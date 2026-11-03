import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext, type AppContext } from "../dist/app.js";

/** Like the main harness, but hands the test the AppContext too (so it can emit on the bus). */
async function withServer(fn: (base: string, ctx: AppContext) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, ctx);
  } finally {
    server.close();
  }
}

/** Create a server and return its id. Grants are validated against the servers table, so a test
 *  that scopes a grant has to scope it to something real. */
async function makeServer(base: string, owner: string, name: string): Promise<string> {
  const res = await fetch(`${base}/api/servers`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
    body: JSON.stringify({ name, host: "127.0.0.1", port: 9001, password: "pw", game: "hll", protocol: "binary-v2", engagementMode: "observe" }),
  });
  const text = await res.text(); // read once — an assertion message that calls .text() burns the body
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as { server: { id: string } }).server.id;
}

async function ownerToken(base: string): Promise<string> {
  await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "pw" }) });
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "pw" }) });
  return ((await res.json()) as { token: string }).token;
}

/** Open an SSE stream and resolve once a `data:` line arrives (parsed) — or reject on timeout. */
async function firstEvent(url: string, trigger: () => void, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let triggered = false;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before an event arrived");
      buffer += decoder.decode(value, { stream: true });
      // Once the handshake comment is through, the bus subscription is live — fire the trigger.
      if (!triggered && buffer.includes(": connected")) {
        triggered = true;
        trigger();
      }
      const line = buffer.split("\n").find((l) => l.startsWith("data:"));
      if (line) return JSON.parse(line.slice("data:".length).trim());
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

test("SSE stream requires a valid token", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/events/stream`);
    assert.equal(res.status, 401);
    await res.body?.cancel();
    const bad = await fetch(`${base}/api/events/stream?token=nope`);
    assert.equal(bad.status, 401);
    await bad.body?.cancel();
  });
});

test("SSE stream delivers an event emitted on the bus", async () => {
  await withServer(async (base, ctx) => {
    const token = await ownerToken(base);
    const evt = await firstEvent(`${base}/api/events/stream?token=${token}`, () => {
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: "srv-1", actorName: "Peter", victimName: "Robo", weapon: "BAR" });
    });
    assert.equal(evt.kind, "evt.kill");
    assert.equal(evt.actorName, "Peter");
  });
});

test("scoped stream (?serverId=) ignores events from other servers", async () => {
  await withServer(async (base, ctx) => {
    const token = await ownerToken(base);
    const evt = await firstEvent(`${base}/api/events/stream?token=${token}&serverId=srv-1`, () => {
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: "srv-OTHER", actorName: "Nobody" }); // filtered out
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: "srv-1", actorName: "Wanted" }); // delivered
    });
    assert.equal(evt.serverId, "srv-1");
    assert.equal(evt.actorName, "Wanted");
  });
});

/**
 * The unscoped stream used to authorize ONCE, with no scope, and then filter on the query
 * parameter. Both halves were wrong: a per-server `none` is invisible to a scopeless check, so a
 * vetoed server's events flowed anyway; and a moderator holding only a per-server grant could not
 * open the stream at all. It now authorizes each event against the grants.
 */
async function tokenFor(base: string, owner: string, username: string, grants: Record<string, unknown>[]): Promise<string> {
  const h = { "content-type": "application/json", authorization: `Bearer ${owner}` };
  const made = await fetch(`${base}/api/users`, { method: "POST", headers: h, body: JSON.stringify({ username, password: "pw" }) });
  const { user } = (await made.json()) as { user: { id: string } };
  const put = await fetch(`${base}/api/users/${user.id}/grants`, { method: "PUT", headers: h, body: JSON.stringify({ grants }) });
  assert.equal(put.status, 200, await put.text());
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "pw" }) });
  return ((await login.json()) as { token: string }).token;
}

test("unscoped stream honours a per-server 'none' veto", async () => {
  await withServer(async (base, ctx) => {
    const owner = await ownerToken(base);
    const secret = await makeServer(base, owner, "Secret");
    const open = await makeServer(base, owner, "Open");
    // Global read, vetoed on the secret server. The veto is server-scoped, so the old scopeless
    // entry check never saw it.
    const token = await tokenFor(base, owner, "watcher", [
      { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
      { capability: "server.view", scopeType: "server", scopeId: secret, level: "none" },
    ]);
    const evt = await firstEvent(`${base}/api/events/stream?token=${token}`, () => {
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: secret, actorName: "Hidden" }); // vetoed
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: open, actorName: "Wanted" });   // allowed
    });
    // The vetoed event was emitted FIRST, so if it were delivered it would be the one we read.
    assert.equal(evt.serverId, open);
    assert.equal(evt.actorName, "Wanted");
  });
});

test("a server-scoped moderator can open the unscoped stream, and sees only their server", async () => {
  await withServer(async (base, ctx) => {
    const owner = await ownerToken(base);
    const mine = await makeServer(base, owner, "Mine");
    const theirs = await makeServer(base, owner, "Theirs");
    const token = await tokenFor(base, owner, "scopedmod", [
      { capability: "server.view", scopeType: "server", scopeId: mine, level: "read" },
    ]);
    const evt = await firstEvent(`${base}/api/events/stream?token=${token}`, () => {
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: theirs, actorName: "Nobody" });
      ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: mine, actorName: "Wanted" });
    });
    assert.equal(evt.serverId, mine);
    assert.equal(evt.actorName, "Wanted");
  });
});

/**
 * The connection's two exits, which both have to release the bus subscription and the heartbeat.
 *
 * A leaked subscription is invisible in any single test run — it is a handler that keeps firing
 * into a dead response, a 25-second re-auth loop per departed viewer, and memory that only moves
 * on a graph. So these tests observe the release DIRECTLY: the bus's `on` is wrapped before the
 * stream connects, and the flag flips only when the route lets go.
 */
function watchUnsubscribe(ctx: AppContext): { released: () => boolean } {
  const origOn = ctx.bus.on.bind(ctx.bus);
  let released = false;
  (ctx.bus as { on: typeof ctx.bus.on }).on = (kind, handler) => {
    const un = origOn(kind, handler);
    return () => { released = true; un(); };
  };
  return { released: () => released };
}

const waitFor = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

test("a client that disconnects releases the bus subscription promptly", async () => {
  await withServer(async (base, ctx) => {
    const token = await ownerToken(base);
    await makeServer(base, token, "SSE leave");
    const watch = watchUnsubscribe(ctx);

    // Connect, wait for the handshake, then hang up the way a closed tab does.
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events/stream?token=${token}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.ok(new TextDecoder().decode(first.value).includes(": connected"));
    ac.abort();

    /*
     * The route must notice WITHOUT traffic: no event is emitted here on purpose. On current
     * Node the request's own 'close' fires here too, so this is a regression net rather than a
     * repro — its job is to fail if a Node upgrade shifts those semantics again and a quiet
     * disconnect goes back to being discovered only when a later write fails (the 25-second
     * heartbeat at best; on a stream with nothing to say, never).
     */
    assert.ok(await waitFor(watch.released), "the subscription must be released by the disconnect itself, not by a failing write");
  });
});

test("a connected client that stops reading is cut off at the buffer cap, not fed forever", async () => {
  await withServer(async (base, ctx) => {
    const token = await ownerToken(base);
    const sid = await makeServer(base, token, "SSE stall");
    const watch = watchUnsubscribe(ctx);

    // Connect and read ONLY the handshake — then stop, like a suspended tab. The socket stays
    // open, so nothing errors; every write from here buffers somewhere on our behalf.
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events/stream?token=${token}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await reader.read();

    try {
      // A busy kill feed, oversized: enough bytes to blow past the kernel's socket buffer and
      // then the 1MB cap. If the cap is gone, this test's failure mode is the leak itself —
      // waitFor times out because the server buffers all of it happily.
      const big = "x".repeat(64 * 1024);
      for (let i = 0; i < 200 && !watch.released(); i++) {
        ctx.bus.emit("evt.kill", { kind: "evt.kill", serverId: sid, filler: big });
        if (i % 20 === 19) await new Promise((r) => setTimeout(r, 10)); // let writes settle into buffers
      }
      assert.ok(await waitFor(watch.released), "past the cap the connection must be ended and released");
    } finally {
      ac.abort();
    }
  });
});
