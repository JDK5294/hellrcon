/**
 * Per-user "recent activity" — a small local history of what you just did (opened a profile or a
 * screen, granted a VIP…) so the dashboard and Search can offer quick jumps back. Stored on this
 * device, one list per account signed in here; capped and deduped. Purely a navigation convenience
 * — distinct from the audit trail.
 */
export type RecentKind = "player" | "vip" | "ban" | "config" | "search" | "console" | "screen";

export interface RecentTarget { playerId?: string; serverId?: string; userId?: string; matchId?: string; guideId?: string }
export interface RecentItem {
  kind: RecentKind;
  label: string;
  sub?: string;
  /** where a click should jump to (a nav view id) + optional deep-link target, or tab. */
  view: string;
  target?: RecentTarget;
  tab?: string;
  ts: string;
}

/** The list before it was per account: whose it was cannot be told, so nobody inherits it. */
const SHARED_KEY = "panel.recent";

/**
 * Whose list: the account signed in, by the same key the panel's other per-person settings use
 * (userPrefs). On a shared computer one person's recently opened players and screens are not the
 * next person's to see — the rule the back trail keeps too (lib/api setToken).
 */
function key(): string {
  let user = "";
  try { user = localStorage.getItem("panel.username") ?? ""; } catch { /* ignore */ }
  return `${SHARED_KEY}.${user || "_"}`;
}
const MAX = 20;
/** Screens are kept apart, and fewer: they are opened far more often than anything is done, and
 *  would otherwise push every player off the list within a few minutes. */
const MAX_SCREENS = 10;

export function getRecent(): RecentItem[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(key()) || "[]") as RecentItem[]; } catch { return []; }
}

/** Record an activity, moving an existing match (same kind + target/label) to the front. */
export function recordRecent(item: Omit<RecentItem, "ts">): void {
  if (typeof window === "undefined") return;
  const now = { ...item, ts: new Date().toISOString() };
  const sameKey = (a: RecentItem) =>
    a.kind === now.kind && (now.target?.playerId ? a.target?.playerId === now.target.playerId : a.label === now.label);
  let screens = 0, others = 0;
  const next = [now, ...getRecent().filter((r) => !sameKey(r))]
    .filter((r) => (r.kind === "screen" ? ++screens <= MAX_SCREENS : ++others <= MAX));
  try {
    localStorage.setItem(key(), JSON.stringify(next));
    localStorage.removeItem(SHARED_KEY);
    window.dispatchEvent(new CustomEvent("panel:recent"));
  } catch { /* ignore quota */ }
}

export function clearRecent(): void {
  try { localStorage.removeItem(key()); window.dispatchEvent(new CustomEvent("panel:recent")); } catch { /* ignore */ }
}
