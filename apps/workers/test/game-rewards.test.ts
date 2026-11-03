/**
 * Game rewards' decisions, rule by rule — who places, when a streak pays, which tiers are due.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KillStreakTracker, bestSquadsBroadcast, bestSquadsReport, categoryValue, dayIn, mainSquad, prevDay, rankBestSquads, rankTopStats, streakEndingOn, streakPayoutsDue, topStatsBroadcast } from "../dist/game-rewards.js";
import { GAME_REWARDS_DEFAULTS, type PlayerMatchStatRow } from "@app/db";

const row = (id: string, over: Partial<PlayerMatchStatRow> = {}): PlayerMatchStatRow => ({
  matchId: "m", playerId: id, serverId: "s", playerName: id, side: "allies",
  kills: 0, deaths: 0, teamkills: 0, combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
  roleSeconds: { "1": 3600 }, slSeconds: 0, ...over,
} as PlayerMatchStatRow);
const pts = (points: number) => ({ vipHours: 0, points });
const topCfg = (cats: { id: string; ranks: number }[], minMinutes = 20) => ({
  ...GAME_REWARDS_DEFAULTS.topStats, minMinutes,
  categories: cats.map((c) => ({ id: c.id, enabled: true, ranks: Array.from({ length: c.ranks }, (_, i) => pts(100 - i * 10)) })),
}) as never;

test("top stats: best first, a reward per place, zeros never place", () => {
  const rows = [row("a", { kills: 30 }), row("b", { kills: 45 }), row("c", { kills: 12 }), row("d", { kills: 0 })];
  const w = rankTopStats(rows, topCfg([{ id: "kills", ranks: 5 }]), new Set());
  assert.deepEqual(w.map((x) => [x.playerId, x.rank, x.reward.points]), [["b", 1, 100], ["a", 2, 90], ["c", 3, 80]]);
});

test("top stats: someone who joined for five minutes cannot place", () => {
  const rows = [row("late", { kills: 99, roleSeconds: { "1": 300 } }), row("full", { kills: 10 })];
  const w = rankTopStats(rows, topCfg([{ id: "kills", ranks: 1 }], 20), new Set());
  assert.equal(w[0]!.playerId, "full");
});

test("top stats: ratios need 5 kills — 3 kills and no deaths is not the best K/D", () => {
  const rows = [row("lucky", { kills: 3, deaths: 0 }), row("steady", { kills: 20, deaths: 5 })];
  assert.equal(categoryValue("kd", rows[0]!, new Set(), 0), null);
  assert.equal(rankTopStats(rows, topCfg([{ id: "kd", ranks: 1 }]), new Set())[0]!.playerId, "steady");
});

test("top stats: commander is whoever commanded, ranked on combat + support", () => {
  const cmd = new Set(["13"]);
  const rows = [
    row("cmdr", { combat: 100, support: 900, roleSeconds: { "13": 3000 } }),
    row("grunt", { combat: 2000, support: 2000 }), // never commanded
  ];
  const w = rankTopStats(rows, topCfg([{ id: "commander", ranks: 1 }]), cmd);
  assert.deepEqual(w.map((x) => [x.playerId, x.value]), [["cmdr", 1000]]);
});

test("top stats: the broadcast names each category's winner", () => {
  const w = rankTopStats([row("a", { kills: 30, support: 500 }), row("b", { kills: 20, support: 900 })], topCfg([{ id: "kills", ranks: 1 }, { id: "support", ranks: 1 }]), new Set());
  assert.equal(topStatsBroadcast(w), "Top players this match — kills: a (30) | support: b (900)");
});

test("kill streaks: kills without dying, each tier once per life, a death starts over", () => {
  const t = new KillStreakTracker();
  const tiers = [{ kills: 3 }, { kills: 5 }];
  const hits: number[] = [];
  for (let i = 1; i <= 5; i++) hits.push(...t.kill("p", `t${i}`, tiers).map((h) => h.kills));
  assert.deepEqual(hits, [3, 5]);
  assert.equal(t.kill("p", "t6", tiers).length, 0, "6 kills pays nothing new");
  t.death("p");
  const again = [1, 2, 3].flatMap((i) => t.kill("p", `u${i}`, tiers));
  assert.deepEqual(again.map((h) => [h.kills, h.lifeRef]), [[3, "u1"]], "a new life, a new ref — paid again");
  t.reset();
  assert.equal(t.current("p"), 0, "a new match ends every run");
});

test("day streaks: consecutive days ending today, in the community's timezone", () => {
  assert.equal(prevDay("2026-03-01"), "2026-02-28");
  assert.equal(dayIn("America/New_York", Date.parse("2026-09-27T02:00:00Z")), "2026-09-26", "10pm in New York is still the 26th");
  const days = new Set(["2026-09-20", "2026-09-22", "2026-09-23", "2026-09-24"]);
  assert.deepEqual(streakEndingOn(days, "2026-09-24"), { count: 3, start: "2026-09-22" });
  assert.equal(streakEndingOn(days, "2026-09-25").count, 0, "today not played yet — no streak to pay");
});

test("day streaks: every tier reached is due (receipts keep each to once), plus the repeat", () => {
  const tiers = [{ days: 3, reward: pts(50) }, { days: 7, reward: pts(150) }];
  assert.deepEqual(streakPayoutsDue(2, tiers, 7).map((d) => d.days), []);
  assert.deepEqual(streakPayoutsDue(3, tiers, 7).map((d) => d.days), [3]);
  assert.deepEqual(streakPayoutsDue(7, tiers, 7).map((d) => d.days), [3, 7]);
  assert.deepEqual(streakPayoutsDue(10, tiers, 7).map((d) => d.days), [3, 7], "between repeats: nothing new");
  assert.deepEqual(streakPayoutsDue(14, tiers, 7).map((d) => [d.days, d.reward.points]), [[3, 50], [7, 150], [14, 150]], "day 14: the top tier again");
  assert.deepEqual(streakPayoutsDue(14, tiers, 0).map((d) => d.days), [3, 7], "repeat off");
});

test("a tier's own message rides with it, the repeat included", () => {
  const tiers = [{ days: 3, reward: pts(50), message: "three!" }, { days: 7, reward: pts(150), message: "a week!" }];
  const due = streakPayoutsDue(14, tiers, 7);
  assert.deepEqual(due.map((d) => [d.days, d.message]), [[3, "three!"], [7, "a week!"], [14, "a week!"]]);
});

test("a winner's own match numbers, ready for their message", async () => {
  const { playerMatchVars } = await import("../dist/game-rewards.js");
  const v = playerMatchVars(row("a", { kills: 30, deaths: 8, combat: 400, support: 250, vehiclesDestroyed: 2, roleSeconds: { "1": 3000 } }));
  assert.deepEqual(v, { kills: 30, deaths: 8, kd: "3.75", kpm: "0.60", combat: 400, offense: 0, defense: 0, support: 250, teamplay: 650, vehicles: 2, minutes: 50 });
});

const HLL_SQUADS = { infantry: [0, 1, 2, 3, 5, 6, 7, 8, 9], recon: [4, 10], armor: [11, 12], artillery: [14, 15, 16] };
const HLLV_SQUADS = { infantry: [0, 3, 5, 6, 7, 8, 9], recon: [4, 10], armor: [11, 12], mortar: [13, 14, 15], helicopter: [16, 17] };
/** A player who spent the whole match in one squad. */
const crew = (id: string, team: number, squad: number, role: number, over: Partial<PlayerMatchStatRow> = {}) =>
  row(id, { units: [{ ts: 0, team, squad, role }], roleSeconds: { [String(role)]: 3600 }, ...over });
