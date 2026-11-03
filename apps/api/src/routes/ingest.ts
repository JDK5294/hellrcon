/**
 * Getting data in: live log ingestion, the event and match reads that hang off a server, and the CRCON import/transform jobs.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { displayNameOf } from "../auth.js";
import { transformCrconArchive } from "../crcon-transform.js";
import { readJsonBody, sendError, sendFile, sendJson, str } from "../http.js";
import { can } from "@app/access";
import { InMemoryRepository, type CrconImportJobPatch } from "@app/db";
import { ingestLines } from "@app/ingest";
import { crconBackupFile, errors } from "@app/shared";
import { once } from "node:events";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { CrconTransformRun } from "../context.js";
import { connectGameClient, decommissionLocked, gameClientFor, logger, pageAnchor, pageLimit, pageOffset, pairMatches, requirePrincipal, route, sendForbidden, serverRoute, type Route } from "./kit.js";

/**
 * Which CRCON server an archive says it holds — read from the HEAD of the file, not by scanning it.
 *
 * The database export writes its `meta` record first, so the answer is in the first line. The older
 * network-API pull wrote no meta at all, and its archive cannot be attributed to a server — which
 * on a multi-server install makes it unusable, because CRCON's log store is shared and there is
 * then nothing to tell one server's rows from another's. Surfacing this next to the archive is what
 * lets an operator SEE which era their file is from before spending hours applying the wrong one.
 *
 * null means "this file does not say", never "server 0". Only the first 64 KB is read (a status
 * poll must stay cheap on a 20 GB file), so an archive that was API-pulled and later topped up by
 * an export can still read as null — the Apply does the full, authoritative check in its pre-scan.
 */
