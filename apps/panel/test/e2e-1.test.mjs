// Browser smoke tests for the panel: the REAL built bundle (out/) served over a stubbed API,
// driven by Chromium. Self-skipping where the environment can't run them:
//   - needs a Chromium binary (CHROMIUM env var, or the standard Playwright cache path)
//   - needs the panel built (pnpm --filter @app/panel build)
// so `pnpm -w test` stays green on machines without a browser while CI/dev boxes with one get
// real coverage.
//
// Part 1 of 3: the tests are spread over several files so they run side by side; the
// shared harness and helpers live in ./e2e-kit.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { OWNER_GRANTS, HLL_DESCRIPTOR } from "./stub-api.mjs";
import { unzipStored } from "./unzip.mjs";
import { toXlsx } from "../lib/download.ts";
import { WHATS_NEW } from "../lib/whatsNew.ts";
import { lockedNow, walkCheckKey } from "../lib/walkNotice.ts";
import { WALKTHROUGHS, walkthroughsFor } from "../lib/walkthroughs.ts";
import { WALK_FIXTURES } from "./walk-stage.mjs";
import { ROUTES } from "../lib/routes.ts";
import { CAPABILITY_CATALOG } from "../../../packages/access/src/capabilities.ts";
import { DIALOGS, MENUS, REVEALS, KNOWN_GAPS, SUBJECT_PAGES, act, coverageOf, overlayOpen, unansweredReads, namedForDownload, recordGaps, dialogChoices, dialogOpen, menuItems, namedForDialog, pickScreenOption, press, pressChoice, pressItem, pressScreenChoice, ringed, screenChoices, screenCrashed, screenLists, stepsOn, uncovered, unfold } from "./coverage-kit.mjs";
import { SKIP, withPage, MAPVOTE_FIXTURES, openLibrary, MODE_CFG, inFront, held, hubTabs, panelTitled, ACTIVE_S1, TWO_SERVERS, TK_ROSTER, touchDrag, PHONE, apiCalls, rightEdge, PUB_ALPHA, SCORE_FIELDS, APIS_OVERRIDES, STALE_MS, threeServers, PICKER, leaveSlowServer, PUSH_KEY, fakePush } from "./e2e-kit.mjs";

test("boot smoke: owner sees the dashboard, full nav, no page errors", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    assert.equal(await page.locator(".nav-item", { hasText: "Dashboard" }).count(), 1);
    for (const item of ["Live", "Players", "Maps", "Auto settings", "Administration"]) {
      assert.ok((await page.locator(".nav-item", { hasText: item }).count()) >= 1, `nav shows ${item}`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The duplicate-call budget for the first screen. An audit found three components independently
 * fetching /api/servers on one dashboard mount — the shared ServerProvider, the AttentionStrip's
 * own copy, and the dash-servers widget block — three requests for one answer, every load, from
 * every open panel. The strip now reads the provider; the two that remain are the provider (the
 * canonical copy every screen shares) and the generic widget block (its own machinery, declared
 * refresh cadence). A third copy is what this asserts against: if this fails, some component
 * grew its own fetch of a list the provider already holds — point it at useServers() instead.
 */
test("initial load fetches the server list at most twice (provider + widget block)", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { stub }) => {
    await page.waitForSelector(".attention, .attention.ok", { timeout: 5000 }).catch(() => {});
    const serverGets = stub.calls.filter((c) => c.method === "GET" && c.path === "/api/servers").length;
    assert.ok(serverGets >= 1, "the provider must fetch the list at least once");
    assert.ok(serverGets <= 2, `initial load made ${serverGets} GET /api/servers calls — a component grew its own copy of the shared list`);
  });
});

/*
 * Tab cannot leave an open modal.
 *
 * aria-modal tells assistive tech the background is inert, but the TAB key doesn't read aria:
 * without a trap it walks straight out into the covered page, and a keyboard user ends up
 * operating controls they cannot see behind the backdrop.
 */
test("a modal traps Tab inside itself", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/live": { body: { players: [{ id: "p1", playerId: "76561198000000001", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 }, scoreData: { combat: 1, offense: 0, defense: 0, support: 0 } }], session: { playerCount: 1, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 0, remainingMatchTime: 100, matchTime: 10 } } },
    },
  }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 10000 });
    await page.locator(".player-actions .pa-menu button").first().click();
    await page.locator(".pa-mi", { hasText: "Switch team" }).first().click();
    await page.waitForSelector(".confirm-modal");

    // More presses than the dialog has controls, in both directions: every landing stays inside.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i < 6 ? "Tab" : "Shift+Tab");
      const inside = await page.evaluate(() => {
        const dialog = window.document.querySelector(".pa-modal");
        return Boolean(dialog && dialog.contains(window.document.activeElement));
      });
      assert.equal(inside, true, `press ${i + 1} kept focus inside the dialog`);
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector(".confirm-modal", { state: "detached" });
  });
});

test("map vote: unpicked days read as OFF, and say what that means", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: MAPVOTE_FIXTURES }, async (page) => {
    // A schedule is a library record now, so the day picker is inside the schedule editor rather
    // than welded to whichever map set happens to be selected.
    await openLibrary(page, "Manage schedules", "Daytime");
    await page.waitForSelector(".daypick-btn", { timeout: 15000 });

    // the schedule picks no days — every button must be off, not merely unstyled
    const pressed = await page.locator('.daypick-btn[aria-pressed="true"]').count();
    assert.equal(pressed, 0, "no day is selected");
    assert.equal(await page.locator(".daypick-btn").count(), 7);
    const setup = page.locator(".panel", { hasText: "Vote setup" }).first();
    assert.match((await setup.textContent()) ?? "", /applies every day/i);

    // picking one flips it on and updates the explanation
    await page.locator(".daypick-btn", { hasText: "FRI" }).click();
    assert.equal(await page.locator('.daypick-btn[aria-pressed="true"]').count(), 1);
    assert.match((await setup.textContent()) ?? "", /1 highlighted day/i);
  });
});

/*
 * The app's OWN back/forward — lib/trail.ts + the TrailNav buttons in the sidebar. The browser
 * pair already works (asserted above); this pair exists because the panel jumps around and on a
 * phone/PWA the browser's buttons are somewhere else entirely. Real clicks on the real buttons,
 * because the unit tests own the semantics and this owns the wiring: router → trail → buttons.
 */
test("the in-app back/forward buttons walk the last screens", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.waitForFunction(() => window.location.hash.startsWith("#/"));
    const back = page.locator(".sidebar .trail-btn").first();
    const fwd = page.locator(".sidebar .trail-btn").nth(1);
    // The hash flips synchronously on a click, but the buttons re-render one React commit later
    // (hashchange → state → effect → trail). Every state assertion therefore POLLS the DOM it is
    // asserting rather than sampling it in that gap — the gap is real app behaviour, not a bug.
    const buttons = (b, f) => page.waitForFunction(
      ([wantBack, wantFwd]) => {
        const [bb, ff] = window.document.querySelectorAll(".sidebar .trail-btn");
        return bb && ff && bb.disabled === !wantBack && ff.disabled === !wantFwd;
      },
      [b, f],
    );

    // Fresh session: nowhere to go in either direction, and the buttons say so.
    await buttons(false, false);

    // Walk three screens, then come back along the trail.
    await page.goto(`${page.url().split("#")[0]}#/players/vips`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/players/vips");
    await page.goto(`${page.url().split("#")[0]}#/maps/rotation`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/maps/rotation");

    await buttons(true, false);
    assert.match(await back.getAttribute("title"), /Back to VIPs/, "the tooltip names the destination");
    await back.click();
    await page.waitForFunction(() => window.location.hash === "#/players/vips");
    await buttons(true, true);
    await back.click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/dashboard"));
    await buttons(false, true); // the start of the trail — only forward remains

    // Forward retraces the same steps…
    await fwd.click();
    await page.waitForFunction(() => window.location.hash === "#/players/vips");
    await buttons(true, true);

    // …until a new destination is chosen, which drops the forward half.
    await page.goto(`${page.url().split("#")[0]}#/moderation/bans`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/moderation/bans");
    await buttons(true, false); // choosing a different future forgets the old one
    assert.match(await back.getAttribute("title"), /Back to VIPs/);

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Staying signed in. While the panel is in use, /me hands back a renewed sign-in when the current
 * one is running down, and the panel keeps it without disturbing anything — setToken clears the
 * back/forward trail, right for a sign-in as someone else, never for a renewal; the trail outlives
 * a refresh, so boot must not clear it either. A live stream opened on a sign-in that has since run
 * out is refused, the browser gives up on it for good, and it is opened again on the renewed one.
 */
test("a sign-in renewed while the panel is in use is kept without losing your place, and a refused live stream reopens on it", { skip: SKIP }, async () => {
  let renewal = "renewed-1";
  const me = () => ({ body: { user: { id: "u1", username: "tester", displayName: "tester", discordNick: null, role: "owner" }, grants: OWNER_GRANTS, limits: {}, roles: [], session: { token: renewal } } });
  // A refused token stands for a sign-in that has run out since a stream was opened on it.
  const refused = new Set(["renewed-1"]);
  const streamTokens = [];
  const stream = (url) => {
    const token = url.searchParams.get("token");
    streamTokens.push(token);
    return refused.has(token) ? { status: 401, body: { error: { message: "sign in again" } } } : undefined;
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": me, "/api/events/stream": stream } }, async (page, { errors }) => {
    const signedInAs = (token) => page.waitForFunction((t) => window.localStorage.getItem("panel.token") === t, token);
    const renewTo = async (token) => {
      renewal = token;
      await page.evaluate(() => window.document.dispatchEvent(new window.Event("visibilitychange")));
      await signedInAs(token);
    };
    const backTo = (title) => page.waitForFunction((t) => {
      const back = window.document.querySelector(".sidebar .trail-btn");
      return back && !back.disabled && back.title.includes(t);
    }, title);
    const status = (text) => page.waitForFunction((t) => window.document.querySelector(".live-status")?.textContent === t, text);
    // The stub sees stream requests the page cannot be asked about, so wait on them directly.
    const streamedOn = async (token) => {
      for (let i = 0; i < 100 && !streamTokens.includes(token); i++) await page.waitForTimeout(100);
      assert.ok(streamTokens.includes(token), `a stream opened on ${token}, got ${JSON.stringify([...new Set(streamTokens)])}`);
    };

    await signedInAs("renewed-1"); // kept at boot
    // Read per retry, so the live document's value is enough (only the hash changes below).
    await page.evaluate(() => { window.__STREAM_RETRY_MS__ = 100; });
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/players/vips");
    await page.goto(`${base}#/live`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.location.hash === "#/live");
    await status("reconnecting…");
    await streamedOn("renewed-1");

    // The minute-by-minute check renews it: kept, the trail untouched, the stream back on it.
    await renewTo("renewed-2");
    await status("● live");
    await streamedOn("renewed-2");
    await backTo("Back to VIPs");

    // The game log's live tail reopens the same way.
    refused.add("renewed-2");
    await page.goto(`${base}#/history/logs`, { waitUntil: "domcontentloaded" });
    const tailed = streamTokens.length;
    await page.locator("label.toggle", { hasText: "Live" }).click();
    for (let i = 0; i < 100 && streamTokens.length <= tailed; i++) await page.waitForTimeout(100);
    assert.equal(streamTokens[tailed], "renewed-2", "the tail was opened on the sign-in it had");
    await renewTo("renewed-3");
    await streamedOn("renewed-3");

    // A refresh boots again, renewal and all, and the trail it kept (per tab) still holds the
    // screens walked before it.
    renewal = "renewed-4";
    await page.reload({ waitUntil: "domcontentloaded" });
    await signedInAs("renewed-4");
    await page.waitForFunction(() => window.location.hash === "#/history/logs");
    const kept = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("panel.trail") ?? "{}").entries ?? []);
    assert.ok(kept.includes("/players/vips"), `the trail survived the refresh, got ${JSON.stringify(kept)}`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Search finds players too: someone reported in Discord is looked up from anywhere, by name or by
 * game id, through the directory's own search. An answer for an earlier text, still on its way
 * when the next letter is typed, is never shown under the newer text; a refused search reads as no
 * matches rather than searching forever; an account that may not see the directory never asks.
 */
test("search finds players by name or game id and opens the profile", { skip: SKIP }, async () => {
  const caereca = { id: "p1", name: "Caereca", platform: "steam", platformId: "76561198000000001", lastSeen: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  const cassidy = { id: "p2", name: "Cassidy", platform: "epic", platformId: "a1b2c3", lastSeen: null };
  const gunplay = { id: "p3", name: "Gunplay", platform: "epic", platformId: "deadbeef00112233", lastSeen: null };
  const asked = [];
  const players = (url) => {
    const q = url.searchParams.get("q");
    if (q === null) return undefined; // the directory itself, unchanged
    asked.push(q);
    if (q === "ca") return { delayMs: 1_500, body: { players: [cassidy], total: 1 } }; // outrun below
    if (q === "caer" || q === caereca.platformId) return { body: { players: [caereca], total: 1 } };
    if (q === "deadbe") return { delayMs: 600, body: { players: [gunplay], total: 1 } };
    if (q === "~~~~") return { delayMs: 600, status: 403, body: { error: { message: "no" } } };
    return { body: { players: [], total: 0 } };
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/players": players } }, async (page, { errors }) => {
    const item = (name) => page.locator(".cmdk-group", { hasText: "Players" }).locator(".cmdk-item", { hasText: name });
    await page.keyboard.press("Control+k");
    const input = page.locator(".cmdk input");
    await input.waitFor();
    assert.match(await input.getAttribute("placeholder"), /players/);

    // "ca" goes out and is slow; "caer" overtakes it. Only Caereca is ever listed.
    await input.fill("ca");
    for (let i = 0; i < 50 && !asked.includes("ca"); i++) await page.waitForTimeout(50);
    await input.fill("caer");
    await item("Caereca").waitFor();
    assert.match(await item("Caereca").innerText(), /Steam \(PC\) · seen 2 h ago/);
    await page.waitForTimeout(1_700); // the slow answer has landed by now
    assert.equal(await item("Cassidy").count(), 0, "the earlier text's answer is not shown");
    assert.equal(await item("Caereca").count(), 1);

    // A game id finds its player, though the name holds none of it — on top, even where an Epic
    // id's letters happen to spell their way loosely through dozens of screens' descriptions.
    await input.fill(caereca.platformId);
    await item("Caereca").waitFor();
    // The screens are listed first; arrowed down to one, the players arriving above it take the
    // highlight back to the top, so Enter never runs a row that moved under it.
    await input.fill("deadbe");
    await page.locator(".cmdk-item").nth(2).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await item("Gunplay").waitFor();
    assert.ok(await page.locator(".cmdk-group").count() > 1, "screens match these letters too");
    assert.equal(await page.locator(".cmdk-group-label").first().textContent(), "Players");
    assert.match(await page.locator(".cmdk-item.active").innerText(), /Gunplay/);

    // A refused search: no matches, not "Searching…" for ever (no screen can match these) — and
    // while it is out, nothing found for the text before.
    await input.fill("~~~~");
    assert.equal(await item("Gunplay").count(), 0, "the last text's players went with it");
    assert.equal(await page.locator(".cmdk-empty").textContent(), "Searching…");
    await page.waitForFunction(() => window.document.querySelector(".cmdk-empty")?.textContent === "No matches.");

    // Opened as the directory opens one: the profile, and a place on the recent list.
    await input.fill("caer");
    await item("Caereca").waitFor();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /p1/.test(window.location.hash));
    // The list is the signed-in account's own (lib/recent), under its name.
    const recent = await page.evaluate(() => JSON.parse(window.localStorage.getItem(`panel.recent.${window.localStorage.getItem("panel.username")}`) ?? "[]"));
    assert.ok(recent.some((r) => r.target?.playerId === "p1" && r.label === "Caereca"), JSON.stringify(recent));
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // May not see the directory: the palette never asks.
  const viewerAsked = [];
  await withPage({
    grants: [{ capability: "vip.grant", scopeType: "global", scopeId: null, level: "write" }],
    overrides: { "/api/players": (url) => { if (url.searchParams.get("q") !== null) viewerAsked.push(url.searchParams.get("q")); return undefined; } },
  }, async (page) => {
    await page.keyboard.press("Control+k");
    const input = page.locator(".cmdk input");
    await input.waitFor();
    assert.doesNotMatch(await input.getAttribute("placeholder"), /players/);
    await input.fill("caer");
    await page.waitForTimeout(600);
    assert.deepEqual(viewerAsked, []);
  });
});

/*
 * On a phone, a found player's hint (platform, last seen: what tells two like names apart) stays on
 * the row however long the name. A 32-character name with no spaces held its column open and
 * pushed the hint out past the edge, where nobody could see it.
 */
test("Search keeps a long-named player's hint on screen on a phone", { skip: SKIP }, async () => {
  const LONG = "XxX_WolfpackCommanderEliteXx_XxX";
  const found = { players: [{ id: "p1", name: LONG, platform: "steam", platformId: "76561198000000001", lastSeen: null }], total: 1 };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: {
    "/api/players": (url) => (url.searchParams.get("q") === null ? undefined : { body: found }),
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });
    await page.locator(".quick-btn", { hasText: "Search" }).click();
    await page.locator(".cmdk input").fill("Xx");
    const row = page.locator(".cmdk-item", { hasText: LONG });
    await row.waitFor({ timeout: 10_000 });
    const edge = await page.evaluate(() => window.document.documentElement.clientWidth);
    for (const part of [".cmdk-title", ".cmdk-hint"]) {
      const right = await row.locator(part).evaluate((el) => el.getBoundingClientRect().right);
      assert.ok(right <= edge, `${part} ends inside the screen: ${Math.round(right)} of ${edge}px`);
    }
    assert.match(await row.locator(".cmdk-hint").innerText(), /Steam \(PC\)/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A player's windows are titled with their name ("Edit VIP · <name>"). On a 360px phone a
 * 32-character name with no spaces lost its last letters at the window's edge - the one place that
 * says whose VIP is being changed.
 */
test("a player's window shows a long name whole on a phone", { skip: SKIP }, async () => {
  const LONG = "XxX_WolfpackCommanderEliteXx_XxX";
  const at = "2026-10-01T20:00:00.000Z";
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: {
    "/api/players/p1": { body: {
      player: { id: "p1", name: LONG, platform: "steam", platformId: "76561198000000001", firstSeen: at, lastSeen: at },
      stats: { kills: 1, deaths: 1, teamkills: 0 }, flags: { watchlist: false, vip: false, updatedByName: null },
      canViewNotes: true, notes: [], statsByServer: [], sessions: [], recentEvents: [],
    } },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/~p1`, { waitUntil: "networkidle" });
    await page.locator("button.pa-more").click();
    await page.locator(".pa-dropdown .pa-mi", { hasText: "Edit VIP" }).click();
    const title = page.locator(".pa-modal h3", { hasText: LONG });
    await title.waitFor({ timeout: 10_000 });
    const fit = await title.evaluate((el) => {
      const box = el.closest(".pa-modal").getBoundingClientRect();
      return { right: el.getBoundingClientRect().right, inner: box.right - parseFloat(window.getComputedStyle(el.closest(".pa-modal")).paddingRight), wide: el.scrollWidth, shown: el.clientWidth };
    });
    assert.ok(fit.right <= fit.inner + 0.5 && fit.wide <= fit.shown, `the title fits its window: ends at ${Math.round(fit.right)} of ${Math.round(fit.inner)}px, ${fit.wide}px in ${fit.shown}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/**
 * A Vietnam server must be read in Vietnam's words.
 *
 * The Live header showed "Allies 2 · 50" beside a US star and a German Balkenkreuz over a Quảng
 * Ngãi round: the side LABELS were hardcoded WW2 wording in half the panel, and the faction
 * emblems — Hell Let Loose's own WW2 artwork — were emitted for any map at all. The side IDS stay
 * `allies`/`axis` (they are the cross-game vocabulary the database is written in); only what a
 * human reads follows the game, and nothing may show HLL's emblems for a game that isn't HLL.
 */
test("a Vietnam server reads as US/NVA, with no WW2 emblems", { skip: SKIP }, async () => {
  const HLLV_DESCRIPTOR = {
    id: "hllv", label: "Hell Let Loose: Vietnam",
    roles: { 0: "Rifleman", 9: "Squad Leader", 16: "Pilot", 17: "Logistics Officer" },
    sides: [
      { id: "allies", label: "US", color: "blue", teamValues: [1], parity: "odd" },
      { id: "axis", label: "NVA", color: "red", teamValues: [2], parity: "even" },
    ],
    squadLabel: "Platoon", scoreFields: [], squadLeaderRoles: [4, 9, 12, 14, 17], configFields: [],
  };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [{ id: "s1", name: "LYNX Vietnam", game: "hllv", engagementMode: "observe" }] } },
      "/api/games/hllv/descriptor": { body: { descriptor: HLLV_DESCRIPTOR } },
      "/api/servers/s1/live": { body: {
        players: [],
        session: { alliedScore: 2, axisScore: 3, alliedPlayerCount: 50, axisPlayerCount: 50, remainingMatchTime: 993, mapName: "QUẢNG NGÃI", gameMode: "Conquest" },
      } },
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /US|NVA/.test(window.document.body.innerText), null, { timeout: 15_000 });

    const body = await page.locator("body").innerText();
    assert.match(body, /\bUS\b/, "the header names the US, the game's own word for this side");
    assert.match(body, /\bNVA\b/, "…and the NVA");
    assert.ok(!/\bAllies\b/.test(body), "no WW2 side wording on a Vietnam round");
    assert.ok(!/\bAxis\b/.test(body), "no WW2 side wording on a Vietnam round");

    // Vietnam ships its own emblems now, so the round wears US and NVA — and the invariant that
    // matters is not "no emblems" but "never the OTHER war's": every src must come from this
    // game's own folder, so a Balkenkreuz can never reach a Quảng Ngãi round.
    const emblems = page.locator("img.faction-emblem");
    assert.equal(await emblems.count(), 2, "both sides wear their own emblem");
    const srcs = await emblems.evaluateAll((els) => els.map((e) => e.getAttribute("src") || ""));
    assert.ok(srcs.every((u) => u.includes("/game/hllv/teams/")), `Vietnam art only, got ${srcs.join(", ")}`);
    assert.ok(srcs.some((u) => /\/us(_|\.)/.test(u)), "the US emblem");
    assert.ok(srcs.some((u) => /\/nva(_|\.)/.test(u)), "the NVA emblem");
    assert.ok(!srcs.some((u) => u.includes("/game/hll/")), "and nothing from the WW2 set");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("an HLL server keeps its own emblems and wording", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/live": { body: {
        players: [],
        session: { alliedScore: 2, axisScore: 3, alliedPlayerCount: 50, axisPlayerCount: 50, remainingMatchTime: 993, mapName: "CARENTAN", gameMode: "Warfare" },
      } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Allies/.test(window.document.body.innerText), null, { timeout: 15_000 });
    const body = await page.locator("body").innerText();
    assert.match(body, /Allies/);
    assert.match(body, /Axis/);
    assert.ok((await page.locator("img.faction-emblem").count()) > 0, "HLL still gets its emblems");
  });
});

/*
 * Three more places named the sides in WW2 words whatever the game: the event report's Winner
 * column, and the "Paint as" brushes of both painters on Map zones (the zone sets' and the
 * seeding areas'). Each is about one game — the event's own server's, the zone sets', the seeding
 * server's — and must say US and NVA for Vietnam, even with an HLL server selected.
 */
test("the event report and both zone painters say US and NVA for Vietnam", { skip: SKIP }, async () => {
  const HLLV_DESCRIPTOR = {
    id: "hllv", label: "Hell Let Loose: Vietnam", roles: {},
    sides: [
      { id: "allies", label: "US", color: "blue", teamValues: [1], parity: "odd" },
      { id: "axis", label: "NVA", color: "red", teamValues: [2], parity: "even" },
    ],
    squadLabel: "Platoon", scoreFields: [], squadLeaderRoles: [], configFields: [],
  };
  const at = "2026-10-01T20:00:00.000Z";
  const event = { id: "ev1", name: "Jungle Night", serverId: "s2", status: "closed", openMode: "at", openAnchor: at, closeMode: "at", closeAnchor: at, minMinutes: 0, mapVoteProfile: null, rotationSetId: null, createdBy: "owner" };
  const round = (id, winner) => ({ id, seq: 1, map: "Quảng Trị", startedAt: at, endedAt: at, winner, alliedScore: 3, axisScore: 2, durationSec: 3600 });
  // Each painter's brushes, in the words written (the badges are drawn in capitals).
  const paintRows = (page, within = page) => within.locator(".row", { has: page.locator("span.muted", { hasText: /^Paint as$/ }) });
  const brushes = async (row) => (await row.locator("button.chip-btn").allTextContents()).map((t) => t.trim());

  // An HLL server selected, the event on the Vietnam one, and Vietnam's zone sets picked.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
        { id: "s2", name: "NAM #1", game: "hllv", engagementMode: "active" },
      ] } },
      "/api/games/hllv/descriptor": { body: { descriptor: HLLV_DESCRIPTOR } },
      "/api/payout-events": { body: { items: [event] } },
      "/api/payout-events/ev1/report": { body: { event, report: {
        window: { from: at, to: at, live: false }, top: [],
        attendance: { players: 0, totalMinutes: 0, medianMinutes: 0, peakConcurrent: null, fromRoster: false, list: [] },
        rounds: [round("r1", "allies"), round("r2", "axis")],
      } } },
      "/api/zones": (url) => ({ body: url.searchParams.get("game") === "hllv"
        ? { sets: [{ id: "z1", name: "Hill 937", game: "hllv", zones: { vantuong: { allies: ["A1"], axis: ["J10"], shared: [] } }, usedBy: [], updatedAt: at }], maps: [{ key: "vantuong", label: "Van Tuong" }] }
        : { sets: [], maps: [] } }),
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/events/report`, { waitUntil: "networkidle" });
    const winners = page.locator("table.data tbody tr td:nth-child(5)");
    await page.waitForFunction(() => /\bNVA\b/i.test(window.document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
    assert.deepEqual((await winners.allTextContents()).map((t) => t.trim()), ["US", "NVA"], "a Vietnam event's winners in Vietnam's words");

    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.locator("select", { has: page.locator('option[value="hllv"]') }).first().selectOption("hllv");
    await page.locator('.chips button:has-text("Hill 937")').click();
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    await page.waitForFunction(() => /\bNVA\b/i.test(window.document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
    const sets = page.locator(".panel", { hasText: 'Painting "Hill 937"' });
    assert.deepEqual(await brushes(paintRows(page, sets)), ["US", "NVA", "Both teams"], "the zone sets' brushes");
    assert.equal(await sets.locator(".zone-grid .zg").first().getAttribute("title"), "A1 — US", "and a painted square says whose it is");
    // Below it, the selected HLL server's own seeding areas keep HLL's words.
    assert.equal(await paintRows(page).count(), 2, "the zone sets' painter, then the seeding areas'");
    assert.deepEqual(await brushes(paintRows(page).last()), ["Allies", "Axis", "Both teams"], "an HLL server's seeding areas");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // A Vietnam server selected: its seeding areas' painter.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [{ id: "s1", name: "NAM #1", game: "hllv", engagementMode: "active" }] } },
      "/api/games/hllv/descriptor": { body: { descriptor: HLLV_DESCRIPTOR } },
      "/api/zones": { body: { sets: [], maps: [] } },
      "/api/servers/s1/seeding": { body: {
        config: { enabled: true, containEnabled: true, containZones: { vantuong: { allies: ["A1"], axis: [], shared: [] } } },
        containMaps: [{ key: "vantuong", label: "Van Tuong" }],
      } },
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    await page.waitForFunction(() => /\bNVA\b/i.test(window.document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
    assert.equal(await page.locator(".zone-grid").count(), 1, "no zone set is open: this is the seeding areas' painter");
    assert.deepEqual(await brushes(paintRows(page)), ["US", "NVA", "Both teams"], "the seeding areas' brushes");
    assert.equal(await page.locator(".zone-grid .zg").first().getAttribute("title"), "A1 — US");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Analytics and Auto settings are about the selected server, and spoke WW2 on a Vietnam one:
 * "Allied win rate", "Axis wins", "62% allied over 7 rounds", and profile conditions "Allied
 * players are below". They follow the server's game now, as Live does.
 */
test("analytics and auto settings name the sides in the selected server's game", { skip: SKIP }, async () => {
  const HLLV_DESCRIPTOR = {
    id: "hllv", label: "Hell Let Loose: Vietnam", roles: {},
    sides: [
      { id: "allies", label: "US", color: "blue", teamValues: [1], parity: "odd" },
      { id: "axis", label: "NVA", color: "red", teamValues: [2], parity: "even" },
    ],
    squadLabel: "Platoon", scoreFields: [], squadLeaderRoles: [], configFields: [],
  };
  const map = (name, rounds, alliesWins, axisWins) => ({ map: name, rounds, alliesWins, axisWins, alliesWinRate: alliesWins / (alliesWins + axisWins), avgMargin: 1.5, blowoutRate: 0.1, avgDurationSec: 3_600 });
  const MATCH = {
    window: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" },
    rounds: 12, decided: 11, alliesWins: 6, axisWins: 5, alliesWinRate: 6 / 11,
    avgDurationSec: 3_600, medianDurationSec: 3_500, avgMargin: 1.4, blowoutRate: 0.1,
    byMap: [map("Quảng Trị", 7, 5, 2), map("Huế", 5, 1, 3)],
    byHour: Array(24).fill(1), weekHour: Array.from({ length: 7 }, () => Array(24).fill(0)),
    timeline: [{ date: "2026-06-01", rounds: 6, alliesWins: 3, axisWins: 3 }, { date: "2026-06-02", rounds: 6, alliesWins: 3, axisWins: 2 }],
  };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [{ id: "s1", name: "NAM #1", game: "hllv", engagementMode: "active" }] } },
      "/api/games/hllv/descriptor": { body: { descriptor: HLLV_DESCRIPTOR } },
      "/api/analytics/match": { body: MATCH },
      "/api/servers/s1/autosettings": { body: { config: { enabled: true, dryRun: true, timezone: "UTC", profiles: [
        { name: "Lopsided", spec: { alliedBelow: 20, axisAbove: 30 }, settings: {} },
      ] }, fields: [] } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const words = async () => page.locator("body").innerText();
    const settled = () => page.waitForFunction(() => /\bNVA\b/i.test(window.document.body.innerText), null, { timeout: 15_000 }).catch(() => {});

    await page.goto(`${base}#/analytics/match`, { waitUntil: "networkidle" });
    await settled();
    let text = await words();
    for (const want of [/US win rate/i, /US wins/i, /NVA wins/i, /71% US over 7 rounds/i]) assert.match(text, want);
    assert.ok(!/allied|\baxis\b/i.test(text), `no WW2 side wording on Vietnam's match analytics: ${text.match(/.{0,40}(allied|\baxis\b).{0,40}/i)?.[0]}`);

    await page.goto(`${base}#/analytics/server`, { waitUntil: "networkidle" });
    await settled();
    text = await words();
    for (const want of [/US win rate/i, /US wins/i, /NVA wins/i]) assert.match(text, want);
    assert.ok(!/allied|\baxis\b/i.test(text), `no WW2 side wording on Vietnam's server analytics: ${text.match(/.{0,40}(allied|\baxis\b).{0,40}/i)?.[0]}`);

    await page.goto(`${base}#/autosettings`, { waitUntil: "networkidle" });
    await page.waitForSelector(".setting-card .sentence-row .field-label", { timeout: 15_000 });
    await settled();
    const rows = (await page.locator(".setting-card .sentence-row .field-label").allTextContents()).map((t) => t.trim());
    assert.ok(rows.includes("US players are below") && rows.includes("NVA players are above"), `the profile's own conditions: ${rows.join(" | ")}`);
    const offered = (await page.locator('select:has(option:text-is("+ When…")) option').allTextContents()).map((t) => t.trim());
    assert.ok(offered.includes("US players are above…") && offered.includes("NVA players are below…"), `the conditions it can add: ${offered.join(" | ")}`);
    assert.ok(!offered.some((o) => /allied|\baxis\b/i.test(o)), "none in WW2 words");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a slow response never paints over a newer one", { skip: SKIP }, async () => {
  // The bug this guards: pick a server, pick a different one before the first list arrives, and
  // the first response lands second and paints the wrong server's data — with nothing on screen
  // to say the two don't match. useResource discards a response whose request has been outrun.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "Slow Server", host: "h", port: 1, protocol: "binary-v2", engagementMode: "active" },
        { id: "s2", name: "Fast Server", host: "h", port: 2, protocol: "binary-v2", engagementMode: "active" },
      ] } },
      "/api/servers/s1/vips": { delayMs: 1500, body: { vips: [{ playerId: "p-slow", playerName: "STALE-ENTRY", serverId: "s1", expiration: null, comment: "", createdByName: "x", createdAt: "2026-01-01T00:00:00Z" }] } },
      "/api/servers/s2/vips": { body: { vips: [{ playerId: "p-fast", playerName: "CURRENT-ENTRY", serverId: "s2", expiration: null, comment: "", createdByName: "x", createdAt: "2026-01-01T00:00:00Z" }] } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/players/vips`, { waitUntil: "domcontentloaded" });
    // s1 is selected first, so its slow request is already in flight; switch before it lands.
    await page.waitForSelector('select[aria-label="Active server"]');
    await page.selectOption('select[aria-label="Active server"]', "s2");
    await page.waitForFunction(() => window.document.body.innerText.includes("CURRENT-ENTRY"), null, { timeout: 10_000 });
    // Outlast the slow response, then confirm it was thrown away rather than painted.
    await page.waitForTimeout(2500);
    const body = await page.locator("body").innerText();
    assert.ok(body.includes("CURRENT-ENTRY"), "the server actually selected is the one shown");
    assert.ok(!body.includes("STALE-ENTRY"), "the outrun response for the previous server was discarded");
  });
});

/*
 * The phone's quick bar: Live, Players, Bans, Search and More one tap away, along the bottom unless
 * the person picks the top in Settings — saved on their account, so their other phone follows. Each
 * screen only for those who may open it; on a desktop there is no bar at all.
 */
test("on a phone the quick bar keeps the main screens one tap away, at the bottom or the top as each person picks", { skip: SKIP }, async () => {
  const phone = { width: 390, height: 844 };
  await withPage({ grants: OWNER_GRANTS, viewport: phone }, async (page, { stub, errors }) => {
    const bar = page.locator(".quick-bar");
    const button = (label) => bar.getByRole("button", { name: label, exact: true });
    const edge = () => bar.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
    await bar.waitFor();
    assert.equal((await edge()).bottom, phone.height, "along the bottom, out of the box");
    assert.deepEqual(await bar.locator(".quick-btn").allTextContents(), ["Live", "Players", "Bans", "⌕Search", "☰More"]);
    // The page ends above it, so its last row is never underneath.
    const pad = await page.locator(".content").evaluate((el) => parseFloat(window.getComputedStyle(el).paddingBottom));
    assert.ok(pad >= 56, `the page keeps room for the bar, got ${pad}px`);

    await button("Bans").tap();
    await page.waitForFunction(() => window.location.hash === "#/moderation/bans");
    assert.equal(await button("Bans").getAttribute("aria-current"), "page");
    await button("Search").tap();
    await page.locator(".cmdk input").waitFor();
    await page.keyboard.press("Escape");
    await button("More").tap();
    await page.waitForSelector(".app-shell.drawer-open");
    await page.locator(".scrim").tap({ position: { x: 370, y: 400 } });

    // Moved to the top in Settings: at once, pinned while the page scrolls, and kept on the account.
    await page.goto(`${page.url().split("#")[0]}#/settings`, { waitUntil: "networkidle" });
    const card = page.locator(".setting-card, .card", { hasText: "Quick bar on phones" }).last();
    await card.getByRole("button", { name: "Top", exact: true }).tap();
    await page.waitForFunction(() => window.document.documentElement.getAttribute("data-phone-bar") === "top");
    assert.equal((await edge()).top, 0);
    await page.evaluate(() => window.scrollBy(0, 600));
    assert.equal((await edge()).top, 0, "still in view down the page");
    const saved = stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/me/prefs").map((c) => c.body);
    assert.ok(saved.some((b) => b?.phoneBar === "top"), JSON.stringify(saved));
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // The account's choice reaches a phone that has never been set up; Bans only for those who may open it.
  const me = { body: { user: { id: "u2", username: "viewer", displayName: "viewer" }, limits: {}, roles: [], prefs: { phoneBar: "top" },
    grants: [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }] } };
  await withPage({ grants: [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }], viewport: phone, overrides: { "/api/me": me } }, async (page) => {
    const bar = page.locator(".quick-bar");
    await bar.waitFor();
    await page.waitForFunction(() => window.document.documentElement.getAttribute("data-phone-bar") === "top");
    assert.deepEqual(await bar.locator(".quick-btn").allTextContents(), ["Live", "Players", "⌕Search", "☰More"]);
  });

  // A desktop has the sidebar; no bar.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.waitForSelector(".sidebar .nav-item");
    assert.equal(await page.locator(".quick-bar").count(), 0);
  });
});

/*
 * Each person's quick bar holds the screens they use most, not one set for everyone: they pick its
 * buttons in Settings (any screen or tab they can open, and Search), in their order, up to four, and
 * More always follows. Or they turn the bar off. Saved on the account, so their other phone
 * follows; a screen the account cannot open is never on its bar.
 */
