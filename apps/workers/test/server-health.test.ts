/**
 * The dark/recovered latch — the state machine behind the "server unreachable" alert, driven
 * without a socket. What it must get right: one blip is not an outage, one outage is one alert,
 * recovery fires only after a real dark report, and a cold start against a down server stays quiet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshHealth, onPollOk, onPollFail } from "../dist/server-health.js";

const MIN = 60_000;
const THRESH = 3 * MIN;

test("a brief blip under the threshold never alerts", () => {
  let h = onPollOk(freshHealth(), 0).state; // first good read establishes the clock
  // Fails, but recovers well before the threshold — nothing said either way.
  let r = onPollFail(h, MIN, THRESH); h = r.state;
  assert.equal(r.emit, null);
  r = onPollOk(h, 2 * MIN);
  assert.equal(r.emit, null, "recovery only follows a DARK report, not sub-threshold flakiness");
});

test("one sustained outage is one dark alert, then one recovery — honest minutes each way", () => {
  let h = onPollOk(freshHealth(), 0).state;

  // Still within tolerance at 2 min.
  let r = onPollFail(h, 2 * MIN, THRESH); h = r.state;
  assert.equal(r.emit, null);

  // Past the threshold: dark, measured from the last good read.
  r = onPollFail(h, 4 * MIN, THRESH); h = r.state;
  assert.deepEqual(r.emit, { kind: "dark", downMinutes: 4 });

  // Every further failure is silent — the alert has latched.
  r = onPollFail(h, 9 * MIN, THRESH); h = r.state;
  assert.equal(r.emit, null, "no repeat dark alerts while it stays down");

  // First success after the dark report: recovery, with total downtime.
  r = onPollOk(h, 10 * MIN); h = r.state;
  assert.deepEqual(r.emit, { kind: "recovered", downMinutes: 10 });

  // And the machine is armed again for the next outage.
  r = onPollFail(h, 10 * MIN + THRESH + 1, THRESH);
  assert.equal(r.emit?.kind, "dark");
});

test("a server that has NEVER answered since startup is left alone", () => {
  const h = freshHealth();
  // No onPollOk ever — cold start against a down or misconfigured server.
  const r = onPollFail(h, 60 * MIN, THRESH);
  assert.equal(r.emit, null, "no last-good clock to measure from — a config problem, not an outage");
  assert.equal(r.state.reportedDark, false);
});
