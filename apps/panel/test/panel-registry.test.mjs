// The panel registry — layer 3 of the permission model, and the test that keeps it honest.
//
// Layer 1 (routes.ts) and layer 2 (the API's `can()` calls) both stayed correct for years, and
// neither did so by good intentions: each has a test that fails the build when a destination or an
// endpoint declares nothing. Layer 3 — the panels INSIDE a page — had no such obligation, and
// drifted exactly as far as you would expect. Sweeping the panels once would have fixed today and
// nothing else; the 153rd panel, written next month, would be undeclared again.
//
// So this test is the mechanism, and the sweep followed it. Every `<Panel>` must say which
// capability gates it. `"open"` is a perfectly good answer — most panels genuinely belong to
// anyone who could reach the page they sit on — but it has to be SAID, because in source code
// "anyone may see this" and "nobody thought about it" must not look identical.
//
// The sweep is finished: UNDECLARED at the bottom is empty, and `caps` is a required prop, so the
// compiler now catches a missing declaration before this test does. Both are kept. The type stops
// you writing one; the test is what proves the whole app is still covered, and it is the only half
// that can check the declaration is a readable literal naming a capability that exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// Straight out of @app/access, for the same reason routes.test.mjs does it: the panel deliberately
// does not depend on the package, but the catalogue is plain data and the point of the assertion is
// that a panel cannot gate on a capability nobody can hold.
import { CAPABILITY_CATALOG } from "../../../packages/access/src/capabilities.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tsxFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Block comments describe panels too ("Each section is its own <Panel>"); they aren't panels. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

/**
 * The source of one `<Panel …>` opening tag, from `<` to the `>` that closes it.
 *
 * Hand-scanned rather than regexed because an attribute value can contain the `>` that would end
 * the tag — `{(a) => b}` and `{x > 1 && …}` both appear in this codebase — so the scanner tracks
 * brace depth and skips string literals.
 */
function openingTag(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === "\\") i++;
    } else if (c === ">" && depth === 0) return src.slice(at, i + 1);
  }
  return null;
}

/** An attribute's raw source: `"literal"`, `{expression}`, or null when it isn't there. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}=("[^"]*"|\\{(?:[^{}]|\\{[^{}]*\\})*\\})`));
  return m ? m[1] : null;
}

/** Every `<Panel>` in the app, with what it declares. */
function panelSites() {
  const sites = [];
  for (const file of [...tsxFiles(join(ROOT, "components")), ...tsxFiles(join(ROOT, "app"))]) {
    const rel = relative(ROOT, file);
    if (rel === "components/Panel.tsx") continue; // the definition, not a use
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(/<Panel\s/g)) {
      const tag = openingTag(src, m.index);
      const line = src.slice(0, m.index).split("\n").length;
      sites.push({ file: rel, line, tag, id: tag && attr(tag, "id"), caps: tag && attr(tag, "caps") });
    }
  }
  return sites;
}

/**
 * How a panel is named in the grandfather list: `file:id`, never `file:line`. Line numbers move
 * every time somebody edits the file above a panel, and a stale-line list would either need
 * constant maintenance or (worse) start silently excusing the wrong panel.
 */
const keyOf = (s) => `${s.file}:${s.id?.startsWith('"') ? s.id.slice(1, -1) : s.id}`;

const SITES = panelSites();

test("every panel is parseable and identified", () => {
  const bad = SITES.filter((s) => !s.tag || !s.id).map((s) => `${s.file}:${s.line}`);
  assert.deepEqual(bad, [], `these <Panel> tags could not be read, or declare no id:\n${bad.join("\n")}`);
  // A rough floor, so a scanner that silently stops matching (a JSX style change, a rename) fails
  // here instead of quietly declaring the whole app compliant.
  assert.ok(SITES.length > 100, `only found ${SITES.length} panels — the scanner is probably broken`);
});

test("a panel's caps declaration is readable without running the app", () => {
  // The registry is only worth having if it can be READ — by this test, and by whoever is asking
  // "who can see this?". A computed `caps={somethingConditional}` would answer neither.
  const dynamic = [];
  for (const s of SITES.filter((x) => x.caps)) {
    const raw = s.caps.startsWith("{") ? s.caps.slice(1, -1).trim() : s.caps;
    const literal = /^"[^"]*"$/.test(raw) || /^\[\s*(?:"[^"]*"\s*,\s*)*"[^"]*"\s*,?\s*\]$/.test(raw);
    if (!literal) dynamic.push(`${keyOf(s)} declares caps=${s.caps}, which is not a literal`);
  }
  assert.deepEqual(dynamic, [], dynamic.join("\n"));
});

test("every capability a panel gates on is a real capability", () => {
  const known = new Set(CAPABILITY_CATALOG.map((c) => c.key));
  const strays = [];
  for (const s of SITES.filter((x) => x.caps)) {
    for (const cap of [...s.caps.matchAll(/"([^"]*)"/g)].map((m) => m[1])) {
      if (cap === "open" || known.has(cap)) continue;
      strays.push(`${keyOf(s)} gates on "${cap}", which no role can hold`);
    }
  }
  assert.deepEqual(strays, [], strays.join("\n"));
});

