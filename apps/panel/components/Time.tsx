"use client";
/**
 * A timestamp cell: relative text ("3 min ago"), the exact instant on hover — or on a tap, which
 * swaps the text for the exact date and time until the next tap. Phones have no hover, so the
 * tooltip alone never reached them. The tap is the timestamp's own: a row or button it sits in does
 * not also act on it.
 *
 * Two things this deliberately does NOT do. It doesn't call Date.now() while rendering — the clock
 * is read in an effect and passed in, so rendering stays pure and predictable. And it doesn't run
 * its own timer: a busy table can hold hundreds of these, and hundreds of intervals to re-render
 * "5 min ago" would be absurd. They all subscribe to one shared clock that ticks every 30 seconds,
 * so a page left open stays honest for the cost of a single interval.
 */
import { useEffect, useState } from "react";
import { fmtExact, fmtRelative } from "../lib/time";

// ---- one clock for every timestamp on the page ----
const subscribers = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: (now: number) => void): () => void {
  subscribers.add(fn);
  if (!timer) timer = setInterval(() => { const n = Date.now(); subscribers.forEach((s) => s(n)); }, 30_000);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

export function Time({ iso, className }: { iso?: string | null; className?: string }) {
  // 0 until the first effect runs: the relative text needs a clock reading, and reading one during
  // render is exactly the impurity we're avoiding. One frame without text costs nothing — the row
  // height comes from padding, so nothing shifts.
  const [now, setNow] = useState(0);
  const [exact, setExact] = useState(false);
  useEffect(() => {
    setNow(Date.now());
    return subscribe(setNow);
  }, []);
  if (!iso) return null;
  const relative = now ? fmtRelative(iso, now) : "";
  return (
    // The tooltip is whichever form is not on screen.
    <time className={className} dateTime={iso} title={exact ? relative : fmtExact(iso)}
      onClick={(e) => { e.stopPropagation(); setExact((v) => !v); }}>
      {exact ? fmtExact(iso) : relative}
    </time>
  );
}
