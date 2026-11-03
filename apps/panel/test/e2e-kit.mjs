// The browser tests' shared kit: the harness, the fixtures and the helpers every e2e-*.test.mjs
// file draws on. Split out of one file so the tests can run as several files side by side.
import { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub } from "./stub-api.mjs";


export const here = dirname(fileURLToPath(import.meta.url));
export const OUT = join(here, "..", "out");
export const CHROMIUM = [process.env.CHROMIUM, "/opt/pw-browsers/chromium", process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium")]
  .filter(Boolean)
  .find((p) => existsSync(p));
export const SKIP = !CHROMIUM ? "no Chromium binary (set CHROMIUM=/path/to/chromium)" : !existsSync(OUT) ? "panel not built (out/ missing)" : false;

/*
 * One browser for the whole file, and a fresh context for each test: a context is a browser
 * profile of its own (storage, cookies, cache, permissions, service workers), so every test still
 * starts clean. A browser launched and closed per test cost each run minutes of startup. Tests
 * started with other arguments get a browser of their kind, shared the same way, and a browser
 * that has gone away is started again rather than failing every test after it.
 */
export const browsers = new Map();
export async function sharedBrowser(args) {
  const key = args.join(" ");
  const kept = browsers.get(key);
  if (kept && (await kept).isConnected()) return kept;
  const { chromium } = await import("playwright-core");
  const started = chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", ...args] });
  browsers.set(key, started);
  return started;
}
after(async () => { for (const b of browsers.values()) await (await b).close().catch(() => {}); });

export async function withPage(stubOpts, fn) {
  const { viewport, browserArgs = [], ...stubRest } = stubOpts;
  const stub = await startStub(stubRest);
  const browser = await sharedBrowser(browserArgs);
  // Whatever the test opened goes with it: its page's context, and any it opened besides.
  const before = new Set(browser.contexts());
  try {
    const page = await browser.newPage(viewport ? { viewport, isMobile: true, hasTouch: true } : {});
    // pre-authenticate: the panel keeps its bearer token in localStorage
    await page.addInitScript(() => window.localStorage.setItem("panel.token", "test-token"));
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(stub.base, { waitUntil: "networkidle" });
    await fn(page, { stub, errors });
  } finally {
    await Promise.all(browser.contexts().filter((c) => !before.has(c)).map((c) => c.close().catch(() => {})));
    await stub.close();
  }
}

/**
 * Fixtures for the map-vote screen: a server pairing two LIBRARY sets with library schedules.
 * `profileLinks` is what the server stores; `profiles` is the same thing already resolved, and
 * `sets`/`schedules` are the shared library the two dropdowns are drawn from.
 */
export const MAPVOTE_FIXTURES = {
  "/api/servers/s1/mapvote/config": { body: {
    enabled: true, surface: "native", channelId: "500000000000000001", pollHours: 2, timezone: "America/New_York",
    reminders: [{ minutesAfterMatchStart: 10, message: "Vote on Discord! {options}" }],
    profileLinks: [
      { mapSet: "default", schedule: "Daytime" },
      { mapSet: "seeding", schedule: "Seeding" },
    ],
    profiles: [
      { name: "default", spec: { start: "07:00", end: "00:00" }, pool: { dayCount: 3, nightCount: 1, wildcardCount: 3, excludePlayedMaps: 4, blacklistMaps: ["kursk_warfare_night"] } },
      { name: "seeding", spec: { playersBelow: 50 }, pool: { dayCount: 5, nightCount: 0, wildcardCount: 0, blacklistMaps: [] } },
    ],
    sets: [
      { id: "ms1", name: "default", pool: { dayCount: 3, nightCount: 1, wildcardCount: 3, excludePlayedMaps: 4, blacklistMaps: ["kursk_warfare_night"] }, usedBy: ["Test"] },
      { id: "ms2", name: "seeding", pool: { dayCount: 5, nightCount: 0, wildcardCount: 0, blacklistMaps: [] }, usedBy: ["Test"] },
    ],
    schedules: [
      { id: "vs1", name: "Daytime", spec: { start: "07:00", end: "00:00" }, usedBy: ["Test"] },
      { id: "vs2", name: "Seeding", spec: { playersBelow: 50 }, usedBy: ["Test"] },
    ],
    activeProfile: "default",
    state: { paused: false, overrideMapId: null, activePoll: null },
  } },
  "/api/servers/s1/maps": { body: {
    current: { id: "carentan_warfare", prettyName: "Carentan", gameMode: "Warfare", environment: "day", family: "carentan" },
    currentIndex: 0, rotation: [], maps: [
      { id: "carentan_warfare", prettyName: "Carentan", gameMode: "Warfare", environment: "day", family: "carentan" },
      { id: "kursk_warfare_night", prettyName: "Kursk (Night)", gameMode: "Warfare", environment: "night", family: "kursk" },
    ],
  } },
};

/** Open the vote setup, expand a library half, and pick the record named. */
export async function openLibrary(page, section, recordName) {
  const base = page.url().split("#")[0];
  await page.goto(`${base}#/maps/votesetup`, { waitUntil: "networkidle" });
  await page.waitForSelector(".panel", { timeout: 15000 });
  await page.locator("button", { hasText: section }).first().click();
  // By its own label, not by content: the pairing rows above carry selects listing the same names.
  await page.locator(`select[aria-label="${section}"]`).selectOption({ label: recordName });
}

/** Build a map-vote config fixture in whichever state the test needs. */
export function mapvoteFixture({ paused = false, activePoll = true, override = null, enabled = true } = {}) {
  const options = [
    { id: "foy_warfare_night", name: "Foy (Night)", votes: 14 },
    { id: "carentan_warfare", name: "Carentan", votes: 9 },
    { id: "kharkov_warfare", name: "Kharkov", votes: 5 },
  ];
  return { body: {
    enabled, surface: "native", channelId: "500000000000000001", pollHours: 2,
    liveApply: true, postMatchApplyDelaySeconds: 300, pollResetDelaySeconds: 180, pauseBelowPlayers: 1,
    timezone: "America/New_York", activeProfile: "friday", reminders: [],
    profiles: [{ name: "friday", spec: { daysOfWeek: ["fri"] }, pool: { dayCount: 0, nightCount: 6, wildcardCount: 0 } }],
    state: {
      paused, pauseReason: paused ? "manual" : null, overrideMapId: override,
      skipNext: false, reroll: false, startNow: false, resyncNow: false,
      sendMessageLayout: null, savedOptions: paused ? options.map((o) => ({ id: o.id, name: o.name })) : [],
      liveAppliedMapId: activePoll ? "foy_warfare_night" : null, reopenAt: null,
      activePoll: activePoll
        ? { options, profile: "friday", openedAt: new Date(Date.now() - 6e5).toISOString(), totalVotes: 28, talliedAt: new Date().toISOString() }
        : null,
    },
  } };
}

/** Read every control on the vote tab as label → enabled. */
export async function voteButtons(page) {
  return page.evaluate(() => {
    const panel = [...window.document.querySelectorAll(".panel")].find((p) => /Map vote/.test(p.textContent || ""));
    const out = {};
    for (const b of panel?.querySelectorAll(".panel-body button") ?? []) {
      const label = (b.textContent || "").trim();
      if (label && label !== "Refresh") out[label] = !b.disabled;
    }
    return out;
  });
}

/*
 * The map set editor is MODE-first: the three categories are the game modes, each saying how many
 * maps it wants from each actual time of day. The version this replaces had three fixed buckets
 * (day / night / wildcard) with the mode buried inside as a filter, which could not say "one dusk
 * map" at all — dusk, morning, overcast and rain were all just "day".
 */
export const MODE_CFG = (pool) => ({
  enabled: true, surface: "native", channelId: "500000000000000001", pollHours: 2,
  liveApply: true, postMatchApplyDelaySeconds: 300, pollResetDelaySeconds: 180,
  pauseBelowPlayers: 0, startupState: "remember", timezone: "UTC", activeProfile: "default", reminders: [],
  defaultPool: { dayCount: 3, nightCount: 1, wildcardCount: 3, battleModes: ["warfare"], wildcardModes: ["offensive"] },
  profileLinks: [{ mapSet: "default", schedule: null }],
  profiles: [{ name: "default", spec: {}, pool }],
  sets: [{ id: "ms1", name: "default", pool, usedBy: ["Test"] }],
  schedules: [],
  state: null,
});

/*
 * The roster sampler has been recording the game's own score buckets — combat, offense, defense,
 * support — plus squad-leader time and time in each role, every sixty seconds, since the panel
 * first watched a server. None of it was reachable: the leaderboard offered four columns from the
 * kill log, the profile judged a player entirely on kills and deaths, and the scoreboard of a round
 * showed the same. Anyone who holds points, builds garrisons, drives supply or leads a squad looked
 * identical to someone who did nothing.
 */
export const SCORE_ROWS = [
  { playerId: "p1", name: "Fragger", kills: 900, deaths: 300, teamkills: 4, kd: 3, combat: 400, offense: 50, defense: 40, support: 20, slSeconds: 0, playtime: 36000 },
  { playerId: "p2", name: "Anchor", kills: 120, deaths: 200, teamkills: 0, kd: 0.6, combat: 90, offense: 60, defense: 980, support: 300, slSeconds: 7200, playtime: 54000 },
  { playerId: "p3", name: "Quartermaster", kills: 40, deaths: 90, teamkills: 1, kd: 0.44, combat: 30, offense: 10, defense: 120, support: 1500, slSeconds: 18000, playtime: 72000 },
];

/** Drawn in front of whatever the viewer is looking at: inside a screen `height` tall, and the
 *  thing actually at its centre — nothing covers it. */
export async function inFront(loc, height) {
  const box = await loc.boundingBox();
  assert.ok(box, "the dialog is drawn");
  assert.ok(box.y >= 0 && box.y + box.height <= height, `the dialog sits within the screen (y ${box.y}, height ${box.height})`);
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(window.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
}

/** Two servers of one game, and the values every field of `.content` holds right now. */
export const TWO_OF_ONE_GAME = [{ id: "s1", name: "One", game: "hll", engagementMode: "active" }, { id: "s2", name: "Two", game: "hll", engagementMode: "active" }];
export const fieldValues = (page) => page.locator(".content input, .content textarea").evaluateAll((els) => els.map((el) => el.value));

/*
 * The Seeding tab did the same: the last server's seeding settings stayed, editable, after another
 * server was picked, until the new server's came in.
 */
/** The Seeding tab's settings for one server, as the API answers them. */
export const seedingReply = (seedTarget, delayMs = 0) => ({ delayMs, body: {
    config: {
      enabled: true, dryRun: true, seedTarget, minPlayers: 5,
      disallowedRoles: [], disallowedWeaponClasses: [], disallowedWeapons: [], disallowedWeaponNames: [], disallowedCommanderAbilities: [],
      capFightEnabled: false, capFightMaxCaps: 3, capFightSkipWarning: false, capFightNotice: "",
      containEnabled: false, containGraceSec: 60, containMaxPlayers: 60, containNotice: "", containZones: {},
      paceEnabled: false, paceUnlockMinutes: [0, 0, 20, 40, 60], paceNotice: "",
      immuneLevel: 0, immuneTags: [], announceMessage: "", maxWarnings: 2, warnIntervalSec: 60, warnMessage: "w",
      maxPunishes: 2, punishIntervalSec: 60, punishMessage: "p", kickAfter: true, kickMessage: "k",
      rewardEnabled: false, rewardHours: 0, rewardPoints: 0, rewardLinkedNote: "", rewardUnlinkedNote: "",
      minSeedMinutes: 15, rewardCumulative: true, rewardMessage: "r", rewardDelaySec: 0, phaseConfirmSec: 0, phaseHysteresis: 0,
    },
    roles: {}, weaponClasses: [], weapons: [], commanderAbilities: [], containMaps: [], announcePreview: "", configured: true,
} });

/*
 * Migration 156 carved the chat filter and the zone sets off the rules permission, the seed reward
 * off seeding, and the Discord bot's setup and online access off user & role admin. Each opens its
 * own tab or panel, and the permission it was carved from no longer does.
 */
export const held = (capability, level = "write", scopeId = null) => ({ capability, scopeType: scopeId ? "server" : "global", scopeId, level });
export const hubTabs = async (page) => {
  await page.locator(".hub-tabs [role='tab']").first().waitFor({ timeout: 10_000 });
  return (await page.locator(".hub-tabs [role='tab']").allTextContents()).map((t) => t.trim());
};
/** A hub with one tab to show draws no tab strip: it opens on that tab, and offers no other. */
export const onlyTab = async (page, path) => {
  await page.waitForURL((u) => u.hash === path, { timeout: 10_000 });
  await page.locator(".hub-tabs").first().waitFor({ state: "attached", timeout: 10_000 });
  assert.equal(await page.locator(".hub-tabs [role='tab']").count(), 0, `${path} is the only tab`);
};
export const panelTitles = async (page) => (await page.locator(".panel-title").allTextContents()).map((t) => t.trim());
export const panelTitled = (page, title) => page.locator(".panel-title").filter({ hasText: new RegExp(`^${title}$`) });

/*
 * Granting a role is "which servers does this cover" — plural.
 *
 * The first cut of this control was a single <select>: every server, or exactly one. That reads
 * fine with two servers and cannot express the normal case at three — "the @Mods role covers
 * Warfare and Offensive but not the training server". The store always allowed it (an assignment
 * is one row per scope), so this was a control narrower than the data behind it.
 */

/** A role-map endpoint that remembers what was PUT, so the panel's reload sees its own save. */
export async function stubRoleMap(page, initial = []) {
  const state = { mappings: [...initial], puts: [] };
  await page.route("**/api/discord/role-map**", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData() ?? "{}");
      state.puts.push(body);
      const drId = decodeURIComponent(new URL(req.url()).pathname.split("/").pop());
      state.mappings = (body.roles ?? []).map((a) => ({
        discordRoleId: drId, discordRoleName: body.discordRoleName ?? null,
        roleId: a.roleId, scopeId: a.scopeId ?? null,
      }));
    }
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ mappings: state.mappings, oauthConfigured: true }),
    });
  });
  return state;
}

