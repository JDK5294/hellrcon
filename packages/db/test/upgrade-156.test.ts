import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Migration 156. Three permissions split, each keeping its name for the part that stayed: the chat
 * filter and the zone sets off the enforcer rules (admin.moderation), the seed reward off seeding
 * (seeding.config), the Discord bot's setup and online access off user & role admin (admin.users).
 * Nobody's access may move on the upgrade: every grant of an old key — a block included, at its own
 * scope — and every role entry for one gains the same on each new key, once, and a grant somebody
 * already made on a new key by hand is left as they made it.
 */
const DB = process.env.DATABASE_URL;

test("migration 156: every holder of a split permission, and every block on one, holds the same on its new keys", { skip: !DB }, async () => {
  const { MIGRATIONS } = await import("../dist/migrations.js");
  const pg = (await import("pg")).default;
  const schema = `up156_${Math.random().toString(36).slice(2, 8)}`;
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  const q = (sql: string, args: unknown[] = []) => client.query(sql, args);
  try {
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}`);
    await q("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const m of MIGRATIONS.filter((x) => x.id < "156")) {
      await q("BEGIN"); await q(m.sql); await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]); await q("COMMIT");
    }

    const names = ["rules", "seeder", "blocked", "byhand", "other"];
    const id: Record<string, string> = {};
    for (const n of names) id[n] = (await q("INSERT INTO users (id, username) VALUES (gen_random_uuid(), $1) RETURNING id", [n])).rows[0].id as string;
    const server = (await q("SELECT gen_random_uuid() AS id")).rows[0].id as string;
    const grant = (user: string, capability: string, level: string, scopeId: string | null = null) =>
      q("INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)",
        [id[user], capability, scopeId ? "server" : "global", scopeId, level]);
    await grant("rules", "admin.moderation", "write");
    await grant("seeder", "seeding.config", "read", server);
    await grant("blocked", "admin.users", "none");
    await grant("byhand", "admin.users", "write");
    await grant("byhand", "discord.setup", "read"); // given by hand already: kept as it is
    await grant("other", "server.view", "read");
    const role = async (name: string, grants: unknown[]) =>
      (await q("INSERT INTO roles (id, name, grants) VALUES (gen_random_uuid(), $1, $2::jsonb) RETURNING id", [name, JSON.stringify(grants)])).rows[0].id as string;
    const mods = await role("Moderators", [{ capability: "admin.moderation", level: "read" }, { capability: "seeding.config", level: "write" }, { capability: "server.view", level: "read" }]);
    const trial = await role("Trial", [{ capability: "admin.users", level: "none" }]);
    const leads = await role("Leads", [{ capability: "admin.users", level: "write" }, { capability: "admin.online", level: "none" }]);
    const viewers = await role("Viewers", [{ capability: "server.view", level: "read" }]);

    const m156 = MIGRATIONS.find((x) => x.id.startsWith("156"));
    assert.ok(m156, "migration 156 exists");
    // Twice: a re-run must add nothing.
    for (let i = 0; i < 2; i++) {
      await q("BEGIN"); await q(m156.sql); await q("COMMIT");
    }
    await q("INSERT INTO schema_migrations (id) VALUES ($1)", [m156.id]);

    const held = async (user: string) => (await q(
      "SELECT capability, level, scope_type, scope_id FROM grants WHERE user_id = $1 ORDER BY capability", [id[user]],
    )).rows.map((r: { capability: string; level: string; scope_type: string; scope_id: string | null }) =>
      `${r.capability}=${r.level}${r.scope_id ? `@${r.scope_id === server ? "server" : r.scope_id}` : ""}`);
    assert.deepEqual(await held("rules"), ["admin.moderation=write", "moderation.chatfilter=write", "moderation.zones=write"]);
    assert.deepEqual(await held("seeder"), ["seeding.config=read@server", "seeding.rewards=read@server"], "at its own scope");
    assert.deepEqual(await held("blocked"), ["admin.online=none", "admin.users=none", "discord.setup=none"], "a block keeps blocking");
    assert.deepEqual(await held("byhand"), ["admin.online=write", "admin.users=write", "discord.setup=read"], "a grant made by hand is left as it was made");
    assert.deepEqual(await held("other"), ["server.view=read"]);

    const entries = async (roleId: string) => ((await q("SELECT grants FROM roles WHERE id = $1", [roleId])).rows[0].grants as { capability: string; level: string }[])
      .map((g) => `${g.capability}=${g.level}`).sort();
    assert.deepEqual(await entries(mods), ["admin.moderation=read", "moderation.chatfilter=read", "moderation.zones=read", "seeding.config=write", "seeding.rewards=write", "server.view=read"]);
    assert.deepEqual(await entries(trial), ["admin.online=none", "admin.users=none", "discord.setup=none"]);
    assert.deepEqual(await entries(leads), ["admin.online=none", "admin.users=write", "discord.setup=write"], "an entry the role already had for a new key stays");
    assert.deepEqual(await entries(viewers), ["server.view=read"]);
  } finally {
    await q(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
