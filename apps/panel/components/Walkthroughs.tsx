"use client";
/**
 * Help → Start here: the walkthroughs made for this person (lib/walkthroughs), and the slideshow
 * that plays one — each step a picture of the panel with the control ringed and a line saying what
 * to do with it.
 *
 * What is listed is decided by walkthroughsFor alone: the person's own permissions, the screens
 * they can open. Somebody given a new permission finds its walkthroughs here the next time they
 * look; somebody who lost one stops seeing them. The search box looks through the same list, so
 * it never offers a walkthrough the person could not follow.
 */
import { onDemand } from "../lib/onDemand";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGrants } from "../lib/grants";
import { useAppNav } from "../lib/nav";
import { pathFor } from "../lib/routes";
import { WALKTHROUGHS, WALK_GROUPS, onPhone, searchWalkthroughs, showOnScreen, stageKey, walkthroughsFor, type WalkStep, type Walkthrough } from "../lib/walkthroughs";
import SHOTS from "../lib/walkthroughShots.json";
import PHONE_SHOTS from "../lib/walkthroughShotsPhone.json";
import { openSetup } from "../lib/gettingStarted";
import { EmptyState, Modal, SearchInput } from "./ui";
import { Panel, PanelGroup } from "./Panel";

/** A step's picture: its size, where the ring goes, its version — and, on a phone, whether what it
 *  rings is in the menu, which has to be opened with ☰ first. */
interface Shot { w: number; h: number; ring: number[] | null; v: string; menu?: boolean }
const shots = SHOTS as Record<string, Shot>;
const phoneShots = PHONE_SHOTS as Record<string, Shot>;

/** The staff command's panel in Discord, drawn in a step's place (WalkStep.discord): loaded only
 *  for the walkthrough that has such steps. */
const StaffPanelDrawing = onDemand(() => import("./StaffPanelDrawing"), "default");

/** Is the panel laid out for a phone — its menu behind ☰ (the breakpoint page.tsx and the CSS use)? */
function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return phone;
}

/** A step as this screen shows it: on a phone, its phone words and the phone's picture (or the
 *  computer's, until the phone's is taken). */
function asShown(step: WalkStep, phone: boolean): { step: WalkStep; src: string; shot: Shot | undefined } {
  if (phone) {
    const s = onPhone(step);
    const key = stageKey(s);
    const shot = phoneShots[key];
    if (shot) return { step: s, src: `/walkthroughs/phone/${key}.webp?v=${shot.v}`, shot };
  }
  const key = stageKey(step);
  const shot = shots[key];
  return { step: phone ? onPhone(step) : step, src: `/walkthroughs/${key}.webp?v=${shot?.v ?? ""}`, shot };
}

/** The picture of one step, and where the ring goes on it — in fractions of the picture, so it
 *  lands on the control however wide the window draws it. */
function StepPicture({ src, shot }: { src: string; shot: Shot | undefined }) {
  if (!shot) return null;
  const [x, y, w, h] = shot.ring ?? [];
  const pct = (n: number | undefined, of: number) => `${((n ?? 0) / of) * 100}%`;
  return (
    <div className="walk-stage" style={{ aspectRatio: `${shot.w} / ${shot.h}` }}>
      <img src={src} alt="" width={shot.w} height={shot.h} draggable={false} />
      {shot.ring && (
        <span className="walk-ring" aria-hidden
          style={{ left: pct(x, shot.w), top: pct(y, shot.h), width: pct(w, shot.w), height: pct(h, shot.h) }} />
      )}
    </div>
  );
}

/**
 * "Copy link": the address that opens Help on this walkthrough's slideshow — what turns "go read the
 * watchlist walkthrough" in Discord into one click. Built from pathFor, so the link and the router
 * cannot disagree about its shape.
 */
function CopyWalkLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#${pathFor("help", "start", id)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* the clipboard refused (an insecure address): nothing sensible to fall back to */ }
  }
  return (
    <button type="button" className="ghost walk-share" onClick={copy} title="Copy a link that opens this walkthrough, to paste to a colleague">
      {copied ? "✓ Copied" : "🔗 Copy link"}
    </button>
  );
}

/** One walkthrough as a slideshow: Back and Next (or the arrow keys), or a dot to jump. `onLive`
 *  replaces what "Show me on my screen" does (Getting started ends itself first). */
