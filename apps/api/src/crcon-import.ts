/**
 * Pure mappers from an existing CRCON instance's API responses into our import shapes. Kept separate
 * from the route so they're unit-testable with fixture JSON (we can't reach a real CRCON in tests).
 * Field extraction is deliberately defensive — CRCON's exact keys drift a little across versions, so
 * each value tries a few known aliases before giving up.
 */
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** First non-empty value among the given keys. */
function pick(o: unknown, ...keys: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Pull the record array out of a CRCON payload: a bare array, or `{ <key>: [...] }`. */
function rowsOf(result: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object") {
    for (const k of keys) {
      const v = (result as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/** Normalize a CRCON expiry into an ISO string, or null for permanent/absent/unparseable. */
export function normExpiry(v: unknown): string | null {
  const s = str(v);
  if (!s || /^(never|permanent|none|null)$/i.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** CRCON records sometimes nest the player under `player`; check there too. */
const nested = (r: unknown) => (r && typeof r === "object" ? (r as Record<string, unknown>).player : undefined);
/**
 * True when a string looks like a game-issued player id: a long decimal (Steam64 / XUID) or a long
 * hex id (Windows / Epic / console). The game player id is the ONE determining key for a person —
 * but CRCON rows also carry CRCON's own little database ids in plain `id` fields, and accepting one
 * of those would mint a phantom profile that looks like a duplicate person. Anything that doesn't
 * look game-issued is rejected, so a row without a real player id maps to nothing rather than to
 * a wrong somebody.
 */
export const looksLikeGamePlayerId = (v: string): boolean => /^\d{16,19}$/.test(v) || /^[0-9a-fA-F]{16,64}$/.test(v);
const playerIdOf = (r: unknown): string => {
  for (const o of [r, nested(r)]) {
    if (!o) continue;
    // Fields that explicitly claim to be the player id are trusted as-is.
    const explicit = str(pick(o, "player_id", "steam_id_64", "steam_id", "steamId", "playerId"));
    if (explicit) return explicit;
    // A bare `id` is ambiguous — CRCON puts its own database ids there — so it only counts when it
    // actually looks like a game-issued id.
    const bare = str(pick(o, "id"));
    if (bare && looksLikeGamePlayerId(bare)) return bare;
  }
  return "";
};
const nameOf = (r: unknown) => { const n = pick(r, "name", "player_name", "playerName", "current_name") ?? pick(nested(r), "name", "player_name", "current_name"); return n ? str(n) : null; };

/** Platform guess from an id (17-digit = Steam64), matching the ingest pipeline. */
export const inferPlatform = (id: string): string => (/^\d{17}$/.test(id) ? "steam" : "other");

export interface ImportedVip { playerId: string; playerName: string | null; expiration: string | null }
export function mapVips(result: unknown): ImportedVip[] {
  const out: ImportedVip[] = [];
  for (const r of rowsOf(result, "vips", "vip_ids", "result")) {
    const playerId = playerIdOf(r);
    if (!playerId) continue;
    out.push({ playerId, playerName: nameOf(r), expiration: normExpiry(pick(r, "vip_expiration", "expiration", "expires_at", "expiration_date", "expires")) });
  }
  return out;
}

/** Timestamps in CRCON payloads drift between ISO-with-zone, naive-UTC ISO, and unix seconds.
 *  Normalize to a real ISO instant, or null when unparsable. Naive strings are treated as UTC —
 *  CRCON stores UTC — rather than letting Date guess the host zone. */
export function crconTime(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const raw = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return crconTime(Number(raw));
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(raw);
  const t = Date.parse(hasZone ? raw : `${raw}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** `author` is who placed the ban/record on CRCON (its `admin_name`), so the import keeps the
 *  original moderator rather than attributing everything to whoever ran the import. */
export interface ImportedBan { playerId: string; playerName: string | null; reason: string; expiresAt: string | null; author: string | null; at: string | null }
/** When the ban/record was PLACED on CRCON — the moderation moment, never the import moment.
 *  Key names drift across CRCON versions and between vanilla-ban parses and blacklist rows. */
const placedAt = (r: unknown): string | null => crconTime(pick(r, "ban_time", "banned_at", "created_at", "created", "creation_time", "timestamp", "date"));
/** The CRCON admin/tool that created the record (`admin_name`, with a few aliases). */
const authorOf = (r: unknown): string | null => { const a = pick(r, "admin_name", "by", "banned_by", "created_by", "author"); return a ? str(a) : null; };
export function mapBans(result: unknown): ImportedBan[] {
  const out: ImportedBan[] = [];
  for (const r of rowsOf(result, "bans", "records", "result")) {
    const playerId = playerIdOf(r);
    if (!playerId) continue;
    const type = str(pick(r, "type", "ban_type")).toLowerCase();
    // Perma bans never expire; temp bans carry an expiry (various key names).
    const expiresAt = type.startsWith("perma") ? null : normExpiry(pick(r, "expires_at", "expiration", "until", "ban_expiration"));
    out.push({ playerId, playerName: nameOf(r), reason: str(pick(r, "reason", "ban_reason")) || "Imported from CRCON", expiresAt, author: authorOf(r), at: placedAt(r) });
  }
  return out;
}

/** CRCON blacklist metadata (get_blacklists → list[BlacklistType]). */
export interface ImportedBlacklist { id: string; name: string }
export function mapBlacklists(result: unknown): ImportedBlacklist[] {
  const out: ImportedBlacklist[] = [];
  for (const r of rowsOf(result, "blacklists", "result")) {
    const id = str(pick(r, "id", "blacklist_id"));
    const name = str(pick(r, "name")) || `blacklist ${id}`;
    if (id) out.push({ id, name });
  }
  return out;
}

/** One page of CRCON blacklist records (get_blacklist_records). Reuses the ban shape. */
export function mapBlacklistRecords(result: unknown): ImportedBan[] {
  // records may be a bare array, `{ records: [...] }`, or `{ result: { records: [...] } }`
  const inner = result && typeof result === "object" && "result" in (result as Record<string, unknown>)
    ? (result as Record<string, unknown>).result : result;
  const out: ImportedBan[] = [];
  for (const r of rowsOf(inner, "records", "result")) {
    const playerId = playerIdOf(r);
    if (!playerId) continue;
    out.push({ playerId, playerName: nameOf(r), reason: str(pick(r, "reason")) || "Imported from CRCON", expiresAt: normExpiry(pick(r, "expires_at", "expiration")), author: authorOf(r), at: placedAt(r) });
  }
  return out;
}

/**
 * Watch provenance out of a CRCON row: reason, author and (when CRCON kept one) the timestamp.
 * CRCON's WatchList lives either as the row itself (archive `watchlist` records) or nested under
 * `watchlist` on a profile; `watched` is null when the row says nothing either way.
 */
export interface WatchInfo { watched: boolean | null; reason: string | null; by: string | null; at: string | null }
export function watchInfoOf(raw: unknown): WatchInfo {
  // Prefer the nested watchlist object when present; CRCON also ships it as a bare boolean.
  const nestedWatch = pick(raw, "watchlist", "watch_list");
  const o = nestedWatch && typeof nestedWatch === "object" ? nestedWatch : raw;
  const flag = pick(o, "is_watched", "watched") ?? (typeof nestedWatch === "boolean" ? nestedWatch : undefined);
  // CRCON stores UTC but often serializes without a zone — a naive string is UTC, not host-local.
  const at = str(pick(o, "modified", "created", "creation_time", "timestamp"));
  const t = at ? Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(at) ? at : `${at}Z`) : NaN;
  return {
    watched: typeof flag === "boolean" ? flag : nestedWatch && typeof nestedWatch === "object" ? true : null,
    reason: str(pick(o, "reason", "comment")) || null,
    by: str(pick(o, "by", "author", "added_by")) || null,
    at: Number.isFinite(t) ? new Date(t).toISOString() : null,
  };
}

