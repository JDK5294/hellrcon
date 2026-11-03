import { test } from "node:test";
import assert from "node:assert/strict";
import { latestOccurrence, recurrenceError, describeRecurrence, zonedTimeToInstant, type Recurrence } from "../dist/index.js";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));
const monthly = (monthDay: number, time = "00:00"): Recurrence => ({ repeat: "monthly", monthDay, time });

test("monthly: the latest 1st at or before now — and this month's only once it has arrived; the month is its identity", () => {
  const r = monthly(1, "00:00");
  assert.deepEqual(latestOccurrence(r, utc(2026, 10, 7, 12), "UTC"), { key: "2026-10", at: utc(2026, 10, 1) });
  assert.equal(latestOccurrence(r, utc(2026, 10, 1, 0, 0), "UTC")!.key, "2026-10", "at the minute itself");
  assert.equal(latestOccurrence(monthly(1, "06:00"), utc(2026, 10, 1, 5, 59), "UTC")!.key, "2026-09", "not yet today: last month's");
});

test("monthly on the 31st means the last day of shorter months", () => {
  assert.deepEqual(latestOccurrence(monthly(31), utc(2026, 3, 5), "UTC")!.at, utc(2026, 2, 28));
  assert.deepEqual(latestOccurrence(monthly(31), utc(2028, 3, 5), "UTC")!.at, utc(2028, 2, 29), "leap year");
  assert.deepEqual(latestOccurrence(monthly(31), utc(2026, 5, 5), "UTC")!.at, utc(2026, 4, 30));
  assert.deepEqual(latestOccurrence(monthly(30), utc(2026, 8, 5), "UTC")!.at, utc(2026, 7, 30), "30 stays the 30th in a 31-day month");
});

test("read in the community's zone: midnight in New York is 04:00/05:00 UTC", () => {
  const r = monthly(1, "00:00");
  // 2026-10-01 00:00 New York (EDT, UTC-4) = 04:00 UTC.
  assert.deepEqual(latestOccurrence(r, utc(2026, 10, 1, 4, 0), "America/New_York"), { key: "2026-10", at: utc(2026, 10, 1, 4, 0) });
  assert.equal(latestOccurrence(r, utc(2026, 10, 1, 3, 59), "America/New_York")!.key, "2026-09", "still September 30th in New York");
  // Winter: EST, UTC-5.
  assert.deepEqual(latestOccurrence(r, utc(2026, 12, 1, 6), "America/New_York")!.at, utc(2026, 12, 1, 5));
});

test("DST: wall times convert on the change days, and a skipped minute lands on a real instant", () => {
  // 2026-03-08 is the US spring-forward day; 12:00 EDT = 16:00 UTC.
  assert.deepEqual(zonedTimeToInstant(2026, 3, 8, 12 * 60, "America/New_York"), utc(2026, 3, 8, 16));
  // 2026-11-01 fall-back day; 12:00 EST = 17:00 UTC.
  assert.deepEqual(zonedTimeToInstant(2026, 11, 1, 12 * 60, "America/New_York"), utc(2026, 11, 1, 17));
  const gap = zonedTimeToInstant(2026, 3, 8, 2 * 60 + 30, "America/New_York");
  assert.ok(Number.isFinite(gap.getTime()));
});

test("weekly: the most recent of the chosen days", () => {
  const r: Recurrence = { repeat: "weekly", weekdays: ["sat", "sun"], time: "20:00" };
  // 2026-10-07 is a Wednesday; the last weekend moment was Sunday the 4th at 20:00.
  assert.equal(latestOccurrence(r, utc(2026, 10, 7, 12), "UTC")!.key, "2026-10-04");
  assert.equal(latestOccurrence(r, utc(2026, 10, 10, 19, 59), "UTC")!.key, "2026-10-04", "Saturday, before the time");
  assert.equal(latestOccurrence(r, utc(2026, 10, 10, 20), "UTC")!.key, "2026-10-10");
  assert.equal(latestOccurrence({ repeat: "weekly", weekdays: [], time: "20:00" }, utc(2026, 10, 7), "UTC"), null);
});

