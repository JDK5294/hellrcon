/**
 * The slow, resumable CRCON backup pull. Given a running crcon_import_job, it walks an ordered set
 * of stages and streams every record into the host-side NDJSON archive file (append-only, deduped
 * in memory), advancing the job's per-stage cursor after each page so a restart resumes mid-stage
 * rather than re-pulling. Postgres holds only the small job record; the archive never touches the DB
 * or app memory in bulk. Every network read goes through the throttled CrconClient, so even a full
 * pull is a steady trickle.
 */
import { existsSync } from "node:fs";
import { CrconClient } from "@app/rcon-core";
import type { Repository } from "@app/db";
import { createLogger, crconBackupFile } from "@app/shared";
import { rowsFrom, entityKeyOf, pick, str } from "./stages.js";
import { ArchiveWriter, readEntityKeys } from "./archive.js";

const log = createLogger("crcon-import");
const PAGE = 100;
// Deliberately slower than the client default — a backup pull has no deadline, so err on gentle.
const INTERVAL_MS = Number(process.env.CRCON_IMPORT_INTERVAL_MS ?? 250);
const FLUSH_EVERY = 10; // persist cursor at least this often within a long stage

interface Progress { cursor: Record<string, any>; counts: Record<string, number>; errors: string[] }

/** Every pull stage, in run order. Stage key === the archive dataType it writes (the retry stage is
 *  absent on purpose — it re-writes `player_detail` rows). Used to seed the dedupe set on resume.
 *  ADDING A STAGE? Also handle its dataType in the API's crcon-transform AND add it to the
 *  "archive completeness" test in apps/api/test/import-api.test.ts — that test is the guard
 *  against pulling data that never gets applied. */
export const STAGE_KEYS = [
  "meta",
  "vip", "ban", "blacklist", "blacklist_record", "standard_message", "map_history", "map_scoreboard", "watchlist",
  "player", "player_detail",
  "log_kill", "log_teamkill", "log_match", "log_connect", "log_disconnect", "log_teamswitch",
  "log_admin", "log_message", "log_vote", "log_tkauto", "log_camera", "log_chat",
] as const;

async function flush(repo: Repository, jobId: string, prog: Progress): Promise<void> {
  await repo.crconSnapshot.updateJob(jobId, { cursor: prog.cursor, counts: prog.counts, errors: prog.errors });
}
async function stopped(repo: Repository, jobId: string): Promise<boolean> {
  const j = await repo.crconSnapshot.getJob(jobId);
  return !j || j.status !== "running";
}

/** Append rows to the archive; count only the ones newly written (dedupe skips repeats). */
function store(archive: ArchiveWriter, dataType: string, rows: Record<string, unknown>[], prog: Progress): void {
  let n = 0;
  for (const raw of rows) if (archive.append({ dataType, entityKey: entityKeyOf(dataType, raw), raw })) n += 1;
  if (n) prog.counts[dataType] = (prog.counts[dataType] ?? 0) + n;
}

async function single(client: CrconClient, archive: ArchiveWriter, command: string, dataType: string, prog: Progress): Promise<void> {
  store(archive, dataType, rowsFrom(await client.get(command), dataType, "players", "bans", "vips", "records", "maps"), prog);
}

/** Page through a command until a short page; resumable via cursor.page. Returns false if paused.
 *  The end-of-data check MUST compare against the size actually requested — a stage may override
 *  `page_size` (the player/watchlist pulls use 500). Comparing against a fixed constant instead
 *  mis-reads a normal short final page (e.g. 325 of 500) as "not done", and since CRCON clamps an
 *  out-of-range page to the last page rather than returning empty, the loop re-fetches the same
 *  page forever (all deduped, so counts/archive freeze while the cursor keeps flushing). */
async function paged(
  client: CrconClient, repo: Repository, jobId: string, archive: ArchiveWriter,
  command: string, dataType: string, prog: Progress, extra: Record<string, string | number> = {}, cursorKey = dataType,
): Promise<boolean> {
  const size = Number(extra.page_size ?? PAGE);
  let page = Number(prog.cursor[cursorKey]?.page ?? 1);
  for (;;) {
    if (await stopped(repo, jobId)) return false;
    const rows = rowsFrom(await client.get(command, { ...extra, page, page_size: size }), "players", "records", "result", "maps", dataType);
    store(archive, dataType, rows, prog);
    const done = rows.length < size;
    prog.cursor[cursorKey] = { page: page + 1, done };
    await flush(repo, jobId, prog);
    if (done) return true;
    page += 1;
  }
}