test("each person picks the quick bar's buttons, or turns it off", { skip: SKIP }, async () => {
  const phone = { width: 390, height: 844 };
  await withPage({ grants: OWNER_GRANTS, viewport: phone }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    const bar = page.locator(".quick-bar");
    const labels = () => bar.locator(".quick-btn").allTextContents();
    await bar.waitFor();
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    const card = page.locator(".setting-card", { hasText: "Quick bar buttons" });
    await card.locator(".field-label").first().waitFor({ timeout: 10_000 });
    assert.deepEqual((await card.locator(".field-label").allTextContents()).map((t) => t.trim()), ["Live", "Players", "Moderation › Bans", "Search"], "the usual four, until someone chooses");

    // Bans off, Requests on, and Requests ahead of Search: the bar follows each change at once.
    await card.getByRole("button", { name: "Take Moderation › Bans off the bar" }).tap();
    await card.getByLabel("Add a button to the quick bar").selectOption("moderation.requests");
    await card.getByRole("button", { name: "Move Moderation › Requests earlier" }).tap();
    assert.deepEqual(await labels(), ["Live", "Players", "Requests", "⌕Search", "☰More"]);
    const items = stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/me/prefs" && c.body?.phoneBarItems).map((c) => c.body.phoneBarItems);
    assert.deepEqual(items.at(-1), ["live", "players", "moderation.requests", "search"], "kept on the account");
    assert.equal(await card.getByLabel("Add a button to the quick bar").count(), 0, "four at most: nothing more to add");
    assert.match(await card.innerText(), /4 is the most\. Take one off to add another\./, "and it says why");

    // The new button opens its screen, and reads as the screen you are on.
    await bar.getByRole("button", { name: "Requests", exact: true }).tap();
    await page.waitForFunction(() => window.location.hash === "#/moderation/requests");
    assert.equal(await bar.getByRole("button", { name: "Requests", exact: true }).getAttribute("aria-current"), "page");

    // Off: no bar, nothing keeps room for one, no buttons left to pick, and the account remembers.
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    await page.locator(".setting-card", { hasText: "Quick bar on phones" }).getByRole("button", { name: "Off", exact: true }).tap();
    await page.waitForFunction(() => window.document.documentElement.getAttribute("data-phone-bar") === "off");
    assert.equal(await bar.isVisible(), false, "no bar");
    const pad = await page.locator(".content").evaluate((el) => parseFloat(window.getComputedStyle(el).paddingBottom));
    assert.ok(pad < 56, `no room kept for a bar that is not there: ${pad}px`);
    assert.equal(await page.locator(".setting-card", { hasText: "Quick bar buttons" }).count(), 0);
    assert.ok(stub.calls.some((c) => c.method === "PUT" && c.path === "/api/me/prefs" && c.body?.phoneBar === "off"), "off is kept on the account");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // The account's choice reaches a phone that has never been set up, and a button for a screen the
  // account cannot open (Bans, here) stays off its bar.
  const viewer = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  const me = { body: { user: { id: "u2", username: "viewer", displayName: "viewer" }, limits: {}, roles: [], grants: viewer,
    prefs: { phoneBarItems: ["players.leaderboard", "moderation.bans", "live"] } } };
  await withPage({ grants: viewer, viewport: phone, overrides: { "/api/me": me } }, async (page) => {
    const bar = page.locator(".quick-bar");
    await bar.waitFor();
    await page.waitForFunction(() => window.document.querySelectorAll(".quick-bar .quick-btn").length === 3, null, { timeout: 10_000 });
    assert.deepEqual(await bar.locator(".quick-btn").allTextContents(), ["Leaderboard", "Live", "☰More"]);
  });
});

/*
 * An iPhone that has had its keyboard up can lose track of the screen: what is pinned along the
 * bottom stays where the page was and scrolls with it, mid-screen, while visualViewport.offsetTop
 * says how far the screen has moved off it. The bar, and the request bar and messages over it, move
 * back by that much, to the screen's bottom edge; with the keyboard up the same keeps the bar under
 * the keyboard. Nothing moves when the two agree, or zoomed in. Chromium never loses track, so the
 * test tells the page what such an iPhone says, through each of the three things that say it.
 */
test("on a phone the quick bar stays at the screen's bottom when an iPhone loses track of the screen", { skip: SKIP }, async () => {
  const phone = { width: 390, height: 844 };
  await withPage({ grants: OWNER_GRANTS, viewport: phone }, async (page, { errors }) => {
    await page.locator(".quick-bar").waitFor();
    await page.evaluate(() => {
      const vv = window.visualViewport;
      window.__vv = { offsetTop: 0, height: window.innerHeight, scale: 1 };
      for (const k of ["offsetTop", "height", "scale"]) Object.defineProperty(vv, k, { configurable: true, get: () => window.__vv[k] });
      // A request bar, as one stands while a request is being built.
      const rb = window.document.createElement("div");
      rb.className = "request-bar";
      rb.id = "test-request-bar";
      window.document.body.append(rb);
    });
    const say = (vv, event) => page.evaluate(([vv, event]) => {
      Object.assign(window.__vv, vv);
      if (event === "page scroll") window.dispatchEvent(new Event("scroll"));
      else window.visualViewport.dispatchEvent(new Event(event));
    }, [vv, event]);
    const placed = () => page.evaluate(() => {
      const r = window.document.querySelector(".quick-bar").getBoundingClientRect();
      const moved = (sel) => window.getComputedStyle(window.document.querySelector(sel)).translate;
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), flag: window.document.documentElement.hasAttribute("data-vv-shift"),
        bar: moved(".quick-bar"), requests: moved("#test-request-bar"), toasts: moved(".toast-stack") };
    });

    // As things should be: along the bottom, and nothing moved.
    let at = await placed();
    assert.deepEqual([at.bottom, at.flag, at.bar, at.requests, at.toasts], [phone.height, false, "none", "none", "none"]);

    // Lost track: the keyboard gone, but the screen 300px down from where the bar is pinned, and the
    // viewport still the keyboard's height short. The bar's bottom is the screen's bottom again —
    // the screen's top plus the page's height — and what sits on the bar moves with it.
    await say({ offsetTop: 300, height: 464 }, "scroll");
    at = await placed();
    assert.equal(at.bottom, 300 + phone.height, `at the screen's bottom edge: ${JSON.stringify(at)}`);
    assert.deepEqual([at.flag, at.bar, at.requests, at.toasts], [true, "0px 300px", "0px 300px", "0px 300px"]);
    // The page scrolling says it again, and so does the screen changing size.
    await say({ offsetTop: 120 }, "page scroll");
    assert.equal((await placed()).bottom, 120 + phone.height, "after the page scrolls");
    await say({ offsetTop: 200 }, "resize");
    assert.equal((await placed()).bottom, 200 + phone.height, "after the screen changes size");

    // The keyboard up, the screen 180px down the page and 500px of it above the keyboard: the bar
    // stays under the keyboard, not over what is being typed in.
    await say({ offsetTop: 180, height: 500 }, "resize");
    at = await placed();
    assert.equal(at.bottom, 180 + phone.height);
    assert.ok(at.top >= 180 + 500, `none of the bar above the keyboard: ${JSON.stringify(at)}`);

    // Zoomed in, the screen moving over the page is the zoom: nothing moves.
    await say({ offsetTop: 250, height: 422, scale: 2 }, "resize");
    at = await placed();
    assert.deepEqual([at.bottom, at.flag, at.bar, at.toasts], [phone.height, false, "none", "none"]);

    // The two agree again: along the bottom, and nothing moved.
    await say({ offsetTop: 0, height: phone.height, scale: 1 }, "scroll");
    at = await placed();
    assert.deepEqual([at.bottom, at.flag, at.bar, at.requests, at.toasts], [phone.height, false, "none", "none", "none"]);

    // Pinned at the top, the bar is a row of the page rather than pinned along the bottom: only what
    // is along the bottom moves.
    await page.evaluate(() => window.document.documentElement.setAttribute("data-phone-bar", "top"));
    await say({ offsetTop: 300, height: 464 }, "scroll");
    at = await placed();
    assert.deepEqual([at.flag, at.bar, at.requests, at.toasts], [true, "none", "0px 300px", "0px 300px"]);

    // A screen too wide for the bar has none, and nothing is left moved.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => !window.document.querySelector(".quick-bar"));
    const left = await page.evaluate(() => [window.document.documentElement.hasAttribute("data-vv-shift"), window.document.documentElement.style.getPropertyValue("--vv-shift")]);
    assert.deepEqual(left, [false, ""]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The VIP list's search finds a player by name or id, and nothing else. It read each grant's
 * comment too, and a name staff write in comments — who sold the VIP, who it is for — brought up
 * every such row besides the player's own: a hundred rows for one name, on a phone with the
 * Comment column off the screen. While a search is on, the count beside Current VIPs says how
 * many of the list it found.
 */
test("the VIP list's search finds players by name or id, not by what comments say", { skip: SKIP }, async () => {
  const vip = (id, playerName, comment) => ({
    id: `v${id}`, serverId: "s1", playerId: `7656119800000000${id}`, playerName, comment, expiration: null,
    pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null, groupHold: null, perkGroups: [],
    createdByName: "Sam", createdAt: "2026-10-24T20:15:00.000Z", updatedAt: "2026-10-24T20:15:00.000Z",
  });
  const vips = [vip(1, "KREITZ", "Paid: one month"), vip(2, "PHOENIX", "Sold by Kreitz"), vip(3, "Juniper", "Event winner")];
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/vips": { body: { vips } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/vips`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Current VIPs" }) });
    const search = panel.getByPlaceholder("Search name or ID…");
    const count = () => panel.locator(".panel-subtitle").innerText();
    const names = () => panel.locator("tbody .player-link").allInnerTexts();
    const rows = (n) => page.waitForFunction((n) => {
      const list = [...window.document.querySelectorAll(".panel")].find((p) => p.querySelector(".panel-title")?.textContent.includes("Current VIPs"));
      return list?.querySelectorAll("tbody tr").length === n;
    }, n);
    await panel.locator("tbody tr").first().waitFor();
    assert.equal(await count(), "3");

    // A name: the player, and not the row whose comment mentions them.
    await search.fill("kreitz");
    await rows(1);
    assert.deepEqual(await names(), ["KREITZ"]);
    assert.equal(await count(), "1 of 3");
    // An id finds its player.
    await search.fill("76561198000000003");
    assert.deepEqual(await names(), ["Juniper"]);
    assert.equal(await count(), "1 of 3");
    // A word only a comment holds finds nobody, and says what the search looks at.
    await search.fill("Event");
    await panel.getByText("No VIPs match your search").waitFor();
    assert.match(await panel.innerText(), /The search covers player names and IDs\./);
    assert.equal(await count(), "0 of 3");
    // Cleared: the whole list, and its count alone.
    await search.fill("");
    await rows(3);
    assert.equal(await count(), "3");
    assert.deepEqual(errors, []);
  });
});

