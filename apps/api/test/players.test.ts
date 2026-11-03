import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository, createIsolatedRepository } from "@app/db";
import { createHandler, createAppContext, type AppContext } from "../dist/app.js";
import { jsonFetch } from "./harness.ts";

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

async function ownerAuth(base: string) {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return { authorization: `Bearer ${login.body.token as string}` };
}

test("search finds a player; profile carries stats, flags, notes gate", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Peter" });

    const search = await jsonFetch(`${base}/api/players?q=pete`, { headers: auth });
    assert.ok((search.body.players as any[]).some((p) => p.id === player.id));

    const prof = await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth });
    assert.equal(prof.status, 200);
    assert.equal(prof.body.player.name, "Peter");
    assert.equal(prof.body.flags.watchlist, false);
    assert.equal(prof.body.canViewNotes, true); // owner has * → notes visible
    assert.ok(Array.isArray(prof.body.notes));

    // rich combat analytics ship on every profile, in their calm empty shape when history is thin
    assert.ok(prof.body.combat, "combat analytics missing from the profile");
    assert.deepEqual(prof.body.combat.killTypes, []);
    assert.deepEqual(prof.body.combat.streaks, { bestKillstreak: 0, currentKillstreak: 0, bestDeathstreak: 0 });
    assert.equal(prof.body.combat.rates.kpm, null);
  });
});

test("flags toggle + notes create, both audited", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000002", name: "Robo" });

    const flagged = await jsonFetch(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ watchlist: true }) });
    assert.equal(flagged.status, 200);
    assert.equal(flagged.body.flags.watchlist, true);

    // VIP is a GRANT, not a flag. It used to be settable here as a second, cosmetic source of
    // truth, which let a star say the opposite of the grants table. The refusal names where it
    // moved to rather than quietly ignoring the field.
    const asFlag = await jsonFetch(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ vip: true }) });
    assert.equal(asFlag.status, 400);
    assert.match(String(asFlag.body.error?.message ?? ""), /vip is not a flag/i);

    // shows up in the flagged list
    const list = await jsonFetch(`${base}/api/players/flagged`, { headers: auth });
    assert.ok((list.body.flags as any[]).some((f) => f.playerId === player.id));

    // A VIP-only marker row is NOT a watchlist entry. Since the marker follows the real grant,
    // every VIP in the community has one of these rows — and the flagged route used to fetch,
    // enrich and ship them all, for every caller to filter straight back out.
    const vipOnly = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000022", name: "Just A VIP" });
    await ctx.repo.playerFlags.set(vipOnly.id, { vip: true }, { userId: null, name: "grant-sync" });
    const list2 = await jsonFetch(`${base}/api/players/flagged`, { headers: auth });
    assert.ok(!(list2.body.flags as any[]).some((f) => f.playerId === vipOnly.id), "VIP-only rows stay out of the watchlist");

    const note = await jsonFetch(`${base}/api/players/${player.id}/notes`, { method: "POST", headers: auth, body: JSON.stringify({ body: "toxic in chat" }) });
    assert.equal(note.status, 201);

    const prof = await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth });
    assert.equal((prof.body.notes as any[])[0].body, "toxic in chat");

    const audit = await jsonFetch(`${base}/api/audit`, { headers: auth });
    const actions = (audit.body.entries as any[]).map((e) => e.action);
    assert.ok(actions.includes("player.flags"));
    assert.ok(actions.includes("note.create"));
  });
});

test("watch provenance: reason/who/when survive VIP toggles and imports, clear on unwatch", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000012", name: "Suspect" });

    // Staff watch with a reason → the record says why, who and when.
    const on = await jsonFetch(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ watchlist: true, reason: "team-killing on seed" }) });
    assert.equal(on.body.flags.watchReason, "team-killing on seed");
    assert.equal(on.body.flags.watchBy, "admin");
    assert.ok(on.body.flags.watchAt, "watch timestamp recorded");

    // Re-asserting the watch must not erase its own story (updatedBy/At move, provenance stays).
    const reasserted = await jsonFetch(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ watchlist: true }) });
    assert.equal(reasserted.body.flags.watchReason, "team-killing on seed");
    assert.equal(reasserted.body.flags.watchBy, "admin");

    // The flagged list (the Watchlist tab) carries it too.
    const list = await jsonFetch(`${base}/api/players/flagged`, { headers: auth });
    const row = (list.body.flags as any[]).find((f) => f.playerId === player.id);
    assert.equal(row.watchReason, "team-killing on seed");
    assert.equal(row.watchBy, "admin");

    // ...and the audit trail names the reason.
    const audit = await jsonFetch(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "player.flags" && String(e.summary).includes("team-killing on seed")));

    // Import-style set: the ORIGINAL CRCON author/timestamp lands, not the importer/now.
    const other = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000013", name: "Imported" });
    const imported = await ctx.repo.playerFlags.set(other.id, { watchlist: true, watchReason: "griefing", watchBy: "OldAdmin", watchAt: "2024-05-01T10:00:00.000Z" }, { userId: null, name: "importer" });
    assert.equal(imported.watchBy, "OldAdmin");
    assert.equal(imported.watchAt, "2024-05-01T10:00:00.000Z");
    // Re-flagging (idempotent re-import with no details) keeps the original story.
    const again = await ctx.repo.playerFlags.set(other.id, { watchlist: true }, { userId: null, name: "importer" });
    assert.equal(again.watchReason, "griefing");
    assert.equal(again.watchBy, "OldAdmin");

    // Unwatching closes the record: flag off, current-row provenance gone.
    const off = await jsonFetch(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ watchlist: false }) });
    assert.equal(off.body.flags.watchlist, false);
    assert.equal(off.body.flags.watchReason, null);
    assert.equal(off.body.flags.watchBy, null);
    assert.equal(off.body.flags.watchAt, null);

    // ...but the story is NOT lost: the spell lives on in the permanent watch history, closed
    // with who removed it — and a later re-watch stacks a second spell on top.
    await jsonFetch(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ watchlist: true, reason: "back at it" }) });
    const prof = await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth });
    const hist = prof.body.watchHistory as any[];
    assert.equal(hist.length, 2, "both spells kept forever");
    assert.equal(hist[0].reason, "back at it");
    assert.equal(hist[0].removedAt, null, "current spell is open");
    assert.equal(hist[1].reason, "team-killing on seed");
    assert.equal(hist[1].removedBy, "admin");
    assert.ok(hist[1].removedAt, "old spell closed, not deleted");
  });
});

