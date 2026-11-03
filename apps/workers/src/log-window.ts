/**
 * How far back an ingest poll reads the game's log.
 *
 * The window was a constant, the poll interval plus 5 seconds (15 by default), whatever had
 * happened since the last read. A pass that ran long put more than that between two reads: a slow
 * read inside the pass, a game hitching through a map change, or a score check between polls
 * (score-check.ts) answered late. Whatever the game logged in the difference was never read at
 * all: kills, chat, a MATCH START or a MATCH ENDED.
 *
 * The window now reaches back to when the previous read was sent, plus the same slack, so a long
 * pass reads further back instead of leaving a hole. It is never shorter than the old constant,
 * and never longer than the re-read a new connection makes (RECONNECT_BACKFILL_SEC). Reading more
 * costs nothing that matters: lines dedupe by stable key in memory, and events dedupe in the store.
 */

/** Seconds of log the next read asks for, `sincePreviousReadMs` after the last read was sent. */
export function logBacktrackSec(sincePreviousReadMs: number, pollMs: number, maxSec: number): number {
  const slackSec = 5;
  const floorSec = Math.ceil(pollMs / 1000) + slackSec;
  return Math.min(maxSec, Math.max(floorSec, Math.ceil(sincePreviousReadMs / 1000) + slackSec));
}
