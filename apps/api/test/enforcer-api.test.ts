import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, assertAsked, askedFor } from "./harness.ts";

// Roster-trigger writes ride a paced per-server chain; this file's state-kind firings must not
// spend real time breathing between calls.
process.env.RULE_CROWD_PACE_MS = "0";

test("rule CRUD + validation + audit", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    const created = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "TK kick", eventKind: "evt.teamkill", action: "kick", reason: "no TK" }) });
    assert.equal(created.status, 201);
    const id = created.body.rule.id as string;

    // validation
    assert.equal((await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "teamkill", action: "kick" }) })).status, 400); // not evt.*
    assert.equal((await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.kill", action: "explode" }) })).status, 400); // bad action
    assert.equal((await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.kill", action: "kick", match: "(" }) })).status, 400); // bad regex

    // toggle + list
    await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    const list = await jf(`${base}/api/enforcer/rules`, { headers: auth });
    assert.equal((list.body.rules as any[]).find((r) => r.id === id).enabled, false);

    // audit recorded
    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "rule.create"));

    // delete
    assert.equal((await jf(`${base}/api/enforcer/rules/${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jf(`${base}/api/enforcer/rules/${id}`, { method: "DELETE", headers: auth })).status, 404);
  });
});

test("managing rules requires admin.moderation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await jf(`${base}/api/enforcer/rules`, { headers: plain })).status, 403);
    // Creating one is asked for, not done.
    assertAsked(await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: plain, body: JSON.stringify({ name: "x", eventKind: "evt.kill", action: "kick" }) }));
    assert.deepEqual((await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules, [], "no rule was created");
  });
});

test("the event decides the action family, and PATCH goes through the same validation as POST", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    // VIP anywhere but a disconnect is refused.
    const vipOnTk = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.teamkill", action: "vip" }) });
    assert.equal(vipOnTk.status, 400);
    // A disconnected player can only be granted VIP.
    const kickOnLeave = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.player.disconnected", action: "kick", reason: "bye" }) });
    assert.equal(kickOnLeave.status, 400);
    // A team-switch rule cannot move the player — the move is a team switch, and it would answer
    // itself — first action or ladder rung. A side-swap rule (message on the second swap in a
    // match, kick on repeat, as a trial run) saves as it is.
    const post = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "swap", eventKind: "evt.player.teamSwitched", match: "switched sides", ...body }) });
    const moveOnSwap = await post({ action: "switch" });
    assert.equal(moveOnSwap.status, 400);
    assert.match(String((moveOnSwap.body.error as { message?: string })?.message), /cannot move the player/);
    assert.equal((await post({ action: "message", reason: "no", escalateActions: ["switch"] })).status, 400);
    const sideSwap = await post({ action: "message", reason: "no swapping", threshold: 2, windowSec: 0, countPerMatch: true, escalateActions: ["kick"], dryRun: true });
    assert.equal(sideSwap.status, 201, JSON.stringify(sideSwap.body));
    assert.equal(sideSwap.body.rule.countPerMatch, true);
    assert.deepEqual(sideSwap.body.rule.escalateActions, ["kick"]);
    // Crash VIP round-trips with its knobs.
    const vip = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "crash vip", eventKind: "evt.player.disconnected", action: "vip", vipMinutes: 15, delaySec: 30 }) });
    assert.equal(vip.status, 201, JSON.stringify(vip.body));
    assert.equal(vip.body.rule.vipMinutes, 15);
    assert.equal(vip.body.rule.delaySec, 30);
    assert.equal(vip.body.rule.vipCooldownMinutes, 60, "an unasked-for crash VIP is rate-limited by default");
    // The cooldown is bounded, and 0 (no limit) is legal but has to be asked for.
    assert.equal((await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.player.disconnected", action: "vip", vipCooldownMinutes: -1 }) })).status, 400);
    assert.equal((await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.player.disconnected", action: "vip", vipCooldownMinutes: "wat" }) })).status, 400);
    const noLimit = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "no limit", eventKind: "evt.player.disconnected", action: "vip", vipCooldownMinutes: 0 }) });
    assert.equal(noLimit.status, 201);
    assert.equal(noLimit.body.rule.vipCooldownMinutes, 0);
    // And an edit cannot smuggle a bad one past the merge-then-validate PATCH.
    assert.equal((await jf(`${base}/api/enforcer/rules/${vip.body.rule.id as string}`, { method: "PATCH", headers: auth, body: JSON.stringify({ vipCooldownMinutes: 366 * 1440 }) })).status, 400);
    const edited = await jf(`${base}/api/enforcer/rules/${vip.body.rule.id as string}`, { method: "PATCH", headers: auth, body: JSON.stringify({ vipCooldownMinutes: 120 }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.rule.vipCooldownMinutes, 120);
    // The idle trigger needs a real window; threshold has no meaning and is pinned to 1.
    const idleShort = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "afk", eventKind: "app.idle", action: "punish", reason: "afk", windowSec: 5 }) });
    assert.equal(idleShort.status, 400);
    const idle = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "afk", eventKind: "app.idle", action: "punish", reason: "afk", windowSec: 1800, threshold: 4 }) });
    assert.equal(idle.status, 201);
    assert.equal(idle.body.rule.threshold, 1);

    /*
     * PATCH used to copy body values straight into the store — the unvalidated door beside a
     * validated POST. It now merges over the stored rule and re-runs the same checks, so an edit
     * cannot smuggle in what a create refuses.
     */
    const tk = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "TK", eventKind: "evt.teamkill", action: "kick", reason: "no" }) });
    const id = tk.body.rule.id as string;
    const badAction = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ action: "garbage" }) });
    assert.equal(badAction.status, 400, "an unknown action is refused on edit too");
    const badPair = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ action: "vip" }) });
    assert.equal(badPair.status, 400, "vip on a teamkill rule is refused on edit too");
    const nanThreshold = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ threshold: "wat" }) });
    assert.equal(nanThreshold.status, 400, "a NaN threshold is refused on edit too");
    // A plain toggle still works — the merged rule is already valid.
    const toggled = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    assert.equal(toggled.status, 200, JSON.stringify(toggled.body));
    assert.equal(toggled.body.rule.enabled, false);
    // And an unchanged field survives an unrelated edit.
    const renamed = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "TK renamed" }) });
    assert.equal(renamed.body.rule.reason, "no");
    // A malformed role id in the gate is refused.
    const badRole = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ requireRoleIds: ["boosters"] }) });
    assert.equal(badRole.status, 400);
  });
});

test("death triggers save like any other kind, and still obey the vip pairing rule", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const ok = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "spawn camped", eventKind: "app.death", action: "message", reason: "Killed by {attacker_name}.", threshold: 5, windowSec: 60,
    }) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.rule.eventKind, "app.death");
    assert.equal(ok.body.rule.threshold, 5, "a death rule keeps its threshold — unlike app.idle, deaths are countable");

    const tk = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "team-killed", eventKind: "app.teamdeath", action: "message", reason: "Sorry — report it in Discord.",
    }) });
    assert.equal(tk.status, 201);

    // VIP is still disconnect-only: a death is not a crash.
    const vipOnDeath = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "x", eventKind: "app.death", action: "vip",
    }) });
    assert.equal(vipOnDeath.status, 400);
    // And an unknown synthetic kind is still refused.
    const bogus = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "x", eventKind: "app.whatever", action: "message", reason: "hi",
    }) });
    assert.equal(bogus.status, 400);
  });
});

/**
 * Escalation ladders through the API: steps round-trip, and the two shapes that would misfire are
 * refused at the door — a step the engine has no command for, and a ladder on a crash-VIP rule
 * (VIP is a perk with its own cooldown, not an enforcement step).
 */
test("escalation ladders round-trip, and the nonsense shapes are refused", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    const created = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "TK ladder", eventKind: "evt.teamkill", action: "message", reason: "no TK",
      escalateActions: ["punish", "kick"], escalateResetMinutes: 240,
    }) });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.rule.escalateActions, ["punish", "kick"]);
    assert.equal(created.body.rule.escalateResetMinutes, 240);

    // A rule saved before ladders existed answers with an empty one, not undefined.
    const plain = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "plain", eventKind: "evt.kill", action: "punish",
    }) });
    assert.deepEqual(plain.body.rule.escalateActions, []);

    const bad = (body: Record<string, unknown>) =>
      jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.kill", action: "message", ...body }) });
    assert.equal((await bad({ escalateActions: ["explode"] })).status, 400, "an unknown step is refused");
    assert.equal((await bad({ escalateActions: ["vip"] })).status, 400, "VIP is a perk, not an escalation step");
    // Long enough to outlast a rejoin: a player kicked at the top of a ladder comes back inside the
    // forget window still carrying the count, so the ladder needs room past the kick for a ban.
    const rejoinLadder = ["message", "punish", "punish", "kick", "kick", "tempban", "tempban", "permaban", "permaban"];
    const long = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "rejoin ladder", eventKind: "evt.teamkill", action: "message", reason: "no TK", hours: 24,
      escalateActions: rejoinLadder, escalateResetMinutes: 60,
    }) });
    assert.equal(long.status, 201, JSON.stringify(long.body));
    assert.deepEqual(long.body.rule.escalateActions, rejoinLadder, "all nine steps saved, in order");
    assert.equal((await bad({ escalateActions: [...rejoinLadder, "permaban"], hours: 24 })).status, 400, "ten steps is past the ceiling");
    assert.equal((await bad({ escalateActions: ["kick"], escalateResetMinutes: -1 })).status, 400);
    assert.equal((await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "x", eventKind: "evt.player.disconnected", action: "vip", escalateActions: ["kick"],
    }) })).status, 400, "a crash-VIP rule cannot escalate");

    // A tempban needs its length wherever it sits — Duration 0 on the wire is a ban that holds
    // nobody. The refusal names Ban hours; supplying them makes the same rule valid.
    assert.equal((await bad({ escalateActions: ["tempban"] })).status, 400, "a ladder tempban with no hours is unenforceable");
    assert.equal((await bad({ action: "tempban" })).status, 400, "so is a first-action tempban with none");
    assert.equal((await bad({ escalateActions: ["tempban"], hours: 24 })).status, 201, "hours make the ladder real");
  });
});

test("a rule carries its own Discord ping switch, defaulting to on", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    // Not sent = on. A client that predates the field must not silence the rule it is editing.
    const legacy = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "ping default (alerts)", eventKind: "evt.teamkill", action: "kick", reason: "tk",
    }) });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.rule.alertEnabled, true);

    // Explicitly silenced, and it survives the round trip.
    const quiet = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "noisy idle kick (alerts)", eventKind: "evt.teamkill", action: "kick", reason: "tk", alertEnabled: false,
    }) });
    assert.equal(quiet.body.rule.alertEnabled, false);
    const listed = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as any[];
    assert.equal(listed.find((r) => r.name === "noisy idle kick (alerts)").alertEnabled, false);
    assert.equal(listed.find((r) => r.name === "ping default (alerts)").alertEnabled, true);

    // And it can be turned back on by a patch that names only that field.
    const on = await jf(`${base}/api/enforcer/rules/${quiet.body.rule.id}`, { method: "PATCH", headers: auth,
      body: JSON.stringify({ alertEnabled: true }) });
    assert.equal(on.body.rule.alertEnabled, true);
    assert.equal(on.body.rule.action, "kick", "the rest of the rule is untouched");
  });
});

/*
 * A PATCH must not destroy the fields it does not mention.
 *
 * The route re-validates by merging the edit over the stored rule and re-running parseRuleBody —
 * which re-derives the WHOLE rule, so an absent key is the default, not "leave it alone". The
 * escalation ladder was missing from that merge, so renaming a rule silently wiped its
 * "then punish, then kick": no error, no audit line, just a rule that stopped escalating.
 */
test("editing one field of a rule leaves the ladder and the ping switch alone", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const made = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "before rename (survive)", eventKind: "evt.teamkill", action: "message", reason: "tk",
      escalateActions: ["punish", "kick"], escalateResetMinutes: 45, alertEnabled: false,
    }) });
    assert.equal(made.status, 201);
    const id = made.body.rule.id as string;

    // The most innocuous edit there is.
    const renamed = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth,
      body: JSON.stringify({ name: "after rename (survive)" }) });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.rule.name, "after rename (survive)");
    assert.deepEqual(renamed.body.rule.escalateActions, ["punish", "kick"], "the ladder survived the rename");
    assert.equal(renamed.body.rule.escalateResetMinutes, 45);
    assert.equal(renamed.body.rule.alertEnabled, false, "and so did the silenced ping");

    // Still true after a reload — the store, not just the response.
    const listed = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as any[];
    const stored = listed.find((r) => r.id === id);
    assert.deepEqual(stored.escalateActions, ["punish", "kick"]);
    assert.equal(stored.alertEnabled, false);
  });
});

test("a rule's reason is bounded, like the rule name beside it", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    // The reason reaches the player as the message or the ban reason; it was the one field on the
    // rule with no ceiling, while `name` directly above it has used boundedText all along.
    const tooLong = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "long reason (bounds)", eventKind: "evt.teamkill", action: "kick", reason: "x".repeat(501),
    }) });
    assert.equal(tooLong.status, 400);
    assert.match(JSON.stringify(tooLong.body), /too long/i);
    const ok = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "ok reason (bounds)", eventKind: "evt.teamkill", action: "kick", reason: "x".repeat(500),
    }) });
    assert.equal(ok.status, 201);
  });
});

test("admin-cam kinds, the note action, and the per-rule alert channel round-trip", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: unknown) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    // A cam-enter notify rule: synthetic kind, note action, its own channel.
    const created = await post({
      name: "cam watch", eventKind: "app.admincam.enter", action: "note",
      reason: "went on admin cam", alertChannelId: "123456789012345",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.rule.eventKind, "app.admincam.enter");
    assert.equal(created.body.rule.action, "note");
    assert.equal(created.body.rule.alertChannelId, "123456789012345");
    const id = created.body.rule.id as string;

    // The exit kind is its own trigger, and blank channel = the shared one (null).
    const exit = await post({ name: "cam exit", eventKind: "app.admincam.exit", action: "note", alertChannelId: "" });
    assert.equal(exit.status, 201);
    assert.equal(exit.body.rule.alertChannelId, null);

    // A channel id is a pasted Discord snowflake, nothing else.
    assert.equal((await post({ name: "x", eventKind: "evt.kill", action: "kick", alertChannelId: "not-a-channel" })).status, 400);

    // Renaming must not wipe the stored channel — the PATCH door re-derives the whole rule, so
    // any field missing from its merge list is silently reset (the escalation ladder already
    // fell through this exact hole once).
    const renamed = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "cam watch 2" }) });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.rule.alertChannelId, "123456789012345", "the channel survived the rename");
    assert.equal(renamed.body.rule.eventKind, "app.admincam.enter");

    // A note reaches nobody, so it is legal even on the disconnect event — the one kind every
    // other action but vip is refused on.
    assert.equal((await post({ name: "leaver note", eventKind: "evt.player.disconnected", action: "note" })).status, 201);
    assert.equal((await post({ name: "leaver kick", eventKind: "evt.player.disconnected", action: "kick" })).status, 400);
  });
});

test("rule exemptions and the trial switch round-trip, validate, and survive a rename", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: unknown) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    const created = await post({
      name: "tk kick", eventKind: "evt.teamkill", action: "kick", reason: "no TK",
      immuneTags: ["staff", "trusted"], immuneRoleIds: ["123456789012345"], dryRun: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.rule.immuneTags, ["staff", "trusted"]);
    assert.deepEqual(created.body.rule.immuneRoleIds, ["123456789012345"]);
    assert.equal(created.body.rule.dryRun, true);
    const id = created.body.rule.id as string;

    // Defaults stay permissive: a rule that says nothing exempts nobody and really acts.
    const plain = await post({ name: "plain", eventKind: "evt.kill", action: "kick" });
    assert.deepEqual(plain.body.rule.immuneTags, []);
    assert.deepEqual(plain.body.rule.immuneRoleIds, []);
    assert.equal(plain.body.rule.dryRun, false);

    // A role id is a snowflake, and a role cannot be both required and exempt.
    assert.equal((await post({ name: "x", eventKind: "evt.kill", action: "kick", immuneRoleIds: ["nope"] })).status, 400);
    const both = await post({ name: "x", eventKind: "evt.kill", action: "kick", requireRoleIds: ["123456789012345"], immuneRoleIds: ["123456789012345"] });
    assert.equal(both.status, 400);
    assert.match(String((both.body.error as { message?: string })?.message), /both required and exempt/);

    // The PATCH door re-derives the whole rule, so anything missing from its merge list is reset.
    const renamed = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "tk kick 2" }) });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.body.rule.immuneTags, ["staff", "trusted"], "the exempt tags survived the rename");
    assert.deepEqual(renamed.body.rule.immuneRoleIds, ["123456789012345"]);
    assert.equal(renamed.body.rule.dryRun, true, "and so did the trial switch");

    // Coming off trial is an ordinary edit.
    const live = await jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ dryRun: false }) });
    assert.equal(live.body.rule.dryRun, false);
  });
});

test("a rule set saves as a named setup and applies to another server", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) })).body.server.id as string;
    const one = await mk("one");
    const two = await mk("two");

    // Two rules pinned to server one, and a community-wide rule that belongs to nobody's setup.
    await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "tk", eventKind: "evt.teamkill", action: "kick", reason: "no TK", serverId: one, immuneTags: ["staff"], escalateActions: ["permaban"] }) });
    await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "cam", eventKind: "app.admincam.enter", action: "note", serverId: one }) });
    await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "global", eventKind: "evt.kill", action: "message", reason: "hi" }) });

    const saved = await jf(`${base}/api/presets/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "house policy", serverId: one }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const applied = await jf(`${base}/api/servers/${two}/presets/rules/apply`, { method: "POST", headers: auth, body: JSON.stringify({ name: "house policy" }) });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));

    const all = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as { name: string; serverId: string | null; immuneTags: string[]; escalateActions: string[] }[];
    const onTwo = all.filter((r) => r.serverId === two);
    assert.deepEqual(onTwo.map((r) => r.name).sort(), ["cam", "tk"], "both pinned rules landed on the new server");
    assert.deepEqual(onTwo.find((r) => r.name === "tk")!.immuneTags, ["staff"], "with their exemptions…");
    assert.deepEqual(onTwo.find((r) => r.name === "tk")!.escalateActions, ["permaban"], "…and their ladders");
    // The community-wide rule was NOT copied: it already applies to server two, and duplicating
    // it per server would turn one policy into many that have to be edited in step.
    assert.equal(all.filter((r) => r.name === "global").length, 1);
    assert.equal(all.filter((r) => r.serverId === one).length, 2, "the source server is untouched");
  });
});

