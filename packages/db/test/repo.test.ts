import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { InMemoryRepository, toPublicServer, kindsForCategories, banScopeCovers, automationEnabled, isPermanentKvKey, computeKd, PERMANENT_KV_PREFIX, ECONOMY_LEDGER_PAGE, ECONOMY_ACTIVITY_KINDS, economyActivityKind } from "../dist/index.js";
import type { BanScopeJson, CrconPlayerCache } from "../dist/index.js";

test("users: create, find, unique username, count", async () => {
  const repo = new InMemoryRepository();
  assert.equal(await repo.users.count(), 0);
  const u = await repo.users.create({ username: "Owner", passwordHash: "h" });
  assert.equal(await repo.users.count(), 1);
  assert.equal((await repo.users.findById(u.id))?.username, "Owner");
  assert.equal((await repo.users.findByUsername("owner"))?.id, u.id); // case-insensitive
  await assert.rejects(() => repo.users.create({ username: "owner", passwordHash: "x" }), /already exists/);
});

test("tokens: stored by hash and retrievable", async () => {
  const repo = new InMemoryRepository();
  const u = await repo.users.create({ username: "u", passwordHash: "h" });
  await repo.tokens.create({ userId: u.id, name: "launcher", tokenHash: "abc" });
  assert.equal((await repo.tokens.findByHash("abc"))?.userId, u.id);
  assert.equal(await repo.tokens.findByHash("nope"), null);
});

test("servers: default to observe mode; engagement mode toggles; secret is stripped for clients", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv 1", host: "1.2.3.4", port: 28865, password: "secret" });
  assert.equal(s.engagementMode, "observe"); // safe by default
  assert.equal(s.protocol, "binary-v2");
  assert.equal((toPublicServer(s) as Record<string, unknown>).password, undefined);

  const updated = await repo.servers.setEngagementMode(s.id, "active");
  assert.equal(updated?.engagementMode, "active");
  assert.equal((await repo.servers.list()).length, 1);
});

test("servers: retirement drops the row from the DEFAULT list and nowhere else", async () => {
  const repo = new InMemoryRepository();
  const live = await repo.servers.create({ name: "Live", host: "1.1.1.1", port: 1, password: "p" });
  const parked = await repo.servers.create({ name: "Parked", host: "1.1.1.2", port: 2, password: "p" });
  await repo.servers.setRetired(parked.id, true);
  // Fail closed: every consumer of the plain list — pickers, workers, Discord — loses it at once…
  assert.deepEqual((await repo.servers.list()).map((s) => s.name), ["Live"]);
  // …the Connections tab opts back in…
  assert.deepEqual((await repo.servers.list({ includeRetired: true })).map((s) => s.name).sort(), ["Live", "Parked"]);
  // …and history reads still resolve it by id, stamped with since-when.
  const row = await repo.servers.findById(parked.id);
  assert.equal(row?.name, "Parked");
  assert.ok(row?.retiredAt);
  // Bringing it back restores the default list exactly.
  await repo.servers.setRetired(parked.id, false);
  assert.equal((await repo.servers.list()).length, 2);
  void live;
});

test("servers: decommission is a second stamp, and the final purge spares user history", async () => {
  const repo = new InMemoryRepository();
  // The setup account is the FIRST user created, whoever registers later and with what grants.
  const first = await repo.users.create({ username: "founder", passwordHash: "h" });
  await repo.users.create({ username: "later-admin", passwordHash: "h" });
  assert.equal(await repo.users.firstUserId(), first.id);

  const s = await repo.servers.create({ name: "Old Faithful", host: "1.1.1.3", port: 3, password: "p" });
  await repo.servers.setRetired(s.id, true);
  const stamped = await repo.servers.setDecommissioned(s.id, true);
  assert.ok(stamped?.decommissionedAt, "the stamp says since when");
  assert.ok(stamped?.retiredAt, "decommissioning does not disturb the retire stamp");
  // Pure visibility fact: the store still lists it under includeRetired (the API filters per
  // reader — the store cannot know who is asking).
  assert.ok((await repo.servers.list({ includeRetired: true })).some((x) => x.id === s.id));
  const back = await repo.servers.setDecommissioned(s.id, false);
  assert.equal(back?.decommissionedAt, null);

  // keepUserHistory: careers and moderation events survive the purge; the rest of the history goes.
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000900", name: "Lifer" });
  await repo.stats.bump(p.id, s.id, { kills: 3 });
  await repo.events.insert([
    { serverId: s.id, ts: new Date().toISOString(), kind: "evt.player.banned", actorPlayerId: p.id, actorName: "Lifer", dedupeKey: "k1" },
    { serverId: s.id, ts: new Date().toISOString(), kind: "evt.kill", actorPlayerId: p.id, actorName: "Lifer", victimName: "Other", dedupeKey: "k2" },
  ]);
  const counts = await repo.crconSnapshot.purgeServerData(s.id, { keepUserHistory: true });
  assert.equal(counts.careers, 0, "the count is honest: no career row was taken");
  assert.equal(counts.events, 1, "only the non-moderation event went");
  assert.equal((await repo.stats.get(p.id, s.id))?.kills, 3);
  const kinds = (await repo.events.listByPlayer(p.id)).map((e) => e.kind);
  assert.deepEqual(kinds, ["evt.player.banned"]);
});

test("grants: created and listed per user", async () => {
  const repo = new InMemoryRepository();
  const u = await repo.users.create({ username: "mod", passwordHash: "h" });
  await repo.grants.create({ userId: u.id, capability: "server.kick", scopeType: "server", scopeId: "s1", level: "write" });
  const grants = await repo.grants.listByUser(u.id);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.level, "write");
});

test("players: upsert is idempotent by platform id and updates name/last-seen", async () => {
  const repo = new InMemoryRepository();
  const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765611980000001", name: "Theo" });
  const b = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765611980000001", name: "Theo2" });
  assert.equal(a.id, b.id);
  assert.equal((await repo.players.findById(a.id))?.name, "Theo2");
  assert.equal((await repo.players.list()).length, 1);
});

test("playerAliases: every seen name + clan tag is recorded with seen-count and time window", async () => {
  const repo = new InMemoryRepository();
  const t1 = "2026-01-01T00:00:00.000Z", t2 = "2026-02-01T00:00:00.000Z", t3 = "2026-03-01T00:00:00.000Z";
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "77", name: "OldName", clanTag: "AAA", ts: t1 });
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "77", name: "OldName", clanTag: "AAA", ts: t2 }); // same → bump
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "77", name: "NewName", clanTag: "BBB", ts: t3 }); // changed

  const aliases = await repo.playerAliases.list(p.id);
  const names = aliases.filter((a) => a.kind === "name");
  const clans = aliases.filter((a) => a.kind === "clan");
  assert.deepEqual(names.map((a) => a.value).sort(), ["NewName", "OldName"]);
  assert.deepEqual(clans.map((a) => a.value).sort(), ["AAA", "BBB"]);

  const old = names.find((a) => a.value === "OldName")!;
  assert.equal(old.seenCount, 2);
  assert.equal(old.firstSeen, t1);
  assert.equal(old.lastSeen, t2);

  // Empty clan tag (no clan) is not recorded as an alias.
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "77", name: "NewName", clanTag: "", ts: t3 });
  assert.equal((await repo.playerAliases.list(p.id)).filter((a) => a.kind === "clan").length, 2);
});

test("sessions + stats: connect/disconnect accumulate visits and playtime", async () => {
  const repo = new InMemoryRepository();
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "88", name: "Solo", ts: "2026-01-01T00:00:00.000Z" });

  // One full session of 90 minutes → 1 visit, 5400s playtime.
  await repo.sessions.open(p.id, "s1", "2026-01-02T10:00:00.000Z");
  await repo.stats.bump(p.id, "s1", { visits: 1 });
  const dur = await repo.sessions.close(p.id, "s1", "2026-01-02T11:30:00.000Z");
  assert.equal(dur, 5400);
  await repo.stats.bump(p.id, "s1", { playtimeSec: dur });

  // Closing with no open session yields 0 (no negative/erroneous playtime).
  assert.equal(await repo.sessions.close(p.id, "s1", "2026-01-02T12:00:00.000Z"), 0);

  const stats = await repo.stats.get(p.id);
  assert.equal(stats?.visits, 1);
  assert.equal(stats?.playtimeSec, 5400);

  // The closed session is kept in history; an unmatched close records nothing.
  const history = await repo.sessions.list(p.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.durationSec, 5400);
  assert.equal(history[0]?.connectedAt, "2026-01-02T10:00:00.000Z");
  assert.equal(history[0]?.disconnectedAt, "2026-01-02T11:30:00.000Z");
});

test("discord auth: link a user, find by discord id, list linked; role mapping resolves", async () => {
  const repo = new InMemoryRepository();
  // A Discord-provisioned user has no password and is role-managed.
  const u = await repo.users.create({ username: "DiscoStaff", discordId: "111", discordUsername: "Disco#1", discordManaged: true });
  assert.equal(u.passwordHash, null);
  assert.equal((await repo.users.findByDiscordId("111"))?.id, u.id);
  assert.equal((await repo.users.findByDiscordId("nope")), null);
  assert.deepEqual((await repo.users.listDiscordLinked()).map((x) => x.id), [u.id]);

  // A manual user with no Discord at all is not in the list.
  const manual = await repo.users.create({ username: "Manual", passwordHash: "h" });
  assert.equal(manual.discordManaged, false);
  assert.equal((await repo.users.listDiscordLinked()).length, 1);

  // linkDiscord attaches an identity to an existing account.
  const linked = await repo.users.linkDiscord(manual.id, { discordId: "222", username: "man2", nick: "Man #2", managed: false });
  assert.equal(linked?.discordId, "222");
  assert.equal((await repo.users.findByDiscordId("222"))?.id, manual.id);

  // A RENAME must not create a second account: identity is the discord id, names are cosmetic.
  await repo.users.linkDiscord(u.id, { discordId: "111", username: "disco_new", nick: "Disco (AFK)" });
  const renamed = await repo.users.findByDiscordId("111");
  assert.equal(renamed?.id, u.id);                    // same row, not a new user
  assert.equal(renamed?.username, "DiscoStaff");      // account key untouched
  assert.equal(renamed?.discordUsername, "disco_new");
  assert.equal(renamed?.discordNick, "Disco (AFK)");
  assert.equal((await repo.users.list()).length, 2);  // still just the two accounts

  // A partial refresh (only the nick) leaves the handle alone rather than blanking it.
  await repo.users.linkDiscord(u.id, { discordId: "111", nick: "Disco" });
  const partial = await repo.users.findByDiscordId("111");
  assert.equal(partial?.discordUsername, "disco_new");
  assert.equal(partial?.discordNick, "Disco");

  // Linking without managing still puts you on the list. This is the case that mattered: the merge
  // flow leaves discordManaged false, and those accounts were the ones whose names went stale.
  assert.deepEqual((await repo.users.listDiscordLinked()).map((x) => x.id).sort(), [u.id, manual.id].sort());

  // setDiscordManaged toggles the override without touching the link — the sweep still sees them,
  // it just stops re-applying their roles.
  await repo.users.setDiscordManaged(u.id, false);
  assert.equal((await repo.users.findById(u.id))?.discordManaged, false);
  assert.equal((await repo.users.listDiscordLinked()).length, 2);
  await repo.users.setDiscordManaged(u.id, true);
  assert.equal((await repo.users.listDiscordLinked()).length, 2);

  // Role mapping: many-to-many, replace semantics.
  const rAdmin = await repo.roles.create({ name: "Admin", grants: [{ capability: "*", level: "write" }], limits: {} });
  const rMod = await repo.roles.create({ name: "Mod", grants: [{ capability: "moderation.bans", level: "write" }], limits: {} });
  const everywhere = (...ids: string[]) => ids.map((roleId) => ({ roleId, scopeId: null }));
  await repo.discordRoleMap.setForDiscordRole("d-admin", "Admins", everywhere(rAdmin.id, rMod.id));
  await repo.discordRoleMap.setForDiscordRole("d-mod", "Mods", everywhere(rMod.id));
  const maps = await repo.discordRoleMap.list();
  assert.equal(maps.length, 3);
  assert.equal(maps.filter((m) => m.discordRoleId === "d-admin").length, 2);

  // Replace d-admin with just rMod, then clear d-mod.
  await repo.discordRoleMap.setForDiscordRole("d-admin", "Admins", everywhere(rMod.id));
  assert.equal((await repo.discordRoleMap.list()).filter((m) => m.discordRoleId === "d-admin").length, 1);
  assert.equal(await repo.discordRoleMap.remove("d-mod"), true);
  assert.equal((await repo.discordRoleMap.list()).some((m) => m.discordRoleId === "d-mod"), false);
});

test("matches: open supersedes prior open; folds per-player stats; aggregates wins by side", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const alice = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "111", name: "Alice" });
  const bob = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "222", name: "Bob" });

  // First match: Alice (allies) wins.
  const m1 = await repo.matches.open({ serverId: s.id, map: "Carentan Warfare", startedAt: "2026-07-01T10:00:00.000Z" });
  assert.equal((await repo.matches.getOpen(s.id))?.id, m1.id);
  await repo.matches.bumpStat({ matchId: m1.id, playerId: alice.id, serverId: s.id, playerName: "Alice", side: "allies", kills: 10, deaths: 3 });
  await repo.matches.bumpStat({ matchId: m1.id, playerId: alice.id, serverId: s.id, kills: 2, deaths: 1 }); // fold again
  await repo.matches.bumpStat({ matchId: m1.id, playerId: bob.id, serverId: s.id, playerName: "Bob", side: "axis", kills: 4, deaths: 8 });
  const closed = await repo.matches.close(m1.id, { endedAt: "2026-07-01T10:40:00.000Z", winner: "allies", alliedScore: 3, axisScore: 2, result: "ALLIED (3 - 2)" });
  assert.equal(closed?.winner, "allies");
  assert.equal(await repo.matches.getOpen(s.id), null); // closed

  const board = await repo.matches.statsForMatch(m1.id);
  assert.equal(board[0]!.playerId, alice.id); // highest kills first
  assert.equal(board[0]!.kills, 12);
  assert.equal(board[0]!.deaths, 4);

  // Second match still open; opening supersedes it when a third opens.
  const m2 = await repo.matches.open({ serverId: s.id, map: "Foy Warfare", startedAt: "2026-07-01T11:00:00.000Z" });
  await repo.matches.bumpStat({ matchId: m2.id, playerId: alice.id, serverId: s.id, side: "axis", kills: 1, deaths: 5 });
  await repo.matches.close(m2.id, { endedAt: "2026-07-01T11:30:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)" });

  const agg = await repo.matches.aggregateForPlayer(alice.id);
  assert.equal(agg.matches, 2);
  assert.equal(agg.wins, 1);   // m1 allies=winner
  assert.equal(agg.losses, 1); // m2 axis != winner
  assert.equal(agg.kills, 13);

  const recent = await repo.matches.listForPlayer(alice.id);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.map, "Foy Warfare"); // newest first
  assert.equal(recent[0]!.winner, "allies");

  // participants: every line across a SET of matches, one call (feeds "most played with/against")
  const parts = await repo.matches.participants([m1.id, m2.id]);
  assert.equal(parts.length, 3); // alice+bob in m1, alice in m2
  assert.deepEqual(parts.filter((p) => p.matchId === m1.id).map((p) => p.playerId).sort(), [alice.id, bob.id].sort());
  assert.deepEqual(await repo.matches.participants([]), []);

  // topStats: the records board — best single-round figures joined with their round, finished
  // rounds only. A monster line in the OPEN round is not a record until the whistle confirms it.
  const top = await repo.matches.topStats(s.id, "kills", 5);
  assert.equal(top[0]!.playerName, "Alice");
  assert.equal(top[0]!.value, 12);
  assert.equal(top[0]!.map, "Carentan Warfare");
  assert.equal(top[0]!.matchSeq, m1.seq, "the record names its round by the public alias");
  const m3 = await repo.matches.open({ serverId: s.id, map: "Kursk Warfare", startedAt: "2026-07-01T12:00:00.000Z" });
  await repo.matches.bumpStat({ matchId: m3.id, playerId: bob.id, serverId: s.id, playerName: "Bob", kills: 99 });
  assert.equal((await repo.matches.topStats(s.id, "kills", 5)).some((r) => r.value === 99), false, "open rounds stay off the board");

  // participantCounts: one row per round, however many stat lines it produced.
  const pc = new Map((await repo.matches.participantCounts(s.id)).map((c) => [c.matchId, c.players]));
  assert.equal(pc.get(m1.id), 2);
  assert.equal(pc.get(m3.id), 1, "open rounds count participants too — the caller decides what they mean");

  // importOne: external (CRCON) history lands as finished rows, idempotent on (server, start)
  const imp = { serverId: s.id, map: "kursk_warfare", startedAt: "2026-06-01T18:00:00.000Z", endedAt: "2026-06-01T19:20:00.000Z", winner: "axis" as const, result: "AXIS (5 - 0)" };
  assert.equal(await repo.matches.importOne(imp), true);
  assert.equal(await repo.matches.importOne(imp), false); // re-import is silent
  assert.equal(await repo.matches.importOne({ ...imp, startedAt: m1.startedAt }), false); // collides with a live-tracked round
  const all = await repo.matches.list(s.id);
  assert.ok(all.some((m) => m.map === "kursk_warfare" && m.winner === "axis" && m.endedAt));
});

/*
 * The score comes from the live session read, sampled onto the open round, because the MATCH ENDED
 * log line is not a reliable source of one — HLL: Vietnam's carries no score at all. Every
 * finished round on the public stats site read "unknown" with no winner until this existed, so
 * what matters here is that a scoreless close does not ERASE what was sampled.
 */
