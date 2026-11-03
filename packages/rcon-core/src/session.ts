/**
 * One canonical shape for "the round right now", read from whichever protocol answered.
 *
 * The wire keys are not one thing. Binary v2 lowercases only the FIRST CHARACTER of the client's
 * C# property name, which is fine for `QueueCount` -> `queueCount` but turns every acronym into
 * something no one would guess: `ID` -> `iD`, `COMBAT` -> `cOMBAT`, `MAPS` -> `mAPS`, and so
 * `VIPQueueCount` -> `vIPQueueCount`. The CRCON bridge answers `get_gamestate`, which is
 * snake_case throughout (`queue_count`, `num_allied_players`). Readers that pick one spelling get
 * `undefined` from the others and quietly render it as zero — which is exactly how the VIP queue
 * came to always read 0, and how a bridge-backed server would report an empty match.
 *
 * So: accept every spelling seen in the wild, in one place, and let everything downstream read a
 * single shape. A field nobody supplied stays `undefined` rather than becoming 0 — "the server did
 * not say" and "the server said none" are different answers, and only one of them is safe to show.
 */

/** The round, as the rest of the app agrees to talk about it. */
export interface SessionInfo {
  serverName?: string;
  mapName?: string;
  /** the map's RAW id ("stmereeglise_offensive_us") — exact, unlike the printable name. */
  mapId?: string;
  gameMode?: string;
  matchTime?: number;
  remainingMatchTime?: number;
  alliedScore?: number;
  axisScore?: number;
  playerCount?: number;
  alliedPlayerCount?: number;
  axisPlayerCount?: number;
  maxPlayerCount?: number;
  /** players waiting in the general queue (not a capacity — see maxQueueCount). */
  queueCount?: number;
  /** the configured queue size. CRCON exposes the same number as `get_queue_length`. */
  maxQueueCount?: number;
  /**
   * The server's `vipQueueCount`, VERBATIM. Do not render this as a queue depth — read it through
   * `vipQueueDepth()`, which knows the field is not always what it is named. See that function.
   */
  vipQueueCount?: number;
  /** the configured VIP queue size — i.e. reserved slots, NOT people waiting. */
  maxVipQueueCount?: number;
  /**
   * Conquest's scoreline. Each side starts the round with `initialMorale` and holding ground
   * drains the enemy's pool; the round ends when one side's morale is gone. Every mode reports
   * the three fields — warfare/offensive rounds report 0s — so a POSITIVE `initialMorale` is
   * what says "this round is scored in morale", and consumers must key on that rather than on
   * the game mode string, which arrives in several spellings.
   */
  initialMorale?: number;
  alliedMorale?: number;
  axisMorale?: number;
}

/**
 * People waiting in the general queue, or `undefined` when the counter cannot be a queue: the same
 * test vipQueueDepth applies, within the queue's own declared size or, undeclared, the server's
 * capacity. That counter has never been seen misreporting, but it is now RECORDED with every
 * roster sample, and a stored number nobody can explain would sit in the history for good.
 */
export function queueDepth(s: SessionInfo): number | undefined {
  const n = s.queueCount;
  if (n == null || !Number.isInteger(n) || n < 0) return undefined;
  const cap = s.maxQueueCount ?? s.maxPlayerCount;
  if (cap != null && Number.isFinite(cap) && n > cap) return undefined;
  return n;
}

/**
 * People actually waiting in the VIP queue, or `undefined` when the server's counter cannot mean
 * that.
 *
 * Live capture from a 100-slot 5.0.3 server, mid-round:
 *
 *     "queueCount":6, "maxQueueCount":6, "vipQueueCount":742, "maxVipQueueCount":2
 *
 * 742 people cannot be waiting in a queue whose own maximum is 2, on a server that holds 100. The
 * field carries the size of the server's VIP LIST there, not a queue — the name is wrong at the
 * source. Rendering it verbatim put "742 VIP queue" on the match card.
 *
 * So the counter is believed only when it could be a queue: within the declared VIP queue maximum,
 * or — if the server didn't declare one — within the server's own capacity. Anything else is
 * reported as unknown, because showing a number we cannot explain is worse than showing none.
 */