test("nth weekday: the first Saturday, and the last Friday", () => {
  const first: Recurrence = { repeat: "nth", nth: 1, nthWeekday: "sat", time: "18:00" };
  // October 2026: the 1st is a Thursday, so the first Saturday is the 3rd.
  assert.deepEqual(latestOccurrence(first, utc(2026, 10, 7), "UTC"), { key: "2026-10", at: utc(2026, 10, 3, 18) });
  assert.deepEqual(latestOccurrence(first, utc(2026, 10, 3, 17), "UTC")!.at, utc(2026, 9, 5, 18), "before the time: September's");
  const last: Recurrence = { repeat: "nth", nth: -1, nthWeekday: "fri", time: "21:00" };
  assert.deepEqual(latestOccurrence(last, utc(2026, 10, 7), "UTC")!.at, utc(2026, 9, 25, 21));
  assert.deepEqual(latestOccurrence(last, utc(2026, 11, 1), "UTC")!.at, utc(2026, 10, 30, 21));
});

test("dates: the latest listed date that has arrived; future ones wait", () => {
  const r: Recurrence = { repeat: "dates", dates: ["2026-12-25", "2026-07-04", "2027-01-01"], time: "12:00" };
  assert.equal(latestOccurrence(r, utc(2026, 10, 7), "UTC")!.key, "2026-07-04");
  assert.equal(latestOccurrence(r, utc(2026, 12, 25, 12), "UTC")!.key, "2026-12-25");
  assert.equal(latestOccurrence({ ...r, dates: ["2030-01-01"] }, utc(2026, 10, 7), "UTC"), null);
});

test("save-time refusals name the fix; a good recurrence passes", () => {
  assert.equal(recurrenceError(monthly(1, "00:00")), null);
  assert.match(recurrenceError(monthly(1, "24:00"))!, /HH:MM/);
  assert.match(recurrenceError(monthly(0))!, /1 to 31/);
  assert.match(recurrenceError({ repeat: "weekly", weekdays: [], time: "10:00" })!, /day of the week/);
  assert.match(recurrenceError({ repeat: "nth", nth: 5, nthWeekday: "sat", time: "10:00" })!, /first to the fourth, or the last/);
  assert.match(recurrenceError({ repeat: "dates", dates: ["2026-02-30"], time: "10:00" })!, /not a date/);
  assert.match(recurrenceError({ repeat: "yearly" as never, time: "10:00" })!, /repeat must be/);
});

test("described in words for the audit trail", () => {
  assert.equal(describeRecurrence(monthly(1, "00:00")), "on the 1st of every month at 00:00");
  assert.equal(describeRecurrence(monthly(31, "06:30")), "on the last day of every month at 06:30");
  assert.equal(describeRecurrence({ repeat: "weekly", weekdays: ["sun", "sat"], time: "20:00" }), "every Saturday and Sunday at 20:00");
  assert.equal(describeRecurrence({ repeat: "nth", nth: 1, nthWeekday: "sat", time: "18:00" }), "on the first Saturday of every month at 18:00");
  assert.equal(describeRecurrence({ repeat: "dates", dates: ["2026-12-25"], time: "12:00" }), "on 2026-12-25 at 12:00");
});

test("a month carries one monthly moment whatever its day or time — moving either after it ran waits for next month", () => {
  const ran = latestOccurrence(monthly(1, "00:00"), utc(2026, 10, 7), "UTC")!.key;
  const moved = latestOccurrence(monthly(15, "12:00"), utc(2026, 10, 20), "UTC")!.key;
  assert.equal(ran, moved, "same period: a runner that claimed it will not run the 15th again this month");
  const weekly = latestOccurrence({ repeat: "weekly", weekdays: ["sat", "sun"], time: "20:00" }, utc(2026, 10, 11, 21), "UTC")!.key;
  assert.equal(weekly, "2026-10-11", "weekly moments are each their own day");
});
