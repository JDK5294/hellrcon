import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 136: one switch per job on the ground rules. The zones answer to contain_enabled
 * alone and steamroll protection to pace_enabled alone, where before the auto fence also needed
 * contain_auto_enabled and positional_enabled, and the pace rule positional_enabled. So nothing
 * starts punishing on its own: a switch that would now enforce more than it did is turned off.
 * Everything that enforced before still does, and the cap-fight switch is left as it was.
 */
const DB = process.env.DATABASE_URL;

test("migration 136: a switch that would now enforce more is turned off; everything else is left alone", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up136_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "136")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }
    // [contain, auto, positional, pace] before → [contain, positional, pace] after
    const rows: [string, boolean, boolean, boolean, boolean][] = [
      ["00000000-0000-4000-8000-000000000001", true, true, true, true],    // everything was really on
      ["00000000-0000-4000-8000-000000000002", true, false, false, true],  // painted only; pace held back
      ["00000000-0000-4000-8000-000000000003", true, true, false, false],  // auto set, but held by the master
      ["00000000-0000-4000-8000-000000000004", false, false, true, false], // the cap fight by position alone
      ["00000000-0000-4000-8000-000000000005", false, false, false, false], // all off
    ];
    for (const [id, contain, auto, positional, pace] of rows) {
      await q("INSERT INTO servers (id, name, host, port, password) VALUES ($1, $2, '127.0.0.1', 1, 'x')", [id, `srv ${id.slice(-1)}`]);
      await q("INSERT INTO seeding_config (server_id, contain_enabled, contain_auto_enabled, positional_enabled, pace_enabled) VALUES ($1, $2, $3, $4, $5)",
        [id, contain, auto, positional, pace]);
    }

    const m136 = MIGRATIONS.find((x) => x.id.startsWith("136"));
    assert.ok(m136, "migration 136 exists");
    await q("BEGIN"); await q(m136.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m136.id]); await q("COMMIT");

    const after = async (id: string) => (await q("SELECT contain_enabled, positional_enabled, pace_enabled FROM seeding_config WHERE server_id = $1", [id])).rows[0];
    assert.deepEqual(await after(rows[0]![0]), { contain_enabled: true, positional_enabled: true, pace_enabled: true }, "what enforced still enforces");
    assert.deepEqual(await after(rows[1]![0]), { contain_enabled: false, positional_enabled: false, pace_enabled: false },
      "painted-only zones would now fence unpainted maps too, and the held-back pace rule would start: both off");
    assert.deepEqual(await after(rows[2]![0]), { contain_enabled: false, positional_enabled: false, pace_enabled: false }, "the auto fence never ran here: off");
    assert.deepEqual(await after(rows[3]![0]), { contain_enabled: false, positional_enabled: true, pace_enabled: false }, "the cap fight's switch is left as it was");
    assert.deepEqual(await after(rows[4]![0]), { contain_enabled: false, positional_enabled: false, pace_enabled: false });
  } finally {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
