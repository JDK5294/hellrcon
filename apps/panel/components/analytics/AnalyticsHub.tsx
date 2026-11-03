"use client";
/**
 * The analytics destination: several separate pages behind one sidebar entry.
 *
 * Each tab is its OWN page with its own route path and its own capability — they are not five views
 * of one permission. "Let this person see population figures but not staff workload" is a real thing
 * a community wants to say, so `analytics.server` and `analytics.staff` are granted independently
 * and a tab whose capability the user lacks is not rendered at all.
 *
 * It sits in the Admin SECTION of the sidebar. That is placement, not privilege: none of these
 * capabilities implies any admin power, and a moderator granted only `analytics.mapvote` sees an
 * Admin section containing exactly one page.
 */
import { onDemand } from "../../lib/onDemand";
import { Hub, ScreenLoading, type HubTab } from "../ui";

// Each analytics page's code is fetched the first time it opens.
const ServerAnalytics = onDemand(() => import("./ServerAnalytics"), "default", ScreenLoading);
const MatchAnalytics = onDemand(() => import("./MatchAnalytics"), "default", ScreenLoading);
const PlayerAnalytics = onDemand(() => import("./PlayerAnalytics"), "default", ScreenLoading);
const CombatAnalytics = onDemand(() => import("./CombatAnalytics"), "default", ScreenLoading);
const CompositionAnalytics = onDemand(() => import("./CompositionAnalytics"), "default", ScreenLoading);
const AnnouncementAnalytics = onDemand(() => import("./AnnouncementAnalytics"), "default", ScreenLoading);
const StaffAnalytics = onDemand(() => import("./StaffAnalytics"), "default", ScreenLoading);
const MapVoteAnalytics = onDemand(() => import("./MapVoteAnalytics"), "default", ScreenLoading);

export interface AnalyticsCaps {
  server: boolean;
  match: boolean;
  player: boolean;
  combat: boolean;
  composition: boolean;
  staff: boolean;
  announcements: boolean;
  mapvote: boolean;
}

export function AnalyticsHub({ caps, tab, onTab }: { caps: AnalyticsCaps; tab?: string; onTab?: (id: string) => void }) {
  const tabs: HubTab[] = [
    { id: "server", label: "Server", show: caps.server, render: () => <ServerAnalytics /> },
    { id: "match", label: "Matches", show: caps.match, render: () => <MatchAnalytics /> },
    { id: "player", label: "Players", show: caps.player, render: () => <PlayerAnalytics /> },
    { id: "combat", label: "Combat", show: caps.combat, render: () => <CombatAnalytics /> },
    { id: "composition", label: "Composition", show: caps.composition, render: () => <CompositionAnalytics /> },
    { id: "staff", label: "Staff", show: caps.staff, render: () => <StaffAnalytics /> },
    { id: "mapvote", label: "Map votes", show: caps.mapvote, render: () => <MapVoteAnalytics /> },
    { id: "announcements", label: "Announcements", show: caps.announcements, render: () => <AnnouncementAnalytics /> },
  ];
  return <Hub routeId="analytics" tabs={tabs} active={tab} onChange={onTab} />;
}
