"use client";
/**
 * THE ROUTE REGISTRY — one table that names every place in the panel.
 *
 * Before this existed the same information was spread across four files that could disagree: the
 * sidebar built its own list, each hub hard-coded its own tabs and breadcrumb strings, and the
 * command palette knew only the eleven top-level entries (so a tab like "Console admins" was
 * unreachable by search — you had to already know where it lived). Everything now reads from here:
 *
 *   • the sidebar            — sections, order, labels, icons
 *   • the breadcrumb trail   — derived from the route, not typed per page
 *   • the browser URL/title  — `#/players/vips`, "VIPs · Players"
 *   • the command palette    — searches every title, blurb and keyword below
 *
 * `blurb` is the promise this panel makes to a new admin: every destination says, in one plain
 * sentence, what it is for. It shows under the page title AND in search results, so you can find a
 * screen by describing what you want to do rather than by guessing its name.
 */

// The one import this file takes, and with its real ".ts" extension: the node-run tests load this
// module directly, and Node resolves no extensionless sibling. Only ever this direction — access
// knows nothing of routes.
import { hasCap, holdsOutright, isOwner, type ClientGrant } from "./access.ts";

export interface RouteDef {
  /** stable id. Top-level = the view id the shell renders; tabs = "<view>.<tab>". */
  id: string;
  /** the view this belongs to (tabs only). */
  parent?: string;
  /** URL path under the hash: "/players/vips". */
  path: string;
  /** what it's called in the nav, the tab bar, and the breadcrumb. */
  title: string;
  /** one plain sentence: what this screen is for. Shown as the page subtitle and in search. */
  blurb: string;
  /** sidebar grouping for top-level destinations. */
  section?: string;
  /** extra search terms — the words someone might type when they don't know our label. */
  keywords?: string[];
  /**
   * Visible when the user holds ANY of these capabilities (empty/absent = always).
   *
   * A destination's list must COVER every one of its tabs: the sidebar decides whether to show the
   * destination from this list and only then offers the tabs beneath it, so a capability that
   * appears on a tab but not on its parent produces a screen its holder can only reach by typing
   * the URL. `routes.test.mjs` asserts the containment rather than trusting it.
   */
  caps?: string[];
  /** Level those capabilities need. Defaults to the capability's own minimum — see CAP_MIN_LEVEL —
   *  and is only set here to demand MORE than that (a page whose read surface is not worth a tab). */
  capLevel?: "read" | "write";
  /** hidden from the sidebar (still routable + searchable): tabs, and account-level pages. */
  hidden?: boolean;
  /**
   * Offered to OWNERS only — the global "*" grant at write (`isOwner` in lib/access) — and to
   * nobody else, whatever they hold.
   *
   * Not expressible as `caps`: every capability in the catalogue can be handed to a role, and the
   * Administrator preset holds all but one of them, so no capability is "owner only". An owner-only
   * row therefore carries NO caps (routes.test.mjs asserts it) and this flag is the whole gate —
   * applied by `canOpenRoute`, the one predicate every nav surface asks. Help never lists these,
   * for anyone (see HELP_ROUTES): it is the page screen-shared to train staff.
   */
  ownerOnly?: boolean;
  /**
   * `caps` count only when held OUTRIGHT (`holdsOutright` in lib/access): a global grant on the
   * account itself. A "*" confined to one server, or the global read an open request draft lends,
   * does not open it — for destinations that span every server and are granted by name.
   */
  outright?: boolean;
  /**
   * `"reading"` caps the column at a comfortable line length. Everything else fills the window.
   *
   * Data is the default because that is what this app mostly is, and because the opposite default
   * is what made the desktop experience bad: one frame-wide cap gave paragraphs a readable measure
   * by taking the width away from an eighteen-column roster, which then scrolled sideways next to
   * a thousand pixels of empty screen. Only mark a destination `"reading"` when its content really
   * is mostly words — a table on it will be narrower for no reason.
   */
  measure?: "reading";
}

/**
 * Capabilities where Read is not a state — every endpoint behind them demands write.
 *
 * "Do you have this capability at all" is not the same question for every capability. For most it
 * is "at least read". For these there is no read form of the thing: you cannot half-kick somebody,
 * and there is no read-only console. Asking for read would offer the destination to a holder whose
 * every request then 403s — a menu entry that exists only to disappoint.
 *
 * The list mirrors `levels: ["write"]` in the capability catalogue, and an API test asserts the two
 * agree AND that both match what the routes actually enforce. Three copies of a fact is two too
 * many, but the alternative is the nav waiting on a network fetch before it can draw itself; the
 * test is what makes the duplication safe rather than a bug in waiting.
 */
export const CAP_MIN_LEVEL: Readonly<Record<string, "write">> = {
  "action.message": "write",
  "action.kick": "write",
  "action.punish": "write",
  "action.tempban": "write",
  "action.permaban": "write",
  "action.unban": "write",
  "action.switch": "write",
  "action.switch_death": "write",
  "admin.console": "write",
  "api.tokens": "write",
  "layout.edit": "write",
  "maps.next": "write",
  "maps.names": "write",
  "mapvote.control": "write",
  "moderation.bans.sync": "write",
  "player.tags": "write",
  "player.watchlist.curate": "write",
  "server.add": "write",
  "server.engagement": "write",
  "server.manage": "write",
  "templates.manage": "write",
};

/** The level a capability must be held at to count as held. */
export function minLevelFor(capability: string): "read" | "write" {
  return CAP_MIN_LEVEL[capability] ?? "read";
}

/**
 * May this account open the route? THE question every nav surface asks — the sidebar, its sub-nav,
 * the command palette, Help's page directory and its "Take me there" links.
 *
 * It lived as a copy in each of those places while it was one line. The day it grew a second
 * clause (owner-only tabs), every copy that did not grow with it would have offered the tab to
 * people the API then 404s, so it lives here now and nowhere else.
 *
 * Each capability is asked for at its OWN minimum, not at one level for the whole route. `capLevel`
 * used to apply read to everything unless a route said otherwise, which offered Broadcast to
 * somebody holding Read on "Message players" — a state that grants nothing, on a page where every
 * control then 403s. A route may still demand more than the minimum; it may not accidentally
 * demand less.
 */
