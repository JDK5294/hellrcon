/**
 * The automation firing history (Auto settings → History): one paged, filterable read over the
 * audit trail, scoped to AUTOMATION actors by action-prefix allowlist. The scoping is the
 * load-bearing part — this endpoint is gated on the automation config capabilities, NOT the audit
 * capability, so it must be impossible to read a staff member's own actions through it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Repository } from "@app/db";
import { withServer, withIsolatedServer, jf, ownerAuth } from "./harness.ts";

test("history: automation rows only, filterable by family, rule and text, orderable, paged", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    // A beat between rows: audit stamps its own clock, and same-millisecond rows tie — the time
    // ordering under test must not depend on how uuids happen to sort.
    const a = async (input: Parameters<Repository["audit"]["create"]>[0]) => { await repo.audit.create(input); await new Promise((r) => setTimeout(r, 5)); };
    await a({ actorUserId: null, actorName: "enforcer", action: "enforcer.kick", targetType: "player", targetId: "p1", targetName: "Griefer", summary: "kick Griefer — TK policy", data: { ruleId: "r-1" } });
    await a({ actorUserId: null, actorName: "enforcer", action: "enforcer.message", targetType: "player", targetId: "p2", targetName: "Newbie", summary: "message Newbie — solo tank", data: { ruleId: "r-2" } });
    await a({ actorUserId: null, actorName: "enforcer", action: "rule.breaker", targetType: "rule", targetId: "r-1", targetName: "TK policy", summary: "rule DISABLED ITSELF", data: { ruleId: "r-1" } });
    await a({ actorUserId: null, actorName: "seeding", action: "seed.warn", targetType: "player", targetId: "p3", targetName: "Arty", summary: "warned Arty — artillery while seeding" });
    await a({ actorUserId: null, actorName: "auto settings", action: "autosettings.apply", targetType: "server", targetId: "s1", summary: "applied profile night" });
    // STAFF actions — the one thing this endpoint must never serve. The second row wears an
    // allowlisted prefix on purpose: the automated-at-write-time flag is the fence that holds
    // even if an action name strays into automation territory (rule edits are exactly that —
    // "rule.create" is a staff act living beside the automated "rule.breaker").
    await a({ actorUserId: "u-1", actorName: "AdminAlice", action: "player.kick", targetType: "player", targetId: "p9", targetName: "Somebody", summary: "AdminAlice kicked Somebody" });
    await a({ actorUserId: "u-1", actorName: "AdminAlice", action: "rule.create", targetType: "rule", targetId: "r-9", targetName: "New rule", summary: "AdminAlice created rule" });

    const all = await jf(`${base}/api/automation/history`, { headers: auth });
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 5, "five automation rows; neither staff action is among them");
    assert.ok(!(all.body.entries as any[]).some((e) => e.action === "player.kick"), "a staff action can never leak through the prefix allowlist");
    assert.ok(!(all.body.entries as any[]).some((e) => e.action === "rule.create"), "even under an allowlisted prefix, a HUMAN row never leaks — the automated flag is the fence");
    assert.equal((all.body.entries as any[])[0].action, "autosettings.apply", "newest first by default");

    const seedOnly = await jf(`${base}/api/automation/history?sources=seeding`, { headers: auth });
    assert.deepEqual((seedOnly.body.entries as any[]).map((e) => e.action), ["seed.warn"]);

    const perRule = await jf(`${base}/api/automation/history?ruleId=r-1`, { headers: auth });
    assert.deepEqual((perRule.body.entries as any[]).map((e) => e.action).sort(), ["enforcer.kick", "rule.breaker"], "the per-rule view: firings AND its breaker trip");

    const searched = await jf(`${base}/api/automation/history?q=solo%20tank`, { headers: auth });
    assert.deepEqual((searched.body.entries as any[]).map((e) => e.action), ["enforcer.message"]);

    const asc = await jf(`${base}/api/automation/history?order=asc&limit=1`, { headers: auth });
    assert.equal((asc.body.entries as any[])[0].action, "enforcer.kick", "asc starts at the oldest");
    assert.equal(asc.body.total, 5, "the total ignores the page size");

    assert.equal((await jf(`${base}/api/automation/history?sources=nonsense`, { headers: auth })).status, 400);
  });
});

test("history: gated on the automation capabilities, not on the audit trail", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    assert.equal((await jf(`${base}/api/automation/history`, { headers: { authorization: `Bearer ${l.body.token as string}` } })).status, 403);
    assert.equal((await jf(`${base}/api/automation/history`)).status, 401);
  });
});

/*
 * Seeding and Auto settings are granted per server, and the history answered for every server
 * whatever the grant said: staff trusted with one server's seeding read every other server's
 * automation. Each server's rows now go to whoever holds one of the three on it; the rows of no
 * server (a community-wide schedule) to someone who sees every server, as Staff activity keeps them.
 */
