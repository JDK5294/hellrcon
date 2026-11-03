import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  weekHourGrid, quantile, buildMatchTrends, buildStaffTeamAnalytics,
  buildMapVoteAnalytics, distribute, percentileOf, matchStandouts,
  buildCombatSummary, pairAdminResponses, buildAdminResponseAnalytics, foldPlatformModeration,
} from "../src/analytics.ts";
import { emptyPlatformSums, emptyPlatformTrendRow } from "@app/db";
import type { MatchRow, AuditRow, PlayerMatchStatRow } from "@app/db";

function match(p: Partial<MatchRow>): MatchRow {
  return {
    id: Math.random().toString(36).slice(2),
    serverId: "s",
    map: "Carentan",
    startedAt: "2026-07-01T10:00:00Z",
    endedAt: "2026-07-01T11:00:00Z",
    winner: "allies",
    alliedScore: 3,
    axisScore: 2,
    ...p,
  } as MatchRow;
}

function audit(p: Partial<AuditRow>): AuditRow {
  return {
    id: Math.random().toString(36).slice(2),
    ts: "2026-07-01T10:00:00Z",
    actorUserId: "u1",
    actorName: "Alice",
    action: "player.kick",
    targetId: null,
    targetName: null,
    serverId: "s",
    summary: null,
    data: null,
    ...p,
  } as AuditRow;
}

// ---------------------------------------------------------------- shared

test("weekHourGrid buckets by UTC day and hour, ignoring unparseable stamps", () => {
  // 2026-07-01 is a Wednesday (day 3).
  const grid = weekHourGrid([
    "2026-07-01T10:00:00Z",
    "2026-07-01T10:59:59Z",
    "2026-07-01T11:00:00Z",
    "not a date",
  ]);
  assert.equal(grid.length, 7);
  assert.equal(grid[0]!.length, 24);
  assert.equal(grid[3]![10], 2);
  assert.equal(grid[3]![11], 1);
  assert.equal(grid.flat().reduce((a, b) => a + b, 0), 3); // the junk stamp was dropped
});

test("quantile interpolates like percentile_cont and survives an empty list", () => {
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([10], 0.9), 10);
  // median of an even-length list is the midpoint between the two middle values.
  assert.equal(quantile([10, 20, 30, 40], 0.5), 25);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
});

// ---------------------------------------------------------------- matches

test("buildMatchTrends: headline balance counts only decided rounds", () => {
  const t = buildMatchTrends([
    match({ winner: "allies" }),
    match({ winner: "allies" }),
    match({ winner: "axis" }),
    match({ winner: null }),        // still running / never resolved
    match({ winner: "draw" as unknown as MatchRow["winner"] }),
  ]);
  assert.equal(t.rounds, 5);
  assert.equal(t.decided, 3);
  assert.equal(t.alliesWins, 2);
  assert.equal(t.axisWins, 1);
  assert.equal(t.alliesWinRate, 2 / 3); // NOT 2/5 — undecided rounds are not axis wins
});

test("buildMatchTrends: no decided rounds yields a null rate rather than zero", () => {
  const t = buildMatchTrends([match({ winner: null, alliedScore: null, axisScore: null })]);
  assert.equal(t.decided, 0);
  assert.equal(t.alliesWinRate, null);
  assert.equal(t.avgMargin, null);
  assert.equal(t.blowoutRate, null);
});

test("buildMatchTrends: blowouts are measured against the biggest gap actually seen", () => {
  // The mode's maximum gap is inferred from the data: here 5-0 is the ceiling.
  const t = buildMatchTrends([
    match({ alliedScore: 5, axisScore: 0, winner: "allies" }),
    match({ alliedScore: 3, axisScore: 2, winner: "allies" }),
    match({ alliedScore: 0, axisScore: 5, winner: "axis" }),
    match({ alliedScore: 4, axisScore: 1, winner: "allies" }),
  ]);
  assert.equal(t.blowoutRate, 0.5); // two of the four ended at a gap of 5
  assert.equal(t.avgMargin, (5 + 1 + 5 + 3) / 4);
});

test("buildMatchTrends: per-map rows carry their own denominator and sort by volume", () => {
  const t = buildMatchTrends([
    match({ map: "Foy", winner: "allies" }),
    match({ map: "Foy", winner: "axis" }),
    match({ map: "Foy", winner: "allies" }),
    match({ map: "SME", winner: "allies" }),
  ]);
  assert.deepEqual(t.byMap.map((m) => m.map), ["Foy", "SME"]);
  const foy = t.byMap[0]!;
  assert.equal(foy.rounds, 3);
  assert.equal(foy.alliesWins, 2);
  assert.equal(foy.axisWins, 1);
  assert.equal(foy.alliesWinRate, 2 / 3);
  // A single-round map still reports 100%, which is exactly why `rounds` travels with it.
  assert.equal(t.byMap[1]!.alliesWinRate, 1);
  assert.equal(t.byMap[1]!.rounds, 1);
});

