"use client";
import { useState } from "react";
import { api, wasFiled } from "../lib/api";

export interface WidgetSize { w: number; h: number }
export interface Widget { id: string; title: string; visible: boolean; order: number; required?: boolean; view?: WidgetView; pluginId?: string; size?: WidgetSize }

/** Declarative widget UI (mirrors @app/widgets). No plugin code runs in the browser —
 *  the renderer maps these known block types to React. */
export type DataSource =
  | { kind: "static"; value: unknown }
  | { kind: "plugin"; key: string; refreshMs?: number }
  | { kind: "api"; path: string; pick?: string; refreshMs?: number };
/** How a value is written for a person — formatted with the same helpers the analytics pages use,
 *  so a widget's numbers are spelled the way the rest of the panel spells them. */
export type ValueFormat = "number" | "decimal" | "percent" | "duration" | "time" | "text";
export interface WidgetColumn { key: string; label: string; link?: "player"; format?: ValueFormat }
export interface WidgetTile { label: string; key: string; unit?: string; sub?: string; accent?: boolean; format?: ValueFormat }
export interface WidgetSeries { labelKey?: string; valueKey?: string; format?: ValueFormat; emptyText?: string }
export type WidgetBlock =
  | { type: "markdown"; text: string }
  | { type: "note"; text: string; variant?: "info" | "warn" | "danger" }
  | { type: "stat"; label: string; source: DataSource; unit?: string; sub?: string; accent?: boolean; format?: ValueFormat }
  | { type: "stats"; source: DataSource; tiles: WidgetTile[] }
  | { type: "table"; columns: WidgetColumn[]; source: DataSource; emptyText?: string; max?: number }
  | ({ type: "bars"; source: DataSource; colorIndex?: number } & WidgetSeries)
  | ({ type: "split"; source: DataSource } & WidgetSeries)
  | { type: "feed"; kinds: string[]; emptyText?: string; max?: number };
export interface WidgetView { blocks: WidgetBlock[] }

/**
 * Toggle visibility and reorder the nav widgets, then save for yourself or the whole instance.
 *
 * Saving for yourself needs no permission — it is your own layout. Saving the INSTANCE default
 * rewrites what every colleague sees, and the API guards it on `layout.edit`; the button was shown
 * to everyone regardless, so most of the team met that grant as an error message.
 */
export default function LayoutEditor({ widgets, onClose, onSaved, canSaveInstance = false }: { widgets: Widget[]; onClose: () => void; onSaved: () => void; canSaveInstance?: boolean }) {
  const [items, setItems] = useState<Widget[]>(widgets.map((w) => ({ ...w })));
  const [status, setStatus] = useState("");

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
  };
  const setVisible = (i: number, v: boolean) => {
    const next = items.slice();
    next[i] = { ...next[i], visible: v };
    setItems(next);
  };

  async function save(scope: "user" | "instance") {
    const config = { items: items.map((w, idx) => ({ widgetId: w.id, visible: w.required ? true : w.visible, order: idx * 10 })) };
    setStatus("Saving…");
    try {
      await api("/layout/admin", { method: "PUT", body: { config, scope } });
      setStatus(scope === "instance" ? "Saved as the team default." : "Saved.");
      onSaved();
    } catch (err) {
      setStatus((wasFiled(err) ? "" : "Error: ") + (err as Error).message);
    }
  }

  return (
    <div className="card">
      <div className="row">
        <h2 className="m-0">Customize layout</h2>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
      <div>
        {items.map((w, i) => (
          <div className="layout-item" key={w.id}>
            <label className="inline">
              <input type="checkbox" checked={w.required ? true : w.visible} disabled={w.required} onChange={(e) => setVisible(i, e.target.checked)} />
              {w.title}{w.required ? " (required)" : ""}
            </label>
            <span>
              {/* Reordering is chrome, not a call to action — the filled accent style is reserved
                  for the one thing a panel is FOR (here, Save). */}
              <button className="ghost mini" type="button" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>{" "}
              <button className="ghost mini" type="button" onClick={() => move(i, 1)} disabled={i === items.length - 1}>↓</button>
            </span>
          </div>
        ))}
      </div>
      <div className="actions">
        <button className="primary" onClick={() => save("user")}>Save for me</button>
        {/* Offered to everyone; without the layout permission it is sent for approval. */}
        <button className="ghost" onClick={() => save("instance")}>{canSaveInstance ? "Save as team default" : "Ask to save as team default"}</button>
      </div>
      <p className="muted">{status}</p>
    </div>
  );
}
