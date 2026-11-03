"use client";
import { useServers } from "../lib/servers";
import { Icon } from "./icons";

/** The pinned active-server card in the sidebar. A native select overlays the card for switching. */
export default function ServerSwitcher() {
  const { servers, serverId, server, serverNo, numberOf, setServerId } = useServers();
  if (!servers.length) return null;

  return (
    <div className="server-switcher" title={server?.name}>
      {/* The number takes the icon's slot rather than sitting beside it. A servers glyph on the
          servers card says nothing you didn't already know; the number is the one piece of
          information here that also appears somewhere else, so it earns the prominent square. */}
      <span className="ss-icon ss-no">{serverNo ?? <Icon name="servers" />}</span>
      <div className="ss-meta">
        <div className="ss-name">{server?.name ?? "Select a server"}</div>
        <div className="ss-sub">
          {server && <span className={`dot ${server.engagementMode === "active" ? "on" : "obs"}`} />}
          {server ? (server.engagementMode === "active" ? "Active" : "Observe") : `${servers.length} server${servers.length === 1 ? "" : "s"}`}
        </div>
      </div>
      <span className="ss-chev" aria-hidden>⌄</span>
      <select value={serverId} onChange={(e) => setServerId(e.target.value)} aria-label="Active server">
        {/* Numbered here too, or the badge elsewhere is a code with no key. */}
        {servers.map((s) => <option key={s.id} value={s.id}>{numberOf(s.id)} · {s.name}</option>)}
      </select>
    </div>
  );
}

/**
 * The active server's number, for the header.
 *
 * The header cannot print a server name — they run to eighty characters here and differ by one
 * digit buried in the middle — so on a phone there was nothing at all saying which server every
 * action was about to hit. This is that missing piece: two characters wide, always in the same
 * place. It opens the navigation, where the switcher is, so it answers "which one?" and "change
 * it" with the same tap.
 */
export function ServerBadge({ onOpen }: { onOpen: () => void }) {
  const { servers, server, serverNo } = useServers();
  if (!servers.length || serverNo === null) return null;
  const mode = server?.engagementMode === "active" ? "Active" : "Observe";
  return (
    <button
      className={`server-badge ${server?.engagementMode === "active" ? "on" : "obs"}`}
      onClick={onOpen}
      title={`Server ${serverNo} — ${server?.name ?? ""} (${mode})`}
      aria-label={`Server ${serverNo}, ${server?.name ?? ""}. Open navigation to switch server`}
    >
      {serverNo}
    </button>
  );
}
