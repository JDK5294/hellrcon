/**
 * The second witness to a match ending, as a pure decision (see the map-vote loop): the vote used
 * to learn of a match end only from the admin log's MATCH ENDED line, and one lost line left a
 * poll up for hours. This watches the map IN PLAY instead — the first read after a poll opens
 * notes it, and a different map seen on two checks running is a match that ended unreported.
 */
export interface PollMapWatch { messageId: string; mapKey: string; changedTo: string | null; lastCheckMs: number }

export function pollMapWatchStep(
  watch: PollMapWatch | null,
  input: { messageId: string; mapKey: string; nowMs: number },
): { watch: PollMapWatch | null; rolledOverFrom: string | null } {
  const { messageId, mapKey, nowMs } = input;
  // An unreadable map judges nothing — it only marks the check as done.
  if (!mapKey) return { watch: watch ? { ...watch, lastCheckMs: nowMs } : null, rolledOverFrom: null };
  // A new poll (or the first look at this one): its map is whatever is in play now.
  if (!watch || watch.messageId !== messageId) return { watch: { messageId, mapKey, changedTo: null, lastCheckMs: nowMs }, rolledOverFrom: null };
  if (mapKey === watch.mapKey) return { watch: { ...watch, changedTo: null, lastCheckMs: nowMs }, rolledOverFrom: null };
  // First sighting of a different map: confirmed only if the next check agrees, so one odd read
  // during a map transition cannot throw a live vote away.
  if (watch.changedTo !== mapKey) return { watch: { ...watch, changedTo: mapKey, lastCheckMs: nowMs }, rolledOverFrom: null };
  return { watch: null, rolledOverFrom: watch.mapKey };
}
