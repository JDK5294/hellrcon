import { test } from "node:test";
import assert from "node:assert/strict";
import type { CrconPlayerCache } from "../dist/index.js";

// Integration test for the Postgres repository. Skipped unless DATABASE_URL is set
// (it runs in CI against a real Postgres service). Uses dynamic imports so the built
// dist / pg driver are only loaded when actually running.
const DB = process.env.DATABASE_URL;

test("postgres repo: migrate + CRUD round-trip", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    await repo.migrate(); // idempotent

    const uname = "u_" + Math.random().toString(36).slice(2);
    const user = await repo.users.create({ username: uname, passwordHash: "h" });
    assert.equal((await repo.users.findById(user.id))?.username, uname);
    assert.equal((await repo.users.findByUsername(uname.toUpperCase()))?.id, user.id); // case-insensitive
    assert.ok((await repo.users.count()) >= 1);

    const server = await repo.servers.create({ name: "S", host: "1.2.3.4", port: 28865, password: "secret" });
    // Automation switches: exceptions-only jsonb, {} by default, replaced whole by setAutomation.
    assert.deepEqual(server.automation, {});
    const staged = await repo.servers.setAutomation(server.id, { broadcast: false, vipSweep: false });
    assert.deepEqual(staged?.automation, { broadcast: false, vipSweep: false });
    assert.deepEqual((await repo.servers.findById(server.id))?.automation, { broadcast: false, vipSweep: false });
    assert.deepEqual((await repo.servers.setAutomation(server.id, {}))?.automation, {});
    assert.equal(server.engagementMode, "observe"); // safe default persisted
    assert.equal((await repo.servers.setEngagementMode(server.id, "active"))?.engagementMode, "active");
    assert.ok((await repo.servers.list()).some((s) => s.id === server.id));

    /*
     * player_ban. The memory store has the behavioural tests; these are the ones only a real
     * Postgres can answer — that jsonb comes back as a rule and not a string, that the lift is a
     * conditional UPDATE rather than a read-modify-write, and that the CHECK holds.
     */
    const banScope = { mode: "except" as const, serverIds: [server.id] };
    const ban = await repo.playerBans.create({
      game: "hll", playerId: `ban_${uname}`, playerName: "Cheat", kind: "perma",
      reason: "aimbot", category: "cheating", scope: banScope, createdByName: "t",
    });
    assert.deepEqual(ban.scope, banScope, "jsonb round-trips as an object, not a string");
    assert.equal(ban.category, "cheating");
    assert.equal(ban.liftedAt, null);
    assert.equal((await repo.playerBans.get(ban.id))?.scope.mode, "except");

    assert.ok((await repo.playerBans.list({ playerId: `ban_${uname}`, activeOnly: true })).length === 1);
    assert.equal(await repo.playerBans.lift(ban.id, "boss"), true);
    // The second lift is refused in SQL (`AND lifted_at IS NULL`), so two staff clicking at once
    // cannot overwrite who actually did it.
    assert.equal(await repo.playerBans.lift(ban.id, "someone else"), false);
    assert.equal((await repo.playerBans.get(ban.id))?.liftedByName, "boss");
    assert.equal((await repo.playerBans.list({ playerId: `ban_${uname}`, activeOnly: true })).length, 0);
    // Lifted, not deleted.
    assert.equal((await repo.playerBans.list({ playerId: `ban_${uname}` })).length, 1);

    // An expiry in the past drops out of `activeOnly` with nobody lifting it — evaluated by
    // Postgres's own now(), not the app's clock.
    await repo.playerBans.create({
      game: "hll", playerId: `exp_${uname}`, kind: "temp", reason: "spam", scope: { mode: "all" },
      expiresAt: new Date(Date.now() - 60_000).toISOString(), createdByName: "t",
    });
    assert.equal((await repo.playerBans.list({ playerId: `exp_${uname}`, activeOnly: true })).length, 0);
    assert.equal((await repo.playerBans.list({ playerId: `exp_${uname}` })).length, 1);

    await assert.rejects(
      pool.query("INSERT INTO player_ban (game, player_id, kind, reason, scope, created_by_name) VALUES ('hll','x','forever','r','{}'::jsonb,'t')"),
      /violates check constraint/,
      "kind is constrained to temp|perma",
    );

    const th = "th_" + uname;
    await repo.tokens.create({ userId: user.id, name: "launcher", tokenHash: th });
    assert.equal((await repo.tokens.findByHash(th))?.userId, user.id);

    await repo.grants.create({ userId: user.id, capability: "server.kick", scopeType: "server", scopeId: server.id, level: "write" });
    const grants = await repo.grants.listByUser(user.id);
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.level, "write");

    // players upsert + events + trim (partitioned evt table)
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765_" + uname, name: "Theo" });
    assert.equal((await repo.players.findById(player.id))?.platformId, "765_" + uname);
    // A historical sighting (a CRCON import) backdates first_seen without regressing last_seen or
    // letting an empty name clobber the current one.
    const back = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765_" + uname, name: "", ts: "2020-01-01T00:00:00.000Z" });
    assert.equal(back.firstSeen, "2020-01-01T00:00:00.000Z", "first seen reaches back to the import era");
    assert.ok(back.lastSeen >= player.firstSeen, "last seen stays at the live sighting");
    assert.equal(back.name, "Theo");

    await repo.events.insert([
      { serverId: server.id, ts: "2024-01-01T00:00:00.000Z", kind: "evt.kill", actorName: "a", victimName: "b", weapon: "M1" },
      { serverId: server.id, ts: new Date().toISOString(), kind: "evt.kill", actorName: "c", victimName: "d", weapon: "M2" },
    ]);
    assert.ok((await repo.events.listRecent(server.id)).length >= 2);
    const spec = { kinds: ["evt.kill"], olderThanIso: "2025-01-01T00:00:00.000Z" };
    assert.equal(await repo.events.countForTrim(spec), 1);
    const trimmed = await repo.events.trim(spec);
    assert.equal(trimmed.deleted, 1);
    assert.equal(await repo.events.countForTrim(spec), 0);

    // stats rollup: bump accumulates; leaderboard joins players; trim-safe
    await repo.stats.bump(player.id, server.id, { kills: 3, deaths: 1 });
    await repo.stats.bump(player.id, server.id, { kills: 2 });
    const s = await repo.stats.get(player.id);
    assert.equal(s?.kills, 5);
    assert.equal(s?.deaths, 1);
    const lb = await repo.stats.leaderboard("kills", 10);
    assert.ok(lb.some((e) => e.playerId === player.id && e.kills === 5 && e.kd === 5));

    // announcements + layouts round-trip
    const ann = await repo.announcements.create({ title: "T", body: "B", published: true });
    assert.ok((await repo.announcements.listPublished()).some((a) => a.id === ann.id));
    await repo.announcements.update(ann.id, { published: false });
    assert.equal((await repo.announcements.listPublished()).some((a) => a.id === ann.id), false);

    await repo.layouts.set("admin", "user", user.id, { items: [{ widgetId: "trim", visible: false, order: 5 }] });
    const got = await repo.layouts.get("admin", "user", user.id);
    assert.equal((got?.config as any).items[0].widgetId, "trim");
    // upsert overwrites
    await repo.layouts.set("admin", "user", user.id, { items: [] });
    assert.equal(((await repo.layouts.get("admin", "user", user.id))?.config as any).items.length, 0);
  } finally {
    await pool.end();
  }
});

test("postgres repo: RCON passwords are sealed at rest and legacy rows get upgraded", { skip: !DB }, async () => {
  const { createPostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;

  /*
   * A scratch database, NOT the shared battery one. Booting the repository with the key set runs
   * the plaintext SWEEP, which seals every unsealed password it can see — and in the shared
   * database "every" includes rows the OTHER suites, running in parallel without a key, seeded
   * moments ago. Their next read of their own server then throws "encrypted but ENCRYPTION_KEY
   * is not set". That was a real intermittent battery failure, not a hypothesis: store-contract
   * lost its retired-server row to exactly this sweep.
   */
  const name = `sealed_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: DB });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    await admin.end();
    // Don't pretend to have run: say plainly that the role can't do this.
    if ((err as { code?: string }).code === "42501") {
      assert.ok(true, "skipped: the test role cannot CREATE DATABASE");
      return;
    }
    throw err;
  }
  const url = new URL(DB!);
  url.pathname = `/${name}`;
  const SCRATCH = url.toString();
  process.env.ENCRYPTION_KEY = "test-at-rest-key";
  const pool = new pg.Pool({ connectionString: SCRATCH });
  // Closed in the finally BEFORE the scratch database drops: a force-drop severs their pooled
  // connections mid-air, and pg surfaces that as an uncaught exception that fails the whole file.
  let repo: Awaited<ReturnType<typeof createPostgresRepository>> | null = null;
  let repo2: Awaited<ReturnType<typeof createPostgresRepository>> | null = null;
  try {
    // boot path (migrate + plaintext sweep) with the key set
    repo = await createPostgresRepository(SCRATCH);
    const server = await repo.servers.create({ name: "sealed", host: "10.0.0.9", port: 28900, password: "super-secret" });
    // the app sees plaintext…
    assert.equal((await repo.servers.findById(server.id))?.password, "super-secret");
    // …but the database column holds ciphertext
    const { rows } = await pool.query("SELECT password FROM servers WHERE id = $1", [server.id]);
    assert.match(rows[0].password as string, /^enc:v1:/);

    // a legacy plaintext row (pre-encryption) is sealed by the next boot sweep
    const legacyId = "00000000-0000-0000-0000-0000000000fe";
    await pool.query(
      "INSERT INTO servers (id, name, game, protocol, host, port, password, engagement_mode) VALUES ($1,'legacy','hll','binary-v2','10.0.0.8',28901,'old-plain','observe')",
      [legacyId],
    );
    repo2 = await createPostgresRepository(SCRATCH);
    const { rows: after } = await pool.query("SELECT password FROM servers WHERE id = $1", [legacyId]);
    assert.match(after[0].password as string, /^enc:v1:/);
    assert.equal((await repo2.servers.findById(legacyId))?.password, "old-plain");
  } finally {
    delete process.env.ENCRYPTION_KEY;
    await repo?.close?.().catch(() => {});
    await repo2?.close?.().catch(() => {});
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`).catch(() => {});
    await admin.end();
  }
});

test("postgres repo: migrate reclaims the advisory lock from a dead-idle holder", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;

  // Simulate a client whose container was killed without closing TCP: it took the migration
  // lock, then went silent. Postgres still considers the session alive and the lock held.
  const zombie = new pg.Client({ connectionString: DB });
  zombie.on("error", () => {}); // emitted when its backend is terminated — expected here
  await zombie.connect();
  await zombie.query("SELECT pg_advisory_lock(776273)");

  process.env.MIGRATION_LOCK_POLL_MS = "200";
  process.env.MIGRATION_LOCK_STALE_MS = "500";
  process.env.MIGRATION_LOCK_WAIT_MAX_MS = "15000";
  const pool = new pg.Pool({ connectionString: DB });
  try {
    // Must terminate the idle holder and complete rather than hang forever.
    await new PostgresRepository(pool).migrate();
    // The zombie's session was terminated out from under it.
    await assert.rejects(zombie.query("SELECT 1"));
  } finally {
    delete process.env.MIGRATION_LOCK_POLL_MS;
    delete process.env.MIGRATION_LOCK_STALE_MS;
    delete process.env.MIGRATION_LOCK_WAIT_MAX_MS;
    await pool.end();
    await zombie.end().catch(() => {});
  }
});

/*
 * Ties are the normal case in this schema, not an edge case: the live roster upsert stamps ONE
 * last_seen across every player online, the game log stamps to the second, and half a leaderboard
 * sits on zero. `ORDER BY <metric> DESC` alone leaves those rows in whatever order the scan
 * produced — and that order shifts as rows are updated — so the LIMIT cut through a tie changed
 * between refreshes and players near the boundary flickered on and off the board.
 *
 * This has to run against real Postgres. The in-memory store could never reproduce it: V8's
 * Array#sort is stable, so an untied comparator there is deterministic by accident.
 */
test("postgres: a LIMIT through a tie is deterministic, and survives the rows moving", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const TS = "2026-06-01T12:00:00.000Z";
    const server = await repo.servers.create({ name: `tie-${tag}`, host: "1.1.1.1", port: 28865, password: "p" });

    // One timestamp for the whole roster, exactly as the live read does.
    const players = await repo.players.upsertMany(
      Array.from({ length: 25 }, (_, i) => ({
        game: "hll", platform: "steam", platformId: `tie-${tag}-${String(i).padStart(3, "0")}`, name: `P${i}`, ts: TS,
      })),
    );
    // Everybody on zero teamkills: a 25-way tie on that board.
    await repo.stats.bumpMany(players.map((p) => ({ playerId: p.id, serverId: server.id, delta: { kills: 1, deaths: 1 } })));
    await repo.events.insert(players.map((p, i) => ({
      serverId: server.id, ts: TS, kind: "evt.kill", actorPlayerId: p.id, actorName: p.name,
      victimPlayerId: null, victimName: null, weapon: "M1", data: null, dedupeKey: `tie-${tag}-${i}`,
    })));

    const read = async () => ({
      board: (await repo.stats.leaderboard("teamkills", 10)).map((e) => e.playerId),
      recent: (await repo.events.listRecent(server.id, 10)).map((e) => e.dedupeKey),
    });

    const first = await read();
    assert.deepEqual(await read(), first, "the same read twice must return the same cut");
    for (const [name, rows] of Object.entries(first)) {
      assert.equal(rows.length, 10, `${name} returned ${rows.length} rows`);
      assert.equal(new Set(rows).size, 10, `${name} repeated a row inside one page`);
    }

    // The real trigger: an UPDATE rewrites the row somewhere else in the heap, so a sort with no
    // tiebreak reads the tied group back in a different order. This is why it never reproduced in
    // a freshly-loaded test database and did in production.
    await repo.stats.bumpMany(players.slice(0, 12).map((p) => ({ playerId: p.id, serverId: server.id, delta: { visits: 1 } })));
    await pool.query("VACUUM ANALYZE player_stats, evt");
    assert.deepEqual(await read(), first, "rows moving must not change which ones make the cut");
  } finally {
    await pool.end();
  }
});

/*
 * The map-vote state row has two writers: the worker's tick and the panel's control buttons. They
 * touch disjoint fields, but the row used to be written whole from whatever the caller last read —
 * and the worker reads it, then spends a second or two talking to Discord, then writes. Any staff
 * click inside that window was silently reverted: Pause looked like it worked and un-paused itself
 * on the next tick. Patching only the fields a caller decided removes the conflict outright.
 */
test("postgres: a staff click is not reverted by a tick that started before it", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { blankMapVoteState } = await import("../dist/types.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: `race-${Math.random().toString(36).slice(2, 8)}`, host: "1.1.1.1", port: 28865, password: "p" });
    await repo.mapVote.setState(blankMapVoteState(server.id));

    // The combined surface + per-surface duplicate protection round-trip through real columns.
    await repo.mapVote.setConfig(server.id, { surface: "both", registeredOnlyIngame: true, registeredOnlyDiscord: false });
    const cfg = await repo.mapVote.getConfig(server.id);
    assert.equal(cfg?.surface, "both");
    assert.equal(cfg?.registeredOnlyIngame, true);
    assert.equal(cfg?.registeredOnlyDiscord, false, "the two gates are independent");
    await repo.mapVote.setConfig(server.id, { enabled: true });
    assert.equal((await repo.mapVote.getConfig(server.id))?.registeredOnlyIngame, true, "an unrelated patch keeps the gates");

    // The worker's tick begins and reads the state. Everything after this is inside its window.
    const beforeDiscord = await repo.mapVote.getState(server.id);
    assert.equal(beforeDiscord?.paused, false);

    // Staff press Pause and force a map while the worker is mid-flight.
    await repo.mapVote.patchState(server.id, { paused: true, pauseReason: "staff" });
    await repo.mapVote.patchState(server.id, { overrideMapId: "foy_warfare" });

    // The worker finishes and records the poll it just opened.
    await repo.mapVote.patchState(server.id, {
      activeMessageId: "msg-1", activeChannelId: "chan-1",
      options: [{ id: "carentan_warfare", name: "Carentan" }], openedAt: new Date().toISOString(),
    });

    const after = await repo.mapVote.getState(server.id);
    assert.equal(after?.paused, true, "the staff pause must survive the worker's write");
    assert.equal(after?.pauseReason, "staff");
    assert.equal(after?.overrideMapId, "foy_warfare", "the forced map must survive it too");
    assert.equal(after?.activeMessageId, "msg-1", "and the worker's own field must still land");

    // A patch that names no fields is a no-op that still returns the row (and creates it if absent).
    const untouched = await repo.mapVote.patchState(server.id, {});
    assert.equal(untouched.paused, true);
    assert.equal(untouched.activeMessageId, "msg-1");

    // Why the leader is not being queued has to survive the round trip — it is the only thing the
    // panel can show when the next map says "whatever the rotation says".
    const noted = await repo.mapVote.patchState(server.id, { liveApplyNote: "nobody has voted yet" });
    assert.equal(noted.liveApplyNote, "nobody has voted yet");
    assert.equal((await repo.mapVote.patchState(server.id, { liveApplyNote: null })).liveApplyNote, null);

    // Patching a server with no row yet must create one, defaulted, not throw.
    const fresh = await repo.servers.create({ name: `race2-${Math.random().toString(36).slice(2, 8)}`, host: "1.1.1.2", port: 28866, password: "p" });
    const created = await repo.mapVote.patchState(fresh.id, { paused: true });
    assert.equal(created.paused, true);
    assert.equal(created.overrideMapId, null);
    assert.deepEqual(created.options, []);
  } finally {
    await pool.end();
  }
});

/*
 * Every other test migrates an EMPTY database. A real upgrade does not: it runs the new migrations
 * against an install that already has rows. That is a different problem — a NOT NULL column with no
 * default, a unique index over data that already violates it, or a backfill that assumes a shape all
 * succeed on empty and fail on populated, and they fail on a live install at the worst moment.
 *
 * So: apply everything up to a point, put real rows in, then let the production `migrate()` apply the
 * rest. The window is the newest migrations, which is where the risk actually is — a migration that
 * has already shipped to real installs has been proven by them.
 */
const UPGRADE_WINDOW = 8;

/** Rows in the tables migrations tend to alter. Each is skipped if its table doesn't exist yet. */
const UPGRADE_SEED: [string, string][] = [
  ["servers", `INSERT INTO servers (id, name, host, port, password) VALUES (gen_random_uuid(),'S','1.1.1.1',28865,'p')`],
  ["users", `INSERT INTO users (id, username, password_hash) VALUES (gen_random_uuid(),'u1','h')`],
  ["players", `INSERT INTO players (id, platform, platform_id, name, first_seen, last_seen)
               VALUES (gen_random_uuid(),'steam','76561198000000001','Alice',now(),now()),
                      (gen_random_uuid(),'other','epic-bob','Bob',now(),now())`],
  ["player_stats", `INSERT INTO player_stats (player_id) SELECT id FROM players`],
  ["evt", `INSERT INTO evt (id, server_id, ts, kind, dedupe_key)
           SELECT gen_random_uuid(), s.id, now(), 'evt.kill', 'up'||g FROM servers s, generate_series(1,5) g`],
  ["matches", `INSERT INTO matches (id, server_id, map, started_at)
               SELECT gen_random_uuid(), id, 'Foy Warfare', now() FROM servers`],
  // Rounds as installs carry them TODAY: migration 062 (the flanked-line winner re-read) has
  // left the upgrade window, so the mis-called round is seeded ALREADY corrected — winner from
  // the score, the win credited to Bob. The window's job is now to leave both rows exactly as
  // they are; re-flipping a corrected round would be 062 running twice.
  ["matches", `INSERT INTO matches (id, server_id, map, started_at, ended_at, settled_at, winner, allied_score, axis_score, result)
               SELECT '00000000-0000-4000-8000-00000000006a', id, 'Kharkov Warfare', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour', 'axis', 2, 3, '\`Kharkov Warfare\` ALLIED (2 - 3) AXIS' FROM servers`],
  ["matches", `INSERT INTO matches (id, server_id, map, started_at, ended_at, settled_at, winner, allied_score, axis_score, result)
               SELECT '00000000-0000-4000-8000-00000000006b', id, 'Foy Warfare', now() - interval '4 hours', now() - interval '3 hours', now() - interval '3 hours', 'axis', 0, 5, 'Foy Warfare AXIS (0 - 5)' FROM servers`],
  ["player_match_stats", `INSERT INTO player_match_stats (match_id, player_id, server_id, player_name, side, won)
               SELECT '00000000-0000-4000-8000-00000000006a', p.id, s.id, p.name,
                      CASE WHEN p.name = 'Alice' THEN 'allies' ELSE 'axis' END,
                      CASE WHEN p.name = 'Alice' THEN false ELSE true END
               FROM players p, servers s`],
  // The careers as 062 settled them: the win sits on Bob, who earned it.
  ["player_stats", `UPDATE player_stats ps SET matches_played = 1,
                      matches_won = CASE WHEN (SELECT name FROM players WHERE id = ps.player_id) = 'Bob' THEN 1 ELSE 0 END,
                      server_id = (SELECT id FROM servers LIMIT 1)`],
  ["audit", `INSERT INTO audit (id, ts, actor_name, action, summary)
             VALUES (gen_random_uuid(), now(), 'sam', 'vip.grant', 'seeded')`],
  // A live watch as installs carry it TODAY: migration 063 (single-reason → watch_reasons) has
  // left the upgrade window, so the reason row is seeded alongside the flag rather than expected
  // from the carry. The window's job is to leave both exactly where they are.
  ["player_flags", `INSERT INTO player_flags (player_id, watchlist, vip, updated_by_name, updated_at, watch_reason, watch_by, watch_at)
                    SELECT id, true, false, 'PEPPER', now(), 'seen teaming with cheaters', 'PEPPER', now()
                      FROM players WHERE name = 'Alice'`],
  ["watch_reasons", `INSERT INTO watch_reasons (id, player_id, reason, added_by, added_at)
                     SELECT gen_random_uuid(), id, 'seen teaming with cheaters', 'PEPPER', now()
                       FROM players WHERE name = 'Alice'`],
  ["grants", `INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
              SELECT gen_random_uuid(), id, 'server.view', 'global', NULL, 'read' FROM users`],
  // Watchlist grants as installs carry them TODAY: migration 064 (the write→curate fan-out) has
  // left the upgrade window, so both halves are seeded rather than expected from the carry. The
  // window's job is to leave the pair exactly where it is.
  ["grants", `INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
              SELECT gen_random_uuid(), id, 'player.watchlist', 'global', NULL, 'write' FROM users`],
  ["grants", `INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
              SELECT gen_random_uuid(), id, 'player.watchlist.curate', 'global', NULL, 'write' FROM users`],
  // The role as installs carry it TODAY (migration 066's ask-strip has left the upgrade window,
  // so no stale 'ask' entry is seeded): the window's job is to leave the grants exactly as-is.
  ["roles", `INSERT INTO roles (id, name, grants)
             VALUES (gen_random_uuid(), 'Trial Mod', '[{"capability":"player.watchlist","level":"write"},{"capability":"player.watchlist.curate","level":"write"}]'::jsonb)`],
  // The player-rule modules as installs carry them TODAY: migration 072 (modules → rules) has
  // left the upgrade window, so the ARMED solo-tank module is seeded already TRANSLATED — the
  // equivalent enforcer rule below, in 072's own output shape — while the blob stays in
  // autosettings_config as the record 072 leaves behind. The window's job is now to leave the
  // carried rule exactly as it is, and never to resurrect the disabled module.
  ["autosettings_config", `INSERT INTO autosettings_config (server_id, enabled, dry_run, modules)
       SELECT id, true, false,
              '{"no_solo_tank":{"enabled":true,"dryRun":false,"config":{"tankRoles":[11,12],"minCrew":3,"warnIntervalSec":45,"kickAfter":true,"immuneLevel":15,"warnMessage":"crew up or step out"}},
                "min_level":{"enabled":false,"dryRun":true,"config":{"minLevel":50}}}'::jsonb
         FROM servers`],
  ["enforcer_rules", `INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours,
                        delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes,
                        alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params)
       SELECT gen_random_uuid(), 'No solo tank', true, id, 'app.state.solo_tank', NULL, 1, 45, 'message', 'crew up or step out', NULL,
              0, 10, 60, '[]'::jsonb, '["punish","kick"]'::jsonb, 120, true, NULL, '[]'::jsonb, '[]'::jsonb, false, 15,
              -- split-era shape: the minPlayers->players_min translation left the 8-migration
              -- window when 082 landed, so data at the split already carries clean params (the
              -- players_min column exists with its default by the time this row is seeded).
              '{"tankRoles":[11,12],"minCrew":3}'::jsonb
         FROM servers`],
  // Migration 080's residue cleanup left the 8-migration window when 088 landed, so data at the
  // split already carries the cleaned shape: no per-user autosettings.rules orphans, and Old
  // Guard's moderation.blacklist half already translated to the ban key. The window must leave
  // that cleaned state exactly as it stands — no later migration may re-wedge the role editor.
  ["roles", `INSERT INTO roles (id, name, grants)
             VALUES (gen_random_uuid(), 'Old Guard', '[{"capability":"moderation.bans","level":"write"},{"capability":"server.view","level":"read"}]'::jsonb)`],
  // A welcome-VIP marker as installs carry it TODAY (migration 058 moved it under `keep:` and has
  // since left the upgrade window), plus a scratch row from the same namespace. The migrations in
  // the window must leave both exactly where they are.
  ["plugin_kv", `INSERT INTO plugin_kv (namespace, key, value, updated_at)
                 VALUES ('vip-registration','keep:daysBonus:111222333444','true'::jsonb, now() - interval '400 days'),
                        ('vip-registration','777888999000','{"codeHash":"x"}'::jsonb, now() - interval '400 days')`],
];

test("postgres: the board tick's write-back cannot clobber a staff save", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: `board-${Math.random().toString(36).slice(2, 8)}`, host: "1.1.1.3", port: 28867, password: "p" });
    await repo.discordRelay.upsertConfig(server.id, {
      statusBoard: { enabled: true, channelId: "111", messageId: null, intervalSec: 60, imageName: null, title: null },
    });

    // The worker's tick begins: it reads the config, then spends seconds rendering. Everything
    // staff do in that window happens against the row, not against the worker's snapshot.
    await repo.discordRelay.getConfig(server.id);

    // Staff set a title and change the alert routing mid-render.
    await repo.discordRelay.upsertConfig(server.id, {
      statusBoard: { enabled: true, channelId: "111", messageId: null, intervalSec: 60, imageName: null, title: "The [LYNX] Division" },
      channels: { kills: "999" },
    });

    // The worker finishes and records only what is its to record.
    await repo.discordRelay.patchBoardState(server.id, { messageId: "m-1", imageName: "phl-rain.webp" });

    const after = await repo.discordRelay.getConfig(server.id);
    assert.equal(after?.statusBoard.title, "The [LYNX] Division", "the staff title must survive the worker's write");
    assert.equal(after?.channels.kills, "999", "so must every other field on the row");
    assert.equal(after?.statusBoard.messageId, "m-1", "and the worker's own state must still land");
    assert.equal(after?.statusBoard.imageName, "phl-rain.webp");

    // Clearing works through the same path: null is a value, not an omission.
    await repo.discordRelay.patchBoardState(server.id, { messageId: null, imageName: null });
    const cleared = await repo.discordRelay.getConfig(server.id);
    assert.equal(cleared?.statusBoard.messageId, null);
    assert.equal(cleared?.statusBoard.title, "The [LYNX] Division", "clearing board state must not touch the title");
  } finally {
    await pool.end();
  }
});

test("postgres: the newest migrations apply to a database that already has data", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;

  // A scratch database, because the point is to control where the migration chain stops.
  const name = `upgrade_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: DB });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    await admin.end();
    // Don't pretend to have run: say plainly that the role can't do this.
    if ((err as { code?: string }).code === "42501") {
      assert.ok(true, "skipped: the test role cannot CREATE DATABASE");
      return;
    }
    throw err;
  }

  const url = new URL(DB!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  try {
    // 1. The install as it exists today: everything except the window under test. The baseline
    // always applies (floor 1) — it is what creates the tables the seed lands in; the window
    // only ever covers migrations appended after it.
    const split = Math.max(1, MIGRATIONS.length - UPGRADE_WINDOW);
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.slice(0, split)) {
      await pool.query(m.sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    }

    // 2. Their data.
    let seeded = 0;
    for (const [table, sql] of UPGRADE_SEED) {
      const { rows } = await pool.query("SELECT to_regclass($1) AS t", [table]);
      if (rows[0].t === null) continue;
      await pool.query(sql);
      seeded++;
    }
    assert.ok(seeded >= 6, `the seed must actually land or this test proves nothing (placed ${seeded}/${UPGRADE_SEED.length})`);

    // 3. The upgrade, through the real code path.
    await new PostgresRepository(pool).migrate();

    // Applying is not enough — the rows have to still be there afterwards. A migration that drops or
    // truncates its way past a constraint would otherwise pass this test.
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM players)::int AS players,
              (SELECT count(*) FROM servers)::int AS servers,
              (SELECT count(*) FROM evt)::int     AS evt,
              (SELECT count(*) FROM audit)::int   AS audit`,
    );
    assert.equal(counts.rows[0].players, 2, "the upgrade must not lose players");
    assert.equal(counts.rows[0].servers, 1, "the upgrade must not lose servers");
    assert.equal(counts.rows[0].evt, 5, "the upgrade must not lose events");
    assert.equal(counts.rows[0].audit, 1, "the upgrade must not lose the audit trail");

    const applied = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    assert.equal(applied.rows[0].n, MIGRATIONS.length, "every migration must be recorded as applied");

    // The welcome-VIP marker already sits on the protected prefix on a live install; the upgrade
    // must leave it (and the scratch row beside it) exactly where they are — an install that
    // upgrades must not start paying second helpings.
    const kv = await pool.query("SELECT key FROM plugin_kv WHERE namespace = 'vip-registration' ORDER BY key");
    assert.deepEqual(kv.rows.map((r: { key: string }) => r.key), ["777888999000", "keep:daysBonus:111222333444"],
      "the paid-marker stays under keep:, and the scratch row beside it is untouched");

    // The role bundle survives the window byte-for-byte — no later migration may rewrite grants.
    const trialMod = await pool.query("SELECT grants FROM roles WHERE name = 'Trial Mod'");
    assert.deepEqual(trialMod.rows[0].grants, [
      { capability: "player.watchlist", level: "write" },
      { capability: "player.watchlist.curate", level: "write" },
    ], "the window leaves the role's grants untouched");

    // The rounds 062 corrected (before it left the window) stay corrected: no later migration
    // may re-read a settled round, re-flip a winner, or move a credited win.
    const flipped = await pool.query("SELECT winner FROM matches WHERE id = '00000000-0000-4000-8000-00000000006a'");
    assert.equal(flipped.rows[0].winner, "axis", "the corrected round keeps its corrected winner");
    const legacy = await pool.query("SELECT winner FROM matches WHERE id = '00000000-0000-4000-8000-00000000006b'");
    assert.equal(legacy.rows[0].winner, "axis", "the named-winner shape keeps its named winner");
    const won = await pool.query(
      `SELECT p.name, s.won FROM player_match_stats s JOIN players p ON p.id = s.player_id
        WHERE s.match_id = '00000000-0000-4000-8000-00000000006a' ORDER BY p.name`,
    );
    assert.deepEqual(won.rows, [{ name: "Alice", won: false }, { name: "Bob", won: true }]);
    const careers = await pool.query(
      "SELECT p.name, ps.matches_won FROM player_stats ps JOIN players p ON p.id = ps.player_id ORDER BY p.name",
    );
    assert.deepEqual(careers.rows, [{ name: "Alice", matches_won: 0 }, { name: "Bob", matches_won: 1 }]);

    // Alice's watch (carried by 063 before it left the window) stays whole: the flag and its
    // reason row survive the window untouched.
    const wr = await pool.query(
      `SELECT wr.reason, wr.added_by FROM watch_reasons wr JOIN players p ON p.id = wr.player_id WHERE p.name = 'Alice'`,
    );
    assert.deepEqual(wr.rows, [{ reason: "seen teaming with cheaters", added_by: "PEPPER" }]);

    // The watchlist pair 064 fanned out (before it left the window) stays whole: no later
    // migration may drop either half, personally or inside a role document.
    const curate = await pool.query(
      `SELECT count(*)::int AS n FROM grants WHERE capability = 'player.watchlist.curate' AND level = 'write'`,
    );
    assert.equal(curate.rows[0].n, 1, "the curation half of the watchlist pair survives the window");
    const role = await pool.query(`SELECT grants FROM roles WHERE name = 'Trial Mod'`);
    assert.ok((role.rows[0].grants as { capability: string; level: string }[])
      .some((g) => g.capability === "player.watchlist.curate" && g.level === "write"),
      "the role document keeps its curation half too");

    // The rule 072 carried (before it left the window) survives the window with its behaviour
    // intact — live, its knobs, the ladder — and 074's lift of minPlayers out of params onto the
    // rule itself still lands on a seeded post-072 row. The DISABLED module stays untranslated.
    const carried = await pool.query(`SELECT * FROM enforcer_rules WHERE event_kind = 'app.state.solo_tank'`);
    assert.equal(carried.rows.length, 1, "the carried rule survives the window, exactly once");
    const rule = carried.rows[0];
    assert.equal(rule.enabled, true);
    assert.equal(rule.dry_run, false, "the module was LIVE, so the rule must stay live — a silent dry-run park is a behaviour change");
    assert.equal(rule.window_sec, 45);
    assert.equal(rule.immune_level, 15);
    assert.equal(rule.reason, "crew up or step out");
    assert.deepEqual(rule.escalate_actions, ["punish", "kick"]);
    assert.deepEqual(rule.params, { tankRoles: [11, 12], minCrew: 3 });
    assert.equal(rule.players_min, 0);
    assert.equal(rule.breaker_limit, 10, "the safety valve arms on carried rules too");
    const notCarried = await pool.query(`SELECT count(*)::int AS n FROM enforcer_rules WHERE event_kind = 'app.state.low_level'`);
    assert.equal(notCarried.rows[0].n, 0, "a disabled module is not resurrected as a rule");

    // The cleanup 080 did (before it left the window) stays done: no later migration may
    // materialize fresh autosettings.rules orphans or rewrite the translated role document.
    const orphanGrants = await pool.query(`SELECT count(*)::int AS n FROM grants WHERE capability = 'autosettings.rules'`);
    assert.equal(orphanGrants.rows[0].n, 0, "no orphan rows reappear after the window");
    const oldGuard = await pool.query(`SELECT grants FROM roles WHERE name = 'Old Guard'`);
    const oldGuardCaps = (oldGuard.rows[0].grants as { capability: string; level: string }[])
      .map((g) => `${g.capability}/${g.level}`).sort();
    assert.deepEqual(oldGuardCaps, ["moderation.bans/write", "server.view/read"],
      "the cleaned role document survives the window byte-for-byte");

  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  }
});

