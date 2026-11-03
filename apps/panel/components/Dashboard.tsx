"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRefreshable } from "../lib/refresh";
import { api, wasFiled } from "../lib/api";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";
import type { Widget, WidgetSize } from "./LayoutEditor";
import { WidgetBlocks } from "./WidgetRenderer";
import { BUILTIN_TILES } from "./builtinTiles";
import { ActionResult, EmptyState, Toggle } from "./ui";
import { AttentionStrip } from "./cards/AttentionStrip";

const MAX_COLS = 12;
const MAX_ROWS = 8;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const sizeOf = (w: Widget): WidgetSize => ({ w: clamp(w.size?.w ?? 2, 1, MAX_COLS), h: clamp(w.size?.h ?? 1, 1, MAX_ROWS) });

/** Columns shrink on narrow viewports so tiles never overflow the grid. */
function useColumns(): number {
  const [cols, setCols] = useState(MAX_COLS);
  useEffect(() => {
    const compute = () => {
      const w = window.innerWidth;
      setCols(w < 700 ? 2 : w < 1000 ? 4 : w < 1500 ? 8 : MAX_COLS);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);
  return cols;
}

/** Compact size picker: a little matrix you sweep across to choose width×height. */
function SizePicker({ size, onPick }: { size: WidgetSize; onPick: (s: WidgetSize) => void }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<WidgetSize | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const shown = hover ?? size;
  return (
    <div className="sizepick" ref={ref}>
      <button className="mini" title="Resize" onClick={() => setOpen((v) => !v)}>{size.w}×{size.h}</button>
      {open && (
        <div className="sizepick-pop" onMouseLeave={() => setHover(null)}>
          {/* cell size comes from a custom property so a touch device can enlarge the whole matrix */}
          <div className="sizepick-grid" style={{ gridTemplateColumns: `repeat(${MAX_COLS}, var(--sizepick-cell))` }}>
            {Array.from({ length: MAX_ROWS }, (_, r) =>
              Array.from({ length: MAX_COLS }, (_, c) => {
                const on = c < shown.w && r < shown.h;
                return (
                  <div
                    key={`${r}-${c}`}
                    className={`sizepick-cell ${on ? "on" : ""}`}
                    onMouseEnter={() => setHover({ w: c + 1, h: r + 1 })}
                    onClick={() => { onPick({ w: c + 1, h: r + 1 }); setOpen(false); }}
                  />
                );
              }),
            )}
          </div>
          <div className="sizepick-label">{shown.w} × {shown.h}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The dashboard: a grid of resizable, draggable widget tiles. In edit mode a tile can be
 * dragged to reorder (the dragged tile ghosts and others reflow live to show where it lands),
 * resized to any width×height up to 12×8 via the sweep picker, or hidden. Arrangement persists
 * per-user via the layout API (`dashboard` surface).
 */
export default function Dashboard({ unseenAnnouncements = 0 }: { unseenAnnouncements?: number } = {}) {
  const [items, setItems] = useState<Widget[]>([]);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  const columns = useColumns();
  const grants = useGrants();
  const canSaveInstance = hasCap(grants, "layout.edit", "write");

  const load = useCallback(async () => {
    try {
      const r = await api<{ widgets: Widget[] }>("/layout/dashboard");
      setItems(r.widgets.map((w) => ({ ...w, size: sizeOf(w) })));
      setLoadErr("");
    } catch (e) {
      // Said, not drawn as an empty dashboard: Widgets and Edit layout save the list on screen, and
      // an empty list saved there cleared the layout that couldn't be read — or the team's default.
      setLoadErr((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // Dashboard predates useResource and still loads by hand, so it joins the pull-to-refresh here.
  useRefreshable(load);

  // drag to reorder: move the dragged tile as it passes over others (live reflow feedback)
  const onDragEnter = (i: number) => {
    const from = dragIndex.current;
    if (from === null || from === i) return;
    setItems((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(i, 0, moved!);
      return next;
    });
    dragIndex.current = i;
  };

  // Tap-and-keyboard reorder. Dragging above is HTML5 drag-and-drop, which fires no events for
  // touch, so on a phone these buttons are the only way to move a tile.
  const moveTile = (from: number, dir: -1 | 1) => setItems((prev) => {
    const to = from + dir;
    if (to < 0 || to >= prev.length) return prev;
    const next = prev.slice();
    [next[from], next[to]] = [next[to]!, next[from]!];
    return next;
  });

  const setSize = (id: string, size: WidgetSize) => setItems((prev) => prev.map((w) => (w.id === id ? { ...w, size } : w)));
  const toggleHidden = (id: string) => setItems((prev) => prev.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)));

  const configFrom = (list: Widget[]) => ({ items: list.map((w, idx) => ({ widgetId: w.id, visible: w.visible, order: idx * 10, size: sizeOf(w) })) });

  // Per-user widget on/off — saved to the user's own dashboard layout immediately (shared instance
  // default stays intact; each user customizes which of the on widgets they see).
  async function toggleShown(id: string) {
    const before = items;
    const next = items.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w));
    setItems(next);
    // The picker says "Saved to your account", so a save that failed puts the card back and says
    // why, rather than showing a dashboard the next visit will not.
    try { await api("/layout/dashboard", { method: "PUT", body: { config: configFrom(next), scope: "user" } }); }
    catch (e) {
      setItems(before);
      setStatus((wasFiled(e) ? "" : "Error: ") + (e as Error).message);
    }
  }

  // close the widget picker on outside click
  useEffect(() => {
    if (!picking) return;
    const onDoc = (e: MouseEvent) => { if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPicking(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [picking]);

  async function save(scope: "user" | "instance") {
    setStatus("Saving…");
    try {
      await api("/layout/dashboard", { method: "PUT", body: { config: configFrom(items), scope } });
      setStatus(scope === "instance" ? "Saved as the team default." : "Saved");
      setEditing(false);
      setTimeout(() => setStatus(""), 2500);
    } catch (e) {
      setStatus((wasFiled(e) ? "" : "Error: ") + (e as Error).message);
    }
  }

  const shown = editing ? items : items.filter((w) => w.visible);

  return (
    <div className={`dashboard ${editing ? "editing" : ""}`}>
      <div className="row dash-head">
        <h1 className="m-0">Dashboard</h1>
        <div className="actions mt-0">
          {status && <span className="muted" style={{ alignSelf: "center" }}>{status}</span>}
          {editing ? (
            <>
              <button className="primary" onClick={() => save("user")}>Save</button>
              {/* Same wording as the nav editor and every page's Arrange mode: sets the starting
                  point for colleagues who haven't arranged their own dashboard. Offered to
                  everyone; without the layout permission it is sent for approval. */}
              <button className="ghost" onClick={() => save("instance")}>{canSaveInstance ? "Save as team default" : "Ask to save as team default"}</button>
              <button className="ghost" onClick={() => { setEditing(false); load(); }}>Cancel</button>
            </>
          ) : !loadErr && (
            <>
              <div className="widget-picker-wrap" ref={pickRef}>
                <button className="ghost" onClick={() => setPicking((v) => !v)}>Widgets</button>
                {picking && (
                  <div className="widget-picker">
                    <div className="widget-picker-head">Show on your dashboard</div>
                    {items.map((w) => (
                      <label key={w.id} className={`widget-picker-item ${w.required ? "locked" : ""}`}>
                        <Toggle checked={w.visible} disabled={w.required} onChange={() => toggleShown(w.id)} name={w.title} />
                        <span>{w.title}</span>
                      </label>
                    ))}
                    <div className="widget-picker-foot muted">Saved to your account.</div>
                  </div>
                )}
              </div>
              <button className="ghost" onClick={() => setEditing(true)}>Edit layout</button>
            </>
          )}
        </div>
      </div>

      {/* What needs you, before the numbers. */}
      {!editing && <AttentionStrip unseenAnnouncements={unseenAnnouncements} />}

      {loadErr && <div className="card"><ActionResult error={`Couldn't read your dashboard layout: ${loadErr}`} /></div>}

      {loaded && !loadErr && shown.length === 0 && (
        <div className="card">
          <EmptyState icon="🧩" title="Your dashboard is empty"
            action={<button className="mini" onClick={() => setPicking(true)}>Choose widgets</button>}>
            The dashboard is yours to arrange — pick the tiles you want (server state, top players, live
            kills, recent activity) and drag them into the order that suits how you work.
          </EmptyState>
        </div>
      )}

      <div className="dash-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {shown.map((w) => {
          const i = items.indexOf(w);
          const s = sizeOf(w);
          return (
            <div
              key={w.id}
              className={`tile ${editing ? "editable" : ""} ${!w.visible ? "hidden-tile" : ""} ${draggingId === w.id ? "dragging" : ""}`}
              style={{ gridColumn: `span ${Math.min(s.w, columns)}`, gridRow: `span ${s.h}` }}
              draggable={editing}
              onDragStart={() => { dragIndex.current = i; setDraggingId(w.id); }}
              onDragEnter={() => onDragEnter(i)}
              onDragOver={(e) => editing && e.preventDefault()}
              onDragEnd={() => { dragIndex.current = null; setDraggingId(null); }}
            >
              <div className="tile-head">
                <span className="tile-title">{w.title}</span>
                {editing && (
                  <span className="tile-controls" role="group" aria-label={`Arrange ${w.title}`}>
                    <button className="mini ghost tile-move" title="Move earlier" aria-label={`Move ${w.title} earlier`} disabled={i === 0} onClick={() => moveTile(i, -1)}>◀</button>
                    <button className="mini ghost tile-move" title="Move later" aria-label={`Move ${w.title} later`} disabled={i === items.length - 1} onClick={() => moveTile(i, 1)}>▶</button>
                    <SizePicker size={s} onPick={(ns) => setSize(w.id, ns)} />
                    <button className="mini ghost" title={w.visible ? "Hide" : "Show"} onClick={() => toggleHidden(w.id)}>{w.visible ? "◉" : "◯"}</button>
                  </span>
                )}
              </div>
              <div className="tile-body">
                {(() => {
                  const Builtin = BUILTIN_TILES[w.id];
                  return Builtin ? <Builtin /> : <WidgetBlocks widget={w} />;
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
