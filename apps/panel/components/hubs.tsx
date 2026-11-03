"use client";
/**
 * Consolidated nav destinations. Each hub groups surfaces that operate on the SAME thing under one
 * sidebar entry with capability-gated tabs, instead of scattering them across separate views:
 *
 * A tab is gated TWICE and the two gates must agree: `show` below decides the tab bar, and the same
 * tab's `caps` in lib/routes.ts decides the sidebar's sub-nav. Where they disagreed the sub-nav
 * offered a tab the hub then refused to render, so clicking it silently landed you on a different
 * one. routes.test.mjs pins the registry half; keep `show` reading the same capability at the same
 * level as the row it mirrors.
 *
 *   PlayersHub    — the people directory: Players | Leaderboard | VIPs
 *   ModerationHub — enforcement records: Bans
 *   HistoryHub    — what happened in game: Game log | Matches | Map votes
 *   AdminHub      — running the instance + the team: Users & roles | Staff activity | Templates |
 *                   Data trim | System
 *
 * Tabs whose capability the user lacks are hidden, so nobody is offered a page that would only 403.
 * Every child renders headerless (PanelHeader) — the Hub supplies the page header + tab bar.
 */
import { useState } from "react";
import { onDemand } from "../lib/onDemand";
import { Hub, ScreenLoading, type HubTab } from "./ui";
import { useAppNav } from "../lib/nav";
import type { ClientGrant } from "../lib/access";
import { KICK_ACTIONS, PUNISH_ACTIONS, WARN_ACTIONS } from "../lib/enforcement";

// Each tab's code is fetched the first time that tab opens (the shell loads this hub the same way),
// so opening one screen never downloads the rest.
const Players = onDemand(() => import("./Players"), "default", ScreenLoading);
const Leaderboard = onDemand(() => import("./Leaderboard"), "default", ScreenLoading);
const Clans = onDemand(() => import("./Clans"), "default", ScreenLoading);
const PlayerTriggers = onDemand(() => import("./PlayerTriggers"), "default", ScreenLoading);
const Vips = onDemand(() => import("./Vips"), "default", ScreenLoading);
const Economy = onDemand(() => import("./Economy"), "default", ScreenLoading);
const Payouts = onDemand(() => import("./Payouts"), "default", ScreenLoading);
const Events = onDemand(() => import("./Events"), "default", ScreenLoading);
const EventReport = onDemand(() => import("./EventReport"), "default", ScreenLoading);
const Bans = onDemand(() => import("./Bans"), "default", ScreenLoading);
const Watchlist = onDemand(() => import("./Watchlist"), "default", ScreenLoading);
const Messages = onDemand(() => import("./Messages"), "default", ScreenLoading);
const Broadcast = onDemand(() => import("./Broadcast"), "default", ScreenLoading);
const Logs = onDemand(() => import("./Logs"), "default", ScreenLoading);
const Matches = onDemand(() => import("./Matches"), "default", ScreenLoading);
const MapVoteHistory = onDemand(() => import("./MapVoteHistory"), "default", ScreenLoading);
const Activity = onDemand(() => import("./Activity"), "default", ScreenLoading);
const Users = onDemand(() => import("./Users"), "default", ScreenLoading);
const Requests = onDemand(() => import("./Requests"), "default", ScreenLoading);
const Templates = onDemand(() => import("./Templates"), "default", ScreenLoading);
const VipPresets = onDemand(() => import("./VipPresets"), "default", ScreenLoading);
const Servers = onDemand(() => import("./Servers"), "default", ScreenLoading);
const AdminCamHistory = onDemand(() => import("./AdminCamHistory"), "default", ScreenLoading);
const Console = onDemand(() => import("./Console"), "default", ScreenLoading);
const Trim = onDemand(() => import("./Trim"), "default", ScreenLoading);
const DataPort = onDemand(() => import("./DataPort"), "default", ScreenLoading);
const System = onDemand(() => import("./System"), "default", ScreenLoading);
const OnlineAccess = onDemand(() => import("./OnlineAccess"), "default", ScreenLoading);
const PlayerGroups = onDemand(() => import("./PlayerGroups"), "PlayerGroups", ScreenLoading);
const ActionRecord = onDemand(() => import("./ActionRecord"), "ActionRecord", ScreenLoading);
const LiveSettings = onDemand(() => import("./ServerConfig"), "LiveSettings", ScreenLoading);
const ConsoleAdmins = onDemand(() => import("./ConsoleAdmins"), "ConsoleAdmins", ScreenLoading);
const HelpStart = onDemand(() => import("./Walkthroughs"), "HelpStart", ScreenLoading);
const HelpPages = onDemand(() => import("./Help"), "HelpPages", ScreenLoading);
const HelpPlaceholders = onDemand(() => import("./Help"), "HelpPlaceholders", ScreenLoading);
const HelpWhatsNew = onDemand(() => import("./WhatsNew"), "HelpWhatsNew", ScreenLoading);

