"use client";
/**
 * Shared UI kit — the reusable building blocks the views compose from, so every surface looks and
 * behaves the same. Inspired by the CRCON settings language: setting cards, sliders with ticks,
 * iOS-style toggles, tinted callouts, and a breadcrumb page header. All theme-aware via CSS vars.
 */
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PAGE_SIZES } from "../lib/paged";
import { ADDED_TO_REQUEST, SENT_FOR_APPROVAL } from "../lib/filed";
import { canOnServer, hasCap } from "../lib/access";
import { useGrants } from "../lib/grants";
import { useRequestMode } from "../lib/requestMode";
import { useAppNav } from "../lib/nav";
import { useServers } from "../lib/servers";
import { routeById, tabsOf, trailFor } from "../lib/routes";
import { rememberTab, recallTab } from "../lib/userPrefs";

/**
 * Page header: title, the "what is this for" line, the breadcrumb trail, and right-aligned actions.
 * Pass `routeId` and the title/blurb/trail all come from the route registry, so a page can never
 * describe itself as something it isn't — and every screen gets its one-line explanation for free.
 */
export function PageHeader({ routeId, tab, title, subtitle, crumbs, actions }: {
  routeId?: string; tab?: string; title?: string; subtitle?: ReactNode; crumbs?: string[]; actions?: ReactNode;
}) {
  const route = routeId ? routeById(routeId) : undefined;
  const activeTab = routeId && tab ? routeById(`${routeId}.${tab}`) : undefined;
  const shownTitle = title ?? route?.title ?? "";
  // The blurb follows the tab when there is one: each tab says what IT is for, not just its hub.
  const shownSubtitle = subtitle ?? activeTab?.blurb ?? route?.blurb;
  const trail = crumbs ?? (routeId ? [route?.section, ...trailFor(routeId, tab).map((r) => r.title)].filter(Boolean) as string[] : undefined);
  return (
    <div className="page-header">
      <div className="page-header-main">
        <h1 className="m-0">{shownTitle}</h1>
        {shownSubtitle && <div className="page-subtitle">{shownSubtitle}</div>}
      </div>
      {trail && trail.length > 0 && (
        <nav className="crumbs" aria-label="Breadcrumb">{trail.map((c, i) => (
          <span key={i} className={i === trail.length - 1 ? "crumb current" : "crumb"}>{c}{i < trail.length - 1 && <span className="crumb-sep">›</span>}</span>
        ))}</nav>
      )}
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

/** One tab in a tabbed screen. `show` hides tabs the user has no capability for, so nobody is
 *  offered a page that would only 403. */
export interface HubTab { id: string; label: string; show?: boolean; render: () => ReactNode }

/**
 * The panel's ONE tab bar. Every tabbed screen uses it, so tabs look and behave identically
 * wherever you meet them, and each tab is a real URL — linkable, back-button-able, and reachable
 * from search.
 */
export function TabBar({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active?: string; onChange: (id: string) => void }) {
  const strip = useRef<HTMLDivElement | null>(null);
  // Which edges have more tabs behind them, so the fades only appear when there IS more.
  const [overflow, setOverflow] = useState<"none" | "left" | "right" | "both">("none");

  const measure = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // A sub-pixel remainder is not overflow; 2px keeps a fade off a bar that merely rounds badly.
    if (max <= 2) return setOverflow("none");
    const atStart = el.scrollLeft <= 2;
    const atEnd = el.scrollLeft >= max - 2;
    setOverflow(atStart ? "right" : atEnd ? "left" : "both");
  }, []);

  /*
   * Bring the ACTIVE tab into view. The bar scrolls, but it starts at zero — so on a hub with more
   * tabs than fit, landing on one of the later ones (by URL, by search, by the command palette)
   * showed a tab bar that did not contain the page you were looking at. The Analytics hub has
   * eight tabs and six fit: Staff and Map votes were simply unreachable by clicking, and if you
   * were ON one of them the bar gave no hint of where you were.
   *
   * Layout effect, and scrollLeft rather than scrollIntoView: the latter also scrolls ancestors,
   * which yanks the whole page down to a bar that is sticky at the top anyway.
   */
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const tab = el.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tab) {
      const pad = 24; // leave a sliver of the neighbour showing, so it reads as "there is more"
      const left = tab.offsetLeft - pad;
      const right = tab.offsetLeft + tab.offsetWidth + pad;
      if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left);
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    }
    measure();
  }, [active, tabs, measure]);

  useEffect(() => {
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Rotating a phone or opening the sidebar changes what fits.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // A tight menu leaves a page's tabs to this bar when it shows every one (lib/menuFit), so say when
  // that may have changed: on arriving, on leaving, and when they start or stop all fitting.
  const allShown = overflow === "none";
  useEffect(() => {
    window.dispatchEvent(new Event("panel:tabbar"));
    return () => { window.dispatchEvent(new Event("panel:tabbar")); };
  }, [allShown]);

  if (tabs.length < 2) return null;

  return (
    // The wrapper owns the fades; the strip owns the scrolling, so a fade can't be scrolled away.
    <div className={`tabbar-wrap ov-${overflow}`}>
      <div
        className="tabbar" role="tablist" ref={strip} onScroll={measure}
        onWheel={(e) => {
          // A mouse has no horizontal wheel. Without this the only way to reach a tab past the
          // edge is shift+wheel or a drag — neither of which anybody guesses.
          const el = strip.current;
          if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          if (el.scrollWidth <= el.clientWidth) return;
          el.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id} role="tab" aria-selected={active === t.id}
            className={`tabbar-tab${active === t.id ? " active" : ""}`}
            onClick={() => onChange(t.id)}
          >{t.label}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * Tabbed hub — the standard way to group related surfaces under ONE nav destination instead of
 * scattering them across several. Title, description and breadcrumb come from the route registry;
 * the active tab lives in the URL (so `#/players/vips` opens VIPs directly) and is remembered per
 * user, so returning to a hub resumes where you left it.
 */
export function Hub({ routeId, title, subtitle, crumbs, tabs, active, onChange, actions, subjectTab, renamedTabs }: {
  routeId?: string; title?: string; subtitle?: ReactNode; crumbs?: string[]; tabs: HubTab[];
  active?: string; onChange?: (id: string) => void; actions?: ReactNode;
  /**
   * The tab that handles this hub's subject — the one thing a URL like `#/players/~<id>` names.
   * When a subject is present that tab wins regardless of which one you last used, and the hub
   * stops forcing a tab into the URL: writing one there would overwrite the subject, which is
   * exactly how opening a profile used to bounce you straight back to the directory.
   */
  subjectTab?: string;
  /**
   * Retired tab id → where it went. Tabs get merged, and a URL someone bookmarked (or the tab this
   * user last had open here) must land on the thing that replaced it rather than silently falling
   * back to the first tab, which is how a saved link quietly starts lying.
   */
  renamedTabs?: Record<string, string>;
}) {
  const nav = useAppNav();
  const visible = tabs.filter((t) => t.show !== false);
  const onSubject = Boolean(routeId && nav.view === routeId && nav.subject && subjectTab);
  // Which tab: the subject's tab if we're looking at a subject, else an explicit prop, else the
  // URL, else the one this user last used here, else the first the user is allowed to see.
  const fromUrl = routeId && nav.view === routeId ? nav.tab : undefined;
  const remembered = routeId ? recallTab(routeId) : undefined;
  const asked = (onSubject ? subjectTab : undefined) ?? active ?? fromUrl ?? remembered;
  const wanted = (asked && renamedTabs?.[asked]) ?? asked;
  const shown = visible.find((t) => t.id === wanted) ?? visible[0];

  const select = (id: string) => {
    if (routeId) rememberTab(routeId, id);
    if (onChange) onChange(id);
    else nav.setTab(id);
  };
  // Landing on a hub with no tab in the URL still shows one — put it in the URL so the address bar
  // always describes the screen, and so a refresh returns here rather than to the first tab.
  useEffect(() => {
    if (!routeId || nav.view !== routeId || nav.tab || !shown || onChange) return;
    if (onSubject) return; // the URL already says what it's about; a tab would replace that
    nav.setTab(shown.id);
  }, [routeId, nav, shown, onChange, onSubject]);

  // Registry order wins for the bar (it is the canonical reading order), with any tab the registry
  // doesn't know — dynamic auto-mod modules, plugin tabs — appended in the order given.
  const declared = routeId ? tabsOf(routeId).map((r) => r.id.slice(routeId.length + 1)) : [];
  const ordered = [
    ...declared.map((id) => visible.find((t) => t.id === id)).filter(Boolean) as HubTab[],
    ...visible.filter((t) => !declared.includes(t.id)),
  ];

  return (
    <div>
      {/*
        The tab bar is a SIBLING of the header card, not its last child. A sticky element can only
        stick within its containing block, and as the last thing inside the header that block ended
        exactly where the bar did — so on a phone, where the head scrolls away and the bar is
        supposed to stay, it had no room to stick and simply scrolled off with everything else. The
        CSS re-joins them visually; only the box tree changes.
      */}
      <div className="card page-head">
        <PageHeader routeId={routeId} tab={shown?.id} title={title} subtitle={subtitle} crumbs={crumbs} actions={actions} />
      </div>
      <div className="hub-tabs">
        <TabBar tabs={ordered.map((t) => ({ id: t.id, label: t.label }))} active={shown?.id} onChange={select} />
      </div>
      {/* Keyed by tab: each tab is its own screen. Two tabs drawn by one component (the moderation
          records) were one instance handed new props, so a tab came back from its neighbour on
          page one and with the neighbour's search still being sent. */}
      {shown ? <Fragment key={shown.id}>{shown.render()}</Fragment> : <div className="card"><p className="muted">You don&apos;t have access to any part of this section.</p></div>}
    </div>
  );
}

/**
 * The empty state — what a screen says when it has nothing to show.
 *
 * "No bans recorded." is a dead end: it tells you the list is empty, which you can see, and leaves
 * you to work out whether something is broken, whether you lack permission, or whether you simply
 * haven't done the thing yet. Every empty list here instead answers three questions: what would be
 * here, why it isn't, and what to do about it — with the action as a button where there is one.
 *
 * Use `filtered` when the data exists but the current filters hide it; that is a different message
 * ("nothing matches" is not "nothing exists") and gets a Clear button instead of a set-up hint.
 */
export function EmptyState({ icon = "○", title, children, action, filtered, onClear }: {
  icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode;
  filtered?: boolean; onClear?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>{icon}</div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {(action || (filtered && onClear)) && (
        <div className="empty-actions">
          {filtered && onClear && <button className="mini ghost" onClick={onClear}>Clear filters</button>}
          {action}
        </div>
      )}
    </div>
  );
}

/**
 * The small counterpart to EmptyState: one short line for a sub-section that happens to be empty.
 *
 * There are exactly two ways this panel says "nothing here". A whole screen, tab or list that is
 * empty gets an `EmptyState`, which answers what would be here, why it isn't, and what to do. A
 * narrow sub-section inside a screen that is otherwise full — one column of a stats panel, one
 * field in a form — gets this instead, because a full empty state there is louder than the thing
 * it's reporting. Having both named means the choice is deliberate rather than whatever the last
 * person reached for.
 */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="nothing">{children}</p>;
}

/** A button that takes you somewhere else in the panel — the usual "what to do about it" action on
 *  an empty state, so a dead end becomes a signpost. Marked with where it goes: Help's walkthroughs
 *  explain the screen it opens, not the button (test/e2e-3 "every action on every screen"). */
export function GoTo({ view, tab, children }: { view: string; tab?: string; children: ReactNode }) {
  const nav = useAppNav();
  return <button className="mini" data-goto={tab ? `${view}.${tab}` : view} onClick={() => nav.go(view, undefined, tab)}>{children}</button>;
}

/**
 * Loading placeholders that hold the shape of what's coming.
 *
 * Forty screens said "Loading…" — a line of text that then vanishes and is replaced by a table,
 * so every page load jumped. A skeleton occupies roughly the space the real content will, which
 * removes the jump and tells you at a glance whether you're waiting for a table, a list or a
 * single figure.
 */
export function SkeletonRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div className="sk-row" key={r}>
          {Array.from({ length: cols }, (_, c) => (
            // Varied widths so it reads as content rather than as a progress bar.
            <span className="sk-cell" key={c} style={{ width: `${c === 0 ? 28 : 12 + ((r + c) % 4) * 4}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** What a screen shows while its code is still on the way (screens load on demand: lib/onDemand's
 *  `Loading`). Takes no props. */
export function ScreenLoading() {
  return <SkeletonLines lines={4} />;
}

/** A few stacked lines — for prose, notices, and card bodies rather than tables. */
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span className="sk-cell sk-line" key={i} style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

/**
 * The outcome of the last thing that happened on this screen — a failed load, or a save that worked.
 *
 * Thirty-four files hand-rolled `{err && <p className="error">{err}</p>}` and eight more paired it
 * with `ok-msg`, which meant two half-conventions and at least one screen deciding which class to
 * use by comparing the message text to a hard-coded string. One component, one rendering: pass
 * whichever of the two you have and it shows that, or nothing at all when both are empty.
 */
export function ActionResult({ ok, error }: { ok?: string | null; error?: string | null }) {
  // A write that was filed for approval instead of happening comes through the error path (see
  // lib/api) — true, but not a failure, so it is not painted as one.
  if (error && (error.startsWith(SENT_FOR_APPROVAL) || error.startsWith(ADDED_TO_REQUEST))) {
    return <p className="hint" role="status">{error}</p>;
  }
  if (error) return <p className="error" role="alert">{error}</p>;
  if (ok) return <p className="ok-msg" role="status">{ok}</p>;
  return null;
}

/**
 * Where a screen's changes go, said once above its controls when they do not all simply happen.
 *
 * Everything a role can see, it can ask for, so the controls stay usable without the permission
 * and keep their own names; this is the one line that says a save, an add or a delete will be sent
 * for approval instead — all of them, or those needing a permission the account lacks when the
 * screen spans several — or added to the request being built. Nothing when the account holds every
 * `capability` at write (on `serverId`, for a screen about one server).
 */
export function AskNotice({ capability, serverId }: { capability: string | readonly string[]; serverId?: string | null }) {
  const grants = useGrants();
  const { building } = useRequestMode();
  const caps = typeof capability === "string" ? [capability] : capability;
  const held = caps.filter((c) => (serverId ? canOnServer(grants, c, serverId, "write") : hasCap(grants, c, "write"))).length;
  if (!building && held === caps.length) return null;
  return (
    <p className="hint notice" role="note">
      {building
        ? "Each change you make here is added to your request — nothing happens until you submit it."
        : held === 0
          ? "You don't hold the permission for changes here, so each one you make is sent for approval to someone who does (Moderation → Requests)."
          : "Changes here that need a permission you don't hold are sent for approval to someone who does (Moderation → Requests)."}
    </p>
  );
}

/**
 * The "you have no servers yet" guard, in the two shapes it actually takes.
 *
 * This sentence appeared seven times in five different wordings and three different renderings.
 * It is the panel's most important dead end — nothing works before a server is connected — so it
 * says one thing, in one voice, with a button that takes you to the place that fixes it.
 *
 * `NoServersPage` is for screens that cannot function at all without one (Live, the game log, match
 * history); it keeps the page header so the screen still tells you where you are.
 */
export function NoServersPage({ routeId, children }: { routeId?: string; children?: ReactNode }) {
  // An unread list is empty too: said as what it is, with a way to ask again — not as "nothing is
  // connected", which sends someone to add servers they already have.
  const { error, refresh } = useServers();
  if (error) {
    return (
      <div className="card">
        {routeId && <PageHeader routeId={routeId} />}
        <ActionResult error={`Couldn't read the server list: ${error}`} />
        <button className="mini" onClick={refresh}>Try again</button>
      </div>
    );
  }
  return (
    <div className="card">
      {routeId && <PageHeader routeId={routeId} />}
      <EmptyState icon="🔌" title="No game servers connected yet" action={<GoTo view="admin" tab="connections">Add a server</GoTo>}>
        {children ?? <>Give the panel a server&apos;s address and RCON password and it starts reading the roster and
          the game log. Everything else follows from a connected server.</>}
      </EmptyState>
    </div>
  );
}

/** The same guard for screens that still do something useful without a server — an inline note
 *  rather than a whole-page dead end. Pass children to say what specifically won't work. */
export function NoServersNote({ children }: { children?: ReactNode }) {
  const { error, refresh } = useServers();
  if (error) {
    return (
      <Callout variant="warn">
        Couldn&apos;t read the server list: {error}{" "}
        <button className="mini" onClick={refresh}>Try again</button>
      </Callout>
    );
  }
  return (
    <Callout variant="info">
      No game servers are connected yet — add one under <strong>Administration → Connections</strong>.
      {children ? <> {children}</> : null}
    </Callout>
  );
}

/**
 * The panel's one search box. Every list that filters uses it, so search looks the same width and
 * behaves the same way wherever you meet it — previously eight hand-rolled inputs with four
 * different max-widths and no consistent clear affordance.
 */
export function SearchInput({ value, onChange, placeholder, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean;
}) {
  return (
    // type="search" gives the browser's own clear button and the right keyboard on mobile.
    <input
      className="search-input" type="search" value={value} placeholder={placeholder}
      aria-label={placeholder} autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * The scope control for the community-wide screens — the directory, the leaderboard, the player
 * analytics page.
 *
 * Those three are not per-server the way the console or the map rotation are: a player is one
 * person across every server a community runs, so "everyone" is a real and useful question. The
 * problem was that it was the ONLY question they could ask, while the sidebar showed one pinned
 * server above them — so a career merged from two servers read as one server's figures, with
 * nothing on screen to say otherwise.
 *
 * This is what makes the choice visible and deliberate. It defaults to the pinned server, because
 * that is what the rest of the panel is showing and what the reader assumes; "All servers" is one
 * click away and, once chosen, says so in the same place the reader is already looking.
 */
export function ScopePicker({ servers, value, onChange, noun = "figures" }: {
  servers: { id: string; name: string }[];
  /** "" means every server. */
  value: string;
  onChange: (serverId: string) => void;
  /** What is being scoped, for the hint after the control ("figures", "ranking", "players"). */
  noun?: string;
}) {
  // Generated, because two of these can share a page (a hub tab beside a panel) and a duplicated
  // id would point both labels at the same control.
  const id = useId();
  // One server and nothing to choose between: the control would be a dropdown with a single option
  // implying an alternative that does not exist.
  if (servers.length < 2) return null;
  const named = servers.find((s) => s.id === value);
  return (
    <div className="scope-picker">
      <label className="scope-label" htmlFor={id}>Showing</label>
      <select id={id} className="scope-select" aria-label="Server scope" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All servers (combined)</option>
        {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <span className="scope-hint">
        {named ? `${noun} from ${named.name} only` : `${noun} from every server, added together`}
      </span>
    </div>
  );
}

/**
 * The footer of every paged list: where you are, how much there is, the way to any page, and how
 * big a page should be.
 *
 * This replaced "Load more". Appending pages meant the only way to reach last month was to click
 * through everything between, with no way back and a page that grew without bound. A pager states
 * position ("41–60 of 312"), jumps to first/last, and steps in either direction — and the
 * page-size choice is ONE preference shared by every list, because "I read 100 rows at a time" is
 * about the reader, not the table they happen to be on.
 *
 * Takes the PagedList itself rather than eight props: seven call sites, one contract.
 */
export function Pager<T>({ list, noun = "row" }: {
  list: {
    items: T[] | null; total: number | null; loading: boolean;
    page: number; pages: number | null; limit: number;
    hasPrev: boolean; hasNext: boolean;
    setPage: (p: number) => void; setLimit: (n: number) => void;
  };
  noun?: string;
}) {
  const { items, total, page, pages, limit, hasPrev, hasNext, loading } = list;
  const plural = noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  const shown = items?.length ?? 0;
  // Nothing to navigate and nothing hidden: one short page needs no chrome at all.
  if (shown === 0 && page === 0) return null;
  if (page === 0 && !hasNext && total !== null && total <= PAGE_SIZES[0]!) {
    return <div className="load-more"><span className="muted fs-sm">{total.toLocaleString()} {total === 1 ? noun : plural} — that&apos;s all of them</span></div>;
  }
  const first = page * limit + 1;
  const last = page * limit + shown;
  return (
    <div className="load-more pager">
      <span className="muted fs-sm">
        {total !== null
          ? `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()} ${plural}`
          : `${first.toLocaleString()}–${last.toLocaleString()}`}
      </span>
      <span className="pager-buttons">
        <button className="mini ghost" disabled={!hasPrev || loading} onClick={() => list.setPage(0)} title="First page">«</button>
        <button className="mini ghost" disabled={!hasPrev || loading} onClick={() => list.setPage(page - 1)} title="Previous page">‹</button>
        <span className="muted fs-sm pager-where">Page {page + 1}{pages !== null ? ` of ${pages}` : ""}</span>
        <button className="mini ghost" disabled={!hasNext || loading} onClick={() => list.setPage(page + 1)} title="Next page">›</button>
        {pages !== null && (
          <button className="mini ghost" disabled={!hasNext || loading} onClick={() => list.setPage(pages - 1)} title="Last page">»</button>
        )}
      </span>
      <label className="muted fs-sm pager-size">
        <select value={limit} onChange={(e) => list.setLimit(Number(e.target.value))} aria-label={`${plural} per page`}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {" "}per page
      </label>
    </div>
  );
}

/** Compact in-hub section header — the headerless replacement for PageHeader inside a Hub tab. */
export function PanelHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="row" style={{ alignItems: "center", marginBottom: 6 }}>
      <div>
        <h2 className="m-0">{title}</h2>
        {subtitle && <p className="muted" style={{ margin: "2px 0 0", fontSize: "0.82rem" }}>{subtitle}</p>}
      </div>
      <span className="grow" />
      {actions}
    </div>
  );
}

/** A centered section divider with a label (e.g. "— Match Timers —"). */
export function Divider({ label }: { label: string }) {
  return <div className="section-divider"><span>{label}</span></div>;
}

/**
 * A modal dialog: backdrop, Escape, and the labelling a screen reader needs.
 *
 * Six of these were written by hand — ban a player, edit VIP, the player-action confirmations,
 * console admins, server connections — and every one of them could only be dismissed by clicking
 * the backdrop or hunting for Cancel. Escape did nothing, which is the one key everybody presses to
 * get out of a dialog, and none of them announced itself as a dialog at all: to a screen reader
 * they were an unlabelled div that happened to appear. The command palette next door had all of
 * this; the modals simply never got it.
 *
 * `busy` is why closing is a prop rather than always-available: these dialogs run real actions
 * against a game server, and dismissing one mid-request would leave the caller wondering whether
 * the ban landed. While busy, both the backdrop and Escape are inert — deliberately, and the same
 * rule the hand-written backdrops already applied.
 *
 * Focus moves to the dialog on open so the next Tab lands inside it rather than back at the page
 * behind. It is not a full focus trap: that needs care around the last element and is a bigger
 * change than this, and the two things people actually reach for — Escape, and the label — are
 * here.
 */
export function Modal({ title, onClose, busy = false, className, children }: {
  /** The dialog's heading, and its accessible name. */
  title: ReactNode;
  onClose: () => void;
  /** While true the dialog refuses to dismiss: an action is in flight. */
  busy?: boolean;
  /** Extra classes on the dialog box (e.g. `confirm-modal`, which narrows it). */
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const labelId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    // The dialog itself, not its first control: landing on a field means a screen reader starts
    // mid-form instead of at the name of the thing that just opened. The opener is remembered so
    // closing puts the keyboard back where the user was — without it, focus falls to <body> and a
    // keyboard user restarts the page from the top.
    const opener = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Keep Tab inside the dialog. aria-modal tells assistive tech the background is inert, but the
  // TAB key doesn't read aria — without a trap it walks straight out into the page the backdrop
  // is covering, and the user is suddenly operating controls they cannot see.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const focusables = [...box.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.offsetParent !== null); // skip hidden controls
    if (!focusables.length) { e.preventDefault(); return; } // nothing to visit — stay on the dialog
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="pa-modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className={className ? `pa-modal ${className}` : "pa-modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <h3 id={labelId}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Tinted callout for contextual notices. */
export function Callout({ variant = "info", children, onClose }: { variant?: "info" | "warn" | "danger"; children: ReactNode; onClose?: () => void }) {
  const icon = variant === "warn" ? "⚠" : variant === "danger" ? "⛔" : "ⓘ";
  return (
    <div className={`callout callout-${variant}`}>
      <span className="callout-icon" aria-hidden>{icon}</span>
      <div className="callout-body">{children}</div>
      {onClose && <button className="callout-close" onClick={onClose} aria-label="Dismiss">✕</button>}
    </div>
  );
}

/** The ONE observe-mode banner, so every write screen says the same thing in the same words.
 *  Renders nothing when the server is active (or unknown). Pass children for a screen-specific
 *  extra sentence (e.g. "settings are still saved"). */
export function ObserveBanner({ server, when = "now", children }: {
  server?: { engagementMode?: string } | null;
  /**
   * Whether this screen acts on the game NOW (a kick, a map change, a broadcast — refused outright
   * on a read-only server) or configures something that acts LATER (auto-mod rules, seeding, auto
   * settings — saved happily, then never applied). Telling someone their save was "refused" when
   * it wasn't is its own kind of wrong, so the two say different things.
   */
  when?: "now" | "later";
  children?: ReactNode;
}) {
  if (!server || server.engagementMode === "active") return null;
  return (
    <Callout variant="warn">
      This server is in <strong>observe</strong> mode — the panel reads it but never writes.{" "}
      {when === "now"
        ? "Actions on this screen are refused."
        : "Settings here still save, but nothing will be applied to the server until it is active."}{" "}
      Switch it to <strong>Active</strong> under Administration → Connections.{children ? <> {children}</> : null}
    </Callout>
  );
}

/** iOS-style toggle — the app-wide control for every single on/off. Plain checkboxes remain only
 *  in MULTI-SELECT lists (bulk row selection, server pick-lists, a map's layer filters),
 *  where a row of switches would misread as independent settings. `label` takes a node so a rich
 *  two-line caption keeps its switch, and `title` carries the hover explainer some settings wear. */
export function Toggle({ checked, onChange, label, disabled, title, name }: {
  checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string;
  /** What the switch is called where its words are beside it rather than in it (screen readers). */
  name?: string;
}) {
  return (
    <label className={`toggle ${disabled ? "disabled" : ""}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={name} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label !== undefined && <span className="toggle-label">{label}</span>}
    </label>
  );
}

/**
 * A settings row: an iOS-style switch, its name, and the fields that only make sense once it is
 * on — which is the point. A screen full of greyed-out inputs for features nobody enabled reads
 * as clutter on a desktop and as endless scrolling on a phone, so the detail is REMOVED, not
 * disabled, until the switch is thrown.
 *
 * The whole row is the hit target on a phone (the switch is 23px tall; a thumb is not), and the
 * revealed fields wrap onto their own line rather than squeezing beside the label.
 */
export function SettingSwitch({ label, checked, onChange, disabled, hint, children }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string; children?: ReactNode;
}) {
  return (
    <div className={`setting-switch${checked ? " on" : ""}`}>
      <div className="setting-switch-head">
        <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
        {checked && children ? <div className="setting-switch-fields">{children}</div> : null}
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/** A Discord role as the roles endpoint returns it. */
export interface GuildRole {
  id: string; name: string; color: number;
  /** Discord-managed (the booster role, mostly): fine to GATE on, impossible for a bot to GIVE —
   *  pickers that assign roles filter these out. */
  managed?: boolean;
}

/**
 * Copy this page's own URL — the share affordance for subject pages (a player's profile, a staff
 * member's). The hash router already makes these URLs complete ("/players/directory/~<id>"), so
 * sharing one is strictly better than "hey, look this guy up": the receiver lands on the exact
 * profile. This button just saves the trip through the address bar, which on a phone is the
 * difference between doing it and not.
 */
export function CopyLink({ label = "Copy link" }: { label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied (insecure origin) — the URL is still in the address bar */
    }
  }
  return (
    <button type="button" className="ghost" onClick={copy} title="Copy a link to this page to share with other staff">
      {copied ? "✓ Copied" : `🔗 ${label}`}
    </button>
  );
}

/**
 * Pick Discord roles by clicking their names.
 *
 * Two screens gate on roles — who may claim points, and who may open the staff panel — and both
 * mean the same thing by it: none picked is "everyone", one or more is "any of these". One control
 * so the two never disagree about what an empty list means.
 *
 * A role that was picked and has since been deleted (or whose guild we cannot read) still shows as
 * a chip by its raw id: a saved restriction that renders as nothing is a restriction nobody knows
 * is there.
 */
/**
 * Why a Discord role picker has nothing to offer, in one sentence.
 *
 * `/discord/roles` reports an unconfigured bot as `botConfigured: false` and says nothing in
 * `error` — there was no error, there is simply nothing to ask. Screens that read only `error`
 * therefore drew an empty picker with no explanation, which reads as a broken control rather than
 * as a setting nobody has filled in yet. It matters most on the gates that go quiet when Discord
 * cannot be reached (an auto-mod rule holds fire rather than guess), so the reason belongs next to
 * the picker. One sentence, written once, for every screen that asks the same question.
 */
export function roleListNote(r: { botConfigured?: boolean; error?: string }): string {
  if (r.error) return r.error;
  if (r.botConfigured === false) return "No Discord bot token or guild id is set, so roles can't be listed — until that is configured a role gate cannot be chosen here, or checked when it matters.";
  return "";
}

export function RoleChips({ roles, value, onChange, disabled, note, emptyLabel = "anyone", someLabel = "only these roles" }: {
  roles: GuildRole[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Why the list is empty, when Discord told us. */
  note?: string;
  emptyLabel?: string;
  someLabel?: string;
}) {
  const picked = new Set(value);
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  const unknown = value.filter((id) => !roles.some((r) => r.id === id));
  return (
    <div className="claim-roles">
      <span className="claim-roles-label">{picked.size ? someLabel : emptyLabel}</span>
      <div className="chips">
        {roles.map((r) => (
          <button key={r.id} type="button" disabled={disabled} onClick={() => toggle(r.id)}
            className={`role-chip${picked.has(r.id) ? " on" : ""}`}
            style={picked.has(r.id) && r.color ? { borderColor: `#${r.color.toString(16).padStart(6, "0")}` } : undefined}>
            {r.name}
          </button>
        ))}
        {unknown.map((id) => (
          <button key={id} type="button" disabled={disabled} onClick={() => toggle(id)} className="role-chip on" title="This role is not in the guild list">
            {id}
          </button>
        ))}
        {!roles.length && !unknown.length && (
          <span className="hint">
            {note || "No roles readable — set the public Discord server in the Discord hub (Setup & status) and make sure the bot is in it."}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * RoleChips folded behind a disclosure line.
 *
 * A settings screen with four role-gated features is four walls of chips, almost all of them in
 * their default "anyone" state — noise that buries the numbers people actually come to change.
 * Collapsed, a gate is ONE line that says what it currently means ("anyone linked", "only these
 * 2 roles"), and the chips appear only for the person who came to change the restriction.
 * A native <details>: no state to hold, and the summary line is the label.
 */
export function RoleDisclosure(props: Parameters<typeof RoleChips>[0] & { label?: string }) {
  const { label = "Who can use this", ...chips } = props;
  const n = chips.value.length;
  const named = chips.value.map((id) => chips.roles.find((r) => r.id === id)?.name ?? id);
  return (
    <details className="role-disclosure">
      <summary>
        <span className="claim-roles-label">{label}</span>{" "}
        {n ? <span>{named.join(", ")}</span> : <span className="muted">{chips.emptyLabel ?? "anyone"}</span>}
      </summary>
      <RoleChips {...chips} />
    </details>
  );
}

/** Range slider with tick labels and a big current-value readout. */
export function Slider({ value, min, max, step = 1, ticks, unit, onChange, disabled }: {
  value: number; min: number; max: number; step?: number; ticks?: number[]; unit?: string; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className="slider">
      <div className="slider-row">
        <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
        <div className="slider-value">{value}{unit ? <span className="slider-unit"> {unit}</span> : null}</div>
      </div>
      {ticks && ticks.length > 0 && (
        <div className="slider-ticks">{ticks.map((t) => <span key={t} style={{ left: `${((t - min) / (max - min)) * 100}%` }}>{t}</span>)}</div>
      )}
    </div>
  );
}

/**
 * Explanatory text, folded under an "Explanation" toggle — the app's standard for any paragraph
 * that explains rather than controls (the owner's call: screens had become walls of text to
 * scroll past). Controls, warnings and live status stay in view; the reading is one click away.
 * A setting's description folds this way on its own (SettingCard); put any other explanation
 * inside one.
 */
/* A notice that must stay in view — a warning, what an action that costs something will do,
   something to fix before saving — is not an explanation: write it as className="hint notice". */
export function Explanation({ children }: { children: ReactNode }) {
  return (
    <details className="explain">
      <summary>Explanation</summary>
      <div className="explain-body">{children}</div>
    </details>
  );
}

/**
 * A single setting presented as a card: accent icon, title + description (folded under
 * "Explanation"), an inline action (usually Save, enabled when dirty), the control, and optional
 * helper text.
 */
export function SettingCard({ icon, title, description, action, dirty, children, helper }: {
  icon?: ReactNode; title: string; description?: string; action?: ReactNode; dirty?: boolean; children: ReactNode; helper?: string;
}) {
  return (
    <div className={`setting-card ${dirty ? "dirty" : ""}`}>
      <div className="setting-head">
        {icon && <span className="setting-icon" aria-hidden>{icon}</span>}
        <div className="setting-meta">
          <div className="setting-title">{title}</div>
          {description && <Explanation>{description}</Explanation>}
        </div>
        {action && <div className="setting-action">{action}</div>}
      </div>
      <div className="setting-body">{children}</div>
      {helper && <div className="setting-helper">{helper}</div>}
    </div>
  );
}

/**
 * A numbered step in a set-up flow. The panel's guiding rule is that someone should be able to open
 * a screen and know what to do without being taught — so anything with an order to it is presented
 * as steps, each stating in plain words what it is for, rather than a grid of labelled inputs whose
 * relationship you have to infer.
 */
export function Step({ n, title, blurb, children, done }: {
  n: number; title: string; blurb?: ReactNode; children: ReactNode; done?: boolean;
}) {
  return (
    <section className={`step ${done ? "step-done" : ""}`}>
      <div className="step-head">
        <span className="step-n" aria-hidden>{done ? "✓" : n}</span>
        <div className="step-meta">
          <h3 className="step-title">{title}</h3>
          {blurb && <div className="step-blurb">{blurb}</div>}
        </div>
      </div>
      <div className="step-body">{children}</div>
    </section>
  );
}
