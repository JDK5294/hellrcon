import { test } from "node:test";
import assert from "node:assert/strict";
import { askedFor, jf, withIsolatedServer as withServer } from "./harness.ts";

/*
 * Three permissions each gave away a second job (migration 156 carved them apart, CAPABILITY_SPLITS
 * in @app/access): the chat filter and the zone sets rode the enforcer rules, the seed reward rode
 * seeding, and the Discord bot's setup and online access rode user & role admin. These pin each new
 * key to what it opens, and that the old key no longer opens it.
 */

async function owner(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}
/** A staff account holding exactly these personal grants (global unless a scope is given), signed in. */
async function staff(base: string, auth: Record<string, string>, username: string, grants: { capability: string; level: string; scopeId?: string }[]) {
  const made = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
  const id = made.body.user.id as string;
  const set = await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({
    grants: grants.map((g) => ({ capability: g.capability, level: g.level, scopeType: g.scopeId ? "server" : "global", scopeId: g.scopeId ?? null })),
  }) });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

test("the chat filter is its own permission, and acting on players takes that action's own key", async () => {
  await withServer(async (base) => {
    const auth = await owner(base);
    const chat = await staff(base, auth, "chatmod", [
      { capability: "moderation.chatfilter", level: "write" },
      { capability: "action.message", level: "write" },
    ]);
    const rules = await staff(base, auth, "rulesmod", [{ capability: "admin.moderation", level: "write" }]);
    const put = (body: Record<string, unknown>, h = chat) => jf(`${base}/api/chat-filter`, { method: "PUT", headers: h, body: JSON.stringify({ words: "badword", reason: "language", ...body }) });
    const saved = async () => (await jf(`${base}/api/chat-filter`, { headers: auth })).body.config as { enabled: boolean; action: string; hours: number | null; words: string[] };

    assert.equal((await jf(`${base}/api/chat-filter`, { headers: chat })).status, 200);
    assert.equal((await jf(`${base}/api/chat-filter`, { headers: rules })).status, 403, "the rules permission no longer opens it");
    assert.deepEqual(await askedFor(base, auth, await put({ enabled: true, action: "message" }, rules)), { capability: "moderation.chatfilter", serverId: null });

    // Switched on to an action they may take by hand: saved.
    assert.equal((await put({ enabled: true, action: "message" })).status, 200);
    assert.deepEqual([(await saved()).enabled, (await saved()).action], [true, "message"]);
    // Changing what it does to one they may not: asked for that action's key, nothing changed.
    for (const [action, hours, key] of [["kick", null, "action.kick"], ["punish", null, "action.punish"], ["tempban", 2, "action.tempban"],
      ["blacklist", 24, "action.tempban"], ["blacklist", null, "action.permaban"]] as const) {
      assert.deepEqual(await askedFor(base, auth, await put({ enabled: true, action, hours })), { capability: key, serverId: null }, `${action} ${hours ?? "no hours"}`);
    }
    assert.equal((await saved()).action, "message", "nothing was saved on the asking");

    // The owner sets it to kick. Editing the words of the filter as it stands needs no kick key;
    // changing its hours, or switching it back on after it was off, does.
    assert.equal((await put({ enabled: true, action: "kick" }, auth)).status, 200);
    assert.equal((await put({ enabled: true, action: "kick", words: "badword\nworseword" })).status, 200, "the standing action keeps standing");
    assert.deepEqual((await saved()).words, ["badword", "worseword"]);
    assert.equal((await put({ enabled: false, action: "kick" })).status, 200, "switching it off takes nothing more");
    assert.deepEqual(await askedFor(base, auth, await put({ enabled: true, action: "kick" })), { capability: "action.kick", serverId: null }, "switching a kick back on is acting");
    assert.equal((await saved()).enabled, false);
  });
});

