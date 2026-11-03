import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf } from "./harness.ts";

/*
 * "View as" on Users & roles shows the panel as someone with only that role would see it. The panel
 * names the role on every read (x-preview-role, or ?previewRole= on the live stream) and the API
 * answers as the role: the previewer's grants held down to the role's, never past what the
 * previewer may see. It used to narrow only the panel's own screens, so a role with no permissions
 * still showed the dashboard's cards, the server list and the host figures, all read as the owner.
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
  const set = await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants }) });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  return login(base, username, "pw");
}
async function role(base: string, auth: Record<string, string>, name: string, grants: unknown[]): Promise<string> {
  const r = await jf(`${base}/api/roles`, { method: "POST", headers: auth, body: JSON.stringify({ name, grants }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.role.id as string;
}
const viewing = (auth: Record<string, string>, roleId: string) => ({ ...auth, "x-preview-role": roleId });
const cards = async (base: string, headers: Record<string, string>) =>
  ((await jf(`${base}/api/layout/dashboard`, { headers })).body.widgets as { id: string }[]).map((w) => w.id);
const serverNames = async (base: string, headers: Record<string, string>) =>
  ((await jf(`${base}/api/servers`, { headers })).body.servers as { name: string }[]).map((s) => s.name).sort();

test("viewing a role with no permissions: no cards but your recent list, no servers, nothing read as you", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    await repo.servers.create({ name: "WW2", host: "10.0.0.1", port: 1, password: "x" });
    const viewOnly = await role(base, auth, "View only", []);
    const as = viewing(auth, viewOnly);

    assert.ok((await cards(base, auth)).includes("dash-team-activity"), "as yourself, every card");
    assert.deepEqual(await cards(base, as), ["dash-recent"], "as the role, only the list of what you opened");
    assert.deepEqual(await serverNames(base, auth), ["WW2"]);
    assert.deepEqual(await serverNames(base, as), [], "no server the role could open");
    for (const path of ["/api/audit", "/api/health/metrics", "/api/players/flagged"]) {
      assert.equal((await jf(`${base}${path}`, { headers: as })).status, 403, `${path} is the role's to read, and it may not`);
      assert.equal((await jf(`${base}${path}`, { headers: auth })).status, 200, `${path} as yourself`);
    }
    assert.equal((await jf(`${base}/api/updates`, { headers: as })).body.shown, false, "the setup account's own notice is not the role's");

    // Looking only: a write that arrives inside a preview is refused, and nothing is made.
    const made = await jf(`${base}/api/roles`, { method: "POST", headers: as, body: JSON.stringify({ name: "Sneaky", grants: [] }) });
    assert.equal(made.status, 403);
    assert.match(made.body.error.message as string, /previewing a role/);
    const roles = (await jf(`${base}/api/roles`, { headers: auth })).body.roles as { name: string }[];
    assert.ok(!roles.some((r) => r.name === "Sneaky"), "nothing was made");
  });
});

test("viewing never shows more than you may see: your servers only, at no more than the role's level", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const a = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.create({ name: "Bravo", host: "10.0.0.2", port: 1, password: "x" });
    const viewers = await role(base, auth, "Viewers", [{ capability: "server.view", level: "read" }]);
    // Reads every role and every server's list, but views one server only.
    const lead = await staff(base, auth, "lead", [
      { capability: "admin.users", level: "read" },
      { capability: "server.view", level: "read", scopeType: "server", scopeId: a.id },
    ]);

    assert.deepEqual(await serverNames(base, lead), ["Alpha", "Bravo"], "as themselves, the whole list (they read the roles)");
    assert.deepEqual(await serverNames(base, viewing(lead, viewers)), ["Alpha"], "as the role, only the server they could view anyway");
    assert.deepEqual(await serverNames(base, viewing(auth, viewers)), ["Alpha", "Bravo"], "an owner viewing it sees every server the role would");

    const as = viewing(auth, viewers);
    const seen = await cards(base, as);
    for (const id of ["dash-maprotation", "dash-vips-watched", "dash-servers"]) assert.ok(seen.includes(id), `${id}: the role views servers`);
    for (const id of ["dash-server-settings", "dash-team-activity", "dash-moderators", "dash-rules"]) assert.ok(!seen.includes(id), `${id}: not the role's`);
    assert.equal((await jf(`${base}/api/audit`, { headers: as })).status, 403);
  });
});

test("only someone who may read roles can view as one, and a role deleted mid-preview shows nothing", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    await repo.servers.create({ name: "WW2", host: "10.0.0.1", port: 1, password: "x" });
    const nothing = await role(base, auth, "Nothing", []);
    const mod = await staff(base, auth, "mod", [{ capability: "server.view", level: "read" }]);

    assert.deepEqual(await serverNames(base, viewing(mod, nothing)), ["WW2"], "anyone else naming a role is answered as themselves");
    assert.deepEqual(await serverNames(base, viewing(auth, "no-such-role")), [], "a role that is gone shows nothing, not everything");
    assert.equal((await jf(`${base}/api/audit`, { headers: viewing(auth, "no-such-role") })).status, 403);
  });
});

test("the live stream opened inside a preview is the role's", async () => {
  await withServer(async (base) => {
    const auth = await owner(base);
    const nothing = await role(base, auth, "Nothing", []);
    const token = auth.authorization.slice("Bearer ".length);
    const open = async (query: string) => {
      const ctl = new AbortController();
      const r = await fetch(`${base}/api/events/stream?${query}`, { signal: ctl.signal });
      ctl.abort();
      return r.status;
    };
    assert.equal(await open(new URLSearchParams({ token }).toString()), 200, "as yourself");
    assert.equal(await open(new URLSearchParams({ token, previewRole: nothing }).toString()), 403, "as a role that views no server");
  });
});

test("a preview does not see what only the setup account sees: a decommissioned server", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
    const old = await repo.servers.create({ name: "Old", host: "10.0.0.2", port: 1, password: "x" });
    await repo.servers.setDecommissioned(old.id, true);
    const readAll = await role(base, auth, "Read all", [{ capability: "*", level: "read" }]);

    assert.deepEqual(await serverNames(base, auth), ["Alpha", "Old"], "the setup account sees the server it decommissioned");
    assert.deepEqual(await serverNames(base, viewing(auth, readAll)), ["Alpha"], "nobody in a role is the setup account");
  });
});

/*
 * The dashboard's cards are offered to whoever their reads are open to: Server settings reads the
 * server's settings, VIPs & watched the watchlist, Moderators the staff profiles. Undeclared, the
 * first two went to everyone, and Moderators asked for the audit trail its read does not take. A
 * card's permission counts wherever it is held, as its read does — staff granted their servers one
 * by one were offered none of the gated cards.
 */