export interface HubCaps {
  serverView: boolean;
  vip: boolean;
  bans: boolean;
  staffAnalytics: boolean;
  adminUsers: boolean;
  /** admin.online — the panel's domain, its tunnel and the stats site's address. */
  adminOnline: boolean;
  requests: boolean;
  /** Review EVERY staff member's finished requests, not just your own. */
  requestsHistory: boolean;
  serverConfig: boolean;
  serverConfigManage: boolean;
  /** server.manage — see/edit the game-server connections. */
  serverManage: boolean;
  /** server.add write — register a new game server. */
  serverAdd: boolean;
  /** server.admins — the game's own console-admin list. */
  serverAdmins: boolean;
  serverAdminsManage: boolean;
  /** admin.console WRITE — the raw RCON command box has no read side. */
  console: boolean;
  /** templates.manage WRITE — likewise: reading the library needs no grant, editing it does. */
  templates: boolean;
  /** crcon.import read — see the CRCON archive panel on Connections; write — run a pull. */
  crconImport: boolean;
  crconImportRun: boolean;
  /** server.engagement write — the observe/active switch and the per-automation switches. */
  serverEngagement: boolean;
  /** server.manage write — add a server, edit its credentials, re-read its name. */
  serverManageEdit: boolean;
  /** vip.presets read — see the VIP presets tab; write — edit the preset buttons. */
  vipPresets: boolean;
  vipPresetsManage: boolean;
  trim: boolean;
  /** admin.data read — the Backup tab (export/import archives; write gates the actions inside). */
  dataPort: boolean;
  mapVote: boolean;
  /** player.groups read — see the Groups tab at all. */
  groups: boolean;
  /** player.groups write — create/delete groups, edit membership. */
  groupsManage: boolean;
  /** Any of economy.config (the settings), economy.shop (the offers), economy.balances (the
   *  members' balances) — see the community economy; economyManage is the settings. */
  economy: boolean;
  economyManage: boolean;
  /** economy.payout read — see the bulk payout history; write — run one. */
  payout: boolean;
  payoutRun: boolean;
  /** events.manage read — see the scheduled windows; write — schedule and cancel them.
   *  Deliberately NOT the same grant as payout: opening a window is not spending anything. */
  events: boolean;
  eventsManage: boolean;
  /** analytics.server or analytics.match read — the event Report tab without event or payout rights. */
  eventReport: boolean;
  /** action.message write — send a message to a player, or to everyone on the server. */
  messagePlayers: boolean;
  /** player.watchlist read — the Watched tab under Moderation. */
  watchlist: boolean;
  /** broadcast.config read/write — see the rotating broadcast list; write to edit it. */
  broadcast: boolean;
  broadcastManage: boolean;
  /** The raw grants, for the few places that gate per SERVER (e.g. a bulk action's server list). */
  grants: ClientGrant[];
}

