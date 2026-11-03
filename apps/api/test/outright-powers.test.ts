/**
 * What only an owner holds — a global "*", and the capabilities only ever held outright — must not
 * reach anyone else through a side door.
 *
 * User admin is gated scope-blind (canAnywhere), so the admin of ONE server passes it. users.test.ts
 * pins the front doors (granting "*" or a plugin's outright permission directly). This file pins
 * the side doors, with the test vault's permission (vault-plugin.ts) as the outright one: a veto
 * lifted rather than a grant added, a decoy "*" that fools the last-owner guard, the owner's account
 * itself (password, sessions, merge, delete), an archive import, and Discord management switched
 * back on. Every change is judged on the EFFECTIVE result, so a downgrade still goes through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repository } from "@app/db";
import { withIsolatedServer, jsonFetch as jf } from "./harness.ts";
import { vault } from "./vault-plugin.ts";

const withServer = (fn: Parameters<typeof withIsolatedServer>[0]) => withIsolatedServer(fn, [vault]);

type Auth = { authorization: string };

async function login(base: string, username: string, password: string): Promise<Auth> {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

/** The founding owner, a server, and a way to make staff. */
async function setup(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const owner = await login(base, "owner", "pw");
  const ownerId = (await jf(`${base}/api/me`, { headers: owner })).body.user.id as string;
  const made = await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "S", host: "127.0.0.1", port: 1, password: "x", game: "hll" }) });
  const sid = made.body.server.id as string;
  const mk = async (username: string, grants: unknown[]) => {
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
    const id = u.body.user.id as string;
    const set = await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants }) });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    return { id, auth: await login(base, username, "pw") };
  };
  const role = async (name: string, grants: unknown[]) => {
    const r = await jf(`${base}/api/roles`, { method: "POST", headers: owner, body: JSON.stringify({ name, grants }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.role.id as string;
  };
  const assign = async (userId: string, roleId: string) =>
    assert.equal((await jf(`${base}/api/users/${userId}/roles`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId, scopeId: null }] }) })).status, 200);
  // The admin of ONE server: full control there, which passes every scope-blind user-admin gate.
  const scoped = await mk("scoped", [{ capability: "*", scopeType: "server", scopeId: sid, level: "write" }]);
  return { owner, ownerId, sid, mk, role, assign, scoped };
}

/** 200 to a holder of vault.view, 404 to everyone else. */
const vaultStatus = async (base: string, auth: Auth) => (await jf(`${base}/api/plugins/vault/status`, { headers: auth })).status;
const globalStar = (level: string) => ({ capability: "*", scopeType: "global", level });
const isOwner = async (base: string, auth: Auth) =>
  ((await jf(`${base}/api/me`, { headers: auth })).body.grants as { capability: string; scopeType: string; level: string }[])
    .some((g) => g.capability === "*" && g.scopeType === "global" && g.level === "write");