export const THREE_SERVERS = { body: { servers: [
  { id: "s1", name: "Warfare", game: "hll", engagementMode: "observe" },
  { id: "s2", name: "Offensive", game: "hll", engagementMode: "observe" },
  { id: "s3", name: "Training", game: "hll", engagementMode: "observe" },
] } };
export const ONE_PANEL_ROLE = { body: { roles: [{ id: "r-mod", name: "Moderator" }] } };
export const ONE_GUILD_ROLE = { body: { roles: [{ id: "d-mods", name: "Mods", color: 0 }], botConfigured: true } };

/**
 * Console admin — the game's own admin list, including admin camera — from the player's ⋯ menu.
 *
 * The grant system, the expiry sweep and a whole Console admins screen existed, and none of them
 * could give ONE player admin cam: the only route in was to build a player group, add them, and run
 * a bulk action. This drives the menu item and reads what goes over the wire, and it holds the
 * scoping too — the item is gated on server.admins for the server in hand, not on being staff.
 */
export const ACTIVE_S1 = { "/api/servers": { body: { servers: [{ id: "s1", name: "Test Server #1", game: "hll", engagementMode: "active" }] } } };

/**
 * Banning across servers, from the panel.
 *
 * A ban lives in one game server's ban list, so "barred from the community" used to mean doing it
 * once per server — and lifting it meant remembering to do the reverse everywhere, which is how a
 * player ends up quietly still banned on the one nobody clicked. The ban and unban modals now
 * carry a server picker; this drives it and reads what actually goes over the wire.
 */