/** People: the player directory, the leaderboard over the same players, and VIP grants. */
export function PlayersHub({ caps, tab, onTab, playerProps }: {
  caps: HubCaps; tab?: string; onTab?: (id: string) => void;
  playerProps: { canNotes: boolean; canFlags: boolean; canActions: boolean; canGroups: boolean; canVip: boolean; canVipPause: boolean; openPlayerId?: string };
}) {
  const tabs: HubTab[] = [
    { id: "players", label: "Directory", show: caps.serverView, render: () => <Players {...playerProps} /> },
    { id: "leaderboard", label: "Leaderboard", show: caps.serverView, render: () => <Leaderboard /> },
    // Clan tags: every tag the roster has shown, spellings combined, and who wears each — the same
    // read as the directory, so the same people see it.
    { id: "clans", label: "Clans", show: caps.serverView, render: () => <Clans /> },
    // Per-player triggers: pick a player, arm an action to fire when they next connect (or every
    // time). Shown to anyone who can see the directory; the builder itself greys out actions the
    // viewer's role cannot grant, and the API gates creation on the action's own capability.
    { id: "triggers", label: "Triggers", show: caps.serverView, render: () => <PlayerTriggers /> },
    { id: "vips", label: "VIPs", show: caps.vip, render: () => <Vips /> },
    { id: "groups", label: "Groups", show: caps.groups, render: () => <PlayerGroups canManage={caps.groupsManage} grants={caps.grants} /> },
    // The economy sits with the people it belongs to: balances are facts about community members,
    // the way VIP grants are facts about players.
    { id: "economy", label: "Economy", show: caps.economy, render: () => <Economy canManage={caps.economyManage} /> },
  ];
  return (
    <Hub routeId="players" tabs={tabs} active={tab} onChange={onTab} subjectTab="players" />
  );
}

/**
 * Events: everything that happens AS an event — the scheduled windows themselves, the bulk
 * payouts that reward them (docs/bulk-payout.md), and analytics scoped to an event's exact
 * window. Payouts moved here from Players because an event is the thing being operated on:
 * schedule it, run it (optionally with its own map-vote profile pinned), pay it, read it.
 */
export function EventsHub({ caps, tab, onTab }: { caps: HubCaps; tab?: string; onTab?: (id: string) => void }) {
  const nav = useAppNav();
  // "Pay this event" hands an event across tabs: remember which, then switch to Payouts.
  //
  // The nonce is what makes pressing it TWICE work. Setting the same id again is not a state
  // change, so React skipped the render and the effect that points the builder at the event never
  // re-ran: after changing the source by hand, the button silently did nothing until you picked a
  // different event. Every press is now its own value.
  const [payEvent, setPayEvent] = useState<{ id: string; nonce: number } | null>(null);
  const tabs: HubTab[] = [
    // Three tabs, three different grants. Someone who runs Friday night sees the schedule; someone
    // trusted with the float sees Payouts; an analyst sees the Report. The overlaps are real
    // people, but none of the three implies another.
    { id: "schedule", label: "Events", show: caps.events,
      render: () => <Events canRun={caps.eventsManage} grants={caps.grants}
        onPay={caps.payoutRun ? (ev) => { setPayEvent((cur) => ({ id: ev.id, nonce: (cur?.nonce ?? 0) + 1 })); nav.setTab("payouts"); } : undefined} /> },
    { id: "payouts", label: "Payouts", show: caps.payout, render: () => <Payouts canRun={caps.payoutRun} payEvent={payEvent} /> },
    // Who came to an event is what a payout for it pays, so payout holders read reports too.
    { id: "report", label: "Report", show: caps.events || caps.payout || caps.eventReport, render: () => <EventReport /> },
  ];
  return (
    <Hub routeId="events" tabs={tabs} active={tab} onChange={onTab} />
  );
}

