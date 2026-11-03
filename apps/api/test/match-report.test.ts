/**
 * The match report builder: the round-level reads (class split, flow timeline, duels, awards)
 * layered over the same fold the public scoreboard uses. Sides come from the stat rows, kills
 * only from evt.kill — a teamkill shapes streaks and the TK award, never the class split.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Read from dist: match-report imports streamer by its emitted .js name, which strip-types
// cannot resolve back to a .ts source — the same reason the staff-analytics tests read dist.
import { buildMatchReport, publicMatchReport, headcountTimeline, HEADCOUNT_MAX_MINUTES } from "../dist/match-report.js";
import type { ReportStatRow } from "../src/match-report.ts";

const CLASSES: Record<string, { id: string; label: string }> = {
  "M1 GARAND": { id: "rifle", label: "Rifle" },
  "155MM HOWITZER": { id: "artillery", label: "Artillery" },
  "MG42": { id: "mg", label: "Machine gun" },
  "MK2 GRENADE": { id: "grenade", label: "Grenades" },
};
const classify = (w: string) => CLASSES[w] ?? { id: "other", label: "Other" };

const T0 = "2026-08-01T20:00:00.000Z";
const at = (secs: number) => new Date(Date.parse(T0) + secs * 1000).toISOString();
const kill = (secs: number, actor: string, victim: string, weapon: string, kind = "evt.kill") => ({
  ts: at(secs), kind, actorPlayerId: actor, actorName: actor, victimPlayerId: victim, victimName: victim, weapon,
});
const row = (playerId: string, side: "allies" | "axis", over: Partial<ReportStatRow> = {}): ReportStatRow => ({
  playerId, playerName: playerId, side, kills: 0, deaths: 0, teamkills: 0,
  combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, slSeconds: 0, ...over,
});

test("class split, flow buckets, duels and awards all read from the same stream", () => {
  const stats = [
    row("Ana", "allies", { kills: 4, deaths: 1, teamkills: 3, support: 20 }),
    row("Bob", "allies", { kills: 0, deaths: 1, support: 450 }),
    row("Xen", "axis", { kills: 1, deaths: 3 }),
    row("Yak", "axis", { deaths: 1 }),
  ];
  const events = [
    kill(10, "Ana", "Xen", "M1 GARAND"),
    kill(30, "Ana", "Yak", "M1 GARAND"),
    kill(70, "Ana", "Xen", "155MM HOWITZER"),
    kill(90, "Xen", "Ana", "MG42"),
    kill(95, "Ana", "Bob", "MK2 GRENADE", "evt.teamkill"),
    kill(100, "Ana", "Xen", "M1 GARAND"),
  ];
  const r = buildMatchReport({ events, stats, startedAt: T0, endedAt: at(600), classify });

  assert.equal(r.complete, true);
  // Rifle 3-0, artillery 1-0, MG 0-1 — the teamkill's grenade never enters the split.
  assert.deepEqual(r.classSplit, [
    { classId: "rifle", label: "Rifle", allies: 3, axis: 0 },
    { classId: "artillery", label: "Artillery", allies: 1, axis: 0 },
    { classId: "mg", label: "Machine gun", allies: 0, axis: 1 },
  ]);

  // The same split one weapon finer, sorted by total then name — the TK grenade stays out here too.
  assert.deepEqual(r.weaponSplit, [
    { weapon: "M1 GARAND", allies: 3, axis: 0 },
    { weapon: "155MM HOWITZER", allies: 1, axis: 0 },
    { weapon: "MG42", allies: 0, axis: 1 },
  ]);

  // One-minute buckets: minute 0 holds the first two, minute 1 the 70/90/100-second kills.
  assert.equal(r.bucketMinutes, 1);
  assert.deepEqual(r.timeline[0], { minute: 0, allies: 2, axis: 0 });
  assert.deepEqual(r.timeline[1], { minute: 1, allies: 2, axis: 1 });

  // Ana↔Xen met four times, Ana ahead 3–1; every other pair is too small to be a duel.
  assert.deepEqual(r.duels, [{ aId: "Ana", aName: "Ana", bId: "Xen", bName: "Xen", aKills: 3, bKills: 1 }]);

  // The fold rides along: Ana's streak survives her TK and resets on her death.
  assert.equal(r.players["Ana"]!.side, "allies", "the drill-in and the race chart colour by this");
  assert.equal(r.players["Ana"]!.killsStreak, 3);
  assert.deepEqual(r.players["Ana"]!.weapons[0], ["M1 GARAND", 3]);
  assert.deepEqual(r.players["Ana"]!.mostKilled[0], ["Xen", 3]);

  const byId = new Map(r.awards.map((a) => [a.id, a]));
  assert.equal(byId.get("kills")?.playerName, "Ana");
  assert.equal(byId.get("support")?.playerName, "Bob", "the award reads the stat rows, not the kill stream");
  assert.equal(byId.get("tks")?.playerName, "Ana");
  assert.equal(byId.get("kd"), undefined, "no K/D award under ten kills — a 4-kill round proves nothing");
  assert.equal(byId.get("vehicles"), undefined, "no vehicle kills, no tanker chip");
  assert.equal(byId.get("firstblood")?.playerName, "Ana");
  assert.equal(byId.get("firstblood")?.value, "0:10");
  assert.equal(byId.get("burst"), undefined, "Ana never lands three kills inside 30 seconds here");

  // A round with no captured kill log keeps the honest flag and draws nothing.
  const bare = buildMatchReport({ events: [], stats, startedAt: T0, endedAt: at(600), classify });
  assert.equal(bare.complete, false);
  assert.deepEqual(bare.classSplit, []);
  assert.deepEqual(bare.weaponSplit, []);
  assert.deepEqual(bare.duels, []);
});

test("per-player timeline keeps the whole round in order; burst needs three kills in 30 seconds", () => {
  const stats = [row("Ana", "allies"), row("Xen", "axis")];
  const events = [
    kill(12, "Xen", "Ana", "MG42"),
    kill(40, "Ana", "Xen", "M1 GARAND"),
    kill(50, "Ana", "Xen", "M1 GARAND"),
    kill(65, "Ana", "Xen", "MK2 GRENADE"),
    kill(300, "Ana", "Xen", "M1 GARAND"),
  ];
  const r = buildMatchReport({ events, stats, startedAt: T0, endedAt: at(600), classify });

  // Ana's personal timeline: her opening death rides along with her kills, seconds since kickoff.
  assert.deepEqual(r.players["Ana"]!.timeline, [
    [12, "d", "Xen", "MG42"],
    [40, "k", "Xen", "M1 GARAND"],
    [50, "k", "Xen", "M1 GARAND"],
    [65, "k", "Xen", "MK2 GRENADE"],
    [300, "k", "Xen", "M1 GARAND"],
  ]);

  const byId = new Map(r.awards.map((a) => [a.id, a]));
  assert.equal(byId.get("firstblood")?.playerName, "Xen", "the opening kill is the stream's, not the top fragger's");
  assert.equal(byId.get("firstblood")?.value, "0:12");
  // Ana's 40/50/65 kills span 25 seconds — a burst. Her 300-second kill sits outside every window.
  assert.equal(byId.get("burst")?.playerName, "Ana");
  assert.equal(byId.get("burst")?.value, "3 in 30s");
});

/*
 * The public wire is keyed by DISPLAY NAME, because internal ids must never cross it. Nothing
 * stops two people wearing one name in a round, and a name-keyed map would then publish one of
 * them under the other's row: the scoreboard would drill into the wrong player's round, silently.
 * Neither is published instead — everyone else on the round is unaffected.
 */
