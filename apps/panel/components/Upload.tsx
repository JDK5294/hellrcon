"use client";
/**
 * "Upload": a list downloaded from this page — or a copy edited in Excel or Google Sheets — put
 * back. Nothing changes until the preview has been seen: the popup reads the file, shows what every
 * line would do (lib/uploadPlans), and applies only the lines that add or lengthen something,
 * saying how far it has got. A line the server turns down is listed with its reason.
 */
import { useState, type ReactNode } from "react";
import { ActionResult, Modal } from "./ui";
import { readTable, type Table } from "../lib/upload";
import type { Plan, PlanAction, PlanRow } from "../lib/uploadPlans";

/** What became of one line that was applied. */
export interface UploadResult { line: number; who: string; ok: boolean; detail: string }

const ACTION_WORD: Record<PlanAction, string> = { add: "new", extend: "longer", keep: "no change", skip: "skipped" };
const ACTION_BADGE: Record<PlanAction, string> = { add: "ok", extend: "active", keep: "", skip: "warn-badge" };
/** The most lines the preview draws; a long list is summed up above it in full. */
const SHOWN = 300;

export function UploadButton<T>({ title, intro, plan, fields, blocked, apply, onDone }: {
  /** The popup's heading: "Upload a VIP list". */
  title: string;
  /** One sentence: where the lines go, and the rule they follow. */
  intro: string;
  /** What each line would do, against the list as it stands: read when the file is picked, never
   *  what the screen holds, which may still be loading or narrowed by a search. */
  plan: (table: Table) => Plan<T> | Promise<Plan<T>>;
  /** Anything the lines need from the person: a note, a reason, the servers. */
  fields?: ReactNode;
  /** Why Apply cannot be pressed yet, given the lines it would send ("" when it can). */
  blocked?: (rows: PlanRow<T>[]) => string;
  /** Send the lines; report each, and how many are done so far. */
  apply: (rows: PlanRow<T>[], progress: (done: number) => void) => Promise<UploadResult[]>;
  /** Once applied: read the list again. */
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState("");
  const [planned, setPlanned] = useState<Plan<T> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<UploadResult[] | null>(null);

  const reset = () => { setFile(""); setPlanned(null); setError(""); setDone(0); setResults(null); };
  const changes = (planned?.rows ?? []).filter((r) => r.action === "add" || r.action === "extend");
  const why = planned && changes.length ? blocked?.(changes) ?? "" : "";

  async function pick(f: File | undefined) {
    if (!f) return;
    reset();
    setFile(f.name);
    try {
      const p = await plan(await readTable(new Uint8Array(await f.arrayBuffer())));
      if (p.missing) setError(`The file has no "${p.missing}" column — upload a list downloaded from this page.`);
      else setPlanned(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run() {
    setBusy(true);
    setError("");
    try {
      setResults(await apply(changes, setDone));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const counts = (planned?.rows ?? []).reduce<Record<PlanAction, number>>((c, r) => ({ ...c, [r.action]: c[r.action] + 1 }), { add: 0, extend: 0, keep: 0, skip: 0 });
  const summary = ([["add", "new"], ["extend", "made longer"], ["keep", "no change"], ["skip", "skipped"]] as const)
    .filter(([k]) => counts[k]).map(([k, word]) => `${counts[k]} ${word}`).join(" · ");
  const failed = (results ?? []).filter((r) => !r.ok);

  return (
    <>
      <button type="button" className="mini ghost" onClick={() => { reset(); setOpen(true); }}>Upload</button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)} busy={busy} className="confirm-modal">
          <p className="muted fs-sm" style={{ marginTop: 0 }}>{intro}</p>
          {!results && (
            <div className="pa-fields">
              <label>A list downloaded from this page — Excel, CSV or JSON
                <input type="file" accept=".xlsx,.csv,.json,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
              </label>
            </div>
          )}
          <ActionResult error={error} />
          {planned && !results && (
            <>
              <p className="fs-sm"><strong>{file}</strong>: {summary || "nothing in it"}.</p>
              <div className="upload-plan">
                {planned.rows.slice(0, SHOWN).map((r) => (
                  <div key={r.line} className={`upload-line ${r.action}`}>
                    <span className={`badge ${ACTION_BADGE[r.action]}`}>{ACTION_WORD[r.action]}</span> <strong>{r.who}</strong> <span className="muted">— {r.detail}</span>
                  </div>
                ))}
                {planned.rows.length > SHOWN && <p className="muted fs-sm">…and {planned.rows.length - SHOWN} more lines.</p>}
              </div>
              {changes.length > 0 && fields && <div className="pa-fields" style={{ marginTop: 10 }}>{fields}</div>}
              {why && <p className="hint">{why}</p>}
            </>
          )}
          {busy && <p className="muted fs-sm">Working… {done} of {changes.length}</p>}
          {results && (
            <>
              <p className="fs-sm"><strong>Done:</strong> {results.length - failed.length} of {results.length} applied.</p>
              {failed.length > 0 && (
                <div className="upload-plan">
                  {failed.map((r) => <div key={r.line} className="upload-line skip"><strong>{r.who}</strong> <span className="muted">— {r.detail}</span></div>)}
                </div>
              )}
            </>
          )}
          <div className="pa-actions">
            <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={busy}>{results ? "Close" : "Cancel"}</button>
            {!results && (
              <button type="button" onClick={() => void run()} disabled={busy || !changes.length || Boolean(why)}>
                {changes.length ? `Apply ${changes.length} change${changes.length === 1 ? "" : "s"}` : "Nothing to apply"}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
