/**
 * A scoped capability granted on ONE server is not authority over the others.
 *
 * Most server-scoped work goes through `serverRoute`, which gates on the server in the path. The
 * routes worth pinning here are the ones that do NOT take a server in the path: they gate with
 * `canAnywhere` — which only asks whether the account holds the capability somewhere — and then
 * read or write a specific server named in the body, or sweep the whole community. That shape is
 * fine when the capability is community-wide by declaration (templates, users, enforcer rules are
 * `scoped: false`); it is a privilege escalation when the capability is scoped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { askedFor, jf, ownerAuth, withServer } from "./harness.ts";

/** An account holding `cap` at write on exactly one server, plus the ids of both servers. */
async function twoServersOneGrant(base: string, cap: string) {
  const auth = await ownerAuth(base);
  const mine = await jf(`${base}/api/servers`, {
    method: "POST", headers: auth, body: JSON.stringify({ name: "Mine", host: "10.0.0.1", port: 1, password: "x", game: "hll" }),
  });
  const theirs = await jf(`${base}/api/servers`, {
    method: "POST", headers: auth, body: JSON.stringify({ name: "Theirs", host: "10.0.0.2", port: 2, password: "x", game: "hll" }),
  });
  const mineId = (mine.body.server as { id: string }).id;
  const theirsId = (theirs.body.server as { id: string }).id;

  const created = await jf(`${base}/api/users`, {
    method: "POST", headers: auth, body: JSON.stringify({ username: "mod", password: "pw" }),
  });
  const userId = (created.body.user as { id: string }).id;
  const granted = await jf(`${base}/api/users/${userId}/grants`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({ grants: [{ capability: cap, level: "write", scopeType: "server", scopeId: mineId }] }),
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "mod", password: "pw" }) });
  return { auth, modAuth: { authorization: `Bearer ${login.body.token as string}` }, mineId, theirsId };
}

test("seeding the ban record visits only the servers the account may sync", async () => {
  await withServer(async (base) => {
    const { modAuth, mineId, theirsId } = await twoServersOneGrant(base, "moderation.bans.sync");

    const r = await jf(`${base}/api/bans/seed`, { method: "POST", headers: modAuth, body: "{}" });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // Neither server is reachable in a test, so every attempt fails — but WHICH servers were
    // attempted is the whole question: a seed reads a server's ban list and writes decisions
    // covering it, and the second server was never this account's to touch.
    const visited = (r.body.servers as { serverId: string }[]).map((s) => s.serverId);
    assert.deepEqual(visited, [mineId], "only the granted server is contacted");
    const outOfScope = (r.body.outOfScope as { serverId: string }[]).map((s) => s.serverId);
    assert.deepEqual(outOfScope, [theirsId], "and the rest are named, not silently missing");
  });
});

test("an account with no ban-sync rights anywhere cannot seed at all — it can only ask", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await jf(`${base}/api/servers`, {
      method: "POST", headers: auth, body: JSON.stringify({ name: "S", host: "10.0.0.1", port: 1, password: "x", game: "hll" }),
    });
    const created = await jf(`${base}/api/users`, {
      method: "POST", headers: auth, body: JSON.stringify({ username: "nobody", password: "pw" }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "nobody", password: "pw" }) });
    const r = await jf(`${base}/api/bans/seed`, {
      method: "POST", headers: { authorization: `Bearer ${login.body.token as string}` }, body: "{}",
    });
    assert.deepEqual(await askedFor(base, auth, r), { capability: "moderation.bans.sync", serverId: null });
    assert.deepEqual(await repo.audit.list({ actions: ["bans.seed"] }), [], "no seed ran on the asking");
  });
});

test("a template may only be cut from a server the account holds — it copies that server's settings", async () => {
  await withServer(async (base) => {
    const { auth, modAuth, mineId, theirsId } = await twoServersOneGrant(base, "autosettings.templates");

    const foreign = await jf(`${base}/api/autosettings/templates`, {
      method: "POST", headers: modAuth, body: JSON.stringify({ name: "stolen", serverId: theirsId }),
    });
    // Another server's auto-settings are not readable through a template: it is asked of someone
    // holding the key on THAT server, and nothing is saved on the asking.
    assert.deepEqual(await askedFor(base, auth, foreign), { capability: "autosettings.templates", serverId: theirsId });
    assert.deepEqual((await jf(`${base}/api/autosettings/templates`, { headers: auth })).body.templates, []);

    const own = await jf(`${base}/api/autosettings/templates`, {
      method: "POST", headers: modAuth, body: JSON.stringify({ name: "mine", serverId: mineId }),
    });
    assert.equal(own.status, 200, JSON.stringify(own.body));
  });
});