export const TWO_SERVERS = {
  "/api/servers": { body: { servers: [
    { id: "s1", name: "The [LYNX] Division #1 | MIC'S MANDATORY!!", game: "hll", engagementMode: "active" },
    { id: "s2", name: "The [LYNX] Division #2 | MIC'S MANDATORY!!", game: "hll", engagementMode: "active" },
  ] } },
  "/api/servers/s1/live": { body: {
    players: [{ id: "p1", playerId: "76561198000000001", playerDbId: "db-1", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 } }],
    session: { playerCount: 1, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 0, remainingMatchTime: 100, matchTime: 10 },
  } },
};

/**
 * The three from the staff feedback round: a team-kill flag, a text-size setting, and the
 * two-team split view.
 */
export const TK_ROSTER = {
  ...TWO_SERVERS,
  "/api/servers/s1/live": { body: {
    players: [
      // Over the flag threshold, and the squad's Officer (role 9 — the real wire value, same as
      // production), so his squad is NOT missing a leader.
      { id: "p1", playerId: "76561198000000001", playerDbId: "db-1", name: "Griefer", team: 1, unit: "ABLE", platoon: "ABLE", role: 9, level: 40, side: "allies", stats: { infantryKills: 4, vehicleKills: 0, deaths: 2, teamKills: 7 } },
      // Under it: two team kills in a round is a satchel gone wrong, not a pattern.
      { id: "p2", playerId: "76561198000000002", playerDbId: "db-2", name: "Clumsy", team: 1, unit: "ABLE", platoon: "ABLE", role: 0, level: 10, side: "allies", stats: { infantryKills: 9, vehicleKills: 0, deaths: 3, teamKills: 2 } },
      // The other side, in a squad with no officer in it.
      { id: "p3", playerId: "76561198000000003", playerDbId: "db-3", name: "Jerry", team: 0, unit: "BAKER", platoon: "BAKER", role: 0, level: 55, side: "axis", stats: { infantryKills: 12, vehicleKills: 1, deaths: 4, teamKills: 0 } },
    ],
    session: { playerCount: 3, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 2, axisPlayerCount: 1, remainingMatchTime: 100, matchTime: 600 },
  } },
};

