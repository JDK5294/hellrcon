/**
 * ONE set of questions, asked of BOTH stores.
 *
 * The two implementations are written separately and tested separately (repo.test.ts drives the
 * in-memory one, postgres.test.ts the real one), so nothing until now made them answer the same
 * way — and a store that quietly disagrees with the other is worse than one that is simply wrong,
 * because every test passes and only production is affected. This file seeds an identical world
 * in each and compares the answers directly.
 *
 * The memory store always runs. Postgres joins when DATABASE_URL is set (as in CI and the local
 * battery), and the two answer sets must match exactly, ids normalised away.
 *
 * Rules for what belongs here: only behaviour the PORT PROMISES — filtering, ordering, tie-breaks,
 * what counts as active. Anything genuinely unspecified (a Map's iteration order, an id's shape)
 * has no business being pinned by a test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// dist, not src: memory.ts imports its siblings by their emitted .js names, which strip-types
// cannot resolve — the same reason repo.test.ts reads dist.
import { CONFIG_VERSIONS_KEPT, InMemoryRepository, InsufficientBalance, rulePaused, ruleSwitchedOn } from "../dist/index.js";
import type { AuditRow, HourMetric, Repository } from "../src/types.ts";

const DB = process.env.DATABASE_URL;
/* The battery points both stores at ONE database that other suites also write to, so every
 * question below is scoped to the world this file seeds — by server, by player, by this run's own
 * game id. A contract test that asks a global question is measuring the other tests. */
const RUN = Math.random().toString(36).slice(2, 8);
const GAME = `hll-${RUN}`;
const T = (n: number) => new Date(Date.parse("2026-08-01T10:00:00.000Z") + n * 60_000).toISOString();
const PAST = "2026-07-01T10:00:00.000Z";
const FUTURE = "2099-07-01T10:00:00.000Z";
/** One instant shared by a whole batch — what an approval applying several bans at once produces. */
const SAME = T(9);

interface World { serverId: string; serverId2: string; serverId3: string; ana: string; bob: string; cid: string; matchIds: string[]; label: Map<string, string> }

