import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEEDING_DEFAULTS, createRepository, seedCycleReplayRefusal, seedCycleRetryable, type SeedingConfigRow } from "@app/db";
import { planSeedingTick, joinsSince, seedingNews, seedActionAudit, enforcementSides, warfareVerdict, calibrationOf, bandOf, pastFrontLine, blankAxisCal, mergeGeometry, CAP_POS_GRACE_SEC, attackerSideOf, PACE_GRACE_SEC, type AxisCalState, bridgeAccountFor, calcRewardExpiration, applyVars, composeRewardMessage, formatVipUntil, rosterIdOf, pointsSkipReason, resolveContainZone, rewardPhrase, vipSpan, rosterPosOf, isDisallowedWeapon, seedCheckDelayMs, seedTickDelayMs, seedPaidPlayers, splitRepeatSeeders, seedWindowLabel, POINTS_LINK_UNREADABLE, type SeedRosterPlayer, type EscalationState, type Phase } from "../dist/seeding.js";

function cfg(patch: Partial<SeedingConfigRow> = {}): SeedingConfigRow {
  // Default to instant phase changes (confirm + hysteresis off) so the core-logic tests are
  // isolated; the phase-stability tests opt in explicitly.
  // positionalEnabled: the cap fight by position is off by default (the cap fight works like
  // CRCON's — see seeding-crcon-mode.test.ts); this file tests it as built, so its servers switch
  // it on. The zones and steamroll protection have switches of their own, set per test.
  return { serverId: "srv-1", ...SEEDING_DEFAULTS, positionalEnabled: true, phaseConfirmSec: 0, phaseHysteresis: 0, updatedAt: new Date(0).toISOString(), ...patch };
}
function player(id: string, over: Partial<SeedRosterPlayer> = {}): SeedRosterPlayer {
  return { playerId: id, name: id, level: 50, role: 0, tags: [], ...over };
}
function roster(n: number, over: (i: number) => Partial<SeedRosterPlayer> = () => ({})): SeedRosterPlayer[] {
  return Array.from({ length: n }, (_, i) => player(`p${i}`, over(i)));
}
function tick(input: Partial<Parameters<typeof planSeedingTick>[0]> & { config: SeedingConfigRow; roster: SeedRosterPlayer[] }) {
  return planSeedingTick({
    progress: new Map(), escalation: new Map(), prevPhase: "seeding" as Phase,
    pendingPhase: null, pendingSinceMs: 0,
    elapsedSec: 30, nowMs: 1_000_000, lastRewardMs: 0, roleName: (r) => `role${r}`, ...input,
  });
}

test("applyVars replaces known tokens and leaves unknown ones", () => {
  assert.equal(applyVars("hi {player_name}, {n} warnings", { player_name: "Bob", n: 2 }), "hi Bob, 2 warnings");
  assert.equal(applyVars("{unknown} stays", {}), "{unknown} stays");
});

test("phase: below minPlayers = idle, at/over target = live, between = seeding", () => {
  const config = cfg({ minPlayers: 5, seedTarget: 40 });
  assert.equal(tick({ config, roster: roster(3), prevPhase: "seeding" }).phase, "idle");
  assert.equal(tick({ config, roster: roster(20) }).phase, "seeding");
  assert.equal(tick({ config, roster: roster(40), prevPhase: "seeding" }).phase, "live");
});

test("phase confirm delay: a brief spike does not commit until it holds", () => {
  const config = cfg({ minPlayers: 5, seedTarget: 40, phaseConfirmSec: 60 });
  const now = 1_000_000;
  // count hits 40 (would be live) but no pending yet -> stays seeding, starts the timer
  const t1 = tick({ config, roster: roster(40), prevPhase: "seeding", pendingPhase: null, pendingSinceMs: 0, nowMs: now });
  assert.equal(t1.phase, "seeding");
  assert.equal(t1.pendingPhase, "live");
  // 30s later still 40, but < 60s confirm -> still seeding
  const t2 = tick({ config, roster: roster(40), prevPhase: "seeding", pendingPhase: t1.pendingPhase, pendingSinceMs: t1.pendingSinceMs, nowMs: now + 30_000 });
  assert.equal(t2.phase, "seeding");
  // drops back to 39 before confirming -> candidate abandoned, no commit, progress intact
  const t3 = tick({ config, roster: roster(39), prevPhase: "seeding", pendingPhase: t2.pendingPhase, pendingSinceMs: t2.pendingSinceMs, nowMs: now + 45_000 });
  assert.equal(t3.phase, "seeding");
  assert.equal(t3.pendingPhase, null);
  assert.equal(t3.clearProgress, false); // seed progress was NOT wiped by the blip
});

test("phase confirm delay: commits once the count holds past the delay", () => {
  const config = cfg({ minPlayers: 5, seedTarget: 40, phaseConfirmSec: 60, minSeedMinutes: 0, rewardEnabled: true });
  const now = 1_000_000;
  const t1 = tick({ config, roster: roster(40), prevPhase: "seeding", pendingPhase: null, pendingSinceMs: 0, nowMs: now });
  assert.equal(t1.phase, "seeding");
  // 61s later, still 40 -> commits live, and the seeding->live reward fires
  const t2 = tick({ config, roster: roster(40), prevPhase: "seeding", pendingPhase: t1.pendingPhase, pendingSinceMs: t1.pendingSinceMs, nowMs: now + 61_000 });
  assert.equal(t2.phase, "live");
  assert.equal(t2.pendingPhase, null);
  assert.equal(t2.rewards.length, 40);
});

test("hysteresis: once live, a small dip below the target stays live", () => {
  const config = cfg({ minPlayers: 5, seedTarget: 40, phaseHysteresis: 3 }); // confirm off
  // committed live, count 38 (within the 3-player dead band) -> still live
  assert.equal(tick({ config, roster: roster(38), prevPhase: "live" }).phase, "live");
  // count 36 (>=3 below target) -> falls back to seeding
  assert.equal(tick({ config, roster: roster(36), prevPhase: "live" }).phase, "seeding");
  // from seeding, need the full target to go live again (asymmetric)
  assert.equal(tick({ config, roster: roster(39), prevPhase: "seeding" }).phase, "seeding");
  assert.equal(tick({ config, roster: roster(40), prevPhase: "seeding" }).phase, "live");
});

test("draining to idle abandons the cycle (clearProgress)", () => {
  const r = tick({ config: cfg({ minPlayers: 5 }), roster: roster(2), prevPhase: "seeding" });
  assert.equal(r.phase, "idle");
  assert.equal(r.clearProgress, true);
});

/*
 * An EMPTY server is idle, whatever the thresholds work out to.
 *
 * minPlayers and phaseHysteresis are configured independently and validated independently — each
 * is simply "a whole number ≥ 0" — so a community that seeds from almost nothing can set
 * minPlayers 2 with a hysteresis of 5 and land on an idle threshold of -3, which a count of zero
 * is never below. The server then never leaves `seeding` after everyone goes home, and since the
 * cycle only resets on the way into idle, the accrued progress and the ladders survive: the next
 * fill pays VIP for minutes banked in an attempt that was abandoned hours ago.
 */
test("an emptied server goes idle even when the hysteresis is wider than minPlayers", () => {
  const config = cfg({ minPlayers: 2, seedTarget: 40, phaseHysteresis: 5 });
  const r = tick({ config, roster: [], prevPhase: "seeding" });
  assert.equal(r.phase, "idle", "nobody is on the server, so nothing is being seeded");
  assert.equal(r.clearProgress, true, "…and the abandoned cycle's progress goes with it");

  // The band still does its job on the way down to a non-empty count: one player left, and
  // minPlayers-minus-band would say idle, but the floor only ever applies at zero.
  assert.equal(tick({ config, roster: roster(1), prevPhase: "seeding" }).phase, "seeding");
});

test("seeding accrues presence for everyone online", () => {
  const r = tick({ config: cfg(), roster: roster(10), elapsedSec: 30 });
  assert.equal(r.progressAdds.length, 10);
  assert.ok(r.progressAdds.every((a) => a.deltaSec === 30));
});

const joins = (...ids: string[]) => ids.map((id) => ({ playerId: id, name: id }));

test("the seeding rules are told once to each player who joins while the server seeds", () => {
  const config = cfg({ announceMessage: "welcome", minPlayers: 2 });
  const first = tick({ config, roster: roster(3), joined: joins("p1", "p2") });
  assert.deepEqual(first.announces.map((a) => a.playerId), ["p1", "p2"], "the two who joined, not everyone on");
  assert.equal(tick({ config, roster: roster(3) }).announces.length, 0, "nobody joined since");
  // A join is a join: one who leaves and comes back is told again, once.
  assert.deepEqual(tick({ config, roster: roster(3), joined: joins("p1", "p1") }).announces.map((a) => a.playerId), ["p1"]);
});

test("nobody hears the seeding rules again because the server went live and dropped back", () => {
  // On through a slow seed, a player heard them four or five times in one game: every return to
  // seeding, and every reconnect to the server, greeted everyone on the roster again.
  const config = cfg({ announceMessage: "welcome", minPlayers: 2, seedTarget: 10 });
  assert.equal(tick({ config, roster: roster(12), prevPhase: "seeding" }).phase, "live");
  const back = tick({ config, roster: roster(8), prevPhase: "live" });
  assert.equal(back.phase, "seeding");
  assert.equal(back.announces.length, 0, "already on: no join, no greeting");
  // A reconnect or a restart starts the phase over from idle: still nobody is told without a join.
  const fresh = tick({ config, roster: roster(8), prevPhase: "idle" });
  assert.equal(fresh.phase, "seeding");
  assert.equal(fresh.announces.length, 0);
});

test("seedingNews: a real change of phase is news; a reset finding its feet is not", () => {
  // After a reset the phase is a placeholder idle that waits out the confirm window and then
  // commits to what the server already was: no "seeding has started" for that.
  assert.deepEqual(seedingNews({ settled: false, prevPhase: "idle" }, { phase: "idle", pendingPhase: "seeding" }), { news: false, settled: false }, "still confirming");
  assert.deepEqual(seedingNews({ settled: false, prevPhase: "idle" }, { phase: "seeding", pendingPhase: null }), { news: false, settled: true }, "learned in silence");
  assert.deepEqual(seedingNews({ settled: true, prevPhase: "seeding" }, { phase: "live", pendingPhase: null }), { news: true, settled: true }, "went live");
  assert.deepEqual(seedingNews({ settled: true, prevPhase: "seeding" }, { phase: "seeding", pendingPhase: "live" }), { news: false, settled: true }, "no change yet");
  // A server that really was idle at the reset: idle is learned at once, and seeding after it is news.
  assert.deepEqual(seedingNews({ settled: false, prevPhase: "idle" }, { phase: "idle", pendingPhase: null }), { news: false, settled: true });
  assert.equal(seedingNews({ settled: true, prevPhase: "idle" }, { phase: "seeding", pendingPhase: null }).news, true);
});

test("joinsSince: the joins after the cursor, by game id, and where to read from next", async () => {
  // Read from the game log's joins, not the runner's memory, so a reconnect or a restart tells
  // nobody twice.
  const repo = await createRepository({});
  const server = await repo.servers.create({ name: "one", host: "127.0.0.1", port: 1, password: "x" });
  const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Alpha" });
  const b = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000002", name: "Bravo" });
  const evt = (kind: string, pid: string, name: string, ts: string, id: string) => ({
    serverId: server.id, ts, kind, actorPlayerId: pid, actorName: name,
    victimPlayerId: null, victimName: null, weapon: kind === "evt.kill" ? "W" : null, data: null, dedupeKey: `t:${id}`,
  });
  await repo.events.insert([
    evt("evt.player.connected", a.id, "Alpha", "2026-10-23T10:00:00.000Z", "1"), // before the cursor
    evt("evt.player.connected", b.id, "Bravo", "2026-10-23T10:05:00.000Z", "2"),
    evt("evt.kill", a.id, "Alpha", "2026-10-23T10:06:00.000Z", "3"),             // not a join
  ]);
  const r = await joinsSince(repo, server.id, "2026-10-23T10:01:00.000Z");
  assert.deepEqual(r.joined, [{ playerId: "76561198000000002", name: "Bravo" }], "the game id, not the store's");
  assert.equal(r.cursor, "2026-10-23T10:05:00.000Z");
  const again = await joinsSince(repo, server.id, r.cursor);
  assert.deepEqual(again.joined, [], "each join is read once");
  assert.equal(again.cursor, r.cursor);
});

test("a join while the server is live, or below its minimum, is not told the seeding rules", () => {
  // As CRCON: the reminder goes out on a join only while a seeding rule is in force.
  const config = cfg({ announceMessage: "welcome", minPlayers: 5, seedTarget: 10 });
  assert.equal(tick({ config, roster: roster(12), prevPhase: "live", joined: joins("p0") }).announces.length, 0, "live");
  assert.equal(tick({ config, roster: roster(2), prevPhase: "idle", joined: joins("p0") }).announces.length, 0, "below the minimum");
});

test("disallowed role escalates warn -> punish -> kick with intervals", () => {
  const config = cfg({ disallowedRoles: [7], minPlayers: 1, maxWarnings: 1, warnIntervalSec: 10, maxPunishes: 1, punishIntervalSec: 10, kickAfter: true });
  const bad = [player("bad", { role: 7 })];
  let esc: EscalationState = new Map();

  // first warning (nowMs is a real epoch-ish value, far past lastWarnMs=0, so the gate is open)
  let r = tick({ config, roster: bad, escalation: esc, nowMs: 100_000 });
  assert.equal(r.actions[0]?.kind, "warn");
  // Each step says which rule and what — the History line is built from it.
  assert.deepEqual(r.actions[0]?.reason, { rule: "role", detail: "role7", step: { n: 1, of: 1 } });
  esc = r.escalation;

  // warns maxed; punish interval elapsed -> punish
  r = tick({ config, roster: bad, escalation: esc, nowMs: 111_000 });
  assert.equal(r.actions[0]?.kind, "punish");
  assert.deepEqual(r.actions[0]?.reason, { rule: "role", detail: "role7", step: { n: 1, of: 1 } });
  esc = r.escalation;

  // punishes maxed -> kick (no interval gate on kick)
  r = tick({ config, roster: bad, escalation: esc, nowMs: 122_000 });
  assert.equal(r.actions[0]?.kind, "kick");
  assert.deepEqual(r.actions[0]?.reason, { rule: "role", detail: "role7" }, "a kick ends the ladder rather than stepping on it");
});

