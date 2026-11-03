// Version history's "what this save changed", in words. A rule, a map set and a vote schedule are
// three shapes; the history list must read the same way for each, without anyone comparing two
// blobs of settings by eye.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnapshots } from "../lib/versionDiff.ts";

test("plain fields read old → new, with the screen's own labels and formatting", () => {
  const lines = diffSnapshots(
    { name: "TK kick", threshold: 2, action: "kick", dryRun: true, reason: "" },
    { name: "TK kick", threshold: 3, action: "tempban", dryRun: false, reason: "stop it" },
    { labels: { threshold: "Count", action: "Action", dryRun: "Trial run", reason: "Message" }, format: (p, v) => (p === "action" ? `[${String(v)}]` : undefined) },
  );
  assert.deepEqual(lines.map((l) => `${l.label}: ${l.text}`), [
    "Action: [kick] → [tempban]",
    "Trial run: on → off",
    "Message: (none) → “stop it”",
    "Count: 2 → 3",
  ]);
});

test("lists of values read as what came and went; order alone says so", () => {
  const [maps] = diffSnapshots({ maps: ["foy", "kursk", "omaha"] }, { maps: ["foy", "omaha", "carentan"] }, { labels: { maps: "Maps" } });
  assert.equal(maps.label, "Maps");
  assert.equal(maps.text, "added “carentan”; removed “kursk”");
  assert.equal(diffSnapshots({ maps: ["a", "b"] }, { maps: ["b", "a"] })[0].text, "order changed");
  assert.equal(diffSnapshots({ maps: [] }, { maps: ["a"] })[0].text, "added “a”");
});

test("nested settings read by path, numbered from one; empty and missing are the same nothing", () => {
  const lines = diffSnapshots(
    { pool: { modeBuckets: [{ mode: "warfare", count: 3, maps: ["foy"] }, { mode: "offensive", count: 1 }] } },
    { pool: { modeBuckets: [{ mode: "warfare", count: 4, maps: ["foy"] }, { mode: "offensive", count: 1 }] } },
    { labels: { pool: "Maps", modeBuckets: "Mode buckets", count: "How many" } },
  );
  assert.deepEqual(lines.map((l) => [l.path, l.label, l.text]), [["pool.modeBuckets.0.count", "Maps › Mode buckets › 1 › How many", "3 → 4"]]);
  assert.deepEqual(diffSnapshots({ tags: [], note: null }, { note: "" }), [], "[] / null / \"\" / missing all read as none");
});

test("ignored keys are not part of the story; a made or deleted record diffs against nothing", () => {
  assert.deepEqual(diffSnapshots({ enabled: true, name: "a" }, { enabled: false, name: "a" }, { ignore: ["enabled"] }), []);
  const deleted = diffSnapshots({ name: "Friday" }, null);
  assert.deepEqual(deleted.map((l) => l.text), ["“Friday” → (none)"]);
  assert.ok(diffSnapshots({ reason: "x".repeat(300) }, { reason: "y" })[0].text.length < 200, "a long value is clipped");
});