test("buildMatchTrends: a missing map name is bucketed rather than dropped", () => {
  const t = buildMatchTrends([match({ map: null }), match({ map: null })]);
  assert.equal(t.byMap.length, 1);
  assert.equal(t.byMap[0]!.map, "Unknown");
  assert.equal(t.byMap[0]!.rounds, 2);
});

test("buildMatchTrends: timeline is oldest-first and hour buckets are UTC", () => {
  const t = buildMatchTrends([
    match({ startedAt: "2026-07-03T14:00:00Z" }),
    match({ startedAt: "2026-07-01T14:00:00Z" }),
    match({ startedAt: "2026-07-01T09:00:00Z" }),
  ]);
  assert.deepEqual(t.timeline.map((d) => d.date), ["2026-07-01", "2026-07-03"]);
  assert.equal(t.timeline[0]!.rounds, 2);
  assert.equal(t.byHour[14], 2);
  assert.equal(t.byHour[9], 1);
});

// ---------------------------------------------------------------- staff

test("buildStaffTeamAnalytics: shares sum to the whole and the busiest leads", () => {
  const a = buildStaffTeamAnalytics([
    audit({ actorUserId: "u1", actorName: "Alice", action: "player.kick" }),
    audit({ actorUserId: "u1", actorName: "Alice", action: "vip.grant" }),
    audit({ actorUserId: "u1", actorName: "Alice", action: "player.punish" }),
    audit({ actorUserId: "u2", actorName: "Bob", action: "config.update" }),
  ]);
  assert.equal(a.totalActions, 4);
  assert.equal(a.activeStaff, 2);
  assert.equal(a.members[0]!.name, "Alice");
  assert.equal(a.members[0]!.actions, 3);
  assert.equal(a.members[0]!.share, 0.75);
  assert.equal(a.busiestShare, 0.75);
  assert.equal(a.members.reduce((n, m) => n + m.share, 0), 1);
  // Work is categorised, not just counted — and finely enough to tell a kick from a punish.
  assert.equal(a.members[0]!.byCategory["kicks"], 1);
  assert.equal(a.members[0]!.byCategory["punishes"], 1);
  assert.equal(a.members[0]!.byCategory["vip"], 1);
  assert.equal(a.members[1]!.byCategory["settings"], 1, "config work is its own bucket, hideable on its own");
});

test("buildStaffTeamAnalytics: an actor with no user id is still one person, keyed by name", () => {
  const a = buildStaffTeamAnalytics([
    audit({ actorUserId: null, actorName: "system" }),
    audit({ actorUserId: null, actorName: "system" }),
  ]);
  assert.equal(a.activeStaff, 1);
  assert.equal(a.members[0]!.userId, null);
  assert.equal(a.members[0]!.actions, 2);
});

test("buildStaffTeamAnalytics: uncovered hours counts empty cells of the 168-hour week", () => {
  const empty = buildStaffTeamAnalytics([]);
  assert.equal(empty.uncoveredHours, 168);
  assert.equal(empty.busiestShare, null);

  const one = buildStaffTeamAnalytics([audit({ ts: "2026-07-01T10:00:00Z" })]);
  assert.equal(one.uncoveredHours, 167);
});

test("buildStaffTeamAnalytics: lastAt keeps the newest action, not the last row seen", () => {
  const a = buildStaffTeamAnalytics([
    audit({ ts: "2026-07-05T10:00:00Z" }),
    audit({ ts: "2026-07-09T10:00:00Z" }),
    audit({ ts: "2026-07-02T10:00:00Z" }),
  ]);
  assert.equal(a.members[0]!.lastAt, "2026-07-09T10:00:00Z");
});

// ---------------------------------------------------------------- map votes

test("buildMapVoteAnalytics: override rate is over FINISHED votes only", () => {
  const a = buildMapVoteAnalytics([
    { decidedAt: "2026-07-01T00:00:00Z", outcome: "vote", winnerName: "Foy", totalVotes: 10 },
    { decidedAt: "2026-07-01T02:00:00Z", outcome: "vote", winnerName: "SME", totalVotes: 6 },
    { decidedAt: "2026-07-02T00:00:00Z", outcome: "override", winnerName: "Foy", totalVotes: 4 },
    // An unfinished/cancelled vote must not dilute the rate.
    { decidedAt: "2026-07-02T02:00:00Z", outcome: "cancelled", winnerName: null, totalVotes: 0 },
  ], []);
  assert.equal(a.votesHeld, 4);
  assert.equal(a.decidedByVote, 2);
  assert.equal(a.overridden, 1);
  assert.equal(a.overrideRate, 1 / 3);
  assert.equal(a.totalBallots, 20);
  assert.equal(a.avgTurnout, 5);
});

test("buildMapVoteAnalytics: empty history reports nulls, not zeroes, for its rates", () => {
  const a = buildMapVoteAnalytics([], []);
  assert.equal(a.overrideRate, null);
  assert.equal(a.avgTurnout, null);
  assert.deepEqual(a.timeline, []);
});

