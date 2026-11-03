/**
 * The Live page answers from the worker's latest reads of the server (@app/shared live-share) while
 * they are fresh, and only reads the game itself when they are not: one watching staff member used
 * to cost the game a new connection and login on every refresh, for reads the worker had just made.
 *
 * And it no longer saves everyone it shows. Players already on record are the worker's roster
 * sample's to keep current once a minute; saving the whole roster on every refresh of every viewer
 * was most of the database's writes during a round, and counted each refresh as another sighting
 * of every name. Someone the store has never seen is still added, so every row links to a profile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_SHARE_FRESH_MS, liveShareKey, type LiveSharedKind } from "@app/shared";
import { fakeGameServer } from "./fake-hll-server.ts";
import { withServer, jf, ownerAuth } from "./harness.ts";

type Ctx = Parameters<Parameters<typeof withServer>[0]>[2];

/** Leave reads for the API as the worker does, taken `ageMs` ago. */
function share(ctx: Ctx, serverId: string, reads: Record<LiveSharedKind, unknown>, ageMs: Partial<Record<LiveSharedKind, number>> = {}) {
  for (const [kind, value] of Object.entries(reads) as [LiveSharedKind, unknown][]) {
    ctx.bus.remember(liveShareKey(serverId, kind), { at: Date.now() - (ageMs[kind] ?? 0), value }, 120);
  }
}

