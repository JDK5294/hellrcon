"use client";
/** Dashboard tile: moderators — staff and their recent action counts, from the audit staff summary.
 *  Gated by staff.analytics (the layout endpoint filters it out for everyone else). */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { SkeletonLines } from "../ui";
import { Time } from "../Time";
import { useServers } from "../../lib/servers";

interface Staff { actorName: string; count: number; lastAt: string }
const initials = (n: string) => (n || "?").trim().slice(0, 2).toUpperCase();

export default function ModeratorsCard() {
  // Follows the pinned server rather than offering its own control: this is a tile on a dashboard
  // that already names the server above it, and "who is moderating" merged across every server was
  // the same wrong answer the staff pages gave.
  const { serverId } = useServers();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    setStaff(null); setError(false); // the last server's names, or its failure, are not this server's
    api<{ staff: Staff[] }>(`/audit/staff${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ""}`)
      .then((r) => { if (live) setStaff(r.staff); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [serverId]);
  if (error) return <p className="muted fs-md">Couldn&apos;t load moderators.</p>;
  if (!staff) return <SkeletonLines lines={4} />;
  if (!staff.length) return <p className="muted fs-md">No staff activity recorded yet.</p>;
  return (
    <div className="recent-card">
      <div className="recent-list">
        {staff.slice(0, 8).map((s) => (
          <div key={s.actorName} className="recent-row static">
            <span className="team-avatar" aria-hidden>{initials(s.actorName)}</span>
            <span className="recent-main"><span className="recent-label" style={{ fontWeight: 600 }}>{s.actorName}</span></span>
            <span className="recent-meta">
              <span className="muted fs-sm">{s.count} action{s.count === 1 ? "" : "s"}</span>
              <Time className="recent-time" iso={s.lastAt} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
