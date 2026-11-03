"use client";
/**
 * Week × hour grid — the right shape for "when does this happen", because the two things that
 * drive server activity (which day, what time) are exactly its two axes. Reading the same data as
 * 168 bars would show the total and hide the pattern.
 *
 * Magnitude, so the colour is SEQUENTIAL: one hue, light to dark. Never a rainbow — a rainbow
 * implies categories where there is only "more" and "less", and its bands invent boundaries the
 * data doesn't have.
 */
import { useId, useState } from "react";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Heatmap({ grid, format = (n: number) => n.toLocaleString(), label = "events", empty = "Nothing recorded in this window yet." }: {
  /** [day 0=Sunday][hour 0–23] — counts. */
  grid: number[][];
  format?: (n: number) => string;
  label?: string;
  empty?: string;
}) {
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const titleId = useId();
  const max = Math.max(1, ...grid.flat());
  const total = grid.flat().reduce((a, b) => a + b, 0);
  if (!total) return <p className="nothing">{empty}</p>;

  const CELL = 15, GAP = 2, LEFT = 30, TOP = 14;
  const W = LEFT + 24 * (CELL + GAP), H = TOP + 7 * (CELL + GAP) + 12;
  /*
   * A `viewBox` with `width: 100%` scales the whole drawing to its container, and this chart's
   * geometry is fixed cells rather than a continuous line — so a wider container does not show
   * more, it just draws the same 168 squares bigger. On a desktop column that meant 50px slabs
   * with the day names blown up to headline size: still legible, but no longer a heatmap.
   *
   * Capped so a cell lands around 24px — comfortably clickable, still small enough that the eye
   * takes the week in as one shape, which is the entire reason to draw it this way. The Radar
   * beside it has always done the same; a time series has no such limit and keeps every pixel,
   * because there the extra width really does resolve more detail.
   */
  const MAX_CELL = 24;
  const maxWidth = Math.round(W * (MAX_CELL / CELL));

  return (
    <div className="viz-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="viz-svg" style={{ maxWidth }} role="img" aria-labelledby={titleId}>
        <title id={titleId}>Activity by day of week and hour of day. Busiest cell: {format(max)} {label}.</title>
        {[0, 6, 12, 18, 23].map((h) => (
          <text key={h} x={LEFT + h * (CELL + GAP) + CELL / 2} y={10} className="viz-axis" textAnchor="middle">{h}</text>
        ))}
        {DOW.map((name, d) => (
          <text key={name} x={LEFT - 6} y={TOP + d * (CELL + GAP) + CELL - 3} className="viz-axis" textAnchor="end">{name}</text>
        ))}
        {grid.map((row, d) => row.map((v, h) => {
          const on = hover?.d === d && hover?.h === h;
          // Opacity IS the ramp: one hue over the card, so it reads light→dark in both themes
          // without needing a second validated colour scale.
          const t = v === 0 ? 0 : 0.12 + (v / max) * 0.88;
          return (
            <rect
              key={h} x={LEFT + h * (CELL + GAP)} y={TOP + d * (CELL + GAP)} width={CELL} height={CELL} rx={3}
              className={`hm-cell${on ? " on" : ""}`} style={{ opacity: v === 0 ? 1 : undefined, fillOpacity: t }}
              onMouseEnter={() => setHover({ d, h })} onMouseLeave={() => setHover(null)}
            />
          );
        }))}
      </svg>
      {/* The scale in NUMBERS. "less → more" told a reader the direction and nothing else — what
          does the third shade MEAN? Each swatch now carries the count it stands for: a blank
          square for zero (the cells really are blank at zero), then the ramp sampled at quarters
          of the busiest cell, ending on the busiest itself, with the unit spelled out after.
          Duplicate labels collapse when the busiest is small. Exact per-cell numbers stay one
          hover/tap away. */}
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
      {hover && (
        <div className="viz-tip" role="status">
          <strong>{DOW[hover.d]} {String(hover.h).padStart(2, "0")}:00</strong> · {format(grid[hover.d]?.[hover.h] ?? 0)} {label}
        </div>
      )}
    </div>
  );
}
