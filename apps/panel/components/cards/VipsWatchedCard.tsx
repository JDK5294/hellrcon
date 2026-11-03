"use client";
/** Dashboard tile: VIP list (per active server) + watchlist, in two tabs. */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { hasCap } from "../../lib/access";
import { useGrants } from "../../lib/grants";
import { useServers } from "../../lib/servers";
import { SkeletonLines } from "../ui";

interface Vip { playerId: string; playerName: string | null; expiration: string | null }
interface FlagRow { playerId: string; name: string | null; watchlist: boolean }

function avatar(name: string | null, id: string) {
  const s = (name || id).trim();
  return s.slice(0, 2).toUpperCase() || "??";
}

export default function VipsWatchedCard() {
  const { serverId } = useServers();
  // The VIP list is read with VIP access (granting or removing it). Without it the card is the
  // watchlist alone, rather than a VIP tab saying the server has none.
  const grants = useGrants();
  const seesVips = hasCap(grants, "vip.grant", "read") || hasCap(grants, "vip.revoke", "read");
  const [tab, setTab] = useState<"vip" | "watched">(seesVips ? "vip" : "watched");
  const [vips, setVips] = useState<Vip[] | null>(null);
  const [vipsFailed, setVipsFailed] = useState(false);
  const [watched, setWatched] = useState<FlagRow[] | null>(null);

  useEffect(() => {
    if (!seesVips) return;
    if (!serverId) { setVips([]); return; }
    // Switching servers mid-flight: the old server's VIP list must not paint over the new one's.
    let live = true;
    setVips(null); setVipsFailed(false);
    api<{ vips: Vip[] }>(`/servers/${serverId}/vips`)
      .then((r) => { if (live) setVips(r.vips); })
      .catch(() => { if (live) { setVips([]); setVipsFailed(true); } });
    return () => { live = false; };
  }, [serverId, seesVips]);
  // A failed read is said, as the VIP tab says it: "No watched players" under a list that never
  // arrived is a claim about the watchlist the card cannot make.
  const [watchedFailed, setWatchedFailed] = useState(false);
  useEffect(() => {
    api<{ flags: FlagRow[] }>("/players/flagged").then((r) => setWatched(r.flags.filter((f) => f.watchlist))).catch(() => { setWatched([]); setWatchedFailed(true); });
  }, []);

  const rows: { id: string; name: string | null }[] =
    tab === "vip" ? (vips ?? []).map((v) => ({ id: v.playerId, name: v.playerName })) : (watched ?? []).map((w) => ({ id: w.playerId, name: w.name }));
  const loading = tab === "vip" ? vips === null : watched === null;

  return (
    <div className="vw-card">
      <div className="vw-tabs">
        {seesVips && <button className={`vw-tab ${tab === "vip" ? "active" : ""}`} onClick={() => setTab("vip")}>VIP{vips && !vipsFailed ? ` (${vips.length})` : ""}</button>}
        <button className={`vw-tab ${tab === "watched" ? "active" : ""}`} onClick={() => setTab("watched")}>Watched{watched && !watchedFailed ? ` (${watched.length})` : ""}</button>
      </div>
      <div className="vw-list">
        {loading && <SkeletonLines lines={4} />}
        {!loading && !rows.length && <p className="muted">{tab === "vip" ? (vipsFailed ? "Couldn't load this server's VIPs." : "No VIPs on this server.") : watchedFailed ? "Couldn't load the watchlist." : "No watched players."}</p>}
        {rows.map((r) => (
          <div key={r.id} className="vw-row">
            <span className="vw-avatar">{avatar(r.name, r.id)}</span>
            <span className="vw-name">{r.name || <span className="muted">{r.id.slice(0, 14)}…</span>}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
