/**
 * The dedicated chat filter — CRCON's "profanities", grown up. What is pinned here: the word
 * list becomes exactly two managed rules through the same validation door as hand-written ones
 * (whole-word regex, one per chat kind), a re-save edits those rules in place and PRESERVES what
 * staff added to them by hand, an empty-but-enabled list is refused (it would match everything),
 * and the censor planner diffs against our own record because HLL cannot read its list back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { buildChatFilterMatch, normalizeChatFilterWords, planCensorPushes } from "../dist/chat-filter.js";
import { jf, ownerAuth } from "./harness.ts";

async function withRepoServer(fn: (base: string, repo: any) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); }
}

test("the match is whole words, literally escaped, deduped and phrase-tolerant", () => {
  assert.deepEqual(normalizeChatFilterWords("slur,  SLUR \n badword\n\n kys  buddy "), ["slur", "badword", "kys buddy"]);
  const m = buildChatFilterMatch(["bad.word", "kys buddy"]);
  assert.equal(m, "\\b(?:bad\\.word|kys\\s+buddy)\\b");
  const re = new RegExp(m, "i");
  assert.ok(re.test("you BAD.WORD!"), "case-insensitive, punctuation escaped");
  assert.ok(re.test("kys   buddy"), "a phrase survives double spacing");
  assert.ok(!re.test("badxword"), "the escaped dot is a dot, not any-character");
  // The word-boundary promise the help text makes by name.
  const slur = new RegExp(buildChatFilterMatch(["slur"]), "i");
  assert.ok(!slur.test("Slurpee says gg"), "a name containing a word is not the word");
  assert.ok(slur.test("that was a slur"));
});

test("saving materialises two managed rules; a re-save edits them and keeps hand-added settings", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const put = (body: unknown) => jf(`${base}/api/chat-filter`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    const r1 = await put({ enabled: true, words: "slur\nbadword", action: "punish", reason: "language" });
    assert.equal(r1.status, 200);
    const cfg1 = r1.body.config;
    assert.ok(cfg1.teamRuleId && cfg1.unitRuleId);
    const team = await repo.enforcerRules.get(cfg1.teamRuleId);
    const unit = await repo.enforcerRules.get(cfg1.unitRuleId);
    assert.equal(team.eventKind, "evt.chat.team");
    assert.equal(unit.eventKind, "evt.chat.squad");
    assert.equal(team.match, "\\b(?:slur|badword)\\b");
    assert.equal(team.action, "punish");
    assert.equal(team.serverId, null, "one community-wide policy, like the list itself");

    // Staff tune the managed rule by hand: exempt a tag, add a ladder. The next word-list save
    // must not flatten that — the filter manages its fields and only its fields.
    const patch = await jf(`${base}/api/enforcer/rules/${cfg1.teamRuleId}`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ immuneTags: ["staff"], escalateActions: ["kick"] }),
    });
    assert.equal(patch.status, 200);

    const r2 = await put({ enabled: true, words: "slur, badword, newword", action: "kick", reason: "language" });
    assert.equal(r2.status, 200);
    const cfg2 = r2.body.config;
    assert.equal(cfg2.teamRuleId, cfg1.teamRuleId, "edited in place, not multiplied");
    const team2 = await repo.enforcerRules.get(cfg1.teamRuleId);
    assert.match(team2.match, /newword/);
    assert.equal(team2.action, "kick");
    assert.deepEqual(team2.immuneTags, ["staff"], "the hand-added exemption survived the save");
    assert.deepEqual(team2.escalateActions, ["kick"], "so did the ladder");

    // Disabling parks both rules; the definition stays for the day it comes back.
    const r3 = await put({ enabled: false, words: "slur, badword, newword", action: "kick", reason: "language" });
    assert.equal(r3.status, 200);
    assert.equal((await repo.enforcerRules.get(cfg1.teamRuleId)).enabled, false);
    assert.equal((await repo.enforcerRules.get(cfg1.unitRuleId)).enabled, false);
  });
});

test("refusals: an enabled empty list, a bogus action, a tempban with no hours", async () => {
  await withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    const put = (body: unknown) => jf(`${base}/api/chat-filter`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await put({ enabled: true, words: "", action: "punish" })).status, 400, "an empty enabled list would match everything");
    assert.equal((await put({ enabled: true, words: "x y", action: "note" })).status, 400, "actions are the moderation five");
    const noHours = await put({ enabled: true, words: "slur", action: "tempban" });
    assert.equal(noHours.status, 400, "a tempban needs its length, same door as the Rules page");
  });
});

test("the censor planner diffs per ACTIVE server against what was actually pushed", () => {
  const servers = [
    { id: "s1", name: "One", engagementMode: "active" },
    { id: "s2", name: "Two", engagementMode: "observe" },
  ];
  // First push: everything is an add; the observe server is never written to.
  let plan = planCensorPushes(servers as never, ["a", "b"], {});
  assert.deepEqual(plan, [{ serverId: "s1", name: "One", add: ["a", "b"], remove: [] }]);
  // A later save that swaps a word: one add, one remove — the record is the baseline, because
  // HLL's wire has no banned-words getter to reconcile against.
  plan = planCensorPushes(servers as never, ["a", "c"], { s1: ["a", "b"] });
  assert.deepEqual(plan, [{ serverId: "s1", name: "One", add: ["c"], remove: ["b"] }]);
  // Censor switched off: wanted is empty, so the push is pure removal, never amnesia.
  plan = planCensorPushes(servers as never, [], { s1: ["a", "c"] });
  assert.deepEqual(plan, [{ serverId: "s1", name: "One", add: [], remove: ["a", "c"] }]);
  // In sync → no entry at all.
  assert.deepEqual(planCensorPushes(servers as never, ["a"], { s1: ["a"] }), []);
});

test("a managed rule deleted under Rules is reported, not papered over — and Save puts it back", async () => {
  /*
   * The filter's own switch is this page's intent; the two managed rules are what enforce it, and
   * they live under Rules where staff can delete or disable them. With nothing reporting their
   * state, the screen went on saying "acting on players: on" while team chat was policed by
   * nothing at all.
   */
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const put = (body: unknown) => jf(`${base}/api/chat-filter`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    const get = () => jf(`${base}/api/chat-filter`, { headers: auth });

    const saved = await put({ enabled: true, words: "slur", action: "punish", reason: "language" });
    const { teamRuleId, unitRuleId } = saved.body.config;
    assert.deepEqual(saved.body.rules.team, { id: teamRuleId, enabled: true, sectionOff: false, pausedUntil: null }, "the save reports what it just built");

    const healthy = await get();
    assert.equal(healthy.body.rules.team.enabled, true);
    assert.equal(healthy.body.rules.unit.enabled, true);

    // Staff switch the unit-chat rule off by hand, and delete the team-chat one outright.
    await jf(`${base}/api/enforcer/rules/${unitRuleId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    await repo.enforcerRules.remove(teamRuleId);

    const broken = await get();
    assert.equal(broken.body.config.enabled, true, "the filter still believes it is on…");
    assert.equal(broken.body.rules.team, null, "…but the team-chat rule is gone, and the screen must be told");
    assert.equal(broken.body.rules.unit.enabled, false, "and the unit-chat rule is parked");

    // Saving is the repair: both rules exist and are enabled again.
    const repaired = await put({ enabled: true, words: "slur", action: "punish", reason: "language" });
    assert.equal(repaired.body.rules.team.enabled, true);
    assert.equal(repaired.body.rules.unit.enabled, true);
    const after = await get();
    assert.equal(after.body.rules.team.enabled, true, "and it sticks");
    assert.equal(after.body.rules.unit.enabled, true);
  });
});

test("a managed rule held by its section's switch or a pause is reported as such — a save lifts neither", async () => {
  /*
   * A rule's own switch is not the only thing that stops it: filed in a section that is switched
   * off, or paused, it holds fire with its own switch still on — and the screen said "acting".
   */
  await withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    const put = (body: unknown) => jf(`${base}/api/chat-filter`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    const get = () => jf(`${base}/api/chat-filter`, { headers: auth });
    const saved = await put({ enabled: true, words: "slur", action: "punish", reason: "language" });
    const { teamRuleId, unitRuleId } = saved.body.config;

    const sec = (await jf(`${base}/api/enforcer/sections`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Chat rules" }) })).body.section;
    await jf(`${base}/api/enforcer/sections/assign`, { method: "POST", headers: auth, body: JSON.stringify({ ruleIds: [teamRuleId], sectionId: sec.id }) });
    await jf(`${base}/api/enforcer/sections/${sec.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    const paused = await jf(`${base}/api/enforcer/rules/${unitRuleId}/pause`, { method: "POST", headers: auth, body: JSON.stringify({ minutes: 120, reason: "event night" }) });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));

    const held = await get();
    assert.deepEqual(held.body.rules.team, { id: teamRuleId, enabled: true, sectionOff: true, pausedUntil: null }, "held by its section, its own switch on");
    assert.equal(held.body.rules.unit.enabled, true);
    assert.equal(held.body.rules.unit.sectionOff, false);
    assert.equal(held.body.rules.unit.pausedUntil, paused.body.rule.pausedUntil, "paused, and until when");

    // A save puts back what it manages — and says the section and the pause still hold.
    const resaved = await put({ enabled: true, words: "slur", action: "punish", reason: "language" });
    assert.equal(resaved.body.rules.team.sectionOff, true);
    assert.equal(resaved.body.rules.unit.pausedUntil, paused.body.rule.pausedUntil);

    // A pause that has run out is no pause.
    await jf(`${base}/api/enforcer/rules/${unitRuleId}/pause`, { method: "DELETE", headers: auth });
    assert.equal((await get()).body.rules.unit.pausedUntil, null);
  });
});
