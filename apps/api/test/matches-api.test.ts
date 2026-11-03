import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { jf, ownerAuth } from "./harness.ts";

async function withRepoServer(fn: (base: string, repo: any) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); }
}

test("matches: pairs start/end into rounds, newest first, with duration + score", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "m", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const base0 = 1_700_000_000_000;
    const t = (n: number) => new Date(base0 + n * 60_000).toISOString(); // n minutes
    const ev = (kind: string, n: number, data: any) => ({ serverId: id, ts: t(n), kind, actorPlayerId: null, actorName: null, victimPlayerId: null, victimName: null, weapon: null, data, dedupeKey: `${kind}-${n}` });

    await repo.events.insert([
      ev("evt.match.started", 0, { map: "Carentan Warfare" }),
      ev("evt.match.ended", 30, { result: "Carentan Allies (3 - 2)", score: "3 - 2" }),
      ev("evt.match.started", 35, { map: "Foy Warfare" }), // ongoing (no end)
      ev("evt.kill", 10, null), // ignored
    ]);

    const r = await jf(`${base}/api/servers/${id}/matches`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.body.matches.length, 2);
    // newest first: ongoing Foy, then finished Carentan
    assert.equal(r.body.matches[0].map, "Foy Warfare");
    assert.equal(r.body.matches[0].endedAt, null);
    const done = r.body.matches[1];
    assert.equal(done.map, "Carentan Warfare");
    assert.equal(done.durationSec, 30 * 60);
    assert.equal(done.score, "3 - 2");

    assert.equal((await jf(`${base}/api/servers/${id}/matches`)).status, 401);
  });
});

test("matches: an end with no seen start shows a clean map name, not the raw scoreboard text", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "m2", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    // A round whose MATCH START predates the event window: only the modern flanked end line
    // exists. Its map used to render as the whole raw tail — backticks, labels, score and all —
    // which is how "`CARENTAN NIGHT Warfare` ALLIED (5 - 0) AXIS" appeared as a MAP in history.
    await repo.events.insert([{
      serverId: id, ts: new Date(1_700_000_000_000).toISOString(), kind: "evt.match.ended",
      actorPlayerId: null, actorName: null, victimPlayerId: null, victimName: null, weapon: null,
      data: { result: "`CARENTAN NIGHT Warfare` ALLIED (5 - 0) AXIS", score: "5 - 0" },
      dedupeKey: "ghost-end",
    }]);

    const r = await jf(`${base}/api/servers/${id}/matches`, { headers: auth });
    assert.equal(r.status, 200);
    const ghost = r.body.matches.find((m: { map: string | null }) => m.map?.includes("CARENTAN"));
    assert.ok(ghost, "the end-only round is still listed");
    assert.equal(ghost.map, "CARENTAN NIGHT Warfare");
    assert.equal(ghost.score, "5 - 0", "and its score rides in the score column, not the map cell");
  });
});

/*
 * The match REPORT rides the detail read: class split, flow, duels, awards and the per-player
 * fold, all derived from the round's own kill stream. The one honesty rule under test at the
 * end: a round with no captured kill log says complete:false and carries no charts.
 */