test("a seeding action files a line that names its rule; the restricted rules keep to \"seeding rule\"", () => {
  const act = (reason: any, kind: "warn" | "punish" | "kick" = "warn") => ({ playerId: "765", name: "snowwhitebybis", kind, message: "told", reason });
  const role = seedActionAudit(act({ rule: "role", detail: "Tank Commander", step: { n: 1, of: 2 } }), "srv-1", false);
  assert.equal(role.action, "seed.warn");
  assert.equal(role.targetId, "765");
  assert.equal(role.serverId, "srv-1");
  assert.equal(role.summary, "warn snowwhitebybis — seeding, disallowed role: Tank Commander (warning 1 of 2)");
  assert.deepEqual(role.data, { message: "told", rule: "role", detail: "Tank Commander", step: { n: 1, of: 2 } });
  const dry = seedActionAudit(act({ rule: "weapon", detail: "MG42" }, "kick"), "srv-1", true);
  assert.equal(dry.summary, "[dry-run] would kick snowwhitebybis — seeding, disallowed weapon: MG42");
  assert.equal(dry.data!.dryRun, true);
  // The line goes to anyone who reads the trail: the area and pace rules say no more than this…
  const zone = seedActionAudit(act({ rule: "zone", detail: "outside their team's drawn area", step: { n: 1, of: 2 } }), "srv-1", false);
  assert.equal(zone.summary, "warn snowwhitebybis — seeding rule (warning 1 of 2)");
  assert.equal(zone.data!.rule, "zone", "…while the reason rides in the data, for the API to show its holders");
  const pace = seedActionAudit(act({ rule: "pace", detail: "reached point 4 before it opens at minute 40" }, "kick"), "srv-1", false);
  assert.equal(pace.summary, "kick snowwhitebybis — seeding rule");
  // …and a cap fight judged by position reads exactly like one judged by score.
  const byScore = seedActionAudit(act({ rule: "capFight", detail: "their team already held 3 caps", step: { n: 1, of: 2 } }), "srv-1", false);
  const byPos = seedActionAudit(act({ rule: "capFight", detail: "their team already held 3 caps", byPosition: true, step: { n: 1, of: 2 } }), "srv-1", false);
  assert.equal(byPos.summary, byScore.summary);
  assert.equal(byScore.summary, "warn snowwhitebybis — seeding, cap fight: their team already held 3 caps (warning 1 of 2)");
  // No name on the roster row: the line names the player by id rather than reading "warn  —".
  assert.equal(seedActionAudit({ ...act({ rule: "role", detail: "Sniper" }), name: "" }, "srv-1", false).summary.startsWith("warn 765 —"), true);
});

test("recovering from a disallowed role resets the ladder", () => {
  const config = cfg({ disallowedRoles: [7], minPlayers: 1, maxWarnings: 2, warnIntervalSec: 0 });
  let r = tick({ config, roster: [player("x", { role: 7 })], escalation: new Map(), nowMs: 0 });
  assert.equal(r.actions[0]?.kind, "warn");
  // switched to an allowed role -> escalation entry cleared
  r = tick({ config, roster: [player("x", { role: 0 })], escalation: r.escalation, nowMs: 100 });
  assert.equal(r.actions.length, 0);
  assert.equal(r.escalation.has("x"), false);
});

test("immunity by level and by tag skips enforcement", () => {
  const byLevel = cfg({ disallowedRoles: [7], minPlayers: 1, immuneLevel: 10 });
  let r = tick({ config: byLevel, roster: [player("noob", { role: 7, level: 5 })], escalation: new Map() });
  assert.equal(r.phase, "seeding");
  assert.equal(r.actions.length, 0);
  const byTag = cfg({ disallowedRoles: [7], minPlayers: 1, immuneTags: ["staff"] });
  r = tick({ config: byTag, roster: [player("mod", { role: 7, tags: ["staff"] })], escalation: new Map() });
  assert.equal(r.actions.length, 0);
});

test("seeding -> live rewards those who met minimum seed time, clears cycle", () => {
  const config = cfg({ seedTarget: 3, minPlayers: 2, minSeedMinutes: 10, rewardEnabled: true });
  const progress = new Map([["p0", 600], ["p1", 100], ["p2", 0]]); // 10m, ~1.7m, 0
  const r = tick({ config, roster: roster(3), progress, prevPhase: "seeding", elapsedSec: 30 });
  assert.equal(r.phase, "live");
  assert.deepEqual(r.rewards.map((x) => x.playerId).sort(), ["p0"]);
  assert.equal(r.clearProgress, true);
});

test("a worker restart cannot eat the reward round: idle -> live still pays banked minutes", () => {
  const config = cfg({ seedTarget: 3, minPlayers: 2, minSeedMinutes: 10, rewardEnabled: true });
  const progress = new Map([["p0", 600], ["p1", 100]]);
  const r = tick({ config, roster: roster(3), progress, prevPhase: "idle", elapsedSec: 0 });
  assert.equal(r.phase, "live");
  assert.deepEqual(r.rewards.map((x) => x.playerId), ["p0"], "banked minutes still pay after a restart");
  assert.equal(r.clearProgress, true);
});

test("a worker restart mid-seed keeps every seeder's banked minutes (the confirm window holds it at idle)", () => {
  // The real default: a phase change must hold for 60s, so the first ticks after a restart are
  // committed "idle" while the count says seeding. Clearing progress on that picture wiped every
  // seeder's time on each update — and with it the minutes the restart payout needed.
  const config = cfg({ seedTarget: 40, minPlayers: 5, phaseConfirmSec: 60 });
  const r = tick({ config, roster: roster(12), progress: new Map([["p0", 900], ["p1", 300]]), prevPhase: "idle", nowMs: 1_000_000 });
  assert.equal(r.phase, "idle", "still inside the confirm window");
  assert.equal(r.clearProgress, false, "banked minutes survive the restart");
});

test("a restart while simply live is not a reward round, and does not stamp the cooldown", () => {
  const config = cfg({ seedTarget: 3, minPlayers: 2, rewardEnabled: true });
  const r = tick({ config, roster: roster(5), prevPhase: "idle", progress: new Map() });
  assert.equal(r.phase, "live");
  assert.equal(r.rewarded, false, "nothing banked, nothing fired");
});

test("a go-live inside the repeat window is still a reward round — the runner decides who is paid", () => {
  const config = cfg({ seedTarget: 3, minPlayers: 2, minSeedMinutes: 0, rewardEnabled: true, rewardDelaySec: 3600 });
  const now = 10_000_000;
  const again = tick({ config, roster: roster(3), prevPhase: "seeding", nowMs: now, lastRewardMs: now - 60_000 });
  assert.equal(again.rewarded, true, "a second push must not leave its new seeders with nothing");
  assert.equal(again.rewards.length, 3, "every qualifier is listed; splitRepeatSeeders thanks the already-paid");
  assert.notEqual(again.rewardDebounced, true);
});

test("seedCycleReplayRefusal: only a live, unpaid, un-debounced cycle is replayable", () => {
  const entries = [{ playerId: "p", name: "P", seconds: 900 }];
  const base = { endedAt: "2026-09-26T00:00:00.000Z", entries };
  assert.match(seedCycleReplayRefusal(null)!, /no finished seed cycle/);
  assert.match(seedCycleReplayRefusal({ ...base, rewarded: true })!, /already paid/);
  assert.match(seedCycleReplayRefusal({ ...base, rewarded: false, wentLive: false })!, /without going live/);
  assert.match(seedCycleReplayRefusal({ ...base, rewarded: false, debounced: true })!, /reward delay/);
  assert.equal(seedCycleReplayRefusal({ ...base, rewarded: false, wentLive: true }), null);
  assert.equal(seedCycleReplayRefusal({ ...base, rewarded: false }), null, "older records read as went-live");
});

test("seedCycleRetryable: only a PAID round's still-owed seeders are retried", () => {
  const entries = [{ playerId: "p", name: "P", seconds: 900 }];
  const owe = (o: Partial<{ needVip: boolean; needPoints: boolean; needBridge: boolean }>) =>
    ({ playerId: "p", name: "P", needVip: false, needPoints: false, needBridge: false, reason: "r", ...o });
  const paid = { endedAt: "2026-09-26T00:00:00.000Z", rewarded: true, entries };
  assert.deepEqual(seedCycleRetryable(null), []);
  assert.deepEqual(seedCycleRetryable({ ...paid, rewarded: false, failed: [owe({ needVip: true })] }), [],
    "an unpaid cycle is replayed whole, not retried");
  assert.equal(seedCycleRetryable({ ...paid, failed: [owe({ needVip: true })] }).length, 1);
  assert.equal(seedCycleRetryable({ ...paid, failed: [owe({})] }).length, 0, "nothing owed, nothing to retry");
  assert.equal(seedCycleRetryable({ ...paid }).length, 0, "older records carry no failures");
});

/*
 * The retry pays OWED PARTS only. A seeder whose VIP landed and whose points did not must be
 * retried for points alone — re-running the VIP would stack the time twice. The loop records,
 * per part, whether it completed; the failure it writes carries exactly the incomplete parts,
 * and a retried points credit reuses the original round's ledger ref. Source-order, like the
 * other runner guards: the runner is I/O and cannot be unit-driven.
 */
test("a failed seeder records exactly which parts are still owed, and a retry pays only those", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  const from = src.indexOf("for (const rw of roundRewards) {");
  const to = src.indexOf("for (const b of bridgeStops) if (b.connected)");
  assert.ok(from > 0 && to > from);
  const loop = src.slice(from, to);
  assert.ok(loop.includes("const rwHours = rw.skipVip ? 0 : payHours;"), "a retry skips a VIP part already paid");
  assert.ok(loop.includes("const rwPoints = rw.skipPoints ? 0 : payPoints;"), "…and a points part already paid");
  assert.ok(loop.includes("!rw.skipBridge &&"), "…and the bridge");
  assert.ok(loop.includes("needVip: !vipDone, needPoints: !pointsDone, needBridge: !bridgeDone"), "the catch records the incomplete parts");
  assert.ok(loop.includes("ref: `${payRef}:${rw.playerId}`"), "a retried credit reuses the round's ledger ref");
  assert.ok(!/\bpayHours\b|\bpayPoints\b(?!;)/.test(loop.replace("const rwHours = rw.skipVip ? 0 : payHours;", "").replace("const rwPoints = rw.skipPoints ? 0 : payPoints;", "")),
    "no config amount is used past the per-seeder ones");
});

test("seedPaidPlayers: only a real payment counts, part by part", () => {
  const paid = seedPaidPlayers([
    { targetId: "paid", data: { hours: 24, round: "r1" } },
    { targetId: "dry", data: { dryRun: true } },
    { targetId: "failed", data: { failed: "rcon timeout" } },
    { targetId: "bridged", data: { bridgeFrom: "other-server" } },
    { targetId: null, data: {} },
    { targetId: "nodata" },
    { targetId: "refused", data: { hours: 24, points: 500, vipFailed: "the game refused the VIP grant: x", pointsApplied: 500 } },
    { targetId: "unreadable", data: { points: 500, pointsSkipped: POINTS_LINK_UNREADABLE } },
    { targetId: "unlinked", data: { points: 500, pointsSkipped: pointsSkipReason({ points: 500, discordId: null, linkReadable: true })! } },
    // A later row that landed the VIP completes the earlier refusal.
    { targetId: "later", data: { vipFailed: "refused" } },
    { targetId: "later", data: { hours: 24 } },
  ]);
  assert.deepEqual([...paid.keys()].sort(), ["later", "nodata", "paid", "refused", "unlinked", "unreadable"]);
  assert.deepEqual(paid.get("paid"), { vip: true, points: true });
  assert.deepEqual(paid.get("refused"), { vip: false, points: true }, "the game refused the VIP: still owed");
  assert.deepEqual(paid.get("unreadable"), { vip: true, points: false }, "points we could not pay are ours to owe");
  assert.deepEqual(paid.get("unlinked"), { vip: true, points: true }, "no Discord link is the player's to fix");
  assert.deepEqual(paid.get("later"), { vip: true, points: true });
});

test("splitRepeatSeeders: fully paid are thanked, unpaid are paid, part-paid get only the missing part", () => {
  const q = [{ playerId: "a", name: "A" }, { playerId: "b", name: "B" }, { playerId: "c", name: "C" }, { playerId: "d", name: "D" }];
  const { pay, repeat } = splitRepeatSeeders(q, new Map([
    ["b", { vip: true, points: true }],
    ["c", { vip: false, points: true }],
    ["d", { vip: true, points: false }],
  ]));
  assert.deepEqual(repeat.map((p) => p.playerId), ["b"]);
  assert.deepEqual(pay.map((p) => p.playerId), ["a", "c", "d"]);
  assert.deepEqual(pay[0], { playerId: "a", name: "A" }, "never paid: paid in full, untouched");
  assert.deepEqual(pay[1], { playerId: "c", name: "C", skipVip: false, skipPoints: true, skipBridge: true }, "the refused VIP only — points already landed");
  assert.deepEqual(pay[2], { playerId: "d", name: "D", skipVip: true, skipPoints: false, skipBridge: true });
  assert.equal(splitRepeatSeeders(q, new Map()).pay.length, 4, "nobody paid yet: everyone is paid");
});

test("seedWindowLabel reads the way a player would say it", () => {
  assert.equal(seedWindowLabel(3600), "1 hour");
  assert.equal(seedWindowLabel(7200), "2 hours");
  assert.equal(seedWindowLabel(5400), "90 minutes");
  assert.equal(seedWindowLabel(1800), "30 minutes");
  assert.equal(seedWindowLabel(60), "1 minute");
});

/*
 * The repeat window lives in the runner (it needs the reward rows), so it is pinned the way the
 * other runner guards are: the split happens BEFORE the pay loop, the pay loop pays only the
 * split's "pay" half, and the thanked half gets the already-paid message and an audit line.
 */
test("the runner pays only seeders not paid in the repeat window, and thanks the rest", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  const split = src.indexOf("splitRepeatSeeders(plan.rewards, seedPaidPlayers(paidRows))");
  const loop = src.indexOf("for (const rw of roundRewards) {");
  const thank = src.indexOf("config.rewardRepeatMessage");
  assert.ok(split > 0 && loop > split, "the split happens before anyone is paid");
  assert.ok(thank > loop, "the already-paid are messaged after the round");
  assert.ok(src.includes('actions: ["seed.reward"], serverId: server.id, from: since'), "who was paid is read from this server's reward rows in the window");
  assert.ok(src.includes('action: "seed.repeat"'), "the thanked seeders are on the record");
  // A failed read must not fall through to paying everyone.
  const fallback = src.slice(split, loop);
  assert.ok(/repeatSeeders = plan\.rewards;\s*roundRewards = \[\];/.test(fallback), "an unreadable window thanks everyone rather than risk a double payment");
});

test("reward delay 0 = fire on every crossing", () => {
  const config = cfg({ seedTarget: 3, minPlayers: 2, minSeedMinutes: 0, rewardEnabled: true, rewardDelaySec: 0 });
  const now = 10_000_000;
  const r = tick({ config, roster: roster(3), prevPhase: "seeding", nowMs: now, lastRewardMs: now - 1000 });
  assert.equal(r.rewarded, true);
  assert.equal(r.rewards.length, 3);
});

test("reward disabled = no rewards on going live", () => {
  const config = cfg({ seedTarget: 3, minPlayers: 2, minSeedMinutes: 0, rewardEnabled: false });
  const r = tick({ config, roster: roster(3), prevPhase: "seeding" });
  assert.equal(r.phase, "live");
  assert.equal(r.rewards.length, 0);
});

test("steady-state live does nothing", () => {
  const r = tick({ config: cfg({ seedTarget: 3, minPlayers: 2 }), roster: roster(5), prevPhase: "live" });
  assert.equal(r.phase, "live");
  assert.equal(r.rewards.length, 0);
  assert.equal(r.progressAdds.length, 0);
  assert.equal(r.actions.length, 0);
});

test("calcRewardExpiration: fresh grant = now + hours", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(calcRewardExpiration(null, 24, true, now), "2026-01-02T00:00:00.000Z");
});

test("calcRewardExpiration: PERMANENT VIP absorbs the reward — null means leave the row alone", () => {
  /*
   * The incident this pins: a permanent grant stores expiration null, and so does "no grant",
   * so the reward math handed only the expiration replaced a PAID permanent VIP with now + 72h
   * — which the expiry sweep then dutifully removed from the game three days later. The row is
   * the input now, and permanent answers null: nothing to write, with either stack setting.
   */
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(calcRewardExpiration({ expiration: null }, 72, true, now), null, "cumulative must not date a permanent grant");
  assert.equal(calcRewardExpiration({ expiration: null }, 72, false, now), null, "non-cumulative must not either");
  // And the absence of a row is still a fresh grant — the two nulls are different facts.
  assert.equal(calcRewardExpiration(undefined, 72, true, now), "2026-01-04T00:00:00.000Z");
});

