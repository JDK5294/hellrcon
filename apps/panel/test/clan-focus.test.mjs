/*
 * The Clans tab's hand-off, in memory: a profile's clan tag chip naming the clan the tab should
 * open on (read, then cleared once shown). The clans last ticked are the tab's own remembered
 * state (lib/remembered.ts), driven in the browser tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearClanFocus, focusClan, peekClanFocus } from "../lib/clanFocus.ts";
import { locationFromPath, pathFor } from "../lib/routes.ts";

test("a chip's clan is there to read until the tab clears it — read twice, it is still there", () => {
  assert.equal(peekClanFocus(), null);
  focusClan("[KLM]");
  assert.equal(peekClanFocus(), "[KLM]");
  assert.equal(peekClanFocus(), "[KLM]", "a component mounted twice (development) still sees it");
  clearClanFocus();
  assert.equal(peekClanFocus(), null, "the next visit starts plain");
});

test("the Clans tab has its own address under Players", () => {
  assert.equal(pathFor("players", "clans"), "/players/clans");
  assert.deepEqual(locationFromPath("/players/clans"), { view: "players", tab: "clans" });
});
