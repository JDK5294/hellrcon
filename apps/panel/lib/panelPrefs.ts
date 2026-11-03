"use client";
/**
 * Per-user, per-view panel arrangement: order, widths, hidden set and collapse state.
 *
 * The authoritative copy lives server-side under the `panel:<viewId>` layout surface (same store
 * and scope rules as the dashboard's widget layout), so an arrangement follows the account across
 * browsers. localStorage is kept as a first-paint cache and offline fallback: it is read
 * synchronously on mount so the page doesn't visibly re-shuffle, then the server's answer (when it
 * differs) replaces it. Keyed by the signed-in username so different staff on a shared browser
 * don't clash; `username` is stamped into localStorage on login (see the panel boot).
 */
export interface PanelPrefs {
  /** panel ids in display order (CSS `order`); ids not listed fall back to mount order. */
  order: string[];
  /** panel ids currently collapsed (header shown, body folded). */
  collapsed: string[];
  /** panel ids removed from the page entirely — re-shown from Arrange mode. */
  hidden: string[];
  /** panel width in twelfths of the row (12 = full width, the default). Applies on wide
   *  viewports; narrow screens stack everything full-width regardless. */
  widths: Record<string, number>;
  /** set once the user has moved, sized or hidden a panel — `order` alone can't say, since it is
   *  also written on first mount to record the default order. Drives whether Reset is offered. */
  reordered?: boolean;
  /** set once the user has collapsed or expanded anything on this page. Until then each panel's own
   *  `defaultCollapsed` applies; afterwards `collapsed` is the whole truth and defaults never
   *  re-fold something the user opened. */
  touched?: boolean;
}

export const EMPTY_PREFS: PanelPrefs = { order: [], collapsed: [], hidden: [], widths: {} };

/** Clamp any stored/received shape into a valid PanelPrefs — used for both the localStorage cache
 *  and the server's `panel:` layout config, so the two can never disagree about the shape. */
export function normalizePanelPrefs(raw: unknown): PanelPrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<PanelPrefs>;
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const widths: Record<string, number> = {};
  if (p.widths && typeof p.widths === "object" && !Array.isArray(p.widths)) {
    for (const [k, v] of Object.entries(p.widths)) {
      if (typeof v === "number" && Number.isFinite(v)) widths[k] = Math.max(1, Math.min(12, Math.round(v)));
    }
  }
  return { order: ids(p.order), collapsed: ids(p.collapsed), hidden: ids(p.hidden), widths, reordered: !!p.reordered, touched: !!p.touched };
}

/** Has this user expressed any opinion about this page — anything for Reset to undo? */
export function prefsCustomized(p: PanelPrefs): boolean {
  return !!p.touched || !!p.reordered || p.hidden.length > 0 || Object.keys(p.widths).length > 0;
}

const keyFor = (view: string) => {
  let user = "";
  try { user = localStorage.getItem("panel.username") ?? ""; } catch { /* ignore */ }
  return `panel.panels.${user || "_"}.${view}`;
};

export function readPanelPrefs(view: string): PanelPrefs {
  try {
    const raw = localStorage.getItem(keyFor(view));
    if (!raw) return { ...EMPTY_PREFS };
    return normalizePanelPrefs(JSON.parse(raw));
  } catch { return { ...EMPTY_PREFS }; }
}

export function writePanelPrefs(view: string, prefs: PanelPrefs): void {
  try { localStorage.setItem(keyFor(view), JSON.stringify(prefs)); } catch { /* quota/private mode — preference is best-effort */ }
}

export function clearPanelPrefs(view: string): void {
  try { localStorage.removeItem(keyFor(view)); } catch { /* ignore */ }
}