export function canOpenRoute(grants: ClientGrant[], r: Pick<RouteDef, "caps" | "capLevel" | "ownerOnly" | "outright">): boolean {
  if (r.ownerOnly && !isOwner(grants)) return false;
  const holds = r.outright ? holdsOutright : hasCap;
  return !r.caps?.length || r.caps.some((c) => holds(grants, c, r.capLevel ?? minLevelFor(c)));
}

/** Capabilities that count only when held outright — the caps of every `outright` row. Filled
 *  once ROUTES exists (below); role previews ask them the outright question. */
export const OUTRIGHT_CAPS = new Set<string>();

/** Sidebar section order. A section with no visible destination is skipped entirely. */
export const SECTIONS = ["Monitor", "Community", "Servers", "Automation", "Integrations", "Admin"];

export const ROUTES: RouteDef[] = [
  { id: "dashboard", path: "/dashboard", title: "Dashboard", blurb: "Your at-a-glance overview — server state, recent activity, and the tiles you choose to keep.", keywords: ["home", "overview", "start", "tiles", "widgets"] },
  /**
   * Help sits beside the Dashboard, above every section, and is open to everyone.
   *
   * Sectionless on purpose: it belongs to the app rather than to an area of it, and the one thing a
   * person looking for help must not have to do is work out which section help would be filed
   * under. No `caps` for the same reason — the guides hide the ones you could not follow, but the
   * page itself is never the thing you lack permission to find.
   */
  { id: "help", path: "/help", title: "Help", measure: "reading",
    blurb: "How to do the common things, step by step — and every page in the app, with what it is for.",
    keywords: ["help", "how to", "guide", "docs", "documentation", "tutorial", "getting started", "where is", "cannot find", "lost", "manual", "support"] },
  { id: "help.start", parent: "help", path: "/help/start", title: "Start here", hidden: true, measure: "reading",
    blurb: "Your personal setup, and walkthroughs of what your permissions let you do: each step on a picture of the panel with the button to press ringed, or on your own screen.",
    keywords: ["start", "start here", "walkthrough", "walkthroughs", "tour", "tutorial", "slideshow", "show me", "pictures", "first time", "new staff", "onboarding", "learn", "setup", "personal setup", "getting started", "how to", "how do i", "guide", "guides", "steps", "instructions"] },
  { id: "help.pages", parent: "help", path: "/help/pages", title: "All pages", hidden: true, measure: "reading",
    blurb: "Every screen in the app with a one-line description, including the ones you reach by clicking rather than from the nav.",
    keywords: ["index", "directory", "sitemap", "all pages", "list", "quick links", "shortcuts"] },
  { id: "help.whatsnew", parent: "help", path: "/help/whats-new", title: "What's new", hidden: true, measure: "reading",
    blurb: "What each update changed, in a few plain words — the same notes the panel shows once after an update.",
    keywords: ["whats new", "what's new", "new", "changes", "changed", "update", "updates", "updated", "release notes", "news"] },
  { id: "help.placeholders", parent: "help", path: "/help/placeholders", title: "Placeholders", hidden: true, measure: "reading",
    blurb: "Every placeholder you can type into a message — {player_name}, {vip_until} and the rest — what each fills with, and where it works.",
    keywords: ["placeholder", "placeholders", "token", "tokens", "variables", "player_name", "vip_until", "template", "personalise", "personalize"] },

  // ---- Monitor: what is happening right now, and what already happened ----
  { id: "live", path: "/live", title: "Live", section: "Monitor", caps: ["server.view"],
    blurb: "Who is on the server right now — the scoreboard, team stats, and the live event feed.",
    keywords: ["scoreboard", "roster", "players online", "now", "squads", "kick", "punish", "current match", "who is on"] },
  { id: "history", path: "/history", title: "History", section: "Monitor", caps: ["server.view", "mapvote.config", "server.admins"],
    blurb: "What happened in game — the event log, the rounds played, and how each map was chosen.",
    keywords: ["past", "logs", "record", "yesterday", "search chat"] },
  { id: "history.logs", parent: "history", path: "/history/logs", title: "Game log", hidden: true, caps: ["server.view"],
    blurb: "Every chat line, kill, connection and admin action, filterable and searchable.",
    keywords: ["chat", "kills", "teamkills", "connections", "audit", "event log", "who said"] },
  { id: "history.matches", parent: "history", path: "/history/matches", title: "Matches", hidden: true, caps: ["server.view"],
    blurb: "Every round played: map, duration, score, and who fought in it.",
    keywords: ["rounds", "games", "results", "win", "loss", "score"] },
  { id: "history.admincam", parent: "history", path: "/history/admincam", title: "Admin camera", hidden: true, caps: ["server.admins"],
    blurb: "Who went into spectator, on which server, when, and for how long — and whether players are told when it happens.",
    keywords: ["admin cam", "camera", "spectator", "watching", "cam log", "who was watching"] },
  { id: "history.mapvotes", parent: "history", path: "/history/mapvotes", title: "Map votes", hidden: true, caps: ["mapvote.config"],
    blurb: "Past map votes and how they were decided — candidates, tally, and the winner.",
    keywords: ["votemap", "poll", "winner", "ballots"] },
  // A single round. Not in the sidebar — you arrive by clicking a row in Matches or a line on a
  // player's profile — but it IS a destination, with a URL you can paste and a title of its own.
  { id: "match", path: "/match", title: "Round", hidden: true, caps: ["server.view"],
    blurb: "One round in full: the result, and every player's scoreboard line for it.",
    keywords: ["match", "round", "scoreboard", "game"] },
  { id: "community", path: "/announcements", title: "Announcements", section: "Monitor", measure: "reading",
    blurb: "The staff noticeboard — post notices to your team and see who has read them.",
    keywords: ["notices", "board", "memo", "staff message", "read receipts", "community"] },

  // ---- Community: the people ----
  { id: "players", path: "/players", title: "Players", section: "Community", caps: ["server.view", "vip.grant", "vip.revoke", "player.groups", "economy.config", "economy.shop", "economy.balances"],
    blurb: "Everyone the system has ever seen — profiles, career stats, standings, and VIP grants.",
    keywords: ["records", "search player", "profile", "steam id", "who is", "directory"] },
  { id: "players.players", parent: "players", path: "/players/directory", title: "Directory", hidden: true, caps: ["server.view"],
    blurb: "Search and filter every tracked player by name, platform, last seen, watched or VIP.",
    // "register"/"link" land here because the manual Discord registration lives on a player's
    // profile, one click past this list — and the palette is where people look for it first.
    keywords: ["find", "lookup", "filter", "search", "records", "register", "registration", "link discord", "manual link", "unlink"] },
  { id: "players.leaderboard", parent: "players", path: "/players/leaderboard", title: "Leaderboard", hidden: true, caps: ["server.view"],
    blurb: "Career standings across your servers — kills, K/D, playtime and visits.",
    keywords: ["top", "ranking", "best", "stats", "kd"] },
  { id: "players.clans", parent: "players", path: "/players/clans", title: "Clans", hidden: true, caps: ["server.view"],
    blurb: "Every clan tag players have worn — spellings combined into one — and who wears each, now or before.",
    keywords: ["clan", "clan tag", "tag", "team", "who is in", "members", "combine", "spellings"] },
  { id: "players.vips", parent: "players", path: "/players/vips", title: "VIPs", hidden: true, caps: ["vip.grant", "vip.revoke"],
    blurb: "Who holds a VIP slot on each server, and when it expires.",
    keywords: ["vip", "reserved slot", "perks", "expiry", "donator"] },
  { id: "players.groups", parent: "players", path: "/players/groups", title: "Groups", hidden: true, caps: ["player.groups"],
    blurb: "Saved lists of players you act on together — grant VIP, temp ban or message a whole group at once.",
    keywords: ["bulk", "list", "clan", "team", "batch"] },
  { id: "players.triggers", parent: "players", path: "/players/triggers", title: "Triggers", hidden: true, caps: ["server.view"],
    blurb: "Per-player triggers — fire a message, kick, ban, VIP or points when one player connects, kills or chats; once or every time.",
    keywords: ["trigger", "welcome", "on connect", "on join", "fire once", "per player", "auto message", "watch action"] },
  // The settings, the shop's offers and the balances are each their own trust (view the ledgers ≠
  // edit the settings ≠ price the shop), so the tab opens for any of them, as the API splits them.
  { id: "players.economy", parent: "players", path: "/players/economy", title: "Economy", hidden: true, caps: ["economy.config", "economy.shop", "economy.balances"],
    blurb: "The points economy behind the VIP shop — settings, shop offers, member balances and ledgers.",
    keywords: ["points", "shop", "balance", "ledger", "currency", "claims", "gift"] },
  { id: "events", path: "/events", title: "Events", section: "Community", caps: ["events.manage", "economy.payout", "analytics.server", "analytics.match"],
    blurb: "Community events end to end — schedule the window, pin its maps, pay the people who came, and read how it went.",
    keywords: ["event", "friday night", "schedule", "window", "payout", "reward", "attendance"] },
  { id: "events.schedule", parent: "events", path: "/events/schedule", title: "Events", hidden: true, caps: ["events.manage"],
    blurb: "Windows that open and close themselves — at a set time, or on the match boundaries around it — with an optional map-vote profile pinned while open.",
    keywords: ["schedule", "window", "open", "close", "match start", "cancel", "map vote", "pin"] },
  { id: "events.payouts", parent: "events", path: "/events/payouts", title: "Payouts", hidden: true, caps: ["economy.payout"],
    blurb: "Pay currency or VIP days to many members at once — everyone linked, everyone online, everyone at an event — with receipts.",
    keywords: ["bulk", "payout", "reward", "mass", "vip days", "points", "receipts"] },
  { id: "events.report", parent: "events", path: "/events/report", title: "Report", hidden: true, caps: ["events.manage", "economy.payout", "analytics.server", "analytics.match"],
    blurb: "Analytics for one event's exact window — who came and for how long, the rounds played, and who led the board.",
    keywords: ["attendance", "turnout", "event stats", "how did it go", "rounds", "top players"] },
  /**
   * Moderation grew from one page into a hub: it was the ban record and nothing else, so every
   * other decision staff made — kicks, punishments, switches — was only findable by scrolling the
   * whole staff trail past everything else. One tab per action, sorted, plus the send-to-everyone
   * message that is itself an admin action.
   */
  // server.view is in the list because the Requests tab is for EVERYONE: any staff member can
  // file an approval request and needs somewhere to read the outcome.
  { id: "moderation", path: "/moderation", title: "Moderation", section: "Community", caps: ["moderation.bans", "action.message", "audit.trail", "player.watchlist", "server.view"],
    blurb: "Every enforcement decision, sorted by what was done — bans, the watchlist, kicks, punishments, switches — and messaging the server.",
    keywords: ["ban", "punish", "blacklist", "kick", "banned", "tempban", "permaban", "unban", "appeal", "message", "warn", "switch", "record", "watch", "watchlist", "watched"] },
  { id: "moderation.bans", parent: "moderation", path: "/moderation/bans", title: "Bans", hidden: true, caps: ["moderation.bans"],
    blurb: "The community's ban record — every decision, however many servers it covers.",
    keywords: ["ban", "blacklist", "banned", "tempban", "permaban", "unban", "appeal"] },
  { id: "moderation.requests", parent: "moderation", path: "/moderation/requests", title: "Requests", hidden: true,
    blurb: "Approval requests: anything staff asked to do without holding the permission, and the lines waiting for your signature.",
    keywords: ["requests", "approvals", "approve", "deny", "ask", "pending"] },
  { id: "moderation.watched", parent: "moderation", path: "/moderation/watched", title: "Watched", hidden: true, caps: ["player.watchlist"],
    blurb: "Everyone on the watchlist — searchable by name, reason and staff member, online rows first.",
    keywords: ["watch", "watchlist", "watched", "flagged", "eye", "suspect", "keeping an eye"] },
  { id: "moderation.messages", parent: "moderation", path: "/moderation/messages", title: "Messages", hidden: true, caps: ["action.message"], capLevel: "write",
    blurb: "Send everyone on the server a message that stays on their screen until they acknowledge it — with saved presets.",
    keywords: ["message", "tell everyone", "announce", "notify", "warn", "presets", "all players"] },
  { id: "moderation.kicks", parent: "moderation", path: "/moderation/kicks", title: "Kicks", hidden: true, caps: ["audit.trail"],
    blurb: "Every kick, who made it and why.",
    keywords: ["kick", "removed", "record"] },
  { id: "moderation.punishments", parent: "moderation", path: "/moderation/punishments", title: "Punishments", hidden: true, caps: ["audit.trail"],
    blurb: "Every punish, who made it and why.",
    keywords: ["punish", "kill", "penalty", "record"] },
  { id: "moderation.switches", parent: "moderation", path: "/moderation/switches", title: "Switches", hidden: true, caps: ["audit.trail"],
    blurb: "Every team switch staff have made, immediate or on death.",
    keywords: ["switch", "team", "move", "balance", "swap"] },
  { id: "moderation.warnings", parent: "moderation", path: "/moderation/warnings", title: "Warnings", hidden: true, caps: ["audit.trail"],
    blurb: "Messages sent to one player — the warning that comes before anything heavier.",
    keywords: ["warn", "message", "told", "spoken to"] },

  // ---- Servers: the machines and the match ----
  // (The old Config hub's tabs live under Administration now — one settings destination.)
  { id: "maps", path: "/maps", title: "Maps", section: "Servers", caps: ["server.view", "mapvote.config"],
    blurb: "The map in play, the rotation, what this match is fought over, and how the next map is picked.",
    keywords: ["rotation", "next map", "objectives", "votemap", "map vote", "change map", "skirmish", "offensive"] },
  { id: "maps.vote", parent: "maps", path: "/maps/vote", title: "Vote", hidden: true, caps: ["mapvote.config"],
    blurb: "Run the next-map poll: start, pause, force a map, tell players in game, and watch the count.",
    keywords: ["votemap", "poll", "start vote", "pause", "override", "force map", "reroll", "skip", "leader"] },
  { id: "maps.rotation", parent: "maps", path: "/maps/rotation", title: "Rotation", hidden: true, caps: ["server.view"],
    blurb: "The map in play, the rotation order, and what this match is fought over.",
    keywords: ["rotation", "current map", "objectives", "next map", "order"] },
  { id: "maps.votesetup", parent: "maps", path: "/maps/votesetup", title: "Vote setup", hidden: true, caps: ["mapvote.config"],
    blurb: "Which maps can be voted on, where the poll posts, and the timings behind it.",
    keywords: ["map sets", "profiles", "channel", "poll hours", "reminders", "blacklist", "schedule", "history", "undo", "restore", "deleted"] },
  { id: "maps.catalogue", parent: "maps", path: "/maps/catalogue", title: "Catalogue", hidden: true, caps: ["server.view"],
    blurb: "Every map the server knows about, with custom display names and a sample of what a vote would offer.",
    keywords: ["map list", "rename", "display name", "preview", "sample vote"] },
  // ---- Automation: things that act without you ----
  { id: "autosettings", path: "/autosettings", title: "Auto settings", section: "Automation", caps: ["autosettings.profiles", "admin.moderation", "moderation.chatfilter", "moderation.zones", "seeding.config"],
    blurb: "The server managing itself — scheduled settings, player rules, event rules, and seeding, in one place.",
    keywords: ["auto settings", "autosettings", "automod", "schedule", "night", "rules", "no leader", "seeding", "level", "teamkill", "punish", "automatic", "enforcer"] },
  { id: "autosettings.settings", parent: "autosettings", path: "/autosettings/settings", title: "Server settings", hidden: true, caps: ["autosettings.profiles"],
    blurb: "Settings profiles that apply themselves by schedule, player count or match time — plus timed match messages.",
    keywords: ["autosettings", "schedule", "night", "profiles", "automatic", "match time", "timed messages"] },
  // The rule engine is guarded on admin.moderation ALONE — autosettings.config buys you the
  // settings profiles and the player-rule modules next door, not this.
  { id: "autosettings.rules", parent: "autosettings", path: "/autosettings/rules", title: "Rules", hidden: true, caps: ["admin.moderation"],
    blurb: "The one rule engine: event triggers (team kills, chat, joins, crashes, no kills) and live-roster triggers (solo tank or helicopter, no squad leader, level, role, name, restricted weapons), each with immunity and an escalation ladder.",
    keywords: ["trigger", "punish", "warn", "escalation", "delay", "pause", "resume", "section switch", "history", "undo", "restore", "recently deleted", "crash vip", "no vip", "free vip", "vip rule", "afk", "no kills", "idle", "welcome", "connect", "disconnect", "automod", "no leader", "squad leader", "min level", "solo tank", "solo helicopter", "pilot", "name filter", "weapon", "role"] },
  { id: "autosettings.chatfilter", parent: "autosettings", path: "/autosettings/chatfilter", title: "Chat filter", hidden: true, caps: ["moderation.chatfilter"],
    blurb: "One word list for in-game chat: act on players through two managed rules, and optionally feed the game's own censor.",
    keywords: ["chat filter", "profanity", "banned words", "censor", "word filter", "swear", "slur", "language"] },
  { id: "autosettings.history", parent: "autosettings", path: "/autosettings/history", title: "History", hidden: true, caps: ["admin.moderation", "autosettings.profiles", "seeding.config"],
    blurb: "Every action the automation took — rule firings and breaker trips, seeding enforcement, profile applies, map-vote and broadcast — filterable by family or single rule, searchable, paged.",
    keywords: ["automation history", "firings", "fired", "what did the automod do", "breaker", "dry-run", "log", "audit", "rule history"] },
  { id: "autosettings.seeding", parent: "autosettings", path: "/autosettings/seeding", title: "Seeding", hidden: true, caps: ["seeding.config"],
    blurb: "Low-population rules while a server fills, then VIP time and/or points for the seeders once it goes live.",
    keywords: ["seed", "low pop", "fill", "reward", "seeder", "points", "currency", "vip", "weapon", "artillery", "commander", "bombing run", "strafing run", "precision strike"] },
  { id: "autosettings.gamerewards", parent: "autosettings", path: "/autosettings/gamerewards", title: "Game rewards", hidden: true, caps: ["autosettings.profiles"],
    blurb: "Reward players for how they play — top stats each match, kill streaks, days played in a row and days seeding in a row — with VIP time and/or points, each individually switched.",
    keywords: ["game rewards", "rewards", "top stats", "topstats", "kill streak", "streak", "consecutive days", "daily", "loyalty", "progressive", "vip", "points", "match end", "mvp"] },
  // The zone sets are their own permission; the rules permission reads them (its editor picks a
  // set for each zone rule) and the seeding ground rules here answer to it, with Seeding.
  { id: "autosettings.zones", parent: "autosettings", path: "/autosettings/zones", title: "Map zones", hidden: true, caps: ["moderation.zones", "admin.moderation"],
    blurb: "Named zone sets painted on the tactical map's 10×10 grid, per map, per game — what the \"player outside the allowed area\" rule enforces from live positions — and the seeding ground rules: seeding zones, the cap fight by position and steamroll protection.",
    keywords: ["zones", "zone set", "map zones", "area", "boundary", "out of bounds", "geofence", "sector", "grid", "keep out", "restricted area", "fight club", "event area",
      "ground rules", "seeding zones", "seeding areas", "seeding area", "auto zones", "map layouts", "learn layouts", "prefill", "steamroll", "offensive pace"] },

  // ---- Integrations ----
  { id: "discord", path: "/discord", title: "Discord", section: "Integrations", caps: ["discord.relay", "discord.setup", "admin.users", "community.edit"],
    blurb: "Everything Discord — the bot's connection, what it relays, who it alerts, and sign-in with Discord roles.",
    keywords: ["bot", "webhook", "relay", "alerts", "oauth", "sso", "login", "roles", "channel"] },
  { id: "discord.setup", parent: "discord", path: "/discord/setup", title: "Setup & status", hidden: true, caps: ["discord.setup"],
    blurb: "Is the bot connected, which guild it serves, and what it still needs.",
    keywords: ["connect", "token", "guild", "invite", "health"] },
  { id: "discord.relay", parent: "discord", path: "/discord/relay", title: "Relay & alerts", hidden: true, caps: ["discord.relay", "community.edit"],
    blurb: "Which in-game events get posted to which channel, and what pings staff.",
    keywords: ["channel", "webhook", "kills", "chat", "ping", "watchlist"] },
  { id: "discord.signin", parent: "discord", path: "/discord/signin", title: "Sign-in & roles", hidden: true, caps: ["admin.users"],
    blurb: "Let staff sign in with Discord, and map Discord roles onto panel roles.",
    keywords: ["oauth", "sso", "login", "role map", "permissions", "auto provision"] },

  // ---- Admin ----
  /**
   * Analytics: five separate pages, each behind its OWN capability.
   *
   * It sits in the Admin section of the sidebar, but that is placement, not privilege — none of
   * these capabilities implies any admin power. Someone can be given map-vote analytics and
   * nothing else, and the sidebar will show them an Admin section containing only that page.
   * They are deliberately not tabs of one permission: "let this person see population figures but
   * not staff workload" is a real thing a community wants to say.
   */
  { id: "analytics", path: "/analytics", title: "Analytics", section: "Admin",
    caps: ["analytics.server", "analytics.match", "analytics.player", "analytics.combat", "analytics.composition", "analytics.staff", "analytics.mapvote", "analytics.announcements"],
    blurb: "How your community, your matches and your team are actually doing — measured, not guessed.",
    keywords: ["stats", "graphs", "charts", "trends", "reports", "numbers", "insights", "population"] },
  { id: "analytics.server", parent: "analytics", path: "/analytics/server", title: "Server", hidden: true, caps: ["analytics.server"],
    blurb: "Population through the day and week, peak times, how many players come back, and whether matches are close.",
    keywords: ["population", "peak", "busy", "retention", "returning", "activity", "uptime", "balance"] },
  { id: "analytics.match", parent: "analytics", path: "/analytics/match", title: "Matches", hidden: true, caps: ["analytics.match"],
    blurb: "How rounds actually play out — per-map win rates, how one-sided each map is, and how long rounds run.",
    keywords: ["rounds", "maps", "win rate", "balance", "duration", "stomps", "close games"] },
  { id: "analytics.player", parent: "analytics", path: "/analytics/player", title: "Players", hidden: true, caps: ["analytics.player"],
    blurb: "The population as a whole — how players rank against each other, and how much they actually play.",
    keywords: ["ranking", "percentile", "playtime", "sessions", "regulars", "distribution"] },
  { id: "analytics.combat", parent: "analytics", path: "/analytics/combat", title: "Combat", hidden: true, caps: ["analytics.combat"],
    blurb: "What people are actually killing each other with — weapon and class usage, and how much of it lands on teammates.",
    keywords: ["weapons", "guns", "kills", "teamkills", "friendly fire", "tk", "meta", "armour", "artillery"] },
  { id: "analytics.composition", parent: "analytics", path: "/analytics/composition", title: "Composition", hidden: true, caps: ["analytics.composition"],
    blurb: "What the server looked like — side balance, the role mix, and how often squads ran without a leader.",
    keywords: ["roles", "squads", "leaderless", "no sl", "balance", "stacking", "sides", "makeup", "officers", "composition"] },
  { id: "analytics.announcements", parent: "analytics", path: "/analytics/announcements", title: "Announcements", hidden: true, caps: ["analytics.announcements"],
    blurb: "Whether the staff noticeboard is actually being read — read rates, time-to-see, and who acknowledged what.",
    keywords: ["notices", "read rate", "acknowledged", "seen", "noticeboard", "communication"] },
  { id: "analytics.staff", parent: "analytics", path: "/analytics/staff", title: "Staff", hidden: true, caps: ["analytics.staff"],
    blurb: "How moderation work is shared out, and which hours of the week are thin on cover.",
    keywords: ["workload", "coverage", "moderation", "team", "shifts", "who does what"] },
  { id: "analytics.mapvote", parent: "analytics", path: "/analytics/mapvote", title: "Map votes", hidden: true, caps: ["analytics.mapvote"],
    blurb: "Which maps win the vote, how turnout moves, and how often a result gets overridden.",
    keywords: ["votes", "turnout", "winners", "overrides", "popular maps"] },

  { id: "admin", path: "/admin", title: "Administration", section: "Admin", caps: ["admin.users", "admin.online", "templates.manage", "vip.presets", "admin.trim", "admin.data", "audit.trail", "server.config", "server.manage", "server.add", "server.engagement", "server.admins", "admin.console", "crcon.pull", "broadcast.config"],
    blurb: "Every settings screen in one place — staff accounts, server connections and live settings, console admins, shared presets, retention, and host health.",
    keywords: ["users", "roles", "permissions", "staff", "team", "system", "health", "settings", "config"] },
  { id: "admin.users", parent: "admin", path: "/admin/users", title: "Users & roles", hidden: true, caps: ["admin.users"],
    blurb: "Staff accounts and what each role is allowed to do.",
    keywords: ["accounts", "permissions", "capability", "grant", "invite", "password", "merge"] },
  { id: "admin.activity", parent: "admin", path: "/admin/activity", title: "Staff activity", hidden: true, caps: ["audit.trail"],
    blurb: "What your admins have been doing — actions per person, over time.",
    keywords: ["audit", "who did", "moderator stats", "accountability"] },
  // Four separate permissions meet on this one tab: the connection itself (server.manage), its live
  // settings link (server.config), the observe/active + per-automation switches (server.engagement)
  // and the CRCON archive pull that lives at the bottom of it (crcon.import). Each holder gets the
  // tab and only the controls their grant covers.
  { id: "admin.connections", parent: "admin", path: "/admin/connections", title: "Connections", hidden: true, caps: ["server.manage", "server.add", "server.config", "server.engagement", "crcon.pull"],
    blurb: "The servers this panel talks to — address, credentials, the observe/active switch, and the CRCON archive pull.",
    keywords: ["add server", "rcon", "host", "port", "credentials", "observe mode", "crcon", "backup", "import", "archive", "command check", "game update", "new commands", "nickname", "rename server", "alias"] },
  { id: "admin.live", parent: "admin", path: "/admin/live", title: "Live settings", hidden: true, caps: ["server.config"],
    blurb: "Settings applied to the running server right now — welcome message, slots, idle kick, vote kick.",
    keywords: ["welcome message", "motd", "queue", "idle", "high ping", "auto balance", "vip slots", "server settings"] },
  /**
   * The scrolling line across the top left, and the rotation behind it. It sits in Administration
   * rather than out in the nav because it is a set-and-forget instance setting — the rotation is
   * written once and then runs for months — not a thing normal staff reach for. What staff DO
   * reach for is Moderation → Messages, which is a different surface on screen entirely.
   */
  { id: "admin.broadcast", parent: "admin", path: "/admin/broadcast", title: "Broadcast", hidden: true, caps: ["broadcast.config"],
    blurb: "The scrolling message across the top left of every player's screen — one now, or a rotating list on a timer.",
    keywords: ["broadcast", "scroll", "scrolling", "rotation", "rules reminder", "discord promo", "motd", "announce"] },
  { id: "admin.admins", parent: "admin", path: "/admin/admins", title: "Console admins", hidden: true, caps: ["server.admins"],
    blurb: "In-game admin rights on the game server itself, with optional expiry.",
    keywords: ["game admin", "console", "moderator", "owner", "senior"] },
  // Named "RCON console" rather than "Console" because it sits next to "Console admins" — two very
  // different things that would otherwise read as a pair.
  // Write, not read: this screen is a send box and nothing else. There is no read side to the raw
  // console, and the API guards it on write — offered at read it is a tab whose only button 403s.
  { id: "admin.console", parent: "admin", path: "/admin/console", title: "RCON console", hidden: true, caps: ["admin.console"], capLevel: "write",
    blurb: "Send a raw command straight to the game server — the escape hatch when the panel has no button for it.",
    keywords: ["rcon", "command", "raw", "terminal", "advanced", "console"] },
  // Write, for the same reason as the console: the template library is readable by anyone who can
  // act (the action dialogs preview it), so the only thing this SCREEN adds is editing.
  { id: "admin.templates", parent: "admin", path: "/admin/templates", title: "Templates", hidden: true, caps: ["templates.manage"], capLevel: "write",
    blurb: "Reusable wording for reasons, messages and broadcasts, so the team says the same thing.",
    keywords: ["presets", "canned", "reason", "message", "snippets"] },
  { id: "admin.vippresets", parent: "admin", path: "/admin/vippresets", title: "VIP presets", hidden: true, caps: ["vip.presets"],
    blurb: "The duration buttons on the Edit VIP popup — each tap adds its time onto the total.",
    keywords: ["vip", "presets", "durations", "skip queue", "pause", "calculator", "buttons"] },
  { id: "admin.trim", parent: "admin", path: "/admin/trim", title: "Data trim", hidden: true, caps: ["admin.trim"],
    blurb: "Delete old event history you no longer need, with a backup first.",
    keywords: ["retention", "prune", "cleanup", "disk", "delete old"] },
  { id: "admin.backup", parent: "admin", path: "/admin/backup", title: "Backup", hidden: true, caps: ["admin.data"],
    blurb: "Export selected data types to one archive, and import archives — the clean-slate migration path.",
    keywords: ["export", "import", "backup", "migrate", "archive", "database", "restore"] },
  { id: "admin.system", parent: "admin", path: "/admin/system", title: "System", hidden: true, caps: ["audit.trail"],
    blurb: "Host health, versions, and the plugins this instance is running.",
    keywords: ["health", "version", "cpu", "memory", "disk", "plugins", "status"] },
  { id: "admin.online", parent: "admin", path: "/admin/online", title: "Online access", hidden: true, caps: ["admin.online"],
    blurb: "How people reach this install from the internet, and the public stats site's own address and name.",
    keywords: ["domain", "hostname", "address", "url", "stats site", "public stats", "community name", "online", "internet", "tunnel", "cloudflare", "https", "certificate", "remote access"] },

  // ---- Account-level (reached from the account menu, not the nav) ----
  { id: "settings", path: "/settings", title: "Settings", hidden: true, measure: "reading",
    blurb: "Your own preferences — theme, accent colour, layout density, and where the app opens.",
    keywords: ["appearance", "theme", "dark", "light", "accent", "density", "preferences", "tokens", "api key"] },
];

