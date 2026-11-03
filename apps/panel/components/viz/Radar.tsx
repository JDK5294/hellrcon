"use client";
/**
 * Radar (spider) chart for a multi-axis profile — e.g. a staff member's action mix or a player's
 * combat profile across several measures at once. Axes share one normalised radial scale (values
 * scaled by the global max so shapes are comparable and there's no hidden second axis). One filled
 * polygon per series, 2px stroke + translucent fill, a legend for ≥2 series, and a hover tooltip per
 * vertex. Colour by fixed palette slot.
 */
import { useState } from "react";
import { seriesVar } from "./palette";

export interface RadarAxis { key: string; label: string }
export interface RadarSeries { key: string; label: string; colorIndex: number; values: Record<string, number> }

const SIZE = 260, CX = SIZE / 2, CY = SIZE / 2, R = 96;

export function Radar({ axes, series }: { axes: RadarAxis[]; series: RadarSeries[] }) {
  const [hover, setHover] = useState<{ ai: number; si: number } | null>(null);
  if (axes.length < 3) return <p className="muted">Not enough dimensions to chart.</p>;

  let max = 0;
  for (const s of series) for (const a of axes) max = Math.max(max, s.values[a.key] ?? 0);
  max = max || 1;

  const angle = (i: number) => (Math.PI * 2 * i) / axes.length - Math.PI / 2;
  const point = (i: number, r: number) => [CX + Math.cos(angle(i)) * r, CY + Math.sin(angle(i)) * r] as const;
  const rings = [0.25, 0.5, 0.75, 1];

  const hv = hover ? { axis: axes[hover.ai], s: series[hover.si], val: series[hover.si].values[axes[hover.ai].key] ?? 0 } : null;

  return (
    <div className="viz-wrap">
      <svg className="viz-chart" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" style={{ maxWidth: 320, margin: "0 auto", display: "block" }}>
        {rings.map((rr) => (
          <polygon key={rr} className="grid" fill="none" strokeWidth={1}
            points={axes.map((_, i) => point(i, R * rr).join(",")).join(" ")} />
        ))}
        {axes.map((a, i) => {
          const [x, y] = point(i, R);
          const [lx, ly] = point(i, R + 16);
          return (
            <g key={a.key}>
              <line className="grid" x1={CX} y1={CY} x2={x} y2={y} strokeWidth={1} />
              <text className="axis-label" x={lx} y={ly + 3} textAnchor={lx > CX + 4 ? "start" : lx < CX - 4 ? "end" : "middle"}>{a.label}</text>
            </g>
          );
        })}
        {series.map((s, si) => {
          const poly = axes.map((a, i) => point(i, R * ((s.values[a.key] ?? 0) / max)).join(",")).join(" ");
          return (
            <g key={s.key}>
              <polygon points={poly} fill={seriesVar(s.colorIndex)} fillOpacity={series.length > 1 ? 0.18 : 0.26} stroke={seriesVar(s.colorIndex)} strokeWidth={2} strokeLinejoin="round" />
              {axes.map((a, ai) => {
                const [x, y] = point(ai, R * ((s.values[a.key] ?? 0) / max));
                return <circle key={a.key} cx={x} cy={y} r={hover?.ai === ai && hover?.si === si ? 5 : 3} fill={seriesVar(s.colorIndex)} stroke="var(--surface)" strokeWidth={1.5}
                  onMouseEnter={() => setHover({ ai, si })} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }} />;
              })}
            </g>
          );
        })}
      </svg>

      {hv && (
        <div className="viz-tip" style={{ left: "50%", top: 4, transform: "translateX(-50%)" }}>
          <div className="tt-title">{hv.axis.label}</div>
          <div className="tt-row"><span className="k"><span className="sw" style={{ width: 8, height: 8, borderRadius: 2, display: "inline-block", background: seriesVar(hv.s.colorIndex) }} />{hv.s.label}</span><span>{hv.val.toLocaleString()}</span></div>
        </div>
      )}

      {series.length > 1 && (
        <div className="viz-legend">
          {series.map((s) => (
            <span key={s.key} className="li"><span className="sw" style={{ background: seriesVar(s.colorIndex) }} />{s.label}</span>
          ))}
        </div>
      )}
    </div>
  );
}
