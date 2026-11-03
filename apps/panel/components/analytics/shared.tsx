"use client";
/**
 * Pieces every analytics page shares, so the five pages read as one product rather than five
 * dashboards that happen to sit next to each other.
 *
 * The window picker is the important one. Every analytics route reads the window the same way
 * (a number of days, a custom from/to, or all time — see the API's analyticsWindow), so the control
 * is identical everywhere and a habit learned on one page works on the next.
 */
import { useState, type ReactNode } from "react";
import { fmtDay, isoToWall, wallToIso } from "../../lib/time";
import { useRemembered } from "../../lib/remembered";

export const WINDOWS = [7, 30, 90, 365] as const;

const WINDOW_LABEL: Record<number, string> = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

/**
 * What an analytics page is looking at. `custom` carries CALENDAR dates ("YYYY-MM-DD"), read in the
 * display zone, both ends included — "Sep 1 to Sep 7" means the whole of the 7th, the way anybody
 * reading those two dates means it.
 */
export type AnalyticsRange =
  | { kind: "days"; days: number }
  | { kind: "custom"; from: string; to: string }
  | { kind: "all" };

export const DEFAULT_RANGE: AnalyticsRange = { kind: "days", days: 30 };

const isAnalyticsRange = (v: unknown): v is AnalyticsRange => {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return false;
  if (r.kind === "all") return true;
  if (r.kind === "days") return (WINDOWS as readonly number[]).includes(r.days as number);
  return r.kind === "custom" && typeof r.from === "string" && DATE_RE.test(r.from) && typeof r.to === "string" && DATE_RE.test(r.to);
};

/**
 * One analytics tab's window, kept for the sitting: a player opened from a chart, or another tab,
 * comes back to the same days — not to the last 30 again.
 */