test("the rules listing reports when each rule last fired", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "tk", eventKind: "evt.teamkill", action: "kick", reason: "no TK" }) });
    const id = created.body.rule.id as string;

    // A rule nothing has fired yet is simply absent from the map — the page reads that as
    // "quiet", which is the honest answer and the one worth seeing.
    const listed = await jf(`${base}/api/enforcer/rules`, { headers: auth });
    assert.ok(listed.body.activity, "the listing carries an activity map");
    assert.ok(!(id in (listed.body.activity as Record<string, unknown>)), "a rule that has never fired is absent");
    assert.ok(typeof listed.body.activitySince === "string", "and says what window it counted over");
  });
});

/*
 * Native active hours: a rule may carry a wall-clock window (overnight-aware, optional weekdays
 * and timezone) gating when it fires. The native replacement for the retired profile trick of
 * flipping whole modules on a schedule.
 */
test("active hours round-trip, survive unrelated edits, and the junk shapes are refused", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "night", eventKind: "evt.teamkill", action: "kick", ...body }) });

    const created = await post({ activeHours: { start: "22:00", end: "6:00", daysOfWeek: ["fri", "SAT"], timezone: "America/New_York" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Times normalize to two-digit hours; day names normalize to the lowercase vocabulary.
    assert.deepEqual(created.body.rule.activeHours, { start: "22:00", end: "06:00", daysOfWeek: ["fri", "sat"], timezone: "America/New_York" });

    // A rename must not shake the window off (the PATCH merge-list trap).
    const renamed = await jf(`${base}/api/enforcer/rules/${created.body.rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "night TK" }) });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.body.rule.activeHours?.start, "22:00");

    // Clearing is an explicit null, back to always-on.
    const cleared = await jf(`${base}/api/enforcer/rules/${created.body.rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ activeHours: null }) });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.rule.activeHours, null);

    // Junk is refused loudly at save time, because the runtime window engine fails CLOSED on it —
    // a stored typo would silently turn the rule off, which nobody notices until a bad night.
    assert.equal((await post({ activeHours: { start: "ten pm", end: "06:00" } })).status, 400);
    assert.equal((await post({ activeHours: { start: "22:00" } })).status, 400, "an end is required");
    assert.equal((await post({ activeHours: { start: "22:00", end: "22:00" } })).status, 400, "a zero-length window means leave it off");
    assert.equal((await post({ activeHours: { start: "22:00", end: "06:00", daysOfWeek: ["funday"] } })).status, 400);
    assert.equal((await post({ activeHours: { start: "22:00", end: "06:00", timezone: "Mars/Olympus" } })).status, 400);
    assert.equal((await post({ activeHours: { start: "25:00", end: "06:00" } })).status, 400, "25:00 is not a time");
  });
});

