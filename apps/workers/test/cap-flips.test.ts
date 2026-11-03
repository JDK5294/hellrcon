/**
 * The score-timeline recorder against CRCON's own (rcon/logs/loop.py, v12.3.0): its gates, its
 * flips, its two skips, Conquest morale, and match_time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordTimelineStep, type TimelineState } from "../src/cap-flips.ts";

const fresh = (over: Partial<TimelineState> = {}): TimelineState => ({ capFlips: [], moraleHistory: [], matchTime: 0, initialMorale: null, prevElapsed: 0, ...over });
const START = 1_760_000_000;

test("nothing is recorded while the live map or mode is not the round's, or before the clock runs", () => {
  const live = { mapId: "carentan_warfare", gameMode: "Warfare", remainingMatchTime: 5000, matchTime: 5400, alliedScore: 2, axisScore: 2 };
  assert.deepEqual(recordTimelineStep("foy_warfare", "hll", START, START + 60, live, fresh()), { elapsed: 0 }, "another map is live");
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 60, { ...live, gameMode: "Offensive" }, fresh()), { elapsed: 0 }, "another mode is live");
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 60, { ...live, remainingMatchTime: 0 }, fresh()), { elapsed: 0 }, "the clock has not started");
  // Once a pass has recorded, a 0 on the clock is overtime, not "not started".
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 60, { ...live, remainingMatchTime: 0 }, fresh({ prevElapsed: 50, matchTime: 5400, capFlips: [[10, 2, 2]] })), { elapsed: 60, recorded: true });
});

test("a flip is the score when it changes, at seconds since the start; match_time is set once", () => {
  const live = { mapId: "carentan_warfare", gameMode: "Warfare", remainingMatchTime: 5000, matchTime: 5400, alliedScore: 2, axisScore: 2 };
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 30, live, fresh()), { elapsed: 30, recorded: true, matchTime: 5400, flip: [30, 2, 2] });
  const state = fresh({ capFlips: [[30, 2, 2]], matchTime: 5400, prevElapsed: 30 });
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 40, live, state), { elapsed: 40, recorded: true }, "no change, no flip");
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 50, { ...live, alliedScore: 3, axisScore: 2 }, state), { elapsed: 50, recorded: true, flip: [50, 3, 2] });
  // Warfare's opening 2-2 after there are flips is a new match's score leaking in: not recorded.
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 60, live, fresh({ capFlips: [[30, 2, 2], [50, 3, 2]], matchTime: 5400, prevElapsed: 50 })), { elapsed: 60, recorded: true });
});

test("an Offensive's timer is one objective's, and a reset to its opening line is not a flip", () => {
  const live = { mapId: "carentan_offensive_us", gameMode: "Offensive", remainingMatchTime: 1700, matchTime: 5400, alliedScore: 0, axisScore: 5 };
  assert.equal(recordTimelineStep("carentan_offensive_us", "hll", START, START + 30, live, fresh()).matchTime, 9000, "the untouched 90 minutes means 30, five times over");
  const state = fresh({ capFlips: [[30, 0, 5], [400, 1, 4]], matchTime: 9000, prevElapsed: 400 });
  assert.deepEqual(recordTimelineStep("carentan_offensive_us", "hll", START, START + 500, live, state), { elapsed: 500, recorded: true }, "back to 0-5 with US attacking: a reset, ignored");
});

test("Conquest samples morale with each flip and takes initial_morale from the first", () => {
  const live = { mapId: "CAR_L_1944_Conquest_Day", gameMode: "Conquest", remainingMatchTime: 3000, matchTime: 3600, alliedScore: 1, axisScore: 0, initialMorale: 500, alliedMorale: 480, axisMorale: 455 };
  assert.deepEqual(recordTimelineStep("CAR_L_1944_Conquest_Day", "hll", START, START + 90, live, fresh()), {
    elapsed: 90, recorded: true, matchTime: 3600, flip: [90, 1, 0], initialMorale: 500, morale: [90, 480, 455],
  });
});

test("Vietnam's attacker-prefixed mode reads as its last word", () => {
  const live = { mapId: "wdeve_offensivenva_day", gameMode: "NVA Offensive", remainingMatchTime: 1700, matchTime: 1800, alliedScore: 5, axisScore: 0 };
  assert.deepEqual(recordTimelineStep("wdeve_offensivenva_day", "hllv", START, START + 20, live, fresh()), { elapsed: 20, recorded: true, matchTime: 9000, flip: [20, 5, 0] });
});

test("the live layer is compared as get_gamestate parses it, against the id the round is filed under", () => {
  const live = { mapId: "CARENTAN_WARFARE", gameMode: "Warfare", remainingMatchTime: 5000, matchTime: 5400, alliedScore: 2, axisScore: 2 };
  assert.deepEqual(recordTimelineStep("carentan_warfare", "hll", START, START + 30, live, fresh()), { elapsed: 30, recorded: true, matchTime: 5400, flip: [30, 2, 2] }, "the catalogue's spelling of the live id");
  assert.deepEqual(recordTimelineStep("CARENTAN Warfare", "hll", START, START + 30, live, fresh()), { elapsed: 0 }, "log text is never a layer id");
});
