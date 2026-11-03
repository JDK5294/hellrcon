/**
 * Nightly automatic full backups — the pure half.
 *
 * The manual button (Admin → Backup → "Create full backup now") already writes a complete,
 * restorable archive into a host-mounted folder. What it cannot do is run while nobody is
 * thinking about it, and the whole point of a backup is the day nobody was. This planner decides
 * WHEN the worker should write one and WHICH old ones to let go; the I/O (the export itself, the
 * pruning, the audit row) stays in index.ts like every other sweep.
 *
 * Two decisions worth their comments:
 *
 *  - "Due" is once per COMMUNITY day: due when the community's clock has passed the configured
 *    hour and the newest AUTOMATIC archive was written on an earlier day of that clock. That
 *    survives DST (a calendar day, not 24 hours), survives the worker being down over the hour
 *    itself (it runs when the worker returns, rather than skipping a day), and never runs twice
 *    in one day however often the sweep ticks. It was "older than ~20 hours" once, and twenty
 *    hours after an hour before 04:00 is still the same day: a backup set for 03:00 ran again at
 *    23:00, and then every 20 hours, round the clock.
 *
 *  - Rotation only ever touches auto-backup-* files. A manual full-backup-* was made
 *    deliberately — usually right before something risky — and a rotation that quietly eats the
 *    "before" snapshot the operator was counting on is worse than a full disk.
 */

import { zonedParts } from "@app/schedule";

/** What the operator asked for, what exists, and what time it is. */
export interface AutoBackupInput {
  enabled: boolean;
  /** Postgres only — the memory store has nothing durable to archive. */
  supported: boolean;
  /** Hour of the community's day (0–23) the backup should run at. */
  hour: number;
  /** How many automatic archives to keep. */
  keep: number;
  /** The community IANA zone the hour is read in. */
  timezone: string;
  nowMs: number;
  /** Every file currently in the backup folder (any name — the planner filters). */
  files: string[];
}

export interface AutoBackupPlan {
  /** Write an archive this tick. */
  due: boolean;
  /** Auto archives to delete, oldest first — the ones past `keep` (counting the one about to be
   *  written when `due`). Never names a manual backup. */
  prune: string[];
}

export const AUTO_BACKUP_NAME = /^auto-backup-\d{8}-\d{6}\.ndjson\.gz$/;

/** Same shape the manual button uses, its own prefix — rotation keys off the name. */
export function autoBackupFileName(now = new Date()): string {
  return `auto-backup-${now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.ndjson.gz`;
}

/** The UTC timestamp encoded in an auto archive's name, or null for any other file. */
export function autoBackupAtMs(name: string): number | null {
  const m = /^auto-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ndjson\.gz$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** The hour (0–23) of `nowMs` on the community's clock; falls back to UTC on a zone the runtime
 *  does not know, the same posture as every other schedule reader. */
export function hourInZone(nowMs: number, timezone: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(new Date(nowMs));
    return Number(h);
  } catch {
    return new Date(nowMs).getUTCHours();
  }
}

/** The community's calendar day of `ms` — for telling one day from another, nothing more. UTC on a
 *  zone the runtime does not know, like the hour. */
function dayInZone(ms: number, timezone: string): string {
  const { year, month, day } = zonedParts(new Date(ms), timezone);
  return `${year}-${month}-${day}`;
}

export function planAutoBackup(input: AutoBackupInput): AutoBackupPlan {
  const autos = input.files
    .map((name) => ({ name, atMs: autoBackupAtMs(name) }))
    .filter((f): f is { name: string; atMs: number } => f.atMs !== null)
    .sort((a, b) => a.atMs - b.atMs);

  if (!input.enabled || !input.supported) return { due: false, prune: [] };

  const newest = autos[autos.length - 1];
  const due = hourInZone(input.nowMs, input.timezone) >= input.hour
    && (!newest || dayInZone(newest.atMs, input.timezone) !== dayInZone(input.nowMs, input.timezone));

  // Keep the newest `keep` including tonight's (when due): with keep=7 and 7 on disk, writing the
  // eighth prunes the oldest one — the folder holds `keep`, not `keep + 1`, at rest.
  const keep = Math.max(1, input.keep) - (due ? 1 : 0);
  const prune = autos.slice(0, Math.max(0, autos.length - keep)).map((f) => f.name);
  return { due, prune };
}
