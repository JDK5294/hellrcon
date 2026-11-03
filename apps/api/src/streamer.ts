/**
 * Streamer mode — answering CRCON's public HTTP API, byte-for-byte, without a login.
 *
 * Established Hell Let Loose streamers already run overlay tools written against CRCON. Rather
 * than asking them to build something special for us, a server can be switched to serve the same
 * endpoint names with the same JSON, so an existing tool works unchanged.
 *
 * The contract here was read out of CRCON's source, not remembered — see docs/streamer-mode.md
 * for the derivation, the field-by-field mapping, and the six places our data does not (yet)
 * reach CRCON's. Everything in this file is a pure builder or a whitelist; the routes that use it
 * live in routes/streamer.ts.
 *
 * Two rules govern every change to this file:
 *   1. The whitelist is the security boundary. An endpoint that is not in ENDPOINTS does not
 *      exist to an anonymous caller, whatever else the app can do.
 *   2. Absent data is CRCON's own empty value, never a fabrication. A plausible invention is
 *      worse than the null CRCON itself returns when its recorder is offline.
 *
 * ---------------------------------------------------------------------------------------------
 * Portions derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool:
 *   its layer-id grammar and attacker table (rcon/maps.py), and the records its API builds, which
 *   this file rebuilds key for key. Copyright (c) 2020 Julien Marechal. MIT License; full text in
 *   third_party/crcon/LICENSE.
 */

import { describeMap, CRCON_MAPS, crconLayerDump, crconMapNameFromRecord, crconParseLayer, crconParseLayerOrUnknown, resolveVoteWinner } from "@app/maps";
import { jsonbOrdered, pyDateNaive, pyDateUtc, pyFloat, pyInt } from "./crcon-json.js";
import { crconDetectTeam, crconWeaponTypeUsage } from "./crcon-weapons.js";
import { crconFiledRates, crconNemeses, type CrconFiledTemp, type CrconIdPolicy, type CrconPlayerFigures } from "./crcon-stats.js";

/**
 * The complete public surface.
 *
 * Of CRCON's 304 endpoints exactly these eight answer without authentication: `get_version` and
 * `get_public_info` unconditionally, the six scoreboard reads whenever `lock_stats_api` is unset
 * (its default). Nothing else belongs here — notably NOT `run_raw_command`, which reads as
 * unauthenticated in CRCON's source because it carries no `login_required`, but is gated by
 * `permission_required("api.can_run_raw_commands")`. It executes arbitrary RCON.
 *
 * The per-IP budgets USED to be CRCON's own numbers, copied from the `@ratelimit` decorators on
 * those views: 60/m, and 10/m on the two history reads. CRCON deleted all six in v12.1.0, as a
 * bug fix — "rate limiting on public endpoints that caused 403 errors for public stats pages" —
 * and the reason is arithmetic. A budget is per IP, one page view makes several calls, an overlay
 * polls on a timer, and a household or a campus shares one address: 10/m is reached by one person
 * pressing refresh twice.
 *
 * So the numbers are ours now, not a copy, and they are set where a limit cannot be the thing
 * that breaks a viewer: far above any real pattern, still a brake on a scripted flood. Keeping
 * the mechanism is a deliberate difference from upstream — they can lean on their deployment's
 * proxy, and this app is handed to communities who run it however they run it.
 */
const PUBLIC_BUDGET_PER_MINUTE = 600; // 10 a second from one address

export const ENDPOINTS: Record<string, { perMinute: number }> = {
  get_version: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
  get_public_info: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
  get_live_scoreboard: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
  get_live_game_stats: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
  get_scoreboard_maps: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
  get_map_scoreboard: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
  get_map_history: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
  get_previous_map: { perMinute: PUBLIC_BUDGET_PER_MINUTE },
};

/** Endpoints this build actually answers — since the public stats page, all eight of them. The
 *  set stays (rather than being deleted as always-true) so a future endpoint that arrives
 *  contract-first can be budgeted before it is implemented, exactly as these four once were. */
export const IMPLEMENTED = new Set([
  "get_version", "get_public_info", "get_map_history", "get_previous_map",
  "get_live_scoreboard", "get_live_game_stats", "get_scoreboard_maps", "get_map_scoreboard",
]);

export interface Envelope {
  result: unknown;
  command: string;
  arguments: Record<string, unknown> | Map<string, unknown> | null;
  failed: boolean;
  error: unknown;
  forwards_results: null;
  version: string;
}

/**
 * CRCON's response wrapper. Every reply is this shape, success or failure, and **a 200 does not
 * mean the call worked — `failed` does**. Tools branch on `failed` and then read `result`, so the
 * envelope has to be present and correctly filled even on the error path.
 */
export function envelope(o: {
  result?: unknown;
  command: string;
  args?: Record<string, unknown> | Map<string, unknown> | null;
  failed?: boolean;
  error?: unknown;
  version: string;
}): Envelope {
  return {
    result: o.result ?? null,
    command: o.command,
    arguments: o.args ?? null,
    failed: o.failed ?? false,
    error: o.error ?? null,
    // Only ever populated by CRCON when a WRITE was forwarded to sibling servers. Streamer mode is
    // read-only, so this is structurally always null — but the key must exist.
    forwards_results: null,
    version: o.version,
  };
}

