/**
 * One entry of the trail in full (GET /api/audit/:id, audit-changes.ts): what its action changed,
 * setting by setting, before and after — from the record itself, from a record's version history,
 * or, for an older auto settings save, from the save before it — and everything else it holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "@app/access";
import { jsonFetch as jf, ownerAuth, withServer } from "./harness.ts";

type Repo = Parameters<Parameters<typeof withServer>[0]>[1];
type Change = { where: string[]; before: string | null; after: string | null };

/** A signed-in account holding exactly these grants. */
async function signIn(base: string, repo: Repo, grants: { capability: string; level?: "read" | "write"; serverId?: string }[]) {
  const user = await repo.users.create({ username: `u-${Math.random().toString(36).slice(2, 8)}`, passwordHash: await hashPassword("pw"), email: null });
  for (const g of grants) {
    await repo.grants.create({ userId: user.id, capability: g.capability, scopeType: g.serverId ? "server" : "global", scopeId: g.serverId ?? null, level: g.level ?? "read" });
  }
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: user.username, password: "pw" }) });
  return { authorization: `Bearer ${login.body.token}` };
}
const line = (items: Change[], where: string[]) => items.find((c) => c.where.join(" · ") === where.join(" · "));

test("an auto settings save keeps what it replaced, and its entry says exactly what changed, profile by profile", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const server = await repo.servers.create({ name: "Vietnam #1", game: "hll", host: "10.0.0.9", port: 9, password: "x" } as never);
    const put = (body: object) => jf(`${base}/api/servers/${server.id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    const night = { name: "Night", spec: { playersBelow: 40, daysOfWeek: ["fri", "sat"] }, settings: { autoBalanceEnabled: true, idleKick: 10 } };
    const first = await put({ enabled: true, dryRun: true, timezone: "UTC", profiles: [night], matchMessages: [] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await put({
      enabled: true, dryRun: false, timezone: "UTC", matchMessages: [],
      profiles: [
        { name: "Day", settings: { voteKickEnabled: false } },
        { ...night, spec: { playersBelow: 50, daysOfWeek: ["fri", "sat"] }, settings: { autoBalanceEnabled: false, idleKick: 10 } },
      ],
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const [latest, earliest] = (await jf(`${base}/api/audit?action=autosettings.config`, { headers: auth })).body.entries as { id: string }[];

    const detail = await jf(`${base}/api/audit/${latest!.id}`, { headers: auth });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.entry.action, "autosettings.config");
    const { basis, items } = detail.body.changes as { basis: string; items: Change[] };
    assert.equal(basis, "recorded", "the record keeps what the save replaced");
    assert.deepEqual(line(items, ["Profile “Night”", "When", "Total players are below"]), { where: ["Profile “Night”", "When", "Total players are below"], before: "40", after: "50" });
    assert.deepEqual(line(items, ["Profile “Night”", "Auto-balance"]), { where: ["Profile “Night”", "Auto-balance"], before: "on", after: "off" }, "a game setting by the game's own label");
    assert.deepEqual(line(items, ["Profile “Day”", "Vote kick"]), { where: ["Profile “Day”", "Vote kick"], before: null, after: "off" }, "a new profile, setting by setting");
    assert.deepEqual(line(items, ["Dry run"]), { where: ["Dry run"], before: "on", after: "off" });
    assert.deepEqual(line(items, ["Profile order (the first that matches wins)"]), undefined, "Night is still the only profile both saves had, so no order changed");
    assert.equal(items.some((c) => c.where.includes("Idle kick (minutes)") || c.where.includes("Days")), false, "what stayed the same is not listed");
    assert.equal(detail.body.details.some((d: { label: string }) => /patch|before/i.test(d.label)), false, "the settings are not listed again under the details");

    const firstDetail = (await jf(`${base}/api/audit/${earliest!.id}`, { headers: auth })).body;
    assert.equal(firstDetail.changes.basis, "recorded", "the first save is compared with the defaults it replaced");
    assert.deepEqual(line(firstDetail.changes.items, ["Profile “Night”", "When", "Days"]), { where: ["Profile “Night”", "When", "Days"], before: null, after: "fri, sat" });
    assert.deepEqual(line(firstDetail.changes.items, ["Auto settings"]), { where: ["Auto settings"], before: "off", after: "on" });

    // Reordering is a change of its own: the first profile that matches wins.
    await put({ enabled: true, dryRun: false, timezone: "UTC", matchMessages: [], profiles: [second.body.config.profiles[1], second.body.config.profiles[0]] });
    const reordered = (await jf(`${base}/api/audit?action=autosettings.config&limit=1`, { headers: auth })).body.entries[0];
    const order = line((await jf(`${base}/api/audit/${reordered.id}`, { headers: auth })).body.changes.items, ["Profile order (the first that matches wins)"]);
    assert.deepEqual(order, { where: ["Profile order (the first that matches wins)"], before: "Profile “Day”, Profile “Night”", after: "Profile “Night”, Profile “Day”" });
  });
});

test("applying a template keeps what it replaced, and an older save is compared with the save before it", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const server = await repo.servers.create({ name: "WW2 #1", game: "hll", host: "10.0.0.8", port: 8, password: "x" } as never);
    await jf(`${base}/api/servers/${server.id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: false, dryRun: true, timezone: "UTC", profiles: [{ name: "Seed", settings: { idleKick: 5 } }], matchMessages: [] }) });
    const saved = await jf(`${base}/api/autosettings/templates`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Seeding nights", serverId: server.id }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await jf(`${base}/api/servers/${server.id}/autosettings`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: false, dryRun: true, timezone: "UTC", profiles: [], matchMessages: [] }) });
    const applied = await jf(`${base}/api/servers/${server.id}/autosettings/apply-template`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Seeding nights" }) });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const apply = (await jf(`${base}/api/audit?action=autosettings.template&limit=1`, { headers: auth })).body.entries[0];
    const applyDetail = (await jf(`${base}/api/audit/${apply.id}`, { headers: auth })).body;
    assert.equal(applyDetail.changes.basis, "recorded");
    assert.deepEqual(line(applyDetail.changes.items, ["Profile “Seed”", "Idle kick (minutes)"]), { where: ["Profile “Seed”", "Idle kick (minutes)"], before: null, after: "5" }, "the template's profile came back");
    assert.deepEqual(applyDetail.details, [{ label: "Template", value: "Seeding nights" }, { label: "Profiles", value: "1" }]);

    // Records from before saves kept `before`: each compared with the save before it on record.
    const old = (patch: object, summary = "updated auto settings") => repo.audit.create({
      actorUserId: null, actorName: "owner", action: "autosettings.config", targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id, summary, data: { patch },
    });
    const pause = () => new Promise((r) => setTimeout(r, 5));
    const other = await repo.servers.create({ name: "Other", game: "hll", host: "10.0.0.7", port: 7, password: "x" } as never);
    await pause();
    const a = await old({ enabled: true, dryRun: true, profiles: [{ name: "Night", settings: { idleKick: 10 } }] });
    await pause();
    await repo.audit.create({ actorUserId: null, actorName: "owner", action: "autosettings.config", targetType: "server", targetId: other.id, serverId: other.id, summary: "x", data: { patch: { dryRun: false } } });
    await pause();
    const b = await old({ dryRun: false, profiles: [{ name: "Night", settings: { idleKick: 15 } }] });
    const bDetail = (await jf(`${base}/api/audit/${b.id}`, { headers: auth })).body.changes;
    assert.equal(bDetail.basis, "previous");
    assert.equal(bDetail.since.ts, a.ts, "compared with this server's save before it, not another server's");
    assert.deepEqual(bDetail.items, [
      { where: ["Dry run"], before: "on", after: "off" },
      { where: ["Profile “Night”", "Idle kick (minutes)"], before: "10", after: "15" },
    ]);
    // A template applied in between, from before applies kept what they set: nothing to compare with.
    await pause();
    await repo.audit.create({ actorUserId: null, actorName: "owner", action: "autosettings.template", targetType: "server", targetId: server.id, serverId: server.id, summary: `applied auto settings template "Old" to ${server.name}`, data: { template: "Old" } });
    await pause();
    const c = await old({ profiles: [{ name: "Night", settings: { idleKick: 20 } }] });
    const cDetail = (await jf(`${base}/api/audit/${c.id}`, { headers: auth })).body.changes;
    assert.equal(cDetail.basis, "set");
    assert.match(cDetail.note, /template “Old” was applied/);
    assert.deepEqual(cDetail.items, [{ where: ["Profile “Night”", "Idle kick (minutes)"], before: null, after: "20" }], "what the save set");
    // A template merely SAVED from the server in between changes nothing on it.
    await pause();
    await repo.audit.create({ actorUserId: null, actorName: "owner", action: "autosettings.template", targetType: "server", targetId: server.id, serverId: server.id, summary: `saved auto settings template "New" from ${server.name}`, data: { template: "New" } });
    await pause();
    const d = await old({ profiles: [{ name: "Night", settings: { idleKick: 25 } }] });
    assert.deepEqual((await jf(`${base}/api/audit/${d.id}`, { headers: auth })).body.changes.items, [{ where: ["Profile “Night”", "Idle kick (minutes)"], before: "20", after: "25" }]);
    // The first save on record has nothing before it.
    const lone = await repo.servers.create({ name: "Lone", game: "hll", host: "10.0.0.6", port: 6, password: "x" } as never);
    const e = await repo.audit.create({ actorUserId: null, actorName: "owner", action: "autosettings.config", targetType: "server", targetId: lone.id, serverId: lone.id, summary: "x", data: { patch: { enabled: true } } });
    const eDetail = (await jf(`${base}/api/audit/${e.id}`, { headers: auth })).body.changes;
    assert.equal(eDetail.basis, "set");
    assert.match(eDetail.note, /No earlier save/);
    // A setting no earlier save on record names has nothing to compare with: it is not claimed as
    // added, it is left out.
    await pause();
    const f = await repo.audit.create({ actorUserId: null, actorName: "owner", action: "autosettings.config", targetType: "server", targetId: lone.id, serverId: lone.id, summary: "x", data: { patch: { enabled: false, dryRun: true } } });
    const fDetail = (await jf(`${base}/api/audit/${f.id}`, { headers: auth })).body.changes;
    assert.equal(fDetail.basis, "previous");
    assert.deepEqual(fDetail.items, [{ where: ["Auto settings"], before: "on", after: "off" }], "dry run: no earlier save names it");
  });
});

