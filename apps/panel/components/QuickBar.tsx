"use client";
/**
 * The phone's quick bar: the screens each person uses most, one tap away from any screen, and More,
 * which opens the whole menu. Without it a phone reached every screen through the menu — open it,
 * then pick.
 *
 * Which buttons it holds, and in what order, is each person's choice in Settings → Workspace — any
 * screen or hub tab they can open, and Search — kept with their other preferences (lib/userPrefs:
 * Live, Players, Bans and Search until they choose). Where it sits, along the bottom (the default,
 * where a thumb is), pinned at the top, or not at all, is the same person's choice, applied as an
 * attribute on <html> (applyPhoneBar), so the stylesheet does the placing and a change moves it at
 * once. Its measured height is published as `--quick-bar-h`, the way the request bar publishes its
 * own, so the page ends above it — and a hub's tab bar pins under it — rather than being covered. A
 * screen the account cannot open is left out; More always stays.
 */
import { useEffect, useRef, useState } from "react";
import { Icon, hasIcon } from "./icons";
import { routeById } from "../lib/routes";
import { readUserPrefs } from "../lib/userPrefs";

/** The buttons this person chose, kept in step with the choice: Settings and the account both write
 *  through lib/userPrefs, which says so with a "panel:prefs" event. */
function usePhoneBarItems(): string[] {
  const [items, setItems] = useState<string[]>(() => readUserPrefs().phoneBarItems);
  useEffect(() => {
    const read = () => setItems(readUserPrefs().phoneBarItems);
    read();
    window.addEventListener("panel:prefs", read);
    return () => window.removeEventListener("panel:prefs", read);
  }, []);
  return items;
}

/** Keeps what is pinned along the bottom at the screen's bottom when an iPhone loses track of it.
 *  Once its keyboard has been up, iOS can leave the pinned layer where the keyboard left it (WebKit
 *  bug 297779): the bar stays where the page was and scrolls with it, mid-screen, while
 *  visualViewport.offsetTop says how far the screen's top has moved off the layer's. That distance
 *  is published as `--vv-shift`, with data-vv-shift on <html> while it is not zero, and the
 *  stylesheet moves the bar — and the request bar and messages over it — down by it, back to the
 *  screen's bottom edge. With the keyboard up the same distance holds the bar at that edge, under
 *  the keyboard, rather than over the page above it. Everywhere else the distance is zero, so
 *  nothing moves; and zoomed in, the screen moving over the page is the zoom, so it is left alone. */
function usePinnedToScreen() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    if (!vv) return;
    let shown = 0;
    const place = () => {
      const shift = Math.abs(vv.scale - 1) > 0.01 ? 0 : Math.round(vv.offsetTop);
      if (shift === shown) return;
      shown = shift;
      if (shift) { root.style.setProperty("--vv-shift", `${shift}px`); root.setAttribute("data-vv-shift", ""); }
      else { root.style.removeProperty("--vv-shift"); root.removeAttribute("data-vv-shift"); }
    };
    place();
    vv.addEventListener("resize", place);
    vv.addEventListener("scroll", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      vv.removeEventListener("resize", place);
      vv.removeEventListener("scroll", place);
      window.removeEventListener("scroll", place);
      root.style.removeProperty("--vv-shift");
      root.removeAttribute("data-vv-shift");
    };
  }, []);
}

interface Button { key: string; label: string; icon?: string; view?: string; tab?: string; open: () => void }

export function QuickBar({ view, tab, can, go, onSearch, onMore }: {
  view: string;
  tab?: string;
  /** May this account open the route with this id? */
  can: (routeId: string) => boolean;
  go: (view: string, target?: undefined, tab?: string) => void;
  onSearch: () => void;
  onMore: () => void;
}) {
  const bar = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = bar.current;
    const root = document.documentElement;
    if (!el) return;
    const set = () => root.style.setProperty("--quick-bar-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--quick-bar-h"); };
  }, []);
  usePinnedToScreen();

  const items = usePhoneBarItems();
  const buttons: Button[] = items.flatMap((id): Button[] => {
    if (id === "search") return [{ key: id, label: "Search", open: onSearch }];
    const r = routeById(id);
    if (!r || !can(id)) return [];
    const v = r.parent ?? r.id;
    const t = r.parent ? r.id.slice(r.parent.length + 1) : undefined;
    // A tab wears its own glyph where it has one (Bans, VIPs), else its screen's.
    return [{ key: id, label: r.title, icon: t && hasIcon(t) ? t : v, view: v, tab: t, open: () => go(v, undefined, t) }];
  });
  // The screen you are on: one of your tabs exactly, else the screen it belongs to.
  const here = buttons.find((b) => b.view === view && b.tab !== undefined && b.tab === tab)
    ?? buttons.find((b) => b.view === view && b.tab === undefined);

  return (
    <nav className="quick-bar" aria-label="Quick bar" ref={bar}>
      {buttons.map((b) => {
        const on = b === here;
        return (
          <button key={b.key} type="button" className={`quick-btn${on ? " on" : ""}`} data-route={b.key} aria-current={on ? "page" : undefined} onClick={b.open}>
            {b.icon ? <Icon name={b.icon} /> : <span className="quick-ico" aria-hidden>⌕</span>}<span>{b.label}</span>
          </button>
        );
      })}
      <button type="button" className="quick-btn" onClick={onMore}><span className="quick-ico" aria-hidden>☰</span><span>More</span></button>
    </nav>
  );
}
