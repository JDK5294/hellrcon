/**
 * The map WRITES, shared by every surface that performs them.
 *
 * The web routes in routes/maps.ts grew the hard-won behavior here — ChangeMap's option list
 * follows the rotation and swallows unlisted maps silently, objectives must be validated against
 * the live grid, the layout must be written down because the game never repeats it — and the
 * Discord panel must not re-learn any of those lessons on its own copy. So the action cores live
 * here, and both surfaces call them: same game commands, same verification, same audit rows.
 *
 * Refusals a person can fix (an unlisted map, a stale objective pick) come back as `{ refusal }`;
 * transport failures throw, and each caller wraps them in its own envelope (the route as a 502,
 * the panel as an error line). Engagement mode stays with the CALLERS: the route answers 409 and
 * the panel draws ⛔, but both check before calling.
 */
import type { Repository, ServerRow } from "@app/db";
import { stateReaderFor } from "@app/games";
import { normalizeSession } from "@app/rcon-core";
import { describeMap, scheduleNextMap } from "@app/maps";
import type { RotationIO } from "@app/maps";
import { connectGameClient, gameClientFor, parseObjectiveRows } from "./routes/kit.js";

/** Who the action is recorded under — both surfaces resolve a real account before calling. */
export interface MapActor { userId: string; name: string }

/** Queue `mapId` to play after the current round, by rewriting the rotation (the round in
 *  progress is left alone). Audits as map.next, exactly like the web route always has. */
