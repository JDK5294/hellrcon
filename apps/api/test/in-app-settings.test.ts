import { test } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { hashPassword } from "@app/access";
import { INSTALL_ENV_SETTINGS } from "@app/db";
import { jsonFetch, ownerAuth, withServer } from "./harness.ts";
import { settleInstallEnv } from "../dist/install-env.js";
import { loadApiConfig, publicStatsConfig } from "../dist/config.js";

/*
 * The Discord app's credentials and the public stats site are set in the panel, and every reader
 * still reads them from the environment: these tests share the process's environment, so each one
 * puts back what it found.
 */
const VARS = INSTALL_ENV_SETTINGS.map((s) => s.env);
async function withCleanEnv(fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
  try { await fn(); } finally {
    for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  }
}

/** fetch() refuses a caller-set Host header, so a request on another hostname speaks raw http. */
function statusOn(base: string, path: string, host: string): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end();
  });
}

async function staffAuth(base: string, repo: Parameters<Parameters<typeof withServer>[0]>[1]) {
  const user = await repo.users.create({ username: `staff-${Math.random().toString(36).slice(2, 8)}`, passwordHash: await hashPassword("pw"), email: null });
  await repo.grants.create({ userId: user.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: user.username, password: "pw" }) });
  return { authorization: `Bearer ${login.body.token}` };
}

test("the Discord app is set up in the panel: in force at once, the secrets never sent back or written down", async () => {
  await withCleanEnv(() => withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    assert.equal((await jsonFetch(`${base}/api/auth/discord/status`)).body.configured, false);
    const put = await jsonFetch(`${base}/api/discord/setup`, { method: "PUT", headers: auth, body: JSON.stringify({
      botToken: "Bot MTIz.abc-DEF.ghi_jkl", clientId: "123456789012345678", clientSecret: "the-client-secret",
      guildId: "234567890123456789", redirectUri: "https://panel.example.com/",
    }) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.pieces.botToken, true);
    assert.equal(put.body.values.redirectUri, "https://panel.example.com/api/auth/discord/callback", "the panel's address alone is enough");
    assert.equal(put.body.features.signIn, true);
    assert.doesNotMatch(JSON.stringify(put.body), /MTIz|the-client-secret/, "secrets are never sent back");

    assert.equal(process.env.DISCORD_TOKEN, "MTIz.abc-DEF.ghi_jkl", "in force in this process at once, without the pasted 'Bot ' prefix");
    assert.equal((await jsonFetch(`${base}/api/auth/discord/status`)).body.configured, true, "sign-in with Discord is offered straight away");
    assert.equal(await repo.installSettings.get("discord.clientSecret"), "the-client-secret", "kept with the install's settings");

    const trail = (await repo.audit.list({ action: "discord.setup" }))[0];
    assert.ok(trail, "the change is on the trail");
    assert.match(trail!.summary, /bot token/);
    assert.doesNotMatch(JSON.stringify(trail), /MTIz|the-client-secret/, "naming what changed, never the values");
  }));
});

test("a Discord setting cleared in the panel is off at once; a bad one is refused and nothing is saved", async () => {
  await withCleanEnv(() => withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const put = (body: Record<string, unknown>) => jsonFetch(`${base}/api/discord/setup`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await put({ botToken: "a.b.c", appId: "345678901234567890" })).status, 200);
    const cleared = await put({ botToken: "" });
    assert.equal(cleared.body.pieces.botToken, false);
    assert.equal(cleared.body.pieces.appId, true, "only what was sent changes");
    assert.equal("DISCORD_TOKEN" in process.env, false);

    for (const [body, why] of [
      [{ appId: "not-a-number" }, /long number/],
      [{ publicKey: "abc" }, /64 letters and digits/],
      [{ redirectUri: "https://panel.example.com/somewhere-else" }, /\/api\/auth\/discord\/callback/],
      [{ botToken: "has a space" }, /space/],
    ] as const) {
      const r = await put({ guildId: "456789012345678901", ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(String(r.body.error?.message), why);
    }
    assert.equal(await repo.installSettings.get("discord.guildId"), null, "a refused save stores none of its fields — not even the ones before the bad one");
    assert.equal((await jsonFetch(`${base}/api/discord/setup`, { headers: auth })).body.pieces.guildId, false);
  }));
});