test("the noticeboard's Discord nudge sits with the relay, and its old link still lands there", { skip: SKIP }, async () => {
  // "Announcements" was a Discord tab holding one toggle and a channel id — the same decision the
  // relay tab next to it makes. It merged in. Two things have to hold: it is reachable in its new
  // home, and the URL people bookmarked does not quietly open the wrong screen.
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];

    await page.goto(`${base}#/discord/relay`, { waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar", { timeout: 10_000 });
    const tabs = await page.locator(".tabbar-tab").allInnerTexts();
    assert.ok(!tabs.includes("Announcements"), `the merged tab is gone, got ${JSON.stringify(tabs)}`);
    assert.ok(tabs.includes("Relay & alerts"), "the tab it merged into is still there");

    // Both panels are on the one tab: the per-server relay and the instance-wide nudge.
    const body = await page.locator("body").innerText();
    assert.ok(body.includes("Relay & alerts"), "the relay panel is here");
    assert.ok(body.includes("Unread-notice nudge"), "so is the nudge that used to have its own tab");

    // The retired URL redirects rather than falling through to whichever tab happens to be first.
    await page.goto(`${base}#/discord/announcements`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.document.body.innerText.includes("Unread-notice nudge"), null, { timeout: 10_000 });
    const active = await page.locator(".tabbar-tab.active").innerText();
    assert.equal(active.trim(), "Relay & alerts", "an old bookmark opens where the setting went");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Between rounds, and before the first, there is no round in play: the stats site's round report
 * said "Loading…" for as long as the page stayed open, and its game log said "not found".
 */
test("public site: with no round in play, the round report and the game log say so", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const none = { status: 404, body: { error: "not found" } };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/api/public/alpha/report/current": none,
    "/api/public/alpha/log/current": none,
    "/stats/alpha/api/get_live_game_stats": { body: { result: { snapshot_timestamp: 1, refresh_interval_sec: 5, stats: [] }, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    for (const tab of ["report", "log"]) {
      await page.goto(`${stub.base}/stats/alpha/${tab}`, { waitUntil: "load" });
      await page.getByText("No round is being played right now.").waitFor({ timeout: 10_000 });
      const text = await page.locator("body").innerText();
      assert.doesNotMatch(text, /Loading…/, `${tab}: not loading`);
      assert.doesNotMatch(text, /not found/, `${tab}: no bare "not found"`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The stats site counted one as many: "1 rounds" for a seeding hero with one low-pop round and on
 * the seeding card of a server with one recorded round, "1 players" over a scoreboard of one, and
 * the same for a kill streak and a career's visits.
 */
test("public site: one round is counted as 1 round", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const stats = {
    scannedMatches: 1, truncated: false,
    overview: { matches: 1, avgMinutes: 60, alliesWins: 1, axisWins: 0, attackersWinPct: null },
    maps: [], quality: { contested: 0, decisive: 1, stomp: 0, crash: 0, other: 0, scored: 1 },
    activity: [],
    seeding: { measuredRounds: 1, seededShare: 0, avgPlayers: 6, hoursUtc: Array.from({ length: 24 }, () => 0),
      heroes: [{ name: "Smith", rounds: 1 }, { name: "Jones", rounds: 2 }], killers: [] },
    records: { kills: [], combat: [], support: [] },
    regulars: { playtime: [], kills: [] },
    classRecords: [], weaponRecords: [],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/api/public/alpha/stats": { body: { stats } },
    "/stats/alpha/api/get_public_info": { body: { result: null, failed: true, error: "down" } },
    "/stats/alpha/api/get_live_game_stats": { body: { result: { snapshot_timestamp: 1, refresh_interval_sec: 5, stats: [
      { player_id: "76561198000000001", player: "Smith", platform: "steam", steaminfo: null, kills: 3, deaths: 1, teamkills: 0, kill_death_ratio: 3, combat: 1, offense: 0, defense: 0, support: 0, time_seconds: 60, kills_streak: 1, most_killed: {}, death_by: {}, weapons: {}, death_by_weapons: {}, team: null, status: "online" },
    ] }, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "load" });
    await page.waitForFunction(() => /\b1 player\b/.test(window.document.body.innerText), null, { timeout: 10_000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /\b1 players\b/, "a scoreboard of one");
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "load" });
    await page.getByText("From the 1 round with recorded players.", { exact: false }).waitFor({ timeout: 10_000 });
    const heroes = await page.locator("tr", { hasText: /^(Smith|Jones)/ }).allInnerTexts();
    assert.ok(heroes.some((t) => /Smith\s+1 round$/.test(t.trim())) && heroes.some((t) => /Jones\s+2 rounds$/.test(t.trim())), heroes.join(" | "));
    assert.doesNotMatch(await page.locator("body").innerText(), /\b1 rounds\b/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The directory offered "🔨 Perma banned" to anyone who could open it. It lists who is banned for
 * good: the Bans page's answer, behind its own permission there and on the profile. "★ VIP" stays
 * everyone's — each row marks a VIP already.
 */
test("the player directory offers the perma-banned filter only with the Bans permission", { skip: SKIP }, async () => {
  const viewer = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  for (const [who, grants, offered] of [["a viewer", viewer, false], ["the owner", OWNER_GRANTS, true]]) {
    await withPage({ grants }, async (page, { errors }) => {
      await page.goto(`${page.url().split("#")[0]}#/players/directory`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: /^Filters/ }).click();
      await page.getByRole("button", { name: "👁 Watched" }).waitFor({ timeout: 10_000 });
      assert.equal(await page.getByRole("button", { name: "★ VIP" }).count(), 1, `${who}: the VIP filter`);
      assert.equal(await page.getByRole("button", { name: "🔨 Perma banned" }).count(), offered ? 1 : 0, `${who}: the perma-banned filter`);
      assert.deepEqual(errors, [], "no uncaught page errors");
    });
  }
});

/*
 * Putting the panel online: both ways side by side, each with its pros and cons. The tunnel's token
 * is pasted as the dashboard shows it and never shown again; its state comes back with the save.
 * The own-domain way says whether its HTTPS proxy runs, and links the address once it does.
 */
test("Online access: the tunnel's token is pasted and saved, its state shown, and the own domain links its address", { skip: SKIP }, async () => {
  const view = (over = {}) => ({
    route: "vm",
    tunnel: { set: false, state: "off", connections: 0, tunnelId: null, detail: null },
    domain: { host: null, proxy: false },
    statsSite: { host: null, origin: null, name: null, shareable: null },
    ...over,
  });
  const connected = { set: true, state: "connected", connections: 4, tunnelId: "8b8a1f9e-6c1d", detail: null };
  const ownDomain = { host: "panel.example.com", proxy: true };
  let stubRef = null;
  const saved = (path) => Boolean(stubRef?.calls.some((c) => c.method === "PUT" && c.path === path));
  await withPage({ grants: OWNER_GRANTS, overrides: {
    // After a save the tab reads itself again, and reads what the save left.
    "/api/online": () => ({ body: view({ ...(saved("/api/online/tunnel") ? { tunnel: connected } : {}), ...(saved("/api/online/domain") ? { domain: ownDomain } : {}) }) }),
    "/api/online/tunnel": { body: view({ tunnel: connected }) },
    "/api/online/domain": { body: view({ domain: ownDomain }) },
  } }, async (page, { stub, errors }) => {
    stubRef = stub;
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/admin/online`, { waitUntil: "networkidle" });
    const tunnelWay = page.locator("section.online-way", { hasText: "Cloudflare Tunnel" });
    await tunnelWay.waitFor({ timeout: 10_000 });
    assert.match(await tunnelWay.innerText(), /No ports to open[\s\S]*Visits pass through Cloudflare/, "its pros and its cons");
    const pasted = "cloudflared.exe service install eyJhIjoiYSJ9";
    await tunnelWay.locator("input[type=password]").fill(pasted);
    await tunnelWay.locator("button", { hasText: /^Save$/ }).click();
    await tunnelWay.locator(".online-status", { hasText: "Connected" }).waitFor({ timeout: 10_000 });
    assert.match(await tunnelWay.locator(".online-status").innerText(), /4 connections to Cloudflare · tunnel 8b8a1f9e/);
    assert.deepEqual(stub.calls.find((c) => c.method === "PUT" && c.path === "/api/online/tunnel")?.body, { token: pasted }, "sent as pasted: the panel picks the token out");
    assert.equal(await tunnelWay.locator("input[type=password]").inputValue(), "", "and the field empties: the token is never shown again");

    const domainWay = page.locator("section.online-way", { hasText: "Your own domain" });
    assert.match(await domainWay.innerText(), /not running on this install/, "says the proxy does not run yet");
    await domainWay.locator("input").fill("panel.example.com");
    await domainWay.locator("button", { hasText: /^Save$/ }).click();
    await domainWay.locator("a", { hasText: "https://panel.example.com" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(stub.calls.find((c) => c.method === "PUT" && c.path === "/api/online/domain")?.body, { host: "panel.example.com" });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * While the tunnel is still connecting the tab reads itself every few seconds. A save made while one
 * of those reads is on its way must not be painted over when that older read lands: the panel went
 * back to "Connecting…" seconds after "Connected", until the next read.
 */
test("Online access: a save is not painted over by a slower read already on its way", { skip: SKIP }, async () => {
  const tunnel = (state, connections = 0) => ({ set: true, state, connections, tunnelId: "8b8a1f9e-6c1d", detail: state === "connecting" ? "edge discovery: the DNS query failed" : null });
  const view = (t) => ({ route: "home", tunnel: t, domain: { host: null, proxy: false }, statsSite: { host: null, origin: null, name: null, shareable: null } });
  let stubRef = null;
  let reads = 0;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/online": () => {
      reads += 1;
      if (stubRef?.calls.some((c) => c.method === "PUT" && c.path === "/api/online/tunnel")) return { body: view(tunnel("connected", 4)) };
      // The second read is slow, and says what was true before the save.
      return reads === 2 ? { delayMs: 3_000, body: view(tunnel("connecting")) } : { body: view(tunnel("connecting")) };
    },
    "/api/online/tunnel": { body: view(tunnel("connected", 4)) },
  } }, async (page, { stub, errors }) => {
    stubRef = stub;
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/admin/online`, { waitUntil: "networkidle" });
    const status = page.locator("section.online-way", { hasText: "Cloudflare Tunnel" }).locator(".online-status");
    await status.filter({ hasText: "Connecting to Cloudflare" }).waitFor({ timeout: 10_000 });
    for (let i = 0; i < 100 && reads < 2; i++) await page.waitForTimeout(100);
    assert.ok(reads >= 2, "a second read is on its way");
    await page.locator("section.online-way", { hasText: "Cloudflare Tunnel" }).locator("input[type=password]").fill("cloudflared.exe service install eyJhIjoiYSJ9");
    await page.locator("section.online-way", { hasText: "Cloudflare Tunnel" }).locator("button", { hasText: /^Save$/ }).click();
    await status.filter({ hasText: "Connected" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(3_500);
    assert.match(await status.innerText(), /^Connected/, "the slow read that was on its way did not put the old state back");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The public demo: a switch that saves as it is turned, and while it is on, the one link to share —
 * on the panel's own domain once its HTTPS proxy serves it, or else on the address the panel is open
 * on. A save that fails puts the switch back where it was.
 */
test("Online access: the public demo's switch saves as it is turned, and its link starts where the panel is reached", { skip: SKIP }, async () => {
  let on = false;
  let refuse = false;
  let domain = { host: null, proxy: false };
  const view = () => ({
    route: "home", tunnel: { set: false, state: "off", connections: 0, tunnelId: null, detail: null }, domain,
    statsSite: { host: null, origin: null, name: null, shareable: null }, demo: { on },
  });
  let stubRef = null;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/online": () => ({ body: view() }),
    "/api/online/demo": () => {
      if (refuse) return { status: 500, body: { error: { message: "the setting could not be saved" } } };
      on = stubRef.calls.at(-1).body.on;
      return { body: view() };
    },
  } }, async (page, { stub, errors }) => {
    stubRef = stub;
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/admin/online`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel").filter({ has: page.locator(".panel-title", { hasText: /^Public demo$/ }) });
    await panel.waitFor({ timeout: 10_000 });
    const box = panel.locator("label.toggle input");
    assert.equal(await box.isChecked(), false, "off until someone turns it on");
    assert.equal(await panel.locator(".panel-subtitle").innerText(), "Off");
    assert.equal(await panel.locator(".demo-link").count(), 0, "no link to share while it is off");

    await panel.locator("label.toggle").click();
    await panel.locator(".panel-subtitle", { hasText: /^On$/ }).waitFor({ timeout: 10_000 });
    assert.deepEqual(stub.calls.filter((c) => c.path === "/api/online/demo").map((c) => [c.method, c.body]), [["PUT", { on: true }]], "saved as it was turned");
    const here = new URL(base).origin;
    const links = () => panel.locator(".demo-link a").evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute("href")]));
    assert.deepEqual(await links(), [[`${here}/demo/`, `${here}/demo/`]], "one link, on the address the panel is open on");
    assert.match(await panel.innerText(), /On\. Anyone with the link can try the panel\./);

    refuse = true;
    await panel.locator("label.toggle").click();
    await panel.getByText("the setting could not be saved").waitFor({ timeout: 10_000 });
    assert.equal(await box.isChecked(), true, "a save that failed puts the switch back");
    assert.equal(await panel.locator(".demo-link a").count(), 1, "and the link with it");

    // On a VM whose HTTPS proxy serves the panel's own domain, the links are on that.
    refuse = false;
    domain = { host: "panel.example.com", proxy: true };
    await page.reload({ waitUntil: "networkidle" });
    await panel.locator(".demo-link a").first().waitFor({ timeout: 10_000 });
    assert.deepEqual((await links()).map(([, href]) => href), ["https://panel.example.com/demo/"]);

    await panel.locator("label.toggle").click();
    await panel.locator(".panel-subtitle", { hasText: /^Off$/ }).waitFor({ timeout: 10_000 });
    assert.equal(await panel.locator(".demo-link").count(), 0, "turned off, the link goes");
    assert.match(await panel.innerText(), /Off\. The link now answers "not found"\./);
    assert.deepEqual(stub.calls.filter((c) => c.path === "/api/online/demo").map((c) => c.body), [{ on: true }, { on: false }, { on: false }]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("analytics windows: All time and a custom date range reach the API, and say what they cover", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/analytics/server": { body: { window: { from: "2025-03-01T12:00:00.000Z", to: "2026-09-27T12:00:00.000Z" } } } },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/analytics/server`, { waitUntil: "networkidle" });
    const seen = [];
    page.on("request", (r) => { if (r.url().includes("/api/analytics/server")) seen.push(r.url()); });

    await page.getByRole("button", { name: "All time" }).first().click();
    await page.waitForFunction(() => window.document.body.innerText.includes("since "), null, { timeout: 10_000 });
    assert.ok(seen.some((u) => u.includes("all=1")), `All time asks for all=1, got ${seen.join(" ")}`);

    await page.getByRole("button", { name: "Custom…" }).first().click();
    await page.locator('input[type="date"]').nth(0).fill("2025-01-01");
    await page.locator('input[type="date"]').nth(1).fill("2026-06-30");
    await page.getByRole("button", { name: "Apply" }).first().click();
    await page.waitForFunction(() => [...window.document.querySelectorAll("button")].every((b) => b.textContent !== "Apply"), null, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const custom = seen.find((u) => u.includes("from=") && u.includes("to="));
    assert.ok(custom, `a custom range asks with from/to, got ${seen.join(" ")}`);
    const q = new URL(custom).searchParams;
    // Longer than a year on purpose — the old one-year cap is gone for custom ranges.
    assert.ok(Date.parse(q.get("to")) - Date.parse(q.get("from")) > 366 * 86_400_000, "an 18-month range is sent as asked");

    // A start after the end is refused before it costs a query.
    await page.getByRole("button", { name: "Custom…" }).first().click();
    await page.locator('input[type="date"]').nth(0).fill("2026-06-30");
    await page.locator('input[type="date"]').nth(1).fill("2026-06-01");
    assert.equal(await page.getByRole("button", { name: "Apply" }).first().isDisabled(), true);
    assert.ok((await page.locator("body").innerText()).includes("The start date is after the end date."));
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a mode with no category can be added, including skirmish", { skip: SKIP }, async () => {
  // Skirmish used to be unbuildable: no preset and no default named it, so a real server's
  // skirmish maps could never be offered and nothing said so. Now it is one button.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/servers/s1/mapvote/config": { body: MODE_CFG({
      modeBuckets: [{ mode: "warfare", count: 2, limits: { day: 2 }, maps: [] }],
    }) } },
  }, async (page, { errors }) => {
    await openLibrary(page, "Manage map sets", "default");
    await page.waitForSelector(".mapset-envs", { timeout: 10_000 });

    const panel = page.locator(".panel", { hasText: "Vote setup" }).first();
    assert.match(await panel.innerText(), /Add a mode:/);
    await panel.locator("button", { hasText: /^Skirmish$/ }).first().click();
    await page.waitForFunction(
      () => [...window.document.querySelectorAll(".mapset-bucket")].some((c) => (c.textContent || "").includes("Skirmish")),
      null, { timeout: 5_000 },
    );
    const skirmish = page.locator(".mapset-bucket").filter({ hasText: "Skirmish" }).first();
    assert.match(await skirmish.innerText(), /Nothing asked for/, "a fresh category is empty until you fill it in");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("switching servers cannot leave the previous server's data on screen", { skip: SKIP }, async () => {
  /*
   * The dashboard tiles are keyed on the active server. Every one of them fired its request in a
   * useEffect and painted whatever came back — so picking a different server while the first one's
   * request was still in flight let the OLD server's rotation, settings and VIP list land second
   * and paint over the new server's. Nothing on screen said which server you were looking at, so
   * the screen simply lied, and it lied worst on exactly the servers that are slow to answer.
   *
   * Three servers, because the race has to start AFTER the page has loaded: the initial navigation
   * waits for the network to go quiet, so a slow tile on the landing server resolves before the
   * test can touch anything. Server one is the quiet landing pad; the race is two → three.
   */
  const SLOW_MS = 1500;
  const server = (id, name) => ({ id, name, game: "hll", engagementMode: "observe" });
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [server("s1", "Landing"), server("s2", "Slow"), server("s3", "Current")] } },
      "/api/layout/dashboard": { body: { source: "default", widgets: [
        { id: "dash-maprotation", title: "Map rotation", visible: true, order: 10, required: false, size: { w: 4, h: 2 } },
        { id: "dash-server-settings", title: "Settings", visible: true, order: 20, required: false, size: { w: 4, h: 2 } },
        { id: "dash-vips-watched", title: "VIPs", visible: true, order: 30, required: false, size: { w: 4, h: 2 } },
      ] } },
      "/api/servers/s1/maprotation": { body: { mapRotation: { currentIndex: 0, mAPS: [{ name: "LANDING-ROTATION" }] } } },
      "/api/servers/s1/config": { body: { config: { maxQueuedPlayers: 1 } } },
      "/api/servers/s1/vips": { body: { vips: [] } },
      // The server we leave mid-request. Everything it returns is marked STALE.
      "/api/servers/s2/maprotation": { delayMs: SLOW_MS, body: { mapRotation: { currentIndex: 0, mAPS: [{ name: "STALE-ROTATION-S2" }] } } },
      "/api/servers/s2/config": { delayMs: SLOW_MS, body: { config: { maxQueuedPlayers: 111 } } },
      "/api/servers/s2/vips": { delayMs: SLOW_MS, body: { vips: [{ playerId: "p2", playerName: "STALE-VIP-S2" }] } },
      // The server we end on. Answers at once, so it lands FIRST and the stale data arrives after.
      "/api/servers/s3/maprotation": { body: { mapRotation: { currentIndex: 0, mAPS: [{ name: "CORRECT-ROTATION-S3" }] } } },
      "/api/servers/s3/config": { body: { config: { maxQueuedPlayers: 222 } } },
      "/api/servers/s3/vips": { body: { vips: [{ playerId: "p3", playerName: "CORRECT-VIP-S3" }] } },
    },
  }, async (page) => {
    const picker = 'select[aria-label="Active server"]';
    await page.waitForFunction(() => /LANDING-ROTATION/.test(window.document.body.innerText), null, { timeout: 15_000 });

    // Start the slow server's three requests, then change your mind before any of them answer.
    await page.selectOption(picker, "s2");
    await page.selectOption(picker, "s3");

    // Server three answers immediately…
    await page.waitForFunction(() => /CORRECT-ROTATION-S3/.test(window.document.body.innerText), null, { timeout: 15_000 });

    // …and server two's answers arrive well after. This is the window the bug lived in.
    await page.waitForTimeout(SLOW_MS + 800);

    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /STALE-ROTATION-S2/, "the abandoned server's rotation painted over the current one's");
    assert.doesNotMatch(body, /STALE-VIP-S2/, "the abandoned server's VIP list painted over the current one's");
    assert.doesNotMatch(body, /\b111\b/, "the abandoned server's settings painted over the current one's");
    assert.match(body, /CORRECT-ROTATION-S3/, "the current server's rotation must still be on screen");
    assert.match(body, /CORRECT-VIP-S3/, "the current server's VIP list must still be on screen");
    assert.match(body, /\b222\b/, "the current server's settings must still be on screen");

    // And the switcher still says which server this is, so the assertions above mean what they say.
    assert.equal(await page.locator(picker).inputValue(), "s3");
  });
});

/*
 * "View as" a role with no permissions showed the whole dashboard: the panel narrowed its own
 * screens to the role, but every read still went out on the owner's own access, so the cards, the
 * server list and the host figures were the owner's. Every read now names the role and the API
 * answers as it; your own account's read never does; leaving the preview reads everything as you.
 */
test("View as: every read names the role, your own account's never does, and Exit reads as you again", { skip: SKIP }, async () => {
  const card = (id, title) => ({ id, title, visible: true, order: 10, required: false, size: { w: 4, h: 2 } });
  const asRole = (req) => req?.headers["x-preview-role"] === "r-view";
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/roles": { body: { roles: [{ id: "r-view", name: "View only", grants: [], limits: {}, members: 0 }] } },
      // Answered the way the API answers: as the role inside the preview, as you outside it. The
      // role's dashboard keeps a live feed, so the stream it opens is checked too.
      "/api/layout/dashboard": (url, req) => ({ body: { source: "default", widgets: asRole(req)
        ? [card("dash-recent", "Recent activity"), { ...card("dash-killfeed", "Live kills"), view: { blocks: [{ type: "feed", kinds: ["evt.kill"], emptyText: "Waiting for kills…", max: 40 }] } }]
        : [card("dash-recent", "Recent activity"), card("dash-server-settings", "Server settings")] } }),
      "/api/servers": (url, req) => ({ body: { servers: asRole(req) ? [] : [{ id: "s1", name: "WW2", game: "hll", engagementMode: "active" }] } }),
      "/api/servers/s1/config": { body: { config: { maxQueuedPlayers: 6 } } },
    },
  }, async (page, { stub, errors }) => {
    const picker = page.locator('select[aria-label="Active server"]');
    const titles = () => page.locator(".tile-title").allInnerTexts();
    await page.goto(`${stub.base}/#/admin/users`, { waitUntil: "networkidle" });
    const viewAs = page.locator(".role-card", { hasText: "View only" }).getByRole("button", { name: "View as" });
    await viewAs.waitFor();
    await picker.waitFor();
    await page.locator(".host-status").waitFor();
    await page.waitForLoadState("networkidle");

    const from = stub.calls.length;
    await viewAs.click();
    await page.getByText("Viewing as View only").waitFor();
    await picker.waitFor({ state: "detached" });
    // Your own account's read, from Settings, while previewing.
    const ownRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/me");
    await page.evaluate(() => { window.location.hash = "#/settings"; });
    await ownRead;
    const streamed = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/events/stream");
    await page.evaluate(() => { window.location.hash = "#/dashboard"; });
    await page.locator(".tile-title", { hasText: "Live kills" }).waitFor();
    await streamed;
    assert.deepEqual(await titles(), ["Recent activity", "Live kills"], "the role's dashboard, not yours");
    assert.equal(await page.locator(".host-status").count(), 0, "no host figures: the role cannot read them");
    const during = stub.calls.slice(from);
    for (const path of ["/api/plugin-pages", "/api/servers", "/api/layout/dashboard", "/api/events/stream", "/api/me"]) {
      assert.ok(during.some((c) => c.path === path), `${path} was read during the preview`);
    }
    for (const c of during) assert.equal(c.preview, c.path === "/api/me" ? null : "r-view", `${c.path} ${c.path === "/api/me" ? "is your own account's: never as the role" : "names the role"}`);

    // Leaving from the dashboard itself: what the preview read gives way to your own.
    const exitAt = stub.calls.length;
    await page.getByRole("button", { name: "Exit preview" }).click();
    await page.locator(".tile-title", { hasText: "Server settings" }).waitFor();
    await picker.waitFor();
    await page.locator(".host-status").waitFor();
    assert.deepEqual(await titles(), ["Recent activity", "Server settings"], "your own dashboard again");
    const after = stub.calls.slice(exitAt);
    assert.ok(after.some((c) => c.path === "/api/plugin-pages"), "the plugin pages read again as you");
    assert.ok(after.every((c) => c.preview === null), "nothing read as the role after Exit");
    assert.deepEqual(errors, []);
  });
});

/*
 * A dashboard card shows only what its reader can read. The VIP list takes VIP access, so without
 * it VIPs & watched is the watchlist alone, never a VIP tab saying the server has none. And the
 * strip above the cards took a refused watchlist read for the panel being down, and an empty
 * server list for none being connected, both wrong for someone who simply holds no server access.
 */
test("dashboard cards and the strip above them say only what their reader can read", { skip: SKIP }, async () => {
  const card = (id, title) => ({ id, title, visible: true, order: 10, required: false, size: { w: 4, h: 2 } });
  await withPage({
    grants: [{ capability: "server.view", level: "read", scopeType: "global", scopeId: null }],
    overrides: {
      "/api/layout/dashboard": { body: { source: "default", widgets: [card("dash-vips-watched", "VIPs & watched")] } },
      "/api/players/flagged": { body: { flags: [{ playerId: "p1", name: "Watched One", watchlist: true }] } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${stub.base}/#/dashboard`, { waitUntil: "networkidle" });
    await page.locator(".vw-row", { hasText: "Watched One" }).waitFor();
    assert.deepEqual(await page.locator(".vw-tab").allInnerTexts(), ["Watched (1)"], "the watchlist alone: no VIP tab");
    assert.ok(!stub.calls.some((c) => /\/vips$/.test(c.path)), "and no VIP list asked for");
  });
  await withPage({
    grants: [],
    overrides: {
      "/api/layout/dashboard": { body: { source: "default", widgets: [card("dash-recent", "Recent activity")] } },
      "/api/servers": { body: { servers: [] } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${stub.base}/#/dashboard`, { waitUntil: "networkidle" });
    await page.locator(".tile-title", { hasText: "Recent activity" }).waitFor();
    await page.waitForTimeout(300);
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /isn't answering/, "a permission it lacks is not the panel being down");
    assert.doesNotMatch(body, /No game servers are connected/, "servers it was not given are not servers missing");
    assert.match(body, /Nothing needs your attention\./, "all clear, without counting servers it cannot see");
    assert.doesNotMatch(body, /0 servers connected/);
    assert.ok(!stub.calls.some((c) => c.path === "/api/players/flagged"), "no watchlist read it would be refused");
    assert.equal(await page.locator(".host-status").count(), 0, "no host line to say Offline");
  });
});

/*
 * A list that cannot be read says so. The player Directory kept its loading bars up for good when
 * the read failed: the list's own error was never drawn, and the bars waited on the Watchlist's.
 */
test("the player Directory says when its list could not be read", { skip: SKIP }, async () => {
  const failed = { status: 500, body: { error: { code: "internal", message: "The player list could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/players": failed } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/directory`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { hasText: "Directory" }).first();
    await panel.locator(".error", { hasText: "The player list could not be read." }).waitFor({ timeout: 10_000 });
    assert.equal(await panel.locator(".skeleton").count(), 0, "and no loading bars under it");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("Auto settings: the chat filter and the zone sets open with their own permissions, not the rules'", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("moderation.chatfilter"), held("moderation.zones")] }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    assert.deepEqual(await hubTabs(page), ["Chat filter", "Map zones"], "their two tabs, and no rules");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  await withPage({ grants: [held("server.view", "read"), held("admin.moderation")] }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/zones`, { waitUntil: "networkidle" });
    const tabs = await hubTabs(page);
    assert.ok(tabs.includes("Rules") && tabs.includes("Map zones"), `the rules, and the zone sets they pick from: ${tabs.join(", ")}`);
    assert.ok(!tabs.includes("Chat filter"), "the chat filter is not the rules permission's");
    await page.locator(".panel", { hasText: "Zone sets" }).first().waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("button", { name: "Create" }).count(), 0, "reading the sets is not drawing them");
  });
});

/*
 * The same for Events → "Post the list to Discord": a failed read of its settings left loading
 * rows in the card for good, with the error kept but never drawn.
 */
test("the Post the list to Discord card says when its settings could not be read", { skip: SKIP }, async () => {
  const failed = { status: 500, body: { error: { code: "internal", message: "The post settings could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/payout-events/post-config": failed } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/events/schedule`, { waitUntil: "networkidle" });
    const card = page.locator(".panel", { hasText: "Post the list to Discord" });
    await card.locator("button.panel-toggle").click();
    await card.locator(".error", { hasText: "The post settings could not be read." }).waitFor({ timeout: 10_000 });
    assert.equal(await card.locator(".skeleton").count(), 0, "and no loading rows under it");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A player's name on their profile wraps on a phone rather than running off its edge. A Steam name
 * is up to 32 characters with no spaces: on a 390px iPhone the last letters were cut off, and the
 * lines under the name were held out past the screen with it.
 */
test("a long player name wraps on the profile instead of running off a phone's edge", { skip: SKIP }, async () => {
  const LONG = "XxX_WolfpackCommanderEliteXx_XxX";
  const at = "2026-10-01T20:00:00.000Z";
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 }, overrides: {
    "/api/players/p1": { body: {
      player: { id: "p1", name: LONG, platform: "steam", platformId: "76561198000000001", firstSeen: at, lastSeen: at },
      stats: { kills: 1, deaths: 1, teamkills: 0 }, flags: { watchlist: false, vip: false, updatedByName: null },
      canViewNotes: true, notes: [], statsByServer: [], sessions: [], recentEvents: [],
    } },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/~p1`, { waitUntil: "networkidle" });
    const name = page.locator("h1", { hasText: LONG });
    await name.waitFor({ timeout: 10_000 });
    const { right, width } = await name.evaluate((el) => ({ right: el.getBoundingClientRect().right, width: window.document.documentElement.clientWidth }));
    assert.ok(right <= width, `the name ends inside the screen: ${Math.round(right)} of ${width}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The same on the stats site, which players open: a career page headed by a 32-character name ran
 * past the edge of a 360px phone (a common Android width).
 */
test("a long player name wraps on the stats site's career page", { skip: SKIP }, async () => {
  const LONG = "XxX_WolfpackCommanderEliteXx_XxX";
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: true,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/api/public/alpha/player/76561198000000001": { body: {
      player: { name: LONG, platform: "steam", platformId: "76561198000000001" },
      career: { kills: 900, deaths: 450, teamkills: 3, playtimeSec: 360000, visits: 120, combat: 1, offense: 1, defense: 1, support: 1, slSeconds: 3600, matchesPlayed: 80, matchesWon: 41, highestLevel: 250 },
      roles: [], weapons: [], deathsTo: [], rounds: [],
    } },
  };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/player/76561198000000001`, { waitUntil: "networkidle" });
    const name = page.locator("strong", { hasText: LONG });
    await name.waitFor({ timeout: 10_000 });
    const { right, width } = await name.evaluate((el) => ({ right: el.getBoundingClientRect().right, width: window.document.documentElement.clientWidth }));
    assert.ok(right <= width, `the name ends inside the screen: ${Math.round(right)} of ${width}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * …and on every other list whose row buttons reported into a line above the list (or, for player
 * triggers, into the builder's form): the rotation, the trigger list, VIP integrity's findings and
 * the clans. Each failure opens in front of the row, and the page's error line stays empty.
 */
test("rotation edits, trigger switches, VIP integrity fixes and clan changes that fail say why in a popup", { skip: SKIP }, async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const trig = {
    id: "t1", playerId: "p1", playerName: "Critic_5", serverId: null, serverName: null, event: "connect",
    steps: [{ action: "message", message: "Welcome back {player_name}", hours: 0, points: 0, delaySec: 0 }],
    fireOnce: false, enabled: true, note: "", createdByName: "KREITZ", createdAt: at,
    firedCount: 0, lastFiredAt: null, disarmedAt: null, summary: "on connect, message (every time)",
  };
  const clan = { key: "k1", label: "LYNX", customised: true, now: 3, ever: 10, lastSeen: null, spellings: [{ tag: "LYNX", now: 3, ever: 10, lastSeen: null }] };
  const refusal = (message) => ({ status: 409, body: { error: { code: "conflict", message } } });
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
        { id: "s2", name: "WW2 #2", game: "hll", engagementMode: "active" },
      ] } },
      "/api/servers/s1/maprotation/remove": refusal("the game refused: that map is not in the rotation"),
      "/api/player-triggers": { body: { triggers: [trig] } },
      "/api/players/p1/triggers": { body: { triggers: [trig], allowedActions: ["message"] } },
      "/api/players/p1/triggers/t1": refusal("the trigger changed while you looked at it"),
      "/api/vips/integrity": { body: { scanned: 10, findings: [{
        serverId: "s2", serverName: "WW2 #2", playerId: "p-short", playerName: "SHORTED", verdict: "shortened",
        permanentSince: at, grantedBy: "tester", currentExpiration: null, lostMs: 3 * 86_400_000, evidence: [],
      }] } },
      "/api/servers/s2/vips": refusal("WW2 #2 is not connected"),
      "/api/clans": { body: { clans: [clan], total: 1, focus: null, canEdit: true } },
      "/api/clans/members": { body: { members: [], total: 0 } },
      "/api/clans/reset": refusal("that clan was reset by someone else"),
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const popup = async (title, reason) => {
      const dialog = page.locator(".confirm-modal", { hasText: title });
      await dialog.waitFor({ timeout: 5_000 });
      assert.match(await dialog.innerText(), reason);
      assert.ok(await inFront(dialog, 844), `nothing covers "${title}"`);
      assert.equal(await page.locator("p.error", { hasText: reason }).count(), 0, `"${title}" is not in the page's error line`);
      await dialog.locator("button", { hasText: "OK" }).click();
      await dialog.waitFor({ state: "detached" });
    };

    // The rotation: the ✕ on its last map.
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    const remove = page.locator('button[title="Remove from rotation"]').last();
    await remove.waitFor({ timeout: 15_000 });
    await remove.click();
    await page.locator(".confirm-modal button", { hasText: "Remove" }).click();
    await popup("Couldn't change the rotation", /that map is not in the rotation/);

    // A player trigger's Disable, in the list under the builder.
    await page.goto(`${base}#/players/triggers`, { waitUntil: "networkidle" });
    const disable = page.locator("tbody button", { hasText: /^Disable$/ }).first();
    await disable.waitFor({ timeout: 15_000 });
    await disable.click();
    await popup("Couldn't disable the trigger on Critic_5", /the trigger changed while you looked at it/);

    // VIP integrity: Add back on a finding.
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    const toggle = page.locator("button.panel-toggle", { hasText: "VIP integrity" });
    await toggle.waitFor({ timeout: 15_000 });
    await toggle.click();
    await page.locator("button", { hasText: "Scan all servers" }).click();
    await page.locator("tr", { hasText: "SHORTED" }).locator("button", { hasText: "Add 3d back" }).click();
    await page.locator(".confirm-modal button", { hasText: "Add it back" }).click();
    await popup("Couldn't add the time back for SHORTED", /WW2 #2 is not connected/);

    // Clans: Reset on an edited clan.
    await page.goto(`${base}#/players/clans`, { waitUntil: "networkidle" });
    const reset = page.locator("tr", { hasText: "LYNX" }).locator("button", { hasText: /^Reset$/ });
    await reset.waitFor({ timeout: 15_000 });
    await reset.click();
    await page.locator(".confirm-modal button", { hasText: /^Reset$/ }).click();
    await popup("Couldn't reset LYNX", /that clan was reset by someone else/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the game log comes back as it was left, by either back button: category and Live per user, search and player per sitting", { skip: SKIP }, async () => {
  /*
   * Staff report: monitoring on History → Game log with Team kills and Live on, they open a player
   * from a line, come back, and the log is on All with Live off, so both get picked again every
   * time. The filters were plain state and opening a profile unmounts the log, so no way back
   * could find them. Both buttons are driven: the panel's own back walks to a new address, the
   * browser's pops the old one. A new sitting then keeps the per-user half and not the search.
   */
  const asked = []; // every events query the log made, newest last
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/events": (url) => {
        asked.push(url.searchParams);
        return { body: { events: [{ ts: "2026-01-01T00:00:00.000Z", kind: "evt.teamkill", actorName: "Caereca", actorPlayerId: "p1", victimName: "Mate", weapon: "M1" }], total: 1 } };
      },
      "/api/players": (url) => (url.searchParams.get("q")
        ? { body: { players: [{ id: "p7", platformId: "76561100000000077", name: "Picked Pete" }], total: 1 } }
        : undefined),
    },
  }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    const streams = () => stub.requests.filter((p) => p === "/api/events/stream").length;
    const filtersOf = (sp) => sp && ({ kinds: sp.get("kinds"), q: sp.get("q"), player: sp.get("player") });
    const LEFT = { kinds: "evt.teamkill", q: "Caer", player: "76561100000000077" }; // the picker filters by game id
    const liveBox = (pg) => pg.locator("label.toggle", { hasText: "Live" }).locator("input");
    // The stub sees requests the page cannot be asked about, so wait on them directly.
    const until = async (cond, what) => {
      for (let i = 0; i < 150 && !cond(); i++) await page.waitForTimeout(100);
      assert.ok(cond(), `timed out waiting for ${what}`);
    };

    await page.goto(`${base}#/history/logs`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-row", { timeout: 15_000 });
    await page.click(".seg-btn:has-text('Team kills')");
    await page.locator("label.toggle", { hasText: "Live" }).click();
    await page.fill("input.search-input", "Caer");
    await page.getByPlaceholder("Filter to one player…").fill("Pete");
    await page.click(".picker-card-top:has-text('Picked Pete')"); // the name: mid-card is the copy-id button
    await page.waitForSelector(".picker-chip:has-text('Picked Pete')", { timeout: 15_000 });
    await until(() => JSON.stringify(filtersOf(asked[asked.length - 1])) === JSON.stringify(LEFT), "the log to ask with every filter set");
    await until(() => streams() >= 1, "Live to open the stream");

    const backTo = async (how) => {
      await page.click(".log-row .player-link:has-text('Caereca')");
      // The log's own title, not its rows: the profile's activity feed draws the same rows.
      await page.waitForSelector(".panel-title:text-is('Game log')", { state: "detached", timeout: 15_000 });
      assert.match(await page.evaluate(() => window.location.hash), /^#\/players\//, "the name opened the profile");
      const askedBefore = asked.length;
      const streamsBefore = streams();
      if (how === "app") await page.click(".sidebar .trail-btn[aria-label^='Back to']");
      else await page.goBack();
      await page.waitForSelector(".panel-title:text-is('Game log')", { timeout: 15_000 });
      await page.waitForSelector(".log-row", { timeout: 15_000 });

      assert.equal((await page.locator(".seg-btn.active").textContent())?.trim(), "Team kills", `${how} back: still on Team kills`);
      assert.equal(await liveBox(page).isChecked(), true, `${how} back: Live still on`);
      assert.equal(await page.inputValue("input.search-input"), "Caer", `${how} back: the search kept`);
      assert.match((await page.locator(".picker-chip").textContent()) ?? "", /Picked Pete/, `${how} back: the player kept`);
      // The first query after coming back already carries them: no detour through the defaults.
      assert.deepEqual(filtersOf(asked[askedBefore]), LEFT, `${how} back: the first query asked with what was left`);
      await until(() => streams() > streamsBefore, `${how} back: Live to stream again`);
    };
    await backTo("app");
    await backTo("browser");

    // A new sitting (what a new tab starts with: this browser's localStorage, an empty
    // sessionStorage) gets the person's view of the log, category and Live, not the old search.
    const asked2 = asked.length;
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload(); // not "networkidle": with Live remembered, a stream is held open from the start
    await page.waitForSelector(".log-row", { timeout: 15_000 });
    assert.equal((await page.locator(".seg-btn.active").textContent())?.trim(), "Team kills", "a new sitting opens on this user's category");
    assert.equal(await liveBox(page).isChecked(), true, "and with Live on");
    assert.equal(await page.inputValue("input.search-input"), "", "but without the last sitting's search");
    assert.equal(await page.locator(".picker-chip").count(), 0, "or its player");
    assert.deepEqual(filtersOf(asked[asked2]), { kinds: "evt.teamkill", q: null, player: null });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("Moderation, History and Live screens come back as they were left", { skip: SKIP }, async () => {
  /*
   * The same report as the Players screens, on the rest of the panel: a ban searched for, a record
   * paged through, a round list scrolled back, a board searched — each went the moment its tab was
   * left or a player was opened from it. Each is left in a state of its own, taken away, and must
   * come back as it was, asking the API with it the first time.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const asked = { bans: [], kicks: [], matches: [], cam: [] };
  const audit = Array.from({ length: 120 }, (_, i) => ({ id: `a${i}`, ts: at, actorName: "owner", actorDisplayName: "owner", action: "player.kick", targetType: "player", targetId: `t${i}`, targetName: `Kicked ${i}`, summary: `kicked ${i}`, serverId: "s1" }));
  const rounds = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, map: "foy_warfare", startedAt: at, endedAt: at, durationSec: 3600, result: "Allies", score: "5-0" }));
  const votes = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, decidedAt: at, profile: null, winnerId: "foy", winnerName: "Foy", totalVotes: 3, outcome: "decided", applied: true,
    options: [{ id: "foy", name: "Foy", votes: 2 }, { id: "kursk", name: "Kursk", votes: 1 }] }));
  const doneLine = { id: "l1", seq: 0, serverId: "s1", capability: "action.kick", kind: "kick", payload: { reason: "x" }, playerId: "p1", playerName: "Caereca",
    state: "approved", decidedByName: "owner", decidedAt: at, denyReason: null, modified: null, appliedAt: at, applyError: null, canSign: false, signRefusal: null };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
        { id: "s2", name: "WW2 #2", game: "hll", engagementMode: "active" },
      ] } },
      "/api/bans": (url) => { asked.bans.push(url.searchParams); return { body: { bans: [] } }; },
      "/api/players/flagged": { body: { flags: [{ playerId: "p1", name: "Caereca", online: false, onlineServers: [], watchBy: "owner", watchAt: at, reasons: [] }] } },
      "/api/requests": { body: { mine: [{ id: "q1", requesterName: "tester", status: "resolved", note: null, submittedAt: at, expiresAt: at, own: true, lines: [doneLine] }], queue: [] } },
      "/api/servers/s1/mapvote/history": (url) => {
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
        return { body: { history: votes.slice(offset, offset + limit), total: votes.length, tally: [], voters: [] } };
      },
      "/api/requests/history": { body: { decisions: [{
        requestId: "r1", lineId: "l1", requesterName: "lead", filedAt: at, requestStatus: "done", kind: "kick", serverId: "s1", serverName: "WW2 #1",
        playerId: "p1", playerName: "Caereca", state: "approved", decidedByName: "owner", decidedAt: at, denyReason: null, applyError: null, modified: null, payload: { reason: "x" },
      }], limit: 200 } },
      "/api/audit": (url) => {
        if (!url.searchParams.get("actions")) return undefined;
        asked.kicks.push(url.searchParams);
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
        return { body: { entries: audit.slice(offset, offset + limit), total: audit.length } };
      },
      "/api/servers/s1/matches": (url) => {
        asked.matches.push(url.searchParams);
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
        return { body: { matches: rounds.slice(offset, offset + limit), total: rounds.length } };
      },
      "/api/admincam/history": (url) => {
        asked.cam.push(url.searchParams);
        return { body: { sessions: [], total: 0, admins: [{ playerId: "a1", playerName: "Admin One" }], servers: [{ id: "s2", name: "WW2 #2" }] } };
      },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const tab = async (label) => { await page.click(`.tabbar-tab:text-is('${label}')`); };
    const until = async (cond, what) => {
      for (let i = 0; i < 150 && !cond(); i++) await page.waitForTimeout(100);
      assert.ok(cond(), `timed out waiting for ${what}`);
    };

    // --- Bans: a search, lifted bans shown, one server. Away to another tab, and back.
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "networkidle" });
    const banSearch = page.getByPlaceholder("Search player, id, reason, staff, server…");
    await banSearch.fill("grief");
    await page.locator("label.toggle", { hasText: "Show lifted & expired" }).click();
    const banServer = page.locator("select[title^='Narrow the record']");
    await banServer.selectOption("s2");
    await until(() => asked.bans.some((sp) => sp.get("q") === "grief" && sp.get("history") === "1"), "the bans to be asked for with the search");
    let before = asked.bans.length;
    await tab("Watched");
    await tab("Bans");
    await banSearch.waitFor({ timeout: 15_000 });
    assert.equal(await banSearch.inputValue(), "grief", "the ban search came back");
    assert.equal(await page.locator("label.toggle", { hasText: "Show lifted & expired" }).locator("input").isChecked(), true, "and lifted bans shown");
    assert.equal(await banServer.inputValue(), "s2", "and the server");
    await until(() => asked.bans.length > before, "the bans read again");
    assert.deepEqual({ q: asked.bans[before].get("q"), history: asked.bans[before].get("history") }, { q: "grief", history: "1" }, "asking with them the first time");

    // --- The watchlist's search, and the request history's.
    await tab("Watched");
    const watchSearch = page.getByPlaceholder("Search names, reasons, staff…");
    await watchSearch.fill("smurf");
    await tab("Requests");
    const historySearch = page.getByPlaceholder("Filter by player, staff member, action or reason…");
    await historySearch.fill("tempban");
    const finished = page.locator("button", { hasText: "Completed (1)" });
    await finished.click();
    await tab("Watched");
    assert.equal(await watchSearch.inputValue(), "smurf", "the watchlist search came back");
    await tab("Requests");
    assert.equal(await historySearch.inputValue(), "tempban", "and the request history's");
    assert.equal(await finished.getAttribute("aria-expanded"), "true", "and finished requests still unfolded");

    // --- Kicks: a search and page two. Away to another tab, and back.
    await tab("Kicks");
    const kickSearch = page.getByPlaceholder("Search player, reason, staff…");
    await kickSearch.fill("spam");
    await until(() => asked.kicks.some((sp) => sp.get("q") === "spam"), "the kicks to be searched");
    await page.waitForFunction(() => /Page 1 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    before = asked.kicks.length;
    await tab("Bans");
    await tab("Kicks");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(await kickSearch.inputValue(), "spam", "the kicks search came back");
    assert.deepEqual({ q: asked.kicks[before].get("q"), offset: asked.kicks[before].get("offset") }, { q: "spam", offset: "50" }, "asking for the page left, with the search, the first time");

    // --- Matches: page two, a round opened from it, Back.
    await page.goto(`${base}#/history/matches`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Page 1 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.locator("tbody tr").first().click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/match/"), null, { timeout: 15_000 });
    before = asked.matches.length;
    await page.goBack();
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(asked.matches[before]?.get("offset"), "50", "the rounds came back on the page left");

    // --- Map votes: page two, one round's maps shown. Away to another tab, and back.
    await tab("Map votes");
    await page.waitForFunction(() => /Page 1 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.locator("button", { hasText: "Show the 2 maps" }).first().click();
    await page.waitForSelector("button:has-text('Hide the 2 maps')", { timeout: 15_000 });
    await tab("Matches");
    await tab("Map votes");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForSelector("button:has-text('Hide the 2 maps')", { timeout: 15_000 });

    // --- The admin camera: one server and one admin. Away to another tab, and back.
    await tab("Admin camera");
    const camServer = page.locator("label", { hasText: "Server" }).locator("select").first();
    const camAdmin = page.locator("label", { hasText: "Admin" }).locator("select").first();
    await camServer.selectOption("s2");
    await camAdmin.selectOption("a1");
    await until(() => asked.cam.some((sp) => sp.get("serverId") === "s2" && sp.get("playerId") === "a1"), "the camera log to be filtered");
    before = asked.cam.length;
    await tab("Matches");
    await tab("Admin camera");
    await until(() => asked.cam.length > before, "the camera log read again");
    assert.deepEqual({ serverId: asked.cam[before].get("serverId"), playerId: asked.cam[before].get("playerId") }, { serverId: "s2", playerId: "a1" }, "the camera log came back filtered");
    // Both lists fill in from the log's own reply, so the selects show what they hold once it is
    // drawn — not the moment it is asked for.
    const shows = async (select, want) => {
      for (let i = 0; i < 100 && (await select.inputValue()) !== want; i++) await page.waitForTimeout(100);
      return select.inputValue();
    };
    assert.equal(await shows(camServer, "s2"), "s2");
    assert.equal(await shows(camAdmin, "a1"), "a1");

    // --- Live: the board searched, a player opened from it, Back.
    await page.goto(`${base}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    const boardSearch = page.locator(".roster-filters .roster-search").first();
    const feedSearch = page.getByPlaceholder("Search these events…");
    // The feed first, its category and search, then back to the board for a player.
    await page.click(".seg-btn:text-is('Live feed')");
    await feedSearch.fill("garand");
    await page.click(".seg-btn:text-is('Kills')");
    await page.click(".seg-btn:text-is('Scoreboard')");
    await boardSearch.fill("Player 7");
    await page.locator(".player-link", { hasText: /^Player 7$/ }).first().click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/players/~"), null, { timeout: 15_000 });
    await page.goBack();
    await boardSearch.waitFor({ timeout: 15_000 });
    assert.equal(await boardSearch.inputValue(), "Player 7", "the board's search came back");
    await page.click(".seg-btn:text-is('Live feed')");
    assert.equal(await feedSearch.inputValue(), "garand", "and the feed's");
    await page.waitForSelector(".seg-btn.active:text-is('Kills')", { timeout: 15_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * "Lift all on this server" lifts everything the server enforces, so its confirmation counts
 * everything. It counted the screen's list, which a search typed above it narrows: "1 standing
 * decision" above a lift that took every one.
 */
test("Lift all's confirmation counts every ban on the server, whatever the search", { skip: SKIP }, async () => {
  const ban = (id, name) => ({ id, ts: new Date().toISOString(), by: "owner", playerName: name, playerId: id, platform: "steam", type: "perma", reason: "x", category: null, scope: { mode: "all" }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"] });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    // The API applies the search.
    "/api/bans": (url) => ({ body: { bans: url.searchParams.get("q") ? [ban("1", "Alpha")] : [ban("1", "Alpha"), ban("2", "Bravo"), ban("3", "Charlie")] } }),
  } }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/moderation/bans`, { waitUntil: "networkidle" });
    await page.locator("select[title^='Narrow the record']").selectOption("s1");
    await page.getByPlaceholder("Search player, id, reason, staff, server…").fill("alpha");
    await page.waitForFunction(() => !window.document.body.innerText.includes("Bravo"));
    await page.locator("button", { hasText: "Lift all on this server" }).click();
    const dialog = page.locator(".confirm-modal");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /\b3 standing decision/, "every ban the lift will reach");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});

test("first run: a wrong setup code is refused and says where the right one is — the owner form is not offered", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/me": { status: 401, body: { error: { message: "not signed in" } } },
    "/api/setup/status": { body: { needed: true, codeRequired: true, stage: null, route: "home" } },
    "/api/setup/verify": { status: 403, body: { error: { message: "that is not this install's setup code — it is shown in the window that started the panel" } } },
  } }, async (page, { errors }) => {
    await page.locator("h1", { hasText: "Set up your panel" }).waitFor({ timeout: 10_000 });
    await page.locator("label", { hasText: "Setup code" }).locator("input").fill("WRNG-CODE");
    await page.locator("button", { hasText: "Continue" }).click();
    await page.locator(".callout", { hasText: "window that started the panel" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator("h1", { hasText: "Create the owner account" }).count(), 0);
    // Someone who closed that window: the page says how to get the code back.
    assert.match(await page.locator("details").first().textContent(), /Lost it\? Run the start script again/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the tab you are on is visible in its own tab bar, however many tabs there are", { skip: SKIP }, async () => {
  /*
   * From a report with a screenshot: the Analytics hub was open on Staff, and Staff was not in the
   * tab bar. The bar scrolls, but it starts at zero — so with eight tabs and room for six, the last
   * two were off the right edge. Unreachable by clicking, with no scrollbar (hidden by design) and
   * no fade to say anything was there. You could only get to them by typing the URL, and once you
   * were there the bar still showed six other tabs and not the one you were on.
   *
   * This measures geometry, not markup: is the active tab's box actually inside the strip's box.
   */
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    // Narrow enough that the eight tabs genuinely do not fit. (The report's screenshot was a photo
    // of a laptop, so its CSS width was well under the image's pixel width — at 1206 the bar fits.)
    await page.setViewportSize({ width: 900, height: 900 });

    const box = async () => page.evaluate(() => {
      const strip = window.document.querySelector(".tabbar");
      const tab = strip?.querySelector('[aria-selected="true"]');
      if (!strip || !tab) return null;
      const s = strip.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      return {
        label: tab.textContent?.trim() ?? "",
        tabs: strip.querySelectorAll('[role="tab"]').length,
        overflows: strip.scrollWidth > strip.clientWidth + 2,
        inside: t.left >= s.left - 1 && t.right <= s.right + 1,
      };
    });

    // Land directly on the LAST tab, the way a bookmark or the command palette does.
    await page.goto(`${base}#/analytics/staff`, { waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar-tab", { timeout: 15_000 });
    const staff = await box();
    assert.ok(staff, "the analytics hub should render a tab bar with a selected tab");
    assert.ok(staff.tabs >= 7, `expected the hub's full tab set, got ${staff.tabs}`);
    assert.ok(staff.overflows, "this test only means something while the bar actually overflows");
    assert.match(staff.label, /staff/i, `the selected tab should be Staff, got "${staff.label}"`);
    assert.ok(staff.inside, "the tab you are on must be scrolled into view, not left off the edge");

    // The fade tells you there is more in that direction — the only signal, since the scrollbar is
    // hidden. Scrolled to the end, it must point back the way you came.
    const wrap = await page.locator(".tabbar-wrap").getAttribute("class");
    assert.match(wrap ?? "", /ov-(left|both)/, `expected an overflow hint pointing left, got "${wrap}"`);

    // And the first tab is reachable again from here: clicking it scrolls the bar back.
    await page.locator(".tabbar-tab").first().click();
    await page.waitForFunction(
      () => /server/i.test(window.document.querySelector('.tabbar [aria-selected="true"]')?.textContent ?? ""),
      null,
      { timeout: 15_000 },
    );
    const first = await box();
    assert.ok(first?.inside, "after switching back, the newly-active tab must be in view too");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/**
 * Every destination in the registry, opened against an API that answers `{}` for everything.
 *
 * A panel screen breaks in one particular way: some `data.thing.map(...)` on a response that came
 * back thinner than the component assumed, and React unmounts the whole tree — the reader gets a
 * blank page, not a broken panel. That is the failure a store that predates a feature produces, or
 * a server with no rounds yet, or a route the user lacks permission on. It has been swept by hand
 * twice; this is the sweep that runs every time, so the next screen added has to survive it too.
 *
 * `{}` is the honest worst case, not a contrived one: the stub answers every unfixtured path with
 * it, which is exactly what an endpoint returns before its feature has any data.
 */
test("no route white-screens on an empty API", { skip: SKIP }, async () => {
  // Read the destinations from the shipped registry rather than restating them here — a list that
  // has to be kept in sync by hand is a list that silently stops covering new screens.
  const src = await readFile(new URL("../lib/routes.ts", import.meta.url), "utf8");
  const paths = [...src.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length > 40, `expected the whole registry, found ${paths.length} paths`);

  // A fresh page per route, deliberately. A crash unmounts the React tree, and a hash change does
  // not reload the document — so on one shared page the first broken route makes every route after
  // it look broken too. The first version of this test reported thirty failures for one bug, which
  // is worse than reporting none: you cannot tell where to start.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    const base = page.url().split("#")[0];
    const broken = [];
    // Four routes at a time, each still on a page of its own: one after another, they took over a
    // minute and a half of every run.
    const queue = [...paths];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        // `newPage()` off the browser, not the context: the harness's page owns the default
        // context, which refuses a second page. Each route gets its own context and storage.
        const fresh = await page.context().browser().newPage();
        await fresh.addInitScript(() => window.localStorage.setItem("panel.token", "test-token"));
        let thrown = null;
        fresh.on("pageerror", (e) => { thrown ??= String(e).split("\n")[0]; });
        await fresh.goto(`${base}#${path}`, { waitUntil: "networkidle" }).catch(() => {});
        // The shell paints synchronously; give the view's first fetch a moment to land and throw.
        await fresh.waitForTimeout(200);
        const body = (await fresh.locator("body").innerText()).trim();
        // An uncaught error that did NOT blank the page is the same bug caught one render earlier,
        // so it fails too rather than waiting to become a white screen on somebody's install. And
        // a screen that crashed says so in its place (components/ScreenBoundary) rather than
        // blanking the page, which this sweep could not see until it read those words too.
        if (thrown || /Application error|client-side exception|could not be shown/i.test(body) || body.length < 20) {
          broken.push(`${path}: ${thrown ?? body.slice(0, 100) ?? "(empty page)"}`);
        }
        await fresh.close();
      }
    }));
    assert.deepEqual(broken, [], `these routes broke on an empty API:\n${broken.join("\n")}`);
  });
});

test("a Discord sign-in handoff in the URL fragment survives long enough to be read", { skip: SKIP }, async () => {
  /*
   * The callback hands the session token back as `https://panel/#discord_token=…`, and the shell
   * reads it out of the fragment on boot. Between those two things sits the hash router, which
   * adopts the URL on mount — and treated "not a route" as "no route yet", replacing the whole
   * fragment with the landing view.
   *
   * Both effects run on the same mount, and the router's is registered first (page.tsx calls
   * useHashRoute above the consuming effect), so the token was gone before anything read it. The
   * user lands back on the sign-in screen with no error and nothing in the logs — the sign-in
   * worked perfectly, the answer was thrown away on arrival.
   */
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    // A SEPARATE page, with no pre-seeded token and no prior document: a browser arriving fresh
    // from Discord holding nothing but the fragment. It has to be a new page — navigating the
    // existing one to a URL that differs only in its hash is a same-document navigation, so React
    // never re-mounts and the boot path under test never runs at all.
    const fresh = await page.context().browser().newPage();
    const freshErrors = [];
    fresh.on("pageerror", (e) => freshErrors.push(String(e)));
    await fresh.goto(`${base}#discord_token=handed-back-by-discord`, { waitUntil: "networkidle" });
    page = fresh;
    errors.push(...freshErrors);

    // The token reached storage, which is the whole job of the handoff.
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("panel.token")),
      "handed-back-by-discord",
      "the session token was dropped before the shell could read it",
    );
    // And the app is actually in — not sitting on the sign-in screen.
    await page.waitForSelector("nav, .sidebar, main", { timeout: 15_000 });
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /Sign in with Discord/i, "still on the sign-in screen after a successful sign-in");

    // The handoff is cleared from the URL once spent — a session token must not sit in history.
    assert.doesNotMatch(await page.evaluate(() => window.location.href), /discord_token/,
      "the token must not be left in the address bar");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A rule alert in Discord links the player's profile, and the person tapping it is often signed
 * out (a phone's in-app browser, a fresh device). Discord sign-in leaves the panel and comes back
 * to its root, which used to land them on the default screen with the profile lost. The sign-in
 * screen now holds the page for the trip, and the shell reopens it on return.
 */
test("Discord sign-in comes back to the page it started on, not the default screen", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/auth/status": { body: { hasUsers: true } },
    "/api/auth/discord/status": { body: { configured: true } },
  } }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    // Signed out, on a profile link: pressing the Discord button holds the page for the trip.
    const out = await page.context().browser().newPage();
    out.on("pageerror", (e) => errors.push(String(e)));
    await out.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await out.getByRole("button", { name: /Sign in with Discord/ }).click();
    await out.waitForURL(/\/api\/auth\/discord\/start/, { timeout: 10_000 });
    assert.equal(await out.evaluate(() => window.sessionStorage.getItem("panel.signin.return")), "#/players/~p1");
    await out.close();

    // Back from Discord with the token: the held page opens, and the token leaves the URL.
    const back = await page.context().browser().newPage();
    back.on("pageerror", (e) => errors.push(String(e)));
    await back.addInitScript(() => window.sessionStorage.setItem("panel.signin.return", "#/players/~p1"));
    await back.goto(`${base}#discord_token=handed-back-by-discord`, { waitUntil: "networkidle" });
    await back.waitForFunction(() => window.location.hash === "#/players/~p1", null, { timeout: 10_000 });
    assert.doesNotMatch(back.url(), /discord_token/, "the token must not be left in the address bar");
    for (let i = 0; i < 50 && !stub.requests.some((r) => r.startsWith("/api/players/p1")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(stub.requests.some((r) => r.startsWith("/api/players/p1")), "the profile itself was opened");
    assert.equal(await back.evaluate(() => window.sessionStorage.getItem("panel.signin.return")), null, "the held page is used once");
    await back.close();
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the open destination lists its tabs in the sidebar, so none is hidden past a scroll edge", { skip: SKIP }, async () => {
  // Administration carries ten tabs — more than fit the header strip at any normal width. The
  // sidebar lists them all, stacked, which is the only place every one is reachable by clicking.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/users`, { waitUntil: "networkidle" });
    await page.waitForSelector(".nav-subnav");

    const labels = await page.locator(".nav-subnav .nav-subitem").allInnerTexts();
    for (const want of ["Users & roles", "Connections", "Live settings", "Console admins", "RCON console", "VIP presets", "System"]) {
      assert.ok(labels.some((l) => l.trim() === want), `sidebar lists ${want} (got: ${labels.join(", ")})`);
    }
    // Map points was removed (Maps → Rotation sets objectives): not even the owner is offered it.
    assert.ok(!labels.some((l) => l.trim() === "Map points"), `no Map points tab (got: ${labels.join(", ")})`);
    // The tab you are on is marked, and a tab past the header's edge is one click away.
    assert.equal(await page.locator(".nav-subitem.active", { hasText: "Users & roles" }).count(), 1);
    await page.locator(".nav-subitem", { hasText: "RCON console" }).click();
    await page.waitForFunction(() => window.location.hash === "#/admin/console");
    assert.equal(await page.locator(".nav-subitem.active", { hasText: "RCON console" }).count(), 1);

    // A destination without tabs contributes no sub-nav at all.
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".nav-subnav").count(), 0, "a tabless destination shows no sub-nav");
  });
});

/*
 * The menu packs itself into the window it has. On a laptop (1366 × 768 leaves a browser about
 * 650px) it needed almost twice that: Maps, Auto settings, Discord, Analytics and Administration sat
 * below the edge, and on a section with tabs a dozen entries did. It now tightens a step at a time —
 * less air, a one-line host status, rules for headings — until it fits, and leaves an open section's
 * tabs to the page's own tab bar when that bar shows every one; on a tall window it stays as it was.
 */
test("the menu packs itself into a laptop's window, every screen in view, and stays roomy on a tall one", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const menu = () => page.evaluate(() => {
      const aside = window.document.querySelector(".sidebar"), nav = aside.querySelector(".nav");
      const n = nav.getBoundingClientRect();
      const out = [...nav.querySelectorAll(".nav-item, .nav-subitem")].filter((el) => el.offsetParent)
        .filter((el) => { const r = el.getBoundingClientRect(); return r.top < n.top - 1 || r.bottom > n.bottom + 1; })
        .map((el) => el.textContent.trim());
      const sub = nav.querySelector(".nav-subnav");
      const foot = aside.querySelector(".settings-trigger").getBoundingClientRect();
      return {
        fit: aside.dataset.fit ?? "", out, subnavShown: !!sub && window.getComputedStyle(sub).display !== "none",
        statusHeight: aside.querySelector(".host-status")?.getBoundingClientRect().height ?? 0,
        footInView: foot.bottom <= window.innerHeight + 1,
        headings: [...nav.querySelectorAll(".nav-group-label")].filter((el) => el.offsetParent).map((el) => el.textContent.trim()),
      };
    });
    // Exactly these steps: a wait that took "contains these" would pass on the last screen's steps
    // before the menu has fitted itself to the new one.
    const settled = (want) => page.waitForFunction((w) => (window.document.querySelector(".sidebar")?.dataset.fit ?? "") === w, want, { timeout: 5_000 });

    // A tall window: the menu as it always was, every heading written.
    await page.setViewportSize({ width: 1366, height: 1300 });
    await page.goto(`${base}#/dashboard`, { waitUntil: "networkidle" });
    await page.waitForSelector(".host-status .hs-stat");
    await settled("");
    let m = await menu();
    assert.deepEqual(m.out, [], "everything in view");
    assert.ok(m.headings.includes("Monitor") && m.headings.includes("Admin"), `headings written (${m.headings.join(", ")})`);

    // The same screen squeezed into a laptop's window, without a click: it packs itself.
    await page.setViewportSize({ width: 1366, height: 650 });
    await settled("snug tight lines");
    m = await menu();
    assert.deepEqual(m.out, [], `every screen in view (out of view: ${m.out.join(", ")})`);
    assert.ok(m.statusHeight < 36, `the host status on one line (${m.statusHeight}px)`);
    assert.ok(m.footInView, "the account row still on screen");

    // A section whose tabs the page's own bar shows in full: the menu leaves them to it.
    await page.goto(`${base}#/players/directory`, { waitUntil: "networkidle" });
    await settled("snug tight lines tabs-above");
    m = await menu();
    assert.equal(m.subnavShown, false, "the tabs are the page's to show");
    assert.deepEqual(m.out, [], `every screen in view (out of view: ${m.out.join(", ")})`);
    assert.ok(await page.locator(".hub-tabs .tabbar").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "and the page's bar does show every one");

    // Administration's thirteen tabs run past its bar's edge: the menu keeps listing them.
    await page.goto(`${base}#/admin/users`, { waitUntil: "networkidle" });
    await page.locator(".nav-subitem", { hasText: "Online access" }).waitFor();
    m = await menu();
    assert.equal(m.subnavShown, true, "the menu lists the tabs its bar cannot show");
    assert.ok(!m.fit.includes("tabs-above"), `no tabs-above here (${m.fit})`);
    // Scrolled by hand to look further up, the menu stays there while it fits itself again.
    await page.locator(".sidebar .nav").evaluate((nav) => { nav.scrollTop = 0; });
    await page.evaluate(() => window.dispatchEvent(new Event("panel:prefs")));
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".sidebar .nav").evaluate((nav) => nav.scrollTop), 0, "a fit that changed nothing moves nothing");

    // Between the two: a one-entry section loses its heading before any other does.
    await page.goto(`${base}#/dashboard`, { waitUntil: "networkidle" });
    await page.setViewportSize({ width: 1366, height: 780 });
    await settled("snug tight");
    m = await menu();
    assert.ok(!m.fit.includes("lines"), `not as tight as rules (${m.fit})`);
    assert.ok(m.headings.includes("Monitor") && m.headings.includes("Community"), `sections of several keep their headings (${m.headings.join(", ")})`);
    for (const one of ["Servers", "Automation", "Integrations"]) assert.ok(!m.headings.includes(one), `no heading over the one-entry ${one} (${m.headings.join(", ")})`);
    assert.deepEqual(m.out, [], `every screen in view (out of view: ${m.out.join(", ")})`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The screen size is kept per person on each device, under the name of whoever signed in — and
 * the name a browser opens with is the last person's to use it. Nothing read it again once a
 * sign-in landed, so the menu kept the last person's pick, or their Automatic, until a reload.
 */
test("on a shared computer, whoever signs in gets their own screen size at once, not the last person's", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.setViewportSize({ width: 1366, height: 1300 });
    const fit = () => page.evaluate(() => window.document.querySelector(".sidebar")?.dataset.fit ?? "");
    // The browser was last used by alice; this sign-in is tester's. First alice packed the menu
    // for a small laptop and tester never picked; then the other way round.
    for (const [mine, theirs, want] of [[null, "1280x720", ""], ["1280x720", null, "snug tight lines"]]) {
      await page.evaluate(([m, t]) => {
        window.localStorage.setItem("panel.username", "alice");
        window.localStorage.setItem("panel.prefs.alice", JSON.stringify(t ? { screenSize: t } : {}));
        window.localStorage.setItem("panel.prefs.tester", JSON.stringify(m ? { screenSize: m } : {}));
      }, [mine, theirs]);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".host-status .hs-stat");
      await page.waitForFunction((w) => {
        const aside = window.document.querySelector(".sidebar");
        return !!aside && (aside.dataset.fit ?? "") === w;
      }, want, { timeout: 5_000 }).catch(() => {});
      assert.equal(await page.evaluate(() => window.localStorage.getItem("panel.username")), "tester", "signed in as tester");
      assert.equal(await fit(), want, mine ? "tester's own pick packs the menu" : "tester's Automatic, not alice's small laptop");
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Collapsed to its icons, the menu packs itself as the full one does. The rail's own padding rules
 * outranked the first step's, so at a laptop's height it kept the 24px the step takes away, and
 * Administration's icon sat past the edge.
 */
test("collapsed to icons, the menu packs itself too: every icon in view on a laptop", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const settled = () => page.waitForFunction(() => window.document.querySelector(".sidebar")?.dataset.fit === "snug tight lines", null, { timeout: 5_000 });
    // The air the steps take off the sidebar's ends and off the account button.
    const air = () => page.evaluate(() => {
      const aside = window.document.querySelector(".sidebar");
      const pad = (el) => { const s = window.getComputedStyle(el); return [s.paddingTop, s.paddingBottom]; };
      return { ends: pad(aside), account: pad(aside.querySelector(".settings-trigger")) };
    });
    await page.setViewportSize({ width: 1366, height: 650 });
    await page.goto(`${base}#/dashboard`, { waitUntil: "networkidle" });
    await page.locator(".host-status .hs-stat").first().waitFor();
    await settled();
    const full = await air();
    await page.locator(".collapse-btn").click();
    await page.locator(".app-shell.collapsed").waitFor();
    await settled();
    assert.deepEqual(await air(), full, "the same steps take the same air off the rail as off the full menu");
    const m = await page.evaluate(() => {
      const aside = window.document.querySelector(".sidebar"), nav = aside.querySelector(".nav"), n = nav.getBoundingClientRect();
      const out = [...nav.querySelectorAll(".nav-item")].filter((el) => { const r = el.getBoundingClientRect(); return r.top < n.top - 1 || r.bottom > n.bottom + 1; })
        .map((el) => el.getAttribute("title") ?? el.textContent.trim());
      return { out, footInView: aside.querySelector(".settings-trigger").getBoundingClientRect().bottom <= window.innerHeight + 1 };
    });
    assert.deepEqual(m.out, [], `every icon in view (out of view: ${m.out.join(", ")})`);
    assert.ok(m.footInView, "the account button still on screen");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the match card states the round: sectors held, real VIPs, and each queue counter apart", { skip: SKIP }, async () => {
  // The fixture round is 2–3 with a full 40/40 queue, 2 reserved VIP slots, and 10 of the 98
  // players holding a VIP grant. Its `vipQueueCount` is the live server's 742 — a count that
  // cannot be a queue, because the server's own maximum for it is 2.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".live-summary", { timeout: 10_000 });

    // Sectors are drawn, one block per cap, coloured by holder — 5 blocks, 2 of them allied.
    await page.waitForSelector(".sector-bar .sector");
    assert.equal(await page.locator(".sector-bar .sector").count(), 5, "one block per sector");
    assert.equal(await page.locator(".sector-bar .sector.side-blue").count(), 2, "allied sectors");
    assert.equal(await page.locator(".sector-bar .sector.side-red").count(), 3, "axis sectors");

    const summary = await page.locator(".live-summary").innerText();
    // The two queue counters are reported as the game reports them, not summed into a number that
    // matches neither (40 + 2 = 42 used to be shown as "42 queued").
    assert.match(summary, /40\/40 queued/, "the general queue reports against its own maximum");
    assert.ok(!/742/.test(summary), "a VIP count that cannot be a queue is not shown as one");
    assert.ok(!/VIP queue/.test(summary), "…and the label is dropped with it");
    assert.match(summary, /2 VIP slots/, "the reserved-slot setting is named for what it is");
    assert.ok(!/782 queued/.test(summary), "the two counters are not summed");
    // VIPs come from live grants, so the count is real rather than perpetually zero.
    assert.match(summary, /10 VIP\b/, "counts players holding a VIP grant");
    assert.ok(!/Watched/i.test(summary), "the watched tally is gone from the match card");

    // Team stats moved inside the match card rather than sitting in a panel of their own.
    assert.equal(await page.locator(".live-summary .team-stats").count(), 1, "team stats live in the match card");
    // …and the leaderless-squad warning moved down to the roster it describes.
    assert.ok(!/No SL/.test(summary), "No-SL is no longer in the match summary");
  });
});