test("note body is required", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000003", name: "X" });
    const bad = await jsonFetch(`${base}/api/players/${player.id}/notes`, { method: "POST", headers: auth, body: JSON.stringify({ body: "  " }) });
    assert.equal(bad.status, 400);
  });
});

test("player identity: the same platform id converges on ONE row regardless of platform string", async () => {
  const repo = await createRepository();
  // The live roster reports the game's platform; kill ingest infers "other" for a 32-hex id.
  // Both must land on the same player — this exact mismatch used to fork kills away from the
  // profile the roster kept fresh.
  const fromRoster = await repo.players.upsert({ game: "hll", platform: "epic", platformId: "9ab6d265061977a91c76f151fca7feb0", name: "PIZZAROLL" });
  const fromKill = await repo.players.upsert({ game: "hll", platform: "other", platformId: "9ab6d265061977a91c76f151fca7feb0", name: "PIZZAROLL" });
  assert.equal(fromKill.id, fromRoster.id);
  assert.equal(fromKill.platform, "epic"); // the real platform is kept, not downgraded to "other"

  // Reversed order: an "other" placeholder upgrades when the roster later reports the truth.
  const first = await repo.players.upsert({ game: "hll", platform: "other", platformId: "aab6d265061977a91c76f151fca7feb0", name: "X" });
  const second = await repo.players.upsert({ game: "hll", platform: "xbl", platformId: "aab6d265061977a91c76f151fca7feb0", name: "X" });
  assert.equal(second.id, first.id);
  assert.equal(second.platform, "xbl");

  // Stats bumped via either path accrue on the single row (same server, so one stats row too).
  const srv = await repo.servers.create({ name: "Ident", host: "1.1.1.1", port: 28961, password: "p" });
  await repo.stats.bump(fromRoster.id, srv.id, { kills: 3 });
  await repo.stats.bump(fromKill.id, srv.id, { deaths: 1 });
  const s = await repo.stats.get(fromRoster.id);
  assert.equal(s?.kills, 3);
  assert.equal(s?.deaths, 1);
});

test("directory filters: platform, last-seen window, watched-only, sort; rows are enriched", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const older = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000021", name: "OldTimer", ts: "2025-01-05T00:00:00.000Z" });
    const recent = await ctx.repo.players.upsert({ game: "hll", platform: "epic", platformId: "9ab6d265061977a91c76f151fca7feb1", name: "Fresh", ts: "2026-07-01T00:00:00.000Z" });
    const dirSrv = await ctx.repo.servers.create({ name: "Dir", host: "1.1.1.1", port: 28962, password: "p" });
    await ctx.repo.stats.bump(recent.id, dirSrv.id, { kills: 7, visits: 2, playtimeSec: 7200 });
    await ctx.repo.playerFlags.set(older.id, { watchlist: true }, { userId: null, name: "test" });

    // Enriched rows: stats + flags ride on the directory listing itself.
    const all = await jsonFetch(`${base}/api/players?limit=50`, { headers: auth });
    const freshRow = (all.body.players as any[]).find((p) => p.id === recent.id);
    assert.equal(freshRow.kills, 7);
    assert.equal(freshRow.playtimeSec, 7200);
    assert.equal(freshRow.watchlist, false);
    assert.equal((all.body.players as any[]).find((p) => p.id === older.id).watchlist, true);

    // Platform filter.
    const epicOnly = await jsonFetch(`${base}/api/players?platform=epic`, { headers: auth });
    assert.ok((epicOnly.body.players as any[]).every((p) => p.platform === "epic"));
    assert.ok((epicOnly.body.players as any[]).some((p) => p.id === recent.id));

    // Last-seen window keeps only players seen inside it.
    const windowed = await jsonFetch(`${base}/api/players?seenFrom=2026-01-01T00:00:00.000Z`, { headers: auth });
    assert.ok((windowed.body.players as any[]).some((p) => p.id === recent.id));
    assert.ok(!(windowed.body.players as any[]).some((p) => p.id === older.id));

    // Watched-only.
    const watched = await jsonFetch(`${base}/api/players?watched=1`, { headers: auth });
    assert.ok((watched.body.players as any[]).every((p) => p.watchlist === true));
    assert.ok((watched.body.players as any[]).some((p) => p.id === older.id));

    // Sort by kills puts the scorer first.
    const byKills = await jsonFetch(`${base}/api/players?sort=kills&limit=5`, { headers: auth });
    assert.equal((byKills.body.players as any[])[0].id, recent.id);

    // Perma-banned-only rides the ban DECISIONS (player_ban), not the imported archive: an active
    // perma keeps the player in, and a crcon_ban archive row alone does not count — the archive is
    // history, the decision table is the record.
    await ctx.repo.playerBans.create({ game: "hll", playerId: recent.platformId, playerName: "Fresh", kind: "perma", reason: "x", category: null, scope: { mode: "all" }, expiresAt: null, createdByUserId: null, createdByName: "t" });
    await ctx.repo.crconBans.upsert({ serverId: dirSrv.id, playerId: older.platformId, playerName: "OldTimer", type: "perma", reason: "x", expiresAt: null, author: "t" });
    const pb = await jsonFetch(`${base}/api/players?permaBanned=1`, { headers: auth });
    assert.ok((pb.body.players as any[]).some((p) => p.id === recent.id), "an active perma decision keeps the player in");
    assert.ok(!(pb.body.players as any[]).some((p) => p.id === older.id), "an archive row alone does not count");
  });
});