test("a rule's edit is read from its version history, and only by whoever may read the rules", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "No solo tank", eventKind: "app.state.solo_tank", action: "message", reason: "{violation}", params: { tankRoles: [11, 12], minCrew: 3 }, playersMin: 40 }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const edited = await jf(`${base}/api/enforcer/rules/${created.body.rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ playersMin: 50 }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const entry = (await jf(`${base}/api/audit?action=rule.update`, { headers: auth })).body.entries[0];
    const detail = (await jf(`${base}/api/audit/${entry.id}`, { headers: auth })).body;
    assert.equal(detail.changes.basis, "version");
    assert.deepEqual(detail.changes.items, [{ where: ["Players min"], before: "40", after: "50" }]);
    // Somebody who may read the trail but not the rules sees the entry, not the rule's terms.
    const trailOnly = await signIn(base, repo, [{ capability: "audit.trail" }]);
    const theirs = await jf(`${base}/api/audit/${entry.id}`, { headers: trailOnly });
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.changes, null);
    // A switch-only edit keeps no version: its line says what changed, and nothing more is claimed.
    await jf(`${base}/api/enforcer/rules/${created.body.rule.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    const off = (await jf(`${base}/api/audit?action=rule.update&limit=1`, { headers: auth })).body.entries[0];
    assert.match(off.summary, /disabled/);
    assert.equal((await jf(`${base}/api/audit/${off.id}`, { headers: auth })).body.changes, null);
  });
});

