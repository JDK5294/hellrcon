/**
 * STANDALONE child script — not imported by the API. Spawned as:
 *
 *   node --experimental-sqlite dist/botdb-extract.js <path-to-bot.db>
 *
 * because `node:sqlite` sits behind a flag on Node 22 and the API process must not depend on
 * being started with it. The child reads ONLY the earlier bot's VIP-module `users` table (the one table
 * the cutover carries over — see docs/vip-module.md's last section) and prints JSON on stdout; any failure
 * prints { error } and exits non-zero. The parent (botdb-import.ts) treats stdout as the whole
 * contract.
 */

interface SqliteStmt { all(): Record<string, unknown>[] }
interface SqliteDb { prepare(sql: string): SqliteStmt; close(): void }

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: botdb-extract <bot.db>");
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (p: string, opts?: { readOnly?: boolean }) => SqliteDb };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const users = db.prepare(`
      SELECT discord_id, discord_username, discord_display_name, discord_global_name, discord_nick,
             discord_name, player_guid, last_ingame_name, last_seen_ingame_name, balance,
             registered_at, registration_source, registration_vip_granted_once, created_at, updated_at
      FROM users
    `).all();
    process.stdout.write(JSON.stringify({ users }));
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  process.stdout.write(JSON.stringify({ error: (err as Error).message }));
  process.exit(1);
});
