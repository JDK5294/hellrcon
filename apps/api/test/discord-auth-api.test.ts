import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createIsolatedRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { ownerAuth } from "./harness.ts";

async function withRepoServer(fn: (base: string, repo: any) => Promise<void>): Promise<void> {
  const { repo, cleanup } = await createIsolatedRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); await cleanup(); }
}
async function jf(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, redirect: "manual", headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  let body: Record<string, any> = {};
  try { body = (await res.json()) as Record<string, any>; } catch { /* redirects have no JSON */ }
  return { status: res.status, body, location: res.headers.get("location") };
}

test("discord auth status: not configured without env", async () => {
  await withRepoServer(async (base) => {
    const r = await jf(`${base}/api/auth/discord/status`);
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, false); // no DISCORD_CLIENT_ID etc. in test env
  });
});

test("discord-only account cannot log in with a password", async () => {
  await withRepoServer(async (base, repo) => {
    await repo.users.create({ username: "discostaff", discordId: "999", discordManaged: true }); // no password
    const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "discostaff", password: "" }) });
    assert.equal(r.status, 401);
    const r2 = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "discostaff", password: "anything" }) });
    assert.equal(r2.status, 401);
  });
});

test("discord role-map: set, list, validate role, delete (admin.users gated)", async () => {
  await withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    // Create a panel role to map onto.
    const role = await jf(`${base}/api/roles`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Trial mod", grants: [{ capability: "moderation.bans", level: "read" }], limits: {} }) });
    const roleId = role.body.role.id as string;

    // Unknown role id is rejected.
    const bad = await jf(`${base}/api/discord/role-map/d1`, { method: "PUT", headers: auth, body: JSON.stringify({ roleIds: ["nope"], discordRoleName: "Mods" }) });
    assert.equal(bad.status, 400);

    // Valid mapping saves.
    const put = await jf(`${base}/api/discord/role-map/d1`, { method: "PUT", headers: auth, body: JSON.stringify({ roleIds: [roleId], discordRoleName: "Mods" }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.mappings.length, 1);
    assert.equal(put.body.mappings[0].discordRoleId, "d1");
    assert.equal(put.body.mappings[0].roleId, roleId);

    const list = await jf(`${base}/api/discord/role-map`, { headers: auth });
    assert.equal(list.status, 200);
    assert.equal(list.body.mappings.length, 1);
    assert.equal(list.body.oauthConfigured, false);

    // Delete it.
    const del = await jf(`${base}/api/discord/role-map/d1`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 200);
    assert.equal((await jf(`${base}/api/discord/role-map`, { headers: auth })).body.mappings.length, 0);
  });
});

test("discord role-map requires auth", async () => {
  await withRepoServer(async (base) => {
    const r = await jf(`${base}/api/discord/role-map`);
    assert.equal(r.status, 401);
  });
});

test("discord setup: reports everything off when no env is set (admin gated)", async () => {
  await withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    const r = await jf(`${base}/api/discord/setup`, { headers: auth });
    assert.equal(r.status, 200);
    // Nothing configured in the test env → every piece false, every feature off.
    assert.equal(Object.values(r.body.pieces).some(Boolean), false);
    assert.equal(Object.values(r.body.features).some(Boolean), false);
    // Requires auth.
    assert.equal((await jf(`${base}/api/discord/setup`)).status, 401);
  });
});

test("discord-managed override: toggle off/on; rejected for non-linked users", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const linked = await repo.users.create({ username: "discostaff", discordId: "d-500", discordUsername: "Disco#5", discordManaged: true });

    // Turn the override ON (managed = false) → Discord stops driving their roles, but the account
    // is still linked, so the sweep keeps their display name current.
    const off = await jf(`${base}/api/users/${linked.id}/discord-managed`, { method: "PUT", headers: auth, body: JSON.stringify({ managed: false }) });
    assert.equal(off.status, 200);
    assert.equal(off.body.user.discordManaged, false);
    assert.deepEqual((await repo.users.listDiscordLinked()).map((u: { id: string }) => u.id), [linked.id]);

    // Hand back to Discord (managed = true).
    const on = await jf(`${base}/api/users/${linked.id}/discord-managed`, { method: "PUT", headers: auth, body: JSON.stringify({ managed: true }) });
    assert.equal(on.body.user.discordManaged, true);

    // A user with no Discord link can't be toggled.
    const manual = await repo.users.create({ username: "manual", passwordHash: "h" });
    const bad = await jf(`${base}/api/users/${manual.id}/discord-managed`, { method: "PUT", headers: auth, body: JSON.stringify({ managed: false }) });
    assert.equal(bad.status, 400);
  });
});

/*
 * The OAuth handshake, end to end, with the environment configured.
 *
 * The unit tests cover the cookie's shape. This covers the thing that matters: that the callback
 * actually REFUSES a state which did not start in this browser. A signed state alone cannot tell
 * the difference — anyone can get one from /start — so without the cookie an attacker's unspent
 * code+state, opened by a staff member, signs that staff member in as the attacker.
 */
