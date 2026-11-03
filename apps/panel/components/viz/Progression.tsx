"use client";
/**
 * Change-over-time line chart (inline SVG — the panel is a static export, no chart libs). One line
 * per series on a single shared y-axis (never dual-axis), a legend that toggles series, a window
 * selector to zoom to the last N points, an optional linear trend line (shown only when a single
 * series is isolated, so it's unambiguous), and a crosshair + tooltip on hover. Series colour is
 * assigned by fixed palette slot so toggling never repaints the survivors.
 */
import { useMemo, useRef, useState } from "react";
import { seriesVar } from "./palette";

export interface ProgSeries { key: string; label: string; colorIndex: number }
/** A value of null (or an absent key) is a GAP — "nothing was measured here", which is a
 *  different fact from zero. The line breaks instead of inventing a 0 point; the tooltip says
 *  "—". A ratio like K/D on a day with no rounds is the canonical case. */
export interface ProgPoint { x: string; label?: string; values: Record<string, number | null> }

const W = 720, H = 240, PAD = { l: 38, r: 14, t: 14, b: 26 };
const PW = W - PAD.l - PAD.r, PH = H - PAD.t - PAD.b;
const DEFAULT_WINDOWS = [25, 50, 100, 500];

/** least-squares slope/intercept over (i, y) pairs → a straight line across the plot. Gaps
 *  (null) simply don't vote; the x positions of the points that do are kept. */
function trendLine(ys: (number | null)[]): { x1: number; y1: number; x2: number; y2: number } | null {
  const pairs = ys.map((y, i) => ({ i, y })).filter((p): p is { i: number; y: number } => p.y !== null);
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { i, y } of pairs) { sx += i; sy += y; sxx += i * i; sxy += i * y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  const last = ys.length - 1;
  return { x1: 0, y1: b, x2: last, y2: m * last + b };
}

