"use client";
/**
 * Pull down at the top of the page to re-fetch everything on it.
 *
 * Mounted once in the shell; there is nothing per-screen to wire up, because the refresh travels
 * through `refreshAll` and every `useResource` is already subscribed to it.
 *
 * Touch listeners only, so a mouse never sees this and the desktop panel is untouched. The rules
 * that matter are all about NOT firing:
 *
 *   - Only from a page already scrolled to the top, and only on a downward drag.
 *   - Never when the finger started inside something that scrolls on its own. A roster table, the
 *     command palette's list, an open modal — a drag there belongs to that element, and stealing it
 *     to refresh the page would make those lists impossible to scroll back up. Nor inside a surface
 *     that takes drags for itself (touch-action: none): a map that pans under a finger dragged
 *     down it, where the dial rising over the map mid-pan is the page taking a gesture not its own.
 *   - Never behind the drawer or its scrim: pulling on a shaded page is a miss-tap, not a request.
 *   - Never mid-pinch. Two fingers is a zoom.
 *
 * `preventDefault` on the move is what suppresses the browser's own pull-to-refresh, so a pull does
 * this instead of reloading the whole app and losing the view. It is only ever called once the drag
 * has been positively identified as a pull, so ordinary scrolling is never intercepted — which is
 * also why the listener is registered non-passive.
 */
import { useEffect, useRef, useState } from "react";
import { refreshAll } from "../lib/refresh";

/** How far the indicator must travel before releasing counts as a refresh. */
const TRIGGER = 64;
/** The indicator stops moving here however hard the page is pulled. */
const MAX = 96;
/** Finger travel → indicator travel. Under 1 so the pull feels weighted rather than sticky. */
const RESISTANCE = 0.5;
/** Sideways slop allowed before a drag is treated as a horizontal swipe and released. */
const H_SLOP = 24;
/**
 * A refresh that never reports back must not strand the spinner. Nothing should reach this — every
 * resource resolves on its own fetch settling — but a wedged request should degrade to "the
 * indicator went away" rather than "the app looks stuck".
 */
const SAFETY_MS = 15_000;

/** Does this element scroll vertically on its own, or handle drags itself? Then the drag is its
 *  business, not ours. */
function scrollsOwnContent(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.touchAction === "none") return true;
  const overflowY = style.overflowY;
  if (overflowY !== "auto" && overflowY !== "scroll") return false;
  return el.scrollHeight > el.clientHeight + 1;
}

/** Walk up from the touched node looking for a scroller that owns this gesture. */
function insideOwnScroller(start: EventTarget | null): boolean {
  let node = start instanceof Element ? start : null;
  while (node && node !== document.body) {
    if (scrollsOwnContent(node)) return true;
    node = node.parentElement;
  }
  return false;
}

export default function PullToRefresh() {
  // How far the indicator has travelled, in px. 0 = parked.
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  // Set while a drag has been identified as a pull, so move/end know to act on it.
  const pulling = useRef(false);
  const startY = useRef(0);
  const startX = useRef(0);
  // The listeners are registered once and never see a re-render, so "is a refresh already running"
  // lives in a ref they write themselves. `busy` is the same fact for the renderer.
  const busyRef = useRef(false);

  useEffect(() => {
    const reset = () => { pulling.current = false; setPull(0); };

    const onStart = (e: TouchEvent) => {
      pulling.current = false;
      if (busyRef.current || e.touches.length !== 1) return;
      if (window.scrollY > 0) return;
      if (document.querySelector(".app-shell.drawer-open")) return;
      if (insideOwnScroller(e.target)) return;
      const t = e.touches[0]!;
      startY.current = t.clientY;
      startX.current = t.clientX;
      pulling.current = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!pulling.current) return;
      if (e.touches.length !== 1) return reset();
      const t = e.touches[0]!;
      const dy = t.clientY - startY.current;
      const dx = t.clientX - startX.current;
      // Upward, sideways, or the page scrolled under us: this was not a pull after all. Released
      // without preventDefault so the browser still gets to do whatever it was going to do.
      if (dy <= 0 || Math.abs(dx) > H_SLOP || window.scrollY > 0) return reset();
      // Identified. From here the gesture is ours, and the browser's own pull-to-refresh is not
      // allowed to also fire.
      e.preventDefault();
      setPull(Math.min(MAX, dy * RESISTANCE));
    };

    const onEnd = () => {
      if (!pulling.current) return;
      pulling.current = false;
      setPull((current) => {
        if (current < TRIGGER) return 0;
        busyRef.current = true;
        setBusy(true);
        // Parked at the trigger height while it works, so the spinner has somewhere to sit.
        const settled = () => { busyRef.current = false; setBusy(false); setPull(0); };
        let finished = false;
        void refreshAll().then(() => { if (!finished) { finished = true; settled(); } });
        setTimeout(() => { if (!finished) { finished = true; settled(); } }, SAFETY_MS);
        return TRIGGER;
      });
    };

    // Non-passive on move only, because that is the only one that calls preventDefault. The other
    // three stay passive so they cost nothing on every scroll.
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, []);

  const armed = pull >= TRIGGER;
  const visible = pull > 0 || busy;
  return (
    <div
      className={`ptr${visible ? " on" : ""}${busy ? " busy" : ""}${armed ? " armed" : ""}`}
      style={{ transform: `translateX(-50%) translateY(${pull}px)`, opacity: Math.min(1, pull / (TRIGGER * 0.6)) || (busy ? 1 : 0) }}
      role="status"
      aria-live="polite"
    >
      {/* Rotates with the pull, then spins once it is working — the same dial doing both jobs, so
          the transition from "you are pulling" to "it is loading" has no cut. */}
      <span className="ptr-dial" style={busy ? undefined : { transform: `rotate(${(pull / MAX) * 270}deg)` }} />
      <span className="sr-only">{busy ? "Refreshing" : armed ? "Release to refresh" : "Pull to refresh"}</span>
    </div>
  );
}
