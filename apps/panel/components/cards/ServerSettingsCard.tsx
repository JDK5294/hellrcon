"use client";
/** Dashboard tile: read-only summary of the active server's settings (from /config). */
import { useMemo } from "react";
import { api } from "../../lib/api";
import { useServers } from "../../lib/servers";
import { useResource } from "../../lib/resource";
import { SkeletonLines } from "../ui";

interface Config {
  autoBalanceEnabled?: boolean;
  autoBalanceThreshold?: number;
  voteKickEnabled?: boolean;
  highPing?: number;
  idleKick?: number;
  teamSwitchCooldown?: number;
  maxQueuedPlayers?: number;
}

function Bool({ on }: { on: boolean | undefined }) {
  if (on === undefined) return <span className="muted">—</span>;
  return <span className={`ss-flag ${on ? "on" : "off"}`}>{on ? "✓" : "✕"}</span>;
}

export default function ServerSettingsCard() {
  const { serverId, server } = useServers();
  // Keyed on serverId so a slow read for the previous server cannot land on top of this one's.
  const load = useMemo(
    () => (serverId ? () => api<{ config: Config }>(`/servers/${serverId}/config`).then((r) => r.config) : null),
    [serverId],
  );
  const { data: cfg, error: err } = useResource<Config>(load);

  if (!server) return <p className="muted">No server selected.</p>;
  if (err) return <p className="muted fs-sm">Couldn&apos;t read settings.</p>;
  if (!cfg) return <SkeletonLines lines={3} />;

  const num = (v: number | undefined, unit: string, off = "off") => (v === undefined ? "—" : v === 0 ? off : `${v} ${unit}`);

  return (
    <div className="ss-summary">
      <div className="ss-flags">
        <span className="ss-item"><Bool on={cfg.autoBalanceEnabled} /> Autobalance</span>
        <span className="ss-item"><Bool on={cfg.voteKickEnabled} /> Vote-kick</span>
      </div>
      <dl className="ss-list">
        <div><dt>Team switch cooldown</dt><dd>{num(cfg.teamSwitchCooldown, "min")}</dd></div>
        <div><dt>Autobalance threshold</dt><dd>{cfg.autoBalanceThreshold ?? "—"}{cfg.autoBalanceThreshold !== undefined ? " players" : ""}</dd></div>
        <div><dt>Idle autokick</dt><dd>{num(cfg.idleKick, "min")}</dd></div>
        <div><dt>Max ping autokick</dt><dd>{num(cfg.highPing, "ms")}</dd></div>
        <div><dt>Queue length</dt><dd>{cfg.maxQueuedPlayers ?? "—"}{cfg.maxQueuedPlayers !== undefined ? " players" : ""}</dd></div>
      </dl>
    </div>
  );
}
