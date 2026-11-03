"use client";
/**
 * One action from the staff trail, opened from its row: who did it and when, what it was done to,
 * and what it changed — setting by setting, what each was and what it became (GET /api/audit/:id,
 * apps/api audit-changes) — then everything else its record keeps.
 *
 * Opened from Staff activity's Trail and from a staff member's Actions (auditRowProps).
 */
import { Fragment, useEffect, useState } from "react";
import { api } from "../lib/api";
import { fmtExact, humanizeIsoInText } from "../lib/time";
import { useServers } from "../lib/servers";
import { ActionResult, Modal, SkeletonLines } from "./ui";
import { StaffLink } from "./StaffLink";
import { AuditTarget, type AuditEntry } from "./Activity";

/** One setting that moved; a side that is null did not exist then (added, or removed). */
interface AuditChange { where: string[]; before: string | null; after: string | null }
interface AuditDetailAnswer {
  entry: AuditEntry;
  changes: {
    basis: "recorded" | "version" | "previous" | "set";
    items: AuditChange[];
    since?: { ts: string; actorName: string };
    note?: string;
  } | null;
  details: { label: string; value: string }[];
}

/**
 * What a row of the trail needs to open its action: pressed anywhere on it. What the row holds of
 * its own — the action's button, a staff member's name, a player's, a game id to copy, the time —
 * keeps its press to itself (each stops it there): a profile opens, an id is copied, the exact time
 * shows, and the action opens once.
 */
export function auditRowProps(open: () => void) {
  return { className: "audit-row", onClick: open };
}

/** The action's name in its row, as a button that opens it: a keyboard reaches it, as it does a link. */
export function AuditActionButton({ action, onOpen }: { action: string; onOpen: () => void }) {
  return (
    <button type="button" className="audit-action" onClick={(e) => { e.stopPropagation(); onOpen(); }} title="See exactly what this did">
      <code>{action}</code>
    </button>
  );
}

/** A value as people read it: a date and time in their own clock, not as the record keeps it. */
const read = (v: string | null) => (v === null ? "" : humanizeIsoInText(v));

function ChangeLine({ c, setOnly }: { c: AuditChange; setOnly: boolean }) {
  const value = setOnly
    ? read(c.after)
    : c.before === null
      ? <><span className="muted">added: </span>{read(c.after)}</>
      : c.after === null
        ? <><span className="muted">removed: </span>{read(c.before)}</>
        : <>{read(c.before)} <span className="muted" aria-label="changed to">→</span> {read(c.after)}</>;
  return (
    <li>
      {c.where.length > 0 && <span className="audit-where">{c.where.join(" › ")}</span>}
      <span className="audit-values">{value}</span>
    </li>
  );
}

export function AuditDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [answer, setAnswer] = useState<AuditDetailAnswer | null>(null);
  const [error, setError] = useState("");
  const { servers } = useServers();
  useEffect(() => {
    let live = true;
    setAnswer(null);
    setError("");
    api<AuditDetailAnswer>(`/audit/${encodeURIComponent(id)}`)
      .then((a) => { if (live) setAnswer(a); })
      .catch((err) => { if (live) setError((err as Error).message); });
    return () => { live = false; };
  }, [id]);

  const e = answer?.entry;
  const changes = answer?.changes ?? null;
  const details = answer?.details ?? [];
  // The server it was done on, unless the server is what it was done to: said once, under To.
  const server = e?.serverId && !(e.targetType === "server" && e.targetId === e.serverId)
    ? servers.find((s) => s.id === e.serverId)?.name ?? null : null;
  return (
    <Modal title="Action details" onClose={onClose} className="audit-detail-modal">
      {error && <ActionResult error={error} />}
      {!answer && !error && <SkeletonLines lines={4} />}
      {answer && !e && <p className="muted">Nothing was recorded for this action.</p>}
      {e && (
        <>
          <p className="mod-summary">{humanizeIsoInText(e.summary)}</p>
          <dl className="mod-facts">
            <dt>When</dt><dd>{fmtExact(e.ts)}</dd>
            <dt>Who</dt><dd><StaffLink userId={e.actorUserId} name={e.actorDisplayName || e.actorName} /></dd>
            {(e.targetName || e.targetId) && <><dt>To</dt><dd><AuditTarget entry={e} /></dd></>}
            {server && <><dt>Server</dt><dd>{server}</dd></>}
            <dt>Action</dt><dd><code>{e.action}</code></dd>
          </dl>
          {changes && (
            <section className="audit-part">
              <h4>{changes.basis === "set" ? "What it set" : "What changed"}</h4>
              {changes.basis === "previous" && changes.since && (
                <p className="muted fs-sm">Compared with the save before it, on {fmtExact(changes.since.ts)} by {changes.since.actorName}.</p>
              )}
              {changes.basis === "version" && <p className="muted fs-sm">From the record&apos;s saved versions.</p>}
              {changes.note && <p className="muted fs-sm">{changes.note}</p>}
              {changes.items?.length
                ? <ul className="audit-changes">{changes.items.map((c, i) => <ChangeLine key={i} c={c} setOnly={changes.basis === "set"} />)}</ul>
                : <p className="muted">Saved with nothing changed.</p>}
            </section>
          )}
          {details.length > 0 && (
            <section className="audit-part">
              <h4>Details</h4>
              <dl className="mod-facts">
                {details.map((d) => <Fragment key={d.label}><dt>{d.label}</dt><dd>{read(d.value)}</dd></Fragment>)}
              </dl>
            </section>
          )}
        </>
      )}
      <div className="pa-actions">
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