test("calcRewardExpiration: cumulative stacks onto a future expiry", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(calcRewardExpiration({ expiration: "2026-01-05T00:00:00.000Z" }, 24, true, now), "2026-01-06T00:00:00.000Z");
});

test("calcRewardExpiration: non-cumulative takes the later of existing vs now+hours — never shortens", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  // existing further out -> keep it
  assert.equal(calcRewardExpiration({ expiration: "2026-01-10T00:00:00.000Z" }, 24, false, now), "2026-01-10T00:00:00.000Z");
  // existing sooner -> now+hours wins
  assert.equal(calcRewardExpiration({ expiration: "2026-01-01T06:00:00.000Z" }, 24, false, now), "2026-01-02T00:00:00.000Z");
});

test("planSeedingTick does not advance the ladder it was handed", () => {
  // The contract says pure, and the runner reassigns from the result — but `new Map(prev)` copies
  // the ENTRY REFERENCES, so `st.warns += 1` advanced the caller's own state too. @app/rules hit
  // exactly this and fixed it; this pins the same fix here. It matters because a caller cannot
  // undo what it cannot see: an enforcement that never reached the game should leave the ladder
  // where it was, and that needs the previous value to still say what it said.
  const config = cfg({ minPlayers: 1, seedTarget: 50, maxWarnings: 2, warnIntervalSec: 0, disallowedRoles: [3] });
  const before: EscalationState = new Map([["p0", { warns: 0, lastWarnMs: 0, punishes: 0, lastPunishMs: 0 }]]);
  const snapshot = { ...before.get("p0")! };

  const r = tick({ config, roster: [player("p0", { role: 3 })], escalation: before });
  assert.equal(r.actions.length, 1, "the violation warns");
  assert.equal(r.escalation.get("p0")!.warns, 1, "and the RETURNED ladder advanced");
  assert.deepEqual(before.get("p0"), snapshot, "while the one passed in is untouched");

  // Same input again therefore yields the same decision, rather than silently escalating.
  const again = tick({ config, roster: [player("p0", { role: 3 })], escalation: before });
  assert.equal(again.escalation.get("p0")!.warns, 1);
  assert.equal(again.actions[0]!.kind, "warn", "still a warn — the input was never advanced");
});

/*
 * Weapon rules — the retired "Seeding rules" module, now inside the seeding automation. The
 * properties under test are the ones that differ from the ROLE ladder: a kill is an event, not a
 * state, so a quiet tick is not a recovery; and matching is by class chip first, free-text second.
 */
test("a disallowed weapon class escalates through the ladder; other weapons do not", () => {
  const config = cfg({
    disallowedWeaponClasses: ["artillery"], maxWarnings: 1, maxPunishes: 1,
    warnIntervalSec: 0, punishIntervalSec: 0,
  });
  const classOf = (w: string) => (w.includes("HOWITZER") ? "artillery" : "rifle");
  const base = { config, roster: roster(20), weaponClassOf: classOf };

  const t1 = tick({ ...base, weaponKills: [{ playerId: "p1", name: "p1", weapon: "155MM HOWITZER [M114]" }] });
  assert.deepEqual(t1.actions.map((a) => a.kind), ["warn"]);
  assert.match(t1.actions[0]!.message, /155MM HOWITZER \[M114\] is not allowed while seeding/);
  assert.deepEqual(t1.actions[0]!.reason, { rule: "weapon", detail: "155MM HOWITZER [M114]", step: { n: 1, of: 1 } });

  // A rifle kill is the game working — no action, and no ladder entry to leak.
  const t2 = tick({ ...base, weaponKills: [{ playerId: "p2", name: "p2", weapon: "M1 GARAND" }] });
  assert.equal(t2.actions.length, 0);

  // Second offence, ladder carried forward: punish. A quiet tick between them is NOT a recovery.
  const quiet = tick({ ...base, weaponEscalation: t1.weaponEscalation, weaponKills: [] });
  assert.equal(quiet.actions.length, 0);
  const t3 = tick({ ...base, weaponEscalation: quiet.weaponEscalation, weaponKills: [{ playerId: "p1", name: "p1", weapon: "155MM HOWITZER [M114]" }], nowMs: 1_060_000 });
  assert.deepEqual(t3.actions.map((a) => a.kind), ["punish"]);
});

test("free-text weapon extras match as substrings, like the module they replaced", () => {
  const config = cfg({ disallowedWeapons: ["150MM"], maxWarnings: 1, warnIntervalSec: 0 });
  const t = tick({ config, roster: roster(20), weaponKills: [{ playerId: "p0", name: "p0", weapon: "150MM HOWITZER [sFH 18]" }] });
  assert.deepEqual(t.actions.map((a) => a.kind), ["warn"]);
});

test("weapon rules only bite while seeding, and immunity + absence are respected", () => {
  const config = cfg({ disallowedWeaponClasses: ["artillery"], immuneLevel: 10, seedTarget: 40 });
  const classOf = () => "artillery";
  // Live server: same kill, no action.
  const live = tick({ config, roster: roster(40), prevPhase: "live", weaponClassOf: classOf,
    weaponKills: [{ playerId: "p1", name: "p1", weapon: "HOWITZER" }] });
  assert.equal(live.actions.length, 0);
  // Immune player (level 5 <= 10): skipped.
  const immune = tick({ config, roster: roster(20, (i) => (i === 1 ? { level: 5 } : {})), weaponClassOf: classOf,
    weaponKills: [{ playerId: "p1", name: "p1", weapon: "HOWITZER" }] });
  assert.equal(immune.actions.length, 0);
  // Attacker already gone: nothing to act on, nothing invented.
  const gone = tick({ config, roster: roster(20), weaponClassOf: classOf,
    weaponKills: [{ playerId: "left", name: "left", weapon: "HOWITZER" }] });
  assert.equal(gone.actions.length, 0);
});

test("isDisallowedWeapon: chips match the class, extras match the text, neither guesses", () => {
  const c = { disallowedWeaponClasses: ["artillery"], disallowedWeapons: ["88MM"], disallowedWeaponNames: [] };
  assert.equal(isDisallowedWeapon(c, "artillery", "155MM HOWITZER"), true);
  assert.equal(isDisallowedWeapon(c, "rifle", "M1 GARAND"), false);
  assert.equal(isDisallowedWeapon(c, null, "88MM KWK 36"), true, "extras work with no class at all");
  assert.equal(isDisallowedWeapon(c, null, "M1 GARAND"), false);
});

test("isDisallowedWeapon: a picked name is exact — the one overpowered gun, not its neighbours", () => {
  // The point of individual names over substrings: banning the drum PPSH must not ban the plain
  // one, even though the plain one's name is a substring of the drum's.
  const c = { disallowedWeaponClasses: [], disallowedWeapons: [], disallowedWeaponNames: ["PPSH 41 W/DRUM"] };
  assert.equal(isDisallowedWeapon(c, "smg", "PPSH 41 W/DRUM"), true);
  assert.equal(isDisallowedWeapon(c, "smg", "ppsh 41 w/drum"), true, "case-insensitive, like the log");
  assert.equal(isDisallowedWeapon(c, "smg", "PPSH 41"), false, "the plain gun stays legal");
});

test("an individually picked weapon escalates while its classmates stay legal", () => {
  const config = cfg({ disallowedWeaponNames: ["MG42"], maxWarnings: 1, warnIntervalSec: 0 });
  const classOf = () => "mg"; // both kills are machine guns; only the named one is picked
  const banned = tick({ config, roster: roster(20), weaponClassOf: classOf,
    weaponKills: [{ playerId: "p1", name: "p1", weapon: "MG42" }] });
  assert.deepEqual(banned.actions.map((a) => a.kind), ["warn"]);
  assert.match(banned.actions[0]!.message, /MG42 is not allowed while seeding/);
  const classmate = tick({ config, roster: roster(20), weaponClassOf: classOf,
    weaponKills: [{ playerId: "p2", name: "p2", weapon: "MG34" }] });
  assert.equal(classmate.actions.length, 0);
});

test("a blocked commander ability escalates, and says it was a commander ability", () => {
  const config = cfg({ disallowedCommanderAbilities: ["BOMBING RUN", "PRECISION STRIKE"], maxWarnings: 1, warnIntervalSec: 0 });
  // Deliberately no weaponClassOf and no weapon config: the ability check stands on its own.
  const hit = tick({ config, roster: roster(20),
    weaponKills: [{ playerId: "p1", name: "p1", weapon: "BOMBING RUN" }] });
  assert.deepEqual(hit.actions.map((a) => a.kind), ["warn"]);
  assert.match(hit.actions[0]!.message, /commander ability BOMBING RUN is not allowed while seeding/);
  assert.deepEqual(hit.actions[0]!.reason, { rule: "ability", detail: "BOMBING RUN", step: { n: 1, of: 1 } });
  // The un-blocked ability stays legal — blocking one strike is not blocking the commander.
  const other = tick({ config, roster: roster(20),
    weaponKills: [{ playerId: "p1", name: "p1", weapon: "STRAFING RUN" }] });
  assert.equal(other.actions.length, 0);
});

test("the announcement a seeder receives lists the rules actually in force", () => {
  // The greeting and the enforcement are one policy: the message is composed from the same config
  // that punishes, so it cannot promise a rule the server isn't applying.
  const config = cfg({
    announceMessage: "Seeding — thanks for helping!",
    disallowedRoles: [13],
    disallowedWeaponClasses: ["artillery"],
    disallowedCommanderAbilities: ["BOMBING RUN"],
  });
  const t = tick({
    config, roster: roster(20), joined: roster(20).map((p) => ({ playerId: p.playerId, name: p.name })),
    roleName: (r: number) => (r === 13 ? "Commander" : `role ${r}`),
    weaponClassName: (id: string) => (id === "artillery" ? "Artillery" : id),
  });
  assert.equal(t.announces.length, 20, "everyone who joined");
  const msg = t.announces[0]!.message;
  assert.match(msg, /^Seeding — thanks for helping!/, "the admin's own words come first");
  assert.match(msg, /Roles: Commander/);
  assert.match(msg, /Weapons: Artillery/);
  assert.match(msg, /Commander abilities: BOMBING RUN/);
  // Told once per join, not once per tick — the composed text must not defeat that.
  const again = tick({ config, roster: roster(20) });
  assert.equal(again.announces.length, 0);
});

// ---- cap fight (CRCON's enforce_cap_fight, the third seeding rule) ----

const WARFARE = { gameMode: "warfare", alliedScore: 3, axisScore: 2 };

test("cap fight: first sight records the baseline, a later climb is the violation", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense })];
  // Allies hold 3 caps — winning — so the first observation only records the score.
  const t1 = tick({ config, roster: winner(100), session: WARFARE });
  assert.equal(t1.actions.length, 0, "first observation records, never punishes");
  assert.equal(t1.capOffense.get("w"), 100);
  // Same score next tick: standing still is not attacking.
  const t2 = tick({ config, roster: winner(100), session: WARFARE, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.equal(t2.actions.length, 0);
  // The score climbed — only standing in the enemy cap does that while winning.
  const t3 = tick({ config, roster: winner(120), session: WARFARE, capOffense: t2.capOffense, capEscalation: t2.capEscalation });
  assert.deepEqual(t3.actions.map((a) => a.kind), ["warn"]);
  // The warn quotes capFightNotice — the same words the greeting shows (default here).
  assert.match(t3.actions[0]!.message, /Attacking the next point while your team is winning/);
  assert.deepEqual(t3.actions[0]!.reason, { rule: "capFight", detail: "their team already held 3 caps", step: { n: 1, of: 1 } });
});

/*
 * The warn's {violation} is capFightNotice — the greeting's line and the enforcement message are
 * deliberately the SAME words, so the player is warned in the sentence they were shown on join.
 * A blank notice keeps the line out of the greeting but must not blank the warn: an enforcement
 * message naming no rule reads as a bot malfunction, so it falls back to the stock phrase.
 */
test("cap fight: the warn is worded by capFightNotice, and blank falls back to the stock phrase", () => {
  const base = { capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 };
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense })];
  const run = (notice: string) => {
    const config = cfg({ ...base, capFightNotice: notice });
    const t1 = tick({ config, roster: winner(100), session: WARFARE });
    return tick({ config, roster: winner(120), session: WARFARE, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  };
  assert.match(run("Do NOT push the 4th point").actions[0]!.message, /Do NOT push the 4th point/);
  assert.match(run("  ").actions[0]!.message, /attacking the next point is not allowed while seeding/);
});

test("cap fight: warfare only — offensive-mode scores mean something else, so the rule stands down", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const r = [player("w", { side: "allies" as const, offense: 100 })];
  const off = { gameMode: "offensive", alliedScore: 3, axisScore: 2 };
  const t1 = tick({ config, roster: r, session: off, capOffense: new Map([["w", 10]]) });
  assert.equal(t1.actions.length, 0);
  assert.equal(t1.capOffense.size, 0, "stale baselines are dropped, not kept for the next warfare round");
  // No session read at all (rule couldn't see the mode) -> same stand-down.
  const t2 = tick({ config, roster: r, session: null, capOffense: new Map([["w", 10]]) });
  assert.equal(t2.actions.length, 0);
  assert.equal(t2.capOffense.size, 0);
});

/*
 * Field report: a seeder capped the 4th point on the WW2 server and the rule never fired. Live
 * builds report enum-shaped values (the same servers send platforms as EPlatformFamily::Steam),
 * and the rule compared the mode to the bare string "warfare" — any other spelling disarmed it
 * silently. The verdict now strips the enum prefix, matches loosely, and falls back to the map id.
 */
test("cap fight: the warfare check reads enum-shaped modes and falls back to the map id", () => {
  assert.equal(warfareVerdict("warfare", null), "warfare");
  assert.equal(warfareVerdict("EGameMode::Warfare", null), "warfare");
  assert.equal(warfareVerdict("Warfare", "stmereeglise_warfare"), "warfare");
  assert.equal(warfareVerdict("EGameMode::Offensive", null), "other");
  assert.equal(warfareVerdict("Conquest", null), "other");
  assert.equal(warfareVerdict("Skirmish", null), "other");
  // Empty or unfamiliar text: the map id decides.
  assert.equal(warfareVerdict("", "carentan_warfare"), "warfare");
  assert.equal(warfareVerdict("EGameMode::SomethingNew", "foy_offensive_ger"), "other");
  assert.equal(warfareVerdict(null, "CAR_L_1944_Conquest_Day"), "other");
  // Neither says anything: couldn't tell — never "not warfare".
  assert.equal(warfareVerdict("", null), "unknown");

  // End to end: an enum-shaped warfare round arms the rule exactly as the bare word does.
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense })];
  const enumWarfare = { gameMode: "EGameMode::Warfare", alliedScore: 3, axisScore: 2 };
  const t1 = tick({ config, roster: winner(100), session: enumWarfare });
  assert.equal(t1.capFightMode, "warfare");
  const t2 = tick({ config, roster: winner(130), session: enumWarfare, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.deepEqual(t2.actions.map((a) => a.kind), ["warn"], "the 4th-point push is caught");
  // No mode text at all, but the map id says warfare: still armed.
  const byMap = { gameMode: "", alliedScore: 3, axisScore: 2, mapId: "stmereeglise_warfare" };
  const u1 = tick({ config, roster: winner(100), session: byMap });
  const u2 = tick({ config, roster: winner(130), session: byMap, capOffense: u1.capOffense, capEscalation: u1.capEscalation });
  assert.equal(u2.actions.length, 1);
});