export function WalkthroughPlayer({ walk, onClose, onLive }: { walk: Walkthrough; onClose: () => void; onLive?: (step: number) => void }) {
  const [at, setAt] = useState(0);
  const phone = usePhoneLayout();
  const last = walk.steps.length - 1;
  const { step, src, shot } = asShown(walk.steps[Math.min(at, last)]!, phone);
  const back = useCallback(() => setAt((i) => Math.max(0, i - 1)), []);
  const next = useCallback(() => setAt((i) => Math.min(last, i + 1)), [last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
      if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, next]);

  // The next picture is fetched while this one is read, so pressing Next shows it at once.
  useEffect(() => {
    const after = walk.steps[at + 1];
    if (!after) return;
    const next = asShown(after, phone);
    if (next.shot) new Image().src = next.src;
  }, [at, walk, phone]);

  return (
    <Modal title={walk.title} onClose={onClose} className="walk-modal">
      <figure className="walk-figure">
        {/* A step in Discord has no picture: the panel it is in is drawn, as it is for this person. */}
        {step.discord
          ? <div className="walk-stage walk-drawn"><StaffPanelDrawing step={step} part={step.discord.part} server={step.discord.server} ring={step.target} /></div>
          : <StepPicture src={src} shot={shot} />}
        <figcaption className="walk-caption">
          <span className="walk-count">Step {at + 1} of {walk.steps.length}</span>
          <span className="walk-text">{step.text}</span>
          {shot?.menu && <span className="muted walk-menu-hint">Tap ☰ at the top left to open the menu first.</span>}
        </figcaption>
      </figure>
      {walk.steps.length > 1 && (
        <div className="walk-dots" role="group" aria-label="Steps">
          {walk.steps.map((s, i) => (
            <button key={i} type="button" className={`walk-dot${i === at ? " on" : ""}`}
              aria-label={`Step ${i + 1}`} aria-current={i === at ? "step" : undefined} onClick={() => setAt(i)} />
          ))}
        </div>
      )}
      <div className="pa-actions">
        <CopyWalkLink id={walk.id} />
        {/* The same steps on the panel itself, from this one: the screen opens, the control is ringed. */}
        <button type="button" className="ghost walk-live" onClick={() => { if (onLive) onLive(at); else { onClose(); showOnScreen(walk.id, at); } }}>Show me on my screen</button>
        <button type="button" className="ghost" onClick={back} disabled={at === 0}>Back</button>
        {at < last
          ? <button type="button" className="primary" onClick={next}>Next</button>
          : <button type="button" className="primary" onClick={onClose}>Done</button>}
      </div>
    </Modal>
  );
}

/** The personal setup, as the search sees it: found by what it sets up. */
const SETUP = {
  title: "Personal setup",
  blurb: "How the panel looks, its text size, your clock and where it opens, set up a step at a time.",
  keywords: ["settings", "theme", "dark", "light", "colour", "color", "text size", "density", "time zone", "landing", "notifications", "phone"],
  steps: [],
};

/** One walkthrough in the list: its title, what it shows, how many steps. */
function WalkCard({ walk, onOpen }: { walk: Walkthrough; onOpen: (w: Walkthrough) => void }) {
  return (
    <li>
      <button type="button" className="walk-card" onClick={() => onOpen(walk)}>
        <span className="walk-card-title">{walk.title}</span>
        <span className="muted walk-card-blurb">{walk.blurb}</span>
        <span className="muted walk-card-count">{walk.steps.length} steps</span>
      </button>
    </li>
  );
}

