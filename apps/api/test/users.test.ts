import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jsonFetch } from "./harness.ts";
import { vault } from "./vault-plugin.ts";

async function login(base: string, username: string, password: string) {
  const r = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

async function ownerAuth(base: string) {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return login(base, "owner", "pw");
}

test("owner creates a user, grants a capability, and it takes effect", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);

    const caps = await jsonFetch(`${base}/api/capabilities`, { headers: owner });
    assert.ok((caps.body.capabilities as any[]).some((c) => c.key === "audit.trail"));

    const created = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "mod", password: "pw" }) });
    assert.equal(created.status, 201);
    const modId = created.body.user.id as string;

    // mod has no analytics access yet
    const modAuth = await login(base, "mod", "pw");
    const denied = await jsonFetch(`${base}/api/audit`, { headers: modAuth });
    assert.equal(denied.status, 403);

    // grant staff.analytics read
    const grant = await jsonFetch(`${base}/api/users/${modId}/grants`, { method: "POST", headers: owner, body: JSON.stringify({ capability: "audit.trail", scopeType: "global", level: "read" }) });
    assert.equal(grant.status, 201);

    // now mod can read analytics
    const allowed = await jsonFetch(`${base}/api/audit`, { headers: modAuth });
    assert.equal(allowed.status, 200);

    // revoke removes it again
    const grantId = grant.body.grant.id as string;
    const revoked = await jsonFetch(`${base}/api/users/${modId}/grants/${grantId}`, { method: "DELETE", headers: owner });
    assert.equal(revoked.status, 200);
    const deniedAgain = await jsonFetch(`${base}/api/audit`, { headers: modAuth });
    assert.equal(deniedAgain.status, 403);
  });
});

test("non-admin cannot manage users; validation + duplicate guarded", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = await login(base, "plain", "pw");

    assert.equal((await jsonFetch(`${base}/api/users`, { headers: plain })).status, 403);
    assert.equal((await jsonFetch(`${base}/api/users`, { method: "POST", headers: plain, body: JSON.stringify({ username: "x", password: "y" }) })).status, 403);

    // duplicate username
    assert.equal((await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "plain", password: "pw" }) })).status, 409);
    // bad grant
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "mod2", password: "pw" }) });
    const bad = await jsonFetch(`${base}/api/users/${u.body.user.id}/grants`, { method: "POST", headers: owner, body: JSON.stringify({ capability: "server.view", scopeType: "server", level: "read" }) });
    assert.equal(bad.status, 400); // server scope needs scopeId
  });
});

