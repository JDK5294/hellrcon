import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pollMapWatchStep } from "../dist/mapvote-watch.js";

/*
 * Field report: a poll posted at 5:54 sat "Active, 0 votes" until at least 9:24 — the Discord card
 * timed out on its own at 7:54 and no new vote followed. The vote learned of a match end only from
 * the log's MATCH ENDED line. These pin the second witness: the map in play.
 */
test("a map change seen on two checks running is a match end the log missed", () => {
  let w = pollMapWatchStep(null, { messageId: "poll1", mapKey: "foy_warfare", nowMs: 0 });
  assert.equal(w.rolledOverFrom, null, "the first look only notes the map");
  w = pollMapWatchStep(w.watch, { messageId: "poll1", mapKey: "foy_warfare", nowMs: 60_000 });
  assert.equal(w.rolledOverFrom, null, "same map, nothing to do");
  w = pollMapWatchStep(w.watch, { messageId: "poll1", mapKey: "omahabeach_warfare", nowMs: 120_000 });
  assert.equal(w.rolledOverFrom, null, "one sighting of a new map is not enough");
  w = pollMapWatchStep(w.watch, { messageId: "poll1", mapKey: "omahabeach_warfare", nowMs: 180_000 });
  assert.equal(w.rolledOverFrom, "foy_warfare", "confirmed: roll over, naming the map it left");
  assert.equal(w.watch, null);
});

test("one odd read in a map transition, or an unreadable map, throws nothing away", () => {
  let w = pollMapWatchStep(null, { messageId: "p", mapKey: "foy_warfare", nowMs: 0 });
  w = pollMapWatchStep(w.watch, { messageId: "p", mapKey: "omahabeach_warfare", nowMs: 1 });
  w = pollMapWatchStep(w.watch, { messageId: "p", mapKey: "foy_warfare", nowMs: 2 });
  assert.equal(w.watch!.changedTo, null, "back on the poll's map: the odd read is forgotten");
  w = pollMapWatchStep(w.watch, { messageId: "p", mapKey: "", nowMs: 3 });
  w = pollMapWatchStep(w.watch, { messageId: "p", mapKey: "", nowMs: 4 });
  assert.equal(w.rolledOverFrom, null);
  assert.equal(w.watch!.mapKey, "foy_warfare", "unreadable reads judge nothing");
  // A different map, then a THIRD map: each is its own first sighting.
  w = pollMapWatchStep(w.watch, { messageId: "p", mapKey: "a", nowMs: 5 });
  w = pollMapWatchStep(w.watch, { messageId: "p", mapKey: "b", nowMs: 6 });
  assert.equal(w.rolledOverFrom, null);
});

test("a new poll starts its own watch from the map in play", () => {
  let w = pollMapWatchStep(null, { messageId: "old", mapKey: "foy_warfare", nowMs: 0 });
  w = pollMapWatchStep(w.watch, { messageId: "new", mapKey: "omahabeach_warfare", nowMs: 1 });
  assert.equal(w.rolledOverFrom, null, "a different poll on a different map is simply a new watch");
  assert.equal(w.watch!.mapKey, "omahabeach_warfare");
});

test("the rollover never applies the old vote's winner (it would land a match late)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  const from = src.indexOf("--- a match that ended without MATCH ENDED reaching the log");
  // Bounded by the replay guard, which shares the rollover's session read but is not the rollover.
  const to = src.indexOf("--- the replay guard: while a vote is up, the next map is never the map in play ---");
  assert.ok(from > 0 && to > from, "the rollover block is in place, ahead of the replay guard");
  assert.ok(to < src.indexOf("--- keep the next map pointed at whatever is currently winning ---"), "and both ahead of live apply");
  const block = src.slice(from, to);
  assert.ok(!block.includes("scheduleNextMap("), "no end-of-match apply inside the rollover");
  assert.ok(block.includes('action: "mapvote.missedEnd"'), "the rollover is on the trail");
  assert.ok(block.includes("activeMessageId: null"), "and the stranded poll is cleared so a fresh one opens");
});
