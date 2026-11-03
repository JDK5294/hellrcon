import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { jf, ownerAuth } from "./harness.ts";

// Custom harness that keeps the repo so the test can seed events directly (the HTTP ingest route
// needs a live RCON server, which we don't have in-process).
async function withRepoServer(fn: (base: string, repo: any) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); }
}

test("events log filter: by kind category and by text query (incl chat message body)", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "log", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const t = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();

    await repo.events.insert([
      { serverId: id, ts: t(1), kind: "evt.chat.team", actorPlayerId: null, actorName: "Alice", victimPlayerId: null, victimName: null, weapon: null, data: { message: "push the point" }, dedupeKey: "a" },
      { serverId: id, ts: t(2), kind: "evt.chat.squad", actorPlayerId: null, actorName: "Bob", victimPlayerId: null, victimName: null, weapon: null, data: { message: "on me lads" }, dedupeKey: "b" },
      { serverId: id, ts: t(3), kind: "evt.kill", actorPlayerId: null, actorName: "Carol", victimPlayerId: null, victimName: "Dave", weapon: "M1 GARAND", data: null, dedupeKey: "c" },
      { serverId: id, ts: t(4), kind: "evt.match.started", actorPlayerId: null, actorName: null, victimPlayerId: null, victimName: null, weapon: null, data: null, dedupeKey: "d" },
    ]);

    // No filter → all four.
    const all = await jf(`${base}/api/servers/${id}/events`, { headers: auth });
    assert.equal(all.status, 200);
    assert.equal(all.body.events.length, 4);

    // Category filter → only chat kinds.
    const chat = await jf(`${base}/api/servers/${id}/events?kinds=evt.chat.team,evt.chat.squad`, { headers: auth });
    assert.deepEqual(chat.body.events.map((e: any) => e.kind).sort(), ["evt.chat.squad", "evt.chat.team"]);

    // Text query matches the chat message body, not just names.
    const q = await jf(`${base}/api/servers/${id}/events?q=point`, { headers: auth });
    assert.equal(q.body.events.length, 1);
    assert.equal(q.body.events[0].data.message, "push the point");

    // Query by actor name still works across kinds.
    const byName = await jf(`${base}/api/servers/${id}/events?q=carol`, { headers: auth });
    assert.equal(byName.body.events.length, 1);
    assert.equal(byName.body.events[0].kind, "evt.kill");

    // Gated by server.view; unauthenticated is 401.
    assert.equal((await jf(`${base}/api/servers/${id}/events`)).status, 401);
  });
});

test("events log filter: single player via internal id OR platform id, stacking with kinds", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "log2", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const other = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "elsewhere", host: "127.0.0.1", port: 2, password: "x" }) });
    const otherId = other.body.server.id as string;
    const alice = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000042", name: "Alice" });
    const bob = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000043", name: "Bob" });
    const t = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();

    await repo.events.insert([
      // Alice kills, Alice dies, Alice chats — plus noise from Bob and an Alice line on ANOTHER server
      { serverId: id, ts: t(1), kind: "evt.kill", actorPlayerId: alice.id, actorName: "Alice", victimPlayerId: bob.id, victimName: "Bob", weapon: "MP40", data: null, dedupeKey: "k1" },
      { serverId: id, ts: t(2), kind: "evt.kill", actorPlayerId: bob.id, actorName: "Bob", victimPlayerId: alice.id, victimName: "Alice", weapon: "M1 GARAND", data: null, dedupeKey: "k2" },
      { serverId: id, ts: t(3), kind: "evt.chat.team", actorPlayerId: alice.id, actorName: "Alice", victimPlayerId: null, victimName: null, weapon: null, data: { message: "hi" }, dedupeKey: "c1" },
      { serverId: id, ts: t(4), kind: "evt.kill", actorPlayerId: bob.id, actorName: "Bob", victimPlayerId: null, victimName: "Zed", weapon: "MP40", data: null, dedupeKey: "k3" },
      { serverId: otherId, ts: t(5), kind: "evt.kill", actorPlayerId: alice.id, actorName: "Alice", victimPlayerId: null, victimName: "Zed", weapon: "MP40", data: null, dedupeKey: "k4" },
    ]);

    // By internal uuid: Alice's three lines on THIS server only (either side of the kill).
    const byUuid = await jf(`${base}/api/servers/${id}/events?player=${alice.id}`, { headers: auth });
    assert.deepEqual(byUuid.body.events.map((e: any) => e.dedupeKey).sort(), ["c1", "k1", "k2"]);

    // By platform id (what the panel's PlayerPicker holds) — same result.
    const byPlatform = await jf(`${base}/api/servers/${id}/events?player=76561198000000042`, { headers: auth });
    assert.deepEqual(byPlatform.body.events.map((e: any) => e.dedupeKey).sort(), ["c1", "k1", "k2"]);

    // Player + kinds stack.
    const kills = await jf(`${base}/api/servers/${id}/events?player=${alice.id}&kinds=evt.kill,evt.teamkill`, { headers: auth });
    assert.deepEqual(kills.body.events.map((e: any) => e.dedupeKey).sort(), ["k1", "k2"]);

    // Unknown player → empty page, not an error.
    const nobody = await jf(`${base}/api/servers/${id}/events?player=76561190000000000`, { headers: auth });
    assert.equal(nobody.status, 200);
    assert.deepEqual(nobody.body.events, []);
  });
});

test("round events: the open match's events only, newest first, with a fallback when no round is open", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "round", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const t = (n: number) => new Date(1_700_000_000_000 + n * 60_000).toISOString();

    await repo.events.insert([
      // Last round — must not leak into "this round".
      { serverId: id, ts: t(1), kind: "evt.kill", actorPlayerId: null, actorName: "OldRound", victimPlayerId: null, victimName: "X", weapon: "K98", data: null, dedupeKey: "r0" },
      { serverId: id, ts: t(5), kind: "evt.kill", actorPlayerId: null, actorName: "ThisRound", victimPlayerId: null, victimName: "Y", weapon: "M1", data: null, dedupeKey: "r1" },
      { serverId: id, ts: t(6), kind: "evt.chat", actorPlayerId: null, actorName: "Talker", victimPlayerId: null, victimName: null, weapon: null, data: { message: "gg" }, dedupeKey: "r2" },
    ]);

    // With no open match the route still answers — recent events, and says there is no round.
    const noRound = await jf(`${base}/api/servers/${id}/round/events`, { headers: auth });
    assert.equal(noRound.status, 200);
    assert.equal(noRound.body.round, null, "no round on record is stated, not implied");
    assert.ok((noRound.body.events as any[]).length >= 3, "falls back to recent events rather than nothing");

    // Open a round between the two groups: only what happened after its start belongs to it.
    await repo.matches.open({ serverId: id, map: "Foy", startedAt: t(4) });
    const r = await jf(`${base}/api/servers/${id}/round/events`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.body.round.map, "Foy");
    assert.equal(r.body.round.startedAt, t(4));
    const names = (r.body.events as any[]).map((e) => e.actorName);
    assert.deepEqual(names, ["Talker", "ThisRound"], "this round's events, newest first");
    assert.ok(!names.includes("OldRound"), "the previous round stays out of it");

    // Kind filtering rides along, so the feed's category chips can narrow the backfill too.
    const kills = await jf(`${base}/api/servers/${id}/round/events?kinds=evt.kill`, { headers: auth });
    assert.deepEqual((kills.body.events as any[]).map((e) => e.actorName), ["ThisRound"]);

    // Gated like every other server read.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plainr", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plainr", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await jf(`${base}/api/servers/${id}/round/events`, { headers: plain })).status, 403);
  });
});