async function seed(repo: Repository): Promise<World> {
  const s1 = await repo.servers.create({ name: "Alpha", host: "10.0.0.1", port: 1, password: "x" });
  const s2 = await repo.servers.create({ name: "Bravo", host: "10.0.0.2", port: 2, password: "x" });
  // A RETIRED server with a public slug: the default list must drop it, findById must still
  // resolve it (old records keep its name), and its public address must stop answering.
  const s3 = await repo.servers.create({ name: "Sunset", host: "10.0.0.3", port: 3, password: "x" });
  await repo.servers.setPublicProfile(s3.id, { publicSlug: `${RUN}-sunset`, publicName: "Sunset", publicPlayerIds: true });
  await repo.servers.setRetired(s3.id, true);
  const [ana, bob, cid] = await repo.players.upsertMany([
    { game: GAME, platform: "steam", platformId: `${RUN}-1000`, name: "Ana", ts: T(0) },
    { game: GAME, platform: "steam", platformId: `${RUN}-2000`, name: "Bob", ts: T(0) },
    { game: GAME, platform: "xbox", platformId: `${RUN}-3000`, name: "Cid", ts: T(0) },
  ]);
  assert.ok(ana && bob && cid);
  const label = new Map([[s1.id, "S1"], [s2.id, "S2"], [ana.id, "ANA"], [bob.id, "BOB"], [cid.id, "CID"]]);

  const matchIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = await repo.matches.open({ serverId: i === 3 ? s2.id : s1.id, map: i % 2 ? "foy_warfare" : "carentan_warfare", startedAt: T(i * 100) });
    label.set(m.id, `M${i}`);
    matchIds.push(m.id);
    if (i === 2) continue; // one round stays open: an in-progress round must read alike too
    await repo.matches.bumpStat({ matchId: m.id, playerId: ana.id, serverId: m.serverId, playerName: "Ana", side: "allies", kills: 5 + i, deaths: 2 });
    await repo.matches.bumpStat({ matchId: m.id, playerId: bob.id, serverId: m.serverId, playerName: "Bob", side: "axis", kills: 3, deaths: 4 + i, teamkills: i === 0 ? 1 : 0 });
    if (i === 0) await repo.matches.bumpStat({ matchId: m.id, playerId: cid.id, serverId: m.serverId, playerName: "Cid", side: "axis", kills: 0, deaths: 1 });
    // The game's own score for the first round, as the roster sampler folds it: the platform
    // split sums these, and the two stores must sum them alike.
    if (i === 0) await repo.stats.sampleRoster({ serverId: m.serverId, matchId: m.id, sampleSec: 60, players: [
      { platformId: `${RUN}-1000`, name: "Ana", role: 1, isSquadLead: true, side: "allies", score: { combat: 120, offense: 40, defense: 60, support: 30, vehicleKills: 2 } },
      { platformId: `${RUN}-3000`, name: "Cid", role: 0, isSquadLead: false, side: "axis", score: { combat: 50, offense: 10, defense: 20, support: 5 } },
    ] });
    await repo.matches.close(m.id, { endedAt: T(i * 100 + 45), winner: i % 2 ? "axis" : "allies", alliedScore: i % 2 ? 1 : 5, axisScore: i % 2 ? 4 : 0, result: null });
    await repo.matches.saveWeaponRollup(m.id, [
      { playerId: ana.id, weapon: "M1 GARAND", classId: "rifle", kills: 4 + i, deaths: 1 },
      { playerId: bob.id, weapon: "MG42", classId: "mg", kills: 3, deaths: 0 },
      // Kills nil, deaths real: a weapon that only ever killed this player must stay off the KILL
      // boards and appear on the death ones. The stores agreeing about that is the point.
      { playerId: bob.id, weapon: "M1 GARAND", classId: "rifle", kills: 0, deaths: 4 },
    ]);
  }

  // Bans: a standing perma, a lifted one, an expired temp, and one on another game. Distinct
  // instants on purpose — with a tie, order comes down to ids, and the two stores mint their own.
  const bans = [
    { game: GAME, playerId: ana.id, playerName: "Ana", kind: "perma" as const, reason: "cheating", createdByName: "staff", scope: { mode: "all" as const }, expiresAt: null, createdAt: T(1) },
    { game: GAME, playerId: bob.id, playerName: "Bob", kind: "temp" as const, reason: "spam", createdByName: "staff", scope: { mode: "all" as const }, expiresAt: FUTURE, createdAt: T(2) },
    { game: GAME, playerId: cid.id, playerName: "Cid", kind: "temp" as const, reason: "old", createdByName: "staff", scope: { mode: "all" as const }, expiresAt: PAST, createdAt: T(3) },
    { game: `${GAME}v`, playerId: ana.id, playerName: "Ana", kind: "temp" as const, reason: "vietnam", createdByName: "staff", scope: { mode: "all" as const }, expiresAt: FUTURE, createdAt: T(4) },
    { game: `${GAME}v`, playerId: bob.id, playerName: "Bob", kind: "temp" as const, reason: "vietnam", createdByName: "staff", scope: { mode: "all" as const }, expiresAt: FUTURE, createdAt: T(5) },
  ];
  const created = [];
  for (const b of bans) created.push(await repo.playerBans.create(b));
  await repo.playerBans.lift(created[1]!.id, "boss");

  await repo.playerFlags.set(ana.id, { watchlist: true }, { userId: null, name: "staff" });
  await repo.watchReasons.add({ playerId: ana.id, reason: "griefing", addedBy: "staff", addedAt: T(1) });
  await repo.watchReasons.add({ playerId: ana.id, reason: "lapsed", addedBy: "staff", addedAt: T(2), expiresAt: PAST });
  const withdrawn = await repo.watchReasons.add({ playerId: ana.id, reason: "withdrawn", addedBy: "staff", addedAt: T(3) });
  await repo.watchReasons.remove(withdrawn.id, "boss");
  // Bob's only reason has lapsed while his flag is still armed — what the expiry sweep hunts for.
  await repo.playerFlags.set(bob.id, { watchlist: true }, { userId: null, name: "staff" });
  await repo.watchReasons.add({ playerId: bob.id, reason: "only lapsed", addedBy: "staff", addedAt: T(4), expiresAt: PAST });

  await repo.vips.upsert({ serverId: s1.id, playerId: `${RUN}-1000`, playerName: "Ana", comment: "donor", expiration: FUTURE, createdByName: "staff" });
  await repo.vips.upsert({ serverId: s1.id, playerId: `${RUN}-2000`, playerName: "Bob", comment: "", expiration: null, createdByName: "staff" });

  // Player triggers: one armed one-shot, and one already spent — both stores must agree on what
  // is "armed" (listArmed drops the spent one) and on the per-player list order (newest first).
  const armedTrig = await repo.playerTriggers.create({ playerId: ana.id, playerName: "Ana", serverId: null, event: "connect", steps: [{ action: "message", message: "welcome", hours: 0, points: 0, delaySec: 0 }], fireOnce: true, createdByName: "staff" });
  const spentTrig = await repo.playerTriggers.create({ playerId: ana.id, playerName: "Ana", serverId: s1.id, event: "teamkill", steps: [{ action: "kick", message: "no TK", hours: 0, points: 0, delaySec: 0 }, { action: "message", message: "and stay out", hours: 0, points: 0, delaySec: 60 }], fireOnce: true, createdByName: "staff" });
  await repo.playerTriggers.recordFire(spentTrig.id, true, T(6));
  void armedTrig;
  // An event with settings of its own (a weapon kill's weapons): both stores keep them as created,
  // and an edit replaces them rather than merging — one trigger of each, since an edit would hide
  // a create that never stored them.
  // On Bob, so Ana's two triggers stay the overview contract's whole world (see below).
  await repo.playerTriggers.create({ playerId: bob.id, playerName: "Bob", serverId: s1.id, event: "weaponkill", params: { weapons: "SATCHEL" }, steps: [{ action: "message", message: "no satchels", hours: 0, points: 0, delaySec: 0 }], fireOnce: true, createdByName: "staff" });
  const weaponTrig = await repo.playerTriggers.create({ playerId: bob.id, playerName: "Bob", serverId: s1.id, event: "weaponkill", params: { weapons: "FLAMETHROWER, SATCHEL" }, steps: [{ action: "message", message: "no flames", hours: 0, points: 0, delaySec: 0 }], fireOnce: false, createdByName: "staff" });
  await repo.playerTriggers.edit(weaponTrig.id, { serverId: s1.id, event: "weaponkill", params: { weapons: "150MM" }, steps: weaponTrig.steps, fireOnce: false, note: null, editedByName: "staff" });

  // The paid-VIP floor, sequenced on the second server and read back in ask(): an unflagged
  // write must not date a permanent grant (Ana), the flagged staff replace must (Bob), and a
  // dated grant extends as ever (Cid). Two stores disagreeing HERE is a paid grant surviving
  // on one install and dying on another.
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-1000`, playerName: "Ana", comment: "paid", expiration: null, createdByName: "staff" });
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-1000`, comment: "seed reward", expiration: FUTURE, createdByName: "seeding" });
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-2000`, playerName: "Bob", comment: "paid", expiration: null, createdByName: "staff" });
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-2000`, expiration: FUTURE, createdByName: "staff", replacePermanent: true });
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-4000`, playerName: "Dee", comment: "paid", expiration: null, createdByName: "staff" });
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-4000`, comment: "event winner", typedNote: true, expiration: FUTURE, createdByName: "staff" });
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-3000`, playerName: "Cid", comment: "temp", expiration: PAST, createdByName: "staff" });
  await repo.vips.upsert({ serverId: s2.id, playerId: `${RUN}-3000`, expiration: FUTURE, createdByName: "seeding" });

  // The manual-map-change stand-down: a patch writes the instant, a read hands it back — a store
  // that forgets the column silently un-holds the vote robot right after a human's pick.
  await repo.mapVote.patchState(s1.id, { manualHoldUntil: FUTURE });
  // The in-game ballot's voters the public vote_status lists: a store that drops the column (or a
  // name-matched ballot's null id) publishes a different voter list from the same vote.
  await repo.mapVote.patchState(s1.id, { ingameVoters: { messageId: "ingame:2026-10-13T00:00:00.000Z", voters: [[{ name: "Ana", playerId: `${RUN}-1000` }, { name: "Bob", playerId: null }], [], [{ name: "Cid", playerId: `${RUN}-3000` }]] } });

  // Measured concurrency: three snapshots in distinct grid buckets, distinct counts (a tie would
  // leave peakAt to each store's own tie-breaking). The blend question below must read them
  // identically through SQL's DISTINCT ON and the memory store's earliest-per-bucket fold.
  const flatComp = { players: 0, unassigned: 0, byRole: {}, bySide: {} };
  await repo.rosterSnapshots.record({ serverId: s1.id, ts: T(21), playerCount: 5, composition: { ...flatComp, players: 5 } });
  await repo.rosterSnapshots.record({ serverId: s1.id, ts: T(26), playerCount: 9, composition: { ...flatComp, players: 9 } });
  await repo.rosterSnapshots.record({ serverId: s1.id, ts: T(31), playerCount: 0, composition: flatComp });

  // Presence for the platform split: two Steam sessions (one player twice), one Xbox, and one on
  // the second server that a serverId-scoped question must leave out.
  const sess = (pid: string, atIso: string, sec: number, serverId = s1.id) => repo.sessions.importOne({
    playerId: pid, serverId, connectedAt: atIso,
    disconnectedAt: new Date(Date.parse(atIso) + sec * 1000).toISOString(), durationSec: sec,
  });
  await sess(ana.id, T(20), 600);
  await sess(ana.id, T(40), 300);
  await sess(cid.id, T(25), 1200);
  await sess(cid.id, T(50), 120); // inside the five-minute cutoff: an early leaver
  await sess(bob.id, T(30), 900, s2.id);

  await repo.audit.create({ actorUserId: null, actorName: "staff", action: "ban.create", targetType: "player", targetId: ana.id, targetName: "Ana", serverId: s1.id, summary: "banned" });
  await repo.audit.create({ actorUserId: null, actorName: "vip.expire", action: "vip.expire", targetType: "player", targetId: bob.id, targetName: "Bob", serverId: null, summary: "expired" });

  // A mixed slice of the event stream, for the cursor questions the worker loops ask: kinds
  // filtered AND time-bounded in the same query, with other kinds and other servers interleaved
  // so a store that ignores either filter answers differently.
  await repo.events.insert([
    { serverId: s1.id, ts: T(10), kind: "evt.kill", actorPlayerId: ana.id, actorName: "Ana", victimPlayerId: bob.id, victimName: "Bob", weapon: "M1 GARAND", dedupeKey: `${RUN}-e1` },
    { serverId: s1.id, ts: T(11), kind: "evt.chat", actorPlayerId: bob.id, actorName: "Bob", data: { message: "hello" }, dedupeKey: `${RUN}-e2` },
    { serverId: s1.id, ts: T(12), kind: "evt.teamkill", actorPlayerId: bob.id, actorName: "Bob", victimPlayerId: cid.id, victimName: "Cid", weapon: "MG42", dedupeKey: `${RUN}-e3` },
    { serverId: s1.id, ts: T(13), kind: "evt.match.ended", dedupeKey: `${RUN}-e4` },
    { serverId: s1.id, ts: T(14), kind: "evt.kill", actorPlayerId: ana.id, actorName: "Ana", victimPlayerId: bob.id, victimName: "Bob", weapon: "M1 GARAND", dedupeKey: `${RUN}-e5` },
    { serverId: s2.id, ts: T(14), kind: "evt.kill", actorPlayerId: ana.id, actorName: "Ana", victimPlayerId: bob.id, victimName: "Bob", weapon: "MG42", dedupeKey: `${RUN}-e6` },
  ]);

  return { serverId: s1.id, serverId2: s2.id, serverId3: s3.id, ana: ana.id, bob: bob.id, cid: cid.id, matchIds, label };
}

/** Ids differ between stores by construction; labels make the two answer sets comparable. */
function normalise(value: unknown, label: Map<string, string>): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => {
    if (typeof v === "string") {
      if (label.has(v)) return label.get(v);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return "<id>";
    }
    return v;
  }));
}

async function ask(repo: Repository, w: World): Promise<Record<string, unknown>> {
  const q: Record<string, unknown> = {};
  // Sort by the LABEL, never the raw id: each store mints its own ids, so an id-sorted list is
  // two different lists wearing the same name.
  const who = (id: string) => w.label.get(id) ?? "<other>";
  const ban = (r: { playerName: string | null; kind: string; game: string; liftedAt: string | null }) =>
    [r.playerName, r.kind, r.game, r.liftedAt ? "lifted" : "standing"];

  q["matches.list"] = (await repo.matches.list(w.serverId, 50, 0)).map((m) => [m.map, m.winner, m.endedAt !== null]);
  q["matches.count"] = await repo.matches.count(w.serverId);
  q["matches.getOpen"] = (await repo.matches.getOpen(w.serverId))?.startedAt ?? null;
  q["matches.statsForMatch"] = (await repo.matches.statsForMatch(w.matchIds[0]!)).map((r) => [r.playerName, r.side, r.kills, r.deaths]);
  q["matches.topStats.kills"] = (await repo.matches.topStats(w.serverId, "kills", 5)).map((r) => [r.playerName, r.value]);
  q["matches.topStats.support"] = (await repo.matches.topStats(w.serverId, "support", 5)).map((r) => [r.playerName, r.value]);
  q["matches.participants"] = (await repo.matches.participants([w.matchIds[0]!, w.matchIds[1]!])).map((r) => r.playerName).sort();
  q["matches.listForPlayer"] = (await repo.matches.listForPlayer(w.ana, 50)).map((r) => [r.map, r.kills]);
  q["matches.classesWithData"] = (await repo.matches.classesWithData(w.serverId)).slice().sort();
  q["matches.topClassKills"] = (await repo.matches.topClassKills(w.serverId, "rifle", 3)).map((r) => [r.playerName, r.value, r.weapon]);
  q["matches.classTotals"] = (await repo.matches.classTotals(w.serverId, "rifle", 3)).map((r) => [r.name, r.kills]);
  q["matches.classDeathTotals"] = (await repo.matches.classDeathTotals(w.serverId, "rifle", 3)).map((r) => [r.name, r.deaths]);
  q["matches.weaponSummary"] = (await repo.matches.weaponSummary(w.serverId, 5)).map((r) => [r.weapon, r.classId, r.totalKills]);
  q["matches.topWeaponKills"] = (await repo.matches.topWeaponKills(w.serverId, "M1 GARAND", 3)).map((r) => [r.playerName, r.value]);
  q["matches.weaponTotals"] = (await repo.matches.weaponTotals(w.serverId, "MG42", 3)).map((r) => [r.name, r.kills]);
  q["matches.weaponDeathTotals"] = (await repo.matches.weaponDeathTotals(w.serverId, "M1 GARAND", 3)).map((r) => [r.name, r.deaths]);
  q["matches.playerWeaponTotals"] = await repo.matches.playerWeaponTotals(w.serverId, w.ana, 5);
  q["matches.playerWeaponDeathTotals"] = await repo.matches.playerWeaponDeathTotals(w.serverId, w.bob, 5);
  q["matches.pendingWeaponRollup"] = (await repo.matches.pendingWeaponRollup(200)).filter((m) => w.matchIds.includes(m.id)).map((m) => m.startedAt);
  q["stats.byServer"] = (await repo.stats.byServer(w.ana)).map((r) => [r.kills, r.deaths, r.matchesPlayed]);
  // A later page of one server's board, and of both servers', and how many each ranks.
  q["stats.leaderboard.page"] = (await repo.stats.leaderboard("kills", 1, [w.serverId], 1)).map((e) => [e.playerId, e.kills]);
  q["stats.leaderboard.pageBoth"] = (await repo.stats.leaderboard("deaths", 2, [w.serverId, w.serverId2], 1)).map((e) => [e.playerId, e.deaths]);
  q["stats.leaderboardCount"] = [await repo.stats.leaderboardCount([w.serverId]), await repo.stats.leaderboardCount([w.serverId2]), await repo.stats.leaderboardCount([w.serverId, w.serverId2])];
  // Scoped to this run's first server: the shared battery database holds other suites' sessions
  // and rounds, but never on OUR server ids.
  q["analytics.platformBreakdown"] = (await repo.analytics.platformBreakdown({ serverId: w.serverId, from: T(0), to: T(500) }))
    .rows.map((r) => [r.platform, r.players, r.newPlayers, r.sessions, r.shortSessions, r.playtimeSec,
      r.rounds, r.kills, r.deaths, r.teamkills, r.vehicleKills, r.scoredRounds, r.combat, r.offense, r.defense, r.support, r.slSeconds]);
  q["mapVote.manualHold"] = (await repo.mapVote.getState(w.serverId))?.manualHoldUntil ?? null;
  q["mapVote.ingameVoters"] = (await repo.mapVote.getState(w.serverId))?.ingameVoters ?? null;
  // Kills attributed to the round they happened in — driven from the rounds in SQL, from the
  // events in memory; the two must land the same. The second window opens MID-round (T(12)), so
  // only the kills after it may count toward that round.
  q["analytics.combat.byMap"] = (await repo.analytics.combat({ serverId: w.serverId, from: T(0), to: T(500), tz: "UTC" })).byMap;
  q["analytics.combat.byMap.clipped"] = (await repo.analytics.combat({ serverId: w.serverId, from: T(12), to: T(500), tz: "UTC" })).byMap;
  q["analytics.platformTrend"] = (await repo.analytics.platformTrend({ serverId: w.serverId, from: T(0), to: T(500), tz: "UTC" })).rows;
  {
    // The measured-first blend end to end: snapshots override the session inference, the peak is
    // the best measurement, and the two stores' bucket folds must land on the same instants.
    const con = await repo.analytics.concurrency({ serverId: w.serverId, from: T(0), to: T(500), tz: "UTC" });
    q["analytics.concurrency"] = [con.peak, con.peakAt, con.average, con.openAtEnd, con.sampleSec];
  }
  q["players.byPlatformFamily"] = (await repo.players.directory({ game: GAME, platform: "xbox" }))
    .map((p) => who(p.id)).sort();

  q["bans.thisGame"] = (await repo.playerBans.list({ game: GAME })).map(ban);
  q["bans.activeOnly"] = (await repo.playerBans.list({ game: GAME, activeOnly: true })).map(ban);
  q["bans.otherGame"] = (await repo.playerBans.list({ game: `${GAME}v`, activeOnly: true })).map(ban);
  q["bans.byPlayer"] = (await repo.playerBans.list({ playerId: w.ana })).map(ban);
  q["watchReasons.list"] = (await repo.watchReasons.list(w.ana)).map((r) => [r.reason, r.removedAt ? "removed" : "open"]);
  q["watchReasons.active"] = [...(await repo.watchReasons.listActiveByPlayers([w.ana, w.bob])).entries()]
    .map(([id, rows]) => [who(id), rows.map((r) => r.reason)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  q["watchReasons.lapsed"] = (await repo.watchReasons.lapsedWatchers()).filter((id) => id === w.ana || id === w.bob || id === w.cid).map(who).sort();
  q["flags.listWatched"] = (await repo.playerFlags.listWatched()).map((f) => f.playerId).filter((id) => id === w.ana || id === w.bob || id === w.cid).map(who).sort();
  q["vips.list"] = (await repo.vips.list(w.serverId)).map((v) => [v.playerName, v.expiration]).sort();
  q["vips.permanentFloor"] = (await repo.vips.list(w.serverId2)).map((v) => [v.playerName, v.expiration, v.comment]).sort();
  // Retirement: findById still names the retired server (old records stay readable) and its
  // public slug no longer answers. The LIST filtering (default drops retired, includeRetired
  // restores) is pinned in each store's own isolated suite instead — listing here would decrypt
  // every row in the shared battery database, including other suites' sealed passwords.
  q["servers.retired"] = [
    (await repo.servers.findById(w.serverId3))?.name ?? "GONE",
    (await repo.servers.findById(w.serverId3))?.retiredAt ? "stamped" : "NOT-STAMPED",
    (await repo.servers.findBySlug(`${RUN}-sunset`)) === null ? "slug dark" : "slug ANSWERS",
  ];
  // listArmed is GLOBAL (the runner loads every player's triggers), so scope to this run's player
  // — a global question would measure the other suites sharing the Postgres database.
  q["playerTriggers.armed"] = (await repo.playerTriggers.listArmed()).filter((t) => t.playerId === w.ana || t.playerId === w.bob).map((t) => [t.event, t.steps.map((st) => [st.action, st.delaySec]), t.fireOnce, t.params]).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  // Sorted: the two triggers are created in the same seed instant, so "newest first" is a real
  // tie the two stores may break differently — the contract is the SET, as with vips.list.
  q["playerTriggers.byPlayer"] = (await repo.playerTriggers.listByPlayer(w.ana)).map((t) => [t.event, t.steps.length, t.disarmedAt ? "spent" : "armed"]).sort();
  // The overview read (also global — scoped to this run's player). Armed-before-spent is the one
  // ORDER the tab depends on; within each half the same-instant tie makes the rest a set.
  q["playerTriggers.all"] = (await repo.playerTriggers.listAll(500))
    .filter((t) => t.playerId === w.ana).map((t) => [t.disarmedAt ? "spent" : "armed", t.event]);
  /*
   * The NARROWED overview — the parameter the trigger tab's per-server scope rests on. Ana holds
   * one trigger that follows her anywhere (no server) and one scoped to S1, so the three answers
   * are the whole contract: a reader scoped to nothing still sees the follow-anywhere one, naming
   * the OTHER server must not reveal S1's, and naming S1 returns both. Two stores disagreeing
   * here is a scope leak on one install and not the other.
   */
  q["playerTriggers.all.scopedToNothing"] = (await repo.playerTriggers.listAll(500, []))
    .filter((t) => t.playerId === w.ana).map((t) => t.event);
  q["playerTriggers.all.scopedToOther"] = (await repo.playerTriggers.listAll(500, [w.serverId2]))
    .filter((t) => t.playerId === w.ana).map((t) => t.event);
  q["playerTriggers.all.scopedToOwn"] = (await repo.playerTriggers.listAll(500, [w.serverId]))
    .filter((t) => t.playerId === w.ana).map((t) => t.event).sort();
  q["audit.list"] = (await repo.audit.list({ serverId: w.serverId })).map((a) => [a.action, a.actorName, a.serverId ? "scoped" : "unscoped"]).sort();
  q["audit.count"] = await repo.audit.count({ serverId: w.serverId });
  q["audit.staffSummary.human"] = (await repo.audit.staffSummary({ actor: "human", serverIds: [w.serverId] })).map((r) => [r.actorName, r.count, r.byAction]);
  q["audit.staffSummary.auto"] = (await repo.audit.staffSummary({ actor: "auto", serverIds: [w.serverId] })).map((r) => [r.actorName, r.count, r.byAction]);

  // The worker loops' cursor question: kinds filtered AND time-bounded in one query (`from` is
  // inclusive). The seeding tick and the map-vote tick both lean on this exact combination now,
  // so a store that ignores either filter — or reads the bound as exclusive — must fail here.
  q["events.query.kindsSince"] = (await repo.events.query({
    serverId: w.serverId, kinds: ["evt.kill", "evt.teamkill"], from: T(12), limit: 50,
  })).map((e) => [e.kind, e.ts, e.weapon]);
  q["events.query.matchBoundaries"] = (await repo.events.query({
    serverId: w.serverId, kinds: ["evt.match.started", "evt.match.ended"], from: T(0), limit: 50,
  })).map((e) => [e.kind, e.ts]);
  return normalise(q, w.label) as Record<string, unknown>;
}

test("both stores answer the same questions the same way", { skip: !DB && "needs DATABASE_URL for the other half" }, async () => {
  const mem = new InMemoryRepository();
  const memAnswers = await ask(mem, await seed(mem));

  const { createPostgresRepository } = await import("../dist/postgres.js");
  const pg = await createPostgresRepository(DB!);
  await pg.migrate();
  const pgAnswers = await ask(pg, await seed(pg));

  const diverged: string[] = [];
  for (const key of Object.keys(memAnswers)) {
    const a = JSON.stringify(memAnswers[key]), b = JSON.stringify(pgAnswers[key]);
    if (a !== b) diverged.push(`${key}\n    memory: ${a}\n    pgsql : ${b}`);
  }
  assert.deepEqual(diverged, [], `the stores disagree:\n  ${diverged.join("\n  ")}`);
  assert.ok(Object.keys(memAnswers).length >= 30, "the comparison must actually be asking things");
  await pg.close?.();
});

test("the paid-VIP floor: automation cannot date a permanent grant; a declared replace can", async () => {
  /*
   * The exact sequence that cost a player VIP bought with real money, twice: staff grant
   * permanent, an automated writer upserts a date over it, the expiry sweep later enforces the
   * date it finds. Each writer was fixed at its own call site; this is the STORE refusing the
   * downgrade for every caller that has not declared "I am replacing a permanent grant" — see
   * NewVip.replacePermanent.
   */
  const repo = new InMemoryRepository();
  const s = await repo.servers.create({ name: "Floor", host: "10.9.9.9", port: 9, password: "x" });

  await repo.vips.upsert({ serverId: s.id, playerId: "paid-1", playerName: "Payer", comment: "bought", expiration: null, createdByName: "staff" });
  const refused = await repo.vips.upsert({ serverId: s.id, playerId: "paid-1", comment: "seed reward", expiration: FUTURE, createdByName: "seeding" });
  assert.equal(refused.expiration, null, "an unflagged write cannot date a permanent grant — the returned row says what was kept");
  assert.equal(refused.comment, "bought", "and a write turned away leaves the grant's note as it was");
  const typed = await repo.vips.upsert({ serverId: s.id, playerId: "paid-1", comment: "event winner", typedNote: true, expiration: FUTURE, createdByName: "staff" });
  assert.deepEqual([typed.expiration, typed.comment], [null, "event winner"], "a note a person typed lands; the date still does not");

  const replaced = await repo.vips.upsert({ serverId: s.id, playerId: "paid-1", expiration: FUTURE, createdByName: "staff", replacePermanent: true });
  assert.equal(replaced.expiration, FUTURE, "a declared staff replace still works — downgrading is a decision, not impossible");

  // The floor guards only the permanent→dated edge: dated grants move freely, and a fresh row
  // takes whatever it is given.
  await repo.vips.upsert({ serverId: s.id, playerId: "dated-1", expiration: PAST, createdByName: "staff" });
  assert.equal((await repo.vips.upsert({ serverId: s.id, playerId: "dated-1", expiration: FUTURE, createdByName: "seeding" })).expiration, FUTURE);
  assert.equal((await repo.vips.upsert({ serverId: s.id, playerId: "fresh-1", expiration: FUTURE, createdByName: "seeding" })).expiration, FUTURE);
  // And an unflagged PERMANENT write over a dated row is an upgrade, never blocked.
  assert.equal((await repo.vips.upsert({ serverId: s.id, playerId: "dated-1", expiration: null, createdByName: "staff" })).expiration, null);
});

/*
 * The dated-VIP floor (NewVip.mayShorten), the same idea one step further: automation can only ever
 * ADD time. The field incident: a rule's VIP wrote "now + 3 days" over grants running for weeks, and
 * CRCON's year-3000 "never expires" — carried in as a DATED grant — was written down to days, then
 * swept off the game. Both stores, so the floor is not a property of one of them.
 */
test("the dated-VIP floor: no unflagged write moves a dated grant earlier, a person's cut can, and year 3000 is permanent", async () => {
  const check = async (repo: Repository, label: string) => {
    const s = await repo.servers.create({ name: `Dated floor ${label}`, host: "10.9.9.8", port: 9, password: "x" });
    assert.ok(s);
    const pid = `${RUN}-dated-${label}`;
    const LATER = "2031-06-01T00:00:00.000Z", EARLIER = "2030-01-01T00:00:00.000Z";
    await repo.vips.upsert({ serverId: s.id, playerId: pid, playerName: "Payer", comment: "paid 30 days", expiration: LATER, createdByName: "staff" });
    const cut = await repo.vips.upsert({ serverId: s.id, playerId: pid, comment: "VIP from rule", expiration: EARLIER, createdByName: "enforcer" });
    assert.equal(cut.expiration, LATER, `${label}: an unflagged write cannot move the expiry earlier — the returned row says what stood`);
    assert.equal(cut.comment, "paid 30 days", `${label}: and a write turned away leaves the grant's note`);
    const typed = await repo.vips.upsert({ serverId: s.id, playerId: pid, comment: "event winner", typedNote: true, expiration: EARLIER, createdByName: "staff" });
    assert.deepEqual([typed.expiration, typed.comment], [LATER, "event winner"], `${label}: a note a person typed lands; the earlier date still does not`);
    const longer = await repo.vips.upsert({ serverId: s.id, playerId: pid, expiration: "2032-01-01T00:00:00.000Z", createdByName: "seeding" });
    assert.equal(longer.expiration, "2032-01-01T00:00:00.000Z", `${label}: extending is never blocked`);
    const reduced = await repo.vips.upsert({ serverId: s.id, playerId: pid, expiration: EARLIER, createdByName: "staff", mayShorten: true });
    assert.equal(reduced.expiration, EARLIER, `${label}: a person removing time (mayShorten) still lands`);
    const edited = await repo.vips.upsert({ serverId: s.id, playerId: pid, expiration: "2029-01-01T00:00:00.000Z", createdByName: "staff", replacePermanent: true });
    assert.equal(edited.expiration, "2029-01-01T00:00:00.000Z", `${label}: the editor's exact set (replacePermanent) lands too`);

    const y3k = await repo.vips.upsert({ serverId: s.id, playerId: `${pid}-3k`, expiration: "3000-01-04T00:00:00.000Z", createdByName: "vip-sync" });
    assert.equal(y3k.expiration, null, `${label}: CRCON's year-3000 "never expires" is stored as permanent`);
    const flattened = await repo.vips.upsert({ serverId: s.id, playerId: `${pid}-3k`, expiration: EARLIER, createdByName: "game rewards" });
    assert.equal(flattened.expiration, null, `${label}: …so the permanent floor keeps automation from dating it down`);
    const imported = await repo.vips.importOne({ serverId: s.id, playerId: `${pid}-imp`, expiration: "3000-02-07T05:55:00.000Z", createdByName: "crcon-import" });
    assert.equal(imported.row.expiration, null, `${label}: an import's year-3000 date lands permanent too`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/*
 * A round shorter than five minutes is not a game (MIN_MATCH_MS). The scoreboard sampler is where
 * a short round did its quietest damage: one opened on the end screen diffed the last round's
 * scoreboard — which the game keeps showing between rounds — against its empty lines, and added
 * every player's whole last round to their career a second time. Careers now wait until a round
 * is ripe, the first ripe sample brings the round in whole, settling a game catches up what no
 * ripe sample reached, and discarding a short round takes back whatever it was credited.
 */
test("short rounds never reach a career: the sampler waits five minutes, settle catches up, discard takes back", async () => {
  const check = async (repo: Repository, label: string, age: (matchId: string, startedAt: string) => Promise<void>) => {
    const s = await repo.servers.create({ name: `Short rounds ${label}`, host: "10.9.9.7", port: 9, password: "x" });
    assert.ok(s);
    const platformId = `${RUN}-short-${label}`;
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId, name: "Medic" });
    const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
    const sample = (matchId: string, combat: number) => repo.stats.sampleRoster({
      serverId: s.id, matchId, sampleSec: 60, players: [{ platformId, name: "Medic", role: 1, isSquadLead: false, level: 3, score: { combat } } as never],
    });
    const career = async () => {
      const c = await repo.stats.get(p.id);
      return { combat: c?.combat ?? 0, played: c?.matchesPlayed ?? 0, won: c?.matchesWon ?? 0 };
    };
    const line = async (matchId: string) => (await repo.matches.statsForMatch(matchId))[0]?.combat;

    // The end-screen round: the last round's 900 on the scoreboard, a minute old.
    const phantom = await repo.matches.open({ serverId: s.id, map: "KURSK Warfare", startedAt: ago(60) });
    await sample(phantom.id, 900);
    assert.equal((await career()).combat, 0, `${label}: a round under five minutes adds nothing to a career`);
    assert.equal(await line(phantom.id), 900, `${label}: its live scoreboard still fills`);
    assert.equal(await repo.matches.discardShort(phantom.id, new Date().toISOString()), true, `${label}: and it is dropped`);
    assert.equal(await repo.matches.get(phantom.id), null);
    assert.deepEqual(await repo.matches.statsForMatch(phantom.id), [], `${label}: with its scoreboard`);
    assert.deepEqual(await career(), { combat: 0, played: 0, won: 0 }, `${label}: having given nothing`);

    // A real round: sampled in its first minute, then past five.
    const real = await repo.matches.open({ serverId: s.id, map: "UTAH BEACH Offensive", startedAt: ago(60) });
    await sample(real.id, 100);
    assert.equal((await career()).combat, 0, `${label}: unripe — careers wait`);
    await age(real.id, ago(360));
    await sample(real.id, 150);
    assert.equal((await career()).combat, 150, `${label}: the first ripe sample brings the round in whole, minute one included`);
    await sample(real.id, 170);
    assert.equal((await career()).combat, 170, `${label}: then only the rise`);
    assert.equal(await repo.matches.discardShort(real.id, new Date().toISOString()), false, `${label}: a game is never discarded`);
    await repo.matches.close(real.id, { endedAt: new Date().toISOString(), winner: null, alliedScore: null, axisScore: null, result: null });
    await repo.stats.settleMatch(real.id, null);
    assert.deepEqual(await career(), { combat: 170, played: 1, won: 0 }, `${label}: settling adds the game played, and no score twice`);

    // A game that ended before any ripe sample reached it: settle brings its scores in.
    const brief = await repo.matches.open({ serverId: s.id, map: "FOY Warfare", startedAt: ago(120) });
    await sample(brief.id, 40);
    await repo.matches.close(brief.id, { endedAt: new Date().toISOString(), winner: null, alliedScore: null, axisScore: null, result: null });
    await repo.stats.settleMatch(brief.id, null);
    assert.deepEqual(await career(), { combat: 210, played: 2, won: 0 }, `${label}: a game's scores are never left out of a career`);

    // A short round that was credited and settled (what history holds): discard takes it all back.
    const startedAt = ago(900);
    const old = await repo.matches.open({ serverId: s.id, map: "CARENTAN Warfare", startedAt });
    await repo.matches.bumpStat({ matchId: old.id, playerId: p.id, serverId: s.id, side: "allies", kills: 1 });
    await sample(old.id, 300);
    await repo.matches.close(old.id, { endedAt: new Date().toISOString(), winner: "allies", alliedScore: 5, axisScore: 0, result: null });
    await repo.stats.settleMatch(old.id, "allies");
    assert.deepEqual(await career(), { combat: 510, played: 3, won: 1 });
    const oneMinuteIn = new Date(Date.parse(startedAt) + 60_000).toISOString();
    assert.equal(await repo.matches.discardShort(old.id, oneMinuteIn), true);
    assert.deepEqual(await career(), { combat: 210, played: 2, won: 0 }, `${label}: its scores, its game played and its win all come back off`);
  };
  const mem = new InMemoryRepository();
  await check(mem, "memory", async (id, startedAt) => {
    const row = await mem.matches.get(id);
    row!.startedAt = startedAt; // the memory store hands back its own row
  });
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    const pool = (pg as unknown as { pool: { query: (sql: string, args: unknown[]) => Promise<unknown> } }).pool;
    try {
      await check(pg, "pgsql", async (id, startedAt) => { await pool.query("UPDATE matches SET started_at = $2 WHERE id = $1", [id, startedAt]); });
    } finally { await pg.close?.(); }
  }
});

