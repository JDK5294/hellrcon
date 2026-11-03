/**
 * The events post, and the schedule that sends it by itself.
 *
 * The property that matters most is the one a test can actually pin: every instant in the post is
 * Discord's unix-timestamp markup, so each reader sees it on their own clock. A wall-clock string
 * anywhere in this output is the bug.
 *
 * Imported from `dist`, as every other package's tests are: the runner strips types rather than
 * resolving them, so it cannot follow the `./x.js` specifier one source file uses to reach
 * another. That only started to matter when this package grew past a single file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEventsPost, discordTime, dueEventsPost, eventLine, upcomingEvents,
  type AnnounceableEvent, type EventPostSchedule,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-24T18:00:00.000Z"); // a Monday, 2pm Eastern

const ev = (over: Partial<AnnounceableEvent> = {}): AnnounceableEvent => ({
  id: "e1", name: "Forest Bash", serverId: "s1", status: "scheduled",
  openMode: "at", openAnchor: "2026-08-28T23:30:00.000Z", openedAt: null,
  closeMode: "at", closeAnchor: "2026-08-29T02:30:00.000Z", closedAt: null,
  ...over,
});

test("every instant is unix markup — never a wall-clock string somebody's zone disagrees with", () => {
  const post = buildEventsPost([ev()], { days: 14, now: NOW, serverNames: { s1: "LYNX #1" } })!;
  const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  assert.ok(post.includes(`<t:${secs("2026-08-28T23:30:00.000Z")}:F>`), "the start, as seconds since the epoch");
  assert.ok(post.includes(`<t:${secs("2026-08-29T02:30:00.000Z")}:t>`), "…and the end, a clock face because it is the same night");
  assert.ok(post.includes(`<t:${secs("2026-08-28T23:30:00.000Z")}:R>`), "…plus the relative form Discord keeps live");
  // No formatted date anywhere: the moment one appears, it is wrong for most readers.
  assert.doesNotMatch(post, /\d{4}-\d{2}-\d{2}T/, "no ISO leaked through");
  assert.doesNotMatch(post, /\b(AM|PM|UTC|GMT)\b/i, "and no zone-bound wall clock");
  assert.match(post, /LYNX #1/, "the server is named for the people reading");
  assert.match(post, /next 14 days/);
});

test("an event longer than a day gets a dated end; a night out gets a clock face", () => {
  const short = eventLine(ev());
  assert.match(short, /→ <t:\d+:t>/);
  const long = eventLine(ev({ closeAnchor: "2026-08-31T02:30:00.000Z" }));
  assert.match(long, /→ <t:\d+:f>/, "three days later, the date matters");
});

/*
 * An event's name is staff's typing, and Discord reads it as markdown: "Clan_vs_Clan_Finals" came
 * out with "vs" in italics. The callers pass Discord's escaping; the server's name is left as it is.
 */
test("an event's name is written through the caller's escaping, so it shows as typed", () => {
  const literal = (t: string) => t.replace(/[\\*_]/g, "\\$&");
  const line = eventLine(ev({ name: "Clan_vs_Clan *finals*" }), { serverNames: { s1: "LYNX_1" }, literal });
  assert.match(line, /^\*\*Clan\\_vs\\_Clan \\\*finals\\\*\*\* · LYNX_1\n/);
  assert.ok(buildEventsPost([ev({ name: "a_b_c" })], { days: 14, now: NOW, literal })!.includes("**a\\_b\\_c**"), "the whole post too");
  assert.match(eventLine(ev({ name: "a_b_c" })), /^\*\*a_b_c\*\*/, "without one, the name is written as it is");
});

test("a match-boundary event says so — the difference between arriving on time and to a lobby", () => {
  assert.match(eventLine(ev({ openMode: "match_start_after" })), /starts with the first match after this/);
  assert.doesNotMatch(eventLine(ev({ openMode: "at" })), /first match/);
  assert.match(eventLine(ev({ status: "open", openedAt: "2026-08-24T17:00:00.000Z" })), /on now/);
});

test("the list is what is still to come, soonest first — records are not invitations", () => {
  const events = [
    ev({ id: "far", openAnchor: "2026-10-01T20:00:00.000Z" }),
    ev({ id: "soon", openAnchor: "2026-08-26T20:00:00.000Z" }),
    ev({ id: "past", openAnchor: "2026-08-01T20:00:00.000Z" }),
    ev({ id: "done", status: "closed", openAnchor: "2026-08-25T20:00:00.000Z" }),
    ev({ id: "off", status: "cancelled", openAnchor: "2026-08-25T20:00:00.000Z" }),
    // Running RIGHT NOW: its start is behind us, and it is the most useful line in the post.
    ev({ id: "live", status: "open", openAnchor: "2026-08-24T16:00:00.000Z", openedAt: "2026-08-24T16:05:00.000Z" }),
  ];
  assert.deepEqual(upcomingEvents(events, 14, NOW).map((e) => e.id), ["live", "soon"]);
  assert.deepEqual(upcomingEvents(events, 60, NOW).map((e) => e.id), ["live", "soon", "far"]);
});

