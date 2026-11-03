/**
 * Append-only NDJSON archive writer + a streaming key reader. The archive is a single file on the
 * host; we never load it into memory. Dedupe is in-memory *within a run* (a small Set of keys) —
 * that plus the job's resume cursor keeps duplicates out without ever scanning the file, and any
 * rare partial-page duplicate a crash might leave is absorbed by the idempotent transform.
 */
import { once } from "node:events";
import { createWriteStream, createReadStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { CrconArchiveRecord } from "@app/db";

export class ArchiveWriter {
  private seen = new Set<string>();
  private stream: WriteStream;
  private backpressured = false;
  /** The stream's failure, if it had one. Captured by a listener — a WriteStream 'error' with no
   *  listener is an uncaught exception that takes the whole worker process down, ingest and all —
   *  and re-thrown from the next append/drain/close, where the runner's per-stage error handling
   *  can record it against the job instead. */
  private failure: Error | null = null;
  /**
   * `fresh` truncates any existing file (a brand-new pull writes a clean, updated archive);
   * otherwise it appends (a resumed pull adds to what's already there).
   *
   * `dedupe` scopes the in-memory seen-set. "all" (the default, and what the API pull needs) keys
   * EVERY record, which costs one string per row for the life of the run — fine for a pull that
   * pages an API, ruinous for a database export walking seventeen million log lines, where the set
   * alone outgrows the heap. An export whose stages page by primary key cannot emit the same key
   * twice, so it passes the small set of types that genuinely can repeat and pays nothing for the
   * rest.
   */
  constructor(readonly file: string, fresh = false, private readonly dedupe: "all" | ReadonlySet<string> = "all") {
    mkdirSync(dirname(file), { recursive: true });
    this.stream = createWriteStream(file, { flags: fresh ? "w" : "a" });
    this.stream.on("error", (err) => { this.failure = err; });
  }
  /** Write a record unless its (dataType, entityKey) was already written this run. Returns true if written. */
  append(rec: CrconArchiveRecord): boolean {
    if (this.failure) throw this.failure;
    if (this.dedupe === "all" || this.dedupe.has(rec.dataType)) {
      const key = `${rec.dataType}|${rec.entityKey}`;
      if (this.seen.has(key)) return false;
      this.seen.add(key);
    }
    // A false return means the OS has not taken what we've written and Node is now holding it in
    // memory. Recorded, not ignored: the caller drains between batches (see drain), because a
    // producer that reads from a fast database and writes to a slow volume will otherwise buffer
    // the entire archive in the heap and die with the file still nearly empty.
    if (!this.stream.write(`${JSON.stringify(rec)}\n`)) this.backpressured = true;
    return true;
  }
  /** Wait until the write buffer has been absorbed, if it has grown past the watermark. */
  async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.backpressured) return;
    this.backpressured = false;
    if (this.stream.writableLength === 0) return; // already absorbed; no 'drain' will be emitted
    await once(this.stream, "drain");
  }
  /**
   * A barrier: resolves once every record appended SO FAR has reached the file itself. drain()
   * only waits when the buffer grew past the watermark — small writes never trip it, yet they
   * still sit in the stream's memory until the OS takes them. A stage that reads its parent ids
   * back out of the very archive being written (player_detail reading "player" rows, the
   * blacklist records reading "blacklist" rows) would quietly miss that buffered tail on a slow
   * or busy volume, and the missing profiles would never even be recorded as errors.
   */
  flushed(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stream.writableLength === 0) return Promise.resolve();
    return new Promise((res, rej) => {
      // A zero-byte write's callback runs only after every chunk queued before it hit the fd.
      this.stream.write("", (err) => (err ? rej(err) : res()));
    });
  }
  /** Pre-load the dedupe set with what the file ALREADY holds for the given data types, so a
   *  re-run stage (retry / top-up on an existing archive) appends only genuinely new rows instead
   *  of doubling everything it re-fetches. Only the named types are loaded — seeding a whole
   *  million-row archive would cost memory for types nobody is about to re-pull. */
  async seedFrom(file: string, dataTypes: string[]): Promise<void> {
    if (!dataTypes.length || !existsSync(file)) return;
    const prefixes = dataTypes.map((t) => `{"dataType":${JSON.stringify(t)},`);
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!prefixes.some((p) => line.startsWith(p))) continue;
      try {
        const rec = JSON.parse(line) as CrconArchiveRecord;
        this.seen.add(`${rec.dataType}|${rec.entityKey}`);
      } catch { /* skip malformed */ }
    }
  }
  close(): Promise<void> {
    // end()'s callback doubles as the error listener, so a stream that already failed (or fails
    // flushing its last buffer) rejects instead of hanging on a 'finish' that will never come.
    return new Promise((res, rej) => {
      this.stream.end((err?: Error | null) => {
        const fail = err ?? this.failure;
        if (fail) rej(fail); else res();
      });
    });
  }
}

/**
 * Stream one data type's entity keys back out of the archive — used on resume to rebuild the parent
 * id lists (blacklist ids, player ids) without holding the whole file in memory. A cheap prefix
 * check skips the big `player_detail` lines entirely, so we only JSON-parse the small rows we want.
 */
export async function readEntityKeys(file: string, dataType: string): Promise<string[]> {
  if (!existsSync(file)) return [];
  const prefix = `{"dataType":${JSON.stringify(dataType)},`;
  const out: string[] = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith(prefix)) continue;
    try { out.push(String((JSON.parse(line) as CrconArchiveRecord).entityKey)); } catch { /* skip malformed */ }
  }
  return out;
}
