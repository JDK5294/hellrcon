// Recent activity (lib/recent): what the dashboard's card and Search list before anything is typed.
// Screens are opened far more often than anything is done, so they are capped apart — an afternoon
// of moving between screens must never push the players off the list.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.window = { dispatchEvent: () => true };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const { getRecent, recordRecent } = await import("../lib/recent.ts");

const screen = (label, tab) => recordRecent({ kind: "screen", label, view: label.toLowerCase(), ...(tab ? { tab } : {}) });
const player = (id) => recordRecent({ kind: "player", label: `Player ${id}`, sub: "profile", view: "players", target: { playerId: id } });

beforeEach(() => store.clear());

test("a screen opened again moves to the front, once, and keeps its tab", () => {
  screen("Bans", "bans");
  screen("Live");
  screen("Bans", "bans");
  assert.deepEqual(getRecent().map((r) => [r.label, r.tab]), [["Bans", "bans"], ["Live", undefined]]);
});

test("ten screens at most, and they never push players off the list", () => {
  for (const id of ["a", "b", "c"]) player(id);
  for (let i = 0; i < 12; i++) screen(`Screen ${i}`);
  let items = getRecent();
  assert.equal(items.filter((r) => r.kind === "screen").length, 10);
  assert.equal(items.find((r) => r.kind === "screen" && r.label === "Screen 0"), undefined, "the oldest screens went");
  assert.deepEqual(items.filter((r) => r.kind === "player").map((r) => r.target.playerId), ["c", "b", "a"], "every player stayed");

  for (let i = 0; i < 25; i++) player(`p${i}`);
  items = getRecent();
  assert.equal(items.filter((r) => r.kind === "player").length, 20, "twenty of everything else");
  assert.equal(items.filter((r) => r.kind === "screen").length, 10, "and the screens are still there");
  assert.equal(items[0].target.playerId, "p24", "newest first");
});

// A shared computer: one person's recently opened players and screens are not the next person's to
// see — the same rule the back trail keeps (lib/api setToken/clearToken). The panel keys its
// per-person settings by the account signed in (panel.username), and the list follows it.
test("each account on this browser has its own list", () => {
  store.set("panel.username", "alice");
  player("a1");
  screen("Bans", "bans");
  store.set("panel.username", "bob");
  assert.deepEqual(getRecent(), [], "bob sees nothing of alice's");
  player("b1");
  assert.deepEqual(getRecent().map((r) => r.target?.playerId), ["b1"]);
  store.set("panel.username", "alice");
  assert.deepEqual(getRecent().map((r) => r.label), ["Bans", "Player a1"], "alice's own list is still hers");
});

test("the old list from before it was per account is nobody's to inherit", () => {
  store.set("panel.recent", JSON.stringify([{ kind: "player", label: "Someone's player", view: "players", target: { playerId: "x" }, ts: "2026-10-01T00:00:00.000Z" }]));
  store.set("panel.username", "carol");
  assert.deepEqual(getRecent(), []);
  player("c1");
  assert.equal(store.has("panel.recent"), false, "and it is cleared away");
});