/*
 * Pull to refresh.
 *
 * A gesture is the one thing that cannot be reasoned about from the source: whether it fires, and
 * more importantly whether it fires when it MUST NOT, only shows up under a real finger on a real
 * scroller. So these drive CDP touch events against the built bundle, and three of the four are
 * about the gesture staying out of the way.
 *
 * Refetching is observed through the stub's request log — the point of the feature is that the data
 * is asked for again, not that a spinner appeared.
 */
/** Drive a touch drag, optionally pausing at the bottom of it so the mid-gesture state can be read. */
export async function touchDrag(page, x, fromY, toY, { atFullPull } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 12;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps }] });
    await page.waitForTimeout(8);
  }
  // The finger is still down here. Anything that only exists DURING the gesture has to be read now
  // — against a local stub the refetch can finish before a check placed after the release.
  if (atFullPull) await atFullPull();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

export const PHONE = { width: 402, height: 874 };
/** How many times the API has been asked for anything, as a stand-in for "did it re-fetch". */
export const apiCalls = (stub) => stub.requests.length;

/*
 * Nothing important sits off the right-hand edge of a phone.
 *
 * The shell is `overflow-x: clip`, which is the right choice — a panel that scrolls sideways as a
 * whole feels broken — but it also means content wider than the screen is not scrolled to, it is
 * simply GONE. A table's last two columns, a row of buttons, a wide chart: cut off with no
 * scrollbar to hint that anything is missing.
 *
 * The house answer is a `.scroll-x` wrapper, which gives the thing its own horizontal scroller.
 * Every table in the app had one except four screens added in one sitting, and the omission is
 * invisible on the desktop it was written on — the columns simply fit. So this is a scan rather
 * than a habit: at 390px, walk every destination and fail on anything whose right edge is past the
 * viewport without a scrollable ancestor to reach it by.
 */
