/**
 * Core entities and the Repository interface. The rest of the system depends on this
 * interface, not a concrete database — so the API runs on the in-memory repo in dev/tests
 * and on Postgres in production without any call-site changes.
 */
import type { EngagementMode, RconProtocol, AccessLevel, GrantScope, SignatureActionMap } from "@app/shared";
// The one timezone implementation in the repo — the same `zonedParts` the memory store and the
// map-vote scheduler use, so "Saturday 20:00" means the same thing everywhere.
import { WEEKDAYS as WEEKDAY_ORDER, zonedParts } from "@app/schedule";
import type { ClanTagSettings } from "./clan-tags.js";

/** binary-v2 header framing variant (kept in sync with rcon-core's HeaderMode). */
export type HeaderMode = "magic" | "legacy";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string | null; // null for Discord-only accounts (no password login)
  email: string | null;
  discordId: string | null;       // linked Discord user id — NEVER changes, so it is the identity
  discordUsername: string | null; // the unique @handle (e.g. "jdk5294")
  discordNick: string | null;     // guild nickname / global display name — changes freely
  discordManaged: boolean;     // true when panel roles are driven by the Discord role mapping
  /** when this user last opened the staff announcements board (null = never). Drives the
   *  "new announcements since you were last here" notice. */
  announcementsSeenAt: string | null;
  /**
   * Which generation of this account's sessions is still valid.
   *
   * Web sessions are stateless signed tokens, so nothing on the server "holds" one to throw away.
   * Each token records the epoch it was signed under, and a request is honoured only while the two
   * agree — so raising this number ends every session for the account at once. Zero is the value
   * every account starts at and the value a token with no epoch reads as, which is what lets the
   * column be added without signing anybody out.
   */
  sessionEpoch: number;
  createdAt: string;
}

/** One mapping from a Discord role id to a panel role (permission bundle). */
/**
 * A role handed out somewhere, and where it applies.
 *
 * `scopeId: null` means the whole community, which is what every assignment used to be. A server
 * id means the role's capabilities apply on that server and nowhere else — so one "Moderator"
 * role covers every server without becoming one role per server.
 */
export interface RoleAssignment {
  roleId: string;
  scopeId: string | null;
}

export interface DiscordRoleMapRow {
  discordRoleId: string;
  discordRoleName: string | null;
  roleId: string;
  /** null = this Discord role grants the panel role everywhere. */
  scopeId: string | null;
  createdAt: string;
}

export interface ApiTokenRow {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string | null;
}

/**
 * One phone or computer taking phone notifications for one account (Settings → Phone
 * notifications): the address its browser's push service gave it, and the keys a message to it is
 * encrypted with. Keyed by that address — a browser turned on again replaces its own row.
 */
export interface PushSubscriptionRow {
  endpoint: string;
  userId: string;
  /** The browser's public key (P-256, base64url) and its 16-byte secret: what a message is sealed to. */
  p256dh: string;
  auth: string;
  /** What the person would call it: "iPhone", "Windows computer". */
  device: string;
  /** The address the panel was open at when it was turned on — the contact a push names. */
  origin: string;
  /** The account's session epoch when it was turned on. Signing out everywhere moves the account
   *  to a new one, and a device left on the old one hears nothing more. */
  epoch: number;
  createdAt: string;
}

/**
 * The automations that can act on a server, each individually switchable.
 *
 * Engagement mode is the master safety: observe blocks every write no matter what. These switches
 * exist for the OTHER migration problem — a community moving off CRCON one system at a time.
 * Flipping a server to active used to mean every automation fired at once, against systems CRCON
 * still owns and data not yet synced. With these, "active" can mean exactly one thing: run the map
 * vote here and nothing else.
 *
 * An absent key means its default — the map is a list of exceptions, so existing servers keep
 * their current behaviour and a fresh one runs everything the moment it goes active.
 *
 * Every automation defaults ON except the two reconcilers' "fix what you find" switches
 * (`banSyncApply`, `vipSyncApply`), which default OFF. A reconciler always runs and reports; it
 * issues bans or grants and removes VIP on its own only on a server where staff switched its fix
 * on, after reading what its reports said it would do. These were deploy flags once
 * (BAN_RECONCILE_APPLY / VIP_RECONCILE_APPLY, one for every server); they live here so they are
 * set in the app, per server, by the same people who decide what else the app may do there.
 */
export const SERVER_AUTOMATION_KEYS = ["mapvote", "broadcast", "seeding", "autosettings", "vipSweep", "consoleAdminSweep", "banSync", "vipSync", "banSyncApply", "vipSyncApply"] as const;
export type ServerAutomationKey = (typeof SERVER_AUTOMATION_KEYS)[number];
export type ServerAutomation = Partial<Record<ServerAutomationKey, boolean>>;
/** The automations that stay off until a server's staff switch them on. */
export const SERVER_AUTOMATION_DEFAULT_OFF: readonly ServerAutomationKey[] = ["banSyncApply", "vipSyncApply"];
/** What an absent key means for this automation. */
export function automationDefault(key: ServerAutomationKey): boolean {
  return !SERVER_AUTOMATION_DEFAULT_OFF.includes(key);
}
/** Absent means the key's default: the stored map is a list of exceptions. */
export function automationEnabled(automation: ServerAutomation | null | undefined, key: ServerAutomationKey): boolean {
  const v = automation?.[key];
  return typeof v === "boolean" ? v : automationDefault(key);
}

export interface ServerRow {
  id: string;
  /**
   * What the app CALLS this server — the staff nickname when one is set, else the game's own
   * name. This is the display name on purpose: audits, Discord embeds, player messages, panel
   * lists, every composed sentence wants the readable name, so the repository resolves it ONCE
   * at the read boundary instead of every call site remembering to. The handful of places that
   * need the game's real name (RCON name resolution, the public stats surfaces) read `gameName`.
   */
  name: string;
  /** The game server's OWN name — what players see in the server browser. Never the nickname. */
  gameName: string;
  game: string;
  protocol: RconProtocol;
  host: string;
  port: number;
  /** RCON password — a secret. Sealed at rest (AES-256-GCM) in Postgres when ENCRYPTION_KEY is set; the repository decrypts on read. */
  password: string;
  engagementMode: EngagementMode;
  automation: ServerAutomation;
  headerMode: HeaderMode | null;
  gameVersion: string | null;
  timezone: string | null;
  crconBaseUrl: string | null;
  /**
   * Serve this server's read-only state on CRCON's public API names, WITHOUT a login, so a
   * streamer's existing CRCON overlay tool works against it unchanged. Off by default: this is
   * the only unauthenticated surface in the app, and turning it on is a deliberate act per
   * server. The enabled set is a fixed whitelist — see docs/streamer-mode.md and, for the
   * public stats page built on the same switch, docs/public-stats.md.
   */
  streamerMode: boolean;
  /**
   * The server's address on the public stats site: /stats/<publicSlug>. Human-typeable where the
   * row id is not — staff know what "server 3" means, players getting a link do not, so the slug
   * is what gets said out loud ("stats slash nam"). Unique across servers when set; null means
   * the server has never been named for the public site (the publish flow fills it in).
   */
  publicSlug: string | null;
  /**
   * What the public page CALLS the server — separate from `name`, which is the staff-facing
   * connection label and may say things ("observe", an IP) a visitor has no use for. Also serves
   * as CRCON's `short_name` in get_public_info. Null = fall back to `name`.
   */
  publicName: string | null;
  /**
   * The staff-set alias behind `name`. Null = none (the game name shows). Set on the Connections
   * card; when present it IS `name` everywhere except the public stats page, which shows the
   * game's real identity with this alias quoted beside it.
   */
  nickname: string | null;
  /**
   * Whether the public surface publishes each player's PLATFORM ID (Steam64 / EOS) beside their
   * name, as CRCON's own public scoreboard does. TRUE by default — CRCON parity, and the ids are
   * what a consuming tool joins on. It stays its own switch (rather than being wired to
   * publishing) so ids can be pulled for one server without taking its whole page down.
   */
  publicPlayerIds: boolean;
  /**
   * When staff RETIRED this server (null = live). A retired server keeps every row it ever
   * produced — careers, matches, events, VIP history, nothing cascades — but stops existing
   * anywhere except the Connections tab: `servers.list()` drops it BY DEFAULT, so every picker,
   * worker loop, Discord module and public page loses it without each caller having to know the
   * feature exists. Reads that label HISTORY (an id→name map over old rows) opt back in with
   * `includeRetired`, so records from its era stay readable. Reversible — stage 1 of the
   * retire → decommission → delete lifecycle.
   */
  retiredAt: string | null;
  /**
   * Every name this server has gone by — earlier nicknames, in-game names, public names and slugs,
   * newest first (capped). A message saved as "{vip_until:WW2}" must keep working after staff
   * rename WW2 to "WW2 #1": the placeholder matches current names first, then these. Staff-only
   * history, so it never rides the public wire (see toPublicServer).
   */
  formerNames: string[];
  /**
   * When the SETUP ACCOUNT decommissioned this server (null = not decommissioned). Stage 2 of the
   * lifecycle, and the first stage that is not everyone's to reach: only the install's first
   * created login — the account that set the panel up — may stamp or clear it, because whoever
   * holds this stage holds the key to the final delete, and "anyone with a permission" must not.
   * A decommissioned server vanishes from EVERY other account's Connections tab (the API filters
   * it per requester; the store itself cannot know who is asking) while every record it ever
   * produced stays put and retrievable. Requires `retiredAt` to already be set; reversible back
   * to plain retired.
   */
  decommissionedAt: string | null;
  /**
   * Which `SERVER_<n>_*` block in the environment seeded this server, or null when it was added
   * through the panel.
   *
   * This is the server's identity as far as env discovery is concerned, and deliberately NOT its
   * address: a host can move a server to a new ip, port and password and it is still the same
   * server — same records, same bans, same stats, same settings, only a new face. Matching on the
   * address made a moved server look unknown, and the next boot re-seeded it as a second, empty
   * server. The slot is stable across any number of moves.
   */
  seedSlot: number | null;
  /**
   * When a connection to this server last SUCCEEDED, and the most recent failure.
   *
   * A server that cannot be reached is the most important fact about it, and the app used to
   * discard it: every dial's outcome was thrown away, so a server whose credentials had gone stale
   * looked identical to a healthy one on every screen while failing every operation. Kept as a
   * pair rather than one status because "failing now, worked an hour ago" and "failing now, never
   * worked" are different problems. `lastError` is cleared on the next success.
   */
  lastContactAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
}

/** Server as exposed by the API — never includes the RCON password. */
/**
 * A server as the panel sees it: everything but the password.
 *
 * `no` is the DISPLAY ORDINAL — "the Nth server this community added" — and it is attached by the
 * listing route, not stored. It has to be computed over EVERY server before the list is filtered
 * to what the reader may see, because the alternative (numbering by position in the list you were
 * handed) gives a different answer to every reader: somebody granted access to the third server
 * alone received a one-server list and was told they were looking at "Server 1". The number is a
 * label for humans, never an identifier — everything that stores or routes uses the id.
 */
export type ServerPublic = Omit<ServerRow, "password" | "formerNames"> & { no?: number };

export interface GrantRow {
  id: string;
  userId: string;
  capability: string;
  scopeType: GrantScope;
  scopeId: string | null;
  level: AccessLevel;
}

/** One capability inside a role bundle (roles are global-scope by design). `none` is an
 *  explicit veto: it blocks the capability even if another role or grant confers it. */
export interface RoleGrantEntry {
  capability: string;
  level: "none" | "read" | "write";
}
export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  grants: RoleGrantEntry[];
  limits: Record<string, number>;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface NewRole {
  name: string;
  description?: string | null;
  grants: RoleGrantEntry[];
  /** Per-role rate limits. Optional: a role with none is an ordinary role, and both stores read an
   *  absent one as `{}` — it was required here while only one of them actually could. */
  limits?: Record<string, number>;
  createdByName?: string | null;
}

export interface NewServer {
  name: string;
  game?: string;
  protocol?: RconProtocol;
  host: string;
  port: number;
  password: string;
  engagementMode?: EngagementMode;
  automation?: ServerAutomation;
  headerMode?: HeaderMode | null;
  /** crcon-bridge only: base URL of the existing CRCON instance to read through. */
  crconBaseUrl?: string | null;
  /** the `SERVER_<n>_*` env block this came from; omitted for a server added through the panel. */
  seedSlot?: number | null;
}

/**
 * A change to how the panel reaches an existing server. Every field optional: rotating a password
 * should not make you restate the host, and moving a server should not make you retype a secret
 * the operator may not even have to hand. Omitted = left as it is; `password` omitted specifically
 * means "keep the stored one", which is what lets the editor render without ever sending it back.
 */
export interface ServerConnectionPatch {
  host?: string;
  port?: number;
  password?: string;
  protocol?: RconProtocol;
  headerMode?: HeaderMode | null;
  crconBaseUrl?: string | null;
}

/** A tracked in-game player identity (keyed by platform id — Steam64 or hashed). */
/** A player as a live read or a log line reports them — what `players.upsert` takes. */
export interface SeenPlayer {
  /**
   * Which game's account this is — named by the caller, never defaulted. HLL: Vietnam does not
   * identify players by the same id as HLL, so an id only means something alongside the game it came
   * from, and a row that guessed becomes a VIP grant that lands nowhere.
   */
  game: string;
  platform: string;
  platformId: string;
  name: string;
  clanTag?: string;
  /** From the roster read this sighting came from, when it had one. Omitted leaves a stored level
   *  alone: a sighting that could not see the level is not evidence that they have none. */
  level?: number;
  ts?: string;
}

export interface PlayerRow {
  id: string;
  /** the game whose server saw this account; fixed when the row is created. */
  game: string;
  platform: string;
  platformId: string;
  name: string;
  /** Their level the last time a roster read named it; null until one has. Kept because it is the
   *  only player fact the enforcer cannot re-read at firing time — it acts from bus events, and
   *  events carry no roster. */
  level: number | null;
  firstSeen: string;
  lastSeen: string;
}

/**
 * The server id carried by career history recorded before stats were split per server, on an
 * install that ran more than one server at the time — real play with no honest server to name.
 *
 * It counts toward a career total (which sums every row) but is never claimed by a per-server
 * view. A single-server install has none of these: migration 049 attributes its whole history to
 * the one server it can only have been played on.
 */
export const UNATTRIBUTED_SERVER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * One player whose stored last_seen outruns everything that could vouch for it, and the evidence
 * that contradicts it. `best` is what the repair would lower the clock to; the three sources are
 * shown separately because WHICH one is missing tells the operator what happened — a player with
 * no sessions and no events at all was never really seen, they were written by an importer.
 */
export interface LastSeenDriftRow {
  id: string;
  name: string;
  platformId: string;
  /** The clock as stored today — what the profile shows. */
  lastSeen: string;
  /** What the evidence supports: the newest of first_seen, last session end, last event. */
  best: string;
  firstSeen: string;
  lastSessionEnd: string | null;
  lastEvent: string | null;
}

export interface LastSeenDrift {
  /** How many players are drifted in total (the sample is only the worst of them). */
  total: number;
  sample: LastSeenDriftRow[];
}

/** Filters for the records directory (the Players page). All optional; unset = no constraint. */
export interface PlayerDirectoryFilters {
  /** name/platform-id substring. */
  q?: string;
  platform?: string;
  /**
   * Only accounts of this game ("hll" | "hllv"). The picker behind every per-server action sets it
   * to the TARGET server's game, because the games issue different player ids and an id from the
   * wrong game is a command the server accepts and applies to nobody.
   */
  game?: string;
  /**
   * Restrict to players who have played on these servers, and report their figures on THOSE
   * servers (which is also what the stat sorts order by). Unset means every player the community
   * has ever seen, with careers summed across every server — a different question, and the caller
   * has to pick one.
   *
   * A list rather than a single id because a viewer scoped to two of five servers must see exactly
   * those two summed, never all five.
   */
  serverIds?: string[];
  /** last-seen window (ISO instants, inclusive). */
  seenFrom?: string;
  seenTill?: string;
  watchedOnly?: boolean;
  vipOnly?: boolean;
  /** Only players who have worn one of these clan tag spellings (the API expands a main tag into
   *  every spelling of it — see clan-tags.ts). */
  clanTags?: string[];
  sort?: "lastSeen" | "firstSeen" | "name" | "platform" | "kills" | "teamkills" | "playtime" | "visits";
  /** only players with an ACTIVE permanent ban decision (player_ban, unlifted and unexpired). */
  permaBannedOnly?: boolean;
  /** Which way. Every column is clickable in the directory, so every column must reverse. */
  sortDir?: "asc" | "desc";
  limit?: number;
  /** rows to skip — how the directory reaches past the first page. */
  offset?: number;
  /**
   * Keyset cursor: the sort key and id of the LAST row of the previous page. When present it
   * replaces `offset` entirely.
   *
   * The directory is the one paged list that cannot be pinned to a moment in time. The game log and
   * the audit trail only ever gain rows, so an upper time bound freezes them; the directory is a
   * view of mutable rows — `last_seen` changes every time somebody connects, `kills` every time
   * they fire — so the row you are sorted by MOVES, and offset paging then skips and repeats rows
   * whichever way it moved. Keyset asks "the next rows after this exact position in the ordering",
   * which stays correct however the rows underneath change.
   */
  after?: { value: string | number | null; id: string };
}

/** A directory row: the player plus career stats and profile flags, resolved in one query. */
export interface PlayerDirectoryRow extends PlayerRow {
  kills: number;
  deaths: number;
  teamkills: number;
  visits: number;
  playtimeSec: number;
  watchlist: boolean;
  /** Holds a live VIP grant — on the filtered server when one was named, on any server otherwise.
   *  This is the grants table, the same source as the profile's VIP panel. */
  vip: boolean;
  /** This row's value in whatever column the query sorted by — what the next page's cursor is
   *  built from, so the caller never has to re-derive an expression like lower(name). */
  sortKey: string | number | null;
}

/**
 * A historical identity a player has used — a past name ("name") or clan tag ("clan"). Recorded
 * automatically whenever a player is seen (ingest + live reads): the first time a value appears we
 * stamp `firstSeen`, and every subsequent sighting bumps `lastSeen` and `seenCount`. Powers the
 * "Also known as" / clan-tag history on the player profile.
 */
export interface PlayerAliasRow {
  playerId: string;
  kind: "name" | "clan";
  value: string;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
}

/** One clan tag spelling as recorded: players who have worn it, players wearing it now, last seen. */
export interface ClanSpellingRow { tag: string; ever: number; now: number; lastSeen: string }
/** The same counts for a group of spellings (a main tag) — each player counted once. */
export interface ClanGroupStatsRow { key: string; ever: number; now: number; lastSeen: string | null }
/** Who a clan read covers: one game's accounts, and — for a viewer limited to some servers —
 *  only players with a career row on one of those servers, the same boundary the directory keeps. */
export interface ClanScope { game?: string; serverIds?: string[] }
export interface ClanMembersQuery extends ClanScope {
  /** the spellings to list wearers of (every spelling of the chosen main tags). */
  tags: string[];
  /** now = wearing one of them; former = wore one and no longer does; any (default) = both. */
  status?: "now" | "former" | "any";
  /** only players last seen at or after this instant. */
  seenFrom?: string;
  limit?: number;
  offset?: number;
}
export interface ClanMemberRow {
  player: PlayerRow;
  /** the spelling they wore most recently, of the ones asked about. */
  tag: string;
  /** first and last seen wearing any of them. */
  firstSeen: string;
  lastSeen: string;
  wearingNow: boolean;
  /** the tag they wear now, whichever it is — null when their latest session showed none. */
  currentTag: string | null;
}

/**
 * A linked external identity: `(provider, externalId) ↔ player`. Providers are open-ended strings
 * ("eos", "discord", "steamweb", …) so integrations/plugins can link identities without core schema
 * changes — game- and integration-specific ids never become columns on `players`.
 */
export interface ExternalLinkRow {
  playerId: string;
  provider: string;
  externalId: string;
  createdByName: string | null;
  createdAt: string;
}

/** A custom player flag/tag — a short colored label (emoji or text) an admin attaches to a player
 *  (CRCON's "flags"), e.g. "🚩 toxic" or "good SL". Distinct from the watchlist/VIP booleans. */
export interface PlayerTagRow {
  id: string;
  playerId: string;
  label: string;
  note: string | null;
  createdByName: string;
  createdAt: string;
}
export interface NewPlayerTag {
  playerId: string;
  label: string;
  note?: string | null;
  createdByName: string;
}

/** One completed play session (a connect→disconnect pair), kept for the profile's session history. */
export interface PlayerSessionRow {
  id: string;
  playerId: string;
  serverId: string;
  connectedAt: string;
  disconnectedAt: string;
  durationSec: number;
}

/** A completed session being imported from history — a PlayerSessionRow before it has an id. */
export type ImportedSession = Omit<PlayerSessionRow, "id">;

/**
 * Per-player career rollup. Accumulated incrementally AT INGEST TIME (not recomputed from
 * `evt`), so it survives trimming of the raw event store — trimming old events never loses
 * these totals. Tiny and kept forever.
 */
export interface PlayerStatsRow {
  playerId: string;
  /**
   * The server these figures were earned on, or null when the row is a career total summed across
   * every server (what `stats.get` returns with no serverId).
   *
   * `UNATTRIBUTED_SERVER_ID` appears here for history that predates the per-server split on an
   * install that ran more than one server — real play, with no honest server to name.
   */
  serverId: string | null;
  kills: number;
  deaths: number;
  teamkills: number;
  /** number of play sessions (server joins) seen. */
  visits: number;
  /** total time played across all completed sessions, in seconds. */
  playtimeSec: number;
  /**
   * The game's own score buckets, accumulated across every round. Kills and deaths say almost
   * nothing about a Hell Let Loose player who builds nodes and holds a point; these are what make
   * that player visible.
   */
  combat: number;
  offense: number;
  defense: number;
  support: number;
  vehicleKills: number;
  vehiclesDestroyed: number;
  /** seconds in each role, keyed by the game's raw role number (the role set is the game's). */
  roleSeconds: Record<string, number>;
  /** seconds spent leading a squad — pulled out of roleSeconds so it can be sorted on. */
  slSeconds: number;
  /** highest level ever seen; the game's level only climbs, so max is self-healing. */
  highestLevel: number;
  matchesPlayed: number;
  matchesWon: number;
  updatedAt: string;
}

/** One player's contribution to one sample of the roster — what the 60s sampler observes. */
export interface RosterSampleRow {
  /** platform id as the game reports it; resolved to our player id by the store. */
  platformId: string;
  name?: string;
  /** raw role number, or null when the game did not say. */
  role: number | null;
  /** true when this role leads a squad, decided by the game descriptor, not by the store. */
  isSquadLead?: boolean;
  level?: number;
  side?: "allies" | "axis" | null;
  /**
   * The squad the game reports for this player as its own INDEX, or null when unassigned — the
   * protocol's `platoonIndex`, not the display `platoon` name. Feeds the per-round unit history
   * CRCON publishes as `units`, which appends an entry whenever the (team, squad, role) triple
   * changes, so the squad has to be sampled to be diffed. An index because CRCON's
   * `UnitHistoryEntry.squad` is an int and the public API republishes it raw.
   */
  squad?: number | null;
  /** the round's running totals as the game reports them — NOT deltas. */
  score?: {
    combat?: number; offense?: number; defense?: number; support?: number;
    vehicleKills?: number; vehiclesDestroyed?: number;
    /**
     * The GAME's own kill and death counters for the round, which are not the same numbers as the
     * kill stream's `kills`/`deaths`: the game's kill counter also increments on an assist, and its
     * death counter on a redeploy. CRCON keeps both for exactly that reason and publishes these two
     * as `kills_and_assists` / `deaths_and_redeploys` (`rcon/logs/loop.py`). Reading only one of
     * the pair and calling it the other would silently misreport both.
     */
    killsAndAssists?: number;
    deathsAndRedeploys?: number;
  };
}

export interface StatsDelta {
  kills?: number;
  deaths?: number;
  teamkills?: number;
  visits?: number;
  playtimeSec?: number;
}

/**
 * Every column a career board can be ordered by. Exported as a runtime array as well as a type,
 * because the API has to validate a query string against it — and when that whitelist was written
 * out by hand it drifted: the score buckets and squad-leader time were collectable, storable and
 * sortable here, and the route quietly answered every request for them with the kill board.
 */
export const LEADERBOARD_SORTS = [
  "kills", "deaths", "teamkills", "kd", "combat", "offense", "defense", "support", "slSeconds", "playtime",
] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];

/** A freeform admin note on a player. Viewable with the `player.notes` read capability. */
export interface PlayerNoteRow {
  id: string;
  playerId: string;
  authorUserId: string | null;
  authorName: string;
  body: string;
  createdAt: string;
}
export interface NewPlayerNote {
  playerId: string;
  authorUserId?: string | null;
  authorName: string;
  body: string;
  /** When the note was actually written. An import passes the record's own stamp so a 2023 CRCON
   *  comment reads as 2023, not as the day someone ran the import. Omitted = now. */
  createdAt?: string | null;
}

/** Watchlist / VIP flags on a player. */
/** One IP a player has been seen on. Sensitive — reading requires the player.ips capability. */
export interface PlayerIpRow {
  playerId: string;
  ip: string;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
  /** where it came from, e.g. "crcon-profile" or "crcon-log". */
  source: string;
}

export interface PlayerFlagsRow {
  playerId: string;
  watchlist: boolean;
  vip: boolean;
  updatedByName: string | null;
  updatedAt: string | null;
  /** Watch provenance — why/who/when for the CURRENT watch. Null unless watchlist is true;
   *  cleared on unwatch. updatedBy/At can't carry this: any flag change overwrites them. */
  watchReason: string | null;
  watchBy: string | null;
  watchAt: string | null;
}
/** One watch spell, kept forever: opened when the flag armed, closed (never deleted) on removal. */
export interface WatchHistoryRow {
  id: string;
  playerId: string;
  reason: string | null;
  watchedBy: string | null;
  watchedAt: string;
  removedBy: string | null;
  removedAt: string | null;
}

/** A prior version of a watch reason, kept on the row when it is edited — "pre edits should
 *  remain retrievable" is a moderation-record requirement, not a nicety. */
export interface WatchReasonEdit {
  reason: string;
  expiresAt: string | null;
  editedBy: string | null;
  editedAt: string;
}
/**
 * One REASON somebody is watched — the unit the watchlist is actually made of.
 *
 * A watch used to be a boolean with a single reason field, so a second staff member's concern
 * either overwrote the first or could not be recorded at all. Reasons are now rows: added
 * independently, removed independently (never deleted — `removedAt` closes them), each optionally
 * expiring on its own clock. The player is ON the watchlist while at least one reason is active
 * (not removed, not expired); the `player_flags.watchlist` boolean every consumer reads is a
 * cache of that fact, kept in sync by the service layer.
 */
export interface WatchReasonRow {
  id: string;
  playerId: string;
  reason: string;
  addedBy: string | null;
  /** The author's ACCOUNT id — what "edit your own" is decided by, since display names change.
   *  Null on rows from before the curation split (and on automation), which reads as "not
   *  provably yours": only a curator touches those. */
  addedByUserId: string | null;
  addedAt: string;
  /** null = watches until removed; otherwise the reason lapses on its own at this instant. */
  expiresAt: string | null;
  removedBy: string | null;
  removedAt: string | null;
  /** Prior versions, oldest first. Never trimmed. */
  edits: WatchReasonEdit[];
}
export interface PlayerFlagsPatch {
  watchlist?: boolean;
  vip?: boolean;
  /** Provenance for the watch flag. Provided values overwrite; omitted values are kept (except
   *  when watchlist flips on, where by/at default to the acting user and now). Unwatch clears all
   *  three. Imports pass the original CRCON reason/author/timestamp here. */
  watchReason?: string;
  watchBy?: string;
  watchAt?: string;
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  platform: string;
  kills: number;
  deaths: number;
  teamkills: number;
  kd: number;
  /** The game's score buckets — what a board has to show to credit anything but fragging. */
  combat: number;
  offense: number;
  defense: number;
  support: number;
  /** seconds spent leading a squad, and total time played, both sortable. */
  slSeconds: number;
  playtime: number;
}

export function computeKd(kills: number, deaths: number): number {
  return deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : kills;
}

/** The columns a single-round records board can rank by — a whitelist because the key reaches
 *  SQL as a column name and reaches the API as a query string. */
export const MATCH_RECORD_KEYS = ["kills", "combat", "offense", "defense", "support"] as const;
export type MatchRecordKey = (typeof MATCH_RECORD_KEYS)[number];

/** One entry on a records board: who, how much, and in which round. */
export interface MatchStatRecord {
  playerId: string;
  playerName: string | null;
  side: "allies" | "axis" | null;
  value: number;
  /** the round, spoken the way the public surface speaks rounds (see MatchRow.seq). */
  matchSeq: number;
  map: string | null;
  startedAt: string;
}

/** A class-board entry also names the weapon that carried the record — "127 with the howitzer"
 *  is the record; the class is just its shelf. */
export interface ClassKillRecord extends MatchStatRecord {
  weapon: string | null;
}

/** A stored normalized event (`evt.*`). `kind` is the canonical event name. */
export interface EvtRow {
  id: string;
  serverId: string;
  ts: string;
  kind: string;
  actorPlayerId: string | null;
  actorName: string | null;
  victimPlayerId: string | null;
  victimName: string | null;
  weapon: string | null;
  data: Record<string, unknown> | null;
  /** stable identity of the source log line (unix ts + body); powers insert idempotency. */
  dedupeKey: string | null;
}

export interface NewEvt {
  serverId: string;
  ts: string;
  kind: string;
  actorPlayerId?: string | null;
  actorName?: string | null;
  victimPlayerId?: string | null;
  victimName?: string | null;
  weapon?: string | null;
  data?: Record<string, unknown> | null;
  /** stable per-server identity; a repeated log line with the same key is inserted once. */
  dedupeKey?: string | null;
}

/**
 * A manual data-trim request. Deletes raw `evt` rows whose `kind` is in `kinds` and that
 * are older than `olderThanIso`. Optional backup exports the matched slice first.
 */
export interface TrimSpec {
  kinds: string[];
  olderThanIso: string;
  /** if set, export the matched rows here (gzipped NDJSON) before deleting; abort on failure. */
  backupPath?: string | null;
}

export interface TrimResult {
  deleted: number;
  backupPath: string | null;
}

/** Named trim categories → the event kinds they cover.
 *
 *  Every kind the ingest or the CRCON import can store belongs to exactly one category here — an
 *  uncategorised kind is one the trim tool can never reclaim, so it accumulates forever with no way
 *  to remove it. `EVENT_KINDS` below is the whole vocabulary, and the test asserts the two agree. */
export const TRIM_CATEGORIES: Record<string, string[]> = {
  connections: ["evt.player.connected", "evt.player.disconnected"],
  kills: ["evt.kill"], // a kill record is also the victim's death
  teamkills: ["evt.teamkill"],
  chat: ["evt.chat.team", "evt.chat.squad"],
  teamswitches: ["evt.player.teamSwitched"],
  votes: ["evt.vote.started", "evt.vote.completed", "evt.vote.cast"],
  // Kicks/bans/admin messages/camera use — the record of what staff did in game. Kept separate from
  // the audit log, which records what staff did through the panel.
  moderation: ["evt.player.kicked", "evt.player.banned", "evt.player.punished", "evt.admin.message", "evt.admin.camera"],
  // Match start/end are what the round history is derived from, so trimming them is a deliberate act.
  match: ["evt.match.started", "evt.match.ended"],
};

/** Every normalized event kind we can store. The single source of truth for the vocabulary — both
 *  the trim categories and the panel's filter categories are checked against it. */
export const EVENT_KINDS = [
  "evt.kill", "evt.teamkill",
  "evt.chat.team", "evt.chat.squad",
  "evt.player.connected", "evt.player.disconnected", "evt.player.teamSwitched",
  "evt.player.kicked", "evt.player.banned", "evt.player.punished",
  "evt.admin.message", "evt.admin.camera",
  "evt.vote.started", "evt.vote.completed", "evt.vote.cast",
  "evt.match.started", "evt.match.ended",
] as const;

/**
 * The trim categories in plain words, for the panel and the API to share. This copy used to live
 * in the panel alone, which is how catalogs drift: a category added here was invisible there
 * until somebody noticed. One list, served over the API, rendered verbatim.
 */
export const TRIM_CATEGORY_INFO: { id: string; label: string; hint: string }[] = [
  { id: "connections", label: "Joins and leaves", hint: "who connected and disconnected" },
  { id: "kills", label: "Kills", hint: "the killfeed — usually the biggest event category by far" },
  { id: "teamkills", label: "Team kills", hint: "keep these longer than kills if you use them for moderation" },
  { id: "chat", label: "Chat", hint: "team and squad messages" },
  { id: "teamswitches", label: "Team switches", hint: "players changing side" },
  { id: "votes", label: "In-game votes", hint: "vote kicks and the like — not the map vote" },
  { id: "moderation", label: "Moderation in game", hint: "kicks, bans, admin messages and camera use" },
  { id: "match", label: "Match start and end", hint: "the round history is built from these — trimming loses it" },
];

/**
 * The non-event data types the trim tool can clear, beyond the raw event log.
 *
 * Inclusion rule: a dataset is here when it GROWS with time and ages into history — samples,
 * sessions, finished rounds, old sightings. Deliberately absent, and worth naming because each
 * absence is a decision:
 *
 *  - watch history, bans and blacklist records, VIP grants, player notes — moderation provenance,
 *    kept forever by design (#240 made watch history permanent on purpose);
 *  - the economy ledger — balances are stored, but every balance stays EXPLAINABLE as the sum of
 *    its rows only while the rows exist;
 *  - announcement read receipts — bounded (one row per user per notice), and deleting them would
 *    make the unread-notice nudge re-ping staff about ancient announcements;
 *  - players and career stats — the directory and leaderboard are the product.
 *
 * Every id here must have an implementation in BOTH stores' `trimData`; the db test walks this
 * list, so adding an id without wiring it fails the build rather than silently never deleting.
 */
export const TRIM_DATASETS: { id: string; label: string; hint: string }[] = [
  { id: "rosterSnapshots", label: "Roster snapshots", hint: "one per server per minute — the fastest-growing table in the app; powers the composition history" },
  { id: "playerSessions", label: "Play sessions", hint: "one per player per visit; playtime and visit totals are already accumulated and are kept" },
  { id: "matches", label: "Match history", hint: "finished rounds and every player's scoreboard line for them; career totals are kept" },
  { id: "mapVotes", label: "Map-vote history", hint: "decided vote rounds and their ballots" },
  { id: "adminCam", label: "Admin camera sessions", hint: "who was in spectator, where, for how long; open sessions are never touched" },
  { id: "ipHistory", label: "IP history", hint: "addresses not seen since the cutoff" },
  { id: "aliasHistory", label: "Name and clan-tag history", hint: "\"also known as\" entries not seen since the cutoff; current names are kept on the player" },
  { id: "audit", label: "Staff activity", hint: "the panel's own action log — what staff did through this app" },
  // Almost every key-value row is live state (a registration code in flight, a standing lockout);
  // the rest is spent and has no reader — the flows delete their own now, but a row orphaned by an
  // old build or an interrupted flow has nothing to remove it. The exception is a row that is a
  // PERMANENT FACT rather than scratch, which is what `keep:` marks — see PERMANENT_KV_PREFIX.
  { id: "pluginKv", label: "Plugin key-value rows", hint: "scratch state for registration and plugins; live codes, standing lockouts and permanent markers are never collected" },
];

/**
 * Keys under this prefix are FACTS, not scratch, and the retention sweep never collects them.
 *
 * Almost everything in plugin_kv is short-lived, which is why the dataset ages out by write time
 * at all. But the store also holds a few markers that record that something IRREVERSIBLE has
 * already happened — the registration day-bonus flag is the one that hurts: it has no expiry and
 * no repair path (see recordRegistrationBonus), and it is the only thing standing between a member
 * and a second helping of welcome VIP. Ageing it out by write time meant a routine trim quietly
 * re-armed a payout months later, on a table whose catalogue entry promised it held only scratch.
 *
 * A plugin storing something that must outlive a trim uses the same prefix, and gets the same
 * protection without either store learning what the key means. Under `keep:viewer:` it is one
 * person's own setting, which also stays out of every archive (DATA_EXPORT_ROWS_KEPT).
 */
export const PERMANENT_KV_PREFIX = "keep:";

/** Whether a plugin_kv key is a permanent marker the retention sweep must leave alone. */
export function isPermanentKvKey(key: string): boolean {
  return key.startsWith(PERMANENT_KV_PREFIX);
}

export function kindsForCategories(categories: string[]): string[] {
  const kinds = new Set<string>();
  for (const c of categories) for (const k of TRIM_CATEGORIES[c] ?? []) kinds.add(k);
  return [...kinds];
}

/**
 * The whole database, carved into individually selectable export groups — what the Backup screen
 * offers, what the exporter writes, and what the importer knows how to put back. The point is a
 * clean-slate migration that keeps only what you choose: export "servers + players + vip + bans"
 * from the old install, migrate a fresh database, import the archive.
 *
 * Ordering is load-bearing twice over: groups are listed parents-first and each group's `tables`
 * are listed parents-first, so an archive written in catalog order can be imported top-to-bottom
 * without tripping a foreign key. `needs` names the groups whose rows this group's foreign keys
 * point at — the panel auto-selects them, and the importer reports (not fails) rows whose parents
 * are genuinely missing.
 *
 * The archive format is one gzipped NDJSON file of `{table, row}` lines (a `{header}` first line
 * carries version + provenance) — the same shape the trim backups write. That file IS the seam a
 * future CRCON-database adapter feeds: translating their schema into these lines is all an
 * importer tune-up has to do.
 */
export interface DataExportGroup { id: string; label: string; hint: string; tables: string[]; needs?: string[] }

/* ---------------- approvals: staff requests and their lines ---------------- */

export type ApprovalRequestStatus = "draft" | "open" | "resolved" | "expired" | "withdrawn";
export type ApprovalLineState = "pending" | "approved" | "denied" | "voided" | "executed";

/**
 * Where a filed request's Discord card is remembered: `pluginKv[this][requestId]` holds
 * `{ channelId, messageId, content }`.
 *
 * The name lives here because two processes use it. The API posts the card and re-renders it after
 * every decision; the WORKER runs the expiry sweep, and closes the card of a request nobody signed
 * in time — which it can do without knowing how a request is worded, because the API leaves the
 * rendered text in this record. A namespace spelled out by hand in both places is a typo away from
 * a card that never closes.
 */
export const APPROVALS_RELAY_KV_NS = "approvals-relay";

/** The longest message Discord accepts — the whole message, not one line of it. */
export const DISCORD_MESSAGE_MAX = 2000;

/**
 * The relay card's own ceiling: under Discord's limit, with room left for the line the expiry sweep
 * adds when it closes the card. A card over the limit is refused outright — it never posts, so the
 * people who approve from Discord never see the request, and an edit is refused the same way — and
 * a card the API posted must always be closable by the worker.
 */
export const APPROVAL_CARD_MAX = 1800;

/** A relay card as the expiry sweep closes it: its last text with the closing line under it, the
 *  text trimmed if the two would not fit in one message. */
export function closedApprovalCard(content: string, voided: number): string {
  const tail = `\n⌛ **Expired** — nobody signed this in time${voided ? `, so ${voided === 1 ? "its one pending line was" : `its ${voided} pending lines were`} voided` : ""}. It can be filed again.`;
  const room = DISCORD_MESSAGE_MAX - tail.length;
  return `${content.length > room ? `${content.slice(0, room - 1)}…` : content}${tail}`;
}

/**
 * The default page size for `economy.ledger`.
 *
 * It is named here because BOTH stores have to agree on it. Postgres defaulted to 100 and the
 * memory store to "every row this member ever had": a caller that omitted `limit` was handed a
 * page in production and the whole ledger in every test, so a truncation bug could not fail a
 * test. The ledger is append-only and unbounded — a member who has been claiming daily for two
 * years has thousands of rows — so the page is the honest default, and the tests now see it.
 */
export const ECONOMY_LEDGER_PAGE = 100;

/**
 * The activity feed's vocabulary: what KIND of movement a ledger entry is, decided from its ref.
 *
 * The ref was already the discriminator — every writer stamps its own prefix (`buy:` from the
 * Discord panel, `staff-buy:` from the panel's buy-for, `payout:<job>:` from the bulk engine,
 * `seed:` from the seeding worker, and so on) — this table just names the families so the API,
 * both stores and the panel agree on one list. A staff adjustment and the cap trim are the two
 * writers with NO ref (they are corrections, not replayable events), which is why "adjust" is
 * spelled as a null match rather than a prefix.
 *
 * Order matters where prefixes overlap: `refund:` rows also start with nothing else (a refund of
 * a purchase is `refund:buy:…`), and `gift-in:` must be checked before `gift:` would match it —
 * the classifier walks this map in declaration order and takes the first hit.
 */
export const ECONOMY_ACTIVITY_KINDS: Readonly<Record<string, { label: string; prefixes: string[] | null }>> = {
  purchase: { label: "Purchases", prefixes: ["buy:", "staff-buy:"] },
  gift: { label: "Gifts", prefixes: ["gift-in:", "gift:", "staff-gift:"] },
  claim: { label: "Claims", prefixes: ["claim:"] },
  payout: { label: "Payouts", prefixes: ["payout:"] },
  seed: { label: "Seed rewards", prefixes: ["seed:"] },
  game: { label: "Game rewards", prefixes: ["game:"] },
  refund: { label: "Refunds", prefixes: ["refund:"] },
  bonus: { label: "Welcome bonuses", prefixes: ["bonus:"] },
  adjust: { label: "Adjustments", prefixes: null }, // ref IS NULL: staff corrections + cap trims
};

/** The kind of one entry, by the table above; "other" for a ref no family claims (e.g. the cutover import's rows). */
export function economyActivityKind(ref: string | null): string {
  if (ref === null) return "adjust";
  for (const [kind, def] of Object.entries(ECONOMY_ACTIVITY_KINDS)) {
    if (def.prefixes && def.prefixes.some((p) => ref.startsWith(p))) return kind;
  }
  return "other";
}

/** One row of the cross-member activity feed: the ledger entry plus who, for display. */
export interface EconomyActivityRow extends EconomyLedgerRow {
  /** The member's Discord display name as the members table knows it; null when never learned. */
  discordName: string | null;
  /** From `economyActivityKind(ref)` — stamped by the store so every reader agrees. */
  kind: string;
}

/** One proposed action: one server, one capability, the exact payload the execute path takes. */
export interface ApprovalLineRow {
  id: string;
  requestId: string;
  seq: number;
  serverId: string | null;
  capability: string;
  kind: string;
  payload: Record<string, unknown>;
  playerId: string | null;
  playerName: string | null;
  state: ApprovalLineState;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  denyReason: string | null;
  /** approve-with-modification on numeric fields: { hours: { requested: 8, granted: 4 } }. */
  modified: Record<string, { requested: number; granted: number }> | null;
  appliedAt: string | null;
  /** the approval stood but execution failed (server unreachable…) — recorded, never silent. */
  applyError: string | null;
  createdAt: string;
}

export interface ApprovalRequestRow {
  id: string;
  requesterUserId: string;
  requesterName: string;
  status: ApprovalRequestStatus;
  note: string | null;
  createdAt: string;
  submittedAt: string | null;
  expiresAt: string | null;
  resolvedAt: string | null;
  updatedAt: string | null;
  /**
   * Drafts only: "Save draft" parks it. A parked draft keeps its lines and resumes on the next
   * "Build a request", but confers NO request-view elevation — leaving the builder is supposed
   * to end the widened view, not just hide the bar. null = actively being built.
   */
  parkedAt: string | null;
  lines: ApprovalLineRow[];
}

export interface NewApprovalLine {
  seq?: number;
  serverId?: string | null;
  capability: string;
  kind: string;
  payload: Record<string, unknown>;
  playerId?: string | null;
  playerName?: string | null;
}

export const DATA_EXPORT_GROUPS: DataExportGroup[] = [
  { id: "settings", label: "App settings", hint: "community clock, Discord command, chat filter, nudge + events-post + signature settings, plugin storage, match board badge",
    tables: ["app_config", "discord_commands", "chat_filter", "announcement_nudge_config", "event_post_config", "signature_config", "plugin_kv", "brand_images"] },
  { id: "servers", label: "Server connections", hint: "hosts, ports and RCON credentials — treat the archive like a password file",
    tables: ["servers"] },
  { id: "accounts", label: "Staff accounts & roles", hint: "users, API tokens, roles, role assignments, permissions, rate limits, saved layouts",
    tables: ["users", "api_tokens", "roles", "user_roles", "grants", "user_limits", "layouts"], needs: ["servers"] },
  { id: "serverConfig", label: "Per-server feature settings", hint: "auto settings + templates, broadcast, relay, Discord role map, seeding, admin-cam, map vote, enforcer rules and their sections, feature presets",
    tables: ["autosettings_templates", "feature_presets", "autosettings_config", "broadcast_config", "welcome_config", "game_rewards_config", "discord_relay_config", "discord_role_map", "seeding_config", "admin_cam_config", "mapvote_config", "rule_sections", "enforcer_rules", "enforcer_vip_grants", "rule_firings", "rule_occurrences"],
    needs: ["servers", "accounts"] },
  { id: "maps", label: "Maps", hint: "custom map display names, map sets, vote schedules, zone sets, taught objective locations, learned map layouts, learned objective names",
    tables: ["map_names", "map_sets", "vote_schedules", "map_zone_sets", "objective_points", "map_layouts", "objective_grids"] },
  { id: "templates", label: "Message templates", hint: "reason/message/broadcast presets",
    tables: ["message_templates"] },
  { id: "players", label: "Players & careers", hint: "the directory: identities, career stats, flags, tags, seeding time, per-player triggers",
    tables: ["players", "player_stats", "player_flags", "player_tags", "seed_progress", "player_triggers"], needs: ["servers"] },
  { id: "aliases", label: "Names & clan tags", hint: "every name and clan tag a player has been seen with",
    tables: ["player_aliases"], needs: ["players"] },
  { id: "notes", label: "Player notes", hint: "freeform admin notes on players",
    tables: ["player_notes"], needs: ["players", "accounts"] },
  { id: "links", label: "Discord links", hint: "Discord-account-to-player registrations",
    tables: ["external_links"], needs: ["players"] },
  { id: "vip", label: "VIP & console admins", hint: "VIP grants, VIP presets, console admin grants",
    tables: ["vip_presets", "vips", "console_admins"], needs: ["players", "servers"] },
  { id: "economy", label: "Economy", hint: "settings, member balances and the full ledger they are explained by",
    tables: ["economy_config", "community_members", "economy_ledger"] },
  // Receipts, not config: the jobs are the record of who was paid what and why, so leaving them
  // behind in a migration would orphan the ledger rows and VIP grants they explain.
  { id: "payouts", label: "Bulk payouts", hint: "every bulk payout job and its per-person receipts",
    tables: ["payout_jobs", "payout_items", "payout_events", "game_reward_receipts", "game_reward_days"], needs: ["players"] },
  // `blacklists`/`blacklist_records` were dropped when the ban record replaced them (see the
  // ban-model migration). The catalogue kept listing them, which broke this group's export AND
  // its size preview with "relation does not exist" — found the day a full backup first walked
  // every group. The schema coverage test guards new tables against being forgotten; the
  // full-catalogue walk in the backup test now guards the reverse direction.
  { id: "bans", label: "Bans", hint: "the ban book: ban decisions and imported CRCON bans",
    tables: ["player_ban", "crcon_ban"], needs: ["players", "servers"] },
  { id: "watch", label: "Watch history", hint: "every watchlist entry ever, active and lifted — spells and per-reason records both",
    tables: ["watch_history", "watch_reasons"], needs: ["players"] },
  { id: "approvals", label: "Approval requests", hint: "staff requests and who signed each line — the approvals record",
    tables: ["approval_requests", "approval_lines"], needs: ["accounts", "servers"] },
  { id: "groups", label: "Player groups", hint: "named groups and their members",
    tables: ["player_groups", "player_group_members"], needs: ["players"] },
  { id: "announcements", label: "Staff announcements", hint: "the noticeboard and its read receipts",
    tables: ["announcements", "announcement_reads"], needs: ["accounts"] },
  { id: "events", label: "Game log", hint: "every normalized game event — usually the biggest part of an archive by far",
    tables: ["evt"], needs: ["servers", "players"] },
  { id: "matches", label: "Match history", hint: "finished rounds and every player's scoreboard line",
    // player_match_weapon_kills rides along: it is derived from the game log, but the matches
    // export carries class_rollup_at stamps — restoring stamps without rows would leave the
    // records boards empty forever, since a stamped round is never re-folded.
    // crcon_short_rounds: the rounds under five minutes the CRCON-compatible endpoints still list;
    // crcon_player_stats: CRCON's per-round player cache, beside each round.
    // match_score_series: each player's score buckets through the round, for its score charts.
    tables: ["matches", "player_match_stats", "player_match_weapon_kills", "crcon_short_rounds", "crcon_player_stats", "match_score_series"], needs: ["servers", "players"] },
  { id: "sessions", label: "Play sessions", hint: "one row per player per visit",
    tables: ["player_sessions"], needs: ["servers", "players"] },
  { id: "rosterSnapshots", label: "Roster snapshots", hint: "per-minute population and composition samples",
    tables: ["roster_snapshots"], needs: ["servers"] },
  { id: "mapVotes", label: "Map-vote history", hint: "decided votes and their ballots",
    tables: ["mapvote_history", "mapvote_ballots"], needs: ["servers"] },
  { id: "adminCam", label: "Admin camera sessions", hint: "who was in spectator, where, for how long",
    tables: ["admin_cam_sessions"], needs: ["servers", "players"] },
  { id: "ipHistory", label: "IP history", hint: "per-player address sightings",
    tables: ["player_ips"], needs: ["players"] },
  { id: "audit", label: "Staff activity", hint: "the panel's own action log",
    tables: ["audit"], needs: ["accounts", "servers"] },
];

/** Tables deliberately NOT exportable, each with its reason — the coverage test walks the schema
 *  and refuses any table that is neither in a group nor named here, so a new table cannot be
 *  silently unmigratable. */
export const DATA_EXPORT_EXCLUDED: Record<string, string> = {
  schema_migrations: "the migration ledger — a fresh database rebuilds it by running migrations",
  evt_default: "a partition of evt — its rows export through evt itself",
  open_sessions: "live state: who is connected right now",
  mapvote_state: "live state: the poll in flight",
  objective_layout_expiries: "live state: the plays-left countdown on a saved Vietnam layout — it counts rounds on THIS install's servers as they happen",
  // Not a group with an owner flag: export, backup and import are all gated on admin.data, which
  // every Administrator holds, so an archive would hand presets to people the tab hides them from.
  map_point_presets: "objective presets, a removed feature: nothing reads them any more, so there is nothing to carry",
  map_point_pending: "live state: a stored layout THIS install's worker still has to put back on its own servers (left by the removed objective presets)",
  seeding_state: "live state: the current seeding phase",
  service_heartbeats: "runtime health, meaningless on another install",
  crcon_import_job: "CRCON pull bookkeeping — the archive it builds lives on disk, not in the database",
  install_settings: "this install's own keys and service credentials (the login-signing key, the setup code, sealed credentials) — a restored install keeps its own, and an archive never carries them",
  push_subscriptions: "the devices taking phone notifications — each one subscribed to THIS install's own key (kept in install_settings), so nothing could reach them from another; people turn them on again there",
  rule_status: "live state: what each roster rule saw on its latest check, overwritten every few seconds",
  config_versions: "edit history of rules, map sets and vote schedules on this install — an archive carries the records themselves, not every save that led to them",
  // Most are drained within seconds; one waiting for its member to be seen on a server can stand
  // for up to 30 days. Not carried across: an archive restored on another install starts with an
  // empty queue, so a rule still waiting for a member there does not fire on the new one.
  player_group_events: "live state: group membership changes for the rules engine — drained within seconds, or waiting (up to 30 days) for their member to be seen; not carried across",
};

/**
 * The tables whose rows decide who can sign in and what they may do: accounts and their password
 * hashes (and the oldest one is the setup account, which holds the server-lifecycle keys), API
 * tokens, roles, role assignments, grants, limits — and the Discord role map, which hands roles to
 * whoever holds a Discord role at their next sign-in. An archive is a hand-editable file, so
 * importing one of these rows is granting it; only an owner may (see the import route).
 */
export const DATA_PORT_ACCESS_TABLES: readonly string[] = ["users", "api_tokens", "roles", "user_roles", "grants", "user_limits", "discord_role_map"];

/**
 * Rows of an EXPORTED table that stay behind, as a predicate on the rows that DO go, with the
 * reason. Applied to the counts and the archive, so the two agree, and to a restore's wipe, which
 * leaves these rows where they are — no archive could bring them back. The rest of the table
 * travels as usual.
 */
export const DATA_EXPORT_ROWS_KEPT: Record<string, { where: string; why: string }> = {
  plugin_kv: {
    where: "NOT (key LIKE 'keep:viewer:%')",
    why: "one person's own settings in a plugin (keys under keep:viewer:) — the archive is read by every admin.data holder, and a row per person would name who uses it",
  },
};

export function tablesForDataGroups(groups: string[]): string[] {
  const byId = new Map(DATA_EXPORT_GROUPS.map((g) => [g.id, g]));
  const unknown = groups.filter((g) => !byId.has(g));
  if (unknown.length) throw new Error(`unknown export group(s): ${unknown.join(", ")}`);
  const want = new Set(groups);
  // Catalog order, not request order — the archive must be written parents-first.
  return DATA_EXPORT_GROUPS.filter((g) => want.has(g.id)).flatMap((g) => g.tables);
}

/** Every export group — what a FULL backup selects. One expression, so the backup button and the
 *  restore wipe can never disagree with the catalog about what "everything" means. */
export function allDataGroups(): string[] {
  return DATA_EXPORT_GROUPS.map((g) => g.id);
}

/** What the importer did with one table's rows. `skipped` = already present (conflict);
 *  `failed` = refused by the database (usually a missing parent row), first error kept. */
export interface DataPortTableReport { read: number; inserted: number; skipped: number; failed: number; error?: string }
export type DataPortReport = Record<string, DataPortTableReport>;

/** A staff notice on the announcements board. */
export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  published: boolean;
  /** when it was (last) posted — the anchor for time-to-see analytics. null while a draft. */
  publishedAt: string | null;
  /** when the unread-nudge fired for this posting (null = not yet). Cleared on re-post, so a
   *  re-posted notice earns a fresh nudge cycle. */
  nudgedAt: string | null;
  authorUserId: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Global (board-wide) config for the Discord unread-notice nudge. */
export interface AnnouncementNudgeConfig {
  enabled: boolean;
  /** the staff Discord channel the reminder is posted in. */
  channelId: string;
  /** how long after posting before the one-time nudge fires. */
  afterHours: number;
  /**
   * Staff the nudge never NAMES — away, on leave, whatever the reason staff should not be pinged
   * over a board they cannot open. Excusal is about the reminder only: their read receipts still
   * record, the board still shows them the notice when they return, and every nudge's audit row
   * lists who it left out so an absent name has a receipt. Stands until removed — the list is on
   * the same screen that turns the nudge on, where it cannot be forgotten invisibly.
   */
  excusedUserIds: string[];
}
export const ANNOUNCEMENT_NUDGE_DEFAULTS: AnnouncementNudgeConfig = { enabled: false, channelId: "", afterHours: 48, excusedUserIds: [] };
/** One staff member's read receipt for one notice. `readAt` is stamped the first time the board
 *  renders the posted notice for them (never overwritten); `acknowledgedAt` is the explicit
 *  "✓ Acknowledge" click — the stronger signal for policy changes. */
export interface AnnouncementReadRow {
  announcementId: string;
  userId: string;
  readAt: string;
  acknowledgedAt: string | null;
}

/** A reusable message/reason preset staff can pick instead of typing. `kind` picks where it appears:
 *  "reason" (kick/ban/punish reasons), "message" (in-game player messages), "broadcast". */
export interface MessageTemplateRow {
  id: string;
  kind: string;
  /** short label for the picker chip; falls back to the body when blank. */
  title: string;
  body: string;
  sortOrder: number;
  updatedAt: string;
}
export interface NewMessageTemplate { kind: string; title?: string; body: string; sortOrder?: number }
export type MessageTemplatePatch = Partial<Pick<MessageTemplateRow, "kind" | "title" | "body" | "sortOrder">>;
export const MESSAGE_TEMPLATE_KINDS = ["reason", "message", "broadcast"] as const;

/** One duration button on the Edit VIP popup. The buttons are a CALCULATOR: each click ADDS the
 *  preset's days+hours to the running total (1 day ×2 + 1 week ×2 = 2 weeks 2 days), applied on
 *  confirm. `kind` picks which tab the button sits on: "add" (granting VIP) or "pause" (a VIP
 *  timeout). The list itself is community-editable under Administration → VIP presets. */
export interface VipPresetRow {
  id: string;
  kind: "add" | "pause";
  label: string;
  days: number;
  hours: number;
  sortOrder: number;
}
export interface NewVipPreset { kind: "add" | "pause"; label: string; days: number; hours: number; sortOrder?: number }
export type VipPresetPatch = Partial<Pick<VipPresetRow, "label" | "days" | "hours" | "sortOrder">>;

/** A slow, resumable pull of an existing CRCON instance's stored data into our durable snapshot
 *  archive. The expensive network extract happens once; the archive is re-uploadable and the
 *  transform into our own systems runs against it offline, as many times as needed. */
export type CrconImportJobStatus = "running" | "paused" | "done" | "error";
export interface CrconImportJobRow {
  id: string;
  serverId: string;
  baseUrl: string;
  status: CrconImportJobStatus;
  /** per-data-type progress cursors (page numbers, last entity id, done flags) — drives resume. */
  cursor: Record<string, unknown>;
  /** rolling per-data-type counts of records archived. */
  counts: Record<string, number>;
  /** non-fatal problems encountered per data type (kept so a partial pull is legible). */
  errors: string[];
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
/** `apiKey` is persisted so the worker can resume across restarts, but it never rides on
 *  CrconImportJobRow — it's read only via crconSnapshot.getJobApiKey so it can't leak through the API. */
export interface NewCrconImportJob { serverId: string; baseUrl: string; apiKey: string; createdByUserId?: string | null; createdByName: string }
export interface CrconImportJobPatch { status?: CrconImportJobStatus; cursor?: Record<string, unknown>; counts?: Record<string, number>; errors?: string[]; baseUrl?: string; apiKey?: string }

/** One record in the archive file: a raw CRCON payload tagged with its data type + dedupe key.
 *  The archive lives as an NDJSON file on the host (one of these per line), never in the DB. */
export interface CrconArchiveRecord { dataType: string; entityKey: string; raw: unknown }

export interface NewAnnouncement {
  title: string;
  body: string;
  published?: boolean;
  authorUserId?: string | null;
}

export interface AnnouncementPatch {
  title?: string;
  body?: string;
  published?: boolean;
}

/** An immutable record of a staff (or system/auto) action — the backbone of staff analytics,
 *  the moderation trail, and search. `actorUserId` is null for system/auto actions. */
export interface AuditRow {
  id: string;
  ts: string;
  actorUserId: string | null;
  actorName: string; // denormalized for display + search ("system", "enforcer", or a username)
  action: string; // dotted verb, e.g. "player.kick", "note.create", "user.create"
  targetType: string | null; // "player" | "server" | "user" | "rule" | …
  targetId: string | null;
  targetName: string | null;
  serverId: string | null;
  summary: string; // human-readable one-liner
  data: Record<string, unknown> | null;
  /**
   * The APP did this, not a person — decided when the row is written, because it stops being
   * answerable later: deleting an account nulls actor_user_id, and inferring "automated" from
   * that would turn a departed admin's history into machinery.
   */
  automated: boolean;
}

export interface NewAudit {
  actorUserId?: string | null;
  actorName: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  serverId?: string | null;
  summary: string;
  data?: Record<string, unknown> | null;
}

/** Filters for searching the audit trail. All are optional and AND together. */
/** What the game log is asking for. Every field is optional; together they are one WHERE clause. */
/** A window of one server's event stream for a fold (EventsRepo.window). */
export interface EventWindowQuery {
  serverId: string;
  kinds?: string[];
  /** Inclusive lower / exclusive upper time bound, as EventQuery's. */
  from?: string;
  to?: string;
  /** At most this many: the newest of the window when it holds more. */
  limit: number;
}

export interface EventQuery {
  serverId: string;
  /** full evt.* kinds — a category is a set of them. */
  kinds?: string[];
  /** free text over actor name, victim name, and the chat/admin message body. */
  q?: string;
  /** our internal player uuid: their events as either actor or victim. */
  playerId?: string;
  /** Inclusive lower / exclusive upper time bound. Both optional — the game log wants the whole
   *  history, an analytics read wants one window, and the same filter serves both. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** The window every analytics read is asked about. `serverId` absent = across all servers. */
/**
 * How a server's PLAY changed over the window, from the game's own score buckets rather than the
 * kill log. Kills answer "was it busy"; these answer "what kind of game is being played here" —
 * whether points are held, garrisons built, supply driven, squads led. The roster sampler has been
 * recording it all along.
 */
export interface ScoreTrends {
  daily: {
    date: string;
    rounds: number;
    players: number;
    combat: number;
    offense: number;
    defense: number;
    support: number;
    slSeconds: number;
    vehicleKills: number;
  }[];
  totals: {
    rounds: number;
    players: number;
    combat: number;
    offense: number;
    defense: number;
    support: number;
    slSeconds: number;
    vehicleKills: number;
    /** Share of participants who led a squad at all — the number the no-leader automod exists for. */
    ledShare: number | null;
  };
}

export interface AnalyticsWindow {
  serverId?: string;
  from: string;
  to: string;
  /**
   * IANA zone the hour/day buckets are taken in. Defaults to UTC, which is what these queries did
   * unconditionally — and for a community that is not on UTC that put a Saturday-evening peak on
   * Sunday morning. The API validates the caller's zone before it reaches here; an unusable one
   * would make Postgres raise rather than quietly answer about a different week.
   */
  tz?: string;
}

export interface SessionActivity {
  /** Sessions started in each hour of the day, index 0–23, in the window's zone. */
  byHour: number[];
  /** Sessions started on each day of the week, index 0=Sunday. */
  byDow: number[];
  /** The crossing of the two: [day 0=Sunday][hour 0–23]. Real counts, not the outer product of the
   *  margins — the source grouping is already (hour, dow), so this costs nothing extra. */
  weekHour: number[][];
  /** Per calendar day (UTC): sessions started, distinct players, and total player-seconds. */
  daily: { date: string; sessions: number; players: number; seconds: number }[];
  sessions: number;
  uniquePlayers: number;
  totalSeconds: number;
  /** Median and 90th-percentile session length, in seconds — the shape a mean would hide. */
  medianSec: number;
  p90Sec: number;
  /**
   * Sessions that ended almost immediately. Someone who joins, looks at what is running, and quits
   * is casting a vote no other number on the page captures — a map can hold a healthy win rate
   * while quietly emptying the server.
   */
  shortSessions: number;
  /** The threshold `shortSessions` used, in seconds, so the panel never has to assume one. */
  shortCutoffSec: number;
  /** Sessions and early leaves attributed to the map that was running when the player CONNECTED. */
  earlyLeaversByMap: { map: string; sessions: number; short: number }[];
}

/**
 * How far apart to sample occupancy, for a window of `n` days.
 *
 * Finer on a short window (where you are looking at one evening) and coarser on a long one (where
 * you are looking at a season, and 8,760 hourly samples is already more resolution than the chart
 * can draw). Shared by both stores so they cannot disagree about what a sample is — the panel
 * cannot tell which store answered, and a different grid would give a different answer.
 */
export function occupancySampleSec(days: number): number {
  if (days <= 2) return 300;      // 5 min
  if (days <= 7) return 900;      // 15 min
  if (days <= 31) return 1800;    // 30 min
  return 3600;                    // 1 hour
}

/** Every sample instant in a window, as epoch milliseconds, aligned to the epoch so both stores
 *  land on exactly the same instants. */
export function occupancySamples(fromIso: string, toIso: string, stepSec: number): number[] {
  const from = Date.parse(fromIso), to = Date.parse(toIso);
  const step = stepSec * 1000;
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t < to; t += step) out.push(t);
  return out;
}

/**
 * Turn "how many were online at each sample instant" into the two shapes the page draws.
 *
 * Lives here, shared, because it walks the FULL sample grid — including the instants nobody was on
 * — so an empty hour is a real zero rather than a missing cell, and a dead Tuesday still appears in
 * the trend. Both stores hand it the same map and get the same answer; a divergence here would be
 * a bug that only shows up on whichever store production happens to run.
 *
 * `tz` is the reader's zone, and it is the whole point of the week grid. "When are we busy" is a
 * question about local evenings; answered in UTC it is not slightly off, it is answered about a
 * different week — a US-Central community's Saturday-evening peak lands on the Sunday row, which
 * is where cover gets scheduled from. Session activity was moved onto the caller's zone; this
 * builder draws the busiest chart on the same page and was still bucketing in UTC, so the two
 * heatmaps sitting side by side disagreed with each other.
 */
export function foldOccupancy(
  window: { from: string; to: string },
  stepSec: number,
  countAt: Map<number, number>,
  tz = "UTC",
): Pick<Concurrency, "weekHour" | "daily" | "dayHour"> {
  const weekSum = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const weekN = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const perDay = new Map<string, { peak: number; sum: number; n: number }>();
  const perDayHour = new Map<string, { sum: number[]; n: number[] }>();

  for (const t of occupancySamples(window.from, window.to, stepSec)) {
    const c = countAt.get(t) ?? 0;
    const p = zonedParts(new Date(t), tz);
    const dow = WEEKDAY_ORDER.indexOf(p.weekday), h = Math.floor(p.minutes / 60);
    weekSum[dow]![h] = (weekSum[dow]![h] ?? 0) + c;
    weekN[dow]![h] = (weekN[dow]![h] ?? 0) + 1;
    const key = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const day = perDay.get(key) ?? { peak: 0, sum: 0, n: 0 };
    day.peak = Math.max(day.peak, c);
    day.sum += c;
    day.n += 1;
    perDay.set(key, day);
    let dh = perDayHour.get(key);
    if (!dh) perDayHour.set(key, (dh = { sum: Array<number>(24).fill(0), n: Array<number>(24).fill(0) }));
    dh.sum[h] = dh.sum[h]! + c;
    dh.n[h] = dh.n[h]! + 1;
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    weekHour: weekSum.map((row, d) => row.map((v, h) => (weekN[d]![h] ? round1(v / weekN[d]![h]!) : 0))),
    daily: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, peak: v.peak, average: v.n ? round1(v.sum / v.n) : 0 })),
    dayHour: [...perDayHour.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, hours: v.sum.map((s, h) => (v.n[h] ? round1(s / v.n[h]!) : null)) })),
  };
}

/**
 * What the When people play grid can show besides players online (the page's own read), each as
 * one figure per local hour. Read on demand, one metric at a time, so picking one costs only its
 * own query and the page's load stays what it was.
 *
 * From the roster samples (one a minute, wherever the app was watching):
 *  - peak: the most players any sample in the hour showed;
 *  - queue: players waiting to get in, the VIP queue included, averaged — recorded from migration
 *    148 on, so older hours have no figure;
 *  - imbalance: the gap in players between the two sides, averaged;
 *  - noLeader: squads with nobody in a squad-leader role, both sides together, averaged;
 *  - unsquadded: players on a side but in no squad, averaged.
 * Counted, wherever the app has a record:
 *  - arrivals: finished visits, by the hour they began — what the page's Arrivals chart counts;
 *  - kills, teamkills, chat, moderation: lines of those kinds in the game log.
 */
export const HOUR_METRICS = ["peak", "queue", "imbalance", "noLeader", "unsquadded", "arrivals", "kills", "teamkills", "chat", "moderation"] as const;
export type HourMetric = (typeof HOUR_METRICS)[number];
export const isHourMetric = (v: unknown): v is HourMetric => typeof v === "string" && (HOUR_METRICS as readonly string[]).includes(v);

/** The game-log kinds each counted metric adds up. Kicks and bans are the game's own lines: from
 *  any admin tool, and the game's idle and team-kill kicks too. */
export const HOUR_METRIC_KINDS: Partial<Record<HourMetric, string[]>> = {
  kills: ["evt.kill"],
  teamkills: ["evt.teamkill"],
  chat: ["evt.chat.team", "evt.chat.squad"],
  moderation: ["evt.player.kicked", "evt.player.banned"],
};

/** One local date's row on a date × hour grid: a figure per hour, null where nothing can say. */
export interface DateHourRow { date: string; hours: (number | null)[] }

/** An hour's average to one decimal, worked out HERE from integer sums and counts, so the two
 *  stores round the same numbers the same way instead of each trusting its own arithmetic. */
export const hourAverage = (sum: number, n: number): number => Math.round((sum / n) * 10) / 10;

/** The cell an instant falls in: its LOCAL date and hour, "2026-10-14|21". Postgres builds the
 *  same key from `AT TIME ZONE`. */
export function localHourKey(at: string | Date, tz: string): string {
  const p = zonedParts(typeof at === "string" ? new Date(at) : at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}|${Math.floor(p.minutes / 60)}`;
}

/**
 * Lay an hour metric's cells over every local date the window touches, oldest first: the shape
 * the page's date grid draws.
 *
 * A cell with a figure shows it. A cell without one is a ZERO only where the app was watching
 * (`watched`: the hours it took a roster sample in) — no kills in an hour it sampled an empty
 * server is a real nought. Anywhere else it is null and gets no square: an hour from before the
 * app watched, or while it was down, has no record to be zero about. The roster metrics pass no
 * `watched`: their cells exist exactly where the samples do.
 */
export function foldHourGrid(window: { from: string; to: string }, tz: string, cells: Map<string, number>, watched?: Set<string>): DateHourRow[] {
  const dateOf = (ms: number) => localHourKey(new Date(ms), tz).split("|")[0]!;
  const first = dateOf(Date.parse(window.from));
  const last = dateOf(Date.parse(window.to) - 1);
  const rows: DateHourRow[] = [];
  // Calendar arithmetic on the date itself, so no zone or daylight-saving change can skip a day.
  for (let d = first; d <= last; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    rows.push({ date: d, hours: Array.from({ length: 24 }, (_, h) => cells.get(`${d}|${h}`) ?? (watched?.has(`${d}|${h}`) ? 0 : null)) });
  }
  return rows;
}

/**
 * How many players were on the server AT THE SAME TIME.
 *
 * This is the number people mean by "how busy are we", and it is not the same as how many sessions
 * started — a hundred people who each join for ten minutes across an evening is a hundred joins and
 * never more than a handful online at once. Getting it right means overlapping intervals, not
 * counting rows.
 *
 * Two sources, in strict order of trust, all folded from ONE per-instant pass at `sampleSec`.
 * Where the worker MEASURED the roster (a snapshot a minute), the measurement is the figure —
 * grid cells, peak and mean alike — because session history can lie in ways no filter fully
 * catches, and the peak prefers the best raw measurement over any bucket. Where nothing was
 * measured (history imported from before the app watched the server), the figures are INFERRED
 * from session rows sampled on the same grid — clamped, when scoped to one server, to the game's
 * 100 slots (GAME_SLOT_CAP), a physical bound no reconstruction may exceed. A spike shorter than
 * the sample interval can be missed in inferred-only eras; the exhaustive sweep that could not
 * miss it re-read every imported session row on every page load, which is a price a page cannot
 * pay. See blendMeasuredConcurrency.
 */
/**
 * The longest a single session is believed for presence purposes — the same 12-hour torn-data
 * rule the CRCON import applies to connect/disconnect pairs (crcon-transform.ts). The field
 * showed why concurrency needs it too: a backlog of stale open sessions mass-closed at one
 * instant produced ~1,300 multi-week "sessions" all overlapping one band, and the heatmap
 * reported 1,294 players at once on a 100-slot server. A span is counted from its connect for at
 * most this long; whatever a torn record claims beyond that is the artifact, not the player.
 */
export const TORN_SESSION_SEC = 12 * 3600;

/**
 * The longest a stored play session may be: a day from its connect. Nobody plays 24 hours without
 * a break, so a longer pair is a disconnect nobody saw — a session closed only by the player's next
 * connect weeks later, or one CRCON kept open until a disconnect line months on (a live WW2
 * profile showed a 1,584-hour "session", and its playtime with it). Every way a session closes
 * stores it capped here — its end at its connect plus a day — and adds no more than that to
 * playtime. Migration 152 capped the ones stored before it.
 */
export const SESSION_MAX_SEC = 24 * 3600;

/**
 * The most players an HLL-family server can physically hold — both games ship a 100-slot cap.
 * Session-INFERRED concurrency scoped to one server is clamped here; a bigger number is
 * arithmetic (mispaired log rebuilds stacking phantom spans), not people. Measurements are never
 * clamped, and unscoped (fleet-wide) counts are not either.
 */
export const GAME_SLOT_CAP = 100;

/**
 * Blend MEASURED concurrency (per-minute roster snapshots, downsampled to the grid) over the
 * concurrency INFERRED from session rows. A measurement is the ground truth for its bucket —
 * including a measured zero — because session history can lie in ways no filter fully catches
 * (mispaired connects rebuilt into phantom hours; the field saw 267 "at once" on a 100-slot
 * server). Where nothing was measured (history imported from before the app watched the server,
 * worker downtime), the inference stands. With no measurements at all the inputs pass through
 * untouched, so a pure-history window keeps the exact sweep semantics.
 *
 * Shared by both stores for the same reason foldOccupancy is: the panel cannot tell which store
 * answered, so the two must blend identically.
 */
export function blendMeasuredConcurrency(input: {
  from: string; to: string; stepSec: number;
  /** instantMs → players, reconstructed from session spans (distinct players per instant). */
  inferred: Map<number, number>;
  /** instantMs → players, measured (bucket sums of downsampled snapshots). */
  measured: Map<number, number>;
  /** the highest single measurement in the window at full sample resolution, when scoped. */
  measuredMax: { c: number; at: string } | null;
  /**
   * Physical ceiling for the INFERRED values, or null for none. Scoped to one server this is the
   * game's slot count: an inferred concurrency above what the server can hold is arithmetic, not
   * people, whatever the session rows claim. Measurements are never clamped — they were real.
   */
  inferredCap?: number | null;
}): { counts: Map<number, number>; peak: number; peakAt: string | null; average: number } {
  const cap = input.inferredCap ?? null;
  const clamp = (n: number) => (cap !== null && n > cap ? cap : n);
  // Measured buckets FLOOR onto the step lattice, so with an unaligned window start (every live
  // "last 90 days" window) the first bucket can land before the sampling grid's first instant —
  // a key the fold ignores but the mean below would count. Keep only the grid's own instants.
  const stepMs = input.stepSec * 1000;
  const fromMs = Date.parse(input.from), toMs = Date.parse(input.to);
  const gridStart = Math.ceil(fromMs / stepMs) * stepMs;
  const counts = new Map([...input.inferred].map(([t, c]) => [t, clamp(c)] as const));
  for (const [t, c] of input.measured) {
    if (t >= gridStart && t < toMs) counts.set(t, c);
  }
  // Peak: the earliest grid instant carrying the highest merged value — then the best RAW
  // measurement outranks it on a tie or better, because a full-resolution sample beats a bucket.
  // (Peak and mean both derive from this one per-instant fold; the exhaustive sweep over every
  // session row that used to compute them re-read years of imported history on every page load,
  // which is how a 90-day view outlived the proxy's patience.)
  let peak = 0; let peakAt: string | null = null;
  for (const t of [...counts.keys()].sort((a, b) => a - b)) {
    const c = counts.get(t)!;
    if (c > peak) { peak = c; peakAt = new Date(t).toISOString(); }
  }
  if (input.measuredMax && input.measuredMax.c >= peak) {
    peak = input.measuredMax.c;
    peakAt = input.measuredMax.at;
  }
  // Mean over every grid instant in the window, absent instants counting as empty — the sampled
  // equivalent of player-time ÷ window.
  let instants = 0;
  for (let t = gridStart; t < toMs; t += stepMs) instants += 1;
  let sum = 0;
  for (const c of counts.values()) sum += c;
  return { counts, peak, peakAt, average: instants > 0 ? Math.round((sum / instants) * 100) / 100 : 0 };
}

export interface Concurrency {
  /** Most players online simultaneously. Exact. */
  peak: number;
  /** When that happened. Null when nobody played in the window. */
  peakAt: string | null;
  /** Mean players online across the whole window (total player-seconds ÷ window). Exact. */
  average: number;
  /** Average concurrent players in each [day 0=Sunday][hour] cell, from the samples. */
  weekHour: number[][];
  /**
   * The week grid unrolled onto real dates: average concurrent players per LOCAL hour of each
   * LOCAL calendar date, from the same samples. This is what lets "was Saturday's event actually
   * busy" be answered about THAT Saturday instead of the average of every Saturday in the window.
   * `null` marks an hour the window never sampled — the partial days at its edges, or an hour a
   * DST jump skipped — which is "no data", not an empty server, and must be drawn as absent.
   */
  dayHour: { date: string; hours: (number | null)[] }[];
  /** Per calendar day (UTC): the sampled peak and mean. */
  daily: { date: string; peak: number; average: number }[];
  /** Seconds between occupancy samples — stated so a reader knows the resolution. */
  sampleSec: number;
  /** Players with a session still open at the window's end and younger than the torn-session
   *  cap — a row "open" for days is a missed disconnect, not somebody online. */
  openAtEnd: number;
}

/**
 * What one platform adds up to over a window, or over one local day of it. Presence comes from
 * sessions, placed by their connect; performance and score from finished rounds, placed by their
 * start. Sums only: the page derives every ratio (K/D, score per round, the average session, the
 * early-leaver share) from them, so the two stores cannot round differently and a ratio is never
 * an average of ratios.
 */
export interface PlatformSums {
  /** distinct players who had a session. */
  players: number;
  /** of those, players first seen in the window (in the trend: first seen that local day). */
  newPlayers: number;
  sessions: number;
  /** sessions that ended inside the short-session cutoff: the early leavers. */
  shortSessions: number;
  playtimeSec: number;
  /** finished-round participations whose round STARTED in the window, and their sums. */
  rounds: number;
  kills: number;
  deaths: number;
  teamkills: number;
  vehicleKills: number;
  /** of those rounds, the ones the game's score was recorded for (any bucket above zero). A round
   *  imported from a kill log has none, so a score-per-round figure divides by these instead. */
  scoredRounds: number;
  /** the game's own score buckets, summed over those rounds. */
  combat: number;
  offense: number;
  defense: number;
  support: number;
  slSeconds: number;
}

/** A platform with nothing recorded yet — what both stores start each row from. */
export const emptyPlatformSums = (): PlatformSums => ({
  players: 0, newPlayers: 0, sessions: 0, shortSessions: 0, playtimeSec: 0,
  rounds: 0, kills: 0, deaths: 0, teamkills: 0, vehicleKills: 0,
  scoredRounds: 0, combat: 0, offense: 0, defense: 0, support: 0, slSeconds: 0,
});

/**
 * The crossplay split OVER TIME: per platform per local calendar day, the same sums the
 * PlatformBreakdown table carries. Feeds the line chart beside the table, which plots the picked
 * metric as a running total from the window's first day, so every line ends at the table's
 * number. Days with no activity for a platform simply have no row.
 */
export interface PlatformTrend {
  rows: PlatformTrendRow[];
}
export interface PlatformTrendRow extends PlatformSums {
  date: string;
  platform: string;
  /**
   * Players whose FIRST session in the window started this local day. A running count of players
   * cannot add up `players` (a regular would count once per day); added up from the window's first
   * day, these are the distinct players so far, and they end at the breakdown's `players`.
   */
  firstPlayers: number;
  /** Of those, the ones first seen in the window: they end at the breakdown's `newPlayers`. */
  firstNewPlayers: number;
}
/** A platform's day with nothing recorded yet — what both stores start each trend row from. */
export const emptyPlatformTrendRow = (date: string, platform: string): PlatformTrendRow =>
  ({ date, platform, ...emptyPlatformSums(), firstPlayers: 0, firstNewPlayers: 0 });

/**
 * The wire never agreed on one spelling per platform: the official client says steam/epic/
 * winstore, live crossplay servers report unreal enum names (EPlatformFamily::XboxSeries, ::PS5,
 * ::Steam, ::WinGDK, ::EGS). Filters that compare the stored token exactly therefore match one
 * install's data and not another's. These two helpers are the shared truth both stores filter
 * with: a token normalized (lowercased, enum prefix stripped), and a FAMILY id expanded to every
 * normalized token that belongs to it. An unknown family answers null — the caller falls back to
 * treating the input as a literal token, so an odd value can still be filtered for by its exact
 * spelling.
 */
export const normalizePlatformToken = (p: string): string => p.toLowerCase().replace(/^eplatformfamily::/, "");
export function platformFamilyTokens(family: string): string[] | null {
  const FAMILIES: Record<string, string[]> = {
    steam: ["steam"],
    epic: ["epic", "egs"],
    msstore: ["win", "winstore", "wingdk"],
    xbox: ["xbox", "xboxone", "xboxseries", "xsx", "xbl"],
    playstation: ["ps4", "ps5", "psn"],
    unknown: ["unknown", ""],
    other: ["other"],
  };
  return FAMILIES[family.toLowerCase()] ?? null;
}

/**
 * Per-PLATFORM slice of a server's window — the crossplay question. A lobby that mixes PC and
 * console wants to know whether one input method is quietly out-fragging the other; every
 * player row already knows its platform (the live roster reports it), so this is the joins the
 * app never made rather than data it never had. Sums, not averages: the page derives K/D and
 * kills-per-round so the two stores cannot round differently.
 */
export interface PlatformBreakdown {
  rows: ({
    /** the platform as the game reports it ("steam", "epic", "xbox", "ps5", …). */
    platform: string;
  } & PlatformSums)[];
}

/**
 * Server-wide combat, aggregated in the database.
 *
 * Weapons stay RAW here: which weapon belongs to which class is game knowledge that lives in the
 * game descriptor, so the store counts strings and the API buckets them. That keeps a new game's
 * weapon list out of the SQL entirely.
 */
export interface CombatActivity {
  totals: { kills: number; teamkills: number; killers: number; victims: number };
  /** Every weapon that got a kill or a team kill in the window, most-used first. */
  byWeapon: { weapon: string; kills: number; teamkills: number }[];
  daily: { date: string; kills: number; teamkills: number }[];
  /** Kills by [day 0=Sunday][hour] — the same shape every other heatmap on the analytics pages uses. */
  weekHour: number[][];
  byHour: number[];
  topKillers: { playerId: string; name: string; kills: number }[];
  /** Ranked by team kills, which is the list that actually gets acted on. */
  topTeamkillers: { playerId: string; name: string; teamkills: number; kills: number }[];
  /** Kills and team kills attributed to the round they happened in, grouped by map. */
  byMap: { map: string; kills: number; teamkills: number }[];
}

/**
 * One periodic sample of a server's shape, as the worker writes it.
 *
 * `composition` is a `RosterSummary` from @app/games — sides, roles, squads and which squads had
 * nobody leading them. It is stored as JSON because its keys are the GAME's (side ids, role
 * numbers), and columns for them would bake one game's factions into the schema.
 */
export interface RosterSnapshotInput {
  serverId: string;
  ts: string;
  playerCount: number;
  composition: RosterSnapshotComposition;
  mapName?: string | null;
  gameMode?: string | null;
  /**
   * The score at the moment of the sample. Together the samples of one round ARE a score
   * timeline — CRCON's `cap_flips`. Null when the session read did not carry a score (and on every
   * row written before migration 042), which is a different fact from nil-nil.
   */
  alliedScore?: number | null;
  axisScore?: number | null;
  /**
   * Players waiting to get in at the moment of the sample: the general queue, and the VIP queue
   * where the server's counter can be believed (the game sometimes puts the size of its VIP LIST
   * in that field — see vipQueueDepth). Null when the read had no queue, and on every sample taken
   * before migration 148: the queue was not recorded until then, so an old sample's queue is
   * unknown rather than empty.
   */
  queueCount?: number | null;
  vipQueueCount?: number | null;
}

/**
 * A count the store keeps as an integer column, or null. Postgres refuses a fraction for an
 * integer, and that refusal would cost the WHOLE sample — composition and score with it — over a
 * queue figure nobody could explain anyway. Both stores keep the same nothing in its place.
 */
export const wholeOrNull = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isInteger(n) ? n : null);

/** The stored shape of one sample's composition. Structurally a `RosterSummary`, restated here so
 *  @app/db does not depend on the game registry to describe its own rows. */
export interface RosterSnapshotComposition {
  players?: number;
  unassigned?: number;
  byRole?: Record<string | number, number>;
  bySide?: Record<string, {
    players?: number;
    squads?: number;
    unsquadded?: number;
    noSlSquads?: string[];
    byRole?: Record<string | number, number>;
  }>;
}

export interface RosterSnapshotRow extends RosterSnapshotInput {
  id: string;
  /**
   * The game this sample was taken on — stamped at write time, not inferred later.
   *
   * `composition` counts RAW ROLE NUMBERS, and a number means different things in different
   * games (13 is Commander in HLL and Mortar Support in Vietnam). Without this, a server that
   * changed games had its old samples relabelled into a vocabulary they were never counted in.
   * Null only on rows written before the column existed.
   */
  game: string | null;
}

/**
 * What a server LOOKED LIKE over a window: the side split, the role mix, and how often squads went
 * without a leader.
 *
 * Every number here is an average over samples, and `samples`/`sampleSec` are returned so the page
 * can say so. Shares are ratios of sums (total players in a role ÷ total players seen), not means
 * of per-sample ratios: that weights by population, which is the question people are actually
 * asking — "what fraction of the playing that happened was medics", not "what was the mix on a
 * typical near-empty sample".
 *
 * With no server filter the unit is a SERVER-sample, not an instant: two servers' snapshots land at
 * different moments, so adding them together would be summing numbers from different times. Every
 * ratio here stays correct across servers; `avgPlayers` and `peakPlayers` read as "per server".
 */
export interface RosterComposition {
  /** Samples the window covers after downsampling — the denominator behind every average here. */
  samples: number;
  /** Seconds between the samples used, so the page states its own resolution. */
  sampleSec: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Mean players per sample across the whole window, empty samples included. Null with no data. */
  avgPlayers: number | null;
  /** Highest player count in any sample. Null with no data. */
  peakPlayers: number | null;
  /** Per side: mean players per sample, and share of all player-samples (0–1). */
  bySide: { sideId: string; avgPlayers: number; share: number }[];
  /** Per role: mean players per sample, and share of all player-samples. Biggest share first. */
  byRole: { role: number; avgPlayers: number; share: number }[];
  /**
   * Leaderless squads. Conditioned on samples that HAD at least one squad — a sample of an empty
   * server cannot have a leaderless squad, and counting it would deflate the rate toward zero the
   * more the server sat idle. `squadSamples` is that denominator, stated rather than implied.
   */
  noSl: { squadSamples: number; avgSquads: number; sampleShare: number } | null;
  /** Per calendar day (UTC). `roleShare` is keyed by role id and sums to ~1 on a populated day. */
  daily: { date: string; samples: number; avgPlayers: number; noSlAvg: number; roleShare: Record<number, number> }[];
  /** Per map, most-sampled first — how much it ran and what it looked like while it did. */
  byMap: { map: string; samples: number; avgPlayers: number; noSlAvg: number }[];
}

/**
 * Fold sampled snapshots into the composition shape.
 *
 * Shared by both stores for the same reason `foldOccupancy` is: the panel cannot tell which store
 * answered, so a difference here would be a bug that only appears on whichever one production runs.
 * The stores' only job is to hand over one row per bucket, in time order.
 */
export function foldComposition(rows: RosterSnapshotRow[], sampleSec: number): RosterComposition {
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const n = rows.length;
  if (n === 0) {
    return { samples: 0, sampleSec, firstAt: null, lastAt: null, avgPlayers: null, peakPlayers: null,
      bySide: [], byRole: [], noSl: null, daily: [], byMap: [] };
  }

  let totalPlayers = 0;
  let peak = 0;
  const sideTotals = new Map<string, number>();
  const roleTotals = new Map<number, number>();
  // No-SL is conditioned on samples that had squads at all — see the field's note.
  let squadSamples = 0, noSlSquadTotal = 0, samplesWithNoSl = 0;
  const perDay = new Map<string, { samples: number; players: number; noSl: number; roles: Map<number, number>; rolePlayers: number }>();
  const perMap = new Map<string, { samples: number; players: number; noSl: number }>();

  for (const r of rows) {
    const c = r.composition ?? {};
    totalPlayers += r.playerCount;
    peak = Math.max(peak, r.playerCount);

    let squads = 0, noSl = 0;
    for (const [sideId, side] of Object.entries(c.bySide ?? {})) {
      sideTotals.set(sideId, (sideTotals.get(sideId) ?? 0) + (side?.players ?? 0));
      squads += side?.squads ?? 0;
      noSl += side?.noSlSquads?.length ?? 0;
    }
    if (squads > 0) {
      squadSamples += 1;
      noSlSquadTotal += noSl;
      if (noSl > 0) samplesWithNoSl += 1;
    }

    let rolePlayers = 0;
    const sampleRoles = new Map<number, number>();
    for (const [role, count] of Object.entries(c.byRole ?? {})) {
      const id = Number(role);
      if (!Number.isFinite(id)) continue;
      roleTotals.set(id, (roleTotals.get(id) ?? 0) + count);
      sampleRoles.set(id, count);
      rolePlayers += count;
    }

    const date = r.ts.slice(0, 10);
    const day = perDay.get(date) ?? { samples: 0, players: 0, noSl: 0, roles: new Map<number, number>(), rolePlayers: 0 };
    day.samples += 1; day.players += r.playerCount; day.noSl += noSl; day.rolePlayers += rolePlayers;
    for (const [id, count] of sampleRoles) day.roles.set(id, (day.roles.get(id) ?? 0) + count);
    perDay.set(date, day);

    const map = (r.mapName ?? "").trim();
    if (map) {
      const m = perMap.get(map) ?? { samples: 0, players: 0, noSl: 0 };
      m.samples += 1; m.players += r.playerCount; m.noSl += noSl;
      perMap.set(map, m);
    }
  }

  // Shares divide by the total player-samples actually attributed, so they sum to 1 even when some
  // players were unassigned (mid-switch) and therefore belong to no side.
  const sideAttributed = [...sideTotals.values()].reduce((a, b) => a + b, 0);
  const roleAttributed = [...roleTotals.values()].reduce((a, b) => a + b, 0);

  return {
    samples: n,
    sampleSec,
    firstAt: rows[0]!.ts,
    lastAt: rows[n - 1]!.ts,
    avgPlayers: round1(totalPlayers / n),
    peakPlayers: peak,
    bySide: [...sideTotals.entries()]
      .map(([sideId, total]) => ({ sideId, avgPlayers: round1(total / n), share: sideAttributed ? round3(total / sideAttributed) : 0 }))
      .sort((a, b) => b.share - a.share || a.sideId.localeCompare(b.sideId)),
    byRole: [...roleTotals.entries()]
      .map(([role, total]) => ({ role, avgPlayers: round1(total / n), share: roleAttributed ? round3(total / roleAttributed) : 0 }))
      .sort((a, b) => b.share - a.share || a.role - b.role),
    noSl: squadSamples === 0 ? null : {
      squadSamples,
      avgSquads: round1(noSlSquadTotal / squadSamples),
      sampleShare: round3(samplesWithNoSl / squadSamples),
    },
    daily: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({
      date,
      samples: v.samples,
      avgPlayers: round1(v.players / v.samples),
      noSlAvg: round1(v.noSl / v.samples),
      roleShare: Object.fromEntries([...v.roles.entries()]
        .map(([id, count]) => [id, v.rolePlayers ? round3(count / v.rolePlayers) : 0])),
    })),
    byMap: [...perMap.entries()]
      .map(([map, v]) => ({ map, samples: v.samples, avgPlayers: round1(v.players / v.samples), noSlAvg: round1(v.noSl / v.samples) }))
      .sort((a, b) => b.samples - a.samples || a.map.localeCompare(b.map)),
  };
}

export interface PlayerMix {
  /** First ever seen inside the window. */
  newPlayers: number;
  /** Active in the window, but known before it. */
  returningPlayers: number;
  /** Of the window's newcomers, how many were still being seen more than a day later. */
  newPlayersWhoCameBack: number;
}

export interface AuditQuery {
  actorUserId?: string;
  action?: string;
  /** Match any of these actions — for asking a question like "everything VIP" in one query. */
  actions?: string[];
  targetId?: string;
  serverId?: string;
  /**
   * Restrict to actions taken on these servers. A list rather than an id for the same reason the
   * leaderboard takes one: a viewer scoped to two of five servers must see exactly those two.
   *
   * Entries with no server (account edits, template changes — things done to the community rather
   * than to a game server) are EXCLUDED by a scoped read, because they did not happen on any of
   * the named servers. An unscoped read still sees everything. See `includeUnscoped` for the case
   * where the list is a VIEW filter rather than a permission boundary.
   */
  serverIds?: string[];
  /**
   * Keep community-wide entries (server_id IS NULL) in a `serverIds` read.
   *
   * `serverIds` carries two different meanings that look identical here: "these are the only
   * servers you are ALLOWED to see", and "these are the servers I chose to LOOK at". Excluding
   * unscoped rows is right for the first and badly wrong for the second — a reader who picks one
   * server is not asking us to delete player groups, templates, notes and account changes from the
   * staff record, but that is exactly what happened, and it made whole categories of staff action
   * look like they were never recorded at all.
   *
   * Callers set this when the reader can see every server anyway, so narrowing is presentation and
   * nothing is being withheld. A reader whose grants genuinely restrict them never sets it.
   */
  includeUnscoped?: boolean;
  /**
   * Keep only human actions, or only the app's own.
   *
   * Reads the `automated` flag stored at write time, NOT `actor_user_id` — that goes null when an
   * account is deleted, which would reclassify a departed admin's work as machinery.
   *
   * This has to be a QUERY filter rather than something the caller does to the rows it got back.
   * Automation outnumbers humans hundreds to one, so a page of "the most recent N entries" is, at
   * any real volume, entirely automation — and a caller that then filters for humans in memory is
   * left holding nothing, from a table that has lost no rows at all. Staff analytics did exactly
   * that and read as zero for a whole team the day the crash-VIP rule was switched on.
   */
  actor?: "human" | "auto";
  /** free-text search across actor name, action, summary, and target name. */
  q?: string;
  /** Match actions by PREFIX ("enforcer." = every enforcer verb) — how the automation history
   *  asks for whole families without enumerating verbs that grow. */
  actionPrefixes?: string[];
  /** Keep only rows whose data carries this ruleId — the per-rule firing history. */
  dataRuleId?: string;
  /** Keep only rows whose data carries a (non-null) `expiration` — the reward rows that actually
   *  moved a VIP. A regular player collects a game.reward row every match, nearly all of them
   *  points-only; a VIP timeline or scan that read them all spent its whole page on noise. */
  dataExpirationSet?: boolean;
  /** Time order; default "desc" (newest first), unchanged for existing callers. */
  order?: "asc" | "desc";
  from?: string; // ISO lower bound (inclusive)
  to?: string; // ISO upper bound (exclusive)
  limit?: number;
  offset?: number;
}

/** Per-staff activity rollup for the analytics view. */
export interface StaffSummaryRow {
  actorUserId: string | null;
  actorName: string;
  count: number;
  lastAt: string;
  byAction: Record<string, number>;
}

/** An auto-moderation rule: when `eventKind` fires (optionally matching `match`, optionally
 *  `threshold` times within `windowSec` by the same player), take `action` on that player. */
export interface RuleRow {
  id: string;
  name: string;
  enabled: boolean;
  /** null = the rule fires on events from EVERY server; a uuid pins it to that server's events. */
  serverId: string | null;
  eventKind: string;
  /** optional regex (source) tested against the event's text (chat message, weapon, names). */
  match: string | null;
  /** fire once the same actor triggers this many matches within windowSec (1 = first match).
   *  For the synthetic "app.idle" kind, windowSec is instead the no-kills timeframe. */
  threshold: number;
  windowSec: number;
  /** message | kick | punish | tempban | permaban | blacklist | vip */
  action: string;
  reason: string | null;
  hours: number | null;
  /** seconds to wait between the event and the action (0 = immediately). While waiting, presence
   *  is re-checked: message/punish/kick need the player still on the server, vip still gone. */
  delaySec: number;
  /** the "vip" action's duration — a disconnect's temporary VIP so a crash doesn't cost the queue. */
  vipMinutes: number;
  /** how long after one crash VIP this rule refuses the same player another (0 = no limit). The
   *  grant is never additive, so this bounds FREQUENCY: without it, disconnecting just before each
   *  grant expires rolls the expiry forward forever — a permanent queue skip, farmed. */
  vipCooldownMinutes: number;
  /** only fire for players linked to a community-Discord member holding one of these roles
   *  (empty = everyone) — the same gate shape as the VIP panel's buttons. */
  requireRoleIds: string[];
  /**
   * NEVER fire for players carrying one of these tags. The inverse of requireRoleIds, and the
   * gate the other three enforcement systems have always had (seeding and the rule modules both
   * carry immuneLevel + immuneTags): without it, the one surface that can tempban, permaban and
   * run an escalation ladder was also the only one that could not be told to leave your own
   * staff alone.
   *
   * No immuneLevel counterpart on purpose: a player's LEVEL is only on the live roster, and the
   * enforcer acts from bus events — it would have to open an RCON connection per firing to read
   * a number that protects new players from the seeding rules, which is not what this gate is
   * for. Tags and Discord roles are both answerable from what we already hold.
   */
  immuneTags: string[];
  /** …and never fire for players linked to a community-Discord member holding one of these roles.
   *  Resolved through the same cached lookup as requireRoleIds, so it costs no extra call. */
  immuneRoleIds: string[];
  /**
   * …and never fire for players at or below this level (0 = off). The gate seeding and the rule
   * modules have always had, and the one rules could not offer until players started remembering
   * their level: a brand-new player mis-hitting a teammate is a different event from a veteran
   * doing it, and a community that wants to be gentle with newcomers can now say so once.
   *
   * A player whose level was never seen is NOT exempt — an unknown is not a low number.
   */
  immuneLevel: number;
  /**
   * Trial this ONE rule: record what it would have done and touch nobody, while every other rule
   * on the server keeps enforcing. Observe mode and the server's automation switch already force
   * this for every rule at once; that is the wrong grain for "watch the new rule for an evening
   * before letting it act", which is what the other three automations' own dry-run toggles are
   * for and what this brings to rules.
   */
  dryRun: boolean;
  /**
   * Follow-up actions for REPEAT firings on the same player: the rule's own `action` is the first
   * offence, these are the second, third, … (the last repeats). Empty = every firing uses
   * `action`, exactly as before. This is what lets one rule say "message, then punish, then kick"
   * instead of somebody maintaining three rules with staggered thresholds.
   */
  escalateActions: string[];
  /** minutes after the LAST firing before a player's offence count resets (0 = only on restart). */
  escalateResetMinutes: number;
  /**
   * Ping Discord when THIS rule fires (subject to the server's "Rule fired" alert being set up at
   * all — this is the per-rule half of that switch, not a second one).
   *
   * Per rule because "tell me about the automod" is not one appetite: a temp-ban rule firing twice
   * a week is worth a mention, and the idle-kick rule firing forty times a night is what makes
   * somebody mute the channel — taking the temp bans with it. Defaults to true, and the migration
   * backfills true, so nothing goes quiet without somebody deciding it should.
   */
  alertEnabled: boolean;
  /**
   * Where THIS rule's Discord ping goes, overriding the server's "Player rules firing" channel.
   * null = the shared channel, as before. Per rule because one channel for every rule is exactly
   * what made staff mute it: admin-cam rules belong where the admins talk, ban rules where the
   * moderation lives. A rule with its own channel pings even when the shared alert is off — the
   * channel on the rule IS the ask.
   */
  alertChannelId: string | null;
  /**
   * Trigger-specific knobs for the state and weapon triggers (tank roles, minimum crew, weapon
   * lists, name patterns…), null for kinds that take none. Shape is owned by @app/rules —
   * validated there at save time, resolved over the trigger's defaults at read time.
   */
  params: Record<string, unknown> | null;
  /**
   * When this rule is allowed to fire — a wall-clock window evaluated by @app/schedule's
   * isWindowActive, same brain as the auto-settings profiles. null = always active. The window
   * gates the FIRING (and the worker's state detection); it never disables the rule, so the
   * editor shows it armed with its hours beside it rather than mysteriously off.
   */
  activeHours: RuleActiveHours | null;
  /**
   * Population bounds, pairing with activeHours: the rule fires only while the server holds at
   * least playersMin and (when playersMax > 0) at most playersMax players. 0 = unbounded on that
   * side. State rules judge the live roster count in the worker; event rules judge the latest
   * roster snapshot in the enforcer (an unknown count holds fire, never guesses).
   */
  playersMin: number;
  playersMax: number;
  /**
   * The safety valve: if this rule ACTS (for real — dry-runs and notes don't count) on more than
   * this many distinct players inside a minute, it disables itself, audits why, and pings its
   * alert channel. A mistyped weapon list or a too-high minimum level is the difference between
   * moderating and kicking half the server. 0 = no limit; default 10.
   */
  breakerLimit: number;
  /**
   * Minutes into the current match the rule is live for: at least `matchMinutesMin` (0 = from the
   * start) and under `matchMinutesMax` (0 = to the end). "Only in the first 10 minutes", "not
   * before 5 minutes in". A server whose match start is unknown holds fire on a rule that set
   * either bound — the same "unknown is not permission" rule the population gate follows.
   */
  matchMinutesMin: number;
  matchMinutesMax: number;
  /** Count the threshold across the current MATCH ("3 team kills in one match") instead of within
   *  windowSec. An unknown match start falls back to the last RULE_MATCH_FALLBACK_MINUTES. */
  countPerMatch: boolean;
  /** Only fire for players carrying one of these profile tags (empty = anyone) — the positive
   *  twin of immuneTags. An unreadable tag list holds fire. */
  requireTags: string[];
  /** At most this many firings per player per `capPeriod` (0 = no cap). Counted from the rule's
   *  own firings in the audit trail, so a restart does not reset anyone's allowance; a trial-run
   *  rule counts its trial firings. */
  capCount: number;
  capPeriod: RuleCapPeriod;
  /** The tag an "add a tag" step (first action or ladder rung) puts on the player; null when the
   *  rule has no such step. */
  actionTag: string | null;
  /** Community points a "grant points" rule pays per firing (0 when the rule does not pay). */
  points: number;
  /** The Rules page section this rule is filed under (null = none, "Other rules"). Filing alone
   *  never changes what the rule does; the section's master switch does (see sectionOff). */
  sectionId: string | null;
  /** Read, never written: the rule is filed under a section whose master switch is off, so it
   *  holds fire whatever its own `enabled` says. Judge a rule with ruleSwitchedOn, not `enabled`. */
  sectionOff: boolean;
  /** Paused until this instant (null = not paused): it holds fire until then and switches itself
   *  back on after, without anything being written — a lapsed pause is simply in the past. Set
   *  with enforcerRules.setPause; an edit never touches it. Judge a rule with ruleLive. */
  pausedUntil: string | null;
  /** Why, and who — the rule card says both, so nobody has to ask. */
  pauseReason: string | null;
  pausedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Whether a rule is switched on: its own switch AND its section's master switch. `enabled` alone
 * is the rule's own switch, kept untouched while its section is off so that switching the section
 * back on brings back exactly the rules that were on — every place that decides whether a rule
 * acts asks this instead.
 */
export function ruleSwitchedOn(rule: Pick<RuleRow, "enabled" | "sectionOff">): boolean {
  return rule.enabled && !rule.sectionOff;
}

/** The longest pause: a year. Past that, a rule is switched off, not paused. */
export const RULE_PAUSE_MAX_MINUTES = 365 * 24 * 60;

/** Paused at `nowMs`: a pause whose end is still ahead. */
export function rulePaused(rule: Pick<RuleRow, "pausedUntil">, nowMs: number = Date.now()): boolean {
  return rule.pausedUntil !== null && Date.parse(rule.pausedUntil) > nowMs;
}

/**
 * Whether a rule acts at `nowMs`: switched on (ruleSwitchedOn) and not paused. Everything that
 * decides whether a rule fires asks this. A check about what a rule COULD do — the keys a group
 * change needs — asks ruleSwitchedOn instead: a pause lifts itself.
 */
export function ruleLive(rule: Pick<RuleRow, "enabled" | "sectionOff" | "pausedUntil">, nowMs: number = Date.now()): boolean {
  return ruleSwitchedOn(rule) && !rulePaused(rule, nowMs);
}

/** What version history covers: rules, and the map vote's map sets and schedules. */
export type ConfigVersionKind = "rule" | "mapSet" | "voteSchedule";
export const CONFIG_VERSION_KINDS: readonly ConfigVersionKind[] = ["rule", "mapSet", "voteSchedule"];
/** Saves kept per record — the oldest go first. */
export const CONFIG_VERSIONS_KEPT = 50;
/**
 * One save of a record staff edit by hand, as it stood before and after — so any save can be
 * undone by putting its `before` back (which is itself a save, so the undo can be undone).
 * `before` null: the record did not exist (it was brought back); `after` null: it was deleted.
 */
export interface ConfigVersionRow {
  id: string;
  kind: ConfigVersionKind;
  targetId: string;
  /** the record's name when saved — a deleted record has no other name to show. */
  targetName: string | null;
  change: "edit" | "delete" | "restore";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
}
export type NewConfigVersion = Omit<ConfigVersionRow, "id" | "createdAt">;

/** Thrown by ruleSections.create/rename when the name is already another section's. */
export class RuleSectionNameTaken extends Error {
  constructor(name: string) { super(`there is already a section called "${name}"`); this.name = "RuleSectionNameTaken"; }
}

/** A named shelf on the Rules page ("Player level rules"), with a master switch for its rules. */
export interface RuleSectionRow {
  id: string;
  name: string;
  /** The master switch: off holds every rule filed here. Each rule's own switch stays as it was. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One roster rule's latest look at a server's roster: how many players it saw, how many it flagged,
 * how many firings it actually sent (a flagged player inside the re-check interval, or not yet in
 * the player directory, is not sent), why the whole rule held back if it did (`held`), and the
 * trigger's own breakdown of the roster ("hold VIP": 85, "have no VIP": 2…).
 */
export interface RuleCheckSummary {
  roster: number;
  flagged: number;
  sent: number;
  /** flagged but still inside the rule's re-check interval for that player. */
  paced: number;
  /** flagged but not in the player directory yet — sent on a later check. */
  unknownPlayers: number;
  held: string | null;
  breakdown: Record<string, number>;
}
export interface RuleStatusRow {
  ruleId: string;
  serverId: string;
  checkedAt: string | null;
  check: RuleCheckSummary | null;
  skippedAt: string | null;
  skipReason: string | null;
  skipPlayer: string | null;
}

/** The span a rule's per-player cap counts over. Rolling windows: a day is the last 24 hours. */
export type RuleCapPeriod = "match" | "day" | "week" | "month" | "ever";
export const RULE_CAP_PERIODS: readonly RuleCapPeriod[] = ["match", "day", "week", "month", "ever"];
/** When a server's match start is unknown, "this match" means the last this-many minutes. */
export const RULE_MATCH_FALLBACK_MINUTES = 90;

/** A rule's active window: overnight-aware (start > end wraps midnight), optional weekday and
 *  timezone (default UTC). Kept narrower than ScheduleWindow on purpose — months/dates/years on a
 *  moderation rule would be policy nobody can read at a glance. */
export interface RuleActiveHours {
  /** "HH:MM" wall-clock bounds; start > end wraps past midnight. */
  start: string;
  end: string;
  /** active only on these weekdays (absent/empty = every day). */
  daysOfWeek?: string[];
  /** IANA timezone the window is read in (default "UTC"). */
  timezone?: string;
}
export interface NewRule {
  /** Only when bringing a deleted rule back from its history: it returns under its own id, so
   *  its history follows it. Every other create leaves this out and gets a new id. */
  id?: string;
  name: string;
  eventKind: string;
  action: string;
  enabled?: boolean;
  serverId?: string | null;
  match?: string | null;
  threshold?: number;
  windowSec?: number;
  reason?: string | null;
  hours?: number | null;
  delaySec?: number;
  vipMinutes?: number;
  vipCooldownMinutes?: number;
  requireRoleIds?: string[];
  immuneTags?: string[];
  immuneRoleIds?: string[];
  immuneLevel?: number;
  dryRun?: boolean;
  escalateActions?: string[];
  escalateResetMinutes?: number;
  alertEnabled?: boolean;
  alertChannelId?: string | null;
  params?: Record<string, unknown> | null;
  activeHours?: RuleActiveHours | null;
  playersMin?: number;
  playersMax?: number;
  breakerLimit?: number;
  matchMinutesMin?: number;
  matchMinutesMax?: number;
  countPerMatch?: boolean;
  requireTags?: string[];
  capCount?: number;
  capPeriod?: RuleCapPeriod;
  actionTag?: string | null;
  points?: number;
  sectionId?: string | null;
}
export interface RulePatch {
  name?: string;
  enabled?: boolean;
  serverId?: string | null;
  eventKind?: string;
  match?: string | null;
  threshold?: number;
  windowSec?: number;
  action?: string;
  reason?: string | null;
  hours?: number | null;
  delaySec?: number;
  vipMinutes?: number;
  vipCooldownMinutes?: number;
  requireRoleIds?: string[];
  immuneTags?: string[];
  immuneRoleIds?: string[];
  immuneLevel?: number;
  dryRun?: boolean;
  escalateActions?: string[];
  escalateResetMinutes?: number;
  alertEnabled?: boolean;
  alertChannelId?: string | null;
  params?: Record<string, unknown> | null;
  activeHours?: RuleActiveHours | null;
  playersMin?: number;
  playersMax?: number;
  breakerLimit?: number;
  matchMinutesMin?: number;
  matchMinutesMax?: number;
  countPerMatch?: boolean;
  requireTags?: string[];
  capCount?: number;
  capPeriod?: RuleCapPeriod;
  actionTag?: string | null;
  points?: number;
  sectionId?: string | null;
}

/**
 * A VIP grant. The game's native VIP has no expiry, so we own the expiration here (like CRCON):
 * `expiration === null` means permanent; a timestamp means the always-on worker removes the game
 * VIP once it passes. One row per (server, player).
 */
export interface VipRow {
  id: string;
  serverId: string;
  playerId: string;
  playerName: string | null;
  comment: string | null;
  /** null = permanent; otherwise the ISO instant the VIP lapses. */
  expiration: string | null;
  /** VIP timeout (a moderation action): while set and in the future, the VIP is off the game but
   *  the grant survives and keeps accumulating grants. Two modes: 'running' — expiration keeps
   *  ticking (the lost time is the punishment); 'banked' — the meter freezes and the expiration is
   *  pushed out by the pause's real duration on resume/lapse (pausedAt anchors the math; the
   *  expiry sweep skips banked-frozen rows). All null = not paused. */
  pausedUntil: string | null;
  pauseReason: string | null;
  pausedBy: string | null;
  pauseMode: "running" | "banked" | null;
  pausedAt: string | null;
  /** A group perk holding this grant permanent, with the timed balance frozen beneath it — null
   *  when none is. See VipGroupHold. */
  groupHold: VipGroupHold | null;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
/** The pause fields as one unit; null clears them (resume / lapse). Mode defaults to 'running';
 *  the stores stamp pausedAt with now when `at` is omitted. */
export interface VipPause { until: string; reason: string; by: string; mode?: "running" | "banked"; at?: string }
/** One console-admin grant: a player on the GAME SERVER's own admin list (in-game admin powers —
 *  admin camera, console kicks). the panel's row is the book of record, exactly like VIP: granting
 *  writes the game AND this row; the game is never the only place the list lives. No connection to
 *  panel logins whatsoever. */
export interface ConsoleAdminRow {
  id: string;
  serverId: string;
  playerId: string;
  playerName: string | null;
  /** the game-defined admin group they were added under (owner, senior, junior, spectator…). */
  adminGroup: string;
  /** internal staff note — never sent to the game. */
  comment: string | null;
  /** null = permanent; otherwise the ISO instant the grant lapses. The game only knows permanent
   *  admins, so the panel owns the expiry — the worker sweep removes lapsed admins from the game. */
  expiration: string | null;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
export interface NewConsoleAdmin {
  serverId: string;
  playerId: string;
  playerName?: string | null;
  adminGroup: string;
  comment?: string | null;
  expiration?: string | null;
  createdByUserId?: string | null;
  createdByName: string;
}

/** A named set of players (a clan-vs-clan roster, the streamers, an event squad…): membership is
 *  keyed by GAME player id, so a group is global — the server(s) are chosen when a bulk action is
 *  applied to it, not when the group is made. */
export interface PlayerGroupRow {
  id: string;
  name: string;
  description: string | null;
  /** how many players are in it (filled by list/get; not a stored column). */
  memberCount: number;
  /** The group's VIP perk, or null for none — see GroupVipPerk. */
  vipPerk: GroupVipPerk | null;
  /** A role in the community Discord whose holders the worker keeps listed (null = no sync). */
  discordRoleId: string | null;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}
/**
 * A player group's VIP perk: while a player is listed, they hold PERMANENT VIP on the servers it
 * covers, and whatever timed VIP they had there freezes beneath it — time granted meanwhile (staff
 * adding days, and rewards unless the perk says otherwise: bankRewards) adds to that frozen
 * balance. Leaving the group gives the balance back, plus the severance. A player already holding
 * permanent VIP from anywhere else is left exactly as they are: nothing to freeze, nothing to give back.
 */
export interface GroupVipPerk {
  /** The game whose servers it covers — player ids do not cross games. */
  game: string;
  /** Which of that game's servers: a RULE, so "every server" covers one added later. */
  scope: BanScopeJson;
  /** Minutes of VIP added on leaving, on top of the frozen balance (0 = none). */
  severanceMinutes: number;
  /**
   * Whether VIP REWARDS a member earns while listed add to their frozen balance — true, and when
   * absent (every perk set up before the switch). False: seed rewards and the bridge, game
   * rewards, player triggers, VIP shop purchases and gifts, bulk payouts and the registration
   * welcome find the group's VIP the way they find permanent VIP of the player's own — nothing to
   * add (vip-holds.ts rewardsRefusedBy). A person's grant by hand still adds to the balance, and
   * time already frozen is never touched. Both stores read it back as a boolean.
   */
  bankRewards?: boolean;
}

/** One group holding a player's VIP, as the hold remembers it from the last reconcile. */
export interface VipGroupHoldSource { id: string; name: string; severanceMinutes: number }

/**
 * A group perk's hold on one VIP grant (one server, one player). While it stands the grant is
 * permanent (expiration NULL) and `bankedMs` is the timed VIP frozen beneath it. It ends only
 * through the perk's reconciler (the player left every group holding it, or the perks were
 * switched off), or when staff grant the player permanent VIP outright.
 */
export interface VipGroupHold {
  /** When the hold began. */
  since: string;
  /** The frozen timed balance, in milliseconds — given back when the hold ends. */
  bankedMs: number;
  /** The groups holding it at the last reconcile: the severance on release is the largest of
   *  theirs (a group switched off "without severance" is recorded here at 0). */
  groups: VipGroupHoldSource[];
}

export interface PlayerGroupMemberRow {
  groupId: string;
  /** the GAME player id (platform id) — the identity bulk actions are issued against. */
  playerId: string;
  playerName: string | null;
  addedByName: string;
  addedAt: string;
  /** Who listed them: a person ("panel") or the group's Discord role sync ("discord") — the sync
   *  only ever removes its own. */
  source: "panel" | "discord";
}

/**
 * One real membership change, queued for the rule engine (migration 125): a player newly added to
 * a group, or removed from one. Re-adding someone already listed queues nothing.
 */
/** A membership change claimed this long ago and never finished belongs to a taker that died: it
 *  is dropped rather than handed out twice (playerGroups.takeEvents). */
export const GROUP_EVENT_CLAIM_MS = 60 * 60_000;

export interface PlayerGroupEventRow {
  id: string;
  groupId: string;
  /** The group's name when it happened — a group deleted since still has one here. */
  groupName: string;
  playerId: string;
  playerName: string | null;
  kind: "joined" | "left";
  createdAt: string;
  /** Not taken before this. A change waiting for its member to be seen on a server is put back
   *  with a later one (playerGroups.deferEvent). */
  notBefore: string;
  /** The rules still to fire on it — null for every rule watching; set when some fired and the
   *  rest wait. */
  ruleIds: string[] | null;
  /** Set by takeEvents: a later change of the same member in the same group is queued behind
   *  this one — they were removed (or added back) since, so a change still waiting is moot. */
  superseded?: boolean;
}

/**
 * Where "permanent" begins for a VIP expiration. CRCON stores never-expiring VIP as a date in the
 * year 3000 (and its seeding rewards stack days onto it: 3000-01-04, 3000-02-07…), so an import or
 * a sync carried those in as DATED grants — which the permanent floor did not protect, and
 * automation then dated them down to a few days, and the expiry sweep took them off the game.
 * Every store write turns an expiration from this instant on into permanent (null), and the VIP
 * integrity scan reads one the same way.
 */
export const VIP_PERMANENT_FROM = "2900-01-01T00:00:00.000Z";

/** The audit actions the VIP integrity scan reads in full (audit.vipTimeline)… */
export const VIP_TIMELINE_ACTIONS = ["vip.grant", "vip.revoke", "vip.reduce", "vip.expire", "seed.reward", "player.vipresume", "vip.integrity_ignore", "vip.group_hold", "vip.group_release"] as const;
/** …and these only where they moved an expiry (data.expiration set): every player earns a
 *  points-only game reward most matches, and the rows that touch no VIP are not the scan's. */
export const VIP_TIMELINE_EXPIRY_ACTIONS = ["game.reward", "enforcer.vip"] as const;

/** The expiration as it is stored: null (permanent) for none, or for a date at or past
 *  VIP_PERMANENT_FROM; any other date unchanged. */
export function storedVipExpiration(expiration: string | null | undefined): string | null {
  if (expiration == null) return null;
  const t = Date.parse(expiration);
  return Number.isFinite(t) && t >= Date.parse(VIP_PERMANENT_FROM) ? null : expiration;
}

export interface NewVip {
  serverId: string;
  playerId: string;
  playerName?: string | null;
  comment?: string | null;
  expiration?: string | null;
  createdByUserId?: string | null;
  createdByName: string;
  /**
   * Permission to replace a PERMANENT grant's null expiration with a date. Without it, both
   * stores keep the null and the returned row says so — the floor under every current and
   * future caller, in the store because that is the one door every write walks through. A write
   * the floor turns away (or a held grant keeps, below) leaves the grant's note as it was — unless
   * the note is one a person typed for it (typedNote).
   *
   * Twice now an automated path has rewritten a permanent VIP someone paid real money for into
   * a dated one (the shop's points purchase, then the seed reward), and each time the expiry
   * sweep then removed the grant from the game — correctly, by the date it found. Each was
   * fixed at its own call site; this flag is what makes the CLASS of bug impossible: automation
   * never carries it, and only a staff surface whose UI says "replace the grant" passes it.
   * Downgrading permanent to dated is a decision a person announces, never a side effect.
   */
  replacePermanent?: boolean;
  /**
   * Permission to move a DATED expiration earlier. Without it, both stores keep the later of the
   * stored date and the written one: every automated grant — a seed or game reward, a rule's VIP,
   * a shop purchase, a player trigger, a scheduled grant — can only ever add time, whatever it read
   * a moment before and however it computed its date. The same floor as replacePermanent, one step
   * further: players pay for dated VIP too, and a stale read or a write that forgot to take the
   * later date cut real time (the year-3000 rows below were cut to days that way). Only a person's
   * deliberate cut passes it (the VIPs page's "remove time"); the VIP editor's exact set passes
   * replacePermanent, which covers this too. A write the floor turns away keeps the grant's note.
   */
  mayShorten?: boolean;
  /**
   * The comment is a note a person typed for this write ("event winner" on a bulk grant): it lands
   * even where the permanent floor keeps the grant's expiration, as it would where the grant was
   * already permanent and the write simply stacked onto it. Never on a grant a group perk holds.
   */
  typedNote?: boolean;
  /**
   * A grant held by a group perk keeps its permanent expiration whatever this write says — time
   * for a held player goes to the frozen balance (vips.bankGroupHold), and the hold ends only
   * through the perk. A DATED write that lands on a held grant anyway (it read the row a moment
   * before the hold began) is banked by the store: the balance becomes the larger of the two, so
   * the grant's time is kept and a cut never reaches frozen time. The one exception is a person
   * granting the player PERMANENT VIP outright: that write passes this — whether or not it saw a
   * hold — the hold is dropped, and the grant is theirs: permanent, and no longer the group's to end.
   */
  endsGroupHold?: boolean;
  /**
   * A dated write landing on a held grant is banked as the time it gives from the grant's own
   * clock: while a banked VIP timeout stands that clock stopped at the timeout's start (paused_at),
   * the same anchor startGroupHold measures from. The timeout's END is the one write already
   * measured from now — it hands the frozen time back — and says so with this.
   */
  thawsPause?: boolean;
}

/** The events a per-player trigger can fire on — the player-scoped slice of the event stream. */
export type PlayerTriggerEvent =
  // …things the player DOES…
  | "connect" | "disconnect" | "kill" | "teamkill" | "chat"
  // …and things that happen TO them: the victim side of a kill, and the game's own moderation
  // lines. The last three carry only a NAME on the wire (the KICK/BAN log line has no id), so
  // matching falls back to the trigger's stored player name when the event has no record id.
  | "death" | "teamkilled" | "kicked" | "banned" | "punished"
  // …and the Rules tab's player events, read from the same bus events its rules read: a side swap
  // (never the drop to Unassigned that every swap passes through), a kill with a weapon the
  // trigger's params name, and going on or coming off the admin camera.
  | "teamswitch" | "weaponkill" | "camenter" | "camexit"
  // …starting a vote or voting in one (the VOTESYS lines name the player only by name), and going
  // AFK: no kill for the trigger's params.minutes, on a clock the trigger runner keeps.
  | "votestart" | "votecast" | "afk"
  // …and the Rules tab's live-roster conditions, judged on the roster by the worker: plays a
  // chosen role, below a level (overall or on chosen roles), a name the filter catches, outside
  // the allowed area, no VIP, a playtime milestone, no Discord link, a kill rate over a limit, a
  // ratio of kills, deaths and team kills past a limit, a clan tag, and the squad checks. Each is
  // @app/rules' PLAYER_ROSTER_EVENT_KIND; the trigger's params carry that detector's knobs.
  | "role" | "lowlevel" | "rolelevel" | "badname" | "outofzone" | "novip" | "playtime"
  | "nodiscord" | "killrate" | "ratio" | "clantag" | "noleader" | "solotank" | "soloheli";
/** The actions a trigger can take. RCON actions plus the two book-of-record grants (VIP, points). */
export type PlayerTriggerAction =
  | "message" | "kick" | "punish" | "tempban" | "permaban"
  | "vip" | "vipremove" // vipremove never touches a PERMANENT grant — see the runner
  | "points" | "takepoints"
  | "switch" // move them to the other team immediately
  | "watch"; // add a watchlist reason (the step's message)

/**
 * A per-player trigger: "when THIS player <event>, <action>", once or every time.
 *
 * The sibling of a server Rule, and deliberately not one: a rule watches a server for ANYONE
 * doing something; a trigger watches ONE named player and follows them across servers (serverId
 * null) or waits on one (serverId set). `playerId` is the player RECORD id (players.id), because
 * a trigger is aimed at a person, not at whatever platform id they log in with today.
 */
/** One step of a trigger: the action, its parameters, and how long after the event it runs. */
export interface PlayerTriggerStep {
  action: PlayerTriggerAction;
  /** message body / kick-punish-ban reason; the `{player_name}` token is filled at fire time. */
  message: string | null;
  /** tempban / VIP length in hours. */
  hours: number;
  /** economy points to grant (the `points` action). */
  points: number;
  /** seconds after the triggering event before THIS step runs (0 = immediately). Steps run at
   *  their own offsets, so "message now, kick in 60s" is one trigger. A step that needs the
   *  player present (message/kick/punish) re-checks presence when its delay lapses. */
  delaySec: number;
}

export interface PlayerTriggerRow {
  id: string;
  playerId: string;
  playerName: string | null;
  /** null = any server; otherwise only this one. */
  serverId: string | null;
  event: PlayerTriggerEvent;
  /** the ordered actions this trigger fires — one or several, each with its own delay. */
  steps: PlayerTriggerStep[];
  /** fire once then disarm (kept as a spent receipt), or every matching event. */
  fireOnce: boolean;
  enabled: boolean;
  /** staff free-text: why this trigger exists, shown on the row. */
  note: string | null;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  firedCount: number;
  lastFiredAt: string | null;
  /** set when a fireOnce trigger has fired — the row stays as a receipt, armed no more. */
  disarmedAt: string | null;
  /** What the event needs to know beyond itself — the weapons a "weaponkill" trigger listens for.
   *  `{}` for events that need nothing. Validated per event where a trigger is saved. */
  params: Record<string, unknown>;
  /** When staff last EDITED what it does (event, actions, scope) — null if never. A chain mid-delay
   *  compares this to stop running a version of the trigger that no longer exists. */
  updatedAt: string | null;
  updatedByName: string | null;
}

/** A full re-edit of a trigger: everything that defines it except whose trigger it is. */
export interface PlayerTriggerEdit {
  serverId: string | null;
  event: PlayerTriggerEvent;
  params: Record<string, unknown>;
  steps: PlayerTriggerStep[];
  fireOnce: boolean;
  note: string | null;
  editedByName: string;
  /** Arm a spent one-shot again (clears disarmedAt). Otherwise its armed state is left as it was. */
  rearm?: boolean;
}

export interface NewPlayerTrigger {
  playerId: string;
  playerName?: string | null;
  serverId?: string | null;
  event: PlayerTriggerEvent;
  params?: Record<string, unknown>;
  steps: PlayerTriggerStep[];
  fireOnce?: boolean;
  note?: string | null;
  createdByUserId?: string | null;
  createdByName: string;
}

/**
 * A ban's scope, as a RULE rather than a list of ids.
 *
 * Mirrors `BanScope` in apps/api/src/ban-scope.ts, which owns the resolution logic. Stored as jsonb
 * because the first two shapes describe servers that do not exist yet, which a join table cannot.
 */
export type BanScopeJson =
  | { mode: "servers"; serverIds: string[] }
  | { mode: "all" }
  | { mode: "except"; serverIds: string[] };

/**
 * Does this rule cover this server? Pure and game-blind — the caller filters decisions to the
 * server's game first, because player ids do not cross games and neither can a rule about them.
 */
export function banScopeCovers(scope: BanScopeJson, serverId: string): boolean {
  if (scope.mode === "all") return true;
  if (scope.mode === "except") return !scope.serverIds.includes(serverId);
  return scope.serverIds.includes(serverId);
}

const STEAM64_ID = /^765\d{14}$/;

/**
 * May this player id be acted on at a server of `game`? Groups are community-wide and mix both
 * games' accounts, so anything fanning a group out to servers asks first. The directory's word
 * wins when it has one — every id the panel has seen carries the game that first saw it, and ids
 * never move between games — else a Steam64 is only ever a WW2 (hll) account, and any other id (a
 * console EOS id, which both games issue in the same shape) waits until the directory has seen it.
 * `gameOf` maps platform id → game for the ids the directory knows.
 */
export function memberGameVerdict(playerId: string, game: string, gameOf: ReadonlyMap<string, string>): "ok" | "otherGame" | "notSeen" {
  const known = gameOf.get(playerId);
  if (known) return known === game ? "ok" : "otherGame";
  if (STEAM64_ID.test(playerId.trim())) return game === "hll" ? "ok" : "otherGame";
  return "notSeen";
}

/**
 * May a group VIP perk write on this server? Armed (not observe mode), and its VIP expiry run by
 * the panel (the `vipSweep` switch — off means CRCON owns VIP there). Elsewhere the perk neither
 * starts nor releases a hold. Shared by the worker that acts on perks and the VIP list that shows
 * where one covers a player, so the two cannot disagree.
 */
export function perkWritable(server: Pick<ServerRow, "engagementMode" | "automation">): boolean {
  return server.engagementMode !== "observe" && automationEnabled(server.automation, "vipSweep");
}

/**
 * What staff DECIDED about a player — as opposed to what a game server is currently enforcing,
 * which stays a live read off the game's own ban list.
 *
 * Rows are never deleted; a lift stamps `liftedAt`, so a player banned, unbanned and banned again
 * is three facts in order.
 */
export interface PlayerBanRow {
  id: string;
  /** Player ids do not cross games, so neither can a rule about them. */
  game: string;
  playerId: string;
  playerName: string | null;
  kind: "temp" | "perma";
  reason: string;
  /** Optional taxonomy — what the blacklist's named lists were actually for. */
  category: string | null;
  scope: BanScopeJson;
  /** NULL = permanent. A date, so "until the end of the season" is expressible. */
  expiresAt: string | null;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  liftedAt: string | null;
  liftedByName: string | null;
}
export interface NewPlayerBan {
  game: string;
  playerId: string;
  playerName?: string | null;
  kind: "temp" | "perma";
  reason: string;
  category?: string | null;
  scope: BanScopeJson;
  expiresAt?: string | null;
  createdByUserId?: string | null;
  createdByName: string;
  /** The real instant, for a row seeded from a game server or an archive. Defaults to now. */
  createdAt?: string;
}

// --- Community economy (docs/vip-module.md) ---

/**
 * A member of the community economy, keyed by DISCORD id — the one identity every participant has.
 * Public members hold no panel account, and may hold a balance before linking any game account.
 * `balance` is a cache of the ledger's sum, maintained in the same transaction as every write.
 */
export interface CommunityMemberRow {
  discordId: string;
  discordName: string | null;
  balance: number;
  createdAt: string;
  updatedAt: string;
}

/** One append-only ledger row. `delta` is the APPLIED amount after cap clamping — what happened,
 *  not what was asked for — and may be zero (a claim at the cap still consumes its period). */
export interface EconomyLedgerRow {
  id: string;
  discordId: string;
  delta: number;
  reason: string;
  /** Unique when present — the at-most-once key for purchases and claims. */
  ref: string | null;
  /** Who caused it: the member, a staff name, or "system". */
  actorName: string | null;
  createdAt: string;
}

export interface NewEconomyEntry {
  discordId: string;
  /** Requested change; the store clamps credits at the cap and refuses overdrawing debits. */
  delta: number;
  reason: string;
  ref?: string | null;
  actorName?: string | null;
  /** Freshest known Discord name, folded onto the member row on the way through. */
  discordName?: string | null;
}

/** Thrown by economy.apply when a debit would take a balance below zero. It carries the numbers,
 *  so a refusal can be put to a member in their own words rather than the store's. */
export class InsufficientBalance extends Error {
  readonly balance: number;
  readonly needed: number;
  constructor(balance: number, needed: number) {
    super(`insufficient balance: has ${balance}, needs ${needed}`);
    this.name = "InsufficientBalance";
    this.balance = balance;
    this.needed = needed;
  }
}

/**
 * Bulk payout (docs/bulk-payout.md): one JOB paying many people, with a receipt row per person.
 * The job is the summary a history screen lists; the items are the truth a dispute reads. Items
 * are written as the run progresses, so a crash mid-run leaves a ledger of exactly who was
 * reached — status INTERRUPTED plus the items IS the recovery story (retry pays whoever has no
 * PASS row), which is why there is no resume machinery.
 */
export interface PayoutJobRow {
  id: string;
  sourceType: "linked" | "online" | "window" | "event" | "retry";
  /** The source's parameters, verbatim — server, window bounds, retried job — for the record. */
  sourceRef: Record<string, unknown>;
  payoutType: "currency" | "vip";
  amount: number;
  /** VIP target servers; empty for currency, which is a community-wide balance. */
  serverIds: string[];
  audience: "everyone" | "linked" | "role";
  dryRun: boolean;
  status: "RUNNING" | "COMPLETE" | "COMPLETE_WITH_FAILURES" | "INTERRUPTED";
  requestedByUserId: string | null;
  requestedByName: string;
  createdAt: string;
  completedAt: string | null;
  totalCount: number;
  successCount: number;
  failedCount: number;
  /** The duplicate key — the payout's identity, for refusing to run the same one twice. */
  duplicateKey: string;
}

export type NewPayoutJob = Omit<PayoutJobRow, "id" | "createdAt" | "completedAt" | "successCount" | "failedCount">;

export interface PayoutItemRow {
  id: number;
  jobId: string;
  playerId: string | null;
  discordId: string | null;
  displayName: string;
  /** PENDING = written up front and not reached yet — after an interruption, exactly who a
   *  retry still owes. PASS/FAIL replace it in place as the run reaches each person. */
  status: "PASS" | "FAIL" | "PENDING";
  error: string;
  /** Before/after, shaped by the payout type: {balanceBefore,balanceAfter} for currency;
   *  {servers: {serverId: {before,after,alreadyPermanent}}} for VIP. JSON because the shape
   *  follows the type and columns would bake one type's shape into both. */
  detail: Record<string, unknown>;
  createdAt: string;
}

export type NewPayoutItem = Omit<PayoutItemRow, "id" | "createdAt">;

/**
 * A named payout window whose boundaries resolve themselves (docs/bulk-payout.md, event windows).
 * Each side is either a hard time (`at`: the anchor IS the boundary) or the next match boundary
 * at/after the anchor — "open with the first new round after 8pm", "close when the round being
 * played at 11pm finishes". The anchors are what staff CONFIGURED; openedAt/closedAt are what
 * the sweep RESOLVED, null until known. The transition policy itself lives in @app/payout
 * (`resolveEventBoundaries`), not in either store.
 */
export interface PayoutEventRow {
  id: string;
  name: string;
  serverId: string;
  status: "scheduled" | "open" | "closed" | "cancelled";
  openMode: "at" | "match_start_after";
  openAnchor: string;
  openedAt: string | null;
  closeMode: "at" | "match_end_after";
  closeAnchor: string;
  closedAt: string | null;
  /** Present at least this many minutes to count — the payout preview's default floor. */
  minMinutes: number;
  /** A map-vote profile NAME to pin while the event is open — the vote composes from that
   *  profile's pool instead of the schedule's choice. Null = the schedule decides as usual. */
  mapVoteProfile: string | null;
  /** A library map set id whose explicit lineup replaces the server's ROTATION when the event
   *  opens — the rotation half of the pairing mapVoteProfile makes for the vote. Null = the
   *  rotation is left alone. A set deleted in the meantime skips with an audit note. */
  rotationSetId: string | null;
  /** When the worker applied (or terminally skipped) the rotation set after open — the latch
   *  that makes the apply once-per-event and lets an unreachable server retry next sweep. */
  rotationAppliedAt: string | null;
  /** The who-was-there list materialised AT CLOSE, so the event outlives session trimming. */
  roster: { playerId: string; name: string | null; minutes: number }[] | null;
  createdBy: string;
  createdAt: string;
  /**
   * When staff marked this FINISHED event as needing no payout, and who did — both null while it
   * is still to be paid, or has been. The events list shows "No payout needed" instead of
   * "Awaiting payment"; undoing the mark clears both. Only a closed event takes it (setNoPayout).
   */
  noPayoutAt: string | null;
  noPayoutBy: string | null;
}

export type NewPayoutEvent = Omit<PayoutEventRow, "id" | "status" | "openedAt" | "closedAt" | "rotationAppliedAt" | "roster" | "createdAt" | "noPayoutAt" | "noPayoutBy">;

/**
 * What an event may still be CHANGED to, and the rule for when — the whole of "editing a
 * scheduled event", expressed as a type plus a status guard in each store.
 *
 * While `scheduled`, everything here is fair game: nothing has resolved, so nothing is being
 * rewritten. Once `open`, the open boundary HAS resolved — an event that started with the 8pm
 * round started then, and editing that anchor afterwards would make the record lie — so only the
 * still-unresolved half (the close side) and the descriptive fields move. `serverId` is fixed at
 * open too, because presence has been accruing against that server since.
 *
 * A `closed` or `cancelled` event is a record, and records are not edited: both stores refuse.
 */
export interface PayoutEventPatch {
  name?: string;
  /** Scheduled only — see above. */
  serverId?: string;
  /** Scheduled only — see above. */
  openMode?: "at" | "match_start_after";
  /** Scheduled only — see above. */
  openAnchor?: string;
  closeMode?: "at" | "match_end_after";
  closeAnchor?: string;
  minMinutes?: number;
  mapVoteProfile?: string | null;
  rotationSetId?: string | null;
}

/**
 * The self-sending events post: which channel, how far ahead, and when.
 *
 * `lastPostedOn` is the once-a-day latch (a local YYYY-MM-DD), stored beside the schedule rather
 * than derived, because "did today's post go out" cannot be answered from the channel — the bot
 * cannot read its own history without another permission, and a worker restart must not repost.
 */
export interface EventPostConfig {
  enabled: boolean;
  channelId: string;
  /** How many days ahead the posted list covers. */
  daysAhead: number;
  /** 0 = Sunday … 6 = Saturday; -1 = every day. */
  weekday: number;
  /** Time of day to post at, on the community clock. */
  atHour: number;
  atMinute: number;
  /** Local date (YYYY-MM-DD) of the last automatic post — the latch. */
  lastPostedOn: string | null;
}
export const EVENT_POST_DEFAULTS: EventPostConfig = {
  enabled: false, channelId: "", daysAhead: 14, weekday: 1, atHour: 9, atMinute: 0, lastPostedOn: null,
};

/** A shop offer. `scope` is the servers the granted VIP days land on — configuration, not code:
 *  a per-server shop is several offers with one-server scopes; a community-wide shop is one offer
 *  scoped to all. The Discord panel renders one button per enabled offer. */
export interface EconomyOffer {
  id: string;
  label: string;
  points: number;
  days: number;
  scope: { mode: "all" } | { mode: "servers"; serverIds: string[] };
  enabled: boolean;
  /**
   * Discord role ids the RECIPIENT must hold for this offer's VIP to be sold to them. EMPTY
   * MEANS EVERYONE (who is linked) — what an offer gets by being created and touching nothing
   * else, and what every offer written before this field existed reads as.
   *
   * The case it exists for: a community running two games sells VIP for each, and the whole shop
   * was drawn for everybody — a Vietnam-only member was offered WW2 VIP they could not use, and
   * only found out after spending. Pointing an offer at that game's registration role
   * (`registration.gameRoles`) makes the shop say what each member can actually receive.
   *
   * On the RECIPIENT, not the payer, because the gate is about where the days can land: someone
   * who plays only Vietnam may still spend their balance gifting WW2 VIP to a friend who plays
   * WW2, while buying it for themselves is refused and says why. That also makes this the early,
   * cheap form of a rule the grant already enforced late — VIP only lands on an account for that
   * server's game.
   *
   * Otherwise the same rules as a claim's gate: holding ANY listed role is enough (alternatives,
   * not requirements), and it is enforced on PURCHASE as well as drawn, because a button from a
   * panel message someone still has open must not buy.
   */
  roleIds: string[];
}

/**
 * Instance-wide settings that are not about any one server or feature — currently the community's
 * clock, which several features inherit.
 */
/** What a community's uploaded image is for. */
export type BrandImageKey = "board-badge";

/** One image a community uploaded in the panel. */
export interface BrandImageRow {
  key: BrandImageKey;
  /** image/png, image/jpeg or image/webp: read from the file's own first bytes, never from what the
   *  upload said it was. */
  mime: string;
  bytes: Uint8Array;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AppConfig {
  /**
   * The IANA zone this community runs on ("America/New_York"). Everything scheduled reads back in
   * it, the daily/monthly claim resets on its midnight, and any schedule that leaves its own zone
   * blank inherits it.
   *
   * Defaults to UTC because a fresh install has nobody to ask; the panel offers the browser's zone
   * on first open, which is the answer 99% of the time.
   */
  timezone: string;
  /**
   * The PUBLIC Discord guild — where members are, where the VIP launcher is posted, and whose
   * roles gate the claims.
   *
   * This exists because a community is usually TWO Discords: a staff server people are invited
   * into, and a public one everybody joins. DISCORD_GUILD_ID is the staff one — it decides who may
   * sign in to the panel and which roles map to panel roles. It is the wrong guild to read member
   * roles from, and reading it was why the claim role picker only ever offered staff roles.
   *
   * Empty means "the same guild as staff", which is right for a community that runs only one.
   */
  communityGuildId: string;
  /**
   * Community role badges: Discord roles in the PUBLIC guild → an emoji shown beside the player,
   * wherever the VIP star and the watch eye already show (roster marks, profile chips).
   *
   * Exists because Vietnam has no clan tags, so "is this one of ours?" cannot be read off a name
   * — but the community Discord already knows, and players link to it through the VIP panel. A
   * badge is DERIVED state like the star, never a flag someone sets on a player: it appears and
   * disappears with the role itself.
   *
   * Several badges may be defined (member, booster, tournament team…), each matching ANY of its
   * roles, and one player can wear several at once.
   */
  roleBadges: RoleBadgeDef[];
  /**
   * The approvals relay — OPTIONAL, off by default (empty string). When a channel id is set and a
   * bot token exists, every filed approval request posts a card there with Approve/Deny buttons,
   * and the card edits itself as lines are decided. Purely additive: the panel's Requests tab is
   * the source of truth and works identically with this blank.
   */
  approvalsChannelId: string;
  /** Optional role to @mention on each filed request ("" = no ping). */
  approvalsMentionRoleId: string;
  /**
   * The request builder's visibility ceiling: while a user has an open draft, their READ view is
   * elevated so they can browse the surfaces their request touches. "" = no ceiling (everything
   * readable); a role id caps the elevation at what THAT role can see — typically the community's
   * top approver role, so requesters see at most what the people signing for them see. The
   * elevation never confers write and never overrides a personal lockout.
   */
  requestCeilingRoleId: string;
  /**
   * How long an UNSUBMITTED draft (the request builder's cart, active or saved) survives with no
   * activity before the sweep deletes it, in hours. Measured from the last touch — a capture, a
   * save, a resume. 0 = keep drafts forever.
   */
  requestDraftTtlHours: number;
  /**
   * Nightly automatic full backups, written by the WORKER into the same host-mounted folder the
   * "Create full backup now" button uses (auto-backup-*.ndjson.gz beside full-backup-*). Off by
   * default: a backup archive carries every table verbatim, sealed credentials included, and
   * turning that on is the operator's call.
   */
  autoBackupEnabled: boolean;
  /** The hour (0–23) of the COMMUNITY's day the nightly backup runs at. Default 4 — after the
   *  evening's play, before anyone is up to be slowed by it. */
  autoBackupHour: number;
  /** How many automatic archives to keep; the sweep prunes the oldest past this. Manual backups
   *  (full-backup-*) are never pruned — those were made deliberately, often right before some
   *  risky change, and rotation must not eat them. */
  autoBackupKeep: number;
  /**
   * Clan tags: the combines, splits and names staff made on top of the automatic grouping of
   * spellings (Players → Clans; see clan-tags.ts). Written only by the Clans tab's own routes.
   */
  clanTags: ClanTagSettings;
  updatedAt: string;
}

/** One community badge: the emoji, the words behind it (tooltip), and the roles that earn it. */
export interface RoleBadgeDef {
  id: string;
  /** what is rendered — an emoji (or two; it is a bounded string, not parsed). */
  emoji: string;
  /** the tooltip: what holding this badge MEANS ("Community member"). */
  label: string;
  /** Discord role ids in the community guild; holding ANY of them earns the badge. */
  roleIds: string[];
}

export const APP_CONFIG_DEFAULTS: Omit<AppConfig, "updatedAt"> = { timezone: "UTC", communityGuildId: "", roleBadges: [], approvalsChannelId: "", approvalsMentionRoleId: "", requestCeilingRoleId: "", requestDraftTtlHours: 72, autoBackupEnabled: false, autoBackupHour: 4, autoBackupKeep: 7, clanTags: { merges: {}, labels: {} } };

/**
 * Split a string into GRAPHEME CLUSTERS — what a person calls "one emoji".
 *
 * `"👨‍👩‍👧‍👦".length` is 11, not 1: JavaScript counts UTF-16 code units, and an emoji can be a
 * surrogate pair, a variation selector, a skin tone, or a whole ZWJ chain of those. Anything that
 * measures or trims an emoji by `.length` will cut one in half, and half an emoji is not a smaller
 * emoji — it is the hatched .notdef box.
 *
 * Intl.Segmenter is the correct answer and is everywhere current (Safari 16.4+); the fallback
 * splits on code points, which is still whole-character-safe for the simple cases and only
 * over-counts ZWJ sequences.
 */
export function graphemes(s: string): string[] {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(x: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].map((g) => g.segment);
  return Array.from(s);
}

/**
 * Tidy an emoji field: trim, drop the joiners and modifiers that can only be left DANGLING by a
 * truncation elsewhere, and keep at most `max` whole graphemes.
 *
 * The dangling-character sweep matters because a value mangled by a length cap (a `maxlength` on
 * an input counts UTF-16 units too) arrives here already broken, and storing it would paint an
 * unfixable box beside a player's name.
 */
export function normalizeBadgeEmoji(raw: string, max = 2): string {
  // ORDER MATTERS, and getting it wrong is silent. Half a surrogate pair has to go FIRST: a cut
  // mid-emoji leaves the lone surrogate at the end, hiding the joiner behind it, so trimming
  // joiners first finds nothing and leaves a dangling one once the surrogate is dropped. Then the
  // edge trim repeats, because removing one joiner can expose the next.
  //
  // Escapes, not the literal characters: a zero-width joiner pasted into source is invisible to
  // every reader and to review. ‍ = ZWJ, ︎/️ = the text/emoji variation selectors.
  let s = raw
    .trim()
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  let prev = "";
  while (s !== prev) {
    prev = s;
    // Alternation, not a character class: a class holding combining marks is flagged as
    // misleading (they compose with what precedes them), and the linter is right to say so.
    s = s.replace(/^(?:‍|︎|️)+/, "").replace(/‍+$/, "");
  }
  return graphemes(s).slice(0, max).join("");
}

/** The badges a set of held Discord roles earns, in the order staff defined them. Pure — this is
 *  THE matching rule, shared by the roster, the profile, and the tests. */
export function badgesForRoles(badges: RoleBadgeDef[], heldRoleIds: string[]): { emoji: string; label: string }[] {
  if (!badges.length || !heldRoleIds.length) return [];
  const held = new Set(heldRoleIds);
  return badges
    .filter((b) => b.emoji.trim() && b.roleIds.some((r) => held.has(r)))
    .map((b) => ({ emoji: b.emoji, label: b.label || "Community role" }));
}

/** A zone the runtime will actually accept. Anything else falls back rather than throwing in a
 *  worker loop — a bad zone is a settings mistake, not a reason to stop granting VIP. */
export function safeTimezone(tz: string | null | undefined, fallback = "UTC"): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export interface EconomyClaim {
  enabled: boolean;
  /** Each claim rolls a whole number in [min, max]. */
  min: number;
  max: number;
  /**
   * Discord role ids allowed to claim. EMPTY MEANS EVERYONE (who is linked) — the common case,
   * and the one a community gets by switching the claim on and touching nothing else.
   *
   * A list turns the claim into a perk: boosters, patrons, a members role. It is checked against
   * the roles Discord sends with the press, so losing the role stops the claim at the next press
   * rather than whenever something happens to re-sync.
   */
  roleIds: string[];
}

/** The one-row economy settings document (economy_config.config). */
export interface EconomyConfig {
  /** What the currency is called everywhere it is shown: "Points" until the community names it. */
  currencyName: string;
  /** Credits clamp here; null = uncapped. */
  balanceCap: number | null;
  claims: { daily: EconomyClaim; monthly: EconomyClaim };
  /** Member→member currency gifts: a floor, and a ceiling per gift (null = uncapped). The cap
   *  bounds ONE gift, not a day's worth — it is a brake on fat fingers and on funnelling a whole
   *  balance in a single press, not an allowance system. */
  gifting: { enabled: boolean; minAmount: number; maxAmount: number | null };
  /** Buying a shop offer FOR someone else. Its own switch: a community may sell VIP happily and
   *  still not want it changing hands, and "there are offers" is not consent to gifting them.
   *  `roleIds` gates WHO may gift, same semantics as a claim's: empty is everyone, otherwise any
   *  of the listed community-guild roles. */
  vipGifting: { enabled: boolean; roleIds: string[] };
  offers: EconomyOffer[];
  /** The welcome for verifying a link over Discord: VIP days (0 = off) and a currency bonus
   *  (0 = off).
   *
   *  `bonusPerGame` decides HOW OFTEN it is paid. Off (the default): once per Discord account,
   *  ever — a second game linked later finds the bonus spent and pays nothing. On: once per
   *  Discord account PER GAME, so registering on Hell Let Loose and later on Vietnam pays the
   *  welcome each time. Still never twice for the same game, however many servers of it there are.
   *
   *  `bonusAllGames` decides how far the days reach, and only means anything while `bonusPerGame`
   *  is off — the two answer the same question and would double-pay together. Off (the default):
   *  only the servers of the game the account was registered on. On: every game's servers — but
   *  each game's grant uses the member's linked account FOR THAT GAME, because the games issue
   *  different player ids and the other game's id is one a server accepts and applies to nobody;
   *  a game with no linked account is skipped, not guessed at.
   *
   *  `gameRoles` maps game id → community-guild Discord role id, given to the member when they
   *  register an account for that game and taken back when staff clear the link. Per game, not one
   *  role for "registered": the whole point is telling the WW2-registered from the Vietnam-registered
   *  apart in Discord. A game with no entry assigns nothing.
   *
   *  `serverIds` names the servers the PUBLIC panel offers when a member picks where they are
   *  playing. Empty means every server, which is what a community that has nothing to hide wants;
   *  listing some is for the case where a server exists but is not open for registration yet — a
   *  test box, an event server, a game still being set up. Staff's own manual registration ignores
   *  this entirely: it is about what players are offered, never about what staff can reach. */
  registration: { bonusDays: number; bonusPoints: number; bonusAllGames: boolean; bonusPerGame: boolean; gameRoles: Record<string, string>; serverIds: string[] };
  updatedAt: string;
}

/** Everything off until the panel turns it on — a fresh install must not run an economy silently. */
/**
 * What setConfig accepts: every field optional, and the nested blobs partial. A section sent
 * replaces that whole section; keys left unsent inside it read back as ECONOMY_DEFAULTS — not as
 * whatever an earlier save held — because both stores complete reads from the defaults (see
 * config()). Callers keeping staff-edited values therefore send complete sections (the editor
 * route does); partial sections are for callers that mean "defaults except this". Offers are a
 * list and replace wholesale — a partial offer identifies nothing.
 */
export interface EconomyConfigPatch {
  currencyName?: string;
  balanceCap?: number | null;
  claims?: { daily?: Partial<EconomyClaim>; monthly?: Partial<EconomyClaim> };
  gifting?: Partial<EconomyConfig["gifting"]>;
  vipGifting?: Partial<EconomyConfig["vipGifting"]>;
  offers?: EconomyOffer[];
  registration?: Partial<EconomyConfig["registration"]>;
}

export const ECONOMY_DEFAULTS: Omit<EconomyConfig, "updatedAt"> = {
  currencyName: "Points",
  balanceCap: null,
  claims: {
    daily: { enabled: false, min: 15, max: 25, roleIds: [] },
    monthly: { enabled: false, min: 475, max: 525, roleIds: [] },
  },
  gifting: { enabled: false, minAmount: 1, maxAmount: null },
  vipGifting: { enabled: false, roleIds: [] },
  offers: [],
  registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, bonusPerGame: false, gameRoles: {}, serverIds: [] },
};

/**
 * THE slash command — singular, and the type says so.
 *
 * The bot has exactly one command, and everything it can do is a button inside the panel it
 * opens (docs/discord-modules.md). That is a deliberate limit, not an accident of what has been
 * built: a second command would be a second surface to find, permission and register, when the
 * panel already lists exactly what the presser is allowed to do. Anything new is a module.
 *
 * `name` and `description` are what Discord shows and are staff's to change; a one-row jsonb
 * document (discord_commands.config) holds them.
 */
export interface DiscordCommandConfig {
  name: string;
  description: string;
  /** Off removes the command from Discord on the next registration — the bot's whole inbound
   *  surface, since public users press buttons on a posted launcher rather than type anything. */
  enabled: boolean;
  updatedAt: string;
}

export const DISCORD_COMMAND_DEFAULTS: Omit<DiscordCommandConfig, "updatedAt"> = {
  name: "staff",
  description: "Open the staff panel",
  enabled: true,
};

/**
 * The dedicated in-game chat filter — one community-wide word list serving two consumers:
 *
 *  - ENFORCEMENT: the API maintains two managed rules (team chat + unit chat) whose match regex
 *    is derived from `words` with word boundaries, so the list acts on players through the same
 *    engine as every other rule. The managed rule ids are remembered here so a save updates the
 *    rules in place, preserving anything staff added to them by hand (exemptions, a ladder,
 *    alert routing, active hours).
 *  - THE GAME'S OWN CENSOR (CRCON's "profanities"): with `censor` on, the list is pushed to each
 *    ACTIVE server's native banned-words list, which stars the words out of chat client-side.
 *    `censorApplied` records per server what has actually been pushed, because HLL's v2 wire has
 *    no banned-words getter — our record IS the reconcile baseline for the add/remove diff.
 */
export interface ChatFilterConfig {
  /** Enforcement on/off — the managed rules' enabled switch rides this. */
  enabled: boolean;
  /** Words and short phrases, matched whole-word and case-insensitively. */
  words: string[];
  /** What the managed rules do on a match ("blacklist" = the real-ban action, as in rules). */
  action: "message" | "punish" | "kick" | "tempban" | "blacklist";
  /** Ban length: required for tempban, optional for blacklist (blank = permanent), else null. */
  hours: number | null;
  /** What the player is told / the ban reason. */
  reason: string;
  /** Also push the list into each active server's native banned-words censor. */
  censor: boolean;
  /** serverId → the words last successfully pushed there (the diff baseline). */
  censorApplied: Record<string, string[]>;
  /** The managed rules, so saves edit rather than multiply. Null until first save. */
  teamRuleId: string | null;
  unitRuleId: string | null;
  updatedAt: string;
}

export const CHAT_FILTER_DEFAULTS: Omit<ChatFilterConfig, "updatedAt"> = {
  enabled: false, words: [], action: "punish", hours: null, reason: "",
  censor: false, censorApplied: {}, teamRuleId: null, unitRuleId: null,
};

/** A game ban imported from an existing CRCON instance — the import-time archive, kept for
 *  reference. The live record is player_ban; nothing reads this on the Bans page any more. */
export interface CrconBanRow {
  id: string;
  serverId: string;
  playerId: string;
  playerName: string | null;
  type: "temp" | "perma";
  reason: string | null;
  expiresAt: string | null;
  author: string | null; // who placed the ban on CRCON
  createdAt: string;
}
export interface NewCrconBan {
  serverId: string;
  playerId: string;
  playerName?: string | null;
  type: "temp" | "perma";
  reason?: string | null;
  expiresAt?: string | null;
  author?: string | null;
  /** When the ban was actually issued on the game server (CRCON's stamp). The Bans view shows
   *  this as WHEN, so an import without it would read as "banned the day I imported". Upsert
   *  keeps the EARLIEST known instant, which also repairs rows an older import stamped late. */
  bannedAt?: string | null;
}

/** One played round. Opened on MATCH START, closed on MATCH ENDED with the parsed outcome. */
/**
 * The shortest round that counts as a game. Anything shorter — a map loaded and switched away
 * from at once, a round restarted seconds in, a start line the game writes on the end screen — is
 * never kept as a match and never reaches a career: it was showing up as a "0m" round in the match
 * list and handing everyone online a played (and a win or loss), and while one sat open on the end
 * screen the scoreboard sampler added the whole last round's scores to careers a second time. So
 * a round's sampled scores reach careers only once it has run this long (stats.sampleRoster), and
 * one that ends sooner is dropped (matches.discardShort).
 */
export const MIN_MATCH_MS = 5 * 60_000;

/**
 * A round as the CRCON-compatible endpoints list it: one of ours, or one under MIN_MATCH_MS that
 * our records dropped and CRCON's keep (crcon_short_rounds). `matchId` is null for the latter.
 */
export interface CrconRoundRow {
  matchId: string | null;
  short: boolean;
  seq: number;
  game: string | null;
  map: string | null;
  crconMap: string | null;
  crconGuessed: boolean | null;
  crconInitialMorale: number | null;
  crconEndDeferred: boolean | null;
  startedAt: string;
  endedAt: string | null;
  capFlips: [number, number, number][];
  moraleHistory: [number, number, number][];
  matchTime: number;
  sectorLayout: string[] | null;
  alliedScore: number | null;
  axisScore: number | null;
  result: string | null;
  createdAt: string;
  /** Set only on rounds our live ingest settled; never on an imported round. */
  settledAt: string | null;
}

/**
 * One leg of CRCON's unit history (UnitHistoryEntry): seconds since the round's start, then the
 * side (1 allies, 2 axis), squad index and role id, each -111 for unassigned or offline. The squad
 * is null only where CRCON's own fallback player record carries no unit.
 */
export interface CrconUnitEntry {
  ts: number;
  team: number;
  squad: number | null;
  role: number;
}

/**
 * One player's line in CRCON's per-round player cache (MapInfo.player_stats, kept by
 * record_player_stats in rcon/logs/loop.py at v12.3.0): the game's score buckets for the current
 * session with earlier sessions' totals banked in the p_* fields, the unit history, the names seen
 * and whether the player is still connected. p_coord and has_spawned are the recorder's own
 * state and are never published.
 */
export interface CrconPlayerStat {
  combat: number;
  p_combat: number;
  offense: number;
  p_offense: number;
  defense: number;
  p_defense: number;
  support: number;
  p_support: number;
  vehicle_kills: number;
  p_vehicle_kills: number;
  vehicles_destroyed: number;
  p_vehicles_destroyed: number;
  kills_and_assists: number;
  p_kills_and_assists: number;
  deaths_and_redeploys: number;
  p_deaths_and_redeploys: number;
  p_unit: CrconUnitEntry;
  units: CrconUnitEntry[];
  level: number;
  p_coord: { x: number; y: number; z: number };
  has_spawned: boolean;
  names: string[];
  status: "online" | "offline";
}

/** The cache as CRCON keeps it: [player_id, line] pairs in the order players were first seen. */
export type CrconPlayerCache = [string, CrconPlayerStat][];

/** One player's score buckets at one moment of a round, for match_score_series. */
export interface ScoreSeriesPoint {
  platformId: string;
  /** Seconds since the round's start. */
  sec: number;
  combat: number;
  offense: number;
  defense: number;
  support: number;
}

export interface MatchRow {
  id: string;
  /**
   * The game this round was PLAYED on — not whichever game its server runs today.
   *
   * A map name only means something against a game's catalogue, and reading a stored round
   * against the server's current game silently mis-parses every round a server recorded before it
   * switched games: wrong factions, wrong layer, a Vietnam map resolving to a WW2 one that merely
   * looks plausible. CRCON reached the same conclusion in v12.1.1 (parse_recorded_layer).
   *
   * Null only on rows a very old store wrote and never backfilled; callers fall back to the
   * server's game there, which is what they used to do for every row.
   */
  game: string | null;
  /**
   * The round's public integer alias, install-wide and chronological. Exists because CRCON's
   * `Maps.id` is an autoincrement int and its public API hands that id to clients which hand it
   * straight back (`get_map_scoreboard?map_id=<int>`): a tool doing `parseInt` on our UUID gets
   * NaN. The UUID stays the identifier everywhere internal; `seq` exists only to be spoken on the
   * public surface. See docs/public-stats.md (gap 6 in docs/streamer-mode.md).
   */
  seq: number;
  serverId: string;
  map: string | null;
  startedAt: string;
  endedAt: string | null;
  winner: "allies" | "axis" | null;
  alliedScore: number | null;
  axisScore: number | null;
  /**
   * Conquest's scoreline, sampled off the live session the same way the score is: each side
   * starts with `initialMorale` and the round ends when one pool is empty. Null on every round
   * that was not scored in morale (warfare/offensive report zeros on the wire, and zeros are
   * not recorded — a 0–0 morale row would read as a finished drain).
   */
  initialMorale: number | null;
  alliedMorale: number | null;
  axisMorale: number | null;
  /** CRCON's map-recorder timeline: each score change as [seconds since start, allied, axis], and
   *  in Conquest the morale at each, the same shape. Oldest first. See apps/workers/src/cap-flips.ts. */
  capFlips: [number, number, number][];
  moraleHistory: [number, number, number][];
  /** The theoretical full match length the recorder saw (CRCON's match_time); 0 until it did. */
  matchTime: number;
  /** CRCON's record of the round's start (apps/workers/src/round-start.ts): the layer id it files
   *  the round under, whether that was a guess from the match log, and its initial_morale —
   *  which, unlike `initialMorale`, CRCON also sets on rounds not scored in morale. All null
   *  until the worker has decided them. */
  crconMap: string | null;
  crconGuessed: boolean | null;
  crconInitialMorale: number | null;
  /** CRCON's record of the round's end (apps/workers/src/round-end.ts): true when CRCON would have
   *  left the end to the next round's start, false when the MATCH ENDED time stood, null when
   *  not decided (no MATCH ENDED line, or no decision made). */
  crconEndDeferred: boolean | null;
  result: string | null; // the raw MATCH ENDED tail, kept for display when parsing is partial
  /** When settleMatch rolled this round's played/won onto careers; null until then. This is its
   *  own column because it used to be a " settled" marker appended to `result` — which the
   *  panel renders verbatim, so every match detail page read "… settled" to staff. */
  settledAt: string | null;
  /** The five objectives STAFF set for this round, or null if nobody set one. Never "the layout
   *  played" — the game has no reader for that (docs/rcon-503.md), only a setter. */
  sectorLayout: string[] | null;
  sectorLayoutBy: string | null;
  sectorLayoutAt: string | null;
  createdAt: string;
}
/**
 * One leg of a player's squad/role history within a round — CRCON's `UnitHistoryEntry`, field for
 * field. All four are the GAME's own numbers (its team ids, its squad index, its role number), not
 * ours, because the public API republishes them raw.
 */
export interface UnitHistoryEntry {
  /** seconds since the round started */
  ts: number;
  team: number;
  squad: number;
  role: number;
}

/** A player's scoreboard line for one match, accumulated from the kill stream. */
export interface PlayerMatchStatRow {
  matchId: string;
  playerId: string;
  serverId: string;
  playerName: string | null;
  side: "allies" | "axis" | null; // side at last fold, used for win attribution
  kills: number;
  deaths: number;
  teamkills: number;
  /** the round's FINAL score buckets — the game resets these each match, so this is not a running sum. */
  combat: number;
  offense: number;
  defense: number;
  support: number;
  vehicleKills: number;
  vehiclesDestroyed: number;
  /** seconds in each role this round, keyed by the game's raw role number. Key "-1" is the
   *  unknown-role sentinel: time IMPORTED from CRCON, which records how long a player was in a
   *  round but not what they played. It sums into round playtime like any other key; role
   *  breakdowns must skip negative keys (RoleSplit does). */
  roleSeconds: Record<string, number>;
  slSeconds: number;
  /**
   * The game's own kill/death counters for this round — CRCON's `kills_and_assists` and
   * `deaths_and_redeploys`. Deliberately separate columns from `kills`/`deaths` above, which count
   * kill-log lines: the game's counters also move on an assist and on a redeploy, so the two pairs
   * disagree by design and CRCON publishes both.
   *
   * `*Prev` carries the total from BEFORE the player's most recent reconnect. The game resets a
   * player's counters when they rejoin mid-round, so the published figure is prev + current — the
   * same two-part accounting CRCON does with its `p_` fields. Without it, reconnecting would erase
   * a player's round.
   */
  killsAndAssists: number;
  killsAndAssistsPrev: number;
  deathsAndRedeploys: number;
  deathsAndRedeploysPrev: number;
  /**
   * Every (team, squad, role) the player held this round, in order, with the seconds-since-kickoff
   * at which they moved into it — CRCON's `units`. Appended only when the triple CHANGES, so a
   * player who never switches has one entry rather than one per sample.
   */
  units: UnitHistoryEntry[];
  /** null until the match closes — mid-round we genuinely do not know, and false would claim a loss. */
  won: boolean | null;
  presentAtEnd: boolean | null;
  updatedAt: string;
}
/** Rollup of a player's per-match stats into career-over-matches figures (for the profile). */
export interface PlayerMatchAggregate {
  matches: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  teamkills: number;
}
/** A player's per-match line joined with the match it belongs to (for the profile's recent matches). */
export interface PlayerMatchRow extends PlayerMatchStatRow {
  map: string | null;
  startedAt: string;
  endedAt: string | null;
  winner: "allies" | "axis" | null;
  /** the round's public integer alias, so a caller can link to the round on the public site. */
  seq: number;
}

/**
 * Per-server seeding configuration. "Seeding" is the low-population phase where a server needs
 * players to join and stay so it fills up. While seeding, special rules apply (some roles are
 * disallowed to keep early play fair); once the server reaches `seedTarget` players it goes
 * "live" and everyone who helped seed for long enough is rewarded with VIP. Game-agnostic: the
 * disallowed roles are raw role numbers matched against the game descriptor's role map.
 */
/**
 * One extra stop on the seed-reward bridge: when THIS server's seed round pays out, also grant
 * `hours` of VIP on `serverId`. A same-game target pays by the seeder's own platform id; a
 * target on ANOTHER game pays only seeders registered for that game — the seeded account's
 * Discord link is the hub, and the other game's link supplies the id that game understands
 * (the same resolution the VIP shop uses). Points are not bridged: the balance already lives on
 * the Discord account and is one number however many servers exist.
 */
export interface SeedBridgeTarget {
  serverId: string;
  hours: number;
}

export interface SeedingConfigRow {
  serverId: string;
  enabled: boolean;
  /** audit-only: never send warns/punishes/kicks/VIP to the game (tune against real traffic). */
  dryRun: boolean;
  /** player count at which the server is considered "live" (out of seeding). */
  seedTarget: number;
  /** below this count the automod does nothing (server is basically empty). */
  minPlayers: number;
  /** roles (descriptor role numbers) not allowed while seeding. */
  disallowedRoles: number[];
  /**
   * Weapon-class ids (the game's weaponClasses: "artillery", "armor", …) whose kills are
   * violations while seeding. Classes, not weapon names, because that is how staff think about a
   * seed — "no artillery, no armor" — and because a class keeps matching when a game patch adds a
   * new gun to the family. This absorbed the retired "Seeding rules" module (one page, one
   * threshold, one phase machine, instead of two of each).
   */
  disallowedWeaponClasses: string[];
  /** extra weapon substrings (upper-cased) for the odd case the class chips don't cover. */
  disallowedWeapons: string[];
  /**
   * INDIVIDUAL weapons (exact kill-log names, upper-cased) picked from the game's weaponCatalog —
   * for the gun that is overpowered on a quiet server while the rest of its class is fine.
   * Exact-match, not substring: catalogue names are validated against the game table, so a name
   * here is precisely what a kill line will say.
   */
  disallowedWeaponNames: string[];
  /** commander kill-abilities (upper-cased, from the game's commanderAbilities) blocked while
   *  seeding — "no commander strikes on 20 players" as its own switch, not one more weapon. */
  disallowedCommanderAbilities: string[];
  /**
   * Enforce the cap fight (CRCON's third seeding rule, ported from v12.1.1 seeding_rules.py):
   * while a team already holds `capFightMaxCaps` points, a player on that team whose OFFENSE
   * score is still climbing is standing in the enemy cap attacking it — the exact thing a seed
   * agrees not to do. WARFARE ONLY, by construction: the check reads the team scores, which in
   * warfare are caps held (0–5); offensive mode scores mean something else entirely, so there
   * the rule stands down rather than firing on garbage — the same line CRCON draws.
   */
  capFightEnabled: boolean;
  /** caps a team may hold before its attackers are violating (CRCON: 2–4, default 3). */
  capFightMaxCaps: number;
  /** skip the warning steps and punish on the first offence (CRCON's skip_warning). */
  capFightSkipWarning: boolean;
  /**
   * The cap-fight rule in the operator's own words. It appears in two places, deliberately the
   * same words: the line under "Not allowed while seeding:" in the greeting, and the {violation}
   * phrase in the warn/punish messages — the player is warned in the words the greeting used.
   * Blank keeps the line OUT of the greeting; the warnings then fall back to the stock phrase,
   * because an enforcement message that names no rule is worse than a default one.
   */
  capFightNotice: string;
  /**
   * The seeding zones — ONE switch: keep each team off the other team's ground, using the same
   * live world positions the restricted live screen reads. Where staff painted a map or layer
   * (keyed by `zoneKeyOf` / `layerZoneKey` from @app/maps: three sector lists, the Allies'
   * ground, the Axis' ground, and squares marked for both) the paint decides; a player is judged
   * only on the other team's ground, and "both teams" and empty squares are free for everyone.
   * Everywhere else the auto fence keeps each side to its half plus the shared middle band, from
   * the layer's learned layout or the round read live (warfare rounds only), and layouts are
   * learned while this is on. Enforcement runs only while the phase is `seeding`, through the
   * same warn → punish → kick ladder as the role rules.
   */
  containEnabled: boolean;
  /** No longer read: the zones' one switch (containEnabled) covers the auto fence. Kept so old
   *  rows, backups and presets load unchanged. */
  containAutoEnabled: boolean;
  /**
   * The positional half of the cap fight: a winning-team player past the front line is caught by
   * where they stand, beside the offense-score half. Off (the default), the cap fight works the
   * way CRCON's does, by offense score alone. (Named before it was narrowed to this one job; the
   * zones and steamroll protection answer to containEnabled and paceEnabled.)
   */
  positionalEnabled: boolean;
  /** seconds a player may stand outside their side's zone before the ladder starts (0 = instantly). */
  containGraceSec: number;
  /** stand the containment down at/above this many players even while still "seeding" (0 = the
   *  phase alone decides). Exists because a community may seed to 80 but want free play from 60. */
  containMaxPlayers: number;
  /** the rule in the operator's words — the greeting line and the warn's {violation}; blank keeps
   *  the line out of the greeting and the warns fall back to the stock phrase (capFightNotice's rule). */
  containNotice: string;
  /** zone key → the three sector lists ("A1".."J10"). */
  containZones: Record<string, { allies: string[]; axis: string[]; shared: string[] }>;
  /**
   * Steamroll protection for OFFENSIVE rounds (WW2 map ids name the attacker) — its own switch.
   * The five points unlock on a clock: paceUnlockMinutes[k] is the earliest round-minute the
   * attacking team may set foot in point band k (counted from the attackers' own end; 0 = always
   * open). Judged from the same round geometry as the seeding zones (learned per layer, or read
   * live), with the same label-trust gates, and runs during LIVE rounds — this is match pacing,
   * not a seed rule. Defenders are never touched. Layouts are learned while this is on.
   */
  paceEnabled: boolean;
  paceUnlockMinutes: number[];
  /** the rule in the operator's words — the warn's {violation}; blank uses the stock sentence. */
  paceNotice: string;
  /** Seeding zones on "Learn only": learn each LAYER's layout from players walking out of their own
   *  end in a round's first ten minutes, enforcing nothing. Zones On (containEnabled) learn too, as
   *  does steamroll protection, which uses the layouts. */
  layoutLearnEnabled: boolean;
  /** players at or below this level are exempt from enforcement (0 = disabled). */
  immuneLevel: number;
  /** players carrying any of these custom tags are exempt. */
  immuneTags: string[];
  /** message shown to a connecting player during seeding (blank = none). */
  announceMessage: string;
  /** escalation ladder: warn → punish → kick. */
  maxWarnings: number;
  warnIntervalSec: number;
  warnMessage: string;
  maxPunishes: number;
  punishIntervalSec: number;
  punishMessage: string;
  kickAfter: boolean;
  kickMessage: string;
  /**
   * The seed reward, in two currencies that are independent of each other: VIP time and community
   * points. `rewardEnabled` is the master switch; `rewardHours` and `rewardPoints` are each 0 for
   * "not this one", so a community can give VIP, points, or both, and change its mind without
   * touching anything else. Enabled with both at zero is refused at the route — a reward that
   * promises something and hands over nothing is worse than one that is switched off.
   */
  rewardEnabled: boolean;
  /** VIP granted per qualifying seeder (hours). 0 = no VIP in this reward. */
  rewardHours: number;
  /**
   * Community points credited per qualifying seeder. 0 = no points in this reward.
   *
   * Points live on a DISCORD account (that is what a balance is), so a seeder whose game account
   * carries no Discord link cannot be paid — the same rule the bulk payout states outright. They
   * still get the VIP half if there is one, and the skip is recorded on their reward row rather
   * than being silent.
   */
  rewardPoints: number;
  /** minimum minutes present during seeding to qualify. */
  minSeedMinutes: number;
  /** true = add reward onto any existing VIP; false = extend to max(existing, now+reward). */
  rewardCumulative: boolean;
  /**
   * The bridge: extra servers this reward also lands on, each with its own hours — "seed WW2,
   * get 3 days here and 1 day on Vietnam". Saved only by staff holding vip.grant on each target
   * (the route enforces it), executed by the worker under the same rules as the seeded server's
   * own grant: permanent absorbs, paused banks, never shortens, one round per debounce. A slice
   * that cannot land (not registered on that game, target retired) is skipped with the reason
   * on its own receipt, never silently.
   */
  rewardBridge: SeedBridgeTarget[];
  rewardMessage: string;
  /**
   * The currency footnote, sent with the reward whenever points are switched on — one line for a
   * seeder who is linked and one for a seeder who is not.
   *
   * It exists because the gap is otherwise silent. Points land on a Discord account, so an
   * unlinked seeder collects the VIP half and simply never hears about the rest; they cannot ask
   * about a reward they were never told existed. Telling them what they COULD have earned turns
   * that into a reason to link, and stays true — it says "could have", never "did".
   *
   * Blank switches either half off. Tokens: `{currency}` `{reward_points}` `{player_name}`, plus
   * `{balance}` on the linked line (an unlinked player has no balance, so it renders empty there).
   */
  rewardLinkedNote: string;
  rewardUnlinkedNote: string;
  /** The repeat window, in seconds: a seeder paid within this long is not paid again when the
   *  population drops and comes back — they get `rewardRepeatMessage` instead, and only seeders
   *  NOT paid in the window are rewarded. 0 = every round pays everyone who qualifies. */
  rewardDelaySec: number;
  /** What a seeder already paid within the repeat window is told when the server goes live
   *  again. Blank = say nothing. Tokens: `{window}` ("1 hour"), `{player_name}`. */
  rewardRepeatMessage: string;
  /** phase stability — sustained-time confirm: the player count must hold in a new phase's band for
   *  this many seconds before the phase actually commits. 0 = react instantly. */
  phaseConfirmSec: number;
  /** phase stability — hysteresis: a dead band (in players) on the DOWN-crossing, so the phase only
   *  falls back once the count drops this far below the boundary. 0 = symmetric thresholds. */
  phaseHysteresis: number;
  /** How often the seeding loop checks the server, in seconds. null = the install's default
   *  (30s, or SEED_POLL_MS). Read every tick, so a change applies at the next check. */
  checkSec: number | null;
  /** The quicker check used while seeding with a rule that chases positions armed. null = the
   *  install's default (10s, or SEED_FAST_POLL_MS). Never slower than `checkSec`. */
  chaseCheckSec: number | null;
  updatedAt: string;
}
/** Bounds for the seeding check speeds, in seconds. */
export const SEED_CHECK_SEC = { min: 5, max: 300 } as const;
export const SEED_CHASE_CHECK_SEC = { min: 3, max: 60 } as const;
export type SeedingConfigPatch = Partial<Omit<SeedingConfigRow, "serverId" | "updatedAt">>;

/** Rotating server broadcast: a list of messages the worker cycles through the game's `broadcast`
 *  command on an interval, plus a master switch and a dry-run (audit-only) mode. One row per server. */
export interface BroadcastConfigRow {
  serverId: string;
  /** master switch for the rotating auto-broadcast. */
  enabled: boolean;
  /** audit-only: log "would broadcast …" but never send to the game (safe while tuning). */
  dryRun: boolean;
  /** seconds between rotations. */
  intervalSec: number;
  /** pick the next message at random instead of walking the list in order. */
  randomize: boolean;
  /** the rotation — messages are cycled in order (or at random). Empty = nothing to send. */
  messages: string[];
  updatedAt: string;
}
export type BroadcastConfigPatch = Partial<Omit<BroadcastConfigRow, "serverId" | "updatedAt">>;

/** Factory defaults for a server's broadcast config (used when none is stored yet). */
export const BROADCAST_DEFAULTS: Omit<BroadcastConfigRow, "serverId" | "updatedAt"> = {
  enabled: false,
  dryRun: true,
  intervalSec: 300, // 5 min — a sane default cadence that won't spam
  randomize: false,
  messages: [],
};

/**
 * The LIVE welcome message: the game shows one stored welcome text to everyone who joins, so
 * placeholders there can only be SERVER-wide ones ({next_map}, {player_count}…), and only by the
 * app rewriting the game's text. This is that: a template kept here, filled and written to the
 * game on a timer — and only when the filled text actually changed. Joins never trigger a write;
 * a server filling from 0 to 100 costs at most one write per interval. Off by default.
 */
export interface WelcomeConfigRow {
  serverId: string;
  enabled: boolean;
  /** the text with placeholders, as staff wrote it. */
  template: string;
  /** at most one rewrite per this many seconds (60–3600). */
  intervalSec: number;
  /** what was last written to the game — compared before every write, and survives restarts. */
  lastText: string | null;
  lastWrittenAt: string | null;
  updatedAt: string;
}
export type WelcomeConfigPatch = Partial<Pick<WelcomeConfigRow, "enabled" | "template" | "intervalSec">>;
export const WELCOME_DEFAULTS: Pick<WelcomeConfigRow, "enabled" | "template" | "intervalSec"> = {
  enabled: false,
  template: "",
  intervalSec: 300,
};
export const WELCOME_INTERVAL_MIN_SEC = 60;
export const WELCOME_INTERVAL_MAX_SEC = 3600;

/**
 * GAME REWARDS — paying players for how they play, per server, each kind individually switched.
 *
 *  - topStats: at each match end, the best players per category (kills, K/D, support…), a
 *    reward per rank. Only matches with enough players, only players who played long enough.
 *  - killStreaks: kills without dying, tiers crossed once per life. Team kills never count.
 *  - playDays: consecutive days played (a minimum each day), progressive tiers, optional repeat.
 *  - seedDays: consecutive days a player was PAID a seed reward, progressive tiers, optional repeat.
 *
 * Every reward is VIP hours and/or points (either may be 0). Paid permanent VIP is never shortened
 * (the seed reward's rule, verbatim). Each kind has its own dry-run, on by default, which records
 * "would reward" without paying. Every payout is claimed once by a receipt, so a restart or a
 * re-read log never pays twice.
 */
export interface RewardAmount { vipHours: number; points: number }
export const TOP_STAT_CATEGORIES = ["kills", "kd", "kpm", "combat", "offense", "defense", "support", "teamplay", "commander", "vehicles"] as const;
export type TopStatCategory = (typeof TOP_STAT_CATEGORIES)[number];
/** `message`: this tier's own message; blank = the card's message. */
export interface StreakTier { days: number; reward: RewardAmount; message?: string }
/** Squad types best-squad rewards rank, across every game — a type a game lacks is skipped there. */
export const SQUAD_TYPES = ["infantry", "armor", "recon", "artillery", "mortar", "helicopter"] as const;
export type SquadType = (typeof SQUAD_TYPES)[number];
/** What a squad is ranked by: its members' numbers for the match. "score" is all four buckets. */
export const SQUAD_METRICS = ["score", "teamplay", "kills", "combat", "offense", "defense", "support"] as const;
export type SquadMetric = (typeof SQUAD_METRICS)[number];
/** The reward cards, in the panel's default arrangement. */
export const GAME_REWARD_CARDS = ["matchEnd", "topStats", "bestSquads", "killStreaks", "playDays", "seedDays"] as const;
export type GameRewardCard = (typeof GAME_REWARD_CARDS)[number];
export interface GameRewardsConfig {
  /**
   * The cards in the order staff arranged them in the panel. A player who earns more than one
   * reward at a match end (a top-stats place and the everyone-at-match-end day, say) gets ONE
   * message, its parts in this order — and within top stats, in the order of `categories`.
   */
  order: GameRewardCard[];
  topStats: {
    enabled: boolean; dryRun: boolean;
    /** a player must have played at least this long in the match to place. */
    minMinutes: number;
    /** matches with fewer players than this pay nothing (seeding rounds, empty servers). */
    minPlayers: number;
    /** broadcast the winners to the whole server at match end. */
    broadcast: boolean;
    /** message EVERY player the winners list at match end — the report ElGuillermo's CRCON plugin
     *  hll_crcon_live_topstats sends (the idea only; none of its code) — in their one match-end
     *  message, above their own rewards. */
    showEveryone: boolean;
    message: string;
    /** one entry per category; `ranks[i]` is the reward for place i+1 (its length = winners).
     *  `message`: this category's own message; blank = the card's message. */
    categories: { id: TopStatCategory; enabled: boolean; ranks: RewardAmount[]; message?: string }[];
  };
  /**
   * The best squad of each type at each match end — the best infantry squad, tank crew, recon
   * team… — with every member of a placed squad rewarded. A player counts in the squad they spent
   * most of the match in; a squad needs `minMembers` players who played at least `minMinutes`.
   * `scoring` adds the members' numbers up ("total") or averages them, so a short-handed squad can
   * still place on how well its members played.
   */
  bestSquads: {
    enabled: boolean; dryRun: boolean;
    minMinutes: number;
    minPlayers: number;
    minMembers: number;
    metric: SquadMetric;
    scoring: "total" | "average";
    /** broadcast each type's winning squad to the server at match end. */
    broadcast: boolean;
    /** add the squad winners to every player's match-end message, after their own rewards. */
    showEveryone: boolean;
    message: string;
    /** one entry per squad type; `ranks[i]` is what EACH member of the squad in place i+1 gets. */
    types: { id: SquadType; enabled: boolean; ranks: RewardAmount[]; message?: string }[];
  };
  killStreaks: {
    enabled: boolean; dryRun: boolean; message: string;
    /** streaks only count while at least this many are on — a near-empty server is not a streak. */
    minPlayers: number;
    tiers: { kills: number; reward: RewardAmount; message?: string }[];
  };
  playDays: { enabled: boolean; dryRun: boolean; minMinutes: number; message: string; tiers: StreakTier[]; repeatEveryDays: number };
  seedDays: { enabled: boolean; dryRun: boolean; message: string; tiers: StreakTier[]; repeatEveryDays: number };
  /**
   * EVERYONE on the server when a long enough match ends — "a day of VIP for every player online at
   * the end of every match that goes over an hour". Seeded or not, any time of day.
   */
  matchEnd: {
    enabled: boolean; dryRun: boolean;
    /** the match must have run at least this long (start to end). */
    minMatchMinutes: number;
    /** and the player must have been in it at least this long (0 = on at the end is enough). */
    minPlayedMinutes: number;
    /** matches with fewer players than this at the end pay nothing (0 = any). */
    minPlayers: number;
    reward: RewardAmount;
    message: string;
  };
}
export interface GameRewardsConfigRow { serverId: string; config: GameRewardsConfig; updatedAt: string }
const pts = (points: number): RewardAmount => ({ vipHours: 0, points });
export const GAME_REWARDS_DEFAULTS: GameRewardsConfig = {
  order: [...GAME_REWARD_CARDS],
  topStats: {
    enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, broadcast: true, showEveryone: true,
    message: "Top {category} this match — #{rank} with {value}! You earned {reward}.",
    categories: TOP_STAT_CATEGORIES.map((id) => ({
      id, enabled: ["kills", "kd", "teamplay", "offense", "defense", "support", "commander"].includes(id),
      ranks: id === "commander" ? [pts(100)] : [pts(100), pts(50), pts(25)],
    })),
  },
  bestSquads: {
    enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, minMembers: 2, metric: "score", scoring: "total",
    broadcast: true, showEveryone: true,
    message: "Best {squad_type} squad this match — #{rank} with {value}, with {squad_mates}! You earned {reward}.",
    types: SQUAD_TYPES.map((id) => ({ id, enabled: ["infantry", "armor", "recon"].includes(id), ranks: [pts(50)] })),
  },
  killStreaks: {
    enabled: false, dryRun: true, minPlayers: 20,
    message: "{streak} kills without dying — nice! You earned {reward}.",
    tiers: [{ kills: 10, reward: pts(25) }, { kills: 20, reward: pts(75) }, { kills: 30, reward: pts(150) }],
  },
  playDays: {
    enabled: false, dryRun: true, minMinutes: 30,
    message: "{days} days in a row on {server_name} — thanks for playing! You earned {reward}.",
    tiers: [{ days: 3, reward: pts(50) }, { days: 7, reward: pts(150) }, { days: 14, reward: pts(300) }],
    repeatEveryDays: 7,
  },
  matchEnd: {
    enabled: false, dryRun: true, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 0,
    reward: { vipHours: 24, points: 0 },
    message: "Thank you {player_name} for playing on {server_name}! You earned {reward} for a {match_minutes}-minute match. Your VIP now runs until {vip_until}.",
  },
  seedDays: {
    enabled: false, dryRun: true,
    message: "{days} days of seeding in a row — legend! You earned {reward}.",
    tiers: [{ days: 3, reward: pts(100) }, { days: 7, reward: { vipHours: 24, points: 0 } }],
    repeatEveryDays: 7,
  },
};

/**
 * Known ids in the order given, each once, then any the list left out in their default order —
 * so an order saved before a card or category existed still names every one.
 */
export function orderedIds<T extends string>(given: unknown, all: readonly T[]): T[] {
  const seen = new Set<T>();
  for (const id of Array.isArray(given) ? given : []) if ((all as readonly unknown[]).includes(id)) seen.add(id as T);
  for (const id of all) seen.add(id);
  return [...seen];
}

/** A stored config over today's defaults — a section or category added later appears with its
 *  default instead of being missing from a row saved before it existed. Stored ORDER is kept:
 *  cards and categories come back in the order staff arranged them. */
export function mergeGameRewards(raw: unknown): GameRewardsConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof GameRewardsConfig, Record<string, unknown>>> & { order?: unknown };
  const D = GAME_REWARDS_DEFAULTS;
  const storedCats = Array.isArray(r.topStats?.categories) ? (r.topStats!.categories as GameRewardsConfig["topStats"]["categories"]) : [];
  const catOrder = orderedIds(storedCats.map((c) => c?.id), TOP_STAT_CATEGORIES);
  const storedTypes = Array.isArray(r.bestSquads?.types) ? (r.bestSquads!.types as GameRewardsConfig["bestSquads"]["types"]) : [];
  const typeOrder = orderedIds(storedTypes.map((t) => t?.id), SQUAD_TYPES);
  return {
    order: orderedIds(r.order, GAME_REWARD_CARDS),
    topStats: {
      ...D.topStats, ...(r.topStats ?? {}),
      categories: catOrder.map((id) => ({ ...D.topStats.categories.find((d) => d.id === id)!, ...(storedCats.find((c) => c?.id === id) ?? {}) })),
    } as GameRewardsConfig["topStats"],
    bestSquads: {
      ...D.bestSquads, ...(r.bestSquads ?? {}),
      types: typeOrder.map((id) => ({ ...D.bestSquads.types.find((d) => d.id === id)!, ...(storedTypes.find((t) => t?.id === id) ?? {}) })),
    } as GameRewardsConfig["bestSquads"],
    killStreaks: { ...D.killStreaks, ...(r.killStreaks ?? {}) } as GameRewardsConfig["killStreaks"],
    playDays: { ...D.playDays, ...(r.playDays ?? {}) } as GameRewardsConfig["playDays"],
    seedDays: { ...D.seedDays, ...(r.seedDays ?? {}) } as GameRewardsConfig["seedDays"],
    matchEnd: { ...D.matchEnd, ...(r.matchEnd ?? {}) } as GameRewardsConfig["matchEnd"],
  };
}

/** One alert rule: post to a channel, optionally pinging a role. */
export interface DiscordAlertRule {
  enabled: boolean;
  channelId: string | null;
  /** Discord role id to ping (or null for no ping). */
  mentionRoleId: string | null;
}
/** Admin-request alert: an alert rule plus the in-game chat trigger that fires it. */
export interface DiscordAdminPingRule extends DiscordAlertRule {
  trigger: string;
}
/** Ping alerts that fire immediately (with a mention), separate from the batched category relay. */
export interface DiscordAlertsConfig {
  /** a player typing the trigger (default "!admin") in chat → ping staff. */
  adminPing: DiscordAdminPingRule;
  /** a watchlisted player connecting → ping staff. */
  watchlist: DiscordAlertRule;
  /** an auto-mod rule firing (ban/kick/punish/message/blacklist) → report it, e.g. "8 team kills
   *  in 30s → temp ban" lands in the staff channel with the rule name, player, and reason. */
  automation: DiscordAlertRule;
  /** the server going DARK: RCON unanswered for minutes → one alert, and one more when it is
   *  back. The worker already knew; before this it just never told anyone. */
  serverDark: DiscordAlertRule;
}

/** Per-category relay fine-tuning: an optional role pinged with each batch, plus the noise
 *  filters (kills: team kills only; admin: include individual ballots). */
export interface DiscordCategoryOptions {
  /** Discord role id pinged once per posted batch (null/absent = never ping). */
  mentionRoleId?: string | null;
  /** kills category only: drop regular kills, relay ONLY team kills. */
  teamkillsOnly?: boolean;
  /** admin category only: also relay each individual ballot, not just a vote's start and result.
   *  Absent/false is the default — a kick vote on a full server is one line per player. */
  includeVoteBallots?: boolean;
}
/** Per-server Discord relay routing: which event categories post to which channels. The bot token
 *  stays in the environment (a shared secret); only the channel routing lives here so staff can
 *  configure it from the panel. A category relays only when it's enabled AND has a channel id.
 *  `alerts` carries the immediate ping alerts (admin requests, watchlist joins). */
export interface DiscordRelayConfigRow {
  serverId: string;
  /** master switch for relaying this server's events at all. */
  enabled: boolean;
  /** event categories opted into (subset of "kills"|"chat"|"admin"|"connections"|"match"). */
  categories: string[];
  /** category → Discord channel id (or null). */
  channels: Record<string, string | null>;
  /** category → fine-tuning (mention role, team-kills-only, chat keywords). */
  categoryOptions: Record<string, DiscordCategoryOptions>;
  /** immediate ping alerts (independent of the batched category relay above). */
  alerts: DiscordAlertsConfig;
  /** the always-current match board: ONE message per server, edited in place forever. */
  statusBoard: DiscordStatusBoardConfig;
  updatedAt: string;
}

/**
 * A live match board in Discord: one message per server that the worker EDITS on a timer, so the
 * channel holds a single always-current picture of the round rather than a scroll of stale ones.
 * `messageId` is state the worker owns — it is written back after the first post and reused
 * forever, and only cleared if Discord tells us the message is gone.
 */
export interface DiscordStatusBoardConfig {
  enabled: boolean;
  channelId: string | null;
  /** the message being kept current. Null until the first post. */
  messageId: string | null;
  /** how often to redraw. Discord rate-limits edits, so this has a floor. */
  intervalSec: number;
  /**
   * What to print as the board's headline, instead of the server's name.
   *
   * The name a server is advertised under carries its whole rulebook after a pipe, so the board
   * falls back to the part before the first separator — which is a guess, and wrong as often as it
   * is right. This is the operator saying it outright. Null means keep guessing.
   */
  title: string | null;
  /** artwork currently attached to that message. Worker-owned, like `messageId`: it is how the
   *  board knows to re-upload the picture on a map change and to leave it alone otherwise. */
  imageName: string | null;
}
export const DISCORD_STATUS_BOARD_DEFAULTS: DiscordStatusBoardConfig = {
  enabled: false, channelId: null, messageId: null, intervalSec: 60, imageName: null, title: null,
};
/** Editing more often than this earns 429s and buys nothing — a round moves slower than a minute. */
export const DISCORD_STATUS_BOARD_MIN_SEC = 30;
export type DiscordRelayConfigPatch = Partial<Omit<DiscordRelayConfigRow, "serverId" | "updatedAt">>;

export const DISCORD_RELAY_CATEGORIES = ["kills", "chat", "admin", "connections", "match"] as const;
export const DISCORD_ALERTS_DEFAULTS: DiscordAlertsConfig = {
  adminPing: { enabled: false, channelId: null, mentionRoleId: null, trigger: "!admin" },
  watchlist: { enabled: false, channelId: null, mentionRoleId: null },
  automation: { enabled: false, channelId: null, mentionRoleId: null },
  serverDark: { enabled: false, channelId: null, mentionRoleId: null },
};
export const DISCORD_RELAY_DEFAULTS: Omit<DiscordRelayConfigRow, "serverId" | "updatedAt"> = {
  enabled: false,
  categories: ["kills", "admin", "match"], // sensible low-noise default (chat/connections opt-in)
  channels: {},
  categoryOptions: {},
  alerts: DISCORD_ALERTS_DEFAULTS,
  statusBoard: DISCORD_STATUS_BOARD_DEFAULTS,
};

/** A schedule window + population condition (structurally the @app/schedule ScheduleSpec, kept
 *  local so the db package carries no runtime dependency on the scheduler). Blank fields = "any". */
export interface AutoSettingsSpec {
  timezone?: string;
  daysOfWeek?: string[];
  months?: number[];
  years?: number[];
  dates?: string[];
  start?: string;
  end?: string;
  playersBelow?: number;
  playersAbove?: number;
  alliedBelow?: number;
  alliedAbove?: number;
  axisBelow?: number;
  axisAbove?: number;
  teamDiffBelow?: number;
  teamDiffAbove?: number;
  /** minutes the current match has been running: at least (inclusive) / below (strict). */
  matchMinutesAtLeast?: number;
  matchMinutesBelow?: number;
}
/**
 * One timed match message: sent to everyone in game once per match, this many minutes after the
 * match started. Kept apart from profiles on purpose — profiles are first-match-wins, so a message
 * made a profile would take the server away from whichever profile (seeding, night) should own it.
 */
export interface AutoSettingsMatchMessage {
  /** minutes after the match started. */
  minutes: number;
  /** the text; placeholders are filled per player. */
  message: string;
  /** only when at least this many players are on (0 = always). */
  minPlayers: number;
  enabled: boolean;
}
/** How late a timed match message may still go out — a restart or a population that arrives a
 *  few minutes after the mark still gets it; one noticed half an hour late does not. */
export const MATCH_MESSAGE_GRACE_MIN = 5;
export const MATCH_MESSAGE_MAX = 20;
/** One auto-settings profile: when it's active (spec) and the server settings to apply while it is.
 *  A profile with no spec is an unconditional default (put it last). `settings` maps a game config
 *  field key to the value to write. */
export interface AutoSettingsProfile {
  name: string;
  spec?: AutoSettingsSpec;
  settings: Record<string, string | number | boolean>;
  /** Queued as the NEXT map when this profile becomes active — a one-shot on the transition, so a
   *  "seeding" profile can line up a small map without fighting staff over the rotation. */
  nextMap?: string;
  /** Applied when this profile becomes active: replaces this server's profiles, modules and
   *  timezone from the named template. Auto settings reconfiguring itself — the worker guards
   *  against apply loops with a cooldown, and audits every application. */
  applyTemplate?: string;
}

/** A saved, reusable Auto settings configuration: the profiles, player-rule modules and timezone —
 *  everything that describes behaviour, nothing that describes one server's state (enabled and
 *  dry-run stay per-server, so applying a template can never silently arm enforcement). */
/** One named behaviour snapshot of a feature's config — see the FEATURE_PRESETS catalog for what
 *  each feature freezes (always behaviour only, never the enabled/dry-run switches). */
export interface FeaturePresetRow {
  id: string;
  feature: string;
  name: string;
  config: Record<string, unknown>;
  /**
   * The game of the server the snapshot was taken FROM (null on rows saved before this was
   * recorded). Some features' configs only mean something against that game — a seeding preset
   * stores raw role numbers, and role 13 is HLL's Commander but Vietnam's Mortar Support — so
   * game-scoped features refuse to apply a preset across games rather than silently enforcing
   * the wrong roles.
   */
  game: string | null;
  createdByName: string;
  updatedAt: string;
}

export interface AutoSettingsTemplateRow {
  id: string;
  name: string;
  config: { timezone: string; profiles: AutoSettingsProfile[] };
  createdByName: string;
  updatedAt: string;
}
/** Per-server auto-settings: an ordered profile list the worker resolves (first match wins) and
 *  applies whenever the active profile changes. Mirrors CRCON's Auto Settings. */
export interface AutoSettingsConfigRow {
  serverId: string;
  enabled: boolean;
  /** audit-only: log "would apply …" but never write to the game. */
  dryRun: boolean;
  /** default IANA timezone for profiles whose spec doesn't set its own. */
  timezone: string;
  profiles: AutoSettingsProfile[];
  /** messages sent at set times after each match starts — see AutoSettingsMatchMessage. */
  matchMessages: AutoSettingsMatchMessage[];
  updatedAt: string;
}
export type AutoSettingsConfigPatch = Partial<Omit<AutoSettingsConfigRow, "serverId" | "updatedAt">>;

export const AUTOSETTINGS_DEFAULTS: Omit<AutoSettingsConfigRow, "serverId" | "updatedAt"> = {
  enabled: false,
  dryRun: true,
  timezone: "UTC",
  profiles: [],
  matchMessages: [],
};

/** Factory defaults for a server's seeding config (used when none is stored yet). */
export const SEEDING_DEFAULTS: Omit<SeedingConfigRow, "serverId" | "updatedAt"> = {
  enabled: false,
  dryRun: true,
  seedTarget: 40,
  minPlayers: 5,
  disallowedRoles: [],
  disallowedWeaponClasses: [],
  disallowedWeapons: [],
  disallowedWeaponNames: [],
  disallowedCommanderAbilities: [],
  capFightEnabled: false,
  capFightMaxCaps: 3,
  capFightSkipWarning: false,
  capFightNotice: "Attacking the next point while your team is winning",
  containEnabled: false,
  containAutoEnabled: false,
  positionalEnabled: false,
  paceEnabled: false,
  paceUnlockMinutes: [0, 0, 20, 40, 60],
  paceNotice: "",
  layoutLearnEnabled: true,
  containGraceSec: 60,
  containMaxPlayers: 60,
  // Phrased as the offence, like capFightNotice: it renders under "Not allowed while seeding:".
  containNotice: "Going onto the other team's ground (watch the map)",
  containZones: {},
  immuneLevel: 0,
  immuneTags: [],
  announceMessage: "We're seeding the server — special rules apply. Thanks for helping!",
  maxWarnings: 2,
  warnIntervalSec: 60,
  warnMessage: "Seeding rules: {violation}. You'll be punished after {max_warnings} warnings ({received_warnings} so far).",
  maxPunishes: 2,
  punishIntervalSec: 60,
  punishMessage: "Seeding rules: {violation}. You've been punished ({received_punishes}/{max_punishes}).",
  kickAfter: true,
  kickMessage: "You kept violating the seeding rules after multiple warnings and punishments.",
  rewardEnabled: true,
  rewardHours: 24,
  rewardBridge: [],
  // Off until a community says otherwise: an install that upgrades into this feature must not
  // start handing out currency because it happened to have an economy configured.
  rewardPoints: 0,
  minSeedMinutes: 15,
  rewardCumulative: true,
  // `{reward}` composes whichever halves are switched on ("24h of VIP", "500 Points", or both),
  // so one message reads correctly in every combination. The individual tokens are still there
  // for staff who want to write their own sentence.
  rewardMessage: "Thanks for helping us seed! You've been granted {reward}.",
  rewardLinkedNote: "This server offers {currency} rewards for seeding — you're linked and earned {reward_points}. Your total is {balance}.",
  rewardUnlinkedNote: "This server offers {currency} rewards for seeding — you're unlinked and could have earned {reward_points}. Visit our Discord to link, it's free.",
  rewardDelaySec: 3600, // 1 hour — a seeder paid in the last hour is thanked, not paid again
  rewardRepeatMessage: "The server is seeded — thanks for helping! You were already rewarded for seeding in the last {window}, so this round's reward goes to new seeders.",
  phaseConfirmSec: 60, // count must hold ~60s before a phase change commits (ignores brief spikes/dips)
  phaseHysteresis: 3, // fall back to the lower phase only once the count drops 3 below the boundary
  checkSec: null, // the install's default check speed
  chaseCheckSec: null,
};

/**
 * The seed reward's fields — what the Seeding rewards permission answers for (migration 156 carved
 * it off seeding.config). Read without it, the config comes back without these; a save that
 * changes one, or a saved setup that would, needs it at write.
 */
export const SEEDING_REWARD_KEYS = [
  "rewardEnabled", "rewardHours", "rewardPoints", "rewardBridge", "minSeedMinutes", "rewardCumulative",
  "rewardMessage", "rewardLinkedNote", "rewardUnlinkedNote", "rewardDelaySec", "rewardRepeatMessage",
] as const satisfies readonly (keyof SeedingConfigRow)[];

/** Accrued presence for one player during the CURRENT seeding cycle of a server. */
export interface SeedProgressRow {
  serverId: string;
  playerId: string;
  playerName: string | null;
  seconds: number;
  updatedAt: string;
}

/** Runtime seeding phase for a server, written by the worker so the UI can show live status. */
/** The last FINISHED seed cycle — what "pay last seed" replays when a payout was missed
 *  (the worker restarted across the go-live line, or the server drained unwatched). */
export interface SeedCycleRecord {
  /** when the cycle ended (ISO). */
  endedAt: string;
  /** whether a reward round fired for this cycle when it ended — a paid cycle is not replayable.
   *  A DRY-RUN round is not a paid one: it granted nothing, so it stays replayable. */
  rewarded: boolean;
  /** false when the cycle ended by draining back to idle — the seed never went live, so there is
   *  no missed payout to replay. Absent on older records (read as went-live). */
  wentLive?: boolean;
  /** the go-live landed inside the reward delay after a paid round and was suppressed on purpose
   *  (a flap across the line) — not a missed payout either. */
  debounced?: boolean;
  /** the reward round's id — a retry reuses it, so its receipts join the round's and a points
   *  credit that already landed is recognised by the ledger instead of paid twice. */
  round?: string;
  /** seeders whose payment did not complete, and exactly which parts are still OWED — a retry
   *  pays those parts and nothing else (VIP already extended must not be extended again). */
  failed?: SeedFailure[];
  entries: { playerId: string; name: string | null; seconds: number }[];
}

/** One seeder a reward round did not finish paying. */
export interface SeedFailure {
  playerId: string;
  name: string | null;
  needVip: boolean;
  needPoints: boolean;
  needBridge: boolean;
  reason: string;
}

/** The seeders a "retry failed" would pay: only after the round itself paid (an unpaid cycle is
 *  replayed whole instead), and only those with a part still owed. */
export function seedCycleRetryable(c: SeedCycleRecord | null): SeedFailure[] {
  if (!c || !c.rewarded) return [];
  return (c.failed ?? []).filter((f) => f.needVip || f.needPoints || f.needBridge);
}

/** Why an archived cycle may NOT be replayed by "pay last seed", or null when it may. The API
 *  refuses with it and the worker re-checks it at payment time, so a cycle archived between the
 *  click and the tick can never be paid twice. */
export function seedCycleReplayRefusal(c: SeedCycleRecord | null): string | null {
  if (!c) return "no finished seed cycle on record yet — the worker archives one whenever a seed ends";
  if (c.rewarded) return "the last seed cycle already paid out — paying it again would double the reward";
  if (c.wentLive === false) return "the last seed drained back to idle without going live — there was no payout to miss";
  if (c.debounced) return "the last go-live landed inside the reward delay after a paid round, and was skipped on purpose so a flapping count is not paid twice";
  return null;
}

/** One layer's learned-geometry votes: how many rounds put the attack axis on x or y, with the
 *  Allies at the negative or positive end. A round votes once its players' trips out of their own
 *  end agree (the worker's foldTravel). */
export interface MapLayoutRow {
  mapId: string;
  xNeg: number; xPos: number; yNeg: number; yPos: number;
  /** the team-centre split (world cm) the old spawn-reading votes carried; travel votes record 0. */
  separation: number;
  updatedAt: string;
}

export interface SeedingStateRow {
  serverId: string;
  phase: "idle" | "seeding" | "live";
  liveCount: number;
  seederCount: number;
  /** when the last reward round fired (ISO), for the reward-delay debounce; null if never. */
  lastRewardAt: string | null;
  /** a "pay last seed" is waiting — read with the state the worker loads every tick anyway, so the
   *  consuming UPDATE only runs when there is something to consume. Read-only (set via requestPay). */
  payRequested?: boolean;
  updatedAt: string;
}

/** One automod framework module's config for one server. `config` is the resolved blob (module
 *  fields + standard fields, minus enabled/dryRun which are their own columns). */

/** A staff-set DISPLAY name override for a map, keyed by (game, raw map id). Cosmetic only — all
 *  logic (placement, rotation, votes) keys off the raw map id; this just changes what's shown. */
export interface MapNameRow {
  game: string;
  mapId: string;
  /** null when this row only carries a family override. */
  displayName: string | null;
  /** staff-set family, overriding the one inferred from the map id. null = use the inferred one. */
  family: string | null;
  updatedAt: string;
}

/** One taught objective option: where a map's Row r · Option i sits, and what it is called. */
export interface ObjectivePointRow {
  game: string;
  /** the map FAMILY key (zoneKeyOf) — objectives are the map's, not a mode/time variant's. */
  mapKey: string;
  /** 0–4: which of the five sector strips. */
  row: number;
  /** 0–2: which option within the strip. */
  idx: number;
  /** the community's name for the location — Vietnam's wire offers only digits. */
  name: string | null;
  /** the tactical-map cell ("E6") it sits in — what the picker highlights. */
  sector: string | null;
  updatedAt: string;
}

/**
 * The countdown behind "save this layout for the next N plays" (HLL: Vietnam only). The game
 * stores a layout forever; the worker owns the expiry: each NEW round of the map decrements
 * `playsLeft`, and at zero it sends RemoveSectorLayout — back to the server's own picks. No row
 * for a (server, map) means the saved layout stands until somebody clears it.
 */
export interface ObjectiveLayoutExpiryRow {
  serverId: string;
  mapId: string;
  playsLeft: number;
  /** the last match counted — or the one already running at save time, which the no-restart
   *  save does not affect — so one round is never counted twice. */
  lastMatchId: string | null;
  setBy: string;
  updatedAt: string;
}

/**
 * One of a removed objective preset's five picks ("Map points"): the option (0–2) within that
 * sector strip, and the game's own string for it when one was known. In a picks array, `null` is
 * Random. Only a leftover pending row still carries them (see mapPointPending).
 */
export interface MapPointPick {
  idx: number;
  name: string | null;
}

/**
 * Where a press's preset objectives stand:
 * - "await_load" (WW2): the switch is sent; the picks go out once the new map has LOADED — the
 *   game only takes a layout for the match in play, and restarts the round to do it.
 * - "arming" (Vietnam): written BEFORE the layout is stored on the game server, so a crash
 *   between the store and the switch still leaves a record of what to put back.
 * - "armed" (Vietnam): stored and switched; the round takes the stored layout when it loads, and
 *   the worker then puts back whatever the server had stored before.
 */
export type MapPointPendingPhase = "await_load" | "arming" | "armed";

/** A press the removed objective presets left in flight on a server — at most one row each. */
export interface MapPointPendingRow {
  serverId: string;
  /** minted by the store on every insert and every set. Every later write names it, so an actor
   *  still holding an older row misses instead of acting on the press that replaced it. */
  id: string;
  game: string;
  mapKey: string;
  modeKey: string;
  /** the target layer, spelled the way the server spelled it. */
  mapId: string;
  /** the session's map at press time, when it could be read. */
  beforeMapId: string | null;
  phase: MapPointPendingPhase;
  /** the preset's picks AS PRESSED — an edit while the press is in flight does not change it. */
  picks: (MapPointPick | null)[];
  /** Vietnam: the MapId the layout is stored under on the game server. */
  storedMapId: string | null;
  /** Vietnam: the five indices this press stored. The put-back only undoes them while they still
   *  stand — a layout staff stored over them since is theirs. */
  storedIndices: number[] | null;
  /** Vietnam: the indices an EARLIER press stored under the same key, when this press carried its
   *  row (and so its restore); null = nothing carried. Either list standing is ours to undo
   *  (planUndo) — when a store's answer is lost, nobody can tell which one stands, and a put-back
   *  judging by one list would read the other as staff's and leave a preset stored for good. */
  carriedIndices: number[] | null;
  /** Vietnam: what was stored for storedMapId before this press; null = nothing, so the put-back
   *  removes the entry instead of restoring one. */
  restore: number[] | null;
  /** the match open at press time — never mistaken for the new map's round. */
  baselineMatchId: string | null;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  /** set while one actor is applying or putting back; null = free to claim. */
  claimedAt: string | null;
}

/**
 * The community's signature settings: the two optional lines appended to what a player is shown,
 * and which actions want which half. One row for the whole community — a signature is the
 * community's voice, and keeping three servers' wording in step by hand is not a feature.
 */
export interface SignatureConfigRow {
  /** Template for the staff line; `{staff}` becomes the acting staff member's panel name. */
  staffLine: string;
  /** Free text appended verbatim — a Discord invite, a rules link, an appeals note. */
  customLine: string;
  /** Per action, which halves apply. Absent = neither. */
  actions: SignatureActionMap;
  updatedAt: string;
}
export interface SignatureConfigPatch {
  staffLine?: string;
  customLine?: string;
  actions?: SignatureActionMap;
}
export const SIGNATURE_DEFAULTS = { staffLine: "- {staff}", customLine: "", actions: {} as SignatureActionMap } as const;

/**
 * One visit to the admin camera: who, where, from when to when.
 *
 * `exitedAt`/`durationSec` are null while the session is still open — somebody is in cam right
 * now — which the history table reads as "still in" rather than as a broken row.
 */
export interface AdminCamSessionRow {
  id: string;
  serverId: string;
  /** null once the player row is merged away or deleted; `playerName` is the durable record. */
  playerId: string | null;
  playerName: string;
  enteredAt: string;
  exitedAt: string | null;
  durationSec: number | null;
}

/** How a history read is narrowed and ordered. Sorting is done in the STORE, not on the page,
 *  because the list is paged and sorting one page is not sorting the list. */
export interface AdminCamQuery {
  serverId?: string;
  /** Restrict to server ids the viewer may see. Empty array means "no servers", not "all". */
  serverIds?: string[];
  playerId?: string;
  /** Case-insensitive substring of the admin's name. */
  q?: string;
  limit?: number;
  offset?: number;
  sort?: AdminCamSort;
  dir?: "asc" | "desc";
}
export const ADMIN_CAM_SORTS = ["entered", "exited", "duration", "who", "server"] as const;
export type AdminCamSort = (typeof ADMIN_CAM_SORTS)[number];

/** Per-server: whether entering the admin camera is announced in game, and what it says. */
export interface AdminCamConfigRow {
  serverId: string;
  notifyEnabled: boolean;
  /** `{player}` is replaced with the IN-GAME name from the log line — not the panel/Discord name,
   *  which is what `{staff}` means on a signature. Blank = say nothing for that half. */
  enterMessage: string;
  exitMessage: string;
  updatedAt: string;
}
export interface AdminCamConfigPatch {
  notifyEnabled?: boolean;
  enterMessage?: string;
  exitMessage?: string;
}
export const ADMIN_CAM_DEFAULTS = {
  notifyEnabled: false,
  enterMessage: "An admin is now watching. {player}",
  exitMessage: "",
} as const;

/**
 * A named map set in the community-wide library: which maps a vote may offer, with no opinion about
 * when. Shared by every server — the same curated pool is built once and used everywhere — and
 * plain editable data, including the starter rows the migration seeds.
 *
 * `name` is the link target (a server's config stores the name, so the stored JSON stays readable
 * by eye), and it is unique case-insensitively for that reason.
 */
export interface MapSetRow {
  id: string;
  name: string;
  /**
   * Which game's maps this set is made of. Shared by every server RUNNING THAT GAME — a pool of map
   * ids means nothing to a game that does not have those maps, so "community-wide" stops at the
   * game boundary and a pairing across it is refused rather than left to fail at vote time.
   */
  game: string;
  /** pool overrides layered over the engine's defaults — the MapPoolConfig partial. */
  pool: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A named zone-set in the library: 10×10 sector paints (A1–J10, the tactical map's own grid),
 * one paint per map family, for one game. The out-of-zone enforcer rules reference a set by id;
 * `zones` is { [zoneKeyOf mapKey]: { allies, axis, shared } } — the exact shape the seeding
 * containment paint already stores, so the two speak one vocabulary.
 */
export interface MapZoneSetRow {
  id: string;
  name: string;
  game: string;
  zones: Record<string, { allies: string[]; axis: string[]; shared: string[] }>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A named schedule in the library: WHEN something applies — days, a time window, a player range —
 * with no opinion about what. Deliberately a record of its own rather than a field of a map set:
 * "Friday teatime" is one timing many sets can share, and welding it to one set meant re-entering
 * it every time.
 */
export interface VoteScheduleRow {
  id: string;
  name: string;
  /** the ScheduleSpec, opaque here and validated by the API layer. */
  spec: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** One line of a server's vote setup: use THIS library set, on THAT library schedule (null = all
 *  the time). Order is priority — first match wins. */
export interface MapVoteLink {
  mapSet: string;
  schedule: string | null;
}

/** Per-server map-vote config: an ordered list of scheduled pool profiles. `profiles` is opaque JSON
 *  to the db (validated + typed as MapVoteProfile[] by the API/maps layer). */
export interface MapVoteConfigRow {
  serverId: string;
  /** master switch for the automated match-end vote loop. */
  enabled: boolean;
  /** vote surface: "native" = Discord native poll (REST); "embed" = custom embed (later). */
  surface: string;
  /** Discord channel id to post the poll into (null = no Discord vote). */
  channelId: string | null;
  /** poll duration in hours (Discord poll). */
  pollHours: number;
  timezone: string;
  /**
   * The pairings RESOLVED against the library — `[{ name, spec, pool }]`, exactly the shape the
   * vote engine and the coverage map take. Nothing downstream of the store has to know the settings
   * now live in two shared tables.
   */
  profiles: Record<string, unknown>[];
  /** What is actually stored: which library set, on which library schedule, in priority order. The
   *  editor works on these; everything else works on `profiles`. */
  profileLinks: MapVoteLink[];
  /** in-game broadcast nudges after MATCH START (e.g. "vote on Discord"). */
  reminders: MapVoteReminder[];
  /** keep the next map continuously set to whichever option is currently winning, instead of only
   *  deciding once the match ends. If the match ends early the right map is already queued. */
  liveApply: boolean;
  /** after a match ends, ignore live-leader changes for this many seconds (the new poll's first few
   *  votes are noise, and the map for the match just started is already locked in). */
  postMatchApplyDelaySeconds: number;
  /** after a match ends, wait this long before opening the replacement vote, so players who are
   *  still loading in get to see it. */
  pollResetDelaySeconds: number;
  /** Clear everything this bot has left in the vote channel when a new vote opens, so it holds one
   *  live ballot rather than a growing wall of spent ones. That means the closed polls AND the
   *  message Discord posts itself each time a poll ends ("…'s poll has closed!"), which outlives
   *  the poll it describes. Messages posted by PEOPLE are never touched, and the panel's vote
   *  history keeps every tally regardless. */
  tidyChannel: boolean;
  /** pause voting automatically while the server has fewer than this many players (0 = never). */
  pauseBelowPlayers: number;
  /**
   * The two registered-only gates, one per surface. Registered = a Discord account linked to a
   * game account (the VIP panel registration). Independent on purpose — the common posture is
   * "anyone may click the Discord poll, but an in-game vote must come from a registered player":
   *
   *  - `registeredOnlyIngame`: in-game chat votes from unlinked players are not counted.
   *  - `registeredOnlyDiscord`: unregistered Discord clicks are discounted at the exact close
   *    (the poll card still shows them; the posted result is the counted tally).
   *
   * LINKED voters are deduplicated across the two surfaces regardless of either gate — their
   * in-game ballot carries their real Discord id, and the Discord ballot wins a conflict.
   */
  registeredOnlyIngame: boolean;
  registeredOnlyDiscord: boolean;
  /** what a worker restart should do to this server's vote. See MAPVOTE_STARTUP_STATES. */
  startupState: MapVoteStartupState;
  updatedAt: string;
}

/**
 * What happens to the vote when the worker process starts.
 *
 * Our paused flag lives in the database, so by default a restart simply resumes whatever posture the
 * vote was already in — that is `remember`, and it is what you want almost always.
 *
 * The other two exist because "whatever it was" is sometimes exactly wrong:
 *  - `paused` is the old bot's `startup_state: "paused"` behaviour. A server that should normally be quiet
 *    (an events or CvC server) starts paused every time, so a manual resume is understood to last
 *    until the next restart rather than forever.
 *  - `active` is the opposite guard: if the process died while the vote happened to be paused, this
 *    stops the pause outliving the crash that caused it.
 */
export const MAPVOTE_STARTUP_STATES = ["remember", "paused", "active"] as const;
export type MapVoteStartupState = (typeof MAPVOTE_STARTUP_STATES)[number];

/** One in-game nudge: how long after the match starts to broadcast it, and what it looks like.
 *  `layout` picks what follows the message: nothing, the map names, or the map names with their
 *  current vote counts. */
export interface MapVoteReminder {
  minutesAfterMatchStart: number;
  message: string;
  layout?: MapVoteMessageLayout;
}
export const MAPVOTE_MESSAGE_LAYOUTS = ["none", "map_list", "vote_counts"] as const;
export type MapVoteMessageLayout = (typeof MAPVOTE_MESSAGE_LAYOUTS)[number];

export interface MapVoteConfigPatch {
  tidyChannel?: boolean;
  enabled?: boolean;
  surface?: string;
  channelId?: string | null;
  pollHours?: number;
  timezone?: string;
  /** The pairings to store. Named `profiles` because that is still the column; the values are
   *  MapVoteLink, not whole profiles. */
  profiles?: MapVoteLink[];
  reminders?: MapVoteReminder[];
  liveApply?: boolean;
  postMatchApplyDelaySeconds?: number;
  pollResetDelaySeconds?: number;
  pauseBelowPlayers?: number;
  registeredOnlyIngame?: boolean;
  registeredOnlyDiscord?: boolean;
  startupState?: MapVoteStartupState;
}

/** Runtime state of the automated map vote for a server: the active Discord poll (if any) and the
 *  match-end cursor, written by the worker. */
export interface MapVoteStateRow {
  serverId: string;
  /** Discord message id of the open poll, or null when no poll is active. */
  activeMessageId: string | null;
  activeChannelId: string | null;
  /** poll options in order: [{ id: rawMapId, name: displayName }]. */
  options: { id: string; name: string }[];
  /** name of the profile the active poll was composed from. */
  profile: string | null;
  openedAt: string | null;
  /** timestamp of the last MATCH ENDED we acted on (dedupe cursor). */
  lastMatchEndAt: string | null;
  /** staff paused the automated loop (no polls open; active one is closed). */
  paused: boolean;
  /** why it is paused: "staff" (someone pressed pause) or "empty" (the server dropped below the
   *  configured player count). Only an "empty" pause lifts itself again. */
  pauseReason: string | null;
  /** the options of the poll that was open when voting paused. Resuming puts THESE back up, so a
   *  pause is a genuine pause rather than a restart. */
  savedOptions: { id: string; name: string }[];
  /** Discord message id of the "voting is paused" notice, so resuming can clear it. */
  pauseNoticeId: string | null;
  /** staff-forced next map (raw id) — applied instead of the vote winner until cleared. */
  overrideMapId: string | null;
  /** rolling list of recently-played raw map ids (newest first) for poll exclusion. */
  recentMaps: string[];
  /** latest vote counts, index-aligned with `options`. Parked here by the worker (which owns all
   *  Discord I/O) so the panel reads a durable snapshot instead of every viewer hitting Discord. */
  tallies: number[];
  talliedAt: string | null;
  /** The ballot closed most recently, kept only until the next one opens so the worker can clear
   *  it from the channel (see mapvote_config.tidyChannel). Null once it has been removed. */
  lastClosedMessageId: string | null;
  lastClosedChannelId: string | null;
  /** staff asked to abandon the current vote — the worker closes it without applying a winner. */
  skipNext: boolean;
  /** staff asked for a fresh set of options — the worker reopens the poll on its next pass. */
  reroll: boolean;
  /** staff asked to start a vote right now: unpause, drop any override, bin whatever is open and
   *  put up a brand-new vote. The emergency button. */
  startNow: boolean;
  /** staff asked to re-read the server's map list from scratch and then start a fresh vote — for
   *  when the game added maps and our catalogue is stale. */
  resyncNow: boolean;
  /** staff asked to push the vote to everyone in game right now, in this layout. Cleared once sent. */
  sendMessageLayout: string | null;
  /** the map the live-leader tracker most recently queued, so an unchanged leader isn't re-applied
   *  on every pass. */
  liveAppliedMapId: string | null;
  /**
   * Why the next map is NOT currently tracking the vote leader ("nobody has voted yet", "settling
   * after the last match (240s left)"), or null while it is tracking. The worker always knew this
   * and only ever logged the success case, which made a silently-declining tracker indistinguishable
   * from a working one. The panel shows this string beside "Next map".
   */
  liveApplyNote: string | null;
  /**
   * The in-game ballot's counted voters, per option in the ballot's order, as the worker last read
   * them, for the vote whose message id they carry, so a new ballot never shows the last one's.
   * Null until an in-game vote has been read. The public API's vote_status lists them, as CRCON
   * lists its voters; Discord voters are never kept here.
   */
  ingameVoters: { messageId: string; voters: MapVoteIngameVoter[][] } | null;
  /** don't open the next vote before this time (the post-match settle delay). */
  reopenAt: string | null;
  /**
   * A staff member changed the map BY HAND: until this instant the vote loop stands down — the
   * open vote (whose round the human just ended) is closed without applying a winner, nothing is
   * queued, and no new poll opens. The point is that automation must never fight a human's pick;
   * the window is staff's chance to pause or switch voting off if the change is meant to stick.
   * Written by the map-change action, cleared by the worker when it expires (or by Start vote —
   * the emergency button still outranks everything). Null = no hold.
   */
  manualHoldUntil: string | null;
  /**
   * Why the worker last failed to OPEN a poll ("only 1 option composed…", a Discord error), or null
   * once one opens. Exists because every failure to open used to be a warn in the worker's log and
   * nothing anywhere else — the control page said "no poll is open" and sat there, and pressing
   * Start vote again just failed silently again. The panel shows this string.
   */
  lastOpenError: string | null;
  updatedAt: string;
}

/** One counted in-game ballot: the name it was typed under, and the game's own player id where the
 *  log gave one (null for a ballot matched by name). */
export interface MapVoteIngameVoter { name: string; playerId: string | null }

/**
 * The fields of the vote state a single decision touches. `serverId` identifies the row and
 * `updatedAt` is stamped by the store, so neither is patchable.
 */
export type MapVoteStatePatch = Partial<Omit<MapVoteStateRow, "serverId" | "updatedAt">>;

/** One concluded vote: what was offered, how it went, what was chosen and why. */
export interface MapVoteHistoryRow {
  id: string;
  serverId: string;
  decidedAt: string;
  profile: string | null;
  /** the options as offered, with their final vote counts. */
  options: MapVoteHistoryOption[];
  winnerId: string | null;
  winnerName: string | null;
  totalVotes: number;
  /** why this vote ended: it was counted, staff forced a map, staff skipped it, nobody voted, it
   *  was replaced by a staff-started vote, or something went wrong. */
  outcome: "vote" | "override" | "skipped" | "no_votes" | "restarted" | "held" | "error";
  /** whether the winning map was actually set on the server (observe mode records but never applies). */
  applied: boolean;
}
export interface NewMapVoteHistory extends Omit<MapVoteHistoryRow, "id" | "decidedAt"> { decidedAt?: string }

/** One option as it was offered, plus — where the vote surface can tell us — exactly who picked it.
 *  Recording the ballot is what turns "Foy got 7 votes" into "these seven people wanted Foy", which
 *  is what per-player voting history is built from. */
export interface MapVoteHistoryOption {
  id: string;
  name: string;
  votes: number;
  /** the Discord accounts that voted for this option. Absent (not empty) when the surface could not
   *  identify voters, so "nobody voted" and "we couldn't tell" stay distinguishable. */
  voters?: MapVoteVoter[];
}
export interface MapVoteVoter { discordId: string; name: string }

/** One person's pick in one concluded vote — the ballot, flattened for querying. Stored alongside
 *  the history row so "what does this player usually vote for" is an indexed lookup rather than a
 *  scan through JSON. */
export interface MapVoteBallotRow {
  id: string;
  historyId: string;
  serverId: string;
  decidedAt: string;
  mapId: string;
  mapName: string;
  discordUserId: string;
  discordName: string;
  /** whether the map this person voted for is the one that ended up being played. */
  won: boolean;
}

/** How often one Discord account votes, and how often their pick is the one that gets played. */
export interface MapVoteVoterSummary {
  /** The identity the ballot was counted under: a Discord id, or "player:<key>" for an in-game
   *  voter with no linked Discord (see the in-game vote surface). */
  discordUserId: string;
  discordName: string;
  votes: number;
  wins: number;
  lastVotedAt: string;
  /** the panel user + game player this Discord account is linked to, when it is linked. */
  userId: string | null;
  playerId: string | null;
  playerName: string | null;
  /** True when this identity is an unlinked IN-GAME voter. They are not a Discord account at all,
   *  so "not linked to a game account" is exactly backwards for them — they are a game account
   *  with no Discord. Their playerId resolves from the id itself where the log gave us one. */
  ingame: boolean;
}

/** One person's taste in maps: how often they voted for each, and how often it then got played. */
export interface MapVotePreference {
  mapId: string;
  name: string;
  votes: number;
  wins: number;
  lastVotedAt: string;
}

/** How often a map has been offered and how often it won — map popularity from evidence. */
export interface MapVoteTally {
  mapId: string;
  name: string;
  offered: number;
  won: number;
  votes: number;
}

/** A background service's last-known state, upserted by the process that runs it. */
export interface HeartbeatRow {
  name: string;
  status: string; // running | stopped | fatal | exited (process-reported)
  detail: Record<string, unknown> | null;
  updatedAt: string;
}

/** A saved UI layout for a surface, scoped to the whole instance or to one user. */
export type LayoutScope = "instance" | "user";
export interface LayoutRow {
  id: string;
  scopeType: LayoutScope;
  /** "" for instance scope; a user id for user scope. */
  scopeId: string;
  surface: string;
  config: Record<string, unknown>;
  updatedAt: string;
}

export interface Repository {
  users: {
    create(input: { username: string; passwordHash?: string | null; email?: string | null; discordId?: string | null; discordUsername?: string | null; discordNick?: string | null; discordManaged?: boolean }): Promise<UserRow>;
    findById(id: string): Promise<UserRow | null>;
    findByUsername(username: string): Promise<UserRow | null>;
    /** Locate a user by their linked Discord account id (for OAuth sign-in). */
    findByDiscordId(discordId: string): Promise<UserRow | null>;
    /**
     * The id of the install's FIRST created account — "the login that set HellRCON up".
     * Earliest `createdAt` wins, id as the tie-break so the answer never flaps. This is an
     * identity fact, not a grant: decommissioning and deleting a server are gated on BEING this
     * account, precisely so no permission anyone can hand out holds those keys. Null only on an
     * install with no users yet (which cannot be making authenticated calls anyway).
     */
    firstUserId(): Promise<string | null>;
    count(): Promise<number>;
    list(): Promise<UserRow[]>;
    /** Every user with a linked Discord account, managed or not — the background sweep's list.
     *  It is deliberately wider than "Discord-managed": whose roles Discord controls decides
     *  whether the sweep RE-APPLIES roles, but everyone linked needs their NAME kept current. */
    listDiscordLinked(): Promise<UserRow[]>;
    /** Attach/refresh the linked Discord identity on a user. Called on every Discord login AND by
     *  the background sweep, so a renamed member's display name never goes stale. */
    linkDiscord(id: string, input: { discordId: string; username?: string | null; nick?: string | null; managed?: boolean }): Promise<UserRow | null>;
    /** Stamp "this user has seen the announcements board as of now". */
    setAnnouncementsSeen(id: string): Promise<void>;
    /**
     * Display preferences that belong to the PERSON, not the browser: theme, accent colour,
     * density, landing view, remembered tabs. Schemaless on purpose — a column per toggle would
     * mean a migration every time the panel grows one. One key is read by the server: which phone
     * notifications the person wants (`phoneAlerts`, see the API's phone-alerts.ts).
     */
    getPrefs(id: string): Promise<Record<string, unknown>>;
    /** Merge a patch over the stored prefs (the panel saves one setting at a time). */
    setPrefs(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Toggle whether a linked user's roles are Discord-managed (false = admin hand-tunes them). */
    setDiscordManaged(id: string, managed: boolean): Promise<UserRow | null>;
    /**
     * End every web session this account has, by moving it to the next session epoch. Returns the
     * new epoch, or null if there is no such user.
     *
     * This is the lockout that did not exist. Resetting a password deliberately leaves sessions
     * alone — that route is for a staffer who forgot theirs, and the sessions it would kill are
     * usually the same person's — so before this the only way to stop a leaked credential was to
     * delete the account, taking its roles, grants and Discord link with it.
     *
     * It does NOT touch API tokens: those are separate stored credentials with their own list and
     * their own revoke. The caller that means "lock this account out" has to do both, and the route
     * that does says so.
     */
    revokeSessions(id: string): Promise<number | null>;
    /** Delete a user (their tokens, grants, and limits go too; audit rows keep the name, lose the id). */
    remove(id: string): Promise<boolean>;
    /** Merge `duplicateId` into `survivorId` and delete the duplicate: audit rows (actor + user
     *  targets), player-note/announcement authorship, and announcement reads (keeping the earliest
     *  read/ack per notice) all move to the survivor. The survivor keeps its OWN roles, grants,
     *  limits, and tokens — the duplicate's die with it. If the survivor has no Discord identity
     *  and the duplicate does, the identity (id, names, managed flag) transfers, so a manual
     *  account absorbs its auto-created Discord twin. Null when either id is missing or equal. */
    merge(survivorId: string, duplicateId: string): Promise<UserRow | null>;
    setPassword(id: string, passwordHash: string): Promise<boolean>;
  };
  /** Discord role → panel role mapping, the source of truth for Discord-provisioned permissions. */
  discordRoleMap: {
    list(): Promise<DiscordRoleMapRow[]>;
    /**
     * Replace the whole set of panel roles a given Discord role grants (empty clears it).
     * Each assignment carries the scope it applies on, so one Discord role can confer a role
     * globally, on one server, or on several — as separate assignments of the same role.
     */
    setForDiscordRole(discordRoleId: string, discordRoleName: string | null, assignments: RoleAssignment[]): Promise<void>;
    remove(discordRoleId: string): Promise<boolean>;
  };
  /** Per-user action limits (e.g. tempban.maxHours) — numeric caps refining a capability. */
  userLimits: {
    get(userId: string): Promise<Record<string, number>>;
    /** Replace the user's whole limit set (empty object clears everything). */
    replace(userId: string, limits: Record<string, number>): Promise<void>;
  };
  /** Custom named roles: a reusable permission bundle (global grants + limits). Users can hold
   *  several; their effective access is the union of their roles plus individual grants. */
  roles: {
    list(): Promise<RoleRow[]>;
    get(id: string): Promise<RoleRow | null>;
    /** Several roles in one query. Every authenticated request resolves the caller's roles, so this
     *  is the difference between one round trip and one per role held. Missing ids are skipped. */
    getMany(ids: string[]): Promise<RoleRow[]>;
    findByName(name: string): Promise<RoleRow | null>;
    create(input: NewRole): Promise<RoleRow>;
    update(id: string, patch: Partial<Omit<NewRole, "createdByName">>): Promise<RoleRow | null>;
    remove(id: string): Promise<boolean>;
  };
  userRoles: {
    /** roles held by a user, each with the scope it applies on. */
    listByUser(userId: string): Promise<RoleAssignment[]>;
    /** The same, for many users in one round trip — the staff/user listings resolve every row's
     *  roles at once, and one query beats one per person on every page load. Users with no roles
     *  are simply absent from the map. */
    listByUsers(userIds: string[]): Promise<Map<string, RoleAssignment[]>>;
    /** user ids holding a role, at any scope. */
    members(roleId: string): Promise<string[]>;
    /** User ids holding any of these roles EVERYWHERE (an assignment with no server scope). The
     *  owner check needs unscoped specifically — a role held on one server is not ownership. */
    unscopedMembersOf(roleIds: string[]): Promise<string[]>;
    /** user ids holding any of these roles EVERYWHERE (an assignment with no server scope). The
     *  owner check needs unscoped specifically: a role held on one server is not ownership. */
    unscopedMembersOf(roleIds: string[]): Promise<string[]>;
    /** replace a user's whole role set. */
    set(userId: string, assignments: RoleAssignment[]): Promise<void>;
  };
  tokens: {
    create(input: { userId: string; name: string; tokenHash: string; expiresAt?: string | null }): Promise<ApiTokenRow>;
    findByHash(tokenHash: string): Promise<ApiTokenRow | null>;
    /** The caller's tokens (secrets excluded by the API layer), newest first. */
    listByUser(userId: string): Promise<ApiTokenRow[]>;
    /** Revoke one of the user's tokens; false if it isn't theirs / doesn't exist. */
    remove(id: string, userId: string): Promise<boolean>;
    /** Revoke ALL of a user's tokens at once, returning how many went. The account-lockout path:
     *  a compromised account's own minted token is how an attacker survives losing the session. */
    removeAllForUser(userId: string): Promise<number>;
  };
  /** The devices taking phone notifications (PushSubscriptionRow). They go with their account. */
  pushSubscriptions: {
    list(): Promise<PushSubscriptionRow[]>;
    listByUser(userId: string): Promise<PushSubscriptionRow[]>;
    get(endpoint: string): Promise<PushSubscriptionRow | null>;
    /** Keyed by endpoint: the same browser turned on again — or by someone else, on a shared
     *  computer — replaces the row, keeping when it was first turned on. */
    upsert(row: Omit<PushSubscriptionRow, "createdAt">): Promise<PushSubscriptionRow>;
    remove(endpoint: string): Promise<boolean>;
  };
  servers: {
    create(input: NewServer): Promise<ServerRow>;
    findById(id: string): Promise<ServerRow | null>;
    /**
     * Locate a server by its connection endpoint.
     *
     * Discovery's FALLBACK match, not its primary one: an address identifies where a server can be
     * reached today, never which server it is. See `findBySeedSlot` for the identity that survives
     * a move.
     */
    findByHostPort(host: string, port: number): Promise<ServerRow | null>;
    /**
     * Locate the server a given `SERVER_<n>_*` env block seeded — discovery's identity check.
     *
     * The address cannot serve as identity, because moving a server to a new ip/port/password
     * leaves it the same server with all the same records; matching on the address made a moved
     * server look unknown and the next boot cloned it as a second, empty row. The slot number does
     * not move with the server.
     */
    findBySeedSlot(slot: number): Promise<ServerRow | null>;
    /**
     * Record that this server is the one env slot `slot` seeded.
     *
     * Discovery calls this when it matched a server the old way (by address) and the slot is not
     * yet recorded, so an install that predates slots is stamped on its next boot and protected
     * from then on. A slot already held by another server is left alone rather than stolen.
     */
    claimSeedSlot(id: string, slot: number): Promise<ServerRow | null>;
    /**
     * Record the outcome of a connection attempt — the app's only memory of whether a server answers.
     *
     * Called from the one helper every dial goes through, so it costs no call-site discipline.
     * Failures always write (an operator needs the reason and the time). Successes are throttled:
     * the ingestion loop connects every few seconds per server and an UPDATE per poll would be pure
     * write amplification for a timestamp nobody reads that precisely — so a success writes only
     * when it clears a recorded error or when the last one is over a minute old.
     */
    recordContact(id: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void>;
    /** Every LIVE server, oldest first. Retired servers are excluded BY DEFAULT — the fail-closed
     *  side of retirement: a surface that forgets the feature exists hides them, it cannot leak
     *  them. `includeRetired` is for the Connections tab and for id→name maps over history. */
    list(opts?: { includeRetired?: boolean }): Promise<ServerRow[]>;
    /** Retire (stamp) or bring back (clear). Touches NOTHING else — no data moves or dies. */
    setRetired(id: string, retired: boolean): Promise<ServerRow | null>;
    /**
     * Decommission (stamp) or recommission (clear) — stage 2. Like setRetired this is a pure
     * visibility fact: no data moves or dies. WHO may call it (the install's first login only)
     * and WHEN (only while retired) are the route's law, not the store's — the store just writes
     * the stamp it is told to.
     */
    setDecommissioned(id: string, decommissioned: boolean): Promise<ServerRow | null>;
    /**
     * The point of no return: drop the server ROW. Every table keyed to it by foreign key goes
     * with it (matches and their stats/weapon rows, VIPs, bans, configs, rules, scoped triggers…).
     * The route pairs this with crconSnapshot.purgeServerData first, which clears the tables that
     * deliberately carry NO foreign key (events, sessions, careers) — the pairing, not this call
     * alone, is the whole delete. The route passes `keepUserHistory` there, so careers and
     * moderation history outlive even this. Returns false when the id is unknown.
     *
     * The leftover objective-preset row (mapPointPending) also carries no foreign key — a data-port
     * restore runs DELETE FROM servers, and a cascade would lose a put-back still owed — so this
     * call deletes it by hand instead.
     */
    remove(id: string): Promise<boolean>;
    /**
     * Change how the panel reaches an EXISTING server: address, port, credential, protocol.
     *
     * The gap this closes: a server's RCON password could be set once, at add time, and never
     * again. Providers rotate credentials — and when one did, the panel kept dialling with the old
     * one and every write to that server failed with a 401 nobody could act on. The env is no help
     * either: discovery treats it as a seed and refuses to overwrite a server it already knows, so
     * the new password could sit in the environment while the app kept using the old one. Short of
     * editing the database by hand there was no way out.
     *
     * Only the fields provided are changed, so rotating a password does not require restating the
     * host. `password` is sealed on write exactly like `create` does it.
     */
    updateConnection(id: string, patch: ServerConnectionPatch): Promise<ServerRow | null>;
    setEngagementMode(id: string, mode: EngagementMode): Promise<ServerRow | null>;
    /** Turn the unauthenticated CRCON-compatible read API on or off for this server. */
    setStreamerMode(id: string, on: boolean): Promise<ServerRow | null>;
    /**
     * Name the server for the public stats site: its URL slug and its public display name.
     * Callers validate the slug's shape; the STORE enforces uniqueness (throws on a taken slug)
     * because two servers answering one address is corruption, not a validation nicety.
     */
    setPublicProfile(id: string, profile: { publicSlug: string | null; publicName: string | null; publicPlayerIds: boolean }): Promise<ServerRow | null>;
    /** Set or clear (null) the staff-facing alias — see ServerRow.nickname. */
    setNickname(id: string, nickname: string | null): Promise<ServerRow | null>;
    /** Resolve a public-stats slug to its server — the anonymous surface's only lookup.
     *  A RETIRED server does not resolve: its public pages pause with it. */
    findBySlug(publicSlug: string): Promise<ServerRow | null>;
    /** Replace the per-automation switches. The stored map is exceptions-only; {} means run everything. */
    setAutomation(id: string, automation: ServerAutomation): Promise<ServerRow | null>;
    /** update the display name (e.g. after pulling the live name from RCON). */
    updateName(id: string, name: string): Promise<ServerRow | null>;
    /**
     * Correct which game a server runs, and the protocol used to talk to it.
     *
     * This exists because the game can be set WRONG at creation and was otherwise permanent: env
     * discovery used to seed every server as `hll` with no way to say otherwise, and a Vietnam
     * server labelled HLL connects fine while being read with the wrong roles, sides, weapons and
     * identity rule. Callers validate both values against the game-module registry first.
     */
    setGame(id: string, game: string, protocol: RconProtocol): Promise<ServerRow | null>;
  };
  grants: {
    listByUser(userId: string): Promise<GrantRow[]>;
    /** User ids holding `capability` at GLOBAL scope, at `level` or above. Answers "who are the
     *  owners" in one query rather than a listByUser per account — and the level is part of that
     *  question: a global "*" at none is a lockout (or a decoy anyone with user admin can plant),
     *  and one at read is an auditor. Neither is an owner. */
    userIdsWithGlobalCapability(capability: string, level: AccessLevel): Promise<string[]>;
    create(input: Omit<GrantRow, "id">): Promise<GrantRow>;
    remove(id: string): Promise<boolean>;
  };
  players: {
    /** Upsert a seen player. A non-empty `name` and/or `clanTag` is also recorded as alias history. */
    upsert(input: SeenPlayer): Promise<PlayerRow>;
    /**
     * Upsert a whole roster at once, returning the rows in the same order.
     *
     * Same semantics as calling `upsert` per player — identity on platform_id, alias history
     * recorded — but in a fixed number of statements rather than three per player. The live view
     * records identity for everyone on the server on every read, which it does every 15 seconds
     * per watching admin: on a full server that was ~250 round-trips a poll, and the whole point
     * of the capture is that it is a side effect nobody should notice.
     *
     * Duplicate platform ids within one batch are collapsed (a roster read can repeat a player
     * mid-reconnect); blank platform ids are skipped. The returned array therefore may be shorter
     * than the input — callers key off `platformId`, not position.
     */
    upsertMany(inputs: SeenPlayer[]): Promise<PlayerRow[]>;
    /**
     * Repair for last_seen values no sighting can vouch for. A player's stored last_seen must
     * never postdate ALL the evidence — the latest session end, the latest event involving them,
     * their first_seen. It briefly can for a player online right now (the roster capture bumps it
     * between events), which self-corrects within a snapshot; it lastingly can only when a bug
     * counted something that wasn't a sighting (the CRCON import did exactly that). Lowers every
     * such row to its best evidence and returns how many were lowered. Raise-free and idempotent.
     */
    settleLastSeenFromEvidence(): Promise<number>;
    /**
     * The read-only half of that repair: who is currently drifted, and by how much. Answers the
     * question a bare repair count cannot — "is MY player one of them, and what does the evidence
     * actually say?" — so a clock that looks wrong can be diagnosed instead of guessed at. The
     * sample is the worst offenders first (largest gap between the stored clock and the evidence).
     */
    lastSeenDrift(limit?: number): Promise<LastSeenDrift>;
    /** Look up many players by internal id at once. Any id with no row is simply absent, so the
     *  result may be shorter than the input — callers index it by id, not by position. */
    findByIds(ids: string[]): Promise<PlayerRow[]>;
    /**
     * Look up many players by EITHER key at once — internal id or game platform id.
     *
     * The audit trail is the caller. Manual actions are recorded against the platform id the
     * action route was handed; enforcer rules, notes and flags against our internal id. A reader
     * showing "who was this done to" has a column of ids in both shapes and no way to tell them
     * apart, so it asks for all of them and indexes the answer by both.
     */
    findByAnyIds(ids: string[]): Promise<PlayerRow[]>;
    findById(id: string): Promise<PlayerRow | null>;
    /** Look up by the game platform id (e.g. from a live read), independent of platform. */
    findByPlatformId(platformId: string): Promise<PlayerRow | null>;
    /** Bulk twin of the above — one query serves a whole listing (the ban book's name fill). */
    findByPlatformIds(platformIds: string[]): Promise<PlayerRow[]>;
    list(limit?: number): Promise<PlayerRow[]>;
    /** name/id substring search for the player list. */
    search(q: string, limit?: number): Promise<PlayerRow[]>;
    /** The records directory: filtered, sorted, and enriched with career stats + flags in one
     *  query — what the Players page renders. */
    directory(filters: PlayerDirectoryFilters): Promise<PlayerDirectoryRow[]>;
    /** How many players match those filters in total, ignoring limit/offset — so the directory can
     *  say "200 of 4,213 matching" and know whether another page exists. */
    directoryCount(filters: PlayerDirectoryFilters): Promise<number>;
    /** Total tracked players — a real count, not a capped list length. */
    count(): Promise<number>;
  };
  playerAliases: {
    /** All past names + clan tags for a player, most-recently-seen first. */
    list(playerId: string): Promise<PlayerAliasRow[]>;
    /** Record one sighting of a name/clan at `ts` — widens first/last seen, bumps the counter.
     *  The import path for CRCON's name-history arrays: each historical name lands with ITS
     *  time, so "Also known as" reaches back before this panel existed. */
    record(playerId: string, kind: "name" | "clan", value: string, ts: string): Promise<void>;
    /** Many sightings in one statement. Same widening rule per row; duplicates inside the batch are
     *  folded first (one row cannot be an ON CONFLICT target twice) with their seen_count summed,
     *  so a name appearing N times in one archive counts N exactly as N single calls would. */
    recordMany(rows: { playerId: string; kind: "name" | "clan"; value: string; ts: string }[]): Promise<void>;
  };
  /**
   * Clan tags as the roster reported them — the alias history's `clan` rows, asked about by
   * spelling. Grouping spellings into one main tag is the caller's (clan-tags.ts); the store only
   * counts and lists. "Wearing now" = the player's newest tag, seen within CLAN_CURRENT_GRACE_SEC of
   * their own last sighting; a tag they have since taken off or replaced is one they used to wear.
   */
  clanTags: {
    /** Every spelling ever recorded, nothing more — what grouping needs (cheap: index only). */
    tags(): Promise<string[]>;
    /** Every spelling ever recorded, with its counts, over the players `opts` covers. */
    spellings(opts?: ClanScope): Promise<ClanSpellingRow[]>;
    /** The counts for groups of spellings, one row per group that anyone covered has worn. */
    groupStats(groups: { key: string; tags: string[] }[], opts?: ClanScope): Promise<ClanGroupStatsRow[]>;
    /** The players who have worn any of these spellings — current wearers first, then by when
     *  they were last seen wearing one. `total` counts every match, not just this page. */
    members(q: ClanMembersQuery): Promise<{ rows: ClanMemberRow[]; total: number }>;
  };
  externalLinks: {
    list(playerId: string): Promise<ExternalLinkRow[]>;
    /** Upsert one identity per (player, provider); null externalId clears the link. */
    set(playerId: string, provider: string, externalId: string | null, byName?: string | null): Promise<void>;
    /** Reverse lookup — which player owns this external identity? */
    findPlayer(provider: string, externalId: string): Promise<PlayerRow | null>;
    /**
     * Every player carrying this identity, most recently seen first. One Discord account links to
     * one game account PER GAME (docs/vip-module.md), and player ids do not cross games — so the
     * same Discord id legitimately fans out to several player rows once a second game exists.
     * `findPlayer` answers "the one" and quietly picks when there are several; anything making a
     * per-game decision (registration, purchases, the member panel) must read the full set.
     */
    findPlayers(provider: string, externalId: string): Promise<PlayerRow[]>;
    /**
     * Every player carrying this identity under ANY provider — the "same account elsewhere"
     * lookup. A platform account id (a Steam64, an Xbox XUID) is permanent per account and turns
     * up beside BOTH games' rows for the same human, but which provider name it was filed under
     * is a labelling detail this lookup must not depend on.
     */
    findPlayersByExternalId(externalId: string): Promise<PlayerRow[]>;
    /** Every DISTINCT external identity for a provider. What a bulk reconcile walks — one entry
     *  per Discord account, however many game accounts hang off it. */
    distinctExternalIds(provider: string): Promise<string[]>;
    /** Which of these players (profile ids) hold a link for `provider` — a whole roster in one read. */
    linkedAmong(playerIds: string[], provider: string): Promise<Set<string>>;
  };
  playerTags: {
    list(playerId: string): Promise<PlayerTagRow[]>;
    /**
     * Tag labels for a whole roster at once, keyed by the platform id the game reports.
     *
     * The seeding and auto-mod runners both need "which of these players carry an immunity tag",
     * once per poll tick. Each was resolving it a player at a time — a `players.findByPlatformId`
     * followed by a `playerTags.list` — so a full 100-player server cost 200 round trips per tick,
     * per runner, against a pool that defaults to 10 connections. Players with no tags are simply
     * absent from the map; so are platform ids we have never seen.
     */
    labelsByPlatformIds(platformIds: string[]): Promise<Map<string, string[]>>;
    add(input: NewPlayerTag): Promise<PlayerTagRow>;
    /** The row that was removed, so the caller can name it on the audit trail; null if there was
     *  no such tag. A bare boolean left "who took that tag off?" unanswerable. */
    remove(id: string): Promise<PlayerTagRow | null>;
  };
  /** Play-session pairing for visits/playtime. One open session per (player, server); closing it
   *  folds the duration into the playtime rollup, so this store only holds currently-open sessions. */
  sessions: {
    /**
     * Open a session on connect.
     *
     * A connect while one is already open BANKS the old one (ending it at this connect) instead of
     * overwriting it, and returns its elapsed seconds so the caller can credit them — 0 when there
     * was nothing to bank, or when this connect is older than the session already recorded.
     */
    open(playerId: string, serverId: string, ts: string): Promise<number>;
    /** Close the open session on disconnect: record it in the session history and return the
     *  elapsed seconds (0 if none was open, in which case nothing is recorded). */
    close(playerId: string, serverId: string, ts: string): Promise<number>;
    /** Completed sessions for a player, most-recent first. `serverId` narrows to when they were
     *  playing on that one server — the profile lists every server, the analytics page compares
     *  a player against one server's population and must use that server's sessions. */
    list(playerId: string, limit?: number, serverId?: string): Promise<PlayerSessionRow[]>;
    /** Every COMPLETED session that overlaps [from, to) on one server — the bulk payout's
     *  "who was on between X and Y" source. Only closed sessions live in this table; a window
     *  that is still open must union this with `openOnServer`. */
    inWindow(serverId: string, fromIso: string, toIso: string): Promise<{ playerId: string; connectedAt: string; disconnectedAt: string }[]>;
    /** Server ids where this player currently has an open session ("online now"). */
    openServers(playerId: string): Promise<string[]>;
    /** The same, for many players at once — playerId → server ids, absent when they're offline.
     *  The watchlist asks this for every flagged player at once; one query beats one per row. */
    openServersFor(playerIds: string[]): Promise<Map<string, string[]>>;
    /**
     * Each player's newest session on any server, open (no end) or closed: CRCON's sessions[0],
     * which its live scoreboard counts a player's time from. Absent for a player with none.
     */
    latestFor(playerIds: string[]): Promise<Map<string, { connectedAt: string; disconnectedAt: string | null }>>;
    /** Every open session on ONE server — playerId → connectedAt. The live roster's TIME column:
     *  one query per 15s poll, not one per player. */
    openOnServer(serverId: string): Promise<Map<string, string>>;
    /**
     * Close every open session on `serverId` that the live roster no longer backs — the reaper
     * behind "banned an hour ago and still shows ONLINE".
     *
     * A session is only ever closed by a parsed DISCONNECTED line, and the game does not always
     * provide one: a ban-kick's line names the player without an id, a server crash logs nothing,
     * and a worker restart misses whatever happened while it was down. Any of those strands the
     * open-session row forever, and everything that reads "online now" — the profile badge, the
     * watchlist, payout presence — keeps saying the player is here.
     *
     * `presentPlayerIds` is the roster as the caller just read it; only sessions ABSENT from it
     * AND opened before `connectedBeforeIso` (the grace: a player who connected after the roster
     * read started must not be reaped by it) are closed, into the same history `close()` writes.
     * Deliberately NOT folded into the career playtime rollup: the close time is the sweep's, not
     * the player's real departure, and the ordinary disconnect path remains the accurate one.
     * Returns how many sessions were closed.
     */
    closeAbsent(serverId: string, presentPlayerIds: string[], connectedBeforeIso: string, ts: string): Promise<number>;
    /** Idempotently insert a completed historical session (e.g. imported from CRCON). Dedupes on
     *  (playerId, serverId, connectedAt); returns true ONLY if newly inserted, so the caller folds
     *  the duration into the rollup exactly once even across repeated imports. */
    importOne(input: ImportedSession): Promise<boolean>;
    /** Many historical sessions in ONE statement, same dedupe rule as importOne. Returns the subset
     *  that was actually inserted, so the caller still folds each duration into the rollup exactly
     *  once — the property importOne's boolean carries, kept across the batch. A CRCON install has
     *  a session per player per join across years; one round trip each made this the import's
     *  second-largest cost after the kill stream. */
    importMany(rows: ImportedSession[]): Promise<ImportedSession[]>;
  };
  playerNotes: {
    list(playerId: string, limit?: number): Promise<PlayerNoteRow[]>;
    create(input: NewPlayerNote): Promise<PlayerNoteRow>;
    /** Lower a note's created_at to an earlier real instant (never raises) — the repair for notes
     *  an older import stamped at import time instead of when they were actually written. */
    backdate(id: string, createdAt: string): Promise<void>;
  };
  /** IP sightings per player (idempotent upsert; the ip index also answers "who shared this ip"). */
  playerIps: {
    /** Record a sighting at `ts` — widens first/last seen, bumps the counter. */
    record(playerId: string, ip: string, ts: string, source: string): Promise<void>;
    list(playerId: string): Promise<PlayerIpRow[]>;
    /** Every player seen on this exact IP — the alt-account cross-reference. */
    byIp(ip: string): Promise<PlayerIpRow[]>;
    /** The same for a set of addresses at once. A player's IP page cross-references every address
     *  they've been seen on, which was a query each — and then a name lookup per sharer. */
    byIps(ips: string[]): Promise<PlayerIpRow[]>;
  };
  playerFlags: {
    get(playerId: string): Promise<PlayerFlagsRow | null>;
    /** Also maintains the permanent watch history: arming opens a history row, updating an active
     *  watch's provenance updates the open row, unwatching CLOSES it (removed by/at) — the past
     *  reasons are how staff catch repeat offenders, so nothing is ever deleted. */
    set(playerId: string, patch: PlayerFlagsPatch, by: { userId: string | null; name: string }): Promise<PlayerFlagsRow>;
    /** WATCHED players only — the 👁 highlight and the watchlist tab. This used to return VIP-marked
     *  rows too, and since the VIP marker follows the real grant, that was every VIP in the
     *  community: hundreds of rows fetched, enriched with names and open sessions, and then thrown
     *  away by every caller — all of them filter to the watchlist, and the live view's ★ comes from
     *  the grants themselves. */
    listWatched(): Promise<PlayerFlagsRow[]>;
    /** Every watch this player has ever had, newest first (open spell included). */
    watchHistory(playerId: string): Promise<WatchHistoryRow[]>;
  };

  watchReasons: {
    /** Every reason ever recorded for this player, active first then newest first — the profile
     *  shows the removed and expired ones too, struck through, because that IS the record. */
    list(playerId: string): Promise<WatchReasonRow[]>;
    /** ACTIVE reasons (not removed, not expired) for many players at once — one query feeds the
     *  whole Watched tab rather than one per row. */
    listActiveByPlayers(playerIds: string[]): Promise<Map<string, WatchReasonRow[]>>;
    get(id: string): Promise<WatchReasonRow | null>;
    add(input: { playerId: string; reason: string; addedBy: string | null; addedByUserId?: string | null; expiresAt?: string | null; addedAt?: string }): Promise<WatchReasonRow>;
    /** Edit text and/or expiry. The previous version is APPENDED to `edits` first — an edited
     *  moderation record that forgets what it used to say is a record that can be laundered. */
    edit(id: string, patch: { reason?: string; expiresAt?: string | null }, by: string | null): Promise<WatchReasonRow | null>;
    /** Close one reason (never deletes). Returns the closed row, or null if unknown/already closed. */
    remove(id: string, by: string | null): Promise<WatchReasonRow | null>;
    /** Close every active reason for a player (the "remove from watchlist" of the multi-reason
     *  world). Returns how many were closed. */
    removeAll(playerId: string, by: string | null): Promise<number>;
    /** Players whose watchlist FLAG is still armed but whose last active reason has lapsed —
     *  what the expiry sweep disarms. */
    lapsedWatchers(): Promise<string[]>;
  };
  approvals: {
    /** New request. Drafts are private scratch (the builder); the fast path files at 'open'. */
    create(input: { requesterUserId: string; requesterName: string; note?: string | null; status?: "draft" | "open" }): Promise<ApprovalRequestRow>;
    get(id: string): Promise<ApprovalRequestRow | null>;
    /** The requester's one live draft, if any — entering the builder resumes it. */
    findDraft(requesterUserId: string): Promise<ApprovalRequestRow | null>;
    /** Newest-submitted-first; drafts (no submitted_at) sort by created_at. */
    list(q?: { status?: ApprovalRequestStatus[]; requesterUserId?: string; limit?: number }): Promise<ApprovalRequestRow[]>;
    /** Append a line. Only drafts and open requests may grow (open: the fast path's single line). */
    addLine(requestId: string, input: NewApprovalLine): Promise<ApprovalLineRow | null>;
    /** Remove a line from a DRAFT — reviewing means being able to drop a row before filing. */
    removeLine(requestId: string, lineId: string): Promise<boolean>;
    /** draft → open. Conditional: an already-filed or discarded request stays what it is. */
    submit(id: string, expiresAt: string): Promise<ApprovalRequestRow | null>;
    /** Delete a DRAFT outright — an unfiled bundle is scratch, not record. */
    discardDraft(id: string): Promise<boolean>;
    /** Park (Save draft) or resume the requester's draft. Parked = kept, but no view elevation.
     *  Returns the draft, or null when they have none. */
    parkDraft(requesterUserId: string, parked: boolean): Promise<ApprovalRequestRow | null>;
    /**
     * Delete drafts nobody has touched since `cutoffIso` (updated_at — captures, parks and
     * resumes all bump it). The worker sweep calls this with now − the admin-set TTL; an
     * abandoned cart is scratch that would otherwise elevate-on-resume forever.
     */
    discardStaleDrafts(cutoffIso: string): Promise<ApprovalRequestRow[]>;
    /** open → withdrawn: pending lines void, decided lines keep their stamps (they happened). */
    withdraw(id: string): Promise<ApprovalRequestRow | null>;
    /**
     * Decide ONE pending line — the race is settled HERE, by a conditional transition: two
     * approvers clicking together resolve to one winner and one "already handled", never a
     * double execution. Approving with `modified` records requested→granted per field.
     */
    decideLine(lineId: string, d: { state: "approved" | "denied"; byUserId: string; byName: string; denyReason?: string | null; modified?: Record<string, { requested: number; granted: number }> | null }): Promise<ApprovalLineRow | null>;
    /** Record what execution did with an approved line — done, or the error, never silence. */
    markApplied(lineId: string, error?: string | null): Promise<ApprovalLineRow | null>;
    /** A line the requester executed THEMSELVES at submit (they held the write — no approval was
     *  ever needed): state 'executed', their own stamp, applied in the same motion. */
    markExecuted(lineId: string, by: { userId: string; name: string }, error?: string | null): Promise<ApprovalLineRow | null>;
    /** Close the request once no line is pending; no-op while any is. Returns the fresh row. */
    settle(requestId: string): Promise<ApprovalRequestRow | null>;
    /** Age out open requests past their expiry: pending lines void, status → expired. Returns
     *  the requests that expired, for the audit trail. */
    expireDue(nowIso: string): Promise<ApprovalRequestRow[]>;
  };
  events: {
    /** Insert events idempotently by (serverId, dedupeKey). Returns the rows actually
     *  inserted (duplicates are skipped) so callers can bump stats only for new events. */
    insert(rows: NewEvt[]): Promise<NewEvt[]>;
    listRecent(serverId: string, limit?: number): Promise<EvtRow[]>;
    /**
     * The game log's query, filtered in the DATABASE.
     *
     * The panel's filters (category, free text, one player) used to run in JavaScript over the
     * most recent 1000 rows, which quietly capped what you could find: search a busy server for a
     * chat line from last week and it simply wasn't there, because a thousand kills had pushed it
     * out of the window before the filter ever ran. Filtering in SQL means the search covers the
     * whole log, and — since the matching set is now a real result set — it can be paged.
     */
    query(q: EventQuery): Promise<EvtRow[]>;
    /**
     * A whole window of one server's events for a fold over a round or a session: every match up
     * to `limit` (the newest, when the window holds more), oldest first. `query` is a PAGE, at most
     * 500 rows, and a round's kill stream runs to thousands.
     */
    window(q: EventWindowQuery): Promise<EvtRow[]>;
    /** How many events match, ignoring limit/offset, so a screen can say "42 of 1,930". */
    countQuery(q: EventQuery): Promise<number>;
    /** recent events where the player was actor or victim (for their profile). `kinds`, when given,
     *  restricts the window to those event kinds — combat analytics pulls a deep kill/death window
     *  without chat lines eating the limit. */
    listByPlayer(playerId: string, limit?: number, kinds?: string[], opts?: { offset?: number; serverId?: string; serverIds?: string[] }): Promise<EvtRow[]>;
    /** How many events involve this player (optionally of these kinds, on this server) — the
     *  total behind the profile's paged activity feed. */
    /** `serverIds` is the READER's boundary, `serverId` the caller's chosen filter — they are
     *  different questions and both apply, so a count stays honest about the page beside it. */
    countByPlayer(playerId: string, kinds?: string[], serverId?: string, serverIds?: string[]): Promise<number>;
    /** Earliest LOCALLY-ingested event for a server (dedupe key not from the CRCON import). This is
     *  the historical-import boundary: anything at/after it was already observed live by the panel,
     *  so importing CRCON's copy of the same period would double-count. Null = no local history. */
    firstLocalTs(serverId: string): Promise<string | null>;
    /**
     * Give imported team switches the import's round-by-round reading (from/to, the side swap and
     * its count): rows an earlier import stored without their teams, and rows this import stored
     * as it streamed, each described on its own until the whole archive had been seen. Events are
     * otherwise never rewritten; this touches only imported ("crcon:") switch rows whose swap is not
     * named yet and whose data would change, matched by server, dedupe key and time — a swap already
     * named is never rewritten, so a re-run changes nothing however often it runs. Returns how many
     * rows changed.
     */
    fillImportedTeamSwitches(serverId: string, rows: { dedupeKey: string; ts: string; data: Record<string, unknown> }[]): Promise<number>;
    /** count rows a trim would remove (for preview). */
    countForTrim(spec: TrimSpec): Promise<number>;
    /** back up (if requested) then delete the matched slice. */
    trim(spec: TrimSpec): Promise<TrimResult>;
  };
  /**
   * Trim for the non-event datasets in TRIM_DATASETS — the tables that grow with time beyond the
   * raw event log. Same contract as the event trim: preview is an exact count of what run would
   * delete at the same cutoff, and with a backup directory no row is removed without first being
   * written to a gzipped NDJSON file (one file per dataset, each line `{ table, row }` — child
   * rows a cascade would take, like a match's scoreboard lines, are written too).
   *
   * Rows still in progress are never touched: the open round, an admin still in camera. Datasets
   * whose age is a `last_seen` keep any row seen since the cutoff, however old its first sighting.
   */
  trimData: {
    /** Exact per-dataset counts of what `run` would delete at this cutoff. Unknown ids throw. */
    preview(datasets: string[], olderThanIso: string): Promise<Record<string, number>>;
    /** Delete, oldest first, optionally backing each dataset up to its own file in `backupDir`. */
    run(datasets: string[], olderThanIso: string, backupDir: string | null): Promise<Record<string, TrimResult>>;
  };
  /**
   * Whole-database export/import by DATA_EXPORT_GROUPS — the clean-slate migration path. Postgres
   * only: it works on raw table rows, and the memory store has no tables (its `supported: false`
   * lets the API answer honestly instead of pretending). The archive is one gzipped NDJSON file:
   * a `{ header }` first line, then `{ table, row }` lines in parents-first catalog order, ids
   * preserved verbatim so every foreign key survives the trip.
   */
  dataPort: {
    supported: boolean;
    /** Preview: per-group row counts at zero cost to the data — what an export would carry. */
    counts(groups: string[]): Promise<Record<string, number>>;
    /** Stream the selected groups' tables into a gzipped NDJSON archive at `path`.
     *  `onProgress` (rows written so far) lets a job report while a big table drains. */
    export(groups: string[], path: string, onProgress?: (rows: number) => void): Promise<{ tables: Record<string, number>; rows: number }>;
    /** Read an archive and insert its rows: already-present rows are skipped (never overwritten),
     *  rows the database refuses (usually a missing parent) are counted and reported, not fatal.
     *  Serial sequences are resynced afterwards so future inserts don't collide.
     *  `refuseTables` names tables whose rows are not inserted at all — each is counted as failed
     *  under that table with the reason, so the report says what was held back. */
    import(path: string, onProgress?: (rows: number) => void, opts?: { refuseTables?: ReadonlySet<string> }): Promise<DataPortReport>;
    /**
     * Restore a FULL backup: empty every catalogued table, then import the archive.
     *
     * `import` alone cannot give a fresh install its old life back, because a fresh install is not
     * empty — migrations seed the four singleton config rows and the factory map sets, schedules
     * and VIP duration presets, and boot seeds the preset roles. Under import's existing-rows-win
     * rule those seeds beat the archive on exactly the rows an operator cares about most: their
     * settings, their roles (unique names collide, so staff role assignments then fail as
     * orphans), their curated map library. The wipe clears the seeds so the archive's own rows —
     * same ids, same content — land whole.
     *
     * The wipe runs in ONE transaction, children-first (reverse catalog order), and only ever
     * touches catalogued tables — live state (open sessions, poll state) and the migration ledger
     * are left alone. If the import half then fails midway, re-running the restore converges: the
     * wipe empties whatever landed and the import replays the same archive.
     */
    restore(path: string, onProgress?: (rows: number) => void): Promise<DataPortReport>;
  };
  stats: {
    /** apply a delta to a player's rollup on one server (accumulated at ingest). */
    bump(playerId: string, serverId: string, delta: StatsDelta): Promise<void>;
    /**
     * The same fold for many players in one round trip. Ingest calls this once per batch of log
     * lines instead of once per player per line — a busy round put four career writes on the wire
     * for every single kill, and the cost grew with how much was happening on the server.
     *
     * Deltas for the same (player, server) are summed by the caller; passing a pair twice is
     * still safe.
     */
    bumpMany(deltas: { playerId: string; serverId: string; delta: StatsDelta }[]): Promise<void>;
    /**
     * Reconciliation for session history imported before playtime folding existed: raise each
     * player's rollup on `serverId` to AT LEAST the sum of their recorded sessions that ended
     * strictly before `beforeTs` (null = the server was never locally observed, every session
     * counts). Never lowers anything — a rollup already at or above its history, live-era seconds
     * included, is untouched — so re-running is idempotent. Returns how many players were raised.
     */
    settlePlaytimeFromSessions(serverId: string, beforeTs: string | null): Promise<number>;
    /**
     * One player's rollup. With `serverId` it is what they did on THAT server; without, their
     * career across every server the community runs, summed — which is what a profile means by
     * "career" and what this returned before stats were split per server.
     */
    get(playerId: string, serverId?: string): Promise<PlayerStatsRow | null>;
    /** Their rollup on each server they have played on, newest activity first. Empty for a player
     *  with no recorded play. Powers the profile's per-server breakdown. */
    byServer(playerId: string): Promise<PlayerStatsRow[]>;
    /** Visits + total playtime on ONE server for many players at once — the live roster's VISITS
     *  column (a whole roster is one query). Absent = never recorded there. */
    visitsFor(playerIds: string[], serverId: string): Promise<Map<string, { visits: number; playtimeSec: number }>>;
    /**
     * Seconds played by many players at once (profile id → seconds; absent = none recorded). On one
     * server or every server (`serverId` null); all time (`since` null, from the rollup) or since a
     * point (completed sessions, the part of each after `since`). A session still open is in
     * neither — the caller adds what it knows of the current visit.
     */
    playtimeFor(playerIds: string[], opts: { serverId: string | null; since: string | null }): Promise<Map<string, number>>;
    /** Ranked players. With `serverIds`, only what was earned on those servers, summed; without,
     *  every server — an explicit choice at the call site, never a silent merge. `offset` skips
     *  that many places from the top, for the board's later pages. */
    leaderboard(sort: LeaderboardSort, limit?: number, serverIds?: string[], offset?: number): Promise<LeaderboardEntry[]>;
    /** How many players that same board ranks, whatever it is sorted by — its page count. */
    leaderboardCount(serverIds?: string[]): Promise<number>;
    /**
     * Fold one roster sample into both the match line and the career rollup, for the WHOLE roster
     * in one round trip. A hundred players a minute per server is not somewhere to put a write per
     * player — the live view already had to be rescued from exactly that.
     *
     * Score handling is the subtle part. The game resets its score buckets every round and reports
     * running totals, not deltas, so the match line takes the max (a value can only climb within a
     * round) and the career rollup receives only the INCREASE over what the match line already had.
     * That makes the fold idempotent: replaying the same sample adds nothing twice.
     *
     * `sampleSec` is how long this sample stands for, added to the role clocks.
     */
    sampleRoster(input: {
      serverId: string;
      /** the open match, when there is one; role time and career score still accrue without it. */
      matchId: string | null;
      sampleSec: number;
      players: RosterSampleRow[];
    }): Promise<void>;
    /**
     * Settle a finished match: mark who won, who was still connected at the whistle, and roll
     * matches played/won onto their careers. Idempotent — closing twice must not double-count.
     *
     * Presence is derived from the open-session table rather than passed in. The caller that closes
     * a match is the log ingest, which has no roster in hand; asking it for one would get an empty
     * list and quietly mark everybody absent. Open sessions already answer "who is connected",
     * exactly, and cost nothing to consult.
     */
    settleMatch(matchId: string, winner: "allies" | "axis" | null): Promise<void>;
  };
  /**
   * Aggregate reads that exist to answer a question about the WHOLE population rather than about
   * one row. They return small, already-summarised results — a page of analytics must never pull
   * a hundred thousand sessions into the API just to count them.
   */
  analytics: {
    /**
     * Session activity in a window, bucketed by when each session STARTED — by hour of day (0–23)
     * and by day of week (0=Sunday), both in `q.tz`. Bucketing on the start is a deliberate simplification:
     * it answers "when do people show up", which is the question behind "when are we busy", and it
     * does not pretend to be a concurrency measurement.
     */
    sessionActivity(q: AnalyticsWindow): Promise<SessionActivity>;
    /**
     * New vs returning across a window: players whose first-ever sighting falls inside it, versus
     * players active in it who were already known. Plus how many of the window's newcomers came
     * back after their first day — the only honest retention number this data supports.
     */
    playerMix(q: AnalyticsWindow): Promise<PlayerMix>;
    /** Sessions, playtime and finished-round kill sums per platform — see PlatformBreakdown. */
    platformBreakdown(q: AnalyticsWindow): Promise<PlatformBreakdown>;
    /** Distinct players per platform per local day — see PlatformTrend. */
    platformTrend(q: AnalyticsWindow): Promise<PlatformTrend>;
    /** Per-day score buckets, squad-leader time and vehicle work, from the per-match stat rows. */
    scoreTrends(q: AnalyticsWindow): Promise<ScoreTrends>;
    /** Finished rounds in a window with their scores — the raw material for balance analysis. */
    matchesInWindow(q: AnalyticsWindow): Promise<MatchRow[]>;
    /**
     * Server-wide kill/team-kill aggregates for a window. Everything here is a GROUP BY in the
     * database: the alternative is streaming a busy server's whole kill log into the API to count
     * it, which is minutes of work and hundreds of megabytes for one page of charts.
     */
    combat(q: AnalyticsWindow): Promise<CombatActivity>;
    /**
     * True concurrency — overlapping sessions, not session starts. Sessions are CLIPPED to the
     * window, and the still-open ones count as online right up to its end, so the near edge isn't
     * quietly short by everyone currently playing.
     */
    concurrency(q: AnalyticsWindow): Promise<Concurrency>;
    /**
     * Roster composition over a window, from the periodic snapshots.
     *
     * Downsampled to one snapshot per `occupancySampleSec` bucket before folding, for the same
     * reason the occupancy grid is: a month at minute resolution is 43,000 rows per server to
     * answer a question that a 30-minute grid answers identically, and the returned `sampleSec`
     * says which grid was used.
     */
    composition(q: AnalyticsWindow): Promise<RosterComposition>;
    /**
     * One hour metric (HOUR_METRICS) over a server's window: a figure per local hour on every date
     * the window touches — foldHourGrid says which hours are zero and which are empty. One server
     * only: added up across servers, a peak or a side gap would describe no server at all. Read at
     * full resolution, unlike the page's own grids, because a peak has to see every sample.
     */
    hourGrid(q: AnalyticsWindow & { serverId: string }, metric: HourMetric): Promise<DateHourRow[]>;
    /**
     * When the recorded history starts — for one server, or (unscoped) the whole install: the
     * earliest session, round, roster sample or game event, and unscoped the audit trail too.
     * Null when nothing has been recorded. The "All time" analytics window starts HERE rather than
     * at some fixed old date: every per-hour grid walks the window, and a window opening in 1970
     * would be half a million empty hours before the first real one.
     */
    earliest(serverId?: string): Promise<string | null>;
  };
  /** Feature presets: named behaviour snapshots of feature configs (broadcast, map vote,
   *  seeding — see the FEATURE_PRESETS catalog). Community-wide; names unique per feature,
   *  case-insensitively, because Auto settings profiles reference them by name. */
  featurePresets: {
    list(feature: string): Promise<FeaturePresetRow[]>;
    get(feature: string, name: string): Promise<FeaturePresetRow | null>;
    /** upsert by (feature, name): saving under an existing name replaces it. `game` is the source
     *  server's game (see FeaturePresetRow.game). */
    save(input: { feature: string; name: string; config: Record<string, unknown>; game?: string | null; createdByName: string }): Promise<FeaturePresetRow>;
    remove(id: string): Promise<boolean>;
  };
  rosterSnapshots: {
    /** Write one sample. Idempotent on (server, ts) so a retrying sampler can't double-count. */
    record(input: RosterSnapshotInput): Promise<void>;
    /** Raw samples in a window, oldest first — for exports and for verifying the fold.
     *  UNBOUNDED and it carries the composition jsonb, so it is for internal callers that know
     *  their window is small. Anything public wants `scoreTimeline`. */
    list(q: AnalyticsWindow): Promise<RosterSnapshotRow[]>;
    /**
     * The score timeline for a window — every sample that RECORDED a score, oldest first.
     *
     * Backs CRCON's `cap_flips` on the public stats API, which is a byte-for-byte parity surface:
     * it returns the round's WHOLE timeline, so this takes no limit and must never grow one. A cap
     * here would be a deviation, and on that surface a deviation is the bug.
     *
     * Deliberately not `list` all the same: it reads three columns instead of dragging every
     * sample's composition jsonb through, and drops the scoreless rows in SQL rather than in JS
     * afterwards. Both are invisible in the output and are what make serving the whole timeline
     * affordable.
     */
    scoreTimeline(serverId: string, fromIso: string, toIso: string): Promise<{ ts: string; alliedScore: number; axisScore: number }[]>;
    /** The newest sample for one server — the cheap "how does the server look right now" read
     *  (no RCON round-trip) behind the Auto settings live-preview. Null until the sampler runs. */
    latest(serverId: string): Promise<RosterSnapshotRow | null>;
  };
  layouts: {
    get(surface: string, scopeType: LayoutScope, scopeId: string): Promise<LayoutRow | null>;
    set(surface: string, scopeType: LayoutScope, scopeId: string, config: Record<string, unknown>): Promise<LayoutRow>;
    /** Drop a saved layout so the scope falls back to the next source (instance default, then the
     *  built-in defaults). @returns whether a row existed. */
    remove(surface: string, scopeType: LayoutScope, scopeId: string): Promise<boolean>;
    /** How many layouts this scope holds across all surfaces — the bound behind the per-user cap
     *  on panel surfaces, whose names the caller invents (widget surfaces are registry-bounded). */
    countForScope(scopeType: LayoutScope, scopeId: string): Promise<number>;
  };
  pluginKv: {
    get(namespace: string, key: string): Promise<unknown>;
    /** `at` overrides the write time. Callers restoring or replaying history need the row to
     *  keep the moment it was really written, because retention ages these rows out by it —
     *  a restored row that claims to be new would outlive the sweep meant to collect it. */
    set(namespace: string, key: string, value: unknown, at?: string): Promise<void>;
    /**
     * Forget a key entirely.
     *
     * A key-value store with no delete can only ever grow: the registration flow "cleared" a
     * spent challenge by writing `{}` over it, so every player who ever linked their account
     * left a permanent empty row behind, and every lockout left a stale timestamp. Storing
     * emptiness is not the same as storing nothing.
     */
    remove(namespace: string, key: string): Promise<void>;
  };
  announcements: {
    /** Stamp first-read receipts for this user on the given POSTED notices (idempotent — the
     *  first read time is never overwritten). Unknown/draft ids are ignored. */
    markRead(userId: string, announcementIds: string[]): Promise<void>;
    /** Explicit acknowledgement (implies read). Returns null when the notice isn't posted. */
    acknowledge(announcementId: string, userId: string): Promise<AnnouncementReadRow | null>;
    /** All read receipts for one notice. */
    reads(announcementId: string): Promise<AnnouncementReadRow[]>;
    /** All of one user's read receipts — lets list endpoints attach per-user read state. */
    readsForUser(userId: string): Promise<AnnouncementReadRow[]>;
    /** Board-wide Discord nudge settings (single instance-level row; defaults when unset). */
    getNudgeConfig(): Promise<AnnouncementNudgeConfig>;
    setNudgeConfig(patch: Partial<AnnouncementNudgeConfig>): Promise<AnnouncementNudgeConfig>;
    /** Stamp "the unread nudge fired for this posting" (once per publish cycle). */
    markNudged(id: string): Promise<void>;
    create(input: NewAnnouncement): Promise<AnnouncementRow>;
    /** published only, newest first — for the board every staff member reads, `offset` from the
     *  newest for its later pages. */
    listPublished(limit?: number, offset?: number): Promise<AnnouncementRow[]>;
    /** How many are posted — the board's page count. */
    countPublished(): Promise<number>;
    /** all posts incl. drafts — for the editor (requires community.edit). */
    listAll(limit?: number, offset?: number): Promise<AnnouncementRow[]>;
    /** How many there are, drafts included. */
    countAll(): Promise<number>;
    get(id: string): Promise<AnnouncementRow | null>;
    update(id: string, patch: AnnouncementPatch): Promise<AnnouncementRow | null>;
    remove(id: string): Promise<boolean>;
  };
  /** Reusable message/reason presets (the editable library behind the pickers). */
  templates: {
    list(kind?: string): Promise<MessageTemplateRow[]>;
    create(input: NewMessageTemplate): Promise<MessageTemplateRow>;
    update(id: string, patch: MessageTemplatePatch): Promise<MessageTemplateRow | null>;
    remove(id: string): Promise<boolean>;
  };
  /** The duration buttons on the Edit VIP popup (add tab + pause tab), community-editable. */
  vipPresets: {
    list(): Promise<VipPresetRow[]>;
    create(input: NewVipPreset): Promise<VipPresetRow>;
    update(id: string, patch: VipPresetPatch): Promise<VipPresetRow | null>;
    remove(id: string): Promise<boolean>;
  };
  /** The Rules page's sections. Filing changes nothing a rule does; a section's master switch
   *  (setEnabled) holds every rule filed under it. */
  ruleSections: {
    /** Every section, oldest first (the page's default order; staff arrange their own). */
    list(): Promise<RuleSectionRow[]>;
    /** Throws RuleSectionNameTaken when another section already has the name (ignoring case). */
    create(name: string): Promise<RuleSectionRow>;
    /** Null when absent; throws RuleSectionNameTaken like create. */
    rename(id: string, name: string): Promise<RuleSectionRow | null>;
    /** Flip the section's master switch. Touches no rule's own switch. Null when absent. */
    setEnabled(id: string, enabled: boolean): Promise<RuleSectionRow | null>;
    /** Deletes the section; its rules stay, on no section. */
    remove(id: string): Promise<boolean>;
  };
  enforcerRules: {
    list(): Promise<RuleRow[]>;
    get(id: string): Promise<RuleRow | null>;
    create(input: NewRule): Promise<RuleRow>;
    update(id: string, patch: RulePatch): Promise<RuleRow | null>;
    remove(id: string): Promise<boolean>;
    /** File these rules under a section (null = none). Touches nothing else on them — not even
     *  updatedAt's meaning of "the rule changed" — and skips ids that do not exist. Returns how
     *  many rules moved. */
    setSection(ruleIds: string[], sectionId: string | null): Promise<number>;
    /** Pause a rule until `until` (who and why kept beside it), or lift a pause (null). Touches
     *  nothing else — not its own switch, and not updatedAt, which a schedule reads as "the
     *  rule's terms changed". Null when the rule is gone. */
    setPause(id: string, pause: { until: string; reason: string; by: string } | null): Promise<RuleRow | null>;
    /**
     * When each rule last fired, and how often lately — read from the audit trail, which already
     * stamps every firing with its `ruleId`.
     *
     * The Rules page could say what a rule WOULD do and never whether it had done it, so a rule
     * mis-scoped to the wrong server, gated on a role nobody holds, or watching an event the log
     * stopped emitting looked exactly like one quietly keeping the peace. Keyed by rule id;
     * rules that have never fired are simply absent.
     */
    activity(since: string): Promise<Map<string, { lastFiredAt: string; count: number }>>;
    /** When this rule last granted this player a crash VIP on this server, or null if never.
     *  Persisted rather than held in memory: the cooldown it feeds is the anti-farm defence, and
     *  one that forgot everything on restart would be no defence at all. */
    lastVipGrantAt(ruleId: string, serverId: string, playerId: string): Promise<string | null>;
    /** Stamp a crash VIP grant, starting that player's cooldown on that rule. */
    recordVipGrant(ruleId: string, serverId: string, playerId: string): Promise<void>;
    /** How many times this rule has fired on this player (profile id) since `since` (null = ever)
     *  — the per-player cap's count. Real firings only, or only trial ones when `dryRun`; failed
     *  attempts never count against a player. */
    firingCount(ruleId: string, subjectId: string, since: string | null, dryRun: boolean): Promise<number>;
    /** Count one firing of a capped rule on a player (rule_firings — kept out of every retention
     *  trim, unlike the audit log the cap used to read). */
    recordFiring(ruleId: string, subjectId: string, dryRun: boolean): Promise<void>;
    /**
     * Claim one occurrence of a scheduled rule ("2026-11" for a monthly one): true when this call
     * took it, false when it was already taken — by an earlier run, or by another API process in
     * the same instant. Claim first, act after: a crash mid-run loses the rest of that run rather
     * than repeating anyone's grant.
     */
    claimOccurrence(ruleId: string, occurrence: string): Promise<boolean>;
    /** Store what a roster rule saw on its latest check of one server (see RuleCheckSummary). */
    recordCheck(ruleId: string, serverId: string, summary: RuleCheckSummary): Promise<void>;
    /** Store the latest reason the enforcer held one of this rule's firings back on a server. */
    recordSkip(ruleId: string, serverId: string, reason: string, playerName: string | null): Promise<void>;
    /** Every rule's status rows, for the rules page. */
    statuses(): Promise<RuleStatusRow[]>;
  };
  audit: {
    create(input: NewAudit): Promise<AuditRow>;
    /**
     * Hear every row THIS process writes, as soon as it is stored: how the phone notifications
     * learn of a staff ban or a changed setting the moment it happens. Each listener gets its own
     * copy; one that throws is ignored, because the row is written either way. Returns the way to
     * stop listening.
     */
    watch(listener: (row: AuditRow) => void): () => void;
    /** search/filter the trail, newest first. */
    list(query?: AuditQuery): Promise<AuditRow[]>;
    /** One entry by its id; null when there is none (an id of the wrong shape included). */
    get(id: string): Promise<AuditRow | null>;
    /**
     * The VIP integrity scan's read: every row that moves or decides a VIP expiry (VIP_TIMELINE_*),
     * oldest first, one page after an opaque cursor — the WHOLE history, never capped. A capped read
     * taken oldest first drops the NEWEST rows, which is where every dismissal and every add-back
     * is: both came straight back on the next recheck. `next` is null on the last page. The cursor
     * carries the stored timestamp at full precision, so a page boundary never repeats or skips a row.
     *
     * `scope` narrows it for a reader that needs one server's story up to a point (the analytics
     * VIP count): rows filed under that server, and banked-pause resumes (which can list several
     * servers in one row), older than `before`. The integrity scan reads it whole.
     */
    vipTimeline(cursor: string | null, limit: number, scope?: { serverId?: string; before?: string }): Promise<{ rows: AuditRow[]; next: string | null }>;
    /**
     * What a set of purchases landed as: every `vip.grant` row whose `data.ref` is one of `refs` —
     * a VIP shop purchase's ledger ref, which each server's grant carries — oldest first. The points
     * history reads it to say when the days bought start and when the VIP now ends, so the ledger,
     * which nothing edits, never has to. Rows trimmed off the trail are simply not found.
     */
    vipGrantsByRef(refs: string[]): Promise<AuditRow[]>;
    /** How many entries match, ignoring limit/offset — the denominator for paging. */
    count(query?: AuditQuery): Promise<number>;
    /** Per-staff activity rollup (counts + last-seen + by-action breakdown), optionally for one
     *  set of servers — "who is actually moderating THIS server" is a different question from
     *  "who is busy across the community", and the page could only ask the second one. */
    /**
     * Per-actor rollup of the trail. `actor` splits people from machinery: "human" keeps only
     * rows a signed-in user performed (actor_user_id set), "auto" only the app's own automation
     * (vip.expire, seeding, auto settings — rows with no user). Omitted = everyone, which is
     * almost never what a STAFF statistic wants: the automation dwarfs the humans.
     */
    staffSummary(range?: { from?: string; to?: string; serverIds?: string[]; includeUnscoped?: boolean; actor?: "human" | "auto" }): Promise<StaffSummaryRow[]>;
  };
  heartbeats: {
    /** Record a service's current state (upsert by name). */
    upsert(input: { name: string; status: string; detail?: Record<string, unknown> | null }): Promise<HeartbeatRow>;
    list(): Promise<HeartbeatRow[]>;
  };
  vips: {
    /** VIP grants, optionally scoped to one server. Newest-first is not required; UI sorts. */
    list(serverId?: string): Promise<VipRow[]>;
    /** One PLAYER's grants across every server — the profile's read. `playerId` is the game's
     *  platform id, the same key grants are stored under. */
    listByPlayer(playerId: string): Promise<VipRow[]>;
    get(serverId: string, playerId: string): Promise<VipRow | null>;
    /** Insert or update the (server, player) grant, setting name/comment/expiration.
     *  NEVER touches the pause fields — a paused player's grants keep accumulating. */
    upsert(input: NewVip): Promise<VipRow & { endedHold?: VipGroupHold | null }>;
    /** The IMPORT's write, and the one difference that matters: an archive never overrules a grant
     *  the panel already holds. `upsert` sets `expiration` unconditionally, which is right for a
     *  staff grant and catastrophic for a historical import — a backup taken weeks ago would push
     *  its stale expiry over the live one, extending VIPs that should have lapsed, cutting short
     *  ones staff had extended, and (worst) turning a timed VIP permanent wherever CRCON held no
     *  expiry. So this inserts when the (server, player) grant is absent and otherwise leaves the
     *  existing row untouched — expiration, pause and all. Re-running converges; nothing live moves.
     *  `inserted` says which happened, so the import can report how many it left alone. */
    importOne(input: NewVip): Promise<{ row: VipRow; inserted: boolean }>;
    remove(serverId: string, playerId: string): Promise<boolean>;
    /** Grants whose expiration has passed `nowIso` (never permanent ones) — for the sweep. */
    expired(nowIso: string): Promise<VipRow[]>;
    /** Set (or clear, with null) the pause on ONE grant. Returns the row, or null if absent. */
    setPause(serverId: string, playerId: string, pause: VipPause | null): Promise<VipRow | null>;
    /** Grants whose pause has lapsed (`paused_until` < nowIso) — the sweep restores their game VIP. */
    pauseLapsed(nowIso: string): Promise<VipRow[]>;
    /**
     * Begin a group perk's hold: the grant becomes permanent and any timed VIP freezes into the
     * balance, measured in the store at write time (a banked pause's balance is frozen at its own
     * start). Creates the grant when there is none. Returns null — and changes nothing — when the
     * player already holds permanent VIP that no perk gave them: that is theirs, not the group's.
     */
    startGroupHold(input: { serverId: string; playerId: string; playerName?: string | null; groups: VipGroupHoldSource[]; createdByName: string; whilePerks?: boolean }): Promise<VipRow | null>;
    /** Refresh the groups a hold remembers (their names and severances). Null when not held — or,
     *  given `expect`, when the plan is out of date: the hold no longer remembers the groups and
     *  severances the caller read, or a group named no longer carries a perk with the severance
     *  written (switched off or changed since the plan) — a severance a person decided is never
     *  overwritten by an older plan. */
    setGroupHoldSources(serverId: string, playerId: string, groups: VipGroupHoldSource[], expect?: VipGroupHoldSource[]): Promise<VipRow | null>;
    /**
     * Add to a held grant's frozen balance: the larger of (balance + addMs) and atLeastMs. Null
     * when the grant is not held — the caller grants the ordinary way instead.
     */
    bankGroupHold(serverId: string, playerId: string, change: { addMs?: number; atLeastMs?: number }): Promise<VipRow | null>;
    /**
     * Take time OUT of a held grant's frozen balance — a person removing VIP of the player's own
     * from beneath a group perk's hold: `cutMs` of it (never below nothing), or `all` of it. The
     * hold itself, the group's permanent, stands. Null when the grant is not held; `removedMs` is
     * what actually came off, measured in the same write.
     */
    cutGroupHold(serverId: string, playerId: string, change: { cutMs?: number; all?: boolean }): Promise<{ row: VipRow; removedMs: number } | null>;
    /**
     * End a hold: the grant takes this dated expiration (the frozen balance plus any severance,
     * from now — the expiry sweep ends it at that date like any other) and stops being held. The
     * one automated write allowed to date a permanent grant, because the perk made it permanent.
     * Null when the grant is no longer held — or, given `expect`, when its frozen balance or its
     * groups' largest severance has moved since the caller planned (time banked, a perk switched
     * off without severance): the caller re-plans next round rather than hand back stale numbers.
     */
    endGroupHold(serverId: string, playerId: string, expiration: string, expect?: { bankedMs: number; severanceMinutes: number }): Promise<VipRow | null>;
    /** Every grant a group perk holds. */
    groupHeld(): Promise<VipRow[]>;
    /** Record a group's severance on every hold it is part of — at once, rather than at the
     *  worker's next refresh, because a release can follow in the same breath: the perk switched
     *  off (with the severance or without, 0), or narrowed by the same edit that changed it. A
     *  release pays what was set last. Returns holds touched. */
    setGroupSeverance(groupId: string, minutes: number): Promise<number>;
    /** The expiry sweep's delete: only while the grant is still past its date and no group perk
     *  holds it — a grant extended or taken into a hold since the sweep read it stays. True when
     *  it was deleted. */
    removeExpired(serverId: string, playerId: string): Promise<boolean>;
    /** Delete a TIMED grant only — never one a group perk holds, nor one made permanent since the
     *  caller read it (a schedule's revoke or cut). True when it was deleted. */
    removeTimed(serverId: string, playerId: string): Promise<boolean>;
    /** Move a TIMED grant's expiration — never one a group perk holds, nor one made permanent or
     *  removed since the caller read it (a schedule's cut). Null when there was no such grant. */
    updateTimedExpiration(serverId: string, playerId: string, expiration: string): Promise<VipRow | null>;
  };
  /** Per-player triggers — see PlayerTriggerRow. The evaluator keeps the ARMED set in memory and
   *  refreshes it on a timer, so `listArmed` is the hot read and the rest are UI/mutation paths. */
  playerTriggers: {
    /** Every armed trigger (enabled, not yet disarmed) across all players — the evaluator's load. */
    listArmed(): Promise<PlayerTriggerRow[]>;
    /** Every trigger across ALL players — the tab's overview, so an armed trigger is findable
     *  without remembering whose it was. Armed first, then newest; capped so a long tail of
     *  spent one-shots cannot balloon the read (default 200).
     *
     *  `serverIds` narrows to triggers scoped to THOSE servers, plus the unscoped "any server"
     *  ones, and the narrowing happens BEFORE the cap — a reader who may see one server of five
     *  gets 200 of theirs, not whatever survived another server's long tail. Omitted means no
     *  restriction (a reader who may see every server, which is the common case and the query
     *  this always ran). An EMPTY array is the honest answer for a reader scoped to nothing:
     *  the unscoped triggers only. */
    listAll(limit?: number, serverIds?: string[]): Promise<PlayerTriggerRow[]>;
    /** Every trigger for ONE player, newest first — the profile tab's read (spent ones included). */
    listByPlayer(playerId: string): Promise<PlayerTriggerRow[]>;
    get(id: string): Promise<PlayerTriggerRow | null>;
    create(input: NewPlayerTrigger): Promise<PlayerTriggerRow>;
    /** Toggle enabled, or edit the note. Returns the row, or null if it is gone. */
    update(id: string, patch: { enabled?: boolean; note?: string | null }): Promise<PlayerTriggerRow | null>;
    /** Re-edit what a trigger does (event, actions, scope, once/every, note), stamping who and
     *  when. Keeps its player, author, and fire history. Returns the row, or null if it is gone. */
    edit(id: string, def: PlayerTriggerEdit): Promise<PlayerTriggerRow | null>;
    /** Record a firing: bump the count, stamp lastFiredAt, and (when `disarm`) retire a one-shot.
     *  Returns the updated row so the caller can see whether it is still armed. */
    recordFire(id: string, disarm: boolean, at: string): Promise<PlayerTriggerRow | null>;
    remove(id: string): Promise<boolean>;
  };
  /** Console-admin grants — the exact book-of-record pattern as vips, INCLUDING expiry: the game
   *  only supports permanent admins, so the panel owns the expiration and the worker sweep removes
   *  lapsed grants from the game. */
  consoleAdmins: {
    list(serverId?: string): Promise<ConsoleAdminRow[]>;
    get(serverId: string, playerId: string): Promise<ConsoleAdminRow | null>;
    /** Insert or update the (server, player) grant, setting name/group/comment/expiration. */
    upsert(input: NewConsoleAdmin): Promise<ConsoleAdminRow>;
    remove(serverId: string, playerId: string): Promise<boolean>;
    /** Grants whose expiration has passed `nowIso` (never permanent ones) — for the sweep. */
    expired(nowIso: string): Promise<ConsoleAdminRow[]>;
  };
  /** Named player groups for bulk actions (bulk VIP / console admin / temp ban / team swap…). */
  playerGroups: {
    list(): Promise<PlayerGroupRow[]>;
    get(id: string): Promise<PlayerGroupRow | null>;
    create(input: { name: string; description?: string | null; createdByUserId?: string | null; createdByName: string }): Promise<PlayerGroupRow>;
    update(id: string, patch: { name?: string; description?: string | null }): Promise<PlayerGroupRow | null>;
    /** Set (or with null, remove) the group's VIP perk. Null when the group does not exist. */
    setVipPerk(id: string, perk: GroupVipPerk | null): Promise<PlayerGroupRow | null>;
    /** Link the group to a community Discord role (or with null, unlink). Null when the group does
     *  not exist. Unlinking keeps every member where they are. */
    setDiscordRole(id: string, roleId: string | null): Promise<PlayerGroupRow | null>;
    remove(id: string): Promise<boolean>;
    members(groupId: string): Promise<PlayerGroupMemberRow[]>;
    /** Idempotent: re-adding refreshes the stored name, keeps the original adder (and source). A
     *  real add — someone not listed before — also queues a "joined" event for the rule engine. */
    addMember(input: { groupId: string; playerId: string; playerName?: string | null; addedByName: string }): Promise<PlayerGroupMemberRow>;
    /** True when they were listed; a real removal also queues a "left" event. */
    removeMember(groupId: string, playerId: string): Promise<boolean>;
    /**
     * The Discord role sync's own add and removal. Each lands only while the group is STILL linked
     * to `roleId`: a pass reads Discord for a while, and a group unlinked, moved to another role or
     * deleted in the meantime must not be changed on the old reading. The add lists someone not
     * listed at all, as a "discord" membership; the removal takes only a "discord" membership, never
     * one a person added. True when it changed something — and queued the joined/left event with it.
     */
    syncAddMember(input: { groupId: string; roleId: string; playerId: string; playerName?: string | null; addedByName: string }): Promise<boolean>;
    syncRemoveMember(input: { groupId: string; roleId: string; playerId: string }): Promise<boolean>;
    /**
     * Take up to `limit` queued membership changes, oldest first. Taking is CLAIMING: the row is
     * marked and stays queued until the taker finishes it (ackEvents) or puts it back
     * (deferEvent), so two API processes never get the same one (Postgres skips rows another
     * transaction holds) and a member's later change stays behind it in every process. A claim
     * older than an hour is a taker that died: it is dropped, never handed out twice. Only
     * changes whose `notBefore` has come are taken, a member's changes in a group one at a time
     * in order, and each says whether a later one of the same member is queued behind it.
     * Deleting a group queues nothing.
     */
    takeEvents(limit: number): Promise<PlayerGroupEventRow[]>;
    /** Done with these taken changes: they leave the queue. */
    ackEvents(ids: string[]): Promise<void>;
    /** Put a taken change back to wait: taken again from `notBefore`, for `ruleIds` only (null =
     *  every rule watching). It keeps its place in its member's order. */
    deferEvent(event: PlayerGroupEventRow, notBefore: string, ruleIds: string[] | null): Promise<void>;
    /** Which groups a GAME player id belongs to — for the profile. */
    groupsForPlayer(playerId: string): Promise<PlayerGroupRow[]>;
  };
  /** Per-server seeding automod + seed-reward config and its runtime progress/state. */
  seeding: {
    getConfig(serverId: string): Promise<SeedingConfigRow | null>;
    listConfigs(): Promise<SeedingConfigRow[]>;
    upsertConfig(serverId: string, patch: SeedingConfigPatch): Promise<SeedingConfigRow>;
    /** Add `deltaSeconds` of seeding presence for a player (upsert). */
    addProgress(serverId: string, playerId: string, playerName: string | null, deltaSeconds: number): Promise<void>;
    /**
     * The whole tick's roster in one statement — the per-player form is an N+1 on the 30s seeding
     * tick. Duplicate playerIds are pre-summed so the upsert never touches a row twice.
     */
    addProgressMany(serverId: string, adds: { playerId: string; playerName: string | null; deltaSeconds: number }[]): Promise<void>;
    listProgress(serverId: string): Promise<SeedProgressRow[]>;
    /** End the current seed cycle: drop all accrued progress for the server. */
    clearProgress(serverId: string): Promise<void>;
    getState(serverId: string): Promise<SeedingStateRow | null>;
    setState(state: SeedingStateRow): Promise<void>;
    /** Archive the cycle that just ended — kept until the next one replaces it. */
    setLastCycle(serverId: string, cycle: SeedCycleRecord): Promise<void>;
    getLastCycle(serverId: string): Promise<SeedCycleRecord | null>;
    /** Ask the worker to replay the archived cycle's reward round on its next tick. */
    requestPay(serverId: string): Promise<void>;
    /** Consume a pending pay request — true exactly once per request, so a request is never
     *  handled by two ticks. */
    takePayRequest(serverId: string): Promise<boolean>;
  };
  /** Per-layer learned attack geometry (see MapLayoutRow). Keyed by the lowercased map id. */
  mapLayouts: {
    list(): Promise<MapLayoutRow[]>;
    get(mapId: string): Promise<MapLayoutRow | null>;
    /** One round's vote for this layer. With `round` (the match's identity), a second vote from
     *  the same match is ignored — null is returned — so a restart mid-round cannot count one
     *  round twice. */
    record(mapId: string, vote: { axis: "x" | "y"; alliesDir: -1 | 1; separation?: number; round?: string | null }): Promise<MapLayoutRow | null>;
  };
  /** Per-server rotating broadcast config (the worker cycles the messages on an interval). */
  broadcast: {
    getConfig(serverId: string): Promise<BroadcastConfigRow | null>;
    listConfigs(): Promise<BroadcastConfigRow[]>;
    upsertConfig(serverId: string, patch: BroadcastConfigPatch): Promise<BroadcastConfigRow>;
  };
  /** Game rewards (see GameRewardsConfig): settings, once-only payout receipts, daily streak days. */
  gameRewards: {
    getConfig(serverId: string): Promise<GameRewardsConfigRow | null>;
    setConfig(serverId: string, config: GameRewardsConfig): Promise<GameRewardsConfigRow>;
    /** Claim one payout. true = this call owns it (pay it); false = already claimed (never pay twice). */
    claim(input: { serverId: string; playerId: string; ref: string; kind: string; detail?: Record<string, unknown> | null }): Promise<boolean>;
    /** Give a claim back — the payout it guarded delivered NOTHING (the game connection was lost
     *  mid-grant), so a later evaluation may pay it after all. */
    release(input: { serverId: string; playerId: string; ref: string }): Promise<void>;
    /** Add seconds to each player's day (kind "play"), returning each player's new total for that day. */
    addDaySeconds(serverId: string, kind: string, day: string, adds: { playerId: string; seconds: number }[]): Promise<{ playerId: string; seconds: number }[]>;
    /** A player's recorded days of `kind` on/after `sinceDay` (YYYY-MM-DD), oldest first. */
    days(serverId: string, playerId: string, kind: string, sinceDay: string): Promise<{ day: string; seconds: number }[]>;
  };
  /** The live welcome message (see WelcomeConfigRow). */
  welcome: {
    getConfig(serverId: string): Promise<WelcomeConfigRow | null>;
    upsertConfig(serverId: string, patch: WelcomeConfigPatch): Promise<WelcomeConfigRow>;
    /** Record what was just written to the game, so an unchanged fill is never written twice.
     *  `text: null` forgets it (the game lost its settings) so the next pass writes again. */
    markWritten(serverId: string, text: string | null, at: string | null): Promise<void>;
  };
  /** The bot's slash-command surface: what each command is CALLED, and whether it is installed.
   *  Community-wide (one bot, one application), so no server dimension. */
  appConfig: {
    get(): Promise<AppConfig>;
    set(patch: Partial<Omit<AppConfig, "updatedAt">>): Promise<AppConfig>;
  };

  /**
   * The install's own settings — the deployment's, not the community's: the key that signs logins,
   * service credentials, the setup code. One value per key. A value set as `secret` is sealed with
   * ENCRYPTION_KEY when there is one (the RCON-password policy), and opened on read; a sealed value
   * this install can no longer open reads as unset rather than failing every reader. Never in a
   * data archive (DATA_EXPORT_EXCLUDED): a restored install keeps its own.
   */
  installSettings: {
    get(key: string): Promise<string | null>;
    /** `null` removes the key. */
    set(key: string, value: string | null, opts?: { secret?: boolean; by?: string | null }): Promise<void>;
    /** The stored value, or `make()`'s, stored once: two callers racing both get the first one kept.
     *  A stored value that can no longer be opened is replaced. */
    getOrCreate(key: string, make: () => string, opts?: { secret?: boolean }): Promise<string>;
  };

  /**
   * The community's own images, uploaded in the panel: today the match board's corner badge. None
   * is built in. One shipped as a file once, and every install's board wore that one community's
   * badge; without an upload, the board carries only its server's name.
   */
  brandImages: {
    get(key: BrandImageKey): Promise<BrandImageRow | null>;
    set(key: BrandImageKey, image: { mime: string; bytes: Uint8Array; by: string | null }): Promise<BrandImageRow>;
    /** True when there was one to remove. */
    remove(key: BrandImageKey): Promise<boolean>;
  };

  discordCommands: {
    get(): Promise<DiscordCommandConfig>;
    set(patch: Partial<Omit<DiscordCommandConfig, "updatedAt">>): Promise<DiscordCommandConfig>;
  };
  /** The dedicated in-game chat filter — one community-wide word list (see ChatFilterConfig). */
  chatFilter: {
    get(): Promise<ChatFilterConfig>;
    set(patch: Partial<Omit<ChatFilterConfig, "updatedAt">>): Promise<ChatFilterConfig>;
  };
  /** Per-server Discord relay routing (category → channel). Read by the discord bot process. */
  discordRelay: {
    getConfig(serverId: string): Promise<DiscordRelayConfigRow | null>;
    listConfigs(): Promise<DiscordRelayConfigRow[]>;
    upsertConfig(serverId: string, patch: DiscordRelayConfigPatch): Promise<DiscordRelayConfigRow>;
    /**
     * Write ONLY the status board's worker-owned state, touching nothing else on the row.
     *
     * The worker cannot use upsertConfig for this: that is a read-modify-write of the whole row,
     * and the worker holds its snapshot across a multi-second render plus a Discord round-trip.
     * Any staff save landing in that window would be clobbered by the stale copy — and a staff
     * save in the other order would drop the freshly posted messageId, which is how a second
     * board ends up in the channel. This merges the two keys at the store, atomically.
     */
    patchBoardState(serverId: string, state: { messageId: string | null; imageName: string | null }): Promise<void>;
  };
  /** Per-server auto-settings: scheduled/population-driven config profiles (the worker applies them). */
  autosettings: {
    getConfig(serverId: string): Promise<AutoSettingsConfigRow | null>;
    listConfigs(): Promise<AutoSettingsConfigRow[]>;
    upsertConfig(serverId: string, patch: AutoSettingsConfigPatch): Promise<AutoSettingsConfigRow>;
    /** Templates are community-wide, so one behaviour set can be stamped onto every server. */
    templates: {
      list(): Promise<AutoSettingsTemplateRow[]>;
      /** case-insensitive by name — templates are referenced by name from profile actions. */
      get(name: string): Promise<AutoSettingsTemplateRow | null>;
      /** upsert by name (case-insensitive): saving under an existing name replaces it. */
      save(input: { name: string; config: AutoSettingsTemplateRow["config"]; createdByName: string }): Promise<AutoSettingsTemplateRow>;
      remove(id: string): Promise<boolean>;
    };
  };
  /**
   * Staff-set per-map overrides, per game: the display name (cosmetic) and the family (which the
   * vote engine groups variants by). Neither is ever a lookup key — every code path keys off the
   * raw map id — and a row may carry either one alone.
   */
  mapNames: {
    list(game: string): Promise<MapNameRow[]>;
    /** Set the display override; blank clears it. Returns the row, or null once nothing is left. */
    set(game: string, mapId: string, displayName: string): Promise<MapNameRow | null>;
    /** Set the family override; blank clears it. Returns the row, or null once nothing is left. */
    setFamily(game: string, mapId: string, family: string): Promise<MapNameRow | null>;
  };
  /**
   * Staff-taught objective locations, per game and map FAMILY (the zone/art key): each of the
   * 5×3 grid options can carry the name the community knows it by — Vietnam's wire offers only
   * digits — and the tactical-map cell ("E6") it sits in, which is what the picker highlights.
   * Taught once, read by the panel's objectives picker and the Discord sector walk alike.
   */
  objectivePoints: {
    forMap(game: string, mapKey: string): Promise<ObjectivePointRow[]>;
    /** Teach one option; an explicitly blank half clears it, and a row left with neither name
     *  nor sector is dropped. Omitted halves are untouched. */
    set(game: string, mapKey: string, row: number, idx: number, patch: { name?: string | null; sector?: string | null }): Promise<ObjectivePointRow | null>;
  };
  layoutExpiries: {
    /** Every standing countdown — the worker's sweep walks this. */
    list(): Promise<ObjectiveLayoutExpiryRow[]>;
    get(serverId: string, mapId: string): Promise<ObjectiveLayoutExpiryRow | null>;
    /** Start (or restart) a countdown — a re-save replaces whatever stood. */
    set(input: { serverId: string; mapId: string; playsLeft: number; lastMatchId: string | null; setBy: string }): Promise<ObjectiveLayoutExpiryRow>;
    /** One play counted: the new remaining count and the match that consumed it. */
    count(serverId: string, mapId: string, playsLeft: number, lastMatchId: string): Promise<void>;
    delete(serverId: string, mapId: string): Promise<void>;
  };
  /**
   * What the removed objective presets ("Map points") may have left: at most one row per server,
   * from a press made before the update. A Vietnam row is the only record of a layout to put back
   * on the game server (apps/workers preset-leftovers.ts); nothing writes rows any more, so the
   * worker drains the table and then stops asking.
   */
  mapPointPending: {
    list(): Promise<MapPointPendingRow[]>;
    /** Delete AND return in one step, so exactly one actor ever gets to act on a given row. */
    take(serverId: string, id: string): Promise<MapPointPendingRow | null>;
  };
  /**
   * Admin-camera sessions: the durable record of who was in spectator, where, and for how long.
   *
   * Kept as its own table rather than read back out of the event log, because the log is trimmable
   * and a pair of unrelated events cannot answer "how long". Sessions are built by the ingest as
   * the enter/leave lines arrive.
   */
  /** The community's signature settings — one row, always present. */
  signatures: {
    get(): Promise<SignatureConfigRow>;
    set(patch: SignatureConfigPatch): Promise<SignatureConfigRow>;
  };
  adminCam: {
    /** Somebody entered cam. Re-entering while a session is already open is a no-op, so a replayed
     *  or duplicated log line never mints a second overlapping row. */
    open(input: { serverId: string; playerId: string | null; playerName: string; at: string }): Promise<void>;
    /** Close the open session. Returns the elapsed seconds, or null when nothing was open — an
     *  exit with no matching entry is dropped rather than recorded as a zero-length visit. */
    close(input: { serverId: string; playerId: string | null; playerName: string; at: string }): Promise<number | null>;
    /** A finished visit with both ends known — the historical importer's write. Idempotent on the
     *  enter instant, so re-applying an archive repairs rather than duplicates. Returns whether a
     *  row was actually added. */
    importOne(input: { serverId: string; playerId: string | null; playerName: string; enteredAt: string; exitedAt: string; durationSec: number }): Promise<boolean>;
    list(query?: AdminCamQuery): Promise<AdminCamSessionRow[]>;
    count(query?: AdminCamQuery): Promise<number>;
    /** Distinct admins seen in cam, for the history page's filter. */
    admins(serverIds?: string[]): Promise<{ playerId: string | null; playerName: string }[]>;
    getConfig(serverId: string): Promise<AdminCamConfigRow | null>;
    setConfig(serverId: string, patch: AdminCamConfigPatch): Promise<AdminCamConfigRow>;
  };
  /**
   * The community-wide map-set library. Not per-server on purpose: a curated pool is work, and
   * making every server keep its own copy meant doing that work again per server and then keeping
   * the copies in step by hand.
   */
  mapSets: {
    /** Every set, or only one game's when a game is named. */
    list(game?: string): Promise<MapSetRow[]>;
    get(id: string): Promise<MapSetRow | null>;
    /** By name, case-insensitively — the form the link stores. */
    findByName(name: string): Promise<MapSetRow | null>;
    /** `id` only when bringing a deleted set back from its history (see NewRule.id). */
    create(input: { id?: string; name: string; game: string; pool?: Record<string, unknown> }): Promise<MapSetRow>;
    /** Patch name, game and/or pool. Returns null if the id is gone. Throws on a duplicate name. */
    update(id: string, patch: { name?: string; game?: string; pool?: Record<string, unknown> }): Promise<MapSetRow | null>;
    remove(id: string): Promise<boolean>;
  };
  /** Version history for rules, map sets and vote schedules — see ConfigVersionRow. */
  configVersions: {
    /** Keep one save, then trim that record's history to its newest CONFIG_VERSIONS_KEPT. */
    record(input: NewConfigVersion): Promise<ConfigVersionRow>;
    /** One record's saves, newest first. */
    list(kind: ConfigVersionKind, targetId: string, limit?: number): Promise<ConfigVersionRow[]>;
    get(id: string): Promise<ConfigVersionRow | null>;
    /** Each record's LATEST deletion of this kind, newest first. Some may have been brought back
     *  since — the caller checks the record itself. */
    deletions(kind: ConfigVersionKind, limit?: number): Promise<ConfigVersionRow[]>;
  };
  /** The community-wide zone-set library (sector paints per map, per game) — see MapZoneSetRow.
   *  Same library shape as mapSets on purpose; they answer the same "author once, use anywhere". */
  mapZones: {
    list(game?: string): Promise<MapZoneSetRow[]>;
    get(id: string): Promise<MapZoneSetRow | null>;
    create(input: { name: string; game: string; zones?: MapZoneSetRow["zones"] }): Promise<MapZoneSetRow>;
    /** Patch name and/or zones (game is fixed at creation — a paint is drawn over one game's maps). */
    update(id: string, patch: { name?: string; zones?: MapZoneSetRow["zones"] }): Promise<MapZoneSetRow | null>;
    remove(id: string): Promise<boolean>;
  };
  /** The community-wide schedule library — WHEN, separated from WHAT so one timing serves many
   *  sets. Same shape as mapSets deliberately; they are edited by the same surface. */
  voteSchedules: {
    list(): Promise<VoteScheduleRow[]>;
    get(id: string): Promise<VoteScheduleRow | null>;
    findByName(name: string): Promise<VoteScheduleRow | null>;
    /** `id` only when bringing a deleted schedule back from its history (see NewRule.id). */
    create(input: { id?: string; name: string; spec?: Record<string, unknown> }): Promise<VoteScheduleRow>;
    update(id: string, patch: { name?: string; spec?: Record<string, unknown> }): Promise<VoteScheduleRow | null>;
    remove(id: string): Promise<boolean>;
  };
  /** Per-server map-vote config (scheduled pool profiles) + runtime poll state. */
  mapVote: {
    getConfig(serverId: string): Promise<MapVoteConfigRow | null>;
    setConfig(serverId: string, patch: MapVoteConfigPatch): Promise<MapVoteConfigRow>;
    /** all configs (for the worker's scan). */
    listConfigs(): Promise<MapVoteConfigRow[]>;
    getState(serverId: string): Promise<MapVoteStateRow | null>;
    /**
     * Replace the WHOLE row. Almost never what you want — see `patchState`. Kept for the one
     * legitimate case, wiping the state back to a known baseline.
     */
    setState(state: MapVoteStateRow): Promise<void>;
    /**
     * Write only the fields given, leaving every other column as it is in the database.
     *
     * This row has two writers — the worker's tick and the panel's control buttons — and they
     * touch disjoint fields. Expressed as read-modify-write over the full row, the worker would
     * read the state, spend a second or two talking to Discord, and then write back a snapshot
     * that predated whatever staff had just pressed: Pause looked like it worked and then quietly
     * un-paused itself on the next tick. Patching only the columns a caller actually decided
     * removes the conflict rather than narrowing the window.
     */
    patchState(serverId: string, patch: MapVoteStatePatch): Promise<MapVoteStateRow>;
    /** Record a concluded vote. */
    recordHistory(input: NewMapVoteHistory): Promise<MapVoteHistoryRow>;
    /** Most recent concluded votes, newest first. */
    history(serverId: string, limit?: number, offset?: number): Promise<MapVoteHistoryRow[]>;
    /** How many votes are recorded for the server — the pager's denominator. */
    historyCount(serverId: string): Promise<number>;
    /**
     * Headline figures over EVERY recorded vote, not the page on screen: the history page's
     * stat tiles must describe the whole record even when the table below shows twenty rows.
     */
    historySummary(serverId: string): Promise<{ rounds: number; decided: number; forced: number; silent: number; totalVotes: number; contested: number }>;
    /** Per-map offered/won/vote totals across the recorded history. */
    mapTally(serverId: string, limit?: number): Promise<MapVoteTally[]>;
    /** Who votes, how often, and how often their pick wins — busiest voters first. Resolves the
     *  Discord ↔ player link so staff see names they recognise, not snowflake ids. */
    voterSummary(serverId: string, limit?: number): Promise<MapVoteVoterSummary[]>;
    /** One Discord account's map preferences, most-voted first. `serverId` narrows to one server,
     *  `serverIds` to a set of them (the servers a reader may see). */
    preferences(discordUserId: string, opts?: { serverId?: string; serverIds?: string[]; limit?: number }): Promise<MapVotePreference[]>;
    /** One Discord account's individual ballots, newest first. */
    ballots(discordUserId: string, opts?: { serverId?: string; serverIds?: string[]; limit?: number }): Promise<MapVoteBallotRow[]>;
    /** Totals for one Discord account: how many votes cast and how many went their way. */
    voterTotals(discordUserId: string, serverId?: string, serverIds?: string[]): Promise<{ votes: number; wins: number; firstVotedAt: string | null; lastVotedAt: string | null }>;
  };
  /**
   * Bans as staff MEANT them — the intent behind what the game servers enforce.
   *
   * Separate from `crconBans` (an import archive) and from the audit trail (an event log that
   * cannot answer "is this player banned right now" without a replay). This is the state, and it
   * is what the reconciler compares each server's live ban list against.
   */
  playerBans: {
    /** `activeOnly` drops lifted and expired rows — the reconciler's question. */
    list(query?: { game?: string; playerId?: string; activeOnly?: boolean }): Promise<PlayerBanRow[]>;
    get(id: string): Promise<PlayerBanRow | null>;
    create(input: NewPlayerBan): Promise<PlayerBanRow>;
    /** Stamp a row lifted. Returns false if it was already lifted or never existed. */
    lift(id: string, liftedByName: string, liftedAt?: string): Promise<boolean>;
    /** Lift every active ban on a player, optionally only of one kind. Returns how many. */
    liftAllFor(playerId: string, liftedByName: string, kind?: "temp" | "perma"): Promise<number>;
    /** Replace a decision's scope rule — how a PARTIAL unban is recorded: the rule shrinks to the
     *  servers still banned instead of the whole row being stamped lifted. Refuses lifted rows. */
    setScope(id: string, scope: BanScopeJson): Promise<boolean>;
    /** Move a decision's expiry — how an approved over-cap extension lands: the SAME sentence
     *  grows, rather than a ban/unban/ban zigzag. Refuses lifted rows. */
    setExpiry(id: string, expiresAt: string | null): Promise<boolean>;
  };
  /** The community economy — members keyed by Discord id, an append-only ledger, one config row.
   *  See docs/vip-module.md. */
  economy: {
    member(discordId: string): Promise<CommunityMemberRow | null>;
    /** Upsert-and-return; refreshes the stored Discord name when one is given. */
    ensureMember(discordId: string, discordName?: string | null): Promise<CommunityMemberRow>;
    /** `q` searches id and name. Ordered by balance descending — the screen is a leaderboard. */
    members(query?: { q?: string; limit?: number; offset?: number }): Promise<CommunityMemberRow[]>;
    membersCount(q?: string): Promise<number>;
    /**
     * The ONE write path for balances: ledger row + cached balance, atomically.
     *  - Credits clamp at `maxBalance` — the row records the applied delta, possibly 0.
     *  - A debit below zero throws InsufficientBalance; the CHECK constraint backs this in the
     *    store itself.
     *  - A duplicate `ref` applies nothing and returns the row that already owns the ref with
     *    `applied: false` — how a double-click, a replay, or a same-period claim becomes a no-op.
     */
    apply(entry: NewEconomyEntry, opts?: { maxBalance?: number | null }): Promise<{ member: CommunityMemberRow; entry: EconomyLedgerRow; applied: boolean }>;
    /**
     * One member's entries, newest first. `limit` defaults to ECONOMY_LEDGER_PAGE — a PAGE, never
     * "everything": the ledger is append-only and a long-standing member's runs to thousands of
     * rows. Callers that need a total ask `ledgerCount`.
     */
    ledger(discordId: string, opts?: { limit?: number; offset?: number }): Promise<EconomyLedgerRow[]>;
    /**
     * The cross-member activity feed: every member's entries in one list, newest first, with the
     * member's name joined on for display. `kind` filters by the ECONOMY_ACTIVITY_KINDS families
     * (an unknown kind returns nothing rather than everything — a typo must not read as "all").
     * This is the read behind Economy → Activity; per-member questions stay on `ledger`.
     */
    activity(opts?: { kind?: string; limit?: number; offset?: number }): Promise<{ entries: EconomyActivityRow[]; total: number }>;
    ledgerCount(discordId: string): Promise<number>;
    /** Newest entry whose ref starts with `prefix` — what "when can I claim again" derives from. */
    lastEntryWithRefPrefix(discordId: string, prefix: string): Promise<EconomyLedgerRow | null>;
    /** How many members sit above `cap` right now, and by how much in total. Read-only — the
     *  number the panel shows next to the offer to fix it. Null cap means nothing is over. */
    overCap(cap: number | null): Promise<{ members: number; excess: number }>;
    /**
     * Bring every balance above `cap` down to it, as REAL ledger rows (one negative entry each,
     * reason given), so the correction is explainable to the member it happened to rather than a
     * number silently changing overnight.
     *
     * The repair for credits that landed uncapped — `apply` clamps at write time, but a caller
     * that omitted the cap has already overshot, and its ref is spent, so re-running the import
     * converges on the wrong figure. Idempotent by construction: a second call finds nobody over.
     */
    trimToCap(cap: number, actorName: string, reason?: string): Promise<{ members: number; removed: number }>;
    config(): Promise<EconomyConfig>;
    setConfig(patch: EconomyConfigPatch): Promise<EconomyConfig>;
  };
  payouts: {
    /** Open a job in RUNNING. Items stream in via addItem; finish() closes it. */
    create(input: NewPayoutJob): Promise<PayoutJobRow>;
    /** One receipt row, written the moment that recipient's outcome is known. */
    addItem(input: NewPayoutItem): Promise<void>;
    /** Every recipient's receipt as PENDING, before the first payment — so an interruption leaves
     *  the unreached on the ledger. Returns the row ids in the order given. */
    openItems(jobId: string, rows: { playerId: string | null; discordId: string | null; displayName: string }[]): Promise<number[]>;
    /** Replace a PENDING receipt with its outcome, in place. */
    settleItem(id: number, outcome: { status: "PASS" | "FAIL"; error: string; detail: Record<string, unknown> }): Promise<void>;
    /** Close the job with its final tallies. */
    finish(id: string, patch: { status: PayoutJobRow["status"]; successCount: number; failedCount: number }): Promise<void>;
    get(id: string): Promise<PayoutJobRow | null>;
    /** Newest first. */
    list(opts?: { limit?: number; offset?: number }): Promise<PayoutJobRow[]>;
    count(): Promise<number>;
    /**
     * The REAL (non-dry-run) runs made for these events, oldest first: each event payout, and
     * every retry down its chain — followed by `sourceRef.jobId`, the run each retry retried, so
     * retries recorded before `rootJobId` existed are found too. What the events list's Payment
     * column is read from (@app/payout's `eventPayments`).
     */
    forEvents(eventIds: string[]): Promise<PayoutJobRow[]>;
    items(jobId: string, opts?: { limit?: number; offset?: number }): Promise<PayoutItemRow[]>;
    itemsCount(jobId: string): Promise<number>;
    /** The FAIL rows of a job — what a retry pays — plus, with `includePending`, the rows it
     *  never reached (only for an INTERRUPTED job: a running one is still paying them). */
    failedItems(jobId: string, opts?: { includePending?: boolean }): Promise<PayoutItemRow[]>;
    /** A REAL (non-dry-run) job with this identity that ran, is running, or was interrupted — the
     *  duplicate gate. An interrupted run paid part of its list, so running it again would pay
     *  that part twice; its rest is a retry. Dry runs never count: rehearsing a payout must not
     *  block performing it. */
    findDuplicate(duplicateKey: string): Promise<PayoutJobRow | null>;
    /** Flip every RUNNING job to INTERRUPTED — called once at boot, because a RUNNING row after
     *  a restart is a driver that no longer exists — with its tallies filled from the receipts
     *  (finish() never ran): PASS rows ok, the rest failed or unreached. Returns how many. */
    interruptStale(): Promise<number>;
  };
  /** Named payout windows with self-resolving boundaries. The stores only persist state — the
   *  decision of WHEN a boundary resolves is @app/payout's `resolveEventBoundaries`, applied by
   *  the worker sweep and the API alike via `applyTransition`. */
  payoutEvents: {
    create(input: NewPayoutEvent): Promise<PayoutEventRow>;
    get(id: string): Promise<PayoutEventRow | null>;
    /**
     * Edit an event that has not finished happening. Status-guarded in the store (see
     * PayoutEventPatch): a scheduled event takes any field, an open one keeps its resolved open
     * boundary and its server, and a closed or cancelled one refuses — returns null, which the
     * caller reports rather than silently no-ops.
     */
    update(id: string, patch: PayoutEventPatch): Promise<PayoutEventRow | null>;
    /** The worker's latch after applying an open event's rotation set — not a staff edit. */
    markRotationApplied(id: string, atIso: string): Promise<void>;
    /** Newest first. */
    list(opts?: { limit?: number; offset?: number }): Promise<PayoutEventRow[]>;
    count(): Promise<number>;
    /** The sweep's working set: every scheduled/open event. */
    pending(): Promise<PayoutEventRow[]>;
    /**
     * Persist what one sweep decided. openedAt flips scheduled→open; closedAt flips →closed and
     * stores the materialised roster beside it (the event must outlive session trimming). Guarded
     * by current status so a racing worker+API pair cannot close an event twice or reopen a
     * cancelled one — returns the row as it now stands, or null if the event is gone.
     */
    applyTransition(id: string, t: { openedAt?: string; closedAt?: string; roster?: { playerId: string; name: string | null; minutes: number }[] }): Promise<PayoutEventRow | null>;
    /** Cancel a scheduled or open event. Returns false when it was already closed/cancelled —
     *  a closed window is a record, not a plan, and cancelling records is how evidence vanishes. */
    cancel(id: string): Promise<boolean>;
    /**
     * Mark a CLOSED event as needing no payout (`mark` says when and who), or clear the mark
     * (null). The way out of "Awaiting payment" for an event nobody means to pay: cancelling would
     * unmake the record, which a closed event refuses. Status-guarded: any other status, or no such
     * event, returns null and changes nothing — an event still to finish has nothing to decide yet.
     */
    setNoPayout(id: string, mark: { at: string; by: string } | null): Promise<PayoutEventRow | null>;
    /** The self-sending Discord post's settings (see EventPostConfig). One row, community-wide. */
    getPostConfig(): Promise<EventPostConfig>;
    setPostConfig(patch: Partial<EventPostConfig>): Promise<EventPostConfig>;
  };
  /** Game bans imported from CRCON — an import archive. Upsert is keyed by
   *  (serverId, playerId, type) so re-importing never duplicates a row. */
  crconBans: {
    list(query?: { serverId?: string }): Promise<CrconBanRow[]>;
    upsert(input: NewCrconBan): Promise<CrconBanRow>;
    remove(serverId: string, playerId: string, type: "temp" | "perma"): Promise<boolean>;
  };
  /** Persistent match history + per-player scoreboards. A match is opened on MATCH START and closed
   *  on MATCH ENDED; player lines are folded live from the kill stream via `bumpStat`. */
  matches: {
    /** Open a new match for a server, closing any still-open one first. Returns the new match. */
    open(input: { serverId: string; map: string | null; startedAt: string }): Promise<MatchRow>;
    /** The currently-open (unfinished) match for a server, if any. */
    getOpen(serverId: string): Promise<MatchRow | null>;
    /**
     * Stamp the score the game is reporting RIGHT NOW onto whichever round is open on this server.
     *
     * The MATCH ENDED log line is the only other source of a final score, and it does not always
     * carry one (HLL: Vietnam's does not), which left every finished round scoreless and
     * winnerless. The live session read has the score all along — it is what draws the panel's
     * match header — so sampling it each tick means the last sample before the whistle IS the
     * final score. No-op when no round is open (between maps).
     */
    recordScore(serverId: string, score: { alliedScore: number; axisScore: number; initialMorale?: number; alliedMorale?: number; axisMorale?: number }): Promise<void>;
    /** One pass of the score-timeline recorder: append a flip and/or morale point, set
     *  match_time if still 0, set CRCON's initial_morale if still null. */
    recordTimeline(matchId: string, step: { flip?: [number, number, number]; morale?: [number, number, number]; matchTime?: number; initialMorale?: number }): Promise<void>;
    /** CRCON's record of a round's start, made once: the layer id it is filed under, whether that
     *  was guessed, its match_time (if still 0) and initial_morale. A no-op once decided. */
    recordStart(matchId: string, start: { map: string; guessed: boolean; matchTime: number; initialMorale: number | null }): Promise<void>;
    /** CRCON's record of a round's end, made once (see MatchRow.crconEndDeferred). */
    recordEnd(matchId: string, end: { deferred: boolean }): Promise<void>;
    /** The round's CRCON player cache (CrconPlayerStat), null when nothing was recorded. */
    crconPlayers(matchId: string): Promise<CrconPlayerCache | null>;
    /** Replace the round's CRCON player cache with what the recorder computed. */
    saveCrconPlayers(matchId: string, cache: CrconPlayerCache): Promise<void>;
    /** Add a point to each player's score series for the round (match_score_series). A point
     *  that repeats the player's last totals is dropped, and a platform id with no player is
     *  skipped. */
    appendScoreSeries(matchId: string, points: ScoreSeriesPoint[]): Promise<void>;
    /** The round's score series by internal player id: five ints a point, flattened (secs since
     *  the start, combat, offense, defense, support). Players with no points are absent. */
    scoreSeries(matchId: string): Promise<Map<string, number[]>>;
    /** The player cache a short round (crcon_short_rounds) kept when it was discarded. */
    crconShortRoundPlayers(seq: number): Promise<CrconPlayerCache | null>;
    /**
     * Close a match with its parsed outcome. Returns the updated row (or null if already gone).
     *
     * A null score does NOT erase a sampled one: the log line not carrying a score is an absence
     * of information, not a report of "no score". Same for the winner — passing null keeps
     * whatever the scores imply.
     */
    close(id: string, patch: { endedAt: string; winner: "allies" | "axis" | null; alliedScore: number | null; axisScore: number | null; result: string | null }): Promise<MatchRow | null>;
    /**
     * Drop a round that ended (at `endedAt`) less than MIN_MATCH_MS after it started: it was never
     * a game. Whatever it gave careers is taken back first (sampled scores it was credited with, a
     * settled played/won), then it goes with its scoreboard. A round that did run long enough is
     * refused (false) — so no caller can delete a real game by mistake. A copy of what the
     * CRCON-compatible endpoints publish stays behind (crconRounds), with `endedText` (the MATCH
     * ENDED line's text, when a whistle closed it) as its result.
     */
    discardShort(id: string, endedAt: string, endedText?: string | null): Promise<boolean>;
    /** A server's rounds as CRCON lists them, newest first: ours, and the short ones only those
     *  endpoints keep (CrconRoundRow). */
    crconRounds(serverId: string, limit: number, offset: number): Promise<CrconRoundRow[]>;
    /** How many rounds crconRounds lists for the server. */
    crconRoundCount(serverId: string): Promise<number>;
    /** One of crconRounds by its public alias, with the round that started next after it (null
     *  for the newest) — CRCON files a round's scoreboard as the next one starts. */
    crconRoundBySeq(serverId: string, seq: number): Promise<{ round: CrconRoundRow; newer: CrconRoundRow | null } | null>;
    get(id: string): Promise<MatchRow | null>;
    /** Look a round up by its public integer alias (the CRCON-compatible `map_id`). */
    getBySeq(seq: number): Promise<MatchRow | null>;
    /**
     * Rounds for a server, newest first. `beforeIso` is an exclusive upper bound on startedAt: it
     * pins the result set so a round that ends while someone is paging cannot shift every later
     * page down by one and make them re-read what they just read.
     */
    list(serverId: string, limit?: number, offset?: number, beforeIso?: string): Promise<MatchRow[]>;
    /** How many rounds this server has on record — the denominator for paging. */
    count(serverId: string): Promise<number>;
    /** The earliest match to START at/after `iso` on this server — what a payout event's
     *  "open with the first new round after X" boundary resolves against. */
    firstStartedAfter(serverId: string, iso: string): Promise<MatchRow | null>;
    /** The earliest-ENDING finished match with endedAt at/after `iso` — ordered by endedAt, not
     *  startedAt, because the round that closes an event is the first to FINISH past the anchor,
     *  which is not always the first to have started. */
    firstEndedAfter(serverId: string, iso: string): Promise<MatchRow | null>;
    /** Fold one player's kill/death/teamkill delta onto their line for a match (upsert). `side`, when
     *  given, is recorded (last write wins) so finished matches can be attributed as wins/losses. */
    bumpStat(input: { matchId: string; playerId: string; serverId: string; playerName?: string | null; side?: "allies" | "axis" | null; kills?: number; deaths?: number; teamkills?: number }): Promise<void>;
    /** Many scoreboard folds in one round trip — same rules as `bumpStat`, including that `side`
     *  and `playerName` are last-non-null-wins. See `stats.bumpMany` for why this exists. */
    bumpStatMany(inputs: { matchId: string; playerId: string; serverId: string; playerName?: string | null; side?: "allies" | "axis" | null; kills?: number; deaths?: number; teamkills?: number }[]): Promise<void>;
    /** Every player's line for a match, best score first. */
    statsForMatch(matchId: string): Promise<PlayerMatchStatRow[]>;
    /**
     * The best single-round figures ever recorded on a server — the records board. Stat rows
     * joined with their round (map + date + public alias, so the record can say WHEN), ordered by
     * one whitelisted column, finished rounds only: an open round's numbers are still moving and
     * a record that un-happens at the whistle is not a record.
     */
    topStats(serverId: string, key: MatchRecordKey, limit?: number): Promise<MatchStatRecord[]>;
    /** How many players each of a server's rounds actually had — one GROUP BY, keyed by match.
     *  The raw material for "was this round seeded", which nothing stores because it is always
     *  derivable from the stat rows that are the ground truth for who played. */
    participantCounts(serverId: string): Promise<{ matchId: string; players: number }[]>;
    /** Finished rounds the weapon-kill rollup has not visited yet, newest first — fresh records
     *  surface immediately and history backfills behind them. */
    pendingWeaponRollup(limit?: number): Promise<MatchRow[]>;
    /** Write one round's per-player per-WEAPON counts, both directions — kills WITH the weapon
     *  and deaths TO it (class resolved at fold time, stored beside the weapon) — and stamp the
     *  round visited: stamped even for an empty fold, so a round without a kill log is never
     *  re-scanned. Replaces any earlier rollup for the round, so a re-run corrects rather than
     *  double-counts. */
    saveWeaponRollup(matchId: string, rows: { playerId: string; weapon: string; classId: string; kills: number; deaths: number }[]): Promise<void>;
    /** Which weapon classes have any rolled-up kills on this server — the boards worth drawing. */
    classesWithData(serverId: string): Promise<string[]>;
    /** Best single-round totals for one weapon CLASS (summed over its weapons per player per
     *  round), naming the weapon that carried the record. Finished rounds only, like topStats. */
    topClassKills(serverId: string, classId: string, limit?: number): Promise<ClassKillRecord[]>;
    /** Career totals for one class, summed over rolled-up rounds. */
    classTotals(serverId: string, classId: string, limit?: number): Promise<{ playerId: string; name: string | null; kills: number }[]>;
    /** The weapons with the most recorded kills on a server — which individual boards to draw. */
    weaponSummary(serverId: string, limit?: number): Promise<{ weapon: string; classId: string; totalKills: number }[]>;
    /** Best single-round counts for ONE weapon. Finished rounds only. */
    topWeaponKills(serverId: string, weapon: string, limit?: number): Promise<MatchStatRecord[]>;
    /** Career totals for one weapon. */
    weaponTotals(serverId: string, weapon: string, limit?: number): Promise<{ playerId: string; name: string | null; kills: number }[]>;
    /** One player's career weapons on one server, biggest first — the career page's breakdown. */
    playerWeaponTotals(serverId: string, playerId: string, limit?: number): Promise<{ weapon: string; kills: number }[]>;
    /** The victim side of the boards: who has died most to one CLASS, career, on one server. */
    classDeathTotals(serverId: string, classId: string, limit?: number): Promise<{ playerId: string; name: string | null; deaths: number }[]>;
    /** …and to one individual weapon. */
    weaponDeathTotals(serverId: string, weapon: string, limit?: number): Promise<{ playerId: string; name: string | null; deaths: number }[]>;
    /** One player's career "died to" weapons on one server — the career page's other column. */
    playerWeaponDeathTotals(serverId: string, playerId: string, limit?: number): Promise<{ weapon: string; deaths: number }[]>;
    /** A player's recent per-match lines joined with the match (for their profile). */
    listForPlayer(playerId: string, limit?: number): Promise<PlayerMatchRow[]>;
    /** Rollup of a player's finished matches into win/loss + combat totals. */
    aggregateForPlayer(playerId: string): Promise<PlayerMatchAggregate>;
    /** Every player's line for a SET of matches — the raw material for "most played with/against"
     *  on a profile (one query for the player's recent matches instead of one per match). */
    participants(matchIds: string[]): Promise<PlayerMatchStatRow[]>;
    /** Import a finished match from an external record (CRCON map history). Idempotent on
     *  (serverId, startedAt); returns true only when a new row was created. Never touches an
     *  open match — imported rounds always arrive already ended. */
    importOne(input: { serverId: string; map: string | null; startedAt: string; endedAt: string | null; winner: "allies" | "axis" | null; result: string | null }): Promise<boolean>;
    /**
     * Import a round's FULL scoreboard from CRCON's per-map stats — the record the plain history
     * import cannot carry: the final score, and each player's score buckets, vehicle kills and
     * round playtime, which no log line ever reports and therefore cannot be derived later.
     *
     * Idempotent by construction so a re-run tops up instead of double-counting:
     *   - the match is created if missing (same identity and arbiter rules as `importOne`),
     *     scores/winner fill only what is NULL — anything already recorded wins over a backfill;
     *   - per-player numbers take GREATEST(existing, imported): the kill-log import may have
     *     counted kills for the same round already, and CRCON's round total should equal it —
     *     max keeps whichever source saw more without ever summing the two;
     *   - `side` fills only when unknown; playtime lands in roleSeconds under the "-1" sentinel
     *     (below) and only when no role time exists at all, so a re-import cannot add it twice.
     *
     * Returns how it landed so the transform can count honestly.
     */
    importScoreboard(input: {
      serverId: string; map: string | null; startedAt: string; endedAt: string | null;
      alliedScore: number | null; axisScore: number | null;
      stats: {
        playerId: string; playerName: string | null; side: "allies" | "axis" | null;
        kills: number; deaths: number; teamkills: number;
        combat: number; offense: number; defense: number; support: number;
        vehicleKills: number; vehiclesDestroyed: number;
        /** CRCON's per-round playtime; null when its row had none. */
        timeSeconds: number | null;
        /** Real role clocks collapsed from CRCON's unit history (game role int → seconds).
         *  When present and non-empty it replaces the "-1 unknown-role" sentinel: the imported
         *  round then carries the same shape a live-sampled round does. */
        roleSeconds?: Record<string, number> | null;
      }[];
    }): Promise<{ created: boolean; statsApplied: number }>;
    /** Record the objective layout staff just set, against whichever round is open on this server.
     *  Returns the match it landed on, or null when no round is open (between maps, or before the
     *  first MATCH START after a restart) — the layout is still applied in game either way, we just
     *  have nothing to hang it on. Last write wins: staff can re-set mid-round. */
    recordSectorLayout(input: { serverId: string; layout: string[]; by: string | null }): Promise<MatchRow | null>;
  };
  /** Jobs that track a slow CRCON pull. The archive itself is a host-side NDJSON file (not the DB),
   *  so only the small job record — status, resume cursor, counts, key — lives here. */
  crconSnapshot: {
    createJob(input: NewCrconImportJob): Promise<CrconImportJobRow>;
    getJob(id: string): Promise<CrconImportJobRow | null>;
    /** Most recent job for a server (the panel shows this). */
    latestJob(serverId: string): Promise<CrconImportJobRow | null>;
    listJobs(serverId?: string): Promise<CrconImportJobRow[]>;
    updateJob(id: string, patch: CrconImportJobPatch): Promise<CrconImportJobRow | null>;
    /** The stored CRCON API key for a job — worker-only, never returned through the API. */
    getJobApiKey(id: string): Promise<string | null>;
    /**
     * Fast integrity read over what past imports left in the database. `crossServerEvents` is the
     * smoking gun of a multi-server contamination: the same CRCON log row (dedupe key
     * `crcon:<id>`) applied under MORE THAN ONE server — only possible when unfiltered pulls fed
     * both servers the whole install's logs. The rest sizes the imported era so a reset's blast
     * radius is known before anyone confirms it.
     */
    importIntegrity(serverId: string): Promise<{
      cutoff: string | null;
      importedEvents: number;
      crossServerEvents: number;
      preCutoffMatches: number;
      preCutoffSessions: number;
    }>;
    /**
     * VIP expiries that no longer agree with the newest deliberate setting of them — the damage an
     * apply did before `vips.importOne` existed, when the archive's expiration was written over the
     * live one. A setting is anything that set an expiry on purpose and recorded the value: a
     * grant, a group perk's release, a staff or rule cut, a seed or game reward that granted VIP —
     * never the VIP reconciler putting a VIP back on the game, which only copies the row as it
     * stands. A VIP with no surviving setting is not reported rather than guessed at. `direction` names which
     * way it moved ("extended" | "shortened" | "made-permanent" | "given-an-expiry").
     * Read-only — the caller decides what, if anything, to hand to restoreVipExpirations.
     */
    vipsMovedByImport(serverId: string): Promise<Array<{
      playerId: string;
      playerName: string | null;
      currentExpiration: string | null;
      grantedExpiration: string | null;
      grantedAt: string;
      grantedBy: string;
      movedAt: string;
      direction: string;
    }>>;
    /** Give the named VIPs back the time their newest setting recorded — ONLY where that gives
     *  time back ("shortened", or permanent "given-an-expiry"). A longer row is never cut: VIP is
     *  paid for, and an extension that keeps its own record looks the same here as an import's.
     *  Only the ids passed are touched; returns what each became. */
    restoreVipExpirations(serverId: string, playerIds: string[]): Promise<Array<{ playerId: string; restoredTo: string | null }>>;
    /**
     * WIPE this server's game data — live and imported alike, with no cutoff and no provenance
     * test. The heavier sibling of resetImportedHistory, for when the stored history is not worth
     * telling apart from what a re-import would rebuild.
     *
     * Removed: every event, match and per-player match line, session, admin-camera visit, career
     * stat row, imported ban and VIP grant belonging to this server — then, for players left with
     * no presence on ANY server, their notes, tags, IP sightings, aliases, watch flag and watch
     * history. That orphan test is what makes the call safe to run on one server of several: a
     * player still active elsewhere keeps everything.
     *
     * NOT removed: the players themselves, and so their Discord links, group memberships and VIP
     * economy balances — identity and account linkage never came from CRCON and no CRCON backup
     * restores them. Nor any configuration: the connection, auto settings, map-vote profiles,
     * templates, staff accounts and the audit trail all survive.
     *
     * `keepUserHistory` is the final-delete variant: careers (player_stats) are not touched at
     * all, and of the events only the non-moderation kinds go — kicks, bans, punishes, admin
     * messages and camera watches stay on the record. Those are USER history — what happened to
     * a person, earned or done to them — not server plumbing, and the owner deleting a
     * connection must not rewrite anyone's past. The orphan scrub is skipped too (a kept career
     * row IS presence).
     *
     * One transaction: it happens completely or not at all.
     */
    purgeServerData(serverId: string, opts?: { keepUserHistory?: boolean }): Promise<{
      events: number; matches: number; matchStats: number; sessions: number; cameraSessions: number;
      careers: number; bans: number; vips: number;
      notes: number; tags: number; ips: number; aliases: number; watchlist: number;
    }>;
    /**
     * Remove EVERYTHING a CRCON import wrote to this server's history, so a clean archive can be
     * re-applied from zero: imported events (dedupe key `crcon:%`), pre-cutoff matches with their
     * per-player lines, pre-cutoff sessions and admin-camera visits — then recompute every career
     * counter that imported evidence fed (kills/deaths/teamkills from remaining events, visits
     * from remaining connects, playtime from remaining sessions). Score buckets, role clocks and
     * squad-lead time are untouched: they were only ever live-sampled, never imported as careers.
     *
     * Convergent by design: after this, re-applying an archive rebuilds exactly what it describes
     * through the normal counting paths (the deleted events re-insert, so their career bumps
     * re-count once). The live era is preserved — only records the import created are removed.
     */
    resetImportedHistory(serverId: string): Promise<{
      events: number; matches: number; matchStats: number; sessions: number; cameraSessions: number; playersRecounted: number;
    }>;
    /**
     * Everything an import left here, itemised — the destination half of a reconciliation.
     * Counted the same way the source will be so the two are directly comparable: only rows an
     * import could have created (`crcon:%` events), and only the imported era (before the cutoff)
     * for records the live tracker also writes.
     *
     * This is what turns "the import finished" into "the import is provably complete": compare
     * these against the same counts taken from CRCON's own database and every category must match
     * exactly, or the difference names itself.
     */
    importedBreakdown(serverId: string): Promise<{
      cutoff: string | null;
      /**
       * Events sourced from CRCON's game LOG, per kind — dedupe key `crcon:<log id>`.
       * Deliberately excludes `crcon:ra:%`: those come from a player profile's received_actions,
       * not from a log line, and land on the same kinds (kicked/banned/message). Counting them
       * here would make our side exceed the log every time and turn a correct import into a
       * failed reconciliation.
       */
      eventsByKind: Record<string, number>;
      /** Events derived from profile received_actions (`crcon:ra:%`), which have no log-line
       *  counterpart to be reconciled against. Reported so the total is still accounted for. */
      profileActionEvents: number;
      matches: number;
      matchStats: number;
      sessions: number;
    }>;
  };

  /**
   * Release whatever the store is holding open. A no-op in memory; `pool.end()` on Postgres.
   *
   * It exists for TESTS. A test process that builds a Postgres-backed repository keeps a live
   * connection pool, and a live pool keeps the event loop alive: the tests all pass, the runner
   * prints nothing more, and the process simply never exits — which reads exactly like a hang and
   * is what stopped the Postgres battery from ever finishing. Production shuts down by exiting.
   */
  close(): Promise<void>;
}

/**
 * The vote state of a server nothing has happened on yet.
 *
 * One definition, because there were three byte-identical copies — the worker's, the API's and the
 * store's — and a new column added to the row would have had to be remembered in all of them.
 */
export function blankMapVoteState(serverId: string): MapVoteStateRow {
  return {
    serverId, activeMessageId: null, activeChannelId: null, options: [], profile: null,
    openedAt: null, lastMatchEndAt: null, paused: false, pauseReason: null, savedOptions: [],
    pauseNoticeId: null, overrideMapId: null, recentMaps: [],
    tallies: [], talliedAt: null, lastClosedMessageId: null, lastClosedChannelId: null, skipNext: false, reroll: false,
    startNow: false, resyncNow: false, sendMessageLayout: null, liveAppliedMapId: null, liveApplyNote: null,
    ingameVoters: null, reopenAt: null, manualHoldUntil: null, lastOpenError: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Strip the secret before returning a server to any client. */
export function toPublicServer(s: ServerRow): ServerPublic {
  const { password: _password, formerNames: _formerNames, ...rest } = s;
  return rest;
}
