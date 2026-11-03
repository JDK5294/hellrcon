/**
 * CRCON's player statistics, ported from rcon/player_stats.py at v12.3.0: the rows its live
 * scoreboards publish (LiveStats behind get_live_scoreboard, TimeWindowStats behind
 * get_live_game_stats) and the game-log half of every row it files when a round ends.
 *
 * Every figure is CRCON's own arithmetic over its own reading of the game log, quirks included,
 * because a tool built against CRCON reads these numbers as CRCON writes them:
 *
 *   - A row starts as get_default_player_stats, key for key. The three rates stay the int 0 until
 *     a log line is processed for the player, and are round(…, 2) floats from then on.
 *   - most_killed and death_by are keyed by the other player's id, in the order first met.
 *   - A life runs from the last spawn CRCON knows of (the session's start, a CONNECTED line, the
 *     previous death) to a death. The shortest life starts at 0 and only ever takes min() from
 *     there, so it is 0 or below, never a real minimum.
 *   - VOTE STARTED counts for every player the line is filed under: the target as well.
 *   - Session time is whole seconds truncated toward zero, and can be negative where CRCON's two
 *     guesses cross (a first sighting is dated three minutes after the window opens).
 *
 * The overlay of the round's player cache (_apply_current_map_player_stats) is here too: the score
 * buckets, level, side, faction and status come from crcon-players.ts's cache, and a player the
 * cache holds loses id, map_id and units from the row.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { pyDateUtc, pyFloat, pyRound, type PyFloat } from "./crcon-json.js";
import { crconParseLayer } from "@app/maps";
import type { CrconPlayerCache, CrconPlayerStat } from "@app/db";

/** A game-log line as CRCON's stats read it (StructuredLogLineWithMetaData, the fields used). */
export interface CrconLogLine {
  action: string;
  /** The line's own timestamp: whole seconds, in ms. */
  timestampMs: number;
  player_name_1: string | null;
  player_id_1: string | null;
  player_name_2: string | null;
  player_id_2: string | null;
  weapon: string | null;
  /** The line as CRCON keeps it; only the vote handler reads it (PV_Favour / PV_Against). */
  raw: string;
}

/** A player as get_stats_by_player receives one. */
export interface CrconStatsPlayer {
  name: string;
  player_id: string;
  /** The game's platform string, for a connected player; falsy falls back to the stored one. */
  platform?: string | null;
}

/** One player's figures as BaseStats accumulates them; crconRow lays them out. */
export interface CrconPlayerFigures {
  player_id: string;
  player: string;
  platform: string | null;
  kills: number;
  kills_streak: number;
  deaths: number;
  deaths_without_kill_streak: number;
  teamkills: number;
  teamkills_streak: number;
  deaths_by_tk: number;
  deaths_by_tk_streak: number;
  nb_vote_started: number;
  nb_voted_yes: number;
  nb_voted_no: number;
  time_seconds: number;
  /** last_spawn, epoch ms. */
  lastSpawnMs: number | null;
  /** Whether any log line was processed: the rates are floats only then. */
  rated: boolean;
  longest_life_secs: number;
  shortest_life_secs: number;
  most_killed: Map<string, number>;
  death_by: Map<string, number>;
  weapons: Map<string, number>;
  death_by_weapons: Map<string, number>;
}

interface Streaks {
  kill: number;
  death: number;
  teamkills: number;
  deathsByTk: number;
}

const bump = (dict: Map<string, number>, key: string) => dict.set(key, (dict.get(key) ?? 0) + 1);

/** is_same_log_player: by id when both sides have one, else by name. */
function isSameLogPlayer(player: CrconStatsPlayer, log: CrconLogLine, slot: 1 | 2): boolean {
  const logId = slot === 1 ? log.player_id_1 : log.player_id_2;
  const logName = slot === 1 ? log.player_name_1 : log.player_name_2;
  if (player.player_id && logId) return player.player_id === logId;
  return player.name === logName;
}

// The vote handler's three patterns, used with re.match on the raw line: `.` stops at a newline.
const VOTED_NO = /^[^\n]*PV_Against/;
const VOTED_YES = /^[^\n]*PV_Favour/;

