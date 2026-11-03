"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, clearToken, getToken, renewToken, setToken } from "../lib/api";
import { holdReturnRoute, takeReturnRoute } from "../lib/signin-return";
import { Callout, EmptyState, ScreenLoading } from "../components/ui";
import { APP_NAME, BRAND_MARK } from "../lib/brand";
import Auth from "../components/Auth";
import { SetupWalkthrough } from "../components/Setup";
import { onDemand } from "../lib/onDemand";
import type { Widget } from "../components/LayoutEditor";
import type { HubCaps } from "../components/hubs";
import type { AnalyticsCaps } from "../components/analytics/AnalyticsHub";
import { ScreenBoundary } from "../components/ScreenBoundary";
import { SettingsMenu } from "../components/SettingsMenu";
import PullToRefresh from "../components/PullToRefresh";
import { TrailNav } from "../components/TrailNav";
import { QuickBar } from "../components/QuickBar";
import { Icon } from "../components/icons";
import { ServerProvider } from "../lib/servers";
import { GrantsProvider } from "../lib/grants";
// One implementation of "does this account hold X", shared with the panel gate — see lib/access.
import { hasCap, previewGrantsForRole } from "../lib/access";
import { RequestModeProvider } from "../lib/requestMode";
import { RequestBar } from "../components/RequestBar";
import { RolePreviewProvider, type PreviewRole } from "../lib/rolePreview";
import { RolePreviewBar } from "../components/RolePreviewBar";
import { DemoBar } from "../components/DemoBar";
import ServerSwitcher, { ServerBadge } from "../components/ServerSwitcher";
import SidebarStatus from "../components/SidebarStatus";
import { CommandK, type Command } from "../components/CommandPalette";
import { AppNavProvider, useHashRoute } from "../lib/nav";
import { OUTRIGHT_CAPS, ROUTES, SECTIONS, canOpenRoute, pluginRouteById, routeById, setPluginPages, tabsOf, type PluginPageInfo, type RouteDef } from "../lib/routes";
import { readUserPrefs, applyDensity, applyPhoneBar } from "../lib/userPrefs";
import { adoptAccountPrefs, pushAccountPrefs, type AccountPrefs } from "../lib/accountPrefs";
import { applyDisplayZone } from "../lib/zones";
import { GameProvider } from "../lib/game";
import { FeedbackProvider, useToast } from "../lib/feedback";
import { recordRecent, type RecentTarget } from "../lib/recent";
import { signOutPush, syncPush } from "../lib/push";
import { WhatsNewPopup } from "../components/WhatsNew";
import { WHATS_NEW, lastSeen, markSeen, unseenReleases, type WhatsNewRelease } from "../lib/whatsNew";
import { lockedNow, newlyTheirs, walkCheckKey, type WalkCheck } from "../lib/walkNotice";
import { markSetupSeen, setupSeen } from "../lib/gettingStarted";
import { fitMenu, keepActiveInView, screenRoom, useMenuWatch } from "../lib/menuFit";

// A plugin's page, whose code the API sends only to a viewer who may open it (PluginPage). Loaded on
// demand and never server-rendered; the loading state is nothing on purpose, so the address renders
// nothing until the shell has decided what the viewer is allowed to know exists.
const PluginPage = onDemand(() => import("../components/PluginPage"), "PluginPage");

// Every destination loads on demand too: its code is fetched the first time it opens, so a phone
// opening the panel downloads the shell and the one screen it is on, not every screen there is.
// A screen whose code cannot be fetched (the panel was updated under an open tab) is handled by
// ScreenBoundary around the screen area.
const Dashboard = onDemand(() => import("../components/Dashboard"), "default", ScreenLoading);
const LiveView = onDemand(() => import("../components/LiveView"), "default", ScreenLoading);
const Community = onDemand(() => import("../components/Community"), "default", ScreenLoading);
const LayoutEditor = onDemand(() => import("../components/LayoutEditor"), "default");
const WidgetRenderer = onDemand(() => import("../components/WidgetRenderer"), "default", ScreenLoading);
const StaffProfile = onDemand(() => import("../components/StaffProfile"), "default", ScreenLoading);
const AutoSettingsHub = onDemand(() => import("../components/AutoSettingsHub"), "default", ScreenLoading);
const Maps = onDemand(() => import("../components/Maps"), "default", ScreenLoading);
const DiscordHub = onDemand(() => import("../components/DiscordHub"), "default", ScreenLoading);
const Settings = onDemand(() => import("../components/Settings"), "default", ScreenLoading);
// "Show me on my screen" (Help's walkthroughs): fetched the first time someone asks for it.
const WalkSpotlight = onDemand(() => import("../components/WalkSpotlight"), "default");
// The personal setup each person is walked through once (lib/gettingStarted).
const GettingStarted = onDemand(() => import("../components/GettingStarted"), "default");
// A walkthrough's slideshow opened from Search, over the screen the person is on.
const PlayWalkthrough = onDemand(() => import("../components/Walkthroughs"), "PlayWalkthrough");
// The walkthroughs a person's new permissions opened, shown to them once (lib/walkNotice).
const NewWalkthroughs = onDemand(() => import("../components/Walkthroughs"), "NewWalkthroughs");
const PlayersHub = onDemand(() => import("../components/hubs"), "PlayersHub", ScreenLoading);
const EventsHub = onDemand(() => import("../components/hubs"), "EventsHub", ScreenLoading);
const ModerationHub = onDemand(() => import("../components/hubs"), "ModerationHub", ScreenLoading);
const HelpHub = onDemand(() => import("../components/hubs"), "HelpHub", ScreenLoading);
const HistoryHub = onDemand(() => import("../components/hubs"), "HistoryHub", ScreenLoading);
const AdminHub = onDemand(() => import("../components/hubs"), "AdminHub", ScreenLoading);
const AnalyticsHub = onDemand(() => import("../components/analytics/AnalyticsHub"), "AnalyticsHub", ScreenLoading);
const MatchDetail = onDemand(() => import("../components/MatchDetail"), "MatchDetail", ScreenLoading);

interface Grant { capability: string; level: string; scopeType?: string; scopeId?: string | null; source?: string }
/** Whether to offer the per-player action menus. EVERYONE gets them now: lacking a permission
 *  files the action as an approval request instead of firing it, so the dialogs are for all
 *  staff and the confirm button says which of the two will happen. The one exception is the
 *  personal wildcard lockout — "this person may not touch this, whatever their roles say". */
const hasAnyAction = (grants: Grant[]) => {
  return !grants.some((g) => !g.source && g.capability === "*" && g.level === "none" && g.scopeType !== "server");
};

const FALLBACK: Widget[] = ["players", "community"].map((id, i) => ({
  id,
  title: id[0].toUpperCase() + id.slice(1),
  visible: true,
  order: i,
  required: false,
}));

/**
 * Map a view id to its screen. Several ids are LEGACY — surfaces that were consolidated into a hub
 * or another view's tab. They still resolve (deep links, stored layouts, the command palette) by
 * opening their hub on the right tab, so no saved link ever dead-ends.
 */