test("match detail: the report derives class split, awards and per-player detail from the kill stream", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "rep", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const base0 = 1_700_100_000_000;
    const t = (secs: number) => new Date(base0 + secs * 1000).toISOString();

    const ana = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000009001", name: "Ana" });
    const xen = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000009002", name: "Xen" });
    const m = await repo.matches.open({ serverId: id, map: "carentan_warfare", startedAt: t(0) });
    await repo.matches.bumpStat({ matchId: m.id, playerId: ana.id, serverId: id, playerName: "Ana", side: "allies", kills: 3 });
    await repo.matches.bumpStat({ matchId: m.id, playerId: xen.id, serverId: id, playerName: "Xen", side: "axis", deaths: 3, kills: 1 });
    const kill = (secs: number, actor: string, victim: string, weapon: string) => ({
      serverId: id, ts: t(secs), kind: "evt.kill", actorPlayerId: actor, actorName: actor === ana.id ? "Ana" : "Xen",
      victimPlayerId: victim, victimName: victim === ana.id ? "Ana" : "Xen", weapon, data: null, dedupeKey: `k${secs}`,
    });
    await repo.events.insert([
      kill(10, ana.id, xen.id, "M1 GARAND"),
      kill(40, ana.id, xen.id, "M1 GARAND"),
      kill(70, ana.id, xen.id, "155MM HOWITZER [M114]"),
      kill(90, xen.id, ana.id, "MG42"),
    ]);
    await repo.matches.appendScoreSeries(m.id, [{ platformId: "76561198000009001", sec: 120, combat: 60, offense: 40, defense: 0, support: 10 }]);
    await repo.matches.close(m.id, { endedAt: t(600), winner: "allies", alliedScore: 5, axisScore: 0, result: null });

    const r = await jf(`${base}/api/matches/${m.id}`, { headers: auth });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const report = r.body.report;
    assert.equal(report.complete, true);
    const classes = new Map((report.classSplit as { classId: string; allies: number; axis: number }[]).map((c) => [c.classId, c]));
    assert.equal(classes.get("rifle")?.allies, 2, "the game's own classifier buckets the Garand");
    assert.equal(classes.get("artillery")?.allies, 1);
    assert.equal(classes.get("mg")?.axis, 1);
    assert.equal(report.players[ana.id].killsStreak, 3);
    assert.deepEqual(report.players[ana.id].mostKilled[0], ["Xen", 3]);
    // The personal timeline crosses the wire as tuples, seconds counted from the match's start.
    assert.deepEqual(report.players[ana.id].timeline[0], [10, "k", "Xen", "M1 GARAND"]);
    assert.deepEqual(report.players[ana.id].timeline[3], [90, "d", "Xen", "MG42"]);
    assert.deepEqual(report.players[ana.id].scores, [[120, 60, 40, 0, 10]], "the score charts' points ride the staff report too");
    assert.equal((report.awards as { id: string; value: string }[]).find((a) => a.id === "firstblood")?.value, "0:10");
    assert.deepEqual(report.duels, [{ aId: ana.id, aName: "Ana", bId: xen.id, bName: "Xen", aKills: 3, bKills: 1 }]);
    assert.equal((report.awards as { id: string; playerName: string }[]).find((a) => a.id === "kills")?.playerName, "Ana");

    // A round with no kill log: the scoreboard stands, the report says why the charts don't.
    const bare = await repo.matches.open({ serverId: id, map: "foy_warfare", startedAt: t(700_000) });
    await repo.matches.close(bare.id, { endedAt: t(701_000), winner: null, alliedScore: null, axisScore: null, result: null });
    const r2 = await jf(`${base}/api/matches/${bare.id}`, { headers: auth });
    assert.equal(r2.body.report.complete, false);
    assert.deepEqual(r2.body.report.classSplit, []);
  });
});

test("match detail: players on each side per minute, from this round's own roster samples", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port: 1, password: "x" }) })).body.server.id as string;
    const id = await mk("rep");
    const other = await mk("other");
    const base0 = 1_700_200_000_000;
    const t = (secs: number) => new Date(base0 + secs * 1000).toISOString();
    const side = (players: number) => ({ players, squads: 0, unsquadded: players, noSlSquads: [], byRole: {} });
    const snap = (serverId: string, secs: number, allies: number, axis: number) => repo.rosterSnapshots.record({
      serverId, ts: t(secs), playerCount: allies + axis,
      composition: { players: allies + axis, unassigned: 0, byRole: {}, bySide: { allies: side(allies), axis: side(axis) } },
    });

    const m = await repo.matches.open({ serverId: id, map: "foy_warfare", startedAt: t(0) });
    await snap(id, 15, 30, 31);
    await snap(id, 76, 32, 33);
    await snap(id, 137, 34, 35);
    await snap(other, 5, 90, 90); // another server's sample, nearer the first mark than ours
    await repo.matches.close(m.id, { endedAt: t(130), winner: "allies", alliedScore: 3, axisScore: 2, result: null });
    const r = await jf(`${base}/api/matches/${m.id}`, { headers: auth });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.headcount, [
      { minute: 0, allies: 30, axis: 31 },
      { minute: 1, allies: 32, axis: 33 },
      // 2:00 is 44 s past 1:16; the sample at 2:17 came after the whistle at 2:10.
      { minute: 2, allies: 32, axis: 33 },
    ]);

    // A round still open reads no further than the cap — its samples belong to it, but a sample
    // hours later is not a reason to read and draw six hours of nothing.
    const open = await repo.matches.open({ serverId: id, map: "carentan_warfare", startedAt: t(1000) });
    await snap(id, 1010, 40, 41);
    await snap(id, 1070, 42, 43);
    await snap(id, 1000 + 7 * 3600, 44, 45);
    const live = await jf(`${base}/api/matches/${open.id}`, { headers: auth });
    assert.deepEqual(live.body.headcount, [{ minute: 0, allies: 40, axis: 41 }, { minute: 1, allies: 42, axis: 43 }]);

    // A round the worker never sampled has none.
    const bare = await repo.matches.open({ serverId: other, map: "foy_warfare", startedAt: t(900_000) });
    await repo.matches.close(bare.id, { endedAt: t(901_000), winner: null, alliedScore: null, axisScore: null, result: null });
    assert.deepEqual((await jf(`${base}/api/matches/${bare.id}`, { headers: auth })).body.headcount, []);
  });
});