export function useAnalyticsRange(tab: string): [AnalyticsRange, (r: AnalyticsRange) => void] {
  return useRemembered<AnalyticsRange>(`analytics.${tab}.range`, DEFAULT_RANGE, isAnalyticsRange, "session");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The calendar day after `date` ("2026-09-07" → "2026-09-08"), without a zoned Date in sight. */
function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The query string that asks the API for this range. */
export function rangeQuery(r: AnalyticsRange): string {
  if (r.kind === "all") return "all=1";
  if (r.kind === "custom") {
    const from = wallToIso(`${r.from}T00:00`);
    const to = wallToIso(`${nextDay(r.to)}T00:00`);
    if (from && to) return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }
  return `days=${r.kind === "days" ? r.days : 30}`;
}

/**
 * How long a page waits for its answer. The panel's usual minute is right for a month; a year or
 * all time on a large imported history, read cold after a restart, can honestly take longer — and
 * giving up at 60s would call a slow answer "no answer". Just under the tunnel's own 100s, which
 * is the real ceiling.
 */
export function rangeTimeoutMs(r: AnalyticsRange): number | undefined {
  return r.kind === "days" && r.days <= 90 ? undefined : 95_000;
}

/** Today's date in the display zone, as a date input's value. */
const today = (): string => isoToWall(new Date().toISOString()).slice(0, 10);
const daysAgo = (n: number): string => isoToWall(new Date(Date.now() - n * 86_400_000).toISOString()).slice(0, 10);

export function WindowPicker({ range, onChange }: { range: AnalyticsRange; onChange: (r: AnalyticsRange) => void }) {
  // The custom dates are a DRAFT until Apply: every change of range reloads the page's data, and
  // a reload per keystroke of a date is several slow queries for dates nobody meant.
  const [editing, setEditing] = useState(false);
  const [from, setFrom] = useState(range.kind === "custom" ? range.from : daysAgo(30));
  const [to, setTo] = useState(range.kind === "custom" ? range.to : today());
  const bad = !DATE_RE.test(from) || !DATE_RE.test(to) ? "Pick both dates."
    : from > to ? "The start date is after the end date."
    : from > today() ? "The start date is in the future."
    : "";
  const btn = (active: boolean, label: string, onClick: () => void) => (
    <button key={label} type="button" className={`seg-btn${active ? " active" : ""}`} aria-pressed={active} onClick={onClick}>{label}</button>
  );
  return (
    <>
      <div className="seg" role="group" aria-label="Time window">
        {WINDOWS.map((d) => btn(range.kind === "days" && range.days === d, WINDOW_LABEL[d]!, () => { setEditing(false); onChange({ kind: "days", days: d }); }))}
        {btn(range.kind === "all", "All time", () => { setEditing(false); onChange({ kind: "all" }); })}
        {btn(range.kind === "custom" || editing, "Custom…", () => setEditing(true))}
      </div>
      {editing && (
        <div className="control-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label className="fs-xs">From <input type="date" value={from} max={today()} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="fs-xs">To <input type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="button" className="primary mini" disabled={Boolean(bad)} onClick={() => { setEditing(false); onChange({ kind: "custom", from, to }); }}>Apply</button>
          <button type="button" className="ghost mini" onClick={() => setEditing(false)}>Cancel</button>
          {bad && <span className="hint" style={{ margin: 0 }}>{bad}</span>}
        </div>
      )}
    </>
  );
}

/** The window the API actually answered for, in words — only where the button alone doesn't say:
 *  all time starts wherever the recorded history does, and a custom range is its two dates. */
function shownLabel(range: AnalyticsRange, shown?: { from: string; to: string } | null): string | null {
  if (range.kind === "all") return shown ? `since ${fmtDay(shown.from)}` : null;
  if (range.kind === "custom") return `${fmtDay(wallToIso(`${range.from}T12:00`))} – ${fmtDay(wallToIso(`${range.to}T12:00`))}`;
  return null;
}

/** The row above the charts: what window, over what data, refreshable. One shape on all the pages. */
export function AnalyticsBar({ range, onRange, shown, scope, onRefresh, children }: {
  range: AnalyticsRange;
  onRange: (r: AnalyticsRange) => void;
  /** The `window` the response carried — what "All time" turned out to mean on this install. */
  shown?: { from: string; to: string } | null;
  /** What the numbers cover, in words — "this server", "all servers", the sample size. */
  scope?: ReactNode;
  onRefresh?: () => void;
  children?: ReactNode;
}) {
  const label = shownLabel(range, shown);
  return (
    <div className="an-bar">
      <WindowPicker range={range} onChange={onRange} />
      {label && <span className="muted fs-xs">{label}</span>}
      {children}
      {scope != null && <span className="muted fs-xs an-scope">{scope}</span>}
      {onRefresh && <button type="button" className="ghost mini an-refresh" onClick={onRefresh}>Refresh</button>}
    </div>
  );
}

/**
 * A panel's body while its read is out: the skeleton until the read lands, and after a failed read
 * a line that says so. Drawn over no data, a panel read as an empty window — "nobody played in this
 * window", a row of zeros, a chart with nothing on it — when nothing had been read at all. `said`:
 * the panel already shows the error itself, so the body stays empty.
 */
export function ReadPending({ error, said, children }: { error: string; said?: boolean; children: ReactNode }) {
  if (!error) return <>{children}</>;
  return said ? null : <p className="nothing">Couldn&apos;t read this.</p>;
}

// ---------------------------------------------------------------- formatting
//
// Shared so the same quantity never appears in two formats on two pages.

/*
 * Every one of these treats "not a finite number" as no value, not just null.
 *
 * They guarded null and undefined, which is what a field the API omits looks like — but arithmetic
 * on a missing field produces NaN, and NaN is neither. `168 - data.uncoveredHours` on a response
 * without that field rendered the literal string "NaN/168" on the staff analytics page. A dash says
 * "we don't have this"; NaN says "this software is broken", and one of those is true.
 *
 * Number.isFinite is false for null, undefined, NaN and both infinities, so it is the whole guard.
 */
export const num = (n: number | null | undefined): string => (!Number.isFinite(n as number) ? "—" : Math.round(n as number).toLocaleString());

export const dec = (n: number | null | undefined, places = 1): string => (!Number.isFinite(n as number) ? "—" : (n as number).toFixed(places));

/** A count in words, the noun singular for one: "1 kill", "12 kills" — never "1 kills". */
export const counted = (n: number | null | undefined, noun: string, plural = `${noun}s`): string =>
  `${num(n)} ${Number.isFinite(n as number) && Math.round(n as number) === 1 ? noun : plural}`;

/** A rate as a percentage. Rates are stored 0–1 everywhere; this is the only place that × 100. */
export const pct = (n: number | null | undefined, places = 0): string => (!Number.isFinite(n as number) ? "—" : `${((n as number) * 100).toFixed(places)}%`);

/** Seconds as the coarsest unit that still says something: 42s, 7m, 1h 12m. */
export function dur(sec: number | null | undefined): string {
  if (!Number.isFinite(sec as number)) return "—";
  sec = sec as number;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Minutes as the coarsest unit that still says something: 42m, 3h 05m, 2d 4h.
 *
 * Shared with the noticeboard itself (Community), which shows the same "time to see" figure beside
 * each notice — the two screens had a copy each, so the same number could have been formatted two
 * ways on two pages describing the same thing.
 */
export function minutes(min: number | null | undefined): string {
  if (min == null) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Hours from seconds, for totals big enough that minutes are noise. */
export const hours = (sec: number | null | undefined): string =>
  sec == null ? "—" : `${Math.round(sec / 3600).toLocaleString()}h`;

/** "02:00" for an hour index — reads as a clock time rather than a bare number. */
export const hourLabel = (h: number): string => `${String(h).padStart(2, "0")}`;

/**
 * A rate is only worth ranking when its denominator is big enough to mean something. Pages that sort
 * by a rate call this, so "100% win rate over 1 round" never tops a table.
 */
export const enoughSample = (denominator: number, min = 5): boolean => denominator >= min;

