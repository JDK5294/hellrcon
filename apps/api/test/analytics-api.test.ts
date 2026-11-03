import { test } from "node:test";
import assert from "node:assert/strict";
import type { NewAudit, Repository } from "@app/db";
import { withIsolatedServer as withServer, jf, ownerAuth, assertAsked } from "./harness.ts";

async function makeGameServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "s", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

async function staffAuth(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string; scopeType?: string; scopeId?: string | null }[]) {
  const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  const put = await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
    method: "PUT", headers: owner,
    body: JSON.stringify({ grants: grants.map((g) => ({ scopeType: "global", scopeId: null, ...g })) }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

const PAGES = ["server", "match", "player", "combat", "staff", "mapvote"] as const;

test("every analytics page requires authentication", async () => {
  await withServer(async (base) => {
    for (const page of PAGES) {
      const r = await jf(`${base}/api/analytics/${page}`);
      assert.equal(r.status, 401, `${page} should be 401 unauthenticated`);
    }
  });
});

test("each analytics page is granted on its OWN capability and unlocks nothing else", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);

    // The whole point of five capabilities: someone given map-vote analytics sees map-vote
    // analytics, and is refused the other four.
    for (const page of PAGES) {
      const auth = await staffAuth(base, owner, `only-${page}`, [{ capability: `analytics.${page}`, level: "read" }]);
      const ok = await jf(`${base}/api/analytics/${page}?serverId=${serverId}`, { headers: auth });
      assert.equal(ok.status, 200, `${page} with its own capability: ${JSON.stringify(ok.body)}`);

      for (const other of PAGES) {
        if (other === page) continue;
        const denied = await jf(`${base}/api/analytics/${other}?serverId=${serverId}`, { headers: auth });
        assert.equal(denied.status, 403, `${page} grant must not unlock ${other}`);
        // The denial names the exact capability to grant, so an admin can act on it directly.
        assert.equal(denied.body.error?.missing?.capability, `analytics.${other}`);
        assert.equal(denied.body.error?.missing?.level, "read");
      }
    }
  });
});

test("analytics capabilities carry no admin power, and admin capabilities carry no analytics", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);

    // Placement in the Admin section of the sidebar is not privilege.
    const analyst = await staffAuth(base, owner, "analyst", PAGES.map((p) => ({ capability: `analytics.${p}`, level: "read" })));
    assert.equal((await jf(`${base}/api/users`, { headers: analyst })).status, 403);
    assert.equal((await jf(`${base}/api/audit`, { headers: analyst })).status, 403);
    // A player action without the write never EXECUTES for an analyst — it files as an
    // approval request instead (202: accepted, not performed; anyone may ask).
    const kick = await jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: analyst, body: JSON.stringify({ action: "kick", playerId: "1", reason: "x" }) });
    assert.equal(kick.status, 202);
    assert.equal(kick.body.requested, true);

    // And the reverse: the audit-trail capability does not hand over the staff analytics page.
    const auditor = await staffAuth(base, owner, "auditor", [{ capability: "audit.trail", level: "read" }]);
    assert.equal((await jf(`${base}/api/audit`, { headers: auditor })).status, 200);
    assert.equal((await jf(`${base}/api/analytics/staff`, { headers: auditor })).status, 403);
  });
});

test("server-scoped analytics can be granted for one server and refused for another", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const mine = await makeGameServer(base, owner);
    const theirs = await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "s2", host: "127.0.0.1", port: 2, password: "x" }) });
    const otherId = theirs.body.server.id as string;

    const scoped = await staffAuth(base, owner, "scoped", [
      { capability: "analytics.server", level: "read", scopeType: "server", scopeId: mine },
    ]);
    assert.equal((await jf(`${base}/api/analytics/server?serverId=${mine}`, { headers: scoped })).status, 200);
    assert.equal((await jf(`${base}/api/analytics/server?serverId=${otherId}`, { headers: scoped })).status, 403);
  });
});

test("the window is bounded, and echoed back so the page can say what it is showing", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);

    const def = await jf(`${base}/api/analytics/server?serverId=${serverId}`, { headers: owner });
    assert.equal(def.status, 200);
    const days = (Date.parse(def.body.window.to) - Date.parse(def.body.window.from)) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 0.01, `default window should be 30 days, got ${days}`);

    const wide = await jf(`${base}/api/analytics/server?serverId=${serverId}&days=99999`, { headers: owner });
    const wideDays = (Date.parse(wide.body.window.to) - Date.parse(wide.body.window.from)) / 86_400_000;
    assert.ok(wideDays <= 365, `window must be capped, got ${wideDays} days`);

    // Junk must not produce an Invalid Date window.
    const junk = await jf(`${base}/api/analytics/server?serverId=${serverId}&days=banana`, { headers: owner });
    assert.equal(junk.status, 200);
    assert.ok(!Number.isNaN(Date.parse(junk.body.window.from)));
  });
});

test("an empty instance answers with zeroes and nulls rather than failing", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);

    const s = await jf(`${base}/api/analytics/server?serverId=${serverId}`, { headers: owner });
    assert.equal(s.status, 200);
    assert.equal(s.body.activity.sessions, 0);
    assert.equal(s.body.activity.weekHour.length, 7);
    assert.equal(s.body.activity.weekHour[0].length, 24);
    assert.equal(s.body.balance.alliesWinRate, null);

    const m = await jf(`${base}/api/analytics/match?serverId=${serverId}`, { headers: owner });
    assert.equal(m.body.rounds, 0);
    assert.deepEqual(m.body.byMap, []);

    const p = await jf(`${base}/api/analytics/player`, { headers: owner });
    assert.equal(p.body.subject, null);
    assert.ok(Array.isArray(p.body.killDistribution.buckets));

    const v = await jf(`${base}/api/analytics/mapvote?serverId=${serverId}`, { headers: owner });
    assert.equal(v.body.votesHeld, 0);
    assert.equal(v.body.overrideRate, null);
  });
});

test("map-vote analytics without a server answers empty instead of erroring", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const r = await jf(`${base}/api/analytics/mapvote`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.votesHeld, 0);
    assert.deepEqual(r.body.maps, []);
  });
});

