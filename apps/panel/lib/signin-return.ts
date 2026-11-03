/**
 * Where to come back to after a trip through Discord — signing in, or linking an account.
 *
 * Both leave the panel and return to its root with the outcome in the hash, which used to land
 * everyone on the default screen — so a profile opened from a Discord alert while signed out (a
 * phone's in-app browser, a fresh device) became the dashboard after signing in. Whatever starts
 * the trip holds the page's route, and the shell reopens it on return.
 *
 * sessionStorage: per tab, so it survives the round trip through Discord and dies with the tab.
 * Only a panel route ("#/…") is ever held or handed back.
 */
const KEY = "panel.signin.return";

/** Hold the current route for the trip through Discord (nothing, if the page is no route). */
export function holdReturnRoute(): void {
  try {
    const hash = window.location.hash;
    if (hash.startsWith("#/")) window.sessionStorage.setItem(KEY, hash);
    else window.sessionStorage.removeItem(KEY);
  } catch { /* storage blocked: sign-in lands on the default screen */ }
}

/** The held route, once ("" when none) — read on the way back. */
export function takeReturnRoute(): string {
  try {
    const held = window.sessionStorage.getItem(KEY) ?? "";
    window.sessionStorage.removeItem(KEY);
    return held.startsWith("#/") ? held : "";
  } catch {
    return "";
  }
}