export interface PublicInfoInput {
  /** The server's game ("hll" or "hllv"): which catalogue the maps are read against, and config.game. */
  game: string;
  /** The live server name (CRCON's get_name, the session's serverName). */
  serverName: string;
  /** the staff-set public display name (servers.publicName), CRCON's `short_name`. */
  shortName: string;
  /** The session's layer id. */
  currentMapId: string;
  /** The rotation's next layer id; "unknown" when there is none, as CRCON's _get_next_map_id. */
  nextMapId: string;
  /**
   * The newest round on record (CRCON's MapsHistory()[0], ended or not), or null when there is
   * none: its start in epoch seconds and the timeline the recorder kept for it.
   */
  latest: { start: number | null; capFlips: [number, number, number][]; moraleHistory: [number, number, number][]; matchTime: number } | null;
  playerCount: number;
  maxPlayerCount: number;
  alliedPlayers: number;
  axisPlayers: number;
  alliedScore: number;
  axisScore: number;
  alliedMorale: number;
  axisMorale: number;
  initialMorale: number;
  timeRemainingSec: number;
  voteStatus: unknown;
  /**
   * The game's own `serverconfig` answer, or null when there is none to read (a legacy-text or
   * bridged server has no such read; a v2 server's must answer, see crconConfigComplete).
   */
  serverConfig: ServerConfigRead | null;
}

/** The game's raw `serverconfig` answer, as the wire sends it. */
export type ServerConfigRead = Record<string, unknown>;

/** The fields CRCON's get_server_config (rcon/commands.py) reads off `serverconfig`, by these names. */
const CONFIG_KEYS = ["buildNumber", "buildRevision", "passwordProtected", "serverName", "supportedPlatforms"] as const;

/** Whether a `serverconfig` answer holds every field CRCON reads. CRCON indexes each by name, so
 *  an answer missing one is a KeyError there, and its get_public_info a server error. */
export function crconConfigComplete(cfg: ServerConfigRead | null): boolean {
  return cfg !== null && !Array.isArray(cfg) && CONFIG_KEYS.every((k) => Object.hasOwn(cfg, k));
}

/** A recorded cap flip as CRCON's recorder writes it: MapScore(allied_score, axis_score, ts). */
export const capFlipOut = ([ts, allied, axis]: [number, number, number]) => ({ allied_score: allied, axis_score: axis, ts });
/** A morale point as CRCON's recorder writes it: {allied_morale, axis_morale, ts}. */
export const moraleOut = ([ts, allied, axis]: [number, number, number]) => ({ allied_morale: allied, axis_morale: axis, ts });

/**
 * `get_public_info`, key for key as CRCON v12.3.0's view builds it (rconweb/api/views.py). The
 * maps are the live session's and the rotation's, parsed as the game state parses them; start,
 * cap_flips, morale_history and match_time are the newest round's on record, the way CRCON reads
 * them off its map history whether that round has ended or not; time_remaining is a float of
 * whole seconds (a timedelta's total_seconds()); config is the game's own answer, untouched.
 */
export function buildPublicInfo(i: PublicInfoInput): Record<string, unknown> {
  const cfg = i.serverConfig;
  const raw = (key: (typeof CONFIG_KEYS)[number], fallback: unknown) => (cfg && Object.hasOwn(cfg, key) ? cfg[key] : fallback);
  return {
    current_map: { map: crconLayer(i.currentMapId, i.game, true), start: i.latest?.start ?? null },
    next_map: { map: crconLayer(i.nextMapId || "unknown", i.game, true), start: null },
    player_count: i.playerCount,
    max_player_count: i.maxPlayerCount,
    player_count_by_team: { allied: i.alliedPlayers, axis: i.axisPlayers },
    score: { allied: i.alliedScore, axis: i.axisScore },
    allied_morale: i.alliedMorale,
    axis_morale: i.axisMorale,
    initial_morale: i.initialMorale,
    morale_history: i.latest ? i.latest.moraleHistory.map(moraleOut) : [],
    cap_flips: i.latest ? i.latest.capFlips.map(capFlipOut) : null,
    match_time: i.latest ? i.latest.matchTime : 0,
    time_remaining: pyFloat(Math.trunc(i.timeRemainingSec)),
    vote_status: i.voteStatus,
    name: {
      name: i.serverName,
      short_name: i.shortName,
      // CRCON's own public-stats container ports (its PUBLIC_STATS_PORT env); none here.
      public_stats_port: null,
      public_stats_port_https: null,
    },
    config: {
      build_number: raw("buildNumber", ""),
      build_revision: raw("buildRevision", ""),
      password_protected: raw("passwordProtected", false),
      server_name: raw("serverName", i.serverName),
      supported_platforms: raw("supportedPlatforms", []),
      game: i.game,
    },
  };
}

/**
 * CRCON's `VoteMapStatus` for `get_public_info` (rcon/vote_map/service.py get_status, called
 * unsorted). Off, it is CRCON's fixed "disabled" answer, never null. On: each option of the
 * running vote in its own order as {voters, map, votes_count}; `next_map` is the PRETTY NAME of
 * the map the vote puts next.
 *
 * CRCON's is whatever its apply_results last applied (generate_next_map: the admin's next map,
 * else the most voted, else its default method), and restart() applies one the moment a vote
 * opens, so it names a map before anybody has voted. Ours is the result this vote's round end
 * would apply now, by the worker's own rule: a staff override, else the leader, the earliest of a
 * tie, or with no votes the default pick, the first option of a shuffled ballot — never the map in
 * play, which would replay it. Null only while there is no ballot.
 *
 * `voters` lists the in-game ballots, as CRCON lists the in-game players who voted
 * ({player_id, player_name, count}, the order players voted in): the name typed under, the game's
 * own player id where the server publishes ids (null on a names-only server, or for a ballot
 * matched by name), and a count of 1, since we weigh no vote above another. Discord votes are
 * counted but never listed: a community's Discord identities are not CRCON's game names.
 * `last_reminder` and `player_choice` are null: we keep neither.
 */