/** Standard/welcome/punishment messages → archived as { kind, message }, keyed by content. */
async function messages(client: CrconClient, archive: ArchiveWriter, prog: Progress): Promise<void> {
  const srcs: { command: string; kind: string }[] = [
    { command: "get_standard_broadcast_messages", kind: "broadcast" },
    { command: "get_standard_welcome_messages", kind: "welcome" },
    { command: "get_standard_punishments_messages", kind: "punishment" },
  ];
  const rows: Record<string, unknown>[] = [];
  for (const s of srcs) {
    let raw: unknown;
    try { raw = await client.get(s.command); } catch (e) { prog.errors.push(`${s.command}: ${(e as Error).message}`); continue; }
    for (const m of rowsFrom(raw, "messages", "result")) {
      const message = typeof m === "string" ? m : String((m as any)?.message ?? (m as any)?.text ?? "");
      if (message.trim()) rows.push({ kind: s.kind, message: message.trim() });
    }
  }
  store(archive, "standard_message", rows, prog);
}

/**
 * Historical game-log pull (kills / team kills) — the deep history behind career stats, weapon
 * breakdowns and nemeses. get_historical_logs has no page parameter, so we walk TIME: ascending,
 * `limit` rows per request, cursor = the last event_time seen. The `from` bound is inclusive, so
 * each request re-fetches the boundary row(s) and the archive's dedupe collapses them.
 *
 * Two version quirks handled here rather than hoped away:
 *  - the lower-bound kwarg is `from` on some CRCON versions and `from_` on others — on a rejected
 *    request we flip the name once and remember the working one in the cursor;
 *  - if a full page arrives but nothing new was written AND the boundary didn't advance (more rows
 *    sharing one timestamp than fit in a page), we nudge the bound by 1s rather than loop forever.
 */
const LOG_PAGE = 1000;
async function historicalLogs(
  client: CrconClient, repo: Repository, jobId: string, archive: ArchiveWriter,
  action: string, dataType: string, prog: Progress, serverNumber: number | null,
): Promise<boolean> {
  const cur = () => (prog.cursor[dataType] ?? {}) as { from?: string | null; fromParam?: string; done?: boolean };
  let from: string | null = cur().from ?? null;
  let fromParam = cur().fromParam ?? "from";
  for (;;) {
    if (await stopped(repo, jobId)) return false;
    const params: Record<string, string | number> = { action, limit: LOG_PAGE, time_sort: "asc" };
    // ONE server's history, not the install's. CRCON's log store is shared across every server in
    // the install and `server_filter` DEFAULTS TO ALL — on a multi-server install an unfiltered
    // pull hands back both servers' lines interleaved, and everything downstream then attributes
    // the other server's kills, sessions and playtime to this one.
    if (serverNumber !== null) params.server_filter = String(serverNumber);
    if (from) params[fromParam] = from;
    let raw: unknown;
    try {
      raw = await client.get("get_historical_logs", params);
    } catch (e) {
      if (from && fromParam === "from") { fromParam = "from_"; continue; } // kwarg-name drift — try the other spelling once
      throw e;
    }
    const rows = rowsFrom(raw, "logs", "result");
    let wrote = 0;
    for (const r of rows) if (archive.append({ dataType, entityKey: entityKeyOf(dataType, r), raw: r })) wrote += 1;
    if (wrote) prog.counts[dataType] = (prog.counts[dataType] ?? 0) + wrote;
    const last = rows.length ? str(pick(rows[rows.length - 1], "event_time", "event_time_as_timestamp", "creation_time", "timestamp_ms")) : "";
    const stalled = rows.length >= LOG_PAGE && wrote === 0 && last === from;
    const done = rows.length < LOG_PAGE;
    from = stalled && last ? new Date(Date.parse(last) + 1000).toISOString() : (last || from);
    prog.cursor[dataType] = { from, fromParam, done };
    await flush(repo, jobId, prog);
    if (done) return true;
  }
}

/** One rich profile per archived player — the expensive fan-out, bounded by the throttle and fully
 *  resumable via cursor.offset. Player ids come from the archive (streamed), so resume works too. */
