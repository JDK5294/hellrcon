"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt, wasFiled, authHeaders, refusal } from "../lib/api";
import { useConfirm } from "../lib/feedback";
import { PanelGroup, Panel } from "./Panel";
import { Pager, Toggle, Explanation } from "./ui";
import { useClientPages } from "../lib/paged";

/** One export group as /data/options serves it — the catalog lives in @app/db, so a data type
 *  added there appears here without a panel change. `needs` are the groups this one's foreign
 *  keys point at; selecting a group selects them too. */
interface PortGroup { id: string; label: string; hint: string; needs?: string[] }

interface RunStatus {
  status: "idle" | "running" | "done" | "error";
  kind?: "export" | "import" | "backup" | "restore";
  rows?: number;
  file?: string;
  fileBytes?: number;
  report?: Record<string, { read: number; inserted: number; skipped: number; failed: number; error?: string }>;
  error?: string;
}

/** One stored full backup, as /data/backups lists them (newest first). */
interface BackupFile { name: string; bytes: number; createdAt: string }

const mb = (bytes: number) => `${Math.max(0.1, bytes / 1_048_576).toFixed(1)} MB`;

/** Where a run's words go (the panel its button is in), and what it says when it has finished. */
const RUN_SAYS: Record<NonNullable<RunStatus["kind"]>, { at: "full" | "export" | "import"; done: (st: RunStatus) => string }> = {
  backup: { at: "full", done: (st) => `Full backup finished: ${(st.rows ?? 0).toLocaleString()} row(s). The file is in the host's backups folder and listed below.` },
  restore: { at: "full", done: () => "Restore finished — the report below says what came back." },
  export: { at: "export", done: (st) => `Export finished: ${(st.rows ?? 0).toLocaleString()} row(s). Download it below.` },
  import: { at: "import", done: () => "Import finished — the report below says what landed." },
};

/**
 * Export / import the database by data type — the clean-slate migration path: export what you
 * want to keep, stand up a fresh install, upload the archive there. Ids travel verbatim, so
 * everything that references everything else still lines up on the other side.
 */