test("searching ranks the exact name first, however stale the player", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    // The real complaint, reproduced: dozens of Sgt Peppers seen five minutes ago, and the player
    // literally named Pepper last seen a year ago. Last-seen order buried the exact match at the
    // bottom of the list.
    await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000101", name: "Pepper", ts: "2025-05-14T00:00:00.000Z" });
    await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000102", name: "Pepper8560", ts: "2026-08-01T00:00:00.000Z" });
    for (let i = 0; i < 5; i++) {
      await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656119800000011${i}`, name: `Sgt Pepper ${i}`, ts: new Date().toISOString() });
    }
    const r = await jsonFetch(`${base}/api/players?q=pepper`, { headers: auth });
    const names = (r.body.players as any[]).map((p) => p.name);
    assert.equal(names[0], "Pepper", `the exact match tops the list: ${names.join(", ")}`);
    assert.equal(names[1], "Pepper8560", "then names that START with the search");
    assert.ok(names.slice(2).every((n: string) => n.startsWith("Sgt")), "substring matches follow");
  });
});

test("directory pages: every player is reachable, exactly once", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    // 25 players who all tie on the default sort (same last-seen instant). Ties are where naive
    // paging breaks: without a total order the database may return them in any order per query, so
    // a row can appear on two pages while another is never returned at all.
    const ts = "2026-05-05T00:00:00.000Z";
    for (let i = 0; i < 25; i++) {
      await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656119800000${String(i).padStart(4, "0")}`, name: `Tied${i}`, ts });
    }

    const first = await jsonFetch(`${base}/api/players?limit=10&offset=0`, { headers: auth });
    assert.equal((first.body.players as any[]).length, 10);
    assert.equal(first.body.total, 25, "total counts every match, not the page");

    const seen = new Set<string>();
    for (let offset = 0; offset < 25; offset += 10) {
      const page = await jsonFetch(`${base}/api/players?limit=10&offset=${offset}`, { headers: auth });
      for (const p of page.body.players as any[]) {
        assert.ok(!seen.has(p.id), `player ${p.name} appeared on two pages`);
        seen.add(p.id);
      }
    }
    assert.equal(seen.size, 25, "paging reached every player exactly once");
  });
});

test("the total describes the filtered set, so paging knows when to stop", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    for (let i = 0; i < 8; i++) {
      await ctx.repo.players.upsert({ game: "hll", platform: i < 3 ? "epic" : "steam", platformId: `id-page-${i}`, name: `P${i}` });
    }
    const all = await jsonFetch(`${base}/api/players?limit=100`, { headers: auth });
    assert.equal(all.body.total, 8);

    // With a filter on, the total must describe the FILTERED set — otherwise "Load more" offers a
    // page that doesn't exist, or hides one that does.
    const epic = await jsonFetch(`${base}/api/players?platform=epic&limit=2`, { headers: auth });
    assert.equal(epic.body.total, 3, "total follows the filter");
    assert.equal((epic.body.players as any[]).length, 2, "but the page respects the limit");

    const rest = await jsonFetch(`${base}/api/players?platform=epic&limit=2&offset=2`, { headers: auth });
    assert.equal((rest.body.players as any[]).length, 1, "the last page is the remainder");
    assert.ok((rest.body.players as any[]).every((p: any) => p.platform === "epic"));
  });
});

