/**
 * Whole-database export & import — the clean-slate migration path (Admin → Backup).
 *
 * Everything runs as ONE background job at a time, polled over /api/data/status, because both
 * directions can be minutes of work on a big install and no proxy keeps a request open that long
 * (the CRCON transform learned this in production). Files live on the host under the same
 * directory as trim backups; the download/upload routes stream them, never buffer them.
 *
 * The archive format ({header} line, then {table, row} NDJSON, gzipped) is the seam a future
 * CRCON-database adapter feeds — see docs/data-port.md.
 */
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import type { AppContext } from "../context.js";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { readJsonBody, sendError, sendFile, sendJson, str } from "../http.js";
import { canAnywhere, holdsOutright } from "@app/access";
import { DATA_EXPORT_GROUPS, DATA_PORT_ACCESS_TABLES, allDataGroups, tablesForDataGroups } from "@app/db";
import type { DataPortRun } from "../context.js";
import { requirePrincipal, route, sendForbidden, TRIM_BACKUP_DIR, type Route } from "./kit.js";

// Resolved per call so a test can point BACKUP_DIR at a temp directory; production leaves it
// unset and shares the trim backups' home.
const backupDir = () => process.env.BACKUP_DIR || TRIM_BACKUP_DIR;
const exportFile = () => `${backupDir()}/data-export.ndjson.gz`;
const uploadFile = () => `${backupDir()}/data-upload.ndjson.gz`;
/**
 * Who uploaded the archive waiting for import, kept beside it on disk so a restart cannot forget
 * it. An import is only as trustworthy as the file it reads, and the upload slot is shared: an
 * owner importing a file a non-owner put there would otherwise lend that file the owner's
 * authority. Missing or unreadable reads as "not an owner's".
 */
const uploaderFile = () => `${uploadFile()}.by.json`;
interface Uploader { userId: string; name: string; owner: boolean }
async function readUploader(): Promise<Uploader | null> {
  try {
    const raw = JSON.parse(await readFile(uploaderFile(), "utf8")) as Partial<Uploader>;
    return typeof raw.userId === "string" ? { userId: raw.userId, name: String(raw.name ?? ""), owner: raw.owner === true } : null;
  } catch { return null; }
}

/**
 * Full backups: every catalogued table in one timestamped archive, accumulating in the backup
 * folder (a host-mounted directory in the compose stack, so the files are visible and copyable
 * on the host machine) rather than overwriting a singleton the way the migration export does.
 *
 * The NAME IS THE VALIDATION: a stored backup is only ever addressed by a string this pattern
 * accepts, and the pattern admits no separators — so a crafted "../" name cannot reach outside
 * the backup folder, on any platform, without a resolve-and-compare dance to get wrong.
 */
// full-backup-* is the button, auto-backup-* is the worker's nightly run — one folder, one list,
// both restorable. The split prefix exists for ROTATION: the worker prunes only its own.
const BACKUP_NAME = /^(?:full|auto)-backup-\d{8}-\d{6}\.ndjson\.gz$/;
const backupFileName = (now = new Date()) =>
  `full-backup-${now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.ndjson.gz`;
const backupPath = (name: string) => `${backupDir()}/${name}`;

/** The stored backups, newest first — the list the panel renders and the restore picks from.
 *  A file deleted between the directory read and its stat is simply no longer a backup — skipped,
 *  never a 500 for whoever is looking at the list while housekeeping runs. */
