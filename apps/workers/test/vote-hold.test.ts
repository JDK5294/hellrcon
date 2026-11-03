import { test } from "node:test";
import assert from "node:assert/strict";
import { clearLapsedVoteHold } from "../dist/vote-hold.js";

test("the vote loop clears a lapsed hold only while it is still the one it read", async () => {
  let cleared = 0;
  const io = (stored: string | null | (() => never)) => ({
    read: async () => (typeof stored === "function" ? stored() : stored),
    clear: async () => { cleared++; },
  });
  assert.equal(await clearLapsedVoteHold("t1", io("t1")), null);
  assert.equal(cleared, 1, "unchanged since the snapshot: cleared");
  assert.equal(await clearLapsedVoteHold("t1", io("t2")), "t2", "extended mid-tick: the extension survives");
  assert.equal(cleared, 1);
  assert.equal(await clearLapsedVoteHold("t1", io(() => { throw new Error("db blinked"); })), "t1", "a failed re-read clears nothing");
  assert.equal(cleared, 1);
});