/** A Steam id no other suite uses. */
const steamId = () => `7656119${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;

/** A server row pointing at a port nothing listens on: any read of the game itself fails. */
async function unreachableServer(base: string, auth: Record<string, string>, name: string): Promise<string> {
  const r = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.server.id as string;
}

test("live: the worker's fresh reads are the answer, with no connection to the game of its own", async () => {
  await withServer(async (base, _repo, ctx) => {
    const auth = await ownerAuth(base);
    const serverId = await unreachableServer(base, auth, "shared-fresh");
    const id = steamId();
    share(ctx, serverId, {
      session: { serverName: "Shared", playerCount: 1 },
      players: { players: [{ iD: id, name: "FromWorker", platform: "steam", team: 1 }] },
      maprotation: { maps: ["foy_warfare"], current_index: 0 },
    });
    const live = await jf(`${base}/api/servers/${serverId}/live`, { headers: auth });
    assert.equal(live.status, 200, "answered although the game cannot be reached");
    assert.deepEqual((live.body.players as { name: string }[]).map((p) => p.name), ["FromWorker"]);
    assert.ok((live.body.players as { playerDbId: string | null }[])[0]!.playerDbId, "enriched like a read of the game");
    assert.deepEqual(live.body.mapRotation, { maps: ["foy_warfare"], current_index: 0 });
    assert.equal(live.body.session.playerCount, 1);
  });
});

test("live: reads that are not all fresh are not used, and the page reads the game itself", async () => {
  await withServer(async (base, _repo, ctx) => {
    const auth = await ownerAuth(base);
    const reads = { session: {}, players: { players: [] }, maprotation: null };
    // One stale read is enough: a fresh roster beside an old score is a page that never existed.
    const stale = await unreachableServer(base, auth, "shared-stale");
    share(ctx, stale, reads, { session: LIVE_SHARE_FRESH_MS.session + 2000 });
    assert.equal((await jf(`${base}/api/servers/${stale}/live`, { headers: auth })).status, 502, "went to the game, which is not there");
    // One missing read is the same.
    const partial = await unreachableServer(base, auth, "shared-partial");
    share(ctx, partial, { ...reads });
    ctx.bus.remember(liveShareKey(partial, "maprotation"), null, 120);
    assert.equal((await jf(`${base}/api/servers/${partial}/live`, { headers: auth })).status, 502);

    // And a game that is there answers, through the same page.
    const token = auth.authorization.replace(/^Bearer /, "");
    const { fake, serverId } = await fakeGameServer(base, token, "shared-fallback");
    try {
      fake.players = [{ iD: steamId(), name: "FromGame", platform: "steam" }];
      share(ctx, serverId, { session: {}, players: { players: [{ iD: steamId(), name: "Old", platform: "steam" }] }, maprotation: null }, { players: LIVE_SHARE_FRESH_MS.players + 2000 });
      const live = await jf(`${base}/api/servers/${serverId}/live`, { headers: auth });
      assert.equal(live.status, 200);
      assert.deepEqual((live.body.players as { name: string }[]).map((p) => p.name), ["FromGame"]);
    } finally { fake.close(); }
  });
});

test("live: after a change made through the API, reads the worker took before it are not shown", async () => {
  await withServer(async (base, _repo, ctx) => {
    const auth = await ownerAuth(base);
    const token = auth.authorization.replace(/^Bearer /, "");
    const { fake, serverId } = await fakeGameServer(base, token, "shared-after-kick");
    try {
      const stays = steamId();
      const kicked = steamId();
      // The worker's last roster still has the player about to be kicked.
      share(ctx, serverId, {
        session: {},
        players: { players: [{ iD: stays, name: "Stays", platform: "steam" }, { iD: kicked, name: "Kicked", platform: "steam" }] },
        maprotation: null,
      });
      // A read through the API changes nothing, and the shared reads still answer.
      assert.equal((await jf(`${base}/api/servers/${serverId}/admins`, { headers: auth })).status, 200);
      assert.ok(fake.received.includes("GetAdminGroups"));
      assert.deepEqual(((await jf(`${base}/api/servers/${serverId}/live`, { headers: auth })).body.players as { name: string }[]).map((p) => p.name), ["Stays", "Kicked"]);
      // Past the 4-second cache, so the next refresh is a new read.
      await new Promise((r) => setTimeout(r, 4100));
      fake.players = [{ iD: stays, name: "Stays", platform: "steam" }];
      const kick = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: auth, body: JSON.stringify({ action: "kick", playerId: kicked }) });
      assert.equal(kick.status, 200, JSON.stringify(kick.body));
      const live = await jf(`${base}/api/servers/${serverId}/live`, { headers: auth });
      assert.equal(live.status, 200);
      assert.deepEqual((live.body.players as { name: string }[]).map((p) => p.name), ["Stays"], "the reload after the kick shows it");
    } finally { fake.close(); }
  });
});

test("live: players already on record are not saved again; someone new is added and linked", async () => {
  await withServer(async (base, repo, ctx) => {
    const auth = await ownerAuth(base);
    const serverId = await unreachableServer(base, auth, "shared-known");
    const knownId = steamId();
    const newId = steamId();
    const longAgo = "2021-03-04T05:06:07.000Z";
    const [known] = await repo.players.upsertMany([{ game: "hll", platform: "steam", platformId: knownId, name: "Known", clanTag: "LYNX", level: 50, ts: longAgo }]);
    const aliasesBefore = await repo.playerAliases.list(known!.id);
    // Identity links (another id the same roster entry names) are written for the newcomer only.
    const linked: string[] = [];
    const setLink = repo.externalLinks.set.bind(repo.externalLinks);
    repo.externalLinks.set = async (playerId, provider, externalId) => { linked.push(playerId); return setLink(playerId, provider, externalId); };
    share(ctx, serverId, {
      session: {},
      players: { players: [
        { iD: knownId, name: "Known", clanTag: "LYNX", level: 51, platform: "steam", eosId: `eos-${knownId}` },
        { iD: newId, name: "Newcomer", level: 3, platform: "steam", eosId: `eos-${newId}` },
      ] },
      maprotation: null,
    });
    const live = await jf(`${base}/api/servers/${serverId}/live`, { headers: auth });
    assert.equal(live.status, 200);
    const rows = live.body.players as { name: string; playerDbId: string | null }[];
    assert.equal(rows.find((p) => p.name === "Known")!.playerDbId, known!.id, "the known player still links to their profile");

    const after = await repo.players.findById(known!.id);
    assert.equal(after!.lastSeen, known!.lastSeen, "not saved again: the worker's roster sample keeps them current");
    assert.equal(after!.level, 50);
    assert.deepEqual(await repo.playerAliases.list(known!.id), aliasesBefore, "a refresh is not another sighting of their names");

    const added = await repo.players.findByPlatformId(newId);
    assert.ok(added, "someone the store has never seen is added");
    assert.equal(added!.name, "Newcomer");
    assert.equal(added!.level, 3);
    assert.equal(rows.find((p) => p.name === "Newcomer")!.playerDbId, added!.id, "and links to their new profile");
    assert.deepEqual(linked, [added!.id]);
    assert.deepEqual((await repo.externalLinks.list(added!.id)).map((l) => [l.provider, l.externalId]), [["eos", `eos-${newId}`]]);
  });
});