test("lifting a veto confers what it held back, so it is judged like a grant", async () => {
  await withServer(async (base) => {
    const { owner, mk, role, assign, scoped } = await setup(base);

    // A role update that only REMOVES a row: the Auditor's vault.view veto.
    const auditorRole = await role("Auditor", [{ capability: "*", level: "read" }, { capability: "vault.view", level: "none" }]);
    const auditor = await mk("auditor", []);
    await assign(auditor.id, auditorRole);
    assert.equal(await vaultStatus(base, auditor.auth), 404, "the veto keeps the global-read auditor out");
    const lift = await jf(`${base}/api/roles/${auditorRole}`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [{ capability: "*", level: "read" }] }) });
    assert.equal(lift.status, 403, JSON.stringify(lift.body));
    assert.equal(await vaultStatus(base, auditor.auth), 404, "still kept out");

    // The same veto held personally: the matrix save that omits it, and the single-grant delete.
    const t = await mk("t", [globalStar("read"), { capability: "vault.view", scopeType: "global", level: "none" }]);
    assert.equal((await jf(`${base}/api/users/${t.id}/grants`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [globalStar("read")] }) })).status, 403);
    const veto = ((await jf(`${base}/api/users/${t.id}`, { headers: owner })).body.grants as { id: string; level: string }[]).find((g) => g.level === "none")!;
    assert.equal((await jf(`${base}/api/users/${t.id}/grants/${veto.id}`, { method: "DELETE", headers: scoped.auth })).status, 403);
    assert.equal(await vaultStatus(base, t.auth), 404, "the personal veto still stands");

    // The single-grant delete must name the grant's OWN user — not any account in the URL.
    const other = await mk("other", []);
    assert.equal((await jf(`${base}/api/users/${other.id}/grants/${veto.id}`, { method: "DELETE", headers: owner })).status, 404, "a grant of someone else's");
    assert.equal(await vaultStatus(base, t.auth), 404, "and it was not removed");

    // A co-owner the owner locked out with a personal "*" none beside an Owners role.
    const ownersRole = await role("Owners", [{ capability: "*", level: "write" }]);
    const co = await mk("co", [globalStar("none")]);
    await assign(co.id, ownersRole);
    assert.equal(await isOwner(base, co.auth), true, "the role row is there…");
    assert.equal((await jf(`${base}/api/plugins/vault/owner`, { headers: co.auth })).status, 404, "…but the lockout holds");
    assert.equal((await jf(`${base}/api/users/${co.id}/grants`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [] }) })).status, 403, "lifting an owner's lockout is conferring ownership");
    assert.equal((await jf(`${base}/api/plugins/vault/owner`, { headers: co.auth })).status, 404);

    // The owner holds all of it, so the same edits are theirs to make.
    assert.equal((await jf(`${base}/api/users/${t.id}/grants/${veto.id}`, { method: "DELETE", headers: owner })).status, 200);
    assert.equal(await vaultStatus(base, t.auth), 200);
    assert.equal((await jf(`${base}/api/roles/${auditorRole}`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "*", level: "read" }] }) })).status, 200);
    assert.equal(await vaultStatus(base, auditor.auth), 200);
  });
});

