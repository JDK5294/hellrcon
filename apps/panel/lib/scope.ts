"use client";
/**
 * The server scope a screen is looking at, remembered like the rest of its state (lib/remembered.ts).
 * Kept apart from that module because it reads the panel's server list: the charts the public stats
 * site shares with the panel remember too, and must not carry the panel's servers and API client in.
 */
import { useServers } from "./servers";
import { isTextOrNull, useRemembered } from "./remembered";

/**
 * A screen's server scope, kept for the sitting: "" is every server, an id is that one server, and
 * until the viewer picks, it follows the server pinned in the sidebar. A remembered server that
 * has since gone (deleted, retired, or no longer this account's) follows the pinned one again
 * rather than asking for a server nobody can pick.
 */
export function useScope(name: string): [string, (next: string) => void] {
  const { servers, serverId, loading } = useServers();
  const [scope, setScope] = useRemembered<string | null>(name, null, isTextOrNull, "session");
  const known = scope !== null && (scope === "" || loading || servers.some((s) => s.id === scope));
  return [known ? scope : serverId, setScope];
}
