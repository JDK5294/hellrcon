/**
 * Which audit actions the watchlist writes — and therefore which ones the profile's moderation
 * timeline must NOT print for itself.
 *
 * The timeline renders watch spells from `watch_history` (one "Watchlisted" row per reason, plus
 * an "Unwatched" row once it closes), because those rows are permanent, carry the reason and the
 * staff member, and exist for watches that came in through an import — none of which is true of
 * the audit trail. Printing the audit row TOO shows one act twice, a second apart, in the panel
 * people open to ask "has this been dealt with before?".
 *
 * There are two actions, not one, and that is the bug this list closes: reason work is filed under
 * `player.watchlist`, but flipping the flag — the ⋯ menu's "Remove from watchlist", and the same
 * decision executed off an approval — is filed under `player.flags`. Only the first was ever
 * filtered, so every removal double-showed. A test holds this set to what the API actually writes.
 *
 * Dropping them also stops the trail from telling somebody who may read moderation history but not
 * the watchlist that a watch exists at all — `watchHistory` is already withheld from them.
 */
export const WATCH_AUDIT_ACTIONS: readonly string[] = ["player.watchlist", "player.flags"];

/** True for an audit row whose story the watch-history rows already tell. */
export function isWatchAudit(action: string): boolean {
  return WATCH_AUDIT_ACTIONS.includes(action);
}