/**
 * What the HELP page may list: every screen except the owner-only ones (and no plugin's page —
 * those are never in ROUTES). Help is the page people open over a shoulder and screen-share to
 * train new staff, so those screens are not merely filtered there — they are absent for EVERYONE,
 * holders included. Each explains itself to the people who can open it; help never speaks of them.
 */
const OWNER_ONLY = new Set(ROUTES.filter((r) => r.ownerOnly).map((r) => r.id));
for (const r of ROUTES) if (r.outright) for (const c of r.caps ?? []) OUTRIGHT_CAPS.add(c);
export const HELP_ROUTES: RouteDef[] = ROUTES.filter((r) => !OWNER_ONLY.has(r.id) && !(r.parent && OWNER_ONLY.has(r.parent)));

const BY_ID = new Map(ROUTES.map((r) => [r.id, r]));
const BY_PATH = new Map(ROUTES.map((r) => [r.path, r]));

/** A page a plugin adds, as the API lists it (/api/plugin-pages) — only the ones this viewer may
 *  open, each with what opens it. */
export interface PluginPageInfo {
  plugin: string;
  id: string;
  title: string;
  section: string;
  blurb: string;
  permission: string | null;
  outright: boolean;
  ownerOnly: boolean;
}

export interface PluginRouteDef extends RouteDef {
  plugin: string;
}