/*
 * The v1 trigger panel armed single-action triggers; 088 reshapes the table into a step chain.
 * A live install upgrades with triggers ARMED, so the fold has to carry the old action into
 * steps[0] byte-for-byte — a trigger that changes behaviour across an upgrade fires the wrong
 * thing at a real player.
 */
test("postgres: 088 folds an armed v1 single-action trigger into steps[0] unchanged", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;

  const name = `fold_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: DB });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (err) {
    await admin.end();
    if ((err as { code?: string }).code === "42501") {
      assert.ok(true, "skipped: the test role cannot CREATE DATABASE");
      return;
    }
    throw err;
  }

  const url = new URL(DB!);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  try {
    const split = MIGRATIONS.findIndex((m) => m.id === "088_player_trigger_steps");
    assert.ok(split > 0, "088 must exist for this test to mean anything");
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.slice(0, split)) {
      await pool.query(m.sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    }

    // A trigger exactly as the shipped v1 panel armed it: one action in the old flat columns.
    await pool.query(`INSERT INTO players (id, platform, platform_id, name)
                      VALUES ('00000000-0000-4000-8000-0000000000f1','steam','76561100000000901','Rex')`);
    await pool.query(`INSERT INTO player_triggers (id, player_id, player_name, server_id, event, action, message, hours, points, fire_once, created_by_name)
                      VALUES ('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000f1','Rex',NULL,'connect','vip','',72,0,true,'staff')`);

    await new PostgresRepository(pool).migrate();

    const { rows } = await pool.query(`SELECT steps, fire_once, enabled, disarmed_at FROM player_triggers WHERE id = '00000000-0000-4000-8000-0000000000f2'`);
    assert.deepEqual(rows[0].steps, [{ action: "vip", message: "", hours: 72, points: 0, delaySec: 0 }],
      "the armed action became steps[0] with no delay — behaviour unchanged across the upgrade");
    assert.equal(rows[0].fire_once, true, "still a one-shot");
    assert.equal(rows[0].disarmed_at, null, "still armed");
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end();
  }
});

/*
 * Offset paging assumes the list holds still. The lists this panel pages through do not — the game
 * log gains a row every few seconds on a busy server — so "Load more" asks for OFFSET 50 against a
 * list that has grown, and page two starts inside page one. The reader is shown rows they just
 * read, and never sees the ones squeezed out between the two windows.
 *
 * Pinning the read to the instant it began is what fixes it: every page is answered from the same
 * snapshot, and rows newer than the anchor are simply not part of this read.
 */
test("postgres: paging a growing list neither repeats nor skips rows", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const PAGE = 20;
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `page-${tag}`, host: "1.1.1.1", port: 28865, password: "p" });
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

    // A quiet stretch of history, then the operator opens the log.
    await repo.events.insert(Array.from({ length: 60 }, (_, i) => ({
      serverId: server.id, ts: at(i), kind: "evt.kill", actorName: `old-${i}`, dedupeKey: `${tag}-old-${i}`,
    })));

    // The anchor the API mints on page one: after everything that exists, before anything to come.
    const anchor = at(100);
    const page1 = await repo.events.query({ serverId: server.id, limit: PAGE, offset: 0, to: anchor });
    assert.equal(page1.length, PAGE);
    // The control, read at the same moment and WITHOUT the anchor — the old behaviour's page one.
    const drift1 = await repo.events.query({ serverId: server.id, limit: PAGE, offset: 0 });

    // While the operator reads, the server keeps playing. Ten more kills land.
    await repo.events.insert(Array.from({ length: 10 }, (_, i) => ({
      serverId: server.id, ts: at(200 + i), kind: "evt.kill", actorName: `new-${i}`, dedupeKey: `${tag}-new-${i}`,
    })));

    // They press "Load more" — twice.
    const page2 = await repo.events.query({ serverId: server.id, limit: PAGE, offset: PAGE, to: anchor });
    const page3 = await repo.events.query({ serverId: server.id, limit: PAGE, offset: PAGE * 2, to: anchor });

    const keys = [...page1, ...page2, ...page3].map((e) => e.dedupeKey);
    assert.equal(keys.length, PAGE * 3, "three full pages");
    assert.equal(new Set(keys).size, keys.length, "a row must never appear on two pages");

    // And nothing was skipped: the three pages are exactly the first 60 of the pinned list.
    const whole = (await repo.events.query({ serverId: server.id, limit: 500, offset: 0, to: anchor })).map((e) => e.dedupeKey);
    assert.deepEqual(keys, whole.slice(0, PAGE * 3), "the pages must reconstruct the list in order");

    // The rows that arrived mid-read are genuinely excluded — they belong to the next refresh, not
    // to a read that started before they existed.
    assert.equal(keys.some((k) => k?.includes("-new-")), false, "a row newer than the anchor is not part of this read");

    // Without the anchor, the same sequence drifts: this is the behaviour being fixed. `drift1` was
    // read before the ten new events, `drift2` after — exactly what a reader pressing "Load more"
    // does, and the reason the control has to straddle the insert rather than follow it.
    const drift2 = await repo.events.query({ serverId: server.id, limit: PAGE, offset: PAGE });
    const overlap = drift2.map((e) => e.dedupeKey).filter((k) => drift1.some((e) => e.dedupeKey === k));
    assert.equal(overlap.length, 10, `unanchored paging should repeat exactly the 10 rows that arrived mid-read, got ${overlap.length}`);
  } finally {
    await pool.end();
  }
});

test("postgres: a round ending mid-read does not shift the match list", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: `mpage-${Math.random().toString(36).slice(2, 8)}`, host: "1.1.1.2", port: 28866, password: "p" });
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, n, 0, 0)).toISOString();
    for (let i = 0; i < 8; i++) await repo.matches.open({ serverId: server.id, map: `map-${i}`, startedAt: at(i) });

    const anchor = at(20);
    const first = await repo.matches.list(server.id, 4, 0, anchor);
    // A new round starts while the reader is on page one.
    await repo.matches.open({ serverId: server.id, map: "brand-new", startedAt: at(21) });
    const second = await repo.matches.list(server.id, 4, 4, anchor);

    const ids = [...first, ...second].map((m) => m.id);
    assert.equal(new Set(ids).size, 8, "no round may appear on both pages");
    assert.equal([...first, ...second].some((m) => m.map === "brand-new"), false, "a round that started after the read is not in it");
  } finally {
    await pool.end();
  }
});

/*
 * Hour and day buckets used to be taken in whatever zone the DATABASE server ran in — normally UTC,
 * whoever was reading. That put a Saturday-evening peak on Sunday morning for anyone not on UTC,
 * and the "which hours are we thin on" figure pointed at the wrong hours.
 *
 * Two things have to hold: the zone actually moves the bucket, and the in-memory store agrees with
 * Postgres. The second matters because a dev running without DATABASE_URL sees the memory store,
 * and a chart that disagrees between the two is worse than one that is wrong in both.
 */
test("postgres: session buckets follow the caller's zone, and the memory store agrees", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `tz-${tag}`, host: "1.1.1.3", port: 28867, password: "p" });
    const memServer = await mem.servers.create({ name: `tz-${tag}`, host: "1.1.1.3", port: 28867, password: "p" });
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765_tz_${tag}`, name: "Zoned" });
    const memPlayer = await mem.players.upsert({ game: "hll", platform: "steam", platformId: `765_tz_${tag}`, name: "Zoned" });

    // Saturday 2026-07-04 20:30 US Central == Sunday 2026-07-05 01:30 UTC.
    const connectedAt = "2026-07-05T01:30:00.000Z";
    const closedAt = "2026-07-05T02:30:00.000Z";
    await repo.sessions.open(player.id, server.id, connectedAt);
    await repo.sessions.close(player.id, server.id, closedAt);
    await mem.sessions.open(memPlayer.id, memServer.id, connectedAt);
    await mem.sessions.close(memPlayer.id, memServer.id, closedAt);

    const win = { serverId: server.id, from: "2026-07-01T00:00:00.000Z", to: "2026-07-10T00:00:00.000Z" };
    const memWin = { ...win, serverId: memServer.id };

    const utc = await repo.analytics.sessionActivity(win);
    assert.equal(utc.byHour[1], 1, "in UTC this session starts at 01:00");
    assert.equal(utc.byDow[0], 1, "…on Sunday");

    const central = await repo.analytics.sessionActivity({ ...win, tz: "America/Chicago" });
    assert.equal(central.byHour[20], 1, "locally it is a Saturday 20:00 session");
    assert.equal(central.byDow[6], 1, "…on Saturday");
    assert.equal(central.byHour[1], 0);
    assert.equal(central.weekHour[6]![20], 1, "and the crossing agrees with the margins");

    // The calendar DAY moves too, not just the hour — that is what makes a daily series wrong.
    assert.equal(utc.daily[0]?.date, "2026-07-05");
    assert.equal((await repo.analytics.sessionActivity({ ...win, tz: "America/Chicago" })).daily[0]?.date, "2026-07-04");

    // Parity: the store a dev sees without DATABASE_URL must answer identically.
    for (const tz of ["UTC", "America/Chicago", "Australia/Sydney"]) {
      const p = await repo.analytics.sessionActivity({ ...win, tz });
      const m = await mem.analytics.sessionActivity({ ...memWin, tz });
      assert.deepEqual(m.byHour, p.byHour, `byHour differs between stores for ${tz}`);
      assert.deepEqual(m.byDow, p.byDow, `byDow differs between stores for ${tz}`);
      assert.deepEqual(m.daily.map((d) => d.date), p.daily.map((d) => d.date), `daily dates differ for ${tz}`);
    }

    // The COMBAT heatmap follows the same zone rule. It was the one analytics read that missed
    // the zone pass — the memory store bucketed kills in UTC whatever q.tz said, so the same
    // Saturday-evening kill above landed on Sunday morning for a dev (or a small install)
    // without Postgres behind the panel.
    const killAt = { serverId: server.id, ts: connectedAt, kind: "evt.kill", actorName: "a", victimName: "b", weapon: "M1", dedupeKey: `tzc-${tag}` };
    await repo.events.insert([killAt]);
    await mem.events.insert([{ ...killAt, serverId: memServer.id }]);
    const combatCentral = await repo.analytics.combat({ ...win, tz: "America/Chicago" });
    assert.equal(combatCentral.byHour[20], 1, "locally the kill lands at Saturday 20:00");
    assert.equal(combatCentral.weekHour[6]![20], 1);
    for (const tz of ["UTC", "America/Chicago", "Australia/Sydney"]) {
      const p = await repo.analytics.combat({ ...win, tz });
      const m = await mem.analytics.combat({ ...memWin, tz });
      assert.deepEqual(m.byHour, p.byHour, `combat byHour differs between stores for ${tz}`);
      assert.deepEqual(m.weekHour, p.weekHour, `combat weekHour differs between stores for ${tz}`);
      assert.deepEqual(m.daily.map((d) => d.date), p.daily.map((d) => d.date), `combat daily dates differ for ${tz}`);
    }
  } finally {
    await pool.end();
  }
});

/*
 * The directory is the one paged list that cannot be pinned to a moment in time. The game log and
 * the audit trail only ever GAIN rows, so an upper time bound freezes them. This is a view of
 * mutable rows: last_seen changes every time somebody connects, kills every time they fire. The
 * value a row is sorted by moves under the reader — so offset paging repeats rows or skips them
 * depending on which way it moved, and no snapshot can prevent that.
 *
 * Keyset asks "what comes after this exact position in the ordering", which survives the movement.
 */
test("postgres: the directory pages correctly while rows are changing under it", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  const PAGE = 10;
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const made: { id: string; platformId: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const platformId = `765_dir_${tag}_${String(i).padStart(2, "0")}`;
      const seen = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId, name: `Dir ${tag} ${i}`, ts: seen });
      await mem.players.upsert({ game: "hll", platform: "steam", platformId, name: `Dir ${tag} ${i}`, ts: seen });
      made.push({ id: p.id, platformId });
    }
    const filters = { q: `dir_${tag}`, sort: "lastSeen" as const, sortDir: "desc" as const, limit: PAGE };

    // Page one, then a burst of activity: the ten players at the BOTTOM of the order all reconnect,
    // which under DESC last_seen throws them to the very top.
    const page1 = await repo.players.directory(filters);
    assert.equal(page1.length, PAGE);
    for (const m of made.slice(0, 10)) {
      await repo.players.upsert({ game: "hll", platform: "steam", platformId: m.platformId, name: "bumped", ts: new Date().toISOString() });
    }

    const seen = [...page1];
    let last = page1[page1.length - 1]!;
    for (let i = 0; i < 3; i++) {
      const next = await repo.players.directory({ ...filters, after: { value: last.sortKey, id: last.id } });
      if (!next.length) break;
      seen.push(...next);
      last = next[next.length - 1]!;
    }

    const ids = seen.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `keyset paging repeated a row: ${ids.length - new Set(ids).size} duplicates`);

    // The control: offset paging over the same movement DOES repeat rows.
    const off2 = await repo.players.directory({ ...filters, offset: PAGE });
    const overlap = off2.filter((r) => page1.some((o) => o.id === r.id));
    assert.ok(overlap.length > 0, "offset paging should visibly drift here — otherwise this test proves nothing");

    // And the memory store pages the same way, so a dev without DATABASE_URL sees the same thing.
    const memPage1 = await mem.players.directory(filters);
    const memLast = memPage1[memPage1.length - 1]!;
    const memPage2 = await mem.players.directory({ ...filters, after: { value: memLast.sortKey, id: memLast.id } });
    assert.equal(memPage2.length, PAGE, "the memory store must fill a cursor page too");
    assert.equal(new Set([...memPage1, ...memPage2].map((r) => r.platformId)).size, memPage1.length + memPage2.length,
      "the memory store must not repeat a row across pages either");
  } finally {
    await pool.end();
  }
});

/*
 * The score half of the server page is a JOIN across two tables and a date_trunc in the caller's
 * zone — three separate places for the two stores to disagree, and a chart is exactly the kind of
 * output that looks fine while being wrong. This writes through the real fold the sampler uses
 * rather than inserting rows directly, so the test covers the path the numbers actually take.
 */
test("postgres: score trends bucket by the caller's day, and the memory store agrees", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const mk = (r: typeof repo | typeof mem) =>
      r.servers.create({ name: `score-${tag}`, host: "1.1.1.4", port: 28869, password: "p" });
    const [server, memServer] = [await mk(repo), await mk(mem)];

    // Saturday 20:30 US Central is already Sunday in UTC — the same pair of rounds lands on two
    // different pairs of days depending on who is reading.
    const rounds = ["2026-07-05T01:30:00.000Z", "2026-07-06T15:00:00.000Z"];
    const roster = [
      // The leader is the point of `ledShare`: one of two participants ever led a squad.
      { platformId: `765_sc1_${tag}`, name: "Leader", role: 9, isSquadLead: true,
        score: { combat: 400, offense: 300, defense: 200, support: 100, vehicleKills: 5, vehiclesDestroyed: 1 } },
      { platformId: `765_sc2_${tag}`, name: "Rifle", role: 0, isSquadLead: false,
        score: { combat: 600, offense: 100, defense: 100, support: 200, vehicleKills: 1, vehiclesDestroyed: 0 } },
    ];
    for (const [r, srv] of [[repo, server], [mem, memServer]] as const) {
      // Both stores fold a sample onto a player they already know and skip one they don't — the
      // sampler upserts first, so a test that didn't would be measuring an empty roster.
      for (const p of roster) await r.players.upsert({ game: "hll", platform: "steam", platformId: p.platformId, name: p.name });
      for (const startedAt of rounds) {
        const match = await r.matches.open({ serverId: srv.id, map: "CARENTAN", startedAt });
        await r.stats.sampleRoster({ serverId: srv.id, matchId: match.id, sampleSec: 60, players: roster });
      }
    }

    const win = { serverId: server.id, from: "2026-07-01T00:00:00.000Z", to: "2026-07-10T00:00:00.000Z" };
    const memWin = { ...win, serverId: memServer.id };

    const utc = await repo.analytics.scoreTrends(win);
    assert.deepEqual(utc.daily.map((d) => d.date), ["2026-07-05", "2026-07-06"], "in UTC the first round is Sunday's");
    const central = await repo.analytics.scoreTrends({ ...win, tz: "America/Chicago" });
    assert.deepEqual(central.daily.map((d) => d.date), ["2026-07-04", "2026-07-06"], "locally it was Saturday night");

    // Totals are per-round finals summed across rounds, and a player is counted once however many
    // rounds they played — the two are different denominators and swapping them is silent.
    assert.equal(utc.totals.rounds, 2);
    assert.equal(utc.totals.players, 2, "two people, not four player-rounds");
    assert.equal(utc.totals.combat, 2000, "400+600 in each of two rounds");
    assert.equal(utc.totals.support, 600);
    assert.equal(utc.totals.vehicleKills, 12);
    assert.equal(utc.totals.slSeconds, 120, "60s of squad-leading in each round, from one player");
    assert.equal(utc.totals.ledShare, 0.5, "one of the two participants ever led");
    // Zone changes which day a round lands on; it must not change what the window totals to.
    assert.deepEqual(central.totals, utc.totals);

    for (const tz of ["UTC", "America/Chicago", "Australia/Sydney"]) {
      const p = await repo.analytics.scoreTrends({ ...win, tz });
      const m = await mem.analytics.scoreTrends({ ...memWin, tz });
      assert.deepEqual(m.daily, p.daily, `daily rows differ between stores for ${tz}`);
      assert.deepEqual(m.totals, p.totals, `totals differ between stores for ${tz}`);
    }

    // A server that has never been sampled answers with nothing to draw, not with zeroes that
    // would render as a real flat line.
    const empty = await repo.analytics.scoreTrends({ ...win, from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" });
    assert.deepEqual(empty.daily, []);
    assert.equal(empty.totals.rounds, 0);
    assert.equal(empty.totals.ledShare, null, "no participants means no share, not 0%");
  } finally {
    await pool.end();
  }
});

/*
 * The busiest chart on the server page. `sessionActivity` was moved onto the caller's zone; the
 * occupancy grid beside it — the one that answers "when are we actually busy" rather than "when do
 * people show up" — was still folded in UTC, in a helper shared by BOTH stores. So the two stores
 * agreed with each other and both put a US-Central Saturday evening on the Sunday row, which is
 * where cover gets scheduled from.
 */
test("postgres: the occupancy grid follows the caller's zone, and the memory store agrees", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const [server, memServer] = [
      await repo.servers.create({ name: `occ-${tag}`, host: "1.1.1.5", port: 28871, password: "p" }),
      await mem.servers.create({ name: `occ-${tag}`, host: "1.1.1.5", port: 28871, password: "p" }),
    ];
    const [player, memPlayer] = [
      await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765_occ_${tag}`, name: "Online" }),
      await mem.players.upsert({ game: "hll", platform: "steam", platformId: `765_occ_${tag}`, name: "Online" }),
    ];

    // Saturday 2026-07-04 20:00–21:00 US Central is Sunday 01:00–02:00 UTC.
    const from = "2026-07-05T01:00:00.000Z", to = "2026-07-05T02:00:00.000Z";
    await repo.sessions.open(player.id, server.id, from);
    await repo.sessions.close(player.id, server.id, to);
    await mem.sessions.open(memPlayer.id, memServer.id, from);
    await mem.sessions.close(memPlayer.id, memServer.id, to);

    // A two-day window, so the grid samples every five minutes and the hour is unambiguous.
    const win = { serverId: server.id, from: "2026-07-04T00:00:00.000Z", to: "2026-07-06T00:00:00.000Z" };
    const memWin = { ...win, serverId: memServer.id };

    const utc = await repo.analytics.concurrency(win);
    assert.ok(utc.weekHour[0]![1]! > 0, "in UTC the hour lands on Sunday 01:00");
    assert.equal(utc.weekHour[6]![20], 0, "…and not on Saturday evening");
    assert.ok(utc.daily.some((d) => d.date === "2026-07-05" && d.peak === 1), "and on Sunday's row of the trend");

    const central = await repo.analytics.concurrency({ ...win, tz: "America/Chicago" });
    assert.ok(central.weekHour[6]![20]! > 0, "locally it is a Saturday 20:00 hour");
    assert.equal(central.weekHour[0]![1], 0);
    assert.ok(central.daily.some((d) => d.date === "2026-07-04" && d.peak === 1), "…and Saturday's row of the trend");

    // The zone changes which cell an hour lands in; it must not change how many players there were.
    assert.equal(central.peak, utc.peak);
    assert.equal(central.average, utc.average);

    // The same samples unrolled onto real dates. The week grid averages every Saturday together;
    // this one has to put the hour on THE Saturday it happened, and mark hours the window never
    // sampled as absent rather than as an empty server.
    const utcDay = utc.dayHour.find((d) => d.date === "2026-07-05");
    assert.ok(utcDay && utcDay.hours[1]! > 0, "in UTC the hour sits on the 5th's row, 01:00");
    assert.equal(utcDay!.hours[12], 0, "a sampled hour nobody played is a real zero");
    const centralDay = central.dayHour.find((d) => d.date === "2026-07-04");
    assert.ok(centralDay && centralDay.hours[20]! > 0, "locally it sits on the 4th's row, 20:00");
    // The UTC window opens mid-day in Chicago, so the local 3rd exists but its morning was never
    // sampled — null, not zero, or the chart would draw a dead morning that is really no data.
    const centralFirst = central.dayHour[0]!;
    assert.equal(centralFirst.date, "2026-07-03");
    assert.equal(centralFirst.hours[0], null, "before the window opened: no data, not an empty server");
    assert.equal(centralFirst.hours[19], 0, "the first sampled local hour is a real zero");

    for (const tz of ["UTC", "America/Chicago", "Australia/Sydney"]) {
      const p = await repo.analytics.concurrency({ ...win, tz });
      const m = await mem.analytics.concurrency({ ...memWin, tz });
      assert.deepEqual(m.weekHour, p.weekHour, `the occupancy grid differs between stores for ${tz}`);
      assert.deepEqual(m.dayHour, p.dayHour, `the date grid differs between stores for ${tz}`);
      assert.deepEqual(m.daily, p.daily, `the daily trend differs between stores for ${tz}`);
    }
  } finally {
    await pool.end();
  }
});

/*
 * The early-leavers-by-map attribution. It used to join each session against EVERY round whose
 * lifetime contained the connect instant — and a round that never got its MATCH ENDED line (a crash,
 * a mid-round import cutoff) reads as still running months later, so every session since ALSO
 * matched it: one connect, two map rows, and the "which maps empty the server" panel summed to more
 * sessions than there were. On a year of imported history that join was also the whole 7-day
 * timeout. A session now lands on exactly one map — the round actually running when they connected,
 * or 'Unknown' when they connected between rounds (which the old join misfiled under the stale one).
 */
test("postgres: a session lands on exactly one map, and a stale open round cannot double-count it", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const [server, memServer] = [
      await repo.servers.create({ name: `bym-${tag}`, host: "1.1.1.6", port: 28873, password: "p" }),
      await mem.servers.create({ name: `bym-${tag}`, host: "1.1.1.6", port: 28873, password: "p" }),
    ];
    const [player, memPlayer] = [
      await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765_bym_${tag}`, name: "Joiner" }),
      await mem.players.upsert({ game: "hll", platform: "steam", platformId: `765_bym_${tag}`, name: "Joiner" }),
    ];

    for (const [r, sid] of [[repo, server.id], [mem, memServer.id]] as const) {
      // Months old and never closed — exactly the stray a crash leaves behind.
      await r.matches.importOne({ serverId: sid, map: "Stale", startedAt: "2026-03-01T00:00:00.000Z", endedAt: null, winner: null, result: null });
      await r.matches.importOne({ serverId: sid, map: "Foy", startedAt: "2026-07-05T01:00:00.000Z", endedAt: "2026-07-05T02:30:00.000Z", winner: "allies", result: null });
    }
    const sess = (connectedAt: string, disconnectedAt: string, durationSec: number) => {
      const s = { connectedAt, disconnectedAt, durationSec };
      return Promise.all([
        repo.sessions.importOne({ ...s, playerId: player.id, serverId: server.id }),
        mem.sessions.importOne({ ...s, playerId: memPlayer.id, serverId: memServer.id }),
      ]);
    };
    await sess("2026-07-05T01:10:00.000Z", "2026-07-05T01:12:00.000Z", 120);   // during Foy, left early
    await sess("2026-07-05T01:20:00.000Z", "2026-07-05T02:20:00.000Z", 3600);  // during Foy, stayed
    await sess("2026-07-05T03:00:00.000Z", "2026-07-05T04:00:00.000Z", 3600);  // between rounds

    const win = { serverId: server.id, from: "2026-07-01T00:00:00.000Z", to: "2026-07-10T00:00:00.000Z" };
    const a = await repo.analytics.sessionActivity(win);
    assert.equal(a.sessions, 3);
    assert.deepEqual(a.earlyLeaversByMap, [
      { map: "Foy", sessions: 2, short: 1 },
      { map: "Unknown", sessions: 1, short: 0 },
    ], "three connects, three attributions: the stale round claims none of them");

    const m = await mem.analytics.sessionActivity({ ...win, serverId: memServer.id });
    assert.deepEqual(m.earlyLeaversByMap, a.earlyLeaversByMap, "the attribution differs between stores");
  } finally {
    await pool.end();
  }
});

/*
 * The lockout, at the store level. Both halves have to behave identically on both stores, because
 * a security control that works in dev and not in production is worse than none — you believe the
 * account is locked out.
 */
test("postgres: revoking sessions bumps only that account, and takes its tokens with it", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  try {
    await repo.migrate();
    for (const r of [repo, mem] as const) {
      const tag = Math.random().toString(36).slice(2, 8);
      const a = await r.users.create({ username: `lock-a-${tag}`, passwordHash: "h" });
      const b = await r.users.create({ username: `lock-b-${tag}`, passwordHash: "h" });
      assert.equal(a.sessionEpoch, 0, "a new account starts at the epoch every existing token reads as");

      await r.tokens.create({ userId: a.id, name: "one", tokenHash: `t1_${tag}` });
      await r.tokens.create({ userId: a.id, name: "two", tokenHash: `t2_${tag}` });
      await r.tokens.create({ userId: b.id, name: "other", tokenHash: `t3_${tag}` });

      assert.equal(await r.users.revokeSessions(a.id), 1);
      assert.equal(await r.users.revokeSessions(a.id), 2, "each revocation moves it on — it is a counter, not a flag");
      assert.equal((await r.users.findById(a.id))?.sessionEpoch, 2, "and it is what a later read sees");
      assert.equal((await r.users.findById(b.id))?.sessionEpoch, 0, "the other account is untouched");

      assert.equal(await r.tokens.removeAllForUser(a.id), 2);
      assert.deepEqual(await r.tokens.listByUser(a.id), []);
      assert.equal((await r.tokens.listByUser(b.id)).length, 1, "and keeps its own tokens");
      assert.equal(await r.tokens.removeAllForUser(a.id), 0, "revoking twice is not an error, it is nothing left to do");

      assert.equal(await r.users.revokeSessions("00000000-0000-0000-0000-000000000000"), null, "no such account");
    }
  } finally {
    await pool.end();
  }
});

/*
 * Trimming is the one destructive thing the panel does, and the backup is the only reason it is
 * safe to do at all.
 *
 * The old shape SELECTed the whole matched slice into memory, wrote it, then DELETEd — measured at
 * 417 MB of resident memory for 300,000 events (a fortnight on a busy server) in the API process
 * that also serves the panel. This project imports YEARS of CRCON history, so millions of rows is
 * the ordinary case. It also meant the backup was a DIFFERENT query from the delete: anything
 * matching the predicate that arrived in between — a CRCON import backfilling old events — was
 * deleted without ever reaching the file.
 */
test("postgres: a backed-up trim archives exactly what it deleted", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const { createGunzip } = await import("node:zlib");
  const { createReadStream } = await import("node:fs");
  const { rm } = await import("node:fs/promises");
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const path = `/tmp/claude-0/trim-test-${Math.random().toString(36).slice(2)}.ndjson.gz`;
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `trim-${tag}`, host: "1.1.1.6", port: 28873, password: "p" });

    // More rows than one batch, so the loop actually loops — a single-batch test would pass on
    // the old shape too and prove nothing about the thing that changed.
    const N = 12_000;
    const old = Date.parse("2024-01-01T00:00:00Z");
    await repo.events.insert(Array.from({ length: N }, (_, i) => ({
      serverId: server.id, ts: new Date(old + i * 1000).toISOString(), kind: "evt.kill",
      actorName: `A${i}`, victimName: "B", weapon: "M1", dedupeKey: `t-${tag}-${i}`,
    })));
    // A row the trim must NOT touch: same kind, newer than the cutoff.
    await repo.events.insert([{
      serverId: server.id, ts: new Date().toISOString(), kind: "evt.kill",
      actorName: "Recent", victimName: "B", weapon: "M1", dedupeKey: `keep-${tag}`,
    }]);

    const spec = { kinds: ["evt.kill"], olderThanIso: "2025-01-01T00:00:00.000Z", backupPath: path };
    assert.equal(await repo.events.countForTrim(spec), N, "the count and the trim agree on what matches");
    const res = await repo.events.trim(spec);
    assert.equal(res.deleted, N, "every matching row went");
    assert.equal(res.backupPath, path);

    // The archive is readable and holds exactly the deleted rows — not a truncated gzip, and not
    // a snapshot taken before the delete that might disagree with it.
    const lines: string[] = [];
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      createReadStream(path).pipe(createGunzip())
        .on("data", (c: Buffer) => { buf += c.toString("utf8"); })
        .on("end", () => { lines.push(...buf.split("\n").filter(Boolean)); resolve(); })
        .on("error", reject);
    });
    assert.equal(lines.length, N, `the archive holds ${lines.length} rows for ${N} deleted`);
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string; actorName: string; ts: string });
    assert.ok(parsed.every((r) => r.kind === "evt.kill"), "and only the kinds asked for");
    assert.equal(new Set(parsed.map((r) => r.actorName)).size, N, "every row is distinct — no batch written twice");
    assert.ok(parsed.every((r) => r.ts < spec.olderThanIso), "and none from after the cutoff");

    // The newer row survived. Scoped to THIS server: `countForTrim` is deliberately global (a trim
    // is not per-server), so counting with it here would also see every other test's events.
    const left = await repo.events.listRecent(server.id, 50);
    assert.equal(left.length, 1, "exactly the row after the cutoff is left");
    assert.equal(left[0]!.actorName, "Recent");
  } finally {
    await rm(path, { force: true }).catch(() => {});
    await pool.end();
  }
});