test("PUT grants replaces the whole set in place (matrix save)", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "mod", password: "pw" }) });
    const id = u.body.user.id as string;

    // apply a bundle
    const set1 = await jsonFetch(`${base}/api/users/${id}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [
        { capability: "server.view", scopeType: "global", level: "read" },
        { capability: "audit.trail", scopeType: "global", level: "read" },
      ] }),
    });
    assert.equal(set1.status, 200);
    assert.equal((set1.body.grants as any[]).length, 2);

    // tune it: analytics gone, view upgraded to write — one call, no revoke dance
    const set2 = await jsonFetch(`${base}/api/users/${id}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "server.view", scopeType: "global", level: "write" }] }),
    });
    assert.equal(set2.status, 200);
    const modAuth = await login(base, "mod", "pw");
    assert.equal((await jsonFetch(`${base}/api/audit`, { headers: modAuth })).status, 403);

    // unknown capability rejected
    const bad = await jsonFetch(`${base}/api/users/${id}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "nope.nope", scopeType: "global", level: "read" }] }),
    });
    assert.equal(bad.status, 400);
  });
});

test("lockout guards: last owner keeps star, self keeps user-admin, only owner undeletable", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const me = await jsonFetch(`${base}/api/me`, { headers: owner });
    const ownerId = me.body.user.id as string;

    // owner cannot drop their own star while they're the only owner
    const drop = await jsonFetch(`${base}/api/users/${ownerId}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "server.view", scopeType: "global", level: "read" }] }),
    });
    assert.equal(drop.status, 400);

    // owner cannot delete themself
    assert.equal((await jsonFetch(`${base}/api/users/${ownerId}`, { method: "DELETE", headers: owner })).status, 400);

    // with a second owner, the first CAN step down
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "second", password: "pw" }) });
    await jsonFetch(`${base}/api/users/${u.body.user.id}/grants`, {
      method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "*", scopeType: "global", level: "write" }] }),
    });
    const stepDown = await jsonFetch(`${base}/api/users/${ownerId}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "admin.users", scopeType: "global", level: "write" }] }),
    });
    assert.equal(stepDown.status, 200);
  });
});

test("temp-ban duration limit is enforced per user (owners exempt)", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    // A fast-refusing server so within-limit requests fail at connect, not at the limit gate.
    const srv = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "t", host: "127.0.0.1", port: 1, password: "x" }) });
    const serverId = (srv.body.server as any).id as string;

    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "jr", password: "pw" }) });
    const set = await jsonFetch(`${base}/api/users/${u.body.user.id}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({
        grants: [{ capability: "action.tempban", scopeType: "global", level: "write" }],
        limits: { "tempban.maxHours": 24 },
      }),
    });
    assert.equal(set.status, 200);
    assert.equal((set.body.limits as any)["tempban.maxHours"], 24);

    const jr = await login(base, "jr", "pw");
    // Over the cap is NO LONGER a flat refusal on a single server: the split executes AT the cap
    // and files the remainder for approval (see approvals.test.ts for the full flow). Here the
    // server is unreachable, so the capped attempt fails at connect — the point is that the
    // limit gate no longer answers 403 before trying what WAS within the actor's authority.
    const over = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: jr,
      body: JSON.stringify({ action: "tempban", playerId: "1", hours: 48 }),
    });
    assert.notEqual(over.status, 403, "the cap now splits instead of refusing");

    // within the cap → passes the gate (fails later at connect: not 403)
    const within = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: jr,
      body: JSON.stringify({ action: "tempban", playerId: "1", hours: 12 }),
    });
    assert.notEqual(within.status, 403);

    // unknown limit key rejected
    const bad = await jsonFetch(`${base}/api/users/${u.body.user.id}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [], limits: { "nope.maxThings": 5 } }),
    });
    assert.equal(bad.status, 400);

    // the owner (star grant) is never limited — gate passes even for huge values
    const ownerBan = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ action: "tempban", playerId: "1", hours: 9999 }),
    });
    assert.notEqual(ownerBan.status, 403);
  });
});

test("roles: bundle applies to members, edits propagate, limits enforced via role", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const srv = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "t", host: "127.0.0.1", port: 1, password: "x" }) });
    const serverId = (srv.body.server as any).id as string;

    // create a role: analytics read + actions write with a 24h temp-ban cap
    const created = await jsonFetch(`${base}/api/roles`, {
      method: "POST", headers: owner,
      body: JSON.stringify({
        name: "TMOD",
        grants: [
          { capability: "audit.trail", level: "read" },
          { capability: "action.kick", level: "write" },
          { capability: "action.tempban", level: "write" },
        ],
        limits: { "tempban.maxHours": 24 },
      }),
    });
    assert.equal(created.status, 201);
    const roleId = created.body.role.id as string;

    // duplicate name refused
    assert.equal((await jsonFetch(`${base}/api/roles`, { method: "POST", headers: owner, body: JSON.stringify({ name: "tmod" }) })).status, 409);

    // a user with NO individual grants gets everything through the role
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "tm", password: "pw" }) });
    await jsonFetch(`${base}/api/users/${u.body.user.id}/roles`, { method: "PUT", headers: owner, body: JSON.stringify({ roleIds: [roleId] }) });
    const tm = await login(base, "tm", "pw");
    assert.equal((await jsonFetch(`${base}/api/audit`, { headers: tm })).status, 200);

    // The role's temp-ban cap binds its members. Over the cap it now SPLITS (capped ban now,
    // remainder filed — see approvals.test.ts) instead of refusing outright; on this dead test
    // server the capped attempt fails at connect, which is precisely NOT a 403 at the limit gate.
    const over = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: tm, body: JSON.stringify({ action: "tempban", playerId: "1", hours: 72 }),
    });
    assert.notEqual(over.status, 403, "the cap splits instead of refusing");

    // editing the role updates members immediately: drop analytics
    const upd = await jsonFetch(`${base}/api/roles/${roleId}`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "action.kick", level: "write" }, { capability: "action.tempban", level: "write" }] }),
    });
    assert.equal(upd.status, 200);
    assert.equal((await jsonFetch(`${base}/api/audit`, { headers: tm })).status, 403);

    // removing the role removes the access: the kick no longer executes — without the write it
    // files as an approval request instead (202, requested), never firing at the game.
    await jsonFetch(`${base}/api/users/${u.body.user.id}/roles`, { method: "PUT", headers: owner, body: JSON.stringify({ roleIds: [] }) });
    const gone = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: tm, body: JSON.stringify({ action: "kick", playerId: "1", reason: "x" }),
    });
    assert.equal(gone.status, 202);
    assert.equal((gone.body as any).requested, true);

    // role delete works and guards don't trip (role has no star)
    assert.equal((await jsonFetch(`${base}/api/roles/${roleId}`, { method: "DELETE", headers: owner })).status, 200);
  });
});

test("roles: ownership via a role counts for lockout guards", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const me = await jsonFetch(`${base}/api/me`, { headers: owner });
    const ownerId = me.body.user.id as string;

    // an "Owners" role carrying the star
    const created = await jsonFetch(`${base}/api/roles`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "Owners", grants: [{ capability: "*", level: "write" }] }),
    });
    const roleId = created.body.role.id as string;
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "co", password: "pw" }) });
    await jsonFetch(`${base}/api/users/${u.body.user.id}/roles`, { method: "PUT", headers: owner, body: JSON.stringify({ roleIds: [roleId] }) });

    // with a role-based co-owner, the original owner may step down
    const stepDown = await jsonFetch(`${base}/api/users/${ownerId}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "admin.users", scopeType: "global", level: "write" }] }),
    });
    assert.equal(stepDown.status, 200);

    // Stepped down, the former owner no longer outranks the role at all; the co-owner — the one
    // owner left — meets the lockout guards.
    assert.equal((await jsonFetch(`${base}/api/roles/${roleId}`, { method: "DELETE", headers: owner })).status, 403);
    const co = await login(base, "co", "pw");
    // now the star role protects the last owner: deleting it would leave none
    assert.equal((await jsonFetch(`${base}/api/roles/${roleId}`, { method: "DELETE", headers: co })).status, 400);
    // and stripping the star from the role is refused too
    const strip = await jsonFetch(`${base}/api/roles/${roleId}`, {
      method: "PUT", headers: co, body: JSON.stringify({ grants: [{ capability: "server.view", level: "read" }] }),
    });
    assert.equal(strip.status, 400);
    // and the co-owner cannot lose their only star role
    const unassign = await jsonFetch(`${base}/api/users/${u.body.user.id}/roles`, {
      method: "PUT", headers: co, body: JSON.stringify({ roleIds: [] }),
    });
    assert.equal(unassign.status, 400);
  });
});