test("population bounds and the safety limit round-trip, default sanely, and refuse nonsense", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "p", eventKind: "evt.teamkill", action: "kick", ...body }) });

    const plain = await post({});
    assert.equal(plain.status, 201);
    assert.equal(plain.body.rule.playersMin, 0);
    assert.equal(plain.body.rule.playersMax, 0);
    assert.equal(plain.body.rule.breakerLimit, 10, "the safety valve arms by default");

    const bounded = await post({ playersMin: 40, playersMax: 90, breakerLimit: 25 });
    assert.equal(bounded.status, 201);
    assert.equal(bounded.body.rule.playersMin, 40);
    assert.equal(bounded.body.rule.playersMax, 90);
    assert.equal(bounded.body.rule.breakerLimit, 25);

    // A rename keeps all three (the PATCH merge-list trap, again).
    const renamed = await jf(`${base}/api/enforcer/rules/${bounded.body.rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "renamed" }) });
    assert.equal(renamed.body.rule.playersMin, 40);
    assert.equal(renamed.body.rule.breakerLimit, 25);

    assert.equal((await post({ playersMin: 60, playersMax: 40 })).status, 400, "a floor above the ceiling matches no server");
    assert.equal((await post({ playersMin: -1 })).status, 400);
    assert.equal((await post({ playersMax: 500 })).status, 400);
    assert.equal((await post({ breakerLimit: "lots" })).status, 400);
    const off = await post({ breakerLimit: 0 });
    assert.equal(off.status, 201, "0 is a deliberate opt-out, allowed");
    assert.equal(off.body.rule.breakerLimit, 0);

    /*
     * A counting rule needs something to count within. The editor's blank rule starts at
     * threshold 1 / window 0, so raising the threshold and leaving the window is one click away —
     * and it used to save an enabled rule that could not fire once, with nothing saying why.
     */
    const noWindow = await post({ threshold: 8, windowSec: 0 });
    assert.equal(noWindow.status, 400, "N times within 0 seconds can never happen");
    assert.match(String((noWindow.body.error as { message?: string }).message), /window/i,
      "and the refusal names the field to fix");
    const windowed = await post({ threshold: 8, windowSec: 10 });
    assert.equal(windowed.status, 201, "with a window it is an ordinary counting rule");
    assert.equal(windowed.body.rule.threshold, 8);
    // A single-occurrence rule needs no window at all — that is the default shape.
    assert.equal((await post({ threshold: 1, windowSec: 0 })).status, 201);
  });
});

test("the no-VIP trigger carries VIP up to a year, and saving any VIP rule answers to vip.grant", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) })).body.server.id as string;
    const mine = await mk("mine"), theirs = await mk("theirs");
    const post = (body: Record<string, unknown>, h: Record<string, string> = auth) =>
      jf(`${base}/api/enforcer/rules`, { method: "POST", headers: h, body: JSON.stringify({ name: "Welcome VIP", eventKind: "app.state.no_vip", action: "vip", windowSec: 1800, ...body }) });

    // A day of VIP, once a month — the shape the trigger is for; a year is the ceiling.
    const ok = await post({ serverId: mine, vipMinutes: 1440, vipCooldownMinutes: 30 * 1440, reason: "VIP until {vip_until}", params: { minMinutesOnline: 20 } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.rule.vipMinutes, 1440);
    assert.equal(ok.body.rule.vipCooldownMinutes, 43200);
    assert.equal(ok.body.rule.params.minMinutesOnline, 20);
    assert.equal((await post({ serverId: mine, vipMinutes: 365 * 1440 + 1 })).status, 400);
    assert.equal((await post({ serverId: mine, action: "message", reason: "Get VIP on our Discord" })).status, 201, "message-only works too");
    assert.equal((await post({ serverId: mine, action: "vip", eventKind: "app.state.solo_tank" })).status, 400, "VIP stays off every other roster trigger");

    // A rule editor holding VIP grant on ONE server.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "rules-mod", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [
      { capability: "admin.moderation", level: "write", scopeType: "global", scopeId: null },
      { capability: "vip.grant", level: "write", scopeType: "server", scopeId: mine },
    ] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "rules-mod", password: "pw" }) });
    const mod = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await post({ serverId: mine }, mod)).status, 201, "their server: they hold the key");
    const rules = async () => (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as { id: string; vipMinutes: number; enabled: boolean; name: string }[];
    const before = (await rules()).length;
    // Without the key there, they ask for it — on that server — and nothing is saved.
    assert.deepEqual(await askedFor(base, auth, await post({ serverId: theirs }, mod)), { capability: "vip.grant", serverId: theirs }, "another server: they don't");
    assert.deepEqual(await askedFor(base, auth, await post({ serverId: null }, mod)), { capability: "vip.grant", serverId: null }, "community-wide needs the key everywhere");
    assert.equal((await rules()).length, before, "neither rule was created");
    assert.equal((await post({ serverId: theirs, action: "message", reason: "hi" }, mod)).status, 201, "a message rule needs no VIP key");

    // Someone else's VIP rule: they can reach for the brakes, not the dials.
    const other = await post({ serverId: theirs, vipMinutes: 60 });
    const id = other.body.rule.id as string;
    const patch = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules/${id}`, { method: "PATCH", headers: mod, body: JSON.stringify(body) });
    assertAsked(await patch({ vipMinutes: 600 }));
    assert.equal((await patch({ enabled: false })).status, 200, "switching it off only ever stops grants");
    assertAsked(await patch({ enabled: true }), "switching it back on is granting again");
    assertAsked(await patch({ enabled: false, name: "renamed" }), "any edit beyond switching off needs the key");
    const stood = (await rules()).find((r) => r.id === id)!;
    assert.deepEqual([stood.vipMinutes, stood.enabled, stood.name], [60, false, "Welcome VIP"], "only the switch-off landed");
    // Moving it onto a server where they DO hold the key is theirs to do.
    assert.equal((await patch({ serverId: mine })).status, 200);
  });
});