/*
 * The same two-server separation the memory store is held to in repo.test.ts, against real SQL.
 *
 * It has to be tested twice because the two stores share no code here: the memory store folds rows
 * in TypeScript, Postgres does it with GROUP BY over a composite key, a LATERAL join and an ANY()
 * filter. A store-parity bug in this area is exactly the kind that only shows up in production,
 * because the panel's own tests run against memory.
 */
test("postgres: two servers stay separable across stats, the board and the directory", { skip: !DB }, async () => {
  const { PostgresRepository, InMemoryRepository } = await import("../dist/index.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  try {
    await repo.migrate();
    // Every other test in this file shares the database, so the fixtures are tagged and every
    // assertion filters to them — otherwise a global board would be counting other tests' players.
    const tag = Math.random().toString(36).slice(2, 8);
    const mk = async (n: string, port: number) => {
      const s = await repo.servers.create({ name: `${n}-${tag}`, host: "10.0.0.1", port, password: "p" });
      const m = await mem.servers.create({ name: `${n}-${tag}`, host: "10.0.0.1", port, password: "p" });
      return { pg: s.id, mem: m.id };
    };
    const A = await mk("A", 28100 + Math.floor(Math.random() * 500));
    const B = await mk("B", 28700 + Math.floor(Math.random() * 500));
    const player = async (suffix: string, name: string) => {
      const input = { game: "hll", platform: "steam", platformId: `765_${tag}_${suffix}`, name };
      return { pg: (await repo.players.upsert(input)).id, mem: (await mem.players.upsert(input)).id, name };
    };
    const alice = await player("a", `Alice ${tag}`);
    const carol = await player("c", `Carol ${tag}`);
    const bob = await player("b", `Bob ${tag}`);

    for (const [store, sa, sb, pa, pc, pb] of [
      [repo, A.pg, B.pg, alice.pg, carol.pg, bob.pg],
      [mem, A.mem, B.mem, alice.mem, carol.mem, bob.mem],
    ] as const) {
      await store.stats.bumpMany([
        { playerId: pa, serverId: sa, delta: { kills: 100, deaths: 10, visits: 1, playtimeSec: 3600 } },
        { playerId: pc, serverId: sa, delta: { kills: 20, deaths: 20, visits: 1, playtimeSec: 1200 } },
        { playerId: pc, serverId: sb, delta: { kills: 30, deaths: 10, visits: 2, playtimeSec: 2400 } },
        { playerId: pb, serverId: sb, delta: { kills: 5, deaths: 5, visits: 1, playtimeSec: 600 } },
      ]);
    }

    // Per-server rollups, and the career that is still their sum.
    assert.equal((await repo.stats.get(carol.pg, A.pg))?.kills, 20);
    assert.equal((await repo.stats.get(carol.pg, B.pg))?.kills, 30);
    assert.equal(await repo.stats.get(alice.pg, B.pg), null);
    const career = await repo.stats.get(carol.pg);
    assert.equal(career?.kills, 50, "the career is every server added together, as a profile means it");
    assert.equal(career?.visits, 3);
    assert.equal(career?.serverId, null, "a total is not any server's row");
    assert.deepEqual((await repo.stats.byServer(carol.pg)).map((s) => s.kills).sort((x, y) => x - y), [20, 30]);
    // …and the memory store answers identically, which is the point of running both.
    assert.equal((await mem.stats.get(carol.mem))?.kills, 50);
    assert.equal((await mem.stats.get(carol.mem, A.mem))?.kills, 20);

    // The board, scoped and unscoped. Filtered to this test's players because the table is shared.
    const mine = new Set([alice.name, carol.name, bob.name]);
    const board = async (ids?: string[]) =>
      (await repo.stats.leaderboard("kills", 500, ids)).filter((e) => mine.has(e.name));
    assert.deepEqual((await board([A.pg])).map((e) => e.name), [alice.name, carol.name]);
    assert.equal((await board([A.pg])).find((e) => e.name === carol.name)?.kills, 20);
    assert.deepEqual((await board([B.pg])).map((e) => e.name), [carol.name, bob.name]);
    assert.equal((await board([B.pg])).find((e) => e.name === carol.name)?.kills, 30);
    assert.equal((await board()).find((e) => e.name === carol.name)?.kills, 50, "combining is still on offer");
    assert.deepEqual(await repo.stats.leaderboard("kills", 50, []), [], "and a viewer scoped to nothing sees nothing");

    // The directory. The LATERAL fold must produce ONE row per player, not one per server row —
    // a plain join on the new composite key would silently duplicate everyone who plays on both.
    const filters = { q: `765_${tag}`, limit: 50 };
    const dirA = await repo.players.directory({ ...filters, serverIds: [A.pg] });
    assert.deepEqual(dirA.map((r) => r.name).sort(), [alice.name, carol.name].sort());
    assert.equal(dirA.find((r) => r.name === carol.name)?.kills, 20);
    assert.equal(await repo.players.directoryCount({ ...filters, serverIds: [A.pg] }), 2, "the count must match the rows");
    const dirAll = await repo.players.directory(filters);
    assert.equal(dirAll.length, 3, "one row per player, even for someone who plays on both");
    assert.equal(dirAll.find((r) => r.name === carol.name)?.kills, 50);
    assert.equal(await repo.players.directoryCount(filters), 3);

    // VIP: a per-server grant, which the directory used to answer from a community-wide flag.
    await repo.vips.upsert({ serverId: A.pg, playerId: `765_${tag}_a`, playerName: alice.name, expiration: null, createdByName: "t" });
    await repo.vips.upsert({ serverId: B.pg, playerId: `765_${tag}_c`, playerName: carol.name, expiration: "2020-01-01T00:00:00.000Z", createdByName: "t" });
    assert.deepEqual((await repo.players.directory({ ...filters, serverIds: [A.pg], vipOnly: true })).map((r) => r.name), [alice.name]);
    assert.deepEqual((await repo.players.directory({ ...filters, serverIds: [B.pg], vipOnly: true })).map((r) => r.name), [],
      "an expired grant is not VIP now");
    assert.deepEqual((await repo.players.directory({ ...filters, vipOnly: true })).map((r) => r.name), [alice.name]);

    // Sessions, scoped.
    await repo.sessions.open(carol.pg, A.pg, "2026-06-01T10:00:00.000Z");
    await repo.sessions.close(carol.pg, A.pg, "2026-06-01T11:00:00.000Z");
    await repo.sessions.open(carol.pg, B.pg, "2026-06-02T10:00:00.000Z");
    await repo.sessions.close(carol.pg, B.pg, "2026-06-02T11:00:00.000Z");
    assert.equal((await repo.sessions.list(carol.pg)).length, 2);
    assert.deepEqual((await repo.sessions.list(carol.pg, 50, A.pg)).map((s) => s.serverId), [A.pg]);
  } finally {
    await pool.end();
  }
});

/*
 * The directory sorted by a career figure adds every player's rows up in one pass and joins the
 * totals (it read them a player at a time before), and its count no longer works the totals out at
 * all. What the listing shows must not move: one line per player, the figures of the servers asked
 * about and no others, a player who never played kept when no server is chosen and left out when
 * one is, pages that neither repeat nor skip, and a count that matches them.
 */
test("postgres: sorted by a career figure, the directory ranks each player once, by the servers asked about", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/index.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    // The table is shared with every other test here, so the lists are narrowed to this test's ids.
    const tag = Math.random().toString(36).slice(2, 8);
    const server = async (n: string) =>
      (await repo.servers.create({ name: `${n}-${tag}`, host: "10.0.0.1", port: 29100 + Math.floor(Math.random() * 800), password: "p" })).id;
    const A = await server("A");
    const B = await server("B");
    const name = new Map<string, string>();
    const player = async (suffix: string, n: string) => {
      const id = (await repo.players.upsert({ game: "hll", platform: "steam", platformId: `766_${tag}_${suffix}`, name: `${n} ${tag}` })).id;
      name.set(id, n);
      return id;
    };
    const alice = await player("a", "alice");
    const carol = await player("c", "carol");
    const bob = await player("b", "bob");
    await player("d", "dave"); // seen, never played: no row on any server
    await repo.stats.bumpMany([
      { playerId: alice, serverId: A, delta: { kills: 100, deaths: 10, visits: 1, playtimeSec: 3600 } },
      { playerId: carol, serverId: A, delta: { kills: 20, deaths: 20, teamkills: 3, visits: 1, playtimeSec: 1200 } },
      { playerId: carol, serverId: B, delta: { kills: 30, deaths: 10, teamkills: 1, visits: 2, playtimeSec: 2400 } },
      // More than Carol has on B and fewer than her career: a list of B that took in her other
      // server would put her above him.
      { playerId: bob, serverId: B, delta: { kills: 40, deaths: 5, visits: 5, playtimeSec: 600 } },
    ]);
    type Filters = Parameters<typeof repo.players.directory>[0];
    const mine = { q: `766_${tag}`, limit: 50 };
    const list = async (f: Filters) =>
      (await repo.players.directory({ ...mine, ...f })).map((r) => [name.get(r.id), Number(r.sortKey)]);

    assert.deepEqual(await list({ sort: "kills", sortDir: "desc" }), [["alice", 100], ["carol", 50], ["bob", 40], ["dave", 0]],
      "every player once, careers summed across servers, the one who never played at 0");
    assert.deepEqual(await list({ sort: "kills", sortDir: "asc" }), [["dave", 0], ["bob", 40], ["carol", 50], ["alice", 100]]);
    assert.deepEqual(await list({ sort: "kills", sortDir: "desc", serverIds: [B] }), [["bob", 40], ["carol", 30]],
      "B's own kills: Carol's 20 on A are not B's");
    assert.deepEqual(await list({ sort: "kills", sortDir: "desc", serverIds: [A] }), [["alice", 100], ["carol", 20]],
      "only those with a row on A — Bob never played there");
    assert.deepEqual(await list({ sort: "kills", sortDir: "desc", serverIds: [A, B] }), [["alice", 100], ["carol", 50], ["bob", 40]]);
    assert.deepEqual(await list({ sort: "kills", serverIds: [] }), [], "a viewer scoped to nothing sees nobody");
    assert.deepEqual(await list({ sort: "playtime", sortDir: "asc", serverIds: [A] }), [["carol", 1200], ["alice", 3600]]);
    assert.deepEqual(await list({ sort: "visits", sortDir: "desc" }), [["bob", 5], ["carol", 3], ["alice", 1], ["dave", 0]]);
    assert.deepEqual(await list({ sort: "teamkills", sortDir: "desc", serverIds: [B] }), [["carol", 1], ["bob", 0]]);
    // The whole line is the chosen servers' figures, not only the one sorted by.
    const carolOnA = (await repo.players.directory({ ...mine, sort: "teamkills", serverIds: [A] })).find((r) => r.id === carol);
    assert.deepEqual([carolOnA?.kills, carolOnA?.deaths, carolOnA?.teamkills, carolOnA?.visits, carolOnA?.playtimeSec], [20, 20, 3, 1, 1200]);

    // Pages, by offset and by cursor, meet without a gap or a repeat.
    assert.deepEqual(await list({ sort: "kills", sortDir: "desc", limit: 2, offset: 2 }), [["bob", 40], ["dave", 0]]);
    assert.deepEqual(await list({ sort: "kills", sortDir: "desc", limit: 2, after: { value: 50, id: carol } }), [["bob", 40], ["dave", 0]]);

    // The count, worked out without the totals, matches the lists above whatever the sort.
    for (const sort of [undefined, "kills", "visits"] as const) {
      assert.equal(await repo.players.directoryCount({ ...mine, sort }), 4, `everyone (${sort ?? "default sort"})`);
      assert.equal(await repo.players.directoryCount({ ...mine, sort, serverIds: [A] }), 2, `A (${sort ?? "default sort"})`);
      assert.equal(await repo.players.directoryCount({ ...mine, sort, serverIds: [B] }), 2, `B (${sort ?? "default sort"})`);
      assert.equal(await repo.players.directoryCount({ ...mine, sort, serverIds: [A, B] }), 3, `A and B (${sort ?? "default sort"})`);
      assert.equal(await repo.players.directoryCount({ ...mine, sort, serverIds: [] }), 0, `nothing (${sort ?? "default sort"})`);
    }
    assert.equal(await repo.players.directoryCount({ q: `766_${tag}_c`, serverIds: [A] }), 1, "and with a search on top");
  } finally {
    await pool.end();
  }
});

/*
 * One server's board is read straight from that server's rows rather than added up per player
 * first: the table holds one row per player and server, so a server's rows are its board. The
 * same server named twice still goes through the adding up, which makes it the yardstick here —
 * the two must agree on every sort, ties and limit included — and a board of two servers must
 * still add both up.
 */
test("postgres: one server's leaderboard is its own rows, in the order the summed board gives", { skip: !DB }, async () => {
  const { PostgresRepository, LEADERBOARD_SORTS } = await import("../dist/index.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = async (n: string) =>
      (await repo.servers.create({ name: `${n}-${tag}`, host: "10.0.0.1", port: 29100 + Math.floor(Math.random() * 800), password: "p" })).id;
    const A = await server("A");
    const B = await server("B");
    const ids: string[] = [];
    for (const n of ["p1", "p2", "p3", "p4", "p5"]) {
      ids.push((await repo.players.upsert({ game: "hll", platform: "steam", platformId: `767_${tag}_${n}`, name: `${n} ${tag}` })).id);
    }
    const [p1, p2, p3, p4, p5] = ids as [string, string, string, string, string];
    await repo.stats.bumpMany([
      // p2 and p3 tie on kills, so the tiebreak decides between them.
      { playerId: p1, serverId: A, delta: { kills: 50, deaths: 10, teamkills: 1, playtimeSec: 900 } },
      { playerId: p2, serverId: A, delta: { kills: 30, deaths: 3, teamkills: 4, playtimeSec: 7200 } },
      { playerId: p3, serverId: A, delta: { kills: 30, deaths: 15, playtimeSec: 1800 } },
      { playerId: p4, serverId: A, delta: { kills: 5, deaths: 0, teamkills: 2, playtimeSec: 300 } },
      { playerId: p1, serverId: B, delta: { kills: 1, deaths: 1 } },
      { playerId: p5, serverId: B, delta: { kills: 70, deaths: 7 } },
    ]);
    // The score buckets and squad-lead time, which the game reports rather than the kill log: each
    // ordered differently from the kills, and from each other.
    const scores: [string, number, number, number, number, number][] = [
      [p1, 100, 4000, 50, 900, 60], [p2, 900, 10, 3000, 50, 0], [p3, 500, 700, 700, 4000, 1800], [p4, 20, 2000, 9000, 10, 600],
    ];
    for (const [id, combat, offense, defense, support, sl] of scores) {
      await pool.query(
        "UPDATE player_stats SET combat = $3, offense = $4, defense = $5, support = $6, sl_seconds = $7 WHERE player_id = $1 AND server_id = $2",
        [id, A, combat, offense, defense, support, sl]);
    }

    for (const sort of LEADERBOARD_SORTS) {
      const one = await repo.stats.leaderboard(sort, 50, [A]);
      assert.deepEqual(one, await repo.stats.leaderboard(sort, 50, [A, A]), `${sort}: as the summed board has it`);
      assert.equal(one.length, 4, `${sort}: one line per player on A, and nobody from B`);
      assert.deepEqual(await repo.stats.leaderboard(sort, 2, [A]), one.slice(0, 2), `${sort}: the limit cuts the same board`);
      assert.deepEqual(await repo.stats.leaderboard(sort, 2, [A], 2), one.slice(2, 4), `${sort}: and the offset pages it`);
      assert.deepEqual(await repo.stats.leaderboard(sort, 2, [A, B], 3), (await repo.stats.leaderboard(sort, 50, [A, B])).slice(3, 5), `${sort}: the summed board too`);
    }
    assert.deepEqual([await repo.stats.leaderboardCount([A]), await repo.stats.leaderboardCount([B]), await repo.stats.leaderboardCount([A, B]), await repo.stats.leaderboardCount([])],
      [4, 2, 5, 0], "how many each board ranks: p1 on both servers is one line of theirs");
    const line = (e: { playerId: string; kills: number; combat: number }) => [ids.indexOf(e.playerId) + 1, e.kills, e.combat];
    assert.deepEqual((await repo.stats.leaderboard("kills", 50, [A])).map(line), [[1, 50, 100], [2, 30, 900], [3, 30, 500], [4, 5, 20]],
      "A's own figures, the tie in platform-id order");
    assert.deepEqual((await repo.stats.leaderboard("support", 50, [A])).map(line), [[3, 30, 500], [1, 50, 100], [2, 30, 900], [4, 5, 20]]);
    assert.deepEqual((await repo.stats.leaderboard("kills", 50, [B])).map(line), [[5, 70, 0], [1, 1, 0]]);
    // Two servers are still added up into one line per player.
    assert.deepEqual((await repo.stats.leaderboard("kills", 50, [A, B])).map(line), [[5, 70, 0], [1, 51, 100], [2, 30, 900], [3, 30, 500], [4, 5, 20]]);
  } finally {
    await pool.end();
  }
});

/*
 * The combat screen's two rankings count each player's kills per name the log gave them first and
 * name the lines after, rather than joining every kill to its player before counting. What a line
 * is must not move: one per player under the name they have now — or, with no name on file (no
 * row, or an empty one), one per name the log gave them — and a kill with no player in no line.
 */
test("postgres: the combat rankings line players up as before — counted first, named after", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/index.js");
  const { randomUUID } = await import("node:crypto");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const C = (await repo.servers.create({ name: `Combat-${tag}`, host: "10.0.0.1", port: 29100 + Math.floor(Math.random() * 800), password: "p" })).id;
    const player = async (n: string) =>
      (await repo.players.upsert({ game: "hll", platform: "steam", platformId: `768_${tag}_${n}`, name: `${n} ${tag}` })).id;
    const ana = await player("Ana");
    const dan = await player("Dan");
    const eve = await player("Eve");
    await pool.query("UPDATE players SET name = '' WHERE id = $1", [eve]); // a row with no name on it
    const ghost = randomUUID(); // a player the log names whom we hold no row for
    const at = Date.parse("2026-08-01T10:00:00.000Z");
    const events: Parameters<typeof repo.events.insert>[0] = [];
    const log = (n: number, kind: "evt.kill" | "evt.teamkill", actorPlayerId: string | null, actorName: string | null) => {
      for (let i = 0; i < n; i++) {
        events.push({ serverId: C, ts: new Date(at + events.length * 1000).toISOString(), kind, actorPlayerId, actorName, weapon: "M1 GARAND", dedupeKey: `${tag}-${events.length}` });
      }
    };
    log(4, "evt.kill", ana, "Ana"); log(3, "evt.kill", ana, "[TAG] Ana"); // renamed mid-window
    log(1, "evt.teamkill", ana, "Ana"); log(1, "evt.teamkill", ana, "[TAG] Ana");
    log(6, "evt.kill", dan, "Dan");
    log(5, "evt.kill", ghost, "Ghost"); log(1, "evt.kill", ghost, null); log(3, "evt.teamkill", ghost, "Ghost");
    log(3, "evt.kill", eve, "Eve"); log(2, "evt.kill", eve, "Evie"); log(1, "evt.teamkill", eve, "Evie");
    log(9, "evt.kill", null, null); // no player at all: in the totals, in no ranking
    assert.equal((await repo.events.insert(events)).length, events.length);

    const c = await repo.analytics.combat({ serverId: C, from: new Date(at - 60_000).toISOString(), to: new Date(at + 3_600_000).toISOString(), tz: "UTC" });
    assert.equal(c.totals.kills, 33);
    assert.deepEqual(c.topKillers.map((k) => [k.playerId, k.name, k.kills]), [
      [ana, `Ana ${tag}`, 7], // both names the log gave her are one line, under the name on file
      [dan, `Dan ${tag}`, 6],
      [ghost, "Ghost", 5], // no row: named as the log named them…
      [eve, "Eve", 3], // …and so is a row with an empty name, a line per name
      [eve, "Evie", 2],
      [ghost, "Unknown", 1], // and where the log gave no name either
    ]);
    assert.deepEqual(c.topTeamkillers.map((k) => [k.playerId, k.name, k.teamkills, k.kills]), [
      [ghost, "Ghost", 3, 5],
      [ana, `Ana ${tag}`, 2, 7],
      [eve, "Evie", 1, 2],
    ], "team killers only, each beside the kills of the same line");
  } finally {
    await pool.end();
  }
});

/*
 * The roster sampler must not credit score with no match open.
 *
 * The game keeps reporting last round's scoreboard between matches, and the career step diffs the
 * sample against the round's match line — which does not exist when there is no round. The delta
 * therefore collapsed to the FULL running score and was added once a minute, forever, to every
 * connected player's career. The memory store always guarded this; Postgres did not, so the two
 * stores disagreed and only the deployed one was wrong.
 */
test("postgres: a roster sample with no open match moves the clocks but never the score", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `sample-${tag}`, host: "10.0.0.9", port: 28900 + Math.floor(Math.random() * 90), password: "p" });
    const platformId = `765_sample_${tag}`;
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId, name: `Sampled ${tag}` });
    const sample = { platformId, role: 1, isSquadLead: true, level: 42, score: { combat: 300, offense: 200, defense: 100, support: 50 } };

    // Three ticks between rounds — the state a server sits in for minutes at a time.
    for (let i = 0; i < 3; i++) {
      await repo.stats.sampleRoster({ serverId: server.id, matchId: null, sampleSec: 60, players: [sample] });
    }
    const s = await repo.stats.get(p.id, server.id);
    assert.equal(s?.combat, 0, "no open match means no round to diff against, so no score is earned");
    assert.equal(s?.offense, 0);
    assert.equal(s?.defense, 0);
    assert.equal(s?.support, 0);
    // The clocks still run: they measure time observed, which is true with or without a round.
    assert.equal(s?.slSeconds, 180, "three minutes of squad leading did happen");
    assert.equal(s?.roleSeconds["1"], 180);
    assert.equal(s?.highestLevel, 42);
    assert.equal(s?.serverId, server.id, "and it landed on the server that was sampled");
  } finally {
    await pool.end();
  }
});

test("postgres repo: labelsByPlatformIds resolves a whole roster in one query", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const uniq = Math.random().toString(36).slice(2, 8);
    const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `pa_${uniq}`, name: "A" });
    const b = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `pb_${uniq}`, name: "B" });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: `pc_${uniq}`, name: "C" });
    await repo.playerTags.add({ playerId: a.id, label: "trusted", note: null, createdByName: "admin" });
    await repo.playerTags.add({ playerId: b.id, label: "seeder", note: null, createdByName: "admin" });
    await repo.playerTags.add({ playerId: b.id, label: "staff", note: null, createdByName: "admin" });

    // Count the statements this actually issues — the whole point of the method is that it is one
    // regardless of roster size, where the runners previously did two per player.
    let queries = 0;
    const counting = new pg.Pool({ connectionString: DB });
    const original = counting.query.bind(counting);
    (counting as unknown as { query: unknown }).query = (...args: unknown[]) => { queries += 1; return (original as (...a: unknown[]) => unknown)(...args); };
    const countingRepo = new PostgresRepository(counting);
    const map = await countingRepo.playerTags.labelsByPlatformIds([`pa_${uniq}`, `pb_${uniq}`, `pc_${uniq}`, `nope_${uniq}`]);
    await counting.end();

    assert.equal(queries, 1, `expected exactly one query for the whole roster, saw ${queries}`);
    assert.deepEqual(map.get(`pa_${uniq}`), ["trusted"]);
    assert.deepEqual(map.get(`pb_${uniq}`), ["seeder", "staff"], "ordered by created_at");
    assert.equal(map.has(`pc_${uniq}`), false, "tagless player absent");
    assert.equal(map.has(`nope_${uniq}`), false, "unknown platform id absent");

    // The empty roster must not hit the database at all.
    assert.equal((await repo.playerTags.labelsByPlatformIds([])).size, 0);
  } finally {
    await pool.end();
  }
});

test("postgres repo: feature presets upsert by (feature, name) case-insensitively and stay per-feature", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const uniq = Math.random().toString(36).slice(2, 8);
    const name = `Night ${uniq}`;

    const saved = await repo.featurePresets.save({ feature: "broadcast", name, config: { messages: ["a", "b"], intervalSec: 600 }, createdByName: "tester" });
    assert.equal((await repo.featurePresets.get("broadcast", name.toUpperCase()))?.id, saved.id, "name lookup is case-insensitive");
    assert.equal(await repo.featurePresets.get("mapvote", name), null, "features are separate namespaces");

    // Same name on ANOTHER feature is its own row; same name on the SAME feature replaces.
    const other = await repo.featurePresets.save({ feature: "mapvote", name, config: { pollHours: 3 }, createdByName: "tester" });
    assert.notEqual(other.id, saved.id);
    await repo.featurePresets.save({ feature: "broadcast", name: name.toLowerCase(), config: { messages: ["c"] }, createdByName: "tester2" });
    const list = (await repo.featurePresets.list("broadcast")).filter((p) => p.name.toLowerCase() === name.toLowerCase());
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]!.config.messages, ["c"]);

    assert.equal(await repo.featurePresets.remove(saved.id), true);
    assert.equal(await repo.featurePresets.remove(saved.id), false);
    await repo.featurePresets.remove(other.id);
  } finally {
    await pool.end();
  }
});

test("postgres repo: a config save leaves the legacy modules column (072's recovery record) untouched", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: `recov-${Math.random().toString(36).slice(2, 8)}`, host: "1.1.1.9", port: 28871, password: "p" });
    await repo.autosettings.upsertConfig(server.id, { timezone: "Europe/Berlin" });
    // A pre-072 install's module blob, exactly as the migration leaves it: translated onto rules,
    // kept in the column as the recovery record of what was translated.
    await pool.query(`UPDATE autosettings_config SET modules = '{"no_solo_tank":{"enabled":true}}'::jsonb WHERE server_id = $1`, [server.id]);

    const after = await repo.autosettings.upsertConfig(server.id, { timezone: "UTC", profiles: [{ name: "day", settings: {} }] });
    assert.equal(after.timezone, "UTC");
    assert.ok(!("modules" in after), "the retired blob never rides the row back into the app");
    const { rows } = await pool.query("SELECT modules FROM autosettings_config WHERE server_id = $1", [server.id]);
    assert.deepEqual(rows[0]!.modules, { no_solo_tank: { enabled: true } },
      "saving a config must not rewrite the recovery record — the column is unread AND unwritten");
  } finally {
    await pool.end();
  }
});

test("postgres repo: auto settings templates upsert by name (case-insensitive) and round-trip", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const uniq = Math.random().toString(36).slice(2, 8);
    const name = `Night rules ${uniq}`;
    const config = {
      timezone: "Europe/Berlin",
      profiles: [{ name: "night", spec: { start: "22:00", end: "06:00", teamDiffAbove: 10 }, settings: { autoBalanceEnabled: true }, moduleOverrides: { no_leader: true } }],
      modules: { no_leader: { enabled: true, dryRun: false, config: { minSquadSize: 3 } } },
    };

    const saved = await repo.autosettings.templates.save({ name, config: config as never, createdByName: "tester" });
    assert.ok(saved.id);
    assert.equal(saved.name, name);
    assert.equal((await repo.autosettings.templates.get(name.toUpperCase()))?.id, saved.id, "lookup is case-insensitive");
    assert.deepEqual((await repo.autosettings.templates.get(name))?.config, config, "config round-trips through jsonb intact");

    // Saving under the same name in a different case REPLACES the row, keeping one template.
    const replaced = await repo.autosettings.templates.save({ name: name.toLowerCase(), config: { ...config, timezone: "UTC" } as never, createdByName: "tester2" });
    assert.equal(replaced.name, name.toLowerCase());
    assert.equal((await repo.autosettings.templates.list()).filter((t) => t.name.toLowerCase() === name.toLowerCase()).length, 1);
    assert.equal((await repo.autosettings.templates.get(name))?.config.timezone, "UTC");

    assert.equal(await repo.autosettings.templates.remove(replaced.id), true);
    assert.equal(await repo.autosettings.templates.remove(replaced.id), false);
    assert.equal(await repo.autosettings.templates.get(name), null);
  } finally {
    await pool.end();
  }
});