test("server list is scoped: users only see servers they can view", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const s1 = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "one", host: "127.0.0.1", port: 1, password: "x" }) });
    const s2 = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "two", host: "127.0.0.1", port: 2, password: "x" }) });
    const id1 = (s1.body.server as any).id as string;
    assert.ok((s2.body.server as any).id);

    // scoped viewer: server.view on server one only
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "scoped", password: "pw" }) });
    await jsonFetch(`${base}/api/users/${u.body.user.id}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "server.view", scopeType: "server", scopeId: id1, level: "read" }] }),
    });
    const scoped = await login(base, "scoped", "pw");
    const list = await jsonFetch(`${base}/api/servers`, { headers: scoped });
    assert.equal(list.status, 200);
    assert.deepEqual((list.body.servers as any[]).map((s) => s.id), [id1]);

    // no grants at all → empty list, owner sees both
    const n = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "nogrants", password: "pw" }) });
    assert.ok(n.body.user.id);
    const none = await login(base, "nogrants", "pw");
    assert.equal(((await jsonFetch(`${base}/api/servers`, { headers: none })).body.servers as any[]).length, 0);
    assert.equal(((await jsonFetch(`${base}/api/servers`, { headers: owner })).body.servers as any[]).length, 2);
  });
});

test("password reset and user delete work end to end", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "temp", password: "old" }) });
    const id = u.body.user.id as string;

    assert.equal((await jsonFetch(`${base}/api/users/${id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ password: "new" }) })).status, 200);
    // old password rejected, new accepted
    assert.equal((await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "temp", password: "old" }) })).status, 401);
    const fresh = await login(base, "temp", "new");
    assert.ok(fresh.authorization.includes("Bearer "));

    assert.equal((await jsonFetch(`${base}/api/users/${id}`, { method: "DELETE", headers: owner })).status, 200);
    assert.equal((await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "temp", password: "new" }) })).status, 401);
  });
});