function withDiscordEnv<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID", "DISCORD_OAUTH_REDIRECT"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    DISCORD_CLIENT_ID: "cid", DISCORD_CLIENT_SECRET: "csecret", DISCORD_GUILD_ID: "gid",
    DISCORD_OAUTH_REDIRECT: "http://panel.test/api/auth/discord/callback",
  });
  return fn().finally(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });
}

/** The `state` the authorize URL was built with, plus the cookie /start handed the browser. */
async function beginFlow(base: string) {
  const res = await fetch(`${base}/api/auth/discord/start`, { redirect: "manual" });
  const authorize = new URL(res.headers.get("location")!);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { state: authorize.searchParams.get("state")!, cookie: setCookie.split(";")[0]! };
}

test("discord sign-in: /start binds the flow to the browser that began it", async () => {
  await withDiscordEnv(() => withRepoServer(async (base) => {
    const { state, cookie } = await beginFlow(base);
    assert.ok(state, "the authorize URL carries a state");
    assert.match(cookie, /^hr_oauth_state=/, "and the browser is given the matching nonce");
    // The two are the same value — that is the whole mechanism.
    assert.ok(state.startsWith(decodeURIComponent(cookie.split("=")[1]!)), "the state is signed over the cookie's nonce");
  }));
});

test("discord sign-in: a state from someone else's browser is refused", async () => {
  await withDiscordEnv(() => withRepoServer(async (base) => {
    // The attacker starts a flow and keeps the state without spending it.
    const attacker = await beginFlow(base);

    // The victim opens that callback URL. Their browser has no matching cookie, so this must not
    // reach the token exchange at all — the response is a bounce back to the login screen.
    const victim = await fetch(`${base}/api/auth/discord/callback?code=stolen&state=${encodeURIComponent(attacker.state)}`, { redirect: "manual" });
    assert.equal(victim.status, 302);
    const frag = decodeURIComponent(victim.headers.get("location") ?? "");
    assert.match(frag, /discord_error=/, "refused");
    assert.match(frag, /did not start in this browser/, "and says why");
    assert.ok(!/discord_token=/.test(frag), "no session token is handed out");
  }));
});

test("discord sign-in: a mismatched cookie is refused as firmly as a missing one", async () => {
  await withDiscordEnv(() => withRepoServer(async (base) => {
    const a = await beginFlow(base);
    const b = await beginFlow(base); // a second, unrelated flow
    const res = await fetch(`${base}/api/auth/discord/callback?code=x&state=${encodeURIComponent(a.state)}`, {
      redirect: "manual", headers: { cookie: b.cookie },
    });
    const frag = decodeURIComponent(res.headers.get("location") ?? "");
    assert.match(frag, /did not start in this browser/);
    assert.ok(!/discord_token=/.test(frag));
  }));
});

test("discord sign-in: the callback spends the cookie even when it refuses", async () => {
  await withDiscordEnv(() => withRepoServer(async (base) => {
    const { state, cookie } = await beginFlow(base);
    // A matching cookie gets past the binding check and on to the token exchange, which fails here
    // (there is no Discord to talk to) — the point is what happens to the cookie.
    const res = await fetch(`${base}/api/auth/discord/callback?code=bad&state=${encodeURIComponent(state)}`, {
      redirect: "manual", headers: { cookie },
    });
    assert.match(res.headers.get("set-cookie") ?? "", /hr_oauth_state=;.*Max-Age=0/,
      "a nonce that reached the callback once must not be usable again");
    const frag = decodeURIComponent(res.headers.get("location") ?? "");
    assert.ok(!/did not start in this browser/.test(frag), "it got past the binding check");
    assert.match(frag, /discord_error=/, "and failed later, at Discord");
  }));
});

test("discord link: /link/start binds the same way, for the signed-in user", async () => {
  await withDiscordEnv(() => withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    const res = await fetch(`${base}/api/auth/discord/link/start`, { headers: auth });
    const { url } = (await res.json()) as { url: string };
    const cookie = res.headers.get("set-cookie") ?? "";
    const nonce = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
    assert.match(nonce, /^link:/, "link mode carries the user id in the nonce");
    assert.ok(new URL(url).searchParams.get("state")!.startsWith(nonce), "and the state is signed over it");
  }));
});

/*
 * Linking Discord to the account you are signed in to folds in the account that Discord id already
 * belongs to (the duplicate a first Discord sign-in creates) and deletes it, roles and grants with
 * it. That did the merge under Users' work with none of its refusals: signed in to a spare account,
 * an owner linking their own Discord deleted the setup account and its owner grants, and left the
 * install with no owner at all. Discord's side is stubbed; every other request goes through.
 */
