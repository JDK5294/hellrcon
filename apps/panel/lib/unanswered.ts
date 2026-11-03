/**
 * A write that got no answer — a timeout, a dropped connection, the proxy's own gateway error —
 * may still have run to the end on the server. For a grant that STACKS, pressing it again would
 * give everyone the time twice, so those callers say so instead of inviting a retry.
 *
 * Reads `status` off the error (lib/api's ApiError: 0 when no answer arrived at all) rather than
 * importing the class, so this stays a leaf the tests can load.
 */
export function mayStillBeRunning(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 0 || status === 502 || status === 504 || status === 524;
}

export const STILL_RUNNING_NOTE = "It may still be finishing on the server — check the players' VIP before running it again, or they get the time twice.";
