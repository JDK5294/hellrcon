/**
 * @app/ingest — the pipeline that turns raw admin-log lines into stored events.
 *
 *   raw log line  ──normalizer──▶  evt.*  ──▶  upsert players + insert into the event store
 *
 * Pure and repository-agnostic (works on the in-memory or Postgres repo). The continuous
 * live path (apps/workers) just calls `ingestLines` with each batch it streams from a server.
 */
import { MIN_MATCH_MS, type NewEvt, type MatchRow, type Repository, type StatsDelta } from "@app/db";
import { requireGame, parseMatchResult, resultMapName, sameMapName, sideFromTeam } from "@app/games";
import { enrichTeamSwitches, switchRank, switchStepOf, TEAM_SWITCH_KIND, type SwitchEnrichment } from "./team-switches.js";

export { enrichTeamSwitches, switchRank, switchStepOf, ROUND_EDGE_KINDS, ROUND_LOOKBACK_MS, TEAM_SWITCH_KIND } from "./team-switches.js";

/** Whether a round that started at `startedAt` and ended at `endedAt` was too short to be a game. */
function isShortRound(startedAt: string, endedAt: string): boolean {
  return Date.parse(endedAt) - Date.parse(startedAt) < MIN_MATCH_MS;
}

/** Guess the platform from an id (17-digit numeric = Steam64; otherwise a hashed/other id). */
export function inferPlatform(id: string): string {
  return /^\d{17}$/.test(id) ? "steam" : "other";
}

interface MaybePlayerFields {
  playerId?: string;
  playerName?: string;
  victimId?: string;
  victimName?: string;
  weapon?: string;
  data?: Record<string, unknown> | null;
}

/**
 * Normalize each line, resolve player identities (upsert), and insert the resulting events.
 * Returns the number of events stored. Unrecognized lines are ignored.
 *
 * `onEvent` (optional) is called for each stored event — the API uses it to publish events
 * to the in-process plugin event bus so plugins react to live activity.
 *
 * `onWarning` (optional) hears what was stored less well than it could have been but stored all
 * the same — a team switch that could not be linked or read against the round — so the caller
 * can log it. Unlike a failure it never throws: the batch's side effects still run.
 */
