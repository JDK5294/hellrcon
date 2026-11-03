/**
 * Applying a saved map set to a server's LIVE rotation — the pure half.
 *
 * The rotation editor only ever spoke one map at a time (add/remove), which made reshaping a
 * rotation for an event a 70-click chore. These two functions turn a library map set into a
 * one-shot apply: resolve the set to a concrete ordered lineup, then plan the exact command
 * sequence that makes the live rotation equal it. The API route and the events worker both
 * execute the same plan; neither re-derives the rules.
 */
import { DEFAULT_POOL_CONFIG, type MapPoolConfig } from "./vote.js";

/**
 * The concrete, ordered lineup a set describes — or null when it doesn't describe one.
 *
 * A set is usually a POLL RECIPE ("3 day warfare + 1 night"), and a recipe is not a lineup: it
 * names counts and rules, not an ordered list, so applying it to a rotation would mean silently
 * rolling dice. Only sets that are EXPLICIT resolve:
 *
 *   1. `sequence` — the lineup verbatim, order preserved. What "save rotation as set" writes.
 *   2. A recipe whose every counted bucket lists its maps explicitly — the lineup is those lists
 *      concatenated (enforced maps first, then the always-offered ones, then bucket order). Order
 *      across buckets is the editor's bucket order, so a mixed-mode lineup that must interleave
 *      should use `sequence`. Always-offered maps are part of what the set plays, so they ride in
 *      the lineup too — but alone they do not make a recipe a lineup.
 *
 * Duplicates collapse to the first occurrence: the game accepts the same map twice in a
 * rotation, but a set that lists one twice is far more likely a copy-paste than a plan.
 */
export function explicitRotationOf(pool: Partial<MapPoolConfig> | null | undefined): string[] | null {
  const p = pool ?? {};
  const clean = (ids: unknown): string[] =>
    (Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean);
  const dedupe = (ids: string[]): string[] => [...new Set(ids)];

  const sequence = clean(p.sequence);
  if (sequence.length) return dedupe(sequence);

  const out: string[] = [];
  const enforced = (p.enforceCount ?? 0) > 0 ? clean(p.enforcedMaps) : [];
  out.push(...enforced, ...clean(p.alwaysOffer));

  const buckets = Array.isArray(p.modeBuckets) ? p.modeBuckets : [];
  if (buckets.some((b) => (b?.count ?? 0) > 0)) {
    for (const b of buckets) {
      if ((b?.count ?? 0) <= 0) continue;
      const maps = clean(b.maps);
      if (!maps.length) return null; // a counted bucket with no explicit maps is a recipe, not a lineup
      out.push(...maps);
    }
    return out.length ? dedupe(out) : null;
  }

  const legacy: [number, unknown][] = [
    [p.dayCount ?? DEFAULT_POOL_CONFIG.dayCount, p.dayMaps],
    [p.nightCount ?? DEFAULT_POOL_CONFIG.nightCount, p.nightMaps],
    [p.wildcardCount ?? DEFAULT_POOL_CONFIG.wildcardCount, p.wildcardMaps],
  ];
  let counted = false;
  for (const [count, maps] of legacy) {
    if (count <= 0) continue;
    counted = true;
    const list = clean(maps);
    if (!list.length) return null;
    out.push(...list);
  }
  if (!counted && !enforced.length) return null;
  return out.length ? dedupe(out) : null;
}

/** One step of an apply: the same shape the add/remove RCON commands take. */
export interface RotationStep {
  op: "add" | "remove";
  mapId: string;
  index: number;
}

/**
 * The command sequence that turns `current` into exactly `target`, in order.
 *
 * Adds come FIRST, all of them, appended after the existing entries — the rotation must never
 * be emptied mid-flight, because HLL answers an empty rotation by refilling it with the entire
 * catalogue (see the remove route's warning). Then every ORIGINAL entry is removed from the
 * front: after the appends the originals occupy indices 0..C-1, so it is C removals of index 0,
 * each carrying the map name the game cross-checks. What remains is `target`, verbatim.
 *
 * A rebuild, not a diff, on purpose: the game's remove is by index, so any plan computed against
 * shifting survivor positions is fragile the moment an entry repeats. The one shortcut taken is
 * the identity case — a rotation already equal to the target gets an empty plan, so re-applying
 * a set (an event opening twice, a nervous double-click) touches nothing.
 */
export function planRotationApply(current: string[], target: string[]): RotationStep[] {
  if (!target.length) throw new Error("refusing to plan an empty rotation");
  if (current.length === target.length && current.every((m, i) => m === target[i])) return [];
  const steps: RotationStep[] = [];
  target.forEach((mapId, i) => steps.push({ op: "add", mapId, index: current.length + i }));
  current.forEach((mapId) => steps.push({ op: "remove", mapId, index: 0 }));
  return steps;
}
