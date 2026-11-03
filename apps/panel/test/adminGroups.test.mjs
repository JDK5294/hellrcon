// The console-admin default group. The game lists "owner" first, and both grant flows used to
// take the first entry — so a grant whose group nobody touched went out at the level with the
// keys to everything, when this community hands out "spectator" (admin camera, nothing else).
import { test } from "node:test";
import assert from "node:assert/strict";
import { preferredAdminGroup } from "../lib/adminGroups.ts";

test("a fresh grant starts on spectator, wherever the server lists it", () => {
  assert.equal(preferredAdminGroup(["owner", "senior", "junior", "spectator"]), "spectator");
  assert.equal(preferredAdminGroup(["Spectator", "owner"]), "Spectator", "case and the server's own spelling are respected");
  assert.equal(preferredAdminGroup([" spectator ", "owner"]), " spectator ", "whitespace in the game's list is matched, not rewritten");
});

test("a custom group set without spectator falls back to the first entry; empty stays empty", () => {
  assert.equal(preferredAdminGroup(["moderator", "streamer"]), "moderator");
  assert.equal(preferredAdminGroup([]), "");
  assert.equal(preferredAdminGroup(null), "");
  assert.equal(preferredAdminGroup(undefined), "");
});
