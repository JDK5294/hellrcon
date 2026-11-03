"use client";
/**
 * App navigation — where you are, and how to go somewhere else.
 *
 * The panel used to hold its location in a single `useState`, which meant it had no location at
 * all: you couldn't bookmark a screen, couldn't send a colleague a link to it, the browser's back
 * button left the app entirely, and a refresh always dumped you back on the dashboard. Every
 * destination now lives at a real URL under the hash (`#/players/vips`), so all four of those work
 * and the breadcrumb can be derived from where you actually are.
 *
 * The hash is used rather than real paths on purpose: the panel is a static bundle served at "/",
 * so a deep path like /players/vips would 404 on refresh unless the host rewrote it. A hash never
 * reaches the server, so deep links work anywhere this is deployed.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RecentTarget } from "./recent";
import { SUBJECT_FIELD, locationFromPath, pathFor, routeById } from "./routes";
import { APP_NAME } from "./brand";
import { trailNote } from "./trail";

export interface AppNav {
  /** the destination currently on screen. */
  view: string;
  /** the active tab within it, when it has tabs. */
  tab?: string;
  /** the one thing this screen is about, when it is about one thing (a player id, a match id). */
  subject?: string;
  /** Navigate. `target` deep-links a subject (e.g. open one player's profile); `tab` picks a tab. */
  go: (view: string, target?: RecentTarget, tab?: string) => void;
  /** Switch tab within the current destination (writes the URL, so it's linkable + back-able). */
  setTab: (tab: string) => void;
}

const Ctx = createContext<AppNav>({ view: "dashboard", go: () => {}, setTab: () => {} });
export const AppNavProvider = Ctx.Provider;
export function useAppNav() { return useContext(Ctx); }

const readHash = (): { view: string; tab?: string; subject?: string } => {
  if (typeof window === "undefined") return { view: "dashboard" };
  const h = window.location.hash.replace(/^#/, "");
  // A hash carrying OAuth handoff params (discord_token=…) is not a route — ignore it and let the
  // shell consume it; we land on the default view.
  if (!h || !h.startsWith("/")) return { view: "dashboard" };
  return locationFromPath(h);
};

/** The URL holds one opaque subject id; hand it back as the field that destination expects. */
function targetFrom(view: string, subject?: string): RecentTarget | null {
  if (!subject) return null;
  const field = SUBJECT_FIELD[view];
  return field ? ({ [field]: subject } as RecentTarget) : null;
}

/** …and the inverse: which id of a target this destination puts in its URL. */
function subjectFrom(view: string, target?: RecentTarget | null): string | undefined {
  if (!target) return undefined;
  const field = SUBJECT_FIELD[view];
  return field ? (target as Record<string, string | undefined>)[field] : undefined;
}

/**
 * Owns the location. Returns the current view/tab plus navigation helpers, and keeps the URL and
 * the document title in step with both.
 */
export function useHashRoute(fallbackView = "dashboard") {
  const [loc, setLoc] = useState<{ view: string; tab?: string; subject?: string }>({ view: fallbackView });

  // Adopt the URL on mount (the first render can't read it safely), then follow back/forward.
  useEffect(() => {
    // The URL is the whole location, subject included, so following it can't drop anything.
    const sync = () => setLoc(readHash());
    const hash = window.location.hash;
    if (hash.startsWith("#/")) {
      setLoc(readHash());
    } else {
      /*
       * No route in the URL → land on the caller's preferred view. Rewrite the URL ONLY when the
       * fragment is empty, because a fragment that is not a route is not necessarily nothing.
       *
       * Discord sign-in hands the session token back as `…/#discord_token=…` and the shell reads
       * it out of the fragment on boot. Both effects run on the same mount and this one is
       * registered first (page.tsx calls useHashRoute above the consumer), so replacing the hash
       * here destroyed the token before anything read it: sign-in completed, the answer was
       * discarded on arrival, and the user was returned to the sign-in screen with no error shown
       * and nothing in the logs. `readHash` already declines to route on such a fragment — this is
       * the other half of leaving it alone.
       *
       * The shell clears it itself once spent, so a session token never lingers in history.
       */
      if (!hash || hash === "#") window.history.replaceState(null, "", `#${pathFor(fallbackView)}`);
      setLoc({ view: fallbackView });
    }
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopt the landing view once, at boot
  }, []);

  // Keep the tab title useful: it names the screen you're on, so a pinned browser tab is identifiable.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const view = routeById(loc.view);
    const tab = loc.tab ? routeById(`${loc.view}.${loc.tab}`) : undefined;
    document.title = [tab?.title, view?.title, APP_NAME].filter(Boolean).join(" · ");
  }, [loc]);

  // Every arrival feeds the app's own back/forward trail — HERE, on the committed location,
  // rather than in go(): a screen reached by the browser's buttons, a deep link, or the command
  // palette is a place you were just as much as one reached by clicking the nav. Not the first
  // render's location, though: that is the fallback this starts on before the URL is read, and the
  // effect above always sets the real one, which lands here next. Noted, it put a Dashboard nobody
  // had visited into the trail on every refresh, and Back went there.
  const adopted = useRef(false);
  useEffect(() => {
    if (!adopted.current) { adopted.current = true; return; }
    trailNote(pathFor(loc.view, loc.tab, loc.subject));
  }, [loc]);

  const go = useCallback((view: string, t?: RecentTarget, tab?: string) => {
    const subject = subjectFrom(view, t);
    setLoc({ view, tab, subject });
    const next = `#${pathFor(view, tab, subject)}`;
    if (window.location.hash !== next) window.location.hash = next;
  }, []);

  // Changing tab drops the subject: you are asking for the tab's list, not the one thing you were
  // looking at inside it.
  const setTab = useCallback((tab: string) => {
    setLoc((cur) => {
      const next = `#${pathFor(cur.view, tab)}`;
      if (window.location.hash !== next) window.location.hash = next;
      return { view: cur.view, tab };
    });
  }, []);

  return { view: loc.view, tab: loc.tab, subject: loc.subject, target: targetFrom(loc.view, loc.subject), go, setTab };
}