/**
 * Enforcement, sorted by what was actually done.
 *
 * This was the ban record alone — one surface, no tab machinery. That made every other decision
 * staff take invisible: a kick, a punish or a team switch existed only as a line in the staff
 * trail, mixed in with role edits and settings changes, so "has anyone dealt with this player"
 * meant reading the whole thing. Each action now has its own tab reading its own slice of the
 * trail, the ban record moves in whole as the first of them, and the send-to-everyone message —
 * itself an admin action — sits with them rather than off in the automation section.
 *
 * The record tabs are `audit.trail`, because that is the data; the ban tab is `moderation.bans`
 * and the message tab is `action.message`. A moderator who can act but not audit sees the doing
 * tabs and not the reading ones, which is the correct shape for those two grants.
 */
export function ModerationHub({ caps, tab, onTab }: { caps: HubCaps; tab?: string; onTab?: (id: string) => void }) {
  const tabs: HubTab[] = [
    { id: "bans", label: "Bans", show: caps.bans, render: () => <Bans /> },
    // The watchlist as a place. It lived only inside the VIP widget, so the one list every
    // moderator is supposed to keep an eye on was findable only by those who already knew.
    { id: "watched", label: "Watched", show: caps.watchlist, render: () => <Watchlist /> },
    { id: "requests", label: "Requests", show: caps.requests, render: () => <Requests canHistory={caps.requestsHistory} /> },
    { id: "messages", label: "Messages", show: caps.messagePlayers,
      render: () => <Messages canSend={caps.messagePlayers} canManagePresets={caps.templates} /> },
    /**
     * Each record covers the automated enforcers as well as the staff.
     *
     * The same act is audited under a different prefix depending on who did it — a kick is
     * `player.kick` by hand, `seed.kick` from the seeding rules, `autosettings.kick` from a rule
     * module. Listing only the manual one made a tab titled "every kick" show a small and
     * unrepresentative fraction of them: on a busy night most enforcement is automatic, and the
     * question these tabs answer ("has this player been dealt with?") does not care which of the
     * three did it. The rows name their actor either way, so an automated one reads as one.
     */
    { id: "kicks", label: "Kicks", show: caps.staffAnalytics,
      render: () => <ActionRecord id="mod-kicks" title="Kicks" subtitle="Every kick — by hand, by a rule, or by the seeding rules."
        actions={KICK_ACTIONS} emptyText="No kicks have been recorded on this server yet." /> },
    { id: "punishments", label: "Punishments", show: caps.staffAnalytics,
      render: () => <ActionRecord id="mod-punishments" title="Punishments" subtitle="Every punish — by hand, by a rule, or by the seeding rules."
        actions={PUNISH_ACTIONS} emptyText="No punishments have been recorded on this server yet." /> },
    // No automated counterpart: no rule module moves anyone between teams, so this one really is
    // "what staff did".
    { id: "switches", label: "Switches", show: caps.staffAnalytics,
      render: () => <ActionRecord id="mod-switches" title="Team switches" subtitle="Moves staff made, immediate or on next death."
        actions={["player.switch", "player.switch_death"]} emptyText="No team switches have been recorded on this server yet." /> },
    { id: "warnings", label: "Warnings", show: caps.staffAnalytics,
      render: () => <ActionRecord id="mod-warnings" title="Warnings" subtitle="Messages sent to one player — usually what comes before anything heavier."
        actions={WARN_ACTIONS} emptyText="No warnings have been recorded on this server yet." /> },
  ];
  return (
    <Hub routeId="moderation" tabs={tabs} active={tab} onChange={onTab} />
  );
}

/**
 * Help: how to do things, and where everything is.
 *
 * No capability on any tab. The page that tells you where things are must not itself be
 * something you need a permission to find — the CONTENT is filtered instead, so a walkthrough you
 * could not follow and a page you could not open are simply not listed.
 */
export function HelpHub({ tab, onTab }: { tab?: string; onTab?: (id: string) => void }) {
  const tabs: HubTab[] = [
    { id: "start", label: "Start here", render: () => <HelpStart /> },
    { id: "pages", label: "All pages", render: () => <HelpPages /> },
    { id: "placeholders", label: "Placeholders", render: () => <HelpPlaceholders /> },
    { id: "whatsnew", label: "What's new", render: () => <HelpWhatsNew /> },
  ];
  // subjectTab: a shared walkthrough link (#/help/start/~id, or an old guide's) must land on Start
  // here whatever tab the reader last had open — same mechanism as a player link landing on the
  // directory.
  return <Hub routeId="help" tabs={tabs} active={tab} onChange={onTab} subjectTab="start" />;
}

