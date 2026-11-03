"use client";
/**
 * One player's round as a picture: a step line that climbs with each kill, an ✕ at each death, a
 * △ at each team kill (which is not a kill, so the line stays put), and a hover that names the
 * moment — who, what weapon, which kill it was. The line wears the player's side colour (the match
 * pages' page-wide rule), deaths and team kills wear a shape, so none of them is colour-alone.
 * Shared by the staff match drill-in and the public stats site's round pages — one drawing, so the
 * two can never disagree about a round.
 */
import { useMemo, useState } from "react";
import { seriesVar } from "./palette";

/** [seconds since kickoff, kill / death / team kill, the other player, weapon] — the wire's
 *  timeline tuple. Only a "k" is a kill. */
export type TimelineTuple = [number, "k" | "d" | "t", string | null, string | null];

/** "12:34" — where in the round something happened. Minutes can pass 60 on a long offensive. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const TL = { W: 720, H: 130, l: 34, r: 12, t: 12, b: 22 };
const TL_PW = TL.W - TL.l - TL.r, TL_PH = TL.H - TL.t - TL.b;

export function PlayerTimeline({ events, roundSecs, colorIndex }: { events: TimelineTuple[]; roundSecs: number | null; colorIndex: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // Server order is already chronological; sorting again costs nothing and trusts nobody.
  const ordered = useMemo(() => [...events].sort((a, b) => a[0] - b[0]), [events]);
  // Kills-so-far at each event — the step line's height there, and the death markers' resting line.
  const cum = useMemo(() => { let k = 0; return ordered.map((e) => (e[1] === "k" ? ++k : k)); }, [ordered]);

  if (ordered.length === 0) return <p className="muted fs-sm">No kills or deaths recorded.</p>;

  const totalKills = cum[cum.length - 1] ?? 0;
  const maxK = Math.max(1, totalKills);
  const lastTs = ordered[ordered.length - 1]![0];
  // The axis runs the whole round when we know its length — a player who died at minute 3 and
  // left should read as absent for the rest, not stretched across the page.
  const endSecs = Math.max(roundSecs ?? 0, lastTs + 30, 60);
  const xAt = (s: number) => TL.l + (s / endSecs) * TL_PW;
  const yAt = (k: number) => TL.t + TL_PH - (k / maxK) * TL_PH;

  let path = `M ${xAt(0)} ${yAt(0)}`;
  let level = 0;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]![1] !== "k") continue;
    const x = xAt(ordered[i]![0]);
    path += ` L ${x} ${yAt(level)} L ${x} ${yAt(cum[i]!)}`;
    level = cum[i]!;
  }
  path += ` L ${xAt(endSecs)} ${yAt(level)}`;

  // x labels every 1/2/5/10/15/30/60 minutes — whichever keeps the axis at ≤ 7 marks.
  const endMin = Math.ceil(endSecs / 60);
  const stepMin = [1, 2, 5, 10, 15, 30, 60].find((s) => endMin / s <= 7) ?? 120;
  const marks: number[] = [];
  for (let m = 0; m * stepMin <= endMin; m++) marks.push(m * stepMin);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const s = (((e.clientX - rect.left) / rect.width) * TL.W - TL.l) / TL_PW * endSecs;
    let best = 0;
    for (let i = 1; i < ordered.length; i++) if (Math.abs(ordered[i]![0] - s) < Math.abs(ordered[best]![0] - s)) best = i;
    setHover(best);
  };

  const tip = hover != null ? ordered[hover] : null;
  const tipLeft = tip ? (xAt(tip[0]) / TL.W) * 100 : 0;

  return (
    <div className="viz-wrap">
      <svg className="viz-chart" viewBox={`0 0 ${TL.W} ${TL.H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Kills over the round">
        {(maxK >= 8 ? [0, Math.round(maxK / 2), maxK] : [0, maxK]).map((k) => (
          <g key={k}>
            <line className="grid" x1={TL.l} x2={TL.W - TL.r} y1={yAt(k)} y2={yAt(k)} strokeWidth={1} />
            <text className="tick" x={TL.l - 6} y={yAt(k) + 3} textAnchor="end">{k}</text>
          </g>
        ))}
        {marks.map((m) => (
          <text className="tick" key={m} x={xAt(Math.min(m * 60, endSecs))} y={TL.H - 8} textAnchor="middle">{m}m</text>
        ))}
        <path d={path} fill="none" stroke={seriesVar(colorIndex)} strokeWidth={2} strokeLinejoin="round" />
        {ordered.map((e, i) => e[1] === "d" && (
          <g className="tl-death" key={i}>
            <line x1={xAt(e[0]) - 4} y1={yAt(cum[i]!) - 4} x2={xAt(e[0]) + 4} y2={yAt(cum[i]!) + 4} />
            <line x1={xAt(e[0]) - 4} y1={yAt(cum[i]!) + 4} x2={xAt(e[0]) + 4} y2={yAt(cum[i]!) - 4} />
          </g>
        ))}
        {ordered.map((e, i) => e[1] === "t" && (
          <path className="tl-tk" key={`t${i}`}
            d={`M ${xAt(e[0])} ${yAt(cum[i]!) - 5} L ${xAt(e[0]) + 5} ${yAt(cum[i]!) + 4} L ${xAt(e[0]) - 5} ${yAt(cum[i]!) + 4} Z`} />
        ))}
        {tip && hover != null && (
          <>
            <line className="axis" x1={xAt(tip[0])} x2={xAt(tip[0])} y1={TL.t} y2={TL.t + TL_PH} strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={xAt(tip[0])} cy={yAt(cum[hover]!)} r={4.5} fill={tip[1] === "k" ? seriesVar(colorIndex) : tip[1] === "t" ? "var(--tone-tk)" : "var(--muted)"} stroke="var(--surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      {tip && hover != null && (
        <div className="viz-tip" style={{ left: `min(${tipLeft}%, calc(100% - 150px))`, top: 8 }}>
          <div className="tt-title">{clock(tip[0])} · {tip[1] === "k" ? `kill #${cum[hover]}` : tip[1] === "t" ? "team kill" : "death"}</div>
          <div className="tt-row"><span className="k">{tip[1] === "k" ? "Killed" : tip[1] === "t" ? "Team-killed" : "Died to"}</span><span>{tip[2] ?? "?"}</span></div>
          {tip[3] && <div className="tt-row"><span className="k">Weapon</span><span>{tip[3]}</span></div>}
        </div>
      )}
    </div>
  );
}
