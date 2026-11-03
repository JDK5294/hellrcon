/**
 * Pure helpers for the slow CRCON backup pull. The runner (runner.ts) drives the network + storage;
 * this module owns the two bits worth unit-testing on their own: pulling the row array out of a
 * CRCON page, and deriving a stable dedupe key per record. Keeping the key logic here (not in the
 * runner) means we can prove dedupe behaviour without a live CRCON.
 */
export function str(v: unknown): string { return v == null ? "" : String(v); }

/** First non-empty value among the given keys of an object. */
export function pick(o: unknown, ...keys: string[]): unknown {
  if (!o || typeof o !== "object") return undefined;
  const r = o as Record<string, unknown>;
  for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && v !== "") return v; }
  return undefined;
}

/** Pull a record array out of a CRCON payload: a bare array, `{ result: [...] }`, or `{ <key>: [...] }`. */
export function rowsFrom(result: unknown, ...keys: string[]): Record<string, unknown>[] {
  const inner = result && typeof result === "object" && "result" in (result as Record<string, unknown>) && !Array.isArray(result)
    ? (result as Record<string, unknown>).result : result;
  if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  if (inner && typeof inner === "object") {
    for (const k of keys) { const v = (inner as Record<string, unknown>)[k]; if (Array.isArray(v)) return v as Record<string, unknown>[]; }
  }
  return [];
}

/** CRCON sometimes nests the player under `player`; look there too when reading an id. */
const nested = (r: unknown) => (r && typeof r === "object" ? (r as Record<string, unknown>).player : undefined);
export function playerIdOf(row: unknown): string {
  return str(pick(row, "player_id", "steam_id_64", "steam_id", "steamId", "id", "playerId") ?? pick(nested(row), "player_id", "steam_id_64", "steam_id", "id"));
}

/** Small stable string hash (djb2) — the dedupe key for records that carry no natural id
 *  (standard messages, some map-history rows). Content-addressed, so identical rows collapse. */
export function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** A stable dedupe key for a record within its data type. Player-keyed types use the player id;
 *  lists use their id; keyless types fall back to a content hash so re-pulls still collapse. */
export function entityKeyOf(dataType: string, row: unknown): string {
  const r = row as Record<string, unknown>;
  switch (dataType) {
    case "vip":
    case "ban":
    case "watchlist":
    case "player":
    case "player_detail":
    case "player_comment":
    case "player_message":
      return playerIdOf(r) || hashKey(JSON.stringify(row));
    case "blacklist":
      return str(pick(r, "id", "blacklist_id")) || hashKey(JSON.stringify(row));
    case "blacklist_record": {
      const id = str(pick(r, "id"));
      if (id) return id;
      // "blacklist:player" only when at least one half exists — the template alone is never falsy,
      // so without this check every record missing all three fields would collapse onto ":".
      const bl = str(pick(r, "blacklist_id"));
      const pid = playerIdOf(r);
      return bl || pid ? `${bl}:${pid}` : hashKey(JSON.stringify(row));
    }
    default:
      break;
  }
  // Historical log rows (every log_* data type) carry a DB id; rows without one collapse by
  // content, which also absorbs the inclusive-boundary refetch of the time-cursored pull.
  // Everything else keys the same way: its id when it has one, its content when not.
  return str(pick(r, "id")) || hashKey(JSON.stringify(row));
}
