/**
 * binary-v2 response shapes — the JSON `GetServerInformation` / `Get*Bans` return, confirmed from
 * live captures on a running server (schemas only; no live values live here). These typings let
 * the rest of the system consume v2 reads structurally instead of poking at `unknown`.
 *
 * Field-name quirks are the server's, kept verbatim: `iD` (player id), `cOMBAT` (score bucket),
 * `mAPS` (rotation list). Team encoding matches the session factions — `team: 0` is the axis side,
 * `team: 3` the allied side (session reports `axisFaction: 0`, `alliedFaction: 3`).
 *
 * The official 5.03 RCON client's own DTOs carry this exact field set, which is independent
 * corroboration — see `docs/rcon-503.md`. Where its C# property names and these wire keys
 * disagree on casing, the live capture (here) wins.
 */

export interface V2ScoreData {
  cOMBAT: number;
  offense: number;
  defense: number;
  support: number;
}

export interface V2PlayerStats {
  deaths: number;
  infantryKills: number;
  vehicleKills: number;
  teamKills: number;
  vehiclesDestroyed: number;
}

export interface V2PlayerInfo {
  name: string;
  clanTag: string;
  iD: string;
  platform: string;
  eosId: string;
  level: number;
  team: number;
  role: number;
  platoon: string;
  platoonIndex: number;
  loadout: string;
  scoreData: V2ScoreData;
  stats: V2PlayerStats;
  worldPosition: { x: number; y: number; z: number };
}

/** `GetServerInformation` with `{ Name: "players" }`. */
export interface V2PlayersResponse {
  players: V2PlayerInfo[];
}

/** `GetServerInformation` with `{ Name: "session" }`. */
export interface V2SessionInfo {
  serverName: string;
  mapName: string;
  mapId: string;
  gameMode: string;
  remainingMatchTime: number;
  matchTime: number;
  alliedFaction: number;
  axisFaction: number;
  alliedScore: number;
  axisScore: number;
  initialMorale: number;
  alliedMorale: number;
  axisMorale: number;
  playerCount: number;
  alliedPlayerCount: number;
  axisPlayerCount: number;
  maxPlayerCount: number;
  queueCount: number;
  maxQueueCount: number;
  vipQueueCount: number;
  maxVipQueueCount: number;
}

export interface V2MapEntry {
  name: string;
  gameMode: string;
  timeOfDay: string;
  iD: string;
  position: number;
}

/** `GetServerInformation` with `{ Name: "maprotation" }`. */
export interface V2MapRotation {
  currentIndex: number;
  mAPS: V2MapEntry[];
}

/** One entry of `GetTemporaryBans` / `GetPermanentBans` (`durationHours` is 0 for permabans). */
export interface V2BanEntry {
  userId: string;
  userName: string;
  timeOfBanning: string;
  durationHours: number;
  banReason: string;
  adminName: string;
}

export interface V2BanList {
  banList: V2BanEntry[];
}

/** Protocol-agnostic ban row the API/UI consume. */
export interface GameBan {
  playerId: string;
  playerName: string | null;
  ts: string | null;
  durationHours: number;
  reason: string;
  by: string | null;
  type: "temp" | "perma";
}

/** One entry of the `vipplayers` info request (`GetServerInformation`). Casing is speculative
 *  until a populated live capture exists — the parser below accepts every plausible spelling. */
export interface V2VipEntry {
  id?: string;
  iD?: string;
  Id?: string;
  ID?: string;
  comment?: string;
  Comment?: string;
}

/** Protocol-agnostic VIP row the reconciler consumes. */
export interface GameVip {
  playerId: string;
  comment: string | null;
}

/**
 * Normalize a `vipplayers` answer into `GameVip[]` — or `null` when the response is not a
 * structured VIP list at all.
 *
 * The null/empty distinction is the whole point, and it is the opposite trade from
 * `normalizeGameBans`. For bans, [] on an unreadable answer is safe because every consumer
 * degrades. The VIP reconciler CANNOT degrade that way: a server whose VIP list was wiped answers
 * a real, well-formed `{ vipPlayers: [] }`, and that empty list is exactly the incident the
 * reconciler exists to repair — ~40 recorded grants, none of them on the game. If "can't read" and
 * "genuinely empty" collapsed into one value, the reconciler would either re-grant against servers
 * it never actually read (legacy text answers raw strings) or ignore the wiped-list case entirely.
 *
 * So: the presence of the list KEY is the evidence. An object carrying `vipPlayers` (any casing)
 * answered the question, and its emptiness is a fact; anything else — raw text, an error string,
 * an unrelated object — is `null`, no evidence, and callers must not plan against it.
 */
export function normalizeGameVips(raw: unknown): GameVip[] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Live capture (2026-08-15) shows `vipPlayers`; the Vietnam PDF's own tables say `VipPlayers`.
  // Accept the spellings a v2 server could plausibly emit (it mangles acronym casing elsewhere).
  const list = o.vipPlayers ?? o.VipPlayers ?? o.vipplayers;
  if (!Array.isArray(list)) return null;
  return list
    .map((e) => {
      const v = (e ?? {}) as V2VipEntry;
      // First NON-EMPTY casing, not `??`: a build that answers an empty `iD` beside a real `id`
      // must not make this VIP vanish from the read — the enforcer's "already VIP on the game's
      // own list" guard and the reconciler both plan against exactly this list.
      const playerId = [v.iD, v.id, v.Id, v.ID].map((x) => String(x ?? "").trim()).find((x) => x) ?? "";
      const comment = v.comment ?? v.Comment;
      return { playerId, comment: comment != null && String(comment) !== "" ? String(comment) : null };
    })
    .filter((v) => v.playerId);
}

/**
 * Normalize a `{ banList: [...] }` v2 response into `GameBan[]`. Defensive: accepts the raw
 * `unknown` from the adapter and returns `[]` for any other shape (e.g. a legacy text response),
 * so callers don't have to branch on protocol.
 */
export function normalizeGameBans(raw: unknown, type: "temp" | "perma"): GameBan[] {
  const list = (raw as V2BanList | null)?.banList;
  if (!Array.isArray(list)) return [];
  return list.map((b) => ({
    playerId: String(b?.userId ?? ""),
    playerName: b?.userName ? String(b.userName) : null,
    ts: b?.timeOfBanning ? String(b.timeOfBanning) : null,
    durationHours: Number(b?.durationHours ?? 0),
    reason: String(b?.banReason ?? ""),
    by: b?.adminName ? String(b.adminName) : null,
    type,
  }));
}