test("a rules setup or a scheduled profile cannot carry a VIP rule past the VIP grant key", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) })).body.server.id as string;
    const source = await mk("source"), target = await mk("target");
    await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Welcome VIP", serverId: source, eventKind: "app.state.no_vip", action: "vip", windowSec: 1800, vipMinutes: 1440 }) });
    assert.equal((await jf(`${base}/api/presets/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "with vip", serverId: source }) })).status, 200);
    await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "TK kick", serverId: target, eventKind: "evt.teamkill", action: "kick" }) });
    assert.equal((await jf(`${base}/api/presets/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "no vip", serverId: target }) })).status, 200);

    // Rule editing and profiles on the target, no VIP grant anywhere.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "setup-mod", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [
      { capability: "admin.moderation", level: "write", scopeType: "global", scopeId: null },
      { capability: "autosettings.profiles", level: "write", scopeType: "global", scopeId: null },
    ] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "setup-mod", password: "pw" }) });
    const mod = { authorization: `Bearer ${l.body.token as string}` };

    const apply = (name: string, h: Record<string, string>) => jf(`${base}/api/servers/${target}/presets/rules/apply`, { method: "POST", headers: h, body: JSON.stringify({ name }) });
    const onTarget = async () => ((await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as { serverId: string | null }[]).filter((r) => r.serverId === target).length;
    const targetRules = await onTarget();
    assert.deepEqual(await askedFor(base, auth, await apply("with vip", mod)), { capability: "vip.grant", serverId: target }, "the setup's VIP rule would land on a server they cannot grant VIP on");
    assert.equal(await onTarget(), targetRules, "nothing was applied");
    assert.equal((await apply("no vip", mod)).status, 200, "a setup without one is theirs to apply");

    const profiles = (preset: string) => ({ profiles: [{ name: "evening", spec: { start: "18:00", end: "23:00" }, settings: { "preset:rules": preset } }] });
    const put = (body: unknown, h: Record<string, string>) => jf(`${base}/api/servers/${target}/autosettings`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    assert.deepEqual(await askedFor(base, auth, await put(profiles("with vip"), mod)), { capability: "vip.grant", serverId: target }, "scheduling that setup is the same side door");
    const scheduled = (await jf(`${base}/api/servers/${target}/autosettings`, { headers: auth })).body.config?.profiles ?? [];
    assert.ok(!JSON.stringify(scheduled).includes("with vip"), "nothing was scheduled");
    assert.equal((await put(profiles("no vip"), mod)).status, 200);
    // The owner schedules the VIP setup; the moderator can still save the profile around it.
    assert.equal((await put(profiles("with vip"), auth)).status, 200);
    const standing = { profiles: [{ name: "evening", spec: { start: "18:00", end: "22:00" }, settings: { "preset:rules": "with vip" } }] };
    assert.equal((await put(standing, mod)).status, 200, "a choice already standing is not re-asked");
  });
});

