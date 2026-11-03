/**
 * Game rewards' I/O: claiming receipts, granting VIP, crediting points, telling the player. The
 * decisions live in ./game-rewards.ts; the worker calls these from ingestion (kill streaks, match
 * ends), the seed payout (seed days) and its attendance loop (play days).
 */
import { bankIfHeld, serverTimezone, type GameRewardsConfig, type Repository, type RewardAmount, type ServerRow } from "@app/db";
import { getGame } from "@app/games";
import type { StateKind } from "@app/rcon-core";
import type { Logger } from "@app/shared";
import { applyVars, calcRewardExpiration, rewardPhrase } from "./seeding.js";
import { rendererFor } from "./renderer.js";
import { bestSquadsBroadcast, bestSquadsReport, dayIn, formatSquadValue, formatStat, playedSeconds, playerMatchVars, prevDay, rankBestSquads, rankTopStats, squadNames, SQUAD_TYPE_LABELS, streakEndingOn, streakPayoutsDue, topStatsBroadcast, topStatsReport, TOP_STAT_LABELS } from "./game-rewards.js";
import { prettifyMapId } from "@app/maps";
import { MESSAGE_PACE_MS, normalizeSession, rosterPlayers } from "@app/rcon-core";

/** The slice of a game client these need — so a test can hand in a fake. */
export interface RewardClient {
  execute(command: string, params: Record<string, unknown>): Promise<unknown>;
  readState(kind: StateKind): Promise<unknown>;
}

// ---------------------------------------------------------------------------------------------
// GAME REWARDS (see GameRewardsConfig in @app/db and ./game-rewards.ts for the decisions).
// ---------------------------------------------------------------------------------------------

export type GameRewardKind = "topStats" | "bestSquad" | "killStreak" | "playDays" | "seedDays" | "matchEnd";

/**
 * Messages held back so each player gets ONE message per match end. A player can earn several
 * rewards at the same whistle — a top-stats place or two and the everyone-at-match-end day — and
 * sent one after another in the same second, each new message would land on top of the last and
 * only the final one would ever be read. `order` places each part: the card's position in the
 * panel's arrangement first, then (for top stats) the category's position, then the place.
 */
export interface MessageBatch {
  /** `filler`: nice to read, not needed (the winners list) — goes last, cut to fit the screen. */
  add(platformId: string, name: string | null, order: number, text: string, filler?: boolean): void;
}

/** Where a card sits in the panel's arrangement — the first digit of a combined message's order. */
export function cardPosition(cfg: GameRewardsConfig, card: GameRewardsConfig["order"][number]): number {
  const i = (cfg.order ?? []).indexOf(card);
  return i < 0 ? 99 : i;
}

/** Game-rewards settings, cached briefly — the ingest path asks on every poll. */
export const gameRewardsCache = new Map<string, { at: number; cfg: GameRewardsConfig | null }>();
export async function gameRewardsFor(repo: Repository, serverId: string): Promise<GameRewardsConfig | null> {
  const hit = gameRewardsCache.get(serverId);
  if (hit && Date.now() - hit.at < 30_000) return hit.cfg;
  const cfg = (await repo.gameRewards.getConfig(serverId).catch(() => null))?.config ?? null;
  gameRewardsCache.set(serverId, { at: Date.now(), cfg });
  return cfg;
}

/** The roles each game calls "Commander", as the role-seconds keys a match line uses. */
function commanderRolesOf(game: string): Set<string> {
  const roles = (getGame(game)?.descriptor as { roles?: Record<number, string> } | undefined)?.roles ?? {};
  return new Set(Object.entries(roles).filter(([, label]) => label === "Commander").map(([id]) => String(id)));
}

/**
 * Pay one game reward — or, in dry-run (or on an observe server), record what it WOULD pay.
 *
 * The receipt is claimed FIRST: a claim that returns false means this exact payout already
 * happened (a restart, a re-read log, a second evaluation), and nothing is paid or said twice.
 * The VIP half follows the seed reward's rules to the letter — a paid permanent VIP is never
 * touched, a paused one banks the time without reappearing in game — and the points half is one
 * ledger credit under a ref of its own (so even the ledger refuses a double). Then one audit row,
 * and the player is messaged with their own numbers.
 */
