/**
 * The sector grid and the zone key: the two facts seeding containment stands on. The grid names
 * the same cell for a position that the panel's picker draws, and the key folds EVERY spelling of
 * a map — layer id, compact skirmish id, Vietnam's two id shapes, a pretty name — to one string,
 * which is also the panel's art-family name. If either drifts, zones enforce somewhere other than
 * where they were drawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sectorOf, isSectorId, allSectorIds, zoneKeyOf, SECTOR_GRID, SECTOR_WORLD_EXTENT, learnedLayoutOf, layoutZonePaint, layerZoneKey } from "../dist/index.js";

test("sectorOf names cells the way the tactical map labels them", () => {
  assert.equal(sectorOf(-100_000, -100_000), "A1", "north-west corner");
  assert.equal(sectorOf(99_999, 99_999), "J10", "south-east corner");
  assert.equal(sectorOf(0, 0), "F6", "dead centre falls in the sixth column/row cell");
  assert.equal(sectorOf(-100_000, 99_999), "A10", "south-west");
  // Positions off the square (spawn glitches, vehicles clipping the edge) clamp, never throw.
  assert.equal(sectorOf(250_000, -250_000), "J1");
});

test("the sector vocabulary is closed: every generated id validates, junk does not", () => {
  const all = allSectorIds();
  assert.equal(all.length, SECTOR_GRID * SECTOR_GRID);
  for (const id of all) assert.ok(isSectorId(id), id);
  for (const bad of ["K1", "A0", "A11", "a1", "5A", "", "A1 "]) assert.ok(!isSectorId(bad), bad);
});

test("every spelling of a map folds to one zone key, and it is the art family's name", () => {
  // WW2: layer ids, offensive/team variants and the compact skirmish spelling are one map.
  for (const id of ["carentan_warfare", "carentan_offensive_us", "CAR_S_1944", "carentan_warfare_night"]) {
    assert.equal(zoneKeyOf(id), "carentan", id);
  }
  for (const id of ["stmereeglise_warfare", "SME_S_1944", "stmereeglise_offensive_ger"]) {
    assert.equal(zoneKeyOf(id), "stmereeglise", id);
  }
  assert.equal(zoneKeyOf("stmariedumont_off_us"), "stmariedumont");
  assert.equal(zoneKeyOf("hill400_warfare"), "hill400");
  // Vietnam: the map id and the layer id are different spellings of the same six maps.
  for (const id of ["WDEV_A", "wdeva_warfare_day", "Vạn Tường"]) assert.equal(zoneKeyOf(id), "vantuong", id);
  assert.equal(zoneKeyOf("WDEV_F"), "thanhhoabridge");
  assert.equal(zoneKeyOf("wdevc_warfare_day"), "hueoutskirts");
  // Blank input is "no key", never a phantom family.
  assert.equal(zoneKeyOf(""), null);
  assert.equal(zoneKeyOf(null), null);
});

/*
 * Per-LAYER learned layouts: one vote per calibrated round, trusted once two rounds agree and the
 * winning reading holds three votes in four — so a round with mis-coloured spawns is outvoted.
 */
test("learnedLayoutOf: two agreeing rounds and a 3-in-4 majority, or nothing", () => {
  assert.equal(learnedLayoutOf(null), null);
  assert.equal(learnedLayoutOf({ xNeg: 1, xPos: 0, yNeg: 0, yPos: 0 }), null, "one round is not a pattern");
  assert.deepEqual(learnedLayoutOf({ xNeg: 2, xPos: 0, yNeg: 0, yPos: 0 }), { axis: "x", alliesDir: -1, rounds: 2, agree: 2 });
  assert.equal(learnedLayoutOf({ xNeg: 2, xPos: 1, yNeg: 0, yPos: 0 }), null, "2 of 3 is below the 3-in-4 bar");
  assert.deepEqual(learnedLayoutOf({ xNeg: 1, xPos: 0, yNeg: 0, yPos: 6 }), { axis: "y", alliesDir: 1, rounds: 7, agree: 6 }, "a flipped round is outvoted");
});