const squadCfg = (types: Record<string, number>, over: Record<string, unknown> = {}) => ({
  ...GAME_REWARDS_DEFAULTS.bestSquads, minMinutes: 20, minMembers: 2, metric: "score", scoring: "total",
  types: GAME_REWARDS_DEFAULTS.bestSquads.types.map((t) => ({ ...t, enabled: t.id in types, ranks: Array.from({ length: types[t.id] ?? 1 }, (_, i) => pts(100 - i * 50)) })),
  ...over,
}) as never;

test("best squads: a player counts in the squad they spent the match in — by time, not by where they ended", () => {
  assert.deepEqual(mainSquad(crew("a", 1, 2, 11), HLL_SQUADS), { team: 1, squad: 2, type: "armor" });
  // Ten minutes of infantry, then forty in a tank: the tank is their squad.
  const moved = row("b", { units: [{ ts: 0, team: 1, squad: 0, role: 6 }, { ts: 600, team: 1, squad: 3, role: 11 }], roleSeconds: { "6": 600, "11": 2400 } });
  assert.deepEqual(mainSquad(moved, HLL_SQUADS), { team: 1, squad: 3, type: "armor" });
  // …and forty minutes of infantry before ten in a tank keeps them infantry.
  const stayed = row("c", { units: [{ ts: 0, team: 1, squad: 0, role: 6 }, { ts: 2400, team: 1, squad: 3, role: 11 }], roleSeconds: { "6": 2400, "11": 600 } });
  assert.deepEqual(mainSquad(stayed, HLL_SQUADS), { team: 1, squad: 0, type: "infantry" });
  // The commander is in no squad, nor is a player never in one.
  assert.equal(mainSquad(crew("d", 1, 0, 13), HLL_SQUADS), null, "commander");
  assert.equal(mainSquad(crew("e", 1, -1, 6), HLL_SQUADS), null, "unassigned");
  assert.equal(mainSquad(row("f", { units: [] }), HLL_SQUADS), null);
});