test("staff analytics counts real audited work and splits it by person", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    // Creating servers and users is itself audited work, so measure the shape rather than a
    // fixed total: the trail is never empty by the time we get here.
    await makeGameServer(base, owner);
    await makeGameServer(base, owner);

    const r = await jf(`${base}/api/analytics/staff`, { headers: owner });
    assert.equal(r.status, 200);
    assert.ok(r.body.totalActions > 0);
    assert.ok(r.body.activeStaff >= 1);
    assert.equal(r.body.members[0].name, "owner");
    // Shares are a partition of the total.
    const shares = (r.body.members as { share: number }[]).reduce((n, m) => n + m.share, 0);
    assert.ok(Math.abs(shares - 1) < 1e-9);
    assert.equal(r.body.weekHour.length, 7);
    assert.ok(r.body.uncoveredHours < 168); // something happened, so at least one hour is covered
  });
});

test("player analytics resolves a subject by either id and ranks it against the population", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    // A real server row: stats reference the server by uuid, so a made-up "srv-a" cannot be stored.
    const serverId = await makeGameServer(base, owner);
    // A small population: one strong player and two ordinary ones.
    const strong = await repo.players.upsert({ game: "hll", platformId: "76561190000000001", name: "Ace", platform: "steam" });
    const mid = await repo.players.upsert({ game: "hll", platformId: "76561190000000002", name: "Mid", platform: "steam" });
    const low = await repo.players.upsert({ game: "hll", platformId: "76561190000000003", name: "Low", platform: "steam" });
    await repo.stats.bump(strong.id, serverId, { kills: 500, deaths: 100 });
    await repo.stats.bump(mid.id, serverId, { kills: 100, deaths: 100 });
    await repo.stats.bump(low.id, serverId, { kills: 10, deaths: 100 });

    const byPlatform = await jf(`${base}/api/analytics/player?playerId=${strong.platformId}`, { headers: owner });
    assert.equal(byPlatform.status, 200);
    assert.equal(byPlatform.body.subject.name, "Ace");
    assert.equal(byPlatform.body.subject.stats.kills, 500);
    assert.equal(byPlatform.body.subject.killsPercentile, 67); // above 2 of 3
    assert.equal(byPlatform.body.subject.weekHour.length, 7);

    // The same player by our internal id — a name clicked anywhere must resolve.
    const byInternal = await jf(`${base}/api/analytics/player?playerId=${strong.id}`, { headers: owner });
    assert.equal(byInternal.body.subject.playerId, strong.id);

    const weak = await jf(`${base}/api/analytics/player?playerId=${low.platformId}`, { headers: owner });
    assert.equal(weak.body.subject.killsPercentile, 0); // nobody below them

    const missing = await jf(`${base}/api/analytics/player?playerId=nobody-here`, { headers: owner });
    assert.equal(missing.status, 404);
  });
});

test("combat analytics answers with an empty shape before any kills are recorded", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const r = await jf(`${base}/api/analytics/combat?serverId=${serverId}`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.kills, 0);
    assert.equal(r.body.tkRate, null);
    assert.deepEqual(r.body.weapons, []);
    assert.deepEqual(r.body.friendlyFireWeapons, []);
    assert.equal(r.body.weekHour.length, 7);
  });
});

test("combat analytics counts real kills, classifies weapons, and ranks team killers", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const shooter = await repo.players.upsert({ game: "hll", platformId: "76561190000000011", name: "Shooter", platform: "steam" });
    const tker = await repo.players.upsert({ game: "hll", platformId: "76561190000000012", name: "Careless", platform: "steam" });
    const victim = await repo.players.upsert({ game: "hll", platformId: "76561190000000013", name: "Victim", platform: "steam" });

    const now = Date.now();
    const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({
        serverId, ts: at(60 + i), kind: "evt.kill", actorPlayerId: shooter.id, actorName: "Shooter",
        victimPlayerId: victim.id, victimName: "Victim", weapon: "M1 GARAND", data: null, dedupeKey: `k${i}`,
      })),
      {
        serverId, ts: at(30), kind: "evt.teamkill", actorPlayerId: tker.id, actorName: "Careless",
        victimPlayerId: victim.id, victimName: "Victim", weapon: "155MM HOWITZER", data: null, dedupeKey: "tk1",
      },
    ];
    await repo.events.insert(rows as Parameters<typeof repo.events.insert>[0]);

    const r = await jf(`${base}/api/analytics/combat?serverId=${serverId}`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.kills, 5);
    assert.equal(r.body.teamkills, 1);
    assert.equal(r.body.tkRate, 20); // 1 team kill per 5 kills, per 100
    assert.equal(r.body.killers, 2, "both actors appear, one of them only via a team kill");
    assert.equal(r.body.victims, 1);

    const garand = (r.body.weapons as { weapon: string; kills: number; classId: string }[]).find((w) => w.weapon === "M1 GARAND");
    assert.equal(garand?.kills, 5);
    assert.ok(garand?.classId, "the weapon was classified against the game descriptor");

    assert.equal(r.body.topKillers[0].name, "Shooter");
    assert.equal(r.body.topKillers[0].kills, 5);
    assert.equal(r.body.topTeamkillers[0].name, "Careless");
    assert.equal(r.body.topTeamkillers[0].teamkills, 1);
    // Kills travel beside the team-kill count so the panel can show a personal rate.
    assert.equal(r.body.topTeamkillers[0].kills, 0);
  });
});

test("staff analytics carries the admin-response block even with nothing to report", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    await makeGameServer(base, owner);
    const r = await jf(`${base}/api/analytics/staff`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.response.requests, 0);
    assert.equal(r.body.response.medianSec, null);
    assert.equal(r.body.response.answeredRate, null);
    assert.equal(r.body.response.byHour.length, 24);
    assert.equal(r.body.response.weekHour.length, 7);
  });
});

test("admin calls are found by the server's configured trigger, and mentions of it are not calls", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const caller = await repo.players.upsert({ game: "hll", platformId: "76561190000000021", name: "Caller", platform: "steam" });
    const now = Date.now();
    const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

    await repo.events.insert([
      { serverId, ts: at(60), kind: "evt.chat.team", actorPlayerId: caller.id, actorName: "Caller",
        victimPlayerId: null, victimName: null, weapon: null, data: { message: "!admin someone is griefing" }, dedupeKey: "c1" },
      // Talking ABOUT the trigger is not a call for help — a substring search alone would count it.
      { serverId, ts: at(50), kind: "evt.chat.team", actorPlayerId: caller.id, actorName: "Caller",
        victimPlayerId: null, victimName: null, weapon: null, data: { message: "you can type !admin if you need help" }, dedupeKey: "c2" },
    ] as Parameters<typeof repo.events.insert>[0]);

    const r = await jf(`${base}/api/analytics/staff`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.response.requests, 1, "only the line that STARTS with the trigger counts");
    assert.equal(r.body.response.recent[0].message, "!admin someone is griefing");
  });
});