test("history: each server's automation to the staff who hold its automation permissions", async () => {
  await withIsolatedServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const alpha = await repo.servers.create({ name: "Alpha", host: "h", port: 71, password: "p" });
    const bravo = await repo.servers.create({ name: "Bravo", host: "h", port: 72, password: "p" });
    await repo.audit.create({ actorUserId: null, actorName: "seeding", action: "seed.warn", targetType: "player", targetId: "p1", serverId: alpha.id, summary: "warned on Alpha" });
    await repo.audit.create({ actorUserId: null, actorName: "seeding", action: "seed.warn", targetType: "player", targetId: "p2", serverId: bravo.id, summary: "warned on Bravo" });
    await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "enforcer.schedule", targetType: "rule", targetId: "r1", summary: "a community-wide schedule ran" });
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "alpha-seeder", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "seeding.config", level: "read", scopeType: "server", scopeId: alpha.id }] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "alpha-seeder", password: "pw" }) });
    const seeder = { authorization: `Bearer ${l.body.token as string}` };

    const servers = async (headers: Record<string, string>, q = "") => {
      const r = await jf(`${base}/api/automation/history${q}`, { headers });
      return { status: r.status, servers: ((r.body.entries ?? []) as { serverId: string | null }[]).map((e) => e.serverId), total: r.body.total };
    };
    const mine = await servers(seeder);
    assert.deepEqual(mine.servers, [alpha.id], "their server's automation, and nothing of another's or of none");
    assert.equal(mine.total, 1, "the count is held to the same rule as the rows");
    assert.equal((await servers(seeder, `?serverId=${bravo.id}`)).status, 403, "naming another server is refused");
    assert.deepEqual((await servers(seeder, `?serverId=${alpha.id}`)).servers, [alpha.id]);
    const everything = await servers(auth);
    assert.deepEqual([...everything.servers].sort(), [alpha.id, bravo.id, null].sort(), "the owner sees every server's and the community-wide row");
  });
});

