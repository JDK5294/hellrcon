"use client";
/**
 * A column chart for a single measure across a known set of buckets — sessions per hour of the
 * day, rounds per map, actions per weekday.
 *
 * Deliberately one series on one axis. Two measures of different scale go in two charts, never in
 * one with two y-axes: a dual axis lets the author decide which line looks higher, which is a
 * decision the reader should be making.
 *
 * Inline SVG because the panel is a static export with no chart libraries, and because a table
 * fallback then costs nothing — the same numbers are always available to a screen reader.
 */
import { useId, useState } from "react";
import { seriesVar } from "./palette";

export interface Bar { label: string; value: number; /** longer text for the tooltip */ hint?: string }

const H = 150, PAD = { t: 10, b: 22, l: 34, r: 6 };
/** Rough width of one axis character in viewBox units — enough to size and clip labels by. */
const CHAR_W = 6.5;

/** Cut a label to what its slot can actually hold. The full text is always in the hover tip, so
 *  nothing is lost; an axis of overlapping words loses everything. */
function fit(label: string, width: number): string {
  const chars = Math.floor(width / CHAR_W);
  return label.length <= chars ? label : `${label.slice(0, Math.max(1, chars - 1))}…`;
}

export function Bars({ data, colorIndex = 0, format = (n: number) => n.toLocaleString(), highlightMax = true, empty = "No data yet." }: {
  data: Bar[];
  colorIndex?: number;
  format?: (n: number) => string;
  /** Emphasise the tallest bar — the peak is usually the reason you opened the chart. */
  highlightMax?: boolean;
  empty?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  if (!data.length) return <p className="nothing">{empty}</p>;

  const max = Math.max(...data.map((d) => d.value), 1);
  const peak = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  // Buckets are sized for their LABELS, not just their count. Hour-of-day ticks ("07") need almost
  // nothing; role names ("Automatic rifleman") need real room, and at the old fixed 26px they ran
  // into each other and the axis read as one long word. Capped, because past a point a wider
  // viewBox only scales the whole chart down and the text is no more legible for it.
  const longest = data.reduce((n, d) => Math.max(n, d.label.length), 0);
  const slot = Math.max(26, Math.min(longest * CHAR_W, 90));
  const W = Math.max(data.length * slot, 320);
  const pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b;
  const bw = pw / data.length;
  // Three gridlines is enough to read a height off; more is chartjunk.
  const ticks = [0, max / 2, max];

  return (
    <div className="viz-wrap viz-scroll">
      {/* An inline SVG scales by aspect ratio, so on a phone a wide chart is squeezed until its
          axis is 4px tall — legible on the desktop it was checked on, useless in the hand. Below
          its natural width it scrolls sideways in its own box instead, which is what the tables
          already do. */}
      {/* And a ceiling for the same reason, from the other side. `slot` above is the width each
          bucket NEEDS; a container three times that does not show more, it just draws the same
          bars fatter, until twenty-four hour columns are 40px slabs a foot tall. Half again over
          natural is enough to feel like it is using the room without turning a chart into
          wallpaper. */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: W * 0.6, maxWidth: W * 1.5 }} className="viz-svg viz-bars" role="img" aria-labelledby={titleId}>
        <title id={titleId}>Column chart, {data.length} buckets, highest {format(max)}</title>
        {ticks.map((t, i) => {
          const y = PAD.t + ph - (t / max) * ph;
          return (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} className="viz-grid" />
              <text x={PAD.l - 5} y={y + 3} className="viz-axis" textAnchor="end">{format(Math.round(t))}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.value / max) * ph;
          const x = PAD.l + i * bw;
          // A bar is capped in width: with two or three categories the proportional width alone
          // produces a single slab as wide as the card, which reads as a design accident rather
          // than a value.
          const w = Math.min(bw * 0.64, 64);
          const bx = x + (bw - w) / 2;
          const on = hover === i;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* A full-height hit target: aiming at a 2px-tall bar is not a fair ask. */}
              <rect x={x} y={PAD.t} width={bw} height={ph} fill="transparent" />
              <rect
                x={bx} y={PAD.t + ph - h} width={w} height={Math.max(h, d.value > 0 ? 2 : 0)}
                rx={3} fill={seriesVar(colorIndex)}
                opacity={on ? 1 : highlightMax && i === peak ? 0.95 : 0.62}
              />
            </g>
          );
        })}
        {/* Clipped to the slot, and every other one when the slots are too narrow to bother — 24
            hour ticks don't fit at this width. */}
        {data.map((d, i) => (
          (bw >= 20 || i % 2 === 0) && (
            <text key={i} x={PAD.l + i * bw + bw / 2} y={H - 7} className="viz-axis" textAnchor="middle">{fit(d.label, bw)}</text>
          )
        ))}
      </svg>
      {hover !== null && data[hover] && (
        <div className="viz-tip" role="status">
          <strong>{data[hover]!.label}</strong> · {format(data[hover]!.value)}
          {data[hover]!.hint ? <span className="muted"> · {data[hover]!.hint}</span> : null}
        </div>
      )}
    </div>
  );
}
