/**
 * When a session the live roster no longer backs is recorded as having ENDED.
 *
 * The reaper closes sessions the game never told us about: a ban-kick whose log line carries no
 * id, a server crash that logs nothing, or — the one this file exists for — whatever happened
 * while the worker was down. It closed them at the moment it noticed, which is right to within a
 * tick in normal running and badly wrong after an outage: a worker down from 8pm to 2am closed
 * every session stranded at 8pm as if the player had been there until 2am. Those six phantom
 * hours are not cosmetic — they are attendance for an event payout, and hours on a leaderboard.
 *
 * So the end is capped at the last moment anything actually OBSERVED this server. Nobody can know
 * when a player left while nothing was watching; crediting them to the last sighting under-states
 * that unknown by at most one tick in normal running, and crediting them to "now" over-states it
 * without limit. Under-crediting is the safer of the two errors when the number buys something.
 */

/**
 * @param seenAt the roster read that found them absent — "now".
 * @param lastObservedAt the previous successful observation of this server, or null when this
 *   process has not made one yet and the store had no snapshot to seed from.
 */
export function reapEndAt(seenAt: string, lastObservedAt: string | null): string {
  if (!lastObservedAt) return seenAt;
  return lastObservedAt < seenAt ? lastObservedAt : seenAt;
}
