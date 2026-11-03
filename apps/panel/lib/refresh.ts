"use client";
/**
 * "Everything on this screen, again" — one signal, every resource.
 *
 * Pull-to-refresh has no idea what is on screen. The Live view holds a roster and a feed, a player
 * profile holds eight panels, and each of them owns its own loader; a gesture at the top of the page
 * cannot reach into any of that. So instead of the gesture knowing about screens, the screens know
 * about the gesture: `useResource` subscribes here once, and every resource anywhere in the tree
 * re-fetches together without a single screen opting in.
 *
 * `refreshAll` resolves when they have all settled, which is what lets the spinner stay up until the
 * data is actually there. A refresh indicator that hides on a timer is a decoration — it says
 * "done" while the request it started is still in flight, and the one moment a user is watching it
 * is the moment they suspect the numbers are stale.
 */
import { useEffect } from "react";

type Handler = () => Promise<void> | void;

const handlers = new Set<Handler>();

/** Register a re-fetch. Returns the unsubscribe, so it drops straight out of a `useEffect`. */
export function onRefreshAll(handler: Handler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

/**
 * Ask everything mounted to fetch again; resolves once every subscriber has finished (or failed).
 *
 * `allSettled`, not `all`: one screen whose request 500s must not leave the others' spinner up
 * forever. A failed resource paints its own error — that is not this function's business.
 */
export async function refreshAll(): Promise<void> {
  await Promise.allSettled([...handlers].map((h) => h()));
}

/** How many resources are currently subscribed. Only used by tests. */
export function refreshSubscriberCount(): number {
  return handlers.size;
}

/**
 * Join the refresh for a screen that loads its own data.
 *
 * `useResource` subscribes on its own, but a good half of the panel predates it and still hand-rolls
 * a `useCallback` loader with a `useEffect` beside it. Those screens are not broken and rewriting
 * them all to chase this feature would be a much bigger change than the feature deserves — so they
 * opt in with one line instead:
 *
 *     useRefreshable(load);
 *
 * `load` must be stable (it already is — it is the same `useCallback` the mount effect uses), and
 * returning its promise is what keeps the pull indicator up until the data has actually landed.
 */
export function useRefreshable(load: (() => Promise<unknown> | void) | null | undefined): void {
  useEffect(() => {
    if (!load) return;
    return onRefreshAll(() => { const r = load(); return r instanceof Promise ? r.then(() => {}) : undefined; });
  }, [load]);
}
