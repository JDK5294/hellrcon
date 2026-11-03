"use client";
/**
 * The app's own back/forward pair — the visible half of lib/trail.ts.
 *
 * Rendered twice: in the sidebar above search (desktop) and on the phone topbar. Both are the
 * same two buttons: disabled when the trail has nothing in that direction, and the tooltip names
 * the screen the click would land on, because an arrow that won't say where it goes is a gamble,
 * not a control.
 *
 * Navigation happens by setting the hash — the same door every other navigation uses — so the
 * router's own arrival handling (including telling the trail this was a MOVE, not a new visit)
 * needs no special case for us.
 */
import { useSyncExternalStore } from "react";
import { subscribeTrail, trailBack, trailForward, trailState, trailVersion } from "../lib/trail";
import { locationFromPath, routeById } from "../lib/routes";

/** "Back to VIPs", from the path the button would go to. */
function titleOf(path: string | null): string | null {
  if (!path) return null;
  const loc = locationFromPath(path);
  const tab = loc.tab ? routeById(`${loc.view}.${loc.tab}`) : undefined;
  const view = routeById(loc.view);
  return tab?.title ?? view?.title ?? null;
}

export function TrailNav({ className = "" }: { className?: string }) {
  // Subscribe by version (a changing number), then read the real state: useSyncExternalStore
  // wants a snapshot that is referentially stable between changes, which the number is and a
  // freshly-built object is not.
  useSyncExternalStore(subscribeTrail, trailVersion, trailVersion);
  const s = trailState();
  const go = (path: string | null) => {
    if (path) window.location.hash = `#${path}`;
  };
  const backTitle = titleOf(s.backPath);
  const fwdTitle = titleOf(s.forwardPath);
  return (
    <div className={`trail-nav ${className}`.trim()} role="group" aria-label="Recently visited screens">
      <button
        type="button"
        className="trail-btn"
        disabled={!s.canBack}
        onClick={() => go(trailBack())}
        title={backTitle ? `Back to ${backTitle}` : "Nothing to go back to"}
        aria-label={backTitle ? `Back to ${backTitle}` : "Back"}
      >
        ←
      </button>
      <button
        type="button"
        className="trail-btn"
        disabled={!s.canForward}
        onClick={() => go(trailForward())}
        title={fwdTitle ? `Forward to ${fwdTitle}` : "Nothing to go forward to"}
        aria-label={fwdTitle ? `Forward to ${fwdTitle}` : "Forward"}
      >
        →
      </button>
    </div>
  );
}
