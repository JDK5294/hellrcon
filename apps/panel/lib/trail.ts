"use client";
/**
 * THE TRAIL — the app's own back/forward, over the last ten screens this person was on.
 *
 * The browser already has back/forward, so why a second pair? Because the panel jumps around:
 * a name on the Live roster opens a profile, the profile links a match, the match links the map
 * vote — and the browser's buttons sit outside the app on a phone/PWA, mixed in with everything
 * else the tab did (searches, the OAuth bounce, other sites). The trail is only the app: the
 * screens you were on, newest last, capped at ten because "where was I just now" does not need
 * an archive.
 *
 * WHERE IT LIVES: sessionStorage — per tab, survives a refresh, dies with the tab. It is also
 * reset whenever the signed-in identity changes (setToken/clearToken in lib/api.ts call
 * resetTrail), so a shared computer never offers one staff member the previous one's footsteps,
 * and a fresh login always starts clean. That reset is the "per staff member" guarantee; the
 * storage itself only has to be "this sitting".
 *
 * SEMANTICS are the familiar ones: visiting somewhere new while you are back in the middle of
 * the trail drops the forward half (you have chosen a different future), and going back then
 * forward walks the same entries. Entries are hash paths ("/players/vips"), the same strings the
 * router already speaks, so the trail never invents a second way to say where.
 */

const KEY = "panel.trail";
const MAX = 10;

interface Trail {
  entries: string[];
  index: number; // -1 = empty
}

let trail: Trail = { entries: [], index: -1 };
let loaded = false;
/** Set by back()/forward() just before they navigate: the index the next note() should adopt
 *  instead of appending. Cleared by the very next note either way. */
let jumpTo: number | null = null;
const listeners = new Set<() => void>();
/** Bumped on every change — useSyncExternalStore needs a snapshot that changes by identity. */
let version = 0;

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Trail) : null;
    if (parsed && Array.isArray(parsed.entries) && parsed.entries.every((e) => typeof e === "string")) {
      const entries = parsed.entries.slice(-MAX);
      const index = Math.min(Math.max(-1, Number(parsed.index)), entries.length - 1);
      trail = { entries, index };
    }
  } catch {
    /* a torn write reads as an empty trail, never as a crash */
  }
}

function save(): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(trail));
  } catch {
    /* storage full or blocked: the trail still works in memory for this page's lifetime */
  }
}

function changed(): void {
  version += 1;
  save();
  for (const l of listeners) l();
}

/** The router reports every arrival here (nav.tsx). Idempotent for the screen already on top. */
export function trailNote(path: string): void {
  load();
  // Arriving where back()/forward() said we were going is a MOVE along the trail, not a visit.
  if (jumpTo !== null && trail.entries[jumpTo] === path) {
    trail = { ...trail, index: jumpTo };
    jumpTo = null;
    changed();
    return;
  }
  jumpTo = null; // a different arrival supersedes the pending jump (redirects, races)
  if (trail.entries[trail.index] === path) return; // re-render of the same screen, not a visit
  const entries = [...trail.entries.slice(0, trail.index + 1), path].slice(-MAX);
  trail = { entries, index: entries.length - 1 };
  changed();
}

/** The path one step back, and the bookkeeping to treat the next arrival as that step — or null
 *  at the start of the trail. The caller does the actual navigation (it owns the hash). */
export function trailBack(): string | null {
  load();
  if (trail.index <= 0) return null;
  jumpTo = trail.index - 1;
  return trail.entries[jumpTo] ?? null;
}

export function trailForward(): string | null {
  load();
  if (trail.index < 0 || trail.index >= trail.entries.length - 1) return null;
  jumpTo = trail.index + 1;
  return trail.entries[jumpTo] ?? null;
}

/** Called on every identity change (login, logout, session expiry) — see lib/api.ts. */
export function resetTrail(): void {
  loaded = true; // an explicit reset must not be overwritten by a later lazy load
  // "You are here" is the natural first entry of an empty trail. Without it, a reset that fires
  // while the app is already mounted (the Discord sign-in handoff) leaves the CURRENT screen
  // unrecorded — the router only notes arrivals, and staying put is not one — so the first
  // navigation afterwards had nothing to go back to. A fragment that is not a route (the OAuth
  // token) seeds nothing, matching the router's own reading of it.
  const here = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
  const entries = here.startsWith("/") ? [here] : [];
  trail = { entries, index: entries.length - 1 };
  jumpTo = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear is fine */
  }
  version += 1;
  for (const l of listeners) l();
}

export interface TrailState {
  canBack: boolean;
  canForward: boolean;
  /** the path each button would go to (for tooltips); null when it cannot. */
  backPath: string | null;
  forwardPath: string | null;
}

export function trailState(): TrailState {
  load();
  return {
    canBack: trail.index > 0,
    canForward: trail.index >= 0 && trail.index < trail.entries.length - 1,
    backPath: trail.index > 0 ? trail.entries[trail.index - 1] ?? null : null,
    forwardPath: trail.index < trail.entries.length - 1 ? trail.entries[trail.index + 1] ?? null : null,
  };
}

/** Subscription for React (components/TrailNav.tsx uses this via useSyncExternalStore). */
export function subscribeTrail(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function trailVersion(): number {
  return version;
}

/** Test seam: the whole state, read-only. */
export function trailEntries(): { entries: string[]; index: number } {
  load();
  return { entries: [...trail.entries], index: trail.index };
}
