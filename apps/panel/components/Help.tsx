"use client";
/**
 * Help — where everything is. Its walkthroughs are under Start here (components/Walkthroughs).
 *
 * **All pages** is GENERATED from the route registry, so it cannot go stale. Every destination and
 * every tab, with the same one-sentence description search uses, filtered to what this account may
 * actually open. It includes the screens the command palette leaves out — the palette only offers
 * routes that are neither hidden nor a tab of a hidden one — which is exactly the set nobody can
 * find on purpose.
 */
import { useMemo, useState } from "react";
import { useAppNav } from "../lib/nav";
import { useGrants } from "../lib/grants";
import { HELP_ROUTES, SECTIONS, canOpenRoute, type RouteDef } from "../lib/routes";
import { EmptyState, SearchInput } from "./ui";
import { Panel, PanelGroup } from "./Panel";
import { PlaceholderReference } from "./Placeholders";

const routeHaystack = (r: RouteDef, parent?: RouteDef) =>
  [parent?.title ?? "", r.title, r.blurb, ...(r.keywords ?? [])].join(" ").toLowerCase();

/** Jump to a destination, or to a "<destination>.<tab>". */
function useJump() {
  const nav = useAppNav();
  return (id: string) => {
    const dot = id.indexOf(".");
    if (dot === -1) return nav.go(id);
    nav.go(id.slice(0, dot), undefined, id.slice(dot + 1));
  };
}

/** May this account open the screen? The same rule the sidebar and the palette apply — literally
 *  the same function, so an owner-only or write-only screen cannot be offered here and refused
 *  there. */
function useCanRoute() {
  const grants = useGrants();
  return useMemo(() => (r: RouteDef) => canOpenRoute(grants, r), [grants]);
}

export function HelpPages() {
  const go = useJump();
  const canRoute = useCanRoute();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();

  /** Destinations in registry order, each with the tabs beneath it. */
  const directory = useMemo(() => {
    const tops = HELP_ROUTES.filter((r) => !r.parent && canRoute(r));
    return [
      { label: "Start here", items: tops.filter((r) => !r.section) },
      ...SECTIONS.map((label) => ({ label, items: tops.filter((r) => r.section === label) })),
    ]
      .map((g) => ({
        label: g.label,
        items: g.items
          .map((r) => ({
            route: r,
            // A tab is listed under its destination, never alone — "Bans" means nothing without
            // "Moderation" above it.
            tabs: HELP_ROUTES.filter((t) => t.parent === r.id && canRoute(t)),
          }))
          // A destination survives if IT matches or one of its tabs does, and then only the matching
          // tabs are shown — searching "kicks" should land on Moderation › Kicks, not all six tabs.
          .map(({ route, tabs }) => ({
            route,
            tabs: needle ? tabs.filter((t) => routeHaystack(t, route).includes(needle)) : tabs,
            self: !needle || routeHaystack(route).includes(needle),
          }))
          .filter((x) => x.self || x.tabs.length),
      }))
      .filter((g) => g.items.length);
  }, [canRoute, needle]);

  return (
    <PanelGroup viewId="help-pages">
      <Panel id="help-pages" caps="open" title="All pages"
        subtitle="Every screen you can open, and what it is for. Built from the app itself, so it is never out of date."
        actions={<SearchInput value={q} onChange={setQ} placeholder="Search every page…" />}>
        {directory.length === 0 && (
          <EmptyState title={`No page matches “${q}”`}>
            Search reads a page&apos;s description and the words you might use instead of ours, so try describing what you want to do.
          </EmptyState>
        )}
        {directory.map((g) => (
          <div key={g.label} className="help-group">
            <h4 className="help-group-label">{g.label}</h4>
            <ul className="help-pages">
              {g.items.map(({ route, tabs }) => (
                <li key={route.id}>
                  <button type="button" className="help-page" onClick={() => go(route.id)}>
                    <span className="help-page-title">{route.title}</span>
                    <span className="muted help-page-blurb">{route.blurb}</span>
                  </button>
                  {tabs.length > 0 && (
                    <ul className="help-tabs">
                      {tabs.map((t) => (
                        <li key={t.id}>
                          <button type="button" className="help-page" onClick={() => go(t.id)}>
                            <span className="help-page-title">{t.title}</span>
                            <span className="muted help-page-blurb">{t.blurb}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Panel>
    </PanelGroup>
  );
}

/** Help → Placeholders: the full list of what can be typed into a message. */
export function HelpPlaceholders() {
  return (
    <PanelGroup viewId="help-placeholders">
      <Panel id="help-placeholders" caps="open" title="Placeholders"
        subtitle="Type these into any message to players and each one is filled in when it is sent.">
        <PlaceholderReference />
      </Panel>
    </PanelGroup>
  );
}
