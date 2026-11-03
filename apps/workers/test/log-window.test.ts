/**
 * How far back an ingest poll reads the game's log (log-window.ts): back to when the previous read
 * was sent, plus 5 seconds, so a pass that ran long reads further back instead of leaving lines
 * nothing ever reads. Never shorter than the old constant, never longer than a reconnect's re-read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { logBacktrackSec } from "../dist/log-window.js";

test("a long pass reads back to the previous read, so no line between the two is skipped", () => {
  assert.equal(logBacktrackSec(9_000, 10_000, 600), 15, "never shorter than the poll interval plus 5 seconds");
  assert.equal(logBacktrackSec(10_300, 10_000, 600), 16, "a normal pass: its own length plus the slack");
  assert.equal(logBacktrackSec(24_600, 10_000, 600), 30, "a pass stalled by a slow read: the whole 24.6 seconds, plus the slack");
  assert.equal(logBacktrackSec(7_200_000, 10_000, 600), 600, "never more than a reconnect's own re-read");
  // Every gap is covered, up to the cap.
  for (const gapMs of [0, 1, 999, 1_000, 14_999, 15_000, 15_001, 59_500, 594_000]) {
    assert.ok(logBacktrackSec(gapMs, 10_000, 600) * 1000 >= gapMs + 5_000, `a ${gapMs} ms gap is read with its slack`);
  }
});