test("history: a seeding row names its rule; the ground rules' detail reaches holders of the rules permission", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const seed = (action: string, targetName: string, summary: string, data: Record<string, unknown>) =>
      repo.audit.create({ actorUserId: null, actorName: "seeding", action, targetType: "player", targetId: `id-${targetName}`, targetName, serverId: null, summary, data });
    // As the worker writes them: open rules named in the line, the ground rules plain.
    await seed("seed.warn", "Rolly", "warn Rolly — seeding, disallowed role: Tank Commander (warning 1 of 2)",
      { message: "Seeding rules: Tank Commander is not allowed while seeding.", rule: "role", detail: "Tank Commander", step: { n: 1, of: 2 } });
    await seed("seed.punish", "Fenced", "punish Fenced — seeding rule (punish 1 of 2)",
      { message: "Seeding rules: stay in the seeding area.", rule: "zone", detail: "outside their team's drawn area", step: { n: 1, of: 2 } });
    await seed("seed.kick", "Racer", "[dry-run] would kick Racer — seeding rule",
      { message: "Kicked.", rule: "pace", detail: "reached point 4 before it opens at minute 40", dryRun: true });
    await seed("seed.warn", "Pusher", "warn Pusher — seeding, cap fight: their team already held 3 caps (warning 1 of 2)",
      { message: "No pushing.", rule: "capFight", detail: "their team already held 3 caps", byPosition: true, step: { n: 1, of: 2 } });
    // From before reasons were recorded: only the message the player was sent.
    await seed("seed.warn", "Oldie", "warn Oldie — seeding rule", { message: "Seeding rules: stay in the seeding area." });

    const lines = async (auth: Record<string, string>, path = "/api/automation/history?sources=seeding&limit=50") => {
      const r = await jf(`${base}${path}`, { headers: auth });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return new Map((r.body.entries as any[]).filter((e) => e.action.startsWith("seed.")).map((e) => [e.targetName as string, e]));
    };

    // The owner holds everything: every line whole.
    const full = await lines(owner);
    assert.equal(full.get("Rolly").summary, "warn Rolly — seeding, disallowed role: Tank Commander (warning 1 of 2)");
    assert.equal(full.get("Fenced").summary, "punish Fenced — seeding area: outside their team's drawn area (punish 1 of 2)");
    assert.equal(full.get("Racer").summary, "[dry-run] would kick Racer — steamroll protection: reached point 4 before it opens at minute 40");
    assert.equal(full.get("Pusher").summary, "warn Pusher — seeding, cap fight by position: past the front line, their team already held 3 caps (warning 1 of 2)");
    assert.equal(full.get("Oldie").summary, "warn Oldie — seeding rule: “Seeding rules: stay in the seeding area.”", "an old row's message is its best why");

    const staffWith = async (username: string, extra: string[]) => {
      const created = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
      const userId = (created.body.user as { id: string }).id;
      const set = await jf(`${base}/api/users/${userId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [
        { capability: "seeding.config", level: "read", scopeType: "global", scopeId: null },
        { capability: "audit.trail", level: "read", scopeType: "global", scopeId: null },
        ...extra.map((capability) => ({ capability, level: "read", scopeType: "global", scopeId: null })),
      ] }) });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
      return { authorization: `Bearer ${login.body.token as string}` };
    };

    // Staff holding the rules permission (the Map zones page the ground rules live on): whole lines too.
    const moderator = await staffWith("modstaff", ["admin.moderation"]);
    for (const path of ["/api/automation/history?sources=seeding&limit=50", "/api/audit?limit=50"]) {
      const whole = await lines(moderator, path);
      assert.equal(whole.get("Fenced").summary, "punish Fenced — seeding area: outside their team's drawn area (punish 1 of 2)", path);
      assert.equal(whole.get("Racer").summary, "[dry-run] would kick Racer — steamroll protection: reached point 4 before it opens at minute 40", path);
    }

    // Seeding staff without it: the lines as written, and data that says nothing more, on every
    // row alike.
    const seedOnly = await staffWith("seedstaff", []);
    for (const path of ["/api/automation/history?sources=seeding&limit=50", "/api/audit?limit=50"]) {
      const plain = await lines(seedOnly, path);
      assert.equal(plain.get("Rolly").summary, "warn Rolly — seeding, disallowed role: Tank Commander (warning 1 of 2)", `${path}: an open rule is named for everyone`);
      assert.equal(plain.get("Fenced").summary, "punish Fenced — seeding rule (punish 1 of 2)", path);
      assert.equal(plain.get("Racer").summary, "[dry-run] would kick Racer — seeding rule", path);
      assert.equal(plain.get("Pusher").summary, "warn Pusher — seeding, cap fight: their team already held 3 caps (warning 1 of 2)", `${path}: a positional cap fight reads like any other`);
      assert.equal(plain.get("Oldie").summary, "warn Oldie — seeding rule", path);
      const wire = JSON.stringify([...plain.values()].map((e) => e.data));
      for (const secret of ["zone", "pace", "drawn area", "minute 40", "byPosition", "seeding area", "stay in"]) {
        assert.ok(!wire.includes(secret), `${path}: "${secret}" must not ride the wire to this reader: ${wire}`);
      }
      assert.deepEqual(plain.get("Racer").data, { dryRun: true });
      assert.deepEqual(plain.get("Rolly").data, { step: { n: 1, of: 2 } });
    }
  });
});
