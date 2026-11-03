import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 135: a seeding area now judges a player only on the other team's painted ground, so the
 * stock rule wording ("Leaving your team's seeding area") told players, in every greeting, to stay
 * off the free middle. Configs still on that old default get the new one; a server's own wording
 * is never touched, and new configs start on the new default.
 */
const DB = process.env.DATABASE_URL;

test("migration 135: the stock seeding-area wording follows the rule, a server's own wording stays", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up135_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "135")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }
    const S1 = "00000000-0000-4000-8000-000000000001";
    const S2 = "00000000-0000-4000-8000-000000000002";
    const S3 = "00000000-0000-4000-8000-000000000003";
    for (const id of [S1, S2, S3]) {
      await q("INSERT INTO servers (id, name, host, port, password) VALUES ($1, $2, '127.0.0.1', 1, 'x')", [id, `srv ${id.slice(-1)}`]);
    }
    await q("INSERT INTO seeding_config (server_id) VALUES ($1)", [S1]); // the column's old default
    await q("INSERT INTO seeding_config (server_id, contain_notice) VALUES ($1, $2)", [S2, "Stay off the enemy's side"]);

    const m135 = MIGRATIONS.find((x) => x.id.startsWith("135"));
    assert.ok(m135, "migration 135 exists");
    await q("BEGIN"); await q(m135.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m135.id]); await q("COMMIT");

    const notice = async (id: string) => (await q("SELECT contain_notice FROM seeding_config WHERE server_id = $1", [id])).rows[0].contain_notice as string;
    assert.equal(await notice(S1), "Going onto the other team's ground (watch the map)", "the old default follows the rule");
    assert.equal(await notice(S2), "Stay off the enemy's side", "a server's own wording stays exactly as written");
    await q("INSERT INTO seeding_config (server_id) VALUES ($1)", [S3]);
    assert.equal(await notice(S3), "Going onto the other team's ground (watch the map)", "and a new config starts on the new default");
  } finally {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