test("buildMapVoteAnalytics: map rows carry the offer count behind the win rate", () => {
  const a = buildMapVoteAnalytics([], [
    { mapId: "foy", name: "Foy", offered: 10, won: 4, votes: 30 },
    { mapId: "sme", name: "SME", offered: 1, won: 1, votes: 3 },
  ]);
  assert.deepEqual(a.maps.map((m) => m.mapId), ["foy", "sme"]); // most-offered first
  assert.equal(a.maps[0]!.winRate, 0.4);
  // A 1-for-1 map reads as 100%, which is only safe because `offered` is right there.
  assert.equal(a.maps[1]!.winRate, 1);
  assert.equal(a.maps[1]!.offered, 1);
});

test("buildMapVoteAnalytics: a map never offered gets a null rate, not a divide by zero", () => {
  const a = buildMapVoteAnalytics([], [{ mapId: "x", name: "X", offered: 0, won: 0, votes: 0 }]);
  assert.equal(a.maps[0]!.winRate, null);
});

// ---------------------------------------------------------------- players

test("distribute: buckets are half-open and the last one is unbounded", () => {
  const d = distribute([0, 5, 10, 49, 50, 5000], [0, 10, 50], (n) => String(n));
  assert.deepEqual(d.buckets.map((b) => b.label), ["<10", "10–50", "50+"]);
  assert.deepEqual(d.buckets.map((b) => b.value), [2, 2, 2]);
  // Every value lands in exactly one bucket.
  assert.equal(d.buckets.reduce((n, b) => n + b.value, 0), 6);
  assert.equal(d.max, 5000);
});

test("distribute: an empty population has a zero max and no NaN percentiles", () => {
  const d = distribute([], [0, 10], (n) => String(n));
  assert.equal(d.max, 0);
  assert.equal(d.median, 0);
  assert.equal(d.p90, 0);
  assert.ok(!Number.isNaN(d.p99));
});

test("percentileOf: strictly-below definition, so the best player is not 100th", () => {
  const pop = [10, 20, 30, 40];
  assert.equal(percentileOf(35, pop), 75);
  assert.equal(percentileOf(10, pop), 0);   // ties do not count as below
  assert.equal(percentileOf(40, pop), 75);
  assert.equal(percentileOf(5, []), 0);     // no population, no claim
});

// ---------------------------------------------------------------- match standouts

function stat(p: Partial<PlayerMatchStatRow>): PlayerMatchStatRow {
  return {
    matchId: "m", playerId: "p", playerName: "P", serverId: "s", side: "allies",
    kills: 0, deaths: 0, teamkills: 0, updatedAt: "2026-07-01T00:00:00Z",
    ...p,
  } as PlayerMatchStatRow;
}

test("matchStandouts: the K/D board needs a minimum sample", () => {
  const s = matchStandouts([
    stat({ playerId: "cameo", playerName: "Cameo", kills: 1, deaths: 0 }),  // K/D 1 kill, infinite ratio
    stat({ playerId: "real", playerName: "Real", kills: 30, deaths: 5 }),
    stat({ playerId: "tk", playerName: "Tk", kills: 6, deaths: 6, teamkills: 4 }),
  ]);
  assert.equal(s.topKills[0]!.playerId, "real");
  // The 1-kill cameo would otherwise top the ratio board on a single lucky shot.
  assert.ok(!s.topKd.some((r) => r.playerId === "cameo"));
  assert.equal(s.topKd[0]!.playerId, "real");
  assert.equal(s.worstTk[0]!.playerId, "tk");
  assert.equal(s.worstTk.length, 1); // only players who actually team-killed appear
});

// ---------------------------------------------------------------- combat

const CLASSES: Record<string, { id: string; label: string }> = {
  "M1 GARAND": { id: "rifle", label: "Rifle" },
  THOMPSON: { id: "smg", label: "SMG" },
  "155MM HOWITZER": { id: "artillery", label: "Artillery" },
};
const classify = (w: string) => CLASSES[w] ?? { id: "other", label: "Other" };

test("buildCombatSummary: friendly-fire rate is per 100 kills, not a raw count", () => {
  const c = buildCombatSummary(
    { kills: 1000, teamkills: 30, killers: 40, victims: 60 },
    [
      // A popular rifle with more RAW team kills than the artillery…
      { weapon: "M1 GARAND", kills: 900, teamkills: 18 },
      // …but the artillery kills a teammate one time in five.
      { weapon: "155MM HOWITZER", kills: 60, teamkills: 12 },
    ],
    classify,
  );
  assert.equal(c.tkRate, 3);
  const rifle = c.weapons.find((w) => w.weapon === "M1 GARAND")!;
  const arty = c.weapons.find((w) => w.weapon === "155MM HOWITZER")!;
  assert.equal(rifle.tkRate, 2);
  assert.equal(arty.tkRate, 20);
  // Ranked by rate, the artillery leads despite having fewer team kills in total.
  assert.equal(c.friendlyFireWeapons[0]!.weapon, "155MM HOWITZER");
});

