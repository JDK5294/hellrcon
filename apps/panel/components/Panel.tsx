"use client";
/**
 * Arrangeable panels, per user — the dashboard's layout treatment applied to every screen. A
 * `<PanelGroup viewId>` wraps a set of `<Panel id>` children; each panel has a header with a
 * collapse toggle and optional actions. "Arrange panels" enters an edit mode (the dashboard's
 * "Edit layout", same idea) where panels compress to their headers and can be dragged to reorder
 * with live reflow, moved with ◀ ▶ buttons (the touch/keyboard path — HTML5 drag-and-drop fires
 * nothing for touch), sized to ⅓/½/⅔/full of the row on a 12-column grid, or hidden entirely.
 *
 * Order is applied via CSS `order` and width via `grid-column: span` (no DOM moves — safe with
 * conditional children). The arrangement persists server-side per user via the layout API
 * (`panel:<viewId>` surface), the same store the dashboard uses, so it follows the account across
 * browsers; localStorage keeps a first-paint cache so the page doesn't visibly re-shuffle while
 * the request is in flight. A panel used outside a group still renders (as a plain card), so
 * adoption is incremental and never breaks a view.
 *
 * Two things are kept deliberately separate:
 *   • `mounted`     — the panels on screen right now, in mount order. Not persisted; it is just what
 *                     the group can see, and it changes as conditional panels come and go.
 *   • `prefs.order` — the arrangement the USER chose. Only written when they actually move something.
 * The effective order is the saved arrangement (restricted to what's mounted) followed by anything
 * new in mount order, so adding a panel to a view never disturbs a layout somebody already set.
 * A panel the user HID stays registered — it keeps its slot and appears ghosted in Arrange mode;
 * it just doesn't render on the page.
 *
 * Every panel also declares who may see it, via `caps` — layer 3 of the permission model, with
 * lib/panels.ts for the rules and test/panel-registry.test.mjs for the obligation. A panel hidden
 * by caps (unlike one hidden by the user) skips registration entirely, so it takes no slot and
 * never appears in the arrange controls.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, wasFiled } from "../lib/api";
import { readPanelPrefs, writePanelPrefs, clearPanelPrefs, normalizePanelPrefs, prefsCustomized, EMPTY_PREFS, type PanelPrefs } from "../lib/panelPrefs";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";
import { panelVisible, type PanelCaps } from "../lib/panels";

/** The widths a panel can take, in twelfths of the row. Full width is the default and is not
 *  stored, so an untouched panel stays "no opinion" rather than "explicitly 12". */
const WIDTHS: [number, string][] = [[4, "⅓"], [6, "½"], [8, "⅔"], [12, "Full"]];

/**
 * What the server has already told us about each surface, for this page load.
 *
 * Staff move between screens constantly (the back/forward trail exists because of it), and every
 * mount was asking the API for the same arrangement again — four visits to a screen, four identical
 * requests, each one landing after first paint and re-setting state that had not changed. The
 * answer only changes when THIS tab changes it, so one fetch per surface is enough and every write
 * below updates the entry in step. Cleared on sign-out with everything else, since the module is
 * reloaded with the page.
 */
const layoutCache = new Map<string, PanelPrefs | null>();

interface GroupCtx {
  editing: boolean;
  orderIndex: (id: string) => number;
  /** Register a panel's "starts folded" default, honoured only until the user decides for themselves. */
  registerDefault: (id: string, collapsed: boolean) => void;
  register: (id: string) => () => void;
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  dragId: string | null;
  setDragId: (id: string | null) => void;
  /** Live reflow while dragging: move the dragged panel to the hovered panel's slot. */
  dragOver: (targetId: string) => void;
  move: (id: string, dir: -1 | 1) => void;
  canMove: (id: string, dir: -1 | 1) => boolean;
  width: (id: string) => number;
  setWidth: (id: string, w: number) => void;
  isHidden: (id: string) => boolean;
  toggleHidden: (id: string) => void;
}
const Ctx = createContext<GroupCtx | null>(null);

