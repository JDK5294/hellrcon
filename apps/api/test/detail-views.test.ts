import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createIsolatedRepository } from "@app/db";
import { createHandler, createAppContext, type AppContext } from "../dist/app.js";

/**
 * The two screens that used to be dead ends: a VIP entry you couldn't ask any history of, and a
 * match row that told you a round happened and nothing else.
 */
async function withServer(fn: (base: string, ctx: AppContext) => Promise<void>): Promise<void> {
  // Its own schema against Postgres, its own store in memory — the isolation these tests were
  // written assuming. See createIsolatedRepository.
  const { repo, cleanup } = await createIsolatedRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, ctx);
  } finally {
    server.close();
    await cleanup();
  }
}

async function jsonFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function owner(base: string) {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const r = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = { authorization: `Bearer ${r.body.token as string}` };
  const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "t", host: "127.0.0.1", port: 1, password: "x" }) });
  return { auth, serverId: (created.body.server as { id: string }).id };
}

test("VIP history reads the grants and revokes back out of the audit log", async () => {
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000009", name: "Donor" });

    // Two grants and a revoke, as the VIP routes record them.
    await ctx.repo.audit.create({ actorName: "alice", action: "vip.grant", targetType: "player", targetId: player.platformId, serverId, summary: "granted", data: { expiration: "2026-09-01T00:00:00Z", comment: "donated" } });
    await ctx.repo.audit.create({ actorName: "bob", action: "vip.revoke", targetType: "player", targetId: player.platformId, serverId, summary: "revoked" });
    await ctx.repo.audit.create({ actorName: "alice", action: "vip.grant", targetType: "player", targetId: player.platformId, serverId, summary: "granted again" });
    // …and a reduction, as the reduce route records it: the new expiry lives in `after`, the
    // amount in removedDays/Hours. The timeline exists to answer "why is my VIP shorter?" —
    // leaving reductions out would hide exactly that answer.
    await ctx.repo.audit.create({ actorName: "bob", action: "vip.reduce", targetType: "player", targetId: player.platformId, serverId, summary: "took 3d back", data: { playerId: player.platformId, removedDays: 3, removedHours: 0, before: "2026-09-01T00:00:00Z", after: "2026-08-29T00:00:00.000Z", removed: false } });
    // The two events that used to be INVISIBLE here — and were exactly what destroyed a paid
    // permanent grant while this view showed nothing between a grant and a mystery revoke: the
    // automated write that moved the expiry, and the sweep that then removed the grant.
    await ctx.repo.audit.create({ actorName: "seeding", action: "seed.reward", targetType: "player", targetId: player.platformId, serverId, summary: "seed reward", data: { hours: 72, expiration: "2026-09-04T00:00:00Z" } });
    await ctx.repo.audit.create({ actorName: "system", action: "vip.expire", targetType: "player", targetId: player.platformId, serverId, summary: "expired", data: { expiration: "2026-09-04T00:00:00Z" } });
    // Seed rows that changed nothing stay out: a dry run, and a points-only reward.
    await ctx.repo.audit.create({ actorName: "seeding", action: "seed.reward", targetType: "player", targetId: player.platformId, serverId, summary: "dry", data: { hours: 72, expiration: "2026-09-05T00:00:00Z", dryRun: true } });
    await ctx.repo.audit.create({ actorName: "seeding", action: "seed.reward", targetType: "player", targetId: player.platformId, serverId, summary: "points only", data: { points: 500 } });
    // Noise that must not appear: a different action, and the same action on someone else.
    await ctx.repo.audit.create({ actorName: "alice", action: "player.kick", targetType: "player", targetId: player.platformId, serverId, summary: "kicked" });
    await ctx.repo.audit.create({ actorName: "alice", action: "vip.grant", targetType: "player", targetId: "76561100000000010", serverId, summary: "someone else" });

    const r = await jsonFetch(`${base}/api/players/${player.id}/vip-history`, { headers: auth });
    assert.equal(r.status, 200);
    const history = r.body.history as { action: string; by: string; serverName: string | null; expiration: string | null; comment: string | null }[];
    assert.equal(history.length, 6, "only this player's VIP entries — expiry and expiry-moving seed rows included");
    assert.deepEqual(history.map((h) => h.action).sort(), ["expired", "granted", "granted", "reduced", "revoked", "seed reward"]);
    const seeded = history.find((h) => h.action === "seed reward")!;
    assert.equal(seeded.expiration, "2026-09-04T00:00:00Z", "the seed row shows the expiry it wrote");
    assert.equal(seeded.by, "seeding");
    const expired = history.find((h) => h.action === "expired")!;
    assert.equal(expired.expiration, "2026-09-04T00:00:00Z", "the expire row shows the date the grant died at");
    assert.ok(history.every((h) => h.serverName === "t"), "the server is named, not just its id");
    const granted = history.find((h) => h.comment === "donated")!;
    assert.equal(granted.expiration, "2026-09-01T00:00:00Z", "the expiry that was set is carried through");
    assert.equal(granted.by, "alice");
    const reduced = history.find((h) => h.action === "reduced")!;
    assert.equal(reduced.expiration, "2026-08-29T00:00:00.000Z", "a reduction shows the NEW expiry");
    assert.equal(reduced.comment, "3d taken back");
    assert.equal(reduced.by, "bob");
  });
});

