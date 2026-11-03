import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVoteWinner } from "../dist/index.js";

const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `map${i}`, name: `Map ${i}` }));

test("highest count wins", () => {
  const w = resolveVoteWinner(opts(3), [2, 5, 1]);
  assert.equal(w!.index, 1);
  assert.equal(w!.option.id, "map1");
  assert.equal(w!.count, 5);
  assert.equal(w!.noVotes, false);
});

test("ties break to the earliest option", () => {
  const w = resolveVoteWinner(opts(3), [4, 4, 1]);
  assert.equal(w!.index, 0);
});

test("no votes → first option, flagged", () => {
  const w = resolveVoteWinner(opts(3), [0, 0, 0]);
  assert.equal(w!.index, 0);
  assert.equal(w!.noVotes, true);
});

test("missing counts treated as zero", () => {
  const w = resolveVoteWinner(opts(3), [0, 3]); // only 2 counts for 3 options
  assert.equal(w!.index, 1);
  assert.equal(w!.count, 3);
});

test("no options → null", () => {
  assert.equal(resolveVoteWinner([], []), null);
});

test("the map in play cannot win while anything else is on the ballot", () => {
  const w = resolveVoteWinner(opts(3), [1, 5, 2], { exclude: "MAP1" });
  assert.equal(w!.option.id, "map2");
  assert.equal(w!.count, 2);
  assert.equal(w!.noVotes, false);
});

test("with no votes, the default pick skips the map in play", () => {
  const w = resolveVoteWinner(opts(3), [0, 0, 0], { exclude: "map0" });
  assert.equal(w!.option.id, "map1");
  assert.equal(w!.noVotes, true);
});

test("votes only for the map in play leave the default pick", () => {
  const w = resolveVoteWinner(opts(3), [0, 4, 0], { exclude: "map1" });
  assert.equal(w!.option.id, "map0");
  assert.equal(w!.noVotes, true);
});

test("an exclusion that matches nothing changes nothing", () => {
  const w = resolveVoteWinner(opts(3), [2, 5, 1], { exclude: "elsewhere" });
  assert.equal(w!.option.id, "map1");
  assert.equal(resolveVoteWinner(opts(2), [0, 0], { exclude: null })!.option.id, "map0");
});

test("a ballot of nothing but the excluded map is judged as it stands", () => {
  const one = [{ id: "solo", name: "Solo" }];
  assert.equal(resolveVoteWinner(one, [0], { exclude: "solo" })!.option.id, "solo");
});

// --- the result as a round ends (resolveRoundResult) ---
const ballot = [
  { id: "foy_warfare", name: "Foy" },
  { id: "omahabeach_warfare", name: "Omaha Beach" },
  { id: "kursk_warfare", name: "Kursk" },
];

test("round result: read on time — the leader, still to be queued", async () => {
  const { resolveRoundResult } = await import("../dist/index.js");
  const r = resolveRoundResult({ options: ballot, counts: [1, 4, 0], roundMap: "carentan_warfare", inPlay: "carentan_warfare" })!;
  assert.equal(r.winner.option.id, "omahabeach_warfare");
  assert.equal(r.alreadyInPlay, false);
});

test("round result: read after the leader loaded — the leader is the result, and is not queued again", async () => {
  const { resolveRoundResult } = await import("../dist/index.js");
  const r = resolveRoundResult({ options: ballot, counts: [1, 4, 0], roundMap: "carentan_warfare", inPlay: "OMAHABEACH_WARFARE" })!;
  assert.equal(r.winner.option.id, "omahabeach_warfare", "never the runner-up");
  assert.equal(r.winner.count, 4);
  assert.equal(r.alreadyInPlay, true);
});

test("round result: read late, but the final count moved — the new leader is queued behind the map that loaded", async () => {
  const { resolveRoundResult } = await import("../dist/index.js");
  const r = resolveRoundResult({ options: ballot, counts: [5, 4, 0], roundMap: "carentan_warfare", inPlay: "omahabeach_warfare" })!;
  assert.equal(r.winner.option.id, "foy_warfare");
  assert.equal(r.alreadyInPlay, false);
});

test("round result: a ballot carrying the map its round was played on cannot hand it the win", async () => {
  const { resolveRoundResult } = await import("../dist/index.js");
  const r = resolveRoundResult({ options: ballot, counts: [6, 2, 0], roundMap: "foy_warfare", inPlay: "foy_warfare" })!;
  assert.equal(r.winner.option.id, "omahabeach_warfare");
  assert.equal(r.alreadyInPlay, false);
});

test("round result: the round's map unknown — the map in play stands in for it, as before", async () => {
  const { resolveRoundResult } = await import("../dist/index.js");
  const r = resolveRoundResult({ options: ballot, counts: [0, 0, 0], roundMap: null, inPlay: "foy_warfare" })!;
  assert.equal(r.winner.option.id, "omahabeach_warfare");
  assert.equal(r.winner.noVotes, true);
  assert.equal(r.alreadyInPlay, false);
  assert.equal(resolveRoundResult({ options: [], counts: [] }), null);
});

test("the exclusion matches a map id whatever its case or stray spaces, as the replay guard's does", async () => {
  const { replayGuardPick } = await import("../dist/index.js");
  const spaced = [{ id: " carentan_warfare ", name: "Carentan" }, { id: "foy_warfare", name: "Foy" }];
  assert.equal(resolveVoteWinner(spaced, [5, 0], { exclude: "CARENTAN_WARFARE" })!.option.id, "foy_warfare");
  assert.equal(resolveVoteWinner(spaced, [5, 0], { exclude: "  " })!.option.id, " carentan_warfare ", "a blank exclusion bars nothing");
  // The two now agree: the guard gets the other option rather than nothing.
  assert.equal(replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: spaced, tallies: [5, 0] }), "foy_warfare");
});
