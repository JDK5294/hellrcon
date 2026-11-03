import { test } from "node:test";
import assert from "node:assert/strict";
// Imported from dist (test script builds first): state.ts is reached through the module's runtime
// .js specifiers, which strip-types can't resolve back to source — same pattern as the log tests.
import { parseRotation, parseNextInRotation, parseMapShuffle, parseMapEntries, parseMapCatalogue, parsePlayerCount, parseObjectiveRows } from "../dist/hll/state.js";

test("rotation: the object form, the bare-array form, and an empty answer", () => {
  assert.deepEqual(parseRotation({ mAPS: [{ iD: "foy_warfare" }, { iD: "kharkov_warfare" }], currentIndex: 1 }),
    { maps: ["foy_warfare", "kharkov_warfare"], currentIndex: 1 });
  assert.deepEqual(parseRotation(["foy_warfare"]), { maps: ["foy_warfare"], currentIndex: 0 });
  assert.deepEqual(parseRotation(null), { maps: [], currentIndex: 0 });
  assert.deepEqual(parseRotation({}), { maps: [], currentIndex: 0 });
});

test("rotation: every spelling a server has been seen to use", () => {
  // Builds differ on case for both the list and the id, and on snake_case for the index. Accepting
  // only one spelling means an empty rotation on the servers that use the other.
  for (const key of ["mAPS", "maps", "MAPS"]) {
    assert.deepEqual(parseRotation({ [key]: ["a", "b"] }).maps, ["a", "b"], `list key ${key}`);
  }
  assert.deepEqual(parseRotation({ maps: [{ id: "lowercase_id" }] }).maps, ["lowercase_id"]);
  assert.equal(parseRotation({ maps: [], current_index: 3 }).currentIndex, 3);
});

/*
 * The field case: two skirmish maps at 1 and 2, two more added at 3 and 4, and the game's place
 * left on entry 2 by the edits before them. Entry 3 played — the map already in play — while the
 * editor showed a list anyone would read from the top. "Next" is the entry after the game's place.
 */
test("next in rotation: the entry after the game's own place, wrapping — not the first entry", () => {
  const rot = (currentIndex: number) => ({ mAPS: ["smdm_skirmish", "sme_skirmish", "smdm_warfare", "carentan_warfare"].map((iD) => ({ iD })), currentIndex });
  assert.equal(parseNextInRotation(rot(1)), 2, "place on entry 2 → entry 3 plays");
  assert.equal(parseNextInRotation(rot(3)), 0, "place on the last entry wraps to the first");
  // The same place before the two maps were appended: a two-map list wraps to the top instead,
  // which is how appending to the END moved what plays next.
  assert.equal(parseNextInRotation({ mAPS: [{ iD: "smdm_skirmish" }, { iD: "sme_skirmish" }], currentIndex: 1 }), 0);
  // A place past the end (its entry was removed) still wraps the way the game counts.
  assert.equal(parseNextInRotation({ mAPS: [{ iD: "a" }, { iD: "b" }], currentIndex: 2 }), 1);
  assert.equal(parseNextInRotation({ maps: ["a", "b", "c"], current_index: 0 }), 1, "the snake_case spelling");
  // A next index the answer states itself (CRCON's flattened rotation) is taken as given.
  assert.equal(parseNextInRotation({ maps: ["a", "b", "c"], current_index: 0, next_index: 2 }), 2);
});

test("next in rotation: unknown when the answer does not say where the game is", () => {
  assert.equal(parseNextInRotation(["a", "b"]), null, "a bare list has no place — never guess entry 2");
  assert.equal(parseNextInRotation({ maps: ["a", "b"] }), null, "an object without an index either");
  assert.equal(parseNextInRotation({ mAPS: [], currentIndex: 0 }), null, "an empty rotation has no next");
  assert.equal(parseNextInRotation(null), null);
  assert.equal(parseNextInRotation({ maps: ["a", "b"], next_index: 5 }), null, "a stated index off the list is not trusted");
});

test("map shuffle: v2's { enable } answer, the legacy words, and unknown when it does not say", () => {
  assert.equal(parseMapShuffle({ enable: true }), true);
  assert.equal(parseMapShuffle({ enable: false }), false);
  assert.equal(parseMapShuffle({ Enabled: "True" }), true);
  assert.equal(parseMapShuffle(true), true);
  assert.equal(parseMapShuffle(" TRUE "), true);
  assert.equal(parseMapShuffle("FALSE"), false);
  assert.equal(parseMapShuffle("off"), false);
  assert.equal(parseMapShuffle(1), true, "a bare 1/0 body");
  assert.equal(parseMapShuffle(0), false);
  // A sentence is never read for a word inside it: this one holds "enabled" and means OFF, and
  // reading it as on would put a shuffle warning on a server that is not shuffling.
  assert.equal(parseMapShuffle("Map shuffle enabled: False"), null);
  assert.equal(parseMapShuffle("Map shuffle is enabled"), null, "unknown wording stays unknown");
  assert.equal(parseMapShuffle({}), null, "an answer without the switch is unknown, not off");
  assert.equal(parseMapShuffle(null), null);
  assert.equal(parseMapShuffle("garbled"), null);
});