test("buildCombatSummary: a weapon under the sample floor cannot top the friendly-fire list", () => {
  const c = buildCombatSummary(
    { kills: 500, teamkills: 5, killers: 10, victims: 20 },
    [
      { weapon: "M1 GARAND", kills: 480, teamkills: 4 },
      // 100% friendly-fire rate — over one kill. Exactly the noise the floor exists to exclude.
      { weapon: "SATCHEL", kills: 1, teamkills: 1 },
    ],
    classify,
  );
  assert.ok(!c.friendlyFireWeapons.some((w) => w.weapon === "SATCHEL"));
  assert.equal(c.friendlyFireWeapons[0]!.weapon, "M1 GARAND");
  // It is still listed in the full weapon table — excluded from the RANKING, not from the data.
  assert.ok(c.weapons.some((w) => w.weapon === "SATCHEL"));
});

test("buildCombatSummary: class shares account for every kill, unknown weapons included", () => {
  const c = buildCombatSummary(
    { kills: 100, teamkills: 0, killers: 5, victims: 9 },
    [
      { weapon: "M1 GARAND", kills: 50, teamkills: 0 },
      { weapon: "THOMPSON", kills: 30, teamkills: 0 },
      { weapon: "SOMETHING WE DO NOT KNOW", kills: 20, teamkills: 0 },
    ],
    classify,
  );
  assert.equal(c.classes.reduce((n, x) => n + x.kills, 0), 100);
  assert.ok(Math.abs(c.classes.reduce((n, x) => n + x.share, 0) - 1) < 1e-9);
  assert.equal(c.classes.find((x) => x.id === "other")!.kills, 20, "an unrecognised weapon is bucketed, never dropped");
});

test("buildCombatSummary: an empty window divides by nothing", () => {
  const c = buildCombatSummary({ kills: 0, teamkills: 0, killers: 0, victims: 0 }, [], classify);
  assert.equal(c.tkRate, null);
  assert.deepEqual(c.weapons, []);
  assert.deepEqual(c.friendlyFireWeapons, []);
});

// ---------------------------------------------------------------- admin response

const req = (ts: string, serverId = "s1") => ({ ts, serverId, playerName: "P", playerId: "p", message: "!admin help" });
const act = (ts: string, serverId: string | null = "s1", actorName = "Alice") => ({ ts, serverId, actorName, action: "player.kick" });

test("pairAdminResponses: pairs a call with the next action on the SAME server", () => {
  const paired = pairAdminResponses(
    [req("2026-07-01T10:00:00Z")],
    [act("2026-07-01T10:00:30Z")],
  );
  assert.equal(paired[0]!.responseSec, 30);
  assert.equal(paired[0]!.respondedBy, "Alice");
});

test("pairAdminResponses: an action on another server is not an answer", () => {
  const paired = pairAdminResponses(
    [req("2026-07-01T10:00:00Z", "s1")],
    [act("2026-07-01T10:00:30Z", "s2")],
  );
  assert.equal(paired[0]!.responseSec, null);
});

test("pairAdminResponses: one action answers ONE call, not every call before it", () => {
  // Three people call for help in the same minute and staff do exactly one thing. Without the
  // used-set this reports three fast responses — flattering the team most on the night they were
  // most overwhelmed.
  const paired = pairAdminResponses(
    [req("2026-07-01T10:00:00Z"), req("2026-07-01T10:00:10Z"), req("2026-07-01T10:00:20Z")],
    [act("2026-07-01T10:01:00Z")],
  );
  assert.equal(paired.filter((r) => r.responseSec != null).length, 1);
  assert.equal(paired[0]!.responseSec, 60);
  assert.equal(paired[1]!.responseSec, null);
  assert.equal(paired[2]!.responseSec, null);
});

test("pairAdminResponses: past the cutoff a call is unanswered, not answered very slowly", () => {
  const paired = pairAdminResponses(
    [req("2026-07-01T10:00:00Z")],
    [act("2026-07-01T12:00:00Z")],
    1800,
  );
  assert.equal(paired[0]!.responseSec, null);
});

test("pairAdminResponses: an action BEFORE the call never counts", () => {
  const paired = pairAdminResponses(
    [req("2026-07-01T10:00:00Z")],
    [act("2026-07-01T09:59:00Z")],
  );
  assert.equal(paired[0]!.responseSec, null);
});

