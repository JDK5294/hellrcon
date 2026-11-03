/**
 * The short spellings the Postgres store keeps two kinds of json in (compact-json.ts): a kill's
 * sides, and a roster sample's composition. Each must read back exactly as it was written, and
 * anything that would not is stored as it came. Rows written before the packing read as they were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { packComposition, packKillData, unpackComposition, unpackKillData } from "../src/compact-json.ts";

/** Through storage and back: what a jsonb column hands the reader is the json of what went in. */
const stored = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

test("kill data: a list of four in a fixed order, absent keys false and left off the end; read back exactly", () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["evt.kill", { playerTeam: "Allies", victimTeam: "Axis", actorSide: "allies", victimSide: "axis" }, ["Allies", "Axis", "allies", "axis"]],
    ["evt.teamkill", { playerTeam: "Axis", victimTeam: "Axis", actorSide: "axis", victimSide: "axis" }, ["Axis", "Axis", "axis", "axis"]],
    // A side the line did not name stays null.
    ["evt.kill", { playerTeam: "Allies", victimTeam: null, actorSide: "allies", victimSide: null }, ["Allies", null, "allies", null]],
    // Imported kills carry only the sides CRCON's line declared.
    ["evt.kill", { actorSide: "allies", victimSide: "axis" }, [false, false, "allies", "axis"]],
    ["evt.kill", { actorSide: "allies" }, [false, false, "allies"]],
    ["evt.kill", { victimSide: "axis" }, [false, false, false, "axis"]],
  ];
  for (const [kind, data, packed] of cases) {
    assert.deepEqual(packKillData(kind, data), packed, JSON.stringify(data));
    assert.deepEqual(unpackKillData(kind, stored(packKillData(kind, data))), data, `${JSON.stringify(data)} reads back`);
  }
});

test("kill data: anything else is stored as it came, and rows from before read as they were", () => {
  const asIs: [string, unknown][] = [
    ["evt.chat.all", { message: "gg" }], // not a kill
    ["evt.kill", null],
    ["evt.kill", {}],
    ["evt.kill", { playerTeam: "Allies", extra: 1 }], // a key the spelling has no place for
    ["evt.kill", { actorSide: false }], // false is the spelling's own "absent"
  ];
  for (const [kind, data] of asIs) assert.equal(packKillData(kind, data), data, JSON.stringify(data));
  const old = { playerTeam: "Allies", victimTeam: "Axis", actorSide: "allies", victimSide: "axis" };
  assert.equal(unpackKillData("evt.kill", old), old);
  assert.equal(unpackKillData("evt.kill", null), null);
  // A list is only ever a kill's packed sides.
  assert.deepEqual(unpackKillData("evt.chat.all", ["a"]), ["a"]);
});

const side = (players: number, squads: number, noSlSquads: string[], unsquadded: number, byRole: Record<string, number>) =>
  ({ players, squads, noSlSquads, unsquadded, byRole });

test("composition: each side a list, the top level's role counts left out; read back exactly", () => {
  const allies = side(50, 12, ["BAKER", "DOG"], 2, { 0: 4, 1: 7, 9: 9 });
  const axis = side(49, 12, ["ABLE"], 1, { 0: 4, 1: 6, 9: 8 });
  const composition = { players: 100, bySide: { allies, axis }, unassigned: 1, byRole: { 0: 8, 1: 13, 9: 17 } };
  // The one unassigned player has no role: the top's role counts are the sides' added up.
  assert.deepEqual(packComposition(composition), {
    p: 100,
    b: { allies: [50, 12, ["BAKER", "DOG"], 2, { 0: 4, 1: 7, 9: 9 }], axis: [49, 12, ["ABLE"], 1, { 0: 4, 1: 6, 9: 8 }] },
    x: 1,
  });
  assert.deepEqual(unpackComposition(stored(packComposition(composition))), stored(composition));
  // Players on no side who hold a role: theirs alone is kept, and the top adds up again.
  const withUnassigned = { ...composition, byRole: { 0: 8, 1: 13, 9: 17, 13: 1 } };
  assert.deepEqual((packComposition(withUnassigned) as { ur: unknown }).ur, { 13: 1 });
  assert.deepEqual(unpackComposition(stored(packComposition(withUnassigned))), stored(withUnassigned));
  // A role a side counts that the top does not still reads back as written.
  const uneven = { ...composition, byRole: { 0: 8, 1: 13 } };
  assert.deepEqual(unpackComposition(stored(packComposition(uneven))), stored(uneven));
  // No sides at all (nobody resolved to a team).
  const sideless = { players: 7, unassigned: 7, byRole: {}, bySide: {} };
  assert.deepEqual(packComposition(sideless), { p: 7, b: {}, x: 7 });
  assert.deepEqual(unpackComposition(stored(packComposition(sideless))), sideless);
});

test("composition: anything else is stored as it came, and samples from before read as they were", () => {
  const allies = side(5, 1, [], 0, { 1: 5 });
  const asIs: unknown[] = [
    {},
    { players: 5, bySide: { allies }, byRole: { 1: 5 } }, // no unassigned count
    { players: 5, bySide: { allies }, unassigned: 0, byRole: { 1: 5 }, extra: true },
    { players: 5, bySide: { allies: { ...allies, squadsLed: 1 } }, unassigned: 0, byRole: { 1: 5 } },
    { players: 5, bySide: { allies }, unassigned: 0, byRole: { 1: 5, 2: 0 } }, // a zero the sum cannot say
  ];
  for (const c of asIs) assert.equal(packComposition(c), c, JSON.stringify(c));
  assert.deepEqual(packComposition(null), {});
  const old = { players: 5, bySide: { allies }, unassigned: 0, byRole: { 1: 5 } };
  assert.equal(unpackComposition(old), old);
  assert.deepEqual(unpackComposition(null), {});
});