export interface VoteStatusInput {
  enabled: boolean;
  paused: boolean;
  /** Poll options in order, with counts index-aligned (our state stores them that way). */
  options: { id: string; name: string }[];
  tallies: number[];
  /** A staff override wins over the tally — it is what will actually be played. */
  overrideMapId: string | null;
  /** The map in play: the vote's own round, which cannot be its result (that replays it). */
  inPlayMapId?: string | null;
  /** The in-game ballot's voters per option as the worker last read them, tagged with the vote
   *  they were read for (MapVoteStateRow.ingameVoters). */
  ingameVoters?: { messageId: string; voters: { name: string; playerId: string | null }[][] } | null;
  /** The vote that is up (MapVoteStateRow.activeMessageId): voters read for any other are not its. */
  activeMessageId?: string | null;
  /** The server publishes player ids (its "Publish player ids" switch); off, every id is null. */
  publishIds?: boolean;
  game: string;
}

export function buildVoteStatus(i: VoteStatusInput): Record<string, unknown> {
  if (!i.enabled) {
    return { enabled: false, paused: false, results: [], last_reminder: null, next_map: null, player_choice: null };
  }
  const counts = i.options.map((_, idx) => (Number.isFinite(i.tallies[idx]) ? i.tallies[idx]! : 0));
  // Only the voters read for the vote that is up: a list left from the last ballot answered a
  // different question.
  const voters = i.ingameVoters && i.activeMessageId && i.ingameVoters.messageId === i.activeMessageId ? i.ingameVoters.voters : [];
  const results = i.options.map((o, idx) => ({
    // VoteMapVoter's keys, in CRCON's order.
    voters: (voters[idx] ?? []).map((v) => ({ player_id: i.publishIds ? v.playerId : null, player_name: v.name, count: 1 })),
    map: crconLayer(o.id, i.game, true),
    votes_count: counts[idx],
  }));
  // What the vote puts next: a staff override, else what the round's end would apply now. This
  // read null for a tie or a poll nobody had voted in, where CRCON names its default pick.
  const nextMap: string | null = i.overrideMapId
    || resolveVoteWinner(i.options, counts, { exclude: i.inPlayMapId ?? null })?.option.id
    || null;
  return {
    enabled: true,
    paused: i.paused,
    results,
    last_reminder: null,
    next_map: nextMap ? String(crconLayer(nextMap, i.game, true).pretty_name) : null,
    player_choice: null,
  };
}

/**
 * CRCON's layer-id grammar, which is the same for both games.
 *
 *   `<name>_(off[ensive]_<attackers> | <mode>[_V2])[_<environment>]`
 *
 * Copied from `rcon/maps.py`. Vietnam reuses it unchanged — only the vocabulary inside the slots
 * differs — so parsing structurally is the part we can be sure of even while CRCON's Vietnam
 * catalogue is still filling in.
 */
const LAYER_ID = /^(?<name>[a-zA-Z0-9]+)_(?:(?<offensive>off(?:ensive)?)_?(?<attackers>[a-zA-Z]+)|(?<mode>[a-zA-Z]+)(?:_V2)?)(?:_(?<environment>[a-zA-Z]+))?$/;

/**
 * Which side a map id's attacker token belongs to.
 *
 * Verbatim from CRCON's `parse_map_string_attacker`, including that Vietnam's tokens fold into the
 * SAME allies/axis vocabulary rather than a south/north one — CRCON decided that deliberately
 * (`Team.from_hllrcon` maps the game's stable side ids 1→allies, 2→axis for both games), so a tool
 * reading `attackers` gets one answer set whichever game it is pointed at.
 */
export const ATTACKER_SIDE: Record<string, "allies" | "axis"> = {
  // Vietnam
  nva: "axis", us: "allies", usa: "allies",
  // WW2 — the same table CRCON's faction list carries
  ger: "axis", dak: "axis", rus: "allies", sov: "allies", cw: "allies", gb: "allies", b8a: "allies", can: "allies",
};

/**
 * The two factions a game's layers can field, in CRCON's `Faction` shape (`short_name.lower()`
 * plus the side it plays).
 *
 * Vietnam fields the same two factions in every round, so they can be stated once here. WW2 cannot
 * be: its armies depend on the map, which is why `CRCON_MAPS` carries them per map and is consulted
 * first. This table is the fallback for a game with no catalogue row of its own.
 */
const GAME_FACTIONS: Record<string, { allies: string; axis: string }> = {
  hllv: { allies: "us", axis: "nva" },
};

/**
 * CRCON's `LayerType` for one raw map id, for the game the server actually runs.
 *
 * `describeMap` reads the id's grammar rather than a WW2 map list, so it is safe on Vietnam ids
 * too: `huecity_offensive_nva` comes back offensive/huecity/day, correctly. Its display-name table
 * has no Vietnam entries, so `huecity` would infer as "Huecity" — but that is what `overrides` is
 * for: the `map_names` store staff already edit from the Maps screen, applied here so the public
 * API says whatever the panel says. Nothing about Vietnam names has to be guessed in code.
 *
 * The remaining Vietnam shortfall is upstream of this function: the protocol REPORTS `GameMode`
 * and `TimeOfDay` per map entry (docs/hll-vietnam.md §"Map entry"), and we still infer them from
 * the id because `parseMapCatalogue` keeps only the id. Preferring the reported fields is step 4
 * of that document's plan and is not done.
 */