/** Help → Start here. */
export function HelpStart() {
  const grants = useGrants();
  const [open, setOpen] = useState<Walkthrough | null>(null);
  const [q, setQ] = useState("");
  const mine = useMemo(() => walkthroughsFor(grants), [grants]);
  const groups = useMemo(() => WALK_GROUPS
    .map((label) => ({ label, items: mine.filter((w) => w.group === label) }))
    .filter((g) => g.items.length), [mine]);
  // Searching: the walkthroughs that answer it, best first, in place of the groups.
  const found = useMemo(() => (q.trim() ? searchWalkthroughs(mine, q) : null), [mine, q]);
  const setupFound = !found || searchWalkthroughs([SETUP], q).length > 0;
  // A shared link (#/help/start/~<id>) opens its walkthrough once, when the person's permissions
  // are in.
  const nav = useAppNav();
  const linked = nav.view === "help" ? nav.subject : undefined;
  const linkedTo = linked && WALKTHROUGHS.some((w) => w.id === linked) ? [linked] : [];
  const linkedWalk = linkedTo.map((id) => mine.find((w) => w.id === id)).find(Boolean);
  const opened = useRef("");
  useEffect(() => {
    if (!linked || !linkedWalk || opened.current === linked) return;
    opened.current = linked;
    setOpen(linkedWalk);
  }, [linked, linkedWalk]);

  return (
    <PanelGroup viewId="help-start">
      <Panel id="help-start" caps="open" title="Start here"
        subtitle="Walkthroughs made for what you can do. Each step shows the panel with the button to press ringed."
        actions={<SearchInput value={q} onChange={setQ} placeholder="Search the walkthroughs…" />}>
        {/* A link to a walkthrough this person cannot follow says so: the list with nothing opened
            reads as a broken link, not as a permission. */}
        {linked && grants.length > 0 && !linkedWalk && (
          <p className="hint">
            {linkedTo.length
              ? "The walkthrough that link points at covers something your permissions don't include, so it isn't shown here."
              : "That link names a walkthrough that is no longer here, probably from an older version of the panel."}
          </p>
        )}
        {/* The setup everyone is walked through once, for whenever they want it again. */}
        {setupFound && (
          <div className="help-group">
            <h4 className="help-group-label">Your setup</h4>
            <ul className="walk-list">
              <li>
                <button type="button" className="walk-card" onClick={openSetup}>
                  <span className="walk-card-title">{SETUP.title}</span>
                  <span className="muted walk-card-blurb">{SETUP.blurb}</span>
                </button>
              </li>
            </ul>
          </div>
        )}
        {found && (found.length > 0 ? (
          <div className="help-group">
            <h4 className="help-group-label">{found.length === 1 ? "1 walkthrough" : `${found.length} walkthroughs`}</h4>
            <ul className="walk-list">{found.map((w) => <WalkCard key={w.id} walk={w} onOpen={setOpen} />)}</ul>
          </div>
        ) : !setupFound && (
          <EmptyState title="No walkthrough matches" filtered onClear={() => setQ("")}>
            Try other words, or say what you want to do, such as &ldquo;ban a player&rdquo;.
          </EmptyState>
        ))}
        {!found && groups.length === 0 && (
          <EmptyState title="No walkthroughs for your permissions yet">Walkthroughs appear here as you are given things to do.</EmptyState>
        )}
        {!found && groups.map((g) => (
          <div key={g.label} className="help-group">
            <h4 className="help-group-label">{g.label}</h4>
            <ul className="walk-list">{g.items.map((w) => <WalkCard key={w.id} walk={w} onOpen={setOpen} />)}</ul>
          </div>
        ))}
      </Panel>
      {open && <WalkthroughPlayer walk={open} onClose={() => setOpen(null)} />}
    </PanelGroup>
  );
}

/**
 * New walkthroughs (lib/walkNotice): permissions given to this person opened walkthroughs they
 * could not follow before, and here they are, once — each playable from here, and kept in Start
 * here like the rest.
 */
export function NewWalkthroughs({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const grants = useGrants();
  const walks = useMemo(() => walkthroughsFor(grants).filter((w) => ids.includes(w.id)), [grants, ids]);
  const [playing, setPlaying] = useState<Walkthrough | null>(null);
  useEffect(() => { if (!walks.length) onClose(); }, [walks, onClose]);
  if (playing) {
    return <WalkthroughPlayer walk={playing} onClose={() => setPlaying(null)} onLive={(i) => { onClose(); showOnScreen(playing.id, i); }} />;
  }
  return (
    <Modal title="New walkthroughs for you" onClose={onClose} className="walk-new-modal">
      <p className="mt-0">
        You have been given more to do. {walks.length === 1 ? "Here is its walkthrough" : "Here is a walkthrough for each"}, kept in Help under Start here.
      </p>
      <ul className="walk-list">{walks.map((w) => <WalkCard key={w.id} walk={w} onOpen={setPlaying} />)}</ul>
      <div className="pa-actions">
        <button type="button" className="primary" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}

/**
 * A walkthrough opened from anywhere (Search lists them): the slideshow over the screen the person
 * is on, if their permissions give them that walkthrough — the same steps Start here would show.
 */
export function PlayWalkthrough({ walkId, onClose }: { walkId: string; onClose: () => void }) {
  const grants = useGrants();
  const walk = useMemo(() => walkthroughsFor(grants).find((w) => w.id === walkId), [grants, walkId]);
  useEffect(() => { if (!walk) onClose(); }, [walk, onClose]);
  return walk ? <WalkthroughPlayer walk={walk} onClose={onClose} /> : null;
}