export function Progression({ points, series, windows = DEFAULT_WINDOWS, format = (n: number) => n.toLocaleString() }: {
  points: ProgPoint[];
  series: ProgSeries[];
  windows?: number[];
  /** How a value reads. Without this a percentage series draws an axis of bare numbers, and "36"
   *  on a share chart is indistinguishable from 36 players. */
  format?: (n: number) => string;
}) {
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [win, setWin] = useState<number | "all">("all");
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const visible = series.filter((s) => !off[s.key]);
  const winPoints = useMemo(() => (win === "all" ? points : points.slice(-win)), [points, win]);
  const n = winPoints.length;

  /** null (or absent) means a gap, never zero. */
  const val = (p: ProgPoint, key: string): number | null => p.values[key] ?? null;

  const max = useMemo(() => {
    let m = 0;
    for (const p of winPoints) for (const s of visible) m = Math.max(m, val(p, s.key) ?? 0);
    return m || 1;
  }, [winPoints, visible]);

  if (!points.length) return <p className="muted">Not enough history to chart yet.</p>;

  const xAt = (i: number) => (n <= 1 ? PAD.l + PW / 2 : PAD.l + (i / (n - 1)) * PW);
  const yAt = (v: number) => PAD.t + PH - (v / max) * PH;

  // y grid: 4 bands.
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((max * i) / 4));
  // x labels: at most ~6, evenly sampled, and the LAST point is always labelled so the axis says
  // where the series ends. Those two rules fight each other — with 14 points every 3rd is labelled,
  // which puts one at index 12 right on top of the forced one at 13. Drop a sampled label that
  // lands inside half a step of the end.
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const lastSafe = n - 1 - Math.ceil(labelEvery / 2);
  const showLabel = (i: number) => i === n - 1 || (i % labelEvery === 0 && i <= lastSafe);

  const trend = visible.length === 1 ? trendLine(winPoints.map((p) => val(p, visible[0].key))) : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (n <= 1) return setHover(0);
    const i = Math.round(((px - PAD.l) / PW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const tip = hover != null ? winPoints[hover] : null;
  const tipLeft = hover != null ? (xAt(hover) / W) * 100 : 0;

  return (
    <div className="viz-wrap" ref={wrapRef}>
      <div className="viz-toggles" role="group" aria-label="Window">
        {windows.filter((w) => w < points.length).map((w) => (
          <button key={w} className={`viz-toggle${win === w ? " active" : ""}`} onClick={() => setWin(w)}>Last {w}</button>
        ))}
        <button className={`viz-toggle${win === "all" ? " active" : ""}`} onClick={() => setWin("all")}>All</button>
      </div>

      <svg className="viz-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={yAt(t)} y2={yAt(t)} strokeWidth={1} />
            <text className="tick" x={PAD.l - 6} y={yAt(t) + 3} textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {/* The last label ends at its point rather than centring on it: centred, a long one
            ("Oct 7 23:00") ran off the right edge. */}
        {winPoints.map((p, i) => showLabel(i) && (
          <text className="tick" key={p.x} x={xAt(i)} y={H - 8} textAnchor={i === n - 1 && n > 1 ? "end" : "middle"}>{p.label ?? p.x.slice(5)}</text>
        ))}

        {trend && (
          <line className="trend" x1={xAt(trend.x1)} y1={yAt(trend.y1)} x2={xAt(trend.x2)} y2={yAt(trend.y2)} />
        )}

        {visible.map((s) => {
          // Runs of consecutive real values become polyline segments; a gap breaks the line.
          const segments: string[][] = [];
          let run: string[] = [];
          const lone: number[] = []; // real points fenced by gaps — invisible without a dot
          winPoints.forEach((p, i) => {
            const v = val(p, s.key);
            if (v === null) {
              if (run.length) segments.push(run);
              if (run.length === 1) lone.push(i - 1);
              run = [];
            } else {
              run.push(`${xAt(i)},${yAt(v)}`);
            }
          });
          if (run.length) segments.push(run);
          if (run.length === 1) lone.push(n - 1);
          return (
            <g key={s.key}>
              {segments.filter((seg) => seg.length > 1).map((seg, j) => (
                <polyline key={j} fill="none" stroke={seriesVar(s.colorIndex)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={seg.join(" ")} />
              ))}
              {n > 30 && lone.map((i) => (
                <circle key={`lone-${i}`} cx={xAt(i)} cy={yAt(val(winPoints[i]!, s.key)!)} r={2.5} fill={seriesVar(s.colorIndex)} />
              ))}
            </g>
          );
        })}

        {/* dots only when sparse enough to read; otherwise the line carries it (isolated points
            between gaps keep a dot at any density, or they would vanish entirely). */}
        {n <= 30 && visible.map((s) => winPoints.map((p, i) => {
          const v = val(p, s.key);
          return v === null ? null : <circle key={`${s.key}-${i}`} cx={xAt(i)} cy={yAt(v)} r={3} fill={seriesVar(s.colorIndex)} />;
        }))}

        {hover != null && (
          <>
            <line className="axis" x1={xAt(hover)} x2={xAt(hover)} y1={PAD.t} y2={PAD.t + PH} strokeWidth={1} strokeDasharray="3 3" />
            {visible.map((s) => {
              const v = val(winPoints[hover]!, s.key);
              return v === null ? null : (
                <circle key={s.key} cx={xAt(hover)} cy={yAt(v)} r={4.5} fill={seriesVar(s.colorIndex)} stroke="var(--surface)" strokeWidth={2} />
              );
            })}
          </>
        )}
      </svg>

      {tip && (
        <div className="viz-tip" style={{ left: `min(${tipLeft}%, calc(100% - 130px))`, top: 40 }}>
          <div className="tt-title">{tip.label ?? tip.x}</div>
          {visible.map((s) => (
            <div className="tt-row" key={s.key}>
              <span className="k"><span className="sw" style={{ width: 8, height: 8, borderRadius: 2, display: "inline-block", background: seriesVar(s.colorIndex) }} />{s.label}</span>
              <span>{val(tip, s.key) === null ? "—" : format(val(tip, s.key)!)}</span>
            </div>
          ))}
        </div>
      )}

      {series.length > 1 && (
        <div className="viz-legend">
          {series.map((s) => (
            <span key={s.key} className={`li${off[s.key] ? " off" : ""}`} onClick={() => setOff((o) => ({ ...o, [s.key]: !o[s.key] }))} role="button" tabIndex={0}>
              <span className="sw" style={{ background: seriesVar(s.colorIndex) }} />{s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