async function playerDetail(client: CrconClient, repo: Repository, jobId: string, file: string, archive: ArchiveWriter, prog: Progress): Promise<boolean> {
  // The rows this stage reads back were appended moments ago and may still sit in the write
  // stream's buffer — flush first, or the tail of the player list quietly goes unprofiled.
  await archive.flushed();
  const players = await readEntityKeys(file, "player");
  let off = Number(prog.cursor.player_detail?.offset ?? 0);
  for (; off < players.length; off++) {
    if (await stopped(repo, jobId)) { prog.cursor.player_detail = { offset: off, done: false }; await flush(repo, jobId, prog); return false; }
    const pid = players[off]!;
    if (!pid) continue;
    try {
      const prof = await client.get("get_player_profile", { player_id: pid });
      const raw = (prof && typeof prof === "object" ? prof : { player_id: pid, profile: prof }) as Record<string, unknown>;
      if (!("player_id" in raw)) raw.player_id = pid;
      store(archive, "player_detail", [raw], prog);
    } catch (e) {
      prog.errors.push(`player_profile ${pid}: ${(e as Error).message}`);
    }
    if (off % FLUSH_EVERY === 0) { prog.cursor.player_detail = { offset: off + 1, done: false }; await flush(repo, jobId, prog); }
  }
  prog.cursor.player_detail = { offset: players.length, done: true };
  await flush(repo, jobId, prog);
  return true;
}

/** Re-fetch ONLY the player profiles that failed last run (their ids were parsed out of the job's
 *  error log by the retry route into cursor.player_detail_retry.pids). Successes are appended to
 *  the archive; persistent failures are re-recorded so the operator can retry again later. */
async function retryPlayerDetail(client: CrconClient, repo: Repository, jobId: string, archive: ArchiveWriter, prog: Progress): Promise<boolean> {
  const pids: string[] = Array.isArray(prog.cursor.player_detail_retry?.pids) ? prog.cursor.player_detail_retry.pids : [];
  let off = Number(prog.cursor.player_detail_retry?.offset ?? 0);
  for (; off < pids.length; off++) {
    if (await stopped(repo, jobId)) { prog.cursor.player_detail_retry = { pids, offset: off, done: false }; await flush(repo, jobId, prog); return false; }
    const pid = pids[off]!;
    try {
      const prof = await client.get("get_player_profile", { player_id: pid });
      const raw = (prof && typeof prof === "object" ? prof : { player_id: pid, profile: prof }) as Record<string, unknown>;
      if (!("player_id" in raw)) raw.player_id = pid;
      store(archive, "player_detail", [raw], prog);
    } catch (e) {
      prog.errors.push(`player_profile ${pid}: ${(e as Error).message}`);
    }
    if (off % FLUSH_EVERY === 0) { prog.cursor.player_detail_retry = { pids, offset: off + 1, done: false }; await flush(repo, jobId, prog); }
  }
  prog.cursor.player_detail_retry = { offset: pids.length, done: true };
  await flush(repo, jobId, prog);
  return true;
}

/** Per-blacklist paginated record pull, iterating the blacklist ids already archived this run. */
async function blacklistRecords(client: CrconClient, repo: Repository, jobId: string, file: string, archive: ArchiveWriter, prog: Progress): Promise<boolean> {
  await archive.flushed(); // same read-back-of-live-archive as playerDetail — see there
  const ids = await readEntityKeys(file, "blacklist");
  let li = Number(prog.cursor.blacklist_record?.listIndex ?? 0);
  for (; li < ids.length; li++) {
    const ok = await paged(client, repo, jobId, archive, "get_blacklist_records", "blacklist_record", prog, { blacklist_id: ids[li]!, exclude_expired: "false" }, `blacklist_record:${ids[li]}`);
    if (!ok) { prog.cursor.blacklist_record = { listIndex: li, done: false }; await flush(repo, jobId, prog); return false; }
    prog.cursor.blacklist_record = { listIndex: li + 1, done: li + 1 >= ids.length };
    await flush(repo, jobId, prog);
  }
  prog.cursor.blacklist_record = { listIndex: ids.length, done: true };
  await flush(repo, jobId, prog);
  return true;
}

