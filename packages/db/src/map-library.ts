/**
 * Resolving a server's vote setup against the shared map-set library.
 *
 * A server stores PAIRINGS — this set, on that schedule — and everything downstream (the vote
 * engine, the coverage map, the panel's "which set is live right now") wants whole profiles. That
 * expansion happens once, here, and is called by both stores from `getConfig`/`listConfigs`, so no
 * caller can forget it and read raw pairings by mistake.
 *
 * Both halves resolve BY NAME, case-insensitively, because the name is what the pairing stores: an
 * id would make the stored config unreadable and a rename a data migration. The libraries enforce
 * unique names to keep that lookup unambiguous.
 */
import type { MapSetRow, MapVoteLink, VoteScheduleRow } from "./types.js";

/** Everything a resolution needs, read once per call rather than per pairing. */
export interface MapVoteLibrary {
  sets: MapSetRow[];
  schedules: VoteScheduleRow[];
}

/**
 * Read the stored `profiles` column as pairings.
 *
 * A row written before the library existed holds whole profiles; those are read as a pairing on the
 * set of the same name, which is exactly what the migration created for it. Anything without a
 * usable name is dropped rather than resolved to a nameless set, because a pairing that points
 * nowhere would silently widen the vote to the engine's defaults.
 */
export function toLinks(raw: unknown): MapVoteLink[] {
  if (!Array.isArray(raw)) return [];
  const out: MapVoteLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const mapSet = String(r.mapSet ?? r.name ?? "").trim();
    if (!mapSet) continue;
    const schedule = r.schedule == null ? null : String(r.schedule).trim() || null;
    out.push({ mapSet, schedule });
  }
  return out;
}

/**
 * Expand pairings into the `{ name, spec, pool }` profiles the engine takes.
 *
 * A pairing whose set has been deleted is dropped, not resolved to an empty pool: an empty pool
 * silently means "the engine's built-in defaults", so a deleted set would quietly start offering
 * the whole catalogue instead of showing up as a gap on the coverage map. A missing SCHEDULE is
 * different and is kept — no schedule means "all the time", which is a real answer.
 */
export function hydrateLinks(links: MapVoteLink[], library: MapVoteLibrary): Record<string, unknown>[] {
  const setByName = new Map(library.sets.map((s) => [s.name.toLowerCase(), s]));
  const schedByName = new Map(library.schedules.map((s) => [s.name.toLowerCase(), s]));
  const out: Record<string, unknown>[] = [];
  for (const link of links) {
    const set = setByName.get(link.mapSet.toLowerCase());
    if (!set) continue;
    const sched = link.schedule ? schedByName.get(link.schedule.toLowerCase()) : undefined;
    out.push({ name: set.name, spec: sched ? sched.spec : {}, pool: set.pool });
  }
  return out;
}