/**
 * The roster's action column: first, and alone.
 *
 * It used to be the LAST column of a table wider than any phone, carrying six shortcut icons —
 * watch, VIP, temp ban, perma ban, Discord and more — repeated on every one of a hundred rows.
 * Reaching them meant scrolling right until the player's name was off screen, which is the one
 * thing you need to still see when you are about to kick somebody, and every action they offered
 * was in the ⋯ menu beside them anyway. So: ⋯ only, first column, between the number and the
 * checkbox, with the same glyph in the header doing the whole selection at once.
 */
test("the roster acts from its first column, with nothing else in the way", { skip: SKIP }, async () => {
  const two = { "/api/servers/s1/live": { body: {
    players: [
      // playerDbId is what /live attaches server-side; the watchlist/comment/Discord items need it.
      { id: "p1", playerId: "76561198000000001", playerDbId: "db-1", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, vip: true, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 } },
      { id: "p2", playerId: "76561198000000002", playerDbId: "db-2", name: "OtherGuy", team: 1, unit: "BAKER", role: "rifleman", level: 20, stats: { infantryKills: 0, vehicleKills: 0, deaths: 0, teamKills: 0 } },
    ],
    session: { playerCount: 2, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 1, remainingMatchTime: 100, matchTime: 10 },
  } } };
  await withPage({ grants: OWNER_GRANTS, overrides: two }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });

    // Column order: the row number, then ⋯, then the checkbox. Read off the real first row.
    const shape = await page.evaluate(() => {
      const row = window.document.querySelector(".scoreboard tbody tr");
      const cells = [...(row?.children ?? [])];
      return {
        first: cells[0]?.textContent?.trim(),
        secondHasMenu: Boolean(cells[1]?.querySelector(".player-actions .pa-menu button")),
        thirdIsCheckbox: cells[2]?.querySelector('input[type="checkbox"]') !== null,
        // Everything the actions cell contains — one button and no shortcut icons.
        actionButtons: cells[1]?.querySelectorAll("button").length ?? 0,
      };
    });
    assert.equal(shape.first, "1", "row number leads");
    assert.ok(shape.secondHasMenu, "the ⋯ menu is the second cell");
    assert.ok(shape.thirdIsCheckbox, "the checkbox follows it");
    assert.equal(shape.actionButtons, 1, "one button in the actions cell — the ⋯ and nothing else");

    // The menu still opens and still holds the actions the icons used to duplicate.
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    const items = await page.locator(".pa-dropdown .pa-mi").allTextContents();
    for (const want of ["watchlist", "Temp ban", "Perma ban", "Discord"]) {
      assert.ok(items.some((t) => t.includes(want)), `the ⋯ menu still offers ${want} — got ${items.join(" | ")}`);
    }
    await page.keyboard.press("Escape");
  });
});

test("console admin is one click from the player's ⋯ menu, and gated on server.admins", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: ACTIVE_S1 }, async (page) => {
    const posted = [];
    await page.route("**/api/servers/*/admins", async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      posted.push(JSON.parse(r.request().postData() ?? "{}"));
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ applied: [{ serverName: "Test Server #1" }], skipped: [] }) });
    });
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    await page.locator(".pa-mi", { hasText: "Console admin" }).click();
    await page.waitForSelector(".pa-modal");

    // The groups are the SERVER's, read live — never a list the panel invented, because a name the
    // server doesn't know produces a grant the game refuses.
    await page.waitForFunction(() => (window.document.querySelectorAll(".pa-modal select option").length > 0), null, { timeout: 10_000 });
    assert.deepEqual(await page.locator(".pa-modal select option").allTextContents(), ["owner", "senior", "junior", "spectator"]);

    // Whoever the modal says it is about is who the request names — the bug this whole entry point
    // replaces was staff granting admin to the wrong person via a group.
    const heading = (await page.locator(".pa-modal h3").textContent()) ?? "";

    // Opens permanent, like the game's own notion of an admin; the expiry is the deliberate act.
    await page.locator(".pa-actions button:not(.ghost):not(.danger)").click();
    await page.waitForFunction(() => !window.document.querySelector(".pa-modal"), null, { timeout: 10_000 });
    assert.equal(posted.length, 1, "one grant posted");
    // The untouched default is SPECTATOR (admin camera, nothing else) — the game lists "owner"
    // first, and defaulting to it handed the keys to everything to every grant nobody re-read.
    assert.equal(posted[0].group, "spectator");
    assert.equal(posted[0].mode, "permanent");
    assert.ok(posted[0].playerId, "the request names a player");
    assert.ok(heading.includes(posted[0].playerName), `the modal named ${heading}, the request named ${posted[0].playerName}`);
    assert.equal(posted[0].allServers, false, "this server only unless asked");
  });

  // Same owner, one explicit block on server.admins: the item is not there to click.
  const blocked = [...OWNER_GRANTS, { capability: "server.admins", scopeType: "global", scopeId: null, level: "none" }];
  await withPage({ grants: blocked, overrides: ACTIVE_S1 }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    const items = await page.locator(".pa-dropdown .pa-mi").allTextContents();
    assert.ok(items.length > 0, "the menu still opens for everything else");
    assert.ok(!items.some((t) => t.includes("Console admin")), `no console admin without the capability — got ${items.join(" | ")}`);
  });
});

/**
 * An expanded moderation row must sit UNDER its summary line, not beside it.
 *
 * The detail panel was appended as a second child of `.mod-row`, which was a horizontal flex
 * container from back when a row was only its one-line summary. So the two laid out side by side:
 * the head kept `width: 100%`, the detail got squeezed to a sliver at the right edge — an 80-
 * character server name rendering one character per line — and `align-items: center` floated the
 * head in the middle of the thousand-pixel column of vertical text it had just created.
 *
 * Nothing that only asks "did the detail render?" sees any of that; it rendered perfectly. So this
 * measures: the detail starts below the head, it is most of the row's width rather than a sliver,
 * and the long server name has not pushed the page sideways.
 */
test("an expanded moderation record lays out under its row, not beside it", { skip: SKIP }, async () => {
  const LONG = "The [LYNX] Division #1 | MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED, LVL 100+ COMMANDER ENFORCED";
  const overrides = {
    "/api/servers": { body: { servers: [{ id: "s1", name: LONG, game: "hll", engagementMode: "observe" }] } },
    "/api/players/p1": { body: {
      player: { id: "p1", name: "Caereca", platform: "steam", platformId: "76561198000000001", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-07-31T10:00:00.000Z" },
      stats: { kills: 1, deaths: 1, teamkills: 0 },
      flags: { watchlist: false, vip: false, updatedByName: null },
      canViewNotes: true, notes: [], statsByServer: [], sessions: [], recentEvents: [],
      canViewModeration: true,
      moderation: [{
        id: "m1", ts: "2026-06-30T12:00:00.000Z", action: "player.message", serverId: "s1",
        actorUserId: "u1", actorName: "kreitz", actorDisplayName: "KREITZ [LYNX]",
        targetId: "p1", targetName: "Caereca", targetDisplayName: "Caereca", targetPlatformId: "76561198000000001",
        summary: "sent a message to Caereca",
        data: { message: "Mics are mandatory on this server — please join squad voice." },
      }],
    } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.locator(".mod-head").first().click();
    await page.waitForSelector(".mod-detail", { timeout: 10_000 });

    const geom = await page.evaluate(() => {
      const row = window.document.querySelector(".mod-row.open");
      const head = row.querySelector(".mod-head").getBoundingClientRect();
      const detail = row.querySelector(".mod-detail").getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return {
        stacked: detail.top >= head.bottom - 1,
        detailWidthShare: detail.width / r.width,
        // Rounding leaves the head a pixel short of the row's padding box; 3px is slack, not a gap.
        headFillsRow: Math.abs(head.width - detail.width) <= 3,
        pageOverflows: window.document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    assert.ok(geom.stacked, "the detail starts below the head, not alongside it");
    assert.ok(geom.detailWidthShare > 0.8, `the detail gets the row's width, not a sliver (got ${(geom.detailWidthShare * 100).toFixed(0)}%)`);
    assert.ok(geom.headFillsRow, "head and detail are the same width — they are stacked siblings");
    assert.ok(!geom.pageOverflows, "an 80-character server name does not push the page sideways");

    // And the record is actually readable: the server, and what was said.
    const text = (await page.locator(".mod-detail").textContent()) ?? "";
    assert.match(text, /MIC'S MANDATORY/, "the server it happened on");
    assert.match(text, /please join squad voice/, "the message that was sent");
  });
});

/*
 * Who did it is the first thing a moderation record is read for. On a phone each row's line was cut
 * off at the edge, which is where "· by" and the name came, and the opened record listed the
 * server, the reason and the game id but never who. A watch has no record to open at all.
 */
test("a moderation record names who did it, on a phone too", { skip: SKIP }, async () => {
  const BY = "Rookie Wrangler [LYNX]";
  const overrides = {
    "/api/players/p1": { body: {
      player: { id: "p1", name: "OGSharkSmuggler", platform: "steam", platformId: "76561198000000001", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-10-14T10:00:00.000Z" },
      stats: { kills: 1, deaths: 1, teamkills: 0 },
      flags: { watchlist: true, vip: false, updatedByName: null },
      canViewNotes: true, notes: [], statsByServer: [], sessions: [], recentEvents: [],
      canViewModeration: true, canViewWatch: true,
      moderation: [{
        id: "m1", ts: "2026-10-14T12:00:00.000Z", action: "player.permaban", serverId: "s1",
        actorUserId: "u2", actorName: "rookie", actorDisplayName: BY,
        targetId: "p1", targetName: "OGSharkSmuggler", targetDisplayName: "OGSharkSmuggler", targetPlatformId: "76561198000000001",
        summary: "ran permaban on OGSharkSmuggler — Running command over",
        data: { reason: "Running command over" },
      }],
      watchHistory: [{ id: "w1", reason: "Runs the command over in every match, warned twice", watchedBy: BY, watchedAt: "2026-10-13T12:00:00.000Z", removedBy: null, removedAt: null }],
    } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    const rows = page.locator(".mod-row");
    await rows.first().waitFor({ timeout: 10_000 });
    // Each row's line whole, wrapping onto a second line rather than hidden past the edge.
    const lines = await page.locator(".mod-main").evaluateAll((els) => els.map((e) => ({ text: e.textContent ?? "", cut: e.scrollWidth > e.clientWidth + 1 })));
    assert.equal(lines.length, 2, "the ban and the watch");
    for (const line of lines) {
      assert.match(line.text, /by Rookie Wrangler \[LYNX\]/, `who did it: ${line.text}`);
      assert.equal(line.cut, false, `nothing cut off: ${line.text}`);
    }
    // The opened record names who too.
    await rows.filter({ hasText: "Perma ban" }).locator(".mod-head").click();
    const detail = page.locator(".mod-detail");
    await detail.waitFor();
    const facts = await detail.locator("dt").evaluateAll((dts) => dts.map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? ""]));
    assert.ok(facts.some(([k, v]) => k === "By" && v === BY), `the record says who: ${JSON.stringify(facts)}`);
    assert.equal(await page.evaluate(() => window.document.documentElement.scrollWidth > window.innerWidth + 1), false, "the page does not scroll sideways");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a ban can name several servers, and says so before it fires", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: TWO_SERVERS }, async (page) => {
    const posted = [];
    await page.route("**/api/servers/*/actions", async (r) => {
      posted.push(JSON.parse(r.request().postData() ?? "{}"));
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, action: "permaban", results: [{ serverId: "s1", serverName: "#1", ok: true }, { serverId: "s2", serverName: "#2", ok: true }], applied: 2, failed: 0 }) });
    });
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    await page.locator(".pa-mi", { hasText: "Perma ban" }).click();
    await page.waitForSelector(".pa-modal");

    // Opens on "Only these" with the pinned server ticked and nothing else — reaching further is
    // always a deliberate act.
    const picker = page.locator(".scope-pick");
    await picker.waitFor();
    assert.equal(await picker.locator(".scope-chip.on").count(), 1, "starts on the pinned server alone");
    assert.match((await picker.locator(".scope-pick-note").textContent()) ?? "", /exactly these, not any added later/);

    await page.locator(".scope-pick .seg-btn", { hasText: "Everywhere" }).first().click();
    // "Everywhere" is a rule, not a set of ticks, so the chips go away entirely — and the note has
    // to say the part that no count can: a server built next month is covered too.
    assert.equal(await picker.locator(".scope-chip").count(), 0, "a rule has nothing to tick");
    assert.match((await picker.locator(".scope-pick-note").textContent()) ?? "", /any added later/);

    await page.locator(".pa-fields input").first().fill("cheating");
    await page.locator(".pa-actions button:not(.ghost)").click();
    await page.waitForFunction(() => !window.document.querySelector(".pa-modal"), null, { timeout: 10_000 });

    assert.equal(posted.length, 1, "one request, not one per server");
    // The RULE goes over the wire, not its expansion. Sending ["s1","s2"] would look identical to
    // ticking both by hand, and the difference is the whole point.
    assert.deepEqual(posted[0].scope, { mode: "all" }, "the rule is what is sent");
    assert.equal(posted[0].serverIds, undefined, "the old expanded list is not sent alongside it");
    assert.equal(posted[0].action, "permaban");
  });
});

test("a single-server ban sends no serverIds at all", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: TWO_SERVERS }, async (page) => {
    const posted = [];
    await page.route("**/api/servers/*/actions", async (r) => {
      posted.push(JSON.parse(r.request().postData() ?? "{}"));
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, action: "permaban", results: [{ serverId: "s1", serverName: "#1", ok: true }], applied: 1, failed: 0 }) });
    });
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    await page.locator(".pa-mi", { hasText: "Perma ban" }).click();
    await page.locator(".pa-fields input").first().fill("cheating");
    await page.locator(".pa-actions button:not(.ghost)").click();
    await page.waitForFunction(() => !window.document.querySelector(".pa-modal"), null, { timeout: 10_000 });

    // The ordinary case is untouched: one server, the old body shape, no fan-out.
    assert.equal(posted.length, 1);
    assert.equal(posted[0].serverIds, undefined, "the default ban is still a plain single-server call");
    assert.equal(posted[0].scope, undefined, "…and carries no scope either — the path names the server");
  });
});

test("removing a temp ban offers the picker even though it asks for nothing else", { skip: SKIP }, async () => {
  // Unbans have no fields, so they used to be a straight confirm dialog with no room to say "and
  // on the other server too" — the exact half-lift that leaves someone banned somewhere. They are
  // only offered where the panel KNOWS about a ban, which is the profile, not the live roster.
  const overrides = {
    ...TWO_SERVERS,
    "/api/players/p1": { body: {
      player: { id: "p1", name: "TestGuy", platform: "steam", platformId: "76561198000000001", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-07-31T10:00:00.000Z" },
      stats: { kills: 1, deaths: 1, teamkills: 0 },
      flags: { watchlist: false, vip: false, updatedByName: null },
      canViewNotes: true, notes: [], statsByServer: [], sessions: [], recentEvents: [],
      banStatus: { tempBan: { ts: "2026-08-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z", reason: "cheating" }, permaBan: null },
    } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    const posted = [];
    await page.route("**/api/servers/*/actions", async (r) => {
      posted.push(JSON.parse(r.request().postData() ?? "{}"));
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, action: "unban_temp", results: [{ serverId: "s1", serverName: "#1", ok: true }, { serverId: "s2", serverName: "#2", ok: true }], applied: 2, failed: 0 }) });
    });
    await page.goto(`${page.url().split("#")[0]}#/players/~p1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".pa-profile .pa-menu button", { timeout: 15_000 });
    await page.locator(".pa-profile .pa-menu button").click();
    await page.locator(".pa-mi", { hasText: "Remove temp ban" }).click();

    // A modal, not a bare confirm — because there is now a choice to make.
    await page.waitForSelector(".pa-modal .scope-pick", { timeout: 10_000 });
    await page.locator(".scope-pick .seg-btn", { hasText: "Everywhere" }).first().click();
    await page.locator(".pa-actions button:not(.ghost)").click();
    await page.waitForFunction(() => !window.document.querySelector(".pa-modal"), null, { timeout: 10_000 });
    assert.deepEqual(posted[0].scope, { mode: "all" }, "the unban reaches every server, now and later");
  });
});

test("the ban list lifts every server the player is banned on — unless you untick one", { skip: SKIP }, async () => {
  // One row is one DECISION, and its rule already says which servers it covers. The confirm opens
  // with all of them ticked — lifting one at a time is the half-unban this model exists to stop —
  // and still lets a single one be dropped, because "lift it on this server only" is a decision
  // staff genuinely make.
  const overrides = {
    ...TWO_SERVERS,
    "/api/bans": { body: { bans: [
      { id: "b1", ts: "2026-08-01T00:00:00.000Z", by: "admin", playerName: "Griefer", playerId: "76561198000000009", type: "perma", reason: "cheating", category: null, scope: { mode: "all" }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1", "s2"] },
    ] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    const posted = [];
    await page.route("**/api/servers/*/actions", async (r) => {
      posted.push({ url: r.request().url(), body: JSON.parse(r.request().postData() ?? "{}") });
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, action: "unban_perma", results: [{ serverId: "s2", serverName: "#2", ok: true }], applied: 1, failed: 0 }) });
    });
    await page.locator(".nav-item", { hasText: "Moderation" }).first().click();
    await page.waitForSelector(".scroll-x table tbody tr", { timeout: 15_000 });
    await page.locator("tbody tr", { hasText: "Griefer" }).first().locator("button", { hasText: "Unban" }).click();

    const picker = page.locator(".confirm-modal .scope-pick");
    await picker.waitFor({ timeout: 10_000 });
    assert.equal(await picker.locator(".scope-chip.on").count(), 2, "both of the player's bans start ticked");

    // Drop the first server. The dialog says what that leaves behind.
    await picker.locator(".scope-chip").first().click();
    await picker.locator(".scope-pick-note", { hasText: "Still banned on 1" }).waitFor({ timeout: 10_000 });

    const fired = page.waitForRequest((r) => r.url().includes("/actions") && r.method() === "POST", { timeout: 10_000 });
    await page.locator(".confirm-modal .pa-actions button.danger").click();
    await fired;
    assert.equal(posted.length, 1, "one request for the whole lift");
    assert.equal(posted[0].body.serverIds, undefined, "one server left ticked means a plain single-server unban");
    assert.match(posted[0].url, /\/servers\/s2\/actions$/, "and it is aimed at the server that stayed ticked");
  });
});

test("a player past the team-kill threshold is marked, and one below it is not", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    const flagged = page.locator(".scoreboard tbody tr.tk-flag");
    assert.equal(await flagged.count(), 1, "exactly the one player over the threshold");
    assert.match((await flagged.first().textContent()) ?? "", /Griefer/);
    // The marking has to be visible, not just a class name: a highlight nobody can see is not one.
    const tinted = await flagged.first().locator("td").first().evaluate((el) => window.getComputedStyle(el).backgroundColor);
    assert.notEqual(tinted, "rgba(0, 0, 0, 0)", "the flagged row is actually tinted");
  });
});

test("a tap anywhere else closes the player menu, and a tap inside it does not", { skip: SKIP }, async () => {
  // On a phone the menu had no way off it. It dismissed on `onMouseLeave` — a pointer leaving a
  // box, which a touchscreen never sends — so it opened and then stayed, a fixed panel over the
  // page. Escape is no help either: there is no keyboard. `pointerdown` is dispatched directly
  // here rather than clicked, because a Playwright click MOVES the mouse and would fire the old
  // mouseleave path, hiding whether the fix is present at all.
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER, viewport: { width: 390, height: 780 } }, async (page) => {
    // By hash, not by the nav: on a phone the nav lives in a drawer.
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    await page.waitForSelector(".pa-dropdown");

    // Inside the menu: still open, or its own items would never fire.
    await page.locator(".pa-dropdown .pa-mi").first().dispatchEvent("pointerdown");
    await page.waitForTimeout(50);
    assert.equal(await page.locator(".pa-dropdown").count(), 1, "a tap on an item does not dismiss the menu");

    // Outside it: gone.
    await page.locator(".scoreboard-summary").first().dispatchEvent("pointerdown");
    await page.waitForSelector(".pa-dropdown", { state: "detached", timeout: 5_000 });
  });
});

/*
 * iPhone Safari zooms the page into any focused field whose text is under 16px, and stays zoomed.
 * On a touch screen the panel's fields are 1rem for that reason - but with the Small text size
 * picked, 1rem is 14.4px, and every field zoomed the page again.
 */
test("on a phone a field's text stays at 16px with the Small text size, so the iPhone does not zoom", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    await page.locator(".seg-btn", { hasText: /^Small$/ }).first().click();
    await page.waitForFunction(() => parseFloat(window.getComputedStyle(window.document.documentElement).fontSize) < 15, null, { timeout: 10_000 });
    await page.goto(`${base}#/players/directory`, { waitUntil: "networkidle" });
    const field = page.getByPlaceholder("Search name or ID…");
    await field.waitFor({ timeout: 10_000 });
    const size = await field.evaluate((el) => parseFloat(window.getComputedStyle(el).fontSize));
    assert.ok(size >= 16, `the search field's text is ${size}px; under 16px the iPhone zooms the page into it`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("text size scales the whole panel and survives a reload", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    const rootPx = () => page.evaluate(() => parseFloat(window.getComputedStyle(window.document.documentElement).fontSize));
    const before = await rootPx();

    await page.goto(`${page.url().split("#")[0]}#/settings`, { waitUntil: "networkidle" });
    await page.locator(".seg-btn", { hasText: "Larger" }).first().click();
    await page.waitForFunction((was) => parseFloat(window.getComputedStyle(window.document.documentElement).fontSize) > was + 1, before, { timeout: 10_000 });

    // And it must be applied BEFORE paint on the next load, not corrected afterwards — otherwise
    // every page load reflows the whole app in front of the reader.
    await page.reload({ waitUntil: "domcontentloaded" });
    const after = await rootPx();
    assert.ok(after > before + 1, `text size did not persist (${before} → ${after})`);
    const inline = await page.evaluate(() => window.document.documentElement.style.getPropertyValue("--font-scale"));
    assert.equal(inline.trim(), "1.25", "the pre-paint script applied the stored scale");
  });
});

test("pull to refresh: a drag on a surface that takes drags for itself is left alone", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: PHONE }, async (page, { stub }) => {
    // A surface that pans under the finger (touch-action: none) — the live map is one. Dragging down
    // it at the top of the page is a pan; the dial used to rise and arm over the map mid-pan.
    await page.evaluate(() => {
      const box = window.document.createElement("div");
      box.id = "own-gestures";
      box.style.cssText = "position:fixed;top:100px;left:0;right:0;height:300px;touch-action:none;z-index:200;background:#111";
      window.document.body.appendChild(box);
    });
    await page.waitForTimeout(100);
    const before = apiCalls(stub);
    let armedDuringDrag = false;
    await touchDrag(page, 200, 150, 420, {
      atFullPull: async () => { armedDuringDrag = (await page.locator(".ptr.on").count()) > 0; },
    });
    await page.waitForTimeout(500);
    assert.equal(armedDuringDrag, false, "no dial while the finger was down");
    assert.equal(apiCalls(stub), before, "and nothing was fetched again");
  });
});

/*
 * Panel arrangement — the dashboard's layout treatment on a Panel screen.
 *
 * "Arrange panels" is the whole path: enter the mode, move a panel, narrow one, hide one, and
 * leave. The arrangement must survive a reload (the localStorage cache), and the server must have
 * been told (a PUT to the panel: surface with exactly the strict shape the API stores) — that PUT
 * is what makes the arrangement follow the account to another browser.
 */
test("panels: arrange mode — reorder, width, hide, and the save that follows", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/system`, { waitUntil: "networkidle" });
    await page.waitForSelector("button.panel-reset");

    // Everyday mode: no arrange controls, bodies visible.
    assert.equal(await page.locator(".panel-edit-controls").count(), 0, "arrange controls only exist in arrange mode");
    await page.click("button.panel-reset"); // "⧉ Arrange panels"
    await page.waitForSelector(".panel-group.editing");

    // Bodies compress away so the page becomes a compact arrangeable grid.
    assert.equal(await page.locator(".panel-group.editing .panel-body:visible").count(), 0, "bodies hide while arranging");

    // Move "System" later: its CSS order swaps with the next panel's.
    const orderIs = (title, n) => page.waitForFunction(([t, want]) => {
      const p = [...window.document.querySelectorAll(".panel")].find((el) => el.querySelector(".panel-title")?.textContent === t);
      return p && Number(p.style.order) === want;
    }, [title, n]);
    await orderIs("System", 0);
    await page.click('button[aria-label="Move System later"]');
    await orderIs("System", 1); // System moved one slot later…
    await orderIs("Services", 0); // …and Services took the first slot

    // Width: half the row = an inline span of 6 (the grid is 12 columns).
    const spanIs = (title, span) => page.waitForFunction(([t, want]) => {
      const p = [...window.document.querySelectorAll(".panel")].find((el) => el.querySelector(".panel-title")?.textContent === t);
      return p && p.style.gridColumn === want;
    }, [title, span]);
    await page.click('button[aria-label="Set System to ½ width"]');
    await spanIs("System", "span 6");

    // Hide the plugins panel: ghosted while arranging, gone once done.
    await page.click('button[aria-label="Hide Loaded plugins"]');
    await page.waitForSelector(".panel.hidden-panel", { timeout: 5000 }); // stays visible (ghosted) while arranging
    await page.click(".panel-toolbar button.mini.primary"); // Done — also flushes the save immediately
    await page.waitForFunction(() => !window.document.querySelector(".panel-group.editing"));
    assert.ok(!(await page.evaluate(() => window.document.body.innerText)).includes("Loaded plugins"), "the hidden panel left the page");

    // The save carried the strict shape the API stores, to the panel: surface for this view.
    for (let i = 0; i < 50 && !stub.calls.some((c) => c.method === "PUT" && c.path === "/api/layout/panel:system"); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const put = stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/layout/panel:system").at(-1);
    assert.ok(put, "the arrangement was saved server-side");
    assert.equal(put.body?.scope, "user");
    assert.deepEqual(put.body?.config?.hidden, ["plugins"]);
    assert.equal(put.body?.config?.widths?.host, 6);
    assert.deepEqual(put.body?.config?.order?.slice(0, 2), ["services", "host"]);

    // Out of arrange mode the button owns up to what's hidden, so a missing panel has a thread
    // to pull rather than looking deleted.
    assert.match(await page.locator("button.panel-reset").innerText(), /1 hidden/);

    // Reload: the arrangement holds (localStorage cache; the stub has no server copy to offer).
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("button.panel-reset");
    await spanIs("System", "span 6"); // width survived the reload
    assert.ok(!(await page.evaluate(() => window.document.body.innerText)).includes("Loaded plugins"), "hidden survived the reload");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The server's copy of a panel arrangement wins over an empty browser: a layout saved on one
 * machine (the PUT above) must arrange the page on another, where localStorage knows nothing.
 */
test("panels: a server-side arrangement applies on a fresh browser", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/layout/panel:system": { body: { surface: "panel:system", source: "user", config: {
        order: ["services", "host"], collapsed: [], hidden: ["auto-activity"], widths: { host: 6 }, touched: false, reordered: true,
      } } },
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/system`, { waitUntil: "networkidle" });
    // The config arrives by fetch after first paint; wait for it to take hold.
    await page.waitForFunction(() => {
      const p = [...window.document.querySelectorAll(".panel")].find((el) => el.querySelector(".panel-title")?.textContent === "System");
      return p && p.style.gridColumn === "span 6";
    });
    const orders = await page.evaluate(() => Object.fromEntries(
      [...window.document.querySelectorAll(".panel")].map((el) => [el.querySelector(".panel-title")?.textContent, Number(el.style.order)]),
    ));
    assert.ok(orders["Services"] < orders["System"], "the saved order (Services first) applied");
    assert.ok(!(await page.evaluate(() => window.document.body.innerText)).includes("Automated activity"), "the server-hidden panel is off the page");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A profile asked for every block's data whatever its reader could see: IP history, VIP history and
 * the group chips were refused reads on every visit by a Viewer. And IP history hid itself on any
 * failure, so a read that broke looked like a permission nobody holds.
 */
