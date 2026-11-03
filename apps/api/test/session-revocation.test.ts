/**
 * Ending a session that nothing on the server is holding.
 *
 * Web sessions are stateless signed tokens with a seven-day life, so before this there was no way
 * to end one. An account whose password leaked kept every power it has — banning players, rewriting
 * server config, issuing RCON — for up to a week, and resetting the password did nothing about it
 * (on purpose: that route is for a staffer who forgot theirs, and the sessions it would kill are
 * usually the same person's). API tokens were self-service only, so nobody but the holder could
 * revoke one. Between them, the only lockout available was deleting the account.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createIsolatedRepository } from "@app/db";
import { signSession, verifySession } from "@app/access";
import { createHandler, createAppContext } from "../dist/app.js";
import { jf } from "./harness.ts";

async function withRepoServer(fn: (base: string, repo: any) => Promise<void>): Promise<void> {
  // Its own schema against Postgres, its own store in memory — the isolation these tests were
  // written assuming. See createIsolatedRepository.
  const { repo, cleanup } = await createIsolatedRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); await cleanup(); }
}
const login = async (base: string, username: string, password: string) =>
  (await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password }) })).body.token as string;

/** An owner plus a second staff account that may make API tokens, both signed in. */
async function twoAccounts(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const ownerToken = await login(base, "owner", "pw");
  const auth = { authorization: `Bearer ${ownerToken}` };
  const made = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "mod", password: "pw2" }) });
  const modId = made.body.user.id as string;
  const grants = await jf(`${base}/api/users/${modId}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "api.tokens", level: "write" }] }) });
  assert.equal(grants.status, 200);
  return { auth, ownerToken, modId, modToken: await login(base, "mod", "pw2") };
}

test("signing an account out everywhere ends its sessions immediately", async () => {
  await withRepoServer(async (base) => {
    const { auth, modId, modToken } = await twoAccounts(base);
    const modAuth = { authorization: `Bearer ${modToken}` };

    assert.equal((await jf(`${base}/api/me`, { headers: modAuth })).status, 200, "the session works before revocation");

    const r = await jf(`${base}/api/users/${modId}/revoke-sessions`, { method: "POST", headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.body.sessionEpoch, 1, "the account moved to the next session epoch");
    assert.equal(r.body.self, false);

    // Same token, same signature, same expiry — and now worthless.
    assert.equal((await jf(`${base}/api/me`, { headers: modAuth })).status, 401, "the old session is refused");

    // The ACCOUNT is untouched: signing back in works and the new token is good.
    const fresh = await login(base, "mod", "pw2");
    assert.ok(fresh && fresh !== modToken, "a new sign-in mints a different token");
    assert.equal((await jf(`${base}/api/me`, { headers: { authorization: `Bearer ${fresh}` } })).status, 200);
  });
});

test("it revokes the account's API tokens too", async () => {
  await withRepoServer(async (base) => {
    const { auth, modId, modToken } = await twoAccounts(base);
    const modAuth = { authorization: `Bearer ${modToken}` };

    // A token an attacker minted is how they survive losing the session, so ending one without the
    // other is not a lockout.
    const made = await jf(`${base}/api/tokens`, { method: "POST", headers: modAuth, body: JSON.stringify({ name: "bot" }) });
    const apiToken = made.body.token as string;
    assert.equal((await jf(`${base}/api/me`, { headers: { authorization: `Bearer ${apiToken}` } })).status, 200);

    const r = await jf(`${base}/api/users/${modId}/revoke-sessions`, { method: "POST", headers: auth });
    assert.equal(r.body.tokensRevoked, 1);
    assert.equal((await jf(`${base}/api/me`, { headers: { authorization: `Bearer ${apiToken}` } })).status, 401, "the minted token is gone too");
  });
});

test("revoking one account leaves every other account signed in", async () => {
  await withRepoServer(async (base) => {
    const { auth, ownerToken, modId } = await twoAccounts(base);
    await jf(`${base}/api/users/${modId}/revoke-sessions`, { method: "POST", headers: auth });
    assert.equal((await jf(`${base}/api/me`, { headers: { authorization: `Bearer ${ownerToken}` } })).status, 200,
      "the epoch is per account, not global");
  });
});

test("a password reset deliberately does NOT sign anyone out", async () => {
  await withRepoServer(async (base) => {
    const { auth, modId, modToken } = await twoAccounts(base);
    await jf(`${base}/api/users/${modId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ password: "new-pw" }) });
    // The two routes answer different questions, and conflating them would sign a staffer out of
    // the browser they are asking for help in.
    assert.equal((await jf(`${base}/api/me`, { headers: { authorization: `Bearer ${modToken}` } })).status, 200);
  });
});

test("revocation is recorded in the audit trail", async () => {
  await withRepoServer(async (base) => {
    const { auth, modId, modToken } = await twoAccounts(base);
    await jf(`${base}/api/tokens`, { method: "POST", headers: { authorization: `Bearer ${modToken}` }, body: JSON.stringify({ name: "bot" }) });
    await jf(`${base}/api/users/${modId}/revoke-sessions`, { method: "POST", headers: auth });

    const trail = await jf(`${base}/api/audit?limit=50`, { headers: auth });
    const row = (trail.body.entries as any[]).find((e) => e.action === "user.revoke_sessions");
    assert.ok(row, "a lockout is exactly the kind of action the trail exists for");
    assert.equal(row.targetName, "mod");
    assert.match(row.summary, /signed mod out everywhere and revoked 1 API token/);
  });
});

