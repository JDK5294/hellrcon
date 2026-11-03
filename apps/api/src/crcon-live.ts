/**
 * The two live scoreboards as CRCON v12.3.0 computes them (rcon/player_stats.py), from what we hold:
 *
 *   - get_live_scoreboard is LiveStats: every player connected now, in the game's order, over their
 *     current session (CRCON's sessions[0]: their newest session, its start the first spawn), the
 *     server's log read back as far as the oldest session reaches.
 *   - get_live_game_stats is TimeWindowStats over the current round: everyone the round's log
 *     names, from the round's start to now.
 *
 * Both lay the current round's player cache over their rows (crcon-players.ts in the worker keeps
 * it). CRCON's current map is its newest round, whether it has ended or not.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { playerIdentityOf, getGame } from "@app/games";
import type { CrconPlayerCache, CrconRoundRow, EvtRow, PlayerRow, ServerRow } from "@app/db";
import type { AppContext } from "./context.js";
import {
  CRCON_LOG_HISTORY, crconFiledTemp, crconLineEncounters, crconLiveStats, crconRows, crconTimeWindowStats,
  type CrconSession, type CrconStatsPlayer,
} from "./crcon-stats.js";
import { CRCON_LOG_KINDS, crconLogLines, type CrconLogRound } from "./crcon-logs.js";
import { buildFiledPlayerStats, crconMapName, crconPlatform } from "./streamer.js";

/** How many rounds back a session's log is read with its rounds' caches (name lookups only). */
const ROUNDS_BACK = 12;

/** The round's player cache: its own, or the copy a short round kept. */
async function cacheOf(ctx: AppContext, round: CrconRoundRow): Promise<CrconPlayerCache> {
  const cache = round.matchId ? await ctx.repo.matches.crconPlayers(round.matchId) : await ctx.repo.matches.crconShortRoundPlayers(round.seq);
  return cache ?? [];
}

/** The rounds a window starting at `fromMs` can fall in (newest first), each with its cache. */
async function roundsSince(ctx: AppContext, server: ServerRow, fromMs: number): Promise<{ round: CrconRoundRow; cache: CrconPlayerCache }[]> {
  const rows = await ctx.repo.matches.crconRounds(server.id, ROUNDS_BACK, 0);
  const out: { round: CrconRoundRow; cache: CrconPlayerCache }[] = [];
  for (const round of rows) {
    out.push({ round, cache: await cacheOf(ctx, round) });
    if (Date.parse(round.startedAt) <= fromMs) break;
  }
  return out;
}

/** A round's window as record_line saw it: open until CRCON set an end (the next start, when it
 *  deferred the whistle). */
function logRound(round: CrconRoundRow, newer: CrconRoundRow | null, cache: CrconPlayerCache): CrconLogRound {
  const end = round.crconEndDeferred === true ? (newer ? newer.startedAt : null) : round.endedAt;
  return { startMs: Date.parse(round.startedAt), endMs: end ? Date.parse(end) : null, players: cache };
}

/** The server's events in a window as CRCON lines, with what the rows need to name players. */
async function linesFor(ctx: AppContext, server: ServerRow, fromMs: number, rounds: { round: CrconRoundRow; cache: CrconPlayerCache }[], window: { toMs?: number; limit?: number } = {}) {
  const events: EvtRow[] = await ctx.repo.events.window({
    serverId: server.id, kinds: [...CRCON_LOG_KINDS], from: new Date(fromMs).toISOString(),
    to: window.toMs === undefined ? undefined : new Date(window.toMs).toISOString(),
    limit: window.limit ?? CRCON_LOG_HISTORY,
  });
  const internal = new Set<string>();
  for (const e of events) {
    if (e.actorPlayerId) internal.add(e.actorPlayerId);
    if (e.victimPlayerId) internal.add(e.victimPlayerId);
  }
  const players = internal.size ? await ctx.repo.players.findByIds([...internal]) : [];
  const platformOf = new Map(players.map((p) => [p.id, p.platformId]));
  const logRounds = rounds.map(({ round, cache }, i) => logRound(round, i > 0 ? rounds[i - 1]!.round : null, cache));
  const logs = crconLogLines(events, (id) => platformOf.get(id) ?? null, logRounds);
  // The last name each platform id was seen with, for a server that keys nemeses by name.
  const names = new Map<string, string>();
  for (const l of logs) {
    if (l.player_id_1 && l.player_name_1) names.set(l.player_id_1, l.player_name_1);
    if (l.player_id_2 && l.player_name_2) names.set(l.player_id_2, l.player_name_2);
  }
  return { logs, names };
}