test("display preferences belong to the account, not the browser", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    // A fresh account has none, and /me carries them so the panel can paint the right colours
    // without a second round trip.
    const fresh = await jsonFetch(`${base}/api/me`, { headers: auth });
    assert.deepEqual(fresh.body.prefs, {});

    // Saving one setting must not erase the others — the panel saves them one at a time.
    await jsonFetch(`${base}/api/me/prefs`, { method: "PUT", headers: auth, body: JSON.stringify({ accent: "#64748b", themeMode: "dark" }) });
    const second = await jsonFetch(`${base}/api/me/prefs`, { method: "PUT", headers: auth, body: JSON.stringify({ density: "cozy" }) });
    assert.deepEqual(second.body.prefs, { accent: "#64748b", themeMode: "dark", density: "cozy" });

    // And they come back on the next sign-in — which is the whole point: set the colour on a
    // desktop, open the panel on a phone, get the same colour.
    const me = await jsonFetch(`${base}/api/me`, { headers: auth });
    assert.equal(me.body.prefs.accent, "#64748b");
    assert.equal(me.body.prefs.density, "cozy");

    // Clearing back to the theme default is a real value, not a missing one.
    const cleared = await jsonFetch(`${base}/api/me/prefs`, { method: "PUT", headers: auth, body: JSON.stringify({ accent: null }) });
    assert.equal(cleared.body.prefs.accent, null);
    assert.equal(cleared.body.prefs.density, "cozy", "clearing one setting leaves the rest");

    // Guards: an array is not a preference object, and the blob stays bounded.
    assert.equal((await jsonFetch(`${base}/api/me/prefs`, { method: "PUT", headers: auth, body: JSON.stringify([1, 2]) })).status, 400);
    assert.equal((await jsonFetch(`${base}/api/me/prefs`, { method: "PUT", headers: auth, body: JSON.stringify({ junk: "x".repeat(9000) }) })).status, 400);
    assert.equal((await jsonFetch(`${base}/api/me/prefs`, { method: "PUT", body: JSON.stringify({ accent: "#fff" }) })).status, 401);
  });
});

/*
 * The short-lived "ask" grant level is gone — lacking write IS the ask, so no grant vocabulary
 * carries it. The matrix must refuse it wherever a level is accepted, for roles and personal
 * grants alike, or an old client could quietly store a level nothing reads.
 */