test("VIP history is gated by the vip capability", async () => {
  await withServer(async (base, ctx) => {
    const { auth } = await owner(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000011", name: "X" });
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip-history`, { headers: plain })).status, 403);
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip-history`)).status, 401);
  });
});

test("a match opens to its full scoreboard", async () => {
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    const match = await ctx.repo.matches.open({ serverId, map: "Foy", startedAt: "2026-07-01T10:00:00Z" });
    await ctx.repo.matches.close(match.id, { endedAt: "2026-07-01T11:00:00Z", winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIES WIN 5 - 0" });
    // Real player rows: player_id is a uuid in Postgres, so a made-up "p1" cannot be stored.
    const ally = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000021", name: "Ally One" });
    const axis = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000022", name: "Axis One" });
    await ctx.repo.matches.bumpStat({ matchId: match.id, playerId: ally.id, serverId, playerName: "Ally One", side: "allies", kills: 30, deaths: 10, teamkills: 1 });
    await ctx.repo.matches.bumpStat({ matchId: match.id, playerId: axis.id, serverId, playerName: "Axis One", side: "axis", kills: 12, deaths: 25 });

    const r = await jsonFetch(`${base}/api/matches/${match.id}`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.body.match.map, "Foy");
    assert.equal(r.body.match.winner, "allies");
    assert.equal(r.body.match.serverName, "t", "the round names its server rather than only its id");
    const stats = r.body.stats as { playerName: string; kills: number; side: string }[];
    assert.equal(stats.length, 2);
    assert.equal(stats.find((s) => s.playerName === "Ally One")?.kills, 30);
    assert.equal(stats.find((s) => s.playerName === "Axis One")?.side, "axis");
  });
});

test("an unknown match is a 404, not an empty screen", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);
    assert.equal((await jsonFetch(`${base}/api/matches/00000000-0000-0000-0000-000000000000`, { headers: auth })).status, 404);
    assert.equal((await jsonFetch(`${base}/api/matches/whatever`)).status, 401);
  });
});

test("the matches list carries the id each row needs to open", async () => {
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    const m = await ctx.repo.matches.open({ serverId, map: "Carentan", startedAt: "2026-07-02T10:00:00Z" });
    await ctx.repo.matches.close(m.id, { endedAt: "2026-07-02T10:40:00Z", winner: "axis", alliedScore: 2, axisScore: 3, result: "" });
    const r = await jsonFetch(`${base}/api/servers/${serverId}/matches`, { headers: auth });
    assert.equal(r.status, 200);
    const row = (r.body.matches as { id?: string; map: string }[]).find((x) => x.map === "Carentan");
    assert.equal(row?.id, m.id, "without this the row has nothing to link to");
  });
});