test("directory sort reverses, and the order holds across pages", async () => {
  // The directory pages, so it cannot sort in the browser: sorting the fetched rows would order
  // one page and label it "the top players". The database orders the whole result, which means
  // the direction has to travel with the column — it previously did not, so a second click on a
  // header had nothing to reverse.
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const sortSrv = await ctx.repo.servers.create({ name: "Sort", host: "1.1.1.1", port: 28963, password: "p" });
    for (let i = 0; i < 25; i++) {
      const p = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656119000000${1000 + i}`, name: `S${String(i).padStart(2, "0")}` });
      await ctx.repo.stats.bump(p.id, sortSrv.id, { kills: i });
    }
    const names = async (qs: string) => {
      const r = await jsonFetch(`${base}/api/players?${qs}`, { headers: auth });
      return (r.body.players as { name: string }[]).map((p) => p.name);
    };

    const desc = await names("sort=kills&sortDir=desc&limit=25");
    const asc = await names("sort=kills&sortDir=asc&limit=25");
    assert.equal(desc[0], "S24", "descending puts the most kills first");
    assert.equal(asc[0], "S00", "ascending reverses it");
    assert.deepEqual(asc, [...desc].reverse());

    const p1 = await names("sort=kills&sortDir=desc&limit=10&offset=0");
    const p2 = await names("sort=kills&sortDir=desc&limit=10&offset=10");
    assert.deepEqual([...p1, ...p2], desc.slice(0, 20), "page two continues the order, it doesn't restart");
    assert.equal(new Set([...p1, ...p2]).size, 20, "no row appears on both pages");

    // Columns that had no server-side sort before, so their headers could not have been clickable.
    assert.deepEqual((await names("sort=name&sortDir=asc&limit=3")), ["S00", "S01", "S02"]);
    assert.equal((await jsonFetch(`${base}/api/players?sort=teamkills&sortDir=asc`, { headers: auth })).status, 200);
    assert.equal((await jsonFetch(`${base}/api/players?sort=platform&sortDir=desc`, { headers: auth })).status, 200);
    // An unknown column is ignored rather than 500ing on a hand-typed URL.
    assert.equal((await jsonFetch(`${base}/api/players?sort=nonsense`, { headers: auth })).status, 200);
  });
});

test("the activity feed answers to server grants: chat on a server you cannot view is not yours to read", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const alpha = await ctx.repo.servers.create({ name: "Alpha", host: "h", port: 51, password: "p" });
    const bravo = await ctx.repo.servers.create({ name: "Bravo", host: "h", port: 52, password: "p" });
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000950", name: "Talker" });
    const t0 = Date.parse("2026-02-01T00:00:00Z");
    await ctx.repo.events.insert([
      { serverId: alpha.id, ts: new Date(t0).toISOString(), kind: "evt.kill", actorPlayerId: player.id, actorName: "Talker", dedupeKey: "sc-kill-a" },
      // What this person said, and what was done to them, on the server the reader holds nothing on.
      { serverId: bravo.id, ts: new Date(t0 + 1000).toISOString(), kind: "evt.chat.team", actorPlayerId: player.id, actorName: "Talker", dedupeKey: "sc-chat-b" },
      { serverId: bravo.id, ts: new Date(t0 + 2000).toISOString(), kind: "evt.kill", actorPlayerId: player.id, actorName: "Talker", dedupeKey: "sc-kill-b" },
    ]);
    // Sessions too: per-server presence, the same rule as the career rows beside them.
    await ctx.repo.stats.bump(player.id, alpha.id, { kills: 1 });
    await ctx.repo.stats.bump(player.id, bravo.id, { kills: 2 });

    // Staff trusted with ALPHA alone.
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "alpha-eyes", password: "pw" }) });
    await jsonFetch(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ grants: [{ capability: "server.view", level: "read", scopeType: "server", scopeId: alpha.id }] }),
    });
    const l = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "alpha-eyes", password: "pw" }) });
    const scoped = { authorization: `Bearer ${l.body.token as string}` };

    // The paged feed: Alpha's kill only — and the TOTAL says so too, not just the page.
    const feed = await jsonFetch(`${base}/api/players/${player.id}/events`, { headers: scoped });
    assert.equal(feed.status, 200);
    assert.equal(feed.body.total, 1, "the count is bounded by the same rule as the rows");
    assert.deepEqual((feed.body.events as any[]).map((e) => e.dedupeKey), ["sc-kill-a"]);

    // Naming the other server directly is refused outright — not answered with a quiet empty page,
    // which would still confirm the server exists. Same answer the admin-camera history gives.
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/events?serverId=${bravo.id}`, { headers: scoped })).status, 403);

    // The profile's own recent feed is held to it as well.
    const prof = await jsonFetch(`${base}/api/players/${player.id}`, { headers: scoped });
    assert.equal(prof.status, 200);
    assert.deepEqual((prof.body.recentEvents as any[]).map((e) => e.dedupeKey), ["sc-kill-a"]);
    assert.deepEqual((prof.body.statsByServer as any[]).map((r) => r.serverId), [alpha.id], "careers were already scoped — still are");

    // And somebody who may see both still sees both, on both surfaces.
    const ownerFeed = await jsonFetch(`${base}/api/players/${player.id}/events`, { headers: auth });
    assert.equal(ownerFeed.body.total, 3);
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/events?serverId=${bravo.id}`, { headers: auth })).body.total, 2);
  });
});

/*
 * A server's VIP list, its console admins and who is on it right now each answer to a permission
 * held on THAT server, and their own pages ask it per server. The profile, the VIP history and the
 * VIP integrity check asked it anywhere and then answered for every server, so staff trusted with
 * one server read another's VIP (with what was paid for it), its admins, and that the player was on
 * it at that moment. The disciplinary record stays community-wide, as the profile already says.
 */
test("a profile's VIP, console admins, online servers, VIP history and integrity answer per server", async () => {
  await withServer(async (base, ctx) => {
    const repo = ctx.repo;
    const auth = await ownerAuth(base);
    const owner = await repo.users.findByUsername("admin");
    const alpha = await repo.servers.create({ name: "Alpha", host: "h", port: 61, password: "p" });
    const bravo = await repo.servers.create({ name: "Bravo", host: "h", port: 62, password: "p" });
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000960", name: "Donor" });
    for (const s of [alpha, bravo]) {
      await repo.vips.upsert({ serverId: s.id, playerId: player.platformId, playerName: "Donor", comment: `paid on ${s.name}`, expiration: null, createdByUserId: owner!.id, createdByName: "admin" });
      await repo.consoleAdmins.upsert({ serverId: s.id, playerId: player.platformId, playerName: "Donor", adminGroup: "junior", createdByName: "admin" });
      await repo.audit.create({ actorUserId: owner!.id, actorName: "admin", action: "vip.grant", targetType: "player", targetId: player.platformId, targetName: "Donor", serverId: s.id, summary: `granted VIP on ${s.name}`, data: { playerId: player.platformId, expiration: null, comment: `paid on ${s.name}` } });
    }
    // A permanent grant on record whose row is gone, on each server: the integrity check finds both.
    const lost = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000961", name: "Lost" });
    for (const s of [alpha, bravo]) {
      await repo.audit.create({ actorUserId: owner!.id, actorName: "admin", action: "vip.grant", targetType: "player", targetId: lost.platformId, targetName: "Lost", serverId: s.id, summary: "granted VIP", data: { playerId: lost.platformId, expiration: null } });
    }
    await repo.sessions.open(player.id, bravo.id, new Date(Date.now() - 60_000).toISOString());

    // Staff trusted with ALPHA alone, with every one of those pages there.
    const u = await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "alpha-staff", password: "pw" }) });
    await jsonFetch(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ grants: ["server.view", "vip.grant", "server.admins"].map((capability) => ({ capability, level: "read", scopeType: "server", scopeId: alpha.id })) }),
    });
    const l = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "alpha-staff", password: "pw" }) });
    const scoped = { authorization: `Bearer ${l.body.token as string}` };

    const servers = (rows: { serverId: string | null }[]) => rows.map((r) => r.serverId).sort();
    const prof = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: scoped })).body;
    assert.deepEqual(servers(prof.vipStatus), [alpha.id], "VIP on the server they may see, and only there");
    assert.deepEqual(servers(prof.consoleAdminStatus), [alpha.id]);
    assert.equal(prof.onlineNow, false, "on a server they cannot see is not online to them");
    assert.deepEqual(prof.onlineServers, []);
    const history = (await jsonFetch(`${base}/api/players/${player.id}/vip-history`, { headers: scoped })).body.history;
    assert.deepEqual(servers(history), [alpha.id]);
    const findings = (await jsonFetch(`${base}/api/vips/integrity`, { headers: scoped })).body.findings;
    assert.deepEqual(servers(findings), [alpha.id]);

    // Whoever may see both still sees both.
    const full = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth })).body;
    assert.deepEqual(servers(full.vipStatus), [alpha.id, bravo.id].sort());
    assert.deepEqual(servers(full.consoleAdminStatus), [alpha.id, bravo.id].sort());
    assert.equal(full.onlineNow, true);
    assert.deepEqual(servers((await jsonFetch(`${base}/api/players/${player.id}/vip-history`, { headers: auth })).body.history), [alpha.id, bravo.id].sort());
    assert.deepEqual(servers((await jsonFetch(`${base}/api/vips/integrity`, { headers: auth })).body.findings), [alpha.id, bravo.id].sort());
  });
});

test("the profile's activity feed pages over the WHOLE history, filterable by kind and server", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const s1 = await ctx.repo.servers.create({ name: "A", host: "h", port: 1, password: "p" });
    const s2 = await ctx.repo.servers.create({ name: "B", host: "h", port: 2, password: "p" });
    const player = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000900", name: "Busy" });

    // 60 kills on server A (more than one page), one chat line on server B.
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    await ctx.repo.events.insert(Array.from({ length: 60 }, (_, i) => ({
      serverId: s1.id, ts: new Date(t0 + i * 60_000).toISOString(), kind: "evt.kill",
      actorPlayerId: player.id, actorName: "Busy", dedupeKey: `feed-${i}`,
    })));
    await ctx.repo.events.insert([{ serverId: s2.id, ts: new Date(t0).toISOString(), kind: "evt.chat.team", actorPlayerId: player.id, actorName: "Busy", dedupeKey: "feed-chat" }]);

    // Page one, then page two — no overlap, and the total spans everything, not a recent slice.
    const p1 = await jsonFetch(`${base}/api/players/${player.id}/events?limit=50`, { headers: auth });
    assert.equal(p1.status, 200);
    assert.equal(p1.body.total, 61);
    assert.equal((p1.body.events as any[]).length, 50);
    const p2 = await jsonFetch(`${base}/api/players/${player.id}/events?limit=50&offset=50`, { headers: auth });
    assert.equal((p2.body.events as any[]).length, 11);
    const seen = new Set([...(p1.body.events as any[]), ...(p2.body.events as any[])].map((e) => e.id));
    assert.equal(seen.size, 61, "two pages cover the history exactly once");

    // Kind and server filters narrow the TOTAL, not just the page.
    const kills = await jsonFetch(`${base}/api/players/${player.id}/events?kinds=evt.kill&limit=10`, { headers: auth });
    assert.equal(kills.body.total, 60);
    const chatOnB = await jsonFetch(`${base}/api/players/${player.id}/events?serverId=${s2.id}`, { headers: auth });
    assert.equal(chatOnB.body.total, 1);
    assert.equal((chatOnB.body.events as any[])[0].kind, "evt.chat.team");

    // Auth required; unknown player 404s.
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/events`)).status, 401);
    assert.equal((await jsonFetch(`${base}/api/players/nope/events`, { headers: auth })).status, 404);
  });
});

