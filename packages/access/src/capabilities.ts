/**
 * The catalog of capabilities the system checks, with human descriptions. This is the source
 * of truth the role-management UI reads to offer grants — keep it in sync with the `can(...)`
 * checks across the API. `scoped` marks capabilities that can be granted per-server (not just
 * globally); `write`-implies-`read` is handled by the RBAC level ordering.
 *
 * Capabilities are FINE-GRAINED on purpose: every distinct admin action is its own permission
 * (message ≠ kick ≠ temp ban ≠ perma ban…), so a role can hand out exactly what it means to.
 */
export interface CapabilityDef {
  key: string;
  label: string;
  description: string;
  /** true if a `server`-scoped grant is meaningful (per-server access). */
  scoped: boolean;
  /** UI grouping (permission matrix sections). */
  group: string;
  /**
   * Which of the four states are REAL for this capability.
   *
   * The permission matrix offers four per row — inherit, Block, Read, Write — and for most
   * capabilities all four mean something. For some they do not, and offering a state that grants
   * nothing is worse than not offering it: an admin sets "Read" on Kick, the row goes green, and
   * the person still cannot kick anybody. Nothing lies exactly; the matrix simply asked a question
   * the API has no answer to.
   *
   * So each capability declares the levels its endpoints actually enforce:
   *   • `["read","write"]` (the default) — a read surface and a write surface both exist.
   *   • `["write"]`        — every endpoint demands write. There is no read form of "kick a
   *                          player" or "send a raw console command".
   *   • `["read"]`         — every endpoint is a read. Granting write adds nothing, and offering
   *                          it invites somebody to think it does.
   *
   * Inherit and Block always apply: "no grant of my own" and "explicitly denied" are meaningful
   * for anything that can be granted at all.
   *
   * This is checked rather than trusted — see apps/api/test/capability-levels.test.ts, which
   * derives the same answer from the route source and fails if the two disagree. A capability
   * whose enforcement changes and whose entry here does not is precisely the drift that puts a
   * dead state back on the screen.
   */
  levels?: readonly ("read" | "write")[];
}

/** Every state this capability's rows may be set to. */
export function capabilityLevels(def: CapabilityDef): readonly ("read" | "write")[] {
  return def.levels ?? ["read", "write"];
}

/** The lowest level that actually confers this capability — what "do you have it at all" means. */
export function minLevelFor(key: string): "read" | "write" {
  const def = CAPABILITY_CATALOG.find((c) => c.key === key);
  return def && !capabilityLevels(def).includes("read") ? "write" : "read";
}