test("a downgrade confers nothing: whoever holds the power may lower it, but not on an account or role that outranks them", async () => {
  await withServer(async (base) => {
    const { owner, mk, role, assign, scoped } = await setup(base);
    // A user admin who holds the vault outright, short of ownership.
    const ua = await mk("ua", [{ capability: "admin.users", scopeType: "global", level: "write" }, { capability: "vault.view", scopeType: "global", level: "write" }]);
    const t = await mk("t", [{ capability: "vault.view", scopeType: "global", level: "write" }]);
    const down = await jf(`${base}/api/users/${t.id}/grants`, { method: "PUT", headers: ua.auth, body: JSON.stringify({ grants: [{ capability: "vault.view", scopeType: "global", level: "read" }] }) });
    assert.equal(down.status, 200, JSON.stringify(down.body));
    const keeper = await role("Keeper", [{ capability: "vault.view", level: "write" }]);
    assert.equal((await jf(`${base}/api/roles/${keeper}`, { method: "PUT", headers: ua.auth, body: JSON.stringify({ grants: [{ capability: "vault.view", level: "read" }] }) })).status, 200);

    // An owner's "*" lowered, or an owners' role: only by an owner — a downgrade is still a change.
    const co = await mk("co", [globalStar("write")]);
    assert.equal((await jf(`${base}/api/users/${co.id}/grants`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [globalStar("read")] }) })).status, 403);
    const ownersRole = await role("Owners", [{ capability: "*", level: "write" }]);
    const member = await mk("member", []);
    await assign(member.id, ownersRole);
    assert.equal((await jf(`${base}/api/roles/${ownersRole}`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [{ capability: "*", level: "read" }] }) })).status, 403);
    assert.equal((await jf(`${base}/api/users/${co.id}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [globalStar("read")] }) })).status, 200, "the owner may");
    assert.equal(await isOwner(base, co.auth), false);
    assert.equal((await jf(`${base}/api/roles/${ownersRole}`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "*", level: "read" }] }) })).status, 200);
  });
});

test("only a global \"*\" at write counts as an owner for the lockout guards", async () => {
  await withServer(async (base) => {
    const { owner, ownerId, mk, role, assign, scoped } = await setup(base);
    // A non-owner cannot touch the owner's account at all; the owner stripping themselves meets the guard.
    assert.equal((await jf(`${base}/api/users/${ownerId}/grants`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ grants: [] }) })).status, 403);
    const strip = () => jf(`${base}/api/users/${ownerId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [] }) });
    assert.equal((await strip()).status, 400, "the sole owner cannot be stripped");

    // A decoy: anyone with user admin may plant a "*" none on a dummy — it is a veto, not a grant.
    const decoy = await jf(`${base}/api/users`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ username: "decoy", password: "pw" }) });
    assert.equal((await jf(`${base}/api/users/${decoy.body.user.id}/grants`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ capability: "*", scopeType: "global", level: "none" }) })).status, 201);
    assert.equal((await strip()).status, 400, "a decoy \"*\" at none is not a second owner");

    // Nor is a global-read auditor, held through a role.
    const auditorRole = await role("Auditor", [{ capability: "*", level: "read" }]);
    const auditor = await mk("auditor", []);
    await assign(auditor.id, auditorRole);
    assert.equal((await strip()).status, 400, "an auditor is not a second owner");
    assert.equal((await jf(`${base}/api/users/${ownerId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "admin.users", scopeType: "global", level: "write" }] }) })).status, 400, "nor may the owner step down onto one");

    // Nor a co-owner the owner locked out: an Owners role beside a personal "*" none holds nothing.
    const ownersRole = await role("Owners", [{ capability: "*", level: "write" }]);
    const locked = await mk("locked", [globalStar("none")]);
    await assign(locked.id, ownersRole);
    assert.equal((await strip()).status, 400, "a locked-out co-owner is not a second owner");

    // The single-grant delete answers to the same guard.
    const star = ((await jf(`${base}/api/users/${ownerId}`, { headers: owner })).body.grants as { id: string; capability: string }[]).find((g) => g.capability === "*")!;
    assert.equal((await jf(`${base}/api/users/${ownerId}/grants/${star.id}`, { method: "DELETE", headers: scoped.auth })).status, 403, "not a non-owner's to touch");
    assert.equal((await jf(`${base}/api/users/${ownerId}/grants/${star.id}`, { method: "DELETE", headers: owner })).status, 400);
    // And a personal veto on the sole owner's "*" is a lockout too.
    assert.equal((await jf(`${base}/api/users/${ownerId}/grants`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ capability: "*", scopeType: "global", level: "none" }) })).status, 403);
    assert.equal((await jf(`${base}/api/users/${ownerId}/grants`, { method: "POST", headers: owner, body: JSON.stringify({ capability: "*", scopeType: "global", level: "none" }) })).status, 400);
    assert.equal(await isOwner(base, owner), true);
    assert.equal((await jf(`${base}/api/plugins/vault/owner`, { headers: owner })).status, 200, "the owner is still the owner");
  });
});

test("a role turned from \"*\" write to read stops conferring ownership, and the lockout guard knows it", async () => {
  await withServer(async (base) => {
    const { owner, ownerId, mk, role, assign } = await setup(base);
    // The owner hands ownership to a role, then steps down: the role's member is the only owner.
    const ownersRole = await role("Owners", [{ capability: "*", level: "write" }]);
    const co = await mk("co", []);
    await assign(co.id, ownersRole);
    assert.equal((await jf(`${base}/api/users/${ownerId}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ capability: "admin.users", scopeType: "global", level: "write" }] }) })).status, 200);
    // The role still carries a "*" — at read, which is no owner at all.
    const down = await jf(`${base}/api/roles/${ownersRole}`, { method: "PUT", headers: co.auth, body: JSON.stringify({ grants: [{ capability: "*", level: "read" }] }) });
    assert.equal(down.status, 400, JSON.stringify(down.body));
    assert.equal(await isOwner(base, co.auth), true);
  });
});

