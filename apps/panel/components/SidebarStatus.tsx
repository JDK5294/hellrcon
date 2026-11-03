"use client";
/**
 * Host-status footer for the sidebar — mirrors CRCON's footer, reporting the machine the panel runs
 * on (self-hosted box / VPS). Polls /health/metrics; collapses to a single dot on the rail.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { BUILT_COMMIT, bundleIsStale } from "../lib/version";

interface Metrics {
  online: boolean;
  cpuPct: number;
  memory: { usedBytes: number; totalBytes: number; pct: number };
  disk: { usedBytes: number; totalBytes: number; pct: number } | null;
  uptimeSec: number;
  hostname: string;
  node: string;
  appVersion: string | null;
  appCommit: string | null;
}

const POLL_MS = 15_000;
const pctClass = (p: number) => (p >= 90 ? "crit" : p >= 75 ? "warn" : "ok");

export default function SidebarStatus() {
  const [m, setM] = useState<Metrics | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let alive = true;
    // This badge is on EVERY page, so its poll runs wherever the panel is open. One request at a
    // time, and none from a hidden tab — a phone with the panel backgrounded all day was pinging
    // the health endpoint every 15s for a dot nobody could see.
    let inFlight = false;
    const tick = () => {
      if (inFlight || (typeof document !== "undefined" && document.hidden)) return;
      inFlight = true;
      api<Metrics>("/health/metrics")
        .then((r) => {
          if (!alive) return;
          // A reply without the figures is no reading. Drawn as it came, its missing memory took
          // the whole panel down from here — this badge is on every screen, and polls.
          if (typeof r?.cpuPct !== "number" || typeof r?.memory?.pct !== "number") { setDown(true); return; }
          setM(r); setDown(false);
        })
        .catch(() => { if (alive) setDown(true); })
        .finally(() => { inFlight = false; });
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, []);

  const online = !down && !!m;
  const stale = bundleIsStale(BUILT_COMMIT, m?.appCommit);
  return (
    // The version and commit ride in the tooltip too: a tight menu keeps the line to one row by
    // leaving them out of it (lib/menuFit).
    <div className="host-status" title={m ? [m.hostname, `node ${m.node}`, m.appVersion && `v${m.appVersion}`, m.appCommit].filter(Boolean).join(" · ") : "host status"}>
      {stale && (
        <button type="button" className="hs-stale" onClick={() => window.location.reload()}>
          Panel updated — tap to reload
        </button>
      )}
      <div className="hs-head">
        <span className={`dot ${online ? "on" : "off"}`} />
        <span className="hs-label">{online ? "Online" : "Offline"}</span>
        {m?.appVersion && <span className="hs-ver nav-label">v{m.appVersion}</span>}
        {/* The commit the running image was built from — the ground truth for "did my update land". */}
        {m?.appCommit && <span className="hs-ver nav-label" title="running code commit">{m.appCommit}</span>}
      </div>
      {m && (
        <div className="hs-stats nav-label">
          <Stat label="CPU" pct={m.cpuPct} />
          <Stat label="RAM" pct={m.memory.pct} />
          {m.disk && <Stat label="Disk" pct={m.disk.pct} />}
        </div>
      )}
    </div>
  );
}

function Stat({ label, pct }: { label: string; pct: number }) {
  return (
    <span className={`hs-stat ${pctClass(pct)}`} title={`${label} ${pct}%`}>
      <span className="hs-stat-label">{label}</span>
      <span className="hs-stat-val">{pct}%</span>
    </span>
  );
}
