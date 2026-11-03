"use client";
/**
 * "Show me on my screen": a walkthrough played on the panel itself. Each step opens its screen,
 * rings the control on it and dims the rest, with a note beside it saying what to do.
 *
 * The person does each step; the panel presses nothing the walkthrough is teaching. It only opens
 * the step's screen as the step's picture shows it, as the step begins and only where the person's
 * was left otherwise: the panel the control is in opened if folded, and the view the step is on
 * chosen (Live's Roster on Scoreboard, not its feed). Pressing the ringed
 * control moves the walkthrough on (what it opened — a menu, a dialog — is where the next step
 * is), and so does pressing any other the step names: the ⋯ on whichever row is the player's.
 * Next and Back move it without pressing anything. A field is for typing in, so it waits for Next.
 * A step whose control is not on the screen yet (a menu item before the menu is open) says so and
 * waits for it to appear; one scrolled out of view says that instead. A step about a state the
 * panel may not be in (its `stage`: a pull running, a Vietnam server) says the control is there
 * only then.
 *
 * On a phone the menu folds away behind ☰: a step pointing into it (a screen's entry, the server
 * picker) rings ☰ until the menu is open, then the entry in it — and while the menu is open over
 * the page, a screen's tab is the one listed under it in the menu.
 *
 * A step in Discord (WalkStep.discord) has no screen here to open: the panel the staff command
 * opens there is drawn in a window over whatever screen the person is on, opened where the step
 * is, and its control is ringed in it like any other.
 *
 * Loaded only when asked for (page.tsx listens for "panel:walk"), so the panel's first download
 * does not carry every walkthrough.
 */
import { onDemand } from "../lib/onDemand";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGrants } from "../lib/grants";
import { useAppNav } from "../lib/nav";
import { onPhone, walkthroughsFor } from "../lib/walkthroughs";
import { bringWalkTargetIntoView, findWalkTarget, walkTargetBox, type WalkTarget } from "../lib/walkTarget";

/** The staff command's panel in Discord, for a step there: loaded only when one is shown. */
const StaffPanelDrawing = onDemand(() => import("./StaffPanelDrawing"), "default");

/** What a press moves on from: a control. A field or a panel waits for Next. */
const PRESSABLE = 'button, a[href], [role="button"], [role="tab"]';
/** The ring stands this far off the control, as it does in the pictures. */
const PAD = 4;

interface Box { left: number; top: number; width: number; height: number }
const onScreen = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
};
const sameBox = (a: Box | null, b: Box | null) =>
  a === b || Boolean(a && b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);
/** The part of a control the person can see — cut to any box it scrolls in, inside the window — or
 *  null. A list scrolled inside its own box (the roster) hides rows the window still holds. */
function seenBox(el: HTMLElement): Box | null {
  const r = walkTargetBox(el);
  return r.width > 0 && r.height > 0 && r.top + r.height > 0 && r.top < window.innerHeight && r.left + r.width > 0 && r.left < window.innerWidth ? r : null;
}
/** A switch that is on: the chosen half of a segmented control, a pressed toggle, the open tab. */
const isOn = (el: HTMLElement) =>
  el.classList.contains("active") || el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-selected") === "true";

/** Is all of it in sight: not cut off by a box it scrolls in, nor under something drawn over it (a
 *  list's sticky header, the quick bar along the bottom)? Asked at its top, middle and foot. */
function inSight(el: HTMLElement): boolean {
  const r = seenBox(el);
  if (!r) return false;
  const x = r.left + r.width / 2;
  return [r.top + 2, r.top + r.height / 2, r.top + r.height - 2].every((y) => {
    const at = document.elementFromPoint(x, y);
    return Boolean(at && el.contains(at));
  });
}

/**
 * Where the note goes. Beside the dialog a control is in — or over or under it, on a screen too
 * narrow for beside — so the note never covers the dialog's own buttons; beside a tall control (the
 * whole menu); else under the control, or over it when there is no room below, or at the foot of
 * the window when there is room for neither.
 */
function notePlace(box: Box | null, frame: Box | null): React.CSSProperties {
  const W = Math.min(320, window.innerWidth - 16);
  const clampX = (x: number) => Math.max(8, Math.min(window.innerWidth - W - 8, x));
  if (!box) return { left: clampX(window.innerWidth / 2 - W / 2), bottom: 24, width: W };
  const beside = (r: Box): React.CSSProperties | null => {
    const top = Math.max(8, Math.min(window.innerHeight - 200, box.top));
    if (r.left + r.width + 12 + W <= window.innerWidth - 8) return { left: r.left + r.width + 12, top, width: W };
    if (r.left - W - 12 >= 8) return { left: r.left - W - 12, top, width: W };
    return null;
  };
  const aside = (frame && beside(frame)) || (box.height > window.innerHeight * 0.5 ? beside(box) : null);
  if (aside) return aside;
  const left = clampX(box.left + box.width / 2 - W / 2);
  // No room beside the dialog (a phone): over it, or under it, rather than on its buttons.
  if (frame && frame.top > 190) return { left, bottom: window.innerHeight - frame.top + 12, width: W };
  if (frame && window.innerHeight - (frame.top + frame.height) > 190) return { left, top: frame.top + frame.height + 12, width: W };
  if (window.innerHeight - (box.top + box.height) > 190) return { left, top: box.top + box.height + 12, width: W };
  if (box.top > 190) return { left, bottom: window.innerHeight - box.top + 12, width: W };
  // No room under it or over it (a panel taller than the window): at the foot of the window, over
  // the control, rather than off the screen with Back and Next.
  return { left, bottom: 24, width: W };
}

