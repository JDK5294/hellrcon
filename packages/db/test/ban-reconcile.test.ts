// The reconciler's brain. The runner is plumbing; every decision that could ban or unban a real
// player is made here, so this is where the edges live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gameBanRanOut, planBanReconcile, reconcileSignature, type GameBanLite, type PlayerBanRow } from "../dist/index.js";

const NOW = "2026-08-11T12:00:00.000Z";
let n = 0;
function decision(over: Partial<PlayerBanRow>): PlayerBanRow {
  return {
    id: `d${++n}`, game: "hll", playerId: "p1", playerName: null, kind: "perma", reason: "r",
    category: null, scope: { mode: "all" }, expiresAt: null, createdByUserId: null,
    createdByName: "mod", createdAt: "2026-08-01T00:00:00.000Z", liftedAt: null, liftedByName: null,
    ...over,
  };
}
const ban = (playerId: string, type: "temp" | "perma" = "perma"): GameBanLite => ({ playerId, type });

test("a server missing a standing ban gets it — including a server the rule has never seen", () => {
  const plan = planBanReconcile("new-server", "hll", [decision({ scope: { mode: "all" } })], [], NOW);
  assert.deepEqual(plan.apply.map((d) => d.playerId), ["p1"]);
  assert.deepEqual(plan.lift, []);
  assert.deepEqual(plan.foreign, []);
});

test("an excluded server is not covered, and a snapshot list stays a snapshot", () => {
  const except = decision({ scope: { mode: "except", serverIds: ["s2"] } });
  const literal = decision({ playerId: "p2", scope: { mode: "servers", serverIds: ["s1"] } });
  assert.equal(planBanReconcile("s2", "hll", [except, literal], [], NOW).apply.length, 0);
  assert.deepEqual(planBanReconcile("s1", "hll", [except, literal], [], NOW).apply.map((d) => d.playerId), ["p1", "p2"]);
  assert.deepEqual(planBanReconcile("s3", "hll", [except, literal], [], NOW).apply.map((d) => d.playerId), ["p1"]);
});

test("a rule never crosses games, even saying all", () => {
  const plan = planBanReconcile("viet", "hllv", [decision({ scope: { mode: "all" } })], [ban("p1")], NOW);
  assert.equal(plan.apply.length, 0);
  // …and the hll decision does not adopt the hllv game ban either: it is foreign THERE.
  assert.deepEqual(plan.foreign.map((f) => f.playerId), ["p1"]);
});

test("a lifted or expired decision lifts the game ban; a re-ban after a lift protects it", () => {
  const lifted = decision({ liftedAt: NOW, liftedByName: "boss" });
  assert.deepEqual(planBanReconcile("s1", "hll", [lifted], [ban("p1")], NOW).lift, [{ playerId: "p1", kind: "perma" }]);

  const expired = decision({ kind: "temp", expiresAt: "2026-08-10T00:00:00.000Z" });
  assert.deepEqual(planBanReconcile("s1", "hll", [expired], [ban("p1", "temp")], NOW).lift, [{ playerId: "p1", kind: "temp" }]);

  // Banned, lifted, banned again: the active row wins and the game ban stays.
  const again = decision({});
  const plan = planBanReconcile("s1", "hll", [lifted, again], [ban("p1")], NOW);
  assert.deepEqual(plan.lift, []);
  assert.deepEqual(plan.apply, []);
});

/*
 * HLL goes on listing a temp ban after its time runs out, and refuses to remove it
 * ("Request was invalid"): a live WW2 server listed 21 finished 24-hour team-kill bans among its
 * 37, and a sync failed on every one. Judged by the game's OWN record of each ban — placed when,
 * for how long — so a ban the game still enforces is lifted exactly as before.
 */