test("a profile asks only for the blocks its reader may see, and its IP history says a failed read", { skip: SKIP }, async () => {
  const profile = { body: {
    player: { id: "p1", platformId: "76561198000000001", platform: "steam", name: "Subject", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
    stats: { kills: 1, deaths: 1, teamkills: 0, playtimeSec: 60, visits: 1 },
    flags: {}, recentEvents: [], sessions: [], aliases: [], matches: [], canViewNotes: false, notes: [],
  } };
  const viewer = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  await withPage({ grants: viewer, overrides: { "/api/players/p1": profile } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/~p1`, { waitUntil: "networkidle" });
    await page.locator("h1", { hasText: "Subject" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const asked = stub.calls.map((c) => c.path);
    assert.ok(!asked.includes("/api/players/p1/ips"), "no IP history read");
    assert.ok(!asked.includes("/api/players/p1/vip-history"), "no VIP history read");
    assert.ok(!asked.some((p) => p.startsWith("/api/player-groups/for/")), "no group read");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/players/p1": profile, "/api/players/p1/ips": { status: 500, body: { error: "the database is not answering" } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/~p1`, { waitUntil: "networkidle" });
    await page.locator("button.panel-toggle", { has: page.locator(".panel-title", { hasText: /^IP history$/ }) }).click();
    await page.getByText("Couldn't read the IP history").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * VIPs & watched said "Couldn't load this server's VIPs" when the VIP list failed, but "No watched
 * players" and "Watched (0)" when the watchlist did.
 */
test("the dashboard's Watched tab says when the watchlist couldn't be read", { skip: SKIP }, async () => {
  const card = { id: "dash-vips-watched", title: "VIPs & watched", visible: true, order: 10, required: false, size: { w: 4, h: 2 } };
  await withPage({
    grants: [{ capability: "server.view", level: "read", scopeType: "global", scopeId: null }],
    overrides: {
      "/api/layout/dashboard": { body: { source: "default", widgets: [card] } },
      "/api/players/flagged": { status: 500, body: { error: "the database is not answering" } },
    },
  }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/dashboard`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't load the watchlist.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No watched players.").count(), 0);
    assert.deepEqual(await page.locator(".vw-tab").allInnerTexts(), ["Watched"], "no count it never read");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Sign-in & roles turned each failed read into a claim: "create at least one role first", "sign-in
 * isn't configured yet", "the bot token + guild id aren't set". And a role picker whose list failed
 * sent staff to set up the bot.
 */
test("Discord role lists that couldn't be read say so, not that something isn't set up", { skip: SKIP }, async () => {
  const down = { status: 500, body: { error: "the database is not answering" } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/roles": down, "/api/discord/role-map": down, "/api/discord/roles": down } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/discord/signin`, { waitUntil: "networkidle" });
    await panelTitled(page, "Sign-in & roles").waitFor({ timeout: 10_000 });
    await page.getByText("Couldn't read the panel's roles").waitFor({ timeout: 10_000 });
    await page.getByText("Couldn't read the role mapping").waitFor();
    await page.getByText("Couldn't read the Discord server's roles").waitFor();
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /Create at least one role first/);
    assert.doesNotMatch(body, /Sign-in isn.t configured yet/);
    assert.doesNotMatch(body, /bot token \+ guild id aren.t set/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/discord/roles": down,
    "/api/app-config": { body: { config: { roleBadges: [{ emoji: "⭐", label: "Member", roleIds: [] }] } } },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/discord/setup`, { waitUntil: "networkidle" });
    const badges = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Community badges" }) });
    await badges.getByText("Couldn't read the Discord role list").waitFor({ timeout: 10_000 });
    assert.equal(await badges.getByText("No roles readable").count(), 0, "not told to set up the bot");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  // The economy's role gates, the same.
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/discord/roles": down,
    "/api/economy/config": { body: { config: {
      currencyName: "Points", balanceCap: null,
      claims: { daily: { enabled: true, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: false, minAmount: 1, maxAmount: null }, vipGifting: { enabled: false, roleIds: [] }, offers: [],
      registration: { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, bonusPerGame: false, gameRoles: {}, serverIds: [] }, updatedAt: "2026-07-01T00:00:00.000Z",
    } } },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/economy`, { waitUntil: "networkidle" });
    const gate = page.locator("details", { hasText: "Who can claim" }).first();
    await gate.locator("summary").click();
    await gate.getByText("Couldn't read the Discord role list").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  // A payout split by role had empty pickers and no word why.
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/discord/roles": down } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/events/payouts`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Split by role/ }).click();
    await page.getByText("Couldn't read the Discord role list").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Users & roles drew a permission editor with nothing in it when the permission list failed to
 * load, and said nothing.
 */
test("Users & roles says when the permission list couldn't be read", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/capabilities": { status: 500, body: { error: "the database is not answering" } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/users`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the permission list").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The dashboard's card picker says "Saved to your account", and a save that failed kept the card
 * as picked anyway — the next visit put it back without a word.
 */
test("a dashboard card shown or hidden that couldn't be saved goes back, and says why", { skip: SKIP }, async () => {
  const card = { id: "dash-recent", title: "Recent activity", visible: true, order: 10, required: false, size: { w: 2, h: 2 } };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/layout/dashboard": (url, req) => (req.method === "PUT"
      ? { status: 500, body: { error: "the database is not answering" } }
      : { body: { source: "default", widgets: [card] } }),
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Widgets" }).click();
    const item = page.locator(".widget-picker-item", { hasText: "Recent activity" });
    await item.locator("label.toggle").click();
    await page.locator(".dash-head .muted", { hasText: "Error:" }).waitFor({ timeout: 10_000 });
    assert.equal(await item.getByRole("checkbox").isChecked(), true, "the card is shown again");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * An analytics page whose read failed said so once, at its top, and then drew every panel below
 * over no data — "nobody played in this window", dashes, empty charts: an empty window, which is a
 * different and wrong statement.
 */
test("analytics panels say their read failed, not that the window was empty", { skip: SKIP }, async () => {
  const down = { status: 500, body: { error: "the database is not answering" } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/analytics/server": down, "/api/analytics/combat": down } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/analytics/server`, { waitUntil: "networkidle" });
    await page.locator(".panel", { hasText: "Daily trend" }).getByText("Couldn't read this.").waitFor({ timeout: 10_000 });
    const overview = page.locator(".panel", { hasText: "the window at a glance" });
    assert.match(await overview.innerText(), /HTTP 500/, "the error is said at the top");
    assert.equal(await overview.getByText("Couldn't read this.").count(), 0, "and not again under it");
    assert.doesNotMatch(await page.locator("main").innerText(), /nobody played in this window/);
    await page.goto(`${stub.base}/#/analytics/combat`, { waitUntil: "networkidle" });
    await page.locator(".panel", { hasText: "Top killers" }).getByText("Couldn't read this.").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The match board's corner badge shipped inside the program, so every install's board wore one
 * community's badge. It is uploaded here now: none until somebody uploads one, the file's own bytes
 * sent, shown, replaced and removed. A reader, or a manager of one server, sees it and is offered
 * nothing to change.
 */
test("the match board badge is uploaded, shown and removed here, and a reader or one server's manager only sees it", { skip: SKIP }, async () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  let stored = false;
  const overrides = {
    "/api/discord/board-badge": (url, req) => {
      if (req.method === "GET") return stored ? { raw: "badge" } : { status: 404, body: { error: { message: "no match board badge" } } };
      if (req.method === "PUT") { stored = true; return { body: { ok: true, mime: "image/png", bytes: PNG.length } }; }
      if (req.method === "DELETE") { const was = stored; stored = false; return { body: { removed: was } }; }
      return undefined;
    },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/discord/relay`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { hasText: "Match board badge" });
    await panel.getByText("No badge yet.").waitFor({ timeout: 10_000 });
    // The file's own bytes go up, not a JSON wrapping of them.
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/discord/board-badge") && r.method() === "PUT");
    await panel.getByLabel("Upload a badge").setInputFiles({ name: "badge.png", mimeType: "image/png", buffer: PNG });
    assert.deepEqual([...(await sent).postDataBuffer()], [...PNG]);
    await panel.getByText("Badge saved").waitFor({ timeout: 10_000 });
    await panel.getByRole("img", { name: "Match board badge" }).waitFor();
    assert.equal(await panel.getByLabel("Replace the badge").count(), 1, "a set badge is replaced, not uploaded again");
    await panel.getByRole("button", { name: "Remove" }).click();
    await panel.getByText("Badge removed").waitFor({ timeout: 10_000 });
    assert.equal(await panel.getByRole("img", { name: "Match board badge" }).count(), 0);
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.path === "/api/discord/board-badge"));
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // A reader sees the badge and is offered nothing to change: an upload would only be refused.
  stored = true;
  const reader = [{ capability: "discord.relay", scopeType: "global", scopeId: null, level: "read" }];
  await withPage({ grants: reader, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/discord/relay`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { hasText: "Match board badge" });
    await panel.getByRole("img", { name: "Match board badge" }).waitFor({ timeout: 10_000 });
    assert.equal(await panel.locator("input[type=file]").count(), 0, "no upload");
    assert.equal(await panel.getByRole("button", { name: "Remove" }).count(), 0, "no remove");
    await panel.getByText("Changing the badge needs the Discord relay permission on every server.").waitFor();
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // So does a manager of one server's relay: the badge is on every server's board, so changing it
  // takes the permission for all of them, and the server would refuse anything less.
  const oneServer = [{ capability: "discord.relay", scopeType: "server", scopeId: "s1", level: "write" }];
  await withPage({ grants: oneServer, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/discord/relay`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { hasText: "Match board badge" });
    await panel.getByRole("img", { name: "Match board badge" }).waitFor({ timeout: 10_000 });
    assert.equal(await panel.locator("input[type=file]").count(), 0, "no upload");
    assert.equal(await panel.getByRole("button", { name: "Remove" }).count(), 0, "no remove");
    await panel.getByText("Changing the badge needs the Discord relay permission on every server.").waitFor();
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The career page said "No career here for this player" whenever its read failed — the address
 * over its limit for the minute, the database not answering — as it does for a player with none.
 */
test("public career page: a read that failed says so, not that there is no career", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "alpha", game: "hll", playerIds: true,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/api/public/alpha/player/76561198000000001": { status: 500, body: { error: "the database is not answering" } },
    "/api/public/alpha/player/76561198000000002": { status: 404, body: { error: "not found" } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/player/76561198000000001`, { waitUntil: "networkidle" });
    await page.getByText("This player's career is unavailable right now.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No career here").count(), 0);
    await page.goto(`${stub.base}/stats/alpha/player/76561198000000002`, { waitUntil: "networkidle" });
    await page.getByText("No career here for this player.").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * An unread server list is empty too, and every screen that guards on "no servers" said "No game
 * servers connected yet" over it — to the owner of a panel with servers, who might add them again.
 */
test("a server list that couldn't be read says so, not that none are connected", { skip: SKIP }, async () => {
  let down = true;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    // Down, then a good read of a list that really is empty.
    "/api/servers": () => (down ? { status: 500, body: { error: "the database is not answering" } } : { body: { servers: [] } }),
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/live`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the server list").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No game servers connected yet").count(), 0, "no false 'nothing connected'");
    await page.goto(`${stub.base}/#/players/vips`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the server list").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No game servers are connected yet").count(), 0);
    down = false;
    await page.getByRole("button", { name: "Try again" }).click();
    // A good read clears the failure: an empty list now is the real "none connected".
    await page.getByText("No game servers are connected yet").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("Couldn't read the server list").count(), 0, "the failure is not left up");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The stats site read a refused server list as an empty one: "No published server at this
 * address" to a visitor holding a good link, and "No servers are published right now" up front.
 */
test("public site: a server list that couldn't be read says so, not that nothing is published", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/public/servers": { status: 500, body: { error: { message: "the database is not answering" } } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "networkidle" });
    await page.getByText("The stats couldn't be loaded right now.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No published server at this address").count(), 0);
    await page.goto(`${stub.base}/stats`, { waitUntil: "networkidle" });
    await page.getByText("The stats couldn't be loaded right now.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No servers are published right now").count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The slash command's description box kept its desktop width on a phone — the phone rule that
 * fills the line was less specific than the desktop one — and ran past the panel's edge.
 */
test("the slash command's description box fits a phone", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: {
    "/api/discord/commands": { body: { config: { name: "staff", description: "Open the staff panel", enabled: true }, canRegister: false, guildId: null, canCheckRoles: false, mappedRoles: 0 } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/discord/setup`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel").filter({ has: page.locator(".panel-title", { hasText: "Slash command" }) });
    const box = panel.locator("label", { hasText: "description" }).locator("input");
    await box.waitFor({ timeout: 10_000 });
    const panelRight = await rightEdge(panel);
    assert.ok((await rightEdge(box)) <= panelRight, `the box ends at ${await rightEdge(box)}px, the panel at ${panelRight}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Past games, and a past game, whose reads failed before CRCON's wrapper was ever written — the
 * API's own error answer, from a fault ahead of the command — waited at "Loading…" for as long as
 * the fault lasted: the answer carried no result and no "failed", so it read as one on its way.
 */
test("public site: past games and a past game whose reads fail outright say so, not Loading", { skip: SKIP }, async () => {
  const outright = { status: 500, body: { error: { code: "internal", message: "database unavailable" } } };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [PUB_ALPHA] } },
    "/stats/alpha/api/get_scoreboard_maps": outright,
    "/stats/alpha/api/get_map_scoreboard": outright,
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/games`, { waitUntil: "networkidle" });
    await page.getByText("Past games are unavailable right now.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("Loading…").count(), 0, "not left waiting");
    await page.goto(`${stub.base}/stats/alpha/games/42`, { waitUntil: "networkidle" });
    await page.getByText("This round is unavailable right now.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("Loading…").count(), 0, "not left waiting");
    assert.equal(await page.getByText("[object Object]").count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/* A long message preset pushed its row, and the row's Delete, past a phone's edge. */
test("a long message preset keeps its Delete on a phone screen", { skip: SKIP }, async () => {
  const body = "Please respect the server rules and keep comms clean — repeat offences are a kick, then a ban. ThisIsAnUnbrokenWordThatGoesOnAndOnAndOn";
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: {
    "/api/templates": { body: { templates: [{ id: "t1", kind: "message", title: "", body, sortOrder: 0 }], kinds: ["reason", "message", "broadcast"] } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/admin/templates`, { waitUntil: "networkidle" });
    const del = page.getByRole("button", { name: "Delete" });
    await del.waitFor({ timeout: 10_000 });
    const panelRight = await rightEdge(page.locator(".panel", { has: del }));
    assert.ok((await rightEdge(del)) <= panelRight, `Delete ends at ${await rightEdge(del)}px, the panel at ${panelRight}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A reply without the sidebar's list — what a sign-in page or a proxy answering in the API's place
 * reads as — was drawn as it came, and the sidebar's filter over it took the whole panel down.
 */
test("a sidebar layout reply with nothing in it leaves the panel standing", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/layout/admin": { body: {} } } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/live`, { waitUntil: "networkidle" });
    await page.locator(".nav-item", { hasText: "Live" }).first().waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(/Application error|client-side exception/).count(), 0, "no crash screen");
    // The standard menu, as after a failed read: its layout editor offers the standard tiles, where an
    // empty list would offer nothing, and saving it would store an empty menu.
    await page.click(".settings-trigger");
    await page.locator(".sm-item", { hasText: "Edit layout" }).click();
    const editor = page.locator(".card", { hasText: "Customize layout" });
    await editor.locator(".layout-item", { hasText: "Players" }).waitFor({ timeout: 10_000 });
    assert.equal(await editor.locator(".layout-item", { hasText: "Community" }).count(), 1, "the standard menu's tiles");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The sidebar's host status, on every screen and polling, drew its figures from whatever came back:
 * a reply without them took the whole panel down. Missing either figure is no reading.
 */
test("a host status reply with nothing in it reads as offline, and the panel stays up", { skip: SKIP }, async () => {
  let reply = {};
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/health/metrics": () => ({ body: reply }) } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/live`, { waitUntil: "networkidle" });
    await page.locator(".host-status", { hasText: "Offline" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(/Application error|client-side exception/).count(), 0, "no crash screen");
    // The processor's figure without the memory's: drawn, the missing memory took the panel down.
    reply = { cpuPct: 12 };
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".host-status", { hasText: "Offline" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(/Application error|client-side exception/).count(), 0, "no crash screen without the memory");
    // The memory's without the processor's: drawn, it read Online over a "NaN%".
    reply = { memory: { usedBytes: 1, totalBytes: 2, pct: 50 }, disk: null };
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".host-status", { hasText: "Offline" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".host-status", { hasText: "NaN" }).count(), 0, "no figure that isn't one");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/* Server stats waited on a reply without its figures, and said "Loading…" for as long as it was open. */
test("public site: a server stats reply with nothing in it says they're unavailable", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [PUB_ALPHA] } },
    "/api/public/alpha/stats": { body: {} },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    await page.getByText("Server stats are unavailable right now.").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A quick double tap on a server's mode or publish switch sent the change twice: two lines in the
 * activity log for one change, and a phone alert that it was changed "again". Each switch is held
 * until the list shows the change, so a tap between the save and the list's reload, with the button
 * still under its old label, is no second change either.
 */
test("a quick double tap on a server's mode or publish switch makes one change", { skip: SKIP }, async () => {
  let mode = "active", published = true, slow = false;
  const server = () => ({ id: "s1", name: "Alpha", host: "h", port: 1, protocol: "binary-v2", game: "hll", engagementMode: mode, streamerMode: published, publicSlug: "alpha" });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    // The save answers at once; the list it reloads takes a second, as on a busy server.
    "/api/servers": (url, req) => (req.method === "GET" ? { delayMs: slow ? 1_000 : 0, body: { servers: [server()] } } : undefined),
    "/api/servers/s1/engagement": (url, req) => { if (req.method !== "POST") return undefined; mode = "observe"; slow = true; return { body: { server: server() } }; },
    "/api/servers/s1/streamer-mode": (url, req) => { if (req.method !== "POST") return undefined; published = false; slow = true; return { body: { server: server() } }; },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/admin/connections`, { waitUntil: "networkidle" });
    const card = page.locator(".subcard", { hasText: "Alpha" });
    const posts = (path) => stub.calls.filter((c) => c.method === "POST" && c.path === path).length;
    // Two taps 120ms apart, the second where the first landed, whether or not the button takes it.
    const doubleTap = async (label) => {
      const btn = card.getByRole("button", { name: label, exact: true });
      await btn.click();
      await page.waitForTimeout(120);
      await btn.click({ force: true, timeout: 1_000 }).catch(() => {});
    };
    await doubleTap("Switch to observe");
    await card.getByRole("button", { name: "Switch to active", exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(posts("/api/servers/s1/engagement"), 1, "one change of mode");
    await doubleTap("Unpublish stats");
    await card.getByRole("button", { name: "Publish stats", exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(posts("/api/servers/s1/streamer-mode"), 1, "one change of publishing");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Reset undoes YOUR arrangement — so it is only offered when there is one.
 *
 * A team default arrives carrying widths and hidden panels, which is indistinguishable from a
 * personal arrangement if you only look at the config. Reset was therefore live on a page nobody
 * had arranged, promising to restore a layout that would come back byte-identical. The layout
 * endpoint already says whose arrangement it handed over; this is that answer being used.
 */
test("panels: Reset is offered for your own arrangement, not for the team default", { skip: SKIP }, async () => {
  const teamDefault = {
    surface: "panel:system", source: "instance",
    config: { order: ["services", "host"], collapsed: [], hidden: ["plugins"], widths: { host: 6 }, touched: false, reordered: true },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/layout/panel:system": { body: teamDefault } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/system`, { waitUntil: "networkidle" });
    await page.waitForSelector("button.panel-reset");
    // The team default is in force (a panel it hides is gone)…
    await page.waitForFunction(() => !window.document.body.innerText.includes("Loaded plugins"));
    await page.click("button.panel-reset");
    await page.waitForSelector(".panel-group.editing");
    // …but there is nothing of MINE to reset yet.
    assert.equal(await page.locator('.panel-toolbar button:has-text("Reset")').isDisabled(), true,
      "Reset is inert while the page is showing the team default");

    // Arrange something myself, and it becomes mine to undo.
    await page.click('button[aria-label="Move System later"]');
    await page.waitForFunction(() => {
      const b = [...window.document.querySelectorAll(".panel-toolbar button")].find((x) => /Reset/.test(x.textContent || ""));
      return b && !b.disabled;
    });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The rules page answers for the server you are on. Every rule used to render regardless of its
 * pin, so three servers' welcome messages and TK policies read as one interleaved wall — and the
 * wall only grows with the fleet. Community-wide rules stay (they genuinely run here); rules
 * pinned elsewhere wait behind one labelled button, so nothing is invisible, just filed.
 */
test("rules: the list is this server's policy, with the rest behind a labelled toggle", { skip: SKIP }, async () => {
  const rule = (id, name, serverId) => ({
    id, name, serverId, enabled: true, eventKind: "evt.teamkill", match: null, threshold: 1,
    windowSec: 0, action: "kick", reason: null, hours: null, delaySec: 0, vipMinutes: 10,
    vipCooldownMinutes: 60, requireRoleIds: [],
  });
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "Server One", game: "hll", engagementMode: "observe" },
        { id: "s2", name: "Server Two", game: "hll", engagementMode: "observe" },
      ] } },
      "/api/enforcer/rules": { body: { rules: [
        rule("r1", "tk policy here", "s1"),
        rule("r2", "welcome elsewhere", "s2"),
        rule("r3", "crash vip everywhere", null),
      ], activity: {} } },
    },
  }, async (page) => {
    // The first server in the list is the pinned default, so this page is Server One's. The tab
    // is reached the way a person reaches it — the hub keeps its own tab state, so a cold deep
    // link lands on the default tab.
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector('text=tk policy here');
    assert.equal(await page.locator("text=crash vip everywhere").count(), 1, "community-wide rules run here too");
    assert.equal(await page.locator("text=welcome elsewhere").count(), 0, "another server's rule is not this server's policy");

    // Nothing vanished: the other server's rule is one labelled click away, and one more hides it again.
    await page.click('button:has-text("pinned to other servers")');
    await page.waitForSelector("text=welcome elsewhere");
    await page.click('button:has-text("Show only this server\'s rules")');
    await page.waitForFunction(() => !window.document.body.innerText.includes("welcome elsewhere"));
  });
});

test("rules: a section's own switch turns its rules off at once, after asking — and a held section says why its rules are off", { skip: SKIP }, async () => {
  const rule = (id, name, sectionId, over = {}) => ({
    id, name, serverId: null, sectionId, enabled: true, eventKind: "evt.teamkill", match: null, threshold: 1,
    windowSec: 0, action: "kick", reason: null, hours: null, delaySec: 0, vipMinutes: 10,
    vipCooldownMinutes: 60, requireRoleIds: [], ...over,
  });
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: {
        sections: [{ id: "sec1", name: "Event rules", enabled: true }, { id: "sec2", name: "Night rules", enabled: false }],
        rules: [rule("r1", "event welcome", "sec1"), rule("r2", "night tk", "sec2", { sectionOff: true })],
        activity: {},
      } },
      "/api/enforcer/sections/sec1": { body: { section: { id: "sec1", name: "Event rules", enabled: false } } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector("text=night tk");
    // The held section says so — on the section and on its rule, never as a rule "quiet for a week".
    const night = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Night rules" }) });
    assert.equal(await night.locator("text=This section is switched off").count(), 1);
    assert.equal(await night.locator("text=off — section switched off").count(), 1);
    assert.equal(await night.locator("text=quiet 7d").count(), 0, "a held rule is not reported as quiet");
    // Off asks first, then sends the switch and nothing else.
    const events = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Event rules" }) });
    await events.locator("label.toggle", { hasText: "Section on" }).click();
    await page.locator(".confirm-modal button", { hasText: /^Switch off$/ }).click();
    await page.waitForSelector('text="Event rules" switched off');
    const call = stub.calls.find((c) => c.method === "PATCH" && c.path === "/api/enforcer/sections/sec1");
    assert.deepEqual(call?.body, { enabled: false });
  });
});

/*
 * The dedicated chat filter: a word list, not a regex box. One save carries the list, the
 * enforcement switch and the censor switch in a single PUT; the screen says where the managed
 * rules live so nobody hunts for the exemption/ladder knobs that deliberately are not here.
 */
test("chat filter: the word list saves in one PUT and points at its managed rules", { skip: SKIP }, async () => {
  const blank = { enabled: false, words: [], action: "punish", hours: null, reason: "", censor: false, censorApplied: {}, teamRuleId: null, unitRuleId: null };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      // One body serves both verbs: the GET reader takes `config`, the PUT reader also finds
      // `censorResults` — the stub keys overrides by path alone.
      "/api/chat-filter": { body: { config: blank, censorResults: [] } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/chatfilter`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Watched words");

    await page.locator("textarea").fill("badword\nkys buddy");
    await page.locator("label.toggle", { hasText: "Act when a watched word" }).click();
    await page.locator('button:has-text("Save chat filter")').click();
    await page.waitForFunction(() => window.document.body.innerText.includes("Saved —"));

    const put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/chat-filter");
    assert.ok(put, "the save is one PUT to /api/chat-filter");
    assert.match(String(put.body.words), /badword/);
    assert.match(String(put.body.words), /kys buddy/);
    assert.equal(put.body.enabled, true);
    assert.equal(put.body.action, "punish");

    // The screen owns the list; the advanced knobs live on the managed rules, and it says so.
    assert.ok((await page.locator("text=Chat filter — team chat").count()) >= 1, "names the managed rules");
  });
});

/*
 * The group triggers in the Rules editor: a player added to / removed from a group. The picker
 * lists the community's groups, the action list holds only what reaches an absent player, the
 * on-server knobs (threshold, window, population, match window) are gone, and the read-back
 * sentence names the group.
 */
test("rules: a group trigger picks its group, offers only off-server actions, and reads back the group's name", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: { rules: [], activity: {} } },
      "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 3, createdByName: "owner", vipPerk: null }] } },
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/rules`, { waitUntil: "networkidle" });
    await page.click('button:has-text("New rule")');
    await page.selectOption('label:has-text("On event") select', "app.group.joined");
    // The trigger picker's own options mention groups, so find the picker by what it lists.
    const groupSelect = page.locator('select:has(option[value="g1"])');
    await groupSelect.waitFor();
    await groupSelect.selectOption("g1");
    const actions = await page.locator('label:has-text("Action") select option').evaluateAll((os) => os.map((o) => o.value));
    assert.deepEqual(actions, ["vip", "points", "tag", "note"], "membership isn't presence: no message, kick, move or ban");
    for (const gone of ["Threshold (matches)", "Window (seconds)", "Active from (players", "Active from minute of the match", "At most (times per player"]) {
      assert.equal(await page.locator(`text=${gone}`).count(), 0, `"${gone}" means nothing for a membership change`);
    }
    // A new rule starts on the server you are on — VIP lands there alone; community-wide, on every
    // server of the member's game.
    await page.waitForFunction(() => /When a player is added to group “WW2 CVC” → grant 7 days of VIP, with NO cooldown/.test(window.document.body.innerText), null, { timeout: 5_000 });
    await page.locator('label:has-text("Applies to") select').selectOption("");
    await page.waitForFunction(() => /When a player is added to group “WW2 CVC” → grant 7 days of VIP on every server of their game/.test(window.document.body.innerText), null, { timeout: 5_000 });
    // Points, a tag or a note happen once — the per-player limit is theirs again.
    await page.selectOption('label:has-text("Action") select', "points");
    await page.waitForSelector("text=At most (times per player");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The automation History tab — the one deliberate tab addition: every firing across the
 * families, filterable and paged, without the general audit capability.
 */
test("auto settings: the History tab lists automation firings with family chips and a rule filter", { skip: SKIP }, async () => {
  const entry = (id, action, summary, data = null) => ({ id, ts: "2026-09-01T20:0" + id.slice(-1) + ":00.000Z", actorName: "enforcer", action, targetName: "Griefer", targetId: "p1", serverId: "s1", summary, data });
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: { rules: [{ id: "r1", name: "TK policy", enabled: true, serverId: null, eventKind: "evt.teamkill", action: "kick", match: null, threshold: 1, windowSec: 0, reason: null, hours: null, delaySec: 0, vipMinutes: 10, vipCooldownMinutes: 60, requireRoleIds: [] }], activity: {} } },
      "/api/automation/history": { body: { entries: [
        entry("e1", "enforcer.kick", "kick Griefer — TK policy", { ruleId: "r1" }),
        entry("e2", "seed.warn", "warned Arty — artillery while seeding"),
        entry("e3", "rule.breaker", "rule DISABLED ITSELF (safety limit)", { ruleId: "r1" }),
      ], total: 3 } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("History")');
    await page.waitForSelector('text=kick Griefer — TK policy');
    await page.waitForSelector('text=DISABLED ITSELF');
    // Family chips + the per-rule filter are on offer.
    await page.waitForSelector('.chip-btn:has-text("Seeding")');
    await page.waitForSelector('select:has(option:has-text("TK policy"))');
    // A rule firing names its rule inline, resolved from the rules list.
    assert.ok((await page.locator('td:has-text("TK policy")').count()) >= 1);
  });
});

/*
 * A text box's natural width grows with the text size. With Larger text on a phone it widened the
 * template and VIP preset lists past the screen's edge, taking their Delete buttons with it, and
 * pushed a group's VIP grant — its date and its comment box — off the side.
 */
test("with Larger text on a phone, templates, VIP presets and a group's VIP grant keep within the screen", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 360, height: 780 },
    overrides: {
      ...ACTIVE_S1,
      "/api/templates": { body: { templates: [{ id: "t1", kind: "message", title: "", body: "Please respect the server rules and the other players", sortOrder: 0 }], kinds: ["reason", "message", "broadcast"] } },
      "/api/vip-presets": { body: { presets: [{ id: "v1", kind: "add", label: "Help skip the queue", days: 7, hours: 0, sortOrder: 0 }] } },
      "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 1, createdByName: "owner", vipPerk: null }] } },
      "/api/player-groups/g1": { body: { members: [] } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    await page.locator(".setting-card", { hasText: "Text size" }).getByRole("button", { name: "Larger" }).click();
    // Each control's right edge inside the screen and inside the card that holds it.
    const within = (loc, what) => loc.evaluate((el, w) => {
      const r = el.getBoundingClientRect(), card = el.closest(".card").getBoundingClientRect();
      return r.right <= window.innerWidth + 1 && r.right <= card.right + 1 ? "" : `${w} reaches ${Math.round(r.right)}px (screen ${window.innerWidth}, card ${Math.round(card.right)})`;
    }, what);

    await page.goto(`${base}#/admin/templates`, { waitUntil: "networkidle" });
    const del = page.getByTitle("Delete this template");
    await del.waitFor();
    assert.equal(await within(del, "the template's Delete"), "");

    await page.goto(`${base}#/admin/vippresets`, { waitUntil: "networkidle" });
    await page.getByTitle("Delete this duration button").waitFor();
    for (const [loc, what] of [[page.getByLabel("Label").first(), "the preset's label"], [page.getByLabel("Hours").first(), "its hours"], [page.getByTitle("Delete this duration button"), "its Delete"]]) {
      assert.equal(await within(loc, what), "");
    }

    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await page.locator(".seg-btn", { hasText: "Grant VIP" }).first().click();
    await page.locator(".seg-btn", { hasText: "Until date" }).first().click();
    const date = page.locator("label", { hasText: "Expires at" }).locator("input");
    const comment = page.locator("label", { hasText: "Comment (required)" }).locator("input");
    await comment.waitFor();
    assert.equal(await within(date, "the grant's date"), "");
    assert.equal(await within(comment, "the grant's comment"), "");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Each relay category's channel box was held at 200px beside its Test button, on one line. On the
 * smallest phones' screens (320px) the two did not fit, and every category's card ran past the edge.
 */
test("on the smallest phones, each relay category's channel box and Test button keep within the screen", { skip: SKIP }, async () => {
  const cats = ["kills", "chat", "admin", "connections", "match"];
  const relay = { body: {
    categories: cats, botConfigured: true, configured: true,
    config: {
      serverId: "s1", enabled: true, categories: cats, channels: Object.fromEntries(cats.map((c) => [c, "123456789012345678"])), categoryOptions: {},
      alerts: { adminPing: { enabled: false, trigger: "!admin", channelId: "", mentionRoleId: "" }, watchlist: { enabled: false, channelId: "", mentionRoleId: "" }, automation: { enabled: false, channelId: "", mentionRoleId: "" } },
      updatedAt: new Date().toISOString(),
    },
  } };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 320, height: 640 }, overrides: { "/api/servers/s1/discord": relay } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/discord/relay`, { waitUntil: "networkidle" });
    // The categories' boxes: each beside its Test button (the alerts below have channel boxes too).
    const boxes = page.locator('.setting-card .control-row:has(> button:text-is("Test")) > input[placeholder="Channel id"]');
    await boxes.first().waitFor();
    assert.equal(await boxes.count(), cats.length);
    const out = await page.evaluate(() => [...window.document.querySelectorAll('.setting-card input[placeholder="Channel id"]')].filter((box) => box.parentElement.querySelector(":scope > button")?.textContent === "Test").flatMap((box) => {
      const test = box.parentElement.querySelector(":scope > button");
      const card = box.closest(".setting-card");
      // Each inside the screen and inside what holds it: the box and button in their category's
      // card, the card in the panel.
      const edge = Math.min(window.innerWidth, card.closest(".panel").getBoundingClientRect().right);
      return [[box, card.getBoundingClientRect().right], [test, card.getBoundingClientRect().right], [card, edge]].filter(([el, room]) => {
        const r = el.getBoundingClientRect();
        return r.right > window.innerWidth + 1 || r.right > room + 1;
      }).map(([el]) => `${el.tagName.toLowerCase()}.${el.className || ""} ${el.placeholder || el.textContent.slice(0, 20)} reaches ${Math.round(el.getBoundingClientRect().right)}px`);
    }));
    assert.deepEqual(out, [], "every category's card, channel box and Test button inside the screen and what holds it");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  // On a computer, with room to spare, each box keeps the 200px it always had.
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/discord": relay } }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/discord/relay`, { waitUntil: "networkidle" });
    const box = page.locator('.setting-card .control-row:has(> button:text-is("Test")) > input[placeholder="Channel id"]').first();
    await box.waitFor();
    assert.equal(Math.round((await box.boundingBox()).width), 200);
  });
});

/*
 * Each file sent or fetched read its refusal its own way. The cutover import of a bot file read every
 * answer as JSON, so a proxy's error page in front of the API (a tunnel's 502) came out as a parse
 * error; the CRCON archive's export said only "export failed (404)" where the API said why; its
 * upload and the match board badge's said "upload failed (504)" and "HTTP 530" where every other
 * screen says what the proxy's answer means.
 */
test("the cutover import, the CRCON archive and the board badge say why they were refused", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/economy/import-botdb": (url, req) => (req.method === "POST" ? { status: 502, raw: "<html><body>502 Bad Gateway</body></html>" } : undefined),
    "/api/servers/s1/import/crcon/job": { body: { job: null, archive: [{ dataType: "vip", count: 3 }], fileBytes: 1024 } },
    "/api/servers/s1/import/crcon/export": { status: 404, body: { error: { code: "not_found", message: "no archive yet — run a backup pull first" } } },
    "/api/servers/s1/import/crcon/upload": (url, req) => (req.method === "POST" ? { status: 504, raw: "<html><body>504 Gateway Time-out</body></html>" } : undefined),
    "/api/discord/board-badge": (url, req) => (req.method === "PUT" ? { status: 530, raw: "error code: 1033" } : { status: 404, body: { error: { message: "no match board badge" } } }),
  } }, async (page, { stub, errors }) => {
    const panel = (title) => page.locator("section.panel", { has: page.locator(".panel-title", { hasText: title }) });
    await page.goto(`${stub.base}/#/players/economy`, { waitUntil: "networkidle" });
    const cutover = panel("v4 cutover import");
    await cutover.locator("button.panel-toggle").click();
    await cutover.locator('input[type="file"]').setInputFiles({ name: "bot.db", mimeType: "application/octet-stream", buffer: Buffer.from("SQLite format 3\0") });
    await cutover.getByRole("button", { name: "Import", exact: true }).click();
    await page.locator(".toast-text", { hasText: "The panel's API did not answer (HTTP 502 came from the proxy in front of it)" }).waitFor({ timeout: 10_000 });
    assert.doesNotMatch(await page.locator(".toast-stack").innerText(), /JSON|Unexpected token/, "not a parse error");

    await page.goto(`${stub.base}/#/admin/connections`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Export backup (.ndjson)" }).click();
    await page.getByText("no archive yet — run a backup pull first").waitFor({ timeout: 10_000 });
    await page.locator('input[type="file"][accept=".ndjson,.json,application/x-ndjson"]').setInputFiles({ name: "crcon-backup.ndjson", mimeType: "application/x-ndjson", buffer: Buffer.from("{}\n") });
    await page.getByText("The panel's API did not answer (HTTP 504 came from the proxy in front of it)").waitFor({ timeout: 10_000 });

    await page.goto(`${stub.base}/#/discord/relay`, { waitUntil: "networkidle" });
    const badge = page.locator(".panel", { hasText: "Match board badge" });
    await badge.getByLabel("Upload a badge").setInputFiles({ name: "badge.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    await badge.getByText("Cloudflare can't reach the computer the panel runs on (HTTP 530)").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The settings, the shop's offers and the balances are three permissions. The Economy screen ran
 * on the settings' alone: whoever ran the shop could not open it or find its guide, and a balances
 * reviewer opened it onto the settings' refusal instead of the members they may see.
 */
test("Economy opens for each of its permissions, onto that one's part", { skip: SKIP }, async () => {
  const grant = (capability, level) => [{ capability, scopeType: "global", scopeId: null, level }];
  // The shop, held at read: its menu entry, the offers to edit (and ask for), nothing of the
  // settings, and the shop's walkthrough under Help.
  await withPage({ grants: grant("economy.shop", "read") }, async (page, { stub, errors }) => {
    assert.ok((await page.locator(".nav-item", { hasText: "Players" }).count()) >= 1, "the menu offers Players");
    await page.goto(`${stub.base}/#/players/economy`, { waitUntil: "networkidle" });
    const offers = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Shop offers" }) });
    await offers.getByRole("button", { name: "Add offer" }).click();
    assert.equal(await offers.locator('input[value="Two Weeks"]').isEditable(), true, "an offer's fields are theirs to edit");
    assert.equal(await offers.getByText("You don't hold the permission for changes here").count(), 1, "and says a change is asked for");
    assert.equal(await page.locator(".panel-title", { hasText: /^Settings$/ }).count(), 0, "no settings");
    // The shop's walkthrough under Help is the one they may follow, which shows the offers, not the
    // one for changing them that the write of the permission is shown.
    await page.goto(`${stub.base}/#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "See the VIP shop" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".walk-card", { hasText: "Set up the VIP shop" }).count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  // The balances, held at read: the members, and the settings' document never asked for.
  const refused = { status: 403, body: { error: { code: "forbidden", message: "missing permission: Economy settings (Bans & VIP) — read access required" } } };
  await withPage({ grants: grant("economy.balances", "read"), overrides: { "/api/economy/config": refused } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/players/economy`, { waitUntil: "networkidle" });
    await page.locator(".panel-title", { hasText: "Members" }).waitFor({ timeout: 10_000 });
    assert.equal(stub.calls.filter((c) => c.path === "/api/economy/config").length, 0, "the settings are not asked for");
    assert.equal(await page.getByText("missing permission").count(), 0, "and no refusal in their place");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a VIP grant in the queue says what signing grants — the date it runs to, and its comment", { skip: SKIP }, async () => {
  const line = (over) => ({
    id: "l1", seq: 0, serverId: "s1", capability: "vip.grant", kind: "vip",
    payload: {}, playerId: "76561198000000009", playerName: "Donor", state: "pending",
    decidedByName: null, decidedAt: null, denyReason: null, modified: null,
    appliedAt: null, applyError: null, canSign: true, signRefusal: null, ...over,
  });
  const overrides = {
    "/api/requests": { body: {
      queue: [{
        id: "r1", requesterName: "TrialMod", status: "open", note: null,
        submittedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-03T00:00:00.000Z", own: false,
        lines: [
          line({ id: "lp", payload: { playerId: "76561198000000009", mode: "permanent", comment: "paid $25 — PayPal" } }),
          line({ id: "lu", seq: 1, playerId: "76561198000000010", playerName: "Winner", payload: { playerId: "76561198000000010", mode: "until", expiresAt: "2026-12-01T00:00:00.000Z", comment: "event winner" } }),
        ],
      }],
      mine: [],
    } },
    "/api/requests/history": { body: { decisions: [] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/moderation/requests`, { waitUntil: "networkidle" });
    await page.waitForSelector(".req-line", { timeout: 10_000 });
    const rows = await page.locator(".req-line").allInnerTexts();
    const donor = rows.find((t) => t.includes("Donor")) ?? "";
    assert.match(donor, /permanent · comment “paid \$25 — PayPal”/, "the person signing sees who paid");
    const winner = rows.find((t) => t.includes("Winner")) ?? "";
    assert.match(winner, /until \S.* · comment “event winner”/, "a dated grant says the date it runs to");
    assert.doesNotMatch(winner, /until ·/, "not a bare “until”");
  });
});

/**
 * A finished event nobody means to pay: marked, so it stops saying "Awaiting payment".
 *
 * Staff found no way out of the badge for a practice night or a scrim — a closed event refuses
 * cancel, rightly, since it is a record with a report. The row offers "No payout needed" instead,
 * and the same place offers it back.
 */
test("events list: a finished event can be marked as needing no payout, and the mark undone", { skip: SKIP }, async () => {
  let marked = false;
  const row = (o) => ({
    serverId: "s1", serverName: "Main", status: "closed", payment: null, noPayoutAt: null, noPayoutBy: null,
    openMode: "at", openAnchor: "2026-08-28T19:00:00.000Z", openedAt: "2026-08-28T19:00:00.000Z",
    closeMode: "at", closeAnchor: "2026-08-28T23:00:00.000Z", closedAt: "2026-08-28T23:00:00.000Z",
    minMinutes: 0, mapVoteProfile: null, rotationSetId: null, roster: [{ playerId: "p1", name: "Someone", minutes: 90 }],
    createdBy: "owner", createdAt: "2026-08-01T00:00:00.000Z", ...o,
  });
  const overrides = {
    // The list answers as the server would after each press; the press itself only records. Its
    // answer is slow on purpose, so the test cannot pass by reading a row before it repaints.
    "/api/payout-events": () => ({ delayMs: 400, body: { items: [
      row({ id: "e1", name: "Practice night", ...(marked ? { noPayoutAt: "2026-08-29T10:00:00.000Z", noPayoutBy: "Reaper" } : {}) }),
      row({ id: "e2", name: "Paid night", payment: { state: "paid", unpaid: 0, at: "2026-08-29T00:10:00.000Z" } }),
    ] } }),
    "/api/payout-events/e1/no-payout": () => { marked = !marked; return { body: { event: {} } }; },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/events/schedule`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.data tbody tr", { timeout: 10_000 });
    const table = page.locator("table.data", { has: page.locator("th", { hasText: "Window" }) });
    const practice = table.locator("tbody tr", { hasText: "Practice night" });
    const paymentOf = async (r) => (await r.locator("td").nth(2).innerText()).replace(/\s+/g, " ").trim();
    const presses = () => stub.calls.filter((c) => c.method === "POST" && c.path === "/api/payout-events/e1/no-payout").map((c) => c.body);

    assert.match(await paymentOf(practice), /^awaiting payment$/i);
    assert.equal(await table.locator("tbody tr", { hasText: "Paid night" }).getByRole("button", { name: "No payout needed" }).count(), 0,
      "a paid event has nothing to mark");

    await practice.getByRole("button", { name: "No payout needed" }).click();
    // Wait on the mark itself. The button carries the same words, so waiting for "No payout
    // needed" was over before the list had reloaded, and the check below then read the row as it
    // was before the press whenever the reload was slower than the test.
    await page.waitForFunction(() => /marked by Reaper/.test(window.document.querySelector("table.data tbody tr")?.innerText ?? ""));
    assert.deepEqual(presses(), [{ noPayout: true }]);
    assert.equal(await paymentOf(practice), "No payout needed marked by Reaper");
    assert.equal(await practice.locator(".badge.warn-badge").count(), 0, "the badge is gone");
    assert.equal(await practice.getByRole("button", { name: "No payout needed" }).count(), 0);

    await practice.getByRole("button", { name: "Needs a payout" }).click();
    await page.waitForFunction(() => /awaiting payment/i.test(window.document.querySelector("table.data tbody tr")?.innerText ?? ""));
    assert.deepEqual(presses(), [{ noPayout: true }, { noPayout: false }], "and taken back from the same row");
    assert.match(await paymentOf(practice), /^awaiting payment$/i);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The round's game log on the public match page: its start and end, kills and team kills with the
 * weapon, connects, disconnects and team switches, on the round's own clock. A tab of its own with
 * a pasteable address (.../games/<id>/log), filtered by kind and by a name.
 */
test("public round page: the game log tab lists the round in order, filtered by kind and name", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [{ key: "combat", label: "CBT", title: "Combat" }],
    squadLabel: "Squad",
  };
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan", game_mode: "Warfare" }, result: { allied: 5, axis: 0 }, player_stats: [],
  };
  const log = {
    start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", truncated: false,
    lines: [
      { t: 0, kind: "evt.match.started" },
      { t: 60, kind: "evt.player.connected", who: "Jones" },
      { t: 120, kind: "evt.player.teamSwitched", who: "Jones", from: "Allies", to: "Axis", swapFrom: "Allies", swapCount: 1 },
      { t: 300, kind: "evt.kill", who: "Smith", whom: "Jones", weapon: "M1 GARAND" },
      { t: 420, kind: "evt.teamkill", who: "Jones", whom: "Brown", weapon: "MP40" },
      { t: 3000, kind: "evt.player.disconnected", who: "Brown" },
      { t: 3600, kind: "evt.match.ended" },
    ],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/log/5": { body: { log } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.locator("a", { hasText: "Game log" }).first().click();
    await page.waitForSelector(".log-row", { timeout: 10_000 });
    assert.ok(page.url().endsWith("/stats/alpha/games/5/log"), "the log is a pasteable URL");
    const rows = () => page.locator(".log-row").allInnerTexts();
    let text = await rows();
    assert.equal(text.length, 7, "every line of the round");
    assert.match(text[0], /Match started/);
    assert.match(text[6], /Match ended/);
    assert.match(text[3], /^5:00\s+KILL\s+Smith ✖ Jones · M1 GARAND$/, `the round's clock, the chip, who killed whom with what: ${text[3]}`);
    assert.match(text[2], /switched sides Allies → Axis/);

    await page.locator(".seg-btn", { hasText: "Team kills" }).click();
    text = await rows();
    assert.equal(text.length, 3, "the team kill, between the round's start and end");
    assert.match(text[1], /Jones team-killed Brown · MP40/);

    await page.locator(".seg-btn", { hasText: "All" }).click();
    await page.fill('input[aria-label="Find a player in the log"]', "brown");
    text = await rows();
    assert.equal(text.length, 4, "a name finds every line it is in, either side of it");

    // In this tab the round's log keeps the search left on it, for the visit.
    await page.goto(`${stub.base}/stats/alpha/games/5/log`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-row", { timeout: 10_000 });
    assert.equal(await page.inputValue('input[aria-label="Find a player in the log"]'), "brown");
    assert.equal(await page.locator(".log-row").count(), 4);
    // Opened straight from a pasted link — in a tab of its own, the way a link someone was sent
    // opens, which starts with nothing remembered — the log tab is what shows, and the whole round.
    await page.evaluate(() => window.sessionStorage.clear());
    await page.goto(`${stub.base}/stats/alpha/games/5/log`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-row", { timeout: 10_000 });
    assert.equal(await page.locator(".log-row").count(), 7);
  });
});

/*
 * The admin camera on the public game log: who went in and who came out, by name, under the CAM
 * chip and a filter of its own. On a phone the longer row of filters still fits the screen.
 */
test("public round page: the game log shows the admin camera, in and out, with a filter of its own", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [{ key: "combat", label: "CBT", title: "Combat" }],
    squadLabel: "Squad",
  };
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan", game_mode: "Warfare" }, result: { allied: 5, axis: 0 }, player_stats: [],
  };
  const log = {
    start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", truncated: false,
    lines: [
      { t: 0, kind: "evt.match.started" },
      { t: 60, kind: "evt.player.connected", who: "Jones" },
      { t: 240, kind: "evt.admin.camera", who: "Admin Lynx", entered: true },
      { t: 300, kind: "evt.kill", who: "Smith", whom: "Jones", weapon: "M1 GARAND" },
      { t: 390, kind: "evt.admin.camera", who: "Admin Lynx", entered: false },
      { t: 3600, kind: "evt.match.ended" },
    ],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/log/5": { body: { log } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5/log`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-row", { timeout: 10_000 });
    const rows = () => page.locator(".log-row").allInnerTexts();
    let text = await rows();
    assert.equal(text.length, 6, "the camera lines among the rest, in order");
    assert.match(text[2], /^4:00\s+CAM\s+Admin Lynx entered the admin camera$/, text[2]);
    assert.match(text[4], /^6:30\s+CAM\s+Admin Lynx left the admin camera$/, text[4]);

    await page.locator(".seg-btn", { hasText: "Admin camera" }).click();
    text = await rows();
    assert.equal(text.length, 4, "the two camera lines, between the round's start and end");
    assert.match(text[1], /entered the admin camera/);
    assert.match(text[2], /left the admin camera/);
    assert.ok(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth), "the page never pans sideways");
    assert.deepEqual(errors, []);
  });
});

/*
 * A round's game log saves as a file, in the format picked: Excel, CSV or JSON. The file holds the
 * lines the log shows — its kind filter and its name search — every one of them, not only the page
 * drawn, under columns a spreadsheet can sort: when, the round's clock, what, who, whom, with what.
 */
test("public round page: the game log downloads as Excel, CSV or JSON — the lines it shows", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [{ key: "combat", label: "CBT", title: "Combat" }],
    squadLabel: "Squad",
  };
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan", game_mode: "Warfare" }, result: { allied: 5, axis: 0 }, player_stats: [],
  };
  const log = {
    start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", truncated: false,
    lines: [
      { t: 0, kind: "evt.match.started" },
      { t: 60, kind: "evt.player.connected", who: "Jones" },
      { t: 120, kind: "evt.player.teamSwitched", who: "Jones", from: "Allies", to: "Axis", swapFrom: "Allies", swapCount: 1 },
      { t: 240, kind: "evt.admin.camera", who: "Admin Lynx", entered: true },
      { t: 300, kind: "evt.kill", who: "=Smith", whom: "Jones", weapon: "M1 GARAND" },
      { t: 420, kind: "evt.teamkill", who: "Jones", whom: "Brown", weapon: "MP40" },
      { t: 3600, kind: "evt.match.ended" },
    ],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/log/5": { body: { log } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5/log`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-row", { timeout: 10_000 });
    const popup = page.locator(".pa-modal");
    const download = async (format) => {
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await popup.waitFor();
      if (format) await popup.locator("select").selectOption(format);
      const said = await popup.innerText();
      const [file] = await Promise.all([page.waitForEvent("download"), popup.getByRole("button", { name: "Download", exact: true }).click()]);
      await popup.waitFor({ state: "detached" });
      return { said, name: file.suggestedFilename(), text: (await readFile(await file.path())).toString("utf8"), bytes: await readFile(await file.path()) };
    };
    const day = String.raw`\d{4}-\d{2}-\d{2}`;

    // Kills only, as CSV: the round's start and end, and the kill — the team kill is another filter.
    await page.getByRole("button", { name: "Kills", exact: true }).click();
    const csv = await download("csv");
    assert.match(csv.said, /3 lines, as the log shows them, with its filter and search/);
    assert.doesNotMatch(csv.said, /game id/i, "a log of names is not described by how it keeps ids");
    assert.match(csv.name, new RegExp(`^alpha-round-5-game-log-${day}\\.csv$`));
    const rows = csv.text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    assert.match(rows[0], /^Time \([^)]+\),Round clock,What,Player,Target,Weapon,Detail$/);
    assert.equal(rows.length, 4, `a heading and three lines: ${rows.join(" | ")}`);
    assert.match(rows[2], /,5:00,Kill,'=Smith,Jones,M1 GARAND,$/, "a name that starts like a formula is kept as text");

    // The whole log, as JSON: every line, with the switch and the camera spelled out.
    await page.getByRole("button", { name: "All", exact: true }).click();
    const json = await download("json");
    const lines = JSON.parse(json.text);
    assert.equal(lines.length, 7);
    assert.deepEqual(Object.keys(lines[0]), ["time", "roundClock", "what", "player", "target", "weapon", "detail"]);
    assert.equal(lines[0].what, "Match started");
    assert.equal(lines[2].detail, "switched sides Allies → Axis");
    assert.deepEqual(lines[3], { time: "2026-08-01T10:04:00.000Z", roundClock: "4:00", what: "Admin camera", player: "Admin Lynx", target: "", weapon: "", detail: "entered the admin camera" });

    // A name searched, as Excel — the format offered first is the one last used, so pick it.
    await page.fill('input[aria-label="Find a player in the log"]', "brown");
    const xlsx = await download("xlsx");
    assert.match(xlsx.name, new RegExp(`^alpha-round-5-game-log-${day}\\.xlsx$`));
    const sheet = unzipStored(xlsx.bytes).get("xl/worksheets/sheet1.xml");
    assert.match(sheet, />Brown</);
    assert.doesNotMatch(sheet, /Admin Lynx/, "the search left the camera line out");
    assert.deepEqual(errors, []);
  });
});
test("public round page: each score gets a chart behind the kills chart's switch", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: SCORE_FIELDS, squadLabel: "Squad",
  };
  const row = (id, name, side, kills, combat, support) => ({
    id, player_id: null, player: name, platform: null, kills, deaths: 1, teamkills: 0, kill_death_ratio: kills,
    combat, offense: 0, defense: 0, support, time_seconds: 600, kills_streak: kills, team: { side },
    weapons: {}, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:10:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan Warfare" }, result: { allied: 1, axis: 4 },
    player_stats: [row(1, "Arty", "axis", 1, 260, 15), row(2, "Medic", "axis", 0, 0, 480), row(3, "Smith", "allies", 1, 40, 0)],
  };
  const life = { killsStreak: 1, deathsWithoutKillStreak: 1, longestLifeSecs: 60, shortestLifeSecs: 20, deathsByTk: 0 };
  const report = {
    complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [], duels: [], awards: [],
    timeline: [{ minute: 0, allies: 1, axis: 1 }],
    players: {
      Arty: { ...life, side: "axis", timeline: [[30, "k", "Smith", "MG42"]], scores: [[120, 40, 0, 0, 10], [180, 120, 20, 0, 10], [300, 260, 20, 0, 15]] },
      Medic: { ...life, side: "axis", timeline: [], scores: [[120, 0, 0, 0, 150], [240, 0, 0, 0, 480]] },
      Smith: { ...life, side: "allies", timeline: [[10, "k", "Arty", "M1 GARAND"], [30, "d", "Arty", "MG42"]] },
    },
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/report/5": { body: { report } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    const open = (name) => page.locator("table.scoreboard tbody tr", { hasText: name }).first().click();
    const chart = (label) => page.locator(`svg[aria-label="${label} over the round"]`);
    const ticks = (label) => chart(label).locator("text.tick").allTextContents();
    const tab = (label) => page.locator('.seg[aria-label="Chart"] button', { hasText: label });

    await open("Arty");
    await chart("Kills").waitFor({ timeout: 10_000 });
    assert.deepEqual(await page.locator('.seg[aria-label="Chart"] button').allInnerTexts(), ["Kills", "Cbt", "Off", "Def", "Sup"],
      "the kills chart first, then the scoreboard's own score columns");
    await tab("Cbt").click();
    await chart("Combat score").waitFor({ timeout: 5_000 });
    assert.equal(await chart("Kills").count(), 0, "one chart at a time");
    assert.ok((await ticks("Combat score")).includes("260"), "the line tops out at the round's combat total");
    await tab("Sup").click();
    assert.ok((await ticks("Support score")).includes("15"));
    await tab("Kills").click();
    await chart("Kills").waitFor({ timeout: 5_000 });

    // No kill or death: straight to the score they made most of.
    await open("Medic");
    await chart("Support score").waitFor({ timeout: 5_000 });
    assert.ok((await ticks("Support score")).includes("480"));

    // No scores recorded: the kills chart alone, as before.
    await open("Smith");
    await chart("Kills").waitFor({ timeout: 5_000 });
    assert.equal(await page.locator('.seg[aria-label="Chart"]').count(), 0, "no switch without scores");
  });
});