test("postgres repo: watch provenance survives VIP toggles and clears on unwatch", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const uniq = Math.random().toString(36).slice(2, 8);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656119800${Date.now() % 1_000_000}1`, name: `Watched ${uniq}` });

    // Import-style: the original CRCON author/time land, not the caller/now.
    const on = await repo.playerFlags.set(player.id, { watchlist: true, watchReason: "repeat TK", watchBy: "OldAdmin", watchAt: "2024-05-01T10:00:00.000Z" }, { userId: null, name: "importer" });
    assert.equal(on.watchReason, "repeat TK");
    assert.equal(on.watchBy, "OldAdmin");
    assert.equal(on.watchAt, "2024-05-01T10:00:00.000Z");

    // A VIP change and an idempotent re-flag both keep the original story.
    await repo.playerFlags.set(player.id, { vip: true }, { userId: null, name: "someone-else" });
    const kept = await repo.playerFlags.set(player.id, { watchlist: true }, { userId: null, name: "someone-else" });
    assert.equal(kept.watchReason, "repeat TK");
    assert.equal(kept.watchBy, "OldAdmin");
    assert.equal(kept.watchAt, "2024-05-01T10:00:00.000Z");

    // A fresh watch-on with no details defaults to the acting user; unwatch clears everything.
    await repo.playerFlags.set(player.id, { watchlist: false }, { userId: null, name: "staff" });
    const fresh = await repo.playerFlags.set(player.id, { watchlist: true }, { userId: null, name: "staff" });
    assert.equal(fresh.watchBy, "staff");
    assert.ok(fresh.watchAt);
    assert.equal(fresh.watchReason, null);
    const off = await repo.playerFlags.set(player.id, { watchlist: false }, { userId: null, name: "staff" });
    assert.equal(off.watchReason, null);
    assert.equal(off.watchBy, null);
    assert.equal(off.watchAt, null);
    assert.equal(off.vip, true, "the VIP flag is untouched by unwatching");

    // The permanent history kept every spell: the import-era one (provenance synced by the
    // re-flag), closed by "staff"; and the fresh manual one, also closed. Nothing deleted.
    const hist = await repo.playerFlags.watchHistory(player.id);
    assert.equal(hist.length, 2);
    assert.ok(hist.every((h) => h.removedAt !== null), "all spells closed, none deleted");
    const imported2 = hist.find((h) => h.reason === "repeat TK");
    assert.ok(imported2, "the imported spell survives with its reason");
    assert.equal(imported2!.watchedBy, "OldAdmin");
    assert.equal(imported2!.removedBy, "staff");
  } finally {
    await pool.end();
  }
});

test("postgres repo: VIP pause round-trips, survives upsert, and lapses for the sweep", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: `vp ${Math.random().toString(36).slice(2, 8)}`, host: "h", port: 9, password: "x" });
    const pid = `7656119811${Date.now() % 1_000_000}`;
    await repo.vips.upsert({ serverId: server.id, playerId: pid, playerName: "P", comment: null, expiration: new Date(Date.now() + 86_400_000).toISOString(), createdByUserId: null, createdByName: "t" });

    const until = new Date(Date.now() + 3_600_000).toISOString();
    const paused = await repo.vips.setPause(server.id, pid, { until, reason: "TK spree", by: "Mod" });
    assert.equal(paused!.pausedUntil, until);
    assert.equal(paused!.pauseReason, "TK spree");
    assert.equal(paused!.pausedBy, "Mod");
    assert.equal(paused!.pauseMode, "running", "mode defaults to running");
    assert.ok(paused!.pausedAt, "pausedAt stamped by the store");

    // Banked mode round-trips, and a banked-frozen grant is invisible to the expiry sweep.
    const anchor = new Date(Date.now() - 7_200_000).toISOString();
    const banked = await repo.vips.setPause(server.id, pid, { until, reason: "TK spree", by: "Mod", mode: "banked", at: anchor });
    assert.equal(banked!.pauseMode, "banked");
    assert.equal(banked!.pausedAt, anchor);
    await repo.vips.upsert({ serverId: server.id, playerId: pid, playerName: "P", comment: null, expiration: new Date(Date.now() - 1000).toISOString(), createdByUserId: null, createdByName: "t" });
    assert.ok(!(await repo.vips.expired(new Date().toISOString())).some((v) => v.playerId === pid), "banked-frozen grant does not expire");
    await repo.vips.upsert({ serverId: server.id, playerId: pid, playerName: "P", comment: null, expiration: new Date(Date.now() + 86_400_000).toISOString(), createdByUserId: null, createdByName: "t" });
    await repo.vips.setPause(server.id, pid, { until, reason: "TK spree", by: "Mod" });

    // A grant/extension while paused must not touch the pause fields.
    await repo.vips.upsert({ serverId: server.id, playerId: pid, playerName: "P", comment: "seed reward", expiration: new Date(Date.now() + 2 * 86_400_000).toISOString(), createdByUserId: null, createdByName: "seeding" });
    const after = await repo.vips.get(server.id, pid);
    assert.equal(after!.pauseReason, "TK spree", "upsert preserved the pause");

    // Not lapsed yet; flip the clock into the past and the sweep sees it; clearing ends it.
    assert.ok(!(await repo.vips.pauseLapsed(new Date().toISOString())).some((v) => v.playerId === pid));
    await repo.vips.setPause(server.id, pid, { until: new Date(Date.now() - 1000).toISOString(), reason: "TK spree", by: "Mod" });
    assert.ok((await repo.vips.pauseLapsed(new Date().toISOString())).some((v) => v.playerId === pid));
    const cleared = await repo.vips.setPause(server.id, pid, null);
    assert.equal(cleared!.pausedUntil, null);
    assert.equal(cleared!.pauseReason, null);
    assert.equal(await repo.vips.setPause(server.id, "no-such-player", null), null);
    await repo.vips.remove(server.id, pid);

    // Seeding progress batch: one statement for a tick's roster, duplicates pre-summed so the
    // upsert never touches a row twice, and it stacks on top of the single-row form.
    await repo.seeding.addProgress(server.id, "seed_a", "Alice", 30);
    await repo.seeding.addProgressMany(server.id, [
      { playerId: "seed_a", playerName: null, deltaSeconds: 30 },
      { playerId: "seed_b", playerName: "Bob", deltaSeconds: 30 },
      { playerId: "seed_b", playerName: "Bob", deltaSeconds: 15 }, // duplicate in one batch
    ]);
    await repo.seeding.addProgressMany(server.id, []); // empty batch is a no-op, not an error
    const progress = new Map((await repo.seeding.listProgress(server.id)).map((r) => [r.playerId, r]));
    assert.equal(progress.get("seed_a")!.seconds, 60, "batch adds on top of the single-row form");
    assert.equal(progress.get("seed_a")!.playerName, "Alice", "a null name in the batch keeps the stored one");
    assert.equal(progress.get("seed_b")!.seconds, 45, "duplicate ids in one batch are summed");
    await repo.seeding.clearProgress(server.id);

    // Playtime reconciliation: raises a rollup to its recorded session history, never lowers it.
    // Created AT their historical era (the import backdates first_seen the same way) — the
    // last-seen repair below can only lower onto evidence at or after first_seen.
    const settled = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `settle_${Date.now()}`, name: "Settler", ts: "2022-01-01T10:00:00.000Z" });
    await repo.sessions.importOne({ playerId: settled.id, serverId: server.id, connectedAt: "2022-01-01T10:00:00.000Z", disconnectedAt: "2022-01-01T11:00:00.000Z", durationSec: 3600 });
    assert.equal(await repo.stats.settlePlaytimeFromSessions(server.id, null), 1, "one player raised");
    assert.equal((await repo.stats.get(settled.id, server.id))?.playtimeSec, 3600);
    await repo.stats.bump(settled.id, server.id, { playtimeSec: 500 }); // live-era seconds on top
    assert.equal(await repo.stats.settlePlaytimeFromSessions(server.id, null), 0, "raise-only: a richer rollup is untouched");
    assert.equal((await repo.stats.get(settled.id, server.id))?.playtimeSec, 4100);

    // Last-seen repair: a bogus "sighting" (an upsert with no timestamp — what the old import
    // did) bumps last_seen to now, but their only evidence is the 2022 session, so the repair
    // lowers them back onto it.
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: settled.platformId, name: "" });
    // Before repairing: the drift report names them and shows what the evidence actually says,
    // so an operator can recognise their own player rather than trusting a bare count.
    const drift = await repo.players.lastSeenDrift(50);
    const drifted = drift.sample.find((r) => r.id === settled.id);
    assert.ok(drift.total >= 1 && drifted, "the bumped player shows up as drifted");
    assert.equal(drifted.best, "2022-01-01T11:00:00.000Z", "the evidence is their last session");
    assert.equal(drifted.lastSessionEnd, "2022-01-01T11:00:00.000Z");
    assert.ok(drifted.lastSeen > drifted.best, "and the stored clock outruns it");
    assert.ok((await repo.players.settleLastSeenFromEvidence()) >= 1, "the sighting-less player is lowered");
    assert.equal((await repo.players.findById(settled.id))?.lastSeen, "2022-01-01T11:00:00.000Z");
    assert.ok(!(await repo.players.lastSeenDrift(50)).sample.some((r) => r.id === settled.id), "repaired players leave the report");

    // The repair walks the table in platform_id windows rather than as one whole-table UPDATE,
    // because the single statement locked rows in heap order and deadlocked against live ingest,
    // which locks them sorted by platform_id. Windowing is the part that can silently under-repair
    // — a paging bug skips players and nobody notices, because the count still looks plausible — so
    // this drifts more players than fit in one window and demands every one of them back.
    const wide = `wide_${Date.now()}_`;
    const many = Array.from({ length: 620 }, (_, i) => ({
      game: "hll", platform: "steam", platformId: `${wide}${String(i).padStart(4, "0")}`, name: `Wide ${i}`, ts: "2021-03-04T05:06:07.000Z",
    }));
    await repo.players.upsertMany(many);
    // A sighting with no timestamp is the bogus bump the repair exists to undo: it drags last_seen
    // to now while the evidence trail still says 2021.
    await repo.players.upsertMany(many.map((m) => ({ ...m, ts: undefined })));
    const before = await repo.players.lastSeenDrift(1);
    assert.ok(before.total >= 620, `all ${620} show as drifted before the sweep`);
    assert.ok((await repo.players.settleLastSeenFromEvidence()) >= 620, "the sweep repairs across window boundaries");
    // The four that matter are the window edges: the first of the run, the last of window one, the
    // first of window two, and the last of the run. A paging bug shows up as exactly one of these
    // still carrying the bogus clock.
    for (const i of [0, 499, 500, 619]) {
      const at = await repo.players.findByPlatformId(`${wide}${String(i).padStart(4, "0")}`);
      assert.equal(at?.lastSeen, "2021-03-04T05:06:07.000Z", `player ${i} was lowered (window boundary)`);
    }

    // Search relevance: the exact name outranks fresher substring matches.
    const uid = Date.now();
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: `rank_a_${uid}`, name: "Pepper", ts: "2025-05-14T00:00:00.000Z" });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: `rank_b_${uid}`, name: "Pepper8560", ts: new Date().toISOString() });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: `rank_c_${uid}`, name: "Sgt Pepper", ts: new Date().toISOString() });
    const ranked = await repo.players.directory({ q: "pepper", limit: 10 });
    assert.deepEqual(ranked.map((r) => r.name).slice(0, 3), ["Pepper", "Pepper8560", "Sgt Pepper"], "exact, then prefix, then contains");

    // The new only-filters, against the same rows.
    await repo.playerBans.create({ game: "hll", playerId: `rank_a_${uid}`, playerName: "Pepper", kind: "perma", reason: "r", scope: { mode: "all" }, createdByName: "t" });
    const blOnly = await repo.players.directory({ q: "pepper", permaBannedOnly: true, limit: 10 });
    assert.deepEqual(blOnly.map((r) => r.name), ["Pepper"]);
    // An imported crcon_ban row is an archive, not a live ban — it must NOT satisfy the filter.
    await repo.crconBans.upsert({ serverId: server.id, playerId: `rank_c_${uid}`, playerName: "Sgt Pepper", type: "perma", reason: "x", expiresAt: null, author: "t" });
    const pbOnly = await repo.players.directory({ q: "pepper", permaBannedOnly: true, limit: 10 });
    assert.deepEqual(pbOnly.map((r) => r.name), ["Pepper"], "the archive row does not count as banned");
  } finally {
    await pool.end();
  }
});

test("postgres repo: VIP presets seed with the migration and round-trip CRUD", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    // 008 seeds the starter buttons: add gets "Help skip queue" first, pause starts at "1 day".
    const seeded = await repo.vipPresets.list();
    assert.deepEqual(seeded.filter((p) => p.kind === "add").map((p) => p.label), ["Help skip queue", "1 day", "1 week", "1 month"]);
    assert.deepEqual(seeded.filter((p) => p.kind === "pause").map((p) => p.label), ["1 day", "1 week", "1 month"]);

    const created = await repo.vipPresets.create({ kind: "pause", label: "2 hours", days: 0, hours: 2, sortOrder: 9 });
    assert.equal(created.kind, "pause");
    assert.equal(created.hours, 2);
    const patched = await repo.vipPresets.update(created.id, { label: "3 hours", hours: 3 });
    assert.equal(patched!.label, "3 hours");
    assert.equal(patched!.hours, 3);
    assert.equal(patched!.days, 0, "untouched fields survive a partial patch");
    assert.ok((await repo.vipPresets.list()).some((p) => p.id === created.id));
    assert.equal(await repo.vipPresets.remove(created.id), true);
    assert.equal(await repo.vipPresets.remove(created.id), false);
  } finally {
    await pool.end();
  }
});

/*
 * Three failure shapes seen in production logs, all in the ingest write path. Each one aborted a
 * whole batch: a roster that lists the same platform id twice made the sampler's single-statement
 * upsert illegal ("ON CONFLICT DO UPDATE command cannot affect row a second time"); concurrent
 * openers of a round collided on the one-open-match partial index; and an imported round with no
 * end time collided with the live open round on that same index. The deadlock fix (sorted batches)
 * can't be proven deterministically, so this covers the two errors that can.
 */
test("postgres: ingest writes survive duplicate roster rows and open-match collisions", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `dup-${tag}`, host: "1.1.1.9", port: 28870, password: "p" });
    const platformId = `765_dup_${tag}`;
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId, name: "Twice" });

    // The same player listed twice in one roster read — reconnects do this. One statement must
    // fold it to one row (last entry wins), not blow up the whole sample.
    const match = await repo.matches.open({ serverId: server.id, map: "FOY", startedAt: "2026-08-01T10:00:00.000Z" });
    await repo.stats.sampleRoster({
      serverId: server.id, matchId: match.id, sampleSec: 60,
      players: [
        { platformId, name: "Twice", role: 0, isSquadLead: false, score: { combat: 100, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0 } },
        { platformId, name: "Twice", role: 0, isSquadLead: true, score: { combat: 150, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0 } },
      ],
    });
    const stats = await repo.stats.get(player.id, server.id);
    assert.equal(stats?.combat, 150, "the duplicated row counts once, last entry wins");
    assert.equal(stats?.slSeconds, 60, "one sample interval of leading, not two");

    // Two workers racing to open a round (a runner restart overlapping its replacement) must not
    // trip matches_one_open_idx — the advisory lock serializes them; last opener's round is open.
    const [a, b] = await Promise.all([
      repo.matches.open({ serverId: server.id, map: "FOY", startedAt: "2026-08-01T11:00:00.000Z" }),
      repo.matches.open({ serverId: server.id, map: "FOY", startedAt: "2026-08-01T11:00:01.000Z" }),
    ]);
    assert.ok(a.id && b.id);
    const open = await repo.matches.getOpen(server.id);
    assert.ok(open, "exactly one round is left open");

    // Re-opening the SAME round (same server + started_at) reuses the row and re-opens it, rather
    // than returning a closed row or minting a duplicate.
    const again = await repo.matches.open({ serverId: server.id, map: "STMEREEGLISE", startedAt: open!.startedAt });
    assert.equal(again.id, open!.id);
    assert.equal(again.endedAt, null);
    assert.equal(again.map, "STMEREEGLISE");

    // An imported historical round with no end time, while live ingest already holds the open
    // round: the import loses silently instead of raising a duplicate-key error mid-batch.
    const imported = await repo.matches.importOne({ serverId: server.id, map: "KURSK", startedAt: "2026-08-01T12:00:00.000Z", endedAt: null, winner: null, result: null });
    assert.equal(imported, false, "the backfill yields to the live open round");
    assert.equal((await repo.matches.getOpen(server.id))?.id, open!.id, "the live round is untouched");
  } finally {
    await pool.end();
  }
});

/*
 * Administration → Staff activity is the record: it must keep everyone who ever acted, and keep
 * them APART. Departed accounts all carry actor_user_id NULL, so grouping the rollup on the id
 * alone folded every one of them into a single row wearing whichever name sorted highest — two
 * former admins became one person who appeared to have done both their jobs. The memory store
 * keyed on the name and never had the bug, which is exactly why this test lives here.
 */
test("postgres: the staff rollup keeps departed admins apart, and merges a renamed one", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    await pool.query("DELETE FROM audit");

    const stay = await repo.users.create({ username: "stay_" + Math.random().toString(36).slice(2), passwordHash: "x" });
    const goneA = await repo.users.create({ username: "goneA_" + Math.random().toString(36).slice(2), passwordHash: "x" });
    const goneB = await repo.users.create({ username: "goneB_" + Math.random().toString(36).slice(2), passwordHash: "x" });

    await repo.audit.create({ actorUserId: goneA.id, actorName: "Ada", action: "player.kick", summary: "Ada kicked" });
    await repo.audit.create({ actorUserId: goneA.id, actorName: "Ada", action: "player.ban", summary: "Ada banned" });
    await repo.audit.create({ actorUserId: goneB.id, actorName: "Bo", action: "player.kick", summary: "Bo kicked" });
    // One person who renamed mid-window and is STILL here: two stored names, one id, one row.
    await repo.audit.create({ actorUserId: stay.id, actorName: "Cy", action: "player.kick", summary: "Cy kicked" });
    await repo.audit.create({ actorUserId: stay.id, actorName: "Cyrus", action: "player.kick", summary: "Cyrus kicked" });

    await repo.users.remove(goneA.id);
    await repo.users.remove(goneB.id);

    const rows = await repo.audit.staffSummary({ actor: "human" });
    const byName = Object.fromEntries(rows.map((r) => [r.actorName, r.count]));
    assert.equal(byName.Ada, 2, "the departed admin keeps her own two actions");
    assert.equal(byName.Bo, 1, "and does not absorb the other departed admin's");
    assert.equal(rows.filter((r) => r.actorUserId == null).length, 2, "two people who left are two rows");
    // The rename is the opposite case: still one account, so still one row carrying both actions.
    const present = rows.filter((r) => r.actorUserId === stay.id);
    assert.equal(present.length, 1, "a rename does not split a present person in two");
    assert.equal(present[0]!.count, 2);
    assert.deepEqual(present[0]!.byAction, { "player.kick": 2 });
  } finally {
    await pool.end();
  }
});

/*
 * ONE VOLLEY, ONE ACTION — over real SQL. The Staff activity leaderboard reads this rollup, and
 * counted raw it showed a group message as one action per recipient ("player.message ×1683" on
 * the card, ×15 on the same person's collapsed profile). The volley key is the UTC minute, so
 * timestamps are pinned after insert to prove both halves: same minute collapses, a second
 * volley in another minute is a second act.
 */
test("postgres: the staff rollup counts a bulk volley once per UTC minute and skips continuations", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const tag = Math.random().toString(36).slice(2, 8);
  const actor = `Volley_${tag}`;
  try {
    await repo.migrate();
    // A real account: rows are stamped automated at write time from actorUserId == null, and the
    // leaderboard reads actor:"human" — a null actor here would test the machinery view instead.
    const staffer = await repo.users.create({ username: `volley_${tag}`, passwordHash: "x" });
    const mk = (summary: string, data: Record<string, unknown> | null, action = "player.message") =>
      repo.audit.create({ actorUserId: staffer.id, actorName: actor, action, summary, data });
    for (const t of ["p1", "p2", "p3"]) await mk(`v1-${tag}`, { playerId: t, message: "m", bulk: true });
    for (const t of ["p1", "p2"]) await mk(`v2-${tag}`, { playerId: t, message: "m2", bulk: true });
    await mk(`solo-${tag}`, { playerId: "p9", message: "hi" });
    await mk(`cont-${tag}`, { playerId: "p1", continues: "req-1" }, "player.tempban");
    // Pin the clocks: volley one at 10:00, volley two at 10:01 — different minutes, so two acts.
    await pool.query(`UPDATE audit SET ts = '2026-09-01T10:00:30Z' WHERE summary = $1`, [`v1-${tag}`]);
    await pool.query(`UPDATE audit SET ts = '2026-09-01T10:01:05Z' WHERE summary = $1`, [`v2-${tag}`]);

    const me = (await repo.audit.staffSummary({ actor: "human" })).find((r) => r.actorName === actor);
    assert.equal(me?.byAction["player.message"], 3, "two volleys and a solo message are three acts — never six rows");
    assert.equal(me?.byAction["player.tempban"], undefined, "a continuation is not a new act");
    assert.equal(me?.count, 3);
  } finally {
    await pool.end();
  }
});

/*
 * The library migration has to move live configuration, not just create tables.
 *
 * Every server's inline profiles are lifted into shared records and the config rewritten to point
 * at them, so this checks the part that would be silently destructive: two servers that had the
 * SAME set become one library row (that dedupe is the whole point of the change), two that merely
 * shared a NAME keep both pools (merging them would change what a server offers), a spec carrying
 * nothing becomes no schedule rather than an empty one, and the starter rows lose any name a real
 * config already claimed.
 */
test("postgres: migration 029 re-files players by where they were actually seen", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const vn = await repo.servers.create({ name: `vn-${tag}`, host: "10.8.0.1", port: 28871, password: "p", game: "hllv" } as never);
    const ww2 = await repo.servers.create({ name: `ww-${tag}`, host: "10.8.0.2", port: 28872, password: "p" });

    // Three players the pre-column era would have stamped 'hll': one with Vietnam stats, one with
    // only a Vietnam session, one holding a Vietnam VIP grant and nothing else. Plus a genuine WW2
    // player who must NOT move.
    const byStats = await repo.players.upsert({ game: "hllv", platform: "epic", platformId: `vnst-${tag}`, name: "Stats" });
    const bySession = await repo.players.upsert({ game: "hllv", platform: "epic", platformId: `vnse-${tag}`, name: "Session" });
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: `vnvip-${tag}`, name: "Vip" });
    const wwPlayer = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765ww-${tag}`, name: "Ww" });
    await repo.stats.bump(byStats.id, vn.id, { kills: 1 });
    await repo.stats.bump(wwPlayer.id, ww2.id, { kills: 1 });
    await repo.sessions.importOne({ playerId: bySession.id, serverId: vn.id, connectedAt: "2026-08-13T01:00:00Z", disconnectedAt: "2026-08-13T02:00:00Z", durationSec: 3600 });
    await repo.vips.upsert({ serverId: vn.id, playerId: `vnvip-${tag}`, playerName: "Vip", comment: null, expiration: null, createdByUserId: null, createdByName: "t" });

    // The identity bug's casualties: before the EOS fix, a Steam player on the Vietnam server was
    // keyed by their Steam64, merging Vietnam sightings into a WW2-namespace row. Both shapes of
    // that damage must stay 'hll' — the row that ALSO has real WW2 evidence (flipping it would
    // break its WW2 VIP grants), and even the Vietnam-only one, because a Steam64 is an id the
    // Vietnam server itself will not act on; the corrected keying gives them a fresh EOS row.
    const mergedSteam = `7650${Date.now()}`;
    const vnOnlySteam = `7651${Date.now()}`;
    const merged = await repo.players.upsert({ game: "hll", platform: "steam", platformId: mergedSteam, name: "Merged" });
    const vnOnly = await repo.players.upsert({ game: "hll", platform: "steam", platformId: vnOnlySteam, name: "VnOnly" });
    await repo.stats.bump(merged.id, ww2.id, { kills: 2 });
    await repo.sessions.importOne({ playerId: merged.id, serverId: vn.id, connectedAt: "2026-08-13T03:00:00Z", disconnectedAt: "2026-08-13T04:00:00Z", durationSec: 3600 });
    await repo.sessions.importOne({ playerId: vnOnly.id, serverId: vn.id, connectedAt: "2026-08-13T03:00:00Z", disconnectedAt: "2026-08-13T04:00:00Z", durationSec: 3600 });

    // Rewind to the pre-column state migration 028 found: every row stamped 'hll'.
    await pool.query("UPDATE players SET game = 'hll' WHERE platform_id LIKE $1", [`%${tag}`]);

    // Replay the refile exactly as a deploy would run it.
    await pool.query("DELETE FROM schema_migrations WHERE id = '029_refile_players_by_sighting'");
    await pool.query(MIGRATIONS.find((m: { id: string }) => m.id === "029_refile_players_by_sighting")!.sql);

    const gameOf = async (pid: string) =>
      (await pool.query("SELECT game FROM players WHERE platform_id = $1", [pid])).rows[0]?.game;
    assert.equal(await gameOf(`vnst-${tag}`), "hllv", "stats sighting re-files");
    assert.equal(await gameOf(`vnse-${tag}`), "hllv", "session sighting re-files");
    assert.equal(await gameOf(`vnvip-${tag}`), "hllv", "a VIP grant re-files");
    assert.equal(await gameOf(`765ww-${tag}`), "hll", "a WW2 player stays put");
    assert.equal(await gameOf(mergedSteam), "hll", "a Steam row with both games' evidence keeps its WW2 identity");
    assert.equal(await gameOf(vnOnlySteam), "hll", "a Steam64-keyed row never becomes hllv — Vietnam cannot act on that id");
  } finally {
    await pool.end();
  }
});

test("postgres: the map-set migration lifts inline profiles into the shared library", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();

    // Rewind to the state the lift runs against: drop the library and put inline profiles back.
    await pool.query("DELETE FROM mapvote_config");
    await pool.query("DROP TABLE IF EXISTS map_sets, vote_schedules");
    const a = await repo.servers.create({ name: "Warfare", host: "10.9.0.1", port: 28011, password: "p" });
    const b = await repo.servers.create({ name: "Offensive", host: "10.9.0.2", port: 28012, password: "p" });
    const inline = (rows: unknown[]) => JSON.stringify(rows);
    await pool.query("INSERT INTO mapvote_config (server_id, profiles) VALUES ($1, $2::jsonb)", [a.id, inline([
      { name: "friday", spec: { daysOfWeek: ["fri"] }, pool: { dayCount: 4 } },
      { name: "always", spec: {}, pool: { dayCount: 3 } },
    ])]);
    await pool.query("INSERT INTO mapvote_config (server_id, profiles) VALUES ($1, $2::jsonb)", [b.id, inline([
      { name: "friday", spec: { daysOfWeek: ["fri"] }, pool: { dayCount: 4 } },   // identical → one row
      { name: "night", spec: { start: "00:00", end: "07:00" }, pool: { dayCount: 9 } }, // clashes with the seed
    ])]);

    // Re-run the library migrations, as a fresh database would — including the one that gives a set
    // its game, because this rewind DROPPED the table and rebuilds it from scratch.
    for (const id of ["015_map_set_library", "016_map_set_library_seed", "027_map_sets_belong_to_a_game"]) {
      await pool.query("DELETE FROM schema_migrations WHERE id = $1", [id]);
      await pool.query(MIGRATIONS.find((m: { id: string }) => m.id === id)!.sql);
    }

    const names = (await repo.mapSets.list()).map((s) => s.name);
    assert.equal(names.filter((n) => n === "friday").length, 1, "the same set on two servers is one library row");
    assert.ok(names.includes("always"));
    // The live "night" keeps its own name and its own maps; the starter row of that name loses.
    assert.equal((await repo.mapSets.findByName("night"))!.pool.dayCount, 9, "the community's own set won the name");
    assert.ok(names.includes("dday"), "the starter rows that clashed with nothing are still seeded");

    // A spec with nothing in it is the ABSENCE of a schedule, not an empty one.
    const schedules = (await repo.voteSchedules.list()).map((s) => s.name);
    assert.ok(!schedules.includes("always"));
    assert.ok(schedules.includes("friday"));

    // Both servers now point at library rows, in their original order, and still resolve.
    const cfgA = (await repo.mapVote.getConfig(a.id))!;
    assert.deepEqual(cfgA.profileLinks, [{ mapSet: "friday", schedule: "friday" }, { mapSet: "always", schedule: null }]);
    assert.equal(cfgA.profiles.length, 2);
    assert.deepEqual((cfgA.profiles[0] as { pool: { dayCount: number } }).pool, { dayCount: 4 });
    const cfgB = (await repo.mapVote.getConfig(b.id))!;
    assert.deepEqual(cfgB.profileLinks.map((l) => l.mapSet), ["friday", "night"]);

    // And the shared row is genuinely shared: one edit moves both servers.
    // A set carries its game through the round trip, and the list narrows to one game's sets. The
    // starter library is WW2 because that is the only game this app ran until HLL: Vietnam.
    assert.ok((await repo.mapSets.list()).every((s) => s.game === "hll"), "the seeded library is WW2");
    const nam = await repo.mapSets.create({ name: `nam-${Math.random().toString(36).slice(2, 8)}`, game: "hllv", pool: { modeBuckets: [] } });
    assert.equal(nam.game, "hllv");
    assert.deepEqual((await repo.mapSets.list("hllv")).map((s) => s.id), [nam.id], "one game's sets only");
    assert.ok(!(await repo.mapSets.list("hll")).some((s) => s.id === nam.id));
    assert.equal((await repo.mapSets.update(nam.id, { game: "hll" }))!.game, "hll", "a set can be relabelled");

    const friday = (await repo.mapSets.findByName("friday"))!;
    await repo.mapSets.update(friday.id, { pool: { dayCount: 7 } });
    for (const id of [a.id, b.id]) {
      const cfg = (await repo.mapVote.getConfig(id))!;
      assert.equal((cfg.profiles[0] as { pool: { dayCount: number } }).pool.dayCount, 7);
    }
  } finally {
    await pool.end();
  }
});

/*
 * Admin-cam sorting lives in SQL, so the SQL is what has to be right — and the two halves that are
 * easy to get wrong there are the open session (no exit, no duration) and the one-open-per-player
 * guarantee the pairing depends on.
 */
test("postgres: admin cam pairs sessions, keeps open ones sortable, and refuses a second", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    await pool.query("DELETE FROM admin_cam_sessions");
    const a = await repo.servers.create({ name: "Alpha", host: "10.8.0.1", port: 28011, password: "p" });
    const b = await repo.servers.create({ name: "Bravo", host: "10.8.0.2", port: 28012, password: "p" });
    const jane = await repo.players.upsert({ game: "hll", platformId: "76561190000000601", name: "Jane", platform: "steam" });
    const bo = await repo.players.upsert({ game: "hll", platformId: "76561190000000602", name: "Bo", platform: "steam" });
    const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();

    await repo.adminCam.open({ serverId: a.id, playerId: jane.id, playerName: "Jane", at: T(0) });
    // A replayed log line — the worker re-reads the last few seconds every poll — must not open a
    // second overlapping session, or the next exit would close the wrong one.
    await repo.adminCam.open({ serverId: a.id, playerId: jane.id, playerName: "Jane", at: T(1) });
    assert.equal(await repo.adminCam.count({ serverId: a.id }), 1);
    assert.equal(await repo.adminCam.close({ serverId: a.id, playerId: jane.id, playerName: "Jane", at: T(5) }), 300);
    // An exit with no matching entry is dropped, not stored as a zero-length visit.
    assert.equal(await repo.adminCam.close({ serverId: a.id, playerId: jane.id, playerName: "Jane", at: T(6) }), null);

    // importOne: a COMPLETE visit, the way the CRCON archive importer writes history. Its whole
    // reason to exist is that replaying open()+close() over an archive duplicates: the first pair
    // is already closed, so a second apply finds nothing open, starts a new visit and closes it.
    // Keyed on the enter instant instead, so re-applying an archive repairs rather than doubles —
    // and re-applying is the normal retry workflow, not an edge case.
    assert.equal(await repo.adminCam.importOne({ serverId: a.id, playerId: bo.id, playerName: "Bo", enteredAt: T(100), exitedAt: T(107), durationSec: 420 }), true);
    assert.equal(await repo.adminCam.importOne({ serverId: a.id, playerId: bo.id, playerName: "Bo", enteredAt: T(100), exitedAt: T(107), durationSec: 420 }), false, "the same visit twice is one row");
    // An id-less line (older CRCON eras logged camera without one) dedupes on the NAME, matching
    // what open/close already do — otherwise every re-apply would stack another nameless visit.
    assert.equal(await repo.adminCam.importOne({ serverId: a.id, playerId: null, playerName: "Ghost", enteredAt: T(110), exitedAt: T(112), durationSec: 120 }), true);
    assert.equal(await repo.adminCam.importOne({ serverId: a.id, playerId: null, playerName: "Ghost", enteredAt: T(110), exitedAt: T(112), durationSec: 120 }), false, "nameless visits dedupe on the name");
    // The same instant on ANOTHER server is a different visit — two servers can be watched at once.
    assert.equal(await repo.adminCam.importOne({ serverId: b.id, playerId: bo.id, playerName: "Bo", enteredAt: T(100), exitedAt: T(107), durationSec: 420 }), true);
    await pool.query("DELETE FROM admin_cam_sessions WHERE entered_at >= $1", [T(100)]);

    await repo.adminCam.open({ serverId: b.id, playerId: jane.id, playerName: "Jane", at: T(10) });
    await repo.adminCam.close({ serverId: b.id, playerId: jane.id, playerName: "Jane", at: T(40) });
    await repo.adminCam.open({ serverId: a.id, playerId: bo.id, playerName: "Bo", at: T(50) });

    // NULLS LAST in BOTH directions: an open session has no duration and must not sort as zero.
    const longest = await repo.adminCam.list({ sort: "duration", dir: "desc" });
    assert.deepEqual(longest.map((s) => s.durationSec), [1800, 300, null]);
    const shortest = await repo.adminCam.list({ sort: "duration", dir: "asc" });
    assert.deepEqual(shortest.map((s) => s.durationSec), [300, 1800, null]);

    // By server NAME, not id — the id sorts to nothing a reader recognises.
    const byServer = await repo.adminCam.list({ sort: "server", dir: "asc" });
    assert.equal(byServer[0]!.serverId, a.id, "Alpha before Bravo");
    const byWho = await repo.adminCam.list({ sort: "who", dir: "asc" });
    assert.equal(byWho[0]!.playerName, "Bo");

    // Scope: an empty allow-list means "nothing", never "everything".
    assert.equal(await repo.adminCam.count({ serverIds: [] }), 0);
    assert.equal(await repo.adminCam.count({ serverIds: [b.id] }), 1);
    assert.equal(await repo.adminCam.count({ playerId: jane.id }), 2);

    // The record outlives the player row: deleting the account must not erase who was watching.
    await pool.query("DELETE FROM players WHERE id = $1", [bo.id]);
    const survivors = await repo.adminCam.list({ q: "bo" });
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0]!.playerId, null);
    assert.equal(survivors[0]!.playerName, "Bo", "the name is the durable record");

    // The de-duplication has to hold for a line with NO resolvable player id too, which is routine
    // here — the game log hands back corrupted ids often enough that the kill parser carries its own
    // repair for them. The one-open-per-(server, player) unique index cannot enforce this on its
    // own, because Postgres treats NULLs as distinct: every re-read of the poll window inserted
    // another open session, and the matching exit could only ever close one of them, so the rest
    // stayed on the history as permanent "still in cam" ghosts.
    await repo.adminCam.open({ serverId: b.id, playerId: null, playerName: "Ghost", at: T(20) });
    await repo.adminCam.open({ serverId: b.id, playerId: null, playerName: "Ghost", at: T(21) });
    assert.equal((await repo.adminCam.list({ q: "ghost" })).length, 1, "an id-less replay opens ONE session");
    // A different nameless admin on the same server is a different session, not a duplicate — and
    // closing one must not close the other.
    await repo.adminCam.open({ serverId: b.id, playerId: null, playerName: "Wraith", at: T(22) });
    assert.equal(await repo.adminCam.close({ serverId: b.id, playerId: null, playerName: "Ghost", at: T(25) }), 300);
    assert.equal((await repo.adminCam.list({ q: "wraith" }))[0]!.exitedAt, null, "Ghost's exit left Wraith alone");

    // The notification switch round-trips and defaults to silent.
    assert.equal(await repo.adminCam.getConfig(a.id), null);
    const cfg = await repo.adminCam.setConfig(a.id, { notifyEnabled: true });
    assert.equal(cfg.notifyEnabled, true);
    assert.match(cfg.enterMessage, /admin/i, "an unset message falls back to the shared default");
  } finally {
    await pool.end();
  }
});

