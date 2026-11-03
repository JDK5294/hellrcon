import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jsonFetch } from "./harness.ts";

async function login(base: string, username: string, password: string) {
  const r = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

async function owner(base: string): Promise<{ auth: Record<string, string>; serverId: string }> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = await login(base, "owner", "pw");
  // 127.0.0.1:1 refuses instantly, so the create-time name resolution returns at once.
  const created = await jsonFetch(`${base}/api/servers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "t", host: "127.0.0.1", port: 1, password: "x" }),
  });
  return { auth, serverId: (created.body.server as { id: string }).id };
}

test("raw console requires auth", async () => {
  await withServer(async (base) => {
    const r = await jsonFetch(`${base}/api/servers/whatever/raw`, { method: "POST", body: JSON.stringify({ command: "GetServerInformation" }) });
    assert.equal(r.status, 401);
  });
});

test("empty command is rejected before any connection", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/raw`, { method: "POST", headers: auth, body: JSON.stringify({ command: "  " }) });
    assert.equal(r.status, 400);
    assert.match(String((r.body.error as { message?: string })?.message), /command is required/);
  });
});

test("raw on an unknown server is 404", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/does-not-exist/raw`, { method: "POST", headers: auth, body: JSON.stringify({ command: "GetServerInformation" }) });
    assert.equal(r.status, 404);
  });
});

test("raw console is gated by admin.console — a plain user files a request instead", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = await login(base, "plain", "pw");
    // Not refused any more: a server-scoped write without the permission is filed for approval,
    // and a raw console command is no exception — nothing runs until somebody signs it.
    const r = await jsonFetch(`${base}/api/servers/${serverId}/raw`, { method: "POST", headers: plain, body: JSON.stringify({ command: "GetServerInformation" }) });
    assert.equal(r.status, 202);
    assert.equal((r.body as any).requested, true);
  });
});

test("live ban list requires auth", async () => {
  await withServer(async (base) => {
    const r = await jsonFetch(`${base}/api/servers/whatever/bans/live`);
    assert.equal(r.status, 401);
  });
});

test("live ban list is gated by moderation.bans — a plain user is forbidden", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain2", password: "pw" }) });
    const plain = await login(base, "plain2", "pw");
    const r = await jsonFetch(`${base}/api/servers/${serverId}/bans/live`, { headers: plain });
    assert.equal(r.status, 403);
  });
});

test("live ban list on an unknown server is 404", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/does-not-exist/bans/live`, { headers: auth });
    assert.equal(r.status, 404);
  });
});

/*
 * The capability probe. The v2 command catalogue lives on the RUNNING game server, so the route
 * reads it live — but the protocol check is decided entirely from the stored row, before any
 * dial, so a dead address must never turn "wrong protocol" into a 502.
 */
test("command probe: a legacy-text server is refused with the Commands.xml explanation, before any dial", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);
    const created = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "legacy", host: "127.0.0.1", port: 1, password: "x", protocol: "legacy-text" }),
    });
    const id = (created.body.server as { id: string }).id;
    const r = await jsonFetch(`${base}/api/servers/${id}/rcon-commands`, { headers: auth });
    assert.equal(r.status, 409);
    assert.match(String((r.body.error as { message?: string })?.message), /Commands\.xml/);
  });
});

test("command probe: an unreachable binary-v2 server is an upstream error, not a crash", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/rcon-commands`, { headers: auth });
    assert.equal(r.status, 502);
  });
});

test("command probe is gated by server.config — a plain user is forbidden", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain3", password: "pw" }) });
    const plain = await login(base, "plain3", "pw");
    const r = await jsonFetch(`${base}/api/servers/${serverId}/rcon-commands`, { headers: plain });
    assert.equal(r.status, 403);
  });
});
