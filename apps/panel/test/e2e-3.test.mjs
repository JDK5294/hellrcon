// Browser smoke tests for the panel: the REAL built bundle (out/) served over a stubbed API,
// driven by Chromium. Self-skipping where the environment can't run them:
//   - needs a Chromium binary (CHROMIUM env var, or the standard Playwright cache path)
//   - needs the panel built (pnpm --filter @app/panel build)
// so `pnpm -w test` stays green on machines without a browser while CI/dev boxes with one get
// real coverage.
//
// Part 3 of 3: the tests are spread over several files so they run side by side; the
// shared harness and helpers live in ./e2e-kit.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_GRANTS, HLL_DESCRIPTOR, startStub } from "./stub-api.mjs";
import { PHONE_SCREEN, WALK_FIXTURES, setStage, stageStep, walkGrants } from "./walk-stage.mjs";
import { WALKTHROUGHS } from "../lib/walkthroughs.ts";
import { ROUTES, canOpenRoute, routeById } from "../lib/routes.ts";
import { WHATS_NEW } from "../lib/whatsNew.ts";
import { CAPABILITY_CATALOG } from "../../../packages/access/src/capabilities.ts";
import { ALL_STEPS, SUBJECT_PAGES, KNOWN_GAPS, coverageOf, recordGaps, stepsOn, uncovered, unansweredReads, unfold } from "./coverage-kit.mjs";
import { SKIP, withPage, openLibrary, mapvoteFixture, voteButtons, MODE_CFG, SCORE_ROWS, inFront, TWO_OF_ONE_GAME, seedingReply, held, panelTitled, ACTIVE_S1, TWO_SERVERS, TK_ROSTER, touchDrag, PHONE, overflowingElements, WIDE_ROWS, clippedPanelTitles, rightEdge, SCORE_FIELDS, APIS_SERVER, APIS_OVERRIDES, dataPath, SLOW_WRITE_MS, writesTo, STALE_MS, DEMO_PAGE, DEMO_OVERRIDES, PUSH_KEY, fakePush } from "./e2e-kit.mjs";

test("destructive actions ask first and report the result", { skip: SKIP }, async () => {
  const calls = [];
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      // roster with one player so the row actions render
      "/api/servers/s1/live": { body: { players: [{ id: "p1", playerId: "76561198000000001", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 }, scoreData: { combat: 1, offense: 0, defense: 0, support: 0 } }], session: { playerCount: 1, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 0, remainingMatchTime: 100, matchTime: 10 } } },
    },
  }, async (page) => {
    page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/actions")) calls.push(r.url()); });
    // window.confirm must never be used by the panel any more — fail loudly if it is.
    await page.addInitScript(() => { window.confirm = () => { throw new Error("native confirm used"); }; });
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 10000 });

    // open the overflow menu and choose an action that needs no typing
    await page.locator(".player-actions .pa-menu button").first().click();
    const item = page.locator(".pa-mi", { hasText: "Switch team" }).first();
    await item.click();

    // it must ASK, not act
    await page.waitForSelector(".confirm-modal");
    assert.equal(calls.length, 0, "nothing fired before confirming");
    assert.match((await page.locator(".confirm-modal").textContent()) ?? "", /TestGuy/);

    // cancelling leaves the player alone
    await page.locator(".confirm-modal .ghost").click();
    await page.waitForSelector(".confirm-modal", { state: "detached" });
    assert.equal(calls.length, 0, "cancel does nothing");
  });
});

/*
 * Escape closes a dialog, and a screen reader is told it is one.
 *
 * Six modals were written by hand and none of them handled Escape — the one key everybody presses
 * to get out of a dialog did nothing, on the screens that ban and kick people. They also announced
 * themselves as an unlabelled div. Both now come from the shared `Modal`, so this checks the shared
 * behaviour through the most destructive path that reaches it.
 */
test("a modal closes on Escape and names itself to assistive tech", { skip: SKIP }, async () => {
  const calls = [];
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/live": { body: { players: [{ id: "p1", playerId: "76561198000000001", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 }, scoreData: { combat: 1, offense: 0, defense: 0, support: 0 } }], session: { playerCount: 1, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 0, remainingMatchTime: 100, matchTime: 10 } } },
    },
  }, async (page) => {
    page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/actions")) calls.push(r.url()); });
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 10000 });
    await page.locator(".player-actions .pa-menu button").first().click();
    await page.locator(".pa-mi", { hasText: "Switch team" }).first().click();
    await page.waitForSelector(".confirm-modal");

    // It is a dialog, and its accessible name is the heading — not "div".
    const dialog = page.locator(".pa-modal[role=dialog]").first();
    assert.equal(await dialog.count(), 1, "the modal declares role=dialog");
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    const labelledBy = await dialog.getAttribute("aria-labelledby");
    assert.ok(labelledBy, "the dialog points at its own heading for a name");
    assert.ok(((await page.locator(`#${labelledBy}`).textContent()) ?? "").trim().length > 0, "and that heading has text");

    // Escape dismisses it, and dismissing is not acting.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".confirm-modal", { state: "detached" });
    assert.deepEqual(calls, [], "escaping a confirmation does not perform the action");
  });
});

test("punitive actions refuse to submit without a reason", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/live": { body: { players: [{ id: "p1", playerId: "76561198000000001", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 }, scoreData: { combat: 1, offense: 0, defense: 0, support: 0 } }], session: { playerCount: 1, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 0, remainingMatchTime: 100, matchTime: 10 } } },
    },
  }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 10000 });
    await page.locator(".player-actions .pa-menu button").first().click();
    await page.locator(".pa-mi", { hasText: "Kick" }).first().click();
    await page.waitForSelector(".pa-modal");

    const submit = page.locator(".pa-modal .pa-actions button").last();
    assert.equal(await submit.isDisabled(), true, "blocked with an empty reason");
    assert.match((await page.locator(".pa-modal .hint").last().textContent()) ?? "", /reason/i);

    await page.locator(".pa-modal input").first().fill("griefing");
    assert.equal(await submit.isDisabled(), false, "enabled once a reason is typed");
  });
});

test("a deep link opens the exact screen it names, and the URL follows you", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    // 1. Landing on the app gives you a real address, not a blank one.
    await page.waitForFunction(() => window.location.hash.startsWith("#/"));
    assert.match(await page.evaluate(() => window.location.hash), /^#\/dashboard/);

    // 2. A pasted deep link opens that tab directly — the whole point of routing the tabs.
    await page.goto(`${page.url().split("#")[0]}#/players/vips`, { waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar-tab.active");
    assert.equal(await page.locator(".tabbar-tab.active").innerText(), "VIPs");
    // The breadcrumb says where you are, derived from the route rather than typed per page.
    const crumbs = await page.locator(".crumbs").innerText();
    assert.ok(crumbs.includes("Players") && crumbs.includes("VIPs"), `breadcrumb names the location, got: ${crumbs}`);

    // 3. Clicking a tab writes the URL, so it can be copied and shared.
    await page.locator(".tabbar-tab", { hasText: "Leaderboard" }).click();
    await page.waitForFunction(() => window.location.hash === "#/players/leaderboard");

    // 4. Back returns to the previous tab instead of leaving the app.
    await page.goBack();
    await page.waitForFunction(() => window.location.hash === "#/players/vips");
    assert.equal(await page.locator(".tabbar-tab.active").innerText(), "VIPs");

    // 5. A refresh keeps you where you were.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar-tab.active");
    assert.equal(await page.locator(".tabbar-tab.active").innerText(), "VIPs");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("search finds a screen by what it does, not just by its name", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".cmdk input");
    // "welcome message" is nowhere in a nav label — it lives in a tab's description. Before the
    // registry, this search returned nothing and you had to know it was under Config.
    await page.locator(".cmdk input").fill("welcome message");
    await page.waitForTimeout(150);
    const first = await page.locator(".cmdk-item").first().innerText();
    assert.ok(/Live settings/i.test(first), `expected the Live settings tab, got: ${first}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.location.hash === "#/admin/live");
  });
});

/*
 * Search ranks three kinds of match, each below the one before: the screens whose name or
 * description holds what was typed, then the walkthroughs Help's own search found, then screens
 * that only have its letters in order. "roster" is far into Live's description, which scored it
 * under forty of those letter matches — and the walkthroughs, ranked under Live, off the list.
 */
test("search ranks the screens holding the words, then walkthroughs, then letter matches", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.keyboard.press("Control+k");
    await page.locator(".cmdk input").fill("roster");
    await page.locator(".cmdk-group-label", { hasText: /^Walkthroughs$/ }).waitFor({ timeout: 10_000 });
    // Ranked as ↑ and ↓ move through them (data-i): rows of one group are listed together.
    const rows = await page.locator(".cmdk-item").evaluateAll((els) => els.map((e) => ({
      i: Number(e.getAttribute("data-i")),
      title: e.querySelector(".cmdk-title")?.textContent ?? "",
      group: e.closest(".cmdk-group")?.querySelector(".cmdk-group-label")?.textContent ?? "",
    })));
    const rank = (title) => rows.find((r) => r.title === title && r.group !== "Walkthroughs")?.i ?? -1;
    const walks = rows.filter((r) => r.group === "Walkthroughs").map((r) => r.i);
    assert.equal(walks.length, 5, "every walkthrough Help's search found for it");
    assert.ok(rank("Live") !== -1 && rank("Live") < Math.min(...walks), `Live, whose search word it is, ranks above them: ${JSON.stringify(rows.slice(0, 12))}`);
    assert.ok(rank("Dashboard") > Math.max(...walks), "a screen with only the letters in order ranks below them");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Search opens on what you opened lately. Recent activity — the dashboard's card — now holds every
 * profile opened, however it was reached, and every screen, and Search lists it before anything is
 * typed, leaving out the screen already open. A screen comes back on its own tab.
 */
test("search lists recent players and screens before anything is typed, as the dashboard card does", { skip: SKIP }, async () => {
  const guy = { id: "76561100000000001", platformId: "76561100000000001", platform: "steam", name: "Clickable Guy", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/leaderboard": { body: { leaderboard: [{ playerId: guy.id, name: guy.name, kills: 10, deaths: 2, kd: 5, teamkills: 0 }] } },
      [`/api/players/${guy.id}`]: { body: { player: guy, stats: { kills: 10, deaths: 2, teamkills: 0, playtimeSec: 60, visits: 1 }, flags: {}, recentEvents: [], sessions: [], aliases: [], matches: [] } },
      "/api/layout/dashboard": { body: { source: "default", widgets: [{ id: "dash-recent", title: "Recent activity", visible: true, order: 10, required: false, size: { w: 2, h: 2 } }] } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "networkidle" });
    // A name tapped anywhere, not only in the directory, is recent activity.
    await page.goto(`${base}#/players/leaderboard`, { waitUntil: "networkidle" });
    await page.locator(".player-link", { hasText: "Clickable Guy" }).click();
    await page.waitForSelector("h1:has-text('Clickable Guy')");
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });

    const recent = page.locator(".cmdk-group", { has: page.locator(".cmdk-group-label", { hasText: /^Recent$/ }) }).locator(".cmdk-item");
    await page.keyboard.press("Control+k");
    await page.locator(".cmdk input").waitFor();
    assert.equal(await page.locator(".cmdk-group-label").first().textContent(), "Recent", "first, before anything is typed");
    assert.deepEqual(await recent.locator(".cmdk-title").allTextContents(), ["Clickable Guy", "Players › Leaderboard", "Moderation › Bans"], "newest first, without the screen open now");
    await recent.filter({ hasText: "Moderation › Bans" }).click();
    await page.waitForFunction(() => window.location.hash === "#/moderation/bans");

    await page.keyboard.press("Control+k");
    await recent.filter({ hasText: "Clickable Guy" }).click();
    await page.waitForFunction((id) => window.location.hash.includes(id), guy.id);

    // The dashboard's card lists the same, and takes a screen back to its own tab.
    await page.goto(`${base}#/dashboard`, { waitUntil: "networkidle" });
    // Its name, not the middle of the row: a tap on the time in it shows the exact time instead.
    await page.locator(".recent-row", { hasText: "Maps › Rotation" }).locator(".recent-label").click();
    await page.waitForFunction(() => window.location.hash === "#/maps/rotation");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Search opens on what you opened lately, and nothing else. Every screen was listed under it, each
 * with a sentence beside its name, and on a phone the sentence left the name a letter wide, one
 * letter to a line. Typing still finds any screen, and its name keeps to one line.
 */
test("Search opens on Recent alone, and a screen found by typing keeps its name whole on a phone", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const search = page.locator(".quick-btn", { hasText: "Search" });
    const labels = () => page.locator(".cmdk-group-label").allTextContents();

    // Nothing opened yet: it says what to do, not "No matches".
    await search.tap();
    await page.locator(".cmdk-empty").waitFor();
    assert.equal(await page.locator(".cmdk-empty").innerText(), "Type to find a screen, a player, a server or a walkthrough.");
    assert.deepEqual(await labels(), [], "no list of every screen");
    await page.keyboard.press("Escape");

    // Each screen drawn before the next is opened: two quick jumps can be drawn as one.
    const current = page.locator('.quick-btn[aria-current="page"]');
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "networkidle" });
    await current.filter({ hasText: "Bans" }).waitFor();
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    await current.waitFor({ state: "detached" });
    await search.tap();
    await page.locator(".cmdk-item").first().waitFor();
    assert.deepEqual(await labels(), ["Recent"], "only what was opened lately");
    assert.deepEqual(await page.locator(".cmdk-title").allTextContents(), ["Moderation › Bans"]);

    // Typed: the screen is found, with its description, and its name on one line.
    await page.locator(".cmdk input").fill("dashboard");
    const row = page.locator(".cmdk-item", { has: page.locator(".cmdk-title", { hasText: /^Dashboard$/ }) });
    await row.waitFor();
    assert.match(await row.locator(".cmdk-hint").innerText(), /at-a-glance overview/);
    const lines = await row.locator(".cmdk-title").evaluate((el) => {
      const range = window.document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
    assert.equal(lines, 1, "the name keeps to one line beside its description");
    assert.equal((await labels())[0], "Screens", "listed under Screens");
    assert.ok(!(await labels()).includes("Go to"), "there is no Go to section");
    assert.deepEqual(errors, []);
  });

  // On a computer, letters typed straight after Ctrl K land in the box, even on the first open of
  // the page: an empty box now lists only what was opened lately, so a lost letter is a lost search.
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type("dash");
    assert.equal(await page.locator(".cmdk input").inputValue(), "dash");
    await page.locator(".cmdk-title", { hasText: /^Dashboard$/ }).waitFor();
    assert.deepEqual(errors, []);
  });
});

test("an empty screen says what belongs there and how to fill it", { skip: SKIP }, async () => {
  // A brand-new instance: no servers connected at all. This is the first thing a new admin sees,
  // and it used to read "No servers yet. Add one above."
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers": { body: { servers: [] } } } }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/connections`, { waitUntil: "networkidle" });
    await page.waitForSelector(".empty-state");
    const text = await page.locator(".empty-state").first().innerText();
    assert.match(text, /No game servers connected yet/i);
    // It explains what a connection unlocks rather than only stating the absence...
    assert.match(text, /roster|game log/i);
    // ...and offers the action that fixes it.
    assert.equal(await page.locator(".empty-state button", { hasText: "Add a server" }).count(), 1);
  });
});

test("the add-server form offers every registered game, and protocols follow the game", { skip: SKIP }, async () => {
  // The Game dropdown is fed by /api/games. Before this test existed, nothing asserted the options
  // actually rendered — the form shipped once with an empty dropdown and every suite stayed green.
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers": { body: { servers: [] } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/connections`, { waitUntil: "networkidle" });
    await page.locator(".empty-state button", { hasText: "Add a server" }).click();
    const game = page.locator("form select").first();
    await page.waitForFunction(() => window.document.querySelectorAll("form select option").length > 1, null, { timeout: 10_000 });
    assert.deepEqual(await game.locator("option").allTextContents(), ["Hell Let Loose", "Hell Let Loose: Vietnam"],
      "both registered games must be selectable");

    // Switching to Vietnam narrows the protocol list to that game's own protocols.
    await game.selectOption("hllv");
    const protocols = await page.locator("form select").nth(1).locator("option").allTextContents();
    assert.ok(protocols.some((p) => /official Vietnam RCON/.test(p)), "Vietnam offers its binary-v2");
    assert.ok(!protocols.some((p) => /crcon-bridge/.test(p)), "crcon-bridge is HLL-only and must disappear");
    assert.equal(await page.locator("form select").nth(1).inputValue(), "binary-v2", "protocol resets to the game's first");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The panel behind a Cloudflare Tunnel. While the computer it runs on restarts (an update does
 * that) the tunnel is down, and Cloudflare answers every request itself: HTTP 530, error 1033, a
 * page of its own instead of the API's words. A bare "HTTP 530" read like a fault in the panel.
 */
test("a Cloudflare tunnel that is down is said in words, not as a bare HTTP 530", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [] } },
      "/api/games": { status: 530, raw: "<!DOCTYPE html><html><head><title>Cloudflare Tunnel error</title></head><body>Error 1033</body></html>" },
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/connections`, { waitUntil: "networkidle" });
    await page.locator(".empty-state button", { hasText: "Add a server" }).click();
    const alert = page.locator("form .error", { hasText: /could not load the game list/i });
    await alert.waitFor({ timeout: 10_000 });
    assert.match(await alert.innerText(), /Cloudflare can't reach the computer the panel runs on \(HTTP 530\)\. It may be restarting/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the dashboard leads with what needs attention", { skip: SKIP }, async () => {
  // A watched player in game and a server left read-only: both are things you'd want to know before
  // reading any tile, and both link to the screen that deals with them.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [{ id: "s1", name: "Server 1", host: "h", port: 1, protocol: "binary-v2", engagementMode: "observe" }] } },
      "/api/players/flagged": { body: { flags: [{ playerId: "p1", name: "Watched Guy", watchlist: true, vip: false, online: true }] } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });
    await page.waitForSelector(".attention");
    const strip = await page.locator(".attention-list").innerText();
    assert.match(strip, /watched player/i, "surfaces watched players who are in game now");
    assert.match(strip, /observe mode/i, "surfaces servers left read-only");
    // The observe-mode notice takes you to the screen that changes it.
    await page.locator(".attention", { hasText: "observe mode" }).locator("button").click();
    await page.waitForFunction(() => window.location.hash === "#/admin/connections");
  });
});

test("all-clear is stated, not left blank", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [{ id: "s1", name: "Server 1", host: "h", port: 1, protocol: "binary-v2", engagementMode: "active" }] } },
      "/api/players/flagged": { body: { flags: [] } },
      "/api/me": { body: { user: { username: "admin" }, grants: OWNER_GRANTS, unseenAnnouncements: 0 } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });
    await page.waitForSelector(".attention.ok");
    assert.match(await page.locator(".attention.ok").innerText(), /Nothing needs your attention/i);
  });
});

test("clicking a player name anywhere opens that profile, and the URL says so", { skip: SKIP }, async () => {
  // The regression this guards: the open profile used to live in React state beside the router.
  // go() set it and then set the hash — but changing the hash fires hashchange, whose handler
  // cleared it. Every player name outside the directory navigated to the players screen with
  // nobody selected. Anything the URL doesn't carry, the router is free to lose.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/leaderboard": { body: { leaderboard: [
        { playerId: "76561100000000001", name: "Clickable Guy", kills: 10, deaths: 2, kd: 5, teamkills: 0 },
      ] } },
      "/api/players/76561100000000001": { body: {
        player: { id: "76561100000000001", platformId: "76561100000000001", platform: "steam", name: "Clickable Guy", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
        stats: { kills: 10, deaths: 2, teamkills: 0, playtimeSec: 60, visits: 1 },
        flags: {}, recentEvents: [], sessions: [], aliases: [], matches: [],
      } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/players/leaderboard`, { waitUntil: "networkidle" });
    await page.locator(".player-link", { hasText: "Clickable Guy" }).click();

    // The profile is on screen…
    await page.waitForSelector("h1:has-text('Clickable Guy')", { timeout: 10_000 });
    // …and it is a place, not a mode: the URL names the player, so it can be linked and refreshed.
    const hash = await page.evaluate(() => window.location.hash);
    assert.match(hash, /76561100000000001/, `the open profile should be in the URL, got ${hash}`);

    // Back returns to the list it came from.
    await page.goBack();
    await page.waitForFunction(() => window.location.hash === "#/players/leaderboard");
  });
});

test("a polling screen refreshes in place, and a poll cannot outrun a server switch", { skip: SKIP }, async () => {
  // The live roster keeps itself current. Two things have to hold: the poll must replace the list
  // without blanking it, and switching server mid-flight must not let the previous server's roster
  // land on top of the new one.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "Slow Server", host: "h", port: 1, protocol: "binary-v2", engagementMode: "active" },
        { id: "s2", name: "Fast Server", host: "h", port: 2, protocol: "binary-v2", engagementMode: "active" },
      ] } },
      "/api/servers/s1/live": { delayMs: 1500, body: { players: [{ id: "1", name: "STALE-ROSTER", team: 0 }], session: { playerCount: 1 } } },
      "/api/servers/s2/live": { body: { players: [{ id: "2", name: "CURRENT-ROSTER", team: 0 }], session: { playerCount: 1 } } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('select[aria-label="Active server"]');
    await page.selectOption('select[aria-label="Active server"]', "s2");
    await page.waitForFunction(() => window.document.body.innerText.includes("CURRENT-ROSTER"), null, { timeout: 10_000 });
    await page.waitForTimeout(2500); // outlast the slow response and at least one poll
    const body = await page.locator("body").innerText();
    assert.ok(body.includes("CURRENT-ROSTER"), "the roster stays on screen across polls");
    assert.ok(!body.includes("STALE-ROSTER"), "the outrun roster for the previous server was discarded");
  });
});

/*
 * The Live card's counts on a phone. They sat in a row that never wrapped, so each squeezed into a
 * column of its own and broke over two or three lines ("· 40/40 / queued", "· 2 / VIP / slots"),
 * the separators stranded at the start of a line. Each count keeps to one line; the row wraps
 * between them.
 */
test("on a phone the Live card's counts each keep to one line", { skip: SKIP }, async () => {
  for (const width of [390, 360]) {
    await withPage({ grants: OWNER_GRANTS, viewport: { width, height: 844 } }, async (page) => {
      await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
      await page.locator(".lm-counts", { hasText: "queued" }).waitFor();
      const counts = await page.evaluate(() => [...window.document.querySelectorAll(".lm-counts > :not(.badge)")].map((el) => {
        const range = window.document.createRange();
        range.selectNodeContents(el);
        const line = Math.max(...[...range.getClientRects()].map((r) => r.height));
        return { text: el.textContent.trim(), lines: Math.round(range.getBoundingClientRect().height / line) };
      }));
      for (const want of [/online/, /queued/, /VIP slots/, /\d+ VIP$/]) assert.ok(counts.some((c) => want.test(c.text)), `${width}px: ${want} is a count of its own — ${JSON.stringify(counts)}`);
      for (const c of counts) assert.equal(c.lines, 1, `${width}px: "${c.text}" breaks over ${c.lines} lines`);
      // …and none runs off the card instead.
      const past = await page.evaluate(() => {
        const edge = window.document.querySelector(".live-summary").getBoundingClientRect().right;
        return [...window.document.querySelectorAll(".lm-counts > *")].filter((el) => el.getBoundingClientRect().right > edge + 1).map((el) => el.textContent.trim());
      });
      assert.deepEqual(past, [], `${width}px: counts past the card's edge`);
    });
  }
});

test("on a phone the Live header does not pin itself over the screen", { skip: SKIP }, async () => {
  // Reported from a real phone: the Live "dashboard" blocked the screen the whole time you
  // scrolled. The page head is `position: sticky`, and Live had packed its entire status card —
  // title, blurb, breadcrumb, player counts, map, score line, No-SL warnings, footer — inside it.
  // On a 390px-wide screen that pinned block was most of the viewport and never moved, so the
  // scoreboard scrolled past through a sliver.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone-class
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".live-summary", { timeout: 10_000 });
    // Let the layout settle before measuring. The nav drawer is fixed and full-height, parked at
    // translateX(-100%), and the skip below recognises it by where it ends up — so measuring while
    // its transition is still running reports an 844px pinned header and fails on nothing.
    await page.waitForTimeout(250);

    // Whatever is actually pinned to the top of the viewport, measured from the rendered page
    // rather than assumed from the CSS.
    const pinnedHeight = await page.evaluate(() => {
      let worst = 0;
      for (const el of window.document.querySelectorAll("body *")) {
        const cs = window.getComputedStyle(el);
        if (cs.position !== "sticky" && cs.position !== "fixed") continue;
        // Skip what is present but not on screen: the nav drawer is fixed and full-height, and
        // sits at translateX(-100%) until you open it; the scrim is fixed and transparent.
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.right <= 8 || r.left >= window.innerWidth - 8) continue;
        // Only things parked at the top of the viewport steal reading space.
        if (r.top <= 1 && r.height > 0 && r.width > 200) worst = Math.max(worst, r.height);
      }
      return worst;
    });
    assert.ok(
      pinnedHeight < 844 * 0.35,
      `a pinned header may not eat a third of a phone screen — got ${Math.round(pinnedHeight)}px of 844`,
    );

    // And the status really does scroll away: it is content now, not chrome.
    const before = await page.evaluate(() => window.document.querySelector(".live-summary").getBoundingClientRect().top);
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => window.document.querySelector(".live-summary").getBoundingClientRect().top);
    assert.ok(after < before - 400, `the match status should scroll away, moved ${Math.round(before - after)}px`);

    // The roster below it is reachable — the point of the whole screen.
    await page.evaluate(() => window.scrollTo(0, window.document.body.scrollHeight));
    await page.waitForTimeout(150);
    assert.ok((await page.locator("body").innerText()).includes("Scoreboard"), "the scoreboard is reachable by scrolling");
  });
});

test("on a phone a hub still pins its tab bar, so tabs stay reachable down a long list", { skip: SKIP }, async () => {
  // Dropping the sticky head on mobile must not cost the tab bar: that is the part worth keeping
  // within reach halfway down a page, and it is ~36px rather than ~500.
  // A long list, so there is actually something to scroll past.
  const players = Array.from({ length: 120 }, (_, i) => ({
    id: `d${i}`, name: `Directory Player ${i}`, platform: "steam", platformId: `7656119000000${i}`,
    firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z",
    kills: i, deaths: i, teamkills: 0, visits: i, playtimeSec: i * 3600,
  }));
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/players": { body: { players, total: players.length } } },
  }, async (page) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${page.url().split("#")[0]}#/players/directory`, { waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar", { timeout: 10_000 });
    await page.waitForFunction(() => window.document.body.scrollHeight > window.innerHeight + 400, null, { timeout: 10_000 });

    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(150);
    const bar = await page.evaluate(() => {
      const el = window.document.querySelector(".tabbar");
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, scrolled: window.scrollY };
    });
    /*
     * Measure where the bar actually IS, not which CSS property it carries. The previous version of
     * this test asserted `position === "sticky"` and `top <= 1` — and passed while the bar sat at
     * top: -391, four hundred pixels above the viewport. Every negative number satisfies `<= 1`, so
     * the geometry check could not fail, and the CSS property was declared on an element that had
     * no room to stick: the bar was the last child of the header card, so its sticky range ended
     * exactly where it began. It has never actually pinned on a phone until now.
     */
    assert.ok(bar.scrolled > 400, `the page must really have scrolled, got ${bar.scrolled}px`);
    assert.ok(bar.top >= -1 && bar.top <= 1, `the tab bar must be pinned AT the top, got ${Math.round(bar.top)}px`);
    assert.ok(bar.bottom > 0 && bar.bottom < 120, `and visible on screen, got bottom ${Math.round(bar.bottom)}px`);
    assert.ok(bar.height < 80, `the pinned strip should be small, got ${Math.round(bar.height)}px`);
  });
});

test("a Discord setup response missing fields degrades to 'off', it does not white-screen the app", { skip: SKIP }, async () => {
  // Found the hard way: the readout did `Object.values(data.features)`, so a payload without that
  // key threw during render — and because the panel is one React tree, one status card took down
  // every screen with "Application error: a client-side exception has occurred". A status readout
  // is exactly the thing that has to survive a surprising response.
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/discord/setup": { body: {} } } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/discord/setup`, { waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar", { timeout: 10_000 });

    const body = await page.locator("body").innerText();
    assert.ok(!body.includes("Application error"), "the page still renders");
    assert.ok(body.includes("Discord is"), "it reports the honest answer — nothing is configured");
    // Nothing is known about any piece, so each reads "not set" rather than vanishing.
    assert.ok(body.includes("Bot token"), "the checklist is still listed");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The Discord app's settings are typed in on Setup & status instead of infra/.env. A secret comes back
 * only as "set": its field stays empty, blank keeps it, and Remove clears it on save. Only what was
 * changed is sent.
 */
test("Discord setup: the app's settings are typed in here, a saved secret is never shown, and only what changed is sent", { skip: SKIP }, async () => {
  let stubRef = null;
  const readout = (pieces = {}, values = {}) => ({
    pieces: { botToken: true, appId: false, publicKey: false, clientId: true, clientSecret: true, guildId: true, redirectUri: false, ...pieces },
    values: { guildId: "234567890123456789", redirectUri: null, clientId: "123456789012345678", appId: null, publicKey: null, communityGuildId: null, ...values },
    features: { relay: true, interactions: false, signIn: false, roleSync: true, commandRegistration: false },
  });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/discord/setup": () => ({ body: stubRef?.calls.at(-1)?.method === "PUT"
      ? readout({ botToken: false, appId: true, redirectUri: true }, { appId: "345678901234567890", redirectUri: "https://panel.example.com/api/auth/discord/callback" })
      : readout() }),
  } }, async (page, { stub, errors }) => {
    stubRef = stub;
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/discord/setup`, { waitUntil: "networkidle" });
    const token = page.getByLabel("Bot token");
    await token.waitFor({ timeout: 10_000 });
    assert.equal(await token.inputValue(), "", "the saved token is not shown");
    assert.equal(await token.getAttribute("placeholder"), "saved — leave blank to keep it");
    assert.equal(await page.getByLabel("Staff server id").inputValue(), "234567890123456789", "ids are shown as they are");

    await page.getByLabel("Application id").fill("345678901234567890");
    // Opened on this computer's own address, the panel does not offer it as the return address: it
    // would work for nobody signing in from anywhere else.
    assert.equal(await page.locator("button", { hasText: "Use this panel's address" }).count(), 0);
    await page.getByLabel("Sign-in return address").fill("https://panel.example.com");
    const tokenRow = page.locator(".setup-row", { hasText: "Bot token" });
    await tokenRow.locator("button", { hasText: "Remove" }).click();
    await tokenRow.locator(".badge", { hasText: "removed on save" }).waitFor({ timeout: 5_000 });
    const setupPanel = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Setup & status" }) });
    await setupPanel.locator("button", { hasText: /^Save$/ }).click();
    await setupPanel.locator(".ok-msg", { hasText: "Saved" }).waitFor({ timeout: 10_000 });
    const put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/discord/setup");
    assert.deepEqual(put?.body, { appId: "345678901234567890", redirectUri: "https://panel.example.com", botToken: "" },
      "the id and the return address typed, and the token removed — the client secret, left blank, is kept");
    assert.equal(await page.getByLabel("Application id").inputValue(), "345678901234567890", "the saved readout is shown");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

// Opened from an address of its own, the panel offers that address as the return address in one click.
test("Discord setup: opened from the panel's own address, its return address is one click away", { skip: SKIP }, async () => {
  const readout = { pieces: { botToken: true, appId: true, publicKey: false, clientId: true, clientSecret: true, guildId: true, redirectUri: false },
    values: { guildId: "234567890123456789", redirectUri: null, clientId: "123456789012345678", appId: "345678901234567890", publicKey: null, communityGuildId: null },
    features: { relay: true, interactions: false, signIn: false, roleSync: true, commandRegistration: false } };
  await withPage({ grants: OWNER_GRANTS, browserArgs: ["--host-resolver-rules=MAP panel.test 127.0.0.1"], overrides: {
    "/api/discord/setup": { body: readout },
  } }, async (page, { stub, errors }) => {
    const own = `http://panel.test:${new URL(stub.base).port}`;
    await page.goto(`${own}/#/discord/setup`, { waitUntil: "networkidle" });
    await page.getByLabel("Sign-in return address").waitFor({ timeout: 10_000 });
    await page.locator("button", { hasText: "Use this panel's address" }).click();
    assert.equal(await page.getByLabel("Sign-in return address").inputValue(), `${own}/api/auth/discord/callback`);
    const setupPanel = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Setup & status" }) });
    await setupPanel.locator("button", { hasText: /^Save$/ }).click();
    await setupPanel.locator(".ok-msg", { hasText: "Saved" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(stub.calls.find((c) => c.method === "PUT" && c.path === "/api/discord/setup")?.body, { redirectUri: `${own}/api/auth/discord/callback` });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The request builder, the community's time zone and the backup list showed defaults when their
 * read failed: no ceiling and 72 hours (and the hours box saves when it is left, so tabbing
 * through it put 72 over the real value), UTC as the community's clock, and "No backups yet".
 */
test("Users & roles and Backup: a read that failed is said, and nothing is saved over it", { skip: SKIP }, async () => {
  const failed = { status: 500, body: { error: { code: "internal", message: "The settings could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/app-config": failed, "/api/data/backups": failed } }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    const panel = (title) => page.locator("section.panel", { has: page.locator(".panel-title", { hasText: title }) });
    await page.goto(`${base}#/admin/users`, { waitUntil: "networkidle" });
    await panel("Request builder").getByText("Couldn't read the request builder's settings").waitFor({ timeout: 10_000 });
    assert.equal(await panel("Request builder").locator("input, select").count(), 0, "no form over what it could not read");
    await panel("Community time zone").getByText("Couldn't read the community time zone").waitFor({ timeout: 10_000 });
    assert.equal(await panel("Community time zone").locator("select").count(), 0, "no zone named for it");

    await page.goto(`${base}#/admin/backup`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't list the backups").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No backups yet").count(), 0, "a list that failed is not an empty one");
    assert.ok(!stub.calls.some((c) => c.method === "PUT" && c.path === "/api/app-config"), "nothing was saved");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // Read, and left as it was: nothing is saved. Changed: it is.
  const config = { body: { config: { timezone: "UTC", requestCeilingRoleId: "", requestDraftTtlHours: 48 } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/app-config": config } }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/users`, { waitUntil: "networkidle" });
    const hours = page.getByLabel("Discard unsubmitted drafts after (hours)");
    await page.waitForFunction(() => [...window.document.querySelectorAll("input[type=number]")].some((el) => el.value === "48"), null, { timeout: 10_000 });
    await hours.focus();
    await hours.blur();
    await page.waitForTimeout(400);
    const puts = () => stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/app-config");
    assert.equal(puts().length, 0, "left as it was: nothing saved");
    // The reply, not the request: the stand-in records a save once it has read the whole body,
    // which can come after the browser has reported the request sent.
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/app-config") && r.request().method() === "PUT", { timeout: 10_000 });
    await hours.fill("24");
    await hours.blur();
    await saved;
    assert.deepEqual(puts().map((c) => c.body), [{ requestDraftTtlHours: 24 }]);
  });
});

/*
 * The community's clock belongs to the whole community, so it is not among anyone's own settings: it
 * is on Users & roles, answering to user & role admin as the server does — read shows it, write
 * changes it, and a change without write is sent for approval. Settings keeps each person's own
 * clock, which names the community's as its default.
 */
test("the community's time zone is set on Users & roles, not in anyone's own Settings", { skip: SKIP }, async () => {
  const config = { body: { config: { timezone: "America/New_York", requestCeilingRoleId: "", requestDraftTtlHours: 48 } } };
  const panel = (page, title) => page.locator("section.panel", { has: page.locator(".panel-title", { hasText: title }) });
  for (const [grants, who] of [[OWNER_GRANTS, "an owner"], [[held("server.view", "read")], "staff"]]) {
    await withPage({ grants, overrides: { "/api/app-config": config } }, async (page, { stub, errors }) => {
      await page.goto(`${stub.base}/#/settings`, { waitUntil: "networkidle" });
      await panel(page, "Workspace").getByText("Times shown in").waitFor({ timeout: 10_000 });
      assert.equal(await panel(page, "Community time zone").count(), 0, `not in ${who}'s own Settings`);
      const own = panel(page, "Workspace").locator(".setting-card", { hasText: "Times shown in" }).locator("select");
      assert.ok((await own.locator("option").allTextContents()).includes("Community default (America/New_York)"), "their own clock names the community's");
      assert.deepEqual(errors, []);
    });
  }
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/app-config": config } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/admin/users`, { waitUntil: "networkidle" });
    const clock = panel(page, "Community time zone").locator("select");
    await clock.waitFor({ timeout: 10_000 });
    assert.equal(await clock.inputValue(), "America/New_York");
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/app-config") && r.request().method() === "PUT", { timeout: 10_000 });
    await clock.selectOption("Europe/London");
    await saved;
    assert.deepEqual(stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/app-config").map((c) => c.body), [{ timezone: "Europe/London" }]);
    assert.deepEqual(errors, []);
  });
  // Read alone: it is shown, and a change is sent for approval.
  await withPage({ grants: [held("server.view", "read"), held("admin.users", "read")], overrides: { "/api/app-config": config } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/admin/users`, { waitUntil: "networkidle" });
    await panel(page, "Community time zone").locator("select").waitFor({ timeout: 10_000 });
    await panel(page, "Community time zone").getByText("sent for approval", { exact: false }).waitFor();
    assert.deepEqual(errors, []);
  });
});

/*
 * Each control on Maps answers to the permission the server checks for it — the rotation editor to
 * Edit map rotation, Rename and Set family to Map display names, Change now to Set next map — and
 * Add server to Add a server, not to looking after the servers already there.
 */
test("Maps and Connections show each control to the permission the server checks for it", { skip: SKIP }, async () => {
  const view = held("server.view", "read");
  const cases = [
    { name: "Edit map rotation", grants: [view, held("maps.rotation")], rotation: true, rename: false, change: false },
    { name: "Set next map", grants: [view, held("maps.next")], rotation: false, rename: false, change: true },
    { name: "Map display names", grants: [view, held("maps.names")], rotation: false, rename: true, change: false },
  ];
  for (const c of cases) {
    await withPage({ grants: c.grants, overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
      await page.goto(`${stub.base}/#/maps/rotation`, { waitUntil: "networkidle" });
      await page.locator(".panel-title", { hasText: "In play" }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Check from game" }).first().waitFor();
      assert.equal(await page.locator(".panel-title", { hasText: "Edit rotation" }).count(), c.rotation ? 1 : 0, `${c.name}: the rotation editor`);
      await page.goto(`${stub.base}/#/maps/catalogue`, { waitUntil: "networkidle" });
      await page.locator(".panel-title", { hasText: "Every map" }).waitFor({ timeout: 10_000 });
      assert.equal(await page.getByRole("button", { name: "Rename" }).count() > 0, c.rename, `${c.name}: Rename`);
      assert.equal(await page.getByRole("button", { name: "Set family" }).count() > 0, c.rename, `${c.name}: Set family`);
      assert.equal(await page.getByRole("button", { name: /^(Change now|Add \+ change)$/ }).count() > 0, c.change, `${c.name}: Change now`);
      assert.deepEqual(errors, []);
    });
  }
  for (const [grants, add, name] of [[[view, held("server.add")], true, "Add a server"], [[view, held("server.manage")], false, "Manage a server's connection"]]) {
    await withPage({ grants, overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
      await page.goto(`${stub.base}/#/admin/connections`, { waitUntil: "networkidle" });
      await page.locator(".panel-title", { hasText: "Connections" }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);
      assert.equal(await page.getByRole("button", { name: "Add server" }).count(), add ? 1 : 0, `${name}: Add server`);
      assert.deepEqual(errors, []);
    });
  }
});

/*
 * A player's Discord registration answers to Player identity links, as the server does — read shows
 * it, with a change sent for approval — and not to the watchlist. Scheduling events answers to
 * Community events alone: someone who can only run payouts gets Payouts and the event Report, not a
 * schedule tab with nothing of theirs on it.
 */
test("Discord registration and event scheduling each answer to their own permission", { skip: SKIP }, async () => {
  const view = held("server.view", "read");
  for (const [grants, shown, who] of [[[view, held("player.watchlist")], false, "the watchlist"], [[view, held("player.links", "read")], true, "identity links, read"]]) {
    await withPage({ grants, overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
      await page.goto(`${stub.base}/#/players/directory`, { waitUntil: "networkidle" });
      await page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Directory" }) }).locator("tbody tr").first().click();
      await page.locator(".panel-title", { hasText: "Overview" }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const panel = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Discord registration" }) });
      assert.equal(await panel.count(), shown ? 1 : 0, `${who}: Discord registration`);
      if (shown) {
        await panel.getByText("sent for approval", { exact: false }).waitFor();
        assert.equal(await panel.getByLabel("Discord user id").isEnabled(), true, "a change can be asked for");
      }
      assert.deepEqual(errors, []);
    });
  }
  for (const [grants, tabs, who] of [[[held("economy.payout")], ["Payouts", "Report"], "payouts"], [[held("events.manage", "read")], ["Events", "Report"], "events, read"]]) {
    await withPage({ grants, overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
      await page.goto(`${stub.base}/#/events`, { waitUntil: "networkidle" });
      await page.locator(".hub-tabs [role='tab']").first().waitFor({ timeout: 10_000 });
      assert.deepEqual((await page.locator(".hub-tabs [role='tab']").allTextContents()).map((t) => t.trim()), tabs, who);
      assert.deepEqual(errors, []);
    });
  }
});

/*
 * A game server the panel cannot reach left "…" where its map goes, on its own page and on the
 * stats site's list of servers, for as long as it stayed down — as if its game were on its way.
 */
test("public site: a server that cannot be reached says so where its map goes", { skip: SKIP }, async () => {
  const mk = (slug, name) => ({
    slug, name, game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  });
  const down = { body: { result: null, failed: true, error: "could not reach the server" } };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [mk("alpha", "Alpha 24/7"), mk("bravo", "Bravo")] } },
    "/stats/alpha/api/get_public_info": down,
    "/stats/bravo/api/get_public_info": down,
    "/stats/alpha/api/get_live_game_stats": { body: { result: { snapshot_timestamp: 1, refresh_interval_sec: 5, stats: [] }, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "load" });
    await page.locator(".pub-hud-link, .hud-card, body").getByText("Not reachable right now").first().waitFor({ timeout: 10_000 });
    await page.goto(`${stub.base}/stats`, { waitUntil: "load" });
    await page.waitForFunction(() => (window.document.body.innerText.match(/Not reachable right now/g) ?? []).length >= 2, null, { timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The staff screens counted one as many too: "1 rounds, 1 decided" over a short window on Match
 * analytics, a map "over 1 rounds", a side of "1 players", a server's "1 matches".
 */
test("Match analytics: one round is counted as 1 round", { skip: SKIP }, async () => {
  const map = (name, rounds, alliesWins, axisWins) => ({ map: name, rounds, alliesWins, axisWins, alliesWinRate: alliesWins / Math.max(1, alliesWins + axisWins), avgMargin: 1.5, blowoutRate: 0, avgDurationSec: 3_600 });
  const MATCH = {
    window: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" },
    rounds: 1, decided: 1, alliesWins: 1, axisWins: 0, alliesWinRate: 1,
    avgDurationSec: 3_600, medianDurationSec: 3_600, avgMargin: 4, blowoutRate: 0,
    byMap: [map("Carentan Warfare", 1, 1, 0)],
    byHour: Array(24).fill(0), weekHour: Array.from({ length: 7 }, () => Array(24).fill(0)),
    timeline: [{ date: "2026-06-01", rounds: 1, alliesWins: 1, axisWins: 0 }],
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/analytics/match": { body: MATCH } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/analytics/match`, { waitUntil: "networkidle" });
    await page.getByText("1 round, 1 decided").waitFor({ timeout: 10_000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /\b1 rounds\b/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("Combat analytics: one kill by one player reads in the singular", { skip: SKIP }, async () => {
  const COMBAT = {
    window: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-06T00:00:00.000Z" },
    kills: 1, teamkills: 0, killers: 1, victims: 1, tkRate: 0,
    weapons: [{ weapon: "M1 GARAND", classId: "rifle", className: "Rifle", kills: 1, teamkills: 0, share: 1, tkRate: 0 }],
    classes: [{ id: "rifle", label: "Rifle", kills: 1, teamkills: 0, share: 1 }],
    friendlyFireWeapons: [], daily: [{ date: "2026-06-01", kills: 1, teamkills: 0 }],
    weekHour: Array.from({ length: 7 }, () => Array(24).fill(0)), byHour: Array(24).fill(0),
    topKillers: [{ playerId: "p1", name: "Smith", kills: 1 }], topTeamkillers: [],
    byMap: [{ map: "Carentan Warfare", kills: 1, teamkills: 0 }],
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/analytics/combat": { body: COMBAT } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/analytics/combat`, { waitUntil: "networkidle" });
    await page.getByText("1 kill from 1 player").waitFor({ timeout: 10_000 });
    const body = await page.locator("body").innerText();
    assert.match(body, /1 player did the killing/);
    assert.doesNotMatch(body, /\b1 (kills|players)\b/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("Online access: the stats site's own address and community name are saved there", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/online": { body: { statsSite: { host: null, origin: null, name: null, shareable: null } } },
    "/api/online/stats-site": { body: { statsSite: { host: "stats.example.com", origin: null, name: "The Lynx Division", shareable: "https://stats.example.com" } } },
  } }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/admin/online`, { waitUntil: "networkidle" });
    const statsPanel = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Public stats site" }) });
    await statsPanel.locator("label", { hasText: "Its own address" }).locator("input").fill("stats.example.com");
    await statsPanel.locator("label", { hasText: "Community name" }).locator("input").fill("The Lynx Division");
    await statsPanel.locator("button", { hasText: /^Save$/ }).click();
    await statsPanel.locator(".ok-msg", { hasText: "Stats links now start https://stats.example.com" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(stub.calls.find((c) => c.method === "PUT" && c.path === "/api/online/stats-site")?.body, { host: "stats.example.com", origin: "", name: "The Lynx Division" });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("composition analytics draws every panel, and hides maps with too few samples", { skip: SKIP }, async () => {
  // The one analytics page whose data cannot be reconstructed from the log. Two things have to
  // hold for it to be worth having: it renders the whole shape it was given, and it refuses to
  // rank a map off a handful of readings — a 4-sample map next to a 620-sample one would read as
  // a fair comparison.
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    // A full load, so the wait for a quiet network covers the screen's reads: changing the
    // address's # alone does not, and the panels' titles are drawn before their figures arrive.
    await page.goto(`${base}?full=1#/analytics/composition`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.document.body.innerText.includes("Side balance"), null, { timeout: 10_000 });

    const body = await page.locator("body").innerText();
    for (const panel of ["Overview", "Side balance", "Role mix", "Role mix over time", "Leaderless squads over time", "By map"]) {
      assert.ok(body.includes(panel), `the ${panel} panel is on the page`);
    }
    // Role numbers are meaningless to a reader; the descriptor's labels must reach the chart.
    assert.ok(body.includes("Rifleman"), "roles are named, not numbered");
    assert.ok(body.includes("Allies") && body.includes("Axis"), "sides are named");
    // The page states its own resolution rather than implying minute-by-minute truth.
    assert.ok(/one every 30 min/.test(body), `the sampling resolution is stated, got: ${body.slice(0, 300)}`);

    assert.ok(body.includes("ST MARIE DU MONT"), "a well-sampled map is listed");
    assert.ok(!body.includes("CARENTAN"), "a map with 4 samples is not ranked against one with 620");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("server analytics shows what the game's own score says, and stays quiet without it", { skip: SKIP }, async () => {
  // The sampler has been recording combat/offense/defense/support and squad-leader time since the
  // panel first watched a server, and none of it reached a screen — a full server and a server
  // playing deathmatch looked identical here. Two things have to hold: the figures are the ones
  // the numbers actually add up to (a chart that draws SOMETHING is not the same as a right one),
  // and a server with no scored rounds says so instead of drawing an empty axis.
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/analytics/server`, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => window.document.body.innerText.includes("How the game is being played"),
      null, { timeout: 10_000 },
    );

    const play = page.locator(".panel", { hasText: "How the game is being played" }).first();
    // The title is drawn while the read is still out, over a placeholder, and changing the
    // address's # alone does not wait for the read: the panel is looked at once it has its answer.
    await play.locator('[aria-busy="true"]').waitFor({ state: "detached", timeout: 10_000 });
    // Lowercased because innerText reflects the stylesheet, and stat-tile labels are uppercased
    // in CSS — asserting on the authored casing would pin a font decision, not a number.
    const text = (await play.innerText()).toLowerCase();

    // Derived, not echoed: 25 rounds across five days, 43,200 SL-seconds = 12h, and an objective
    // share of 185,000/375,000. Each is a different arithmetic mistake if it comes out wrong.
    assert.match(text, /rounds scored\s*25\b/, `rounds are summed across the window, got: ${text.slice(0, 400)}`);
    assert.ok(text.includes("12h"), "squad-leader seconds are reported in hours");
    assert.ok(text.includes("18% of players led at some point"), "the led share is stated as a share of players");
    assert.ok(text.includes("49%"), "objective score is a share of ALL score, not of combat");

    // One bar in four named parts — identity never colour alone.
    assert.equal(await play.locator(".split-seg").count(), 4, "the score splits into its four buckets");
    for (const label of ["combat", "offense", "defense", "support"]) {
      assert.ok(text.includes(label), `${label} is named in the legend`);
    }

    // Four series over five days, on one axis because they are shares. A dual-axis version of this
    // chart is the thing the shares exist to avoid.
    assert.equal(await play.locator(".viz-legend .li").count(), 4, "every series is in the legend");
    assert.equal(await play.locator("polyline").count(), 4, "one line per bucket");

    // Squad-leader hours are a different unit, so they get their own chart rather than a second
    // y-axis — five bars, including the day nobody led.
    // rx=3 picks the drawn bars; every bar also carries an invisible full-height hit target.
    assert.equal(await play.locator('.viz-bars rect[rx="3"]').count(), 5, "one bar per day, including the empty one");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // The same page for a server whose rounds predate the sampler: the API sends no `scores` at all.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/analytics/server": { body: { window: { from: "", to: "" } } } },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/analytics/server`, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => window.document.body.innerText.includes("How the game is being played"),
      null, { timeout: 10_000 },
    );
    const play = page.locator(".panel", { hasText: "How the game is being played" }).first();
    await play.locator('[aria-busy="true"]').waitFor({ state: "detached", timeout: 10_000 });
    const text = await play.innerText();
    assert.match(text, /No scored rounds in this window yet/, `it explains the absence, got: ${text.slice(0, 300)}`);
    assert.equal(await play.locator(".split-seg").count(), 0, "nothing is drawn from nothing");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * When people play picks what its grid shows. Players online is the page's own read and costs no
 * extra request; anything else is fetched when picked, and an empty grid says which kind of empty
 * it is: all zeros is a fact about the server, no squares at all a fact about the record.
 */
test("server analytics: When people play picks what its grid shows, fetching only what is picked", { skip: SKIP }, async () => {
  const seen = [];
  const day = (hours) => [{ date: "2026-06-01", hours: Array.from({ length: 24 }, (_, h) => hours[h] ?? null) }];
  const rowsFor = { kills: day({ 19: 0, 20: 14, 21: 9 }), chat: day({ 20: 0, 21: 0 }), queue: day({}) };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/analytics/server/hours": (url) => {
        const metric = url.searchParams.get("metric");
        seen.push(metric);
        return { body: { metric, rows: rowsFor[metric] ?? [] } };
      },
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/analytics/server`, { waitUntil: "networkidle" });
    const card = page.locator(".panel", { hasText: "When people play" }).first();
    const picker = card.locator('select[aria-label="What the grid shows"]');
    await picker.waitFor({ timeout: 10_000 });
    assert.deepEqual(seen, [], "players online is the page's own read: nothing extra until something is picked");
    const groups = await picker.locator("optgroup").evaluateAll((gs) => gs.map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.value)]));
    assert.deepEqual(groups, [
      ["Population", ["online", "peak", "queue", "arrivals"]],
      ["Teams and squads", ["imbalance", "noLeader", "unsquadded"]],
      ["Game log", ["kills", "teamkills", "chat", "moderation"]],
    ]);

    await picker.selectOption("kills");
    await card.locator(".hm-unit", { hasText: "kills" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(seen, ["kills"]);
    assert.match(await card.locator(".panel-subtitle").innerText(), /^kills, every date in the window$/);
    assert.equal(await card.locator("rect.hm-cell").count(), 3, "a square for each hour with a figure, none for the rest");
    // A zero is drawn, outlined like the legend says; an hour with no record is not drawn at all.
    const zero = card.locator("rect.hm-zero");
    assert.equal(await zero.count(), 1);
    assert.notEqual(await zero.evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).stroke), "none", "a zero is outlined, not invisible");

    // Zeros where the app was watching: the server was quiet, and the grid says so.
    await picker.selectOption("chat");
    await card.locator(".nothing", { hasText: "No chat logged in this window." }).waitFor({ timeout: 10_000 });
    // No figure anywhere: the record is what is missing, and the grid says that instead.
    await picker.selectOption("queue");
    await card.locator(".nothing", { hasText: "No queue recorded in this window." }).waitFor({ timeout: 10_000 });
    assert.deepEqual(seen, ["kills", "chat", "queue"]);

    // Back to players online: the page's own grid again, with no request for it.
    await picker.selectOption("online");
    assert.match(await card.locator(".panel-subtitle").innerText(), /^players online at once, every date in the window$/);
    assert.deepEqual(seen, ["kills", "chat", "queue"]);
    assert.deepEqual(errors, []);
  });
});

test("a backend that accepts but never answers is reported, not waited on forever", { skip: SKIP }, async () => {
  // Found from a real report: every Discord tab sat on a loading skeleton with nothing on screen
  // saying why. `api()` had no timeout, so a server that took the connection and then went quiet
  // left each screen shimmering indefinitely — the one failure that most needs explaining was the
  // one the panel explained least. A short timeout is injected here so the test doesn't wait a
  // minute for the real one.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/discord/setup": { delayMs: 30_000, body: {} } },
  }, async (page) => {
    // Set on the live document, not via addInitScript: the navigation below only changes the hash,
    // so the page never reloads and an init script would never run. The timeout is read per call.
    await page.evaluate(() => { window.__API_TIMEOUT_MS__ = 1500; });
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/discord/setup`, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(
      () => /did not respond|Could not reach/.test(window.document.body.innerText),
      null,
      { timeout: 15_000 },
    );
    const body = await page.locator("body").innerText();
    assert.match(body, /did not respond within \d+s/, `the page says the server went quiet, got: ${body.slice(0, 300)}`);
  });
});

test("the map vote's controls are all present and disabled with a reason, never hidden", { skip: SKIP }, async () => {
  // Modelled on the old bot's panel, which is the version of this screen people actually like.
  // Its rule is that every action is always on screen and greys out when it doesn't apply — a
  // "Resume" you can see but not press tells you the vote isn't paused, where a "Resume" that has
  // vanished makes you wonder whether resuming exists at all. The old screen hid these actions
  // inside a nine-step configuration wizard; this pins both that they are reachable and that their
  // enabled state tracks the poll.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/servers/s1/mapvote/config": mapvoteFixture({ activePoll: true }) },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/vote`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.document.body.innerText.includes("Leader"), null, { timeout: 10_000 });

    const btns = await voteButtons(page);
    // Every action the old bot's panel had has a home here. Missing one is the regression this guards against.
    for (const label of ["Start vote", "Pause", "Resume", "New options", "Skip vote", "Re-read maps",
                         "Tell players: maps", "Tell players: standings", "Force next map", "Clear forced map"]) {
      assert.ok(label in btns, `"${label}" is on the control surface, got ${JSON.stringify(Object.keys(btns))}`);
    }
    // A poll is open and nothing is forced, so: Pause yes, Resume no, Clear forced map no.
    assert.equal(btns["Pause"], true, "a running vote can be paused");
    assert.equal(btns["Resume"], false, "a vote that isn't paused cannot be resumed");
    assert.equal(btns["Skip vote"], true, "an open poll can be skipped");
    assert.equal(btns["Clear forced map"], false, "nothing is forced, so there is nothing to clear");

    // The status block answers the four questions the old bot's embed answered.
    const body = await page.locator("body").innerText();
    for (const field of ["Profile", "Poll", "Leader", "Next map"]) {
      assert.ok(body.includes(field), `the status block states ${field}`);
    }
    assert.ok(body.includes("friday"), "it names the scheduled profile in force");
    assert.ok(/Foy \(Night\)/.test(body), "and the map currently leading");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("pausing and having no poll flip exactly the controls they should", { skip: SKIP }, async () => {
  // The inverse of the case above, so the assertions can't pass by everything simply being enabled.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/servers/s1/mapvote/config": mapvoteFixture({ paused: true, activePoll: false, override: "kharkov_warfare" }) },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/vote`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.document.body.innerText.includes("Paused"), null, { timeout: 10_000 });

    const btns = await voteButtons(page);
    assert.equal(btns["Pause"], false, "an already-paused vote cannot be paused again");
    assert.equal(btns["Resume"], true, "a paused vote can be resumed");
    assert.equal(btns["Skip vote"], false, "with no poll open there is nothing to skip");
    assert.equal(btns["Tell players: standings"], false, "and no standings to broadcast");
    assert.equal(btns["Clear forced map"], true, "a forced map can be cleared");
    // Start vote and Re-read maps are the two that always work — they are how you get unstuck.
    assert.equal(btns["Start vote"], true, "starting a fresh vote always works");
    assert.equal(btns["Re-read maps"], true, "re-reading the map list always works");

    const body = await page.locator("body").innerText();
    assert.ok(body.includes("Kharkov"), "the forced map is named in the status block");
    assert.ok(/forced by staff/.test(body), "and labelled as staff's doing rather than the vote's");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the retired Discord map-vote tab lands on the Maps vote screen", { skip: SKIP }, async () => {
  // That tab's whole content was a sentence and a button pointing back at Maps. Anyone who
  // bookmarked it should arrive where the feature actually is.
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/discord/mapvote`, { waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar", { timeout: 10_000 });

    const tabs = await page.locator(".tabbar-tab").allInnerTexts();
    assert.ok(tabs.includes("Vote"), `the Maps tab bar is showing, got ${JSON.stringify(tabs)}`);
    const active = await page.locator(".tabbar-tab.active").innerText();
    assert.equal(active.trim(), "Vote", "and Vote is the selected tab");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a map set is built per game mode, counted per real time of day", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/servers/s1/mapvote/config": { body: MODE_CFG({
      modeBuckets: [
        { mode: "warfare", count: 4, limits: { day: 3, night: 1 }, maps: [] },
        { mode: "offensive", count: 2, maps: [] },
      ],
    }) } },
  }, async (page, { errors }) => {
    // The set editor lives in the shared library now — open it and pick the set under test.
    await openLibrary(page, "Manage map sets", "default");
    await page.waitForSelector(".mapset-envs", { timeout: 10_000 });

    const card = (label) => page.locator(".mapset-bucket").filter({ hasText: label }).first();
    const warfare = card("Warfare");

    // Each time of day the mode actually has is its own count — dusk and morning are no longer
    // swept into "day", which is the whole point of the rebuild.
    const times = await warfare.locator(".mapset-env-name").allInnerTexts();
    for (const t of ["Day", "Night", "Dusk", "Morning"]) {
      assert.ok(times.some((x) => x.startsWith(t)), `Warfare offers a ${t} count, got ${JSON.stringify(times)}`);
    }
    // …and each one says how many maps could fill it, so an unfillable count is visible up front.
    assert.ok(times.some((x) => /Dusk\s*·\s*1/.test(x)), `the dusk row counts its maps, got ${JSON.stringify(times)}`);

    // The set's total is the sum across categories, not a per-bucket guess.
    assert.match(await page.locator(".panel", { hasText: "Vote setup" }).first().innerText(), /offers 6 maps/i);
    // The mode's own count is what reaches the poll; the per-time numbers are ceilings inside it.
    assert.equal(await warfare.locator('input[type="number"]').first().inputValue(), "4");
    assert.equal(await card("Offensive").locator('input[type="number"]').first().inputValue(), "2");

    // Maps stay behind the category's own disclosure, and are scoped to the times it asks for:
    // day (5) + night (3) = 8, with dusk and morning excluded because their counts are zero.
    assert.equal(await warfare.locator(".mapgrid").count(), 0, "the map list starts folded away");
    await warfare.locator(".mapset-maps-toggle").click();
    await page.waitForSelector(".mapgrid-tile", { timeout: 5_000 });
    assert.match(await warfare.innerText(), /8 fit the times above/);
    const names = await warfare.locator(".mapgrid-name").allInnerTexts();
    assert.ok(names.length > 0);
    for (const n of names) assert.ok(!/_/.test(n), `"${n}" is a human name, not a raw id`);
    assert.ok(!names.some((n) => /dusk|morning/i.test(n)), `no map for a time nobody asked for, got ${JSON.stringify(names)}`);

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("an older day/night set keeps working and offers to convert without changing what it offers", { skip: SKIP }, async () => {
  // Every set saved before this existed still composes through the old buckets, so the editor must
  // not pretend otherwise — it states the real total and offers the conversion rather than doing it.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/servers/s1/mapvote/config": { body: MODE_CFG({
      dayCount: 3, nightCount: 1, wildcardCount: 2, battleModes: ["warfare"], wildcardModes: ["offensive"],
    }) } },
  }, async (page, { errors }) => {
    await openLibrary(page, "Manage map sets", "default");
    await page.waitForSelector(".callout", { timeout: 10_000 });

    const panel = page.locator(".panel", { hasText: "Vote setup" }).first();
    assert.match(await panel.innerText(), /older day\/night\/wildcard buckets/);
    assert.match(await panel.innerText(), /offers 6 maps/, "the legacy total is what it really offers");
    assert.equal(await page.locator(".mapset-envs").count(), 0, "no mode categories until it is converted");

    await panel.locator("button", { hasText: "Convert this set" }).first().click();
    await page.waitForSelector(".mapset-envs", { timeout: 5_000 });

    // Same six maps a vote, now said per mode: 3 Warfare day + 1 Warfare night + 2 Offensive.
    assert.match(await panel.innerText(), /offers 6 maps/, "converting does not change what the set offers");
    const warfare = page.locator(".mapset-bucket").filter({ hasText: "Warfare" }).first();
    assert.equal(await warfare.locator('input[type="number"]').first().inputValue(), "4", "3 day + 1 night");
    assert.equal(await page.locator(".mapset-bucket").filter({ hasText: "Offensive" }).first().locator('input[type="number"]').first().inputValue(), "2");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A screen that re-fetches when you change a filter has to ignore the answer to the question you
 * are no longer asking. Two clicks is all it takes: pick one column, pick another before the first
 * lands, and the slow first response arrives last and fills the table — while the control still
 * says the second. The data on screen then belongs to a different query than the one named above
 * it, with nothing to indicate that.
 */
test("a slow response for the previous sort never paints over the one you picked", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      // Same path, different answers per query: the board you leave is slow and carries a marker
      // row; the board you land on is instant.
      "/api/leaderboard": (url) =>
        url.searchParams.get("sort") === "teamkills"
          ? { delayMs: 1500, body: { leaderboard: [{ playerId: "x", name: "STALE-BOARD", platform: "steam", kills: 1, deaths: 1, teamkills: 99, kd: 1 }] } }
          : { body: { leaderboard: [{ playerId: "y", name: "FRESH-BOARD", platform: "steam", kills: 5, deaths: 1, teamkills: 0, kd: 5 }] } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/leaderboard`, { waitUntil: "networkidle" });
    await page.waitForSelector(".inline-select", { timeout: 15000 });

    // Ask for the slow board, then immediately change your mind.
    await page.locator(".inline-select").selectOption("teamkills");
    await page.locator(".inline-select").selectOption("kills");

    // Well past the slow response's arrival: it must have been discarded, not rendered.
    await page.waitForTimeout(2500);
    const text = await page.locator("table").innerText();
    assert.ok(text.includes("FRESH-BOARD"), `the board you picked is shown: ${text}`);
    assert.ok(!text.includes("STALE-BOARD"), `the board you left must NOT arrive late and win: ${text}`);
    assert.equal(await page.locator(".inline-select").inputValue(), "kills");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the leaderboard can rank support and squad-leader time, not only kills", { skip: SKIP }, async () => {
  // The API used to accept any sort and answer every one of them with the kill board, because the
  // route's whitelist was four names written out by hand. So this checks BOTH ends: that the panel
  // asks for the column, and that the column it asked for is what came back.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      // A function of the URL, so each sort returns a genuinely different order — exactly what a
      // hardcoded whitelist silently failed to do.
      "/api/leaderboard": (url) => {
        const sort = url.searchParams.get("sort") ?? "kills";
        const key = sort === "playtime" ? "playtime" : sort;
        const rows = [...SCORE_ROWS].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
        return { body: { sort, leaderboard: rows } };
      },
    },
  }, async (page, { errors, stub }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/leaderboard`, { waitUntil: "networkidle" });
    await page.waitForSelector("table tbody tr", { timeout: 15_000 });

    // Default board: the fragger leads, and the columns are the combat-log ones.
    assert.match(await page.locator("table tbody tr").first().innerText(), /Fragger/);

    // Rank by support instead. The people who actually keep a team supplied come first.
    await page.selectOption('select[aria-label="Rank by"]', "support");
    await page.waitForFunction(
      () => /Quartermaster/.test(window.document.querySelector("table tbody tr")?.textContent ?? ""),
      null,
      { timeout: 15_000 },
    );
    assert.ok(stub.requests.some((p) => p === "/api/leaderboard"), "the board is served by the API, not sorted client-side");

    // The ranked column has to be ON SCREEN — a board that hides what it sorted by is one you have
    // to take on trust.
    const head = await page.locator("table thead").innerText();
    assert.match(head, /support/i, `support column missing from header: ${head}`);

    // And squad-leader time, which is a duration and must not print as a raw second count.
    await page.selectOption('select[aria-label="Rank by"]', "slSeconds");
    await page.waitForFunction(
      () => /Squad-leader time/i.test(window.document.querySelector("table thead")?.textContent ?? ""),
      null,
      { timeout: 15_000 },
    );
    const body = await page.locator("table tbody").innerText();
    assert.match(body, /\d+h/, `squad-leader time should read as hours, got: ${body.slice(0, 200)}`);
    assert.doesNotMatch(body, /18,?000/, "a duration must not be printed as a raw second count");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Field report, with screenshots: on the VIP list a group member's permanent and a player's own
 * read the same — both "PERMANENT", the members with a "GROUP PERK" badge that named no group — and
 * nothing said how much of anyone's VIP was on hold. A member now wears the group's name in green,
 * and time on hold shows in red under the status: their own VIP paused beneath the group's, and a
 * VIP timeout's banked time (or that a running one's clock keeps going).
 */
test("VIP list: group members wear the group's name in green; paused time shows in red", { skip: SKIP }, async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const at = "2026-01-01T00:00:00.000Z";
  const row = (playerId, playerName, extra = {}) => ({
    id: `v-${playerId}`, serverId: "s1", playerId, playerName, comment: "", expiration: null,
    pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null, groupHold: null,
    createdByName: "tester", createdAt: at, updatedAt: at, ...extra,
  });
  const hold = (bankedMs) => ({ since: at, bankedMs, groups: [{ id: "g1", name: "WW2 CVC", severanceMinutes: 0 }] });
  const vips = [
    row("p1", "OWN PERM"),
    row("p2", "HELD BANKED", { groupHold: hold(29 * 86_400_000) }),
    row("p3", "HELD NOTHING", { groupHold: hold(0) }),
    // A banked timeout froze the time left when it began: three days.
    row("p4", "TIMEOUT BANKED", { expiration: iso(now + 2 * 86_400_000), pausedAt: iso(now - 86_400_000), pausedUntil: iso(now + 86_400_000), pauseMode: "banked", pauseReason: "toxic", pausedBy: "KREITZ" }),
    row("p5", "TIMEOUT RUNNING", { expiration: iso(now + 5 * 86_400_000), pausedAt: iso(now - 3_600_000), pausedUntil: iso(now + 86_400_000), pauseMode: "running" }),
    row("p6", "TIMEOUT OVER", { expiration: iso(now + 5 * 86_400_000), pausedAt: iso(now - 3 * 86_400_000), pausedUntil: iso(now - 86_400_000), pauseMode: "banked" }),
    // In the group with a permanent of their own, which the perk never takes over: shown as the
    // group's, with that permanent paused beneath it.
    row("p7", "OWN UNDER GROUP", { perkGroups: [{ id: "g1", name: "WW2 CVC" }] }),
    // In the group with dated VIP the perk is not holding yet (it starts at its next check): their
    // own clock, as is.
    row("p8", "DATED MEMBER", { expiration: iso(now + 9 * 86_400_000), perkGroups: [{ id: "g1", name: "WW2 CVC" }] }),
    // VIP timeouts on a permanent — their own, the group's, and their own beneath the group's.
    row("p9", "PERMA BANKED", { pausedAt: iso(now - 3_600_000), pausedUntil: iso(now + 86_400_000), pauseMode: "banked" }),
    row("p10", "PERMA RUNNING", { pausedAt: iso(now - 3_600_000), pausedUntil: iso(now + 86_400_000), pauseMode: "running" }),
    row("p11", "HELD PAUSED", { groupHold: hold(0), pausedAt: iso(now - 3_600_000), pausedUntil: iso(now + 86_400_000), pauseMode: "banked" }),
    row("p12", "MEMBER PAUSED", { perkGroups: [{ id: "g1", name: "WW2 CVC" }], pausedAt: iso(now - 3_600_000), pausedUntil: iso(now + 86_400_000), pauseMode: "running" }),
  ];
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: { "/api/servers/s1/vips": { body: { vips } } },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    const rowOf = (name) => page.locator("tr", { hasText: name });
    await rowOf("TIMEOUT OVER").waitFor({ timeout: 15_000 });
    const tokenColor = (token) => page.evaluate((t) => {
      const el = window.document.createElement("span");
      el.style.color = `var(${t})`;
      window.document.body.appendChild(el);
      const c = window.getComputedStyle(el).color;
      el.remove();
      return c;
    }, token);
    const green = await tokenColor("--ok");
    const red = await tokenColor("--err");
    const colorOf = (loc) => loc.evaluate((el) => window.getComputedStyle(el).color);

    // A group member: the group's name in green — in place of "Permanent", which is VIP of their
    // own — and their own paused time in red beneath.
    const held = rowOf("HELD BANKED");
    const statusOf = (r) => r.locator("td").nth(2).innerText();
    assert.equal((await held.locator(".badge.ok").textContent()).trim(), "WW2 CVC");
    assert.doesNotMatch(await statusOf(held), /permanent/i, "a group member's status does not also say Permanent");
    assert.doesNotMatch(await statusOf(rowOf("HELD NOTHING")), /permanent/i);
    assert.match(await statusOf(rowOf("OWN PERM")), /permanent/i, "VIP of their own still says Permanent");
    assert.equal(await colorOf(held.locator(".badge.ok")), green, "the group badge is green");
    assert.equal((await held.locator(".vip-paused").textContent()).trim(), "29 days paused");
    assert.equal(await colorOf(held.locator(".vip-paused")), red, "paused time is red");
    assert.doesNotMatch(await page.locator("table").first().innerText(), /group perk/i, "no badge that names no group");

    // Nothing of their own beneath the group: the badge, and no paused line.
    assert.equal(await rowOf("HELD NOTHING").locator(".badge.ok").count(), 1);
    assert.equal(await rowOf("HELD NOTHING").locator(".vip-paused").count(), 0);

    // A permanent of their own: neither.
    assert.equal(await rowOf("OWN PERM").locator(".badge.ok").count(), 0, "their own permanent wears no group badge");
    assert.equal(await rowOf("OWN PERM").locator(".vip-paused").count(), 0);

    // VIP timeouts: the banked time left, or that the clock runs on — in red too.
    const banked = rowOf("TIMEOUT BANKED").locator(".vip-paused");
    assert.match(await banked.textContent(), /^3 days paused until \S/);
    assert.equal(await colorOf(banked), red);
    assert.match(await rowOf("TIMEOUT RUNNING").locator(".vip-paused").textContent(), /^Paused until .+ · time running$/);
    assert.equal(await rowOf("TIMEOUT OVER").locator(".vip-paused").count(), 0, "a timeout that has ended shows nothing");
    // A timeout on a permanent: no time runs on a permanent, so banked or running the line is the
    // same, starting with a capital like every other. Under a green badge the badge, or the line
    // above, already says whose permanent it is: "Permanent paused" again would read as their own
    // permanent on the group's, and as the same thing twice on a permanent of their own.
    const timeoutLines = (name) => rowOf(name).locator(".vip-paused").allTextContents().then((t) => t.map((x) => x.trim()));
    assert.match((await timeoutLines("PERMA BANKED")).join("|"), /^Permanent paused until [^·|]+$/);
    assert.match((await timeoutLines("PERMA RUNNING")).join("|"), /^Permanent paused until [^·|]+$/, "no time runs on a permanent");
    assert.match((await timeoutLines("HELD PAUSED")).join("|"), /^Paused until [^·|]+$/, "the group's permanent is not their own");
    const memberLines = await timeoutLines("MEMBER PAUSED");
    assert.equal(memberLines.length, 2);
    assert.equal(memberLines[0], "Permanent paused");
    assert.match(memberLines[1], /^Paused until [^·]+$/, "Permanent paused is said once");

    // A member whose permanent is their own: the group's badge, and "Permanent paused" in red.
    const ownUnder = rowOf("OWN UNDER GROUP");
    assert.equal((await ownUnder.locator("button.badge.ok").textContent()).trim(), "WW2 CVC");
    assert.equal(await ownUnder.locator(".badge.active").count(), 0, "no Permanent status badge beside the group's");
    assert.equal((await ownUnder.locator(".vip-paused").textContent()).trim(), "Permanent paused");
    assert.equal(await colorOf(ownUnder.locator(".vip-paused")), red);
    assert.equal(await rowOf("OWN PERM").locator(".badge.active").count(), 1, "outside any VIP group, Permanent stays");
    // A member's dated VIP the perk is not holding keeps its own clock: no group badge, nothing paused.
    assert.equal(await rowOf("DATED MEMBER").locator(".badge.ok").count(), 0);
    assert.equal(await rowOf("DATED MEMBER").locator(".vip-paused").count(), 0);
    // Revoke on it says what it ends: their own permanent, with the group's VIP taking over.
    await ownUnder.locator("button", { hasText: "Revoke" }).click();
    const ask = page.locator(".confirm-modal", { hasText: "Revoke OWN UNDER GROUP's own permanent VIP?" });
    await ask.waitFor({ timeout: 5_000 });
    assert.match(await ask.innerText(), /whose perk gives them VIP while they are on its list/);
    await ask.locator("button", { hasText: "Cancel" }).click();
    await ask.waitFor({ state: "detached" });

    // The green badge stands where the status did, so it opens the profile as the status does.
    await held.locator("button.badge.ok").click();
    await page.waitForFunction(() => /p2/.test(window.location.hash), null, { timeout: 5_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The Bans screen with nothing on record points people at where game-server bans are, by the name
 * the screen gives that list. It named an "On the server" list the screen does not have: the
 * switch reads Platform and Live.
 */
test("the empty Bans list points at a list the screen has", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/moderation/bans`, { waitUntil: "networkidle" });
    const empty = page.locator(".empty-state", { hasText: "No bans on record" });
    await empty.waitFor();
    const named = (await empty.locator("strong").allTextContents()).map((t) => t.trim());
    assert.ok(named.length > 0, "it names the list");
    for (const name of named) {
      assert.equal(await page.locator(".seg-btn", { hasText: new RegExp(`^${name}$`) }).count(), 1, `"${name}" is a list on the screen's switch`);
    }
  });
});

/*
 * The empty watchlist says how to add someone, by the name the control has. It said to use
 * "Watch" on a profile, and a profile has no "Watch": it is "Add to watchlist", in its ⋯ menu.
 */
test("the empty watchlist names the control that adds someone", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/players/flagged": { body: { flags: [] } } } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/directory`, { waitUntil: "networkidle" });
    await page.locator(".seg-btn", { hasText: /^Watchlist$/ }).click();
    const empty = page.locator(".empty-state", { hasText: "Nobody is being watched" });
    await empty.waitFor();
    const named = (await empty.locator("strong").allTextContents()).map((t) => t.trim());
    assert.ok(named.length > 0, "it names the control");
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.locator("button.pa-more").click();
    for (const name of named) {
      // The item's whole label (after its icon), exactly: a substring would find "watch" in anything.
      const label = new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      assert.equal(await page.locator(".pa-dropdown .pa-mi", { hasText: label }).count(), 1, `the profile's ⋯ menu has "${name}"`);
    }
  });
});

/*
 * Auto settings drew its form before the server's settings came in: "Off" and "No profiles yet"
 * while they loaded, and the last server's profiles after a switch — with Save there to press,
 * which would have written either over the server's real profiles.
 */
test("Auto settings shows no form to save until the server's own settings are in", { skip: SKIP }, async () => {
  const servers = [{ id: "s1", name: "One", game: "hll", engagementMode: "active" }, { id: "s2", name: "Two", game: "hll", engagementMode: "active" }];
  const config = (name) => ({ delayMs: 2_500, body: { config: { enabled: true, dryRun: false, timezone: "UTC", profiles: [{ name, spec: {}, settings: {} }] }, fields: [] } });
  const onScreen = async (page) => ({
    text: await page.locator(".content").innerText(),
    names: await page.locator(".content input").evaluateAll((els) => els.map((el) => el.value)),
    save: await page.locator(".content").getByRole("button", { name: "Save", exact: true }).count(),
  });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers": { body: { servers } },
    "/api/servers/s1/autosettings": config("Night on One"),
    "/api/servers/s2/autosettings": config("Night on Two"),
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/settings`, { waitUntil: "load" });
    await page.locator(".hub-tabs").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);
    let now = await onScreen(page);
    assert.doesNotMatch(now.text, /No profiles yet/, "not empty: still coming");
    assert.equal(now.save, 0, "nothing to save yet");
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "Night on One"), null, { timeout: 10_000 });

    // Another server: the last one's profiles go until this one's are in.
    await page.locator(".server-switcher select").selectOption("s2");
    await page.waitForTimeout(600);
    now = await onScreen(page);
    assert.ok(!now.names.includes("Night on One"), "One's profiles are not shown as Two's");
    assert.equal(now.save, 0, "nothing to save yet");
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "Night on Two"), null, { timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // A failed read: it says so, with no form to save.
  const failed = { status: 500, body: { error: { code: "internal", message: "The auto settings could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/autosettings": failed } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/settings`, { waitUntil: "networkidle" });
    await page.locator(".error", { hasText: "The auto settings could not be read." }).waitFor({ timeout: 10_000 });
    const now = await onScreen(page);
    assert.doesNotMatch(now.text, /No profiles yet/);
    assert.equal(now.save, 0, "no form to save");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The greeting goes to each player who joins while the server seeds, once per join; a phase change
 * tells nobody again. The tab used to say the opposite of both.
 */
test("the Seeding tab says who hears the greeting, and that a phase change re-greets nobody", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/seeding": seedingReply(41) } }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/seeding`, { waitUntil: "networkidle" });
    await page.getByLabel("Message for each player who joins while seeding").waitFor({ timeout: 10_000 });
    assert.doesNotMatch(await page.locator(".panel", { hasText: "Phase stability" }).textContent() ?? "", /greet/, "a phase change greets nobody again");
  });
});

/*
 * The team on Staff activity is the staff profiles permission; the trail beneath it is the audit
 * trail. A moderator holds the trail alone, and was told "No staff actions recorded yet" above a
 * trail listing them: the refused list read as an empty one. A list that failed said the same.
 */
test("Staff activity: the team shows with Staff profiles, the trail keeps its server picker, and a team not read is not an empty one", { skip: SKIP }, async () => {
  const servers = { "/api/servers": { body: { servers: TWO_OF_ONE_GAME } } };
  const trail = { body: { entries: [{ id: "a1", actorName: "owner", action: "user.create", summary: "TRAIL-ENTRY", ts: "2026-10-20T20:00:00Z", targetType: null, targetId: null, targetName: null, serverId: null }], total: 1 } };
  const open = async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/activity`, { waitUntil: "networkidle" });
    await page.locator("text=TRAIL-ENTRY").first().waitFor({ timeout: 10_000 });
  };
  const trailPanel = (page) => page.locator(".panel").filter({ has: panelTitled(page, "Trail") });

  await withPage({ grants: [held("server.view", "read"), held("audit.trail", "read")], overrides: { ...servers, "/api/audit": trail } }, async (page, { stub, errors }) => {
    await open(page);
    assert.equal(await panelTitled(page, "The team").count(), 0, "no team without Staff profiles");
    assert.doesNotMatch(await page.locator(".content").innerText(), /No staff actions recorded yet/, "no false empty team");
    assert.ok(!stub.calls.some((c) => c.path === "/api/audit/staff"), "the team is not asked for");
    // The server picker narrows the trail, from the trail.
    const picked = page.waitForRequest((r) => r.url().includes("/api/audit?") && r.url().includes("serverId=s2"), { timeout: 10_000 });
    await trailPanel(page).locator(".scope-select").selectOption("s2");
    await picked;
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  await withPage({ grants: OWNER_GRANTS, overrides: { ...servers, "/api/audit": trail } }, async (page, { errors }) => {
    await open(page);
    await page.locator(".staff-card", { hasText: "yeti" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".scope-select").count(), 1, "one picker, on the team");
    assert.equal(await trailPanel(page).locator(".scope-select").count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  const failed = { status: 500, body: { error: { code: "internal", message: "The team could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { ...servers, "/api/audit": trail, "/api/audit/staff": failed } }, async (page) => {
    await open(page);
    const team = page.locator(".panel").filter({ has: panelTitled(page, "The team") });
    await team.locator(".error", { hasText: "Couldn't load the team" }).waitFor({ timeout: 10_000 });
    assert.doesNotMatch(await team.innerText(), /No staff actions recorded yet/, "a failed team is not an empty one");
  });
});

/*
 * An action in the trail opens in a window of its own: pressed by its name, or anywhere on its row
 * but a link of its own. It says what the action changed, setting by setting — where each sits,
 * what it was and what it became — then the rest of what its record keeps. A staff member's
 * Actions open it the same way. A staff action read "updated auto settings for VIETNAM — 2
 * profile(s)", and nothing said which profile, or which setting, had changed.
 */
test("an action pressed in the trail, or in a staff member's Actions, opens what it changed, setting by setting", { skip: SKIP }, async () => {
  const entry = { id: "a7", ts: "2026-10-24T18:05:00.000Z", actorUserId: "u2", actorName: "yeti", action: "autosettings.config", targetType: "server", targetId: "s1", targetName: "Server #1", serverId: "s1", summary: "TRAIL-ENTRY" };
  const detail = { body: { entry, changes: { basis: "recorded", items: [
    { where: ["Profile “Night”", "When", "Total players are below"], before: "40", after: "50" },
    { where: ["Profile “Day”", "Vote kick"], before: null, after: "off" },
    { where: ["Profile “Old”", "Idle kick (minutes)"], before: "10", after: null },
  ] }, details: [{ label: "Kept until", value: "2026-11-24T19:40:00.000Z" }] } };
  const overrides = {
    "/api/audit": { body: { entries: [entry], total: 1 } },
    "/api/audit/a7": detail,
    "/api/audit/staff/u2": { body: { user: { id: "u2", username: "yeti", createdAt: "2026-02-01T00:00:00.000Z" }, actorName: "yeti", analytics: {
      total: 1, firstAt: entry.ts, lastAt: entry.ts, byAction: {}, topTargets: [], topServers: [], daily: [],
      byCategory: { bans: 0, kicks: 0, vips: 0, messages: 0, moves: 0, punishments: 0, requests: 0, other: 1 } } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    const dialog = page.getByRole("dialog", { name: "Action details" });
    const lines = async () => (await dialog.locator(".audit-changes li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    const WHAT_CHANGED = [
      "Profile “Night” › When › Total players are below 40 → 50",
      "Profile “Day” › Vote kick added: off",
      "Profile “Old” › Idle kick (minutes) removed: 10",
    ];
    await page.goto(`${page.url().split("#")[0]}#/admin/activity`, { waitUntil: "networkidle" });
    const trail = page.locator(".panel").filter({ has: panelTitled(page, "Trail") });
    await trail.locator("text=TRAIL-ENTRY").waitFor({ timeout: 10_000 });
    assert.equal(await dialog.count(), 0, "nothing open until an action is pressed");

    // By the action's name.
    await trail.getByRole("button", { name: "autosettings.config" }).click();
    await dialog.locator(".audit-changes li").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await lines(), WHAT_CHANGED, "each setting by where it sits, with what it was and what it became");
    await dialog.getByRole("heading", { name: "What changed" }).waitFor();
    const facts = (await dialog.locator(".mod-facts").first().innerText()).replace(/\s+/g, " ");
    assert.match(facts, /Who yeti/, "who did it");
    assert.match(facts, /To Server #1/, "what it was done to");
    assert.doesNotMatch(facts, /Server Test Server #1/, "a server it was done to is not named again as the server it was done on");
    const details = dialog.locator(".audit-part", { has: page.getByRole("heading", { name: "Details" }) });
    assert.match(await details.innerText(), /Kept until/, "the rest of the record under Details");
    assert.doesNotMatch(await details.innerText(), /2026-11-24T19:40/, "a date as people read it, not as the record keeps it");
    assert.deepEqual(stub.calls.filter((c) => c.path === "/api/audit/a7").map((c) => c.method), ["GET"], "read once, by its id");
    await dialog.getByRole("button", { name: "Close" }).click();
    await dialog.waitFor({ state: "detached" });

    // Anywhere on the row: its summary.
    await trail.locator("td", { hasText: "TRAIL-ENTRY" }).click();
    await dialog.locator(".audit-changes li").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await lines(), WHAT_CHANGED);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // A link of the row's own goes where it goes, and opens nothing.
    await trail.locator("button.player-link", { hasText: "yeti" }).click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/staff/"), null, { timeout: 10_000 });
    assert.equal(await dialog.count(), 0, "the staff member's page, not the action");

    // Their Actions open it the same way.
    await page.click("button.viz-toggle:text-is('Actions')");
    const actions = page.locator(".panel").filter({ has: panelTitled(page, "Actions") });
    await actions.getByRole("button", { name: "autosettings.config" }).click();
    await dialog.locator(".audit-changes li").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await lines(), WHAT_CHANGED);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await actions.locator("td", { hasText: "TRAIL-ENTRY" }).click();
    await dialog.locator(".audit-changes li").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // An older save of a setting not kept the way it is now: what it set, and why there is nothing to
  // compare it with. One the reader may not open says so, with nothing else. (One done to a player
  // names the server it was done on.)
  const toPlayer = { ...entry, targetType: "player", targetId: "p2", targetName: "Kestrel" };
  const set = { body: { entry: toPlayer, changes: { basis: "set", note: "NO-EARLIER-SAVE", items: [{ where: ["Profile “Night”", "Auto-balance"], before: null, after: "on" }] }, details: [] } };
  const missing = { status: 404, body: { error: { code: "not_found", message: "no such entry in the trail" } } };
  for (const [what, answer] of [["set", set], ["missing", missing]]) {
    await withPage({ grants: OWNER_GRANTS, overrides: { "/api/audit": overrides["/api/audit"], "/api/audit/a7": answer } }, async (page, { errors }) => {
      await page.goto(`${page.url().split("#")[0]}#/admin/activity`, { waitUntil: "networkidle" });
      const dialog = page.getByRole("dialog", { name: "Action details" });
      await page.getByRole("button", { name: "autosettings.config" }).click();
      if (what === "set") {
        await dialog.getByRole("heading", { name: "What it set" }).waitFor({ timeout: 10_000 });
        await dialog.getByText("NO-EARLIER-SAVE").waitFor();
        assert.deepEqual((await dialog.locator(".audit-changes li").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["Profile “Night” › Auto-balance on"], "what it set, no added: or arrow");
        assert.match((await dialog.locator(".mod-facts").first().innerText()).replace(/\s+/g, " "), /Server Test Server #1/, "the server it was done on");
      } else {
        await dialog.locator(".error", { hasText: "no such entry in the trail" }).waitFor({ timeout: 10_000 });
        assert.equal(await dialog.locator(".audit-changes, .mod-facts").count(), 0, "nothing else");
      }
      assert.deepEqual(errors, [], `${what}: no uncaught page errors`);
    });
  }
});

test("Seeding: the reward and its payouts show only with Seeding rewards on that server", { skip: SKIP }, async () => {
  const reward = ["rewardEnabled", "rewardHours", "rewardPoints", "rewardLinkedNote", "rewardUnlinkedNote", "minSeedMinutes", "rewardCumulative", "rewardMessage", "rewardDelaySec"];
  const full = seedingReply(41);
  // As the API answers a reader without the reward: the config with none of it.
  const without = { body: { ...full.body, config: Object.fromEntries(Object.entries(full.body.config).filter(([k]) => !reward.includes(k))) } };
  const open = async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/seeding`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "41"), null, { timeout: 10_000 });
  };
  for (const [what, grants] of [
    ["seeding alone", [held("server.view", "read"), held("seeding.config")]],
    ["the reward on another server", [held("server.view", "read"), held("seeding.config"), held("seeding.rewards", "write", "s2")]],
  ]) {
    await withPage({ grants, overrides: { "/api/servers/s1/seeding": without } }, async (page, { stub, errors }) => {
      await open(page);
      assert.equal(await panelTitled(page, "Seed reward").count(), 0, `${what}: no reward panel`);
      assert.equal(await panelTitled(page, "Recent seed payouts").count(), 0, `${what}: no payouts`);
      assert.ok(!stub.calls.some((c) => c.path.endsWith("/seeding/payouts")), `${what}: the receipts are not read`);
      await page.getByLabel("Seed target (players to go live)").fill("42");
      const saved = page.waitForResponse((r) => r.url().endsWith("/api/servers/s1/seeding") && r.request().method() === "PUT");
      await page.getByRole("button", { name: "Save seeding config" }).click();
      await saved;
      const sent = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/servers/s1/seeding")?.body ?? {};
      assert.ok(!Object.keys(sent).some((k) => k.startsWith("reward") || k === "minSeedMinutes"), `${what}: a save sends none of the reward: ${Object.keys(sent).join(", ")}`);
      assert.deepEqual(errors, [], "no uncaught page errors");
    });
  }
  await withPage({ grants: [held("server.view", "read"), held("seeding.config"), held("seeding.rewards", "read", "s1")], overrides: { "/api/servers/s1/seeding": full } }, async (page, { stub }) => {
    await open(page);
    await panelTitled(page, "Seed reward").first().waitFor({ timeout: 10_000 });
    assert.equal(await panelTitled(page, "Recent seed payouts").count(), 1);
    await page.waitForRequest((r) => r.url().includes("/api/servers/s1/seeding/payouts"), { timeout: 10_000 }).catch(() => null);
    assert.ok(stub.calls.some((c) => c.path === "/api/servers/s1/seeding/payouts"), "the receipts are read where they are shown");
  });
});

/*
 * The same standard on the Bans list. An Unban that failed wrote "Unban failed: …" in the note line
 * above the list — and so did one filed for approval, which had not failed at all. A partial lift,
 * the dangerous outcome (the player looks fixed and is still barred somewhere), went there too.
 */
test("Bans: an Unban that fails or lifts only part says so in a popup; one filed for approval keeps the note line", { skip: SKIP }, async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const ban = (id, playerId, playerName, serverIds) => ({
    id, ts: at, by: "tester", playerName, playerId, platform: "steam", type: "perma", reason: "griefing", category: null,
    scope: { mode: "servers", serverIds }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null,
    active: true, auto: false, serverIds,
  });
  let unbans = 0;
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
        { id: "s2", name: "WW2 #2", game: "hll", engagementMode: "active" },
      ] } },
      "/api/bans": { body: { bans: [
        ban("b1", "76561198000000101", "AA FAIL", ["s1"]),
        ban("b2", "76561198000000102", "BB PART", ["s1", "s2"]),
        ban("b3", "76561198000000103", "CC FILED", ["s1"]),
      ] } },
      // The three unbans in the order they are pressed: refused, half done, filed for approval.
      "/api/servers/s1/actions": () => [
        { status: 409, body: { error: { code: "conflict", message: "the server refused: no such ban" } } },
        { body: { results: [{ serverName: "WW2 #1", ok: true }, { serverName: "WW2 #2", ok: false, error: "RCON timed out" }], applied: 1 } },
        { status: 202, body: { requested: true, label: "Lift ban" } },
      ][unbans++],
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "networkidle" });
    const unbanOn = (name) => page.locator("tr", { hasText: name }).locator("button", { hasText: "Unban" });
    await unbanOn("CC FILED").waitFor({ timeout: 15_000 });

    await unbanOn("AA FAIL").click();
    await page.locator(".confirm-modal button", { hasText: "Remove" }).click();
    const refused = page.locator(".confirm-modal", { hasText: "Couldn't remove the ban on AA FAIL" });
    await refused.waitFor({ timeout: 5_000 });
    assert.match(await refused.innerText(), /the server refused: no such ban/);
    assert.ok(await inFront(refused, 844), "nothing covers the dialog");
    assert.doesNotMatch(await page.locator("body").innerText(), /Unban failed/);
    await refused.locator("button", { hasText: "OK" }).click();
    await refused.waitFor({ state: "detached" });

    await unbanOn("BB PART").click();
    await page.locator(".confirm-modal button", { hasText: "Remove" }).click();
    const partial = page.locator(".confirm-modal", { hasText: "BB PART is still banned on WW2 #2" });
    await partial.waitFor({ timeout: 5_000 });
    assert.match(await partial.innerText(), /Unbanned on 1 of 2 servers\. RCON timed out/);
    assert.ok(await inFront(partial, 844), "nothing covers the dialog");
    await partial.locator("button", { hasText: "OK" }).click();
    await partial.waitFor({ state: "detached" });

    await unbanOn("CC FILED").click();
    await page.locator(".confirm-modal button", { hasText: "Remove" }).click();
    await page.locator("p.muted", { hasText: "Sent for approval" }).waitFor({ timeout: 5_000 });
    assert.equal(await page.locator(".confirm-modal").count(), 0, "no popup for a filed request");
    assert.doesNotMatch(await page.locator("body").innerText(), /Unban failed/, "filed is not failed");
    assert.equal(unbans, 3);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a round's scoreboard carries its score columns, and omits them when it has none", { skip: SKIP }, async () => {
  const match = {
    id: "m1", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
    startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:40:00.000Z",
    winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)",
    sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
  };
  const scored = [
    { matchId: "m1", playerId: "p1", playerName: "Fragger", side: "allies", kills: 42, deaths: 12, teamkills: 0, combat: 310, offense: 40, defense: 20, support: 10, slSeconds: 0 },
    { matchId: "m1", playerId: "p2", playerName: "Anchor", side: "allies", kills: 8, deaths: 15, teamkills: 0, combat: 60, offense: 20, defense: 640, support: 210, slSeconds: 2400 },
  ];

  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/matches/m1": { body: { match, stats: scored } } } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 15_000 });
    // Headers are uppercased by CSS, so compare on the text, not its casing.
    const head = (await page.locator("table.scoreboard thead").innerText()).toLowerCase();
    for (const col of ["combat", "off", "def", "sup", "sl time"]) {
      assert.ok(head.includes(col), `scoreboard is missing the ${col} column: ${JSON.stringify(head)}`);
    }
    const body = await page.locator("table.scoreboard tbody").innerText();
    assert.match(body, /640/, "the defense score of the round must be on the row");
    assert.match(body, /40m/, "squad-leader time in a round reads as a duration");
  });

  // A round imported from a kill log has no score buckets. Five empty columns on every historic
  // round would be worse than not offering them.
  const bare = scored.map((s) => ({ matchId: s.matchId, playerId: s.playerId, playerName: s.playerName, side: s.side, kills: s.kills, deaths: s.deaths, teamkills: s.teamkills }));
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/matches/m1": { body: { match, stats: bare } } } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 15_000 });
    const head = (await page.locator("table.scoreboard thead").innerText()).toLowerCase();
    assert.ok(!head.includes("sl time"), `score columns must be absent on a round without scores: ${head}`);
    assert.ok(head.includes("kills"), "the kill columns are still there");
  });
});

/*
 * Two people can wear the same display name in one round. The staff page knows them apart — it
 * holds their internal ids — so the kill race must draw two separate lines rather than keying its
 * paths by the label they share and losing one of them behind the other.
 */
test("the kill race draws a line each for two players wearing one name", { skip: SKIP }, async () => {
  const match = {
    id: "m1", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
    startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:40:00.000Z",
    winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)",
    sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
  };
  const st = (playerId, playerName, side, kills) => ({
    matchId: "m1", playerId, playerName, side, kills, deaths: 3, teamkills: 0,
    combat: 100, offense: 0, defense: 0, support: 0, slSeconds: 0,
  });
  const detail = (side, kills, from) => ({
    side, timeline: Array.from({ length: kills }, (_, i) => [from + i * 25, "k", "X", "M1 GARAND"]),
    killsStreak: kills, deathsWithoutKillStreak: 1, longestLifeSecs: 200, shortestLifeSecs: 10, deathsByTk: 0,
  });
  const body = {
    match,
    stats: [st("p1", "Nemesis", "allies", 9), st("p2", "Nemesis", "axis", 4), st("p3", "Solo", "allies", 6)],
    report: {
      complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [],
      timeline: [{ minute: 0, allies: 1, axis: 1 }], duels: [], awards: [],
      players: { p1: detail("allies", 9, 20), p2: detail("axis", 4, 30), p3: detail("allies", 6, 40) },
    },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/matches/m1": { body } } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    await page.waitForSelector('svg[aria-label="Every player\'s kills over the round"]', { timeout: 15_000 });
    const ds = await page.locator('svg[aria-label="Every player\'s kills over the round"] path').evaluateAll(
      (nodes) => nodes.map((n) => n.getAttribute("d")),
    );
    assert.equal(ds.length, 3, "three players with kills, three lines");
    assert.equal(new Set(ds).size, 3, "the two Nemeses get their own paths, not one path drawn twice");
  });
});

/*
 * Players on each side, minute by minute. A minute with no roster sample arrives as null and must
 * BREAK the line — drawn as 0 it would read as a side emptying out — and a round with no samples
 * says why instead of drawing empty axes.
 */
test("a round's players on each side draw minute by minute; a round with no roster samples says so", { skip: SKIP }, async () => {
  const match = {
    id: "m1", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
    startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:40:00.000Z",
    winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)",
    sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
  };
  const headcount = [
    { minute: 0, allies: 20, axis: 18 }, { minute: 1, allies: 24, axis: 22 }, { minute: 2, allies: 26, axis: 25 },
    { minute: 3, allies: null, axis: null },
    { minute: 4, allies: 31, axis: 30 }, { minute: 5, allies: 33, axis: 34 },
  ];
  const panelOf = (page) => page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Players on each side" }) });
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/matches/m1": { body: { match, stats: [], headcount } } } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    const panel = panelOf(page);
    await panel.locator("svg.viz-chart").waitFor({ timeout: 15_000 });
    // Two sides, each broken in two by the empty minute: four runs of line, not two.
    assert.equal(await panel.locator("svg.viz-chart polyline").count(), 4, "the minute with no sample breaks both lines");
    const legend = await panel.locator(".viz-legend").innerText();
    assert.match(legend, /Allies/);
    assert.match(legend, /Axis/);
    // The x axis says which minute — the labels are not left blank.
    const ticks = await panel.locator("svg.viz-chart text.tick").allTextContents();
    assert.ok(ticks.includes("5m"), `the last minute is labelled: ${JSON.stringify(ticks)}`);
    assert.equal(await panel.locator(".notice").count(), 0);
  });
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/matches/m1": { body: { match, stats: [], headcount: [] } } } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    const panel = panelOf(page);
    await panel.waitFor({ timeout: 15_000 });
    assert.match(await panel.locator(".notice").innerText(), /No roster samples for this round/);
    assert.equal(await panel.locator("svg").count(), 0, "no empty axes");
  });
});

test("the game log, a round, a profile's lists and the map vote tables come back as they were left", { skip: SKIP }, async () => {
  /*
   * The rest of "visiting a profile and going back resets things": the game log came back on page
   * one; a round came back with every scoreboard row shut, each drill-in on its kills chart and the
   * kill race back on kills, unsearched; a profile's VIP history and map votes went back to their
   * first page; the map vote tables too. Each is left in a state of its own, taken away and brought
   * back, and must come back as it was.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const asked = { events: [] };
  const logRows = Array.from({ length: 120 }, (_, i) => ({
    id: `e${i}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 120 - i)).toISOString(), kind: "evt.kill", actorName: `p${i}`, victimName: "v", weapon: "M1",
  }));
  const racer = (side, scores) => ({
    side, weapons: [], deathByWeapons: [], mostKilled: [], deathBy: [], timeline: [[30, "k", "X", "M1 GARAND"], [90, "k", "Y", "M1 GARAND"]],
    killsStreak: 2, deathsWithoutKillStreak: 0, longestLifeSecs: 60, shortestLifeSecs: 20, deathsByTk: 0, scores,
  });
  const round = {
    match: {
      id: "m1", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
      startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:40:00.000Z",
      winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)",
      sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
    },
    stats: [
      { matchId: "m1", playerId: "p1", playerName: "Arty", side: "allies", kills: 2, deaths: 0, teamkills: 0, combat: 260, offense: 20, defense: 0, support: 15, slSeconds: 0 },
      { matchId: "m1", playerId: "p2", playerName: "Bodo", side: "axis", kills: 2, deaths: 0, teamkills: 0, combat: 100, offense: 60, defense: 40, support: 5, slSeconds: 0 },
    ],
    report: {
      complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [], timeline: [{ minute: 0, allies: 1, axis: 1 }], duels: [], awards: [],
      players: {
        p1: racer("allies", [[120, 40, 10, 0, 10], [300, 260, 20, 0, 15]]),
        p2: racer("axis", [[120, 50, 30, 20, 5], [300, 100, 60, 40, 5]]),
      },
    },
  };
  const vipRows = Array.from({ length: 60 }, (_, i) => ({ id: `h${i}`, ts: at, action: "granted", by: "owner", byUserId: "u1", serverId: "s1", serverName: "WW2 #1", expiration: null }));
  const ballots = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, decidedAt: at, mapId: "foy", mapName: `Map ${i}`, won: i % 2 === 0 }));
  const tally = Array.from({ length: 60 }, (_, i) => ({ mapId: `m${i}`, name: `Map ${i}`, offered: 60 - i, won: 1, votes: 2 }));
  const voters = Array.from({ length: 60 }, (_, i) => ({ discordUserId: `d${i}`, discordName: `Voter ${i}`, votes: 60 - i, wins: 1, lastVotedAt: at, userId: null, playerId: null, playerName: null }));
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/events": (url) => {
        asked.events.push(url.searchParams);
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
        return { body: { events: logRows.slice(offset, offset + limit), total: logRows.length, anchor: at } };
      },
      "/api/matches/m1": { body: round },
      "/api/games/hll/descriptor": { body: { descriptor: { ...HLL_DESCRIPTOR, scoreFields: SCORE_FIELDS } } },
      "/api/players/p1/vip-history": { body: { history: vipRows } },
      "/api/players/p1/mapvote": { body: { linked: true, discordId: "d1", totals: { votes: 60, wins: 30, firstVotedAt: at, lastVotedAt: at }, preferences: [], ballots } },
      "/api/servers/s1/mapvote/history": { body: { history: [], total: 0, tally, voters } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const tab = async (label) => { await page.click(`.tabbar-tab:text-is('${label}')`); };
    const pageOf = (scope, text) => scope.locator(".pager-where", { hasText: text }).first().waitFor({ timeout: 15_000 });

    // --- The game log: page two. A round opened from the history, and Back.
    await page.goto(`${base}#/history/logs`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-row", { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await pageOf(page, "Page 2 of 3");
    let before = asked.events.length;
    await page.goto(`${base}#/history/matches`, { waitUntil: "networkidle" });
    await page.goBack();
    await pageOf(page, "Page 2 of 3");
    assert.equal(asked.events[before]?.get("offset"), "50", "the log came back on its page, asking for it the first time");

    // --- A round: one row open on its combat chart, the race on offense and searched. A player, and Back.
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    await page.locator("tr.row-expandable", { hasText: "Arty" }).first().click();
    await page.locator('.seg[aria-label="Chart"] button:text-is("Cbt")').first().click();
    await page.locator('.seg[aria-label="Race"] button:text-is("Off")').click();
    const raceSearch = page.locator('input[aria-label="Find a player in the kill race"]');
    await raceSearch.fill("Bo");
    await page.locator(".race-chip", { hasText: "Axis" }).click();
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.goBack();
    await page.waitForSelector('.seg[aria-label="Chart"] .seg-btn.active:text-is("Cbt")', { timeout: 15_000 });
    await page.waitForSelector('.seg[aria-label="Race"] .seg-btn.active:text-is("Off")', { timeout: 15_000 });
    assert.equal(await raceSearch.inputValue(), "Bo", "the race still searched");
    await page.waitForSelector(".race-chip.on:has-text('Axis')", { timeout: 15_000 });

    // --- A profile: the VIP history and the map votes each on page two. Another screen, and Back.
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    const vipPanel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "VIP history" }) });
    const toggle = vipPanel.locator("button.panel-toggle");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    await vipPanel.locator("button[title='Next page']").click();
    await pageOf(vipPanel, "Page 2 of 2");
    const votesPanel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Map votes" }) });
    await votesPanel.locator("button[title='Next page']").click();
    await pageOf(votesPanel, "Page 2 of 2");
    await page.goto(`${base}#/history/matches`, { waitUntil: "networkidle" });
    await page.goBack();
    await pageOf(vipPanel, "Page 2 of 2");
    await pageOf(votesPanel, "Page 2 of 2");

    // --- Map votes: the maps' table and the voters' each on page two. Away to another tab, and back.
    await page.goto(`${base}#/history/mapvotes`, { waitUntil: "networkidle" });
    const mapsPanel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Which maps win" }) });
    const votersPanel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Who votes" }) });
    await mapsPanel.locator("button[title='Next page']").click();
    await pageOf(mapsPanel, "Page 2 of 2");
    await votersPanel.locator("button[title='Next page']").click();
    await pageOf(votersPanel, "Page 2 of 2");
    await tab("Matches");
    await tab("Map votes");
    await pageOf(mapsPanel, "Page 2 of 2");
    await pageOf(votersPanel, "Page 2 of 2");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("public stats: a round comes back from a player's career page as it was left — its board, the row opened, the race and the log", { skip: SKIP }, async () => {
  /*
   * Someone sorts a round's board, searches it for their name, opens their row on a score chart and
   * taps the name for their career page; Back used to land on a fresh board — sorted by kills, no
   * search, every row shut — and so did the report's race and the log's filter. Each is left in a
   * state of its own, the career page opened, and Back must find it as it was.
   */
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: true,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: SCORE_FIELDS, squadLabel: "Squad",
  };
  const row = (id, name, side, kills, deaths) => ({
    id, player_id: `7656119800000000${id}`, player: name, platform: "steam", kills, deaths, teamkills: 0, kill_death_ratio: kills / deaths,
    combat: 100 * id, offense: 10 * id, defense: 0, support: 0, time_seconds: 600, kills_streak: 1, team: { side },
    weapons: {}, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:20:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan Warfare" }, result: { allied: 1, axis: 4 },
    player_stats: [row(1, "Smith", "allies", 9, 3), row(2, "Smithers", "allies", 2, 8), row(3, "Jones", "axis", 5, 5)],
  };
  const life = { killsStreak: 1, deathsWithoutKillStreak: 1, longestLifeSecs: 60, shortestLifeSecs: 20, deathsByTk: 0, weapons: {}, deathByWeapons: {}, mostKilled: {}, deathBy: {} };
  const report = {
    complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [], duels: [], awards: [],
    timeline: [{ minute: 0, allies: 2, axis: 1 }],
    players: {
      Smith: { ...life, side: "allies", timeline: [[10, "k", "Jones", "M1 GARAND"]], scores: [[120, 40, 10, 0, 0], [600, 100, 10, 0, 0]] },
      Smithers: { ...life, side: "allies", timeline: [[50, "k", "Jones", "M1 GARAND"]], scores: [[600, 200, 20, 0, 0]] },
      Jones: { ...life, side: "axis", timeline: [[30, "k", "Smith", "MG42"]], scores: [[600, 300, 30, 0, 0]] },
    },
  };
  // Longer than one draw of the log (300 lines), so how far it has been shown is something to keep.
  const log = {
    start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:20:00.000Z", truncated: false,
    lines: [
      { t: 0, kind: "evt.match.started" },
      { t: 60, kind: "evt.player.connected", who: "Jones" },
      ...Array.from({ length: 650 }, (_, i) => ({ t: 100 + i, kind: "evt.kill", who: i % 2 ? "Smith" : "Jones", whom: i % 2 ? "Jones" : "Smith", weapon: "M1 GARAND" })),
      { t: 1200, kind: "evt.match.ended" },
    ],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/report/5": { body: { report } },
    "/api/public/alpha/log/5": { body: { log } },
    "/api/public/alpha/player/76561198000000001": { status: 404, body: { error: "no career recorded" } },
    "/stats/alpha/api/get_live_game_stats": { body: { result: { snapshot_timestamp: 1, refresh_interval_sec: 5, stats: round.player_stats }, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    const names = () => page.locator("table.scoreboard tbody tr td.pub-sb-name strong").allInnerTexts();
    const career = async () => {
      await page.locator("table.scoreboard tbody tr td.pub-sb-name a", { hasText: /^Smith$/ }).first().click();
      await page.waitForURL(/\/stats\/alpha\/player\//, { timeout: 15_000 });
      await page.goBack();
    };

    // --- The board: Allies only, searched for "Smith", sorted by deaths, Smith's row open on combat.
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    await page.locator('.seg[aria-label="Show a side"] button', { hasText: "Allies" }).click();
    await page.fill('input[aria-label="Find a player"]', "Smith");
    await page.locator('table.scoreboard thead th[title="Deaths"]').first().click();
    assert.deepEqual(await names(), ["Smithers", "Smith"], "the board as left: two of them, most deaths first");
    await page.locator("table.scoreboard tbody tr", { hasText: "Smithers" }).first().click();
    await page.locator('.seg[aria-label="Chart"] button:text-is("Cbt")').click();
    await career();
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    assert.equal(await page.inputValue('input[aria-label="Find a player"]'), "Smith", "the search came back");
    assert.deepEqual(await names(), ["Smithers", "Smith"], "and the side and the sort with it");
    await page.waitForSelector('.seg[aria-label="Show a side"] .seg-btn.active:has-text("Allies")', { timeout: 10_000 });
    await page.waitForSelector('.seg[aria-label="Chart"] .seg-btn.active:text-is("Cbt")', { timeout: 10_000 });

    // --- The report: the race on offense. The career page, and Back.
    await page.goto(`${stub.base}/stats/alpha/games/5/report`, { waitUntil: "networkidle" });
    await page.locator('.seg[aria-label="Race"] button:text-is("Off")').click();
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    await page.goBack();
    await page.waitForSelector('.seg[aria-label="Race"] .seg-btn.active:text-is("Off")', { timeout: 10_000 });

    // --- The log: read past its first draw. Another page, and Back.
    await page.goto(`${stub.base}/stats/alpha/games/5/log`, { waitUntil: "networkidle" });
    const more = page.locator("button", { hasText: /^Show more/ });
    await more.click();
    assert.match(await more.innerText(), /\(53 left\)/, "the log read to its second draw");
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    await page.goBack();
    await more.waitFor({ timeout: 10_000 });
    assert.match(await more.innerText(), /\(53 left\)/, "and comes back read that far, not to its first draw");
    // ...then kills only, searched for "Jones". Another page, and Back.
    await page.locator(".seg-btn", { hasText: /^Kills$/ }).click();
    await page.fill('input[placeholder="Find a player…"]', "Jones");
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    await page.goBack();
    await page.waitForSelector(".seg-btn.active:text-is('Kills')", { timeout: 10_000 });
    assert.equal(await page.inputValue('input[placeholder="Find a player…"]'), "Jones", "the log came back searched");

    // --- The live round's board is a place of its own: it opens unsearched, then keeps its own.
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    assert.equal(await page.inputValue('input[aria-label="Find a player"]'), "", "not the past round's search");
    await page.fill('input[aria-label="Find a player"]', "Smith");
    await page.locator('table.scoreboard thead th[title="Deaths"]').first().click();
    assert.deepEqual(await names(), ["Smithers", "Smith"]);
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    await page.goBack();
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    assert.equal(await page.inputValue('input[aria-label="Find a player"]'), "Smith", "the live board's search came back");
    assert.deepEqual(await names(), ["Smithers", "Smith"], "and its sort");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a moderation record tab comes back from the tab beside it as it was left", { skip: SKIP }, async () => {
  /*
   * Kicks, Punishments, Team switches and Warnings are one screen drawn four times, and the hub
   * handed the one on screen new props instead of a screen of its own: Kicks left on page two,
   * Punishments opened beside it, Kicks again — page one, its remembered page wiped, and a
   * Punishments search still sent with the first read of Kicks.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const rows = (action, n) => Array.from({ length: n }, (_, i) => ({ id: `${action}${i}`, ts: at, actorUserId: "u1", actorName: "mod", actorDisplayName: "mod", action, targetType: "player", targetId: `x${i}`, targetName: `Target ${i}`, summary: `${action} ${i}`, serverId: "s1" }));
  const kicks = rows("player.kick", 120), punishes = rows("player.punish", 120);
  const asked = [];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/audit": (url) => {
      const acts = (url.searchParams.get("actions") ?? "").split(",");
      const which = acts.includes("player.kick") ? "kicks" : acts.includes("player.punish") ? "punishments" : "other";
      asked.push({ which, q: url.searchParams.get("q") ?? "" });
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const src = (which === "kicks" ? kicks : which === "punishments" ? punishes : []).filter((r) => r.targetName.toLowerCase().includes(q));
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
      return { body: { entries: src.slice(offset, offset + limit), total: src.length } };
    },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const where = (text) => page.locator(".pager-where", { hasText: text }).first().waitFor({ timeout: 15_000 });
    const search = page.getByPlaceholder("Search player, reason, staff…");
    await page.goto(`${base}#/moderation/kicks`, { waitUntil: "networkidle" });
    await where("Page 1 of 3");
    await page.click("button[title='Next page']");
    await where("Page 2 of 3");
    // Punishments, searched.
    await page.click(".tabbar-tab:text-is('Punishments')");
    await where("Page 1 of 3");
    await search.fill("Target 1");
    await where("Page 1 of 1");
    // Kicks again: its own page, its own (empty) search, and nothing asked with the other's.
    const before = asked.length;
    await page.click(".tabbar-tab:text-is('Kicks')");
    await where("Page 2 of 3").catch(() => { throw new Error("Kicks came back from Punishments on page one"); });
    await page.waitForTimeout(600); // past the search box's debounce, so a lagging search would have been sent
    assert.equal(await search.inputValue(), "", "Kicks has its own search");
    const kicksAsked = asked.slice(before).filter((a) => a.which === "kicks");
    assert.ok(kicksAsked.length > 0, "Kicks was read");
    assert.deepEqual(kicksAsked.filter((a) => a.q), [], "Kicks was never read with the Punishments search");
    assert.match(await page.locator(".pager-where").first().innerText(), /Page 2 of 3/, "and stayed on its page");
    // And Punishments comes back searched, as it was left.
    await page.click(".tabbar-tab:text-is('Punishments')");
    await where("Page 1 of 1");
    assert.equal(await search.inputValue(), "Target 1", "Punishments kept its search");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("another player's profile or another group, opened in place, keeps its own page", { skip: SKIP }, async () => {
  /*
   * A profile opened from another profile is the same screen given another player, and a group
   * picked on the Groups tab is the same table given other members. The list moved to was handed
   * the last one's rows and treated as a new filter of it: a profile's activity went back to page
   * one, its remembered page wiped, and a group's members were cut to the last page of the group
   * before.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const paged = (rows, url) => {
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
    return rows.slice(offset, offset + limit);
  };
  const profile = (id) => ({ body: {
    player: { id, name: `Player ${id}`, platform: "steam", platformId: `7656${id}`, firstSeen: at, lastSeen: at },
    stats: { kills: 1, deaths: 1, teamkills: 0 }, flags: { watchlist: false, vip: false, updatedByName: null },
    canViewNotes: true, notes: [], statsByServer: [], sessions: [], recentEvents: [],
  } });
  const events = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, ts: at, kind: "evt.kill", serverId: "s1", actorName: "Someone", victimName: `v${i}`, data: {} }));
  const long = events(120), short = events(70); // three pages and two
  const group = (id, name) => ({ id, name, description: null, memberCount: 0, createdByName: "owner", vipPerk: null });
  const members = (n) => Array.from({ length: n }, (_, i) => ({ playerId: `7656112000${String(i).padStart(7, "0")}`, playerName: `Member ${i}`, addedByName: "owner", addedAt: at, source: "manual" }));
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/players/p2": profile("p2"),
    "/api/players/p3": profile("p3"),
    "/api/players/p2/events": (url) => ({ body: { events: paged(long, url), total: long.length } }),
    "/api/players/p3/events": (url) => ({ body: { events: paged(short, url), total: short.length } }),
    "/api/player-groups": { body: { groups: [group("g1", "WW2 CVC"), group("g2", "Seeders")] } },
    "/api/player-groups/g1": { body: { members: members(10) } },
    "/api/player-groups/g2": { body: { members: members(60) } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const activity = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Activity" }) });
    const where = (scope, text) => scope.locator(".pager-where", { hasText: text }).first().waitFor({ timeout: 15_000 });

    // One player's activity on its last page; away, another player's, then the first's in place.
    await page.goto(`${base}#/players/~p2`, { waitUntil: "networkidle" });
    await activity.locator("button[title='Last page']").click();
    await where(activity, "Page 3 of 3");
    await page.goto(`${base}#/history/matches`, { waitUntil: "networkidle" });
    await page.goto(`${base}#/players/~p3`, { waitUntil: "networkidle" });
    await where(activity, "Page 1 of 2");
    await page.evaluate(() => { window.location.hash = "#/players/~p2"; });
    await page.waitForFunction(() => /Player p2/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await where(activity, "Page 3 of 3").catch(() => { throw new Error("the first player's activity, opened in place, was not on its page"); });

    // A group's members on page two; another group, then the first again.
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    const groups = page.locator("select", { has: page.locator("option", { hasText: "Seeders" }) });
    await groups.selectOption("g2");
    await where(page, "Page 1 of 2");
    await page.click("button[title='Next page']");
    await where(page, "Page 2 of 2");
    await groups.selectOption("g1");
    await page.waitForSelector("text=Member 9", { timeout: 15_000 });
    await groups.selectOption("g2");
    await where(page, "of 2");
    assert.match(await page.locator(".pager-where").first().innerText(), /Page 2 of 2/, "the group picked again is on the page it was left on");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Sync with game on a server still listing temp bans whose time ran out: the game refuses to remove
 * those, so they are left alone — and the screen says how many, rather than failing on each. A
 * refusal it does meet is named: who, and the game's answer once, not the same error for nobody.
 */
test("bans: Sync with game and Lift all say which listed temp bans already ran out, and name whoever the game refused", { skip: SKIP }, async () => {
  const at = "2026-08-01T00:00:00.000Z";
  const servers = [{ id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" }];
  const ban = { id: "b1", ts: at, by: "admin", playerName: "Alpha", playerId: "id-a", type: "perma", reason: "cheating", category: null, scope: { mode: "all" }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"] };
  const refusal = "(400) command removeTempBan failed: Unable to perform request. Request was invalid";
  let syncs = 0;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers": () => ({ body: { servers } }),
    "/api/bans": { body: { bans: [ban] } },
    // The plan first, then what the apply did; then, run again, nothing left but the finished ones.
    "/api/servers/s1/bans/reconcile": () => (++syncs === 1
      ? { body: { applied: false, onGame: 37, apply: [], lift: [{ playerId: "tk-new" }, { playerId: "tk-stuck" }, { playerId: "x" }], foreign: [], ranOut: [{ playerId: "tk-old", playerName: "Gunplay" }, { playerId: "tk-older", playerName: "Tobicek_356" }] } }
      : syncs === 2
        ? { body: { applied: true, restored: [], lifted: ["tk-new"], ranOut: [{ playerId: "tk-old", playerName: "Gunplay" }, { playerId: "tk-older", playerName: "Tobicek_356" }],
            skipped: [{ playerId: "tk-stuck", playerName: "Chaptheclown", reason: refusal }, { playerId: "a2c4e6f8b0d2a2c4e6f8b0d2a2c4e6f8", playerName: null, reason: refusal }], before: 37, after: 36 } }
        : { body: { applied: false, onGame: 36, apply: [], lift: [], foreign: [{ playerId: "outside-1", type: "temp" }], ranOut: [{ playerId: "tk-old", playerName: "Gunplay" }, { playerId: "tk-older", playerName: "Tobicek_356" }] } }),
    "/api/servers/s1/bans/lift-all": { body: { lifted: 1, narrowed: 0, cleared: 3, ranOut: 2, failed: [], gameError: null } },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/moderation/bans`, { waitUntil: "networkidle" });
    await page.locator("tbody tr", { hasText: "Alpha" }).waitFor({ timeout: 15_000 });

    await page.locator("button", { hasText: "Sync with game" }).click();
    const dialog = page.locator(".confirm-modal");
    await dialog.waitFor({ timeout: 10_000 });
    const asked = await dialog.innerText();
    assert.match(asked, /enforces 35 ban/, "the finished ones are not counted as enforced");
    assert.match(asked, /2 temp bans on its list had already run out/);
    assert.match(asked, /so they're left alone/, "asked before anything has run: not \"were left alone\"");
    await dialog.locator("button", { hasText: "Sync now" }).click();

    const note = page.locator("p", { hasText: "Applied 0, lifted 1" });
    await note.waitFor({ timeout: 10_000 });
    const said = await note.innerText();
    assert.match(said, /2 temp bans on its list had already run out — the game still lists them but no longer enforces them/);
    assert.match(said, /skipped 2: Chaptheclown, a2c4e6f8b0d2… — \(400\) command removeTempBan failed/, "who, then the game's answer once");
    assert.equal(said.split("removeTempBan failed").length - 1, 1, "the same refusal is not repeated per player");

    // Run again with nothing left to do but the finished ones and one placed outside the panel: in
    // sync, and it says why the list is longer. 36 listed = 33 matching the record + 1 outside + 2
    // run out — the "+1" is in addition to the 33, not counted in them as well.
    await page.locator("button", { hasText: "Sync with game" }).click();
    const settled = page.locator("p", { hasText: "In sync" });
    await settled.waitFor({ timeout: 10_000 });
    assert.match(await settled.innerText(), /In sync: this server enforces 33 ban\(s\) matching the record \(\+1 placed outside the panel, left alone — adopt them with Sync from servers\)\. 2 temp bans on its list had already run out/);

    // Lift all on this server says the same of the entries it left.
    await page.locator("select[title^='Narrow the record']").selectOption("s1");
    await page.locator("button", { hasText: "Lift all on this server" }).click();
    await page.locator(".confirm-modal button", { hasText: "Lift everything" }).click();
    const lifted = page.locator("p", { hasText: "Lifted 1 decision" });
    await lifted.waitFor({ timeout: 10_000 });
    assert.match(await lifted.innerText(), /2 temp bans on its list had already run out/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Bans → Live is the game's own list, and HLL goes on listing a temp ban after its time ran out.
 * Such a row is dimmed and says it ran out — as an expired decision does in the record — instead
 * of an Unban the game refuses ("Request was invalid"); the count says how many of the temp bans.
 */
test("bans: the Live list shows a temp ban whose time ran out, with no Unban the game would refuse", { skip: SKIP }, async () => {
  const at = "2026-08-01T00:00:00.000Z";
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers/s1/bans/live": { body: { bans: [
      { playerId: "76561198000000011", playerName: "Finished", type: "temp", ts: at, durationHours: 24, reason: "TK on connect", by: "bot", ranOut: true },
      { playerId: "76561198000000012", playerName: "Running", type: "temp", ts: at, durationHours: 24, reason: "TK on connect", by: "bot", ranOut: false },
      { playerId: "76561198000000013", playerName: "Cheater", type: "perma", ts: at, durationHours: 0, reason: "cheating", by: "admin", ranOut: false },
    ] } },
  } }, async (page, { errors }) => {
    await page.locator(".nav-item", { hasText: "Moderation" }).first().click();
    await page.locator(".seg-btn", { hasText: "Live" }).first().click();
    await page.waitForSelector("table");

    const finished = page.locator("tbody tr", { hasText: "Finished" });
    assert.equal(await finished.locator("button", { hasText: "Unban" }).count(), 0, "no Unban the game would refuse");
    assert.match(await finished.innerText(), /ran out/);
    assert.equal(await finished.evaluate((el) => window.getComputedStyle(el).opacity), "0.55", "dimmed, like an expired decision");
    const running = page.locator("tbody tr", { hasText: "Running" });
    assert.equal(await running.locator("button", { hasText: "Unban" }).count(), 1, "a ban still running keeps its Unban");
    assert.equal(await running.evaluate((el) => window.getComputedStyle(el).opacity), "1");
    assert.equal(await page.locator("tbody tr", { hasText: "Cheater" }).locator("button", { hasText: "Unban" }).count(), 1);
    assert.match(await page.locator("p", { hasText: "temporary" }).first().innerText(), /2 temporary \(1 ran out\) · 1 permanent/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("staff signing in while the owner is part-way through setup go straight to the panel", { skip: SKIP }, async () => {
  await withPage({ grants: [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }], overrides: {
    "/api/setup/status": { body: { needed: false, codeRequired: false, stage: "walkthrough", route: "home" } },
  } }, async (page) => {
    await page.locator(".nav-item").first().waitFor({ timeout: 10_000 });
    assert.equal(await page.locator("h1", { hasText: "Your community's time zone" }).count(), 0, "the walk-through is the owner's");
  });
});

test("a remembered server or rule filter that has gone stops filtering", { skip: SKIP }, async () => {
  /*
   * The Bans record keeps the server it was narrowed to, and the automation history the rule, for
   * the sitting. A server deleted (or no longer this account's) went on narrowing the record from
   * a dropdown that could not show it, with "Lift all on this server" still offered for it; a rule
   * deleted went on narrowing the history to its old firings under "— every rule —".
   */
  const at = "2026-08-01T00:00:00.000Z";
  const ban = (id, name, serverIds) => ({ id, ts: at, by: "admin", playerName: name, playerId: `id-${id}`, type: "perma", reason: "cheating", category: null, scope: { mode: "servers", serverIds }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds });
  const rule = (id, name) => ({ id, name, enabled: true, serverId: null, eventKind: "evt.teamkill", action: "kick", match: null, threshold: 1, windowSec: 0, reason: null, hours: null, delaySec: 0, vipMinutes: 10, vipCooldownMinutes: 60, requireRoleIds: [] });
  const servers = [
    { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
    { id: "s2", name: "WW2 #2", game: "hll", engagementMode: "active" },
  ];
  const rules = [rule("r1", "TK policy"), rule("r2", "Chat spam")];
  const asked = [];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers": () => ({ body: { servers } }),
    "/api/bans": { body: { bans: [ban("b1", "Alpha Griefer", ["s1"]), ban("b2", "Bravo Griefer", ["s2"])] } },
    "/api/enforcer/rules": () => ({ body: { rules, activity: {} } }),
    "/api/automation/history": (url) => {
      asked.push(url.searchParams);
      return { body: { entries: [{ id: "e1", ts: at, actorName: "enforcer", action: "enforcer.kick", targetName: "Griefer", targetId: "p1", serverId: "s1", summary: "kick Griefer — TK policy", data: { ruleId: "r1" } }], total: 1 } };
    },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const until = async (cond, what) => {
      for (let i = 0; i < 150 && !cond(); i++) await page.waitForTimeout(100);
      assert.ok(cond(), `timed out waiting for ${what}`);
    };
    const liftAll = page.locator("button", { hasText: "Lift all on this server" });
    const rows = page.locator(".scroll-x table tbody tr");

    // The record narrowed to the second server.
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "networkidle" });
    await rows.first().waitFor({ timeout: 15_000 });
    await page.locator("select[title^='Narrow the record']").selectOption("s2");
    await liftAll.waitFor({ timeout: 15_000 });
    assert.equal(await rows.count(), 1, "narrowed to the second server's ban");
    // The second server deleted: the record is every server's again, and nothing offers to lift
    // bans on a server that is not there.
    servers.splice(1);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("tbody tr", { hasText: "Bravo Griefer" }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    assert.equal(await rows.count(), 2, "both bans are listed: the gone server narrows nothing");
    assert.equal(await liftAll.count(), 0, "no Lift all for a server that has gone");

    // The history narrowed to the second rule.
    await page.goto(`${base}#/autosettings/history`, { waitUntil: "networkidle" });
    const ruleSelect = page.locator("select:has(option:has-text('— every rule —'))");
    await ruleSelect.selectOption("r2");
    await until(() => asked.at(-1)?.get("ruleId") === "r2", "the history to be read for the second rule");
    // The second rule deleted: back on the history, it is every rule's again.
    rules.splice(1);
    await page.goto(`${base}#/help/pages`, { waitUntil: "networkidle" });
    // Help on screen before going back: two address changes drawn as one would leave the history
    // where it was, never read again.
    await page.getByPlaceholder("Search every page…").waitFor();
    const before = asked.length;
    await page.goto(`${base}#/autosettings/history`, { waitUntil: "networkidle" });
    await until(() => asked.length > before, "the history to be read again");
    await page.waitForTimeout(500);
    assert.equal(asked.at(-1)?.get("ruleId"), null, "the history is read for every rule, not for the one that has gone");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * To pick its steps the menu tries each in turn, and through each try the browser holds what is in
 * view steady by moving the scroll — moves that did not always undo. A menu scrolled part way crept
 * a few pixels at every fit, and it fits again whenever the sidebar changes: every 15 seconds while
 * the host status refreshes. Checked only at the top of the menu, where nothing can creep.
 */
test("a menu scrolled part way stays put while it fits itself again", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    // The menu scrolling on its own in a laptop's window; then the whole sidebar, in a shorter one.
    for (const [height, scroller] of [[580, ".nav"], [520, ""]]) {
      const what = scroller ? "menu" : "sidebar";
      await page.setViewportSize({ width: 1366, height });
      await page.goto(`${base}#/admin/users`, { waitUntil: "networkidle" });
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".host-status .hs-stat").first().waitFor({ state: "attached" });
      await page.waitForTimeout(300);
      for (const part of [0.2, 0.45, 0.7]) {
        const at = await page.evaluate(([sel, f]) => {
          const aside = window.document.querySelector(".sidebar"), el = sel ? aside.querySelector(sel) : aside;
          el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * f);
          return el.scrollTop;
        }, [scroller, part]);
        assert.ok(at > 0, `${height}px window: the ${what} scrolls`);
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.dispatchEvent(new Event("panel:prefs")));
          await page.waitForTimeout(150);
        }
        const now = await page.evaluate((sel) => {
          const aside = window.document.querySelector(".sidebar");
          return (sel ? aside.querySelector(sel) : aside).scrollTop;
        }, scroller);
        assert.equal(now, at, `${height}px window, the ${what} scrolled ${Math.round(part * 100)}% of the way stays at ${at}`);
      }
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A phone on its side takes the short screen above further: about 390px tall, where the brand,
 * search, host status, server switcher and account took some 360px and left the nav a sliver that
 * showed one item. There the sidebar scrolls as one column instead, every destination at full
 * height and the bottom section after it. 844×390 is the drawer (an iPhone on its side); 932×430
 * is wider than the drawer breakpoint, so the sidebar sits beside the page.
 */
test("a phone on its side: the sidebar scrolls as one column instead of squeezing the nav to a sliver", { skip: SKIP }, async () => {
  for (const viewport of [{ width: 844, height: 390 }, { width: 932, height: 430 }]) {
    await withPage({ grants: OWNER_GRANTS, viewport }, async (page) => {
      const at = `${viewport.width}×${viewport.height}`;
      await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });
      const burger = page.locator(".burger");
      if (await burger.isVisible()) {
        await burger.click();
        await page.waitForSelector(".app-shell.drawer-open");
      }
      const m = await page.evaluate(() => {
        const nav = window.document.querySelector(".sidebar .nav");
        const side = window.document.querySelector(".sidebar");
        return { shown: nav.clientHeight, content: nav.scrollHeight, sideScrolls: side.scrollHeight > side.clientHeight };
      });
      assert.ok(m.content - m.shown <= 1, `${at}: the nav shows ${m.shown}px of its ${m.content}px, squeezed between the pinned rows`);
      assert.ok(m.sideScrolls, `${at}: the sidebar itself scrolls to the rest`);
      // The one column reaches everything: the last destination, then the account row.
      for (const sel of [".sidebar .nav-item >> nth=-1", ".sidebar .sidebar-footer"]) {
        await page.locator(sel).scrollIntoViewIfNeeded();
        const box = await page.locator(sel).boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height + 1, `${at}: ${sel} scrolls fully into view`);
      }
    });
  }
});

test("the Live feed opens with the round so far, and doesn't ask whether you want live data", { skip: SKIP }, async () => {
  // The feed is an SSE tail, so it used to start empty: walk up to a match already in progress and
  // the screen said nothing had happened. It now backfills the open round first.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/round/events": { body: {
        round: { id: "m1", map: "Foy", startedAt: new Date(Date.now() - 900_000).toISOString() },
        events: [
          { ts: new Date(Date.now() - 60_000).toISOString(), kind: "evt.kill", actorName: "EARLIER-KILLER", victimName: "EARLIER-VICTIM", weapon: "M1 GARAND", dedupeKey: "k1" },
          { ts: new Date(Date.now() - 120_000).toISOString(), kind: "evt.chat", actorName: "EARLIER-TALKER", dedupeKey: "k2" },
        ],
      } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    // Scoreboard and feed share one panel now, switched by a tab rather than stacked.
    await page.locator(".seg-btn", { hasText: "Live feed" }).click();
    await page.waitForSelector(".live-feed .live-row", { timeout: 10_000 });

    const feed = await page.locator(".live-feed").innerText();
    assert.match(feed, /EARLIER-KILLER/, "the round's earlier kill is there before any live event arrives");
    assert.match(feed, /EARLIER-TALKER/, "and so is the earlier chat line");

    // On the view that IS live, an opt-in checkbox to see live data is a question with one answer.
    assert.equal(await page.locator("label", { hasText: "Stream live" }).count(), 0, "no redundant live toggle");
    // It says what window it is showing rather than leaving the reader to guess.
    assert.match(await page.locator(".control-row").first().innerText(), /this round/i);
  });
});

/**
 * The document may never be wider than the screen.
 *
 * On a phone the browser fits the whole document, so one element that sticks out does not give you
 * a scrollbar — it zooms the entire page out, and every screen you open afterwards starts at that
 * scale. Nothing about it is visible at desktop width, which is where this kind of bug is written,
 * so the invariant is asserted here at a real phone size instead.
 *
 * The server name is the long one on purpose. A control sized by its content — a `<select>` is
 * sized by its longest option — behaves completely differently against "Test Server #1" than
 * against a name carrying a community's whole rulebook, and the short fixture hides it.
 */
test("no screen is wider than the phone it is drawn on", { skip: SKIP }, async () => {
  const LONG = "The [LYNX] Division #1 | MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED, LVL 100+ COMMANDER ENFORCED";
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 402, height: 874 },
    overrides: { "/api/servers": { body: { servers: [
      { id: "s1", name: LONG, game: "hll", engagementMode: "observe" },
      { id: "s2", name: `${LONG} — SECOND`, game: "hll", engagementMode: "observe" },
    ] } } },
  }, async (page) => {
    const base = page.url().split("#")[0];
    const screens = [
      "/dashboard", "/live", "/history/logs", "/history/matches", "/announcements",
      "/players/directory", "/players/leaderboard", "/players/vips", "/players/groups",
      "/moderation", "/maps/rotation", "/maps/catalogue",
      "/autosettings/settings", "/broadcast", "/discord/relay",
      "/analytics/server", "/admin/users", "/admin/activity", "/admin/connections", "/admin/system",
    ];
    for (const screen of screens) {
      await page.goto(`${base}#${screen}`, { waitUntil: "networkidle" });
      const { doc, view, worst } = await page.evaluate(() => {
        const root = window.document.documentElement;
        let worst = null;
        for (const el of window.document.querySelectorAll("*")) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0 || b.right <= root.clientWidth + 1) continue;
          const parent = el.parentElement;
          if (parent && parent.getBoundingClientRect().right > root.clientWidth + 1) continue;
          if (!worst || b.right > worst.right) {
            worst = { right: Math.round(b.right), tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 50) };
          }
        }
        return { doc: root.scrollWidth, view: root.clientWidth, worst };
      });
      assert.ok(doc <= view, `${screen} is ${doc}px wide in a ${view}px viewport — the phone will zoom the whole page out${worst ? `; widest thing past the edge: <${worst.tag} class="${worst.cls}"> reaching ${worst.right}px` : ""}`);
    }
  });
});

test("coverage states time AND player count, and a broken read cannot take the page down", { skip: SKIP }, async () => {
  // Sets are matched on time and player count together, so a display that fixes one to describe
  // the other is wrong wherever the other moves: at 30 players the seeding set owns the evening
  // that "prime time 18:00–23:00" claims. Every row therefore names its own band.
  const cfg = {
    enabled: true, surface: "native", channelId: "500000000000000001", pollHours: 2,
    liveApply: true, postMatchApplyDelaySeconds: 300, pollResetDelaySeconds: 180,
    pauseBelowPlayers: 0, startupState: "remember", timezone: "UTC", activeProfile: "prime time",
    reminders: [],
    profileLinks: [
      { mapSet: "seeding", schedule: "under 40" },
      { mapSet: "prime time", schedule: "evenings" },
    ],
    profiles: [
      { name: "seeding", spec: { playersBelow: 40 }, pool: { dayCount: 3 } },
      { name: "prime time", spec: { start: "18:00", end: "23:00" }, pool: { dayCount: 3 } },
    ],
    sets: [
      { id: "ms1", name: "seeding", pool: { dayCount: 3 }, usedBy: ["Test"] },
      { id: "ms2", name: "prime time", pool: { dayCount: 3 }, usedBy: ["Test"] },
    ],
    schedules: [
      { id: "vs1", name: "under 40", spec: { playersBelow: 40 }, usedBy: ["Test"] },
      { id: "vs2", name: "evenings", spec: { start: "18:00", end: "23:00" }, usedBy: ["Test"] },
    ],
    state: null,
  };

  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/servers/s1/mapvote/config": { body: cfg } },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/votesetup`, { waitUntil: "networkidle" });
    await page.waitForSelector(".cov-bar", { timeout: 10_000 });

    // Two rows, each SAYING its player band — the axis that every earlier version left implied.
    const labels = await page.locator(".cov-band-label").allInnerTexts();
    assert.ok(labels.some((l) => /under 40 players/i.test(l)), `a band names its lower range, got ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /40\+ players/i.test(l)), `and its upper one, got ${JSON.stringify(labels)}`);

    // The same time of day answers differently in each band, which is the whole point.
    const rows = page.locator(".cov-row").filter({ has: page.locator(".cov-bar") });
    assert.match(await rows.nth(0).innerText(), /seeding/, "under 40, the seeding set owns the day");
    const busy = await rows.nth(1).innerText();
    assert.match(busy, /prime time/, "at 40+, prime time owns its window");
    assert.match(busy, /defaults/, "and the uncovered rest of the day is drawn, not omitted");

    // The gap warning names BOTH axes; a time range with no player band is a half-truth.
    const warn = await page.locator(".callout", { hasText: "No map set covers" }).first().innerText();
    assert.match(warn, /00:00–18:00/, "the uncovered hours are named exactly");
    assert.match(warn, /40\+ players/, "and so is the band they are uncovered in");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // A coverage read that answers with nothing usable — an API older than the panel — must cost an
  // empty section and nothing else. Reaching into that response used to throw during render, which
  // unmounted the entire settings page: no Save button, no map sets, no way to tell why.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/mapvote/config": { body: cfg },
      "/api/servers/s1/mapvote/coverage": { body: {} },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/votesetup`, { waitUntil: "networkidle" });
    // The pairing rows are the part a render crash would take with it, so wait for one by name.
    await page.locator('select[aria-label="Manage map sets"], .setting-card select').first().waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".cov-bar").count(), 0, "nothing is drawn from an unusable answer");
    const body = await page.locator("body").innerText();
    assert.match(body, /Manage map sets/i, "the rest of the page still renders");
    assert.match(body, /Save/, "including the Save the whole page hangs off");
    assert.deepEqual(errors, [], "and it is not an uncaught error either");
  });
});

/*
 * Everything a role can see, it can ask for — on the player's menu too.
 *
 * A comment, a linked account and group membership used to sit outside requests: "Add comment" was
 * hidden from anyone without the notes write ("what is hidden here genuinely cannot be done"), and
 * inside the request builder their dialogs said they "happen now, not on submit". The API now asks
 * for them like every other action, so the menu offers them and says so.
 */
test("player menu: a comment is asked for rather than hidden, and the groups dialog says where a toggle goes", { skip: SKIP }, async () => {
  const one = { "/api/servers/s1/live": { body: {
    players: [{ id: "p1", playerId: "76561198000000001", playerDbId: "db-1", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 } }],
    session: { playerCount: 1, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 0, remainingMatchTime: 100, matchTime: 10 },
  } } };
  const groups = { "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", memberCount: 3 }] } } };
  const openMenu = async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
  };

  // Can read notes, cannot write them: the item is there, and its dialog sends for approval.
  const notesReadOnly = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "player.notes", scopeType: "global", scopeId: null, level: "read" },
  ];
  await withPage({ grants: notesReadOnly, overrides: { ...ACTIVE_S1, ...one } }, async (page) => {
    await openMenu(page);
    await page.locator(".pa-mi", { hasText: "Add comment" }).click();
    await page.waitForSelector(".pa-modal");
    assert.equal(((await page.locator(".pa-actions button:not(.ghost)").textContent()) ?? "").trim(), "Send for approval");
  });
  // Building a request: a comment goes into the request like any action, and a toggle in the
  // groups dialog (on the profile, where the menu offers it) is captured — each dialog says so.
  await withPage({ grants: OWNER_GRANTS, overrides: { ...ACTIVE_S1, ...one, ...groups, "/api/requests/draft": { body: { draft: { lines: [] } } } } }, async (page) => {
    await page.route("**/api/player-groups/for/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ groups: [] }) }));
    await page.evaluate(() => window.localStorage.setItem("panel.requestMode", "1"));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".request-bar", { timeout: 15_000 });
    await openMenu(page);
    await page.locator(".pa-mi", { hasText: "Add comment" }).click();
    await page.waitForSelector(".pa-modal");
    assert.equal(((await page.locator(".pa-actions button:not(.ghost)").textContent()) ?? "").trim(), "Add to request");
    assert.doesNotMatch(await page.locator(".pa-modal").innerText(), /saved now/, "the old promise is gone");
    await page.locator(".pa-actions button.ghost").click();

    await page.goto(`${page.url().split("#")[0]}#/players/~p1`, { waitUntil: "networkidle" });
    await page.locator(".player-actions .pa-menu button").first().click();
    await page.locator(".pa-mi", { hasText: "Groups" }).click();
    await page.waitForSelector(".pa-modal");
    const text = await page.locator(".pa-modal").innerText();
    assert.match(text, /Each change you toggle is added to your request/);
    assert.doesNotMatch(text, /not part of the request/, "the old promise is gone");
  });
});

/*
 * Everything a role can see, it can ask for — on the screens too, not only in the player menu. A
 * screen the account can read but not change used to grey out or hide every control, so nothing
 * on it could be asked for. Now the controls stay usable under their own names, one line says
 * where a change goes, and saving is sent for approval.
 */
test("a screen the role can see but not change: its controls stay usable, a notice says where changes go, and saving is asked for", { skip: SKIP }, async () => {
  const viewer = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "autosettings.profiles", scopeType: "global", scopeId: null, level: "read" },
    { capability: "player.groups", scopeType: "global", scopeId: null, level: "read" },
  ];
  await withPage({ grants: viewer, overrides: {
    ...ACTIVE_S1,
    "/api/servers/s1/autosettings": { body: { config: { enabled: false, dryRun: true, timezone: "UTC", profiles: [] }, fields: [] } },
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 0, createdByName: "owner", vipPerk: null }] } },
  } }, async (page, { errors }) => {
    let sent = null;
    await page.route("**/api/servers/s1/autosettings", async (r) => {
      if (r.request().method() !== "PUT") return r.continue();
      sent = r.request().postDataJSON();
      await r.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ requested: true, requestId: "req-1", label: "Change the auto settings" }) });
    });
    const base = page.url().split("#")[0];

    await page.goto(`${base}#/autosettings`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=You don't hold the permission for changes here", { timeout: 15_000 });
    const master = page.locator('.setting-card:has-text("Enable auto settings") .toggle input');
    assert.equal(await master.isDisabled(), false, "the switch is usable without the write");
    await page.locator('.setting-card:has-text("Enable auto settings") .toggle').click();
    await page.locator('button.primary:has-text("Save")').first().click();
    await page.waitForSelector("text=Sent for approval", { timeout: 10_000 });
    assert.equal(sent?.enabled, true, "the change itself went to the API, to be filed there");

    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForSelector('button:has-text("+ New group")', { timeout: 15_000 });
    await page.waitForSelector("text=You don't hold the permission for changes here");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a player's flags and watch reasons: whoever sees them may change them, and what the account lacks is sent for approval", { skip: SKIP }, async () => {
  /*
   * Flags come with seeing the player, and the watch record with the watchlist read — but adding or
   * removing a flag needed the watchlist read, and editing someone else's watch reason or closing
   * any reason needed curation, so a role that could see all of it had nothing to ask with.
   */
  const id = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const profile = { body: {
    player: { id, platform: "steam", platformId: "76561198000000001", name: "Watched Guy", firstSeen: "2026-09-01T00:00:00.000Z", lastSeen: "2026-10-01T00:00:00.000Z" },
    stats: null, flags: { watchlist: true, vip: false, updatedByName: null, watchReason: "griefing", watchBy: "Another Admin" }, recentEvents: [], canViewNotes: false,
    tags: [{ id: "t1", label: "toxic", note: null, createdByName: "Another Admin" }],
  } };
  const reasons = { body: { reasons: [{ id: "w1", reason: "griefing", addedBy: "Another Admin", addedAt: "2026-10-01T00:00:00.000Z", expiresAt: null, removedBy: null, removedAt: null, own: false, edits: [] }] } };
  const filed = (label) => ({ status: 202, contentType: "application/json", body: JSON.stringify({ requested: true, requestId: "req-1", label }) });

  // Watchlist read only: no write, no curation.
  const watchReader = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "player.watchlist", scopeType: "global", scopeId: null, level: "read" },
  ];
  await withPage({ grants: watchReader, overrides: { [`/api/players/${id}`]: profile, [`/api/players/${id}/watch`]: reasons } }, async (page, { errors }) => {
    const sent = [];
    await page.route(`**/api/players/${id}/watch/reasons/w1`, async (r) => {
      sent.push(r.request().method());
      await r.fulfill(filed(r.request().method() === "DELETE" ? "Close a watch reason" : "Edit a watch reason"));
    });
    await page.goto(`${page.url().split("#")[0]}#/players/~${id}`, { waitUntil: "networkidle" });
    const row = page.locator(".note", { hasText: "griefing" }).filter({ has: page.locator("button", { hasText: "Edit" }) });
    await row.waitFor({ timeout: 15_000 });
    assert.equal(await row.locator("button", { hasText: "Remove" }).count(), 1, "closing a reason is offered, not hidden");

    await row.locator("button", { hasText: "Edit" }).click();
    await page.locator(".note input").first().fill("griefing at the HQ");
    const save = page.locator(".note button.primary");
    assert.equal((await save.innerText()).trim(), "Send for approval", "someone else's reason, without curation: Save says it asks");
    await save.click();
    await page.waitForSelector("text=Sent for approval", { timeout: 10_000 });
    await page.locator(".note button", { hasText: "Remove" }).first().waitFor({ timeout: 10_000 });

    await page.locator(".note button", { hasText: "Remove" }).first().click();
    const confirm = page.locator(".confirm-modal button", { hasText: "Send for approval" });
    await confirm.waitFor({ timeout: 10_000 });
    await confirm.click();
    for (let i = 0; i < 50 && sent.length < 2; i++) await page.waitForTimeout(100);
    assert.deepEqual(sent, ["PATCH", "DELETE"], "both went to the API, to be filed there");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // No watchlist at all: the flags are still on screen, so they can be asked for.
  const viewer = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  await withPage({ grants: viewer, overrides: { [`/api/players/${id}`]: profile } }, async (page, { errors }) => {
    const sent = [];
    await page.route(`**/api/players/${id}/tags**`, async (r) => {
      sent.push(r.request().method());
      await r.fulfill(filed(r.request().method() === "DELETE" ? "Remove a player tag" : "Add a player tag"));
    });
    await page.goto(`${page.url().split("#")[0]}#/players/~${id}`, { waitUntil: "networkidle" });
    await page.waitForSelector("button.ptag-add", { timeout: 15_000 });
    await page.locator('button.ptag-x[aria-label="Ask to remove flag"]').click();
    await page.waitForSelector("text=Sent for approval", { timeout: 10_000 });
    assert.deepEqual(sent, ["DELETE"], "the removal went to the API, to be filed there");

    // The page's arrangement can be asked for as everyone's starting point too.
    let layout = null;
    await page.route("**/api/layout/**", async (r) => {
      const body = r.request().postDataJSON?.() ?? null;
      if (r.request().method() !== "PUT" || body?.scope !== "instance") return r.continue();
      layout = body;
      await r.fulfill(filed("Change a screen's layout for everyone"));
    });
    await page.click("button.panel-reset");
    await page.locator(".panel-toolbar button", { hasText: "Ask to save as team default" }).click();
    await page.waitForFunction(() => /Sent for approval/.test(window.document.querySelector(".panel-toolbar")?.textContent || ""), null, { timeout: 10_000 });
    assert.equal(layout?.scope, "instance", "the team default went to the API, to be filed there");
    assert.doesNotMatch(await page.locator(".panel-toolbar").innerText(), /Error/, "a filed save is news, not an error");

    // And the dashboard's.
    layout = null;
    await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });
    await page.locator(".dash-head button", { hasText: "Edit layout" }).click();
    await page.locator(".dash-head button", { hasText: "Ask to save as team default" }).click();
    await page.waitForFunction(() => /Sent for approval/.test(window.document.querySelector(".dash-head")?.textContent || ""), null, { timeout: 10_000 });
    assert.equal(layout?.scope, "instance", "the dashboard's team default went to the API, to be filed there");
    assert.doesNotMatch(await page.locator(".dash-head").innerText(), /Error/, "a filed save is news, not an error");

    // And the menu's layout editor.
    layout = null;
    await page.click(".settings-trigger");
    await page.locator(".sm-item", { hasText: "Edit layout" }).click();
    const editor = page.locator(".card", { hasText: "Customize layout" });
    await editor.locator("button", { hasText: "Ask to save as team default" }).click();
    await page.waitForFunction(() => /Sent for approval/.test([...window.document.querySelectorAll(".card")].find((c) => /Customize layout/.test(c.textContent || ""))?.textContent || ""), null, { timeout: 10_000 });
    assert.equal(layout?.scope, "instance", "the menu editor's team default went to the API, to be filed there");
    assert.doesNotMatch(await editor.innerText(), /Error/, "a filed save is news, not an error");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("Data trim and Backup ask like every other screen: the notice, a filed trim or backup read as news, and a switch that was only asked for stays as it is", { skip: SKIP }, async () => {
  const viewer = [
    { capability: "admin.trim", scopeType: "global", scopeId: null, level: "read" },
    { capability: "admin.data", scopeType: "global", scopeId: null, level: "read" },
  ];
  const filed = (label) => ({ status: 202, contentType: "application/json", body: JSON.stringify({ requested: true, requestId: "req-1", label }) });
  await withPage({ grants: viewer, overrides: {
    "/api/data/backups": { body: { backups: [{ name: "backup-2026-10-01.ndjson.gz", createdAt: "2026-10-01T00:00:00.000Z", bytes: 2048 }] } },
    "/api/app-config": { body: { config: { autoBackupEnabled: false, autoBackupHour: 3, autoBackupKeep: 7, timezone: "UTC" } } },
    "/api/players/last-seen-drift": { body: { total: 2, sample: [] } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.route("**/api/trim", async (r) => (r.request().method() === "POST" ? r.fulfill(filed("Trim stored data")) : r.continue()));
    await page.route("**/api/players/last-seen-drift/repair", async (r) => r.fulfill(filed("Repair players' last-seen times")));
    await page.route("**/api/data/backup", async (r) => (r.request().method() === "POST" ? r.fulfill(filed("Make a backup")) : r.continue()));
    await page.route("**/api/data/backups/*", async (r) => (r.request().method() === "DELETE" ? r.fulfill(filed("Delete a backup")) : r.continue()));
    await page.route("**/api/data/export", async (r) => (r.request().method() === "POST" ? r.fulfill(filed("Export data")) : r.continue()));
    await page.route("**/api/app-config", async (r) => (r.request().method() === "PUT" ? r.fulfill(filed("Change the app-wide settings")) : r.continue()));
    const newsNotError = async (label) => {
      await page.waitForFunction((l) => window.document.body.innerText.includes(l), label, { timeout: 10_000 });
      assert.doesNotMatch(await page.locator("body").innerText(), /Error: Sent for approval/, `${label}: news, not an error`);
    };

    await page.goto(`${base}#/admin/trim`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=You don't hold the permission for changes here", { timeout: 15_000 });
    await page.locator(".trim-row", { hasText: "Kills" }).locator(".toggle").click();
    await page.locator("button.danger", { hasText: /Remove|Trim/ }).click();
    await page.locator(".confirm-modal button.danger").click();
    await newsNotError("Trim stored data");
    await page.locator("button", { hasText: "Check" }).last().click();
    await page.locator("button", { hasText: "Repair 2 player(s)" }).click();
    await page.locator(".confirm-modal button", { hasText: "Repair" }).click();
    await newsNotError("Repair players' last-seen times");

    await page.goto(`${base}#/admin/backup`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Create full backup now" }).click();
    await newsNotError("Make a backup");
    await page.locator("tr", { hasText: "backup-2026-10-01" }).locator("button", { hasText: "Delete" }).click();
    await page.locator(".confirm-modal button.danger").click();
    await newsNotError("Delete a backup");
    await page.locator("button", { hasText: "Select everything" }).click();
    await page.locator("button.primary", { hasText: /Export/ }).click();
    await newsNotError("Export data");

    // The nightly switch saves on flip: asked for, it must not show as switched on.
    const nightly = page.locator(".card", { hasText: "Nightly automatic backup" }).locator(".toggle input");
    assert.equal(await nightly.isChecked(), false);
    await page.locator(".card", { hasText: "Nightly automatic backup" }).locator(".toggle").click();
    await page.waitForFunction(() => /Change the app-wide settings/.test(window.document.body.innerText), null, { timeout: 10_000 });
    assert.equal(await nightly.isChecked(), false, "only asked for: the schedule still reads off");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the header's checkbox takes everything shown and its ⋯ acts on the lot", { skip: SKIP }, async () => {
  const two = { "/api/servers/s1/live": { body: {
    players: [
      { id: "p1", playerId: "76561198000000001", name: "TestGuy", team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 } },
      { id: "p2", playerId: "76561198000000002", name: "OtherGuy", team: 1, unit: "BAKER", role: "rifleman", level: 20, stats: { infantryKills: 0, vehicleKills: 0, deaths: 0, teamKills: 0 } },
    ],
    session: { playerCount: 2, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 1, remainingMatchTime: 100, matchTime: 10 },
  } } };
  await withPage({ grants: OWNER_GRANTS, overrides: two }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard thead", { timeout: 15_000 });

    const bulk = page.locator(".scoreboard thead .pa-menu button");
    // Nothing ticked: the menu is refused rather than offered and then doing nothing.
    assert.equal(await bulk.isDisabled(), true, "bulk ⋯ is disabled with an empty selection");

    await page.locator('.scoreboard thead input[type="checkbox"]').check();
    // Wait for the re-render rather than counting on the next tick. Asserting straight after the
    // click raced React's state update and failed about one run in three.
    await page.waitForFunction(() => window.document.querySelectorAll('.scoreboard tbody input[type="checkbox"]:checked').length === 2, null, { timeout: 10_000 });
    assert.match((await page.locator(".scoreboard-summary", { hasText: "selected" }).textContent()) ?? "", /2 selected/);

    await bulk.click();
    const items = await page.locator(".scoreboard thead .pa-dropdown .pa-mi").allTextContents();
    for (const want of ["Kick", "Temp ban", "Perma ban", "Switch team"]) {
      assert.ok(items.some((t) => t.includes(want)), `bulk menu offers ${want} — got ${items.join(" | ")}`);
    }
    // It says what it is about to hit. "Kick" reads very differently at 1 and at 90.
    assert.match((await page.locator(".scoreboard thead .pa-mi-head").textContent()) ?? "", /2 selected/);

    await page.locator(".scoreboard thead .pa-mi", { hasText: "Kick" }).click();
    assert.match((await page.locator(".pa-modal").textContent()) ?? "", /2 player/);
    await page.locator(".pa-modal .ghost").click();

    // Untick-all clears it again.
    await page.locator('.scoreboard thead input[type="checkbox"]').uncheck();
    await page.waitForFunction(() => window.document.querySelectorAll('.scoreboard tbody input[type="checkbox"]:checked').length === 0, null, { timeout: 10_000 });
  });
});

test("a ban with nothing ticked cannot be submitted", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: TWO_SERVERS }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    await page.locator(".pa-mi", { hasText: "Perma ban" }).click();
    await page.waitForSelector(".scope-pick");
    await page.locator(".pa-fields input").first().fill("cheating");

    // Untick the one server that was ticked. A ban aimed at no server would do nothing at all, so
    // the button says so rather than accepting the click and reporting a success that never
    // happened. ("Everywhere" cannot reach this state, which is rather the point of it.)
    await page.locator(".scope-chip.on").click();
    assert.equal(await page.locator(".scope-chip.on").count(), 0);
    assert.equal(await page.locator(".pa-actions button:not(.ghost)").isDisabled(), true);
    assert.match((await page.locator(".pa-modal .pa-blocked").textContent()) ?? "", /at least one server/, "the submit says why it is blocked");
  });
});

/**
 * Banning somebody who has never played here.
 *
 * The blacklist was the only surface that took a pasted id, and what it produced never reached the
 * game. Losing it would have cost the one case a ban record exists for: the cheater another
 * community warns you about, banned before they ever connect. This drives the Bans page's own
 * composer, from a raw id to the request on the wire.
 */
test("a player who has never connected can be banned from a pasted id", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: TWO_SERVERS }, async (page) => {
    const posted = [];
    await page.route("**/api/servers/*/actions", async (r) => {
      posted.push(JSON.parse(r.request().postData() ?? "{}"));
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, action: "permaban", results: [{ serverId: "s1", serverName: "#1", ok: true }, { serverId: "s2", serverName: "#2", ok: true }], applied: 2, failed: 0 }) });
    });
    await page.goto(`${page.url().split("#")[0]}#/moderation`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Ban a player…" }).click();
    await page.waitForSelector(".pa-modal");

    // A stranger: not in the directory, so the picker's raw-id escape hatch is the whole path.
    await page.locator(".pa-modal .picker input").fill("76561198000009999");
    // A real click, not a dispatched event: the option lives in a dropdown, and the thing this
    // regressed on before was a wrapper stealing the click before it reached the option.
    await page.locator(".picker-opt", { hasText: "as a raw id" }).click();
    assert.deepEqual(await page.locator(".picker-chip").allTextContents(), ["76561198000009999✕"], "the pasted id is picked");
    await page.locator(".scope-pick .seg-btn", { hasText: "Everywhere" }).first().click();
    // Once an id is picked the picker's own input is gone, so the reason is the first field left.
    await page.locator(".pa-fields input").first().fill("cheating — reported by a neighbouring community");
    await page.locator(".pa-actions button.danger").click();
    await page.waitForFunction(() => !window.document.querySelector(".pa-modal"), null, { timeout: 10_000 });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].action, "permaban");
    assert.equal(posted[0].playerId, "76561198000009999");
    assert.deepEqual(posted[0].scope, { mode: "all" }, "a pre-emptive ban reaches the servers they might turn up on");
  });
});

/**
 * The ban record's Platform column: the platform the game reported for each banned player, in the
 * same words the By platform analytics use, between Type and Where. A player the panel has never
 * seen has no platform on record and says so with a dash, and the column sorts like its
 * neighbours, A to Z with the unknowns last.
 */
test("the ban record shows each player's platform between Type and Where", { skip: SKIP }, async () => {
  const row = (id, name, platform) => ({ id, ts: "2026-08-01T00:00:00.000Z", by: "admin", playerName: name, playerId: `id-${id}`, platform, type: "perma", reason: "cheating", category: null, scope: { mode: "all" }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1", "s2"] });
  const overrides = {
    ...TWO_SERVERS,
    "/api/bans": { body: { bans: [
      row("b1", "Boxer", "EPlatformFamily::XboxSeries"),
      row("b2", "Stranger", null),
      row("b3", "Piper", "steam"),
      row("b4", "Sony", "ps5"),
    ] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    await page.locator(".nav-item", { hasText: "Moderation" }).first().click();
    await page.waitForSelector(".scroll-x table tbody tr", { timeout: 15_000 });
    const table = page.locator(".scroll-x table").first();
    const heads = (await table.locator("thead th").allTextContents()).map((t) => t.replace(/[^A-Za-z]/g, ""));
    const at = heads.indexOf("Platform");
    assert.ok(at > 0, `a Platform heading (got ${heads.join(", ")})`);
    assert.deepEqual(heads.slice(at - 1, at + 2), ["Type", "Platform", "Where"], "between Type and Where");
    const platformOf = async (name) => ((await table.locator("tbody tr", { hasText: name }).first().locator("td").nth(at).textContent()) ?? "").trim();
    assert.equal(await platformOf("Boxer"), "Xbox", "the game's enum name, said the way people say it");
    assert.equal(await platformOf("Piper"), "Steam (PC)");
    assert.equal(await platformOf("Sony"), "PlayStation");
    assert.equal(await platformOf("Stranger"), "—", "an id the panel has never seen has no platform to show");

    await table.locator("thead th", { hasText: "Platform" }).click();
    const names = async () => (await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => tr.querySelectorAll("td")[1]?.textContent?.trim() ?? "")));
    assert.deepEqual(await names(), ["Sony", "Piper", "Boxer", "Stranger"], "sorted by platform, A to Z, the unknown last");
  });
});

/**
 * A ban that is over says in its own row when it ended, and a lifted one who lifted it. Who lifted
 * it was a hover note a phone cannot show, and when was nowhere on the page: the row read "lifted"
 * and nothing more, so checking whether a player was still banned, and since when not, could not
 * be done from it.
 */
test("the ban record says in the row who lifted a ban and when, and when an expired one ran out", { skip: SKIP }, async () => {
  const row = (id, name, over) => ({
    id, ts: "2026-08-12T15:00:00.000Z", by: "BLACKLIST: Sam", playerName: name, playerId: `id-${id}`, platform: "xbl", type: "perma",
    reason: "Harassing our members", category: null, scope: { mode: "servers", serverIds: ["s1"] }, game: "hll",
    expiresAt: null, liftedAt: null, liftedBy: null, active: false, auto: false, serverIds: ["s1"], ...over,
  });
  const overrides = { "/api/bans": { body: { bans: [
    row("b1", "Lifted", { liftedAt: "2026-09-01T10:00:00.000Z", liftedBy: "Jordan" }),
    row("b2", "RanOut", { type: "temp", expiresAt: "2026-08-13T15:00:00.000Z" }),
    row("b3", "Standing", { active: true }),
  ] } } };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/moderation/bans`, { waitUntil: "networkidle" });
    await page.locator("label.toggle", { hasText: "Show lifted & expired" }).click();
    const last = (name) => page.locator(".scroll-x table tbody tr", { hasText: name }).first().locator("td").last();
    await last("Lifted").waitFor({ timeout: 15_000 });
    const said = async (name) => (await last(name).innerText()).replace(/\s+/g, " ").trim();
    assert.match(await said("Lifted"), /^lifted by Jordan · \S+/, "who lifted it, and when");
    assert.match(await said("RanOut"), /^expired \S+/, "when it ran out");
    assert.doesNotMatch(await said("RanOut"), / by /, "nobody lifted it");
    assert.equal(await last("Standing").getByRole("button", { name: "Unban" }).count(), 1, "one still in force can be lifted");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a server card's roster opens as itself, not on the Live view's search or locked side", { skip: SKIP }, async () => {
  /*
   * The Live view keeps its board's search and locked side for the sitting. The same board is each
   * server card's roster on the Servers page, and took them too: "View live" opened a server's
   * roster locked to a side and filtered to a name last used on another screen, and one card's
   * search was the next card's. The cards' rosters keep nothing; the Live view's keeps its own.
   */
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.locator(".team-side-head").first().click();
    await page.waitForSelector(".locked-head");
    await page.locator(".roster-search").first().fill("griefer");

    await page.goto(`${base}#/admin/connections`, { waitUntil: "networkidle" });
    await page.locator("button:text-is('View live')").first().click();
    await page.waitForSelector(".team-split", { timeout: 15_000 });
    assert.equal(await page.locator(".locked-head").count(), 0, "the card's roster is not locked to the Live view's side");
    assert.equal(await page.locator(".team-side").count(), 2, "both sides of it are there");
    assert.equal(await page.locator(".roster-search").first().inputValue(), "", "and it opens unsearched");

    await page.goto(`${base}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".locked-head", { timeout: 15_000 });
    assert.equal(await page.locator(".roster-search").first().inputValue(), "griefer", "the Live view's board keeps its own");
  });
});

test("the team split shows both sides at once and keeps them side by side on a phone", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.waitForSelector(".team-split");

    const sides = page.locator(".team-side");
    assert.equal(await sides.count(), 2, "one pane per side");
    // Allies pane holds the two allies, Axis pane the one axis player — not one merged list.
    assert.match((await sides.nth(0).textContent()) ?? "", /Griefer/);
    assert.ok(!/Jerry/.test((await sides.nth(0).textContent()) ?? ""), "the other team is not in this pane");
    assert.match((await sides.nth(1).textContent()) ?? "", /Jerry/);

    // The squad with no officer says so; the one with an officer does not.
    const noSl = page.locator(".team-squad-head .nosl");
    assert.equal(await noSl.count(), 1, "only BAKER is missing a leader");

    // The TK flag carries into this view too — the same rule, one shared helper.
    assert.equal(await page.locator(".team-row.tk-flag").count(), 1);

    // On a phone the panes must stay SIDE BY SIDE: stacking would destroy the comparison this
    // view exists for. They go off-screen instead, and the container scrolls to reach them.
    await page.setViewportSize({ width: 390, height: 780 });
    await page.waitForTimeout(150);
    const box = await sides.nth(0).boundingBox();
    const other = await sides.nth(1).boundingBox();
    assert.ok(box && other, "both panes still laid out");
    assert.ok(other.x >= box.x + box.width - 1, `panes stacked instead of staying side by side (${JSON.stringify({ box, other })})`);
    const scrolls = await page.locator(".team-split").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.ok(scrolls, "the container scrolls sideways to reach the second pane");
  });
});

test("locking a side hands it to the real table — the squad view for one team", { skip: SKIP }, async () => {
  // The lock does not render a wider version of the comparison row; it renders the scoreboard,
  // grouped by squad, filtered to that side. Anything less means reinventing sortable columns,
  // tick boxes and the bulk menu inside a component that exists to be narrow.
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.waitForSelector(".team-split");

    await page.locator(".team-side-head").first().click();
    await page.waitForSelector(".locked-head");
    assert.equal(await page.locator(".team-split").count(), 0, "the two-pane comparison is put away");

    // The full table, with the columns and the sortable headers.
    const head = page.locator(".scoreboard thead");
    assert.match((await head.textContent()) ?? "", /Player/);
    assert.match((await head.textContent()) ?? "", /K\/D/);
    assert.ok((await page.locator(".scoreboard thead th.sortable").count()) > 3, "headers still sort");
    // Grouped by squad, like the Squads layout.
    assert.ok((await page.locator(".scoreboard tr.squad-head").count()) > 0, "squad rows group it");
    // One team only — names, in a column that cannot be squeezed away.
    const body = (await page.locator(".scoreboard tbody").textContent()) ?? "";
    assert.match(body, /Griefer/);
    assert.ok(!/Jerry/.test(body), "the other side is not in the locked table");
    // The leaderless squad is called out here too, not only in the panes.
    assert.equal(await page.locator(".scoreboard tr.squad-head .nosl").count(), 0, "ABLE has its officer");

    // The bar above it names the side and is the way back.
    const bar = page.locator(".locked-head");
    assert.match((await bar.textContent()) ?? "", /Allies/);
    await bar.click();
    await page.waitForSelector(".team-split");
    assert.equal(await page.locator(".team-side").count(), 2, "both panes are back");
  });
});

/*
 * The Teams view as staff hold it on a phone: levels of one, two and three digits and one with
 * none, kills of one and two digits, two team-killers, a squad with a single kill, and a name too
 * long for its row.
 */
const PHONE_TEAMS = {
  ...TK_ROSTER,
  "/api/servers/s1/live": { body: {
    ...TK_ROSTER["/api/servers/s1/live"].body,
    players: [
      ...TK_ROSTER["/api/servers/s1/live"].body.players,
      { id: "p4", playerId: "76561198000000004", playerDbId: "db-4", name: "Oberleutnant Maximilian von Kraut", team: 1, unit: "ABLE", platoon: "ABLE", role: 0, level: 117, side: "allies", stats: { infantryKills: 10, vehicleKills: 0, deaths: 0, teamKills: 0 } },
      { id: "p5", playerId: "76561198000000005", playerDbId: "db-5", name: "Rookie", team: 1, unit: "CHARLIE", platoon: "CHARLIE", role: 9, level: 3, side: "allies", stats: { infantryKills: 1, vehicleKills: 0, deaths: 2, teamKills: 0 } },
      { id: "p6", playerId: "76561198000000006", playerDbId: "db-6", name: "Unranked", team: 1, unit: "CHARLIE", platoon: "CHARLIE", role: 0, side: "allies", stats: { infantryKills: 0, vehicleKills: 0, deaths: 0, teamKills: 0 } },
    ],
    session: { ...TK_ROSTER["/api/servers/s1/live"].body.session, playerCount: 6, alliedPlayerCount: 5 },
  } },
};

test("on a phone the Teams view shows one whole side at a time, its rows in line and its kills in words", { skip: SKIP }, async () => {
  /*
   * Staff called the view's text and spacing horrible on a phone, and it was: each pane kept a
   * 290px floor, so the other team hung 30px into view as a strip of role icons with no names; the
   * level and the K/D were as wide as their digits, so names and figures started and ended at a
   * different point on every row; a squad's kills read "5k"; a long name was cut mid-letter; and
   * the ⋯, grown for a thumb, stretched every row to 41px. It keeps its size, out of its own row's
   * padding and never the next row's: overlapping, a tap on one ⋯'s lower edge was the next
   * player's.
   */
  await withPage({ grants: OWNER_GRANTS, overrides: PHONE_TEAMS, viewport: PHONE }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.waitForSelector(".team-split");

    const layout = () => page.locator(".team-split").evaluate((split) => {
      const s = split.getBoundingClientRect();
      return {
        left: s.left, right: s.right, width: split.clientWidth,
        panes: [...split.querySelectorAll(".team-side")].map((p) => {
          const r = p.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, rowStart: p.querySelector(".team-row").firstElementChild.getBoundingClientRect().left };
        }),
      };
    });
    const at = await layout();
    assert.ok(at.panes[0].width >= at.width - 20 && at.panes[0].right <= at.right + 0.5, `one side takes the width it is given (${JSON.stringify(at)})`);
    assert.ok(at.panes[1].left >= at.right - 8, `of the other side, no more than its edge shows (${JSON.stringify(at)})`);
    assert.ok(at.panes[1].rowStart >= at.right, "and none of its rows");
    // One swipe settles on the other side, whole.
    await page.locator(".team-split").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await page.waitForTimeout(300);
    const swiped = await layout();
    assert.ok(swiped.panes[1].left >= swiped.left - 0.5 && swiped.panes[1].right <= swiped.right + 0.5, `the other side, all of it (${JSON.stringify(swiped)})`);

    const allies = page.locator(".team-side").first();
    assert.deepEqual(await allies.locator(".team-squad-sub").allTextContents(), ["23 kills", "1 kill"], "a squad's kills in words, and one kill as one");
    assert.equal((await allies.locator(".team-side-stats").textContent())?.trim(), "24 kills · 9 TK");

    const rows = await allies.locator(".team-row").evaluateAll((rs) => rs.map((r) => ({
      name: Math.round(r.querySelector(".team-row-name").getBoundingClientRect().left),
      kd: Math.round(r.querySelector(".team-row-kd").getBoundingClientRect().right),
      kdStart: Math.round(r.querySelector(".team-row-kd").getBoundingClientRect().left),
    })));
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows.map((r) => r.name)).size, 1, `every name starts in one line, whatever the level (${JSON.stringify(rows)})`);
    assert.equal(new Set(rows.map((r) => r.kd)).size, 1, `and every K/D ends in one, team kills or not (${JSON.stringify(rows)})`);
    assert.equal(new Set(rows.map((r) => r.kdStart)).size, 1, `in a column of one width, so the marks beside it line up too (${JSON.stringify(rows)})`);

    const long = await allies.locator(".team-row-name", { hasText: "Oberleutnant" }).evaluate((cell) => {
      const link = cell.querySelector(".player-link");
      const text = window.document.createRange();
      text.selectNodeContents(link);
      return { cell: cell.getBoundingClientRect().right, link: link.getBoundingClientRect().right, text: text.getBoundingClientRect().width, room: cell.clientWidth, ends: window.getComputedStyle(link).textOverflow };
    });
    assert.ok(long.text > long.room, `the name is longer than its row has room for (${JSON.stringify(long)})`);
    assert.ok(long.link <= long.cell + 0.5 && long.ends === "ellipsis", `so it is shortened with … in its space, not cut at the edge (${JSON.stringify(long)})`);

    const size = await allies.locator(".team-row").evaluateAll((rs) => rs.map((r) => {
      const dots = r.querySelector(".player-actions .ico-btn").getBoundingClientRect();
      return { row: r.getBoundingClientRect().height, dots: dots.height, top: dots.top, bottom: dots.bottom };
    }));
    assert.ok(size.every((s) => s.row <= 35), `a row no taller than its ⋯ and a line (${JSON.stringify(size)})`);
    assert.ok(size.every((s) => s.dots >= 34), `while the ⋯ keeps a thumb's size (${JSON.stringify(size)})`);
    assert.ok(size.every((s, i) => i === 0 || size[i - 1].bottom <= s.top + 0.5), `and no row's ⋯ lies over the next one's (${JSON.stringify(size)})`);
  });
});

test("a locked side on a phone: text at the page's sizes, and no column for what every row would repeat", { skip: SKIP }, async () => {
  /*
   * On an iPhone the locked side's squad headings came out about 1.6 times the size of the rows
   * under them, and its names larger than the numbers beside them. Safari enlarges text inside
   * anything wider than the screen, and on a phone the table is. The page turns that off; a browser
   * that never enlarges shows the sizes it sets. The Team column said "Allies" on every row under a
   * bar saying it, the squad column repeated each heading, and between them they held the names
   * off a phone's screen.
   */
  await withPage({ grants: OWNER_GRANTS, overrides: PHONE_TEAMS, viewport: PHONE }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.locator(".team-side-head").first().click();
    await page.waitForSelector(".locked-head");

    const heads = (await page.locator(".scoreboard thead th").allTextContents()).map((t) => t.trim());
    assert.ok(heads.includes("Player") && heads.includes("K/D"), `still the table (${heads.join(" | ")})`);
    assert.ok(!heads.includes("Team") && !heads.includes("Squad"), `without a column for what the bar and the headings say (${heads.join(" | ")})`);
    assert.equal(await page.locator(".scoreboard tr.squad-head .team-tag").count(), 0, "nor the side's tag on every squad");
    const subs = (await page.locator(".scoreboard tr.squad-head .squad-sub").allTextContents()).map((t) => t.trim());
    assert.match(subs[0] ?? "", /^· 23 kills ·/);
    assert.match(subs[1] ?? "", /^· 1 kill ·/, "one kill as one");
    assert.equal((await page.locator(".locked-head .team-side-stats").textContent())?.trim(), "24 kills · 9 TK");

    const adjust = await page.evaluate(() => {
      const cs = (el) => window.getComputedStyle(el);
      const heading = window.document.querySelector(".scoreboard tr.squad-head td");
      const name = window.document.querySelector(".scoreboard tbody tr:not(.squad-head) .player-link");
      return [heading, name].map((el) => [cs(el).getPropertyValue("-webkit-text-size-adjust"), cs(el).getPropertyValue("text-size-adjust")]);
    });
    assert.deepEqual(adjust, [["100%", "100%"], ["100%", "100%"]], "and the phone may not enlarge the headings or the names past the page's sizes");
    // Rows as short as their ⋯ allows, with no row's ⋯ over the next one's: a tap is one player's.
    const rows = await page.locator(".scoreboard tbody tr:not(.squad-head)").evaluateAll((trs) => trs.map((tr) => {
      const dots = tr.querySelector(".player-actions .ico-btn").getBoundingClientRect();
      return { row: tr.getBoundingClientRect().height, dots: dots.height, top: dots.top, bottom: dots.bottom };
    }));
    assert.ok(rows.every((r) => r.row <= 35 && r.dots >= 34), `rows of 35px at most, each ⋯ still 34px (${JSON.stringify(rows)})`);
    assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].bottom <= r.top + 0.5), `and no row's ⋯ lies over the next one's (${JSON.stringify(rows)})`);
  });
});

test("the roster can be searched, by anyone who can see it", { skip: SKIP }, async () => {
  /*
   * The most-used control on the tool this replaced: staff get a name in Discord and need to know
   * whether that player is on right now. The answer was previously "read a hundred rows".
   *
   * Runs on a read-only grant on purpose. The filter row used to render only for staff who could
   * act on a player, which made narrowing the roster down a permission rather than a reading aid.
   */
  const viewer = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  await withPage({ grants: viewer, overrides: TK_ROSTER }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    const rows = page.locator(".scoreboard tbody tr");
    assert.equal(await rows.count(), 3, "all three players to begin with");

    const search = page.locator(".roster-search").first();
    await search.fill("jerry"); // wrong case, and it still lands
    await page.waitForFunction(() => window.document.querySelectorAll(".scoreboard tbody tr").length === 1, null, { timeout: 5_000 });
    assert.match(await page.locator(".roster-filters").innerText(), /1 of 3/, "says how much of the roster is left");

    // The clan tag is the other half of "who from LYNX is on".
    await search.fill("BAKER");
    await page.waitForFunction(() => window.document.querySelectorAll(".scoreboard tbody tr").length === 1, null, { timeout: 5_000 });

    // A miss is an answer — "not on right now" — not a broken screen.
    await search.fill("nobodyhere");
    await page.waitForSelector(".empty-state", { timeout: 5_000 });
    assert.match(await page.locator(".empty-state").innerText(), /nobodyhere/, "the empty state repeats what was searched for");

    await search.fill("");
    await page.waitForFunction(() => window.document.querySelectorAll(".scoreboard tbody tr").length === 3, null, { timeout: 5_000 });
  });
});

test("on a desktop monitor the page uses the screen instead of a 1120px column", { skip: SKIP }, async () => {
  /*
   * Reported from a real desktop: "it only fills half my screen when fullscreen… I don't have to
   * scroll to the side to see all the stats". The main column was capped at 1120px, which was set
   * when this app was mostly forms. The result on a wide monitor was the worst of both: the Live
   * roster — eighteen columns of numbers — scrolling sideways inside its share of 1120px, with
   * more than a thousand pixels of empty screen beside it.
   */
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER }, async (page) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    await page.waitForTimeout(150);

    const box = await page.locator("main.content").boundingBox();
    const sidebar = await page.locator("aside").first().boundingBox();
    const available = 1920 - (sidebar?.width ?? 0);
    assert.ok(
      box.width > available - 24,
      `the column left ${Math.round(available - box.width)}px of the screen unused (${Math.round(box.width)} of ${Math.round(available)})`,
    );

    // The point of the width: the stats are readable without a sideways scroll.
    const scrolls = await page.locator(".scroll-x.roster").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.ok(!scrolls, "the roster still scrolls sideways on a 1920px screen");

    // Prose still gets a measure — filling 1900px with a paragraph is its own kind of broken.
    await page.goto(`${page.url().split("#")[0]}#/announcements`, { waitUntil: "networkidle" });
    await page.waitForSelector("main.content.reading", { timeout: 10_000 });
    const reading = await page.locator("main.content").boundingBox();
    assert.ok(reading.width < available - 200, `the noticeboard did not keep a reading measure (${Math.round(reading.width)}px)`);

    /*
     * Fixed-geometry charts stop growing too. An SVG with a viewBox and `width: 100%` scales its
     * whole drawing to the container, so uncapping the column turned the week heatmap into 50px
     * slabs with headline-sized day names and the hour histogram into a wall. A wider box shows
     * more of a time series; it shows nothing more of 168 squares.
     */
    await page.goto(`${page.url().split("#")[0]}#/analytics/server`, { waitUntil: "networkidle" });
    const heat = page.locator(".viz-svg").first();
    await heat.waitFor({ timeout: 10_000 });
    const chart = await heat.boundingBox();
    const panel = await page.locator(".panel").first().boundingBox();
    assert.ok(chart.width < panel.width * 0.7, `the heatmap scaled to fill its panel (${Math.round(chart.width)} of ${Math.round(panel.width)})`);

    /*
     * And the same rule for form controls, which is where this kept coming back. A text box at
     * `width: 100%` takes whatever its grid cell offers, so uncapping the column produced an 850px
     * field for a Discord channel id and a 1,260px one holding the number 2. The ceiling lives on
     * the control now rather than on each container, so the check is a sweep rather than a spot.
     */
    for (const hash of ["#/discord/relay", "#/admin/users"]) {
      await page.goto(`${page.url().split("#")[0]}${hash}`, { waitUntil: "networkidle" });
      await page.waitForSelector("main.content label > input:not([type=checkbox]):not([type=radio])", { timeout: 10_000 });
      const stretched = await page.evaluate(() => {
        const rem = parseFloat(window.getComputedStyle(window.document.documentElement).fontSize);
        const cap = (el) => (el.tagName === "TEXTAREA" ? 60 : el.type === "number" ? 12 : 34) * rem;
        return [...window.document.querySelectorAll("main.content input, main.content select, main.content textarea")]
          .filter((el) => !el.classList.contains("wide") && el.getBoundingClientRect().width > 0)
          .map((el) => ({ tag: el.tagName, type: el.type, w: Math.round(el.getBoundingClientRect().width), cap: Math.round(cap(el)) }))
          .filter((f) => f.w > f.cap + 2);
      });
      assert.deepEqual(stretched, [], `${hash}: controls stretched past their measure — ${JSON.stringify(stretched)}`);
    }

    // Capping them left room beside the label, which the layout used: label, field and hint all ran
    // onto one line. A field inside a label still starts its own line.
    const stacked = await page.evaluate(() => {
      const el = [...window.document.querySelectorAll("main.content label > input")].find((i) => i.type !== "checkbox" && i.type !== "radio");
      return el ? window.getComputedStyle(el).display : null;
    });
    assert.equal(stacked, "block", "a field inside a label no longer starts its own line");
  });
});

/*
 * The one that matters most. The move handler calls preventDefault to suppress the browser's own
 * pull-to-refresh, and a preventDefault on the wrong gesture makes the page impossible to scroll —
 * a failure that would affect every screen on every phone, all the time.
 */
test("pull to refresh: ordinary scrolling still scrolls", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: PHONE }, async (page) => {
    await page.evaluate(() => { window.document.body.style.minHeight = "3000px"; });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.scrollY), 0, "starts at the top");

    // Upward drag = scroll down. Starts at the top, which is exactly where the pull gesture is
    // armed, so this is the case that would break if direction were not checked.
    await touchDrag(page, 200, 600, 200);
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => window.scrollY) > 0, "the page scrolled");
  });
});

test("phone: no screen hides content off the right edge", { skip: SKIP }, async () => {
  // One destination per hub, plus the tabs added most recently — the screens where a wide table is
  // most likely and least likely to have been looked at on a phone.
  const screens = [
    "#/dashboard", "#/live", "#/history/logs", "#/history/matches",
    "#/players", "#/players/vips", "#/players/leaderboard",
    "#/events/schedule", "#/events/payouts", "#/events/report",
    "#/moderation/bans", "#/moderation/messages", "#/moderation/kicks", "#/moderation/punishments",
    "#/maps/rotation", "#/admin/users", "#/admin/broadcast", "#/admin/system",
  ];
  await withPage({ grants: OWNER_GRANTS, viewport: PHONE, overrides: WIDE_ROWS }, async (page, { errors }) => {
    const offenders = [];
    const titles = [];
    for (const hash of screens) {
      await page.goto(`${page.url().split("#")[0]}${hash}`, { waitUntil: "networkidle" });
      // The panels render from fetches; give the skeletons a beat to become real content.
      await page.waitForTimeout(150);
      const bad = await page.evaluate(overflowingElements);
      for (const b of bad) offenders.push(`${hash}: ${b}`);
      for (const t of await page.evaluate(clippedPanelTitles)) titles.push(`${hash}: "${t}"`);
    }
    assert.deepEqual(offenders, [],
      "these are cut off on a phone screen with no way to scroll to them — wrap wide content in .scroll-x:\n" + offenders.join("\n"));
    assert.deepEqual(titles, [],
      "these panel titles were squeezed to an ellipsis — the subtitle beside them is what should give up the space:\n" + titles.join("\n"));
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The zone rule's set picker said "No zone sets yet — paint one first" when the list failed to load,
 * and the clan rule's chips "No clan tags recorded yet". (The role gates beside them are the role
 * list's, and say a failed read like every other role picker.)
 */
test("the rule editor's zone sets and clan tags say when they couldn't be read", { skip: SKIP }, async () => {
  const down = { status: 500, body: { error: "the database is not answering" } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/enforcer/rules": { body: { rules: [], activity: {} } }, "/api/zones": down, "/api/clans": down, "/api/discord/roles": down } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/rules`, { waitUntil: "networkidle" });
    await page.click('button:has-text("New rule")');
    // Its role gates, too: their fallback sends staff to set up the bot.
    const gate = page.locator("details", { hasText: "Only for players holding" }).first();
    await gate.locator("summary").click();
    await gate.getByText("Couldn't read the Discord role list").waitFor({ timeout: 10_000 });
    await page.selectOption('label:has-text("On event") select', "live-roster");
    await page.selectOption('label:has-text("Live roster check") select', "app.state.out_of_zone");
    await page.getByText("Couldn't read the zone sets").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No zone sets yet").count(), 0);
    await page.selectOption('label:has-text("Live roster check") select', "app.state.clan_tag");
    await page.getByText("Couldn't read the clan tags").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No clan tags recorded yet").count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A ratio of this match's counts — kills, deaths, team kills — built in the rule editor: the pair,
 * which way, a limit with decimals and the minimum, saved as the server stores them. A saved one's
 * card says which ratio, which way and the limit.
 */
test("rules: a ratio check sets two of this match's counts against a limit", { skip: SKIP }, async () => {
  const stored = {
    id: "r9", name: "Team killers", serverId: null, sectionId: null, enabled: true, eventKind: "app.state.ratio", match: null,
    threshold: 1, windowSec: 60, action: "kick", reason: null, hours: null, delaySec: 0, vipMinutes: 10, vipCooldownMinutes: 60,
    requireRoleIds: [], params: { ratio: "teamkills:kills", direction: "above", limit: 2, minCount: 10 },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/enforcer/rules": { body: { sections: [], rules: [stored], activity: {}, now: new Date().toISOString() } } } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/rules`, { waitUntil: "networkidle" });
    await page.locator(".subcard", { hasText: "Team killers" }).getByText("a player's team kills to kills is at or above 2 (live roster)").waitFor({ timeout: 10_000 });
    await page.click('button:has-text("New rule")');
    const form = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: /^New rule/ }) });
    const field = (label) => form.locator("label").filter({ hasText: label });
    await form.locator('label:has-text("Name") input').first().fill("Feeders");
    await page.selectOption('label:has-text("On event") select', "live-roster");
    await page.selectOption('label:has-text("Live roster check") select', "app.state.ratio");
    // It starts where a new ratio rule does: team kills to kills, at or above 2, from 10 counts.
    assert.equal(await field(/^Ratio/).locator("select").inputValue(), "teamkills:kills");
    assert.equal(await field(/^Fires when it is/).locator("select").inputValue(), "above");
    assert.equal(await field(/^Limit/).locator("input").inputValue(), "2");
    assert.equal(await field(/^Only once the two add up/).locator("input").inputValue(), "10");
    // A phone offers a decimal point for the limit, and the form takes one.
    assert.equal(await field(/^Limit/).locator("input").getAttribute("inputmode"), "decimal");
    await field(/^Ratio/).locator("select").selectOption("kills:deaths");
    await field(/^Fires when it is/).locator("select").selectOption("below");
    await field(/^Limit/).locator("input").fill("0.25");
    await field(/^Only once the two add up/).locator("input").fill("15");
    await form.locator('button:has-text("Create rule")').click();
    const saved = () => stub.calls.filter((c) => c.method === "POST" && c.path === "/api/enforcer/rules");
    for (let i = 0; i < 150 && !saved().length; i++) await page.waitForTimeout(100);
    assert.equal(saved().length, 1, "saved once");
    assert.equal(saved()[0].body.eventKind, "app.state.ratio");
    assert.deepEqual(saved()[0].body.params, { ratio: "kills:deaths", direction: "below", limit: 0.25, minCount: 15 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/* The nightly backup card used to vanish when its settings couldn't be read. */
test("the backup screen says when the nightly schedule couldn't be read", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/data/options": { body: { supported: true, groups: [] } },
    "/api/data/backups": { body: { backups: [] } },
    "/api/app-config": { status: 500, body: { error: "the database is not answering" } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/admin/backup`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the nightly backup schedule").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Which notifications come is decided on the server, from the account's copy. A choice that never
 * reached it stayed on screen as made, and the notification it promised never came.
 */
test("a phone notification choice that couldn't be saved goes back, and says why", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/me/push": (url) => (url ? { body: { key: PUSH_KEY, devices: [] } } : undefined),
    "/api/me/prefs": (url, req) => (req.method === "PUT" ? { status: 500, body: { error: "the database is not answering" } } : undefined),
  } }, async (page, { stub, errors }) => {
    await page.addInitScript(fakePush);
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").click();
    await page.waitForFunction(() => window.__push.sub !== null);
    const choice = page.getByRole("checkbox", { name: "A player asks for an admin in chat" });
    assert.equal(await choice.isChecked(), false);
    await page.locator(".phone-alerts label.toggle", { hasText: "A player asks for an admin in chat" }).click();
    await page.getByText("Couldn't save your notification choices").waitFor({ timeout: 10_000 });
    assert.equal(await choice.isChecked(), false, "not shown as chosen");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/* A badge whose read failed offers nothing to change: an upload over it would replace a badge nobody saw. */
test("a match board badge that couldn't be read says so, with nothing to upload over it", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/discord/board-badge": (url, req) => (req.method === "GET" ? { status: 500, body: { error: { message: "the database is not answering" } } } : undefined),
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/discord/relay`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { hasText: "Match board badge" });
    await panel.getByText("Couldn't read the badge: the database is not answering").waitFor({ timeout: 10_000 });
    assert.equal(await panel.locator("input[type=file]").count(), 0, "nothing to upload over it");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A dashboard whose layout couldn't be read said "Your dashboard is empty" and offered Widgets and
 * Edit layout — whose saves wrote that empty list over the layout nobody had read.
 */
test("a dashboard whose layout couldn't be read says so, with nothing to save over it", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/layout/dashboard": { status: 500, body: { error: "the database is not answering" } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/dashboard`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read your dashboard layout").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("Your dashboard is empty").count(), 0);
    const head = page.locator(".dash-head");
    assert.equal(await head.getByRole("button", { name: "Widgets" }).count(), 0, "no card picker");
    assert.equal(await head.getByRole("button", { name: "Edit layout" }).count(), 0, "no layout editor");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Each VIP preset row was held to one line, and on a 360px phone it ran past the screen's edge:
 * the hours box and Delete were cut off, out of reach.
 */
test("VIP presets fit a phone: each row's hours and Delete stay on screen", { skip: SKIP }, async () => {
  const presets = [
    { id: "v1", kind: "add", label: "Help skip queue", days: 0, hours: 6 },
    { id: "v2", kind: "add", label: "1 month", days: 30, hours: 0 },
  ];
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: { "/api/vip-presets": { body: { presets } } } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/admin/vippresets`, { waitUntil: "networkidle" });
    const deletes = page.getByRole("button", { name: "Delete" });
    await deletes.first().waitFor({ timeout: 10_000 });
    assert.equal(await deletes.count(), 2);
    for (const b of await deletes.all()) assert.ok((await rightEdge(b)) <= 360, `Delete ends at ${await rightEdge(b)}px on a 360px screen`);
    for (const h of await page.getByRole("spinbutton", { name: "Hours" }).all()) assert.ok((await rightEdge(h)) <= 360, `an hours box ends at ${await rightEdge(h)}px`);
    assert.ok((await rightEdge(page.getByRole("button", { name: "Add" }).first())) <= 360, "and the new preset's Add");
    // Kept on one line by squeezing, the name box would be a sliver: it gets a line of its own.
    for (const l of await page.locator('input[aria-label="Label"]').all()) {
      const w = (await l.boundingBox())?.width ?? 0;
      assert.ok(w >= 200, `a preset's name box is ${Math.round(w)}px wide`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A profile's Nemeses and Squadmates lists sat in columns that would not narrow below their
 * longest name: one long name pushed the lists past a phone's edge, cutting off the name and the
 * count beside it.
 */
test("a long name in a profile's Nemeses wraps on a phone, and its count stays on screen", { skip: SKIP }, async () => {
  const long = "ThisIsAVeryLongPlayerNameThatGoesOnAndOnAndOn";
  const combat = {
    window: { events: 12, matches: 1, firstEventAt: "2026-10-20T10:00:00.000Z" }, rates: { kpm: 0.5, dpm: 0.4 },
    killTypes: [], deathTypes: [], melee: { kills: 0, deaths: 0, lastDeath: null },
    streaks: { bestKillstreak: 2, currentKillstreak: 0, bestDeathstreak: 1 },
    mostKilled: [{ playerId: "p2", name: "Smith", count: 2 }], mostDiedTo: [{ playerId: "p3", name: long, count: 3 }],
    playedWith: [], playedAgainst: [], faction: { allies: 1, axis: 0, alliesPct: 1 },
    maps: [], modes: [], servers: [], rolling: [],
  };
  const profile = { body: {
    player: { id: "p1", platformId: "76561198000000001", platform: "steam", name: "Subject", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
    stats: { kills: 1, deaths: 1, teamkills: 0, playtimeSec: 60, visits: 1 },
    flags: {}, recentEvents: [], sessions: [], aliases: [], matches: [], canViewNotes: false, notes: [], combat,
  } };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: { "/api/players/p1": profile } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/players/~p1`, { waitUntil: "networkidle" });
    const nemeses = page.locator(".panel", { hasText: "Most died to" });
    await nemeses.getByText(long).waitFor({ timeout: 10_000 });
    assert.ok((await rightEdge(nemeses.getByText(long))) <= 360, `the long name ends at ${await rightEdge(nemeses.getByText(long))}px`);
    assert.ok((await rightEdge(nemeses.getByText("×3"))) <= 360, `its count ends at ${await rightEdge(nemeses.getByText("×3"))}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("rules: moving a rule out of a switched-off section asks before it starts firing, and removing that section says its rules stay off", { skip: SKIP }, async () => {
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
      "/api/enforcer/sections/assign": { body: { moved: 1, sectionId: "sec1" } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector("text=night tk");

    // Into "Event rules", which is on: nothing would hold it, so the move asks first.
    await page.click('button:has-text("Select rules")');
    await page.check('input[aria-label="Select night tk"]');
    await page.click('.rule-select-bar button:has-text("Move")');
    const modal = page.locator(".confirm-modal");
    await modal.waitFor();
    assert.match(await modal.innerText(), /Start "night tk" firing\?/);
    assert.match(await modal.innerText(), /held by its section's switch, which is off/);
    await modal.locator("button", { hasText: /^Cancel$/ }).click();
    assert.ok(!stub.calls.some((c) => c.path === "/api/enforcer/sections/assign"), "cancelled: nothing moved");
    await page.click('.rule-select-bar button:has-text("Move")');
    await page.locator(".confirm-modal button", { hasText: /^Move anyway$/ }).click();
    await page.waitForFunction(() => !window.document.querySelector(".rule-select-bar"));
    assert.deepEqual(stub.calls.find((c) => c.path === "/api/enforcer/sections/assign")?.body, { ruleIds: ["r2"], sectionId: "sec1" });

    // Removing the switched-off section: its rule that is on is switched off, not set firing — said before.
    const night = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Night rules" }) });
    await night.locator('button:has-text("Remove")').click();
    await modal.waitFor();
    assert.match(await modal.innerText(), /switched off and holding it, so it is switched off one by one — nothing starts firing/);
    await modal.locator("button", { hasText: /^Cancel$/ }).click();
  });
});

test("rules: Pause asks how long and why, and a paused rule says who paused it, until when, with Resume now", { skip: SKIP }, async () => {
  const rule = (id, name, over = {}) => ({
    id, name, serverId: null, sectionId: null, enabled: true, eventKind: "evt.teamkill", match: null, threshold: 1,
    windowSec: 0, action: "kick", reason: null, hours: null, delaySec: 0, vipMinutes: 10,
    vipCooldownMinutes: 60, requireRoleIds: [], ...over,
  });
  const now = new Date().toISOString();
  const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: {
        sections: [],
        rules: [
          rule("r1", "tk kick"),
          rule("r2", "chat spam", { pausedUntil: until, pauseReason: "event night", pausedBy: "Ana" }),
        ],
        activity: {}, now,
      } },
      "/api/enforcer/rules/r1/pause": { body: { rule: rule("r1", "tk kick") } },
      "/api/enforcer/rules/r2/pause": { body: { rule: rule("r2", "chat spam") } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector("text=chat spam");
    // The paused rule says so — who, until when, why — and is not reported as quiet.
    const spam = page.locator(".subcard", { hasText: "chat spam" });
    assert.equal(await spam.locator("text=paused · back").count(), 1);
    assert.equal(await spam.locator("text=Paused by Ana").count(), 1);
    assert.equal(await spam.locator("text=event night").count(), 1);
    assert.equal(await spam.locator("text=quiet 7d").count(), 0);
    assert.equal(await spam.locator('button:has-text("Pause")').count(), 0, "no second pause on a paused rule");
    await spam.locator('button:has-text("Resume now")').click();
    await page.waitForSelector('text="chat spam" is back on');
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.path === "/api/enforcer/rules/r2/pause"));

    // Pausing asks how long and why — no reason, no pause.
    const tk = page.locator(".subcard", { hasText: "tk kick" });
    await tk.locator('button:has-text("Pause")').click();
    const form = tk.locator(".rule-pause-form");
    await form.locator('button:has-text("2 hours")').click();
    assert.equal(await form.locator('button[type=submit]').isDisabled(), true, "a reason first");
    await form.locator("input").fill("server event");
    await form.locator('button[type=submit]').click();
    await page.waitForSelector('text=Paused "tk kick"');
    const call = stub.calls.find((c) => c.method === "POST" && c.path === "/api/enforcer/rules/r1/pause");
    assert.deepEqual(call?.body, { minutes: 120, reason: "server event" });
  });
});

test("rules: History lists each save in words and puts an earlier version back; Recently deleted brings a rule back", { skip: SKIP }, async () => {
  const rule = (id, name, over = {}) => ({
    id, name, serverId: null, sectionId: null, enabled: true, eventKind: "evt.teamkill", match: null, threshold: 3,
    windowSec: 60, action: "kick", reason: null, hours: null, delaySec: 0, vipMinutes: 10,
    vipCooldownMinutes: 60, requireRoleIds: [], ...over,
  });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: { sections: [], rules: [rule("r1", "TK kick")], activity: {}, now: new Date().toISOString() } },
      "/api/enforcer/rules/r1/versions": { body: { versions: [
        { id: "v1", change: "edit", targetId: "r1", targetName: "TK kick", actorName: "Ana", createdAt: at,
          before: { name: "TK kick", threshold: 2, action: "message", escalateActions: [], enabled: true },
          after: { name: "TK kick", threshold: 3, action: "kick", escalateActions: ["tempban"], enabled: false } },
      ] } },
      "/api/enforcer/versions/v1/restore": { body: { rule: rule("r1", "TK kick", { threshold: 2, action: "message" }) } },
      "/api/enforcer/deleted-rules": { body: { deleted: [
        { id: "v9", change: "delete", targetId: "r9", targetName: "Night TK", actorName: "Bob", createdAt: at, before: { name: "Night TK" }, after: null },
      ] } },
      "/api/enforcer/versions/v9/restore": { status: 201, body: { rule: rule("r9", "Night TK") } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector("text=TK kick");
    const card = page.locator(".subcard", { hasText: "TK kick" });
    await card.locator('button:has-text("History")').click();
    await card.locator(".version-row").first().waitFor();
    const text = await card.locator(".rule-history").innerText();
    assert.match(text, /Ana changed it/);
    assert.match(text, /Count: 2 → 3/);
    assert.match(text, /Action: message → kick/, "steps read by their labels");
    assert.match(text, /Then, on repeat: added temp ban|Then, on repeat: added tempban/);
    assert.doesNotMatch(text, /On:|enabled/, "the rule's own switch is not part of the story");
    await card.locator('button:has-text("Restore the version before this")').click();
    await page.locator(".confirm-modal button", { hasText: /^Restore$/ }).click();
    await page.waitForSelector("text=Restored the earlier version");
    assert.ok(stub.calls.some((c) => c.method === "POST" && c.path === "/api/enforcer/versions/v1/restore"));

    await page.click('button:has-text("Recently deleted")');
    const deleted = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Recently deleted rules" }) });
    await deleted.locator("text=Night TK").waitFor();
    assert.match(await deleted.innerText(), /deleted by Bob/);
    await deleted.locator('button:has-text("Restore")').click();
    await page.waitForSelector('text=Brought back "Night TK"');
    assert.ok(stub.calls.some((c) => c.method === "POST" && c.path === "/api/enforcer/versions/v9/restore"));
  });
});

/*
 * The escalation ladder's two field bugs, both found on a phone. A ladder whose ban is only a
 * RUNG ("message, then ban") offered no Ban hours field anywhere — the editor decided the field
 * off the first action and tempban rungs only, so every such ban was silently permanent with no
 * way to set removal hours. And the "then <action>" chips refused to shrink (a select sizes to
 * its longest option; min-width:auto held the whole chip to it), so the opened editor marched
 * off the right edge at phone width and dragged the page wide with it.
 */
test("rule editor: a ladder ban gets the hours field, and the ladder fits a phone", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: {
      "/api/enforcer/rules": { body: { rules: [{
        id: "r1", name: "chat conduct", serverId: null, enabled: true, eventKind: "evt.chat.team",
        match: "slur", threshold: 1, windowSec: 0, action: "message", reason: "watch it",
        hours: null, delaySec: 0, vipMinutes: 10, vipCooldownMinutes: 60, requireRoleIds: [],
        escalateActions: ["message", "blacklist"], escalateResetMinutes: 120,
      }], activity: {} } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector("text=chat conduct");

    // The rule's sentence resolves the ban the way THIS rule will do it — no hours saved, so the
    // ladder's ban reads "permanent ban", not the editor's conditional "temp with hours" label.
    assert.match(await page.locator(".subcard .muted").first().innerText(), /then permanent ban on repeat/);

    await page.click('.subcard button:has-text("Edit")');
    await page.waitForSelector(".rule-escalation");

    // The ladder's ban reads the one rule-level hours, so the editor must offer them even though
    // no step is a tempban and the first action isn't a ban.
    assert.equal(await page.locator('label:has-text("Ban hours (blank = permanent ban)")').count(), 1,
      "a full-ban ladder step exposes the removal-hours field");

    // And the opened editor — long-labelled ladder chips included — stays inside the phone.
    const { doc, view } = await page.evaluate(() => {
      const root = window.document.documentElement;
      return { doc: root.scrollWidth, view: root.clientWidth };
    });
    assert.ok(doc <= view, `the opened rule editor is ${doc}px wide in a ${view}px viewport`);
  });
});

/*
 * Folding the live roster's checks into one choice changed the picker, not the rules: each rule
 * stores its check's own kind, as it always did. A rule saved on any check opens under live roster
 * with that check picked, and saves back the same check with the same settings.
 */
test("rules saved on a live roster check open on that check and save back unchanged", { skip: SKIP }, async () => {
  const checks = {
    "app.state.no_leader": { minSquadSize: 3 },
    "app.state.low_level": { minLevel: 30 },
    "app.state.role_level": { roles: [11], minLevel: 60 },
    "app.state.bad_role": { disallowedRoles: [12], allowedRoles: [] },
    "app.state.bad_name": { bannedSubstrings: "slur", blockUrls: true, bannedPattern: "" },
    "app.state.solo_tank": { tankRoles: [11, 12], minCrew: 3 },
    "app.state.solo_heli": { heliRoles: [16, 17], minCrew: 2 },
    "app.state.out_of_zone": { zoneSet: "z1", keepOut: true, exemptRoles: [] },
    "app.state.no_vip": { minMinutesOnline: 15 },
    "app.state.playtime": { hours: 50, periodDays: 30, allServers: true },
    "app.state.no_discord": { minMinutesOnline: 10 },
    "app.state.kill_rate": { minKills: 40, killsPer10Min: 30, minKd: 5 },
    "app.state.ratio": { ratio: "teamkills:deaths", direction: "above", limit: 1.5, minCount: 20 },
    "app.state.clan_tag": { clans: ["ABC"] },
  };
  const rules = Object.entries(checks).map(([eventKind, params], i) => ({
    id: `r${i}`, name: `Check ${String(i).padStart(2, "0")}`, serverId: null, sectionId: null, enabled: true, eventKind, match: null,
    threshold: 1, windowSec: 120, action: "message", reason: "{violation}", hours: null, delaySec: 0, vipMinutes: 10,
    vipCooldownMinutes: 60, requireRoleIds: [], params,
  }));
  const overrides = { "/api/enforcer/rules": { body: { sections: [], rules, activity: {}, now: new Date().toISOString() } } };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/rules`, { waitUntil: "networkidle" });
    for (const r of rules) {
      const card = page.locator(".subcard", { hasText: r.name });
      await card.locator('button:has-text("Edit")').click();
      const form = card.locator("form");
      assert.equal(await form.locator('label:has-text("On event") select').inputValue(), "live-roster", `${r.eventKind} opens under live roster`);
      assert.equal(await form.locator('label:has-text("Live roster check") select').inputValue(), r.eventKind, `${r.eventKind} opens on its own check`);
      await form.locator('button[type="submit"]').click();
      const saved = () => stub.calls.filter((c) => c.method === "PATCH" && c.path === `/api/enforcer/rules/${r.id}`);
      for (let i = 0; i < 150 && !saved().length; i++) await page.waitForTimeout(100);
      assert.equal(saved().length, 1, `${r.eventKind} saved`);
      assert.equal(saved()[0].body.eventKind, r.eventKind, "the same check");
      assert.deepEqual(saved()[0].body.params, r.params, "the same settings");
      assert.equal(saved()[0].body.windowSec, 120, "the same re-check interval");
      await form.waitFor({ state: "detached", timeout: 10_000 });
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The player-rule scenarios live in the Rules engine now — Rules is the one place server rule
 * customization comes from. The hub carries no per-module tabs, and picking a state trigger in
 * the rule editor opens that trigger's own knobs (roles, minimum crew, population floor).
 */
test("auto settings: state triggers live in the Rules editor; no module tabs remain", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: { rules: [], activity: {} } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    // Gone is only said of tabs that have been drawn: looked for before the bar was, they passed
    // whether or not they were there.
    await page.locator('.hub-tabs button:has-text("Rules")').waitFor();
    for (const gone of ["Player rules", "No solo tank", "No squad leader"]) {
      assert.equal(await page.locator(`.hub-tabs button:has-text("${gone}")`).count(), 0, `"${gone}" is not a hub tab any more`);
    }
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.click('button:has-text("New rule")');
    // On event offers the live roster as one choice, and its checks in a list beside it…
    const offered = await page.locator('label:has-text("On event") select option').evaluateAll((os) => os.map((o) => o.value));
    assert.ok(offered.includes("live-roster"), "the live roster is a choice");
    assert.deepEqual(offered.filter((k) => k.startsWith("app.state.")), [], "its checks are not listed one by one beside the events");
    await page.selectOption('label:has-text("On event") select', "live-roster");
    await page.selectOption('label:has-text("Live roster check") select', "app.state.solo_tank");
    // …and picking one opens its own knobs: the tank-role chips and the minimum crew.
    await page.waitForSelector('text=Tank roles');
    await page.waitForSelector('text=Minimum crew');
    // Population bounds and the safety valve live on the RULE, beside active hours — for every
    // trigger kind, not inside one trigger's params.
    await page.waitForSelector('text=Active from (players');
    await page.waitForSelector('text=Safety limit');
    await page.waitForSelector('text=Only during set hours');
    // The state pacing replaces the event-count controls.
    assert.equal(await page.locator('text=Threshold (matches)').count(), 0, "a persisting state is paced, not counted");
    await page.waitForSelector('text=Re-check interval (seconds)');
  });
});

/*
 * The rule filter's list belongs to the rules permission. Staff here for seeding or auto settings
 * alone were refused it on every visit to the History tab; they are not asked for it now, and the
 * history reads as before.
 */
test("auto settings History asks for the rule list only from those who may read the rules", { skip: SKIP }, async () => {
  const seedingOnly = [{ capability: "seeding.config", scopeType: "global", scopeId: null, level: "read" }];
  await withPage({
    grants: seedingOnly,
    overrides: {
      "/api/automation/history": { body: { entries: [
        { id: "e2", ts: "2026-09-01T20:02:00.000Z", actorName: "seeding", action: "seed.warn", targetName: "Arty", targetId: "p2", serverId: "s1", summary: "warned Arty — artillery while seeding", data: null },
      ], total: 1 } },
    },
  }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/history`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=warned Arty — artillery while seeding");
    assert.equal(stub.calls.filter((c) => c.path === "/api/enforcer/rules").length, 0, "the rules list is not asked for");
    assert.equal(await page.locator('select:has(option:has-text("— every rule —"))').count(), 0, "and no rule filter is offered");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A file fetched or sent on the Backup screen said only "download failed (409)" when it was
 * refused, where the API had said why.
 */
test("Backup: a refused download or upload says why", { skip: SKIP }, async () => {
  const refused = (message) => ({ status: 409, body: { error: { code: "conflict", message } } });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/data/options": { body: { supported: true, groups: [{ id: "players", label: "Players", hint: "every player" }] } },
    "/api/data/backups": { body: { backups: [{ name: "full-backup-20261001-000000.ndjson.gz", createdAt: "2026-10-01T00:00:00.000Z", bytes: 2048 }] } },
    "/api/data/status": { body: { run: { status: "done", kind: "export", rows: 5, file: "data-export.ndjson.gz", fileBytes: 2048 }, upload: null } },
    "/api/data/download": refused("the export is still being written — wait for it to finish"),
    "/api/data/backups/full-backup-20261001-000000.ndjson.gz": refused("this backup is still being written — wait for it to finish"),
    "/api/data/upload": (url, req) => (req.method === "POST" ? refused("an export, import or upload is already in progress") : undefined),
  } }, async (page, { stub, errors }) => {
    const panel = (title) => page.locator("section.panel", { has: page.locator(".panel-title", { hasText: title }) });
    await page.goto(`${stub.base}/#/admin/backup`, { waitUntil: "networkidle" });
    await panel("Export").locator("button", { hasText: "Download archive" }).click();
    await panel("Export").getByText("Error: the export is still being written — wait for it to finish").waitFor({ timeout: 10_000 });
    await panel("Full backup").locator("tr", { hasText: "full-backup-20261001" }).locator("button", { hasText: "Download" }).click();
    await panel("Full backup").getByText("Error: this backup is still being written — wait for it to finish").waitFor({ timeout: 10_000 });
    await panel("Import").locator('input[type="file"]').setInputFiles({ name: "data-export.ndjson.gz", mimeType: "application/gzip", buffer: Buffer.from([0x1f, 0x8b, 0, 0]) });
    await panel("Import").getByText("Error: an export, import or upload is already in progress").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A list that has not been read is not an empty one. The roles, the team on Staff activity, the
 * message presets and the zone sets each said there were none while their read was on its way.
 */
test("lists say there are none only once they have been read", { skip: SKIP }, async () => {
  const slow = (body) => ({ delayMs: 2000, body });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/roles": slow({ roles: [] }),
    "/api/audit/staff": slow({ staff: [] }),
    "/api/templates": slow({ templates: [] }),
    "/api/zones": slow({ sets: [], maps: [] }),
  } }, async (page, { stub, errors }) => {
    // Where the panel is the list's own, it says it is loading, and counts nothing yet.
    for (const [route, panel, empty, loading] of [
      ["admin/users", "Roles", "No roles defined yet", true],
      ["admin/activity", "The team", "No staff actions recorded yet", true],
      ["moderation/messages", "Message everyone", "No presets saved yet", false],
      ["autosettings/zones", "Zone sets", "No zone sets yet for this game", false],
    ]) {
      await page.goto(`${stub.base}/#/${route}`);
      const own = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: panel }) }).first();
      await own.waitFor({ timeout: 10_000 });
      assert.equal(await page.getByText(empty).count(), 0, `${route}: not said while the list is on its way`);
      if (loading) {
        assert.equal(await own.locator(".skeleton").count(), 1, `${route}: said to be loading instead`);
        assert.equal(await own.locator(".panel-subtitle").count(), 0, `${route}: and no count of none`);
      }
      await page.getByText(empty).first().waitFor({ timeout: 10_000 });
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Shareable walkthrough links. "Go through the watchlist one" used to mean describing where to
 * click; a walkthrough's Copy link gives #/help/start/~<id>, which opens it. A link that cannot open
 * says why, rather than leaving the list on screen as if nothing had happened: one to a How do I
 * guide, pasted before the guides were taken out, among them.
 */
test("help: a shared walkthrough link opens it, or says why it cannot", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    // From a cold start: the link waits for the permissions, then opens its walkthrough.
    await page.goto(`${base}?visit=1#/help/start/~watch-player`, { waitUntil: "networkidle" });
    const watch = page.getByRole("dialog", { name: "Put a player on the watchlist" });
    await watch.getByText("Step 1 of", { exact: false }).waitFor({ timeout: 10_000 });
    // Its Copy link gives the walkthrough's own address, which opens it in turn.
    await page.evaluate(() => {
      window.copied = [];
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { window.copied.push(t); } } });
    });
    await watch.getByRole("button", { name: "🔗 Copy link" }).click();
    await watch.getByRole("button", { name: "✓ Copied" }).waitFor();
    const [link] = await page.evaluate(() => window.copied);
    assert.equal(link, `${base}?visit=1#/help/start/~watch-player`);
    await page.keyboard.press("Escape");
    await watch.waitFor({ state: "detached" });
    await page.goto(`${base}?visit=2#/help/start/~give-vip`, { waitUntil: "networkidle" });
    await page.getByRole("dialog", { name: "Give a player VIP" }).getByText("Step 1 of", { exact: false }).waitFor({ timeout: 10_000 });
    // The How do I guides are gone: a link to one lands on Start here, opens nothing, and says so.
    await page.goto(`${base}?visit=3#/help/guides/~watch-a-player`, { waitUntil: "networkidle" });
    await page.getByText("names a walkthrough that is no longer here", { exact: false }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("dialog").count(), 0, "nothing opened");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  // Giving VIP is not theirs to follow, and a walkthrough that is no longer here: each says so.
  await withPage({ grants: [held("server.view", "read")] }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}?visit=1#/help/start/~give-vip`, { waitUntil: "networkidle" });
    await page.getByText("covers something your permissions don't include", { exact: false }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("dialog").count(), 0, "nothing opened");
    await page.goto(`${base}?visit=2#/help/guides/~no-such-guide`, { waitUntil: "networkidle" });
    await page.getByText("names a walkthrough that is no longer here", { exact: false }).waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A round is seventy-odd rows, and halfway down nobody remembers which column is deaths and which
 * is defence. On a phone the table scrolls sideways inside its card, so a CSS sticky header would
 * stick to that card, never to the screen: the column header is pinned to the top of the SCREEN
 * instead, lined up with the columns and following them sideways. The page itself must fit the
 * phone too: it laid out ~650px wide (the page grid's auto column grew to the table's width), so
 * the whole page panned and the table's own sideways scroller never engaged.
 */
test("public round page on a phone: fits the screen, and the column header follows you down", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [
      { key: "combat", label: "CBT", title: "Combat" }, { key: "offense", label: "OFF", title: "Offense" },
      { key: "defense", label: "DEF", title: "Defense" }, { key: "support", label: "SUP", title: "Support" },
    ],
    squadLabel: "Squad",
  };
  const player = (id) => ({
    id, player_id: null, player: `[LYNX] Player Number ${id}`, platform: null, kills: 70 - id, deaths: id % 20, teamkills: id % 3,
    kill_death_ratio: (70 - id) / Math.max(1, id % 20), combat: 300 + id, offense: id * 10, defense: 400, support: 40,
    time_seconds: 3000, kills_streak: 5, team: { side: id % 2 ? "allies" : "axis" }, weapons: {}, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-10-11T21:13:11.000Z", end: "2026-10-11T21:50:00.000Z", map_name: "carentan_offensive_ger",
    map: { pretty_name: "Carentan", game_mode: "Offensive" }, result: { allied: 1, axis: 4 },
    player_stats: Array.from({ length: 70 }, (_, i) => player(i + 1)),
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    const [docW, viewW] = await page.evaluate(() => [window.document.documentElement.scrollWidth, window.innerWidth]);
    assert.deepEqual([docW, viewW], [390, 390], "the page lays out at the phone's width; only the table scrolls sideways");
    assert.equal(await page.locator(".sb-float").count(), 0, "nothing is pinned while the table's own header is on screen");

    // Down the table: the header is pinned to the top, each label over its column.
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForSelector(".sb-float", { timeout: 5_000 });
    const scroller = "table.scoreboard tbody";
    const lineUp = () => page.evaluate((sel) => {
      const float = window.document.querySelector(".sb-float");
      const kills = [...float.querySelectorAll("th")].find((t) => /^K\b(?!\/)/.test(t.textContent.trim()));
      const row = [...window.document.querySelectorAll(`${sel} tr`)].find((r) => r.getBoundingClientRect().top > 60);
      // K is the second column: the side is the row's colour now, not a column of its own.
      return { top: float.getBoundingClientRect().top, head: kills.getBoundingClientRect().left, cell: row.children[1].getBoundingClientRect().left };
    }, scroller);
    let at = await lineUp();
    assert.equal(Math.round(at.top), 0, "pinned to the top of the screen");
    assert.ok(Math.abs(at.head - at.cell) < 1, `K sits over its column: header ${at.head}, cell ${at.cell}`);

    // Sideways, it follows the table.
    await page.evaluate((sel) => { window.document.querySelector(sel).closest("div").scrollLeft = 120; }, scroller);
    await page.waitForFunction(() => window.document.querySelector(".sb-float")?.scrollLeft === 120, null, { timeout: 5_000 });
    at = await lineUp();
    assert.ok(Math.abs(at.head - at.cell) < 1, `still over its column after scrolling sideways: header ${at.head}, cell ${at.cell}`);

    // The pinned copy sorts like the real header, and shows the newly sorted list from its top,
    // where the real header takes over again. (The browser's scroll anchoring used to chase a
    // re-sorted row instead and land the page wherever that row went.)
    await page.locator(".sb-float th", { hasText: /^D$/ }).click();
    await page.waitForFunction(() => [...window.document.querySelectorAll("table.scoreboard thead th")].some((t) => t.textContent.trim() === "D ↓"), null, { timeout: 5_000 });
    await page.waitForSelector(".sb-float", { state: "detached", timeout: 5_000 });
    const headTop = await page.evaluate((sel) => window.document.querySelector(sel).closest("table").querySelector("thead").getBoundingClientRect().top, scroller);
    assert.ok(Math.abs(headTop) < 2, `the sorted list starts at the top of the screen: its header is at ${headTop}`);
    assert.equal(await page.locator(`${scroller} tr`).first().locator("td").nth(2).innerText(), "19", "sorted by deaths, most first");

    // Back at the top of the page it stays aside.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".sb-float").count(), 0);
  });
});

/*
 * The scoreboard carries a row's side as its colour — a bar down its edge and the name in that
 * side's ink — rather than a column a phone cannot spare, and a side filter names the sides with
 * their head counts.
 */
test("public scoreboard: a side filter, and each row wearing its side", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const row = (id, name, side) => ({
    id, player_id: null, player: name, platform: null, kills: 10 - id, deaths: 2, teamkills: 0, kill_death_ratio: 1,
    combat: 0, offense: 0, defense: 0, support: 0, time_seconds: 600, kills_streak: 1, team: { side },
    weapons: {}, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan Warfare" }, result: { allied: 2, axis: 3 },
    player_stats: [row(1, "Smith", "allies"), row(2, "Jones", "axis"), row(3, "Brown", "axis")],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    const names = () => page.locator("table.scoreboard tbody td.pub-sb-name strong").allInnerTexts();
    assert.deepEqual(await page.locator(".pub-sb-tools .seg-btn").allInnerTexts(), ["All 3", "Allies 1", "Axis 2"], "each side named, with its head count");
    assert.deepEqual(await page.locator("table.scoreboard thead th").allInnerTexts().then((t) => t.slice(0, 2)), ["PLAYER", "K ↓"].map((x) => x),
      "no side column: the name, then the numbers");

    // Each row wears its side: a bar down its edge and the name in its ink.
    const marks = await page.locator("table.scoreboard tbody tr").evaluateAll((rows) => rows.map((r) => [
      r.querySelector("td.pub-sb-name strong").textContent,
      r.querySelector("td.pub-sb-name").style.boxShadow,
      r.querySelector("td.pub-sb-name strong").style.color,
    ]));
    for (const [name, bar, ink] of marks) {
      const side = name === "Smith" ? "blue" : "red";
      assert.ok(bar.includes(`--side-${side}`) && ink.includes(`--side-${side}`), `${name} wears ${side}: ${bar} / ${ink}`);
    }

    await page.locator(".pub-sb-tools .seg-btn", { hasText: "Axis" }).click();
    assert.deepEqual(await names(), ["Jones", "Brown"], "one side's board");
    await page.locator(".pub-sb-tools .seg-btn", { hasText: "Axis" }).click();
    assert.equal((await names()).length, 3, "the same button lets go of it");
    await page.fill('input[aria-label="Find a player"]', "smi");
    assert.deepEqual(await names(), ["Smith"]);
    assert.ok((await page.locator(".pub-sb-tools").innerText()).includes("1 of 3"), "a search says how many it kept");
  });
});

/*
 * A team kill rides the report wire as its own mark ("t"), never as a kill: the kill race counts a
 * player's kills alone, and their personal timeline marks the team kill with a triangle where it
 * happened, without stepping the line up.
 */
test("public round page: a team kill is marked on the timeline and never raced as a kill", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const row = (id, name, side, kills, teamkills) => ({
    id, player_id: null, player: name, platform: null, kills, deaths: 1, teamkills, kill_death_ratio: kills,
    combat: 0, offense: 0, defense: 0, support: 0, time_seconds: 600, kills_streak: kills, team: { side },
    weapons: {}, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:10:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan Warfare" }, result: { allied: 1, axis: 4 },
    player_stats: [row(1, "Arty", "axis", 2, 1), row(2, "Riley", "axis", 3, 0), row(3, "Smith", "allies", 1, 0)],
  };
  const life = { killsStreak: 1, deathsWithoutKillStreak: 1, longestLifeSecs: 60, shortestLifeSecs: 20, deathsByTk: 0 };
  const report = {
    complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [], duels: [], awards: [],
    timeline: [{ minute: 0, allies: 1, axis: 3 }, { minute: 1, allies: 0, axis: 2 }],
    players: {
      Arty: { ...life, side: "axis", timeline: [[30, "k", "Smith", "MG42"], [60, "t", "Riley", "MG42"], [90, "k", "Smith", "MG42"]] },
      Riley: { ...life, side: "axis", timeline: [[20, "k", "Smith", "KAR98K"], [40, "k", "Smith", "KAR98K"], [60, "d", "Arty", "MG42"], [80, "k", "Smith", "KAR98K"]] },
      Smith: { ...life, side: "allies", timeline: [[10, "k", "Riley", "M1 GARAND"], [20, "d", "Riley", "KAR98K"]] },
    },
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/report/5": { body: { report } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5/report`, { waitUntil: "networkidle" });
    await page.waitForSelector('svg[aria-label="Every player\'s kills over the round"]', { timeout: 10_000 });
    const race = await page.locator("body").innerText();
    assert.ok(/Arty · 2/.test(race) && !/Arty · 3/.test(race), "the race finishes Arty on their two kills, not three");
    assert.ok(/Riley · 3/.test(race));

    // Arty's own round: two steps up, and the team kill as its own mark between them.
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.locator("table.scoreboard tbody tr", { hasText: "Arty" }).first().click();
    await page.waitForSelector('svg[aria-label="Kills over the round"]', { timeout: 10_000 });
    assert.equal(await page.locator(".tl-tk").count(), 1, "the team kill is marked");
    const ticks = await page.locator('svg[aria-label="Kills over the round"] text.tick').allTextContents();
    assert.ok(ticks.includes("2") && !ticks.includes("3"), `the line tops out at two kills: ${ticks.join(", ")}`);
  });
});

/*
 * CRCON keys a row's most_killed and death_by by the other player's id, so a server that publishes
 * ids sends ids there. The drill-in names each one from that player's row on the same board, and
 * an id with no row is an unknown player, never a string of hex. A names-only server's keys are
 * names already and show as they come.
 */
test("public scoreboard: Most killed and Died to name the players, though the wire keys them by id", { skip: SKIP }, async () => {
  const ARTY = "a1b2c3d4e5f60718293a4b5c6d7e8f90", SMITH = "c0ffee00c0ffee00c0ffee00c0ffee00", GONE = "deadbeefdeadbeefdeadbeefdeadbeef";
  const row = (id, playerId, name, side, mostKilled, deathBy) => ({
    id, player_id: playerId, player: name, platform: null, kills: 3, deaths: 1, teamkills: 0, kill_death_ratio: 3,
    combat: 0, offense: 0, defense: 0, support: 0, time_seconds: 600, kills_streak: 2, team: { side },
    weapons: {}, most_killed: mostKilled, death_by: deathBy,
  });
  const drillIn = async (playerIds, rows) => {
    const server = {
      slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds,
      sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
      scoreFields: [], squadLabel: "Squad",
    };
    const round = {
      id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:10:00.000Z", map_name: "carentan_warfare",
      map: { pretty_name: "Carentan Warfare" }, result: { allied: 1, axis: 4 }, player_stats: rows,
    };
    const overrides = {
      "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
      "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    };
    let text = "";
    await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
      await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
      await page.locator("table.scoreboard tbody tr", { hasText: "Arty" }).first().click();
      const detail = page.locator("table.scoreboard td[colspan]", { hasText: "Most killed" });
      await detail.waitFor({ timeout: 10_000 });
      text = await detail.innerText();
    });
    return text;
  };

  const published = await drillIn(true, [
    row(1, ARTY, "Arty", "axis", { [SMITH]: 2, [GONE]: 1 }, { [SMITH]: 1 }),
    row(2, SMITH, "Smith", "allies", { [ARTY]: 1 }, { [ARTY]: 2 }),
  ]);
  assert.ok(/Most killed\s+Smith ×2\s+Unknown player ×1\s+Died to\s+Smith ×1/.test(published), `names, not ids: ${published}`);
  assert.ok(!published.includes(SMITH) && !published.includes(GONE), "no other player's id is printed");
  assert.ok(published.includes(ARTY), "the row's own id still shows in its Player id box");

  const namesOnly = await drillIn(false, [
    row(1, null, "Arty", "axis", { Smith: 2 }, { Smith: 1 }),
    row(2, null, "Smith", "allies", { Arty: 1 }, { Arty: 2 }),
  ]);
  assert.ok(/Most killed\s+Smith ×2\s+Died to\s+Smith ×1/.test(namesOnly), `a names-only board's keys show as they come: ${namesOnly}`);
});

test("staff match page: each score gets a chart behind the kills chart's switch", { skip: SKIP }, async () => {
  const match = {
    id: "m1", serverId: "s1", serverName: "Test Server #1", map: "Foy Warfare",
    startedAt: "2026-07-01T10:00:00.000Z", endedAt: "2026-07-01T10:40:00.000Z",
    winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIED (5 - 0)",
    sectorLayout: null, sectorLayoutBy: null, sectorLayoutAt: null,
  };
  const body = {
    match,
    stats: [{ matchId: "m1", playerId: "p1", playerName: "Arty", side: "allies", kills: 1, deaths: 1, teamkills: 0, combat: 260, offense: 20, defense: 0, support: 15, slSeconds: 0 }],
    report: {
      complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [], timeline: [{ minute: 0, allies: 1, axis: 0 }], duels: [], awards: [],
      players: {
        p1: {
          side: "allies", weapons: [], deathByWeapons: [], mostKilled: [], deathBy: [], timeline: [[30, "k", "X", "M1 GARAND"]],
          killsStreak: 1, deathsWithoutKillStreak: 1, longestLifeSecs: 60, shortestLifeSecs: 20, deathsByTk: 0,
          scores: [[120, 40, 0, 0, 10], [300, 260, 20, 0, 15]],
        },
      },
    },
  };
  const overrides = {
    "/api/matches/m1": { body },
    "/api/games/hll/descriptor": { body: { descriptor: { ...HLL_DESCRIPTOR, scoreFields: SCORE_FIELDS } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    await page.locator("tr.row-expandable", { hasText: "Arty" }).first().click();
    await page.locator('svg[aria-label="Kills over the round"]').waitFor({ timeout: 10_000 });
    await page.locator('.seg[aria-label="Chart"] button', { hasText: "Cbt" }).click();
    await page.locator('svg[aria-label="Combat score over the round"]').waitFor({ timeout: 5_000 });
    const ticks = await page.locator('svg[aria-label="Combat score over the round"] text.tick').allTextContents();
    assert.ok(ticks.includes("260"), `the staff drill-in draws the same chart: ${ticks.join(", ")}`);
  });
});

/*
 * The kill race races each score too, behind a switch over the chart: the same crowd of lines,
 * coloured by side, the leaders named where they finish, off the score points each player's own
 * charts draw. A score runs to four digits where kills run to two, so on a phone the axis has to
 * make room for the number at its top.
 */
test("public round report: the kill race races each score behind a switch", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: SCORE_FIELDS, squadLabel: "Squad",
  };
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:20:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan Warfare" }, result: { allied: 1, axis: 4 }, player_stats: [],
  };
  const life = { killsStreak: 1, deathsWithoutKillStreak: 1, longestLifeSecs: 60, shortestLifeSecs: 20, deathsByTk: 0 };
  const report = {
    complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [], duels: [], awards: [],
    timeline: [{ minute: 0, allies: 2, axis: 1 }],
    players: {
      Arty: { ...life, side: "axis", timeline: [[30, "k", "Smith", "MG42"]], scores: [[120, 40, 0, 0, 10], [600, 1240, 20, 0, 15]] },
      Medic: { ...life, side: "axis", timeline: [], scores: [[120, 0, 0, 0, 150], [600, 0, 0, 0, 480]] },
      Smith: { ...life, side: "allies", timeline: [[10, "k", "Arty", "M1 GARAND"], [50, "k", "Medic", "M1 GARAND"]], scores: [[300, 300, 0, 60, 0]] },
      // A wide name with a four-digit total: the longest end label a phone has to fit.
      "[LYNX] Wolverine": { ...life, side: "allies", timeline: [], scores: [[600, 1100, 0, 0, 0]] },
    },
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/report/5": { body: { report } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5/report`, { waitUntil: "networkidle" });
    const race = (noun) => page.locator(`svg[aria-label="Every player's ${noun} over the round"]`);
    const tab = (label) => page.locator('.seg[aria-label="Race"] button', { hasText: label });
    const card = page.locator(".card", { hasText: "The kill race" });
    await race("kills").waitFor({ timeout: 10_000 });
    assert.deepEqual(await page.locator('.seg[aria-label="Race"] button').allInnerTexts(), ["Kills", "Cbt", "Off", "Def", "Sup"],
      "kills first, then the scoreboard's own score columns");
    assert.ok((await card.innerText()).includes("every player's kills and scores over the round"));
    let text = await card.innerText();
    assert.ok(/Smith · 2/.test(text) && /Arty · 1/.test(text) && /2 players finished with no kills/.test(text));

    await tab("Cbt").click();
    await race("combat score").waitFor({ timeout: 5_000 });
    assert.equal(await race("kills").count(), 0, "one race at a time");
    text = await card.innerText();
    assert.ok(/Arty · 1240/.test(text) && /Smith · 300/.test(text) && / · 1100/.test(text), `the leaders named at their combat totals: ${text}`);
    assert.ok(/3 lines/.test(text) && /1 player finished with no combat score/.test(text), "no combat score, no line, and the note says so");
    const fit = await race("combat score").evaluate((svg) => {
      const right = svg.getBoundingClientRect().right;
      return [...svg.querySelectorAll("text.race-label")].map((t) => [t.textContent, t.getBoundingClientRect().right <= right + 0.5]);
    });
    assert.ok(fit.length === 3 && fit.every(([, inside]) => inside), `every end label fits inside the chart: ${JSON.stringify(fit)}`);
    // The top of the axis reads whole, inside the chart, on a phone.
    const top = race("combat score").locator("text.tick", { hasText: "1240" });
    assert.equal(await top.count(), 1, "the axis tops out at the round's best combat total");
    const [svgBox, tickBox] = [await race("combat score").boundingBox(), await top.boundingBox()];
    assert.ok(tickBox.x >= svgBox.x, `the 1240 at the axis top starts inside the chart (${tickBox.x} vs ${svgBox.x})`);

    await tab("Sup").click();
    await race("support score").waitFor({ timeout: 5_000 });
    text = await card.innerText();
    assert.ok(/Medic · 480/.test(text) && /Arty · 15/.test(text) && /2 players finished with no support score/.test(text),
      "a medic with no kills races on their support");

    await tab("Kills").click();
    await race("kills").waitFor({ timeout: 5_000 });
  });
});

test("public stats: every screen's APIs button lists each public API the screen reads, with its link and output", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: APIS_OVERRIDES }, async (page, { stub }) => {
    const seen = new Set();
    page.on("request", (req) => { const p = dataPath(req.url()); if (p) seen.add(p); });
    const screens = ["", "/alpha", "/alpha/report", "/alpha/log", "/alpha/games", "/alpha/games/5", "/alpha/games/5/report",
      "/alpha/games/5/log", "/alpha/server", "/alpha/player/76561198000000001"];
    for (const screen of screens) {
      seen.clear();
      await page.goto(`${stub.base}/stats${screen}`, { waitUntil: "networkidle" });
      // What the screen itself asked for, before the panel asks for anything. The servers list and
      // the home-screen manifest belong to the site around every screen, not to the screen.
      const read = [...seen].filter((p) => screen === "" || (p !== "/api/public/servers" && p !== "/api/public/webmanifest"));
      assert.ok(read.length > 0, `${screen || "/"} reads something`);
      const button = page.locator("button.pub-apis-btn:visible");
      assert.equal(await button.count(), 1, `${screen || "/"}: one APIs button in sight`);
      await button.click();
      const dialog = page.locator('[role="dialog"][aria-label="APIs for this screen"]');
      await dialog.waitFor({ timeout: 5_000 });
      const listed = (await dialog.locator(".pub-api-url code").allTextContents()).map((u) => {
        assert.ok(u.startsWith(stub.base), `a full link, ready to paste: ${u}`);
        return dataPath(u);
      });
      for (const p of read) assert.ok(listed.includes(p), `${screen || "/"} reads ${p}, so its APIs list has it: ${JSON.stringify(listed)}`);
      // Each one shows what it answers now.
      await page.waitForFunction(() => [...window.document.querySelectorAll(".pub-api-out")].every((e) => e.textContent !== "Loading…"), null, { timeout: 5_000 });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached", timeout: 5_000 });
    }
  });
});

// Opened on the panel's own host, the page still hands out the public address: the admin
// hostname never rides a link someone copies for a streamer.
test("public stats APIs panel: its links carry the site's public address, not the host it was opened on", { skip: SKIP }, async () => {
  const overrides = { ...APIS_OVERRIDES, "/api/public/servers": { body: { site: { name: "Lynx", origin: "https://stats.example" }, servers: [APIS_SERVER] } } };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games`, { waitUntil: "networkidle" });
    await page.locator("button.pub-apis-btn:visible").click();
    const entry = page.locator(".pub-api", { hasText: "get_scoreboard_maps" });
    await entry.waitFor({ timeout: 5_000 });
    const link = "https://stats.example/stats/alpha/api/get_scoreboard_maps?page=1&limit=25";
    assert.equal(await entry.locator(".pub-api-url code").textContent(), link);
    assert.equal(await entry.locator("a.pub-api-open").getAttribute("href"), link, "Open goes there too");
    const urls = await page.locator(".pub-api-url code").allTextContents();
    assert.ok(urls.every((u) => u.startsWith("https://stats.example/")), `no link names the host the page was opened on: ${urls.join(", ")}`);
    // The replies are still read from where the page is.
    await entry.locator(".pub-api-out").filter({ hasNotText: "Loading…" }).waitFor({ timeout: 5_000 });
  });
});

test("public stats APIs button on a phone: in the top bar, and the panel closes from its ✕", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: APIS_OVERRIDES, viewport: { width: 390, height: 844 } }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "networkidle" });
    const inBar = page.locator("header.topbar button.pub-apis-btn");
    assert.ok(await inBar.isVisible(), "the top bar carries it on a phone");
    assert.equal(await page.locator(".pub-toolbar").isVisible(), false, "and the wide screen's row stands down");
    const box = await inBar.boundingBox();
    assert.ok(box.x + box.width > 390 - 40, `at the top right: ${JSON.stringify(box)}`);
    await inBar.click();
    const dialog = page.locator('[role="dialog"][aria-label="APIs for this screen"]');
    await dialog.waitFor({ timeout: 5_000 });
    const sheet = await dialog.boundingBox();
    assert.ok(sheet.width >= 389, `the panel takes the phone's width: ${sheet.width}`);
    await dialog.locator("button.pub-apis-close").click();
    await dialog.waitFor({ state: "detached", timeout: 5_000 });
  });
});

/*
 * Each player's level has its own column after their name, as the panel's live view has one:
 * "Lvl", coloured on the same scale (red under 20, yellow, green, blue, purple from 350), and
 * sortable like the rest. A player the round never saw a level for gets an empty cell; a board with
 * no levels at all has no column.
 */
test("public scoreboard: a Lvl column after the name, as the live view has, on its colour scale", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const row = (id, name, level, kills) => ({
    id, player_id: null, player: name, platform: null, level, kills, deaths: 2, teamkills: 0, kill_death_ratio: kills / 2,
    combat: 0, offense: 0, defense: 0, support: 0, time_seconds: 600, kills_streak: 1, team: { side: "axis" },
    weapons: {}, most_killed: {}, death_by: {},
  });
  const board = async (rows, sortByLevel = false) => {
    const round = {
      id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:10:00.000Z", map_name: "carentan_warfare",
      map: { pretty_name: "Carentan Warfare" }, result: { allied: 1, axis: 4 }, player_stats: rows,
    };
    const overrides = {
      "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
      "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    };
    const read = (page) => page.evaluate(() => {
      const table = [...window.document.querySelectorAll("table.scoreboard")].find((t) => t.querySelector("tbody"));
      return {
        head: [...table.querySelectorAll("thead th")].map((th) => th.textContent.replace(/[↓↑]/g, "").trim()),
        rows: [...table.querySelectorAll("tbody tr")].map((tr) => {
          const name = tr.querySelector("td.pub-sb-name");
          const next = name.nextElementSibling;
          return { name: name.querySelector("strong")?.textContent, numberInName: /\d/.test(name.textContent), next: [next.textContent, next.querySelector("span")?.className ?? null] };
        }),
      };
    });
    let seen = null;
    await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
      await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
      await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
      if (sortByLevel) await page.locator("table.scoreboard thead th", { hasText: "Lvl" }).first().click();
      seen = await read(page);
    });
    return seen;
  };

  const shown = await board([row(1, "Arty", 160, 9), row(2, "Riley", 12, 8), row(3, "Smith", 0, 7), row(4, "Jones", 420, 6)]);
  assert.deepEqual(shown.head.slice(0, 3), ["Player", "Lvl", "K"], "its own column, right after the name");
  assert.deepEqual(shown.rows, [
    { name: "Arty", numberInName: false, next: ["160", "lvl-3"] },
    { name: "Riley", numberInName: false, next: ["12", "lvl-1"] },
    { name: "Smith", numberInName: false, next: ["", null] },
    { name: "Jones", numberInName: false, next: ["420", "lvl-5"] },
  ], "each level beside its name, in the scale's colour, never in the name's cell; an unknown one an empty cell");

  const sorted = await board([row(1, "Arty", 160, 9), row(2, "Riley", 12, 8), row(3, "Smith", 0, 7), row(4, "Jones", 420, 6)], true);
  assert.deepEqual(sorted.rows.map((r) => r.name), ["Jones", "Arty", "Riley", "Smith"], "sorted by level, highest first");

  const none = await board([row(1, "Arty", 0, 9), row(2, "Riley", 0, 8)]);
  assert.ok(!none.head.includes("Lvl"), "a board with no levels has no column of blanks");
  assert.deepEqual(none.rows.map((r) => r.next[0]), ["9", "8"], "the kills follow the name there");
});

/*
 * The public round page carries the full match report — the same charts the staff match page
 * grew: award chips, the flow chart, the class split, duels, and (behind a row tap) each
 * player's personal kill timeline. This drives the REAL public bundle against stubbed public
 * endpoints, because these panels only existing behind the sign-in was exactly the bug.
 */
test("public round page: awards, flow, duels and the per-player timeline render for anyone", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [
      { key: "combat", label: "CBT", title: "Combat" }, { key: "offense", label: "OFF", title: "Offense" },
      { key: "defense", label: "DEF", title: "Defense" }, { key: "support", label: "SUP", title: "Support" },
    ],
    squadLabel: "Squad",
  };
  const player = (id, name, side, kills, deaths) => ({
    id, player_id: null, player: name, platform: null, kills, deaths, teamkills: 0,
    kill_death_ratio: deaths ? kills / deaths : kills, combat: 100, offense: 0, defense: 0, support: 0,
    time_seconds: 600, kills_streak: kills, team: { side }, weapons: { "M1 GARAND": kills }, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:40:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan", game_mode: "Warfare" }, result: { allied: 5, axis: 0 },
    player_stats: [player(1, "Smith", "allies", 12, 2), player(2, "Jones", "axis", 2, 12),
      player(3, "Ace", "allies", 9, 3), player(4, "Bravo", "axis", 8, 4), player(5, "Cee", "allies", 7, 5),
      player(6, "Dee", "axis", 6, 6), player(7, "Eee", "allies", 5, 7), player(8, "Eff", "axis", 4, 8),
      player(9, "Gee", "allies", 3, 9), player(10, "DeepCut", "axis", 1, 11), player(11, "Nought", "allies", 0, 12)],
  };
  // A round is a crowd, so the race has to be navigable, not just drawable: a pack big enough
  // that the leader cut leaves players unnamed is what makes the search worth testing.
  const racer = (side, kills, from) => ({
    side, timeline: Array.from({ length: kills }, (_, i) => [from + i * 30, "k", "Someone", "M1 GARAND"]),
    killsStreak: kills, deathsWithoutKillStreak: 1, longestLifeSecs: 300, shortestLifeSecs: 20, deathsByTk: 0,
  });
  const report = {
    complete: true, bucketMinutes: 1,
    classSplit: [{ classId: "rifle", label: "Rifle", allies: 12, axis: 2 }],
    weaponSplit: [{ weapon: "M1 GARAND", allies: 12, axis: 0 }, { weapon: "MG42", allies: 0, axis: 2 }],
    timeline: [{ minute: 0, allies: 3, axis: 1 }, { minute: 1, allies: 9, axis: 1 }],
    duels: [{ aName: "Smith", bName: "Jones", aKills: 12, bKills: 2 }],
    awards: [
      { id: "kills", emoji: "💀", label: "Most kills", playerName: "Smith", value: "12" },
      { id: "firstblood", emoji: "🩸", label: "First blood", playerName: "Jones", value: "0:30" },
    ],
    players: {
      Smith: { side: "allies", timeline: [[30, "d", "Jones", "MG42"], [90, "k", "Jones", "M1 GARAND"], [140, "k", "Jones", "M1 GARAND"]],
        killsStreak: 12, deathsWithoutKillStreak: 1, longestLifeSecs: 500, shortestLifeSecs: 30, deathsByTk: 0 },
      Jones: { side: "axis", timeline: [[30, "k", "Smith", "MG42"], [200, "k", "Smith", "MG42"]],
        killsStreak: 2, deathsWithoutKillStreak: 2, longestLifeSecs: 200, shortestLifeSecs: 90, deathsByTk: 0 },
      Ace: racer("allies", 9, 40), Bravo: racer("axis", 8, 50), Cee: racer("allies", 7, 60),
      Dee: racer("axis", 6, 70), Eee: racer("allies", 5, 80), Eff: racer("axis", 4, 90),
      Gee: racer("allies", 3, 100), DeepCut: racer("axis", 1, 110),
      Nought: { side: "allies", timeline: [[10, "d", "Ace", "MG42"]], killsStreak: 0, deathsWithoutKillStreak: 1, longestLifeSecs: 10, shortestLifeSecs: 10, deathsByTk: 0 },
    },
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/report/5": { body: { report } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    // The main screen is the player list — awards ride it inline, charts live one tab over.
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard", { timeout: 10_000 });
    assert.equal(await page.locator('.award-inline[aria-label="Most kills"]').count(), 1, "the scoreboard wears award emojis inline");
    assert.equal(await page.locator(".award-chip").count(), 0, "the chart cards stay off the main screen");

    // Tap Smith's row → the personal kill timeline opens with its death marks.
    await page.locator("table.scoreboard tbody tr", { hasText: "Smith" }).first().click();
    await page.waitForSelector('svg[aria-label="Kills over the round"]', { timeout: 10_000 });
    assert.equal(await page.locator(".tl-death").count(), 1, "Smith's one death wears its ✕");

    // The Round report tab is a real link — the charts live at .../report.
    await page.locator("a", { hasText: "Round report" }).first().click();
    await page.waitForSelector(".award-chip", { timeout: 10_000 });
    assert.ok(page.url().endsWith("/stats/alpha/games/5/report"), "the report screen is a pasteable URL");
    assert.equal(await page.locator(".award-chip").count(), 2, "both award chips render");
    assert.equal(await page.locator(".viz-chart").count() >= 1, true, "the flow chart draws");
    assert.equal((await page.locator(".side-split").count()) >= 2, true, "class split and top weapons draw as side-by-side rows");
    const reportText = await page.locator("body").innerText();
    assert.ok(reportText.includes("Top weapons") && reportText.includes("M1 GARAND"), "the round's individual weapons render");
    assert.ok(reportText.includes("The kill race"), "the all-players race chart renders");
    assert.equal((await page.locator('svg[aria-label="Every player\'s kills over the round"] path').count()) >= 10, true, "one line per racer");
    assert.ok(/Ace · 9/.test(reportText), "the leaders are named at the finish");
    assert.ok(/10 lines/.test(reportText) && /1 player finished with no kills/.test(reportText),
      "the note counts the lines drawn and owns up to the player who can't be one");
    assert.equal(await page.locator('.seg[aria-label="Race"]').count(), 0, "a round without scores races kills alone, with no switch");

    // A full server is 100 players, so the crowd has to stay navigable: the leader cut leaves most
    // of them unnamed, and the search is how anyone finds their own line in the mat.
    assert.ok(!/DeepCut · 1/.test(reportText), "a player outside the leaders isn't named by default");
    await page.locator("input.race-find").fill("deepcut");
    const foundText = await page.locator("body").innerText();
    assert.ok(/DeepCut · 1/.test(foundText), "searching a name labels that player wherever they finished");
    assert.ok(/1 lit for/.test(foundText), "the note says how many the search lit up");

    // The legend doubles as a side filter — half the crowd is half the mat.
    await page.locator("input.race-find").fill("");
    await page.locator("button.race-chip", { hasText: "Axis" }).click();
    assert.ok(/5 lines on Axis/.test(await page.locator("body").innerText()), "isolating a side redraws only that side's lines");
    await page.locator("button.race-chip", { hasText: "Axis" }).click();
    assert.equal((await page.locator(".duels tr").count()) >= 1, true, "the duel table renders");
  });
});

/*
 * The public wire cannot key two players under one name, so it publishes neither and lists the
 * name in `sharedNames`. The row must then SAY that — a drill-in that silently lacks a timeline
 * looks broken, and the one thing a reader must not conclude is that the scores are wrong too.
 */
test("public round page: a row whose name two players share explains itself", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const row = (id, name, side, kills) => ({
    id, player_id: null, player: name, platform: null, kills, deaths: 2, teamkills: 0,
    kill_death_ratio: kills / 2, combat: 0, offense: 0, defense: 0, support: 0, time_seconds: 600,
    kills_streak: kills, team: { side }, weapons: { "M1 GARAND": kills }, most_killed: {}, death_by: {},
  });
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:40:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan", game_mode: "Warfare" }, result: { allied: 5, axis: 0 },
    player_stats: [row(1, "Nemesis", "allies", 9), row(2, "Nemesis", "axis", 4), row(3, "Solo", "allies", 6)],
  };
  const report = {
    complete: true, bucketMinutes: 1, classSplit: [], weaponSplit: [],
    timeline: [{ minute: 0, allies: 1, axis: 1 }], duels: [], awards: [],
    // Exactly what the API emits for this round: the shared name is withheld and named.
    players: { Solo: { side: "allies", timeline: [[30, "k", "X", "M1 GARAND"]], killsStreak: 6, deathsWithoutKillStreak: 0, longestLifeSecs: 90, shortestLifeSecs: 30, deathsByTk: 0 } },
    sharedNames: ["Nemesis"],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/report/5": { body: { report } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    await page.locator("table.scoreboard tbody tr", { hasText: "Nemesis" }).first().click();
    await page.waitForFunction(() => /goes by this name too/i.test(window.document.body.innerText), null, { timeout: 10_000 });
    const text = await page.locator("body").innerText();
    assert.ok(/scores on this row are still yours/i.test(text), "the row says what IS still true of it");
    assert.equal(await page.locator('svg[aria-label="Kills over the round"]').count(), 0,
      "and shows no personal timeline, rather than someone else's");

    // The unaffected player still drills in normally.
    await page.locator("table.scoreboard tbody tr", { hasText: "Solo" }).first().click();
    await page.waitForSelector('svg[aria-label="Kills over the round"]', { timeout: 10_000 });
  });
});

test("double press: a points adjustment is applied once", { skip: SKIP }, async () => {
  const id = "111222333444";
  const overrides = {
    "/api/economy/members": { body: { members: [{ discordId: id, discordName: "Alice", balance: 500, updatedAt: "2026-09-01T00:00:00.000Z" }], total: 1 } },
    [`/api/economy/members/${id}`]: { body: { ledger: [], players: [] } },
    [`/api/economy/members/${id}/adjust`]: { delayMs: SLOW_WRITE_MS, body: {
      member: { discordId: id, discordName: "Alice", balance: 600, updatedAt: "2026-09-02T00:00:00.000Z" },
      entry: { id: "l1", delta: 100, reason: "tournament prize", ref: null, actorName: "tester", createdAt: "2026-09-02T00:00:00.000Z" },
    } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/economy`, { waitUntil: "networkidle" });
    // By the id: the activity feed above names an Alice too.
    await page.locator("tr", { hasText: id }).first().click();
    await page.getByPlaceholder("+/- amount").fill("100");
    await page.getByPlaceholder("Reason (goes on the ledger").fill("tournament prize");
    await page.getByRole("button", { name: "Apply", exact: true }).dblclick();
    await page.waitForFunction(() => /Balance is now 600/.test(window.document.body.innerText), null, { timeout: 10_000 });
    assert.equal(writesTo(stub, "POST", `/api/economy/members/${id}/adjust`), 1, "one press, one adjustment");
  });
});

test("Economy: under a VIP purchase, when its days start and when the VIP ends, on each server — in Activity and in the member's ledger", { skip: SKIP }, async () => {
  const id = "111222333555";
  const at = "2026-11-30T12:00:00.000Z";
  const vip = [
    { serverId: "s1", serverName: "Shop #1", playerId: "765", from: "2026-12-01T12:00:00.000Z", until: "2026-12-15T12:00:00.000Z", held: false },
    { serverId: "s2", serverName: "Shop #2", playerId: "765", from: null, until: null, held: true },
  ];
  const bought = { id: "l1", delta: -250, reason: "VIP shop: Two Weeks", ref: "buy:ix1", actorName: null, createdAt: at, vip };
  const seed = { id: "l0", delta: 600, reason: "seed", ref: null, actorName: "owner", createdAt: at };
  const overrides = {
    "/api/economy/activity": { body: { entries: [{ ...bought, discordId: id, discordName: "Alice", kind: "purchase" }, { ...seed, discordId: id, discordName: "Alice", kind: "adjust" }], total: 2, kinds: [] } },
    "/api/economy/members": { body: { members: [{ discordId: id, discordName: "Alice", balance: 350, updatedAt: at }], total: 1 } },
    [`/api/economy/members/${id}`]: { body: { member: { discordId: id, discordName: "Alice", balance: 350, updatedAt: at }, ledger: [bought, seed], total: 2, players: [] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/players/economy`, { waitUntil: "networkidle" });
    // Times as the panel writes them: in the device's zone, or the community's.
    const when = (iso) => page.evaluate((v) => [new Date(v).toLocaleString(), new Date(v).toLocaleString(undefined, { timeZone: "UTC" })], iso);
    const [fromLocal, fromUtc] = await when(vip[0].from);
    const [untilLocal, untilUtc] = await when(vip[0].until);
    const check = async (rows, where) => {
      const purchase = rows.filter({ hasText: "VIP shop: Two Weeks" }).first();
      await purchase.waitFor({ timeout: 10_000 });
      const lines = await purchase.locator(".vip-bought > div").allInnerTexts();
      assert.equal(lines.length, 2, `${where}: a line per server`);
      assert.ok([`Shop #1: VIP from ${fromLocal} until ${untilLocal}`, `Shop #1: VIP from ${fromUtc} until ${untilUtc}`].includes(lines[0]), `${where}: the dated server — "${lines[0]}"`);
      assert.equal(lines[1], "Shop #2: days saved for when the group's permanent VIP ends", `${where}: the server a group holds`);
      assert.equal(await rows.filter({ hasText: "seed" }).first().locator(".vip-bought").count(), 0, `${where}: nothing under a row that is not a purchase`);
    };
    const panel = (title) => page.locator("section.panel", { has: page.locator(`.panel-title:text-is('${title}')`) });
    await check(panel("Activity").locator("tbody tr"), "Activity");
    await panel("Members").locator("tr", { hasText: id }).first().click();
    await check(panel("Members").locator("tbody tbody tr"), "the member's ledger");
  });
});

test("double press: a server action from a Connections card is sent once", { skip: SKIP }, async () => {
  const overrides = { "/api/servers/s1/actions": { delayMs: SLOW_WRITE_MS, body: { ok: true } } };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/connections`, { waitUntil: "networkidle" });
    await page.locator('button:has-text("Admin action")').first().click();
    await page.getByPlaceholder("Search a player, or paste an id…").fill("76561198000000077");
    await page.locator('button:has-text("as a raw id")').click();
    await page.getByPlaceholder("Message", { exact: true }).fill("Please play the objective");
    await page.locator('.admin-grid button:has-text("Apply")').dblclick();
    await page.waitForSelector("text=message sent.", { timeout: 10_000 });
    assert.equal(writesTo(stub, "POST", "/api/servers/s1/actions"), 1, "one press, one message");
  });
});

test("double press: a staff notice is posted once", { skip: SKIP }, async () => {
  // One path serves the board's list and the post, so the slow reply carries both shapes.
  const overrides = { "/api/community/announcements": { delayMs: SLOW_WRITE_MS, body: { announcements: [], announcement: { id: "a1", title: "Event night", body: "Saturday 8pm", published: true } } } };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/announcements`, { waitUntil: "networkidle" });
    await page.locator('label:has-text("Title") input').fill("Event night");
    await page.locator('label:has-text("Body") textarea').fill("Saturday 8pm");
    await page.locator('button:has-text("Add notice")').dblclick();
    const titleCleared = () => [...window.document.querySelectorAll("label")].find((l) => l.textContent.startsWith("Title"))?.querySelector("input")?.value === "";
    await page.waitForFunction(titleCleared, null, { timeout: 10_000 });
    assert.equal(writesTo(stub, "POST", "/api/community/announcements"), 1, "one press, one notice");
  });
});

test("public stats: picking another server never shows the last one's game", { skip: SKIP }, async () => {
  const pub = (slug, name) => ({ slug, name, game: "hll", playerIds: true, sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }], scoreFields: [], squadLabel: "Squad" });
  const info = (map) => ({ current_map: { map: { id: "x", pretty_name: map }, start: 1_760_000_000 }, player_count: 1, max_player_count: 100, player_count_by_team: { allied: 1, axis: 0 }, score: { allied: 2, axis: 2 }, time_remaining: 100.0, name: { name: "n", short_name: "" } });
  const row = (name) => ({ player_id: "76561198000000001", player: name, platform: "steam", steaminfo: null, kills: 3, deaths: 1, teamkills: 0, kill_death_ratio: 3, combat: 1, offense: 0, defense: 0, support: 0, time_seconds: 60, kills_streak: 1, most_killed: {}, death_by: {}, weapons: {}, death_by_weapons: {}, team: "allies", status: "online" });
  const live = (name) => ({ result: { snapshot_timestamp: 1, refresh_interval_sec: 5, stats: [row(name)] }, failed: false });
  const statsWire = (who) => ({ stats: {
    scannedMatches: 3, truncated: false,
    overview: { matches: 3, avgMinutes: 90, alliesWins: 2, axisWins: 1, attackersWinPct: null },
    maps: [], quality: { contested: 0, decisive: 0, stomp: 0, crash: 0, other: 0, scored: 0 },
    activity: [], seeding: null,
    records: { kills: [], combat: [], support: [] },
    regulars: { playtime: [{ name: who, hours: 12 }], kills: [] },
    classRecords: [], weaponRecords: [],
  } });
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [pub("alpha", "Alpha"), pub("bravo", "Bravo")] } },
    "/stats/alpha/api/get_public_info": { body: { result: info("ALPHA-MAP"), failed: false } },
    "/stats/alpha/api/get_live_game_stats": { body: live("AlphaPlayer") },
    "/stats/bravo/api/get_public_info": { delayMs: STALE_MS, body: { result: info("BRAVO-MAP"), failed: false } },
    "/stats/bravo/api/get_live_game_stats": { delayMs: STALE_MS, body: live("BravoPlayer") },
    "/api/public/alpha/stats": { body: statsWire("AlphaRegular") },
    "/api/public/bravo/stats": { delayMs: STALE_MS, body: statsWire("BravoRegular") },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    // Now playing, then the other server from the sidebar: the same view, a new server.
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /AlphaPlayer/.test(window.document.body.innerText) && /ALPHA-MAP/.test(window.document.body.innerText), null, { timeout: 10_000 });
    await page.locator(".sidebar a", { hasText: "Bravo" }).first().click();
    await page.waitForFunction(() => window.location.pathname === "/stats/bravo", null, { timeout: 5_000 });
    const during = await page.locator("main, body").first().innerText();
    assert.doesNotMatch(during, /AlphaPlayer/, "Alpha's players stood on screen under Bravo's name");
    assert.doesNotMatch(during, /ALPHA-MAP/, "Alpha's map stood in the header under Bravo's name");
    await page.waitForFunction(() => /BravoPlayer/.test(window.document.body.innerText), null, { timeout: 10_000 });

    // Server stats, then a history jump straight to the other server's: the same view again.
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /AlphaRegular/.test(window.document.body.innerText), null, { timeout: 10_000 });
    await page.evaluate(() => {
      window.history.pushState(null, "", "/stats/bravo/server");
      window.dispatchEvent(new window.PopStateEvent("popstate"));
    });
    await page.waitForTimeout(300);
    assert.doesNotMatch(await page.locator("body").innerText(), /AlphaRegular/, "Alpha's server stats stood on screen under Bravo's name");
    await page.waitForFunction(() => /BravoRegular/.test(window.document.body.innerText), null, { timeout: 10_000 });
  });
});

/*
 * Map zones: the community zone-set library under Auto settings — the same painter as the seeding
 * areas, but per named set, per game, feeding the "outside the allowed area" rules. A set is
 * selected from its chip and saved WHOLE, so the PUT must carry the edited paint. Painting is the
 * zone sets' own permission (the rules permission only reads them).
 */
test("map zones: the library lists a game's sets, the painter edits one, and saving sends the whole paint", { skip: SKIP }, async () => {
  const ZONE_CAPS = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "moderation.zones", scopeType: "global", scopeId: null, level: "write" },
  ];
  const zonesResponse = { body: {
    sets: [{ id: "z1", name: "Fight Club", game: "hll", zones: { carentan: { allies: ["A1"], axis: ["J10"], shared: [] } }, usedBy: ["Zoned"], updatedAt: "2026-09-05T12:00:00.000Z" }],
    maps: [{ key: "carentan", label: "Carentan" }, { key: "foy", label: "Foy" }],
  } };
  await withPage({ grants: ZONE_CAPS, overrides: { "/api/zones": zonesResponse, "/api/zones/z1": zonesResponse } }, async (page, { stub }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Zone sets/i.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.locator('.chips button:has-text("Fight Club")').click();
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    assert.equal(await page.locator(".zone-grid .zg").count(), 100, "the tactical map's whole 10×10 grid");
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 1, "the stored allies cell is painted");
    assert.equal(await page.locator(".zone-grid .zg-axis").count(), 1);
    assert.match(await page.locator("body").innerText(), /Enforced by: Zoned/, "the set says which rules read it");
    await page.locator(".zone-grid .zg").nth(1).click(); // paint B1 with the default allies brush
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 2, "the clicked cell wears the brush");
    await page.locator('button:has-text("Save changes")').click();
    await page.waitForFunction(() => /\bsaved\b/i.test(window.document.body.innerText), null, { timeout: 10_000 });
    const put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/zones/z1");
    assert.ok(put, "the save PUTs the set");
    assert.deepEqual([...put.body.zones.carentan.allies].sort(), ["A1", "B1"], "the edited paint travels whole");
  });
});

/*
 * The group economy grant: a staffer holding balances-write lands on the "Grant economy" form for
 * the selected group; without it the action is still offered — everything a role can see, it can
 * ask for — and the form says the grant is sent for approval.
 */
test("groups: the economy grant opens for balances-write holders, and is asked for by everyone else", { skip: SKIP }, async () => {
  const BASE_CAPS = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "player.groups", scopeType: "global", scopeId: null, level: "write" },
  ];
  const ECO = { capability: "economy.balances", scopeType: "global", scopeId: null, level: "write" };
  const overrides = {
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "Event Winners", description: null, memberCount: 2, createdByName: "owner" }] } },
    "/api/player-groups/g1": { body: { members: [
      { groupId: "g1", playerId: "76561190000000001", playerName: "Ana", addedByName: "owner", addedAt: "2026-09-01T00:00:00.000Z" },
    ] } },
  };
  await withPage({ grants: [...BASE_CAPS, ECO], overrides }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Event Winners/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForFunction(() => /Grant economy/.test(window.document.body.innerText), null, { timeout: 15_000 });
    // It sits in the same action row as the other group actions; with no other action held it is
    // the one selected, so its form is showing — amount, reason, no server to aim at.
    await page.waitForSelector('text=Amount per member', { timeout: 5_000 });
    assert.ok(!/Apply on/.test(await page.locator("body").innerText()), "economy is not aimed at a server");
  });
  await withPage({ grants: BASE_CAPS, overrides }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Event Winners/.test(window.document.body.innerText), null, { timeout: 15_000 });
    // No balances-write: offered all the same, and it says where the grant goes.
    await page.locator('.seg-btn:has-text("Grant economy")').click();
    await page.waitForSelector('text=Amount per member', { timeout: 5_000 });
    await page.waitForSelector("text=You don't hold the permission for changes here", { timeout: 5_000 });
  });
  // The owner's single wildcard grant opens it too — as a button beside Grant VIP.
  await withPage({ grants: [{ capability: "*", scopeType: "global", scopeId: null, level: "write" }], overrides }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Grant economy/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.locator('.seg-btn:has-text("Grant economy")').click();
    await page.waitForSelector('text=Amount per member', { timeout: 5_000 });
  });
});

/*
 * A group's VIP perk reads back on the group — what it gives, who it holds, what the worker could
 * not do — and switching it off asks about the severance, refusing to go until it is answered.
 */
test("groups: the VIP perk reads back, and switching it off waits for the severance answer", { skip: SKIP }, async () => {
  const perk = { game: "hll", scope: { mode: "all" }, severanceMinutes: 2880 };
  const searches = [];
  const overrides = {
    "/api/games": { body: { games: [{ id: "hll", label: "WW2", protocols: [] }] } },
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 2, createdByName: "owner", vipPerk: perk }] } },
    "/api/player-groups/g1": { body: {
      group: { id: "g1", name: "WW2 CVC", vipPerk: perk },
      members: [
        { groupId: "g1", playerId: "76561190000000001", playerName: "Ana", addedByName: "owner", addedAt: "2026-09-01T00:00:00.000Z" },
        { groupId: "g1", playerId: "0123456789abcdef0123456789abcdef", playerName: "Bo", addedByName: "owner", addedAt: "2026-09-01T00:00:00.000Z" },
      ],
      perkStatus: {
        heldPlayers: 1, heldGrants: 1,
        held: [{ serverId: "s1", playerId: "76561190000000001", bankedMs: 3 * 86_400_000, since: "2026-09-02T00:00:00.000Z" }],
        notes: { notSeen: 1, otherGame: 0, ownPermanent: 0, ownGameVip: 0, listUnreadable: 0, quietServers: 0 },
        checkedAt: new Date().toISOString(),
      },
    } },
    // Only the switch-off reaches this path here; the answer travels in the query string.
    "/api/player-groups/g1/perk": (url) => { searches.push(url.search); return { body: { group: { id: "g1", name: "WW2 CVC", vipPerk: null } } }; },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /permanent VIP on every WW2 server/.test(window.document.body.innerText), null, { timeout: 15_000 });
    const text = await page.locator("body").innerText();
    assert.match(text, /plus 2 days severance/);
    assert.match(text, /Holding permanent VIP for 1 player/);
    assert.match(text, /1 member hasn't been seen on a server yet/);
    assert.match(text, /3 days/, "the frozen balance under Ana's grant");

    await page.locator('button:has-text("Switch off…")').click();
    const go = page.locator('.confirm-modal button:has-text("Switch off")');
    await go.waitFor();
    assert.ok(await go.isDisabled(), "no answer, no switch-off — nobody's VIP is decided by a default");
    await page.locator('.confirm-modal label:has-text("No severance") input').check();
    await go.click();
    await page.waitForFunction(() => !window.document.querySelector(".confirm-modal"), null, { timeout: 5_000 });
    assert.deepEqual(searches, ["?severance=0"]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A perk's rewards switch: the perk says where it stands, and the editor offers it beside the
 * severance and saves it with the rest — the one answer to "should this group's members keep
 * stacking seed rewards and shop days beneath the group's VIP?".
 */
test("groups: a perk's rewards switch reads back on the perk, and the editor saves it", { skip: SKIP }, async () => {
  const perk = { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false };
  const overrides = {
    "/api/games": { body: { games: [{ id: "hll", label: "WW2", protocols: [] }] } },
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "Staff", description: null, memberCount: 1, createdByName: "owner", vipPerk: perk }] } },
    "/api/player-groups/g1": { body: {
      group: { id: "g1", name: "Staff", vipPerk: perk },
      members: [{ groupId: "g1", playerId: "76561190000000001", playerName: "Ana", addedByName: "owner", addedAt: "2026-09-01T00:00:00.000Z" }],
      perkStatus: { heldPlayers: 1, heldGrants: 1, held: [], notes: {}, checkedAt: new Date().toISOString() },
    } },
    "/api/player-groups/g1/perk": { body: { group: { id: "g1", name: "Staff", vipPerk: { ...perk, bankRewards: true } } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/groups`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /permanent VIP on every WW2 server/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.match(await page.locator("body").innerText(), /Rewards don.t add to the frozen VIP while they.re listed/, "the perk says where the switch stands");

    await page.getByRole("button", { name: "Change", exact: true }).click();
    const off = page.locator("label", { hasText: "Rewards don't add to their frozen VIP" });
    await off.waitFor({ timeout: 5_000 });
    assert.equal(await off.locator('input[type="checkbox"]').isChecked(), false, "the editor opens on the perk's own setting");
    await off.click();
    await page.locator("label", { hasText: "Rewards add to their frozen VIP" }).waitFor({ timeout: 5_000 });
    await page.locator('button:has-text("Save perk")').click();
    for (let i = 0; i < 50 && !stub.calls.some((c) => c.method === "PUT" && c.path === "/api/player-groups/g1/perk"); i++) await page.waitForTimeout(100);
    const saved = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/player-groups/g1/perk");
    assert.ok(saved, "the perk was saved");
    assert.equal(saved.body.bankRewards, true, "with the switch as it was left");
    assert.equal(saved.body.severanceMinutes, 0, "and the rest of the perk as it was");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The placeholder list under a message box types into the box. The box is React-controlled, so a
 * value set behind React's back would vanish on the next render — this proves the click reaches
 * React's state (the text survives typing after it), lands at the cursor, and that Help carries
 * the full list the fold-out links to.
 */
test("placeholder chips type into the message box, and Help lists every placeholder", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/moderation/messages`, { waitUntil: "networkidle" });
    const box = page.locator("textarea").first();
    await box.waitFor();
    await box.fill("Hi ");
    await page.locator(".placeholder-chip", { hasText: "{player_name}" }).first().click();
    await box.pressSequentially(", VIP until");
    await page.locator(".placeholder-chip", { hasText: "{vip_until}" }).first().click();
    assert.equal(await box.inputValue(), "Hi {player_name}, VIP until {vip_until}");

    // The meanings are one click away (no hover on a phone), and link to the full list.
    await page.locator(".placeholder-meanings > summary").first().click();
    assert.match(await page.locator(".placeholder-meanings").first().innerText(), /VIP on this server ends/);
    await page.locator(".placeholder-meanings button", { hasText: "full placeholder list" }).first().click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/help/placeholders"));
    const ref = await page.locator(".placeholder-reference").innerText();
    for (const t of ["{player_name}", "{vip_until}", "{vip_remaining}", "{server_name}", "{violation}", "{reward}"]) {
      assert.ok(ref.includes(t), `Help lists ${t}`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The trigger builder's number boxes — AFK minutes, and a roster condition's own knobs (the form the
 * Rules tab's editor shares) — read what was typed. A plain number box jumped to "0" when cleared
 * and then read "015" once 15 was typed.
 */
test("player trigger number boxes read what was typed, never 015", { skip: SKIP }, async () => {
  const base = {
    serverId: null, serverName: null, steps: [{ action: "message", message: "Wake up", hours: 0, points: 0, delaySec: 0 }],
    fireOnce: false, enabled: true, note: null, createdByName: "KREITZ", createdAt: "2026-10-10T16:57:19Z",
    firedCount: 0, lastFiredAt: null, disarmedAt: null,
  };
  const afk = { ...base, id: "t5", playerId: "p5", playerName: "Idle", event: "afk", params: { minutes: 10 }, summary: "on 10 minutes without a kill, message (every time)" };
  const low = { ...base, id: "t6", playerId: "p5", playerName: "Idle", event: "lowlevel", params: { minLevel: 25 }, summary: "on level below 25, message (every time)" };
  const overrides = {
    "/api/player-triggers": { body: { triggers: [afk, low] } },
    "/api/players/p5/triggers": { body: { triggers: [afk, low], allowedActions: ["message"], game: "hll", rosterEvents: ["role", "lowlevel"] } },
    "/api/players/p5/triggers/t5": { body: { trigger: afk } },
    "/api/players/p5/triggers/t6": { body: { trigger: low } },
    "/api/games/hll/descriptor": { body: { descriptor: { id: "hll", label: "hll", sides: [], scoreFields: [], squadLeaderRoles: [], squadLabel: "Squad", configFields: [], roles: { 0: "Rifleman" } } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/triggers`, { waitUntil: "networkidle" });
    for (const [row, label, key, id] of [["minutes without a kill", "Minutes without a kill", "minutes", "t5"], ["level below 25", "Minimum level to play", "minLevel", "t6"]]) {
      await page.locator("tr", { hasText: row }).locator("button", { hasText: /^Edit$/ }).first().click();
      const box = page.locator(`label:has-text("${label}") input`);
      await box.waitFor();
      // What a person does: select what is there, delete it, type the new number.
      await box.click();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      assert.equal(await box.inputValue(), "", `${label}: a cleared box stays empty while it is being typed in`);
      await page.keyboard.type("15");
      assert.equal(await box.inputValue(), "15", `${label}: no leading zero`);
      await page.locator("button", { hasText: "Save changes" }).click();
      await page.locator("button", { hasText: "Save changes" }).waitFor({ state: "detached" });
      const put = stub.calls.filter((c) => c.method === "PUT" && c.path === `/api/players/p5/triggers/${id}`).pop();
      assert.equal(put.body.params[key], 15, `${label}: the number typed is the number saved`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * VIP for everyone ticked in the Live view, and a message telling each how much they now have.
 * The form opens with that message ready (placeholders and all), and one call does both.
 */
test("every VIP added asks for a comment: the VIP editor, the VIPs page, a Live selection and a group", { skip: SKIP }, async () => {
  /*
   * Players pay real money for VIP, and a grant nobody wrote a word about is one nobody can account
   * for later. Each place a person adds VIP holds its button until a comment is typed, says why,
   * and sends the comment with the grant — the API refuses a grant without one.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const one = { playerId: "76561198000000001", playerName: "TestGuy" };
  const overrides = {
    ...ACTIVE_S1,
    "/api/servers/s1/live": { body: {
      players: [
        { id: "p1", playerId: one.playerId, playerDbId: "db-1", name: one.playerName, team: 0, unit: "ABLE", role: "rifleman", level: 40, stats: { infantryKills: 1, vehicleKills: 0, deaths: 1, teamKills: 0 } },
        { id: "p2", playerId: "76561198000000002", name: "OtherGuy", team: 1, unit: "BAKER", role: "rifleman", level: 20, stats: { infantryKills: 0, vehicleKills: 0, deaths: 0, teamKills: 0 } },
      ],
      session: { playerCount: 2, maxPlayerCount: 100, queueCount: 0, mapName: "KURSK", gameMode: "Warfare", alliedScore: 0, axisScore: 0, alliedPlayerCount: 1, axisPlayerCount: 1, remainingMatchTime: 100, matchTime: 10 },
    } },
    // One answer for the list (GET) and a grant (POST): each reads what it needs.
    "/api/servers/s1/vips": { body: { vips: [], applied: [{ serverId: "s1", serverName: "Test Server #1", expiration: null }], skipped: [] } },
    "/api/servers/s1/vips/bulk": { body: { applied: [{ ...one, note: "until …", messaged: null }], skipped: [], messageFailed: 0 } },
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 1, createdByName: "owner", vipPerk: null }] } },
    "/api/player-groups/g1": { body: { members: [{ ...one, addedByName: "owner", addedAt: at, source: "manual" }] } },
    "/api/player-groups/g1/apply": { body: { results: [{ serverId: "s1", serverName: "Test Server #1", applied: [one], skipped: [] }] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    const asks = /Type a comment — every VIP added needs one/;
    const posted = (path) => stub.calls.filter((c) => c.method === "POST" && c.path === path);
    const until = async (cond, what) => {
      for (let i = 0; i < 150 && !cond(); i++) await page.waitForTimeout(100);
      assert.ok(cond(), `timed out waiting for ${what}`);
    };

    // --- The VIP editor, from a player's ⋯ menu on the Live view.
    await page.goto(`${base}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr", { hasText: one.playerName }).first().locator(".pa-menu button").click();
    await page.locator(".pa-mi", { hasText: "Edit VIP" }).click();
    const editor = page.locator(".pa-modal");
    await editor.locator("label", { hasText: "Days" }).locator("input").fill("1");
    const grantOne = editor.locator(".pa-actions button:not(.ghost)");
    assert.equal(await grantOne.isDisabled(), true, "the editor holds its Grant until a comment is typed");
    assert.match(await editor.innerText(), asks, "and says why");
    await editor.locator("label", { hasText: "Comment (required)" }).locator("input").fill("paid $10 — 1 day");
    assert.equal(await grantOne.isDisabled(), false);
    await grantOne.click();
    await until(() => posted("/api/servers/s1/vips").length === 1, "the editor's grant");
    assert.equal(posted("/api/servers/s1/vips")[0].body.comment, "paid $10 — 1 day", "the comment goes with the grant");

    // --- The VIPs page's grant form.
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    const form = page.locator(".vip-form");
    await form.locator(".picker input").fill(one.playerId);
    await form.locator(".picker-opt", { hasText: "as a raw id" }).click();
    const grantPage = form.locator("button.primary", { hasText: "Grant VIP" });
    assert.equal(await grantPage.isDisabled(), true, "the VIPs page holds Grant VIP until a comment is typed");
    assert.match(await form.innerText(), asks, "and says why");
    await form.locator("label", { hasText: "Comment (required)" }).locator("input").fill("event winner");
    await grantPage.click();
    await until(() => posted("/api/servers/s1/vips").length === 2, "the VIPs page's grant");
    assert.equal(posted("/api/servers/s1/vips")[1].body.comment, "event winner");

    // --- A Live selection.
    await page.goto(`${base}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".scoreboard thead", { timeout: 15_000 });
    await page.locator('.scoreboard thead input[type="checkbox"]').check();
    await page.locator(".scoreboard thead .pa-menu button").click();
    await page.locator(".scoreboard thead .pa-mi", { hasText: "Grant VIP" }).click();
    const bulk = page.locator(".pa-modal");
    const grantMany = bulk.locator("button", { hasText: "Grant VIP to selected" });
    assert.equal(await grantMany.isDisabled(), true, "a selection's grant waits for a comment");
    assert.match(await bulk.innerText(), asks);
    await bulk.locator("label", { hasText: "Comment (required)" }).locator("input").fill("seeded the server");
    await grantMany.click();
    await until(() => posted("/api/servers/s1/vips/bulk").length === 1, "the selection's grant");
    assert.equal(posted("/api/servers/s1/vips/bulk")[0].body.comment, "seeded the server");
    // Opened again for the next grant, it asks again: the last grant's comment is not carried over.
    await page.waitForSelector(".pa-modal", { state: "detached", timeout: 10_000 });
    await page.locator(".scoreboard thead .pa-menu button").click();
    await page.locator(".scoreboard thead .pa-mi", { hasText: "Grant VIP" }).click();
    assert.equal(await bulk.locator("label", { hasText: "Comment (required)" }).locator("input").inputValue(), "", "the next grant starts without a comment");
    assert.equal(await grantMany.isDisabled(), true);
    await bulk.locator("button", { hasText: "Cancel" }).click();

    // --- A group.
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await page.locator(".seg-btn", { hasText: "Grant VIP" }).first().click();
    await page.locator(".seg-btn", { hasText: "For a duration" }).first().click();
    const grantGroup = page.locator("button", { hasText: "Grant VIP — whole group" });
    assert.equal(await grantGroup.isDisabled(), true, "a group's grant waits for a comment");
    assert.match(await page.locator("body").innerText(), asks);
    await page.locator("label", { hasText: "Comment (required)" }).locator("input").fill("clan match casters");
    await grantGroup.click();
    await page.locator(".confirm-modal button", { hasText: "Grant VIP" }).click();
    await until(() => posted("/api/player-groups/g1/apply").length === 1, "the group's grant");
    assert.equal(posted("/api/player-groups/g1/apply")[0].body.comment, "clan match casters");
    // The next group grant asks again, as every other VIP form does: the comment was that grant's.
    const groupComment = page.locator("label", { hasText: "Comment (required)" }).locator("input");
    for (let i = 0; i < 50 && (await groupComment.inputValue()) !== ""; i++) await page.waitForTimeout(100);
    assert.equal(await groupComment.inputValue(), "", "the comment goes with the grant it was typed for");
    assert.equal(await grantGroup.isDisabled(), true);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("game rewards: Best squads offers this game's squad types only, and saves per-type places", { skip: SKIP }, async () => {
  const r = (points) => ({ vipHours: 0, points });
  const types = ["infantry", "armor", "recon", "artillery", "mortar", "helicopter"].map((id) => ({ id, enabled: id === "armor", ranks: [r(50)] }));
  const config = {
    order: ["matchEnd", "topStats", "bestSquads", "killStreaks", "playDays", "seedDays"],
    topStats: { enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, broadcast: true, message: "m", categories: [{ id: "kills", enabled: true, ranks: [r(100)] }] },
    bestSquads: { enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, minMembers: 2, metric: "score", scoring: "total", broadcast: true, showEveryone: true, message: "m", types },
    killStreaks: { enabled: false, dryRun: true, minPlayers: 20, message: "m", tiers: [{ kills: 10, reward: r(25) }] },
    playDays: { enabled: false, dryRun: true, minMinutes: 30, message: "m", tiers: [{ days: 3, reward: r(50) }], repeatEveryDays: 7 },
    seedDays: { enabled: false, dryRun: true, message: "m", tiers: [{ days: 3, reward: r(100) }], repeatEveryDays: 7 },
    matchEnd: { enabled: false, dryRun: true, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 0, reward: { vipHours: 24, points: 0 }, message: "m" },
  };
  const descriptor = { id: "hll", label: "Hell Let Loose", sides: [], roles: {}, squadLeaderRoles: [], squadLabel: "Squad", scoreFields: [], configFields: [],
    squadTypes: { infantry: [0], recon: [4], armor: [11, 12], artillery: [14] } };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers/s1/game-rewards": { body: { config, recent: [] } },
    "/api/games/hll/descriptor": { body: { descriptor } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/gamerewards`, { waitUntil: "networkidle" });
    const card = page.locator(".panel", { hasText: "Best squads per match" }).first();
    await card.waitFor();
    await card.locator("text=Artillery squads").waitFor();
    const text = await card.innerText();
    assert.match(text, /Armor \(tank crews\)/);
    assert.doesNotMatch(text, /Mortar platoons|Helicopter platoons/, "squad types this game does not have are not offered");
    await card.locator("label.toggle", { hasText: "Infantry squads" }).click();
    await page.locator("button", { hasText: /^Save$/ }).first().click();
    await page.waitForFunction(() => window.document.body.innerText.includes("Saved."));
    const put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/servers/s1/game-rewards");
    assert.equal(put.body.bestSquads.types.find((t) => t.id === "infantry").enabled, true);
    assert.equal(put.body.bestSquads.dryRun, true, "still a dry run");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a screen whose code cannot be fetched: one automatic reload, then a notice, and the rest of the panel keeps working", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    // What the opening screen needed has arrived. Any other screen file asked for from here on
    // stands for one the update removed.
    const known = new Set(await page.evaluate(() => performance.getEntriesByType("resource")
      .map((e) => e.name).filter((n) => n.includes("/_next/static/chunks/"))));
    let blocked = 0;
    await page.route("**/_next/static/chunks/**", (route) => {
      if (known.has(route.request().url())) return route.continue();
      blocked += 1;
      return route.abort();
    });
    let loads = 0;
    page.on("load", () => { loads += 1; });
    const base = page.url().split("#")[0];
    const reloaded = page.waitForEvent("load", { timeout: 15_000 });
    await page.goto(`${base}#/maps`);
    await reloaded;
    await page.waitForSelector("text=The panel was updated while this tab was open", { timeout: 15_000 });
    assert.equal(loads, 1, "it reloaded by itself exactly once");
    assert.ok(blocked >= 2, "the screen's file was asked for before and after that reload");
    assert.equal(await page.locator('[role="alert"] button:has-text("Reload")').count(), 1, "a Reload button");
    assert.ok(await page.locator("aside").isVisible(), "the sidebar is still there");

    // Somewhere already loaded opens normally, and the notice is gone.
    await page.unroute("**/_next/static/chunks/**");
    await page.goto(`${base}#/dashboard`);
    await page.waitForFunction(() => !window.document.body.innerText.includes("The panel was updated while this tab was open"), null, { timeout: 15_000 });
    assert.equal(loads, 1, "no further reloads");
  });
});

test("plugin pages: listed to who may open them, drawn in place with the panel's kit, and nothing anywhere else", { skip: SKIP }, async () => {
  const VIEW = { capability: "server.view", scopeType: "global", scopeId: null, level: "read" };
  const DEMO = { capability: "demo.view", scopeType: "global", scopeId: null, level: "read" };
  const LOOSE = { ...DEMO_PAGE, id: "demo-loose", title: "Loose Demo", section: "Nowhere", permission: null, outright: false };

  await withPage({ grants: [VIEW, DEMO], overrides: { ...DEMO_OVERRIDES, "/api/plugin-pages": { body: { pages: [DEMO_PAGE, LOOSE] } } } }, async (page, { stub, errors }) => {
    const group = (label) => page.locator(".nav-group", { has: page.locator(".nav-group-label", { hasText: label }) });
    // In the sidebar, under the section the plugin chose; one with a section the sidebar does not
    // have goes under More.
    await group("Monitor").locator(".nav-item", { hasText: "Demo Page" }).waitFor({ timeout: 15_000 });
    await group("More").locator(".nav-item", { hasText: "Loose Demo" }).waitFor({ timeout: 15_000 });
    assert.ok(!stub.requests.includes("/api/plugin-pages/demo/demo-page"), "the code is not fetched until the page is opened");
    await group("Monitor").locator(".nav-item", { hasText: "Demo Page" }).click();
    await page.waitForFunction(() => /hello from the plugin/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(new URL(page.url()).hash, "#/demo-page", "the page has an address of its own");
    assert.match(await page.locator(".demo-view").innerText(), /on view demo-page/, "the panel's navigation reaches into the page");
    // The kit's Toggle is the panel's own, and it works.
    await page.locator(".demo-card .toggle").click();
    await page.waitForFunction(() => /Flipped/.test(window.document.querySelector(".demo-card")?.textContent ?? ""), null, { timeout: 5_000 });
    // Its stylesheet applies.
    assert.equal(await page.locator(".demo-card").evaluate((el) => window.getComputedStyle(el).outlineColor), "rgb(1, 2, 3)");
    // Found by search like any other screen.
    await page.keyboard.press("Control+k");
    await page.keyboard.type("Demo Page");
    await page.locator(".cmdk-item", { hasText: "Demo Page" }).first().waitFor({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  // A deep link from a fresh load, with the list slow to arrive: the address waits for it instead
  // of flashing the nothing-here it is about to stop being, then draws the page and names the tab.
  await withPage({ grants: [VIEW, DEMO], overrides: { ...DEMO_OVERRIDES, "/api/plugin-pages": { delayMs: 1500, body: { pages: [DEMO_PAGE] } } } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.addInitScript(() => {
      new window.MutationObserver(() => {
        if (/There's nothing here/i.test(window.document.body?.innerText ?? "")) window.sawNothing = true;
      }).observe(window.document, { subtree: true, childList: true, characterData: true });
    });
    await page.goto(`${base}#/demo-page`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /hello from the plugin/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(await page.evaluate(() => window.sawNothing ?? false), false, "no flash of nothing-here while the list was on its way");
    await page.waitForFunction(() => window.document.title === "Demo Page · hellrcon", null, { timeout: 5_000 });
  });

  // Not listed to this viewer: no entry, nothing at the address, and the code never asked for.
  // And listed, but not opened by the grants on screen (a list read before a permission went, or a
  // role being previewed): the same.
  for (const [what, pages] of [["not listed", []], ["listed, but not theirs", [DEMO_PAGE]]]) {
    await withPage({ grants: [VIEW], overrides: { ...DEMO_OVERRIDES, "/api/plugin-pages": { body: { pages } } } }, async (page, { stub }) => {
      const base = page.url().split("#")[0];
      await page.waitForFunction(() => /Live/.test(window.document.querySelector(".nav")?.textContent ?? ""), null, { timeout: 15_000 });
      assert.ok(!/Demo Page/.test(await page.locator(".nav").innerText()), `${what}: the sidebar does not name it`);
      await page.goto(`${base}#/demo-page`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => /There's nothing here/i.test(window.document.body.innerText), null, { timeout: 15_000 });
      assert.ok(!/Demo heading|hello from the plugin/.test(await page.locator("body").innerText()), what);
      assert.ok(!stub.requests.includes("/api/plugin-pages/demo/demo-page"), `${what}: the code is never asked for`);
    });
  }

  // A permission granted while the tab is open: the page joins the sidebar at the next re-read,
  // with no reload — the same as any other screen.
  let granted = false;
  const listing = () => ({ body: { pages: granted ? [DEMO_PAGE] : [] } });
  const me = () => ({ body: { user: { id: "u1", username: "tester", displayName: "tester" }, grants: granted ? [VIEW, DEMO] : [VIEW], limits: {}, roles: [] } });
  await withPage({ grants: [VIEW], overrides: { ...DEMO_OVERRIDES, "/api/plugin-pages": listing, "/api/me": me } }, async (page) => {
    await page.waitForFunction(() => /Live/.test(window.document.querySelector(".nav")?.textContent ?? ""), null, { timeout: 15_000 });
    assert.ok(!/Demo Page/.test(await page.locator(".nav").innerText()));
    granted = true;
    await page.evaluate(() => window.document.dispatchEvent(new window.Event("visibilitychange")));
    await page.locator(".nav-item", { hasText: "Demo Page" }).waitFor({ timeout: 15_000 });
  });
});

test("a screen a plugin adds can go on the quick bar, like the panel's own", { skip: SKIP }, async () => {
  const VIEW = { capability: "server.view", scopeType: "global", scopeId: null, level: "read" };
  const DEMO = { capability: "demo.view", scopeType: "global", scopeId: null, level: "read" };
  await withPage({ grants: [VIEW, DEMO], viewport: { width: 390, height: 844 }, overrides: DEMO_OVERRIDES }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    const card = page.locator(".setting-card", { hasText: "Quick bar buttons" });
    await card.locator(".field-label").first().waitFor({ timeout: 10_000 });
    // Offered by the name the menu gives it, and added like any screen.
    await card.getByLabel("Add a button to the quick bar").selectOption({ label: "Demo Page" }, { timeout: 10_000 });
    await card.locator(".quick-pick", { hasText: "Demo Page" }).waitFor();
    const saved = stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/me/prefs" && c.body?.phoneBarItems).map((c) => c.body.phoneBarItems);
    assert.ok(saved.at(-1)?.includes("demo-page"), `kept on the account: ${JSON.stringify(saved.at(-1))}`);
    // On the bar, it opens the plugin's screen, and reads as the screen you are on.
    const bar = page.locator(".quick-bar");
    await bar.getByRole("button", { name: "Demo Page", exact: true }).tap();
    await page.waitForFunction(() => /hello from the plugin/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(new URL(page.url()).hash, "#/demo-page");
    assert.equal(await bar.getByRole("button", { name: "Demo Page", exact: true }).getAttribute("aria-current"), "page");
    assert.deepEqual(errors, [], errors.join("\n"));
  });
});

/*
 * An upload's preview checks the file against the whole list as it stands, read when the file is
 * picked. It checked against what the screen happened to hold instead: nothing yet while the list
 * was still loading, and only the matches while a search was typed. A player already banned then
 * read as new, and Apply banned them again.
 */
test("an upload's preview checks against the whole list, whatever the screen holds", { skip: SKIP }, async () => {
  const banned = { id: "b1", ts: new Date().toISOString(), by: "owner", playerName: "Banned", playerId: "13", platform: "steam", type: "perma", reason: "x", category: null, scope: { mode: "all" }, game: "hll", expiresAt: null, liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"] };
  let reads = 0;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    // The API applies the search, and the screen's first read is slow, as on a phone.
    "/api/bans": (url) => ({ body: { bans: url.searchParams.get("q") ? [] : [banned] }, delayMs: ++reads === 1 ? 5000 : 0 }),
  } }, async (page) => {
    const base = page.url().split("#")[0];
    const popup = page.locator(".pa-modal");
    const upload = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Bans$/ }) }).getByRole("button", { name: "Upload", exact: true });
    const file = { name: "bans.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([
      { playerId: "13", player: "Banned", type: "perma", until: null, game: "WW2", reason: "x", status: "active" },
      { playerId: "15", player: "Fresh", type: "perma", until: null, game: "WW2", reason: "x", status: "active" },
    ])) };
    const preview = async () => {
      await upload.click();
      await popup.locator("input[type=file]").setInputFiles(file);
      await popup.getByText(/\d+ new/).waitFor();
      const text = await popup.innerText();
      await popup.getByRole("button", { name: /Cancel|Close/ }).first().click();
      await popup.waitFor({ state: "detached" });
      return text;
    };

    // Before the screen's list has arrived.
    await page.goto(`${base}#/moderation/bans`, { waitUntil: "domcontentloaded" });
    await upload.waitFor();
    let text = await preview();
    assert.match(text, /1 new · 1 no change/, "the list still loading");
    assert.match(text, /Banned — already banned/);

    // With a search typed that the player already banned does not match.
    await page.getByPlaceholder("Search player, id, reason, staff, server…").fill("zzz");
    await page.locator(".empty-state", { hasText: "No bans match your search" }).waitFor();
    text = await preview();
    assert.match(text, /1 new · 1 no change/, "a search typed");
  });

  // The VIP list, before the screen's read of it has arrived: a permanent VIP stays "no change".
  let vipReads = 0;
  const paid = { id: "v1", serverId: "s1", playerId: "1", playerName: "Paid", comment: "x", expiration: null, pausedUntil: null, createdByName: "owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers/s1/vips": () => ({ body: { vips: [paid] }, delayMs: ++vipReads === 1 ? 5000 : 0 }),
  } }, async (page) => {
    const popup = page.locator(".pa-modal");
    await page.goto(`${page.url().split("#")[0]}#/players/vips`, { waitUntil: "domcontentloaded" });
    const upload = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Current VIPs" }) }).getByRole("button", { name: "Upload", exact: true });
    await upload.click();
    await popup.locator("input[type=file]").setInputFiles({ name: "vips.csv", mimeType: "text/csv", buffer: Buffer.from("Player,Player ID,Status,Expires (UTC)\r\nPaid,1,Permanent,\r\n") });
    await popup.getByText(/no change|new/).first().waitFor();
    assert.match(await popup.innerText(), /1 no change/, "the list still loading");
  });
});

test("what's new leaves out what a person cannot use, and an update with nothing for them, heading and all", { skip: SKIP }, async () => {
  const grants = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  const me = { body: { user: { id: "u2", username: "viewer", displayName: "viewer", createdAt: "2026-01-02T03:04:05.000Z" }, grants, limits: {}, roles: [], prefs: {} } };
  // The updates with a note for them: one about no screen in particular, or a screen they can open.
  const theirs = WHATS_NEW.filter((r) => r.items.some((it) => !it.where || it.where.some((id) => canOpenRoute(grants, routeById(id)))));
  assert.ok(theirs.length > 1 && theirs.length < WHATS_NEW.length, "some updates have nothing for them, and more than one has something");
  const headings = (where) => where.locator(".whats-new-day").allTextContents().then((all) => all.map((h) => h.replace(/ · .*/, "")));
  const notesUnder = (where) => where.locator("section").evaluateAll((sections) => sections.map((s) => s.querySelectorAll("li").length));
  await withPage({ grants, overrides: { "/api/me": me } }, async (page) => {
    const popup = page.getByRole("dialog", { name: "What's new" });
    await popup.getByText("Search finds players").waitFor();
    assert.equal(await popup.getByText("Upload a list again").count(), 0, "no list they could upload to");
    assert.deepEqual(await headings(popup), theirs.map((r) => `Build ${r.build}`), "a heading for each update with something for them, and no other");
    assert.ok((await notesUnder(popup)).every((n) => n > 0), "every heading over a note");
    await popup.getByRole("button", { name: "Got it" }).click();
    await page.goto(`${page.url().split("#")[0]}#/help/whats-new`, { waitUntil: "networkidle" });
    const help = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: /^What's new$/ }) });
    await help.locator(".whats-new li").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await headings(help), theirs.map((r) => `Build ${r.build}`), "Help keeps the same updates");
    assert.ok((await notesUnder(help)).every((n) => n > 0), "every heading over a note there too");
  });
});

/*
 * "Switch on death" asks for its own permission. The dialog asked about "Switch teams now" for it
 * while the server checks "Switch teams on death": someone given only the second was told the move
 * would go for approval, and then it happened at once; someone given only the first was told it
 * would happen, and it went for approval.
 */
test("switch on death asks for its own permission, not the one for switching now", { skip: SKIP }, async () => {
  const confirmFor = async (grants) => {
    let said = "";
    await withPage({ grants, overrides: ACTIVE_S1 }, async (page) => {
      await page.goto(`${page.url().split("#")[0]}?visit=1#/live`, { waitUntil: "networkidle" });
      await page.locator(".player-actions .pa-menu button").first().click();
      await page.locator(".pa-mi", { hasText: "Switch on death" }).click();
      const dialog = page.locator(".confirm-modal");
      await dialog.waitFor();
      said = (await dialog.textContent()) ?? "";
    });
    return said;
  };
  const own = await confirmFor([held("server.view", "read"), held("action.switch_death")]);
  assert.match(own, /stay put until their next death/, own);
  assert.doesNotMatch(own, /Send for approval/, own);
  const other = await confirmFor([held("server.view", "read"), held("action.switch")]);
  assert.match(other, /Send for approval/, other);
});

/*
 * The same for a phone, where the panel folds its menu away behind ☰ and moves Search and the
 * account into the bar along the top: every step, as it is on a phone, points at something on a
 * phone's screen — a screen's entry in the menu with the menu open, as Help's phone pictures show.
 */
test("every walkthrough step points at a control that is on a phone's screen too", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page) => {
    const browser = page.context().browser();
    const missing = [];
    const queue = [...WALKTHROUGHS];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        const grants = walkGrants(w);
        const overrides = { ...WALK_FIXTURES };
        const stub = await startStub({ grants, overrides });
        const context = await browser.newContext(PHONE_SCREEN);
        try {
          const fresh = await context.newPage();
          await fresh.addInitScript(() => window.localStorage.setItem("panel.token", "test-token"));
          for (const [n, step] of w.steps.entries()) {
            setStage(overrides, step, grants);
            const { el, why } = await stageStep(fresh, stub.base, step, n, { phone: true });
            if (!el) { missing.push(`${w.id} step ${n + 1}: ${why}`); continue; }
            // On the phone's screen, as the picture shows it — not in the menu folded away off it.
            const inView = await el.evaluate((e) => {
              e.scrollIntoView({ block: "center", inline: "nearest" });
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
            });
            await el.dispose();
            if (!inView) missing.push(`${w.id} step ${n + 1}: off the phone's screen`);
          }
        } finally {
          await context.close();
          await stub.close();
        }
      }
    }));
    assert.deepEqual(missing, [], `steps whose control is not on a phone's screen:\n${missing.join("\n")}`);
  });
});

/*
 * Every control on every screen has a walkthrough step pointing at it — for someone holding every
 * permission, who sees them all, with every folded panel opened — or is one of the kinds a
 * walkthrough explains once for all screens:
 *  - a tab, which some step presses;
 *  - a panel's title (it folds the panel), Arrange panels, Explanation and other fold-outs, a column's
 *    name (it sorts), a player's name, Download, a chart's keys, a list's pages, and a saved preset
 *    under a box ("Use a screen's panels and lists");
 *  - ↑ ↓ ✕ arranging a list's rows, copying an id, Refresh (or ↻), and a placeholder such as
 *    {player_name} or {vip_until:Server #2}; Clear filters under a list a filter emptied, and
 *    Try again under a read that failed;
 *  - a link to another screen, whose own walkthroughs explain it;
 *  - Help's own lists of walkthroughs, guides and updates ("Find help in the panel");
 *  - Cancel and Close.
 * A setting (a switch, a box to type in, a list to pick from, one of a set of choices, a quick pick,
 * a row of chips) is explained by a step ringing it, or naming it in `fields` about the panel it is
 * in. A row's control is one control on every row. The same holds for the menu and the bars around
 * the screens, on a computer and on a phone, and for Live as it can be left: the two teams, a side
 * locked, a player ticked, the roster filtered, the live feed. What is not covered yet is listed in
 * KNOWN_GAPS (test/coverage-kit).
 */
test("every control on every screen, and around it, has a walkthrough step, and every setting is explained", { skip: SKIP }, async () => {
  const grants = CAPABILITY_CATALOG.map((c) => held(c.key, "write"));
  const hubs = new Set(ROUTES.filter((r) => r.parent).map((r) => r.parent));
  const missing = [];
  const empty = new Set();
  const look = async (page, place, scope, routes, opts) => {
    for (const said of await uncovered(page, scope, coverageOf(routes === "all" ? ALL_STEPS : stepsOn(routes)), opts)) missing.push(`${place}: ${said}`);
  };
  await withPage({ grants, overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
    let visit = 0;
    const open = async (path) => {
      await page.goto(`${stub.base}/?cover=${++visit}#${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(250);
      await unfold(page);
    };
    for (const r of ROUTES) {
      if (hubs.has(r.id) || r.ownerOnly) continue;
      await open(r.path);
      await look(page, r.id, "main", [r.id], { help: r.id.startsWith("help.") });
    }
    for (const [path, routes] of SUBJECT_PAGES) {
      await open(path);
      await look(page, path, "main", routes);
    }
    // Live as it can be left: the two teams side by side, one side locked, a player ticked, the
    // roster filtered, the feed.
    await open("/live");
    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.waitForSelector(".team-split");
    await look(page, "live (Teams)", "main", ["live"]);
    await page.locator(".team-side-head").first().click();
    await page.waitForSelector(".locked-head");
    await look(page, "live (a side locked)", "main", ["live"]);
    await page.locator(".locked-head").click();
    await page.locator(".seg-btn", { hasText: "Table" }).first().click();
    await page.locator(".scoreboard tbody tr input[type=checkbox]").first().check();
    await look(page, "live (a player ticked)", "main", ["live"]);
    // Filtered to one role: how many of the roster are left, and the way back to all of them.
    const roles = page.locator(".roster-filters select").nth(1);
    await roles.selectOption({ index: 1 });
    await page.waitForTimeout(150);
    await look(page, "live (filtered)", "main", ["live"]);
    await roles.selectOption("all");
    await page.locator(".panel", { hasText: "Roster" }).getByRole("button", { name: "Live feed", exact: true }).click();
    await page.waitForTimeout(200);
    await look(page, "live (Live feed)", "main", ["live"]);
    await page.locator(".panel", { hasText: "Roster" }).getByRole("button", { name: "Scoreboard", exact: true }).click();
    // Around every screen: the menu, its search, the server picker and the account.
    await open("/");
    await look(page, "around the screens", "shell", "all");
    assert.deepEqual(errors, []);
    for (const r of unansweredReads(stub)) empty.add(r);
  });
  // On a phone: the bar along the top, the quick bar, and the menu behind ☰.
  await withPage({ grants, overrides: WALK_FIXTURES, viewport: PHONE }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/?cover=phone#/`, { waitUntil: "networkidle" });
    await look(page, "around the screens on a phone", "shell", "all");
    assert.deepEqual(errors, []);
    for (const r of unansweredReads(stub)) empty.add(r);
  });
  recordGaps("screens", missing);
  assert.deepEqual([...empty].sort(), [], "reads the walkthrough stage answered with nothing: give each its data in WALK_FIXTURES (test/walk-stage)");
  assert.deepEqual(missing, KNOWN_GAPS.screens, "controls no walkthrough step rings, and settings none names");
});

/*
 * On a phone the slideshow shows the panel as a phone shows it — the phone's picture — and a step
 * starting in the menu says to open it with ☰ first; on a computer, the computer's picture and no
 * such line.
 */
test("the slideshow shows a phone's pictures on a phone, and says when to open the menu", { skip: SKIP }, async () => {
  for (const [viewport, phone] of [[{ width: 390, height: 844 }, true], [{ width: 1280, height: 800 }, false]]) {
    await withPage({ grants: [held("audit.trail", "read")], overrides: WALK_FIXTURES, ...(phone ? { viewport } : {}) }, async (page, { errors }) => {
      if (!phone) await page.setViewportSize(viewport);
      await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
      await page.locator(".walk-card", { hasText: "Look back at what staff did" }).click();
      const slides = page.getByRole("dialog", { name: "Look back at what staff did" });
      await slides.locator(".walk-stage img").waitFor();
      const src = await slides.locator(".walk-stage img").getAttribute("src");
      assert.equal(src.startsWith("/walkthroughs/phone/"), phone, `${phone ? "a phone's" : "a computer's"} picture: ${src}`);
      assert.equal(await slides.getByText("Tap ☰ at the top left to open the menu first.").count(), phone ? 1 : 0, "Administration is in the menu");
      // A step on the screen itself needs no menu.
      await slides.getByRole("button", { name: "Next" }).click();
      await slides.getByText("Step 2 of", { exact: false }).waitFor();
      assert.equal(await slides.getByText("Tap ☰ at the top left to open the menu first.").count(), 0);
      assert.deepEqual(errors, []);
    });
  }
});

/*
 * An event's report that comes back without its parts — a proxy answering in the API's place — is
 * said to be unreadable. Drawn as if whole, it took the Report tab into its "could not be shown"
 * card.
 */
test("an event's report that comes back incomplete is said, not crashed on", { skip: SKIP }, async () => {
  await withPage({ grants: [held("events.manage", "read")], overrides: { ...WALK_FIXTURES, "/api/payout-events/ev2/report": { body: {} } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/events/report`, { waitUntil: "networkidle" });
    await page.getByText("This event's report could not be read.").waitFor();
    assert.equal(await page.getByText("This screen hit an error and could not be shown").count(), 0);
    assert.deepEqual(errors, []);
  });
});

/** Notes the time of every request the panel makes from here on, in the page's own clock. */
async function noteRequests(page) {
  await page.evaluate(() => {
    window.__asked = [];
    const real = window.fetch;
    window.fetch = (input, init) => {
      window.__asked.push([performance.now(), new URL(input instanceof Request ? input.url : String(input), window.location.href)]);
      return real(input, init);
    };
  });
}

/*
 * A screen's code loads the first time it is opened. Through React's Suspense (next/dynamic) the
 * screen then waited at least 300ms on its placeholder before showing, however fast its code came —
 * and it asks for its data only once shown. Every first opening in a visit paid that. Now a screen
 * shows, and asks, as soon as its code is in.
 */
test("a screen opened for the first time asks for its data as soon as its code is in", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await noteRequests(page);
    const waits = [];
    for (const [hash, asks] of [["#/history", "/api/servers/s1/events"], ["#/players", "/api/players"], ["#/analytics", "/api/analytics/server"]]) {
      const opened = await page.evaluate((h) => { const t = performance.now(); window.location.hash = h; return t; }, hash);
      const at = await page.waitForFunction(([a, since]) => window.__asked.find(([t, u]) => t >= since && u.pathname === a)?.[0] ?? false, [asks, opened]);
      waits.push(Math.round((await at.jsonValue()) - opened));
    }
    // Suspense's wait alone was 300ms, so each first opening asked 300ms on at the earliest.
    waits.sort((a, b) => a - b);
    assert.ok(waits[1] < 250, `screens asked for their data ${waits.join(", ")}ms after they were opened`);
    assert.deepEqual(errors, []);
  });
});

/*
 * Bans waited before asking for its list: the search's pause between keystrokes ran on opening the
 * screen too. Now it asks as soon as it shows; typing still waits, so a word is one read, not one a
 * letter.
 */
test("Bans asks for its list as soon as it shows; only typing in its search waits", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await noteRequests(page);
    const search = 'input[placeholder="Search player, id, reason, staff, server…"]';
    await page.evaluate((sel) => {
      new window.MutationObserver(() => { if (!window.__shown && window.document.querySelector(sel)) window.__shown = performance.now(); })
        .observe(window.document.body, { childList: true, subtree: true });
      window.location.hash = "#/moderation/bans";
    }, search);
    const asked = await page.waitForFunction(() => {
      const a = window.__asked.find(([, u]) => u.pathname === "/api/bans");
      return a && window.__shown ? a[0] - window.__shown : false;
    });
    const wait = await asked.jsonValue();
    assert.ok(wait < 120, `asked for the list ${Math.round(wait)}ms after the screen showed`);
    // Typing: two letters, one read, for both.
    await page.locator(search).click();
    await page.keyboard.type("xy", { delay: 40 });
    await page.waitForFunction(() => window.__asked.some(([, u]) => u.pathname === "/api/bans" && u.searchParams.get("q") === "xy"));
    await page.waitForTimeout(400);
    const searched = await page.evaluate(() => window.__asked.filter(([, u]) => u.pathname === "/api/bans" && u.searchParams.has("q")).map(([, u]) => u.searchParams.get("q")));
    assert.deepEqual(searched, ["xy"], "one read for the word typed");
    assert.deepEqual(errors, []);
  });
});

/*
 * The panel reads the server list once, for every screen. The dashboard's Servers tile read it
 * again on its own as soon as the dashboard's layout came — the same answer twice, and a whole
 * extra wait on every opening of the dashboard. It counts the list the panel holds now.
 */
test("the dashboard asks for the server list once: its Servers tile counts the list the panel holds", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { stub, errors }) => {
    await page.evaluate(() => { window.location.hash = "#/dashboard"; });
    const tile = page.locator(".stat-tile", { has: page.locator(".label", { hasText: /^configured$/ }) });
    await tile.locator(".value", { hasText: /^1$/ }).waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(stub.calls.filter((c) => c.method === "GET" && c.path === "/api/servers").length, 1, "the list, read once");
    assert.deepEqual(errors, []);
  });
});

/*
 * Lists that came whole and were drawn whole — VIPs, the ban record and the game's own ban list,
 * the watchlists, player rules, backups, a player's notes and IP history — show a page at a time,
 * with the pager and page sizes every other list has. Their order and their search still run over
 * the whole list, and each new one starts on its first page.
 */
const pad2 = (n) => String(n).padStart(2, "0");
/** a to b, counting either way. */
const span = (a, b) => Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a <= b ? a + i : a - i));
/** Polls `read` until it gives `want` (compared as JSON), or fails with what it gave last. */
async function until(read, want, label) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const got = await read();
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    if (Date.now() > deadline) assert.deepEqual(got, want, label);
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** What a list's footer says: "1–50 of 60 VIPs", or "11 VIPs — that's all of them". */
const footer = (scope) => scope.locator(".load-more > span").first().innerText();

test("the VIP list comes a page at a time, ordered and searched over all of it, and keeps its page", { skip: SKIP }, async () => {
  const day = 864e5;
  const vip = (n) => ({
    id: `v${n}`, serverId: "s1", playerId: `7656119800000${String(n).padStart(4, "0")}`, playerName: `Member ${pad2(n)}`, comment: "Paid",
    // Member 60 runs out first and Member 01 last: the opposite of the names' order.
    expiration: new Date(Date.parse("2026-12-01T00:00:00.000Z") + (61 - n) * day).toISOString(),
    pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, pausedAt: null, groupHold: null, perkGroups: [],
    createdByName: "Sam", createdAt: "2026-10-24T20:15:00.000Z", updatedAt: "2026-10-24T20:15:00.000Z",
  });
  // Handed over in no useful order: the panel's own sort puts them right, over the whole list.
  const vips = Array.from({ length: 60 }, (_, i) => vip(((i * 7) % 60) + 1));
  const history = Array.from({ length: 60 }, (_, i) => ({
    id: `h${i}`, ts: new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 3600e3).toISOString(), action: i % 2 ? "granted" : "revoked",
    by: "Sam", byUserId: null, serverId: "s1", serverName: "WW2 #1", expiration: null, comment: null,
  }));
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/vips": { body: { vips } }, "/api/players/p1/vip-history": { body: { history } } } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Current VIPs" }) });
    const names = () => panel.locator("tbody .player-link").allInnerTexts();
    const members = (ns) => ns.map((n) => `Member ${pad2(n)}`);

    // A page of the default fifty, in name order over the whole list, and the pager saying so.
    await until(names, members(span(1, 50)), "page one: Member 01 to 50");
    assert.equal(await footer(panel), "1–50 of 60 VIPs");
    await panel.getByTitle("Next page").click();
    await until(names, members(span(51, 60)), "page two: the last ten");
    assert.equal(await footer(panel), "51–60 of 60 VIPs");

    // Another order is another list: its first page, ordered over all sixty.
    await panel.locator("th.sortable", { hasText: "Expiration" }).click();
    await until(names, members(span(60, 11)), "soonest to run out first, from the whole list");
    await panel.getByTitle("Next page").click();
    await until(names, members(span(10, 1)), "page two of that order");

    // A search starts on its first page too, in the order chosen — one that finds all sixty, typed
    // on page two, as well as one that finds ten.
    const search = panel.getByPlaceholder("Search name or ID…");
    await search.fill("member");
    await until(names, members(span(60, 11)), "a search, from its first page");
    await search.fill("member 5");
    await until(names, members(span(59, 50)), "the ten it finds, soonest first");
    assert.equal(await footer(panel), "10 VIPs — that's all of them");
    await search.fill("");
    await until(names, members(span(60, 11)), "cleared: the whole list's first page");

    // The page is kept for the sitting: left on page two, it comes back there, in its order.
    await panel.getByTitle("Next page").click();
    await until(names, members(span(10, 1)), "page two");
    await page.goto(`${base}#/dashboard`, { waitUntil: "networkidle" });
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    await until(names, members(span(10, 1)), "back on page two, in the order chosen");

    // How many rows a page holds is the reader's choice, from the first page.
    await panel.getByLabel("VIPs per page").selectOption("25");
    await until(async () => (await names()).length, 25, "25 to a page");
    assert.equal(await footer(panel), "1–25 of 60 VIPs");

    // A list that already came in pages does the same: another order opens on its first page.
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    const vipHistory = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "VIP history" }) });
    const toggle = vipHistory.locator("button.panel-toggle");
    await toggle.waitFor();
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    await vipHistory.getByTitle("Next page").click();
    await vipHistory.locator(".pager-where", { hasText: "Page 2 of 3" }).waitFor();
    await vipHistory.locator("th.sortable", { hasText: "What" }).click();
    await vipHistory.locator(".pager-where", { hasText: "Page 1 of 3" }).waitFor();
    assert.deepEqual(errors, []);
  });
});

test("the lists already paged in the browser open another order on its first page", { skip: SKIP }, async () => {
  const at = "2026-10-01T00:00:00.000Z";
  const ballots = span(1, 60).map((n) => ({ id: `b${n}`, decidedAt: at, mapId: "foy", mapName: `Map ${pad2(n)}`, won: n % 2 === 0 }));
  const tally = span(1, 60).map((n) => ({ mapId: `m${n}`, name: `Map ${pad2(n)}`, offered: 61 - n, won: 1, votes: 2 }));
  const voters = span(1, 60).map((n) => ({ discordUserId: `d${n}`, discordName: `Voter ${pad2(n)}`, votes: 61 - n, wins: 1, lastVotedAt: at, userId: null, playerId: null, playerName: null }));
  const members = span(1, 60).map((n) => ({ groupId: "g1", playerId: `7656119800003${String(n).padStart(4, "0")}`, playerName: `Member ${pad2(n)}`, addedByName: "Sam", addedAt: at }));
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/players/p1/mapvote": { body: { linked: true, discordId: "d1", totals: { votes: 60, wins: 30, firstVotedAt: at, lastVotedAt: at }, preferences: [], ballots } },
    "/api/servers/s1/mapvote/history": { body: { history: [], total: 0, tally, voters } },
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "Clan match roster", description: "", memberCount: 60, createdByName: "Sam", vipPerk: null, discordRoleId: null }] } },
    "/api/player-groups/g1": { body: { members, perkStatus: null } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const reorder = async (panel, column, label) => {
      await panel.getByTitle("Next page").first().click();
      await panel.locator(".pager-where", { hasText: "Page 2 of 2" }).waitFor();
      await panel.locator("th.sortable", { hasText: column }).click();
      await panel.locator(".pager-where", { hasText: "Page 1 of 2" }).waitFor({ timeout: 10_000 }).catch(() => assert.fail(`${label}: another order stayed on page two`));
    };
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await reorder(page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Map votes" }) }), "Voted for", "a player's map votes");
    await page.goto(`${base}#/history/mapvotes`, { waitUntil: "networkidle" });
    await reorder(page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Which maps win" }) }), "Map", "the maps' table");
    await reorder(page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Who votes" }) }), "Who", "the voters");
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    await reorder(page.locator(".panel", { has: page.locator("th.sortable", { hasText: "Added by" }) }), "Added by", "a group's members");
    assert.deepEqual(errors, []);
  });
});

test("the ban record and the game's own ban list come a page at a time", { skip: SKIP }, async () => {
  const at = (n) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + n * 3600e3).toISOString();
  const bans = span(1, 60).map((n) => ({
    id: `b${n}`, ts: at(n), by: "Sam", playerName: `Banned ${pad2(n)}`, playerId: `7656119800001${String(n).padStart(4, "0")}`, platform: "steam",
    type: "temp", reason: "Teamkilling", category: "teamkilling", scope: { mode: "all" }, game: "hll",
    expiresAt: "2099-01-01T00:00:00.000Z", liftedAt: null, liftedBy: null, active: true, auto: false, serverIds: ["s1"],
  }));
  const live = span(1, 60).map((n) => ({
    playerId: `7656119800002${String(n).padStart(4, "0")}`, playerName: `Held ${pad2(n)}`, ts: at(n), durationHours: 24, reason: "Spawn camping", by: "Sam", type: "temp",
  }));
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/bans": { body: { bans } }, "/api/servers/s1/bans/live": { body: { bans: live } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/moderation/bans`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Bans$/ }) });
    const names = () => panel.locator("tbody .player-link").allInnerTexts();
    // The record, newest first over all sixty, fifty to a page.
    await until(names, span(60, 11).map((n) => `Banned ${pad2(n)}`), "the record's first page");
    assert.equal(await footer(panel), "1–50 of 60 bans");
    await panel.getByTitle("Next page").click();
    await until(names, span(10, 1).map((n) => `Banned ${pad2(n)}`), "and its second");
    await panel.locator("th.sortable", { hasText: "Player" }).click();
    await until(names, span(1, 50).map((n) => `Banned ${pad2(n)}`), "another order, from its first page");
    // The game's own list, the same way.
    await panel.locator(".seg-btn", { hasText: /^Live$/ }).click();
    await until(names, span(60, 11).map((n) => `Held ${pad2(n)}`), "the game's list, first page");
    assert.equal(await footer(panel), "1–50 of 60 bans");
    await panel.getByTitle("Next page").click();
    await until(names, span(10, 1).map((n) => `Held ${pad2(n)}`), "and its second");
    await panel.locator("th.sortable", { hasText: "Player" }).click();
    await until(names, span(1, 50).map((n) => `Held ${pad2(n)}`), "another order, from its first page");
    assert.deepEqual(errors, []);
  });
});

test("both watchlists come a page at a time", { skip: SKIP }, async () => {
  const watched = span(1, 60).map((n) => ({
    playerId: `p${n}x`, name: `Watched ${pad2(n)}`, watchlist: true, vip: false, online: n > 5, onlineServers: n > 5 ? ["Server #1"] : [],
    updatedByName: "Sam", updatedAt: "2026-10-22T19:00:00.000Z", watchReason: "Teamkilling", watchBy: "Sam", watchAt: "2026-10-22T19:00:00.000Z",
    reasons: [{ id: `w${n}`, reason: "Teamkilling", addedBy: "Sam", addedAt: "2026-10-22T19:00:00.000Z", expiresAt: null }],
  }));
  const label = (ns) => ns.map((n) => `Watched ${pad2(n)}`);
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/players/flagged": { body: { flags: watched } } } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    // Moderation's watchlist: fifty to a page, and a search from its first page.
    await page.goto(`${base}#/moderation/watched`, { waitUntil: "networkidle" });
    const list = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Watched players" }) });
    const names = () => list.locator("tbody .player-link").allInnerTexts();
    await until(names, label(span(1, 50)), "its first page");
    assert.equal(await footer(list), "1–50 of 60 players");
    await list.getByTitle("Next page").click();
    await until(names, label(span(51, 60)), "its second");
    await list.getByPlaceholder("Search names, reasons, staff…").fill("watched");
    await until(names, label(span(1, 50)), "a search finding all sixty, from its first page");
    await list.getByPlaceholder("Search names, reasons, staff…").fill("watched 5");
    await until(names, label(span(50, 59)), "a search, from its first page");
    assert.equal(await footer(list), "10 players — that's all of them");

    // The players screen's Watchlist tab: the same, and "On a server now" is its own first page.
    await page.goto(`${base}#/players/players`, { waitUntil: "networkidle" });
    const dir = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Directory" }) });
    await dir.locator(".seg-btn", { hasText: /^Watchlist$/ }).click();
    const rows = () => dir.locator("tbody tr td:first-child").allInnerTexts();
    await until(rows, label(span(1, 50)), "the tab's first page");
    assert.equal(await footer(dir), "1–50 of 60 players");
    await dir.getByTitle("Next page").click();
    await until(rows, label(span(51, 60)), "its second");
    await dir.locator(".seg-btn", { hasText: /^On a server now/ }).click();
    await until(rows, label(span(6, 55)), "those on a server, from their first page");
    assert.equal(await footer(dir), "1–50 of 55 players");
    assert.deepEqual(errors, []);
  });
});

test("a player's notes and IP history come a page at a time", { skip: SKIP }, async () => {
  const profile = { body: {
    player: { id: "p1", platformId: "76561198000000001", platform: "steam", name: "Subject", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
    stats: { kills: 1, deaths: 1, teamkills: 0, playtimeSec: 60, visits: 1 },
    flags: {}, recentEvents: [], sessions: [], aliases: [], matches: [], canViewNotes: true,
    notes: span(60, 1).map((n) => ({ id: `n${n}`, authorName: "Sam", body: `Note ${pad2(n)}`, createdAt: "2026-10-22T19:00:00.000Z" })),
  } };
  const ips = span(1, 60).map((n) => ({ ip: `203.0.113.${n}`, firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-10-24T20:00:00.000Z", seenCount: 1, sharedWith: [] }));
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/players/p1": profile, "/api/players/p1/ips": { body: { ips } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/~p1`, { waitUntil: "networkidle" });
    // Notes, newest first as written, fifty to a page.
    const notes = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Notes$/ }) });
    const bodies = () => notes.locator(".note > div:nth-child(2)").allInnerTexts();
    await until(bodies, span(60, 11).map((n) => `Note ${pad2(n)}`), "the notes' first page");
    assert.equal(await footer(notes), "1–50 of 60 notes");
    await notes.getByTitle("Next page").click();
    await until(bodies, span(10, 1).map((n) => `Note ${pad2(n)}`), "and their second");
    // IP history, opened: the same.
    const ipPanel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^IP history$/ }) });
    await ipPanel.locator("button.panel-toggle").click();
    const addresses = () => ipPanel.locator("tbody tr td:first-child code").allInnerTexts();
    await until(addresses, span(1, 50).map((n) => `203.0.113.${n}`), "the addresses' first page");
    assert.equal(await footer(ipPanel), "1–50 of 60 IPs");
    await ipPanel.getByTitle("Next page").click();
    await until(addresses, span(51, 60).map((n) => `203.0.113.${n}`), "and their second");
    assert.deepEqual(errors, []);
  });
});

test("player rules and backups come a page at a time", { skip: SKIP }, async () => {
  const rule = (n, playerId, playerName) => ({
    id: `tr${playerId}${n}`, playerId, playerName, event: "connect", steps: [{ action: "message", message: "Hi", hours: 0, points: 0, delaySec: 0 }],
    fireOnce: true, enabled: true, note: null, serverId: null, serverName: null, createdByName: "Sam", createdAt: "2026-10-23T19:00:00.000Z",
    firedCount: 0, lastFiredAt: null, disarmedAt: null, summary: `When they connect: message them (${pad2(n)})`,
  });
  const triggers = span(1, 60).map((n) => rule(n, `p${n}x`, `Ruled ${pad2(n)}`));
  const theirs = span(1, 60).map((n) => rule(n, "p1x", "Ruled 01"));
  const backups = span(1, 60).map((n) => ({ name: `backup-2026-08-${pad2(Math.ceil(n / 2))}T0${n % 2}-00-00Z.tar.gz`, bytes: 1_048_576, createdAt: "2026-08-01T03:00:00.000Z" }));
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/player-triggers": { body: { triggers } },
    "/api/players/p1x/triggers": { body: { triggers: theirs, allowedActions: ["message"], game: "hll" } },
    "/api/data/backups": { body: { backups } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    // Every player's rules, then one player's own.
    await page.goto(`${base}#/players/triggers`, { waitUntil: "networkidle" });
    const all = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "All triggers" }) });
    const players = () => all.locator("tbody tr td:first-child").allInnerTexts();
    await until(players, span(1, 50).map((n) => `Ruled ${pad2(n)}`), "every player's, first page");
    assert.equal(await footer(all), "1–50 of 60 triggers");
    await all.getByTitle("Next page").click();
    await until(players, span(51, 60).map((n) => `Ruled ${pad2(n)}`), "and the second");
    await all.getByTitle("First page").click();
    await all.locator("button.linklike", { hasText: "Ruled 01" }).click();
    const own = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Armed & spent triggers" }) });
    await own.locator(".pager-where", { hasText: "Page 1 of 2" }).waitFor();
    assert.equal(await own.locator("tbody tr").count(), 50, "one player's, fifty to a page");
    // Backups, fifty to a page.
    await page.goto(`${base}#/admin/backup`, { waitUntil: "networkidle" });
    const full = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Full backup" }) });
    const files = () => full.locator("tbody tr td:first-child code").allInnerTexts();
    await until(files, backups.slice(0, 50).map((b) => b.name), "the backups' first page");
    assert.equal(await footer(full), "1–50 of 60 backups");
    await full.getByTitle("Next page").click();
    await until(files, backups.slice(50).map((b) => b.name), "and their second");
    assert.deepEqual(errors, []);
  });
});

/*
 * Lists that stopped at the newest fifty or hundred — scheduled events, payout history, the staff
 * board, the leaderboard — are read from the server a page at a time, with how many there are; a
 * payout's recipients and receipts, the request history and the seed reward rounds are paged in
 * the browser. A change made to a row is seen on the page the reader was on.
 */
/** One page of `rows`, as the server answers the offset and limit `url` asks for. */
const pageOf = (rows, url) => {
  const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
  return rows.slice(offset, offset + limit);
};
/** Where each read of a list started, and how many it asked for. */
const where = (asked) => asked.map((u) => [u.get("offset"), u.get("limit")]);

test("scheduled events are read a page at a time, and a change keeps the reader's page", { skip: SKIP }, async () => {
  const at = (n) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + n * 3600e3).toISOString();
  // Newest first, as the API keeps them. Odd ones are still to come; even ones closed and unpaid.
  const event = (n) => ({
    id: `e${n}`, name: `Event ${pad2(n)}`, serverId: "s1", serverName: "Server #1", status: n % 2 ? "scheduled" : "closed",
    openMode: "at", openAnchor: at(n), openedAt: n % 2 ? null : at(n), closeMode: "at", closeAnchor: at(n + 1), closedAt: n % 2 ? null : at(n + 1),
    minMinutes: 0, mapVoteProfile: null, rotationSetId: null, roster: n % 2 ? null : [{ playerId: "p1", name: "Someone", minutes: 90 }],
    createdBy: "Sam", createdAt: at(n), payment: null,
  });
  const events = span(60, 1).map(event);
  const asked = [];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/payout-events": (url, req) => {
      if (req.method === "POST") { events.unshift(event(61)); return { body: { event: events[0] } }; }
      asked.push(url.searchParams);
      return { body: { items: pageOf(events, url), total: events.length } };
    },
    "/api/payout-events/e9/cancel": () => { events.find((e) => e.id === "e9").status = "cancelled"; return { body: { ok: true } }; },
    "/api/payout-events/e10/no-payout": () => { Object.assign(events.find((e) => e.id === "e10"), { noPayoutAt: at(70), noPayoutBy: "Sam" }); return { body: { event: {} } }; },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/events/schedule`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Scheduled events" }) });
    const names = () => panel.locator("table.data tbody tr td:first-child").allInnerTexts();
    const label = (ns) => ns.map((n) => `Event ${pad2(n)}`);
    await until(names, label(span(60, 11)), "the newest fifty");
    assert.equal(await footer(panel), "1–50 of 60 events");
    await panel.getByTitle("Next page").click();
    await until(names, label(span(10, 1)), "the ten before them");
    assert.deepEqual(where(asked).at(-1), ["50", "50"], "read from the server, fifty places down");

    // Cancelling one, and marking another as needing no payout, read the page they are on again.
    const row = (n) => panel.locator("table.data tbody tr", { has: page.locator("td:first-child", { hasText: new RegExp(`^Event ${pad2(n)}$`) }) });
    let reads = asked.length;
    await row(9).getByRole("button", { name: "Cancel" }).click();
    await row(9).locator("td", { hasText: /^cancelled$/ }).waitFor();
    assert.deepEqual(where(asked.slice(reads)), [["50", "50"]], "page two, read again");
    assert.equal(await panel.locator(".pager-where").innerText(), "Page 2 of 2");
    reads = asked.length;
    await row(10).getByRole("button", { name: "No payout needed" }).click();
    await row(10).locator("td", { hasText: /marked by Sam/ }).waitFor();
    assert.deepEqual(where(asked.slice(reads)), [["50", "50"]], "and again");

    // A new event is the newest: scheduling one opens page one, where it is.
    await panel.locator("label", { hasText: /^Name/ }).locator("input").fill("Event 61");
    await panel.locator("label", { hasText: /^Server/ }).locator("select").selectOption("s1");
    await panel.locator("label", { hasText: /^Open time/ }).locator("input").fill("2026-11-01T19:00");
    await panel.locator("label", { hasText: /^Close time/ }).locator("input").fill("2026-11-01T22:00");
    await panel.getByRole("button", { name: "Schedule event" }).click();
    await until(names, label(span(61, 12)), "page one, the new event first");
    assert.deepEqual(where(asked).at(-1), ["0", "50"]);
    assert.deepEqual(errors, []);
  });
});

test("payout history is read a page at a time, and a payout's recipients and receipts come in pages", { skip: SKIP }, async () => {
  const at = (n) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + n * 3600e3).toISOString();
  // 250 runs, newest first. Two still owe people: run 190, on the history's second page, and run
  // 3 — older than the newest 200, which are all the retry picker reads of its own.
  const owes = (n) => n === 3 || n === 190;
  const job = (n) => ({
    id: `j${n}`, sourceType: "online", payoutType: "currency", amount: n, serverIds: ["s1"], audience: "linked", dryRun: false,
    status: "COMPLETE", requestedByName: "Sam", createdAt: at(n), completedAt: at(n),
    totalCount: n === 3 ? 2500 : 10, successCount: n === 3 ? 2498 : owes(n) ? 8 : 10, failedCount: owes(n) ? 2 : 0,
  });
  const jobs = span(250, 1).map(job);
  const asked = [];
  const receipt = (n) => ({ id: n, displayName: `Paid ${pad2(n)}`, discordId: `d${n}`, status: "PASS", error: "", detail: {} });
  const recipient = (n) => ({ discordId: `d${n}`, playerId: null, displayName: `Member ${pad2(n)}`, sourceName: null, minutes: null });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/payouts": (url) => { asked.push(url.searchParams); return { body: { items: pageOf(jobs, url), total: jobs.length } }; },
    "/api/payouts/j3": { body: { job: job(3), items: span(1, 60).map(receipt), itemsTotal: 2500 } },
    "/api/payouts/preview": { body: { recipients: span(1, 60).map(recipient), dropped: { unlinked: 0, noRole: 0, underMinutes: 0, removed: 0, noGameAccount: 0 } } },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/events/payouts`, { waitUntil: "networkidle" });
    const history = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Payout history" }) });
    const whats = () => history.locator("table.data", { has: page.locator("th", { hasText: "When" }) }).locator("tbody tr td:nth-child(2)").allInnerTexts();
    await until(whats, span(250, 201).map((n) => `${n} point(s)`), "the newest fifty runs");
    assert.equal(await footer(history), "1–50 of 250 payouts");
    await history.getByTitle("Last page").click();
    await until(whats, span(50, 1).map((n) => `${n} point(s)`), "the oldest fifty");
    assert.deepEqual(where(asked).at(-1), ["200", "50"]);

    // An old run's receipts, a page at a time, saying how many of them the screen holds.
    const run = history.locator("tbody tr", { has: page.locator("td:nth-child(2)", { hasText: /^3 point\(s\)$/ }) });
    await run.getByRole("button", { name: "Receipts" }).click();
    await history.getByText("The first 60 of 2,500 are here").waitFor();
    const receipts = history.locator("table.data", { has: page.locator("th", { hasText: "Detail" }) });
    const paid = () => receipts.locator("tbody tr td:first-child").allInnerTexts();
    await until(paid, span(1, 50).map((n) => `Paid ${pad2(n)}`), "the receipts' first page");
    assert.equal(await history.locator(".load-more").nth(1).locator("span").first().innerText(), "1–50 of 60 receipts");
    await history.getByTitle("Next page").nth(1).click();
    await until(paid, span(51, 60).map((n) => `Paid ${pad2(n)}`), "and their second");

    // The retry picker offers the newest runs that owe anyone, whichever page the history is on —
    // and a run picked from a later page with its button, however old.
    const build = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "New payout" }) });
    await build.locator("label", { hasText: "Recipients come from" }).locator("select").selectOption("retry");
    const pick = build.locator("label", { hasText: "Payout to retry" }).locator("select");
    const offered = async () => (await pick.locator("option").allInnerTexts()).slice(1).map((t) => t.replace(/^.* — /, ""));
    await until(offered, ["190 pts, 2 failed"], "run 190, from the picker's own read of the newest runs");
    assert.ok(asked.some((u) => u.get("limit") === "200" && u.get("offset") === null), "which it made itself");
    await run.getByRole("button", { name: "Retry failures" }).click();
    await until(() => pick.inputValue(), "j3", "the run picked from page five is the one to retry");
    assert.deepEqual(await offered(), ["3 pts, 2 failed", "190 pts, 2 failed"]);
    await history.getByTitle("First page").click();
    await until(whats, span(250, 201).map((n) => `${n} point(s)`), "the history back on its first page");
    assert.equal(await pick.inputValue(), "j3", "and the run picked is still the one to retry");

    // Who a payout would reach, a page at a time.
    await build.locator("label", { hasText: "Recipients come from" }).locator("select").selectOption("online");
    await build.getByRole("button", { name: "Preview recipients" }).click();
    const list = build.locator("table.data", { has: page.locator("th", { hasText: "In game" }) });
    const who = () => list.locator("tbody tr td:first-child").allInnerTexts();
    await until(who, span(1, 50).map((n) => `Member ${pad2(n)}`), "the recipients' first page");
    assert.equal(await footer(build), "1–50 of 60 recipients");
    await build.getByTitle("Next page").click();
    await until(who, span(51, 60).map((n) => `Member ${pad2(n)}`), "and their second");
    assert.deepEqual(errors, []);
  });
});

test("the request history and the seed reward rounds come a page at a time", { skip: SKIP }, async () => {
  const at = (n) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + n * 3600e3).toISOString();
  const decisions = span(1, 60).map((n) => ({
    requestId: `r${n}`, lineId: `l${n}`, requesterName: "Jordan", filedAt: at(n), requestStatus: "closed", kind: "kick", serverId: "s1", serverName: "Server #1",
    playerId: `7656119800005${String(n).padStart(4, "0")}`, playerName: `Asked ${pad2(n)}`, state: "approved", decidedByName: "Sam", decidedAt: at(n),
    denyReason: null, applyError: null, modified: null, payload: { reason: "Teamkilling" },
  }));
  const rounds = span(60, 1).map((n) => ({
    round: `round-${n}`, at: at(n), manual: false, dryRun: false,
    receipts: [{ playerId: `p${n}`, name: `Seeder ${pad2(n)}`, summary: `Round ${pad2(n)}: a day of VIP`, outcome: "paid" }],
  }));
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/requests/history": { body: { decisions, limit: 200 } },
    "/api/servers/s1/seeding": seedingReply(41),
    "/api/servers/s1/seeding/payouts": { body: { rounds } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/moderation/requests`, { waitUntil: "networkidle" });
    const history = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "All request history" }) });
    const players = () => history.locator("tbody .player-link").allInnerTexts();
    const asked = (ns) => ns.map((n) => `Asked ${pad2(n)}`);
    await until(players, asked(span(60, 11)), "the latest decided first, fifty to a page");
    assert.equal(await footer(history), "1–50 of 60 decisions");
    await history.getByTitle("Next page").click();
    await until(players, asked(span(10, 1)), "and the ten before");
    // A filter typed on page two shows its own first page, and so does another order.
    await history.getByPlaceholder("Filter by player, staff member, action or reason…").fill("asked");
    await until(players, asked(span(60, 11)), "the filter, from its first page");
    await history.getByTitle("Next page").click();
    await until(players, asked(span(10, 1)), "its second");
    await history.locator("th.sortable", { hasText: "Player" }).click();
    await until(players, asked(span(1, 50)), "by player, from the first page");

    // The seed rewards' rounds, newest first, fifty to a page.
    await page.goto(`${base}#/autosettings/seeding`, { waitUntil: "networkidle" });
    const payouts = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Recent seed payouts" }) });
    const toggle = payouts.locator("button.panel-toggle");
    await toggle.waitFor();
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    const seen = () => payouts.locator("details.subcard li").allTextContents();
    await until(seen, span(60, 11).map((n) => `Round ${pad2(n)}: a day of VIP`), "the newest fifty rounds");
    assert.equal(await footer(payouts), "1–50 of 60 rounds");
    await payouts.getByTitle("Next page").click();
    await until(seen, span(10, 1).map((n) => `Round ${pad2(n)}: a day of VIP`), "and the ten before");
    assert.deepEqual(errors, []);
  });
});

test("the staff board comes a page at a time: each page's notices are new once, seen, and counted on their page", { skip: SKIP }, async () => {
  const at = (n) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + n * 3600e3).toISOString();
  // Newest first. Every third has not been read yet.
  const notice = (n) => ({
    id: `n${n}`, title: `Notice ${pad2(n)}`, body: "Read me", published: true, publishedAt: at(n), createdAt: at(n),
    authorUserId: null, myRead: n % 3 ? { readAt: at(n + 1), acknowledgedAt: null } : null,
  });
  const notices = span(60, 1).map(notice);
  const asked = { board: [], reach: [] };
  let calls = [];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/community/announcements/all": (url) => { asked.board.push(url.searchParams); return { body: { announcements: pageOf(notices, url), total: notices.length } }; },
    // The receipts are kept, as the API keeps them: a notice read once comes back read.
    "/api/community/announcements/read": () => {
      for (const id of calls.at(-1)?.body?.ids ?? []) {
        const n = notices.find((x) => x.id === id);
        if (n && !n.myRead) n.myRead = { readAt: at(99), acknowledgedAt: null };
      }
      return { body: { ok: true } };
    },
    "/api/community/announcements/analytics": (url) => {
      asked.reach.push(url.searchParams);
      const rows = pageOf(notices, url).map((n) => ({ id: n.id, title: n.title, published: n.published, publishedAt: n.publishedAt, readCount: 2, ackCount: 1, staffCount: 5, avgMinutesToSee: 30, medianMinutesToSee: 30 }));
      return { body: { staffCount: 5, postedCount: rows.length, overallReadRate: null, overallAvgMinutesToSee: null, notices: rows } };
    },
    "/api/community/announcements": (url, req) => {
      if (req.method !== "POST") return undefined;
      notices.unshift({ ...notice(61), myRead: null });
      return { body: { announcement: notices[0] } };
    },
    "/api/community/announcements/n5": () => { notices.find((x) => x.id === "n5").published = false; return { body: { announcement: {} } }; },
    "/api/community/announcements/n4/ack": () => ({ body: { read: { announcementId: "n4", readAt: at(5), acknowledgedAt: at(99) } } }),
  } }, async (page, { stub, errors }) => {
    calls = stub.calls;
    await page.goto(`${page.url().split("#")[0]}#/announcements`, { waitUntil: "networkidle" });
    const board = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Notices/ }) });
    const titles = () => board.locator(".subcard > .row strong").allInnerTexts();
    const fresh = () => board.locator(".subcard", { has: page.locator(".badge:text-is('NEW')") }).locator(".row strong").allInnerTexts();
    const seenButtons = () => board.locator("button", { hasText: /^Seen / }).count();
    const reads = () => calls.filter((c) => c.method === "POST" && c.path === "/api/community/announcements/read").map((c) => c.body.ids);
    const label = (ns) => ns.map((n) => `Notice ${pad2(n)}`);
    const unread = (ns) => ns.filter((n) => n % 3 === 0);

    // Page one: its unread notices are new, and are marked seen; its reach is read for it.
    await until(titles, label(span(60, 11)), "the newest fifty");
    assert.equal(await footer(board), "1–50 of 60 notices");
    await until(fresh, label(unread(span(60, 11))), "page one's unread notices are new");
    await until(reads, [unread(span(60, 11)).map((n) => `n${n}`)], "and seen, those and no others");
    await until(seenButtons, 50, "each with its reach");

    // Page two: the same for its own.
    await board.getByTitle("Next page").click();
    await until(titles, label(span(10, 1)), "the ten before");
    await until(fresh, label(unread(span(10, 1))), "page two's unread notices are new");
    await until(reads, [unread(span(60, 11)).map((n) => `n${n}`), unread(span(10, 1)).map((n) => `n${n}`)], "page two's, seen");
    await until(seenButtons, 10, "their reach, read for page two");
    assert.deepEqual(where(asked.reach).at(-1), ["50", "50"]);

    // An acknowledgement shows on the notice at once.
    const four = board.locator(".subcard", { hasText: "Notice 04" });
    await four.getByRole("button", { name: "✓ Acknowledge" }).click();
    await four.locator(".badge", { hasText: "✓ Acknowledged" }).waitFor();

    // Unposting one keeps the page; it reads as a draft where it was.
    const reads2 = asked.board.length;
    await board.locator(".subcard", { hasText: "Notice 05" }).getByRole("button", { name: "Unpost" }).click();
    await board.locator(".subcard", { hasText: "Notice 05" }).locator(".badge:text-is('draft')").waitFor();
    assert.deepEqual(where(asked.board.slice(reads2)), [["50", "50"]], "page two, read again");
    assert.equal(await board.locator(".pager-where").innerText(), "Page 2 of 2");

    // A notice posted from page two is at the top of page one, and is not new to whoever posted
    // it. What was new this visit still is, and only the new notice is marked seen.
    const compose = page.locator(".panel", { has: page.locator(".panel-title", { hasText: "Post a notice" }) });
    await compose.locator("label", { hasText: /^Title/ }).locator("input").fill("Notice 61");
    await compose.locator("label", { hasText: /^Body/ }).locator("textarea").fill("Read me");
    await compose.getByRole("button", { name: "Add notice" }).click();
    await until(titles, label(span(61, 12)), "page one, the new notice first");
    assert.deepEqual(await fresh(), label(unread(span(60, 12))), "the poster's own notice is not new to them");
    await until(reads, [unread(span(60, 11)).map((n) => `n${n}`), unread(span(10, 1)).map((n) => `n${n}`), ["n61"]], "seen: the new notice, and nothing twice");
    assert.deepEqual(errors, []);
  });
});

test("the leaderboard comes a page at a time, numbered from the top, and another ranking opens on its first page", { skip: SKIP }, async () => {
  const line = (n) => ({ playerId: `p${n}x`, name: `Ranked ${pad2(n)}`, kills: 1000 - n, deaths: n, teamkills: 0, kd: (1000 - n) / n,
    combat: 0, offense: 0, defense: 0, support: 0, slSeconds: 0, playtime: 3600 });
  const standings = span(1, 60).map(line);
  const asked = [];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/leaderboard": (url) => {
      asked.push(url.searchParams);
      return { body: { sort: url.searchParams.get("sort"), serverId: url.searchParams.get("serverId"), leaderboard: pageOf(standings, url), total: standings.length } };
    },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/leaderboard`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Leaderboard$/ }) });
    const places = () => panel.locator("tbody tr").evaluateAll((rows) => rows.map((r) => `${r.cells[0].textContent} ${r.cells[1].textContent}`));
    await until(places, span(1, 50).map((n) => `${n} Ranked ${pad2(n)}`), "the top fifty");
    assert.equal(await footer(panel), "1–50 of 60 players");
    await panel.getByTitle("Next page").click();
    await until(places, span(51, 60).map((n) => `${n} Ranked ${pad2(n)}`), "places 51 to 60, numbered from the top");
    assert.deepEqual(where(asked).at(-1), ["50", "50"]);
    // Ranked by something else, it is another board, from its first place.
    await panel.locator("select[aria-label='Rank by']").selectOption("deaths");
    await panel.locator(".pager-where", { hasText: "Page 1 of 2" }).waitFor();
    assert.deepEqual([asked.at(-1).get("sort"), asked.at(-1).get("offset")], ["deaths", "0"]);
    assert.deepEqual(errors, []);
  });
});
