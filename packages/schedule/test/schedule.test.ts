import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWindowActive, windowContains, zonedParts, matchesPlayerCount, isActive, resolveProfile,
  WEEKDAYS, matchWindowOpen, type ScheduleSpec,
} from "../dist/index.js";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));
const wdOf = (date: Date) => WEEKDAYS[date.getUTCDay()]!; // matches zonedParts weekday under tz "UTC"

test("windowContains: normal, all-day, and overnight wraparound", () => {
  assert.equal(windowContains(9 * 60, "08:00", "17:00"), true);
  assert.equal(windowContains(18 * 60, "08:00", "17:00"), false);
  assert.equal(windowContains(3 * 60, "00:00", "00:00"), true); // equal bounds = all day
  // overnight 22:00→02:00
  assert.equal(windowContains(23 * 60, "22:00", "02:00"), true);
  assert.equal(windowContains(1 * 60, "22:00", "02:00"), true);
  assert.equal(windowContains(12 * 60, "22:00", "02:00"), false);
});

test("zonedParts converts to the target timezone", () => {
  // 2026-01-01 05:00 UTC is 2026-01-01 00:00 in New York (UTC-5 in winter)
  const p = zonedParts(utc(2026, 1, 1, 5, 0), "America/New_York");
  assert.equal(p.year, 2026); assert.equal(p.month, 1); assert.equal(p.day, 1);
  assert.equal(p.minutes, 0);
});

test("time window respects timezone (overnight, NY)", () => {
  const at = utc(2026, 1, 1, 5, 0); // 00:00 NY / 05:00 UTC
  assert.equal(isWindowActive({ timezone: "America/New_York", start: "23:00", end: "01:00" }, at), true);
  assert.equal(isWindowActive({ timezone: "UTC", start: "23:00", end: "01:00" }, at), false); // 05:00 UTC
});

test("day-of-week gating", () => {
  const at = utc(2026, 6, 10, 12, 0);
  const today = wdOf(at);
  const other = WEEKDAYS[(WEEKDAYS.indexOf(today) + 1) % 7]!;
  assert.equal(isWindowActive({ timezone: "UTC", daysOfWeek: [today] }, at), true);
  assert.equal(isWindowActive({ timezone: "UTC", daysOfWeek: [other] }, at), false);
});

test("month + year gating", () => {
  const at = utc(2026, 6, 6, 12, 0);
  assert.equal(isWindowActive({ timezone: "UTC", months: [6] }, at), true);
  assert.equal(isWindowActive({ timezone: "UTC", months: [7] }, at), false);
  assert.equal(isWindowActive({ timezone: "UTC", years: [2026] }, at), true);
  assert.equal(isWindowActive({ timezone: "UTC", years: [2025] }, at), false);
});

test("dates: recurring MM-DD and exact YYYY-MM-DD", () => {
  const at = utc(2026, 6, 6, 12, 0);
  assert.equal(isWindowActive({ timezone: "UTC", dates: ["06-06"] }, at), true); // D-Day, recurring
  assert.equal(isWindowActive({ timezone: "UTC", dates: ["2026-06-06"] }, at), true); // exact
  assert.equal(isWindowActive({ timezone: "UTC", dates: ["2025-06-06"] }, at), false); // wrong year, exact
  assert.equal(isWindowActive({ timezone: "UTC", dates: ["06-07"] }, at), false);
});

test("all fields must hold together", () => {
  const at = utc(2026, 6, 6, 15, 0); // Sat-ish, June, 15:00 UTC
  const day = wdOf(at);
  assert.equal(isWindowActive({ timezone: "UTC", daysOfWeek: [day], months: [6], start: "14:00", end: "16:00" }, at), true);
  // wrong time → false even though day+month match
  assert.equal(isWindowActive({ timezone: "UTC", daysOfWeek: [day], months: [6], start: "16:00", end: "18:00" }, at), false);
});

test("matchesPlayerCount: below/above and unknown handling", () => {
  assert.equal(matchesPlayerCount({}, null), true); // no condition = always
  assert.equal(matchesPlayerCount({ playersBelow: 50 }, 30), true);
  assert.equal(matchesPlayerCount({ playersBelow: 50 }, 50), false);
  assert.equal(matchesPlayerCount({ playersBelow: 50 }, null), false); // condition set, count unknown
  assert.equal(matchesPlayerCount({ playersAbove: 80 }, 90), true);
  assert.equal(matchesPlayerCount({ playersAbove: 80 }, 80), false);
  assert.equal(matchesPlayerCount({ playersBelow: 100, playersAbove: 40 }, 60), true);
  assert.equal(matchesPlayerCount({ playersBelow: 100, playersAbove: 40 }, 30), false);
});

test("isActive combines window + player count", () => {
  const at = utc(2026, 6, 6, 12, 0);
  const spec: ScheduleSpec = { timezone: "UTC", months: [6], playersBelow: 50 };
  assert.equal(isActive(spec, at, { playerCount: 30 }), true);
  assert.equal(isActive(spec, at, { playerCount: 60 }), false);
  assert.equal(isActive(spec, utc(2026, 7, 6, 12, 0), { playerCount: 30 }), false); // wrong month
});