test("matches: the live score is sampled onto the open round, and a scoreless close keeps it", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const other = await repo.servers.create({ name: "Other", host: "1.1.1.2", port: 28865, password: "p" });

  // Nothing open: sampling is a no-op, not an error (the gap between maps).
  await repo.matches.recordScore(s.id, { alliedScore: 1, axisScore: 0 });

  const m = await repo.matches.open({ serverId: s.id, map: "wdevb_warfare_day", startedAt: "2026-08-01T10:00:00.000Z" });
  await repo.matches.recordScore(s.id, { alliedScore: 1, axisScore: 0 });
  await repo.matches.recordScore(s.id, { alliedScore: 1, axisScore: 4 }); // later ticks overwrite
  // One server's tick must never touch another's round.
  const mOther = await repo.matches.open({ serverId: other.id, map: "foy_warfare", startedAt: "2026-08-01T10:00:00.000Z" });
  await repo.matches.recordScore(other.id, { alliedScore: 5, axisScore: 5 });
  assert.deepEqual([(await repo.matches.get(m.id))?.alliedScore, (await repo.matches.get(m.id))?.axisScore], [1, 4]);

  // Vietnam's MATCH ENDED: a result string, no score, no side named. The sample survives and the
  // winner is derived from it — the whole point, since `winner` drives every win count in the app.
  const closed = await repo.matches.close(m.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: "MATCH ENDED" });
  assert.equal(closed?.alliedScore, 1, "a null score is silence, not zero");
  assert.equal(closed?.axisScore, 4);
  assert.equal(closed?.winner, "axis", "derived from the score the sampler kept");

  // A draw names nobody, rather than crediting the side that happens to sort first.
  const drawn = await repo.matches.close(mOther.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
  assert.equal(drawn?.winner, null);

  // And when the log DOES carry a score (HLL's does), it wins — it is the authoritative final,
  // where the sample is only the last thing we happened to see.
  const m2 = await repo.matches.open({ serverId: s.id, map: "carentan_warfare", startedAt: "2026-08-01T12:00:00.000Z" });
  await repo.matches.recordScore(s.id, { alliedScore: 2, axisScore: 2 });
  const scored = await repo.matches.close(m2.id, { endedAt: "2026-08-01T13:00:00.000Z", winner: "allies", alliedScore: 3, axisScore: 2, result: "ALLIED (3 - 2)" });
  assert.deepEqual([scored?.alliedScore, scored?.axisScore, scored?.winner], [3, 2, "allies"]);

  // A finished round is finished: a later tick must not reopen its score.
  await repo.matches.recordScore(s.id, { alliedScore: 9, axisScore: 9 });
  assert.equal((await repo.matches.get(m2.id))?.alliedScore, 3);
});

/*
 * The CRCON scoreboard import carries what no log line does — the final score, and per-player
 * buckets and playtime. It runs AFTER the kill-log import may have already counted the same
 * round, and may itself run twice, so everything here is about not double-counting.
 */
test("matches: importScoreboard fills scores/buckets idempotently and never double-counts", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const alice = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "111", name: "Alice" });
  const bob = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "222", name: "Bob" });

  // The kill-log import got here first: the match exists (no scores) and Alice has 12 kills.
  await repo.matches.importOne({ serverId: s.id, map: "carentan_warfare", startedAt: "2021-01-01T10:00:00.000Z", endedAt: "2021-01-01T10:40:00.000Z", winner: null, result: null });
  const m = (await repo.matches.list(s.id))[0]!;
  await repo.matches.bumpStat({ matchId: m.id, playerId: alice.id, serverId: s.id, playerName: "Alice", side: null, kills: 12, deaths: 4 });

  const board = {
    serverId: s.id, map: "carentan_warfare", startedAt: "2021-01-01T10:00:00.000Z", endedAt: "2021-01-01T10:40:00.000Z",
    alliedScore: 3, axisScore: 2,
    stats: [
      // CRCON agrees on Alice's kills; it also knows her buckets, side and playtime.
      { playerId: alice.id, playerName: "Alice", side: "allies" as const, kills: 12, deaths: 4, teamkills: 0, combat: 300, offense: 120, defense: 80, support: 40, vehicleKills: 1, vehiclesDestroyed: 0, timeSeconds: 2400 },
      // Bob never fired a shot, so the kill logs never created his line — the scoreboard does.
      { playerId: bob.id, playerName: "Bob", side: "axis" as const, kills: 0, deaths: 9, teamkills: 0, combat: 20, offense: 0, defense: 200, support: 500, vehicleKills: 0, vehiclesDestroyed: 0, timeSeconds: 2000 },
    ],
  };
  const first = await repo.matches.importScoreboard(board);
  assert.equal(first.created, false, "the match already existed");
  assert.equal(first.statsApplied, 2);

  const after = (await repo.matches.list(s.id))[0]!;
  assert.deepEqual([after.alliedScore, after.axisScore, after.winner], [3, 2, "allies"], "score fills blanks and names the winner");
  const lines = await repo.matches.statsForMatch(m.id);
  const a = lines.find((l) => l.playerId === alice.id)!;
  assert.equal(a.kills, 12, "GREATEST, not sum — the two sources agree and must not add up");
  assert.deepEqual([a.combat, a.side], [300, "allies"]);
  assert.deepEqual(a.roleSeconds, { "-1": 2400 }, "playtime lands under the unknown-role sentinel");
  const b = lines.find((l) => l.playerId === bob.id)!;
  assert.deepEqual([b.deaths, b.support], [9, 500], "a no-kill player still gets a line");

  // Re-run: nothing moves. This is what lets the operator apply the archive twice without fear.
  await repo.matches.importScoreboard(board);
  const again = (await repo.matches.statsForMatch(m.id)).find((l) => l.playerId === alice.id)!;
  assert.deepEqual([again.kills, again.combat, again.roleSeconds["-1"]], [12, 300, 2400]);

  // A recorded score is never overwritten by a re-import carrying a different one.
  await repo.matches.importScoreboard({ ...board, alliedScore: 5, axisScore: 0 });
  assert.equal((await repo.matches.list(s.id))[0]!.alliedScore, 3, "what is recorded wins over a backfill");

  // A round the history stage never saw: the scoreboard alone creates it whole.
  const solo = await repo.matches.importScoreboard({ ...board, startedAt: "2021-01-02T10:00:00.000Z", endedAt: "2021-01-02T10:45:00.000Z" });
  assert.equal(solo.created, true);
  assert.equal((await repo.matches.list(s.id)).length, 2);
});

test("matches: the objective layout staff set is recorded on the OPEN round only", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });

  // Nothing open: the layout still applied in game, but there is no round to hang it on. Silent
  // null rather than an error — refusing the write would imply the game rejected it, which it didn't.
  assert.equal(await repo.matches.recordSectorLayout({ serverId: s.id, layout: ["A", "B", "C", "D", "E"], by: "kate" }), null);

  const m = await repo.matches.open({ serverId: s.id, map: "Foy Warfare", startedAt: "2026-07-01T10:00:00.000Z" });
  assert.equal(m.sectorLayout, null); // a round nobody touched stays null, which MEANS "nobody set one"

  const first = await repo.matches.recordSectorLayout({ serverId: s.id, layout: ["Church", "Mill", "Road", "Bridge", "Farm"], by: "kate" });
  assert.equal(first?.id, m.id);
  assert.deepEqual(first?.sectorLayout, ["Church", "Mill", "Road", "Bridge", "Farm"]);
  assert.equal(first?.sectorLayoutBy, "kate");
  assert.ok(first?.sectorLayoutAt);

  // Re-setting mid-round replaces rather than appends: the game holds one layout, so must we.
  const second = await repo.matches.recordSectorLayout({ serverId: s.id, layout: ["Woods", "Mill", "Road", "Bridge", "Farm"], by: "sam" });
  assert.deepEqual(second?.sectorLayout, ["Woods", "Mill", "Road", "Bridge", "Farm"]);
  assert.equal(second?.sectorLayoutBy, "sam");

  // It survives the round closing — that is the whole point, since the game will never tell us again.
  await repo.matches.close(m.id, { endedAt: "2026-07-01T10:40:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)" });
  assert.deepEqual((await repo.matches.get(m.id))?.sectorLayout, ["Woods", "Mill", "Road", "Bridge", "Farm"]);

  // And a closed round is no longer a target: a layout set between maps must not rewrite history.
  assert.equal(await repo.matches.recordSectorLayout({ serverId: s.id, layout: ["X", "X", "X", "X", "X"], by: "sam" }), null);
  assert.deepEqual((await repo.matches.get(m.id))?.sectorLayout, ["Woods", "Mill", "Road", "Bridge", "Farm"]);
});

test("externalLinks: (provider, id) links set/clear/reverse-lookup; ids never live on players", async () => {
  const repo = new InMemoryRepository();
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "77", name: "Solo" });
  assert.deepEqual(await repo.externalLinks.list(p.id), []);

  await repo.externalLinks.set(p.id, "discord", "123456789012345678", "owner");
  await repo.externalLinks.set(p.id, "eos", "eos-abc");
  const links = await repo.externalLinks.list(p.id);
  assert.deepEqual(links.map((l) => l.provider), ["discord", "eos"]);

  // reverse lookup resolves the player (an integration asks "whose discord is this?")
  assert.equal((await repo.externalLinks.findPlayer("discord", "123456789012345678"))?.id, p.id);
  assert.equal(await repo.externalLinks.findPlayer("discord", "nope"), null);

  // re-set replaces; null clears
  await repo.externalLinks.set(p.id, "discord", "999");
  assert.equal((await repo.externalLinks.list(p.id)).find((l) => l.provider === "discord")?.externalId, "999");
  await repo.externalLinks.set(p.id, "discord", null);
  assert.deepEqual((await repo.externalLinks.list(p.id)).map((l) => l.provider), ["eos"]);
});

test("externalLinks.findPlayers: one Discord id fans out to every player row carrying it", async () => {
  const repo = new InMemoryRepository();
  // The multi-game shape (docs/vip-module.md): the same person, one row per game's id namespace.
  const ww2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656", name: "Same Person" });
  const viet = await repo.players.upsert({ game: "hll", platform: "epic", platformId: "eos-1", name: "Same Person" });
  await repo.externalLinks.set(ww2.id, "discord", "123456789012345678", "registration");
  await repo.externalLinks.set(viet.id, "discord", "123456789012345678", "registration");

  const both = await repo.externalLinks.findPlayers("discord", "123456789012345678");
  assert.deepEqual(new Set(both.map((x) => x.id)), new Set([ww2.id, viet.id]));
  // The singular lookup still answers — but it picks, which is exactly why per-game decisions
  // must not use it.
  assert.ok(await repo.externalLinks.findPlayer("discord", "123456789012345678"));
  assert.deepEqual(await repo.externalLinks.findPlayers("discord", "nope"), []);

  // Clearing one game's link leaves the other standing.
  await repo.externalLinks.set(viet.id, "discord", null);
  assert.deepEqual((await repo.externalLinks.findPlayers("discord", "123456789012345678")).map((x) => x.id), [ww2.id]);
});

test("playerTags + online: tags add/list/remove; openServers reflects live sessions", async () => {
  const repo = new InMemoryRepository();
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "42", name: "Rowdy" });

  const t = await repo.playerTags.add({ playerId: p.id, label: "🚩 toxic", note: "mic spam", createdByName: "owner" });
  await repo.playerTags.add({ playerId: p.id, label: "good SL", createdByName: "owner" });
  assert.equal((await repo.playerTags.list(p.id)).length, 2);
  await repo.playerTags.remove(t.id);
  const tags = await repo.playerTags.list(p.id);
  assert.deepEqual(tags.map((x) => x.label), ["good SL"]);

  // online-now via open sessions
  assert.deepEqual(await repo.sessions.openServers(p.id), []);
  await repo.sessions.open(p.id, "srv-1", new Date().toISOString());
  assert.deepEqual(await repo.sessions.openServers(p.id), ["srv-1"]);
  await repo.sessions.close(p.id, "srv-1", new Date().toISOString());
  assert.deepEqual(await repo.sessions.openServers(p.id), []); // closed → offline
});

test("events + trim: category×age deletes only the matched slice, backup archives it", async () => {
  const repo = new InMemoryRepository();
  const old = "2024-01-01T00:00:00.000Z";
  const recent = new Date().toISOString();
  await repo.events.insert([
    { serverId: "s1", ts: old, kind: "evt.kill", actorName: "a", victimName: "b", weapon: "M1" },
    { serverId: "s1", ts: recent, kind: "evt.kill", actorName: "c", victimName: "d", weapon: "M2" },
    { serverId: "s1", ts: old, kind: "evt.player.connected", actorName: "e" },
  ]);
  assert.equal((await repo.events.listRecent("s1")).length, 3);

  const spec = { kinds: kindsForCategories(["kills"]), olderThanIso: "2025-01-01T00:00:00.000Z" };
  assert.equal(await repo.events.countForTrim(spec), 1); // preview: only the old kill

  const backupPath = join(tmpdir(), `app-trim-test-${Date.now()}.ndjson.gz`);
  const res = await repo.events.trim({ ...spec, backupPath });
  assert.equal(res.deleted, 1);
  assert.equal(res.backupPath, backupPath);

  // backup exists and contains exactly the 1 deleted row
  const lines = gunzipSync(readFileSync(backupPath)).toString("utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).kind, "evt.kill");

  // the recent kill and the old connection (different category) survive
  const remaining = await repo.events.listRecent("s1");
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some((e) => e.kind === "evt.player.connected"));
});

test("audit survives deleting the actor, keeping the last known name", async () => {
  const repo = new InMemoryRepository();
  const u = await repo.users.create({ username: "Mod", passwordHash: "h" });
  await repo.audit.create({ actorUserId: u.id, actorName: "Mod", action: "player.kick", summary: "kicked someone" });

  assert.equal(await repo.users.remove(u.id), true);

  // The record is permanent — deleting the account must never erase what they did.
  const entries = await repo.audit.list({ limit: 10 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.actorUserId, null);   // link dropped, matching Postgres ON DELETE SET NULL
  assert.equal(entries[0]!.actorName, "Mod");    // last known name preserved for display
});

test("names follow the player: a rename reaches every list that stored a copy", async () => {
  // VIPs, console admins and group memberships each keep their own copy of the
  // player's name, taken when the entry was made. HLL players rename constantly, so those copies
  // used to go stale the moment someone changed their tag — the VIP list would show a name from
  // months earlier while the roster beside it showed the current one.
  const repo = new InMemoryRepository();
  const PID = "76561100000000001"; // these tables key on the raw platform id, not our uuid
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: PID, name: "OldName" });

  await repo.vips.upsert({ serverId: s.id, playerId: PID, playerName: "OldName", createdByName: "admin" });
  await repo.consoleAdmins.upsert({ serverId: s.id, playerId: PID, playerName: "OldName", adminGroup: "admin", createdByName: "admin" });
  const g = await repo.playerGroups.create({ name: "G", createdByName: "admin" });
  await repo.playerGroups.addMember({ groupId: g.id, playerId: PID, playerName: "OldName", addedByName: "admin" });

  // An entry for someone who has never joined — pasting a raw id is a supported way to add one,
  // and the stored copy is the only name we will ever have for them.
  await repo.vips.upsert({ serverId: s.id, playerId: "76561199999999999", playerName: "GhostName", createdByName: "admin" });

  await repo.players.upsert({ game: "hll", platform: "steam", platformId: PID, name: "NewName" });

  assert.equal((await repo.vips.get(s.id, PID))?.playerName, "NewName");
  assert.equal((await repo.vips.list(s.id)).find((v) => v.playerId === PID)?.playerName, "NewName");
  assert.equal((await repo.consoleAdmins.get(s.id, PID))?.playerName, "NewName");
  assert.equal((await repo.playerGroups.members(g.id))[0]?.playerName, "NewName");

  // …and the one we can't resolve keeps what it was given rather than going blank.
  assert.equal((await repo.vips.list(s.id)).find((v) => v.playerId === "76561199999999999")?.playerName, "GhostName");
});

test("analytics: session activity buckets by when people show up, and the mix separates new from returning", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const regular = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000001", name: "Regular", ts: "2026-01-01T00:00:00.000Z" });
  const sticky = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000002", name: "Sticky", ts: "2026-06-02T09:00:00.000Z" });
  const oneShot = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000003", name: "OneShot", ts: "2026-06-03T09:00:00.000Z" });
  // Sticky comes back four days after arriving; OneShot never does.
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000002", name: "Sticky", ts: "2026-06-06T09:00:00.000Z" });
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000001", name: "Regular", ts: "2026-06-05T09:00:00.000Z" });

  const add = (pid: string, at: string, sec: number) => repo.sessions.importOne({
    playerId: pid, serverId: s.id, connectedAt: at,
    disconnectedAt: new Date(Date.parse(at) + sec * 1000).toISOString(), durationSec: sec,
  });
  await add(regular.id, "2026-06-05T09:00:00.000Z", 600);
  await add(sticky.id, "2026-06-06T09:30:00.000Z", 1800);
  await add(oneShot.id, "2026-06-03T21:00:00.000Z", 3600);

  const win = { serverId: s.id, from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" };
  const act = await repo.analytics.sessionActivity(win);
  assert.equal(act.sessions, 3);
  assert.equal(act.uniquePlayers, 3);
  assert.equal(act.totalSeconds, 6000);
  assert.equal(act.medianSec, 1800, "the middle of 600/1800/3600 — a mean would read 2000 and hide the shape");
  assert.equal(act.byHour[9], 2, "two sessions started in the 09:00 hour");
  assert.equal(act.byHour[21], 1);
  assert.equal(act.daily.length, 3, "one row per day that had activity");

  // The week × hour grid is the real crossing, not the outer product of the two margins. Fri 09,
  // Sat 09 and Wed 21 happened; Wed 09 and Fri 21 did NOT, even though both of their margins are
  // non-zero — which is exactly the difference the heatmap would otherwise invent.
  assert.equal(act.weekHour.length, 7);
  assert.equal(act.weekHour[0]!.length, 24);
  assert.equal(act.weekHour[5]![9], 1, "Friday 09:00");
  assert.equal(act.weekHour[6]![9], 1, "Saturday 09:00");
  assert.equal(act.weekHour[3]![21], 1, "Wednesday 21:00");
  assert.equal(act.weekHour[3]![9], 0, "nobody played Wednesday morning");
  assert.equal(act.weekHour[5]![21], 0, "nobody played Friday evening");
  assert.equal(act.weekHour.flat().reduce((a, b) => a + b, 0), act.sessions, "the grid accounts for every session");

  const mix = await repo.analytics.playerMix(win);
  assert.equal(mix.newPlayers, 2, "first seen inside the window");
  assert.equal(mix.returningPlayers, 1, "known before it");
  assert.equal(mix.newPlayersWhoCameBack, 1, "only one newcomer was still around a day later");
});