/** Elements clipped off the right edge with no scrollable ancestor — i.e. unreachable. */
export function overflowingElements() {
  const bad = [];
  const limit = window.innerWidth + 2; // sub-pixel rounding
  for (const el of window.document.querySelectorAll("main *, .app-shell > *")) {
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= limit) continue;
    // Reachable if anything between here and the root scrolls horizontally.
    let p = el.parentElement;
    let reachable = false;
    while (p) {
      const ov = window.getComputedStyle(p).overflowX;
      if (ov === "auto" || ov === "scroll") { reachable = true; break; }
      p = p.parentElement;
    }
    if (reachable) continue;
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).join(".")
      : "";
    bad.push(el.tagName.toLowerCase() + cls + " reaches " + Math.round(r.right) + "px");
  }
  return [...new Set(bad)];
}

/*
 * Rows, not empty states.
 *
 * The screens most likely to overflow are the ones with a wide TABLE, and a table with no rows is
 * an EmptyState — which fits any screen. Without fixtures this scan walked eighteen screens full of
 * "nothing here yet" and proved nothing; removing a `.scroll-x` wrapper left it green. So the two
 * widest new tables are given realistic content: long names, real timestamps, a full summary
 * sentence — the things that actually push a column past the edge.
 */
export const WIDE_ROWS = {
  "/api/payout-events": { body: { total: 2, offset: 0, limit: 25, items: [
    { id: "ev1", name: "Friday Night Community Event — Warfare", serverId: "s1", status: "closed",
      serverName: "The [LYNX] Division #1 | MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED, LVL 100+ COMMANDER ENFORCED", payment: null,
      openMode: "match_start_after", openAnchor: "2026-08-15T19:00:00.000Z", openedAt: "2026-08-15T19:12:00.000Z",
      closeMode: "match_end_after", closeAnchor: "2026-08-15T23:00:00.000Z", closedAt: "2026-08-15T23:41:00.000Z",
      minMinutes: 30, mapVoteProfile: "Event maps (curated)", roster: [{ playerId: "p1", name: "Someone", minutes: 120 }],
      createdBy: "owner", createdAt: "2026-08-10T10:00:00.000Z" },
    { id: "ev2", name: "Sunday Seed", serverId: "s1", status: "scheduled",
      serverName: "Seed", payment: null,
      openMode: "at", openAnchor: "2026-08-24T18:00:00.000Z", openedAt: null,
      closeMode: "at", closeAnchor: "2026-08-24T22:00:00.000Z", closedAt: null,
      minMinutes: 0, mapVoteProfile: null, roster: null, createdBy: "owner", createdAt: "2026-08-20T10:00:00.000Z" },
  ] } },
  "/api/audit": { body: { total: 2, offset: 0, limit: 50, anchor: "2026-08-22T00:00:00.000Z", entries: [
    { id: "a1", ts: "2026-08-21T22:14:00.000Z", actorUserId: "u1", actorName: "LongStaffNameHere",
      actorDisplayName: "LongStaffNameHere", action: "player.kick", targetType: "player", targetId: "76561198000000001",
      targetName: "A Player With A Fairly Long Name", targetDisplayName: "A Player With A Fairly Long Name",
      targetPlatformId: "76561198000000001", serverId: "s1",
      summary: "ran kick on A Player With A Fairly Long Name — team killing repeatedly after warnings" },
    { id: "a2", ts: "2026-08-21T21:02:00.000Z", actorUserId: null, actorName: "auto settings",
      action: "autosettings.kick", targetType: "player", targetId: "76561198000000002",
      targetName: "Another Player", serverId: "s1", summary: "kick Another Player — no commander for 10 minutes" },
  ] } },
};