test("resolveProfile: first match wins; conditionless default last", () => {
  const profiles = [
    { name: "dday", spec: { timezone: "UTC", dates: ["06-06"] } as ScheduleSpec },
    { name: "seeding", spec: { playersBelow: 50 } as ScheduleSpec },
    { name: "night", spec: { timezone: "UTC", start: "00:00", end: "07:00" } as ScheduleSpec },
    { name: "default" }, // no spec → always matches, must be last
  ];
  // D-Day midday, busy → dday wins (listed first)
  assert.equal(resolveProfile(profiles, utc(2026, 6, 6, 12, 0), { playerCount: 80 })?.name, "dday");
  // low pop on a normal day → seeding
  assert.equal(resolveProfile(profiles, utc(2026, 3, 10, 12, 0), { playerCount: 20 })?.name, "seeding");
  // 03:00 UTC busy normal day → night
  assert.equal(resolveProfile(profiles, utc(2026, 3, 10, 3, 0), { playerCount: 80 })?.name, "night");
  // busy midday normal day → default
  assert.equal(resolveProfile(profiles, utc(2026, 3, 10, 12, 0), { playerCount: 80 })?.name, "default");
});

test("resolveProfile returns null when nothing matches and no default", () => {
  const profiles = [{ name: "friday", spec: { timezone: "UTC", daysOfWeek: ["fri"] } as ScheduleSpec }];
  const at = utc(2026, 6, 6, 12, 0);
  const expected = wdOf(at) === "fri" ? "friday" : null;
  assert.equal(resolveProfile(profiles, at)?.name ?? null, expected);
});

/*
 * This engine decides which map-vote profile and which auto-settings are in force, from a worker
 * tick, forever. Two things it must never do: throw, and match when it shouldn't.
 *
 * The API validates both the timezone and the HH:MM bounds on save, so none of this is reachable
 * through the panel today. It is here because the engine is a shared library — the plugin SDK hands
 * it to third-party code — and because rows written before those validators existed are still in
 * people's databases.
 */
test("an unusable timezone falls back to UTC instead of throwing", () => {
  // Intl throws a RangeError on all of these. The empty string is the likely one: a blank field.
  const at = new Date("2026-07-30T21:30:00Z"); // 21:30 UTC
  for (const timezone of ["", "   ", "America/New York", "Mars/Olympus", "UTC+1", "GMT+0200"]) {
    let active;
    assert.doesNotThrow(() => { active = isWindowActive({ timezone, start: "21:00", end: "22:00" }, at); },
      `timezone ${JSON.stringify(timezone)} threw — that kills the worker tick, not just this window`);
    assert.equal(active, true, `timezone ${JSON.stringify(timezone)} should have evaluated in UTC`);
  }
  // A real zone still wins: 21:30 UTC is 17:30 in New York, outside the window.
  assert.equal(isWindowActive({ timezone: "America/New_York", start: "21:00", end: "22:00" }, at), false);
});

test("a mistyped time makes a window inactive — it must never make it always-on", () => {
  // The old parse gave NaN, every comparison against NaN was false, and the overnight branch fell
  // through to `now < end` — so "8pm" as a start turned a night-only window into most of the day.
  const noon = new Date("2026-07-30T12:00:00Z");
  for (const start of ["8pm", "", "20", "20:", "abc", "20:60", "25:00", "-1:00", "20:00:00"]) {
    assert.equal(
      isWindowActive({ timezone: "UTC", start, end: "23:00" }, noon),
      false,
      `start ${JSON.stringify(start)} left the window active at midday`,
    );
  }
  for (const end of ["8am", "", "abc", "99:99"]) {
    assert.equal(isWindowActive({ timezone: "UTC", start: "20:00", end }, noon), false, `end ${JSON.stringify(end)} matched`);
  }
  // …and the well-formed equivalents still behave.
  assert.equal(isWindowActive({ timezone: "UTC", start: "20:00", end: "23:00" }, noon), false, "midday is outside 20:00-23:00");
  assert.equal(isWindowActive({ timezone: "UTC", start: "08:00", end: "18:00" }, noon), true, "midday is inside 08:00-18:00");
});

test("a window straddling a DST change follows the wall clock, not the offset", () => {
  // 21:00-23:00 local in New York, across the spring-forward night (2026-03-08). The UTC offset
  // shifts by an hour that night; a matcher built on fixed-offset arithmetic drifts by an hour and
  // starts firing at the wrong time. Comparing wall-clock components in the zone is what avoids it.
  const win = { timezone: "America/New_York", start: "21:00", end: "23:00" };
  // The night before the change: EST, UTC-5 — 21:30 local is 02:30 UTC the next day.
  assert.equal(isWindowActive(win, new Date("2026-03-08T02:30:00Z")), true, "21:30 EST is inside");
  assert.equal(isWindowActive(win, new Date("2026-03-08T01:30:00Z")), false, "20:30 EST is outside");
  // The night after: EDT, UTC-4 — the SAME local 21:30 is now 01:30 UTC, an hour earlier in
  // absolute time. That shift is the whole point: a fixed-offset matcher would miss it by an hour.
  assert.equal(isWindowActive(win, new Date("2026-03-09T01:30:00Z")), true, "21:30 EDT is inside");
  assert.equal(isWindowActive(win, new Date("2026-03-09T04:30:00Z")), false, "00:30 EDT is past the window");
});

