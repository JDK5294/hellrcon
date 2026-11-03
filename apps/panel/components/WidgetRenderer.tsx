"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanelGroup, Panel } from "./Panel";
import { api, fmt, openStream } from "../lib/api";
import { PlayerLink } from "./PlayerLink";
import { useServers } from "../lib/servers";
import type { DataSource, ValueFormat, Widget, WidgetBlock, WidgetColumn, WidgetSeries, WidgetTile } from "./LayoutEditor";
import { kindLabel, teamSwitchText } from "../lib/eventKinds";
import { toneClass } from "../lib/colors";
import { ActionResult, Callout, EmptyState, SkeletonLines, SkeletonRows } from "./ui";
import { Bars, SERIES_COUNT, SplitBar, StatGrid, StatTile } from "./viz";
import { Time } from "./Time";
import { dec, dur, num, pct } from "./analytics/shared";

/**
 * Renders a plugin widget's declarative `view` — the widget-rendering bridge. No plugin code
 * runs here; each known block `type` maps to a small React renderer. `plugin` data sources are
 * fetched from the API (backed by the plugin's server-side provider); `feed` blocks stream live
 * events over SSE.
 *
 * The block vocabulary tracks what the panel's own screens can do, deliberately. It used to be
 * markdown, one number, a table and a feed, while every first-party page had charts, tile grids,
 * skeletons, formatted values and a server picker — so a plugin's page read as a lesser citizen,
 * and the only way out was shipping browser code, which is the one thing this design exists to
 * prevent. Everything added here is still data: the plugin describes, the panel draws.
 */
export default function WidgetRenderer({ widget }: { widget: Widget }) {
  // Wrapped in a group of its own so a plugin destination collapses/reorders like a first-party one.
  return (
    <PanelGroup viewId={`plugin-${widget.id}`}>
      <Panel id="widget" caps="open" title={widget.title}>
        <WidgetBlocks widget={widget} />
      </Panel>
    </PanelGroup>
  );
}

/** Just the blocks — used inside the plugin page (with a card) and dashboard tiles (bare). */
export function WidgetBlocks({ widget }: { widget: Widget }) {
  const blocks = widget.view?.blocks ?? [];
  if (blocks.length === 0) return <p className="muted">This widget has no blocks.</p>;
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} block={b} pluginId={widget.pluginId} />
      ))}
    </>
  );
}

function Block({ block, pluginId }: { block: WidgetBlock; pluginId?: string }) {
  switch (block.type) {
    case "markdown":
      return <p style={{ whiteSpace: "pre-wrap" }}>{block.text}</p>;
    case "note":
      return <Callout variant={block.variant ?? "info"}>{block.text}</Callout>;
    case "stat":
      return <StatBlock block={block} pluginId={pluginId} />;
    case "stats":
      return <StatsBlock block={block} pluginId={pluginId} />;
    case "table":
      return <TableBlock block={block} pluginId={pluginId} />;
    case "bars":
      return <ChartBlock block={block} pluginId={pluginId} kind="bars" />;
    case "split":
      return <ChartBlock block={block} pluginId={pluginId} kind="split" />;
    case "feed":
      return <FeedBlock kinds={block.kinds} emptyText={block.emptyText} max={block.max ?? 40} />;
    default:
      return <p className="muted">Unsupported block.</p>;
  }
}

