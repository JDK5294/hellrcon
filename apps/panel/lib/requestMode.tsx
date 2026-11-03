"use client";
/**
 * Request mode — the cart. While it is on, the app looks and works exactly as it always does,
 * with one promise: NOTHING fires. Every action dialog's confirm captures its validated payload
 * into the user's one server-side draft instead of executing, and the pinned bar keeps the
 * running count until Review & submit — the moment the world actually changes.
 *
 * The draft itself lives in the API (one per user), so a closed laptop loses nothing; this
 * context only remembers that THIS browser is in the mode (localStorage) and mirrors the count.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { onRequestFiled } from "./filed";

interface RequestMode {
  building: boolean;
  count: number;
  /** Enter the mode, creating or resuming (un-parking) the server-side draft. */
  start: () => Promise<void>;
  /** Leave the mode and return to the page the user was on before entering. Used by submit —
   *  for keeping the draft, use save(); for throwing it away, discard(). */
  exit: () => void;
  /** Save draft: PARK it server-side (kept, but no view elevation) and leave. */
  save: () => Promise<void>;
  /** Delete the draft and leave. */
  discard: () => Promise<void>;
  /** A dialog captured a line — the bar's count follows. */
  captured: (lines: number) => void;
  refresh: () => Promise<void>;
}

const noop = async () => {};
const Ctx = createContext<RequestMode>({ building: false, count: 0, start: noop, exit: () => {}, save: noop, discard: noop, captured: () => {}, refresh: noop });
export const useRequestMode = () => useContext(Ctx);

// Session state: lib/api's setToken/clearToken remove both keys on sign-in/out (by literal name),
// so a sign-out never hands the next account an auto-entered builder or a stale return page.
const FLAG = "panel.requestMode";
/**
 * Where to go back to. Entering the mode remembers the page the user was standing on — a page
 * their OWN grants could see, by construction — so every way out (save, discard, submit) can
 * land them somewhere valid instead of leaving them on an elevated page that is about to 403.
 */
const RETURN = "panel.requestMode.return";

export function RequestModeProvider({ children, onBuildingChange }: {
  children: React.ReactNode;
  /**
   * Fired on every enter/leave of the mode, AFTER the server-side draft exists (start POSTs it
   * first). The shell listens to re-read /api/me: an open draft is what carries the request-view
   * elevation, so the nav can only widen once the server would honour the reads it offers.
   */
  onBuildingChange?: (building: boolean) => void;
}) {
  const [building, setBuilding] = useState(false);
  const [count, setCount] = useState(0);

  /*
   * Captures made from screens that never heard of the cart.
   *
   * Every server-scoped write files or captures through one wrapper now, and those screens hand
   * the answer to the shared client rather than to this provider — so the bar's count would have
   * sat still while the request filled up behind it. One subscription keeps the receipt honest,
   * wherever the capture came from.
   */
  useEffect(() => onRequestFiled((n) => {
    if (n.captured) setCount((c) => n.lines ?? c + 1);
  }), []);

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ draft: { lines: unknown[] } | null }>("/requests/draft");
      setCount(r.draft?.lines.length ?? 0);
    } catch { /* the bar shows the last known count until the next capture corrects it */ }
  }, []);

  const start = useCallback(async () => {
    const r = await api<{ draft: { lines: unknown[] } }>("/requests/draft", { method: "POST" });
    setCount(r.draft.lines.length);
    setBuilding(true);
    try {
      // Remember where they came from — but only on a FRESH entry. A page reload mid-build also
      // lands here (the restore effect below), and by then the current page may be one only the
      // elevation can show; overwriting the return with it would exit into a 403.
      if (window.localStorage.getItem(FLAG) !== "1") window.localStorage.setItem(RETURN, window.location.hash || "#/dashboard");
      window.localStorage.setItem(FLAG, "1");
    } catch { /* fine */ }
    onBuildingChange?.(true);
  }, [onBuildingChange]);

  useEffect(() => {
    try {
      // Restoring the mode goes through start(), not just the flag: the POST creates-or-resumes
      // the draft, and the draft is what the view elevation hangs off — a flag alone would put
      // the bar up over a nav that cannot widen.
      if (window.localStorage.getItem(FLAG) === "1") void start().catch(() => refresh());
    } catch { /* private windows */ }
  }, [refresh, start]);

  const exit = useCallback(() => {
    setBuilding(false);
    try {
      window.localStorage.removeItem(FLAG);
      // Back to the page they were on before the mode widened anything — their own view is
      // guaranteed to still show it. The grants refresh (onBuildingChange) collapses the nav.
      const back = window.localStorage.getItem(RETURN);
      window.localStorage.removeItem(RETURN);
      if (back && back !== window.location.hash) window.location.hash = back;
    } catch { /* fine */ }
    onBuildingChange?.(false);
  }, [onBuildingChange]);

  const save = useCallback(async () => {
    // Park, not just hide: a parked draft keeps its lines for next time but confers no view
    // elevation — leaving the builder ENDS the widened view, server-side included.
    await api("/requests/draft/park", { method: "POST" }).catch(() => { /* no draft yet — exit still cleans up */ });
    exit();
  }, [exit]);

  const discard = useCallback(async () => {
    await api("/requests/draft", { method: "DELETE" });
    setCount(0);
    exit();
  }, [exit]);

  const captured = useCallback((lines: number) => setCount(lines), []);

  return <Ctx.Provider value={{ building, count, start, exit, save, discard, captured, refresh }}>{children}</Ctx.Provider>;
}