test("nothing to announce posts nothing — a weekly 'no events!' teaches people to ignore the channel", () => {
  assert.equal(buildEventsPost([], { days: 14, now: NOW }), null);
  assert.equal(buildEventsPost([ev({ status: "cancelled" })], { days: 14, now: NOW }), null);
  assert.equal(discordTime("not a time"), "");
});

// ---- the self-sending schedule ---------------------------------------------------------------

const sched = (over: Partial<EventPostSchedule> = {}): EventPostSchedule => ({
  enabled: true, channelId: "123456", daysAhead: 14, weekday: 1, atHour: 9, atMinute: 0, lastPostedOn: null, ...over,
});

test("the weekly post fires on its day, after its time, once — in the community's zone", () => {
  const tz = "America/New_York";
  // Monday 08:59 Eastern — not yet.
  assert.equal(dueEventsPost(sched(), tz, Date.parse("2026-08-24T12:59:00Z")), null);
  // Monday 09:00 Eastern — due, for Monday's date.
  assert.deepEqual(dueEventsPost(sched(), tz, Date.parse("2026-08-24T13:00:00Z")), { postFor: "2026-08-24" });
  // Latched: the same day never posts twice, however often the worker ticks.
  assert.equal(dueEventsPost(sched({ lastPostedOn: "2026-08-24" }), tz, Date.parse("2026-08-24T15:00:00Z")), null);
  // Tuesday is not Monday.
  assert.equal(dueEventsPost(sched(), tz, Date.parse("2026-08-25T13:00:00Z")), null);
  // The zone is the community's, not UTC: 09:00 Eastern is 13:00Z, and at 09:00Z it is only 5am there.
  assert.equal(dueEventsPost(sched(), tz, Date.parse("2026-08-24T09:00:00Z")), null);
});

test("a worker that was down at the appointed minute still posts that day", () => {
  // Missed 9am, back at 2pm: the day's post still goes out (the latch is the DATE, not the minute).
  assert.deepEqual(dueEventsPost(sched(), "America/New_York", Date.parse("2026-08-24T18:00:00Z")), { postFor: "2026-08-24" });
  // …but not the next morning, arriving a day late as if it were fresh.
  assert.equal(dueEventsPost(sched({ lastPostedOn: "2026-08-24" }), "America/New_York", Date.parse("2026-08-25T13:00:00Z")), null);
});

test("daily is a weekday of -1; off, channel-less or unusable zones never post", () => {
  const tz = "America/New_York";
  assert.deepEqual(dueEventsPost(sched({ weekday: -1 }), tz, Date.parse("2026-08-25T13:00:00Z")), { postFor: "2026-08-25" });
  assert.equal(dueEventsPost(sched({ enabled: false }), tz, Date.parse("2026-08-24T13:00:00Z")), null);
  assert.equal(dueEventsPost(sched({ channelId: "" }), tz, Date.parse("2026-08-24T13:00:00Z")), null);
  // A bad zone falls back to UTC rather than throwing inside a worker tick.
  assert.deepEqual(dueEventsPost(sched({ weekday: -1 }), "Not/AZone", Date.parse("2026-08-24T13:00:00Z")), { postFor: "2026-08-24" });
});

/*
 * A full calendar fits ITSELF inside Discord's budget by dropping whole entries and saying so.
 * The callers used to slice(0, 1900) instead, which sheared the last entry mid-<t:…> token —
 * Discord renders a broken timestamp as raw markup — and ate the very footer that explains why
 * the times look right to everyone.
 */
test("an overfull events post drops whole entries, never shears a timestamp, and keeps its footer", () => {
  const many = Array.from({ length: 40 }, (_, i) => ev({
    id: `e${i}`, name: `Skirmish Night #${i} — the long-running community classic`,
    openAnchor: new Date(NOW + (i + 1) * 3_600_000).toISOString(),
    closeAnchor: new Date(NOW + (i + 1) * 3_600_000 + 7_200_000).toISOString(),
  }));
  const post = buildEventsPost(many, { days: 7, now: NOW });
  assert.ok(post);
  assert.ok(post.length <= 1900, `fits the budget (${post.length})`);
  // Every timestamp token that appears is complete — none was cut mid-way.
  assert.equal((post.match(/<t:/g) ?? []).length, (post.match(/<t:\d+:[a-zA-Z]>/g) ?? []).length, "no sheared <t:…> token");
  assert.match(post, /…and \d+ more events later in the window\./, "the dropped tail is admitted, not hidden");
  assert.match(post, /Times show in your own time zone\./, "the footer survives");
  assert.match(post, /Skirmish Night #0/, "the soonest events are the ones kept");

  // A calendar that fits is untouched — no "more" line, everything present.
  const few = buildEventsPost(many.slice(0, 3), { days: 7, now: NOW });
  assert.ok(few && !/more event/.test(few));
  assert.match(few, /Skirmish Night #2/);
});