test("buildAdminResponseAnalytics: medians come from answered calls only", () => {
  const a = buildAdminResponseAnalytics(pairAdminResponses(
    [req("2026-07-01T10:00:00Z"), req("2026-07-01T11:00:00Z"), req("2026-07-01T12:00:00Z")],
    [act("2026-07-01T10:00:10Z"), act("2026-07-01T11:00:30Z")],
  ));
  assert.equal(a.requests, 3);
  assert.equal(a.answered, 2);
  assert.equal(a.unanswered, 1);
  assert.equal(a.answeredRate, 2 / 3);
  // 10s and 30s — the unanswered call must not enter as a zero or as some huge number.
  assert.equal(a.medianSec, 20);
  assert.equal(a.byHour[10], 1);
  assert.equal(a.byHour[12], 1);
  assert.equal(a.medianByHour[12], null, "an hour with no answered call reports null, not 0");
  assert.equal(a.slowest[0]!.responseSec, 30);
});

test("buildAdminResponseAnalytics: no calls at all is nulls, not zeroes", () => {
  const a = buildAdminResponseAnalytics([]);
  assert.equal(a.requests, 0);
  assert.equal(a.answeredRate, null);
  assert.equal(a.medianSec, null);
  assert.equal(a.p90Sec, null);
});

/*
 * Every "by hour", "by day" and week-grid figure used to be bucketed in UTC, whatever the reader's
 * clock. For a community that is not on UTC that is not a rounding error — it moves activity to the
 * wrong DAY, and the charts stay confidently wrong rather than going empty, which is the harder
 * kind to notice. A Saturday-evening peak in US Central is the busiest slot a game community has,
 * and in a UTC grid it lands on Sunday morning.
 */
test("the week grid buckets in the viewer's zone, not UTC", async () => {
  const { weekHourGrid } = await import("../dist/analytics.js");
  // Saturday 2026-07-04, 20:30 US Central = Sunday 2026-07-05, 01:30 UTC.
  const ts = ["2026-07-05T01:30:00.000Z"];

  const utc = weekHourGrid(ts);
  assert.equal(utc[0]![1], 1, "in UTC this is Sunday 01:00");
  assert.equal(utc[6]![20], 0, "and nothing on Saturday evening");

  const central = weekHourGrid(ts, "America/Chicago");
  assert.equal(central[6]![20], 1, "locally it is Saturday 20:00 — the busiest slot of the week");
  assert.equal(central[0]![1], 0, "and nothing on Sunday morning");

  // The default is still UTC, so a client that sends no zone gets exactly what it got before.
  assert.deepEqual(weekHourGrid(ts), weekHourGrid(ts, "UTC"));
  // An unusable zone falls back rather than throwing — this runs inside a request handler.
  assert.doesNotThrow(() => weekHourGrid(ts, "Not/AZone"));
  assert.deepEqual(weekHourGrid(ts, "Not/AZone"), utc);
});

test("hourIn and dayIn move a timestamp across the date line where they should", async () => {
  const { hourIn, dayIn } = await import("../dist/analytics.js");
  const lateEvening = "2026-07-05T01:30:00.000Z"; // Sat 20:30 in Chicago, Sun 01:30 UTC

  assert.equal(hourIn(lateEvening, "UTC"), 1);
  assert.equal(hourIn(lateEvening, "America/Chicago"), 20);
  assert.equal(dayIn(lateEvening, "UTC"), "2026-07-05");
  assert.equal(dayIn(lateEvening, "America/Chicago"), "2026-07-04", "the calendar day differs, not just the hour");

  // The other direction: a zone ahead of UTC.
  assert.equal(dayIn("2026-07-04T23:30:00.000Z", "Australia/Sydney"), "2026-07-05");
  assert.equal(hourIn("2026-07-04T23:30:00.000Z", "Australia/Sydney"), 9);

  // Junk in, no throw: these run per row inside a request handler.
  assert.equal(hourIn("not a date", "UTC"), null);
  assert.equal(dayIn("not a date", "UTC"), "not a date".slice(0, 10));
});

test("staff coverage counts the hours a community actually plays", async () => {
  const { buildStaffTeamAnalytics } = await import("../dist/analytics.js");
  // Five actions across one Saturday evening in Chicago — 20:00-22:00 local, which is 01:00-03:00
  // Sunday in UTC. In UTC these read as two different days.
  const entries = ["01:00", "01:30", "02:00", "02:30", "03:00"].map((hm, i) => ({
    id: `a${i}`, ts: `2026-07-05T${hm}:00.000Z`, actorUserId: "u1", actorName: "sam",
    action: "player.kick", targetType: "player", targetId: null, targetName: null,
    serverId: null, summary: "", data: null,
  }));

  const utc = buildStaffTeamAnalytics(entries as never);
  const central = buildStaffTeamAnalytics(entries as never, "America/Chicago");

  // Same total work either way — only WHEN it is credited moves.
  assert.equal(utc.totalActions, central.totalActions);
  assert.equal(utc.byHour[1], 2, "UTC puts this in the small hours");
  assert.equal(central.byHour[20], 2, "the community sees its own Saturday evening");
  assert.equal(central.byHour[1], 0);

  // The WEEK grid must agree with byHour — it is what uncoveredHours reads, and a UTC grid beside
  // a zoned byHour put the coverage gaps on the wrong day of the week. Saturday 20:00 Chicago is
  // Sunday 01:00 UTC, so the two grids disagree about both the day AND the hour.
  assert.equal(central.weekHour[6]![20], 2, "the grid credits Saturday evening, like byHour does");
  assert.equal(central.weekHour[0]![1], 0, "and nothing lands on Sunday morning");
  assert.equal(utc.weekHour[0]![1], 2, "while the UTC default keeps its old reading");
});