/** Walk a dotted path (supports numeric indices and `length`) into a JSON value. */
function pick(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (cur == null) return undefined;
    if (key === "length" && Array.isArray(cur)) cur = cur.length;
    else cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Write a value the way the rest of the panel writes it.
 *
 * `text` (the default) is deliberately unchanged from the old renderer's `String(value)`, so a
 * widget written before formats existed reads exactly as it did. Everything else routes through
 * the analytics helpers, which is the whole point: an absent number becomes an em dash rather
 * than "NaN" or "null", and a duration is coarsened the same way it is on every other page.
 */
function formatValue(value: unknown, format: ValueFormat | undefined): string {
  if (value === null || value === undefined) return format && format !== "text" ? "—" : "";
  switch (format) {
    case "number": return num(Number(value));
    case "decimal": return dec(Number(value));
    case "percent": return pct(Number(value));
    case "duration": return dur(Number(value));
    default: return String(value);
  }
}

/**
 * The same value, as a NODE — because one format cannot be a string.
 *
 * `time` promises the reader's own zone and a label that re-ages ("3 minutes ago"), which is a
 * live component, not text. Tables rendered it that way and stats did not, so the same field
 * declared the same way read as "3 minutes ago" in a table and as
 * "2026-08-21T20:00:00.000Z" in a tile beside it. Everything that shows a value goes through
 * here now, so there is one answer to what a format means.
 */
function renderValue(value: unknown, format: ValueFormat | undefined): ReactNode {
  if (format === "time") return value ? <Time iso={String(value)} /> : "—";
  return formatValue(value, format);
}

/** Numeric columns right-align, as they do in every first-party table. */
const isNumeric = (format?: ValueFormat) => format === "number" || format === "decimal" || format === "percent" || format === "duration";

/**
 * Resolve a DataSource to a value: static inline, fetched from the plugin's provider, or fetched
 * from a REST endpoint (`api`). Re-fetches on `refreshMs` when set.
 *
 * `loading` is separate from "data is null", because a source can legitimately answer null and a
 * tile that says "…" forever is indistinguishable from one that is broken.
 */
function useDataSource(source: DataSource, pluginId?: string): { data: unknown; error: string; loading: boolean } {
  const { serverId, servers, loading: serversLoading, error: serversError } = useServers();
  // The server list is in hand already: the panel reads it once for every screen (lib/servers) and
  // keeps it current. A tile about it reads that instead of asking again once the dashboard's
  // layout has arrived — a second read of the same answer, and a whole extra wait on every opening.
  const shared = source.kind === "api" && source.path === "/servers";
  // `{serverId}` in an api path follows the reader's selected server, the way the rest of the
  // panel does. Resolved here so the effect re-runs when they switch servers.
  const resolved = useMemo<DataSource | null>(() => {
    if (shared) return null;
    if (source.kind !== "api" || !source.path.includes("{serverId}")) return source;
    if (!serverId) return null; // nothing to ask for yet — not an error, just not answerable
    return { ...source, path: source.path.replaceAll("{serverId}", encodeURIComponent(serverId)) };
  }, [source, serverId, shared]);

  const [data, setData] = useState<unknown>(source.kind === "static" ? source.value : null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(source.kind !== "static");

  useEffect(() => {
    if (!resolved) { setLoading(false); return; }
    if (resolved.kind === "static") {
      setData(resolved.value);
      setLoading(false);
      return;
    }
    let alive = true;
    setError("");
    // A new source means the value on screen belongs to the old one. Switching servers is the
    // case that bites: without this, server A's numbers sat under server B's name until the new
    // request landed, which is the same stale-read hazard the panel's own server picker was
    // fixed for. Clear first, show the skeleton, then answer.
    setData(null);
    setLoading(true);
    // Same polling discipline as useResource: never a second request while one is out, and a
    // hidden tab lets its ticks pass — a dashboard full of widgets in a background tab was a
    // steady drip of fetches nobody was looking at.
    let inFlight = false;
    const load = async () => {
      inFlight = true;
      try {
        if (resolved.kind === "plugin") {
          if (!pluginId) { if (alive) { setError("widget has no plugin id"); setLoading(false); } return; }
          const r = await api<{ data: unknown }>(`/plugins/${pluginId}/data?key=${encodeURIComponent(resolved.key)}`);
          if (alive) setData(r.data);
        } else {
          const r = await api<unknown>(resolved.path);
          if (alive) setData(pick(r, resolved.pick));
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight = false;
        if (alive) setLoading(false);
      }
    };
    void load();
    const ms = resolved.refreshMs;
    const timer = ms && ms > 0
      ? setInterval(() => { if (!inFlight && !(typeof document !== "undefined" && document.hidden)) void load(); }, ms)
      : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [resolved, pluginId]);

  if (shared) return { data: pick({ servers }, source.pick), error: serversError, loading: serversLoading && !serversError };
  return { data, error, loading: loading && !error };
}

/** A source that needs a server the reader has not picked yet says so, rather than sitting empty. */
function NeedsServer() {
  return <p className="muted">Pick a server to see this.</p>;
}
const awaitingServer = (source: DataSource, serverId: string | null | undefined) =>
  source.kind === "api" && source.path.includes("{serverId}") && !serverId;

function StatBlock({ block, pluginId }: { block: Extract<WidgetBlock, { type: "stat" }>; pluginId?: string }) {
  const { serverId } = useServers();
  const { data, error, loading } = useDataSource(block.source, pluginId);
  if (awaitingServer(block.source, serverId)) return <NeedsServer />;
  // Accept a raw scalar or a { value } object.
  const value = data !== null && typeof data === "object" && "value" in (data as object) ? (data as { value: unknown }).value : data;
  const shown: ReactNode = loading ? "…" : error ? "—" : renderValue(value, block.format);
  return (
    <>
      <StatTile
        label={block.label}
        value={<>{shown}{block.unit ? <span className="muted" style={{ fontSize: "1rem" }}> {block.unit}</span> : null}</>}
        sub={block.sub}
        accent={block.accent}
      />
      <ActionResult error={error} />
    </>
  );
}

function StatsBlock({ block, pluginId }: { block: Extract<WidgetBlock, { type: "stats" }>; pluginId?: string }) {
  const { serverId } = useServers();
  const { data, error, loading } = useDataSource(block.source, pluginId);
  if (awaitingServer(block.source, serverId)) return <NeedsServer />;
  if (loading) return <SkeletonLines lines={2} />;
  if (error) return <ActionResult error={error} />;
  return (
    <StatGrid>
      {(block.tiles ?? []).map((t: WidgetTile) => (
        <StatTile
          key={t.key + t.label}
          label={t.label}
          value={<>{renderValue(pick(data, t.key), t.format)}{t.unit ? <span className="muted" style={{ fontSize: "1rem" }}> {t.unit}</span> : null}</>}
          sub={t.sub}
          accent={t.accent}
        />
      ))}
    </StatGrid>
  );
}

function TableBlock({ block, pluginId }: { block: Extract<WidgetBlock, { type: "table" }>; pluginId?: string }) {
  const { serverId } = useServers();
  const { data, error, loading } = useDataSource(block.source, pluginId);
  const columns = block.columns ?? [];
  if (awaitingServer(block.source, serverId)) return <NeedsServer />;
  if (loading) return <SkeletonRows rows={3} cols={Math.max(1, columns.length)} />;
  if (error) return <ActionResult error={error} />;
  const all = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  // A widget pointed at an unbounded endpoint must not put ten thousand rows in a dashboard tile.
  const max = block.max && block.max > 0 ? block.max : 200;
  const rows = all.slice(0, max);
  if (!rows.length) return <EmptyState title={block.emptyText ?? "No data"}>Nothing to show here yet.</EmptyState>;
  return (
    <div className="scroll-x">
      <table>
        <thead><tr>{columns.map((c: WidgetColumn) => <th key={c.key} className={isNumeric(c.format) ? "num" : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{columns.map((c: WidgetColumn) => {
              const raw = row[c.key];
              // A "player"-linked column renders the cell as a link to that row's profile.
              const cell = c.link === "player"
                ? <PlayerLink playerId={row.playerId ? String(row.playerId) : undefined} name={String(raw ?? "")} />
                : renderValue(raw, c.format);
              return <td key={c.key} className={isNumeric(c.format) ? "num" : undefined}>{cell}</td>;
            })}</tr>
          ))}
        </tbody>
      </table>
      {all.length > rows.length && (
        <p className="muted fs-sm">Showing the first {rows.length.toLocaleString()} of {all.length.toLocaleString()}.</p>
      )}
    </div>
  );
}

/**
 * A share bar identifies its slices BY COLOUR, and the palette has seven.
 *
 * `seriesVar` clamps anything past the seventh to the seventh — the palette defending itself —
 * so a widget handing over twenty slices drew a run of identical bands that a reader cannot tell
 * apart or match to the legend. The house rule for categorical colour is that an extra series
 * folds into "Other" rather than being given a colour that is already taken, so that is what
 * happens: the biggest are kept, the tail is summed, and the total still adds up.
 */
function foldToPalette(rows: { label: string; value: number }[]): { key: string; label: string; value: number; colorIndex: number }[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  if (sorted.length <= SERIES_COUNT) {
    return sorted.map((r, i) => ({ key: `${i}-${r.label}`, label: r.label, value: r.value, colorIndex: i }));
  }
  const kept = sorted.slice(0, SERIES_COUNT - 1);
  const rest = sorted.slice(SERIES_COUNT - 1).reduce((n, r) => n + r.value, 0);
  return [
    ...kept.map((r, i) => ({ key: `${i}-${r.label}`, label: r.label, value: r.value, colorIndex: i })),
    { key: "other", label: `Other (${sorted.length - kept.length})`, value: rest, colorIndex: SERIES_COUNT - 1 },
  ];
}

/**
 * The two chart blocks, which differ only in the mark they draw: `bars` compares rows against each
 * other, `split` shows them as shares of one whole. Both read the same `{label, value}` list, so a
 * plugin can move between them without reshaping its data.
 */
function ChartBlock({ block, pluginId, kind }: {
  block: Extract<WidgetBlock, { type: "bars" | "split" }>;
  pluginId?: string;
  kind: "bars" | "split";
}) {
  const { serverId } = useServers();
  const { data, error, loading } = useDataSource(block.source, pluginId);
  const series = block as WidgetSeries;
  if (awaitingServer(block.source, serverId)) return <NeedsServer />;
  if (loading) return <SkeletonLines lines={3} />;
  if (error) return <ActionResult error={error} />;
  const labelKey = series.labelKey ?? "label";
  const valueKey = series.valueKey ?? "value";
  const rows = (Array.isArray(data) ? (data as Record<string, unknown>[]) : [])
    .map((r) => ({ label: String(r[labelKey] ?? ""), value: Number(r[valueKey] ?? 0) }))
    .filter((r) => Number.isFinite(r.value));
  const format = (n: number) => formatValue(n, series.format ?? "number");
  const empty = series.emptyText ?? "No data yet.";
  return kind === "bars"
    ? <Bars data={rows} colorIndex={(block as { colorIndex?: number }).colorIndex ?? 0} format={format} empty={empty} />
    : <SplitBar slices={foldToPalette(rows)} format={format} empty={empty} />;
}

interface FeedItem { key: string; ts: string; kind: string; text: string; tone: string; playerId?: string; actorName?: string }

function FeedBlock({ kinds, emptyText, max }: { kinds: string[]; emptyText?: string; max: number }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const kindSet = useRef(new Set(kinds));
  useEffect(() => {
    kindSet.current = new Set(kinds);
  }, [kinds]);

  useEffect(() => {
    return openStream(undefined, { message: (data) => {
      try {
        const evt = JSON.parse(data) as { kind: string; ts: string; actorPlayerId?: string; actorName?: string; victimName?: string; weapon?: string; data?: Record<string, unknown> };
        if (!kindSet.current.has(evt.kind)) return;
        const text = `${evt.kind === "evt.player.teamSwitched" ? " " + (teamSwitchText(evt.data) ?? "switched team") : ""}${evt.victimName ? " → " + evt.victimName : ""}${evt.weapon ? ` (${evt.weapon})` : ""}`;
        setItems((prev) => [{
          key: `${Date.now()}-${Math.random()}`, ts: evt.ts, kind: evt.kind, text,
          tone: toneClass(evt.kind, evt.data),
          playerId: evt.actorPlayerId, actorName: evt.actorName || "",
        }, ...prev].slice(0, max));
      } catch {
        /* ignore malformed frame */
      }
    } });
  }, [max]);

  return (
    <div className="live-feed">
      {items.length === 0 && <div className="live-row"><span className="muted">{emptyText ?? "Waiting for events…"}</span></div>}
      {items.map((r) => (
        <div className={`live-row ${r.tone}`} key={r.key}>
          {/* The actor is a link, as it is in the panel's own live feed — a name you cannot click
              is the difference between reading a feed and using one. */}
          <time>{fmt(r.ts)}</time> <code>{kindLabel(r.kind)}</code>{" "}
          <span>{r.actorName ? <PlayerLink playerId={r.playerId} name={r.actorName} /> : null}{r.text}</span>
        </div>
      ))}
    </div>
  );
}