test("staff match page: the kill race races each score behind a switch", { skip: SKIP }, async () => {
  const match = {
    id: "m1", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
    startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:40:00.000Z",
    winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)",
    sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
  };
  const st = (playerId, playerName, side, kills, combat, offense) => ({
    matchId: "m1", playerId, playerName, side, kills, deaths: 1, teamkills: 0, combat, offense, defense: 0, support: 0, slSeconds: 0,
  });
  const detail = (side, kills, scores) => ({
    side, weapons: [], deathByWeapons: [], mostKilled: [], deathBy: [],
    timeline: Array.from({ length: kills }, (_, i) => [30 + i * 30, "k", "X", "M1 GARAND"]),
    killsStreak: kills, deathsWithoutKillStreak: 1, longestLifeSecs: 60, shortestLifeSecs: 20, deathsByTk: 0, scores,
  });
  const body = {
    match,
    stats: [st("p1", "Arty", "allies", 3, 260, 20), st("p2", "Runner", "axis", 1, 40, 900)],
    report: {
      complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [], timeline: [{ minute: 0, allies: 3, axis: 1 }], duels: [], awards: [],
      players: { p1: detail("allies", 3, [[300, 260, 20, 0, 0]]), p2: detail("axis", 1, [[120, 10, 300, 0, 0], [600, 40, 900, 0, 0]]) },
    },
  };
  const overrides = {
    "/api/matches/m1": { body },
    "/api/games/hll/descriptor": { body: { descriptor: { ...HLL_DESCRIPTOR, scoreFields: SCORE_FIELDS } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    await page.locator('svg[aria-label="Every player\'s kills over the round"]').waitFor({ timeout: 15_000 });
    await page.locator('.seg[aria-label="Race"] button', { hasText: "Off" }).click();
    await page.locator('svg[aria-label="Every player\'s offense score over the round"]').waitFor({ timeout: 5_000 });
    const text = await page.locator("body").innerText();
    assert.ok(/Runner · 900/.test(text) && /Arty · 20/.test(text), `the staff race draws the offense race: ${text.slice(0, 400)}`);
  });
});

test("public stats APIs panel: the reply as CRCON sent it, and the CRCON endpoints marked", { skip: SKIP }, async () => {
  // Raw bytes: JSON.stringify would write 1.0 as 1, and the panel must not either.
  const raw = '{"result":{"id":5,"start":"2026-08-01T10:00:00+00:00","end":"2026-08-01T10:20:00+00:00","map_name":"carentan_warfare",'
    + '"map":{"pretty_name":"Carentan Warfare"},"result":{"axis":4,"allied":1},"player_stats":[{"player":"Arty","kill_death_ratio":1.0,"weapons":{}}]},'
    + '"command":"get_map_scoreboard","failed":false,"error":null,"version":"v12.3.0"}';
  const overrides = { ...APIS_OVERRIDES, "/stats/alpha/api/get_map_scoreboard": { raw } };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5/report`, { waitUntil: "networkidle" });
    await page.locator("button.pub-apis-btn:visible").click();
    const entry = page.locator(".pub-api", { hasText: "get_map_scoreboard" });
    await entry.locator(".pub-api-out", { hasText: "kill_death_ratio" }).waitFor({ timeout: 5_000 });
    assert.equal(await entry.locator(".pub-api-url code").textContent(), `${stub.base}/stats/alpha/api/get_map_scoreboard?map_id=5`);
    const out = await entry.locator(".pub-api-out").textContent();
    assert.ok(out.includes('"kill_death_ratio": 1.0'), `the number as it was sent: ${out}`);
    assert.ok(out.includes('\n  "result": {\n    "id": 5,'), "laid out a level an indent");
    assert.ok(out.includes('"weapons": {}'), "an empty object stays on its line");
    assert.equal(await entry.locator(".pub-api-tag").textContent(), "CRCON", "a CRCON endpoint says so");
    assert.equal(await page.locator(".pub-api", { hasText: "Round report" }).locator(".pub-api-tag").count(), 0, "this site's own endpoints don't");
  });
});

/*
 * Past games runs to hundreds of pages once a server's CRCON history is in, and the list used to
 * offer one step either way: "page 1 of 487  Older". The pager reaches the first and last pages,
 * the ones around the page showing, and any page by its number, each page a real link.
 */
test("public stats past games: a pager to any page, by link or by number, on a wide screen and a phone", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const asked = [];
  const round = (id) => ({ id, start: "2026-08-01T10:00:00+00:00", end: "2026-08-01T10:20:00+00:00", map_name: "carentan_warfare",
    map: { pretty_name: `Round ${id}` }, result: { allied: 3, axis: 2 } });
  const overridesFor = (total) => ({
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_scoreboard_maps": (url) => {
      const n = Number(url.searchParams.get("page"));
      asked.push(n);
      // Page 444 lost its rounds between the count and the read (a trim mid-visit).
      const count = n === 444 ? 0 : Math.max(0, Math.min(25, total - (n - 1) * 25));
      const maps = Array.from({ length: count }, (_, i) => round((n - 1) * 25 + i + 1));
      // One slow page, to see the old rows stand dimmed while it comes.
      return { body: { result: { page: n, page_size: 25, total, maps }, failed: false }, delayMs: n === 3 ? 1500 : 0 };
    },
    "/stats/alpha/api/get_map_scoreboard": (url) => ({ body: { result: { ...round(Number(url.searchParams.get("map_id"))), player_stats: [] }, failed: false } }),
  });
  const overrides = overridesFor(487 * 25 - 3); // the last page is short
  const pager = (page) => page.locator('nav.pub-pager[aria-label="Pages"]');
  /** The pager's row as read: each link's text (… for a skipped stretch), the showing page in [ ]. */
  const row = (page) => pager(page).locator(".pub-pages > *").evaluateAll((els) => els.map((e) =>
    e.getAttribute("aria-current") === "page" ? `[${e.textContent}]` : e.textContent));
  const firstRow = (page) => page.locator("table.pub-games tbody tr:first-child td:first-child").innerText();
  const atPage = (page, n) => page.waitForFunction((n) => window.location.search === `?page=${n}`
    && window.document.querySelector('.pub-pages [aria-current="page"]')?.textContent === String(n)
    && !window.document.querySelector(".pub-stale"), n, { timeout: 5_000 });

  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games`, { waitUntil: "networkidle" });
    await pager(page).waitFor({ timeout: 10_000 });
    assert.deepEqual(await row(page), ["[1]", "2", "3", "4", "5", "…", "487", "Older→"], "the newest page: the next ones, and the last");
    assert.equal(await pager(page).locator('a[title="Page 487"]').getAttribute("href"), "/stats/alpha/games?page=487", "a page is a real link");
    assert.match(await pager(page).innerText(), /1–25 of 12,172 rounds/, "where the page sits in the list");

    // The last page, from its link.
    await pager(page).locator('a[title="Page 487"]').click();
    await atPage(page, 487);
    assert.deepEqual(await row(page), ["←Newer", "1", "…", "483", "484", "485", "486", "[487]"], "the oldest page: no step past it");
    assert.equal(await firstRow(page), "Round 12151");
    assert.match(await pager(page).innerText(), /12,151–12,172 of 12,172 rounds/);

    // Any page by its number, from the box.
    const box = pager(page).getByLabel("Page number, 1 to 487");
    await box.fill("250");
    await box.press("Enter");
    await atPage(page, 250);
    assert.deepEqual(await row(page), ["←Newer", "1", "…", "248", "249", "[250]", "251", "252", "…", "487", "Older→"]);
    assert.equal(await firstRow(page), "Round 6226");
    // Into a round and back: the list comes back on the page it was on, not the first.
    await page.locator("table.pub-games a", { hasText: "Round 6230" }).click();
    await page.waitForFunction(() => window.location.pathname === "/stats/alpha/games/6230", null, { timeout: 5_000 });
    const crumb = page.locator(".pub-crumbs a", { hasText: "Past games" });
    assert.equal(await crumb.getAttribute("href"), "/stats/alpha/games?page=250", "the round's way back names the page");
    await crumb.click();
    await atPage(page, 250);
    assert.equal(await box.inputValue(), "", "the box empties once used");
    // Past the end goes to the end; nothing at all goes nowhere.
    await box.fill("9999");
    await pager(page).getByRole("button", { name: "Go" }).click();
    await atPage(page, 487);
    const goButton = pager(page).getByRole("button", { name: "Go" });
    assert.equal(await goButton.isDisabled(), true, "Go waits for a number");
    const ink = () => goButton.evaluate((e) => window.getComputedStyle(e).color);
    const resting = await ink();
    await goButton.hover({ force: true });
    assert.equal(await ink(), resting, "and does not light up under the pointer while it waits");

    // Near the start, a single skipped page is shown, not hidden behind a mark.
    await page.goto(`${stub.base}/stats/alpha/games?page=5`, { waitUntil: "networkidle" });
    await atPage(page, 5);
    assert.deepEqual(await row(page), ["←Newer", "1", "2", "3", "4", "[5]", "6", "7", "…", "487", "Older→"]);
    // A slow page leaves the last rows up, dimmed, until it arrives.
    await pager(page).locator('a[title="Page 3"]').click();
    await page.locator('.pub-stale[aria-busy="true"] table.pub-games').waitFor({ timeout: 2_000 });
    assert.equal(await firstRow(page), "Round 101", "page 5's rows, until page 3 comes");
    await atPage(page, 3);
    assert.equal(await firstRow(page), "Round 51");

    // A page whose rounds went between the count and the read is empty, not "past the end".
    await page.goto(`${stub.base}/stats/alpha/games?page=444`, { waitUntil: "networkidle" });
    await atPage(page, 444);
    assert.equal(await page.locator("table.pub-games tbody").innerText(), "No rounds on this page.");

    // An address past the last page says so and points back at the list.
    await page.goto(`${stub.base}/stats/alpha/games?page=600`, { waitUntil: "networkidle" });
    await pager(page).waitFor({ timeout: 5_000 });
    assert.match(await page.locator("table.pub-games tbody").innerText(), /There is no page 600: the rounds end on page 487/);
    assert.deepEqual(await row(page), ["←Newer", "1", "…", "483", "484", "485", "486", "487"], "no page marked as showing");
    assert.equal(await pager(page).locator('a[title="Newer rounds"]').getAttribute("href"), "/stats/alpha/games?page=487", "Newer steps back onto the list");
    assert.equal(await pager(page).locator("form .muted").count(), 0, "no count for a page with nothing on it");
    assert.deepEqual([...new Set(asked)].sort((a, b) => a - b), [1, 3, 5, 250, 444, 487, 600], "each page read once it was asked for");
  });

  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page, { stub }) => {
    // Three-digit pages are the wide case: with a page either side the row ran onto a second line.
    await page.goto(`${stub.base}/stats/alpha/games?page=250`, { waitUntil: "networkidle" });
    await atPage(page, 250);
    assert.deepEqual(await row(page), ["←", "1", "…", "[250]", "…", "487", "→"], "a phone: the first, this and the last page, bare arrows");
    // Centres, not tops: a "…" is shorter than a page link and sits centred on the same line.
    const mids = await pager(page).locator(".pub-pages > *").evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    }));
    assert.equal(new Set(mids).size, 1, `the pager's row stays on one line on a phone: ${mids.join(",")}`);
    assert.ok(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth), "and the page does not pan sideways");
    await page.goto(`${stub.base}/stats/alpha/games?page=8`, { waitUntil: "networkidle" });
    await atPage(page, 8);
    assert.deepEqual(await row(page), ["←", "1", "…", "[8]", "…", "487", "→"]);
    const tap = await pager(page).locator('a[title="Page 1"]').boundingBox();
    assert.ok(tap.width >= 32 && tap.height >= 32, `a page link is a fingertip wide: ${JSON.stringify(tap)}`);
    const size = await pager(page).locator("input").evaluate((e) => window.getComputedStyle(e).fontSize);
    assert.equal(size, "16px", "16px in the box, or the iPhone zooms the page into it");
    await pager(page).locator('a[title="Older rounds"]').click();
    await atPage(page, 9);
  });

  // The narrowest phone in use (320px, the first iPhone SE), with four- and five-digit page numbers.
  for (const [pages, at] of [[1300, 1250], [12000, 11999]]) {
    await withPage({ grants: OWNER_GRANTS, overrides: overridesFor(pages * 25), viewport: { width: 320, height: 640 } }, async (page, { stub }) => {
      await page.goto(`${stub.base}/stats/alpha/games?page=${at}`, { waitUntil: "networkidle" });
      await atPage(page, at);
      const mids = await pager(page).locator(".pub-pages > *").evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      }));
      assert.equal(new Set(mids).size, 1, `page ${at} of ${pages} on a 320px phone: one line (${(await row(page)).join(" ")})`);
      assert.ok(await page.evaluate(() => window.document.documentElement.scrollWidth <= window.innerWidth), "and no sideways pan");
    });
  }
});

/*
 * A name is the size of the numbers beside it. On a phone the scoreboard scrolls sideways, and
 * Safari enlarges text it judges too small inside anything wider than the screen: it drew names
 * about 1.4 times the numbers' size, the numbers being too short for it to touch. The page sets
 * text-size-adjust, which turns that off; a browser without the enlarging shows the sizes it sets.
 */
test("public scoreboard on a phone: names at the numbers' size, with the phone's text enlarging off", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const row = (id, name, side) => ({
    id, player_id: null, player: name, platform: null, kills: 39, deaths: 20, teamkills: 0, kill_death_ratio: 1.95,
    combat: 0, offense: 0, defense: 0, support: 0, time_seconds: 600, kills_streak: 5, team: { side },
    weapons: {}, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:10:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan Warfare" }, result: { allied: 1, axis: 4 },
    player_stats: [row(1, "1 V 35 ARTY", "axis"), row(2, "IMURHUCKLEBERRY", "axis"), row(3, "Riley", "allies")],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    const sizes = await page.evaluate(() => {
      const row = window.document.querySelector("table.scoreboard tbody tr");
      const name = row.querySelector("td.pub-sb-name strong");
      const num = row.querySelector("td.num");
      const cs = (el) => window.getComputedStyle(el);
      return {
        name: cs(name).fontSize, num: cs(num).fontSize,
        adjust: [cs(name).getPropertyValue("-webkit-text-size-adjust"), cs(name).getPropertyValue("text-size-adjust")],
      };
    });
    assert.equal(sizes.name, sizes.num, "a name is set at its row's number size");
    assert.deepEqual(sizes.adjust, ["100%", "100%"], "and the phone may not enlarge it past that");
  });
});

/*
 * The public server stats page — /stats/<slug>/server. The profile wire arrives precomputed
 * (names only); this proves the page draws it: overview tiles, the maps table with its honest
 * "no lean under five decided rounds" dash, the quality split, records linking to their rounds,
 * and the regulars.
 */
test("public server stats: maps, quality, records and regulars render from the profile wire", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const stats = {
    scannedMatches: 360, truncated: false,
    overview: { matches: 360, avgMinutes: 63, alliesWins: 150, axisWins: 170, attackersWinPct: 64 },
    maps: [
      { id: "carentan_warfare", name: "Carentan Warfare", mode: "warfare", played: 28, avgMinutes: 68, alliesWins: 6, axisWins: 15 },
      { id: "foy_warfare", name: "Foy Warfare", mode: "warfare", played: 2, avgMinutes: 61, alliesWins: 1, axisWins: 1 },
    ],
    quality: { contested: 90, decisive: 140, stomp: 95, crash: 10, other: 0, scored: 335 },
    activity: Array.from({ length: 28 }, (_, i) => ({ day: `2026-08-${String(i + 1).padStart(2, "0")}`, matches: 5 + (i % 9) })),
    seeding: {
      measuredRounds: 300, seededShare: 72, avgPlayers: 71,
      hoursUtc: Array.from({ length: 24 }, (_, h) => (h >= 16 && h <= 23 ? 20 : 2)),
      heroes: [{ name: "tHa gRoUCh", rounds: 32 }, { name: "MAX_LAZER", rounds: 19 }],
      killers: [{ map: "El Alamein Off. GER", drops: 2, after: 4 }],
    },
    records: {
      kills: [{ name: "Soren", side: "allies", value: 127, map: "Kursk Warfare", seq: 41, at: "2026-06-01T10:00:00.000Z" }],
      combat: [{ name: "QuiGon", side: "allies", value: 4086, map: "Kharkov Off.", seq: 52, at: "2026-07-01T10:00:00.000Z" }],
      support: [{ name: "Convehti", side: "axis", value: 7646, map: "Foy Warfare", seq: 61, at: "2026-07-08T10:00:00.000Z" }],
    },
    regulars: {
      playtime: [{ name: "Bido", hours: 94 }],
      kills: [{ name: "QuiGonHim", kills: 2314 }],
    },
    classRecords: [
      { classId: "mg", label: "Machine gun",
        best: [{ name: "Imperial", side: "axis", value: 142, map: "El Alamein Off. GB", seq: 77, at: "2026-06-29T10:00:00.000Z", weapon: "MG42" }],
        career: [{ name: "SGT Marlow", kills: 11713 }],
        deaths: [{ name: "jackburton87", deaths: 4021 }] },
    ],
    weaponRecords: [
      { weapon: "GEWEHR 43", classId: "rifle", label: "Rifle", totalKills: 51234,
        best: [{ name: "LAMBDA", side: "axis", value: 236, map: "Utah Beach Off. US", seq: 88, at: "2026-02-10T10:00:00.000Z" }],
        career: [{ name: "LAMBDA", kills: 9876 }],
        deaths: [{ name: "Clutch", deaths: 903 }] },
    ],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/api/public/alpha/stats": { body: { stats } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    await page.waitForSelector(".stat-tile, .tile, table.mini-table", { timeout: 10_000 });

    const body = await page.locator("body").innerText();
    // innerText carries the CSS uppercase transform on tile labels, so match case-blind.
    assert.ok(/rounds recorded/i.test(body), "the overview tiles render");
    assert.ok(body.includes("63m"), "average round length shows");
    assert.ok(body.includes("Carentan Warfare"), "the maps table renders");
    assert.ok(/71% Axis/.test(body), "a map with enough decided rounds shows its lean");
    const foyRow = page.locator("table.mini-table tr", { hasText: "Foy Warfare" }).first();
    assert.ok((await foyRow.innerText()).includes("—"), "two decided rounds is not a lean");
    assert.ok(body.includes("Contested"), "the quality split renders");
    assert.ok(body.includes("Soren") && body.includes("127"), "the kills record renders");
    assert.ok(body.includes("Bido") && body.includes("94h"), "the regulars render");
    assert.ok(/seeded rounds/i.test(body) && body.includes("72%"), "the seeding share renders");
    assert.ok(body.includes("Machine gun") && body.includes("142") && body.includes("11,713"), "the weapon-class board renders");
    assert.ok(body.includes("MG42"), "the class record names the weapon that carried it");
    assert.equal(await page.locator('a[href="/stats/alpha/games/77"]').count(), 1, "the class record links to its round");
    assert.ok(body.includes("GEWEHR 43") && body.includes("236") && body.includes("51,234"), "the individual-weapon board renders");
    assert.ok(body.includes("jackburton87") && body.includes("4,021"), "the died-to-class leader renders");
    assert.ok(body.includes("Clutch") && body.includes("903"), "the died-to-weapon leader renders");
    assert.equal(await page.locator('a[href="/stats/alpha/games/88"]').count(), 1, "the weapon record links to its round");
    assert.ok(body.includes("tHa gRoUCh") && body.includes("32 rounds"), "the seeding heroes render");
    assert.ok(body.includes("El Alamein Off. GER") && body.includes("2 of 4"), "the killer maps render");

    // A record's map is a real link to its round.
    const link = page.locator('a[href="/stats/alpha/games/41"]');
    assert.equal(await link.count(), 1, "the record links to its round by public alias");
  });
});

/*
 * A career page that failed must not blank the next one. The view stays mounted when only the
 * player changes — a history jump straight from one career page to another — and it reset the
 * career on the way but kept the old error, so every player after one with no career read "No
 * career here" until the page reloaded.
 */
test("public career page: one player's missing career is not carried over to the next", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "alpha", game: "hll", playerIds: true,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/api/public/alpha/player/76561198000000002": { status: 404, body: { error: "not found" } },
    "/api/public/alpha/player/76561198000000001": { body: {
      player: { name: "Smith", platform: "steam", platformId: "76561198000000001" },
      career: { kills: 217, deaths: 100, teamkills: 1, playtimeSec: 7200, visits: 5, combat: 900, offense: 0, defense: 0, support: 0, slSeconds: 3600, matchesPlayed: 10, matchesWon: 6, highestLevel: 141 },
      roles: [], weapons: [], deathsTo: [], rounds: [],
    } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/player/76561198000000002`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /No career here/.test(window.document.body.innerText), null, { timeout: 10_000 });
    // Straight to another career, the way a history jump arrives: same view, a new player.
    await page.evaluate(() => {
      window.history.pushState(null, "", "/stats/alpha/player/76561198000000001");
      window.dispatchEvent(new window.PopStateEvent("popstate"));
    });
    await page.waitForSelector(".stat-tile", { timeout: 10_000 });
    const body = await page.locator("body").innerText();
    assert.ok(body.includes("217"), "the second player's career renders");
    assert.ok(!body.includes("No career here"), "with no error left over from the first");
  });
});

test("server switch: Broadcast and the live welcome never show the server you left", { skip: SKIP }, async () => {
  const bcast = (sid, msg) => ({ serverId: sid, enabled: true, dryRun: false, intervalSec: 300, randomize: false, messages: [msg], updatedAt: "2026-09-26T00:00:00Z" });
  const welcome = (template) => ({ enabled: true, template, intervalSec: 60, updatedAt: "2026-09-26T00:00:00Z" });
  const overrides = threeServers({
    "/api/servers/s1/broadcast": { body: { config: bcast("s1", "LANDING-BROADCAST") } },
    "/api/servers/s1/welcome": { body: { config: welcome("LANDING-WELCOME") } },
    "/api/servers/s2/broadcast": { delayMs: STALE_MS, body: { config: bcast("s2", "STALE-BROADCAST-S2") } },
    "/api/servers/s2/welcome": { delayMs: STALE_MS, body: { config: welcome("STALE-WELCOME-S2") } },
    "/api/servers/s3/broadcast": { body: { config: bcast("s3", "CORRECT-BROADCAST-S3") } },
    "/api/servers/s3/welcome": { body: { config: welcome("CORRECT-WELCOME-S3") } },
  });
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/broadcast`, { waitUntil: "networkidle" });
    const values = () => page.evaluate(() => [...window.document.querySelectorAll("input, textarea")].map((e) => e.value).join(" | ") + " | " + window.document.body.innerText);
    await page.waitForFunction(() => [...window.document.querySelectorAll("input, textarea")].some((e) => e.value.includes("LANDING")) || /LANDING-/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.selectOption(PICKER, "s2");
    await page.selectOption(PICKER, "s3");
    await page.waitForFunction(() => [...window.document.querySelectorAll("input, textarea")].some((e) => e.value.includes("CORRECT-WELCOME-S3")) || /CORRECT-WELCOME-S3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForTimeout(STALE_MS + 800);
    const seen = await values();
    assert.doesNotMatch(seen, /STALE-BROADCAST-S2/, "the abandoned server's rotation landed under the current server");
    assert.doesNotMatch(seen, /STALE-WELCOME-S2/, "the abandoned server's welcome landed under the current server");
    assert.match(seen, /CORRECT-BROADCAST-S3/);
    assert.match(seen, /CORRECT-WELCOME-S3/);

    // And while the next server's settings are on their way, the last server's are not on screen
    // under its name, where Save would write them.
    await page.selectOption(PICKER, "s2");
    await page.waitForTimeout(300);
    assert.doesNotMatch(await values(), /CORRECT-BROADCAST-S3/, "the last server's rotation stood, saveable, under the next server's name");
  });
});

