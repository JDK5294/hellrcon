/**
 * Two kinds of json the Postgres store keeps in a shorter spelling: a kill's sides (evt.data on
 * evt.kill and evt.teamkill rows) and a roster sample's composition (roster_snapshots.composition).
 * The store packs on write and unpacks on read, so everything above it sees exactly what was
 * written. A value that would not come back exactly is stored as it came: packing only ever
 * shortens the spelling, never changes the value. Rows written before the packing are read as
 * they always were.
 */

const KILL_KEYS = ["playerTeam", "victimTeam", "actorSide", "victimSide"] as const;
const KILL_KINDS = new Set(["evt.kill", "evt.teamkill"]);

/** The order a packed side keeps its figures in. The hour grid's SQL reads them by position. */
export const PACKED_SIDE_FIELDS = ["players", "squads", "noSlSquads", "unsquadded", "byRole"] as const;
const COMPOSITION_KEYS = ["players", "bySide", "unassigned", "byRole"];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const json = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Equal as stored json: the same values, objects compared without regard to key order (jsonb
 *  keeps none). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

/** The packed spelling when it reads back exactly as the value it stands for, else the value. */
function shorter(value: unknown, packed: unknown, unpack: (stored: unknown) => unknown): unknown {
  return sameJson(unpack(json(packed)), json(value)) ? packed : value;
}

/**
 * A kill's data as stored: its four values in a fixed order (null stays null), `false` for a key
 * it did not have, and the absent ones at the end left off. A live kill's
 * `{"playerTeam":"Allies","victimTeam":"Axis","actorSide":"allies","victimSide":"axis"}` is 99
 * bytes as jsonb, `["Allies","Axis","allies","axis"]` 44; an imported kill's
 * `{"actorSide":"allies","victimSide":"axis"}` is 53, `[false,false,"allies","axis"]` 34.
 */
export function packKillData(kind: string, data: unknown): unknown {
  if (!KILL_KINDS.has(kind) || !isObject(data)) return data ?? null;
  const keys = Object.keys(data);
  if (!keys.length || !keys.every((k) => (KILL_KEYS as readonly string[]).includes(k))) return data;
  const packed: unknown[] = KILL_KEYS.map((k) => (Object.hasOwn(data, k) ? data[k] : false));
  while (packed.at(-1) === false) packed.pop();
  return shorter(data, packed, (s) => unpackKillData(kind, s));
}

export function unpackKillData(kind: string, stored: unknown): Json | null {
  if (!KILL_KINDS.has(kind) || !Array.isArray(stored)) return (stored as Json | null | undefined) ?? null;
  const out: Json = {};
  KILL_KEYS.forEach((k, i) => { if (i < stored.length && stored[i] !== false) out[k] = stored[i]; });
  return out;
}

/**
 * A roster sample's composition as stored. Each side's five figures go in a list in
 * PACKED_SIDE_FIELDS order, the top level's keys shrink to a letter, and the top level's role
 * counts, which are the sides' role counts added up, are left out. Only the roles of players on no
 * side (`ur`) are kept, where there are any. A 100-player sample is 670 bytes as jsonb instead of
 * 986. A packed composition is the only kind with a `b` and no `bySide`.
 */
export function packComposition(composition: unknown): unknown {
  if (!isObject(composition)) return composition ?? {};
  const keys = Object.keys(composition);
  if (keys.length !== COMPOSITION_KEYS.length || !COMPOSITION_KEYS.every((k) => keys.includes(k))) return composition;
  const { players, bySide, unassigned, byRole } = composition;
  if (!isObject(bySide) || !isObject(byRole)) return composition;
  const b: Json = {};
  const sided: Record<string, number> = {};
  for (const [id, side] of Object.entries(bySide)) {
    if (!isObject(side) || Object.keys(side).length !== PACKED_SIDE_FIELDS.length || !PACKED_SIDE_FIELDS.every((f) => Object.hasOwn(side, f))) return composition;
    b[id] = PACKED_SIDE_FIELDS.map((f) => side[f]);
    if (!isObject(side.byRole)) return composition;
    for (const [role, n] of Object.entries(side.byRole)) sided[role] = (sided[role] ?? 0) + Number(n);
  }
  const ur: Record<string, number> = {};
  for (const [role, n] of Object.entries(byRole)) if (Number(n) !== (sided[role] ?? 0)) ur[role] = Number(n) - (sided[role] ?? 0);
  for (const role of Object.keys(sided)) if (!Object.hasOwn(byRole, role)) ur[role] = -sided[role]!;
  return shorter(composition, { p: players, b, x: unassigned, ...(Object.keys(ur).length ? { ur } : {}) }, unpackComposition);
}

export function unpackComposition(stored: unknown): Json {
  if (!isObject(stored)) return (stored as Json | null | undefined) ?? {};
  if (!Object.hasOwn(stored, "b") || Object.hasOwn(stored, "bySide") || !isObject(stored.b)) return stored;
  const bySide: Json = {};
  const byRole: Record<string, number> = {};
  for (const [id, packed] of Object.entries(stored.b)) {
    const side: Json = {};
    PACKED_SIDE_FIELDS.forEach((f, i) => { side[f] = Array.isArray(packed) ? packed[i] : undefined; });
    bySide[id] = side;
    if (isObject(side.byRole)) for (const [role, n] of Object.entries(side.byRole)) byRole[role] = (byRole[role] ?? 0) + Number(n);
  }
  if (isObject(stored.ur)) for (const [role, n] of Object.entries(stored.ur)) byRole[role] = (byRole[role] ?? 0) + Number(n);
  for (const role of Object.keys(byRole)) if (byRole[role] === 0) delete byRole[role];
  return { players: stored.p, bySide, unassigned: stored.x, byRole };
}
