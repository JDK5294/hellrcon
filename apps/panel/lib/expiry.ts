/** Shared status badge for panel-owned expiring grants (VIP, console admins):
 *  null = permanent, past = expired (awaiting the worker sweep), future = time left. */
/** Is this instant still ahead of us? (Render-safe home for the clock read — components must
 *  stay pure, so the impure Date.now lives here, exactly like expiryStatus below.) */
export function isFuture(iso: string | null | undefined): boolean {
  return Boolean(iso && Date.parse(iso) > Date.now());
}

export function expiryStatus(expiration: string | null): { label: string; cls: string } {
  if (expiration === null) return { label: "Permanent", cls: "active" };
  const ms = Date.parse(expiration) - Date.now();
  if (ms <= 0) return { label: "Expired", cls: "observe" };
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return { label: days >= 1 ? `${days}d ${hours}h left` : `${hours}h left`, cls: "observe" };
}