const PLUGIN_ROUTES = new Map<string, PluginRouteDef>();
/** The outright permissions plugin pages put into OUTRIGHT_CAPS, so a fresh list can take them out. */
const PLUGIN_OUTRIGHT = new Set<string>();

/**
 * Installs the plugin pages the API listed as routes, replacing the last list. From then on the
 * sidebar, the palette, the tab title and role previews treat each like any other destination: its
 * permission is its `caps`, asked outright when the permission is. A page whose address a built-in
 * screen owns, or once owned, is left out — a plugin can never stand in for one of the panel's own.
 */
export function setPluginPages(pages: readonly PluginPageInfo[]): void {
  PLUGIN_ROUTES.clear();
  for (const c of PLUGIN_OUTRIGHT) OUTRIGHT_CAPS.delete(c);
  PLUGIN_OUTRIGHT.clear();
  for (const p of pages) {
    const path = `/${p.id}`;
    if (BY_ID.has(p.id) || BY_PATH.has(path) || path in LEGACY || PLUGIN_ROUTES.has(p.id)) continue;
    PLUGIN_ROUTES.set(p.id, {
      id: p.id, path, title: p.title, blurb: p.blurb, keywords: [], plugin: p.plugin,
      // A section the sidebar does not have is no section: the page is listed under "More".
      section: SECTIONS.includes(p.section) ? p.section : undefined,
      caps: p.permission ? [p.permission] : undefined,
      outright: p.outright || undefined,
      ownerOnly: p.ownerOnly || undefined,
    });
    if (p.permission && p.outright && !OUTRIGHT_CAPS.has(p.permission)) {
      OUTRIGHT_CAPS.add(p.permission);
      PLUGIN_OUTRIGHT.add(p.permission);
    }
  }
}

