"use client";
/** Dashboard tile: map rotation for the active server — current map highlighted, upcoming maps
 *  listed in order. Reads GetServerInformation(maprotation) via /servers/:id/maprotation. */
import { useMemo } from "react";
import { api } from "../../lib/api";
import { useServers } from "../../lib/servers";
import { useResource } from "../../lib/resource";
import { SkeletonLines } from "../ui";

interface MapEntry { name?: string; gameMode?: string; timeOfDay?: string }
interface Rotation { currentIndex?: number; mAPS?: MapEntry[] }

export default function MapRotationCard() {
  const { serverId, servers } = useServers();
  // Keyed on serverId: switching servers is a different subject, so a rotation still in flight for
  // the old one can never paint over the new one's.
  const load = useMemo(
    () => (serverId ? () => api<{ mapRotation: Rotation }>(`/servers/${serverId}/maprotation`).then((r) => r.mapRotation ?? {}) : null),
    [serverId],
  );
  const { data: rot, error } = useResource<Rotation>(load);

  if (!servers.length) return <p className="muted fs-md">Add a server first.</p>;
  if (error) return <p className="muted fs-md">Couldn&apos;t read the rotation.</p>;
  if (!rot) return <SkeletonLines lines={4} />;
  const maps = rot.mAPS ?? [];
  if (!maps.length) return <p className="muted fs-md">No rotation reported.</p>;
  const cur = rot.currentIndex ?? 0;

  return (
    <div className="maprot-card">
      <ol className="maprot-list">
        {maps.map((m, i) => (
          <li key={i} className={`maprot-row ${i === cur ? "current" : ""}`}>
            <span className="maprot-idx">{i === cur ? "▶" : i + 1}</span>
            <span className="recent-main"><span className="recent-label" style={{ fontWeight: i === cur ? 700 : 500 }}>{m.name || "—"}</span></span>
            <span className="muted fs-xs">{[m.gameMode, m.timeOfDay].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