export async function payGameReward(
  repo: Repository, server: ServerRow, client: RewardClient, slog: Logger,
  p: {
    kind: GameRewardKind; ref: string; platformId: string; name: string | null; reward: RewardAmount; dryRun: boolean; message: string; vars: Record<string, string | number>; what: string;
    /** Hold the message for one combined send (see MessageBatch) instead of sending it now. */
    batch?: { into: MessageBatch; order: number };
  },
): Promise<void> {
  const dryRun = p.dryRun || server.engagementMode !== "active";
  const ref = dryRun ? `dry:${p.ref}` : p.ref;
  const claimed = await repo.gameRewards.claim({ serverId: server.id, playerId: p.platformId, ref, kind: p.kind, detail: { what: p.what, reward: p.reward } }).catch(() => false);
  if (!claimed) return;
  const eco = await repo.economy.config().catch(() => null);
  const currency = eco?.currencyName || "Points";
  const who = p.name || p.platformId;
  if (dryRun) {
    await repo.audit.create({
      actorUserId: null, actorName: "game rewards", action: "game.reward",
      targetType: "player", targetId: p.platformId, targetName: p.name ?? undefined, serverId: server.id,
      summary: `[dry-run] would reward ${who} with ${rewardPhrase(p.reward.vipHours, p.reward.points, currency) || "a message"} — ${p.what}`,
      data: { kind: p.kind, ref: p.ref, reward: p.reward, dryRun: true },
    }).catch(() => {});
    return;
  }
  const detail: Record<string, unknown> = { kind: p.kind, ref: p.ref, reward: p.reward };
  const now = Date.now();
  let vipGiven = 0;
  let vipKept = false;
  if (p.reward.vipHours > 0) {
    try {
      // Permanent VIP from a group perk: the hours join the VIP they get back on leaving it (a hold
      // that ended since the read is read again — see bankIfHeld) — unless the group's perk takes
      // no rewards, when the held grant comes back as `existing` and absorbs them below.
      const basis = await bankIfHeld(repo, server.id, p.platformId, { addMs: p.reward.vipHours * 3_600_000 }, { reward: true });
      const existing = basis.existing ?? null;
      const expiration = basis.banked ? null : calcRewardExpiration(existing, p.reward.vipHours, true, now);
      if (basis.banked) {
        vipGiven = p.reward.vipHours;
        detail.groupHeld = true;
        detail.bankedMs = basis.banked.groupHold!.bankedMs;
      } else if (expiration === null) {
        vipKept = true; // permanent absorbs it — never rewritten
        if (basis.refusedBy) detail.vipSkipped = `permanent VIP from group ${basis.refusedBy.map((n) => `"${n}"`).join(", ")}, whose perk takes no rewards`;
      }
      else {
        const paused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > now);
        if (!paused) await client.execute("addVip", { playerId: p.platformId, description: p.name || "game reward" });
        // The note is written only on a NEW row, like the seed reward: an existing grant's note is
        // staff's ("paid — 30 days via PayPal"), and a reward must never erase it. The audit row
        // says what the reward was.
        const row = await repo.vips.upsert({ serverId: server.id, playerId: p.platformId, playerName: p.name, comment: existing ? null : `game reward: ${p.what}`, expiration, createdByUserId: null, createdByName: "game rewards" });
        // A hold that began after the read took the hours into its frozen balance; permanent VIP
        // granted meanwhile absorbed them (the store's floor kept it permanent).
        if (row.groupHold) { vipGiven = p.reward.vipHours; detail.groupHeld = true; detail.bankedMs = row.groupHold.bankedMs; }
        else if (row.expiration === null) vipKept = true;
        // What landed (the store keeps the later date), the integrity scan's evidence.
        else { vipGiven = p.reward.vipHours; detail.expiration = row.expiration; }
      }
    } catch (err) {
      detail.vipFailed = (err as Error).message;
      slog.warn("game reward: VIP not granted", { playerId: p.platformId, err: (err as Error).message });
    }
  }
  let pointsGiven = 0;
  if (p.reward.points > 0) {
    try {
      const row = (await repo.players.findByPlatformIds([p.platformId])).find((r) => r.game === server.game) ?? null;
      const discordId = row ? (await repo.externalLinks.list(row.id)).find((l) => l.provider === "discord")?.externalId ?? null : null;
      if (!discordId) detail.pointsSkipped = "no Discord link — points need a linked account";
      else {
        const out = await repo.economy.apply(
          { discordId, delta: p.reward.points, reason: `Game reward on ${server.name}: ${p.what}`, ref: `game:${server.id}:${p.ref}:${p.platformId}`, actorName: "game rewards" },
          { maxBalance: eco?.balanceCap ?? null },
        );
        pointsGiven = out.entry.delta;
        detail.balance = out.member.balance;
      }
    } catch (err) {
      detail.pointsFailed = (err as Error).message;
    }
  }
  const phrase = rewardPhrase(vipGiven, pointsGiven, currency);
  // Nothing landed at all (the VIP grant failed and no points were credited): the receipt is
  // given BACK, so this payout is not recorded as made — a day streak evaluated again pays it,
  // and nobody is told they earned something they did not get.
  const delivered = vipGiven > 0 || pointsGiven > 0 || vipKept || !(detail.vipFailed || detail.pointsFailed);
  if (!delivered) await repo.gameRewards.release({ serverId: server.id, playerId: p.platformId, ref }).catch(() => {});
  await repo.audit.create({
    actorUserId: null, actorName: "game rewards", action: "game.reward",
    targetType: "player", targetId: p.platformId, targetName: p.name ?? undefined, serverId: server.id,
    summary: delivered
      ? `rewarded ${who} with ${phrase || (vipKept ? "a thank-you (VIP already permanent)" : "nothing")} — ${p.what}${detail.pointsSkipped ? ` — points skipped, ${String(detail.pointsSkipped)}` : ""}${detail.vipFailed ? ` — VIP NOT granted, ${String(detail.vipFailed)}` : ""}`
      : `could NOT reward ${who} — ${p.what} — ${detail.vipFailed ? `the VIP grant failed (${String(detail.vipFailed)})` : `the points failed (${String(detail.pointsFailed)})`}, so nothing was paid and it is not marked as paid`,
    data: { ...detail, vipGiven, pointsGiven, ...(vipKept ? { vipKept: true } : {}), ...(delivered ? {} : { released: true }) },
  }).catch(() => {});
  if (!delivered || !p.message.trim()) return;
  const filled = applyVars(p.message, { ...p.vars, reward: phrase || (vipKept ? "our thanks — your VIP is already permanent" : "our thanks") });
  // Held for the combined send: the server placeholders ({vip_until}…) fill THEN, after every
  // reward this whistle pays has landed, so they read the player's final time.
  if (p.batch) { p.batch.into.add(p.platformId, p.name, p.batch.order, filled); return; }
  try {
    const text = await rendererFor(repo, server, client, undefined, true).render(filled, { playerId: p.platformId, playerName: p.name });
    try { await client.execute("messagePlayer", { playerId: p.platformId, message: text }); }
    catch { await new Promise((r) => setTimeout(r, 500)); await client.execute("messagePlayer", { playerId: p.platformId, message: text }); }
  } catch { /* they may have left — the reward stands, the audit row says so */ }
}

