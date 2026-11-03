"use client";
/**
 * Dashboard tile: your recent activity with quick jumps back (viewed a player → reopen that
 * profile; opened a screen → back to it; granted a VIP → jump to VIPs). Personal + local — a
 * navigation convenience, not the audit trail. Staff auditing of *others'* actions lives in the
 * Activity view (staff.analytics). Search lists the same items before anything is typed.
 */
import { useEffect, useState } from "react";
import { Time } from "../Time";
import {  } from "../../lib/api";
import { getRecent, clearRecent, type RecentItem, type RecentKind } from "../../lib/recent";
import { useAppNav } from "../../lib/nav";

const KIND_ICON: Record<RecentKind, string> = { player: "👤", vip: "★", ban: "🚫", config: "⚙", search: "⌕", console: "⌨", screen: "▤" };

export default function RecentActivityCard() {
  const { go } = useAppNav();
  const [items, setItems] = useState<RecentItem[]>([]);

  useEffect(() => {
    const refresh = () => setItems(getRecent());
    refresh();
    window.addEventListener("panel:recent", refresh);
    return () => window.removeEventListener("panel:recent", refresh);
  }, []);

  if (!items.length) return <p className="muted fs-md">Nothing yet — open a player or a screen and it&apos;ll show up here for a quick jump back.</p>;

  return (
    <div className="recent-card">
      <div className="recent-list">
        {items.map((r, i) => (
          <button key={i} className="recent-row" onClick={() => go(r.view, r.target, r.tab)} title={`Jump to ${r.label}`}>
            <span className="recent-ico" aria-hidden>{KIND_ICON[r.kind] ?? "•"}</span>
            <span className="recent-main">
              <span className="recent-label">{r.label}</span>
              {r.sub && <span className="recent-sub">{r.sub}</span>}
            </span>
            <span className="recent-meta"><Time className="recent-time" iso={r.ts} /></span>
            <span className="recent-jump" aria-hidden>→</span>
          </button>
        ))}
      </div>
      <button className="mini ghost recent-clear" onClick={() => clearRecent()}>Clear</button>
    </div>
  );
}
