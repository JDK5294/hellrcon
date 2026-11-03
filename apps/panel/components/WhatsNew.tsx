"use client";
/**
 * What's new (lib/whatsNew): after an update, what changed that this person hasn't seen yet —
 * once. Closing it marks it seen on their account, so their other devices don't show it again;
 * Help → What's new keeps every entry for whenever they want it.
 *
 * An item is shown only to someone who can open one of the screens it is about, and "Show me"
 * goes to the first of those (or opens Search, for the items about Search). An update with nothing
 * in it for them is left out whole — its heading too, which would otherwise head nothing.
 */
import { useEffect, useMemo } from "react";
import { useGrants } from "../lib/grants";
import { useAppNav } from "../lib/nav";
import { canOpenRoute, routeById } from "../lib/routes";
import { WHATS_NEW, type WhatsNewItem, type WhatsNewRelease } from "../lib/whatsNew";
import { Modal } from "./ui";
import { Panel, PanelGroup } from "./Panel";

/** "23 October 2026", the release's own day — not shifted by the reader's time zone. */
export function releaseDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** "Build 2 · 23 October 2026": which update, and when. */
export const releaseHeading = (r: WhatsNewRelease) => `Build ${r.build} · ${releaseDay(r.date)}`;

/** Ask the shell to open Search (page.tsx listens): it is not a screen to go to. */
export const openSearch = () => window.dispatchEvent(new CustomEvent("panel:search"));

/** Which items this person can use, and where each one's "Show me" goes. */
export function useWhatsNewAccess() {
  const grants = useGrants();
  return useMemo(() => {
    const opens = (id: string) => { const r = routeById(id); return Boolean(r && canOpenRoute(grants, r)); };
    const shown = (it: WhatsNewItem) => !it.where || it.where.some(opens);
    return {
      shown,
      target: (it: WhatsNewItem) => it.where?.find(opens),
      /** The updates with something in them for this person. */
      releases: (all: WhatsNewRelease[]) => all.filter((r) => r.items.some(shown)),
    };
  }, [grants]);
}

function Items({ release, onShow }: { release: WhatsNewRelease; onShow?: () => void }) {
  const access = useWhatsNewAccess();
  const nav = useAppNav();
  const show = (it: WhatsNewItem) => {
    onShow?.();
    if (it.search) return openSearch();
    const id = access.target(it);
    if (!id) return;
    const dot = id.indexOf(".");
    if (dot === -1) nav.go(id);
    else nav.go(id.slice(0, dot), undefined, id.slice(dot + 1));
  };
  return (
    <ul className="whats-new">
      {release.items.filter(access.shown).map((it) => (
        <li key={it.title}>
          <div className="whats-new-title">{it.title}</div>
          <p className="whats-new-text">{it.text}</p>
          {(it.search || access.target(it)) && (
            <button type="button" className="mini ghost" onClick={() => show(it)}>Show me</button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The popup after an update: what's new since this person last looked. Nothing in it they can
 *  use — every item about screens they cannot open — and it is simply marked seen. */
export function WhatsNewPopup({ releases, onClose }: { releases: WhatsNewRelease[]; onClose: () => void }) {
  const access = useWhatsNewAccess();
  const theirs = access.releases(releases);
  const anything = theirs.length > 0;
  useEffect(() => { if (!anything) onClose(); }, [anything, onClose]);
  if (!anything) return null;
  return (
    <Modal title="What's new" onClose={onClose} className="whats-new-modal">
      <p style={{ marginTop: 0 }}>The panel has been updated. Here is what changed.</p>
      {theirs.map((r) => (
        <section key={r.build}>
          {theirs.length > 1 && <h3 className="whats-new-day">{releaseHeading(r)}</h3>}
          <Items release={r} onShow={onClose} />
        </section>
      ))}
      <p className="muted fs-sm">You can read this again at any time in Help, under What&apos;s new.</p>
      <div className="pa-actions">
        <button type="button" className="primary" onClick={onClose}>Got it</button>
      </div>
    </Modal>
  );
}

/** Help → What's new: every update's notes, newest first — those with something for this person. */
export function HelpWhatsNew() {
  const access = useWhatsNewAccess();
  return (
    <PanelGroup viewId="help-whatsnew">
      <Panel id="help-whatsnew" caps="open" title="What's new" subtitle="what each update changed, newest first">
        {access.releases(WHATS_NEW).map((r) => (
          <section key={r.build}>
            <h3 className="whats-new-day">{releaseHeading(r)}</h3>
            <Items release={r} />
          </section>
        ))}
      </Panel>
    </PanelGroup>
  );
}