async function archiveServerNumber(file: string): Promise<number | null> {
  if (!existsSync(file)) return null;
  let fh;
  try {
    fh = await open(file, "r");
    const buf = Buffer.alloc(65_536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    // Drop the trailing partial line: a half-written record would throw the JSON parse below.
    const head = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of head.slice(0, head.lastIndexOf("\n") + 1).split("\n")) {
      if (!line.startsWith(`{"dataType":"meta",`)) continue;
      const n = (JSON.parse(line) as { raw?: { server_number?: unknown } }).raw?.server_number;
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
    return null;
  } catch { return null; } finally { await fh?.close(); }
}

export const ingestRoutes: Route[] = [
  // Recent stored events for a server (from the event store).
  route("GET", "/api/servers/:id/events", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "server.view", "read", { serverId: id })) return sendForbidden(res, "server.view", "read");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const limit = pageLimit(u, 100, 500);
    const offset = pageOffset(u);
    // The filters go to the DATABASE now. They used to run here, in JavaScript, over whatever the
    // most recent 1000 rows happened to be — so on a busy server a chat search simply could not
    // see past the last few hours of kills, and there was nothing on screen to say so.
    const kindsParam = u.get("kinds");
    const kinds = kindsParam ? kindsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const q = (u.get("q") ?? "").trim() || undefined;
    // `player` accepts our uuid or a platform id, the same contract as the profile route.
    const rawPlayer = (u.get("player") ?? "").trim();
    let playerId: string | undefined;
    if (rawPlayer) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawPlayer);
      const target = (isUuid ? await ctx.repo.players.findById(rawPlayer) : null) ?? await ctx.repo.players.findByPlatformId(rawPlayer);
      if (!target) return sendJson(res, 200, { events: [], total: 0, offset, limit });
      playerId = target.id;
    }
    // Pin the read to the instant it began. The game log is the fastest-moving list here — without
    // this, every event that lands while someone reads page one shifts page two down by a row.
    const { anchor, to } = pageAnchor(u, u.get("to") || undefined);
    const query = { serverId: id, kinds, q, playerId, from: u.get("from") || undefined, to, limit, offset };
    // The page and its total come from the same query, so the count always describes what you see.
    const [events, total] = await Promise.all([ctx.repo.events.query(query), ctx.repo.events.countQuery(query)]);
    sendJson(res, 200, { events, total, offset, limit, anchor });
  }),

  // Everything that has happened THIS ROUND, newest first — what the Live view's feed opens with.
  // The feed is an SSE tail, so it used to begin empty and only ever show what arrived after you
  // reached the screen: walking up to a match already in progress told you nothing about it.
  route("GET", "/api/servers/:id/round/events", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "server.view", "read", { serverId: id })) return sendForbidden(res, "server.view", "read");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const limit = pageLimit(u, 300, 1000);
    const kindsParam = u.get("kinds");
    const kinds = kindsParam ? kindsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const open = await ctx.repo.matches.getOpen(id);
    // No open round — match tracking hasn't seen a start yet, or the server is between maps. Fall
    // back to the most recent events so the feed still opens with context rather than blank, and
    // say so with `round: null` instead of implying the rows are a round.
    const query = { serverId: id, kinds, limit, offset: 0, ...(open ? { from: open.startedAt } : {}) };
    const events = await ctx.repo.events.query(query);
    sendJson(res, 200, {
      events,
      round: open ? { id: open.id, map: open.map, startedAt: open.startedAt } : null,
      limit,
    });
  }),

  // Match history: the match start/end events paired into rounds (map, duration, result). Newest
  // first. server.view-gated.
  route("GET", "/api/servers/:id/matches", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "server.view", "read", { serverId: id })) return sendForbidden(res, "server.view", "read");
    const mu = new URL(req.url ?? "", "http://x").searchParams;
    const limit = pageLimit(mu, 50, 200);
    const offset = pageOffset(mu);
    // Same snapshot rule as the game log: a round ending mid-read must not shift every later page.
    const { anchor } = pageAnchor(mu);
    // The durable match store is authoritative — live tracking writes it and the CRCON import
    // backfills it. Event pairing remains as a FALLBACK for rounds that predate both (it reads the
    // trimmable recent-event window), deduped against the durable rows by start minute.
    const durable = (await ctx.repo.matches.list(id, limit, offset, anchor)).map((m) => ({
      // The id is what makes a row openable. Legacy rows paired from the event window below have
      // no durable record and so carry none — those stay un-clickable rather than linking nowhere.
      id: m.id,
      map: m.map, startedAt: m.startedAt, endedAt: m.endedAt,
      durationSec: m.endedAt ? Math.max(0, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 1000)) : null,
      result: m.result,
      score: m.alliedScore != null && m.axisScore != null ? `${m.alliedScore} - ${m.axisScore}` : null,
    }));
    // Rounds that predate the durable store are reconstructed from the recent-event window. That
    // window is finite and unpaged, so they are only offered on the FIRST page — appending them to
    // page two would interleave a fixed set into a moving one and repeat rows.
    // A legacy row genuinely has no durable id — the panel keys off that to decide whether the row
    // can be opened, so the type says so rather than pretending every row has one.
    let matches: { id?: string; map: string | null; startedAt: string; endedAt: string | null; durationSec: number | null; result: string | null; score: string | null }[] = durable;
    if (offset === 0) {
      const covered = new Set(durable.map((m) => m.startedAt.slice(0, 16)));
      const events = await ctx.repo.events.listRecent(id, 2000);
      const legacy = pairMatches(events).filter((m) => !covered.has(m.startedAt.slice(0, 16)));
      matches = [...durable, ...legacy].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
    }
    const total = await ctx.repo.matches.count(id);
    sendJson(res, 200, { matches, total, offset, limit, anchor });
  }),

  // One-shot pull of the admin log into the event store (handy without a running worker).
  // Reads only (safe in observe mode); writes to OUR store, not the game server.
  route("POST", "/api/servers/:id/ingest", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    // One-shot ingest WRITES events/stats — an operator tool, not a viewer feature. Scoped to the
    // server in the path: unscoped, this was wrong in both directions at once — an operator granted
    // server.manage on one server could not ingest it, and a global grant could ingest any of them.
    if (!can(p.grants, "server.manage", "write", { serverId: id })) return sendForbidden(res, "server.manage", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const lines = await client.readLogLines();
      // publish each stored event to the plugin bus so plugins react to live activity
      // Warnings: stored all the same, less fully (a team switch left unlinked) — reported, not failed.
      const warnings: string[] = [];
      const ingested = await ingestLines(ctx.repo, id, lines, (evt) => ctx.bus.emit(evt.kind, evt), server.game, (w) => warnings.push(w));
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "ingest.run",
        targetType: "server", targetId: id, targetName: server.name, serverId: id,
        summary: `ran a one-shot log ingest on ${server.name} — ${ingested} event(s)`,
        data: warnings.length ? { ingested, warnings } : { ingested },
      });
      sendJson(res, 200, warnings.length ? { ingested, warnings } : { ingested });
    } catch (err) {
      throw errors.upstream(`ingest failed: ${(err as Error).message}`, { serverId: id, host: server.host, port: server.port });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // --- CRCON backup snapshot: the slow, resumable full-data pull (worker-driven) ---
  // Start (or resume) the background pull. A running job is returned as-is; a paused one is resumed;
  // otherwise a new job is created with the CRCON URL + key (key stored server-side, never returned).
  route("POST", "/api/servers/:id/import/crcon/job", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "crcon.pull", "write", { serverId: id })) return sendForbidden(res, "crcon.pull", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const latest = await ctx.repo.crconSnapshot.latestJob(id);
    if (latest?.status === "running") return sendJson(res, 200, { job: latest, note: "a pull is already running" });
    const body = await readJsonBody(req);
    // Resume a paused OR errored job from its saved cursor (keeps the progress + archive file) rather
    // than re-pulling from scratch — a pull that stopped near the end shouldn't lose hours of work.
    // Credentials may be supplied again on resume: a CRCON key that was rotated or expired is the
    // usual reason a pull stopped, and without this the job could never be revived.
    // `restart: true` abandons the old job and starts fresh instead (the archive file is kept, so
    // already-pulled records are still deduped).
    if (latest && (latest.status === "paused" || latest.status === "error") && !body.restart) {
      const patch: CrconImportJobPatch = { status: "running" };
      const newUrl = str(body.baseUrl).trim();
      const newKey = str(body.apiKey).trim();
      if (newUrl) patch.baseUrl = newUrl;
      if (newKey) patch.apiKey = newKey;
      // A resume after a failure should not inherit the old error list — it reads as still-broken.
      if (latest.status === "error") patch.errors = [];
      const resumed = await ctx.repo.crconSnapshot.updateJob(latest.id, patch);
      return sendJson(res, 200, { job: resumed, note: newKey || newUrl ? "resumed with new credentials" : "resumed" });
    }
    const baseUrl = (str(body.baseUrl).trim() || latest?.baseUrl || server.crconBaseUrl || "").trim();
    const apiKey = str(body.apiKey).trim() || (server.protocol === "crcon-bridge" ? server.password : "");
    if (!baseUrl) return sendError(res, 400, "a CRCON base URL is required (set it on the server, or pass baseUrl)");
    if (!apiKey) return sendError(res, 400, "a CRCON API key is required (pass apiKey)");
    const job = await ctx.repo.crconSnapshot.createJob({ serverId: id, baseUrl, apiKey, createdByUserId: p.user.id, createdByName: displayNameOf(p.user) });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "import.crcon.job.start",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `started a CRCON backup pull for ${server.name}`,
    });
    sendJson(res, 201, { job, note: "started" });
  }),

  // Latest job status + a per-data-type progress summary (from the job's live counts) and the
  // archive file's size. We never scan the file here — status polls must stay cheap.
  route("GET", "/api/servers/:id/import/crcon/job", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "crcon.pull", "read", { serverId: params.id })) return sendForbidden(res, "crcon.pull", "read");
    const job = await ctx.repo.crconSnapshot.latestJob(params.id!);
    const counts = (job?.counts ?? {}) as Record<string, number>;
    const archive = Object.entries(counts).map(([dataType, count]) => ({ dataType, count })).sort((a, b) => a.dataType.localeCompare(b.dataType));
    const file = crconBackupFile(params.id!);
    const fileBytes = existsSync(file) ? statSync(file).size : 0;
    sendJson(res, 200, { job, archive, fileBytes, archiveServerNumber: await archiveServerNumber(file) });
  }),

  // Pause a running pull (the worker stops between pages; the cursor is already persisted). Resume
  // via POST .../job.
  route("POST", "/api/servers/:id/import/crcon/job/pause", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "crcon.pull", "write", { serverId: params.id! })) return sendForbidden(res, "crcon.pull", "write");
    if (await decommissionLocked(ctx, p, params.id!)) return sendError(res, 404, "server not found");
    const job = await ctx.repo.crconSnapshot.latestJob(params.id!);
    if (!job) return sendError(res, 404, "no pull to pause");
    const updated = job.status === "running" ? await ctx.repo.crconSnapshot.updateJob(job.id, { status: "paused" }) : job;
    if (updated?.status === "paused" && job.status === "running") {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "crcon.pause",
        targetType: "server", targetId: params.id!, serverId: params.id!,
        summary: `paused the CRCON pull`,
        data: { jobId: job.id },
      });
    }
    sendJson(res, 200, { job: updated });
  }),

  // Retry the failures of a finished pull — WITHOUT re-pulling what already succeeded. Flips the
  // latest done/error job back to running with a surgical cursor reset: stages that failed (their
  // error lines are prefixed with the stage key) lose their cursor entry so they re-run; failed
  // player profiles ("player_profile <id>: …") are queued for the worker's retry stage; and any
  // stage ADDED since the pull finished has no cursor entry, so it runs too — this is also the
  // "top up an old archive with newly supported data types" button. The archive file is appended
  // to (never truncated) and the worker pre-seeds its dedupe from the file, so nothing doubles.
  route("POST", "/api/servers/:id/import/crcon/job/retry", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "crcon.pull", "write", { serverId: params.id! })) return sendForbidden(res, "crcon.pull", "write");
    if (await decommissionLocked(ctx, p, params.id!)) return sendError(res, 404, "server not found");
    const job = await ctx.repo.crconSnapshot.latestJob(params.id!);
    if (!job) return sendError(res, 404, "no pull to retry — run a backup pull first");
    if (job.status === "running") return sendError(res, 400, "the pull is still running");
    if (job.status === "paused") return sendError(res, 400, "the pull is paused — Resume it instead");
    const cursor = { ...(job.cursor as Record<string, unknown>) };
    const pids: string[] = [];
    for (const line of job.errors) {
      const profile = /^player_profile (\S+):/.exec(line);
      if (profile) { pids.push(profile[1]!); continue; }
      const prefix = line.split(":")[0]?.trim() ?? "";
      if (prefix && prefix in cursor) delete cursor[prefix]; // failed stage → re-run it
      if (prefix.startsWith("get_standard_")) delete cursor.standard_message;
    }
    const uniquePids = [...new Set(pids)];
    if (uniquePids.length) cursor.player_detail_retry = { pids: uniquePids, done: false };
    else delete cursor.player_detail_retry;
    const updated = await ctx.repo.crconSnapshot.updateJob(job.id, { status: "running", cursor, errors: [] });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "import.crcon.job.retry",
      targetType: "server", targetId: params.id!, serverId: params.id!,
      summary: `retried the CRCON pull's failures (${uniquePids.length} player profile${uniquePids.length === 1 ? "" : "s"}, ${job.errors.length} recorded issue${job.errors.length === 1 ? "" : "s"})`,
    });
    sendJson(res, 200, { job: updated, retriedProfiles: uniquePids.length });
  }),

  // Download the archive file (NDJSON, one {dataType, entityKey, raw} per line). Streamed straight
  // from disk — never buffered — so a huge archive downloads with a flat memory footprint. This IS
  // the durable backup: once pulled, the data never has to come from CRCON again.
  serverRoute("GET", "/api/servers/:id/import/crcon/export", "crcon.pull", "read", async ({ res, params }) => {
    const file = crconBackupFile(params.id!);
    if (!existsSync(file)) return sendError(res, 404, "no archive yet — run a backup pull first");
    sendFile(res, file, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="crcon-backup-${params.id}.ndjson"`,
      "content-length": String(statSync(file).size),
    });
  }),

  // Re-upload a previously exported archive, replacing the host-side file. Lets a saved backup be
  // restored — or moved to another server — then transformed, all without touching CRCON.
  route("POST", "/api/servers/:id/import/crcon/upload", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "crcon.pull", "write", { serverId: id })) return sendForbidden(res, "crcon.pull", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    // Same guards as deleting the archive: replacing the file out from under a pull that is
    // appending to it, or an Apply that is streaming it, corrupts whichever one loses the race.
    if (ctx.crconTransforms.get(id)?.status === "running") return sendError(res, 409, "an Apply run is reading the archive — wait for it to finish");
    if ((await ctx.repo.crconSnapshot.latestJob(id))?.status === "running") return sendError(res, 409, "a backup pull is writing the archive — pause it first");
    const file = crconBackupFile(id);
    await mkdir(dirname(file), { recursive: true });
    // Streamed to disk line by line — a real archive runs to hundreds of megabytes, which is why
    // this must never buffer the body (the old readRawBody path capped out at 1 MB and refused
    // exactly the files this route exists for). Valid lines land in a .partial that only replaces
    // the real file once the whole body has arrived, so a dropped connection cannot leave a
    // half-written archive wearing the real name.
    const partial = `${file}.upload-partial`;
    const out = createWriteStream(partial);
    let kept = 0, skipped = 0;
    try {
      const rl = createInterface({ input: req, crlfDelay: Infinity });
      for await (const line of rl) {
        const s = line.trim();
        if (!s) continue;
        let rec: { dataType?: unknown; entityKey?: unknown };
        try { rec = JSON.parse(s); } catch { skipped += 1; continue; }
        if (!str(rec.dataType) || !str(rec.entityKey)) { skipped += 1; continue; }
        if (!out.write(`${s}\n`)) await once(out, "drain");
        kept += 1;
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      await rename(partial, file);
    } catch (err) {
      out.destroy();
      await unlink(partial).catch(() => {});
      throw err;
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "import.crcon.upload",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `uploaded a CRCON backup into ${server.name}: ${kept} record(s), ${skipped} skipped`,
    });
    sendJson(res, 200, { imported: kept, skipped, errors: [] });
  }),

  // Transform the archive into our own systems (players, VIPs, bans, watchlist, notes,
  // templates). Reads only the archive — never CRCON — and is idempotent, so it's safe to re-run
  // after a parser fix without re-pulling.
  // "Apply to panel" — STARTS a background run and returns immediately. It used to answer inline,
  // but a multi-million-row archive takes longer than any proxy or browser keeps a request open
  // (the production tunnel canceled every attempt), so the panel now polls the status route below.
  route("POST", "/api/servers/:id/import/crcon/transform", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "crcon.apply", "write", { serverId: id })) return sendForbidden(res, "crcon.apply", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    if (ctx.crconTransforms.get(id)?.status === "running") return sendError(res, 409, "an Apply run is already in progress for this server");
    // A real Apply writes as it goes; a data import or restore replacing the same tables at the
    // same time would interleave the two. (Checked again below once dry-or-real is known.)
    const dataRun = ctx.dataPortRun.current;
    const dataWriting = dataRun?.status === "running" && (dataRun.kind === "import" || dataRun.kind === "restore");
    // ?dry=1 — the fire-once safety: the SAME transform, the SAME archive, but into a throwaway
    // in-memory store. Everything is exercised — every parser, every guard, every skip bucket —
    // and the full report comes back with zero writes. Only after a clean dry run does a real
    // Apply have any business running. The throwaway store is seeded with the real cutoff so the
    // overlap rule behaves exactly as it will on the day.
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const dry = q.get("dry") === "1";
    if (!dry && dataWriting) return sendError(res, 409, `a data ${dataRun!.kind} is running — wait for it to finish first`);
    // Default: the archive's VIP expirations win, because an import is a migration and CRCON is the
    // system of record being migrated off. `?keepLiveVips=1` inverts it for the top-up case, where
    // the panel has been the book of record and the backup predates grants staff made since.
    const vipPolicy = q.get("keepLiveVips") === "1" ? "live" as const : "archive" as const;
    const run: CrconTransformRun = { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processed: 0, phase: "scan", ...(dry ? { dry } : {}) };
    ctx.crconTransforms.set(id, run);
    const by = { userId: p.user.id, name: p.name };
    logger.info(dry ? "crcon dry run started" : "crcon apply started", { serverId: id, server: server.name, by: p.name, vipPolicy });
    void (async () => {
      try {
        let target = ctx.repo;
        if (dry) {
          // Counting mode: a real CRCON history is tens of millions of events, and keeping a row
          // object for each one exhausts the heap long before the report is produced — the dry run
          // would die on exactly the archives it exists to check. Imported events are deduped and
          // counted without being retained; nothing downstream reads them back.
          const mem = new InMemoryRepository({ countImportedEvents: true });
          const cutoff = await ctx.repo.events.firstLocalTs(id);
          if (cutoff) {
            // One synthetic local event at the real cutoff instant — firstLocalTs then answers
            // the same date the real Apply will see, so afterCutoff skips match exactly.
            await mem.events.insert([{ serverId: id, ts: cutoff, kind: "evt.kill", actorPlayerId: null, actorName: null, victimPlayerId: null, victimName: null, weapon: null, data: null, dedupeKey: "dry-run-cutoff" }]);
          }
          target = mem;
        }
        const summary = await transformCrconArchive(target, server, by, (n, phase) => { run.processed = n; run.phase = phase; run.updatedAt = new Date().toISOString(); }, { vipPolicy });
        run.status = "done";
        run.summary = summary;
        run.updatedAt = new Date().toISOString();
        logger.info(dry ? "crcon dry run finished" : "crcon apply finished", {
          serverId: id, server: server.name, events: summary.events, matches: summary.matches,
          players: summary.players, errors: summary.errors.length, unrecognized: summary.skipped.unrecognized,
        });
        await ctx.repo.audit.create({
          actorUserId: by.userId, actorName: by.name, action: dry ? "import.crcon.dryRun" : "import.crcon.transform",
          targetType: "server", targetId: id, targetName: server.name, serverId: id,
          summary: dry
            ? `${by.name} dry-ran the CRCON archive against ${server.name} (no writes): ${summary.events} event(s), ${summary.matches} round(s), ${summary.errors.length} error(s), ${summary.skipped.unrecognized} unrecognized`
            : `${by.name} transformed the CRCON archive into ${server.name}: ${summary.players} player(s), ${summary.vips} VIP(s), ${summary.watchlist} watched, ${summary.notes} note(s), ${summary.messages} message(s)${summary.errors.length ? ` (${summary.errors.length} error(s))` : ""}`,
          data: { summary },
        });
      } catch (err) {
        run.status = "error";
        run.error = (err as Error).message;
        run.updatedAt = new Date().toISOString();
        // A failed run used to leave NO durable trace anywhere: the reason lived only in this
        // in-memory run object, which the next API restart forgets, and the audit row below is
        // only written on success. Someone whose Apply died came to the container logs — the one
        // place they'd think to look — and found nothing about it at all. Both records now exist.
        logger.error(dry ? "crcon dry run failed" : "crcon apply failed", {
          serverId: id, server: server.name, phase: run.phase, processed: run.processed, err,
        });
        await ctx.repo.audit.create({
          actorUserId: by.userId, actorName: by.name, action: dry ? "import.crcon.dryRun" : "import.crcon.transform",
          targetType: "server", targetId: id, targetName: server.name, serverId: id,
          summary: `${by.name}'s CRCON ${dry ? "dry run" : "apply"} against ${server.name} failed during ${run.phase} after ${run.processed} row(s): ${run.error}`,
          data: { failed: true, phase: run.phase, processed: run.processed, error: run.error },
        }).catch(() => { /* the log line above is the floor; a dead DB must not mask the real error */ });
      }
    })();
    sendJson(res, 202, { started: true, dry });
  }),

  // Poll the running/last Apply run: status, live processed count, and (when done) the full
  // summary incl. the skip report. Survives the browser navigating away; forgotten on API restart
  // (re-running is always safe — every write is idempotent).
  route("GET", "/api/servers/:id/import/crcon/transform/status", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "crcon.apply", "read", { serverId: params.id })) return sendForbidden(res, "crcon.apply", "read");
    const run = ctx.crconTransforms.get(params.id!);
    sendJson(res, 200, run ?? { status: "idle" });
  }),

  /**
   * Delete the stored archive file — the trim for the "keep everything" copy. The archive is the
   * full-fidelity stand-in for the original backup (every exported row complete, including the
   * fields the transform reads past), which is exactly why deleting it is a deliberate, separate
   * act: after this, those fields exist nowhere but the original backup, and a re-Apply needs a
   * fresh export or upload first. Refused while a pull or Apply is using the file.
   */
  route("DELETE", "/api/servers/:id/import/crcon/archive", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "crcon.pull", "write", { serverId: id })) return sendForbidden(res, "crcon.pull", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    if (ctx.crconTransforms.get(id)?.status === "running") return sendError(res, 409, "an Apply run is reading the archive — wait for it to finish");
    if ((await ctx.repo.crconSnapshot.latestJob(id))?.status === "running") return sendError(res, 409, "a backup pull is writing the archive — pause it first");
    const file = crconBackupFile(id);
    if (!existsSync(file)) return sendError(res, 404, "no stored archive for this server");
    const bytes = statSync(file).size;
    await unlink(file);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "import.crcon.archive.delete",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `deleted ${server.name}'s stored CRCON archive (${Math.round(bytes / 1048576)} MB) — imported history is unaffected; a future re-Apply needs a fresh export or upload`,
      data: { bytes },
    });
    sendJson(res, 200, { deleted: true, bytes });
  }),

  /** What past imports left in the database, and whether any of it is cross-server contaminated
   *  (the same CRCON log row applied under more than one server — the fingerprint of an
   *  unfiltered pull on a multi-server install). Fast SQL only; safe to call any time. */
  route("GET", "/api/servers/:id/import/crcon/integrity", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "crcon.pull", "read", { serverId: params.id })) return sendForbidden(res, "crcon.pull", "read");
    const server = await ctx.repo.servers.findById(params.id!);
    if (!server) return sendError(res, 404, "server not found");
    sendJson(res, 200, await ctx.repo.crconSnapshot.importIntegrity(server.id));
  }),

  /** VIP expiries an old-style Apply moved off the value staff actually granted. Read-only, and
   *  gated on vip.grant rather than crcon.import: it is VIP data being disclosed, whatever moved
   *  it. Empty means every VIP still matches its grant (or has no grant on record to compare). */
  route("GET", "/api/servers/:id/import/crcon/vip-drift", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!can(p.grants, "vip.grant", "read", { serverId: params.id })) return sendForbidden(res, "vip.grant", "read");
    const server = await ctx.repo.servers.findById(params.id!);
    if (!server) return sendError(res, 404, "server not found");
    sendJson(res, 200, { moved: await ctx.repo.crconSnapshot.vipsMovedByImport(server.id) });
  }),

  /**
   * Give VIPs back the time the audit trail says they were set to, where an import cut it. Takes an
   * explicit list of player ids — never "fix everything you find" — so a human has read the drift
   * report and chosen before anything is written. Only ever gives time back (the store refuses to
   * shorten anything): VIP is paid for, and never cut in bulk. Restoring is itself a VIP grant
   * decision, so it needs vip.grant write, and it audits like one.
   */
  route("POST", "/api/servers/:id/import/crcon/vip-drift/restore", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "vip.grant", "write", { serverId: id })) return sendForbidden(res, "vip.grant", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const playerIds = Array.isArray(body.playerIds) ? body.playerIds.map((v) => str(v)).filter(Boolean) : [];
    if (playerIds.length === 0) return sendError(res, 400, "playerIds is required — name the VIPs to restore");
    const restored = await ctx.repo.crconSnapshot.restoreVipExpirations(id, playerIds);
    for (const r of restored) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "vip.grant",
        targetType: "player", targetId: r.playerId, serverId: id,
        summary: `restored ${r.playerId}'s VIP expiry on ${server.name} to the granted value (${r.restoredTo ?? "permanent"}) after an import had moved it`,
        data: { playerId: r.playerId, expiration: r.restoredTo, comment: "restored from the audit trail" },
      });
    }
    logger.info("crcon vip drift restored", { serverId: id, server: server.name, asked: playerIds.length, restored: restored.length, by: p.name });
    sendJson(res, 200, { restored });
  }),

  /**
   * WIPE this server's game data — live and imported alike. The bigger hammer than reset, for when
   * an import's leavings are not worth telling apart from what a re-import rebuilds: it takes
   * everything by server_id rather than by provenance, so nothing an old import wrote can survive
   * by being unmarked.
   *
   * Deliberately narrow in the other direction: another server's rows are never in range (every
   * delete is keyed on this server), configuration is untouched, and the player identities — with
   * the Discord links and balances hanging off them — stay.
   *
   * NO typed confirmation. It was the server's own name, which turned out to be a hundred-character
   * MOTD banner; then the literal "yes", which still failed for anyone whose browser was holding
   * the previous panel bundle and dutifully sending the old value. Two rounds of an operator being
   * told no while doing exactly the right thing. The permission check is the real gate — this route
   * needs crcon.pull write, which not every account has — and the panel asks once before calling.
   * A string comparison a stale client can fail is not security, it is a second way to be wrong.
   */
  route("POST", "/api/servers/:id/purge", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "crcon.pull", "write", { serverId: id })) return sendForbidden(res, "crcon.pull", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    // The wipe-for-reimport tool goes dark with the rest: on a decommissioned server "everything
    // is kept and retrievable" is the owner's promise to keep, nobody else's to break.
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    if (ctx.crconTransforms.get(id)?.status === "running") return sendError(res, 409, "an Apply run is in progress — wait for it before wiping");
    const r = await ctx.repo.crconSnapshot.purgeServerData(id);
    logger.warn("server data wiped", { serverId: id, server: server.name, by: p.name, ...r });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "server.data.purge",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `wiped ${server.name}'s game data: ${r.events.toLocaleString()} event(s), ${r.matches.toLocaleString()} match(es) with ${r.matchStats.toLocaleString()} player line(s), ${r.sessions.toLocaleString()} session(s), ${r.careers.toLocaleString()} career(s), ${r.bans} ban(s), ${r.vips} VIP(s), and for players left with no presence anywhere ${r.notes} note(s), ${r.tags} tag(s), ${r.aliases} alias(es), ${r.ips} IP(s). Settings, accounts and player identities untouched`,
      data: { ...r },
    });
    sendJson(res, 200, r);
  }),

  /**
   * Remove everything a CRCON import wrote to this server's history so a clean archive can be
   * re-applied from zero. The live era is untouched; career counters that imported evidence fed
   * are recomputed from what remains, and the next Apply rebuilds the imported era through the
   * normal counting paths. This is the repair for a contaminated (unfiltered multi-server) or
   * otherwise distrusted import — destructive by design, so it is its own deliberate call.
   */
  route("POST", "/api/servers/:id/import/crcon/reset", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "crcon.pull", "write", { serverId: id })) return sendForbidden(res, "crcon.pull", "write");
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
    if (ctx.crconTransforms.get(id)?.status === "running") return sendError(res, 409, "an Apply run is in progress — wait for it before resetting");
    const r = await ctx.repo.crconSnapshot.resetImportedHistory(id);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "import.crcon.reset",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `reset ${server.name}'s imported CRCON history: ${r.events.toLocaleString()} event(s), ${r.matches} match(es) with ${r.matchStats.toLocaleString()} player line(s), ${r.sessions.toLocaleString()} session(s), ${r.cameraSessions} camera visit(s) removed; ${r.playersRecounted.toLocaleString()} career(s) recounted from live evidence`,
      data: { ...r },
    });
    sendJson(res, 200, r);
  }),
];