test("map entries: each with the game's own name, mode and time of day", () => {
  assert.deepEqual(parseMapEntries({ mAPS: [
    { iD: "/Game/BNW/Maps/FRA/SMDM/SMDM_Day_Skirmish", name: "ST MARIE DU MONT", gameMode: "Skirmish", timeOfDay: "Day", position: 0 },
  ], currentIndex: 0 }), [{ id: "/Game/BNW/Maps/FRA/SMDM/SMDM_Day_Skirmish", name: "ST MARIE DU MONT", gameMode: "Skirmish", timeOfDay: "Day" }]);
  assert.deepEqual(parseMapEntries(["carentan_warfare"]), [{ id: "carentan_warfare", name: "", gameMode: "", timeOfDay: "" }], "a bare list");
  assert.deepEqual(parseMapEntries({ maps: [{ id: "a", Name: "A", GameMode: "Warfare", TimeOfDay: "Night" }] }),
    [{ id: "a", name: "A", gameMode: "Warfare", timeOfDay: "Night" }], "the other casings");
  assert.deepEqual(parseMapEntries(null), []);
  assert.deepEqual(parseMapEntries({}), []);
});

test("map catalogue: the lowercase 'id' spelling is accepted", () => {
  // The regression this file exists for. The worker's private copy matched only `iD`, so against a
  // build reporting `id` the panel listed every map and the map vote had nothing to pick from.
  const wire = (idKey: string) => ({ dialogueParameters: [{ [idKey]: "MapName", valueMember: "foy_warfare,kharkov_warfare" }] });
  assert.deepEqual(parseMapCatalogue(wire("iD")), ["foy_warfare", "kharkov_warfare"]);
  assert.deepEqual(parseMapCatalogue(wire("id")), ["foy_warfare", "kharkov_warfare"], "lowercase id must work too");
});

test("map catalogue: the shallow forms and the noise cases", () => {
  assert.deepEqual(parseMapCatalogue("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(parseMapCatalogue([" a ", "b", ""]), ["a", "b"]);
  assert.deepEqual(parseMapCatalogue({ dialogueParameters: [{ iD: "SomethingElse", valueMember: "x" }] }), [],
    "a dialogue with no MapName parameter yields nothing, not its neighbour's value");
  assert.deepEqual(parseMapCatalogue(null), []);
  assert.deepEqual(parseMapCatalogue({}), []);
});

test("player count: the snake_case spellings are accepted", () => {
  // The other regression. The worker's copy read camelCase only, so on a snake_case build every
  // population-gated auto-settings profile and the vote's low-population pause never fired.
  assert.equal(parsePlayerCount({ playerCount: 42 }), 42);
  assert.equal(parsePlayerCount({ player_count: 42 }), 42);
  assert.equal(parsePlayerCount({ alliedPlayerCount: 20, axisPlayerCount: 22 }), 42);
  assert.equal(parsePlayerCount({ allied_player_count: 20, axis_player_count: 22 }), 42, "snake_case must work too");
});

test("player count: an answer that doesn't say is null, not zero", () => {
  // A gate that reads "unknown" as "empty server" applies the empty-server settings to a full one.
  assert.equal(parsePlayerCount(null), null);
  assert.equal(parsePlayerCount({}), null);
  assert.equal(parsePlayerCount({ alliedPlayerCount: 20 }), null, "one side alone is not a total");
  assert.equal(parsePlayerCount("nonsense"), null);
  assert.equal(parsePlayerCount({ playerCount: 0 }), 0, "a real zero is still a zero");
});

// ---- the objective grid (moved here from the API's route kit so the worker can share it) ----

/** GetClientReferenceData("SetSectorLayout") as the wire nests it: one dialogue parameter per
 *  sector, its three options a comma list under valueMember. */
const grid = (idKey: string, rows: string[][], valueKey = "valueMember") => ({
  dialogueParameters: rows.map((opts, i) => ({ [idKey]: `Sector_${i + 1}`, [valueKey]: opts.join(", ") })),
});
const FIVE = [["A1", "A2", "A3"], ["B1", "B2", "B3"], ["C1", "C2", "C3"], ["D1", "D2", "D3"], ["E1", "E2", "E3"]];

test("objective rows: five sectors in sector order, options trimmed", () => {
  assert.deepEqual(parseObjectiveRows(grid("iD", FIVE)), FIVE);
  // The order on the wire is not the order of the rows: the row index IS the sector number, so a
  // shuffled answer must still come back Sector_1 first.
  const shuffled = grid("iD", FIVE);
  shuffled.dialogueParameters.reverse();
  assert.deepEqual(parseObjectiveRows(shuffled), FIVE);
});

test("objective rows: the lowercase 'id' spelling and the 'value' fallback are accepted", () => {
  assert.deepEqual(parseObjectiveRows(grid("id", FIVE)), FIVE, "lowercase id must work too");
  assert.deepEqual(parseObjectiveRows(grid("iD", FIVE, "value")), FIVE, "value when valueMember is absent");
});

test("objective rows: a missing or empty sector answers [], never a shifted partial grid", () => {
  // Four rows would put sector 4's options under sector 3's pick — every later pick off by one.
  const missing = grid("iD", FIVE);
  missing.dialogueParameters.splice(2, 1);
  assert.deepEqual(parseObjectiveRows(missing), []);
  const empty = grid("iD", FIVE);
  empty.dialogueParameters[4] = { iD: "Sector_5", valueMember: " , " };
  assert.deepEqual(parseObjectiveRows(empty), [], "a sector with no options is as good as missing");
  assert.deepEqual(parseObjectiveRows(null), []);
  assert.deepEqual(parseObjectiveRows({}), []);
  assert.deepEqual(parseObjectiveRows({ dialogueParameters: "nope" }), []);
});

test("objective rows: exported from the package index for the API and the worker", async () => {
  const mod = await import("../dist/index.js");
  assert.equal(mod.parseObjectiveRows, parseObjectiveRows);
});