test("an entry is read as the trail is: not found for an id that isn't one, a server the reader may not see, or a community-wide entry for a reader held to a server", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mine = await repo.servers.create({ name: "Mine", host: "10.0.0.5", port: 5, password: "x" } as never);
    const theirs = await repo.servers.create({ name: "Theirs", host: "10.0.0.4", port: 4, password: "x" } as never);
    const on = (serverId: string | null, data?: Record<string, unknown>) => repo.audit.create({ actorUserId: null, actorName: "mod", action: "player.message", targetType: "player", targetId: "765", targetName: "Ana", serverId, summary: "ran message on Ana (bulk, 98 selected)", data: data ?? null });
    const here = await on(mine.id, { message: "Please play the objective", bulk: true, selected: 98 });
    const there = await on(theirs.id);
    const everywhere = await on(null);
    const detail = await jf(`${base}/api/audit/${here.id}`, { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.changes, null, "a message changes no setting");
    assert.deepEqual(detail.body.details, [{ label: "Message", value: "Please play the objective" }, { label: "Bulk", value: "on" }, { label: "Selected", value: "98" }]);
    assert.equal(detail.body.entry.targetDisplayName, "Ana");
    assert.equal((await jf(`${base}/api/audit/not-an-id`, { headers: auth })).status, 404);
    assert.equal((await jf(`${base}/api/audit/00000000-0000-4000-8000-000000000000`, { headers: auth })).status, 404);
    const scoped = await signIn(base, repo, [{ capability: "audit.trail", serverId: mine.id }]);
    assert.equal((await jf(`${base}/api/audit/${here.id}`, { headers: scoped })).status, 200, "their own server's entry");
    assert.equal((await jf(`${base}/api/audit/${there.id}`, { headers: scoped })).status, 404, "another server's: not found, as the trail would not list it");
    assert.equal((await jf(`${base}/api/audit/${everywhere.id}`, { headers: scoped })).status, 404, "a community-wide entry, for a reader held to one server");
    assert.equal((await jf(`${base}/api/audit/${everywhere.id}`, { headers: auth })).status, 200);
    const nobody = await signIn(base, repo, [{ capability: "server.view" }]);
    assert.equal((await jf(`${base}/api/audit/${here.id}`, { headers: nobody })).status, 403);
  });
});