test("signing YOURSELF out is allowed, and says so", async () => {
  await withRepoServer(async (base) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const token = await login(base, "owner", "pw");
    const auth = { authorization: `Bearer ${token}` };
    const me = await jf(`${base}/api/me`, { headers: auth });

    const r = await jf(`${base}/api/users/${me.body.user.id}/revoke-sessions`, { method: "POST", headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.body.self, true, "the response is the last thing this session gets — it should say so");
    assert.equal((await jf(`${base}/api/me`, { headers: auth })).status, 401);
    // And the owner is not locked out of their own panel: the credentials still work.
    assert.ok(await login(base, "owner", "pw"));
  });
});

test("a token from an older epoch stays refused across further revocations", async () => {
  await withRepoServer(async (base) => {
    const { auth, modId, modToken } = await twoAccounts(base);
    await jf(`${base}/api/users/${modId}/revoke-sessions`, { method: "POST", headers: auth });
    const second = await jf(`${base}/api/users/${modId}/revoke-sessions`, { method: "POST", headers: auth });
    assert.equal(second.body.sessionEpoch, 2, "each revocation moves the epoch on");
    assert.equal((await jf(`${base}/api/me`, { headers: { authorization: `Bearer ${modToken}` } })).status, 401,
      "an old token never comes back into range");
  });
});

/*
 * Staying signed in while the panel is in use. A sign-in lasted a week from when it was made, used
 * or not; the open panel asks for /me every minute, and that answer now carries a fresh week when
 * the current one is running down — up to thirty days after the person last actually signed in.
 */
test("a sign-in in use is renewed by /me, within its ceiling, and never past a revocation", async () => {
  await withRepoServer(async (base) => {
    const { auth, modId, modToken } = await twoAccounts(base);
    const me = (token: string) => jf(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    const now = Math.floor(Date.now() / 1000);
    const DAY = 24 * 3600;
    const claimsOf = (token: string) => verifySession(token, "test")!;

    // Just signed in: a whole week left, nothing to renew — nor half a day in, with six and a half
    // days left; renewing on every minute's check would sign a new token each time.
    const fresh = await me(modToken);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.session, undefined, "a fresh sign-in is not renewed");
    const halfDay = signSession({ sub: modId, exp: now + 7 * DAY - 12 * 3600, ep: 0, auth: now - 12 * 3600 }, "test");
    assert.equal((await me(halfDay)).body.session, undefined, "renewed only once less than six days are left");

    // Two days left, signed in five days ago: a new week, the same account and epoch, and the
    // original sign-in time carried forward.
    const ageing = signSession({ sub: modId, exp: now + 2 * DAY, ep: 0, auth: now - 5 * DAY }, "test");
    const renewed = await me(ageing);
    assert.equal(renewed.status, 200);
    const next = renewed.body.session?.token as string;
    assert.ok(next, "a sign-in running down gets a fresh one");
    const c = claimsOf(next);
    assert.equal(c.sub, modId);
    assert.equal(c.ep, 0);
    assert.equal(c.auth, now - 5 * DAY, "renewing is not signing in");
    assert.ok(Math.abs(c.exp - (now + 7 * DAY)) <= 5, "a week from now");
    assert.equal((await me(next)).status, 200, "and it works");

    // A token from before the sign-in time was carried counts its week back from its expiry.
    const legacy = signSession({ sub: modId, exp: now + 2 * DAY, ep: 0 }, "test");
    assert.equal(claimsOf((await me(legacy)).body.session.token).auth, now + 2 * DAY - 7 * DAY);

    // Near the ceiling the week is cut short, and at it there is no more renewing.
    const nearCap = signSession({ sub: modId, exp: now + 2 * DAY, ep: 0, auth: now - 27 * DAY }, "test");
    assert.ok(Math.abs(claimsOf((await me(nearCap)).body.session.token).exp - (now + 3 * DAY)) <= 5, "thirty days after signing in, not a week from now");
    const atCap = signSession({ sub: modId, exp: now + 2 * DAY, ep: 0, auth: now - 28 * DAY }, "test");
    assert.equal((await me(atCap)).body.session, undefined, "a sign-in at its ceiling runs out; the next one is real");

    // API tokens carry their own expiry and are never handed a session.
    const made = await jf(`${base}/api/tokens`, { method: "POST", headers: { authorization: `Bearer ${modToken}` }, body: JSON.stringify({ name: "bot" }) });
    const byApiToken = await me(made.body.token as string);
    assert.equal(byApiToken.status, 200, "the API token signs in");
    assert.equal(byApiToken.body.session, undefined);

    // Signed out everywhere: neither the old sign-in nor its renewal gets in, and nothing is renewed.
    await jf(`${base}/api/users/${modId}/revoke-sessions`, { method: "POST", headers: auth });
    assert.equal((await me(ageing)).status, 401);
    assert.equal((await me(next)).status, 401, "a renewal answers to the epoch like any sign-in");

    // A sign-in made after that renews on the new epoch, not the old one.
    const { ep } = claimsOf(await login(base, "mod", "pw2"));
    assert.ok(ep, "signing out everywhere moved the epoch on");
    const later = await me(signSession({ sub: modId, exp: now + 2 * DAY, ep, auth: now - DAY }, "test"));
    const again = later.body.session?.token as string;
    assert.equal(claimsOf(again).ep, ep);
    assert.equal((await me(again)).status, 200);
  });
});
