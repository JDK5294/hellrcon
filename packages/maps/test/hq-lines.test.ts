import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutZonePaint, onEndLine, onOuterLine, paintAxis, sectorLineOf, SECTOR_WORLD_EXTENT } from "../dist/index.js";

/*
 * The HQ lines: the first grid line at each end of the way a map runs. Nobody standing on one is
 * judged by the seeding areas and the learner never reads a side off one — at the start of a
 * round both teams show there — and a prefilled paint leaves them bare, exactly the cells
 * onEndLine names.
 */
test("HQ lines: the first grid line at each end, along the axis the map runs", () => {
  assert.equal(sectorLineOf(-SECTOR_WORLD_EXTENT), 0);
  assert.equal(sectorLineOf(-80_001), 0);
  assert.equal(sectorLineOf(-80_000), 1, "a line starts at its own edge");
  assert.equal(sectorLineOf(80_000), 9);
  assert.equal(sectorLineOf(250_000), 9, "off the square clamps to the edge line");
  assert.equal(onEndLine({ x: 0, y: -95_000 }, "y"), true, "row 1");
  assert.equal(onEndLine({ x: 0, y: 95_000 }, "y"), true, "row 10");
  assert.equal(onEndLine({ x: 0, y: -75_000 }, "y"), false, "row 2 is ground, not the HQ line");
  assert.equal(onEndLine({ x: -95_000, y: 0 }, "y"), false, "column A ends the OTHER axis");
  assert.equal(onEndLine({ x: -95_000, y: 0 }, "x"), true);
  assert.equal(onOuterLine({ x: -95_000, y: 0 }), true, "before the axis is known, every edge line");
  assert.equal(onOuterLine({ x: 0, y: 95_000 }), true);
  assert.equal(onOuterLine({ x: 0, y: 0 }), false);
});

test("HQ lines: a prefilled paint leaves them bare, along with the middle and nothing else", () => {
  for (const layout of [{ axis: "x" as const, alliesDir: -1 as const }, { axis: "y" as const, alliesDir: 1 as const }]) {
    const paint = layoutZonePaint(layout);
    const painted = new Set([...paint.allies, ...paint.shared, ...paint.axis]);
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) {
      const pos = { x: -SECTOR_WORLD_EXTENT + (i + 0.5) * 20_000, y: -SECTOR_WORLD_EXTENT + (j + 0.5) * 20_000 };
      const cell = `${"ABCDEFGHIJ"[i]}${j + 1}`;
      const along = layout.axis === "x" ? i : j;
      assert.equal(!painted.has(cell), onEndLine(pos, layout.axis) || along === 4 || along === 5, `${cell} in ${JSON.stringify(layout)}`);
    }
  }
});

test("HQ lines: a hand paint names its own direction, or none", () => {
  // The owner's marked Foy: Allies rows 2–4 and Axis rows 7–9 across the playable columns C–H.
  const cols = "CDEFGH".split("");
  const rows = (rs: number[]) => rs.flatMap((r) => cols.map((c) => `${c}${r}`));
  assert.equal(paintAxis({ allies: rows([2, 3, 4]), axis: rows([7, 8, 9]) }), "y");
  assert.equal(paintAxis(layoutZonePaint({ axis: "x", alliesDir: 1 })), "x");
  assert.equal(paintAxis({ allies: ["A1"], axis: [] }), null, "one team only: no direction");
  assert.equal(paintAxis({ allies: ["A1"], axis: ["J10"] }), null, "corner to corner: no direction");
  assert.equal(paintAxis({ allies: ["E5"], axis: ["F5"] }), null, "a single line apart is not a direction");
});