/*
 * Ticket closed-4996, second finding: punish-first was ON and the bot still said nothing — so
 * every path where the rule holds without acting must classify itself. "armed-blind" is the one
 * that matches the ticket best after the mode fix: a team at the cap line whose roster rows carry
 * no offense score leaves the detector nothing to see, and it must say so as a state, not stay
 * indistinguishable from "armed and quiet because nobody attacked".
 */
test("cap fight: every held or blind condition classifies itself", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const winner = (offense: number | null) => [player("w", { side: "allies" as const, offense })];

  // Armed and watching: warfare, scores, a winner with a readable offense score.
  const armed = tick({ config, roster: winner(100), session: { gameMode: "warfare", alliedScore: 3, axisScore: 2 } });
  assert.equal(armed.capFightState, "armed");
  assert.match(armed.capFightNote!, /watching 1 of 1/);

  // Armed but BLIND: the winning team's rows carry no offense score — the ticket's shape.
  const blind = tick({ config, roster: winner(null), session: { gameMode: "warfare", alliedScore: 3, axisScore: 2 } });
  assert.equal(blind.capFightState, "armed-blind");
  assert.match(blind.capFightNote!, /none carry an offense score/);

  // No team at the line yet: the normal seed state.
  const early = tick({ config, roster: winner(100), session: { gameMode: "warfare", alliedScore: 2, axisScore: 2 } });
  assert.equal(early.capFightState, "no-leader");

  // Warfare but the session read carried no scores: holding, and saying which half is missing.
  const noScores = tick({ config, roster: winner(100), session: { gameMode: "warfare", alliedScore: null, axisScore: null } });
  assert.equal(noScores.capFightState, "holding-scores");

  // Neither mode text nor map id: holding on the mode.
  const noMode = tick({ config, roster: winner(100), session: { gameMode: "", alliedScore: 3, axisScore: 2 } });
  assert.equal(noMode.capFightState, "holding-mode");

  // A non-warfare round: standing down is the correct, named state.
  const off = tick({ config, roster: winner(100), session: { gameMode: "offensive", alliedScore: 3, axisScore: 2 } });
  assert.equal(off.capFightState, "standing-down");
});

test("cap fight: only the team at/over maxCaps is tracked, and losing the lead clears the baseline", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const both = (allied: number, axis: number) => [
    player("a", { side: "allies" as const, offense: allied }),
    player("x", { side: "axis" as const, offense: axis }),
  ];
  // Allies 3 caps (winning), axis 2 (not): only the allied player is recorded.
  const t1 = tick({ config, roster: both(50, 50), session: WARFARE });
  assert.ok(t1.capOffense.has("a"));
  assert.ok(!t1.capOffense.has("x"), "the losing team may attack — that's the fight seeding wants");
  // The axis player's offense climbing is fine; the allied player's is the violation.
  const t2 = tick({ config, roster: both(80, 500), session: WARFARE, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.deepEqual(t2.actions.map((a) => a.playerId), ["a"]);
  // Scores flip to 2-3: allies no longer winning -> baseline dropped, so a re-take doesn't
  // compare against a score from the previous lead.
  const flipped = { gameMode: "warfare", alliedScore: 2, axisScore: 3 };
  const t3 = tick({ config, roster: both(999, 500), session: flipped, capOffense: t2.capOffense, capEscalation: t2.capEscalation });
  assert.ok(!t3.capOffense.has("a"));
});

test("cap fight: skip-warning spends the warnings, so the first offence lands on punish", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, capFightSkipWarning: true, minPlayers: 1, maxWarnings: 2, punishIntervalSec: 0 });
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense })];
  const t1 = tick({ config, roster: winner(100), session: WARFARE });
  const t2 = tick({ config, roster: winner(120), session: WARFARE, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.deepEqual(t2.actions.map((a) => a.kind), ["punish"]);
});

test("cap fight: immunity and the disabled toggle both stand the rule down", () => {
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense, level: 3 })];
  // Immune by level: observed (baseline still tracked) but never actioned.
  const immune = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, immuneLevel: 5, maxWarnings: 1, warnIntervalSec: 0 });
  const t1 = tick({ config: immune, roster: winner(100), session: WARFARE });
  const t2 = tick({ config: immune, roster: winner(120), session: WARFARE, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.equal(t2.actions.length, 0);
  // Toggle off: nothing tracked at all, and any leftover baseline is dropped.
  const offCfg = cfg({ capFightEnabled: false, minPlayers: 1 });
  const t3 = tick({ config: offCfg, roster: winner(100), session: WARFARE, capOffense: new Map([["w", 10]]) });
  assert.equal(t3.capOffense.size, 0);
  assert.equal(t3.actions.length, 0);
});

test("cap fight: its ladder survives role recovery, and going live clears it", () => {
  // A cap-fighter on a LEGAL role must not have their steps wiped by the role loop's
  // recovered-players reset — the ladders are separate maps.
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, disallowedRoles: [7], maxWarnings: 1, warnIntervalSec: 0, punishIntervalSec: 0, seedTarget: 40, minPlayers: 1 });
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense, role: 0 })];
  const t1 = tick({ config, roster: winner(100), session: WARFARE });
  const t2 = tick({ config, roster: winner(120), session: WARFARE, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.deepEqual(t2.actions.map((a) => a.kind), ["warn"]);
  const t3 = tick({ config, roster: winner(140), session: WARFARE, capOffense: t2.capOffense, capEscalation: t2.capEscalation, nowMs: 1_060_000 });
  assert.deepEqual(t3.actions.map((a) => a.kind), ["punish"], "second climb continues the ladder — role recovery didn't reset it");
  // Seeding -> live: cycle over, both cap maps are part of the reset.
  const live = tick({ config, roster: roster(40, () => ({ side: "allies" as const, offense: 5 })), session: WARFARE, capOffense: t3.capOffense, capEscalation: t3.capEscalation, prevPhase: "seeding" });
  assert.equal(live.phase, "live");
  assert.equal(live.capOffense.size, 0);
  assert.equal(live.capEscalation.size, 0);
});

/**
 * The seed reward pays in two currencies, independently: VIP time, community points, or both.
 *
 * One reward message has to read correctly in every combination, or turning points on quietly
 * leaves seeders being told they got "24h of VIP" when what they got was 500 points. `{reward}`
 * composes whichever halves are switched on, so staff write one sentence rather than three.
 */
test("vipSpan speaks in months, days and hours, never a wall of hours", () => {
  assert.equal(vipSpan(5), "5h");
  assert.equal(vipSpan(24), "1d");
  assert.equal(vipSpan(36), "1d 12h");
  assert.equal(vipSpan(168), "7d");
  assert.equal(vipSpan(720), "1mo");
  assert.equal(vipSpan(756), "1mo 1d 12h");
  assert.equal(vipSpan(0), "0h", "zero still reads as a duration (rewardPhrase drops it before this matters)");
});

test("the reward message says when VIP now runs out, CRCON-style", () => {
  const base = { playerName: "Kreitz", points: 0, linked: false, credited: null, balance: null,
    currencyName: "Points", linkedNote: "", unlinkedNote: "", message: "You've been granted {reward}." };
  assert.equal(
    composeRewardMessage({ ...base, hours: 24, vipUntil: "Oct 3, 7:45 PM EDT" }),
    "You've been granted 1d of VIP. Your VIP on this server runs until Oct 3, 7:45 PM EDT.");
  assert.equal(
    composeRewardMessage({ ...base, hours: 24, vipUntil: "Oct 3", message: "VIP until {vip_until} - enjoy your {reward}." }),
    "VIP until Oct 3 - enjoy your 1d of VIP.", "a placed token says where the date belongs");
  assert.equal(
    composeRewardMessage({ ...base, hours: 24, vipUntil: null }),
    "You've been granted 1d of VIP.", "no date, no dangling sentence");
  // The permanent-VIP absorb finally says something instead of nothing.
  assert.equal(
    composeRewardMessage({ ...base, hours: 0, vipAbsorbed: true }),
    "Thanks for helping us seed, Kreitz! Your VIP is permanent, so there was nothing to add.");
});

test("formatVipUntil renders the community timezone and survives a bad one", () => {
  const now = Date.parse("2026-09-26T00:00:00Z");
  const et = formatVipUntil("2026-10-03T23:45:00Z", "America/New_York", now)!;
  assert.match(et, /Oct 3/);
  assert.match(et, /7:45/);
  const bad = formatVipUntil("2026-10-03T23:45:00Z", "not/a-zone", now)!;
  assert.match(bad, /11:45/);
  assert.match(formatVipUntil("2027-01-02T00:00:00Z", null, now)!, /2027/, "a far expiry spells its year");
  assert.equal(formatVipUntil("garbage", null, now), null);
});

test("rosterIdOf reads the id whatever the wire spells it, skipping empties", () => {
  assert.equal(rosterIdOf({ iD: "a" }), "a");
  assert.equal(rosterIdOf({ Id: "b" }), "b");
  assert.equal(rosterIdOf({ ID: "c" }), "c");
  assert.equal(rosterIdOf({ iD: "", id: "d" }), "d", "an empty spelling never shadows a real one");
  assert.equal(rosterIdOf({}), "");
});

test("rewardPhrase says what is actually being given, in every combination", () => {
  assert.equal(rewardPhrase(24, 0, "Points"), "1d of VIP");
  assert.equal(rewardPhrase(0, 500, "Points"), "500 Points");
  assert.equal(rewardPhrase(24, 500, "Points"), "1d of VIP and 500 Points");
  // The currency is whatever the community named it.
  assert.equal(rewardPhrase(0, 50, "Lynx Bucks"), "50 Lynx Bucks");
  // Nothing switched on says nothing — the route refuses to STORE that, but a config written
  // before the rule existed still has to render rather than printing "undefined".
  assert.equal(rewardPhrase(0, 0, "Points"), "");
  // Negatives and stray zeroes never become a phrase.
  assert.equal(rewardPhrase(-5, 0, "Points"), "");
});

test("the reward message renders from the same tokens the worker passes", () => {
  const render = (hours: number, points: number) => applyVars(
    "Thanks for helping us seed! You've been granted {reward}.",
    { player_name: "Kreitz", reward_hours: hours, reward_points: points, currency: "Points", reward: rewardPhrase(hours, points, "Points") },
  );
  assert.equal(render(24, 0), "Thanks for helping us seed! You've been granted 1d of VIP.");
  assert.equal(render(0, 500), "Thanks for helping us seed! You've been granted 500 Points.");
  assert.equal(render(24, 500), "Thanks for helping us seed! You've been granted 1d of VIP and 500 Points.");
  // A community that wrote its own sentence still gets the individual numbers.
  assert.equal(
    applyVars("{player_name}: {reward_points} {currency} and {reward_hours}h VIP", { player_name: "Kreitz", reward_hours: 12, reward_points: 250, currency: "Points" }),
    "Kreitz: 250 Points and 12h VIP",
  );
});

/**
 * An unlinked seeder must not be TOLD they got points.
 *
 * Points are a balance on a Discord account, so the two halves of the reward do not always both
 * land: somebody who has never linked collects the VIP and nothing else. The message is therefore
 * composed per player rather than per round — "granted 24h of VIP and 500 Points" to somebody who
 * received 24h of VIP is exactly the message that turns a missing reward into a support ticket.
 */
test("the reward a player is told about is the reward that reached them", () => {
  const say = (hours: number, points: number, linked: boolean) => {
    const theirs = points > 0 && linked ? points : 0;
    return applyVars("You've been granted {reward}.", {
      reward_hours: hours, reward_points: theirs, currency: "Points",
      reward: rewardPhrase(hours, theirs, "Points"),
    });
  };
  assert.equal(say(24, 500, true), "You've been granted 1d of VIP and 500 Points.");
  assert.equal(say(24, 500, false), "You've been granted 1d of VIP.", "no link, no points, and no claim of points");
  assert.equal(say(0, 500, true), "You've been granted 500 Points.");
  // Points-only and unlinked: nothing reached them, so the empty phrase is the runner's signal to
  // say nothing at all rather than send a sentence with a hole in it.
  assert.equal(rewardPhrase(0, 0, "Points"), "");
  assert.equal(say(0, 500, false), "You've been granted .", "which is why the runner checks the phrase before sending");
});

/**
 * The seed reward is paid at most once per crossing, and the guard that makes that true has to
 * come FIRST.
 *
 * `lastRewardAt` is the debounce, read back from the store on every tick. Stamped after the
 * payment loop — where it used to be — a worker that died half way through paying came back, found
 * no stamp, re-detected the transition and paid everyone it had already paid a second time:
 * cumulative VIP stacked twice, and points would have too. The per-credit `ref` cannot cover it,
 * because the retry is a new round carrying a new timestamp.
 *
 * The runner is I/O around `planSeedingTick` and cannot be unit-driven, so this asserts the
 * ORDER in the source — which is the whole of the property.
 */
test("the reward debounce is stamped before any reward is paid", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  // Scoped to the seed runner's reward step: `addVip` is also issued by the VIP pause-resume sweep
  // earlier in the file, and a whole-file search would compare against that instead.
  const from = src.indexOf("4) Rewards on seeding→live");
  const to = src.indexOf("// 5) End the cycle");
  assert.ok(from > 0 && to > from, "could not find the seed runner's reward step");
  const step = src.slice(from, to);

  const stamp = step.indexOf("if (plan.rewarded && !dryRun) {");
  const loop = step.indexOf("for (const rw of roundRewards) {");
  const grantVip = step.indexOf('await client.execute("addVip"');
  const grantPoints = step.indexOf("await repo.economy.apply(");
  for (const [what, at] of [["the payment loop", loop], ["the VIP grant", grantVip], ["the points credit", grantPoints]] as const) {
    assert.ok(at > 0, `could not find ${what} in the reward step`);
  }
  assert.ok(stamp > 0, "the pre-payment stamp is gone — the debounce is back to being written after the fact");
  assert.ok(stamp < loop, "the debounce must be stamped before the payment loop opens");
  assert.ok(stamp < grantVip && stamp < grantPoints, "…and before either currency is handed over");
});

/*
 * A group perk that takes no rewards. The seed reward asks the hold's groups before it promises
 * anything — the message and the dry run read vipHeld — and both banking calls in the step, the
 * seeder's own server and each bridge stop, bank as a reward. Source-order, for the same reason as
 * the debounce test above; rewardsRefusedBy and bankIfHeld themselves are tested on both stores.
 */
test("a group perk taking no rewards: the seed reward and the bridge ask the hold before anything banks", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  const from = src.indexOf("4) Rewards on seeding→live");
  const to = src.indexOf("// 5) End the cycle");
  assert.ok(from > 0 && to > from, "could not find the seed runner's reward step");
  const step = src.slice(from, to);
  const ask = step.indexOf("const holdRefuses = existingVip?.groupHold ? await rewardsRefusedBy(repo, existingVip.groupHold) : [];");
  const held = step.indexOf("const vipHeld = rwHours > 0 && !!existingVip?.groupHold && !holdRefuses.length;");
  const phrase = step.indexOf("const phrase = rewardPhrase(vipHours");
  assert.ok(ask > 0 && held > ask && phrase > held, "whether the hold takes rewards is asked before anything is promised");
  assert.equal([...step.matchAll(/bankIfHeld\(/g)].length, 2, "two banking calls in the step");
  assert.equal([...step.matchAll(/bankIfHeld\(repo, [^;]*\{ reward: true \}\)/g)].length, 2, "and both bank as a reward");
});

