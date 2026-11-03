/**
 * Screens load on demand, so a panel updated under an open tab leaves that tab asking for screen
 * files that are gone. These decide what ScreenBoundary does about it: recognise that failure, and
 * allow one reload a minute for it — a second failure inside the window stays on screen instead
 * of reloading forever.
 */
export const RELOADED_KEY = "panel.screen.reloadedAt";
export const RELOAD_WINDOW_MS = 60_000;

/** A screen's code that could not be fetched — webpack's ChunkLoadError, or the browser's own
 *  words for a dynamic import that failed (Chrome / Firefox, then Safari). */
export function isChunkLoadError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "ChunkLoadError"
    || /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(e.message);
}

/** True the first time in a window — the page may reload for a missing screen file once. Storage
 *  that throws (private mode, blocked site data) says no: better a Reload button than a loop. */
export function mayReload(store: Pick<Storage, "getItem" | "setItem"> | null, now = Date.now()): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(RELOADED_KEY) ?? 0);
    if (now - last < RELOAD_WINDOW_MS) return false;
    store.setItem(RELOADED_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
