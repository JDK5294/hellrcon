/**
 * The restore marker — how a full-backup restore tells the WORKER to stand down.
 *
 * A restore empties every catalogued table and refills it from the archive. The worker is a
 * separate process that keeps ingesting the whole time, and its writes race the archive's: a
 * player upserted from a live log line mid-restore takes that platform id with a fresh uuid, the
 * archive's row for the same player then loses the unique-index conflict, and every archived row
 * pointing at the old uuid — careers, sessions, events, VIP grants — is refused as an orphan. The
 * restore reports partial instead of whole, on exactly the "way back to where you were" path.
 *
 * The signal is a FILE in the backup directory, because that is the one channel the two processes
 * already share unconditionally: the compose stack mounts the same host folder into both, no
 * Redis is required (the bus is optional), and no table can carry it — the restore wipes the
 * tables, so a row-based flag would vanish at the exact moment it matters. Where the mount is
 * absent (a bare-node deployment that never configured one), the marker is simply never seen and
 * behaviour is what it was before this existed.
 *
 * Freshness, not existence, is the truth: a crashed restore must not silence ingestion forever,
 * so the marker expires unless refreshed — and the restore refreshes it as its import progresses,
 * which lets a multi-hour archive stay protected without a long expiry window.
 */
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where backups (and this marker) live inside the containers. BACKUP_DIR overrides — the same
 *  variable the API's data-port routes honour, so the two can never point at different folders. */
export function backupDirPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BACKUP_DIR || "/data/backups";
}

const MARKER = ".restore-in-progress";

/** A marker older than this is a wreck, not a restore — ignored, and the worker carries on. The
 *  restore refreshes the marker at least once a minute while its import runs, so a LIVE restore
 *  never comes close to the edge however big the archive is. */
export const RESTORE_MARKER_MAX_AGE_MS = 10 * 60_000;

export function restoreMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(backupDirPath(env), MARKER);
}

/** Arm (or refresh) the marker. Writing anew rather than touching, so arming also works when the
 *  file does not exist yet, and the content says when — useful when staring at a stuck one. */
export function armRestoreMarker(env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(backupDirPath(env), { recursive: true });
  writeFileSync(restoreMarkerPath(env), new Date().toISOString());
}

export function clearRestoreMarker(env: NodeJS.ProcessEnv = process.env): void {
  try { unlinkSync(restoreMarkerPath(env)); } catch { /* already gone */ }
}

/** Is a restore replacing the database right now? Fresh marker = yes; absent or stale = no. */
export function restoreInProgress(env: NodeJS.ProcessEnv = process.env, maxAgeMs = RESTORE_MARKER_MAX_AGE_MS): boolean {
  try {
    return Date.now() - statSync(restoreMarkerPath(env)).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}