/*
 * A refused game call must not drop the seeder. The VIP grant used to share one try with the
 * store write, the points and the receipt, so an AddVip refusal paid nothing and wrote nothing —
 * only permanent VIPs (who skip the call) came out with receipts, and a round looked like it paid
 * "only staff". Source-order again, for the same reason as the debounce test above.
 */
test("a refused VIP grant is isolated, and a failed seeder always gets a receipt", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  const from = src.indexOf("4) Rewards on seeding\u2192live");
  const to = src.indexOf("// 5) End the cycle");
  assert.ok(from > 0 && to > from, "could not find the seed runner's reward step");
  const step = src.slice(from, to);
  assert.ok(step.includes('try { await client.execute("addVip", { playerId: rw.playerId'), "the seeder's AddVip is in its own try");
  assert.ok(step.includes("detail.vipFailed"), "a refused new grant is recorded, not thrown");
  const catchAt = step.indexOf('slog.warn("seed reward failed"');
  assert.ok(catchAt > 0, "the per-seeder catch is still there");
  assert.match(step.slice(catchAt, catchAt + 900), /repo\.audit\.create\([\s\S]*seed reward FAILED/, "and it writes a receipt, not just a log line");
});

/**
 * The currency footnote — the half that reaches the seeder who got nothing.
 *
 * Points land on a Discord account, so an unlinked seeder collects the VIP half and would never
 * hear that a currency reward exists at all: they cannot ask about something nobody told them
 * about. The footnote says what they COULD have earned, which is true and is the reason to link.
 * It is sent whenever points are switched on, to linked and unlinked alike.
 */
/** The runner's own composer, with the config defaults it is normally handed. */
function compose(o: {
  hours: number; points: number; linked: boolean;
  credited?: number; balance?: number;
  message?: string; linkedNote?: string; unlinkedNote?: string; currency?: string;
}) {
  return composeRewardMessage({
    playerName: "Kreitz",
    hours: o.hours, points: o.points, linked: o.linked,
    credited: o.credited ?? null, balance: o.balance ?? null,
    currencyName: o.currency ?? "Points",
    message: o.message ?? SEEDING_DEFAULTS.rewardMessage,
    linkedNote: o.linkedNote ?? SEEDING_DEFAULTS.rewardLinkedNote,
    unlinkedNote: o.unlinkedNote ?? SEEDING_DEFAULTS.rewardUnlinkedNote,
  });
}

