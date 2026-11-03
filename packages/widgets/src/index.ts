/**
 * @app/widgets — the framework-agnostic widget/layout engine.
 *
 * Every UI surface (admin panel, community page, scoreboard) is composed of **widgets**
 * arranged by a saved **layout config**. This package owns the *model* and the pure
 * resolution logic — no rendering, no framework — so the same layout drives the current
 * vanilla panel today and the Next.js UI later, and plugins register widgets the same way.
 */

export type Surface = "admin" | "dashboard" | "community" | "scoreboard";

/**
 * Where a block's data comes from. Declarative on purpose — no code crosses to the browser:
 * - `static`: an inline value baked into the widget definition.
 * - `plugin`: fetched from `GET /api/plugins/:id/data?key=…`, backed by a provider the plugin
 *   registered server-side (optionally re-fetched every `refreshMs`).
 */
export type DataSource =
  | { kind: "static"; value: unknown }
  | { kind: "plugin"; key: string; refreshMs?: number }
  /** first-party: fetch a REST endpoint and optionally `pick` a dotted path (e.g. "servers.length",
   *  "leaderboard.0.name"). Honors the caller's auth/RBAC — it's just a normal API call.
   *
   *  The path may contain `{serverId}`, which the panel replaces with whichever server the reader
   *  has selected. Almost every screen in the app is scoped to one server; without this a widget
   *  could only ever be community-wide or hard-wired to one id chosen when the plugin was
   *  written, which is why plugin tiles sat next to server-scoped ones showing something else. A
   *  widget whose path needs a server simply does not load until one is picked. */
  | { kind: "api"; path: string; pick?: string; refreshMs?: number };

/** Tile footprint on the dashboard grid, in grid cells (columns × rows). */
export interface WidgetSize { w: number; h: number }

/**
 * How a value is written for a person.
 *
 * The panel formats every one of these with the SAME helpers its own analytics pages use, so a
 * widget's numbers are spelled the way the rest of the app spells them — thousands separated,
 * durations coarsened, a rate rendered as a percentage, an absent value shown as an em dash
 * rather than "NaN" or "null". A widget that had to pre-format its own strings server-side could
 * not match that, and could not react to the reader's locale or time zone at all.
 */
export type ValueFormat =
  /** a count: 1234 → "1,234" */
  | "number"
  /** one decimal place, for averages and ratios that are not rates */
  | "decimal"
  /** a rate stored 0–1: 0.42 → "42%" */
  | "percent"
  /** seconds: 4320 → "1h 12m" */
  | "duration"
  /** an ISO timestamp, rendered in the reader's zone and re-rendered as it ages */
  | "time"
  /** as-is (the default) */
  | "text";

export interface WidgetColumn {
  key: string;
  label: string;
  /** if "player", the cell renders as a link to that row's player profile (using the row's
   *  `playerId` field), so names in a widget table are clickable like everywhere else. */
  link?: "player";
  /** how the cell is written; numeric formats also right-align the column, as everywhere else. */
  format?: ValueFormat;
}

/** One tile in a `stats` grid, reading a field out of the block's single source object. */
export interface WidgetTile {
  label: string;
  /** dotted path into the source value, e.g. "players" or "totals.kills". */
  key: string;
  unit?: string;
  /** the quieter line under the number — a denominator, a caveat, a comparison. */
  sub?: string;
  /** the one figure this group is about, if any. */
  accent?: boolean;
  format?: ValueFormat;
}

/** A `{label, value}` pair for the chart blocks, addressed by whatever the source calls them. */
export interface WidgetSeries {
  /** field holding each row's label (default "label"). */
  labelKey?: string;
  /** field holding each row's number (default "value"). */
  valueKey?: string;
  format?: ValueFormat;
  emptyText?: string;
}