test("best squads: each type's best squad by its members' score added up; a squad too small or a type turned off never places", () => {
  const rows = [
    crew("a1", 1, 0, 9, { combat: 300, support: 200 }), crew("a2", 1, 0, 6, { combat: 400 }),            // Allies infantry squad 0: 900
    crew("b1", 2, 0, 9, { combat: 200, offense: 100 }), crew("b2", 2, 0, 3, { support: 300 }), crew("b3", 2, 0, 6, { combat: 100 }), // Axis infantry squad 0: 700
    crew("t1", 1, 1, 12, { combat: 500 }), crew("t2", 1, 1, 11, { combat: 250 }),                         // a tank crew: 750
    crew("r1", 2, 2, 4, { combat: 999 }),                                                                 // a lone recon: too small
  ];
  const placed = rankBestSquads(rows, squadCfg({ infantry: 2, armor: 1, recon: 1 }), HLL_SQUADS);
  const view = placed.map((p) => [p.type, p.rank, p.value, p.members.map((m) => m.playerId).sort().join("+")]);
  assert.deepEqual(view, [
    ["infantry", 1, 900, "a1+a2"],
    ["infantry", 2, 700, "b1+b2+b3"],
    ["armor", 1, 750, "t1+t2"],
  ], "squad 0 on each side is a different squad; a lone recon cannot place under a minimum of two");
  assert.deepEqual(placed[0]!.reward, pts(100));
  assert.deepEqual(placed[1]!.reward, pts(50));
  assert.equal(rankBestSquads(rows, squadCfg({ armor: 1 }), HLL_SQUADS).every((p) => p.type === "armor"), true, "only the types switched on");
});

test("best squads: averaging lets a short-handed squad win on how its members played; short stays do not count", () => {
  const rows = [
    crew("a1", 1, 0, 9, { combat: 500 }), crew("a2", 1, 0, 6, { combat: 500 }),                                   // 1000 total, 500 each
    crew("b1", 2, 0, 9, { combat: 300 }), crew("b2", 2, 0, 3, { combat: 300 }), crew("b3", 2, 0, 6, { combat: 300 }), crew("b4", 2, 0, 6, { combat: 300 }), // 1200 total, 300 each
  ];
  assert.equal(rankBestSquads(rows, squadCfg({ infantry: 1 }), HLL_SQUADS)[0]!.members[0]!.playerId.startsWith("b"), true, "added up: the bigger squad");
  const avg = rankBestSquads(rows, squadCfg({ infantry: 1 }, { scoring: "average" }), HLL_SQUADS)[0]!;
  assert.equal(avg.value, 500);
  assert.ok(avg.members.every((m) => m.playerId.startsWith("a")), "averaged: the better-playing squad");
  // A member who played five minutes is not counted — and the squad can fall below the minimum.
  const brief = [crew("c1", 1, 4, 9, { combat: 800 }), crew("c2", 1, 4, 6, { combat: 800, roleSeconds: { "6": 300 } })];
  assert.deepEqual(rankBestSquads(brief, squadCfg({ infantry: 1 }), HLL_SQUADS), []);
});

test("best squads: each game's own squad types — a Vietnam mortar platoon places, artillery is not looked for", () => {
  const rows = [crew("m1", 1, 0, 14, { combat: 100, support: 100 }), crew("m2", 1, 0, 15, { combat: 50 })];
  const placed = rankBestSquads(rows, squadCfg({ mortar: 1, artillery: 1 }), HLLV_SQUADS);
  assert.deepEqual(placed.map((p) => [p.type, p.value]), [["mortar", 250]]);
  // Role 14 is HLL's artillery observer: the same row under WW2 squad types is an artillery squad.
  assert.deepEqual(rankBestSquads(rows, squadCfg({ mortar: 1, artillery: 1 }), HLL_SQUADS).map((p) => p.type), ["artillery"]);
});

test("best squads: the winners list names each squad by its people; the broadcast names each type's winner", () => {
  const rows = [crew("Ana", 1, 0, 9, { combat: 400 }), crew("Bob", 1, 0, 6, { combat: 300 }), crew("Tim", 2, 1, 12, { combat: 500 }), crew("Kim", 2, 1, 11, { combat: 100 })];
  const placed = rankBestSquads(rows, squadCfg({ infantry: 1, armor: 1 }), HLL_SQUADS);
  assert.equal(bestSquadsReport(placed, ["infantry", "armor"], "total"), "Best squads this match:\nInfantry: Ana, Bob (700)\nArmor: Kim, Tim (600)");
  assert.equal(bestSquadsBroadcast(placed, "total"), "Best squads — infantry squad: Ana, Bob (700) | armor squad: Kim, Tim (600)");
  assert.equal(bestSquadsReport([], ["infantry"], "total"), "");
});
