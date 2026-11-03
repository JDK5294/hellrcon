import { test } from "node:test";
import assert from "node:assert/strict";
import { liveShareKey, type LiveSharedKind } from "@app/shared";
import { withServer, jf, ownerAuth } from "./harness.ts";

/*
 * Why a player is watched, and by whom, is the watchlist permission's: "see who is watched and
 * why". The profile kept the reason from anyone without it, but the Live roster's 👁 and the
 * watched list served the same words to anyone who can see a server, the Viewer role among them;
 * and the profile still sent who last changed the watch, and when — who set it.
 */
type Ctx = Parameters<Parameters<typeof withServer>[0]>[2];

function share(ctx: Ctx, serverId: string, reads: Record<LiveSharedKind, unknown>) {
  for (const [kind, value] of Object.entries(reads) as [LiveSharedKind, unknown][]) {
    ctx.bus.remember(liveShareKey(serverId, kind), { at: Date.now(), value }, 120);
  }
}

async function account(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string }[]) {
  const made = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  await jf(`${base}/api/users/${made.body.user.id as string}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: grants.map((g) => ({ ...g, scopeType: "global", scopeId: null })) }) });
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

test("watch reasons reach only the watchlist permission: on the Live roster, the watched list and the profile", async () => {
  await withServer(async (base, repo, ctx) => {
    const owner = await ownerAuth(base);
    const made = await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "watch-why", host: "127.0.0.1", port: 1, password: "x" }) });
    const serverId = made.body.server.id as string;
    const steam = `7656119${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: steam, name: "Sneaky", ts: new Date().toISOString() });
    const watched = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: owner, body: JSON.stringify({ reason: "alt of a banned cheater" }) });
    assert.equal(watched.status, 201, JSON.stringify(watched.body));
    share(ctx, serverId, {
      session: { serverName: "watch-why", playerCount: 1 },
      players: { players: [{ iD: steam, name: "Sneaky", platform: "steam", team: 1 }] },
      maprotation: { maps: ["foy_warfare"], current_index: 0 },
    });

    const viewer = await account(base, owner, `viewer${Date.now()}`, [{ capability: "server.view", level: "read" }]);
    const reader = await account(base, owner, `reader${Date.now()}`, [{ capability: "server.view", level: "read" }, { capability: "player.watchlist", level: "read" }]);
    const row = async (auth: Record<string, string>) => ((await jf(`${base}/api/servers/${serverId}/live`, { headers: auth })).body.players as Record<string, unknown>[])[0]!;
    // The viewer first: the roster both read is one shared payload, and cutting it for the viewer
    // must not cut it for whoever reads it next.
    const seen = await row(viewer);
    assert.equal(seen.watch, true, "the 👁 is everyone's");
    assert.equal(seen.watchReason, null, "the reason is not");
    assert.equal(seen.watchBy, null);
    const read = await row(reader);
    assert.equal(read.watchReason, "alt of a banned cheater", "the watchlist permission reads why");
    assert.equal(read.watchBy, "owner");

    const flagged = async (auth: Record<string, string>) => ((await jf(`${base}/api/players/flagged`, { headers: auth })).body.flags as Record<string, unknown>[]).find((f) => f.playerId === player.id)!;
    const listed = await flagged(viewer);
    assert.ok(listed, "who is watched is listed");
    assert.equal(listed.watchReason, null);
    assert.equal(listed.watchBy, null);
    assert.deepEqual(listed.reasons, []);
    // The flag's last change is the watch's own — who armed it, and when — and the panel shows it
    // wherever the author is missing.
    assert.equal(listed.updatedByName, null);
    assert.equal(listed.updatedAt, null);
    const full = await flagged(reader);
    assert.deepEqual((full.reasons as { reason: string }[]).map((r) => r.reason), ["alt of a banned cheater"]);
    assert.equal(full.watchReason, "alt of a banned cheater");
    assert.equal(full.updatedByName, "owner");

    // The profile left out the reason and its author, but sent the same last change.
    const profile = async (auth: Record<string, string>) => (await jf(`${base}/api/players/${player.id}`, { headers: auth })).body.flags as Record<string, unknown>;
    const plain = await profile(viewer);
    assert.equal(plain.watchlist, true, "the 👁 is everyone's");
    assert.equal(plain.watchBy, null);
    assert.equal(plain.updatedByName, null, "who last changed the watch is who set it");
    assert.equal(plain.updatedAt, null);
    const told = await profile(reader);
    assert.equal(told.updatedByName, "owner");
    assert.equal(told.watchBy, "owner");
  });
});