test("a staff action after a call is paired with it; one on another server is not", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const otherServer = (await jf(`${base}/api/servers`, {
      method: "POST", headers: owner,
      body: JSON.stringify({ name: "other", host: "127.0.0.1", port: 2, password: "x" }),
    })).body.server.id as string;
    const caller = await repo.players.upsert({ game: "hll", platformId: "76561190000000031", name: "Caller", platform: "steam" });
    const now = Date.now();

    // Two calls a minute apart on the watched server.
    await repo.events.insert([
      { serverId, ts: new Date(now - 600_000).toISOString(), kind: "evt.chat.team",
        actorPlayerId: caller.id, actorName: "Caller", victimPlayerId: null, victimName: null,
        weapon: null, data: { message: "!admin help" }, dedupeKey: "call1" },
      { serverId, ts: new Date(now - 540_000).toISOString(), kind: "evt.chat.team",
        actorPlayerId: caller.id, actorName: "Caller", victimPlayerId: null, victimName: null,
        weapon: null, data: { message: "!admin still here" }, dedupeKey: "call2" },
    ] as Parameters<typeof repo.events.insert>[0]);

    // The staff actions go straight to the trail: every real one needs a live RCON connection, and
    // the pairing under test reads the trail, not the game. The store stamps `now` itself, so the
    // ordering here — Alice first, then Bob — is what decides which call each one can answer.
    // Both are real accounts on the current roster: the response metric counts the staff you HAVE,
    // so automation (no actor id) and departed accounts alike are outside the population.
    const alice = await repo.users.create({ username: "alice", passwordHash: "x" });
    const bob = await repo.users.create({ username: "bob", passwordHash: "x" });
    await repo.audit.create({
      actorUserId: alice.id, actorName: "Alice", action: "player.kick",
      targetName: "Griefer", serverId, summary: "kicked Griefer",
    });
    // …and one on the OTHER server, which must not answer anything here.
    await repo.audit.create({
      actorUserId: bob.id, actorName: "Bob", action: "player.kick",
      targetName: "Someone", serverId: otherServer, summary: "kicked Someone",
    });

    // The analytics window ends at "now", exclusive, so an audit row stamped in the SAME
    // millisecond as the request would fall outside it. Real windows are 30 days wide and real
    // actions are seconds-to-days old, so this edge never comes up in use — but writing the row
    // and firing the request back to back lands on it often enough to make the test flap.
    await new Promise((r) => setTimeout(r, 5));

    const r = await jf(`${base}/api/analytics/staff`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.response.requests, 2);
    // Two calls, but only ONE action on this server: the second call stays unanswered even though
    // a kick happened on another server moments later. That exclusion is the point of the test.
    assert.equal(r.body.response.answered, 1);
    assert.equal(r.body.response.unanswered, 1);
    assert.equal(r.body.response.slowest[0].respondedBy, "Alice");
    assert.equal(r.body.response.slowest[0].respondedAction, "player.kick");
    // Alice's row lands at ~now, so the older call waited roughly its own age. Asserted as a range
    // because the trail timestamps itself — an exact equality here would be testing the clock.
    const waited = r.body.response.slowest[0].responseSec as number;
    assert.ok(waited >= 595 && waited <= 660, `expected the ~600s call to be the answered one, got ${waited}`);
  });
});

test("server analytics reports early leavers with the map they joined on", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const p1 = await repo.players.upsert({ game: "hll", platformId: "76561190000000041", name: "Quitter", platform: "steam" });
    const p2 = await repo.players.upsert({ game: "hll", platformId: "76561190000000042", name: "Stayer", platform: "steam" });

    const start = new Date(Date.now() - 3 * 3600_000).toISOString();
    const end = new Date(Date.now() - 1 * 3600_000).toISOString();
    await repo.matches.importOne({ serverId, map: "Foy", startedAt: start, endedAt: end, winner: "allies", result: null });

    const joinAt = new Date(Date.now() - 2.5 * 3600_000).toISOString();
    const short = 60;    // a minute — under the five-minute cutoff
    const long = 7200;   // two hours — well over it
    await repo.sessions.importOne({
      playerId: p1.id, serverId, connectedAt: joinAt,
      disconnectedAt: new Date(Date.parse(joinAt) + short * 1000).toISOString(), durationSec: short,
    });
    await repo.sessions.importOne({
      playerId: p2.id, serverId, connectedAt: joinAt,
      disconnectedAt: new Date(Date.parse(joinAt) + long * 1000).toISOString(), durationSec: long,
    });

    const r = await jf(`${base}/api/analytics/server?serverId=${serverId}`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.activity.sessions, 2);
    assert.equal(r.body.activity.shortSessions, 1);
    assert.equal(r.body.activity.shortCutoffSec, 300);
    const foy = (r.body.activity.earlyLeaversByMap as { map: string; sessions: number; short: number }[])
      .find((m) => m.map === "Foy");
    assert.equal(foy?.sessions, 2, "both joins land inside the round that was running");
    assert.equal(foy?.short, 1);
  });
});

/** audit.create stamps "now". VIP history from days ago is backdated in place: by SQL on Postgres,
 *  and on the memory store by a field write (it hands back the stored row itself). */
async function auditAt(repo: Repository, ts: string, input: NewAudit): Promise<void> {
  const row = await repo.audit.create(input);
  const pool = (repo as unknown as { pool?: { query(sql: string, args: unknown[]): Promise<unknown> } }).pool;
  if (pool) await pool.query("UPDATE audit SET ts = $1 WHERE id = $2", [ts, row.id]);
  else (row as { ts: string }).ts = ts;
}

/*
 * The By platform card's bans and VIP, through the real route and store: decisions made in the
 * window whose rule covers this server, by the banned player's platform; VIPs on every day they
 * held VIP on this server, rebuilt from the VIP history with today's list under it. A ban that
 * only covers another server, or another game's servers, is not this server's, and neither is a
 * VIP held there. A crash VIP is nobody's.
 */