/*
 * The profile was the back door into three gated pages.
 *
 * A Viewer cannot open Moderation → Bans or Players → VIPs. They could open any player's profile
 * and read both out of one payload: the ban and its reason, every active ban decision, every VIP
 * grant and who paused it, plus the watchlist reason and who set it. The capabilities existed and
 * were enforced on their own pages; this one never asked.
 *
 * Gated at the API, not in the component: a hidden panel whose data is still in the JSON is a
 * tidier screen, not a boundary. So the assertion is about the PAYLOAD, which is the only version
 * of this that means anything.
 */
test("player profile withholds ban, VIP and watch detail from someone who cannot open those pages", async () => {
  await withServer(async (base, ctx) => {
    const repo = ctx.repo;
    const owner = await ownerAuth(base);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "700700700700700", name: "Subject" });
    await repo.playerFlags.set(player.id, { watchlist: true, watchReason: "suspected of walling" }, { userId: null, name: "Head Admin" });
    await repo.audit.create({ actorName: "admin", action: "player.permaban", targetType: "player", targetId: player.platformId, targetName: "Subject", summary: "cheating", data: { reason: "cheating" } });
    await repo.playerBans.create({ game: "hll", playerId: player.platformId, playerName: "Subject", kind: "perma", reason: "aimbot", category: "cheating", scope: { mode: "all" }, expiresAt: null, createdByUserId: null, createdByName: "admin" });

    // The owner holds "*" and sees everything — otherwise this test could pass by breaking the page.
    const full = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: owner })).body;
    assert.equal(full.canViewBans, true);
    assert.ok(full.banStatus.permaBan, "the owner sees the ban");
    assert.equal(full.banDecisions.length, 1);
    assert.equal(full.banDecisions[0].category, "cheating");
    assert.equal(full.canViewWatch, true);
    assert.equal(full.flags.watchReason, "suspected of walling");

    // A Viewer: server.view and nothing else.
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "looker", password: "pw" }) });
    const u = await repo.users.findByUsername("looker");
    await repo.grants.create({ userId: u!.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "looker", password: "pw" }) });
    const viewer = { authorization: `Bearer ${login.body.token as string}` };

    const seen = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: viewer })).body;
    assert.equal(seen.canViewBans, false);
    assert.equal(seen.banStatus, undefined, "no ban record in the payload at all");
    assert.equal(seen.banDecisions, undefined, "the decisions share the Bans page's gate");
    assert.equal(seen.canViewVip, false);
    assert.equal(seen.vipStatus, undefined);
    assert.equal(seen.canViewModeration, false);
    assert.equal(seen.moderation, undefined);
    // The eye mark stays — the live roster shows it to anyone who can see the roster, so hiding it
    // here would only make the profile disagree with the page they clicked through from. What goes
    // is the staff note attached to it.
    assert.equal(seen.canViewWatch, false);
    assert.equal(seen.flags.watchlist, true, "the marker survives");
    assert.equal(seen.flags.watchReason, null, "the reason does not");
    assert.equal(seen.flags.watchBy, null);
    assert.equal(seen.watchHistory, undefined);
    // And the profile still works: the parts a Viewer is meant to see are all there.
    assert.equal(seen.player.name, "Subject");
    assert.ok(Array.isArray(seen.recentEvents));

    // One capability at a time restores exactly its own block and nothing else.
    await repo.grants.create({ userId: u!.id, capability: "vip.grant", scopeType: "global", scopeId: null, level: "read" });
    const withVip = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: viewer })).body;
    assert.equal(withVip.canViewVip, true);
    assert.ok(Array.isArray(withVip.vipStatus));
    assert.equal(withVip.canViewBans, false, "vip.grant does not unlock the ban record");
    assert.equal(withVip.banStatus, undefined);
  });
});

