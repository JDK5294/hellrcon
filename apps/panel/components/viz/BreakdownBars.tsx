"use client";
/**
 * Horizontal magnitude breakdown — one row per category, bar length proportional to the largest
 * value. Every row carries a visible text label and value (the dataviz "relief rule": identity is
 * never colour-alone, which also satisfies the light-mode contrast WARN). Categorical colour is
 * assigned by fixed slot order via the series palette, so a filter that drops a row never repaints
 * the survivors.
 */
import { seriesVar } from "./palette";

export interface BreakdownDatum {
  key: string;
  label?: string;
  value: number;
  colorIndex?: number;
  /** What to PRINT, when the raw number isn't the readable form — durations in particular, where
   *  the bar wants seconds for its length but the reader wants "1h 40m", not "6,000". */
  valueLabel?: string;
}

export function BreakdownBars({ data, empty = "No activity yet." }: { data: BreakdownDatum[]; empty?: string }) {
  const rows = data.filter((d) => d.value > 0);
  if (!rows.length) return <p className="muted">{empty}</p>;
  const max = Math.max(...rows.map((d) => d.value));
  return (
    <div className="breakdown">
      {rows.map((d, i) => (
        <div className="breakdown-row" key={d.key}>
          <span className="bl-label">{d.label ?? d.key}</span>
          <span className="breakdown-track">
            <span className="breakdown-fill" style={{ width: `${(d.value / max) * 100}%`, background: seriesVar(d.colorIndex ?? i) }} />
          </span>
          <span className="bl-val">{d.valueLabel ?? d.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
