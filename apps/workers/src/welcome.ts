/**
 * The live welcome message's one decision: does the game need this text written NOW?
 *
 * Written when the filled text differs from what the game was last given (a new map, a new
 * next-map pick, a re-worded template — never merely a player joining, since joins are not an
 * input here at all), or when the last write is old enough that the game may have dropped it.
 */
export const WELCOME_REASSERT_MS = 12 * 60 * 60_000;

export function welcomeNeedsWrite(input: { filled: string; lastText: string | null; lastWrittenAt: string | null; nowMs: number }): boolean {
  if (input.filled !== input.lastText) return true;
  if (!input.lastWrittenAt) return true;
  const at = Date.parse(input.lastWrittenAt);
  return !Number.isFinite(at) || input.nowMs - at >= WELCOME_REASSERT_MS;
}
