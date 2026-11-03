import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 134: layouts are learned from players walking out of their own end now, so the votes
 * cast the old way — on where team labels stood when a round began — are dropped rather than left
 * to outvote the new ones. The table itself stays, ready for the next round's vote.
 */
const DB = process.env.DATABASE_URL;

test("migration 134: the old layout votes are dropped, the table stays", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up134_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "134")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }
    await q("INSERT INTO map_layouts (map_id, x_neg, y_pos, separation, last_round) VALUES ('foy_warfare', 3, 1, 90000, 'm1'), ('carentan_warfare', 0, 2, 70000, 'm2')");

    const m134 = MIGRATIONS.find((x) => x.id.startsWith("134"));
    assert.ok(m134, "migration 134 exists");
    await q("BEGIN"); await q(m134.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m134.id]); await q("COMMIT");

    assert.equal((await q("SELECT count(*)::int AS n FROM map_layouts")).rows[0].n, 0, "every old vote is gone");
    await q("INSERT INTO map_layouts (map_id, y_neg, last_round) VALUES ('foy_warfare', 1, 'm3')");
    assert.equal((await q("SELECT y_neg FROM map_layouts WHERE map_id = 'foy_warfare'")).rows[0].y_neg, 1, "and the next vote lands");
  } finally {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
