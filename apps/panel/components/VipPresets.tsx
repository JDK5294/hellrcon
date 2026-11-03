"use client";
/**
 * VIP preset editor — the community-editable duration buttons on the Edit VIP popup. Two lists,
 * one per tab of that popup (Add VIP / Pause VIP). Each preset is a labelled amount of time; on
 * the popup the buttons act as a calculator, every click ADDING the preset's time to the running
 * total, so "1 day" tapped twice is 2 days. Editing needs the VIP presets permission; the popup
 * itself only reads them.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useConfirm } from "../lib/feedback";
import { ActionResult, AskNotice, Divider, EmptyState, SkeletonLines, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";

interface Preset { id: string; kind: "add" | "pause"; label: string; days: number; hours: number; sortOrder: number }
const KIND_LABEL: Record<Preset["kind"], string> = { add: "Add VIP tab", pause: "Pause VIP tab" };
const KIND_HELP: Record<Preset["kind"], string> = {
  add: "Buttons offered when granting VIP — e.g. “Help skip queue”, “1 week”.",
  pause: "Buttons offered when pausing VIP (the VIP timeout).",
};
const KINDS: Preset["kind"][] = ["add", "pause"];

export default function VipPresets({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [items, setItems] = useState<Preset[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { label: string; days: string; hours: string }>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    setErr("");
    api<{ presets: Preset[] }>("/vip-presets").then((r) => setItems(r.presets)).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const draft = (kind: string) => drafts[kind] ?? { label: "", days: "0", hours: "0" };
  const setDraft = (kind: string, patch: Partial<{ label: string; days: string; hours: string }>) =>
    setDrafts((d) => ({ ...d, [kind]: { ...draft(kind), ...patch } }));

  async function add(kind: Preset["kind"]) {
    const d = draft(kind);
    if (!d.label.trim()) return;
    setBusy(`add-${kind}`); setErr("");
    try {
      await api("/vip-presets", { method: "POST", body: { kind, label: d.label.trim(), days: Number(d.days) || 0, hours: Number(d.hours) || 0, sortOrder: (items ?? []).filter((p) => p.kind === kind).length } });
      setDrafts((ds) => ({ ...ds, [kind]: { label: "", days: "0", hours: "0" } }));
      load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  async function save(p: Preset, patch: { label?: string; days?: number; hours?: number }) {
    setBusy(p.id); setErr("");
    try { await api(`/vip-presets/${p.id}`, { method: "PATCH", body: patch }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }
  async function remove(p: Preset) {
    if (!(await confirm({ title: `Delete the “${p.label}” preset?`, confirmLabel: "Delete", danger: true }))) return;
    setBusy(p.id); setErr("");
    try { await api(`/vip-presets/${p.id}`, { method: "DELETE" }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  return (
    <PanelGroup viewId="vippresets">
      <Panel
        id="vippresets"
        caps="open"
        title="VIP presets"
        actions={<button className="ghost mini" onClick={load}>Refresh</button>}
      >
      <Explanation>
        The duration buttons on the Edit VIP popup. They act as a calculator — each tap adds the
        button&apos;s time onto the total (tap “1 day” twice for 2 days), so keep them as building blocks.
      </Explanation>
      <ActionResult error={err} />
      {canManage ? <AskNotice capability="vip.presets" /> : <p className="hint">You need the VIP presets permission to edit these.</p>}
      {!items && !err && <SkeletonLines lines={4} />}

      {items && KINDS.map((kind) => {
        const rows = items.filter((p) => p.kind === kind);
        const d = draft(kind);
        return (
          <div key={kind}>
            <Divider label={`${KIND_LABEL[kind]} (${rows.length})`} />
            <p className="hint">{KIND_HELP[kind]}</p>
            <div style={{ display: "grid", gap: 6 }}>
              {rows.length === 0 && (
                <EmptyState icon="★" title={`No ${KIND_LABEL[kind].toLowerCase()} presets yet`}>
                  Without presets the popup still works — staff just type days and hours by hand.
                </EmptyState>
              )}
              {rows.map((p) => (
                <div key={p.id} className="control-row preset-row">
                  <input defaultValue={p.label} disabled={!canManage || busy === p.id} className="grow-min" aria-label="Label"
                    onBlur={(e) => canManage && e.target.value.trim() && e.target.value.trim() !== p.label && save(p, { label: e.target.value.trim() })}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                  <input type="number" min="0" defaultValue={String(p.days)} disabled={!canManage || busy === p.id} style={{ width: 74 }} aria-label="Days" title="Days"
                    onBlur={(e) => canManage && Number(e.target.value) !== p.days && save(p, { days: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                  <span className="muted">d</span>
                  <input type="number" min="0" defaultValue={String(p.hours)} disabled={!canManage || busy === p.id} style={{ width: 74 }} aria-label="Hours" title="Hours"
                    onBlur={(e) => canManage && Number(e.target.value) !== p.hours && save(p, { hours: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                  <span className="muted">h</span>
                  {canManage && <button className="ghost mini danger" disabled={busy === p.id} title="Delete this duration button" onClick={() => remove(p)}>Delete</button>}
                </div>
              ))}
            </div>
            {canManage && (
              <div className="control-row preset-row" style={{ marginTop: 8 }}>
                <input value={d.label} placeholder="New preset label…" className="grow-min"
                  onChange={(e) => setDraft(kind, { label: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") add(kind); }} />
                <input type="number" min="0" value={d.days} style={{ width: 74 }} aria-label="Days" title="Days" onChange={(e) => setDraft(kind, { days: e.target.value })} />
                <span className="muted">d</span>
                <input type="number" min="0" value={d.hours} style={{ width: 74 }} aria-label="Hours" title="Hours" onChange={(e) => setDraft(kind, { hours: e.target.value })} />
                <span className="muted">h</span>
                <button className="ghost" disabled={!d.label.trim() || busy === `add-${kind}`} onClick={() => add(kind)}>Add</button>
              </div>
            )}
          </div>
        );
      })}
      </Panel>
    </PanelGroup>
  );
}