test("a linked seeder is told what landed and what their total is", () => {
  const msg = compose({ hours: 24, points: 500, linked: true, credited: 500, balance: 1750 });
  assert.match(msg, /granted 1d of VIP and 500 Points\./);
  assert.match(msg, /you're linked and earned 500\. Your total is 1750\./);
  assert.doesNotMatch(msg, /\{/, "no token survives into what a player reads");
});

test("an unlinked seeder hears what they could have earned, and never that they got it", () => {
  const msg = compose({ hours: 24, points: 500, linked: false });
  // The reward half is honest: VIP only, because that is all that reached them.
  assert.match(msg, /granted 1d of VIP\./);
  assert.doesNotMatch(msg, /earned 500 Points|and 500 Points/, "never claims the points landed");
  assert.match(msg, /could have earned 500/);
  assert.match(msg, /Visit our Discord to link/);
  assert.doesNotMatch(msg, /\{/);
});

test("points-only and unlinked: the footnote is the whole message, not a sentence with a hole", () => {
  const msg = compose({ hours: 0, points: 500, linked: false });
  assert.doesNotMatch(msg, /granted/, "nothing reached them, so the reward line is not sent");
  assert.match(msg, /^This server offers Points rewards for seeding/);
  assert.match(msg, /could have earned 500/);
});

test("no points configured means no footnote at all", () => {
  const msg = compose({ hours: 24, points: 0, linked: false });
  assert.equal(msg, "Thanks for helping us seed! You've been granted 1d of VIP.");
});

test("the footnote reports what was CREDITED — a capped credit is not the amount promised", () => {
  const msg = compose({ hours: 0, points: 500, linked: true, credited: 120, balance: 5000 });
  assert.match(msg, /earned 120\. Your total is 5000\./);
  assert.doesNotMatch(msg, /earned 500/);
});

test("an empty note switches that half off without touching the other", () => {
  assert.equal(compose({ hours: 0, points: 500, linked: false, unlinkedNote: "" }), "");
  assert.match(compose({ hours: 0, points: 500, linked: true, credited: 500, balance: 500, linkedNote: "" }), /granted 500 Points\./);
});

test("a community's own wording and currency name carry through both halves", () => {
  const msg = compose({
    hours: 0, points: 50, linked: false, currency: "Lynx Bucks",
    unlinkedNote: "{player_name}: link at discord.gg/lynx to collect {reward_points} {currency}.",
  });
  assert.equal(msg, "Kreitz: link at discord.gg/lynx to collect 50 Lynx Bucks.");
});

/*
 * ---- containment: the seed fight stays inside the sectors staff drew ----
 * The planner takes the map's allowed sets pre-resolved (the runner knows the map); these tests
 * drive the grace clock, the recovery reset, the "no position is no violation" rule and the
 * player-count disarm — the judgements that make a geofence a seeding tool rather than a trap.
 */

const CONTAIN_CFG = () => cfg({
  minPlayers: 1, seedTarget: 50, containEnabled: true, containGraceSec: 60, containMaxPlayers: 0,
  maxWarnings: 2, warnIntervalSec: 0, containNotice: "Leaving the seeding area",
  containZones: { carentan: { allies: ["A1"], axis: ["J10"], shared: ["E5"] } },
});
// Positions that land squarely in named sectors: A1 top-left, E5 centre-ish, J10 bottom-right.
const IN_A1 = { x: -95_000, y: -95_000 };
const IN_E5 = { x: -10_000, y: -10_000 };
const IN_J10 = { x: 90_000, y: 90_000 };

test("containment: outside starts a grace clock; the warn lands only after it runs out", () => {
  const config = CONTAIN_CFG();
  const zone = resolveContainZone(config, "carentan");
  const wanderer = () => [player("a", { side: "allies", pos: IN_J10 })]; // an allies player deep in axis ground
  const t1 = tick({ config, roster: wanderer(), containZone: zone, nowMs: 1_000_000 });
  assert.equal(t1.actions.length, 0, "first sight starts the clock, not the ladder");
  assert.ok(t1.containState.has("a"));
  const t2 = tick({ config, roster: wanderer(), containZone: zone, containState: t1.containState, containEscalation: t1.containEscalation, nowMs: 1_030_000 });
  assert.equal(t2.actions.length, 0, "30s in, the grace still holds");
  const t3 = tick({ config, roster: wanderer(), containZone: zone, containState: t2.containState, containEscalation: t2.containEscalation, nowMs: 1_061_000 });
  assert.equal(t3.actions.length, 1);
  assert.equal(t3.actions[0]!.kind, "warn");
  assert.match(t3.actions[0]!.message, /Leaving the seeding area/, "the warn quotes the greeting's own words");
  assert.deepEqual(t3.actions[0]!.reason, { rule: "zone", detail: "on the other team's painted ground", step: { n: 1, of: 2 } });
});

test("containment: coming back inside clears the clock AND the ladder — recovery is recovery", () => {
  const config = CONTAIN_CFG();
  const zone = resolveContainZone(config, "carentan");
  const out = tick({ config, roster: [player("a", { side: "allies", pos: IN_J10 })], containZone: zone, nowMs: 1_000_000 });
  assert.ok(out.containState.has("a"));
  const back = tick({ config, roster: [player("a", { side: "allies", pos: IN_A1 })], containZone: zone, containState: out.containState, containEscalation: out.containEscalation, nowMs: 1_030_000 });
  assert.ok(!back.containState.has("a"), "the clock is gone");
  assert.equal(back.containEscalation.size, 0, "and so is the ladder");
});

test("containment: shared cells admit both sides; a player is judged only on the other team's ground", () => {
  const config = CONTAIN_CFG();
  const zone = resolveContainZone(config, "carentan")!;
  // Both sides standing in the shared cell: nobody is outside.
  const t = tick({ config, roster: [
    player("a", { side: "allies", pos: IN_E5 }),
    player("b", { side: "axis", pos: IN_E5 }),
  ], containZone: zone, nowMs: 1_000_000 });
  assert.equal(t.containState.size, 0);
  // A map drawn for the Allies only: nothing is Axis ground, so the Allies are free everywhere,
  // and the Axis is kept off the Allies' square alone.
  const oneSided = resolveContainZone(cfg({ containEnabled: true, containZones: { carentan: { allies: ["A1"], axis: [], shared: [] } } }), "carentan")!;
  assert.equal(oneSided.axis, null);
  const t2 = tick({ config, roster: [player("a", { side: "allies", pos: IN_J10 }), player("b", { side: "axis", pos: IN_J10 })], containZone: oneSided, nowMs: 1_000_000 });
  assert.equal(t2.containState.size, 0, "away from the Allies' square, nobody is judged");
  const t3 = tick({ config, roster: [player("b", { side: "axis", pos: IN_A1 })], containZone: oneSided, nowMs: 1_000_000 });
  assert.deepEqual([...t3.containState.keys()], ["b"], "on it, the Axis is");
});

test("containment: an empty square is free for both teams — the same as painting it for both", () => {
  // The owner's call: leave the middle empty instead of painting it "both teams". Allies' ground is
  // rows 2–4, the Axis' rows 7–9; rows 5–6 are left empty in one paint and painted shared in the other.
  const cols = "ABCDEFGHIJ".split("");
  const rows = (rs: number[]) => rs.flatMap((r) => cols.map((c) => `${c}${r}`));
  const paint = (shared: string[]) => resolveContainZone(cfg({ containEnabled: true, containZones: { foy: { allies: rows([2, 3, 4]), axis: rows([7, 8, 9]), shared } } }), "foy")!;
  const at = (id: string, side: "allies" | "axis", row: number) => player(id, { side, pos: { x: -10_000, y: -100_000 + (row - 0.5) * 20_000 } });
  const roster = [at("a5", "allies", 5), at("a6", "allies", 6), at("x5", "axis", 5), at("x6", "axis", 6), at("aDeep", "allies", 8), at("xDeep", "axis", 3)];
  const config = cfg({ minPlayers: 1, seedTarget: 50, containEnabled: true, containGraceSec: 0, containMaxPlayers: 0 });
  const empty = tick({ config, roster, containZone: paint([]), nowMs: 1_000_000 });
  const both = tick({ config, roster, containZone: paint(rows([5, 6])), nowMs: 1_000_000 });
  assert.deepEqual([...empty.containState.keys()].sort(), ["aDeep", "xDeep"], "only players on the other team's ground");
  assert.deepEqual([...both.containState.keys()].sort(), [...empty.containState.keys()].sort(), "an empty middle and a shared one judge the same players");
  // A square claimed by both lists (only a hand-made request can) is nobody's ground either.
  const overlap = resolveContainZone(cfg({ containEnabled: true, containZones: { foy: { allies: ["E5", "E3"], axis: ["E5", "E8"], shared: [] } } }), "foy")!;
  assert.deepEqual([...overlap.allies!], ["E3"]);
  assert.deepEqual([...overlap.axis!], ["E8"]);
});

test("containment: a layer painted with 'both teams' squares alone is still its paint — nobody judged, nothing else stands in", () => {
  const config = cfg({ containEnabled: true, containAutoEnabled: true, containGraceSec: 10, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0,
    containZones: { "@foy_warfare": { allies: [], axis: [], shared: ["E5"] }, foy: { allies: ["A1"], axis: ["J10"], shared: [] } } });
  const layer = resolveContainZone(config, "@foy_warfare");
  assert.ok(layer, "the layer's paint comes back, so the runner never falls through to the family's");
  assert.deepEqual([layer!.allies, layer!.axis], [null, null], "and it is nobody's ground");
  // The auto fence would judge this Ally deep in the Axis half; the painted layer outranks it.
  const session = { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "foy_warfare" };
  const home = [player("a", { side: "allies" as const, pos: { x: -70_000, y: 0 } })];
  const deep = [player("a", { side: "allies" as const, pos: { x: 70_000, y: 0 } })];
  const o1 = tick({ config, roster: home, session, axisCal: calState(-80_000, 0, 80_000, 0), containZone: layer, nowMs: 900_000 });
  const o2 = tick({ config, roster: home, session, axisCal: o1.axisCal, containZone: layer, nowMs: 950_000 });
  const t = tick({ config, roster: deep, session, axisCal: o2.axisCal, containZone: layer, nowMs: 1_000_000 });
  assert.equal(t.containState.size, 0);
  assert.equal(tick({ config, roster: deep, session, axisCal: o2.axisCal, containZone: null, nowMs: 1_000_000 }).containState.size, 1, "where nothing is painted, the auto fence does judge");
});

test("containment: no position, and no resolved side, are never violations", () => {
  const config = CONTAIN_CFG();
  const zone = resolveContainZone(config, "carentan");
  const t = tick({ config, roster: [
    player("deploying", { side: "allies", pos: null }),
    player("teamless", { side: null, pos: IN_J10 }),
  ], containZone: zone, nowMs: 1_000_000 });
  assert.equal(t.containState.size, 0);
  assert.equal(t.actions.length, 0);
});

test("containment: at the player cap the rule stands down and forgets its clocks", () => {
  const config = cfg({ ...CONTAIN_CFG(), containMaxPlayers: 10 });
  const zone = resolveContainZone(config, "carentan");
  const out = tick({ config: CONTAIN_CFG(), roster: [player("a", { side: "allies", pos: IN_J10 })], containZone: zone, nowMs: 1_000_000 });
  const many = roster(10, () => ({ side: "allies" as const, pos: IN_J10 }));
  const t = tick({ config, roster: many, containZone: zone, containState: out.containState, containEscalation: out.containEscalation, nowMs: 1_061_000 });
  assert.equal(t.actions.length, 0, "10 players at a cap of 10 = free play");
  assert.equal(t.containState.size, 0, "stale clocks do not survive the disarm");
});

test("containment: immunity is honored on the ladder, not on the clock", () => {
  const config = cfg({ ...CONTAIN_CFG(), immuneTags: ["staff"] });
  const zone = resolveContainZone(config, "carentan");
  const vip = () => [player("a", { side: "allies", pos: IN_J10, tags: ["staff"] })];
  const t1 = tick({ config, roster: vip(), containZone: zone, nowMs: 1_000_000 });
  const t2 = tick({ config, roster: vip(), containZone: zone, containState: t1.containState, containEscalation: t1.containEscalation, nowMs: 1_061_000 });
  assert.equal(t2.actions.length, 0, "immune players are never actioned");
});

test("resolveContainZone: nothing drawn, disabled, or an unknown map key all mean 'nothing to say'", () => {
  assert.equal(resolveContainZone(cfg({ containEnabled: false, containZones: { carentan: { allies: ["A1"], axis: [], shared: [] } } }), "carentan"), null);
  assert.equal(resolveContainZone(CONTAIN_CFG(), "foy"), null);
  assert.equal(resolveContainZone(CONTAIN_CFG(), null), null);
  assert.equal(resolveContainZone(cfg({ containEnabled: true, containZones: {} }), "carentan"), null);
});

test("rosterPosOf reads both protocol spellings and treats 0,0 as the deploy screen", () => {
  assert.deepEqual(rosterPosOf({ worldPosition: { x: 5, y: 6, z: 0 } }), { x: 5, y: 6 });
  assert.deepEqual(rosterPosOf({ world_position: { x: -7, y: 8 } }), { x: -7, y: 8 });
  assert.equal(rosterPosOf({ worldPosition: { x: 0, y: 0, z: 0 } }), null);
  assert.equal(rosterPosOf({}), null);
  assert.equal(rosterPosOf({ worldPosition: { x: "nan", y: 2 } }), null);
});

/*
 * The field report behind these: "the auto mod only punishes like one person at a time every 30
 * or so seconds" while edge-OP waves capped the last objective. Two causes, both fixed: a blinked
 * session read wiped every baseline (the detector needs two sightings per player, so each blink
 * bought the wave a free minute), and the slow tick was the floor on everything.
 */
test("cap fight: a blinked session read holds the baseline instead of wiping it", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense })];
  const t1 = tick({ config, roster: winner(100), session: WARFARE });
  assert.equal(t1.capOffense.get("w"), 100);

  // The session read fails for a tick — the runner's failed-read shape is all-null fields.
  const blink = { gameMode: null, alliedScore: null, axisScore: null };
  const t2 = tick({ config, roster: winner(110), session: blink, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.equal(t2.actions.length, 0, "no evidence, no action");
  assert.equal(t2.capOffense.get("w"), 100, "…and no forgetting");

  // Warfare answered but the scores didn't — same rule: hold, don't wipe.
  const scoreless = { gameMode: "warfare", alliedScore: null, axisScore: null };
  const t3 = tick({ config, roster: winner(115), session: scoreless, capOffense: t2.capOffense, capEscalation: t2.capEscalation });
  assert.equal(t3.actions.length, 0);
  assert.equal(t3.capOffense.get("w"), 100);

  // The next good read sees the climb since the baseline — exactly as if nothing blinked.
  const t4 = tick({ config, roster: winner(120), session: WARFARE, capOffense: t3.capOffense, capEscalation: t3.capEscalation });
  assert.deepEqual(t4.actions.map((a) => a.kind), ["warn"]);
});

test("cap fight: an unreadable offense column holds that player's baseline too", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const winner = (offense: number | null) => [player("w", { side: "allies" as const, offense })];
  const t1 = tick({ config, roster: winner(100), session: WARFARE });
  // One tick's roster carries no score for them — hold, never forget.
  const t2 = tick({ config, roster: winner(null), session: WARFARE, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.equal(t2.capOffense.get("w"), 100);
  const t3 = tick({ config, roster: winner(120), session: WARFARE, capOffense: t2.capOffense, capEscalation: t2.capEscalation });
  assert.deepEqual(t3.actions.map((a) => a.kind), ["warn"]);
});

test("the tick runs fast only while a chase rule is armed and the server is seeding", () => {
  const chase = cfg({ capFightEnabled: true });
  assert.equal(seedTickDelayMs("seeding", chase, 10_000, 30_000), 10_000);
  assert.equal(seedTickDelayMs("live", chase, 10_000, 30_000), 30_000, "nothing to chase once the server is live");
  assert.equal(seedTickDelayMs("idle", chase, 10_000, 30_000), 30_000);
  assert.equal(seedTickDelayMs("seeding", cfg({}), 10_000, 30_000), 30_000, "no chase rule, no extra load on the server");
  const zones = cfg({ containEnabled: true, containZones: { carentan: { allies: ["A1"], axis: ["J10"], shared: [] } } });
  assert.equal(seedTickDelayMs("seeding", zones, 10_000, 30_000), 10_000);
  assert.equal(seedTickDelayMs("seeding", cfg({ containEnabled: true }), 10_000, 30_000), 10_000, "zones with nothing painted still chase: the auto fence watches");
});

test("a seeder whose link we could not READ is not told they never linked one", () => {
  /*
   * The points half of a reward can miss for two reasons, and only one of them is the player's to
   * fix. Both used to arrive as the same empty answer, so a database hiccup during a reward round
   * told a seeder who linked their Discord months ago that they missed out for not linking it —
   * in game, and again in the reward row that staff read when the player asks why.
   */
  assert.equal(pointsSkipReason({ points: 500, discordId: "D1", linkReadable: true }), null, "they got their points");
  assert.equal(pointsSkipReason({ points: 0, discordId: null, linkReadable: true }), null, "no points on offer, nothing to explain");

  const genuine = pointsSkipReason({ points: 500, discordId: null, linkReadable: true });
  assert.match(genuine!, /no Discord link/, "a seeder with no link is told so — that one they can fix");

  const unknown = pointsSkipReason({ points: 500, discordId: null, linkReadable: false });
  assert.doesNotMatch(unknown!, /no Discord link/, "but a failed lookup must not be reported as a missing link");
  assert.match(unknown!, /could not read/, "it says what actually happened");

  // And the in-game note follows: the nudge to go link an account is suppressed when we do not
  // know, so the message carries the VIP half and makes no claim about their Discord.
  const quiet = composeRewardMessage({
    playerName: "Dee", hours: 24, points: 500, linked: false, credited: null, balance: null,
    currencyName: "Points", message: "Thanks {player_name} — you earned {reward}.",
    linkedNote: "You now have {balance}.", unlinkedNote: "Link your Discord to collect {reward_points} {currency}.",
  });
  assert.match(quiet, /Link your Discord/, "the nudge is there for a genuinely unlinked seeder…");
  const suppressed = composeRewardMessage({
    playerName: "Dee", hours: 24, points: 500, linked: false, credited: null, balance: null,
    currencyName: "Points", message: "Thanks {player_name} — you earned {reward}.",
    linkedNote: "You now have {balance}.", unlinkedNote: "",
  });
  assert.doesNotMatch(suppressed, /Link your Discord/, "…and gone when we cannot say");
  assert.match(suppressed, /Thanks Dee/, "while the reward they DID get is still announced");
});

test("bridge: a same-game stop pays the seeder's own id — no registration asked for", () => {
  // linkedAccounts is null (unreadable) on purpose: a same-game stop must not even look.
  const out = bridgeAccountFor({ targetGame: "hll", seededGame: "hll", seederPlatformId: "765-1", linkedAccounts: null, gameLabel: "HLL" });
  assert.deepEqual(out, { playerId: "765-1", skipped: null });
});

test("bridge: a cross-game stop pays the account registration linked for THAT game", () => {
  const out = bridgeAccountFor({
    targetGame: "hllv", seededGame: "hll", seederPlatformId: "765-1",
    linkedAccounts: [{ game: "hll", platformId: "765-1" }, { game: "hllv", platformId: "viet-9" }],
    gameLabel: "HLL: Vietnam",
  });
  assert.deepEqual(out, { playerId: "viet-9", skipped: null });
});

test("bridge: the three ways a cross-game slice misses, each with its own reason", () => {
  const base = { targetGame: "hllv", seededGame: "hll", seederPlatformId: "765-1", gameLabel: "HLL: Vietnam" };
  // Registered for the seeded game only: the slice has no account to land on there.
  const unregistered = bridgeAccountFor({ ...base, linkedAccounts: [{ game: "hll", platformId: "765-1" }] });
  assert.equal(unregistered.playerId, null);
  assert.match(String(unregistered.skipped), /not registered for HLL: Vietnam/);
  // No Discord link at all: registering is what builds the bridge, and the reason says so.
  const unlinked = bridgeAccountFor({ ...base, linkedAccounts: [] });
  assert.match(String(unlinked.skipped), /no Discord link/);
  // The links could not be READ — ours to fix, never blamed on the player as "unlinked".
  const unreadable = bridgeAccountFor({ ...base, linkedAccounts: null });
  assert.match(String(unreadable.skipped), /could not read/);
  assert.ok(!String(unreadable.skipped).includes("no Discord link"), "an outage is not an unlinked player");
});

/*
 * The bridge sentence: landings announced, misses split by whose problem they are. A miss the
 * player can fix speaks with its reason; a miss that is ours (unreadable link, dead target,
 * unresolved stop) stays out of the message — same philosophy pointsSkipReason set.
 */
test("bridgeBonusLine announces landings and player-fixable misses, and stays quiet about ours", async () => {
  const { bridgeBonusLine } = await import("../dist/seeding.js");
  assert.equal(bridgeBonusLine([]), "");
  assert.equal(
    bridgeBonusLine([{ server: "Vietnam #1", hours: 24, landed: true, tell: null }]),
    "Bridge bonus: 1d VIP on Vietnam #1.",
  );
  assert.equal(
    bridgeBonusLine([
      { server: "WW2 #2", hours: 72, landed: true, tell: null },
      { server: "Vietnam #1", hours: 24, landed: false, tell: "not registered for HLL: Vietnam — bridge VIP has no account to land on there" },
    ]),
    "Bridge bonus: 3d VIP on WW2 #2. Heads up: no bridge VIP on Vietnam #1 (not registered for HLL: Vietnam — bridge VIP has no account to land on there).",
  );
  // Ours-to-fix misses carry tell: null and produce NOTHING — not even a generic apology.
  assert.equal(
    bridgeBonusLine([{ server: "Vietnam #1", hours: 24, landed: false, tell: null }]),
    "",
  );
  // A stop whose stored server no longer resolves still reads like a sentence, not "on null".
  assert.equal(
    bridgeBonusLine([{ server: null, hours: 24, landed: false, tell: "no Discord link — registering is what bridges the games" }]),
    "Heads up: no bridge VIP on a linked server (no Discord link — registering is what bridges the games).",
  );
});

// ---- round geometry (auto position rules, nothing painted per map) ----

/** Evidence putting the allies' mean at (ax,ay) and the axis mean at (bx,by), n samples each. */
function calState(ax: number, ay: number, bx: number, by: number, n = 20): AxisCalState {
  const st = blankAxisCal("foy_warfare");
  st.allies = { x: ax * n, y: ay * n, n };
  st.axis = { x: bx * n, y: by * n, n };
  return st;
}

test("geometry: axis and ends come from the teams themselves, either way round", () => {
  const west = calibrationOf(calState(-80_000, 0, 80_000, 0))!;
  assert.deepEqual([west.axis, west.alliesDir], ["x", -1]);
  const swapped = calibrationOf(calState(80_000, 0, -80_000, 0))!;
  assert.equal(swapped.alliesDir, 1);
  const vertical = calibrationOf(calState(0, -70_000, 0, 70_000))!;
  assert.equal(vertical.axis, "y");
  assert.equal(calibrationOf(calState(-80_000, 0, 80_000, 0, 5)), null, "too few samples");
  assert.equal(calibrationOf(calState(-9_000, 0, 9_000, 0)), null, "teams too mingled");
  assert.equal(bandOf({ x: -90_000, y: 0 }, west), 0);
  assert.equal(bandOf({ x: 0, y: 0 }, west), 2);
  assert.equal(bandOf({ x: 90_000, y: 0 }, west), 4);
  assert.equal(bandOf({ x: 90_000, y: 0 }, swapped), 0);
  assert.equal(pastFrontLine("allies", 3, 3, 2), true);
  assert.equal(pastFrontLine("allies", 2, 3, 2), false);
  assert.equal(pastFrontLine("axis", 2, 3, 2), true);
  assert.equal(pastFrontLine("axis", 3, 3, 2), false);
});

test("geometry: position catches a cap push even with no offense scores", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const session = { gameMode: "EGameMode::Warfare", alliedScore: 3, axisScore: 2, mapId: "foy_warfare" };
  const axisCal = calState(-80_000, 0, 80_000, 0);
  const pusher = [player("w", { side: "allies" as const, offense: null, pos: { x: 30_000, y: 0 } })];
  // Their label must be corroborated by their own origin before position may be enforced, so
  // the round starts with them on their own ground.
  const home0 = [player("w", { side: "allies" as const, offense: null, pos: { x: -80_000, y: 0 } })];
  const o1 = tick({ config, roster: home0, session, axisCal, nowMs: 900_000 });
  const o2 = tick({ config, roster: home0, session, axisCal: o1.axisCal, nowMs: 950_000 });
  const t1 = tick({ config, roster: pusher, session, axisCal: o2.axisCal, nowMs: 1_000_000 });
  assert.equal(t1.actions.length, 0, "grace clock first");
  assert.equal(t1.capFightState, "armed");
  assert.match(t1.capFightNote!, /POSITION only/);
  const t2 = tick({ config, roster: pusher, session, axisCal: t1.axisCal, capPosState: t1.capPosState,
    capEscalation: t1.capEscalation, nowMs: 1_000_000 + (CAP_POS_GRACE_SEC + 1) * 1000 });
  assert.deepEqual(t2.actions.map((a) => a.kind), ["warn"]);
  assert.deepEqual(t2.actions[0]!.reason, { rule: "capFight", detail: "their team already held 3 caps", byPosition: true, step: { n: 1, of: 1 } });
  const home = [player("w", { side: "allies" as const, offense: null, pos: { x: -30_000, y: 0 } })];
  const t3 = tick({ config, roster: home, session, axisCal: t2.axisCal, capPosState: t2.capPosState,
    capEscalation: t2.capEscalation, nowMs: 2_000_000 });
  assert.equal(t3.actions.length, 0);
  assert.equal(t3.capPosState.size, 0, "back on own ground clears the clock");
  const cold = tick({ config, roster: pusher, session, axisCal: null, nowMs: 1_000_000 });
  assert.equal(cold.actions.length, 0, "uncalibrated stays quiet");
  // A player first sighted already past the line has NO corroborated origin — never punished on
  // position (their label could be one of the mis-colored ones).
  const stranger = [player("s", { side: "allies" as const, offense: null, pos: { x: 40_000, y: 0 } })];
  const u1 = tick({ config, roster: stranger, session, axisCal: calState(-80_000, 0, 80_000, 0), nowMs: 1_000_000 });
  const u2 = tick({ config, roster: stranger, session, axisCal: u1.axisCal, capPosState: u1.capPosState, nowMs: 1_000_000 + (CAP_POS_GRACE_SEC + 5) * 1000 });
  assert.equal(u2.actions.length, 0, "an unverified side label is skipped, not enforced");
});

test("geometry: a front line mirrored from the score stands the positional cap fight down", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const session = { gameMode: "warfare", alliedScore: 3, axisScore: 2, mapId: "foy_warfare" };
  // Combat mass sits at 0.4 from the labeled-allies end while a 3-2 score puts the line at 0.6:
  // the labels are the wrong way round, and enforcing would punish the losing team.
  const axisCal = calState(-50_000, 0, 10_000, 0);
  const home = [player("w", { side: "allies" as const, offense: null, pos: { x: -80_000, y: 0 } })];
  const o1 = tick({ config, roster: home, session, axisCal, nowMs: 900_000 });
  const pusher = [player("w", { side: "allies" as const, offense: null, pos: { x: 30_000, y: 0 } })];
  const t1 = tick({ config, roster: pusher, session, axisCal: o1.axisCal, nowMs: 1_000_000 });
  const t2 = tick({ config, roster: pusher, session, axisCal: t1.axisCal, capPosState: t1.capPosState, nowMs: 1_000_000 + (CAP_POS_GRACE_SEC + 5) * 1000 });
  assert.equal(t1.actions.length + t2.actions.length, 0);
  assert.match(t2.geometryNote!, /labels look flipped/);
});