export function buildLayer(mapId: string, game: string, overrides?: Map<string, { displayName: string | null; family: string | null }>): unknown {
  const pretty = (id: string) => {
    const inferred = describeMap(id);
    const o = overrides?.get(id);
    // Staff-set names win, exactly as they do on every panel screen. This is the same `map_names`
    // store the Maps editor writes, so a community that has already named its maps sees those
    // names in the public API too instead of the raw inference.
    return o ? { ...inferred, prettyName: o.displayName ?? inferred.prettyName, family: o.family ?? inferred.family } : inferred;
  };
  const id = String(mapId ?? "");
  if (!id) return null;
  const m = LAYER_ID.exec(id)?.groups ?? {};
  const derived = pretty(id);
  const family = derived?.family || m.name || id;
  // CRCON's own catalogue row for this map, when it has one (WW2 — see crcon-maps.ts). It supplies
  // the four facts no id can be parsed into, and the per-map armies, which is what makes the WW2
  // faction names correct rather than absent: Driel fields B8A, the desert maps field DAK.
  const facts = CRCON_MAPS[family];
  const factions = GAME_FACTIONS[game];
  const allies = facts?.allies ?? factions?.allies ?? "";
  const axis = facts?.axis ?? factions?.axis ?? "";
  // The attacker token only means something on an offensive layer; `null` elsewhere, as CRCON does.
  const attackers = m.offensive && m.attackers ? ATTACKER_SIDE[m.attackers.toLowerCase()] ?? null : null;
  return {
    id,
    map: {
      id: family,
      // CRCON carries the shouted catalogue name here and the readable one in `pretty_name`; with
      // no row (Vietnam) both fall back to what we can derive, which is what it did before.
      name: facts?.name ?? family,
      tag: facts?.tag ?? "",
      pretty_name: derived?.prettyName ?? facts?.prettyName ?? family,
      shortname: facts?.shortname ?? "",
      allies: { name: allies, team: "allies" },
      axis: { name: axis, team: "axis" },
      // Only ever a real value or CRCON's empty string — never a guessed default, since a wrong
      // orientation silently mirrors a tactical map.
      orientation: facts?.orientation ?? "",
    },
    game_mode: derived?.mode ?? (m.offensive ? "offensive" : (m.mode ?? "").toLowerCase()),
    attackers,
    environment: derived?.environment ?? (m.environment ?? "day").toLowerCase(),
    pretty_name: derived?.prettyName ?? family,
    image_name: `${id}.webp`,
    image_url: null,
  };
}

/**
 * A map id as CRCON's API writes it: the Layer CRCON's own catalogue and parser make of it
 * (@app/maps crcon-layers.ts), dumped key for key. `orUnknown` is the live game state's
 * parse_layer_or_unknown; without it an id of no recognisable shape throws, as parse_layer does.
 * This, not buildLayer, is what every CRCON endpoint says: buildLayer is our own pages' reading,
 * with the names staff set on the Maps screen, and CRCON has no such names.
 */
export function crconLayer(mapId: string, game: string, orUnknown = false): Record<string, unknown> {
  return crconLayerDump(orUnknown ? crconParseLayerOrUnknown(mapId, game) : crconParseLayer(mapId, game));
}

/**
 * The layer id CRCON files a round under: its `map_name`, the name in its map history, and what
 * the round's `map` object is parsed from. The worker records CRCON's own decision as each round
 * starts (apps/workers/src/round-start.ts); a round from before that, or imported from CRCON, is
 * read from what it stores (@app/maps crconMapNameFromRecord).
 */
export function crconMapName(m: { map: string | null; crconMap?: string | null }, game: string): string {
  return m.crconMap ?? crconMapNameFromRecord(m.map, game);
}

/**
 * One entry of CRCON's map history: its MapInfo as `get_map_history` publishes it, which is every
 * key save_new_map wrote but `player_stats`, in that order (rcon/utils.py, v12.3.0). Times are epoch
 * seconds, as CRCON stores them; it formats only under `?pretty` and in `get_previous_map`.
 */
export interface MapHistoryEntry {
  name: string;
  start: number | null;
  end: number | null;
  guessed: boolean;
  gameLayout: { requested: string[]; set: string[] };
  /** [ts, allied, axis]; empty on every entry but the newest (see mapHistoryEntries). */
  capFlips: [number, number, number][];
  moraleHistory: [number, number, number][];
  initialMorale: number | null;
  matchTime: number;
}

/** The parts of a stored round a map-history entry is made from (a MatchRow carries all of it). */
export interface MapHistoryRound {
  map: string | null;
  crconMap?: string | null;
  game?: string | null;
  startedAt: string;
  endedAt: string | null;
  crconGuessed?: boolean | null;
  crconEndDeferred?: boolean | null;
  crconInitialMorale?: number | null;
  sectorLayout: string[] | null;
  capFlips: [number, number, number][];
  moraleHistory: [number, number, number][];
  matchTime: number;
}

const epochSec = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/**
 * A round's `game_layout`: the objectives requested for it and the ones set. Ours are the five
 * staff chose, which is what CRCON writes for a layout chosen by name (requested and set alike).
 */
export function crconGameLayout(sectorLayout: string[] | null): { requested: string[]; set: string[] } {
  return { requested: sectorLayout ?? [], set: sectorLayout ?? [] };
}

