/**
 * The profile timeline draws watch spells from watch_history, so the audit rows for the same acts
 * must be filtered out — ALL of them. This holds the panel's filter to what the API actually
 * writes: a watchlist audit action the API starts using and the panel does not know about comes
 * back as a duplicate row on every profile, a second apart from the real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WATCH_AUDIT_ACTIONS, isWatchAudit } from "../lib/watchAudit.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("both watchlist audit actions are filtered, and ordinary moderation is not", () => {
  // Reason work files under player.watchlist; flipping the flag (the ⋯ menu's removal, and the
  // same decision executed off an approval) files under player.flags.
  assert.equal(isWatchAudit("player.watchlist"), true);
  assert.equal(isWatchAudit("player.flags"), true);
  for (const keep of ["player.tempban", "player.kick", "player.tag", "player.tag_remove", "player.link", "player.vippause", "enforcer.punish"]) {
    assert.equal(isWatchAudit(keep), false, `${keep} belongs in the timeline`);
  }
});

test("the API writes no watchlist audit action the panel does not filter", () => {
  const sources = ["../../api/src/routes/players.ts", "../../api/src/approvals.ts"]
    .map((rel) => readFileSync(join(here, rel), "utf8"));
  const found = new Set();
  for (const src of sources) {
    // Every audit.create in these files is written as an object literal whose `action:` comes
    // first and whose `summary:` follows within a few lines. A row whose summary talks about the
    // watchlist is a row the watch_history panel already tells the story of.
    for (const m of src.matchAll(/action:\s*"(player\.[a-z_]+)"[\s\S]{0,600}?summary:\s*(`[^`]*`|"[^"]*")/g)) {
      if (/watchlist|watch reason/i.test(m[2])) found.add(m[1]);
    }
  }
  // Sanity: the scan has to actually see the watchlist writes, or it proves nothing.
  assert.ok(found.size >= 2, `expected the scan to find the watchlist audit writes, saw ${[...found].join(", ") || "none"}`);
  for (const action of found) {
    assert.ok(WATCH_AUDIT_ACTIONS.includes(action), `${action} writes watchlist summaries but the profile timeline still prints it beside the watch_history row`);
  }
});