export const CAPABILITY_CATALOG: readonly CapabilityDef[] = [
  { group: "Servers", key: "server.view", label: "View servers", description: "See servers, live state, players, events, leaderboard.", scoped: true, levels: ["read"] },
  /*
   * Adding a server and looking after one are different jobs, so they are different permissions.
   * Everything `server.manage` does names an EXISTING server in its route, so it scopes: "you look
   * after the Offensive server's connection". Creating a new one cannot scope to a server that does
   * not exist yet, and handing it out with a single-server grant was the old bundle's mistake.
   */
  { group: "Servers", key: "server.manage", label: "Manage a server's connection", description: "Rename a server from the live read and run a one-shot ingest. Adding a NEW server is a separate permission.", scoped: true, levels: ["write"] },
  { group: "Servers", key: "server.add", label: "Add a server", description: "Register a new server with the panel, including its RCON credentials. Community-level: there is no server to scope it to.", scoped: false, levels: ["write"] },
  { group: "Servers", key: "server.engagement", label: "Change engagement mode", description: "Switch a server between observe (read-only) and active.", scoped: true, levels: ["write"] },
  { group: "Servers", key: "server.config", label: "Server config", description: "Read and change server game settings (auto-balance, ping/idle kick, vote-kick, welcome, VIP slots…). Still one permission: these are fields in a single request, so splitting them needs per-field authorisation rather than a new key.", scoped: true },
  { group: "Servers", key: "server.admins", label: "Console admins", description: "View (read) and manage (write) the GAME SERVER's own admin list — who can use in-game admin powers like admin camera. Separate from panel logins.", scoped: true },

  // Pulling an archive off CRCON and writing its contents into this panel's own records are
  // separate acts with very different blast radius: the first is a download, the second rewrites
  // players, bans and match history here.
  { group: "Servers", key: "crcon.pull", label: "CRCON pull & backup", description: "Run CRCON archive pulls and backups — fetch, pause, retry, check integrity, discard the archive. Reads from CRCON; changes nothing in this panel.", scoped: true },
  { group: "Servers", key: "crcon.apply", label: "Apply CRCON archive", description: "Transform a pulled archive INTO this panel — players, bans, match and log history. Read watches a running transform; write starts one. This is what rewrites local records, so grant it separately from the pull.", scoped: true },

  { group: "Maps & votes", key: "maps.next", label: "Set next map", description: "Choose the map that plays next.", scoped: true, levels: ["write"] },
  { group: "Maps & votes", key: "maps.rotation", label: "Edit map rotation", description: "Add, remove and reorder maps in the server's rotation, or replace it with a saved set. Read shows which saved sets could apply.", scoped: true, levels: ["read", "write"] },
  { group: "Maps & votes", key: "maps.names", label: "Map display names", description: "Rename how maps are labelled in the panel and in votes. Cosmetic — changes no game state.", scoped: true, levels: ["write"] },
  { group: "Maps & votes", key: "mapvote.config", label: "Map vote setup", description: "Configure the automated map vote — profiles, map sets, schedules, reminders.", scoped: true },
  { group: "Maps & votes", key: "mapvote.control", label: "Map vote live control", description: "Act on a vote that is running or just decided: pause it, force a winner, re-roll or skip. Overriding a live result in front of players is a different job from setting the rules.", scoped: true, levels: ["write"] },

  { group: "Automation", key: "broadcast.config", label: "Broadcasts", description: "Configure rotating server broadcasts (sending one now needs Message players).", scoped: true },
  // The old single Auto settings permission covered the schedule, the player rules that kick people,
  // and the saved templates. Only one of those three can throw somebody off the server.
  { group: "Automation", key: "autosettings.profiles", label: "Auto settings profiles", description: "The server managing its own settings: profiles triggered by time of day or player/team counts.", scoped: true },
  { group: "Automation", key: "autosettings.templates", label: "Auto settings templates", description: "Save and apply named auto-settings templates.", scoped: true },
  { group: "Automation", key: "seeding.config", label: "Seeding", description: "Configure seeding: when it starts, what is not allowed while it runs, and the warnings, punishes and kick. The seed reward on the same tab is Seeding rewards.", scoped: true },
  // Carved off seeding.config (migration 156): tuning when seeding starts and what it forbids is
  // not the same trust as deciding how much VIP time or how many points every seeder is handed.
  { group: "Automation", key: "seeding.rewards", label: "Seeding rewards", description: "The seed reward — VIP time, points, the bridge to other servers and the reward messages — and its payout receipts; with write, change it and pay a missed round. Opening the tab still needs Seeding, and paying VIP or points also needs Grant VIP or Member balances.", scoped: true },
  { group: "Automation", key: "discord.relay", label: "Discord relays & alerts", description: "Configure per-server Discord relay channels and alert pings. Still one permission: alerts are a field inside the relay config request, so splitting them needs per-field authorisation.", scoped: true },
  { group: "Automation", key: "templates.manage", label: "Message templates", description: "Create and edit the shared message & reason preset library.", scoped: false, levels: ["write"] },


  { group: "Player actions", key: "action.message", label: "Message players", description: "Send in-game messages to a player.", scoped: true, levels: ["write"] },
  { group: "Player actions", key: "action.kick", label: "Kick", description: "Kick a player from the server.", scoped: true, levels: ["write"] },
  { group: "Player actions", key: "action.punish", label: "Punish", description: "Punish (kill in place) a player.", scoped: true, levels: ["write"] },
  { group: "Player actions", key: "action.tempban", label: "Temp ban", description: "Issue temporary bans (the max-duration limit below applies).", scoped: true, levels: ["write"] },
  { group: "Player actions", key: "action.permaban", label: "Perma ban", description: "Issue permanent bans.", scoped: true, levels: ["write"] },
  { group: "Player actions", key: "action.unban", label: "Remove bans", description: "Lift temporary and permanent bans.", scoped: true, levels: ["write"] },
  { group: "Player actions", key: "action.switch", label: "Switch teams now", description: "Move a player to the other team immediately.", scoped: true, levels: ["write"] },
  { group: "Player actions", key: "action.switch_death", label: "Switch teams on death", description: "Queue a team switch for the player's next death.", scoped: true, levels: ["write"] },

  // Write is a real level here, not decoration: it is what "Sync from servers" (adopting the game's
  // own ban lists into the record) and the composer's by-id ban are checked against. Read is still
  // the common grant — seeing the record does not let you add to it.
  { group: "Bans & VIP", key: "moderation.bans", label: "Ban record", description: "See the community's ban record and the game server's live ban list.", scoped: true, levels: ["read"] },
  // Adopting the game's own ban list into the record is a bulk write that can create hundreds of
  // ban entries attributed to nobody. Reading the record should not carry it.
  { group: "Bans & VIP", key: "moderation.bans.sync", label: "Adopt game bans", description: "Pull the game server's existing bans into the community record (reconcile / seed). A bulk write — separate from reading the record.", scoped: true, levels: ["write"] },
  { group: "Bans & VIP", key: "vip.grant", label: "Grant VIP", description: "Grant or extend VIP (read = view the VIP list).", scoped: true },
  { group: "Bans & VIP", key: "vip.revoke", label: "Revoke VIP", description: "Remove a player's VIP.", scoped: true },
  { group: "Bans & VIP", key: "vip.pause", label: "Pause VIP", description: "Pause a player's VIP as a punishment (a VIP timeout) and resume it early. The grant survives and keeps expiring — the paused time is simply lost.", scoped: true },
  { group: "Bans & VIP", key: "vip.presets", label: "VIP presets", description: "Edit the duration preset buttons on the Edit VIP popup (community-wide).", scoped: false },
  // Community-wide like the balances it manages: a member's points are not a per-server fact.
  // Split three ways because "change the shop prices" and "put 5000 points in my own account" were
  // the same permission, and only one of them is auditable as a mistake.
  { group: "Bans & VIP", key: "economy.config", label: "Economy settings", description: "How the points economy earns and expires — rates, caps and the rules behind it.", scoped: false },
  { group: "Bans & VIP", key: "economy.shop", label: "VIP shop offers", description: "The catalogue players spend points on: offers, prices and what each one grants.", scoped: false },
  { group: "Bans & VIP", key: "economy.balances", label: "Member balances", description: "View member balances and ledgers; with write, adjust a balance by hand. Hand-adjusting is minting currency — grant it sparingly.", scoped: false },
  // Deliberately NOT in the economy.manage bundle: a bulk payout mints currency or VIP at scale
  // in one click, which is a bigger act than any single balance adjustment. The old bot gated its
  // module to three named roles for the same reason. Grant it by hand, to people you would trust with
  // the whole float.
  { group: "Bans & VIP", key: "economy.payout", label: "Bulk payouts", description: "Pay currency or VIP days to many members at once — everyone linked, everyone online, everyone at an event. With read, see the payout history and receipts.", scoped: false },
  /**
   * Scheduling an event is not spending anything, and it should not need the grant that is.
   *
   * Events arrived gated on `economy.payout`, which is the "trust them with the whole float"
   * permission — so letting somebody run Friday night meant also letting them mint currency for
   * the entire community. They are separate acts: this one opens and closes a window and reads
   * who turned up; paying the people in it still needs `economy.payout` write, as it always did.
   *
   * Pinning an event's map-vote profile needs `mapvote.config` write ON THAT SERVER as well —
   * see the create route. Deciding which maps get voted on is a map-vote power whichever screen
   * it is spelled from.
   */
  { group: "Bans & VIP", key: "events.manage", label: "Community events", description: "Schedule event windows — when they open and close, and who counts as attending — and read the attendance report afterwards. Paying the people who attended is a separate permission (Bulk payouts).", scoped: false },

  { group: "Players", key: "player.notes", label: "Player notes", description: "Read (and, with write, add) admin notes on players.", scoped: false },
  // Was one "player flags" permission covering four unrelated things. Tagging somebody a streamer
  // and rewriting which Discord account they ARE should never have been the same grant.
  { group: "Players", key: "player.watchlist", label: "Watchlist", description: "See who is watched and why (read); add watch reasons and edit your own (write). Removing reasons — anyone's, including your own — or editing another staff member's needs Watchlist curation.", scoped: false },
  // Split out of player.watchlist: adding a concern and rewriting the RECORD are different
  // trusts. A trial mod flags what they see (and can sharpen their own wording — every previous
  // version stays on the row); what another staff member wrote is theirs until a curator says
  // otherwise, and lifting a watch is a curator's call too.
  { group: "Players", key: "player.watchlist.curate", label: "Watchlist curation", description: "Edit or remove ANY watch reason — your own included — and lift a watch entirely. Watchlist (write) only adds reasons and edits its own.", scoped: false, levels: ["write"] },
  { group: "Players", key: "player.tags", label: "Player tags", description: "Add and remove custom tags on players — clan, streamer, event roster labels. Reading them comes with seeing the player at all, so only write is grantable.", scoped: false, levels: ["write"] },
  { group: "Players", key: "player.links", label: "Player identity links", description: "See (read) and change (write) which Discord and platform accounts a player record is linked to. Changing them rewrites WHO a player is — it decides whose VIP, points and history attach to them. Grant write sparingly.", scoped: false },
  { group: "Players", key: "player.ips", label: "Player IP history", description: "View the IP addresses a player has been seen on (imported from CRCON profile data — an address is only ever stored when the source record carries the player's own id). Sensitive — grant sparingly.", scoped: false, levels: ["read"] },
  { group: "Players", key: "player.groups", label: "Player groups", description: "View (read) and manage (write) named player groups — clan-vs-clan rosters, streamers, event squads. Applying a bulk action to a group additionally needs that action's own permission (VIP, console admins, temp ban…).", scoped: false },

  // Analytics is its own group on purpose. Each page is a separate, independently grantable read —
  // none of them implies any admin power. A squad leader can be given map-vote analytics and
  // nothing else; a community manager can have population figures without seeing staff numbers.
  // They live under the Administration SECTION in the sidebar, which is placement, not privilege.
  { group: "Analytics", key: "analytics.server", label: "Server analytics", description: "Population over time, peak hours, new vs returning players, retention, and match balance for a server.", scoped: true, levels: ["read"] },
  { group: "Analytics", key: "analytics.match", label: "Match analytics", description: "Per-round analysis — momentum, top performers, and trends across rounds like per-map win rates and how one-sided each map tends to be.", scoped: true, levels: ["read"] },
  // Since player_stats gained a server dimension this reads per server, and the page offers the
  // scope picker for it — so the per-server grant has to be expressible too.
  { group: "Analytics", key: "analytics.player", label: "Player analytics", description: "The population as a whole — how players rank against each other, playtime and session patterns, and who plays with whom. Per server, it covers the people who play there and their figures on that server.", scoped: true, levels: ["read"] },
  { group: "Analytics", key: "analytics.staff", label: "Staff analytics", description: "Team-wide staff workload: how moderation effort is split, and which hours are thin on cover. Separate from the audit trail permission below, which shows the individual actions. Per server, it covers the effort spent on that server.", scoped: true, levels: ["read"] },
  { group: "Analytics", key: "analytics.mapvote", label: "Map vote analytics", description: "Which maps win, how turnout moves, and how often a result is overridden.", scoped: true, levels: ["read"] },
  { group: "Analytics", key: "analytics.combat", label: "Combat analytics", description: "Server-wide weapon and class usage, friendly-fire rates, and who is doing the killing — including a team-kill ranking. Reads the kill log; it does not grant any moderation action.", scoped: true, levels: ["read"] },
  { group: "Analytics", key: "analytics.composition", label: "Composition analytics", description: "What the server looked like over time — side balance, the role mix, and how often squads went without a leader. Built from periodic roster samples, so it only covers the period since sampling started.", scoped: true, levels: ["read"] },
  { group: "Analytics", key: "analytics.announcements", label: "Announcement analytics", description: "Whether the staff noticeboard is actually being read — read rates, time-to-see and acknowledgements per notice. Grants the reporting only; posting notices is the Staff announcements permission.", scoped: false, levels: ["read"] },

  // Every trail entry carries the server the action was taken on, so "the history of THIS server"
  // is a real, answerable question — and the one a single-server moderator should be able to ask
  // without being handed the whole community's. Community-level actions (templates, accounts)
  // belong to no server and stay visible only to a global holder.
  { group: "Administration", key: "audit.trail", label: "Audit trail", description: "The log of what was done through this panel, and by whom. Per server, it shows only what happened on that server.", scoped: true, levels: ["read"] },
  /*
   * Everyone can see the requests they filed and the ones waiting for their signature — that
   * falls out of being the requester or a possible approver. Nobody could see the FINISHED work
   * of the team as a whole, which is the view you want when asking "was that ban ever actually
   * approved?", "who keeps denying these?", or "what did we decide about this player last month?".
   * Read-only by construction: it is a record of decisions already made, and re-deciding them is
   * not a thing this surface can do.
   */
  { group: "Administration", key: "moderation.requests.history", label: "All request history", description: "Review every staff member's finished approval requests — who asked, who signed or denied, and why. Read-only; your own requests and the ones waiting on you need no permission.", scoped: true, levels: ["read"] },
  // Reading the log of actions and reading a dossier on a named colleague are different things to
  // be trusted with, even though both are built from the same rows.
  { group: "Administration", key: "staff.profiles", label: "Staff profiles", description: "Per-staff activity pages — one colleague's moderation history and figures, gathered in one place.", scoped: true, levels: ["read"] },
  { group: "Administration", key: "community.edit", label: "Staff announcements", description: "Post and manage notices on the staff announcement board.", scoped: false },
  { group: "Administration", key: "layout.edit", label: "Instance layouts", description: "Save dashboard/nav layouts for the whole instance.", scoped: false, levels: ["write"] },
  { group: "Administration", key: "admin.moderation", label: "Enforcer rules", description: "Create and manage the automatic enforcer rules, and the seeding ground rules on Map zones (those also need Seeding). The chat filter and the zone sets are permissions of their own.", scoped: false },
  // Both carved off admin.moderation (migration 156). A chat moderator keeping the banned-words
  // list, or a mapper drawing zones, should not need the power to write auto-kick and auto-ban rules.
  { group: "Administration", key: "moderation.chatfilter", label: "Chat filter", description: "The banned-words list and what happens to a player who uses one. Switching it on or changing what it does also needs that action's own permission (Message, Punish, Kick, Temp ban or Perma ban).", scoped: false },
  { group: "Administration", key: "moderation.zones", label: "Map zones", description: "Draw and edit the zone sets on Map zones. Rules that use a zone are Enforcer rules; the seeding ground rules on the same page are Enforcer rules with Seeding.", scoped: false },
  { group: "Administration", key: "admin.trim", label: "Data trim", description: "Delete old raw events (career stats are kept).", scoped: false },
  { group: "Administration", key: "admin.data", label: "Database export & import", description: "Export selected data to an archive and import archives — archives include server RCON credentials.", scoped: false },
  { group: "Administration", key: "admin.users", label: "User & role admin", description: "Create users, define roles, assign permissions, and tie Discord roles to panel roles. The Discord bot's setup and Online access are permissions of their own.", scoped: false },
  // Both carved off admin.users (migration 156). The bot's setup decides which Discord app and
  // which staff server people sign in through, so it is described as the high trust it is.
  { group: "Administration", key: "discord.setup", label: "Discord bot setup", description: "The Discord app's settings — bot token, sign-in settings, staff server and slash command — and the public Discord server, approvals relay and community badges. It decides which Discord staff sign in through, so grant it as carefully as User & role admin.", scoped: false },
  { group: "Administration", key: "admin.online", label: "Online access", description: "Put the panel on the internet — your own domain or a Cloudflare tunnel — and set the public stats site's address and name.", scoped: false },
  // A token is a second key to its maker's account, with every power they hold, and it never signs
  // out on its own. So using one answers to this as well as making one: take it away and the
  // person's tokens stop working (they are kept, and work again if it is given back).
  { group: "Administration", key: "api.tokens", label: "API tokens", description: "Make your own API tokens for scripts and bots. A token acts with all of its maker's permissions, and works only while they hold this one.", scoped: false, levels: ["write"] },
  { group: "Administration", key: "admin.console", label: "Raw RCON console", description: "Send un-abstracted commands straight to a server (respects engagement mode; refused on observe).", scoped: true, levels: ["write"] },
] as const;

