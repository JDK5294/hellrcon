// New walkthroughs (lib/walkNotice): which walkthroughs a person's new permissions opened, judged
// against what the account kept from the last check — never a walkthrough new to the panel itself,
// which What's new tells everyone about, and never the wider view an open request lends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lockedNow, newlyTheirs, walkCheckKey } from "../lib/walkNotice.ts";
import { WALKTHROUGHS, walkthroughsFor } from "../lib/walkthroughs.ts";

const g = (capability, level = "write", extra = {}) => ({ capability, scopeType: "global", scopeId: null, level, ...extra });
const ids = (grants) => walkthroughsFor(grants).map((w) => w.id);
const ALL = WALKTHROUGHS.map((w) => w.id);

test("a check is made again when the permissions or the build change, and only then", () => {
  const kicker = [g("server.view", "read"), g("action.kick")];
  assert.equal(walkCheckKey(kicker, 24), walkCheckKey([...kicker].reverse(), 24), "the order they come in says nothing");
  assert.notEqual(walkCheckKey(kicker, 24), walkCheckKey([...kicker, g("action.punish")], 24), "a permission given");
  assert.notEqual(walkCheckKey(kicker, 24), walkCheckKey([g("server.view", "read"), g("action.kick", "read")], 24), "a level changed");
  assert.notEqual(walkCheckKey(kicker, 24), walkCheckKey(kicker, 25), "an update");
  assert.equal(walkCheckKey(kicker, 24), walkCheckKey([...kicker, g("action.ban", "write", { source: "request-view" })], 24), "a request's wider view is not theirs");
});

test("the walkthroughs newly someone's are the ones their new permissions opened", () => {
  const kicker = [g("server.view", "read"), g("action.kick")];
  const before = { for: walkCheckKey(kicker, 24), locked: lockedNow(ALL, ids(kicker)) };
  assert.ok(!before.locked.includes("kick-player") && before.locked.includes("punish-player"));
  // Given punishing: its walkthrough, and nothing they could follow already.
  assert.deepEqual(newlyTheirs(before, ids([...kicker, g("action.punish")])), ["punish-player"]);
  // Nothing given: nothing new.
  assert.deepEqual(newlyTheirs(before, ids(kicker)), []);
  // A walkthrough the panel did not have at the last check is not theirs to be told about here.
  assert.deepEqual(newlyTheirs({ ...before, locked: before.locked.filter((id) => id !== "punish-player") }, ids([...kicker, g("action.punish")])), []);
  // Taken away, then given back: told again, since the check after it kept it locked.
  const without = lockedNow(ALL, ids(kicker));
  assert.deepEqual(newlyTheirs({ for: "x", locked: without }, ids([...kicker, g("action.punish")])), ["punish-player"]);
});
