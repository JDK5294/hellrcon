"use client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The menu (the sidebar's list of screens) and the window it sits in.
 *
 * The sidebar is one column the height of the window: the brand and Search at the top, the menu,
 * then the host status, the server picker and the account row pinned at the foot. When the menu is
 * longer than the room between them it scrolls in place — and on a laptop it always was: 1366 × 768
 * leaves a browser about 650px, and the menu with an open section's tabs needed twice that. Nothing
 * moved it to the screen you were on, so opening Administration from Search left its entry and all
 * of its tabs below the edge, with nothing to say where you were. Now the menu packs itself into
 * the room it has, and scrolls to the open screen when even that is not enough.
 */

/**
 * The scroll position that shows [top, bottom] (measured from the top of the list) in a view
 * `height` tall, now scrolled to `scrollTop`: unchanged when it is already in view, else the least
 * move — and never so far that its top leaves the view.
 */
export function scrollToShow(scrollTop: number, height: number, top: number, bottom: number): number {
  if (top < scrollTop) return top;
  if (bottom > scrollTop + height) return Math.min(top, bottom - height);
  return scrollTop;
}

/**
 * Where to scroll the menu for the open screen, given its entry's span (its name and the tabs listed
 * under it) and the open tab's (the name's own, for a screen without tabs), each measured from the top
 * of the list. The whole entry when it fits, by the least move. When it does not — Administration has
 * thirteen tabs — its name at the top with as many tabs under it as fit, the open one among them; and
 * when even the name and the open tab are too far apart for one view, the open tab, which matters more.
 * Whatever is already in view stays put, so stepping through the tabs never jolts the list.
 */
export function menuScrollTop(scrollTop: number, height: number, entry: [number, number], open: [number, number]): number {
  const shown = (top: number, bottom: number) => top >= scrollTop && bottom <= scrollTop + height;
  if (entry[1] - entry[0] <= height) return scrollToShow(scrollTop, height, entry[0], entry[1]);
  if (open[1] - entry[0] <= height) return shown(entry[0], open[1]) ? scrollTop : entry[0];
  return scrollToShow(scrollTop, height, open[0], open[1]);
}

/**
 * Scroll the menu to the open screen's entry, with the tabs listed under it. The menu scrolls in
 * place; on a window too short for that (under 560px, globals.css) the whole sidebar scrolls as one
 * column instead, and it is the sidebar that moves. Off — the phone's drawer, which scrolls as one
 * too — nothing does: each of its openers already lands where it is for (app/page.tsx, openDrawer).
 */
export function keepActiveInView(aside: HTMLElement, off = false): void {
  const nav = aside.querySelector<HTMLElement>(".nav");
  const item = nav?.querySelector<HTMLElement>(".nav-item.active");
  const entry = item?.closest<HTMLElement>(".nav-entry");
  const view = off ? undefined : [nav, aside].find((el) => el && el.scrollHeight > el.clientHeight);
  if (!view || !item || !entry) return;
  const origin = view.getBoundingClientRect().top - view.scrollTop;
  const span = (el: HTMLElement): [number, number] => {
    const r = el.getBoundingClientRect();
    return [r.top - origin, r.bottom - origin];
  };
  view.scrollTop = menuScrollTop(view.scrollTop, view.clientHeight, span(entry), span(entry.querySelector<HTMLElement>(".nav-subitem.active") ?? item));
}

/**
 * How the menu tightens, a step at a time, each kept as the next is added. `snug`: less air
 * everywhere. `tight`: the host status on one line, a slimmer account row, and no heading over a
 * section of one entry. `lines`: every heading drawn as a thin rule, the rows tighter still.
 * `tabs-above`: the open section's tabs left to the page's own tab bar — taken only when that bar
 * shows every one of them, since a bar that hides some past its edge is why they are listed here.
 * The stylesheet draws each step (globals.css, "the menu fits its window").
 */
export const FIT_STEPS = ["snug", "tight", "lines", "tabs-above"] as const;

/** How many steps to take: the fewest whose menu needs no more than `room` (`needs[k]` is the
 *  height with k steps taken), or every one measured when none is enough. */
export function stepsToFit(needs: readonly number[], room: number): number {
  const k = needs.findIndex((n) => n <= room);
  return k === -1 ? needs.length - 1 : k;
}

/** The height the sidebar needs as drawn now: the menu at its full length rather than the
 *  length its scroll cut it to, and without the spacer that fills the room a short one leaves. */
function heightNeeded(aside: HTMLElement, nav: HTMLElement): number {
  const spacer = aside.querySelector<HTMLElement>(".sidebar-spacer");
  return aside.scrollHeight - (spacer?.offsetHeight ?? 0) - nav.clientHeight + nav.scrollHeight;
}

