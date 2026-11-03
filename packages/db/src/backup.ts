/**
 * Backup helper for the trim tool: writes rows as gzipped NDJSON (one JSON object per
 * line) to a path. Used to archive the slice a trim is about to delete, so trimming to
 * reclaim disk never means the data is gone for good.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createGzip, type Gzip } from "node:zlib";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/**
 * An open backup file that rows can be appended to in batches.
 *
 * The trim used to hand its whole matched slice to `backupRowsNdjson` in one array, which meant
 * the process held every row it was about to delete. Measured against real Postgres: 300,000
 * events — a fortnight on a busy server — cost 417 MB of resident memory in the API process, and
 * this project exists partly to import YEARS of history from CRCON. Millions of rows is the
 * expected case, not the pathological one.
 *
 * Writing in batches keeps the cost flat, and lets the caller back up exactly the rows it has
 * just deleted rather than a separate earlier snapshot of what it hoped to delete.
 */
export interface BackupWriter {
  /** Append rows. Respects backpressure, so a slow disk slows the trim instead of buffering it. */
  write(rows: unknown[]): Promise<void>;
  /** Flush and close. Always await this, including on the failure path. */
  close(): Promise<void>;
}

export async function openBackupWriter(path: string): Promise<BackupWriter> {
  await mkdir(dirname(path), { recursive: true });
  const file: WriteStream = createWriteStream(path);
  const gzip: Gzip = createGzip();
  const done = pipeline(gzip, file);
  return {
    async write(rows: unknown[]): Promise<void> {
      if (rows.length === 0) return;
      const chunk = rows.map((r) => JSON.stringify(r) + "\n").join("");
      // `write` returning false means the buffer is full; waiting for "drain" is what keeps a
      // slow disk from turning into unbounded memory, which is the whole point of batching.
      if (!gzip.write(chunk)) await once(gzip, "drain");
    },
    async close(): Promise<void> {
      gzip.end();
      await done;
    },
  };
}

/** Write a whole set of rows at once — the small-input path (the in-memory store, tests). */
export async function backupRowsNdjson(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const source = Readable.from(rows.map((r) => JSON.stringify(r) + "\n"));
  await pipeline(source, createGzip(), createWriteStream(path));
}

/** Default backup filename for a trim run. */
export function defaultBackupPath(dir: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${dir.replace(/\/$/, "")}/trim-${label}-${stamp}.ndjson.gz`;
}