/*
 * The signature config is a singleton — one row for the whole community — and the CHECK on a
 * boolean primary key is what enforces that. Worth a test because "somehow there are two rows and
 * half the servers read the old one" is a failure that would take a long afternoon to find.
 */
test("postgres: signature config is one row, patches merge, and junk actions never round-trip", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();

    // The migration seeds the row, so a fresh install already answers rather than returning null
    // and pushing that case onto the action path, mid-kick.
    const seeded = await repo.signatures.get();
    assert.match(seeded.staffLine, /\{staff\}/);
    assert.deepEqual(seeded.actions, {});

    await repo.signatures.set({ customLine: "Appeal at discord.gg/lynx" });
    // A patch touching one field leaves the others alone.
    const after = await repo.signatures.get();
    assert.equal(after.customLine, "Appeal at discord.gg/lynx");
    assert.match(after.staffLine, /\{staff\}/, "the untouched line survived");

    // An action a player never reads is dropped by the store, not just by the route.
    await repo.signatures.set({ actions: { kick: { staff: true, custom: true }, switch: { staff: true } } as never });
    assert.deepEqual(Object.keys((await repo.signatures.get()).actions), ["kick"]);

    // Still exactly one row, whatever the writes did.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM signature_config");
    assert.equal(rows[0].n, 1);
    await assert.rejects(pool.query("INSERT INTO signature_config (id) VALUES (false)"), /violates check constraint|duplicate key/);
  } finally {
    await pool.end();
  }
});

test("postgres: economy — cap clamp, overdraft CHECK, ref replay, and jsonb config over defaults", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const id = "d_" + Math.random().toString(36).slice(2);

    // The apply transaction: ledger row + cached balance move together.
    const a = await repo.economy.apply({ discordId: id, delta: 100, reason: "seed", discordName: "Alpha" });
    assert.equal(a.member.balance, 100);
    assert.equal((await repo.economy.member(id))?.discordName, "Alpha");

    // Trim at the cap — the row records the applied delta.
    const b = await repo.economy.apply({ discordId: id, delta: 100, reason: "claim" }, { maxBalance: 150 });
    assert.equal(b.member.balance, 150);
    assert.equal(b.entry.delta, 50);

    // Overdraft refuses in the store; the CHECK constraint is the last line, and the balance and
    // ledger stay consistent after the rejection.
    await assert.rejects(() => repo.economy.apply({ discordId: id, delta: -151, reason: "overdraft" }));
    assert.equal((await repo.economy.member(id))?.balance, 150);
    const sum = (await repo.economy.ledger(id, { limit: 100 })).reduce((s, r) => s + r.delta, 0);
    assert.equal(sum, 150, "ledger still explains the balance exactly");

    // The unique ref index makes a replay a no-op — the second call gets the FIRST row back.
    const ref = "buy_" + id;
    const first = await repo.economy.apply({ discordId: id, delta: -25, reason: "purchase", ref });
    const replay = await repo.economy.apply({ discordId: id, delta: -25, reason: "purchase", ref });
    assert.equal(first.applied, true);
    assert.equal(replay.applied, false);
    assert.equal(replay.entry.id, first.entry.id);
    assert.equal(replay.member.balance, 125);

    // Claim derivation across periods.
    await repo.economy.apply({ discordId: id, delta: 10, reason: "daily", ref: `claim:daily:${id}:2026-08-11` });
    await repo.economy.apply({ discordId: id, delta: 10, reason: "daily", ref: `claim:daily:${id}:2026-08-12` });
    assert.equal((await repo.economy.lastEntryWithRefPrefix(id, `claim:daily:${id}:`))?.ref, `claim:daily:${id}:2026-08-12`);

    // Config: stored jsonb merges over defaults, so a document written before a setting existed
    // still answers with that setting's default.
    const cfg = await repo.economy.setConfig({
      currencyName: "Gold Coins",
      offers: [{ id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "servers", serverIds: ["s1"] }, enabled: true, roleIds: [] }],
    });
    assert.equal(cfg.currencyName, "Gold Coins");
    assert.deepEqual(cfg.offers[0]?.scope, { mode: "servers", serverIds: ["s1"] }, "offer scope survives jsonb");
    assert.equal(cfg.claims.monthly.max, 525, "untouched sections keep defaults");
  } finally {
    await pool.end();
  }
});

test("postgres: one Discord id fans out to a player row per game, and findPlayers sees them all", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const discordId = "9" + Date.now();
    // Same human, one row per game's id namespace (the HLL:V shape from packages/games).
    const ww2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "fp_" + discordId, name: "Fanout WW2" });
    const viet = await repo.players.upsert({ game: "hll", platform: "epic", platformId: "fpv_" + discordId, name: "Fanout Viet" });
    await repo.externalLinks.set(ww2.id, "discord", discordId, "registration");
    await repo.externalLinks.set(viet.id, "discord", discordId, "registration");

    const both = await repo.externalLinks.findPlayers("discord", discordId);
    assert.deepEqual(new Set(both.map((x) => x.id)), new Set([ww2.id, viet.id]));
    assert.deepEqual(await repo.externalLinks.findPlayers("discord", "absent-" + discordId), []);

    // Clearing one game's link leaves the other standing.
    await repo.externalLinks.set(viet.id, "discord", null);
    assert.deepEqual((await repo.externalLinks.findPlayers("discord", discordId)).map((x) => x.id), [ww2.id]);
  } finally {
    await pool.end();
  }
});

/*
 * The slash command's name is a one-row jsonb config, same shape as the signature and economy
 * configs. Two things are worth a real-Postgres check: that migration 023 seeds the row (so a
 * fresh install answers with the shipped name rather than a null the dispatcher would have to
 * cope with), and that the read merges over the defaults — a document written before a field
 * existed must still answer for that field.
 */
test("postgres: discord command config is one seeded row that merges over the defaults", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const seeded = await repo.discordCommands.get();
    assert.equal(seeded.name, "staff");
    assert.equal(seeded.enabled, true);

    await repo.discordCommands.set({ name: "lynx", description: "Open the LYNX panel", enabled: true });
    const after = await repo.discordCommands.get();
    assert.equal(after.name, "lynx");
    assert.equal(after.description, "Open the LYNX panel", "the description round-trips through jsonb");

    // A document written before a field existed still answers for that field.
    await pool.query(`UPDATE discord_commands SET config = '{"name":"old"}'::jsonb WHERE id = true`);
    const legacy = await repo.discordCommands.get();
    assert.equal(legacy.name, "old");
    assert.equal(legacy.enabled, true, "a field absent from the stored document reads back as its default");

    // Still exactly one row, and the boolean primary key is what guarantees it.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM discord_commands");
    assert.equal(rows[0].n, 1);
    await assert.rejects(pool.query("INSERT INTO discord_commands (id) VALUES (false)"), /violates check constraint|duplicate key/);

    // The chat filter rides the same single-row jsonb shape, and its two structured fields get
    // the same defensive reading: a hand-edited document cannot crash every reader downstream.
    await repo.chatFilter.set({ enabled: true, words: ["slur", "badword"], action: "kick", censor: true, censorApplied: { s1: ["slur"] }, teamRuleId: "r1" });
    const cf = await repo.chatFilter.get();
    assert.deepEqual(cf.words, ["slur", "badword"]);
    assert.equal(cf.action, "kick");
    assert.deepEqual(cf.censorApplied, { s1: ["slur"] });
    assert.equal(cf.teamRuleId, "r1");
    await pool.query(`UPDATE chat_filter SET config = '{"words":"junk","censorApplied":[1]}'::jsonb WHERE id = true`);
    const junk = await repo.chatFilter.get();
    assert.deepEqual(junk.words, [], "a non-array words document reads as empty, not a crash");
    assert.deepEqual(junk.censorApplied, {}, "a non-object applied map reads as empty");
    assert.equal(junk.action, "punish", "absent fields answer with their defaults");
  } finally {
    await pool.end();
  }
});

test("postgres: the community clock is one seeded row and survives a round trip", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    assert.equal((await repo.appConfig.get()).timezone, "UTC");
    assert.equal((await repo.appConfig.set({ timezone: "America/New_York" })).timezone, "America/New_York");
    assert.equal((await repo.appConfig.get()).timezone, "America/New_York");

    // A zone that was valid when saved can stop being one after a tzdata change; the READ guards
    // too, so every consumer keeps working instead of throwing in a loop.
    await pool.query(`UPDATE app_config SET config = '{"timezone":"Mars/Olympus"}'::jsonb WHERE id = true`);
    assert.equal((await repo.appConfig.get()).timezone, "UTC", "an unusable stored zone reads back as UTC");

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM app_config");
    assert.equal(rows[0].n, 1);
  } finally {
    await pool.end();
  }
});

test("postgres data port: export selected groups, wipe, import restores — including credentials and FK misses", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { gunzipSync } = await import("node:zlib");
  const { readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2);
    const server = await repo.servers.create({ name: `port_${tag}`, host: "203.0.113.9", port: 28123, password: `pw_${tag}` });
    await repo.vips.upsert({ serverId: server.id, playerId: `steam_${tag}`, playerName: "Porter", comment: "roundtrip", expiration: null, createdByName: "test" });
    await repo.mapNames.set("hll", `port_map_${tag}`, "Port Test Map");

    // Counts see the seeded rows without touching them.
    const counts = await repo.dataPort.counts(["servers", "vip", "maps"]);
    assert.ok(counts.servers! >= 1 && counts.vip! >= 1 && counts.maps! >= 1, `counts: ${JSON.stringify(counts)}`);
    await assert.rejects(() => repo.dataPort.counts(["bogus"]), /unknown export group/);

    // Export: gzipped NDJSON, header first, and parents (servers) strictly before children (vips).
    const dir = mkdtempSync(join(tmpdir(), "data-port-"));
    const file = join(dir, "port.ndjson.gz");
    const res = await repo.dataPort.export(["servers", "vip", "maps"], file);
    assert.ok(res.rows >= 3);
    const lines = gunzipSync(readFileSync(file)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines[0].header && lines[0].header.format === "data-port", "first line is the header");
    const tableOf = (l: { table?: string }) => l.table;
    assert.ok(lines.findIndex((l) => tableOf(l) === "servers") < lines.findIndex((l) => tableOf(l) === "vips"),
      "servers rows are written before the vips rows that reference them");
    assert.ok(lines.some((l) => l.table === "servers" && l.row.id === server.id));

    // Wipe the seeded rows (the vip goes with its server), then import: everything returns —
    // same ids, and the sealed RCON password decrypts to what it was.
    await pool.query("DELETE FROM servers WHERE id = $1", [server.id]);
    await pool.query("DELETE FROM map_names WHERE map_id = $1", [`port_map_${tag}`]);
    const report = await repo.dataPort.import(file);
    assert.ok(report.servers!.inserted >= 1, `servers restored: ${JSON.stringify(report.servers)}`);
    assert.ok(report.vips!.inserted >= 1, "the vip rode back in with its server");
    assert.equal(report.servers!.failed, 0);
    const back = await repo.servers.findById(server.id);
    assert.equal(back?.name, `port_${tag}`);
    assert.equal(back?.password, `pw_${tag}`, "the sealed credential survived the round trip");
    assert.equal((await repo.vips.get(server.id, `steam_${tag}`))?.playerName, "Porter");
    assert.ok((await repo.mapNames.list("hll")).some((m) => m.mapId === `port_map_${tag}`));

    // Second import: nothing to do, nothing failed — existing rows always win.
    const again = await repo.dataPort.import(file);
    assert.equal(again.servers!.inserted, 0);
    assert.ok(again.servers!.skipped >= 1);
    assert.equal(again.servers!.failed, 0);

    // A child whose parent is genuinely missing is REPORTED, not fatal, and takes nothing else
    // down with it: delete the server, import only the vip slice.
    const vipOnly = join(dir, "vip-only.ndjson.gz");
    await repo.dataPort.export(["vip"], vipOnly);
    await pool.query("DELETE FROM servers WHERE id = $1", [server.id]); // cascade removes the vip
    const partial = await repo.dataPort.import(vipOnly);
    assert.ok(partial.vips!.failed >= 1, `the orphan vip is a reported failure: ${JSON.stringify(partial.vips)}`);
    assert.match(partial.vips!.error ?? "", /foreign key|violates/i);

    await pool.query("DELETE FROM map_names WHERE map_id = $1", [`port_map_${tag}`]);
  } finally {
    await pool.end();
  }
});

/*
 * An archive is a hand-editable file and import inserts its rows verbatim, so a grants line naming
 * yourself with a global "*" WAS ownership for anyone holding admin.data. The route now passes the
 * access tables as refused for anyone short of an owner; this pins what the store does with that:
 * not one of those rows lands, each is reported against its table, and the rest still import.
 */
test("postgres data port: refused tables import nothing, are reported, and leave the rest alone", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { DATA_PORT_ACCESS_TABLES } = await import("../dist/types.js");
  const { gzipSync } = await import("node:zlib");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2);
    const me = await repo.users.create({ username: `importer_${tag}` });
    const grantId = randomUUID();
    const userId = randomUUID();
    const lines = [
      { header: { format: "data-port", version: 1, groups: ["accounts", "maps"], full: false } },
      { table: "users", row: { id: userId, username: `planted_${tag}`, password_hash: "x", created_at: "1970-01-01T00:00:00Z" } },
      { table: "grants", row: { id: grantId, user_id: me.id, capability: "*", scope_type: "global", scope_id: null, level: "write" } },
      { table: "map_names", row: { game: "hll", map_id: `refuse_map_${tag}`, display_name: "Still imports" } },
    ];
    const dir = mkdtempSync(join(tmpdir(), "data-port-refuse-"));
    const file = join(dir, "hand-built.ndjson.gz");
    writeFileSync(file, gzipSync(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"));

    const report = await repo.dataPort.import(file, undefined, { refuseTables: new Set(DATA_PORT_ACCESS_TABLES) });
    assert.deepEqual([report.grants?.inserted, report.grants?.failed], [0, 1], JSON.stringify(report.grants));
    assert.deepEqual([report.users?.inserted, report.users?.failed], [0, 1], JSON.stringify(report.users));
    assert.match(report.grants?.error ?? "", /owner/);
    assert.equal((await pool.query("SELECT 1 FROM grants WHERE id = $1", [grantId])).rowCount, 0, "no global \"*\" was planted");
    assert.equal(await repo.users.findById(userId), null, "and no account older than the setup account");
    assert.equal(report.map_names?.inserted, 1, "the rest of the archive still lands");

    // Without the refusal the same archive is an ordinary import — what an owner's import does.
    const owner = await repo.dataPort.import(file);
    assert.equal(owner.grants?.inserted, 1);
    await pool.query("DELETE FROM grants WHERE id = $1", [grantId]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[userId, me.id]]);
    await pool.query("DELETE FROM map_names WHERE map_id = $1", [`refuse_map_${tag}`]);
  } finally {
    await pool.end();
  }
});

// The one rule that separates the import's VIP write from a staff grant, pinned against real
// Postgres because the implementation leans on `xmax = 0` (the server's own "this RETURNING row
// came from the INSERT") — a detail the in-memory store cannot exercise.
test("postgres: importOne keeps the live grant (the top-up policy)", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const s = await repo.servers.create({ name: "vip-import", host: "1.2.3.4", port: 28870, password: "x" });
    const live = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 365 * 86_400_000).toISOString();

    // A grant the panel holds is untouchable: not extended by a later archive value, not returned
    // as anything but itself, and not written to at all.
    await repo.vips.upsert({ serverId: s.id, playerId: "76561198000001111", expiration: live, comment: "panel grant", createdByName: "owner" });
    const kept = await repo.vips.importOne({ serverId: s.id, playerId: "76561198000001111", expiration: later, comment: "Imported from CRCON", createdByName: "importer" });
    assert.equal(kept.inserted, false);
    assert.equal(kept.row.expiration, live);
    assert.equal(kept.row.comment, "panel grant");
    assert.equal((await repo.vips.get(s.id, "76561198000001111"))!.expiration, live);

    // CRCON holding no expiry must not turn a timed grant permanent — the worst of the three.
    await repo.vips.importOne({ serverId: s.id, playerId: "76561198000001111", expiration: null, createdByName: "importer" });
    assert.equal((await repo.vips.get(s.id, "76561198000001111"))!.expiration, live);

    // A VIP the panel never knew about is genuinely the import's to create.
    const fresh = await repo.vips.importOne({ serverId: s.id, playerId: "76561198000002222", expiration: later, comment: "Imported from CRCON", createdByName: "importer" });
    assert.equal(fresh.inserted, true);
    assert.equal(fresh.row.expiration, later);

    // Re-applying the same archive converges: nothing inserted, nothing moved.
    const again = await repo.vips.importOne({ serverId: s.id, playerId: "76561198000002222", expiration: live, createdByName: "importer" });
    assert.equal(again.inserted, false);
    assert.equal((await repo.vips.get(s.id, "76561198000002222"))!.expiration, later);
    assert.equal((await repo.vips.list(s.id)).length, 2);
  } finally { await pool.end(); }
});

// The drift report and its repair, against real Postgres: both are pure SQL (a DISTINCT ON over
// the audit trail, an UPDATE ... FROM), so this is the only place the logic is genuinely exercised.
test("postgres: an old-style import's VIP drift is found and restored from the audit trail", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const s = await repo.servers.create({ name: "vip-drift", host: "1.2.3.4", port: 28871, password: "x" });
    const granted = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const ids = { ext: "76561198000003001", cut: "76561198000003002", perm: "76561198000003003", ok: "76561198000003004" };

    for (const playerId of Object.values(ids)) {
      await repo.vips.upsert({ serverId: s.id, playerId, expiration: granted, comment: "panel grant", createdByName: "owner" });
      await repo.audit.create({
        actorUserId: null, actorName: "owner", action: "vip.grant", targetType: "player", targetId: playerId,
        serverId: s.id, summary: "granted VIP", data: { playerId, expiration: granted },
      });
    }
    await new Promise((r) => setTimeout(r, 10));

    // Replay the old unconditional upsert — extended, cut short, and turned permanent. The cut is
    // one the store refuses today (an automated write can no longer move a date earlier), so the
    // replay has to ask for it outright: this is the damage of a version that no longer exists.
    await repo.vips.upsert({ serverId: s.id, playerId: ids.ext, expiration: new Date(Date.now() + 400 * 86_400_000).toISOString(), createdByName: "importer" });
    await repo.vips.upsert({ serverId: s.id, playerId: ids.cut, expiration: new Date(Date.now() + 86_400_000).toISOString(), createdByName: "importer", mayShorten: true });
    await repo.vips.upsert({ serverId: s.id, playerId: ids.perm, expiration: null, createdByName: "importer" });

    const moved = await repo.crconSnapshot.vipsMovedByImport(s.id);
    const byId = new Map(moved.map((m) => [m.playerId, m]));
    assert.equal(moved.length, 3, "the untouched grant is not reported");
    assert.equal(byId.get(ids.ext)!.direction, "extended");
    assert.equal(byId.get(ids.cut)!.direction, "shortened");
    assert.equal(byId.get(ids.perm)!.direction, "made-permanent");
    assert.equal(byId.get(ids.perm)!.currentExpiration, null);
    // The value to restore to survives the round trip through jsonb and timestamptz.
    assert.equal(Date.parse(byId.get(ids.ext)!.grantedExpiration!), Date.parse(granted));

    // Only time an import CUT is given back: the longer row and the made-permanent one are never
    // shortened by a restore, however they are named — VIP is paid for.
    const restored = await repo.crconSnapshot.restoreVipExpirations(s.id, [ids.ext, ids.perm, ids.cut]);
    assert.deepEqual(restored.map((r) => r.playerId), [ids.cut]);
    assert.equal(Date.parse((await repo.vips.get(s.id, ids.cut))!.expiration!), Date.parse(granted));
    assert.notEqual(Date.parse((await repo.vips.get(s.id, ids.ext))!.expiration!), Date.parse(granted), "a longer expiry is not cut");
    assert.equal((await repo.vips.get(s.id, ids.perm))!.expiration, null, "permanent stays permanent");
    assert.deepEqual((await repo.crconSnapshot.vipsMovedByImport(s.id)).map((m) => m.playerId).sort(), [ids.ext, ids.perm].sort(), "the longer two stay listed for staff");

    // Restoring is idempotent: nothing left to give back, so nothing is written.
    assert.deepEqual(await repo.crconSnapshot.restoreVipExpirations(s.id, [ids.ext, ids.perm, ids.cut]), []);

    // A seed reward is a setting too: rewarded after the grant, it is not drift and not restorable.
    const seeder = "76561198000003005";
    await repo.vips.upsert({ serverId: s.id, playerId: seeder, expiration: granted, comment: "panel grant", createdByName: "owner" });
    await repo.audit.create({ actorUserId: null, actorName: "owner", action: "vip.grant", targetType: "player", targetId: seeder, serverId: s.id, summary: "granted VIP", data: { playerId: seeder, expiration: granted } });
    await new Promise((r) => setTimeout(r, 10));
    const rewardedTo = new Date(Date.parse(granted) + 3 * 86_400_000).toISOString();
    await repo.vips.upsert({ serverId: s.id, playerId: seeder, expiration: rewardedTo, createdByName: "seeding" });
    await repo.audit.create({ actorUserId: null, actorName: "seeding", action: "seed.reward", targetType: "player", targetId: seeder, serverId: s.id, summary: "seed reward", data: { hours: 72, expiration: rewardedTo } });
    assert.equal((await repo.crconSnapshot.vipsMovedByImport(s.id)).some((m) => m.playerId === seeder), false, "a seed reward is not an import's damage");
    assert.deepEqual(await repo.crconSnapshot.restoreVipExpirations(s.id, [seeder]), []);
    assert.equal(Date.parse((await repo.vips.get(s.id, seeder))!.expiration!), Date.parse(rewardedTo), "the reward stands");
  } finally { await pool.end(); }
});

// The import's batch writers must be arithmetically identical to the single-row calls they
// replaced — that is the entire claim behind swapping them in, and it is only testable against
// real Postgres (both lean on ON CONFLICT semantics the in-memory loop cannot reproduce).
test("postgres: sessions.importMany and playerAliases.recordMany match the one-at-a-time path", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const s = await repo.servers.create({ name: "batch-writers", host: "1.2.3.4", port: 28872, password: "x" });
    const solo = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000004001", name: "Solo" });
    const batch = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000004002", name: "Batch" });

    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, n)).toISOString();
    const rows = [0, 2, 4].map((h) => ({ connectedAt: at(h), disconnectedAt: at(h + 1), durationSec: 3600 }));

    // Same three sessions, one path each.
    let soloInserted = 0;
    for (const r of rows) if (await repo.sessions.importOne({ playerId: solo.id, serverId: s.id, ...r })) soloInserted += 1;
    const batchInserted = await repo.sessions.importMany(rows.map((r) => ({ playerId: batch.id, serverId: s.id, ...r })));
    assert.equal(batchInserted.length, soloInserted, "same number reported newly inserted");
    assert.equal((await repo.sessions.list(batch.id)).length, (await repo.sessions.list(solo.id)).length);
    // And the returned rows are the inputs, so the caller's playtime fold is over real durations.
    assert.equal(batchInserted.reduce((n, r) => n + r.durationSec, 0), 3 * 3600);

    // Re-running reports nothing new on either path — the "exactly once" property.
    assert.equal(await repo.sessions.importOne({ playerId: solo.id, serverId: s.id, ...rows[0]! }), false);
    assert.deepEqual(await repo.sessions.importMany(rows.map((r) => ({ playerId: batch.id, serverId: s.id, ...r }))), []);
    // A batch mixing known and new inserts only the new one.
    const mixed = await repo.sessions.importMany([
      { playerId: batch.id, serverId: s.id, ...rows[0]! },
      { playerId: batch.id, serverId: s.id, connectedAt: at(8), disconnectedAt: at(9), durationSec: 3600 },
    ]);
    assert.equal(mixed.length, 1);
    assert.equal(mixed[0]!.connectedAt, at(8));

    // Aliases: the same sightings down both paths must leave the same row, counts included —
    // including a duplicate inside the batch, which the merge sums rather than dropping.
    const sights: [string, string][] = [["Ace", at(3)], ["Ace", at(1)], ["Ace", at(5)], ["Nova", at(2)]];
    for (const [v, ts] of sights) await repo.playerAliases.record(solo.id, "name", v, ts);
    await repo.playerAliases.recordMany(sights.map(([v, ts]) => ({ playerId: batch.id, kind: "name" as const, value: v, ts })));
    // Only the sightings under test: players.upsert also records the player's OWN name as an
    // alias, and those differ by construction ("Solo" vs "Batch").
    const norm = (rs: Awaited<ReturnType<typeof repo.playerAliases.list>>) =>
      rs.filter((a) => a.value === "Ace" || a.value === "Nova")
        .map((a) => `${a.value}|${a.seenCount}|${Date.parse(a.firstSeen)}|${Date.parse(a.lastSeen)}`).sort();
    assert.deepEqual(norm(await repo.playerAliases.list(batch.id)), norm(await repo.playerAliases.list(solo.id)),
      "value, seen_count and the widened first/last are identical down both paths");
  } finally { await pool.end(); }
});

/*
 * The wipe, against the real schema. This is the one operation whose whole value is what it does
 * NOT touch, and the in-memory store cannot vouch for that: it re-implements the intent, while the
 * damage would be done by this SQL. So the assertions here are on rows counted straight out of
 * Postgres after the real statements have run.
 */
test("postgres: wiping a server takes all of its data and none of another server's", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const mkS = (n: string) => repo.servers.create({ name: `${tag}-${n}`, host: `10.0.0.${n}`, port: 1, password: "x" });
    const doomed = await mkS("1"), keeper = await mkS("2");
    const mkP = async (pid: string) => (await repo.players.upsert({ game: "hll", platform: "steam", platformId: `${tag}${pid}`, name: pid })).id;
    // onlyDoomed plays here alone; onBoth plays on the keeper too; vipElsewhere has NO history
    // anywhere and only a VIP on the keeper — the case that keys on platform id, not row id.
    const onlyDoomed = await mkP("1"), onBoth = await mkP("2"), vipElsewhere = await mkP("3");
    const ev = (sid: string, p: string, key: string, ts: string) => repo.events.insert([
      { serverId: sid, ts, kind: "evt.kill", actorPlayerId: p, actorName: "x", victimPlayerId: p, victimName: "x", weapon: "W", data: null, dedupeKey: key }]);
    await ev(doomed.id, onlyDoomed, `${tag}-a`, "2021-01-01T00:00:00.000Z");
    // A LIVE-looking key, not crcon:% — the wipe takes it too, which is what separates it from reset.
    await ev(doomed.id, onBoth, `${tag}-live`, "2021-01-02T00:00:00.000Z");
    await ev(keeper.id, onBoth, `${tag}-c`, "2021-01-03T00:00:00.000Z");
    for (const p of [onlyDoomed, onBoth, vipElsewhere]) {
      await repo.playerNotes.create({ playerId: p, authorUserId: null, authorName: "CRCON", body: "n", createdAt: "2021-01-01T00:00:00.000Z" });
      await repo.playerTags.add({ playerId: p, label: "t", note: null, createdByName: "CRCON" });
      await repo.playerIps.record(p, "10.9.9.9", "2021-01-01T00:00:00.000Z", "crcon-profile");
    }
    await repo.vips.upsert({ serverId: keeper.id, playerId: `${tag}3`, playerName: "v", comment: null, expiration: null, createdByUserId: null, createdByName: "CRCON" });
    await repo.crconBans.upsert({ serverId: doomed.id, playerId: `${tag}1`, playerName: "a", type: "perma", reason: "r", expiresAt: null, author: "x", bannedAt: "2021-01-01T00:00:00.000Z" });
    const tmpl = await repo.templates.create({ kind: "broadcast", body: `keep-${tag}` });

    const r = await repo.crconSnapshot.purgeServerData(doomed.id);
    assert.equal(r.events, 2, "both events went — the live-keyed one as well as the imported one");
    assert.equal(r.bans, 1);

    const n = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0].n as number;
    // Gone here.
    assert.equal(await n("SELECT count(*)::int n FROM evt WHERE server_id=$1", [doomed.id]), 0);
    assert.equal(await n("SELECT count(*)::int n FROM crcon_ban WHERE server_id=$1", [doomed.id]), 0);
    assert.equal(await n("SELECT count(*)::int n FROM player_notes WHERE player_id=$1", [onlyDoomed]), 0);
    assert.equal(await n("SELECT count(*)::int n FROM player_tags WHERE player_id=$1", [onlyDoomed]), 0);
    assert.equal(await n("SELECT count(*)::int n FROM player_ips WHERE player_id=$1", [onlyDoomed]), 0);
    // Untouched there.
    assert.equal(await n("SELECT count(*)::int n FROM evt WHERE server_id=$1", [keeper.id]), 1, "the other server keeps its history");
    assert.equal(await n("SELECT count(*)::int n FROM vips WHERE server_id=$1", [keeper.id]), 1, "and its VIP grants");
    assert.equal(await n("SELECT count(*)::int n FROM player_notes WHERE player_id=$1", [onBoth]), 1, "a player seen elsewhere keeps their notes");
    assert.equal(await n("SELECT count(*)::int n FROM player_notes WHERE player_id=$1", [vipElsewhere]), 1,
      "and so does one who is ONLY a VIP elsewhere — that record keys on the platform id, not the row");
    assert.equal(await n("SELECT count(*)::int n FROM player_tags WHERE player_id=$1", [vipElsewhere]), 1);
    // Configuration and identity were never in range.
    assert.equal(await n("SELECT count(*)::int n FROM message_templates WHERE id=$1", [tmpl.id]), 1);
    assert.ok(await repo.servers.findById(doomed.id), "the server itself survives — its data went, not it");
    assert.equal(await n("SELECT count(*)::int n FROM players WHERE id=$1", [onlyDoomed]), 1, "identities stay, so Discord links do");

    // And the dedupe index went with the rows, so a re-import rebuilds rather than being swallowed.
    await ev(doomed.id, onlyDoomed, `${tag}-a`, "2021-01-01T00:00:00.000Z");
    assert.equal(await n("SELECT count(*)::int n FROM evt WHERE server_id=$1", [doomed.id]), 1, "re-import lands again");
  } finally { await pool.end(); }
});

/*
 * The four fields the public API was answering blank, checked against a REAL Postgres.
 *
 * This test exists because the in-memory store spreads its input object (`{ ...input }`), so a
 * field added to a repo input type appears to round-trip there whether or not either store was
 * ever taught to persist it. That is not a hypothetical: the roster score behind `cap_flips` sat
 * in the type, passed its memory-backed test, and wrote nothing on Postgres. Anything the public
 * API publishes gets checked here, against columns, or it does not count as wired.
 */
