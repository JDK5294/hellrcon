import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGameVips } from "../dist/protocol/binary-v2/responses.js";
import { planVipReconcile, vipReconcileSignature, type VipGrantLike } from "../dist/vip-reconcile.js";

const NOW = "2026-08-16T12:00:00.000Z";
const past = "2026-08-15T00:00:00.000Z";
const future = "2026-08-20T00:00:00.000Z";

const grant = (playerId: string, over: Partial<VipGrantLike> = {}): VipGrantLike => ({
  playerId, playerName: `n-${playerId}`, comment: null,
  expiration: null, pausedUntil: null, pauseMode: null, ...over,
});
const on = (playerId: string) => ({ playerId, comment: null });

// ---- normalizeGameVips: the null/[] distinction is the load-bearing part ----

test("normalizeGameVips: a well-formed empty list is EVIDENCE, not absence of it", () => {
  // The live incident verbatim: `{"vipPlayers":[]}` while the panel held dozens of grants. This
  // must come back as a real empty list the planner can act on.
  assert.deepEqual(normalizeGameVips({ vipPlayers: [] }), []);
});

test("normalizeGameVips: anything that is not a structured list is null — never planned against", () => {
  assert.equal(normalizeGameVips("raw legacy text"), null);
  assert.equal(normalizeGameVips(null), null);
  assert.equal(normalizeGameVips({ someOtherKey: [] }), null);
  assert.equal(normalizeGameVips({ vipPlayers: "not an array" }), null);
});

test("normalizeGameVips: accepts the casings a v2 server could plausibly emit", () => {
  // Key casing per the live capture; entry ids in any of the spellings the wire has produced
  // elsewhere (iD is the players read's own quirk). Blank ids are dropped, not kept as "".
  assert.deepEqual(normalizeGameVips({ vipPlayers: [{ iD: "a", comment: "donor" }] }), [{ playerId: "a", comment: "donor" }]);
  assert.deepEqual(normalizeGameVips({ VipPlayers: [{ Id: "b", Comment: "" }] }), [{ playerId: "b", comment: null }]);
  assert.deepEqual(normalizeGameVips({ vipPlayers: [{ id: "c" }, { iD: "" }] }), [{ playerId: "c", comment: null }]);
});

test("normalizeGameVips: an empty `iD` beside a real id must not make the VIP vanish — the enforcer's outside-panel guard plans against this list", () => {
  assert.deepEqual(normalizeGameVips({ vipPlayers: [{ iD: "", id: "76561198000000001", comment: "paid" }] }),
    [{ playerId: "76561198000000001", comment: "paid" }]);
  assert.deepEqual(normalizeGameVips({ vipPlayers: [{ iD: "", Id: "", ID: "d" }] }), [{ playerId: "d", comment: null }]);
});

// ---- the planner's three buckets ----

test("the wiped-list incident: every live grant is 'apply', nothing else", () => {
  const grants = [grant("a"), grant("b", { expiration: future }), grant("c")];
  const plan = planVipReconcile(grants, [], NOW);
  assert.deepEqual(plan.apply.map((v) => v.playerId), ["a", "b", "c"]);
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.foreign, []);
});

test("a grant the game already lists is nothing to do", () => {
  const plan = planVipReconcile([grant("a")], [on("a")], NOW);
  assert.deepEqual(plan, { apply: [], remove: [], foreign: [] });
});

test("PAUSED means off the game: never re-added, removed if present", () => {
  // The rule most likely to be got wrong: a paused VIP has a live row and is deliberately absent
  // from the game. Re-adding them would quietly undo every VIP timeout staff issue.
  const paused = grant("p", { pausedUntil: future });
  assert.deepEqual(planVipReconcile([paused], [], NOW).apply, []);
  const back = planVipReconcile([paused], [on("p")], NOW);
  assert.deepEqual(back.remove, [{ playerId: "p", playerName: "n-p", why: "paused" }]);
  assert.deepEqual(back.apply, []);
});

test("a LAPSED pause is over: the grant counts as live again", () => {
  const plan = planVipReconcile([grant("p", { pausedUntil: past })], [], NOW);
  assert.deepEqual(plan.apply.map((v) => v.playerId), ["p"]);
});

test("expired grants are removed if listed and never re-added", () => {
  const dead = grant("x", { expiration: past });
  assert.deepEqual(planVipReconcile([dead], [], NOW).apply, []);
  const listed = planVipReconcile([dead], [on("x")], NOW);
  assert.deepEqual(listed.remove, [{ playerId: "x", playerName: "n-x", why: "expired" }]);
});

test("a banked pause froze the meter: a stored expiration in the past does NOT read as expired", () => {
  // The expiry sweep skips banked-frozen rows because the pause math pushes the expiration out on
  // resume. The reconciler must agree, or it would remove-as-expired what the sweep preserves.
  // The pause rule still keeps them off the game.
  const banked = grant("b", { pausedUntil: future, pauseMode: "banked", expiration: past });
  const plan = planVipReconcile([banked], [on("b")], NOW);
  assert.deepEqual(plan.remove, [{ playerId: "b", playerName: "n-b", why: "paused" }]);
  assert.deepEqual(planVipReconcile([banked], [], NOW).apply, []);
});

test("foreign entries are reported and never touched", () => {
  const plan = planVipReconcile([grant("ours")], [on("ours"), on("console-granted")], NOW);
  assert.deepEqual(plan.foreign, [{ playerId: "console-granted", comment: null }]);
  assert.deepEqual(plan.remove, [], "not ours to remove");
});

test("the signature is stable across ordering, so a standing plan reports once", () => {
  const a = planVipReconcile([grant("a"), grant("b")], [on("z")], NOW);
  const b = planVipReconcile([grant("b"), grant("a")], [on("z")], NOW);
  assert.equal(vipReconcileSignature(a), vipReconcileSignature(b));
  assert.notEqual(vipReconcileSignature(a), vipReconcileSignature(planVipReconcile([grant("a")], [], NOW)));
});
