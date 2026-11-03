/**
 * Which of the worker's shared reads the Live page may answer from (live-share.ts). All three must
 * be there and fresh: a page built from a fresh roster and a session from a minute ago shows a
 * score that no longer stands beside people who are there now, so anything short of that is null
 * and the page reads the game itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshLiveReads, LIVE_SHARE_FRESH_MS, LIVE_SHARE_TTL_SEC, liveShareKey } from "../src/live-share.ts";

const NOW = 1_800_000_000_000;
const read = (value: unknown, ageMs = 0) => ({ at: NOW - ageMs, value });
const all = () => ({ session: read({ map: "foy" }), players: read([{ name: "A" }]), maprotation: read(["foy", "kursk"]) });

test("live share: all three fresh reads give their values", () => {
  assert.deepEqual(freshLiveReads(all(), NOW), { session: { map: "foy" }, players: [{ name: "A" }], maprotation: ["foy", "kursk"] });
});

test("live share: a server with no rotation shares null, and that is still an answer", () => {
  assert.deepEqual(freshLiveReads({ ...all(), maprotation: read(null) }, NOW)?.maprotation, null);
});

test("live share: each read is held to its own limit, and one too old sends the page to the game", () => {
  for (const kind of ["session", "players", "maprotation"] as const) {
    const limit = LIVE_SHARE_FRESH_MS[kind];
    assert.ok(freshLiveReads({ ...all(), [kind]: read("x", limit) }, NOW), `${kind} at exactly its limit still shows`);
    assert.equal(freshLiveReads({ ...all(), [kind]: read("x", limit + 1) }, NOW), null, `${kind} past its limit`);
  }
  // The rotation changes only when someone changes it: half a minute old is fine for it, never
  // for the roster.
  assert.ok(freshLiveReads({ ...all(), maprotation: read([], 30_000) }, NOW));
  assert.equal(freshLiveReads({ ...all(), players: read([], 30_000) }, NOW), null);
});

test("live share: a read taken before the reader's own last change to the server is not an answer", () => {
  // The panel reloads straight after a kick: a roster read from before it still lists the player.
  const kick = NOW - 3000;
  assert.equal(freshLiveReads({ ...all(), players: read([], 5000) }, NOW, kick), null);
  assert.equal(freshLiveReads({ ...all(), players: read([], 3000) }, NOW, kick), null, "the same moment proves nothing either");
  assert.ok(freshLiveReads({ ...all(), maprotation: read([], 2000), players: read([], 2000), session: read({}, 1000) }, NOW, kick), "every read after it");
  assert.equal(freshLiveReads({ ...all(), maprotation: read([], 10_000), players: read([], 2000), session: read({}, 1000) }, NOW, kick), null,
    "the rotation too: a change can be a map change");
});

test("live share: a missing or malformed read is not an answer", () => {
  const bad: unknown[] = [null, undefined, "text", 5, {}, { at: NOW }, { value: [] }, { at: "now", value: [] }, { at: Number.NaN, value: [] }];
  for (const b of bad) assert.equal(freshLiveReads({ ...all(), players: b }, NOW), null, JSON.stringify(b) ?? String(b));
});

test("live share: every read is kept past its freshness limit, and each server's are its own", () => {
  for (const ms of Object.values(LIVE_SHARE_FRESH_MS)) assert.ok(LIVE_SHARE_TTL_SEC * 1000 > ms);
  assert.notEqual(liveShareKey("a", "players"), liveShareKey("b", "players"));
  assert.notEqual(liveShareKey("a", "players"), liveShareKey("a", "session"));
});