/**
 * Capabilities that USED to be one key and are now several.
 *
 * Eleven permissions each bundled jobs that wanted separating — tagging a player sat with rewriting
 * their identity, reading the ban record sat with adopting hundreds of bans, setting the vote's
 * rules sat with overriding a live result in front of players. The bundle meant the most dangerous
 * member set the floor for the whole group, so the safe half could not be delegated.
 *
 * This map is the upgrade path, and it is the only thing standing between an existing team and a
 * lockout. Migration 039 reads it and, for every stored grant of an old key, writes the same
 * scope and level for each new key — so a role that could tag players can still tag players the
 * morning after, and nobody has to re-grant anything by hand.
 *
 * The old rows are then DELETED, deliberately. Leaving them as an alias that still satisfies the
 * new keys would be the safer-looking choice and the wrong one: unchecking "Player tags" in the
 * editor would not revoke anything, because the invisible old grant would keep conferring it. A
 * permission you cannot take away is not a permission. Expanding and deleting keeps the editor
 * honest — what the matrix shows is what the user has.
 *
 * Where a new key carries the OLD name (mapvote.config, server.config, moderation.bans,
 * server.manage) the meaning narrowed but the key stayed, so its own row needs no rewrite and the
 * migration only adds the siblings that were carved off it.
 */
