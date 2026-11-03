// The panel's reads, answered for a made-up community: what the test stub serves (stub-api.mjs),
// what the walkthrough stage builds on (walk-stage.mjs), and what the public demo starts from
// (lib/demo). Nothing here may reach for Node: the demo runs it in a browser.
import { SETUP_VERSION } from "../lib/gettingStarted.ts";

export const OWNER_GRANTS = [{ capability: "*", scopeType: "global", scopeId: null, level: "write" }];

/**
 * Getting started opens on a sign-in that has not been through it (components/GettingStarted). A
 * test is about something else unless it says so, so every /api/me answer has been through it —
 * except one whose prefs name `setupSeen` themselves.
 */
export function withSetupSeen(path, body) {
  if (path !== "/api/me" || !body || typeof body !== "object" || !body.user) return body;
  if (body.prefs && typeof body.prefs === "object" && "setupSeen" in body.prefs) return body;
  return { ...body, prefs: { ...(body.prefs ?? {}), setupSeen: SETUP_VERSION } };
}

const P1_EVENTS = [
  { ts: "2026-07-31T10:19:00.000Z", kind: "evt.kill", serverId: "s1", actorName: "CPL Crunch", actorPlayerId: "p2", victimName: "Caereca", victimPlayerId: "p1", weapon: "M1 GARAND", data: { actorSide: "allies" } },
  { ts: "2026-07-31T10:10:00.000Z", kind: "evt.kill", serverId: "s1", actorName: "Clutch", actorPlayerId: "p3", victimName: "Caereca", victimPlayerId: "p1", weapon: "KARABINER 98K", data: { actorSide: "axis" } },
  { ts: "2026-07-31T09:51:00.000Z", kind: "evt.admin.message", serverId: "s1", actorName: "Caereca", actorPlayerId: "p1", data: { message: "play the objective" } },
  { ts: "2026-07-31T09:40:00.000Z", kind: "evt.teamkill", serverId: "s2", actorName: "Caereca", actorPlayerId: "p1", victimName: "Necrosis85", victimPlayerId: "p4", weapon: "SATCHEL" },
];

/** Roles that lead nothing — rifleman through engineer, skipping spotter (4), which does. */
const GRUNTS = [0, 1, 2, 3, 5, 6, 7, 8];
/**
 * The first member of each squad, minus three.
 *
 * Squads are `i % 5` and sides split at 49, so allies' first members are 0-4 and axis' are 49-53.
 * Withheld: 2 (allies CHARLIE), 49 (axis EASY) and 53 (axis DOG) — the three the No-SL strip is
 * meant to name.
 */
const OFFICERS = new Set([0, 1, 3, 4, 50, 51, 52]);

/** Every read the panel makes, answered as a quiet community would: the stub serves these, and the
 *  walkthrough stage and the demo build on them. `staffPanel` is the bot's own drawing of its panel. */
