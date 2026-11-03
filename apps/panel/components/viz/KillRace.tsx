"use client";
/**
 * The whole round as one race: every player's cumulative-kill step line on a single large chart.
 * A full server is 100 players, so this is built for a crowd, not for six lines. When the round has
 * scores, a switch races each of them (combat, offense, defense, support) the same way, off the
 * score points the players' own charts draw.
 *
 * A hundred lines can't carry a hundred colours, so identity works in layers instead. Colour says
 * only the SIDE (two hues, named once in the legend — the same two the whole page wears). The
 * leaders are labelled at the end of their line with their count. Hovering lights up the nearest
 * line and dims the rest, which is what makes a single player legible inside the mat at the bottom;
 * clicking keeps it lit so you can look away. And because "which line is mine?" is unanswerable by
 * eye at this density, the search box lights up everyone whose name matches and labels them too,
 * while the legend chips isolate one side to halve the crowd.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { seriesVar } from "./palette";
import { isText, isTextOrNull, useRemembered } from "../../lib/remembered";
import type { TimelineTuple } from "./PlayerTimeline";
import { isChartView, type ScoreTuple } from "./PlayerRoundCharts";

export interface RacePlayer {
  /** Whatever identifies this player to the page — an internal id on the staff match page, the
   *  display name on the public one. Two people can wear the same NAME in a round, so the lines
   *  are keyed by this, never by the label they carry. */
  id: string;
  name: string;
  side: "allies" | "axis" | null;
  timeline: TimelineTuple[];
  /** The report's score points, when the round has them. */
  scores?: ScoreTuple[] | null;
}

/** Rendered width below which the canvas is re-cut for a phone (fewer viewBox units = bigger text). */
const NARROW_PX = 560;
/** vertical room one end label needs, in viewBox units. */
const LABEL_H = 13;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const n1 = (v: number) => Math.round(v * 10) / 10;