export const CAPABILITY_SPLITS: Readonly<Record<string, readonly string[]>> = {
  "player.flags": ["player.watchlist", "player.tags", "player.links"],
  // A later epoch than the eleven below (migration 064): watchlist write kept its name and only
  // the curation half — edit/remove other people's reasons, lift a watch — was carved off it.
  "player.watchlist": ["player.watchlist", "player.watchlist.curate"],
  "maps.control": ["maps.next", "maps.rotation", "maps.names"],
  "mapvote.config": ["mapvote.config", "mapvote.control"],
  // autosettings.rules (the standalone player-rule modules) retired when the scenarios became
  // Rules-engine triggers; the split maps the old combined key onto what still exists.
  "autosettings.config": ["autosettings.profiles", "autosettings.templates"],
  "economy.manage": ["economy.config", "economy.shop", "economy.balances"],
  "crcon.import": ["crcon.pull", "crcon.apply"],
  "staff.analytics": ["audit.trail", "staff.profiles"],
  "discord.config": ["discord.relay"],
  "moderation.bans": ["moderation.bans", "moderation.bans.sync"],
  "server.manage": ["server.manage", "server.add"],
  // A later epoch again (migration 156), the 064 way: each key kept its name for the part that
  // stayed, and every stored grant of it — a block included — gained the same on each new sibling.
  "admin.moderation": ["admin.moderation", "moderation.chatfilter", "moderation.zones"],
  "seeding.config": ["seeding.config", "seeding.rewards"],
  "admin.users": ["admin.users", "discord.setup", "admin.online"],
} as const;

