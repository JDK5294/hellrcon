import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, askedFor } from "./harness.ts";

async function makeGameServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "s", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}
/** Create a staff user with the given global grants and return their auth header. */
async function staffAuth(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string; scopeType?: string; scopeId?: string | null }[]) {
  const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  const put = await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
    method: "PUT", headers: owner,
    body: JSON.stringify({ grants: grants.map((g) => ({ scopeType: "global", scopeId: null, ...g })) }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

test("fine-grained config caps: each feature needs ITS capability, umbrellas no longer unlock it", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeGameServer(base, owner);

    // broadcast.config unlocks broadcasts — and nothing else
    const bcast = await staffAuth(base, owner, "bcast", [{ capability: "broadcast.config", level: "write" }, { capability: "server.view", level: "read" }]);
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast`, { method: "PUT", headers: bcast, body: JSON.stringify({ enabled: false }) })).status, 200);
    // Not their capability, so it does not APPLY — it files for someone whose capability it is.
    // The proof is the same either way: the write did not happen under their own permission.
    const notTheirs = await jf(`${base}/api/servers/${id}/autosettings`, { method: "PUT", headers: bcast, body: JSON.stringify({ enabled: false }) });
    assert.equal(notTheirs.status, 202, JSON.stringify(notTheirs.body));
    assert.equal(notTheirs.body.requested, true);
    const templates = async () => ((await jf(`${base}/api/templates`, { headers: owner })).body.templates as unknown[]).length;
    const asked = await jf(`${base}/api/templates`, { method: "POST", headers: bcast, body: JSON.stringify({ kind: "message", label: "x", body: "y" }) });
    assert.deepEqual(await askedFor(base, owner, asked), { capability: "templates.manage", serverId: null });
    assert.equal(await templates(), 0, "no template saved on the asking");

    // the old server.config umbrella no longer unlocks the split-out features
    const legacy = await staffAuth(base, owner, "legacy", [{ capability: "server.config", level: "write" }]);
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast`, { method: "PUT", headers: legacy, body: JSON.stringify({ enabled: false }) })).body.requested, true);
    assert.equal((await jf(`${base}/api/servers/${id}/discord`, { method: "PUT", headers: legacy, body: JSON.stringify({}) })).body.requested, true);

    // templates.manage unlocks template writes specifically
    const tmpl = await staffAuth(base, owner, "tmpl", [{ capability: "templates.manage", level: "write" }]);
    assert.equal((await jf(`${base}/api/templates`, { method: "POST", headers: tmpl, body: JSON.stringify({ kind: "message", label: "x", body: "y" }) })).status, 201);
  });
});

test("permission denials say exactly which capability is missing", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeGameServer(base, owner);
    const viewer = await staffAuth(base, owner, "viewer", [{ capability: "server.view", level: "read" }]);

    /*
     * On a READ, because a server-scoped write is no longer refused at all — it is filed for
     * approval, which is a different (and better) answer to "you cannot do this". Everything a
     * denial has to carry is unchanged; only the example had to move to a route that still denies.
     */
    const denied = await jf(`${base}/api/servers/${id}/autosettings`, { headers: viewer });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.missing.capability, "autosettings.profiles");
    assert.equal(denied.body.error.missing.level, "read");
    assert.match(denied.body.error.message as string, /Auto settings/);
    assert.match(denied.body.error.message as string, /read access required/);
  });
});

test("explicit none blocks a capability a role confers — even viewing", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeGameServer(base, owner);

    // role that grants viewing; member gets it via the role
    const role = await jf(`${base}/api/roles`, { method: "POST", headers: owner, body: JSON.stringify({ name: "watchers", grants: [{ capability: "server.view", level: "read" }] }) });
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "blocked", password: "pw" }) });
    const uid = u.body.user.id as string;
    await jf(`${base}/api/users/${uid}/roles`, { method: "PUT", headers: owner, body: JSON.stringify({ roleIds: [role.body.role.id] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "blocked", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };

    // via the role they can view…
    assert.equal((await jf(`${base}/api/servers/${id}/events`, { headers: auth })).status, 200);

    // …until a personal explicit-none grant vetoes it
    const veto = await jf(`${base}/api/users/${uid}/grants`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ capability: "server.view", scopeType: "global", scopeId: null, level: "none" }),
    });
    assert.equal(veto.status, 201, JSON.stringify(veto.body));
    const after = await jf(`${base}/api/servers/${id}/events`, { headers: auth });
    assert.equal(after.status, 403);
    assert.equal(after.body.error.missing.capability, "server.view");
  });
});

/**
 * The regressions a scan found: three ways "no scope context" was being read as "must hold a
 * GLOBAL grant". The panel's nav has always been scope-blind, so each of these showed a moderator
 * a section and then refused to open it.
 */
