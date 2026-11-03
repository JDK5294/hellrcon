"use client";
/**
 * A compact two-sided comparison: one row per item, each side's count printed beside a mirrored
 * bar meeting in the middle. Built to replace stacks of one-bar-per-item splits, which buried a
 * dozen rows of data under a dozen repeated legends — here the sides are named ONCE in the
 * header and twelve rows read in a glance. Identity is never colour alone: both headers carry
 * the side's name, and every value is printed as a number.
 *
 * Bars share one scale (the largest single-side value), so lengths compare across rows too —
 * a half-length bar is half the kills, whichever row it sits on.
 */
import { seriesVar } from "./palette";

export interface SideRow { label: string; left: number; right: number }

export function SideSplit({ rows, left, right }: {
  rows: SideRow[];
  left: { label: string; colorIndex: number };
  right: { label: string; colorIndex: number };
}) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.flatMap((r) => [r.left, r.right]));
  return (
    <div className="side-split">
      <div className="ss-head">
        <span className="ss-side"><span className="ss-sw" style={{ background: seriesVar(left.colorIndex) }} />{left.label}</span>
        <span className="ss-side"><span className="ss-sw" style={{ background: seriesVar(right.colorIndex) }} />{right.label}</span>
      </div>
      {rows.map((r) => (
        <div className="ss-row" key={r.label}>
          <span className="ss-label" title={r.label}>{r.label}</span>
          <span className="ss-num">{r.left.toLocaleString()}</span>
          <div className="ss-bars" aria-hidden>
            <div className="ss-half">
              <div className="ss-fill" style={{ width: `${(r.left / max) * 100}%`, background: seriesVar(left.colorIndex) }} />
            </div>
            <div className="ss-half">
              <div className="ss-fill" style={{ width: `${(r.right / max) * 100}%`, background: seriesVar(right.colorIndex) }} />
            </div>
          </div>
          <span className="ss-num">{r.right.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
