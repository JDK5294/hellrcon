/**
 * Extract a server's display name from a `session` state read (GetServerInformation
 * Name=session). Providers like GTX let admins rename a server over RCON, so the live name
 * is authoritative — we pull it rather than trusting a value typed at add-time.
 *
 * The v2 session read returns the name under `serverName` (confirmed from a live capture); the
 * other candidates and one level of nesting are kept as defensive fallbacks for legacy/bridge
 * shapes. Returns the first non-empty string.
 */
const NAME_KEYS = ["serverName", "ServerName", "Name", "name", "Hostname", "hostname"];

export function serverNameFromSession(session: unknown): string | null {
  const fromObject = (obj: Record<string, unknown>): string | null => {
    for (const key of NAME_KEYS) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };

  if (!session || typeof session !== "object") return null;
  const top = session as Record<string, unknown>;

  const direct = fromObject(top);
  if (direct) return direct;

  // Some responses wrap details a level down (e.g. { Result: {...} } / { session: {...} }).
  for (const nestKey of ["Result", "result", "session", "Session", "data", "Data"]) {
    const nested = top[nestKey];
    if (nested && typeof nested === "object") {
      const found = fromObject(nested as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}