/**
 * CRCON's map history from our rounds, newest first (`rounds` as matches.list gives them).
 *
 *   - `end` is the MATCH ENDED time unless CRCON would have left it to the next MATCH START
 *     (MatchRow.crconEndDeferred): then it is the next round's start, or null while there is none.
 *   - `cap_flips` and `morale_history` are emptied on every entry but the newest: CRCON's stats
 *     job clears them from the history once it has filed the round's scoreboard, which it does as
 *     the next round starts (clear_stats_cache, rcon/workers.py).
 *   - `guessed` is true for a round with no recorded decision, as CRCON's is for a round it could
 *     only read from the log.
 */
export function mapHistoryEntries(rounds: MapHistoryRound[], serverGame: string): MapHistoryEntry[] {
  return rounds.map((m, i) => {
    const newer = i > 0 ? rounds[i - 1]! : null;
    return {
      name: crconMapName(m, m.game ?? serverGame),
      start: epochSec(m.startedAt),
      end: m.crconEndDeferred === true ? (newer ? epochSec(newer.startedAt) : null) : epochSec(m.endedAt),
      guessed: m.crconGuessed ?? true,
      gameLayout: crconGameLayout(m.sectorLayout),
      capFlips: i === 0 ? m.capFlips : [],
      moraleHistory: i === 0 ? m.moraleHistory : [],
      initialMorale: m.crconInitialMorale ?? null,
      matchTime: m.matchTime,
    };
  });
}

/**
 * An epoch second as Python's `datetime.fromtimestamp(ts, tz=UTC).isoformat()` writes it.
 *
 * The instant was never in question; the SPELLING was. JavaScript's `toISOString()` gives
 * `2026-08-21T20:00:00.000Z` and Python gives `2026-08-21T20:00:00+00:00` — same moment, and not
 * the same bytes, which is the whole of the contract on this surface. Python omits the fractional
 * part when it is zero, and our epochs are whole seconds, so it never appears.
 *
 * CRCON only reached this spelling in v12.1.1: before that it formatted with a NAIVE
 * `fromtimestamp()`, which renders in whatever zone the container happens to run in and carries
 * no offset at all. We were already publishing the correct instant, so this is the one direction
 * an upstream fix can go — theirs moved to meet ours, and only the punctuation was left.
 */
function pythonIsoUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** CRCON's `x if x else None` around the ISO spelling: a falsy time is null. */
const isoOrNull = (epochSeconds: number | null): string | null => (epochSeconds ? pythonIsoUtc(epochSeconds) : null);

/**
 * `get_map_history`: the entries whole, or under `?pretty` just name, start and end in ISO, as
 * CRCON's view writes them (rconweb/api/scoreboards.py).
 */
export function buildMapHistory(entries: MapHistoryEntry[], pretty: boolean): unknown[] {
  if (pretty) return entries.map((e) => ({ name: e.name, start: isoOrNull(e.start), end: isoOrNull(e.end) }));
  return entries.map((e) => ({
    name: e.name,
    start: e.start,
    end: e.end,
    guessed: e.guessed,
    game_layout: { requested: e.gameLayout.requested, set: e.gameLayout.set },
    cap_flips: e.capFlips.map(capFlipOut),
    morale_history: e.moraleHistory.map(moraleOut),
    initial_morale: e.initialMorale,
    match_time: e.matchTime,
  }));
}

/**
 * `get_previous_map` — index 1 of the map history (0 being the round in progress).
 *
 * CRCON catches the IndexError and answers `result: null, failed: false`: "no previous map" is a
 * fact, not a failure, and a tool that treats it as an error would show a broken overlay on the
 * first round after a restart.
 */
export function buildPreviousMap(entries: MapHistoryEntry[]): unknown {
  const prev = entries[1];
  if (!prev) return null;
  return { name: prev.name, start: isoOrNull(prev.start), end: isoOrNull(prev.end) };
}

// ---------------------------------------------------------------------------
// Scoreboards — the four endpoints that publish per-player rows.
//
// The shapes here are CRCON's own, read from the captured response types
// (docs/crcon-api/response-types.md): `PlayerStatsType` for a player's line,
// `CachedLiveGameStats` for the two live endpoints' wrapper, `MapsType` for a
// past round. docs/public-stats.md records the field-by-field mapping and every
// place our answer deliberately differs (mostly: an honest null where CRCON
// computes something we do not record).
// ---------------------------------------------------------------------------

/** One kill/teamkill/vote event as the fold needs it — a structural subset of EvtRow. */
export interface KillEventLike {
  ts: string;
  kind: string;
  actorPlayerId: string | null;
  actorName: string | null;
  victimPlayerId: string | null;
  victimName: string | null;
  weapon: string | null;
  /** Vote events carry their raw VOTESYS text here; kills do not use it. */
  data?: Record<string, unknown> | null;
}

/** What one round of kill events says about one player (keyed by INTERNAL player id). */
export interface KillWindowLine {
  /** Kills by weapon. A team kill is not a kill: it shows on the timeline, marked, and not here. */
  weapons: Record<string, number>;
  deathByWeapons: Record<string, number>;
  /** CRCON keys nemeses by display NAME, not id — its tools render the dict keys directly. */
  mostKilled: Record<string, number>;
  deathBy: Record<string, number>;
  deathsByTk: number;
  killsStreak: number;
  teamkillsStreak: number;
  deathsWithoutKillStreak: number;
  deathsByTkStreak: number;
  /** Seconds of the player's longest / shortest life in the round; null until their first death. */
  longestLifeSecs: number | null;
  shortestLifeSecs: number | null;
  /** Seconds since match start of the player's last respawn — i.e. their last death. */
  lastSpawnSecs: number | null;
  /** Every kill and death in order, team kills included (marked): the round report's timeline
   *  shows them all. */
  encounters: { action: "kill" | "death"; player_id: string | null; player_name: string | null; ts: number; weapon: string | null; teamkill: boolean }[];
}