test("a server-scoped moderator can open the cross-server pages their nav offers", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeGameServer(base, owner);
    // Grants ONLY on that one server — no global grant anywhere.
    const mod = await staffAuth(base, owner, "scopedmod", [
      { capability: "server.view", level: "read", scopeType: "server", scopeId: id },
      { capability: "moderation.bans", level: "read", scopeType: "server", scopeId: id },
      { capability: "vip.grant", level: "write", scopeType: "server", scopeId: id },
    ]);

    // These span servers, so there is no id to scope the check by — but a per-server grant must
    // still get in. Previously every one of them was a 403.
    for (const path of ["/api/players", "/api/players/flagged", "/api/leaderboard", "/api/templates", "/api/bans"]) {
      const r = await jf(`${base}${path}`, { headers: mod });
      assert.equal(r.status, 200, `${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    }

    // VIP history asked for a capability that does not exist ("vip"), so it matched only the
    // owner's wildcard — an admin holding vip.grant got a 403 on their own feature.
    const vip = await jf(`${base}/api/players/76561198000000001/vip-history`, { headers: mod });
    assert.equal(vip.status, 200, JSON.stringify(vip.body));
  });
});

test("a server-scoped import grant works on its server, and only on its server", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const mine = await makeGameServer(base, owner);
    const theirs = await jf(`${base}/api/servers`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "other", host: "127.0.0.1", port: 2, password: "x" }),
    });
    const other = theirs.body.server.id as string;
    const importer = await staffAuth(base, owner, "importer", [
      { capability: "crcon.pull", level: "write", scopeType: "server", scopeId: mine },
    ]);

    // The check never received the server id, so a scoped grant could not satisfy it at all.
    const ok = await jf(`${base}/api/servers/${mine}/import/crcon/job/pause`, { method: "POST", headers: importer });
    assert.notEqual(ok.status, 403, `own server should not be forbidden: ${JSON.stringify(ok.body)}`);
    // And now that the id IS passed, the grant stops at its own server rather than covering all.
    const denied = await jf(`${base}/api/servers/${other}/import/crcon/job/pause`, { method: "POST", headers: importer });
    assert.equal(denied.status, 403, `other server should be forbidden: ${JSON.stringify(denied.body)}`);
  });
});

/**
 * The two grant-writing routes validated separately, and had drifted apart in a direction that
 * mattered. These pin the union of both.
 */
test("the single-grant route enforces the same rules as the permission-matrix editor", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "target", password: "pw" }) });
    const id = u.body.user.id as string;
    const post = (g: Record<string, unknown>) => jf(`${base}/api/users/${id}/grants`, { method: "POST", headers: owner, body: JSON.stringify(g) });

    // The one that mattered: admin.users is community-wide, so a server-scoped grant of it is a
    // contradiction — and `canAnywhere`, which every admin route guards with, ignores scope, so it
    // would have conferred user-admin everywhere while reading as limited to one server.
    const escalation = await post({ capability: "admin.users", scopeType: "server", scopeId: serverId, level: "write" });
    assert.equal(escalation.status, 400, JSON.stringify(escalation.body));
    assert.match(escalation.body.error.message as string, /cannot be scoped per server/);

    // A capability that does not exist used to be stored verbatim and simply never match.
    const unknown = await post({ capability: "not.a.capability", scopeType: "global", level: "write" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error.message as string, /unknown capability/);

    // A scope id that names no server is a grant that can never apply.
    const ghost = await post({ capability: "server.view", scopeType: "server", scopeId: "00000000-0000-0000-0000-000000000000", level: "read" });
    assert.equal(ghost.status, 400);
    assert.match(ghost.body.error.message as string, /unknown server/);

    // What should still work: a real server-scoped grant of a scoped capability, and the
    // server-scoped wildcard that means "full control of this one server".
    assert.equal((await post({ capability: "server.view", scopeType: "server", scopeId: serverId, level: "read" })).status, 201);
    assert.equal((await post({ capability: "*", scopeType: "server", scopeId: serverId, level: "write" })).status, 201);
  });
});

test("group-scoped grants are refused rather than stored as a permission that does nothing", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "grouped", password: "pw" }) });
    const id = u.body.user.id as string;

    // Nothing populates ResolveContext.serverGroupIds — there are no server groups — so a
    // group-scoped grant never applies. Stored, it was worse than useless in the deny direction:
    // a group-scoped `none`, meant to lock someone out of a set of servers, locked out nobody.
    for (const level of ["write", "none"]) {
      const res = await jf(`${base}/api/users/${id}/grants`, {
        method: "POST", headers: owner,
        body: JSON.stringify({ capability: "server.view", scopeType: "group", scopeId: "some-group", level }),
      });
      assert.equal(res.status, 400, `group scope at level ${level} must be refused`);
      assert.match(res.body.error.message as string, /no server groups/);
    }

    const listed = await jf(`${base}/api/users/${id}`, { headers: owner });
    assert.equal((listed.body.grants as unknown[]).length, 0, "nothing inert was stored");
  });
});