/*
 * The score charts' store (match_score_series): a point per player per write, read back by
 * internal id. A point that repeats the player's last totals is dropped, a platform id with no
 * player is skipped, a player named twice in one write is one point (Postgres refuses an upsert
 * that touches a row twice), and a round that goes takes its series with it.
 */
test("score series: a point per player per write, repeats dropped, gone with the round — in both stores", async () => {
  const check = async (repo: Repository, label: string) => {
    const s = await repo.servers.create({ name: `Score series ${label}`, host: "10.9.9.8", port: 9, password: "x" });
    assert.ok(s);
    const ana = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `${RUN}-series-ana-${label}`, name: "Ana" });
    const bob = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `${RUN}-series-bob-${label}`, name: "Bob" });
    const pt = (platformId: string, sec: number, combat: number, offense: number, defense: number, support: number) =>
      ({ platformId, sec, combat, offense, defense, support });
    const m = await repo.matches.open({ serverId: s.id, map: "FOY Warfare", startedAt: new Date(Date.now() - 60_000).toISOString() });

    await repo.matches.appendScoreSeries(m.id, [
      pt(ana.platformId, 120, 10, 0, 0, 5), pt(bob.platformId, 120, 0, 20, 0, 0), pt(`${RUN}-nobody-${label}`, 120, 1, 0, 0, 0),
    ]);
    await repo.matches.appendScoreSeries(m.id, [pt(ana.platformId, 180, 10, 0, 0, 5), pt(bob.platformId, 180, 0, 40, 0, 0)]);
    await repo.matches.appendScoreSeries(m.id, [pt(ana.platformId, 240, 30, 0, 0, 5), pt(ana.platformId, 240, 35, 0, 0, 5)]);
    // A total can fall (a reconnect the cache could not bank): kept as it came.
    await repo.matches.appendScoreSeries(m.id, [pt(bob.platformId, 300, 0, 10, 0, 0)]);
    const series = await repo.matches.scoreSeries(m.id);
    assert.deepEqual(series.get(ana.id), [120, 10, 0, 0, 5, 240, 35, 0, 0, 5], `${label}: a quiet minute adds no point, and a doubled player is one point`);
    assert.deepEqual(series.get(bob.id), [120, 0, 20, 0, 0, 180, 0, 40, 0, 0, 300, 0, 10, 0, 0], `${label}: each player's own points, in order`);
    assert.equal(series.size, 2, `${label}: a platform id with no player is skipped`);

    assert.equal(await repo.matches.discardShort(m.id, new Date().toISOString()), true);
    assert.equal((await repo.matches.scoreSeries(m.id)).size, 0, `${label}: a round that goes takes its series`);
    await repo.matches.appendScoreSeries(m.id, [pt(ana.platformId, 300, 50, 0, 0, 5)]);
    assert.equal((await repo.matches.scoreSeries(m.id)).size, 0, `${label}: and a late point attaches to nothing`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try {
      await check(pg, "pgsql");
    } finally { await pg.close?.(); }
  }
});

/*
 * The VIP integrity scan's read (audit.vipTimeline): the whole VIP slice of the trail, oldest
 * first, a page at a time — no repeats, no gaps, rows the scan does not need left out. Its
 * predecessor read 20,000 rows oldest first and stopped, dropping the NEWEST rows: every dismissal
 * and add-back, which then came straight back on the next recheck.
 */
