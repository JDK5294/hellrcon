/**
 * Reading Vietnam's own answers — the ones HLL's `hll/state.ts` has no counterpart for.
 *
 * Vietnam STORES objective layouts per map id (SetSectorLayout {MapId, Sector_N}, p11 of the
 * Vietnam RCON document) and reads them back with GetSectorLayout, wired as the logical
 * `getObjectives` in this game's command table beside it. The answer is `Entries[]`, each a MapId
 * and five sector indices.
 *
 * The API has long had a TOLERANT reader of that answer for display (apps/api/src/map-actions.ts
 * `parseStoredLayouts`): anything it cannot read becomes "nothing stored", which is the right
 * failure for a screen. It is the wrong failure for a caller about to WRITE on the strength of the
 * answer — the objective-preset protocol stores a layout, reads the list again to see where it
 * landed, and later restores or removes it. Read "unreadable" as "empty" there and a staff layout
 * gets removed as if it had never existed, or ours is never found again and stays forever. So this
 * is the strict variant: it says null when it does not recognise the answer, and keeps the raw
 * sector values so the consumer validates the one entry it cares about instead of this parser
 * quietly repairing it.
 */

/** One stored layout as the game listed it. Sectors are raw: numbers as given, anything else NaN. */
export interface StoredLayoutEntry { mapId: string; sectors: number[] }

/** A sector value as given when it is a number (or a numeric string), else NaN — never repaired:
 *  `Number(null)` is 0, and a missing value read as option 1 would be a layout nobody stored. */
const rawSector = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
};

/**
 * GetSectorLayout's answer, or null when it is not one we recognise.
 *
 * Recognised: an object carrying an `entries`/`Entries` array, or a bare array. An EMPTY array is a
 * real answer ("nothing stored") and comes back as []. Null for everything else — a failed read, a
 * missing or non-array list, and also a list holding an entry whose map id cannot be read: that
 * entry is a layout stored under SOME map we cannot name, so any answer about a particular map
 * ("nothing is stored for WDEV_A") would be a guess. An entry with a readable map id but no
 * readable sector list is kept with `sectors: []`, so a consumer sees "present but invalid"
 * rather than "absent".
 */
export function parseStoredLayoutsStrict(raw: unknown): StoredLayoutEntry[] | null {
  let entries: unknown = undefined;
  if (Array.isArray(raw)) entries = raw;
  else if (raw && typeof raw === "object") {
    const box = raw as Record<string, unknown>;
    entries = box.entries ?? box.Entries;
  }
  if (!Array.isArray(entries)) return null;
  const out: StoredLayoutEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") return null;
    const o = e as Record<string, unknown>;
    const id = o.mapId ?? o.MapId ?? o.mapID ?? o.MapID;
    const mapId = typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
    if (!mapId) return null;
    const sectors = o.sectors ?? o.Sectors;
    out.push({ mapId, sectors: Array.isArray(sectors) ? sectors.map(rawSector) : [] });
  }
  return out;
}