/**
 * A declarative UI block. The panel ships a generic renderer for each known `type`; a plugin
 * composes these into a widget view without shipping any browser code (safe + version-stable).
 *
 * The vocabulary deliberately tracks what the panel's own screens can do. It began as markdown,
 * one number, a table and a live feed, while every first-party page had charts, tile grids,
 * skeletons and formatted values — so a plugin's page was visibly a lesser citizen, and the only
 * way out was shipping browser code, which is exactly what this design exists to avoid.
 */
export type WidgetBlock =
  | { type: "markdown"; text: string }
  /** A callout: context, a caveat, or a warning, in the panel's own note styling. */
  | { type: "note"; text: string; variant?: "info" | "warn" | "danger" }
  | { type: "stat"; label: string; source: DataSource; unit?: string; sub?: string; accent?: boolean; format?: ValueFormat }
  /** Several figures from ONE source object, as a tile grid — the shape every analytics page
   *  opens with, and one request instead of one per number. */
  | { type: "stats"; source: DataSource; tiles: WidgetTile[] }
  | { type: "table"; columns: WidgetColumn[]; source: DataSource; emptyText?: string; max?: number }
  /** A column chart over a list of `{label, value}` rows. */
  | ({ type: "bars"; source: DataSource; colorIndex?: number } & WidgetSeries)
  /** One bar split into shares — a composition, a pass/fail, a side balance. */
  | ({ type: "split"; source: DataSource } & WidgetSeries)
  | { type: "feed"; kinds: string[]; emptyText?: string; max?: number };

/** A widget's browser UI, as data. Absent → the panel shows a neutral placeholder. */
export interface WidgetView {
  blocks: WidgetBlock[];
}

/** A registerable UI module. First-party features and plugins both register these. */
export interface WidgetDef {
  id: string;
  title: string;
  surface: Surface;
  /** default position (lower = earlier). */
  defaultOrder: number;
  /** shown by default? */
  defaultVisible: boolean;
  /** if true, cannot be hidden (e.g. a required core widget). */
  required?: boolean;
  /** declarative UI for a plugin-provided view (built-in views are rendered by the panel). */
  view?: WidgetView;
  /** set by the host when a plugin registers the widget — which plugin backs its data providers. */
  pluginId?: string;
  /** default tile size on a grid surface (dashboard). */
  defaultSize?: WidgetSize;
  /** if set, the widget is only offered to users with this capability (read). The layout endpoint
   *  filters it out for everyone else, so a gated tile never reaches an unauthorized user. */
  capability?: string;
}

/** A saved per-widget override in a layout. */
export interface LayoutItem {
  widgetId: string;
  visible: boolean;
  order: number;
  /** grid tile size (dashboard surface); ignored by list surfaces. */
  size?: WidgetSize;
}

export interface LayoutConfig {
  items: LayoutItem[];
}

/** The effective, render-ready view of a widget after resolving defaults + overrides. */
export interface ResolvedWidget {
  id: string;
  title: string;
  visible: boolean;
  order: number;
  required: boolean;
  /** carried through so the panel can render a plugin widget's declarative UI. */
  view?: WidgetView;
  /** carried through so the panel knows which plugin backs the view's data sources. */
  pluginId?: string;
  /** effective tile size on a grid surface. */
  size?: WidgetSize;
}

/** In-memory registry. The server seeds first-party defaults; plugins add more. */
export class WidgetRegistry {
  private defs = new Map<string, WidgetDef>();

  /**
   * Add a widget. Ids are unique across every surface, because this is one flat map.
   *
   * A collision is refused rather than allowed to overwrite: this map is what the nav and the
   * dashboard are built from, so a silent last-writer-wins meant a widget could disappear from the
   * panel with nothing logged and nothing to look at. Plugin widget ids are namespaced by plugin id
   * before they get here, so in practice a collision now means a plugin registering the same id
   * twice, or being loaded twice — both of which the caller should hear about.
   *
   * @returns true if registered; false if an entry with this id already exists (left untouched).
   */
  register(def: WidgetDef): boolean {
    if (this.defs.has(def.id)) return false;
    this.defs.set(def.id, def);
    return true;
  }