test("two players wearing one name are both withheld from the public wire, not merged", () => {
  const stats = [
    row("p1", "allies", { playerName: "Nemesis", kills: 2, deaths: 0 }),
    row("p2", "axis", { playerName: "Nemesis", kills: 1, deaths: 2 }),
    row("p3", "allies", { playerName: "Solo", kills: 1, deaths: 1 }),
  ];
  const events = [
    kill(10, "p1", "p2", "M1 GARAND"),
    kill(20, "p1", "p2", "M1 GARAND"),
    kill(30, "p2", "p3", "MG42"),
    kill(40, "p3", "p2", "M1 GARAND"),
  ];
  const r = buildMatchReport({ events, stats, startedAt: T0, endedAt: at(600), classify });
  const names: Record<string, string> = { p1: "Nemesis", p2: "Nemesis", p3: "Solo" };
  const pub = publicMatchReport(r, (id) => names[id] ?? null);

  assert.equal(pub.players["Nemesis"], undefined, "a name two players shared is not an identity, so it publishes nobody");
  assert.equal(pub.players["Solo"]?.timeline.length, 2, "the rest of the round is untouched");
  // The internal ids stay internal whatever happens with names.
  assert.deepEqual(Object.keys(pub.players), ["Solo"]);
  // ...and the wire says WHICH name it withheld, so the page can name the reason on that row
  // instead of showing an unexplained gap.
  assert.deepEqual(pub.sharedNames, ["Nemesis"]);
});

