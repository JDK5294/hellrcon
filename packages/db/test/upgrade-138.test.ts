import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 138. A round shorter than five minutes is not a game: the "0m" rounds in the match
 * list each handed everyone on them a played (and, closed by a whistle, a win), and the sampler
 * credited a round opened on the end screen with the whole last round's scores. The migration
 * takes back what each stored short round gave careers — only what it gave: an imported round
 * never touched one — and drops them, with an audit row per server; real rounds stay, and every
 * live round is marked as having credited its scores, so the sampler's new gate cannot count
 * them a second time.
 */
const DB = process.env.DATABASE_URL;

test("migration 138: short rounds are taken back off careers and dropped; real rounds and imports' careers are left alone", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up138_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "138")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }
    const sid = "00000000-0000-4000-8000-000000000138";
    await q("INSERT INTO servers (id, name, host, port, password) VALUES ($1, 'Vietnam', '127.0.0.1', 1, 'x')", [sid]);
    const ana = "00000000-0000-4000-8000-00000000a138", bo = "00000000-0000-4000-8000-00000000b138";
    await q("INSERT INTO players (id, platform, platform_id, name) VALUES ($1, 'steam', '76561198000000138', 'Ana'), ($2, 'steam', '76561198000000139', 'Bo')", [ana, bo]);
    const round = async (id: string, startedAt: string, endedAt: string | null, settled: boolean) =>
      q("INSERT INTO matches (id, server_id, map, started_at, ended_at, winner, settled_at) VALUES ($1, $2, 'KURSK Warfare', $3, $4, 'axis', $5)",
        [id, sid, startedAt, endedAt, settled ? endedAt : null]);
    const line = (matchId: string, playerId: string, combat: number, won: boolean | null) =>
      q("INSERT INTO player_match_stats (match_id, player_id, server_id, combat, support, won) VALUES ($1, $2, $3, $4, $4, $5)", [matchId, playerId, sid, combat, won]);

    const real = "00000000-0000-4000-8000-000000001001", phantom = "00000000-0000-4000-8000-000000001002";
    const imported = "00000000-0000-4000-8000-000000001003", open = "00000000-0000-4000-8000-000000001004";
    // A real round, then the end-screen round closed 35 seconds after it opened.
    await round(real, "2026-10-11T12:00:00Z", "2026-10-11T13:05:00Z", true);
    await line(real, ana, 2000, false); await line(real, bo, 1500, true);
    await round(phantom, "2026-10-11T13:05:05Z", "2026-10-11T13:05:40Z", true);
    await line(phantom, ana, 2000, false); await line(phantom, bo, 1500, true);
    // A short round from the CRCON archive: lines, but never settled and never in a career.
    await round(imported, "2026-09-01T10:00:00Z", "2026-09-01T10:02:00Z", false);
    await line(imported, ana, 50, null);
    // The round on the server now.
    await round(open, "2026-10-11T13:07:00Z", null, false);
    // Careers as the old code left them: the real round, plus the phantom counted again.
    await q(`INSERT INTO player_stats (player_id, server_id, kills, combat, support, matches_played, matches_won)
             VALUES ($1, $3, 40, 4000, 4000, 2, 0), ($2, $3, 25, 3000, 3000, 2, 2)`, [ana, bo, sid]);

    const m138 = MIGRATIONS.find((x) => x.id.startsWith("138"));
    assert.ok(m138, "migration 138 exists");
    await q("BEGIN"); await q(m138.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m138.id]); await q("COMMIT");

    const rounds = (await q("SELECT id, scores_credited FROM matches ORDER BY started_at")).rows as { id: string; scores_credited: boolean }[];
    assert.deepEqual(rounds.map((r) => r.id), [real, open], "the end-screen round and the imported two-minute round are gone");
    assert.deepEqual(rounds.map((r) => r.scores_credited), [true, true], "every live round is marked as having credited its scores");
    assert.equal((await q("SELECT count(*)::int AS n FROM player_match_stats WHERE match_id = ANY($1)", [[phantom, imported]])).rows[0].n, 0, "their scoreboards went with them");
    assert.equal((await q("SELECT count(*)::int AS n FROM player_match_stats WHERE match_id = $1", [real])).rows[0].n, 2, "the real round's scoreboard stays");

    const career = async (id: string) => (await q("SELECT kills, combat, support, matches_played, matches_won FROM player_stats WHERE player_id = $1", [id])).rows[0];
    assert.deepEqual({ ...(await career(ana)), combat: Number((await career(ana)).combat), support: Number((await career(ana)).support) },
      { kills: 40, combat: 2000, support: 2000, matches_played: 1, matches_won: 0 },
      "Ana: the phantom's game played and its scores come off; the import's 50 never went on, so nothing more does; kills stay");
    assert.deepEqual({ ...(await career(bo)), combat: Number((await career(bo)).combat), support: Number((await career(bo)).support) },
      { kills: 25, combat: 1500, support: 1500, matches_played: 1, matches_won: 1 },
      "Bo: the phantom's win comes off too");

    const audit = (await q("SELECT actor_name, action, server_id, data, summary FROM audit")).rows;
    assert.equal(audit.length, 1, "one audit row for the server");
    assert.equal(audit[0].action, "app.short_rounds");
    assert.equal(audit[0].server_id, sid);
    assert.equal(audit[0].data.rounds, 2);
    assert.match(audit[0].summary, /removed 2 rounds shorter than five minutes/);
  } finally {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