async function listBackups(): Promise<{ name: string; bytes: number; createdAt: string }[]> {
  const names = await readdir(backupDir()).catch(() => [] as string[]);
  const out: { name: string; bytes: number; createdAt: string }[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const st = statSync(backupPath(name));
      out.push({ name, bytes: st.size, createdAt: st.mtime.toISOString() });
    } catch { /* vanished mid-list */ }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Both directions hold the same lock: an import racing an export would archive a half-written
 *  database, and two imports would interleave batches. An in-flight upload counts too — an
 *  import must not start reading a file that is still streaming onto disk. */
function busy(run: { current: DataPortRun | null; uploading: boolean }): boolean {
  return run.current?.status === "running" || run.uploading;
}

/** A CRCON archive being applied for real writes players, VIPs and bans as it goes — an import or
 *  restore underneath it would interleave the two and leave neither. (A dry run writes to a
 *  throwaway store and does not count.) */
function crconApplying(ctx: AppContext): boolean {
  return [...ctx.crconTransforms.values()].some((r) => r.status === "running" && !r.dry);
}
const CRCON_BUSY = "a CRCON import is being applied — wait for it to finish first";

export const dataPortRoutes: Route[] = [
  // The catalog the Backup screen renders: every selectable group with its label, hint and the
  // groups its foreign keys need — plus whether this install can export at all (Postgres only).
  route("GET", "/api/data/options", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "read")) return sendForbidden(res, "admin.data", "read");
    sendJson(res, 200, { supported: ctx.repo.dataPort.supported, groups: DATA_EXPORT_GROUPS });
  }),

  // Row counts per selected group — the "what would this carry" preview. Changes nothing.
  route("POST", "/api/data/counts", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "read")) return sendForbidden(res, "admin.data", "read");
    const groups = await readGroups(req);
    if ("error" in groups) return sendError(res, 400, groups.error);
    if (!ctx.repo.dataPort.supported) return sendError(res, 400, "data export/import requires a Postgres database");
    sendJson(res, 200, { counts: await ctx.repo.dataPort.counts(groups.groups) });
  }),

  // Start an export job. 202 immediately; the panel polls /api/data/status, then downloads.
  route("POST", "/api/data/export", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    const groups = await readGroups(req);
    if ("error" in groups) return sendError(res, 400, groups.error);
    if (busy(ctx.dataPortRun)) return sendError(res, 409, "an export, import or upload is already in progress");
    if (!ctx.repo.dataPort.supported) return sendError(res, 400, "data export/import requires a Postgres database");
    const run: DataPortRun = { kind: "export", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rows: 0, groups: groups.groups };
    ctx.dataPortRun.current = run;
    const by = { userId: p.user.id, name: p.name };
    void (async () => {
      try {
        const result = await ctx.repo.dataPort.export(groups.groups, exportFile(), (rows) => { run.rows = rows; run.updatedAt = new Date().toISOString(); });
        run.status = "done";
        run.rows = result.rows;
        run.file = exportFile();
        run.fileBytes = statSync(exportFile()).size;
        run.updatedAt = new Date().toISOString();
        await ctx.repo.audit.create({
          actorUserId: by.userId, actorName: by.name, action: "data.export",
          targetType: "setting", targetId: "data-port",
          summary: `exported ${result.rows} row(s) (${groups.groups.join(", ")}) to an archive`,
          data: { groups: groups.groups, tables: result.tables, rows: result.rows },
        });
      } catch (err) {
        run.status = "error";
        run.error = (err as Error).message;
        run.updatedAt = new Date().toISOString();
      }
    })();
    sendJson(res, 202, { started: true });
  }),

  // Poll the running/last job. Forgotten on API restart; both directions are safe to redo.
  route("GET", "/api/data/status", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "read")) return sendForbidden(res, "admin.data", "read");
    const upload = existsSync(uploadFile()) ? { bytes: statSync(uploadFile()).size, uploadedBy: (await readUploader())?.name ?? null } : null;
    sendJson(res, 200, { run: ctx.dataPortRun.current ?? { status: "idle" }, upload });
  }),

  // Download the last export — streamed from disk, flat memory whatever the size. Write level:
  // the archive carries every selected table verbatim, server RCON credentials included.
  route("GET", "/api/data/download", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    // A running export is writing THIS file: streaming it now would hand out a truncated gzip
    // that looks like a backup and doesn't open.
    if (ctx.dataPortRun.current?.status === "running" && ctx.dataPortRun.current.kind === "export") {
      return sendError(res, 409, "the export is still being written — wait for it to finish");
    }
    if (!existsSync(exportFile())) return sendError(res, 404, "no export archive yet — run an export first");
    sendFile(res, exportFile(), {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="data-export-${new Date().toISOString().slice(0, 10)}.ndjson.gz"`,
      "content-length": String(statSync(exportFile()).size),
    });
  }),

  // Upload an archive for import — streamed to disk, replacing any previous upload. The audit
  // row is written here (not at import) so an uploaded-but-never-imported archive still shows
  // who brought it in.
  route("POST", "/api/data/upload", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    if (busy(ctx.dataPortRun)) return sendError(res, 409, "an export, import or upload is already in progress");
    ctx.dataPortRun.uploading = true;
    let bytes: number;
    // Written beside the slot and moved in only once all of it has arrived: an upload cut off
    // part-way (a phone changing networks) left half an archive that read as one ready to import,
    // in place of the last complete one.
    const partial = `${uploadFile()}.partial`;
    try {
      await mkdir(dirname(uploadFile()), { recursive: true });
      try {
        await pipeline(req, createWriteStream(partial));
      } catch (err) {
        await unlink(partial).catch(() => {});
        throw err;
      }
      bytes = statSync(partial).size;
      // The old uploader goes before the archive changes: the new bytes must never sit under the
      // old name.
      await unlink(uploaderFile()).catch(() => {});
      await rename(partial, uploadFile());
      const by: Uploader = { userId: p.user.id, name: p.name, owner: holdsOutright(p.grants, "*", "write") };
      await writeFile(uploaderFile(), JSON.stringify(by));
    } finally {
      ctx.dataPortRun.uploading = false;
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "data.upload",
      targetType: "setting", targetId: "data-port",
      summary: `uploaded a data archive (${bytes} bytes) for import`,
    });
    sendJson(res, 200, { bytes });
  }),

  // Start an import of the uploaded archive. Existing rows always win; the report says what
  // landed, what was already there, and what the database refused.
  route("POST", "/api/data/import", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    if (busy(ctx.dataPortRun)) return sendError(res, 409, "an export, import or upload is already in progress");
    if (crconApplying(ctx)) return sendError(res, 409, CRCON_BUSY);
    if (!ctx.repo.dataPort.supported) return sendError(res, 400, "data export/import requires a Postgres database");
    if (!existsSync(uploadFile())) return sendError(res, 404, "no uploaded archive — upload one first");
    const run: DataPortRun = { kind: "import", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rows: 0 };
    ctx.dataPortRun.current = run;
    const by = { userId: p.user.id, name: p.name };
    /*
     * An archive is a file anyone can write by hand, and import inserts its rows verbatim — so a
     * grants row is a grant, a users row with a known password hash is an account (the oldest one
     * the setup account), and a Discord mapping hands out roles. admin.data is not ownership: a
     * server's "*" passes its scope-blind gate, and the Administrator preset carries it. So for
     * anyone short of an owner those tables are refused ROW BY ROW and reported, rather than the
     * whole archive turned away: a migration's players, bans and history still land, and the report
     * says exactly what was held back and why. An owner's import is unchanged — of a file an owner
     * uploaded: one a non-owner put in the shared slot is held back the same way, whoever imports it.
     */
    const ownersFile = holdsOutright(p.grants, "*", "write") && (await readUploader())?.owner === true;
    const refuseTables = ownersFile ? undefined : new Set(DATA_PORT_ACCESS_TABLES);
    void (async () => {
      try {
        const report = await ctx.repo.dataPort.import(uploadFile(), (rows) => { run.rows = rows; run.updatedAt = new Date().toISOString(); }, { refuseTables });
        run.status = "done";
        run.report = report;
        run.updatedAt = new Date().toISOString();
        const totals = Object.values(report).reduce((a, r) => ({ inserted: a.inserted + r.inserted, skipped: a.skipped + r.skipped, failed: a.failed + r.failed }), { inserted: 0, skipped: 0, failed: 0 });
        await ctx.repo.audit.create({
          actorUserId: by.userId, actorName: by.name, action: "data.import",
          targetType: "setting", targetId: "data-port",
          summary: `imported a data archive: ${totals.inserted} row(s) added, ${totals.skipped} already present, ${totals.failed} refused`,
          data: { report },
        });
      } catch (err) {
        run.status = "error";
        run.error = (err as Error).message;
        run.updatedAt = new Date().toISOString();
      }
    })();
    sendJson(res, 202, { started: true });
  }),

  // --- Full backups: one press, everything, a timestamped file on the host ---

  // Create a full backup NOW: every catalogued group in one archive. The CRCON-imported history
  // needs no special casing — those rows live in the same tables (game log, matches, sessions,
  // careers) and ride along like everything else, so a restore never needs the CRCON archive or
  // a re-import.
  route("POST", "/api/data/backup", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    if (!ctx.repo.dataPort.supported) return sendError(res, 400, "full backups require a Postgres database");
    // The busy check and the claim sit together with no await between them — see the restore route.
    if (busy(ctx.dataPortRun)) return sendError(res, 409, "an export, import or upload is already in progress");
    const name = backupFileName();
    const groups = allDataGroups();
    const run: DataPortRun = { kind: "backup", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rows: 0, groups, file: name };
    ctx.dataPortRun.current = run;
    const by = { userId: p.user.id, name: p.name };
    void (async () => {
      // Written under a name the list ignores and RENAMED into place only when whole — so a
      // backup that dies half-written (disk full, a crash) never sits in the list wearing a
      // restorable name. The restore's own archive validation is the second line of defence;
      // this keeps the corpse out of the folder in the first place.
      const partial = `${backupPath(name)}.partial`;
      try {
        await mkdir(backupDir(), { recursive: true });
        const result = await ctx.repo.dataPort.export(groups, partial, (rows) => { run.rows = rows; run.updatedAt = new Date().toISOString(); });
        await rename(partial, backupPath(name));
        run.status = "done";
        run.rows = result.rows;
        run.fileBytes = statSync(backupPath(name)).size;
        run.updatedAt = new Date().toISOString();
        await ctx.repo.audit.create({
          actorUserId: by.userId, actorName: by.name, action: "data.backup",
          targetType: "setting", targetId: "data-port", targetName: name,
          summary: `created a full backup (${result.rows} row(s), every data group) — ${name}`,
          data: { file: name, rows: result.rows, tables: Object.keys(result.tables).length },
        });
      } catch (err) {
        await unlink(partial).catch(() => { /* nothing landed */ });
        run.status = "error";
        run.error = (err as Error).message;
        run.updatedAt = new Date().toISOString();
      }
    })();
    sendJson(res, 202, { started: true, file: name });
  }),

  // The stored backups — what is on the host, newest first.
  route("GET", "/api/data/backups", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "read")) return sendForbidden(res, "admin.data", "read");
    sendJson(res, 200, { backups: await listBackups() });
  }),

  // Download one stored backup. Write level, same as the migration export's download: the archive
  // carries every table verbatim, sealed RCON credentials included.
  route("GET", "/api/data/backups/:name", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    const name = params.name ?? "";
    if (!BACKUP_NAME.test(name)) return sendError(res, 400, "not a backup file name");
    // The running backup is writing THIS file — a download now would hand out a truncated gzip.
    if (ctx.dataPortRun.current?.status === "running" && ctx.dataPortRun.current.kind === "backup" && ctx.dataPortRun.current.file === name) {
      return sendError(res, 409, "this backup is still being written — wait for it to finish");
    }
    if (!existsSync(backupPath(name))) return sendError(res, 404, "no such backup");
    sendFile(res, backupPath(name), {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${name}"`,
      "content-length": String(statSync(backupPath(name)).size),
    });
  }),

  // Delete one stored backup — housekeeping for the folder the button fills.
  route("DELETE", "/api/data/backups/:name", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    const name = params.name ?? "";
    if (!BACKUP_NAME.test(name)) return sendError(res, 400, "not a backup file name");
    // Being written OR being restored from: either way this file is in use, and deleting the one
    // a running restore is reading would strand the restore mid-archive.
    if (ctx.dataPortRun.current?.status === "running" && (ctx.dataPortRun.current.kind === "backup" || ctx.dataPortRun.current.kind === "restore") && ctx.dataPortRun.current.file === name) {
      return sendError(res, 409, ctx.dataPortRun.current.kind === "backup" ? "this backup is still being written" : "a restore is reading this backup right now");
    }
    if (!existsSync(backupPath(name))) return sendError(res, 404, "no such backup");
    await unlink(backupPath(name));
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "data.backup.delete",
      targetType: "setting", targetId: "data-port", targetName: name,
      summary: `deleted the stored backup ${name}`,
    });
    sendJson(res, 200, { deleted: true });
  }),

  /*
   * Restore a full backup: empty every catalogued table, then import the archive — the whole
   * point of the button above. A plain import cannot do this: a fresh install is not empty
   * (migrations seed the singleton configs and the factory presets, boot seeds the preset
   * roles), and under import's existing-rows-win rule those seeds beat the archive on exactly
   * the rows that matter most — the settings, the roles, the curated map library.
   *
   * Deliberately its own route rather than a flag on import: "add these rows" and "replace the
   * install with this archive" must never be one mistyped field apart.
   */
  route("POST", "/api/data/restore", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.data", "write")) return sendForbidden(res, "admin.data", "write");
    // A restore REPLACES the accounts tables wholesale — every login, grant, role and token becomes
    // the archive's, so restoring a backup from before someone was demoted promotes them again.
    // There is no coherent restore that leaves them out (the rest of the archive points at those
    // accounts), so the whole restore is an owner's decision.
    if (!holdsOutright(p.grants, "*", "write")) return sendError(res, 403, "only an owner can restore a backup — it replaces every account, role and permission with the archive's");
    if (!ctx.repo.dataPort.supported) return sendError(res, 400, "restore requires a Postgres database");
    const body = await readJsonBody(req);
    const name = str(body.file);
    if (!BACKUP_NAME.test(name)) return sendError(res, 400, "not a backup file name");
    if (!existsSync(backupPath(name))) return sendError(res, 404, "no such backup");
    /*
     * The busy check and the claim sit together, AFTER every await. They used to straddle the body
     * read, so a double-click on Restore passed the check twice and ran two restores at once —
     * each wiping and refilling every table under the other.
     */
    if (busy(ctx.dataPortRun)) return sendError(res, 409, "an export, import or upload is already in progress");
    if (crconApplying(ctx)) return sendError(res, 409, CRCON_BUSY);
    const run: DataPortRun = { kind: "restore", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rows: 0, file: name };
    ctx.dataPortRun.current = run;
    const by = { userId: p.user.id, name: p.name };
    // Audited BEFORE the wipe, not after: the restore replaces the audit trail itself with the
    // archive's copy, so a row written afterwards records the restore into the history it just
    // installed — while this row documents, in the OLD trail, who chose to end it. Both rows
    // matter; only this one can say what was overwritten. No record, no wipe — and the claim is
    // given back, or every data operation would read "already in progress" until a restart.
    try {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "data.restore",
        targetType: "setting", targetId: "data-port", targetName: name,
        summary: `started a FULL RESTORE from ${name} — every catalogued table is replaced by the archive`,
      });
    } catch (err) {
      run.status = "error";
      run.error = `the restore was not started: ${(err as Error).message}`;
      run.updatedAt = new Date().toISOString();
      return sendError(res, 500, run.error);
    }
    void (async () => {
      try {
        const report = await ctx.repo.dataPort.restore(backupPath(name), (rows) => { run.rows = rows; run.updatedAt = new Date().toISOString(); });
        run.status = "done";
        run.report = report;
        run.updatedAt = new Date().toISOString();
        const totals = Object.values(report).reduce((a, r) => ({ inserted: a.inserted + r.inserted, failed: a.failed + r.failed }), { inserted: 0, failed: 0 });
        await ctx.repo.audit.create({
          actorUserId: by.userId, actorName: by.name, action: "data.restore",
          targetType: "setting", targetId: "data-port", targetName: name,
          summary: `restored ${name}: ${totals.inserted} row(s) restored, ${totals.failed} refused`,
          data: { file: name, report },
        });
      } catch (err) {
        run.status = "error";
        run.error = (err as Error).message;
        run.updatedAt = new Date().toISOString();
      }
    })();
    sendJson(res, 202, { started: true });
  }),
];

/** Parse + validate { groups: string[] } — unknown ids refused by name, empty refused. */
async function readGroups(req: import("node:http").IncomingMessage): Promise<{ groups: string[] } | { error: string }> {
  const body = await readJsonBody(req);
  const groups = Array.isArray(body.groups) ? (body.groups as unknown[]).map(String) : [];
  if (groups.length === 0) return { error: "pick at least one data group" };
  try {
    tablesForDataGroups(groups); // throws naming any unknown id
  } catch (err) {
    return { error: (err as Error).message };
  }
  return { groups };
}
