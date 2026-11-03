import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createLogger } from "@app/shared";
import { createTunnel, parseTunnelToken } from "../dist/tunnel.js";

const log = createLogger("test");
const tokenFor = (t: string) => Buffer.from(JSON.stringify({ a: "account", t, s: "secret" })).toString("base64");

/** A stand-in for cloudflared: records how it was started, exits when told, and says what /ready answers. */
function fakeCloudflared() {
  const started: { args: string[]; token: string | undefined }[] = [];
  let stopped = 0;
  let current: (EventEmitter & { stderr: PassThrough; exitCode: number | null; kill: (s?: string) => boolean }) | null = null;
  let ready = { ok: false, connections: 0 };
  const spawnImpl = ((_bin: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
    const proc = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null as number | null, kill: () => { stopped++; queueMicrotask(() => { proc.exitCode = 0; proc.emit("exit", 0); }); return true; } });
    started.push({ args, token: o.env.TUNNEL_TOKEN });
    current = proc;
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;
  const fetchImpl = (async () => new Response(JSON.stringify({ readyConnections: ready.connections }), { status: ready.ok ? 200 : 503 })) as typeof fetch;
  return {
    started, spawnImpl, fetchImpl, stopped: () => stopped,
    connect: (n = 4) => { ready = { ok: true, connections: n }; },
    disconnect: () => { ready = { ok: false, connections: 0 }; },
    say: (text: string) => { current!.stderr.write(text); },
    crash: () => { current!.exitCode = 1; current!.emit("exit", 1); },
  };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("a pasted tunnel token is found inside the command the dashboard shows, and anything else is not one", () => {
  const token = tokenFor("8b8a1f9e-tunnel");
  assert.deepEqual(parseTunnelToken(`cloudflared.exe service install ${token}`), { token, tunnelId: "8b8a1f9e-tunnel" });
  assert.deepEqual(parseTunnelToken(`cloudflared tunnel run --token ${token}`)?.token, token);
  assert.deepEqual(parseTunnelToken(` ${token} `)?.token, token);
  assert.equal(parseTunnelToken("not-a-token"), null);
  assert.equal(parseTunnelToken(Buffer.from(JSON.stringify({ a: "x" })).toString("base64")), null, "a JSON blob without the tunnel's parts");
});

test("the tunnel runs with the token in its environment, says when it is connected, and starts again when it stops", async () => {
  const fake = fakeCloudflared();
  const tunnel = createTunnel({ log, spawnImpl: fake.spawnImpl, fetchImpl: fake.fetchImpl, restartMinMs: 20, readyPollMs: 10 });
  const token = tokenFor("tunnel-1");
  tunnel.set(token);
  await settle();
  assert.equal(fake.started.length, 1);
  assert.equal(fake.started[0]!.token, token, "the token goes in cloudflared's environment");
  assert.ok(!fake.started[0]!.args.some((a) => a.includes(token)), "never on its command line, where the process list shows it");
  assert.equal(tunnel.status().state, "connecting");
  assert.equal(tunnel.status().tunnelId, "tunnel-1");

  fake.connect(4);
  await settle(40);
  assert.deepEqual({ state: tunnel.status().state, connections: tunnel.status().connections }, { state: "connected", connections: 4 });

  // Cloudflare drops it: its complaint arrives in pieces, followed by hints the panel need not repeat.
  fake.disconnect();
  fake.say("2026-10-21T00:00:00Z INF Starting tunnel\n2026-10-21T00:00:01Z ERR Register tunnel error from server side error=\"Unauth");
  fake.say("orized: Invalid tunnel secret\" event=0\n2026-10-21T00:00:01Z ERR Please try the following things to diagnose this issue: event=0\n");
  fake.say("2026-10-21T00:00:01Z ERR   1. ensure that argotunnel.com is returning \"origintunneld\" service records. event=0\n");
  await settle(5);
  fake.crash();
  assert.equal(tunnel.status().state, "failing");
  assert.equal(tunnel.status().detail, "Register tunnel error from server side error=\"Unauthorized: Invalid tunnel secret\"", "with cloudflared's own complaint, whole");
  await settle(60);
  assert.equal(fake.started.length, 2, "started again after a pause");

  tunnel.set(token);
  await settle();
  assert.equal(fake.started.length, 2, "the same token again changes nothing");
  await tunnel.stop();
});

test("another token restarts it with that one; removing the token stops it for good", async () => {
  const fake = fakeCloudflared();
  const tunnel = createTunnel({ log, spawnImpl: fake.spawnImpl, fetchImpl: fake.fetchImpl, restartMinMs: 20, readyPollMs: 10 });
  tunnel.set(tokenFor("first"));
  await settle();
  tunnel.set(tokenFor("second"));
  await settle();
  assert.deepEqual(fake.started.map((s) => s.token), [tokenFor("first"), tokenFor("second")]);
  assert.equal(fake.stopped(), 1, "the first was stopped before the second started");
  tunnel.set(null);
  await settle(80);
  assert.equal(tunnel.status().state, "off");
  assert.equal(fake.stopped(), 2, "and the second is stopped too");
  assert.equal(fake.started.length, 2, "and nothing starts it again");
});

test("without cloudflared installed, the tunnel says so instead of retrying forever", async () => {
  const spawnImpl = (() => {
    const proc = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null, kill: () => true });
    queueMicrotask(() => proc.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" })));
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;
  const tunnel = createTunnel({ log, spawnImpl, restartMinMs: 10, readyPollMs: 10 });
  tunnel.set(tokenFor("t"));
  await settle(50);
  assert.equal(tunnel.status().state, "missing");
  assert.match(String(tunnel.status().detail), /not installed/);
  await tunnel.stop();
});