test("server analytics splits bans and VIPs by platform, for the server being looked at", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const otherId = await makeGameServer(base, owner);
    const game = (await repo.servers.findById(serverId))!.game;
    const box = await repo.players.upsert({ game, platformId: "a1b2c3d4e5f60718293a4b5c6d7e8f01", name: "Boxer", platform: "EPlatformFamily::XboxSeries" });
    const pc = await repo.players.upsert({ game, platformId: "76561190000000051", name: "Piper", platform: "steam" });
    const cramp = await repo.players.upsert({ game, platformId: "76561190000000052", name: "Cramp", platform: "steam" });
    const joinAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    await repo.sessions.importOne({ playerId: pc.id, serverId, connectedAt: joinAt, disconnectedAt: new Date(Date.parse(joinAt) + 1800_000).toISOString(), durationSec: 1800 });

    const ban = (playerId: string, kind: "temp" | "perma", scope: { mode: "all" } | { mode: "servers"; serverIds: string[] }, over: Record<string, unknown> = {}) =>
      repo.playerBans.create({ game, playerId, playerName: null, kind, reason: "test", scope, expiresAt: null, createdByName: "staff", createdAt: new Date(Date.now() - 3600_000).toISOString(), ...over });
    await ban(box.platformId, "temp", { mode: "servers", serverIds: [serverId] });
    await ban(box.platformId, "perma", { mode: "all" }); // community-wide: covers this server too
    await ban(pc.platformId, "temp", { mode: "servers", serverIds: [otherId] }); // the other server's
    await ban(pc.platformId, "perma", { mode: "all" }, { game: game === "hll" ? "hllv" : "hll" }); // the other game's
    await ban(pc.platformId, "perma", { mode: "all" }, { createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString() }); // long before the window

    // The VIP history, at set hours of the last few days (UTC: no zone was asked for).
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    const t = (daysAgo: number, hour: number) => new Date(today - daysAgo * 86_400_000 + hour * 3_600_000).toISOString();
    const dateOf = (daysAgo: number) => new Date(today - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const grant = (ts: string, sid: string, playerId: string, expiration: string | null) =>
      auditAt(repo, ts, { actorName: "staff", action: "vip.grant", targetType: "player", targetId: playerId, serverId: sid, summary: "granted VIP", data: { expiration } });
    await grant(t(5, 9), serverId, box.platformId, null); // permanent since five days ago: today's row is this grant
    await grant(t(3, 10), serverId, pc.platformId, t(3, 20)); // ten hours, three days ago: no row of it left
    await grant(t(2, 6), otherId, box.platformId, t(2, 18)); // the other server's
    // Cramp's crash VIPs, yesterday and running now: half an hour each. A rule's VIP files its row
    // under the profile id and carries the game id in its data.
    const crash = (ts: string, expiration: string) =>
      auditAt(repo, ts, { actorName: "enforcer", action: "enforcer.vip", targetType: "player", targetId: cramp.id, serverId, summary: "crash VIP", data: { playerId: cramp.platformId, expiration } });
    await crash(t(1, 12), t(1, 12.5));
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    await crash(new Date().toISOString(), soon);

    // Today's list: Boxer's grant, Piper's lapsed row the sweep has not reached, Cramp's crash VIP,
    // and Piper on the other server.
    await repo.vips.upsert({ serverId, playerId: box.platformId, playerName: "Boxer", comment: "", expiration: null, createdByName: "staff" });
    await repo.vips.upsert({ serverId, playerId: pc.platformId, playerName: "Piper", comment: "", expiration: new Date(Date.now() - 60_000).toISOString(), createdByName: "staff" });
    await repo.vips.upsert({ serverId, playerId: cramp.platformId, playerName: "Cramp", comment: "VIP from rule", expiration: soon, createdByName: "enforcer" });
    await repo.vips.upsert({ serverId: otherId, playerId: pc.platformId, playerName: "Piper", comment: "", expiration: null, createdByName: "staff" });

    const r = await jf(`${base}/api/analytics/server?serverId=${serverId}`, { headers: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rows = r.body.platform.rows as { platform: string; players: number; tempBans: number; permaBans: number; vips: number }[];
    const of = (p: string) => rows.find((x) => x.platform === p);
    assert.deepEqual([of("EPlatformFamily::XboxSeries")?.tempBans, of("EPlatformFamily::XboxSeries")?.permaBans, of("EPlatformFamily::XboxSeries")?.vips], [1, 1, 1]);
    assert.deepEqual([of("steam")?.players, of("steam")?.tempBans, of("steam")?.permaBans, of("steam")?.vips], [1, 0, 0, 1],
      "the other server's ban, the other game's and the old one are not this server's; Piper's VIP three days ago is, and Cramp's crash VIPs are nobody's");
    const days = r.body.platformTrend.rows as { date: string; platform: string; tempBans: number; permaBans: number; vips: number; firstPlayers: number; firstVips: number }[];
    assert.equal(days.filter((d) => d.platform === "EPlatformFamily::XboxSeries").reduce((n, d) => n + d.tempBans + d.permaBans, 0), 2, "and the same bans, per day");
    const vipDays = (p: string) => days.filter((d) => d.platform === p && d.vips > 0).map((d) => [d.date, d.vips]);
    assert.deepEqual(vipDays("EPlatformFamily::XboxSeries"), [5, 4, 3, 2, 1, 0].map((n) => [dateOf(n), 1]), "Boxer on every day since the grant");
    assert.deepEqual(vipDays("steam"), [[dateOf(3), 1]], "Piper on the one day she held it");
    // The chart's running counts add up each person's first day: they end at the table's numbers.
    for (const p of ["EPlatformFamily::XboxSeries", "steam"]) {
      const mine = days.filter((d) => d.platform === p);
      assert.deepEqual([mine.reduce((n, d) => n + d.firstPlayers, 0), mine.reduce((n, d) => n + d.firstVips, 0)], [of(p)?.players, of(p)?.vips], `${p}: the first days add up to the table`);
    }
    const daily = r.body.vipDaily as { date: string; vips: number }[];
    assert.deepEqual([daily.length, daily[0]?.date, daily.at(-1)?.date], [31, dateOf(30), dateOf(0)], "every day of the thirty, both ends included");
    assert.deepEqual(daily.filter((d) => d.vips > 0).map((d) => [d.date, d.vips]),
      [[dateOf(5), 1], [dateOf(4), 1], [dateOf(3), 2], [dateOf(2), 1], [dateOf(1), 1], [dateOf(0), 1]]);

    // The other server's view sees its own ban and its own VIPs.
    const other = await jf(`${base}/api/analytics/server?serverId=${otherId}`, { headers: owner });
    const there = other.body.platform.rows as { platform: string; tempBans: number; vips: number }[];
    assert.deepEqual([there.find((x) => x.platform === "steam")?.tempBans, there.find((x) => x.platform === "steam")?.vips], [1, 1]);
    assert.equal(there.find((x) => x.platform === "EPlatformFamily::XboxSeries")?.vips, 1);
    assert.deepEqual((other.body.vipDaily as { date: string; vips: number }[]).filter((d) => d.vips > 0).map((d) => [d.date, d.vips]),
      [[dateOf(2), 1], [dateOf(0), 1]]);
  });
});