/*
 * The marks at the top of a profile are for what holds now — ⛔ and ⏱ for the bans the ban record
 * counts as active, ★ for VIP still running — read from the same record the Bans and VIPs pages
 * read. The ban marks came from the trail's newest ban or unban instead, which the record outlives
 * both ways: Lift all lifts every decision with one row for the server and no unban for each
 * player, and a temp ban the ban sync put back on the game was logged without its hours, so it
 * never ran out. Profiles went on marking players banned whose bans the Bans page listed as lifted
 * and expired. And VIP that had run out read as VIP until the sweep took its row away — which, on
 * a server in observe mode, it never does.
 */
test("a profile marks only the bans and VIP that hold now, as the Bans and VIPs pages count them", async () => {
  await withServer(async (base, ctx) => {
    const repo = ctx.repo;
    const owner = await ownerAuth(base);
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const day = 86_400_000;
    const mk = (platformId: string, name: string) => repo.players.upsert({ game: "hll", platform: "steam", platformId, name });
    const ban = (pl: { platformId: string }, kind: "temp" | "perma", expiresAt: string | null, game = "hll") =>
      repo.playerBans.create({ game, playerId: pl.platformId, playerName: null, kind, reason: `${kind} reason`, category: null, scope: { mode: "all" }, expiresAt, createdByUserId: null, createdByName: "admin" });
    const logged = (pl: { platformId: string }, action: string, data: Record<string, unknown>) =>
      repo.audit.create({ actorName: "admin", action, targetType: "player", targetId: pl.platformId, summary: action, data });
    const marks = async (pl: { id: string }) => {
      const body = (await jsonFetch(`${base}/api/players/${pl.id}`, { headers: owner })).body;
      return { perma: body.banStatus.permaBan?.reason ?? null, temp: body.banStatus.tempBan?.expiresAt ?? null };
    };

    // Lifted with Lift all: the record says lifted, and the trail still ends with the ban.
    const lifted = await mk("800000000000001", "Lifted");
    await logged(lifted, "player.permaban", { reason: "cheating" });
    await repo.playerBans.lift((await ban(lifted, "perma", null)).id, "admin");
    assert.deepEqual(await marks(lifted), { perma: null, temp: null }, "a lifted ban is no mark");
    // Put back on the game by the ban sync, logged without hours, and run out since.
    const ranOut = await mk("800000000000002", "RanOut");
    await logged(ranOut, "player.tempban", { reconcile: true });
    await ban(ranOut, "temp", at(-day));
    assert.deepEqual(await marks(ranOut), { perma: null, temp: null }, "a temp ban that ran out is no mark");
    // Active on the record with nothing in the trail — adopted from the game's own list — is marked,
    // with the record's own end.
    const banned = await mk("800000000000003", "Banned");
    const until = at(2 * day);
    await ban(banned, "perma", null);
    await ban(banned, "temp", until);
    await ban(banned, "temp", at(day));
    assert.deepEqual(await marks(banned), { perma: "perma reason", temp: until }, "of two temp bans, the one that holds longest");
    // A ban on the same id in the other game is that game's account's, not this one's.
    const elsewhere = await mk("800000000000004", "Elsewhere");
    await ban(elsewhere, "perma", null, "hllv");
    assert.deepEqual(await marks(elsewhere), { perma: null, temp: null });

    // VIP: for good, still running, and frozen by a banked pause past its date are VIP; run out is not.
    const vipper = await mk("800000000000005", "Vipper");
    const servers = await Promise.all(["Forever", "Running", "RunOut", "Banked"].map((name, i) => repo.servers.create({ name, host: "h", port: 81 + i, password: "p" })));
    const ends = [null, at(day), at(-3_600_000), at(-3_600_000)];
    for (const [i, s] of servers.entries()) {
      await repo.vips.upsert({ serverId: s.id, playerId: vipper.platformId, playerName: "Vipper", comment: "paid", expiration: ends[i]!, createdByUserId: null, createdByName: "admin" });
    }
    await repo.vips.setPause(servers[3]!.id, vipper.platformId, { until: at(day), reason: "teamkilling", by: "admin", mode: "banked" });
    const vip = (await jsonFetch(`${base}/api/players/${vipper.id}`, { headers: owner })).body.vipStatus as { serverName: string }[];
    assert.deepEqual(vip.map((v) => v.serverName).sort(), ["Banked", "Forever", "Running"]);
  });
});

