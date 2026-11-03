"use client";
/**
 * The smallest unit of the stats visual kit: a labelled headline number. Per the dataviz method a
 * single magnitude is a stat tile, not a chart. `StatGrid` lays a set of them out responsively.
 * Shared by the staff profile and the player profile so both surfaces read the same.
 */
import type { ReactNode } from "react";

export function StatTile({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className={`stat-tile${accent ? " accent" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub != null && sub !== "" && <div className="sub">{sub}</div>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}
