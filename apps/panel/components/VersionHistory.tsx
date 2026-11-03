"use client";
/**
 * Version history: one record's saved changes, newest first — who, when, what each save changed —
 * with a way back from any of them. And the deleted records of a kind, each one Restore away.
 *
 * Shared by the Rules page and the map vote library: the screen says where the history lives, how
 * its fields read, and where a restore goes. Restoring puts the record back as it was BEFORE the
 * chosen save, and is itself a save — so a restore can be undone the same way.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useConfirm, useToast } from "../lib/feedback";
import { diffSnapshots, type DiffOptions } from "../lib/versionDiff";
import { Time } from "./Time";
import { ActionResult, SkeletonLines } from "./ui";

export interface VersionRow {
  id: string;
  change: "edit" | "delete" | "restore";
  targetId: string;
  targetName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorName: string | null;
  createdAt: string;
}

const VERB: Record<VersionRow["change"], string> = { edit: "changed it", restore: "put back an earlier version", delete: "deleted it" };

function useRows<T>(url: string, key: "versions" | "deleted", reload: number): { rows: T[] | null; err: string } {
  const [rows, setRows] = useState<T[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setRows(null); setErr("");
    api<Record<string, T[]>>(url)
      .then((r) => { if (alive) setRows(r[key] ?? []); })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [url, key, reload]);
  return { rows, err };
}

/** A record's saved changes, newest first. `noun` reads in the questions ("rule", "map set"). */
export function VersionHistory({ listUrl, restoreUrl, canRestore, diff, onRestored, noun }: {
  listUrl: string; restoreUrl: (versionId: string) => string; canRestore: boolean; diff: DiffOptions;
  /** Called with the restore's answer — the record as it now stands. */
  onRestored: (restored: Record<string, unknown>) => void; noun: string;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const { rows, err } = useRows<VersionRow>(listUrl, "versions", reload);
  async function restore(v: VersionRow) {
    const ok = await confirm({
      title: `Put this ${noun} back as it was before this change?`,
      body: `It goes back to how it stood before ${v.actorName || "someone"}'s change — anything saved after that is undone too. The restore is kept here like any other save, so it can be undone the same way.`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    setBusy(v.id);
    try {
      const restored = await api<Record<string, unknown>>(restoreUrl(v.id), { method: "POST" });
      toast.success("Restored the earlier version");
      setReload((n) => n + 1);
      onRestored(restored);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  if (err) return <ActionResult error={err} />;
  if (!rows) return <SkeletonLines lines={2} />;
  if (!rows.length) return <p className="muted m-0">No saved changes yet. From now on every save is kept here, and any of them can be undone.</p>;
  return (
    <ol className="version-list">
      {rows.map((v) => {
        // A save has a before and an after; bringing a deleted record back has no before, and
        // deleting one no after — those read as what happened, not as every field appearing.
        const lines = v.before && v.after ? diffSnapshots(v.before, v.after, diff) : [];
        return (
          <li key={v.id} className="version-row">
            <div><strong>{v.actorName || "Someone"}</strong> {v.before ? VERB[v.change] : "brought it back after it was deleted"} · <Time iso={v.createdAt} /></div>
            {v.before && v.after && (lines.length
              ? <ul className="version-diff">{lines.map((l) => <li key={l.path}><span className="muted">{l.label}:</span> {l.text}</li>)}</ul>
              : <p className="muted m-0">No change to its settings.</p>)}
            {canRestore && v.before && (
              <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => restore(v)}>
                {busy === v.id ? "Restoring…" : "Restore the version before this"}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The deleted records of one kind, newest first, each one Restore away. */
export function RecentlyDeleted({ listUrl, restoreUrl, canRestore, onRestored, noun }: {
  listUrl: string; restoreUrl: (versionId: string) => string; canRestore: boolean; onRestored: (restored: Record<string, unknown>) => void; noun: string;
}) {
  const toast = useToast();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const { rows, err } = useRows<VersionRow>(listUrl, "deleted", reload);
  async function restore(v: VersionRow) {
    setBusy(v.id);
    try {
      const restored = await api<Record<string, unknown>>(restoreUrl(v.id), { method: "POST" });
      toast.success(`Brought back "${v.targetName ?? noun}"`);
      setReload((n) => n + 1);
      onRestored(restored);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  if (err) return <ActionResult error={err} />;
  if (!rows) return <SkeletonLines lines={2} />;
  if (!rows.length) return <p className="muted m-0">Nothing deleted lately.</p>;
  return (
    <ul className="version-list">
      {rows.map((v) => (
        <li key={v.id} className="version-row">
          <strong>{v.targetName ?? `a ${noun}`}</strong> — deleted by {v.actorName || "someone"} · <Time iso={v.createdAt} />{" "}
          {canRestore && (
            <button type="button" className="ghost mini" disabled={busy !== null} onClick={() => restore(v)}>
              {busy === v.id ? "Restoring…" : "Restore"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
