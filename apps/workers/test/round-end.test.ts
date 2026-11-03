/**
 * CRCON's record of a round's end, against its own source (rcon/hooks.py record_map_end, v12.3.0).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordRoundEnd } from "../src/round-end.ts";

const END = Date.UTC(2026, 9, 12, 21, 0, 0);
const WHISTLE = "`CARENTAN Warfare` ALLIED (2 - 3) AXIS";

test("a whistle read at once stands when the live layer is on the map the line names", () => {
  assert.deepEqual(recordRoundEnd(WHISTLE, "hll", END, END + 5_000, { mapId: "carentan_warfare_night" }), { deferred: false }, "the same map, whatever its layer");
});

test("a whistle read at once naming another map, or no map CRCON can read, leaves the end to the next start", () => {
  assert.deepEqual(recordRoundEnd(WHISTLE, "hll", END, END + 5_000, { mapId: "foy_warfare" }), { deferred: true });
  assert.deepEqual(recordRoundEnd("CARENTAN Warfare ALLIED (2 - 3) AXIS", "hll", END, END + 5_000, { mapId: "carentan_warfare" }), { deferred: true }, "no backticks: CRCON's pattern reads no map from it");
});

test("a whistle read a minute or more late stands whatever is live", () => {
  assert.deepEqual(recordRoundEnd(WHISTLE, "hll", END, END + 60_000, { mapId: "foy_warfare" }), { deferred: false });
  assert.equal(recordRoundEnd(WHISTLE, "hll", END, END + 59_999, { mapId: "foy_warfare" }).deferred, true, "under a minute is still read at once");
});