test("postgres: the sampler's game counters, unit history and roster score actually persist", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: "PS", host: "10.9.9.9", port: 28865, password: "x" });
    const match = await repo.matches.open({ serverId: server.id, map: "foy_warfare", startedAt: new Date(Date.now() - 600_000).toISOString() });
    const platformId = "76561198" + Math.floor(Math.random() * 1e9).toString().padStart(9, "0");
    // sampleRoster joins players on platform_id — an unknown player is not a row, so seed them the
    // way ingest would before asserting on what the sample wrote.
    await repo.players.upsertMany([{ game: "hll", platform: "steam", platformId, name: "Ana", ts: new Date().toISOString() }]);

    const sample = (over: Record<string, unknown>) => repo.stats.sampleRoster({
      serverId: server.id, matchId: match.id, sampleSec: 60,
      players: [{ platformId, name: "Ana", role: 1, isSquadLead: false, level: 5, side: "allies", squad: 3, ...over } as any],
    });

    // First sample: the game says 10 kills / 4 deaths, allies, squad 3, role 1.
    await sample({ score: { killsAndAssists: 10, deathsAndRedeploys: 4 } });
    let row = (await repo.matches.statsForMatch(match.id)).find((r) => r.playerName !== undefined || true)!;
    assert.equal(row.killsAndAssists, 10, "the game's kill counter reached the column");
    assert.equal(row.deathsAndRedeploys, 4);
    assert.equal(row.units.length, 1, "one leg for the first sighting");
    assert.deepEqual({ team: row.units[0]!.team, squad: row.units[0]!.squad, role: row.units[0]!.role }, { team: 1, squad: 3, role: 1 });

    // Same unit, higher counters: no new leg, counters advance.
    await sample({ score: { killsAndAssists: 15, deathsAndRedeploys: 6 } });
    row = (await repo.matches.statsForMatch(match.id))[0]!;
    assert.equal(row.killsAndAssists, 15);
    assert.equal(row.units.length, 1, "an unchanged unit must not append a leg per poll");

    // Squad switch: a new leg, and only one.
    await sample({ squad: 7, score: { killsAndAssists: 16, deathsAndRedeploys: 6 } });
    row = (await repo.matches.statsForMatch(match.id))[0]!;
    assert.equal(row.units.length, 2, "changing squad appends exactly one leg");
    assert.equal(row.units[1]!.squad, 7);

    /*
     * Reconnect. The game resets a player's counters when they rejoin mid-round, so the sample
     * that follows reports SMALLER numbers. Banking the old total is what stops a reconnect from
     * erasing the round — max-wins would freeze it at the pre-reconnect peak instead, and plain
     * assignment would throw the first session away.
     */
    await sample({ squad: 7, score: { killsAndAssists: 2, deathsAndRedeploys: 1 } });
    row = (await repo.matches.statsForMatch(match.id))[0]!;
    assert.equal(row.killsAndAssistsPrev, 16, "the pre-reconnect total is banked, not lost");
    assert.equal(row.killsAndAssists, 2, "and the live counter follows the game");
    assert.equal(row.killsAndAssistsPrev + row.killsAndAssists, 18, "what the API publishes");
    assert.equal(row.deathsAndRedeploysPrev + row.deathsAndRedeploys, 7);

    // And the roster score behind cap_flips — the field that shipped unwired last time.
    const ts = new Date().toISOString();
    await repo.rosterSnapshots.record({
      serverId: server.id, ts, playerCount: 20, composition: {},
      mapName: "foy_warfare", alliedScore: 3, axisScore: 2,
    });
    const back = (await repo.rosterSnapshots.list({
      serverId: server.id, from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(),
    })).find((r) => r.ts === ts)!;
    assert.equal(back.alliedScore, 3, "the score reached a real column, not just the input object");
    assert.equal(back.axisScore, 2);
  } finally {
    await pool.end();
  }
});

/*
 * Bulk payout: the receipts must be REAL rows. Same rule as the sampler fields above — this is
 * money and VIP, so a memory-backed test proves nothing and the round-trip runs here.
 */
test("postgres: payout jobs and receipts round-trip, the duplicate gate holds, restarts orphan cleanly", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const dupeKey = "test:" + Math.random().toString(36).slice(2);
    const job = await repo.payouts.create({
      sourceType: "online", sourceRef: { serverId: "s-1" }, payoutType: "currency", amount: 100,
      serverIds: [], audience: "linked", dryRun: false, status: "RUNNING",
      requestedByUserId: null, requestedByName: "tester", totalCount: 2, duplicateKey: dupeKey,
    });
    assert.equal(job.status, "RUNNING");

    await repo.payouts.addItem({ jobId: job.id, playerId: null, discordId: "d-1", displayName: "Ana", status: "PASS", error: "", detail: { balanceBefore: 0, balanceAfter: 100 } });
    await repo.payouts.addItem({ jobId: job.id, playerId: null, discordId: "d-2", displayName: "Bob", status: "FAIL", error: "boom", detail: {} });
    await repo.payouts.finish(job.id, { status: "COMPLETE_WITH_FAILURES", successCount: 1, failedCount: 1 });

    const back = (await repo.payouts.get(job.id))!;
    assert.equal(back.status, "COMPLETE_WITH_FAILURES");
    assert.equal(back.successCount, 1);
    const items = await repo.payouts.items(job.id);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0]!.detail, { balanceBefore: 0, balanceAfter: 100 }, "before/after reached a real column");
    assert.deepEqual((await repo.payouts.failedItems(job.id)).map((i) => i.displayName), ["Bob"]);

    // The duplicate gate: a completed real run blocks the same key; a dry run never does.
    assert.equal((await repo.payouts.findDuplicate(dupeKey))?.id, job.id);
    const rehearsal = await repo.payouts.create({
      sourceType: "online", sourceRef: {}, payoutType: "currency", amount: 100, serverIds: [],
      audience: "linked", dryRun: true, status: "RUNNING", requestedByUserId: null,
      requestedByName: "tester", totalCount: 1, duplicateKey: dupeKey + ":dry",
    });
    assert.equal(await repo.payouts.findDuplicate(dupeKey + ":dry"), null, "rehearsing a payout must not block performing it");
    await repo.payouts.finish(rehearsal.id, { status: "COMPLETE", successCount: 1, failedCount: 0 });

    // Field incident: a payout to a whole Discord role names all 355 recipients in duplicate_key,
    // and the raw-text index refused the row ("index row size 5688 exceeds btree version 4 maximum
    // 2704"). Distinct snowflakes barely compress, so the ids here carry real entropy — past even
    // btree's absolute 8191-byte tuple cap. The gate must still hold on a key this size.
    const roleKey = "linked:role:vip:3:s-1:" + Array.from({ length: 400 }, () => crypto.randomUUID()).join(",");
    assert.ok(roleKey.length > 8191, "the key is bigger than any btree entry may be");
    const crowd = await repo.payouts.create({
      sourceType: "linked", sourceRef: {}, payoutType: "vip", amount: 3, serverIds: ["s-1"],
      audience: "linked", dryRun: false, status: "RUNNING", requestedByUserId: null,
      requestedByName: "tester", totalCount: 400, duplicateKey: roleKey,
    });
    await repo.payouts.finish(crowd.id, { status: "COMPLETE", successCount: 400, failedCount: 0 });
    assert.equal((await repo.payouts.findDuplicate(roleKey))?.id, crowd.id, "the gate still catches a re-run of the crowd");
    assert.equal(await repo.payouts.findDuplicate(roleKey + ",d1"), null, "one more person is a different payout");

    // A restart orphans RUNNING jobs rather than leaving them lying about being alive.
    const orphan = await repo.payouts.create({
      sourceType: "linked", sourceRef: {}, payoutType: "vip", amount: 7, serverIds: ["s-1"],
      audience: "everyone", dryRun: false, status: "RUNNING", requestedByUserId: null,
      requestedByName: "tester", totalCount: 5, duplicateKey: "k-" + Math.random().toString(36).slice(2),
    });
    assert.ok((await repo.payouts.interruptStale()) >= 1);
    assert.equal((await repo.payouts.get(orphan.id))?.status, "INTERRUPTED");

    // sessions.inWindow: overlap semantics, on a real table.
    const srv = await repo.servers.create({ name: "PW", host: "10.8.8.8", port: 28865, password: "x" });
    const pid = "76561198" + Math.floor(Math.random() * 1e9).toString().padStart(9, "0");
    const [player] = await repo.players.upsertMany([{ game: "hll", platform: "steam", platformId: pid, name: "Win", ts: new Date().toISOString() }]);
    await repo.sessions.importOne({ playerId: player!.id, serverId: srv.id, connectedAt: "2026-08-21T17:00:00.000Z", disconnectedAt: "2026-08-21T19:00:00.000Z", durationSec: 7200 });
    await repo.sessions.importOne({ playerId: player!.id, serverId: srv.id, connectedAt: "2026-08-21T21:00:00.000Z", disconnectedAt: "2026-08-21T22:00:00.000Z", durationSec: 3600 });
    const win = await repo.sessions.inWindow(srv.id, "2026-08-21T18:00:00.000Z", "2026-08-21T20:00:00.000Z");
    assert.equal(win.length, 1, "the session wrapped around the window counts; the one after it does not");
    assert.equal(win[0]!.playerId, player!.id);
  } finally {
    await pool.end();
  }
});

/*
 * Payout events: the anchors, resolved boundaries and materialised roster must be REAL columns —
 * an event's roster is the payment evidence after sessions trim, so a memory-only test proves
 * nothing (same rule as the payouts round-trip above). Also pins the status guards in SQL: the
 * race-safety of worker + API sweeping concurrently IS those two WHERE clauses.
 */
test("postgres: payout events round-trip, transitions are status-guarded, match lookups order correctly", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const srv = await repo.servers.create({ name: "EV", host: "10.9.9.9", port: 28865, password: "x" });

    const ev = await repo.payoutEvents.create({
      name: "Friday", serverId: srv.id,
      openMode: "match_start_after", openAnchor: "2026-08-21T20:00:00.000Z",
      closeMode: "match_end_after", closeAnchor: "2026-08-21T23:00:00.000Z",
      minMinutes: 30, mapVoteProfile: "Event maps", rotationSetId: null, createdBy: "tester",
    });
    assert.equal(ev.status, "scheduled");
    assert.equal(ev.openAnchor, "2026-08-21T20:00:00.000Z", "timestamptz round-trips to the same instant");
    assert.equal(ev.mapVoteProfile, "Event maps", "the pinned profile name reached a real column");
    assert.equal(ev.roster, null);
    assert.ok((await repo.payoutEvents.pending()).some((e) => e.id === ev.id));

    // Closing a SCHEDULED event must be a no-op — the guard, not the caller, enforces the order.
    const skipped = (await repo.payoutEvents.applyTransition(ev.id, { closedAt: "2026-08-21T23:25:00.000Z" }))!;
    assert.equal(skipped.status, "scheduled", "close does not apply before open");

    const opened = (await repo.payoutEvents.applyTransition(ev.id, { openedAt: "2026-08-21T20:22:00.000Z" }))!;
    assert.equal(opened.status, "open");
    const roster = [{ playerId: "00000000-0000-0000-0000-00000000aaaa", name: "Ana", minutes: 158 }];
    const closed = (await repo.payoutEvents.applyTransition(ev.id, { closedAt: "2026-08-21T23:25:00.000Z", roster }))!;
    assert.equal(closed.status, "closed");
    assert.deepEqual(closed.roster, roster, "the roster reached a real jsonb column");
    // A second close must not overwrite the record — the guard again.
    const reclose = (await repo.payoutEvents.applyTransition(ev.id, { closedAt: "2026-08-22T01:00:00.000Z", roster: [] }))!;
    assert.equal(reclose.closedAt, "2026-08-21T23:25:00.000Z");
    assert.deepEqual(reclose.roster, roster);
    assert.equal(await repo.payoutEvents.cancel(ev.id), false, "a closed window is a record, not a plan");
    assert.ok(!(await repo.payoutEvents.pending()).some((e) => e.id === ev.id));

    const doomed = await repo.payoutEvents.create({
      name: "Doomed", serverId: srv.id, openMode: "at", openAnchor: "2099-01-01T00:00:00.000Z",
      closeMode: "at", closeAnchor: "2099-01-02T00:00:00.000Z", minMinutes: 0, mapVoteProfile: null, rotationSetId: null, createdBy: "tester",
    });
    assert.equal(doomed.mapVoteProfile, null);
    assert.equal(await repo.payoutEvents.cancel(doomed.id), true);
    assert.equal((await repo.payoutEvents.get(doomed.id))?.status, "cancelled");

    // Match lookups: firstEndedAfter orders by END, because the round that closes an event is
    // the first to FINISH past the anchor — not the first to have started.
    const a = await repo.matches.open({ serverId: srv.id, map: "long", startedAt: "2026-08-21T20:00:00.000Z" });
    const b = await repo.matches.open({ serverId: srv.id, map: "short", startedAt: "2026-08-21T20:30:00.000Z" });
    await repo.matches.close(b.id, { endedAt: "2026-08-21T21:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    // NB: opening b auto-closed a at b's start; re-stamp a with the later end this test needs.
    await repo.matches.close(a.id, { endedAt: "2026-08-21T22:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    assert.equal((await repo.matches.firstStartedAfter(srv.id, "2026-08-21T20:10:00.000Z"))?.id, b.id);
    assert.equal((await repo.matches.firstStartedAfter(srv.id, "2026-08-21T23:00:00.000Z")), null);
    assert.equal((await repo.matches.firstEndedAfter(srv.id, "2026-08-21T20:45:00.000Z"))?.id, b.id, "b ends first though a started first");
    assert.equal((await repo.matches.firstEndedAfter(srv.id, "2026-08-21T21:30:00.000Z"))?.id, a.id);
  } finally {
    await pool.end();
  }
});

/*
 * Editing an event after it exists. The rules live in SQL WHERE clauses rather than in the route,
 * for the same reason the transitions do: the worker's sweep and a staff edit can land in the same
 * millisecond, and only the database can settle which one wins. What is being pinned:
 *   scheduled → everything is editable;
 *   open      → the close side and the labels move, the start and the server do NOT (the event is
 *               already running on that server, from that instant — rewriting either would rewrite
 *               history for the players already in it);
 *   closed/cancelled → nothing moves, and update() says so by returning null.
 */
test("postgres: a scheduled event edits freely, an open one only forward, a closed one not at all", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const srv = await repo.servers.create({ name: "ED1", host: "10.9.9.10", port: 28865, password: "x" });
    const other = await repo.servers.create({ name: "ED2", host: "10.9.9.11", port: 28865, password: "x" });

    const ev = await repo.payoutEvents.create({
      name: "Editable", serverId: srv.id,
      openMode: "at", openAnchor: "2026-09-01T20:00:00.000Z",
      closeMode: "at", closeAnchor: "2026-09-01T23:00:00.000Z",
      minMinutes: 30, mapVoteProfile: null, rotationSetId: null, createdBy: "tester",
    });

    const moved = (await repo.payoutEvents.update(ev.id, {
      name: "Moved", serverId: other.id,
      openMode: "match_start_after", openAnchor: "2026-09-02T19:00:00.000Z",
      closeMode: "match_end_after", closeAnchor: "2026-09-02T22:30:00.000Z",
      minMinutes: 45, mapVoteProfile: "Event maps",
    }))!;
    assert.equal(moved.name, "Moved");
    assert.equal(moved.serverId, other.id, "a scheduled event can still change server");
    assert.equal(moved.openMode, "match_start_after");
    assert.equal(moved.openAnchor, "2026-09-02T19:00:00.000Z", "the new anchor is the same instant back out");
    assert.equal(moved.closeAnchor, "2026-09-02T22:30:00.000Z");
    assert.equal(moved.minMinutes, 45);
    assert.equal(moved.mapVoteProfile, "Event maps");
    assert.deepEqual(await repo.payoutEvents.update(ev.id, { mapVoteProfile: null }).then((r) => r?.mapVoteProfile), null,
      "clearing the pin is an edit, not an omission");

    // Now it is running. The close side still moves; the start and the server are frozen.
    await repo.payoutEvents.applyTransition(ev.id, { openedAt: "2026-09-02T19:04:00.000Z" });
    const live = (await repo.payoutEvents.update(ev.id, {
      name: "Running", minMinutes: 20, closeAnchor: "2026-09-02T23:45:00.000Z",
      serverId: srv.id, openAnchor: "2020-01-01T00:00:00.000Z", openMode: "at",
    }))!;
    assert.equal(live.status, "open");
    assert.equal(live.name, "Running", "labels still move while it runs");
    assert.equal(live.minMinutes, 20);
    assert.equal(live.closeAnchor, "2026-09-02T23:45:00.000Z", "the end can be pushed out mid-event");
    assert.equal(live.serverId, other.id, "the server it is running on is frozen");
    assert.equal(live.openAnchor, "2026-09-02T19:00:00.000Z", "the start it already happened at is frozen");
    assert.equal(live.openMode, "match_start_after");

    await repo.payoutEvents.applyTransition(ev.id, { closedAt: "2026-09-02T23:50:00.000Z", roster: [] });
    assert.equal(await repo.payoutEvents.update(ev.id, { name: "Too late" }), null, "a closed event is a record");
    assert.equal((await repo.payoutEvents.get(ev.id))?.name, "Running", "and refusing means unchanged");
    assert.equal(await repo.payoutEvents.update("00000000-0000-0000-0000-0000000000ff", { name: "Ghost" }), null);
  } finally {
    await pool.end();
  }
});

/*
 * The events-post schedule is a SINGLETON row, and its once-a-day latch is the only thing standing
 * between "post the list on Monday morning" and "post the list every five minutes all Monday". A
 * memory-only test would not catch the upsert writing to a second row, which is exactly how a
 * latch stops latching.
 */
test("postgres: the events-post config is one row, and a partial save leaves the rest alone", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const seeded = await repo.payoutEvents.getPostConfig();
    assert.equal(seeded.enabled, false, "off until someone turns it on");
    assert.equal(seeded.lastPostedOn, null);

    await repo.payoutEvents.setPostConfig({ enabled: true, channelId: "123456789012345678", daysAhead: 21, weekday: 5, atHour: 18, atMinute: 30 });
    const cfg = await repo.payoutEvents.getPostConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.channelId, "123456789012345678");
    assert.equal(cfg.daysAhead, 21);
    assert.equal(cfg.weekday, 5);
    assert.equal(cfg.atHour, 18);
    assert.equal(cfg.atMinute, 30);

    // The worker latches the date and touches nothing else — the settings must survive it.
    await repo.payoutEvents.setPostConfig({ lastPostedOn: "2026-09-04" });
    const after = await repo.payoutEvents.getPostConfig();
    assert.equal(after.lastPostedOn, "2026-09-04");
    assert.equal(after.channelId, "123456789012345678", "a latch write must not blank the channel");
    assert.equal(after.daysAhead, 21);
    assert.equal(after.atHour, 18);

    // Clearing the latch is a real save, not an omission. Under a plain COALESCE these two are the
    // same request, and the difference is whether moving today's post to a later hour still goes
    // out today or silently skips the day.
    await repo.payoutEvents.setPostConfig({ lastPostedOn: null });
    assert.equal((await repo.payoutEvents.getPostConfig()).lastPostedOn, null, "an explicit null re-arms the post");
    await repo.payoutEvents.setPostConfig({ lastPostedOn: "2026-09-11" });
    await repo.payoutEvents.setPostConfig({ atHour: 7 });
    assert.equal((await repo.payoutEvents.getPostConfig()).lastPostedOn, "2026-09-11", "and a patch that omits it leaves it alone");

    const { rows } = await pool.query("select count(*)::int as n from event_post_config");
    assert.equal(rows[0].n, 1, "singleton: every save is an upsert onto the one row");
  } finally {
    await pool.end();
  }
});

/*
 * The public score timeline: three columns and the nulls dropped in SQL — both invisible in the
 * output, which is the point, because it backs a byte-for-byte parity endpoint that owes the
 * whole timeline. The memory store filters in JS while this one filters in the query: exactly the
 * pair that can quietly disagree.
 */
test("postgres: scoreTimeline drops scoreless samples and returns the window whole", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const srv = await repo.servers.create({ name: "ST", host: "10.7.7.7", port: 28865, password: "x" });
    const t0 = Date.parse("2026-08-21T20:00:00.000Z");
    const at = (i: number) => new Date(t0 + i * 60_000).toISOString();
    for (let i = 0; i < 5; i++) {
      await repo.rosterSnapshots.record({
        serverId: srv.id, ts: at(i), playerCount: 10, composition: {},
        // The middle sample recorded no score — a row from before the score was sampled.
        ...(i === 2 ? {} : { alliedScore: i, axisScore: 0 }),
      });
    }
    const all = await repo.rosterSnapshots.scoreTimeline(srv.id, at(0), at(99));
    assert.deepEqual(all.map((r) => r.alliedScore), [0, 1, 3, 4], "the scoreless sample is absent, not zero");
    assert.deepEqual(all.map((r) => r.ts), [at(0), at(1), at(3), at(4)], "oldest first, and ALL of them");

    // The window bounds are honoured on both ends.
    assert.deepEqual((await repo.rosterSnapshots.scoreTimeline(srv.id, at(3), at(99))).map((r) => r.alliedScore), [3, 4]);
    assert.equal((await repo.rosterSnapshots.scoreTimeline(srv.id, at(0), at(1))).length, 1, "the upper bound is exclusive");
  } finally {
    await pool.end();
  }
});

/*
 * The composition fold's game filter, in SQL. The memory store excludes in JS and this one in a
 * correlated subquery against `servers` — the pair that can quietly disagree, and the reason a
 * role number relabelled across a game switch is worth pinning in both.
 */
test("postgres: composition folds only samples taken on the game the server runs now", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const srv = await repo.servers.create({ name: "CG", game: "hllv", host: "10.6.6.6", port: 28865, password: "x" } as never);
    const T0 = Date.parse("2026-06-05T00:00:00.000Z");
    const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
    const comp = { players: 20, unassigned: 0, byRole: { 0: 16, 13: 4 }, bySide: {} };

    // Two samples on Vietnam, where role 13 is Mortar Support.
    await repo.rosterSnapshots.record({ serverId: srv.id, ts: at(0), playerCount: 20, composition: comp });
    await repo.rosterSnapshots.record({ serverId: srv.id, ts: at(60), playerCount: 20, composition: comp });
    assert.equal((await repo.rosterSnapshots.latest(srv.id))?.game, "hllv", "the game is stamped at write time");
    assert.equal((await repo.analytics.composition({ serverId: srv.id, from: at(-10), to: at(180) })).samples, 2);

    // Switched to WW2, where 13 is Commander, and sampled again.
    await repo.servers.setGame(srv.id, "hll", "binary-v2");
    await repo.rosterSnapshots.record({ serverId: srv.id, ts: at(120), playerCount: 20, composition: comp });
    const after = await repo.analytics.composition({ serverId: srv.id, from: at(-10), to: at(180) });
    assert.equal(after.samples, 1, "only the sample counted in the vocabulary the caller will label with");
  } finally {
    await pool.end();
  }
});

/**
 * A malformed id is "no such row", not a 500 — asserted with a fake pool, so it runs everywhere.
 *
 * Every id column is `uuid`, so Postgres raises 22P02 on `WHERE id = 'does-not-exist'` where the
 * in-memory store simply finds nothing. Ids come from URLs, so a stale bookmark used to produce a
 * 500 and a database error in the log while the same request in tests produced a clean 404 — the
 * memory store making the suite agree with a behaviour production did not have.
 *
 * This needs no real database: the point is what the repository does with the error, so the pool
 * is faked and the assertions run in the ordinary suite rather than only where Postgres exists.
 */
function badUuidPool(errorMessage: string, code = "22P02") {
  const seen: string[] = [];
  return {
    seen,
    query: async (sql: string) => {
      seen.push(sql);
      const err = new Error(errorMessage) as Error & { code: string };
      err.code = code;
      throw err;
    },
    connect: async () => { throw new Error("not used"); },
    end: async () => {},
  };
}

test("a lookup given something that is not a uuid finds nothing instead of throwing", async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pool = badUuidPool('invalid input syntax for type uuid: "does-not-exist"');
  const repo = new PostgresRepository(pool as never);
  assert.equal(await repo.servers.findById("does-not-exist"), null);
  assert.equal(await repo.users.findById("does-not-exist"), null);
  assert.ok(pool.seen.length >= 2, "the query really was attempted — this is not short-circuiting before the driver");
});

test("only malformed UUIDS are softened, and only for reads", async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");

  // A bad integer is 22P02 too, and swallowing it would hide a real bug rather than answer a
  // question about an id.
  const badInt = new PostgresRepository(badUuidPool('invalid input syntax for type integer: "x"') as never);
  await assert.rejects(() => badInt.servers.findById("x"), /type integer/);

  // Some other database failure on the same read is still a failure.
  const broken = new PostgresRepository(badUuidPool("connection terminated", "08006") as never);
  await assert.rejects(() => broken.servers.findById("x"), /connection terminated/);

  // A WRITE naming an impossible id must fail loudly rather than silently affect nothing.
  const write = new PostgresRepository(badUuidPool('invalid input syntax for type uuid: "nope"') as never);
  await assert.rejects(() => write.servers.setEngagementMode("nope", "active"), /type uuid/);
});

/*
 * The full-backup promise: restored onto a FRESH INSTALL, every single thing comes back.
 *
 * A fresh install is not an empty database — migrations seed the four singleton config rows and
 * the factory presets, and boot seeds the preset roles. Plain import's existing-rows-win rule
 * therefore keeps the fresh DEFAULTS over the archive on exactly the rows an operator cares most
 * about: their settings (same fixed primary key), their roles (unique names collide, so the staff
 * assignments that point at the archived role ids then fail as orphans). Both halves are proven
 * here: import alone leaves the fresh install on defaults, and restore — wipe, then import —
 * brings the archived install back whole, by id and by value.
 */