test("rule conditions: match window, per-match counting, tag gate and cap validate, and survive an edit", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", eventKind: "evt.teamkill", action: "message", reason: "hi", ...body }) });
    // Per match is a window of its own — no windowSec needed.
    const perMatch = await post({ threshold: 3, windowSec: 0, countPerMatch: true });
    assert.equal(perMatch.status, 201, JSON.stringify(perMatch.body));
    assert.equal(perMatch.body.rule.countPerMatch, true);
    assert.equal((await post({ threshold: 3, windowSec: 0 })).status, 400, "without it, 3 in 0 seconds still cannot fire");
    // …and means nothing where nothing is counted.
    const state = await post({ eventKind: "app.state.no_leader", countPerMatch: true, windowSec: 60 });
    assert.equal(state.body.rule.countPerMatch, false);
    // The match window.
    assert.equal((await post({ matchMinutesMin: 10, matchMinutesMax: 5 })).status, 400, "a window that can never open");
    assert.equal((await post({ matchMinutesMax: 601 })).status, 400);
    // Tags: required and exempt cannot be the same tag.
    assert.equal((await post({ requireTags: ["new"], immuneTags: ["new"] })).status, 400);
    // The cap.
    assert.equal((await post({ capCount: -1 })).status, 400);
    assert.equal((await post({ capCount: 1, capPeriod: "fortnight" })).status, 400);
    const full = await post({ matchMinutesMin: 5, matchMinutesMax: 40, requireTags: ["watch"], capCount: 2, capPeriod: "match" });
    assert.equal(full.status, 201);
    // A rename must not reset any of them (ruleBodyFrom carries every field the parser reads).
    const renamed = await jf(`${base}/api/enforcer/rules/${full.body.rule.id as string}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "renamed" }) });
    assert.equal(renamed.status, 200);
    const r = renamed.body.rule;
    assert.deepEqual([r.matchMinutesMin, r.matchMinutesMax, r.requireTags, r.capCount, r.capPeriod], [5, 40, ["watch"], 2, "match"]);
    const pm = await jf(`${base}/api/enforcer/rules/${perMatch.body.rule.id as string}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "renamed" }) });
    assert.equal(pm.body.rule.countPerMatch, true);
  });
});