test("the game log searches the whole log, not just the last screenful", async () => {
  // The filters used to run in JavaScript over the most recent 1000 rows, so on a busy server a
  // chat search could not see past the last few hours of kills — and nothing said so.
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    const rows: Parameters<typeof ctx.repo.events.insert>[0] = [
      { serverId, ts: "2026-01-01T00:00:00.000Z", kind: "evt.chat", actorName: "Ghost", data: { message: "needle in the haystack" }, dedupeKey: "chat-1" },
    ];
    for (let i = 0; i < 1200; i++) {
      rows.push({ serverId, ts: new Date(Date.parse("2026-01-02T00:00:00Z") + i * 1000).toISOString(), kind: "evt.kill", actorName: `K${i}`, dedupeKey: `k-${i}` });
    }
    await ctx.repo.events.insert(rows);

    const hit = await jsonFetch(`${base}/api/servers/${serverId}/events?q=needle`, { headers: auth });
    assert.equal(hit.status, 200);
    assert.equal((hit.body.events as unknown[]).length, 1, "the buried chat line is findable");
    assert.equal(hit.body.total, 1, "and the total describes the filter, not the log");

    const kills = await jsonFetch(`${base}/api/servers/${serverId}/events?kinds=evt.kill&limit=50`, { headers: auth });
    assert.equal((kills.body.events as unknown[]).length, 50, "a filtered page is a full page");
    assert.equal(kills.body.total, 1200, "the total counts every match, not the page");
  });
});

test("paging the game log covers every line exactly once", async () => {
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    await ctx.repo.events.insert(Array.from({ length: 250 }, (_, i) => ({
      serverId, ts: new Date(Date.parse("2026-02-01T00:00:00Z") + i * 1000).toISOString(),
      kind: "evt.kill", actorName: `P${i}`, dedupeKey: `p-${i}`,
    })));
    const seen = new Set<string>();
    for (let offset = 0; offset < 300; offset += 100) {
      const r = await jsonFetch(`${base}/api/servers/${serverId}/events?limit=100&offset=${offset}`, { headers: auth });
      for (const e of r.body.events as { id: string }[]) seen.add(e.id);
    }
    assert.equal(seen.size, 250, "no line repeated across pages, none skipped");
  });
});

test("staff activity and match history report their totals", async () => {
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    // Setting up the fixture writes its own audit entries (creating the server is an admin action),
    // so measure from a baseline rather than assuming the trail starts empty.
    const before = (await jsonFetch(`${base}/api/audit?limit=1`, { headers: auth })).body.total as number;
    for (let i = 0; i < 12; i++) {
      await ctx.repo.audit.create({ actorName: "admin", action: "test.action", summary: `entry ${i}` });
    }
    const a = await jsonFetch(`${base}/api/audit?limit=5`, { headers: auth });
    assert.equal((a.body.entries as unknown[]).length, 5, "a page is a page");
    assert.equal(a.body.total, before + 12, "the trail knows how much more there is than the page");

    for (let i = 0; i < 7; i++) {
      const m = await ctx.repo.matches.open({ serverId, map: `Map${i}`, startedAt: new Date(Date.parse("2026-03-01T00:00:00Z") + i * 3600_000).toISOString() });
      await ctx.repo.matches.close(m.id, { endedAt: null as unknown as string, winner: null, alliedScore: null, axisScore: null, result: null });
    }
    const mres = await jsonFetch(`${base}/api/servers/${serverId}/matches?limit=3`, { headers: auth });
    assert.equal(mres.body.total, 7, "match history knows its total");
    const page2 = await jsonFetch(`${base}/api/servers/${serverId}/matches?limit=3&offset=3`, { headers: auth });
    assert.equal((page2.body.matches as unknown[]).length, 3, "there is a second page to reach");
  });
});

/**
 * An imported message says what was said.
 *
 * The text arrives from CRCON and is stored on the event as `message` — but the profile's reader
 * only ever looked at `reason`, which a message does not have. So it was imported, kept, and
 * dropped on the way out: a stack of "MESSAGE · by CRCON" rows that expanded to a server name and
 * nothing else, missing the one thing you open that row to read.
 */