test("announcement analytics: its own capability opens it, without the power to post", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);

    // The analytics capability is a REPORT, not the noticeboard: read the numbers, post nothing.
    const analyst = await staffAuth(base, owner, "ann-analyst", [{ capability: "analytics.announcements", level: "read" }]);
    assert.equal((await jf(`${base}/api/community/announcements/analytics`, { headers: analyst })).status, 200);
    // Posting is asked for, not done: reporting on the board must not let you write to it.
    assertAsked(await jf(`${base}/api/community/announcements`, {
      method: "POST", headers: analyst, body: JSON.stringify({ title: "t", body: "b", published: true }),
    }), "reporting on the board must not let you write to it");
    assert.deepEqual((await jf(`${base}/api/community/announcements/all`, { headers: owner })).body.announcements, [], "nothing was posted");

    // …and it unlocks nothing else in the Analytics section.
    for (const other of ["server", "match", "player", "combat", "staff", "mapvote"]) {
      assert.equal((await jf(`${base}/api/analytics/${other}`, { headers: analyst })).status, 403, `must not unlock ${other}`);
    }
  });
});

test("announcement analytics: whoever runs the board keeps the per-notice reach it always showed", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    // The board's own notice list renders reach inline against each notice. An editor who was
    // never granted the new analytics capability must not lose that.
    const editor = await staffAuth(base, owner, "board-editor", [{ capability: "community.edit", level: "write" }]);
    assert.equal((await jf(`${base}/api/community/announcements/analytics`, { headers: editor })).status, 200);
  });
});

test("announcement analytics: neither capability means no access, named clearly", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const nobody = await staffAuth(base, owner, "ann-nobody", [{ capability: "server.view", level: "read" }]);
    const r = await jf(`${base}/api/community/announcements/analytics`, { headers: nobody });
    assert.equal(r.status, 403);
    assert.equal(r.body.error?.missing?.capability, "analytics.announcements");
  });
});

test("server analytics reports true concurrency, not arrivals", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);

    // Ten people join over the last few hours, but they are spread out: only ever two overlap.
    // Counting session STARTS would call this a busy server; counting overlap tells the truth.
    const now = Date.now();
    const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
    for (let i = 0; i < 10; i++) {
      const p = await repo.players.upsert({ game: "hll", platformId: `7656119900000${i}0`, name: `Drop${i}`, platform: "steam" });
      const start = 600 - i * 50; // 50 minutes apart
      await repo.sessions.importOne({
        playerId: p.id, serverId,
        connectedAt: at(start), disconnectedAt: at(start - 60), durationSec: 3600,
      });
    }

    const r = await jf(`${base}/api/analytics/server?serverId=${serverId}&days=1`, { headers: owner });
    assert.equal(r.status, 200);
    const c = r.body.concurrency;
    assert.equal(r.body.activity.sessions, 10, "ten sessions started");
    assert.ok(c.peak <= 2, `never more than two overlapped, got a peak of ${c.peak}`);
    assert.ok(c.peak >= 1, "somebody was on");
    assert.ok(c.average > 0 && c.average < 3, `mean should be well under the session count, got ${c.average}`);
    assert.equal(c.weekHour.length, 7);
    assert.equal(c.weekHour[0].length, 24);
    assert.equal(c.sampleSec, 300, "a one-day window samples every five minutes");
    assert.ok(c.peakAt && !Number.isNaN(Date.parse(c.peakAt)));
  });
});

test("concurrency on an empty server is zeroes, not nulls or a crash", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const r = await jf(`${base}/api/analytics/server?serverId=${serverId}`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.concurrency.peak, 0);
    assert.equal(r.body.concurrency.peakAt, null);
    assert.equal(r.body.concurrency.average, 0);
    assert.equal(r.body.concurrency.openAtEnd, 0);
    assert.equal(r.body.concurrency.weekHour.length, 7);
  });
});

test("concurrency counts players who are online right now", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    // Three players currently connected and no closed sessions at all: a store that only read
    // finished sessions would report an empty server while three people were playing on it.
    for (let i = 0; i < 3; i++) {
      const p = await repo.players.upsert({ game: "hll", platformId: `7656119911111${i}0`, name: `Now${i}`, platform: "steam" });
      await repo.sessions.open(p.id, serverId, new Date(Date.now() - 30 * 60_000).toISOString());
    }
    const r = await jf(`${base}/api/analytics/server?serverId=${serverId}&days=1`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.concurrency.openAtEnd, 3);
    assert.equal(r.body.concurrency.peak, 3, "still-open sessions count as online to the window edge");
  });
});

test("composition analytics reports the sampled roster and names the roles", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
    const side = (players: number, squads: number, noSl: string[] = []) =>
      ({ players, squads, unsquadded: 0, noSlSquads: noSl, byRole: {} });

    await repo.rosterSnapshots.record({
      serverId, ts: at(60), playerCount: 40, mapName: "FOY",
      composition: { players: 40, unassigned: 0, byRole: { 0: 32, 9: 8 },
        bySide: { allies: side(20, 4, ["BAKER"]), axis: side(20, 4) } },
    });
    await repo.rosterSnapshots.record({
      serverId, ts: at(30), playerCount: 20, mapName: "FOY",
      composition: { players: 20, unassigned: 0, byRole: { 0: 18, 9: 2 },
        bySide: { allies: side(10, 2), axis: side(10, 2) } },
    });

    const r = await jf(`${base}/api/analytics/composition?serverId=${serverId}&days=1`, { headers: owner });
    assert.equal(r.status, 200);
    assert.equal(r.body.samples, 2);
    assert.equal(r.body.avgPlayers, 30);
    assert.equal(r.body.peakPlayers, 40);
    // 10 of 60 player-samples were officers.
    assert.equal(r.body.byRole.find((x: any) => x.role === 9)?.share, Math.round((10 / 60) * 1000) / 1000);
    assert.equal(r.body.noSl.squadSamples, 2);
    assert.equal(r.body.noSl.sampleShare, 0.5, "one of the two samples had a leaderless squad");
    assert.equal(r.body.byMap[0]?.map, "FOY");
    // Role numbers mean nothing to a reader; the descriptor's labels ride along so the page can
    // say "Officer" without the panel holding a copy of any game's role table.
    assert.equal(r.body.roles["9"], "Officer");
    assert.ok(r.body.sides.some((s: any) => s.id === "allies" && s.label === "Allies"));
  });
});