function renderView(widget: Widget | undefined, view: string, grants: Grant[], target: RecentTarget | null, unseenAnn = 0, pluginsListed = true) {
  const caps: HubCaps = {
    serverView: hasCap(grants, "server.view"),
    vip: hasCap(grants, "vip.grant") || hasCap(grants, "vip.revoke"),
    bans: hasCap(grants, "moderation.bans"),
    staffAnalytics: hasCap(grants, "audit.trail"),
    adminUsers: hasCap(grants, "admin.users"),
    adminOnline: hasCap(grants, "admin.online"),
    // Everyone files and everyone reads their own outcomes — asking needs no grant at all.
    requests: true,
    // …but reviewing the whole team's finished requests is its own grant.
    requestsHistory: hasCap(grants, "moderation.requests.history"),
    serverConfig: hasCap(grants, "server.config"),
    serverConfigManage: hasCap(grants, "server.config"),
    serverManage: hasCap(grants, "server.manage"),
    // Adding a server carries its RCON password, so it is never asked for: the permission itself.
    serverAdd: hasCap(grants, "server.add", "write"),
    serverAdmins: hasCap(grants, "server.admins"),
    serverAdminsManage: hasCap(grants, "server.admins"),
    // Both are write-only capabilities in the API — the console is a send box and the template
    // screen is an editor — so in practice these open for holders, and for anyone building a
    // request (whose view is widened), where a command or an edit is asked for, never refused.
    console: hasCap(grants, "admin.console"),
    templates: hasCap(grants, "templates.manage"),
    crconImport: hasCap(grants, "crcon.pull"),
    crconImportRun: hasCap(grants, "crcon.pull", "write"),
    serverEngagement: hasCap(grants, "server.engagement"),
    serverManageEdit: hasCap(grants, "server.manage", "write"),
    vipPresets: hasCap(grants, "vip.presets"),
    vipPresetsManage: hasCap(grants, "vip.presets"),
    trim: hasCap(grants, "admin.trim"),
    dataPort: hasCap(grants, "admin.data"),
    mapVote: hasCap(grants, "mapvote.config"),
    groups: hasCap(grants, "player.groups"),
    groupsManage: hasCap(grants, "player.groups"),
    // The tab shows for anyone who can see one of its panels. Gating it on economy.config alone
    // made a balances-read grant — the "can look at member balances, cannot touch them" reviewer —
    // invisible: the routes would have served them and the panel never let them ask.
    economy: hasCap(grants, "economy.config") || hasCap(grants, "economy.shop") || hasCap(grants, "economy.balances"),
    economyManage: hasCap(grants, "economy.config"),
    payout: hasCap(grants, "economy.payout"),
    payoutRun: hasCap(grants, "economy.payout"),
    // Scheduling an event and paying one are different trusts, each answering for its own job — the
    // API reads them the same way.
    events: hasCap(grants, "events.manage"),
    eventsManage: hasCap(grants, "events.manage"),
    eventReport: hasCap(grants, "analytics.server") || hasCap(grants, "analytics.match"),
    // Messaging players is one grant whether it is one player from their profile or everyone on
    // the server from the Messages tab — it is the same command either way.
    messagePlayers: hasCap(grants, "action.message"),
    watchlist: hasCap(grants, "player.watchlist"),
    broadcast: hasCap(grants, "broadcast.config"),
    broadcastManage: hasCap(grants, "broadcast.config"),
    grants,
  };
  // Each analytics page is granted on its own — none of them implies any other, and none implies
  // admin. A tab the user lacks is not rendered, so nobody is offered a page that would only 403.
  const analyticsCaps: AnalyticsCaps = {
    server: hasCap(grants, "analytics.server"),
    match: hasCap(grants, "analytics.match"),
    player: hasCap(grants, "analytics.player"),
    combat: hasCap(grants, "analytics.combat"),
    composition: hasCap(grants, "analytics.composition"),
    staff: hasCap(grants, "analytics.staff"),
    announcements: hasCap(grants, "analytics.announcements"),
    mapvote: hasCap(grants, "analytics.mapvote"),
  };
  const playerProps = {
    canNotes: hasCap(grants, "player.notes"),
    canFlags: hasCap(grants, "player.watchlist"),
    canActions: hasAnyAction(grants),
    canGroups: hasCap(grants, "player.groups"),
    canVip: hasCap(grants, "vip.grant"),
    canVipPause: hasCap(grants, "vip.pause"),
    openPlayerId: target?.playerId,
  };
  // A page a plugin adds: drawn when the API listed it to this viewer and the grants on screen open
  // it — a role preview's included. Anyone else gets what any address with nothing at it gets.
  const pluginRoute = pluginRouteById(view);
  if (pluginRoute && canOpenRoute(grants, pluginRoute)) return <PluginPage plugin={pluginRoute.plugin} page={pluginRoute.id} title={pluginRoute.title} />;
  switch (view) {
    case "dashboard": return <Dashboard unseenAnnouncements={unseenAnn} />;
    // Open to everyone: the page that tells you where things are cannot be one of the things you
    // need a permission to find. Its own content is filtered by what you hold.
    case "help": return <HelpHub />;
    case "live": return <LiveView canFlags={hasCap(grants, "player.watchlist")} canActions={hasAnyAction(grants)} canGroups={hasCap(grants, "player.groups")} canVip={hasCap(grants, "vip.grant")} canVipPause={hasCap(grants, "vip.pause")} />;

    // --- People (Players hub) ---
    case "players": return <PlayersHub caps={caps} playerProps={playerProps} />;
    case "leaderboard": return <PlayersHub caps={caps} playerProps={playerProps} tab="leaderboard" />;
    case "vips": return <PlayersHub caps={caps} playerProps={playerProps} tab="vips" />;
    case "economy": return <PlayersHub caps={caps} playerProps={playerProps} tab="economy" />;

    // --- Events: scheduled windows, the payouts that reward them, per-event analytics ---
    case "events": return <EventsHub caps={caps} />;

    // --- Enforcement (Moderation hub) ---
    // "blacklist" survives as a case so old bookmarks land on Bans, its successor.
    case "moderation": case "bans": case "blacklist": return <ModerationHub caps={caps} />;

    // --- In-game record (History hub). The retired plain event list's old "/events" path now
    // belongs to the Events hub above; "logs" still lands here. ---
    case "history": case "logs": return <HistoryHub caps={caps} />;
    case "matches": return <HistoryHub caps={caps} tab="matches" />;
    case "mapvotes": return <HistoryHub caps={caps} tab="mapvotes" />;

    // --- Analytics. Five pages, five independent capabilities; the Admin section is where they
    // sit, not what they require. ---
    case "analytics": return <AnalyticsHub caps={analyticsCaps} />;

    // --- Instance + team administration (Admin hub). Staff activity lives here: it reports on the
    // staff team, so it belongs beside the accounts rather than beside the game log. ---
    case "admin": case "users": return <AdminHub caps={caps} />;
    case "activity": return <AdminHub caps={caps} tab="activity" />;
    case "staff": return target?.userId ? <StaffProfile userId={target.userId} /> : <AdminHub caps={caps} tab="activity" />;
    // A round is its own destination. Without an id in the URL there is no round to show, so
    // fall back to the list you would have picked one from.
    case "match": return target?.matchId
      ? <MatchDetail matchId={target.matchId} onBack={() => window.history.back()} />
      : <HistoryHub caps={caps} tab="matches" />;
    case "templates": return <AdminHub caps={caps} tab="templates" />;
    case "trim": return <AdminHub caps={caps} tab="trim" />;
    case "system": return <AdminHub caps={caps} tab="system" />;

    // --- Server-scoped config. "servers"/"autosettings" are tabs of Config now. ---
    // The Config hub was folded into Administration — old stored layouts still resolve.
    case "config": return <AdminHub caps={caps} tab="live" />;
    case "servers": return <AdminHub caps={caps} tab="connections" />;
    case "autosettings": return <AutoSettingsHub
      canAuto={hasCap(grants, "autosettings.profiles")}
      canSeedingView={hasCap(grants, "seeding.config")}
      canRules={hasCap(grants, "admin.moderation")}
      canChatFilter={hasCap(grants, "moderation.chatfilter")}
      canZones={hasCap(grants, "moderation.zones")}
      canGround={hasCap(grants, "admin.moderation") && hasCap(grants, "seeding.config")}
    />;
    case "maps": return <Maps canManage={hasCap(grants, "maps.next")} canRotate={hasCap(grants, "maps.rotation")} canName={hasCap(grants, "maps.names")} canVote={hasCap(grants, "mapvote.config")} showVote={hasCap(grants, "mapvote.config")} />;
    // The raw console moved from its own nav entry to an Administration tab.
    case "console": return <AdminHub caps={caps} tab="console" />;

    // --- Automation & integrations ---
    // Broadcast became an Administration tab; the old view id still routes there so a stored
    // dashboard layout or a bookmark from before the move lands on it.
    case "broadcast": return <AdminHub caps={caps} tab="broadcast" />;
    case "discord": return <DiscordHub
      canServerConfig={hasCap(grants, "discord.relay")} canServerConfigView={hasCap(grants, "discord.relay")}
      canAdminUsers={hasCap(grants, "admin.users")} canAdminUsersView={hasCap(grants, "admin.users")}
      canDiscordSetup={hasCap(grants, "discord.setup")}
      canCommunity={hasCap(grants, "community.edit")} canCommunityView={hasCap(grants, "community.edit")}
    />;

    // The board links to the two things that moved off it; each link appears only if its
    // destination would actually open for this user.
    case "community": return <Community
      canEdit={hasCap(grants, "community.edit")}
      canDiscord={hasCap(grants, "community.edit")}
      canReadAnalytics={hasCap(grants, "analytics.announcements")}
    />;
    case "settings": return <Settings />;
    default:
      // plugin-provided view: render its declarative `view` via the bridge.
      if (widget?.view) return <WidgetRenderer widget={widget} />;
      // An address with nothing at it. Until the plugin pages are listed it may yet be one of
      // them, so it waits rather than flashing the nothing it is about to stop being.
      if (!widget) return pluginsListed ? <EmptyState title="There's nothing here." /> : null;
      return (
        <div className="card">
          <h1>{widget?.title ?? view}</h1>
          <p className="muted">This plugin registered a view without a UI descriptor.</p>
        </div>
      );
  }
}