test("an owner's account is not a non-owner's to reset, sign out or delete", async () => {
  await withServer(async (base) => {
    const { owner, ownerId, mk, scoped } = await setup(base);
    const reset = await jf(`${base}/api/users/${ownerId}`, { method: "PATCH", headers: scoped.auth, body: JSON.stringify({ password: "mine" }) });
    assert.equal(reset.status, 403, JSON.stringify(reset.body));
    assert.equal((await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "mine" }) })).status, 401, "the hijack password does not work");
    assert.equal((await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) })).status, 200, "the owner's own still does");
    assert.equal((await jf(`${base}/api/users/${ownerId}/revoke-sessions`, { method: "POST", headers: scoped.auth })).status, 403);
    assert.equal((await jf(`${base}/api/me`, { headers: owner })).status, 200, "the owner is still signed in");

    // A second owner, who is not the setup account, is no more deletable by a non-owner.
    const second = await mk("second", [globalStar("write")]);
    assert.equal((await jf(`${base}/api/users/${second.id}`, { method: "DELETE", headers: scoped.auth })).status, 403);

    // Accounts holding no more than the actor are still theirs to help — and the owner may do all of it.
    const mod = await mk("mod", [{ capability: "server.view", scopeType: "global", level: "read" }]);
    assert.equal((await jf(`${base}/api/users/${mod.id}`, { method: "PATCH", headers: scoped.auth, body: JSON.stringify({ password: "new" }) })).status, 200);
    assert.equal((await jf(`${base}/api/users/${mod.id}/revoke-sessions`, { method: "POST", headers: scoped.auth })).status, 200);
    assert.equal((await jf(`${base}/api/users/${scoped.id}`, { method: "PATCH", headers: owner, body: JSON.stringify({ password: "new" }) })).status, 200);
    assert.equal((await jf(`${base}/api/users/${second.id}`, { method: "DELETE", headers: owner })).status, 200);
  });
});

/*
 * An account that outranks the actor is not theirs to change AT ALL — not even to take power away:
 * demoting an owner (or adding a veto to one) and then resetting the account would reach the
 * owner's sign-in in two steps where one is refused. The same goes for the setup account, whose
 * server-lifecycle keys answer to identity: even demoted by another owner, a non-owner cannot
 * reach it. And a role or a Discord mapping that hands out a power the actor lacks is not theirs
 * to edit or delete either. Ordinary accounts, roles and mappings stay theirs to manage.
 */