/** Rendered width of an element, so the chart can re-cut itself for narrow screens. */
function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function KillRace({ players, roundSecs, sides, scoreFields = [], remember }: {
  players: RacePlayer[];
  roundSecs: number | null;
  /** [allies-style, axis-style] — label + palette slot, from the page's own side mapping. */
  sides: { id: string; label: string; colorIndex: number }[];
  /** The game's score columns in the score points' order (combat, offense, defense, support). Each
   *  gets a tab when the round has scores; a round without them races kills alone, as before. */
  scoreFields?: { label: string; title?: string }[];
  /** A name to keep the race's view, search, side and lit line under for the sitting; none keeps nothing. */
  remember?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const narrow = width !== null && width < NARROW_PX;

  const [hover, setHover] = useState<{ id: string; secs: number } | null>(null);
  const [pinned, setPinned] = useRemembered<string | null>(remember ? `${remember}.pinned` : null, null, isTextOrNull, "session");
  const [query, setQuery] = useRemembered(remember ? `${remember}.query` : null, "", isText, "session");
  const [onlySide, setOnlySide] = useRemembered<string | null>(remember ? `${remember}.side` : null, null, isTextOrNull, "session");
  const [view, setView] = useRemembered<"kills" | number>(remember ? `${remember}.view` : null, "kills", isChartView, "session");

  const fields = players.some((p) => p.scores?.length) ? scoreFields.slice(0, 4) : [];
  const metric = typeof view === "number" && view < fields.length ? view : "kills";
  const field = metric === "kills" ? undefined : fields[metric];
  // What the lines count, in words: "kills", "combat score".
  const noun = field ? (field.title ?? field.label).toLowerCase() : "kills";

  // Everything that depends only on the data and the canvas size, including the path strings —
  // 100 players × 50 kills is far too much string-building to redo on every mouse move.
  const chart = useMemo(() => {
    const racers = players
      .map((p) => {
        // Each line as steps: at ts[i] the player's total becomes vs[i]. Deaths don't move the
        // kills race; only kills step it up. A score steps to each point's total.
        let ts: number[], vs: number[];
        if (metric === "kills") {
          ts = p.timeline.filter((t) => t[1] === "k").map((t) => t[0]).sort((a, b) => a - b);
          vs = ts.map((_, i) => i + 1);
        } else {
          const points = [...(p.scores ?? [])].sort((a, b) => a[0] - b[0]);
          ts = points.map((q) => q[0]);
          vs = points.map((q) => q[metric + 1] ?? 0);
        }
        return { id: p.id, name: p.name, side: p.side as string | null, ts, vs, total: vs.length ? vs[vs.length - 1]! : 0 };
      })
      .filter((p) => p.total > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    let maxK = 1, lastTs = 0;
    for (const p of racers) {
      for (const v of p.vs) if (v > maxK) maxK = v;
      lastTs = Math.max(lastTs, p.ts[p.ts.length - 1]!);
    }
    // Room for the widest number on the axis and at the end of a label: a score runs to four
    // digits where kills run to two.
    const digits = String(maxK).length;
    const W = narrow ? 460 : 720;
    // A crowd needs vertical room: the bottom of a 100-player round is a mat of low scores.
    const H = narrow ? 460 : racers.length > 45 ? 500 : racers.length > 18 ? 420 : 340;
    const PAD = {
      l: Math.max(narrow ? 26 : 34, Math.ceil(digits * 5.6 + 8)),
      r: (narrow ? 96 : 122) + Math.max(0, digits - 2) * 7,
      t: 12, b: 22,
    };
    const PW = W - PAD.l - PAD.r, PH = H - PAD.t - PAD.b;
    const endSecs = Math.max(roundSecs ?? 0, lastTs + 30, 60);
    const xAt = (s: number) => PAD.l + (s / endSecs) * PW;
    const yAt = (k: number) => PAD.t + PH - (k / maxK) * PH;

    const paths = new Map<string, string>();
    for (const p of racers) {
      let d = `M ${n1(xAt(0))} ${n1(yAt(0))}`;
      let level = 0;
      for (let i = 0; i < p.ts.length; i++) {
        const x = n1(xAt(p.ts[i]!));
        d += ` L ${x} ${n1(yAt(level))} L ${x} ${n1(yAt(p.vs[i]!))}`;
        level = p.vs[i]!;
      }
      paths.set(p.id, `${d} L ${n1(xAt(endSecs))} ${n1(yAt(level))}`);
    }

    const endMin = Math.ceil(endSecs / 60);
    const stepMin = [1, 2, 5, 10, 15, 30, 60].find((s) => endMin / s <= (narrow ? 5 : 7)) ?? 120;
    const marks: number[] = [];
    for (let m = 0; m * stepMin <= endMin; m++) marks.push(m * stepMin);

    // Enough gridlines to read a value out of the crowd, not so many they become the picture.
    const gridK = maxK >= 12 ? [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxK * f)) : [0, maxK];
    return { racers, W, H, PAD, PW, PH, maxK, endSecs, xAt, yAt, paths, marks, gridK: [...new Set(gridK)] };
  }, [players, roundSecs, narrow, metric]);

  const { racers, W, H, PAD, PW, PH, maxK, endSecs, xAt, yAt, paths, marks, gridK } = chart;

  /** A racer's total at `secs`: the last step at or before it, 0 before the first. */
  const valueAt = useCallback((p: { ts: number[]; vs: number[] }, secs: number) => {
    let lo = 0, hi = p.ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (p.ts[mid]! <= secs) lo = mid + 1; else hi = mid; }
    return lo === 0 ? 0 : p.vs[lo - 1]!;
  }, []);

  /** The nearest line to the pointer: whoever's running total at this x sits closest to this y. */
  const nearest = useCallback((e: React.PointerEvent<SVGSVGElement>, pool: typeof racers) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const sy = ((e.clientY - rect.top) / rect.height) * H;
    const secs = Math.max(0, Math.min(endSecs, ((sx - PAD.l) / PW) * endSecs));
    let best: string | null = null, bestDist = Infinity;
    for (const p of pool) {
      const d = Math.abs(yAt(valueAt(p, secs)) - sy);
      if (d < bestDist) { bestDist = d; best = p.id; }
    }
    return { id: bestDist <= PH * 0.09 ? best : null, secs };
  }, [W, H, PW, PH, PAD.l, endSecs, yAt, valueAt]);

  // The switch: the scoreboard's own column labels, as on each player's own charts.
  const tabs = fields.length > 0 && (
    <div className="seg" role="group" aria-label="Race" style={{ marginBottom: 8 }}>
      <button type="button" className={`seg-btn ${metric === "kills" ? "active" : ""}`} aria-pressed={metric === "kills"}
        onClick={() => setView("kills")}>Kills</button>
      {fields.map((f, i) => (
        <button key={f.label} type="button" className={`seg-btn ${metric === i ? "active" : ""}`} aria-pressed={metric === i}
          title={f.title} onClick={() => setView(i)}>{f.label}</button>
      ))}
    </div>
  );

  if (racers.length < 2) {
    return <>{tabs}<p className="muted fs-sm">{metric === "kills" ? "Not enough players with kills to race." : `Not enough players with a ${noun} to race.`}</p></>;
  }

  const shown = onlySide ? racers.filter((p) => p.side === onlySide) : racers;
  const q = query.trim().toLowerCase();
  const found = q ? shown.filter((p) => p.name.toLowerCase().includes(q)) : [];
  const foundIds = new Set(found.map((p) => p.id));
  const focus = (hover && shown.some((p) => p.id === hover.id) ? hover.id : null)
    ?? (pinned && shown.some((p) => p.id === pinned) ? pinned : null);
  const focused = focus ? shown.find((p) => p.id === focus) ?? null : null;
  const quiet = focus !== null || q !== "";

  const colorOf = (side: string | null) => seriesVar(sides.find((s) => s.id === side)?.colorIndex ?? 2);

  // End labels: the leaders always, plus anyone the search turned up and whoever is picked out —
  // that is the whole answer to "which line is mine". Sorted by height, then nudged apart. A long
  // total leaves less room for the name beside it.
  const wanted = new Map<string, typeof shown[number]>();
  for (const p of shown.slice(0, narrow ? 4 : 6)) wanted.set(p.id, p);
  for (const p of found.slice(0, 8)) wanted.set(p.id, p);
  if (focused) wanted.set(focused.id, focused);
  const cut = (narrow ? 11 : 15) - Math.max(0, String(maxK).length - 2);
  const labels = [...wanted.values()]
    .map((p) => ({ id: p.id, name: p.name.length > cut ? `${p.name.slice(0, cut - 1)}…` : p.name, side: p.side, total: p.total, y: yAt(p.total) }))
    .sort((a, b) => a.y - b.y);
  let lastY = -Infinity;
  for (const l of labels) { l.y = Math.max(l.y, lastY + LABEL_H); lastY = l.y; }
  const spill = lastY - (PAD.t + PH);
  if (spill > 0) for (const l of labels) l.y = Math.max(PAD.t, l.y - spill);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const near = nearest(e, shown);
    setHover(near.id ? { id: near.id, secs: near.secs } : null);
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const near = nearest(e, shown);
    setPinned((cur) => (near.id && near.id !== cur ? near.id : null));
    setHover(near.id ? { id: near.id, secs: near.secs } : null);
  };

  const live = hover?.id === focus ? hover : null;
  const tipValue = focused ? (live ? valueAt(focused, live.secs) : focused.total) : 0;
  const rank = focused ? shown.findIndex((p) => p.id === focused.id) + 1 : 0;
  // Players who finished on nought have no line to draw; say so rather than quietly losing them.
  const drawn = new Set(racers.map((r) => r.id));
  const silent = players.filter((p) => !drawn.has(p.id) && (!onlySide || p.side === onlySide)).length;

  return (
    <div className="viz-wrap" ref={wrap}>
      {tabs}
      <div className="race-head">
        <div className="race-sides">
          {sides.map((s) => (
            <button key={s.id} type="button" className={`race-chip${onlySide === s.id ? " on" : ""}${onlySide && onlySide !== s.id ? " dim" : ""}`}
              aria-pressed={onlySide === s.id} onClick={() => setOnlySide((cur) => (cur === s.id ? null : s.id))}>
              <span className="ss-sw" style={{ background: seriesVar(s.colorIndex) }} />{s.label}
            </button>
          ))}
        </div>
        <input type="search" className="race-find" value={query} placeholder="Find a player…"
          aria-label="Find a player in the kill race" onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="race-plot">
        <svg className="viz-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`Every player's ${noun} over the round`}
          onPointerMove={onMove} onPointerDown={onDown} onPointerLeave={() => setHover(null)}>
          {gridK.map((k) => (
            <g key={k}>
              <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={yAt(k)} y2={yAt(k)} strokeWidth={1} />
              <text className="tick" x={PAD.l - 6} y={yAt(k) + 3} textAnchor="end">{k}</text>
            </g>
          ))}
          {marks.map((m) => (
            <text className="tick" key={m} x={xAt(Math.min(m * 60, endSecs))} y={H - 8} textAnchor="middle">{m}m</text>
          ))}
          {shown.map((p) => p.id !== focus && !foundIds.has(p.id) && (
            <path key={p.id} d={paths.get(p.id)} fill="none" stroke={colorOf(p.side)}
              strokeWidth={1.4} strokeOpacity={quiet ? 0.1 : 0.42} strokeLinejoin="round" />
          ))}
          {found.map((p) => p.id !== focus && (
            <path key={p.id} d={paths.get(p.id)} fill="none" stroke={colorOf(p.side)}
              strokeWidth={2} strokeOpacity={0.9} strokeLinejoin="round" />
          ))}
          {focused && (
            <path d={paths.get(focused.id)} fill="none" stroke={colorOf(focused.side)} strokeWidth={2.6} strokeLinejoin="round" />
          )}
          {labels.map((l) => (
            <text key={l.id} className="race-label" x={W - PAD.r + 5} y={l.y + 3} fill={colorOf(l.side)}>
              {l.name} · {l.total}
            </text>
          ))}
          {focused && live && (
            <line className="axis" x1={xAt(live.secs)} x2={xAt(live.secs)} y1={PAD.t} y2={PAD.t + PH} strokeWidth={1} strokeDasharray="3 3" />
          )}
        </svg>
        {focused && (
          // Parked beside the point it describes, and kept clear of the end labels on the right.
          <div className="viz-tip" style={{
            left: `min(${(xAt(live ? live.secs : endSecs) / W) * 100}%, calc(${((W - PAD.r) / W) * 100}% - 152px))`,
            top: `clamp(0px, ${(yAt(tipValue) / H) * 100}%, calc(100% - 82px))`,
          }}>
            <div className="tt-title">{focused.name}</div>
            {live && (
              <div className="tt-row"><span className="k">{clock(live.secs)}</span>
                <span>{metric === "kills" ? `${tipValue} kill${tipValue === 1 ? "" : "s"}` : `${tipValue} ${noun}`}</span></div>
            )}
            <div className="tt-row"><span className="k">Round total</span><span>{focused.total}</span></div>
            <div className="tt-row"><span className="k">Finished</span><span>#{rank} of {shown.length}</span></div>
          </div>
        )}
      </div>
      <p className="race-note muted fs-sm">
        {q ? (found.length === 0 ? `Nobody here matches “${query.trim()}” · ` : `${found.length} lit for “${query.trim()}” · `) : null}
        {shown.length} line{shown.length === 1 ? "" : "s"}
        {onlySide ? ` on ${sides.find((s) => s.id === onlySide)?.label ?? "this side"}` : ""}
        {silent > 0 ? ` · ${silent} player${silent === 1 ? "" : "s"} finished with no ${noun} and can't be drawn` : ""}
        {pinned ? " · click the line again to let it go" : " · click a line to keep it lit"}
      </p>
    </div>
  );
}
