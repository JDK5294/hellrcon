/**
 * The vote loop's half of the manual-change hold: clear a lapsed hold only if it is still the one
 * the tick read. The loop works from a snapshot taken before its Discord round trips, and a staff
 * map change that extended the hold in between would otherwise be wiped by a stale "it has run
 * out". Returns the hold the loop should carry on with — null when cleared, the newer value when
 * one was written, and the snapshot unchanged when the re-read failed (the next tick tries again).
 */
export async function clearLapsedVoteHold(
  snapshot: string,
  io: { read(): Promise<string | null | undefined>; clear(): Promise<unknown> },
): Promise<string | null> {
  let fresh: string | null;
  try { fresh = (await io.read()) ?? null; } catch { return snapshot; }
  if (fresh !== snapshot) return fresh;
  await io.clear();
  return null;
}
