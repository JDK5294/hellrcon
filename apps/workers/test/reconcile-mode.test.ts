/**
 * What the ban and VIP reconcilers may do on a server: skip it, report on it, or fix it.
 *
 * The fix used to be a worker env flag (BAN_RECONCILE_APPLY / VIP_RECONCILE_APPLY) for every
 * server at once. It is each server's own switch now, read on every sweep, and off until staff
 * turn it on — so the only way a reconciler issues a ban or touches a VIP list on its own is a
 * server whose staff armed exactly that one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECONCILE_MAX_SENDS, StuckWrites, namesOf, reconcileMode } from "../src/reconcile-mode.ts";
import type { ServerRow } from "@app/db";

const server = (p: Partial<ServerRow>) => ({ engagementMode: "active", automation: {}, ...p }) as ServerRow;

test("a server nobody armed is reported on, never fixed", () => {
  assert.equal(reconcileMode(server({}), "ban"), "report");
  assert.equal(reconcileMode(server({}), "vip"), "report");
  assert.equal(reconcileMode(server({ automation: null as never }), "vip"), "report", "a row with no automation map at all still only reports");
});

test("each fix is armed on its own, per server", () => {
  const banArmed = server({ automation: { banSyncApply: true } });
  assert.equal(reconcileMode(banArmed, "ban"), "fix");
  assert.equal(reconcileMode(banArmed, "vip"), "report", "arming the ban fix leaves VIP reporting");
  const vipArmed = server({ automation: { vipSyncApply: true } });
  assert.equal(reconcileMode(vipArmed, "vip"), "fix");
  assert.equal(reconcileMode(vipArmed, "ban"), "report");
  assert.equal(reconcileMode(server({ automation: { banSyncApply: false } }), "ban"), "report");
});

test("observe mode, or the reconciler switched off, skips the server whatever its fix says", () => {
  assert.equal(reconcileMode(server({ engagementMode: "observe", automation: { banSyncApply: true } }), "ban"), "skip");
  assert.equal(reconcileMode(server({ automation: { banSync: false, banSyncApply: true } }), "ban"), "skip");
  assert.equal(reconcileMode(server({ automation: { vipSync: false, vipSyncApply: true } }), "vip"), "skip");
  assert.equal(reconcileMode(server({ automation: { vipSync: false } }), "ban"), "report", "switching VIP reconciliation off leaves bans alone");
});

// A ban or VIP pushed under an id the server cannot act on is accepted and changes nothing, so the
// next sweep plans it again. Unguarded, an armed reconciler re-sent it every few minutes forever,
// writing each send to the trail as a fresh ban or grant.
test("a write the game accepts but never carries out is sent a few times, then left alone and reported once", () => {
  const guard = new StuckWrites();
  const key = (b: { playerId: string }) => b.playerId;
  const planned = [{ playerId: "ghost" }, { playerId: "lands" }];
  for (let sweep = 1; sweep <= RECONCILE_MAX_SENDS; sweep++) {
    const p = guard.plan("s1", sweep === 1 ? planned : [{ playerId: "ghost" }], key);
    assert.deepEqual(p.send.map(key), sweep === 1 ? ["ghost", "lands"] : ["ghost"], `sweep ${sweep} still sends it`);
    for (const w of p.send) guard.accepted("s1", w.playerId);
  }
  const given = guard.plan("s1", [{ playerId: "ghost" }], key);
  assert.deepEqual(given.send, [], "past the tries it is not sent again");
  assert.deepEqual(given.unreported.map(key), ["ghost"], "and it is reported, once");
  const again = guard.plan("s1", [{ playerId: "ghost" }], key);
  assert.deepEqual([again.send, again.unreported], [[], []], "the next sweep neither sends nor reports it");
  assert.deepEqual(again.stuck.map(key), ["ghost"]);

  // Once it stops being planned (it landed, or the decision changed) it is forgotten: planned
  // again later, it gets its tries back.
  guard.plan("s1", [], key);
  assert.deepEqual(guard.plan("s1", [{ playerId: "ghost" }], key).send.map(key), ["ghost"]);
});

test("only an accepted send uses a try; servers and clears are separate", () => {
  const guard = new StuckWrites();
  const key = (b: { playerId: string }) => b.playerId;
  // Refused sends (the game threw — restarting, say) never call accepted: still sent every sweep.
  for (let i = 0; i < RECONCILE_MAX_SENDS + 2; i++) assert.deepEqual(guard.plan("s1", [{ playerId: "a" }], key).send.map(key), ["a"]);
  for (let i = 0; i < RECONCILE_MAX_SENDS; i++) { guard.plan("s1", [{ playerId: "a" }], key); guard.accepted("s1", "a"); }
  assert.deepEqual(guard.plan("s1", [{ playerId: "a" }], key).send, []);
  assert.deepEqual(guard.plan("s2", [{ playerId: "a" }], key).send.map(key), ["a"], "the same player on another server is its own write");
  guard.clear("s1"); // the fix switched off and on again
  assert.deepEqual(guard.plan("s1", [{ playerId: "a" }], key).send.map(key), ["a"], "starts over");
});

test("a stuck-write report names a few players, then counts the rest", () => {
  assert.equal(namesOf([{ playerId: "1", playerName: "Able" }, { playerId: "2", playerName: null }]), "Able, 2");
  const seven = Array.from({ length: 7 }, (_, i) => ({ playerId: String(i), playerName: `P${i}` }));
  assert.equal(namesOf(seven), "P0, P1, P2, P3, P4 and 2 more");
});

/*
 * The ban sweep hands the planner each temp ban's own placement time and duration. HLL goes on
 * listing a temp ban after its time runs out and refuses to remove it, so a planner that cannot
 * see the game's times plans that removal — and an armed sweep re-sends it, refused, every five
 * minutes for good (a refusal uses no try). The sweep is I/O around planBanReconcile, which is
 * tested in @app/db; this pins what it passes.
 */
test("the ban sweep gives the planner each temp ban's own time, so a finished one is never sent", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const from = src.indexOf("async function banReconcileSweep(");
  const sweep = src.slice(from, src.indexOf("planBanReconcile(server.id, server.game, decisions, gameBans, nowIso)", from));
  assert.ok(from > 0 && sweep.length > 0, "could not find the ban sweep's plan");
  assert.ok(sweep.includes('normalizeGameBans(temp, "temp").map((b) => ({ playerId: b.playerId, type: "temp" as const, ts: b.ts, durationHours: b.durationHours }))'),
    "temp bans reach the planner with the game's own placement time and duration");
});