/** Whether the open page's tab bar shows every one of its tabs. No bar found counts as no. */
function pageTabsAllShown(): boolean {
  const strip = document.querySelector<HTMLElement>(".hub-tabs .tabbar");
  return !!strip && strip.scrollWidth <= strip.clientWidth + 1;
}

/**
 * Tighten the menu as far as `room` needs and no further, and mark the steps taken on the sidebar
 * (`data-fit`). `room` is the height to fit, the sidebar's own unless one is given. Off — the
 * phone's drawer, one list that scrolls with room for a thumb — it takes none. Returns the steps.
 */
export function fitMenu(aside: HTMLElement, off: boolean, room?: number | null): string {
  const nav = aside.querySelector<HTMLElement>(".nav");
  const take = (steps: readonly string[]) => {
    if (steps.length) aside.dataset.fit = steps.join(" ");
    else delete aside.dataset.fit;
  };
  if (off || !nav) { take([]); return ""; }
  const steps = FIT_STEPS.filter((s) => s !== "tabs-above" || (aside.querySelector(".nav-subnav") && pageTabsAllShown()));
  const fit = room ?? aside.clientHeight;
  // Each step is tried in turn to measure it, and through each try the browser holds what is in view
  // steady by moving the scroll (scroll anchoring) — moves that did not always undo, so a menu
  // someone had scrolled part way crept a few pixels at every fit. Both scrolls go back after.
  const navTop = nav.scrollTop, asideTop = aside.scrollTop;
  const heights: number[] = [];
  for (let k = 0; k <= steps.length; k++) {
    take(steps.slice(0, k));
    heights.push(heightNeeded(aside, nav));
    if (heights[k] <= fit) break;
  }
  const chosen = steps.slice(0, stepsToFit(heights, fit));
  take(chosen);
  nav.scrollTop = navTop;
  aside.scrollTop = asideTop;
  return chosen.join(" ");
}

/**
 * What a taskbar and a browser's tabs and address bar take from a screen's height, about: a
 * maximized window on a 1366 × 768 laptop leaves the page some 650px.
 */
export const BROWSER_FRAME = 120;

/** The height to pack the menu into for a screen picked in Settings, or null for "auto" — the
 *  window's own height, measured as it changes. */
export function screenRoom(size: string): number | null {
  const height = /^\d+x(\d+)$/.exec(size)?.[1];
  return height ? Number(height) - BROWSER_FRAME : null;
}

/** Window events that can change what the menu has room for: the window's width (which decides
 *  whether a page's tab bar shows every tab), the text size or screen picked in Settings, and a
 *  page's tab bar arriving, leaving, or starting to show every tab. */
const WATCHED = ["resize", "panel:prefs", "panel:tabbar"] as const;

/**
 * Keep the menu fitted, and the open screen in view, as its room or its entries change under it: the
 * window resized, entries arrived (a plugin's page, a permission), the server picker or the host
 * status filled in below it — on a fresh load they arrive after the first scroll — the text size or
 * the screen size changed, a page's tab bar found it shows every tab. The open screen is scrolled back
 * into view only when the fit or the height of the menu or the sidebar changed — the sidebar's for a
 * window too short for the menu to scroll on its own — so a menu someone scrolled by hand to look
 * further down stays where they left it. `epoch` is whatever remounts the sidebar.
 */
export function useMenuWatch(asideRef: RefObject<HTMLElement | null>, off: boolean, room: number | null, epoch: string): void {
  // Read through a ref, so a watch already on its way uses the choice just made, not the one before.
  const latest = useRef({ off, room });
  useLayoutEffect(() => { latest.current = { off, room }; });
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    let frame = 0;
    const heights = () => `${aside.querySelector<HTMLElement>(".nav")?.clientHeight ?? 0} ${aside.clientHeight}`;
    let height = heights();
    const watch = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const before = aside.dataset.fit ?? "";
        const fit = fitMenu(aside, latest.current.off, latest.current.room);
        const now = heights();
        if (fit !== before || now !== height) keepActiveInView(aside, latest.current.off);
        height = now;
      });
    };
    const resized = new ResizeObserver(watch);
    resized.observe(aside);
    const changed = new MutationObserver(watch);
    changed.observe(aside, { childList: true, subtree: true, characterData: true });
    for (const name of WATCHED) window.addEventListener(name, watch);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      changed.disconnect();
      for (const name of WATCHED) window.removeEventListener(name, watch);
    };
  }, [asideRef, epoch]);
}
