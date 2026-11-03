/**
 * The worker's loops that tell players a time or count their days ask for the server's zone — its
 * own Auto settings one, else the community's (@app/db serverTimezone, whose own tests cover what
 * it answers). Both live inside the worker's loops, which a test cannot start, so this reads the
 * source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("the seed reward's VIP date and play-days attendance use the server's zone, not Auto settings alone", () => {
  assert.match(src, /const rewardTz = roundRewards\.length && payHours > 0 \? await serverTimezone\(repo, server\.id\) : null;/, "the seed reward message");
  assert.match(src, /const tz = await serverTimezone\(repo, server\.id\);\n\s+const today = dayIn\(tz, now\);/, "play-days attendance");
  assert.doesNotMatch(src, /autosettings\.getConfig\([^)]*\)[^;\n]*\?\.timezone/, "no loop reads Auto settings' zone on its own");
});
