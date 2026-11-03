/**
 * The expiration math behind every VIP and console-admin grant.
 *
 * The incident this comes from: a member with PERMANENT VIP bought 30 days of VIP with shop points,
 * and their permanent grant became one expiring a month later. They paid to have their VIP taken
 * away, and the audit trail recorded it as an ordinary grant, so nothing looked wrong anywhere.
 *
 * The cause was a signature, not a formula. The function was handed `existing?.expiration ?? null`,
 * and a permanent grant carries `expiration: null` — the same value as no grant at all. Given only
 * that, "forever" and "nothing" are indistinguishable, and it treated the first as the second. It
 * now takes the ROW, so the two facts stay two facts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGrantExpiration } from "../dist/routes/kit.js";

const DAY = 86_400_000;
/** Days from now, for readable assertions on an ISO result. */
const daysOut = (iso: string) => (Date.parse(iso) - Date.now()) / DAY;

test("stacking days onto a permanent grant leaves it permanent", async () => {
  const permanent = { expiration: null };
  assert.equal(
    computeGrantExpiration({ mode: "duration", days: 30, cumulative: true }, permanent),
    null,
    "the shop's exact call — 30 days onto forever is still forever",
  );
  // Hours, and days+hours together, go the same way: it is the stacking that decides, not the unit.
  assert.equal(computeGrantExpiration({ mode: "duration", hours: 12, cumulative: true }, permanent), null);
  assert.equal(computeGrantExpiration({ mode: "duration", days: 7, hours: 6, cumulative: true }, permanent), null);
});

test("no grant at all is not a permanent grant — days start from now", async () => {
  // Same `null` expiration reaches the old code path; the difference is that there is no row.
  for (const nothing of [null, undefined]) {
    const iso = computeGrantExpiration({ mode: "duration", days: 30, cumulative: true }, nothing);
    assert.ok(iso, "a member with no VIP gets a real expiry");
    assert.ok(Math.abs(daysOut(iso!) - 30) < 0.01, `~30 days out (got ${daysOut(iso!).toFixed(3)})`);
  }
});

test("stacking onto a live expiry still stacks; a lapsed one restarts from now", async () => {
  const inTenDays = new Date(Date.now() + 10 * DAY).toISOString();
  const stacked = computeGrantExpiration({ mode: "duration", days: 30, cumulative: true }, { expiration: inTenDays })!;
  assert.ok(Math.abs(daysOut(stacked) - 40) < 0.01, `10 + 30 = 40 days (got ${daysOut(stacked).toFixed(3)})`);

  // An expiry already in the past is spent time, not credit: it must not push the new grant back.
  const lapsed = new Date(Date.now() - 5 * DAY).toISOString();
  const fresh = computeGrantExpiration({ mode: "duration", days: 30, cumulative: true }, { expiration: lapsed })!;
  assert.ok(Math.abs(daysOut(fresh) - 30) < 0.01, `~30 days out (got ${daysOut(fresh).toFixed(3)})`);
});

test("clearing the stack box is a deliberate replacement, and may replace permanent", async () => {
  // "Stack onto existing time" unticked means staff chose to SET the grant, not extend it. Turning
  // permanent into a fixed date is a downgrade they asked for out loud, so it is honoured — the
  // rule above guards the stacking case, which is the one that silently destroys a grant.
  const set = computeGrantExpiration({ mode: "duration", days: 30, cumulative: false }, { expiration: null })!;
  assert.ok(Math.abs(daysOut(set) - 30) < 0.01, `~30 days out (got ${daysOut(set).toFixed(3)})`);
  // As does an explicit 'permanent', from any starting point.
  assert.equal(computeGrantExpiration({ mode: "permanent" }, { expiration: new Date(Date.now() + DAY).toISOString() }), null);
});

test("'until' ignores what came before — the date given is the date set", async () => {
  const when = new Date(Date.now() + 3 * DAY).toISOString();
  assert.equal(computeGrantExpiration({ mode: "until", expiresAt: when }, { expiration: null }), when);
  assert.equal(computeGrantExpiration({ mode: "until", expiresAt: when }, null), when);
});

test("the refusals still refuse", async () => {
  assert.throws(() => computeGrantExpiration({ mode: "duration", days: 0, cumulative: true }, null), /positive days\/hours/);
  assert.throws(() => computeGrantExpiration({ mode: "duration", days: 40_000, cumulative: true }, null), /at most 100 years/);
  assert.throws(() => computeGrantExpiration({ mode: "until", expiresAt: "not a date" }, null), /valid expiresAt/);
  assert.throws(() => computeGrantExpiration({ mode: "until", expiresAt: new Date(Date.now() - DAY).toISOString() }, null), /in the past/);
  assert.throws(() => computeGrantExpiration({ mode: "nonsense" }, null), /unknown expiration mode/);
  // A zero-day grant is refused BEFORE the permanent rule is reached: a bad request stays a bad
  // request rather than being answered "permanent" because of who the target happens to be.
  assert.throws(() => computeGrantExpiration({ mode: "duration", days: 0, cumulative: true }, { expiration: null }), /positive days\/hours/);
});