/**
 * Panel titles that have been squeezed to an ellipsis.
 *
 * Title and subtitle sit on one flex row and are both ellipsised. Neither declared a basis, so both
 * shrank in proportion to their content — and a long subtitle beside a short title took the row,
 * leaving "K…" and "Mes…" where the panel's name should be. The subtitle is the half that can be
 * cut; the title is the word telling you what you are looking at.
 */
export function clippedPanelTitles() {
  const bad = [];
  for (const el of window.document.querySelectorAll(".panel-title")) {
    // scrollWidth past clientWidth is the browser saying "this text does not fit".
    if (el.scrollWidth > el.clientWidth + 1) bad.push((el.textContent || "").trim().slice(0, 30));
  }
  return bad;
}

/* Where a control's right edge sits, so a phone-width test can say what fell off the screen. */
export const rightEdge = async (loc) => { const b = await loc.boundingBox(); return b ? Math.round(b.x + b.width) : null; };

/* The stats site's own fixture: one published server. */
export const PUB_ALPHA = {
  slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
  sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
  scoreFields: [], squadLabel: "Squad",
};

/*
 * A player's round has a chart for each score the game keeps, behind a switch over the kills chart.
 * The tabs wear the scoreboard's own column labels, and each draws that score's total through the
 * round. A player with no kill or death opens on the score they made most of. A player with no
 * recorded scores (any round played before the recorder existed) gets the kills chart alone.
 */
