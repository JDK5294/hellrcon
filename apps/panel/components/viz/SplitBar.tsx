"use client";
/**
 * One bar cut into parts — a composition, where the whole is the point and the parts are shares
 * of it: new versus returning players, wins by side, actions by category.
 *
 * A pie would be the obvious alternative and is worse: judging angle is harder than judging
 * length, and comparing two pies side by side is nearly impossible. One bar compares against
 * itself and stacks fine against another below it.
 *
 * Segments carry a 2px surface gap so adjoining fills never read as one block, and every segment
 * is named in the legend with its number — identity is never colour alone.
 */
import { useId } from "react";
import { seriesVar } from "./palette";

export interface Slice { key: string; label: string; value: number; colorIndex?: number }

export function SplitBar({ slices, format = (n: number) => n.toLocaleString(), empty = "Nothing to split yet." }: {
  slices: Slice[]; format?: (n: number) => string; empty?: string;
}) {
  const titleId = useId();
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((n, s) => n + s.value, 0);
  if (!total) return <p className="nothing">{empty}</p>;

  return (
    <div className="split">
      <div className="split-bar" role="img" aria-labelledby={titleId}>
        <span id={titleId} className="sr-only">
          {shown.map((s) => `${s.label}: ${format(s.value)} (${Math.round((s.value / total) * 100)}%)`).join(", ")}
        </span>
        {shown.map((s, i) => (
          <span
            key={s.key}
            className="split-seg"
            style={{ width: `${(s.value / total) * 100}%`, background: seriesVar(s.colorIndex ?? i) }}
            title={`${s.label}: ${format(s.value)}`}
          />
        ))}
      </div>
      <ul className="split-legend">
        {shown.map((s, i) => (
          <li key={s.key}>
            <span className="split-dot" style={{ background: seriesVar(s.colorIndex ?? i) }} aria-hidden />
            <span className="split-label">{s.label}</span>
            <span className="split-val">{format(s.value)}</span>
            <span className="muted fs-xs">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
