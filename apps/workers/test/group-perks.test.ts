/**
 * Group VIP perks' decisions: who is held where, which holds start, refresh and release, and
 * everything the reconcile refuses to do — take over VIP it did not give, write on a server it
 * may not, or guess an id's game.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { desiredHolds, planPerkHolds, memberGameVerdict, releaseSeverance, type PerkGroup } from "../src/group-perks.ts";
import type { ServerRow, VipRow } from "@app/db";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const STEAM_A = "76561198000000001";
const STEAM_B = "76561198000000002";
const EOS_SEEN = "0123456789abcdef0123456789abcdef";
const EOS_UNSEEN = "fedcba9876543210fedcba9876543210";

function server(p: Partial<ServerRow>): ServerRow {
  return { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active", automation: {}, ...p } as ServerRow;
}
function vip(p: Partial<VipRow>): VipRow {
  return {
    id: "v", serverId: "s1", playerId: STEAM_A, playerName: "Ana", comment: null, expiration: null,
    pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null, groupHold: null,
    createdByUserId: null, createdByName: "staff", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...p,
  } as VipRow;
}
const cvc = (members: string[], perk: Partial<PerkGroup["perk"]> = {}): PerkGroup => ({
  id: "g-cvc", name: "WW2 CVC",
  perk: { game: "hll", scope: { mode: "all" }, severanceMinutes: 2 * 1440, ...perk },
  members: members.map((playerId) => ({ playerId, playerName: playerId === STEAM_A ? "Ana" : null })),
});

test("a member's game: the directory's word, a Steam64 is WW2, anything unseen waits", () => {
  const gameOf = new Map([[EOS_SEEN, "hllv"]]);
  assert.equal(memberGameVerdict(STEAM_A, "hll", gameOf), "ok");
  assert.equal(memberGameVerdict(STEAM_A, "hllv", gameOf), "otherGame", "Vietnam keys players by EOS id, never Steam64");
  assert.equal(memberGameVerdict(EOS_SEEN, "hllv", gameOf), "ok");
  assert.equal(memberGameVerdict(EOS_SEEN, "hll", gameOf), "otherGame");
  assert.equal(memberGameVerdict(EOS_UNSEEN, "hll", gameOf), "notSeen", "a console id could be either game until seen");
});

test("a perk covers its game's servers by rule — every server, the ones listed, or all but some", () => {
  const servers = [server({ id: "s1" }), server({ id: "s2" }), server({ id: "v1", game: "hllv" })];
  const all = desiredHolds([cvc([STEAM_A])], servers, new Map()).desired;
  assert.deepEqual([...all.keys()].sort(), [`s1|${STEAM_A}`, `s2|${STEAM_A}`], "every WW2 server, never the Vietnam one");
  const one = desiredHolds([cvc([STEAM_A], { scope: { mode: "servers", serverIds: ["s2"] } })], servers, new Map()).desired;
  assert.deepEqual([...one.keys()], [`s2|${STEAM_A}`]);
  const but = desiredHolds([cvc([STEAM_A], { scope: { mode: "except", serverIds: ["s2"] } })], servers, new Map()).desired;
  assert.deepEqual([...but.keys()], [`s1|${STEAM_A}`]);
  const { notes } = desiredHolds([cvc([STEAM_A, EOS_UNSEEN])], servers, new Map());
  assert.equal(notes.get("g-cvc")!.notSeen, 1, "an unplaceable member is reported, not dropped silently");
});

test("two groups holding the same player: one hold, both remembered", () => {
  const streamers: PerkGroup = { id: "g-str", name: "Streamers", perk: { game: "hll", scope: { mode: "all" }, severanceMinutes: 60 }, members: [{ playerId: STEAM_A, playerName: "Ana" }] };
  const { desired } = desiredHolds([cvc([STEAM_A]), streamers], [server({})], new Map());
  assert.deepEqual(desired.get(`s1|${STEAM_A}`)!.groups.map((g) => g.id), ["g-cvc", "g-str"]);
});

test("starts: a timed grant is held, permanent VIP of their own is left alone, VIP set outside the panel is not taken over", () => {
  const servers = [server({})];
  const { desired, notes } = desiredHolds([cvc([STEAM_A, STEAM_B, "76561198000000003", "76561198000000004"])], servers, new Map());
  const rows = new Map([
    [`s1|${STEAM_A}`, vip({ playerId: STEAM_A, expiration: new Date(NOW + 10 * DAY).toISOString() })],
    [`s1|${STEAM_B}`, vip({ playerId: STEAM_B, expiration: null })],
  ]);
  // No list read yet: the starts that need one (no grant row) wait for it.
  const first = planPerkHolds({ desired, rows, servers, gameLists: new Map(), nowMs: NOW, notes: new Map([...notes].map(([k, v]) => [k, { ...v }])) });
  assert.deepEqual([...first.needLists], ["s1"]);
  assert.deepEqual(first.start.map((s) => s.playerId), [STEAM_A], "the timed grant needs no list");

  const plan = planPerkHolds({ desired, rows, servers, gameLists: new Map([["s1", new Set(["76561198000000003"])]]), nowMs: NOW, notes });
  assert.deepEqual(plan.start.map((s) => s.playerId).sort(), [STEAM_A, "76561198000000004"]);
  assert.ok(plan.start.every((s) => s.addToGame));
  assert.equal(notes.get("g-cvc")!.ownPermanent, 1, "their own permanent VIP is theirs");
  assert.equal(notes.get("g-cvc")!.ownGameVip, 1, "VIP the game lists with no grant of ours is not taken over");

  const unreadable = desiredHolds([cvc(["76561198000000004"])], servers, new Map());
  const blind = planPerkHolds({ desired: unreadable.desired, rows: new Map(), servers, gameLists: new Map([["s1", null]]), nowMs: NOW, notes: unreadable.notes });
  assert.equal(blind.start.length, 0, "an unreadable list holds the start back");
  assert.equal(unreadable.notes.get("g-cvc")!.listUnreadable, 1);
});

test("a timed-out player is held without being put back on the game — the timeout's end does that", () => {
  const servers = [server({})];
  const { desired, notes } = desiredHolds([cvc([STEAM_A])], servers, new Map());
  const rows = new Map([[`s1|${STEAM_A}`, vip({ expiration: new Date(NOW + DAY).toISOString(), pausedUntil: new Date(NOW + DAY).toISOString(), pauseMode: "banked", pausedAt: new Date(NOW).toISOString() })]]);
  const plan = planPerkHolds({ desired, rows, servers, gameLists: new Map(), nowMs: NOW, notes });
  assert.equal(plan.start[0]!.addToGame, false);
});

test("quiet servers: observe mode, or VIP expiry run outside the panel — nothing starts, nothing is released", () => {
  for (const quiet of [server({ engagementMode: "observe" }), server({ automation: { vipSweep: false } })]) {
    const { desired, notes } = desiredHolds([cvc([STEAM_A])], [quiet], new Map());
    const plan = planPerkHolds({ desired, rows: new Map(), servers: [quiet], gameLists: new Map(), nowMs: NOW, notes });
    assert.equal(plan.start.length, 0);
    assert.equal(notes.get("g-cvc")!.quietServers, 1);
    const left = planPerkHolds({ desired: new Map(), rows: new Map([[`s1|${STEAM_A}`, vip({ groupHold: { since: "x", bankedMs: DAY, groups: [] } })]]), servers: [quiet], gameLists: new Map(), nowMs: NOW, notes: new Map() });
    assert.equal(left.release.length, 0, "a hold there stays rather than being dated into an expiry nobody carries out");
  }
});

test("leaving: the frozen balance back plus the largest severance; nothing banked and none due ends it at once", () => {
  const servers = [server({})];
  const held = vip({ groupHold: { since: "2026-09-01T00:00:00.000Z", bankedMs: 10 * DAY, groups: [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 2 * 1440 }, { id: "g-str", name: "Streamers", severanceMinutes: 60 }] } });
  const plan = planPerkHolds({ desired: new Map(), rows: new Map([[`s1|${STEAM_A}`, held]]), servers, gameLists: new Map(), nowMs: NOW, notes: new Map() });
  assert.equal(plan.release.length, 1);
  assert.equal(plan.release[0]!.severanceMinutes, 2 * 1440);
  assert.equal(Date.parse(plan.release[0]!.expiration), NOW + 12 * DAY);
  assert.equal(releaseSeverance([]), 0);

  const bare = vip({ groupHold: { since: "x", bankedMs: 0, groups: [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 0 }] } });
  const now = planPerkHolds({ desired: new Map(), rows: new Map([[`s1|${STEAM_A}`, bare]]), servers, gameLists: new Map(), nowMs: NOW, notes: new Map() });
  assert.equal(Date.parse(now.release[0]!.expiration), NOW, "dated now: the next VIP sweep takes it off the game");
});

test("still a member: the hold stays, its remembered groups refreshed only when they changed", () => {
  const servers = [server({})];
  const { desired, notes } = desiredHolds([cvc([STEAM_A], { severanceMinutes: 1440 })], servers, new Map());
  const stale = vip({ groupHold: { since: "x", bankedMs: 0, groups: [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 2880 }] } });
  const plan = planPerkHolds({ desired, rows: new Map([[`s1|${STEAM_A}`, stale]]), servers, gameLists: new Map(), nowMs: NOW, notes });
  assert.equal(plan.start.length + plan.release.length, 0);
  assert.deepEqual(plan.refresh[0]!.groups, [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 1440 }]);
  const fresh = vip({ groupHold: { since: "x", bankedMs: 0, groups: [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 1440 }] } });
  assert.equal(planPerkHolds({ desired, rows: new Map([[`s1|${STEAM_A}`, fresh]]), servers, gameLists: new Map(), nowMs: NOW, notes }).refresh.length, 0);
});

test("a timed grant about to run out is left to the expiry sweep; one a VIP timeout froze is not", () => {
  const servers = [server({})];
  const { desired, notes } = desiredHolds([cvc([STEAM_A, STEAM_B, "76561198000000003"])], servers, new Map());
  const rows = new Map([
    [`s1|${STEAM_A}`, vip({ playerId: STEAM_A, expiration: new Date(NOW + 60_000).toISOString() })],
    [`s1|${STEAM_B}`, vip({ playerId: STEAM_B, expiration: new Date(NOW - DAY).toISOString(), pauseMode: "banked", pausedUntil: new Date(NOW + DAY).toISOString(), pausedAt: new Date(NOW - 2 * DAY).toISOString() })],
  ]);
  const plan = planPerkHolds({ desired, rows, servers, gameLists: new Map([["s1", new Set<string>()]]), nowMs: NOW, notes });
  assert.deepEqual(plan.start.map((s) => s.playerId).sort(), [STEAM_B, "76561198000000003"], "Ana's minute is the sweep's — next round holds her");
  const frozen = plan.start.find((s) => s.playerId === STEAM_B)!;
  assert.equal(frozen.expiration, null, "a frozen grant carries no date to recheck");
  assert.equal(frozen.fresh, false);
  assert.equal(plan.start.find((s) => s.playerId === "76561198000000003")!.fresh, true, "no row of ours: the game entry would be the perk's alone");
});

test("a release pays the severance the group's perk is set to now; a refresh carries what the hold remembered", () => {
  const servers = [server({})];
  const held = (severanceMinutes: number) => vip({ playerId: STEAM_A, groupHold: { since: "2026-10-01T00:00:00.000Z", bankedMs: DAY, groups: [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes }] } });
  // Narrowed away from this server (no longer desired) while the perk stands, set to 60 minutes now.
  const plan = planPerkHolds({ desired: new Map(), rows: new Map([[`s1|${STEAM_A}`, held(30 * 1440)]]), servers, gameLists: new Map(), nowMs: NOW, notes: new Map(), perkSeverances: new Map([["g-cvc", 60]]) });
  assert.equal(plan.release.length, 1);
  assert.equal(plan.release[0]!.severanceMinutes, 60);
  assert.equal(plan.release[0]!.recordedSeverance, 30 * 1440, "the release still lands only on the hold as read");
  assert.equal(plan.release[0]!.expiration, new Date(NOW + DAY + 60 * 60_000).toISOString());
  // The perk is gone (switched off, group deleted): the severance recorded on the hold — the answer given.
  const ended = planPerkHolds({ desired: new Map(), rows: new Map([[`s1|${STEAM_A}`, held(0)]]), servers, gameLists: new Map(), nowMs: NOW, notes: new Map(), perkSeverances: new Map() });
  assert.equal(ended.release[0]!.severanceMinutes, 0);

  const { desired, notes } = desiredHolds([cvc([STEAM_A], { severanceMinutes: 60 })], servers, new Map());
  const refresh = planPerkHolds({ desired, rows: new Map([[`s1|${STEAM_A}`, held(30)]]), servers, gameLists: new Map(), nowMs: NOW, notes });
  assert.deepEqual(refresh.refresh.map((r) => [r.groups[0]!.severanceMinutes, r.was[0]!.severanceMinutes]), [[60, 30]]);
});

test("a row the expiry sweep cannot clear is taken over once it has been stuck a while", () => {
  const servers = [server({})];
  const { desired, notes } = desiredHolds([cvc([STEAM_A, STEAM_B])], servers, new Map());
  const rows = new Map([
    [`s1|${STEAM_A}`, vip({ playerId: STEAM_A, expiration: new Date(NOW - 2 * 60_000).toISOString() })], // just past: the sweep's
    [`s1|${STEAM_B}`, vip({ playerId: STEAM_B, expiration: new Date(NOW - 60 * 60_000).toISOString() })], // an hour past: stuck
  ]);
  const plan = planPerkHolds({ desired, rows, servers, gameLists: new Map([["s1", new Set<string>()]]), nowMs: NOW, notes });
  assert.deepEqual(plan.start.map((s) => s.playerId), [STEAM_B]);
});