/** Did this fail because the CONNECTION went away (worth reconnecting), rather than the game
 *  answering "no" to the command (a refusal a retry cannot fix)? */
export function isConnectionLoss(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ObserveModeViolation" || err.name === "RconCommandError" || "statusCode" in err) return false;
  // "fetch failed" is the CRCON bridge's form of the same thing (an HTTP call that never landed).
  return /not connected|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket|closed|timed out|timeout|fetch failed/i.test(err.message);
}

/**
 * A reward client that survives the game dropping the connection. The game server closes RCON
 * connections around a map change — exactly when match-end rewards are being paid — and every
 * command after that failed at once with "not connected", so a full server's match-end VIP
 * failed player by player. This reconnects (a few tries, a few seconds apart, while the next map
 * loads) and runs the command again; a command the game REFUSED is not retried.
 */
export function reconnecting(client: RewardClient, reconnect: () => Promise<void>, slog: Logger, opts: { tries?: number; waitMs?: number } = {}): RewardClient {
  const tries = opts.tries ?? 5;
  const waitMs = opts.waitMs ?? 3_000;
  // Once a full round of reconnecting has failed, the server is DOWN, not between maps: later
  // commands try ONE quick reconnect instead of the whole round again — otherwise every player
  // left on a full server's list would wait out the full backoff in turn, an hour of nothing.
  let down = false;
  const run = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (!isConnectionLoss(err)) throw err;
      let last: unknown = err;
      const rounds = down ? 1 : tries;
      for (let i = 1; i <= rounds; i++) {
        await sleep(waitMs * i);
        try {
          await reconnect();
          down = false;
          slog.info("game rewards: reconnected to the game server", { attempt: i });
          return await call();
        } catch (e) {
          last = e;
          if (!isConnectionLoss(e) && !/connect/i.test((e as Error)?.message ?? "")) throw e;
        }
      }
      down = true;
      throw last;
    }
  };
  return {
    execute: (command, params) => run(() => client.execute(command, params)),
    readState: (kind) => run(() => client.readState(kind)),
  };
}