/*
 * Every settings save keeps what it replaced on its record, so its entry says exactly what changed:
 * seeding, the broadcast rotation, the live welcome message, game rewards, the Discord relay and
 * command, a person's permissions, a role, and the chat filter (a long word list read as the
 * words added and removed).
 */
test("every settings save keeps what it replaced, and its entry says what changed", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const server = await repo.servers.create({ name: "S", game: "hll", host: "10.0.0.3", port: 3, password: "x" } as never);
    const send = async (method: string, path: string, body: object) => {
      const r = await jf(`${base}${path}`, { method, headers: auth, body: JSON.stringify(body) });
      assert.ok(r.status === 200 || r.status === 201, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const changesOf = async (action: string): Promise<Change[]> => {
      const entry = (await jf(`${base}/api/audit?action=${action}&limit=1`, { headers: auth })).body.entries[0];
      const d = (await jf(`${base}/api/audit/${entry.id}`, { headers: auth })).body;
      assert.equal(d.changes?.basis, "recorded", `${action}: ${JSON.stringify(d.changes)}`);
      return d.changes.items;
    };
    const s = `/api/servers/${server.id}`;

    await send("PUT", `${s}/seeding`, { disallowedRoles: [13], containEnabled: false, paceNotice: "GROUND-RULE-BEFORE" });
    await send("PUT", `${s}/seeding`, { disallowedRoles: [13, 14], containEnabled: true, paceNotice: "GROUND-RULE-AFTER" });
    const seeding = await changesOf("seeding.config");
    assert.deepEqual(line(seeding, ["Disallowed roles"]), { where: ["Disallowed roles"], before: "13", after: "13, 14" });
    // The ground rules answer to the rules permission, not the trail's: what they were stays off the
    // record with what they became, and the entry says nothing of them.
    const seedRow = (await repo.audit.list({ actions: ["seeding.config"], limit: 1 }))[0]!;
    assert.ok(!JSON.stringify(seedRow.data).includes("GROUND-RULE") && !("containEnabled" in (seedRow.data!.before as object)), JSON.stringify(seedRow.data));
    assert.ok(!JSON.stringify(seeding).includes("GROUND-RULE") && !seeding.some((c) => /contain|pace/i.test(c.where.join(" "))), JSON.stringify(seeding));

    await send("PUT", `${s}/broadcast`, { enabled: false, dryRun: true, intervalSec: 600, randomize: false, messages: ["one", "two"] });
    await send("PUT", `${s}/broadcast`, { enabled: false, dryRun: true, intervalSec: 900, randomize: false, messages: ["one", "three"] });
    const broadcast = await changesOf("broadcast.config");
    assert.deepEqual(line(broadcast, ["Interval sec"]), { where: ["Interval sec"], before: "600", after: "900" });
    assert.deepEqual(line(broadcast, ["Messages"]), { where: ["Messages"], before: "one, two", after: "one, three" });
    assert.equal(line(broadcast, ["Dry run"]), undefined, "unchanged, not listed");

    await send("PUT", `${s}/welcome`, { template: "Hello on {server}", intervalSec: 300 });
    await send("PUT", `${s}/welcome`, { template: "Welcome to the server" });
    assert.deepEqual(await changesOf("welcome.config"), [{ where: ["Template"], before: "Hello on {server}", after: "Welcome to the server" }]);

    await send("PUT", `${s}/game-rewards`, { killStreaks: { enabled: true, tiers: [{ kills: 15, reward: { points: 40 } }] } });
    await send("PUT", `${s}/game-rewards`, { killStreaks: { enabled: true, tiers: [{ kills: 20, reward: { points: 40 } }] } });
    const rewards = await changesOf("gamerewards.config");
    assert.ok(rewards.some((c) => c.where.join(" · ") === "Kill streaks · Tiers · Entry" && c.after === null && /Kills: 15; Reward: \(.*Points: 40/.test(c.before ?? "")), JSON.stringify(rewards));
    assert.ok(rewards.some((c) => c.where.join(" · ") === "Kill streaks · Tiers · Entry" && c.before === null && /Kills: 20/.test(c.after ?? "")), JSON.stringify(rewards));

    await send("PUT", `${s}/discord`, { enabled: true, categories: ["kills"], channels: { kills: "123456789012345" } });
    await send("PUT", `${s}/discord`, { enabled: true, categories: ["kills", "admin"], channels: { kills: "123456789012345", admin: "223456789012345" } });
    const relay = await changesOf("discord.relay.config");
    assert.deepEqual(line(relay, ["Categories"]), { where: ["Categories"], before: "kills", after: "kills, admin" });
    assert.deepEqual(line(relay, ["Channels", "Admin"]), { where: ["Channels", "Admin"], before: null, after: "223456789012345" });

    await send("PUT", "/api/discord/commands", { name: "crew" });
    await send("PUT", "/api/discord/commands", { name: "mods" });
    assert.deepEqual(line(await changesOf("discord.commands.config"), ["Name"]), { where: ["Name"], before: "crew", after: "mods" });

    const member = await repo.users.create({ username: "member-one", passwordHash: null, email: null } as never);
    const view = { capability: "server.view", scopeType: "global", scopeId: null, level: "read" };
    await send("PUT", `/api/users/${member.id}/grants`, { grants: [view] });
    await send("PUT", `/api/users/${member.id}/grants`, { grants: [view, { capability: "audit.trail", scopeType: "server", scopeId: server.id, level: "read" }] });
    assert.deepEqual(await changesOf("grant.set"), [{ where: ["audit.trail on S"], before: null, after: "read" }], "the permission added, by its name and server");

    const role = (await send("POST", "/api/roles", { name: "Watcher", grants: [{ capability: "server.view", level: "read" }] })).role;
    await send("PUT", `/api/roles/${role.id}`, { name: "Watchers", grants: [{ capability: "server.view", level: "write" }] });
    const roleChanges = await changesOf("role.update");
    assert.deepEqual(line(roleChanges, ["Name"]), { where: ["Name"], before: "Watcher", after: "Watchers" });
    assert.deepEqual(line(roleChanges, ["server.view", "Level"]), { where: ["server.view", "Level"], before: "read", after: "write" });

    const words = (list: string[]) => list.join("\n");
    await send("PUT", "/api/chat-filter", { enabled: false, words: words(["a1", "a2", "a3", "a4", "a5", "a6", "a7"]), action: "message", reason: "language" });
    await send("PUT", "/api/chat-filter", { enabled: false, words: words(["a1", "a2", "a3", "a4", "a5", "a6", "b8"]), action: "message", reason: "language" });
    const filter = await changesOf("chatfilter.update");
    assert.deepEqual(filter.filter((c) => c.where[0] === "Words"), [
      { where: ["Words"], before: null, after: "b8" },
      { where: ["Words"], before: "a7", after: null },
    ], "a long list: the words added and the words removed");
  });
});