test("switch, tag and points: validated where they sit, and points/tags answer to their own keys", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: Record<string, unknown>, h: Record<string, string> = auth) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: h, body: JSON.stringify({ name: "x", eventKind: "evt.teamkill", ...body }) });
    assert.equal((await post({ action: "switch" })).status, 201);
    assert.equal((await post({ action: "tag" })).status, 400, "a tag step needs the tag");
    assert.equal((await post({ action: "message", reason: "x", escalateActions: ["tag"] })).status, 400, "…wherever it sits");
    const tagged = await post({ action: "message", reason: "x", escalateActions: ["tag"], actionTag: "warned" });
    assert.equal(tagged.status, 201);
    assert.equal(tagged.body.rule.actionTag, "warned");
    assert.equal((await post({ action: "points" })).status, 400, "a points rule needs points");
    assert.equal((await post({ action: "points", points: 100001 })).status, 400);
    const paid = await post({ action: "points", points: 50 });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.rule.points, 50);
    assert.equal((await post({ action: "points", points: 5, escalateActions: ["kick"] })).status, 400, "a reward does not escalate");
    assert.equal((await post({ action: "message", reason: "x", escalateActions: ["points"] })).status, 400, "…and nothing escalates into one");
    assert.equal((await post({ eventKind: "evt.player.disconnected", action: "switch" })).status, 400, "a player who left cannot be switched");
    // Values that mean nothing for the action are not stored.
    assert.equal((await post({ action: "kick", points: 9, actionTag: "stray" })).body.rule.points, 0);

    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "rules-only", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [
      { capability: "admin.moderation", level: "write", scopeType: "global", scopeId: null },
    ] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "rules-only", password: "pw" }) });
    const mod = { authorization: `Bearer ${l.body.token as string}` };
    const count = async () => ((await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as unknown[]).length;
    const before = await count();
    assert.equal((await askedFor(base, auth, await post({ action: "points", points: 5 }, mod))).capability, "economy.payout", "paying points mints currency — the payout key");
    assert.equal((await askedFor(base, auth, await post({ action: "tag", actionTag: "x" }, mod))).capability, "player.tags", "writing tags takes the tag key");
    assert.equal(await count(), before, "neither rule was created");
    assert.equal((await post({ action: "switch" }, mod)).status, 201, "a switch is moderation like a kick");
  });
});

test("the new roster triggers save with their knobs; VIP rides on a playtime milestone, not on the others", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const post = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "x", windowSec: 1800, ...body }) });
    const loyalty = await post({ eventKind: "app.state.playtime", action: "vip", vipMinutes: 7 * 1440, vipCooldownMinutes: 30 * 1440, params: { hours: 50, periodDays: 30, allServers: true } });
    assert.equal(loyalty.status, 201, JSON.stringify(loyalty.body));
    assert.deepEqual(loyalty.body.rule.params, { hours: 50, periodDays: 30, allServers: true });
    assert.equal((await post({ eventKind: "app.state.no_discord", action: "message", reason: "Link your Discord: /register" })).status, 201);
    assert.equal((await post({ eventKind: "app.state.no_discord", action: "vip" })).status, 400);
    assert.equal((await post({ eventKind: "app.state.kill_rate", action: "note", params: { killsPer10Min: 0, minKd: 0 } })).status, 400, "both limits off matches nobody");
    assert.equal((await post({ eventKind: "app.state.kill_rate", action: "vip" })).status, 400);
    assert.equal((await post({ eventKind: "app.state.kill_rate", action: "note", params: { minKills: 40, killsPer10Min: 30 } })).status, 201);
    // A ratio of this match's counts: stored in one spelling, its limit to two places, and refused
    // when it would match everyone who reaches the minimum.
    const ratio = await post({ eventKind: "app.state.ratio", action: "note", params: { ratio: "TeamKills:Kills", direction: "above", limit: 1.256, minCount: 12 } });
    assert.equal(ratio.status, 201, JSON.stringify(ratio.body));
    assert.deepEqual(ratio.body.rule.params, { ratio: "teamkills:kills", direction: "above", limit: 1.26, minCount: 12 });
    assert.equal(ratio.body.rule.windowSec, 1800, "a roster check's re-check interval, as asked");
    const refused = async (params: Record<string, unknown>) => {
      const res = await post({ eventKind: "app.state.ratio", action: "note", params });
      assert.equal(res.status, 400);
      return String((res.body.error as { message?: string })?.message);
    };
    assert.match(await refused({ limit: 0 }), /matches everyone/);
    assert.match(await refused({ ratio: "kills:kills" }), /Ratio must be one of/);
    assert.equal((await post({ eventKind: "app.state.ratio", action: "vip" })).status, 400);
    // Points on a roster trigger re-pay every re-check unless the rule says how often.
    assert.equal((await post({ eventKind: "app.state.playtime", action: "points", points: 100 })).status, 400);
    assert.equal((await post({ eventKind: "app.state.playtime", action: "points", points: 100, capCount: 1, capPeriod: "ever" })).status, 201);
  });
});

