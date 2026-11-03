/**
 * Standing the GLOBAL sweeps down while a restore replaces the database.
 *
 * A restore empties every catalogued table and refills it from the archive, and the worker is a
 * separate process that keeps running the whole time. That is what the restore marker is for (see
 * `@app/shared`'s restore-marker), and the supervisor already honours it: the scan stands every
 * per-server runner down and brings them back when the marker clears.
 *
 * The sweeps on their own timers were not covered by that, and they are the ones that DELETE.
 * Mid-restore the tables are half-loaded, so a VIP grant whose server row has not landed yet reads
 * as an orphan and is removed; an approval request reads as expired and is voided; a watch reads
 * as lapsed and is lifted. Ban reconciliation is worse than any of them — with applying armed it
 * compares the game's live ban list against a decisions table that is still filling and lifts the
 * bans it cannot find, on the actual game server. Every one of those is the restore reporting
 * "whole" and then not being whole, on the one path whose entire job is getting back to where you
 * were.
 *
 * So the rule is uniform: no global sweep runs while the marker is fresh. It is applied here
 * rather than inside each sweep so that a sweep added later is covered by the shape of the code
 * instead of by somebody remembering.
 */

export interface SweepLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Wrap a sweep so it does nothing while `paused()` is true.
 *
 * The stand-down is announced once, on the way in, and the return once, on the way out — a restore
 * of a big archive can span dozens of ticks, and a line per tick per sweep would bury the restore's
 * own progress.
 */
export function whilePaused(
  what: string,
  fn: () => Promise<unknown>,
  opts: { paused: () => boolean; log: SweepLog; reason?: string },
): () => Promise<unknown> {
  let standingDown = false;
  const reason = opts.reason ?? "a restore is in progress";
  return async () => {
    if (opts.paused()) {
      if (!standingDown) {
        standingDown = true;
        opts.log.warn(`${what} stood down — ${reason}`);
      }
      return;
    }
    if (standingDown) {
      standingDown = false;
      opts.log.info(`${what} running again`);
    }
    return fn();
  };
}

/**
 * Skip a tick while the previous run of the same sweep is still going.
 *
 * `repeatEvery` never waits for the run before (see @app/shared's background.ts), which is right
 * for sweeps that finish in well under their interval. A sweep that dials game servers on a short
 * cadence can overrun — one slow connect is a timeout's worth of seconds — and two overlapping runs
 * then act on the same rows at once. The database claim still keeps a game write exactly-once; this
 * keeps the dials and the log from doubling up behind it. In-process only, by design: it is a
 * courtesy, not the guarantee.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
  let running = false;
  return async () => {
    if (running) return undefined;
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  };
}