/* A player the caller cannot name is withheld — and does not take a namesake down with them. */
test("an unnamed player is withheld without disturbing the players who are named", () => {
  const stats = [row("p1", "allies", { playerName: "Ana", kills: 1 }), row("p2", "axis", { playerName: "", kills: 1 })];
  const events = [kill(10, "p1", "p2", "M1 GARAND"), kill(20, "p2", "p1", "MG42")];
  const r = buildMatchReport({ events, stats, startedAt: T0, endedAt: at(600), classify });
  const pub = publicMatchReport(r, (id) => (id === "p1" ? "Ana" : null));
  assert.deepEqual(Object.keys(pub.players), ["Ana"]);
  assert.deepEqual(pub.sharedNames, [], "unnamed is not the same as shared");
});

/*
 * Names are whatever players type, and the tallies keyed by them were plain objects. A player named
 * "__proto__" set the object's prototype instead of a row, and vanished from the public round. One
 * named "constructor" or "toString" was counted on from Object's own function, so the staff match
 * page gave "function Object() { [native code] }1" as how often they were killed.
 */
test("players named like an object's built-in properties are counted and published like anyone", () => {
  const names: Record<string, string> = { p1: "__proto__", p2: "constructor", p3: "toString" };
  const stats = [row("p1", "allies", { playerName: names.p1, kills: 3, deaths: 1 }), row("p2", "axis", { playerName: names.p2, kills: 1, deaths: 2 }), row("p3", "axis", { playerName: names.p3, deaths: 1 })];
  const named = (secs: number, actor: string, victim: string, weapon: string) => ({ ...kill(secs, actor, victim, weapon), actorName: names[actor]!, victimName: names[victim]! });
  const events = [
    named(10, "p1", "p2", "M1 GARAND"),
    named(20, "p1", "p2", "M1 GARAND"),
    named(30, "p2", "p1", "MG42"),
    named(40, "p1", "p3", "M1 GARAND"),
  ];
  const r = buildMatchReport({ events, stats, startedAt: T0, endedAt: at(600), classify });
  assert.deepEqual(r.players["p1"]!.mostKilled, [["constructor", 2], ["toString", 1]]);
  assert.deepEqual(r.players["p1"]!.deathBy, [["constructor", 1]]);
  assert.deepEqual(r.players["p2"]!.mostKilled, [["__proto__", 1]]);
  assert.deepEqual(r.players["p2"]!.deathBy, [["__proto__", 2]]);
  assert.deepEqual(r.players["p3"]!.deathBy, [["__proto__", 1]]);

  const pub = JSON.parse(JSON.stringify(publicMatchReport(r, (id) => names[id] ?? null))) as { players: Record<string, { timeline: unknown[] }> };
  assert.deepEqual(Object.keys(pub.players).sort(), ["__proto__", "constructor", "toString"], "each is a row of its own on the wire");
  assert.equal(pub.players["__proto__"]!.timeline.length, 4);
});