/**
 * Who was on when this match ended: the live roster (platform ids), else the match's
 * present-at-end record. The live roster only describes the whistle when the whistle was just
 * now — a match end read late (the backfill after a worker restart) would otherwise name whoever
 * is playing the NEXT match.
 */
export async function playersAtWhistle(
  repo: Repository, client: RewardClient, match: { endedAt: string | null },
  rows: { playerId: string; playerName: string | null; presentAtEnd?: boolean | null }[],
): Promise<{ platformId: string; name: string | null }[]> {
  const online: { platformId: string; name: string | null }[] = [];
  if (match.endedAt && Date.now() - Date.parse(match.endedAt) <= 3 * 60_000) {
    try {
      for (const p of rosterPlayers(await client.readState("players"))) online.push({ platformId: p.playerId, name: p.playerName });
    } catch { /* fall back below */ }
  }
  if (!online.length) {
    for (const r of rows.filter((x) => x.presentAtEnd === true)) {
      const who = await platformOf(repo, r.playerId);
      if (who) online.push({ platformId: who.platformId, name: r.playerName ?? who.name });
    }
  }
  return online;
}

/** Resolve a player RECORD id (what events and match lines carry) to the platform id the game acts on. */
export async function platformOf(repo: Repository, recordId: string): Promise<{ platformId: string; name: string | null } | null> {
  const row = await repo.players.findById(recordId).catch(() => null);
  return row ? { platformId: row.platformId, name: row.name ?? null } : null;
}

/** Top stats for a match that just ended: rank, pay each winner, and (optionally) broadcast them.
 *  `broadcasts`: hold the broadcast line for one combined send instead of sending it now — the
 *  game's broadcast is one message, so a second send would replace the first. */
export async function rewardTopStats(repo: Repository, server: ServerRow, client: RewardClient, slog: Logger, endedAt: string, batch?: MessageBatch, broadcasts?: string[]): Promise<void> {
  const all = await gameRewardsFor(repo, server.id);
  const cfg = all?.topStats;
  if (!cfg?.enabled) return;
  const match = await repo.matches.firstEndedAfter(server.id, new Date(Date.parse(endedAt) - 5_000).toISOString()).catch(() => null);
  // The match THIS whistle closed — within a minute of it. A stray old MATCH ENDED line (the
  // stale-whistle case ingestion refuses to close anything with) must not reach back and reward
  // some other round that ended since.
  if (!match?.endedAt || Math.abs(Date.parse(match.endedAt) - Date.parse(endedAt)) > 60_000) return;
  const rows = await repo.matches.statsForMatch(match.id).catch(() => []);
  const players = rows.filter((r) => playedSeconds(r) > 0 || r.kills > 0 || r.deaths > 0).length;
  if (players < cfg.minPlayers) {
    slog.info("top stats: match below the player minimum — no rewards", { players, minPlayers: cfg.minPlayers });
    return;
  }
  const winners = rankTopStats(rows, cfg, commanderRolesOf(server.game));
  const mapLabel = match.map ? prettifyMapId(match.map) : "the last match";
  for (const w of winners) {
    const who = await platformOf(repo, w.playerId);
    if (!who) continue;
    // A match line only carries a name when the kill stream gave it one — a defender with no
    // kills had none, and the winners list read "Defense: ? (1760)". The player record knows.
    w.playerName ??= who.name;
    const label = TOP_STAT_LABELS[w.category];
    const row = rows.find((r) => r.playerId === w.playerId)!;
    const own = cfg.categories.find((c) => c.id === w.category)?.message?.trim();
    await payGameReward(repo, server, client, slog, {
      kind: "topStats", ref: `top:${match.id}:${w.category}:${w.rank}`, platformId: who.platformId, name: w.playerName ?? who.name,
      reward: w.reward, dryRun: cfg.dryRun, message: own || cfg.message,
      vars: { ...playerMatchVars(row), category: label, rank: w.rank, value: formatStat(w.category, w.value), map: mapLabel },
      what: `#${w.rank} ${label} (${formatStat(w.category, w.value)}) on ${match.map ?? "the last match"}`,
      ...(batch ? { batch: { into: batch, order: cardPosition(all!, "topStats") * 10_000 + cfg.categories.findIndex((c) => c.id === w.category) * 100 + w.rank } } : {}),
    });
  }
  // Everyone sees the winners (the topstats plugin's report), winners or not: in their one
  // match-end message, AFTER their own rewards and cut to what the screen shows — a console
  // cannot scroll the message box, and a player's own reward is the part that must be read.
  // Live only, like the broadcast below.
  if (batch && cfg.showEveryone !== false && !cfg.dryRun && winners.length && server.engagementMode === "active") {
    const report = topStatsReport(winners, cfg.categories.map((c) => c.id));
    if (report) for (const o of await playersAtWhistle(repo, client, match, rows)) batch.add(o.platformId, o.name, Number.MAX_SAFE_INTEGER, report, true);
  }
  if (cfg.broadcast && !cfg.dryRun && winners.length && server.engagementMode === "active") {
    const line = topStatsBroadcast(winners.filter((w) => w.rank === 1));
    if (line && broadcasts) broadcasts.push(line);
    else if (line) await client.execute("broadcast", { message: line.slice(0, 900) }).catch(() => {});
  }
}