test("server switch: Game rewards never shows the server you left", { skip: SKIP }, async () => {
  const r = (points) => ({ vipHours: 0, points });
  const config = (tag) => ({
    topStats: { enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, broadcast: true, message: "m", categories: [{ id: "kills", enabled: true, ranks: [r(100)] }] },
    killStreaks: { enabled: false, dryRun: true, minPlayers: 20, message: `${tag} {streak} kills`, tiers: [{ kills: 10, reward: r(25) }] },
    playDays: { enabled: false, dryRun: true, minMinutes: 30, message: "m", tiers: [{ days: 3, reward: r(50) }], repeatEveryDays: 7 },
    seedDays: { enabled: false, dryRun: true, message: "m", tiers: [{ days: 3, reward: r(100) }], repeatEveryDays: 7 },
    matchEnd: { enabled: false, dryRun: true, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 0, reward: { vipHours: 24, points: 0 }, message: "m" },
  });
  const recent = (who) => [{ at: "2026-09-26T20:00:00Z", summary: `[dry-run] would reward ${who} with 25 Points`, player: who }];
  const overrides = threeServers({
    "/api/servers/s1/game-rewards": { body: { config: config("LANDING"), recent: recent("LandingAce") } },
    "/api/servers/s2/game-rewards": { delayMs: STALE_MS, body: { config: config("STALE"), recent: recent("StaleAce") } },
    "/api/servers/s3/game-rewards": { body: { config: config("CORRECT"), recent: recent("CorrectAce") } },
  });
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/gamerewards`, { waitUntil: "networkidle" });
    await leaveSlowServer(page, "LandingAce");
    await page.waitForFunction(() => /CorrectAce/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForTimeout(STALE_MS + 800);
    const seen = await page.evaluate(() => [...window.document.querySelectorAll("input, textarea")].map((e) => e.value).join(" | ") + " | " + window.document.body.innerText);
    assert.doesNotMatch(seen, /StaleAce|STALE \{streak\}/, "the abandoned server's rewards landed under the current server");
    assert.match(seen, /CorrectAce/);
  });
});

test("server switch: the CRCON backup counts are the current server's", { skip: SKIP }, async () => {
  const status = (n) => ({ job: null, archive: [{ dataType: "vip", count: n }], fileBytes: 1024 });
  const overrides = threeServers({
    "/api/servers/s1/import/crcon/job": { body: status(111111) },
    "/api/servers/s2/import/crcon/job": { delayMs: STALE_MS, body: status(987654) },
    "/api/servers/s3/import/crcon/job": { body: status(333333) },
  });
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/connections`, { waitUntil: "networkidle" });
    await leaveSlowServer(page, "111,111");
    await page.waitForFunction(() => /333,333/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForTimeout(STALE_MS + 800);
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /987,654/, "the abandoned server's archive counts landed under the current server");
    assert.match(body, /333,333/);
  });
});

test("dashboard: the moderators and staff-activity tiles follow the server, and recover from a failed read", { skip: SKIP }, async () => {
  let activityHealthy = false;
  const overrides = threeServers({
    "/api/layout/dashboard": { body: { source: "default", widgets: [
      { id: "dash-moderators", title: "Moderators", visible: true, order: 10, required: false, size: { w: 4, h: 2 } },
      { id: "dash-team-activity", title: "Team activity", visible: true, order: 20, required: false, size: { w: 4, h: 2 } },
    ] } },
    // The landing server's moderators fail; the next server's answer.
    "/api/audit/staff": (url) => (url.searchParams.get("serverId") === "s3"
      ? { body: { staff: [{ actorName: "CurrentMod", count: 3, lastAt: "2026-09-26T20:00:00Z" }] } }
      : { status: 500, body: { error: "boom" } }),
    // The activity feed fails, then answers: the tile must come back on its next read.
    "/api/audit": (url) => (url.searchParams.get("serverId") === "s3"
      ? { delayMs: STALE_MS, body: { entries: [{ id: "a3", actorName: "Ranger", action: "player.kick", summary: "S3-ACTIVITY", ts: "2026-09-26T20:00:00Z", targetType: null, targetId: null, targetName: null, serverId: "s3" }] } }
      : activityHealthy
        ? { body: { entries: [{ id: "a1", actorName: "Ranger", action: "player.kick", summary: "RECOVERED-ACTIVITY", ts: "2026-09-26T20:00:00Z", targetType: null, targetId: null, targetName: null, serverId: "s1" }] } }
        : { status: 500, body: { error: "blip" } }),
  });
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    // The tile's poll runs on a 20-second timer, so the page boots on a clock the test can move.
    await page.clock.install();
    await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => /Couldn.t load moderators/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForFunction(() => /Couldn.t load activity/.test(window.document.body.innerText), null, { timeout: 15_000 });
    // The feed's next poll answers, and the tile shows it.
    activityHealthy = true;
    await page.clock.fastForward(21_000);
    await page.waitForFunction(() => /RECOVERED-ACTIVITY/.test(window.document.body.innerText), null, { timeout: 10_000 });
    // Another server: the last one's failure is not this one's, nor is its feed while this one's loads.
    await page.selectOption(PICKER, "s3");
    await page.waitForFunction(() => /CurrentMod/.test(window.document.body.innerText), null, { timeout: 10_000 });
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /Couldn.t load moderators/);
    assert.doesNotMatch(body, /RECOVERED-ACTIVITY/, "the last server's staff feed stood under the next server's name");
  });
});

/*
 * The installed app wears the program's own mark: the sidebar's slate square with its white letter,
 * never a community's badge. Each icon is read pixel by pixel: the letter's ink is white, centred,
 * and as tall as its platform needs (inside the middle 80% for the maskable one, all an Android
 * launcher is sure to show); the square around it is the slate gradient, edge to edge on the two
 * full-bleed ones, with see-through rounded corners on the other two.
 */
test("the app icons are the program's own mark, placed for each platform", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    const result = await page.evaluate(async () => {
      const out = {};
      for (const file of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
        const img = new window.Image();
        img.src = `/icons/${file}`;
        await img.decode();
        const n = img.naturalWidth;
        const c = window.document.createElement("canvas");
        c.width = n; c.height = n;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, n, n).data;
        const at = (x, y) => [...d.subarray((y * n + x) * 4, (y * n + x) * 4 + 4)];
        let x0 = n, y0 = n, x1 = -1, y1 = -1;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const [r, gr, b, a] = at(x, y);
          if (a < 200 || r < 230 || gr < 230 || b < 230) continue;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        out[file] = { n, ink: x1 < 0 ? null : { x0, y0, x1, y1 }, corner: at(1, 1), edge: at(Math.floor(n / 2), Math.floor(n * 0.06)) };
      }
      return out;
    });
    const want = { "icon-192.png": [0.42, false], "icon-512.png": [0.42, false], "icon-maskable-512.png": [0.34, true], "apple-touch-icon.png": [0.42, true] };
    for (const [file, { n, ink, corner, edge }] of Object.entries(result)) {
      const [cap, opaque] = want[file];
      assert.ok(ink, `${file}: a white letter`);
      const h = (ink.y1 - ink.y0 + 1) / n;
      assert.ok(Math.abs(h - cap) < 0.03, `${file}: the letter is ${h.toFixed(2)} of the side, not ${cap}`);
      for (const [lo, hi, axis] of [[ink.x0, ink.x1, "across"], [ink.y0, ink.y1, "down"]]) {
        assert.ok(Math.abs((lo + hi + 1) / 2 / n - 0.5) < 0.03, `${file}: the letter is centred ${axis}`);
      }
      const [r, g, b, a] = edge;
      assert.ok(a === 255 && b > r + 20 && r >= 60 && r <= 110 && g > r, `${file}: slate around the letter, not ${edge}`);
      assert.equal(corner[3], opaque ? 255 : 0, `${file}: ${opaque ? "full-bleed" : "see-through rounded corners"}`);
    }
  });
});

/*
 * Seeding areas (containment) and the offensive pace rule — the ground rules — live on Auto
 * settings → Map zones, beside the zone-set library, under that page's own permission (the rules
 * permission) for staff who can also read the seeding config. The ordinary Seeding tab says
 * nothing about them to anyone. For a holder the painter works: the grid is the tactical map's own
 * 10×10, and painting a cell stores it under the brush's side.
 */