test("the admin-response week grid buckets in the community's zone too", async () => {
  const { buildAdminResponseAnalytics } = await import("../dist/analytics.js");
  // One !admin call on Saturday 20:30 in Chicago (= Sunday 01:30 UTC), already paired.
  const paired = [{
    ts: "2026-07-05T01:30:00.000Z", serverId: "s1", playerName: "p", playerId: null,
    message: "!admin help", responseSec: 60, respondedBy: "sam", respondedAction: "player.kick",
  }];

  const central = buildAdminResponseAnalytics(paired, "America/Chicago");
  assert.equal(central.byHour[20], 1);
  assert.equal(central.weekHour[6]![20], 1, "the call lands on the community's Saturday evening");
  assert.equal(central.weekHour[0]![1], 0, "not on UTC's Sunday morning");

  const utc = buildAdminResponseAnalytics(paired);
  assert.equal(utc.weekHour[0]![1], 1, "the UTC default keeps its old reading");
});


test("teamCategoryOf: the buckets split what staff actually do", async () => {
  const { teamCategoryOf } = await import("../dist/analytics.js");
  assert.equal(teamCategoryOf("player.message"), "messages");
  assert.equal(teamCategoryOf("message.all"), "messages");
  assert.equal(teamCategoryOf("player.kick"), "kicks");
  assert.equal(teamCategoryOf("player.punish"), "punishes");
  assert.equal(teamCategoryOf("player.switch_death"), "switches");
  assert.equal(teamCategoryOf("player.tempban"), "tempbans");
  assert.equal(teamCategoryOf("player.permaban"), "permabans");
  // Lifting is its own work, and "unban_perma" carries both verbs — unban must win.
  assert.equal(teamCategoryOf("player.unban_perma"), "unbans");
  assert.equal(teamCategoryOf("player.unban_temp"), "unbans");
  assert.equal(teamCategoryOf("bans.seed"), "banrecord");
  assert.equal(teamCategoryOf("vip.grant"), "vip");
  assert.equal(teamCategoryOf("player.watchlist"), "records");
  assert.equal(teamCategoryOf("player.note"), "records");
  assert.equal(teamCategoryOf("player.link"), "records");
  assert.equal(teamCategoryOf("map.rotation.remove"), "maprotation");
  assert.equal(teamCategoryOf("maps.next"), "maprotation");
  assert.equal(teamCategoryOf("mapvote.pause"), "mapvotes");
  assert.equal(teamCategoryOf("economy.payoutEvent.update"), "economy");
  assert.equal(teamCategoryOf("payout.run"), "economy");
  assert.equal(teamCategoryOf("server.automation"), "settings");
  assert.equal(teamCategoryOf("seeding.config"), "settings");
  assert.equal(teamCategoryOf("import.crcon.transform"), "settings");
  // Approval paperwork is its own bucket, and the verb it carries never leaks into the work
  // itself: signing off a ban is not banning (the ban is counted against the requester).
  assert.equal(teamCategoryOf("request.file"), "approvals");
  assert.equal(teamCategoryOf("request.approve"), "approvals");
  assert.equal(teamCategoryOf("request.deny"), "approvals");
  assert.equal(teamCategoryOf("request.withdraw"), "approvals");
  assert.equal(teamCategoryOf("something.new"), "other");
});

test("the team page's category list mirrors this one, in the same order", async () => {
  /**
   * The panel has no workspace dependency on the API, so it hand-copies TEAM_CATEGORIES — and a
   * category present in the data but missing from that copy is work nobody can see: the API counts
   * it, the page never draws a row for it, and the mix silently fails to sum to the total. The
   * staff-profile pair has had this guard since it drifted; this pair never did, and `approvals`
   * had to be hand-mirrored into both halves to add it.
   */
  const { TEAM_CATEGORIES } = await import("../dist/analytics.js");
  const src = readFileSync(new URL("../../panel/components/analytics/StaffAnalytics.tsx", import.meta.url), "utf8");
  const block = /const CATEGORIES = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, "could not find CATEGORIES in StaffAnalytics.tsx — if it was renamed, update this test");
  const mirrored = [...block[1]!.matchAll(/key: "([a-z]+)", label: "([^"]+)"/g)].map((m) => ({ key: m[1], label: m[2] }));
  assert.deepEqual(mirrored, TEAM_CATEGORIES.map((c: { key: string; label: string }) => ({ key: c.key, label: c.label })),
    "the panel's copy of the team categories has drifted");
});

