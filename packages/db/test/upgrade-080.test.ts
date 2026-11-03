import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 080 against a database that already CARRIES the orphan — the upgrade, not the
 * install. The split migration (039) materialized `autosettings.rules` for every
 * autosettings.config holder; 072 retired the key and forgot the stored rows, and because every
 * grants write validates against the catalog, a role carrying the orphan could not be SAVED at
 * all — the live failure was "unknown capability: autosettings.rules" on the role editor's Save.
 * This proves 080 removes exactly the orphan and nothing beside it, from both places grants live.
 */
const DB = process.env.DATABASE_URL;

test("migration 080: the retired autosettings.rules grant is removed from roles and users, nothing else", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up080_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "080")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }

    // The world 072 left behind: a role and a user both still holding the retired key.
    const roleId = (await q(
      `INSERT INTO roles (id, name, grants) VALUES (gen_random_uuid(), 'Head admin', $1::jsonb) RETURNING id`,
      [JSON.stringify([
        { capability: "autosettings.rules", level: "write" },
        { capability: "moderation.blacklist", level: "write" }, // 021's other forgotten residue
        { capability: "admin.moderation", level: "write" },
        { capability: "server.view", level: "read" },
      ])],
    )).rows[0].id as string;
    const userId = (await q(
      "INSERT INTO users (id, username) VALUES (gen_random_uuid(), 'vet') RETURNING id",
    )).rows[0].id as string;
    await q(
      `INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
       VALUES (gen_random_uuid(), $1, 'autosettings.rules', 'global', NULL, 'write'),
              (gen_random_uuid(), $1, 'seeding.config', 'global', NULL, 'write')`,
      [userId],
    );

    const m080 = MIGRATIONS.find((x) => x.id.startsWith("080"));
    assert.ok(m080, "migration 080 exists");
    await q("BEGIN"); await q(m080.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m080.id]); await q("COMMIT");

    const roleCaps = ((await q("SELECT grants FROM roles WHERE id = $1", [roleId])).rows[0].grants as { capability: string }[])
      .map((g) => g.capability).sort();
    assert.deepEqual(roleCaps, ["admin.moderation", "moderation.bans", "server.view"],
      "the orphan is gone, the blacklist residue became a ban manager, the real grants survive");
    const userCaps = ((await q("SELECT capability FROM grants WHERE user_id = $1", [userId])).rows as { capability: string }[])
      .map((r) => r.capability);
    assert.deepEqual(userCaps, ["seeding.config"], "same for the per-user rows");
  } finally {
    await q(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});

/**
 * The class of the bug, closed for good: any capability key a migration ever writes into stored
 * grants must either still exist in the catalog, be one of the documented split-era keys (whose
 * cleanup is the split migration's own DELETE), or carry a `retired-keys-cleaned:` marker naming
 * it — which only a cleanup migration like 080 provides. Retire a key without cleaning the rows
 * it once materialized and this fails, naming the key, before any install's role editor wedges.
 */
test("every capability a migration names is alive, split-era, or cleaned", async () => {
  const { readFile } = await import("node:fs/promises");
  const { CAPABILITY_CATALOG, CAPABILITY_SPLITS } = await import("@app/access");
  // Audit action names a migration's index lists (the VIP integrity timeline, migration 137): the
  // trail's own vocabulary, spelled like keys but never stored as a grant.
  const { VIP_TIMELINE_ACTIONS, VIP_TIMELINE_EXPIRY_ACTIONS } = await import("../dist/index.js");
  const auditActions = new Set<string>([...VIP_TIMELINE_ACTIONS, ...VIP_TIMELINE_EXPIRY_ACTIONS]);
  const src = await readFile(new URL("../src/migrations.ts", import.meta.url), "utf8");

  const alive = new Set(CAPABILITY_CATALOG.map((c) => c.key));
  const splitEra = new Set([...Object.keys(CAPABILITY_SPLITS), ...Object.values(CAPABILITY_SPLITS).flat()]);
  const cleaned = new Set([...src.matchAll(/retired-keys-cleaned:\s*([a-z0-9_.,\s]+)/g)]
    .flatMap((m) => m[1]!.split(",").map((k) => k.trim()).filter(Boolean)));

  // Dotted quoted literals, minus the vocabularies that merely share the spelling (event kinds,
  // trigger ids) — those are not permission keys and have their own checkers.
  const literals = [...src.matchAll(/'([a-z][a-z0-9]*\.[a-z][a-z0-9.]*)'/g)].map((m) => m[1]!);
  const notCaps = /^(evt|app|log|seed|rule|enforcer)\./;
  const orphans = [...new Set(literals)]
    .filter((k) => !notCaps.test(k) && !auditActions.has(k))
    .filter((k) => !alive.has(k) && !splitEra.has(k) && !cleaned.has(k));
  assert.deepEqual(orphans, [],
    `migrations name capability keys that no longer exist and were never cleaned: ${orphans.join(", ")} — ` +
    "retiring a key needs a migration that deletes its stored grants (roles jsonb AND the grants table) " +
    "with a 'retired-keys-cleaned: <key>' marker");

  // The mirror: a "cleaned" key that is still in the catalog is a marker on the wrong key.
  const zombie = [...cleaned].filter((k) => alive.has(k));
  assert.deepEqual(zombie, [], `marked cleaned but still in the catalog: ${zombie.join(", ")}`);
});
