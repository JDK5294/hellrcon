// Setting the panel up as a walkthrough step shows it (lib/walkthroughs): the screen open, as
// someone holding just that walkthrough's permissions, with a menu opened or a field filled first
// where the step says so. Shared by the browser test that fails when a step's control is gone and
// by scripts/walkthrough-shots.mjs, which photographs the same thing — so the pictures and the
// test can never be about different screens.
import { bringWalkTargetIntoView, findWalkTarget, walkTargetBox } from "../lib/walkTarget.ts";
import { WALKTHROUGHS, onPhone } from "../lib/walkthroughs.ts";
import { ROUTES, canOpenRoute, minLevelFor, routeById } from "../lib/routes.ts";
import { HLL_DESCRIPTOR } from "./stage-answers.mjs";
import { SETUP_VERSION } from "../lib/gettingStarted.ts";
import { WHATS_NEW } from "../lib/whatsNew.ts";
import { CAPABILITY_CATALOG, LIMIT_CATALOG, ROLE_PRESETS } from "../../../packages/access/src/capabilities.ts";
import { SIGNABLE_ACTIONS, SIGNABLE_ACTION_LABELS } from "../../../packages/shared/src/signature.ts";

/** The finder, as text for the page to run (it is written to need nothing from its module). */
const FIND = findWalkTarget.toString();
/** How the spotlight scrolls to a control and what of it the ring goes round, as text the same way. */
const BRING = bringWalkTargetIntoView.toString();
const BOX = walkTargetBox.toString();

/** The two screens each step is shown on: a common laptop's window, and a phone's (the panel lays
 *  itself out for a phone below 860 pixels: the menu behind ☰, Search in the bar along the top). */
export const PC_SCREEN = { viewport: { width: 1280, height: 800 } };
export const PHONE_SCREEN = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** A server's game rewards as the API starts them (packages/db GAME_REWARDS_DEFAULTS), with the
 *  reward for playing a whole match switched on. */
const pts = (points) => ({ vipHours: 0, points });
const GAME_REWARDS = {
  order: ["matchEnd", "topStats", "bestSquads", "killStreaks", "playDays", "seedDays"],
  matchEnd: { enabled: true, dryRun: false, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 0, reward: { vipHours: 24, points: 0 }, message: "Thank you {player_name} for playing on {server_name}! You earned {reward}." },
  topStats: {
    enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, broadcast: true, showEveryone: true, message: "Top {category} this match — #{rank} with {value}! You earned {reward}.",
    categories: ["kills", "kd", "kpm", "combat", "offense", "defense", "support", "teamplay", "commander", "vehicles"].map((id) => ({ id, enabled: id === "kills", ranks: [pts(100), pts(50), pts(25)] })),
  },
  bestSquads: {
    enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, minMembers: 2, metric: "score", scoring: "total", broadcast: true, showEveryone: true, message: "Best {squad_type} squad this match — #{rank}! You earned {reward}.",
    types: ["infantry", "armor", "recon", "artillery", "mortar", "helicopter"].map((id) => ({ id, enabled: id === "infantry", ranks: [pts(50)] })),
  },
  killStreaks: { enabled: false, dryRun: true, minPlayers: 20, message: "{streak} kills without dying — nice! You earned {reward}.", tiers: [{ kills: 10, reward: pts(25) }, { kills: 20, reward: pts(75) }] },
  playDays: { enabled: false, dryRun: true, minMinutes: 30, message: "{days} days in a row — thanks for playing! You earned {reward}.", tiers: [{ days: 3, reward: pts(50) }, { days: 7, reward: pts(150) }], repeatEveryDays: 7 },
  seedDays: { enabled: false, dryRun: true, message: "{days} days of seeding in a row — legend! You earned {reward}.", tiers: [{ days: 3, reward: pts(100) }], repeatEveryDays: 7 },
};

/** A month of analytics, to the day the stage's other records end: each day's date, oldest first. */
const ANALYTICS_WINDOW = { from: "2026-09-25T00:00:00.000Z", to: "2026-10-25T00:00:00.000Z" };
const DAYS = Array.from({ length: 30 }, (_, i) => new Date(Date.parse(ANALYTICS_WINDOW.to) - (30 - i) * 864e5).toISOString().slice(0, 10));
/** A week of hours, Monday first, busiest in the evening: the grid every analytics heat map reads,
 *  and the same summed by hour. */
const WEEK_HOURS = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (h >= 18 ? 20 + d * 2 + (h - 18) * 3 : h >= 12 ? 6 : 1)));
const DAY_HOURS = WEEK_HOURS[0].map((_, h) => WEEK_HOURS.reduce((n, day) => n + day[h], 0));
const scaled = (grid, by) => grid.map((day) => day.map((n) => Math.round(n / by)));
/** A request line as the API sends it, waiting on a decision. */
const reqLine = (over) => ({
  seq: 1, serverId: "s1", payload: {}, state: "pending", decidedByName: null, decidedAt: null, denyReason: null, modified: null,
  appliedAt: null, applyError: null, canSign: true, signRefusal: null, ...over,
});
/** A rule as the API sends it: punish after three team kills in five minutes, on every server. */
const rule = (over) => ({
  serverId: null, sectionId: null, enabled: true, eventKind: "evt.teamkill", match: null, threshold: 3, windowSec: 300, action: "punish",
  reason: "Three team kills in five minutes", hours: null, delaySec: 0, vipMinutes: 0, vipCooldownMinutes: 0, requireRoleIds: [], ...over,
});
const VOTE_POOL = { dayCount: 3, nightCount: 1, wildcardCount: 3, excludePlayedMaps: 4, blacklistMaps: [] };
const VOTE_OPTIONS = [{ id: "foy_warfare_night", name: "Foy (Night)", votes: 14 }, { id: "carentan_warfare", name: "Carentan", votes: 9 }, { id: "kharkov_warfare", name: "Kharkov", votes: 5 }];
/** What the game log says, over and over: a kill, team chat, someone joining, another kill. */
const GAME_LOG = [
  { kind: "evt.kill", serverId: "s1", actorName: "CPL Crunch", actorPlayerId: "p2", victimName: "Caereca", victimPlayerId: "p1", weapon: "M1 GARAND", data: { actorSide: "allies" } },
  { kind: "evt.chat", serverId: "s1", actorName: "Caereca", actorPlayerId: "p1", data: { message: "push the middle point", channel: "team", actorSide: "axis" } },
  { kind: "evt.connect", serverId: "s1", actorName: "Quillon", actorPlayerId: "p3" },
  { kind: "evt.kill", serverId: "s1", actorName: "Clutch", actorPlayerId: "p3", victimName: "Caereca", victimPlayerId: "p1", weapon: "KARABINER 98K", data: { actorSide: "axis" } },
];
/** A small badge for the live match board: a shield, drawn as the picture the API would send. */
const BADGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 4 56 12v18c0 15-10 26-24 30C18 56 8 45 8 30V12z" fill="#4f7cff"/><path d="M22 32l7 7 13-14" stroke="#fff" stroke-width="5" fill="none"/></svg>';

/** The staff trail: a kick, a VIP given, and an auto settings save. */
const TRAIL = [
  { id: "au1", ts: "2026-10-24T20:16:00.000Z", actorUserId: "u1", actorName: "Sam", action: "player.kick", targetType: "player", targetId: "p2", targetName: "Kestrel", serverId: "s1", summary: "Kicked Kestrel: Teamkilling at spawn" },
  { id: "au2", ts: "2026-10-24T19:40:00.000Z", actorUserId: "u2", actorName: "Alex", action: "vip.grant", targetType: "player", targetId: "p9", targetName: "Marlow", serverId: "s1", summary: "Gave Marlow VIP until 24 November" },
  { id: "au3", ts: "2026-10-24T18:05:00.000Z", actorUserId: "u1", actorName: "Sam", action: "autosettings.config", targetType: "server", targetId: "s1", targetName: "Server #1", serverId: "s1", summary: "updated auto settings for Server #1 — 2 profile(s)" },
];
/** Each of those opened from its row (GET /api/audit/:id): what it changed, and what else it keeps. */
const TRAIL_DETAILS = {
  au1: { changes: null, details: [{ label: "Player id", value: "76562" }, { label: "Reason", value: "Teamkilling at spawn" }] },
  au2: { changes: null, details: [{ label: "Player id", value: "76569" }, { label: "Expiration", value: "2026-11-24T19:40:00.000Z" }, { label: "Comment", value: "Monthly supporter" }] },
  au3: {
    changes: { basis: "recorded", items: [
      { where: ["Dry run"], before: "on", after: "off" },
      { where: ["Profile “Night”", "When", "Total players are below"], before: "40", after: "50" },
      { where: ["Profile “Night”", "Auto-balance"], before: "on", after: "off" },
      { where: ["Profile “Day”", "Vote kick"], before: null, after: "off" },
    ] },
    details: [],
  },
};

/**
 * What the screens show in a walkthrough's pictures and its test: the stub's own data, plus a
 * server that can be acted on and a ban to lift — the empty versions would leave nothing to ring.
 */
