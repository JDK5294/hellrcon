import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleNextMap, type RotationIO } from "../dist/index.js";

/** In-memory rotation that records the add/remove calls, mirroring the 502 behaviour. */
function fakeIO(initial: string[], currentIndex = 0) {
  const maps = [...initial];
  const calls: string[] = [];
  /** What the port was TOLD to remove, per call — the legacy wire has only this to go on. */
  const namedRemovals: { index: number; told: string | undefined; actual: string | undefined }[] = [];
  const io: RotationIO = {
    async getRotation() { return { maps: [...maps], currentIndex }; },
    async addMapToRotation(mapId, index) { maps.splice(index, 0, mapId); calls.push(`add ${mapId}@${index}`); },
    async removeMapFromRotation(index, mapId) {
      const actual = maps[index];
      namedRemovals.push({ index, told: mapId, actual });
      const [m] = maps.splice(index, 1);
      calls.push(`rm ${m}@${index}`);
    },
  };
  return { io, maps, calls, namedRemovals };
}

test("collapses a multi-map rotation down to the winner", async () => {
  const { io, maps, calls } = fakeIO(["mapA", "mapB", "mapC"]);
  const r = await scheduleNextMap(io, "winner");
  assert.deepEqual(maps, ["winner"]);
  assert.deepEqual(r.rotationMaps, ["winner"]);
  assert.equal(r.verifiedOnly, false);
  // remove idx1 twice (B, C) → add winner@1 → remove idx0 (mapA)
  assert.deepEqual(calls, ["rm mapB@1", "rm mapC@1", "add winner@1", "rm mapA@0"]);
});

test("no-op when the rotation is already just the winner", async () => {
  const { io, maps, calls } = fakeIO(["winner"]);
  const r = await scheduleNextMap(io, "winner");
  assert.equal(r.verifiedOnly, true);
  assert.deepEqual(maps, ["winner"]);
  assert.deepEqual(calls, []);
});

test("adds to an empty rotation", async () => {
  const { io, maps } = fakeIO([]);
  const r = await scheduleNextMap(io, "winner");
  assert.deepEqual(maps, ["winner"]);
  assert.equal(r.verifiedOnly, false);
});

test("two-map rotation collapses correctly", async () => {
  const { io, maps, calls } = fakeIO(["a", "b"]);
  await scheduleNextMap(io, "z");
  assert.deepEqual(maps, ["z"]);
  assert.deepEqual(calls, ["rm b@1", "add z@1", "rm a@0"]);
});

test("throws (does not silently pass) if verification fails", async () => {
  // A broken IO whose removes don't take effect → final rotation won't equal [winner].
  const maps = ["a", "b"];
  const io: RotationIO = {
    async getRotation() { return { maps: [...maps], currentIndex: 0 }; },
    async addMapToRotation() { /* drop */ },
    async removeMapFromRotation() { /* drop */ },
  };
  await assert.rejects(() => scheduleNextMap(io, "winner"), /verification failed/i);
});

test("every removal names the entry standing at that index — the legacy wire has nothing else", async () => {
  /*
   * binary-v2 removes a rotation entry by index; legacy text removes it by name ("rotdel <map>").
   * The port carried only the index, so on a legacy server every removal here went out as a bare
   * `rotdel` and took nothing off the rotation — the collapse then failed verification, and a vote
   * could not queue its own winner at all.
   */
  const { io, namedRemovals } = fakeIO(["mapA", "mapB", "mapC"]);
  await scheduleNextMap(io, "winner");

  assert.deepEqual(
    namedRemovals.map((r) => `${r.told}@${r.index}`),
    ["mapB@1", "mapC@1", "mapA@0"],
    "the name given must be the entry that was actually at that index",
  );
  for (const r of namedRemovals) {
    assert.equal(r.told, r.actual, `removal at ${r.index} named ${r.told} but ${r.actual} was there`);
  }
});