test("seeding areas: the painter lives on Map zones under the rules permission; the Seeding tab stays silent", { skip: SKIP }, async () => {
  const SEED_CAPS = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "seeding.config", scopeType: "global", scopeId: null, level: "write" },
  ];
  const RULES = { capability: "admin.moderation", scopeType: "global", scopeId: null, level: "write" };
  const zonesResponse = { body: { sets: [], maps: [{ key: "carentan", label: "Carentan" }] } };
  const seedingResponse = { body: {
    config: {
      serverId: "s1", enabled: true, dryRun: true, seedTarget: 40, minPlayers: 5,
      disallowedRoles: [], disallowedWeaponClasses: [], disallowedWeapons: [], disallowedWeaponNames: [], disallowedCommanderAbilities: [],
      capFightEnabled: false, capFightMaxCaps: 3, capFightSkipWarning: false, capFightNotice: "",
      containEnabled: true, containGraceSec: 60, containMaxPlayers: 60, containNotice: "Leaving your team's seeding area",
      containZones: { carentan: { allies: ["A1"], axis: ["J10"], shared: ["E5"] } },
      paceEnabled: false, paceUnlockMinutes: [0, 0, 20, 40, 60], paceNotice: "",
      immuneLevel: 0, immuneTags: [], announceMessage: "", maxWarnings: 2, warnIntervalSec: 60, warnMessage: "w",
      maxPunishes: 2, punishIntervalSec: 60, punishMessage: "p", kickAfter: true, kickMessage: "k",
      rewardEnabled: false, rewardHours: 0, rewardPoints: 0, rewardLinkedNote: "", rewardUnlinkedNote: "",
      minSeedMinutes: 15, rewardCumulative: true, rewardMessage: "r", rewardDelaySec: 0, phaseConfirmSec: 0, phaseHysteresis: 0,
    },
    roles: { 13: "Commander" }, weaponClasses: [], weapons: [], commanderAbilities: [],
    containMaps: [{ key: "carentan", label: "Carentan" }, { key: "foy", label: "Foy" }],
    announcePreview: "", configured: true,
  } };

  // The Seeding tab is whole and silent about position rules — even for staff who see them on
  // Map zones, so the two surfaces cannot be confused.
  await withPage({ grants: [...SEED_CAPS, RULES], overrides: { "/api/servers/s1/seeding": seedingResponse, "/api/zones": zonesResponse } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/seeding`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Population thresholds/i.test(window.document.body.innerText), null, { timeout: 15_000 });
    const text = await page.locator("body").innerText();
    assert.ok(!/Seeding areas/i.test(text), "the containment card must not exist on the Seeding tab");
    assert.ok(!/Offensive pace|Steamroll/i.test(text), "nor the pace card");
    assert.equal(await page.locator(".zone-grid").count(), 0);
  });

  // Seeding staff without the rules permission: no Map zones tab, no ground rules.
  await withPage({ grants: SEED_CAPS, overrides: { "/api/servers/s1/seeding": seedingResponse } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Population thresholds/i.test(window.document.body.innerText), null, { timeout: 15_000 });
    const tabs = await page.locator('[role="tab"]').allInnerTexts();
    assert.ok(!tabs.some((t) => /Map zones/i.test(t)), `no Map zones tab: ${tabs.join(", ")}`);
    assert.ok(!/Seeding zones|Also judge the cap fight by position/.test(await page.locator("body").innerText()), "and no ground rules anywhere");
    assert.equal(await page.locator(".zone-grid").count(), 0);
  });

  // Rules staff who cannot read the seeding config: the library, and no ground rules.
  await withPage({ grants: [SEED_CAPS[0], RULES], overrides: { "/api/zones": zonesResponse } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Zone sets/i.test(window.document.body.innerText), null, { timeout: 15_000 });
    const text = await page.locator("body").innerText();
    // The page's own description names the ground rules (that is how search finds them); the
    // section itself, with its cards, is what must be absent.
    assert.ok(!/Seeding zones|Also judge the cap fight by position|Steamroll protection/.test(text), "the ground rules are seeding config too");
    assert.equal(await page.locator(".zone-grid").count(), 0, "no seeding painter (and no set is open)");
  });

  // Rules staff who can read seeding: the library AND the ground rules — the painter, drawn
  // cells, and a click that paints.
  await withPage({ grants: [...SEED_CAPS, RULES], overrides: {
    "/api/servers/s1/seeding": seedingResponse,
    "/api/zones": zonesResponse,
  } }, async (page, { stub }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    const text = await page.locator("body").innerText();
    assert.ok(/Ground rules/.test(text) && /Offensive pace/.test(text), "the ground rules, pace included, are here");
    // One switch per job: the zones, the cap fight by position, steamroll protection — no master
    // switch over them, no separate auto-zones or learning switch.
    assert.equal(await page.locator(".setting-title", { hasText: /^Seeding zones$/ }).count(), 1, "one switch for the zones");
    assert.ok(/Also judge the cap fight by position/.test(text) && /Steamroll protection/.test(text));
    assert.ok(!/Position-based rules|Learn map layouts|Auto zones \(no map setup\)|Keep each team off/.test(text), "the old overlapping switches are gone");
    // Explanations fold: a setting's description is out of sight until its Explanation is opened.
    const zonesCard = page.locator(".setting-card").filter({ has: page.locator(".setting-title", { hasText: /^Seeding zones$/ }) });
    assert.ok(!(await zonesCard.innerText()).includes("players on the deploy screen are never flagged"), "folded by default");
    await zonesCard.locator("summary", { hasText: "Explanation" }).click();
    assert.ok((await zonesCard.innerText()).includes("players on the deploy screen are never flagged"), "one click opens it");
    // Seeding zones has three positions — Off, Learn only, On — and shows the stored one.
    assert.deepEqual(await zonesCard.locator(".seg-btn").allInnerTexts(), ["Off", "Learn only", "On"]);
    assert.equal(await zonesCard.locator('.seg-btn[aria-pressed="true"]').innerText(), "On", "the server's zones are on");
    await zonesCard.locator(".seg-btn", { hasText: "Learn only" }).click();
    assert.equal(await zonesCard.locator('.seg-btn[aria-pressed="true"]').innerText(), "Learn only");
    // Checked before the click: while the save is in flight the button reads "Saving…".
    assert.ok(await page.locator('button:has-text("Save")').count() > 0, "and the rules permission at write can save them");
    await page.locator("div.card").filter({ has: page.getByText("Seeding enforcement judged from live positions.") }).last()
      .locator("button.primary", { hasText: "Save" }).click();
    let put = null;
    for (let i = 0; i < 50 && !put; i++) {
      put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/servers/s1/seeding") ?? null;
      if (!put) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(put, "the save reached the API");
    assert.equal(put.body.containEnabled, false, "Learn only enforces nothing");
    assert.equal(put.body.layoutLearnEnabled, true, "…and learns");
    assert.ok(/Zone sets/.test(text), "beside the zone-set library");
    assert.equal(await page.locator(".zone-grid .zg").count(), 100, "the tactical map's whole 10×10 grid");
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 1, "the stored allies cell is painted");
    assert.equal(await page.locator(".zone-grid .zg-axis").count(), 1);
    assert.equal(await page.locator(".zone-grid .zg-shared").count(), 1);
    // Paint B1 (second cell, row-major) with the default allies brush.
    await page.locator(".zone-grid .zg").nth(1).click();
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 2, "the clicked cell now wears the brush");
    // …and painting the axis cell with the allies brush reassigns it rather than stacking.
    await page.locator(".zone-grid .zg-axis").first().click();
    assert.equal(await page.locator(".zone-grid .zg-axis").count(), 0);
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 3);
  });
});

/*
 * The Vietnam objectives picker, end to end in a real browser.
 *
 * This exists because the highlight feature shipped WITHOUT it and nobody noticed the map was
 * absent on the game it was asked for: the picker resolved its art through tacMapUrl, which
 * answers null for anything but WW2, so a Vietnam server drew the rows and nothing else — no
 * map, no highlights, and no grid to teach squares on. The picker now resolves through
 * liveMapUrl (the resolver that knows Vietnam's six bundled gridded maps), and this test pins
 * every layer of the screen: the art, the taught names over digit wires, the saved-layout line
 * with its exit, the highlight when a taught option is picked, and the teach grid.
 */
test("Vietnam objectives: the gridded map renders with taught names, saved layout, and teach cells", { skip: SKIP }, async () => {
  const overrides = {
    "/api/servers": { body: { servers: [{ id: "s1", name: "NAM #1", game: "hllv", engagementMode: "active" }] } },
    "/api/games/hllv/descriptor": { body: { descriptor: {
      id: "hllv", label: "HLL: Vietnam", roles: {},
      sides: [
        { id: "allies", label: "United States", color: "blue", teamValues: [0], parity: "even" },
        { id: "axis", label: "North Vietnam", color: "red", teamValues: [1], parity: "odd" },
      ],
      scoreFields: [], squadLeaderRoles: [], configFields: [],
    } } },
    "/api/servers/s1/maps": { body: {
      current: { id: "vantuong_warfare", prettyName: "Vạn Tường", gameMode: "Warfare", environment: "day", family: "vantuong" },
      currentIndex: 0, rotation: [], maps: [
        { id: "vantuong_warfare", prettyName: "Vạn Tường", gameMode: "Warfare", environment: "day", family: "vantuong" },
      ],
    } },
    "/api/servers/s1/maprotation/sets": { body: { sets: [] } },
    "/api/servers/s1/maps/objectives": { body: {
      rows: [["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"], ["0", "1", "2"]],
      mapKey: "vantuong",
      points: [{ game: "hllv", mapKey: "vantuong", row: 0, idx: 1, name: "Hilltop Radio", sector: "E6" }],
      mapId: "vantuong_warfare", saved: [1, 0, 2, 0, 1],
    } },
  };
  await withPage({ overrides }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    const panel = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Objectives" }) });
    await panel.waitFor({ timeout: 15000 });

    // The hint speaks Vietnam's truth, not WW2's.
    assert.match(await panel.innerText(), /On Vietnam the layout SAVES/);

    // The rotation's "In play" banner answers from Vietnam's own set too — every map-art
    // resolver used to say null for hllv, so Vietnam screens were bare text beside WW2's.
    const banner = page.locator("img.map-banner").first();
    await banner.waitFor({ timeout: 15000 });
    assert.match(await banner.getAttribute("src"), /\/game\/hllv\/maps\/vantuong\.webp$/);

    // The map is Vietnam's own bundled gridded art — the layer that used to be silently absent.
    const art = panel.locator("img.tac-map");
    await art.waitFor({ timeout: 15000 });
    assert.match(await art.getAttribute("src"), /\/game\/hllv\/maps\/vantuong\.webp$/);

    // Digit wires wear their taught names; untaught digits are honest placeholders.
    await panel.locator("button", { hasText: "Hilltop Radio" }).first().waitFor();
    assert.ok((await panel.locator("button", { hasText: "Option 3" }).count()) >= 1);

    // The saved layout is reported in the same vocabulary, with its exit beside it.
    const savedLine = panel.locator("p", { hasText: "Saved layout for this map" });
    assert.equal(await savedLine.count(), 1);
    assert.match(await savedLine.innerText(), /Hilltop Radio/);
    assert.equal(await panel.locator("button", { hasText: "Clear saved layout" }).count(), 1);

    // Picking the taught option lights its square: the highlight overlay carries the row badge.
    await panel.locator("button", { hasText: "Hilltop Radio" }).first().click();
    await page.waitForFunction(() => {
      const img = window.document.querySelector("img.tac-map");
      if (!img) return false;
      return [...img.parentElement.querySelectorAll("span")].some((s) => s.textContent === "1");
    });

    // Teach mode: the 10×10 grid appears, one tappable cell per square the art prints.
    await panel.locator("label.toggle", { hasText: "Edit locations" }).click();
    await page.waitForFunction(() => window.document.querySelectorAll('[aria-label^="teach cell"]').length === 100);

    // Un-teaching exists: arm the taught option and Forget wipes name and square through the
    // same PUT (blank halves clear) — the exit this screen shipped without.
    await panel.locator("button", { hasText: "Hilltop Radio" }).first().click();
    const forgetBtn = panel.locator("button", { hasText: "Forget location" });
    await forgetBtn.waitFor({ timeout: 15000 });
    await forgetBtn.click();
    const putDone = page.waitForResponse((r) => r.url().includes("/api/servers/s1/maps/objective-points") && r.request().method() === "PUT");
    await page.locator(".confirm-modal button", { hasText: "Forget it" }).click();
    await putDone;
    const wiped = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/servers/s1/maps/objective-points");
    assert.ok(wiped, "the forget reached the teach route");
    assert.equal(wiped.body.name, "");
    assert.equal(wiped.body.sector, "");
    assert.equal(wiped.body.row, 0);
    assert.equal(wiped.body.idx, 1);

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("live settings: an on/off answer in words reads right, and an unreported switch says so", { skip: SKIP }, async () => {
  /*
   * The issue check of the map shuffle setting (6331b81e). The page read every switch with
   * Boolean(value): any non-empty string was ON, so a server answering "off" showed the switch on.
   * And a switch the server did not report at all showed "Disabled" — for map shuffle (which
   * Vietnam's document gives no getter for) that read as "shuffle is off" when nobody knew.
   */
  const descriptor = {
    id: "hll", label: "HLL", roles: {}, sides: [], scoreFields: [], squadLeaderRoles: [],
    configFields: [
      { field: "autoBalanceEnabled", label: "Auto-balance", kind: "bool", read: { command: "getAutoBalanceEnabled", key: "enable" }, write: { command: "setAutoBalanceEnabled", param: "enabled" } },
      { field: "voteKickEnabled", label: "Vote kick", kind: "bool", read: { command: "getVoteKickEnabled", key: "enable" }, write: { command: "setVoteKickEnabled", param: "enabled" } },
      { field: "mapShuffle", label: "Map shuffle", kind: "bool", read: { command: "getMapShuffleEnabled", key: "enable" }, write: { command: "setMapShuffleEnabled", param: "enabled" } },
    ],
  };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/games/hll/descriptor": { body: { descriptor } },
      "/api/servers/s1/config": { body: { serverId: "s1", config: { autoBalanceEnabled: true, voteKickEnabled: "off", mapShuffle: null }, managed: null } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/admin/live`, { waitUntil: "networkidle" });
    // The cards draw from the descriptor before the server's answer lands (every switch off until
    // then), so wait for the answer itself: only a landed read can say a switch went unreported.
    await page.waitForFunction(() => /Not reported by the server/.test(window.document.body.innerText), null, { timeout: 15_000 });
    const labels = await page.evaluate(() => Object.fromEntries([...window.document.querySelectorAll(".setting-card")].map((c) => [
      c.querySelector(".setting-title")?.textContent?.trim() ?? "",
      c.querySelector(".toggle-label")?.textContent?.trim() ?? "",
    ])));
    assert.equal(labels["Auto-balance"], "Enabled");
    assert.equal(labels["Vote kick"], "Disabled", "an answer of \"off\" is off, not on");
    assert.equal(labels["Map shuffle"], "Not reported by the server", "unknown is not shown as a fact");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("nothing is cut off the side of the screen on a phone", { skip: SKIP }, async () => {
  /*
   * The recurring field report, as one guard instead of a bug at a time: the escalation ladder cut
   * off on mobile, the drawer that could not reach the server selector, the widgets past the edge.
   * Each was found by somebody looking at their phone, and each was fixed alone.
   *
   * The measure has to be the RIGHT one, and the obvious one is wrong here: `.app-shell` sets
   * `overflow-x: clip`, so a page can never report sideways scroll no matter how far its content
   * runs over. That is the whole reason these arrive as "cut off" rather than "scrolls" — the
   * content is not reachable at all, it is shorn off at the edge and gone. So this compares each
   * element's right edge against the shell that clips it, and skips anything inside a container
   * that scrolls or clips on its own (a wide table in `.scroll-x` is doing its job).
   */
  const ROUTES = [
    "/dashboard", "/live", "/history", "/players", "/moderation", "/events",
    "/maps", "/maps/vote", "/maps/rotation", "/maps/votesetup", "/maps/catalogue",
    "/autosettings", "/autosettings/rules", "/discord", "/analytics", "/admin", "/help",
  ];
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 } }, async (page) => {
    const base = page.url().split("#")[0];
    const offenders = [];
    for (const route of ROUTES) {
      await page.goto(`${base}#${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(250); // let the route's first paint settle
      const worst = await page.evaluate(() => {
        const shell = window.document.querySelector(".app-shell") ?? window.document.body;
        const edge = shell.getBoundingClientRect().right;
        const SLACK = 2; // sub-pixel rounding is not a bug
        /** Does an ancestor already scroll or clip this element horizontally? Then it is contained. */
        const contained = (el) => {
          for (let p = el.parentElement; p && p !== shell; p = p.parentElement) {
            const ox = window.getComputedStyle(p).overflowX;
            if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
          }
          return false;
        };
        let out = null;
        for (const el of shell.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right <= edge + SLACK) continue;
          if (contained(el)) continue;
          if (!out || r.right > out.right) {
            out = { right: Math.round(r.right), edge: Math.round(edge), tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 70) };
          }
        }
        return out;
      });
      if (worst) {
        offenders.push(`${route}: <${worst.tag} class="${worst.cls}"> reaches ${worst.right}px past a ${worst.edge}px edge`);
      }
    }
    assert.deepEqual(offenders, [], "these are shorn off the side of the screen, not scrollable to");
  });
});

/*
 * The economy result belongs to the group it was applied to: switching groups used to leave the
 * previous group's "N adjusted / N skipped" on screen under the new group's name.
 */
test("groups: an economy result is cleared when another group is picked", { skip: SKIP }, async () => {
  const grants = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "player.groups", scopeType: "global", scopeId: null, level: "write" },
    { capability: "economy.balances", scopeType: "global", scopeId: null, level: "write" },
  ];
  const member = (g) => ({ groupId: g, playerId: "76561190000000001", playerName: "Ana", addedByName: "owner", addedAt: "2026-09-01T00:00:00.000Z" });
  const overrides = {
    "/api/player-groups": { body: { groups: [
      { id: "g1", name: "Winners", description: null, memberCount: 1, createdByName: "owner" },
      { id: "g2", name: "Casters", description: null, memberCount: 1, createdByName: "owner" },
    ] } },
    "/api/player-groups/g1": { body: { members: [member("g1")] } },
    "/api/player-groups/g2": { body: { members: [member("g2")] } },
    "/api/economy/groups/g1/adjust": { body: { group: { id: "g1", name: "Winners" }, currency: "Points", applied: [], skipped: [{ playerId: "76561190000000001", playerName: "Ana", reason: "no Discord link" }] } },
  };
  await withPage({ grants, overrides }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Amount per member", { timeout: 15_000 });
    await page.getByPlaceholder("the ledger row other staff read").fill("event prize");
    await page.locator('button:has-text("Grant economy — whole group")').click();
    await page.locator('button:has-text("Grant to group")').click();
    // The skipped member's reason lives only in the result box (the toast just counts).
    await page.waitForSelector("text=Ana — no Discord link", { timeout: 10_000 });
    await page.locator('select:has(option[value="g2"])').selectOption("g2");
    await page.waitForFunction(() => !/Ana — no Discord link/.test(window.document.body.innerText), null, { timeout: 5_000 });
  });
});

/*
 * A group kept by a Discord role says so — which role, and which members the sync listed — and a
 * manager can link one by picking from the community's roles.
 */
test("groups: a Discord-synced group names its role and marks the members it listed; linking picks a role", { skip: SKIP }, async () => {
  const overrides = {
    "/api/player-groups": { body: { groups: [
      { id: "g1", name: "WW2 CVC", description: null, memberCount: 2, createdByName: "owner", vipPerk: null, discordRoleId: "900000000000000777" },
      { id: "g2", name: "Streamers", description: null, memberCount: 1, createdByName: "owner", vipPerk: null, discordRoleId: null },
    ] } },
    "/api/player-groups/g1": { body: {
      group: { id: "g1", name: "WW2 CVC", discordRoleId: "900000000000000777" },
      members: [
        { groupId: "g1", playerId: "76561190000000001", playerName: "Ana", addedByName: "discord-sync", addedAt: "2026-09-01T00:00:00.000Z", source: "discord" },
        { groupId: "g1", playerId: "76561190000000002", playerName: "Hand", addedByName: "owner", addedAt: "2026-09-01T00:00:00.000Z", source: "panel" },
      ],
      perkStatus: null,
      discordRole: { id: "900000000000000777", name: "CVC Team", problem: "2001 members hold its role — more than a group sync takes on (2000), so the group is left as it is" },
    } },
    "/api/player-groups/g2": { body: {
      group: { id: "g2", name: "Streamers", discordRoleId: null },
      members: [{ groupId: "g2", playerId: "76561190000000009", playerName: "Zed", addedByName: "owner", addedAt: "2026-09-01T00:00:00.000Z", source: "panel" }],
      perkStatus: null, discordRole: null,
    } },
    // No community server set: the staff server's roles stand in, and the picker says so.
    "/api/discord/roles": { body: { fellBack: true, roles: [{ id: "900000000000000777", name: "CVC Team", color: 0 }, { id: "900000000000000888", name: "Streamers", color: 0 }] } },
    // Slow, so the viewer can click to another group before the link's reload comes back.
    "/api/player-groups/g1/discord-role": { delayMs: 1500, body: { group: { id: "g1", name: "WW2 CVC", discordRoleId: "900000000000000888" } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { errors, stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Kept in step with the role @CVC Team/.test(window.document.body.innerText), null, { timeout: 15_000 });
    const rows = await page.locator("table.table tbody tr").allInnerTexts();
    // Badges are upper-cased by CSS, which innerText reports as shown.
    assert.ok(rows.some((r) => /Ana/.test(r) && /via discord/i.test(r)), "the sync's member is marked");
    assert.ok(rows.some((r) => /Hand/.test(r) && !/via discord/i.test(r)), "a hand-added member is not");
    assert.match(await page.locator("body").innerText(), /Not in step\s+2001 members hold its role/i, "why the last sync left the group alone");
    await page.locator('button:has-text("Change role")').click();
    await page.waitForFunction(() => /These are your staff Discord server/.test(window.document.body.innerText), null, { timeout: 5_000 });
    await page.locator('select:has(option[value="900000000000000888"])').selectOption("900000000000000888");
    await page.locator('button:has-text("Link role")').click();
    // The request lands on the stub (this process), so wait for it here rather than in the page.
    const find = () => stub.calls.find((c) => c.path === "/api/player-groups/g1/discord-role" && c.method === "PUT");
    for (let i = 0; i < 50 && !find(); i++) await page.waitForTimeout(100);
    assert.deepEqual(find()?.body, { roleId: "900000000000000888" });
    // Clicked to another group while the link was still saving: its reload must not paint g1 over g2.
    const g1Reads = () => stub.calls.filter((c) => c.path === "/api/player-groups/g1" && c.method === "GET").length;
    const readsBefore = g1Reads();
    await page.locator('select:has(option[value="g2"])').selectOption("g2");
    await page.waitForFunction(() => /Zed/.test(window.document.body.innerText), null, { timeout: 5_000 });
    for (let i = 0; i < 40 && g1Reads() === readsBefore; i++) await page.waitForTimeout(100);
    assert.ok(g1Reads() > readsBefore, "the link's reload of g1 went out");
    await page.waitForTimeout(300);
    const after = await page.locator("table.table tbody tr").allInnerTexts();
    assert.ok(after.some((r) => /Zed/.test(r)) && !after.some((r) => /Ana|Hand/.test(r)), `g2's members stay on screen: ${JSON.stringify(after)}`);
    assert.doesNotMatch(await page.locator("body").innerText(), /Kept in step with the role/, "and not g1's role line");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("Live view: grant VIP to the selection, with the per-player VIP message", { skip: SKIP }, async () => {
  const overrides = {
    "/api/servers/s1/live": { body: {
      players: [
        { id: "p1", playerId: "76561198000000001", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 } },
        { id: "p2", playerId: "76561198000000002", name: "OtherGuy", team: 1, unit: "BAKER", role: "rifleman", level: 20, stats: { infantryKills: 0, vehicleKills: 0, deaths: 0, teamKills: 0 } },
      ],
      session: { playerCount: 2, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 1, remainingMatchTime: 100, matchTime: 10 },
    } },
    "/api/servers/s1/vips/bulk": { body: {
      applied: [{ playerId: "76561198000000001", playerName: "TestGuy", note: "until …", messaged: true }, { playerId: "76561198000000002", playerName: "OtherGuy", note: "until …", messaged: false }],
      skipped: [], messageFailed: 1,
    } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard thead", { timeout: 15_000 });
    await page.locator('.scoreboard thead input[type="checkbox"]').check();
    await page.waitForFunction(() => window.document.querySelectorAll('.scoreboard tbody input[type="checkbox"]:checked').length === 2, null, { timeout: 10_000 });
    await page.locator(".scoreboard thead .pa-menu button").click();
    await page.locator(".scoreboard thead .pa-mi", { hasText: "Grant VIP" }).click();

    const msg = page.locator(".pa-modal textarea");
    assert.match(await msg.inputValue(), /\{vip_until\}/, "the VIP message is ready to send");
    await page.locator(".pa-modal input[type=number]").first().fill("2");
    await page.locator(".pa-modal label", { hasText: "Comment (required)" }).locator("input").fill("seeded the server");
    await page.locator(".pa-modal button", { hasText: "Grant VIP to selected (2)" }).click();
    await page.locator(".pa-modal").waitFor({ state: "detached" });

    const call = stub.calls.find((c) => c.path === "/api/servers/s1/vips/bulk");
    assert.ok(call, "one call grants and messages");
    assert.equal(call.body.players.length, 2);
    assert.equal(call.body.days, 2);
    assert.equal(call.body.cumulative, true, "stacks on top of existing VIP by default");
    assert.equal(call.body.comment, "seeded the server");
    assert.match(call.body.message, /\{vip_remaining\}/);
    // The one whose message did not arrive is named, so staff can message them again.
    assert.match((await page.locator(".scoreboard-summary, body").first().textContent()) ?? "", /OtherGuy|not messaged/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Game rewards: a number box never shows "012", the top-stats categories move with ▲ ▼, and Save
 * sends that order plus the cards' arrangement (which a match end's one combined message follows).
 */
test("game rewards: no leading zeros, categories re-order, the arrangement is saved", { skip: SKIP }, async () => {
  const r = (vipHours) => ({ vipHours, points: 0 });
  const config = {
    order: ["matchEnd", "topStats", "killStreaks", "playDays", "seedDays"],
    topStats: { enabled: true, dryRun: true, minMinutes: 20, minPlayers: 40, broadcast: true, message: "m",
      categories: [{ id: "kills", enabled: true, ranks: [r(12)] }, { id: "support", enabled: true, ranks: [r(12)] }] },
    killStreaks: { enabled: false, dryRun: true, minPlayers: 20, message: "m", tiers: [] },
    playDays: { enabled: false, dryRun: true, minMinutes: 30, message: "m", tiers: [], repeatEveryDays: 7 },
    seedDays: { enabled: false, dryRun: true, message: "m", tiers: [], repeatEveryDays: 7 },
    matchEnd: { enabled: true, dryRun: true, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 0, reward: r(24), message: "m" },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/game-rewards": { body: { config, recent: [] } } } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/gamerewards`, { waitUntil: "networkidle" });
    const end = page.locator(".panel").filter({ has: page.locator(".panel-head", { hasText: "Everyone at match end" }) }).first();
    await end.waitFor();
    const players = end.locator("input[type=number]").nth(2);
    // What a phone ends up with typing "10" into a box that held "0". iPhone Safari kept showing
    // "010"; desktop Chromium tidies it by itself, so this pins the flow, and formNumber's tests
    // pin the tidying that fixes the phone.
    await players.fill("010");
    assert.equal(await players.inputValue(), "10");

    await page.getByRole("button", { name: "Move Support up" }).click();
    await page.locator("button", { hasText: /^Save$/ }).first().click();
    await page.waitForFunction(() => window.document.body.innerText.includes("Saved."));
    const put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/servers/s1/game-rewards");
    assert.equal(put.body.matchEnd.minPlayers, 10);
    assert.deepEqual(put.body.topStats.categories.map((c) => c.id), ["support", "kills"]);
    assert.deepEqual(put.body.order, ["matchEnd", "topStats", "killStreaks", "playDays", "seedDays"], "the cards as arranged on screen");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Recent rewards after a full server's match end: a line per player. The kind filter brings the
 * top-stats winners back into view without scrolling past everyone's match-end line.
 */
test("game rewards: recent rewards filter by kind", { skip: SKIP }, async () => {
  const r = (vipHours) => ({ vipHours, points: 0 });
  const config = {
    order: ["matchEnd", "topStats", "killStreaks", "playDays", "seedDays"],
    topStats: { enabled: true, dryRun: false, minMinutes: 20, minPlayers: 40, broadcast: true, showEveryone: true, message: "m", categories: [{ id: "combat", enabled: true, ranks: [r(12)] }] },
    killStreaks: { enabled: false, dryRun: true, minPlayers: 20, message: "m", tiers: [] },
    playDays: { enabled: false, dryRun: true, minMinutes: 30, message: "m", tiers: [], repeatEveryDays: 7 },
    seedDays: { enabled: false, dryRun: true, message: "m", tiers: [], repeatEveryDays: 7 },
    matchEnd: { enabled: true, dryRun: false, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 5, reward: r(24), message: "m" },
  };
  const recent = [
    ...Array.from({ length: 40 }, (_, i) => ({ at: "2026-09-26T22:10:00Z", summary: `rewarded Player${i} with 1d of VIP — finished a 90-minute match`, player: `Player${i}`, kind: "matchEnd" })),
    { at: "2026-09-26T22:09:36Z", summary: "rewarded Budprodigy with 12h of VIP — #1 combat (1300)", player: "Budprodigy", kind: "topStats" },
  ];
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/game-rewards": { body: { config, recent } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/gamerewards`, { waitUntil: "networkidle" });
    const chip = page.locator("button", { hasText: "Top stats (1)" });
    await chip.waitFor();
    await chip.click();
    const lines = page.locator(".panel").filter({ has: page.locator(".panel-head", { hasText: "Recent rewards" }) }).locator("li");
    assert.equal(await lines.count(), 1);
    assert.match((await lines.first().textContent()) ?? "", /Budprodigy/);
    await page.locator("button", { hasText: /^All$/ }).click();
    assert.equal(await lines.count(), 41);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Lists download as files — the VIP list, the ban record, a payout's receipts, a group's members —
 * in the format picked in the popup, which this device remembers for the next one. A file holds
 * the list as it stands: a search narrows it, a list the screen holds only in part (receipts) is
 * read whole, and a game id is never a number.
 */
test("the VIP list, bans, payout receipts and a group's members download as Excel, CSV or JSON", { skip: SKIP }, async () => {
  const at = "2026-10-20T18:30:00.000Z";
  const vip = (playerId, playerName, expiration, comment) => ({ id: `v-${playerId}`, serverId: "s1", playerId, playerName, comment, expiration, pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null, createdByName: "owner", createdAt: at, updatedAt: at });
  const receipts = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, displayName: `Member ${i}`, discordId: `1000${i}`, status: "PASS", error: "", detail: { balanceBefore: 0, balanceAfter: 100 } }));
  const job = { id: "j1", sourceType: "online", payoutType: "currency", amount: 100, serverIds: ["s1"], audience: "linked", dryRun: false, status: "COMPLETE", requestedByName: "owner", createdAt: at, completedAt: at, totalCount: receipts.length, successCount: receipts.length, failedCount: 0 };
  const receiptPages = [];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers/s1/vips": { body: { vips: [vip("76561198012345678", "-=KLM=- Gunplay", null, "paid, monthly"), vip("76561198000000002", "Caereca", "2026-12-01T00:00:00.000Z", "event")] } },
    "/api/bans": { body: { bans: [{
      id: "b1", ts: at, by: "owner", playerName: '=HYPERLINK("http://x")', playerId: "76561198000000003", platform: "steam", type: "temp", reason: "teamkilling, twice", category: null,
      scope: { mode: "all" }, game: "hll", expiresAt: "2026-10-27T18:30:00.000Z", liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"],
    }] } },
    "/api/servers/s1/bans/live": { body: { bans: [
      { playerId: "76561198000000006", playerName: "Charlie", ts: at, durationHours: 2, reason: "spam", by: "owner", type: "temp", ranOut: true },
    ] } },
    "/api/payouts": { body: { items: [job] } },
    "/api/payouts/j1": (url) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 500);
      receiptPages.push(offset);
      return { body: { job, items: receipts.slice(offset, offset + limit), itemsTotal: receipts.length } };
    },
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 2, createdByName: "owner", vipPerk: null }] } },
    "/api/player-groups/g1": { body: { members: [
      { groupId: "g1", playerId: "76561198000000004", playerName: "Alpha", addedByName: "owner", addedAt: at, source: "panel" },
      { groupId: "g1", playerId: "76561198000000005", playerName: "Bravo", addedByName: "sync", addedAt: at, source: "discord" },
    ] } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const popup = page.locator(".pa-modal");
    const panel = (title) => page.locator(".panel", { has: page.locator(".panel-title", { hasText: title }) });
    const downloadIn = (title) => panel(title).getByRole("button", { name: "Download", exact: true });
    /** The list's Download, the format picked (or left as offered), and the file it saves. */
    const download = async (opener, format) => {
      await opener.click();
      await popup.waitFor();
      if (format) await popup.locator("select").selectOption(format);
      const [file] = await Promise.all([page.waitForEvent("download"), popup.getByRole("button", { name: "Download", exact: true }).click()]);
      await popup.waitFor({ state: "detached" });
      return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
    };
    const day = String.raw`\d{4}-\d{2}-\d{2}`;

    // The VIP list, searched: the file holds what the search left — in Excel, offered first. A
    // search that leaves nothing leaves nothing to download.
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    await panel("Current VIPs").locator("input.search-input").fill("nobody at all");
    await page.waitForFunction(() => [...window.document.querySelectorAll(".panel button")].some((b) => b.textContent === "Download" && b.disabled));
    await panel("Current VIPs").locator("input.search-input").fill("Gunplay");
    await downloadIn("Current VIPs").click();
    await popup.waitFor();
    assert.equal(await popup.locator("select").inputValue(), "xlsx");
    assert.match(await popup.innerText(), /1 VIP, as the list stands/);
    await popup.getByRole("button", { name: "Cancel" }).click();
    const vips = await download(downloadIn("Current VIPs"));
    assert.match(vips.name, new RegExp(`^vips-test-server-1-${day}\\.xlsx$`));
    const sheet = unzipStored(vips.bytes).get("xl/worksheets/sheet1.xml");
    assert.match(sheet, />76561198012345678</, "the id exact, as text");
    assert.match(sheet, />-=KLM=- Gunplay</);
    assert.match(sheet, />Permanent</);
    assert.doesNotMatch(sheet, /Caereca/, "the search left Caereca out");

    // The ban record, as CSV.
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "networkidle" });
    const bans = await download(downloadIn(/^Bans$/), "csv");
    assert.match(bans.name, new RegExp(`^bans-${day}\\.csv$`));
    const csv = bans.bytes.toString("utf8");
    assert.ok(csv.startsWith("\uFEFFWhen ("), "Excel's UTF-8 mark, then the heading");
    assert.match(csv, /,"'=HYPERLINK\(""http:\/\/x""\)",76561198000000003,temp,/, "the name is never run as a formula");
    assert.match(csv, /,All servers,"teamkilling, twice",/);
    // The game's own list, in the format just used.
    await panel(/^Bans$/).getByRole("button", { name: "Live", exact: true }).click();
    await panel(/^Bans$/).getByText("Charlie").waitFor();
    const live = await download(downloadIn(/^Bans$/));
    assert.match(live.name, new RegExp(`^bans-on-test-server-1-${day}\\.csv$`));
    assert.match(live.bytes.toString("utf8"), /,Charlie,76561198000000006,temp,2,spam,owner,yes,Test Server #1\r\n/);

    // A payout's receipts, as JSON: all 2,001, though the screen reads the first 2,000.
    await page.goto(`${base}#/events/payouts`, { waitUntil: "networkidle" });
    await page.locator("button.quiet", { hasText: "Receipts" }).click();
    const receiptButton = page.getByRole("button", { name: "Download", exact: true });
    await receiptButton.waitFor();
    const opened = receiptPages.length;
    const receiptFile = await download(receiptButton, "json");
    assert.match(receiptFile.name, new RegExp(`^payout-2026-10-20-receipts-${day}\\.json$`));
    const rows = JSON.parse(receiptFile.bytes.toString("utf8"));
    assert.equal(rows.length, 2001);
    assert.deepEqual(rows[2000], { recipient: "Member 2000", discordId: "10002000", result: "paid", detail: "0 → 100" });
    assert.deepEqual(receiptPages.slice(opened), [0, 2000], "read a page at a time");

    // A group's members: the popup offers JSON, picked last time; Excel is picked instead.
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await downloadIn("Player groups").click();
    await popup.waitFor();
    assert.equal(await popup.locator("select").inputValue(), "json", "the last format, remembered");
    assert.match(await popup.innerText(), /2 members, every one in the group/);
    await popup.getByRole("button", { name: "Cancel" }).click();
    const group = await download(downloadIn("Player groups"), "xlsx");
    assert.match(group.name, new RegExp(`^group-ww2-cvc-${day}\\.xlsx$`));
    const parts = unzipStored(group.bytes);
    assert.match(parts.get("xl/workbook.xml"), /<sheet name="WW2 CVC"/);
    assert.match(parts.get("xl/worksheets/sheet1.xml"), />Discord role sync</);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A downloaded list goes back in with Upload: the file is read, every line's outcome is shown, and
 * only the new and longer ones are sent once Apply is pressed. VIP only ever goes up — a permanent
 * stays, a group perk's VIP is not made the player's own — bans already lifted or in force are left
 * alone, and a group gains only who is not in it yet. No Upload for someone who may not do it.
 */
test("a downloaded VIP list, ban list or group roster uploads back after a preview, adding only what is new", { skip: SKIP }, async () => {
  const day = 86_400_000;
  const at = (days) => new Date(Date.now() + days * day).toISOString();
  const vip = (playerId, playerName, expiration) => ({ id: `v-${playerId}`, serverId: "s1", playerId, playerName, comment: "x", expiration, pausedUntil: null, createdByName: "owner", createdAt: at(-30), updatedAt: at(-30) });
  let vipReads = 0;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers/s1/vips": () => { vipReads += 1; return { body: { vips: [vip("1", "Paid", null), vip("2", "Short", at(2))] } }; },
    "/api/servers/s1/vips/bulk": () => ({ body: { applied: [{ playerId: "2", note: "until later" }, { playerId: "3", note: "permanent" }], skipped: [] } }),
    "/api/bans": { body: { bans: [{ id: "b1", ts: at(-1), by: "owner", playerName: "Banned", playerId: "13", platform: "steam", type: "perma", reason: "x", category: null, scope: { mode: "all" }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"] }] } },
    "/api/servers/s1/actions": { body: { results: [{ serverName: "Test Server #1", ok: true }], applied: 1 } },
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "Seeders", description: null, memberCount: 1, createdByName: "owner", vipPerk: null }] } },
    "/api/player-groups/g1": { body: { members: [{ groupId: "g1", playerId: "21", playerName: "Already", addedByName: "owner", addedAt: at(-3), source: "panel" }] } },
    "/api/player-groups/g1/members": { body: { member: {} } },
  } }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    const popup = page.locator(".pa-modal");
    const uploadIn = (title) => page.locator(".panel", { has: page.locator(".panel-title", { hasText: title }) }).getByRole("button", { name: "Upload", exact: true });
    const apply = popup.getByRole("button", { name: /^Apply/ });
    const sent = (path) => stub.calls.filter((c) => c.method === "POST" && c.path === path);

    // VIPs, as CSV: the preview first, the note asked for, then only the new and longer lines.
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    await uploadIn("Current VIPs").click();
    await popup.waitFor();
    const csv = ["Player,Player ID,Status,Expires (UTC),Group perk,Paused until (UTC),Comment",
      `Paid,1,,${at(10).slice(0, 16).replace("T", " ")},,,`,
      `Short,2,,${at(10).slice(0, 16).replace("T", " ")},,,`,
      "New,3,Permanent,,,,paid monthly",
      "Perk,4,Group perk,,Seeders,,",
    ].join("\r\n");
    await popup.locator("input[type=file]").setInputFiles({ name: "vips.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await popup.getByText("1 new · 1 made longer · 1 no change · 1 skipped").waitFor();
    assert.match(await popup.innerText(), /Paid — already permanent/);
    assert.match(await popup.innerText(), /Perk — VIP from a group perk/);
    assert.equal(await apply.isDisabled(), true, "nothing sent before a note");
    assert.match(await popup.innerText(), /Type a note — it goes in each player's VIP history\./);
    await popup.getByPlaceholder("e.g. restored after the wipe").fill("restored after the wipe");
    const readsBefore = vipReads;
    await apply.click();
    await popup.getByText("Done: 2 of 2 applied.").waitFor();
    const bulk = sent("/api/servers/s1/vips/bulk");
    assert.equal(bulk.length, 1);
    assert.equal(bulk[0].body.upload, true);
    assert.equal(bulk[0].body.comment, "restored after the wipe");
    assert.deepEqual(bulk[0].body.players.map((p) => [p.playerId, p.until === null ? "permanent" : "dated", p.comment ?? null]),
      [["2", "dated", null], ["3", "permanent", "paid monthly"]], "only the new and the longer, each with its own end");
    // The list is read again as "Done" is shown, so the read can land a moment after the words do.
    for (let i = 0; i < 50 && vipReads <= readsBefore; i++) await page.waitForTimeout(100);
    assert.ok(vipReads > readsBefore, "the list was read again");
    await popup.getByRole("button", { name: "Close" }).click();

    // Bans, as JSON: lifted and already-banned lines left alone; a reason asked for where the line has none.
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "networkidle" });
    await uploadIn(/^Bans$/).click();
    await popup.waitFor();
    const bans = [
      { playerId: "11", player: "Cheater", type: "perma", until: null, game: "WW2", reason: "aimbot", status: "active" },
      { playerId: "12", player: "Griefer", type: "temp", until: at(3), game: "WW2", reason: "", status: "active" },
      { playerId: "13", player: "Banned", type: "perma", until: null, game: "WW2", reason: "x", status: "active" },
      { playerId: "14", player: "Forgiven", type: "perma", until: null, game: "WW2", reason: "x", status: "lifted" },
    ];
    await popup.locator("input[type=file]").setInputFiles({ name: "bans.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bans)) });
    await popup.getByText("2 new · 1 no change · 1 skipped").waitFor();
    assert.match(await popup.innerText(), /Type a reason for the lines without one/);
    await popup.getByPlaceholder("the player sees it, and it goes on the record").fill("griefing");
    await apply.click();
    await popup.getByText("Done: 2 of 2 applied.").waitFor();
    const placed = sent("/api/servers/s1/actions").map((c) => c.body);
    assert.deepEqual(placed.map((b) => [b.action, b.playerId, b.reason, b.scope?.serverIds]), [
      ["permaban", "11", "aimbot", ["s1"]], ["tempban", "12", "griefing", ["s1"]],
    ]);
    assert.ok(placed[1].hours >= 71 && placed[1].hours <= 72, `three days of temp ban, got ${placed[1].hours}h`);
    await popup.getByRole("button", { name: "Close" }).click();

    // A group's roster, as the Excel file its own Download makes: only the new member is added.
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await uploadIn("Player groups").click();
    await popup.waitFor();
    const roster = toXlsx({ name: "Seeders", columns: [{ key: "player", label: "Player" }, { key: "playerId", label: "Player ID" }], rows: [["Already", "21"], ["Newcomer", "76561198000000022"]] },
      { zone: "UTC", wall: (iso) => iso.slice(0, 16) });
    await popup.locator("input[type=file]").setInputFiles({ name: "seeders.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(roster) });
    await popup.getByText("1 new · 1 no change").waitFor();
    await apply.click();
    await popup.getByText("Done: 1 of 1 applied.").waitFor();
    assert.deepEqual(sent("/api/player-groups/g1/members").map((c) => c.body), [{ playerId: "76561198000000022", playerName: "Newcomer" }]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // Someone who may not grant VIP has nothing to upload it with.
  await withPage({ grants: [{ capability: "vip.revoke", scopeType: "global", scopeId: null, level: "write" }], overrides: {
    "/api/servers/s1/vips": { body: { vips: [] } },
  } }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/players/vips`, { waitUntil: "networkidle" });
    await page.locator(".panel-title", { hasText: "Current VIPs" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Upload", exact: true }).count(), 0);
  });
});

test("phone notifications offer only what a person could see: someone who can only watch the servers gets the server ones", { skip: SKIP }, async () => {
  const grants = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  await withPage({ grants, overrides: { "/api/me/push": { body: { key: PUSH_KEY, devices: [] } } } }, async (page, { stub }) => {
    await page.addInitScript(fakePush);
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").click();
    await page.waitForFunction(() => window.__push.sub !== null);
    await page.getByRole("checkbox", { name: "A server stops answering, and when it's back" }).waitFor({ state: "attached" });
    assert.equal(await page.getByRole("checkbox", { name: "A player on the watchlist joins a server" }).count(), 0, "the watchlist is not theirs to read");
    assert.equal(await page.getByRole("checkbox", { name: "A request needs your approval" }).count(), 0, "there is nothing they could sign");
    assert.equal(await page.getByRole("checkbox", { name: "The automatic rules kick or ban a player" }).count(), 0, "the automation history is not theirs to read");
    for (const [label, why] of [
      ["A staff member bans a player", "the ban record is not theirs to read"], ["A player is banned for good", "nor here"],
      ["A staff member changes a setting", "nor is staff activity"], ["An admin goes into the admin camera", "nor the camera log"],
      ["A member buys something in the shop", "nor members' balances"],
    ]) assert.equal(await page.getByRole("checkbox", { name: label }).count(), 0, why);
    for (const label of ["A player asks for an admin in chat", "A server starts seeding, and when it goes live", "A request you sent is approved or denied", "A notice is posted for staff"]) {
      assert.equal(await page.getByRole("checkbox", { name: label }).count(), 1, `${label}: the servers' chat and seeding are theirs to see, anyone may ask, and the notice board is everyone's`);
    }
  });
});

test("on an iPhone, notifications are offered from the Home Screen, and the panel says how to get there", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 } }, async (page, { stub }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" }));
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("only the panel on your Home Screen can get notifications").waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "On this device" }).count(), 0, "no switch that cannot work here");
  });
});

/*
 * What's new (lib/whatsNew.ts, components/WhatsNew.tsx): after an update, once, in plain words.
 * Closing it is remembered on the account — and on the device, for when that save does not land —
 * and someone new to the panel is not told what is "new" about a panel they have never seen.
 */
test("after an update, what's new shows once, and stays under Help", { skip: SKIP }, async () => {
  const me = (prefs) => ({ body: { user: { id: "u1", username: "tester", displayName: "tester", createdAt: "2026-01-02T03:04:05.000Z" }, grants: OWNER_GRANTS, limits: {}, roles: [], prefs } });
  let prefs = {};
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": () => me(prefs) } }, async (page, { stub, errors }) => {
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.waitFor();
    await popup.getByText("Notifications on your phone").waitFor();
    await popup.getByText("Besides the first three, Settings now offers many more to pick from.", { exact: false }).waitFor();
    // Every build, each under its number and day.
    const builds = async () => (await popup.locator(".whats-new-day").allTextContents()).map((s) => s.replace(/ · .*/, ""));
    assert.deepEqual(await builds(), ["Build 53", "Build 52", "Build 51", "Build 50", "Build 49", "Build 46", "Build 42", "Build 38", "Build 37", "Build 36", "Build 35", "Build 34", "Build 33", "Build 32", "Build 31", "Build 28", "Build 27", "Build 26", "Build 25", "Build 24", "Build 23", "Build 22", "Build 21", "Build 16", "Build 15", "Build 4", "Build 3", "Build 2", "Build 1"]);
    await popup.getByRole("button", { name: "Got it" }).click();
    await popup.waitFor({ state: "detached" });
    const seen = stub.calls.filter((c) => c.path === "/api/me/prefs" && c.body?.whatsNewSeen).at(-1)?.body.whatsNewSeen;
    assert.equal(seen, 53, "marked seen on the account: the newest build");

    const reload = async (account, keepDevice) => {
      prefs = account;
      if (!keepDevice) await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("panel.whatsNewSeen.")) localStorage.removeItem(k); });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      return popup.count();
    };
    assert.equal(await reload({}, true), 0, "the account's save never landed: this device still knows");
    assert.equal(await reload({ whatsNewSeen: seen }, false), 0, "another device: the account knows");
    // Closed back when What's new went by date, on the day of build 1: build 2, same day, is still
    // new, and so is every build after it.
    assert.equal(await reload({ whatsNewSeen: "2026-10-23" }, false), 1, "a build added the same day still shows");
    await popup.getByText("More phone notifications").waitFor();
    assert.equal(await popup.getByText("Stay signed in").count(), 0, "only what came after build 1");
    assert.deepEqual(await builds(), ["Build 53", "Build 52", "Build 51", "Build 50", "Build 49", "Build 46", "Build 42", "Build 38", "Build 37", "Build 36", "Build 35", "Build 34", "Build 33", "Build 32", "Build 31", "Build 28", "Build 27", "Build 26", "Build 25", "Build 24", "Build 23", "Build 22", "Build 21", "Build 16", "Build 15", "Build 4", "Build 3", "Build 2"]);
    // Closed at build 2: the builds since, each under its heading.
    assert.equal(await reload({ whatsNewSeen: 2 }, false), 1, "the builds after the one closed");
    await popup.getByText("Admin camera on the public stats site").waitFor();
    assert.equal(await popup.getByText("More phone notifications").count(), 0, "nothing from build 2 again");
    assert.deepEqual(await builds(), ["Build 53", "Build 52", "Build 51", "Build 50", "Build 49", "Build 46", "Build 42", "Build 38", "Build 37", "Build 36", "Build 35", "Build 34", "Build 33", "Build 32", "Build 31", "Build 28", "Build 27", "Build 26", "Build 25", "Build 24", "Build 23", "Build 22", "Build 21", "Build 16", "Build 15", "Build 4", "Build 3"]);
    // Closed at build 52: the one build since, which needs no heading.
    assert.equal(await reload({ whatsNewSeen: 52 }, false), 1, "the build after the one closed");
    await popup.getByText("See exactly what a staff action changed", { exact: true }).waitFor();
    assert.equal(await popup.getByText("VIP purchases show their dates", { exact: true }).count(), 0, "nothing from build 52 again");
    assert.equal(await popup.locator(".whats-new-day").count(), 0, "one build: no headings needed");
    assert.equal(await reload({}, false), 1, "neither knows: it is new to them");

    // "Show me" goes to the screen, and that counts as seen.
    await popup.locator(".whats-new li", { hasText: "Notifications on your phone" }).getByRole("button", { name: "Show me" }).click();
    await popup.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.location.hash.startsWith("#/settings"));

    // Always under Help, where an item about Search opens Search.
    await page.goto(`${stub.base}/#/help/whats-new`, { waitUntil: "networkidle" });
    await page.locator(".whats-new li", { hasText: "Upload a list again" }).waitFor();
    await page.locator(".whats-new li", { hasText: "Go back to what you opened" }).getByRole("button", { name: "Show me" }).click();
    await page.getByPlaceholder(/^Search views/).waitFor();
    assert.deepEqual(errors, []);
  });
});

test("someone new to the panel is not shown what's new", { skip: SKIP }, async () => {
  const me = { body: { user: { id: "u3", username: "new", displayName: "new", createdAt: new Date().toISOString() }, grants: OWNER_GRANTS, limits: {}, roles: [], prefs: {} } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": me } }, async (page) => {
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("dialog", { name: "What's new" }).count(), 0);
  });
});

/*
 * What's new can be switched off, in Settings or in Getting started. After an update it then does
 * not open: what changed is marked seen, as if closed, and stays under Help — until it is switched
 * on again.
 */
test("What's new switched off does not open after an update, and Settings switches it on again", { skip: SKIP }, async () => {
  const newest = WHATS_NEW[0].build;
  const me = (prefs) => ({ body: { user: { id: "u4", username: "quiet", displayName: "quiet", createdAt: "2026-01-02T03:04:05.000Z" }, grants: OWNER_GRANTS, limits: {}, roles: [], prefs } });
  let prefs = { whatsNewSeen: newest - 2, whatsNew: false };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": () => me(prefs) } }, async (page, { stub, errors }) => {
    const popup = page.getByRole("dialog", { name: "What's new" });
    await page.waitForTimeout(500);
    assert.equal(await popup.count(), 0, "switched off: it does not open");
    const marked = stub.calls.filter((c) => c.path === "/api/me/prefs" && c.body?.whatsNewSeen).at(-1)?.body.whatsNewSeen;
    assert.equal(marked, newest, "what changed is marked seen, as if closed");

    // Settings shows it off, and switches it on again — on the account, so for every device.
    await page.goto(`${stub.base}/#/settings`, { waitUntil: "networkidle" });
    const card = page.locator(".setting-card", { has: page.locator(".setting-title", { hasText: "What's new after an update" }) });
    // Settings draws its defaults first and the saved choice a moment later: wait for the saved one.
    await card.getByText("Off: read it in Help", { exact: false }).waitFor();
    assert.equal(await card.locator("label.toggle input").isChecked(), false);
    await card.locator("label.toggle").click();
    await card.getByText("On: it opens once", { exact: false }).waitFor();
    assert.equal(await card.locator("label.toggle input").isChecked(), true);
    assert.equal(stub.calls.filter((c) => c.path === "/api/me/prefs" && c.body?.whatsNew === true).length, 1, "saved on the account");

    // On again: an update it has not seen opens it.
    prefs = { whatsNewSeen: newest - 1, whatsNew: true };
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("panel.whatsNewSeen.")) localStorage.removeItem(k); });
    await page.reload({ waitUntil: "networkidle" });
    await popup.locator(".whats-new-title", { hasText: WHATS_NEW[0].items[0].title }).waitFor();
    assert.deepEqual(errors, []);
  });
});

test("What's new switched off in Getting started does not open when the setup is done", { skip: SKIP }, async () => {
  const grants = [held("server.view", "read")];
  const me = { body: { user: { id: "u6", username: "settled", displayName: "Settled", createdAt: "2026-01-02T03:04:05.000Z" }, grants, limits: {}, roles: [], prefs: { setupSeen: 0, whatsNewSeen: 20 } } };
  await withPage({ grants, overrides: { "/api/me": me } }, async (page, { stub, errors }) => {
    const setup = page.getByRole("dialog", { name: "Getting started" });
    await setup.waitFor();
    for (let i = 0; i < 4; i++) await setup.getByRole("button", { name: /^(Let's start|Next)$/ }).click();
    await setup.getByText("Where it opens").waitFor();
    const choice = setup.locator(".setup-choice", { hasText: "What's new after an update" });
    assert.equal(await choice.locator("label.toggle input").isChecked(), true, "on until it is switched off");
    await choice.locator("label.toggle").click();
    await setup.getByRole("button", { name: "Skip setup" }).click();
    await setup.waitFor({ state: "detached" });
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole("dialog", { name: "What's new" }).count(), 0, "switched off on the way: it does not open after");
    const saved = Object.assign({}, ...stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/me/prefs").map((c) => c.body));
    assert.equal(saved.whatsNew, false, "the choice reached the account");
    assert.equal(saved.whatsNewSeen, WHATS_NEW[0].build, "and what it held is marked seen");
    assert.deepEqual(errors, []);
  });
});

/*
 * New walkthroughs (lib/walkNotice): permissions that open walkthroughs someone could not follow
 * before are told about once — which, each playable from the notice — judged against what the
 * account kept from the last check. The first check of all is a starting point and says nothing,
 * and one found while the panel is in use waits for the next screen the person opens.
 */
const KICKER = [held("server.view", "read"), held("action.kick")];
const lockedFor = (grants) => lockedNow(WALKTHROUGHS.map((w) => w.id), walkthroughsFor(grants).map((w) => w.id));
const meWith = (grants, prefs) => ({ body: { user: { id: "u1", username: "tester", displayName: "tester" }, grants: grants(), limits: {}, roles: [], prefs: prefs() } });
const walksSaved = (stub) => stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/me/prefs" && c.body?.walkthroughs).map((c) => c.body.walkthroughs);

test("permissions that open new walkthroughs are told about once, at sign-in", { skip: SKIP }, async () => {
  const now = [...KICKER, held("action.punish")];
  const before = { for: "an earlier check", locked: lockedFor(KICKER) };
  let prefs = { walkthroughs: before };
  await withPage({ grants: now, overrides: { "/api/me": () => meWith(() => now, () => prefs) } }, async (page, { stub, errors }) => {
    const notice = page.getByRole("dialog", { name: "New walkthroughs for you" });
    await notice.waitFor();
    assert.deepEqual(await notice.locator(".walk-card-title").allTextContents(), ["Punish a player"]);
    // Each plays from the notice, which comes back after it.
    await notice.locator(".walk-card", { hasText: "Punish a player" }).click();
    await page.getByRole("dialog", { name: "Punish a player" }).waitFor();
    await page.keyboard.press("Escape");
    await notice.getByRole("button", { name: "Got it" }).click();
    await notice.waitFor({ state: "detached" });
    const saved = walksSaved(stub).at(-1);
    assert.ok(saved && !saved.locked.includes("punish-player") && saved.locked.includes("perma-ban"), `kept on the account: ${JSON.stringify(saved)}`);
    assert.equal(saved.for, walkCheckKey(now, WHATS_NEW[0].build));
    // Said once: signing in again with what the account kept says nothing.
    prefs = { walkthroughs: saved };
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    assert.equal(await notice.count(), 0);
    assert.deepEqual(errors, []);
  });
});

test("the first walkthrough check of all is a starting point, kept quietly", { skip: SKIP }, async () => {
  await withPage({ grants: KICKER, overrides: { "/api/me": () => meWith(() => KICKER, () => ({})) } }, async (page, { stub, errors }) => {
    for (let i = 0; i < 50 && !walksSaved(stub).length; i++) await page.waitForTimeout(100);
    assert.deepEqual(walksSaved(stub), [{ for: walkCheckKey(KICKER, WHATS_NEW[0].build), locked: lockedFor(KICKER) }]);
    assert.equal(await page.getByRole("dialog", { name: "New walkthroughs for you" }).count(), 0, "nothing to tell");
    assert.deepEqual(errors, []);
  });
});

test("walkthroughs opened while the panel is in use are told about at the next screen opened", { skip: SKIP }, async () => {
  let grants = KICKER;
  const prefs = { walkthroughs: { for: walkCheckKey(KICKER, WHATS_NEW[0].build), locked: lockedFor(KICKER) } };
  await withPage({ grants: KICKER, overrides: { "/api/me": () => meWith(() => grants, () => prefs) } }, async (page, { stub, errors }) => {
    const notice = page.getByRole("dialog", { name: "New walkthroughs for you" });
    await page.waitForTimeout(500);
    assert.equal(await notice.count(), 0, "nothing new at sign-in");
    // Given punishing while the panel is open: the next look at /api/me brings it.
    grants = [...KICKER, held("action.punish")];
    const asked = stub.calls.filter((c) => c.path === "/api/me").length;
    await page.evaluate(() => window.document.dispatchEvent(new Event("visibilitychange")));
    for (let i = 0; i < 50 && stub.calls.filter((c) => c.path === "/api/me").length === asked; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(1500);
    assert.equal(await notice.count(), 0, "not over what they are in the middle of");
    await page.locator('.sidebar [data-route="help"]').click();
    await notice.waitFor();
    assert.deepEqual(await notice.locator(".walk-card-title").allTextContents(), ["Punish a player"]);
    assert.deepEqual(errors, []);
  });
});

/*
 * Every dialog and menu a button opens has walkthrough steps for what is in it — for someone holding
 * every permission. Each control is ringed by a step, or of a kind explained once for every screen,
 * or, a setting, named by a step about that dialog or the button that opens it. In a dialog a step
 * leads into, the buttons at its foot (Save, Delete, Apply) are what that step goes on to press. The
 * same for the menus a player's actions are in and each dialog their items open — under each of a
 * dialog's tabs and choices. What is not covered yet is listed in KNOWN_GAPS (test/coverage-kit).
 */
test("every dialog and menu a button opens has walkthrough steps for what is in it", { skip: SKIP }, async () => {
  const grants = CAPABILITY_CATALOG.map((c) => held(c.key, "write"));
  const missing = [];
  let empty = [];
  await withPage({ grants, overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
    let visit = 0;
    const open = async (path, setup) => {
      await page.goto(`${stub.base}/?cover=${++visit}#${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(250);
      await unfold(page);
      if (setup) {
        // Live's roster on its scoreboard, as a table: where the rows and their ⋯ are.
        const roster = page.locator(".panel", { hasText: "Roster" });
        await roster.getByRole("button", { name: "Scoreboard", exact: true }).click();
        await roster.locator(".seg-btn", { hasText: "Table" }).first().click();
        if (setup === "ticked") await page.locator(".scoreboard tbody tr input[type=checkbox]").first().check();
      }
    };
    // Each gap once for each dialog, whichever of its choices it was found under.
    const look = async (place, steps, opts, said = new Set()) => {
      for (const what of await uncovered(page, "dialog", coverageOf(steps), opts)) {
        if (!said.has(what)) missing.push(`${place}: ${what}`);
        said.add(what);
      }
    };
    // A dialog, then under each of its choices in turn — and the choices those bring out.
    const lookThrough = async (place, steps, opts) => {
      const said = new Set();
      await look(place, steps, opts, said);
      const seen = new Set(await dialogChoices(page));
      const queue = [...seen];
      while (queue.length) {
        if (!(await pressChoice(page, queue.shift()))) continue;
        await page.waitForTimeout(200);
        await look(place, steps, opts, said);
        for (const c of await dialogChoices(page)) if (!seen.has(c)) { seen.add(c); queue.push(c); }
      }
    };
    for (const [path, routes, opener] of DIALOGS) {
      const steps = stepsOn(routes);
      await open(path);
      // A row's ✕ and Download are explained once for every screen ("Use a screen's panels and
      // lists"), and so are the question ✕ asks before it removes the row and the choices Download
      // offers, wherever they are.
      const download = /^Download\b/.test(opener.button ?? "");
      const reached = download || /^[✕×]$/.test(opener.button ?? "") || await ringed(page, steps, opener);
      assert.ok(await press(page, opener), `${path}: nothing to press for ${JSON.stringify(opener)}`);
      await page.waitForTimeout(300);
      // One that opens nothing would be looked through as nothing, and pass whatever it shows.
      assert.ok(await overlayOpen(page), `${path}: ${JSON.stringify(opener)} opens no dialog or menu`);
      await lookThrough(`${path} › ${opener.button ?? opener.css}`, steps, { dialogNamed: download ? namedForDownload() : namedForDialog(steps, opener), reached });
      await page.keyboard.press("Escape");
    }
    for (const [path, routes, opener, setup] of MENUS) {
      const steps = stepsOn(routes);
      await open(path, setup);
      assert.ok(await press(page, opener), `${path}: nothing to press for ${JSON.stringify(opener)}`);
      await page.waitForTimeout(250);
      const items = await menuItems(page);
      assert.ok(items.length > 0, `${path}: the menu has items`);
      await look(`${path} › ${opener.button ?? "⋯"}`, steps, { reached: true });
      for (const item of items) {
        await open(path, setup);
        await press(page, opener);
        await page.waitForTimeout(250);
        const reached = await ringed(page, steps, { button: item });
        await pressItem(page, item);
        await page.waitForTimeout(300);
        if (!(await dialogOpen(page))) continue;
        await lookThrough(`${path} › ${item}`, steps, { dialogNamed: namedForDialog(steps, { button: item }), reached });
      }
    }
    assert.deepEqual(errors, []);
    empty = unansweredReads(stub);
  });
  recordGaps("dialogs", missing);
  assert.deepEqual(empty, [], "reads the walkthrough stage answered with nothing: give each its data in WALK_FIXTURES (test/walk-stage)");
  assert.deepEqual(missing, KNOWN_GAPS.dialogs, "dialog controls no walkthrough step rings, and settings none names");
});

/*
 * Every setting a choice brings out is explained by a walkthrough step: what an editor opened in the
 * page holds (a player trigger's, a new rule's, a profile's) under each kind it can be, a duration
 * or a date to give, each action a group can take, a payout split by role, the quick bar with room
 * for one more button; and every switch, every set of choices and every option of every list on
 * every screen, whose settings are left out until it is made — and, behind each, what it brought
 * out, made in its turn. Only what a choice brings out counts here — the screen around it is the
 * screens test's. A screen that crashes into its "could not be shown" card fails the test outright,
 * rather than listing its Reload as something to explain. What is not covered yet is listed in
 * KNOWN_GAPS (test/coverage-kit).
 */
test("every setting a choice brings out has a walkthrough step that explains it", { skip: SKIP }, async () => {
  const grants = CAPABILITY_CATALOG.map((c) => held(c.key, "write"));
  const missing = [];
  const crashed = [];
  let empty = [];
  await withPage({ grants, overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
    let visit = 0;
    const open = async (path) => {
      await page.goto(`${stub.base}/?cover=${++visit}#${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(250);
      await unfold(page);
    };
    // What each screen's choices bring out is said once, whichever choice brought it out; what the
    // screen shows as it opens is the screens test's.
    const told = new Map();
    const saidOn = async (path, cover) => {
      const said = told.get(path) ?? new Set();
      told.set(path, said);
      for (const what of await uncovered(page, "main", cover)) said.add(what);
      return said;
    };
    const note = async (where, cover, said) => {
      for (const what of await uncovered(page, "main", cover)) {
        if (!said.has(what)) missing.push(`${where}: ${what}`);
        said.add(what);
      }
    };
    // The choices to make on the screen as it stands: each switch and each button of a set of
    // choices, by its words, and each option of each list.
    const choices = async () => {
      const out = [];
      const times = new Map();
      const nthOf = (id) => { const n = times.get(id) ?? 0; times.set(id, n + 1); return n; };
      for (const words of await screenChoices(page)) {
        const nth = nthOf(`press ${words}`);
        out.push({ id: `press ${words} ${nth}`, said: words, make: () => pressScreenChoice(page, words, nth) });
      }
      for (const { name, options } of await screenLists(page)) {
        const nth = nthOf(`list ${name}`);
        for (const o of options) out.push({ id: `list ${name} ${nth} ${o}`, said: o, make: () => pickScreenOption(page, name, nth, o) });
      }
      return out;
    };
    class Crashed extends Error {}
    // Each choice not made before, made in turn and put back as it was; with `further`, what each
    // brought out is made the same way in its turn, one step further.
    const explore = async (path, cover, said, place, known, further) => {
      const here = (await choices()).filter((c) => !known.has(c.id));
      const seen = new Set([...known, ...here.map((c) => c.id)]);
      for (const c of here) {
        const undo = await c.make();
        if (!undo) continue;
        await page.waitForTimeout(150);
        const at = `${place}${c.said}`;
        // A choice that asks first: what it asks is explained too, all but its foot, which is what
        // the step explaining the choice goes on to press.
        if (await dialogOpen(page)) {
          for (const what of await uncovered(page, "dialog", cover, { reached: true })) {
            if (!said.has(what)) missing.push(`${at}: ${what}`);
            said.add(what);
          }
          await page.keyboard.press("Escape");
          await page.waitForTimeout(150);
        }
        if (await screenCrashed(page)) {
          crashed.push(at);
          throw new Crashed();
        }
        await note(at, cover, said);
        if (further) await explore(path, cover, said, `${at} › `, seen, false);
        await undo();
        await page.waitForTimeout(100);
      }
    };
    const look = async (path, cover, said, place, known) => {
      try { await explore(path, cover, said, place, known, true); } catch (e) { if (!(e instanceof Crashed)) throw e; }
    };
    for (const [path, routes, first] of REVEALS) {
      const cover = coverageOf(stepsOn(routes));
      await open(path);
      const said = await saidOn(path, cover);
      const place = `${path} › ${first.map((a) => a.click?.button ?? a.click?.field ?? a.click?.css ?? a.value).join(" › ")}`;
      const before = new Set((await choices()).map((c) => c.id));
      for (const a of first) assert.ok(await act(page, a), `${path}: nothing to do for ${JSON.stringify(a)}`);
      if (await screenCrashed(page)) { crashed.push(place); continue; }
      await note(place, cover, said);
      await look(path, cover, said, `${place} › `, before);
    }
    // Every screen's own. Live's are the screens test's, which looks at it as it can be left;
    // Help's lists are Help.
    const hubs = new Set(ROUTES.filter((r) => r.parent).map((r) => r.parent));
    const screens = [...ROUTES.filter((r) => !hubs.has(r.id) && !r.ownerOnly && r.id !== "live" && !r.id.startsWith("help.")).map((r) => [r.path, [r.id]]), ...SUBJECT_PAGES];
    for (const [path, routes] of screens) {
      const cover = coverageOf(stepsOn(routes));
      await open(path);
      const said = await saidOn(path, cover);
      await look(path, cover, said, `${path} › `, new Set());
    }
    assert.deepEqual(errors, []);
    empty = unansweredReads(stub);
  });
  assert.deepEqual(crashed, [], "screens that crashed into their \"could not be shown\" card");
  recordGaps("choices", missing);
  assert.deepEqual(empty, [], "reads the walkthrough stage answered with nothing: give each its data in WALK_FIXTURES (test/walk-stage)");
  assert.deepEqual(missing, KNOWN_GAPS.choices, "settings a choice brings out that no walkthrough step rings or names");
});