/**
 * Fold a round's kill stream into per-player weapons, nemeses, streaks and encounters, for the
 * round report on our own public page (match-report.ts). The CRCON endpoints do not read it: they
 * run CRCON's own statistics over the log (crcon-stats.ts).
 *
 * A life is measured death to death from the first moment the round saw the player, and the life
 * still running when the round ends is not counted. The shortest life is the true minimum — this
 * page's own reading, not CRCON's (whose is always 0 or below).
 *
 * Encounter `ts` is seconds since match start. `player_id` on an encounter is the INTERNAL id the
 * events carry; the report names players by display name and never publishes it.
 */
export function foldKillWindow(events: KillEventLike[], matchStartIso: string): Map<string, KillWindowLine> {
  const startMs = Date.parse(matchStartIso);
  const byPlayer = new Map<string, KillWindowLine>();
  const line = (id: string): KillWindowLine => {
    let l = byPlayer.get(id);
    if (!l) {
      l = { weapons: {}, deathByWeapons: {}, mostKilled: {}, deathBy: {}, deathsByTk: 0, killsStreak: 0, teamkillsStreak: 0, deathsWithoutKillStreak: 0, deathsByTkStreak: 0, longestLifeSecs: null, shortestLifeSecs: null, lastSpawnSecs: null, encounters: [] };
      byPlayer.set(id, l);
    }
    return l;
  };
  // Streak state per player, folded across the ORDERED stream — repo reads return newest first,
  // so sort ascending here rather than trusting every caller to remember.
  const run = new Map<string, { kills: number; tks: number; deaths: number; tkDeaths: number }>();
  // When each player's current life began, in seconds since match start. Seeded by the first event
  // that names them — a kill they got counts as much as one they took for "the round has seen you".
  const lifeStart = new Map<string, number>();
  const sawAt = (id: string, ts: number) => { if (!lifeStart.has(id)) lifeStart.set(id, ts); };
  const runOf = (id: string) => {
    let r = run.get(id);
    if (!r) { r = { kills: 0, tks: 0, deaths: 0, tkDeaths: 0 }; run.set(id, r); }
    return r;
  };
  // The tallies are keyed by weapon and player names, which are whatever players type: a victim
  // named "constructor" counts from zero, not from Object's own function, and one named
  // "__proto__" is a key like any other, not the object's prototype.
  const bump = (dict: Record<string, number>, key: string) => {
    Object.defineProperty(dict, key, { value: (Object.hasOwn(dict, key) ? dict[key]! : 0) + 1, enumerable: true, writable: true, configurable: true });
  };
  const ordered = [...events].sort((a, b) => a.ts.localeCompare(b.ts));

  for (const e of ordered) {
    if (e.kind !== "evt.kill" && e.kind !== "evt.teamkill") continue;
    const ts = Math.max(0, Math.round((Date.parse(e.ts) - startMs) / 1000));
    const weapon = e.weapon || null;
    if (e.actorPlayerId) {
      const l = line(e.actorPlayerId);
      const r = runOf(e.actorPlayerId);
      sawAt(e.actorPlayerId, ts);
      if (e.kind === "evt.kill") {
        if (weapon) bump(l.weapons, weapon);
        if (e.victimName) bump(l.mostKilled, e.victimName);
        r.kills += 1;
        l.killsStreak = Math.max(l.killsStreak, r.kills);
      } else {
        r.tks += 1;
        l.teamkillsStreak = Math.max(l.teamkillsStreak, r.tks);
      }
      // Any kill (own-team or not) ends a deaths-without-kill run.
      r.deaths = 0; r.tkDeaths = 0;
      l.encounters.push({ action: "kill", player_id: e.victimPlayerId, player_name: e.victimName, ts, weapon, teamkill: e.kind === "evt.teamkill" });
    }
    if (e.victimPlayerId) {
      const l = line(e.victimPlayerId);
      const r = runOf(e.victimPlayerId);
      sawAt(e.victimPlayerId, ts);
      // This death ends a life and starts the next one, exactly as CRCON's _process_death_time
      // does. Clamped at 0 because two events can share a second, and a negative life would be
      // nonsense rather than merely short.
      const began = lifeStart.get(e.victimPlayerId) ?? ts;
      const lived = Math.max(0, ts - began);
      l.longestLifeSecs = l.longestLifeSecs === null ? lived : Math.max(l.longestLifeSecs, lived);
      l.shortestLifeSecs = l.shortestLifeSecs === null ? lived : Math.min(l.shortestLifeSecs, lived);
      l.lastSpawnSecs = ts;
      lifeStart.set(e.victimPlayerId, ts);
      if (weapon) bump(l.deathByWeapons, weapon);
      if (e.actorName) bump(l.deathBy, e.actorName);
      r.deaths += 1;
      l.deathsWithoutKillStreak = Math.max(l.deathsWithoutKillStreak, r.deaths);
      r.kills = 0; r.tks = 0;
      if (e.kind === "evt.teamkill") {
        l.deathsByTk += 1;
        r.tkDeaths += 1;
        l.deathsByTkStreak = Math.max(l.deathsByTkStreak, r.tkDeaths);
      } else {
        r.tkDeaths = 0;
      }
      l.encounters.push({ action: "death", player_id: e.actorPlayerId, player_name: e.actorName, ts, weapon, teamkill: e.kind === "evt.teamkill" });
    }
  }
  return byPlayer;
}

