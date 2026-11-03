/**
 * The source check (scripts/check-naming.mjs) reads the names it keeps out of the program from a
 * word list of its own, which the public copy does not carry: it holds them, says where they may
 * appear, and the check skips its name rules where the list is absent. These run the real script
 * on a small tree made up here, with a word list made up here too, so no real name is in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "check-naming.mjs");
const fp = (s: string) => createHash("sha256").update(s).digest("hex");

/** A tree to check: every file under it, by path from its root. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "source-check-"));
  for (const [path, text] of Object.entries({ "NOTICE.md": "# Third-party notices\n", ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const check = (root: string) => spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });

/** The word list, as the private copy writes it: a banned brand, a community's name and its two-word currency. */
const WORDS = `export const banned = ["acmebrand"];
export const allowedIn = ["notes/internal/", "scripts/private/"];
export const communityWords = [${JSON.stringify(fp("zorblax"))}];
export const communityPairs = [${JSON.stringify(fp("glim glam"))}];
export const communityPairFirst = [${JSON.stringify(fp("glim"))}];
`;

test("the word list keeps its names out everywhere but where it allows them, and catches a name split over two lines", () => {
  const root = tree({
    "scripts/private/naming-words.mjs": WORDS,
    "src/feature.ts": "// Works like acmebrand's panel.\nexport const x = 1;\n",
    "notes/internal/research.md": "# acmebrand\n\nNotes on acmebrand.\n",
    "docs/economy.md": "Members spend\nGlim\nGlam on VIP.\n",
    "docs/about.md": "Built for the Z.O.R.B.L.A.X community.\n",
    "docs/fine.md": "Glimmering glamour, and a glim of something else.\n",
  });
  const r = check(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /src\/feature\.ts:1 {2}\[acmebrand\]/, "a banned name outside the allowed paths");
  assert.doesNotMatch(r.stderr, /notes\/internal\/research\.md/, "the allowed notes may name it");
  assert.match(r.stderr, /docs\/economy\.md:2\n/, "the two-word name wrapped over a line break, at the line it starts on");
  assert.match(r.stderr, /docs\/about\.md:1\n/, "dotted initials fold into the word");
  assert.doesNotMatch(r.stderr, /docs\/fine\.md/, "only the pair is the name, not each of its words");
  assert.doesNotMatch(r.stderr + r.stdout, /zorblax|glim glam/i, "the report gives lines, never the names");
});

test("a copy without the word list checks everything else and says the names went unchecked", () => {
  const clean = check(tree({ "src/feature.ts": "// Works like acmebrand's panel.\n", "docs/economy.md": "Glim\nGlam\n" }));
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /names not checked, as this copy has no word list/);
  const control = check(tree({ "src/feature.ts": "export const sep = \"a\u0001b\";\n" }));
  assert.equal(control.status, 1, "the other rules still run");
  assert.match(control.stderr, /src\/feature\.ts:1 {2}\[\\u0001\]/);
});
