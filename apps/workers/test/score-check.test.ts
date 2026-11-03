/**
 * The score checked every 2 seconds between ingest polls (score-check.ts), as CRCON's loop checks
 * it (rcon/logs/loop.py run(loop_frequency_secs=2), v12.3.0): a cap flip is stamped within 2
 * seconds of the change, not within a 10-second poll. The check records a running round's
 * timeline only; filing a start and closing an end stay the poll's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORE_CHECK_MS, scoreCheck, waitCheckingScore, type ScoreCheckIO } from "../dist/score-check.js";
import type { RoundRecord } from "../dist/crcon-round.js";

/** A clock the waits move: sleeping advances it, and so does a check that takes time. */
const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
};

test("between polls the score is checked every 2 seconds, and the poll still comes on time", async () => {
  assert.equal(SCORE_CHECK_MS, 2_000, "CRCON's loop_frequency_secs");
  const c = fakeClock();
  const checks: number[] = [];
  await waitCheckingScore({ untilMs: 10_000, stepMs: SCORE_CHECK_MS, now: c.now, sleep: c.sleep, stopped: () => false, check: async () => { checks.push(c.now()); } });
  assert.deepEqual(checks, [2_000, 4_000, 6_000, 8_000], "four checks inside a 10-second poll; the poll's own pass is the fifth");
  assert.equal(c.now(), 10_000, "and the poll is due when it was due");

  // A check that takes time does not push the poll back.
  const slow = fakeClock();
  const slowChecks: number[] = [];
  await waitCheckingScore({ untilMs: 10_000, stepMs: 2_000, now: slow.now, sleep: slow.sleep, stopped: () => false, check: async () => { slowChecks.push(slow.now()); slow.advance(300); } });
  assert.deepEqual(slowChecks, [2_000, 4_300, 6_600, 8_900]);
  assert.equal(slow.now(), 10_000);

  // A poll shorter than one step has no check in it.
  const short = fakeClock();
  let shortChecks = 0;
  await waitCheckingScore({ untilMs: 1_500, stepMs: 2_000, now: short.now, sleep: short.sleep, stopped: () => false, check: async () => { shortChecks++; } });
  assert.equal(shortChecks, 0);
  assert.equal(short.now(), 1_500);

  // A runner told to stop stops checking.
  const stop = fakeClock();
  const stopChecks: number[] = [];
  await waitCheckingScore({ untilMs: 10_000, stepMs: 2_000, now: stop.now, sleep: stop.sleep, stopped: () => stopChecks.length >= 2, check: async () => { stopChecks.push(stop.now()); } });
  assert.deepEqual(stopChecks, [2_000, 4_000]);
});

const START = "2026-10-12T20:00:00.000Z";
const startMs = Date.parse(START);
const round = (over: Partial<RoundRecord> = {}): RoundRecord & { id: string } => ({
  id: "r1", map: "CARENTAN Warfare", startedAt: START, endedAt: null, result: null, crconMap: "carentan_warfare", crconEndDeferred: null,
  capFlips: [[1, 2, 2]], moraleHistory: [], matchTime: 5400, crconInitialMorale: 0, ...over,
});
const live = { mapId: "carentan_warfare", gameMode: "Warfare", remainingMatchTime: 5000, matchTime: 5400, alliedScore: 2, axisScore: 2, initialMorale: 0 };

/** The IO a check sees, recording what it read and wrote. */
const io = (r: (RoundRecord & { id: string }) | null, session: Record<string, unknown>, atMs: number) => {
  const seen = { sessionReads: 0, writes: [] as { roundId: string; step: unknown }[] };
  const port: ScoreCheckIO = {
    newestRound: async () => r,
    readSession: async () => { seen.sessionReads++; return session; },
    recordTimeline: async (roundId, step) => { seen.writes.push({ roundId, step }); },
    now: () => atMs,
  };
  return { port, seen };
};

test("a score check stamps a flip at its own second, the way CRCON's 2-second loop does", async () => {
  const { port, seen } = io(round(), { ...live, axisScore: 3 }, startMs + 349_000);
  assert.equal(await scoreCheck(port, "hll", 347), 349);
  assert.deepEqual(seen.writes, [{ roundId: "r1", step: { elapsed: 349, recorded: true, flip: [349, 2, 3] } }]);

  // The same score again records nothing new, and writes nothing.
  const quiet = io(round({ capFlips: [[1, 2, 2], [349, 2, 3]] }), { ...live, axisScore: 3 }, startMs + 351_000);
  assert.equal(await scoreCheck(quiet.port, "hll", 349), 351);
  assert.deepEqual(quiet.seen.writes, []);
});

test("a round being filed or closed is left to the poll, and costs the check no session read", async () => {
  for (const [why, r] of [
    ["no round yet", null],
    ["not yet filed under a layer", round({ crconMap: null })],
    ["its end stands", round({ endedAt: "2026-10-12T21:00:00.000Z", result: "`CARENTAN Warfare` ALLIED (3 - 2) AXIS", crconEndDeferred: false })],
    ["its end not yet judged", round({ endedAt: "2026-10-12T21:00:00.000Z", result: "`CARENTAN Warfare` ALLIED (3 - 2) AXIS" })],
  ] as const) {
    const { port, seen } = io(r, { ...live, axisScore: 3 }, startMs + 400_000);
    assert.equal(await scoreCheck(port, "hll", 390), 390, `${why}: the elapsed time stands`);
    assert.equal(seen.sessionReads, 0, `${why}: no read`);
    assert.deepEqual(seen.writes, [], `${why}: no write`);
  }
  // A whistle CRCON defers keeps the round recording as if it ran on.
  const deferred = io(round({ endedAt: "2026-10-12T20:05:00.000Z", result: "`FOY Warfare` ALLIED (3 - 2) AXIS", crconEndDeferred: true }), { ...live, axisScore: 3 }, startMs + 400_000);
  assert.equal(await scoreCheck(deferred.port, "hll", 398), 400);
  assert.deepEqual(deferred.seen.writes, [{ roundId: "r1", step: { elapsed: 400, recorded: true, flip: [400, 2, 3] } }]);
});