/**
 * What a row shows where its server keeps ids private (the publicPlayerIds switch, off by
 * default): a scoreboard of names can be taken down, while ids that have been crawled and indexed
 * cannot be recalled. The id is null in the row and in every encounter, and the name carries the
 * identity. That IS a divergence from CRCON, whose scoreboards always publish the id; it is the
 * one the operator asked for, and null says "withheld" rather than inventing a stand-in.
 */
const HIDDEN: string | null = null;

/** A platform as CRCON's soldier record holds it: the game's own string, or null where we only
 *  have our own guess at it ("other", "unknown"). */
export const crconPlatform = (platform: string | null): string | null =>
  platform && platform !== "other" && platform !== "unknown" ? platform : null;

/**
 * One filed PlayerStats row as `get_map_scoreboard` sends it — PlayerStats.to_dict, key for key
 * (rcon/models.py, v12.3.0); the view appends `encounters`. A row is what CRCON's stats job filed
 * for the round (workers._build_player_stat_dict): the game log's half from TimeWindowStats over
 * the round (crcon-stats.ts), the cache's half from crconFiledTemp.
 *
 *   - The four dicts come back from jsonb columns, so their keys are in jsonb's order (length,
 *     then bytes), and kills_by_type / deaths_by_type walk the weapons in that order.
 *   - The rates are float columns, so they are floats however they were computed.
 *   - `team` is detect_team over the round's unit history (and its match_time), else its weapons.
 */
export function buildFiledPlayerStats(
  f: CrconPlayerFigures,
  temp: CrconFiledTemp,
  index: number,
  mapSeq: number,
  matchTime: number,
  ids: CrconIdPolicy,
): Record<string, unknown> {
  const weapons = jsonbOrdered(Object.fromEntries(f.weapons));
  const deathByWeapons = jsonbOrdered(Object.fromEntries(f.death_by_weapons));
  const rates = crconFiledRates(f);
  return {
    id: index,
    player_id: ids.publish ? f.player_id : HIDDEN,
    player: f.player,
    platform: f.platform,
    steaminfo: null,
    map_id: mapSeq,
    kills: f.kills,
    kills_by_type: crconWeaponTypeUsage(weapons),
    kills_streak: f.kills_streak,
    deaths: f.deaths,
    deaths_by_type: crconWeaponTypeUsage(deathByWeapons),
    deaths_without_kill_streak: f.deaths_without_kill_streak,
    teamkills: f.teamkills,
    teamkills_streak: f.teamkills_streak,
    deaths_by_tk: f.deaths_by_tk,
    deaths_by_tk_streak: f.deaths_by_tk_streak,
    nb_vote_started: f.nb_vote_started,
    nb_voted_yes: f.nb_voted_yes,
    nb_voted_no: f.nb_voted_no,
    time_seconds: f.time_seconds,
    kills_per_minute: rates.kpm,
    deaths_per_minute: rates.dpm,
    kill_death_ratio: rates.kdr,
    longest_life_secs: f.longest_life_secs,
    shortest_life_secs: f.shortest_life_secs,
    combat: temp.combat,
    offense: temp.offense,
    defense: temp.defense,
    support: temp.support,
    vehicle_kills: temp.vehicle_kills,
    vehicles_destroyed: temp.vehicles_destroyed,
    most_killed: jsonbOrdered(Object.fromEntries(crconNemeses(f.most_killed, ids))),
    death_by: jsonbOrdered(Object.fromEntries(crconNemeses(f.death_by, ids))),
    weapons,
    death_by_weapons: deathByWeapons,
    team: crconDetectTeam(temp.units, matchTime, weapons, deathByWeapons),
    level: temp.level,
    kills_and_assists: temp.kills_and_assists,
    deaths_and_redeploys: temp.deaths_and_redeploys,
    units: temp.units,
  };
}


/**
 * A round as CRCON's scoreboard endpoints read it — a row of its Maps table (a CrconRoundRow
 * carries all of it). CRCON files a round's scoreboard as the NEXT round starts; `nextStart` is
 * that round's start, null only for an imported round with nothing after it.
 */
export interface StoredRoundLike extends MapHistoryRound {
  seq: number;
  alliedScore: number | null;
  axisScore: number | null;
  /** The MATCH ENDED line's text for a round we recorded; the import's summary for an imported one. */
  result: string | null;
  short?: boolean;
  settledAt?: string | null;
}

/**
 * A round that came from CRCON's own archive: CRCON had filed its scoreboard already. Our live
 * ingest settles every round it records and the worker files it; an import does neither.
 */
export function crconIsImported(m: { short?: boolean; crconMap?: string | null; settledAt?: string | null }): boolean {
  return !m.short && !m.crconMap && !m.settledAt;
}

/** TimeWindowStats.match_end_result_regex, used with .match on the MATCH ENDED log's message. */
const MATCH_END_RESULT = new RegExp("^MATCH ENDED `[^\\n]+` ALLIED \\((\\p{Nd}) - (\\p{Nd})\\) AXIS", "u");