export function stageAnswers(grants, staffPanel) {
  return {
    "/api/me": { user: { id: "u1", username: "tester", displayName: "tester", discordNick: null, role: "owner", hasPassword: true }, grants, limits: {}, roles: [] },
    "/api/layout/admin": { source: "default", widgets: [{ id: "players", title: "Players", visible: true, order: 20, required: false }, { id: "community", title: "Announcements", visible: true, order: 50, required: false }] },
    "/api/layout/dashboard": { source: "default", widgets: [
      { id: "dash-servers", title: "Servers", visible: true, order: 10, required: false, size: { w: 2, h: 1 }, view: { blocks: [{ type: "stat", label: "configured", source: { kind: "api", path: "/servers", pick: "servers.length" } }] } },
    ] },
    "/api/servers": { servers: [{ id: "s1", name: "Test Server #1", game: "hll", engagementMode: "observe" }] },
    "/api/health/metrics": { online: true, cpuPct: 1, memory: { usedBytes: 1, totalBytes: 4, pct: 25 }, disk: { usedBytes: 1, totalBytes: 25, pct: 4 }, uptimeSec: 900, hostname: "test", node: "v22", appVersion: "0.0.0", appCommit: "abc1234" },
    "/api/plugins": { plugins: [] },
    "/api/discord/staff-panel": staffPanel.panel,
    "/api/discord/staff-panel/maps/s1": { message: staffPanel.maps },
    "/api/discord/staff-panel/moderation/s1": { message: staffPanel.moderation },
    "/api/tokens": { tokens: [] },
    "/api/players": { players: [], total: 0 },
    // One player profile, with the two things the profile's activity feed needs and used to drop:
    // `data.actorSide` (which colours a kill blue or red) and `serverId` (what the filter reads).
    "/api/players/p1": {
      player: { id: "p1", name: "Caereca", platform: "steam", platformId: "76561", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-07-31T10:00:00.000Z" },
      stats: { kills: 217, deaths: 263, teamkills: 1 },
      flags: { watchlist: false, vip: false, updatedByName: null },
      canViewNotes: true, notes: [],
      statsByServer: [
        { serverId: "s1", serverName: "The [LYNX] Division #1 | MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED", kills: 9, deaths: 5, playtimeSec: 0, matchesPlayed: 0, matchesWon: 0, slSeconds: 0, visits: 2 },
        { serverId: null, serverName: "Before per-server tracking", kills: 208, deaths: 258, playtimeSec: 34200, matchesPlayed: 3, matchesWon: 1, slSeconds: 0, visits: 40 },
      ],
      sessions: [],
      recentEvents: P1_EVENTS,
    },
    // The profile's paged feed reads THIS endpoint (whole history, server-side filters), and the
    // tests exercise the filters — so the stub filters and pages for real instead of echoing.
    "/api/players/p1/events": (url) => {
      const kinds = (url.searchParams.get("kinds") ?? "").split(",").filter(Boolean);
      const serverId = url.searchParams.get("serverId") || "";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const all = P1_EVENTS.filter((e) => (!kinds.length || kinds.includes(e.kind)) && (!serverId || e.serverId === serverId));
      return { events: all.slice(offset, offset + limit), total: all.length, offset, limit };
    },
    // Staff activity: two staff, and a role list that includes a NAMELESS role — a blank chip is
    // indistinguishable from a rendering bug, so the filter has to label it.
    "/api/audit/staff": { staff: [
      { actorUserId: "u1", actorName: "tester", actorDisplayName: "tester", count: 12, lastAt: "2026-07-31T10:00:00.000Z", byAction: { "server.automation": 12 }, roleIds: ["r-owner"] },
      { actorUserId: "u2", actorName: "yeti", actorDisplayName: "yeti", count: 3, lastAt: "2026-07-30T10:00:00.000Z", byAction: { "user.discord_login": 3 }, roleIds: ["r-blank"] },
    ], roles: [{ id: "r-owner", name: "Owner (all access)" }, { id: "r-blank", name: "" }] },
    "/api/audit": { entries: [], total: 0 },
    // Data trim: a two-of-each catalog, and preview counts DISTINCT per id — the test proves each
    // row wears its own number, which identical counts could not distinguish from a shared one.
    "/api/trim/options": {
      categories: [
        { id: "kills", label: "Kills", hint: "the killfeed" },
        { id: "chat", label: "Chat", hint: "team and squad messages" },
      ],
      datasets: [
        { id: "rosterSnapshots", label: "Roster snapshots", hint: "one per server per minute" },
        { id: "audit", label: "Staff activity", hint: "the panel's own action log" },
      ],
    },
    "/api/trim/preview": { events: 46, perCategory: { kills: 41, chat: 5 }, datasets: { rosterSnapshots: 1440, audit: 12 }, total: 1498, olderThan: "2026-05-01T00:00:00.000Z" },
    // Database export/import: a Postgres-backed install with a small catalog whose `needs` chain
    // (vip → players → servers) is what the auto-select test exercises. Distinct counts again.
    "/api/data/options": { supported: true, groups: [
      { id: "servers", label: "Server connections", hint: "hosts, ports and RCON credentials" },
      { id: "players", label: "Players & careers", hint: "the directory", needs: ["servers"] },
      { id: "vip", label: "VIP & console admins", hint: "grants and presets", needs: ["players", "servers"] },
      { id: "audit", label: "Staff activity", hint: "the panel's own action log" },
    ] },
    "/api/data/counts": { counts: { servers: 2, players: 51877, vip: 143, audit: 9210 } },
    "/api/data/status": { run: { status: "idle" }, upload: null },
    "/api/leaderboard": { leaderboard: [] },
    "/api/bans": { bans: [] },
    // ECONOMY_DEFAULTS-shaped, so the Economy tab renders its three panels without special-casing.
    "/api/economy/config": { config: {
      currencyName: "Points", balanceCap: null,
      claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: false, minAmount: 1, maxAmount: null }, vipGifting: { enabled: false, roleIds: [] }, offers: [],
      registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, bonusPerGame: false, gameRoles: {}, serverIds: [] }, updatedAt: "2026-07-01T00:00:00.000Z",
    } },
    "/api/economy/members": { members: [], total: 0 },
    "/api/economy/activity": { entries: [
      { id: "e1", discordId: "111", discordName: "Alice", delta: -250, reason: "VIP shop: Two Weeks", ref: "buy:ix1", actorName: "discord:Alice", createdAt: "2026-08-30T10:00:00.000Z", kind: "purchase" },
      { id: "e2", discordId: "222", discordName: "Bob", delta: 100, reason: "gift received", ref: "gift-in:gift:ix2", actorName: null, createdAt: "2026-08-30T09:00:00.000Z", kind: "gift" },
    ], total: 2, kinds: [
      { id: "purchase", label: "Purchases" }, { id: "gift", label: "Gifts" }, { id: "claim", label: "Claims" },
      { id: "payout", label: "Payouts" }, { id: "seed", label: "Seed rewards" }, { id: "refund", label: "Refunds" },
      { id: "bonus", label: "Welcome bonuses" }, { id: "adjust", label: "Adjustments" },
    ] },
    // The GAME's admin list + the groups it offers — what the Console admin popup reads when it
    // opens. Stock HLL groups, so the picker has real choices without a server behind it.
    "/api/servers/s1/admins": { serverId: "s1", count: 0, admins: [], groups: ["owner", "senior", "junior", "spectator"] },
    "/api/community/announcements": { announcements: [] },
    // A busy, realistic Live read: a full 98/100 server mid-round, with the score line, a next map
    // and squads missing an officer — i.e. the tallest the Live header ever gets. The mobile
    // layout test needs the WORST case, not a quiet one.
    "/api/servers/s1/live": {
      session: {
        playerCount: 98, maxPlayerCount: 100, queueCount: 40, maxQueueCount: 40,
        // Straight from a live server: vipQueueCount carries the VIP LIST size, not a queue, and
        // maxVipQueueCount is the reserved-slot setting. 742 waiting against a max of 2 is the bug.
        vipQueueCount: 742, maxVipQueueCount: 2,
        mapId: "stmereeglise_offensive_us",
        // Spelled and accented exactly the way the game prints it — this is the string whose
        // artwork silently failed to resolve, so the fixture keeps the hard case.
        mapName: "SAINTE-MÈRE-ÉGLISE", gameMode: "Offensive",
        alliedScore: 2, axisScore: 3, alliedPlayerCount: 49, axisPlayerCount: 49,
        remainingMatchTime: 4548,
      },
      players: Array.from({ length: 98 }, (_, i) => ({
        id: `p${i}`, playerId: `p${i}`, name: `Player ${i}`,
        team: i < 49 ? 0 : 1, squad: ["ABLE", "BAKER", "CHARLIE", "DOG", "EASY"][i % 5],
        /*
         * One officer per squad, except three deliberately left without one — the No-SL strip is
         * part of the tallest-header case this fixture exists to reproduce, so it has to be earned
         * rather than assumed. Everyone else draws from GRUNTS, which excludes every leader role;
         * the old `i % 9` sprinkled spotters around and would now quietly lead half these squads.
         */
        role: OFFICERS.has(i) ? 9 : GRUNTS[i % GRUNTS.length],
        level: 50 + (i % 40), kills: i % 30, deaths: i % 20, score: i * 13,
        // Every tenth player holds a real VIP grant — the roster's `vip` is the grant now, not
        // the cosmetic profile marker, so the live view's VIP count has something to count.
        vip: i % 10 === 0,
        stats: { infantryKills: i % 30, vehicleKills: 0, deaths: i % 20, teamKills: i % 7 === 0 ? 1 : 0 },
      })),
      // The real endpoint returns the rotation alongside the round; without it the header has no
      // "Next:" line and the tallest-header case the mobile layout test needs isn't the tall one.
      mapRotation: { currentIndex: 0, mAPS: [{ name: "SAINTE-MÈRE-ÉGLISE", gameMode: "Offensive" }, { name: "FOY", gameMode: "Warfare" }] },
    },
    // The real shape the Maps page reads: a full catalogue plus the rotation drawn from it, with
    // raw ids on every entry. The old fixture had neither `maps` nor an `id`, so the page threw on
    // `data.maps.length` and no test ever saw it render.
    // Shaped from a REAL server's discovered map list: all three modes HLL actually runs
    // (warfare, offensive AND skirmish) across every environment it reports. Skirmish is here on
    // purpose — it was missing from every preset and default, so 27% of a real catalogue could
    // never be voted on and no fixture would have caught it.
    "/api/servers/s1/maps": (() => {
      const mk = (id, prettyName, mode, environment, family) =>
        ({ id, prettyName, mode, environment, family, envGroup: environment === "night" ? "night" : "day" });
      const maps = [
        mk("carentan_warfare", "Carentan", "warfare", "day", "carentan"),
        mk("carentan_warfare_night", "Carentan (Night)", "warfare", "night", "carentan"),
        mk("carentan_offensive_ger", "Carentan Off. GER", "offensive", "day", "carentan"),
        mk("carentan_skirmish_day", "Carentan Skirmish", "skirmish", "day", "carentan"),
        mk("foy_warfare", "Foy", "warfare", "day", "foy"),
        mk("foy_warfare_night", "Foy (Night)", "warfare", "night", "foy"),
        mk("kharkov_warfare", "Kharkov", "warfare", "day", "kharkov"),
        mk("kharkov_offensive_ger", "Kharkov Off. GER", "offensive", "day", "kharkov"),
        mk("stmariedumont_warfare", "St Marie Du Mont", "warfare", "day", "stmariedumont"),
        mk("stmariedumont_warfare_night", "St Marie Du Mont (Night)", "warfare", "night", "stmariedumont"),
        // dusk/morning/overcast are DAY to the engine — the trap that made the editor offer
        // maps a night bucket could never draw.
        mk("mortain_warfare_dusk", "Mortain (Dusk)", "warfare", "dusk", "mortain"),
        mk("mortain_skirmish_overcast", "Mortain Skirmish (Overcast)", "skirmish", "overcast", "mortain"),
        mk("elsenbornridge_warfare_morning", "Elsenborn Ridge (Morning)", "warfare", "morning", "elsenbornridge"),
        mk("omahabeach_offensive_us", "Omaha Beach Off. US", "offensive", "day", "omahabeach"),
        mk("hill400_warfare", "Hill 400", "warfare", "day", "hill400"),
        mk("tobruk_skirmish_day", "Tobruk Skirmish", "skirmish", "day", "tobruk"),
      ];
      return { maps, rotation: [maps[0], maps[6], maps[8]], current: maps[0], currentIndex: 0 };
    })(),
    // Map-set coverage, in the shape the real route returns: exact regions over time AND player
    // count. A test that overrides mapvote/config gets this generic answer, which is enough for
    // "the section renders and does not take the page with it"; tests that care about the numbers
    // override it themselves.
    "/api/servers/s1/mapvote/coverage": {
      timezone: "UTC", hasGaps: true, calendarOnly: [],
      groups: [{
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        bands: [
          { minPlayers: 0, maxPlayers: 40, spans: [{ startMinute: 0, endMinute: 1440, profile: "seeding" }] },
          { minPlayers: 40, maxPlayers: null, spans: [
            { startMinute: 0, endMinute: 1080, profile: null },
            { startMinute: 1080, endMinute: 1440, profile: "prime time" },
          ] },
        ],
      }],
    },
    "/api/community/announcements/nudge-config": { config: { enabled: false, channelId: "", afterHours: 48 } },
    // The real shape: every piece and feature reported, all off (no Discord env vars in a test).
    // The catch-all `{}` below is not a stand-in for this — a response missing `features` is what
    // used to take the whole page down, so the fixture states the contract.
    "/api/discord/setup": {
      pieces: { botToken: false, appId: false, publicKey: false, clientId: false, clientSecret: false, guildId: false, redirectUri: false },
      values: { guildId: null, redirectUri: null, clientId: null },
      features: { relay: false, interactions: false, signIn: false, roleSync: false, commandRegistration: false },
    },
    "/api/discord/role-map": { mappings: [], oauthConfigured: false },
    "/api/discord/roles": { roles: [], botConfigured: false },
    "/api/community/announcements/analytics": { staffCount: 0, postedCount: 0, overallReadRate: null, overallAvgMinutesToSee: null, notices: [] },
    // Server health, shaped so the score half of the page has something to draw: four buckets whose
    // mix MOVES across the days (a flat trend would let a broken chart look right), and squad-leader
    // time that is present but not on every day.
    "/api/analytics/server": (() => {
      const daily = Array.from({ length: 5 }, (_, i) => ({
        date: `2026-06-0${i + 1}`, rounds: 3 + i, players: 60 + i * 4,
        // Combat falls and defense climbs over the window — the point of the trend chart.
        combat: 50_000 - i * 6_000, offense: 12_000, defense: 8_000 + i * 4_000, support: 9_000,
        slSeconds: i === 2 ? 0 : 7_200 + i * 1_800, vehicleKills: 40 + i * 3,
      }));
      const sum = (k) => daily.reduce((a, d) => a + d[k], 0);
      // Players online through a day on a busy server: seeded over the morning, full all evening,
      // emptying after midnight. The last day is the busiest, its evening the window's peak.
      const evening = [70, 52, 34, 18, 9, 6, 6, 9, 16, 26, 40, 54, 64, 70, 76, 80, 86, 91, 95, 97, 98, 97, 94, 86];
      return {
        window: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" },
        scores: {
          daily,
          totals: {
            rounds: sum("rounds"), players: 214,
            combat: sum("combat"), offense: sum("offense"), defense: sum("defense"), support: sum("support"),
            slSeconds: sum("slSeconds"), vehicleKills: sum("vehicleKills"), ledShare: 0.18,
          },
        },
        activity: {
          byHour: Array.from({ length: 24 }, (_, h) => (h >= 18 ? 40 : 8)),
          byDow: [30, 12, 14, 16, 18, 40, 44], weekHour: Array.from({ length: 7 }, () => Array(24).fill(3)),
          daily: daily.map((d) => ({ date: d.date, sessions: 120, players: d.players, seconds: 900_000 })),
          sessions: 600, uniquePlayers: 214, totalSeconds: 4_500_000,
          medianSec: 3_600, p90Sec: 9_000, shortSessions: 42, shortCutoffSec: 300,
          earlyLeaversByMap: [{ map: "KHARKOV", sessions: 200, short: 30 }],
        },
        concurrency: {
          peak: 98, peakAt: "2026-06-05T20:00:00.000Z", average: 61.4,
          weekHour: Array.from({ length: 7 }, () => Array(24).fill(50)),
          dayHour: daily.map((d, i) => ({ date: d.date, hours: evening.map((n) => Math.round(n * (0.92 + i * 0.02))) })),
          daily: daily.map((d) => ({ date: d.date, peak: 90, average: 60 })),
          sampleSec: 1_800, openAtEnd: 12,
        },
        mix: { newPlayers: 80, returningPlayers: 134, newPlayersWhoCameBack: 26 },
        balance: {
          rounds: 19, decided: 17, alliesWins: 9, axisWins: 8, alliesWinRate: 0.529,
          avgDurationSec: 3_900, medianDurationSec: 4_100, avgMargin: 1.8, blowoutRate: 0.24,
        },
      };
    })(),
    // Roster composition with enough shape to exercise every panel on the page: two sides, more
    // roles than the chart tracks individually (so the "Other" fold runs), several days of trend,
    // and a map above the ranking threshold.
    "/api/analytics/composition": {
      window: { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" },
      samples: 1440, sampleSec: 1800,
      firstAt: "2026-06-01T00:00:00.000Z", lastAt: "2026-06-30T23:30:00.000Z",
      avgPlayers: 61.4, peakPlayers: 98,
      bySide: [{ sideId: "allies", avgPlayers: 31.2, share: 0.508 }, { sideId: "axis", avgPlayers: 30.2, share: 0.492 }],
      byRole: [
        { role: 0, avgPlayers: 22.1, share: 0.36 }, { role: 1, avgPlayers: 9.4, share: 0.153 },
        { role: 2, avgPlayers: 7.7, share: 0.125 }, { role: 3, avgPlayers: 6.1, share: 0.099 },
        { role: 4, avgPlayers: 5.2, share: 0.085 }, { role: 5, avgPlayers: 4.4, share: 0.072 },
        { role: 6, avgPlayers: 3.1, share: 0.05 }, { role: 9, avgPlayers: 3.4, share: 0.056 },
      ],
      noSl: { squadSamples: 1180, avgSquads: 1.4, sampleShare: 0.62 },
      daily: Array.from({ length: 6 }, (_, i) => ({
        date: `2026-06-0${i + 1}`, samples: 48, avgPlayers: 55 + i, noSlAvg: 1.8 - i * 0.2,
        roleShare: { 0: 0.36, 1: 0.15, 2: 0.13, 3: 0.1, 4: 0.08, 5: 0.07, 6: 0.05, 9: 0.06 },
      })),
      byMap: [
        { map: "ST MARIE DU MONT", samples: 620, avgPlayers: 72.4, noSlAvg: 1.2 },
        { map: "KHARKOV", samples: 410, avgPlayers: 55.1, noSlAvg: 1.9 },
        { map: "CARENTAN", samples: 4, avgPlayers: 12, noSlAvg: 0.5 },
      ],
      roles: { 0: "Rifleman", 1: "Assault", 2: "Automatic rifleman", 3: "Medic", 4: "Support", 5: "Machine gunner", 6: "Anti-tank", 9: "Officer" },
      sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
      squadLabel: "squad",
    },
    // The real route's shape: id + label + the game's protocols (the Add Server form's protocol
    // dropdown follows the selected game). Both registered games, so the form's game selection is
    // exercised by default rather than only when a test remembers to override.
    "/api/games": { games: [
      { id: "hll", label: "Hell Let Loose", protocols: [{ id: "binary-v2", label: "binary-v2 (current HLL)" }, { id: "legacy-text", label: "legacy-text (older HLL)" }, { id: "crcon-bridge", label: "crcon-bridge (read via existing CRCON)" }] },
      { id: "hllv", label: "Hell Let Loose: Vietnam", protocols: [{ id: "binary-v2", label: "binary-v2 (official Vietnam RCON)" }, { id: "legacy-text", label: "legacy-text (external RconClient)" }] },
    ] },
    // A finished round WITH the objective layout staff set. `m2` below is the same round without
    // one — the pair is the point, because "no layout" has to read as "nobody set one" rather
    // than as a broken panel.
    "/api/matches/m1": {
      match: {
        id: "m1", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
        startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:40:00.000Z",
        winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)",
        sectorLayout: ["Road To Luxembourg", "Bois Jacques", "Foy", "Flak Battery", "Cognac Farm"],
        sectorLayoutBy: "tester", sectorLayoutAt: "2026-07-01T10:01:00.000Z",
      },
      stats: [],
    },
    "/api/matches/m2": {
      match: {
        id: "m2", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
        startedAt: "2026-07-01T11:00:00.000Z", endedAt: "2026-07-01T11:40:00.000Z",
        winner: "axis", alliedScore: 0, axisScore: 5, result: "AXIS (0 - 5)",
        sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
      },
      stats: [],
    },
  };
}