test("composition analytics needs its own permission, and says which one", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    // Every other analytics capability, deliberately: each one is independently grantable, so
    // holding the rest must not open this.
    const staff = await staffAuth(base, owner, "analyst", [
      { capability: "server.view", level: "read" },
      { capability: "analytics.server", level: "read" },
      { capability: "analytics.combat", level: "read" },
    ]);
    const denied = await jf(`${base}/api/analytics/composition?serverId=${serverId}`, { headers: staff });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.missing.capability, "analytics.composition");

    const allowed = await staffAuth(base, owner, "shapewatcher", [
      { capability: "server.view", level: "read" },
      { capability: "analytics.composition", level: "read" },
    ]);
    const ok = await jf(`${base}/api/analytics/composition?serverId=${serverId}`, { headers: allowed });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.samples, 0);
    assert.equal(ok.body.avgPlayers, null, "no samples yet is 'no answer', not 'zero players'");
  });
});

test("staff analytics is the team you have; the trail is everyone who ever acted", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);

    // Three accounts: one busy, one who did nothing this window, and one who later leaves.
    const busy = await repo.users.create({ username: "busy", passwordHash: "x" });
    await repo.users.create({ username: "quiet", passwordHash: "x" }); // never acts — must still be listed
    const leaver = await repo.users.create({ username: "leaver", passwordHash: "x" });
    // Not "Moderator": the factory presets are seeded as real roles at bootstrap, and role names
    // are unique — a preset's name is already taken.
    const role = await repo.roles.create({ name: "Shift lead", grants: [], limits: {}, createdByName: "owner" });
    await repo.userRoles.set(busy.id, [{ roleId: role.id, scopeId: null }]);

    await repo.audit.create({ actorUserId: busy.id, actorName: "busy", action: "player.kick", targetName: "X", summary: "kicked X" });
    await repo.audit.create({ actorUserId: leaver.id, actorName: "leaver", action: "player.tempban", targetName: "Y", summary: "banned Y" });
    // The app's own automation — a different population, and it must stay out of the staff view.
    await repo.audit.create({ actorUserId: null, actorName: "system", action: "vip.expire", targetName: "Z", summary: "VIP expired" });

    // The window ends at "now", exclusive, so a row stamped in the same millisecond as the request
    // falls outside it — a millisecond that only ever happens when a test writes and reads back to
    // back. Same guard as the admin-response test above.
    await new Promise((r) => setTimeout(r, 5));

    const before = await jf(`${base}/api/analytics/staff?days=30`, { headers: owner });
    assert.equal(before.status, 200);
    const names = (before.body.members as { name: string; actions: number; roleIds: string[] }[]);
    // Everyone on the team appears — the quiet one at zero rather than missing entirely.
    for (const who of ["busy", "quiet", "leaver"]) {
      assert.ok(names.some((m) => m.name === who), `${who} is listed: ${JSON.stringify(names.map((m) => m.name))}`);
    }
    assert.equal(names.find((m) => m.name === "quiet")?.actions, 0);
    assert.ok(!names.some((m) => m.name === "system"), "the automation is not a staff member");
    // "Active" counts only those who acted; the whole team is bigger (the harness's own owner
    // account acts too when it registers, so these are floors rather than exact numbers).
    assert.equal(names.find((m) => m.name === "busy")?.actions, 1);
    assert.equal(names.find((m) => m.name === "leaver")?.actions, 1);
    assert.ok((before.body.totalStaff as number) > (before.body.activeStaff as number),
      "the quiet member makes the team bigger than the active count");
    // Roles ride along, plus the catalogue the filter is built from.
    assert.deepEqual(names.find((m) => m.name === "busy")?.roleIds, [role.id]);
    assert.ok((before.body.roles as { id: string }[]).some((r) => r.id === role.id));

    // The account leaves. The two surfaces are for two different audiences and now part ways.
    //
    // Analytics is planning: how the team you HAVE splits the work and covers the week. Someone who
    // left cannot take a shift, so they drop out of it entirely — and out of the entries behind it,
    // so the shares still add up to the team and the busiest-member figure names someone reachable.
    await repo.users.remove(leaver.id);
    const after = await jf(`${base}/api/analytics/staff?days=30`, { headers: owner });
    const members = after.body.members as { name: string; actions: number }[];
    assert.ok(!members.some((m) => m.name === "leaver"), "the departed admin is off the roster view");
    assert.ok((after.body.totalActions as number) < (before.body.totalActions as number),
      "their action left the totals too, so the shares still describe the current team");

    // The record is the other audience, and it forgets nobody: the trail keeps every action under
    // the name that took it, counted as a person's rather than the machinery's, even though the
    // row's user id is now null.
    const human = await jf(`${base}/api/audit/staff`, { headers: owner });
    const kept = (human.body.staff as { actorName: string; count: number }[]).find((s) => s.actorName === "leaver");
    assert.ok(kept, "a departed admin's work is still on the record");
    assert.equal(kept.count, 1);
    const auto = await jf(`${base}/api/audit/staff?actors=auto`, { headers: owner });
    assert.deepEqual((auto.body.staff as { actorName: string }[]).map((s) => s.actorName), ["system"]);

    // The years of legacy shop rows stamped `discord:<member>` fold into ONE machinery line —
    // a customer is not a service, and a hundred one-count impostor rows said less than nothing.
    await repo.audit.create({ actorUserId: null, actorName: "discord:Alpha", action: "vip.grant", summary: "legacy row" });
    await repo.audit.create({ actorUserId: null, actorName: "discord:Bravo", action: "vip.grant", summary: "legacy row" });
    const folded = await jf(`${base}/api/audit/staff?actors=auto`, { headers: owner });
    const rows = folded.body.staff as { actorName: string; count: number }[];
    assert.ok(!rows.some((r) => r.actorName.startsWith("discord:")), "no per-member rows survive");
    const memberLine = rows.find((r) => r.actorName === "discord members");
    assert.ok(memberLine, "they fold into one line");
    assert.equal(memberLine!.count, 2, "carrying both counts");
    // …and the line is RANKED by that combined count. The table is count-descending and the
    // panel renders it in order, so a fold worth two presses sits above the one-count service
    // rather than being parked at the bottom where it was assembled.
    assert.deepEqual(rows.map((r) => r.actorName), ["discord members", "system"],
      "the fold takes its place in the ranking");
  });
});

