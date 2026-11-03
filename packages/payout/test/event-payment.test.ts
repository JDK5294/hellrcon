/**
 * Whether an event has been paid — the events list's Payment column.
 *
 * The answer comes from the runs made for the event, and the cases that matter are the ones where a
 * first look at the payout would say the wrong thing: a run that failed some people and was retried
 * to the end is paid; one whose retry failed again is still owed; a rehearsal pays nobody.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventPayments, type EventPayoutRun } from "../dist/index.js";

let clock = 0;
const at = (n: number) => new Date(Date.parse("2026-09-04T22:00:00.000Z") + n * 60_000).toISOString();
/** A finished run, a minute after the one before it unless told otherwise. */
function run(id: string, o: Partial<EventPayoutRun> & { eventId?: string; retries?: string; head?: string } = {}): EventPayoutRun {
  const start = o.createdAt ?? at(++clock);
  const sourceRef: Record<string, unknown> = o.retries
    ? { type: "retry", jobId: o.retries, ...(o.head ? { rootJobId: o.head } : {}) }
    : { type: "event", eventId: o.eventId ?? "ev1" };
  return {
    id, sourceType: o.retries ? "retry" : "event", sourceRef, dryRun: o.dryRun ?? false,
    status: o.status ?? "COMPLETE", createdAt: start,
    completedAt: o.status === "RUNNING" ? null : o.completedAt ?? start, failedCount: o.failedCount ?? 0,
  };
}

test("a payout that reached everyone is paid, as of when it finished", () => {
  const r = eventPayments([run("j1", { completedAt: "2026-09-04T23:30:00.000Z" })]);
  assert.deepEqual(r.get("ev1"), { state: "paid", unpaid: 0, at: "2026-09-04T23:30:00.000Z" });
});

test("an event nobody has paid has no entry: the list reads that as awaiting payment", () => {
  const r = eventPayments([run("j1", { eventId: "ev1" })]);
  assert.equal(r.get("ev2"), undefined);
  assert.equal(r.size, 1);
});

test("a dry run pays nobody: it neither pays an event nor leaves anyone owed", () => {
  const r = eventPayments([run("j1", { dryRun: true }), run("j2", { eventId: "ev2", dryRun: true, failedCount: 3, status: "COMPLETE_WITH_FAILURES" })]);
  assert.equal(r.size, 0);
});

test("failures are owed until a retry reaches them, then the payout is paid", () => {
  const first = run("j1", { status: "COMPLETE_WITH_FAILURES", failedCount: 3 });
  assert.deepEqual(eventPayments([first]).get("ev1")?.state, "part");
  assert.equal(eventPayments([first]).get("ev1")?.unpaid, 3);

  // The retry failed one of the three again: one is still owed, not three, and not none.
  const retry = run("j2", { retries: "j1", head: "j1", status: "COMPLETE_WITH_FAILURES", failedCount: 1 });
  assert.deepEqual(eventPayments([first, retry]).get("ev1"), { state: "part", unpaid: 1, at: retry.completedAt });

  // And the retry of the retry reached the last one.
  const last = run("j3", { retries: "j2", head: "j1" });
  assert.deepEqual(eventPayments([first, retry, last]).get("ev1"), { state: "paid", unpaid: 0, at: last.completedAt });
});

test("a run cut off part-way owes its unreached until 'Pay the rest' runs", () => {
  const cut = run("j1", { status: "INTERRUPTED", failedCount: 12 });
  assert.deepEqual(eventPayments([cut]).get("ev1")?.state, "part");
  assert.equal(eventPayments([cut]).get("ev1")?.unpaid, 12);
  assert.equal(eventPayments([cut, run("j2", { retries: "j1", head: "j1" })]).get("ev1")?.state, "paid");
  // Cut off after its last receipt was written: nobody was left, so nothing is owed.
  assert.equal(eventPayments([run("j9", { eventId: "ev9", status: "INTERRUPTED", failedCount: 0 })]).get("ev9")?.state, "paid");
});

test("retries from before rootJobId was recorded are followed run by run", () => {
  const r = eventPayments([
    run("j1", { status: "COMPLETE_WITH_FAILURES", failedCount: 2 }),
    run("j2", { retries: "j1", status: "COMPLETE_WITH_FAILURES", failedCount: 1 }),
    run("j3", { retries: "j2" }),
  ]);
  assert.equal(r.get("ev1")?.state, "paid", "j3 paid the last one, two links down from the event payout");
});

test("a run in progress makes the event paying, as of when it started", () => {
  const first = run("j1", { status: "COMPLETE_WITH_FAILURES", failedCount: 2 });
  const live = run("j2", { retries: "j1", head: "j1", status: "RUNNING" });
  const r = eventPayments([first, live]);
  assert.deepEqual(r.get("ev1"), { state: "paying", unpaid: 0, at: live.createdAt });
});

test("two payouts for one event — points and VIP — are both counted", () => {
  const points = run("p1");
  const vip = run("v1", { status: "COMPLETE_WITH_FAILURES", failedCount: 2 });
  assert.deepEqual(eventPayments([points, vip]).get("ev1"), { state: "part", unpaid: 2, at: vip.completedAt },
    "points reaching everyone does not hide the VIP still owed");
  const vipRetry = run("v2", { retries: "v1", head: "v1" });
  assert.deepEqual(eventPayments([points, vip, vipRetry]).get("ev1"), { state: "paid", unpaid: 0, at: vipRetry.completedAt });
});

test("each event is answered on its own, and runs of other payouts are ignored", () => {
  const r = eventPayments([
    run("a1", { eventId: "evA" }),
    run("b1", { eventId: "evB", status: "COMPLETE_WITH_FAILURES", failedCount: 4 }),
    // A retry whose chain leads to no event payout (an online payout's, say) belongs to no event.
    run("x2", { retries: "x1" }),
  ]);
  assert.equal(r.get("evA")?.state, "paid");
  assert.equal(r.get("evB")?.unpaid, 4);
  assert.equal(r.size, 2);
});

test("a loop in the data cannot hang the list", () => {
  const r = eventPayments([run("r1", { retries: "r2" }), run("r2", { retries: "r1" })]);
  assert.equal(r.size, 0);
});