export const SCORE_FIELDS = [
  { key: "cOMBAT", label: "Cbt", title: "Combat score" }, { key: "offense", label: "Off", title: "Offense score" },
  { key: "defense", label: "Def", title: "Defense score" }, { key: "support", label: "Sup", title: "Support score" },
];

/*
 * Every public screen has an APIs button at its top right: the public endpoints the screen is built
 * from, each with its full link and what it answers now, for streamers wiring an overlay. The list
 * is kept in step with the screens here: each screen's own requests are recorded, and every one of
 * them has to be on its list.
 */
export const APIS_SERVER = {
  slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: true,
  sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
  scoreFields: SCORE_FIELDS, squadLabel: "Squad",
};
export const APIS_OVERRIDES = {
  "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [APIS_SERVER] } },
  "/api/public/alpha/player/76561198000000001": { status: 404, body: { error: "not found" } },
};
/** A request the stats page makes for data: its own /api/public routes and the CRCON commands. */
export const dataPath = (url) => {
  const u = new URL(url);
  return u.pathname.startsWith("/api/public/") || /^\/stats\/[^/]+\/api\//.test(u.pathname) ? u.pathname + u.search : null;
};

/*
 * A press that writes something must write it once. These buttons sent their request on every
 * press with nothing to say one was already on its way, so a double-click (or a second press while
 * a slow reply was coming) wrote twice: a points adjustment applied twice, a server action sent
 * twice, a notice, a rule section or a library map set made twice. Each write here answers slowly
 * on purpose; a guarded button stays disabled from the first press until it does.
 */
export const SLOW_WRITE_MS = 1500;
export const writesTo = (stub, method, path) => stub.calls.filter((c) => c.method === method && c.path === path).length;

/*
 * A screen that stays mounted while what it shows changes (another player opened from inside a
 * profile, another server picked in the switcher) must not keep anything of the last one: not its
 * data, not its error, and not a slow answer that lands after the new one's. On the settings
 * screens that last one was the dangerous case: the server you left painted its settings under the
 * new server's name, and Save wrote them there. Each test races a slow answer against a fast one.
 */
export const STALE_MS = 1500;
export const threeServers = (extra = {}) => ({
  "/api/servers": { body: { servers: [
    { id: "s1", name: "Landing", game: "hll", engagementMode: "active" },
    { id: "s2", name: "Slow", game: "hll", engagementMode: "active" },
    { id: "s3", name: "Current", game: "hll", engagementMode: "active" },
  ] } },
  ...extra,
});
export const PICKER = 'select[aria-label="Active server"]';
export async function leaveSlowServer(page, landed) {
  await page.waitForFunction((t) => window.document.body.innerText.includes(t), landed, { timeout: 15_000 });
  await page.selectOption(PICKER, "s2");
  await page.selectOption(PICKER, "s3");
}

