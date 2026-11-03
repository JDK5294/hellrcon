"use client";
/** Dashboard tile: player-rules status — the Auto settings enforcer rules with their enabled
 *  state. Gated by the widget capability. */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { SkeletonLines } from "../ui";

interface Rule { id: string; name: string; enabled: boolean; action: string; eventKind: string }

export default function RulesCard() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    api<{ rules: Rule[] }>("/enforcer/rules").then((r) => setRules(r.rules)).catch(() => setError(true));
  }, []);
  if (error) return <p className="muted fs-md">Couldn&apos;t load player rules.</p>;
  if (!rules) return <SkeletonLines lines={4} />;
  const on = rules.filter((r) => r.enabled).length;
  if (!rules.length) return <p className="muted fs-md">No player rules yet.</p>;
  return (
    <div className="rules-card">
      <div className="rules-summary"><strong>{on}</strong> of {rules.length} rule{rules.length === 1 ? "" : "s"} enabled</div>
      <div className="recent-list">
        {rules.slice(0, 8).map((r) => (
          <div key={r.id} className="rules-row">
            <span className={`am-dot ${r.enabled ? "on" : "off"}`} aria-hidden />
            <span className="recent-main"><span className="recent-label" style={{ fontWeight: 600 }}>{r.name}</span></span>
            <span className="muted fs-sm">{r.action}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