function processLog(stats: CrconPlayerFigures, player: CrconStatsPlayer, log: CrconLogLine): void {
  const kill = isSameLogPlayer(player, log, 1);
  const death = isSameLogPlayer(player, log, 2);
  switch (log.action) {
    case "KILL":
      if (kill) stats.kills += 1;
      else if (death) stats.deaths += 1;
      if (kill) {
        bump(stats.weapons, log.weapon ?? "");
        bump(stats.most_killed, log.player_id_2 ?? "");
      }
      if (death) {
        bump(stats.death_by_weapons, log.weapon ?? "");
        bump(stats.death_by, log.player_id_1 ?? "");
      }
      return;
    case "TEAM KILL":
      if (kill) stats.teamkills += 1;
      else if (death) stats.deaths_by_tk += 1;
      return;
    case "VOTE STARTED":
      stats.nb_vote_started += 1;
      return;
    case "VOTE":
      if (VOTED_NO.test(log.raw)) stats.nb_voted_no += 1;
      else if (VOTED_YES.test(log.raw)) stats.nb_voted_yes += 1;
      return;
  }
}

/** _process_death_time: a life from the last spawn to now, in whole seconds toward zero. */
function processDeathTime(stats: CrconPlayerFigures, logMs: number, saveSpawn = true): void {
  if (stats.lastSpawnMs === null) {
    stats.lastSpawnMs = logMs;
    return;
  }
  const lived = Math.trunc((logMs - stats.lastSpawnMs) / 1000);
  stats.longest_life_secs = Math.max(lived, stats.longest_life_secs);
  stats.shortest_life_secs = Math.min(lived, stats.shortest_life_secs);
  if (saveSpawn) stats.lastSpawnMs = logMs;
}

function calcStreaks(stats: CrconPlayerFigures, player: CrconStatsPlayer, log: CrconLogLine, streaks: Streaks): void {
  if (log.action === "KILL") {
    if (isSameLogPlayer(player, log, 1)) {
      streaks.kill += 1;
      streaks.death = 0;
      streaks.teamkills = 0;
    } else if (isSameLogPlayer(player, log, 2)) {
      streaks.kill = 0;
      streaks.deathsByTk = 0;
      streaks.death += 1;
      processDeathTime(stats, log.timestampMs);
    }
  }
  if (log.action === "TEAM KILL") {
    if (isSameLogPlayer(player, log, 1)) streaks.teamkills += 1;
    if (isSameLogPlayer(player, log, 2)) {
      streaks.deathsByTk += 1;
      processDeathTime(stats, log.timestampMs);
    }
  }
  if (log.action === "CONNECTED") stats.lastSpawnMs = log.timestampMs;
  if (log.action === "DISCONNECTED") processDeathTime(stats, log.timestampMs, false);
  stats.kills_streak = Math.max(streaks.kill, stats.kills_streak);
  stats.deaths_without_kill_streak = Math.max(streaks.death, stats.deaths_without_kill_streak);
  stats.teamkills_streak = Math.max(streaks.teamkills, stats.teamkills_streak);
  stats.deaths_by_tk_streak = Math.max(streaks.deathsByTk, stats.deaths_by_tk_streak);
}

/** What get_stats_by_player asks of the Stats class it runs in. */
export interface CrconStatsHooks {
  /** soldier.platform: the platform stored for the player, or null. */
  storedPlatform(playerId: string): string | null;
  /** _get_player_session_time. */
  sessionTime(player: CrconStatsPlayer): number;
  /** _get_player_first_appearance, epoch ms. */
  firstAppearance(player: CrconStatsPlayer): number | null;
}

/**
 * get_stats_by_player: one row per player id (the last record for an id wins, at the place the id
 * first came), each from its own log lines in order.
 */