test("an overnight window is continuous across midnight", () => {
  // The common case for a night map set, and the one the overnight branch exists for.
  const win = { timezone: "UTC", start: "22:00", end: "04:00" };
  for (const [iso, want] of [
    ["2026-07-30T21:59:00Z", false],
    ["2026-07-30T22:00:00Z", true],
    ["2026-07-30T23:59:00Z", true],
    ["2026-07-31T00:00:00Z", true],
    ["2026-07-31T03:59:00Z", true],
    ["2026-07-31T04:00:00Z", false],
    ["2026-07-31T12:00:00Z", false],
  ] as [string, boolean][]) {
    assert.equal(isWindowActive(win, new Date(iso)), want, `${iso} should be ${want}`);
  }
});

test("team-count conditions: bounds, unknowns never match, diff needs both sides", () => {
  const at = new Date("2025-06-15T12:00:00Z");
  const p = (spec: ScheduleSpec) => resolveProfile([{ name: "x", spec }], at, ctxTeams) !== null;

  const ctxTeams = { alliedCount: 40, axisCount: 25 };
  assert.equal(p({ alliedAbove: 30 }), true);
  assert.equal(p({ alliedBelow: 30 }), false);
  assert.equal(p({ axisBelow: 30 }), true);
  assert.equal(p({ axisAbove: 30 }), false);
  // Lopsided-teams trigger: |40-25| = 15.
  assert.equal(p({ teamDiffAbove: 10 }), true);
  assert.equal(p({ teamDiffAbove: 15 }), false, "strictly above, like the player-count bounds");
  assert.equal(p({ teamDiffBelow: 20 }), true);

  // Unknown values: a condition present never matches, same rule as playerCount.
  const unknown = resolveProfile([{ name: "x", spec: { alliedAbove: 5 } }], at, {});
  assert.equal(unknown, null);
  const halfKnown = resolveProfile([{ name: "x", spec: { teamDiffAbove: 0 } }], at, { alliedCount: 10 });
  assert.equal(halfKnown, null, "a diff against an unknown side must not guess");

  // Composition with the existing conditions still holds.
  const both = resolveProfile(
    [{ name: "x", spec: { playersAbove: 60, teamDiffAbove: 10 } }],
    at, { playerCount: 65, ...ctxTeams },
  );
  assert.equal(both?.name, "x");
});

test("match-time conditions: at least is inclusive, below is strict, unknown never matches", async () => {
  const { matchesMatchTime, matchMinutesSince } = await import("../dist/index.js");
  const band = { matchMinutesAtLeast: 30, matchMinutesBelow: 60 };
  assert.equal(matchesMatchTime(band, 29.9), false);
  assert.equal(matchesMatchTime(band, 30), true);
  assert.equal(matchesMatchTime(band, 59.9), true);
  assert.equal(matchesMatchTime(band, 60), false, "60 belongs to the next band");
  assert.equal(matchesMatchTime(band, null), false, "no match in progress: never a guess");
  assert.equal(matchesMatchTime({}, null), true, "no condition: always");
  const now = Date.UTC(2026, 8, 27, 12, 0);
  assert.equal(isActive(band, new Date(now), { matchMinutes: 45 }), true);
  assert.equal(isActive(band, new Date(now), {}), false);
  assert.equal(matchMinutesSince(new Date(now - 45 * 60_000).toISOString(), now), 45);
  assert.equal(matchMinutesSince(null, now), null);
  assert.equal(matchMinutesSince(new Date(now + 60_000).toISOString(), now), null, "a start in the future is unreadable");
  assert.equal(matchMinutesSince(new Date(now - 7 * 3600_000).toISOString(), now), null, "a match 'open' for hours is a stale row");
  const first = resolveProfile([{ name: "late", spec: { matchMinutesAtLeast: 30 } }, { name: "default" }], new Date(now), { matchMinutes: 10 });
  assert.equal(first?.name, "default");
});

test("matchWindowOpen: from / until minutes into the match; an unknown clock closes a set window", () => {
  assert.equal(matchWindowOpen(0, 0, null), true, "no window: always open, clock or not");
  assert.equal(matchWindowOpen(0, 10, 9.9), true);
  assert.equal(matchWindowOpen(0, 10, 10), false, "until 10 means under 10");
  assert.equal(matchWindowOpen(5, 0, 4), false);
  assert.equal(matchWindowOpen(5, 0, 5), true);
  assert.equal(matchWindowOpen(5, 30, null), false);
});