/** What happened in game: the live event log, the rounds played, and how each map got chosen. */
export function HistoryHub({ caps, tab, onTab }: { caps: HubCaps; tab?: string; onTab?: (id: string) => void }) {
  const tabs: HubTab[] = [
    { id: "logs", label: "Game log", show: caps.serverView, render: () => <Logs /> },
    { id: "matches", label: "Matches", show: caps.serverView, render: () => <Matches /> },
    // Reading the votes belongs beside the rounds they chose, not inside the settings screen that
    // configures them.
    { id: "mapvotes", label: "Map votes", show: caps.mapVote, render: () => <MapVoteHistory /> },
    // Spectator use is a fact about the game, read after the fact — so it reads here, beside the
    // rest of what happened, rather than on the settings page that switches its announcement on.
    { id: "admincam", label: "Admin camera", show: caps.serverAdmins, render: () => <AdminCamHistory /> },
  ];
  return (
    <Hub routeId="history" tabs={tabs} active={tab} onChange={onTab} />
  );
}

/**
 * Running the instance and the team. Staff activity sits here (not under History) because it's an
 * overview of the staff team — who's doing what — which belongs beside the accounts it reports on,
 * not beside the game log. The old Config hub's tabs (Connections, Live settings, Console admins)
 * live here too: they are settings screens, and settings has ONE home.
 */
export function AdminHub({ caps, tab, onTab }: { caps: HubCaps; tab?: string; onTab?: (id: string) => void }) {
  const tabs: HubTab[] = [
    { id: "users", label: "Users & roles", show: caps.adminUsers, render: () => <Users /> },
    { id: "activity", label: "Staff activity", show: caps.staffAnalytics, render: () => <Activity /> },
    { id: "connections", label: "Connections", show: caps.serverManage || caps.serverAdd || caps.serverConfig || caps.serverEngagement || caps.crconImport,
      render: () => <Servers canAdd={caps.serverAdd} canEdit={caps.serverManageEdit} canManage={caps.serverManage} canEngage={caps.serverEngagement} canImport={caps.crconImport} canImportRun={caps.crconImportRun} canProbe={caps.serverConfig} /> },
    { id: "live", label: "Live settings", show: caps.serverConfig, render: () => <LiveSettings canManage={caps.serverConfigManage} /> },
    // The scrolling top-left line and its rotation: an instance setting written once and left, not
    // a screen normal staff open — which is exactly why it is in here rather than out in the nav.
    { id: "broadcast", label: "Broadcast", show: caps.broadcast,
      render: () => <Broadcast canConfig={caps.broadcastManage} canSend={caps.messagePlayers} /> },
    { id: "admins", label: "Console admins", show: caps.serverAdmins, render: () => <ConsoleAdmins canManage={caps.serverAdminsManage} /> },
    { id: "console", label: "RCON console", show: caps.console, render: () => <Console /> },
    { id: "templates", label: "Templates", show: caps.templates, render: () => <Templates canManage={caps.templates} /> },
    { id: "vippresets", label: "VIP presets", show: caps.vipPresets, render: () => <VipPresets canManage={caps.vipPresetsManage} /> },
    { id: "trim", label: "Data trim", show: caps.trim, render: () => <Trim /> },
    { id: "backup", label: "Backup", show: caps.dataPort, render: () => <DataPort /> },
    { id: "system", label: "System", show: caps.staffAnalytics, render: () => <System /> },
    // How people reach the install from the internet: set once, by whoever runs it.
    { id: "online", label: "Online access", show: caps.adminOnline, render: () => <OnlineAccess canManage={caps.adminOnline} /> },
  ];
  return (
    <Hub routeId="admin" tabs={tabs} active={tab} onChange={onTab} />
  );
}
