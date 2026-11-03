/**
 * Fire-and-forget work that must not take the process with it.
 *
 * Lives beside `installCrashHandlers` because that is what makes the difference matter: with crash
 * handlers on — and every process here has them — an unhandled rejection is an exit. A fault inside
 * a supervised connection loop is worth exiting for; a periodic job is not. These read a table, do
 * a thing, and go back to sleep, and a database that blinks for a second means "skip this cycle",
 * not "take the process down".
 *
 * `void someAsyncFn()` is the shape that gets this wrong, and all three apps had one:
 *   - the worker's server rescan — the job that discovers servers and starts their runners, sitting
 *     in a list of four timers where the other three each carried their own `.catch`. One missing,
 *     and the blast radius was every connected server's RCON connection and the whole ingest path.
 *   - the API's enforcer rule refresh, on a ten-second timer against the database.
 *   - the API's and the relay bot's event handlers, where a `void handler(e)` rejection escapes the
 *     bus's own guard: the bus catches what a synchronous subscriber throws and cannot catch a
 *     promise it never sees. One malformed event ends the process, and the next one ends the restart.
 *
 * Having one place to say "this is background work" is what stops the next one from missing it.
 */
import type { Logger } from "./logger.js";

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Start background work now. A failure is logged against `what` and otherwise swallowed. */
export function background(log: Logger, what: string, fn: () => Promise<unknown>): void {
  void Promise.resolve()
    .then(fn) // so a THROW before the first await is caught too, not just a rejection
    .catch((err: unknown) => log.warn(`${what} failed`, { err: reason(err) }));
}

/**
 * The same, on a timer, starting immediately. Returns the handle so shutdown can clear it.
 *
 * `setInterval` never waits for the previous run, which is right for these: they are idempotent
 * and their intervals are far longer than they take. A job that overruns its interval would want
 * a different shape, and none of these do.
 */
export function repeatEvery(log: Logger, what: string, ms: number, fn: () => Promise<unknown>): NodeJS.Timeout {
  background(log, what, fn);
  return setInterval(() => background(log, what, fn), ms);
}