/** The descriptor `useGame()` reads. Faithful to the real HLL one in the parts the panel draws
 *  from: two sides with their colours, squad-leader roles, and the v2 score buckets. It used to be
 *  an empty husk, which quietly turned every faction-coloured element neutral under test. */
export const HLL_DESCRIPTOR = {
  id: "hll", label: "HLL",
  // Roles and leader roles copied from the real descriptor, ids and all. They used to be an empty
  // map and a made-up `squadLeaderRoles: [1]`, which meant the tests agreed with a fiction: role 1
  // is Assault, the officer is 9, and the flag they were exercising could not have been the one
  // that ships. Two behaviours read this now — a squad is leaderless only if nobody holds a leader
  // role, and only if every role in it is one the descriptor can name.
  roles: {
    0: "Rifleman", 1: "Assault", 2: "Automatic Rifleman", 3: "Medic", 4: "Spotter",
    5: "Support", 6: "Machinegunner", 7: "Anti-Tank", 8: "Engineer", 9: "Officer",
    10: "Sniper", 11: "Crewman", 12: "Tank Commander", 13: "Commander",
    14: "Artillery Observer", 15: "Operator", 16: "Gunner",
  },
  sides: [
    { id: "allies", label: "Allies", color: "blue", teamValues: [0], parity: "even" },
    { id: "axis", label: "Axis", color: "red", teamValues: [1], parity: "odd" },
  ],
  scoreFields: [], squadLeaderRoles: [4, 9, 12, 14], configFields: [],
};