export function crconStatsByPlayer(
  indexedLogs: Map<string, CrconLogLine[]>,
  players: CrconStatsPlayer[],
  hooks: CrconStatsHooks,
): Map<string, CrconPlayerFigures> {
  const unique = new Map<string, CrconStatsPlayer>();
  for (const p of players) if (p.player_id) unique.set(p.player_id, p);
  const out = new Map<string, CrconPlayerFigures>();
  for (const player of unique.values()) {
    const stats: CrconPlayerFigures = {
      player_id: player.player_id,
      player: player.name,
      platform: player.platform || hooks.storedPlatform(player.player_id),
      kills: 0, kills_streak: 0, deaths: 0, deaths_without_kill_streak: 0,
      teamkills: 0, teamkills_streak: 0, deaths_by_tk: 0, deaths_by_tk_streak: 0,
      nb_vote_started: 0, nb_voted_yes: 0, nb_voted_no: 0,
      time_seconds: Math.trunc(hooks.sessionTime(player)),
      lastSpawnMs: hooks.firstAppearance(player),
      rated: false,
      longest_life_secs: 0,
      shortest_life_secs: 0,
      most_killed: new Map(), death_by: new Map(), weapons: new Map(), death_by_weapons: new Map(),
    };
    const streaks: Streaks = { kill: 0, death: 0, teamkills: 0, deathsByTk: 0 };
    for (const log of indexedLogs.get(player.player_id) ?? []) {
      processLog(stats, player, log);
      calcStreaks(stats, player, log, streaks);
      stats.rated = true;
    }
    out.set(player.player_id, stats);
  }
  return out;
}

/** The player's current session as CRCON's profile reports it (sessions[0], newest created). */
export interface CrconSession {
  startMs: number | null;
  ended: boolean;
}

/** LiveStats' inputs: the connected players in the game's order, and the server's recent log. */
export interface CrconLiveInput {
  nowMs: number;
  players: CrconStatsPlayer[];
  /** sessions[0] of the player's profile; null when there is no profile or no session. */
  session(playerId: string): CrconSession | null;
  storedPlatform(playerId: string): string | null;
  /** The server's log lines, oldest first; only those inside the window are read. */
  logs: CrconLogLine[];
}

/** LogsHistory's length: get_recent_logs reads no further back than this many lines. */
export const CRCON_LOG_HISTORY = 100_000;

/**
 * LiveStats.get_current_players_stats without the overlay: every connected player's figures over
 * their current session, the log read back as far as the oldest session reaches.
 */
export function crconLiveStats(input: CrconLiveInput): Map<string, CrconPlayerFigures> {
  const players = input.players.filter((p) => p.player_id);
  if (players.length === 0) return new Map();
  const nowSec = input.nowMs / 1000;
  const sessionTime = (p: CrconStatsPlayer): number => {
    const s = input.session(p.player_id);
    if (!s || s.ended || s.startMs === null) return 0;
    return Math.trunc((input.nowMs - s.startMs) / 1000);
  };
  const oldest = Math.max(...players.map(sessionTime));
  const minSec = nowSec - oldest;
  const window: CrconLogLine[] = [];
  for (let i = input.logs.length - 1; i >= 0 && window.length < CRCON_LOG_HISTORY; i--) {
    const log = input.logs[i]!;
    if (log.timestampMs / 1000 < minSec) break;
    window.push(log);
  }
  window.reverse();

  const byId = new Map(players.map((p) => [p.player_id, p]));
  const byName = new Map(players.map((p) => [p.name, p]));
  const inSession = (p: CrconStatsPlayer, log: CrconLogLine) => log.timestampMs >= (nowSec - sessionTime(p)) * 1000;
  const indexed = new Map<string, CrconLogLine[]>();
  const file = (key: string | null, log: CrconLogLine) => {
    if (!key) return;
    let list = indexed.get(key);
    if (!list) indexed.set(key, (list = []));
    list.push(log);
  };
  for (const log of window) {
    const p1 = (log.player_id_1 ? byId.get(log.player_id_1) : undefined) ?? (log.player_name_1 !== null ? byName.get(log.player_name_1) : undefined);
    const p2 = (log.player_id_2 ? byId.get(log.player_id_2) : undefined) ?? (log.player_name_2 !== null ? byName.get(log.player_name_2) : undefined);
    if (p1 && inSession(p1, log)) file(log.player_id_1, log);
    if (p2 && inSession(p2, log)) file(log.player_id_2, log);
  }

  return crconStatsByPlayer(indexed, players, {
    storedPlatform: input.storedPlatform,
    sessionTime,
    firstAppearance: (p) => input.session(p.player_id)?.startMs ?? null,
  });
}