test("analytics: the platform split sums presence and finished rounds per platform, inside the window only", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const other = await repo.servers.create({ name: "Other", host: "h", port: 2, password: "p" });
  const pc1 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000001", name: "PcOne", ts: "2026-06-01T00:00:00.000Z" });
  const pc2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000002", name: "PcTwo", ts: "2026-06-01T00:00:00.000Z" });
  const box = await repo.players.upsert({ game: "hll", platform: "xbox", platformId: "xuid-3000000000000003", name: "Boxer", ts: "2026-06-01T00:00:00.000Z" });

  const T0 = Date.parse("2026-06-05T09:00:00.000Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  const sess = (pid: string, from: number, sec: number, serverId = s.id) => repo.sessions.importOne({
    playerId: pid, serverId, connectedAt: at(from),
    disconnectedAt: at(from + sec), durationSec: sec,
  });
  await sess(pc1.id, 0, 600);
  await sess(pc1.id, 700, 900); // same player twice: 2 sessions, ONE distinct player
  await sess(pc2.id, 0, 300); // exactly the cutoff: not an early leaver
  await sess(box.id, 0, 1200);
  // A newcomer, first seen inside the window, who left inside the five-minute cutoff.
  const fresh = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000004", name: "Fresh", ts: at(30) });
  await sess(fresh.id, 30, 120);
  await sess(box.id, -864000, 600); // ten days before the window — presence must not leak in
  await sess(box.id, 100, 999, other.id); // wrong server — scoped out

  // A finished round in the window, an OPEN one, and one finished round started BEFORE the
  // window: only the first may reach the performance columns.
  // Rounds are sequenced oldest-first because open() retires any still-open round on the server.
  const stat = (matchId: string, pid: string, name: string, kills: number, deaths: number, teamkills = 0) =>
    repo.matches.bumpStat({ matchId, playerId: pid, serverId: s.id, playerName: name, kills, deaths, teamkills });
  const early = await repo.matches.open({ serverId: s.id, map: "SMDM", startedAt: at(-864000) });
  await stat(early.id, pc1.id, "PcOne", 7, 7);
  await repo.matches.close(early.id, { endedAt: at(-860400), winner: "axis", alliedScore: 1, axisScore: 4, result: null });
  const inWin = await repo.matches.open({ serverId: s.id, map: "Foy", startedAt: at(60) });
  await stat(inWin.id, pc1.id, "PcOne", 10, 2);
  await stat(inWin.id, pc2.id, "PcTwo", 4, 6);
  await stat(inWin.id, box.id, "Boxer", 3, 9, 1);
  // The game's own score for the round, as the roster sampler records it: PcOne led a squad for
  // the one sampled minute.
  await repo.stats.sampleRoster({ serverId: s.id, matchId: inWin.id, sampleSec: 60, players: [
    { platformId: pc1.platformId, name: "PcOne", role: 1, isSquadLead: true, side: "allies", score: { combat: 120, offense: 40, defense: 60, support: 30, vehicleKills: 2 } },
    { platformId: box.platformId, name: "Boxer", role: 0, isSquadLead: false, side: "axis", score: { combat: 50, offense: 10, defense: 20, support: 5 } },
  ] });
  await repo.matches.close(inWin.id, { endedAt: at(3600), winner: "allies", alliedScore: 3, axisScore: 2, result: null });
  const open = await repo.matches.open({ serverId: s.id, map: "SME", startedAt: at(3700) });
  await stat(open.id, box.id, "Boxer", 50, 50);

  const win = { serverId: s.id, from: "2026-06-05T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" };
  const { rows } = await repo.analytics.platformBreakdown(win);
  const steam = {
    players: 3, newPlayers: 1, sessions: 4, shortSessions: 1, playtimeSec: 1920,
    rounds: 2, kills: 14, deaths: 8, teamkills: 0, vehicleKills: 2, scoredRounds: 1, combat: 120, offense: 40, defense: 60, support: 30, slSeconds: 60,
  };
  const xbox = {
    players: 1, newPlayers: 0, sessions: 1, shortSessions: 0, playtimeSec: 1200,
    rounds: 1, kills: 3, deaths: 9, teamkills: 1, vehicleKills: 0, scoredRounds: 1, combat: 50, offense: 10, defense: 20, support: 5, slSeconds: 0,
  };
  // PcTwo's round has kills but no score, as an imported round would: it is a round, not a scored one.
  assert.deepEqual(rows, [{ platform: "steam", ...steam }, { platform: "xbox", ...xbox }],
    "sums per platform — the page derives K/D, the per-round score, the average session and the early-leaver share from these");

  // No server scope: the other server's session shows up, and lands under its player's platform.
  const all = await repo.analytics.platformBreakdown({ from: win.from, to: win.to });
  const allXbox = all.rows.find((r) => r.platform === "xbox");
  assert.equal(allXbox?.sessions, 2);
  assert.equal(allXbox?.playtimeSec, 2199);

  // The same split as a per-day series, for the overlaid lines and their metric picker: the
  // breakdown's sums per local day, window- and server-scoped like everything else here.
  const trend = await repo.analytics.platformTrend({ ...win, tz: "UTC" });
  assert.deepEqual(trend.rows, [
    { date: "2026-06-05", platform: "steam", ...steam, firstPlayers: 3, firstNewPlayers: 1 },
    { date: "2026-06-05", platform: "xbox", ...xbox, firstPlayers: 1, firstNewPlayers: 0 },
  ], "pc1's two sessions are one player; the out-of-window and other-server rows are absent; the open round adds nothing");

  // A day's new players are the ones first seen THAT day: the same newcomer, seen again the next
  // day, is a returning player there.
  await sess(fresh.id, 86_400, 900);
  const late = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000005", name: "Late", ts: "2026-06-01T00:00:00.000Z" });
  await sess(late.id, 86_400 + 60, 900); // known before the window, here only on its second day
  const twoDays = await repo.analytics.platformTrend({ serverId: s.id, from: win.from, to: "2026-06-07T00:00:00.000Z", tz: "UTC" });
  const steamOn = (date: string) => twoDays.rows.find((r) => r.date === date && r.platform === "steam");
  assert.equal(steamOn("2026-06-05")?.newPlayers, 1);
  assert.equal(steamOn("2026-06-06")?.players, 2);
  assert.equal(steamOn("2026-06-06")?.newPlayers, 0, "back the next day is not new again");

  // Each player once more, on the day of their first session in the window — what the chart's
  // running count of players adds up. Added up, they are the window's players and new players.
  assert.deepEqual([steamOn("2026-06-05")?.firstPlayers, steamOn("2026-06-06")?.firstPlayers], [3, 1], "Fresh was counted the day before; Late is new to the window");
  assert.deepEqual([steamOn("2026-06-05")?.firstNewPlayers, steamOn("2026-06-06")?.firstNewPlayers], [1, 0]);
  const twoDayTable = await repo.analytics.platformBreakdown({ serverId: s.id, from: win.from, to: "2026-06-07T00:00:00.000Z" });
  for (const b of twoDayTable.rows) {
    const days = twoDays.rows.filter((r) => r.platform === b.platform);
    assert.deepEqual([days.reduce((n, r) => n + r.firstPlayers, 0), days.reduce((n, r) => n + r.firstNewPlayers, 0)], [b.players, b.newPlayers],
      `${b.platform}: the first days add up to the window's players and new players`);
  }
});

