/**
 * Where a walkthrough step points — found on the page by the words a person sees.
 *
 * One function answers it for three callers that must agree: the live spotlight ("Show me on my
 * screen"), the script that renders each step's picture, and the browser test that fails when a
 * step's button has gone. The last two run it inside a page they drive from Node, so it is written
 * to travel: no imports, nothing from the module around it, every helper inside it. Its source is
 * handed to the page as text.
 *
 * The spotlight and the pictures also agree on how a control is shown, by two more written the same
 * way: bringWalkTargetIntoView scrolls to it, and walkTargetBox is the part of it the ring goes round.
 */

/** What a step points at. Words before selectors: a step reads like the screen it describes. */
export interface WalkTarget {
  /** A screen's entry in the menu, by its route id: "live", "players.vips". */
  nav?: string;
  /** A tab in the page's tab bar, by its label. */
  tab?: string;
  /** A panel, by its title (what follows it, " (16)", " · [ABC]" or a name in quotes, aside), or a
   *  named part of a screen that is not a panel. Alone it is the target; with a button or field, it
   *  is where to look. */
  panel?: string;
  /** Look inside the open dialog rather than the page. */
  dialog?: boolean;
  /** A button, by the words on it (or the name an icon-only button carries). Matches the start. */
  button?: string;
  /** A form field, by the words of its label. Matches the start. */
  field?: string;
  /** A setting's card (a switch with its title and explanation), by its title. Matches the start. */
  setting?: string;
  /** A CSS selector, for what has no words of its own (a row's ⋯ button). */
  css?: string;
  /** Which of several matches (0, the first, when absent). */
  nth?: number;
}

/**
 * The element a target names, or null when it is not on the page (or not visible). With `every`,
 * all of them, those in the window first: a step pointing at "a row's ⋯" is about any row's.
 */
export function findWalkTarget(t: WalkTarget): HTMLElement | null;
export function findWalkTarget(t: WalkTarget, every: true): HTMLElement[];
export function findWalkTarget(t: WalkTarget, every = false): HTMLElement | HTMLElement[] | null {
  const words = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const shown = (el: Element) => {
    if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const visible = (list: Iterable<Element>) => [...list].filter(shown) as HTMLElement[];

  // Where to look: the dialog on top, then the panels named (two can share a title), else the page.
  let scope: ParentNode = document;
  if (t.dialog) {
    const dialogs = visible(document.querySelectorAll('[role="dialog"]'));
    const top = dialogs[dialogs.length - 1];
    if (!top) return every ? [] : null;
    scope = top;
  }
  let scopes: ParentNode[] = [scope];
  if (t.panel) {
    // A panel by its name, which a count, a choice or what it is about may follow ("Every map (16)",
    // "Players · [ABC]", 'Painting "Fight Club"'): those differ from one server to the next, and the
    // name does not. A part of a screen that is not a panel is found by the name it carries.
    const want = t.panel;
    const named = (title: string) => title === want || title.startsWith(`${want} (`) || title.startsWith(`${want} · `) || title.startsWith(`${want} "`);
    scopes = visible(scope.querySelectorAll('.panel, [role="region"][aria-label]')).filter((p) => {
      const title = p.matches(".panel") ? p.querySelector(".panel-title") : null;
      return named(title ? words(title) : p.getAttribute("aria-label") ?? "");
    });
    if (!scopes.length) return every ? [] : null;
  }
  const within = (selector: string) => scopes.flatMap((s) => visible(s.querySelectorAll(selector)));

  let found: HTMLElement[] = [];
  if (t.nav) {
    found = within(`[data-route="${t.nav}"]`);
  } else if (t.tab) {
    found = within('[role="tab"]').filter((el) => words(el) === t.tab);
  } else if (t.button) {
    const want = t.button;
    found = within('button, a[href], [role="button"]').filter((el) =>
      words(el).startsWith(want) || (el.getAttribute("aria-label") ?? "").startsWith(want));
  } else if (t.field) {
    const want = t.field;
    found = within("label").filter((el) => words(el).startsWith(want));
  } else if (t.setting) {
    const want = t.setting;
    found = within(".setting-card").filter((el) => words(el.querySelector(".setting-title") ?? el).startsWith(want));
  } else if (t.css) {
    found = within(t.css);
  } else if (t.dialog || t.panel) {
    // Nothing narrower named: the dialog, or the first panel of that title.
    const self = scopes[0];
    if (every) return self instanceof HTMLElement ? [self] : [];
    return self instanceof HTMLElement ? self : null;
  }
  // What is on the screen first: on a phone the menu's entry for a screen sits in the closed drawer,
  // and the quick bar's button for it is the one in view.
  const onScreen = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  };
  found = [...found.filter(onScreen), ...found.filter((el) => !onScreen(el))];
  return every ? found : found[t.nth ?? 0] ?? null;
}

/**
 * The part of a step's control that can be seen, in the window's coordinates: its box, cut to each
 * box around it that hides what spills out of it — a long table scrolled inside its panel shows
 * only the rows in view. The ring goes around this, so it never stands around what is hidden.
 * Only the boxes that hold it in place cut it: what is fixed to the window (a dialog, wherever it
 * sits on the page) escapes every box around it, and what is placed absolutely escapes those
 * between it and the box it is placed in. Written to travel, like findWalkTarget.
 */
export function walkTargetBox(el: Element): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
  let placed = getComputedStyle(el).position;
  for (let p = el.parentElement; p && p !== document.body && placed !== "fixed"; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.display === "contents" || (placed === "absolute" && style.position === "static")) continue;
    const c = p.getBoundingClientRect();
    if (style.overflowX !== "visible") { left = Math.max(left, c.left); right = Math.min(right, c.right); }
    if (style.overflowY !== "visible") { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
    // Beyond this box, what is cut is the box itself, placed as it is.
    placed = style.position;
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Bring a step's control into view: to the middle of the window — or, when it is too tall to be
 * seen whole there (a long panel, a table), with its top just under what stays over the page at the
 * top of the window (the screen's heading, its tabs). Its title and first rows are what is seen,
 * never its middle with the title hidden. `ignore` floats over the page without being part of it
 * (the spotlight's own note). Written to travel, like findWalkTarget.
 */
export function bringWalkTargetIntoView(el: HTMLElement, ignore?: Element | null): void {
  // Its top at the top of the window first, so what stays over the page there has stuck in place.
  el.scrollIntoView({ block: "start", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + Math.min(16, r.width / 2)));
  // What covers the page at the top of the window, above it: anything stuck there (sticky or
  // fixed) that is not where the control itself lives — the menu it is in moves with it.
  const covers = (y: number) => {
    const at = document.elementsFromPoint(x, y).find((e) => !ignore || !ignore.contains(e));
    for (let n: Element | null = at ?? null; n && n !== document.body; n = n.parentElement) {
      const position = getComputedStyle(n).position;
      if (position === "sticky" || position === "fixed") return !n.contains(el) && !el.contains(n);
    }
    return false;
  };
  let cover = 0;
  while (cover < window.innerHeight / 2 && covers(cover)) cover += 4;
  if ((window.innerHeight - r.height) / 2 >= cover + 12) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return;
  }
  const was = el.style.scrollMarginTop;
  el.style.scrollMarginTop = `${cover + 12}px`;
  el.scrollIntoView({ block: "start", inline: "nearest" });
  el.style.scrollMarginTop = was;
}
