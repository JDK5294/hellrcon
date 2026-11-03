import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 033 against a database that ALREADY HOLDS ROUNDS — the upgrade, not the install.
 *
 * Every other Postgres test starts from an empty schema and applies the whole chain, so 033's
 * backfill runs over zero rows there and proves nothing about the case that actually happens: a
 * live install with thousands of imported rounds, where the migration has to number every one of
 * them, flip the column to NOT NULL, and hand the sequence over for the rounds that follow. Get
 * that wrong and the upgrade either fails halfway or silently renumbers history — and `seq` is
 * the id the public site puts in shareable links.
 *
 * Runs its own chain by hand (001..032, then 033) in a dedicated schema, so it can observe the
 * before/after that `repo.migrate()` hides. Skipped without DATABASE_URL, like its siblings.
 */
const DB = process.env.DATABASE_URL;

test("migration 033: rounds that already exist get numbered, in order, once", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  // Its own schema, because this test builds a whole world and must not touch the sibling
  // suites' tables — and a single CLIENT rather than a pool, because `search_path` is a
  // per-connection setting: a pool hands out whichever connection is free, so half the
  // statements would have landed in `public` and the assertions would read a mixture.
  const schema = `up033_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

    // --- The world as it stands before the upgrade ---
    for (const m of MIGRATIONS.filter((x) => x.id < "033")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }
    const mkServer = async (name: string, host: string): Promise<string> => (await q(
      `INSERT INTO servers (id, name, game, protocol, host, port, password, engagement_mode)
       VALUES (gen_random_uuid(), $1, 'hll', 'binary-v2', $2, 1, 'x', 'observe') RETURNING id`, [name, host])).rows[0].id;
    const a = await mkServer("Alpha", "10.0.0.1");
    const b = await mkServer("Bravo", "10.0.0.2");

    // Inserted OUT of chronological order and with the same start on two servers — both are
    // ordinary in an import, and both must still come out of the backfill totally ordered.
    const starts: [string, string][] = [
      [a, "2026-03-01T10:00:00Z"], [b, "2026-01-01T10:00:00Z"], [a, "2026-02-01T10:00:00Z"],
      [b, "2026-02-01T10:00:00Z"], [a, "2026-01-01T10:00:00Z"],
    ];
    const newest = new Map<string, string>();
    for (const [s, when] of starts) if (!newest.has(s) || when > newest.get(s)!) newest.set(s, when);
    for (const [s, when] of starts) {
      // All finished but the newest per server: only one round may be open at a time.
      const open = newest.get(s) === when;
      await q(
        `INSERT INTO matches (id, server_id, map, started_at, ended_at) VALUES (gen_random_uuid(), $1, 'foy_warfare', $2, $3)`,
        [s, when, open ? null : new Date(Date.parse(when) + 3.6e6).toISOString()],
      );
    }

    // --- The upgrade ---
    const m033 = MIGRATIONS.find((x) => x.id.startsWith("033"));
    assert.ok(m033, "migration 033 exists");
    await q("BEGIN"); await q(m033.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m033.id]); await q("COMMIT");

    // --- What the public surface then depends on ---
    const rows = (await q("SELECT seq, started_at FROM matches ORDER BY seq")).rows as { seq: string; started_at: Date }[];
    assert.deepEqual(rows.map((r) => Number(r.seq)), [1, 2, 3, 4, 5], "every existing round is numbered 1..n, no gaps");
    const times = rows.map((r) => new Date(r.started_at).getTime());
    assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]!), "numbering follows start order, so history reads chronologically");

    const col = (await q(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'matches' AND column_name = 'seq'`, [schema])).rows[0];
    assert.equal(col?.is_nullable, "NO", "seq is NOT NULL once every row has one");
    assert.match(String(col?.column_default ?? ""), /nextval/, "new rows draw from the sequence");

    // The number a link carries must never be reused: a round created after the upgrade continues
    // past the backfilled ones rather than colliding with one.
    const next = (await q(
      `INSERT INTO matches (id, server_id, map, started_at, ended_at)
       VALUES (gen_random_uuid(), $1, 'carentan_warfare', '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z') RETURNING seq`, [a])).rows[0];
    assert.equal(Number(next.seq), 6, "the sequence continues past the backfill");

    // The server columns behind /stats/<slug>, including the uniqueness that stops two servers
    // answering one public address — enforced by the database, not just the route.
    await q("UPDATE servers SET public_slug = 'nam' WHERE id = $1", [a]);
    await assert.rejects(
      () => q("UPDATE servers SET public_slug = 'nam' WHERE id = $1", [b]),
      (e: { code?: string }) => e.code === "23505",
      "a second server cannot take a slug that is already an address",
    );
    assert.equal((await q("SELECT count(*)::int AS n FROM servers WHERE streamer_mode = true")).rows[0].n, 0,
      "upgrading publishes nothing — every server stays dark until staff say otherwise");

    // Re-running the migration must not renumber history: the links people already shared point
    // at these integers.
    const before = rows.map((r) => Number(r.seq)).concat(Number(next.seq));
    await q("BEGIN"); await q(m033.sql); await q("COMMIT");
    const after = (await q("SELECT seq FROM matches ORDER BY seq")).rows.map((r: { seq: string }) => Number(r.seq));
    assert.deepEqual(after, before, "re-applying 033 renumbers nothing");
  } finally {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