/**
 * Wait for the wall clock to leave the millisecond the last audit row was stamped with.
 *
 * The analytics window ends at `new Date()` and the store filters `ts < to`, exclusively — an
 * action taken in the very millisecond a report is generated is not in that report. That bound is
 * deliberate (it is what stops a row being counted twice at a page edge), so the test yields to it
 * rather than the other way round: seed, let the clock tick, then ask.
 */
async function afterThisMillisecond(): Promise<void> {
  const started = Date.now();
  while (Date.now() === started) await new Promise((r) => setTimeout(r, 1));
}

/*
 * Automation must never bury the staff it works alongside.
 *
 * Reported from production as "my staff analytics got reset". Nothing had been deleted. The page
 * read the most recent 500 audit entries in a 30-day window and kept the human ones — and the app's
 * own automation outnumbers humans hundreds to one, so once a rule got busy (a crash-VIP grant is
 * one audit row per disconnect on a full server) those 500 rows were all machinery. Every human
 * action was still in the table, behind a page that never looked past the noise.
 *
 * Measured as a BEFORE/AFTER on the same instance: piling automation on top of an unchanged set of
 * human actions must not move a single human number. Registering and creating servers is itself
 * audited, so an absolute total here would be asserting the harness, not the fix.
 */
test("staff analytics reads past the automation, however much of it there is", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const me = (await jf(`${base}/api/users`, { headers: owner })).body.users.find((u: any) => u.username === "owner");
    assert.ok(me, "the owner account is on the roster");
    for (const action of ["player.tempban", "player.kick", "vip.grant"]) {
      await repo.audit.create({ actorUserId: me.id, actorName: "owner", action, summary: `owner did ${action}` });
    }
    await afterThisMillisecond();

    const before = await jf(`${base}/api/analytics/staff`, { headers: owner });
    assert.equal(before.status, 200);
    const mineBefore = (before.body.members as any[]).find((m) => m.userId === me.id);
    assert.ok(mineBefore.actions >= 3, `the three actions are counted (got ${mineBefore.actions})`);

    // Now the volume a busy server produces: more than one 500-row page, all of it NEWER than the
    // human rows — exactly why a "most recent N" read lost them.
    for (let i = 0; i < 700; i += 1) {
      await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "enforcer.vip", summary: `crash vip ${i}` });
    }
    await afterThisMillisecond();

    const after = await jf(`${base}/api/analytics/staff`, { headers: owner });
    assert.equal(after.status, 200);
    const mineAfter = (after.body.members as any[]).find((m) => m.userId === me.id);
    assert.ok(mineAfter, `the staff member did not vanish: ${JSON.stringify(after.body.members)}`);
    assert.equal(mineAfter.actions, mineBefore.actions, "700 automated rows changed no human count");
    assert.equal(after.body.totalActions, before.body.totalActions, "and no team total");
    assert.equal(after.body.activeStaff, before.body.activeStaff, "and nobody dropped off the page");
    assert.equal(after.body.truncated, false, "a window this size is read in full");
  });
});

test("the audit store filters human/automated in the query, not after the limit", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const me = (await jf(`${base}/api/users`, { headers: owner })).body.users.find((u: any) => u.username === "owner");
    await repo.audit.create({ actorUserId: me.id, actorName: "owner", action: "seeded.human", summary: "human" });
    for (let i = 0; i < 20; i += 1) {
      await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "seeded.auto", summary: `auto ${i}` });
    }

    // Asking for fewer rows than the automation alone fills still returns the human row, because
    // the filter runs in the query rather than on whatever the limit happened to return. Scoped to
    // the seeded actions so the harness's own audited setup cannot flatter the result.
    const humans = await repo.audit.list({ actor: "human", actions: ["seeded.human", "seeded.auto"], limit: 5 });
    assert.equal(humans.length, 1);
    assert.equal(humans[0]!.action, "seeded.human");

    const autos = await repo.audit.list({ actor: "auto", actions: ["seeded.human", "seeded.auto"], limit: 5 });
    assert.equal(autos.length, 5);
    assert.ok(autos.every((a) => a.action === "seeded.auto"));

    // Unfiltered is unchanged: 1 human + 20 automated.
    assert.equal((await repo.audit.list({ actions: ["seeded.human", "seeded.auto"], limit: 100 })).length, 21);
  });
});

test("the subject's own week grid is bucketed in the viewer's zone, like the population grid beside it", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const p = await repo.players.upsert({ game: "hll", platformId: "76561190000000021", name: "NightOwl", platform: "steam" });
    // Saturday 2026-07-04, 20:30 in US Central = Sunday 2026-07-05, 01:30 UTC — the wrong-DAY
    // case, not just the wrong hour. The route said "directly comparable to the population chart"
    // while drawing this one grid in UTC beside a zoned population.
    await repo.sessions.open(p.id, serverId, "2026-07-05T01:30:00.000Z");
    await repo.sessions.close(p.id, serverId, "2026-07-05T02:30:00.000Z");

    const central = await jf(`${base}/api/analytics/player?playerId=${p.platformId}`, {
      headers: { ...owner, "x-time-zone": "America/Chicago" },
    });
    assert.equal(central.status, 200);
    assert.equal(central.body.subject.weekHour[6][20], 1, "locally this is Saturday evening");
    assert.equal(central.body.subject.weekHour[0][1], 0, "not Sunday small-hours");

    // No zone sent keeps the old UTC reading — the compatibility contract every bucket keeps.
    const utc = await jf(`${base}/api/analytics/player?playerId=${p.platformId}`, { headers: owner });
    assert.equal(utc.body.subject.weekHour[0][1], 1);
  });
});