test("layoutZonePaint: each side's own ground less its HQ line, the middle left empty, matching the auto fence cell for cell", () => {
  const h = layoutZonePaint({ axis: "x", alliesDir: -1 });
  assert.ok(h.allies.includes("B1") && h.allies.includes("D10"), "allies own columns B–D");
  assert.deepEqual(h.shared, [], "the middle is left empty — free for both, like painting it for both");
  assert.ok(h.axis.includes("G1") && h.axis.includes("I10"), "axis own G–I");
  const painted = [...h.allies, ...h.shared, ...h.axis];
  assert.ok(!painted.some((c) => /^[AEFJ]/.test(c)), "the HQ lines (columns A and J) and the middle (E–F) stay unpainted");
  assert.equal(painted.length, 60, "every other cell is painted…");
  assert.equal(new Set(painted).size, 60, "…exactly once");
  const v = layoutZonePaint({ axis: "y", alliesDir: 1 });
  assert.ok(v.allies.includes("A9") && v.allies.includes("J7"), "vertical, allies at the bottom own rows 7–9");
  assert.ok(!v.allies.includes("A10") && !v.axis.includes("J1"), "rows 10 and 1 are the HQ lines");
  assert.ok(v.axis.includes("A2") && v.axis.includes("J4"));
  // The owner's marked Foy, the other way up: Allies on rows 2–4, Axis on rows 7–9, the HQ rows bare.
  const foy = layoutZonePaint({ axis: "y", alliesDir: -1 });
  assert.deepEqual([...new Set(foy.allies.map((c) => Number(c.slice(1))))].sort((a, b) => a - b), [2, 3, 4]);
  assert.deepEqual([...new Set(foy.axis.map((c) => Number(c.slice(1))))].sort((a, b) => a - b), [7, 8, 9]);
  // Cell for cell against the world geometry: each cell's CENTER, placed by sectorOf, lands in the
  // band its paint says (bands of two cells along the axis, counted from the allies end).
  for (const layout of [{ axis: "x" as const, alliesDir: -1 as const }, { axis: "x" as const, alliesDir: 1 as const }, { axis: "y" as const, alliesDir: -1 as const }, { axis: "y" as const, alliesDir: 1 as const }]) {
    const paint = layoutZonePaint(layout);
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
      const x = -SECTOR_WORLD_EXTENT + (i + 0.5) * (2 * SECTOR_WORLD_EXTENT / 10);
      const y = -SECTOR_WORLD_EXTENT + (j + 0.5) * (2 * SECTOR_WORLD_EXTENT / 10);
      const v2 = layout.axis === "x" ? x : y;
      const fromAllies = layout.alliesDir === -1 ? v2 + SECTOR_WORLD_EXTENT : SECTOR_WORLD_EXTENT - v2;
      const band = Math.floor(fromAllies / (2 * SECTOR_WORLD_EXTENT / 5));
      const cell = sectorOf(x, y);
      const where = paint.allies.includes(cell) ? "allies" : paint.shared.includes(cell) ? "shared" : paint.axis.includes(cell) ? "axis" : "unpainted";
      const along = layout.axis === "x" ? i : j;
      const want = along === 0 || along === 9 || band === 2 ? "unpainted" : band <= 1 ? "allies" : "axis";
      assert.equal(where, want, `${cell} in ${JSON.stringify(layout)}`);
    }
  }
});

test("layerZoneKey: the exact layer, lowercased, marked apart from family keys", () => {
  assert.equal(layerZoneKey("stmereeglise_warfare"), "@stmereeglise_warfare");
  assert.equal(layerZoneKey("CAR_S_1944_Day_P_Skirmish"), "@car_s_1944_day_p_skirmish");
  assert.equal(layerZoneKey(""), null);
});
