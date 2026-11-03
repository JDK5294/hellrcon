import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf } from "./harness.ts";

/*
 * An API token is a second key to its maker's account, with every power they hold, and it never
 * signs out on its own. So making one takes the api.tokens permission, and so does using one:
 * an admin who takes the permission away has to reach the tokens already made, or the limit
 * limits nothing. Seeing and revoking your own takes nothing, so whoever lost it can still clear
 * away what they made.
 */

async function login(base: string, u: string, p: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}
async function owner(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return login(base, "owner", "pw");
}
/** A staff account holding the given personal grants, signed in. */
async function staff(base: string, auth: Record<string, string>, username: string, grants: unknown[]) {
  const made = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
  const id = made.body.user.id as string;
  await setGrants(base, auth, id, grants);
  return { id, auth: await login(base, username, "pw") };
}
async function setGrants(base: string, auth: Record<string, string>, id: string, grants: unknown[]) {
  const r = await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}
const TOKENS = { capability: "api.tokens", level: "write" };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("making an API token takes the permission, and without it the answer is no, not a request", async () => {
  await withServer(async (base) => {
    const auth = await owner(base);
    const mod = await staff(base, auth, "mod", [{ capability: "server.view", level: "read" }]);

    const refused = await jf(`${base}/api/tokens`, { method: "POST", headers: mod.auth, body: JSON.stringify({ name: "bot" }) });
    assert.equal(refused.status, 403, "a token's secret is shown only to whoever makes it, so it is never filed for a signature");
    assert.deepEqual(refused.body.error.missing, { capability: "api.tokens", level: "write" });
    assert.match(refused.body.error.message as string, /API tokens/);
    assert.deepEqual((await jf(`${base}/api/tokens`, { headers: mod.auth })).body.tokens, [], "nothing was made");
    assert.equal(((await jf(`${base}/api/requests`, { headers: auth })).body.queue as unknown[]).length, 0, "and nothing waits for approval");

    await setGrants(base, auth, mod.id, [{ capability: "server.view", level: "read" }, TOKENS]);
    const made = await jf(`${base}/api/tokens`, { method: "POST", headers: mod.auth, body: JSON.stringify({ name: "bot" }) });
    assert.equal(made.status, 201);
    assert.equal((await jf(`${base}/api/me`, { headers: bearer(made.body.token as string) })).status, 200, "and the token signs in");
  });
});

test("a token works only while its maker holds the permission, and they can still see and revoke it", async () => {
  await withServer(async (base) => {
    const auth = await owner(base);
    const mod = await staff(base, auth, "mod", [TOKENS]);
    const made = await jf(`${base}/api/tokens`, { method: "POST", headers: mod.auth, body: JSON.stringify({ name: "bot" }) });
    const key = bearer(made.body.token as string);
    assert.equal((await jf(`${base}/api/me`, { headers: key })).status, 200);

    // Taken away: the token stops at once. The person's own sign-in goes on working.
    await setGrants(base, auth, mod.id, []);
    assert.equal((await jf(`${base}/api/me`, { headers: key })).status, 401, "the token no longer signs anyone in");
    assert.equal((await jf(`${base}/api/me`, { headers: mod.auth })).status, 200);
    const listed = (await jf(`${base}/api/tokens`, { headers: mod.auth })).body.tokens as { id: string; name: string }[];
    assert.deepEqual(listed.map((t) => t.name), ["bot"], "it is kept, and its maker can still see it");

    // Given back: the same token works again.
    await setGrants(base, auth, mod.id, [TOKENS]);
    assert.equal((await jf(`${base}/api/me`, { headers: key })).status, 200, "nothing was deleted, so it works again");

    // Taken away again, it can still be revoked: clearing up takes no permission.
    await setGrants(base, auth, mod.id, []);
    assert.equal((await jf(`${base}/api/tokens/${listed[0]!.id}`, { method: "DELETE", headers: mod.auth })).status, 200);
    assert.deepEqual((await jf(`${base}/api/tokens`, { headers: mod.auth })).body.tokens, []);
    await setGrants(base, auth, mod.id, [TOKENS]);
    assert.equal((await jf(`${base}/api/me`, { headers: key })).status, 401, "revoked stays revoked");
  });
});

test("the permission can come from a role, and a block on the person outranks it", async () => {
  await withServer(async (base) => {
    const auth = await owner(base);
    const mod = await staff(base, auth, "mod", []);
    const role = await jf(`${base}/api/roles`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Scripters", grants: [TOKENS] }) });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const roleId = (role.body.role as { id: string }).id;
    const held = await jf(`${base}/api/users/${mod.id}/roles`, { method: "PUT", headers: auth, body: JSON.stringify({ roles: [{ roleId, scopeId: null }] }) });
    assert.equal(held.status, 200, JSON.stringify(held.body));

    const made = await jf(`${base}/api/tokens`, { method: "POST", headers: mod.auth, body: JSON.stringify({ name: "bot" }) });
    assert.equal(made.status, 201, "the role's grant is enough to make one");
    const key = bearer(made.body.token as string);
    assert.equal((await jf(`${base}/api/me`, { headers: key })).status, 200, "and to use it");

    await setGrants(base, auth, mod.id, [{ capability: "api.tokens", level: "none" }]);
    assert.equal((await jf(`${base}/api/me`, { headers: key })).status, 401, "a block on the person stops the token whatever the role says");
    assert.equal((await jf(`${base}/api/tokens`, { method: "POST", headers: mod.auth, body: JSON.stringify({ name: "two" }) })).status, 403);
  });
});