test("postgres data port: a full backup restores a fresh install to exactly what it was", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { allDataGroups } = await import("../dist/types.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const tag = Math.random().toString(36).slice(2, 8);
  // The restore's worker stand-down: marker in a scratch folder (not the machine's real backup
  // dir), and no grace wait — the 12s exists to outlast a live worker's poll, which a test lacks.
  const markerScratch = mkdtempSync(join(tmpdir(), "restore-marker-"));
  process.env.BACKUP_DIR = markerScratch;
  process.env.RESTORE_GRACE_MS = "0";
  const { restoreInProgress } = await import("@app/shared");
  try {
    await repo.migrate();

    // --- The install as its community shaped it ---
    // Settings that live in seeded singletons: the community's clock and its currency.
    await repo.appConfig.set({ timezone: "America/New_York" });
    await repo.economy.setConfig({ currencyName: `Doubloons_${tag}` });
    // A role carrying a FACTORY PRESET'S NAME but this community's own grants — the sharpest
    // collision, since a fresh boot seeds a role with the same unique name. Renamed first so this
    // test's role IS the one named Moderator in this database.
    await pool.query("UPDATE roles SET name = name || '_" + tag + "' WHERE name = 'Moderator'");
    const role = await repo.roles.create({ name: "Moderator", description: "ours", grants: [{ capability: "server.view", level: "read" }], limits: {}, createdByName: "owner" });
    const user = await repo.users.create({ username: `owner_${tag}`, passwordHash: "h" });
    await repo.userRoles.set(user.id, [{ roleId: role.id, scopeId: null }]);
    // …and ordinary record data, standing in for the whole catalogue.
    const server = await repo.servers.create({ name: `bk_${tag}`, host: "203.0.113.7", port: 28321, password: `pw_${tag}` });
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656119${Date.now() % 10_000_000}`, name: "Keeper" });
    await repo.events.insert([{ serverId: server.id, ts: "2026-01-01T00:00:00.000Z", kind: "evt.kill", actorPlayerId: player.id, actorName: "Keeper", dedupeKey: `bk-${tag}` }]);
    await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: "Keeper", comment: "kept", expiration: null, createdByName: "owner" });

    const file = join(mkdtempSync(join(tmpdir(), "full-backup-")), "full.ndjson.gz");
    const exported = await repo.dataPort.export(allDataGroups(), file);
    assert.ok(exported.rows > 0);

    // --- The "fresh install": wipe, then re-seed what migrations and boot would seed ---
    const freshSim = async () => {
      const { tablesForDataGroups } = await import("../dist/types.js");
      for (const t of [...tablesForDataGroups(allDataGroups())].reverse()) await pool.query(`DELETE FROM "${t}"`);
      // Empty, like a database nobody has used — now the seeds a real fresh install carries
      // before any archive is offered:
      await pool.query("INSERT INTO app_config (id) VALUES (true) ON CONFLICT DO NOTHING");
      await pool.query("INSERT INTO economy_config (id) VALUES (true) ON CONFLICT DO NOTHING");
      await pool.query("INSERT INTO signature_config (id) VALUES (true) ON CONFLICT DO NOTHING");
      await pool.query("INSERT INTO discord_commands (id) VALUES (true) ON CONFLICT DO NOTHING");
      await repo.roles.create({ name: "Moderator", description: "factory preset", grants: [], limits: {}, createdByName: null });
    };

    // --- Plain import on the fresh install: the seeds win, which is the bug restore exists for ---
    await freshSim();
    await repo.dataPort.import(file);
    assert.notEqual((await repo.economy.config()).currencyName, `Doubloons_${tag}`, "import keeps the fresh default currency");
    assert.notEqual((await repo.roles.list()).find((r) => r.name === "Moderator")?.id, role.id, "import keeps the fresh seeded role");
    assert.equal((await repo.userRoles.listByUser(user.id)).length, 0, "…so the staff assignment was refused as an orphan");

    // --- Restore on the same fresh install: the archive wins, whole ---
    await freshSim();
    // A row no archive carries (DATA_EXPORT_ROWS_KEPT) is left alone by the wipe — no import could
    // bring it back.
    await repo.pluginKv.set("probe", `keep:viewer:u_${tag}`, { siteTtlSecs: 900 });
    let markerSeenDuringImport = false;
    const report = await repo.dataPort.restore(file, () => { markerSeenDuringImport ||= restoreInProgress(); });
    assert.ok(markerSeenDuringImport, "the stand-down marker is armed while the archive lands");
    assert.equal(restoreInProgress(), false, "…and cleared the moment the restore ends");
    assert.equal((await repo.appConfig.get()).timezone, "America/New_York", "the community clock came back");
    assert.equal((await repo.economy.config()).currencyName, `Doubloons_${tag}`, "the currency came back");
    const mod = (await repo.roles.list()).find((r) => r.name === "Moderator");
    assert.equal(mod?.id, role.id, "the community's own Moderator role, by id");
    assert.deepEqual(mod?.grants, [{ capability: "server.view", level: "read" }], "…with its own grants");
    assert.deepEqual((await repo.userRoles.listByUser(user.id)).map((a) => a.roleId), [role.id], "the staff assignment holds");
    assert.equal((await repo.servers.findById(server.id))?.password, `pw_${tag}`, "sealed credentials survive");
    assert.equal((await repo.players.findById(player.id))?.name, "Keeper");
    assert.equal((await repo.vips.get(server.id, player.platformId))?.comment, "kept");
    assert.deepEqual(await repo.pluginKv.get("probe", `keep:viewer:u_${tag}`), { siteTtlSecs: 900 }, "a person's own settings survive the restore");
    await repo.pluginKv.remove("probe", `keep:viewer:u_${tag}`);
    for (const [table, r] of Object.entries(report)) {
      assert.equal(r.failed, 0, `restore refused rows in ${table}: ${r.error}`);
    }
  } finally {
    delete process.env.BACKUP_DIR;
    delete process.env.RESTORE_GRACE_MS;
    rmSync(markerScratch, { recursive: true, force: true });
    await pool.end();
  }
});

/*
 * Every way an archive can be unfit to restore is refused BEFORE the wipe.
 *
 * The wipe is the irreversible half of a restore, and it used to run on nothing more than "a
 * file with the right name exists": a truncated gzip (a killed copy, a half-downloaded file), a
 * corrupt line, a partial export renamed to look like a backup — each emptied the database and
 * only then discovered there was nothing whole to refill it with. Restore now reads the entire
 * archive first, so each refusal below must leave the seeded row exactly where it was and the
 * worker stand-down marker unarmed (validation refuses before arming).
 */
test("postgres data port: a bad archive is refused before anything is wiped", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { restoreInProgress } = await import("@app/shared");
  const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import("node:fs");
  const { gzipSync } = await import("node:zlib");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const tag = Math.random().toString(36).slice(2, 8);
  const dir = mkdtempSync(join(tmpdir(), "bad-archive-"));
  process.env.BACKUP_DIR = join(dir, "markers");
  process.env.RESTORE_GRACE_MS = "0";
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: `keep_${tag}`, host: "203.0.113.11", port: 28451, password: "pw" });
    const survived = async () => Boolean(await repo.servers.findById(server.id));

    // (a) A PARTIAL export wearing a backup's clothes: real archive, real header, full: false.
    const partial = join(dir, "partial.ndjson.gz");
    await repo.dataPort.export(["maps"], partial);
    await assert.rejects(() => repo.dataPort.restore(partial), /PARTIAL export/, "a slice must not wipe the whole");
    assert.ok(await survived(), "(a) nothing was wiped");

    // (b) A truncated full backup — the shape a killed copy or half-download takes.
    const { allDataGroups } = await import("../dist/types.js");
    const whole = join(dir, "whole.ndjson.gz");
    await repo.dataPort.export(allDataGroups(), whole);
    const bytes = readFileSync(whole);
    writeFileSync(join(dir, "truncated.ndjson.gz"), bytes.subarray(0, Math.floor(bytes.length / 2)));
    await assert.rejects(() => repo.dataPort.restore(join(dir, "truncated.ndjson.gz")), /refusing to restore/);
    assert.ok(await survived(), "(b) nothing was wiped");

    // (c) Not an archive at all.
    writeFileSync(join(dir, "junk.ndjson.gz"), "definitely not gzip");
    await assert.rejects(() => repo.dataPort.restore(join(dir, "junk.ndjson.gz")), /refusing to restore/);
    assert.ok(await survived(), "(c) nothing was wiped");

    // (d) Valid gzip NDJSON with no header — hand-built, and not ours to trust with a wipe.
    writeFileSync(join(dir, "headerless.ndjson.gz"), gzipSync('{"table":"servers","row":{"id":"x"}}\n'));
    await assert.rejects(() => repo.dataPort.restore(join(dir, "headerless.ndjson.gz")), /does not carry a data-port header/);
    assert.ok(await survived(), "(d) nothing was wiped");

    // No refusal armed the stand-down marker: validation runs before it, so a refused restore
    // never pauses ingestion at all.
    assert.equal(restoreInProgress(), false);

    // …and the whole archive is still perfectly restorable, proving the validator gates rather
    // than blocks.
    const report = await repo.dataPort.restore(whole);
    assert.ok(Object.values(report).some((r) => r.inserted > 0));
    assert.ok(await survived(), "the real backup restores the row it archived");
  } finally {
    delete process.env.BACKUP_DIR;
    delete process.env.RESTORE_GRACE_MS;
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
});

test("postgres sessions.closeAbsent: reaps absent-and-old, keeps present and fresh", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const { randomUUID } = await import("node:crypto");
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2);
    const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `reap_a_${tag}`, name: "A" });
    const b = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `reap_b_${tag}`, name: "B" });
    const c = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `reap_c_${tag}`, name: "C" });
    const s1 = randomUUID();
    const s2 = randomUUID();
    const old = "2026-01-02T10:00:00.000Z";
    const fresh = "2026-01-02T11:59:30.000Z";
    const graceCutoff = "2026-01-02T11:57:00.000Z";
    const now = "2026-01-02T12:00:00.000Z";
    await repo.sessions.open(a.id, s1, old); // present → kept
    await repo.sessions.open(b.id, s1, old); // absent + old → reaped
    await repo.sessions.open(c.id, s1, fresh); // absent + inside the grace → kept
    await repo.sessions.open(b.id, s2, old); // another server → untouched

    assert.equal(await repo.sessions.closeAbsent(s1, [a.id], graceCutoff, now), 1);
    assert.deepEqual(await repo.sessions.openServers(a.id), [s1]);
    assert.deepEqual(await repo.sessions.openServers(b.id), [s2], "reaped on s1, untouched on s2");
    assert.deepEqual(await repo.sessions.openServers(c.id), [s1], "the grace holds fire on a fresh connect");

    const hist = await repo.sessions.list(b.id);
    assert.equal(hist.length, 1);
    assert.equal(hist[0]!.serverId, s1);
    assert.equal(hist[0]!.durationSec, 7200);

    // An empty present-list (an empty server) reaps everything old — the crash-stranded lobby.
    assert.equal(await repo.sessions.closeAbsent(s1, [], graceCutoff, now), 1);
    assert.deepEqual(await repo.sessions.openServers(c.id), [s1], "still inside the grace either way");
  } finally {
    await repo.close();
  }
});

test("postgres: linked identities are searchable and join the same account's rows", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2);
    const xuid = `25332748239${String(Math.floor(Math.random() * 90000) + 10000)}`;
    const vn = await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: `link_vn_${tag}`, name: "CrimePays410" });
    const ww2 = await repo.players.upsert({ game: "hll", platform: "xbox", platformId: `link_ww2_${tag}`, name: "CrimePays410" });
    await repo.externalLinks.set(vn.id, "xbox", xuid);
    await repo.externalLinks.set(ww2.id, "xbox", xuid);

    const hits = await repo.players.search(xuid);
    assert.deepEqual(hits.map((p) => p.id).sort(), [vn.id, ww2.id].sort(), "search finds rows by their linked id");

    const dir = await repo.players.directory({ q: xuid });
    assert.deepEqual(dir.map((p) => p.id).sort(), [vn.id, ww2.id].sort(), "the directory's q filter matches it too");

    const same = await repo.externalLinks.findPlayersByExternalId(xuid);
    assert.deepEqual(same.map((p) => p.id).sort(), [vn.id, ww2.id].sort(), "the reverse account lookup joins the two games");
  } finally {
    await repo.close();
  }
});

/*
 * The session REAPER, in both stores.
 *
 * The reaper closes sessions the game never reported the end of, at a timestamp the worker
 * chooses: the last moment anything observed the server, which for a session that began inside
 * that blind spot can be earlier than the session itself. Both stores must clamp that to the
 * start — zero length is the honest floor, negative is nonsense every consumer would have to
 * defend against.
 *
 * This case is here because it is exactly where the two stores drifted: the Postgres version
 * compared the request's timestamp STRING against `connected_at`, which arrives from pg as a Date,
 * so the guard decided nothing while the memory store's identical-looking guard worked.
 */
test("postgres: a reaped session never ends before it began, and the memory store agrees", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const mem = new InMemoryRepository();
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const mk = async (r: typeof repo | typeof mem) => ({
      server: await r.servers.create({ name: `reap-${tag}`, host: "1.1.1.4", port: 28868, password: "p" }),
      player: await r.players.upsert({ game: "hll", platform: "steam", platformId: `765_reap_${tag}`, name: "Ghost" }),
    });
    const a = await mk(repo);
    const b = await mk(mem);

    const startedAt = "2026-07-05T23:00:00.000Z";
    // Absent from the roster, and an end BEFORE the start — what the outage cap produces for a
    // session the log backfill created inside the blind spot.
    const endedAt = "2026-07-05T20:00:00.000Z";
    const cutoff = "2026-07-06T00:00:00.000Z";
    await repo.sessions.open(a.player.id, a.server.id, startedAt);
    await mem.sessions.open(b.player.id, b.server.id, startedAt);
    assert.equal(await repo.sessions.closeAbsent(a.server.id, [], cutoff, endedAt), 1);
    assert.equal(await mem.sessions.closeAbsent(b.server.id, [], cutoff, endedAt), 1);

    const pgRows = await repo.sessions.list(a.player.id, 10);
    const memRows = await mem.sessions.list(b.player.id, 10);
    for (const [name, rows] of [["postgres", pgRows], ["memory", memRows]] as const) {
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0]!.durationSec, 0, `${name}: a session that ended before it began is zero long`);
      assert.equal(rows[0]!.disconnectedAt, startedAt, `${name}: clamped to the start, not left in the past`);
    }
    assert.deepEqual(
      { d: pgRows[0]!.disconnectedAt, s: pgRows[0]!.durationSec },
      { d: memRows[0]!.disconnectedAt, s: memRows[0]!.durationSec },
      "the two stores answer identically",
    );

    // And an ordinary reap — an end after the start — is untouched by the clamp in either store.
    await repo.sessions.open(a.player.id, a.server.id, "2026-07-06T01:00:00.000Z");
    await mem.sessions.open(b.player.id, b.server.id, "2026-07-06T01:00:00.000Z");
    await repo.sessions.closeAbsent(a.server.id, [], "2026-07-06T03:00:00.000Z", "2026-07-06T02:00:00.000Z");
    await mem.sessions.closeAbsent(b.server.id, [], "2026-07-06T03:00:00.000Z", "2026-07-06T02:00:00.000Z");
    const pgNewest = (await repo.sessions.list(a.player.id, 10))[0]!;
    const memNewest = (await mem.sessions.list(b.player.id, 10))[0]!;
    assert.equal(pgNewest.durationSec, 3600);
    assert.equal(memNewest.durationSec, 3600);
    assert.equal(pgNewest.disconnectedAt, memNewest.disconnectedAt);
  } finally { await pool.end(); }
});

/*
 * The Postgres half of "a second connect banks the open session". It is a different implementation
 * from the memory store's — a transaction, a conditional DELETE and the unique index on
 * (player, server, connected_at) — so the behaviour has to be asserted against a real database,
 * not inferred from the one that passes in memory. The replay case in particular only exists here:
 * ON CONFLICT DO NOTHING must not credit the same minutes to a career twice.
 */
test("postgres: a second connect banks the open session, and a replay banks nothing", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const server = await repo.servers.create({ name: "reconnect", host: "127.0.0.1", port: 1, password: "x" });
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "sess_" + Math.random().toString(36).slice(2), name: "Rejoin", ts: "2026-03-01T00:00:00.000Z" });

    assert.equal(await repo.sessions.open(p.id, server.id, "2026-03-01T20:00:00.000Z"), 0);
    assert.equal(await repo.sessions.open(p.id, server.id, "2026-03-01T22:05:00.000Z"), 7500, "the pre-restart hours are banked");

    const history = await repo.sessions.list(p.id, 50, server.id);
    assert.equal(history.length, 1);
    assert.equal(new Date(history[0]!.disconnectedAt).toISOString(), "2026-03-01T22:05:00.000Z");
    assert.deepEqual(await repo.sessions.openServers(p.id), [server.id], "the newer session is the open one");

    // Replaying the exact same pair: the unique index refuses the duplicate row, and because
    // nothing was recorded, nothing is credited either.
    await repo.sessions.close(p.id, server.id, "2026-03-01T23:00:00.000Z");
    await repo.sessions.open(p.id, server.id, "2026-03-01T20:00:00.000Z");
    assert.equal(await repo.sessions.open(p.id, server.id, "2026-03-01T22:05:00.000Z"), 0, "a replayed bank credits nothing");
    assert.equal((await repo.sessions.list(p.id, 50, server.id)).length, 2, "and adds no row");

    // Older than what is already open: old news, left alone.
    assert.equal(await repo.sessions.open(p.id, server.id, "2026-03-01T21:00:00.000Z"), 0);
    assert.equal(await repo.sessions.close(p.id, server.id, "2026-03-01T22:35:00.000Z"), 1800, "the open session still started at 22:05");
  } finally {
    await pool.end();
  }
});

/*
 * The activity feed's Postgres half: LIKE-ANY prefix matching with escaping, the name join, the
 * null-ref "adjust" family, and the global newest-first order — none of which the memory store's
 * pass proves. The refs mirror the real writers, same as the memory test.
 */
test("postgres: economy activity classifies, filters, joins names, and pages globally", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const a = `act_a_${tag}`, b = `act_b_${tag}`;
    await repo.economy.apply({ discordId: a, delta: 500, reason: `seed ${tag}`, discordName: "Alice" });
    await repo.economy.apply({ discordId: a, delta: -250, reason: `VIP shop ${tag}`, ref: `buy:${tag}` });
    await repo.economy.apply({ discordId: b, delta: 300, reason: `seed ${tag}`, discordName: "Bob" });
    await repo.economy.apply({ discordId: b, delta: -100, reason: `gift out ${tag}`, ref: `gift:${tag}` });
    await repo.economy.apply({ discordId: a, delta: 100, reason: `gift in ${tag}`, ref: `gift-in:gift:${tag}` });
    await repo.economy.apply({ discordId: a, delta: 250, reason: `refund ${tag}`, ref: `refund:buy:${tag}2` });
    await repo.economy.apply({ discordId: b, delta: 75, reason: `payout ${tag}`, ref: `payout:job:${tag}:${b}` });

    // The suite shares one database, so filter every read down to this scene's rows by reason tag.
    const mine = <T extends { reason: string }>(feed: { entries: T[] }) => feed.entries.filter((e) => e.reason.includes(tag));

    const purchases = mine(await repo.economy.activity({ kind: "purchase", limit: 200 }));
    assert.deepEqual(purchases.map((e) => e.reason), [`VIP shop ${tag}`]);
    assert.equal(purchases[0]!.kind, "purchase");
    assert.equal(purchases[0]!.discordName, "Alice", "the members join carries the name");

    const gifts = mine(await repo.economy.activity({ kind: "gift", limit: 200 }));
    assert.deepEqual(gifts.map((e) => e.reason).sort(), [`gift in ${tag}`, `gift out ${tag}`]);

    // refund:buy:… is a REFUND — the LIKE for "buy:" must be anchored to the start, not a substring.
    const refunds = mine(await repo.economy.activity({ kind: "refund", limit: 200 }));
    assert.deepEqual(refunds.map((e) => e.reason), [`refund ${tag}`]);

    const adjusts = mine(await repo.economy.activity({ kind: "adjust", limit: 200 }));
    assert.equal(adjusts.length, 2, "null-ref rows are the adjust family");

    // Global order: this scene's newest row leads its own slice of the unfiltered feed.
    const all = mine(await repo.economy.activity({ limit: 200 }));
    assert.equal(all[0]!.reason, `payout ${tag}`, "newest first across members");
    assert.equal(all.length, 7);

    assert.deepEqual(await repo.economy.activity({ kind: "nope" }), { entries: [], total: 0 });
  } finally {
    await pool.end();
  }
});

/*
 * The rules columns added after the baseline (params, active_hours) go through REAL SQL here —
 * the API tests run on the memory store, so a column missing from the INSERT list or the update
 * map would build clean and fail only at runtime on a live install.
 */
test("postgres: enforcer rules persist trigger params and active hours through create/update", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const rule = await repo.enforcerRules.create({
      name: `hours-${Math.random().toString(36).slice(2, 8)}`, eventKind: "app.state.solo_tank", action: "message",
      params: { tankRoles: [11, 12], minCrew: 3 },
      activeHours: { start: "22:00", end: "06:00", daysOfWeek: ["fri", "sat"], timezone: "America/New_York" },
      playersMin: 40, playersMax: 90, breakerLimit: 25,
      matchMinutesMin: 5, matchMinutesMax: 40, countPerMatch: true, requireTags: ["watch"], capCount: 3, capPeriod: "match",
      actionTag: "warned", points: 40,
    });
    assert.deepEqual([rule.actionTag, rule.points], ["warned", 40]);
    const cleared = await repo.enforcerRules.update(rule.id, { actionTag: null, points: 0 });
    assert.deepEqual([cleared?.actionTag, cleared?.points], [null, 0]);
    try {
      assert.deepEqual([rule.matchMinutesMin, rule.matchMinutesMax, rule.countPerMatch, rule.requireTags, rule.capCount, rule.capPeriod], [5, 40, true, ["watch"], 3, "match"]);
      const recapped = await repo.enforcerRules.update(rule.id, { matchMinutesMax: 0, countPerMatch: false, requireTags: [], capCount: 0, capPeriod: "ever" });
      assert.deepEqual([recapped?.matchMinutesMin, recapped?.matchMinutesMax, recapped?.countPerMatch, recapped?.requireTags, recapped?.capCount, recapped?.capPeriod], [5, 0, false, [], 0, "ever"]);
      // The cap's count is real SQL over rule_firings: this rule's firings on this player, since a
      // point; trial firings only when asked for — and an audit trim does not touch it.
      const { randomUUID } = await import("node:crypto");
      const who = randomUUID();
      await repo.enforcerRules.recordFiring(rule.id, who, false);
      await new Promise((r) => setTimeout(r, 30));
      const between = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 30));
      await repo.enforcerRules.recordFiring(rule.id, who, false);
      await repo.enforcerRules.recordFiring(rule.id, who, true);
      assert.equal(await repo.enforcerRules.firingCount(rule.id, who, null, false), 2);
      assert.equal(await repo.enforcerRules.firingCount(rule.id, who, between, false), 1);
      assert.equal(await repo.enforcerRules.firingCount(rule.id, who, null, true), 1);
      assert.equal(await repo.enforcerRules.firingCount(randomUUID(), who, null, false), 0);
      await repo.trimData.run(["audit"], new Date(Date.now() + 60_000).toISOString(), null);
      assert.equal(await repo.enforcerRules.firingCount(rule.id, who, null, false), 2, "a Staff-activity trim must not reset a 'once ever' cap");
      assert.deepEqual(rule.params, { tankRoles: [11, 12], minCrew: 3 });
      assert.deepEqual(rule.activeHours, { start: "22:00", end: "06:00", daysOfWeek: ["fri", "sat"], timezone: "America/New_York" });
      assert.equal(rule.playersMin, 40);
      assert.equal(rule.playersMax, 90);
      assert.equal(rule.breakerLimit, 25);

      const read = await repo.enforcerRules.get(rule.id);
      assert.deepEqual(read?.activeHours?.start, "22:00");

      const edited = await repo.enforcerRules.update(rule.id, { params: { tankRoles: [12], minCrew: 2 }, activeHours: null });
      assert.deepEqual(edited?.params, { tankRoles: [12], minCrew: 2 });
      assert.equal(edited?.activeHours, null, "an explicit null clears the window");

      const rebounded = await repo.enforcerRules.update(rule.id, { playersMin: 0, playersMax: 0, breakerLimit: 0 });
      assert.equal(rebounded?.playersMin, 0);
      assert.equal(rebounded?.breakerLimit, 0);

      // An update that names none of them leaves everything exactly where it was.
      const renamed = await repo.enforcerRules.update(rule.id, { name: "renamed" });
      assert.deepEqual(renamed?.params, { tankRoles: [12], minCrew: 2 });
      assert.equal(renamed?.activeHours, null);
      assert.equal(renamed?.breakerLimit, 0);
    } finally {
      await repo.enforcerRules.remove(rule.id);
    }
  } finally {
    await pool.end();
  }
});

/*
 * The audit filters the automation history rides on, through REAL SQL: prefix families
 * (LIKE ANY), the per-rule data filter (data->>'ruleId') and the time order.
 */
test("postgres: audit actionPrefixes, dataRuleId and order behave over real SQL", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const tag = Math.random().toString(36).slice(2, 8);
  try {
    await repo.migrate();
    // The staff row wears a REAL user id — audit.actor_user_id is a foreign key, exactly as in
    // production, where staff rows always belong to an account.
    const alice = await repo.users.create({ username: `alice_${tag}`, passwordHash: "x" });
    await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "enforcer.kick", summary: `hist-${tag} kick`, data: { ruleId: `r-${tag}` } });
    await repo.audit.create({ actorUserId: null, actorName: "seeding", action: "seed.warn", summary: `hist-${tag} warn` });
    await repo.audit.create({ actorUserId: alice.id, actorName: "alice", action: "player.kick", summary: `hist-${tag} staff` });

    const auto = await repo.audit.list({ actionPrefixes: ["enforcer.", "seed."], q: `hist-${tag}` });
    assert.deepEqual(auto.map((r) => r.action).sort(), ["enforcer.kick", "seed.warn"], "the staff row never matches an automation prefix");
    const perRule = await repo.audit.list({ dataRuleId: `r-${tag}` });
    assert.deepEqual(perRule.map((r) => r.action), ["enforcer.kick"]);
    const asc = await repo.audit.list({ q: `hist-${tag}`, order: "asc" });
    assert.equal(asc[0]!.action, "enforcer.kick", "asc starts at the oldest");
    assert.equal((await repo.audit.count({ actionPrefixes: ["enforcer."], q: `hist-${tag}` })), 1);
  } finally {
    await pool.end();
  }
});

/*
 * The single-round records board (matches.topStats): both stores must rank the same records, and
 * an open round's numbers must stay off it in both — a record that could un-happen at the whistle
 * is not a record. The memory store runs alongside because a dev without DATABASE_URL sees it,
 * and a records board that disagrees between the two is worse than one wrong in both.
 */
test("postgres: the records board agrees with the memory store, finished rounds only", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const pgRepo = new PostgresRepository(pool);
  try {
    await pgRepo.migrate();
    const results: { name: string | null; side: string | null; value: number; map: string | null }[][] = [];
    for (const repo of [pgRepo, new InMemoryRepository()]) {
      const s = await repo.servers.create({ name: `rec-${Math.random().toString(36).slice(2, 8)}`, host: "1.1.1.3", port: 28867, password: "p" });
      const ada = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000777001", name: "Ada" });
      const bea = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000777002", name: "Bea" });
      const done = await repo.matches.open({ serverId: s.id, map: "carentan_warfare", startedAt: "2026-08-01T10:00:00.000Z" });
      await repo.matches.bumpStat({ matchId: done.id, playerId: ada.id, serverId: s.id, playerName: "Ada", side: "allies", kills: 40 });
      await repo.matches.bumpStat({ matchId: done.id, playerId: bea.id, serverId: s.id, playerName: "Bea", side: "axis", kills: 12 });
      await repo.matches.close(done.id, { endedAt: "2026-08-01T11:00:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, result: null });
      const open = await repo.matches.open({ serverId: s.id, map: "foy_warfare", startedAt: "2026-08-01T12:00:00.000Z" });
      await repo.matches.bumpStat({ matchId: open.id, playerId: bea.id, serverId: s.id, playerName: "Bea", kills: 99 });
      const top = await repo.matches.topStats(s.id, "kills", 10);
      assert.equal(top[0]!.matchSeq, done.seq, "the record names its round by the public alias");

      // The weapon-kill rollup rides the same scenario: write, re-run (replaces), read the boards.
      await repo.matches.saveWeaponRollup(done.id, [
        { playerId: ada.id, weapon: "MG42", classId: "mg", kills: 9, deaths: 0 },
        { playerId: bea.id, weapon: "MG42", classId: "mg", kills: 3, deaths: 0 },
      ]);
      await repo.matches.saveWeaponRollup(done.id, [
        { playerId: ada.id, weapon: "MG42", classId: "mg", kills: 6, deaths: 2 },
        { playerId: ada.id, weapon: "DP-27", classId: "mg", kills: 3, deaths: 0 },
        { playerId: bea.id, weapon: "M1 GARAND", classId: "rifle", kills: 4, deaths: 7 },
      ]);
      assert.deepEqual((await repo.matches.classesWithData(s.id)).sort(), ["mg", "rifle"], "a re-run replaced the round's rollup");
      const classTop = await repo.matches.topClassKills(s.id, "mg", 5);
      assert.deepEqual(classTop.map((r) => ({ name: r.playerName, value: r.value, weapon: r.weapon })),
        [{ name: "Ada", value: 9, weapon: "MG42" }], "class records sum a round's weapons and name the carrier");
      const classTotals = await repo.matches.classTotals(s.id, "rifle", 5);
      assert.deepEqual(classTotals.map((t) => ({ name: t.name, kills: t.kills })), [{ name: "Bea", kills: 4 }]);
      assert.deepEqual(await repo.matches.weaponSummary(s.id, 3), [
        { weapon: "MG42", classId: "mg", totalKills: 6 },
        { weapon: "M1 GARAND", classId: "rifle", totalKills: 4 },
        { weapon: "DP-27", classId: "mg", totalKills: 3 },
      ]);
      assert.deepEqual((await repo.matches.topWeaponKills(s.id, "MG42", 5)).map((r) => ({ name: r.playerName, value: r.value })), [{ name: "Ada", value: 6 }]);
      assert.deepEqual(await repo.matches.playerWeaponTotals(s.id, ada.id, 5), [{ weapon: "MG42", kills: 6 }, { weapon: "DP-27", kills: 3 }]);
      assert.deepEqual((await repo.matches.classDeathTotals(s.id, "rifle", 5)).map((t) => ({ name: t.name, deaths: t.deaths })), [{ name: "Bea", deaths: 7 }]);
      assert.deepEqual((await repo.matches.weaponDeathTotals(s.id, "MG42", 5)).map((t) => ({ name: t.name, deaths: t.deaths })), [{ name: "Ada", deaths: 2 }]);
      assert.deepEqual(await repo.matches.playerWeaponDeathTotals(s.id, bea.id, 5), [{ weapon: "M1 GARAND", deaths: 7 }]);
      assert.equal((await repo.matches.pendingWeaponRollup(50)).some((m) => m.id === done.id), false, "a rolled-up round is never revisited");

      results.push(top.map((r) => ({ name: r.playerName, side: r.side, value: r.value, map: r.map })));
    }
    assert.deepEqual(results[0], results[1], "both stores rank the same records");
    assert.deepEqual(results[0], [
      { name: "Ada", side: "allies", value: 40, map: "carentan_warfare" },
      { name: "Bea", side: "axis", value: 12, map: "carentan_warfare" },
    ], "finished rounds only — the open 99-kill line is not a record yet");
  } finally {
    await pool.end();
  }
});

test("postgres: objective-point patch semantics agree with the memory store", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const pgRepo = new PostgresRepository(pool);
  try {
    await pgRepo.migrate();
    const results: (string | null)[][] = [];
    for (const repo of [pgRepo, new InMemoryRepository()]) {
      // Unique family per run on the shared database; the memory store doesn't mind.
      const fam = `objfam${Math.random().toString(36).slice(2, 8)}`;
      await repo.objectivePoints.set("hll", fam, 2, 0, { name: "The Church" });
      const both = await repo.objectivePoints.set("hll", fam, 2, 0, { sector: "B4" });
      const cleared = await repo.objectivePoints.set("hll", fam, 2, 0, { name: "" });
      const dropped = await repo.objectivePoints.set("hll", fam, 2, 0, { sector: null });
      const left = await repo.objectivePoints.forMap("hll", fam);
      results.push([both?.name ?? null, both?.sector ?? null, cleared?.name ?? null, cleared?.sector ?? null,
        dropped === null ? "dropped" : "kept", String(left.length)]);
    }
    assert.deepEqual(results[0], ["The Church", "B4", null, "B4", "dropped", "0"]);
    assert.deepEqual(results[0], results[1], "the two stores must teach and forget identically");
  } finally {
    await pool.end();
  }
});

test("postgres: layout-expiry countdowns agree with the memory store", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const pgRepo = new PostgresRepository(pool);
  try {
    await pgRepo.migrate();
    const results: (string | number | null)[][] = [];
    for (const repo of [pgRepo, new InMemoryRepository()]) {
      const sid = `srv${Math.random().toString(36).slice(2, 8)}`;
      await repo.layoutExpiries.set({ serverId: sid, mapId: "vantuong_warfare", playsLeft: 3, lastMatchId: "m0", setBy: "owner" });
      const first = await repo.layoutExpiries.get(sid, "vantuong_warfare");
      await repo.layoutExpiries.count(sid, "vantuong_warfare", 2, "m1");
      const counted = await repo.layoutExpiries.get(sid, "vantuong_warfare");
      // A re-save REPLACES the countdown — the whole point of "set" over "insert".
      await repo.layoutExpiries.set({ serverId: sid, mapId: "vantuong_warfare", playsLeft: 5, lastMatchId: "m1", setBy: "other" });
      const resaved = await repo.layoutExpiries.get(sid, "vantuong_warfare");
      const listed = (await repo.layoutExpiries.list()).filter((r) => r.serverId === sid).length;
      await repo.layoutExpiries.delete(sid, "vantuong_warfare");
      const gone = await repo.layoutExpiries.get(sid, "vantuong_warfare");
      results.push([first?.playsLeft ?? null, counted?.playsLeft ?? null, counted?.lastMatchId ?? null,
        resaved?.playsLeft ?? null, resaved?.setBy ?? null, listed, gone === null ? "gone" : "kept"]);
    }
    assert.deepEqual(results[0], [3, 2, "m1", 5, "other", 1, "gone"]);
    assert.deepEqual(results[0], results[1], "the two stores must count identically");
  } finally {
    await pool.end();
  }
});

/*
 * What the removed objective presets left: a pending row an older install wrote. Nothing writes one
 * any more, so the rows are made the way that install made them (SQL), and the store must read one
 * back whole and hand it to exactly one taker — the worker's put-back reads every column of it.
 */
test("postgres: a leftover objective-preset row reads back whole, and is taken once", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const sid = `left${Math.random().toString(36).slice(2, 8)}`;
  try {
    await repo.migrate();
    await pool.query(
      `INSERT INTO map_point_pending (server_id, id, game, map_key, mode_key, map_id, before_map_id, phase, picks,
         stored_map_id, stored_indices, carried_indices, restore, baseline_match_id, requested_by, requested_at, expires_at, claimed_at)
       VALUES ($1, 'row-1', 'hllv', 'vantuong', 'warfare', 'vantuong_warfare_day', 'hue_warfare', 'armed', $2::jsonb,
         'WDEV_A', '[1,0,0,0,2]'::jsonb, '[2,2,2,2,2]'::jsonb, '[0,1,2,1,0]'::jsonb, 'm1', 'Owner',
         '2026-10-01T10:00:00Z', '2026-10-01T10:20:00Z', NULL)`,
      [sid, JSON.stringify([{ idx: 1, name: "Rail" }, null, { idx: 0, name: "" }, null, null])]);
    const row = (await repo.mapPointPending.list()).find((r) => r.serverId === sid);
    assert.deepEqual(row, {
      serverId: sid, id: "row-1", game: "hllv", mapKey: "vantuong", modeKey: "warfare", mapId: "vantuong_warfare_day",
      beforeMapId: "hue_warfare", phase: "armed",
      picks: [{ idx: 1, name: "Rail" }, null, { idx: 0, name: null }, null, null],
      storedMapId: "WDEV_A", storedIndices: [1, 0, 0, 0, 2], carriedIndices: [2, 2, 2, 2, 2], restore: [0, 1, 2, 1, 0],
      baselineMatchId: "m1", requestedBy: "Owner", requestedAt: "2026-10-01T10:00:00.000Z", expiresAt: "2026-10-01T10:20:00.000Z", claimedAt: null,
    });
    assert.equal(await repo.mapPointPending.take(sid, "another"), null, "a take naming another row misses");
    assert.equal((await repo.mapPointPending.take(sid, "row-1"))?.id, "row-1");
    assert.equal(await repo.mapPointPending.take(sid, "row-1"), null, "and only one taker gets it");
    assert.ok(!(await repo.mapPointPending.list()).some((r) => r.serverId === sid));
  } finally {
    await pool.query("DELETE FROM map_point_pending WHERE server_id = $1", [sid]).catch(() => {});
    await pool.end();
  }
});

test("postgres: servers.remove takes a server's leftover objective-preset row with it, while a restore's bare DELETE FROM servers does not", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  const leftover = (serverId: string) => pool.query(
    `INSERT INTO map_point_pending (server_id, id, game, map_key, mode_key, map_id, phase, picks, expires_at)
     VALUES ($1, 'row', 'hll', 'foy', 'warfare', 'foy_warfare', 'await_load', '[]'::jsonb, '2026-10-01T10:05:00Z')`, [serverId]);
  const held = async (serverId: string) => (await repo.mapPointPending.list()).some((r) => r.serverId === serverId);
  try {
    await repo.migrate();
    const gone = await repo.servers.create({ name: "MP gone", host: "10.9.0.1", port: 1, password: "p" });
    const kept = await repo.servers.create({ name: "MP kept", host: "10.9.0.2", port: 2, password: "p" });
    for (const s of [gone, kept]) await leftover(s.id);

    assert.equal(await repo.servers.remove(gone.id), true);
    assert.equal(await held(gone.id), false);
    assert.equal(await held(kept.id), true, "only the removed server's row goes");
    assert.equal(await repo.servers.remove(gone.id), false);

    // No foreign key: the data-port restore wipes servers with a bare DELETE and re-inserts them,
    // and a cascade would lose a put-back still owed on every restore.
    await pool.query("DELETE FROM servers WHERE id = $1", [kept.id]);
    assert.equal(await held(kept.id), true, "an outstanding put-back outlives a bare DELETE FROM servers");
    await pool.query("DELETE FROM map_point_pending WHERE server_id = $1", [kept.id]);
  } finally {
    await pool.end();
  }
});

/*
 * One person's own settings in a plugin (`keep:viewer:` keys, in any plugin's store) stay out of
 * every archive: the export is read by every admin.data holder, and a row per person would name who
 * uses the plugin. The rest of plugin_kv — a plugin's other permanent rows included — travels as it
 * always has, and the counts agree.
 */
test("postgres data port: per-viewer settings rows stay behind, the rest of plugin_kv travels", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { gunzipSync } = await import("node:zlib");
  const { readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2);
    await repo.pluginKv.set("probe", `keep:viewer:user_${tag}`, { siteTtlSecs: 600 });
    await repo.pluginKv.set("other", `keep:viewer:user_${tag}`, { kept: true });
    await repo.pluginKv.set("probe", `keep:other_${tag}`, { kept: true });
    const file = join(mkdtempSync(join(tmpdir(), "data-port-kv-")), "kv.ndjson.gz");
    const res = await repo.dataPort.export(["settings"], file);
    const rows = gunzipSync(readFileSync(file)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l))
      .filter((l) => l.table === "plugin_kv").map((l) => `${l.row.namespace}|${l.row.key}`);
    assert.ok(!rows.includes(`probe|keep:viewer:user_${tag}`), "a person's own settings never reach the archive");
    assert.ok(!rows.includes(`other|keep:viewer:user_${tag}`), "in any plugin's store");
    assert.ok(rows.includes(`probe|keep:other_${tag}`), "the store's other rows travel");
    const { rows: [all] } = await pool.query("SELECT count(*)::int AS n FROM plugin_kv WHERE NOT (key LIKE 'keep:viewer:%')");
    assert.equal(res.tables.plugin_kv, all.n, "the archive carries exactly the rows the filter keeps");
    const counts = await repo.dataPort.counts(["settings"]);
    assert.equal(counts.settings, Object.entries(res.tables).reduce((n, [, v]) => n + v, 0), "counts agree with what the export writes");
    await pool.query("DELETE FROM plugin_kv WHERE key IN ($1, $2)", [`keep:viewer:user_${tag}`, `keep:other_${tag}`]);
  } finally {
    await pool.end();
  }
});

/*
 * The round's score timeline is published on CRCON's API (cap_flips, morale_history, match_time),
 * so it is checked here against real Postgres: each point appended as ONE element (a jsonb || of a
 * bare array would spread its three numbers), match_time and initial_morale set once and kept.
 */
test("postgres: a round's score timeline appends whole points and sets match_time once", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `timeline-${tag}`, host: "1.1.1.1", port: 28865, password: "p" });
    const m = await repo.matches.open({ serverId: server.id, map: "CAR_L_1944_Conquest_Day", startedAt: "2026-08-01T10:00:00.000Z" });
    assert.deepEqual([m.capFlips, m.moraleHistory, m.matchTime], [[], [], 0], "a new round starts empty");
    await repo.matches.recordTimeline(m.id, { flip: [30, 1, 0], morale: [30, 490, 470], matchTime: 3600, initialMorale: 500 });
    await repo.matches.recordTimeline(m.id, { flip: [400, 2, 0], morale: [400, 480, 460], matchTime: 9999, initialMorale: 1 });
    await repo.matches.recordTimeline(m.id, {});
    const got = await repo.matches.getOpen(server.id);
    assert.deepEqual(got?.capFlips, [[30, 1, 0], [400, 2, 0]]);
    assert.deepEqual(got?.moraleHistory, [[30, 490, 470], [400, 480, 460]]);
    assert.equal(got?.matchTime, 3600, "set once, as CRCON sets it only while it is 0");
    assert.equal(got?.crconInitialMorale, 500, "the first one stays");
    assert.equal(got?.initialMorale, null, "CRCON's initial_morale is its own column; ours is the live sample's");
  } finally {
    await pool.end();
  }
});

test("postgres: CRCON's record of a round's start is made once, and only fills what is unset", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `start-${tag}`, host: "1.1.1.1", port: 28866, password: "p" });
    const m = await repo.matches.open({ serverId: server.id, map: "CARENTAN Warfare", startedAt: "2026-08-01T10:00:00.000Z" });
    assert.deepEqual([m.crconMap, m.crconGuessed, m.crconInitialMorale], [null, null, null], "undecided until the worker decides");
    await repo.matches.recordStart(m.id, { map: "carentan_warfare_night", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.recordStart(m.id, { map: "carentan_warfare", guessed: true, matchTime: 1, initialMorale: 7 });
    let got = await repo.matches.getOpen(server.id);
    assert.deepEqual([got?.crconMap, got?.crconGuessed, got?.matchTime, got?.crconInitialMorale], ["carentan_warfare_night", false, 5400, 0], "the first decision stands");
    assert.equal(got?.map, "CARENTAN Warfare", "the log text is kept");
    // A replayed MATCH START re-opens the same row and keeps the decision.
    await repo.matches.open({ serverId: server.id, map: "CARENTAN Warfare", startedAt: "2026-08-01T10:00:00.000Z" });
    got = await repo.matches.getOpen(server.id);
    assert.equal(got?.crconMap, "carentan_warfare_night");
    // A match_time the recorder already set is not overwritten by a late start record.
    const late = await repo.matches.open({ serverId: server.id, map: "FOY Warfare", startedAt: "2026-08-01T12:00:00.000Z" });
    await repo.matches.recordTimeline(late.id, { matchTime: 4500 });
    await repo.matches.recordStart(late.id, { map: "foy_warfare", guessed: true, matchTime: 0, initialMorale: null });
    got = await repo.matches.getOpen(server.id);
    assert.deepEqual([got?.crconMap, got?.crconGuessed, got?.matchTime, got?.crconInitialMorale], ["foy_warfare", true, 4500, null]);
    // CRCON's verdict on the whistle, also made once.
    assert.equal(got?.crconEndDeferred, null);
    await repo.matches.recordEnd(late.id, { deferred: true });
    await repo.matches.recordEnd(late.id, { deferred: false });
    got = await repo.matches.getOpen(server.id);
    assert.equal(got?.crconEndDeferred, true);
  } finally {
    await pool.end();
  }
});

test("postgres: an event window reads past one page — the newest `limit` of it, oldest first", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const s = await repo.servers.create({ name: `win-${tag}`, host: "1.1.1.1", port: 28868, password: "p" });
    const t0 = Date.parse("2026-09-24T10:00:00.000Z");
    await repo.events.insert(Array.from({ length: 600 }, (_, i) => ({ serverId: s.id, ts: new Date(t0 + i * 1000).toISOString(), kind: "evt.kill", dedupeKey: `w${String(i).padStart(3, "0")}` })));
    assert.equal((await repo.events.query({ serverId: s.id, kinds: ["evt.kill"], limit: 20_000 })).length, 500, "a page stops at 500");
    const all = await repo.events.window({ serverId: s.id, kinds: ["evt.kill"], limit: 20_000 });
    assert.equal(all.length, 600);
    assert.deepEqual([all[0]!.dedupeKey, all[599]!.dedupeKey], ["w000", "w599"], "oldest first");
    const newest = await repo.events.window({ serverId: s.id, kinds: ["evt.kill"], from: new Date(t0 + 10_000).toISOString(), limit: 100 });
    assert.deepEqual([newest.length, newest[0]!.dedupeKey, newest[99]!.dedupeKey], [100, "w500", "w599"], "over the limit, the newest");
  } finally {
    await pool.end();
  }
});

test("postgres: a short round leaves our records but stays on CRCON's list, until its server's data goes", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `short-${tag}`, host: "1.1.1.1", port: 28867, password: "p" });
    const long = await repo.matches.open({ serverId: server.id, map: "FOY Warfare", startedAt: "2026-09-24T10:00:00.000Z" });
    await repo.matches.close(long.id, { endedAt: "2026-09-24T11:00:00.000Z", winner: null, alliedScore: 2, axisScore: 2, result: null });
    const short = await repo.matches.open({ serverId: server.id, map: "KURSK Warfare", startedAt: "2026-09-24T11:01:00.000Z" });
    await repo.matches.recordStart(short.id, { map: "kursk_warfare", guessed: false, matchTime: 5400, initialMorale: 0 });
    await repo.matches.recordTimeline(short.id, { flip: [20, 2, 2] });
    const players: CrconPlayerCache = [["76561190000000001", { combat: 5, p_combat: 50, offense: 0, p_offense: 0, defense: 0, p_defense: 0, support: 0, p_support: 0, vehicle_kills: 0, p_vehicle_kills: 0, vehicles_destroyed: 0, p_vehicles_destroyed: 0, kills_and_assists: 1, p_kills_and_assists: 4, deaths_and_redeploys: 0, p_deaths_and_redeploys: 1, p_unit: { ts: 160, team: 1, squad: 1, role: 0 }, units: [{ ts: 160, team: 1, squad: 1, role: 0 }], level: 40, p_coord: { x: 1.5, y: 2, z: 3 }, has_spawned: true, names: ["Able"], status: "online" }]];
    await repo.matches.saveCrconPlayers(short.id, players);
    assert.deepEqual(await repo.matches.crconPlayers(short.id), players, "saved and read back whole, in order");
    assert.equal(await repo.matches.discardShort(short.id, "2026-09-24T11:02:00.000Z", "`KURSK Warfare` ALLIED (2 - 2) AXIS"), true);
    assert.deepEqual((await repo.matches.list(server.id)).map((m) => m.id), [long.id], "gone from our records");
    assert.equal(await repo.matches.crconPlayers(short.id), null, "its own cache went with it");
    assert.deepEqual(await repo.matches.crconShortRoundPlayers(short.seq), players, "and CRCON's copy keeps the players");
    await repo.matches.saveCrconPlayers(short.id, players);
    assert.equal(await repo.matches.crconPlayers(short.id), null, "a deleted round takes no cache");
    const crcon = await repo.matches.crconRounds(server.id, 500, 0);
    assert.deepEqual(crcon.map((r) => [r.short, r.seq, r.crconMap, r.crconGuessed, r.endedAt, r.result, r.matchId, r.capFlips, r.matchTime]), [
      [true, short.seq, "kursk_warfare", false, "2026-09-24T11:02:00.000Z", "`KURSK Warfare` ALLIED (2 - 2) AXIS", null, [[20, 2, 2]], 5400],
      [false, long.seq, null, null, "2026-09-24T11:00:00.000Z", null, long.id, [], 0],
    ]);
    assert.deepEqual((await repo.matches.crconRounds(server.id, 1, 1)).map((r) => r.seq), [long.seq], "paged like the rest");
    await repo.crconSnapshot.purgeServerData(server.id);
    assert.deepEqual(await repo.matches.crconRounds(server.id, 500, 0), [], "the clean slate takes it too");
  } finally {
    await pool.end();
  }
});

/*
 * The game log's guard against storing a line twice indexes a hash of the line's key, not the key's
 * full text (the whole log line again, which made it the largest index on the largest table). The
 * guard must still hold exactly as before: the same line read twice is one row, while the same
 * text on another server, or in another second, is its own line.
 */
test("postgres: a game-log line read twice is stored once, guarded by a hash of its key rather than its text", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const here = await repo.servers.create({ name: `dedupe-${tag}`, host: "10.1.1.1", port: 1, password: "x" });
    const there = await repo.servers.create({ name: `dedupe2-${tag}`, host: "10.1.1.2", port: 1, password: "x" });
    const line = (serverId: string, ts: string) => ({
      serverId, ts, kind: "evt.kill", actorName: "Peter", victimName: "Robo", weapon: "M1918A2 BAR",
      dedupeKey: `1784761672|KILL: Peter(Allies/${tag}87e413ee56a32b73bc41) -> Robo(Axis/b491452aed63925c9fdf) with M1918A2 BAR`,
    });
    const t = "2026-10-01T00:00:00.000Z";
    assert.equal((await repo.events.insert([line(here.id, t)])).length, 1);
    assert.equal((await repo.events.insert([line(here.id, t)])).length, 0, "the same line read again is not stored twice");
    assert.equal((await repo.events.insert([line(there.id, t)])).length, 1, "another server's identical line is its own");
    assert.equal((await repo.events.insert([line(here.id, "2026-10-01T00:00:01.000Z")])).length, 1, "and so is the same text a second later");
    const count = async (serverId: string) => (await pool.query("SELECT count(*)::int AS n FROM evt WHERE server_id = $1", [serverId])).rows[0].n as number;
    assert.equal(await count(here.id), 2);
    assert.equal(await count(there.id), 1);
    // The key itself is kept on the row, whole: it still orders a second's lines and marks imports.
    const keys = (await pool.query("SELECT DISTINCT dedupe_key FROM evt WHERE server_id = $1", [here.id])).rows.map((r) => r.dedupe_key as string);
    assert.deepEqual(keys, [line(here.id, t).dedupeKey]);
    // The guard is the key's hash; no index holds the key's full text any more.
    // This database's own tables only: the upgrade tests build older schemas beside it, with the old indexes.
    const defs = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'evt'")).rows.map((r) => r.indexdef as string);
    assert.ok(defs.some((d) => /^CREATE UNIQUE INDEX .*\(server_id, \(\(md5\(dedupe_key\)\)::uuid\), ts\)/.test(d)), `the unique guard is on md5(dedupe_key): ${defs.join(" | ")}`);
    assert.ok(!defs.some((d) => /\(server_id, dedupe_key, ts\)/.test(d)), "and the full-text index is gone");
  } finally {
    await pool.end();
  }
});

/*
 * Indexes no query can use are not kept: each one is written on every insert or update of its
 * table. player_stats is updated on every batch of kills, and its leaderboard adds a player's rows
 * up before sorting, so only the primary key and one per-server index (the server filter) serve it.
 * roster_snapshots had its (server_id, ts) index twice; matches had (server_id, started_at) twice,
 * once reversed.
 */
test("postgres: only indexes a query can use are kept on player_stats, roster_snapshots and matches", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const indexes = async (table: string) =>
      // This database's own tables only: the upgrade tests build older schemas beside it, with the old indexes.
      (await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY indexname", [table])).rows as { indexname: string; indexdef: string }[];
    assert.deepEqual((await indexes("player_stats")).map((r) => r.indexname), ["player_stats_pkey", "player_stats_server_kills_idx"]);
    const roster = (await indexes("roster_snapshots")).filter((r) => /\(server_id, ts\)$/.test(r.indexdef));
    assert.equal(roster.length, 1, "one (server_id, ts) index on the roster samples");
    assert.match(roster[0]!.indexdef, /^CREATE UNIQUE INDEX/, "and it is the unique one");
    const rounds = (await indexes("matches")).filter((r) => /\(server_id, started_at( DESC)?\)$/.test(r.indexdef));
    assert.deepEqual(rounds.map((r) => r.indexname), ["matches_server_id_started_at_key"], "one (server_id, started_at) index on the rounds");
    // The reads they served still run: a one-server leaderboard, and a server's rounds newest first.
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `idx-${tag}`, host: "10.2.2.2", port: 1, password: "x" });
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `idx-${tag}`, name: "Ida" });
    await repo.stats.bump(player.id, server.id, { kills: 4, deaths: 2 });
    assert.deepEqual((await repo.stats.leaderboard("kills", 5, [server.id])).map((e) => [e.playerId, e.kills]), [[player.id, 4]]);
    const first = await repo.matches.open({ serverId: server.id, map: "A", startedAt: "2026-10-01T10:00:00.000Z" });
    const second = await repo.matches.open({ serverId: server.id, map: "B", startedAt: "2026-10-01T12:00:00.000Z" });
    assert.deepEqual((await repo.matches.list(server.id, 5, 0)).map((m) => m.id), [second.id, first.id]);
  } finally {
    await pool.end();
  }
});

/*
 * The score series packed (migration 151, score-series-pack.ts). A round played before the update
 * keeps its plain points, and reads exactly as it did; the round being played moves over on its
 * next point, so no row ever holds the series twice. Writers of one round take turns: each reads
 * the series, adds its point and writes the series back, so two that interleaved would each write
 * back a series lacking the other's point.
 */
test("postgres: a score series is stored packed; a row from before reads as it was and moves over on its next point", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { unpackScoreSeries } = await import("../dist/score-series-pack.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `series-${tag}`, host: "10.3.3.3", port: 1, password: "x" });
    const player = (name: string) => repo.players.upsert({ game: "hll", platform: "steam", platformId: `series-${name}-${tag}`, name });
    const ana = await player("Ana"), bob = await player("Bob"), cy = await player("Cy");
    const pt = (platformId: string, sec: number, combat: number, offense = 0, defense = 0, support = 0) =>
      ({ platformId, sec, combat, offense, defense, support });
    const stored = async (matchId: string, playerId: string) =>
      (await pool.query("SELECT points, packed FROM match_score_series WHERE match_id = $1 AND player_id = $2", [matchId, playerId]))
        .rows[0] as { points: number[]; packed: Buffer | null } | undefined;
    const m = await repo.matches.open({ serverId: server.id, map: "FOY Warfare", startedAt: new Date(Date.now() - 3_600_000).toISOString() });

    // Ana's row as the old code left it: plain points, no packed bytes.
    const before = [60, 5, 0, 0, 0, 120, 9, 40, 0, 0];
    await pool.query("INSERT INTO match_score_series (match_id, player_id, points) VALUES ($1, $2, $3)", [m.id, ana.id, before]);
    assert.deepEqual((await repo.matches.scoreSeries(m.id)).get(ana.id), before, "read exactly as it was written");
    // A point repeating its last totals is dropped as it always was, and the row is not touched.
    await repo.matches.appendScoreSeries(m.id, [pt(ana.platformId, 180, 9, 40)]);
    assert.deepEqual(await stored(m.id, ana.id), { points: before, packed: null });
    // Its next real point moves it over: the plain points go, the packed bytes hold the lot.
    await repo.matches.appendScoreSeries(m.id, [pt(ana.platformId, 240, 30, 40, 0, 150), pt(bob.platformId, 240, 2)]);
    const moved = await stored(m.id, ana.id);
    assert.deepEqual(moved?.points, [], "no row holds its series twice");
    assert.deepEqual(unpackScoreSeries(moved!.packed!), [...before, 240, 30, 40, 0, 150]);
    const fresh = await stored(m.id, bob.id);
    assert.deepEqual(fresh?.points, [], "a new row is packed from its first point");
    assert.deepEqual(unpackScoreSeries(fresh!.packed!), [240, 2, 0, 0, 0]);
    assert.deepEqual((await repo.matches.scoreSeries(m.id)).get(ana.id), [...before, 240, 30, 40, 0, 150]);

    // A whole round: about a quarter of the plain ints' size, each minute's rewrite included.
    let [combat, offense, defense, support] = [0, 0, 0, 0];
    const flat: number[] = [];
    for (let minute = 1; minute <= 90; minute++) {
      combat += (minute * 7) % 23; offense += (minute * 13) % 41; defense += (minute * 5) % 37; support += minute % 4 === 0 ? 150 : 0;
      flat.push(minute * 60, combat, offense, defense, support);
      await repo.matches.appendScoreSeries(m.id, [pt(cy.platformId, minute * 60, combat, offense, defense, support)]);
    }
    assert.deepEqual((await repo.matches.scoreSeries(m.id)).get(cy.id), flat);
    const { rows: [size] } = await pool.query(
      "SELECT octet_length(packed) AS packed, pg_column_size($3::int[]) AS plain FROM match_score_series WHERE match_id = $1 AND player_id = $2",
      [m.id, cy.id, flat]);
    assert.ok(size.packed <= size.plain * 0.3, `${size.packed} bytes packed against ${size.plain} as plain ints`);

    // Writers of one round take turns: twelve points written at once all land.
    const burst = Array.from({ length: 12 }, (_, i) => pt(bob.platformId, 300 + i * 60, 10 + i));
    await Promise.all(burst.map((p) => repo.matches.appendScoreSeries(m.id, [p])));
    const bobs = (await repo.matches.scoreSeries(m.id)).get(bob.id)!;
    const secs = Array.from({ length: bobs.length / 5 }, (_, i) => bobs[i * 5]!).sort((a, b) => a - b);
    assert.deepEqual(secs, [240, ...burst.map((p) => p.sec)], "no point lost to another writer's");
  } finally {
    await pool.end();
  }
});

/*
 * Archives carry the series as stored. A bytea value is written as Postgres's own text for bytes
 * (`\x` and hex) and goes straight back into the column; a row from before the packing restores
 * its plain points as an array (it used to be refused, stringified as json into an int[]).
 */
test("postgres data port: a round's score series comes back from an export, packed or from before the packing", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { gunzipSync, gzipSync } = await import("node:zlib");
  const { readFileSync, writeFileSync, mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `port-series-${tag}`, host: "10.4.4.4", port: 1, password: "x" });
    const ana = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `port-series-ana-${tag}`, name: "Ana" });
    const bob = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `port-series-bob-${tag}`, name: "Bob" });
    // A round from 2001: the trim below reaches nothing another test made.
    const m = await repo.matches.open({ serverId: server.id, map: "FOY Warfare", startedAt: "2001-02-01T10:00:00.000Z" });
    const pt = (platformId: string, sec: number, combat: number, support = 0) => ({ platformId, sec, combat, offense: 0, defense: 0, support });
    await repo.matches.appendScoreSeries(m.id, [pt(ana.platformId, 60, 3, 300)]);
    await repo.matches.appendScoreSeries(m.id, [pt(ana.platformId, 120, 1, 2000)]);
    const old = [60, 5, 0, 0, 0, 120, 9, 40, 0, 0];
    await pool.query("INSERT INTO match_score_series (match_id, player_id, points) VALUES ($1, $2, $3)", [m.id, bob.id, old]);
    await repo.matches.close(m.id, { endedAt: "2001-02-01T11:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    const series = await repo.matches.scoreSeries(m.id);
    assert.deepEqual(series.get(ana.id), [60, 3, 0, 0, 300, 120, 1, 0, 0, 2000]);

    const dir = mkdtempSync(join(tmpdir(), "port-series-"));
    const file = join(dir, "matches.ndjson.gz");
    await repo.dataPort.export(["matches"], file);
    const lines = (path: string) => gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
    const anaLine = lines(file).find((l) => l.table === "match_score_series" && l.row.player_id === ana.id);
    assert.match(anaLine?.row.packed, /^\\x[0-9a-f]+$/, "the bytes as Postgres writes them in text");
    // Only this round's lines are imported back: the rest of the archive is other tests' rows,
    // some of which they may have deleted since.
    const ours = join(dir, "ours.ndjson.gz");
    writeFileSync(ours, gzipSync(lines(file).filter((l) => l.header || (l.table === "matches" && l.row.id === m.id)
      || (l.table === "match_score_series" && l.row.match_id === m.id)).map((l) => JSON.stringify(l)).join("\n")));

    await pool.query("DELETE FROM matches WHERE id = $1", [m.id]); // the series go with the round
    assert.equal((await repo.matches.scoreSeries(m.id)).size, 0);
    const report = await repo.dataPort.import(ours);
    assert.equal(report.matches?.inserted, 1);
    assert.equal(report.match_score_series?.inserted, 2);
    assert.equal(report.match_score_series?.failed, 0, `nothing refused: ${report.match_score_series?.error}`);
    assert.deepEqual(await repo.matches.scoreSeries(m.id), series, "both rows back exactly");

    // A trim's backup holds the same text for the bytes.
    const trimDir = mkdtempSync(join(tmpdir(), "trim-series-"));
    await repo.trimData.run(["matches"], "2001-02-01T12:00:00.000Z", trimDir);
    const archive = readdirSync(trimDir).find((f) => f.startsWith("trim-matches-"));
    const trimmed = lines(join(trimDir, archive!)).find((l) => l.table === "match_score_series" && l.row.player_id === ana.id);
    assert.equal(trimmed?.row.packed, anaLine.row.packed);
  } finally {
    await pool.end();
  }
});

/*
 * A kill's sides in their short spelling (compact-json.ts): a list of the four values instead of
 * an object naming each one, on every kill row. Read back exactly by every reader, since all of
 * them go through the store's row mapper; a kill row written before the packing reads as it was.
 */
test("postgres: a kill's sides are stored in the short spelling and read back exactly; rows from before read as they were", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { randomUUID } = await import("node:crypto");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const server = await repo.servers.create({ name: `kills-${tag}`, host: "10.5.5.5", port: 1, password: "x" });
    const live = { playerTeam: "Allies", victimTeam: "Axis", actorSide: "allies", victimSide: "axis" };
    const teamkill = { playerTeam: "Axis", victimTeam: "Axis", actorSide: "axis", victimSide: "axis" };
    const unnamed = { playerTeam: "Allies", victimTeam: null, actorSide: "allies", victimSide: null };
    const imported = { actorSide: "axis", victimSide: "allies" };
    const chat = { message: "gg" };
    const ev = (n: number, kind: string, data: Record<string, unknown> | null) => ({
      serverId: server.id, ts: `2026-09-0${n}T10:00:00.000Z`, kind, actorName: "Ana", victimName: "Bob", weapon: "M1 GARAND", data, dedupeKey: `kills-${tag}-${n}`,
    });
    const written = await repo.events.insert([ev(1, "evt.kill", live), ev(2, "evt.teamkill", teamkill), ev(3, "evt.kill", unnamed),
      ev(4, "evt.kill", imported), ev(5, "evt.chat.all", chat), ev(6, "evt.kill", null)]);
    assert.deepEqual(written.map((e) => e.data), [live, teamkill, unnamed, imported, chat, null], "the inserted rows handed back as they came");
    // A kill row as the old code wrote it.
    await pool.query("INSERT INTO evt (id, server_id, ts, kind, actor_name, data, dedupe_key) VALUES ($1, $2, '2026-09-07T10:00:00Z', 'evt.kill', 'Ana', $3, $4)",
      [randomUUID(), server.id, JSON.stringify(live), `kills-${tag}-7`]);

    const raw = (await pool.query("SELECT data, pg_column_size(data) AS bytes FROM evt WHERE server_id = $1 ORDER BY ts", [server.id])).rows;
    assert.deepEqual(raw.map((r) => r.data), [
      ["Allies", "Axis", "allies", "axis"], ["Axis", "Axis", "axis", "axis"], ["Allies", null, "allies", null],
      [false, false, "axis", "allies"], chat, null, live,
    ]);
    assert.ok(raw[0].bytes < raw[6].bytes / 2, `${raw[0].bytes} bytes against ${raw[6].bytes} for the same kill`);
    const read = (await repo.events.listRecent(server.id, 10)).reverse();
    assert.deepEqual(read.map((e) => e.data), [live, teamkill, unnamed, imported, chat, null, live], "every row reads as it was written");
  } finally {
    await pool.end();
  }
});

/*
 * A roster sample's composition in its short spelling: each side's figures in a list, the top
 * level's role counts (the sides' added up) left out. Every reader gets the composition exactly
 * as written: the sample lists, the composition analytics, and the hour grid, whose SQL reads the
 * figures in place. A sample written before the packing reads as it was, beside packed ones. The
 * memory store keeps compositions as given, so it is the reference here.
 */
test("postgres: a roster sample's composition is stored in the short spelling; old and new samples read alike, the hour grid included", { skip: !DB }, async () => {
  const { PostgresRepository } = await import("../dist/postgres.js");
  const { InMemoryRepository } = await import("../dist/memory.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = new PostgresRepository(pool);
  try {
    await repo.migrate();
    const tag = Math.random().toString(36).slice(2, 8);
    const comp = (allies: number, axis: number, noSl: [string[], string[]], unsquadded: [number, number]) => ({
      players: allies + axis + 1, unassigned: 1, byRole: { 1: allies + axis - 2, 9: 2, 13: 1 },
      bySide: {
        allies: { players: allies, squads: 3, noSlSquads: noSl[0], unsquadded: unsquadded[0], byRole: { 1: allies - 1, 9: 1 } },
        axis: { players: axis, squads: 3, noSlSquads: noSl[1], unsquadded: unsquadded[1], byRole: { 1: axis - 1, 9: 1 } },
      },
    });
    const old = comp(30, 26, [["ABLE"], ["BAKER", "DOG"]], [2, 3]);
    const fresh = comp(31, 28, [[], ["CHARLIE"]], [0, 5]);
    const mem = new InMemoryRepository();
    const pgServer = await repo.servers.create({ name: `roster-${tag}`, host: "10.6.6.6", port: 1, password: "x" });
    const memServer = await mem.servers.create({ name: `roster-${tag}`, host: "10.6.6.6", port: 1, password: "x" });
    // The sample before the update, as the old code wrote it; then one written now.
    await pool.query("INSERT INTO roster_snapshots (server_id, game, ts, player_count, composition) VALUES ($1, 'hll', '2026-09-01T10:05:00Z', 57, $2)",
      [pgServer.id, JSON.stringify(old)]);
    await repo.rosterSnapshots.record({ serverId: pgServer.id, ts: "2026-09-01T11:05:00.000Z", playerCount: 60, composition: fresh });
    await mem.rosterSnapshots.record({ serverId: memServer.id, ts: "2026-09-01T10:05:00.000Z", playerCount: 57, composition: old });
    await mem.rosterSnapshots.record({ serverId: memServer.id, ts: "2026-09-01T11:05:00.000Z", playerCount: 60, composition: fresh });

    const raw = (await pool.query("SELECT composition, pg_column_size(composition) AS bytes FROM roster_snapshots WHERE server_id = $1 ORDER BY ts", [pgServer.id])).rows;
    assert.ok(raw[1].composition.b && !raw[1].composition.bySide, "the new sample is packed");
    assert.equal(raw[1].composition.byRole, undefined, "with the top level's role counts left out");
    assert.ok(raw[1].bytes < raw[0].bytes * 0.8, `${raw[1].bytes} bytes against ${raw[0].bytes}`);

    const win = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" };
    assert.deepEqual((await repo.rosterSnapshots.list({ ...win, serverId: pgServer.id })).map((r) => r.composition), [old, fresh]);
    assert.deepEqual((await repo.rosterSnapshots.latest(pgServer.id))?.composition, fresh);
    assert.deepEqual(await repo.analytics.composition({ ...win, serverId: pgServer.id }), await mem.analytics.composition({ ...win, serverId: memServer.id }));
    for (const metric of ["imbalance", "noLeader", "unsquadded"] as const) {
      const cells = async (r: typeof repo | typeof mem, serverId: string) =>
        (await r.analytics.hourGrid({ ...win, serverId, tz: "UTC" }, metric)).flatMap((d) => d.hours.map((v, h) => [d.date, h, v])).filter(([, , v]) => v !== null);
      const got = await cells(repo, pgServer.id);
      assert.equal(got.length, 2, `${metric}: both hours have a figure`);
      assert.deepEqual(got, await cells(mem, memServer.id), metric);
    }
  } finally {
    await pool.end();
  }
});

/*
 * The install's own settings follow the RCON-password policy: a secret is sealed at rest when there
 * is an ENCRYPTION_KEY, a setting that is not secret is stored as it is, and a secret sealed under
 * a key this install no longer holds reads as unset — so getOrCreate makes a new one in its place
 * instead of every boot failing on a value nobody can open.
 */
test("postgres install settings: a secret is sealed at rest, and one sealed under a lost key reads as unset and is replaced", { skip: !DB }, async () => {
  const { createPostgresRepository } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: DB });
  const repo = await createPostgresRepository(DB!);
  const key = `test.seal.${Math.random().toString(36).slice(2, 8)}`;
  const raw = async (k: string) => (await pool.query("SELECT value FROM install_settings WHERE key = $1", [k])).rows[0]?.value as string | undefined;
  try {
    process.env.ENCRYPTION_KEY = "install-key-one";
    await repo.installSettings.set(key, "s3cret", { secret: true, by: "owner" });
    await repo.installSettings.set(`${key}.plain`, "stats.example.com");
    assert.match((await raw(key))!, /^enc:v1:/, "the database holds ciphertext");
    assert.equal(await raw(`${key}.plain`), "stats.example.com", "a setting that is not secret is stored as it is");
    assert.equal(await repo.installSettings.get(key), "s3cret", "the app reads the secret back");
    process.env.ENCRYPTION_KEY = "a-different-key";
    assert.equal(await repo.installSettings.get(key), null, "sealed under a key this install lacks: unset, not an error");
    assert.equal(await repo.installSettings.getOrCreate(key, () => "fresh", { secret: true }), "fresh", "and replaced by getOrCreate");
    assert.equal(await repo.installSettings.get(key), "fresh");
    assert.match((await raw(key))!, /^enc:v1:/, "the replacement is sealed too");
  } finally {
    delete process.env.ENCRYPTION_KEY;
    await pool.query("DELETE FROM install_settings WHERE key LIKE $1", [`${key}%`]).catch(() => {});
    await pool.end();
    await repo.close?.().catch(() => {});
  }
});