test("staff analytics: a bulk volley counts once, and hide filters remove people and kinds of work", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const me = await jf(`${base}/api/me`, { headers: owner });
    const ownerId = (me.body.user as { id: string }).id;
    const other = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "mod", password: "pw" }) });
    const modId = (other.body.user as { id: string }).id;

    // The owner fires one select-all volley (three per-target rows, one minute) + one config save;
    // the mod kicks somebody.
    for (let i = 0; i < 3; i++) {
      await repo.audit.create({
        actorUserId: ownerId, actorName: "owner", action: "player.message", serverId,
        targetType: "player", targetId: `p${i}`, summary: "bulk msg", data: { bulk: true },
      });
    }
    await repo.audit.create({ actorUserId: ownerId, actorName: "owner", action: "config.update", serverId, targetType: "server", targetId: serverId, summary: "cfg", data: null });
    await repo.audit.create({ actorUserId: modId, actorName: "mod", action: "player.kick", serverId, targetType: "player", targetId: "px", summary: "kick", data: null });
    // The window's `to` is exclusive; a row stamped in the SAME millisecond as the request falls
    // just outside it — the file-wide rule after seeding, learned again the flaky way.
    await afterThisMillisecond();

    // Asserted RELATIVE to the response, because the harness itself audits (creating the server
    // and the mod account are owner actions too) and pinning absolute totals would break on any
    // new setup row rather than on a real regression.
    const plain = await jf(`${base}/api/analytics/staff?days=7`, { headers: owner });
    assert.equal(plain.status, 200);
    type Row = { userId: string; actions: number; byCategory: Record<string, number> };
    const ownerRow = (plain.body.members as Row[]).find((m) => m.userId === ownerId)!;
    // The core claim: three per-target bulk rows count as ONE message.
    assert.equal(ownerRow.byCategory.messages, 1, JSON.stringify(plain.body.byAction));
    const settingsCount = ownerRow.byCategory.settings ?? 0;
    assert.ok(settingsCount >= 1, "the config save lands in its own hideable bucket");

    // Hiding the settings category subtracts exactly the settings work, nothing else.
    const noCfg = await jf(`${base}/api/analytics/staff?days=7&hideCategories=settings`, { headers: owner });
    assert.equal(noCfg.body.totalActions, (plain.body.totalActions as number) - settingsCount);

    // Hiding the owner subtracts exactly the owner's actions — and allMembers still lists them so
    // the picker can bring them back.
    const noOwner = await jf(`${base}/api/analytics/staff?days=7&hideUsers=${ownerId}`, { headers: owner });
    assert.equal(noOwner.body.totalActions, (plain.body.totalActions as number) - ownerRow.actions);
    assert.ok(!(noOwner.body.members as Row[]).some((m) => m.userId === ownerId));
    assert.ok((noOwner.body.allMembers as { userId: string }[]).some((m) => m.userId === ownerId));
  });
});

test("staff analytics: picking a server keeps community-wide work measured", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeGameServer(base, owner);
    const me = await jf(`${base}/api/me`, { headers: owner });
    const ownerId = (me.body.user as { id: string }).id;

    // A watchlist flag is done to the COMMUNITY, not on any game server — its audit row carries no
    // server id. Narrowing the page to one server is a view choice for an unrestricted reader, and
    // it used to silently drop every row like this one: staff whose month was flags, notes and
    // account work read as zero the moment a server was selected (or arrived pinned).
    await repo.audit.create({
      actorUserId: ownerId, actorName: "owner", action: "player.watchlist",
      targetType: "player", targetId: "p-flagged", summary: "added to the watchlist", data: null,
    });
    await afterThisMillisecond(); // same-millisecond rows sit outside the window's exclusive `to`

    type Row = { userId: string; actions: number; byCategory: Record<string, number> };
    const scoped = await jf(`${base}/api/analytics/staff?days=7&serverId=${serverId}`, { headers: owner });
    assert.equal(scoped.status, 200);
    const scopedRow = (scoped.body.members as Row[]).find((m) => m.userId === ownerId)!;
    assert.ok((scopedRow.byCategory.records ?? 0) >= 1, `the flag must survive the server filter: ${JSON.stringify(scopedRow?.byCategory)}`);

    // And the unscoped read agrees — the filter added the server's own rows, never subtracted these.
    const open = await jf(`${base}/api/analytics/staff?days=7`, { headers: owner });
    const openRow = (open.body.members as Row[]).find((m) => m.userId === ownerId)!;
    assert.equal(scopedRow.byCategory.records, openRow.byCategory.records);
  });
});

test("server analytics' hour grid: one metric on demand, in the viewer's zone, for one server the caller may see", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const mine = await makeGameServer(base, owner);
    const theirs = (await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "s2", host: "127.0.0.1", port: 2, password: "x" }) })).body.server.id as string;
    await repo.rosterSnapshots.record({ serverId: mine, ts: "2026-08-02T02:30:00.000Z", playerCount: 7, composition: { players: 7, unassigned: 0, byRole: {}, bySide: {} }, queueCount: 2 });
    const url = (q: string) => `${base}/api/analytics/server/hours?from=2026-08-01T05:00:00.000Z&to=2026-08-03T05:00:00.000Z&${q}`;

    // 02:30 UTC on the 2nd is 21:30 on the 1st in Chicago: the grid is the viewer's.
    const central = await jf(url(`serverId=${mine}&metric=peak`), { headers: { ...owner, "x-time-zone": "America/Chicago" } });
    assert.equal(central.status, 200, JSON.stringify(central.body));
    assert.equal(central.body.metric, "peak");
    assert.deepEqual((central.body.rows as { date: string }[]).map((r) => r.date), ["2026-08-01", "2026-08-02"]);
    assert.equal(central.body.rows[0].hours[21], 7);
    const utc = await jf(url(`serverId=${mine}&metric=queue`), { headers: owner });
    assert.equal((utc.body.rows as { date: string; hours: (number | null)[] }[]).find((r) => r.date === "2026-08-02")!.hours[2], 2, "no zone sent reads UTC");

    // What it refuses: no server, a metric it does not have, nobody signed in, someone else's server.
    assert.equal((await jf(url("metric=peak"), { headers: owner })).status, 400, "always one server");
    const bad = await jf(url(`serverId=${mine}&metric=banana`), { headers: owner });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /metric must be one of/);
    assert.equal((await jf(url(`serverId=${mine}&metric=peak`))).status, 401);
    const scoped = await staffAuth(base, owner, "hours-scoped", [{ capability: "analytics.server", level: "read", scopeType: "server", scopeId: mine }]);
    assert.equal((await jf(url(`serverId=${mine}&metric=kills`), { headers: scoped })).status, 200);
    assert.equal((await jf(url(`serverId=${theirs}&metric=kills`), { headers: scoped })).status, 403);
  });
});