/*
 * Which Discord and platform accounts a player record is linked to is who the player IS, and it
 * answers to Player identity links: read sees them, and the same person's rows in other games.
 * Nothing else does — the watchlist, which used to gate the panel showing them, included.
 */
test("player profile shows linked accounts only to Player identity links", async () => {
  await withServer(async (base, ctx) => {
    const repo = ctx.repo;
    const owner = await ownerAuth(base);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "700700700700701", name: "Linked" });
    await repo.externalLinks.set(player.id, "discord", "123456789012345670", "test");
    const full = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: owner })).body;
    assert.equal(full.canViewLinks, true);
    assert.equal((full.links as { provider: string; externalId: string }[]).find((l) => l.provider === "discord")?.externalId, "123456789012345670");

    await jsonFetch(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "watcher", password: "pw" }) });
    const u = await repo.users.findByUsername("watcher");
    await repo.grants.create({ userId: u!.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
    await repo.grants.create({ userId: u!.id, capability: "player.watchlist", scopeType: "global", scopeId: null, level: "write" });
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "watcher", password: "pw" }) });
    const watcher = { authorization: `Bearer ${login.body.token as string}` };
    const seen = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: watcher })).body;
    assert.equal(seen.canViewLinks, false);
    assert.equal(seen.links, undefined, "the watchlist does not show who a player is linked to");
    assert.equal(seen.sameAccount, undefined);
    assert.equal(seen.player.name, "Linked", "the rest of the profile is there");

    await repo.grants.create({ userId: u!.id, capability: "player.links", scopeType: "global", scopeId: null, level: "read" });
    const reader = (await jsonFetch(`${base}/api/players/${player.id}`, { headers: watcher })).body;
    assert.equal(reader.canViewLinks, true);
    assert.equal((reader.links as unknown[]).length, 1);
    // Read is not write: a change is sent for approval, and nothing changes until it is approved.
    const changed = await jsonFetch(`${base}/api/players/${player.id}/links`, { method: "PATCH", headers: watcher, body: JSON.stringify({ provider: "discord", externalId: "123456789012345671" }) });
    assert.equal(changed.status, 202, "filed as a request");
    assert.equal((await repo.externalLinks.list(player.id))[0]?.externalId, "123456789012345670");
  });
});

