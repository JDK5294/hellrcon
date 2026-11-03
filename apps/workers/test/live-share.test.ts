/**
 * The worker's reads of a server's session, roster and rotation, also left for the panel's Live
 * page (live-share.ts), which answers from them instead of opening a game connection of its own on
 * every refresh. A read is unchanged for the worker: the same value comes back, and a failed read
 * throws as it did and leaves nothing behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InProcessEventBus } from "@app/bus";
import { LIVE_ROTATION_SHARE_MS, liveShareKey } from "@app/shared";
import { liveShareAgeMs, shareLiveReadsOn, shareRotationIfDue, sharingLiveReads } from "../dist/live-share.js";

/** A game client whose reads answer from `answers` (a function throws instead), counting each. */
function fakeClient(answers: Record<string, unknown>) {
  const reads: string[] = [];
  return {
    reads,
    async readState(kind: string): Promise<unknown> {
      reads.push(kind);
      const a = answers[kind];
      if (typeof a === "function") throw (a as () => Error)();
      return a;
    },
  };
}

test("live share: the session, roster and rotation the worker reads are left for the Live page, as read", async () => {
  const bus = new InProcessEventBus();
  shareLiveReadsOn(bus);
  try {
    const roster = [{ name: "A", iD: "1" }];
    const client = sharingLiveReads(fakeClient({ players: roster, session: { map: "foy" }, maprotation: ["foy"], objectives: [1, 2] }), "ls-1");
    const before = Date.now();
    assert.equal(await client.readState("players"), roster, "the worker gets the game's own answer back");
    await client.readState("session");
    await client.readState("maprotation");
    await client.readState("objectives");
    const shared = (await bus.recall(liveShareKey("ls-1", "players"))) as { at: number; value: unknown };
    assert.deepEqual(shared.value, roster);
    assert.ok(shared.at >= before && shared.at <= Date.now(), "stamped with when it was read");
    assert.deepEqual(((await bus.recall(liveShareKey("ls-1", "session"))) as { value: unknown }).value, { map: "foy" });
    assert.deepEqual(((await bus.recall(liveShareKey("ls-1", "maprotation"))) as { value: unknown }).value, ["foy"]);
    assert.equal(await bus.recall("live:ls-1:objectives"), null, "only what the Live page shows is shared");
    assert.equal(await bus.recall(liveShareKey("ls-other", "players")), null, "under this server's name only");
    assert.ok(liveShareAgeMs("ls-1", "players") < 1000);
  } finally {
    shareLiveReadsOn(null);
  }
});

test("live share: a failed read throws as before and leaves nothing behind", async () => {
  const bus = new InProcessEventBus();
  shareLiveReadsOn(bus);
  try {
    const client = sharingLiveReads(fakeClient({ players: () => new Error("connection lost") }), "ls-2");
    await assert.rejects(client.readState("players"), /connection lost/);
    assert.equal(await bus.recall(liveShareKey("ls-2", "players")), null);
    assert.equal(liveShareAgeMs("ls-2", "players"), Infinity);
  } finally {
    shareLiveReadsOn(null);
  }
});

test("live share: nothing is shared while sharing is off, and the reads still answer", async () => {
  const client = sharingLiveReads(fakeClient({ players: [] }), "ls-3");
  assert.deepEqual(await client.readState("players"), []);
  assert.equal(liveShareAgeMs("ls-3", "players"), Infinity);
  await shareRotationIfDue(client, "ls-3");
  assert.deepEqual(client.reads, ["players"], "no rotation read nobody can be shown");
});

test("live share: the rotation, which no loop reads on a schedule, is read every half minute", async (t) => {
  const bus = new InProcessEventBus();
  shareLiveReadsOn(bus);
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  try {
    const client = sharingLiveReads(fakeClient({ maprotation: ["foy", "kursk"] }), "ls-4");
    await shareRotationIfDue(client, "ls-4");
    assert.deepEqual(client.reads, ["maprotation"], "the first pass reads it");
    t.mock.timers.tick(LIVE_ROTATION_SHARE_MS - 1);
    await shareRotationIfDue(client, "ls-4");
    assert.equal(client.reads.length, 1, "not again inside half a minute");
    t.mock.timers.tick(1);
    await shareRotationIfDue(client, "ls-4");
    assert.equal(client.reads.length, 2, "and again once it is half a minute old");
    // A read the worker made for its own reasons counts: no second read right after it.
    t.mock.timers.tick(LIVE_ROTATION_SHARE_MS);
    await client.readState("maprotation");
    await shareRotationIfDue(client, "ls-4");
    assert.equal(client.reads.length, 3);

    // A protocol with no rotation: the page shows none, as when its own read of it fails.
    const bare = sharingLiveReads(fakeClient({ maprotation: () => new Error("not exposed") }), "ls-5");
    await shareRotationIfDue(bare, "ls-5");
    assert.deepEqual(await bus.recall(liveShareKey("ls-5", "maprotation")), { at: 1_800_000_000_000 + 2 * LIVE_ROTATION_SHARE_MS, value: null });
    await shareRotationIfDue(bare, "ls-5");
    assert.equal(bare.reads.length, 1, "and is not asked again on every pass");
  } finally {
    shareLiveReadsOn(null);
  }
});
