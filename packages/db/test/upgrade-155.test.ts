import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 155. Making an API token, and using one, now takes the api.tokens permission. Before,
 * anyone signed in could do both, so an upgrade must not stop a token that works today: every
 * account holding one that hasn't run out is given the permission, once, as a grant of its own.
 * An owner holds it already, through the '*' grant of their own or of a role, and gets nothing
 * extra. An account with no live token gets nothing either: it needs the permission given.
 */
const DB = process.env.DATABASE_URL;

test("migration 155: whoever holds a live API token keeps the use of it, nobody else gains anything", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up155_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "155")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }

    const names = ["bot", "two", "lapsed", "none", "owner", "roleowner"];
    const id: Record<string, string> = {};
    for (const n of names) id[n] = (await q("INSERT INTO users (id, username) VALUES (gen_random_uuid(), $1) RETURNING id", [n])).rows[0].id as string;
    const token = (user: string, expiresAt: string | null) =>
      q("INSERT INTO api_tokens (id, user_id, name, token_hash, expires_at) VALUES (gen_random_uuid(), $1, 'script', gen_random_uuid()::text, $2)", [user, expiresAt]);
    await token(id.bot!, null);
    await token(id.two!, null);
    await token(id.two!, new Date(Date.now() + 86_400_000).toISOString());
    await token(id.lapsed!, new Date(Date.now() - 86_400_000).toISOString());
    await token(id.owner!, null);
    await token(id.roleowner!, null);
    await q("INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level) VALUES (gen_random_uuid(), $1, '*', 'global', NULL, 'write')", [id.owner]);
    const ownerRole = (await q(
      "INSERT INTO roles (id, name, grants) VALUES (gen_random_uuid(), 'Owner (all access)', $1::jsonb) RETURNING id",
      [JSON.stringify([{ capability: "*", level: "write" }])],
    )).rows[0].id as string;
    await q("INSERT INTO user_roles (user_id, role_id, scope_id) VALUES ($1, $2, NULL)", [id.roleowner, ownerRole]);

    const m155 = MIGRATIONS.find((x) => x.id.startsWith("155"));
    assert.ok(m155, "migration 155 exists");
    await q("BEGIN"); await q(m155.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m155.id]); await q("COMMIT");

    const rows = (await q("SELECT user_id, scope_type, scope_id, level FROM grants WHERE capability = 'api.tokens'")).rows as
      { user_id: string; scope_type: string; scope_id: string | null; level: string }[];
    const who = (u: string) => names.find((n) => id[n] === u);
    assert.deepEqual(rows.map((r) => who(r.user_id)).sort(), ["bot", "two"],
      "each live token's maker keeps the permission, once however many they hold; a run-out token, no token, or an owner gets none");
    for (const r of rows) assert.deepEqual([r.scope_type, r.scope_id, r.level], ["global", null, "write"], "the permission everywhere, at the level that makes and uses a token");
    const owners = (await q("SELECT capability FROM grants WHERE user_id = ANY($1::uuid[]) ORDER BY capability", [[id.owner, id.roleowner]])).rows;
    assert.deepEqual(owners.map((r: { capability: string }) => r.capability), ["*"], "an owner's grants are as they were");
  } finally {
    await q(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