/**
 * Action limits: numeric caps attached to a capability, granted per user or per role. A
 * capability says WHETHER you may do something; a limit says HOW MUCH of it. Unset = unlimited.
 * Owners (the "*" grant) are never limited. Enforced server-side at the action endpoint — the
 * UI reading this catalog is presentation only.
 */
export interface LimitDef {
  key: string;
  label: string;
  description: string;
  /** the capability this limit refines (UI shows it under that row; pointless without it). */
  capability: string;
  unit: string;
}

export const LIMIT_CATALOG: readonly LimitDef[] = [
  {
    key: "tempban.maxHours",
    label: "Max temp-ban duration",
    description: "Longest temp ban this user can issue, in hours. Blank = unlimited.",
    capability: "action.tempban",
    unit: "hours",
  },
] as const;

/**
 * Role presets — factory TEMPLATES. On first start they are seeded into the roles table as
 * real, fully editable roles; after that the live roles are the source of truth and these
 * templates only back the "start from" options when creating new roles or one-off grants.
 * `"*"` is the owner wildcard (all capabilities, write).
 */
export interface RolePreset {
  key: string;
  label: string;
  description: string;
  grants: { capability: string; level: "none" | "read" | "write" }[];
  /** action limits applied with the role (see LIMIT_CATALOG). */
  limits?: Record<string, number>;
}