/** The plugin pages, in the order the API listed them. */
export const pluginRoutes = (): PluginRouteDef[] => [...PLUGIN_ROUTES.values()];
export const pluginRouteById = (id: string): PluginRouteDef | undefined => PLUGIN_ROUTES.get(id);

export const routeById = (id: string): RouteDef | undefined => BY_ID.get(id) ?? PLUGIN_ROUTES.get(id);
/** The tabs of a destination, in declaration order. */
export const tabsOf = (viewId: string): RouteDef[] => ROUTES.filter((r) => r.parent === viewId);

/**
 * Breadcrumb trail for a location: ["Players", "VIPs"] — derived, never typed by hand, so a page
 * can't claim to be somewhere it isn't.
 */
export function trailFor(viewId: string, tabId?: string): RouteDef[] {
  const view = BY_ID.get(viewId);
  if (!view) return [];
  const tab = tabId ? BY_ID.get(`${viewId}.${tabId}`) : undefined;
  return tab ? [view, tab] : [view];
}

/**
 * Screens that used to be their own destination and are now a tab of a hub. Old bookmarks, stored
 * dashboard layouts and links pasted in Discord months ago still resolve — they just land on the
 * tab that absorbed them, with the tab bar correctly showing where they ended up.
 */
const LEGACY: Record<string, string> = {
  "/leaderboard": "/players/leaderboard", "/vips": "/players/vips", "/groups": "/players/groups",
  // Moderation grew tabs, so its ban record has a path of its own again — these land ON it rather
  // than on the hub's first tab, which is the same place but says so.
  "/bans": "/moderation/bans", "/blacklist": "/moderation/bans", "/moderation/blacklist": "/moderation/bans",
  "/admincam": "/history/admincam", "/logs": "/history/logs", "/matches": "/history/matches", "/mapvotes": "/history/mapvotes",
  // Payouts moved from the Players hub into the Events hub ("/events" itself was once the retired
  // plain event list, long since superseded by Logs — the word now means community events).
  "/players/payouts": "/events/payouts",
  "/users": "/admin/users", "/activity": "/admin/activity", "/templates": "/admin/templates",
  "/trim": "/admin/trim", "/system": "/admin/system",
  "/servers": "/admin/connections", "/admins": "/admin/admins",
  // The Config hub itself was folded into Administration, and the raw console with it.
  // Broadcast left the Automation section for a tab under Administration — it is an instance
  // setting written once, not something normal staff open.
  "/broadcast": "/admin/broadcast",
  "/config": "/admin/live", "/config/connections": "/admin/connections",
  "/config/live": "/admin/live", "/config/admins": "/admin/admins",
  "/console": "/admin/console",
  // Auto-mod and the Config hub's Scheduled (auto) tab merged into one Auto settings destination.
  "/automod": "/autosettings", "/automod/rules": "/autosettings/rules", "/automod/seeding": "/autosettings/seeding",
  "/config/auto": "/autosettings/settings", "/enforcer": "/autosettings", "/announcements": "/announcements",
  // The map vote was reachable from the Discord hub, where it was only ever a signpost pointing
  // back here. Discord is where the poll is posted, not what the feature is about.
  "/discord/mapvote": "/maps/vote",
  // How do I's written guides are gone: an old link to one lands on Start here's walkthroughs.
  "/help/guides": "/help/start",
};

