/**
 * The tactical-map sector grid, and the map key seeding-containment zones are stored under.
 *
 * Both games draw the same 10×10 grid over the same ±100,000cm world square (verified across all
 * 26 tactical maps), so one constant transform names a sector for any world position: columns are
 * lettered A–J west→east, rows numbered 1–10 north→south — "A1" is the top-left corner, exactly as
 * the in-game tactical map labels it. The panel's zone picker and the worker's enforcement both go
 * through `sectorOf`, so a cell clicked on screen IS the cell enforced on the server; there is no
 * second calibration to drift.
 *
 * Grid-fence enforcement as a seeding tool follows FlorianSW/hll-geofences (MIT) in spirit — keep
 * the seed fight inside agreed sectors, warn → punish players who wander — but the math here is
 * derived from our own live-position data rather than ported.
 */
import { describeMap } from "./hll-maps.js";
import { CRCON_MAPS } from "./crcon-catalogue.js";

export const SECTOR_GRID = 10;
/** Half-width of the world square in world units (cm) — every map both games ship. */
export const SECTOR_WORLD_EXTENT = 100_000;

const LETTERS = "ABCDEFGHIJ";

/** One world coordinate → its grid line along that axis, 0–9 (0 = column A, or row 1). Off the
 *  square clamps to the edge line. */
export function sectorLineOf(v: number): number {
  return Math.min(SECTOR_GRID - 1, Math.max(0, Math.floor(((v + SECTOR_WORLD_EXTENT) / (2 * SECTOR_WORLD_EXTENT)) * SECTOR_GRID)));
}

/** World position → sector id ("E5"). Positions off the square clamp to the edge cells. */
export function sectorOf(x: number, y: number): string {
  return `${LETTERS[sectorLineOf(x)]}${sectorLineOf(y) + 1}`;
}

/**
 * Is this position on the FIRST grid line at either end of `axis` — the line a team's HQ sits on?
 *
 * The seeding position rules never judge anyone standing there, and the layout learner never reads
 * a side from it: at the start of a round both teams show on those lines (players swapping sides,
 * or still unassigned from the last match), and nobody from the other team reaches one without
 * first crossing three grid lines of the home team's ground, where they ARE judged. So the line
 * needs no paint, and a prefilled paint leaves it as a buffer.
 */
export function onEndLine(pos: { x: number; y: number }, axis: "x" | "y"): boolean {
  const line = sectorLineOf(axis === "x" ? pos.x : pos.y);
  return line === 0 || line === SECTOR_GRID - 1;
}

/** On the first grid line at ANY edge — the HQ lines, for when nobody knows yet which way the map
 *  runs (the other two edges are off the playable map anyway). */
export function onOuterLine(pos: { x: number; y: number }): boolean {
  return onEndLine(pos, "x") || onEndLine(pos, "y");
}

/**
 * Which way a zone paint runs: the axis along which its two teams' own cells sit furthest apart,
 * so its HQ lines are the first line at each end of it. Null when a team has no cells of its own,
 * when the two are not two grid lines apart either way, or not further apart one way than the
 * other — a paint that names no direction names no HQ lines either.
 */
export function paintAxis(z: { allies?: string[]; axis?: string[] }): "x" | "y" | null {
  const centre = (cells: string[]): { col: number; row: number } | null => {
    let col = 0, row = 0, n = 0;
    for (const id of cells) {
      const m = /^([A-J])([1-9]|10)$/.exec(id);
      if (!m) continue;
      col += LETTERS.indexOf(m[1]!); row += Number(m[2]) - 1; n += 1;
    }
    return n ? { col: col / n, row: row / n } : null;
  };
  const a = centre(z.allies ?? []), b = centre(z.axis ?? []);
  if (!a || !b) return null;
  const dx = Math.abs(a.col - b.col), dy = Math.abs(a.row - b.row);
  if (Math.max(dx, dy) < 2 || dx === dy) return null;
  return dx > dy ? "x" : "y";
}

/** Is this a well-formed sector id ("A1"–"J10")? The config validator's whole vocabulary. */
export function isSectorId(id: string): boolean {
  const m = /^([A-J])([1-9]|10)$/.exec(id);
  return m !== null;
}

/** All 100 sector ids, row-major (A1, B1, … J1, A2, …) — the order a picker renders them in. */
export function allSectorIds(): string[] {
  const out: string[] = [];
  for (let row = 1; row <= SECTOR_GRID; row++) for (const col of LETTERS) out.push(`${col}${row}`);
  return out;
}

/**
 * The key a map's containment zones are stored under — one key per map FAMILY, however the wire
 * spells the round ("carentan_warfare_day", "CAR_S_1944", a pretty name…). Zones are drawn once
 * per map, not once per mode/time-of-day variant, so every spelling of a family must fold to the
 * same key.
 *
 * Derived from the map's display NAME rather than `inferFamily`'s id-based split, because the
 * display name is the one spelling every id variant already funnels into — the compact skirmish
 * ids (SME_S_1944) and Vietnam's two id spellings (WDEV_A / wdeva_warfare_day) all resolve to the
 * same pretty name, where the raw ids would each mint their own family. The folding then matches
 * the panel's art-family names ("stmereeglise", "vantuong"), so the same key also finds the map's
 * tactical-map image.
 */