test("countableActions: one volley counts once; the trail rows themselves are untouched input", async () => {
  const { countableActions, buildStaffTeamAnalytics } = await import("../dist/analytics.js");
  const volley = Array.from({ length: 100 }, (_, i) => audit({
    id: `b${i}`, actorUserId: "u1", action: "player.message", serverId: "s1",
    ts: `2026-07-01T10:0${i < 60 ? 0 : 1}:${String(i % 60).padStart(2, "0")}Z`, data: { bulk: true },
  }));
  const single = audit({ id: "one", actorUserId: "u1", action: "player.kick", ts: "2026-07-01T10:05:00Z" });

  const collapsed = countableActions([...volley, single]);
  // The 100-row volley spans a minute boundary, so it counts as its two minute-buckets — never 100.
  assert.equal(collapsed.filter((e) => e.action === "player.message").length, 2);
  assert.equal(collapsed.filter((e) => e.action === "player.kick").length, 1);

  // Two volleys minutes apart stay two: collapsing is per volley, not per day.
  const later = Array.from({ length: 5 }, (_, i) => audit({
    id: `c${i}`, actorUserId: "u1", action: "player.message", serverId: "s1",
    ts: "2026-07-01T11:00:01Z", data: { bulk: true },
  }));
  assert.equal(countableActions([...volley.slice(0, 5), ...later]).length, 2);

  // Unmarked rows never collapse, even when they look identical — only the write path may say
  // "this was one volley", by stamping data.bulk.
  const twins = [audit({ id: "t1", ts: "2026-07-01T10:00:00Z" }), audit({ id: "t2", ts: "2026-07-01T10:00:01Z" })];
  assert.equal(countableActions(twins).length, 2);

  // And the point of it all: the team page sees one action, not a hundred.
  const team = buildStaffTeamAnalytics(countableActions(volley.slice(0, 50)));
  assert.equal(team.totalActions, 1);

  /*
   * A continuation is not a new act. The second half of an over-cap temp ban is the same sentence
   * reaching the length asked for — counted, a 48h ban signed in two halves read as two bans, and
   * grew another one every rung it climbed.
   */
  const ban = audit({ id: "ban1", actorUserId: "u1", action: "player.tempban", ts: "2026-07-02T10:00:00Z", data: { hours: 24 } });
  const extend = audit({ id: "ban2", actorUserId: "u1", action: "player.tempban", ts: "2026-07-02T12:00:00Z", data: { hours: 48, continues: "decision-1" } });
  assert.deepEqual(countableActions([ban, extend]).map((e) => e.id), ["ban1"]);
  assert.equal(buildStaffTeamAnalytics([ban, extend].map((e) => e)).totalActions, 2, "…and the raw rows are two — the filter is what makes it one");
  assert.equal(buildStaffTeamAnalytics(countableActions([ban, extend])).totalActions, 1);
});

/*
 * Bans in the By platform split. A decision counts when it was made inside the window and its rule
 * covers the server being looked at, under the banned player's platform and on the LOCAL day it was
 * made.
 */
test("platform split: bans counted by kind, window, coverage and local day", () => {
  const platforms: Record<string, string> = { box1: "EPlatformFamily::XboxSeries", box2: "EPlatformFamily::XboxSeries", pc1: "steam" };
  const covered = new Set(["covered"]);
  const ban = (playerId: string, kind: "temp" | "perma", createdAt: string, scope = "covered") =>
    ({ playerId, kind, createdAt, game: "hll", scope: { mode: "servers" as const, serverIds: [scope] } });
  const out = foldPlatformModeration(
    [{ platform: "steam", ...emptyPlatformSums(), players: 9, kills: 40 }],
    [{ ...emptyPlatformTrendRow("2026-06-04", "steam"), players: 9 }],
    {
      bans: [
        ban("box1", "temp", "2026-06-05T03:00:00.000Z"), // 22:00 the evening before, in Chicago
        ban("box2", "temp", "2026-06-05T18:00:00.000Z"),
        ban("box1", "perma", "2026-06-05T19:00:00.000Z"),
        ban("pc1", "temp", "2026-06-04T15:00:00.000Z"),
        ban("ghost", "perma", "2026-06-05T20:00:00.000Z"), // never seen: counted, under "unknown"
        ban("box2", "temp", "2026-06-05T21:00:00.000Z", "elsewhere"), // a rule that does not cover it
        ban("box2", "perma", "2026-05-01T00:00:00.000Z"), // before the window
        ban("box2", "perma", "2026-06-07T00:00:00.000Z"), // after it
      ],
      vipStretches: [],
      platformOf: (id) => platforms[id],
      covers: (b) => (b.scope as { serverIds: string[] }).serverIds.some((id) => covered.has(id)),
      from: "2026-06-03T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z", tz: "America/Chicago",
    },
  );
  const row = (p: string) => out.rows.find((r) => r.platform === p);
  assert.deepEqual(out.rows.map((r) => r.platform), ["steam", "EPlatformFamily::XboxSeries", "unknown"],
    "the stores' rank holds: platforms only bans know of come after the ones that played");
  assert.deepEqual([row("EPlatformFamily::XboxSeries")?.tempBans, row("EPlatformFamily::XboxSeries")?.permaBans], [2, 1]);
  assert.deepEqual([row("steam")?.tempBans, row("steam")?.permaBans], [1, 0]);
  assert.equal(row("steam")?.players, 9, "the stores' sums ride through untouched");
  assert.deepEqual([row("unknown")?.permaBans, row("unknown")?.players], [1, 0], "a stranger's ban is still a ban");

  const day = (date: string, p: string) => out.trend.find((r) => r.date === date && r.platform === p);
  assert.equal(day("2026-06-04", "EPlatformFamily::XboxSeries")?.tempBans, 1, "03:00 UTC is still the 4th in Chicago");
  assert.equal(day("2026-06-05", "EPlatformFamily::XboxSeries")?.tempBans, 1);
  assert.equal(day("2026-06-05", "EPlatformFamily::XboxSeries")?.permaBans, 1);
  assert.deepEqual([day("2026-06-04", "steam")?.tempBans, day("2026-06-04", "steam")?.players], [1, 9], "joined onto the store's own day row");
  assert.deepEqual(out.trend.map((r) => `${r.date} ${r.platform}`), [
    "2026-06-04 EPlatformFamily::XboxSeries", "2026-06-04 steam", "2026-06-05 EPlatformFamily::XboxSeries", "2026-06-05 unknown",
  ], "date order, then platform, as the stores sort");
});

