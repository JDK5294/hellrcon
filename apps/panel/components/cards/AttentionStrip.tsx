"use client";
/**
 * The dashboard's orientation strip — the first thing on the home screen, answering "does anything
 * need me right now?" before you go looking.
 *
 * A grid of tiles tells you what the numbers are; it doesn't tell you whether anything is wrong. So
 * this strip reports only things that are actionable or surprising — watched players currently in
 * game, servers the panel can't reach, servers left in observe mode (the usual reason "nothing I
 * change takes effect"), and unread staff notices — and each one is a link to the screen that deals
 * with it. When everything is fine it says so in one line and takes up almost no space.
 */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { hasCap } from "../../lib/access";
import { useGrants } from "../../lib/grants";
import { useAppNav } from "../../lib/nav";
import { useServers } from "../../lib/servers";

interface FlagRow { playerId: string; name: string | null; watchlist: boolean; online?: boolean }

interface Item {
  tone: "warn" | "info" | "ok";
  icon: string;
  text: string;
  go?: { view: string; tab?: string; label: string };
}

export function AttentionStrip({ unseenAnnouncements = 0 }: { unseenAnnouncements?: number }) {
  const nav = useAppNav();
  // The server list comes from the ONE shared provider, not a fetch of this card's own. This card,
  // the provider and a dashboard widget each called /api/servers on the same mount — three copies
  // of one answer — and this was the only caller that needed nothing the provider doesn't already
  // hold (id, name, engagementMode are all in ServerLite). The 30s tick below asks the provider to
  // refresh, so the switcher and every other consumer share the freshness instead of each paying
  // for their own.
  const { servers: providerServers, refresh: refreshServers, loading: serversLoading } = useServers();
  const servers = serversLoading && providerServers.length === 0 ? null : providerServers;
  const [watched, setWatched] = useState<FlagRow[] | null>(null);
  const [reachable, setReachable] = useState(true);
  // Server view reads the watchlist (/players/flagged) and lists the servers. Without it there is
  // nothing to check — its refusal is not the panel being down, which is what it was taken for —
  // and nothing to count.
  const grants = useGrants();
  const viewsServers = hasCap(grants, "server.view", "read");

  useEffect(() => {
    let alive = true;
    let first = true;
    const tick = () => {
      // No polls from a hidden tab — the same rule the sidebar badge follows: a phone with the
      // panel backgrounded all day must not refresh a strip nobody can see. The first tick always
      // runs (the page just opened); later ones wait for the tab to be visible again.
      if (!first && typeof document !== "undefined" && document.hidden) return;
      // The provider fetched on ITS mount moments ago; refreshing again here would recreate the
      // duplicate this card just stopped making. Later ticks keep the list current.
      if (!first) refreshServers();
      first = false;
      // Watched players are the one genuinely time-sensitive thing on this screen: if someone you
      // flagged is playing right now, you want to know before you go hunting for them. This is
      // also the reachability probe — one request answers both.
      if (!viewsServers) return;
      api<{ flags: FlagRow[] }>("/players/flagged")
        .then((r) => { if (alive) { setWatched(r.flags.filter((f) => f.watchlist)); setReachable(true); } })
        .catch(() => { if (alive) { setWatched([]); setReachable(false); } });
    };
    tick();
    const h = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(h); };
    // refreshServers is a stable useCallback from the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewsServers]);

  const items: Item[] = [];
  if (!reachable) {
    items.push({ tone: "warn", icon: "⚠", text: "The panel API isn't answering — the numbers below may be stale." });
  }
  const watchedOnline = (watched ?? []).filter((f) => f.online);
  if (watchedOnline.length) {
    const names = watchedOnline.slice(0, 3).map((f) => f.name || "unnamed").join(", ");
    items.push({
      tone: "warn", icon: "👁",
      text: `${watchedOnline.length} watched player${watchedOnline.length === 1 ? " is" : "s are"} in game now — ${names}${watchedOnline.length > 3 ? "…" : ""}`,
      go: { view: "players", tab: "players", label: "Open watchlist" },
    });
  }
  const observing = (servers ?? []).filter((s) => s.engagementMode === "observe");
  if (observing.length) {
    items.push({
      tone: "info", icon: "🔒",
      text: `${observing.length} server${observing.length === 1 ? " is" : "s are"} in observe mode — the panel reads ${observing.length === 1 ? "it" : "them"} but every change is refused.`,
      go: { view: "admin", tab: "connections", label: "Review connections" },
    });
  }
  // An empty list means none connected only to someone who could connect one; for anyone else it
  // is the servers they were not given.
  if (servers && servers.length === 0 && hasCap(grants, "server.add", "write")) {
    items.push({
      tone: "info", icon: "🔌",
      text: "No game servers are connected yet — that's the first thing to set up.",
      go: { view: "admin", tab: "connections", label: "Add a server" },
    });
  }
  if (unseenAnnouncements > 0) {
    items.push({
      tone: "info", icon: "📣",
      text: `${unseenAnnouncements} new staff notice${unseenAnnouncements === 1 ? "" : "s"} since you were last here.`,
      go: { view: "community", label: "Read them" },
    });
  }

  // Nothing to report is itself worth saying — silence reads as "not loaded yet".
  if (!items.length) {
    if (!servers) return null; // still loading; don't flash an all-clear we haven't verified
    return (
      <div className="attention ok">
        <span className="att-icon" aria-hidden>✓</span>
        <span>Nothing needs your attention{viewsServers ? ` — ${servers.length} server${servers.length === 1 ? "" : "s"} connected and running normally` : ""}.</span>
      </div>
    );
  }

  return (
    <div className="attention-list">
      {items.map((it, i) => (
        <div key={i} className={`attention ${it.tone}`}>
          <span className="att-icon" aria-hidden>{it.icon}</span>
          <span className="att-text">{it.text}</span>
          {it.go && (
            <button className="mini ghost" onClick={() => nav.go(it.go!.view, undefined, it.go!.tab)}>{it.go.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}