/** The stored platform of each platform id on this server's game (CRCON's soldier.platform). */
async function storedPlatforms(ctx: AppContext, server: ServerRow, platformIds: Iterable<string>): Promise<Map<string, PlayerRow>> {
  const ids = [...new Set(platformIds)];
  const rows = ids.length ? await ctx.repo.players.findByPlatformIds(ids) : [];
  const game = server.game;
  const out = new Map<string, PlayerRow>();
  for (const p of rows) if (!out.has(p.platformId) || p.game === game) out.set(p.platformId, p);
  return out;
}

export interface CrconLiveResult {
  snapshotMs: number;
  stats: Record<string, unknown>[];
}

/** get_live_scoreboard's stats: LiveStats over the connected roster, with the current round's cache. */
export async function crconLiveScoreboard(ctx: AppContext, server: ServerRow, roster: Record<string, unknown>[], nowMs: number): Promise<CrconLiveResult> {
  const mod = getGame(server.game);
  const players: CrconStatsPlayer[] = [];
  for (const pl of roster) {
    const who = playerIdentityOf(mod, pl);
    players.push({ name: String(pl?.name ?? ""), player_id: who?.platformId ?? "", platform: typeof pl?.platform === "string" ? pl.platform : null });
  }
  const known = await storedPlatforms(ctx, server, players.map((p) => p.player_id).filter(Boolean));
  const internalIds = [...known.values()].map((p) => p.id);
  const latest = internalIds.length ? await ctx.repo.sessions.latestFor(internalIds) : new Map<string, { connectedAt: string; disconnectedAt: string | null }>();
  const sessions = new Map<string, CrconSession>();
  for (const [platformId, p] of known) {
    const s = latest.get(p.id);
    if (s) sessions.set(platformId, { startMs: Date.parse(s.connectedAt), ended: s.disconnectedAt !== null });
  }
  const sessionTime = (id: string) => {
    const s = sessions.get(id);
    return !s || s.ended || s.startMs === null ? 0 : Math.trunc((nowMs - s.startMs) / 1000);
  };
  const withIds = players.filter((p) => p.player_id);
  // CRCON takes the oldest session among the players with an id: with players but none of them,
  // its max() of nothing raises, the pass fails, and its last snapshot stands.
  if (players.length && !withIds.length) throw new Error("no player on the roster has an id");
  const oldest = withIds.length ? Math.max(...withIds.map((p) => sessionTime(p.player_id))) : 0;
  const fromMs = nowMs - oldest * 1000;
  const rounds = await roundsSince(ctx, server, fromMs);
  const { logs, names } = await linesFor(ctx, server, fromMs, rounds);
  for (const p of withIds) names.set(p.player_id, p.name);
  const figures = crconLiveStats({
    nowMs, players, logs,
    session: (id) => sessions.get(id) ?? null,
    storedPlatform: (id) => crconPlatform(known.get(id)?.platform ?? null),
  });
  const current = rounds[0];
  const stats = crconRows(
    figures,
    current ? { name: crconMapName(current.round, current.round.game ?? server.game), playerStats: current.cache } : null,
    { publish: server.publicPlayerIds, nameOf: (id) => names.get(id) ?? null },
  );
  return { snapshotMs: nowMs, stats };
}

/** get_live_game_stats' stats: TimeWindowStats over the current round, start to now. */
export async function crconLiveGameStats(ctx: AppContext, server: ServerRow, nowMs: number): Promise<CrconLiveResult> {
  const [newest] = await ctx.repo.matches.crconRounds(server.id, 1, 0);
  if (!newest) return { snapshotMs: nowMs, stats: [] };
  const cache = await cacheOf(ctx, newest);
  const fromMs = Date.parse(newest.startedAt);
  const { logs, names } = await linesFor(ctx, server, fromMs, [{ round: newest, cache }]);
  const ids = new Set<string>();
  for (const l of logs) {
    if (l.player_id_1) ids.add(l.player_id_1);
    if (l.player_id_2) ids.add(l.player_id_2);
  }
  const known = await storedPlatforms(ctx, server, ids);
  const figures = crconTimeWindowStats({
    logs, fromMs, untilMs: nowMs, cooldownSec: 0, cachedPlayers: cache,
    storedPlatform: (id) => crconPlatform(known.get(id)?.platform ?? null),
  });
  const stats = crconRows(
    figures,
    { name: crconMapName(newest, newest.game ?? server.game), playerStats: cache },
    { publish: server.publicPlayerIds, nameOf: (id) => names.get(id) ?? null },
  );
  return { snapshotMs: nowMs, stats };
}