test("analytics: combat aggregates the kill log, and attributes it to the round it happened in", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const ace = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000001", name: "Ace", ts: "2026-06-01T00:00:00.000Z" });
  const careless = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000002", name: "Careless", ts: "2026-06-01T00:00:00.000Z" });
  const victim = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000003", name: "Victim", ts: "2026-06-01T00:00:00.000Z" });

  const T0 = Date.parse("2026-06-05T09:00:00.000Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  await repo.matches.importOne({ serverId: s.id, map: "Foy", startedAt: at(0), endedAt: at(3600), winner: "allies", result: null });
  // A second round nothing happened in — it must NOT appear as a row of zeroes.
  await repo.matches.importOne({ serverId: s.id, map: "SME", startedAt: at(3700), endedAt: at(7200), winner: "axis", result: null });

  await repo.events.insert([
    ...[0, 1, 2].map((i) => ({
      serverId: s.id, ts: at(60 + i), kind: "evt.kill", actorPlayerId: ace.id, actorName: "Ace",
      victimPlayerId: victim.id, victimName: "Victim", weapon: "M1 GARAND", data: null, dedupeKey: `k${i}`,
    })),
    {
      serverId: s.id, ts: at(120), kind: "evt.teamkill", actorPlayerId: careless.id, actorName: "Careless",
      victimPlayerId: victim.id, victimName: "Victim", weapon: "155MM HOWITZER", data: null, dedupeKey: "tk1",
    },
    // A kill the log gave us no weapon for. Counted, and bucketed — never dropped.
    {
      serverId: s.id, ts: at(200), kind: "evt.kill", actorPlayerId: ace.id, actorName: "Ace",
      victimPlayerId: victim.id, victimName: "Victim", weapon: null, data: null, dedupeKey: "k-null",
    },
    // Chat in the same window must not reach a combat aggregate at all.
    {
      serverId: s.id, ts: at(240), kind: "evt.chat.team", actorPlayerId: ace.id, actorName: "Ace",
      victimPlayerId: null, victimName: null, weapon: null, data: { message: "gg" }, dedupeKey: "c1",
    },
  ]);

  const c = await repo.analytics.combat({ serverId: s.id, from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" });
  assert.equal(c.totals.kills, 4, "three rifle kills plus the one with no weapon; the chat line is not a kill");
  assert.equal(c.totals.teamkills, 1);
  assert.equal(c.totals.killers, 2, "both actors count, one of them only ever team-killed");
  assert.equal(c.totals.victims, 1);
  assert.equal(c.byWeapon.find((w) => w.weapon === "M1 GARAND")?.kills, 3);
  assert.equal(c.byWeapon.find((w) => w.weapon === "Unknown")?.kills, 1, "a missing weapon is bucketed, not dropped");
  assert.equal(c.topKillers[0]?.name, "Ace");
  assert.equal(c.topTeamkillers[0]?.name, "Careless");
  assert.equal(c.topTeamkillers[0]?.kills, 0, "their ordinary kills travel alongside, so a rate can be shown");

  // Attribution, and the inner-join semantics Postgres has: only rounds with events appear.
  assert.deepEqual(c.byMap, [{ map: "Foy", kills: 4, teamkills: 1 }]);

  // Kills only in the heatmap — team kills are rare enough that mixing them in would shift the
  // whole ramp without ever being visible.
  assert.equal(c.weekHour[5]?.[9], 4, "Friday 09:00 UTC");
  assert.equal(c.byHour[9], 4);
});

test("analytics: early leavers count against the map that was running when they joined", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const quitter = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000011", name: "Quitter", ts: "2026-06-01T00:00:00.000Z" });
  const stayer = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000012", name: "Stayer", ts: "2026-06-01T00:00:00.000Z" });

  const T0 = Date.parse("2026-06-05T09:00:00.000Z");
  const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  await repo.matches.importOne({ serverId: s.id, map: "Foy", startedAt: at(0), endedAt: at(3600), winner: "allies", result: null });
  await repo.matches.importOne({ serverId: s.id, map: "SME", startedAt: at(3700), endedAt: at(7200), winner: "axis", result: null });

  await repo.sessions.importOne({ playerId: quitter.id, serverId: s.id, connectedAt: at(100), disconnectedAt: at(160), durationSec: 60 });
  await repo.sessions.importOne({ playerId: stayer.id, serverId: s.id, connectedAt: at(100), disconnectedAt: at(3700), durationSec: 3600 });

  const a = await repo.analytics.sessionActivity({ serverId: s.id, from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" });
  assert.equal(a.sessions, 2);
  assert.equal(a.shortSessions, 1, "one of the two left inside the cutoff");
  assert.equal(a.shortCutoffSec, 300);
  // SME is absent rather than a 0-of-0 row: there is no leave rate to compute for a round nobody
  // joined during, and a zero row would sit in the chart implying one.
  assert.deepEqual(a.earlyLeaversByMap, [{ map: "Foy", sessions: 2, short: 1 }]);
});

test("analytics: concurrency counts overlapping sessions, not session starts", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const T0 = Date.parse("2026-06-05T00:00:00.000Z"); // a Friday (day 5)
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const player = async (n: number) =>
    repo.players.upsert({ game: "hll", platform: "steam", platformId: `76561100000000${n}`, name: `P${n}`, ts: at(0) });
  const add = (id: string, from: number, to: number) => repo.sessions.importOne({
    playerId: id, serverId: s.id, connectedAt: at(from), disconnectedAt: at(to), durationSec: (to - from) * 60,
  });

  const [p0, p1, p2, p3, p4] = await Promise.all([player(0), player(1), player(2), player(3), player(4)]);
  // Three players overlap between minute 120 and 150.
  await add(p0!.id, 60, 180);
  await add(p1!.id, 90, 200);
  await add(p2!.id, 120, 150);
  // A hand-off: p3 leaves at the exact instant p4 arrives.
  await add(p3!.id, 400, 500);
  await add(p4!.id, 500, 560);

  const win = { serverId: s.id, from: "2026-06-05T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" };
  const c = await repo.analytics.concurrency(win);

  // FIVE sessions started, but never more than three people were on at once. That gap is the whole
  // reason this exists — "peak" used to mean peak arrivals.
  assert.equal(c.peak, 3);
  assert.equal(c.peakAt, at(120));
  // The hand-off must not read as two: departures are processed before arrivals at the same
  // instant, or every clean substitution invents a player.
  assert.ok(c.peak === 3, "a leave and a join at the same instant is not two players");
  // Mean = total player-minutes (120 + 110 + 30 + 100 + 60 = 420) over a 1440-minute window.
  assert.equal(c.average, Math.round((420 / 1440) * 100) / 100);
  assert.equal(c.sampleSec, 300, "a one-day window samples every five minutes");
  assert.ok(c.weekHour[5]![2]! > 0, "Friday 02:00 UTC had players");
  assert.equal(c.weekHour[5]![12], 0, "an hour nobody played is a real zero, not a gap");
  assert.deepEqual(c.daily.map((d) => d.date), ["2026-06-05"]);
  assert.equal(c.daily[0]?.peak, 3);
});

/*
 * The 1,294-players-on-a-100-slot-server incident. Presence is per PLAYER, and a session is
 * believed for at most 12 hours from its connect: a backlog of stale opens mass-closed at one
 * instant writes multi-week "sessions", and counting those rows painted a phantom crowd across
 * the window's whole first band.
 */
test("analytics: concurrency counts people, not rows, and disbelieves torn multi-day sessions", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const T0 = Date.parse("2026-06-05T00:00:00.000Z");
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const player = (n: number) =>
    repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656120000000${100 + n}`, name: `P${n}`, ts: at(0) });
  const add = (id: string, from: number, to: number) => repo.sessions.importOne({
    playerId: id, serverId: s.id, connectedAt: at(from), disconnectedAt: at(to), durationSec: (to - from) * 60,
  });

  // One person, three overlapping rows for the same evening (live tracking + an imported copy +
  // a partial dupe). Still one person in the seat.
  const dup = await player(0);
  await add(dup.id, 60, 180);
  await add(dup.id, 60, 180);
  await add(dup.id, 90, 150);
  // A second, ordinary player overlapping them: the true peak is TWO.
  const mate = await player(1);
  await add(mate.id, 100, 160);

  // Forty reap artifacts: connected five days before the window, "closed" inside it by a backlog
  // sweep. Believed for 12 hours from connect — all of it before the window — so they must not
  // put a phantom crowd on the window's first morning.
  for (let n = 10; n < 50; n++) {
    const p = await player(n);
    await add(p.id, -5 * 24 * 60, 12 * 60); // five days before → noon of day one
  }

  const win = { serverId: s.id, from: at(0), to: at(24 * 60) };
  const c = await repo.analytics.concurrency(win);
  assert.equal(c.peak, 2, "three rows for one person and forty torn artifacts are still two people");
  assert.equal(c.peakAt, at(100));
  // Mean uses merged per-player time: dup 120min + mate 60min over a 1440-minute window.
  assert.equal(c.average, Math.round((180 / 1440) * 100) / 100);
  const morning = c.dayHour.find((d) => d.date === "2026-06-05");
  assert.ok(morning, "the window's one day is present");
  assert.equal(morning!.hours[6], 0, "06:00 — mid torn-artifact band — is an honest zero");

  // Open sessions follow the same rule: a row open for days is a missed disconnect, not a player
  // online at the window's end; a fresh one is.
  const stale = await player(90), fresh = await player(91);
  await repo.sessions.open(stale.id, s.id, at(-3 * 24 * 60));
  await repo.sessions.open(fresh.id, s.id, at(23 * 60));
  const c2 = await repo.analytics.concurrency(win);
  assert.equal(c2.openAtEnd, 1, "only the fresh open session is somebody online at the end");
  assert.equal(c2.peak, 2, "the stale open adds no presence inside the window either");
});

/*
 * The 267-on-a-100-slot follow-up: the torn-session cap alone still let mispaired log rebuilds
 * stack phantom hours. Where the worker MEASURED the roster (one snapshot a minute), the
 * measurement is the truth for its bucket — including a measured zero — and where nothing was
 * measured, inference stands but can never exceed the game's 100 slots.
 */
test("analytics: measured roster samples outrank session inference, and inference respects the slot cap", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const T0 = Date.parse("2026-06-05T00:00:00.000Z");
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const flat = { unassigned: 0, byRole: {}, bySide: {} };

  // Twelve phantom "players" whose rebuilt sessions all claim 12:00–14:00. The whole two hours
  // is measured, so none of that stacking may reach any figure.
  for (let n = 0; n < 12; n++) {
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `76561230000000${100 + n}`, name: `F${n}`, ts: at(0) });
    await repo.sessions.importOne({ playerId: p.id, serverId: s.id, connectedAt: at(12 * 60), disconnectedAt: at(14 * 60), durationSec: 7200 });
  }
  // Hour 12 measured at three online, hour 13 measured EMPTY — a real zero, not missing data.
  for (let m = 0; m < 60; m += 5) {
    await repo.rosterSnapshots.record({ serverId: s.id, ts: at(12 * 60 + m), playerCount: 3, composition: { players: 3, ...flat } });
    await repo.rosterSnapshots.record({ serverId: s.id, ts: at(13 * 60 + m), playerCount: 0, composition: { players: 0, ...flat } });
  }

  const win = { serverId: s.id, from: at(0), to: at(24 * 60) };
  const c = await repo.analytics.concurrency(win);
  const day = c.dayHour.find((d) => d.date === "2026-06-05")!;
  assert.equal(day.hours[12], 3, "the measured hour reads what was measured, not the phantom twelve");
  assert.equal(day.hours[13], 0, "a measured empty hour is an honest zero, whatever the rows claim");
  assert.equal(c.peak, 3, "the peak is the best measurement — the inferred spike sits inside measured buckets");
  assert.equal(c.average, Math.round((3 * 12 / 288) * 100) / 100, "the mean is over the whole grid, measurement included");

  // A LIVE window ("last 90 days from right now") never starts on a bucket boundary, and the
  // measured buckets floor onto the lattice — the first one can land before the grid's first
  // instant. That key must be dropped, not counted into the mean or crash the fold.
  const odd = await repo.analytics.concurrency({ serverId: s.id, from: at(0.5), to: at(24 * 60 + 0.5) });
  assert.equal(odd.peak, 3, "an unaligned window still reads the measured peak");
  assert.ok(odd.average > 0 && odd.average <= 3, "and a sane mean");

  // Unmeasured windows fall back to inference — bounded by physics. 120 overlapping rebuilt
  // sessions on one server is more than the game can hold, so 100 is the most it may claim.
  const s2 = await repo.servers.create({ name: "S2", host: "h", port: 2, password: "p" });
  for (let n = 0; n < 120; n++) {
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `76561240000000${100 + n}`, name: `G${n}`, ts: at(0) });
    await repo.sessions.importOne({ playerId: p.id, serverId: s2.id, connectedAt: at(60), disconnectedAt: at(120), durationSec: 3600 });
  }
  const c2 = await repo.analytics.concurrency({ serverId: s2.id, from: at(0), to: at(24 * 60) });
  assert.equal(c2.peak, 100, "an inferred crowd larger than the server is clamped to its slots");
  const day2 = c2.dayHour.find((d) => d.date === "2026-06-05")!;
  assert.equal(day2.hours[1], 100, "grid cells respect the same ceiling");
});

/** One snapshot's composition, built the way summarizeRoster produces it. */
const comp = (sides: Record<string, { players: number; squads: number; noSl?: string[] }>, roles: Record<number, number>) => ({
  players: Object.values(sides).reduce((n, s) => n + s.players, 0),
  unassigned: 0,
  byRole: roles,
  bySide: Object.fromEntries(Object.entries(sides).map(([id, s]) =>
    [id, { players: s.players, squads: s.squads, unsquadded: 0, noSlSquads: s.noSl ?? [], byRole: {} }])),
});

/*
 * A role number is only meaningful against the game it was counted on: 13 is "Commander" in HLL
 * and "Mortar Support" in Vietnam, 5 is "Support" against "Specialist". The composition page
 * labels a whole window with the descriptor of whatever game the server runs TODAY, so samples
 * from before a game switch would be relabelled into a vocabulary they were never counted in —
 * and both games' samples summed into one distribution where the same key means two roles.
 */
test("analytics: composition folds only the samples taken on the game the server runs now", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", game: "hllv", host: "h", port: 1, password: "p" } as never);
  const T0 = Date.parse("2026-06-05T00:00:00.000Z");
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

  // Two samples taken while the server ran Vietnam. Role 13 there is Mortar Support.
  await repo.rosterSnapshots.record({ serverId: s.id, ts: at(0), playerCount: 20, mapName: "Quang Ngai",
    composition: comp({ allies: { players: 10, squads: 2 }, axis: { players: 10, squads: 2 } }, { 0: 16, 13: 4 }) });
  await repo.rosterSnapshots.record({ serverId: s.id, ts: at(60), playerCount: 20, mapName: "Quang Ngai",
    composition: comp({ allies: { players: 10, squads: 2 }, axis: { players: 10, squads: 2 } }, { 0: 16, 13: 4 }) });
  const asVietnam = await repo.analytics.composition({ serverId: s.id, from: at(-10), to: at(180) });
  assert.equal(asVietnam.samples, 2);

  // The server is switched to WW2 and samples again. Role 13 now means Commander.
  await repo.servers.setGame(s.id, "hll", "binary-v2");
  await repo.rosterSnapshots.record({ serverId: s.id, ts: at(120), playerCount: 20, mapName: "Foy",
    composition: comp({ allies: { players: 10, squads: 2 }, axis: { players: 10, squads: 2 } }, { 0: 16, 13: 4 }) });

  // The fold is labelled with HLL's vocabulary now, so it must contain ONLY the HLL sample —
  // not three samples whose "13" means two different roles.
  const asHll = await repo.analytics.composition({ serverId: s.id, from: at(-10), to: at(180) });
  assert.equal(asHll.samples, 1, "the Vietnam samples are excluded, not relabelled");
});

test("analytics: composition averages the sampled roster, and says what it sampled", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const T0 = Date.parse("2026-06-05T00:00:00.000Z");
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

  // Three samples an hour apart, so a 5-minute grid keeps all three (one per bucket).
  await repo.rosterSnapshots.record({ serverId: s.id, ts: at(0), playerCount: 20, mapName: "Foy",
    composition: comp({ allies: { players: 10, squads: 2 }, axis: { players: 10, squads: 2 } }, { 0: 16, 9: 4 }) });
  await repo.rosterSnapshots.record({ serverId: s.id, ts: at(60), playerCount: 40, mapName: "Foy",
    composition: comp({ allies: { players: 22, squads: 4, noSl: ["BAKER"] }, axis: { players: 18, squads: 3 } }, { 0: 33, 9: 7 }) });
  await repo.rosterSnapshots.record({ serverId: s.id, ts: at(120), playerCount: 0, mapName: "Carentan",
    composition: comp({}, {}) });

  const c = await repo.analytics.composition({ serverId: s.id, from: at(-10), to: at(180) });

  assert.equal(c.samples, 3);
  assert.equal(c.sampleSec, 300, "a short window samples every five minutes");
  assert.equal(c.avgPlayers, 20, "(20 + 40 + 0) / 3 — the empty sample counts, that IS the population");
  assert.equal(c.peakPlayers, 40);

  // Shares are totals over totals, so they weight by population rather than treating the empty
  // sample as an equal vote about what the mix looks like.
  const officers = c.byRole.find((r) => r.role === 9);
  assert.equal(officers?.share, Math.round((11 / 60) * 1000) / 1000);
  assert.equal(c.bySide.find((x) => x.sideId === "allies")?.share, Math.round((32 / 60) * 1000) / 1000);

  // Only two samples had any squads at all; the third cannot have had a leaderless one, so it is
  // not in the denominator. Counting it would say "leaderless a third of the time" for a server
  // that was simply empty.
  assert.equal(c.noSl?.squadSamples, 2);
  assert.equal(c.noSl?.sampleShare, 0.5);
  assert.equal(c.noSl?.avgSquads, 0.5);

  assert.deepEqual(c.byMap.map((m) => m.map), ["Foy", "Carentan"], "most-sampled first");
  assert.equal(c.byMap[0]?.samples, 2);
  assert.equal(c.daily.length, 1);
  assert.equal(c.daily[0]?.samples, 3);
});

test("analytics: composition over an empty window is null rates, not confident zeroes", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const c = await repo.analytics.composition({ serverId: s.id, from: "2026-06-05T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" });
  assert.equal(c.samples, 0);
  assert.equal(c.avgPlayers, null, "no samples means no average — not an average of zero");
  assert.equal(c.peakPlayers, null);
  assert.equal(c.noSl, null);
  assert.deepEqual(c.byRole, []);
  assert.deepEqual(c.daily, []);
});

test("analytics: composition downsamples to one snapshot per bucket", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const T0 = Date.parse("2026-06-05T00:00:00.000Z");
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  // A month-long window buckets at 30 minutes. Six one-minute samples inside one bucket must
  // contribute ONE sample, or a server that happened to be sampled more often would outweigh one
  // that wasn't — and a year of minute-resolution rows would be read in full to answer the page.
  for (let m = 0; m < 6; m++) {
    await repo.rosterSnapshots.record({ serverId: s.id, ts: at(m), playerCount: 10 * (m + 1),
      composition: comp({ allies: { players: 5, squads: 1 } }, { 0: 5 }) });
  }
  const c = await repo.analytics.composition({ serverId: s.id, from: at(0), to: new Date(T0 + 31 * 86_400_000).toISOString() });
  assert.equal(c.sampleSec, 1800);
  assert.equal(c.samples, 1, "six snapshots in one 30-minute bucket is one sample");
  assert.equal(c.avgPlayers, 10, "and it is the EARLIEST in the bucket, deterministically");
});

test("analytics: a re-written snapshot for the same instant does not double-count", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const ts = "2026-06-05T12:00:00.000Z";
  const one = { serverId: s.id, ts, playerCount: 50, composition: comp({ allies: { players: 25, squads: 4 } }, { 0: 50 }) };
  await repo.rosterSnapshots.record(one);
  await repo.rosterSnapshots.record(one); // the sampler retried after a timeout
  const rows = await repo.rosterSnapshots.list({ serverId: s.id, from: "2026-06-05T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" });
  assert.equal(rows.length, 1);
});

test("analytics: concurrency clips to the window and counts still-open sessions", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "S", host: "h", port: 1, password: "p" });
  const long = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000091", name: "Long", ts: "2026-06-01T00:00:00.000Z" });
  const online = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656110000000092", name: "Online", ts: "2026-06-01T00:00:00.000Z" });

  // A session that began BEFORE the window and ended inside it. Those players were on the server
  // during the window; a containment test would drop them, and it is exactly the long sessions a
  // busyness figure most depends on.
  await repo.sessions.importOne({
    playerId: long.id, serverId: s.id,
    connectedAt: "2026-06-04T22:00:00.000Z", disconnectedAt: "2026-06-05T02:00:00.000Z", durationSec: 4 * 3600,
  });
  // …and someone still playing when the window ends.
  await repo.sessions.open(online.id, s.id, "2026-06-05T22:00:00.000Z");

  const c = await repo.analytics.concurrency({
    serverId: s.id, from: "2026-06-05T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z",
  });

  assert.equal(c.peak, 1);
  assert.equal(c.openAtEnd, 1);
  assert.ok(c.weekHour[5]![0]! > 0, "the pre-window session counts from midnight, clipped");
  assert.ok(c.weekHour[5]![23]! > 0, "the open session counts right up to the window edge");
  // Clipped to the window: 2h of the long session + 2h of the open one = 4h of 24.
  assert.equal(c.average, Math.round((4 / 24) * 100) / 100);
});

test("players.upsertMany matches the per-player upsert, and collapses a duplicated roster", async () => {
  const repo = new InMemoryRepository();
  const ts = "2026-06-05T12:00:00.000Z";
  const rows = await repo.players.upsertMany([{ game: "hll", platform: "steam", platformId: "76561100000000001", name: "Ana", clanTag: "AAA", ts },
    { game: "hll", platform: "steam", platformId: "76561100000000002", name: "Bo", ts },
    // A roster read can list the same player twice while they reconnect. Postgres cannot update
    // one row twice in a single statement, so both stores collapse to the last write — and the
    // caller keys off platformId, never position.
    { game: "hll", platform: "steam", platformId: "76561100000000001", name: "Ana2", ts },
    // Blank ids are not players.
    { game: "hll", platform: "steam", platformId: "   ", name: "Ghost", ts },
  ]);

  assert.equal(rows.length, 2, "two real players out of four input rows");
  const ana = rows.find((r) => r.platformId === "76561100000000001");
  assert.equal(ana?.name, "Ana2", "the last write in the batch wins");

  // Alias history is recorded exactly as the single upsert records it.
  const aliases = await repo.playerAliases.list(ana!.id);
  assert.deepEqual(aliases.filter((a) => a.kind === "name").map((a) => a.value).sort(), ["Ana", "Ana2"]);
  assert.deepEqual(aliases.filter((a) => a.kind === "clan").map((a) => a.value), ["AAA"]);
});

test("players.upsertMany on an empty roster is a no-op, not an error", async () => {
  const repo = new InMemoryRepository();
  assert.deepEqual(await repo.players.upsertMany([]), []);
  assert.deepEqual(await repo.players.upsertMany([{ game: "hll", platform: "steam", platformId: "", name: "x" }]), []);
});

test("the bulk lookups answer exactly what the per-row ones did", async () => {
  // These exist only to collapse N+1s in the watchlist and the IP page, so the thing that matters
  // is that they agree with the single-row calls they replaced — including the awkward cases:
  // an id that doesn't exist, a repeated id, and an empty request.
  const repo = new InMemoryRepository();
  const mk = (n: number) => repo.players.upsert({ game: "hll", platform: "steam", platformId: `76561100000000${n}`, name: `P${n}` });
  const [a, b, c] = await Promise.all([mk(1), mk(2), mk(3)]);

  const found = await repo.players.findByIds([a.id, b.id, a.id, "no-such-player"]);
  assert.deepEqual(found.map((p) => p.name).sort(), ["P1", "P2"], "deduped, and a missing id is absent rather than null");
  assert.deepEqual(await repo.players.findByIds([]), []);

  // Online-now, for many players at once.
  await repo.sessions.open(a.id, "s1", "2026-06-05T10:00:00.000Z");
  await repo.sessions.open(a.id, "s2", "2026-06-05T10:00:00.000Z");
  await repo.sessions.open(b.id, "s1", "2026-06-05T10:00:00.000Z");
  const open = await repo.sessions.openServersFor([a.id, b.id, c.id]);
  assert.deepEqual([...(open.get(a.id) ?? [])].sort(), ["s1", "s2"], "both servers, matching openServers");
  assert.deepEqual(open.get(b.id), ["s1"]);
  assert.equal(open.get(c.id), undefined, "offline players are absent, not an empty array");
  assert.deepEqual(await repo.sessions.openServersFor([a.id]), new Map([[a.id, ["s1", "s2"]]]));
  assert.equal((await repo.sessions.openServersFor([])).size, 0);
  // The per-row call it replaces must still agree.
  assert.deepEqual((await repo.sessions.openServers(a.id)).sort(), ["s1", "s2"]);

  // Shared-address lookups.
  const ts = "2026-06-05T10:00:00.000Z";
  await repo.playerIps.record(a.id, "1.2.3.4", ts, "log");
  await repo.playerIps.record(b.id, "1.2.3.4", ts, "log");
  await repo.playerIps.record(c.id, "5.6.7.8", ts, "log");
  const both = await repo.playerIps.byIps(["1.2.3.4", "5.6.7.8"]);
  assert.equal(both.length, 3);
  assert.deepEqual((await repo.playerIps.byIps(["1.2.3.4"])).map((r) => r.playerId).sort(), [a.id, b.id].sort());
  assert.deepEqual(await repo.playerIps.byIps([]), []);
  assert.deepEqual((await repo.playerIps.byIp("1.2.3.4")).map((r) => r.playerId).sort(), [a.id, b.id].sort());
});

/*
 * Two servers, and every read that could confuse them.
 *
 * A community running more than one server had no way to tell their data apart on the screens that
 * matter most for records: `player_stats` was keyed on the player alone, so kills on the Warfare
 * server and kills on the Offensive server landed in one row and nothing downstream could take
 * them back apart. The leaderboard ranked the merged figure, the directory's stat columns showed
 * it, and both were displayed under a sidebar pinned to one specific server — so a merged number
 * read as that server's.
 *
 * Every assertion below fails against the old shape. They are grouped in one test because the
 * point is the SET of them: fixing the board while leaving the directory merged is the same bug.
 */
test("two servers: every community-wide read can tell them apart", async () => {
  const repo = new InMemoryRepository();
  const A = await repo.servers.create({ name: "Warfare", host: "10.0.0.1", port: 28001, password: "p" });
  const B = await repo.servers.create({ name: "Offensive", host: "10.0.0.2", port: 28002, password: "p" });

  // Alice plays only on A, Bob only on B, and Carol on both.
  const alice = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765_alice", name: "Alice" });
  const bob = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765_bob", name: "Bob" });
  const carol = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765_carol", name: "Carol" });
  await repo.stats.bumpMany([
    { playerId: alice.id, serverId: A.id, delta: { kills: 100, deaths: 10, visits: 1, playtimeSec: 3600 } },
    { playerId: bob.id, serverId: B.id, delta: { kills: 5, deaths: 5, visits: 1, playtimeSec: 600 } },
    { playerId: carol.id, serverId: A.id, delta: { kills: 20, deaths: 20, visits: 1, playtimeSec: 1200 } },
    { playerId: carol.id, serverId: B.id, delta: { kills: 30, deaths: 10, visits: 2, playtimeSec: 2400 } },
  ]);

  // --- one player's figures ---
  assert.equal((await repo.stats.get(alice.id, A.id))?.kills, 100);
  assert.equal(await repo.stats.get(alice.id, B.id), null, "Alice never played on B, so B has nothing to report");
  assert.equal((await repo.stats.get(carol.id, A.id))?.kills, 20);
  assert.equal((await repo.stats.get(carol.id, B.id))?.kills, 30);
  // No server named = the career, which is still every server added together. A profile means
  // that, and it is what this returned before the split — so the upgrade changes no headline.
  const career = await repo.stats.get(carol.id);
  assert.equal(career?.kills, 50);
  assert.equal(career?.visits, 3);
  assert.equal(career?.serverId, null, "a total is not any server's row and must not claim to be");
  assert.deepEqual(
    (await repo.stats.byServer(carol.id)).map((s) => s.kills).sort((x, y) => x - y),
    [20, 30],
    "the breakdown is what lets a career be read as where it was earned",
  );

  // --- the leaderboard ---
  const onA = await repo.stats.leaderboard("kills", 50, [A.id]);
  assert.deepEqual(onA.map((e) => e.name), ["Alice", "Carol"], "B's players are not ranked on A's board");
  assert.equal(onA.find((e) => e.name === "Carol")?.kills, 20, "and Carol is ranked on what she did HERE");
  const onB = await repo.stats.leaderboard("kills", 50, [B.id]);
  assert.deepEqual(onB.map((e) => e.name), ["Carol", "Bob"]);
  assert.equal(onB.find((e) => e.name === "Carol")?.kills, 30);
  // Combining is still available — it just has to be asked for.
  const all = await repo.stats.leaderboard("kills", 50);
  assert.deepEqual(all.map((e) => e.name), ["Alice", "Carol", "Bob"]);
  assert.equal(all.find((e) => e.name === "Carol")?.kills, 50);
  // A viewer scoped to A and B alone gets exactly those two summed, never a third server's.
  assert.deepEqual((await repo.stats.leaderboard("kills", 50, [A.id, B.id])).map((e) => e.name), ["Alice", "Carol", "Bob"]);
  assert.deepEqual(await repo.stats.leaderboard("kills", 50, []), [], "a viewer who can see no server sees no board");
  // A later page of the same board, and how many it ranks.
  assert.deepEqual((await repo.stats.leaderboard("kills", 1, [A.id, B.id], 1)).map((e) => e.name), ["Carol"], "one place down");
  assert.deepEqual((await repo.stats.leaderboard("kills", 5, undefined, 2)).map((e) => e.name), ["Bob"]);
  assert.deepEqual([await repo.stats.leaderboardCount([A.id]), await repo.stats.leaderboardCount([B.id]), await repo.stats.leaderboardCount([A.id, B.id]), await repo.stats.leaderboardCount(), await repo.stats.leaderboardCount([])],
    [2, 2, 3, 3, 0], "a player on two servers is one line of a board over both");

  // --- the directory ---
  const dirA = await repo.players.directory({ serverIds: [A.id], limit: 50 });
  assert.deepEqual(dirA.map((r) => r.name).sort(), ["Alice", "Carol"], "only people who play here");
  assert.equal(dirA.find((r) => r.name === "Carol")?.kills, 20, "showing what they did here");
  assert.equal(await repo.players.directoryCount({ serverIds: [A.id] }), 2, "the total must match the rows");
  const dirB = await repo.players.directory({ serverIds: [B.id], limit: 50 });
  assert.deepEqual(dirB.map((r) => r.name).sort(), ["Bob", "Carol"]);
  assert.equal(dirB.find((r) => r.name === "Carol")?.kills, 30);
  const dirAll = await repo.players.directory({ limit: 50 });
  assert.equal(dirAll.length, 3);
  assert.equal(dirAll.find((r) => r.name === "Carol")?.kills, 50);

  // --- the game filter — what the picker behind every per-server action narrows by, because the
  // games issue different player ids and the other game's id is one the server applies to nobody ---
  await repo.players.upsert({ game: "hllv", platform: "steam", platformId: "0002vn_dave", name: "Dave" });
  assert.deepEqual((await repo.players.directory({ game: "hllv", limit: 50 })).map((r) => r.name), ["Dave"],
    "a Vietnam-scoped picker offers only Vietnam accounts");
  assert.equal((await repo.players.directory({ game: "hll", limit: 50 })).length, 3, "and a WW2-scoped one never sees them");
  assert.equal(await repo.players.directoryCount({ game: "hllv" }), 1, "the count agrees with the page");

  // --- VIP, which is a per-server grant and was answered from a community-wide manual flag ---
  await repo.vips.upsert({ serverId: A.id, playerId: alice.platformId, playerName: "Alice", expiration: null, createdByName: "t" });
  await repo.vips.upsert({ serverId: B.id, playerId: carol.platformId, playerName: "Carol", expiration: "2020-01-01T00:00:00.000Z", createdByName: "t" });
  assert.deepEqual((await repo.players.directory({ serverIds: [A.id], vipOnly: true, limit: 50 })).map((r) => r.name), ["Alice"]);
  assert.deepEqual((await repo.players.directory({ serverIds: [B.id], vipOnly: true, limit: 50 })).map((r) => r.name), [],
    "Carol's B grant expired in 2020, so she is not a VIP there now");
  assert.deepEqual((await repo.players.directory({ vipOnly: true, limit: 50 })).map((r) => r.name), ["Alice"],
    "unscoped means VIP on ANY server — still the grants table, never the manual marker");
  // A leftover manual marker in the flags row cannot resurrect the star. There used to be two
  // VIPs — a grant, and a cosmetic tick anyone could set — and the directory carried both, so a
  // player with no grant could still read as VIP. The row now answers from the grants alone.
  await repo.playerFlags.set(bob.id, { vip: true }, { userId: null, name: "staff" });
  const bobRow = (await repo.players.directory({ limit: 50 })).find((r) => r.name === "Bob")!;
  assert.equal(bobRow.vip, false, "no grant, no star — whatever the old flags row says");

  // --- sessions, which the analytics page compares a player's play pattern from ---
  await repo.sessions.open(carol.id, A.id, "2026-06-01T10:00:00.000Z");
  await repo.sessions.close(carol.id, A.id, "2026-06-01T11:00:00.000Z");
  await repo.sessions.open(carol.id, B.id, "2026-06-02T10:00:00.000Z");
  await repo.sessions.close(carol.id, B.id, "2026-06-02T11:00:00.000Z");
  assert.equal((await repo.sessions.list(carol.id)).length, 2);
  assert.equal((await repo.sessions.list(carol.id, 50, A.id)).length, 1);
  assert.equal((await repo.sessions.list(carol.id, 50, A.id))[0]?.serverId, A.id);
});

/*
 * The audit trail is per-server data that nothing could ask about per server.
 *
 * Every entry already carried the server the action was taken on — a kick happens on a server, a
 * VIP grant is for a server — and neither the trail nor the staff rollup could filter on it. So
 * "who is moderating THIS server" and "what happened here" were unanswerable, and the merged
 * answer was displayed under a sidebar naming one specific server.
 */
test("the audit trail and the staff rollup separate one server from another", async () => {
  const repo = new InMemoryRepository();
  const A = await repo.servers.create({ name: "Warfare", host: "10.0.0.1", port: 28011, password: "p" });
  const B = await repo.servers.create({ name: "Offensive", host: "10.0.0.2", port: 28012, password: "p" });

  const act = (actorName: string, action: string, serverId?: string) =>
    repo.audit.create({ actorUserId: `u-${actorName}`, actorName, action, summary: `${actorName} ${action}`, ...(serverId ? { serverId } : {}) });

  await act("Ada", "player.kick", A.id);
  await act("Ada", "player.kick", A.id);
  await act("Ada", "player.ban", B.id);
  await act("Bo", "player.kick", B.id);
  // An action on no server at all: renaming a template, editing an account. Community-level.
  await act("Cy", "templates.update");

  const names = (rows: { actorName: string }[]) => [...new Set(rows.map((r) => r.actorName))].sort();

  // --- the trail ---
  assert.deepEqual(names(await repo.audit.list({ serverIds: [A.id] })), ["Ada"]);
  assert.equal((await repo.audit.list({ serverIds: [A.id] })).length, 2);
  assert.deepEqual(names(await repo.audit.list({ serverIds: [B.id] })), ["Ada", "Bo"]);
  assert.equal(await repo.audit.count({ serverIds: [A.id] }), 2, "the count must match the rows it counts");
  // Both servers at once — a viewer scoped to two of three sees exactly those two.
  assert.equal((await repo.audit.list({ serverIds: [A.id, B.id] })).length, 4);
  // A community-level action belongs to no server, so a scoped read does not claim it…
  assert.ok(!names(await repo.audit.list({ serverIds: [A.id, B.id] })).includes("Cy"));
  // …and an unscoped read still sees everything, which is what the trail is for.
  assert.equal((await repo.audit.list({})).length, 5);

  // --- the staff rollup: "who is moderating HERE" ---
  const summary = async (serverIds?: string[]) =>
    Object.fromEntries((await repo.audit.staffSummary(serverIds ? { serverIds } : {})).map((r) => [r.actorName, r.count]));
  assert.deepEqual(await summary([A.id]), { Ada: 2 }, "only the people who acted on this server");
  assert.deepEqual(await summary([B.id]), { Ada: 1, Bo: 1 }, "and only what they did here");
  assert.deepEqual(await summary(), { Ada: 3, Bo: 1, Cy: 1 }, "unscoped is still the whole community");
});

/*
 * ONE VOLLEY, ONE ACTION — in the rollup too. The analytics pages collapse a bulk send's
 * per-target rows in JS (countableActions), but the Staff activity leaderboard reads this
 * rollup, and counted raw it showed a group message to a squad as one action PER RECIPIENT:
 * "player.message ×1683" on the card, ×15 on the same person's collapsed profile.
 */
test("staff rollup counts a bulk volley once and skips continuation rows", async () => {
  const repo = new InMemoryRepository();
  const S = await repo.servers.create({ name: "V", host: "10.0.0.9", port: 28019, password: "p" });
  // The store stamps its own clock and the volley key is the UTC minute, so re-seed under a
  // fresh actor in the vanishingly rare run where seeding straddles a minute boundary.
  let actor = "";
  for (let attempt = 0; ; attempt++) {
    actor = `Vol${attempt}`;
    const minute = new Date().toISOString().slice(0, 16);
    for (const target of ["p1", "p2", "p3"]) {
      await repo.audit.create({ actorUserId: null, actorName: actor, action: "player.message", serverId: S.id, targetId: target, summary: "attack the point", data: { playerId: target, message: "attack the point", bulk: true } });
    }
    if (new Date().toISOString().slice(0, 16) === minute) break;
  }
  await repo.audit.create({ actorUserId: null, actorName: actor, action: "player.message", serverId: S.id, targetId: "p9", summary: "hi", data: { playerId: "p9", message: "hi" } });
  // The second half of an over-cap temp ban: the SAME sentence extended, already counted once.
  await repo.audit.create({ actorUserId: null, actorName: actor, action: "player.tempban", serverId: S.id, targetId: "p1", summary: "48h part two", data: { playerId: "p1", continues: "req-1" } });

  const rows = await repo.audit.staffSummary({});
  const me = rows.find((r) => r.actorName === actor);
  assert.equal(me?.byAction["player.message"], 2, "the three-target volley is ONE act beside the solo message");
  assert.equal(me?.byAction["player.tempban"], undefined, "a continuation is not a new act");
  assert.equal(me?.count, 2);
});

/*
 * A role is a bundle of capabilities with no server of its own; the ASSIGNMENT says where it
 * applies. Before this, both places a role could be handed out — a user directly, and a Discord
 * role mapping — stored only the role id, so "Moderator on Warfare" could not be expressed and
 * mapping a Discord role granted its capabilities across the entire community.
 */
test("a role can be held on one server, on another, and everywhere — all at once", async () => {
  const repo = new InMemoryRepository();
  const A = await repo.servers.create({ name: "Warfare", host: "10.0.0.1", port: 28011, password: "p" });
  const B = await repo.servers.create({ name: "Offensive", host: "10.0.0.2", port: 28012, password: "p" });
  const mod = await repo.roles.create({ name: "Mod", grants: [{ capability: "action.kick", level: "write" }], limits: {} });
  const helper = await repo.roles.create({ name: "Helper", grants: [{ capability: "server.view", level: "read" }], limits: {} });
  const user = await repo.users.create({ username: "ada", passwordHash: "x" });

  // The same role twice at different scopes is two assignments, not a duplicate.
  await repo.userRoles.set(user.id, [
    { roleId: mod.id, scopeId: A.id },
    { roleId: mod.id, scopeId: B.id },
    { roleId: helper.id, scopeId: null },
  ]);
  const held = await repo.userRoles.listByUser(user.id);
  assert.equal(held.length, 3);
  assert.deepEqual(held.filter((h) => h.roleId === mod.id).map((h) => h.scopeId).sort(), [A.id, B.id].sort());
  assert.equal(held.find((h) => h.roleId === helper.id)?.scopeId, null, "null keeps meaning everywhere");

  // An exact repeat collapses — the store must not accumulate the same assignment twice.
  await repo.userRoles.set(user.id, [
    { roleId: mod.id, scopeId: A.id },
    { roleId: mod.id, scopeId: A.id },
  ]);
  assert.equal((await repo.userRoles.listByUser(user.id)).length, 1);

  // Membership is "holds it anywhere" — the roles list counts people, not assignments.
  assert.deepEqual(await repo.userRoles.members(mod.id), [user.id]);

  // Deleting the role takes every assignment of it with it, at every scope.
  await repo.userRoles.set(user.id, [{ roleId: mod.id, scopeId: A.id }, { roleId: helper.id, scopeId: B.id }]);
  await repo.roles.remove(mod.id);
  assert.deepEqual((await repo.userRoles.listByUser(user.id)).map((h) => h.roleId), [helper.id]);
});

test("a Discord role can grant a panel role on one server only", async () => {
  const repo = new InMemoryRepository();
  const A = await repo.servers.create({ name: "Warfare", host: "10.0.0.1", port: 28011, password: "p" });
  const B = await repo.servers.create({ name: "Offensive", host: "10.0.0.2", port: 28012, password: "p" });
  const mod = await repo.roles.create({ name: "Mod", grants: [{ capability: "action.kick", level: "write" }], limits: {} });

  // One Discord role, the same panel role, two servers — the case the old schema's primary key
  // (discord_role_id, role_id) made impossible to store.
  await repo.discordRoleMap.setForDiscordRole("d-mods", "Mods", [
    { roleId: mod.id, scopeId: A.id },
    { roleId: mod.id, scopeId: B.id },
  ]);
  const rows = (await repo.discordRoleMap.list()).filter((m) => m.discordRoleId === "d-mods");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.scopeId).sort(), [A.id, B.id].sort());

  // Narrowing it to one server drops the other (replace semantics).
  await repo.discordRoleMap.setForDiscordRole("d-mods", "Mods", [{ roleId: mod.id, scopeId: A.id }]);
  const after = (await repo.discordRoleMap.list()).filter((m) => m.discordRoleId === "d-mods");
  assert.deepEqual(after.map((r) => r.scopeId), [A.id]);
});

test("playerTags.labelsByPlatformIds: whole roster in one lookup, keyed by the id the game reports", async () => {
  const repo = new InMemoryRepository();
  const tagged = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656119000000001", name: "Tagged" });
  const twoTags = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656119000000002", name: "TwoTags" });
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "7656119000000003", name: "Untagged" });

  await repo.playerTags.add({ playerId: tagged.id, label: "trusted", note: null, createdByName: "admin" });
  await repo.playerTags.add({ playerId: twoTags.id, label: "seeder", note: null, createdByName: "admin" });
  await repo.playerTags.add({ playerId: twoTags.id, label: "staff", note: null, createdByName: "admin" });

  const roster = ["7656119000000001", "7656119000000002", "7656119000000003", "7656119000000009"];
  const map = await repo.playerTags.labelsByPlatformIds(roster);

  assert.deepEqual(map.get("7656119000000001"), ["trusted"]);
  assert.deepEqual(map.get("7656119000000002"), ["seeder", "staff"], "multiple tags come back in creation order");
  // A player with no tags and an id we have never seen are both simply absent, so the caller's
  // `?? []` is the whole handling. Returning empty arrays for them would allocate one per player
  // per tick for exactly no information.
  assert.equal(map.has("7656119000000003"), false, "a known player with no tags is absent");
  assert.equal(map.has("7656119000000009"), false, "an unknown platform id is absent");
  assert.equal(map.size, 2);

  // The shapes the runners actually hand it on a quiet server.
  assert.equal((await repo.playerTags.labelsByPlatformIds([])).size, 0);
  assert.equal((await repo.playerTags.labelsByPlatformIds(["", ""])).size, 0);
  // Duplicate ids (the same player reported twice) must not duplicate labels.
  const dup = await repo.playerTags.labelsByPlatformIds(["7656119000000001", "7656119000000001"]);
  assert.deepEqual(dup.get("7656119000000001"), ["trusted"]);
});

/*
 * player_ban — what staff DECIDED, as distinct from what a game server is enforcing.
 *
 * The distinguishing behaviour is that nothing is ever deleted: a lift stamps the row so "banned,
 * lifted, banned again" reads back as three facts in order. Everything else here is about the
 * queries the reconciler and the profile will ask.
 */
test("player bans: create, active filter, lift once", async () => {
  const repo = new InMemoryRepository();
  const scope = { mode: "all" } as const;
  const a = await repo.playerBans.create({ game: "hll", playerId: "p1", playerName: "Cheat", kind: "perma", reason: "aimbot", scope, createdByName: "mod" });
  assert.equal(a.liftedAt, null);
  assert.equal(a.category, null);
  assert.deepEqual(a.scope, scope);

  assert.equal((await repo.playerBans.list({ activeOnly: true })).length, 1);
  assert.equal(await repo.playerBans.lift(a.id, "boss"), true);
  // Lifting twice is not a second event — the first lift is the fact, and who did it must not be
  // overwritten by whoever clicked next.
  assert.equal(await repo.playerBans.lift(a.id, "someone else"), false);
  const after = await repo.playerBans.get(a.id);
  assert.equal(after?.liftedByName, "boss");
  assert.ok(after?.liftedAt);

  // The row survives the lift: history, not a delete.
  assert.equal((await repo.playerBans.list()).length, 1);
  assert.equal((await repo.playerBans.list({ activeOnly: true })).length, 0);
});

test("player bans: an expired ban stops being active without anyone lifting it", async () => {
  const repo = new InMemoryRepository();
  await repo.playerBans.create({
    game: "hll", playerId: "p1", kind: "temp", reason: "spam", scope: { mode: "servers", serverIds: ["s1"] },
    expiresAt: new Date(Date.now() - 60_000).toISOString(), createdByName: "mod",
  });
  await repo.playerBans.create({
    game: "hll", playerId: "p1", kind: "temp", reason: "spam", scope: { mode: "servers", serverIds: ["s1"] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(), createdByName: "mod",
  });
  assert.equal((await repo.playerBans.list()).length, 2);
  assert.equal((await repo.playerBans.list({ activeOnly: true })).length, 1);
});

test("player bans: filtered by game and player, and liftAllFor can narrow to one kind", async () => {
  const repo = new InMemoryRepository();
  const scope = { mode: "all" } as const;
  await repo.playerBans.create({ game: "hll", playerId: "p1", kind: "perma", reason: "a", scope, createdByName: "m" });
  await repo.playerBans.create({ game: "hll", playerId: "p1", kind: "temp", reason: "b", scope, createdByName: "m" });
  await repo.playerBans.create({ game: "hllv", playerId: "p2", kind: "perma", reason: "c", scope, createdByName: "m" });

  assert.equal((await repo.playerBans.list({ game: "hll" })).length, 2);
  assert.equal((await repo.playerBans.list({ playerId: "p2" })).length, 1);

  // "Remove temp ban" must not quietly lift the permanent one alongside it.
  assert.equal(await repo.playerBans.liftAllFor("p1", "boss", "temp"), 1);
  const left = await repo.playerBans.list({ playerId: "p1", activeOnly: true });
  assert.deepEqual(left.map((b) => b.kind), ["perma"]);
  assert.equal(await repo.playerBans.liftAllFor("p1", "boss"), 1);
  assert.equal((await repo.playerBans.list({ playerId: "p1", activeOnly: true })).length, 0);
  // …and it never reached the other player.
  assert.equal((await repo.playerBans.list({ playerId: "p2", activeOnly: true })).length, 1);
});

test("player bans: the scope rule round-trips exactly as stored", async () => {
  const repo = new InMemoryRepository();
  // The whole point of the column: "everywhere but #2" has to come back as a rule, not as the two
  // servers it happens to cover today.
  for (const scope of [{ mode: "all" }, { mode: "except", serverIds: ["s2"] }, { mode: "servers", serverIds: ["s1", "s3"] }] as BanScopeJson[]) {
    const row = await repo.playerBans.create({ game: "hll", playerId: "p", kind: "perma", reason: "r", scope, createdByName: "m" });
    assert.deepEqual((await repo.playerBans.get(row.id))?.scope, scope);
  }
});

test("economy: one write path — clamp at the cap, refuse overdrafts, replay by ref is a no-op", async () => {
  const repo = new InMemoryRepository();

  // A member exists the moment anything touches them, and holds a balance with no game account.
  const a = await repo.economy.apply({ discordId: "d1", delta: 100, reason: "seed", actorName: "staff", discordName: "Alpha" });
  assert.equal(a.applied, true);
  assert.equal(a.member.balance, 100);
  assert.equal((await repo.economy.member("d1"))?.discordName, "Alpha");

  // Credits TRIM at the cap: the row records what was applied, not what was asked for.
  const b = await repo.economy.apply({ discordId: "d1", delta: 100, reason: "claim" }, { maxBalance: 150 });
  assert.equal(b.member.balance, 150);
  assert.equal(b.entry.delta, 50);

  // A debit below zero refuses — and refuses BEFORE writing anything.
  await assert.rejects(() => repo.economy.apply({ discordId: "d1", delta: -151, reason: "overdraft" }));
  assert.equal((await repo.economy.member("d1"))?.balance, 150);

  // The same ref twice is one event: the second call returns the first row, applied: false.
  const first = await repo.economy.apply({ discordId: "d1", delta: -50, reason: "purchase", ref: "buy:1" });
  const replay = await repo.economy.apply({ discordId: "d1", delta: -50, reason: "purchase", ref: "buy:1" });
  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(replay.member.balance, 100, "the replay moved no money");

  // The ledger explains the balance: sum of rows === cached balance.
  const rows = await repo.economy.ledger("d1");
  assert.equal(rows.reduce((s, r) => s + r.delta, 0), (await repo.economy.member("d1"))!.balance);
  assert.equal(await repo.economy.ledgerCount("d1"), 3);

  // Claim derivation: the newest ref with the kind's prefix is the last claim.
  await repo.economy.apply({ discordId: "d1", delta: 20, reason: "daily claim", ref: "claim:daily:d1:2026-08-11" });
  await repo.economy.apply({ discordId: "d1", delta: 20, reason: "daily claim", ref: "claim:daily:d1:2026-08-12" });
  const last = await repo.economy.lastEntryWithRefPrefix("d1", "claim:daily:d1:");
  assert.equal(last?.ref, "claim:daily:d1:2026-08-12");
});

test("economy: members list is a leaderboard, and config round-trips over defaults", async () => {
  const repo = new InMemoryRepository();
  await repo.economy.apply({ discordId: "rich", delta: 500, reason: "seed" });
  await repo.economy.apply({ discordId: "poor", delta: 5, reason: "seed", discordName: "Pauper" });
  const members = await repo.economy.members();
  assert.deepEqual(members.map((m) => m.discordId), ["rich", "poor"]);
  assert.deepEqual((await repo.economy.members({ q: "paup" })).map((m) => m.discordId), ["poor"]);
  assert.equal(await repo.economy.membersCount(), 2);

  // Fresh install: everything off, nothing runs silently.
  const cfg = await repo.economy.config();
  assert.equal(cfg.claims.daily.enabled, false);
  assert.equal(cfg.gifting.enabled, false);
  assert.deepEqual(cfg.offers, []);

  const set = await repo.economy.setConfig({
    currencyName: "Gold Coins", balanceCap: 10_000,
    offers: [{ id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [] }],
  });
  assert.equal(set.currencyName, "Gold Coins");
  assert.equal(set.offers[0]?.days, 14);
  // Untouched sections keep their values across a partial patch.
  assert.equal(set.claims.monthly.max, 525);
});

test("discord command: the shipped name is the default, and a partial patch keeps the rest", async () => {
  const repo = new InMemoryRepository();
  const seeded = await repo.discordCommands.get();
  assert.equal(seeded.name, "staff");
  assert.equal(seeded.enabled, true, "the command ships switched on");

  const renamed = await repo.discordCommands.set({ name: "lynx", description: "Open the LYNX panel" });
  assert.equal(renamed.name, "lynx");
  assert.notEqual(renamed.updatedAt, seeded.updatedAt);

  // Switching it off touches nothing else, so switching it back on restores the same command.
  const off = await repo.discordCommands.set({ enabled: false });
  assert.equal(off.name, "lynx");
  assert.equal(off.description, "Open the LYNX panel");
});

test("app config: the community clock defaults to UTC and refuses a zone the runtime cannot use", async () => {
  const repo = new InMemoryRepository();
  assert.equal((await repo.appConfig.get()).timezone, "UTC", "a fresh install has nobody to ask");

  assert.equal((await repo.appConfig.set({ timezone: "America/New_York" })).timezone, "America/New_York");
  // A zone the runtime cannot parse keeps the last good one rather than poisoning every reader:
  // this value is read inside worker loops, where throwing means VIP stops being granted.
  assert.equal((await repo.appConfig.set({ timezone: "Mars/Olympus" })).timezone, "America/New_York");
  assert.equal((await repo.appConfig.get()).timezone, "America/New_York");
});

test("trimData: every catalogued dataset trims its old rows, keeps live ones, and archives what it deletes", async () => {
  const { TRIM_DATASETS } = await import("../dist/index.js");
  const repo = new InMemoryRepository();
  const cutoff = "2025-01-01T00:00:00.000Z";
  const OLD = "2024-06-01T12:00:00.000Z";
  const NEW = "2025-06-01T12:00:00.000Z";

  // One old row, one new row (and where the semantics call for it, one open row) per dataset.
  await repo.rosterSnapshots.record({ serverId: "s1", ts: OLD, playerCount: 10, composition: {} });
  await repo.rosterSnapshots.record({ serverId: "s1", ts: NEW, playerCount: 20, composition: {} });

  await repo.sessions.importOne({ playerId: "p1", serverId: "s1", connectedAt: "2024-06-01T11:00:00.000Z", disconnectedAt: OLD, durationSec: 3600 });
  await repo.sessions.importOne({ playerId: "p1", serverId: "s1", connectedAt: "2025-06-01T11:00:00.000Z", disconnectedAt: NEW, durationSec: 3600 });
  await repo.sessions.open("p2", "s1", "2024-01-01T00:00:00.000Z"); // still connected — has no disconnect row to trim

  // Scratch state: one row written long ago (an interrupted flow's leftovers) and one live.
  await repo.pluginKv.set("vip-registration", "old-user", { spent: true }, OLD);
  await repo.pluginKv.set("vip-registration", "live-user", { codeHash: "x" }, NEW);
  // …and one row that is a FACT rather than scratch: the welcome VIP has been paid. Backdated well
  // past the cutoff, because that is exactly the case that used to delete it — the marker has no
  // expiry and no repair path, so ageing it out re-arms a payout. `keep:` is what protects it, and
  // the counts below (one old row per dataset) are what proves it was not collected.
  await repo.pluginKv.set("vip-registration", "keep:daysBonus:111222333444", true, OLD);

  const mOld = await repo.matches.open({ serverId: "s1", map: "foy_warfare", startedAt: "2024-06-01T10:00:00.000Z" });
  await repo.matches.bumpStat({ matchId: mOld.id, playerId: "p1", serverId: "s1", playerName: "Ada", kills: 5, deaths: 0, teamkills: 0 });
  await repo.matches.close(mOld.id, { endedAt: OLD, winner: "allies", alliedScore: 3, axisScore: 2, result: null });
  const mNew = await repo.matches.open({ serverId: "s1", map: "foy_warfare", startedAt: "2025-06-01T10:00:00.000Z" });
  await repo.matches.bumpStat({ matchId: mNew.id, playerId: "p1", serverId: "s1", playerName: "Ada", kills: 2, deaths: 0, teamkills: 0 });
  await repo.matches.close(mNew.id, { endedAt: NEW, winner: "axis", alliedScore: 2, axisScore: 3, result: null });
  // A round that STARTED before the cutoff but never ended must survive: it is still being played.
  const mOpen = await repo.matches.open({ serverId: "s1", map: "sme_warfare", startedAt: "2024-07-01T10:00:00.000Z" });

  const voters = [{ discordId: "d1", name: "Ada" }];
  await repo.mapVote.recordHistory({ serverId: "s1", decidedAt: OLD, profile: null, winnerId: "foy_warfare", winnerName: "Foy", totalVotes: 1, outcome: "vote", applied: true,
    options: [{ id: "foy_warfare", name: "Foy", votes: 1, voters }] });
  await repo.mapVote.recordHistory({ serverId: "s1", decidedAt: NEW, profile: null, winnerId: "sme_warfare", winnerName: "SME", totalVotes: 1, outcome: "vote", applied: true,
    options: [{ id: "sme_warfare", name: "SME", votes: 1, voters }] });

  await repo.adminCam.importOne({ serverId: "s1", playerId: "p1", playerName: "Ada", enteredAt: "2024-06-01T11:00:00.000Z", exitedAt: OLD, durationSec: 3600 });
  await repo.adminCam.importOne({ serverId: "s1", playerId: "p1", playerName: "Ada", enteredAt: "2025-06-01T11:00:00.000Z", exitedAt: NEW, durationSec: 3600 });
  await repo.adminCam.open({ serverId: "s1", playerId: "p3", playerName: "Ghost", at: "2024-02-01T00:00:00.000Z" }); // still in camera

  await repo.playerIps.record("p1", "1.1.1.1", OLD, "live");
  await repo.playerIps.record("p1", "2.2.2.2", OLD, "live");
  await repo.playerIps.record("p1", "2.2.2.2", NEW, "live"); // first seen long ago, seen SINCE the cutoff — stays

  await repo.playerAliases.record("p1", "name", "OldName", OLD);
  await repo.playerAliases.record("p1", "name", "NewName", NEW);

  // audit.create stamps "now"; the memory store returns the stored row itself, so backdating the
  // test fixture is a plain field write. (The Postgres check backdates with SQL.)
  const oldAudit = await repo.audit.create({ actorName: "Ada", action: "test.old", summary: "old" });
  (oldAudit as { ts: string }).ts = OLD;
  await repo.audit.create({ actorName: "Ada", action: "test.new", summary: "new" });

  // The catalog IS the contract: every listed id must preview (an unimplemented one throws), and
  // with the seeding above every one of them owes exactly one row to this cutoff.
  const ids = TRIM_DATASETS.map((d: { id: string }) => d.id);
  const preview = await repo.trimData.preview(ids, cutoff);
  for (const id of ids) assert.equal(preview[id], 1, `expected exactly one old ${id} row, saw ${preview[id]}`);
  await assert.rejects(() => repo.trimData.preview(["bogus"], cutoff), /unknown trim dataset/);

  const dir = join(tmpdir(), `trim-data-test-${Date.now()}`);
  const results = await repo.trimData.run(ids, cutoff, dir);

  // Every dataset: one parent deleted, and a parseable gzipped NDJSON archive holding it.
  for (const id of ids) {
    assert.equal(results[id]!.deleted, 1, `${id} should have deleted its one old row`);
    assert.ok(results[id]!.backupPath, `${id} should have written a backup`);
    const lines = gunzipSync(readFileSync(results[id]!.backupPath as string)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.length >= 1, `${id} archive should not be empty`);
    for (const line of lines) assert.ok(line.table && line.row, `${id} archive lines carry {table, row}`);
  }

  // Children ride with their parents: the old match's scoreboard line and the old vote's ballot
  // are IN the archive, and gone from the store.
  const matchLines = gunzipSync(readFileSync(results.matches!.backupPath as string)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(matchLines.map((l) => l.table).sort(), ["matches", "player_match_stats"]);
  const voteLines = gunzipSync(readFileSync(results.mapVotes!.backupPath as string)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(voteLines.map((l) => l.table).sort(), ["mapvote_ballots", "mapvote_history"]);

  // What must remain, remains — new rows, open rows, and anything seen since the cutoff.
  assert.equal((await repo.rosterSnapshots.latest("s1"))?.ts, NEW);
  assert.deepEqual((await repo.sessions.list("p1")).map((s) => s.disconnectedAt), [NEW]);
  assert.deepEqual(await repo.sessions.openServers("p2"), ["s1"], "an open session is untouched");
  assert.equal(await repo.matches.get(mOld.id), null);
  assert.equal((await repo.matches.get(mNew.id))?.id, mNew.id);
  assert.equal((await repo.matches.getOpen("s1"))?.id, mOpen.id, "the open round survives even though it started before the cutoff");
  assert.equal((await repo.matches.statsForMatch(mOld.id)).length, 0);
  assert.equal((await repo.matches.statsForMatch(mNew.id)).length, 1);
  assert.deepEqual((await repo.mapVote.history("s1")).map((h) => h.decidedAt), [NEW]);
  assert.deepEqual((await repo.mapVote.ballots("d1")).map((b) => b.decidedAt), [NEW], "the old ballot went with its vote");
  const cams = await repo.adminCam.list({});
  assert.equal(cams.filter((c) => c.exitedAt === null).length, 1, "the admin still in camera is untouched");
  assert.deepEqual(cams.filter((c) => c.exitedAt !== null).map((c) => c.exitedAt), [NEW]);
  assert.deepEqual((await repo.playerIps.list("p1")).map((r) => r.ip), ["2.2.2.2"]);
  assert.deepEqual((await repo.playerAliases.list("p1")).map((a) => a.value), ["NewName"]);
  const audit = await repo.audit.list({});
  assert.deepEqual(audit.map((a) => a.action), ["test.new"]);
  // The permanent marker outlived a trim whose cutoff is years past it — the whole point of the
  // prefix. Its scratch neighbour from the same namespace and the same instant did not.
  assert.equal(await repo.pluginKv.get("vip-registration", "keep:daysBonus:111222333444"), true,
    "a keep: row records something irreversible and must survive any retention sweep");
  assert.equal(await repo.pluginKv.get("vip-registration", "old-user"), undefined, "…while spent scratch is collected");
  assert.deepEqual(await repo.pluginKv.get("vip-registration", "live-user"), { codeHash: "x" });

  // And a second pass finds nothing: the cutoff was honoured exactly, not approximately.
  const again = await repo.trimData.preview(ids, cutoff);
  for (const id of ids) assert.equal(again[id], 0, `${id} should have nothing left to trim`);

  // No backup requested → no file written, deletion identical.
  const repo2 = new InMemoryRepository();
  await repo2.rosterSnapshots.record({ serverId: "s1", ts: OLD, playerCount: 5, composition: {} });
  const bare = await repo2.trimData.run(["rosterSnapshots"], cutoff, null);
  assert.equal(bare.rosterSnapshots!.deleted, 1);
  assert.equal(bare.rosterSnapshots!.backupPath, null);
});

test("data port catalog: every table is exportable or excluded on purpose, exactly once", async () => {
  const { DATA_EXPORT_GROUPS, DATA_EXPORT_EXCLUDED, tablesForDataGroups } = await import("../dist/index.js");
  const src = readFileSync(new URL("../src/migrations.ts", import.meta.url), "utf8");
  const schemaTables = new Set([...src.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1] as string));
  // …minus what a later migration DROPPED. The scan used to count creations only, so a table the
  // schema had since retired still looked placeable — and the catalogue kept exporting the
  // long-gone `blacklists`, which made the whole Bans group (and the first full backup) fail with
  // "relation does not exist". The blind spot and the stale entry survived each other for months
  // precisely because they agreed.
  for (const m of src.matchAll(/DROP TABLE (?:IF EXISTS )?([a-z_]+)/g)) schemaTables.delete(m[1] as string);

  // Exactly-once assignment: a table in two groups would export (and import) twice.
  const assigned = new Map<string, string>();
  for (const g of DATA_EXPORT_GROUPS) {
    for (const t of g.tables) {
      assert.ok(!assigned.has(t), `${t} is in both "${assigned.get(t)}" and "${g.id}"`);
      assert.ok(!(t in DATA_EXPORT_EXCLUDED), `${t} is both exportable (${g.id}) and excluded`);
      assert.ok(schemaTables.has(t), `group "${g.id}" names a table that does not exist: ${t}`);
      assigned.set(t, g.id);
    }
    for (const need of g.needs ?? []) {
      assert.ok(DATA_EXPORT_GROUPS.some((o: { id: string }) => o.id === need), `group "${g.id}" needs unknown group "${need}"`);
    }
  }
  // Full coverage: a new table must be placed in a group or excluded BY NAME with a reason —
  // otherwise it silently cannot be migrated, which is how data gets stranded.
  for (const t of schemaTables) {
    assert.ok(assigned.has(t) || t in DATA_EXPORT_EXCLUDED,
      `table "${t}" is neither in an export group nor in DATA_EXPORT_EXCLUDED — decide, and say why`);
  }
  for (const t of Object.keys(DATA_EXPORT_EXCLUDED)) {
    if (t === "schema_migrations") continue; // created by the migrate() bootstrap, not the chain
    assert.ok(schemaTables.has(t), `excluded table "${t}" does not exist in the schema`);
  }

  // Selection helper: catalog order (parents first), unknown ids refused by name.
  const tables = tablesForDataGroups(["accounts", "servers"]);
  assert.ok(tables.indexOf("servers") < tables.indexOf("users"), "servers precede accounts whatever order was asked for");
  assert.throws(() => tablesForDataGroups(["bogus"]), /unknown export group/);

  // The memory store answers honestly rather than faking an archive.
  const repo = new InMemoryRepository();
  assert.equal(repo.dataPort.supported, false);
  await assert.rejects(() => repo.dataPort.counts(["settings"]), /Postgres/);
});

test("live roster lookups: open sessions on one server, visits for many players at once", async () => {
  const repo = new InMemoryRepository();
  await repo.sessions.open("p1", "s1", "2026-08-15T10:00:00.000Z");
  await repo.sessions.open("p2", "s1", "2026-08-15T11:00:00.000Z");
  await repo.sessions.open("p3", "s2", "2026-08-15T09:00:00.000Z");
  const open = await repo.sessions.openOnServer("s1");
  assert.equal(open.size, 2);
  assert.equal(open.get("p1"), "2026-08-15T10:00:00.000Z");
  assert.equal(open.get("p3"), undefined, "another server's session must not leak in");

  await repo.stats.bump("p1", "s1", { visits: 1, playtimeSec: 600 });
  await repo.stats.bump("p1", "s1", { visits: 1, playtimeSec: 300 });
  await repo.stats.bump("p1", "s2", { visits: 5 }); // a different server's history stays there
  const v = await repo.stats.visitsFor(["p1", "p2"], "s1");
  assert.equal(v.get("p1")?.visits, 2);
  assert.equal(v.get("p1")?.playtimeSec, 900);
  assert.equal(v.get("p2"), undefined, "no record means no entry — the panel shows a dash, not a zero");
});

test("countImportedEvents: the dry run's store reports the same numbers without keeping the rows", async () => {
  // The CRCON dry run runs the real transform into a throwaway store to report what an Apply WOULD
  // land. Holding a row per event costs gigabytes on a real history, so imported events are counted
  // and dropped — which is only safe if every number the report is built from is unchanged.
  const rows = [
    { serverId: "s1", ts: "2025-01-01T00:00:00.000Z", kind: "evt.kill", actorName: "a", victimName: "b", dedupeKey: "crcon:1" },
    { serverId: "s1", ts: "2025-01-02T00:00:00.000Z", kind: "evt.kill", actorName: "c", victimName: "d", dedupeKey: "crcon:2" },
    { serverId: "s1", ts: "2025-01-03T00:00:00.000Z", kind: "evt.teamkill", actorName: "e", victimName: "f", dedupeKey: "crcon:3" },
  ];
  const full = new InMemoryRepository();
  const counting = new InMemoryRepository({ countImportedEvents: true });

  // The insert's RETURN is what the transform counts by, so it has to agree row for row.
  assert.equal((await full.events.insert(rows)).length, 3);
  assert.equal((await counting.events.insert(rows)).length, 3);

  // Dedupe still applies: a repeat is skipped in both, so a re-run cannot inflate the report.
  assert.equal((await full.events.insert(rows)).length, 0);
  assert.equal((await counting.events.insert(rows)).length, 0);

  // The bodies are gone in counting mode — that IS the saving.
  assert.equal((await full.events.listRecent("s1")).length, 3);
  assert.equal((await counting.events.listRecent("s1")).length, 0);

  // The cutoff the whole overlap rule depends on is unaffected: it ignores crcon: rows by design,
  // and the dry run seeds one local event at the real cutoff, which must still be found.
  assert.equal(await full.events.firstLocalTs("s1"), null);
  assert.equal(await counting.events.firstLocalTs("s1"), null);
  const seed = [{ serverId: "s1", ts: "2026-02-02T00:00:00.000Z", kind: "evt.kill", dedupeKey: "dry-run-cutoff" }];
  await full.events.insert(seed);
  await counting.events.insert(seed);
  assert.equal(await full.events.firstLocalTs("s1"), "2026-02-02T00:00:00.000Z");
  assert.equal(await counting.events.firstLocalTs("s1"), "2026-02-02T00:00:00.000Z");

  // A locally-recorded event is still stored in full — only imported rows are dropped.
  assert.equal((await counting.events.listRecent("s1")).length, 1);
});

/*
 * The memory store must agree with Postgres on the game's own counters and the unit history.
 *
 * These two stores have drifted before precisely here: the memory one spreads its input object, so
 * a field can look persisted while the SQL store writes nothing. The Postgres side of this exact
 * scenario is in postgres.test.ts — keep the two together, and change them together.
 */
test("memory store: game counters bank across a reconnect, and units append only on change", async () => {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "M", host: "10.0.0.1", port: 1, password: "x" });
  const match = await repo.matches.open({ serverId: server.id, map: "foy_warfare", startedAt: new Date(Date.now() - 300_000).toISOString() });
  const platformId = "76561198000000123";
  await repo.players.upsertMany([{ game: "hll", platform: "steam", platformId, name: "Ana", ts: new Date().toISOString() }]);

  const sample = (over: Record<string, unknown>) => repo.stats.sampleRoster({
    serverId: server.id, matchId: match.id, sampleSec: 60,
    players: [{ platformId, name: "Ana", role: 1, isSquadLead: false, level: 5, side: "allies", squad: 3, ...over } as any],
  });
  const line = async () => (await repo.matches.statsForMatch(match.id))[0];

  await sample({ score: { killsAndAssists: 10, deathsAndRedeploys: 4 } });
  assert.equal((await line())!.killsAndAssists, 10);
  assert.equal((await line())!.units.length, 1);
  assert.deepEqual(
    (({ team, squad, role }) => ({ team, squad, role }))((await line())!.units[0]!),
    { team: 1, squad: 3, role: 1 },
  );

  await sample({ score: { killsAndAssists: 15, deathsAndRedeploys: 6 } });
  assert.equal((await line())!.units.length, 1, "an unchanged unit must not append a leg per poll");

  await sample({ squad: 7, score: { killsAndAssists: 16, deathsAndRedeploys: 6 } });
  assert.equal((await line())!.units.length, 2, "changing squad appends exactly one leg");

  // The reconnect: the game's counters restart, and the pre-reconnect total must survive.
  await sample({ squad: 7, score: { killsAndAssists: 2, deathsAndRedeploys: 1 } });
  const l = await line();
  assert.equal(l!.killsAndAssistsPrev, 16, "banked, not lost");
  assert.equal(l!.killsAndAssists, 2);
  assert.equal(l!.killsAndAssistsPrev + l!.killsAndAssists, 18, "what the API publishes");
  assert.equal(l!.deathsAndRedeploysPrev + l!.deathsAndRedeploys, 7);
});

test("sessions.closeAbsent: reaps sessions the roster no longer backs; the grace keeps fresh ones", async () => {
  const repo = new InMemoryRepository();
  const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765611980000131", name: "A" });
  const b = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765611980000132", name: "B" });
  const c = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765611980000133", name: "C" });
  const old = "2026-01-02T10:00:00.000Z";
  const fresh = "2026-01-02T11:59:30.000Z";
  const graceCutoff = "2026-01-02T11:57:00.000Z"; // sessions opened after this are too fresh to judge
  const now = "2026-01-02T12:00:00.000Z";
  await repo.sessions.open(a.id, "s1", old); // present on the roster → kept
  await repo.sessions.open(b.id, "s1", old); // absent + old → reaped (the banned-but-still-ONLINE row)
  await repo.sessions.open(c.id, "s1", fresh); // absent but inside the grace → kept (the connect race)
  await repo.sessions.open(b.id, "s2", old); // another server → not this reap's business

  assert.equal(await repo.sessions.closeAbsent("s1", [a.id], graceCutoff, now), 1);
  assert.deepEqual(await repo.sessions.openServers(a.id), ["s1"], "present players keep their session");
  assert.deepEqual(await repo.sessions.openServers(b.id), ["s2"], "reaped on s1, untouched on s2");
  assert.deepEqual(await repo.sessions.openServers(c.id), ["s1"], "the grace holds fire on a fresh connect");

  // The reaped session lands in history exactly as a normal close would, stamped with the sweep time.
  const hist = await repo.sessions.list(b.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.serverId, "s1");
  assert.equal(hist[0]!.disconnectedAt, now);
  assert.equal(hist[0]!.durationSec, 7200);

  // An EMPTY roster is a valid roster — the whole-lobby-stranded-by-a-crash case reaps everyone old.
  assert.equal(await repo.sessions.closeAbsent("s1", [], graceCutoff, now), 1, "A's session goes once the roster says empty");
  assert.deepEqual(await repo.sessions.openServers(a.id), []);
  assert.deepEqual(await repo.sessions.openServers(c.id), ["s1"], "still inside the grace either way");
});

test("linked identities are searchable, and the same account's rows find each other", async () => {
  const repo = new InMemoryRepository();
  // One human, two games: the Vietnam row links the permanent Xbox XUID; the WW2 row links it too.
  const vn = await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: "0002cb51e95e40538440e20a11491f36", name: "CrimePays410" });
  const ww2 = await repo.players.upsert({ game: "hll", platform: "xbox", platformId: "00028c38e7b748799a502ce7c3d41616", name: "CrimePays410" });
  const stranger = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000091", name: "Someone" });
  await repo.externalLinks.set(vn.id, "xbox", "2533274823952388");
  await repo.externalLinks.set(ww2.id, "xbox", "2533274823952388");

  // Search by the LINKED id — the number staff hold from another surface — finds both rows.
  const hits = await repo.players.search("2533274823952388");
  assert.deepEqual(hits.map((p) => p.id).sort(), [vn.id, ww2.id].sort());
  assert.ok(!hits.some((p) => p.id === stranger.id));

  // The directory's q filter matches it the same way (the Players page search box).
  const dir = await repo.players.directory({ q: "2533274823952388" });
  assert.deepEqual(dir.map((p) => p.id).sort(), [vn.id, ww2.id].sort());

  // And the reverse account lookup answers across providers, which is what the profile's
  // "same account on" list is built from.
  const same = await repo.externalLinks.findPlayersByExternalId("2533274823952388");
  assert.deepEqual(same.map((p) => p.id).sort(), [vn.id, ww2.id].sort());
});

/*
 * `economy.ledger` with no `limit` returns a PAGE, and the page is the same size in both stores.
 *
 * It was not: Postgres served 100 rows and the memory store served every row a member had ever
 * had. Nothing failed, because nothing in the tests owns more than a handful of entries — so a
 * caller that forgot a limit read the whole ledger here and a truncated one in production, and no
 * test could tell them apart. The ledger is append-only and unbounded, so the page is the honest
 * answer; this pins it against the shared constant rather than against either store's habit.
 */
test("economy: a ledger read with no limit is one page, the same page in every store", async () => {
  const repo = new InMemoryRepository();
  const rows = ECONOMY_LEDGER_PAGE + 5;
  for (let i = 0; i < rows; i++) {
    await repo.economy.apply({ discordId: "dp", delta: 1, reason: `entry ${i}`, ref: `p:${i}` });
  }
  assert.equal(await repo.economy.ledgerCount("dp"), rows, "every entry was written");

  const page = await repo.economy.ledger("dp");
  assert.equal(page.length, ECONOMY_LEDGER_PAGE, "no limit must mean one page, not the whole ledger");
  assert.equal(page[0]!.reason, `entry ${rows - 1}`, "newest first");

  // …and an explicit limit still wins, in both directions.
  assert.equal((await repo.economy.ledger("dp", { limit: 3 })).length, 3);
  assert.equal((await repo.economy.ledger("dp", { limit: rows })).length, rows);
  // The second page picks up exactly where the first left off.
  const second = await repo.economy.ledger("dp", { offset: ECONOMY_LEDGER_PAGE });
  assert.equal(second.length, 5);
  assert.equal(second[0]!.reason, `entry ${rows - 1 - ECONOMY_LEDGER_PAGE}`);
});

/*
 * A connect with no disconnect between must BANK the session that was already open, not erase it.
 *
 * The store used to overwrite `connected_at`, and the game does not always send a disconnect — a
 * server restart sends none at all. A player who rejoined quickly, before the roster reaper's next
 * successful read could notice they were gone, lost the whole evening: no session row, no career
 * playtime, and nothing under a payout window asking who was present. Nothing said so.
 */
test("sessions: a second connect banks the open session instead of overwriting it", async () => {
  const repo = new InMemoryRepository();
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "9001", name: "Rejoin", ts: "2026-03-01T00:00:00.000Z" });

  // On at 20:00. The server dies at 22:00 and logs nothing; they are back at 22:05.
  assert.equal(await repo.sessions.open(p.id, "s1", "2026-03-01T20:00:00.000Z"), 0, "nothing was open to bank");
  const banked = await repo.sessions.open(p.id, "s1", "2026-03-01T22:05:00.000Z");
  assert.equal(banked, 7500, "the two hours before the restart are recorded, ended at the reconnect");

  const history = await repo.sessions.list(p.id);
  assert.equal(history.length, 1, "the pre-restart session exists as a row");
  assert.equal(history[0]!.connectedAt, "2026-03-01T20:00:00.000Z");
  assert.equal(history[0]!.disconnectedAt, "2026-03-01T22:05:00.000Z");

  // …and a payout window over the evening can see them.
  const inWindow = await repo.sessions.inWindow("s1", "2026-03-01T19:00:00.000Z", "2026-03-01T23:00:00.000Z");
  assert.equal(inWindow.length, 1);
  assert.equal(inWindow[0]!.playerId, p.id);

  // The new session is the open one, and closes normally.
  assert.deepEqual(await repo.sessions.openServers(p.id), ["s1"]);
  assert.equal(await repo.sessions.close(p.id, "s1", "2026-03-01T23:05:00.000Z"), 3600);
  assert.equal((await repo.sessions.list(p.id)).length, 2);

  // A connect NOT newer than the open one is old news arriving late: it banks nothing and leaves
  // the newer row alone, rather than dragging the start backwards.
  await repo.sessions.open(p.id, "s1", "2026-03-02T10:00:00.000Z");
  assert.equal(await repo.sessions.open(p.id, "s1", "2026-03-02T09:00:00.000Z"), 0);
  assert.equal(await repo.sessions.close(p.id, "s1", "2026-03-02T10:30:00.000Z"), 1800, "the open session still started at 10:00");
});

/*
 * The Economy Activity feed: every member's movements in one list, classified by the ref each
 * writer already stamps. The classifier and the store must agree with the REAL writers — these
 * refs are copied from the call sites (shop.ts, payouts.ts, discord-public.ts, the seeding
 * worker), so a writer changing its prefix breaks this test instead of silently vanishing a
 * whole family from the feed.
 */
test("economy activity: one cross-member feed, classified by ref, filterable, newest first", async () => {
  const repo = new InMemoryRepository();
  const rows: [string, number, string, string | null][] = [
    ["a", 500, "seed", null],                                          // adjust (staff, no ref)
    ["a", -250, "VIP shop: Two Weeks", "buy:ix1"],                     // purchase (Discord)
    ["b", 300, "seed", null],                                          // adjust
    ["b", -100, "gift to A", "gift:ix2"],                              // gift out
    ["a", 100, "gift received", "gift-in:gift:ix2"],                   // gift in
    ["a", 20, "daily claim", "claim:daily:a:2026-08-30"],              // claim
    ["b", 250, "refund: Two Weeks — no server accepted the grant", "refund:buy:ix3"], // refund
    ["a", 75, "Event payout", "payout:job1:a"],                        // payout
    ["b", 40, "Seed reward on S1", "seed:s1:2026-08-30T00:00:00.000Z:p1"], // seed reward
    ["a", -50, "VIP shop: staff buy", "staff-buy:u1"],                 // purchase (panel)
  ];
  for (const [who, delta, reason, ref] of rows) {
    await repo.economy.apply({ discordId: who, delta, reason, ref: ref ?? undefined, discordName: who === "a" ? "Alice" : "Bob" });
  }

  const all = await repo.economy.activity();
  assert.equal(all.total, rows.length);
  assert.equal(all.entries[0]!.reason, "VIP shop: staff buy", "newest first");
  assert.equal(all.entries[0]!.discordName, "Alice", "the member's name rides along");

  const kindOf = (feed: { entries: { reason: string }[] }) => feed.entries.map((e) => e.reason).sort();
  assert.deepEqual(kindOf(await repo.economy.activity({ kind: "purchase" })), ["VIP shop: Two Weeks", "VIP shop: staff buy"]);
  assert.deepEqual(kindOf(await repo.economy.activity({ kind: "gift" })), ["gift received", "gift to A"]);
  assert.deepEqual(kindOf(await repo.economy.activity({ kind: "refund" })), ["refund: Two Weeks — no server accepted the grant"]);
  assert.deepEqual(kindOf(await repo.economy.activity({ kind: "payout" })), ["Event payout"]);
  assert.deepEqual(kindOf(await repo.economy.activity({ kind: "seed" })), ["Seed reward on S1"]);
  assert.deepEqual(kindOf(await repo.economy.activity({ kind: "adjust" })), ["seed", "seed"]);
  // Overlap rules: a refund of a purchase is a REFUND, not a purchase; gift-in is a gift.
  assert.equal((await repo.economy.activity({ kind: "purchase" })).total, 2);
  assert.equal(economyActivityKind("refund:buy:x"), "refund");
  assert.equal(economyActivityKind("gift-in:gift:x"), "gift");
  // Paging.
  const page = await repo.economy.activity({ limit: 3, offset: 3 });
  assert.equal(page.entries.length, 3);
  assert.equal(page.total, rows.length);
  // A typo'd kind is nothing, never everything.
  assert.deepEqual(await repo.economy.activity({ kind: "purchases" }), { entries: [], total: 0 });
  // Every declared kind is a real family the classifier can produce.
  for (const kind of Object.keys(ECONOMY_ACTIVITY_KINDS)) {
    assert.ok((await repo.economy.activity({ kind })).total >= 0);
  }
});

/*
 * Migration-chain invariants, checkable with no database: ids unique (a duplicate id would mark
 * one migration applied and silently skip the other forever) and the numeric prefixes strictly
 * ascending (the runner applies in array order; a mis-numbered insert would apply out of order on
 * fresh installs while upgraded ones already ran it last).
 */
test("migrations: ids are unique and numerically ordered", async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const ids = MIGRATIONS.map((m: { id: string }) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate migration id");
  const nums = ids.map((id: string) => Number(id.split("_")[0]));
  for (const [i, v] of nums.entries()) {
    assert.ok(Number.isFinite(v), `migration id "${ids[i]}" carries no numeric prefix`);
    if (i > 0) assert.ok(v > nums[i - 1]!, `"${ids[i]}" is not numbered after "${ids[i - 1]}"`);
  }
});

test("weapon-kill rollups: replace on re-run, stamp even when empty, feed weapon and class boards", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.1", port: 28865, password: "p" });
  const ada = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "311", name: "Ada" });
  const bea = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "312", name: "Bea" });
  const m1 = await repo.matches.open({ serverId: s.id, map: "carentan_warfare", startedAt: "2026-07-02T10:00:00.000Z" });
  await repo.matches.close(m1.id, { endedAt: "2026-07-02T11:00:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: null });
  const m2 = await repo.matches.open({ serverId: s.id, map: "foy_warfare", startedAt: "2026-07-02T12:00:00.000Z" });
  await repo.matches.close(m2.id, { endedAt: "2026-07-02T13:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });

  assert.deepEqual((await repo.matches.pendingWeaponRollup(10)).map((m) => m.id), [m2.id, m1.id], "newest first, so fresh records surface before the backfill");

  await repo.matches.saveWeaponRollup(m1.id, [
    { playerId: ada.id, weapon: "MG42", classId: "mg", kills: 5, deaths: 0 },
    { playerId: ada.id, weapon: "DP-27", classId: "mg", kills: 2, deaths: 0 },
    { playerId: bea.id, weapon: "MG42", classId: "mg", kills: 2, deaths: 5 },
    { playerId: ada.id, weapon: "M1 GARAND", classId: "rifle", kills: 3, deaths: 0 },
    { playerId: bea.id, weapon: "155MM HOWITZER", classId: "artillery", kills: 0, deaths: 4 },
  ]);
  await repo.matches.saveWeaponRollup(m2.id, []); // a round with no kill log
  assert.deepEqual(await repo.matches.pendingWeaponRollup(10), [], "an empty fold still stamps the round — nothing is re-scanned forever");

  assert.deepEqual((await repo.matches.classesWithData(s.id)).sort(), ["artillery", "mg", "rifle"]);
  // The class record SUMS the class's weapons for the round and names the carrying weapon.
  const top = await repo.matches.topClassKills(s.id, "mg", 5);
  assert.equal(top[0]!.playerName, "Ada");
  assert.equal(top[0]!.value, 7, "5 with the MG42 plus 2 with the DP-27");
  assert.equal(top[0]!.weapon, "MG42", "the record says which weapon carried it");
  assert.equal(top[0]!.matchSeq, m1.seq, "a class record names its round like every other record");

  // The individual-weapon reads.
  assert.deepEqual(await repo.matches.weaponSummary(s.id, 5), [
    { weapon: "MG42", classId: "mg", totalKills: 7 },
    { weapon: "M1 GARAND", classId: "rifle", totalKills: 3 },
    { weapon: "DP-27", classId: "mg", totalKills: 2 },
  ]);
  const mgTop = await repo.matches.topWeaponKills(s.id, "MG42", 5);
  assert.deepEqual(mgTop.map((r) => ({ name: r.playerName, value: r.value })), [{ name: "Ada", value: 5 }, { name: "Bea", value: 2 }]);
  assert.equal((await repo.matches.weaponSummary(s.id, 10)).some((w) => w.weapon === "155MM HOWITZER"), false,
    "a died-to-only weapon draws no KILL board");
  assert.deepEqual((await repo.matches.classDeathTotals(s.id, "artillery", 5)).map((t) => ({ name: t.name, deaths: t.deaths })),
    [{ name: "Bea", deaths: 4 }], "…but the victim side finds it");
  assert.deepEqual((await repo.matches.weaponDeathTotals(s.id, "MG42", 5)).map((t) => ({ name: t.name, deaths: t.deaths })),
    [{ name: "Bea", deaths: 5 }]);
  assert.deepEqual(await repo.matches.playerWeaponDeathTotals(s.id, bea.id, 5),
    [{ weapon: "MG42", deaths: 5 }, { weapon: "155MM HOWITZER", deaths: 4 }]);
  assert.deepEqual(await repo.matches.playerWeaponTotals(s.id, ada.id, 5), [
    { weapon: "MG42", kills: 5 }, { weapon: "M1 GARAND", kills: 3 }, { weapon: "DP-27", kills: 2 },
  ]);

  // A re-run REPLACES the round's rollup — corrected, never double-counted.
  await repo.matches.saveWeaponRollup(m1.id, [{ playerId: ada.id, weapon: "MG42", classId: "mg", kills: 4, deaths: 0 }]);
  const totals = await repo.matches.weaponTotals(s.id, "MG42", 5);
  assert.deepEqual(totals.map((t) => ({ name: t.name, kills: t.kills })), [{ name: "Ada", kills: 4 }]);
});

test("objective points: omitted halves keep, blank halves clear, an empty row drops", async () => {
  const repo = new InMemoryRepository();
  // Teach the name first, the cell second — each write leaves the other half alone.
  await repo.objectivePoints.set("hll", "carentan", 0, 1, { name: "Rail Crossing" });
  const both = await repo.objectivePoints.set("hll", "carentan", 0, 1, { sector: "E6" });
  assert.equal(both?.name, "Rail Crossing");
  assert.equal(both?.sector, "E6");
  // Blank clears that half only; the row survives on the other.
  const nameless = await repo.objectivePoints.set("hll", "carentan", 0, 1, { name: "" });
  assert.equal(nameless?.name, null);
  assert.equal(nameless?.sector, "E6");
  // The read is keyed by game AND map family — a Vietnam row on the same key never bleeds in.
  await repo.objectivePoints.set("hllv", "carentan", 0, 1, { name: "Not This One" });
  const rows = await repo.objectivePoints.forMap("hll", "carentan");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, null);
  // Clearing the last half drops the row entirely — no empty husks in the table.
  assert.equal(await repo.objectivePoints.set("hll", "carentan", 0, 1, { sector: null }), null);
  assert.deepEqual(await repo.objectivePoints.forMap("hll", "carentan"), []);
});

test("data port: presets never ride in an archive, the press in flight is live state, learned names travel with Maps", async () => {
  const { DATA_EXPORT_GROUPS, DATA_EXPORT_EXCLUDED } = await import("../dist/index.js");
  // Every export is open to any admin.data holder — a preset in ANY group would hand owner-only
  // picks to people the tab hides them from.
  for (const g of DATA_EXPORT_GROUPS) {
    assert.ok(!g.tables.includes("map_point_presets"), `presets must not be exportable (found in "${g.id}")`);
    assert.ok(!g.tables.includes("map_point_pending"), `the press in flight must not be exportable (found in "${g.id}")`);
  }
  assert.ok(DATA_EXPORT_EXCLUDED.map_point_presets);
  assert.ok(DATA_EXPORT_EXCLUDED.map_point_pending);
  assert.ok(DATA_EXPORT_GROUPS.find((g: { id: string }) => g.id === "maps")?.tables.includes("objective_grids"));
});

test("banScopeCovers: the rule the reconciler decides real bans with", () => {
  /*
   * This is the copy that runs. The API carried a second implementation of the same three lines
   * and the tests pointed at THAT one, so the rule that actually shapes a game server's ban list
   * had no direct coverage and the two could have drifted apart unnoticed. The API's now delegates
   * here; these are the cases it used to carry, plus the empty-list edges nothing pinned.
   */
  assert.equal(banScopeCovers({ mode: "all" }, "anything"), true, "every server, including ones added later");

  assert.equal(banScopeCovers({ mode: "servers", serverIds: ["a", "b"] }, "a"), true);
  assert.equal(banScopeCovers({ mode: "servers", serverIds: ["a", "b"] }, "c"), false, "a list is a snapshot — a new server is not in it");
  assert.equal(banScopeCovers({ mode: "servers", serverIds: [] }, "a"), false, "'these servers, and there are none' covers nothing");

  assert.equal(banScopeCovers({ mode: "except", serverIds: ["b"] }, "a"), true);
  assert.equal(banScopeCovers({ mode: "except", serverIds: ["b"] }, "b"), false);
  assert.equal(banScopeCovers({ mode: "except", serverIds: ["b"] }, "d"), true, "except covers a server it has never seen");
  assert.equal(banScopeCovers({ mode: "except", serverIds: [] }, "a"), true, "except nothing resolves like all");

  // Ids are compared exactly: a scope must not half-match a server whose id merely looks similar.
  assert.equal(banScopeCovers({ mode: "servers", serverIds: ["ab"] }, "a"), false);
  assert.equal(banScopeCovers({ mode: "except", serverIds: ["ab"] }, "a"), true);
});

test("the small decisions nothing was pinning: automation defaults, the keep: prefix, K/D at zero deaths", () => {
  /*
   * Three one-liners that no test named, each carrying a property the next refactor could flip
   * without anything noticing — and each with consequences out of all proportion to its size.
   */

  // The stored automation map is a list of EXCEPTIONS. Absent means enabled, so a server that has
  // never had a switch touched runs everything. Invert this and every automation on every server
  // stops at once, silently, the way "nothing configured" usually means "nothing happens".
  assert.equal(automationEnabled(undefined, "mapvote"), true, "a server with no automation row runs everything");
  assert.equal(automationEnabled(null, "seeding"), true);
  assert.equal(automationEnabled({}, "broadcast"), true, "an empty map is no exceptions, not no automation");
  assert.equal(automationEnabled({ mapvote: false }, "mapvote"), false, "an explicit false is the only way off");
  assert.equal(automationEnabled({ mapvote: false }, "seeding"), true, "and it switches off only its own key");
  assert.equal(automationEnabled({ mapvote: true }, "mapvote"), true);
  // …except the reconcilers' fixes, which act on the game with nobody pressing: absent is OFF, and
  // only an explicit true arms one. (They were deploy flags, off unless set, for every server.)
  assert.equal(automationEnabled(undefined, "banSyncApply"), false, "a server nobody armed only reports");
  assert.equal(automationEnabled({}, "vipSyncApply"), false);
  assert.equal(automationEnabled({ banSyncApply: true }, "banSyncApply"), true);
  assert.equal(automationEnabled({ banSyncApply: true }, "vipSyncApply"), false, "arming the ban fix arms nothing else");
  assert.equal(automationEnabled({ banSyncApply: true }, "banSync"), true, "and the reconciler itself still defaults on");

  // What the retention sweep must not delete. The prefix is the whole contract between a plugin
  // that needs a marker to outlive a trim and a sweep that knows nothing about what the key means.
  assert.equal(isPermanentKvKey(`${PERMANENT_KV_PREFIX}seen-this-player`), true);
  assert.equal(isPermanentKvKey("seen-this-player"), false);
  assert.equal(isPermanentKvKey(`not-${PERMANENT_KV_PREFIX}anchored`), false, "the prefix anchors at the START — a key that merely contains it is trimmable");
  assert.equal(isPermanentKvKey(""), false);

  // Zero deaths is not a division, and it is not zero either: a player with 7 kills and no deaths
  // has a K/D of 7, which is what every scoreboard in the genre shows.
  assert.equal(computeKd(7, 0), 7);
  assert.equal(computeKd(0, 0), 0);
  assert.equal(computeKd(0, 5), 0);
  assert.equal(computeKd(7, 2), 3.5);
  assert.equal(computeKd(1, 3), 0.33, "rounded to two places, not left as a repeating fraction");
});

test("matches: CRCON's record of a round's start is made once, apart from our own morale", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.9", port: 28865, password: "p" });
  const m = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt: "2026-09-24T10:00:00.000Z" });
  assert.deepEqual([m.crconMap, m.crconGuessed, m.crconInitialMorale], [null, null, null], "undecided until the worker decides");
  await repo.matches.recordStart(m.id, { map: "carentan_warfare_night", guessed: false, matchTime: 5400, initialMorale: 0 });
  await repo.matches.recordStart(m.id, { map: "carentan_warfare", guessed: true, matchTime: 1, initialMorale: 7 });
  let row = await repo.matches.get(m.id);
  assert.deepEqual([row?.crconMap, row?.crconGuessed, row?.matchTime, row?.crconInitialMorale], ["carentan_warfare_night", false, 5400, 0], "the first decision stands");
  assert.deepEqual([row?.map, row?.initialMorale], ["CARENTAN Warfare", null], "the log text and our own morale are untouched");
  // The recorder's first Conquest flip sets CRCON's initial_morale, never ours.
  const c = await repo.matches.open({ serverId: s.id, map: "CARENTAN Conquest", startedAt: "2026-09-24T12:00:00.000Z" });
  await repo.matches.recordTimeline(c.id, { flip: [30, 1, 0], morale: [30, 490, 470], initialMorale: 500 });
  row = await repo.matches.get(c.id);
  assert.deepEqual([row?.crconInitialMorale, row?.initialMorale], [500, null]);
  // CRCON's verdict on the whistle is made once, too.
  assert.equal(row?.crconEndDeferred, null);
  await repo.matches.recordEnd(c.id, { deferred: true });
  await repo.matches.recordEnd(c.id, { deferred: false });
  assert.equal((await repo.matches.get(c.id))?.crconEndDeferred, true);
});

test("events: a window reads past one page — the newest `limit` of it, oldest first", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Win", host: "1.1.1.8", port: 28866, password: "p" });
  const t0 = Date.parse("2026-09-24T10:00:00.000Z");
  await repo.events.insert(Array.from({ length: 600 }, (_, i) => ({ serverId: s.id, ts: new Date(t0 + i * 1000).toISOString(), kind: "evt.kill", dedupeKey: `w${String(i).padStart(3, "0")}` })));
  await repo.events.insert([{ serverId: s.id, ts: new Date(t0 + 5000).toISOString(), kind: "evt.chat.team", dedupeKey: "chat" }]);
  assert.equal((await repo.events.query({ serverId: s.id, kinds: ["evt.kill"], limit: 20_000 })).length, 500, "a page stops at 500");
  const all = await repo.events.window({ serverId: s.id, kinds: ["evt.kill"], limit: 20_000 });
  assert.equal(all.length, 600);
  assert.deepEqual([all[0]!.dedupeKey, all[599]!.dedupeKey], ["w000", "w599"], "oldest first");
  const newest = await repo.events.window({ serverId: s.id, kinds: ["evt.kill"], from: new Date(t0 + 10_000).toISOString(), limit: 100 });
  assert.deepEqual([newest.length, newest[0]!.dedupeKey, newest[99]!.dedupeKey], [100, "w500", "w599"], "over the limit, the newest");
});

test("matches: a short round leaves our records but stays on CRCON's list, until its server's data goes", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.9", port: 28865, password: "p" });
  const long = await repo.matches.open({ serverId: s.id, map: "FOY Warfare", startedAt: "2026-09-24T10:00:00.000Z" });
  await repo.matches.close(long.id, { endedAt: "2026-09-24T11:00:00.000Z", winner: null, alliedScore: 2, axisScore: 2, result: null });
  const short = await repo.matches.open({ serverId: s.id, map: "KURSK Warfare", startedAt: "2026-09-24T11:01:00.000Z" });
  await repo.matches.recordStart(short.id, { map: "kursk_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
  const players: CrconPlayerCache = [["76561190000000001", { combat: 5, p_combat: 50, offense: 0, p_offense: 0, defense: 0, p_defense: 0, support: 0, p_support: 0, vehicle_kills: 0, p_vehicle_kills: 0, vehicles_destroyed: 0, p_vehicles_destroyed: 0, kills_and_assists: 1, p_kills_and_assists: 4, deaths_and_redeploys: 0, p_deaths_and_redeploys: 1, p_unit: { ts: 160, team: 1, squad: 1, role: 0 }, units: [{ ts: 160, team: 1, squad: 1, role: 0 }], level: 40, p_coord: { x: 1.5, y: 2, z: 3 }, has_spawned: true, names: ["Able"], status: "online" }]];
  await repo.matches.saveCrconPlayers(short.id, players);
  assert.equal(await repo.matches.discardShort(short.id, "2026-09-24T11:02:00.000Z", "`KURSK Warfare` ALLIED (2 - 2) AXIS"), true);
  assert.deepEqual((await repo.matches.list(s.id)).map((m) => m.id), [long.id], "gone from our records");
  assert.equal(await repo.matches.crconPlayers(short.id), null, "its own cache went with it");
  assert.deepEqual(await repo.matches.crconShortRoundPlayers(short.seq), players, "and CRCON's copy keeps the players");
  assert.equal(await repo.matches.crconShortRoundPlayers(long.seq), null);
  const crcon = await repo.matches.crconRounds(s.id, 500, 0);
  assert.deepEqual(crcon.map((r) => [r.short, r.seq, r.crconMap, r.endedAt, r.result, r.matchId]), [
    [true, short.seq, "kursk_warfare", "2026-09-24T11:02:00.000Z", "`KURSK Warfare` ALLIED (2 - 2) AXIS", null],
    [false, long.seq, null, "2026-09-24T11:00:00.000Z", null, long.id],
  ], "newest first, the short round keeping its own public alias and what was decided for it");
  assert.deepEqual((await repo.matches.crconRounds(s.id, 1, 1)).map((r) => r.seq), [long.seq], "paged like the rest");
  // Retention ages it out with the rounds around it.
  const trimmed = await repo.trimData.run(["matches"], "2026-09-24T12:00:00.000Z", null);
  assert.equal(trimmed.matches!.deleted, 1, "the count is our rounds");
  assert.deepEqual(await repo.matches.crconRounds(s.id, 500, 0), []);
  // And it goes with its server.
  const again = await repo.matches.open({ serverId: s.id, map: "KURSK Warfare", startedAt: "2026-09-25T10:00:00.000Z" });
  await repo.matches.discardShort(again.id, "2026-09-25T10:01:00.000Z");
  assert.equal((await repo.matches.crconRounds(s.id, 500, 0)).length, 1);
  await repo.servers.remove(s.id);
  assert.deepEqual(await repo.matches.crconRounds(s.id, 500, 0), []);
});

/*
 * Conquest's scoreline rides the same sample. Two rules matter: only a POSITIVE initialMorale is
 * recorded (every other mode reports zeros on the wire, and a stored 0-0 would read as a finished
 * drain), and a later score-only sample — every non-conquest tick — must never erase morale a
 * conquest tick already recorded.
 */
test("matches: morale is sampled like the score, and a score-only tick cannot erase it", async () => {
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Srv", host: "1.1.1.9", port: 28865, password: "p" });
  const m = await repo.matches.open({ serverId: s.id, map: "junobeach_conquest_day", startedAt: "2026-09-24T10:00:00.000Z" });

  await repo.matches.recordScore(s.id, { alliedScore: 2, axisScore: 3, initialMorale: 5000, alliedMorale: 4100, axisMorale: 2600 });
  let row = await repo.matches.get(m.id);
  assert.deepEqual([row?.initialMorale, row?.alliedMorale, row?.axisMorale], [5000, 4100, 2600]);

  // The score-only tick (what every warfare round sends) keeps the recorded morale.
  await repo.matches.recordScore(s.id, { alliedScore: 2, axisScore: 3 });
  row = await repo.matches.get(m.id);
  assert.deepEqual([row?.initialMorale, row?.alliedMorale, row?.axisMorale], [5000, 4100, 2600], "score-only samples never erase morale");

  // A later conquest tick moves it, and a scoreless close keeps the last sample.
  await repo.matches.recordScore(s.id, { alliedScore: 2, axisScore: 3, initialMorale: 5000, alliedMorale: 3900, axisMorale: 900 });
  const closed = await repo.matches.close(m.id, { endedAt: "2026-09-24T11:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: "MATCH ENDED" });
  assert.deepEqual([closed?.initialMorale, closed?.alliedMorale, closed?.axisMorale], [5000, 3900, 900]);

  // A round that never reported morale stays honestly null.
  const plain = await repo.matches.open({ serverId: s.id, map: "carentan_warfare", startedAt: "2026-09-24T12:00:00.000Z" });
  await repo.matches.recordScore(s.id, { alliedScore: 1, axisScore: 0 });
  assert.deepEqual([(await repo.matches.get(plain.id))?.initialMorale, (await repo.matches.get(plain.id))?.alliedMorale], [null, null]);
});
