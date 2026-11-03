/**
 * The rules both stores share for what the removed objective presets ("Map points") left behind —
 * the leftover pending rows (see the Repository's mapPointPending) — kept in one place so the
 * memory store and Postgres cannot drift in how they read one.
 */
import type { MapPointPick } from "./types.js";

/**
 * Picks as stored: `{ idx, name }` and nothing else, with "" read as no name. A pick that is not a
 * readable object — or has no usable index — reads as Random.
 */
export function mapPointPicksOf(raw: unknown): (MapPointPick | null)[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p): MapPointPick | null => {
    if (!p || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    if (typeof r.idx !== "number" || !Number.isFinite(r.idx)) return null;
    return { idx: r.idx, name: typeof r.name === "string" && r.name !== "" ? r.name : null };
  });
}

/** A stored index list (Vietnam's five sector indices) or null. Validating the five is the
 *  consumer's job — the put-back checks the one entry it is about to act on. */
export function indicesOf(raw: unknown): number[] | null {
  return Array.isArray(raw) ? raw.map((n) => Number(n)) : null;
}

/** Plain code-unit order — what Postgres's `COLLATE "C"` sorts by, so both stores list alike
 *  whatever the database's locale makes of the characters in a key. */
export function codeOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