test("'ask' is not a grant level — roles and personal grants both refuse it", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);

    const created = await jsonFetch(`${base}/api/roles`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Event lead" }) });
    assert.equal(created.status, 201);
    const evId = (created.body.role as any).id as string;
    assert.equal((await jsonFetch(`${base}/api/roles/${evId}`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "action.tempban", level: "ask" }] }) })).status, 400);

    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "asker", password: "pw" }) });
    const askerId = ((await jsonFetch(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === "asker").id;
    assert.equal((await jsonFetch(`${base}/api/users/${askerId}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability: "action.kick", level: "ask" }] }) })).status, 400);
  });
});

/*
 * User admin is gated scope-blind (canAnywhere), so a "*" confined to one server passes it. What
 * that admin may NOT do is confer what is only ever held outright — a global "*" (ownership) or a
 * plugin's outright permission (the test vault's) — through any door: a grant, the matrix, a role, a
 * role assignment or a Discord role mapping. The owner is not held back, and re-saving a set that
 * already carries such a grant is not an escalation.
 */
test("a one-server admin cannot confer ownership or an outright-only capability", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const made = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "S", host: "127.0.0.1", port: 1, password: "x", game: "hll" }),
    });
    const sid = made.body.server.id as string;
    const mk = async (username: string, grants: unknown[]) => {
      const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
      const id = u.body.user.id as string;
      assert.equal((await jsonFetch(`${base}/api/users/${id}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants }) })).status, 200);
      return { id, auth: await login(base, username, "pw") };
    };
    const serverStar = { capability: "*", scopeType: "server", scopeId: sid, level: "write" };
    const scoped = await mk("scoped", [serverStar]);
    const target = await mk("target", [{ capability: "server.view", scopeType: "global", level: "read" }]);
    const globalStar = { capability: "*", scopeType: "global", level: "write" };
    const vaultView = { capability: "vault.view", scopeType: "global", level: "read" };

    // Grants, one at a time and as a whole set — on someone else and on themselves.
    for (const g of [globalStar, { ...globalStar, level: "read" }, vaultView]) {
      assert.equal((await jsonFetch(`${base}/api/users/${target.id}/grants`, { method: "POST", headers: scoped.auth, body: JSON.stringify(g) })).status, 403, `single ${JSON.stringify(g)}`);
      assert.equal((await jsonFetch(`${base}/api/users/${scoped.id}/grants`, { method: "POST", headers: scoped.auth, body: JSON.stringify(g) })).status, 403, `single on self ${JSON.stringify(g)}`);
      assert.equal((await jsonFetch(`${base}/api/users/${target.id}/grants`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [g] }) })).status, 403, `matrix ${JSON.stringify(g)}`);
    }
    assert.equal((await jsonFetch(`${base}/api/users/${scoped.id}/grants`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [serverStar, globalStar] }) })).status, 403, "matrix on self");
    // An ordinary global capability is still theirs to hand out — the rule is narrow.
    assert.equal((await jsonFetch(`${base}/api/users/${target.id}/grants`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ capability: "audit.trail", scopeType: "global", level: "read" }) })).status, 201);

    // Roles: creating or editing one that carries them, and assigning or mapping one that does.
    assert.equal((await jsonFetch(`${base}/api/roles`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ name: "Mine", grants: [{ capability: "*", level: "write" }] }) })).status, 403);
    const plain = await jsonFetch(`${base}/api/roles`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ name: "Plain", grants: [{ capability: "server.view", level: "read" }] }) });
    assert.equal(plain.status, 201);
    assert.equal((await jsonFetch(`${base}/api/roles/${plain.body.role.id}`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [{ capability: "vault.view", level: "read" }] }) })).status, 403);
    const ownerRole = await jsonFetch(`${base}/api/roles`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Owners", grants: [{ capability: "*", level: "write" }] }) });
    assert.equal(ownerRole.status, 201, "the owner may make one");
    const rid = ownerRole.body.role.id as string;
    assert.equal((await jsonFetch(`${base}/api/users/${scoped.id}/roles`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ roles: [{ roleId: rid, scopeId: null }] }) })).status, 403, "assigned everywhere");
    assert.equal((await jsonFetch(`${base}/api/users/${target.id}/roles`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ roles: [{ roleId: rid, scopeId: sid }] }) })).status, 200, "assigned to their own server only — that confers nothing everywhere");
    assert.equal((await jsonFetch(`${base}/api/discord/role-map/d1`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ roles: [{ roleId: rid, scopeId: null }], discordRoleName: "Mods" }) })).status, 403, "mapped everywhere");

    // Nothing was conferred: the one-server admin is still no owner.
    const me = await jsonFetch(`${base}/api/me`, { headers: scoped.auth });
    assert.ok(!(me.body.grants as { capability: string; scopeType: string }[]).some((g) => g.capability === "*" && g.scopeType === "global"), "no global wildcard reached them");

    // The owner is not held back, and re-saving a set that already carries it is no escalation.
    assert.equal((await jsonFetch(`${base}/api/users/${target.id}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [vaultView] }) })).status, 200);
    // Once the target holds what the one-server admin does not, the account is not theirs to change at all.
    assert.equal((await jsonFetch(`${base}/api/users/${target.id}/grants`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [vaultView, { capability: "audit.trail", scopeType: "global", level: "read" }] }) })).status, 403, "an account that outranks them");
    assert.equal((await jsonFetch(`${base}/api/discord/role-map/d2`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId: rid, scopeId: null }], discordRoleName: "Owners" }) })).status, 200);
  }, [vault]);
});