test("a rule today's checks refuse can still be switched off — and nothing else", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    // Stored before team-switch rules were refused the move.
    const legacy = await repo.enforcerRules.create({ serverId: null, name: "legacy move", eventKind: "evt.player.teamSwitched", action: "switch", reason: "" } as any);
    const off = await jf(`${base}/api/enforcer/rules/${legacy.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.rule.enabled, false);
    assert.equal(off.body.rule.action, "switch", "only the switch moved");
    const on = await jf(`${base}/api/enforcer/rules/${legacy.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: true }) });
    assert.equal(on.status, 400, "back on is an edit like any other — refused until the action is fixed");
    const fixed = await jf(`${base}/api/enforcer/rules/${legacy.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: true, action: "message", reason: "no swapping" }) });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  });
});

// Rule sections: shelves the Rules page sorts rules onto. Organisation only.
test("rule sections: made, renamed, filled, emptied — and a removed section never takes its rules", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const tag = Math.random().toString(36).slice(2, 7); // unique names: against Postgres the file shares one database
    const post = (path: string, body: unknown, method = "POST") => jf(`${base}/api/enforcer/${path}`, { method, headers: auth, body: JSON.stringify(body) });

    const levels = await post("sections", { name: `Player level rules ${tag}` });
    assert.equal(levels.status, 201, JSON.stringify(levels.body));
    const sectionId = levels.body.section.id as string;
    assert.equal((await post("sections", { name: `PLAYER LEVEL RULES ${tag}` })).status, 409, "names are unique ignoring case");
    assert.equal((await post("sections", { name: "   " })).status, 400);

    // A rule can be made straight onto a section, or filed later in a batch.
    const a = await post("rules", { name: `a ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi", sectionId });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.rule.sectionId, sectionId);
    const b = (await post("rules", { name: `b ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi" })).body.rule;
    const c = (await post("rules", { name: `c ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi" })).body.rule;
    assert.equal(b.sectionId, null);
    assert.equal((await post("rules", { name: `d ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi", sectionId: "00000000-0000-4000-8000-000000000000" })).status, 400, "an unknown section is refused");

    const moved = await post("sections/assign", { ruleIds: [b.id, c.id], sectionId });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.moved, 2);
    const listed = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body;
    assert.ok((listed.sections as any[]).some((x) => x.id === sectionId), "the page gets its sections with its rules");
    assert.deepEqual((listed.rules as any[]).filter((r) => r.sectionId === sectionId).map((r) => r.name).sort(), [`a ${tag}`, `b ${tag}`, `c ${tag}`]);

    // An edit that says nothing about the section leaves it; one that names none unfiles it.
    const renamed = await post(`rules/${b.id}`, { name: `b2 ${tag}` }, "PATCH");
    assert.equal(renamed.body.rule.sectionId, sectionId);
    const unfiled = await post(`rules/${b.id}`, { sectionId: null }, "PATCH");
    assert.equal(unfiled.status, 200, JSON.stringify(unfiled.body));
    assert.equal(unfiled.body.rule.sectionId, null);
    // Filing touches nothing a rule does.
    const after = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules.find((r: any) => r.id === c.id);
    assert.equal(after.action, "message");
    assert.equal(after.enabled, true);

    assert.equal((await post(`sections/${sectionId}`, { name: `Levels ${tag}` }, "PATCH")).body.section.name, `Levels ${tag}`);
    assert.equal((await post("sections/assign", { ruleIds: ["nope"], sectionId })).status, 404, "a vanished rule says so");

    const gone = await jf(`${base}/api/enforcer/sections/${sectionId}`, { method: "DELETE", headers: auth });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.rulesUnfiled, 2);
    const rules = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as any[];
    assert.ok([a.body.rule.id, c.id].every((id) => rules.some((r) => r.id === id && r.sectionId === null)), "its rules stay, on no section");
    const audit = (await jf(`${base}/api/audit?limit=50`, { headers: auth })).body.entries as any[];
    assert.ok(audit.some((e) => e.action === "rule.section.assign"));
  });
});

test("a section's master switch: off holds its rules, their own switches kept; on restores them — one audit line each way", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const tag = Math.random().toString(36).slice(2, 7);
    const post = (path: string, body: unknown, method = "POST") => jf(`${base}/api/enforcer/${path}`, { method, headers: auth, body: JSON.stringify(body) });
    const sec = (await post("sections", { name: `Event rules ${tag}` })).body.section;
    assert.equal(sec.enabled, true, "a section starts on");
    const on = (await post("rules", { name: `on ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi", sectionId: sec.id })).body.rule;
    const own = (await post("rules", { name: `own off ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi", sectionId: sec.id, enabled: false })).body.rule;
    assert.equal((await post(`sections/${sec.id}`, { enabled: "no" }, "PATCH")).status, 400);
    assert.equal((await post(`sections/${sec.id}`, {}, "PATCH")).status, 400, "nothing to change");

    const off = await post(`sections/${sec.id}`, { enabled: false }, "PATCH");
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.section.enabled, false);
    assert.equal(off.body.section.name, `Event rules ${tag}`, "the name is left alone");
    const listed = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body;
    assert.equal((listed.sections as any[]).find((x) => x.id === sec.id).enabled, false);
    const byId = (id: string) => (listed.rules as any[]).find((r) => r.id === id);
    assert.equal(byId(on.id).sectionOff, true, "the page is told why the rule is off");
    assert.equal(byId(on.id).enabled, true, "its own switch is kept");
    assert.equal(byId(own.id).enabled, false);
    // An edit to a held rule keeps it held and keeps its own switch.
    const edited = await post(`rules/${on.id}`, { reason: "edited" }, "PATCH");
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.rule.enabled, true);
    assert.equal(edited.body.rule.sectionOff, true);

    assert.equal((await post(`sections/${sec.id}`, { enabled: false }, "PATCH")).status, 200, "off again is a no-op, not an error");
    const back = await post(`sections/${sec.id}`, { enabled: true }, "PATCH");
    assert.equal(back.body.section.enabled, true);
    const audit = ((await jf(`${base}/api/audit?limit=100`, { headers: auth })).body.entries as any[])
      .filter((e) => e.action === "rule.section.switch" && e.targetId === sec.id);
    assert.equal(audit.length, 2, "one line off, one line on — the repeated off wrote nothing");
    assert.ok(audit.some((e) => /switched the rule section .* off — its 2 rules hold fire/.test(e.summary)));
    assert.ok(audit.some((e) => /back on — 1 of its 2 rules is on again/.test(e.summary)));
  });
});

test("removing a switched-off section sets none of its rules firing: the ones that were on are switched off", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const tag = Math.random().toString(36).slice(2, 7);
    const post = (path: string, body: unknown, method = "POST") => jf(`${base}/api/enforcer/${path}`, { method, headers: auth, body: JSON.stringify(body) });
    const rule = async (name: string, sectionId: string, enabled = true) => (await post("rules", { name, eventKind: "evt.kill", action: "kick", reason: "no", sectionId, enabled })).body.rule;

    const offSec = (await post("sections", { name: `Held ${tag}` })).body.section;
    const a = await rule(`a ${tag}`, offSec.id);
    const b = await rule(`b ${tag}`, offSec.id, false);
    await post(`sections/${offSec.id}`, { enabled: false }, "PATCH");
    const gone = await jf(`${base}/api/enforcer/sections/${offSec.id}`, { method: "DELETE", headers: auth });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.switchedOff, 1);
    const listed = (await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as any[];
    const byId = (id: string) => listed.find((r) => r.id === id);
    assert.equal(byId(a.id).enabled, false, "held by the section, it stays off rather than starting to kick");
    assert.equal(byId(a.id).sectionId, null);
    assert.equal(byId(a.id).sectionOff, false);
    assert.equal(byId(b.id).enabled, false, "already off, still off");
    const trail = ((await jf(`${base}/api/audit?limit=50`, { headers: auth })).body.entries as any[]).find((e) => e.action === "rule.section.delete" && e.targetId === offSec.id);
    assert.match(trail.summary, /the 1 that was on was switched off rather than set firing/);

    // A section that is on holds nothing: its rules carry on exactly as they were.
    const onSec = (await post("sections", { name: `Open ${tag}` })).body.section;
    const c = await rule(`c ${tag}`, onSec.id);
    const kept = await jf(`${base}/api/enforcer/sections/${onSec.id}`, { method: "DELETE", headers: auth });
    assert.equal(kept.body.switchedOff, 0);
    assert.equal(((await jf(`${base}/api/enforcer/rules`, { headers: auth })).body.rules as any[]).find((r) => r.id === c.id).enabled, true);
  });
});

test("pause a rule: minutes or a date, a reason required, an edit keeps it, Resume lifts it — each said once in the trail", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const tag = Math.random().toString(36).slice(2, 7);
    const post = (path: string, body: unknown, method = "POST") => jf(`${base}/api/enforcer/${path}`, { method, headers: auth, body: JSON.stringify(body) });
    const rule = (await post("rules", { name: `pause ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi" })).body.rule;

    assert.equal((await post(`rules/${rule.id}/pause`, { minutes: 30 })).status, 400, "a reason is required");
    assert.equal((await post(`rules/${rule.id}/pause`, { minutes: 30, reason: "  " })).status, 400);
    assert.equal((await post(`rules/${rule.id}/pause`, { reason: "x" })).status, 400, "how long is required");
    assert.equal((await post(`rules/${rule.id}/pause`, { minutes: 0, reason: "x" })).status, 400);
    assert.equal((await post(`rules/${rule.id}/pause`, { minutes: 30, until: new Date(Date.now() + 3_600_000).toISOString(), reason: "x" })).status, 400, "one or the other");
    assert.equal((await post(`rules/${rule.id}/pause`, { until: new Date(Date.now() - 60_000).toISOString(), reason: "x" })).status, 400, "the past is no pause");
    assert.equal((await post(`rules/${rule.id}/pause`, { until: new Date(Date.now() + 400 * 86_400_000).toISOString(), reason: "x" })).status, 400, "a year at most");
    assert.equal((await post("rules/00000000-0000-4000-8000-000000000000/pause", { minutes: 30, reason: "x" })).status, 404);

    const before = Date.now();
    const paused = await post(`rules/${rule.id}/pause`, { minutes: 30, reason: "event night" });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const untilMs = Date.parse(paused.body.rule.pausedUntil);
    assert.ok(untilMs >= before + 30 * 60_000 - 1000 && untilMs <= Date.now() + 30 * 60_000 + 1000, "thirty minutes from now");
    assert.equal(paused.body.rule.pauseReason, "event night");
    assert.equal(paused.body.rule.pausedBy, "owner", "who paused it");
    assert.equal(paused.body.rule.enabled, true, "the rule's own switch is untouched");
    // An edit through the editor keeps the pause.
    const edited = await post(`rules/${rule.id}`, { reason: "edited" }, "PATCH");
    assert.equal(edited.body.rule.pausedUntil, paused.body.rule.pausedUntil);

    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const dated = await post(`rules/${rule.id}/pause`, { until, reason: "the weekend" });
    assert.equal(dated.status, 200);
    assert.equal(dated.body.rule.pausedUntil, new Date(Date.parse(until)).toISOString());

    const resumed = await jf(`${base}/api/enforcer/rules/${rule.id}/pause`, { method: "DELETE", headers: auth });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.rule.pausedUntil, null);
    // Nothing left to lift: answered, and nothing said.
    assert.equal((await jf(`${base}/api/enforcer/rules/${rule.id}/pause`, { method: "DELETE", headers: auth })).status, 200);
    const trail = ((await jf(`${base}/api/audit?limit=100`, { headers: auth })).body.entries as any[]).filter((e) => e.targetId === rule.id);
    assert.equal(trail.filter((e) => e.action === "rule.pause").length, 2);
    assert.ok(trail.some((e) => e.action === "rule.pause" && /until .* UTC — event night/.test(e.summary)));
    assert.equal(trail.filter((e) => e.action === "rule.resume").length, 1, "one resume line, not two");
    assert.match(trail.find((e) => e.action === "rule.resume").summary, /resumed rule .* early — it was paused until .* by owner \(the weekend\)/);
  });
});

test("a saved rules setup carries its rules' sections by name, and makes them where they are missing", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const tag = Math.random().toString(36).slice(2, 7);
    const mk = async (name: string) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) })).body.server.id as string;
    const one = await mk(`one ${tag}`);
    const two = await mk(`two ${tag}`);
    const section = (await jf(`${base}/api/enforcer/sections`, { method: "POST", headers: auth, body: JSON.stringify({ name: `Group rules ${tag}` }) })).body.section;
    await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: `filed ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi", serverId: one, sectionId: section.id }) });
    await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: `loose ${tag}`, eventKind: "evt.kill", action: "message", reason: "hi", serverId: one }) });
    assert.equal((await jf(`${base}/api/presets/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: `sections ${tag}`, serverId: one }) })).status, 200);

    // The section is gone by the time the setup is applied: it comes back, by name.
    await jf(`${base}/api/enforcer/sections/${section.id}`, { method: "DELETE", headers: auth });
    const applied = await jf(`${base}/api/servers/${two}/presets/rules/apply`, { method: "POST", headers: auth, body: JSON.stringify({ name: `sections ${tag}` }) });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const sections = await repo.ruleSections.list();
    const remade = sections.find((x) => x.name === `Group rules ${tag}`);
    assert.ok(remade, "made again under its name");
    const onTwo = (await repo.enforcerRules.list()).filter((r) => r.serverId === two);
    assert.equal(onTwo.find((r) => r.name === `filed ${tag}`)?.sectionId, remade!.id);
    assert.equal(onTwo.find((r) => r.name === `loose ${tag}`)?.sectionId, null);
  });
});