/*
 * VIPs in the By platform split, from runs the VIP history replay rebuilt: on each LOCAL day,
 * everybody whose VIP ran for any part of it; over the window, everybody who held it at all. Both
 * count people, so two runs of one player are one VIP, and every day of the window is listed.
 */
test("platform split: VIPs on every local day a run touches, once per player, every day listed — and once more on their first day", () => {
  const platforms: Record<string, string> = { box1: "EPlatformFamily::XboxSeries", box2: "EPlatformFamily::XboxSeries", pc1: "steam", pc2: "steam" };
  const ms = (iso: string) => Date.parse(iso);
  const out = foldPlatformModeration([], [], {
    bans: [],
    vipStretches: [
      // Chicago: the 2nd 07:00 to the 3rd 22:00, clipped to the window (from the 2nd 19:00): two days.
      { playerId: "box1", from: ms("2026-06-02T12:00:00Z"), to: ms("2026-06-04T03:00:00Z") },
      // The same player again on the 5th: one VIP in the window all the same.
      { playerId: "box1", from: ms("2026-06-05T12:00:00Z"), to: ms("2026-06-07T00:00:00Z") },
      { playerId: "pc1", from: ms("2026-05-01T00:00:00Z"), to: ms("2026-06-10T00:00:00Z") }, // the whole window
      { playerId: "box2", from: ms("2026-05-01T00:00:00Z"), to: ms("2026-06-02T00:00:00Z") }, // over before it began
      // Two runs, the later one listed first: the 5th, and the 3rd (Chicago mornings).
      { playerId: "pc2", from: ms("2026-06-05T14:00:00Z"), to: ms("2026-06-05T20:00:00Z") },
      { playerId: "pc2", from: ms("2026-06-03T15:00:00Z"), to: ms("2026-06-03T20:00:00Z") },
    ],
    platformOf: (id) => platforms[id],
    covers: () => true,
    from: "2026-06-03T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z", tz: "America/Chicago",
  });
  const row = (p: string) => out.rows.find((r) => r.platform === p);
  assert.deepEqual([row("EPlatformFamily::XboxSeries")?.vips, row("steam")?.vips], [1, 2], "people, not runs");
  const days = ["2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"];
  const on = (date: string, p: string) => out.trend.find((r) => r.date === date && r.platform === p);
  assert.deepEqual(days.map((d) => on(d, "EPlatformFamily::XboxSeries")?.vips ?? 0), [1, 1, 0, 1]);
  assert.deepEqual(days.map((d) => on(d, "steam")?.vips ?? 0), [1, 2, 1, 2]);
  assert.deepEqual(out.vipDaily, [
    { date: "2026-06-02", vips: 2 }, { date: "2026-06-03", vips: 3 }, { date: "2026-06-04", vips: 1 }, { date: "2026-06-05", vips: 3 },
  ], "every local day of the window, in Chicago, with nobody counted twice");
  // Each VIP once more, on their first day with VIP in the window: what the chart's running count
  // adds up, ending at the window's VIPs where adding up the days would count them once a day.
  assert.deepEqual(days.map((d) => on(d, "EPlatformFamily::XboxSeries")?.firstVips ?? 0), [1, 0, 0, 0]);
  assert.deepEqual(days.map((d) => on(d, "steam")?.firstVips ?? 0), [1, 1, 0, 0], "pc2 on the 3rd, the earlier run, though it was listed second");
});
