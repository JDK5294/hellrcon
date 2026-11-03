// The rule editor's clash warning: two rules that would punish the same player twice for one
// event, or warn them in the same breath as punishing them. Strict on purpose — a ladder built from
// two rules ("message at 1 team kill", "kick at 3") is a choice, and a warning on every save would
// teach staff to click straight through the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleClashes } from "../lib/ruleClash.ts";

const rule = (over = {}) => ({ id: "x", name: "Rule", enabled: true, serverId: null, eventKind: "evt.teamkill", match: null, threshold: 1, windowSec: 0, action: "kick", ...over });

test("two rules punishing the same event is a double punishment", () => {
  const out = ruleClashes(rule({ id: "new", name: "TK ban", action: "tempban" }), [rule({ id: "a", name: "TK kick" })], "a team kill");
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "punishedTwice");
  assert.match(out[0].text, /“TK kick” also kicks the player for a team kill — they would be punished twice/);
});

test("a message beside a punishment for the same event is flagged, from either side", () => {
  const warn = rule({ id: "w", name: "TK warning", action: "message" });
  const kick = rule({ id: "k", name: "TK kick" });
  assert.equal(ruleClashes(warn, [kick])[0]?.kind, "warnedAndPunished");
  assert.equal(ruleClashes(kick, [warn])[0]?.kind, "warnedAndPunished");
  assert.match(ruleClashes(kick, [warn])[0].text, /only messages the player .* while this rule kicks them/);
});

test("a ladder built from two rules is not a clash: different counts, different windows, different idle times", () => {
  const warnAt1 = rule({ id: "w", name: "warn", action: "message" });
  const kickAt3 = rule({ id: "k", name: "kick at 3", threshold: 3, windowSec: 600 });
  assert.deepEqual(ruleClashes(kickAt3, [warnAt1]), []);
  assert.deepEqual(ruleClashes(rule({ threshold: 3, windowSec: 300 }), [rule({ id: "y", threshold: 3, windowSec: 600 })]), []);
  assert.deepEqual(ruleClashes(rule({ threshold: 2, countPerMatch: true }), [rule({ id: "y", threshold: 2, windowSec: 600 })]), [], "per match vs a window");
  assert.equal(ruleClashes(rule({ threshold: 2, countPerMatch: true }), [rule({ id: "y", threshold: 2, countPerMatch: true })]).length, 1, "both per match");
  const afk = (secs, action) => rule({ eventKind: "app.idle", windowSec: secs, action });
  assert.deepEqual(ruleClashes(afk(600, "kick"), [{ ...afk(300, "message"), id: "y" }]), [], "warn at 5 minutes idle, kick at 10");
  assert.equal(ruleClashes(afk(600, "kick"), [{ ...afk(600, "message"), id: "y" }]).length, 1);
});

test("different servers, different match text, or different trigger settings are different events", () => {
  assert.deepEqual(ruleClashes(rule({ serverId: "s1" }), [rule({ id: "y", serverId: "s2" })]), []);
  assert.equal(ruleClashes(rule({ serverId: "s1" }), [rule({ id: "y", serverId: null })]).length, 1, "community-wide covers every server");
  assert.deepEqual(ruleClashes(rule({ eventKind: "evt.chat.team", match: "badword" }), [rule({ id: "y", eventKind: "evt.chat.team", match: "spam" })]), []);
  assert.equal(ruleClashes(rule({ eventKind: "evt.chat.team", match: "BadWord" }), [rule({ id: "y", eventKind: "evt.chat.team", match: "badword" })]).length, 1);
  assert.equal(ruleClashes(rule({ eventKind: "evt.chat.team", match: "badword" }), [rule({ id: "y", eventKind: "evt.chat.team", match: null })]).length, 1, "no match text fires on every line");
  const low = (minLevel, action) => rule({ eventKind: "app.state.low_level", params: { minLevel }, action });
  assert.deepEqual(ruleClashes(low(10, "kick"), [{ ...low(25, "message"), id: "y" }]), [], "level 10 kick and level 25 warning are tiers");
  assert.equal(ruleClashes(low(25, "kick"), [{ ...low(25, "message"), id: "y" }]).length, 1);
  assert.deepEqual(ruleClashes(rule(), [rule({ id: "y", eventKind: "evt.kill" })]), []);
});

test("a rule that acts on nobody clashes with nothing: off, held by its section, or on a trial run", () => {
  const kick = rule({ id: "y" });
  for (const quiet of [{ enabled: false }, { sectionOff: true }, { dryRun: true }]) {
    assert.deepEqual(ruleClashes(rule(quiet), [kick]), [], JSON.stringify(quiet));
    assert.deepEqual(ruleClashes(rule(), [{ ...kick, ...quiet }]), [], `other ${JSON.stringify(quiet)}`);
  }
  assert.deepEqual(ruleClashes(rule({ id: "same" }), [rule({ id: "same" })]), [], "a rule never clashes with itself");
  assert.deepEqual(ruleClashes(rule({ action: "note" }), [kick]), [], "recording a note touches nobody");
  assert.deepEqual(ruleClashes(rule({ action: "message" }), [rule({ id: "y", action: "message" })]), [], "two messages are not a punishment");
});