/** The most log lines one filed round reads (CRCON reads them all; a real round is a few thousand). */
const FILED_LOG_CAP = 200_000;

/**
 * A cache for a round that has none (recorded before the worker kept CRCON's, or imported): each
 * player's buckets as the round's stat rows hold them, nothing banked, and the game's counters and
 * unit history where we kept them. An imported round's rows hold the buckets CRCON itself filed.
 */
async function cacheFromStatRows(ctx: AppContext, matchId: string): Promise<CrconPlayerCache> {
  const rows = await ctx.repo.matches.statsForMatch(matchId);
  if (!rows.length) return [];
  const players = await ctx.repo.players.findByIds([...new Set(rows.map((r) => r.playerId))]);
  const platformOf = new Map(players.map((p) => [p.id, p.platformId]));
  const out: CrconPlayerCache = [];
  for (const r of rows) {
    const id = platformOf.get(r.playerId);
    if (!id) continue;
    const unit = r.units?.[r.units.length - 1] ?? { ts: 0, team: -111, squad: -111, role: -111 };
    out.push([id, {
      combat: r.combat, p_combat: 0, offense: r.offense, p_offense: 0, defense: r.defense, p_defense: 0, support: r.support, p_support: 0,
      vehicle_kills: r.vehicleKills, p_vehicle_kills: 0, vehicles_destroyed: r.vehiclesDestroyed, p_vehicles_destroyed: 0,
      kills_and_assists: r.killsAndAssists, p_kills_and_assists: r.killsAndAssistsPrev,
      deaths_and_redeploys: r.deathsAndRedeploys, p_deaths_and_redeploys: r.deathsAndRedeploysPrev,
      p_unit: unit, units: r.units ?? [], level: 0, p_coord: { x: 0, y: 0, z: 0 }, has_spawned: true,
      names: r.playerName ? [r.playerName] : [], status: "offline",
    }]);
  }
  return out;
}

/**
 * get_map_scoreboard's player rows: what CRCON's stats job filed for the round (workers._record_stats)
 * — TimeWindowStats over the round's log from its start to its end, both included, a hundred
 * seconds' cooldown off a session still open at the end, combined with the round's player cache —
 * each with the view's encounters on the end.
 */
export async function crconFiledRows(ctx: AppContext, server: ServerRow, round: CrconRoundRow, newer: CrconRoundRow | null): Promise<Record<string, unknown>[]> {
  const startMs = Date.parse(round.startedAt);
  const endIso = (round.crconEndDeferred === true || !round.endedAt ? newer?.startedAt : round.endedAt) ?? round.endedAt ?? round.startedAt;
  const endMs = Date.parse(endIso);
  let cache = await (round.matchId ? ctx.repo.matches.crconPlayers(round.matchId) : ctx.repo.matches.crconShortRoundPlayers(round.seq));
  if (!cache && round.matchId) cache = await cacheFromStatRows(ctx, round.matchId);
  cache ??= [];
  // `till` is inclusive on CRCON's side and `to` exclusive here: a millisecond past the end.
  const { logs, names } = await linesFor(ctx, server, startMs, [{ round, cache }], { toMs: endMs + 1, limit: FILED_LOG_CAP });
  const ids = new Set<string>();
  for (const l of logs) {
    if (l.player_id_1) ids.add(l.player_id_1);
    if (l.player_id_2) ids.add(l.player_id_2);
  }
  const known = await storedPlatforms(ctx, server, ids);
  const figures = crconTimeWindowStats({
    logs, fromMs: startMs, untilMs: endMs, cooldownSec: 100, cachedPlayers: cache,
    storedPlatform: (id) => crconPlatform(known.get(id)?.platform ?? null),
  });
  const policy = { publish: server.publicPlayerIds, nameOf: (id: string) => names.get(id) ?? null };
  const cached = new Map(cache);
  const encounters = crconLineEncounters(logs, startMs, endMs, new Set(figures.keys()));
  return [...figures.values()].map((f, i) => ({
    ...buildFiledPlayerStats(f, crconFiledTemp(cached.get(f.player_id)), i, round.seq, round.matchTime, policy),
    encounters: (encounters.get(f.player_id) ?? []).map((e) => ({ ...e, player_id: policy.publish ? e.player_id : null })),
  }));
}