/**
 * Maps.result as to_dict writes it: `{axis, allied}`, axis first. CRCON reads the score off the
 * round's MATCH ENDED line (TimeWindowStats.map_result) and files 2 - 2 for a round that never had
 * one — superseded by the next start, say. An imported round carries the result CRCON itself
 * filed (its scores, or the import's "ALLIED (2 - 3)"), null where CRCON had none.
 */
export function crconMapResult(m: StoredRoundLike): { axis: number; allied: number } | null {
  if (crconIsImported(m)) {
    if (m.alliedScore !== null && m.axisScore !== null) return { axis: m.axisScore, allied: m.alliedScore };
    const fromText = /\((\d+) - (\d+)\)/.exec(m.result ?? "");
    return fromText ? { axis: Number(fromText[2]), allied: Number(fromText[1]) } : null;
  }
  const line = m.result === null ? null : MATCH_END_RESULT.exec(`MATCH ENDED ${m.result}`);
  if (!line) return { axis: 2, allied: 2 };
  return { axis: pyInt(line[2]!) ?? 0, allied: pyInt(line[1]!) ?? 0 };
}

/**
 * A round's Maps row as `get_map_scoreboard` sends it: to_dict(with_stats=True), key for key,
 * then the `map` the view appends (parse_recorded_layer of the filed id).
 *
 *   - start and end are aware datetimes ("+00:00"); `end` is the round's MATCH ENDED time unless
 *     CRCON left it to the next start (MatchRow.crconEndDeferred).
 *   - creation_time is the naive moment CRCON's stats job wrote the row, as the next round
 *     started: that start stands for it (an imported round's own end, where nothing followed).
 *   - cap_flips is the whole timeline. CRCON's job clamps the last flip to the round's length in
 *     memory, but the column is plain JSON and the change is never written, so the stored
 *     timeline is unclamped — and that is what this endpoint reads back.
 */
export function buildScoreboardMap(
  m: StoredRoundLike,
  nextStart: string | null,
  game: string,
  serverNumber: number | null,
  playerStats: unknown[],
): Record<string, unknown> {
  const mapName = crconMapName(m, game);
  const end = (m.crconEndDeferred === true || !m.endedAt ? nextStart : m.endedAt) ?? m.endedAt ?? m.startedAt;
  return {
    id: m.seq,
    creation_time: pyDateNaive(Date.parse(nextStart ?? end)),
    start: pyDateUtc(Date.parse(m.startedAt)),
    end: pyDateUtc(Date.parse(end)),
    server_number: serverNumber,
    map_name: mapName,
    result: crconMapResult(m),
    game_layout: crconGameLayout(m.sectorLayout),
    cap_flips: m.capFlips.map(capFlipOut),
    morale_history: m.moraleHistory.map(moraleOut),
    initial_morale: m.crconInitialMorale ?? null,
    match_time: m.matchTime,
    player_stats: playerStats,
    map: crconLayer(mapName, game),
  };
}

/**
 * One row of `get_scoreboard_maps`. CRCON writes these out by hand (scoreboards.py), eight keys in
 * this order, not the whole record: player_stats is the record's list without the stats loaded,
 * so always [].
 */
export function buildScoreboardListRow(
  m: StoredRoundLike,
  nextStart: string | null,
  game: string,
  serverNumber: number | null,
): Record<string, unknown> {
  const r = buildScoreboardMap(m, nextStart, game, serverNumber, []);
  return {
    map: r.map, id: r.id, creation_time: r.creation_time, start: r.start, end: r.end,
    server_number: r.server_number, player_stats: r.player_stats, result: r.result,
  };
}

/** `get_scoreboard_maps` — the paged past-rounds list. */
export function buildScoreboardMaps(maps: unknown[], page: number | bigint, pageSize: number, total: number): Record<string, unknown> {
  return { page, page_size: pageSize, total, maps };
}

/**
 * Per-IP, per-endpoint sliding window. CRCON v12.3.0's views carry no limit at all (earlier
 * releases had `@ratelimit(key='ip', rate='60/m')`), so ours sits far past any tool's polling pace:
 * a working tool never meets it. In memory and unshared: the point is to stop one misconfigured
 * overlay polling in a loop from reaching the game server, not to survive a distributed attack.
 */
export class PublicRateLimiter {
  private hits = new Map<string, number[]>();
  /** Bounded so an address-spraying caller cannot grow this without limit. */
  private static MAX_KEYS = 20_000;
  /** Written out rather than a constructor parameter property: this module is imported straight
   *  from source by the tests, and Node's type stripping cannot rewrite `constructor(private x)`. */
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** true when the call is allowed; records it. */
  allow(endpoint: string, addr: string, perMinute: number): boolean {
    const t = this.now();
    const key = `${endpoint}|${addr}`;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > t - 60_000);
    if (recent.length >= perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    // The cap fails CLOSED, exactly as the login throttle does and for the same reason: this is
    // the one surface an anonymous caller can reach, `clientAddrOf` believes forwarding headers,
    // and a caller not behind the proxy can mint a new address per request. If pruning aged-out
    // keys does not get the map back under the cap, an UNSEEN key is refused rather than stored —
    // adding it anyway would let that spray grow the map without bound, and 20k distinct
    // addresses inside one minute is an attack, not an audience.
    if (!this.hits.has(key) && this.hits.size >= PublicRateLimiter.MAX_KEYS) {
      this.prune(t);
      if (this.hits.size >= PublicRateLimiter.MAX_KEYS) return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (!v.some((ts) => ts > t - 60_000)) this.hits.delete(k);
  }
}
