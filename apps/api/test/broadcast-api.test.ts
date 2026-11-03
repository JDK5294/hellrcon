import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "bcast", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("broadcast config GET returns defaults then round-trips a PUT", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    const initial = await jf(`${base}/api/servers/${id}/broadcast`, { headers: auth });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.config.enabled, false);
    assert.equal(initial.body.config.dryRun, true);
    assert.deepEqual(initial.body.config.messages, []);

    const put = await jf(`${base}/api/servers/${id}/broadcast`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, dryRun: false, intervalSec: 600, randomize: true, messages: ["  hello  ", "world", "   "],
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.enabled, true);
    assert.equal(put.body.config.intervalSec, 600);
    assert.equal(put.body.config.randomize, true);
    // blank message dropped, others trimmed
    assert.deepEqual(put.body.config.messages, ["hello", "world"]);

    const after = await jf(`${base}/api/servers/${id}/broadcast`, { headers: auth });
    assert.equal(after.body.configured, true);
    assert.deepEqual(after.body.config.messages, ["hello", "world"]);

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "broadcast.config"));
  });
});

test("broadcast config PUT validation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/broadcast`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    assert.equal((await put({ intervalSec: 10 })).status, 400); // below 30s floor
    assert.equal((await put({ intervalSec: 999999 })).status, 400); // above 24h
    assert.equal((await put({ messages: "not-an-array" })).status, 400);
    assert.equal((await put({ messages: ["x".repeat(1001)] })).status, 400); // too long
    assert.equal((await jf(`${base}/api/servers/does-not-exist/broadcast`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) })).status, 404);
  });
});

test("broadcast send-now validates message + records audit; config gated by server.config, send by action.message", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // empty message rejected before any connection attempt
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "   " }) })).status, 400);
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "x".repeat(1001) }) })).status, 400);

    // a plain user lacks both server.config and action.message
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast`, { headers: plain })).status, 403);
    // A server-scoped WRITE without the permission is filed for approval now (202), not
    // refused — the read half beside it still is. See docs/approvals.md.
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast`, { method: "PUT", headers: plain, body: JSON.stringify({ enabled: true }) })).status, 202);
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast/send`, { method: "POST", headers: plain, body: JSON.stringify({ message: "hi" }) })).status, 202);
    // unauthenticated
    assert.equal((await jf(`${base}/api/servers/${id}/broadcast`)).status, 401);
  });
});

/**
 * Messaging everyone is a DIFFERENT surface from broadcasting, and the endpoint has to hold that
 * line: the broadcast is the scrolling line across the top left, this is the message that waits in
 * the top right to be acknowledged. Same validation and the same capability (`action.message`
 * write, since it is the per-player message command underneath), but a separate path — and one
 * that reports how many players it actually reached rather than a bare ok, because "sent" while
 * half the server saw nothing is the failure this screen exists to surface.
 */
test("message-all validates, gates on action.message, and is a separate path from broadcast", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Rejected before any connection is attempted, exactly like the broadcast next door.
    assert.equal((await jf(`${base}/api/servers/${id}/message/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "   " }) })).status, 400);
    assert.equal((await jf(`${base}/api/servers/${id}/message/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "x".repeat(1001) }) })).status, 400);
    assert.equal((await jf(`${base}/api/servers/does-not-exist/message/send`, { method: "POST", headers: auth, body: JSON.stringify({ message: "hi" }) })).status, 404);

    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "nomsg", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "nomsg", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    // A server-scoped WRITE without the permission is filed for approval now (202), not
    // refused — the read half beside it still is. See docs/approvals.md.
    assert.equal((await jf(`${base}/api/servers/${id}/message/send`, { method: "POST", headers: plain, body: JSON.stringify({ message: "hi" }) })).status, 202);
    assert.equal((await jf(`${base}/api/servers/${id}/message/send`, { method: "POST", body: JSON.stringify({ message: "hi" }) })).status, 401);
  });
});

test("observe mode answers both send routes as a 409 conflict, not an upstream failure", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth); // servers are born in observe mode
    for (const path of ["broadcast/send", "message/send"]) {
      const r = await jf(`${base}/api/servers/${id}/${path}`, { method: "POST", headers: auth, body: JSON.stringify({ message: "hello" }) });
      // Observe is OUR refusal — "server is read-only", something staff can act on — where a 502
      // used to send them hunting a connection problem that wasn't there.
      assert.equal(r.status, 409, path);
      assert.match(JSON.stringify(r.body), /observe mode/, path);
    }
  });
});
