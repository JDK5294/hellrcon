/**
 * Where the CRCON backup archive lives on the host. The pulled data is a single NDJSON file per
 * server — not a DB table — so a full pull of every player's profile never bloats Postgres or the
 * app's memory. The worker streams appends to it; the API streams it to the operator's browser and
 * the transform streams it back in. API and worker must agree on the path, so it comes from one env
 * var (default under the OS temp dir, overridable to a mounted volume in production).
 */
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Directory holding per-server archive files. Set CRCON_BACKUP_DIR to a persistent volume in prod. */
export function crconBackupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CRCON_BACKUP_DIR?.trim() || join(tmpdir(), "app-crcon-backups");
}

/** Absolute path to one server's archive file. serverId is a uuid, so it's filename-safe. */
export function crconBackupFile(serverId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(crconBackupDir(env), `crcon-backup-${serverId}.ndjson`);
}

/**
 * Collapse CRCON's per-round unit history — `player_stats.units`, a timestamped list of
 * `{ts, team, squad, role}` — into seconds per role. Each entry's span runs to the next entry;
 * the last entry's span is closed by the round's own length.
 *
 * The role ints are the GAME's raw role ids: CRCON's recorder stores the roster's role value
 * verbatim (their `UnitHistoryEntry.role` — "role int value"), and our live sampler stores the
 * same raw number, so the collapsed keys drop straight into `role_seconds` beside live-sampled
 * clocks. This is what replaces the "-1 role unknown" sentinel for imported rounds whenever the
 * archive carries a unit history.
 */
export function roleSecondsFromUnits(units: unknown, roundSeconds: number): Record<string, number> {
  if (!Array.isArray(units) || units.length === 0) return {};
  const rows = units
    .map((u) => ({ ts: Number((u as Record<string, unknown>)?.ts), role: Number((u as Record<string, unknown>)?.role) }))
    .filter((u) => Number.isFinite(u.ts) && Number.isFinite(u.role))
    .sort((a, b) => a.ts - b.ts);
  if (rows.length === 0) return {};
  const end = rows[0]!.ts + Math.max(0, Math.round(roundSeconds));
  const out: Record<string, number> = {};
  for (let i = 0; i < rows.length; i += 1) {
    const from = rows[i]!.ts;
    const to = i + 1 < rows.length ? rows[i + 1]!.ts : end;
    const secs = Math.max(0, Math.round(to - from));
    if (secs === 0) continue;
    const key = String(rows[i]!.role);
    out[key] = (out[key] ?? 0) + secs;
  }
  return out;
}
