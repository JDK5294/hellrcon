/**
 * The panel names no community. It was built for one first, and that community's name, clan tag,
 * domain and currency showed through as examples, a Help note and a search word: another community
 * running it would read someone else's name in its own panel. Checked on the BUILT panel, the text
 * a browser actually gets, word by word against SHA-256 fingerprints, so this file names nobody.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const SKIP = existsSync(join(OUT, "index.html")) ? false : "panel not built (out/ missing)";

/** Words that are that community's, in any case: its name and domain, and its tag in small capitals. */
const ANY_CASE = new Set([
  "399e946a6df46ba43e7e31bbd1a72a50ef363f419f225c3956cec88bd332f2e4",
  "6b0dd3e234e3e1a7d87dcefe255e74cc568fdafbd3333a44d79a1c60e2fd165e",
  "acb74c01fbce32f77f83b1ad7907bed9168ec5f37575eec1cff8e10f33b41a64",
  "36ca17332330fb641c0a7f9bacf8e1cfb687a95f4b1f94b6d0f13395c03a7918",
  "ee1d2c1036b1348b3d077a8badd37a37b93954c18b41ed2e9c72d8ce3781aa25",
]);
/** Its tag in capitals, exactly: in lower case those three letters turn up in minified code by chance. */
const EXACT = new Set(["6c2319fe488b053aa097d641852ab7edc1596fdaea46f52e1bed76d4e16cd9d1"]);
/** Its currency's two-word name, and that name's first word, so only those pairs are hashed. */
const PAIRS = new Set(["bfeda11c5ad033721ff760062a65eb77fd05fcdbd769f2e98bed864216bdbe53"]);
const PAIR_FIRST = new Set(["14ea6507645c2ba7e973ea87444bf0470fc2e1f4b64f4f692f736acf9a4dec8a"]);

const seen = new Map();
const sha = (s) => {
  let h = seen.get(s);
  if (h === undefined) { h = createHash("sha256").update(s).digest("hex"); seen.set(s, h); }
  return h;
};

/** The community words in `text`, styling folded the way a reader's eye folds it: 𝔸𝔹ℂ, A.B.C. */
export function communityMentions(text) {
  const folded = text.normalize("NFKC").replace(/(?<![\p{L}\p{N}])\p{L}(?:\.\p{L})+(?![\p{L}\p{N}])/gu, (m) => m.replaceAll(".", ""));
  const words = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
  const found = new Set();
  for (let i = 0; i < words.length; i++) {
    const w = words[i], lower = w.toLowerCase();
    if (ANY_CASE.has(sha(lower)) || EXACT.has(sha(w))) found.add(w);
    if (i + 1 < words.length && PAIR_FIRST.has(sha(lower)) && PAIRS.has(sha(`${lower} ${words[i + 1].toLowerCase()}`))) found.add(`${w} ${words[i + 1]}`);
  }
  return [...found];
}

test("the fingerprint check catches each form a name takes, and passes ordinary words", () => {
  // Built from parts so the words do not sit in this file whole.
  const name = ["da", "wg"].join(""), tag = ["T", "D", "D"].join("");
  for (const sample of [`[${name.toUpperCase()}] #1`, `the${name}division.com`, `-=${tag}=-`, `${tag.split("").join(".")} clan`, `Balance: 600 ${["Ba", "rk"].join("")} ${["Bu", "cks"].join("")}`]) {
    assert.equal(communityMentions(sample).length, 1, `caught in ${JSON.stringify(sample)}`);
  }
  // The tag in lower case is passed on purpose: minified code makes those three letters by chance.
  assert.deepEqual(communityMentions(`Points, [ABC] WW2 #1, ᴀʙᴄ, A.B.C, a ${tag.toLowerCase()} variable`), [], "neutral words pass");
});

test("the built panel names no community: not its name, tag, domain or currency", { skip: SKIP }, () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const files = walk(OUT).filter((f) => /\.(js|html|json|txt|css|webmanifest)$/.test(f));
  assert.ok(files.some((f) => f.endsWith(".js")), "the walk found the panel's scripts");
  const found = files.flatMap((f) => communityMentions(readFileSync(f, "utf8")).map((w) => `${relative(OUT, f)}: ${w}`));
  assert.deepEqual(found, []);
});
