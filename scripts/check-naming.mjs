#!/usr/bin/env node
// Source-hygiene gate. One walk of the tree, several rules:
//
//   1. Names kept out: other products' brand names appear nowhere but the paths the word list
//      allows. The list lives in scripts/private/naming-words.mjs with rule 4's, outside the
//      public copy; a copy without it skips both rules, since a list of names in a check is itself
//      a list anyone can read.
//   2. No raw control characters in source. A literal NUL (or other C0 byte) embedded in a string
//      is legal TypeScript and compiles fine, but it makes the file "binary" to grep, sed, diff and
//      some editors — GNU grep prints "binary file matches" and suppresses the matching lines, so
//      the file silently drops out of text searches over the repo. packages/db/src/postgres.ts had
//      three, used as a composite-key separator, while a fourth site in the same file wrote the
//      same separator as an escape. Escapes produce the identical byte at runtime and keep
//      the source searchable, so the escape is the form we keep.
//
// Kept as one script (and one `pnpm check:naming` task, which CI and the docs already reference)
// rather than two that walk the same tree.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

/** Rules 1 and 4's word list: banned names, where they may appear, and the community's fingerprints. */
const WORDS_FILE = join(ROOT, "scripts", "private", "naming-words.mjs");
const words = existsSync(WORDS_FILE) ? await import(pathToFileURL(WORDS_FILE).href) : null;
/** A path as the word list writes it: from the root, forward slashes. */
const posix = (rel) => rel.split(sep).join("/");

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "out",
  ".turbo",
  "data",
]);

// Only scan text-ish source/doc files.
const SCAN_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".yml", ".yaml", ".bat", ".sh",
  ".env", ".example", ".sql", ".prisma", ".html", ".css",
]);

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (IGNORE_DIRS.has(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXT.has(extOf(entry)) || entry.startsWith(".env")) {
      out.push(rel);
    }
  }
}

const files = [];
walk(ROOT, files);

const banned = words?.banned ?? [];
const allowedIn = words?.allowedIn ?? [];
const pattern = banned.length ? new RegExp(`\\b(${banned.join("|")})\\b`, "i") : null;
const violations = [];
const controlChars = [];

/**
 * C0 control characters plus DEL, minus the three that legitimately appear in text (tab, LF, CR).
 * Built from char codes rather than written as a literal class, so this file cannot contain the
 * very bytes it exists to reject.
 */
const CONTROL_CODES = (() => {
  const out = [];
  for (let c = 0; c <= 31; c++) if (c !== 9 && c !== 10 && c !== 13) out.push(c);
  out.push(127);
  return out;
})();
const CLASS = "[" + CONTROL_CODES.map((c) => "\\u" + c.toString(16).padStart(4, "0")).join("") + "]";
const CONTROL = new RegExp(CLASS);
const CONTROL_G = new RegExp(CLASS, "g");
/** Name the byte in the report — an escape is far easier to act on than an invisible gap. */
const describe = (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;

for (const rel of files) {
  const allowed = allowedIn.some((a) => posix(rel).startsWith(a));
  const text = readFileSync(join(ROOT, rel), "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (pattern && !allowed) {
      const m = line.match(pattern);
      if (m) violations.push({ rel, line: i + 1, term: m[1], text: line.trim().slice(0, 120) });
    }
    // The word list's allowed paths do not apply here — a control character is never wanted, in any file.
    const c = line.match(CONTROL);
    if (c) {
      controlChars.push({
        rel, line: i + 1, ch: describe(c[0]),
        // Strip them from the excerpt, or the report itself becomes unreadable in a terminal.
        text: line.replace(CONTROL_G, "?").trim().slice(0, 120),
      });
    }
  });
}

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error("A name this project keeps out of its code, UI and public docs:\n");
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  [${v.term}]  ${v.text}`);
  }
  console.error(`\n${violations.length} line(s). The word list (${posix(relative(ROOT, WORDS_FILE))}) says where these names may appear.`);
}

if (controlChars.length > 0) {
  failed = true;
  console.error("\nRaw control character(s) in source — write the escape instead, so the file stays searchable:\n");
  for (const c of controlChars) {
    console.error(`  ${c.rel}:${c.line}  [${c.ch}]  ${c.text}`);
  }
  console.error(`\n${controlChars.length} occurrence(s). The escape compiles to the same byte; a literal one makes the file "binary" to grep.`);
}

/*
 * 3. Credit (NOTICE.md). Someone else's code or data says whose it is, where it sits:
 *   - every file NOTICE.md lists under a project names that project's copyright holder in its own
 *     text, and the licence file the section points at exists and names the holder too;
 *   - a source file whose OPENING comment cites CRCON's Python source (rcon/….py, rconweb/….py)
 *     carries CRCON's credit, unless it is listed below as holding none of CRCON's code.
 *     That is the shape every port here has taken, so a new one cannot land without its credit.
 */
const NOTICE = "NOTICE.md";
const CRCON_HOLDER = "Julien Marechal";
/** Files whose opening comment names an rcon/….py path while holding none of CRCON's code. Each
 *  was read and judged; add to this list only the same way. */
const NOT_CRCON_CODE = new Set([
  join("apps", "workers", "src", "score-check.ts"), // cites CRCON's loop cadence, one number
  join("packages", "db", "src", "seeding-message.ts"), // cites CRCON's template token names
  join("packages", "maps", "src", "hll-maps.ts"), // the owner's own bot's rcon/client.py, not CRCON's
]);
const credit = [];
const noticeText = readFileSync(join(ROOT, NOTICE), "utf8");
for (const section of noticeText.split(/^## /m).slice(1)) {
  // A section about material with a licence of its own names its holder first; one without
  // (game assets, ideas, the owner's own code) has nothing to check.
  const holder = /\*\*Copyright \(c\) (?:\d{4} )?([^·*]+?) · /.exec(section)?.[1]?.trim();
  if (!holder) continue;
  const name = section.split("\n")[0].trim();
  const licence = /Full licence text: `([^`]+)`/.exec(section)?.[1];
  let licenceText = "";
  try { licenceText = licence ? readFileSync(join(ROOT, licence), "utf8") : ""; } catch { /* reported below */ }
  if (!licenceText.includes(holder)) credit.push(`${NOTICE} (${name}): the licence file ${licence ? `${licence} is missing or does not name` : "is not named, so nothing names"} ${holder}`);
  for (const [, path] of section.matchAll(/^\| `([^`]+)` \|/gm)) {
    let st;
    try { st = statSync(join(ROOT, path)); } catch { credit.push(`${NOTICE} (${name}) lists ${path}, which does not exist`); continue; }
    if (st.isDirectory()) continue;
    if (!readFileSync(join(ROOT, path), "utf8").includes(holder)) credit.push(`${path}: carries ${name}'s material (${NOTICE}) but does not credit ${holder}`);
  }
}
const CITES_CRCON = /\b(?:rcon|rconweb)\/[\w/]+\.py\b/;
for (const rel of files) {
  if (![".ts", ".tsx"].includes(extOf(rel)) || rel.split(sep).includes("test") || NOT_CRCON_CODE.has(rel)) continue;
  const text = readFileSync(join(ROOT, rel), "utf8");
  if (!text.startsWith("/*")) continue;
  const opening = text.slice(0, text.indexOf("*/") + 2);
  if (CITES_CRCON.test(opening) && !opening.includes(CRCON_HOLDER)) {
    credit.push(`${rel}: its opening comment cites CRCON's source (${CITES_CRCON.exec(opening)[0]}) but carries no credit — add CRCON's (see ${NOTICE}), or list the file in NOT_CRCON_CODE if it holds none of CRCON's code`);
  }
}