/*
 * A team kill is not a kill. The kill race counts a player's "k" marks and the personal timeline
 * climbs on them, so a team kill carried as one put a player's own-side kills on top of their real
 * ones: 38 kills and 6 team kills raced to 44 while the scoreboard said 38. It is its own mark now,
 * and stays out of the player's kills-by-weapon too; for the player it hit it is a death like any.
 */
test("a team kill is its own mark on the killer's timeline, never one of their kills", () => {
  const stats = [row("Ana", "allies", { kills: 2, teamkills: 1 }), row("Bob", "allies"), row("Xen", "axis")];
  const events = [
    kill(10, "Ana", "Xen", "M1 GARAND"),
    kill(20, "Ana", "Bob", "MK2 GRENADE", "evt.teamkill"),
    kill(30, "Ana", "Xen", "M1 GARAND"),
  ];
  const r = buildMatchReport({ events, stats, startedAt: T0, endedAt: at(600), classify });
  assert.deepEqual(r.players["Ana"]!.timeline, [
    [10, "k", "Xen", "M1 GARAND"],
    [20, "t", "Bob", "MK2 GRENADE"],
    [30, "k", "Xen", "M1 GARAND"],
  ]);
  assert.equal(r.players["Ana"]!.timeline.filter((e) => e[1] === "k").length, 2, "two kills, as the scoreboard says");
  assert.deepEqual(r.players["Bob"]!.timeline, [[20, "d", "Ana", "MK2 GRENADE"]], "a death for the player it hit");
  assert.deepEqual(r.players["Ana"]!.weapons, [["M1 GARAND", 2]], "the grenade killed nobody on the other side");
  assert.equal(r.players["Ana"]!.killsStreak, 2, "and it does not break her streak either");

  // The public wire carries the mark through as it is.
  const pub = publicMatchReport(r, (id) => id);
  assert.deepEqual(pub.players["Ana"]!.timeline[1], [20, "t", "Bob", "MK2 GRENADE"]);
});

/*
 * The score charts ride the report. Each player's series comes from the store flattened, five ints
 * a point, and goes out as [secs, combat, offense, defense, support] points. A medic with a series
 * and no kill or death still gets a line, or their row would have no chart at all. The public wire
 * carries the points under the player's name, and a player with no series has no `scores`.
 */
test("score series ride the report: points per player, a line for a scorer with no kills, public by name", () => {
  const stats = [row("Ana", "allies", { kills: 1 }), row("Med", "allies", { support: 150 }), row("Xen", "axis", { deaths: 1 })];
  const r = buildMatchReport({
    events: [kill(30, "Ana", "Xen", "M1 GARAND")], stats, startedAt: T0, endedAt: at(600), classify,
    scoreSeries: new Map([["Ana", [120, 40, 0, 0, 10, 180, 80, 20, 0, 10]], ["Med", [120, 0, 0, 0, 150]]]),
  });
  assert.deepEqual(r.players["Ana"]!.scores, [[120, 40, 0, 0, 10], [180, 80, 20, 0, 10]]);
  assert.deepEqual(r.players["Ana"]!.timeline, [[30, "k", "Xen", "M1 GARAND"]], "the kills chart's line is untouched");
  assert.deepEqual(r.players["Med"]!.scores, [[120, 0, 0, 0, 150]], "a scorer with no kill or death has a line");
  assert.deepEqual([r.players["Med"]!.side, r.players["Med"]!.timeline], ["allies", []]);
  assert.equal("scores" in r.players["Xen"]!, false, "no series, no scores");

  const pub = publicMatchReport(r, (id) => id);
  assert.deepEqual(pub.players["Med"]!.scores, [[120, 0, 0, 0, 150]]);
  assert.deepEqual(pub.players["Ana"]!.scores, [[120, 40, 0, 0, 10], [180, 80, 20, 0, 10]]);
  assert.equal("scores" in pub.players["Xen"]!, false);
});