export default function WalkSpotlight({ walkId, startAt, onClose }: { walkId: string; startAt: number; onClose: () => void }) {
  const grants = useGrants();
  const nav = useAppNav();
  // The same steps the slideshow showed this person: their walkthrough, by their permissions.
  const walk = useMemo(() => walkthroughsFor(grants).find((w) => w.id === walkId), [grants, walkId]);
  const last = (walk?.steps.length ?? 1) - 1;
  const [at, setAt] = useState(Math.min(startAt, last));
  const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches;
  // The step as this screen has it: a phone's words and target on a phone.
  const raw = walk?.steps[at];
  const step = useMemo(() => (raw && narrow ? onPhone(raw) : raw), [raw, narrow]);
  const [box, setBox] = useState<Box | null>(null);
  /** The dialog the control is in, if it is in one. */
  const [frame, setFrame] = useState<Box | null>(null);
  /** Why there is no ring: its control is not on the page yet, or it is, scrolled out of view. */
  const [missing, setMissing] = useState<"" | "gone" | "away">("");
  const target = useRef<HTMLElement | null>(null);
  const note = useRef<HTMLElement | null>(null);
  /** ☰ is ringed, for the menu the step's control is in: pressing it opens the menu, not the step. */
  const viaMenu = useRef(false);
  const [openMenu, setOpenMenu] = useState(false);

  useEffect(() => { if (!walk) onClose(); }, [walk, onClose]);

  // The step's screen, when the person is not on it already. A step whose control is on the screen
  // in front of them is left there; so is a player's profile (or any one thing a screen has open) on
  // the screen the step names, since a step can point into it — going to the screen's address
  // would close it.
  const { view, tab, subject, go } = nav;
  useEffect(() => {
    // A step in Discord is drawn over the screen the person is on, wherever that is.
    if (!step || step.discord) return;
    const dot = step.route.indexOf(".");
    const want = dot === -1 ? { view: step.route } : { view: step.route.slice(0, dot), tab: step.route.slice(dot + 1) };
    const there = view === want.view && (!want.tab || tab === want.tab || Boolean(subject));
    if (!there && !findWalkTarget(step.target)) go(want.view, undefined, want.tab);
    // Only as a step begins: after that, where the person goes is theirs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Find the control (a few times a second — the screen may still be loading), and follow it
  // every frame, so the ring stays on it as the page scrolls or a menu settles.
  useEffect(() => {
    if (!step) return;
    target.current = null;
    setBox(null);
    setFrame(null);
    setMissing("");
    const began = Date.now();
    // Brought into view once a step — and once more on a phone as the menu opens — and after that
    // the scrolling is the person's: looking down the roster for their player is not undone.
    let scrolledFor: string | null = null;
    // The step's screen as its picture shows it: the panel its control is in, then whatever the
    // step sets (a switch the screen remembers). Each pressed at most once a step, and only while
    // the control cannot be found, so a person who switches it back afterwards keeps their choice.
    const t = step.target;
    const wants: WalkTarget[] = [
      ...(t.panel && (t.button || t.field || t.setting || t.css || t.tab) ? [{ panel: t.panel }] : []),
      ...(step.setup ?? []),
    ];
    const pressed = new Set<string>();
    const pressOnce = (key: string, el: HTMLElement) => { if (!pressed.has(key)) { pressed.add(key); el.click(); } };
    const prepare = () => {
      for (const [i, w] of wants.entries()) {
        const panel = w.panel ? findWalkTarget({ panel: w.panel }) : null;
        if (w.panel && !panel) return; // not drawn yet
        if (panel?.classList.contains("is-collapsed")) {
          const open = panel.querySelector<HTMLElement>("button.panel-toggle");
          if (open) pressOnce(`open ${w.panel}`, open);
          return; // its body is drawn next time round
        }
        if (w.button) {
          const sw = findWalkTarget(w);
          if (!sw) return;
          if (!isOn(sw)) pressOnce(`set ${i}`, sw);
        }
      }
    };
    const find = () => {
      // Of several (the ⋯ on every row), one wholly in sight, else the first.
      const all = findWalkTarget(step.target, true);
      if (!all.length && wants.length) prepare();
      let el: HTMLElement | null = step.target.nth !== undefined ? all[step.target.nth] ?? null : all.find(inSight) ?? all[0] ?? null;
      let phase = "page";
      if (narrow) {
        const menuOpen = Boolean(document.querySelector(".app-shell.drawer-open"));
        const entry = step.target.nav ?? (step.target.tab ? step.route : undefined);
        const inMenu = entry ? document.querySelector<HTMLElement>(`.sidebar [data-route="${entry}"]`) : null;
        // The menu open over the page: its entry, not the quick bar's button or the page's tab
        // behind it. The menu closed: ☰, when what the step points at is in the menu.
        if (menuOpen && inMenu) el = inMenu;
        viaMenu.current = !menuOpen && Boolean(el?.closest(".sidebar")) && !onScreen(el!);
        if (viaMenu.current) el = document.querySelector<HTMLElement>(".topbar .burger");
        setOpenMenu(viaMenu.current);
        if (menuOpen) phase = "menu";
      }
      target.current = el;
      // Into the middle of the screen (one too tall for that, its top), when it is out of view or at
      // the edge of it — the note needs room beside it, and a control at the very bottom leaves none.
      if (el && scrolledFor !== phase) {
        const r = el.getBoundingClientRect();
        if (r.top < 48 || r.bottom > window.innerHeight - 48 || r.right < 0 || r.left > window.innerWidth) bringWalkTargetIntoView(el, note.current);
        scrolledFor = phase;
      }
    };
    find();
    const finder = window.setInterval(find, 250);
    let raf = 0;
    const follow = () => {
      const el = target.current;
      // The part of it in view: a table scrolled inside its panel is ringed where it shows.
      const r = el ? seenBox(el) : null;
      const next = r ? { left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 } : null;
      setBox((prev) => (sameBox(prev, next) ? prev : next));
      const d = next ? el!.closest('[role="dialog"], .spot-discord')?.getBoundingClientRect() : undefined;
      const around = d ? { left: d.left, top: d.top, width: d.width, height: d.height } : null;
      setFrame((prev) => (sameBox(prev, around) ? prev : around));
      // A moment for the screen to load before saying the control is not there.
      setMissing(next || Date.now() - began <= 1200 ? "" : el ? "away" : "gone");
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => { window.clearInterval(finder); cancelAnimationFrame(raf); };
  }, [step, narrow]);

  const back = useCallback(() => setAt((i) => Math.max(0, i - 1)), []);
  const next = useCallback(() => { if (at >= last) onClose(); else setAt(at + 1); }, [at, last, onClose]);

  // Pressing the ringed control is doing the step — or any other the step names, such as the ⋯ on
  // another row; one picked out by its place (nth) is that one alone. Move on once it has done its
  // work.
  useEffect(() => {
    if (!step) return;
    const onPress = (e: MouseEvent) => {
      const el = target.current;
      const pressed = e.target;
      if (!el || viaMenu.current || !(pressed instanceof Node)) return;
      const doing = step.target.nth === undefined ? [el, ...findWalkTarget(step.target, true)] : [el];
      if (!doing.some((d) => d.contains(pressed) && d.matches(PRESSABLE))) return;
      window.setTimeout(next, 0);
    };
    document.addEventListener("click", onPress, true);
    return () => document.removeEventListener("click", onPress, true);
  }, [next, step]);

  // Escape ends it — unless a dialog is open, whose own Escape comes first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!walk || !step) return null;
  return createPortal(
    <>
      {/* Over the person's screen, under the ring and the note: a part of the walkthrough, not a
          dialog, so Escape ends the walkthrough as it does on any other step. */}
      {step.discord && (
        <div className="spot-discord">
          <StaffPanelDrawing step={step} part={step.discord.part} server={step.discord.server} />
        </div>
      )}
      {box && <div className="spot-ring" aria-hidden style={box} />}
      {/* Not a dialog: the page stays the person's to use, and a step that points into a dialog
          looks for the dialog on top — which this must never be taken for. */}
      <aside ref={note} className="spot-note" aria-label="Walkthrough" style={notePlace(box, frame)}>
        <div className="spot-head">
          <span className="spot-title">{walk.title}</span>
          <button type="button" className="ghost mini spot-end" aria-label="End the walkthrough" title="End the walkthrough" onClick={onClose}>✕</button>
        </div>
        <span className="walk-count">Step {at + 1} of {walk.steps.length}</span>
        <p className="spot-text" aria-live="polite">{step.text}</p>
        {openMenu && <p className="hint spot-hint">Tap ☰ to open the menu first.</p>}
        {/* A step about a state the panel is not in now (a pull running, a Vietnam server) points
            at what only that state shows: doing the step before would not bring it. */}
        {missing === "gone" && (
          <p className="hint spot-hint">
            {step.discord ? "Not in your panel in Discord as it is now."
              : step.stage ? "Not on your screen now. It is there only when the panel is as this step says." : "Not on your screen yet. It appears once you do the step before."}
          </p>
        )}
        {missing === "away" && (
          <p className="hint spot-hint">
            Out of view.{" "}
            <button type="button" className="linklike" onClick={() => { if (target.current) bringWalkTargetIntoView(target.current, note.current); }}>Scroll to it</button>
          </p>
        )}
        <div className="spot-actions">
          <button type="button" className="ghost mini" onClick={back} disabled={at === 0}>Back</button>
          <button type="button" className="primary mini" onClick={next}>{at < last ? "Next" : "Done"}</button>
        </div>
      </aside>
    </>,
    document.body,
  );
}