if (credit.length > 0) {
  failed = true;
  console.error("\nCredit missing for someone else's code or data — see NOTICE.md:\n");
  for (const c of credit) console.error(`  ${c}`);
  console.error(`\n${credit.length} problem(s).`);
}

/*
 * 4. No community's own name. The program is for any community, so the one it was first built for
 *    appears nowhere in it: not its name, clan tag, domain or currency. The word list holds them as
 *    SHA-256 fingerprints of the lower-cased words, and the report gives the line, not the word.
 *    Styling is folded the way a reader's eye folds it (fullwidth and double-struck letters, A.B.C)
 *    before the words are taken, and a two-word name is caught across a line break too: a wrapped
 *    paragraph is still one sentence to whoever reads it.
 */
const COMMUNITY_WORDS = new Set(words?.communityWords ?? []);
const COMMUNITY_PAIRS = new Set(words?.communityPairs ?? []);
const COMMUNITY_PAIR_FIRST = new Set(words?.communityPairFirst ?? []);
const fingerprints = new Map();
const fingerprint = (s) => {
  let h = fingerprints.get(s);
  if (h === undefined) { h = createHash("sha256").update(s).digest("hex"); fingerprints.set(s, h); }
  return h;
};
const community = [];
for (const rel of files) {
  // An install's own settings (.env, never committed) rightly hold its own community's name; the
  // template they are made from is checked like any file, and so is test data.
  const base = rel.split(sep).at(-1);
  if (base.startsWith(".env") && !base.endsWith(".example")) continue;
  if (!COMMUNITY_WORDS.size && !COMMUNITY_PAIRS.size) break;
  // Every word of the file in order, each with its line, so a pair can span a line break.
  const seq = [];
  readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/).forEach((line, i) => {
    const folded = line.normalize("NFKC").replace(/(?<![\p{L}\p{N}])\p{L}(?:\.\p{L})+(?![\p{L}\p{N}])/gu, (m) => m.replaceAll(".", ""));
    for (const w of folded.match(/[\p{L}\p{N}]+/gu) ?? []) seq.push({ w: w.toLowerCase(), line: i + 1 });
  });
  const lines = new Set();
  seq.forEach(({ w, line }, k) => {
    if (COMMUNITY_WORDS.has(fingerprint(w))
      || (k + 1 < seq.length && COMMUNITY_PAIR_FIRST.has(fingerprint(w)) && COMMUNITY_PAIRS.has(fingerprint(`${w} ${seq[k + 1].w}`)))) lines.add(line);
  });
  for (const line of lines) community.push(`${rel}:${line}`);
}

if (community.length > 0) {
  failed = true;
  console.error("\nA community's own name in the program, which is for any community — none is named in it:\n");
  for (const c of community) console.error(`  ${c}`);
  console.error(`\n${community.length} line(s). Use a neutral example ("Example Community", the clan tag "ABC") or a setting.`);
}

if (failed) process.exit(1);

console.log(words
  ? `check-source: OK (${files.length} files scanned — no banned name, no community's name, no raw control characters, every borrowed file credited).`
  : `check-source: OK (${files.length} files scanned — no raw control characters, every borrowed file credited; names not checked, as this copy has no word list).`);
