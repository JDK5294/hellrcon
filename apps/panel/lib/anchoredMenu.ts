"use client";
/**
 * Position a dropdown against its trigger in VIEWPORT coordinates, so no ancestor can clip it.
 *
 * The roster's ⋯ menus live inside `.scroll-x.roster`, which is `overflow-y: auto` with a
 * max-height — and an absolutely-positioned child of a scroll container is clipped by it. On a
 * full server nobody noticed, because the container is tall and the menu fits. On a short roster
 * the container is only as tall as its few rows, so a nine-item menu opened from the header
 * extended well past the bottom edge: cut off on screen, and — because layout still put the items
 * down there — clicks aimed at them landed on whatever panel occupied that space instead.
 *
 * `position: fixed` takes the menu out of every ancestor's flow and clipping. The cost is that
 * fixed coordinates do not follow a scroll, so this recomputes on scroll and resize while open,
 * and the menu simply closes if its trigger scrolls out of view.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AnchoredMenu {
  /** Put this on the trigger button. */
  ref: React.RefObject<HTMLButtonElement | null>;
  /** Put this on the dropdown — it is what tells an outside tap from an inside one. */
  menuRef: React.RefObject<HTMLDivElement | null>;
  /** Spread onto the dropdown. */
  style: React.CSSProperties;
}

const MARGIN = 8;

export function useAnchoredMenu(open: boolean, onClose: () => void): AnchoredMenu {
  const ref = useRef<HTMLButtonElement | null>(null);
  const menuEl = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed", visibility: "hidden" });

  /**
   * The callback lives in a ref, and this is load-bearing rather than tidiness.
   *
   * Callers pass an inline arrow — `useAnchoredMenu(open, () => setMenu(false))` — which is a new
   * function on every render. Depending on it directly makes `place` new every render, which makes
   * the layout effect below re-run every render, which calls setStyle, which renders again: an
   * infinite loop that takes the whole panel down, not just the menu. Reading it through a ref
   * keeps `place` stable while still calling whatever the latest render passed.
   *
   * The write happens in an effect, not during render — a render can be thrown away or replayed,
   * and a ref written on a discarded render would outlive it. This effect is declared before the
   * ones that read the ref so it runs first on every commit.
   */
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Gone from view (the row scrolled away): a menu floating over unrelated content is worse
    // than no menu.
    if (r.bottom < 0 || r.top > window.innerHeight) { closeRef.current(); return; }
    // Below the trigger by default; above it when there is more room up there. The menu's own
    // height is not known until it renders, so this uses the space available rather than
    // measuring — enough to keep it on screen without a second layout pass.
    const below = window.innerHeight - r.bottom;
    const openUp = below < 240 && r.top > below;
    setStyle({
      position: "fixed",
      left: Math.max(MARGIN, Math.min(r.left, window.innerWidth - 210)),
      ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      maxHeight: (openUp ? r.top : below) - MARGIN,
      overflowY: "auto",
      visibility: "visible",
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) { setStyle({ position: "fixed", visibility: "hidden" }); return; }
    place();
    // `true` for capture: the scroll that matters is the roster container's, not the window's,
    // and a scroll event on an inner element does not bubble.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  /**
   * Tap anywhere else and the menu goes away.
   *
   * This is the whole reason the menu is dismissible on a phone. The dropdown closes itself on
   * `onMouseLeave`, which is a pointer leaving a box — an event a touchscreen never sends. On a
   * desktop that was invisible; on a phone the menu opened and then stayed, a permanent panel
   * covering the page with no way off it but picking one of its items. Escape does not help
   * either: there is no keyboard.
   *
   * `pointerdown`, not `click`, so it goes the instant a finger lands rather than on release. In
   * the capture phase so a handler underneath cannot stop it from ever arriving. Taps inside the
   * menu or on the trigger are excluded — the first would close the menu before its own item
   * could fire, and the second would fight the trigger's toggle and leave it looking dead.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuEl.current?.contains(t) || ref.current?.contains(t)) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  return { ref, menuRef: menuEl, style };
}