export async function setNextMapNow(repo: Repository, actor: MapActor, server: ServerRow, mapId: string): Promise<{ result: Awaited<ReturnType<typeof scheduleNextMap>>; pretty: string; voteHoldUntil: string | null }> {
  const client = gameClientFor(server);
  try {
    await connectGameClient(client, server);
    const io: RotationIO = {
      getRotation: async () => stateReaderFor(server.game).rotation(await client.readState("maprotation")),
      addMapToRotation: async (m, index) => { await client.execute("addMapToRotation", { mapName: m, index }); },
      removeMapFromRotation: async (index, mapId) => { await client.execute("removeMapFromRotation", { mapName: mapId, index }); },
    };
    const result = await scheduleNextMap(io, mapId);
    // Without this, the vote's live-leader tracker re-queues ITS map on the next tick and the
    // human's "play this next" quietly never happens — the same fight the map-change hold stops.
    const voteHoldUntil = await holdVoteForManualPick(repo, server.id);
    await repo.audit.create({
      actorUserId: actor.userId, actorName: actor.name, action: "map.next",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `set next map to ${describeMap(mapId).prettyName} on ${server.name}` +
        (voteHoldUntil ? " — map voting stands down for 5 minutes so it cannot re-queue its own pick" : ""),
      data: { mapId, result, voteHoldUntil },
    });
    return { result, pretty: describeMap(mapId).prettyName, voteHoldUntil };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export interface MapChangeOutcome {
  mapId: string; pretty: string;
  /** the map in play when we started — "not yet moved" is normal, the switch takes a load screen */
  before: string | null;
  verified: boolean; staged: boolean; listed: boolean;
  /** when map voting is on: the vote loop stands down until this instant so it cannot fight the
   *  human's pick (see MapVoteStateRow.manualHoldUntil). Null when voting is off. */
  voteHoldUntil: string | null;
}

/** How long the vote automation stands down after a staff manual map change — long enough for
 *  staff to pause or disable voting if the change is meant to stick, short enough that a vote
 *  server gets its votes back without anyone having to remember to press resume. */
export const MANUAL_MAP_HOLD_MS = 5 * 60_000;

/**
 * A human just picked a map (a change, or a queued next). If the automated vote is on it must not
 * fight that pick — the live-leader tracker re-queues its own map within a tick, and the
 * match-end close applies its winner — so the state gets a hold the worker honors. Returns the
 * hold instant for the caller's reply, or null when voting is off (or the write failed, in which
 * case claiming a hold that does not exist would be worse than staying quiet).
 */
async function holdVoteForManualPick(repo: Repository, serverId: string): Promise<string | null> {
  const voteCfg = await repo.mapVote.getConfig(serverId).catch(() => null);
  if (!voteCfg?.enabled) return null;
  const until = new Date(Date.now() + MANUAL_MAP_HOLD_MS).toISOString();
  try { await repo.mapVote.patchState(serverId, { manualHoldUntil: until }); } catch { return null; }
  return until;
}

/**
 * Load `mapId` RIGHT NOW, ending the round in progress. See the change route's essay for why the
 * accepted list is read first and an unlisted map is STAGED into the rotation (with consent)
 * rather than refused or — worse — silently swallowed by a 200 that did nothing.
 */
export async function changeMapNow(repo: Repository, actor: MapActor, server: ServerRow, mapId: string, stage: boolean): Promise<{ refusal: string } | MapChangeOutcome> {
  const client = gameClientFor(server);
  const reader = stateReaderFor(server.game);
  try {
    await connectGameClient(client, server);
    const readAccepted = () => client.execute("getChangeMapList")
      .then((raw) => reader.mapCatalogue(raw))
      .catch(() => [] as string[]);
    const spelling = (list: string[], m: string) => list.find((x) => x.toLowerCase() === m.toLowerCase()) ?? null;
    const before = await client.readState("maprotation")
      .then((raw) => { const r = reader.rotation(raw); return r.maps[r.currentIndex] ?? null; })
      .catch(() => null);

    let accepted = await readAccepted();
    let staged = false;
    if (accepted.length && !spelling(accepted, mapId)) {
      if (!stage) {
        return { refusal:
          `the server's ChangeMap lists ${accepted.length} map(s) and "${mapId}" is not one of them. ` +
          `That list follows the rotation on this build, so the map has to be in the rotation first — ` +
          `send stage: true to add it and switch in one go, or add it on the Rotation tab yourself.` };
      }
      const rot = reader.rotation(await client.readState("maprotation"));
      if (!rot.maps.some((m) => m.toLowerCase() === mapId.toLowerCase())) {
        await client.execute("addMapToRotation", { mapName: mapId, index: rot.maps.length });
        staged = true;
      }
      accepted = await readAccepted();
    }
    const target = spelling(accepted, mapId) ?? mapId;
    const listed = accepted.length === 0 || spelling(accepted, mapId) !== null;
    await client.execute("changeMap", { mapName: target });
    const after = await client.readState("maprotation")
      .then((raw) => { const r = reader.rotation(raw); return r.maps[r.currentIndex] ?? null; })
      .catch(() => null);
    const verified = after === target;
    // Written even when the switch could not be verified: the command went to the wire, and a
    // hold on a change that didn't land costs nothing.
    const voteHoldUntil = await holdVoteForManualPick(repo, server.id);
    await repo.audit.create({
      actorUserId: actor.userId, actorName: actor.name, action: "map.change",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `changed the map to ${describeMap(target).prettyName} on ${server.name}, ending the round in progress` +
        (staged ? " (added it to the rotation first, which is what this build needs to switch to it)" : "") +
        (voteHoldUntil ? " — map voting stands down for 5 minutes so it cannot fight the pick" : ""),
      data: { mapId: target, requested: mapId, before, after, verified, staged, listed, voteHoldUntil },
    });
    return { mapId: target, pretty: describeMap(target).prettyName, before, verified, staged, listed, voteHoldUntil };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** The current map's live objective grid — five sectors, each row's own options — plus which map
 *  the round is on (best-effort, for joining the taught location names/cells). Fewer than five
 *  rows means the server had nothing to say (a match loading); callers word that themselves. */
export async function readObjectivesLive(server: ServerRow): Promise<{ rows: string[][]; mapId: string }> {
  const client = gameClientFor(server);
  try {
    await connectGameClient(client, server);
    const rows = parseObjectiveRows(await client.execute("getObjectiveRows"));
    const mapId = normalizeSession(await client.readState("session").catch(() => null)).mapId ?? "";
    return { rows, mapId };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Vietnam's STORED layouts (GetSectorLayout, docs/hll-vietnam.md p11): `Entries[]`, each a MapId
 * and five sector indices. Tolerant of key casing the way every wire parser here is — the PDF is
 * not a live capture, and a parser that only accepts one spelling reads a real server as empty.
 */
export function parseStoredLayouts(raw: unknown): { mapId: string; sectors: number[] }[] {
  const box = (raw ?? {}) as Record<string, unknown>;
  const entries = box.entries ?? box.Entries ?? (Array.isArray(raw) ? raw : []);
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const o = e as Record<string, unknown>;
    const mapId = String(o.mapId ?? o.MapId ?? o.mapID ?? "").trim();
    const rawSectors = o.sectors ?? o.Sectors;
    if (!mapId || !Array.isArray(rawSectors)) return [];
    return [{ mapId, sectors: rawSectors.map((s) => Math.trunc(Number(s))).filter((n) => Number.isFinite(n)) }];
  });
}

/**
 * Forget the layout a Vietnam server has STORED for one map (RemoveSectorLayout, p11) — the other
 * half of "set saves it forever". Only Vietnam has anything to clear; WW2's set applies once to
 * the round in play and leaves nothing behind, and this says so instead of dialing the game.
 * `mapIdWanted` empty means the map in play. Shared by the web route and the Discord panel.
 */
export async function clearStoredLayout(repo: Repository, actor: MapActor, server: ServerRow, mapIdWanted: string): Promise<{ refusal: string } | { mapId: string }> {
  if (server.game !== "hllv") return { refusal: "only HLL: Vietnam stores objective layouts — a WW2 set applies once to the round in play and leaves nothing to clear" };
  const client = gameClientFor(server);
  let mapId = mapIdWanted.trim();
  try {
    await connectGameClient(client, server);
    if (!mapId) mapId = normalizeSession(await client.readState("session").catch(() => null)).mapId ?? "";
    if (!mapId) return { refusal: "the server didn't say which map is playing — pass mapId" };
    await client.execute("removeSectorLayout", { mapId });
  } finally {
    await client.disconnect().catch(() => {});
  }
  // A manual clear ends any plays-left countdown with it — a counter with nothing to count
  // would otherwise fire a second RemoveSectorLayout at a layout someone saves later.
  await repo.layoutExpiries.delete(server.id, mapId);
  await repo.audit.create({
    actorUserId: actor.userId, actorName: actor.name, action: "map.objectives",
    targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
    summary: `cleared the saved objective layout for ${describeMap(mapId).prettyName} on ${server.name}`,
    data: { mapId, cleared: true },
  });
  return { mapId };
}

/**
 * Set the five sector objectives for the round. `wanted` holds one entry per row — an objective
 * name from that row, or "random"/"" to leave the row to chance. Validated against the LIVE grid
 * so a stale screen cannot send the previous map's names, and recorded on the open match because
 * the game will never repeat what it ran (docs/rcon-503.md).
 */
export async function applyObjectives(repo: Repository, actor: MapActor, server: ServerRow, wanted: string[], opts: { keepPlays?: number | null } = {}): Promise<{ refusal: string } | { objectives: string[]; recordedOnMatchId: string | null }> {
  const client = gameClientFor(server);
  try {
    await connectGameClient(client, server);
    const rows = parseObjectiveRows(await client.execute("getObjectiveRows"));
    if (rows.length !== 5) return { refusal: "the server did not return the five objective rows (is a match loading?)" };
    const chosen: string[] = [];
    // Both the option string (HLL) and its index in the row (HLL: Vietnam) are computed and sent;
    // the game table decides which reaches the wire.
    const chosenIdx: number[] = [];
    for (let i = 0; i < 5; i++) {
      const pick = wanted[i]!;
      if (pick.toLowerCase() === "random" || pick === "") {
        chosenIdx.push(Math.floor(Math.random() * rows[i]!.length));
        chosen.push(rows[i]![chosenIdx[i]!]!);
      } else if (rows[i]!.includes(pick)) {
        chosenIdx.push(rows[i]!.indexOf(pick));
        chosen.push(pick);
      } else {
        return { refusal: `"${pick}" is not one of row ${i + 1}'s objectives right now (${rows[i]!.join(", ")}) — refresh and pick again` };
      }
    }
    const mapId = normalizeSession(await client.readState("session").catch(() => null)).mapId ?? "";
    await client.execute("setSectorLayout", {
      mapId,
      sector1: chosen[0], sector2: chosen[1], sector3: chosen[2], sector4: chosen[3], sector5: chosen[4],
      sector1Index: chosenIdx[0], sector2Index: chosenIdx[1], sector3Index: chosenIdx[2], sector4Index: chosenIdx[3], sector5Index: chosenIdx[4],
    });
    const match = await repo.matches.recordSectorLayout({ serverId: server.id, layout: chosen, by: actor.name });
    // Vietnam STORES the layout forever (p11 has no expiry), so "for the next N plays" is OURS:
    // a countdown row the worker decrements on each new round of the map, clearing the store at
    // zero. The round already running is pinned as counted — the no-restart save never touched
    // it. Saving without a count is permanent, and REPLACES any countdown that stood.
    const keep = server.game === "hllv" ? opts.keepPlays ?? null : null;
    if (server.game === "hllv") {
      if (keep && keep >= 1 && mapId) {
        const open = await repo.matches.getOpen(server.id).catch(() => null);
        await repo.layoutExpiries.set({ serverId: server.id, mapId, playsLeft: keep, lastMatchId: open?.id ?? null, setBy: actor.name });
      } else if (mapId) {
        await repo.layoutExpiries.delete(server.id, mapId);
      }
    }
    await repo.audit.create({
      actorUserId: actor.userId, actorName: actor.name, action: "map.objectives",
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id,
      summary: `set the objectives on ${server.name} to ${chosen.join(" / ")}` +
        (keep ? ` — kept for the next ${keep} play(s) of the map, then back to the server's own picks` : ""),
      data: { objectives: chosen, matchId: match?.id ?? null, ...(server.game === "hllv" ? { keepPlays: keep } : {}) },
    });
    return { objectives: chosen, recordedOnMatchId: match?.id ?? null };
  } finally {
    await client.disconnect().catch(() => {});
  }
}