/**
 * The group's current arrangement as a position per panel id (lower = earlier), for the rare
 * screen whose SETTINGS follow it — Game rewards sends a match end's combined message in the
 * order its cards are arranged. Null outside a group.
 */
export function usePanelOrder(): ((id: string) => number) | null {
  return useContext(Ctx)?.orderIndex ?? null;
}

export function PanelGroup({ viewId, children }: { viewId: string; children: ReactNode }) {
  const [prefs, setPrefs] = useState<PanelPrefs>({ ...EMPTY_PREFS });
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState("");
  // Whether the arrangement on screen is THIS ACCOUNT'S saved one, rather than the team default (or
  // the built-ins). Reset only has something to undo in the first case: offering it against a team
  // default promised to change a page that would come back looking identical.
  const [ownLayout, setOwnLayout] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [mounted, setMounted] = useState<string[]>([]);
  // Panels that asked to start folded. A page full of expanded panels opens as a wall of scrolling;
  // secondary panels declare `defaultCollapsed` so the page opens short and you unfold what you
  // need. The moment the user collapses or expands ANYTHING here, their choice takes over
  // completely and these defaults stop applying — we never re-fold something they opened.
  const [defaults, setDefaults] = useState<Record<string, boolean>>({});
  const registerDefault = useCallback((id: string, collapsed: boolean) => {
    setDefaults((d) => (d[id] === collapsed ? d : { ...d, [id]: collapsed }));
  }, []);
  const grants = useGrants();
  const canSaveInstance = hasCap(grants, "layout.edit", "write");

  const surface = `panel:${viewId}`;

  // Saves are debounced (dragging reorders on every panel the pointer crosses) and flushed when
  // the group unmounts, so navigating away right after a change doesn't lose it. A failed PUT is
  // silent on purpose: localStorage already holds the arrangement, so the page stays as arranged
  // and the next successful save catches the server up.
  const pendingSave = useRef<PanelPrefs | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set the moment the user changes anything here, so the initial server fetch — still in flight
  // while a quick hand collapses a panel — cannot land afterwards and overwrite the fresher edit.
  const dirty = useRef(false);
  const flush = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const cfg = pendingSave.current;
    if (!cfg) return;
    pendingSave.current = null;
    api(`/layout/${surface}`, { method: "PUT", body: { config: cfg, scope: "user" } }).catch(() => { /* cache holds it */ });
  }, [surface]);
  useEffect(() => () => flush(), [flush]);

  useEffect(() => {
    // Cache first for an instant, stable paint; then the server's answer (the copy that follows
    // the account across browsers) replaces it. No server copy — e.g. an arrangement made before
    // panels persisted server-side — leaves the local one standing; the next change uploads it.
    dirty.current = false;
    setPrefs(readPanelPrefs(viewId));
    // Already asked for this surface on this page load: the answer cannot have changed behind our
    // back (only this tab writes it, and every write updates the entry), so re-visiting a screen
    // costs nothing.
    if (layoutCache.has(surface)) {
      const cached = layoutCache.get(surface) ?? null;
      if (cached) { setPrefs(cached); setOwnLayout(true); }
      return;
    }
    let alive = true;
    api<{ config?: unknown; source?: string }>(`/layout/${surface}`)
      .then((r) => {
        const config = r && typeof r.config === "object" && r.config !== null ? normalizePanelPrefs(r.config) : null;
        // Only a layout of the account's OWN is worth replaying on the next mount — a team default
        // is re-resolved server-side, and caching it as "mine" would make Reset lie.
        layoutCache.set(surface, r?.source === "user" ? config : null);
        if (!alive || dirty.current || !config) return;
        setPrefs(config);
        setOwnLayout(r?.source === "user");
        writePanelPrefs(viewId, config);
      })
      .catch(() => { /* offline or an older API — the local cache stands, and we may ask again */ });
    return () => { alive = false; };
  }, [viewId, surface]);

  /** Save + apply in one step. Callers pass a complete PanelPrefs, so no write happens inside a
   *  state updater (which React is free to run more than once). */
  const commit = useCallback((next: PanelPrefs) => {
    dirty.current = true;
    setPrefs(next);
    setOwnLayout(true); // from here on the page is arranged by this account, whatever it started as
    writePanelPrefs(viewId, next);
    layoutCache.set(surface, next);
    pendingSave.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 600);
  }, [viewId, surface, flush]);

  const register = useCallback((id: string) => {
    setMounted((m) => (m.includes(id) ? m : [...m, id]));
    return () => setMounted((m) => m.filter((x) => x !== id));
  }, []);

  const effective = useMemo(() => {
    const saved = prefs.order.filter((id) => mounted.includes(id));
    return [...saved, ...mounted.filter((id) => !saved.includes(id))];
  }, [prefs.order, mounted]);

  const orderIndex = useCallback((id: string) => {
    const i = effective.indexOf(id);
    return i < 0 ? 999 : i; // not registered yet — park it at the end until the effect runs
  }, [effective]);
  // `touched` records that this user has expressed an opinion about this page's panels; before that
  // the panel's own default applies.
  const isCollapsed = useCallback(
    (id: string) => (prefs.touched ? prefs.collapsed.includes(id) : defaults[id] ?? false),
    [prefs.touched, prefs.collapsed, defaults],
  );
  const toggle = useCallback((id: string) => {
    // First interaction: freeze what is on screen now (defaults included) as the user's own set, so
    // toggling one panel doesn't silently unfold every other panel that started folded.
    const base = prefs.touched ? prefs.collapsed : Object.entries(defaults).filter(([, c]) => c).map(([k]) => k);
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    commit({ ...prefs, collapsed: next, touched: true });
  }, [commit, prefs, defaults]);

  const canMove = useCallback((id: string, dir: -1 | 1) => {
    const i = effective.indexOf(id);
    return i >= 0 && i + dir >= 0 && i + dir < effective.length;
  }, [effective]);
  const move = useCallback((id: string, dir: -1 | 1) => {
    const i = effective.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= effective.length) return;
    const order = effective.slice();
    [order[i], order[j]] = [order[j]!, order[i]!];
    commit({ ...prefs, order, reordered: true });
  }, [commit, effective, prefs]);
  // Same splice the dashboard's tiles use: remove from the old slot, insert at the hovered one —
  // which lands after the hovered panel when dragging forward and before it when dragging back.
  const dragOver = useCallback((targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const from = effective.indexOf(dragId), to = effective.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const order = effective.slice();
    order.splice(from, 1);
    order.splice(to, 0, dragId);
    commit({ ...prefs, order, reordered: true });
  }, [commit, dragId, effective, prefs]);

  const width = useCallback((id: string) => Math.max(1, Math.min(12, prefs.widths[id] ?? 12)), [prefs.widths]);
  const setWidth = useCallback((id: string, w: number) => {
    const widths = { ...prefs.widths };
    if (w >= 12) delete widths[id]; else widths[id] = w;
    commit({ ...prefs, widths });
  }, [commit, prefs]);

  const isHidden = useCallback((id: string) => prefs.hidden.includes(id), [prefs.hidden]);
  const toggleHidden = useCallback((id: string) => {
    const hidden = prefs.hidden.includes(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id];
    commit({ ...prefs, hidden });
  }, [commit, prefs]);

  const reset = useCallback(async () => {
    dirty.current = true; // a straggling initial fetch must not resurrect what was just cleared
    pendingSave.current = null;
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    clearPanelPrefs(viewId);
    layoutCache.set(surface, null);
    setPrefs({ ...EMPTY_PREFS });
    setOwnLayout(false);
    try {
      await api(`/layout/${surface}`, { method: "DELETE" });
      // With the personal layout gone an instance default may apply — ask again.
      const r = await api<{ config?: unknown }>(`/layout/${surface}`);
      if (r?.config && typeof r.config === "object") {
        const p = normalizePanelPrefs(r.config);
        setPrefs(p);
        writePanelPrefs(viewId, p);
      }
    } catch { /* offline — the local reset already applied */ }
  }, [viewId, surface]);

  const saveInstance = useCallback(async () => {
    setStatus("Saving…");
    try {
      await api(`/layout/${surface}`, { method: "PUT", body: { config: prefs, scope: "instance" } });
      setStatus("Saved as the team default.");
    } catch (e) {
      setStatus((wasFiled(e) ? "" : "Error: ") + (e as Error).message);
    }
    setTimeout(() => setStatus(""), 3000);
  }, [surface, prefs]);

  // Reset undoes THIS ACCOUNT'S arrangement, so it needs both: something to undo, and the
  // arrangement on screen being ours. A team default satisfies the first on its own — it arrives
  // with widths and hidden panels set — and offering Reset against one promised to restore a page
  // that would come back looking exactly the same.
  const customized = ownLayout && prefsCustomized(prefs);

  return (
    <Ctx.Provider value={{ editing, orderIndex, register, registerDefault, isCollapsed, toggle, dragId, setDragId, dragOver, move, canMove, width, setWidth, isHidden, toggleHidden }}>
      <div className={`panel-group${editing ? " editing" : ""}`}>
        {children}
        <div className="panel-toolbar">
          {editing ? (
            <>
              <button className="mini primary" onClick={() => { setEditing(false); setDragId(null); flush(); }}>Done</button>
              <button className="mini ghost" onClick={reset} disabled={!customized} title="Back to this page's default arrangement">⟲ Reset</button>
              {/* Offered to everyone; without the layout permission it is sent for approval. */}
              <button className="mini ghost" onClick={saveInstance} title="Make this arrangement the starting point for everyone who hasn't arranged the page themselves">
                {canSaveInstance ? "Save as team default" : "Ask to save as team default"}
              </button>
              {status ? <span className="muted">{status}</span> : (
                <span className="muted panel-toolbar-hint">Drag panels or use ◀ ▶ · pick a width · ◉ hides a panel</span>
              )}
            </>
          ) : (
            <button className="panel-reset" onClick={() => setEditing(true)} title="Arrange this page: reorder panels, set widths, hide what you don't use">
              {/* Name the hidden panels a page holds, or "why is that gone?" has no thread to pull. */}
              ⧉ Arrange panels{(() => { const n = prefs.hidden.filter((id) => mounted.includes(id)).length; return n ? ` · ${n} hidden` : ""; })()}
            </button>
          )}
        </div>
      </div>
    </Ctx.Provider>
  );
}