export function vipQueueDepth(s: SessionInfo): number | undefined {
  const n = s.vipQueueCount;
  // A count of people: a fraction is no more a queue than 742 is.
  if (n == null || !Number.isInteger(n) || n < 0) return undefined;
  const cap = s.maxVipQueueCount ?? s.maxPlayerCount;
  if (cap != null && Number.isFinite(cap) && n > cap) return undefined;
  return n;
}

/** The first key that is actually present, so a real 0 is kept and a missing field stays missing. */
function pick(src: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function num(src: Record<string, unknown>, keys: string[]): number | undefined {
  const v = pick(src, keys);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function str(src: Record<string, unknown>, keys: string[]): string | undefined {
  const v = pick(src, keys);
  if (v === undefined) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

/**
 * Read a raw session/gamestate payload into `SessionInfo`.
 *
 * Each field lists every spelling observed: the binary-v2 key, its first-char-lowercased acronym
 * variant, the client's own PascalCase, and the CRCON bridge's snake_case.
 */
export function normalizeSession(raw: unknown): SessionInfo {
  if (!raw || typeof raw !== "object") return {};
  // Some transports wrap the payload; unwrap one level before reading.
  const outer = raw as Record<string, unknown>;
  const inner = ["result", "Result", "session", "Session", "data", "Data"]
    .map((k) => outer[k])
    .find((v) => v && typeof v === "object" && !Array.isArray(v)) as Record<string, unknown> | undefined;
  const s = inner ?? outer;

  return {
    serverName: str(s, ["serverName", "ServerName", "server_name", "name"]),
    mapName: str(s, ["mapName", "MapName", "map_name", "current_map"]),
    // The raw id is the exact key for artwork and rotation logic; the printable name is accented
    // free text that only matches by squashing ("SAINTE-MÈRE-ÉGLISE" vs stmereeglise_offensive_us).
    mapId: str(s, ["mapId", "MapId", "mapID", "map_id"]),
    gameMode: str(s, ["gameMode", "GameMode", "game_mode", "mode"]),
    matchTime: num(s, ["matchTime", "MatchTime", "match_time"]),
    remainingMatchTime: num(s, ["remainingMatchTime", "RemainingMatchTime", "remaining_match_time", "time_remaining"]),
    alliedScore: num(s, ["alliedScore", "AlliedScore", "allied_score"]),
    axisScore: num(s, ["axisScore", "AxisScore", "axis_score"]),
    playerCount: num(s, ["playerCount", "PlayerCount", "player_count", "num_players"]),
    alliedPlayerCount: num(s, ["alliedPlayerCount", "AlliedPlayerCount", "allied_player_count", "num_allied_players"]),
    axisPlayerCount: num(s, ["axisPlayerCount", "AxisPlayerCount", "axis_player_count", "num_axis_players"]),
    maxPlayerCount: num(s, ["maxPlayerCount", "MaxPlayerCount", "max_player_count", "max_players"]),
    queueCount: num(s, ["queueCount", "QueueCount", "queue_count"]),
    maxQueueCount: num(s, ["maxQueueCount", "MaxQueueCount", "max_queue_count"]),
    // The one that actually bit us: `VIPQueueCount` arrives as `vIPQueueCount`, never `vipQueueCount`.
    vipQueueCount: num(s, ["vIPQueueCount", "vipQueueCount", "VIPQueueCount", "vip_queue_count"]),
    maxVipQueueCount: num(s, ["maxVIPQueueCount", "maxVipQueueCount", "MaxVIPQueueCount", "max_vip_queue_count"]),
    initialMorale: num(s, ["initialMorale", "InitialMorale", "initial_morale"]),
    alliedMorale: num(s, ["alliedMorale", "AlliedMorale", "allied_morale"]),
    axisMorale: num(s, ["axisMorale", "AxisMorale", "axis_morale"]),
  };
}