export default function DataPort() {
  const confirm = useConfirm();
  const [options, setOptions] = useState<{ supported: boolean; groups: PortGroup[] } | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunStatus>({ status: "idle" });
  const [upload, setUpload] = useState<{ bytes: number } | null>(null);
  // What the last action said, in the panel it was taken in. One line served all three panels and
  // showed in two of them, the same words twice, and never in Import: an upload or an import
  // reported only in the panels above it.
  const [msg, setNote] = useState<{ at: "full" | "export" | "import"; text: string }>({ at: "full", text: "" });
  const say = useCallback((at: "full" | "export" | "import") => (text: string) => setNote({ at, text }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  // Whether this screen is still open. A run outlives the screen it was started from; the screen's
  // watch of it does not, or it goes on asking after the run with nobody looking.
  const open = useRef(false);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);

  const refreshStatus = useCallback(async () => {
    const st = await api<{ run?: RunStatus; upload?: { bytes: number } | null }>("/data/status");
    // An answer missing its fields is no run and no upload, not a crash.
    const run = st.run ?? { status: "idle" as const };
    setRun(run);
    setUpload(st.upload ?? null);
    return run;
  }, []);

  const [backups, setBackups] = useState<BackupFile[] | null>(null);
  const backupPages = useClientPages(backups, "data.backups");
  const [backupsErr, setBackupsErr] = useState("");
  // The nightly schedule (app-config; the WORKER runs it). Loaded with the backup list, saved on
  // change — a schedule you have to press Save on is a schedule that is off and looks on.
  const [sched, setSched] = useState<{ autoBackupEnabled: boolean; autoBackupHour: number; autoBackupKeep: number; timezone: string } | null>(null);
  const [schedErr, setSchedErr] = useState("");
  const saveSched = async (patch: Partial<{ autoBackupEnabled: boolean; autoBackupHour: number; autoBackupKeep: number }>) => {
    const prev = sched;
    const next = sched ? { ...sched, ...patch } : null;
    if (next) setSched(next);
    try { await api("/app-config", { method: "PUT", body: patch }); }
    catch (e) {
      // Not saved — refused, or sent for approval — so the schedule shows what is really set.
      setSched(prev);
      say("full")((e as Error).message);
    }
  };
  const loadBackups = useCallback(async () => {
    // A list that failed is not an empty one: "No backups yet" over a folder full of them.
    try { setBackups((await api<{ backups: BackupFile[] }>("/data/backups")).backups); setBackupsErr(""); } catch (e) { setBackups(null); setBackupsErr((e as Error).message); }
    try {
      const c = (await api<{ config: { autoBackupEnabled: boolean; autoBackupHour: number; autoBackupKeep: number; timezone: string } }>("/app-config")).config;
      setSched({ autoBackupEnabled: c.autoBackupEnabled, autoBackupHour: c.autoBackupHour, autoBackupKeep: c.autoBackupKeep, timezone: c.timezone });
      setSchedErr("");
    } catch (e) {
      // Said, not hidden: without the card nobody could tell a failed read from a schedule that
      // isn't offered here.
      setSchedErr((e as Error).message);
    }
  }, []);

  /** Poll until the background run settles — it survives this tab navigating away. "idle"
   *  mid-poll means the API restarted and forgot the run; say so instead of reporting a
   *  success or error that never happened (both directions are safe to redo). Null once the
   *  screen has closed: the run goes on, and the screen opened next follows it. */
  const pollRun = useCallback(async (): Promise<RunStatus | null> => {
    for (;;) {
      if (!open.current) return null;
      const st = await refreshStatus();
      if (st.status === "idle") throw new Error("the run was lost (API restarted) — start it again, it is safe to redo");
      if (st.status !== "running") return st;
      await new Promise((done) => setTimeout(done, 1500));
    }
  }, [refreshStatus]);

  /** Follow a run to its end and say how it ended, in its own panel. */
  const watch = useCallback(async (kind: NonNullable<RunStatus["kind"]>) => {
    const st = await pollRun();
    if (!st) return;
    if (kind === "backup") await loadBackups();
    say(RUN_SAYS[kind].at)(st.status === "done" ? RUN_SAYS[kind].done(st) : `Error: ${st.error}`);
  }, [pollRun, loadBackups, say]);

  useEffect(() => {
    api<{ supported: boolean; groups: PortGroup[] }>("/data/options")
      .then((o) => {
        setOptions(o);
        // A run still going (started here before the screen was left, or by someone else) is
        // followed to its end like one started now. Read once, it froze where it was found, with
        // every button held, until the page was reloaded.
        void refreshStatus().then((st) => {
          const kind = st.status === "running" ? st.kind : undefined;
          if (kind) void watch(kind).catch((e) => say(RUN_SAYS[kind].at)("Error: " + (e as Error).message));
        });
        if (o.supported) void loadBackups();
      })
      .catch((e) => setOptionsError((e as Error).message));
  }, [refreshStatus, loadBackups, watch, say]);

  /** Selecting a group drags its dependencies in with it — an archive of VIPs without the
   *  players and servers they point at would import as a page of refusals. Deselecting never
   *  cascades: the extra groups may have been wanted on their own. */
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      const byId = new Map((options?.groups ?? []).map((g) => [g.id, g]));
      const queue = [id];
      while (queue.length) {
        for (const need of byId.get(queue.pop()!)?.needs ?? []) {
          if (!next.has(need)) { next.add(need); queue.push(need); }
        }
      }
    }
    return next;
  });

  const checkSizes = useCallback(async () => {
    if (!options) return;
    const setMsg = say("export");
    setBusy(true); setMsg("");
    try {
      const r = await api<{ counts: Record<string, number> }>("/data/counts", {
        method: "POST", body: { groups: options.groups.map((g) => g.id) }, timeoutMs: 0,
      });
      setCounts(r.counts);
    } catch (e) { setMsg("Error: " + (e as Error).message); } finally { setBusy(false); }
  }, [options, say]);

  async function runBackup() {
    const setMsg = say("full");
    setBusy(true); setMsg("");
    try {
      await api("/data/backup", { method: "POST" });
      await watch("backup");
    } catch (e) { setMsg((wasFiled(e) ? "" : "Error: ") + (e as Error).message); } finally { setBusy(false); }
  }

  async function downloadBackup(name: string) {
    const setMsg = say("full");
    setBusy(true); setMsg("");
    try {
      const res = await fetch(`/api/data/backups/${name}`, { headers: authHeaders() });
      if (!res.ok) throw await refusal(res);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg("Error: " + (e as Error).message); } finally { setBusy(false); }
  }

  async function deleteBackup(name: string) {
    const setMsg = say("full");
    if (!(await confirm({
      title: `Delete ${name}?`,
      body: "The file is removed from the backups folder on the host. Anything not copied elsewhere is gone.",
      confirmLabel: "Delete", danger: true,
    }))) return;
    setBusy(true); setMsg("");
    try { await api(`/data/backups/${name}`, { method: "DELETE" }); await loadBackups(); }
    catch (e) { setMsg((wasFiled(e) ? "" : "Error: ") + (e as Error).message); } finally { setBusy(false); }
  }

  async function runRestore(name: string) {
    const setMsg = say("full");
    if (!(await confirm({
      title: "Restore this backup — replacing EVERYTHING?",
      body: "Every saved record on this install is replaced by the archive: players, history, settings, staff accounts, roles, the economy — all of it, exactly as it was when the backup was made. Anything changed since then is gone. You may be signed out; sign back in with the credentials from the backup.",
      confirmLabel: "Replace everything with this backup", danger: true,
    }))) return;
    setBusy(true); setMsg("");
    try {
      await api("/data/restore", { method: "POST", body: { file: name } });
      await watch("restore");
    } catch (e) { setMsg("Error: " + (e as Error).message); } finally { setBusy(false); }
  }

  async function runExport() {
    const setMsg = say("export");
    if (selected.size === 0) return;
    setBusy(true); setMsg("");
    try {
      await api("/data/export", { method: "POST", body: { groups: [...selected] } });
      await watch("export");
    } catch (e) { setMsg((wasFiled(e) ? "" : "Error: ") + (e as Error).message); } finally { setBusy(false); }
  }

  // The archive is behind the same login as everything else, so the download carries the bearer
  // token via fetch and hands the browser a blob.
  async function download() {
    const setMsg = say("export");
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/data/download", { headers: authHeaders() });
      if (!res.ok) throw await refusal(res);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = `data-export-${new Date().toISOString().slice(0, 10)}.ndjson.gz`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setMsg("Error: " + (e as Error).message); } finally { setBusy(false); }
  }

  async function uploadArchive(file: File) {
    const setMsg = say("import");
    setBusy(true); setMsg("");
    try {
      const res = await fetch("/api/data/upload", { method: "POST", headers: authHeaders(), body: file });
      if (!res.ok) throw await refusal(res);
      await refreshStatus();
      setMsg("Archive uploaded. Review, then import.");
    } catch (e) { setMsg("Error: " + (e as Error).message); } finally { setBusy(false); }
  }

  async function runImport() {
    const setMsg = say("import");
    if (!(await confirm({
      title: "Import the uploaded archive into this database?",
      body: "Rows that already exist here are kept, never overwritten. New rows are added with their original ids. This cannot be undone from the panel.",
      confirmLabel: "Import", danger: true,
    }))) return;
    setBusy(true); setMsg("");
    try {
      await api("/data/import", { method: "POST" });
      await watch("import");
    } catch (e) { setMsg("Error: " + (e as Error).message); } finally { setBusy(false); }
  }

  const row = (g: PortGroup) => (
    <div className={`setting-switch trim-row${selected.has(g.id) ? " on" : ""}`} key={g.id}>
      <div className="setting-switch-head">
        <Toggle checked={selected.has(g.id)} onChange={() => toggle(g.id)} label={g.label} />
        {counts && (
          <span className={`badge ${counts[g.id] ? "" : "observe"}`} title="rows this group holds right now">
            {(counts[g.id] ?? 0).toLocaleString()}
          </span>
        )}
      </div>
      <p className="hint">{g.hint}{g.needs?.length ? ` — brings ${g.needs.join(", ")}` : ""}</p>
    </div>
  );

  const report = run.status === "done" && (run.kind === "import" || run.kind === "restore") ? run.report : undefined;

  return (
    <PanelGroup viewId="backup">
      <Panel id="backup-full" caps="open" title="Full backup">
        <Explanation>
          One press, everything: every setting, every staff account and preference, every player,
          the whole history — the CRCON-imported records included, since they live in the same
          tables as everything else. The file lands in the <code>backups</code> folder on the host
          machine and is listed here; restoring one on a fresh install brings back every single
          thing as it was, no re-import needed.
        </Explanation>
        <p className="hint notice">A backup carries server RCON credentials — treat the file like a password file.</p>
        {options && !options.supported && (
          <p className="muted">This install is not running on Postgres, so there is nothing to back up.</p>
        )}
        {options?.supported && (
          <>
            <div className="actions">
              <button className="primary" onClick={runBackup} disabled={busy || run.status === "running"}>Create full backup now</button>
              {run.status === "running" && (run.kind === "backup" || run.kind === "restore") && (
                <span className="muted">{run.kind === "backup" ? "Backing up" : "Restoring"}… {(run.rows ?? 0).toLocaleString()} row(s)</span>
              )}
            </div>
            {!sched && schedErr && <p className="muted">Couldn&apos;t read the nightly backup schedule: {schedErr}</p>}
            {sched && (
              <div className="card" style={{ padding: 12, margin: "10px 0" }}>
                <div className="control-row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>Nightly automatic backup</strong>
                  <Toggle checked={sched.autoBackupEnabled} onChange={(v) => void saveSched({ autoBackupEnabled: v })} label={sched.autoBackupEnabled ? "On" : "Off"} />
                  <label className="inline">at
                    <select value={sched.autoBackupHour} onChange={(e) => void saveSched({ autoBackupHour: Number(e.target.value) })} disabled={!sched.autoBackupEnabled}>
                      {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                    </select>
                  </label>
                  <span className="muted">({sched.timezone})</span>
                  <label className="inline">keep
                    <input type="number" min={1} max={60} style={{ width: 64 }} value={sched.autoBackupKeep}
                      onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 60) void saveSched({ autoBackupKeep: n }); }}
                      disabled={!sched.autoBackupEnabled} />
                  </label>
                  <span className="muted">archives</span>
                </div>
                <Explanation>
                  The worker writes <code>auto-backup-…</code> into the same folder, once per day at
                  that hour on the community&apos;s clock, and rotates its own old ones past the keep
                  count. Backups you make with the button are never rotated out — those were made on
                  purpose. If a nightly run fails, it says so on Moderation and retries the next
                  sweep; a copy of any archive still only protects you once it lives off this machine.
                </Explanation>
              </div>
            )}
            {backups && backups.length > 0 && (
              <div className="scroll-x">
                <table>
                  <thead><tr><th>Backup</th><th>Created</th><th>Size</th><th></th></tr></thead>
                  <tbody>
                    {(backupPages.items ?? []).map((b) => (
                      <tr key={b.name}>
                        <td><code>{b.name}</code></td>
                        <td>{fmt(b.createdAt)}</td>
                        <td>{mb(b.bytes)}</td>
                        <td>
                          <span className="actions mt-0">
                            <button className="ghost mini" onClick={() => void downloadBackup(b.name)} disabled={busy}>Download</button>
                            <button className="ghost mini" onClick={() => void runRestore(b.name)} disabled={busy || run.status === "running"}>Restore</button>
                            <button className="ghost mini danger" onClick={() => void deleteBackup(b.name)} disabled={busy}>Delete</button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {backups && backups.length > 0 && <Pager list={backupPages} noun="backup" />}
            {backupsErr && <p className="muted">Couldn&apos;t list the backups: {backupsErr}</p>}
            {backups && backups.length === 0 && <p className="hint">No backups yet — the button above makes the first one.</p>}
            <p className="hint notice">
              Restore replaces everything on this install with the archive — the way back to exactly
              where you were. A backup only protects you if a copy lives somewhere other than this
              machine: download it, or copy it out of the <code>backups</code> folder.
            </p>
          </>
        )}
        {msg.at === "full" && msg.text && <p className="muted">{msg.text}</p>}
      </Panel>

      <Panel id="backup-export" caps="open" title="Export">
        <Explanation>
          Pick what to keep and export it as one archive — settings, players, history, everything is
          its own switch. Ids are preserved, so a fresh install imports it and every reference still
          holds.
        </Explanation>
        <p className="hint notice">The archive includes server RCON credentials when connections are selected: treat the file like a password file.</p>
        {optionsError && <p className="muted">Could not load the catalog: {optionsError}</p>}
        {options && !options.supported && (
          <p className="muted">This install is not running on Postgres, so there is no database to export or import.</p>
        )}
        {options && options.supported && (
          <>
            <div className="actions">
              <button className="ghost" onClick={() => setSelected(new Set(options.groups.map((g) => g.id)))}>Select everything</button>
              <button className="ghost" onClick={() => setSelected(new Set())}>Clear</button>
              <button className="ghost" onClick={checkSizes} disabled={busy}>Check sizes</button>
            </div>
            {options.groups.map(row)}
            <div className="actions">
              <button className="primary" onClick={runExport} disabled={busy || selected.size === 0 || run.status === "running"}>
                Export {selected.size ? `${selected.size} group(s)` : ""}
              </button>
              {/* Only this panel's own kinds: a running BACKUP or RESTORE reports in the Full
                  backup panel above, and calling it "Importing" here reads as a wrong answer. */}
              {run.status === "running" && (run.kind === "export" || run.kind === "import") && (
                <span className="muted">{run.kind === "export" ? "Exporting" : "Importing"}… {(run.rows ?? 0).toLocaleString()} row(s)</span>
              )}
              {run.status === "done" && run.kind === "export" && run.file && (
                <button className="ghost" onClick={download} disabled={busy}>Download archive ({Math.max(1, Math.round((run.fileBytes ?? 0) / 1024)).toLocaleString()} KB)</button>
              )}
            </div>
          </>
        )}
        {msg.at === "export" && msg.text && <p className="muted">{msg.text}</p>}
      </Panel>

      {options?.supported && (
        <Panel id="backup-import" caps="open" title="Import">
          <Explanation>
            Upload an archive exported from this panel (on this install or another one), then import
            it. Existing rows always win — importing is additive and safe to repeat. Rows whose
            parents are missing are reported, not silently dropped.
          </Explanation>
          <div className="actions">
            <input ref={fileRef} type="file" aria-label="Archive file" accept=".gz,.ndjson.gz,application/gzip" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadArchive(f); e.target.value = ""; }} />
            <button onClick={runImport} disabled={busy || !upload || run.status === "running"}>
              Import{upload ? ` (${Math.max(1, Math.round(upload.bytes / 1024)).toLocaleString()} KB uploaded)` : ""}
            </button>
          </div>
          {msg.at === "import" && msg.text && <p className="muted">{msg.text}</p>}
          {report && (
            <div className="scroll-x">
              <table>
                <thead><tr><th>Table</th><th>In archive</th><th>Added</th><th>Already here</th><th>Refused</th></tr></thead>
                <tbody>
                  {Object.entries(report).map(([table, r]) => (
                    <tr key={table}>
                      <td>{table}</td>
                      <td>{r.read.toLocaleString()}</td>
                      <td>{r.inserted.toLocaleString()}</td>
                      <td>{r.skipped.toLocaleString()}</td>
                      <td className={r.failed ? "" : "muted"}>{r.failed.toLocaleString()}{r.error ? ` — ${r.error}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </PanelGroup>
  );
}