/** Toast the outcome of a "Link Discord" round-trip (the callback leaves it in the URL fragment).
 *  Lives inside FeedbackProvider for the same reason as the announcements notice below. */
function DiscordLinkNotice({ result }: { result: string }) {
  const toast = useToast();
  const [told, setTold] = useState(false);
  useEffect(() => {
    if (!result || told) return;
    setTold(true);
    if (result === "merged") toast.success("Discord linked — your duplicate Discord-created account was merged into this one (history combined).");
    else if (result === "1") toast.success("Discord linked — Discord sign-in now lands on this account.");
    else toast.error(result);
  }, [result, told, toast]);
  return null;
}

/** One quiet heads-up per visit when announcements were posted since this user last looked.
 *  Lives inside FeedbackProvider (toasts need it); the nav badge stays until they open the board. */
function NewAnnouncementsNotice({ count }: { count: number }) {
  const toast = useToast();
  const [told, setTold] = useState(false);
  useEffect(() => {
    if (count === 0 || told) return;
    setTold(true);
    toast.info(`${count} new staff announcement${count === 1 ? "" : "s"} since you were last here — see Announcements.`);
  }, [count, told, toast]);
  return null;
}

export default function Panel() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  /** The owner of a brand-new install is walked through setup before the panel opens (Setup.tsx). */
  const [walkthrough, setWalkthrough] = useState(false);
  const [username, setUsername] = useState("");
  const [discordLinked, setDiscordLinked] = useState<boolean | undefined>(undefined);
  const [linkResult, setLinkResult] = useState(""); // "#discord_linked=…" outcome, toasted once
  // Staff announcements posted since this user last opened the board — badges the nav and fires a
  // one-time notice, then clears the moment they open Announcements.
  const [unseenAnn, setUnseenAnn] = useState(0);
  const [widgets, setWidgets] = useState<Widget[]>(FALLBACK);
  // The pages plugins add that this viewer may open, as the API lists them; null until it has.
  const [pluginPages, setPluginPagesState] = useState<PluginPageInfo[] | null>(null);
  const pluginPagesSeen = useRef("");
  const applyPluginPages = useCallback((pages: PluginPageInfo[]) => {
    // Compared first, so the usual unchanged re-read re-renders nothing.
    const key = JSON.stringify(pages);
    if (key === pluginPagesSeen.current) return;
    pluginPagesSeen.current = key;
    setPluginPages(pages);
    setPluginPagesState(pages);
  }, []);
  const loadPluginPages = useCallback(async (keepOnFailure: boolean) => {
    try {
      applyPluginPages((await api<{ pages?: PluginPageInfo[] }>("/plugin-pages")).pages ?? []);
    } catch {
      // At boot an unreadable list is an empty one, so no address waits on it for ever; later, the
      // list already on screen stands until the next read.
      if (!keepOnFailure) applyPluginPages([]);
    }
  }, [applyPluginPages]);

  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /**
   * Grants as /api/me reports them. While the user has an open draft, the API rides its
   * request-view elevation along in here (source "request-view") — read-clamped visibility, capped
   * by the configured ceiling role, honoured server-side because the draft exists.
   */
  const [meGrants, setMeGrants] = useState<Grant[]>([]);
  // Mirrored from RequestModeProvider so the shell (which renders the provider and cannot read its
  // context) knows whether the bar is up.
  const [reqBuilding, setReqBuilding] = useState(false);
  // The role being previewed (view-as-role), mirrored into the shell so `grants` can narrow to it.
  const [previewRole, setPreviewRole] = useState<PreviewRole | null>(null);
  /**
   * Starting or ending a preview changes whose reads these are. The server list (ServerProvider's
   * reloadKey) and the plugin pages are read again either way; ending one also mounts the whole
   * screen afresh (`shellEpoch`), since what the preview read stands on screen until then. Starting
   * one does not: it is started from the role editor, whose unsaved changes must outlive it, and
   * every other screen reads as the role when it opens.
   */
  const [shellEpoch, setShellEpoch] = useState(0);
  const onPreviewChange = useCallback((role: PreviewRole | null) => {
    setPreviewRole(role);
    if (!role) setShellEpoch((n) => n + 1);
    void loadPluginPages(true);
  }, [loadPluginPages]);
  /**
   * What the shell actually navigates by. The elevation is shown only while the bar is up — and
   * since "Save draft" PARKS the draft server-side (a parked draft confers no elevation), leaving
   * the mode ends the widened view on both layers, not just in the nav.
   */
  const grants = useMemo(
    () => {
      const base = reqBuilding ? meGrants : meGrants.filter((g) => g.source !== "request-view");
      // A role preview replaces the view entirely with the narrowed set — never the union, or the
      // preview would show the previewer's own access beside the role's.
      return previewRole ? previewGrantsForRole(base, previewRole.grants, OUTRIGHT_CAPS) : base;
    },
    [meGrants, reqBuilding, previewRole],
  );
  const [cmdkOpen, setCmdkOpen] = useState(false);
  /** After an update: what changed that this person hasn't seen yet (lib/whatsNew), shown once. */
  const [whatsNew, setWhatsNew] = useState<WhatsNewRelease[]>([]);
  const meId = useRef("");
  /** A walkthrough being played on the screen (components/WalkSpotlight), asked for with "panel:walk". */
  const [spotlight, setSpotlight] = useState<{ walkId: string; step: number; n: number } | null>(null);
  const endSpotlight = useCallback(() => setSpotlight(null), []);
  /** A walkthrough's slideshow opened from Search, asked for with "panel:walkthrough". */
  const [slideshow, setSlideshow] = useState<string | null>(null);
  const endSlideshow = useCallback(() => setSlideshow(null), []);
  /**
   * The walkthroughs this person's new permissions opened (lib/walkNotice). `walkCheck` is the
   * account's record of the last check, as boot read it (null: never checked). A notice found at
   * sign-in is shown at once; one found while the panel is in use waits for the next screen the
   * person opens (`now`), so it never lands on what they are in the middle of.
   */
  const walkCheck = useRef<WalkCheck | null | undefined>(undefined);
  const [walksDue, setWalksDue] = useState<{ ids: string[]; keep: WalkCheck; now: boolean } | null>(null);
  const [walksShown, setWalksShown] = useState<{ ids: string[]; keep: WalkCheck } | null>(null);
  const walksChecked = useRef(false);
  /** Getting started is open: on a first sign-in, or asked for again from Help. */
  const [gettingStarted, setGettingStarted] = useState(false);

  const [authError, setAuthError] = useState("");
  // Boot failed for a reason that is NOT "you are signed out" — see boot(). Held separately from
  // authError, which belongs to the sign-in screen; this one says the session is still good.
  const [bootError, setBootError] = useState("");
  // Phone layout: the sidebar becomes a drawer over the page instead of a column beside it.
  const [narrow, setNarrow] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Location lives in the URL (see lib/nav): deep-linkable, back-button-able, refresh-safe.
  const route = useHashRoute(readUserPrefs().landing);
  const { view, tab, subject, target: navTarget } = route;
  const go = useCallback((v: string, target?: RecentTarget, t?: string) => {
    route.go(v, target, t);
    setDrawerOpen(false); // navigating always dismisses the drawer — it covers what you just opened
  }, [route]);
  // Each screen opened is recent activity (lib/recent), which the dashboard card and Search list —
  // apart from the dashboard, which is home, and a profile or a match, recorded as what it shows.
  useEffect(() => {
    if (!authed || view === "dashboard" || subject) return;
    const screen = routeById(view);
    if (!screen) return;
    const sub = tab ? routeById(`${view}.${tab}`) : undefined;
    recordRecent({ kind: "screen", label: sub ? `${screen.title} › ${sub.title}` : screen.title, view, ...(sub ? { tab } : {}) });
  }, [authed, view, tab, subject]);

  // Consume a Discord OAuth handoff left in the URL fragment (#discord_token / #discord_error) before
  // the first boot, so a successful sign-in stores its session token and a failure surfaces cleanly.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = new URLSearchParams(window.location.hash.slice(1));
    const dt = h.get("discord_token");
    const de = h.get("discord_error");
    const dl = h.get("discord_linked");
    if (dt) setToken(dt);
    else if (dl) setLinkResult(dl);
    else if (de) setAuthError(de);
    if (dt || de || dl) {
      // Discord returns to the panel's root, so the page the trip started on (a profile opened
      // from a Discord alert, say) was held for it; reopen it, or land on the default.
      const back = takeReturnRoute();
      history.replaceState(null, "", window.location.pathname + window.location.search + back);
      if (back) window.dispatchEvent(new HashChangeEvent("hashchange"));
      return;
    }

    // Misconfigured redirect: Discord dropped us on the PANEL ROOT with ?code=…&state=… instead of
    // the API's callback endpoint, which happens when the app's Redirect URI (and/or the sign-in
    // return address on Discord → Setup & status) points at the site root. Without this the page just renders the login
    // screen again with no explanation — the failure looks like "it did nothing".
    const q = new URLSearchParams(window.location.search);
    if (q.get("code") && q.get("state")) {
      setAuthError(
        "Discord sent you back to the panel root instead of the sign-in callback. Set the app's Redirect URI " +
        "(Developer Portal → OAuth2 → Redirects) AND the sign-in return address (Discord → Setup & status) to " +
        `${window.location.origin}/api/auth/discord/callback — they must match exactly.`,
      );
      history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Help → Start here opens the personal setup again.
  useEffect(() => {
    const open = () => setGettingStarted(true);
    window.addEventListener("panel:setup", open);
    return () => window.removeEventListener("panel:setup", open);
  }, []);

  // Help's "Show me on my screen" plays a walkthrough over the panel, from the step it was on. Asked
  // again, it starts again: each request is its own.
  useEffect(() => {
    const play = (e: Event) => {
      const { walkId, step } = (e as CustomEvent<{ walkId: string; step?: number }>).detail ?? {};
      if (walkId) setSpotlight((cur) => ({ walkId, step: step ?? 0, n: (cur?.n ?? 0) + 1 }));
    };
    window.addEventListener("panel:walk", play);
    return () => window.removeEventListener("panel:walk", play);
  }, []);

  // Search found a walkthrough: its slideshow, over this screen.
  useEffect(() => {
    const open = (e: Event) => {
      const { walkId } = (e as CustomEvent<{ walkId: string }>).detail ?? {};
      if (walkId) setSlideshow(walkId);
    };
    window.addEventListener("panel:walkthrough", open);
    return () => window.removeEventListener("panel:walkthrough", open);
  }, []);

  // ⌘K / Ctrl-K toggles the command palette; a screen opens it with "panel:search" (What's new's Show me).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdkOpen((o) => !o); }
    };
    const open = () => setCmdkOpen(true);
    window.addEventListener("keydown", h);
    window.addEventListener("panel:search", open);
    return () => { window.removeEventListener("keydown", h); window.removeEventListener("panel:search", open); };
  }, []);

  // Track the phone breakpoint in JS as well as CSS: a few pieces of chrome (the account chip's
  // labels) are rendered conditionally rather than styled, and the rail is meaningless in a drawer.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => { setNarrow(mq.matches); if (!mq.matches) setDrawerOpen(false); };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // While the drawer is open it owns the screen: Escape closes it and the page behind it can't scroll.
  useEffect(() => {
    if (!drawerOpen) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onEsc);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onEsc); };
  }, [drawerOpen]);

  // Apply the saved density (compact/cozy) and the quick bar's place before first paint of the shell.
  useEffect(() => { const prefs = readUserPrefs(); applyDensity(prefs.density); applyPhoneBar(prefs.phoneBar); }, []);

  // Restore the sidebar collapse preference.
  useEffect(() => { setCollapsed(localStorage.getItem("panel.sidebar") === "collapsed"); }, []);
  const toggleCollapsed = () => setCollapsed((c) => {
    const next = !c;
    localStorage.setItem("panel.sidebar", next ? "collapsed" : "open");
    return next;
  });

  const loadLayout = useCallback(async () => {
    try {
      const r = await api<{ widgets: Widget[] }>("/layout/admin");
      // A reply without its list — a sign-in page or a proxy answering in the API's place reads as
      // an empty one — falls back like a failed read. Drawn as it came, the sidebar's filter over
      // it took the whole panel down.
      setWidgets(Array.isArray(r?.widgets) ? r.widgets : FALLBACK);
      // "dashboard" is a fixed home; otherwise keep the current view if it's a visible widget.
      // The URL is the source of truth now; nothing to reconcile here beyond the widget list.
    } catch {
      setWidgets(FALLBACK);
    }
  }, []);

  // Closing What's new marks it seen on the account, so the person's other devices skip it too.
  const closeWhatsNew = useCallback(() => {
    setWhatsNew([]);
    pushAccountPrefs({ whatsNewSeen: markSeen(meId.current) });
  }, []);

  // Finishing or skipping Getting started marks it seen on the account, so it is not shown again on
  // any of the person's devices. What's new waited for it; switched off on the way through, it does
  // not open after it either, and what it held is marked seen as if closed.
  const closeGettingStarted = useCallback(() => {
    setGettingStarted(false);
    pushAccountPrefs({ setupSeen: markSetupSeen(meId.current) });
    if (whatsNew.length && !readUserPrefs().whatsNew) closeWhatsNew();
  }, [whatsNew.length, closeWhatsNew]);

  /*
   * Which walkthroughs are newly this person's: checked again only when what the last check was
   * made for changes — their own permissions (never a role being previewed, nor a request's wider
   * view), or the build. The first check of all says nothing: it is a starting point, made after
   * Getting started, which shows every walkthrough there is.
   */
  useEffect(() => {
    if (!authed || gettingStarted || walkCheck.current === undefined) return;
    const before = walkCheck.current;
    const key = walkCheckKey(meGrants, WHATS_NEW[0]?.build ?? 0);
    if (before?.for === key) { walksChecked.current = true; return; }
    let alive = true;
    import("../lib/walkthroughs").then(({ WALKTHROUGHS, walkthroughsFor }) => {
      if (!alive) return;
      const mine = walkthroughsFor(meGrants).map((w) => w.id);
      const keep = { for: key, locked: lockedNow(WALKTHROUGHS.map((w) => w.id), mine) };
      const fresh = before ? newlyTheirs(before, mine) : [];
      if (fresh.length) setWalksDue({ ids: fresh, keep, now: !walksChecked.current });
      else {
        walkCheck.current = keep;
        setWalksDue(null);
        pushAccountPrefs({ walkthroughs: keep });
      }
      walksChecked.current = true;
    }).catch(() => { /* asked again when the permissions next change */ });
    return () => { alive = false; };
  }, [authed, gettingStarted, meGrants]);
  // The next screen the person opens is a quiet moment for a notice found while they were busy.
  useEffect(() => { setWalksDue((due) => (due && !due.now ? { ...due, now: true } : due)); }, [view, tab]);
  // Never on top of Getting started, What's new or a walkthrough being played, nor while a role is
  // being previewed: after them.
  useEffect(() => {
    if (!walksDue?.now || walksShown || gettingStarted || whatsNew.length > 0 || spotlight || slideshow || previewRole) return;
    setWalksShown({ ids: walksDue.ids, keep: walksDue.keep });
    setWalksDue(null);
  }, [walksDue, walksShown, gettingStarted, whatsNew.length, spotlight, slideshow, previewRole]);
  // Closed: kept on the account, so it is said once.
  const closeWalksNotice = useCallback(() => {
    if (walksShown) {
      walkCheck.current = walksShown.keep;
      pushAccountPrefs({ walkthroughs: walksShown.keep });
    }
    setWalksShown(null);
  }, [walksShown]);

  /*
   * The phone's drawer is one list that scrolls (globals.css): every destination, then the host
   * status, the server picker and the account row. Each opener lands where it is for — the menu
   * button at the top, the server number on the picker, the initial on the account row.
   */
  const openDrawer = (at?: string) => {
    setDrawerOpen(true);
    requestAnimationFrame(() => {
      const side = document.querySelector<HTMLElement>(".sidebar");
      if (!side) return;
      if (!at) side.scrollTop = 0;
      else side.querySelector(at)?.scrollIntoView({ block: "nearest" });
    });
  };

  // The keys that open Search as this computer's keyboard names them: ⌘ is a Mac's; Windows and
  // Linux press Ctrl (the handler above takes either). Touch screens show no keys (globals.css).
  const searchKeys = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";

  // Signing out: this device's phone notifications go off first (lib/push), then the sign-in.
  const signOut = async () => { await signOutPush(); clearToken(); location.reload(); };

  const boot = useCallback(async () => {
    if (!getToken()) return setAuthed(false);
    try {
      // Fired beside /me, not after it: the display zone should be settled before the first
      // screen renders a timestamp, and waiting a serial round trip for it delays every boot.
      const cfgPromise = api<{ config?: { timezone?: string } }>("/app-config").catch(() => null);
      // A brand-new install's owner is part-way through setup until they finish or skip it.
      const setupPromise = api<{ stage?: string | null }>("/setup/status").catch(() => null);
      const me = await api<{ user: { id: string; username: string; displayName?: string; discordId?: string | null; createdAt?: string }; grants: Grant[]; unseenAnnouncements?: number; prefs?: AccountPrefs; session?: { token?: string } }>("/me");
      // A sign-in running down comes back renewed (see refreshMe), at boot as on every check.
      if (me.session?.token) renewToken(me.session.token);
      // Display the Discord nickname when linked (displayName tracks renames); the raw account
      // username stays in localStorage as the STABLE key for per-user panel preferences.
      setUsername(me.user.displayName || me.user.username);
      setDiscordLinked(Boolean(me.user.discordId));
      try { localStorage.setItem("panel.username", me.user.username); } catch { /* per-user panel prefs keying */ }
      // The account's own theme/accent/density, applied over whatever this browser had cached.
      // Set once on any device and every other one matches — the localStorage copy exists only so
      // the first paint has something before this request lands.
      adoptAccountPrefs(me.prefs);
      // This device's phone notifications, if they are on for this person: said again on every open.
      void syncPush(me.user.id).catch(() => {});
      meId.current = me.user.id;
      // What changed since this person last looked — opened once, unless they switched What's new
      // off (Settings, or Getting started): then it is marked seen without opening, and Help keeps it.
      const unseen = unseenReleases(lastSeen(me.user.id, me.prefs?.whatsNewSeen), me.user.createdAt);
      if (readUserPrefs().whatsNew) setWhatsNew(unseen);
      else if (unseen.length) pushAccountPrefs({ whatsNewSeen: markSeen(me.user.id) });
      walkCheck.current = me.prefs?.walkthroughs ?? null;
      // Everyone is walked through their own setup once: new accounts at their first sign-in, and
      // everyone who was here before it at their next.
      setGettingStarted(!setupSeen(me.user.id, me.prefs?.setupSeen));
      // Every timestamp in the panel is written in one zone: the person's preference (adopted
      // just above), else the community's, else this device's. Applied before the shell renders,
      // so no screen ever flashes a different clock.
      applyDisplayZone((await cfgPromise)?.config?.timezone);
      setMeGrants(me.grants ?? []);
      setUnseenAnn(me.unseenAnnouncements ?? 0);
      setWalkthrough((await setupPromise)?.stage === "walkthrough" && hasCap(me.grants ?? [], "admin.users"));
      setBootError("");
      setAuthed(true);
      void loadPluginPages(false);
      await loadLayout();
    } catch (err) {
      /*
       * ONLY a 401 ends the session. A 401 is the server saying "this credential is no good" —
       * expired, revoked, or from a deleted account — and the honest answer to that is the sign-in
       * screen.
       *
       * Everything else is the panel failing to REACH an answer: a 500 from a slow query, a
       * Cloudflare 502/504, a dropped connection, the API restarting. This used to clear the token
       * for all of them, which meant a few seconds of backend trouble signed out every staff
       * member with the panel open — and the login screen was the only explanation they got, so it
       * read as "my account stopped working". For Discord-only accounts it also meant a full OAuth
       * round trip to get back in. The token is fine; keep it and say what actually happened.
       */
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        setAuthed(false);
        return;
      }
      setBootError((err as Error).message || "Could not reach the panel.");
    }
  }, [loadLayout, loadPluginPages]);

  useEffect(() => { boot(); }, [boot]);

  /**
   * Re-read /me while the tab sits open, so a permission granted (or revoked) reaches the person
   * holding the panel without a reload — "I gave them access ten minutes ago" should not depend
   * on the other person remembering to press F5. Only what can change out from under an open tab
   * is applied: grants, display name, the announcements badge. Theme prefs and the display zone
   * stay as booted, so a background tick never fights a change being made locally. Grants are
   * compared before being set, so the usual no-change tick re-renders nothing.
   */
  const refreshMe = useCallback(async () => {
    if (!getToken()) return;
    try {
      const me = await api<{ user: { username: string; displayName?: string; discordId?: string | null }; grants: Grant[]; unseenAnnouncements?: number; session?: { token?: string } }>("/me");
      // This minute-by-minute check is what keeps a panel in use signed in: when the sign-in has
      // less than six days left the answer carries a fresh week, kept without disturbing anything.
      if (me.session?.token) renewToken(me.session.token);
      setUsername(me.user.displayName || me.user.username);
      setDiscordLinked(Boolean(me.user.discordId));
      setMeGrants((prev) => (JSON.stringify(prev) === JSON.stringify(me.grants ?? []) ? prev : (me.grants ?? [])));
      setUnseenAnn(me.unseenAnnouncements ?? 0);
      // A permission granted or taken away changes which plugin pages are this person's too.
      void loadPluginPages(true);
    } catch (err) {
      // 401 means the account itself was revoked or the session expired — same rule as boot.
      // Anything else is transient; the next tick tries again.
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        setAuthed(false);
      }
    }
  }, [loadPluginPages]);

  useEffect(() => {
    if (!authed) return;
    const onVisible = () => { if (document.visibilityState === "visible") void refreshMe(); };
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refreshMe(); }, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [authed, refreshMe]);

  /**
   * STABLE — RequestModeProvider's start/exit close over this, and the provider's restore effect
   * depends on start. An inline arrow here gets a fresh identity on every shell render, which
   * recreated start, which re-fired the restore effect, which re-POSTed the draft and re-read
   * /me — a quiet network drumbeat for as long as the bar was up.
   */
  const onBuildingChange = useCallback((b: boolean) => { setReqBuilding(b); void refreshMe(); }, [refreshMe]);

  useEffect(() => {
    if (view !== "community" || unseenAnn === 0) return;
    setUnseenAnn(0);
    api("/me/announcements-seen", { method: "POST" }).catch(() => { /* re-badges next login at worst */ });
  }, [view, unseenAnn]);

  // The room the menu fits: the screen this device picked in Settings, or the window itself. Read
  // again once a sign-in lands: each person's pick is kept under their name, and the name this
  // browser had on opening is the last person's to use it, not always the one signing in.
  const [screenSize, setScreenSize] = useState("auto");
  useEffect(() => {
    const read = () => setScreenSize(readUserPrefs().screenSize);
    read();
    window.addEventListener("panel:prefs", read);
    return () => window.removeEventListener("panel:prefs", read);
  }, [authed]);
  const room = screenRoom(screenSize);
  // The menu fits its room and scrolls to the screen that is open (lib/menuFit) — reached by a
  // click, by Search, by a link, or by a deep address the panel first loaded on — and again when the
  // entries change under it. Between those, it fits again whenever its room or its entries change.
  const asideRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!asideRef.current) return;
    fitMenu(asideRef.current, narrow, room);
    keepActiveInView(asideRef.current, narrow);
  }, [authed, walkthrough, view, tab, collapsed, narrow, widgets, pluginPages, grants, shellEpoch, room]);
  useMenuWatch(asideRef, narrow, room, `${authed}/${walkthrough}/${shellEpoch}`);

  // The panel could not load, but the session is intact — say that, rather than showing a sign-in
  // screen that tells a staff member their account is the problem when it is not.
  if (authed === null && bootError) return (
    <main className="auth-wrap">
      <div className="card auth-card">
        <h1>Can&apos;t load the panel</h1>
        <Callout variant="warn">{bootError}</Callout>
        <p className="muted notice">You are still signed in — this is the panel failing to reach the server, not your session ending. It is usually over in a moment.</p>
        <div className="actions">
          <button className="primary" onClick={() => { setBootError(""); boot(); }}>Try again</button>
          <button onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
    </main>
  );
  if (authed === null) return <main className="auth-wrap"><p className="muted">Loading…</p></main>;
  if (!authed) return <Auth onAuthed={boot} initialError={authError} />;
  if (walkthrough) return <SetupWalkthrough onDone={() => setWalkthrough(false)} />;

  // The sidebar is generated from the route registry — one entry per DESTINATION, in its declared
  // section, shown when the user holds any of the capabilities that destination lists. Adding a
  // screen means adding a row to lib/routes.ts; nothing here needs to change.
  // The one shared rule (lib/routes canOpenRoute) — the same question Help asks, so the two can
  // never disagree about whether a screen exists for this account.
  const canRoute = (r: RouteDef) => canOpenRoute(grants, r);
  // Plugin pages follow the panel's own, each in the section it asked for.
  const pluginDests = (pluginPages ?? []).flatMap((p) => pluginRouteById(p.id) ?? []);
  const destinations = [...ROUTES, ...pluginDests].filter((r) => !r.parent && !r.hidden && canRoute(r));
  const fixedNav: Widget[] = destinations.map((r, i) => ({ id: r.id, title: r.title, visible: true, order: i, required: true }));
  // Core dashboard widgets whose data/actions the API gates by a capability — hide the tab when the
  // user lacks it so the nav never shows a tab that only 403s. (Plugin-provided widgets declare
  // their own access server-side, so they're always shown.)
  const WIDGET_CAP: Record<string, string> = { players: "server.view", leaderboard: "server.view", events: "server.view", trim: "admin.trim" };
  const canWidget = (id: string) => !WIDGET_CAP[id] || hasCap(grants, WIDGET_CAP[id]);
  // A stored layout may still list ids that are no longer their own destination — each is a tab of a
  // hub now (or is superseded). Their view ids still RENDER for old deep links; they just aren't
  // nav entries, and the registry already lists the hub that contains them.
  const KNOWN = new Set(ROUTES.map((r) => (r.parent ? r.id.split(".").slice(1).join(".") : r.id)));
  const nav = [...fixedNav, ...widgets.filter((w) => w.visible && canWidget(w.id) && !KNOWN.has(w.id))];
  const activeWidget = widgets.find((w) => w.id === view);

  // Command-palette entries. Every destination AND every tab is searchable by title, by its
  // plain-language description, and by the words someone might type instead of our label — so
  // "where do I set the welcome message?" is answerable without knowing it lives under Config.
  const cmdBase: Command[] = [
    ...destinations.flatMap((r) => {
      const tabs = tabsOf(r.id).filter(canRoute);
      const self: Command = {
        id: `go:${r.id}`, title: r.title, group: r.section ?? "Screens", icon: <Icon name={r.id} />,
        hint: r.blurb, keywords: r.keywords, run: () => go(r.id),
      };
      return [self, ...tabs.map((t): Command => ({
        id: `go:${t.id}`,
        title: `${r.title} › ${t.title}`,
        group: r.section ?? "Screens",
        icon: <Icon name={r.id} />,
        hint: t.blurb,
        keywords: t.keywords,
        run: () => go(r.id, undefined, t.id.slice(r.id.length + 1)),
      }))];
    }),
    ...nav.filter((w) => !routeById(w.id)).map((w) => ({
      id: `go:${w.id}`, title: w.title, group: "More", icon: <Icon name={w.id} />, run: () => go(w.id),
    })),
    { id: "act:appearance", title: "Settings", group: "Actions", icon: <Icon name="settings" />, hint: "Theme, accent colour, density, and where the app opens.", keywords: ["preferences", "theme", "density", "landing"], run: () => go("settings") },
    { id: "act:editlayout", title: editing ? "Close layout editor" : "Edit dashboard layout", group: "Actions", hint: "Choose which tiles appear on the dashboard.", run: () => setEditing((v) => !v) },
    { id: "act:logout", title: "Log out", group: "Actions", run: () => void signOut() },
  ];

  // The collapse preference only means anything for a sidebar that sits beside the content. A drawer
  // is already hidden by default, so on a phone it always opens at full width with labels.
  const railed = collapsed && !narrow;

  return (
    <FeedbackProvider>
      <NewAnnouncementsNotice count={unseenAnn} />
      <DiscordLinkNotice result={linkResult} />
    <GrantsProvider grants={grants}>
    <ServerProvider reloadKey={previewRole?.id ?? ""}>
    <GameProvider>
    <AppNavProvider value={{ view, tab, subject, go, setTab: route.setTab }}>
    <RequestModeProvider onBuildingChange={onBuildingChange}>
    <RolePreviewProvider onChange={onPreviewChange}>
    <div key={shellEpoch} className={`app-shell ${railed ? "collapsed" : ""} ${drawerOpen ? "drawer-open" : ""}`}>
      <RequestBar />
      <RolePreviewBar />
      {/* Phone-only chrome. On a narrow screen the sidebar slides in over the page, so the only
          things that stay on screen are the drawer handle, the brand, search and the account. */}
      <header className="topbar">
        {/* The unread-announcements mark lives on the Announcements nav item — which, on a phone,
            is inside a drawer nobody has opened. The count was therefore invisible to exactly the
            people who read the panel on their phone, which is most of them. The burger carries a
            dot so there is a reason to open the drawer in the first place; the count itself stays
            on the nav item, where it says which destination it belongs to. */}
        <button className="burger" onClick={() => openDrawer()} aria-label={unseenAnn > 0 ? `Open navigation — ${unseenAnn} new announcements` : "Open navigation"} aria-expanded={drawerOpen}>
          ☰{unseenAnn > 0 && <span className="burger-dot" aria-hidden />}
        </button>
        <div className="brand"><span className="brand-mark">{BRAND_MARK}</span><span className="brand-name">{APP_NAME}</span></div>
        <ServerBadge onOpen={() => openDrawer(".server-switcher")} />
        <span className="topbar-spacer" />
        <TrailNav />
        <button className="cmdk-trigger" onClick={() => setCmdkOpen(true)} title={`Search (${searchKeys})`} aria-label="Search">
          <span className="cmdk-trigger-ico" aria-hidden>⌕</span>
          <span className="nav-label">Search</span>
          <kbd className="nav-label">{searchKeys}</kbd>
        </button>
        <button className="topbar-account" onClick={() => openDrawer(".sidebar-footer")} title="Account & settings" aria-label="Account & settings">
          <span className="avatar">{(username || "?").charAt(0).toUpperCase()}</span>
        </button>
      </header>
      {narrow && (
        <QuickBar view={view} tab={tab} go={go} onSearch={() => setCmdkOpen(true)} onMore={() => openDrawer()}
          can={(id) => { const r = routeById(id); return Boolean(r && canRoute(r)); }} />
      )}
      <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden />
      <aside className="sidebar" ref={asideRef}>
        <div className="brand">
          <span className="brand-mark">{BRAND_MARK}</span>
          <span className="brand-name">{APP_NAME}</span>
          <button className="collapse-btn" title={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleCollapsed}>{collapsed ? "»" : "«"}</button>
        </div>
        <div className="sidebar-toolrow">
          <TrailNav />
          <button className="cmdk-trigger" onClick={() => setCmdkOpen(true)} title={`Search (${searchKeys})`}>
            <span className="cmdk-trigger-ico" aria-hidden>⌕</span>
            <span className="nav-label">Search</span>
            <kbd className="nav-label">{searchKeys}</kbd>
          </button>
        </div>
        <nav className="nav">
          {(() => {
            // Ungrouped destinations (the dashboard) lead; then each section in registry order;
            // then anything a plugin contributed without a section of its own, under "More".
            const sectionOf = (id: string) => routeById(id)?.section;
            const looseFromPlugin = (id: string) => Boolean(pluginRouteById(id)) && !sectionOf(id);
            const groups: { label: string | null; items: Widget[] }[] = [
              { label: null, items: nav.filter((n) => !sectionOf(n.id) && routeById(n.id) && !looseFromPlugin(n.id)) },
              ...SECTIONS.map((label) => ({ label, items: nav.filter((n) => sectionOf(n.id) === label) })),
              { label: "More", items: nav.filter((n) => !routeById(n.id) || looseFromPlugin(n.id)) },
            ];
            return groups.filter((g) => g.items.length).map((g, gi) => (
              // A section of one entry is marked: as the menu tightens, its heading is the first to go.
              <div key={gi} className={`nav-group${g.label && g.items.length === 1 ? " single" : ""}`}>
                {g.label && <div className="nav-group-label">{g.label}</div>}
                {g.items.map((w) => {
                  /*
                   * The open destination lists its own tabs right here, indented. The tab bar in
                   * the page header scrolls, so on a hub with many tabs (Administration has ten)
                   * the ones past the edge were invisible unless you knew to drag the strip — a
                   * mouse has no horizontal wheel. Here every tab is on screen at once, stacked,
                   * with nothing to discover. A rail (collapsed sidebar) has no room for labels,
                   * so it keeps to icons and leaves the tab bar to do the job.
                   */
                  const myTabs = tabsOf(w.id).filter(canRoute);
                  const subTabs = view === w.id && !railed ? myTabs : [];
                  const tabIdOf = (id: string) => id.split(".").slice(1).join(".");
                  const activeTab = tab ?? (subTabs[0] ? tabIdOf(subTabs[0].id) : undefined);
                  /*
                   * On a phone the sidebar is a drawer over the page, and navigating dismisses it.
                   * That made the sub-nav unreachable: tapping a destination revealed its tabs and
                   * closed the drawer over them in the same gesture, so every tab took an extra
                   * trip through the burger. Tapping a destination that HAS tabs therefore keeps
                   * the drawer up — it opens the destination and shows the tabs it just revealed.
                   * Picking one of those tabs dismisses the drawer, as does the scrim or Escape.
                   */
                  const revealsTabs = narrow && myTabs.length > 1;
                  return (
                    <div key={w.id} className="nav-entry">
                      <button
                        className={`nav-item ${view === w.id ? "active" : ""}`}
                        data-route={w.id}
                        onClick={() => (revealsTabs ? route.go(w.id) : go(w.id))}
                        aria-expanded={revealsTabs ? view === w.id : undefined}
                        title={routeById(w.id)?.blurb ?? w.title}
                      >
                        <span className="ico"><Icon name={w.id} /></span>
                        <span className="nav-label">{w.title}</span>
                        {w.id === "community" && unseenAnn > 0 && <span className="nav-count" aria-label={`${unseenAnn} new announcements`}>{unseenAnn}</span>}
                      </button>
                      {/* One tab is not a choice — a hub with a single visible tab shows none. */}
                      {subTabs.length > 1 && (
                        <div className="nav-subnav">
                          {subTabs.map((t) => {
                            const tid = tabIdOf(t.id);
                            return (
                              <button
                                key={t.id}
                                className={`nav-subitem ${activeTab === tid ? "active" : ""}`}
                                data-route={t.id}
                                onClick={() => go(w.id, undefined, tid)}
                                title={t.blurb ?? t.title}
                              >
                                {t.title}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </nav>
        <div className="sidebar-spacer" />
        {/* Host figures are read with the audit trail (/health/metrics). For anyone else the read
            was refused and the line said "Offline" while the panel was up. */}
        {hasCap(grants, "audit.trail", "read") && <SidebarStatus />}
        <ServerSwitcher />
        <div className="sidebar-footer">
          <SettingsMenu
            username={username}
            editing={editing}
            collapsed={railed}
            onOpenSettings={() => go("settings")}
            discordLinked={discordLinked}
            onEditLayout={() => { setEditing((v) => !v); setDrawerOpen(false); }}
            onLinkDiscord={() => {
              void api<{ url: string }>("/auth/discord/link/start")
                .then((r) => { holdReturnRoute(); window.location.href = r.url; })
                .catch((e) => setLinkResult((e as Error).message));
            }}
            onLogout={() => void signOut()}
          />
        </div>
      </aside>
      {/* Data fills the window; the handful of text-shaped destinations keep a reading measure. */}
      <main className={`content${routeById(view)?.measure === "reading" ? " reading" : ""}`}>
        <DemoBar />
        {editing && <LayoutEditor widgets={widgets} onClose={() => setEditing(false)} onSaved={loadLayout} canSaveInstance={hasCap(grants, "layout.edit", "write")} />}
        <ScreenBoundary resetKey={`${view}/${tab ?? ""}/${subject ?? ""}`}>
          {renderView(activeWidget, view, grants, navTarget, unseenAnn, pluginPages !== null)}
        </ScreenBoundary>
      </main>
      <CommandK open={cmdkOpen} onClose={() => setCmdkOpen(false)} base={cmdBase} />
      {/* Setup first; what changed in an update can wait until it is done — and until a walkthrough
          it started is over: Show me around points at the screen, and would be lost under it. */}
      {gettingStarted && <GettingStarted name={username} onDone={closeGettingStarted} />}
      {whatsNew.length > 0 && !gettingStarted && !spotlight && !slideshow && <WhatsNewPopup releases={whatsNew} onClose={closeWhatsNew} />}
      {spotlight && <WalkSpotlight key={spotlight.n} walkId={spotlight.walkId} startAt={spotlight.step} onClose={endSpotlight} />}
      {slideshow && <PlayWalkthrough key={slideshow} walkId={slideshow} onClose={endSlideshow} />}
      {walksShown && <NewWalkthroughs ids={walksShown.ids} onClose={closeWalksNotice} />}
      {/* Mounted once for the whole app: every screen's data reloads through the same signal, so
          there is nothing per-view to keep in step. Touch-only — the desktop panel never sees it. */}
      <PullToRefresh />
    </div>
    </RolePreviewProvider>
    </RequestModeProvider>
    </AppNavProvider>
    </GameProvider>
    </ServerProvider>
    </GrantsProvider>
    </FeedbackProvider>
  );
}