test("an owner, the setup account, and owner-level roles and mappings are not a non-owner's to change", async () => {
  await withServer(async (base) => {
    const { owner, ownerId, mk, role, assign, scoped } = await setup(base);
    const second = await mk("second", [globalStar("write")]);
    const put = (path: string, body: unknown, auth = scoped.auth) => jf(`${base}${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    // Another owner remains — still the second owner's grants and roles are not the user admin's.
    assert.equal((await put(`/api/users/${second.id}/grants`, { grants: [] })).status, 403, "not even to take power away");
    assert.equal((await jf(`${base}/api/users/${second.id}/grants`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ capability: "admin.users", scopeType: "global", level: "none" }) })).status, 403, "nor to add a veto");
    assert.equal((await put(`/api/users/${second.id}/roles`, { roles: [] })).status, 403);
    assert.equal((await put(`/api/users/${second.id}/discord-managed`, { managed: false })).status, 403, "nor its Discord management");

    // A role, and a Discord mapping, that hand out ownership.
    const owners = await role("Owners", [{ capability: "*", level: "write" }]);
    await assign(second.id, owners);
    assert.equal((await put(`/api/roles/${owners}`, { grants: [{ capability: "*", level: "write" }, { capability: "admin.users", level: "none" }] })).status, 403, "no veto added to the owners' role");
    assert.equal((await jf(`${base}/api/roles/${owners}`, { method: "DELETE", headers: scoped.auth })).status, 403, "nor deleting it");
    assert.equal((await put(`/api/discord/role-map/d-own`, { roles: [{ roleId: owners, scopeId: null }], discordRoleName: "Owners" }, owner)).status, 200);
    assert.equal((await put(`/api/discord/role-map/d-own`, { roles: [], discordRoleName: "Owners" })).status, 403, "no narrowing a mapping that hands out ownership");
    assert.equal((await jf(`${base}/api/discord/role-map/d-own`, { method: "DELETE", headers: scoped.auth })).status, 403, "nor removing it");

    // Ordinary accounts, roles and mappings are still the user admin's to manage.
    const plain = await mk("plain", [{ capability: "server.view", scopeType: "global", level: "read" }]);
    assert.equal((await put(`/api/users/${plain.id}/grants`, { grants: [] })).status, 200);
    const mods = await role("Mods", [{ capability: "server.view", level: "read" }]);
    assert.equal((await put(`/api/roles/${mods}`, { grants: [{ capability: "server.view", level: "write" }] })).status, 200);
    assert.equal((await put(`/api/discord/role-map/d-mod`, { roles: [{ roleId: mods, scopeId: null }], discordRoleName: "Mods" })).status, 200);
    assert.equal((await jf(`${base}/api/discord/role-map/d-mod`, { method: "DELETE", headers: scoped.auth })).status, 200);

    // The setup account, demoted by another owner, keeps its keys — and stays out of reach.
    assert.equal((await put(`/api/users/${ownerId}/grants`, { grants: [] }, second.auth)).status, 200, "an owner may demote it while another owner remains");
    assert.equal((await jf(`${base}/api/users/${ownerId}`, { method: "PATCH", headers: scoped.auth, body: JSON.stringify({ password: "mine" }) })).status, 403, "no reset");
    assert.equal((await jf(`${base}/api/users/${ownerId}/revoke-sessions`, { method: "POST", headers: scoped.auth })).status, 403, "no sign-out");
    assert.equal((await put(`/api/users/${ownerId}/grants`, { grants: [{ capability: "server.view", scopeType: "global", level: "read" }] })).status, 403, "no re-grant");
    assert.equal((await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) })).status, 200, "its own password still works");
    assert.equal((await jf(`${base}/api/users/${ownerId}`, { method: "PATCH", headers: second.auth, body: JSON.stringify({ password: "pw2" }) })).status, 200, "an owner may");
  });
});

test("merge: never the setup account, never an account holding more than the actor, in either direction", async () => {
  await withServer(async (base, repo: Repository) => {
    const { owner, ownerId, mk, scoped } = await setup(base);
    const merge = (auth: Auth, survivorId: string, duplicateId: string) =>
      jf(`${base}/api/users/${survivorId}/merge`, { method: "POST", headers: auth, body: JSON.stringify({ duplicateId }) });

    // Folding the founder into yourself took the server-delete keys and left no owner.
    assert.equal((await merge(scoped.auth, scoped.id, ownerId)).status, 400);
    assert.equal(await repo.users.firstUserId(), ownerId, "the setup account is still the founder");
    const second = await mk("second", [globalStar("write")]);
    assert.equal((await merge(second.auth, second.id, ownerId)).status, 400, "not even another owner may merge the setup account away");

    // An owner who is not the setup account: not absorbed by a non-owner, and not absorbing a dummy for one.
    assert.equal((await merge(scoped.auth, scoped.id, second.id)).status, 403);
    const dummy = await mk("dummy", []);
    assert.equal((await merge(scoped.auth, second.id, dummy.id)).status, 403, "the survivor takes the duplicate's history and Discord sign-in");
    assert.equal(await isOwner(base, second.auth), true);

    // The owner may merge an owner who is not the setup account — another owner remains.
    assert.equal((await merge(owner, dummy.id, second.id)).status, 200);
  });
});

test("merge carries a Discord-managed identity as manual when management would confer what the actor lacks", async () => {
  await withServer(async (base, repo: Repository) => {
    const { owner, mk, role, scoped } = await setup(base);
    // The owner maps a Discord role to Owners everywhere.
    const ownersRole = await role("Owners", [{ capability: "*", level: "write" }]);
    assert.equal((await jf(`${base}/api/discord/role-map/d-own`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId: ownersRole, scopeId: null }], discordRoleName: "Owner" }) })).status, 200);
    // A Discord-created twin, managed, that has not been swept yet (so holds nothing today).
    const twin = await repo.users.create({ username: "twin", discordId: "999", discordUsername: "twin", discordNick: "Twin", discordManaged: true });
    const r = await jf(`${base}/api/users/${scoped.id}/merge`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ duplicateId: twin.id }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.discordId, "999", "the identity still transfers");
    assert.equal(r.body.user.discordManaged, false, "but on manual — the next sweep must not hand the survivor the mapped Owners role");

    // For an owner the merge carries the flag as it always did.
    const plain = await mk("plain", []);
    const twin2 = await repo.users.create({ username: "twin2", discordId: "998", discordManaged: true });
    const r2 = await jf(`${base}/api/users/${plain.id}/merge`, { method: "POST", headers: owner, body: JSON.stringify({ duplicateId: twin2.id }) });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.user.discordManaged, true);
  });
});

test("a merge that fails leaves the duplicate's Discord management as it was", async () => {
  await withServer(async (base, repo: Repository) => {
    const { owner, role, scoped } = await setup(base);
    const ownersRole = await role("Owners", [{ capability: "*", level: "write" }]);
    assert.equal((await jf(`${base}/api/discord/role-map/d-own`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId: ownersRole, scopeId: null }], discordRoleName: "Owner" }) })).status, 200);
    const twin = await repo.users.create({ username: "twin", discordId: "999", discordUsername: "twin", discordNick: "Twin", discordManaged: true });
    // The merge itself fails after the route has switched the twin to manual for it.
    const realMerge = repo.users.merge;
    repo.users.merge = async () => null;
    try {
      const r = await jf(`${base}/api/users/${scoped.id}/merge`, { method: "POST", headers: scoped.auth, body: JSON.stringify({ duplicateId: twin.id }) });
      assert.equal(r.status, 500, JSON.stringify(r.body));
    } finally {
      repo.users.merge = realMerge;
    }
    assert.equal((await repo.users.findById(twin.id))?.discordManaged, true, "still managed: the switch was only for a merge that did not happen");
    assert.equal((await repo.audit.list({ actions: ["user.merge"], limit: 5 })).length, 0);
  });
});

test("switching Discord management back on is judged on what the role map can hand the account", async () => {
  await withServer(async (base, repo: Repository) => {
    const { owner, role, scoped } = await setup(base);
    const ownersRole = await role("Owners", [{ capability: "*", level: "write" }]);
    const modRole = await role("Mods", [{ capability: "server.view", level: "read" }]);
    // B was demoted by the owner: switched to manual, Owners taken off, the Discord role kept.
    const b = await repo.users.create({ username: "b", discordId: "777", discordManaged: false });
    const toggle = (auth: Auth, managed: boolean) =>
      jf(`${base}/api/users/${b.id}/discord-managed`, { method: "PUT", headers: auth, body: JSON.stringify({ managed }) });

    assert.equal((await jf(`${base}/api/discord/role-map/d-mod`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId: modRole, scopeId: null }] }) })).status, 200);
    assert.equal((await toggle(scoped.auth, true)).status, 200, "a map that confers nothing outright is anyone's to switch back on");
    assert.equal((await toggle(scoped.auth, false)).status, 200, "and off — taking control away never confers");

    assert.equal((await jf(`${base}/api/discord/role-map/d-own`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId: ownersRole, scopeId: null }] }) })).status, 200);
    const on = await toggle(scoped.auth, true);
    assert.equal(on.status, 403, JSON.stringify(on.body));
    assert.equal((await repo.users.findById(b.id))?.discordManaged, false, "still manual");
    assert.equal((await toggle(owner, true)).status, 200, "the owner may");
  });
});

test("a role map change is judged on what the mapping confers before and after", async () => {
  await withServer(async (base) => {
    const { owner, mk, role, scoped } = await setup(base);
    const auditorRole = await role("Auditor", [{ capability: "*", level: "read" }, { capability: "vault.view", level: "none" }]);
    const openAuditor = await role("Open auditor", [{ capability: "*", level: "read" }]);
    assert.equal((await jf(`${base}/api/discord/role-map/d-aud`, { method: "PUT", headers: owner, body: JSON.stringify({ roles: [{ roleId: auditorRole, scopeId: null }] }) })).status, 200);
    // Swapping the vetoed role for the open one hands the vault to every holder.
    assert.equal((await jf(`${base}/api/discord/role-map/d-aud`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ roles: [{ roleId: openAuditor, scopeId: null }] }) })).status, 403);
    // The one-server admin does not hold the global read that mapping hands out, so it is not theirs
    // to change at all. A user admin who does hold it may re-save it, or swap in a role conferring the
    // same — judged on the effective result, not on which role rows are new.
    assert.equal((await jf(`${base}/api/discord/role-map/d-aud`, { method: "PUT", headers: scoped.auth, body: JSON.stringify({ roles: [{ roleId: auditorRole, scopeId: null }], discordRoleName: "Auditors" }) })).status, 403);
    const reader = await mk("reader", [globalStar("read"), { capability: "admin.users", scopeType: "global", level: "write" }, { capability: "vault.view", scopeType: "global", level: "none" }]);
    assert.equal((await jf(`${base}/api/discord/role-map/d-aud`, { method: "PUT", headers: reader.auth, body: JSON.stringify({ roles: [{ roleId: auditorRole, scopeId: null }], discordRoleName: "Auditors" }) })).status, 200);
    const sameAuditor = await role("Auditor too", [{ capability: "*", level: "read" }, { capability: "vault.view", level: "none" }]);
    assert.equal((await jf(`${base}/api/discord/role-map/d-aud`, { method: "PUT", headers: reader.auth, body: JSON.stringify({ roles: [{ roleId: sameAuditor, scopeId: null }] }) })).status, 200);
    assert.equal((await jf(`${base}/api/discord/role-map/d-aud`, { method: "PUT", headers: reader.auth, body: JSON.stringify({ roles: [{ roleId: openAuditor, scopeId: null }] }) })).status, 403, "and they may not open the screen they are vetoed from");
  });
});

test("an archive import refuses accounts rows from anyone short of an owner, and a restore is the owner's alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "outright-import-"));
  process.env.BACKUP_DIR = dir;
  try {
    await withServer(async (base, repo: Repository) => {
      const { owner, mk, assign } = await setup(base);
      // An Administrator: admin.data at write, everything but user admin — no ownership.
      const adminRole = ((await jf(`${base}/api/roles`, { headers: owner })).body.roles as { id: string; name: string }[]).find((r) => r.name === "Administrator")!.id;
      const admin = await mk("admin", []);
      await assign(admin.id, adminRole);

      // The store's half is pinned in packages/db against Postgres; here, what the route asks of it.
      const seen: (ReadonlySet<string> | undefined)[] = [];
      (repo as { dataPort: unknown }).dataPort = {
        ...repo.dataPort,
        supported: true,
        import: async (_path: string, _onProgress?: (rows: number) => void, opts?: { refuseTables?: ReadonlySet<string> }) => {
          seen.push(opts?.refuseTables);
          return {};
        },
      };
      const runImport = async (auth: Auth) => {
        assert.equal((await fetch(`${base}/api/data/upload`, { method: "POST", headers: auth, body: "archive" })).status, 200);
        assert.equal((await jf(`${base}/api/data/import`, { method: "POST", headers: auth })).status, 202);
        for (let i = 0; i < 50 && (await jf(`${base}/api/data/status`, { headers: auth })).body.run.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
      };
      await runImport(admin.auth);
      for (const table of ["users", "api_tokens", "roles", "user_roles", "grants", "user_limits", "discord_role_map"]) {
        assert.ok(seen[0]?.has(table), `a non-owner's import refuses ${table}`);
      }
      assert.ok(!seen[0]?.has("players"), "and nothing else");
      await runImport(owner);
      assert.equal(seen[1], undefined, "an owner's import is unchanged");

      // The file is what counts, not only who presses Import: one a non-owner put in the shared
      // slot is held back the same way when an owner imports it, and so is one whose uploader is
      // unknown (a file left from before the record existed).
      const importOnly = async (auth: Auth) => {
        assert.equal((await jf(`${base}/api/data/import`, { method: "POST", headers: auth })).status, 202);
        for (let i = 0; i < 50 && (await jf(`${base}/api/data/status`, { headers: auth })).body.run.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
      };
      assert.equal((await fetch(`${base}/api/data/upload`, { method: "POST", headers: admin.auth, body: "archive" })).status, 200);
      assert.equal((await jf(`${base}/api/data/status`, { headers: owner })).body.upload.uploadedBy, "admin", "the status names who uploaded it");
      await importOnly(owner);
      assert.ok(seen[2]?.has("grants"), "a non-owner's upload is held back even when the owner imports it");
      assert.equal((await fetch(`${base}/api/data/upload`, { method: "POST", headers: owner, body: "archive" })).status, 200);
      rmSync(join(dir, "data-upload.ndjson.gz.by.json"));
      await importOnly(owner);
      assert.ok(seen[3]?.has("grants"), "and so is one whose uploader is unknown");
      seen.length = 2; // the restore checks below do not import

      const restore = await jf(`${base}/api/data/restore`, { method: "POST", headers: admin.auth, body: JSON.stringify({ file: "full-backup-20260101-000000.ndjson.gz" }) });
      assert.equal(restore.status, 403, JSON.stringify(restore.body));
      const ownerRestore = await jf(`${base}/api/data/restore`, { method: "POST", headers: owner, body: JSON.stringify({ file: "full-backup-20260101-000000.ndjson.gz" }) });
      assert.equal(ownerRestore.status, 404, "the owner passes the gate and meets the missing file");
    });
  } finally {
    delete process.env.BACKUP_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