test("only User & role admin sets the Discord app up, and it is never filed for approval — it carries the token", async () => {
  await withCleanEnv(() => withServer(async (base, repo) => {
    await ownerAuth(base);
    const r = await jsonFetch(`${base}/api/discord/setup`, { method: "PUT", headers: await staffAuth(base, repo), body: JSON.stringify({ botToken: "x.y.z" }) });
    assert.equal(r.status, 403);
    assert.equal(await repo.installSettings.get("discord.token"), null);
    assert.equal((await repo.approvals.list()).length, 0, "nothing filed: the request would carry the token");
  }));
});

test("the stats site's own address and name are set in the panel, in force at once — and never the panel's own address", async () => {
  await withCleanEnv(() => withServer(async (base, repo, ctx) => {
    const auth = await ownerAuth(base);
    const put = (body: Record<string, unknown>, headers: Record<string, string> = auth) =>
      jsonFetch(`${base}/api/online/stats-site`, { method: "PUT", headers, body: JSON.stringify(body) });
    const set = await put({ host: "Stats.Example.com", name: "The Lynx Division", origin: "" });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.statsSite, { host: "stats.example.com", origin: null, name: "The Lynx Division", shareable: "https://stats.example.com" });
    assert.deepEqual((await jsonFetch(`${base}/api/public/servers`)).body.site, { name: "The Lynx Division", origin: "https://stats.example.com" });
    assert.equal(await statusOn(base, "/api/auth/status", "stats.example.com"), 404, "on that address the panel does not exist");
    assert.equal(await statusOn(base, "/api/auth/status", "panel.example.com"), 200, "on the panel's it does");

    const typo = await put({ host: "stats example com" });
    assert.equal(typo.status, 400);
    assert.match(String(typo.body.error?.message), /a hostname, like stats\.example\.com/);
    const own = await put({ host: new URL(base).hostname });
    assert.equal(own.status, 400, "the address the panel is reached on");
    assert.match(String(own.body.error?.message), /panel's own address/);
    // The panel's own domain, set on the same screen. This save arrives on another address (the
    // test's own), so only the stored domain says that one is the panel's.
    assert.equal((await jsonFetch(`${base}/api/online/domain`, { method: "PUT", headers: auth, body: JSON.stringify({ host: "panel.example.com" }) })).status, 200);
    const domain = await put({ host: "Panel.Example.com" });
    assert.equal(domain.status, 400, "the panel's own domain");
    assert.match(String(domain.body.error?.message), /panel's own address/);
    assert.equal(await statusOn(base, "/api/auth/status", "panel.example.com"), 200, "and the panel is still there on it");

    const cleared = await put({ host: "", name: "", origin: "" });
    assert.deepEqual(cleared.body.statsSite, { host: null, origin: null, name: null, shareable: null }, "back on the panel's own address, at /stats");
    assert.equal(ctx.config.publicStatsHost, null);
    const trail = await repo.audit.list({ action: "stats.site" });
    assert.equal(trail.length, 2);
  }));
});

/*
 * An install that set these in infra/.env before: its values are carried over on the first boot
 * with this version, and from then on what the panel says is what is in force, whatever the .env
 * file still says.
 */
test("boot carries infra/.env's values over once; after that the panel's values win across restarts", async () => {
  await withCleanEnv(() => withServer(async (_base, repo) => {
    process.env.PUBLIC_STATS_NAME = "From The Env File";
    process.env.DISCORD_GUILD_ID = "567890123456789012";
    const config = loadApiConfig();
    assert.deepEqual(await settleInstallEnv(repo, config), ["DISCORD_GUILD_ID", "PUBLIC_STATS_NAME"]);
    assert.equal(config.publicStatsName, "From The Env File");

    await repo.installSettings.set("stats.name", "Set In The Panel");
    process.env.PUBLIC_STATS_NAME = "From The Env File";
    const restarted = loadApiConfig();
    assert.deepEqual(await settleInstallEnv(repo, restarted), [], "nothing carried over twice");
    assert.equal(restarted.publicStatsName, "Set In The Panel", "the panel's value, though .env still says otherwise");
    assert.equal(process.env.PUBLIC_STATS_NAME, "Set In The Panel");
  }));
});

test("a blank shareable address is the default one, not an empty one", () => {
  assert.equal(publicStatsConfig({ PUBLIC_STATS_HOST: "stats.example.com", PUBLIC_STATS_ORIGIN: "" }).publicStatsOrigin, "https://stats.example.com");
  assert.equal(publicStatsConfig({ PUBLIC_STATS_HOST: "stats.example.com", PUBLIC_STATS_ORIGIN: "http://stats.example.com:8443/" }).publicStatsOrigin, "http://stats.example.com:8443");
  assert.equal(publicStatsConfig({}).publicStatsOrigin, null);
});
