/**
 * The watch service — reasons are the record, the flag is the cache.
 *
 * A player is ON the watchlist while at least one watch REASON is active (not removed, not past
 * its own expiry). Everything that highlights a watched player — the live roster's 👁, the
 * Discord join alert, the Watched tab — reads `player_flags.watchlist`, and that boolean is kept
 * true to the reasons by the two functions here. Nothing else may write the watch flag directly:
 * a flag that can disagree with its own reasons is two watchlists wearing one name.
 */
import type { PlayerFlagsRow, Repository, WatchReasonRow } from "@app/db";

/** One definition of "active", shared with the stores' SQL twin. */
export function isActiveReason(r: WatchReasonRow, now = Date.now()): boolean {
  return r.removedAt === null && (r.expiresAt === null || Date.parse(r.expiresAt) > now);
}

/**
 * Recompute the cached flag from the reasons. The flag's single reason/by/at fields — which the
 * live view's tooltip and the Discord alert still read — carry the NEWEST active reason's story;
 * the full list lives on the profile. playerFlags.set keeps maintaining the watch-spell history
 * (armed/disarmed periods) exactly as before, so that record survives this model unchanged.
 */
export async function syncWatchFlag(repo: Repository, playerId: string, by: { userId: string | null; name: string }): Promise<PlayerFlagsRow> {
  const reasons = await repo.watchReasons.list(playerId);
  const active = reasons.filter((r) => isActiveReason(r));
  if (active.length === 0) return repo.playerFlags.set(playerId, { watchlist: false }, by);
  const newest = active[0]!; // list() orders active first, newest first
  return repo.playerFlags.set(playerId, {
    watchlist: true,
    watchReason: newest.reason,
    ...(newest.addedBy ? { watchBy: newest.addedBy } : {}),
    watchAt: newest.addedAt,
  }, by);
}

/**
 * Add a watch reason (arming the watch when it is the first) and sync the cache.
 *
 * `skipIfDuplicate` is for automated callers that can fire repeatedly on the same evidence — the
 * evasion tripwire re-checks on every link event, and five identical rows say less than one.
 * A deduped call returns `reason: null` and touches nothing.
 */
export async function addWatchReason(
  repo: Repository,
  playerId: string,
  input: { reason: string; by: { userId: string | null; name: string }; expiresAt?: string | null; skipIfDuplicate?: boolean },
): Promise<{ reason: WatchReasonRow | null; flags: PlayerFlagsRow }> {
  if (input.skipIfDuplicate) {
    const existing = await repo.watchReasons.list(playerId);
    if (existing.some((r) => isActiveReason(r) && r.reason === input.reason)) {
      return { reason: null, flags: await syncWatchFlag(repo, playerId, input.by) };
    }
  }
  const reason = await repo.watchReasons.add({
    playerId, reason: input.reason, addedBy: input.by.name, addedByUserId: input.by.userId,
    expiresAt: input.expiresAt ?? null,
  });
  const flags = await syncWatchFlag(repo, playerId, input.by);
  return { reason, flags };
}
