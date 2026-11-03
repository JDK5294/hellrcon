import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSchedule, scheduleWeekdays } from "../lib/scheduleText.ts";

test("a schedule reads as a sentence, in the API's own words", () => {
  assert.equal(describeSchedule({ repeat: "monthly", monthDay: 1, time: "00:00" }), "on the 1st of every month at 00:00");
  assert.equal(describeSchedule({ repeat: "monthly", monthDay: 31, time: "06:30" }), "on the last day of every month at 06:30");
  assert.equal(describeSchedule({ repeat: "monthly", monthDay: 22, time: "06:30" }), "on the 22nd of every month at 06:30");
  assert.equal(describeSchedule({ repeat: "weekly", weekdays: "sun,sat", time: "20:00" }), "every Saturday and Sunday at 20:00");
  assert.equal(describeSchedule({ repeat: "weekly", weekdays: "", time: "20:00" }), "every week (no day picked yet)");
  assert.equal(describeSchedule({ repeat: "nth", nth: 1, nthWeekday: "sat", time: "18:00" }), "on the first Saturday of every month at 18:00");
  assert.equal(describeSchedule({ repeat: "nth", nth: -1, nthWeekday: "fri", time: "21:00" }), "on the last Friday of every month at 21:00");
  assert.equal(describeSchedule({ repeat: "dates", dates: "2026-12-25, 2027-01-01", time: "12:00" }), "on 2026-12-25 and 2027-01-01 at 12:00");
  assert.deepEqual(scheduleWeekdays({ weekdays: "Sunday, mon" }), ["mon", "sun"]);
});