/** The squad types a game's squads come in (role ids per type), or null for a game without them. */
function squadTypesOf(game: string): Record<string, number[]> | null {
  return (getGame(game)?.descriptor as { squadTypes?: Record<string, number[]> } | undefined)?.squadTypes ?? null;
}

/**
 * Best squads for a match that just ended: each squad type's best squads, every member of a placed
 * squad paid — the same once-only receipts, dry run, VIP rules and combined message as top stats.
 */
export async function rewardBestSquads(repo: Repository, server: ServerRow, client: RewardClient, slog: Logger, endedAt: string, batch?: MessageBatch, broadcasts?: string[]): Promise<void> {
  const all = await gameRewardsFor(repo, server.id);
  const cfg = all?.bestSquads;
  if (!cfg?.enabled) return;
  const squadTypes = squadTypesOf(server.game);
  if (!squadTypes) return;
  const match = await repo.matches.firstEndedAfter(server.id, new Date(Date.parse(endedAt) - 5_000).toISOString()).catch(() => null);
  // The match THIS whistle closed, as top stats reads it — never an older round that ended since.
  if (!match?.endedAt || Math.abs(Date.parse(match.endedAt) - Date.parse(endedAt)) > 60_000) return;
  const rows = await repo.matches.statsForMatch(match.id).catch(() => []);
  const players = rows.filter((r) => playedSeconds(r) > 0 || r.kills > 0 || r.deaths > 0).length;
  if (players < cfg.minPlayers) {
    slog.info("best squads: match below the player minimum — no rewards", { players, minPlayers: cfg.minPlayers });
    return;
  }
  const placed = rankBestSquads(rows, cfg, squadTypes);
  // Every member by the id the game acts on, and named — a member with no kills has no name on
  // their match line, and "?" in a squad's list reads as a missing player.
  const who = new Map<string, { platformId: string; name: string | null }>();
  for (const p of placed) {
    for (const m of p.members) {
      if (who.has(m.playerId)) continue;
      const rec = await platformOf(repo, m.playerId);
      if (!rec) continue;
      who.set(m.playerId, rec);
      m.playerName ??= rec.name;
    }
  }
  const mapLabel = match.map ? prettifyMapId(match.map) : "the last match";
  for (const p of placed) {
    const label = SQUAD_TYPE_LABELS[p.type];
    const value = formatSquadValue(p.value, cfg.scoring);
    const own = cfg.types.find((t) => t.id === p.type)?.message?.trim();
    for (const m of p.members) {
      const rec = who.get(m.playerId);
      if (!rec) continue;
      await payGameReward(repo, server, client, slog, {
        kind: "bestSquad", ref: `squad:${match.id}:${p.type}:${p.rank}`, platformId: rec.platformId, name: m.playerName ?? rec.name,
        reward: p.reward, dryRun: cfg.dryRun, message: own || cfg.message,
        vars: {
          ...playerMatchVars(m), squad_type: label, rank: p.rank, value, squad_size: p.members.length, map: mapLabel,
          squad_mates: squadNames(p.members.filter((x) => x.playerId !== m.playerId), 4) || "no one else",
        },
        what: `#${p.rank} ${label} squad (${value}) on ${match.map ?? "the last match"}`,
        ...(batch ? { batch: { into: batch, order: cardPosition(all!, "bestSquads") * 10_000 + cfg.types.findIndex((t) => t.id === p.type) * 100 + p.rank } } : {}),
      });
    }
  }
  if (batch && cfg.showEveryone !== false && !cfg.dryRun && placed.length && server.engagementMode === "active") {
    const report = bestSquadsReport(placed, cfg.types.map((t) => t.id), cfg.scoring);
    if (report) for (const o of await playersAtWhistle(repo, client, match, rows)) batch.add(o.platformId, o.name, Number.MAX_SAFE_INTEGER, report, true);
  }
  if (cfg.broadcast && !cfg.dryRun && placed.length && server.engagementMode === "active") {
    const line = bestSquadsBroadcast(placed, cfg.scoring);
    if (line && broadcasts) broadcasts.push(line);
    else if (line) await client.execute("broadcast", { message: line.slice(0, 900) }).catch(() => {});
  }
}