/** TimeWindowStats' inputs: a window of the server's log and the round's player cache. */
export interface CrconWindowInput {
  /** The window's log lines, oldest first. */
  logs: CrconLogLine[];
  fromMs: number;
  untilMs: number;
  /** Seconds taken off the end of a session still open at the window's end: 0 live, 100 filed. */
  cooldownSec: number;
  /** The round's player cache, for the names a line carries without an id. */
  cachedPlayers: CrconPlayerCache;
  storedPlatform(playerId: string): string | null;
}

/** The warm-up _set_start_end_times credits a player first seen without a CONNECTED line. */
const FIRST_SIGHT_OFFSET_MS = 180_000;

/**
 * TimeWindowStats._get_players_stats_from_logs without the overlay: everyone a line in the window
 * names, their session time pieced together from connects and disconnects, their figures from
 * every line naming them. Rows come in the order players first appear (CRCON's own order is a
 * Python set's, which no two processes share), under the last name an id was seen with.
 */
export function crconTimeWindowStats(input: CrconWindowInput): Map<string, CrconPlayerFigures> {
  const nameToId = new Map<string, string>();
  for (const [id, line] of input.cachedPlayers) for (const name of line.names) nameToId.set(name, id);
  const indexed = new Map<string, CrconLogLine[]>();
  const names = new Map<string, string>();
  const times = new Map<string, { start: number[]; end: number[]; total: number }>();

  const setTimes = (key: string, log: CrconLogLine) => {
    const t = log.timestampMs;
    let rec = times.get(key);
    if (log.action === "CONNECTED") {
      if (!rec) times.set(key, (rec = { start: [], end: [], total: 0 }));
      rec.start.push(t);
      return;
    }
    if (!rec && log.action !== "DISCONNECTED") {
      times.set(key, { start: [input.fromMs + FIRST_SIGHT_OFFSET_MS], end: [], total: 0 });
      return;
    }
    if (rec && log.action === "DISCONNECTED") {
      rec.end.push(t);
      return;
    }
    if (!rec && log.action === "DISCONNECTED") times.set(key, { start: [t], end: [t], total: 0 });
  };

  for (const log of input.logs) {
    for (const slot of [1, 2] as const) {
      const name = slot === 1 ? log.player_name_1 : log.player_name_2;
      const id = slot === 1 ? log.player_id_1 : log.player_id_2;
      if (!id && !name) continue;
      const key = id || nameToId.get(name!);
      if (!key) continue;
      if (name) {
        names.set(key, name);
        if (!nameToId.has(name)) nameToId.set(name, key);
      }
      setTimes(key, log);
      let list = indexed.get(key);
      if (!list) indexed.set(key, (list = []));
      list.push(log);
    }
  }

  for (const rec of times.values()) {
    rec.total = 0;
    if (rec.start.length === 0) continue;
    if (rec.start.length === rec.end.length + 1) rec.end.push(input.untilMs - input.cooldownSec * 1000);
    if (rec.start.length !== rec.end.length) continue;
    for (let i = 0; i < rec.start.length; i++) rec.total += Math.trunc((rec.end[i]! - rec.start[i]!) / 1000);
  }

  // Each id where it first appears, under the last name it was seen with.
  const players: CrconStatsPlayer[] = [];
  for (const key of indexed.keys()) {
    const name = names.get(key);
    if (name !== undefined) players.push({ name, player_id: key });
  }
  return crconStatsByPlayer(indexed, players, {
    storedPlatform: input.storedPlatform,
    sessionTime: (p) => times.get(p.player_id)?.total ?? 0,
    firstAppearance: (p) => times.get(p.player_id)?.start[0] ?? null,
  });
}

/** Whether, and how, a published row may carry players' ids (the server's publicPlayerIds). */
export interface CrconIdPolicy {
  publish: boolean;
  /** For a server that keeps ids private: the name to key most_killed / death_by by instead. */
  nameOf?(playerId: string): string | null;
}