/** Drive a single job to completion (or until paused). Safe to call again to resume. */
export async function runImportJob(repo: Repository, jobId: string): Promise<void> {
  const job = await repo.crconSnapshot.getJob(jobId);
  if (!job || job.status !== "running") return;
  const apiKey = (await repo.crconSnapshot.getJobApiKey(jobId)) ?? "";
  if (!job.baseUrl || !apiKey) {
    await repo.crconSnapshot.updateJob(jobId, { status: "error", errors: [...job.errors, "missing CRCON base URL or API key"] });
    return;
  }
  const client = new CrconClient({ baseUrl: job.baseUrl, apiKey, minIntervalMs: INTERVAL_MS });
  const file = crconBackupFile(job.serverId);
  // A brand-new job (empty cursor) writes a clean, updated file; a resume appends to the existing one.
  const fresh = Object.keys(job.cursor ?? {}).length === 0;
  // A resume whose archive file vanished means the host lost the file (rebuilt without a persistent
  // CRCON_BACKUP_DIR volume, or the volume was removed). Continuing would silently produce a
  // near-empty archive — the id lists for player profiles and blacklist records come FROM the file —
  // so stop with an explicit explanation instead.
  if (!fresh && !existsSync(file)) {
    await repo.crconSnapshot.updateJob(jobId, {
      status: "error",
      errors: [...job.errors, "archive file is missing but the pull had progress — the host lost the archive (is CRCON_BACKUP_DIR on a persistent volume?). Start a fresh pull, or upload a saved backup and Retry."],
    });
    return;
  }
  const archive = new ArchiveWriter(file, fresh);
  const prog: Progress = { cursor: { ...job.cursor }, counts: { ...job.counts }, errors: [...job.errors] };
  const slog = log.child({ jobId, serverId: job.serverId });
  slog.info("CRCON backup pull starting/resuming", { file, fresh });

  const done = (k: string) => Boolean(prog.cursor[k]?.done);
  // Retry / top-up on an existing archive: any stage about to (re)run must first know what the file
  // already holds for its data type, or it would append duplicates of everything it re-fetches.
  if (!fresh) {
    const rerunTypes = STAGE_KEYS.filter((k) => !done(k));
    if (Array.isArray(prog.cursor.player_detail_retry?.pids) && !done("player_detail_retry")) rerunTypes.push("player_detail");
    await archive.seedFrom(file, [...new Set(rerunTypes)]);
  }
  // A stage that ultimately fails (after the client's own retries) is recorded and SKIPPED — it must
  // not abort the whole pull, so one endpoint a CRCON version lacks, or a bad page deep in the run,
  // can't cost hours of progress. Auth failures are the exception: retrying won't help, so we stop.
  // `run` returns false only when the job was paused mid-stage (the driver should stop cleanly).
  const stage = async (key: string, run: () => Promise<boolean | void>): Promise<"continue" | "stop"> => {
    if (done(key)) return "continue";
    try {
      const r = await run();
      if (r === false) return "stop"; // paused
      if (!prog.cursor[key]?.done) prog.cursor[key] = { done: true };
      await flush(repo, jobId, prog);
      return "continue";
    } catch (err) {
      if (isAuthFailure(err)) throw err; // fatal — bad key, no point continuing
      prog.errors.push(`${key}: ${(err as Error).message}`);
      prog.cursor[key] = { done: true }; // skip this data type; a future fresh pull can retry it
      await flush(repo, jobId, prog);
      slog.warn("CRCON stage skipped after failure", { stage: key, err: (err as Error).message });
      return "continue";
    }
  };

  try {
    // Which server of the CRCON install this base URL answers for. Asked ONCE and persisted in the
    // cursor (so a resume in a fresh process still knows it) and in the archive as a meta record
    // (so the transform can filter rows by it — defense in depth against endpoints that ignore or
    // predate their server filters). Null when get_status doesn't answer: the pull still runs,
    // unfiltered, exactly as before — and the verify report will say so.
    let serverNumber: number | null = typeof prog.cursor.meta?.server_number === "number" ? (prog.cursor.meta.server_number as number) : null;
    const meta = async (): Promise<void> => {
      const status = await client.get("get_status") as Record<string, unknown> | null;
      const n = status && typeof status.server_number === "number" ? status.server_number : null;
      serverNumber = n;
      prog.cursor.meta = { done: true, server_number: n };
      if (n !== null && archive.append({ dataType: "meta", entityKey: "server_number", raw: { server_number: n } })) {
        prog.counts.meta = (prog.counts.meta ?? 0) + 1;
      }
    };
    const stages: [string, () => Promise<boolean | void>][] = [
      ["meta", meta],
      ["vip", () => single(client, archive, "get_vip_ids", "vip", prog)],
      ["ban", () => single(client, archive, "get_bans", "ban", prog)],
      ["blacklist", () => single(client, archive, "get_blacklists", "blacklist", prog)],
      ["blacklist_record", () => blacklistRecords(client, repo, jobId, file, archive, prog)],
      ["standard_message", () => messages(client, archive, prog)],
      ["map_history", () => single(client, archive, "get_map_history", "map_history", prog)],
      // Every round's FULL record: final score plus per-player rows with the score buckets,
      // vehicle kills and round playtime — figures no log line carries, so skipping this stage
      // loses them forever. Rows are heavy (a hundred players each, weapons dicts and all),
      // hence the small page.
      ["map_scoreboard", () => paged(client, repo, jobId, archive, "get_scoreboard_maps", "map_scoreboard", prog, { page_size: 25 })],
      ["watchlist", () => paged(client, repo, jobId, archive, "get_players_history", "watchlist", prog, { is_watched: "true", page_size: 500 })],
      ["player", () => paged(client, repo, jobId, archive, "get_players_history", "player", prog, { page_size: 500 })],
      ["player_detail", () => playerDetail(client, repo, jobId, file, archive, prog)],
      ["player_detail_retry", () => retryPlayerDetail(client, repo, jobId, archive, prog)],
      // The deep history last: by far the longest stages on a mature CRCON (every log line ever
      // seen), so everything quick lands first and a pause mid-history still leaves a useful
      // archive. The action filter is a PREFIX match on CRCON's side, which is what lets one stage
      // cover a whole family ("CHAT" → CHAT[Allies][Team] and friends, "ADMIN" → kicks/bans/misc,
      // "VOTE" → started/completed/ballots, "TK" → the auto-TK enforcement lines).
      ["log_kill", () => historicalLogs(client, repo, jobId, archive, "KILL", "log_kill", prog, serverNumber)],
      ["log_teamkill", () => historicalLogs(client, repo, jobId, archive, "TEAM KILL", "log_teamkill", prog, serverNumber)],
      ["log_match", () => historicalLogs(client, repo, jobId, archive, "MATCH", "log_match", prog, serverNumber)],
      ["log_connect", () => historicalLogs(client, repo, jobId, archive, "CONNECTED", "log_connect", prog, serverNumber)],
      ["log_disconnect", () => historicalLogs(client, repo, jobId, archive, "DISCONNECTED", "log_disconnect", prog, serverNumber)],
      ["log_teamswitch", () => historicalLogs(client, repo, jobId, archive, "TEAMSWITCH", "log_teamswitch", prog, serverNumber)],
      ["log_admin", () => historicalLogs(client, repo, jobId, archive, "ADMIN", "log_admin", prog, serverNumber)],
      ["log_message", () => historicalLogs(client, repo, jobId, archive, "MESSAGE", "log_message", prog, serverNumber)],
      ["log_vote", () => historicalLogs(client, repo, jobId, archive, "VOTE", "log_vote", prog, serverNumber)],
      ["log_tkauto", () => historicalLogs(client, repo, jobId, archive, "TK", "log_tkauto", prog, serverNumber)],
      ["log_camera", () => historicalLogs(client, repo, jobId, archive, "CAMERA", "log_camera", prog, serverNumber)],
      ["log_chat", () => historicalLogs(client, repo, jobId, archive, "CHAT", "log_chat", prog, serverNumber)],
    ];
    for (const [key, run] of stages) {
      if (await stopped(repo, jobId)) return; // paused/cancelled between stages
      if ((await stage(key, run)) === "stop") return;
    }

    await repo.crconSnapshot.updateJob(jobId, { status: "done", cursor: prog.cursor, counts: prog.counts, errors: prog.errors });
    slog.info("CRCON backup pull complete", { counts: prog.counts, errors: prog.errors.length });
  } catch (err) {
    // Only fatal (auth) errors land here. Keep the cursor so a resume can pick up where it stopped.
    prog.errors.push((err as Error).message);
    await repo.crconSnapshot.updateJob(jobId, { status: "error", cursor: prog.cursor, counts: prog.counts, errors: prog.errors });
    slog.warn("CRCON backup pull failed", { err: (err as Error).message });
  } finally {
    await archive.close();
  }
}

/** Auth failures (bad/expired API key) are fatal — retrying or continuing won't help. */
function isAuthFailure(err: unknown): boolean {
  return err instanceof Error && /rejected the API key/i.test(err.message);
}

/**
 * Scan-loop entry: find jobs still marked `running` and drive any not already active in this
 * process. Idempotent — a job already being driven is skipped. Call periodically.
 */
export async function driveImportJobs(repo: Repository, active: Map<string, Promise<void>>): Promise<void> {
  for (const job of await repo.crconSnapshot.listJobs()) {
    if (job.status !== "running" || active.has(job.id)) continue;
    // The stored promise is never awaited, so a rejection escaping runImportJob (a failing
    // repo write in its own error path, an archive close on a dead disk) would otherwise be an
    // unhandled rejection — which kills the whole worker process, every server's ingest with it.
    const p = runImportJob(repo, job.id)
      .catch((err: Error) => log.warn("CRCON import job driver crashed", { jobId: job.id, err: err.message }))
      .finally(() => active.delete(job.id));
    active.set(job.id, p);
  }
}
