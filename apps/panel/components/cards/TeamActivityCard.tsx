"use client";
/**
 * Dashboard tile: collective staff activity — everyone's recent actions from the audit trail, with
 * the same jump-back links as the personal Recent tile. Only reaches users with staff.analytics
 * (the layout endpoint filters this gated widget out for everyone else).
 */
import { useEffect, useState } from "react";
import { humanizeIsoInText } from "../../lib/time";
import { api } from "../../lib/api";
import { useAppNav } from "../../lib/nav";
import type { RecentTarget } from "../../lib/recent";
import { SkeletonLines } from "../ui";
import { Time } from "../Time";
import { useServers } from "../../lib/servers";

interface Entry {
  id: string; ts: string; actorName: string; action: string;
  targetType: string | null; targetId: string | null; targetName: string | null;
  serverId: string | null; summary: string;
}

/** Map an audit action to a jump-back destination where one makes sense. */
function jumpFor(e: Entry): { view: string; target?: RecentTarget } | null {
  if (e.action.startsWith("vip.")) return { view: "vips", target: { playerId: e.targetId ?? undefined, serverId: e.serverId ?? undefined } };
  if (e.action.startsWith("player.") || e.targetType === "player") return e.targetId ? { view: "players", target: { playerId: e.targetId } } : null;
  if (e.action.startsWith("config.")) return { view: "admin" };
  if (e.action.startsWith("console.")) return { view: "console" };
  return null;
}

const initials = (name: string) => (name || "?").trim().slice(0, 2).toUpperCase();

export default function TeamActivityCard() {
  const { go } = useAppNav();
  // Follows the pinned server, like the moderators tile beside it: the dashboard names the server
  // above these, so an unscoped feed was every server's actions labelled as one server's.
  const { serverId } = useServers();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setEntries(null); setError(""); // the last server's feed, or its failure, is not this server's
    // A read that works clears the error a failed one left: one dropped poll used to replace the tile
    // with "Couldn't load activity." for good, though every poll after it was succeeding.
    const load = () => api<{ entries: Entry[] }>(`/audit?limit=25${serverId ? `&serverId=${encodeURIComponent(serverId)}` : ""}`)
      .then((r) => { if (live) { setEntries(r.entries); setError(""); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    load();
    // Same hidden-tab rule as the sidebar badge: no polls nobody can see.
    const h = setInterval(() => { if (!(typeof document !== "undefined" && document.hidden)) load(); }, 20_000);
    return () => { live = false; clearInterval(h); };
  }, [serverId]);

  if (error) return <p className="muted fs-md">Couldn&apos;t load activity.</p>;
  if (!entries) return <SkeletonLines lines={4} />;
  if (!entries.length) return <p className="muted fs-md">No staff actions recorded yet.</p>;

  return (
    <div className="recent-card">
      <div className="recent-list">
        {entries.map((e) => {
          const jump = jumpFor(e);
          const Row = jump ? "button" : "div";
          return (
            <Row key={e.id} className={`recent-row team-row ${jump ? "" : "static"}`} onClick={jump ? () => go(jump.view, jump.target) : undefined} title={jump ? "Jump to related view" : undefined}>
              <span className="team-avatar" aria-hidden>{initials(e.actorName)}</span>
              <span className="recent-main">
                {/* Wraps, but only so far: the tile has a fixed height, so an un-clamped summary pushed
                    the row below it half off the bottom and the reader got a sentence cut mid-word.
                    Two lines then an ellipsis, with the whole text on the title. */}
                <span className="recent-label clamp-2" title={humanizeIsoInText(e.summary)}>{humanizeIsoInText(e.summary)}</span>
              </span>
              <span className="recent-meta">
                <Time className="recent-time" iso={e.ts} />
                {jump && <span className="recent-jump" aria-hidden>→</span>}
              </span>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
