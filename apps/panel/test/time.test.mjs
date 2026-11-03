// Relative-time formatting: what every timestamp column in the panel now reads as. The exact
// instant is never lost (it's the tooltip), but the text has to answer "how recently" at a glance
// and stay meaningful for old rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtRelative, fmtExact, overnightSpillHint } from "../lib/time.ts";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

test("recent times read as elapsed, not as clock faces", () => {
  assert.equal(fmtRelative(ago(5_000), NOW), "just now");
  assert.equal(fmtRelative(ago(3 * MIN), NOW), "3 min ago");
  assert.equal(fmtRelative(ago(5 * HOUR), NOW), "5 h ago");
  assert.equal(fmtRelative(ago(30 * HOUR), NOW), "yesterday");
  assert.equal(fmtRelative(ago(4 * DAY), NOW), "4 d ago");
});

test("old times switch to a date — '63 days ago' stops being useful", () => {
  // Inside the same year the year is redundant; across years it isn't.
  assert.match(fmtRelative(ago(40 * DAY), NOW), /Jun/);
  assert.doesNotMatch(fmtRelative(ago(40 * DAY), NOW), /2026/);
  assert.match(fmtRelative(ago(400 * DAY), NOW), /2025/);
});

test("future times read forwards — they're expiries, not history", () => {
  const ahead = (ms) => new Date(NOW + ms).toISOString();
  assert.equal(fmtRelative(ahead(30 * MIN), NOW), "in 30 min");
  assert.equal(fmtRelative(ahead(6 * HOUR), NOW), "in 6 h");
  assert.equal(fmtRelative(ahead(3 * DAY), NOW), "in 3 d");
  // Past a week it becomes a date, and the YEAR has to come with it once it is not this one —
  // the same rule the past branch follows. Without it a VIP running to 2028 read as a bare
  // "12 Mar", which looks like it lapsed rather than like it has years left.
  assert.match(fmtRelative(ahead(40 * DAY), NOW), /Sep/);
  assert.doesNotMatch(fmtRelative(ahead(40 * DAY), NOW), /2026/);
  assert.match(fmtRelative(ahead(400 * DAY), NOW), /2027/);
});

test("bad or missing input never renders as garbage", () => {
  assert.equal(fmtRelative(null, NOW), "");
  assert.equal(fmtRelative(undefined, NOW), "");
  assert.equal(fmtRelative("not-a-date", NOW), "not-a-date");
  assert.equal(fmtExact(null), "");
});

// ---- the display zone: one clock for the whole panel ------------------------------------------
import { setDisplayZone, wallToIso, isoToWall, humanizeIsoInText, effectiveZone, zoneLabel } from "../lib/time.ts";

test("fmtExact writes the display zone, not the device's", () => {
  try {
    setDisplayZone("America/New_York");
    // 21:30 UTC in summer is 5:30 PM Eastern — the screenshot bug this exists to end.
    assert.match(fmtExact("2026-08-22T21:30:00.000Z"), /5:30/);
    setDisplayZone("UTC");
    assert.match(fmtExact("2026-08-22T21:30:00.000Z"), /9:30/);
    setDisplayZone("not-a-zone"); // an unusable zone falls back to the device, never to nothing
    assert.ok(fmtExact("2026-08-22T21:30:00.000Z").length > 0);
  } finally { setDisplayZone(null); }
});

test("a typed wall time means the display zone's clock, DST included", () => {
  try {
    setDisplayZone("America/New_York");
    // Summer (EDT, -4): 7:30 PM in New York is 23:30 UTC.
    assert.equal(wallToIso("2026-08-24T19:30"), "2026-08-24T23:30:00.000Z");
    // Winter (EST, -5): the same wall time is 00:30 UTC the next day.
    assert.equal(wallToIso("2026-01-24T19:30"), "2026-01-25T00:30:00.000Z");
    // Round-trips: the prefill shows the same wall time the admin typed.
    assert.equal(isoToWall("2026-08-24T23:30:00.000Z"), "2026-08-24T19:30");
    // Junk is null, never a guess.
    assert.equal(wallToIso("yesterday teatime"), null);
    assert.equal(wallToIso(""), null);
  } finally { setDisplayZone(null); }
});

test("ISO stamps buried in stored sentences are translated where they are read", () => {
  try {
    setDisplayZone("America/New_York");
    const s = humanizeIsoInText("granted VIP to Dave on S1 (until 2026-08-22T21:30:00.000Z)");
    assert.doesNotMatch(s, /2026-08-22T21:30/, "the raw ISO is gone");
    assert.match(s, /5:30/, "…replaced by the same instant on the community clock");
    assert.equal(humanizeIsoInText("no dates here"), "no dates here");
    assert.equal(humanizeIsoInText(null), "");
  } finally { setDisplayZone(null); }
});

test("effectiveZone and zoneLabel answer even before anything is set", () => {
  setDisplayZone(null);
  assert.ok(effectiveZone().length > 0);
  assert.ok(zoneLabel().length > 0);
  try {
    setDisplayZone("America/Chicago");
    assert.equal(effectiveZone(), "America/Chicago");
    assert.match(zoneLabel(new Date("2026-08-24T12:00:00Z")), /CDT/);
  } finally { setDisplayZone(null); }
});

/*
 * The overnight-window warning: the engine reads day and time as independent AND-conditions, so a
 * "fri 22:00-02:00" profile goes dead at midnight. The editor warns exactly when that will happen
 * — a wrapping window meeting a day filter that omits the following day — and stays quiet
 * everywhere the setup already does what its author meant.
 */
test("overnightSpillHint fires only where midnight actually cuts the window", () => {
  // The classic: Friday night, spilling into an unselected Saturday.
  assert.match(overnightSpillHint(["fri"], "22:00", "02:00") ?? "", /on fri it stops at 00:00/);
  // Friday AND Saturday picked: Friday's spill lands on a selected day; Saturday's does not.
  const friSat = overnightSpillHint(["fri", "sat"], "22:00", "02:00") ?? "";
  assert.match(friSat, /on sat it stops/);
  assert.doesNotMatch(friSat, /on fri/);
  // The week boundary wraps too: Sunday night spills into an unselected Monday.
  assert.match(overnightSpillHint(["sat", "sun"], "22:00", "02:00") ?? "", /on sun it stops/);
  // Quiet everywhere the setup is fine: every day, no days, and windows that do not wrap.
  assert.equal(overnightSpillHint(["sun", "mon", "tue", "wed", "thu", "fri", "sat"], "22:00", "02:00"), null);
  assert.equal(overnightSpillHint([], "22:00", "02:00"), null);
  assert.equal(overnightSpillHint(undefined, "22:00", "02:00"), null);
  assert.equal(overnightSpillHint(["fri"], "20:00", "23:00"), null, "no wrap, no warning");
  assert.equal(overnightSpillHint(["fri"], "junk", "02:00"), null, "an unparseable bound warns about nothing");
});