const rate = (x: number): PyFloat => pyFloat(pyRound(x, 2));

/** most_killed / death_by for the wire: by id, or by name where ids stay private. */
function nemesisDict(dict: Map<string, number>, ids: CrconIdPolicy): Map<string, number> {
  if (ids.publish) return new Map(dict);
  const out = new Map<string, number>();
  for (const [id, n] of dict) {
    const key = ids.nameOf?.(id) ?? "";
    out.set(key, (out.get(key) ?? 0) + n);
  }
  return out;
}

/** The round CRCON calls its current map: its layer name and its player cache. */
export interface CrconCurrentMap {
  name: string;
  playerStats: CrconPlayerCache;
}

/**
 * The published rows: get_default_player_stats filled in, then _apply_current_map_player_stats
 * when there is a current map. A player the cache holds takes their score buckets, level, side,
 * faction and status from it and loses id, map_id and units; everyone else keeps the defaults.
 */
export function crconRows(
  figures: Map<string, CrconPlayerFigures>,
  currentMap: CrconCurrentMap | null,
  ids: CrconIdPolicy,
): Record<string, unknown>[] {
  const cache = currentMap ? new Map<string, CrconPlayerStat>(currentMap.playerStats) : null;
  // parse_layer runs once, before any row, as CRCON's does: a name it cannot read fails them all.
  const layer = currentMap ? crconParseLayer(currentMap.name, "hll") : null;
  const rows: Record<string, unknown>[] = [];
  for (const s of figures.values()) {
    const minutes = Math.max(s.time_seconds / 60, 1);
    const head = {
      player_id: ids.publish ? s.player_id : null,
      player: s.player,
      platform: s.platform,
      steaminfo: null,
    };
    const counts = {
      kills: s.kills,
      kills_streak: s.kills_streak,
      deaths: s.deaths,
      deaths_without_kill_streak: s.deaths_without_kill_streak,
      teamkills: s.teamkills,
      teamkills_streak: s.teamkills_streak,
      deaths_by_tk: s.deaths_by_tk,
      deaths_by_tk_streak: s.deaths_by_tk_streak,
      nb_vote_started: s.nb_vote_started,
      nb_voted_yes: s.nb_voted_yes,
      nb_voted_no: s.nb_voted_no,
      time_seconds: s.time_seconds,
      last_spawn: s.lastSpawnMs === null ? null : pyDateUtc(s.lastSpawnMs),
      kills_per_minute: s.rated ? rate(s.kills / minutes) : 0,
      deaths_per_minute: s.rated ? rate(s.deaths / minutes) : 0,
      kill_death_ratio: s.rated ? rate(s.kills / Math.max(s.deaths, 1)) : 0,
      longest_life_secs: s.longest_life_secs,
      shortest_life_secs: s.shortest_life_secs,
    };
    const dicts = {
      most_killed: nemesisDict(s.most_killed, ids),
      death_by: nemesisDict(s.death_by, ids),
      weapons: new Map(s.weapons),
      death_by_weapons: new Map(s.death_by_weapons),
    };
    const line = cache?.get(s.player_id);
    if (!line) {
      rows.push({
        id: 0, ...head, map_id: 0, ...counts,
        combat: 0, offense: 0, defense: 0, support: 0,
        ...dicts,
        team: null, units: [], level: 0, vehicles_destroyed: 0, vehicle_kills: 0, kills_and_assists: 0, deaths_and_redeploys: 0,
      });
      continue;
    }
    const side = line.p_unit?.team === 1 ? "allies" : line.p_unit?.team === 2 ? "axis" : null;
    rows.push({
      ...head, ...counts,
      combat: line.combat + line.p_combat,
      offense: line.offense + line.p_offense,
      defense: line.defense + line.p_defense,
      support: line.support + line.p_support,
      ...dicts,
      team: side,
      level: line.level,
      vehicles_destroyed: line.vehicles_destroyed + line.p_vehicles_destroyed,
      vehicle_kills: line.vehicle_kills + line.p_vehicle_kills,
      kills_and_assists: line.kills_and_assists + line.p_kills_and_assists,
      deaths_and_redeploys: line.deaths_and_redeploys + line.p_deaths_and_redeploys,
      faction: side === "allies" ? layer!.map.allies.name.toLowerCase() : side === "axis" ? layer!.map.axis.name.toLowerCase() : null,
      status: line.status,
    });
  }
  return rows;
}

