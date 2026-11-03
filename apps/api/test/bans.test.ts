import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext, type AppContext } from "../dist/app.js";
import { jf, ownerAuth } from "./harness.ts";

async function withServer(fn: (base: string, ctx: AppContext) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, ctx); } finally { server.close(); }
}

/*
 * The Bans page reads DECISIONS, not an audit replay.
 *
 * It used to derive itself from the last 500 audit entries of any kind, filtered to ban actions —
 * so a busy week of kicks and VIP grants pushed real bans off the end of the window and they
 * quietly vanished from the page. One row here is one decision, however many servers its rule
 * covers, and the table has no window (docs/ban-model.md).
 */
test("the ban record lists decisions — active by default, history on request, searchable", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const mk = (over: Record<string, unknown>) => ctx.repo.playerBans.create({
      game: "hll", playerId: "111", playerName: "Cheater", kind: "perma", reason: "aimbot",
      category: null, scope: { mode: "all" }, expiresAt: null, createdByUserId: null, createdByName: "owner",
      ...over,
    });
    await mk({});
    await mk({ playerId: "222", playerName: "Griefer", kind: "temp", reason: "mass TK", createdByName: "enforcer" });
    // A ban audit entry is NOT a decision — the replay is exactly what this page stopped doing.
    await ctx.repo.audit.create({ actorName: "owner", action: "player.permaban", targetType: "player", targetName: "Ghost", summary: "perma", data: { playerId: "999" } });

    const r = await jf(`${base}/api/bans`, { headers: auth });
    assert.equal(r.status, 200);
    const bans = r.body.bans as any[];
    assert.equal(bans.length, 2, "two decisions, and nothing conjured from the audit trail");
    const perma = bans.find((b) => b.type === "perma");
    assert.equal(perma.playerName, "Cheater");
    assert.equal(perma.playerId, "111");
    assert.deepEqual(perma.scope, { mode: "all" }, "the rule travels, not just today's expansion");
    assert.equal(perma.active, true);
    // The enforcer's own bans are marked, so "who did this" reads as automation rather than a person.
    assert.equal(bans.find((b) => b.type === "temp").auto, true);

    // A lifted decision leaves the active list but is never deleted — history=1 brings it back.
    await ctx.repo.playerBans.liftAllFor("222", "owner", "temp");
    assert.equal(((await jf(`${base}/api/bans`, { headers: auth })).body.bans as any[]).length, 1);
    const hist = await jf(`${base}/api/bans?history=1`, { headers: auth });
    assert.equal((hist.body.bans as any[]).length, 2);
    assert.equal((hist.body.bans as any[]).find((b) => b.playerId === "222").active, false);

    // Search narrows across player, reason, category and staff.
    assert.equal(((await jf(`${base}/api/bans?q=aimbot`, { headers: auth })).body.bans as any[]).length, 1);
  });
});

test("bans require auth", async () => {
  await withServer(async (base) => {
    assert.equal((await jf(`${base}/api/bans`)).status, 401);
  });
});

test("a nameless ban wears the directory's name for that id", async () => {
  // Bans synced off the game arrive as bare ids — the game's list carries no names — but the
  // directory usually KNOWS who an id is. The book fills the gap from it, and search finds the
  // row by that name; an id the panel has never seen stays honestly nameless.
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    await ctx.repo.players.upsert({ game: "hllv", platform: "xbox", platformId: "0002a4baec8748b28f8da0cb86bbfcb0", name: "SchrockDaddy" });
    await ctx.repo.playerBans.create({
      game: "hllv", playerId: "0002a4baec8748b28f8da0cb86bbfcb0", playerName: null, kind: "perma", reason: "synced",
      category: null, scope: { mode: "all" }, expiresAt: null, createdByUserId: null, createdByName: "sync",
    });
    await ctx.repo.playerBans.create({
      game: "hllv", playerId: "0002ffffffffffffffffffffffffffff", playerName: null, kind: "perma", reason: "synced",
      category: null, scope: { mode: "all" }, expiresAt: null, createdByUserId: null, createdByName: "sync",
    });

    const bans = (await jf(`${base}/api/bans`, { headers: auth })).body.bans as any[];
    assert.equal(bans.find((b) => b.playerId === "0002a4baec8748b28f8da0cb86bbfcb0").playerName, "SchrockDaddy");
    assert.equal(bans.find((b) => b.playerId === "0002ffffffffffffffffffffffffffff").playerName, null, "an id nobody has seen stays nameless");
    // The filled name is searchable, exactly like one recorded at ban time.
    assert.equal(((await jf(`${base}/api/bans?q=schrockdaddy`, { headers: auth })).body.bans as any[]).length, 1);
  });
});

test("each ban row says which platform the player is on, from the directory", async () => {
  // The Platform column on the ban record. It is the token the game reported for the player (the
  // same one the By platform analytics split by), read for EVERY row — a ban recorded with its
  // name still needs its platform. An id the panel has never seen has no platform to claim.
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    await ctx.repo.players.upsert({ game: "hll", platform: "EPlatformFamily::XboxSeries", platformId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Boxer" });
    await ctx.repo.players.upsert({ game: "hllv", platform: "steam", platformId: "76561198000000042", name: "Piper" });
    const mk = (game: string, playerId: string, playerName: string | null) => ctx.repo.playerBans.create({
      game, playerId, playerName, kind: "perma", reason: "test", category: null, scope: { mode: "all" },
      expiresAt: null, createdByUserId: null, createdByName: "owner",
    });
    await mk("hll", "a1b2c3d4e5f60718293a4b5c6d7e8f90", "Boxer");
    await mk("hllv", "76561198000000042", null);
    await mk("hll", "ffffffffffffffffffffffffffffffff", null);

    const bans = (await jf(`${base}/api/bans`, { headers: auth })).body.bans as any[];
    const of = (id: string) => bans.find((b) => b.playerId === id);
    assert.equal(of("a1b2c3d4e5f60718293a4b5c6d7e8f90").platform, "EPlatformFamily::XboxSeries", "a named row still gets its platform");
    assert.equal(of("76561198000000042").platform, "steam");
    assert.equal(of("76561198000000042").playerName, "Piper", "the name fill is unchanged");
    assert.equal(of("ffffffffffffffffffffffffffffffff").platform, null, "an id nobody has seen has no platform");
    // The directory's name for a row that already had one is still not searched — only the gaps
    // are filled, as before.
    await ctx.repo.players.upsert({ game: "hll", platform: "EPlatformFamily::XboxSeries", platformId: "a1b2c3d4e5f60718293a4b5c6d7e8f90", name: "Renamed" });
    assert.equal(((await jf(`${base}/api/bans?q=renamed`, { headers: auth })).body.bans as any[]).length, 0);
  });
});
