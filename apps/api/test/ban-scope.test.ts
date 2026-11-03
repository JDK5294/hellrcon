// A ban's scope is a rule, and the rules only earn their keep if "all servers" behaves differently
// from "these three servers" when a fourth appears. That is the case these tests exist for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeBanScope, narrowBanScope, parseBanScope, resolveBanScope, scopeCovers, type BanScope } from "../dist/ban-scope.js";

const HLL = [
  { id: "a", game: "hll" },
  { id: "b", game: "hll" },
  { id: "c", game: "hll" },
];
const MIXED = [...HLL, { id: "v", game: "hllv" }];
const ids = (scope: BanScope, servers = MIXED, game = "hll") => resolveBanScope(scope, servers, game).map((s) => s.id);

test("an explicit list is a snapshot — a new server is not covered", () => {
  const scope: BanScope = { mode: "servers", serverIds: ["a", "b"] };
  assert.deepEqual(ids(scope), ["a", "b"]);
  // The fourth server arrives.
  assert.deepEqual(ids(scope, [...MIXED, { id: "d", game: "hll" }]), ["a", "b"]);
});

test("all and except are standing rules — a new server IS covered", () => {
  const grown = [...MIXED, { id: "d", game: "hll" }];
  assert.deepEqual(ids({ mode: "all" }, grown), ["a", "b", "c", "d"]);
  assert.deepEqual(ids({ mode: "except", serverIds: ["b"] }, grown), ["a", "c", "d"]);
});

test("a scope never crosses games, whatever it says", () => {
  // "all servers" cannot mean the Vietnam server: a Hell Let Loose Steam64 does not exist there.
  assert.deepEqual(ids({ mode: "all" }), ["a", "b", "c"]);
  assert.deepEqual(ids({ mode: "except", serverIds: [] }), ["a", "b", "c"]);
  // …and naming it explicitly does not smuggle it in either.
  assert.deepEqual(ids({ mode: "servers", serverIds: ["a", "v"] }), ["a"]);
  assert.deepEqual(ids({ mode: "all" }, MIXED, "hllv"), ["v"]);
});

test("except with an empty list is all", () => {
  assert.deepEqual(ids({ mode: "except", serverIds: [] }), ids({ mode: "all" }));
});

test("scopeCovers answers for a server the rule has never seen", () => {
  const fresh = { id: "d", game: "hll" };
  assert.equal(scopeCovers({ mode: "all" }, fresh, "hll"), true);
  assert.equal(scopeCovers({ mode: "except", serverIds: ["b"] }, fresh, "hll"), true);
  assert.equal(scopeCovers({ mode: "except", serverIds: ["d"] }, fresh, "hll"), false);
  assert.equal(scopeCovers({ mode: "servers", serverIds: ["a", "b"] }, fresh, "hll"), false);
  // Wrong game is never covered, even by "all".
  assert.equal(scopeCovers({ mode: "all" }, { id: "v", game: "hllv" }, "hll"), false);
});

test("the original serverIds body still means what it meant", () => {
  const r = parseBanScope({ serverIds: ["a", "b", "a"] });
  assert.ok(r.ok);
  // De-duplicated, and a snapshot — which is the honest reading of a list somebody sent us.
  assert.deepEqual(r.scope, { mode: "servers", serverIds: ["a", "b"] });
});

test("no scope and no serverIds means the server in the path", () => {
  const r = parseBanScope({ action: "permaban" });
  assert.ok(r.ok);
  assert.equal(r.scope, null);
});

test("an empty selection is refused rather than silently doing nothing", () => {
  for (const body of [{ serverIds: [] }, { scope: { mode: "servers", serverIds: [] } }]) {
    const r = parseBanScope(body);
    assert.equal(r.ok, false, JSON.stringify(body));
  }
  // But "everywhere except nothing" is a real sentence and resolves to everywhere.
  const r = parseBanScope({ scope: { mode: "except", serverIds: [] } });
  assert.ok(r.ok);
  assert.deepEqual(r.scope, { mode: "except", serverIds: [] });
});

test("a malformed scope is rejected, not guessed at", () => {
  for (const raw of ["all", ["a"], { mode: "everywhere" }, { mode: 1 }, {}]) {
    assert.equal(parseBanScope({ scope: raw }).ok, false, JSON.stringify(raw));
  }
});

test("the audit summary says which rule was used, not just the count", () => {
  const no = (id: string) => ({ a: 1, b: 2, c: 3 })[id] ?? id;
  assert.equal(describeBanScope({ mode: "all" }, no), "all servers (including any added later)");
  assert.equal(describeBanScope({ mode: "except", serverIds: ["b"] }, no), "all servers except 2 (including any added later)");
  assert.equal(describeBanScope({ mode: "servers", serverIds: ["a"] }, no), "server 1");
  assert.equal(describeBanScope({ mode: "servers", serverIds: ["a", "c"] }, no), "servers 1, 3");
  // The difference the whole model exists for has to be visible in the trail: these two cover the
  // same servers today and mean different things tomorrow.
  assert.notEqual(
    describeBanScope({ mode: "all" }, no),
    describeBanScope({ mode: "servers", serverIds: ["a", "b", "c"] }, no),
  );
});

// What a partial unban does to the rule — narrow, lift, or none of its business.
test("narrowing: all minus one server is except-that-server, and future servers stay covered", () => {
  const r = narrowBanScope({ mode: "all" }, ["a"], MIXED, "hll");
  assert.deepEqual(r, { outcome: "narrow", scope: { mode: "except", serverIds: ["a"] } });
  // The narrowed rule still covers a server added later — the community sentence stands where it
  // was not lifted.
  const later = [...MIXED, { id: "d", game: "hll" }];
  assert.deepEqual(ids((r as { scope: BanScope }).scope, later), ["b", "c", "d"]);
});

test("narrowing: an except rule accumulates lifted servers; a literal list just shrinks", () => {
  const e = narrowBanScope({ mode: "except", serverIds: ["a"] }, ["b"], MIXED, "hll");
  assert.deepEqual(e, { outcome: "narrow", scope: { mode: "except", serverIds: ["a", "b"] } });
  const s = narrowBanScope({ mode: "servers", serverIds: ["a", "b"] }, ["a"], MIXED, "hll");
  assert.deepEqual(s, { outcome: "narrow", scope: { mode: "servers", serverIds: ["b"] } });
});

test("narrowing: lifting every covered server retires the rule — standing rules included", () => {
  assert.deepEqual(narrowBanScope({ mode: "servers", serverIds: ["a"] }, ["a"], MIXED, "hll"), { outcome: "lift" });
  // Staff took every server the dialog offered; a ghost rule that springs back on a future
  // server would be a trap, not an inheritance.
  assert.deepEqual(narrowBanScope({ mode: "all" }, ["a", "b", "c"], MIXED, "hll"), { outcome: "lift" });
});

test("narrowing: an unban elsewhere is not this rule's business", () => {
  assert.deepEqual(narrowBanScope({ mode: "servers", serverIds: ["a"] }, ["b"], MIXED, "hll"), { outcome: "keep" });
  // A different game's server can never touch an hll rule, whatever its id.
  assert.deepEqual(narrowBanScope({ mode: "all" }, ["v"], MIXED, "hll"), { outcome: "keep" });
});
