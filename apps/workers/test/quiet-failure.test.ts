/**
 * The rule that decides whether a repeating job's failure is worth saying out loud.
 *
 * The bug it exists to prevent: every one of these catches logged at `debug` while the default
 * level is `info`, so a job could stop working forever in silence. The bug it must not CAUSE:
 * a 60-second tick warning on every pass, which buries the logs that matter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { QuietFailures, forDuration } from "../dist/quiet-failure.js";

test("the first failure speaks, the ones right behind it do not", () => {
  const q = new QuietFailures(15 * 60_000);
  const first = q.fail("stats:s1", 0);
  assert.equal(first.speak, true, "a job that just broke is news");
  assert.equal(first.runs, 1);

  // A minute of ticks after that is the same news, and saying it sixty times is how a log stops
  // being read at all.
  for (let t = 60_000; t <= 10 * 60_000; t += 60_000) {
    assert.equal(q.fail("stats:s1", t).speak, false, `tick at ${t}ms should stay quiet`);
  }
});

test("a failure that persists is repeated, rarely, and says how long", () => {
  const q = new QuietFailures(15 * 60_000);
  q.fail("stats:s1", 0);
  const later = q.fail("stats:s1", 15 * 60_000);
  assert.equal(later.speak, true, "still broken a quarter of an hour on — say so again");
  assert.equal(later.runs, 2);
  assert.equal(later.sinceMs, 15 * 60_000);
  // ...and then goes quiet again until the next interval.
  assert.equal(q.fail("stats:s1", 16 * 60_000).speak, false);
  assert.equal(q.fail("stats:s1", 30 * 60_000).speak, true);
});

test("recovery is reported, so a warning is never left standing without an answer", () => {
  const q = new QuietFailures();
  q.fail("board:s1", 0);
  q.fail("board:s1", 60_000);
  const back = q.ok("board:s1", 120_000);
  assert.equal(back.recovered, true);
  assert.equal(back.runs, 2, "how bad it got");
  assert.equal(back.sinceMs, 120_000, "how long it lasted");

  // The run is cleared, so the next failure is news again rather than a continuation.
  assert.equal(q.fail("board:s1", 180_000).speak, true);
});

test("a success with nothing behind it is not a recovery", () => {
  const q = new QuietFailures();
  assert.deepEqual(q.ok("board:s1"), { recovered: false, runs: 0, sinceMs: 0 });
});

test("keys are independent, so one server's broken job never silences another's", () => {
  const q = new QuietFailures(15 * 60_000);
  assert.equal(q.fail("stats:s1", 0).speak, true);
  // Same job, different server: its first failure is its own news, not a repeat of s1's.
  assert.equal(q.fail("stats:s2", 0).speak, true);
  assert.equal(q.fail("stats:s1", 1000).speak, false);
  q.ok("stats:s1", 2000);
  // Clearing s1 leaves s2's run intact.
  assert.equal(q.fail("stats:s2", 2000).speak, false);
  assert.equal(q.fail("stats:s2", 2000).runs, 3);
});

test("durations read the way someone scanning a log needs them to", () => {
  assert.equal(forDuration(0), "for 0s");
  assert.equal(forDuration(40_000), "for 40s");
  assert.equal(forDuration(5 * 60_000), "for 5m");
  assert.equal(forDuration(125 * 60_000), "for 2h 5m");
});