test("moderation history shows the text of a message imported from CRCON", async () => {
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000021", name: "Tex" });

    // How the log-line importer files a message, and how it files a kick — the two shapes the
    // profile has to tell apart.
    await ctx.repo.events.insert([
      { serverId, ts: "2026-06-07T18:00:00.000Z", kind: "evt.admin.message",
        actorPlayerId: player.id, actorName: "Tex", victimPlayerId: null, victimName: null, weapon: null,
        data: { message: "Please use your microphone in this squad.", by: "CRCON" },
        dedupeKey: "crcon:msg:1" },
      { serverId, ts: "2026-06-06T18:00:00.000Z", kind: "evt.player.kicked",
        actorPlayerId: player.id, actorName: "Tex", victimPlayerId: null, victimName: null, weapon: null,
        data: { reason: "no mic", by: "CRCON" },
        dedupeKey: "crcon:kick:1" },
    ]);

    const r = await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth });
    assert.equal(r.status, 200);
    const mod = r.body.moderation as { action: string; summary: string; data: Record<string, unknown> | null }[];

    const msg = mod.find((m) => m.action === "player.message");
    assert.ok(msg, "the imported message is on the timeline");
    assert.equal(msg!.data?.message, "Please use your microphone in this squad.",
      "and carries its text under `message`, so the detail labels it 'Message sent'");
    assert.equal(msg!.summary, "Please use your microphone in this squad.");
    assert.equal(msg!.data?.reason, undefined, "a message has no reason — it is not one");

    // The kick is unchanged: its text really is a reason and stays filed as one.
    const kick = mod.find((m) => m.action === "player.kick");
    assert.equal(kick!.data?.reason, "no mic");
  });
});

/**
 * A ban is still visible on a profile buried in imported messages.
 *
 * Enforcement and messages used to come from one newest-200 read across all four kinds, merged and
 * cut to thirty. An imported archive is not a mix — a chatty server records hundreds of admin
 * messages per player and a handful of kicks — so the two hundred were all messages, the thirty
 * were all messages, and an old ban was not below the fold, it was never fetched. The section
 * people open to ask "has this player been dealt with before?" answered with a wall of MESSAGE.
 */
test("moderation history keeps enforcement visible under a pile of imported messages", async () => {
  await withServer(async (base, ctx) => {
    const { auth, serverId } = await owner(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000022", name: "Chatty" });

    // One old ban, then 120 newer messages — every one of them more recent than the ban.
    await ctx.repo.events.insert([{
      serverId, ts: "2026-01-01T12:00:00.000Z", kind: "evt.player.banned",
      actorPlayerId: player.id, actorName: "Chatty", victimPlayerId: null, victimName: null, weapon: null,
      data: { reason: "cheating", banType: "perma", by: "OldAdmin" }, dedupeKey: "crcon:ban:old",
    }]);
    await ctx.repo.events.insert(Array.from({ length: 120 }, (_, i) => ({
      serverId, ts: new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 60_000).toISOString(),
      kind: "evt.admin.message",
      actorPlayerId: player.id, actorName: "Chatty", victimPlayerId: null, victimName: null, weapon: null,
      data: { message: `reminder ${i}`, by: "CRCON" }, dedupeKey: `crcon:msg:${i}`,
    })));

    const r = await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth });
    const mod = r.body.moderation as { action: string; data: Record<string, unknown> | null }[];

    const ban = mod.find((m) => m.action === "player.permaban");
    assert.ok(ban, "the ban survives 120 more-recent messages");
    assert.equal(ban!.data?.reason, "cheating");
    // Messages still fill the rest of the list rather than being dropped altogether.
    assert.ok(mod.filter((m) => m.action === "player.message").length > 20, "messages still make the timeline");
    assert.ok(mod.length <= 30, "and the list is still bounded");
  });
});

/**
 * A lifted ban is an unban on the profile, whichever way it was lifted.
 *
 * Lift all, which clears every ban on a server, records one entry for the server and none for
 * each player. A ban lifted that way never reached the player's history: it ended at the ban, as
 * if it still stood, and the only place left to check was the Bans page with lifted bans shown.
 * The lift is read from the ban record now — who lifted it, and when — and a lift the trail
 * already has is said once.
 */