test("geometry: auto containment fences each side to its half plus mid, painted zones win", () => {
  const config = cfg({ containEnabled: true, containAutoEnabled: true, containGraceSec: 10, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const session = { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "foy_warfare" };
  const axisCal = calState(-80_000, 0, 80_000, 0);
  const deep = [player("a", { side: "allies" as const, pos: { x: 70_000, y: 0 } })];
  const homeA = [player("a", { side: "allies" as const, pos: { x: -80_000, y: 0 } })];
  const oa = tick({ config, roster: homeA, session, axisCal, nowMs: 900_000 });
  const ob = tick({ config, roster: homeA, session, axisCal: oa.axisCal, nowMs: 950_000 });
  const t1 = tick({ config, roster: deep, session, axisCal: ob.axisCal, nowMs: 1_000_000 });
  assert.equal(t1.actions.length, 0, "grace first");
  assert.equal(t1.containState.size, 1);
  const t2 = tick({ config, roster: deep, session, axisCal: t1.axisCal, containState: t1.containState,
    containEscalation: t1.containEscalation, nowMs: 1_000_000 + 11_000 });
  assert.deepEqual(t2.actions.map((a) => a.kind), ["warn"]);
  assert.equal(t2.actions[0]!.reason.detail, "outside their team's half (auto zones)");
  const mid = [player("a", { side: "allies" as const, pos: { x: -5_000, y: 0 } })];
  assert.equal(tick({ config, roster: mid, session, axisCal: ob.axisCal, nowMs: 1_000_000 }).containState.size, 0, "mid band is shared ground");
  const homeX = [player("x", { side: "axis" as const, pos: { x: 80_000, y: 0 } })];
  const ox = tick({ config, roster: homeX, session, axisCal, nowMs: 900_000 });
  const oy = tick({ config, roster: homeX, session, axisCal: ox.axisCal, nowMs: 950_000 });
  const axisDeep = [player("x", { side: "axis" as const, pos: { x: -70_000, y: 0 } })];
  assert.equal(tick({ config, roster: axisDeep, session, axisCal: oy.axisCal, nowMs: 1_000_000 }).containState.size, 1, "symmetric for the other side");
  // First sighted already deep: no corroborated origin, so the fence leaves them alone.
  const strangerDeep = [player("q", { side: "allies" as const, pos: { x: 70_000, y: 0 } })];
  const q1 = tick({ config, roster: strangerDeep, session, axisCal, nowMs: 1_000_000 });
  assert.equal(tick({ config, roster: strangerDeep, session, axisCal: q1.axisCal, containState: q1.containState, nowMs: 1_000_000 + 60_000 }).actions.length, 0);
  // Nothing calibrated, or not warfare: the auto fence stays off.
  assert.equal(tick({ config, roster: deep, session, axisCal: null, nowMs: 1_000_000 }).containState.size, 0);
  assert.equal(tick({ config, roster: deep, session: { ...session, gameMode: "offensive" }, axisCal, nowMs: 1_000_000 }).containState.size, 0);
  // A painted zone for the map outranks the auto fence entirely.
  const painted = { allies: new Set(["I6"]), axis: null };
  const t5 = tick({ config, roster: deep, session, axisCal, containZone: painted, nowMs: 1_000_000 });
  assert.equal(t5.containState.size, 0, "x=+70k y=0 is cell I6, the Allies' own painted ground — and no Axis ground is painted");
});

test("field report: a mid-spawner whose side comes out backwards is not punished walking from mid to their own 2nd point", () => {
  // Real allies player. First sighted on a mid garrison just past the halfway line — the usual
  // seeding spawn — then, on a tick the side guess came out backwards, labeled axis while walking
  // home. The old origin check split at the halfway line and "corroborated" that wrong label.
  const session = { gameMode: "warfare", alliedScore: 3, axisScore: 3 - 1, mapId: "foy_warfare" };
  const axisCal = calState(-80_000, 0, 80_000, 0);
  const atMid = [player("m", { side: "axis" as const, offense: null, pos: { x: 5_000, y: 0 } })];
  const walkingHome = [player("m", { side: "axis" as const, offense: null, pos: { x: -50_000, y: 0 } })]; // allies' 2nd point

  const fence = cfg({ containEnabled: true, containAutoEnabled: true, containGraceSec: 10, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  // Several checks on mid first (a seed fight is mostly that) — every origin sample sits there.
  let f2 = tick({ config: fence, roster: atMid, session, axisCal, nowMs: 900_000 });
  for (let i = 1; i < 5; i++) f2 = tick({ config: fence, roster: atMid, session, axisCal: f2.axisCal, nowMs: 900_000 + i * 10_000 });
  const f3 = tick({ config: fence, roster: walkingHome, session, axisCal: f2.axisCal, nowMs: 1_000_000 });
  const f4 = tick({ config: fence, roster: walkingHome, session, axisCal: f3.axisCal, containState: f3.containState, containEscalation: f3.containEscalation, nowMs: 1_000_000 + 60_000 });
  assert.equal(f3.actions.length + f4.actions.length, 0, "the auto fence has no corroborated side for a mid-spawner");

  const capAxis = { ...session, alliedScore: 2, axisScore: 3 };
  const cap = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  let c2 = tick({ config: cap, roster: atMid, session: capAxis, axisCal, nowMs: 900_000 });
  for (let i = 1; i < 5; i++) c2 = tick({ config: cap, roster: atMid, session: capAxis, axisCal: c2.axisCal, nowMs: 900_000 + i * 10_000 });
  const c3 = tick({ config: cap, roster: walkingHome, session: capAxis, axisCal: c2.axisCal, nowMs: 1_000_000 });
  const c4 = tick({ config: cap, roster: walkingHome, session: capAxis, axisCal: c3.axisCal, capPosState: c3.capPosState, capEscalation: c3.capEscalation, nowMs: 1_000_000 + (CAP_POS_GRACE_SEC + 5) * 1000 });
  assert.equal(c3.actions.length + c4.actions.length, 0, "nor does the positional cap fight");
});

test("enforcement sides: only confident reads place a team; a guess never does", () => {
  const memory = new Map<number, string | null>();
  // Seeding with even teams: the resolver's answer is a guess — no side for anyone yet.
  const guess = enforcementSides(new Map([[1, "axis"], [2, "allies"]]), false, memory);
  assert.deepEqual([...guess.values()], [null, null]);
  // A confident read (uneven teams, headcounts matching) places them…
  const sure = enforcementSides(new Map([[1, "allies"], [2, "axis"]]), true, memory);
  assert.deepEqual([sure.get(1), sure.get(2)], ["allies", "axis"]);
  // …and a later backwards guess defers to it instead of flipping everyone.
  const later = enforcementSides(new Map([[1, "axis"], [2, "allies"]]), false, memory);
  assert.deepEqual([later.get(1), later.get(2)], ["allies", "axis"]);
});

test("geometry: a new map or a fresh 2-2 on the same map resets the ends", () => {
  const config = cfg({ capFightEnabled: true, minPlayers: 1 });
  const axisCal = calState(-80_000, 0, 80_000, 0);
  axisCal.lastScores = { allied: 3, axis: 2 };
  const other = tick({ config, roster: [player("z")], session: { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "carentan_warfare" }, axisCal, nowMs: 1 });
  assert.equal(other.axisCal!.roundKey, "carentan_warfare");
  assert.equal(other.axisCal!.allies.n, 0, "a different map starts from nothing (no positions on this roster)");
  const rematch = tick({ config, roster: [player("z")], session: { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "foy_warfare" }, axisCal, nowMs: 1 });
  assert.equal(rematch.axisCal!.allies.n, 0, "same map again after a decided score: the sides may have swapped");
});

// ---- offensive pace (steamroll protection) ----

/** Same evidence as calState, but for a named round key (the fold resets on a key mismatch). */
function calStateFor(key: string, ax: number, bx: number, n = 20): AxisCalState {
  const st = blankAxisCal(key);
  st.allies = { x: ax * n, y: 0, n };
  st.axis = { x: bx * n, y: 0, n };
  return st;
}

test("pace: the map id names the attacker in both games", () => {
  assert.equal(attackerSideOf("carentan_offensive_ger"), "axis");
  assert.equal(attackerSideOf("stmariedumont_off_us"), "allies");
  assert.equal(attackerSideOf("wdevb_offensivenva_day"), "axis");
  assert.equal(attackerSideOf("elalamein_offensive_CW"), "allies");
  assert.equal(attackerSideOf("foy_warfare"), null, "not offensive");
  assert.equal(attackerSideOf("wdeve_conquest_day"), null);
});

const PACE_MAP = "carentan_offensive_ger"; // axis attacks; allies calibrate at the low-x end
const paceSession = { gameMode: "EGameMode::Offensive", alliedScore: null, axisScore: null, mapId: PACE_MAP };
const paceCfg = (over: Partial<SeedingConfigRow> = {}) =>
  cfg({ paceEnabled: true, minPlayers: 1, maxWarnings: 2, warnIntervalSec: 0, warnMessage: "{violation}", ...over });
const atHome = [player("a", { side: "axis" as const, pos: { x: 80_000, y: 0 } })];
// x = -30k is band 1 from the allies end = the attackers' 4th point, which unlocks at minute 40.
const pushing = [player("a", { side: "axis" as const, pos: { x: -30_000, y: 0 } })];
const START = 400_000; // minute 10 of the round when nowMs is 1_000_000

test("pace: an attacker ahead of the unlock clock is graced, then warned; open bands and defenders are free", () => {
  const config = paceCfg();
  const cal0 = calStateFor(PACE_MAP, -80_000, 80_000);
  const o1 = tick({ config, session: paceSession, roundStartMs: START, roster: atHome, axisCal: cal0, nowMs: 900_000 });
  const o2 = tick({ config, session: paceSession, roundStartMs: START, roster: atHome, axisCal: o1.axisCal, nowMs: 950_000 });
  assert.match(o2.paceNote!, /^armed: axis attacking/);
  assert.equal(o2.paceArmed, true, "armed: the runner checks at the fast speed");
  const noClock = tick({ config, session: paceSession, roster: atHome, axisCal: o1.axisCal, nowMs: 950_000 });
  assert.match(noClock.paceNote!, /^holding/);
  assert.notEqual(noClock.paceArmed, true, "holding (no round clock): not armed, no fast check");
  assert.equal(o2.actions.length, 0, "home ground at minute 10 is fine");
  const t1 = tick({ config, session: paceSession, roundStartMs: START, roster: pushing, axisCal: o2.axisCal, nowMs: 1_000_000 });
  assert.equal(t1.actions.length, 0, "grace clock first");
  assert.equal(t1.paceState.size, 1);
  const t2 = tick({ config, session: paceSession, roundStartMs: START, roster: pushing, axisCal: t1.axisCal,
    paceState: t1.paceState, paceEscalation: t1.paceEscalation, nowMs: 1_000_000 + (PACE_GRACE_SEC + 1) * 1000 });
  assert.deepEqual(t2.actions.map((a) => a.kind), ["warn"]);
  assert.match(t2.actions[0]!.message, /point 4 .* minute 40/);
  assert.equal(t2.actions[0]!.reason.rule, "pace");
  assert.equal(t2.actions[0]!.reason.detail, "reached point 4 before it opens at minute 40");
  const late = tick({ config, session: paceSession, roundStartMs: 1_000_000 - 45 * 60_000, roster: pushing, axisCal: o2.axisCal, nowMs: 1_000_000 });
  assert.equal(late.paceState.size, 0, "minute 45: the 4th point is open");
  // A DEFENDER standing in the same spot is never the pace rule's business.
  const defHome = [player("d", { side: "allies" as const, pos: { x: -80_000, y: 0 } })];
  const d1 = tick({ config, session: paceSession, roundStartMs: START, roster: defHome, axisCal: cal0, nowMs: 900_000 });
  const d2 = tick({ config, session: paceSession, roundStartMs: START, roster: defHome, axisCal: d1.axisCal, nowMs: 950_000 });
  const defDeep = [player("d", { side: "allies" as const, pos: { x: -30_000, y: 0 } })];
  const d3 = tick({ config, session: paceSession, roundStartMs: START, roster: defDeep, axisCal: d2.axisCal, nowMs: 1_000_000 });
  assert.equal(d3.paceState.size, 0);
});

test("pace: holds without a clock or calibration, stands down off-mode, skips unverified labels", () => {
  const config = paceCfg();
  const cal0 = calStateFor(PACE_MAP, -80_000, 80_000);
  const noClock = tick({ config, session: paceSession, roster: pushing, axisCal: cal0, roundStartMs: null, nowMs: 1_000_000 });
  assert.match(noClock.paceNote!, /^holding.*start time/);
  assert.equal(noClock.paceState.size, 0);
  const noCal = tick({ config, session: paceSession, roster: pushing, roundStartMs: START, nowMs: 1_000_000 });
  assert.match(noCal.paceNote!, /^holding.*not calibrated/);
  const warfare = tick({ config, session: { ...paceSession, mapId: "foy_warfare" }, roster: pushing, roundStartMs: START, nowMs: 1_000_000 });
  assert.match(warfare.paceNote!, /^standing down/);
  // First sighted already deep: no corroborated origin, so never punished on position.
  const s1 = tick({ config, session: paceSession, roster: pushing, axisCal: cal0, roundStartMs: START, nowMs: 1_000_000 });
  const s2 = tick({ config, session: paceSession, roster: pushing, axisCal: s1.axisCal, paceState: s1.paceState,
    paceEscalation: s1.paceEscalation, roundStartMs: START, nowMs: 1_000_000 + (PACE_GRACE_SEC + 5) * 1000 });
  assert.equal(s2.actions.length, 0);
  assert.equal(s2.paceState.size, 0);
});

test("pace: keeps enforcing after the server goes live, and a new round wipes its ladder", () => {
  const config = paceCfg({ seedTarget: 1 });
  const cal0 = calStateFor(PACE_MAP, -80_000, 80_000);
  const live = { config, session: paceSession, roundStartMs: START, prevPhase: "live" as Phase };
  const o1 = tick({ ...live, roster: atHome, axisCal: cal0, nowMs: 900_000 });
  assert.equal(o1.phase, "live");
  const o2 = tick({ ...live, roster: atHome, axisCal: o1.axisCal, nowMs: 950_000 });
  const t1 = tick({ ...live, roster: pushing, axisCal: o2.axisCal, nowMs: 1_000_000 });
  const t2 = tick({ ...live, roster: pushing, axisCal: t1.axisCal, paceState: t1.paceState,
    paceEscalation: t1.paceEscalation, nowMs: 1_000_000 + (PACE_GRACE_SEC + 1) * 1000 });
  assert.deepEqual(t2.actions.map((a) => a.kind), ["warn"], "live phase still enforces the pace");
  const sw = tick({ ...live, session: { ...paceSession, mapId: "utahbeach_offensive_us" }, roster: atHome,
    axisCal: t2.axisCal, paceState: t2.paceState, paceEscalation: t2.paceEscalation, nowMs: 2_000_000 });
  assert.equal(sw.paceEscalation.size, 0, "the map changed: last round's ladder is gone");
});


// ---- per-layer learned layouts ----

test("mergeGeometry: live wins, learned covers the warm-up, a disagreement uses neither", () => {
  const live = { axis: "x" as const, alliesDir: -1 as const, separation: 90_000 };
  assert.equal(mergeGeometry(live, null).source, "live");
  assert.equal(mergeGeometry(null, { axis: "y", alliesDir: 1 }).source, "learned");
  assert.equal(mergeGeometry(null, { axis: "y", alliesDir: 1 }).cal!.axis, "y");
  assert.equal(mergeGeometry(live, { axis: "x", alliesDir: -1 }).source, "live", "agreement: the live reading");
  assert.deepEqual(mergeGeometry(live, { axis: "x", alliesDir: 1 }), { cal: null, source: "conflict" }, "flipped end");
  assert.deepEqual(mergeGeometry(live, { axis: "y", alliesDir: -1 }), { cal: null, source: "conflict" }, "other axis");
  assert.deepEqual(mergeGeometry(null, null), { cal: null, source: "none" });
});

test("a learned layout lets auto zones act before the round has calibrated live", () => {
  const config = cfg({ containEnabled: true, containAutoEnabled: true, containGraceSec: 10, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const session = { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "foy_warfare" };
  const learnedLayout = { axis: "x" as const, alliesDir: -1 as const, rounds: 4 };
  const homeA = [player("a", { side: "allies" as const, pos: { x: -80_000, y: 0 } })];
  const deep = [player("a", { side: "allies" as const, pos: { x: 70_000, y: 0 } })];
  // One player on the ground is nowhere near a live calibration (12 samples a team).
  const o1 = tick({ config, roster: homeA, session, learnedLayout, nowMs: 900_000 });
  assert.match(o1.geometryNote!, /using the learned layout/);
  const o2 = tick({ config, roster: homeA, session, learnedLayout, axisCal: o1.axisCal, nowMs: 950_000 });
  const t1 = tick({ config, roster: deep, session, learnedLayout, axisCal: o2.axisCal, nowMs: 1_000_000 });
  assert.equal(t1.containState.size, 1, "the fence is up from the round's first minutes");
  // Without the learned layout the same round is still calibrating, and nothing is judged.
  const n1 = tick({ config, roster: homeA, session, nowMs: 900_000 });
  const n2 = tick({ config, roster: homeA, session, axisCal: n1.axisCal, nowMs: 950_000 });
  const n3 = tick({ config, roster: deep, session, axisCal: n2.axisCal, nowMs: 1_000_000 });
  assert.equal(n3.containState.size, 0);
  assert.match(n3.geometryNote!, /calibrating/);
});

test("live spawns that contradict the learned layout stand the positional rules down", () => {
  const config = cfg({ containEnabled: true, containAutoEnabled: true, containGraceSec: 10, minPlayers: 1 });
  const session = { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "foy_warfare" };
  // Live evidence: allies at the HIGH x end; learned says the low end.
  const axisCal = calState(80_000, 0, -80_000, 0);
  const r = tick({ config, roster: [player("z", { side: "allies" as const, pos: { x: 80_000, y: 0 } })], session, axisCal,
    learnedLayout: { axis: "x", alliesDir: -1, rounds: 5 }, nowMs: 1_000_000 });
  assert.match(r.geometryNote!, /disagree with the learned layout/);
  assert.equal(r.containState.size, 0);
});

// ---- layout learning by direction of travel ----
//
// The owner's rule: the first grid line is ruled out (both teams show there at a round's start —
// swapping sides, or still unassigned from the last match), and a layer is learned when 5 players
// walk out of their end, grid 1 → 2 → 3, inside a round's first 10 minutes.

/** The centre of grid line n (1–10) along either axis, in world units. */
const lineAt = (n: number) => -100_000 + (n - 0.5) * 20_000;
const LEARN = { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "foy_warfare" };
const OPENED = 1_000_000; // the round's start, as the match tracker has it
/** One check per step: `steps` are [column, row] grid lines (1–10), the same for every player. */
function walk(ids: string[], side: "allies" | "axis" | null, steps: [number, number][], opts: { axisCal?: AxisCalState | null; from?: number; roundStartMs?: number | null } = {}): ReturnType<typeof tick> {
  let axisCal = opts.axisCal ?? null;
  let r: ReturnType<typeof tick> | null = null;
  for (const [i, [col, row]] of steps.entries()) {
    r = tick({ config: cfg({ minPlayers: 1 }), session: LEARN, axisCal, roundStartMs: opts.roundStartMs === undefined ? OPENED : opts.roundStartMs,
      roster: ids.map((id) => player(id, { side, pos: { x: lineAt(col), y: lineAt(row) } })), nowMs: (opts.from ?? OPENED + 60_000) + i * 20_000 });
    axisCal = r.axisCal;
  }
  return r!;
}
const OUT_OF_NORTH: [number, number][] = [[5, 1], [5, 2], [5, 3]];
const OUT_OF_SOUTH: [number, number][] = [[5, 10], [5, 9], [5, 8]];
const five = ["a1", "a2", "a3", "a4", "a5"];

test("layout learning: five players walking out of their end in the first ten minutes vote for the layer", () => {
  const r = walk(five, "allies", OUT_OF_NORTH);
  assert.deepEqual(r.layoutSample, { mapId: "foy_warfare", axis: "y", alliesDir: -1, travelers: 5 }, "north–south, Allies at the top");
  assert.equal(walk(five.slice(0, 4), "allies", OUT_OF_NORTH).layoutSample ?? null, null, "four is not five");
  // The Axis walking out of the bottom says the same thing about the same map.
  assert.deepEqual(walk(["x1", "x2", "x3", "x4", "x5"], "axis", OUT_OF_SOUTH).layoutSample, { mapId: "foy_warfare", axis: "y", alliesDir: -1, travelers: 5 });
  // Two separate walks into one tally: 3 Allies out of the top, then 2 Axis out of the bottom.
  const a = walk(["a1", "a2", "a3"], "allies", OUT_OF_NORTH);
  assert.equal(a.layoutSample ?? null, null);
  const b = walk(["x1", "x2"], "axis", OUT_OF_SOUTH, { axisCal: a.axisCal, from: OPENED + 3 * 60_000 });
  assert.deepEqual(b.layoutSample, { mapId: "foy_warfare", axis: "y", alliesDir: -1, travelers: 5 });
  // Sideways maps read sideways: out of the west edge, column A → B → C.
  assert.deepEqual(walk(five, "axis", [[1, 5], [2, 5], [3, 5]]).layoutSample, { mapId: "foy_warfare", axis: "x", alliesDir: 1, travelers: 5 }, "Axis west, so Allies east");
});

test("layout learning: standing on the HQ line never votes and is no calibration evidence", () => {
  // Twenty players, both labels, all on the top HQ line for minutes — the start of a round.
  const crowd = [...Array.from({ length: 10 }, (_, i) => player(`a${i}`, { side: "allies" as const, pos: { x: lineAt(4 + (i % 3)), y: lineAt(1) } })),
    ...Array.from({ length: 10 }, (_, i) => player(`x${i}`, { side: "axis" as const, pos: { x: lineAt(4 + (i % 3)), y: lineAt(1) } }))];
  let axisCal: AxisCalState | null = null;
  let r: ReturnType<typeof tick> | null = null;
  for (let i = 0; i < 10; i++) {
    r = tick({ config: cfg({ minPlayers: 1 }), session: LEARN, axisCal, roundStartMs: OPENED, roster: crowd, nowMs: OPENED + i * 20_000 });
    axisCal = r.axisCal;
  }
  assert.equal(r!.layoutSample ?? null, null, "no trip, no vote");
  assert.deepEqual([r!.axisCal!.allies.n, r!.axisCal!.axis.n], [0, 0], "the HQ lines are set aside from the live calibration too");
  // One line in, they count.
  const out = tick({ config: cfg({ minPlayers: 1 }), session: LEARN, axisCal, roundStartMs: OPENED,
    roster: [player("a0", { side: "allies", pos: { x: lineAt(5), y: lineAt(2) } })], nowMs: OPENED + 300_000 });
  assert.equal(out.axisCal!.allies.n, 1);
});

test("layout learning: grid line by grid line, inside the first ten minutes, on a known round clock", () => {
  assert.equal(walk(five, "allies", [[5, 1], [5, 3]]).layoutSample ?? null, null, "line 1 straight to line 3 is a jump, not a walk");
  assert.equal(walk(five, "allies", [[5, 2], [5, 3], [5, 4]]).layoutSample ?? null, null, "a walk must start on the HQ line");
  assert.equal(walk(five, "allies", [[5, 1], [5, 6], [5, 2], [5, 3]]).layoutSample ?? null, null, "a jump away starts the count again");
  assert.deepEqual(walk(five, "allies", [[5, 1], [5, 2], [5, 2], [5, 1], [5, 2], [5, 3]]).layoutSample?.travelers, 5, "lingering and stepping back are still a walk");
  assert.equal(walk(five, "allies", OUT_OF_NORTH, { from: OPENED + 10 * 60_000 }).layoutSample ?? null, null, "minute 10 on: nothing counts");
  assert.equal(walk(five, "allies", OUT_OF_NORTH, { roundStartMs: null }).layoutSample ?? null, null, "no round clock, no learning");
  assert.equal(walk(five, null, OUT_OF_NORTH).layoutSample ?? null, null, "a player with no side read counts for nobody");
  // A new match is a new tally, even on the same map with nothing else to tell the rounds apart.
  const first = walk(five.slice(0, 3), "allies", OUT_OF_NORTH);
  const second = walk(five.slice(3), "allies", OUT_OF_NORTH, { axisCal: first.axisCal, roundStartMs: OPENED + 3_600_000, from: OPENED + 3_660_000 });
  assert.equal(second.layoutSample ?? null, null, "3 last round + 2 this round is not 5 this round");
});

test("layout learning: a few labels that disagree are outvoted, not followed", () => {
  // Five Allies walk out of the top; one player still wearing an Axis label walks with them.
  const r = walk([...five, "late"], "allies", OUT_OF_NORTH);
  assert.equal(r.layoutSample?.travelers, 6);
  const mixed = walk(["late"], "axis", OUT_OF_NORTH, { axisCal: walk(five, "allies", OUT_OF_NORTH).axisCal, from: OPENED + 3 * 60_000 });
  assert.deepEqual(mixed.layoutSample, { mapId: "foy_warfare", axis: "y", alliesDir: -1, travelers: 5 }, "5 of 6 agree");
  const two = walk(["late1", "late2"], "axis", OUT_OF_NORTH, { axisCal: walk(five, "allies", OUT_OF_NORTH).axisCal, from: OPENED + 3 * 60_000 });
  assert.equal(two.layoutSample ?? null, null, "5 of 7 is under three in four — wait for more");
});

test("seeding areas: nobody standing on an HQ line is judged, even where it is painted", () => {
  // An older paint that DOES cover the HQ rows: Allies rows 1–4 and Axis rows 7–10 across C–H.
  const cols = "CDEFGH".split("");
  const rows = (rs: number[]) => rs.flatMap((r) => cols.map((c) => `${c}${r}`));
  const config = cfg({ minPlayers: 1, seedTarget: 50, containEnabled: true, containGraceSec: 0, containMaxPlayers: 0, maxWarnings: 2, warnIntervalSec: 0,
    containZones: { "@foy_warfare": { allies: rows([1, 2, 3, 4]), axis: rows([7, 8, 9, 10]), shared: [] } } });
  const zone = resolveContainZone(config, "@foy_warfare");
  assert.equal(zone!.ends, "y", "the paint runs north–south");
  const at = (id: string, side: "allies" | "axis", row: number) => player(id, { side, pos: { x: lineAt(5), y: lineAt(row) } });
  // "stale" wears an Axis label on the Allies' HQ row — the start-of-round read the owner reported.
  const t = tick({ config, containZone: zone, nowMs: 1_000_000,
    roster: [at("home", "allies", 1), at("stale", "axis", 1), at("far", "allies", 10), at("ok", "allies", 3), at("deep", "allies", 8)] });
  assert.deepEqual([...t.containState.keys()], ["deep"], "only the Ally standing on Axis ground is outside — the HQ rows judge nobody");
});

test("auto zones: nobody standing on an HQ line is judged either", () => {
  const config = cfg({ containEnabled: true, containAutoEnabled: true, containGraceSec: 10, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const axisCal = calState(0, -70_000, 0, 70_000); // north–south, Allies at the top
  const at = (row: number) => [player("a", { side: "allies" as const, pos: { x: lineAt(5), y: lineAt(row) } })];
  const o1 = tick({ config, roster: at(2), session: LEARN, axisCal, nowMs: 900_000 });
  const o2 = tick({ config, roster: at(2), session: LEARN, axisCal: o1.axisCal, nowMs: 950_000 });
  assert.equal(tick({ config, roster: at(10), session: LEARN, axisCal: o2.axisCal, nowMs: 1_000_000 }).containState.size, 0, "the Axis HQ line");
  assert.equal(tick({ config, roster: at(9), session: LEARN, axisCal: o2.axisCal, nowMs: 1_000_000 }).containState.size, 1, "one line in is Axis ground");
});

test("layout votes go under the REAL layer id, once per match", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  const at = src.indexOf("One vote per round for this layer's layout");
  assert.ok(at > 0);
  const block = src.slice(at, at + 1400);
  assert.ok(block.includes("const voteLayer = sessionLayerId;"), "the session's layer id, never its display name");
  assert.ok(block.includes("wantLearn && voteLayer &&"), "no layer id, no vote");
  assert.ok(block.includes("round: roundId"), "the match is the round's identity");
  assert.ok(block.includes("layoutVotedFor !== voteKey"), "one vote per layer and match, however many ticks agree");
});

test("the runner reads the round for the zones when they are On, and learns on Learn only, On, or with steamroll protection", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  assert.ok(src.includes('const wantContain = config.containEnabled && prevPhase === "seeding";'), "painted or not, the zones' switch alone");
  assert.ok(src.includes('const wantLearn = (config.containEnabled || config.layoutLearnEnabled || config.paceEnabled) && (prevPhase === "seeding" || prevPhase === "live");'),
    "Learn only learns without enforcing; On and steamroll protection learn too");
  assert.ok(!/containAutoEnabled/.test(src), "the retired auto-zones switch is read nowhere in the runner");
});

test("applyVars leaves {constructor}/{__proto__} as typed instead of printing JavaScript internals", () => {
  assert.equal(applyVars("{constructor} {__proto__} {player_name}", { player_name: "Bob" }), "{constructor} {__proto__} Bob");
});

test("each server's own check speed (set in the app) replaces the install default; blank keeps it", () => {
  const defaults = { fastMs: 10_000, slowMs: 30_000 };
  assert.equal(seedCheckDelayMs("seeding", cfg({ checkSec: 60 }), defaults), 60_000, "no chase rule: the server's own check");
  assert.equal(seedCheckDelayMs("live", cfg({ checkSec: 60, capFightEnabled: true }), defaults), 60_000);
  assert.equal(seedCheckDelayMs("seeding", cfg({ checkSec: 60, capFightEnabled: true }), defaults), 10_000, "chasing: the default fast check");
  assert.equal(seedCheckDelayMs("seeding", cfg({ checkSec: 60, chaseCheckSec: 20, capFightEnabled: true }), defaults), 20_000);
  assert.equal(seedCheckDelayMs("seeding", cfg({ checkSec: 15, chaseCheckSec: 20, capFightEnabled: true }), defaults), 15_000, "the fast check is never slower than the normal one");
  assert.equal(seedCheckDelayMs("seeding", cfg({ checkSec: null, chaseCheckSec: null }), defaults), 30_000, "blank = the default");
  // The pace rule follows positions in LIVE offensive rounds too: while it is armed, the fast check.
  assert.equal(seedCheckDelayMs("live", cfg({ checkSec: 60, chaseCheckSec: 20 }), defaults, true), 20_000);
  assert.equal(seedCheckDelayMs("live", cfg({ checkSec: 15, chaseCheckSec: 20 }), defaults, true), 15_000, "still never slower than the normal one");
  assert.equal(seedCheckDelayMs("live", cfg({ checkSec: 60 }), defaults, false), 60_000, "standing down or holding: the normal check");
});
