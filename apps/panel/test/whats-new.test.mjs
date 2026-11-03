// What's new (lib/whatsNew.ts): every entry written for someone opening the panel for the first
// time, and shown to the people it is new to. The words are held to the rules the module states —
// a test, because "keep it plain" is the kind of rule that slips one update at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WHATS_NEW, seenBuild, unseenReleases } from "../lib/whatsNew.ts";
import { routeById } from "../lib/routes.ts";

/** Words that mean something only to whoever built the panel. */
const JARGON = /\b(api|rcon|endpoints?|tokens?|json|cache[sd]?|sync(ed|s)?|back-?end|front-?end|server-side|client-side|deploy(ed)?|commits?|branch(es)?|repo(sitory)?|config(uration)?|toggles?|ui|ux|bugs?|regressions?|refactor(ed)?|database|db|env|vapid|subscriptions?|service worker|localstorage|payloads?|schema|migrations?|css|html|routes?|exports?|exported|imports?|imported|modal|popup|dropdown)\b/i;

test("each update's notes are numbered and dated, newest first, and plain enough for someone new to read", () => {
  assert.ok(WHATS_NEW.length > 0);
  // Numbered upward, newest first: the number is what tells a person what they missed. Updates that
  // only fixed things have no notes, so a number can be missing, but none is used twice.
  const builds = WHATS_NEW.map((r) => r.build);
  assert.ok(builds.every((b, i) => Number.isInteger(b) && (i === 0 || b < builds[i - 1])), `newest first, each number once: ${builds.join(" ")}`);
  assert.equal(builds.at(-1), 1, "the first update is build 1, which a date from before builds were numbered stands for");
  const dates = WHATS_NEW.map((r) => r.date);
  for (const d of dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/, "dated YYYY-MM-DD, the day the update was made");
  assert.deepEqual(dates, [...dates].sort().reverse(), "a later build is never dated earlier");
  for (const r of WHATS_NEW) {
    assert.ok(r.items.length > 0 && r.items.length <= 12, `build ${r.build}: a handful of things, not a changelog`);
    for (const it of r.items) {
      const where = `build ${r.build} “${it.title}”`;
      assert.ok(it.title.length > 0 && it.title.length <= 40, `${where}: a title of a few words`);
      assert.ok(it.text.length <= 320, `${where}: two or three sentences, not a paragraph (${it.text.length} characters)`);
      const sentences = it.text.split(/(?<=[.!?])\s+/);
      assert.ok(sentences.length <= 4, `${where}: at most four sentences`);
      for (const s of sentences) assert.ok(s.split(/\s+/).length <= 26, `${where}: a sentence this long loses a new reader — “${s}”`);
      assert.doesNotMatch(`${it.title} ${it.text}`, JARGON, `${where}: a word only the people who built it would know`);
      for (const id of it.where ?? []) assert.ok(routeById(id), `${where}: "${id}" is not a screen`);
    }
  }
});

test("what is new to a person: every build after the last they closed, or after their account was made", () => {
  // Three builds, two of them on the same day: a second update that day is news too.
  const releases = [{ build: 3, date: "2026-11-01", items: [] }, { build: 2, date: "2026-10-01", items: [] }, { build: 1, date: "2026-10-01", items: [] }];
  const builds = (seen, made) => unseenReleases(seen, made, releases).map((r) => r.build);
  assert.deepEqual(builds(1, "2025-01-01T00:00:00Z"), [3, 2], "since the last one closed, the same day's second build included");
  assert.deepEqual(builds(3, "2025-01-01T00:00:00Z"), [], "all seen");
  assert.deepEqual(builds(undefined, "2025-01-01T00:00:00Z"), [3, 2, 1], "an account from before any of them has seen none");
  assert.deepEqual(builds(undefined, "2026-10-01T09:00:00Z"), [3], "someone new: nothing from before they joined, not even that day's");
  assert.deepEqual(builds(undefined, undefined), [], "nothing to go on: nothing shown");
});

test("a seen marker reads as a build; a date, from before builds were numbered, as build 1", () => {
  assert.equal(seenBuild(2), 2);
  assert.equal(seenBuild("2"), 2, "as this device keeps it");
  // Closed when What's new was keyed by date: build 1 was all there was, so build 2 on is new.
  assert.equal(seenBuild("2026-10-23"), 1);
  assert.deepEqual(unseenReleases(seenBuild("2026-10-23"), "2025-01-01T00:00:00Z").map((r) => r.build), WHATS_NEW.filter((r) => r.build > 1).map((r) => r.build));
  for (const nothing of [undefined, null, "", "soon", 0, -1, 1.5, {}]) assert.equal(seenBuild(nothing), 0, `${JSON.stringify(nothing)}: nothing seen`);
});
