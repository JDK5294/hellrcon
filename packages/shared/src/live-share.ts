/**
 * The worker's latest reads of each server's live state (its session, roster and map rotation),
 * left where the API can read them (the bus's remember/recall). The panel's Live page answers from
 * them while they are fresh instead of opening a game connection of its own on every refresh: the
 * worker reads all three all day, over the connections it already holds.
 */

/** What is shared, under the names readState reads them by. */
export const LIVE_SHARED_KINDS = ["session", "players", "maprotation"] as const;
export type LiveSharedKind = (typeof LIVE_SHARED_KINDS)[number];

/** Where one server's latest read of one kind is kept. */
export const liveShareKey = (serverId: string, kind: LiveSharedKind): string => `live:${serverId}:${kind}`;

/** One shared read: when it was taken (epoch ms) and what the game answered. */
export interface SharedLiveRead {
  at: number;
  value: unknown;
}

/** How long a shared read is kept at all: twice the longest freshness limit below, so a read still
 *  fresh enough to show is never already gone, and a stopped worker's last reads clear themselves
 *  within two minutes. */
export const LIVE_SHARE_TTL_SEC = 120;

/**
 * How old each read may be and still be shown. The roster and session move by the second: while a
 * round runs the worker reads the session every 2 seconds and the roster about every 10, and the
 * panel refreshes every 15.
 * The rotation changes only when someone changes it, and the worker re-reads it every 30 seconds
 * (LIVE_ROTATION_SHARE_MS).
 */
export const LIVE_SHARE_FRESH_MS: Readonly<Record<LiveSharedKind, number>> = { session: 15_000, players: 15_000, maprotation: 60_000 };

/** How often the worker re-reads the rotation to share it, since none of its loops reads it on a
 *  schedule of their own. */
export const LIVE_ROTATION_SHARE_MS = 30_000;

/** The three reads' values when every one is a well-formed read fresh enough to show and taken
 *  after `notBefore` (epoch ms: when the reader last changed something on the server, which an
 *  earlier read cannot show), else null: the reader then asks the game itself. */
export function freshLiveReads(reads: Readonly<Record<LiveSharedKind, unknown>>, now: number, notBefore = 0): Record<LiveSharedKind, unknown> | null {
  const out = {} as Record<LiveSharedKind, unknown>;
  for (const kind of LIVE_SHARED_KINDS) {
    const read = reads[kind];
    if (!read || typeof read !== "object" || !("value" in read)) return null;
    const at = (read as { at?: unknown }).at;
    if (typeof at !== "number" || !Number.isFinite(at) || now - at > LIVE_SHARE_FRESH_MS[kind] || at <= notBefore) return null;
    out[kind] = (read as SharedLiveRead).value;
  }
  return out;
}
