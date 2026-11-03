"use client";
/**
 * A row of click-to-fill preset chips for a given template kind ("reason" | "message" | "broadcast").
 * Loads the editable library (GET /templates?kind); clicking a chip fills the field via onPick — the
 * field stays free-text, so staff can type OR pick.
 *
 * With `canManage`, the row also grows an inline add/remove: presets are only useful if the people
 * who send the same thing every night can save it the moment they type it, and making them cross the
 * app to Administration → Templates to do that is how a preset library stays empty. The full library
 * screen still exists — it edits every kind at once and reorders them; this is the fast path for the
 * kind you are already looking at.
 *
 * Managing is `templates.manage` write, the same grant the library screen needs, because it is the
 * same shared wording every colleague will see. Without it the row is exactly what it always was.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

interface Tmpl { id: string; kind: string; title: string; body: string }

export function TemplatePicker({ kind, onPick, label = "Presets — click to fill:", canManage = false, addFrom }: {
  kind: string;
  onPick: (body: string) => void;
  label?: string;
  /** Show the inline add/remove controls. Gate on templates.manage write. */
  canManage?: boolean;
  /** Current field text, offered as the body of a new preset ("save what I just typed"). */
  addFrom?: string;
}) {
  // Null until read. "No presets saved yet" was offered to a manager while they were on their way.
  const [items, setItems] = useState<Tmpl[] | null>(null);
  // A failed read is said as that. It used to leave the row empty, which offered a manager "No
  // presets saved yet" and hid the row from everyone else — both of which read as "there are none".
  const [readErr, setReadErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    let live = true;
    api<{ templates: Tmpl[] }>(`/templates?kind=${encodeURIComponent(kind)}`)
      .then((r) => { if (live) { setItems(r.templates ?? []); setReadErr(""); } })
      .catch((e) => { if (live) { setItems([]); setReadErr((e as Error).message); } });
    return () => { live = false; };
  }, [kind]);
  useEffect(() => load(), [load]);

  const body = (addFrom ?? "").trim();

  async function save() {
    if (!body) return;
    setBusy(true); setErr("");
    try {
      // Untitled is legal — the chip falls back to the body text, which is often the better label
      // for a one-liner anyway.
      await api("/templates", { method: "POST", body: { kind, title: title.trim(), body } });
      setTitle(""); setAdding(false); load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function remove(t: Tmpl) {
    setBusy(true); setErr("");
    try { await api(`/templates/${t.id}`, { method: "DELETE" }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // Not read yet, or nothing saved and nothing to offer saving: stay out of the way entirely.
  if (items === null && !readErr) return null;
  const list = items ?? [];
  if (!list.length && !canManage && !readErr) return null;

  return (
    <div className="preset-picker" style={{ marginTop: 6 }}>
      {/* With managing switched on the row appears before anything has been saved, and "click to
          fill" then names chips that are not there. Say what is actually on offer. */}
      <span className="hint">{readErr ? `Couldn't read the presets: ${readErr}` : list.length ? label : "No presets saved yet — type a message and save it as one."}</span>
      <div className="chips">
        {list.map((t) => (
          <span key={t.id} className={canManage ? "chip-pair" : undefined}>
            <button type="button" className="badge chip-btn" title={t.body} onClick={() => onPick(t.body)}>
              {t.title || (t.body.length > 40 ? t.body.slice(0, 38) + "…" : t.body)}
            </button>
            {canManage && (
              <button type="button" className="ghost mini" disabled={busy}
                title={`Remove the preset "${t.title || t.body.slice(0, 40)}" for everyone`}
                aria-label={`Remove preset ${t.title || t.body.slice(0, 40)}`}
                onClick={() => remove(t)}>✕</button>
            )}
          </span>
        ))}
        {canManage && !adding && (
          // Disabled with an empty field, and the title says why — a preset is the text you are
          // saving, so there is nothing to save before you have typed it.
          <button type="button" className="badge chip-btn" disabled={!body}
            title={body ? "Save what you typed as a preset" : "Type a message first, then save it as a preset"}
            onClick={() => setAdding(true)}>+ Save as preset</button>
        )}
      </div>
      {canManage && adding && (
        <div className="control-row" style={{ marginTop: 6, flexWrap: "nowrap" }}>
          <input value={title} maxLength={80} placeholder="Name it (optional)…" className="grow-min" data-no-placeholders
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") { setAdding(false); setTitle(""); } }} />
          <button className="primary" disabled={busy || !body} onClick={save}>{busy ? "Saving…" : "Save preset"}</button>
          <button className="ghost" disabled={busy} onClick={() => { setAdding(false); setTitle(""); setErr(""); }}>Cancel</button>
        </div>
      )}
      {err && <p className="hint" role="alert">{err}</p>}
    </div>
  );
}
