/**
 * Who held VIP when, rebuilt from the VIP history (vip-history.ts) — the count behind VIPs per day.
 * Each test replays a short story through the replay and reads back the runs, in hours from T0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vipHistoryReplay, type VipListedRow } from "../src/vip-history.ts";
import type { VipAuditEvent } from "../src/vip-integrity.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const at = (h: number) => new Date(T0 + h * H).toISOString();
const NOW = 720; // thirty days in
const ev = (h: number, action: string, playerId: string, data: Record<string, unknown> = {}, serverId: string | null = "s1"): VipAuditEvent =>
  ({ ts: at(h), action, automated: false, actorName: "staff", serverId, targetId: playerId, data });
const replay = (events: VipAuditEvent[], listed: VipListedRow[] = [], nowH = NOW) => {
  const r = vipHistoryReplay({ serverId: "s1", now: T0 + nowH * H });
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) r.feed(e);
  return r.finish(listed).map((s) => [s.playerId, (s.from - T0) / H, (s.to - T0) / H] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
};

test("a dated grant runs to its date, a permanent one to now; a revoke ends one, the sync clearing a game entry does not", () => {
  assert.deepEqual(replay([
    ev(0, "vip.grant", "A", { expiration: at(48) }),
    ev(10, "vip.grant", "B", { expiration: null }),
    ev(0, "vip.grant", "C", { expiration: at(500) }),
    ev(100, "vip.revoke", "C"),
    ev(0, "vip.grant", "D", { expiration: at(500) }),
    ev(100, "vip.revoke", "D", { reconcile: true, why: "paused" }),
    ev(0, "vip.grant", "E", { expiration: "3000-01-01T00:00:00.000Z" }), // CRCON's "never expires"
  ]), [["A", 0, 48], ["B", 10, NOW], ["C", 0, 100], ["D", 0, 500], ["E", 0, NOW]]);
});

test("rewards move the date; one after the date starts a new run; a dry run, or a date beside a permanent, changes nothing", () => {
  assert.deepEqual(replay([
    ev(0, "vip.grant", "E", { expiration: at(24) }),
    ev(12, "seed.reward", "E", { expiration: at(48) }), // before the date: the run carries on
    ev(60, "seed.reward", "E", { expiration: at(80) }), // after it: a fresh run
    ev(0, "vip.grant", "F", { expiration: null }),
    ev(5, "game.reward", "F", { expiration: at(10) }),
    ev(0, "vip.grant", "G", { expiration: at(24) }),
    ev(12, "seed.reward", "G", { expiration: at(100), dryRun: true }),
    ev(30, "seed.reward", "G", { points: 50 }), // points only: no VIP moved
  ]), [["E", 0, 48], ["E", 60, 80], ["F", 0, NOW], ["G", 0, 24]]);
});

test("grants under an hour are left out, however many in a row; a month's grant made minutes ago counts; runs that meet merge", () => {
  // A rule's VIP files its row under the PROFILE id; the game id rides in its data.
  const crash = (h: number, playerId: string, untilH: number): VipAuditEvent =>
    ({ ...ev(h, "enforcer.vip", `profile-${playerId}`, { playerId, expiration: at(untilH) }), automated: true, actorName: "enforcer" });
  assert.deepEqual(replay([
    crash(100, "crash", 100.5),
    crash(200, "crashThenSeed", 200.5),
    ev(200.25, "seed.reward", "crashThenSeed", { expiration: at(230) }),
    ev(NOW - 10 / 60, "vip.grant", "fresh", { expiration: at(NOW + 30 * 24) }),
    crash(NOW - 10 / 60, "freshCrash", NOW + 20 / 60), // a crash VIP still running: half an hour all told
    ev(0, "vip.grant", "oops", { expiration: at(24) }),
    ev(0.5, "vip.revoke", "oops"),
    // Crashing again and again: each crash VIP renews the last, the run lasts nearly two hours,
    // and every grant in it was half an hour.
    crash(300, "crashy", 300.5), crash(300.4, "crashy", 300.9), crash(300.8, "crashy", 301.3), crash(301.2, "crashy", 301.7),
    // The same, still running: the rule's row in today's list has stood since the first crash.
    crash(NOW - 1.2, "crashyNow", NOW - 0.7), crash(NOW - 0.8, "crashyNow", NOW - 0.3), crash(NOW - 0.4, "crashyNow", NOW + 0.1),
  ], [
    { serverId: "s1", playerId: "crashyNow", expiration: at(NOW + 0.1), createdAt: at(NOW - 1.2), createdByName: "enforcer" },
  ]), [["crashThenSeed", 200, 230], ["fresh", NOW - 10 / 60, NOW]]);
});

test("reductions, the expiry sweep, group perks and a banked pause ending all move the run", () => {
  assert.deepEqual(replay([
    ev(0, "vip.grant", "K", { expiration: at(100) }),
    ev(10, "vip.reduce", "K", { after: at(50) }),
    ev(0, "vip.grant", "L", { expiration: at(100) }),
    ev(10, "vip.reduce", "L", { after: null, removed: true }),
    ev(0, "vip.group_hold", "M"),
    ev(5, "vip.grant", "M", { expiration: at(10), groupHeld: true }), // banked under the hold
    ev(100, "vip.group_release", "M", { expiration: at(150) }),
    ev(0, "vip.group_hold", "N"),
    ev(50, "vip.group_release", "N", {}),
    ev(0, "vip.grant", "O", { expiration: at(100) }),
    ev(50, "player.vipresume", "O", { playerId: "O", banked: [{ serverId: "s1", expiration: at(130) }, { serverId: "s2", expiration: at(999) }] }, null),
    ev(0, "vip.grant", "P", { expiration: null }),
    ev(300, "vip.expire", "P"),
    // A grant older than the history, reduced: what was left of it is what the history knows.
    ev(10, "vip.reduce", "W", { before: at(500), after: at(200) }),
  ]), [["K", 0, 50], ["L", 0, 10], ["M", 0, 150], ["N", 0, 50], ["O", 0, 130], ["P", 0, 300], ["W", 10, 200]]);
});

test("taking the VIP of their own from beneath a group perk's hold ends nothing — the group's permanent stands", () => {
  assert.deepEqual(replay([
    ev(0, "vip.group_hold", "Q"),
    ev(10, "vip.reduce", "Q", { groupHeld: true, removedMs: 24 * H, bankedMs: 48 * H }),
    ev(20, "vip.revoke", "Q", { groupHeld: true, removedMs: 48 * H, bankedMs: 0 }),
  ]), [["Q", 0, NOW]]);
});

test("a pause ending: banked time moves the date, or puts the VIP back once the old date has passed; a pause that let the time run moves nothing", () => {
  // The lapse sweep's rows: one server each, carrying the date only when time came back.
  assert.deepEqual(replay([
    ev(0, "vip.grant", "T", { expiration: at(100) }),
    ev(80, "player.vipresume", "T", { playerId: "T", mode: "banked", bankedMs: 40 * H, expiration: at(140) }),
    ev(0, "vip.grant", "U", { expiration: at(50) }),
    ev(90, "player.vipresume", "U", { playerId: "U", mode: "banked", bankedMs: 80 * H, expiration: at(130) }),
    ev(0, "vip.grant", "V", { expiration: at(60) }),
    ev(30, "player.vipresume", "V", { playerId: "V", mode: "running", bankedMs: 0 }), // no date: not permanent
  ]), [["T", 0, 140], ["U", 0, 50], ["U", 90, 130], ["V", 0, 60]]);
});

test("today's list fills in where the history runs out; other servers' rows are not this server's", () => {
  const row = (playerId: string, createdH: number, expiration: string | null, serverId = "s1"): VipListedRow =>
    ({ serverId, playerId, expiration, createdAt: at(createdH), createdByName: "CRCON import" });
  assert.deepEqual(replay([
    ev(0, "vip.grant", "R", { expiration: null }, "s2"),
    ev(0, "vip.grant", "S", { expiration: at(48) }),
  ], [
    row("Q", 100, null), // imported: no grant row of its own
    row("R", 0, null, "s2"),
    row("S", 0, at(300)), // moved later by a write that left no row
  ]), [["Q", 100, NOW], ["S", 0, 300]]);
});