/** How far back a streak is ever traced — ten years of days is past any streak that will happen. */
const STREAK_LOOKBACK_MAX_DAYS = 3660;

/**
 * Evaluate a consecutive-days streak for one player (play days or seed days) and pay every tier it
 * has reached. Receipts keep each tier to once per streak, so evaluating again pays nothing new.
 */
export async function rewardDayStreak(
  repo: Repository, server: ServerRow, client: RewardClient, slog: Logger,
  kind: "play" | "seed", platformId: string, name: string | null, today: string, secondsToday?: number,
): Promise<void> {
  const all = await gameRewardsFor(repo, server.id);
  const cfg = kind === "play" ? all?.playDays : all?.seedDays;
  if (!cfg?.enabled) return;
  const need = kind === "play" ? Math.max(1, (all!.playDays.minMinutes || 0) * 60) : 1;
  // The streak's first day names every receipt, so it must be the REAL first day. A streak longer
  // than the days read would seem to start at the edge of the read — an edge that moves forward
  // every day, renaming every tier and paying them all again daily. So when the streak reaches the
  // edge, read further back.
  const traceBack = async (lookback: number): Promise<{ count: number; start: string }> => {
    let since = today;
    for (let i = 0; i < lookback; i++) since = prevDay(since);
    const rows = await repo.gameRewards.days(server.id, platformId, kind, since).catch(() => []);
    const streak = streakEndingOn(new Set(rows.filter((r) => r.seconds >= need).map((r) => r.day)), today);
    return streak.start !== since || lookback >= STREAK_LOOKBACK_MAX_DAYS ? streak : traceBack(Math.min(lookback * 4, STREAK_LOOKBACK_MAX_DAYS));
  };
  const { count, start } = await traceBack(120);
  for (const due of streakPayoutsDue(count, cfg.tiers, cfg.repeatEveryDays)) {
    await payGameReward(repo, server, client, slog, {
      kind: kind === "play" ? "playDays" : "seedDays", ref: `${kind}:${start}:${due.days}`, platformId, name,
      reward: due.reward, dryRun: cfg.dryRun, message: due.message?.trim() || cfg.message,
      vars: { days: due.days, ...(secondsToday !== undefined ? { minutes_today: Math.floor(secondsToday / 60) } : {}) },
      what: `${due.days} ${kind === "play" ? "days played" : "days seeding"} in a row`,
    });
  }
}

/** A seed reward was just paid: count its day as a seeding day and pay any streak tier it reached.
 *  `atMs` is when the seeding happened — a missed payout paid the next day (pay-last) belongs to
 *  the day it was earned, not the day it was paid. */
export async function rewardSeedDay(repo: Repository, server: ServerRow, client: RewardClient, slog: Logger, platformId: string, name: string | null, atMs?: number): Promise<void> {
  const cfg = await gameRewardsFor(repo, server.id);
  if (!cfg?.seedDays.enabled) return;
  const tz = await serverTimezone(repo, server.id);
  const today = dayIn(tz, atMs ?? Date.now());
  await repo.gameRewards.addDaySeconds(server.id, "seed", today, [{ playerId: platformId, seconds: 1 }]);
  await rewardDayStreak(repo, server, client, slog, "seed", platformId, name, today);
}

