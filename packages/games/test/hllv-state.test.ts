/**
 * Vietnam's stored-layout list, read STRICTLY. The objective-preset protocol writes on the
 * strength of this answer — it stores a layout, looks for where it landed, and later restores or
 * removes it — so "could not read" must never come back looking like "nothing stored": that is
 * how a staff layout gets removed as if it never existed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStoredLayoutsStrict } from "../dist/index.js";

test("strict layouts: Entries, entries and a bare array are all recognised", () => {
  const entry = { MapId: "WDEV_A", Sectors: [0, 1, 2, 1, 0] };
  const want = [{ mapId: "WDEV_A", sectors: [0, 1, 2, 1, 0] }];
  assert.deepEqual(parseStoredLayoutsStrict({ Entries: [entry] }), want);
  assert.deepEqual(parseStoredLayoutsStrict({ entries: [entry] }), want);
  assert.deepEqual(parseStoredLayoutsStrict([entry]), want);
  // Every casing of the map id a v2 build might produce, and the lowercase sector list.
  for (const key of ["mapId", "MapId", "mapID", "MapID"]) {
    assert.deepEqual(parseStoredLayoutsStrict({ entries: [{ [key]: " WDEV_A ", sectors: [0, 1, 2, 1, 0] }] }), want, key);
  }
});

test("strict layouts: an empty list is a real answer, an unreadable one is null", () => {
  assert.deepEqual(parseStoredLayoutsStrict({ Entries: [] }), [], "nothing stored");
  assert.deepEqual(parseStoredLayoutsStrict([]), []);
  // The tolerant reader turns all of these into [] — exactly the confusion this one exists to avoid.
  for (const raw of [null, undefined, "", "Entries", 42, {}, { Entries: null }, { entries: "WDEV_A" }, { Result: [] }]) {
    assert.equal(parseStoredLayoutsStrict(raw), null, JSON.stringify(raw) ?? "undefined");
  }
});

test("strict layouts: an entry whose map cannot be named makes the whole answer unreadable", () => {
  // A layout stored under SOME map we cannot name: any answer about one particular map would be a
  // guess, so the list as a whole is not trusted.
  assert.equal(parseStoredLayoutsStrict({ Entries: [{ MapId: "WDEV_A", Sectors: [0, 0, 0, 0, 0] }, { Sectors: [1, 1, 1, 1, 1] }] }), null);
  assert.equal(parseStoredLayoutsStrict({ Entries: [{ MapId: "  ", Sectors: [1, 1, 1, 1, 1] }] }), null);
  assert.equal(parseStoredLayoutsStrict({ Entries: [null] }), null);
  assert.equal(parseStoredLayoutsStrict({ Entries: ["WDEV_A"] }), null);
});

test("strict layouts: sectors are kept raw — the consumer validates the entry it cares about", () => {
  const [entry] = parseStoredLayoutsStrict({ Entries: [{ MapId: "WDEV_B", Sectors: [0, 1.5, "2", "x", null, 7] }] })!;
  assert.equal(entry!.mapId, "WDEV_B");
  // Numbers as given (no truncation, no clamping), numeric strings read as numbers, anything else
  // NaN — never 0, which would be "option 1", a layout nobody stored.
  assert.deepEqual(entry!.sectors.slice(0, 3), [0, 1.5, 2]);
  assert.ok(Number.isNaN(entry!.sectors[3]!), "non-numeric → NaN");
  assert.ok(Number.isNaN(entry!.sectors[4]!), "null → NaN, not 0");
  assert.equal(entry!.sectors[5], 7, "out-of-range values survive for the consumer to refuse");
  // A named entry with no readable sector list is PRESENT but invalid, not absent.
  assert.deepEqual(parseStoredLayoutsStrict({ Entries: [{ MapId: "WDEV_C" }] }), [{ mapId: "WDEV_C", sectors: [] }]);
});