test("an external identity belongs to one player: relinking elsewhere is refused until cleared", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    const first = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000031", name: "First Holder" });
    const second = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000032", name: "Second Claimant" });
    const link = (playerId: string, externalId: string | null) =>
      jsonFetch(`${base}/api/players/${playerId}/links`, { method: "PATCH", headers: auth, body: JSON.stringify({ provider: "discord", externalId }) });

    assert.equal((await link(first.id, "123456789012345678")).status, 200);
    // Same id on a different player: refused, naming the current holder — otherwise every reverse
    // lookup from here on picks a player at random.
    const clash = await link(second.id, "123456789012345678");
    assert.equal(clash.status, 409);
    assert.match(clash.body.error.message, /First Holder/);
    // Re-setting on the SAME player is fine (it is an update, not a second holder)…
    assert.equal((await link(first.id, "123456789012345678")).status, 200);
    // …and once the holder clears it, the other player may take it.
    assert.equal((await link(first.id, null)).status, 200);
    assert.equal((await link(second.id, "123456789012345678")).status, 200);
    assert.equal((await ctx.repo.externalLinks.findPlayers("discord", "123456789012345678")).length, 1);
  });
});

/*
 * Every FIRST link pays the registration welcome, whoever makes it: the member with the in-game
 * code, staff from Discord, and — the one that never did — staff from this panel. And an account is
 * paid once, however its link is made, remade or moved: the three paths share one key.
 */
test("a panel Discord link pays the registration welcome on the first link, once per account", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    await ctx.repo.economy.setConfig({ registration: { bonusDays: 0, bonusPoints: 150, bonusAllGames: false } });
    const one = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000051", name: "Welcome One" });
    const two = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000052", name: "Welcome Two" });
    const link = (playerId: string, externalId: string | null) =>
      jsonFetch(`${base}/api/players/${playerId}/links`, { method: "PATCH", headers: auth, body: JSON.stringify({ provider: "discord", externalId }) });

    const member = "323456789012345678";
    const first = await link(one.id, member);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.welcome, ["150 Points"], "the response says what was paid");
    assert.equal((await ctx.repo.economy.member(member))?.balance, 150);
    const row = (await ctx.repo.audit.list({ limit: 20 })).find((a) => a.action === "player.link");
    assert.match(row!.summary, /welcome bonus paid: 150 Points/, "and so does the trail");

    // Saving the same link again is not a new link.
    const again = await link(one.id, member);
    assert.equal(again.body.welcome, undefined);
    // Moving it to another account of the same game: the Discord account was already welcomed.
    await link(one.id, null);
    const moved = await link(two.id, member);
    assert.equal(moved.body.welcome, undefined);
    assert.equal((await ctx.repo.economy.member(member))?.balance, 150, "paid exactly once");

    // An account the in-game code or the Discord staff panel already welcomed is not paid again
    // here: the welcome's ledger ref is shared by every way of linking.
    const elsewhere = "423456789012345678";
    await ctx.repo.economy.ensureMember(elsewhere);
    await ctx.repo.economy.apply({ discordId: elsewhere, delta: 150, reason: "welcome: linked account", ref: `bonus:${elsewhere}`, actorName: "registration" });
    const three = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000053", name: "Welcome Three" });
    const late = await link(three.id, elsewhere);
    assert.equal(late.status, 200);
    assert.equal(late.body.welcome, undefined);
    assert.equal((await ctx.repo.economy.member(elsewhere))?.balance, 150);
  });
});

/*
 * With the Economy page's "pay once per game" on, a panel link follows it exactly as the in-game
 * code and Discord staff linking do: a Hell Let Loose account and then a Vietnam account linked to
 * one Discord collect a welcome each, and another account of a game already paid collects nothing.
 */
test("with bonusPerGame on, a panel Discord link pays the welcome once per game", async () => {
  await withServer(async (base, ctx) => {
    const auth = await ownerAuth(base);
    await ctx.repo.economy.setConfig({ registration: { bonusDays: 0, bonusPoints: 150, bonusAllGames: false, bonusPerGame: true } });
    const ww2 = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000061", name: "PerGame WW2" });
    const ww2Alt = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000062", name: "PerGame WW2 Alt" });
    const vn = await ctx.repo.players.upsert({ game: "hllv", platform: "steam", platformId: "0002a-vn-000061", name: "PerGame VN" });
    const link = (playerId: string, externalId: string | null) =>
      jsonFetch(`${base}/api/players/${playerId}/links`, { method: "PATCH", headers: auth, body: JSON.stringify({ provider: "discord", externalId }) });

    const member = "523456789012345678";
    const first = await link(ww2.id, member);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.welcome, ["150 Points"], "the first game pays");
    assert.equal((await ctx.repo.economy.member(member))?.balance, 150);

    // The second game is its own welcome: the whole point of the setting.
    const second = await link(vn.id, member);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.welcome, ["150 Points"], "the Vietnam link pays again");
    assert.equal((await ctx.repo.economy.member(member))?.balance, 300);

    // Moving the WW2 link to another WW2 account: that game was already paid.
    await link(ww2.id, null);
    const moved = await link(ww2Alt.id, member);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.welcome, undefined, "the same game never pays twice");
    assert.equal((await ctx.repo.economy.member(member))?.balance, 300);
  });
});