const ALL_ACTIONS = ["action.message", "action.kick", "action.punish", "action.tempban", "action.permaban", "action.unban", "action.switch", "action.switch_death"] as const;
/** Left out of the Administrator preset: who runs the panel, who signs in through which Discord,
 *  and where the panel is reachable from. */
const ADMIN_PRESET_LEAVES_OUT = new Set(["admin.users", "discord.setup", "admin.online"]);

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    key: "viewer",
    label: "Viewer",
    description: "Watch-only: live view, players, events, leaderboards. No actions.",
    grants: [{ capability: "server.view", level: "read" }],
  },
  {
    key: "junior-mod",
    label: "Junior moderator",
    description: "Message, kick, punish, and temp-ban (max 24h). Notes on players. No perma bans or VIP.",
    grants: [
      { capability: "server.view", level: "read" },
      { capability: "action.message", level: "write" },
      { capability: "action.kick", level: "write" },
      { capability: "action.punish", level: "write" },
      { capability: "action.tempban", level: "write" },
      { capability: "action.switch", level: "write" },
      { capability: "action.switch_death", level: "write" },
      { capability: "player.notes", level: "write" },
      // Sees who is being watched and why; cannot add or remove tags, and cannot touch identity
      // links at all — the two that used to ride along with this one grant.
      { capability: "player.watchlist", level: "read" },
    ],
    limits: { "tempban.maxHours": 24 },
  },
  {
    key: "moderator",
    label: "Moderator",
    description: "Every player action (temp bans capped at 7 days), the ban record, VIP, notes, flags and player groups, plus read access to the audit trail and Auto settings rules.",
    limits: { "tempban.maxHours": 168 },
    grants: [
      { capability: "server.view", level: "read" },
      ...ALL_ACTIONS.map((capability) => ({ capability, level: "write" as const })),
      { capability: "moderation.bans", level: "read" },
      { capability: "vip.grant", level: "write" },
      { capability: "vip.revoke", level: "write" },
      { capability: "vip.pause", level: "write" },
      { capability: "player.notes", level: "write" },
      { capability: "player.watchlist", level: "write" },
      // The senior half of the watchlist: moderators are the tier trusted to prune and correct
      // the record, not just add to it.
      { capability: "player.watchlist.curate", level: "write" },
      { capability: "player.tags", level: "write" },
      // player.links stays OUT. Rewriting which accounts a player record IS decides whose VIP,
      // points and ban history attach to them; it rode in on the old bundled flags permission
      // rather than because a moderator was ever meant to have it.
      // Groups are the bulk form of the actions above and confer no new power: applying one still
      // needs each action's own permission, all of which this role already holds. It was simply
      // added to the catalogue after this preset was written. `player.ips` is the opposite case and
      // stays out on purpose — it is the one player capability that is sensitive in itself.
      { capability: "player.groups", level: "write" },
      // The trail of what was done, but not the per-colleague dossier pages.
      { capability: "audit.trail", level: "read" },
      // The game-facing analytics are read-only and useful to anyone moderating; staff analytics
      // is deliberately NOT here — grant it explicitly to whoever should see team workload.
      { capability: "analytics.server", level: "read" },
      { capability: "analytics.match", level: "read" },
      { capability: "analytics.player", level: "read" },
      { capability: "analytics.mapvote", level: "read" },
      { capability: "analytics.combat", level: "read" },
      { capability: "analytics.composition", level: "read" },
      { capability: "admin.moderation", level: "read" },
      // What the moderator's read of the rules and of seeding covered before both were split.
      { capability: "moderation.chatfilter", level: "read" },
      { capability: "moderation.zones", level: "read" },
      { capability: "autosettings.profiles", level: "read" },
      { capability: "seeding.config", level: "read" },
      { capability: "seeding.rewards", level: "read" },
    ],
  },
  {
    key: "admin",
    label: "Administrator",
    description: "Everything except user & role management, the Discord bot's setup and online access.",
    // The two carved off user & role admin stay out with it: an Administrator never had them.
    grants: CAPABILITY_CATALOG.filter((c) => !ADMIN_PRESET_LEAVES_OUT.has(c.key)).map((c) => ({ capability: c.key, level: "write" as const })),
  },
  {
    key: "owner",
    label: "Owner (all access)",
    description: "The wildcard grant: every capability, including user & role management.",
    grants: [{ capability: "*", level: "write" }],
  },
] as const;
