// A rule's VIP time and cooldown: stored in minutes, edited as a number and a unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeMinutes, joinMinutes, splitMinutes, VIP_SPAN_MAX_MINUTES } from "../lib/vipSpan.ts";

test("stored minutes open in the largest unit that shows them exactly", () => {
  assert.deepEqual(splitMinutes(10), { value: 10, unit: "minutes" });
  assert.deepEqual(splitMinutes(60), { value: 1, unit: "hours" });
  assert.deepEqual(splitMinutes(90), { value: 90, unit: "minutes" }, "never 1.5 hours — what was typed comes back");
  assert.deepEqual(splitMinutes(4320), { value: 3, unit: "days" });
  assert.deepEqual(splitMinutes(0), { value: 0, unit: "minutes" }, "0 = no cooldown stays a plain 0");
});

test("a number in a unit saves as whole minutes; blank stays blank so the default applies", () => {
  assert.equal(joinMinutes("3", "days"), 4320);
  assert.equal(joinMinutes("1.5", "hours"), 90);
  assert.equal(joinMinutes(30, "days"), 43200);
  assert.ok(Number.isNaN(joinMinutes("", "days")), "a cleared box is not 0 — for a cooldown 0 means no limit");
  assert.equal(joinMinutes("365", "days"), VIP_SPAN_MAX_MINUTES);
  // Round trip.
  for (const m of [1, 45, 60, 1440, 43200, VIP_SPAN_MAX_MINUTES]) { const s = splitMinutes(m); assert.equal(joinMinutes(s.value, s.unit), m); }
});

test("the read-back sentence says days once a span is whole days", () => {
  assert.equal(describeMinutes(10), "10 min");
  assert.equal(describeMinutes(90), "1h 30m");
  assert.equal(describeMinutes(120), "2 hours");
  assert.equal(describeMinutes(1440), "1 day");
  assert.equal(describeMinutes(43200), "30 days");
});