/** Players on right now, cached a minute per server — the kill-streak minimum reads it per streak. */
const onlineCache = new Map<string, { at: number; count: number | null }>();
export async function playersOnline(serverId: string, client: RewardClient): Promise<number | null> {
  const hit = onlineCache.get(serverId);
  if (hit && Date.now() - hit.at < 60_000) return hit.count;
  const count = await client.readState("session").then((raw) => normalizeSession(raw).playerCount ?? null).catch(() => null);
  onlineCache.set(serverId, { at: Date.now(), count });
  return count;
}

/**
 * Everyone on the server when a long enough match ends. "On the server" is the live roster read
 * right at the whistle (players are still on the scoreboard screen); if that read fails, the
 * match's own record of who was present at the end stands in. Each player is paid once per match.
 */
export async function rewardMatchEnd(repo: Repository, server: ServerRow, client: RewardClient, slog: Logger, endedAt: string, batch?: MessageBatch): Promise<void> {
  const all = await gameRewardsFor(repo, server.id);
  const cfg = all?.matchEnd;
  if (!cfg?.enabled) return;
  const match = await repo.matches.firstEndedAfter(server.id, new Date(Date.parse(endedAt) - 5_000).toISOString()).catch(() => null);
  if (!match?.endedAt || Math.abs(Date.parse(match.endedAt) - Date.parse(endedAt)) > 60_000) return;
  const matchMinutes = Math.round((Date.parse(match.endedAt) - Date.parse(match.startedAt)) / 60_000);
  if (!(matchMinutes >= cfg.minMatchMinutes)) {
    slog.info("match-end reward: match too short", { matchMinutes, minMatchMinutes: cfg.minMatchMinutes });
    return;
  }
  const rows = await repo.matches.statsForMatch(match.id).catch(() => []);
  const online = await playersAtWhistle(repo, client, match, rows);
  if (online.length < cfg.minPlayers) {
    slog.info("match-end reward: below the player minimum", { players: online.length, minPlayers: cfg.minPlayers });
    return;
  }
  // Minutes each played in this match, by platform id — only needed when a minimum is set.
  const minutesBy = new Map<string, number>();
  if (cfg.minPlayedMinutes > 0 || cfg.message.includes("{minutes}")) {
    const recs = await repo.players.findByPlatformIds(online.map((o) => o.platformId)).catch(() => []);
    const recToPlatform = new Map(recs.filter((r) => r.game === server.game).map((r) => [r.id, r.platformId]));
    for (const r of rows) {
      const pid = recToPlatform.get(r.playerId);
      if (pid) minutesBy.set(pid, Math.round(playedSeconds(r) / 60));
    }
  }
  const mapLabel = match.map ? prettifyMapId(match.map) : "the last match";
  for (const o of online) {
    const minutes = minutesBy.get(o.platformId) ?? null;
    if (cfg.minPlayedMinutes > 0 && (minutes === null || minutes < cfg.minPlayedMinutes)) continue;
    await payGameReward(repo, server, client, slog, {
      kind: "matchEnd", ref: `end:${match.id}`, platformId: o.platformId, name: o.name,
      reward: cfg.reward, dryRun: cfg.dryRun, message: cfg.message,
      vars: { match_minutes: matchMinutes, minutes: minutes ?? "", map: mapLabel },
      what: `finished a ${matchMinutes}-minute match on ${mapLabel}`,
      ...(batch ? { batch: { into: batch, order: cardPosition(all!, "matchEnd") * 10_000 } } : {}),
    }).catch((err) => slog.warn("match-end reward failed", { playerId: o.platformId, err: (err as Error).message }));
  }
}

/**
 * What one message box shows without scrolling. A console cannot scroll it (a mouse can), so a
 * message that runs past this has its end unread — measured off a console screen: about 18 lines
 * of about 44 characters. Estimated a little short of both, since words wrap before the edge.
 */
export const MESSAGE_SCREEN = { lines: 17, charsPerLine: 40, maxChars: 1000 };

/** Screen lines a text takes: each line, wrapped at the box's width (a blank line is one). */
export function screenLines(text: string, charsPerLine = MESSAGE_SCREEN.charsPerLine): number {
  return text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}

/**
 * One player's parts, as few messages as fit on one screen each: in order, a blank line between,
 * the same text twice said once, never cut mid-part. FILLER parts (the winners list) come last
 * and only into the room left on the last screen — line by line, and left out entirely when not
 * even its heading and one line fit — so what a player earned is never pushed off the screen by
 * what everybody else did.
 */
