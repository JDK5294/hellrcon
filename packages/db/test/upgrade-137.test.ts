import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 137. CRCON stores never-expiring VIP as a year-3000 date, which the import and the VIP
 * sync carried in as DATED grants — unprotected by the permanent floor, so automation dated them
 * down to days. The migration stores them as permanent, with an audit row each saying why, and
 * leaves every real date (and every permanent grant) alone. It also builds the partial index the
 * VIP integrity scan's whole-history read walks; the read's own predicate must be the one the
 * planner can match to it.
 */
const DB = process.env.DATABASE_URL;

test("migration 137: year-3000 VIP becomes permanent with an audit row each; real dates are left alone; the scan's read uses its index", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const { VIP_TIMELINE_SQL } = await import("../dist/postgres.js");
  const pg = (await import("pg")).default;
  const schema = `up137_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "137")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }
    const sid = "00000000-0000-4000-8000-000000000137";
    await q("INSERT INTO servers (id, name, host, port, password) VALUES ($1, 'WW2', '127.0.0.1', 1, 'x')", [sid]);
    const vip = (player: string, name: string, expiration: string | null) =>
      q("INSERT INTO vips (id, server_id, player_id, player_name, expiration, created_by_name) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'crcon-import')", [sid, player, name, expiration]);
    await vip("p-3000", "Dads_soup", "3000-01-04T00:00:00Z");
    await vip("p-3000b", "Guts", "3000-02-07T05:55:00Z");
    await vip("p-dated", "ItalianGrape", "2027-03-03T07:18:48Z");
    await vip("p-perm", "Bad Mercenary", null);

    const m137 = MIGRATIONS.find((x) => x.id.startsWith("137"));
    assert.ok(m137, "migration 137 exists");
    await q("BEGIN"); await q(m137.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m137.id]); await q("COMMIT");

    const exp = async (player: string) => { const r = (await q("SELECT expiration FROM vips WHERE player_id = $1", [player])).rows[0]; return r ? r.expiration : "missing"; };
    assert.equal(await exp("p-3000"), null, "a year-3000 expiry is now permanent");
    assert.equal(await exp("p-3000b"), null, "so is one CRCON's rewards stacked days onto");
    assert.equal((await exp("p-dated") as Date).toISOString(), "2027-03-03T07:18:48.000Z", "a real date is left exactly as it was");
    assert.equal(await exp("p-perm"), null, "a permanent grant stays permanent");

    const audit = (await q("SELECT actor_name, action, target_id, automated, data FROM audit ORDER BY target_id")).rows;
    assert.deepEqual(audit.map((r: { target_id: string }) => r.target_id), ["p-3000", "p-3000b"], "one audit row per converted grant, nothing for the others");
    for (const r of audit) {
      assert.equal(r.actor_name, "vip-integrity");
      assert.equal(r.action, "vip.grant");
      assert.equal(r.automated, true);
      assert.equal(r.data.expiration, null, "written as a PERMANENT grant — the integrity scan reads it as one");
      assert.equal(r.data.year3000, true);
    }

    // The scan's read must be able to use the partial index: with sequential scans priced out, a
    // predicate that does not match the index's would leave the planner nothing else to choose.
    await q("SET enable_seqscan = off");
    const plan = (await q(`EXPLAIN SELECT * FROM audit WHERE (${VIP_TIMELINE_SQL}) ORDER BY ts, id LIMIT 5000`)).rows.map((r: Record<string, string>) => Object.values(r)[0]).join("\n");
    assert.match(plan, /audit_vip_timeline_idx/, `the whole-history read walks its index:\n${plan}`);
  } finally {
    await q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