/** The cache's half of a filed row (workers._compute_temporary_stats), level and units included. */
export interface CrconFiledTemp {
  combat: number;
  offense: number;
  defense: number;
  support: number;
  vehicle_kills: number;
  vehicles_destroyed: number;
  kills_and_assists: number;
  deaths_and_redeploys: number;
  level: number;
  units: CrconPlayerStat["units"];
}

/**
 * _compute_temporary_stats: each bucket plus its banked p_ total — but only where the bucket
 * itself is not 0, so a player whose last session scored nothing files 0 whatever they banked.
 * A player the round's cache never held files get_temp_default_stats: zeros and no units.
 */
export function crconFiledTemp(line: CrconPlayerStat | undefined): CrconFiledTemp {
  const add = (base: number, banked: number) => (Number.isInteger(banked) && base ? base + banked : base);
  if (!line) {
    return { combat: 0, offense: 0, defense: 0, support: 0, vehicle_kills: 0, vehicles_destroyed: 0, kills_and_assists: 0, deaths_and_redeploys: 0, level: 0, units: [] };
  }
  return {
    combat: add(line.combat, line.p_combat),
    offense: add(line.offense, line.p_offense),
    defense: add(line.defense, line.p_defense),
    support: add(line.support, line.p_support),
    vehicle_kills: add(line.vehicle_kills, line.p_vehicle_kills),
    vehicles_destroyed: add(line.vehicles_destroyed, line.p_vehicles_destroyed),
    kills_and_assists: add(line.kills_and_assists, line.p_kills_and_assists),
    deaths_and_redeploys: add(line.deaths_and_redeploys, line.p_deaths_and_redeploys),
    level: line.level,
    units: line.units ?? [],
  };
}

/** The rates a filed row stores, in float columns: round(…, 2) once a line was read, else 0. */
export function crconFiledRates(f: CrconPlayerFigures): { kpm: PyFloat; dpm: PyFloat; kdr: PyFloat } {
  const minutes = Math.max(f.time_seconds / 60, 1);
  return f.rated
    ? { kpm: rate(f.kills / minutes), dpm: rate(f.deaths / minutes), kdr: rate(f.kills / Math.max(f.deaths, 1)) }
    : { kpm: pyFloat(0), dpm: pyFloat(0), kdr: pyFloat(0) };
}

/** most_killed / death_by as a filed row keeps them (before jsonb orders them). */
export function crconNemeses(dict: Map<string, number>, ids: CrconIdPolicy): Map<string, number> {
  return nemesisDict(dict, ids);
}

/**
 * get_map_scoreboard's encounters (scoreboards.py): the round's KILL lines from its start to its
 * end, both ends included, filed under the killer as KILL and the victim as DEATH for every player
 * the round's rows hold. `ts` is whole seconds since the start.
 */
export function crconLineEncounters(lines: CrconLogLine[], startMs: number, endMs: number, players: Set<string>): Map<string, { action: string; player_id: string | null; player_name: string | null; ts: number; weapon: string | null }[]> {
  const out = new Map<string, { action: string; player_id: string | null; player_name: string | null; ts: number; weapon: string | null }[]>();
  for (const id of players) out.set(id, []);
  for (const l of lines) {
    if (l.action !== "KILL" || l.timestampMs < startMs || l.timestampMs > endMs) continue;
    const ts = Math.trunc((l.timestampMs - startMs) / 1000);
    if (l.player_id_1 && out.has(l.player_id_1)) out.get(l.player_id_1)!.push({ action: "KILL", player_id: l.player_id_2, player_name: l.player_name_2, ts, weapon: l.weapon });
    if (l.player_id_2 && out.has(l.player_id_2)) out.get(l.player_id_2)!.push({ action: "DEATH", player_id: l.player_id_1, player_name: l.player_name_1, ts, weapon: l.weapon });
  }
  return out;
}