export function combineParts(parts: { order: number; text: string; filler?: boolean }[], screen = MESSAGE_SCREEN): string[] {
  const fits = (t: string) => screenLines(t, screen.charsPerLine) <= screen.lines && t.length <= screen.maxChars;
  const seen = new Set<string>();
  const own: string[] = [];
  const fillers: string[] = [];
  for (const p of [...parts].sort((a, b) => a.order - b.order)) {
    const t = p.text.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    (p.filler ? fillers : own).push(t);
  }
  const out: string[] = [];
  for (const t of own) {
    const last = out[out.length - 1];
    if (last !== undefined && fits(`${last}\n\n${t}`)) out[out.length - 1] = `${last}\n\n${t}`;
    else out.push(t);
  }
  for (const f of fillers) {
    const lines = f.split("\n");
    const last = out[out.length - 1];
    let kept = 0;
    for (let n = lines.length; n >= 2; n--) {
      const piece = lines.slice(0, n).join("\n");
      if (fits(last === undefined ? piece : `${last}\n\n${piece}`)) { kept = n; break; }
    }
    if (kept < 2 && lines.length >= 2) continue; // not even the heading and one winner — leave it out
    if (kept === 0) continue;
    const piece = lines.slice(0, kept).join("\n");
    if (last === undefined) out.push(piece);
    else out[out.length - 1] = `${last}\n\n${piece}`;
  }
  return out;
}

/** Pause between two players' messages, and before any player's second message. */
const MATCH_END_PACE_MS = MESSAGE_PACE_MS;
const SECOND_MESSAGE_WAIT_MS = 8_000;

/**
 * A match just ended: pay top stats and everyone-at-match-end, then message each player ONCE with
 * everything they earned, in the panel's order. Sends are paced so a full server is not one burst
 * the game drops; a player whose parts outgrow one message gets the rest a few seconds later,
 * after everyone has had their first.
 */
export async function rewardMatchEnded(repo: Repository, server: ServerRow, client: RewardClient, slog: Logger, endedAt: string): Promise<void> {
  const held = new Map<string, { name: string | null; parts: { order: number; text: string; filler?: boolean }[] }>();
  const batch: MessageBatch = {
    add(platformId, name, order, text, filler) {
      const entry = held.get(platformId) ?? { name, parts: [] };
      entry.name ??= name;
      entry.parts.push({ order, text, ...(filler ? { filler: true } : {}) });
      held.set(platformId, entry);
    },
  };
  // One broadcast for the whistle: the game shows a single broadcast message, so top stats and
  // best squads sent one after the other would leave only the second on screen.
  const broadcasts: string[] = [];
  await rewardTopStats(repo, server, client, slog, endedAt, batch, broadcasts).catch((err) => slog.warn("top-stats rewards failed", { err: (err as Error).message }));
  await rewardBestSquads(repo, server, client, slog, endedAt, batch, broadcasts).catch((err) => slog.warn("best-squad rewards failed", { err: (err as Error).message }));
  await rewardMatchEnd(repo, server, client, slog, endedAt, batch).catch((err) => slog.warn("match-end rewards failed", { err: (err as Error).message }));
  if (broadcasts.length) await client.execute("broadcast", { message: broadcasts.join(" | ").slice(0, 900) }).catch(() => {});
  if (!held.size) return;
  const renderer = rendererFor(repo, server, client, undefined, true);
  const rounds: { platformId: string; name: string | null; text: string }[][] = [];
  for (const [platformId, e] of held) {
    // Filled BEFORE fitting: "{vip_until}" becomes "Jul 4, 2027, 10:10 AM EDT", and it is the
    // filled text that has to fit the screen.
    const who = { playerId: platformId, playerName: e.name };
    const filled = await Promise.all(e.parts.map(async (p) => ({ ...p, text: await renderer.render(p.text, who).catch(() => p.text) })));
    combineParts(filled).forEach((text, i) => (rounds[i] ??= []).push({ platformId, name: e.name, text }));
  }
  for (const [i, round] of rounds.entries()) {
    if (i > 0) await sleep(SECOND_MESSAGE_WAIT_MS);
    for (const m of round) {
      try {
        const text = m.text;
        try { await client.execute("messagePlayer", { playerId: m.platformId, message: text }); }
        catch { await sleep(500); await client.execute("messagePlayer", { playerId: m.platformId, message: text }); }
      } catch { /* they may have left — the rewards stand, the audit rows say so */ }
      await sleep(MATCH_END_PACE_MS);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