export const WALK_FIXTURES = {
  // Two servers, the second in observe mode, and a third retired: only Connections asks for those.
  "/api/servers": (url) => ({ body: { servers: [
    { id: "s1", no: 1, name: "Server #1", game: "hll", engagementMode: "active", host: "203.0.113.10", port: 7779, protocol: "binary-v2", lastContactAt: "2026-10-24T20:59:00.000Z" },
    { id: "s2", no: 2, name: "Server #2", game: "hll", engagementMode: "observe", host: "203.0.113.20", port: 7779, protocol: "binary-v2", lastContactAt: "2026-10-24T20:59:00.000Z" },
    ...(url.searchParams.get("includeRetired") ? [{ id: "s3", no: 3, name: "Server #3", game: "hll", engagementMode: "active", host: "203.0.113.30", port: 7779, protocol: "binary-v2", retiredAt: "2026-09-01T18:00:00.000Z", decommissionedAt: null }] : []),
  ] } }),
  // The watchlist: one watched player, who is not online — read by the Watched tab, and by the
  // dashboard's reachability check (unanswered, it warns the panel is down).
  "/api/players/flagged": { body: { flags: [
    { playerId: "p2", name: "Kestrel", watchlist: true, vip: false, online: false, onlineServers: [], updatedByName: "Sam", updatedAt: "2026-10-22T19:00:00.000Z",
      watchReason: "Teamkilling at spawn, three nights running", watchBy: "Sam", watchAt: "2026-10-22T19:00:00.000Z",
      reasons: [{ id: "w1", reason: "Teamkilling at spawn, three nights running", addedBy: "Sam", addedAt: "2026-10-22T19:00:00.000Z", expiresAt: null }] },
  ] } },
  // The directory: an ordinary player first (whose profile the stub already has), then the watched one.
  "/api/players": { body: { players: [
    { id: "p1", name: "Caereca", platform: "steam", platformId: "76561", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-10-24T20:00:00.000Z", game: "hll", level: 87, kills: 217, deaths: 263, teamkills: 1, visits: 42, playtimeSec: 34200, watchlist: false, vip: true },
    { id: "p2", name: "Kestrel", platform: "steam", platformId: "76562", firstSeen: "2026-03-01T00:00:00.000Z", lastSeen: "2026-10-23T21:00:00.000Z", game: "hll", level: 41, kills: 96, deaths: 140, teamkills: 9, visits: 18, playtimeSec: 12600, watchlist: true, vip: false },
    { id: "p3", name: "Quillon", platform: "epic", platformId: "a1b2c3", firstSeen: "2026-05-01T00:00:00.000Z", lastSeen: "2026-10-20T18:00:00.000Z", game: "hll", level: 23, kills: 31, deaths: 58, teamkills: 0, visits: 6, playtimeSec: 5400, watchlist: false, vip: false },
  ], total: 3 } },
  "/api/players/p2": { body: {
    player: { id: "p2", name: "Kestrel", platform: "steam", platformId: "76562", firstSeen: "2026-03-01T00:00:00.000Z", lastSeen: "2026-10-23T21:00:00.000Z" },
    stats: { kills: 96, deaths: 140, teamkills: 9 },
    flags: { watchlist: true, vip: false, updatedByName: "Sam", updatedAt: "2026-10-22T19:00:00.000Z", watchReason: "Teamkilling at spawn, three nights running", watchBy: "Sam", watchAt: "2026-10-22T19:00:00.000Z" },
    canViewNotes: true, notes: [], statsByServer: [], sessions: [], recentEvents: [],
  } },
  // Caereca's profile: flagged, linked to Discord, with VIP on Server #1 paused for two more days —
  // a pause runs against the clock of whoever reads it, so its end is two days from the reading.
  "/api/players/p1": () => ({ body: {
    player: { id: "p1", name: "Caereca", platform: "steam", platformId: "76561", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-10-24T20:00:00.000Z" },
    stats: { kills: 217, deaths: 263, teamkills: 1 },
    flags: { watchlist: false, vip: true, updatedByName: null },
    canViewNotes: true, notes: [],
    statsByServer: [
      { serverId: "s1", serverName: "Server #1", kills: 171, deaths: 205, playtimeSec: 26_400, matchesPlayed: 12, matchesWon: 7, slSeconds: 5_400, visits: 33 },
      { serverId: "s2", serverName: "Server #2", kills: 46, deaths: 58, playtimeSec: 7_800, matchesPlayed: 3, matchesWon: 1, slSeconds: 1_800, visits: 9 },
    ],
    sessions: [],
    recentEvents: [
      { ts: "2026-10-24T20:19:00.000Z", kind: "evt.kill", serverId: "s1", actorName: "Kestrel", actorPlayerId: "p2", victimName: "Caereca", victimPlayerId: "p1", weapon: "M1 GARAND", data: { actorSide: "allies" } },
      { ts: "2026-10-24T20:18:00.000Z", kind: "evt.chat", serverId: "s1", actorName: "Caereca", actorPlayerId: "p1", data: { message: "push the middle point", channel: "team", actorSide: "axis" } },
    ],
    links: [{ provider: "discord", externalId: "222" }],
    tags: [{ id: "tg1", label: "Streams the server", note: "Twitch: caereca_live", createdByName: "Sam", createdAt: "2026-10-22T19:05:00.000Z" }],
    vipStatus: [{ serverId: "s1", serverName: "Server #1", expiration: "2026-11-02T18:00:00.000Z", pausedUntil: new Date(Date.now() + 2 * 864e5).toISOString(), pauseReason: "Teamkilling at spawn", pausedBy: "Sam", pauseMode: "running" }],
  } }),
  "/api/players/p2/watch": { body: { reasons: [
    { id: "w1", reason: "Teamkilling at spawn, three nights running", addedBy: "Sam", addedAt: "2026-10-22T19:00:00.000Z", expiresAt: null, removedBy: null, removedAt: null, own: false, edits: [] },
  ] } },
  "/api/players/p1/ips": { body: { ips: [
    { ip: "203.0.113.24", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-10-24T20:00:00.000Z", seenCount: 38, sharedWith: [] },
    { ip: "198.51.100.7", firstSeen: "2026-06-11T00:00:00.000Z", lastSeen: "2026-08-02T20:00:00.000Z", seenCount: 4, sharedWith: [{ playerId: "p3", name: "Quillon" }] },
  ] } },
  "/api/clans": { body: { clans: [
    { key: "abc", label: "[ABC]", customised: false, now: 4, ever: 11, lastSeen: "2026-10-24T20:00:00.000Z",
      spellings: [{ tag: "[ABC]", ever: 9, now: 3, lastSeen: "2026-10-24T20:00:00.000Z" }, { tag: "ᴀʙᴄ", ever: 2, now: 1, lastSeen: "2026-10-23T20:00:00.000Z" }] },
    { key: "abcx", label: "ABC|", customised: false, now: 1, ever: 3, lastSeen: "2026-10-21T20:00:00.000Z", spellings: [{ tag: "ABC|", ever: 3, now: 1, lastSeen: "2026-10-21T20:00:00.000Z" }] },
    { key: "xyz", label: "XYZ", customised: false, now: 2, ever: 7, lastSeen: "2026-10-24T19:00:00.000Z", spellings: [{ tag: "XYZ", ever: 7, now: 2, lastSeen: "2026-10-24T19:00:00.000Z" }] },
  ], total: 3, focus: null, canEdit: true } },
  "/api/player-groups": { body: { groups: [
    { id: "g1", name: "Clan match roster", description: "Saturday's match", memberCount: 2, createdByName: "Sam", vipPerk: null, discordRoleId: null },
    { id: "g2", name: "Clan members", description: "Everyone in [ABC]", memberCount: 1, createdByName: "Alex",
      vipPerk: { game: "hll", scope: { mode: "all" }, severanceMinutes: 1_440, bankRewards: true }, discordRoleId: "900000000000000010" },
  ] } },
  "/api/player-groups/g2": { body: {
    members: [{ groupId: "g2", playerId: "76561", playerName: "Caereca", addedByName: "Discord role sync", addedAt: "2026-10-01T18:00:00.000Z", source: "discord" }],
    perkStatus: { heldPlayers: 1, heldGrants: 1, held: [{ serverId: "s1", playerId: "76561", bankedMs: 0, since: "2026-10-01T18:00:00.000Z" }], notes: null, checkedAt: "2026-10-24T20:00:00.000Z" },
    discordRole: { id: "900000000000000010", name: "ABC member", problem: null },
  } },
  "/api/player-groups/g1": { body: { members: [
    { groupId: "g1", playerId: "76561", playerName: "Caereca", addedByName: "Sam", addedAt: "2026-10-20T18:00:00.000Z" },
    { groupId: "g1", playerId: "a1b2c3", playerName: "Quillon", addedByName: "Sam", addedAt: "2026-10-20T18:00:00.000Z" },
  ], perkStatus: null } },
  "/api/bans": { body: { bans: [
    { id: "b1", ts: "2026-10-24T20:15:00.000Z", by: "Sam", playerName: "Kestrel", playerId: "76561190000000001", platform: "steam",
      type: "temp", reason: "Teamkilling at spawn", category: "teamkilling", scope: { mode: "all" }, game: "hll",
      expiresAt: "2026-10-26T20:15:00.000Z", liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"] },
    { id: "b2", ts: "2026-10-20T18:02:00.000Z", by: "Alex", playerName: "Quillon", playerId: "76561190000000002", platform: "steam",
      type: "perma", reason: "Cheating", category: "cheating", scope: { mode: "all" }, game: "hll",
      expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"] },
  ] } },
  "/api/servers/s1/vips": { body: { vips: [
    { id: "v1", serverId: "s1", playerId: "76561190000000003", playerName: "Marlow", comment: "Paid: one month", expiration: "2026-11-24T00:00:00.000Z",
      pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null, groupHold: null, perkGroups: [],
      createdByName: "Sam", createdAt: "2026-10-24T20:15:00.000Z", updatedAt: "2026-10-24T20:15:00.000Z" },
    { id: "v2", serverId: "s1", playerId: "76561190000000004", playerName: "Juniper", comment: "Event winner", expiration: null,
      pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null, groupHold: null, perkGroups: [],
      createdByName: "Alex", createdAt: "2026-09-02T18:00:00.000Z", updatedAt: "2026-09-02T18:00:00.000Z" },
  ] } },
  "/api/vip-presets": { body: { presets: [
    { id: "p1", kind: "add", label: "1 week", days: 7, hours: 0, sortOrder: 0 },
    { id: "p2", kind: "add", label: "1 month", days: 30, hours: 0, sortOrder: 1 },
    { id: "p3", kind: "pause", label: "1 day", days: 1, hours: 0, sortOrder: 0 },
  ] } },
  "/api/economy/members": { body: { members: [
    { discordId: "111", discordName: "Alice", balance: 1250, updatedAt: "2026-10-24T20:15:00.000Z" },
    { discordId: "222", discordName: "Bob", balance: 430, updatedAt: "2026-10-23T18:00:00.000Z" },
  ], total: 2 } },
  "/api/payout-events": { body: { items: [
    { id: "ev1", name: "Friday night event", serverId: "s1", serverName: "Server #1", status: "scheduled",
      openMode: "at", openAnchor: "2026-10-30T19:00:00.000Z", openedAt: null, closeMode: "at", closeAnchor: "2026-10-30T22:00:00.000Z", closedAt: null,
      minMinutes: 60, mapVoteProfile: null, rotationSetId: null, roster: null, createdBy: "Sam", createdAt: "2026-10-24T20:15:00.000Z", payment: null },
    { id: "ev2", name: "Seeding drive", serverId: "s1", serverName: "Server #1", status: "closed",
      openMode: "at", openAnchor: "2026-10-18T14:00:00.000Z", openedAt: "2026-10-18T14:00:00.000Z", closeMode: "at", closeAnchor: "2026-10-18T17:00:00.000Z", closedAt: "2026-10-18T17:00:00.000Z",
      minMinutes: 30, mapVoteProfile: null, rotationSetId: null, roster: [], createdBy: "Alex", createdAt: "2026-10-12T20:15:00.000Z", payment: { state: "paid", unpaid: 0, at: "2026-10-18T18:00:00.000Z" } },
    { id: "ev3", name: "Clan match night", serverId: "s1", serverName: "Server #1", status: "closed",
      openMode: "at", openAnchor: "2026-10-24T19:00:00.000Z", openedAt: "2026-10-24T19:00:00.000Z", closeMode: "at", closeAnchor: "2026-10-24T22:00:00.000Z", closedAt: "2026-10-24T22:00:00.000Z",
      minMinutes: 60, mapVoteProfile: null, rotationSetId: null, roster: null, createdBy: "Sam", createdAt: "2026-10-20T20:15:00.000Z", payment: null },
    { id: "ev4", name: "Training session", serverId: "s1", serverName: "Server #1", status: "closed",
      openMode: "at", openAnchor: "2026-10-21T18:00:00.000Z", openedAt: "2026-10-21T18:00:00.000Z", closeMode: "at", closeAnchor: "2026-10-21T19:00:00.000Z", closedAt: "2026-10-21T19:00:00.000Z",
      minMinutes: 30, mapVoteProfile: null, rotationSetId: null, roster: null, createdBy: "Alex", createdAt: "2026-10-19T20:15:00.000Z", payment: null,
      noPayoutAt: "2026-10-21T19:30:00.000Z", noPayoutBy: "Alex" },
  ], total: 4 } },
  // The game's own settings, for Live settings to show, and its squad types, for Best squads per
  // match to rank: as the real descriptor has them (packages/games/src/hll.ts).
  "/api/games/hll/descriptor": { body: { descriptor: { ...HLL_DESCRIPTOR, squadTypes: { infantry: [0, 1, 2, 3, 5, 6, 7, 8, 9], recon: [4, 10], armor: [11, 12], artillery: [14, 15, 16] }, configFields: [
    { field: "autoBalanceEnabled", label: "Auto-balance", kind: "bool", read: { command: "getAutoBalanceEnabled", key: "enable" }, write: { command: "setAutoBalanceEnabled", param: "enabled" } },
    { field: "autoBalanceThreshold", label: "Auto-balance threshold", kind: "num", read: { command: "getAutoBalanceThreshold", key: "autoBalanceThreshold" }, write: { command: "setAutoBalanceThreshold", param: "threshold" } },
    { field: "highPing", label: "High-ping kick (ms)", kind: "num", read: { command: "getHighPing", key: "highPingThresholdMs" }, write: { command: "setHighPing", param: "ms" } },
    { field: "idleKick", label: "Idle kick (minutes)", kind: "num", read: { command: "getIdleKickTime", key: "idleTimeoutMinutes" }, write: { command: "setKickIdleTime", param: "minutes" } },
    { field: "teamSwitchCooldown", label: "Team-switch cooldown (minutes)", kind: "num", read: { command: "getTeamSwitchCooldown", key: "teamSwitchTimer" }, write: { command: "setTeamSwitchCooldown", param: "minutes" } },
    { field: "voteKickEnabled", label: "Vote kick", kind: "bool", read: { command: "getVoteKickEnabled", key: "enable" }, write: { command: "setVoteKickEnabled", param: "enabled" } },
    { field: "maxQueuedPlayers", label: "Max queued players", kind: "num", write: { command: "setMaxQueuedPlayers", param: "count" } },
    { field: "numVipSlots", label: "VIP slots", kind: "num", write: { command: "setNumVipSlots", param: "count" } },
    { field: "welcomeMessage", label: "Welcome message", kind: "str", write: { command: "setWelcomeMessage", param: "message" } },
    { field: "mapShuffle", label: "Map shuffle", kind: "bool", read: { command: "getMapShuffleEnabled", key: "enable" }, write: { command: "setMapShuffleEnabled", param: "enabled" } },
  ] } } },
  "/api/servers/s1/config": { body: { config: { autoBalanceEnabled: true, autoBalanceThreshold: 3, highPing: 400, idleKick: 15, voteKickEnabled: false }, managed: null } },
  "/api/servers/s1/matches": { body: { matches: [
    { id: "m1", map: "Foy Warfare", startedAt: "2026-10-24T19:00:00.000Z", endedAt: "2026-10-24T20:28:00.000Z", durationSec: 5280, result: "ALLIED (5 - 0)", score: "5 - 0" },
    { id: "m2", map: "Carentan Warfare", startedAt: "2026-10-24T17:20:00.000Z", endedAt: "2026-10-24T18:51:00.000Z", durationSec: 5460, result: "AXIS (2 - 3)", score: "2 - 3" },
  ], total: 2 } },
  // The game log: a month of it, so it comes a page at a time — the latest page first.
  "/api/servers/s1/events": { body: { events: Array.from({ length: 25 }, (_, i) => ({ ...GAME_LOG[i % GAME_LOG.length], ts: new Date(Date.parse("2026-10-24T20:19:00.000Z") - i * 97_000).toISOString() })), total: 1_240 } },
  "/api/servers/s1/admins": { body: { serverId: "s1", count: 2, groups: ["owner", "senior", "junior", "spectator"], admins: [
    { id: "a1", serverId: "s1", playerId: "76561", playerName: "Caereca", adminGroup: "senior", comment: "Moderator", expiration: null, createdByName: "Sam", createdAt: "2026-09-02T18:00:00.000Z", updatedAt: "2026-09-02T18:00:00.000Z" },
    { id: "a2", serverId: "s1", playerId: "a1b2c3", playerName: "Quillon", adminGroup: "spectator", comment: "Streamer camera", expiration: "2026-12-01T00:00:00.000Z", createdByName: "Alex", createdAt: "2026-10-12T18:00:00.000Z", updatedAt: "2026-10-12T18:00:00.000Z" },
  ] } },
  // Seeding: on, with its reward, for the Seeding tab to show.
  "/api/servers/s1/seeding": { body: {
    config: {
      enabled: true, dryRun: false, seedTarget: 50, minPlayers: 5,
      disallowedRoles: [], disallowedWeaponClasses: [], disallowedWeapons: [], disallowedWeaponNames: [], disallowedCommanderAbilities: [],
      capFightEnabled: true, capFightMaxCaps: 3, capFightSkipWarning: false, capFightNotice: "",
      containEnabled: false, containGraceSec: 60, containMaxPlayers: 60, containNotice: "", containZones: {},
      paceEnabled: false, paceUnlockMinutes: [0, 0, 20, 40, 60], paceNotice: "",
      immuneLevel: 0, immuneTags: [], announceMessage: "Seeding until {seed_count} players: no tanks or artillery.", maxWarnings: 2, warnIntervalSec: 60,
      warnMessage: "Seeding rules are on: please stay off the tanks.", maxPunishes: 2, punishIntervalSec: 60, punishMessage: "Seeding rules: no tanks.",
      kickAfter: true, kickMessage: "Kicked for breaking seeding rules.",
      rewardEnabled: true, rewardHours: 24, rewardPoints: 50, rewardLinkedNote: "", rewardUnlinkedNote: "",
      minSeedMinutes: 15, rewardCumulative: true, rewardMessage: "Thanks for seeding! {vip_until}", rewardDelaySec: 0, phaseConfirmSec: 0, phaseHysteresis: 0,
    },
    // A map to paint the ground rules on, as Map zones shows them.
    roles: {}, commanderAbilities: [], containMaps: [{ key: "carentan", label: "Carentan" }], announcePreview: "", configured: true,
    // Two of the game's weapon families, and the guns in each.
    weaponClasses: [{ id: "artillery", label: "Artillery" }, { id: "armor", label: "Armor" }],
    weapons: [{ name: "155MM HOWITZER [M114]", classId: "artillery" }, { name: "75MM CANNON [Sherman M4A3(75mm)]", classId: "armor" }, { name: "COAXIAL M1919 [Sherman M4A3(75mm)]", classId: "armor" }],
    // Carentan's attack learned from the rounds played on it.
    learnedLayouts: { "@carentan_warfare": { status: "learned", axis: "x", alliesDir: 1, rounds: 6, agree: 5, prefill: { allies: ["A1", "A2", "B1", "B2"], axis: ["I1", "I2", "J1", "J2"], shared: [] }, autoZone: false } },
  } },
  "/api/servers/s1/seeding/payouts": { body: { rounds: [] } },
  // The objectives on the map in play, and the staff command's settings: what the walkthroughs for
  // choosing objectives and for working from Discord show.
  "/api/servers/s1/maps/objectives": { body: {
    rows: [["Blactot", "502nd Start", "Farm Ruins"], ["Pumping Station", "Ruins", "Derailed Train"], ["Canal Crossing", "Town Center", "Train Station"],
      ["Customs", "Rail Crossing", "Mont Halais"], ["Canal Locks", "Rail Causeway", "La Maison Des Ormes"]],
    mapKey: "carentan", points: [], mapId: "carentan_warfare", saved: null, savedPlays: null,
  } },
  "/api/discord/commands": { body: { config: { name: "staff", description: "Open the staff panel", enabled: true }, canRegister: true, guildId: "900000000000000001", canCheckRoles: true, mappedRoles: 2 } },
  "/api/servers/s1/discord": { body: {
    categories: ["kills", "chat", "admin", "connections", "match"], botConfigured: true,
    config: {
      serverId: "s1", enabled: true, categories: ["admin", "match"], updatedAt: "2026-10-20T18:00:00.000Z",
      channels: { kills: null, chat: null, admin: "500000000000000001", connections: null, match: "500000000000000002" }, categoryOptions: {},
      alerts: {
        adminPing: { enabled: false, channelId: null, mentionRoleId: null, trigger: "!admin" },
        watchlist: { enabled: false, channelId: null, mentionRoleId: null },
        automation: { enabled: false, channelId: null, mentionRoleId: null },
        serverDark: { enabled: false, channelId: null, mentionRoleId: null },
      },
      statusBoard: { enabled: false, channelId: null, messageId: null, intervalSec: 60, title: null },
    },
  } },
  "/api/templates": { body: { kinds: ["reason", "message", "broadcast"], templates: [
    { id: "t1", kind: "reason", title: "Teamkilling", body: "Teamkilling at spawn", sortOrder: 0 },
    { id: "t2", kind: "message", title: "Stay with your squad", body: "Please stay with your squad.", sortOrder: 0 },
  ] } },
  // The staff trail, and one request's decision, for Staff activity and Requests to show.
  "/api/audit": { body: { entries: TRAIL, total: 3 } },
  ...Object.fromEntries(TRAIL.map((e) => [`/api/audit/${e.id}`, { body: { entry: e, ...TRAIL_DETAILS[e.id] } }])),
  "/api/requests/history": { body: { limit: 50, decisions: [
    { requestId: "r1", lineId: "l1", requesterName: "Jordan", filedAt: "2026-10-24T20:01:00.000Z", requestStatus: "closed", kind: "kick", serverId: "s1", serverName: "Server #1",
      playerId: "76562", playerName: "Kestrel", state: "approved", decidedByName: "Sam", decidedAt: "2026-10-24T20:03:00.000Z", denyReason: null, applyError: null, modified: null, payload: { reason: "Teamkilling at spawn" } },
  ] } },
  "/api/chat-filter": { body: { config: {
    enabled: true, words: ["slur one", "slur two"], action: "kick", hours: null, reason: "Kicked for language in chat.",
    censor: false, censorApplied: {}, teamRuleId: null, unitRuleId: null,
  } } },
  // The leaderboard, a clan's players, a player's trigger, and visits to the admin camera.
  "/api/leaderboard": { body: { leaderboard: [
    { playerId: "p1", name: "Caereca", kills: 217, deaths: 263, teamkills: 1, kd: 0.83, combat: 15420, offense: 3200, defense: 4100, support: 2600, slSeconds: 7200, playtime: 34200 },
    { playerId: "p2", name: "Kestrel", kills: 96, deaths: 140, teamkills: 9, kd: 0.69, combat: 7300, offense: 1500, defense: 2100, support: 900, slSeconds: 1800, playtime: 12600 },
    { playerId: "p3", name: "Quillon", kills: 31, deaths: 58, teamkills: 0, kd: 0.53, combat: 2400, offense: 600, defense: 800, support: 1200, slSeconds: 0, playtime: 5400 },
  ], total: 3 } },
  "/api/clans/members": { body: { members: [
    { playerId: "p1", name: "Caereca", game: "hll", platform: "steam", platformId: "76561", lastSeen: "2026-10-24T20:00:00.000Z", tag: "[ABC]", firstSeen: "2026-02-01T00:00:00.000Z", tagLastSeen: "2026-10-24T20:00:00.000Z", wearingNow: true, currentTag: "[ABC]" },
    { playerId: "p3", name: "Quillon", game: "hll", platform: "epic", platformId: "a1b2c3", lastSeen: "2026-10-20T18:00:00.000Z", tag: "ᴀʙᴄ", firstSeen: "2026-05-01T00:00:00.000Z", tagLastSeen: "2026-09-12T18:00:00.000Z", wearingNow: false, currentTag: null },
  ], total: 2 } },
  "/api/player-triggers": { body: { triggers: [
    { id: "tr1", playerId: "p2", playerName: "Kestrel", event: "connect", steps: [{ action: "message", message: "Welcome back. Please stay with your squad.", hours: 0, points: 0, delaySec: 30 }], fireOnce: true, enabled: true,
      note: "Talked to him about team killing", serverId: "s1", serverName: "Server #1", createdByName: "Sam", createdAt: "2026-10-23T19:00:00.000Z", firedCount: 0, lastFiredAt: null, disarmedAt: null, summary: "When they connect: message them" },
  ] } },
  // One player's triggers, opened in the builder: what it may do, as for someone allowed it all.
  "/api/players/p2/triggers": { body: { triggers: [], allowedActions: ["message", "kick", "punish", "tempban", "permaban", "vip", "vipremove", "points", "takepoints", "switch", "watch"], game: "hll" } },
  "/api/admincam/history": { body: { sessions: [
    { id: "c1", serverId: "s1", serverName: "Server #1", playerId: "76561", playerName: "Sam", enteredAt: "2026-10-24T20:05:00.000Z", exitedAt: "2026-10-24T20:11:00.000Z", durationSec: 360 },
    { id: "c2", serverId: "s1", serverName: "Server #1", playerId: "76563", playerName: "Alex", enteredAt: "2026-10-24T18:40:00.000Z", exitedAt: "2026-10-24T18:42:00.000Z", durationSec: 120 },
  ], total: 2, admins: [{ playerId: "76561", playerName: "Sam" }, { playerId: "76563", playerName: "Alex" }], servers: [{ id: "s1", name: "Server #1" }] } },
  // A round with its scoreboard, for a round's page.
  // A staff member's page: what they did, by kind and over time, and to whom.
  "/api/audit/staff/u2": { body: {
    user: { id: "u2", username: "yeti", createdAt: "2026-02-01T00:00:00.000Z" }, actorName: "yeti",
    analytics: {
      total: 14, firstAt: "2026-10-01T18:00:00.000Z", lastAt: "2026-10-24T21:00:00.000Z",
      byAction: { "player.kick": 6, "player.message": 5, "vip.grant": 3 },
      byCategory: { bans: 0, kicks: 6, vips: 3, messages: 5, moves: 0, punishments: 0, requests: 0, other: 0 },
      topTargets: [{ id: "p2", name: "Kestrel", count: 4 }, { id: "p1", name: "Caereca", count: 2 }],
      topServers: [{ serverId: "s1", count: 14, name: "Server #1" }],
      daily: [
        { date: "2026-10-22", total: 5, byCategory: { bans: 0, kicks: 3, vips: 0, messages: 2, moves: 0, punishments: 0, requests: 0, other: 0 } },
        { date: "2026-10-23", total: 4, byCategory: { bans: 0, kicks: 1, vips: 2, messages: 1, moves: 0, punishments: 0, requests: 0, other: 0 } },
        { date: "2026-10-24", total: 5, byCategory: { bans: 0, kicks: 2, vips: 1, messages: 2, moves: 0, punishments: 0, requests: 0, other: 0 } },
      ],
    },
  } },
  "/api/matches/m1": { body: {
    match: { id: "m1", serverId: "s1", serverName: "Server #1", map: "Foy Warfare", startedAt: "2026-10-24T19:00:00.000Z", endedAt: "2026-10-24T20:28:00.000Z",
      winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)", sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null },
    stats: [
      { matchId: "m1", playerId: "p1", playerName: "Caereca", side: "allies", kills: 34, deaths: 12, teamkills: 0, combat: 1520, offense: 380, defense: 640, support: 220 },
      { matchId: "m1", playerId: "p4", playerName: "Marlow", side: "allies", kills: 21, deaths: 15, teamkills: 1, combat: 980, offense: 260, defense: 300, support: 520 },
      { matchId: "m1", playerId: "p2", playerName: "Kestrel", side: "axis", kills: 18, deaths: 24, teamkills: 3, combat: 820, offense: 140, defense: 420, support: 160 },
      { matchId: "m1", playerId: "p3", playerName: "Quillon", side: "axis", kills: 9, deaths: 20, teamkills: 0, combat: 410, offense: 90, defense: 260, support: 380 },
    ],
  } },
  // The shop's offers, an event's report, and the map votes so far.
  "/api/economy/config": { body: { config: {
    currencyName: "Points", balanceCap: null,
    claims: { daily: { enabled: true, min: 15, max: 25, roleIds: [] }, monthly: { enabled: false, min: 475, max: 525, roleIds: [] } },
    gifting: { enabled: false, minAmount: 1, maxAmount: null }, vipGifting: { enabled: false, roleIds: [] },
    offers: [
      { id: "o1", label: "One week of VIP", points: 300, days: 7, scope: { mode: "all" }, enabled: true, roleIds: [] },
      { id: "o2", label: "Two weeks of VIP", points: 550, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [] },
    ],
    registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, bonusPerGame: false, gameRoles: {}, serverIds: [] }, updatedAt: "2026-10-20T00:00:00.000Z",
  } } },
  "/api/payout-events/ev2/report": { body: {
    event: { id: "ev2", name: "Seeding drive", serverId: "s1", serverName: "Server #1", status: "closed", openMode: "at", openAnchor: "2026-10-18T14:00:00.000Z", openedAt: "2026-10-18T14:00:00.000Z",
      closeMode: "at", closeAnchor: "2026-10-18T17:00:00.000Z", closedAt: "2026-10-18T17:00:00.000Z", minMinutes: 30, mapVoteProfile: null, rotationSetId: null, roster: [], createdBy: "Alex", createdAt: "2026-10-12T20:15:00.000Z", payment: null },
    report: {
      window: { from: "2026-10-18T14:00:00.000Z", to: "2026-10-18T17:00:00.000Z", live: false },
      attendance: { players: 3, totalMinutes: 420, medianMinutes: 150, peakConcurrent: 3, fromRoster: false,
        list: [{ playerId: "p1", name: "Caereca", minutes: 180 }, { playerId: "p2", name: "Kestrel", minutes: 150 }, { playerId: "p3", name: "Quillon", minutes: 90 }] },
      rounds: [{ id: "m1", seq: 1, map: "Foy Warfare", startedAt: "2026-10-18T14:05:00.000Z", endedAt: "2026-10-18T15:33:00.000Z", winner: "allies", alliedScore: 5, axisScore: 0, durationSec: 5280 }],
      top: [{ playerId: "p1", name: "Caereca", kills: 34, deaths: 12, teamkills: 0 }],
    },
  } },
  ...Object.fromEntries([["ev3", "Clan match night", "2026-10-24T19:00:00.000Z", "2026-10-24T22:00:00.000Z"], ["ev4", "Training session", "2026-10-21T18:00:00.000Z", "2026-10-21T19:00:00.000Z"]].map(([id, name, from, to]) => [`/api/payout-events/${id}/report`, { body: {
    event: { id, name, serverId: "s1", serverName: "Server #1", status: "closed", openMode: "at", openAnchor: from, openedAt: from, closeMode: "at", closeAnchor: to, closedAt: to, minMinutes: 30, mapVoteProfile: null, rotationSetId: null, roster: null, createdBy: "Sam", createdAt: "2026-10-12T20:15:00.000Z", payment: null },
    report: {
      window: { from, to, live: false },
      attendance: { players: 2, totalMinutes: 240, medianMinutes: 120, peakConcurrent: 2, fromRoster: false, list: [{ playerId: "p1", name: "Caereca", minutes: 150 }, { playerId: "p2", name: "Kestrel", minutes: 90 }] },
      rounds: [], top: [],
    },
  } }])),
  "/api/servers/s1/mapvote/history": { body: {
    history: [
      { id: "v1", decidedAt: "2026-10-24T20:30:00.000Z", profile: "default", winnerId: "foy", winnerName: "Foy", totalVotes: 12, outcome: "vote", applied: true,
        options: [{ id: "foy", name: "Foy", votes: 7 }, { id: "kursk", name: "Kursk", votes: 3 }, { id: "omaha", name: "Omaha Beach", votes: 2 }] },
      { id: "v2", decidedAt: "2026-10-24T19:00:00.000Z", profile: "default", winnerId: "carentan", winnerName: "Carentan", totalVotes: 9, outcome: "vote", applied: true,
        options: [{ id: "carentan", name: "Carentan", votes: 5 }, { id: "hill400", name: "Hill 400", votes: 4 }] },
    ],
    total: 2,
    tally: [{ mapId: "foy", name: "Foy", offered: 6, won: 3, votes: 31 }, { mapId: "carentan", name: "Carentan", offered: 5, won: 2, votes: 22 }, { mapId: "kursk", name: "Kursk", offered: 4, won: 0, votes: 9 }],
    voters: [
      { discordUserId: "d1", discordName: "Caereca", votes: 14, wins: 9, lastVotedAt: "2026-10-24T20:28:00.000Z", userId: null, playerId: "p1", playerName: "Caereca" },
      { discordUserId: "d2", discordName: "Kestrel", votes: 6, wins: 2, lastVotedAt: "2026-10-24T19:00:00.000Z", userId: null, playerId: "p2", playerName: "Kestrel" },
    ],
    summary: { rounds: 2, decided: 2, forced: 0, silent: 0, totalVotes: 21, contested: 1 },
  } },
  // What automation did lately, the panel's own services, a zone set, and a server's game rewards.
  "/api/automation/history": { body: { total: 3, entries: [
    { id: "a1", ts: "2026-10-24T20:41:00.000Z", actorName: "Seeding", action: "seed.warn", targetName: "Kestrel", targetId: "p2", serverId: "s1", summary: "Warned for playing a tank while seeding", data: null },
    { id: "a2", ts: "2026-10-24T20:12:00.000Z", actorName: "Auto settings", action: "autosettings.apply", targetName: null, targetId: null, serverId: "s1", summary: "Switched to the Night profile at 40 players", data: null },
    { id: "a3", ts: "2026-10-24T19:58:00.000Z", actorName: "Team kills", action: "enforcer.punish", targetName: "Marlow", targetId: "p9", serverId: "s1", summary: "Punished for three team kills in five minutes", data: null },
  ] } },
  "/api/health/services": { body: {
    services: [
      { name: "api", group: "in-process", status: "running", detail: { node: "v22", phase: 4 } },
      { name: "enforcer", group: "in-process", status: "running", detail: {} },
      { name: "event_bus", group: "in-process", status: "running", detail: { backend: "redis" } },
      { name: "discord_api", group: "in-process", status: "running", detail: {} },
    ],
    summary: { running: 4, degraded: 0, down: 0 },
  } },
  // What a profile may change, of each kind the API lists, and a saved setup to apply.
  "/api/servers/s1/autosettings": { body: { config: { enabled: false, dryRun: true, timezone: "UTC", profiles: [], matchMessages: [] }, configured: true, fields: [
    { field: "autoBalanceEnabled", label: "Auto-balance", kind: "bool", group: "Server settings" },
    { field: "autoBalanceThreshold", label: "Auto-balance threshold", kind: "num", group: "Server settings" },
    { field: "welcomeMessage", label: "Welcome message", kind: "str", group: "Server settings" },
    { field: "app:mapvote.enabled", label: "Map vote", kind: "bool", group: "App automation" },
    { field: "preset:broadcast", label: "Broadcast rotation preset", kind: "str", group: "Apply presets" },
  ] } },
  "/api/presets": { body: { presets: { broadcast: [{ id: "pr1", name: "Event night", game: null, createdByName: "Sam", updatedAt: "2026-10-20T00:00:00.000Z" }] } } },
  // A saved template, for Templates to offer and list.
  "/api/autosettings/templates": { body: { templates: [{ id: "t1", name: "Night", config: { profiles: [{ name: "Night", spec: { start: "22:00", end: "06:00" }, settings: {} }] }, createdByName: "Sam", updatedAt: "2026-10-20T00:00:00.000Z" }] } },
  "/api/zones": { body: {
    sets: [{ id: "z1", name: "Carentan spawn lines", game: "hll", zones: { carentan: { allies: ["A1", "A2"], axis: ["J9", "J10"], shared: [] } }, usedBy: [], updatedAt: "2026-10-20T00:00:00.000Z" }],
    maps: [{ key: "carentan", label: "Carentan" }],
  } },
  "/api/servers/s1/game-rewards": { body: { config: GAME_REWARDS, recent: [
    { at: "2026-10-24T20:40:00.000Z", summary: "24 hours of VIP for playing the whole match", player: "Caereca", kind: "matchEnd" },
    { at: "2026-10-24T20:40:00.000Z", summary: "24 hours of VIP for playing the whole match", player: "Kestrel", kind: "matchEnd" },
  ] } },
  // The community's clock, and a notice on the staff board for whoever reads it.
  "/api/app-config": { body: { config: { timezone: "UTC" } } },
  "/api/community/announcements": { body: { announcements: [
    { id: "n1", title: "Event this Saturday", body: "Clan match on Server #1 at 8pm. Seeding from 7pm: everyone who helps gets a day of VIP.", published: true, publishedAt: "2026-10-24T18:00:00.000Z", createdAt: "2026-10-24T18:00:00.000Z", myRead: null },
  ], total: 1 } },
  "/api/economy/members/111": { body: {
    ledger: [{ id: "e1", delta: -250, reason: "VIP shop: Two Weeks", ref: "buy:ix1", actorName: "discord:Alice", createdAt: "2026-10-24T20:15:00.000Z" }],
    players: [{ id: "pl1", name: "Alice", game: "hll", platform: "steam", platformId: "76561190000000005", lastSeen: "2026-10-24T20:00:00.000Z" }],
  } },
  // Below, every other read a screen makes. Left to the stub, a read gets an empty answer, and its
  // screen is drawn empty: its rows and their buttons are never seen by the coverage tests, and an
  // editor waiting on its settings is pictured as grey bars. The coverage tests fail on any read
  // answered that way (unansweredReads, in test/coverage-kit).
  // The panel set up, at home.
  "/api/setup/status": { body: { needed: false, codeRequired: false, stage: null, route: "home" } },
  // Users & roles: the one signed in, a member whose roles come from Discord and one set by hand,
  // with a grant on one server of his own; a role; and the permission list as the API serves it.
  "/api/users": { body: { users: [
    { id: "u1", username: "tester", displayName: "tester", email: null, createdAt: "2026-01-02T03:04:05.000Z", grants: [{ capability: "*", scopeType: "global", scopeId: null, level: "write" }], limits: {}, roles: [], hasPassword: true },
    { id: "u2", username: "sam", displayName: "Sam", email: null, createdAt: "2026-02-10T18:00:00.000Z", grants: [], limits: {}, roles: [{ id: "r1", name: "Moderator", scopeId: null }], discordId: "111", discordUsername: "sam", discordNick: "Sam", discordManaged: true, hasPassword: false },
    { id: "u3", username: "rook", displayName: "Rook", email: null, createdAt: "2026-05-04T19:30:00.000Z", grants: [{ capability: "action.tempban", scopeType: "server", scopeId: "s1", level: "write" }], limits: { "tempban.maxHours": 24 }, roles: [{ id: "r1", name: "Moderator", scopeId: "s1" }], discordId: "333", discordUsername: "rook", discordNick: "Rook", discordManaged: false, hasPassword: true },
  ] } },
  "/api/roles": { body: { roles: [
    { id: "r1", name: "Moderator", description: "Kicks, punishments and temporary bans on every server", grants: [
      { capability: "server.view", level: "read" }, { capability: "action.message", level: "write" }, { capability: "action.kick", level: "write" },
      { capability: "action.punish", level: "write" }, { capability: "action.tempban", level: "write" },
    ], limits: { "tempban.maxHours": 72 }, members: 2 },
  ] } },
  "/api/capabilities": { body: { capabilities: CAPABILITY_CATALOG, presets: ROLE_PRESETS, limits: LIMIT_CATALOG } },
  // Requests: one of your own waiting, and one of Rook's for you to decide, three actions in it.
  "/api/requests": { body: {
    mine: [{ id: "q1", requesterName: "tester", status: "open", note: "Camping our spawn with a tank all match", submittedAt: "2026-10-24T20:30:00.000Z", expiresAt: "2026-10-26T20:30:00.000Z", own: true, lines: [
      reqLine({ id: "l1", capability: "action.tempban", kind: "tempban", payload: { hours: 24, reason: "Spawn camping" }, playerId: "p2", playerName: "Kestrel", canSign: false, signRefusal: "Someone else must approve your own request" }),
    ] }, { id: "q3", requesterName: "tester", status: "closed", note: "Parked a tank in our spawn", submittedAt: "2026-10-20T19:00:00.000Z", expiresAt: "2026-10-22T19:00:00.000Z", own: true, lines: [
      reqLine({ id: "l5", capability: "action.kick", kind: "kick", payload: { reason: "Parked a tank in our spawn" }, playerId: "p3", playerName: "Quillon", state: "approved",
        decidedByName: "Sam", decidedAt: "2026-10-20T19:04:00.000Z", appliedAt: "2026-10-20T19:04:00.000Z", canSign: false }),
    ] }],
    queue: [{ id: "q2", requesterName: "Rook", status: "open", note: "Both on Server #1 tonight", submittedAt: "2026-10-24T20:35:00.000Z", expiresAt: "2026-10-26T20:35:00.000Z", own: false, lines: [
      reqLine({ id: "l2", capability: "action.permaban", kind: "permaban", payload: { reason: "Cheating" }, playerId: "p3", playerName: "Quillon" }),
      reqLine({ id: "l3", seq: 2, capability: "action.punish", kind: "punish", payload: { reason: "Teamkilling at spawn" }, playerId: "p2", playerName: "Kestrel" }),
      reqLine({ id: "l4", seq: 3, capability: "action.tempban", kind: "tempban", payload: { hours: 48, reason: "Spawn camping" }, playerId: "p2", playerName: "Kestrel" }),
    ] }],
  } },
  // A request being built (Build a request, which starts or takes one up again): a kick done at
  // once on Submit, and a temporary ban sent for approval.
  "/api/requests/draft": (url, req) => (["GET", "POST"].includes(req.method) ? { body: { draft: { lines: [
    { id: "d1", kind: "kick", serverId: "s1", playerId: "76562", playerName: "Kestrel", payload: { reason: "Spawn camping" }, fate: "immediate" },
    { id: "d2", kind: "tempban", serverId: "s1", playerId: "76562", playerName: "Kestrel", payload: { hours: 24, reason: "Spawn camping" }, fate: "ask" },
  ] } } } : undefined),
  // Backup: last night's full backup.
  "/api/data/backups": { body: { backups: [{ name: "backup-2026-10-25T03-00-00Z.tar.gz", bytes: 48_234_496, createdAt: "2026-10-25T03:00:00.000Z" }] } },
  // The staff board as whoever may post on it reads it: the notice everyone sees, and a draft.
  "/api/community/announcements/all": { body: { announcements: [
    { id: "n1", title: "Event this Saturday", body: "Clan match on Server #1 at 8pm. Seeding from 7pm: everyone who helps gets a day of VIP.", published: true, publishedAt: "2026-10-24T18:00:00.000Z", createdAt: "2026-10-24T18:00:00.000Z", myRead: null },
    { id: "n2", title: "New reasons for temp bans", body: "Use the reasons in Templates for temp bans from now on, so players read the same words from all of us.", published: false, publishedAt: null, createdAt: "2026-10-24T19:00:00.000Z", myRead: null },
  ], total: 2 } },
  // Rules: two in a section, one paused, and one on no section.
  "/api/enforcer/rules": { body: {
    sections: [{ id: "sec1", name: "Team play", enabled: true }],
    rules: [
      rule({ id: "ru1", name: "Team kills", sectionId: "sec1" }),
      rule({ id: "ru2", name: "Leave your squad leaderless", sectionId: "sec1", eventKind: "app.idle", action: "message", reason: "Your squad has no leader", threshold: 1, pausedUntil: "2026-10-26T00:00:00.000Z", pauseReason: "Event night", pausedBy: "Sam" }),
      rule({ id: "ru3", name: "Thanks for seeding", action: "message", eventKind: "evt.connected", threshold: 1, windowSec: 0, reason: "Thanks for seeding!", enabled: false }),
      rule({ id: "ru4", name: "Base camping", serverId: "s2", eventKind: "evt.kill", action: "message", reason: "Please leave the enemy base alone", threshold: 5, windowSec: 600 }),
    ],
    activity: { ru1: { lastFiredAt: "2026-10-24T19:58:00.000Z", count: 12 } },
    status: {}, now: "2026-10-24T21:00:00.000Z",
  } },
  // Online access: reachable through its tunnel, at the community's address, with the stats site.
  "/api/online": { body: {
    route: "home", tunnel: { set: true, state: "connected", connections: 4, tunnelId: "4f9c2d1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f", detail: null },
    domain: { host: "panel.example.org", proxy: true },
    statsSite: { host: "stats.example.org", origin: "https://stats.example.org", name: "Stats", shareable: "https://stats.example.org" },
    demo: { on: true },
  } },
  // Newer versions are for the account made at setup alone, which no walkthrough is about: the
  // API's answer to anyone else.
  "/api/updates": { body: { shown: false } },
  // Broadcast: the rotation and the live welcome, each with its settings.
  "/api/servers/s1/broadcast": { body: { config: { serverId: "s1", enabled: true, dryRun: false, intervalSec: 300, randomize: false, messages: ["Join our Discord: the link is in the server name", "Squad leaders: put down a garrison before you push"], updatedAt: "2026-10-20T00:00:00.000Z" } } },
  "/api/servers/s1/welcome": { body: { config: { serverId: "s1", enabled: true, template: "Welcome to {server_name}! {player_count} on, playing {map_name}.", intervalSec: 60, lastText: null, lastWrittenAt: null, updatedAt: "2026-10-20T00:00:00.000Z" } } },
  // The game's own ban list: a temporary ban and a permanent one.
  "/api/servers/s1/bans/live": { body: { bans: [
    { playerId: "76562", playerName: "Kestrel", ts: "2026-10-24T20:00:00.000Z", durationHours: 24, reason: "Spawn camping", by: "Sam", type: "temp" },
    { playerId: "a1b2c3", playerName: "Quillon", ts: "2026-10-20T18:00:00.000Z", durationHours: 0, reason: "Cheating", by: "Rook", type: "perma" },
  ] } },
  // A saved rotation, for the rotation and an event to put on.
  "/api/servers/s1/maprotation/sets": { body: { sets: [{ id: "rs1", name: "Weekend rotation", lineup: 12 }] } },
  // No CRCON pull under way, and an archive kept from an earlier one: what to start, and what the
  // archive's own buttons do to it.
  "/api/servers/s1/import/crcon/job": { body: {
    job: null, archive: [{ dataType: "vip", count: 120 }, { dataType: "ban", count: 48 }, { dataType: "player", count: 5_200 }], fileBytes: 3_145_728, archiveServerNumber: 1,
  } },
  "/api/servers/s1/import/crcon/transform/status": { body: { status: "idle" } },
  // Seeding under way, and the last seed's payout missed.
  "/api/servers/s1/seeding/status": { body: {
    state: { phase: "seeding", liveCount: 32, seederCount: 18, updatedAt: "2026-10-24T19:20:00.000Z" }, progressCount: 32, enabled: true, dryRun: false,
    lastCycle: { endedAt: "2026-10-23T19:40:00.000Z", rewarded: false, qualifying: 14, refusal: null, owed: 14 },
  } },
  // Auto settings: what it saw last, and the week its profiles cover.
  "/api/servers/s1/autosettings/status": { body: { enabled: false, dryRun: true, active: null, playerCount: 42, alliedCount: 21, axisCount: 21, sampledAt: "2026-10-24T20:59:00.000Z", matchMinutes: 34 } },
  "/api/servers/s1/autosettings/coverage": { body: { timezone: "UTC", hasGaps: true, calendarOnly: [], groups: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], bands: [{ minPlayers: 0, maxPlayers: null, spans: [{ startMinute: 0, endMinute: 1320, profile: null }, { startMinute: 1320, endMinute: 1440, profile: "Night" }] }] }] } },
  // The admin camera's notice to players, written but off.
  "/api/servers/s1/admincam/config": { body: { notifyEnabled: false, enterMessage: "An admin is watching from the camera.", exitMessage: "The admin has left the camera." } },
  // The map vote: on, a vote open, two sets each paired with a schedule, and a reminder.
  "/api/servers/s1/mapvote/config": { body: {
    enabled: true, surface: "native", channelId: "500000000000000001", pollHours: 2, timezone: "UTC", registeredOnlyIngame: false, registeredOnlyDiscord: false,
    liveApply: true, postMatchApplyDelaySeconds: 300, pollResetDelaySeconds: 180, tidyChannel: true, pauseBelowPlayers: 1, startupState: "remember",
    reminders: [{ minutesAfterMatchStart: 10, message: "Vote for the next map: {options}", layout: "vote_counts" }],
    profileLinks: [{ mapSet: "default", schedule: "Daytime" }, { mapSet: "seeding", schedule: "Seeding" }],
    profiles: [{ name: "default", spec: { start: "07:00", end: "00:00" }, pool: VOTE_POOL }, { name: "seeding", spec: { playersBelow: 50 }, pool: { ...VOTE_POOL, dayCount: 5, nightCount: 0, wildcardCount: 0 } }],
    sets: [
      { id: "ms1", name: "default", pool: VOTE_POOL, usedBy: ["Server #1"] },
      // Built by game mode, as a set made or converted here is.
      { id: "ms2", name: "seeding", pool: { modeBuckets: [{ mode: "warfare", count: 4, limits: { day: 3, night: 1 }, maps: [] }, { mode: "offensive", count: 1, limits: {}, maps: [] }], excludePlayedMaps: 4, blacklistMaps: [] }, usedBy: ["Server #1"] },
    ],
    schedules: [{ id: "vs1", name: "Daytime", spec: { start: "07:00", end: "00:00" }, usedBy: ["Server #1"] }, { id: "vs2", name: "Seeding", spec: { playersBelow: 50 }, usedBy: ["Server #1"] }],
    activeProfile: "default",
    state: {
      paused: false, pauseReason: null, overrideMapId: null, skipNext: false, reroll: false, startNow: false, resyncNow: false, sendMessageLayout: null,
      savedOptions: [], liveAppliedMapId: null, reopenAt: null,
      activePoll: { options: VOTE_OPTIONS, profile: "default", openedAt: "2026-10-24T20:30:00.000Z", totalVotes: 28, talliedAt: "2026-10-24T20:40:00.000Z" },
    },
  } },
  // Events posted to Discord each Monday evening, off for now.
  "/api/payout-events/post-config": { body: { config: { enabled: false, channelId: "500000000000000001", daysAhead: 7, weekday: 1, atHour: 18, atMinute: 0, lastPostedOn: null }, botConfigured: true } },
  // Signatures: the staff line, and every action the API lets a line be added to.
  "/api/signatures": { body: {
    staffLine: "— {staff_name}, staff", customLine: "Appeals: our Discord, #ban-appeals",
    actions: Object.fromEntries(SIGNABLE_ACTIONS.map((id) => [id, { staff: id !== "message", custom: id === "tempban" || id === "permaban" }])),
    signable: SIGNABLE_ACTIONS.map((id) => ({ id, label: SIGNABLE_ACTION_LABELS[id] })),
  } },
  // The live match board's badge, a picture.
  "/api/discord/board-badge": { raw: BADGE_SVG, type: "image/svg+xml" },
  // This round so far, for Live's feed.
  "/api/servers/s1/round/events": { body: { round: { startedAt: "2026-10-24T20:20:00.000Z", map: "Carentan" }, events: [
    { ts: "2026-10-24T20:44:10.000Z", kind: "evt.kill", actorName: "Caereca", victimName: "Marlow", weapon: "M1 GARAND", actorPlayerId: "p1", victimPlayerId: "p9", data: { actorSide: "allies", victimSide: "axis" }, dedupeKey: "k1" },
    { ts: "2026-10-24T20:43:02.000Z", kind: "evt.teamkill", actorName: "Kestrel", victimName: "Caereca", weapon: "MK2 GRENADE", actorPlayerId: "p2", victimPlayerId: "p1", data: { actorSide: "allies", victimSide: "allies" }, dedupeKey: "k2" },
    { ts: "2026-10-24T20:41:00.000Z", kind: "evt.chat", actorName: "Quillon", victimName: null, weapon: null, actorPlayerId: "p3", victimPlayerId: null, data: { message: "need a medic at B", scope: "team" }, dedupeKey: "k3" },
  ] } },
  // Payouts: one paid to everyone online, two of them failed.
  "/api/payouts": { body: { items: [
    { id: "j1", sourceType: "online", payoutType: "currency", amount: 100, serverIds: ["s1"], audience: "online", dryRun: false, status: "DONE", requestedByName: "Sam", createdAt: "2026-10-24T20:00:00.000Z", completedAt: "2026-10-24T20:01:00.000Z", totalCount: 40, successCount: 38, failedCount: 2 },
    // Cut off part-way, when the panel restarted: twelve not paid yet.
    { id: "j2", sourceType: "event", payoutType: "vip", amount: 2, serverIds: ["s1"], audience: "everyone", dryRun: false, status: "INTERRUPTED", requestedByName: "Alex", createdAt: "2026-10-23T20:00:00.000Z", completedAt: null, totalCount: 30, successCount: 18, failedCount: 12 },
  ], total: 2 } },
  "/api/payouts/j2": { body: {
    job: { id: "j2", sourceType: "event", payoutType: "vip", amount: 2, serverIds: ["s1"], audience: "everyone", dryRun: false, status: "INTERRUPTED", requestedByName: "Alex", createdAt: "2026-10-23T20:00:00.000Z", completedAt: null, totalCount: 30, successCount: 18, failedCount: 12 },
    items: [{ id: 3, displayName: "Quillon", discordId: "333", status: "PASS", error: "", detail: {} }, { id: 4, displayName: "Marlow", discordId: null, status: "FAIL", error: "Cut off when the panel restarted", detail: {} }],
    itemsTotal: 2,
  } },
  "/api/payouts/j1": { body: {
    job: { id: "j1", sourceType: "online", payoutType: "currency", amount: 100, serverIds: ["s1"], audience: "online", dryRun: false, status: "DONE", requestedByName: "Sam", createdAt: "2026-10-24T20:00:00.000Z", completedAt: "2026-10-24T20:01:00.000Z", totalCount: 40, successCount: 38, failedCount: 2 },
    items: [{ id: 1, displayName: "Caereca", discordId: "222", status: "PASS", error: "", detail: {} }, { id: 2, displayName: "Kestrel", discordId: null, status: "FAIL", error: "No Discord account linked", detail: {} }],
    itemsTotal: 2,
  } },
  // A profile's own tabs, for the two players a walkthrough opens: map votes, VIP's history, the
  // watchlist, their events and addresses, and the groups they are in.
  "/api/players/p1/mapvote": { body: {
    linked: true, discordId: "222", totals: { votes: 14, wins: 6, firstVotedAt: "2026-06-01T20:00:00.000Z", lastVotedAt: "2026-10-24T20:40:00.000Z" },
    preferences: [{ mapId: "carentan_warfare", name: "Carentan", votes: 5, wins: 3, lastVotedAt: "2026-10-24T20:40:00.000Z" }, { mapId: "foy_warfare_night", name: "Foy (Night)", votes: 4, wins: 1, lastVotedAt: "2026-10-20T20:40:00.000Z" }],
    ballots: [{ id: "b1", decidedAt: "2026-10-24T20:40:00.000Z", mapId: "carentan_warfare", mapName: "Carentan", won: true }, { id: "b2", decidedAt: "2026-10-20T20:40:00.000Z", mapId: "foy_warfare_night", mapName: "Foy (Night)", won: false }],
  } },
  "/api/players/p2/mapvote": { body: { linked: false, discordId: null, totals: { votes: 0, wins: 0, firstVotedAt: null, lastVotedAt: null }, preferences: [], ballots: [] } },
  "/api/players/p1/vip-history": { body: { history: [
    { id: "vh1", ts: "2026-10-01T18:00:00.000Z", action: "granted", by: "Sam", byUserId: "u2", serverId: null, serverName: null, expiration: "2026-11-01T18:00:00.000Z", comment: "Paid a month, PayPal" },
    { id: "vh2", ts: "2026-10-24T20:40:00.000Z", action: "game reward", by: "Game rewards", byUserId: null, serverId: "s1", serverName: "Server #1", expiration: "2026-11-02T18:00:00.000Z", comment: "24 hours for playing the whole match" },
  ] } },
  "/api/players/p2/vip-history": { body: { history: [
    { id: "vh3", ts: "2026-09-01T18:00:00.000Z", action: "granted", by: "Rook", byUserId: "u3", serverId: "s1", serverName: "Server #1", expiration: "2026-09-08T18:00:00.000Z", comment: "Event winner" },
    { id: "vh4", ts: "2026-09-08T18:05:00.000Z", action: "expired", by: "VIP expiry sweep", byUserId: null, serverId: "s1", serverName: "Server #1", expiration: null, comment: null },
  ] } },
  "/api/players/p1/watch": { body: { reasons: [] } },
  "/api/players/p2/events": { body: { total: 2, events: [
    { ts: "2026-10-23T20:43:02.000Z", kind: "evt.teamkill", serverId: "s1", actorName: "Kestrel", victimName: "Caereca", weapon: "MK2 GRENADE", actorPlayerId: "p2", victimPlayerId: "p1", data: null },
    { ts: "2026-10-23T20:12:40.000Z", kind: "evt.kill", serverId: "s1", actorName: "Kestrel", victimName: "Marlow", weapon: "MP40", actorPlayerId: "p2", victimPlayerId: "p9", data: null },
  ] } },
  "/api/players/p2/ips": { body: { ips: [{ ip: "198.51.100.7", firstSeen: "2026-03-01T00:00:00.000Z", lastSeen: "2026-10-23T21:00:00.000Z", seenCount: 18, sharedWith: [{ playerId: "p1", name: "Caereca" }] }] } },
  "/api/player-groups/for/76561": { body: { groups: [] } },
  "/api/player-groups/for/76562": { body: { groups: [{ id: "g1", name: "Clan match roster" }] } },
  // Analytics: a month on Server #1, tab by tab.
  "/api/analytics/combat": { body: {
    window: ANALYTICS_WINDOW, kills: 18_420, teamkills: 412, killers: 1_204, victims: 1_388, tkRate: 0.022,
    weapons: [
      { weapon: "M1 GARAND", classId: "rifle", className: "Rifle", kills: 4_210, teamkills: 61, share: 0.23, tkRate: 0.014 },
      { weapon: "MP40", classId: "smg", className: "Submachine gun", kills: 3_120, teamkills: 48, share: 0.17, tkRate: 0.015 },
      { weapon: "M1919 BROWNING", classId: "mg", className: "Machine gun", kills: 2_480, teamkills: 77, share: 0.13, tkRate: 0.031 },
    ],
    classes: [
      { id: "rifle", label: "Rifle", kills: 7_900, teamkills: 120, share: 0.43 }, { id: "smg", label: "Submachine gun", kills: 4_100, teamkills: 70, share: 0.22 },
      { id: "mg", label: "Machine gun", kills: 2_900, teamkills: 95, share: 0.16 },
    ],
    friendlyFireWeapons: [{ weapon: "SATCHEL", classId: "explosive", className: "Explosive", kills: 310, teamkills: 54, share: 0.02, tkRate: 0.17 }],
    daily: DAYS.map((date, i) => ({ date, kills: 500 + (i % 7) * 60, teamkills: 10 + (i % 5) })),
    weekHour: WEEK_HOURS, byHour: DAY_HOURS,
    topKillers: [{ playerId: "p1", name: "Caereca", kills: 217 }, { playerId: "p2", name: "Kestrel", kills: 96 }],
    topTeamkillers: [{ playerId: "p2", name: "Kestrel", teamkills: 9, kills: 96 }],
    byMap: [{ map: "Carentan Warfare", kills: 6_200, teamkills: 140 }, { map: "Foy Warfare", kills: 5_100, teamkills: 98 }],
  } },
  "/api/analytics/match": { body: {
    window: ANALYTICS_WINDOW, rounds: 84, decided: 80, alliesWins: 43, axisWins: 37, alliesWinRate: 0.54, avgDurationSec: 4_620, medianDurationSec: 4_800, avgMargin: 2.1, blowoutRate: 0.18,
    byMap: [
      { map: "Carentan Warfare", rounds: 22, alliesWins: 12, axisWins: 9, alliesWinRate: 0.57, avgMargin: 2.4, blowoutRate: 0.14, avgDurationSec: 4_500 },
      { map: "Foy Warfare", rounds: 18, alliesWins: 8, axisWins: 10, alliesWinRate: 0.44, avgMargin: 1.8, blowoutRate: 0.22, avgDurationSec: 4_900 },
    ],
    byHour: DAY_HOURS.map((n) => Math.round(n / 20)), weekHour: scaled(WEEK_HOURS, 20),
    timeline: DAYS.map((date, i) => ({ date, rounds: 2 + (i % 3), alliesWins: 1 + (i % 2), axisWins: 1 })),
  } },
  "/api/analytics/player": { body: {
    window: ANALYTICS_WINDOW, sampled: 1_388,
    activity: {
      byHour: DAY_HOURS, byDow: WEEK_HOURS.map((day) => day.reduce((a, b) => a + b, 0)), weekHour: WEEK_HOURS,
      daily: DAYS.map((date, i) => ({ date, sessions: 140 + (i % 7) * 12, players: 90 + (i % 7) * 8, seconds: 400_000 + (i % 7) * 30_000 })),
      sessions: 4_820, uniquePlayers: 1_388, totalSeconds: 12_600_000, medianSec: 2_700, p90Sec: 9_000,
    },
    mix: { newPlayers: 310, returningPlayers: 1_078, newPlayersWhoCameBack: 120 },
    killDistribution: { buckets: [{ label: "0", value: 220 }, { label: "1–9", value: 610 }, { label: "10–49", value: 420 }, { label: "50+", value: 138 }], median: 8, p90: 61, p99: 190, max: 217 },
    kdDistribution: { buckets: [{ label: "under 0.5", value: 300 }, { label: "0.5–1", value: 540 }, { label: "1–2", value: 430 }, { label: "2+", value: 118 }], median: 0.9, p90: 1.9, p99: 3.4, max: 5.2 },
    top: [{ playerId: "p1", name: "Caereca", platform: "steam", kills: 217, deaths: 263, teamkills: 1, kd: 0.83 }, { playerId: "p2", name: "Kestrel", platform: "steam", kills: 96, deaths: 140, teamkills: 9, kd: 0.69 }],
    subject: null,
  } },
  "/api/analytics/staff": { body: {
    window: ANALYTICS_WINDOW, totalActions: 342, activeStaff: 3, totalStaff: 3,
    members: [
      { userId: "u2", name: "Sam", actions: 190, share: 0.56, lastAt: "2026-10-24T20:41:00.000Z", byCategory: { punishes: 90, kicks: 40, messages: 40, tempbans: 20 }, roleIds: ["r1"] },
      { userId: "u3", name: "Rook", actions: 120, share: 0.35, lastAt: "2026-10-24T19:00:00.000Z", byCategory: { kicks: 60, punishes: 40, messages: 20 }, roleIds: ["r1"] },
      { userId: "u1", name: "tester", actions: 32, share: 0.09, lastAt: "2026-10-22T18:00:00.000Z", byCategory: { messages: 32 }, roleIds: [] },
    ],
    allMembers: [{ userId: "u1", name: "tester" }, { userId: "u2", name: "Sam" }, { userId: "u3", name: "Rook" }],
    roles: [{ id: "r1", name: "Moderator" }],
    weekHour: scaled(WEEK_HOURS, 10), byHour: DAY_HOURS.map((n) => Math.round(n / 10)),
    byAction: [{ label: "Punish", value: 130 }, { label: "Kick", value: 100 }, { label: "Message", value: 92 }, { label: "Temp ban", value: 20 }],
    timeline: DAYS.map((date, i) => ({ date, actions: 8 + (i % 6) })),
    uncoveredHours: 41, busiestShare: 0.56,
    response: {
      requests: 28, answered: 25, unanswered: 3, answeredRate: 0.89, medianSec: 95, p90Sec: 420,
      byHour: DAY_HOURS.map((n) => Math.round(n / 40)), weekHour: scaled(WEEK_HOURS, 40), medianByHour: DAY_HOURS.map((_, h) => (h >= 18 ? 80 + h : null)),
      slowest: [{ ts: "2026-10-23T02:10:00.000Z", serverId: "s1", playerName: "Quillon", playerId: "p3", message: "!admin someone is driving a tank into our spawn", responseSec: 1_840, respondedBy: "Rook", respondedAction: "kick" }],
      recent: [{ ts: "2026-10-24T20:30:00.000Z", serverId: "s1", playerName: "Caereca", playerId: "p1", message: "!admin teamkiller in my squad", responseSec: 65, respondedBy: "Sam", respondedAction: "punish" }],
    },
  } },
  "/api/analytics/mapvote": { body: {
    window: ANALYTICS_WINDOW, votesHeld: 64, decidedByVote: 58, overridden: 6, overrideRate: 0.09, totalBallots: 1_920, avgTurnout: 30,
    maps: [{ mapId: "carentan_warfare", name: "Carentan", offered: 40, won: 14, winRate: 0.35, votes: 610 }, { mapId: "foy_warfare_night", name: "Foy (Night)", offered: 31, won: 9, winRate: 0.29, votes: 420 }],
    timeline: DAYS.map((date, i) => ({ date, votes: 2, ballots: 50 + (i % 4) * 10 })),
  } },
  // When people play, by the measure picked: the answer names the measure it was asked for.
  "/api/analytics/server/hours": (url) => ({ body: { metric: url.searchParams.get("metric"), rows: DAYS.map((date) => ({ date, hours: DAY_HOURS })) } }),
  // What the buttons that unfold something read or send.
  // Admin camera's Is it working?: the last hour's log read, two visits in it, both stored.
  "/api/servers/s1/admincam/selfcheck": { body: {
    serverName: "Server #1", seconds: 3600, engagementMode: "active", notify: { enabled: false, enterMessage: "An admin is watching from the camera.", exitMessage: "The admin has left the camera." },
    read: { ok: true, lines: 214, camera: [
      { raw: "[20:41:02] CAMERA: Sam (76561190000000001) Entered Admin Camera", parsed: { name: "Sam", playerId: "76561190000000001", entered: true } },
      { raw: "[20:44:40] CAMERA: Sam (76561190000000001) Left Admin Camera", parsed: { name: "Sam", playerId: "76561190000000001", entered: false } },
    ] },
    stored: { events: 2, visits: 41, sample: [{ ts: "2026-10-24T20:41:02.000Z", actorName: "Sam", entered: true }, { ts: "2026-10-24T20:44:40.000Z", actorName: "Sam", entered: false }] },
  } },
  // VIP integrity: a permanent grant that automation gave an end date, three days short.
  "/api/vips/integrity": { body: { scanned: 3, findings: [
    { serverId: "s1", serverName: "Server #1", playerId: "76561", playerName: "Caereca", verdict: "shortened", permanentSince: "2026-03-01T18:00:00.000Z", grantedBy: "Sam",
      currentExpiration: "2026-11-01T18:00:00.000Z", lostMs: 3 * 864e5, evidence: ["A seed reward on 2026-10-20 wrote an end date onto the permanent grant"] },
    { serverId: "s1", serverName: "Server #1", playerId: "76561190000000006", playerName: "Rowan", verdict: "lost", permanentSince: "2026-02-01T18:00:00.000Z", grantedBy: "Alex",
      currentExpiration: null, lostMs: null, evidence: [
        "2026-08-14T02:59:00.000Z — A seed reward wrote an end date onto the permanent grant",
        "2026-08-14T03:00:00.000Z — The VIP expiry sweep took the grant off the game",
        "2026-08-20T19:00:00.000Z — A seed reward added 24 hours to a grant that was gone",
      ] },
  ] } },
  // A sample of the vote a map set would make.
  "/api/servers/s1/maps/poll/preview": { body: { options: VOTE_OPTIONS.map(({ id, name }) => ({ id, name })), profile: "default", alwaysOffered: [], alwaysSkipped: [] } },
  // Rules: one deleted lately, and each rule's saved changes.
  "/api/enforcer/deleted-rules": { body: { deleted: [
    { id: "v9", change: "delete", targetId: "ru9", targetName: "No tanks while seeding", before: { name: "No tanks while seeding", enabled: true }, after: null, actorName: "Sam", createdAt: "2026-10-22T19:00:00.000Z" },
  ] } },
  ...Object.fromEntries(["ru1", "ru2", "ru3", "ru4"].map((id) => [`/api/enforcer/rules/${id}/versions`, { body: { versions: [
    { id: `${id}-v2`, change: "edit", targetId: id, targetName: null, before: { threshold: 2 }, after: { threshold: 3 }, actorName: "Sam", createdAt: "2026-10-20T18:00:00.000Z" },
    { id: `${id}-v1`, change: "edit", targetId: id, targetName: null, before: { enabled: false }, after: { enabled: true }, actorName: "Rook", createdAt: "2026-10-10T18:00:00.000Z" },
  ] } }])),
  // The map vote's library: a set and a schedule deleted lately, and each record's saved changes.
  "/api/mapvote/sets/deleted": { body: { deleted: [
    { id: "msv9", change: "delete", targetId: "ms9", targetName: "night only", before: { name: "night only" }, after: null, actorName: "Sam", createdAt: "2026-10-21T19:00:00.000Z" },
  ] } },
  "/api/mapvote/schedules/deleted": { body: { deleted: [
    { id: "vsv9", change: "delete", targetId: "vs9", targetName: "Weekends", before: { name: "Weekends" }, after: null, actorName: "Sam", createdAt: "2026-10-21T19:00:00.000Z" },
  ] } },
  ...Object.fromEntries([["sets", "ms1"], ["sets", "ms2"], ["schedules", "vs1"], ["schedules", "vs2"]].map(([kind, id]) => [`/api/mapvote/${kind}/${id}/versions`, { body: { versions: [
    { id: `${id}-v1`, change: "edit", targetId: id, targetName: null, before: { name: "old name" }, after: { name: id.startsWith("ms") ? "default" : "Daytime" }, actorName: "Sam", createdAt: "2026-10-18T18:00:00.000Z" },
  ] } }])),
  // Who a payout would pay, before it is sent.
  "/api/payouts/preview": { body: {
    recipients: [
      { discordId: "222", playerId: "p1", displayName: "Caereca", sourceName: "Caereca", minutes: 95 },
      { discordId: "333", playerId: "p3", displayName: "Quillon", sourceName: "Quillon", minutes: 40 },
    ],
    dropped: { unlinked: 1, noRole: 0, underMinutes: 2, removed: 0, noGameAccount: 0 },
  } },
  // A token made under Settings: shown once, to copy. The list it joins is the stub's own.
  "/api/tokens": (url, req) => (req.method === "POST" ? { body: { token: "hrt_4f9c2d1e7a3b4c5d9e8f0a1b2c3d4e5f", name: "token" } }
    : req.method === "GET" ? { body: { tokens: [{ id: "tk1", name: "Discord bot", createdAt: "2026-09-12T18:00:00.000Z", expiresAt: null }] } } : undefined),
};

// Server #2 answers what a screen asks once it is picked there (a scheduled event's server): the same
// map sets and map vote as Server #1.
for (const read of ["maprotation/sets", "mapvote/config"]) WALK_FIXTURES[`/api/servers/s2/${read}`] = WALK_FIXTURES[`/api/servers/s1/${read}`];

/** Vietnam's game, as the real one describes it (packages/games/src/hllv/data) in the parts the
 *  panel draws from: its two sides, its roles and squads, and the scores it keeps. */
const HLLV_DESCRIPTOR = {
  id: "hllv", label: "Hell Let Loose: Vietnam",
  sides: [
    { id: "allies", label: "US", teamValues: [1], parity: "odd", color: "blue" },
    { id: "axis", label: "NVA", teamValues: [2], parity: "even", color: "red" },
  ],
  roles: {
    0: "Rifleman", 3: "Medic", 4: "Spotter", 5: "Specialist", 6: "Machine Gunner", 7: "Grenadier", 8: "Engineer", 9: "Squad Leader", 10: "Sniper",
    11: "Crewman", 12: "Tank Commander", 13: "Mortar Support", 14: "Mortar Observer", 15: "Mortar Gunner", 16: "Pilot", 17: "Logistics Officer", 20: "Commander",
  },
  squadLeaderRoles: [4, 9, 12, 14, 17],
  squadTypes: { infantry: [0, 3, 5, 6, 7, 8, 9], recon: [4, 10], armor: [11, 12], mortar: [13, 14, 15], helicopter: [16, 17] },
  scoreFields: [
    { key: "cOMBAT", label: "Cbt", title: "Combat score" }, { key: "offense", label: "Off", title: "Offense score" },
    { key: "defense", label: "Def", title: "Defense score" }, { key: "support", label: "Sup", title: "Support score" },
  ],
  configFields: [],
};

/** A CRCON pull in one of its states, beside the archive the stage keeps. */
const crconPull = (status, errors = []) => ({ "/api/servers/s1/import/crcon/job": { body: {
  ...WALK_FIXTURES["/api/servers/s1/import/crcon/job"].body,
  job: { id: "cj1", status, counts: { vip: 120, ban: 48, player: 5_200 }, errors, createdByName: "Sam", createdAt: "2026-10-24T18:00:00.000Z", updatedAt: "2026-10-24T20:00:00.000Z" },
} } });
/** The servers, the first as `over` makes it. */
const firstServer = (over) => {
  const list = WALK_FIXTURES["/api/servers"];
  return { "/api/servers": (url, req) => {
    const { body } = typeof list === "function" ? list(url, req) : list;
    return { body: { ...body, servers: body.servers.map((s, i) => (i === 0 ? { ...s, ...over } : s)) } };
  } };
};
/** Who is signed in, with these preferences on their account and `more` said about them: as the stub
 *  answers, plus the day the account was made, which What's new counts from — every update seen,
 *  unless `prefs` says otherwise. */
const signedIn = (grants, prefs, more = {}) => ({ "/api/me": { body: {
  user: { id: "u1", username: "tester", displayName: "tester", discordNick: null, role: "owner", hasPassword: true, createdAt: "2026-01-02T03:04:05.000Z" },
  grants, limits: {}, roles: [], prefs: { setupSeen: SETUP_VERSION, whatsNewSeen: WHATS_NEW[0].build, ...prefs }, ...more,
} } });

/**
 * The states a step can ask for by name (its `stage`, in lib/walkthroughs): what the panel shows
 * only while a CRCON pull runs, on a Vietnam server, when nothing has been recorded yet, and so
 * on — each the answers that make it so, given the permissions the stage is played with. A step's
 * picture is taken in its state (stageFor), and test/e2e-4 looks at every control each state shows.
 */
export const STAGES = {
  // A CRCON pull pulling, paused, stopped on an error, and done with one page that failed.
  "crcon-running": () => crconPull("running"),
  "crcon-paused": () => crconPull("paused"),
  "crcon-stopped": () => crconPull("error", ["log page 12: timed out"]),
  "crcon-done": () => crconPull("done", ["log page 12: timed out"]),
  // The first server a Vietnam one, with a layout of objectives saved for its map, for three plays.
  vietnam: () => ({
    ...firstServer({ game: "hllv" }), "/api/games/hllv/descriptor": { body: { descriptor: HLLV_DESCRIPTOR } },
    "/api/servers/s1/maps/objectives": { body: { ...WALK_FIXTURES["/api/servers/s1/maps/objectives"].body, saved: [0, 1, 2, 0, 1], savedPlays: 3 } },
  }),
  // The last seed's reward paid, but not to everyone yet.
  "seed-owed": () => {
    const status = WALK_FIXTURES["/api/servers/s1/seeding/status"].body;
    return { "/api/servers/s1/seeding/status": { body: { ...status, lastCycle: { ...status.lastCycle, rewarded: true, owed: 3 } } } };
  },
  // The first server's stats on the public site.
  published: () => firstServer({ streamerMode: true }),
  // No server connected yet, and one on which nobody has played yet.
  "no-servers": () => ({ "/api/servers": { body: { servers: [] } } }),
  "no-players": () => ({ "/api/players": { body: { players: [], total: 0 } } }),
  // The server list could not be read, and the panel could not reach its own server at all.
  "servers-unread": () => ({ "/api/servers": { status: 503, body: { error: "The panel's server is not answering" } } }),
  unreachable: () => ({ "/api/me": { status: 503, body: { error: "The panel's server is not answering" } } }),
  // Signed out, with Discord sign-in set up.
  "signed-out": () => ({ "/api/me": { status: 401, body: { error: "unauthorized" } }, "/api/auth/discord/status": { body: { configured: true } } }),
  // The first sign-in after the newest update with something in it for this person: What's new
  // leaves out an item about screens they cannot open, and opens only with something to show.
  "whats-new": (grants) => {
    const opens = (id) => { const r = routeById(id); return Boolean(r && canOpenRoute(grants, r)); };
    const newest = WHATS_NEW.findIndex((r) => r.items.some((it) => !it.where || it.where.some(opens)));
    return signedIn(grants, { whatsNewSeen: WHATS_NEW[newest + 1].build });
  },
  // The first sign-in after being given permissions that opened walkthroughs.
  "new-walkthroughs": (grants) => signedIn(grants, { walkthroughs: { for: "an earlier check", locked: ["use-help", "use-screens", "your-settings"] } }),
  // What the dashboard asks attention for: a watched player in game, and a staff notice unread.
  attention: (grants) => {
    const watched = WALK_FIXTURES["/api/players/flagged"].body.flags;
    return {
      ...signedIn(grants, {}, { unseenAnnouncements: 1 }),
      "/api/players/flagged": { body: { flags: watched.map((f) => ({ ...f, online: true, onlineServers: [{ serverId: "s1", serverName: "Server #1" }] })) } },
    };
  },
};

/** The answers a step's screen is drawn from: the stage's records, and the state the step names on
 *  top of them, for someone holding `grants`. */
export function stageFor(step, grants) {
  if (!step.stage) return WALK_FIXTURES;
  const state = STAGES[step.stage];
  if (!state) throw new Error(`no stage "${step.stage}": name one of test/walk-stage STAGES`);
  return { ...WALK_FIXTURES, ...state(grants) };
}

/** Point a stub's answers at those a step's screen is drawn from (stageFor). The stub reads its
 *  `overrides` afresh for every request, so the next screen opened is drawn from them. */
export function setStage(overrides, step, grants) {
  const want = stageFor(step, grants);
  for (const k of Object.keys(overrides)) if (!(k in want)) delete overrides[k];
  Object.assign(overrides, want);
}

const grant = (capability, level) => ({ capability, scopeType: "global", scopeId: null, level });

/**
 * The fewest permissions that show every step of a walkthrough: its own, and one that opens each
 * step's screen (the first the screen names) — never the owner's "*", so nothing only an owner sees
 * is ever in a picture. A step that presses a tab needs a tab bar to press it in, which a screen
 * shows only with a second tab, so one more permission opens the screen's first other tab.
 */
export function walkGrants(walk) {
  const want = new Map();
  const add = (cap, level) => { if (want.get(cap) !== "write") want.set(cap, level); };
  const opens = (r) => { const first = r?.caps?.[0]; if (first) add(first, r.capLevel ?? minLevelFor(first)); };
  for (const c of walk.caps) add(c, walk.capLevel ?? minLevelFor(c));
  for (const c of walk.needs ?? []) add(c, minLevelFor(c));
  for (const s of walk.steps) {
    for (const c of s.caps?.slice(0, 1) ?? []) add(c, s.capLevel ?? minLevelFor(c));
    for (const c of s.needs ?? []) add(c, minLevelFor(c));
    const r = routeById(s.route);
    opens(r);
    if (s.target.tab && r?.parent) opens(ROUTES.find((t) => t.parent === r.parent && t.id !== r.id && t.caps?.length));
  }
  return [...want].map(([c, l]) => grant(c, l));
}

/** The walkthrough by id — for tests that name one. */
export const walkById = (id) => WALKTHROUGHS.find((w) => w.id === id);

/** The element a target names on the page, or null — the panel's own finder, run in the page. */
export async function findIn(page, target) {
  const handle = await page.evaluateHandle(([src, t]) => new Function(`return ${src}`)()(t), [FIND, target]);
  const el = handle.asElement();
  if (!el) await handle.dispose();
  return el;
}

/** Scroll to a control as "Show me on my screen" does: to the middle, or a tall one's top in view. */
export async function bringIntoView(el) {
  await el.evaluate((e, src) => new Function(`return ${src}`)()(e), BRING);
}

/** The part of a control in view, as Playwright gives a box (x, y, width, height) — what its ring
 *  goes round. Null when none of it is. */
export async function visibleBox(el) {
  const b = await el.evaluate((e, src) => new Function(`return ${src}`)()(e), BOX);
  return b.width > 0 && b.height > 0 ? { x: b.left, y: b.top, width: b.width, height: b.height } : null;
}

/** Wait for a target to be on the page; the element, or null when it never came. */
export async function waitFor(page, target, timeout = 10000) {
  const ok = await page.waitForFunction(([src, t]) => Boolean(new Function(`return ${src}`)()(t)), [FIND, target], { timeout })
    .then(() => true, () => false);
  return ok ? findIn(page, target) : null;
}

/**
 * Open the step's screen fresh (a full load, so nothing from the step before is left open) and do
 * what it says to do first. Returns the step's target, or null with the reason it is missing.
 *
 * On a phone (`phone`, in a page sized like PHONE_SCREEN) the step is as it is there
 * (lib/walkthroughs onPhone), and what it points at in the menu is shown with the menu open — a
 * screen's entry is the menu's, never the quick bar's, which each person arranges for themselves.
 * `menu` says so.
 */
/**
 * A step in Discord (WalkStep.discord) has no screen: the panel it is in is drawn in its place in
 * its walkthrough's slideshow. That slideshow is opened by its link and moved on to the step, and
 * the step's control is looked for in the drawing there.
 */
async function stageDiscordStep(page, base, at, visit, phone) {
  const step = phone ? onPhone(at) : at;
  const walk = WALKTHROUGHS.find((w) => w.steps.includes(at));
  if (!walk) return { el: null, why: "a step in Discord that no walkthrough has" };
  await page.goto(`${base}/?walk=${visit}#/help/start/~${walk.id}`, { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: walk.title });
  if (!(await dialog.waitFor({ timeout: 10000 }).then(() => true, () => false))) return { el: null, why: "its walkthrough did not open from its link" };
  for (let n = 0; n < walk.steps.length; n++) {
    if ((await dialog.locator(".walk-text").textContent()) === step.text) {
      const el = await waitFor(page, step.target);
      return el ? { el, why: "" } : { el: null, why: `target ${JSON.stringify(step.target)} not found in the drawing` };
    }
    const next = dialog.getByRole("button", { name: "Next", exact: true });
    if (!(await next.count())) break;
    await next.click();
  }
  return { el: null, why: "the step is not in its walkthrough's slideshow" };
}

export async function stageStep(page, base, at, visit, { phone = false } = {}) {
  if (at.discord) return stageDiscordStep(page, base, at, visit, phone);
  const step = phone ? onPhone(at) : at;
  const route = routeById(step.route);
  if (!route) return { el: null, why: `no route ${step.route}` };
  // What a screen keeps for the tab's life (the member left open, a filter), and how its panels
  // were left (one the step before opened), are the step before's, not this one's: a row or a
  // panel opened then is closed again by this step's click. So is a request the step before began
  // building (lib/requestMode), which this browser would otherwise go on building.
  await page.evaluate(() => {
    window.sessionStorage.clear();
    for (const k of Object.keys(window.localStorage)) if (k.startsWith("panel.panels.") || k.startsWith("panel.requestMode")) window.localStorage.removeItem(k);
  }).catch(() => {});
  await page.goto(`${base}/?walk=${visit}#${route.path}`, { waitUntil: "networkidle" });
  for (const act of step.before ?? []) {
    const t = act.click ?? act.fill;
    const el = await waitFor(page, t);
    if (!el) return { el: null, why: `before: ${JSON.stringify(t)} not found` };
    if (act.click) {
      // From the middle of the screen, so what it opens (a row's menu) opens in view.
      await el.evaluate((e) => e.scrollIntoView({ block: "center", inline: "nearest" }));
      await el.click();
    } else {
      // A list is filled by picking the option with those words.
      const field = (await el.$("input, textarea, select")) ?? el;
      if (await field.evaluate((f) => f.tagName === "SELECT")) await field.selectOption({ label: act.value });
      else await field.fill(act.value);
    }
    await page.waitForTimeout(120);
  }
  const el = await waitFor(page, step.target);
  if (!el) return { el: null, why: `target ${JSON.stringify(step.target)} not found` };
  if (!phone || !(step.target.nav || await el.evaluate((e) => Boolean(e.closest(".sidebar"))))) return { el, why: "" };
  // The menu opened already, by what the step does first (your initial, at the top right, opens it
  // at your name): ☰ would close it again.
  if (!step.target.nav && await page.evaluate(() => Boolean(window.document.querySelector(".app-shell.drawer-open")))) return { el, why: "" };
  await el.dispose();
  const burger = await waitFor(page, { css: ".topbar .burger" });
  if (!burger) return { el: null, why: "no ☰ to open the menu with" };
  await burger.click();
  // The menu slides in from the side: what it rings is there once it has, not part way.
  const inMenuTarget = step.target.nav ? { css: `.sidebar [data-route="${step.target.nav}"]` } : step.target;
  const slidIn = await page.waitForFunction(([src, t]) => {
    const found = new Function(`return ${src}`)()(t);
    const r = found?.getBoundingClientRect();
    return Boolean(r && r.left >= 0 && r.right <= window.innerWidth);
  }, [FIND, inMenuTarget], { timeout: 10000 }).then(() => true, () => false);
  const inMenu = slidIn ? await findIn(page, inMenuTarget) : null;
  return inMenu ? { el: inMenu, why: "", menu: true } : { el: null, why: `target ${JSON.stringify(step.target)} not found in the menu` };
}