  /** Replace (or add) a widget regardless of what is registered. For the first-party seeding path
   *  and tests, where overwriting is the intent rather than an accident. */
  upsert(def: WidgetDef): void {
    this.defs.set(def.id, def);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  list(surface: Surface): WidgetDef[] {
    return [...this.defs.values()].filter((d) => d.surface === surface);
  }
}

/**
 * Resolve the effective, ordered widget list for a surface:
 * - start from the registered widgets (defaults),
 * - apply saved overrides (visible/order) where the widget still exists,
 * - append any registered widget missing from the saved config (new features show up),
 * - drop saved entries whose widget no longer exists,
 * - `required` widgets can never be hidden.
 */
export function resolveLayout(defs: WidgetDef[], saved: LayoutConfig | null): ResolvedWidget[] {
  const overrides = new Map<string, LayoutItem>();
  for (const item of saved?.items ?? []) overrides.set(item.widgetId, item);

  const resolved: ResolvedWidget[] = defs.map((d) => {
    const o = overrides.get(d.id);
    const visible = d.required ? true : o ? o.visible : d.defaultVisible;
    const order = o ? o.order : d.defaultOrder;
    const size = o?.size ?? d.defaultSize ?? { w: 2, h: 1 };
    return { id: d.id, title: d.title, visible, order, required: Boolean(d.required), size, ...(d.view ? { view: d.view } : {}), ...(d.pluginId ? { pluginId: d.pluginId } : {}) };
  });

  resolved.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return resolved;
}

/** The built-in admin-panel widgets (mirrors the current tabs; plugins can add more). */
export const ADMIN_WIDGETS: WidgetDef[] = [
  // Retired as a nav destination: server connections live in the Config view's Connections tab now.
  // Kept registered, default-hidden, so stored layouts stay resolvable.
  { id: "servers", title: "Servers", surface: "admin", defaultOrder: 10, defaultVisible: false },
  { id: "players", title: "Players", surface: "admin", defaultOrder: 20, defaultVisible: true },
  // Absorbed into the Players hub as a tab; kept registered (default-hidden) so stored layouts resolve.
  { id: "leaderboard", title: "Leaderboard", surface: "admin", defaultOrder: 30, defaultVisible: false },
  // Retired: the plain Events view was superseded by Logs (the panel routes the old id there and
  // hides it from the nav). Kept registered, default-hidden, so stored layouts stay resolvable.
  { id: "events", title: "Events", surface: "admin", defaultOrder: 40, defaultVisible: false },
  // Repurposed: the public community page became the internal staff-announcements board.
  { id: "community", title: "Announcements", surface: "admin", defaultOrder: 50, defaultVisible: true },
  // Absorbed into the Administration hub as a tab; kept registered (default-hidden).
  { id: "trim", title: "Trim", surface: "admin", defaultOrder: 60, defaultVisible: false },
];

/** First-party dashboard tiles — glanceable summaries composed from the declarative block
 *  system + `api` data sources. Plugins can add their own tiles by registering a widget with a
 *  `view` on the `dashboard` surface. */
export const DASHBOARD_WIDGETS: WidgetDef[] = [
  // Every declarative tile below reads a real endpoint, and every one of those endpoints gates
  // on `server.view` read. Declaring it here is what keeps the tile off the dashboard of someone
  // who lacks the grant: without it the tile was still offered, still fetched, and still 403'd —
  // a permanently broken card in a place that is supposed to be a summary of what you can see.
  {
    id: "dash-servers",
    title: "Servers",
    surface: "dashboard",
    defaultOrder: 10,
    defaultVisible: true,
    defaultSize: { w: 2, h: 1 },
    capability: "server.view",
    view: { blocks: [{ type: "stat", label: "configured", format: "number", source: { kind: "api", path: "/servers", pick: "servers.length", refreshMs: 60000 } }] },
  },
  {
    id: "dash-players",
    title: "Players tracked",
    surface: "dashboard",
    defaultOrder: 20,
    defaultVisible: true,
    defaultSize: { w: 2, h: 1 },
    capability: "server.view",
    view: { blocks: [{ type: "stat", label: "seen all-time", format: "number", source: { kind: "api", path: "/players?limit=1", pick: "total", refreshMs: 30000 } }] },
  },
  {
    id: "dash-leaderboard",
    title: "Top fraggers",
    surface: "dashboard",
    defaultOrder: 30,
    defaultVisible: true,
    defaultSize: { w: 4, h: 2 },
    capability: "server.view",
    view: {
      blocks: [
        {
          type: "table",
          // Formats, so the tile spells its numbers the way every other table in the panel does:
          // thousands separated and right-aligned, K/D to one decimal place.
          columns: [
            { key: "name", label: "Player", link: "player" },
            { key: "kills", label: "Kills", format: "number" },
            { key: "kd", label: "K/D", format: "decimal" },
          ],
          source: { kind: "api", path: "/leaderboard?sort=kills&limit=25", pick: "leaderboard", refreshMs: 30000 },
          emptyText: "No stats yet.",
        },
      ],
    },
  },
  {
    id: "dash-killfeed",
    title: "Live kills",
    surface: "dashboard",
    defaultOrder: 40,
    defaultVisible: true,
    defaultSize: { w: 4, h: 3 },
    capability: "server.view",
    view: { blocks: [{ type: "feed", kinds: ["evt.kill", "evt.teamkill"], emptyText: "Waiting for kills…", max: 40 }] },
  },
  // Rich built-in tiles: no declarative `view` — the panel renders them by id from its built-in
  // tile registry (they need first-party React, e.g. the active-server context). Each declares what
  // its own reads need, as the declarative ones do: undeclared, a tile went to everyone, a role with
  // no permissions included, and showed them an error or an empty list.
  // The server's settings: /servers/:id/config.
  { id: "dash-server-settings", title: "Server settings", surface: "dashboard", defaultOrder: 50, defaultVisible: true, defaultSize: { w: 4, h: 2 }, capability: "server.config" },
  // The watchlist (/players/flagged); its VIP tab asks for VIP access itself.
  { id: "dash-vips-watched", title: "VIPs & watched", surface: "dashboard", defaultOrder: 60, defaultVisible: true, defaultSize: { w: 4, h: 2 }, capability: "server.view" },
  { id: "dash-recent", title: "Recent activity", surface: "dashboard", defaultOrder: 5, defaultVisible: true, defaultSize: { w: 4, h: 2 } },
  // Collective staff activity (everyone's actions) — only offered to users who can audit staff.
  { id: "dash-team-activity", title: "Team activity", surface: "dashboard", defaultOrder: 6, defaultVisible: true, defaultSize: { w: 4, h: 2 }, capability: "audit.trail" },
  // Map rotation for the active server (current + upcoming maps).
  { id: "dash-maprotation", title: "Map rotation", surface: "dashboard", defaultOrder: 55, defaultVisible: true, defaultSize: { w: 4, h: 2 }, capability: "server.view" },
  // Moderators (staff activity summary) — read from /audit/staff, which staff profiles open.
  { id: "dash-moderators", title: "Moderators", surface: "dashboard", defaultOrder: 70, defaultVisible: false, defaultSize: { w: 4, h: 2 }, capability: "staff.profiles" },
  // Player-rules status (the Rules tab of Auto settings) — gated to moderation admins. The id is
  // persisted in saved dashboard layouts, so only the title changed when auto-mod became a tab.
  { id: "dash-rules", title: "Player rules", surface: "dashboard", defaultOrder: 75, defaultVisible: false, defaultSize: { w: 4, h: 2 }, capability: "admin.moderation" },
];

export function defaultWidgets(surface: Surface): WidgetDef[] {
  if (surface === "admin") return ADMIN_WIDGETS;
  if (surface === "dashboard") return DASHBOARD_WIDGETS;
  return [];
}