test("replayQueued: a rotation of only the map in play replays it", async () => {
  const { replayQueued } = await import("../dist/index.js");
  assert.equal(replayQueued({ maps: ["carentan_warfare"] }, "carentan_warfare"), true);
  assert.equal(replayQueued({ maps: ["CARENTAN_WARFARE"] }, "carentan_warfare"), true, "case does not matter");
  assert.equal(replayQueued({ maps: ["carentan_warfare", "carentan_warfare"] }, "carentan_warfare"), true);
});

test("replayQueued: any other map in the rotation, or an unknown map in play, is not a replay", async () => {
  const { replayQueued } = await import("../dist/index.js");
  assert.equal(replayQueued({ maps: ["stmariedumont_warfare"] }, "carentan_warfare"), false);
  assert.equal(replayQueued({ maps: ["carentan_warfare", "omaha_warfare"] }, "carentan_warfare"), false);
  assert.equal(replayQueued({ maps: [] }, "carentan_warfare"), false);
  assert.equal(replayQueued({ maps: ["carentan_warfare"] }, null), false);
  assert.equal(replayQueued({ maps: ["carentan_warfare"] }, "  "), false);
});

/*
 * Field report: Carentan played at 3:12, 4:11 and 5:44, and St Marie Du Mont twice in a row the
 * next morning — the vote applied nothing for those rounds, and the rotation it had collapsed to
 * the last winner simply played it again. The guard's decision, pinned.
 */
const ballot = [
  { id: "stmariedumont_warfare", name: "St Marie Du Mont" },
  { id: "omahabeach_warfare", name: "Omaha Beach" },
  { id: "foy_warfare", name: "Foy" },
];

test("replayGuardPick: nobody voted — the default pick replaces the replay", async () => {
  const { replayGuardPick } = await import("../dist/index.js");
  assert.equal(
    replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: ballot, tallies: [0, 0, 0] }),
    "stmariedumont_warfare",
  );
  // A fallback with no vote up passes no tallies at all.
  assert.equal(replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: ballot }), "stmariedumont_warfare");
});

test("replayGuardPick: with votes, the leader", async () => {
  const { replayGuardPick } = await import("../dist/index.js");
  assert.equal(
    replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: ballot, tallies: [1, 0, 3] }),
    "foy_warfare",
  );
});

test("replayGuardPick: a rotation already moving on is left alone", async () => {
  const { replayGuardPick } = await import("../dist/index.js");
  // The vote's result was applied and has not loaded yet: the map in play is the one ending.
  assert.equal(replayGuardPick({ rotation: { maps: ["foy_warfare"] }, inPlay: "carentan_warfare", options: ballot }), null);
  assert.equal(replayGuardPick({ rotation: { maps: ["carentan_warfare", "foy_warfare"] }, inPlay: "carentan_warfare", options: ballot }), null);
  // Nobody can say what is in play: nothing is judged.
  assert.equal(replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: null, options: ballot }), null);
});

test("replayGuardPick: never queues the map in play, even when the ballot carries it", async () => {
  const { replayGuardPick } = await import("../dist/index.js");
  const carrying = [{ id: "carentan_warfare", name: "Carentan" }, ...ballot];
  assert.equal(
    replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: carrying, tallies: [9, 0, 0, 0] }),
    "stmariedumont_warfare",
  );
  // Nothing else to queue: no pick rather than the replay.
  assert.equal(
    replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: [{ id: "carentan_warfare", name: "Carentan" }] }),
    null,
  );
  assert.equal(replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: [] }), null);
});

test("replayGuardPick: a staff override wins, and an override onto the map in play is left as asked", async () => {
  const { replayGuardPick } = await import("../dist/index.js");
  assert.equal(
    replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: ballot, tallies: [0, 0, 5], overrideMapId: "kursk_warfare" }),
    "kursk_warfare",
  );
  assert.equal(
    replayGuardPick({ rotation: { maps: ["carentan_warfare"] }, inPlay: "carentan_warfare", options: ballot, overrideMapId: "CARENTAN_WARFARE" }),
    null,
  );
});
