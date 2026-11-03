/**
 * One pass of CRCON's map recorder over the newest round (rcon/logs/loop.py update_maps_history
 * with the match start and end hooks, v12.3.0): the start decided once, the timeline recorded
 * while the round runs, one more pass when its end is first seen, and none after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crconRoundPass, type RoundRecord } from "../dist/crcon-round.js";

const START = "2026-10-12T20:00:00.000Z";
const startMs = Date.parse(START);
const round = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  map: "CARENTAN Warfare", startedAt: START, endedAt: null, result: null, crconMap: null, crconEndDeferred: null,
  capFlips: [], moraleHistory: [], matchTime: 0, crconInitialMorale: null, ...over,
});
const live = { mapId: "carentan_warfare", gameMode: "Warfare", remainingMatchTime: 5000, matchTime: 5400, alliedScore: 2, axisScore: 2, initialMorale: 0 };

test("a new round is filed, then recorded in the same pass", () => {
  const pass = crconRoundPass(round(), "hll", startMs + 30_000, live, 0);
  assert.deepEqual(pass.start, { map: "carentan_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
  assert.deepEqual(pass.step, { elapsed: 30, recorded: true, flip: [30, 2, 2] }, "match_time came with the start, so the recorder leaves it");
  assert.equal(pass.end, undefined);
  assert.equal(pass.elapsed, 30);
});

test("a whistle that stands gets one more recording pass, then none", () => {
  const ended = round({ crconMap: "carentan_warfare", matchTime: 5400, capFlips: [[30, 2, 2]], endedAt: "2026-10-12T21:00:00.000Z", result: "`CARENTAN Warfare` ALLIED (3 - 2) AXIS" });
  const endMs = Date.parse(ended.endedAt!);
  const pass = crconRoundPass(ended, "hll", endMs + 5_000, { ...live, alliedScore: 3 }, 3590);
  assert.deepEqual(pass.end, { deferred: false });
  assert.deepEqual(pass.step, { elapsed: 3605, recorded: true, flip: [3605, 3, 2] }, "the final score, caught on the pass after the whistle");
  const after = crconRoundPass({ ...ended, crconEndDeferred: false, capFlips: [[30, 2, 2], [3605, 3, 2]] }, "hll", endMs + 15_000, { ...live, alliedScore: 3 }, pass.elapsed);
  assert.deepEqual(after, { elapsed: 3600 }, "an ended round is left alone, its length carried as the elapsed time");
});

test("a whistle CRCON defers keeps the round recording as if it ran on", () => {
  const ended = round({ crconMap: "carentan_warfare", matchTime: 5400, capFlips: [[30, 2, 2]], endedAt: "2026-10-12T21:00:00.000Z", result: "`FOY Warfare` ALLIED (3 - 2) AXIS" });
  const endMs = Date.parse(ended.endedAt!);
  const pass = crconRoundPass(ended, "hll", endMs + 5_000, { ...live, alliedScore: 3 }, 3590);
  assert.deepEqual(pass.end, { deferred: true }, "the line names FOY while CARENTAN is live");
  assert.deepEqual(pass.step, { elapsed: 3605, recorded: true, flip: [3605, 3, 2] });
  const next = crconRoundPass({ ...ended, crconEndDeferred: true, capFlips: [[30, 2, 2], [3605, 3, 2]] }, "hll", endMs + 15_000, { ...live, alliedScore: 3 }, pass.elapsed);
  assert.deepEqual(next, { elapsed: 3615, step: { elapsed: 3615, recorded: true } }, "still recorded, and nothing new to record");
});

test("a round closed without a whistle is not recorded again", () => {
  const superseded = round({ crconMap: "carentan_warfare", endedAt: "2026-10-12T20:30:00.000Z" });
  assert.deepEqual(crconRoundPass(superseded, "hll", startMs + 2_000_000, live, 0), { elapsed: 1800 });
});