const snap = (secs: number, allies?: number, axis?: number) => ({
  ts: at(secs),
  composition: { bySide: { ...(allies === undefined ? {} : { allies: { players: allies } }), ...(axis === undefined ? {} : { axis: { players: axis } }) } },
});

test("headcount: each minute mark reads the sample nearest it, so the sampler's drift leaves no gap", () => {
  // The worker samples about every 61.5 s on its poll loop: the samples drift across the minute
  // marks, one minute holding two of them now and then and the next holding none.
  const drift = Array.from({ length: 30 }, (_, k) => snap(20 + k * 61.5, 30 + k, 40 - k));
  const round = headcountTimeline(drift, T0, at(1750));
  assert.deepEqual(round.map((p) => p.minute), Array.from({ length: 30 }, (_, i) => i), "a point per minute mark, 0 to 29");
  assert.ok(round.every((p) => p.allies !== null && p.axis !== null), "drift alone is never a gap");
  const at_ = (minute: number) => round.find((p) => p.minute === minute)!;
  assert.deepEqual(at_(0), { minute: 0, allies: 30, axis: 40 });
  // Sample 7 (7:30.5) is the nearest to both 7:00 and 8:00 — it stands for each.
  assert.deepEqual([at_(7).allies, at_(8).allies, at_(9).allies], [37, 37, 38]);
  assert.deepEqual(at_(8), { minute: 8, allies: 37, axis: 33 });
  // 27:00 sits one second after sample 26 and 28:00 half a second before sample 27: a whole-minute
  // bucket would hold none for 27 and two for 28.
  assert.deepEqual([at_(27).allies, at_(28).allies, at_(29).allies], [56, 57, 58]);
});

test("headcount: a stretch with no samples is a gap, never zero and never the last count carried on", () => {
  const round = headcountTimeline([snap(10, 20, 21), snap(70, 22, 23), snap(130, 24, 25), snap(430, 30, 31), snap(490, 32, 33)], T0, at(500));
  assert.deepEqual(round.map((p) => [p.minute, p.allies, p.axis]), [
    [0, 20, 21], [1, 22, 23], [2, 24, 25],
    // 3:00 is 50 s past the last sample before the outage — further than any sample may reach.
    [3, null, null], [4, null, null], [5, null, null], [6, null, null],
    [7, 30, 31], [8, 32, 33],
  ]);
});

test("headcount: only the round's own samples, a side the sample did not count, and the cap", () => {
  // Ten seconds before the start is the last round's end screen; ten after the end is the next
  // end screen. Both sit nearer a mark than anything in the round, and neither may stand for it.
  const edges = headcountTimeline([snap(-10, 99, 99), snap(50, 1, 2), snap(110, 3, 4), snap(130, 98, 98)], T0, at(125));
  assert.deepEqual(edges, [
    { minute: 0, allies: null, axis: null },
    { minute: 1, allies: 1, axis: 2 },
    { minute: 2, allies: 3, axis: 4 },
  ]);
  // A side missing from the sample is unknown, not empty; the other side still reads.
  assert.deepEqual(headcountTimeline([snap(5, 12)], T0, at(30)), [{ minute: 0, allies: 12, axis: null }]);
  assert.deepEqual(headcountTimeline([{ ts: at(5), composition: {} }], T0, at(30)), [{ minute: 0, allies: null, axis: null }]);
  // No samples at all: nothing to draw, and the page says why.
  assert.deepEqual(headcountTimeline([], T0, at(3600)), []);
  // A round still running ends at its latest sample.
  assert.equal(headcountTimeline([snap(10, 1, 1), snap(70, 2, 2), snap(130, 3, 3)], T0, null).length, 3);
  // A round left open for ten hours reads no further than the cap.
  const runaway = headcountTimeline([snap(10, 1, 1), snap(36_000, 2, 2)], T0, at(36_000));
  assert.equal(runaway.length, HEADCOUNT_MAX_MINUTES + 1);
  assert.deepEqual(runaway[0], { minute: 0, allies: 1, axis: 1 });
});
