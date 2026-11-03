/**
 * The "wipe the slate on one server" operation — POST /api/servers/:id/bans/lift-all.
 *
 * The whole risk of a bulk unban is reach: it must clear exactly the named server and not one
 * player more. So the contract under test is the scope arithmetic — a decision scoped only to
 * the target is lifted, one that also covers a sibling merely stops covering the target, a
 * community-wide rule becomes "everywhere except", and the other game's record is never even
 * read. The game half runs against an unreachable address here on purpose: the record must land
 * first and stand on its own, with the dial failure reported rather than undoing anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth } from "./harness.ts";
import { FakeHllServer } from "./fake-hll-server.ts";

test("lift-all clears exactly one server: lifts its own bans, narrows shared ones, leaves the other game alone", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = (name: string, port: number, game = "hll") =>
      repo.servers.create({ name, host: "127.0.0.1", port, password: "p", game, engagementMode: "active" });
    const s1 = await mk("One", 41), s2 = await mk("Two", 42);
    await mk("Nam", 43, "hllv"); // the other game's server exists, so its "all" rule resolves to something real

    const ban = (playerId: string, scope: object, game = "hll") =>
      repo.playerBans.create({ game, playerId, kind: "perma", reason: "r", scope: scope as never, createdByName: "t" });
    const only1 = await ban("765-only1", { mode: "servers", serverIds: [s1.id] });
    const both = await ban("765-both", { mode: "servers", serverIds: [s1.id, s2.id] });
    const everywhere = await ban("765-everywhere", { mode: "all" });
    const viet = await ban("eos-viet", { mode: "all" }, "hllv");

    const r = await jf(`${base}/api/servers/${s1.id}/bans/lift-all`, { method: "POST", headers: auth, body: JSON.stringify({}) });
    assert.equal(r.status, 200);
    assert.equal(r.body.lifted, 1, "only the ban scoped to this server alone is over");
    assert.equal(r.body.narrowed, 2, "the shared and community-wide rules shrink instead");
    assert.ok(r.body.gameError, "the unreachable game is reported, not fatal — the record already landed");

    const rows = new Map((await repo.playerBans.list({})).map((b) => [b.id, b]));
    assert.ok(rows.get(only1.id)?.liftedAt, "scoped-only ban is stamped lifted");
    assert.deepEqual(rows.get(both.id)?.scope, { mode: "servers", serverIds: [s2.id] }, "the sibling stays banned");
    assert.equal(rows.get(both.id)?.liftedAt, null);
    assert.deepEqual(rows.get(everywhere.id)?.scope, { mode: "except", serverIds: [s1.id] },
      "community-wide keeps covering servers added later — minus exactly this one");
    assert.deepEqual(rows.get(viet.id)?.scope, { mode: "all" }, "the other game's record is untouched");
    assert.equal(rows.get(viet.id)?.liftedAt, null);

    // Idempotent in effect: nothing covers the server any more, so a second run changes nothing.
    const again = await jf(`${base}/api/servers/${s1.id}/bans/lift-all`, { method: "POST", headers: auth, body: JSON.stringify({}) });
    assert.equal(again.status, 200);
    assert.equal(again.body.lifted, 0);
    assert.equal(again.body.narrowed, 0);
  });
});

test("lift-all refuses an observe-mode server before touching the record", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const s = await repo.servers.create({ name: "Watchonly", host: "127.0.0.1", port: 44, password: "p", engagementMode: "observe" });
    const b = await repo.playerBans.create({ game: "hll", playerId: "765-x", kind: "perma", reason: "r", scope: { mode: "servers", serverIds: [s.id] } as never, createdByName: "t" });

    const r = await jf(`${base}/api/servers/${s.id}/bans/lift-all`, { method: "POST", headers: auth, body: JSON.stringify({}) });
    assert.equal(r.status, 409);
    assert.match(String((r.body.error as { message?: string })?.message), /observe/);
    const row = (await repo.playerBans.list({})).find((x) => x.id === b.id);
    assert.equal(row?.liftedAt, null, "the decision still stands — no record/game split-brain");
  });
});

/*
 * The record's search reaches the servers a ban covers, so "nam" finds every decision that bans
 * someone from Nam — resolved from the RULE, so a community-wide ban matches every server's name.
 */
test("ban search matches the names of the servers a ban covers", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const one = await repo.servers.create({ name: "Alpha Main", host: "127.0.0.1", port: 51, password: "p" });
    const two = await repo.servers.create({ name: "Bravo Seed", host: "127.0.0.1", port: 52, password: "p" });
    const mk = (playerId: string, scope: object) =>
      repo.playerBans.create({ game: "hll", playerId, kind: "perma", reason: "r", scope: scope as never, createdByName: "t" });
    await mk("765-alpha-only", { mode: "servers", serverIds: [one.id] });
    await mk("765-bravo-only", { mode: "servers", serverIds: [two.id] });
    await mk("765-everywhere", { mode: "all" });

    const find = async (q: string) =>
      ((await jf(`${base}/api/bans?q=${encodeURIComponent(q)}`, { headers: auth })).body.bans as { playerId: string }[])
        .map((b) => b.playerId).sort();
    assert.deepEqual(await find("bravo"), ["765-bravo-only", "765-everywhere"], "the Bravo ban and the one covering everywhere");
    assert.deepEqual(await find("alpha main"), ["765-alpha-only", "765-everywhere"]);
    assert.deepEqual(await find("765-bravo"), ["765-bravo-only"], "ids still match on their own");
  });
});

/*
 * HLL goes on listing a temp ban after its time runs out, and refuses to remove it with a 400.
 * Clearing a server's list counts those instead of sending them — as reported, they read as
 * failures nobody could fix — and clears everything still enforced.
 */
test("lift-all leaves temp bans the game lists after their time ran out, and clears the rest", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    try {
      const srv = await repo.servers.create({ name: "WW2 live", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
      fake.tempBans.set("tk-old", { playerId: "tk-old", playerName: "Gunplay", reason: "team kills", by: "rules", hours: 24, at: hoursAgo(30) });
      fake.tempBans.set("tk-new", { playerId: "tk-new", playerName: "Flashlight555", reason: "team kills", by: "rules", hours: 24, at: hoursAgo(6) });
      fake.permaBans.set("cheat", { playerId: "cheat", reason: "aimbot", by: "mod" });

      const r = await jf(`${base}/api/servers/${srv.id}/bans/lift-all`, { method: "POST", headers: auth, body: JSON.stringify({}) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.cleared, 2, "the running temp ban and the perma ban came off");
      assert.equal(r.body.ranOut, 1, "the finished one is counted");
      assert.deepEqual(r.body.failed, [], "and never sent, so nothing reads as refused");
      assert.ok(fake.tempBans.has("tk-old"), "the game goes on listing it, as HLL does");
      assert.equal(fake.tempBans.has("tk-new") || fake.permaBans.has("cheat"), false);
    } finally {
      fake.close();
    }
  });
});