test("dashboard cards go to whoever their reads are open to, wherever the permission is held", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const a = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });

    assert.deepEqual(await cards(base, await staff(base, auth, "none", [])), ["dash-recent"], "no permissions: no cards to fail");
    const oneServer = await cards(base, await staff(base, auth, "one", [{ capability: "server.view", level: "read", scopeType: "server", scopeId: a.id }]));
    for (const id of ["dash-maprotation", "dash-vips-watched", "dash-servers"]) assert.ok(oneServer.includes(id), `${id} for a server granted on its own`);
    assert.ok(!oneServer.includes("dash-server-settings"), "settings are read with server settings access");
    const settings = await cards(base, await staff(base, auth, "cfg", [{ capability: "server.config", level: "read", scopeType: "server", scopeId: a.id }]));
    assert.ok(settings.includes("dash-server-settings"));
    const auditor = await cards(base, await staff(base, auth, "aud", [{ capability: "audit.trail", level: "read" }]));
    assert.ok(auditor.includes("dash-team-activity") && !auditor.includes("dash-moderators"), "the trail opens Team activity, not Moderators");
    const profiles = await cards(base, await staff(base, auth, "prof", [{ capability: "staff.profiles", level: "read" }]));
    assert.ok(profiles.includes("dash-moderators"), "Moderators is read from the staff profiles");
  });
});