test("zone sets are their own permission, and the rules permission still reads them", async () => {
  await withServer(async (base) => {
    const auth = await owner(base);
    const mapper = await staff(base, auth, "mapper", [{ capability: "moderation.zones", level: "write" }]);
    const rules = await staff(base, auth, "rulesmod", [{ capability: "admin.moderation", level: "write" }]);
    const nobody = await staff(base, auth, "nobody", [{ capability: "server.view", level: "read" }]);

    const made = await jf(`${base}/api/zones`, { method: "POST", headers: mapper, body: JSON.stringify({ name: "Mid only", game: "hll" }) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await jf(`${base}/api/zones?game=hll`, { headers: rules })).body.sets.length, 1, "the rules editor's picker lists the sets");
    assert.equal((await jf(`${base}/api/zones`, { headers: nobody })).status, 403);
    const id = made.body.set.id as string;
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/zones/${id}`, { method: "DELETE", headers: rules })), { capability: "moderation.zones", serverId: null }, "drawing is not the rules permission's");
    assert.equal((await jf(`${base}/api/zones?game=hll`, { headers: auth })).body.sets.length, 1, "nothing deleted on the asking");
  });
});

test("the seed reward is its own permission, per server: hidden without it, and changing it asks", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const s = (await repo.servers.create({ name: "WW2", host: "10.0.0.1", port: 1, password: "x" })).id;
    const t = (await repo.servers.create({ name: "Other", host: "10.0.0.2", port: 1, password: "x" })).id;
    const seeding = (h: Record<string, string>, id = s) => jf(`${base}/api/servers/${id}/seeding`, { headers: h });
    const put = (body: Record<string, unknown>, h: Record<string, string>) => jf(`${base}/api/servers/${s}/seeding`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    assert.equal((await put({ rewardHours: 24, seedTarget: 40 }, auth)).status, 200);

    // Seeding rules only, and the reward on ANOTHER server: the reward here is not theirs to read.
    const rulesOnly = await staff(base, auth, "seedrules", [
      { capability: "seeding.config", level: "write", scopeId: s },
      { capability: "seeding.rewards", level: "write", scopeId: t },
    ]);
    const cfg = (await seeding(rulesOnly)).body.config as Record<string, unknown>;
    assert.equal(cfg.seedTarget, 40, "the rules are there");
    for (const k of ["rewardEnabled", "rewardHours", "rewardPoints", "rewardBridge", "minSeedMinutes", "rewardMessage"]) assert.ok(!(k in cfg), `${k} is the reward's`);
    // Saving what they were sent, rules changed: fine, and the reward stands.
    const saved = await put({ ...cfg, seedTarget: 30 }, rulesOnly);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(!("rewardHours" in saved.body.config), "the answer keeps the reward out too");
    assert.deepEqual(await askedFor(base, auth, await put({ rewardHours: 48 }, rulesOnly)), { capability: "seeding.rewards", serverId: s });
    assert.deepEqual(await askedFor(base, auth, await put({ minSeedMinutes: 1 }, rulesOnly)), { capability: "seeding.rewards", serverId: s }, "how long earns it is the reward too");
    const now = (await seeding(auth)).body.config as Record<string, unknown>;
    assert.deepEqual([now.seedTarget, now.rewardHours, now.minSeedMinutes], [30, 24, 15], "the rules saved, the reward did not change");
    assert.equal((await jf(`${base}/api/servers/${s}/seeding/payouts`, { headers: rulesOnly })).status, 403, "nor are its receipts");
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/servers/${s}/seeding/pay-last`, { method: "POST", headers: rulesOnly, body: "{}" })), { capability: "seeding.rewards", serverId: s });

    // Reading the reward but not changing it: the whole config round-trips, a change asks.
    const reader = await staff(base, auth, "seedreader", [
      { capability: "seeding.config", level: "write", scopeId: s },
      { capability: "seeding.rewards", level: "read", scopeId: s },
    ]);
    const full = (await seeding(reader)).body.config as Record<string, unknown>;
    assert.equal(full.rewardHours, 24);
    assert.equal((await put({ ...full, seedTarget: 35 }, reader)).status, 200, "a reward restated as it stands is not a change");
    assert.equal((await jf(`${base}/api/servers/${s}/seeding/payouts`, { headers: reader })).status, 200);
    assert.deepEqual(await askedFor(base, auth, await put({ ...full, rewardHours: 72 }, reader)), { capability: "seeding.rewards", serverId: s });
    assert.equal(((await seeding(auth)).body.config as Record<string, unknown>).rewardHours, 24);

    // A saved setup carries the reward: one that would change it asks, one that matches does not.
    assert.equal((await put({ rewardHours: 100 }, auth)).status, 200);
    assert.equal((await jf(`${base}/api/presets/seeding`, { method: "POST", headers: auth, body: JSON.stringify({ name: "big", serverId: s }) })).status, 200);
    assert.equal((await put({ rewardHours: 24 }, auth)).status, 200);
    assert.equal((await jf(`${base}/api/presets/seeding`, { method: "POST", headers: auth, body: JSON.stringify({ name: "same", serverId: s }) })).status, 200);
    const apply = (name: string) => jf(`${base}/api/servers/${s}/presets/seeding/apply`, { method: "POST", headers: rulesOnly, body: JSON.stringify({ name }) });
    assert.deepEqual(await askedFor(base, auth, await apply("big")), { capability: "seeding.rewards", serverId: s });
    assert.equal(((await seeding(auth)).body.config as Record<string, unknown>).rewardHours, 24, "nothing applied on the asking");
    assert.equal((await apply("same")).status, 200, "a setup that leaves the reward as it is applies");

    // Scheduled, a setup lands on whatever the reward is by then — so carrying one at all asks.
    const scheduler = await staff(base, auth, "seedscheduler", [
      { capability: "seeding.config", level: "write", scopeId: s },
      { capability: "autosettings.profiles", level: "write", scopeId: s },
    ]);
    const profiles = { profiles: [{ name: "evening", spec: { start: "18:00", end: "23:00" }, settings: { "preset:seeding": "same" } }] };
    const scheduled = await jf(`${base}/api/servers/${s}/autosettings`, { method: "PUT", headers: scheduler, body: JSON.stringify(profiles) });
    assert.deepEqual(await askedFor(base, auth, scheduled), { capability: "seeding.rewards", serverId: s });
  });
});

test("the Discord bot's setup and online access are their own permissions; the role map stays with user admin", async () => {
  await withServer(async (base) => {
    const auth = await owner(base);
    const bot = await staff(base, auth, "botadmin", [{ capability: "discord.setup", level: "write" }]);
    const online = await staff(base, auth, "netadmin", [{ capability: "admin.online", level: "write" }]);
    const users = await staff(base, auth, "useradmin", [{ capability: "admin.users", level: "write" }]);
    const appConfig = (body: Record<string, unknown>, h: Record<string, string>) => jf(`${base}/api/app-config`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    const stored = async () => (await jf(`${base}/api/app-config`, { headers: auth })).body.config as { communityGuildId: string; timezone: string; roleBadges: unknown[] };

    for (const path of ["/api/discord/setup", "/api/discord/commands", "/api/discord/roles?guild=community"]) {
      assert.equal((await jf(`${base}${path}`, { headers: bot })).status, 200, `${path} is the bot setup's`);
    }
    for (const path of ["/api/discord/setup", "/api/discord/commands"]) {
      assert.equal((await jf(`${base}${path}`, { headers: users })).status, 403, `${path} is no longer user admin's`);
    }
    assert.equal((await jf(`${base}/api/discord/role-map`, { headers: users })).status, 200, "the role map stays with user admin");
    assert.equal((await jf(`${base}/api/discord/role-map`, { headers: bot })).status, 403);
    assert.equal((await jf(`${base}/api/users`, { headers: bot })).status, 403);

    // The app-wide settings answer field by field: the Discord ones to the bot's setup.
    assert.equal((await appConfig({ communityGuildId: "123456789012345678" }, bot)).status, 200);
    assert.equal((await stored()).communityGuildId, "123456789012345678");
    assert.deepEqual(await askedFor(base, auth, await appConfig({ timezone: "Europe/London" }, bot)), { capability: "admin.users", serverId: null });
    assert.deepEqual(await askedFor(base, auth, await appConfig({ communityGuildId: "", timezone: "Europe/London" }, bot)), { capability: "admin.users", serverId: null }, "a save carrying both needs both");
    assert.equal((await stored()).communityGuildId, "123456789012345678", "nothing saved on the asking");
    assert.equal((await appConfig({ timezone: "Europe/London" }, users)).status, 200);
    assert.deepEqual(await askedFor(base, auth, await appConfig({ roleBadges: [] }, users)), { capability: "discord.setup", serverId: null });
    assert.deepEqual(await askedFor(base, auth, await appConfig({ approvalsChannelId: "123456789012345678" }, users)), { capability: "discord.setup", serverId: null });
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/discord/commands/register`, { method: "POST", headers: users })), { capability: "discord.setup", serverId: null });

    // Online access: its own, and nobody else's.
    assert.equal((await jf(`${base}/api/online`, { headers: online })).status, 200);
    assert.equal((await jf(`${base}/api/online/domain`, { method: "PUT", headers: online, body: JSON.stringify({ host: "panel.example.com" }) })).status, 200);
    for (const h of [users, bot]) assert.equal((await jf(`${base}/api/online`, { headers: h })).status, 403);
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/online/domain`, { method: "PUT", headers: users, body: JSON.stringify({ host: "x.example.com" }) })), { capability: "admin.online", serverId: null });
    assert.equal((await jf(`${base}/api/discord/setup`, { headers: online })).status, 403);
  });
});
