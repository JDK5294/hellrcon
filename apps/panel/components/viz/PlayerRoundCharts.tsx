"use client";
/**
 * A player's round as charts: their kills (PlayerTimeline) and each score the game keeps for them
 * (combat, offense, defense, support), one at a time behind a switch. The switch's labels are the
 * scoreboard's own column labels, so a reader can find the column a chart belongs to. Rounds played
 * before the score recorder existed have no scores, and show the kills chart alone as before.
 * Shared by the staff match drill-in and the public stats site's round pages, like PlayerTimeline.
 */
import { useMemo, useState } from "react";
import { isCount, useRemembered } from "../../lib/remembered";
import { seriesVar } from "./palette";
import { PlayerTimeline, type TimelineTuple } from "./PlayerTimeline";

/** [seconds since kickoff, combat, offense, defense, support]: the report's score points. Each
 *  total holds until the next point. */
export type ScoreTuple = [number, number, number, number, number];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const TL = { W: 720, H: 130, l: 34, r: 12, t: 12, b: 22 };
const TL_PW = TL.W - TL.l - TL.r, TL_PH = TL.H - TL.t - TL.b;

/** One score through the round: a step line that rises as the total does, and a hover that reads
 *  the total at any point. */
export function ScoreTimeline({ points, roundSecs, colorIndex, label }: {
  /** [seconds since kickoff, total], in any order. */
  points: [number, number][];
  roundSecs: number | null;
  colorIndex: number;
  /** The score's name, e.g. "Combat score". */
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ordered = useMemo(() => [...points].sort((a, b) => a[0] - b[0]), [points]);
  if (ordered.length === 0) return <p className="muted fs-sm">Nothing recorded.</p>;

  const maxV = Math.max(1, ...ordered.map((p) => p[1]));
  const lastTs = ordered[ordered.length - 1]![0];
  const endSecs = Math.max(roundSecs ?? 0, lastTs + 30, 60);
  const xAt = (s: number) => TL.l + (s / endSecs) * TL_PW;
  const yAt = (v: number) => TL.t + TL_PH - (v / maxV) * TL_PH;

  // The total is 0 at kickoff and steps to each point's value at that point's time.
  let path = `M ${xAt(0)} ${yAt(0)}`;
  let level = 0;
  for (const [t, v] of ordered) {
    path += ` L ${xAt(t)} ${yAt(level)} L ${xAt(t)} ${yAt(v)}`;
    level = v;
  }
  path += ` L ${xAt(endSecs)} ${yAt(level)}`;

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
  const gained = tip && hover! > 0 ? tip[1] - ordered[hover! - 1]![1] : null;
  const tipLeft = tip ? (xAt(tip[0]) / TL.W) * 100 : 0;

  return (
    <div className="viz-wrap">
      <svg className="viz-chart" viewBox={`0 0 ${TL.W} ${TL.H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${label} over the round`}>
        {(maxV >= 8 ? [0, Math.round(maxV / 2), maxV] : [0, maxV]).map((v) => (
          <g key={v}>
            <line className="grid" x1={TL.l} x2={TL.W - TL.r} y1={yAt(v)} y2={yAt(v)} strokeWidth={1} />
            <text className="tick" x={TL.l - 6} y={yAt(v) + 3} textAnchor="end">{v}</text>
          </g>
        ))}
        {marks.map((m) => (
          <text className="tick" key={m} x={xAt(Math.min(m * 60, endSecs))} y={TL.H - 8} textAnchor="middle">{m}m</text>
        ))}
        <path d={path} fill="none" stroke={seriesVar(colorIndex)} strokeWidth={2} strokeLinejoin="round" />
        {tip && (
          <>
            <line className="axis" x1={xAt(tip[0])} x2={xAt(tip[0])} y1={TL.t} y2={TL.t + TL_PH} strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={xAt(tip[0])} cy={yAt(tip[1])} r={4.5} fill={seriesVar(colorIndex)} stroke="var(--surface)" strokeWidth={2} />
          </>
        )}
      </svg>
      {tip && (
        <div className="viz-tip" style={{ left: `min(${tipLeft}%, calc(100% - 150px))`, top: 8 }}>
          <div className="tt-title">{clock(tip[0])} · {label}</div>
          <div className="tt-row"><span className="k">Total</span><span>{tip[1]}</span></div>
          {gained !== null && gained > 0 && <div className="tt-row"><span className="k">Since the point before</span><span>+{gained}</span></div>}
        </div>
      )}
    </div>
  );
}

/** Which chart a round's charts show: the kills race, or the score at that index. */
export const isChartView = (v: unknown): v is "kills" | number => v === "kills" || isCount(v);

/**
 * The kills chart and the score charts behind one switch. `scoreFields` is the game's score columns
 * in the report's order (combat, offense, defense, support); a field the game does not have gets no
 * tab, and with no scores recorded there is no switch at all.
 */
export function PlayerRoundCharts({ timeline, scores, roundSecs, colorIndex, scoreFields, remember }: {
  timeline: TimelineTuple[];
  scores?: ScoreTuple[] | null;
  roundSecs: number | null;
  colorIndex: number;
  scoreFields: { label: string; title?: string }[];
  /** A name to keep the chart picked under for the sitting; none keeps nothing. */
  remember?: string;
}) {
  const fields = scores?.length ? scoreFields.slice(0, 4) : [];
  // A player with no kill or death (a medic, an engineer) opens on the score they made most of.
  const last = scores?.[scores.length - 1];
  const busiest = last ? fields.reduce((best, _, i) => (last[i + 1]! > last[best + 1]! ? i : best), 0) : 0;
  const [picked, setView] = useRemembered<"kills" | number>(remember ?? null, timeline.length > 0 || fields.length === 0 ? "kills" : busiest, isChartView, "session");
  const view = typeof picked === "number" && picked >= fields.length ? "kills" : picked;
  const field = typeof view === "number" ? fields[view] : undefined;
  const series = useMemo(
    () => (typeof view === "number" && scores ? scores.map((p): [number, number] => [p[0], p[view + 1]!]) : []),
    [scores, view],
  );
  const name = field ? field.title ?? field.label : "";
  return (
    <>
      {fields.length > 0 && (
        <div className="seg" role="group" aria-label="Chart" style={{ marginBottom: 6 }}>
          <button type="button" className={`seg-btn ${view === "kills" ? "active" : ""}`} aria-pressed={view === "kills"} onClick={() => setView("kills")}>Kills</button>
          {fields.map((f, i) => (
            <button key={f.label} type="button" className={`seg-btn ${view === i ? "active" : ""}`} aria-pressed={view === i}
              title={f.title} onClick={() => setView(i)}>{f.label}</button>
          ))}
        </div>
      )}
      {field ? (
        <>
          <div className="hint">{name}, as it built up through the round. Hover for the total at any point.</div>
          <ScoreTimeline points={series} roundSecs={roundSecs} colorIndex={colorIndex} label={name} />
        </>
      ) : (
        <>
          <div className="hint">Their round — the line climbs with each kill, ✕ marks each death. Hover any moment for who and what.</div>
          <PlayerTimeline events={timeline} roundSecs={roundSecs} colorIndex={colorIndex} />
        </>
      )}
    </>
  );
}
