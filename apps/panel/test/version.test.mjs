// The stale-tab handshake: a phone left on the panel for days keeps running whatever bundle it
// loaded, polling a NEW api with OLD code — which looks exactly like "the update didn't land".
// The banner fires only when both sides carry a stamp and disagree; an unstamped side (dev
// server, manual compose build, older API) must never nag, or the banner trains people to ignore it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleIsStale } from "../lib/version.ts";

test("the reload banner shows only for a real disagreement between two stamps", () => {
  assert.equal(bundleIsStale("20f49d9", "f074266"), true, "the tab is behind the server — say so");
  assert.equal(bundleIsStale("f074266", "f074266"), false, "same commit, nothing to do");
  assert.equal(bundleIsStale(null, "f074266"), false, "an unstamped bundle (dev) proves nothing");
  assert.equal(bundleIsStale("f074266", null), false, "an unstamped server proves nothing");
  assert.equal(bundleIsStale(null, null), false);
  assert.equal(bundleIsStale("f074266", undefined), false, "an api that predates the field proves nothing");
});
