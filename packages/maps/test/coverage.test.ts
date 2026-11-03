import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCoverage, type MapVoteProfile } from "../dist/index.js";

const at = (h: number, m = 0) => h * 60 + m;

/*
 * The whole point of computing regions rather than sampling: coverage depends on the player count
 * AND the time, so any answer that fixes one axis is false somewhere on the other. Here the seeding
 * set owns the entire day below 40 players while prime time owns 18:00–23:00 above it — so "the
 * evening is prime time" and "mornings are uncovered" are each true only inside one band.
 */
test("coverage splits on both axes: the same hour answers differently by player count", () => {
  const profiles: MapVoteProfile[] = [
    { name: "seeding", spec: { playersBelow: 40 } },
    { name: "prime", spec: { start: "18:00", end: "23:00" } },
  ];
  const report = describeCoverage(profiles);

  // No day rules anywhere, so every day behaves the same and reads as one group.
  assert.equal(report.groups.length, 1);
  assert.deepEqual(report.groups[0]!.days, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

  const bands = report.groups[0]!.bands;
  assert.equal(bands.length, 2, "one band under 40 players, one at 40 and above");

  const low = bands[0]!;
  assert.deepEqual([low.minPlayers, low.maxPlayers], [0, 40]);
  assert.deepEqual(low.spans, [{ startMinute: 0, endMinute: 1440, profile: "seeding" }],
    "below 40 the seeding set owns the whole day — prime time never gets a look in");

  const high = bands[1]!;
  assert.deepEqual([high.minPlayers, high.maxPlayers], [40, null]);
  assert.deepEqual(high.spans, [
    { startMinute: 0, endMinute: at(18), profile: null },
    { startMinute: at(18), endMinute: at(23), profile: "prime" },
    { startMinute: at(23), endMinute: 1440, profile: null },
  ], "at 40+ only the evening is covered; the rest of the day matches nothing");

  assert.equal(report.hasGaps, true);
});

test("an unconditional set at the bottom closes every gap on both axes", () => {
  const report = describeCoverage([
    { name: "prime", spec: { start: "18:00", end: "23:00" } },
    { name: "default" }, // no spec at all
  ]);
  assert.equal(report.hasGaps, false);
  const bands = report.groups[0]!.bands;
  assert.equal(bands.length, 1, "nothing gates on player count, so there is one band");
  assert.deepEqual(bands[0]!.spans.map((s) => s.profile), ["default", "prime", "default"]);
});

test("day rules split the week into groups, and only the days that differ", () => {
  const report = describeCoverage([
    { name: "weekend", spec: { daysOfWeek: ["sat", "sun"] } },
    { name: "weekday", spec: { daysOfWeek: ["mon", "tue", "wed", "thu", "fri"] } },
  ]);
  assert.equal(report.groups.length, 2);
  assert.deepEqual(report.groups[0]!.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(report.groups[0]!.bands[0]!.spans[0]!.profile, "weekday");
  assert.deepEqual(report.groups[1]!.days, ["sat", "sun"]);
  assert.equal(report.groups[1]!.bands[0]!.spans[0]!.profile, "weekend");
  assert.equal(report.hasGaps, false);
});

test("an overnight window is reported at both ends of the day, not silently dropped", () => {
  const report = describeCoverage([{ name: "night", spec: { start: "22:00", end: "06:00" } }]);
  const spans = report.groups[0]!.bands[0]!.spans;
  assert.deepEqual(spans, [
    { startMinute: 0, endMinute: at(6), profile: "night" },
    { startMinute: at(6), endMinute: at(22), profile: null },
    { startMinute: at(22), endMinute: 1440, profile: "night" },
  ]);
});

test("first match wins, exactly as the worker resolves it", () => {
  // Both match at 20:00 with 100 players; the earlier set must own it.
  const report = describeCoverage([
    { name: "first", spec: { start: "18:00", end: "23:00" } },
    { name: "second", spec: { playersAbove: 50 } },
  ]);
  const high = report.groups[0]!.bands.find((b) => b.minPlayers === 51)!;
  const evening = high.spans.find((s) => s.startMinute === at(18))!;
  assert.equal(evening.profile, "first");
  const morning = high.spans.find((s) => s.startMinute === 0)!;
  assert.equal(morning.profile, "second", "outside the first set's window the second one takes over");
});

test("playersAbove bands start one player up — 'above 50' means 51, not 50", () => {
  const report = describeCoverage([{ name: "busy", spec: { playersAbove: 50 } }]);
  const bands = report.groups[0]!.bands;
  assert.deepEqual(bands.map((b) => [b.minPlayers, b.maxPlayers]), [[0, 51], [51, null]]);
  assert.equal(bands[0]!.spans[0]!.profile, null, "at 50 players nothing matches");
  assert.equal(bands[1]!.spans[0]!.profile, "busy");
});

test("calendar-gated sets are named separately, never folded into a normal week", () => {
  const report = describeCoverage([
    { name: "dday", spec: { dates: ["06-06"] } },
    { name: "default" },
  ]);
  assert.deepEqual(report.calendarOnly, [{ name: "dday", when: "06-06" }]);
  // The weekly picture is what a normal week does: the catch-all, everywhere.
  assert.equal(report.groups.length, 1);
  assert.deepEqual(report.groups[0]!.bands[0]!.spans, [{ startMinute: 0, endMinute: 1440, profile: "default" }]);
  assert.equal(report.hasGaps, false);
});

test("no sets at all is one honest gap, not an empty report", () => {
  const report = describeCoverage([]);
  assert.equal(report.hasGaps, true);
  assert.equal(report.groups.length, 1);
  assert.deepEqual(report.groups[0]!.bands, [{ minPlayers: 0, maxPlayers: null, spans: [{ startMinute: 0, endMinute: 1440, profile: null }] }]);
});

/*
 * Bands only exist where the answer actually changes. Two sets gating on the same count must not
 * produce a band boundary that splits identical rows — that was how the first version implied a
 * difference where there was none.
 */
test("bands that divide the day identically are merged into one", () => {
  const report = describeCoverage([
    { name: "a", spec: { playersBelow: 40 } },
    { name: "b", spec: { playersBelow: 60 } },
    { name: "catch" },
  ]);
  const bands = report.groups[0]!.bands;
  // 0–39 → a, 40–59 → b, 60+ → catch: three genuinely different answers, three bands.
  assert.deepEqual(bands.map((b) => [b.minPlayers, b.maxPlayers, b.spans[0]!.profile]), [
    [0, 40, "a"], [40, 60, "b"], [60, null, "catch"],
  ]);

  // Now the same gate twice over: the second can never win, and the day never divides differently.
  const flat = describeCoverage([{ name: "a", spec: { playersBelow: 40 } }, { name: "a2", spec: { playersBelow: 40 } }]);
  assert.equal(flat.groups[0]!.bands.length, 2, "one band below the gate, one above — not three");
});

/*
 * A profile may carry its own timezone, and the worker honours it (`spec.timezone` wins over the
 * config's). The picture must draw such a profile where it actually fires on the config's axes,
 * not where its clock-face numbers would sit. Asserted at a fixed July instant so the New York
 * offset is known (EDT, UTC-4) rather than whichever half of the year the test happens to run in.
 */
test("a profile's own timezone shifts it to where it really fires on the config axis", () => {
  const report = describeCoverage(
    [{ name: "ny-evening", spec: { daysOfWeek: ["mon"], start: "20:00", end: "23:00", timezone: "America/New_York" } }],
    "UTC",
    new Date("2026-07-06T12:00:00Z"),
  );
  const tue = report.groups.find((g) => g.days.includes("tue"));
  assert.ok(tue, "the window lands on Tuesday in UTC");
  assert.deepEqual(tue!.bands[0]!.spans.filter((s) => s.profile), [
    { startMinute: 0, endMinute: 180, profile: "ny-evening" },
  ], "Monday 20:00-23:00 New York is Tuesday 00:00-03:00 UTC");
  const mon = report.groups.find((g) => g.days.includes("mon"));
  assert.ok(mon!.bands[0]!.spans.every((s) => s.profile === null), "and Monday UTC holds none of it");
});

test("a profile in the config's own timezone is not shifted at all", () => {
  const report = describeCoverage(
    [{ name: "evening", spec: { start: "18:00", end: "23:00", timezone: "America/Chicago" } }],
    "America/Chicago",
    new Date("2026-07-06T12:00:00Z"),
  );
  const spans = report.groups[0]!.bands[0]!.spans;
  assert.deepEqual(spans.filter((s) => s.profile), [
    { startMinute: 18 * 60, endMinute: 23 * 60, profile: "evening" },
  ], "same zone on both sides means the window sits exactly where it was written");
});