/**
 * Some destinations are about ONE thing: a player's profile, a staff member's activity, a single
 * round. That thing is the subject, and it belongs in the URL for the same reasons the destination
 * does — so a profile can be bookmarked, pasted into Discord, and survive a refresh or the back
 * button.
 *
 * It rides as a final `/~<id>` segment. The `~` marks it as a subject rather than a tab, so it can
 * never be mistaken for one (tab ids are plain words) and a subject can follow a tab without
 * ambiguity: `#/history/matches/~<matchId>`.
 *
 * This is also the fix for a real bug. The subject used to be held in React state beside the
 * router: `go()` set it and THEN set the hash — but changing the hash fires `hashchange`, whose
 * handler cleared the subject. Every click on a player name outside the directory therefore
 * navigated to the players screen with nothing selected. Anything the URL doesn't carry, the
 * router is free to lose.
 */
const SUBJECT_MARK = "~";

/** Split a trailing `/~subject` off a path. */
function splitSubject(path: string): { path: string; subject?: string } {
  const at = path.lastIndexOf(`/${SUBJECT_MARK}`);
  if (at === -1) return { path };
  const raw = path.slice(at + 2);
  if (!raw) return { path: path.slice(0, at) || "/" };
  return { path: path.slice(0, at) || "/", subject: decodeURIComponent(raw) };
}

