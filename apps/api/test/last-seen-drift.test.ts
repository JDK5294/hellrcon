/*
 * "Last seen" is the one clock the store only ever winds FORWARD, which makes a wrong value
 * permanent: whatever bumped it (an import that treated processing a record as a sighting) is
 * gone, but the damage stays, and no later correct write can undo it. These tests cover the way
 * out — a report that names the affected players with the evidence that contradicts their clock,
 * and a repair that lowers them onto it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jsonFetch, askedFor } from "./harness.ts";

async function ownerAuth(base: string) {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const l = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

test("the drift report names the bumped players and says what the evidence is", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });

    // A veteran whose real trace ends with a 2025 session, then bumped to "now" by an import.
    const ghost = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "111", name: "Vet", ts: "2025-05-20T08:00:00.000Z" });
    await repo.sessions.importOne({ playerId: ghost.id, serverId: srv.id, connectedAt: "2025-05-20T08:00:00.000Z", disconnectedAt: "2025-05-20T09:00:00.000Z", durationSec: 3600 });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "111", name: "Vet" }); // the bogus sighting

    // A player with NO session and NO event: their first_seen is all the evidence there is.
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "222", name: "Paper", ts: "2024-01-01T00:00:00.000Z" });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "222", name: "Paper" }); // bumped too

    // A genuinely live player: an event vouches for their clock, so they are NOT drifted.
    const live = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "333", name: "Live", ts: "2026-08-05T11:00:00.000Z" });
    await repo.events.insert([{ serverId: srv.id, ts: "2026-08-05T11:00:00.000Z", kind: "evt.kill", actorPlayerId: live.id, dedupeKey: "live-1" }]);

    const r = await jsonFetch(`${base}/api/players/last-seen-drift`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 2, "both bumped players, and only those");
    const byName = new Map((r.body.sample as any[]).map((x) => [x.name, x]));
    assert.equal(byName.get("Vet").best, "2025-05-20T09:00:00.000Z", "the veteran's evidence is their last session");
    assert.equal(byName.get("Vet").lastSessionEnd, "2025-05-20T09:00:00.000Z");
    assert.equal(byName.get("Paper").best, "2024-01-01T00:00:00.000Z", "with nothing else, first seen is the evidence");
    assert.equal(byName.get("Paper").lastSessionEnd, null);
    assert.equal(byName.get("Paper").lastEvent, null);
    assert.ok(!byName.has("Live"), "a player with a real event is not drifted");
  });
});

test("the repair lowers them, is idempotent, and is written to the audit trail", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "s", host: "127.0.0.1", port: 1, password: "x" });
    const ghost = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "111", name: "Vet", ts: "2025-05-20T08:00:00.000Z" });
    await repo.sessions.importOne({ playerId: ghost.id, serverId: srv.id, connectedAt: "2025-05-20T08:00:00.000Z", disconnectedAt: "2025-05-20T09:00:00.000Z", durationSec: 3600 });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "111", name: "Vet" });

    const first = await jsonFetch(`${base}/api/players/last-seen-drift/repair`, { method: "POST", headers: auth });
    assert.equal(first.status, 200);
    assert.equal(first.body.repaired, 1);
    assert.equal((await repo.players.findByPlatformId("111"))?.lastSeen, "2025-05-20T09:00:00.000Z");

    // Running it again is a no-op — the whole point of "lower onto the evidence, never off it".
    const second = await jsonFetch(`${base}/api/players/last-seen-drift/repair`, { method: "POST", headers: auth });
    assert.equal(second.body.repaired, 0);
    assert.equal((await jsonFetch(`${base}/api/players/last-seen-drift`, { headers: auth })).body.total, 0);

    // A data repair is an admin action: it leaves a trail naming who ran it.
    const trail = await repo.audit.list({ limit: 50 });
    assert.ok(trail.some((a) => a.action === "admin.last_seen_repair" && a.actorName === "owner"));
  });
});

test("both halves need the trim capability, and reading needs no more than read", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jsonFetch(`${base}/api/players/last-seen-drift`, { headers: plain })).status, 403);
    // The repair is asked of someone holding the trim key, and nothing is repaired on the asking.
    const asked = await jsonFetch(`${base}/api/players/last-seen-drift/repair`, { method: "POST", headers: plain });
    assert.deepEqual(await askedFor(base, auth, asked), { capability: "admin.trim", serverId: null });
    assert.ok(!(await repo.audit.list({ limit: 50 })).some((a) => a.action === "admin.last_seen_repair"));
    assert.equal((await jsonFetch(`${base}/api/players/last-seen-drift`)).status, 401);
  });
});