test("a temp ban the game still lists after its own time ran out is left alone — reported, never sent, never foreign", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString();
  const finished: GameBanLite = { playerId: "tk1", type: "temp", ts: at(30), durationHours: 24 };
  const running: GameBanLite = { playerId: "tk2", type: "temp", ts: at(6), durationHours: 24 };
  const expired = decision({ playerId: "tk1", kind: "temp", expiresAt: at(6) });
  const lifted = decision({ playerId: "tk2", kind: "temp", expiresAt: at(-18), liftedAt: at(1), liftedByName: "mod" });
  const plan = planBanReconcile("s1", "hll", [expired, lifted], [finished, running], NOW);
  assert.deepEqual(plan.ranOut, [{ playerId: "tk1", kind: "temp" }], "the finished one is reported");
  assert.deepEqual(plan.lift, [{ playerId: "tk2", kind: "temp" }], "the one still running is lifted as before");
  // Without the game's own times nothing is taken to be over.
  assert.deepEqual(planBanReconcile("s1", "hll", [expired], [ban("tk1", "temp")], NOW).lift, [{ playerId: "tk1", kind: "temp" }]);
  // A finished one nobody decided has run out too — never "placed outside the panel", which would
  // ask staff to adopt a ban that holds nobody. One still running stays foreign: reported, never removed.
  const undecided = planBanReconcile("s1", "hll", [], [finished, running], NOW);
  assert.deepEqual(undecided.ranOut, [{ playerId: "tk1", kind: "temp" }], "a finished ban another tool placed has run out");
  assert.deepEqual(undecided.foreign.map((f) => f.playerId), ["tk2"], "only the running one is outside the panel");
  assert.deepEqual(undecided.lift, []);
  // A decision still standing behind a finished entry is left as it is: the game lists the player,
  // so nothing is applied, and nothing is called run out while the record says banned.
  const standing = decision({ playerId: "tk1", kind: "temp", expiresAt: at(-1) });
  const held = planBanReconcile("s1", "hll", [standing], [finished], NOW);
  assert.deepEqual([held.apply, held.lift, held.foreign, held.ranOut], [[], [], [], []]);

  const now = Date.parse(NOW);
  assert.equal(gameBanRanOut({ type: "temp", ts: at(24), durationHours: 24 }, now), true, "over to the minute");
  assert.equal(gameBanRanOut({ type: "temp", ts: new Date(now - 24 * 3_600_000 + 60_000).toISOString(), durationHours: 24 }, now), false, "a minute to go");
  assert.equal(gameBanRanOut({ type: "perma", ts: at(1000), durationHours: 0 }, now), false, "a perma ban never runs out");
  assert.equal(gameBanRanOut({ type: "perma", ts: at(1000), durationHours: 24 }, now), false, "whatever its entry says");
  assert.equal(gameBanRanOut({ type: "temp", ts: "not a date", durationHours: 24 }, now), false);
  assert.equal(gameBanRanOut({ type: "temp", ts: at(30), durationHours: 0 }, now), false, "no duration, no end");
});

test("a game ban with no decision behind it is reported, never removed", () => {
  const plan = planBanReconcile("s1", "hll", [], [ban("mystery")], NOW);
  assert.deepEqual(plan.foreign.map((f) => f.playerId), ["mystery"]);
  assert.deepEqual(plan.lift, [], "the reconciler never deletes what it merely does not recognise");
});

test("a settled server produces an empty plan, and the signature is stable across ordering", () => {
  const d = decision({});
  const settled = planBanReconcile("s1", "hll", [d], [ban("p1")], NOW);
  assert.deepEqual([settled.apply, settled.lift, settled.foreign], [[], [], []]);

  const a = planBanReconcile("s1", "hll", [d, decision({ playerId: "p2" })], [ban("x"), ban("y")], NOW);
  const b = planBanReconcile("s1", "hll", [decision({ playerId: "p2" }), d], [ban("y"), ban("x")], NOW);
  assert.equal(reconcileSignature(a), reconcileSignature(b), "same situation, same signature — the throttle depends on it");
});