export function Panel({ id, title, subtitle, actions, caps, capLevel, defaultCollapsed = false, children }: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Which capability gates this panel — `"open"` if none does. Required, so a new panel cannot be
   *  written without answering the question; see lib/panels.ts. */
  caps: PanelCaps;
  /** Level the capability is needed at. Defaults to read, like a route's. */
  capLevel?: "read" | "write";
  /** Start folded on a page the user hasn't arranged yet — for secondary panels, so the page opens
   *  short instead of as a wall of scrolling. Ignored once the user arranges the page themselves. */
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  const grants = useGrants();
  const register = ctx?.register;
  const registerDefault = ctx?.registerDefault;
  const visible = panelVisible(grants, caps, capLevel);
  // Registration is skipped for a caps-hidden panel so it takes no slot in the group's order and
  // does not appear in the arrange controls — otherwise the layout would have a gap where a panel
  // this account is not allowed to see used to be, which is its own kind of disclosure.
  useEffect(() => (visible ? register?.(id) : undefined), [register, id, visible]);
  useEffect(() => { if (visible) registerDefault?.(id, defaultCollapsed); }, [registerDefault, id, defaultCollapsed, visible]);
  if (!visible) return null;

  // Outside a group: render a plain always-open card so a Panel never breaks a standalone view.
  if (!ctx) {
    return (
      <section className="card panel">
        <header className="panel-head"><span className="panel-title">{title}</span>{actions && <div className="panel-actions">{actions}</div>}</header>
        <div className="panel-body">{children}</div>
      </section>
    );
  }

  const editing = ctx.editing;
  const hidden = ctx.isHidden(id);
  // A user-hidden panel stays registered (it keeps its slot and shows ghosted in Arrange mode)
  // but renders nothing on the page itself.
  if (hidden && !editing) return null;

  const collapsed = ctx.isCollapsed(id);
  const dragging = ctx.dragId === id;
  const w = ctx.width(id);
  const label = typeof title === "string" ? title : "panel";
  return (
    <section
      className={`card panel${collapsed ? " is-collapsed" : ""}${dragging ? " dragging" : ""}${hidden ? " hidden-panel" : ""}`}
      style={{ order: ctx.orderIndex(id), gridColumn: `span ${w}` }}
      draggable={editing}
      onDragStart={editing ? (e) => { ctx.setDragId(id); e.dataTransfer.effectAllowed = "move"; } : undefined}
      onDragEnd={editing ? () => ctx.setDragId(null) : undefined}
      onDragEnter={editing ? () => ctx.dragOver(id) : undefined}
      onDragOver={editing ? (e) => e.preventDefault() : undefined}
    >
      <header className="panel-head">
        {editing && <span className="panel-drag" title="Drag to reorder" aria-hidden>⠿</span>}
        {/* While arranging, the title is a LABEL, not a control: collapsing is off (the bodies are
            hidden anyway) and a button that does nothing is worse than no button — a keyboard user
            tabs onto it, presses it, and learns nothing. The arrange controls beside it are the
            interactive things on this row. */}
        {editing ? (
          <span className="panel-toggle"><span className="panel-title">{title}</span></span>
        ) : (
          <button className="panel-toggle" onClick={() => ctx.toggle(id)} aria-expanded={!collapsed} title={collapsed ? "Expand" : "Collapse"}>
            <span className="panel-chev" aria-hidden>▸</span>
            <span className="panel-title">{title}</span>
            {subtitle && <span className="panel-subtitle">{subtitle}</span>}
          </button>
        )}
        {editing ? (
          <span className="panel-edit-controls" onClick={(e) => e.stopPropagation()}>
            <button className="panel-move-btn" onClick={() => ctx.move(id, -1)} disabled={!ctx.canMove(id, -1)} title="Move earlier" aria-label={`Move ${label} earlier`}>◀</button>
            <button className="panel-move-btn" onClick={() => ctx.move(id, 1)} disabled={!ctx.canMove(id, 1)} title="Move later" aria-label={`Move ${label} later`}>▶</button>
            <span className="panel-widths" role="group" aria-label={`Width of ${label}`}>
              {WIDTHS.map(([val, lab]) => (
                <button key={val} className={`panel-width-btn${w === val ? " on" : ""}`} onClick={() => ctx.setWidth(id, val)} title={val === 12 ? "Full width" : `${lab} of the row`} aria-label={`Set ${label} to ${val === 12 ? "full" : lab} width`}>{lab}</button>
              ))}
            </span>
            <button className="panel-move-btn panel-hide-btn" onClick={() => ctx.toggleHidden(id)} title={hidden ? "Show this panel" : "Hide this panel"} aria-label={`${hidden ? "Show" : "Hide"} ${label}`}>{hidden ? "◯" : "◉"}</button>
          </span>
        ) : (
          actions && <div className="panel-actions" onClick={(e) => e.stopPropagation()}>{actions}</div>
        )}
      </header>
      {!collapsed && <div className="panel-body">{children}</div>}
    </section>
  );
}