test("the VIP timeline pages the whole VIP history in order, with nothing repeated, skipped or extra", async () => {
  const check = async (repo: Repository, label: string) => {
    const s = await repo.servers.create({ name: `Timeline ${label}`, host: "10.9.9.7", port: 7, password: "x" });
    assert.ok(s);
    const tag = `${RUN}-tl-${label}`;
    const wanted: string[] = [];
    for (let i = 0; i < 23; i++) {
      const action = ["vip.grant", "vip.integrity_ignore", "seed.reward", "vip.expire"][i % 4]!;
      const row = await repo.audit.create({ actorUserId: null, actorName: "t", action, targetType: "player", targetId: `${tag}-${i}`, serverId: s.id, summary: tag, data: { expiration: "2030-01-01T00:00:00.000Z" } });
      wanted.push(row.id);
      // Rows the scan does not read: a points-only game reward, and an unrelated action.
      await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: `${tag}-${i}`, serverId: s.id, summary: tag, data: { points: 5 } });
      await repo.audit.create({ actorUserId: null, actorName: "t", action: "message.send", targetType: "player", targetId: `${tag}-${i}`, serverId: s.id, summary: tag });
    }
    const vipReward = await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: `${tag}-r`, serverId: s.id, summary: tag, data: { expiration: "2030-02-01T00:00:00.000Z" } });
    wanted.push(vipReward.id);
    const seen: AuditRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { rows: AuditRow[]; next: string | null } = await repo.audit.vipTimeline(cursor, 4);
      for (const r of page.rows) if (r.summary === tag) seen.push(r);
      cursor = page.next;
      pages += 1;
    } while (cursor && pages < 1000);
    // Rows stamped the same instant tie on time and break the tie by id, not by creation order —
    // so: each wanted row exactly once, nothing else, and time never runs backwards.
    assert.equal(new Set(seen.map((r) => r.id)).size, seen.length, `${label}: no row twice across page boundaries`);
    assert.deepEqual(seen.map((r) => r.id).sort(), [...wanted].sort(), `${label}: every VIP row, and only those`);
    assert.ok(seen.every((r, i) => i === 0 || seen[i - 1]!.ts <= r.ts), `${label}: oldest first`);
    assert.ok(pages >= 6, `${label}: it really paged (${pages} pages of 4)`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/*
 * What a VIP shop purchase landed as (audit.vipGrantsByRef): the points history reads back each
 * server's grant by the purchase's ledger ref, to say when the days start and when the VIP ends.
 */
test("VIP grants by purchase ref: every server's grant under those refs, oldest first, and nothing else — in both stores", async () => {
  const check = async (repo: Repository, label: string) => {
    const s = await repo.servers.create({ name: `Bought ${label}`, host: "10.9.9.8", port: 8, password: "x" });
    assert.ok(s);
    const tag = `${RUN}-vb-${label}`;
    // A few milliseconds apart, so "oldest first" is the order they were written in: rows stamped
    // the same instant tie on time and break the tie by id.
    const grant = async (ref: unknown, extra: Record<string, unknown> = {}, action = "vip.grant") => {
      await new Promise((r) => setTimeout(r, 3));
      return repo.audit.create({
        actorUserId: null, actorName: "shop", action, targetType: "player", targetId: `${tag}-p`, serverId: s.id, summary: tag,
        data: { playerId: `${tag}-p`, expiration: "2030-01-15T00:00:00.000Z", days: 14, ref, via: "VIP shop", ...extra },
      });
    };
    const a1 = await grant(`buy:${tag}-a`);
    const b1 = await grant(`buy:${tag}-b`, { groupHeld: true, bankedMs: 86_400_000, expiration: undefined });
    const a2 = await grant(`buy:${tag}-a`, { expiration: "2030-02-01T00:00:00.000Z" });
    // Not asked for, or not a grant: another purchase, a revoke carrying the ref, no ref, a ref that is not text.
    await grant(`buy:${tag}-c`);
    await grant(`buy:${tag}-a`, {}, "vip.revoke");
    await grant(undefined);
    await grant(42);
    const rows = await repo.audit.vipGrantsByRef([`buy:${tag}-a`, `buy:${tag}-b`, `buy:${tag}-missing`]);
    assert.deepEqual(rows.map((r) => r.id), [a1.id, b1.id, a2.id], `${label}: the three grants under those refs, oldest first`);
    assert.deepEqual(rows.map((r) => (r.data as { ref?: string }).ref), [`buy:${tag}-a`, `buy:${tag}-b`, `buy:${tag}-a`], `${label}: each with its ref`);
    assert.equal((rows[1]!.data as { groupHeld?: boolean }).groupHeld, true, `${label}: a held grant's data comes back whole`);
    assert.deepEqual(await repo.audit.vipGrantsByRef([]), [], `${label}: no refs, no rows`);
    assert.deepEqual(await repo.audit.vipGrantsByRef([`buy:${tag}-missing`]), [], `${label}: a ref with no grant, no rows`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/* One entry of the trail by its id — the detail a tap on a row opens. */
test("one audit entry by its id, data and all; none for an id that is not there or not an id — in both stores", async () => {
  const check = async (repo: Repository, label: string) => {
    const row = await repo.audit.create({ actorUserId: null, actorName: "owner", action: "autosettings.config", targetType: "server", targetId: `${RUN}-t`, serverId: null, summary: `${RUN} saved`, data: { patch: { enabled: true }, before: { enabled: false } } });
    const got = await repo.audit.get(row.id);
    assert.ok(got, `${label}: found`);
    assert.equal(got!.id, row.id);
    assert.equal(got!.summary, `${RUN} saved`);
    assert.deepEqual(got!.data, { patch: { enabled: true }, before: { enabled: false } }, `${label}: with its data`);
    assert.equal(await repo.audit.get("00000000-0000-4000-8000-000000000000"), null, `${label}: an id that is not there`);
    assert.equal(await repo.audit.get("not-an-id"), null, `${label}: not an id at all`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/*
 * The same read scoped the way the analytics VIP count asks it: one server's rows, and every
 * banked-pause resume (a staff resume lists several servers in one row, filed under none), older
 * than a cutoff — paged like the whole read.
 */
test("the VIP timeline scoped to a server and a cutoff: that server's rows and every resume, older than the cutoff", async () => {
  const pause = () => new Promise((r) => setTimeout(r, 30));
  const check = async (repo: Repository, label: string) => {
    const s = await repo.servers.create({ name: `Scoped ${label}`, host: "10.9.9.8", port: 8, password: "x" });
    const s2 = await repo.servers.create({ name: `Scoped other ${label}`, host: "10.9.9.9", port: 9, password: "x" });
    assert.ok(s && s2);
    const tag = `${RUN}-sc-${label}`;
    const write = (action: string, serverId: string | null, n: number, data: Record<string, unknown> = { expiration: "2030-01-01T00:00:00.000Z" }) =>
      repo.audit.create({ actorUserId: null, actorName: "t", action, targetType: "player", targetId: `${tag}-${n}`, serverId, summary: tag, data });
    const resume = (serverId: string | null, n: number) =>
      write("player.vipresume", serverId, n, { playerId: `${tag}-${n}`, expiration: "2030-02-01T00:00:00.000Z", banked: [{ serverId: s2.id, expiration: "2030-02-01T00:00:00.000Z" }] });
    const wanted: string[] = [];
    for (let i = 0; i < 9; i++) {
      wanted.push((await write(i % 2 ? "seed.reward" : "vip.grant", s.id, i)).id);
      await write("vip.grant", s2.id, i); // the other server's
    }
    wanted.push((await resume(null, 90)).id); // a staff resume, filed under no server
    wanted.push((await resume(s2.id, 91)).id); // the lapse sweep's, filed under the other server
    await pause();
    const cutoff = new Date().toISOString();
    await pause();
    await write("vip.grant", s.id, 50); // this server's, after the cutoff
    await resume(null, 92);
    const seen: AuditRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { rows: AuditRow[]; next: string | null } = await repo.audit.vipTimeline(cursor, 4, { serverId: s.id, before: cutoff });
      for (const r of page.rows) if (r.summary === tag) seen.push(r);
      cursor = page.next;
      pages += 1;
    } while (cursor && pages < 1000);
    assert.deepEqual(seen.map((r) => r.id).sort(), [...wanted].sort(), `${label}: this server's rows and every resume before the cutoff, and only those`);
    assert.equal(new Set(seen.map((r) => r.id)).size, seen.length, `${label}: no row twice across page boundaries`);
    assert.ok(seen.every((r, i) => i === 0 || seen[i - 1]!.ts <= r.ts), `${label}: oldest first`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/*
 * The By platform chart's running count of players adds up each player ONCE, on the local day of
 * their first session in the window — a regular on three days is one player, not three. Both stores
 * must place that day the same way, in the viewer's zone (a 22:30 join in Chicago is that evening,
 * not the next UTC day), and count a newcomer by the breakdown's rule.
 */
test("the platform trend counts each player once, on their first local day in the window, in both stores", async () => {
  const check = async (repo: Repository, label: string) => {
    const s = await repo.servers.create({ name: `First days ${label}`, host: "10.9.9.10", port: 10, password: "x" });
    assert.ok(s);
    const before = "2026-07-01T00:00:00.000Z";
    const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `${RUN}-fd-a-${label}`, name: "Ada", ts: before });
    const b = await repo.players.upsert({ game: "hll", platform: "EPlatformFamily::XboxSeries", platformId: `${RUN}-fd-b-${label}`, name: "Bo", ts: "2026-08-02T16:00:00.000Z" });
    const c = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `${RUN}-fd-c-${label}`, name: "Cy", ts: before });
    const sess = (playerId: string, connectedAt: string) => repo.sessions.importOne({
      playerId, serverId: s.id, connectedAt, disconnectedAt: new Date(Date.parse(connectedAt) + 1_800_000).toISOString(), durationSec: 1800,
    });
    await sess(a.id, "2026-08-01T15:00:00.000Z"); // Chicago: Aug 1, 10:00
    await sess(a.id, "2026-08-02T15:00:00.000Z"); // and again Aug 2
    await sess(b.id, "2026-08-02T16:00:00.000Z"); // a newcomer, Aug 2
    await sess(c.id, "2026-08-03T03:30:00.000Z"); // Aug 2, 22:30 in Chicago — Aug 3 in UTC
    await sess(c.id, "2026-08-03T15:00:00.000Z"); // and again Aug 3
    const { rows } = await repo.analytics.platformTrend({ serverId: s.id, from: "2026-08-01T05:00:00.000Z", to: "2026-08-04T05:00:00.000Z", tz: "America/Chicago" });
    assert.deepEqual(rows.map((r) => [r.date, r.platform, r.players, r.firstPlayers, r.firstNewPlayers]), [
      ["2026-08-01", "steam", 1, 1, 0],
      ["2026-08-02", "EPlatformFamily::XboxSeries", 1, 1, 1],
      ["2026-08-02", "steam", 2, 1, 0],
      ["2026-08-03", "steam", 1, 0, 0],
    ], `${label}: Ada on her first day only, Cy on his Chicago evening, Bo as new`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/*
 * The tie-break, pinned per store so the memory-only run covers it too. An approval that applies
 * several bans at once stamps them the same instant; without a second key the list order is
 * whatever the store feels like, and "whatever the store feels like" is free to change between
 * two reads of the same page.
 */
test("bans stamped the same instant come back in a stable, defined order", async () => {
  const check = async (repo: Repository) => {
    const tieGame = `tie-${Math.random().toString(36).slice(2, 8)}`;
    const s = await repo.servers.create({ name: "A", host: "10.0.0.1", port: 1, password: "x" });
    assert.ok(s);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const b = await repo.playerBans.create({
        game: tieGame, playerId: `${RUN}-p${i}`, playerName: `P${i}`, kind: "perma", reason: "batch",
        createdByName: "approval", scope: { mode: "all" as const }, expiresAt: null, createdAt: SAME,
      });
      ids.push(b.id);
    }
    const order = (await repo.playerBans.list({ game: tieGame })).map((b) => b.id);
    assert.deepEqual(order, [...ids].sort((a, b) => b.localeCompare(a)), "same instant → newest-id first");
    assert.deepEqual((await repo.playerBans.list({ game: tieGame })).map((b) => b.id), order, "and the same order every read");

    // The audit trail is the other list written in bursts, and it pages — an unstable tie there
    // would repeat or drop entries at a page boundary, which is the one thing a trail must not do.
    for (let i = 0; i < 5; i++) {
      await repo.audit.create({ actorUserId: null, actorName: "batch", action: "message.send", targetType: "player", targetId: `p${i}`, targetName: `P${i}`, serverId: s.id, summary: "volley" });
    }
    const firstPage = (await repo.audit.list({ limit: 2, serverId: s.id })).map((a) => a.id);
    const secondPage = (await repo.audit.list({ limit: 2, offset: 2, serverId: s.id })).map((a) => a.id);
    assert.equal(new Set([...firstPage, ...secondPage]).size, 4, "paging the trail never repeats an entry");
    assert.deepEqual((await repo.audit.list({ limit: 2, serverId: s.id })).map((a) => a.id), firstPage, "and the page holds still between reads");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("an in-game voter resolves to the player they are, in both stores", async () => {
  /*
   * The in-game vote surface counts a player with no linked Discord under the synthetic identity
   * "player:<their player id>" — an id that can never collide with a Discord snowflake. The voter
   * summary only ever resolved snowflakes, so the panel showed a player it knows perfectly well as
   * "not linked to a game account" and told staff to go add a Discord link that was never missing.
   * The id is right there in the identity; both stores must read it.
   */
  const check = async (repo: Repository) => {
    const game = `ing-${Math.random().toString(36).slice(2, 8)}`;
    const s = await repo.servers.create({ name: "A", host: "10.0.0.1", port: 1, password: "x" });
    const [dee, gus] = await repo.players.upsertMany([
      { game, platform: "steam", platformId: `${game}-1`, name: "Dee", ts: T(0) },
      { game, platform: "steam", platformId: `${game}-2`, name: "Gus", ts: T(0) },
    ]);
    await repo.externalLinks.set(dee!.id, "discord", "D-DEE");

    await repo.mapVote.recordHistory({
      serverId: s.id, decidedAt: T(1), profile: null,
      winnerId: "foy_warfare", winnerName: "Foy", totalVotes: 3, outcome: "vote", applied: true,
      options: [{
        id: "foy_warfare", name: "Foy", votes: 3,
        voters: [
          { discordId: "D-DEE", name: "Dee#1" },                  // a Discord ballot, linked
          { discordId: `player:${gus!.id}`, name: "Gus" },         // in game, no Discord — known player
          { discordId: "player:name:ghost", name: "Ghost" },       // in game, the log gave no id
        ],
      }],
    });

    const rows = await repo.mapVote.voterSummary(s.id, 100);
    const by = (id: string) => rows.find((r) => r.discordUserId === id);

    const linked = by("D-DEE");
    assert.equal(linked?.playerId, dee!.id, "the Discord ballot still resolves through the link");
    assert.equal(linked?.ingame, false, "and is not an in-game identity");

    const inGame = by(`player:${gus!.id}`);
    assert.equal(inGame?.ingame, true, "an in-game ballot is marked as one");
    assert.equal(inGame?.playerId, gus!.id, "and resolves to the player it names — NOT 'no game account'");
    assert.equal(inGame?.playerName, "Gus");

    const nameOnly = by("player:name:ghost");
    assert.equal(nameOnly?.ingame, true);
    assert.equal(nameOnly?.playerId, null, "a name-keyed ballot has no id to resolve, and must not invent one");
    assert.equal(nameOnly?.discordName, "Ghost", "the in-game name is what staff see");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

/*
 * The owner query behind every lockout guard. Only a global "*" at WRITE is ownership: one at none
 * is a lockout — or a decoy, which anyone with user admin may plant on a dummy account to make the
 * last-owner guard believe a second owner exists — and one at read is an auditor. A "*" confined to
 * one server is that server's, not ownership. Both stores must draw the line in the same place.
 */
test("the owner query counts a global \"*\" at write and nothing less, in both stores", async () => {
  const check = async (repo: Repository) => {
    const ids: Record<string, string> = {};
    const s = await repo.servers.create({ name: "Owned", host: "10.0.0.9", port: 9, password: "x" });
    const grant = async (name: string, scopeType: "global" | "server", level: "none" | "read" | "write") => {
      const u = await repo.users.create({ username: `${name}-${RUN}-${Math.random().toString(36).slice(2, 6)}` });
      ids[u.id] = name;
      await repo.grants.create({ userId: u.id, capability: "*", scopeType, scopeId: scopeType === "server" ? s.id : null, level });
    };
    await grant("owner", "global", "write");
    await grant("auditor", "global", "read");
    await grant("decoy", "global", "none");
    await grant("serverAdmin", "server", "write");
    // Scoped to the accounts made here — the battery database is shared with other suites.
    const ask = async (level: "none" | "read" | "write") =>
      (await repo.grants.userIdsWithGlobalCapability("*", level)).filter((id) => id in ids).map((id) => ids[id]).sort();
    assert.deepEqual(await ask("write"), ["owner"], "only the global write counts as an owner");
    assert.deepEqual(await ask("read"), ["auditor", "owner"], "at read or above");
    assert.deepEqual(await ask("none"), ["auditor", "decoy", "owner"], "any global row at all");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

/*
 * A renamed server remembers what it was called — so a message saved as "{vip_until:WW2}" keeps
 * resolving after WW2 becomes "WW2 #1". Postgres does it with a trigger (every setter, and any
 * future one, is covered); memory mirrors it per setter. Both must keep the same history.
 */
test("renaming a server keeps its former names, newest first, de-duplicated", async () => {
  const check = async (repo: Repository) => {
    const s = await repo.servers.create({ name: `Game Name ${RUN}`, host: "10.9.9.9", port: 9, password: "x" });
    assert.deepEqual((await repo.servers.findById(s.id))!.formerNames, [], "a new server has no history");
    await repo.servers.setNickname(s.id, "WW2");
    await repo.servers.setNickname(s.id, "WW2 #1");               // the nickname staff typed into messages
    await repo.servers.updateName(s.id, `Game Name v2 ${RUN}`);   // the in-game name changed too
    await repo.servers.setNickname(s.id, "WW2");                  // and back again
    const row = (await repo.servers.findById(s.id))!;
    assert.equal(row.name, "WW2");
    assert.deepEqual(row.formerNames, ["WW2 #1", `Game Name ${RUN}`, "WW2"],
      "newest first; the current name may also be a former one — harmless, current names match first");
    await repo.servers.setNickname(s.id, "WW2"); // no change → no new history
    assert.equal((await repo.servers.findById(s.id))!.formerNames.length, 3);
    // Staff-only: the history never leaves on the public server shape.
    const { toPublicServer } = await import("../dist/index.js");
    assert.equal("formerNames" in toPublicServer(row), false);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("re-editing a player trigger: same row, new definition, history and author kept", async () => {
  const check = async (repo: Repository) => {
    const pl = await repo.players.upsert({ game: GAME, platform: "steam", platformId: `trig-${RUN}`, name: "Trig" });
    const made = await repo.playerTriggers.create({
      playerId: pl.id, playerName: "Trig", event: "connect", fireOnce: true, createdByName: "Author",
      steps: [{ action: "message", message: "hi", hours: 0, points: 0, delaySec: 0 }],
    });
    await repo.playerTriggers.recordFire(made.id, true, T(1));
    const kept = await repo.playerTriggers.edit(made.id, {
      serverId: null, event: "death", params: {}, fireOnce: false, note: "why", editedByName: "Editor",
      steps: [{ action: "kick", message: "bye", hours: 0, points: 0, delaySec: 5 }],
    });
    assert.equal(kept!.event, "death");
    assert.deepEqual(kept!.steps, [{ action: "kick", message: "bye", hours: 0, points: 0, delaySec: 5 }]);
    assert.equal(kept!.createdByName, "Author");
    assert.equal(kept!.firedCount, 1);
    assert.equal(kept!.updatedByName, "Editor");
    assert.ok(kept!.updatedAt);
    assert.ok(kept!.disarmedAt, "a spent one-shot stays spent without rearm");
    const armed = await repo.playerTriggers.edit(made.id, { ...kept!, note: kept!.note, editedByName: "Editor", rearm: true });
    assert.equal(armed!.disarmedAt, null);
    assert.equal(await repo.playerTriggers.edit("00000000-0000-0000-0000-000000000000", { ...kept!, editedByName: "x" }), null);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("game rewards: a payout is claimed once; day seconds accumulate; settings round-trip over defaults", async () => {
  const check = async (repo: Repository) => {
    const s = await repo.servers.create({ name: `GR ${RUN}`, host: "10.9.9.8", port: 8, password: "x" });
    assert.equal(await repo.gameRewards.claim({ serverId: s.id, playerId: "p1", ref: "top:m1:kills:1", kind: "topStats" }), true);
    assert.equal(await repo.gameRewards.claim({ serverId: s.id, playerId: "p1", ref: "top:m1:kills:1", kind: "topStats" }), false, "never twice");
    assert.equal(await repo.gameRewards.claim({ serverId: s.id, playerId: "p2", ref: "top:m1:kills:1", kind: "topStats" }), true, "per player");

    const t1 = await repo.gameRewards.addDaySeconds(s.id, "play", "2026-09-26", [{ playerId: "p1", seconds: 60 }, { playerId: "p1", seconds: 30 }, { playerId: "p2", seconds: 60 }]);
    assert.deepEqual(t1.sort((a, b) => a.playerId.localeCompare(b.playerId)), [{ playerId: "p1", seconds: 90 }, { playerId: "p2", seconds: 60 }]);
    const t2 = await repo.gameRewards.addDaySeconds(s.id, "play", "2026-09-26", [{ playerId: "p1", seconds: 60 }]);
    assert.deepEqual(t2, [{ playerId: "p1", seconds: 150 }], "the running total for the day");
    await repo.gameRewards.addDaySeconds(s.id, "play", "2026-09-24", [{ playerId: "p1", seconds: 10 }]);
    await repo.gameRewards.addDaySeconds(s.id, "seed", "2026-09-26", [{ playerId: "p1", seconds: 1 }]);
    assert.deepEqual(await repo.gameRewards.days(s.id, "p1", "play", "2026-09-01"), [{ day: "2026-09-24", seconds: 10 }, { day: "2026-09-26", seconds: 150 }]);
    assert.deepEqual(await repo.gameRewards.days(s.id, "p1", "play", "2026-09-25"), [{ day: "2026-09-26", seconds: 150 }]);

    assert.equal(await repo.gameRewards.getConfig(s.id), null);
    const { GAME_REWARDS_DEFAULTS } = await import("../dist/index.js");
    const saved = await repo.gameRewards.setConfig(s.id, { ...GAME_REWARDS_DEFAULTS, killStreaks: { ...GAME_REWARDS_DEFAULTS.killStreaks, enabled: true } });
    assert.equal(saved.config.killStreaks.enabled, true);
    assert.equal((await repo.gameRewards.getConfig(s.id))!.config.topStats.categories.length, GAME_REWARDS_DEFAULTS.topStats.categories.length);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

/*
 * Too few points: a debit that would overdraw is refused by name, with the numbers, so a caller can
 * put it to a member in their own words — and nothing moves or is written. A replay of a debit that
 * already landed is still the replay it is, even when that debit spent everything.
 */
test("an overdrawing debit is refused as InsufficientBalance, with the numbers, and moves nothing", async () => {
  const check = async (repo: Repository) => {
    const who = `9${RUN.length}${Math.floor(Math.random() * 1e12)}`;
    await repo.economy.apply({ discordId: who, delta: 100, reason: "seed" });
    await assert.rejects(repo.economy.apply({ discordId: who, delta: -250, reason: "too much", ref: `od:${RUN}:${who}` }),
      (err: unknown) => err instanceof InsufficientBalance && err.balance === 100 && err.needed === 250);
    assert.equal((await repo.economy.member(who))?.balance, 100, "nothing moved");
    assert.equal(await repo.economy.lastEntryWithRefPrefix(who, `od:${RUN}`), null, "and nothing was written");
    assert.equal((await repo.economy.apply({ discordId: who, delta: -100, reason: "all of it", ref: `all:${RUN}:${who}` })).applied, true);
    assert.equal((await repo.economy.apply({ discordId: who, delta: -100, reason: "all of it", ref: `all:${RUN}:${who}` })).applied, false, "a replay, not a refusal");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

/*
 * The install's own settings (the login-signing key, the setup code, service credentials): read
 * back as set, gone when set to null, and made once by getOrCreate — the first value is the one
 * every later caller gets, which is what lets a key made on the first boot sign logins on the next.
 */
test("install settings: set and read back, removed by null, and made once by getOrCreate", async () => {
  const check = async (repo: Repository) => {
    const k = (name: string) => `test.${RUN}.${name}`;
    assert.equal(await repo.installSettings.get(k("absent")), null);
    await repo.installSettings.set(k("host"), "stats.example.com", { by: "owner" });
    assert.equal(await repo.installSettings.get(k("host")), "stats.example.com");
    await repo.installSettings.set(k("host"), "stats2.example.com");
    assert.equal(await repo.installSettings.get(k("host")), "stats2.example.com", "a second set replaces the first");
    await repo.installSettings.set(k("host"), null);
    assert.equal(await repo.installSettings.get(k("host")), null, "null removes it");
    let made = 0;
    assert.equal(await repo.installSettings.getOrCreate(k("key"), () => `v${++made}`, { secret: true }), "v1");
    assert.equal(await repo.installSettings.getOrCreate(k("key"), () => `v${++made}`, { secret: true }), "v1", "made once, then kept");
    assert.equal(made, 1);
    assert.equal(await repo.installSettings.get(k("key")), "v1");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

/*
 * The devices taking phone notifications: keyed by the address a browser's push service gave it,
 * so the same browser turned on again — or by someone else on a shared computer — is one row, and
 * keeps when it was first turned on. A device goes with its account.
 */
test("phone notification devices: one row per browser, replaced in place, and gone with the account", async () => {
  const check = async (repo: Repository) => {
    const a = await repo.users.create({ username: `push-a-${RUN}-${Math.random().toString(36).slice(2, 6)}`, passwordHash: "h" });
    const b = await repo.users.create({ username: `push-b-${RUN}-${Math.random().toString(36).slice(2, 6)}`, passwordHash: "h" });
    const endpoint = `https://fcm.googleapis.com/fcm/send/${RUN}-${a.id}`;
    const row = { endpoint, userId: a.id, p256dh: "P", auth: "A", device: "iPhone", origin: "https://panel.example", epoch: 0 };
    const first = await repo.pushSubscriptions.upsert(row);
    assert.deepEqual({ ...first, createdAt: "" }, { ...row, createdAt: "" });
    assert.deepEqual((await repo.pushSubscriptions.listByUser(a.id)).map((d) => d.endpoint), [endpoint]);
    const moved = await repo.pushSubscriptions.upsert({ ...row, userId: b.id, device: "Windows computer", epoch: 3 });
    assert.equal(moved.createdAt, first.createdAt, "the same browser, so when it was first turned on stays");
    assert.deepEqual(await repo.pushSubscriptions.get(endpoint), moved);
    assert.deepEqual(await repo.pushSubscriptions.listByUser(a.id), [], "a browser notifies whoever turned it on last");
    assert.equal(await repo.pushSubscriptions.remove(endpoint), true);
    assert.equal(await repo.pushSubscriptions.remove(endpoint), false);
    assert.equal(await repo.pushSubscriptions.get(endpoint), null);
    await repo.pushSubscriptions.upsert({ ...row, endpoint: `${endpoint}-2` });
    await repo.users.remove(a.id);
    assert.equal(await repo.pushSubscriptions.get(`${endpoint}-2`), null, "gone with the account");
    assert.ok(!(await repo.pushSubscriptions.list()).some((d) => d.userId === a.id));
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

/*
 * Nobody plays a day without a break: a longer pair is a disconnect nobody saw. However a session
 * closes — its own disconnect, a connect weeks later with no disconnect between, or the roster
 * check — it is stored at most a day from its connect, and that day is all it reports for playtime.
 */
test("a play session is at most a day from its connect, however it closes", async () => {
  const check = async (repo: Repository) => {
    const s = await repo.servers.create({ name: `SD ${RUN}`, host: "10.9.9.41", port: 41, password: "x" });
    const p = await repo.players.upsert({ game: GAME, platform: "steam", platformId: `sd-${RUN}`, name: "Stayer" });
    const at = (h: number) => new Date(Date.parse("2026-03-27T06:00:00.000Z") + h * 3_600_000).toISOString();
    const later = 100 + 66 * 24;

    await repo.sessions.open(p.id, s.id, at(0));
    assert.equal(await repo.sessions.close(p.id, s.id, at(30)), 86_400, "a disconnect 30 hours on reports a day");
    await repo.sessions.open(p.id, s.id, at(100));
    assert.equal(await repo.sessions.open(p.id, s.id, at(later)), 86_400, "a connect 66 days on banks a day of the last one");
    assert.equal(await repo.sessions.close(p.id, s.id, at(later + 1)), 3_600, "an hour stays an hour");
    await repo.sessions.open(p.id, s.id, at(2000));
    assert.equal(await repo.sessions.closeAbsent(s.id, [], at(2001), at(2050)), 1);

    const rows = (await repo.sessions.list(p.id, 10, s.id))
      .map((r) => ({ from: r.connectedAt, to: r.disconnectedAt, sec: r.durationSec }))
      .sort((a, b) => a.from.localeCompare(b.from));
    assert.deepEqual(rows, [
      { from: at(0), to: at(24), sec: 86_400 },
      { from: at(100), to: at(124), sec: 86_400 },
      { from: at(later), to: at(later + 1), sec: 3_600 },
      { from: at(2000), to: at(2024), sec: 86_400 },
    ], "each ends a day from its connect at the latest");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("roster reads for rules: who is Discord-linked, and hours played — all time or since a point, per server or everywhere", async () => {
  const check = async (repo: Repository) => {
    const a = await repo.servers.create({ name: `PA ${RUN}`, host: "10.9.9.21", port: 21, password: "x" });
    const b = await repo.servers.create({ name: `PB ${RUN}`, host: "10.9.9.22", port: 22, password: "x" });
    const linked = await repo.players.upsert({ game: GAME, platform: "steam", platformId: `pt-l-${RUN}`, name: "Linked" });
    const plain = await repo.players.upsert({ game: GAME, platform: "steam", platformId: `pt-p-${RUN}`, name: "Plain" });
    await repo.externalLinks.set(linked.id, "discord", `9${RUN.replace(/\D/g, "1")}0000000000`.slice(0, 18));
    await repo.externalLinks.set(plain.id, "steam", `pt-${RUN}`);
    assert.deepEqual([...await repo.externalLinks.linkedAmong([linked.id, plain.id], "discord")], [linked.id]);
    assert.equal((await repo.externalLinks.linkedAmong([], "discord")).size, 0);

    // The rollup: 2h on A, 1h on B for one player.
    await repo.stats.bumpMany([
      { playerId: linked.id, serverId: a.id, delta: { playtimeSec: 7200 } },
      { playerId: linked.id, serverId: b.id, delta: { playtimeSec: 3600 } },
    ]);
    assert.equal((await repo.stats.playtimeFor([linked.id, plain.id], { serverId: a.id, since: null })).get(linked.id), 7200);
    assert.equal((await repo.stats.playtimeFor([linked.id], { serverId: null, since: null })).get(linked.id), 10800);
    assert.equal((await repo.stats.playtimeFor([plain.id], { serverId: null, since: null })).has(plain.id), false, "none recorded = absent");

    // Since a point: completed sessions, only the part after it.
    const now = Date.now();
    const iso = (min: number) => new Date(now + min * 60_000).toISOString();
    await repo.sessions.open(plain.id, a.id, iso(-300));
    await repo.sessions.close(plain.id, a.id, iso(-240)); // an hour, entirely before the bound
    await repo.sessions.open(plain.id, a.id, iso(-150));
    await repo.sessions.close(plain.id, a.id, iso(-90)); // an hour straddling it: 30 min after
    await repo.sessions.open(plain.id, b.id, iso(-60));
    await repo.sessions.close(plain.id, b.id, iso(-30)); // 30 min on B, all after
    const since = iso(-120);
    assert.equal((await repo.stats.playtimeFor([plain.id], { serverId: null, since })).get(plain.id), 3600);
    assert.equal((await repo.stats.playtimeFor([plain.id], { serverId: a.id, since })).get(plain.id), 1800);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("rule status: a check and a hold-back land on the same (rule, server) row, and go with the rule", async () => {
  const check = async (repo: Repository) => {
    const s = await repo.servers.create({ name: `RS ${RUN}`, host: "10.9.9.31", port: 31, password: "x" });
    const r = await repo.enforcerRules.create({ name: `status ${RUN}`, eventKind: "app.state.no_vip", action: "vip", serverId: s.id });
    const summary = { roster: 99, flagged: 2, sent: 2, paced: 0, unknownPlayers: 0, held: null, breakdown: { "no VIP": 2 } };
    await repo.enforcerRules.recordCheck(r.id, s.id, summary);
    await repo.enforcerRules.recordSkip(r.id, s.id, "already VIP on the game's own list", "Lynx");
    const mine = (await repo.enforcerRules.statuses()).filter((x) => x.ruleId === r.id);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0]!.check, summary);
    assert.equal(mine[0]!.skipReason, "already VIP on the game's own list");
    assert.equal(mine[0]!.skipPlayer, "Lynx");
    assert.ok(mine[0]!.checkedAt && mine[0]!.skippedAt);
    await repo.enforcerRules.remove(r.id);
    assert.equal((await repo.enforcerRules.statuses()).filter((x) => x.ruleId === r.id).length, 0, "a deleted rule keeps no status");

    // A deleted SERVER takes its status rows and VIP cooldowns with it too — a community-wide
    // rule must not show a ghost "last checked on a server" line for a server that is gone.
    const wide = await repo.enforcerRules.create({ name: `wide ${RUN}`, eventKind: "app.state.no_vip", action: "vip", serverId: null });
    const s2 = await repo.servers.create({ name: `RS2 ${RUN}`, host: "10.9.9.32", port: 32, password: "x" });
    await repo.enforcerRules.recordCheck(wide.id, s2.id, summary);
    await repo.enforcerRules.recordVipGrant(wide.id, s2.id, "76561198000000042");
    await repo.servers.remove(s2.id);
    assert.equal((await repo.enforcerRules.statuses()).filter((x) => x.ruleId === wide.id).length, 0, "a deleted server keeps no status");
    assert.equal(await repo.enforcerRules.lastVipGrantAt(wide.id, s2.id, "76561198000000042"), null, "…and no cooldowns");
    await repo.enforcerRules.remove(wide.id);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("payout receipts: written PENDING up front, settled in place; an interruption tallies them and blocks a re-run", async () => {
  const check = async (repo: Repository) => {
    const key = `cut-${RUN}-${Math.random().toString(36).slice(2)}`;
    const job = await repo.payouts.create({
      sourceType: "online", sourceRef: {}, payoutType: "vip", amount: 3, serverIds: [], audience: "linked",
      dryRun: false, status: "RUNNING", requestedByUserId: null, requestedByName: "t", totalCount: 3, duplicateKey: key,
    });
    const ids = await repo.payouts.openItems(job.id, [
      { playerId: null, discordId: "a", displayName: "A" },
      { playerId: null, discordId: "b", displayName: "B" },
      { playerId: null, discordId: "c", displayName: "C" },
    ]);
    assert.equal(ids.length, 3);
    assert.deepEqual((await repo.payouts.items(job.id)).map((i) => [i.displayName, i.status]), [["A", "PENDING"], ["B", "PENDING"], ["C", "PENDING"]], "in the order given");
    await repo.payouts.settleItem(ids[0]!, { status: "PASS", error: "", detail: { servers: {} } });
    await repo.payouts.settleItem(ids[1]!, { status: "FAIL", error: "boom", detail: {} });

    // Still running: only the failure is retryable — the PENDING row belongs to a live driver.
    assert.deepEqual((await repo.payouts.failedItems(job.id)).map((i) => i.displayName), ["B"]);
    assert.equal(await repo.payouts.interruptStale() >= 1, true);
    const cut = (await repo.payouts.get(job.id))!;
    assert.equal(cut.status, "INTERRUPTED");
    assert.equal(cut.successCount, 1);
    assert.equal(cut.failedCount, 2, "the failure and the unreached");
    assert.deepEqual((await repo.payouts.failedItems(job.id, { includePending: true })).map((i) => i.displayName), ["B", "C"]);
    assert.equal((await repo.payouts.findDuplicate(key))?.id, job.id, "an interrupted run blocks running it again");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("an event's payouts: its real runs and every retry down each chain, oldest first", async () => {
  const ask = async (repo: Repository) => {
    // This run's own event ids: the battery's one database holds other suites' payouts too.
    const evA = `evA-${RUN}`;
    const evB = `evB-${RUN}`;
    const label = new Map<string, string>();
    const make = async (name: string, sourceType: "event" | "retry" | "online", sourceRef: Record<string, unknown>, dryRun = false) => {
      const job = await repo.payouts.create({
        sourceType, sourceRef, payoutType: "currency", amount: 5, serverIds: [], audience: "linked",
        dryRun, status: "RUNNING", requestedByUserId: null, requestedByName: "t", totalCount: 1,
        duplicateKey: `${name}-${RUN}-${Math.random().toString(36).slice(2)}`,
      });
      label.set(job.id, name);
      // Distinct instants, so "oldest first" is the creation order in both stores rather than ids.
      await new Promise((r) => setTimeout(r, 3));
      return job;
    };
    const a1 = await make("a1", "event", { type: "event", eventId: evA });
    await make("a-dry", "event", { type: "event", eventId: evA }, true);
    const a2 = await make("a2", "retry", { type: "retry", jobId: a1.id, rootJobId: a1.id });
    await make("a3-legacy", "retry", { type: "retry", jobId: a2.id }); // before rootJobId was recorded
    await make("a-retry-dry", "retry", { type: "retry", jobId: a1.id, rootJobId: a1.id }, true);
    await make("b1", "event", { type: "event", eventId: evB });
    const o1 = await make("o1", "online", { type: "online", serverId: "x" });
    await make("o2", "retry", { type: "retry", jobId: o1.id, rootJobId: o1.id });
    const names = async (ids: string[]) => (await repo.payouts.forEvents(ids)).map((j) => label.get(j.id) ?? "someone else's");
    return {
      a: await names([evA]),
      both: await names([evA, evB]),
      none: await names([]),
      unknown: await names([`nobody-${RUN}`]),
    };
  };
  const mem = await ask(new InMemoryRepository());
  assert.deepEqual(mem.a, ["a1", "a2", "a3-legacy"], "dry runs never count; a retry of a retry is still the event's");
  assert.deepEqual(mem.both, ["a1", "a2", "a3-legacy", "b1"]);
  assert.deepEqual(mem.none, []);
  assert.deepEqual(mem.unknown, []);
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    assert.deepEqual(await ask(pg), mem);
    await pg.close?.();
  }
});

test("an event's no-payout mark: a closed event only, and undone in full", async () => {
  const ask = async (repo: Repository) => {
    const srv = await repo.servers.create({ name: `NP ${RUN}`, host: "10.9.9.46", port: 46, password: "x" });
    const make = (name: string) => repo.payoutEvents.create({
      name: `${name}-${RUN}`, serverId: srv.id, openMode: "at", openAnchor: T(0), closeMode: "at", closeAnchor: T(60),
      minMinutes: 0, mapVoteProfile: null, rotationSetId: null, createdBy: "t",
    });
    const mark = { at: T(70), by: "Reaper" };
    const ev = await make("np");
    const fresh = [ev.noPayoutAt, ev.noPayoutBy];
    const whileScheduled = await repo.payoutEvents.setNoPayout(ev.id, mark);
    await repo.payoutEvents.applyTransition(ev.id, { openedAt: T(0) });
    const whileOpen = await repo.payoutEvents.setNoPayout(ev.id, mark);
    await repo.payoutEvents.applyTransition(ev.id, { closedAt: T(60), roster: [] });
    const marked = await repo.payoutEvents.setNoPayout(ev.id, mark);
    const read = await repo.payoutEvents.get(ev.id);
    const listed = (await repo.payoutEvents.list({ limit: 500 })).find((e) => e.id === ev.id);
    const cleared = await repo.payoutEvents.setNoPayout(ev.id, null);
    const gone = await repo.payoutEvents.create({
      name: `np-cancelled-${RUN}`, serverId: srv.id, openMode: "at", openAnchor: FUTURE, closeMode: "at", closeAnchor: FUTURE,
      minMinutes: 0, mapVoteProfile: null, rotationSetId: null, createdBy: "t",
    });
    await repo.payoutEvents.cancel(gone.id);
    const onCancelled = await repo.payoutEvents.setNoPayout(gone.id, mark);
    const onMissing = await repo.payoutEvents.setNoPayout("00000000-0000-4000-8000-000000000046", mark);
    await repo.servers.remove(srv.id);
    return {
      fresh, whileScheduled, whileOpen, onCancelled, onMissing,
      marked: [marked?.status, marked?.noPayoutAt, marked?.noPayoutBy],
      read: [read?.noPayoutAt, read?.noPayoutBy],
      listed: [listed?.noPayoutAt, listed?.noPayoutBy],
      cleared: [cleared?.noPayoutAt, cleared?.noPayoutBy],
    };
  };
  const mem = await ask(new InMemoryRepository());
  assert.deepEqual(mem.fresh, [null, null]);
  assert.equal(mem.whileScheduled, null, "an event still to happen has nothing to decide yet");
  assert.equal(mem.whileOpen, null, "nor one still running");
  assert.deepEqual(mem.marked, ["closed", T(70), "Reaper"], "a finished one takes the mark, and stays closed");
  assert.deepEqual(mem.read, [T(70), "Reaper"]);
  assert.deepEqual(mem.listed, [T(70), "Reaper"], "the list carries it, which is what the screen reads");
  assert.deepEqual(mem.cleared, [null, null], "undoing clears who as well as when");
  assert.equal(mem.onCancelled, null, "a cancelled event was never going to be paid");
  assert.equal(mem.onMissing, null);
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    assert.deepEqual(await ask(pg), mem);
    await pg.close?.();
  }
});

test("imported team switches take the import's reading: teams filled, swaps named, a named swap never rewritten", async () => {
  /*
   * The CRCON import stores each switch as the archive streams, described on its own, and names the
   * swaps once the whole archive has been seen — this is the write that carries that reading back.
   * It also fills rows an earlier import stored with no teams at all. What it must never do is
   * rewrite a swap already named, touch a live (non-imported) row, or count a row it left as it was.
   */
  const check = async (repo: Repository) => {
    const s = await repo.servers.create({ name: `SW ${RUN}`, host: "10.9.9.80", port: 80, password: "x" });
    const row = (key: string, n: number, data: Record<string, unknown> | null) => ({
      serverId: s.id, ts: T(n), kind: "evt.player.teamSwitched", actorPlayerId: null, actorName: "Echo",
      victimPlayerId: null, victimName: null, weapon: null, data, dedupeKey: key,
    });
    const swap = { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" };
    await repo.events.insert([
      row("crcon:1", 1, null), // an earlier import's row, with no teams
      row("crcon:2", 2, { from: "None", to: "Axis", change: "joined Axis" }), // this import's, described alone
      row("crcon:3", 3, { change: "left Allies", to: "None", from: "Allies" }), // already right (keys in another order)
      row("crcon:4", 4, { ...swap, swapCount: 3 }), // a swap an earlier import already named
      row("live:5", 5, { from: "None", to: "Axis", change: "joined Axis" }), // ingested live, not imported
    ]);
    const changed = await repo.events.fillImportedTeamSwitches(s.id, [
      { dedupeKey: "crcon:1", ts: T(1), data: { from: "None", to: "Allies", change: "joined Allies" } },
      { dedupeKey: "crcon:2", ts: T(2), data: swap },
      { dedupeKey: "crcon:3", ts: T(3), data: { from: "Allies", to: "None", change: "left Allies" } },
      { dedupeKey: "crcon:4", ts: T(4), data: swap },
      { dedupeKey: "live:5", ts: T(5), data: swap },
    ]);
    assert.equal(changed, 2, "only the row with no teams and the swap left unnamed changed");
    const rows = await repo.events.listRecent(s.id, 10);
    const of = (key: string) => rows.find((e) => e.dedupeKey === key)?.data;
    assert.deepEqual(of("crcon:1"), { from: "None", to: "Allies", change: "joined Allies" });
    assert.deepEqual(of("crcon:2"), swap);
    assert.deepEqual(of("crcon:4"), { ...swap, swapCount: 3 }, "a named swap is never rewritten");
    assert.deepEqual(of("live:5"), { from: "None", to: "Axis", change: "joined Axis" }, "a live row is not the import's");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("seeding's position-rules switch: off by default, and saved when set", async () => {
  const check = async (repo: Repository) => {
    const s = await repo.servers.create({ name: `POS ${RUN}`, host: "10.9.9.70", port: 70, password: "x" });
    const first = await repo.seeding.upsertConfig(s.id, { enabled: true });
    assert.equal(first.positionalEnabled, false);
    const on = await repo.seeding.upsertConfig(s.id, { positionalEnabled: true });
    assert.equal(on.positionalEnabled, true);
    assert.equal((await repo.seeding.getConfig(s.id))?.positionalEnabled, true, "read back from the store");
    assert.equal((await repo.seeding.upsertConfig(s.id, { enabled: false })).positionalEnabled, true, "an unrelated save keeps it");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("a section's master switch holds its rules and leaves their own switches alone, in both stores", async () => {
  /*
   * Off holds every rule filed under the section, read on the rule itself (sectionOff) from every
   * way a rule comes back: list, get, and the row a create or an edit returns. Each rule's own
   * switch is never written, so switching the section back on brings back exactly what was on.
   */
  const check = async (repo: Repository) => {
    const sec = await repo.ruleSections.create(`Switch ${RUN} ${Math.random().toString(36).slice(2, 6)}`);
    assert.equal(sec.enabled, true, "a section starts on");
    const rule = (name: string, extra: Record<string, unknown> = {}) =>
      repo.enforcerRules.create({ name: `${name} ${RUN}`, eventKind: "evt.kill", action: "message", ...extra });
    const on = await rule("on", { sectionId: sec.id });
    const ownOff = await rule("own-off", { enabled: false, sectionId: sec.id });
    const loose = await rule("loose");
    assert.equal(on.sectionOff, false);
    assert.equal((await repo.ruleSections.setEnabled(sec.id, false))?.enabled, false);
    assert.equal((await repo.ruleSections.list()).find((x) => x.id === sec.id)?.enabled, false, "the switch is stored");
    const read = async (id: string) => (await repo.enforcerRules.list()).find((r) => r.id === id)!;
    assert.equal((await read(on.id)).sectionOff, true, "the list reads the section's switch");
    assert.equal((await repo.enforcerRules.get(on.id))?.sectionOff, true, "so does get");
    assert.equal(ruleSwitchedOn(await read(on.id)), false);
    assert.equal((await read(on.id)).enabled, true, "its own switch is untouched");
    assert.equal((await read(loose.id)).sectionOff, false, "a rule in no section is held by none");
    // Made, or edited, while its section is off: the row handed back says so.
    const made = await rule("made", { sectionId: sec.id });
    assert.equal(made.sectionOff, true);
    assert.equal((await repo.enforcerRules.update(on.id, { reason: "edited" }))?.sectionOff, true);
    // Back on: exactly what was on before.
    await repo.ruleSections.setEnabled(sec.id, true);
    assert.equal(ruleSwitchedOn(await read(on.id)), true);
    assert.equal(ruleSwitchedOn(await read(ownOff.id)), false, "a rule switched off on its own stays off");
    // Moved out of an off section, a rule is no longer held; a removed section frees the rest.
    await repo.ruleSections.setEnabled(sec.id, false);
    await repo.enforcerRules.setSection([made.id], null);
    assert.equal((await read(made.id)).sectionOff, false);
    await repo.ruleSections.remove(sec.id);
    assert.equal((await read(on.id)).sectionOff, false);
    assert.equal(await repo.ruleSections.setEnabled(sec.id, true), null, "a section that is gone");
    for (const id of [on.id, ownOff.id, loose.id, made.id]) await repo.enforcerRules.remove(id);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("a rule's pause: kept with who and why, read back by every way a rule comes out, lifted by null — and never an edit", async () => {
  const check = async (repo: Repository) => {
    const rule = await repo.enforcerRules.create({ name: `pause ${RUN}`, eventKind: "evt.kill", action: "message" });
    assert.equal(rule.pausedUntil, null);
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    const paused = await repo.enforcerRules.setPause(rule.id, { until, reason: "event night", by: "Ana" });
    assert.equal(paused?.pausedUntil, until);
    assert.equal(paused?.pauseReason, "event night");
    assert.equal(paused?.pausedBy, "Ana");
    assert.equal(paused?.updatedAt, rule.updatedAt, "a pause is not an edit — a schedule reads updatedAt as one");
    assert.equal(paused?.enabled, true, "nor is it the rule's own switch");
    const listed = (await repo.enforcerRules.list()).find((r) => r.id === rule.id)!;
    assert.equal(listed.pausedUntil, until);
    assert.equal((await repo.enforcerRules.get(rule.id))?.pauseReason, "event night");
    assert.equal(rulePaused(listed, Date.now()), true);
    assert.equal(rulePaused(listed, Date.parse(until) + 1), false, "a pause lifts itself once its moment passes");
    // An edit leaves the pause where it was.
    assert.equal((await repo.enforcerRules.update(rule.id, { reason: "edited" }))?.pausedUntil, until);
    const lifted = await repo.enforcerRules.setPause(rule.id, null);
    assert.equal(lifted?.pausedUntil, null);
    assert.equal(lifted?.pauseReason, null);
    assert.equal(lifted?.pausedBy, null);
    assert.equal(await repo.enforcerRules.setPause("00000000-0000-4000-8000-000000000000", null), null, "a rule that is gone");
    await repo.enforcerRules.remove(rule.id);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("version history: saves kept newest first and trimmed per record, the latest deletion of each, and a record back under its own id — in both stores", async () => {
  const check = async (repo: Repository) => {
    const target = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
    const save = (n: number, change: "edit" | "delete" | "restore" = "edit") => repo.configVersions.record({
      kind: "rule", targetId: target, targetName: `R${n}`, change, before: { threshold: n }, after: change === "delete" ? null : { threshold: n + 1 },
      actorUserId: null, actorName: "Ana",
    });
    const first = await save(1);
    assert.deepEqual(first.before, { threshold: 1 });
    assert.equal(first.actorName, "Ana");
    for (let n = 2; n <= CONFIG_VERSIONS_KEPT + 3; n++) await save(n);
    const kept = await repo.configVersions.list("rule", target);
    assert.equal(kept.length, CONFIG_VERSIONS_KEPT, "the oldest go first");
    assert.deepEqual(kept[0]!.before, { threshold: CONFIG_VERSIONS_KEPT + 3 }, "newest first");
    assert.deepEqual(kept[kept.length - 1]!.before, { threshold: 4 });
    assert.equal(await repo.configVersions.get(first.id), null, "a trimmed save is gone");
    assert.equal((await repo.configVersions.list("mapSet", target)).length, 0, "kinds are kept apart");
    assert.equal((await repo.configVersions.get(kept[0]!.id))?.targetName, `R${CONFIG_VERSIONS_KEPT + 3}`);

    // Deletions: each record's latest, newest first.
    const other = `${target}-b`;
    await repo.configVersions.record({ kind: "rule", targetId: other, targetName: "B", change: "delete", before: { n: 1 }, after: null, actorUserId: null, actorName: null });
    await save(100, "delete");
    await save(101, "delete");
    const gone = (await repo.configVersions.deletions("rule")).filter((v) => v.targetId === target || v.targetId === other);
    assert.deepEqual(gone.map((v) => [v.targetId, v.targetName]), [[target, "R101"], [other, "B"]]);

    // A deleted rule, map set and schedule come back under their own ids.
    const ruleId = "11111111-2222-4333-8444-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    const rule = await repo.enforcerRules.create({ id: ruleId, name: `back ${RUN}`, eventKind: "evt.kill", action: "message" });
    assert.equal(rule.id, ruleId);
    assert.equal((await repo.enforcerRules.get(ruleId))?.name, `back ${RUN}`);
    const setId = "22222222-2222-4333-8444-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    const set = await repo.mapSets.create({ id: setId, name: `Set ${target}`, game: "hll", pool: {} });
    assert.equal(set.id, setId);
    const schedId = "33333333-2222-4333-8444-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    const sched = await repo.voteSchedules.create({ id: schedId, name: `Sched ${target}`, spec: {} });
    assert.equal(sched.id, schedId);
    await repo.enforcerRules.remove(ruleId);
    await repo.mapSets.remove(setId);
    await repo.voteSchedules.remove(schedId);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("clan tags: counted per spelling and per group, worn now told from taken off, wearers listed first — in both stores", async () => {
  const check = async (repo: Repository) => {
    // A game id of this test's own: every count below is about this world alone.
    const game = `${GAME}c`;
    const now = Date.now();
    const at = (min: number) => new Date(now + min * 60_000).toISOString();
    const day = 24 * 60;
    const see = (id: string, name: string, min: number, clanTag?: string) =>
      repo.players.upsert({ game, platform: "steam", platformId: `cl-${id}-${RUN}`, name, ts: at(min), ...(clanTag !== undefined ? { clanTag } : {}) });
    // Ana has worn [KLM] for ten days and wears it now.
    await see("a", "Ana", -10 * day, "[KLM]");
    const ana = await see("a", "Ana", -1, "[KLM]");
    // Bob wore it (in small capitals) a week ago, and was seen today without it.
    await see("b", "Bob", -7 * day, "ᴋʟᴍ");
    const bob = await see("b", "Bob", -1);
    // Cid wore [KLM] five days ago and wears RIVAL now.
    await see("c", "Cid", -5 * day, "[KLM]");
    const cid = await see("c", "Cid", -2, "RIVAL");
    // Dee's tag was read three minutes ago; a log line moved her last seen since. Still worn.
    await see("d", "Dee", -3, "RIVAL");
    const dee = await see("d", "Dee", -1);

    const spellings = new Map((await repo.clanTags.spellings({ game })).map((s) => [s.tag, [s.ever, s.now]]));
    assert.deepEqual(Object.fromEntries(spellings), { "[KLM]": [2, 1], "ᴋʟᴍ": [1, 0], "RIVAL": [2, 2] });
    for (const t of ["[KLM]", "ᴋʟᴍ", "RIVAL"]) assert.ok((await repo.clanTags.tags()).includes(t));

    // A group counts each player once, however many of its spellings they wore.
    const stats = new Map((await repo.clanTags.groupStats([{ key: "klm", tags: ["[KLM]", "ᴋʟᴍ"] }, { key: "rival", tags: ["RIVAL"] }], { game }))
      .map((s) => [s.key, [s.ever, s.now]]));
    assert.deepEqual(Object.fromEntries(stats), { klm: [3, 1], rival: [2, 2] });

    const listed = await repo.clanTags.members({ tags: ["[KLM]", "ᴋʟᴍ"], game });
    assert.equal(listed.total, 3);
    assert.deepEqual(listed.rows.map((r) => [r.player.id, r.tag, r.wearingNow, r.currentTag]), [
      [ana.id, "[KLM]", true, "[KLM]"], // wearing it: first
      [cid.id, "[KLM]", false, "RIVAL"], // then by when they last wore it
      [bob.id, "ᴋʟᴍ", false, null],
    ]);
    assert.equal(Date.parse(listed.rows[0]!.firstSeen), Date.parse(at(-10 * day)), "worn since its first sighting");
    assert.deepEqual((await repo.clanTags.members({ tags: ["[KLM]", "ᴋʟᴍ"], game, status: "now" })).rows.map((r) => r.player.id), [ana.id]);
    assert.deepEqual((await repo.clanTags.members({ tags: ["[KLM]", "ᴋʟᴍ"], game, status: "former" })).rows.map((r) => r.player.id), [cid.id, bob.id]);
    const page = await repo.clanTags.members({ tags: ["[KLM]", "ᴋʟᴍ"], game, limit: 1, offset: 1 });
    assert.deepEqual([page.total, page.rows.map((r) => r.player.id)], [3, [cid.id]], "paged, with the whole count");
    assert.deepEqual((await repo.clanTags.members({ tags: ["RIVAL"], game, status: "now" })).rows.map((r) => r.player.id).sort(), [cid.id, dee.id].sort());
    assert.deepEqual(await repo.clanTags.members({ tags: [], game }), { rows: [], total: 0 });

    // The directory's clan filter: anyone who has worn one of the spellings.
    assert.deepEqual((await repo.players.directory({ game, clanTags: ["ᴋʟᴍ"] })).map((p) => p.id), [bob.id]);
    assert.equal(await repo.players.directoryCount({ game, clanTags: ["[KLM]", "ᴋʟᴍ"] }), 3);
    assert.equal(await repo.players.directoryCount({ game, clanTags: [] }), 0, "a tag nobody wore finds nobody");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("When people play: each hour's figure in the viewer's zone, a zero only where the app was watching — in both stores", async () => {
  const check = async (repo: Repository, label: string) => {
    const s = await repo.servers.create({ name: `Hours ${label}`, host: "10.9.9.11", port: 11, password: "x" });
    const other = await repo.servers.create({ name: `Hours other ${label}`, host: "10.9.9.12", port: 12, password: "x" });
    assert.ok(s && other);
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `${RUN}-hr-${label}`, name: "Hal", ts: "2026-07-01T00:00:00.000Z" });
    const sides = (allies: number, axis: number, noSl: [string[], string[]], unsquadded: [number, number]) => ({
      players: allies + axis, unassigned: 0, byRole: {},
      bySide: {
        allies: { players: allies, squads: 2, unsquadded: unsquadded[0], noSlSquads: noSl[0], byRole: {} },
        axis: { players: axis, squads: 2, unsquadded: unsquadded[1], noSlSquads: noSl[1], byRole: {} },
      },
    });
    // August in Chicago is UTC-5: 15:05 UTC is 10:05 there.
    await repo.rosterSnapshots.record({ serverId: s.id, ts: "2026-08-01T15:05:00.000Z", playerCount: 40, composition: sides(22, 18, [["ABLE"], []], [2, 1]), queueCount: 3, vipQueueCount: 1 });
    await repo.rosterSnapshots.record({ serverId: s.id, ts: "2026-08-01T15:35:00.000Z", playerCount: 52, composition: sides(25, 27, [["ABLE", "BAKER"], ["CHARLIE"]], [0, 4]), queueCount: 1, vipQueueCount: null });
    // 12:10, an empty server whose queue was never read.
    await repo.rosterSnapshots.record({ serverId: s.id, ts: "2026-08-01T17:10:00.000Z", playerCount: 0, composition: sides(0, 0, [[], []], [0, 0]) });
    // 21:30 in Chicago is 02:30 UTC the NEXT day, so the zone decides the row. A sample with no
    // sides says nothing about teams or squads.
    await repo.rosterSnapshots.record({ serverId: s.id, ts: "2026-08-02T02:30:00.000Z", playerCount: 7, composition: { players: 7, unassigned: 7, byRole: {}, bySide: {} }, queueCount: 0 });
    // Another server's sample, and one past the window.
    await repo.rosterSnapshots.record({ serverId: other.id, ts: "2026-08-01T15:10:00.000Z", playerCount: 99, composition: sides(50, 49, [[], []], [0, 0]), queueCount: 6 });
    await repo.rosterSnapshots.record({ serverId: s.id, ts: "2026-08-03T06:00:00.000Z", playerCount: 88, composition: sides(44, 44, [[], []], [0, 0]), queueCount: 5 });
    // A queue that cannot be a count of people: the sample is kept, its queue is not.
    await repo.rosterSnapshots.record({ serverId: s.id, ts: "2026-08-02T19:00:00.000Z", playerCount: 3, composition: { players: 3, unassigned: 3, byRole: {}, bySide: {} }, queueCount: 2.5, vipQueueCount: 0.5 });

    const ev = (ts: string, kind: string, n: number, serverId = s.id) => ({ serverId, ts, kind, actorPlayerId: p.id, actorName: "Hal", dedupeKey: `${RUN}-hr-${label}-${n}` });
    await repo.events.insert([
      ev("2026-08-01T15:20:00.000Z", "evt.kill", 1),
      ev("2026-08-01T15:50:00.000Z", "evt.kill", 2),
      ev("2026-08-01T15:30:00.000Z", "evt.teamkill", 3),
      // 15:00 in Chicago: an hour the app took no sample in, with a kill on the record all the same.
      ev("2026-08-01T20:00:00.000Z", "evt.kill", 4),
      ev("2026-08-01T17:15:00.000Z", "evt.chat.team", 5),
      ev("2026-08-01T17:20:00.000Z", "evt.chat.squad", 6),
      ev("2026-08-02T02:40:00.000Z", "evt.player.kicked", 7),
      ev("2026-08-02T02:45:00.000Z", "evt.player.banned", 8),
      ev("2026-08-01T15:25:00.000Z", "evt.kill", 9, other.id),
      ev("2026-08-03T06:10:00.000Z", "evt.kill", 10),
    ]);
    const visit = (connectedAt: string) => repo.sessions.importOne({
      playerId: p.id, serverId: s.id, connectedAt, disconnectedAt: new Date(Date.parse(connectedAt) + 600_000).toISOString(), durationSec: 600,
    });
    await visit("2026-08-01T15:01:00.000Z");
    await visit("2026-08-01T15:40:00.000Z");
    await visit("2026-08-02T14:00:00.000Z"); // Aug 2, 09:00 in Chicago: not watched, but on the record

    const win = { serverId: s.id, from: "2026-08-01T05:00:00.000Z", to: "2026-08-03T05:00:00.000Z", tz: "America/Chicago" };
    const cells = async (metric: HourMetric, q = win) => {
      const rows = await repo.analytics.hourGrid(q, metric);
      const out: Record<string, number> = {};
      for (const r of rows) r.hours.forEach((v, h) => { if (v !== null) out[`${r.date} ${h}`] = v; });
      return { dates: rows.map((r) => r.date), out };
    };
    const peak = await cells("peak");
    assert.deepEqual(peak.dates, ["2026-08-01", "2026-08-02"], `${label}: a row for every local date in the window`);
    assert.deepEqual(peak.out, { "2026-08-01 10": 52, "2026-08-01 12": 0, "2026-08-01 21": 7, "2026-08-02 14": 3 }, `${label}: the highest sample in each hour`);
    assert.deepEqual((await cells("queue")).out, { "2026-08-01 10": 2.5, "2026-08-01 21": 0 },
      `${label}: queue and VIP queue together, averaged; an hour whose queue was never read has no figure`);
    assert.deepEqual((await cells("imbalance")).out, { "2026-08-01 10": 3, "2026-08-01 12": 0 }, `${label}: |22-18| and |25-27| average 3; a sample without sides says nothing`);
    assert.deepEqual((await cells("noLeader")).out, { "2026-08-01 10": 2, "2026-08-01 12": 0 }, `${label}: 1 and 3 leaderless squads average 2`);
    assert.deepEqual((await cells("unsquadded")).out, { "2026-08-01 10": 3.5, "2026-08-01 12": 0 }, `${label}: 3 and 4 outside a squad average 3.5`);
    // Counted: a zero where the app took a sample, nothing where it has no record at all.
    assert.deepEqual((await cells("kills")).out, { "2026-08-01 10": 2, "2026-08-01 12": 0, "2026-08-01 15": 1, "2026-08-01 21": 0, "2026-08-02 14": 0 }, `${label}: kills`);
    assert.deepEqual((await cells("teamkills")).out, { "2026-08-01 10": 1, "2026-08-01 12": 0, "2026-08-01 21": 0, "2026-08-02 14": 0 }, `${label}: team kills`);
    assert.deepEqual((await cells("chat")).out, { "2026-08-01 10": 0, "2026-08-01 12": 2, "2026-08-01 21": 0, "2026-08-02 14": 0 }, `${label}: team and squad chat`);
    assert.deepEqual((await cells("moderation")).out, { "2026-08-01 10": 0, "2026-08-01 12": 0, "2026-08-01 21": 2, "2026-08-02 14": 0 }, `${label}: kicks and bans`);
    assert.deepEqual((await cells("arrivals")).out, { "2026-08-01 10": 2, "2026-08-01 12": 0, "2026-08-01 21": 0, "2026-08-02 9": 1, "2026-08-02 14": 0 }, `${label}: visits by the hour they began`);
    assert.deepEqual((await repo.rosterSnapshots.list({ serverId: s.id, from: "2026-08-02T19:00:00.000Z", to: "2026-08-02T19:00:01.000Z" })).map((r) => [r.playerCount, r.queueCount, r.vipQueueCount]),
      [[3, null, null]], `${label}: a fractional queue is not stored, and the sample is`);
    // The same samples read in UTC land on other hours, and the 21:30 one on the next date.
    const utc = await cells("peak", { ...win, tz: "UTC" });
    assert.deepEqual(utc.dates, ["2026-08-01", "2026-08-02", "2026-08-03"]);
    assert.deepEqual(utc.out, { "2026-08-01 15": 52, "2026-08-01 17": 0, "2026-08-02 2": 7, "2026-08-02 19": 3 }, `${label}: UTC`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

test("the directory's VIP star and VIP-only filter: a retired server's grant is not held now, and is again once the server is back — in both stores", async () => {
  const check = async (repo: Repository) => {
    // A game id of this test's own: every answer below is about this world alone.
    const game = `${GAME}r`;
    const live = await repo.servers.create({ name: "Live", host: "10.9.8.1", port: 1, password: "x" });
    const gone = await repo.servers.create({ name: "Gone", host: "10.9.8.2", port: 2, password: "x" });
    const [both, onlyGone] = await repo.players.upsertMany([
      { game, platform: "steam", platformId: `rv-1-${RUN}`, name: "Both", ts: T(0) },
      { game, platform: "steam", platformId: `rv-2-${RUN}`, name: "OnlyGone", ts: T(0) },
    ]);
    assert.ok(both && onlyGone);
    await repo.vips.upsert({ serverId: live.id, playerId: both.platformId, expiration: null, createdByName: "staff" });
    await repo.vips.upsert({ serverId: gone.id, playerId: both.platformId, expiration: FUTURE, createdByName: "staff" });
    await repo.vips.upsert({ serverId: gone.id, playerId: onlyGone.platformId, expiration: null, createdByName: "staff" });
    const stars = async () => Object.fromEntries((await repo.players.directory({ game })).map((p) => [p.name, p.vip]));
    const vipOnly = async () => (await repo.players.directory({ game, vipOnly: true })).map((p) => p.name).sort();

    assert.deepEqual(await stars(), { Both: true, OnlyGone: true }, "while both servers are in use, both players hold VIP");
    assert.deepEqual(await vipOnly(), ["Both", "OnlyGone"]);

    await repo.servers.setRetired(gone.id, true);
    assert.deepEqual(await stars(), { Both: true, OnlyGone: false }, "a retired server's grant is not VIP the player has now");
    assert.deepEqual(await vipOnly(), ["Both"]);
    assert.equal(await repo.players.directoryCount({ game, vipOnly: true }), 1, "and the count agrees with the page");
    assert.equal((await repo.vips.listByPlayer(onlyGone.platformId)).length, 1, "the grant itself is kept");

    await repo.servers.setRetired(gone.id, false);
    assert.deepEqual(await stars(), { Both: true, OnlyGone: true }, "it is VIP again once the server is back");
    assert.deepEqual(await vipOnly(), ["Both", "OnlyGone"]);
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

test("a voter's map-vote history narrowed to a set of servers: totals, preferences and ballots alike — in both stores", async () => {
  const check = async (repo: Repository) => {
    const a = await repo.servers.create({ name: "Votes A", host: "10.9.7.1", port: 1, password: "x" });
    const b = await repo.servers.create({ name: "Votes B", host: "10.9.7.2", port: 2, password: "x" });
    const voter = `dv-${RUN}`;
    const vote = (serverId: string, mapId: string) => repo.mapVote.recordHistory({
      serverId, profile: "default",
      options: [{ id: mapId, name: mapId, votes: 1, voters: [{ discordId: voter, name: "v" }] }],
      winnerId: mapId, winnerName: mapId, totalVotes: 1, outcome: "vote", applied: true,
    });
    await vote(a.id, "foy_warfare");
    await vote(b.id, "carentan_warfare");
    await vote(b.id, "carentan_warfare");

    assert.equal((await repo.mapVote.voterTotals(voter)).votes, 3, "unnarrowed: every server");
    assert.equal((await repo.mapVote.voterTotals(voter, undefined, [a.id])).votes, 1);
    assert.equal((await repo.mapVote.voterTotals(voter, undefined, [a.id, b.id])).votes, 3);
    assert.deepEqual((await repo.mapVote.preferences(voter, { serverIds: [a.id] })).map((p) => p.mapId), ["foy_warfare"]);
    assert.deepEqual((await repo.mapVote.ballots(voter, { serverIds: [b.id] })).map((x) => x.serverId), [b.id, b.id]);
    assert.equal((await repo.mapVote.ballots(voter, { serverIds: [] })).length, 0, "an empty set is no servers, not every server");
  };
  await check(new InMemoryRepository());
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    await check(pg);
    await pg.close?.();
  }
});

/*
 * A watcher on the audit trail (the phone notifications' ear on staff actions): every row this
 * process writes, once, as stored — its own copy, so a listener cannot change what the caller got
 * back. A listener that throws changes nothing, and one that stopped hears nothing more.
 */
test("an audit watcher hears each row as it is written, its own copy, until it stops", async () => {
  const check = async (repo: Repository, label: string) => {
    const heard: AuditRow[] = [];
    const stop = repo.audit.watch((row) => { heard.push(row); row.summary = "changed by a listener"; });
    const stopThrower = repo.audit.watch(() => { throw new Error("a listener that breaks"); });
    const tag = `${RUN}-watch-${label}`;
    const row = await repo.audit.create({ actorUserId: null, actorName: "staff", action: "config.set", targetType: "server", targetId: tag, summary: tag, data: { field: "idleKickMinutes", value: 10 } });
    assert.equal(row.summary, tag, `${label}: the caller's row is its own`);
    assert.deepEqual(heard.map((r) => [r.id, r.action, r.summary === "changed by a listener", (r.data as { field?: string } | null)?.field]), [[row.id, "config.set", true, "idleKickMinutes"]], `${label}: heard once, as stored`);
    const listed = (await repo.audit.list({ q: tag })).map((r) => r.summary);
    assert.deepEqual(listed, [tag], `${label}: written whatever the listeners did`);
    stop();
    stopThrower();
    await repo.audit.create({ actorUserId: null, actorName: "staff", action: "config.set", targetType: "server", targetId: tag, summary: `${tag}-2` });
    assert.equal(heard.length, 1, `${label}: nothing after stopping`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/* A notice read before an edit is the notice as it was: the edit route compares the two to tell a
 * draft being posted from a posted notice being edited, and words the trail (and the staff
 * board's notification) by it. */
test("a notice read before an edit keeps saying what it said then", async () => {
  const check = async (repo: Repository, label: string) => {
    const draft = await repo.announcements.create({ title: `${RUN}-${label}`, body: "x", published: false, authorUserId: null });
    const before = await repo.announcements.get(draft.id);
    const after = await repo.announcements.update(draft.id, { published: true });
    assert.equal(before?.published, false, `${label}: the earlier read is untouched`);
    assert.equal(after?.published, true, `${label}: the edit took`);
    assert.equal((await repo.announcements.get(draft.id))?.published, true, `${label}: and is what a fresh read sees`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/*
 * The staff board's pages: each a run of the newest-first list, so paging through it visits every
 * notice once, and the counts say how many there are. The battery's database is shared with other
 * suites, which may post a notice mid-read: a read whose count moved under it is read again.
 */
test("the board's pages run down the newest-first list with nothing repeated or missed, and its counts agree — in both stores", async () => {
  const check = async (repo: Repository, label: string) => {
    for (let i = 0; i < 7; i++) await repo.announcements.create({ title: `${RUN}-${label}-${i}`, body: "x", published: i % 3 !== 2, authorUserId: null });
    const read = async (count: () => Promise<number>, list: (limit: number, offset: number) => Promise<{ id: string; title: string }[]>) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const n = await count();
        const whole = await list(n + 10, 0);
        const paged: { id: string; title: string }[] = [];
        for (let offset = 0; offset < n + 3; offset += 3) paged.push(...(await list(3, offset)));
        if ((await count()) === n) return { n, whole, paged };
      }
      throw new Error(`${label}: the board kept changing while it was read`);
    };
    for (const [what, count, list, mine] of [
      ["posted", () => repo.announcements.countPublished(), (l: number, o: number) => repo.announcements.listPublished(l, o), 5],
      ["all", () => repo.announcements.countAll(), (l: number, o: number) => repo.announcements.listAll(l, o), 7],
    ] as const) {
      const { n, whole, paged } = await read(count, list);
      assert.equal(whole.length, n, `${label} ${what}: the count is the list's length`);
      assert.deepEqual(paged.map((a) => a.id), whole.map((a) => a.id), `${label} ${what}: the pages are the list, in order`);
      assert.equal(whole.filter((a) => a.title.startsWith(`${RUN}-${label}-`)).length, mine, `${label} ${what}: this run's notices are on it`);
    }
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});

/*
 * A search box finds what was typed. Gamer names are full of underscores, and to Postgres's LIKE an
 * underscore is "any one character" and % is "anything": a search for "a_b" also found "axb", a
 * lone "_" matched every name, and "100%" matched "1000" — while the memory store found exactly
 * the text. Every search the screens offer is asked here, of both stores.
 */
test("a search finds the text typed — _, % and \\ are characters, not wildcards — in both stores", async () => {
  const check = async (repo: Repository, label: string) => {
    // A game id and a name stem of this test's own: every answer below is about this world alone.
    const game = `${GAME}w`;
    const tag = `wc${RUN}`;
    const server = await repo.servers.create({ name: "Wild", host: "10.9.6.1", port: 1, password: "x" });
    const names = [`${tag}_a`, `${tag}xa`, `${tag}100%`, `${tag}1000`, `${tag}\\b`, `${tag}b`];
    await repo.players.upsertMany(names.map((name, i) => ({ game, platform: "steam", platformId: `wc-${i}-${RUN}`, name, ts: T(0) })));
    const search = async (q: string) => (await repo.players.search(q)).filter((p) => p.game === game).map((p) => p.name).sort();
    assert.deepEqual(await search(`${tag}_a`), [`${tag}_a`], `${label}: an underscore is an underscore`);
    assert.deepEqual(await search(`${tag}100%`), [`${tag}100%`], `${label}: a percent sign is a percent sign`);
    assert.deepEqual(await search(`${tag}\\b`), [`${tag}\\b`], `${label}: a backslash is a backslash`);
    assert.deepEqual((await repo.players.directory({ game, q: "_a" })).map((p) => p.name), [`${tag}_a`], `${label}: the directory`);
    assert.equal(await repo.players.directoryCount({ game, q: "_a" }), 1, `${label}: and its count`);

    await repo.events.insert([
      { serverId: server.id, ts: T(1), kind: "evt.chat.team", actorName: "Ana", data: { message: "gg 100%" }, dedupeKey: `${RUN}-wc1` },
      { serverId: server.id, ts: T(2), kind: "evt.chat.team", actorName: "Bob", data: { message: "gg 1000" }, dedupeKey: `${RUN}-wc2` },
    ]);
    assert.deepEqual((await repo.events.query({ serverId: server.id, q: "100%" })).map((e) => e.actorName), ["Ana"], `${label}: the game log`);
    assert.equal(await repo.events.countQuery({ serverId: server.id, q: "100%" }), 1, `${label}: and its count`);

    await repo.audit.create({ actorUserId: null, actorName: "staff", action: "test.search", serverId: server.id, summary: `${tag} note_1` });
    await repo.audit.create({ actorUserId: null, actorName: "staff", action: "test.search", serverId: server.id, summary: `${tag} notex1` });
    assert.deepEqual((await repo.audit.list({ serverId: server.id, q: "note_1" })).map((r) => r.summary), [`${tag} note_1`], `${label}: the audit trail`);
    assert.equal(await repo.audit.count({ serverId: server.id, q: "note_1" }), 1, `${label}: and its count`);

    await repo.adminCam.importOne({ serverId: server.id, playerId: null, playerName: "Cam_1", enteredAt: T(3), exitedAt: T(4), durationSec: 60 });
    await repo.adminCam.importOne({ serverId: server.id, playerId: null, playerName: "Camx1", enteredAt: T(5), exitedAt: T(6), durationSec: 60 });
    assert.deepEqual((await repo.adminCam.list({ serverId: server.id, q: "m_1" })).map((r) => r.playerName), ["Cam_1"], `${label}: admin camera`);
    assert.equal(await repo.adminCam.count({ serverId: server.id, q: "m_1" }), 1, `${label}: and its count`);

    await repo.economy.ensureMember(`${RUN}-wc1`, `${tag}_m`);
    await repo.economy.ensureMember(`${RUN}-wc2`, `${tag}xm`);
    assert.deepEqual((await repo.economy.members({ q: `${tag}_m` })).map((m) => m.discordName), [`${tag}_m`], `${label}: community members`);
    assert.equal(await repo.economy.membersCount(`${tag}_m`), 1, `${label}: and their count`);
  };
  await check(new InMemoryRepository(), "memory");
  if (DB) {
    const { createPostgresRepository } = await import("../dist/postgres.js");
    const pg = await createPostgresRepository(DB);
    await pg.migrate();
    try { await check(pg, "pgsql"); } finally { await pg.close?.(); }
  }
});
