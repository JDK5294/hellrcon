"use client";
/**
 * Message & reason templates — the editable library behind every template picker. Grouped by kind
 * (reason / message / broadcast): add, edit inline, and delete. Wherever staff enter a reason or
 * message, these appear as click-to-fill chips (they can still type freely). Managing needs Server
 * config; the pickers themselves only need view access.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useConfirm } from "../lib/feedback";
import { ActionResult, AskNotice, Divider, EmptyState, SkeletonLines, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import Signatures from "./Signatures";

interface Tmpl { id: string; kind: string; title: string; body: string; sortOrder: number }
const KIND_LABEL: Record<string, string> = { reason: "Moderation reasons", message: "In-game messages", broadcast: "Broadcasts" };
const KIND_HELP: Record<string, string> = {
  reason: "Used in the kick / punish / ban reason fields.",
  message: "Used when messaging a player.",
  broadcast: "Used for server broadcasts (send-now and the rotation).",
};

export default function Templates({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [items, setItems] = useState<Tmpl[] | null>(null);
  const [kinds, setKinds] = useState<string[]>(["reason", "message", "broadcast"]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    setErr("");
    api<{ templates: Tmpl[]; kinds: string[] }>("/templates").then((r) => { setItems(r.templates); setKinds(r.kinds ?? kinds); }).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(kind: string) {
    const body = (drafts[kind] ?? "").trim();
    if (!body) return;
    setBusy(`add-${kind}`); setErr("");
    try { await api("/templates", { method: "POST", body: { kind, body } }); setDrafts((d) => ({ ...d, [kind]: "" })); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  async function saveBody(t: Tmpl, body: string) {
    if (body.trim() === t.body) return;
    setBusy(t.id); setErr("");
    try { await api(`/templates/${t.id}`, { method: "PATCH", body: { body: body.trim() } }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  async function remove(t: Tmpl) {
    if (!(await confirm({ title: `Delete this ${t.kind} template?`, confirmLabel: "Delete", danger: true }))) return;
    setBusy(t.id); setErr("");
    try { await api(`/templates/${t.id}`, { method: "DELETE" }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  return (
    <PanelGroup viewId="templates">
      {/* A template is WHAT you say; a signature is who said it and where to go next. Same job,
          same page — split only by how often each changes. */}
      <Signatures canManage={canManage} />
      <Panel
        id="templates"
        caps="open"
        title="Templates"
        actions={<button className="ghost mini" onClick={load}>Refresh</button>}
      >
      <Explanation>Reusable reason &amp; message templates. These fill the pickers wherever staff enter a reason or message — who can still type their own.</Explanation>
      <ActionResult error={err} />
      {canManage ? <AskNotice capability="templates.manage" /> : <p className="hint">You need the &ldquo;Message templates&rdquo; permission to edit these.</p>}
      {!items && !err && <SkeletonLines lines={4} />}

      {items && kinds.map((kind) => {
        const rows = items.filter((t) => t.kind === kind);
        return (
          <div key={kind}>
            <Divider label={`${KIND_LABEL[kind] ?? kind} (${rows.length})`} />
            <p className="hint">{KIND_HELP[kind] ?? ""}</p>
            <div style={{ display: "grid", gap: 6 }}>
              {rows.length === 0 && (
                <EmptyState icon="📝" title={`No ${kind} templates yet`}>
                  Presets are reusable wording your whole team picks from — ban reasons, welcome text,
                  broadcast lines — so everyone words the same thing the same way.
                </EmptyState>
              )}
              {rows.map((t) => (
                <div key={t.id} className="control-row">
                  <input aria-label="Template" defaultValue={t.body} disabled={!canManage || busy === t.id} onBlur={(e) => canManage && saveBody(t, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="grow-min" />
                  {canManage && <button className="ghost mini danger" disabled={busy === t.id} title="Delete this template" onClick={() => remove(t)}>Delete</button>}
                </div>
              ))}
            </div>
            {canManage && (
              <div className="control-row" style={{ marginTop: 8, flexWrap: "nowrap" }}>
                <input value={drafts[kind] ?? ""} placeholder={`Add a ${kind} template…`} onChange={(e) => setDrafts((d) => ({ ...d, [kind]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") add(kind); }} className="grow-min" />
                <button className="ghost" disabled={!(drafts[kind] ?? "").trim() || busy === `add-${kind}`} onClick={() => add(kind)}>Add</button>
              </div>
            )}
          </div>
        );
      })}
      </Panel>
    </PanelGroup>
  );
}
