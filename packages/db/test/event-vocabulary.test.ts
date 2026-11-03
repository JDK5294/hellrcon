import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_KINDS, TRIM_CATEGORIES, kindsForCategories } from "../dist/types.js";

/**
 * The event vocabulary has three lists that must agree, and drift between them is silent:
 * a kind nobody categorised is invisible under every log filter except "All" and can never be
 * trimmed, so it accumulates forever with no way to find or remove it. That is exactly how
 * evt.admin.camera and evt.vote.cast went missing after the CRCON import started producing them.
 *
 * These tests fail the moment a new kind is introduced without being placed.
 */

test("every trim category maps to real kinds, with no kind claimed twice", () => {
  const seen = new Map<string, string>();
  for (const [category, kinds] of Object.entries(TRIM_CATEGORIES)) {
    assert.ok(kinds.length > 0, `trim category "${category}" covers no kinds`);
    for (const k of kinds) {
      assert.ok((EVENT_KINDS as readonly string[]).includes(k), `trim category "${category}" lists unknown kind "${k}"`);
      const prior = seen.get(k);
      assert.equal(prior, undefined, `kind "${k}" is in both "${prior}" and "${category}" — trimming one would surprise the other`);
      seen.set(k, category);
    }
  }
});

test("every event kind we can store is trimmable", () => {
  const covered = new Set(Object.values(TRIM_CATEGORIES).flat());
  const orphans = EVENT_KINDS.filter((k) => !covered.has(k));
  assert.deepEqual(orphans, [], `these kinds can be stored but never trimmed: ${orphans.join(", ")}`);
});

test("every event kind the log filters offer is one we can actually store", () => {
  // The panel's category list is the other half of the vocabulary. Read as source rather than
  // imported, because packages/db must not depend on the panel.
  const src = readFileSync(join(import.meta.dirname, "../../../apps/panel/lib/eventKinds.ts"), "utf8");
  const listed = [...src.matchAll(/"(evt\.[a-zA-Z.]+)"/g)].map((m) => m[1]!);
  assert.ok(listed.length > 0, "found no event kinds in the panel's category list — did the file move?");
  for (const k of new Set(listed)) {
    assert.ok((EVENT_KINDS as readonly string[]).includes(k), `the log filters offer "${k}", which nothing produces`);
  }
});

test("every event kind we can store appears under some log filter", () => {
  const src = readFileSync(join(import.meta.dirname, "../../../apps/panel/lib/eventKinds.ts"), "utf8");
  const listed = new Set([...src.matchAll(/"(evt\.[a-zA-Z.]+)"/g)].map((m) => m[1]!));
  const orphans = EVENT_KINDS.filter((k) => !listed.has(k));
  assert.deepEqual(orphans, [], `these kinds are only reachable under "All": ${orphans.join(", ")}`);
});

test("kindsForCategories unions the requested categories and ignores unknown ones", () => {
  const both = kindsForCategories(["kills", "teamkills"]);
  assert.deepEqual(both.sort(), ["evt.kill", "evt.teamkill"]);
  assert.deepEqual(kindsForCategories(["not-a-category"]), []);
  assert.deepEqual(kindsForCategories([]), []);
  // Team kills are trimmable on their own — a community that keeps them for moderation can drop
  // the killfeed without losing them.
  assert.deepEqual(kindsForCategories(["kills"]), ["evt.kill"]);
});

/*
 * …and a fourth list, in another package: the canonical `EvtKind` union in @app/events, which the
 * HLL log normalizer is typed against.
 *
 * It had drifted two kinds behind this one — the same two, evt.admin.camera and evt.vote.cast, that
 * the tests above were written for. Nothing caught it because every check so far compared lists
 * INSIDE this package, and the type-level taxonomy lives outside it. A union that cannot name an
 * event the store keeps is not canonical; it just looks like it is.
 *
 * Read as text rather than imported so this stays a one-way check with no dependency edge from the
 * store onto the taxonomy package.
 */
test("the canonical EvtKind union names exactly the kinds we can store", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "events", "src", "index.ts"), "utf8");
  const union = src.match(/export type EvtKind =([\s\S]*?);/);
  assert.ok(union, "could not find the EvtKind union — did the taxonomy move?");
  const canonical = [...union[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

  const missing = (EVENT_KINDS as readonly string[]).filter((k) => !canonical.includes(k));
  assert.deepEqual(missing, [], `these kinds can be stored but the canonical union cannot name them:\n${missing.join("\n")}`);

  const extra = canonical.filter((k) => !(EVENT_KINDS as readonly string[]).includes(k));
  assert.deepEqual(extra, [], `the union names kinds nothing can store:\n${extra.join("\n")}`);
});