test("every panel declares what gates it", () => {
  // Sites sharing a key are the same panel rendered down different branches — loading, empty,
  // loaded, as PlayerMapVotes does three times over. They are ONE entry in the registry, so they
  // must all declare and all declare the same thing; a panel whose loading state is visible to
  // more people than its loaded state is a leak wearing a skeleton.
  const groups = new Map();
  for (const s of SITES) {
    const g = groups.get(keyOf(s)) ?? { declared: 0, total: 0, values: new Set() };
    g.total++; if (s.caps) { g.declared++; g.values.add(s.caps); }
    groups.set(keyOf(s), g);
  }
  const disagree = [...groups]
    .filter(([, g]) => (g.declared && g.declared !== g.total) || g.values.size > 1)
    .map(([k, g]) => `${k} — ${g.declared}/${g.total} branches declare${g.values.size > 1 ? `, and they disagree: ${[...g.values].join(" vs ")}` : ""}`);
  assert.deepEqual(disagree, [], `every branch of one panel must declare the same caps:\n${disagree.join("\n")}`);

  const undeclared = [...groups].filter(([, g]) => !g.declared).map(([k]) => k);
  const news = undeclared.filter((k) => !UNDECLARED.includes(k));
  assert.deepEqual(news, [],
    "these panels don't say who may see them. Add caps=… — \"open\" if the page's own gate is the " +
    "whole answer, otherwise the capability behind the data:\n" + news.join("\n"));

  // …and the grandfather list may only ever shrink.
  const stale = UNDECLARED.filter((k) => !undeclared.includes(k));
  assert.deepEqual(stale, [],
    "UNDECLARED lists panels that no longer need it — delete these lines:\n" + stale.join("\n"));
});

/*
 * Panels written before the registry existed and not yet reviewed. It held 135 of them for exactly
 * one commit; every one has since been read and answered, so it is empty and must stay that way.
 *
 * Kept rather than deleted because emptiness is the assertion. The two checks above still run
 * against it, so anything added here has to be removed again before the build passes, and the file
 * says plainly that nothing is outstanding — which a deleted list cannot.
 */
const UNDECLARED = [];

// The Moderation record tabs must not hand-roll their action lists.
//
// The same act is audited under a different prefix depending on who did it: a kick is
// `player.kick` by hand, `seed.kick` from the seeding rules, `autosettings.kick` from a rule
// module and `enforcer.kick` from a Rules-tab rule. This test used to read the literal lists out
// of the JSX and check them against the automated prefixes it knew about — and it knew about two
// of the three, so every enforcer firing stayed invisible with the guard passing.
//
// The lists now live in lib/enforcement.ts, derived from ONE list of sources, and routes.test.mjs
// checks that list against the audit actions the server actually writes. What is left to assert
// here is that the tabs keep using it: a literal enforcement list in the JSX is how the drift got
// in, and it would bypass both of those checks. (Team switches are exempt: no automated system
// moves anyone between teams, so that tab really is "what staff did".)
test("the Moderation records take their action lists from the shared source", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "hubs.tsx"), "utf8");
  const literal = [...src.matchAll(/actions=\{\[([^\]]*)\]\}/g)]
    .map((m) => [...m[1].matchAll(/"([\w.]+)"/g)].map((x) => x[1]))
    .filter((list) => list.some((a) => /\.(kick|punish|warn|message)$/.test(a)));
  assert.deepEqual(literal, [],
    "these tabs spell out enforcement actions inline instead of importing them from lib/enforcement.ts,\n"
    + "so a system that files a fourth prefix will be missing from them and nothing will say so:\n"
    + literal.map((l) => l.join(", ")).join("\n"));

  // And they do import them — the check above passes trivially if the tabs stopped rendering.
  for (const name of ["KICK_ACTIONS", "PUNISH_ACTIONS", "WARN_ACTIONS"]) {
    assert.ok(src.includes(name), `hubs.tsx no longer uses ${name}`);
  }
});

/*
 * The rule trigger picker groups a derived trigger with the event it reads.
 *
 * "admin camera — entered" and "— left" are refinements of the Admin camera event, and when they
 * were simply appended to the list they landed fifteen rows below it, past the votes and the
 * match events, reading as two unrelated features. Placement is by DERIVATION rather than by
 * hand, so this asserts the mechanism is what puts them there — an appended list would look
 * correct today and drift the next time a trigger is added.
 */
test("derived rule triggers sit beneath the event they read", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "Enforcer.tsx"), "utf8");
  assert.match(src, /DERIVED_AFTER[^=]*=\s*\{\s*"evt\.admin\.camera":\s*CAM_KINDS/,
    "the admin-camera triggers are no longer declared as derived from the camera event");
  assert.match(src, /ALL_EVENT_KINDS\.flatMap\(\(k\) => \[k, \.\.\.\(DERIVED_AFTER\[k\] \?\? \[\]\)\]\)/,
    "the picker no longer expands derived triggers in place");
  assert.doesNotMatch(src, /const EVENT_KINDS = \[[^\]]*\.\.\.CAM_KINDS/s,
    "the camera triggers are appended to the end of the picker again instead of sitting under Admin camera");
});
