/**
 * Is a server DARK? — the pure latch behind the "server unreachable" alert.
 *
 * The ingest runner already learns this the hard way: it connects, reads the admin log, and on a
 * dropped or refused connection loops back to reconnect. What it never did was TELL anyone. This
 * turns that lived experience into one alert when a server has been unreachable past a threshold,
 * and exactly one more when it answers again — no flapping, no repeat every reconnect.
 *
 * Kept pure and separate from the I/O for the usual reason: the interesting part is the state
 * machine (when does an outage become worth mentioning, when is it over, how is one round of
 * flakiness kept from spamming), and that is exactly what a test wants to drive without a socket.
 *
 * The rules:
 *  - A single failed poll is not an outage. The alert fires only once the server has been
 *    unanswered for `thresholdMs` CONTINUOUSLY — measured from the last read that actually
 *    succeeded, so a brief reconnect blip stays quiet.
 *  - "Dark" latches: once reported, further failures say nothing until a recovery resets it.
 *  - Recovery fires on the first success AFTER a dark report, never on a success that followed
 *    only sub-threshold flakiness (nothing was ever reported, so there is nothing to recover).
 *  - `downMinutes` on either event is honest wall-clock from the last good read.
 */
export interface ServerHealthState {
  /** Epoch ms of the last read that succeeded. null before the first success ever. */
  lastOkAt: number | null;
  /** True between a dark report and its recovery — suppresses repeat dark alerts. */
  reportedDark: boolean;
}

export const freshHealth = (): ServerHealthState => ({ lastOkAt: null, reportedDark: false });

export type ServerHealthEmit =
  | { kind: "dark"; downMinutes: number }
  | { kind: "recovered"; downMinutes: number }
  | null;

/**
 * A poll SUCCEEDED. Returns the new state and, if the server was previously reported dark, the
 * recovery to emit. The very first success just records the clock — a worker that starts up while
 * a server happens to be down has no "last good" to measure from and must not cry recovery.
 */
export function onPollOk(state: ServerHealthState, now: number): { state: ServerHealthState; emit: ServerHealthEmit } {
  if (state.reportedDark) {
    const downMinutes = state.lastOkAt != null ? Math.max(1, Math.round((now - state.lastOkAt) / 60_000)) : 1;
    return { state: { lastOkAt: now, reportedDark: false }, emit: { kind: "recovered", downMinutes } };
  }
  return { state: { lastOkAt: now, reportedDark: false }, emit: null };
}

/**
 * A poll or connection FAILED. Returns the dark alert to emit the first time the outage crosses
 * the threshold, and null every time after (latched) or before (still within tolerance). A server
 * that has NEVER answered since the worker started (`lastOkAt` null) is left alone — that is a
 * misconfiguration or a cold start, not an outage this alert was asked to report.
 */
export function onPollFail(state: ServerHealthState, now: number, thresholdMs: number): { state: ServerHealthState; emit: ServerHealthEmit } {
  if (state.reportedDark || state.lastOkAt == null) return { state, emit: null };
  if (now - state.lastOkAt < thresholdMs) return { state, emit: null };
  const downMinutes = Math.max(1, Math.round((now - state.lastOkAt) / 60_000));
  return { state: { ...state, reportedDark: true }, emit: { kind: "dark", downMinutes } };
}