/**
 * The maps a containment-zone editor offers, per game — zone key + the label people read. WW2
 * enumerates the CRCON catalogue's map families (whose keys are already zone keys); Vietnam is its
 * own six, listed here because no shared catalogue carries them yet. A live round on a map absent
 * from this list still enforces fine — the worker keys by `zoneKeyOf` of whatever the session
 * reports — the list only bounds what the editor can draw on.
 */
export function containMapCatalog(game: string): { key: string; label: string }[] {
  if (game === "hllv") {
    return [
      { key: "vantuong", label: "Vạn Tường" }, { key: "quangngai", label: "Quảng Ngãi" },
      { key: "hueoutskirts", label: "Huế Outskirts" }, { key: "daktoairfield", label: "Đăk Tô Airfield" },
      { key: "camranhport", label: "Cam Ranh Port" }, { key: "thanhhoabridge", label: "Thanh Hòa Bridge" },
    ];
  }
  return Object.entries(CRCON_MAPS).map(([key, facts]) => ({ key, label: facts.prettyName }));
}

export function zoneKeyOf(mapIdOrName: string | null | undefined): string | null {
  const text = String(mapIdOrName ?? "").trim();
  if (!text) return null;
  // prettyName is "Carentan — Warfare"; the family half is everything before the mode dash.
  const name = describeMap(text).prettyName.split(" — ")[0]!;
  const key = name.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\bsainte?\b/g, "st") // the art families spell the saints "st", the game spells them out
    .replace(/[^a-z0-9]/g, "");
  return key || null;
}

/**
 * A layer's learned attack geometry — which axis the fight runs along and which end the Allies
 * start at — or null while the evidence is too thin to trust. Evidence is one vote per round whose
 * players' trips out of their own end agreed (see map_layouts, and foldTravel in the worker). Two
 * rounds must agree, and the winning reading must hold at least three votes in four: a round with
 * the side labels flipped wholesale is outvoted instead of being taught to every round after it.
 */
export interface LayoutVotes { xNeg: number; xPos: number; yNeg: number; yPos: number }
export interface LearnedLayout { axis: "x" | "y"; alliesDir: -1 | 1; rounds: number; agree: number }

export const LAYOUT_MIN_AGREE = 2;
export const LAYOUT_MIN_SHARE = 0.75;

export function learnedLayoutOf(v: LayoutVotes | null | undefined): LearnedLayout | null {
  if (!v) return null;
  const readings: [LearnedLayout["axis"], LearnedLayout["alliesDir"], number][] = [
    ["x", -1, v.xNeg], ["x", 1, v.xPos], ["y", -1, v.yNeg], ["y", 1, v.yPos],
  ];
  const rounds = readings.reduce((n, r) => n + r[2], 0);
  const best = readings.reduce((a, b) => (b[2] > a[2] ? b : a));
  if (best[2] < LAYOUT_MIN_AGREE || best[2] / rounds < LAYOUT_MIN_SHARE) return null;
  return { axis: best[0], alliesDir: best[1], rounds, agree: best[2] };
}

/**
 * Zone paint for a layout: each side's own ground along the attack axis — its two fifths, less its
 * HQ line — and nothing else. Along the axis the 10-cell grid is five bands of two cells;
 * `alliesDir -1` puts the Allies at the low end (columns B–D, or rows 2–4). The middle fifth stays
 * EMPTY: a player is only judged on the other team's ground, so an empty square is free for both
 * teams, the same as painting it "both teams" with less to go wrong (the owner's call) — the
 * classic "fight over mid" seed, and the fence the auto zones enforce. The first line at each end
 * stays empty too: nobody is judged standing there (see onEndLine), so it is a buffer.
 */
export function layoutZonePaint(layout: { axis: "x" | "y"; alliesDir: -1 | 1 }): { allies: string[]; axis: string[]; shared: string[] } {
  const out = { allies: [] as string[], axis: [] as string[], shared: [] as string[] };
  for (let col = 0; col < SECTOR_GRID; col++) {
    for (let row = 0; row < SECTOR_GRID; row++) {
      const along = layout.axis === "x" ? col : row;
      if (along === 0 || along === SECTOR_GRID - 1) continue;
      const band = Math.floor((layout.alliesDir === -1 ? along : SECTOR_GRID - 1 - along) / 2);
      const cell = `${LETTERS[col]}${row + 1}`;
      if (band <= 1) out.allies.push(cell);
      else if (band >= 3) out.axis.push(cell);
    }
  }
  return out;
}

/** The key a single LAYER's zones are stored under — it wins over the family key, because the
 *  layer (not the family) fixes which end each side attacks from. */
export function layerZoneKey(mapId: string | null | undefined): string | null {
  const id = String(mapId ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  return id ? `@${id}` : null;
}