/*
 * Plugin pages. A plugin's page is not in the panel's bundle: the API lists the pages this viewer
 * may open, and sends a page's code only to them. The shell then draws the page in place, with the
 * panel's own React and kit — so its hooks, the navigation and the stylesheet work as in a
 * built-in screen. To anyone the API did not list it to, the page's address is an address with
 * nothing at it, and its code is never even asked for.
 */
export const DEMO_PAGE = {
  plugin: "demo", id: "demo-page", title: "Demo Page", section: "Monitor", blurb: "A page a plugin adds.",
  permission: "demo.view", outright: true, ownerOnly: false,
};
/** The page's module: the panel's React and kit off the global, a hook, a kit component, an API call. */
export const DEMO_SCRIPT = [
  "const k = globalThis.__hellrconPageKit;",
  "const h = k.React.createElement;",
  "export default function DemoPage() {",
  "  const [on, setOn] = k.React.useState(false);",
  "  const [said, setSaid] = k.React.useState('');",
  "  const nav = k.nav.useAppNav();",
  "  k.React.useEffect(() => { k.api('/plugins/demo/hello').then((r) => setSaid(r.text)); }, []);",
  "  return h('div', { className: 'card demo-card' },",
  "    h('h2', null, 'Demo heading'),",
  "    h('p', { className: 'demo-said' }, said),",
  "    h('p', { className: 'demo-view' }, 'on view ' + nav.view),",
  "    h(k.ui.Toggle, { checked: on, onChange: setOn, label: on ? 'Flipped' : 'Not flipped' }));",
  "}",
].join("\n");
export const DEMO_OVERRIDES = {
  "/api/plugin-pages": { body: { pages: [DEMO_PAGE] } },
  "/api/plugin-pages/demo/demo-page": { body: { script: DEMO_SCRIPT, style: ".demo-card { outline: 3px solid rgb(1, 2, 3); }" } },
  "/api/plugins/demo/hello": { body: { text: "hello from the plugin" } },
};

/*
 * Phone notifications, the browser's half (Settings → Phone notifications, lib/push.ts). The
 * browser's push service is a stand-in here — a real one is a Google or Apple server — but the
 * permission prompt, the subscription the panel hands over and what it sends are the panel's own.
 * Default off: nothing is asked and nothing is sent until the switch is tapped.
 */
export const PUSH_KEY = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => i + 1)]).toString("base64url");
export const fakePush = () => {
  const state = { permission: "default", sub: null, asked: 0, unsubscribed: 0 };
  window.__push = state;
  Object.defineProperty(window.Notification, "permission", { get: () => state.permission, configurable: true });
  window.Notification.requestPermission = async () => { state.asked += 1; state.permission = "granted"; return "granted"; };
  window.PushManager.prototype.getSubscription = async function () { return state.sub; };
  // A subscription left from an earlier visit lives on a worker registered then.
  const registered = navigator.serviceWorker.getRegistration.bind(navigator.serviceWorker);
  navigator.serviceWorker.getRegistration = async (scope) => (await registered(scope)) ?? (state.sub ? { pushManager: { getSubscription: async () => state.sub } } : undefined);
  window.PushManager.prototype.subscribe = async function (opts) {
    const key = new Uint8Array(opts.applicationServerKey);
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
    state.sub = {
      endpoint, options: { applicationServerKey: key.buffer },
      toJSON: () => ({ endpoint, keys: { p256dh: "BPUB", auth: "AUTH" } }),
      unsubscribe: async () => { state.sub = null; state.unsubscribed += 1; return true; },
    };
    state.key = Array.from(key);
    return state.sub;
  };
};
