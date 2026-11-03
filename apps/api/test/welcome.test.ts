/**
 * The live welcome message's settings: off by default, bounded, gated like the broadcast config,
 * and — while it is on — the only thing that writes the game's welcome text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const r = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "S", host: "127.0.0.1", port: 1, password: "x" }) });
  return r.body.server.id as string;
}

test("live welcome: off by default; saved, bounded, and audited", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const first = await jf(`${base}/api/servers/${id}/welcome`, { headers: auth });
    assert.equal(first.status, 200);
    assert.equal(first.body.config.enabled, false, "never on until someone switches it on");
    assert.equal(first.body.configured, false);

    const empty = await jf(`${base}/api/servers/${id}/welcome`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) });
    assert.equal(empty.status, 400, "switching on with no text is refused");
    for (const intervalSec of [30, 99_999]) {
      const bad = await jf(`${base}/api/servers/${id}/welcome`, { method: "PUT", headers: auth, body: JSON.stringify({ intervalSec }) });
      assert.equal(bad.status, 400, `interval ${intervalSec}s is out of bounds`);
    }
    const saved = await jf(`${base}/api/servers/${id}/welcome`, {
      method: "PUT", headers: auth, body: JSON.stringify({ enabled: true, template: "Welcome to {server_name}! Next: {next_map}", intervalSec: 600 }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.enabled, true);
    assert.equal(saved.body.config.intervalSec, 600);
    assert.equal(saved.body.config.lastText, null, "nothing written yet — the worker does that");
    const trail = await jf(`${base}/api/audit?actions=welcome.config`, { headers: auth });
    assert.equal((trail.body.entries as unknown[]).length, 1);
  });
});

test("while it is on, the Server settings welcome box refuses — it would be overwritten or stuck", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/servers/${id}/welcome`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true, template: "Hi from {server_name}" }) });
    const manual = await jf(`${base}/api/servers/${id}/config`, { method: "POST", headers: auth, body: JSON.stringify({ welcomeMessage: "static text" }) });
    assert.equal(manual.status, 409);
    assert.match(JSON.stringify(manual.body), /live welcome message is on/);
  });
});

test("re-wording or switching it on forgets the last write, so the next pass always writes", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/servers/${id}/welcome`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true, template: "A" }) });
    await repo.welcome.markWritten(id, "A", new Date().toISOString());
    await jf(`${base}/api/servers/${id}/welcome`, { method: "PUT", headers: auth, body: JSON.stringify({ intervalSec: 120 }) });
    assert.equal((await repo.welcome.getConfig(id))!.lastText, "A", "a timing change alone keeps it");
    await jf(`${base}/api/servers/${id}/welcome`, { method: "PUT", headers: auth, body: JSON.stringify({ template: "B" }) });
    assert.equal((await repo.welcome.getConfig(id))!.lastText, null, "a new text is written next pass");
  });
});

test("the welcome settings need the broadcast config permission to change", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "viewer", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: [{ scopeType: "global", scopeId: null, capability: "broadcast.config", level: "read" }] }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "viewer", password: "pw" }) });
    const viewer = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await jf(`${base}/api/servers/${id}/welcome`, { headers: viewer })).status, 200);
    // Without write, the change is not applied — it is filed for someone who may approve it.
    const asked = await jf(`${base}/api/servers/${id}/welcome`, { method: "PUT", headers: viewer, body: JSON.stringify({ template: "sneaky" }) });
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    assert.equal((await repo.welcome.getConfig(id)), null, "nothing changed");
  });
});

test("whole-server texts refuse player placeholders — every player would read the raw braces", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (path: string, body: unknown) => jf(`${base}/api/servers/${id}/${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    const welcome = await put("welcome", { enabled: true, template: "Welcome {player_name}! VIP until {vip_until}" });
    assert.equal(welcome.status, 400);
    assert.match(welcome.body.error.message, /\{player_name\}, \{vip_until\} can't work in the welcome message/);
    assert.equal((await put("welcome", { template: "Draft {player_name}" })).status, 200, "a draft that stays off may be saved");
    assert.equal((await put("welcome", { enabled: true })).status, 400, "…but not switched on as written");
    assert.equal((await put("welcome", { enabled: false })).status, 200, "switching off is never refused");
    assert.equal((await put("welcome", { enabled: true, template: "Welcome to {server_name}, next up {next_map}" })).status, 200);

    const rotation = await put("broadcast", { enabled: true, messages: ["Join our Discord!", "Your VIP: {vip_remaining}"] });
    assert.equal(rotation.status, 400);
    assert.match(rotation.body.error.message, /\{vip_remaining\} can't work in a broadcast/);
    assert.equal((await put("broadcast", { enabled: true, messages: ["{vip_until:WW2}"] })).status, 400, "a server-qualified VIP is still one player's");
    assert.equal((await put("broadcast", { enabled: true, messages: ["Now playing {map_name} on {server_name}"] })).status, 200);

    const now = await jf(`${base}/api/servers/${id}/broadcast/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "gg {player_name}" }) });
    assert.equal(now.status, 400);

    const cam = await put("admincam/config", { notifyEnabled: true, enterMessage: "{player} is watching, {player_name}" });
    assert.equal(cam.status, 400);
    assert.equal((await put("admincam/config", { notifyEnabled: true, enterMessage: "{player} is watching on {server_name}" })).status, 200, "{player} is the admin — fine");
  });
});
