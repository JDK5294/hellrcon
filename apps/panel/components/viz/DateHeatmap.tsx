"use client";
/**
 * Date × hour grid — the week heatmap unrolled onto the actual calendar, one row per LOCAL date,
 * newest at the top the way every other history surface in the panel reads. The week grid answers
 * "when are we USUALLY busy"; this one answers "was THAT Saturday busy" — the question you ask
 * after an event, or when deciding whether a slump was one bad week or a trend. It spans whatever
 * window the page has selected, a week to a year, which is why long windows scroll inside the
 * card instead of stretching the page.
 *
 * Same visual language as `Heatmap` (one sequential hue, opacity as the ramp, the scale in
 * numbers, exact values on hover) but deliberately a sibling rather than a mode of it: that
 * component draws a fixed 7×24 grid on four other pages, and its geometry must not learn to
 * stretch.
 *
 * An hour the window never sampled — the partial days at its edges, or an hour nothing was
 * recorded in — gets NO cell. A zero is a different fact (an empty server, a quiet hour), so it is
 * drawn: an outlined empty square, the legend's own zero. Left unoutlined, a zero looked exactly
 * like an hour with no record at all.
 */
import { useId, useState } from "react";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-05" → its pieces, without ever constructing a zoned Date that could shift the day. */
function parts(date: string): { y: number; m: number; d: number; dow: number } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
const short = (p: { m: number; d: number }) => `${MONTHS[p.m - 1]} ${p.d}`;

export function DateHeatmap({ rows, format = (n: number) => n.toLocaleString(), label = "events", empty = "Nothing recorded in this window yet." }: {
  /** Ascending calendar dates from the API, `hours[h]` averaged per local hour, null = never sampled. */
  rows: { date: string; hours: (number | null)[] }[];
  format?: (n: number) => string;
  label?: string;
  empty?: string;
}) {
  const [hover, setHover] = useState<{ r: number; h: number } | null>(null);
  const titleId = useId();
  const days = [...rows].reverse();
  const vals = days.flatMap((r) => r.hours).filter((v): v is number => v !== null);
  const max = Math.max(1, ...vals);
  if (!vals.some((v) => v > 0)) return <p className="nothing">{empty}</p>;

  const CELL = 15, GAP = 2, LEFT = 44, TOP = 14;
  const W = LEFT + 24 * (CELL + GAP), H = TOP + days.length * (CELL + GAP) + 12;
  // Same cap as the week grid, for the same reason: fixed cells, so width only magnifies.
  const MAX_CELL = 24;
  const maxWidth = Math.round(W * (MAX_CELL / CELL));
  // Every date gets a label while the rows still read as a list; past that, Mondays carry the
  // rhythm on a season and month-firsts on a year — the tooltip always has the exact date.
  const labelled = (p: { d: number; dow: number }) =>
    days.length <= 35 || (days.length <= 120 ? p.dow === 1 : p.d === 1);

  return (
    <div className="viz-wrap">
      <div style={days.length > 35 ? { maxHeight: 560, overflowY: "auto" } : undefined}>
        <svg viewBox={`0 0 ${W} ${H}`} className="viz-svg" style={{ maxWidth }} role="img" aria-labelledby={titleId}>
          <title id={titleId}>Activity by date and hour of day, most recent first. Busiest cell: {format(max)} {label}.</title>
          {[0, 6, 12, 18, 23].map((h) => (
            <text key={h} x={LEFT + h * (CELL + GAP) + CELL / 2} y={10} className="viz-axis" textAnchor="middle">{h}</text>
          ))}
          {days.map((row, r) => {
            const p = parts(row.date);
            return (
              <g key={row.date}>
                {labelled(p) && (
                  <text x={LEFT - 6} y={TOP + r * (CELL + GAP) + CELL - 3} className="viz-axis" textAnchor="end">{short(p)}</text>
                )}
                {row.hours.map((v, h) => {
                  if (v === null) return null;
                  const on = hover?.r === r && hover?.h === h;
                  const t = v === 0 ? 0 : 0.12 + (v / max) * 0.88;
                  return (
                    <rect
                      key={h} x={LEFT + h * (CELL + GAP)} y={TOP + r * (CELL + GAP)} width={CELL} height={CELL} rx={3}
                      className={`hm-cell${v === 0 ? " hm-zero" : ""}${on ? " on" : ""}`} style={{ opacity: v === 0 ? 1 : undefined, fillOpacity: t }}
                      onMouseEnter={() => setHover({ r, h })} onMouseLeave={() => setHover(null)}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="viz-legend-row">
        <span className="hm-step"><span className="hm-key hm-key-zero" /><span className="muted fs-xs">0</span></span>
        {[0.25, 0.5, 0.75, 1]
          .map((q) => Math.max(1, Math.round(max * q)))
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .map((v) => (
            <span key={v} className="hm-step">
              <span className="hm-key" style={{ opacity: 0.12 + (v / max) * 0.88 }} />
              <span className="muted fs-xs">{format(v)}</span>
            </span>
          ))}
        <span className="muted fs-xs hm-unit">{label}</span>
      </div>
      {hover && (() => {
        // Hover state can outlive the data: switching the window from 90 days to 7 swaps `rows`
        // under a pointer that never fired mouseleave, and the remembered index may point past
        // the new array. A missing row means the tip simply doesn't render this frame.
        const row = days[hover.r];
        if (!row) return null;
        const p = parts(row.date);
        return (
          <div className="viz-tip" role="status">
            <strong>{DOW[p.dow]} {short(p)} {String(hover.h).padStart(2, "0")}:00</strong> · {format(row.hours[hover.h] ?? 0)} {label}
          </div>
        );
      })()}
    </div>
  );
}
