/*
 * The navigation trail's semantics — the familiar back/forward contract, over the app's own last
 * ten screens. Pure node: without a `window` the module keeps everything in memory, which is
 * exactly the part these tests own (storage is a persistence detail; the identity reset that
 * clears it is wired through lib/api.ts and asserted by source below).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { trailNote, trailBack, trailForward, trailState, resetTrail, trailEntries } from "../lib/trail.ts";

test("visits append, the same screen twice is one entry, and the cap drops the oldest", () => {
  resetTrail();
  trailNote("/dashboard");
  trailNote("/live");
  trailNote("/live"); // a re-render, not a journey
  assert.deepEqual(trailEntries().entries, ["/dashboard", "/live"]);

  for (let i = 0; i < 12; i++) trailNote(`/page-${i}`);
  const { entries, index } = trailEntries();
  assert.equal(entries.length, 10, "the trail holds the last ten screens");
  assert.equal(entries[9], "/page-11", "newest last");
  assert.equal(entries[0], "/page-2", "oldest dropped, dashboard and live long gone");
  assert.equal(index, 9);
});

test("back and forward walk the trail; arriving where they said is a move, not a visit", () => {
  resetTrail();
  for (const p of ["/a", "/b", "/c"]) trailNote(p);

  const back = trailBack();
  assert.equal(back, "/b");
  trailNote("/b"); // the router reports the arrival back() caused
  assert.equal(trailEntries().index, 1, "moved along the trail");
  assert.deepEqual(trailEntries().entries, ["/a", "/b", "/c"], "nothing truncated by going back");

  const fwd = trailForward();
  assert.equal(fwd, "/c");
  trailNote("/c");
  assert.equal(trailEntries().index, 2);

  assert.equal(trailForward(), null, "nothing ahead at the top");
  trailNote("/a"); // clear the pending jump by visiting normally
  resetTrail();
  assert.equal(trailBack(), null, "nothing behind on an empty trail");
});

test("visiting somewhere new from the middle drops the forward half", () => {
  resetTrail();
  for (const p of ["/a", "/b", "/c"]) trailNote(p);
  trailNote(trailBack()); // back to /b
  trailNote("/d"); // choose a different future
  assert.deepEqual(trailEntries().entries, ["/a", "/b", "/d"], "/c is no longer a forward destination");
  assert.equal(trailForward(), null);
  assert.equal(trailBack(), "/b");
});

test("state answers the buttons: can/cannot, and where each would land", () => {
  resetTrail();
  assert.deepEqual(trailState(), { canBack: false, canForward: false, backPath: null, forwardPath: null });
  trailNote("/a");
  trailNote("/b");
  assert.equal(trailState().canBack, true);
  assert.equal(trailState().backPath, "/a");
  trailNote(trailBack());
  const s = trailState();
  assert.equal(s.canForward, true);
  assert.equal(s.forwardPath, "/b");
});

/*
 * The reset is only worth anything if every identity change actually goes through it. There are
 * exactly two doors — setToken and clearToken — and every login, the OAuth handoff, sign out and
 * session expiry all use them; this pins the reset to both so a refactor cannot quietly detach
 * the trail from the identity again.
 */
test("both identity doors reset the trail", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "api.ts"), "utf8");
  const setBody = src.slice(src.indexOf("export function setToken"), src.indexOf("export function clearToken"));
  const clearBody = src.slice(src.indexOf("export function clearToken"));
  assert.match(setBody, /resetTrail\(\)/, "a LOGIN must not inherit the previous person's footsteps");
  assert.match(clearBody.slice(0, clearBody.indexOf("}")), /resetTrail\(\)/, "a LOGOUT must not leave them behind");
});
