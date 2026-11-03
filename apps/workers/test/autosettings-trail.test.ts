/**
 * A profile that applies a template keeps, on its record, what the template replaced and what it
 * set: the staff trail reads both to say what changed, setting by setting (apps/api
 * audit-changes). The loop that applies it is not a module of its own, so this reads its source,
 * as the match messages test does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("a profile applying a template records what it replaced, read before the write and copied, and what it set", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");
  const at = src.indexOf('action: "autosettings.template"');
  assert.ok(at > 0, "the apply is on the record");
  const block = src.slice(src.lastIndexOf("templateAppliedAt.set(", at), src.indexOf("}).catch(", at));
  const read = block.indexOf("await repo.autosettings.getConfig(server.id)");
  const write = block.indexOf("await repo.autosettings.upsertConfig(server.id, applied)");
  assert.ok(read > 0 && write > read, "what it replaces is read before the write");
  assert.match(block, /const before = JSON\.parse\(JSON\.stringify\(\{ timezone: was\?\.timezone \?\? config\.timezone, profiles: was\?\.profiles \?\? \[\] \}\)\)/,
    "and copied: a store that hands back its own row would otherwise show the new settings as the old ones");
  assert.ok(block.includes("data: { profile: active.name, template: tpl.name, profiles: tpl.config.profiles.length, before, after: applied }"), "both on the record");
});