/** Resolve a URL path back to a location. Unknown paths fall back to the dashboard. */
export function locationFromPath(path: string): { view: string; tab?: string; subject?: string } {
  const withSubject = "/" + path.replace(/^#?\/?/, "").replace(/\/+$/, "");
  // The subject comes off first: legacy rewrites and the path table are keyed on the route alone.
  const { path: raw, subject } = splitSubject(withSubject);
  const clean = LEGACY[raw] ?? raw;
  const exact = BY_PATH.get(clean);
  if (exact) {
    const loc = exact.parent ? { view: exact.parent, tab: exact.id.split(".").slice(1).join(".") } : { view: exact.id };
    return subject ? { ...loc, subject } : loc;
  }
  // Unknown deep path: keep the destination if we recognise its first segment (e.g. a plugin view,
  // or a tab id we don't list such as a dynamic auto-mod module).
  const [first, ...rest] = clean.slice(1).split("/");
  if (!first) return { view: "dashboard" };
  const view = ROUTES.find((r) => !r.parent && r.path === `/${first}`);
  const viewId = view?.id ?? first;
  const loc = rest.length ? { view: viewId, tab: rest.join("/") } : { view: viewId };
  return subject ? { ...loc, subject } : loc;
}

/** Build the URL path for a location (inverse of locationFromPath). */
export function pathFor(viewId: string, tabId?: string, subject?: string): string {
  const tab = tabId ? BY_ID.get(`${viewId}.${tabId}`) : undefined;
  const view = BY_ID.get(viewId);
  const base = tab ? tab.path
    : !view ? `/${viewId}${tabId ? `/${tabId}` : ""}`
    : tabId ? `${view.path}/${tabId}` : view.path;
  return subject ? `${base}/${SUBJECT_MARK}${encodeURIComponent(subject)}` : base;
}

/**
 * What a destination's subject IS. The URL carries one opaque id; this says which kind of thing it
 * names, so the screen can be handed the right prop and a stored "recent item" can be turned back
 * into a link. A destination missing from this table simply takes no subject.
 */
export const SUBJECT_FIELD: Record<string, "playerId" | "userId" | "matchId" | "guideId"> = {
  players: "playerId",
  staff: "userId",
  match: "matchId",
  // A walkthrough is a subject too: #/help/start/~watch-player opens it — which is what makes
  // "follow this one" a link somebody can paste in Discord. A link to one of the old How do I
  // guides lands there too, and Start here says it names nothing that is still here.
  help: "guideId",
};