test("discord link: never merges away the setup account, or one holding more than the account signed in", async () => {
  const realFetch = globalThis.fetch;
  let discordId = "";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://discord.com/")) return realFetch(input, init);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/oauth2/token")) return json({ access_token: "tok" });
    if (url.endsWith("/users/@me")) return json({ id: discordId, username: `u${discordId}` });
    return json({ roles: [], nick: null });
  }) as typeof fetch;
  try {
    await withDiscordEnv(() => withRepoServer(async (base, repo) => {
      const owner = await ownerAuth(base);
      const setup = await repo.users.findByUsername("owner");
      await repo.users.linkDiscord(setup.id, { discordId: "100001", username: "owner-d" });
      const boss = await repo.users.create({ username: "boss", passwordHash: "h" });
      await repo.grants.create({ userId: boss.id, capability: "*", scopeType: "global", scopeId: null, level: "write" });
      await repo.users.linkDiscord(boss.id, { discordId: "100002", username: "boss-d" });
      const dupe = await repo.users.create({ username: "dupe", discordId: "100003", discordManaged: true });
      assert.equal((await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "spare", password: "pw" }) })).status, 201);
      const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "spare", password: "pw" }) });
      const spare = { authorization: `Bearer ${login.body.token as string}` };

      const linkAs = async (id: string) => {
        discordId = id;
        const start = await realFetch(`${base}/api/auth/discord/link/start`, { headers: spare });
        const { url } = (await start.json()) as { url: string };
        const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
        const state = new URL(url).searchParams.get("state")!;
        const done = await realFetch(`${base}/api/auth/discord/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie } });
        return decodeURIComponent(done.headers.get("location") ?? "");
      };

      assert.match(await linkAs("100001"), /discord_error=.*setup account/, "the setup account is never merged away");
      assert.ok(await repo.users.findById(setup.id), "…and is still there");
      assert.match(await linkAs("100002"), /discord_error=.*holds permissions this account does not/, "nor an account holding more");
      assert.ok(await repo.users.findById(boss.id), "…which is still there too");
      assert.match(await linkAs("100003"), /discord_linked=merged/, "a duplicate holding no more than this one is folded in");
      assert.equal(await repo.users.findById(dupe.id), null);
      assert.equal((await repo.users.findByUsername("spare")).discordId, "100003");
    }));
  } finally {
    globalThis.fetch = realFetch;
  }
});

/*
 * The point of the whole scoping chain, checked at the level a user experiences it.
 *
 * Discord role → panel role → user → grants. Every hop used to discard the server, so mapping a
 * Discord role handed its capabilities out across the entire community; "@Warfare Mods" could not
 * mean "moderator on Warfare". This asserts the grants that come out the far end are confined to
 * the server the mapping names.
 */
test("a Discord role mapped to one server grants access there and nowhere else", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const A = await repo.servers.create({ name: "Warfare", host: "10.0.0.1", port: 28011, password: "p" });
    const B = await repo.servers.create({ name: "Offensive", host: "10.0.0.2", port: 28012, password: "p" });
    const mod = await repo.roles.create({ name: "Mod", grants: [{ capability: "action.kick", level: "write" }], limits: {} });

    // Map it for Warfare only — the thing the old shape could not express.
    const put = await jf(`${base}/api/discord/role-map/d-warfare-mods`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ discordRoleName: "Warfare Mods", roles: [{ roleId: mod.id, scopeId: A.id }] }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.mappings.map((m: any) => m.scopeId), [A.id], "the scope survives the round trip");

    // Give a user that role on that server, the same way a Discord login would.
    const user = await repo.users.create({ username: "ada", passwordHash: "x" });
    await repo.userRoles.set(user.id, [{ roleId: mod.id, scopeId: A.id }]);

    const { resolveAccess } = await import("../dist/auth.js");
    const { can } = await import("@app/access");
    const access = await resolveAccess(repo, user.id);
    assert.equal(can(access.grants, "action.kick", "write", { serverId: A.id }), true, "the server it was granted on");
    assert.equal(can(access.grants, "action.kick", "write", { serverId: B.id }), false, "and NOT the other one");
    assert.equal(can(access.grants, "action.kick", "write"), false, "nor community-wide");

    // Widening it to everywhere reaches both servers — same role, different assignment.
    await repo.userRoles.set(user.id, [{ roleId: mod.id, scopeId: null }]);
    const wide = await resolveAccess(repo, user.id);
    assert.equal(can(wide.grants, "action.kick", "write", { serverId: B.id }), true);
    assert.equal(can(wide.grants, "action.kick", "write"), true);
  });
});

test("an unscoped role map keeps meaning everywhere, and roleIds still works", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mod = await repo.roles.create({ name: "Mod", grants: [{ capability: "action.kick", level: "write" }], limits: {} });
    // The original request shape, unchanged — an old client or a script must not start failing.
    const put = await jf(`${base}/api/discord/role-map/d-all`, {
      method: "PUT", headers: auth, body: JSON.stringify({ discordRoleName: "Staff", roleIds: [mod.id] }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.mappings.map((m: any) => m.scopeId), [null], "no scope means community-wide, as before");

    // An unknown server is refused rather than silently stored as an assignment granting nothing.
    const bad = await jf(`${base}/api/discord/role-map/d-bad`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ roles: [{ roleId: mod.id, scopeId: "11111111-1111-1111-1111-111111111111" }] }),
    });
    assert.equal(bad.status, 400);
  });
});