export async function ingestLines(repo: Repository, serverId: string, lines: string[], onEvent?: (evt: NewEvt) => void, game = "hll", onWarning?: (message: string) => void): Promise<number> {
  // Resolve the game's log parser + line-identity — the game module owns line formats (including
  // how to derive a stable dedup key); ingest stays game-agnostic.
  const { normalizeLine, logLineKey } = requireGame(game);
  // Build events keyed by dedupeKey so a duplicate line within this batch collapses to one.
  // Stats are bumped AFTER insert, only for rows the store reports as newly inserted, so the
  // same admin-log window read twice (worker + one-shot API + reconnect) never double-counts.
  const pending = new Map<string, { evt: NewEvt; actorPlayerId: string | null; victimPlayerId: string | null }>();

  // Parse first, resolve identities second. Doing it the other way round put two player upserts
  // (three statements each, with the alias write) on the wire for every kill line, so a busy round
  // cost more the busier it got. Everything the batch mentions is now resolved in one call.
  const parsed: { dedupeKey: string; evt: ReturnType<typeof normalizeLine>; f: MaybePlayerFields }[] = [];
  const seenPlayers = new Map<string, { platformId: string; name: string; ts: string }>();
  const note = (platformId: string | undefined, name: string | undefined, ts: string) => {
    if (!platformId) return;
    // Last mention wins — chronologically last, since mentions are noted in sorted order — so the
    // upsert carries the freshest name and last_seen the batch knows.
    seenPlayers.set(platformId, { platformId, name: name ?? "", ts });
  };

  for (const line of lines) {
    const evt = normalizeLine(line, { serverId });
    if (!evt) continue;
    const dedupeKey = logLineKey(line);
    if (pending.has(dedupeKey)) continue; // same line twice in one batch
    pending.set(dedupeKey, null as never); // reserve the key; the real entry is built below
    parsed.push({ dedupeKey, evt, f: evt as unknown as MaybePlayerFields });
  }
  pending.clear();

  // Chronological order, whatever order the wire delivered. Everything below is order-sensitive —
  // a disconnect pairs with the connect before it, a kill belongs to whichever match is open at
  // that moment, a camera exit closes the entry before it — and batch order is the adapter's
  // choice, not a guarantee (CRCON, for one, serves its log newest-first). The sort is stable, so
  // lines sharing the log's one-second timestamp granularity keep their arrival order — except a
  // team switch's two halves: within one second, leaving a side goes before joining one, or a
  // newest-first poll stores and relays "switched sides" ahead of the "left" it follows.
  const switchOrder = (p: (typeof parsed)[number]) =>
    p.evt?.kind === TEAM_SWITCH_KIND ? switchRank(switchStepOf({ data: p.f.data ?? null, dedupeKey: p.dedupeKey }) ?? { from: "None", to: "None" }) : 1;
  parsed.sort((a, b) => Date.parse(a.evt!.ts) - Date.parse(b.evt!.ts) || switchOrder(a) - switchOrder(b));
  for (const { evt, f } of parsed) {
    note(f.playerId, f.playerName, evt!.ts);
    note(f.victimId, f.victimName, evt!.ts);
  }

  const resolved = await repo.players.upsertMany([...seenPlayers.values()].map((s) => ({
    game, platform: inferPlatform(s.platformId), platformId: s.platformId, name: s.name, ts: s.ts,
  })));
  const idByPlatform = new Map(resolved.map((p) => [p.platformId, p.id]));

  // Team switches carry no player id and are only half a swap each: linked to their player by
  // name and read against the round before they are stored (team-switches.ts). Never at the
  // batch's expense — what it cannot read is a warning; the lines are stored as the parser read them.
  const switches: SwitchEnrichment = await enrichTeamSwitches(repo, serverId, parsed, idByPlatform)
    .catch((err: unknown) => ({ linked: new Map(), data: new Map(), errors: [`team switches could not be read: ${(err as Error).message}`] }));
  for (const w of switches.errors) {
    try { onWarning?.(w); } catch { /* a caller's logger never costs the batch */ }
  }

  for (const { dedupeKey, evt, f } of parsed) {
    const actorPlayerId = f.playerId ? idByPlatform.get(f.playerId) ?? null : switches.linked.get(dedupeKey) ?? null;
    const victimPlayerId = f.victimId ? idByPlatform.get(f.victimId) ?? null : null;
    pending.set(dedupeKey, {
      evt: {
        serverId,
        ts: evt!.ts,
        kind: evt!.kind,
        actorPlayerId,
        actorName: f.playerName ?? null,
        victimPlayerId,
        victimName: f.victimName ?? null,
        weapon: f.weapon ?? null,
        data: switches.data.get(dedupeKey) ?? f.data ?? null,
        dedupeKey,
      },
      actorPlayerId,
      victimPlayerId,
    });
  }

  if (pending.size === 0) return 0;

  const items = [...pending.values()];
  const inserted = await repo.events.insert(items.map((i) => i.evt));
  const insertedKeys = new Set(inserted.map((e) => e.dedupeKey));

  // Per-round match tracking, folded from the same (idempotent) event stream: a match opens on
  // MATCH START, per-player scoreboards accrue from kills while it's open, and it closes with the
  // parsed outcome on MATCH ENDED. `openMatch === undefined` means "not yet looked up this batch".
  let openMatch: MatchRow | null | undefined = undefined;
  const currentMatch = async (): Promise<MatchRow | null> => {
    if (openMatch === undefined) openMatch = await repo.matches.getOpen(serverId);
    return openMatch;
  };

  // Stat writes are accumulated across the batch and flushed in as few statements as possible.
  //
  // The match line cannot simply be flushed at the very end: a batch can straddle a round
  // boundary, and `settleMatch` reads the scoreboard to decide who played and who won. So the
  // match bucket is flushed whenever the open match is about to change — every round still sees a
  // complete scoreboard before it is settled. Career totals have no such ordering constraint
  // (they are independent columns) and flush once at the end.
  const careerDelta: { playerId: string; serverId: string; delta: StatsDelta }[] = [];
  let matchDelta: Parameters<Repository["matches"]["bumpStatMany"]>[0] = [];
  const flushMatchDelta = async () => {
    if (matchDelta.length === 0) return;
    await repo.matches.bumpStatMany(matchDelta);
    matchDelta = [];
  };

  /*
   * One item's failure must not cost the batch.
   *
   * The events were stored in a single statement ABOVE, and `insertedKeys` is what makes the stats
   * below idempotent — so a throw part-way through this loop is unrecoverable, not merely
   * inconvenient: those lines are already marked ingested, the next read dedupes them away, and
   * the work never happens. Worse, `careerDelta` only flushes after the loop, so one hiccup on one
   * player's session write silently dropped every kill, death and minute the WHOLE batch had
   * accumulated, on a busy round, with nothing to show for it afterwards.
   *
   * The policy was already the right one a few lines down, where a settle failure is caught so it
   * "must not stop the rest of the batch being ingested". This applies it to every transition. The
   * failures are collected and raised once at the end — AFTER the deltas flush — so the caller
   * still learns something went wrong while the work that could be done has been.
   */
  const failures: string[] = [];
  for (const item of items) {
    if (!insertedKeys.has(item.evt.dedupeKey)) continue; // duplicate — already counted before
    try {
      // Accumulate career stats incrementally (independent of the raw event store, so trimming
      // events never loses these totals). Only ever runs for genuinely new events.
      if (item.evt.kind === "evt.match.started") {
        const map = (item.evt.data?.map as string | undefined) ?? null;
        await flushMatchDelta(); // the outgoing round's scoreboard, before it is superseded
        const superseded = await currentMatch();
        openMatch = await repo.matches.open({ serverId, map, startedAt: item.evt.ts });
        // A round whose MATCH ENDED line was never seen (server crash, worker down across the
        // boundary) is closed by the open() above — but closing is not settling: the people on its
        // scoreboard played that round, and without this they were never counted as having played
        // it. The winner stays null, so nobody is credited a win the game never reported. The id
        // check keeps a replayed MATCH START (which re-opens its own row) from settling itself.
        // A round superseded inside MIN_MATCH_MS (a map switched away from at once, a round
        // restarted seconds in) was never a game: it is dropped, not settled.
        if (superseded && superseded.id !== openMatch.id) {
          const dropped = isShortRound(superseded.startedAt, item.evt.ts)
            && await repo.matches.discardShort(superseded.id, item.evt.ts);
          if (!dropped) {
            await repo.stats.settleMatch(superseded.id, null).catch(() => {
              /* the career rollup for a dead round must not stop the batch being ingested */
            });
          }
        }
      } else if (item.evt.kind === "evt.match.ended") {
        const m = await currentMatch();
        const endResult = (item.evt.data?.result as string | undefined) ?? "";
        // The stale-whistle guard. A backfilled window (the wide first read after a reconnect) can
        // carry the END of a round the tracker never saw OPEN — the worker was down across both
        // that round's start and most of its play. Closing the CURRENTLY open round with that
        // result would stamp it with another map's score and winner. When both sides name their
        // map and the names disagree, this whistle is not ours: leave the open round for its own
        // end or the next start's supersede, exactly as if the stray line had never been read.
        const namedMap = resultMapName(endResult);
        if (m && m.map && namedMap && !sameMapName(m.map, namedMap)) {
          if (onEvent) onEvent(item.evt);
          continue;
        }
        if (m) {
          await flushMatchDelta(); // settleMatch reads the scoreboard, so it must be complete first
          // A round that ends inside MIN_MATCH_MS is not a game — no listing, no played, no win or
          // loss for anyone. (The "0m" rounds: a start line the game writes on the end screen,
          // closed by the whistle a moment later with the round before's score.)
          if (isShortRound(m.startedAt, item.evt.ts) && await repo.matches.discardShort(m.id, item.evt.ts, endResult || null)) {
            openMatch = null;
            if (onEvent) onEvent(item.evt);
            continue;
          }
          const result = endResult;
          const score = item.evt.data?.score as string | undefined;
          const outcome = parseMatchResult(result, score);
          await repo.matches.close(m.id, { endedAt: item.evt.ts, winner: outcome.winner, alliedScore: outcome.alliedScore, axisScore: outcome.axisScore, result: result || null });
          // Settle the scoreboard: who won, who was still connected at the whistle, and roll played/won
          // onto careers. Presence comes from the open-session table inside the store — this path has
          // no roster, and passing an empty one would mark the whole server absent. Idempotent, so a
          // replayed match-end event cannot double-count.
          await repo.stats.settleMatch(m.id, outcome.winner).catch(() => {
            /* a settle failure must not stop the rest of the batch being ingested */
          });
        }
        openMatch = null;
      } else if (item.evt.kind === "evt.kill" || item.evt.kind === "evt.teamkill") {
        const m = await currentMatch();
        if (m) {
          const isTk = item.evt.kind === "evt.teamkill";
          if (item.actorPlayerId) matchDelta.push({ matchId: m.id, playerId: item.actorPlayerId, serverId, playerName: item.evt.actorName, side: sideFromTeam(item.evt.data?.playerTeam as string | undefined), kills: isTk ? 0 : 1, teamkills: isTk ? 1 : 0 });
          if (item.victimPlayerId) matchDelta.push({ matchId: m.id, playerId: item.victimPlayerId, serverId, playerName: item.evt.victimName, side: sideFromTeam(item.evt.data?.victimTeam as string | undefined), deaths: 1 });
        }
      }
      if (item.evt.kind === "evt.kill") {
        if (item.actorPlayerId) careerDelta.push({ playerId: item.actorPlayerId, serverId, delta: { kills: 1 } });
        if (item.victimPlayerId) careerDelta.push({ playerId: item.victimPlayerId, serverId, delta: { deaths: 1 } });
      } else if (item.evt.kind === "evt.teamkill") {
        if (item.actorPlayerId) careerDelta.push({ playerId: item.actorPlayerId, serverId, delta: { teamkills: 1 } });
        if (item.victimPlayerId) careerDelta.push({ playerId: item.victimPlayerId, serverId, delta: { deaths: 1 } });
      } else if (item.evt.kind === "evt.player.connected") {
        // A join is a visit; open a session so the matching disconnect can measure playtime.
        // The session write stays per-event: it is a state transition whose order matters, and
        // connects are rare next to kills.
        if (item.actorPlayerId) {
          // A connect while a session is still open banks the old one rather than discarding it —
          // a server restart sends no disconnect lines at all — and returns its seconds so the
          // career total gains what the recovered row describes. 0 when there was nothing to bank.
          const banked = await repo.sessions.open(item.actorPlayerId, serverId, item.evt.ts);
          careerDelta.push({ playerId: item.actorPlayerId, serverId, delta: { visits: 1 } });
          if (banked > 0) careerDelta.push({ playerId: item.actorPlayerId, serverId, delta: { playtimeSec: banked } });
        }
      } else if (item.evt.kind === "evt.player.disconnected") {
        // Close the open session and fold its elapsed time into the playtime rollup.
        if (item.actorPlayerId) {
          const dur = await repo.sessions.close(item.actorPlayerId, serverId, item.evt.ts);
          if (dur > 0) careerDelta.push({ playerId: item.actorPlayerId, serverId, delta: { playtimeSec: dur } });
        }
      } else if (item.evt.kind === "evt.admin.camera") {
        // Admin camera is a PAIR — entered, then left — and the pair is what anybody actually wants
        // to know ("who was watching, and for how long"). Two loose events cannot answer that, and
        // trimming the game log would erase them, so the pairing is folded into its own table here,
        // exactly like a player session. `entered` was decided by the parser; a line that means
        // neither is stored as an event and skipped here rather than guessed at.
        const entered = (item.evt.data as { entered?: boolean | null } | null)?.entered;
        const who = { serverId, playerId: item.actorPlayerId, playerName: item.evt.actorName ?? "unknown", at: item.evt.ts };
        if (entered === true) await repo.adminCam.open(who);
        else if (entered === false) await repo.adminCam.close(who);
      }
    } catch (err) {
      // Named by kind and timestamp: "something failed" is not something anyone can chase.
      failures.push(`${item.evt.kind} at ${item.evt.ts}: ${(err as Error).message}`);
    }
    if (onEvent) onEvent(item.evt);
  }

  await flushMatchDelta();
  if (careerDelta.length) await repo.stats.bumpMany(careerDelta);

  if (failures.length) {
    throw new Error(`${failures.length} of ${items.length} ingested events failed to update their rollups (the rest were applied): ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? " …" : ""}`);
  }
  return inserted.length;
}