test("moderation history shows a lifted ban as an unban, whichever way it was lifted, and each lift once", async () => {
  await withServer(async (base, ctx) => {
    const { auth } = await owner(base);
    const ww2 = await ctx.repo.servers.create({ name: "WW2", host: "127.0.0.1", port: 1, password: "x", game: "hll", engagementMode: "active" } as never);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "xbl", platformId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", name: "Kestrel" });
    const ban = (kind: "perma" | "temp", over: Record<string, unknown> = {}) => ctx.repo.playerBans.create({
      game: "hll", playerId: player.platformId, kind, reason: "Harassing our members", scope: { mode: "servers", serverIds: [ww2!.id] } as never,
      createdByName: "BLACKLIST: Sam", createdAt: "2026-08-12T15:00:00.000Z", ...over,
    } as never);
    const history = async () => ((await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth })).body);

    // Lifted with Lift all on its server: the ban record says so, the trail has nothing on the player.
    const lifted = await ban("perma");
    const r = await jsonFetch(`${base}/api/servers/${ww2!.id}/bans/lift-all`, { method: "POST", headers: auth, body: JSON.stringify({}) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.lifted, 1);
    const stamped = (await ctx.repo.playerBans.list({ playerId: player.platformId })).find((b) => b.id === lifted.id)!;
    assert.ok(stamped.liftedAt && stamped.liftedByName === "owner");
    let body = await history();
    let unbans = (body.moderation as { id: string; ts: string; action: string; actorName: string; summary: string }[]).filter((m) => m.action.startsWith("player.unban_"));
    assert.equal(unbans.length, 1, JSON.stringify(body.moderation));
    assert.deepEqual({ ...unbans[0], id: undefined }, {
      ...unbans[0], id: undefined, ts: stamped.liftedAt, action: "player.unban_perma", actorName: "owner",
      summary: "lifted the perma ban placed on 2026-08-12T15:00:00.000Z by BLACKLIST: Sam (WW2) — Harassing our members",
    }, "who lifted it, when, and which ban");
    assert.equal(body.banStatus.permaBan, null, "and the profile does not mark them banned");

    // An unban the trail has (the player's menu, the Bans page, an approved request) is said once:
    // the trail's entry and the ban's lift a moment apart are the same unban.
    const temp = await ban("temp", { expiresAt: "2099-01-01T00:00:00.000Z" });
    const at = Date.now();
    await ctx.repo.audit.create({
      actorUserId: null, actorName: "Sam", action: "player.unban_temp", targetType: "player", targetId: player.platformId,
      serverId: ww2!.id, summary: "ran unban_temp on Kestrel", data: { playerId: player.platformId },
    });
    await ctx.repo.playerBans.lift(temp.id, "Sam", new Date(at + 2_000).toISOString());
    // A lift of the OTHER kind at the same moment is its own unban.
    const other = await ban("perma");
    await ctx.repo.playerBans.lift(other.id, "Alex", new Date(at + 2_000).toISOString());
    // The other game's ban on the same account id is the other game's profile's.
    const viet = await ctx.repo.playerBans.create({ game: "hllv", playerId: player.platformId, kind: "perma", reason: "x", scope: { mode: "all" } as never, createdByName: "t" } as never);
    await ctx.repo.playerBans.lift(viet.id, "Nobody");
    // One still in force: no unban, and the profile marks it.
    await ban("perma", { reason: "still banned" });

    body = await history();
    unbans = (body.moderation as typeof unbans).filter((m) => m.action.startsWith("player.unban_"));
    assert.deepEqual(unbans.map((m) => `${m.action} ${m.actorName}`).sort(), ["player.unban_perma Alex", "player.unban_perma owner", "player.unban_temp Sam"], JSON.stringify(unbans));
    assert.ok(unbans.find((m) => m.action === "player.unban_temp")!.summary.startsWith("ran unban_temp"), "the trail's own entry is the one kept");
    assert.equal(body.banStatus.permaBan?.reason, "still banned");
  });
});
