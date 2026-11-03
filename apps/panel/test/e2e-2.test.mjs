// Browser smoke tests for the panel: the REAL built bundle (out/) served over a stubbed API,
// driven by Chromium. Self-skipping where the environment can't run them:
//   - needs a Chromium binary (CHROMIUM env var, or the standard Playwright cache path)
//   - needs the panel built (pnpm --filter @app/panel build)
// so `pnpm -w test` stays green on machines without a browser while CI/dev boxes with one get
// real coverage.
//
// Part 2 of 3: the tests are spread over several files so they run side by side; the
// shared harness and helpers live in ./e2e-kit.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startStub, OWNER_GRANTS, STAFF_PANEL } from "./stub-api.mjs";
import { unzipStored } from "./unzip.mjs";
import { WALK_FIXTURES, findIn, setStage, stageStep, walkGrants } from "./walk-stage.mjs";
import { WALKTHROUGHS } from "../lib/walkthroughs.ts";
import { here, CHROMIUM, SKIP, withPage, MAPVOTE_FIXTURES, mapvoteFixture, inFront, TWO_OF_ONE_GAME, fieldValues, seedingReply, held, onlyTab, panelTitles, panelTitled, stubRoleMap, THREE_SERVERS, ONE_PANEL_ROLE, ONE_GUILD_ROLE, ACTIVE_S1, TWO_SERVERS, TK_ROSTER, touchDrag, PHONE, apiCalls, rightEdge, PUB_ALPHA, SLOW_WRITE_MS, writesTo, STALE_MS, PUSH_KEY, fakePush } from "./e2e-kit.mjs";

/*
 * The widget vocabulary, rendered.
 *
 * A widget's UI is DATA — a plugin describes blocks and the panel draws them, so no plugin code
 * ever reaches the browser. That contract is only worth having if the vocabulary can express what
 * the panel's own screens express; it used to be markdown, one number, a table and a feed, so a
 * plugin page was visibly a lesser citizen. This drives every block type through a real browser
 * against static sources, which is the only way to know the renderer actually draws them.
 */
test("widgets: every block type renders, with the panel's own formatting", { skip: SKIP }, async () => {
  const view = { blocks: [
    { type: "note", text: "Heads up, this is a note.", variant: "warn" },
    { type: "stats", source: { kind: "static", value: { players: 1234, share: 0.42, uptime: 4320 } }, tiles: [
      { label: "Players", key: "players", format: "number", accent: true },
      { label: "Share", key: "share", format: "percent" },
      { label: "Uptime", key: "uptime", format: "duration" },
    ] },
    { type: "bars", source: { kind: "static", value: [
      { label: "Foy", value: 30 }, { label: "Carentan", value: 12 },
    ] }, format: "number" },
    { type: "stat", label: "Last seen", format: "time",
      source: { kind: "static", value: new Date(Date.now() - 5 * 60_000).toISOString() } },
    // Ten slices against a seven-colour palette: the tail has to fold, or the extra bands all
    // wear the same colour and stop being identifiable.
    { type: "split", source: { kind: "static", value: [
      { label: "Allies", value: 60 }, { label: "Axis", value: 40 },
      { label: "C", value: 9 }, { label: "D", value: 8 }, { label: "E", value: 7 },
      { label: "F", value: 6 }, { label: "G", value: 5 }, { label: "H", value: 4 },
      { label: "I", value: 3 }, { label: "J", value: 2 },
    ] } },
    { type: "table", source: { kind: "static", value: [
      { name: "Ana", kills: 1500, kd: 2.25 },
    ] }, columns: [
      { key: "name", label: "Player" },
      { key: "kills", label: "Kills", format: "number" },
      { key: "kd", label: "K/D", format: "decimal" },
    ] },
  ] };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/layout/dashboard": { body: { source: "default", widgets: [
        { id: "w-demo", title: "Block demo", visible: true, order: 10, required: false, size: { w: 4, h: 3 }, view },
      ] } },
    },
  }, async (page, { errors }) => {
    await page.waitForFunction(() => /Block demo/.test(window.document.body.innerText), null, { timeout: 15_000 });
    // A <Time> paints its relative label in an effect, a frame after the widget around it; on a
    // loaded machine (the full battery runs every suite at once) that frame can land after the
    // text below is read. Wait for every one to have painted — and fall through if one never
    // does, so the assertion names what is missing rather than a bare timeout.
    await page.waitForFunction(() => {
      const times = [...window.document.querySelectorAll("time")];
      return times.length > 0 && times.every((t) => (t.textContent ?? "").trim() !== "");
    }, null, { timeout: 15_000 }).catch(() => {});
    const text = await page.evaluate(() => window.document.body.innerText);

    assert.match(text, /Heads up, this is a note\./, "note block");
    // Formatted with the panel's own helpers, not String(value): separators, a rate as a
    // percentage, seconds coarsened to hours and minutes.
    assert.match(text, /1,234/, "number format separates thousands");
    assert.match(text, /42%/, "a 0-1 rate reads as a percentage");
    assert.match(text, /1h 12m/, "seconds read as a duration");
    assert.match(text, /Foy/, "bars block drew its labels");
    assert.match(text, /Allies/, "split block drew its slices");
    assert.match(text, /1,500/, "table columns are formatted too");
    assert.match(text, /2\.3|2\.2/, "K/D to one decimal place");
    // `time` is a live component, not a string: the same format must not read as "3 minutes ago"
    // in a table and as a raw ISO stamp in a tile beside it.
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(text), "no raw ISO timestamps anywhere in a widget");
    assert.match(text, /ago|now|Just/i, "the time format rendered as a human label");
    // A share bar identifies slices by colour and the palette has seven, so a longer list folds.
    assert.match(text, /Other \(4\)/, "slices past the palette fold into Other");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("nav respects grants: viewer only sees view areas; a global Block hides even those", { skip: SKIP }, async () => {
  // read-only viewer
  await withPage({ grants: [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }] }, async (page) => {
    assert.ok((await page.locator(".nav-item", { hasText: "Live" }).count()) >= 1, "viewer sees Live");
    for (const hidden of ["Administration", "Auto settings"]) {
      assert.equal(await page.locator(".nav-item", { hasText: hidden }).count(), 0, `viewer does not see ${hidden}`);
    }
  });
  // same read grant (as if from a role) plus a personal explicit Block: not even viewing
  await withPage({ grants: [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "server.view", scopeType: "global", scopeId: null, level: "none" },
  ] }, async (page) => {
    for (const hidden of ["Live", "History", "Players"]) {
      assert.equal(await page.locator(".nav-item", { hasText: hidden }).count(), 0, `blocked viewer does not see ${hidden}`);
    }
  });
});

test("permission denials from the API surface their message in the view", { skip: SKIP }, async () => {
  const denied = {
    status: 403,
    body: { error: { code: "forbidden", message: "missing permission: View ban lists (Bans & VIP) — read access required", missing: { capability: "moderation.bans", level: "read" } } },
  };
  await withPage({
    grants: [
      { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
      { capability: "moderation.bans", scopeType: "global", scopeId: null, level: "read" },
    ],
    overrides: { "/api/bans": denied },
  }, async (page) => {
    await page.locator(".nav-item", { hasText: "Moderation" }).first().click();
    await page.waitForSelector(".error");
    const text = await page.locator(".error").first().textContent();
    assert.match(text ?? "", /missing permission: View ban lists/);
  });
});

test("map vote: a server pairs a library set with a library schedule", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: MAPVOTE_FIXTURES }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/votesetup`, { waitUntil: "networkidle" });
    await page.waitForSelector(".setting-card select", { timeout: 15000 });

    // Two lines, each a set dropdown beside a schedule dropdown — the sets themselves are not on
    // the page at all until you open the library, which is the point on a phone.
    const setup = page.locator(".panel", { hasText: "Vote setup" }).first();
    assert.equal(await setup.locator(".mapset-bucket").count(), 0, "no map set is expanded by default");
    const picked = await setup.locator("select").evaluateAll((els) => els.map((e) => e.value));
    assert.ok(picked.includes("default") && picked.includes("Daytime"), `the pairings are shown, got ${JSON.stringify(picked)}`);

    // The library is where a set is edited, and it says who else is using it.
    await page.locator("button", { hasText: "Manage map sets" }).first().click();
    assert.match(await setup.innerText(), /Map sets belong to the whole community/);
  });
});

/*
 * A refresh keeps the back trail as it was. The router starts on its fallback screen for one render
 * before it reads the address, and that render used to be noted as a visit: after a refresh, Back
 * offered "Back to Dashboard", a screen nobody had opened, and went there. A link opened in a new
 * tab likewise starts its trail at the screen it names.
 */
test("a refresh keeps the back trail as it was, with no visit to a screen nobody opened", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const trail = (pg) => pg.evaluate(() => JSON.parse(window.sessionStorage.getItem("panel.trail") ?? "{}"));
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/players/vips");
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.document.querySelector(".sidebar .trail-btn")?.title.includes("Back to VIPs"));
    const before = await trail(page);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/maps/rotation");
    await page.waitForFunction(() => window.document.querySelector(".sidebar .trail-btn")?.title.includes("Back to VIPs"));
    assert.deepEqual(await trail(page), before, "the same trail, at the same place");

    // A new tab is a page with no trail of its own yet (it lives in the tab's session storage).
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.location.hash === "#/players/vips");
    await page.waitForSelector(".sidebar .trail-btn");
    assert.deepEqual((await trail(page)).entries, ["/players/vips"]);
    assert.equal(await page.locator(".sidebar .trail-btn").first().isDisabled(), true, "nothing before it to go back to");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The Dashboard's first lines each end in the button that deals with them. A watched player in game
 * with a 32-character name and no spaces widened the whole list past a phone's edge, and every
 * line's button with it: "Open watchlist" and "Review connections" were cut off at the right.
 */
test("the Dashboard's lines keep their buttons on screen when a watched player has a long name", { skip: SKIP }, async () => {
  const LONG = "XxX_WolfpackCommanderEliteXx_XxX";
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 }, overrides: {
    "/api/players/flagged": { body: { flags: [{ playerId: "p1", name: LONG, watchlist: true, online: true, onlineServers: [{ serverId: "s1", serverName: "Test Server #1" }], reasons: [] }] } },
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });
    await page.locator(".attention", { hasText: LONG }).waitFor({ timeout: 10_000 });
    const edge = await page.evaluate(() => window.document.documentElement.clientWidth);
    const buttons = page.locator(".attention button");
    assert.ok(await buttons.count() >= 2, "the watched player's line and the observe-mode line, each with its button");
    for (const right of await buttons.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right))) {
      assert.ok(right <= edge, `a line's button ends inside the screen: ${Math.round(right)} of ${edge}px`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A profile is one game's account, and its actions go to the selected server. With the Vietnam
 * server selected, Search lists the WW2 players too; opening one left every action aimed at a
 * server where that player does not exist. The panel now moves to a server of the player's game —
 * the one they played on last — once, and says so.
 */
test("a player opened from Search moves the panel to a server of their own game", { skip: SKIP }, async () => {
  const at = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  const servers = [
    { id: "s1", name: "WW2 One", game: "hll", engagementMode: "active", no: 1 },
    { id: "s2", name: "WW2 Two", game: "hll", engagementMode: "active", no: 2 },
    // Three was decommissioned, so Vietnam is four.
    { id: "s4", name: "Vietnam", game: "hllv", engagementMode: "active", no: 4 },
  ];
  const profile = (id, platform, game, sessions = [], extra = {}) => ({ body: {
    player: { id, name: "KREITZ", platform, platformId: `${id}-account`, game, firstSeen: at(90), lastSeen: at(1) },
    stats: { kills: 3, deaths: 2, teamkills: 0 }, flags: { watchlist: false, vip: false, updatedByName: null },
    statsByServer: [], sessions, recentEvents: [], ...extra,
  } });
  const session = (serverId, days) => ({ id: `${serverId}-${days}`, serverId, serverName: serverId, connectedAt: at(days), disconnectedAt: at(days), durationSec: 600 });
  const overrides = {
    "/api/servers": { body: { servers } },
    "/api/players": (url) => (url.searchParams.get("q") === null ? undefined : { body: { players: [
      { id: "pw", name: "KREITZ", platform: "steam", platformId: "pw-account", game: "hll", lastSeen: at(1) },
      { id: "pv", name: "KREITZ", platform: "epic", platformId: "pv-account", game: "hllv", lastSeen: at(30) },
    ], total: 2 } }),
    // Played on WW2 Two last, WW2 One before that: Two is where the profile belongs.
    "/api/players/pw": profile("pw", "steam", "hll", [session("s1", 20), session("s2", 2)]),
    "/api/players/pv": profile("pv", "epic", "hllv"),
    // On WW2 One right now, though they played on Two last.
    "/api/players/po": profile("po", "xbox", "hll", [session("s2", 1)], { onlineNow: true, onlineServers: [{ serverId: "s1", serverName: "WW2 One" }] }),
  };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 }, overrides }, async (page, { errors }) => {
    const posted = [];
    await page.route("**/api/servers/*/actions", async (r) => {
      posted.push(new URL(r.request().url()).pathname);
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.evaluate(() => window.localStorage.setItem("panel.serverId", "s4"));
    await page.reload({ waitUntil: "networkidle" });
    const selected = () => page.evaluate(() => window.document.querySelector(".server-badge")?.textContent ?? "");
    await page.waitForFunction(() => window.document.querySelector(".server-badge")?.textContent === "4");
    // The Players group by its own label: a screen's group lists "Players › Directory", and a
    // screen's description can hold a platform's letters ("steamroll").
    const found = page.locator(".cmdk-group").filter({ has: page.locator(".cmdk-group-label", { hasText: /^Players$/ }) });
    const open = async (platform) => {
      await page.locator(".topbar .cmdk-trigger").tap();
      await page.locator(".cmdk input").fill("Kreit");
      const row = found.locator(".cmdk-item", { hasText: platform });
      await row.waitFor();
      await row.tap();
    };

    // The WW2 KREITZ, picked with the Vietnam server selected.
    await open("Steam");
    await page.waitForFunction(() => window.location.hash.includes("pw"));
    await page.waitForFunction(() => window.document.querySelector(".server-badge")?.textContent === "2", null, { timeout: 10_000 });
    assert.match(await page.locator(".toast-stack").innerText(), /Switched to server 2 — this is a WW2 profile\./);
    // So the profile's actions reach a server that knows the player.
    await page.locator(".pa-menu button").first().tap();
    await page.locator(".pa-mi", { hasText: "Send message" }).tap();
    await page.locator(".pa-modal textarea").fill("Hello");
    await page.locator(".pa-actions button:not(.ghost)").tap();
    await page.waitForFunction(() => !window.document.querySelector(".pa-modal"), null, { timeout: 10_000 });
    assert.deepEqual(posted, ["/api/servers/s2/actions"]);

    // Vietnam picked again by hand, on the same profile: that stands.
    await page.locator(".topbar .cmdk-trigger").tap();
    await page.locator(".cmdk input").fill("Vietnam");
    await page.locator(".cmdk-group", { hasText: "Switch server" }).locator(".cmdk-item", { hasText: "Vietnam" }).tap();
    await page.waitForFunction(() => window.document.querySelector(".server-badge")?.textContent === "4");
    await page.waitForTimeout(800);
    assert.equal(await selected(), "4", "the choice made by hand is kept");

    // The Vietnam KREITZ opens where it is, on the Vietnam server.
    await open("Epic");
    await page.waitForFunction(() => window.location.hash.includes("pv"));
    await page.locator(".profile-name").waitFor();
    await page.waitForTimeout(800);
    assert.equal(await selected(), "4", "already a server of their game");
    assert.doesNotMatch((await page.locator(".toast-stack").allInnerTexts()).join(" "), /Vietnam profile/, "and nothing claims it moved");

    // Opened any other way, here a link, it moves the same: to a server they are on right now,
    // ahead of the one they played on last.
    await page.evaluate(() => { window.location.hash = "#/players/~po"; });
    await page.waitForFunction(() => window.document.querySelector(".server-badge")?.textContent === "1", null, { timeout: 10_000 });
    assert.match(await page.locator(".toast-stack").innerText(), /Switched to server 1 — this is a WW2 profile\./);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a failed game-list load is said out loud with a retry, never an empty dropdown", { skip: SKIP }, async () => {
  // The exact production failure this guards: one dropped request on a phone left the Game select
  // reading "No Options" with no error and no way back short of reloading the whole page. The
  // stub answers 500 once, then recovers — the Retry button must complete the add form in place.
  let calls = 0;
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [] } },
      "/api/games": () => (++calls === 1
        ? { status: 500, body: { error: { message: "the backend is restarting" } } }
        : { body: { games: [{ id: "hll", label: "Hell Let Loose", protocols: [{ id: "binary-v2", label: "binary-v2 (current HLL)" }] }] } }),
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/connections`, { waitUntil: "networkidle" });
    await page.locator(".empty-state button", { hasText: "Add a server" }).click();

    // The failure is visible, names the cause, and blocks a submit that could not succeed.
    const alert = page.locator("form .error", { hasText: /could not load the game list/i });
    await alert.waitFor({ timeout: 10_000 });
    assert.match(await alert.innerText(), /restarting/i, "the API's own message is shown, not a generic shrug");
    assert.ok(await page.locator("form button[type=submit]").isDisabled(), "Add stays disabled while there is no game list");

    // Retry recovers in place — no page reload.
    await page.locator("form .error button", { hasText: "Retry" }).click();
    await page.waitForFunction(() => {
      const opts = [...window.document.querySelectorAll("form select")[0].options].map((o) => o.textContent);
      return opts.includes("Hell Let Loose");
    }, null, { timeout: 10_000 });
    assert.ok(!(await page.locator("form button[type=submit]").isDisabled()), "Add re-enables once the list loads");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A time says how long ago, and the exact date and time are a tap away: phones have no hover, so
 * the tooltip alone never reached them. The tap is the time's own — the directory row it sits in
 * opens a profile on a tap, and must not open it for a tap on the time too.
 */
test("tapping a time shows its exact date and time, and the row it sits in does not act on that tap", { skip: SKIP }, async () => {
  const lastSeen = new Date(Date.now() - 3 * 60_000).toISOString();
  const player = { id: "p1", name: "Caereca", platform: "steam", platformId: "76561198000000001", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen, kills: 3, teamkills: 0, visits: 2, playtimeSec: 3600 };
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: { "/api/players": { body: { players: [player], total: 1 } } },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/directory`, { waitUntil: "networkidle" });
    const sel = `tbody tr time[datetime="${lastSeen}"]`;
    const time = page.locator(sel);
    await time.waitFor();
    assert.match(await time.innerText(), /^3 min ago$/);
    const exact = await time.getAttribute("title");
    assert.match(exact, /\d{4}/, "the tooltip carries the exact date");
    // iPhone Safari only hands a tap's click to an element that looks clickable.
    assert.equal(await time.evaluate((el) => window.getComputedStyle(el).cursor), "pointer");

    await time.tap();
    await page.waitForFunction(([s, want]) => window.document.querySelector(s)?.textContent === want, [sel, exact]);
    assert.match(await time.getAttribute("title"), /min ago/, "the tooltip is now the other form");
    assert.equal(await page.evaluate(() => window.location.hash), "#/players/directory", "the row did not open the profile");
    await time.tap();
    await page.waitForFunction((s) => window.document.querySelector(s)?.textContent === "3 min ago", sel);

    // Anywhere else on the row still opens the profile.
    await page.locator("tbody tr td", { hasText: "Caereca" }).tap();
    await page.waitForFunction(() => /p1/.test(window.location.hash));
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // A server's "last reached", answering or not, is the same tappable time.
  const reachedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: { "/api/servers": { body: { servers: [
      { id: "s1", name: "Alpha", host: "h1", port: 1, protocol: "binary-v2", game: "hll", engagementMode: "active", lastContactAt: reachedAt },
      { id: "s2", name: "Bravo", host: "h2", port: 2, protocol: "binary-v2", game: "hll", engagementMode: "active", lastContactAt: reachedAt, lastError: "connection refused", lastErrorAt: reachedAt },
    ] } } },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/connections`, { waitUntil: "networkidle" });
    for (const card of ["Alpha", "Bravo"]) { // reached, then not answering
      const time = page.locator(".subcard", { hasText: card }).locator(`time[datetime="${reachedAt}"]`);
      await time.waitFor();
      const exact = await time.getAttribute("title");
      await time.tap();
      assert.equal(await time.innerText(), exact, `${card}: the exact time on a tap`);
    }
  });
});

/*
 * A popup opened from a roster row is drawn inside the row's table cell, and the roster's cells
 * never wrap their text, so nothing in the popup wrapped either: on a phone the VIP editor's and
 * the temp ban's hints ran off the dialog's edge mid-word, its content 1,100px wide in a 350px box.
 */
test("a popup opened from a roster row wraps its text and fits the screen", { skip: SKIP }, async () => {
  const servers = { body: { servers: [{ id: "s1", name: "Test Server #1", game: "hll", engagementMode: "active", no: 1 }] } };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 }, overrides: { "/api/servers": servers } }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    const more = page.locator("table button[aria-label='More']").first();
    for (const item of ["Edit VIP", "Temp ban", "Send message"]) {
      await more.click();
      await page.locator(".pa-dropdown .pa-mi", { hasText: item }).click();
      const modal = page.locator(".pa-modal");
      await modal.waitFor();
      const m = await modal.evaluate((el) => ({ needs: el.scrollWidth, has: el.clientWidth }));
      assert.ok(m.needs <= m.has + 1, `${item}: the popup's content is ${m.needs}px wide in ${m.has}px`);
      await modal.locator("button", { hasText: "Cancel" }).click();
      await modal.waitFor({ state: "detached" });
    }
  });
});

/*
 * Making an API token takes the API tokens permission, and a token works only while its maker
 * holds it. Without it Settings offers nothing to make: no card at all, unless tokens made before
 * are still listed, and then it says they don't work and still lets you revoke them.
 */
test("API tokens in Settings: made with the permission, and only listed to revoke without it", { skip: SKIP }, async () => {
  const VIEW = { capability: "server.view", scopeType: "global", scopeId: null, level: "read" };
  const TOKENS = { capability: "api.tokens", scopeType: "global", scopeId: null, level: "write" };
  const card = (page) => page.locator(".panel", { has: page.locator(".panel-title", { hasText: "API tokens" }) });
  const open = async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/settings`, { waitUntil: "networkidle" });
    await page.locator(".panel-title", { hasText: "Appearance" }).waitFor();
  };
  // The card starts folded, and can paint unfolded for a moment before that default applies (it
  // appears only once the token list is back): wait for it to settle folded, then open it.
  const unfold = async (page) => {
    await card(page).locator('button.panel-toggle[aria-expanded="false"]').waitFor();
    await card(page).locator("button.panel-toggle").click();
    await card(page).locator('button.panel-toggle[aria-expanded="true"]').waitFor();
  };

  // With it: the card, its Create token, and the account menu's way there.
  await withPage({ grants: [VIEW, TOKENS] }, async (page, { errors }) => {
    await page.click(".settings-trigger");
    assert.equal(await page.locator(".sm-item", { hasText: "API tokens" }).count(), 1, "the menu offers the way there");
    await page.keyboard.press("Escape");
    await open(page);
    await unfold(page);
    assert.equal(await card(page).getByRole("button", { name: "Create token" }).count(), 1);
    assert.deepEqual(errors, []);
  });

  // Without it and with none made: nothing to see.
  await withPage({ grants: [VIEW] }, async (page, { errors }) => {
    await open(page);
    assert.equal(await card(page).count(), 0, "no card when there is nothing to make and nothing to revoke");
    await page.click(".settings-trigger");
    await page.locator(".sm-item", { hasText: "Edit layout" }).waitFor();
    assert.equal(await page.locator(".sm-item", { hasText: "API tokens" }).count(), 0, "and the menu doesn't point at it");
    assert.deepEqual(errors, []);
  });

  // Without it, with one made before: listed, said why it doesn't work, and it can still go.
  const made = { tokens: [{ id: "t1", name: "old-bot", createdAt: "2026-10-01T12:00:00.000Z", expiresAt: null }] };
  await withPage({ grants: [VIEW], overrides: { "/api/tokens": { body: made } } }, async (page, { stub, errors }) => {
    await open(page);
    await unfold(page);
    const body = card(page);
    await body.locator("td", { hasText: "old-bot" }).waitFor();
    assert.match(await body.innerText(), /You no longer have the API tokens permission, so these tokens don't work\. You can still revoke them\./);
    assert.equal(await body.getByRole("button", { name: "Create token" }).count(), 0, "nothing to make");
    await body.getByRole("button", { name: "Revoke" }).click();
    const ask = page.locator(".confirm-modal", { hasText: 'Revoke token "old-bot"?' });
    await ask.getByRole("button", { name: "Remove" }).click();
    await ask.waitFor({ state: "detached" });
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.path === "/api/tokens/t1"), "revoking takes no permission");
    assert.deepEqual(errors, []);
  });
});

/*
 * A saved button for a plugin's screen that is not running right now was left out of Settings'
 * list, so the next change saved the list without it, and after any update it was gone for good.
 * It stays listed, said so, and off the bar. A screen the account may not open still drops out.
 */
test("a quick bar button for a plugin's screen that is not running stays on your list, said so", { skip: SKIP }, async () => {
  const viewer = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  const me = { body: { user: { id: "u2", username: "viewer", displayName: "viewer" }, limits: {}, roles: [], grants: viewer,
    prefs: { phoneBarItems: ["players.leaderboard", "moderation.bans", "demo-page", "live"] } } };
  await withPage({ grants: viewer, viewport: { width: 390, height: 844 }, overrides: { "/api/me": me } }, async (page, { stub, errors }) => {
    const bar = page.locator(".quick-bar");
    await page.waitForFunction(() => window.document.querySelectorAll(".quick-bar .quick-btn").length === 3, null, { timeout: 10_000 });
    assert.deepEqual(await bar.locator(".quick-btn").allTextContents(), ["Leaderboard", "Live", "☰More"], "the bar holds what opens");
    await page.goto(`${page.url().split("#")[0]}#/settings`, { waitUntil: "networkidle" });
    const card = page.locator(".setting-card", { hasText: "Quick bar buttons" });
    await card.locator(".field-label").first().waitFor({ timeout: 10_000 });
    assert.deepEqual((await card.locator(".field-label").allTextContents()).map((t) => t.trim()),
      ["Players › Leaderboard", "A screen (not available right now)", "Live"], "Bans is not this account's to open");
    await card.getByRole("button", { name: "Move Live earlier" }).tap();
    await page.waitForFunction(() => window.document.querySelectorAll(".quick-pick .field-label")[1]?.textContent === "Live");
    const saved = stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/me/prefs" && c.body?.phoneBarItems).map((c) => c.body.phoneBarItems);
    assert.deepEqual(saved.at(-1), ["players.leaderboard", "live", "demo-page"], "the plugin's button is kept");
    assert.deepEqual(await bar.locator(".quick-btn").allTextContents(), ["Leaderboard", "Live", "☰More"]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("on a small phone each of the quick bar's buttons keeps its row in Settings", { skip: SKIP }, async () => {
  // At 360px, "Moderation › Bans" with its three small buttons is wider than the card: the ✕ fell to
  // a line of its own, under the name, looking like the next row's.
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    const card = page.locator(".setting-card", { hasText: "Quick bar buttons" });
    await card.locator(".field-label").first().waitFor({ timeout: 10_000 });
    // And the longest name there is, in place of Live.
    await card.getByRole("button", { name: "Take Live off the bar" }).tap();
    const add = card.getByLabel("Add a button to the quick bar");
    const names = (await add.locator("option").allTextContents()).slice(1);
    const longest = names.reduce((a, b) => (b.length > a.length ? b : a));
    await add.selectOption({ label: longest });
    await card.locator(".quick-pick", { hasText: longest }).waitFor();
    const rows = await card.locator(".quick-pick").evaluateAll((els) => els.map((row) => {
      const boxes = [...row.children].map((el) => el.getBoundingClientRect());
      return { name: row.querySelector(".field-label").textContent, oneLine: Math.max(...boxes.map((b) => b.top)) < Math.min(...boxes.map((b) => b.bottom)) };
    }));
    assert.equal(rows.length, 4);
    for (const r of rows) assert.ok(r.oneLine, `"${r.name}" and its buttons share one line`);
    const wide = await page.evaluate(() => window.document.documentElement.scrollWidth - window.document.documentElement.clientWidth);
    assert.ok(wide <= 1, `nothing runs past the edge: ${wide}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The public Discord server, the approvals relay and the community badges are read from the
 * app-wide settings. A read that failed was shown as "nothing set" — and each saves what it shows:
 * a badge added to "none yet" replaced every badge, and a relay channel typed into the blank form
 * cleared the mention role beside it. Now a failed read is said, and there is nothing to save.
 */
test("Discord setup: a panel whose saved settings could not be read says so and offers nothing to save", { skip: SKIP }, async () => {
  const failed = { status: 500, body: { error: { code: "internal", message: "The settings could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/app-config": failed } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/discord/setup`, { waitUntil: "networkidle" });
    for (const [title, what] of [["Public Discord server", "server"], ["Approvals relay", "relay"], ["Community badges", "badges"]]) {
      const panel = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: title }) });
      await panel.getByText(`Couldn't read the saved ${what}`).waitFor({ timeout: 10_000 });
      assert.equal(await panel.locator("button", { hasText: /Save|Add badge/ }).count(), 0, `${title}: nothing to save over what it could not read`);
      assert.equal(await panel.locator("input").count(), 0, `${title}: no form`);
    }
    assert.ok(!stub.calls.some((c) => c.method === "PUT" && c.path === "/api/app-config"), "nothing was saved");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Why a player is watched, by whom and since when are the watchlist permission's: the API sends
 * nobody else them. The profile still told such a reader "no reason recorded", which is news it
 * doesn't have, and the directory's Watchlist tab gave them three columns of dashes.
 */
test("without the watchlist permission a watch is the mark alone: no \"no reason recorded\", no empty reason columns", { skip: SKIP }, async () => {
  const viewer = [{ capability: "server.view", scopeType: "global", scopeId: null, level: "read" }];
  const flags = { watchlist: true, vip: false, watchReason: null, watchBy: null, watchAt: null, updatedByName: null, updatedAt: null };
  const profile = (canViewWatch) => ({ body: {
    player: { id: "p1", platformId: "76561198000000001", platform: "steam", name: "Watched Guy", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
    stats: { kills: 1, deaths: 1, teamkills: 0, playtimeSec: 60, visits: 1 },
    flags, canViewWatch, recentEvents: [], sessions: [], aliases: [], matches: [], canViewNotes: false, notes: [],
  } });
  const flagged = { body: { flags: [{ playerId: "p1", name: "Watched Guy", online: false, onlineServers: [], reasons: [], ...flags }] } };
  for (const [who, grants, sees] of [["a viewer", viewer, false], ["the owner", OWNER_GRANTS, true]]) {
    await withPage({ grants, overrides: { "/api/players/p1": profile(sees), "/api/players/flagged": flagged } }, async (page, { errors }) => {
      const base = page.url().split("#")[0];
      await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
      await page.getByText("Watchlisted", { exact: true }).waitFor({ timeout: 10_000 });
      // The owner reads reasons, so a watch kept without one says so; a viewer is told nothing.
      assert.equal(await page.getByText("no reason recorded").count(), sees ? 1 : 0, `${who}: "no reason recorded"`);
      await page.goto(`${base}#/players/directory`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Watchlist", exact: true }).click();
      await page.locator("table", { hasText: "Watched Guy" }).waitFor({ timeout: 10_000 });
      const heads = (await page.locator("table th").allTextContents()).map((h) => h.trim());
      assert.equal(heads.includes("Reason"), sees, `${who}: the Reason column (${heads.join(", ")})`);
      assert.equal(heads.includes("Watchlisted by"), sees, `${who}: the Watchlisted by column`);
      assert.deepEqual(errors, [], "no uncaught page errors");
    });
  }
});

/*
 * The directory follows the server pinned in the sidebar. On a server nobody has played on yet it
 * said "No players tracked yet", and to run the import, over everyone the other servers hold.
 */
test("the player directory on a server nobody has played on names that server, and shows everyone a tap away", { skip: SKIP }, async () => {
  const player = { id: "p1", name: "Caereca", platform: "steam", platformId: "76561198000000001", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-10-20T00:00:00.000Z", kills: 3, teamkills: 0, visits: 2, playtimeSec: 3600 };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers": { body: { servers: [{ id: "s1", name: "One", game: "hll", engagementMode: "active" }, { id: "s2", name: "Two", game: "hll", engagementMode: "active" }] } },
    "/api/players": (url) => ({ body: url.searchParams.get("serverId") ? { players: [], total: 0 } : { players: [player], total: 1 } }),
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/directory`, { waitUntil: "networkidle" });
    await page.getByText("No players on One yet").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No players tracked yet").count(), 0, "the community is not empty");
    await page.getByRole("button", { name: "Show every server" }).click();
    await page.locator("table.scoreboard", { hasText: "Caereca" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/**
 * The By platform card as a pick-a-metric chart. One grouped picker carries every metric the
 * split has (population, rounds and kills, the game's score, bans and VIP); the chart draws the
 * picked one per platform as a RUNNING TOTAL across the window, so every line ends at its number
 * in the table, and the table beside it shows the picked metric's group. People (players, VIPs)
 * are added on their first day, a ratio is everything so far divided, and codes the game reports
 * separately but that are one platform to a reader (PS4 and PS5) are one row and one line.
 */
/*
 * When people play draws the same players-online numbers two ways: the date × hour heatmap, or a
 * line through every hour of the window. The line is the grid's own figures — an hour with no
 * square breaks it rather than reading as 0, and the hours outside the window are not drawn.
 */
test("server analytics: When people play switches between the heatmap and a line graph of the same counts", { skip: SKIP }, async () => {
  const at = (hours) => Array.from({ length: 24 }, (_, h) => (h in hours ? hours[h] : null));
  const body = {
    window: { from: "2026-10-01T20:00:00.000Z", to: "2026-10-02T04:00:00.000Z" },
    concurrency: {
      peak: 31, peakAt: null, average: 10, weekHour: [], sampleSec: 300, openAtEnd: 0, daily: [],
      // The window opens at 20:00 on the 1st and closes at 04:00 on the 2nd; 01:00 has no record.
      dayHour: [
        { date: "2026-10-01", hours: at({ 20: 12, 21: 30.5, 22: 18, 23: 0 }) },
        { date: "2026-10-02", hours: at({ 0: 5, 2: 7, 3: 4 }) },
      ],
    },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/analytics/server": { body } } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/analytics/server`, { waitUntil: "networkidle" });
    const card = page.locator(".panel", { hasText: "When people play" }).first();
    const sw = card.locator('[role="group"][aria-label="Chart type"]');
    await sw.waitFor({ timeout: 10_000 });
    assert.equal(await sw.locator('button[aria-pressed="true"]').innerText(), "Heatmap", "the heatmap is the default");
    assert.equal(await card.locator("rect.hm-cell").count(), 7, "a square for each hour with a figure");

    await sw.getByRole("button", { name: "Line graph" }).click();
    const chart = card.locator("svg.viz-chart");
    await chart.waitFor({ timeout: 5_000 });
    assert.equal(await card.locator("rect.hm-cell").count(), 0, "the heatmap gives way to the line");
    assert.equal(await chart.locator("polyline").count(), 2, "the hour with no record breaks the line instead of dropping to 0");
    const ticks = await chart.locator("text.tick").allTextContents();
    assert.ok(ticks.includes("Oct 1 20:00"), `the line starts where the window opens: ${JSON.stringify(ticks)}`);
    assert.ok(ticks.includes("Oct 2 03:00"), "and ends at its last hour");
    assert.ok(!ticks.includes("Oct 1 00:00"), "the hours before the window are not drawn");
    // A label as long as "Oct 2 03:00" must still fit at the right-hand end of the chart.
    const lastTick = await chart.locator("text.tick", { hasText: "Oct 2 03:00" }).boundingBox();
    const frame = await chart.boundingBox();
    assert.ok(lastTick.x + lastTick.width <= frame.x + frame.width + 0.5, "the last label fits inside the chart");
    // The first point is the first square's own figure.
    const box = await chart.boundingBox();
    await chart.hover({ position: { x: 2, y: box.height / 2 }, force: true });
    await card.locator(".viz-tip").waitFor({ timeout: 5_000 });
    const tip = (await card.locator(".viz-tip").innerText()).replace(/\s+/g, " ");
    assert.match(tip, /Oct 1 20:00/);
    assert.match(tip, /players online 12/);

    await sw.getByRole("button", { name: "Heatmap" }).click();
    await card.locator("rect.hm-cell").first().waitFor({ timeout: 5_000 });
    assert.equal(await card.locator("rect.hm-cell").count(), 7);
    assert.ok(!stub.requests.includes("/api/analytics/server/hours"), "the same numbers, so nothing extra is fetched");
    assert.deepEqual(errors, []);
  });
});

test("server analytics: By platform charts any picked metric as a running total per platform, ending at the table", { skip: SKIP }, async () => {
  const sums = (o) => ({ players: 0, newPlayers: 0, sessions: 0, shortSessions: 0, playtimeSec: 0, rounds: 0, kills: 0, deaths: 0, teamkills: 0, vehicleKills: 0, scoredRounds: 0, combat: 0, offense: 0, defense: 0, support: 0, slSeconds: 0, tempBans: 0, permaBans: 0, vips: 0, ...o });
  const day = (date, platform, o) => ({ date, platform, firstPlayers: 0, firstNewPlayers: 0, firstVips: 0, ...sums(o) });
  const XBOX = "EPlatformFamily::XboxSeries", PS5 = "EPlatformFamily::PS5";
  const body = {
    window: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-04T00:00:00.000Z" },
    platform: { rows: [
      // Xbox: 60 rounds, of which 40 carry the game's score (20 came in from a kill log, with none).
      { platform: XBOX, ...sums({ players: 40, sessions: 50, shortSessions: 5, playtimeSec: 180_000, rounds: 60, kills: 600, deaths: 300, scoredRounds: 40, combat: 4_000, tempBans: 3, permaBans: 1, vips: 12 }) },
      { platform: "steam", ...sums({ players: 20, sessions: 20, playtimeSec: 72_000, rounds: 30, kills: 150, deaths: 150, scoredRounds: 30, combat: 4_500, tempBans: 1, vips: 4 }) },
      // One platform under two codes.
      { platform: PS5, ...sums({ players: 6, sessions: 6, rounds: 10, kills: 40, deaths: 20, scoredRounds: 10, tempBans: 2, permaBans: 1, vips: 2 }) },
      { platform: "ps4", ...sums({ players: 2, sessions: 2, rounds: 4, kills: 8, deaths: 8, scoredRounds: 4, permaBans: 2, vips: 1 }) },
      // A code the page has no name for: its own table row, and one neutral line for leftovers.
      { platform: "EPlatformFamily::Switch", ...sums({ players: 1, sessions: 1, tempBans: 1 }) },
    ] },
    platformTrend: { rows: [
      day("2026-06-01", XBOX, { players: 30, firstPlayers: 30, rounds: 30, kills: 300, deaths: 150, tempBans: 2, vips: 10, firstVips: 10 }),
      day("2026-06-01", "steam", { players: 15, firstPlayers: 15, vips: 3, firstVips: 3 }),
      day("2026-06-01", PS5, { players: 4, firstPlayers: 4, rounds: 5, kills: 20, deaths: 10, tempBans: 1, vips: 2, firstVips: 2 }),
      // A day's players and VIPs include people already counted: the running count adds only the new faces.
      day("2026-06-02", XBOX, { players: 25, firstPlayers: 10, rounds: 30, kills: 300, deaths: 150, tempBans: 1, permaBans: 1, vips: 11, firstVips: 2 }),
      day("2026-06-02", "steam", { players: 12, firstPlayers: 5, rounds: 30, kills: 150, deaths: 150, tempBans: 1, vips: 4, firstVips: 1 }),
      day("2026-06-02", "ps4", { players: 2, firstPlayers: 2, rounds: 4, kills: 8, deaths: 8, permaBans: 2, vips: 1, firstVips: 1 }),
      day("2026-06-02", PS5, { players: 3, firstPlayers: 2, rounds: 5, kills: 20, deaths: 10, tempBans: 1, permaBans: 1 }),
      day("2026-06-02", "EPlatformFamily::Switch", { players: 1, firstPlayers: 1, tempBans: 1 }),
      // The 3rd was quiet: no row at all, and the totals carry across it.
    ] },
    vipDaily: [{ date: "2026-06-01", vips: 15 }, { date: "2026-06-02", vips: 16 }, { date: "2026-06-03", vips: 14 }],
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/analytics/server": { body } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/analytics/server`, { waitUntil: "networkidle" });
    const card = page.locator(".panel", { hasText: "By platform" }).first();
    const picker = card.locator('select[aria-label="Metric to compare by platform"]');
    await picker.waitFor({ timeout: 10_000 });

    const groups = await picker.locator("optgroup").evaluateAll((gs) => gs.map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]));
    assert.deepEqual(groups.map(([g]) => g), ["Population", "Rounds and kills", "Score", "Moderation and VIP"]);
    assert.deepEqual(groups[3][1], ["Temp bans", "Perma bans", "VIPs"], "bans and VIPs are pickable");
    assert.ok(groups.flatMap(([, o]) => o).length >= 20, "and so is most of what the page measures");

    const heads = async () => (await card.locator("thead th").allTextContents()).map((t) => t.trim());
    const rowOf = async (name) => (await card.locator("tbody tr", { hasText: name }).first().locator("td").allTextContents()).map((t) => t.trim());
    // The chart's own readout for one day: hover the first or last day and read the tooltip.
    const dayReadout = async (which) => {
      const svg = card.locator("svg.viz-chart");
      await svg.scrollIntoViewIfNeeded();
      const box = await svg.boundingBox();
      // hover() scrolls the chart into view, which the page's own mouse would not.
      await svg.hover({ position: { x: which === "first" ? 2 : box.width - 2, y: box.height / 2 }, force: true });
      await card.locator(".viz-tip").waitFor({ timeout: 5_000 });
      return (await card.locator(".viz-tip .tt-row").allTextContents()).map((t) => t.trim());
    };

    await picker.selectOption("tempBans");
    assert.deepEqual(await heads(), ["Platform", "Temp bans", "Perma bans", "VIPs"], "the table shows the picked metric's group");
    assert.deepEqual(await rowOf("Xbox"), ["Xbox", "3", "1", "12"]);
    assert.deepEqual(await rowOf("Steam"), ["Steam (PC)", "1", "0", "4"]);
    assert.deepEqual(await rowOf("PlayStation"), ["PlayStation", "2", "3", "3"], "PS5 and PS4 added together");
    assert.equal(await card.locator("tbody tr", { hasText: "PlayStation" }).count(), 1, "one PlayStation row, not one per code");
    assert.deepEqual(await rowOf("Switch"), ["EPlatformFamily::Switch", "1", "0", "0"]);
    assert.deepEqual(await dayReadout("first"), ["Xbox2", "Steam (PC)0", "PlayStation1", "Other platforms0"], "one line per platform");
    assert.deepEqual(await dayReadout("last"), ["Xbox3", "Steam (PC)1", "PlayStation2", "Other platforms1"], "the total so far: each line ends at its number in the table");
    // Colour follows the platform, not its place in the table: PlayStation ranks third here and
    // still wears its own colour, and the leftovers are neutral, not a hue.
    const swatches = await card.locator(".viz-legend .li").evaluateAll((els) => els.map((e) => [e.textContent.trim(), e.querySelector(".sw").style.background]));
    assert.deepEqual(swatches, [["Xbox", "var(--series-1)"], ["Steam (PC)", "var(--series-3)"], ["PlayStation", "var(--series-2)"], ["Other platforms", "var(--muted)"]]);
    assert.match(await card.textContent(), /Each day shows the total so far in this window, so every line ends at its number in the table\./);

    // People are added on their first day: the lines end at the table's players, not at the
    // days' players added up (which would count a regular once a day).
    await picker.selectOption("players");
    assert.deepEqual(await dayReadout("first"), ["Xbox30", "Steam (PC)15", "PlayStation4", "Other platforms0"]);
    assert.deepEqual(await dayReadout("last"), ["Xbox40", "Steam (PC)20", "PlayStation8", "Other platforms1"]);

    await picker.selectOption("vips");
    assert.deepEqual(await heads(), ["Platform", "VIPs", "Temp bans", "Perma bans"]);
    assert.deepEqual(await rowOf("Xbox"), ["Xbox", "12", "3", "1"], "held at some point in the window");
    assert.deepEqual(await dayReadout("first"), ["Xbox10", "Steam (PC)3", "PlayStation2", "Other platforms0"]);
    assert.deepEqual(await dayReadout("last"), ["Xbox12", "Steam (PC)4", "PlayStation3", "Other platforms0"]);
    assert.equal(await card.locator(".split-legend").count(), 0, "not a snapshot any more");
    assert.match(await card.textContent(), /Grants under an hour, like a crash VIP, are left out/);

    // Every platform together, per day, in the Daily trend panel: its own scale, its own chart.
    const trend = page.locator(".panel", { hasText: "Daily trend" }).first();
    const vipBars = trend.locator("h4.an-h", { hasText: "VIPs per day" }).locator("xpath=following-sibling::div[contains(@class, 'viz-wrap')][1]");
    assert.match(await vipBars.locator("svg title").textContent(), /3 buckets, highest 16/);
    await vipBars.scrollIntoViewIfNeeded();
    await vipBars.locator("svg rect[fill='transparent']").first().hover({ force: true });
    assert.equal((await vipBars.locator(".viz-tip").textContent()).replace(/\s+/g, " ").trim(), "06-01 · 15 · 2026-06-01");

    await card.locator("thead th", { hasText: "Perma bans" }).click();
    assert.equal(await picker.inputValue(), "permaBans", "a column heading picks too");
    assert.equal(await card.locator("svg.viz-chart").count(), 1);

    // A ratio: everything so far divided, so it ends at the table's ratio; a gap until there is
    // anything to divide.
    await picker.selectOption("kd");
    assert.deepEqual(await heads(), ["Platform", "K/D", "Rounds", "Kills", "Deaths", "Kills / round", "Team kills", "Vehicle kills"],
      "the picked column first: on a phone the table scrolls, and it is the one in view");
    assert.deepEqual([(await rowOf("Xbox"))[1], (await rowOf("Xbox"))[5], (await rowOf("PlayStation"))[1]], ["2.00", "10.0", "1.71"]);
    assert.deepEqual(await dayReadout("first"), ["Xbox2.00", "Steam (PC)—", "PlayStation2.00", "Other platforms—"], "Steam had played no round yet: a gap, not a zero");
    assert.deepEqual(await dayReadout("last"), ["Xbox2.00", "Steam (PC)1.00", "PlayStation1.71", "Other platforms—"]);
    assert.match(await card.textContent(), /Each day shows the K\/D of everything so far in this window/);
    assert.match(await card.textContent(), /A line that starts late means/, "and the gap is explained, behind its fold");

    // The game's score, per player per round it was recorded for: the kill-log rounds would
    // otherwise read as Xbox scoring a third less.
    await picker.selectOption("combat");
    assert.deepEqual((await rowOf("Xbox"))[1], "100");
    assert.deepEqual((await rowOf("Steam"))[1], "150");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the two panels on the relay tab are built to one schema, not two", { skip: SKIP }, async () => {
  // The nudge landed on the relay's tab in the right place but wearing a different visual
  // vocabulary — its Save sat in the body while the relay's sat in the panel header, its switch was
  // a bare checkbox, its fields were loose on the panel instead of inside the card that turns them
  // on. Two panels making the same kind of decision, side by side, asking for it two different
  // ways. This pins the shape they now share so the next edit to one has to keep the other in mind.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/community/announcements/nudge-config": { body: { config: { enabled: true, channelId: "444", afterHours: 48 } } },
      "/api/servers/s1/discord": { body: {
        categories: ["kills", "chat", "admin", "connections", "match"],
        botConfigured: true,
        config: {
          serverId: "s1", enabled: true, categories: ["kills"], channels: { kills: "111" }, categoryOptions: {},
          alerts: {
            adminPing: { enabled: true, trigger: "!admin", channelId: "333", mentionRoleId: "" },
            watchlist: { enabled: false, channelId: "", mentionRoleId: "" },
            automation: { enabled: false, channelId: "", mentionRoleId: "" },
          },
          updatedAt: new Date().toISOString(),
        },
      } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/discord/relay`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.document.body.innerText.includes("Unread-notice nudge"), null, { timeout: 10_000 });

    const relay = page.locator(".panel", { hasText: "Relay & alerts" }).first();
    const nudge = page.locator(".panel", { hasText: "Unread-notice nudge" }).first();
    // Each panel shows its title and Save at once and its settings only when they arrive: read the
    // shape once both are in, or a relay still loading reads as one with no switches at all.
    await relay.getByText("Kills", { exact: true }).waitFor({ timeout: 10_000 });
    await nudge.locator("input[inputmode='numeric']").first().waitFor({ timeout: 10_000 });

    for (const [name, panel] of [["relay", relay], ["nudge", nudge]]) {
      // Save lives in the panel header on both, and appears exactly once — the relay used to carry
      // a second one at the foot of the body, left behind when the header action was introduced.
      assert.equal(await panel.locator(".panel-actions button", { hasText: /^Save/ }).count(), 1,
        `${name} has one Save, in the panel header`);
      assert.equal(await panel.locator(".setting-body button", { hasText: /^Save/ }).count(), 0,
        `${name} has no second Save buried in the body`);
      // Switches are the shared Toggle, and every field the panel owns sits inside the card that
      // enables it rather than loose underneath.
      assert.ok(await panel.locator(".toggle").count() > 0, `${name} uses the shared Toggle`);
      // Both halves of this matter. The second proves the first isn't vacuous: the same
      // `> .panel-body >` path that finds nothing loose does find the cards, so a field moved back
      // out of one would be counted rather than silently missed by a selector that matches nothing.
      const loose = await panel.locator(":scope > .panel-body > .grid input, :scope > .panel-body > label input").count();
      assert.equal(loose, 0, `${name} keeps its inputs inside a setting card`);
      assert.ok(await panel.locator(":scope > .panel-body > .setting-card input").count() > 0,
        `${name}'s fields are reachable at that depth — the loose check above is looking somewhere real`);
    }

    // Dirty the nudge and confirm Discard appears next to Save, the way it does on the relay.
    await nudge.locator("input[inputmode='numeric']").fill("999");
    await page.waitForFunction(
      () => Boolean(window.document.querySelector(".panel-actions button.ghost")),
      null,
      { timeout: 5_000 },
    );
    const discard = await nudge.locator(".panel-actions button.ghost").innerText();
    assert.equal(discard.trim(), "Discard", "an edited nudge offers Discard beside Save, as the relay does");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the map vote setup screen is settings only — the wizard and its numbering are gone", { skip: SKIP }, async () => {
  // The nine numbered steps mixed configuration with live actions, a preview, and a link to another
  // page, and skipped step 4 whenever it didn't apply. Setup is now just settings.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/servers/s1/mapvote/config": mapvoteFixture({ activePoll: true }) },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/votesetup`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /where players vote/i.test(window.document.body.innerText), null, { timeout: 10_000 });

    // The voting surface is a choice now: the Discord poll, or in-game chat-number voting — the
    // CRCON votemap shape, the one console players can always reach.
    const surfaceSel = page.locator("label", { hasText: "Voting surface" }).locator("select");
    assert.equal(await surfaceSel.count(), 1, "the surface select is on the setup screen");
    assert.ok((await surfaceSel.innerText()).includes("In game"), "in-game voting is offered");
    assert.ok((await surfaceSel.innerText()).includes("Both"), "and running the two together, ballots combined");
    // Duplicate protection is one switch per RUNNING surface. A gate whose surface is off does
    // nothing at all in the worker, so offering it here told staff they had protected a vote they
    // had not. The fixture is a Discord-only vote: only the Discord gate may be on screen.
    const ingameGate = page.locator("label.toggle", { hasText: "In-game votes: only registered players count" });
    const discordGate = page.locator("label.toggle", { hasText: "Discord votes: only registered accounts count" });
    assert.equal(await discordGate.count(), 1, "the Discord gate is offered on a Discord-only vote");
    assert.equal(await ingameGate.count(), 0, "the in-game gate is NOT — there is no in-game half for it to gate");

    await surfaceSel.selectOption("both");
    await page.waitForFunction(() => /In-game votes: only registered/i.test(window.document.body.innerText), null, { timeout: 5_000 });
    assert.equal(await ingameGate.count(), 1, "running both surfaces, both gates apply");
    assert.equal(await discordGate.count(), 1, "and they are independent of each other");

    await surfaceSel.selectOption("ingame");
    await page.waitForFunction(() => !/Discord votes: only registered/i.test(window.document.body.innerText), null, { timeout: 5_000 });
    assert.equal(await ingameGate.count(), 1, "an in-game-only vote keeps its own gate");
    assert.equal(await discordGate.count(), 0, "and drops the Discord one with the poll");
    await surfaceSel.selectOption("native");

    const panel = page.locator(".panel", { hasText: "Vote setup" }).first();
    assert.equal(await panel.locator(".step-n").count(), 0, "no numbered steps remain");
    // Save is in the panel header, once — the same shape as every other settings panel.
    assert.equal(await panel.locator(".panel-actions button", { hasText: /^Save/ }).count(), 1, "one Save, in the header");

    // The live controls belong to the Vote tab now and must not have crept back in here. Matched on
    // button labels, not page text: "Pause voting while fewer than N players are on" is a genuine
    // setting that lives here, and is not the Pause button.
    const labels = await panel.locator("button").allInnerTexts();
    const trimmed = labels.map((l) => l.trim());
    for (const gone of ["Start vote", "Pause", "Resume", "Skip vote", "New options", "Force next map"]) {
      assert.ok(!trimmed.includes(gone), `"${gone}" is not a button here — it lives on Vote, got ${JSON.stringify(trimmed)}`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});


test("a round shows the objectives staff set — and stays silent when nobody set any", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];

    // The round staff picked objectives for. This is the ONLY record of them: the game has no
    // reader for the layout in play, so if the panel doesn't show what we sent, nothing does.
    await page.goto(`${base}#/match/~m1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".sector-layout", { timeout: 15000 });
    const chips = await page.locator(".sector-layout-row li").allInnerTexts();
    assert.equal(chips.length, 5, `five sectors, got ${JSON.stringify(chips)}`);
    assert.ok(chips[0].includes("Road To Luxembourg"), `first sector named, got ${chips[0]}`);
    assert.ok(chips[2].includes("Foy"), `third sector named, got ${chips[2]}`);
    // Attribution matters: this is a staff action on the record, not a game reading.
    assert.match(await page.locator(".sector-layout").innerText(), /set by tester/i);

    // The round nobody touched shows nothing at all — no empty slots, no "unknown" placeholders.
    // A blank five-slot grid would read as missing data; absence is the honest rendering.
    await page.goto(`${base}#/match/~m2`, { waitUntil: "networkidle" });
    await page.waitForSelector(".match-art, .statgrid", { timeout: 15000 });
    assert.equal(await page.locator(".sector-layout").count(), 0, "no layout block on an untouched round");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a player profile shows the round performance the sampler recorded, not just kills", { skip: SKIP }, async () => {
  const profile = (stats) => ({ body: {
    player: { id: "p2", platform: "steam", platformId: "76561198000000002", name: "Anchor", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-07-01T00:00:00.000Z" },
    stats, flags: { watchlist: false, vip: false, updatedByName: null }, recentEvents: [], canViewNotes: false,
  } });
  const full = {
    kills: 120, deaths: 200, teamkills: 0, visits: 40, playtimeSec: 54000,
    combat: 90, offense: 60, defense: 980, support: 300,
    vehicleKills: 12, vehiclesDestroyed: 3,
    // Keyed by the game's raw role numbers — the descriptor names them, so no per-game table here.
    roleSeconds: { "0": 3600, "9": 18000, "11": 900 },
    slSeconds: 18000, highestLevel: 214, matchesPlayed: 40, matchesWon: 26,
  };

  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/players/p2": profile(full),
      // Role numbers are named by the game descriptor, so the panel never carries a per-game table.
      "/api/games/hll/descriptor": { body: { descriptor: { id: "hll", label: "HLL", roles: { 0: "Rifleman", 9: "Support", 11: "Squad Leader" }, sides: [], scoreFields: [], squadLeaderRoles: [11], configFields: [] } } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~p2`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Round performance/i.test(window.document.body.innerText), null, { timeout: 15_000 });

    const body = await page.locator("body").innerText();
    // The four score buckets, the squad-leader time as a duration, and the win rate.
    assert.match(body, /Defense/i);
    assert.match(body, /980/, "the defense score must be shown");
    assert.match(body, /Support/i);
    assert.match(body, /5h/, "squad-leader time reads as a duration, not 18000");
    assert.match(body, /65% won/, "40 rounds with 26 wins is a 65% win rate");
    assert.match(body, /214/, "the level the game reported");
    // Roles are named by the descriptor, never by a hardcoded table in the panel.
    assert.match(body, /Squad Leader/, "role numbers must be resolved to the game's own names");
    assert.match(body, /Rifleman/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // A player the sampler never saw gets NO panel — a grid of zeroes reads as broken, absence reads
  // as "nothing recorded", which is the truth.
  await withPage({
    grants: OWNER_GRANTS,
    overrides: { "/api/players/p2": profile({ kills: 5, deaths: 5, teamkills: 0 }) },
  }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~p2`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Overview/i.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /Round performance/i, "no panel when there is nothing to show");
  });
});

test("a profile opened by the player's game id reads every box by the profile's own id", { skip: SKIP }, async () => {
  /*
   * Field report: the same Vietnam player's VIP history showed five entries one way and three the
   * other. The VIP list, the integrity scan and the scoreboards open a profile by the player's GAME
   * id; the profile read resolves either, but the boxes under it passed the address's id along as
   * given. The VIP history then found the grants (filed under the game id) and lost the rule VIP
   * rows (filed under the profile id); the IP box, answered "player not found", vanished; a note or
   * a flag went nowhere.
   */
  const gameId = "00020b3e56644de69f9e5416431bc7c1"; // a Vietnam (EOS) id — 32 hex characters
  const profileId = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const row = (id, action, by, comment) => ({ id, ts: "2026-10-01T13:37:19.000Z", action, by, byUserId: null, serverId: "s1", serverName: "VIETNAM", expiration: "2026-10-01T13:47:19.000Z", comment });
  const filedUnderGameId = [row("g1", "granted", "KREITZ", "time added back"), row("g2", "granted", "KREITZ", "time added back"), row("x1", "expired", "system", "grant reached its expiration")];
  const filedUnderProfileId = [row("r1", "rule VIP", "enforcer", "crash VIP"), row("r2", "rule VIP", "enforcer", "crash VIP")];
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      [`/api/players/${gameId}`]: { body: {
        player: { id: profileId, platform: "epic", platformId: gameId, name: "Dads_soup", firstSeen: "2026-09-01T00:00:00.000Z", lastSeen: "2026-10-01T13:40:00.000Z" },
        stats: null, flags: { watchlist: false, vip: false, updatedByName: null }, recentEvents: [], canViewNotes: true, notes: [],
      } },
      // What the API answers for each id: handed the game id, it finds only the rows filed under it.
      [`/api/players/${profileId}/vip-history`]: { body: { history: [...filedUnderGameId, ...filedUnderProfileId] } },
      [`/api/players/${gameId}/vip-history`]: { body: { history: filedUnderGameId } },
      [`/api/players/${profileId}/ips`]: { body: { ips: [] } },
      [`/api/players/${gameId}/ips`]: { status: 404, body: { error: "player not found" } },
    },
  }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~${gameId}`, { waitUntil: "networkidle" });
    const vipToggle = page.locator("button.panel-toggle", { hasText: "VIP history" });
    await vipToggle.waitFor({ timeout: 15_000 });
    await vipToggle.click();
    const vipRows = page.locator(".panel").filter({ has: vipToggle }).locator("tbody tr");
    await page.waitForFunction(() => /rule VIP/.test(window.document.body.innerText), null, { timeout: 15_000 }).catch(() => {});
    assert.equal(await vipRows.count(), 5, "the grants, the expiry AND the two rule VIPs");
    assert.equal(await page.locator("button.panel-toggle .panel-title").filter({ hasText: /^IP history$/ }).count(), 1, "the IP box is there, not answered \"player not found\"");

    await page.fill('input[placeholder="Add a note…"]', "checked their VIP");
    await page.press('input[placeholder="Add a note…"]', "Enter");
    await page.waitForFunction(() => window.document.querySelector('input[placeholder="Add a note…"]')?.value === "", null, { timeout: 15_000 }).catch(() => {});
    assert.ok(stub.calls.some((c) => c.method === "POST" && c.path === `/api/players/${profileId}/notes`), "the note is filed on the profile");

    // Only the profile read itself and the activity feed (which accepts either id) may use the game id.
    const byGameId = [...new Set(stub.requests.filter((p) => p.startsWith(`/api/players/${gameId}`)))];
    assert.deepEqual(byGameId.filter((p) => p !== `/api/players/${gameId}` && p !== `/api/players/${gameId}/events`), [], "no box reads by the game id");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("VIP integrity on a phone: two receipts, the rest behind Show all, panel dates, rows read from the top", { skip: SKIP }, async () => {
  /*
   * Field report, with screenshots: one lost grant filled several screens. The evidence printed
   * every receipt — and a lost grant gathers every seed reward and sweep the player has had since —
   * in a narrow column of raw ISO stamps, with the name and buttons centred far down the row.
   */
  const evidence = [
    "2026-09-10T22:28:11.921Z — seed reward wrote an expiration of 2026-09-13T22:28:09.533Z over the grant",
    "2026-09-13T22:28:23.624Z — vip-sync removed the game's VIP entry (the row read as expired)",
    "2026-09-13T22:29:25.558Z — the expiry sweep removed the grant (its stored date had passed)",
    "2026-09-13T23:16:46.867Z — seed reward wrote an expiration of 2026-09-16T23:16:46.261Z over the grant",
    "2026-09-16T23:17:17.841Z — the expiry sweep removed the grant (its stored date had passed)",
    "2026-09-20T14:22:13.759Z — seed reward wrote an expiration of 2026-09-23T14:22:13.100Z over the grant",
  ];
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: {
      "/api/vips/integrity": { body: { scanned: 1234, findings: [{
        serverId: "s1", serverName: "WW2", playerId: "p-faith", playerName: "FAITH", verdict: "lost",
        permanentSince: "2026-09-09T21:41:49.000Z", grantedBy: "KREITZ [LYNX]", currentExpiration: null, evidence,
      }] } },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    const toggle = page.locator("button.panel-toggle", { hasText: "VIP integrity" });
    await toggle.waitFor({ timeout: 15_000 });
    await toggle.click();
    await page.locator("button", { hasText: "Scan all servers" }).click();
    const row = page.locator("tr", { hasText: "FAITH" });
    await row.waitFor({ timeout: 15_000 });

    assert.equal(await row.locator(".evidence-line").count(), 2, "the first two receipts: what dated it, what took it off the game");
    const more = row.locator("button", { hasText: "Show all 6" });
    assert.equal(await more.count(), 1, "the rest are one tap away");
    assert.doesNotMatch(await row.innerText(), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "dates read like every other date in the panel, not as raw stamps");
    assert.equal(await row.locator("td").first().evaluate((td) => window.getComputedStyle(td).verticalAlign), "top", "the name and buttons sit at the top of the row");

    await more.click();
    assert.equal(await row.locator(".evidence-line").count(), 6);
    await row.locator("button", { hasText: "Show fewer" }).click();
    assert.equal(await row.locator(".evidence-line").count(), 2);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A row's Revoke answers where the row is.
 *
 * Field report, with a screenshot: Revoke on a group member far down the VIP list put its reason
 * ("holds permanent VIP from group …") in the page's error line — at the TOP of the page, a screen
 * or more above the row on a phone, so nothing seemed to happen. The reason now opens in a dialog
 * in front of the row. A request filed for approval is news, not a failure, and keeps the line.
 */
test("VIPs: a row's Revoke says why it failed in a popup on screen, not in the line at the top", { skip: SKIP }, async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const row = (playerId, playerName, extra = {}) => ({
    id: `v-${playerId}`, serverId: "s1", playerId, playerName, comment: "", expiration: null,
    pausedUntil: null, pauseReason: null, pausedBy: null, pauseMode: null, groupHold: null,
    createdByName: "tester", createdAt: at, updatedAt: at, ...extra,
  });
  const hold = (bankedMs) => ({ since: at, bankedMs, groups: [{ id: "g1", name: "WW2 CVC", severanceMinutes: 0 }] });
  // A long list, so the two group members sort to the bottom — far below the page's error line.
  const filler = Array.from({ length: 40 }, (_, i) => row(`p${String(i).padStart(2, "0")}`, `Member ${String(i).padStart(2, "0")}`));
  const vips = [
    row("p-plain", "AA PLAIN"),
    ...filler,
    row("p-own", "YY OWN", { groupHold: hold(2 * 86_400_000) }),
    row("p-held", "ZZ HELD", { groupHold: hold(0) }),
  ];
  await withPage({
    grants: OWNER_GRANTS,
    viewport: { width: 390, height: 844 },
    overrides: {
      "/api/servers/s1/vips": { body: { vips } },
      // Confirmed on the row, then refused: the store found the hold gone between read and write.
      "/api/servers/s1/vips/p-own": { status: 409, body: { error: { code: "conflict", message: "VIP not revoked: Test Server #1 (their VIP changed while this ran — a group no longer holds it; look again before revoking)" } } },
      // Filed for approval rather than done.
      "/api/servers/s1/vips/p-plain": { status: 202, body: { requested: true, label: "Revoke VIP" } },
    },
  }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/vips`, { waitUntil: "networkidle" });
    const revokeOn = (name) => page.locator("tr", { hasText: name }).locator("button", { hasText: "Revoke" });
    await revokeOn("ZZ HELD").waitFor({ timeout: 15_000 });
    const deletes = () => stub.calls.filter((c) => c.method === "DELETE").map((c) => c.path);

    // Nothing of their own beneath the hold: refused on the spot, nothing sent.
    await revokeOn("ZZ HELD").scrollIntoViewIfNeeded();
    await revokeOn("ZZ HELD").click();
    const refused = page.locator(".confirm-modal", { hasText: "Can't revoke ZZ HELD's VIP" });
    await refused.waitFor({ timeout: 5_000 });
    assert.match(await refused.innerText(), /group “WW2 CVC” alone — there is no VIP of their own beneath it to revoke/);
    assert.ok(await inFront(refused, 844), "nothing covers the dialog");
    assert.equal(await page.locator("p.error", { hasText: "no VIP of their own" }).count(), 0, "not in the page's error line");
    assert.deepEqual(deletes(), [], "nothing was sent");
    await refused.locator("button", { hasText: "OK" }).click();
    await refused.waitFor({ state: "detached" });

    // Confirmed, then refused by the API: that reason pops up too.
    await revokeOn("YY OWN").click();
    await page.locator(".confirm-modal", { hasText: "Revoke YY OWN's own VIP?" }).waitFor();
    await page.locator(".confirm-modal button", { hasText: "Revoke their own VIP" }).click();
    const failed = page.locator(".confirm-modal", { hasText: "Couldn't revoke YY OWN's VIP" });
    await failed.waitFor({ timeout: 5_000 });
    assert.match(await failed.innerText(), /a group no longer holds it; look again before revoking/);
    assert.ok(await inFront(failed, 844), "nothing covers the dialog");
    assert.equal(await page.locator("p.error", { hasText: "no longer holds it" }).count(), 0, "not in the page's error line");
    assert.deepEqual(deletes(), ["/api/servers/s1/vips/p-own"]);
    await failed.locator("button", { hasText: "OK" }).click();
    await failed.waitFor({ state: "detached" });

    // Filed for approval: no popup, and the page's line says where it went.
    await revokeOn("AA PLAIN").click();
    await page.locator(".confirm-modal", { hasText: "Revoke VIP from AA PLAIN?" }).waitFor();
    await page.locator(".confirm-modal button", { hasText: "Remove" }).click();
    await page.locator("p.hint", { hasText: "Sent for approval" }).waitFor({ timeout: 5_000 });
    assert.equal(await page.locator(".confirm-modal").count(), 0, "no popup for a filed request");
    assert.deepEqual(deletes(), ["/api/servers/s1/vips/p-own", "/api/servers/s1/vips/p-plain"]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The Seeding tab said "Loading seeding config…" for good when the read failed: the error was drawn
 * only inside the form, which needs the config it failed to read.
 */
test("the Seeding tab says when its settings could not be read", { skip: SKIP }, async () => {
  const failed = { status: 500, body: { error: { code: "internal", message: "The seeding settings could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/seeding": failed } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/seeding`, { waitUntil: "networkidle" });
    await page.locator(".error", { hasText: "The seeding settings could not be read." }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("Loading seeding config…").count(), 0, "no longer loading");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The Discord relay kept the last server's routing on screen after another server was picked,
 * until the new server's came in: editable, and saved to the new server under its name.
 */
test("the Discord relay drops the last server's routing the moment another server is picked", { skip: SKIP }, async () => {
  const relay = (channel, delayMs = 0) => ({ delayMs, body: {
    categories: ["kills", "chat"], botConfigured: true,
    config: { enabled: true, categories: ["kills"], channels: { kills: channel }, categoryOptions: {},
      alerts: { adminPing: { enabled: false, trigger: "!admin", channelId: "", mentionRoleId: "" }, watchlist: { enabled: false, channelId: "", mentionRoleId: "" }, automation: { enabled: false, channelId: "", mentionRoleId: "" } } },
  } });
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers": { body: { servers: TWO_OF_ONE_GAME } },
    "/api/servers/s1/discord": relay("111"),
    "/api/servers/s2/discord": relay("222", 2_500),
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/discord/relay`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "111"), null, { timeout: 10_000 });
    await page.locator(".server-switcher select").selectOption("s2");
    await page.waitForTimeout(600);
    assert.ok(!(await fieldValues(page)).includes("111"), "One's channel is not shown as Two's");
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "222"), null, { timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("the Seeding tab drops the last server's settings the moment another server is picked", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers": { body: { servers: TWO_OF_ONE_GAME } },
    "/api/servers/s1/seeding": seedingReply(41),
    "/api/servers/s2/seeding": seedingReply(52, 2_500),
  } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/seeding`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "41"), null, { timeout: 10_000 });
    await page.locator(".server-switcher select").selectOption("s2");
    await page.waitForTimeout(600);
    assert.ok(!(await fieldValues(page)).includes("41"), "One's seed target is not shown as Two's");
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "52"), null, { timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The templates are a permission of their own, but Server settings asked for them on every open
 * and read a refusal as "no templates": a profiles-only account was shown an empty Templates
 * panel, and a profile's chosen template was called missing. A list that failed said the same.
 */
test("Auto settings: the templates show with their own permission, and a list not read calls no template missing", { skip: SKIP }, async () => {
  const profiles = { body: { config: { enabled: false, dryRun: true, timezone: "UTC", profiles: [{ name: "Evening", spec: {}, settings: {}, applyTemplate: "Night" }] }, fields: [] } };
  const open = async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/settings`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => [...window.document.querySelectorAll(".content input")].some((el) => el.value === "Evening"), null, { timeout: 10_000 });
  };
  const chosen = async (page) => (await page.locator(".content select:has(option[value='Night']) option[value='Night']").first().textContent()).trim();
  const templatesPanel = (page) => page.locator(".panel").filter({ has: panelTitled(page, "Templates") });

  await withPage({ grants: [held("server.view", "read"), held("autosettings.profiles")], overrides: { ...ACTIVE_S1, "/api/servers/s1/autosettings": profiles } }, async (page, { stub, errors }) => {
    await open(page);
    assert.equal(await panelTitled(page, "Templates").count(), 0, "no templates panel without the templates");
    assert.equal(await chosen(page), "Night", "the profile's template, not called missing");
    assert.ok(!stub.calls.some((c) => c.path === "/api/autosettings/templates"), "the list is not asked for");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  const failed = { status: 500, body: { error: { code: "internal", message: "The templates could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { ...ACTIVE_S1, "/api/servers/s1/autosettings": profiles, "/api/autosettings/templates": failed } }, async (page, { errors }) => {
    await open(page);
    await templatesPanel(page).locator(".error", { hasText: "Couldn't load the templates" }).waitFor({ timeout: 10_000 });
    assert.doesNotMatch(await templatesPanel(page).innerText(), /No templates yet/, "a failed list is not an empty one");
    assert.equal(await chosen(page), "Night", "not called missing when the list could not be read");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // Read, and not on it: that one is missing.
  const day = { body: { templates: [{ id: "t1", name: "Day", config: { profiles: [] }, createdByName: "owner", updatedAt: "2026-10-01T00:00:00Z" }] } };
  await withPage({ grants: OWNER_GRANTS, overrides: { ...ACTIVE_S1, "/api/servers/s1/autosettings": profiles, "/api/autosettings/templates": day } }, async (page) => {
    await open(page);
    await templatesPanel(page).locator(".field-label", { hasText: "Day" }).waitFor({ timeout: 10_000 });
    assert.equal(await chosen(page), "Night (missing)");
  });
});

test("Discord and Administration: the bot's setup, the role map and online access each open with their own permission", { skip: SKIP }, async () => {
  await withPage({ grants: [held("discord.setup")] }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/discord`, { waitUntil: "networkidle" });
    await onlyTab(page, "#/discord/setup");
    await panelTitled(page, "Slash command").waitFor({ timeout: 10_000 });
    const panels = await panelTitles(page);
    assert.ok(panels.includes("Setup & status") && panels.includes("Community badges"), `the bot's setup: ${panels.join(", ")}`);
    assert.ok(!panels.includes("Sign-in & roles"), "not the role map");
    assert.equal(await page.locator(".nav-item", { hasText: "Administration" }).count(), 0, "and no Administration");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  await withPage({ grants: [held("admin.users")] }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/discord`, { waitUntil: "networkidle" });
    await onlyTab(page, "#/discord/signin");
    await panelTitled(page, "Sign-in & roles").waitFor({ timeout: 10_000 });
    assert.ok(!(await panelTitles(page)).includes("Setup & status"), "user & role admin keeps the role map, and only that");
    await page.goto(`${page.url().split("#")[0]}#/admin`, { waitUntil: "networkidle" });
    await onlyTab(page, "#/admin/users");
  });
  await withPage({ grants: [held("admin.online")], overrides: { "/api/online": { body: { statsSite: { host: null, origin: null, name: null, shareable: null } } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin`, { waitUntil: "networkidle" });
    await onlyTab(page, "#/admin/online");
    await panelTitled(page, "Public stats site").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The game log with nothing matching says what to change, in the controls the screen has. It said
 * to widen the time range, and there is no time range on it: a kind of line, a search, a player.
 */
test("the empty game log names only filters the screen has", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/history/logs`, { waitUntil: "networkidle" });
    const empty = page.locator(".empty-state", { hasText: "No matching log lines" });
    await empty.waitFor();
    const text = await empty.innerText();
    assert.doesNotMatch(text, /time range/i, "there is no time range on this screen");
    for (const name of await empty.locator("strong").allTextContents()) {
      assert.equal(await page.locator(".seg-btn", { hasText: new RegExp(`^${name.trim()}$`) }).count(), 1, `"${name}" is on the screen`);
    }
  });
});

test("paging through the game log never re-shows rows you just read", { skip: SKIP }, async () => {
  /*
   * Offset paging assumes the list holds still, and the game log is the fastest-moving list in the
   * panel. Ask for OFFSET 50 a minute after page one and every event that arrived in between has
   * pushed the window down, so page two opens on rows page one already showed — and the rows
   * squeezed out between the two windows are never seen at all.
   *
   * The stub grows its log between pages, exactly as a live server does, and honours the anchor the
   * way the API does. Without one it hands back the drifted window, which is what this pins. The
   * same run also pins the pager itself: pages REPLACE (not append), and the per-page dropdown
   * re-reads at the new size.
   */
  const PAGE = 50;
  let arrived = 0; // rows appended since the reader opened the log
  const rowsAt = (n) => Array.from({ length: n }, (_, i) => ({
    // Newest first, so a new event lands at the TOP and shifts everything below it.
    id: `e${n - 1 - i}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, n - 1 - i)).toISOString(),
    kind: "evt.kill", actorName: `p${n - 1 - i}`, victimName: "v", weapon: "M1",
  }));

  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/events": (url) => {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const anchor = url.searchParams.get("anchor");
        // Page one is the reader arriving. Everything after it happens "later", so grow the log.
        if (offset === 0) arrived = 0; else arrived += 10;
        const all = rowsAt(300 + arrived);
        // The API's contract: an anchor excludes anything newer than the moment page one began.
        const visible = anchor ? all.filter((e) => e.ts < anchor) : all;
        const limit = Number(url.searchParams.get("limit") ?? PAGE);
        return { body: {
          events: visible.slice(offset, offset + limit),
          total: visible.length,
          offset, limit,
          // Minted on page one only, then echoed back by the panel on every later page.
          anchor: anchor ?? new Date(Date.UTC(2026, 0, 1, 0, 5, 0)).toISOString(),
        } };
      },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/history/logs`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-row", { timeout: 15_000 });

    const rowKeys = () => page.evaluate(() =>
      [...window.document.querySelectorAll(".log-row")].map((r) => r.textContent?.trim() ?? ""));

    const seen = [await rowKeys()];
    assert.equal(seen[0].length, PAGE, `page one should show one full page, got ${seen[0].length}`);

    // Step to pages two and three with the log growing underneath each time. Pages REPLACE: the
    // screen holds one page, so each step waits for the first row to change rather than for more.
    for (let i = 0; i < 2; i++) {
      const next = page.locator('.pager button[title="Next page"]');
      assert.equal(await next.count(), 1, `no next-page control on pass ${i + 1} — the test would prove nothing`);
      const firstBefore = seen[seen.length - 1][0];
      await next.click();
      await page.waitForFunction(
        (prev) => window.document.querySelector(".log-row")?.textContent?.trim() !== prev,
        firstBefore,
        { timeout: 15_000 },
      );
      seen.push(await rowKeys());
      assert.equal(seen[seen.length - 1].length, PAGE, `page ${i + 2} should be one full page`);
    }

    // Every row across the three pages is distinct — the anchor pinned the snapshot while the log
    // grew, so no page opened on rows another page already showed.
    const all = seen.flat();
    assert.equal(all.length, PAGE * 3, `expected three full pages, got ${all.length} rows`);
    const dupes = all.filter((r, i) => r && all.indexOf(r) !== i);
    assert.deepEqual(dupes, [], `rows appeared on two pages: ${dupes.slice(0, 3).join(" | ")}`);

    // The per-page dropdown re-reads at the new size, from page one.
    await page.locator(".pager-size select").selectOption("25");
    await page.waitForFunction(
      () => window.document.querySelectorAll(".log-row").length === 25,
      undefined,
      { timeout: 15_000 },
    );
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("Players screens come back as they were left: from another tab, and from a profile opened on them", { skip: SKIP }, async () => {
  /*
   * Owner's report: searching a player or picking a statistic, opening a profile and going back
   * reset the screen. Only the game log kept its filters. Everything else was plain state that
   * went with the screen: a profile opened from the Leaderboard is the Directory's tab, so the
   * board unmounted under it, and switching tabs unmounted the tab left. Each screen here is left
   * in a state of its own, taken away from (a tab, a profile, another section) and brought back —
   * by its tab, or by the browser's Back — and must come back exactly so, asking the API with it
   * the first time. A new sitting then opens them plain.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const servers = [
    { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
    { id: "s2", name: "WW2 #2", game: "hll", engagementMode: "active" },
  ];
  const roster = Array.from({ length: 120 }, (_, i) => ({ id: i === 0 ? "p1" : `px${i}`, platformId: `7656110000${String(i).padStart(7, "0")}`, name: i === 0 ? "Caereca" : `Player ${i}` }));
  const asked = { players: [], board: [], members: [], ledger: [] };
  const clan = { key: "lynx", label: "LYNX", customised: false, now: 1, ever: 2, lastSeen: at, spellings: [{ tag: "LYNX", ever: 2, now: 1, lastSeen: at }] };
  const group = (id, name) => ({ id, name, description: null, memberCount: 1, createdByName: "owner", vipPerk: null });
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers } },
      "/api/players": (url) => {
        asked.players.push(url.searchParams);
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const hits = roster.filter((p) => p.name.toLowerCase().includes(q));
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
        return { body: { players: hits.slice(offset, offset + limit), total: hits.length } };
      },
      "/api/leaderboard": (url) => {
        asked.board.push(url.searchParams);
        return { body: { leaderboard: [{ playerId: "p1", name: "Caereca", kills: 9, deaths: 3, teamkills: 0, kd: 3, combat: 0, offense: 0, defense: 0, support: 0, slSeconds: 0, playtime: 7200 }] } };
      },
      "/api/clans": { body: { clans: [clan], total: 1, focus: null, canEdit: true } },
      "/api/clans/members": (url) => {
        asked.members.push(url.searchParams);
        return { body: { members: [{ playerId: "p1", name: "Caereca", game: "hll", platform: "steam", platformId: "76561", lastSeen: at, tag: "LYNX", firstSeen: at, tagLastSeen: at, wearingNow: true, currentTag: "LYNX" }], total: 1 } };
      },
      "/api/player-groups": { body: { groups: [group("g1", "WW2 CVC"), group("g2", "Seeders")] } },
      "/api/player-groups/g1": { body: { members: [] } },
      // Sixty members, so the list has a second page — and the one opened from it is on it.
      "/api/player-groups/g2": { body: { members: Array.from({ length: 60 }, (_, i) => (i === 55
        ? { playerId: "p1", playerName: "Caereca", addedByName: "owner", addedAt: at, source: "manual" }
        : { playerId: `7656112000${String(i).padStart(7, "0")}`, playerName: `Member ${i}`, addedByName: "owner", addedAt: at, source: "manual" })) } },
      "/api/player-triggers": { body: { triggers: [] } },
      "/api/players/p1/triggers": { body: { triggers: [], allowedActions: ["message"] } },
      "/api/economy/members": (url) => {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const all = [{ discordId: "d1", discordName: "Abby", balance: 50, updatedAt: at }, { discordId: "d2", discordName: "Zed", balance: 5, updatedAt: at }];
        const hits = all.filter((m) => m.discordName.toLowerCase().includes(q));
        return { body: { members: hits, total: hits.length } };
      },
      "/api/economy/members/d1": (url) => {
        asked.ledger.push(url.searchParams);
        return { body: { ledger: [{ id: "e1", delta: 50, reason: "seeding", ref: null, actorName: "owner", createdAt: at }], players: [{ id: "p1", name: "Caereca", game: "hll", platform: "steam", platformId: "76561", lastSeen: at }] } };
      },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const tab = async (label) => { await page.click(`.tabbar-tab:text-is('${label}')`); };
    const scope = () => page.locator("select[aria-label='Server scope']").first();

    // --- The Directory: a search, one server, a filter, page two. Away to another tab, and back.
    await page.goto(`${base}#/players/players`, { waitUntil: "networkidle" });
    await page.waitForSelector("input.search-input", { timeout: 15_000 });
    await page.fill("input.search-input", "Player");
    await scope().selectOption("s2");
    await page.click("button:has-text('Filters')");
    await page.click("button:has-text('★ VIP')");
    // The directory reads its filters a beat after they are set: page two is paged once the list
    // they ask for has been read, not of the unfiltered list still on screen in the meantime.
    for (let i = 0; i < 150 && !asked.players.some((sp) => sp.get("q") === "Player" && sp.get("serverId") === "s2" && sp.get("vip") === "1"); i++) await page.waitForTimeout(100);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => /Page 1 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    let before = asked.players.length;
    await tab("VIPs");
    await tab("Directory");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(await page.inputValue("input.search-input"), "Player", "the directory's search came back");
    assert.equal(await scope().inputValue(), "s2", "and its server");
    assert.equal(await page.locator("button:has-text('★ VIP')").getAttribute("class").then((c) => /active|pressed/.test(c ?? "")), true, "and its filter");
    const first = asked.players[before];
    assert.deepEqual({ q: first.get("q"), serverId: first.get("serverId"), vip: first.get("vip"), offset: first.get("offset") },
      { q: "Player", serverId: "s2", vip: "1", offset: "50" }, "the first read after coming back asked for the page that was left");

    // --- The Leaderboard: rank by playtime over every server, open the player, Back.
    await tab("Leaderboard");
    await page.waitForSelector("select[aria-label='Rank by']", { timeout: 15_000 });
    await page.selectOption("select[aria-label='Rank by']", "playtime");
    await scope().selectOption("");
    await page.waitForFunction(() => window.document.querySelector("select[aria-label='Server scope']")?.value === "", null, { timeout: 15_000 });
    before = asked.board.length;
    await page.click(".player-link:has-text('Caereca')");
    await page.waitForFunction(() => window.location.hash === "#/players/~p1", null, { timeout: 15_000 });
    await page.goBack();
    await page.waitForSelector("select[aria-label='Rank by']", { timeout: 15_000 });
    assert.equal(await page.locator("select[aria-label='Rank by']").inputValue(), "playtime", "the board came back ranking what was picked");
    assert.equal(await scope().inputValue(), "", "over every server");
    for (let i = 0; i < 150 && asked.board.length <= before; i++) await page.waitForTimeout(100);
    const boardAsk = asked.board[before];
    assert.ok(boardAsk, "the board read its standings again");
    assert.deepEqual({ sort: boardAsk.get("sort"), serverId: boardAsk.get("serverId") }, { sort: "playtime", serverId: null }, "and asked with them the first time");

    // --- The profile's activity: Kills only, away to another section, Back.
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.click(".seg-btn:text-is('Kills')");
    await page.waitForSelector(".seg-btn.active:text-is('Kills')", { timeout: 15_000 });
    await page.goto(`${base}#/history/matches`, { waitUntil: "networkidle" });
    await page.goBack();
    await page.waitForSelector(".seg-btn.active:text-is('Kills')", { timeout: 15_000 });

    // --- Clans: a search, a clan ticked, a member's profile, Back.
    await page.goto(`${base}#/players/clans`, { waitUntil: "networkidle" });
    await page.waitForSelector("input[aria-label='Select LYNX']", { timeout: 15_000 });
    await page.fill("input.search-input", "DAW");
    await page.check("input[aria-label='Select LYNX']");
    await page.waitForSelector("tr:has-text('Caereca')", { timeout: 15_000 });
    await page.click("tr:has-text('Caereca')");
    await page.waitForFunction(() => window.location.hash === "#/players/~p1", null, { timeout: 15_000 });
    before = asked.members.length;
    await page.goBack();
    await page.waitForSelector("input[aria-label='Select LYNX']", { timeout: 15_000 });
    assert.equal(await page.inputValue("input.search-input"), "DAW", "the clan search came back");
    assert.equal(await page.isChecked("input[aria-label='Select LYNX']"), true, "and the ticked clan");
    await page.waitForSelector("tr:has-text('Caereca')", { timeout: 15_000 });
    for (let i = 0; i < 150 && asked.members.length <= before; i++) await page.waitForTimeout(100);
    assert.equal(asked.members[before]?.get("key"), "lynx", "its members were read again for the clan ticked");

    // --- Groups: the second group, its second page of members, one of them opened, Back.
    await page.goto(`${base}#/players/groups`, { waitUntil: "networkidle" });
    const picker = page.locator("select", { has: page.locator("option", { hasText: "Seeders" }) });
    await picker.waitFor({ timeout: 15_000 });
    await picker.selectOption("g2");
    await page.waitForFunction(() => /Page 1 of 2/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await page.click(".player-link:has-text('Caereca')");
    await page.waitForFunction(() => window.location.hash === "#/players/~p1", null, { timeout: 15_000 });
    await page.goBack();
    await picker.waitFor({ timeout: 15_000 });
    await page.waitForSelector(".player-link:has-text('Caereca')", { timeout: 15_000 });
    assert.equal(await picker.inputValue(), "g2", "the group on screen came back, not the first group");
    assert.match(await page.locator(".pager-where").first().innerText(), /Page 2 of 2/, "on the page of members it was left on");

    // --- VIPs: a search, away to another tab, back.
    await tab("VIPs");
    const vipSearch = page.getByPlaceholder("Search name or ID…");
    await vipSearch.fill("donor");
    await tab("Clans");
    await tab("VIPs");
    assert.equal(await vipSearch.inputValue(), "donor", "the VIP search came back");

    // --- Triggers: the player picked, away to another tab, back.
    await tab("Triggers");
    await page.getByPlaceholder("Pick the player this is about…").fill("Caer");
    await page.click(".picker-card-top:has-text('Caereca')");
    await page.waitForSelector(".picker-chip:has-text('Caereca')", { timeout: 15_000 });
    await tab("VIPs");
    await tab("Triggers");
    await page.waitForSelector(".picker-chip:has-text('Caereca')", { timeout: 15_000 });

    // --- Economy: a search and the member open below it, a linked player's profile, Back.
    await tab("Economy");
    const memberSearch = page.getByPlaceholder("Search by Discord name or id…");
    await memberSearch.fill("Ab");
    await page.waitForSelector("tr:has-text('Abby')", { timeout: 15_000 });
    await page.click("tr:has-text('Abby')");
    const linked = page.locator(".player-link:has-text('Caereca')");
    await linked.waitFor({ timeout: 15_000 });
    before = asked.ledger.length;
    await linked.click();
    await page.waitForFunction(() => window.location.hash.startsWith("#/players/~"), null, { timeout: 15_000 });
    await page.goBack();
    await linked.waitFor({ timeout: 15_000 });
    assert.equal(await memberSearch.inputValue(), "Ab", "the member search came back");
    assert.ok(asked.ledger.length > before, "and the member open below it, its ledger read again");

    // --- A new sitting (a new tab: this browser's localStorage, an empty sessionStorage) opens
    // every one of them plain.
    await page.evaluate(() => window.sessionStorage.clear());
    await page.goto(`${base}#/players/players`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("input.search-input", { timeout: 15_000 });
    assert.equal(await page.inputValue("input.search-input"), "", "a new sitting's directory has no search");
    await tab("Leaderboard");
    await page.waitForSelector("select[aria-label='Rank by']", { timeout: 15_000 });
    assert.equal(await page.locator("select[aria-label='Rank by']").inputValue(), "kills", "and ranks by the default");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A staff member's Actions tab filters by kind of action, and the dropdown always shows the kind it
 * is filtering by. Its choices were only the kinds on the rows loaded, so a filter with nothing to
 * show (or still loading) dropped out of its own dropdown: "All actions" above a list that was
 * filtered to kicks.
 */
test("a staff member's action filter shows itself even when nothing matches", { skip: SKIP }, async () => {
  const at = "2026-01-01T00:00:00.000Z";
  const row = (i, action) => ({ id: `a${i}`, ts: at, actorUserId: "u2", actorName: "mod", actorDisplayName: "mod", action, targetType: "player", targetId: `x${i}`, targetName: `Target ${i}`, summary: `${action} ${i}`, serverId: "s1" });
  const rows = [row(1, "player.kick"), row(2, "player.message"), row(3, "player.kick")];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/audit/staff/u2": { body: { user: { id: "u2", username: "mod", createdAt: at }, actorName: "mod", analytics: {
      total: 3, firstAt: at, lastAt: at, byAction: {}, topTargets: [], topServers: [], daily: [],
      byCategory: { bans: 0, kicks: 2, vips: 0, messages: 1, moves: 0, punishments: 0, requests: 0, other: 0 } } } },
    // Nothing on or after the 2nd: a date range there finds no kicks.
    "/api/audit": (url) => {
      const kind = url.searchParams.get("action"), from = url.searchParams.get("from");
      const entries = rows.filter((r) => (!kind || r.action === kind) && (!from || r.ts >= from));
      return { body: { entries, total: entries.length } };
    },
  } }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/staff/~u2`, { waitUntil: "networkidle" });
    await page.click("button.viz-toggle:text-is('Actions')");
    const kind = page.locator("select", { has: page.locator("option", { hasText: "All actions" }) });
    await kind.locator("option", { hasText: "player.kick" }).waitFor({ state: "attached" });
    await kind.selectOption("player.kick");
    await page.locator("label", { hasText: "From" }).locator("input[type=date]").fill("2026-01-02");
    await page.getByText("No matching activity.").waitFor();
    assert.equal(await kind.inputValue(), "player.kick", "the dropdown still says what it is filtering by");
  });
});

test("Analytics, staff activity and the other lists come back as they were left", { skip: SKIP }, async () => {
  /*
   * "A specific statistic" in the owner's report: the analytics tabs each held their window, metric
   * and chart as plain state, so a tab switched away from came back on the last 30 days and the
   * heatmap again, and so did the staff trail and a staff member's page, the event report, the
   * automation history and the maps catalogue. Each is
   * left in a state of its own, taken away and brought back, and must come back as it was — asking
   * the API with it the first time.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const asked = { server: [], match: [], player: [], trail: [], member: [], history: [], report: [] };
  const trail = Array.from({ length: 120 }, (_, i) => ({ id: `t${i}`, ts: at, actorUserId: "u2", actorName: "mod", actorDisplayName: "mod", action: "player.kick", targetType: "player", targetId: `x${i}`, targetName: `Target ${i}`, summary: `kicked ${i}`, serverId: "s2" }));
  const event = (id, name, status = "closed") => ({ id, name, serverId: "s1", status, openMode: "at", openAnchor: at, closeMode: "at", closeAnchor: at, minMinutes: 0, mapVoteProfile: null, rotationSetId: null, createdBy: "owner" });
  let events = [event("ev1", "Friday Night"), event("ev2", "Sunday Push")];
  const reportOf = (id, players) => ({ event: events.find((ev) => ev.id === id), report: {
    window: { from: at, to: at, live: false }, rounds: [], top: [],
    attendance: { players, totalMinutes: 0, medianMinutes: 0, peakConcurrent: null, fromRoster: false, list: [] },
  } });
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [
        { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
        { id: "s2", name: "WW2 #2", game: "hll", engagementMode: "active" },
      ] } },
      "/api/analytics/server": (url) => { asked.server.push(url.searchParams); return undefined; },
      "/api/analytics/match": (url) => { asked.match.push(url.searchParams); return undefined; },
      "/api/analytics/player": (url) => { asked.player.push(url.searchParams); return undefined; },
      "/api/players": { body: { players: [{ id: "p1", name: "Caereca", platform: "steam", platformId: "76561198000000001", lastSeen: at }], total: 1 } },
      "/api/audit/staff/u2": { body: { user: { id: "u2", username: "mod", createdAt: at }, actorName: "mod", analytics: {
        total: 120, firstAt: at, lastAt: at, byAction: {}, topTargets: [], topServers: [], daily: [],
        byCategory: { bans: 0, kicks: 120, vips: 0, messages: 0, moves: 0, punishments: 0, requests: 0, other: 0 } } } },
      "/api/audit": (url) => {
        if (url.searchParams.get("actor")) {
          asked.member.push(url.searchParams);
          const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
          return { body: { entries: trail.slice(offset, offset + limit), total: trail.length } };
        }
        if (url.searchParams.get("actions")) return undefined;
        asked.trail.push(url.searchParams);
        const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
        return { body: { entries: trail.slice(offset, offset + limit), total: trail.length } };
      },
      "/api/automation/history": (url) => { asked.history.push(url.searchParams); return { body: { entries: [], total: 0 } }; },
      "/api/payout-events": () => ({ body: { items: events } }),
      // The first event's report is slow, so a switch to the second can race it.
      "/api/payout-events/ev1/report": (url) => { asked.report.push(url.pathname); return { delayMs: 1500, body: reportOf("ev1", 111) }; },
      "/api/payout-events/ev2/report": (url) => { asked.report.push(url.pathname); return { body: reportOf("ev2", 222) }; },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const tab = async (label) => { await page.click(`.tabbar-tab:text-is('${label}')`); };
    const until = async (cond, what) => {
      for (let i = 0; i < 150 && !cond(); i++) await page.waitForTimeout(100);
      assert.ok(cond(), `timed out waiting for ${what}`);
    };
    // Another screen, for real, before Back: under load the goto can return before the app has
    // drawn it, and a Back from there never took the screen left off the page — so it read nothing
    // again, and the checks of what it read timed out.
    const away = async () => {
      await page.goto(`${base}#/history/matches`, { waitUntil: "networkidle" });
      await page.locator(".panel-title", { hasText: "Match history" }).waitFor({ timeout: 15_000 });
    };

    // --- Server analytics: 90 days, drawn as a line. Away to another tab, and back.
    await page.goto(`${base}#/analytics/server`, { waitUntil: "networkidle" });
    await page.click(".seg-btn:text-is('90 days')");
    await page.click(".seg-btn:text-is('Line graph')");
    const gridShows = page.locator('select[aria-label="What the grid shows"]');
    await gridShows.selectOption("kills");
    await until(() => asked.server.some((sp) => sp.get("days") === "90"), "the server figures for 90 days");
    let before = asked.server.length;
    await tab("Matches");
    await page.click(".seg-btn:text-is('7 days')");
    await until(() => asked.match.some((sp) => sp.get("days") === "7"), "the match figures for 7 days");
    await page.locator("button", { hasText: /^Showing \d+\+ rounds$/ }).click();
    await page.waitForSelector("button:text-is('Showing every map')", { timeout: 15_000 });
    await tab("Server");
    await page.waitForSelector(".seg-btn.active:text-is('90 days')", { timeout: 15_000 });
    await page.waitForSelector(".seg-btn.active:text-is('Line graph')", { timeout: 15_000 });
    assert.equal(await gridShows.inputValue(), "kills", "the grid still showing what it was showing");
    await until(() => asked.server.length > before, "the server figures read again");
    assert.equal(asked.server[before].get("days"), "90", "asking for the window left, the first time");
    // ...and each tab keeps its own window.
    before = asked.match.length;
    await tab("Matches");
    await page.waitForSelector(".seg-btn.active:text-is('7 days')", { timeout: 15_000 });
    await page.waitForSelector("button:text-is('Showing every map')", { timeout: 15_000 });
    await until(() => asked.match.length > before, "the match figures read again");
    assert.equal(asked.match[before].get("days"), "7");

    // --- Player analytics: one player picked. Away to another tab, and back.
    await tab("Players");
    await page.getByPlaceholder("Search a player by name…").fill("Caer");
    await page.click(".picker-card-top:has-text('Caereca')");
    await page.waitForSelector(".picker-chip:has-text('Caereca')", { timeout: 15_000 });
    await until(() => asked.player.some((sp) => sp.get("playerId")), "the picked player's figures");
    before = asked.player.length;
    await tab("Server");
    await tab("Players");
    await page.waitForSelector(".picker-chip:has-text('Caereca')", { timeout: 15_000 });
    await until(() => asked.player.length > before, "the player figures read again");
    assert.ok(asked.player[before].get("playerId"), "for the player left, the first time");

    // --- Staff activity: a search, one server, page two. A staff member opened from it, Back.
    await page.goto(`${base}#/admin/activity`, { waitUntil: "networkidle" });
    const trailSearch = page.locator("input.search-input").first();
    await trailSearch.fill("kick");
    await page.locator("select[aria-label='Server scope']").first().selectOption("s2");
    // The search applies after a pause in typing, and this stand-in answers every search alike: page
    // on before it lands and the late search, a new query, puts the list back on page one, as it
    // should. So page only once the trail has been asked with both.
    await until(() => asked.trail.some((sp) => sp.get("q") === "kick" && sp.get("serverId") === "s2"), "the trail asked with the search and the server");
    await page.waitForFunction(() => /Page 1 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    before = asked.trail.length;
    await away();
    await page.goBack();
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(await trailSearch.inputValue(), "kick", "the trail's search came back");
    assert.equal(await page.locator("select[aria-label='Server scope']").first().inputValue(), "s2", "and its server");
    await until(() => asked.trail.length > before, "the trail read again on Back");
    const back = asked.trail.find((sp, i) => i >= before);
    assert.deepEqual({ q: back.get("q"), serverId: back.get("serverId"), offset: back.get("offset") }, { q: "kick", serverId: "s2", offset: "50" }, "asking for the page left the first time");

    // --- One staff member's page: the Actions tab, one kind of action. Away, and Back.
    await page.goto(`${base}#/staff/~u2`, { waitUntil: "networkidle" });
    await page.click("button.viz-toggle:text-is('Actions')");
    const kind = page.locator("select", { has: page.locator("option", { hasText: "All actions" }) });
    await kind.waitFor({ timeout: 15_000 });
    await until(() => asked.member.length > 0, "the member's actions");
    await kind.selectOption("player.kick");
    await until(() => asked.member.some((sp) => sp.get("action") === "player.kick"), "the member's kicks");
    await page.waitForFunction(() => /Page 1 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.click("button[title='Next page']");
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    before = asked.member.length;
    await away();
    await page.goBack();
    await until(() => asked.member.length > before, "the member's actions read again");
    assert.deepEqual({ action: asked.member[before].get("action"), offset: asked.member[before].get("offset") }, { action: "player.kick", offset: "50" },
      "back on the Actions tab, asking for the kind and the page left, the first time");
    assert.equal(await kind.inputValue(), "player.kick");
    // The filters settle a moment after the page mounts; settling on the same ones is no new filter.
    await page.waitForTimeout(800);
    await page.waitForFunction(() => /Page 2 of 3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.deepEqual(asked.member.slice(before).map((sp) => sp.get("offset")), asked.member.slice(before).map(() => "50"), "and it stays on that page");

    // --- The event report: the second event. Away to another tab, and back.
    await page.goto(`${base}#/events/report`, { waitUntil: "domcontentloaded" });
    const picker = page.locator("select", { has: page.locator("option", { hasText: "Sunday Push" }) });
    await picker.waitFor({ timeout: 15_000 });
    await until(() => asked.report.includes("/api/payout-events/ev1/report"), "the latest event's report asked for");
    await picker.selectOption("ev2");
    await until(() => asked.report.includes("/api/payout-events/ev2/report"), "the second event's report");
    // The first event's report lands late, and must not paint over the second's.
    await page.waitForTimeout(2_000);
    const shown = await page.locator(".panel", { hasText: "Event report" }).first().innerText();
    assert.ok(/222/.test(shown) && !/111/.test(shown), `the second event's report stays on screen, got: ${shown.slice(0, 200)}`);
    before = asked.report.length;
    await tab("Events");
    await tab("Report");
    await until(() => asked.report.length > before, "the report read again");
    assert.equal(asked.report[before], "/api/payout-events/ev2/report", "for the event left, not the latest");
    assert.equal(await picker.inputValue(), "ev2");
    // ...unless it can no longer be reported on: then the latest, as on a first visit.
    events = [event("ev1", "Friday Night"), event("ev2", "Sunday Push", "draft")];
    before = asked.report.length;
    await tab("Events");
    await tab("Report");
    await until(() => asked.report.length > before, "a report read again");
    assert.deepEqual(asked.report.slice(before), ["/api/payout-events/ev1/report"], "the latest event's, and never the one gone");

    // --- Automation history: a search, oldest first. Away to another tab, and back.
    await page.goto(`${base}#/autosettings/history`, { waitUntil: "networkidle" });
    await until(() => asked.history.length > 0, "the automation history");
    await page.getByPlaceholder(/Search/).first().fill("seed");
    await until(() => asked.history.some((sp) => sp.get("q") === "seed"), "the history to be searched");
    before = asked.history.length;
    await away();
    await page.goBack();
    await until(() => asked.history.length > before, "the history read again");
    assert.equal(asked.history[before].get("q"), "seed", "the history came back searched");

    // --- The maps catalogue: a search, grouped by family. Another screen, and Back. (Its tabs are
    // one screen, so moving between them never lost anything; leaving the Maps section did.)
    await page.goto(`${base}#/maps/catalogue`, { waitUntil: "networkidle" });
    const mapSearch = page.getByPlaceholder("Search maps…");
    await mapSearch.fill("foy");
    await page.click("button:text-is('By family')");
    await away();
    await page.goBack();
    assert.equal(await mapSearch.inputValue(), "foy", "the catalogue's search came back");
    await page.waitForSelector("button[aria-pressed='true']:text-is('Flat list')", { timeout: 15_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("public stats: a hidden tab stops re-reading the game, and catches up the moment it is looked at", { skip: SKIP }, async () => {
  /*
   * The live screens re-read the game every 15 to 60 seconds and went on doing it in a hidden tab:
   * a player who left the stats page open behind the game kept the live scoreboard and the header
   * asking all evening, for a page nobody was looking at. Hidden, it asks for nothing; shown again,
   * it reads at once rather than waiting out the rest of the timer.
   */
  const mkServer = (slug, name) => ({
    slug, name, game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  });
  const info = {
    current_map: { map: { id: "foy_warfare", pretty_name: "Foy Warfare" }, start: 1_760_000_000 },
    player_count: 87, max_player_count: 100, player_count_by_team: { allied: 44, axis: 43 },
    score: { allied: 4, axis: 1 }, time_remaining: 2712.0, name: { name: "Alpha 24/7", short_name: "" },
  };
  const asked = { info: 0, live: 0 };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [mkServer("alpha", "Alpha 24/7")] } },
    "/stats/alpha/api/get_public_info": () => { asked.info += 1; return { body: { result: info, failed: false } }; },
    "/stats/alpha/api/get_live_game_stats": () => { asked.live += 1; return { body: { result: { snapshot_timestamp: 1, refresh_interval_sec: 5, stats: [] }, failed: false } }; },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    const until = async (cond, what) => {
      for (let i = 0; i < 150 && !cond(); i++) await page.waitForTimeout(100);
      assert.ok(cond(), `timed out waiting for ${what}`);
    };
    const setHidden = (hidden) => page.evaluate((h) => {
      Object.defineProperty(window.document, "hidden", { configurable: true, get: () => h });
      Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
      window.document.dispatchEvent(new window.Event("visibilitychange"));
    }, hidden);
    // The timers are 15 and 20 seconds, so the page boots on a clock the test can move.
    await page.clock.install();
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "networkidle" });
    await until(() => asked.info > 0 && asked.live > 0, "the first reads");
    // From here time moves only when the test moves it, so no timer can stand in for a read that
    // should have come from the tab being looked at.
    await page.clock.pauseAt(new Date(Date.now() + 2_000));

    // Seen: it keeps reading.
    const seen = { ...asked };
    await page.clock.fastForward(21_000);
    await until(() => asked.info > seen.info && asked.live > seen.live, "a visible tab to keep reading");

    // Hidden for five minutes: nothing at all.
    await setHidden(true);
    const hiddenAt = { ...asked };
    await page.clock.fastForward(5 * 60_000);
    await page.waitForTimeout(500);
    assert.deepEqual(asked, hiddenAt, "a hidden tab asks for nothing");

    // Looked at again: a read at once, not after the rest of the timer.
    await setHidden(false);
    await until(() => asked.info > hiddenAt.info && asked.live > hiddenAt.live, "a read the moment it is looked at again");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("a page is kept with the server it was read on: switched elsewhere, in front of the list, or reloaded", { skip: SKIP }, async () => {
  /*
   * A remembered page belonged to the list, not to the server it was read on. Page two of one
   * server's matches, the sidebar switched to the other server on another screen, Matches opened
   * again: page two of the other server's matches. Every list that reads the sidebar's server (or
   * a scope that follows it) is left on page two on the first server, the server switched from
   * another screen, and each must open on page one for the second server and on page two again
   * for the first. Switched in front of the list it is the same, and a long list's page is not cut
   * to the last page of the short one shown a moment before; a reload keeps the page too. A filter
   * changed meanwhile on the other server is a new question: the kept page does not come back.
   */
  const at = "2026-01-01T00:00:00.000Z";
  const paged = (rows, url) => {
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
    return rows.slice(offset, offset + limit);
  };
  const matchRows = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, map: "foy_warfare", startedAt: at, endedAt: at, durationSec: 3600, result: "Allies", score: "5-0" }));
  const matches = { s1: matchRows(300), s2: matchRows(120) }; // six pages and three
  const logRows = Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, ts: at, kind: "evt.kill", actorName: `p${i}`, victimName: "v", weapon: "M1" }));
  const voteRows = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, decidedAt: at, profile: null, winnerId: "foy", winnerName: "Foy", totalVotes: 1, outcome: "decided", applied: true, options: [] }));
  const tally = Array.from({ length: 60 }, (_, i) => ({ mapId: `m${i}`, name: `Map ${i}`, offered: 60 - i, won: 1, votes: 2 }));
  const voters = Array.from({ length: 60 }, (_, i) => ({ discordUserId: `d${i}`, discordName: `Voter ${i}`, votes: 60 - i, wins: 1, lastVotedAt: at, userId: null, playerId: null, playerName: null }));
  const trail = Array.from({ length: 120 }, (_, i) => ({ id: `t${i}`, ts: at, actorUserId: "u2", actorName: "mod", actorDisplayName: "mod", action: "player.kick", targetType: "player", targetId: `x${i}`, targetName: `Target ${i}`, summary: `kicked ${i}`, serverId: "s1" }));
  const roster = Array.from({ length: 120 }, (_, i) => ({ id: `px${i}`, platformId: `7656110000${String(i).padStart(7, "0")}`, name: `Player ${i}`, platform: "steam", firstSeen: at, lastSeen: at }));
  const history = Array.from({ length: 120 }, (_, i) => ({ id: `h${i}`, ts: at, action: "seeding.reward", actorName: "seeding", targetName: null, targetId: null, summary: `paid ${i}`, serverId: "s1", data: null }));
  const overrides = {
    "/api/servers": { body: { servers: [
      { id: "s1", name: "WW2 #1", game: "hll", engagementMode: "active" },
      { id: "s2", name: "WW2 #2", game: "hll", engagementMode: "active" },
    ] } },
    "/api/players": (url) => ({ body: { players: paged(roster, url), total: roster.length } }),
    "/api/audit/staff/u2": { body: { user: { id: "u2", username: "mod", createdAt: at }, actorName: "mod", analytics: {
      total: 120, firstAt: at, lastAt: at, byAction: {}, topTargets: [], topServers: [], daily: [],
      byCategory: { bans: 0, kicks: 120, vips: 0, messages: 0, moves: 0, punishments: 0, requests: 0, other: 0 } } } },
    "/api/audit": (url) => ({ body: { entries: paged(trail, url), total: trail.length } }),
    "/api/automation/history": (url) => ({ body: { entries: paged(history, url), total: history.length } }),
  };
  for (const id of ["s1", "s2"]) {
    overrides[`/api/servers/${id}/matches`] = (url) => ({ body: { matches: paged(matches[id], url), total: matches[id].length } });
    overrides[`/api/servers/${id}/events`] = (url) => ({ body: { events: paged(logRows, url), total: logRows.length } });
    overrides[`/api/servers/${id}/mapvote/history`] = (url) => ({ body: { history: paged(voteRows, url), total: voteRows.length, tally, voters } });
  }
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const picker = 'select[aria-label="Active server"]';
    const where = (scope, text) => scope.locator(".pager-where", { hasText: text }).first().waitFor({ timeout: 15_000 });
    const panel = (title) => page.locator(".panel", { has: page.locator(".panel-title", { hasText: title }) });
    // Each list: how to reach it, and the pagers on it.
    const lists = [
      { name: "matches", path: "#/history/matches", pagers: () => [page] },
      { name: "game log", path: "#/history/logs", pagers: () => [page] },
      { name: "map votes", path: "#/history/mapvotes", pagers: () => [panel("Every vote"), panel("Which maps win"), panel("Who votes")] },
      { name: "kicks", path: "#/moderation/kicks", pagers: () => [page] },
      { name: "directory", path: "#/players/directory", pagers: () => [page] },
      { name: "staff activity", path: "#/admin/activity", pagers: () => [page] },
      { name: "a staff member's actions", path: "#/staff/~u2", pagers: () => [page], open: async () => {
        const actions = page.locator("button.viz-toggle:text-is('Actions')");
        if (!(await actions.getAttribute("class"))?.includes("active")) await actions.click();
      } },
      { name: "automation history", path: "#/autosettings/history", pagers: () => [page] },
    ];
    const visit = async (l) => {
      await page.goto(`${base}${l.path}`, { waitUntil: "networkidle" });
      if (l.open) await l.open();
    };
    const switchElsewhere = async (id) => {
      await page.goto(`${base}#/help/pages`, { waitUntil: "networkidle" });
      await page.selectOption(picker, id);
    };

    // On the first server, every list left on page two.
    for (const l of lists) {
      await visit(l);
      for (const scope of l.pagers()) {
        await where(scope, "Page 1 of");
        await scope.locator("button[title='Next page']").first().click();
        await where(scope, "Page 2 of");
      }
    }
    // The sidebar switched to the second server elsewhere: each opens on its first page.
    await switchElsewhere("s2");
    for (const l of lists) {
      await visit(l);
      for (const scope of l.pagers()) {
        await where(scope, "Page 1 of").catch(() => { throw new Error(`${l.name}: the second server's list did not start at page one`); });
      }
    }
    // Back to the first server, elsewhere: each comes back on the page it was left on there.
    await switchElsewhere("s1");
    for (const l of lists) {
      await visit(l);
      for (const scope of l.pagers()) {
        await where(scope, "Page 2 of").catch(() => { throw new Error(`${l.name}: the first server's list lost its page`); });
      }
    }

    // A filter changed on the second server changes what the first server's kept page means: the
    // game log on Kills there, the first server's log opens on page one, not on page two of Kills.
    await switchElsewhere("s2");
    await page.goto(`${base}#/history/logs`, { waitUntil: "networkidle" });
    await where(page, "Page 1 of");
    await page.click(".seg-btn:text-is('Kills')");
    await page.waitForSelector(".seg-btn.active:text-is('Kills')", { timeout: 15_000 });
    await switchElsewhere("s1");
    await page.goto(`${base}#/history/logs`, { waitUntil: "networkidle" });
    await where(page, "Page 1 of").catch(() => { throw new Error("a page read under the old filter came back under the new one"); });

    // In front of the list: the first server's matches on their last page, the second server's
    // have three, and switching back must find page six — not page three of six.
    await page.goto(`${base}#/history/matches`, { waitUntil: "networkidle" });
    await page.click("button[title='Last page']");
    await where(page, "Page 6 of 6");
    await page.selectOption(picker, "s2");
    await where(page, "Page 1 of 3").catch(() => { throw new Error("switched in front, the second server's matches did not start at page one"); });
    await page.selectOption(picker, "s1");
    await where(page, "Page 6 of 6").catch(() => { throw new Error("switched back in front, the first server's matches were not on their page"); });

    // The directory builds its query a beat after its scope moves: switched in front and back,
    // the query catching up must not read as a new filter and drop the first server's page.
    await page.goto(`${base}#/players/directory`, { waitUntil: "networkidle" });
    await where(page, "Page 2 of");
    await page.selectOption(picker, "s2");
    await where(page, "Page 1 of");
    await page.waitForTimeout(800);
    await page.selectOption(picker, "s1");
    await where(page, "Page 2 of").catch(() => { throw new Error("switched back in front, the directory lost its page"); });
    await page.waitForTimeout(800);
    assert.match(await page.locator(".pager-where").first().innerText(), /Page 2 of/, "and the directory stays on it");

    // A reload: the directory comes back on its page.
    await page.reload({ waitUntil: "networkidle" });
    await where(page, "Page 2 of").catch(() => { throw new Error("reloaded, the directory went back to page one"); });
    // And stays there past the directory's debounce, which must not take the same query for a new one.
    await page.waitForTimeout(800);
    assert.match(await page.locator(".pager-where").first().innerText(), /Page 2 of/, "reloaded, the directory stays on its page");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * First run, in the panel itself. The start script opens the setup page with the one-time code in
 * the link, so the code is checked without anyone typing it, and the first thing asked is the owner
 * account — which carries the code. Signed in, the owner is walked through the time zone and the
 * first game server (tested before it is added), and the panel opens when they are done.
 */
test("first run: the code from the start script's link, the owner account, then time zone and first server — and the panel opens", { skip: SKIP }, async () => {
  let registered = false;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/me": () => (registered ? undefined : { status: 401, body: { error: { message: "not signed in" } } }),
    "/api/setup/status": () => ({ body: registered
      ? { needed: false, codeRequired: false, stage: "walkthrough", route: "home" }
      : { needed: true, codeRequired: true, stage: null, route: "home" } }),
    "/api/setup/verify": { body: { ok: true } },
    "/api/auth/register": () => { registered = true; return { status: 201, body: { user: { id: "u1", username: "owner" }, owner: true } }; },
    "/api/auth/login": { body: { token: "owner-token" } },
    "/api/app-config": { body: { config: { timezone: "UTC" } } },
    "/api/setup/test-server": { body: { ok: true, name: "LYNX WW2" } },
    "/api/setup/finish": { body: { ok: true } },
  } }, async (page, { stub, errors }) => {
    // The start script opens the link in a browser: a page loaded fresh, not one already open
    // (leaving for another address on the same origin makes the next visit a full load).
    await page.goto(`${stub.base}/api/health`);
    await page.goto(`${stub.base}/#/setup?code=abcd-efgh`, { waitUntil: "networkidle" });
    await page.locator("h1", { hasText: "Create the owner account" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(stub.calls.find((c) => c.path === "/api/setup/verify")?.body, { code: "abcd-efgh" }, "the code in the link is checked on its own");
    assert.doesNotMatch(page.url(), /code=/, "and leaves the address bar once it has done its job");

    await page.locator("input[autocomplete=username]").fill("owner");
    const pw = page.locator("input[type=password]");
    await pw.nth(0).fill("correct horse");
    await pw.nth(1).fill("correct horse");
    await page.locator("button", { hasText: "Create account" }).click();
    await page.locator("h1", { hasText: "Your community's time zone" }).waitFor({ timeout: 10_000 });
    const reg = stub.calls.find((c) => c.path === "/api/auth/register");
    assert.equal(reg?.body?.setupCode, "abcd-efgh", "the owner account carries the code");

    await page.locator("button", { hasText: "Save and continue" }).click();
    await page.locator("h1", { hasText: "Connect your game server" }).waitFor({ timeout: 10_000 });
    assert.ok(stub.calls.some((c) => c.method === "PUT" && c.path === "/api/app-config" && typeof c.body?.timezone === "string" && c.body.timezone.length > 0), "the time zone is saved");

    await page.locator("label", { hasText: "Server address" }).locator("input").fill("203.0.113.7");
    await page.locator("label", { hasText: "RCON port" }).locator("input").fill("28316");
    await page.locator("label", { hasText: "RCON password" }).locator("input").fill("rcon-pass");
    await page.locator("button", { hasText: "Test connection" }).click();
    await page.locator(".callout", { hasText: "Connected to “LYNX WW2”." }).waitFor({ timeout: 10_000 });
    assert.equal(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/servers").length, 0, "testing saves nothing");
    await page.locator("button", { hasText: "Add server" }).click();
    await page.locator("h1", { hasText: "You're ready" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(stub.calls.find((c) => c.method === "POST" && c.path === "/api/servers")?.body, { game: "hll", host: "203.0.113.7", port: 28316, password: "rcon-pass" });
    assert.match(await page.locator(".setup-next").innerText(), /Turn on nightly backups[\s\S]*Connect Discord/, "the optional next steps are offered, not asked");
    assert.match(await page.locator(".setup-card").innerText(), /Keep it on after a restart: let Docker Desktop start when you sign in, and the PC sign in by itself\./, "a home PC is told how to stay on after a restart");
    assert.match(await page.locator("details", { hasText: "Autologon" }).textContent(), /Start Docker Desktop when you sign in to your computer[\s\S]*Autologon[\s\S]*somewhere safe/);

    await page.locator("button", { hasText: "Open the panel" }).click();
    await page.locator(".nav-item").first().waitFor({ timeout: 10_000 });
    assert.ok(stub.calls.some((c) => c.method === "POST" && c.path === "/api/setup/finish"), "finishing ends the walk-through for good");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("first run: the setup link opened in a tab already showing the setup page is checked too", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/me": { status: 401, body: { error: { message: "not signed in" } } },
    "/api/setup/status": { body: { needed: true, codeRequired: true, stage: null, route: "home" } },
    "/api/setup/verify": { body: { ok: true } },
  } }, async (page, { stub }) => {
    await page.locator("h1", { hasText: "Set up your panel" }).waitFor({ timeout: 10_000 });
    // Only the part after # changes, so the page does not reload.
    await page.evaluate(() => { window.location.hash = "#/setup?code=wxyz-2345"; });
    await page.locator("h1", { hasText: "Create the owner account" }).waitFor({ timeout: 10_000 });
    assert.deepEqual(stub.calls.find((c) => c.path === "/api/setup/verify")?.body, { code: "wxyz-2345" });
  });
});

// A VM runs Docker as a service from boot: the advice for a PC that restarts is left out there.
test("first run on a VM: the last step leaves out the advice for a PC that restarts", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/setup/status": { body: { needed: false, codeRequired: false, stage: "walkthrough", route: "vm" } },
    "/api/app-config": { body: { config: { timezone: "UTC" } } },
  } }, async (page, { errors }) => {
    await page.locator("button", { hasText: "Save and continue" }).click();
    await page.locator("button", { hasText: "I'll add it later" }).click();
    await page.locator("h1", { hasText: "You're ready" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.getByText("Keep it on after a restart").count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("an install that is already set up opens on sign-in, never on setup", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/me": { status: 401, body: { error: { message: "not signed in" } } },
    "/api/setup/status": { body: { needed: false, codeRequired: false, stage: null, route: "home" } },
  } }, async (page) => {
    await page.locator("h1", { hasText: "Sign in" }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator("h1", { hasText: "Set up your panel" }).count(), 0);
    assert.equal(await page.locator("h1", { hasText: "Create the owner account" }).count(), 0);
  });
});

test("a narrow phone can still reach every tab of a crowded hub", { skip: SKIP }, async () => {
  // The same bar on a 390px phone, where only two or three tabs fit at once.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    const base = page.url().split("#")[0];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}#/analytics/staff`, { waitUntil: "networkidle" });
    await page.waitForSelector(".tabbar-tab", { timeout: 15_000 });

    const inView = await page.evaluate(() => {
      const strip = window.document.querySelector(".tabbar");
      const tab = strip?.querySelector('[aria-selected="true"]');
      if (!strip || !tab) return false;
      const s = strip.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      return t.left >= s.left - 1 && t.right <= s.right + 1;
    });
    assert.ok(inView, "on a phone the active tab must still be scrolled into view");

    // The page itself must not scroll sideways — the strip absorbs the overflow, not the document.
    const bodyOverflows = await page.evaluate(() =>
      window.document.documentElement.scrollWidth > window.document.documentElement.clientWidth + 1);
    assert.equal(bodyOverflows, false, "the page must not scroll horizontally; only the tab strip does");
  });
});

test("with two servers, the community-wide screens say which one the figures are for", { skip: SKIP }, async () => {
  /*
   * The leaderboard and the directory are community-wide by nature — a player is one person across
   * every server you run. They were also ONLY able to be community-wide: they merged every
   * server's careers into one figure while the sidebar above them named a single server, so the
   * merged number read as that server's and there was nothing on screen to say otherwise.
   *
   * This drives the real bundle with two servers configured and answers each `serverId` with
   * genuinely different data, so a panel that fails to send the parameter cannot pass.
   */
  const TWO = { servers: [
    { id: "s1", name: "Warfare", game: "hll", engagementMode: "observe" },
    { id: "s2", name: "Offensive", game: "hll", engagementMode: "observe" },
  ] };
  const byServer = {
    s1: [{ playerId: "p1", name: "AliceOnWarfare", kills: 100, deaths: 10, kd: 10, teamkills: 0, combat: 0, offense: 0, defense: 0, support: 0, slSeconds: 0, playtime: 3600 }],
    s2: [{ playerId: "p2", name: "BobOnOffensive", kills: 5, deaths: 5, kd: 1, teamkills: 0, combat: 0, offense: 0, defense: 0, support: 0, slSeconds: 0, playtime: 600 }],
  };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: TWO },
      "/api/leaderboard": (url) => {
        const id = url.searchParams.get("serverId");
        // No serverId at all = the combined board. Each server = only its own players.
        const rows = id ? (byServer[id] ?? []) : [...byServer.s1, ...byServer.s2];
        return { body: { sort: url.searchParams.get("sort") ?? "kills", serverId: id, leaderboard: rows } };
      },
    },
  }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/leaderboard`, { waitUntil: "networkidle" });
    await page.waitForSelector("table tbody tr", { timeout: 15_000 });

    // The control exists and is not decoration: the page opens on the pinned server, and the board
    // holds only that server's players.
    const picker = page.locator('select[aria-label="Server scope"]');
    assert.equal(await picker.count(), 1, "two servers must come with a visible scope control");
    let body = await page.locator("table tbody").innerText();
    assert.match(body, /AliceOnWarfare/, "the pinned server's players are on the board");
    assert.doesNotMatch(body, /BobOnOffensive/, "the OTHER server's players are not — that was the whole bug");

    // Switch to the other server: a completely different population.
    await picker.selectOption("s2");
    await page.waitForFunction(
      () => /BobOnOffensive/.test(window.document.querySelector("table tbody")?.textContent ?? ""),
      null,
      { timeout: 15_000 },
    );
    body = await page.locator("table tbody").innerText();
    assert.doesNotMatch(body, /AliceOnWarfare/, "and the first server's players are gone");

    // Combining is still available — it just has to be chosen, and the page says so when it is.
    await picker.selectOption("");
    await page.waitForFunction(
      () => /AliceOnWarfare/.test(window.document.querySelector("table tbody")?.textContent ?? ""),
      null,
      { timeout: 15_000 },
    );
    body = await page.locator("table tbody").innerText();
    assert.match(body, /BobOnOffensive/, "all-servers shows both");
    assert.match(await page.locator(".scope-hint").innerText(), /every server/i,
      "and the page states that these figures are combined, rather than leaving it to be assumed");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("one server: the scope control stays out of the way", { skip: SKIP }, async () => {
  // Most communities run a single server. Offering "all servers" versus "this server" there is a
  // choice between two identical answers, so the control must not appear at all.
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/leaderboard`, { waitUntil: "networkidle" });
    await page.waitForSelector(".panel", { timeout: 15_000 });
    assert.equal(await page.locator('select[aria-label="Server scope"]').count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The player profile's activity feed is the Game log's feed, and for a long time it was not.
 *
 * It printed the raw event key in a <code> — a moderator reading a profile saw `evt.kill` rather
 * than a coloured KILL tag, with the columns that carry the meaning (victim, weapon) pushed off the
 * right of a phone screen. The vocabulary existed the whole time; only the log used it. This pins
 * both halves: no raw keys, and the shared tag/tone classes actually present.
 */
test("a player profile reads events the way the game log does, not as raw evt.* keys", { skip: SKIP }, async () => {
  await withPage({}, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-list", { timeout: 10_000 });

    const body = await page.textContent("body");
    assert.ok(!/evt\.kill|evt\.admin\.message|evt\.teamkill/.test(body ?? ""),
      "the raw event key must never reach the screen");

    // The tags, with the tones that carry the meaning: an allied killer is blue, an axis killer
    // red, a team kill always yellow regardless of side.
    const tags = await page.$$eval(".log-tag", (els) => els.map((e) => e.textContent?.trim()));
    assert.ok(tags.includes("KILL"), `expected a KILL tag, got ${JSON.stringify(tags)}`);
    assert.ok(tags.includes("TK"), "a team kill is tagged TK");
    assert.ok(tags.includes("MSG"), "an admin message is tagged MSG");
    assert.equal((await page.$$(".log-tag.kill-blue")).length, 1, "the allied killer's row is blue");
    assert.equal((await page.$$(".log-tag.kill-red")).length, 1, "the axis killer's row is red");
    assert.equal((await page.$$(".log-row.tone-tk")).length, 1, "team kills are their own tone");

    // The weapon rides along in the sentence rather than in a column that falls off the screen.
    assert.ok((body ?? "").includes("M1 GARAND"), "the weapon is part of the line");
  });
});

test("a player profile's activity can be narrowed to one server and one kind", { skip: SKIP }, async () => {
  // A second server, so the scope picker is offered at all — it stays hidden when a player's
  // events only ever came from one place, which is the common case and needs no control.
  await withPage({
    overrides: { "/api/servers": { body: { servers: [
      { id: "s1", name: "Test Server #1", game: "hll", engagementMode: "observe" },
      { id: "s2", name: "Test Server #2", game: "hll", engagementMode: "observe" },
    ] } } },
  }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-list", { timeout: 10_000 });
    assert.equal((await page.$$(".log-row")).length, 4);

    // Team kills only: the one on the other server survives, the three on s1 go.
    await page.click(".activity-controls .seg-btn:has-text('Team kills')");
    await page.waitForFunction(() => window.document.querySelectorAll(".log-row").length === 1);
    assert.ok((await page.textContent("body"))?.includes("Necrosis85"));

    // Back to everything, then narrow by server instead. The events carry two different servers,
    // so the picker is offered at all — which is the thing that was missing.
    await page.click(".activity-controls .seg-btn:has-text('All')");
    await page.waitForFunction(() => window.document.querySelectorAll(".log-row").length === 4);
    const picker = await page.$(".activity-controls select[aria-label='Server scope']");
    assert.ok(picker, "two servers' events means a scope picker");
    await picker.selectOption("s2");
    await page.waitForFunction(() => window.document.querySelectorAll(".log-row").length === 1);
  });
});

test("the profile admits it has no sessions instead of hiding the panel", { skip: SKIP }, async () => {
  await withPage({}, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".log-list", { timeout: 10_000 });
    const body = await page.textContent("body");
    // The panel used to disappear entirely when the list was empty, which reads as "sessions are
    // not being tracked" rather than "this player has none".
    assert.ok((body ?? "").includes("Recent sessions"), "the panel is always present");
  });
});

test("a Discord role can be mapped to several servers, not just one", { skip: SKIP }, async () => {
  await withPage({
    overrides: { "/api/servers": THREE_SERVERS, "/api/roles": ONE_PANEL_ROLE, "/api/discord/roles": ONE_GUILD_ROLE },
  }, async (page) => {
    const base = page.url().split("#")[0];
    const state = await stubRoleMap(page);

    await page.goto(`${base}#/discord/signin`, { waitUntil: "networkidle" });
    await page.waitForSelector(".drm-row", { timeout: 10_000 });

    // Grant the panel role. It starts community-wide, which is the old behaviour and still the
    // right default — narrowing is the deliberate act.
    await page.click(".drm-row .drm-chip");
    await page.waitForSelector(".scope-chips", { timeout: 10_000 });
    const chips = await page.$$eval(".scope-chip", (els) => els.map((e) => e.textContent?.trim()));
    assert.deepEqual(chips, ["Every server", "Warfare", "Offensive", "Training"],
      "every server the community runs is offered, not a choice of one");

    // Two of the three — the case a single select could not express at all.
    await page.click(".scope-chip:has-text('Warfare')");
    await page.waitForFunction(() => window.document.querySelectorAll(".scope-chip[aria-pressed='true']").length === 1);
    await page.click(".scope-chip:has-text('Offensive')");
    await page.waitForFunction(() => window.document.querySelectorAll(".scope-chip[aria-pressed='true']").length === 2);

    const last = state.puts.at(-1);
    assert.ok(last, "the panel saved something");
    const scopes = (last.roles ?? []).map((a) => a.scopeId).sort();
    assert.deepEqual(scopes, ["s1", "s2"], `expected both servers, got ${JSON.stringify(last.roles)}`);
  });
});

test("picking every server again clears the specific ones", { skip: SKIP }, async () => {
  await withPage({
    overrides: { "/api/servers": THREE_SERVERS, "/api/roles": ONE_PANEL_ROLE, "/api/discord/roles": ONE_GUILD_ROLE },
  }, async (page) => {
    const base = page.url().split("#")[0];
    // Already scoped to one server, so the control starts narrowed and must reflect that.
    const state = await stubRoleMap(page, [
      { discordRoleId: "d-mods", discordRoleName: "Mods", roleId: "r-mod", scopeId: "s1" },
    ]);
    await page.goto(`${base}#/discord/signin`, { waitUntil: "networkidle" });
    await page.waitForSelector(".scope-chips", { timeout: 10_000 });

    const pressed = await page.$$eval(".scope-chip[aria-pressed='true']", (els) => els.map((e) => e.textContent?.trim()));
    assert.deepEqual(pressed, ["Warfare"], "the saved scope is what the control shows");

    // "Every server" is not "all of them ticked" — it must send a null scope, so a server added
    // next week is covered too rather than being silently outside the grant.
    await page.click(".scope-chip:has-text('Every server')");
    await page.waitForFunction(() => {
      const on = [...window.document.querySelectorAll(".scope-chip[aria-pressed='true']")];
      return on.length === 1 && on[0].textContent?.trim() === "Every server";
    });
    assert.deepEqual((state.puts.at(-1).roles ?? []).map((a) => a.scopeId), [null], "community-wide is a null scope");
  });
});

test("a list emptied by a filter says so and offers to clear it", { skip: SKIP }, async () => {
  // The live ban list said "No bans match your search." and stopped there — a dead end that leaves
  // you to clear the box yourself, and does not distinguish "nothing matches" from "nothing exists".
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers/s1/bans/live": { body: { bans: [
        { playerId: "76561198000000001", playerName: "Griefer", type: "temp", reason: "TK", by: "admin" },
        { playerId: "76561198000000002", playerName: "Smurf", type: "perma", reason: "cheating", by: "admin" },
      ] } },
    },
  }, async (page) => {
    await page.locator(".nav-item", { hasText: "Moderation" }).first().click();
    // The live list is read over RCON on demand, behind the Live segment.
    await page.locator(".seg-btn", { hasText: "Live" }).first().click();
    await page.waitForSelector("table");

    await page.locator("input[placeholder*=\"Search player\"]").first().fill("zzzznomatch");
    await page.waitForSelector(".empty-state");
    const text = await page.locator(".empty-state").first().innerText();
    // It distinguishes filtered-empty from genuinely empty, and says how much is hidden.
    assert.match(text, /No bans match your search/i);
    assert.match(text, /2 bans/i, `expected the hidden count, got: ${text}`);

    // And the way out is a button, not an instruction.
    const clear = page.locator(".empty-state button", { hasText: "Clear filters" });
    assert.equal(await clear.count(), 1, "filtered-empty must offer Clear filters");
    await clear.click();
    await page.waitForSelector("table");
    assert.equal(await page.locator(".empty-state").count(), 0, "clearing the filter brings the list back");
  });
});

/*
 * A laptop's window is shorter than the menu: 1366 × 768 leaves a browser about 650px. The menu
 * scrolled in place but never to the screen you were on, so arriving at Administration by address
 * or by Search left its entry and its tabs below the edge, with nothing to say where you were.
 * Larger text on a short window makes Administration with its thirteen tabs taller than the menu
 * however tightly it packs, so the open tab has to win over the entry's name.
 */
test("the menu scrolls to the screen you're on, and to its open tab, on a short window", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.setViewportSize({ width: 1366, height: 600 });
    const base = page.url().split("#")[0];
    const inMenuView = (selector) => page.evaluate((sel) => {
      const nav = window.document.querySelector(".sidebar .nav");
      const el = window.document.querySelector(`.sidebar ${sel}`);
      if (!nav || !el) return false;
      const n = nav.getBoundingClientRect(), r = el.getBoundingClientRect();
      return r.top >= n.top - 1 && r.bottom <= n.bottom + 1;
    }, selector);
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    await page.locator(".setting-card", { hasText: "Text size" }).getByRole("button", { name: "Larger" }).click();

    await page.goto(`${base}#/admin/users`, { waitUntil: "networkidle" });
    await page.waitForSelector(".nav-subitem.active");
    assert.ok(await page.locator(".sidebar .nav").evaluate((nav) => nav.scrollHeight > nav.clientHeight), "the menu is longer than the window here");
    assert.ok(await inMenuView(".nav-item.active"), "Administration is in view");
    assert.ok(await inMenuView(".nav-subitem.active"), "and so is its open tab, Users & roles");

    // A fresh load straight onto the last of the thirteen tabs. The server picker and the host
    // status arrive after the first scroll and take room from the menu: it scrolls again.
    await page.goto(`${base}#/admin/online`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".nav-subitem.active", { hasText: "Online access" }).waitFor();
    await page.locator(".server-switcher").waitFor();
    await page.locator(".host-status .hs-stat").first().waitFor();
    await page.waitForTimeout(300);
    assert.ok(await inMenuView(".nav-subitem.active"), "the open tab is in view");

    // Back to the top of the menu for a screen at the top of it.
    await page.goto(`${base}#/dashboard`, { waitUntil: "networkidle" });
    await page.locator(".nav-item.active", { hasText: "Dashboard" }).waitFor();
    assert.ok(await inMenuView(".nav-item.active"), "Dashboard is in view");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Not every screen is the window it seems: each person picks the screen the menu is packed for in
 * Settings — every common size from a small laptop's to a 4K monitor's — or leaves it on Automatic,
 * which fits the window itself. The choice is this device's alone: a laptop and a monitor want
 * different answers, so it never rides the account to the person's other devices.
 */
test("Settings offers every common screen size for the menu, smallest to largest; the pick packs it, on this device only", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    const fit = () => page.evaluate(() => window.document.querySelector(".sidebar")?.dataset.fit ?? "");
    const settled = (pred) => page.waitForFunction(`(() => { const f = window.document.querySelector(".sidebar")?.dataset.fit ?? ""; return (${pred})(f); })()`, null, { timeout: 5_000 });
    await page.setViewportSize({ width: 1366, height: 650 });
    await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
    const pick = page.getByLabel("Screen size");
    await pick.waitFor();

    const options = await pick.locator("option").allInnerTexts();
    assert.equal(options[0], "Automatic — fits this window", "Automatic first, and chosen until someone picks");
    assert.equal(await pick.inputValue(), "auto");
    const sizes = options.slice(1).map((o) => o.split(" — ")[0]);
    assert.equal(sizes.length, 13);
    assert.equal(sizes[0], "1280 × 720");
    assert.equal(sizes.at(-1), "3840 × 2160");
    const area = (t) => t.split(" × ").reduce((a, b) => Number(a) * Number(b));
    for (let i = 1; i < sizes.length; i++) assert.ok(area(sizes[i]) > area(sizes[i - 1]), `smallest to largest: ${sizes[i - 1]} then ${sizes[i]}`);
    await page.getByText("Automatic: the menu fits this window, 1366 × 650 right now.").waitFor();
    await settled(`(f) => f.includes("lines")`);

    // A 4K monitor's packing in a laptop's window: roomy, and the menu scrolls.
    await pick.selectOption("3840x2160");
    await settled(`(f) => f === ""`);
    await page.getByText("Packed for a 3840 × 2160 screen.", { exact: false }).waitFor();
    assert.ok(await page.locator(".sidebar .nav").evaluate((nav) => nav.scrollHeight > nav.clientHeight), "in a smaller window the menu scrolls");

    // A small laptop's packing in a tall window: as tight as that laptop needs.
    await page.setViewportSize({ width: 1366, height: 1300 });
    await pick.selectOption("1280x720");
    await settled(`(f) => f.includes("lines")`);
    assert.ok((await fit()).includes("tight"), "the steps before it are taken too");

    // Kept on this device across a reload — and never sent to the account.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("Screen size").waitFor();
    assert.equal(await page.getByLabel("Screen size").inputValue(), "1280x720");
    await settled(`(f) => f.includes("lines")`);
    const synced = stub.calls.filter((c) => c.path === "/api/me/prefs").map((c) => JSON.stringify(c.body ?? {}));
    assert.ok(synced.every((b) => !b.includes("screenSize")), `not on the account (${synced.join(" ")})`);

    // Back to Automatic: the tall window's own fit.
    await page.getByLabel("Screen size").selectOption("auto");
    await settled(`(f) => f === ""`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A window too short for the menu to scroll on its own — under 560px, like a big phone on its side
 * or a laptop's window with the browser's tools open — scrolls the whole sidebar as one column
 * instead. Only the menu was ever scrolled to the open screen, so there nothing was:
 * Administration's entry and its tabs sat below the edge. A phone's drawer keeps its own ways.
 */
test("on a window too short for the menu to scroll on its own, the sidebar scrolls to the open screen", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const inView = (selector) => page.evaluate((sel) => {
      const aside = window.document.querySelector(".sidebar"), el = aside?.querySelector(sel);
      if (!el) return false;
      const v = aside.getBoundingClientRect(), r = el.getBoundingClientRect();
      return r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
    }, selector);
    // A big phone on its side: wider than a phone's layout, so the sidebar sits beside the page.
    await page.setViewportSize({ width: 932, height: 430 });
    await page.goto(`${base}#/admin/users`, { waitUntil: "networkidle" });
    await page.locator(".nav-subitem.active", { hasText: "Users & roles" }).waitFor();
    await page.waitForTimeout(300);
    assert.ok(await page.locator(".sidebar").evaluate((a) => a.scrollHeight > a.clientHeight), "the sidebar scrolls as one column here");
    assert.ok(await inView(".nav-item.active"), "Administration is in view");
    assert.ok(await inView(".nav-subitem.active"), "and so is its open tab");

    // A fresh load onto the last of its tabs in a laptop's short window, which leaves it at the
    // sidebar's lower edge, and the window shortened further.
    await page.setViewportSize({ width: 1366, height: 540 });
    await page.goto(`${base}#/admin/online`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".nav-subitem.active", { hasText: "Online access" }).waitFor();
    await page.locator(".host-status .hs-stat").first().waitFor({ state: "attached" });
    await page.waitForTimeout(300);
    assert.ok(await inView(".nav-subitem.active"), "Online access is in view");
    await page.setViewportSize({ width: 1366, height: 480 });
    await page.waitForTimeout(300);
    assert.ok(await inView(".nav-subitem.active"), "and stays in view as the window shortens");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  // A phone's drawer: opening a section from it reveals the tabs under its name, and the list stays
  // where the thumb left it.
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 } }, async (page) => {
    await page.locator(".burger").click();
    const side = page.locator(".sidebar");
    const admin = page.locator(".sidebar .nav-item", { hasText: "Administration" });
    await admin.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const before = await side.evaluate((a) => a.scrollTop);
    await admin.click();
    await page.locator(".sidebar .nav-subitem", { hasText: "Online access" }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await side.evaluate((a) => a.scrollTop), before, "the drawer stays where it was");
  });
});

/*
 * However tight the menu packs, every row stays at least 24px tall — the least a finger, or an
 * unsteady hand, can be asked to hit (WCAG 2.5.8). The tightest step took the tabs listed under a
 * screen to 22px, 21 with small text.
 */
test("a tightly packed menu keeps every row at least 24px tall, at every text size", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.setViewportSize({ width: 1366, height: 650 });
    for (const size of ["Small", "Default"]) {
      await page.goto(`${base}#/settings`, { waitUntil: "networkidle" });
      await page.locator(".setting-card", { hasText: "Text size" }).getByRole("button", { name: size, exact: true }).click();
      await page.goto(`${base}#/admin/users`, { waitUntil: "networkidle" });
      await page.locator(".nav-subitem", { hasText: "Online access" }).waitFor();
      await page.waitForFunction(() => window.document.querySelector(".sidebar")?.dataset.fit?.includes("lines"), null, { timeout: 5_000 });
      const rows = await page.evaluate(() => [...window.document.querySelectorAll(".sidebar .nav-item, .sidebar .nav-subitem")]
        .filter((el) => el.offsetParent).map((el) => [el.textContent.trim(), Math.round(el.getBoundingClientRect().height * 10) / 10]));
      const short = rows.filter(([, h]) => h < 24);
      assert.ok(rows.length > 20, `the menu with Administration's tabs (${rows.length} rows)`);
      assert.deepEqual(short, [], `${size} text: rows under 24px (${short.map(([t, h]) => `${t} ${h}px`).join(", ")})`);
    }
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Search's shortcut, as this keyboard names it. The handler takes ⌘K or Ctrl K, but the hint said
 * ⌘K everywhere — a key a Windows keyboard does not have — and showed it on phones, which have no
 * keyboard to press it on.
 */
test("Search's shortcut reads Ctrl K on Windows, ⌘K on a Mac, and nothing on a phone", { skip: SKIP }, async () => {
  for (const [platform, keys] of [["Win32", "Ctrl K"], ["MacIntel", "⌘K"]]) {
    await withPage({ grants: OWNER_GRANTS }, async (page) => {
      await page.addInitScript((p) => Object.defineProperty(window.navigator, "platform", { get: () => p }), platform);
      await page.reload({ waitUntil: "networkidle" });
      const trigger = page.locator(".sidebar .cmdk-trigger");
      assert.equal(await trigger.locator("kbd").textContent(), keys, platform);
      assert.equal(await trigger.getAttribute("title"), `Search (${keys})`);
      assert.ok(await trigger.locator("kbd").isVisible(), `${platform}: shown with a keyboard`);
    });
  }
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 390, height: 844 } }, async (page) => {
    await page.locator(".burger").click();
    await page.waitForSelector(".app-shell.drawer-open");
    assert.equal(await page.locator(".sidebar .cmdk-trigger kbd").isVisible(), false, "a touch screen has no keys to press");
    await page.locator(".sidebar .cmdk-trigger").click();
    await page.locator(".cmdk-input input").waitFor();
    assert.equal(await page.locator(".cmdk-input kbd").isVisible(), false, "nor an esc key");
  });
});

/*
 * The phone's drawer is ONE list that scrolls: every destination at full height, then the host
 * status, the server picker and the account row. It used to pin that bottom section and give the
 * menu what was left — under half an upright phone — in a scroll of its own that nothing showed was
 * there, so the menu looked as if it ended a few items in (Players → Clans on an iPhone, with the
 * rest of Players, Moderation, Servers, Automation and Administration out of sight). Each way into
 * the drawer lands where it is for: the menu button at the top, the server number on the picker,
 * the round initial on the account row.
 */
test("on a phone the drawer is one list, and each way into it lands where it is for", { skip: SKIP }, async () => {
  // Numbered, as the API numbers them: the top bar's server badge shows the number.
  const servers = { body: { servers: [
    { id: "s1", name: "Test Server #1", game: "hll", engagementMode: "active", no: 1 },
    { id: "s2", name: "Vietnam", game: "hllv", engagementMode: "active", no: 2 },
  ] } };
  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 600 }]) {
    await withPage({ grants: OWNER_GRANTS, viewport, overrides: { "/api/servers": servers } }, async (page) => {
      const at = `${viewport.width}×${viewport.height}`;
      await page.goto(`${page.url().split("#")[0]}#/players/directory`, { waitUntil: "networkidle" });
      const inView = async (sel) => {
        const box = await page.locator(sel).boundingBox();
        return Boolean(box && box.y >= 0 && box.y + box.height <= viewport.height + 1);
      };
      const shut = async () => {
        await page.locator(".scrim").click({ position: { x: viewport.width - 10, y: viewport.height / 2 } });
        await page.waitForFunction(() => !window.document.querySelector(".app-shell.drawer-open"));
      };

      await page.locator(".server-badge").click();
      await page.waitForSelector(".app-shell.drawer-open");
      await page.waitForFunction(() => {
        const r = window.document.querySelector(".sidebar .server-switcher")?.getBoundingClientRect();
        return r && r.top >= 0 && r.bottom <= window.innerHeight + 1;
      });
      const m = await page.evaluate(() => {
        const nav = window.document.querySelector(".sidebar .nav");
        const side = window.document.querySelector(".sidebar");
        return { shown: nav.clientHeight, content: nav.scrollHeight, sideScrolls: side.scrollHeight > side.clientHeight };
      });
      assert.ok(m.content - m.shown <= 1, `${at}: the menu shows ${m.shown}px of its ${m.content}px in a scroll of its own`);
      assert.ok(m.sideScrolls, `${at}: the drawer itself scrolls`);
      assert.ok(await inView(".sidebar .server-switcher"), `${at}: the server number opens on the picker`);
      await shut();

      await page.locator(".topbar-account").click();
      await page.waitForSelector(".app-shell.drawer-open");
      await page.waitForFunction(() => {
        const r = window.document.querySelector(".sidebar .sidebar-footer")?.getBoundingClientRect();
        return r && r.top >= 0 && r.bottom <= window.innerHeight + 1;
      });
      await shut();

      await page.locator(".burger").click();
      await page.waitForSelector(".app-shell.drawer-open");
      await page.waitForFunction(() => window.document.querySelector(".sidebar")?.scrollTop === 0);
      assert.ok(await inView(".sidebar .brand"), `${at}: the menu button opens at the top`);
      // Everything is reachable by scrolling: the last destination in the menu.
      await page.locator(".sidebar .nav-item >> nth=-1").scrollIntoViewIfNeeded();
      assert.ok(await inView(".sidebar .nav-item >> nth=-1"), `${at}: the last destination scrolls into view`);
    });
  }
});

test("on a phone, opening a destination reveals its tabs instead of closing the drawer over them", { skip: SKIP }, async () => {
  // The drawer covers the page, so navigating dismisses it. That used to fire even when the tap
  // had just revealed a sub-nav — you saw the tabs for an instant, then had to reopen the burger
  // to reach any of them.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto(`${page.url().split("#")[0]}#/dashboard`, { waitUntil: "networkidle" });

    await page.locator(".burger").click();
    await page.waitForSelector(".app-shell.drawer-open");
    await page.locator(".nav-item", { hasText: "Administration" }).click();

    // The destination opened AND the drawer is still up, showing what the tap revealed.
    await page.waitForFunction(() => window.location.hash.startsWith("#/admin"));
    assert.equal(await page.locator(".app-shell.drawer-open").count(), 1, "drawer stays up on a destination with tabs");
    await page.waitForSelector(".nav-subnav .nav-subitem");

    // Picking one of those tabs is the navigation that dismisses it.
    await page.locator(".nav-subitem", { hasText: "RCON console" }).click();
    await page.waitForFunction(() => window.location.hash === "#/admin/console");
    await page.waitForFunction(() => !window.document.querySelector(".app-shell.drawer-open"));

    // A destination with no tabs still dismisses the drawer on the first tap.
    await page.locator(".burger").click();
    await page.waitForSelector(".app-shell.drawer-open");
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForFunction(() => !window.document.querySelector(".app-shell.drawer-open"));
  });
});

test("the match card is the map: artwork behind the whole card, a thumbnail on the current map, bars across the width", { skip: SKIP }, async () => {
  // The fixture round is SAINTE-MÈRE-ÉGLISE — accented and spelled out, the exact spelling that
  // used to resolve to no artwork at all, leaving the card a wall of text.
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/live`, { waitUntil: "networkidle" });
    await page.waitForSelector(".live-summary", { timeout: 10_000 });

    assert.equal(await page.locator(".live-summary.has-art").count(), 1, "the round's map is behind the card");
    const art = await page.evaluate(() =>
      window.getComputedStyle(window.document.querySelector(".live-summary")).getPropertyValue("--match-art"));
    assert.match(art, /stmereeglise-\w+\.webp/, `the accented name resolved to its own art, got: ${art}`);

    // The current map is identified by its picture, like the next one — it was the only map on the
    // row wearing an emoji instead.
    assert.equal(await page.locator(".lm-map img.map-thumb").count(), 1, "the current map has a thumbnail");
    assert.equal(await page.locator(".lm-next img.map-thumb").count(), 1, "the next map still has one");

    // Every stat row spans the card with a share bar per side, instead of two figures marooned at
    // the edges with the width left blank.
    const rows = await page.locator(".team-stats .ts-row").count();
    assert.ok(rows >= 4, `stat rows are present, got ${rows}`);
    assert.equal(await page.locator(".team-stats .ts-row .ts-bar").count(), rows * 2, "both sides get a bar on every row");
    const widths = await page.evaluate(() =>
      [...window.document.querySelectorAll(".team-stats .ts-row:first-child .ts-fill")].map((el) => el.style.width));
    assert.equal(widths.length, 2);
    for (const w of widths) assert.match(w, /^[\d.]+%$/, "the bars are drawn as a share, not a fixed size");
  });
});

/*
 * The staff role filter is CHROME — it narrows a list, it does not act. Filled accent buttons are
 * reserved for the one thing a panel is for (Save, Send, Apply). This shipped with the segmented
 * class on the wrapper instead of the children, so every role fell through to the default filled
 * accent style and the row read as a wall of primary call-to-actions.
 */
test("the staff role filter is a segmented control, not a row of call-to-action buttons", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/admin/activity`, { waitUntil: "networkidle" });
    await page.waitForSelector(".staff-card", { timeout: 10_000 });
    await page.click(".control-row button:has-text('Roles')");
    await page.waitForSelector(".control-row .seg .seg-btn", { timeout: 5_000 });

    // Every role chip carries the segmented class; none is left to the filled default.
    const chips = await page.$$eval(".control-row .seg .seg-btn", (els) =>
      els.map((e) => ({ text: e.textContent.trim(), cls: e.className })));
    assert.ok(chips.length >= 2, `expected the role chips, got ${JSON.stringify(chips)}`);
    assert.ok(chips.every((c) => c.cls.includes("seg-btn")), "each role is a segmented chip");
    // A role with no name still has to be pickable rather than rendering as a blank chip.
    assert.ok(chips.some((c) => c.text === "Unnamed role"), `a nameless role is labelled: ${JSON.stringify(chips)}`);

    // Picking one narrows the team, and Clear is a quiet control too.
    await page.click(".control-row .seg-btn:has-text('Owner')");
    await page.waitForFunction(() => window.document.querySelectorAll(".staff-card").length === 1);
    const clear = await page.$eval(".control-row button:has-text('Clear')", (e) => e.className);
    assert.ok(clear.includes("ghost"), `Clear is a quiet button, got "${clear}"`);
    await page.click(".control-row button:has-text('Clear')");
    await page.waitForFunction(() => window.document.querySelectorAll(".staff-card").length === 2);
  });
});

/**
 * Which server am I about to act on?
 *
 * On a phone the sidebar is a drawer, so the pinned server card — the only thing that names the
 * active server — is off screen for the whole session. The header could not stand in for it: these
 * names are the ones players see in the browser, eighty characters of "The [LYNX] Division #2 |
 * MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED, LVL 100+ COMMANDER ENFORCED", identical between servers
 * except for one digit in the middle. Nothing that fits in a header can distinguish them.
 *
 * So the header carries the server's NUMBER: position in creation order, two characters, always in
 * the same place. This checks it says the right one and follows the switch.
 *
 * The fixture is deliberately a SCOPED reader's list — two servers that are #2 and #3 of the
 * community's three, as the API reports them to somebody without access to the first. The panel
 * used to number the list it was handed, so it called these 1 and 2; the numbers a colleague used
 * for the same machines. Numbering off the API's `no` is the difference this asserts.
 */
test("the header names the active server by number, on a phone", { skip: SKIP }, async () => {
  const two = {
    "/api/servers": { body: { servers: [
      { id: "s1", no: 2, name: "The [LYNX] Division #2 | MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED", game: "hll", engagementMode: "observe" },
      { id: "s2", no: 3, name: "The [LYNX] Division #3 | MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED", game: "hll", engagementMode: "active" },
    ] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: two, viewport: { width: 390, height: 844 } }, async (page) => {
    const badge = page.locator(".server-badge");
    await badge.waitFor({ timeout: 15_000 });
    assert.equal((await badge.textContent())?.trim(), "2", "the community's number, not this list's index");
    // The full name is still reachable — the number is shorthand, not a replacement for the truth.
    assert.match(await badge.getAttribute("title") ?? "", /Division #2/);

    // Switching repaints it. The switcher lives in the drawer, which the badge itself opens.
    await badge.click();
    await page.locator(".server-switcher select").selectOption("s2");
    await page.waitForFunction(() => window.document.querySelector(".server-badge")?.textContent?.trim() === "3", null, { timeout: 10_000 });
    assert.match(await badge.getAttribute("title") ?? "", /Division #3/);
    // Active mode is the one worth noticing, and the badge says so without a word.
    assert.ok((await badge.getAttribute("class"))?.includes("on"), "an active server's badge is not the quiet variant");

    // The picker teaches the numbering, or the badge is a code with no key.
    const options = await page.locator(".server-switcher select option").allTextContents();
    assert.deepEqual(options.map((t) => t.slice(0, 3)), ["2 ·", "3 ·"]);
  });
});

test("'everywhere but' bans the rest and shows the exception struck through", { skip: SKIP }, async () => {
  // The mode staff asked for, and the one that only makes sense as a rule: "banned from the
  // community, except the server they help run". Ticking the other servers by hand would say
  // something subtly different — that a server added later is NOT covered.
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
    await page.waitForSelector(".pa-modal .scope-pick");

    await page.locator(".scope-pick .seg-btn", { hasText: "Everywhere but" }).click();
    // The mode starts from no exceptions rather than inheriting the tick from "Only these" — a
    // chip means the opposite in each mode, so carrying it would invert what the user had said.
    assert.equal(await page.locator(".scope-chip.off").count(), 0, "no exceptions to begin with");
    // A ticked chip means the opposite here, so it must not look the same: `.off`, struck through.
    await page.locator(".scope-chip").nth(1).click();
    assert.equal(await page.locator(".scope-chip.off").count(), 1, "the exception reads as excluded");
    assert.equal(await page.locator(".scope-chip.on").count(), 0, "and never as selected");

    await page.locator(".pa-fields input").first().fill("cheating");
    await page.locator(".pa-actions button:not(.ghost)").click();
    await page.waitForFunction(() => !window.document.querySelector(".pa-modal"), null, { timeout: 10_000 });
    assert.deepEqual(posted[0].scope, { mode: "except", serverIds: ["s2"] });
  });
});

test("the ban's server picker never offers a server running a different game", { skip: SKIP }, async () => {
  // Player ids do not cross games (HLL: Vietnam keys everyone by its own per-game EOS id), so a
  // server running another game is not a place this ban CAN land. Offering it would invite a tick
  // that the API refuses — or worse, a staff member believing the player is banned there.
  const overrides = {
    ...TWO_SERVERS,
    "/api/servers": { body: { servers: [
      { id: "s1", name: "The [LYNX] Division #1", game: "hll", engagementMode: "active" },
      { id: "s2", name: "The [LYNX] Division #2", game: "hll", engagementMode: "active" },
      { id: "s3", name: "The [LYNX] Division Vietnam", game: "hllv", engagementMode: "active" },
    ] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".player-actions", { timeout: 15_000 });
    await page.locator(".scoreboard tbody tr").first().locator(".pa-menu button").click();
    await page.locator(".pa-mi", { hasText: "Perma ban" }).click();
    await page.waitForSelector(".pa-modal .scope-pick");
    // Two chips, not three: the hll servers only. The hllv server is not a smaller option — it
    // is a place where this player id does not exist.
    assert.equal(await page.locator(".scope-pick .scope-chip").count(), 2, "only same-game servers are offered");
  });
});

test("a remembered team filter cannot empty a side of the split", { skip: SKIP }, async () => {
  // The regression staff hit: the team filter is persisted (right for the ranked table), and the
  // split honoured it — so anyone who had ever tapped a team chip opened the two-team view and
  // found one pane reading "Nobody on this side" about a team that was on the server, with the
  // chips scrolled off the top of a phone as the only clue.
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });

    // Filter to one team in the table — the state that used to poison the split.
    await page.locator(".team-filter button", { hasText: "Axis" }).first().click();
    await page.waitForFunction(() => window.document.querySelectorAll(".scoreboard tbody tr").length === 1, null, { timeout: 5_000 });

    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.waitForSelector(".team-split");
    const sides = page.locator(".team-side");
    assert.equal(await sides.count(), 2, "both panes are present");
    assert.match((await sides.nth(0).textContent()) ?? "", /Griefer/, "the filtered-out side still has its players");
    assert.match((await sides.nth(1).textContent()) ?? "", /Jerry/);
    assert.equal(await page.locator(".team-split-empty").count(), 0, "neither side claims to be empty");
    // And the chips are gone while they govern nothing.
    assert.equal(await page.locator(".team-filter").count(), 0, "the team chips are hidden in the split");

    // The filter is still remembered for the table it belongs to.
    await page.locator(".seg-btn", { hasText: "Table" }).first().click();
    await page.waitForSelector(".scoreboard tbody tr");
    assert.equal(await page.locator(".scoreboard tbody tr").count(), 1, "the table keeps the filter it was given");
  });
});

test("the locked table calls out a squad with no leader", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: TK_ROSTER }, async (page) => {
    await page.locator(".nav-item", { hasText: "Live" }).first().click();
    await page.waitForSelector(".scoreboard tbody tr", { timeout: 15_000 });
    await page.locator(".seg-btn", { hasText: "Teams" }).first().click();
    await page.waitForSelector(".team-split");
    // BAKER, on the axis side, has nobody in a leader role.
    await page.locator(".team-side-head").nth(1).click();
    await page.waitForSelector(".locked-head");
    assert.equal(await page.locator(".scoreboard tr.squad-head .nosl").count(), 1, "BAKER is flagged");
  });
});

/*
 * A backend hiccup is not a sign-out.
 *
 * Boot used to clear the stored token on ANY failure of /api/me — so a 500 from a slow query, a
 * Cloudflare 502, or the API restarting logged out every staff member with the panel open, and the
 * sign-in screen was the only explanation they got. It reads as "my account stopped working", and
 * for a Discord-only account getting back in means the whole OAuth round trip again.
 *
 * Only the server saying the credential is bad (401) may end a session. Everything else keeps the
 * token and says what actually happened.
 */
test("a failing panel does not sign you out; an expired session does", { skip: SKIP }, async () => {
  const token = () => window.localStorage.getItem("panel.token");

  // The API is having a moment: the session survives and the panel says so.
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": { status: 503, body: { error: { message: "database is starting up" } } } } }, async (page) => {
    await page.locator(".auth-card h1", { hasText: "Can't load the panel" }).waitFor({ timeout: 15_000 });
    assert.match(await page.locator(".auth-card").textContent(), /database is starting up/, "it repeats what the server said, not a generic failure");
    assert.match(await page.locator(".auth-card").textContent(), /still signed in/, "and says the session is intact");
    assert.equal(await page.evaluate(token), "test-token", "the token is NOT thrown away for a server-side failure");
    assert.equal(await page.locator("form input[autocomplete='username']").count(), 0, "no sign-in form — they are not signed out");
  });

  // The credential really is bad: that IS a sign-out, and the token goes.
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": { status: 401, body: { error: { message: "unauthorized" } } } } }, async (page) => {
    await page.locator("form input[autocomplete='username']").waitFor({ timeout: 15_000 });
    assert.equal(await page.evaluate(token), null, "a 401 clears the token");
  });
});

/*
 * The rebuilt Data trim page: one switch row per trimmable type, catalog-driven, with "Check
 * sizes" putting a count on EVERY row — the number beside a toggle is what the decision is
 * about, so it cannot depend on the toggle already being on.
 */
test("data trim: catalog rows are switches, counts land on every row, selection arms the button", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/trim`, { waitUntil: "networkidle" });
    // networkidle does not mean rendered: under full-suite load the catalog rows can paint after
    // the navigation settles, and counting them before the first exists reads 0. Wait like every
    // other block here does.
    await page.locator(".trim-row").first().waitFor({ timeout: 15_000 });

    // Every type the catalog serves is a switch row — categories and datasets alike.
    for (const label of ["Kills", "Chat", "Roster snapshots", "Staff activity"]) {
      assert.equal(await page.locator(".trim-row", { hasText: label }).count(), 1, `a switch row for ${label}`);
    }

    // Nothing selected yet: the destructive button is dead, and no counts are claimed.
    const trimBtn = page.locator("button.danger", { hasText: "Trim" });
    assert.equal(await trimBtn.isDisabled(), true, "no selection, no trim");
    assert.equal(await page.locator(".trim-row .badge").count(), 0, "no counts before Check sizes");

    // Check sizes: every row gets ITS number (the stub's counts are all distinct on purpose).
    await page.locator("button", { hasText: "Check sizes" }).click();
    await page.locator(".trim-row .badge").first().waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".trim-row .badge").count(), 4, "every row shows a count, selected or not");
    for (const [label, count] of [["Kills", "41"], ["Chat", "5"], ["Roster snapshots", "1,440"], ["Staff activity", "12"]]) {
      assert.equal(await page.locator(".trim-row", { hasText: label }).locator(".badge").textContent(), count, `${label} wears its own number`);
    }

    // Selecting rows arms the button with the sum of exactly the selected counts.
    await page.locator(".trim-row", { hasText: "Roster snapshots" }).locator(".toggle").click();
    assert.equal(await trimBtn.isDisabled(), false);
    assert.match(await trimBtn.textContent(), /1,440/, "the button quotes the selected rows' total");
    await page.locator(".trim-row", { hasText: "Kills" }).locator(".toggle").click();
    assert.match(await trimBtn.textContent(), /1,481/, "two selections, one summed total");

    // Changing the cutoff makes the on-screen counts stale — they vanish rather than lie.
    await page.locator(".trim-cutoff button", { hasText: "30d" }).click();
    assert.equal(await page.locator(".trim-row .badge").count(), 0, "counts for the old cutoff are not shown against the new one");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The Backup tab: catalog-driven switch rows for whole-database export, where selecting a group
 * DRAGS ITS DEPENDENCIES IN — an archive of VIPs without the players and servers they reference
 * would import as a page of refusals, so the panel refuses to let that selection exist.
 */
test("backup: group rows render, selecting a group auto-selects what it needs, sizes land per row", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/backup`, { waitUntil: "networkidle" });
    // A hash change is a same-document navigation: goto resolves before the catalog fetch, so
    // wait for the first row rather than asserting into a still-loading screen.
    await page.locator(".trim-row").first().waitFor({ timeout: 15_000 });

    for (const label of ["Server connections", "Players & careers", "VIP & console admins", "Staff activity"]) {
      assert.equal(await page.locator(".trim-row", { hasText: label }).count(), 1, `a switch row for ${label}`);
    }

    // Nothing selected: export is dead.
    const exportBtn = page.locator("button.primary", { hasText: "Export" });
    assert.equal(await exportBtn.isDisabled(), true, "no selection, no export");

    // Selecting VIP pulls players and servers in with it (vip → players → servers).
    await page.locator(".trim-row", { hasText: "VIP & console admins" }).locator(".toggle").click();
    for (const label of ["VIP & console admins", "Players & careers", "Server connections"]) {
      assert.ok((await page.locator(".trim-row.on", { hasText: label }).count()) === 1, `${label} is selected`);
    }
    assert.equal(await page.locator(".trim-row.on", { hasText: "Staff activity" }).count(), 0, "unrelated groups stay off");
    assert.equal(await exportBtn.isDisabled(), false);

    // Deselecting the dependent leaves its dependencies selected — they may be wanted alone.
    await page.locator(".trim-row", { hasText: "VIP & console admins" }).locator(".toggle").click();
    assert.equal(await page.locator(".trim-row.on", { hasText: "Server connections" }).count(), 1);

    // Check sizes: every row wears its own count (stub counts are all distinct).
    await page.locator("button", { hasText: "Check sizes" }).click();
    await page.locator(".trim-row .badge").first().waitFor({ timeout: 15_000 });
    for (const [label, count] of [["Server connections", "2"], ["Players & careers", "51,877"], ["VIP & console admins", "143"], ["Staff activity", "9,210"]]) {
      assert.equal(await page.locator(".trim-row", { hasText: label }).locator(".badge").textContent(), count, `${label} wears its own number`);
    }

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("pull to refresh: a pull at the top re-fetches the screen", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: PHONE }, async (page, { stub, errors }) => {
    await page.waitForTimeout(200);
    const before = apiCalls(stub);

    let armedDuringDrag = false;
    // Far enough past the trigger that resistance cannot leave it short.
    await touchDrag(page, 200, 120, 420, {
      atFullPull: async () => { armedDuringDrag = (await page.locator(".ptr.on.armed").count()) > 0; },
    });
    assert.ok(armedDuringDrag, "the dial is up and armed while the finger is down");

    await page.waitForTimeout(600);
    assert.ok(apiCalls(stub) > before, `the screen re-fetched (${before} → ${apiCalls(stub)} calls)`);
    // And it puts itself away again rather than sitting there.
    await page.waitForFunction(() => !window.document.querySelector(".ptr.busy"), null, { timeout: 5000 });
    assert.equal(await page.locator(".ptr.on").count(), 0, "the dial parks itself when the data lands");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("pull to refresh: a short tug is not a refresh", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: PHONE }, async (page, { stub }) => {
    await page.waitForTimeout(200);
    const before = apiCalls(stub);
    // ~30px of finger travel is ~15px of dial against a 64px trigger: an accidental brush.
    await touchDrag(page, 200, 120, 150);
    await page.waitForTimeout(500);
    assert.equal(apiCalls(stub), before, "a tug under the threshold fetched nothing");
    assert.equal(await page.locator(".ptr.on").count(), 0, "and left no indicator behind");
  });
});

test("pull to refresh: a drag inside a scroller of its own is left alone", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: PHONE }, async (page, { stub }) => {
    // A list that scrolls on its own — a roster table, the command palette, an open modal. Dragging
    // down inside one of these is that list being scrolled back up, never a page refresh.
    await page.evaluate(() => {
      const box = window.document.createElement("div");
      box.id = "own-scroller";
      box.style.cssText = "position:fixed;top:100px;left:0;right:0;height:300px;overflow-y:auto;z-index:200;background:#111";
      box.innerHTML = "<div style='height:2000px'>tall</div>";
      window.document.body.appendChild(box);
      box.scrollTop = 0; // at ITS top, so only the page-level guard can tell the two apart
    });
    await page.waitForTimeout(100);
    const before = apiCalls(stub);
    await touchDrag(page, 200, 150, 420);
    await page.waitForTimeout(500);
    assert.equal(apiCalls(stub), before, "the page did not refresh out from under the list");
    assert.equal(await page.locator(".ptr.on").count(), 0, "and no indicator appeared");
  });
});

/*
 * System's Automated activity is the staff statistics' read, which answers to Staff profiles. It
 * asked whoever could open System — the trail's permission — and hid itself on any failure, so a
 * read that broke looked the same as a permission nobody holds.
 */
test("System's automated activity asks only with Staff profiles, and says when its read fails", { skip: SKIP }, async () => {
  const trailOnly = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "audit.trail", scopeType: "global", scopeId: null, level: "read" },
  ];
  await withPage({ grants: trailOnly }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/system`, { waitUntil: "networkidle" });
    await page.locator(".panel-title", { hasText: "Services" }).waitFor({ timeout: 10_000 });
    assert.ok(!stub.calls.some((c) => c.path === "/api/audit/staff"), "nothing it would be refused");
    assert.equal(await page.locator(".panel-title", { hasText: "Automated activity" }).count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/audit/staff": { status: 500, body: { error: "the database is not answering" } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/system`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the automated activity").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Loaded plugins lists an unlisted plugin only to someone the API names it to (one who may open one
 * of its pages), and then by its name alone: its id is not shown, and the row says who sees it.
 */
test("System: an unlisted plugin is shown by its name, with who sees it", { skip: SKIP }, async () => {
  const plugins = [
    { id: "probe", name: "Probe", version: "1.0.0", apiVersion: 1, capabilities: ["api:routes"] },
    { id: "quiet-one", name: "Quiet", version: "2.0.0", apiVersion: 1, capabilities: ["ui:page"], unlisted: true },
  ];
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/plugins": { body: { plugins } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/system`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Loaded plugins/ }) });
    const names = panel.locator("tbody tr td:first-child");
    await names.first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await names.allInnerTexts(), ["Probe probe", "Quiet listed only for those who may open it"]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Four more reads that went quiet when they failed: the message presets ("No presets saved yet" to
 * a manager, nothing at all to anyone else), the saved rotations on Maps (an empty picker) and on a
 * scheduled event (the field left out), and a profile's groups (no chips, read as "in no groups").
 */
test("presets, saved rotations and a profile's groups say when they couldn't be read", { skip: SKIP }, async () => {
  const down = { status: 500, body: { error: "the database is not answering" } };
  const profile = { body: {
    player: { id: "p1", platformId: "76561198000000001", platform: "steam", name: "Subject", firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
    stats: { kills: 1, deaths: 1, teamkills: 0, playtimeSec: 60, visits: 1 },
    flags: {}, recentEvents: [], sessions: [], aliases: [], matches: [], canViewNotes: false, notes: [],
  } };
  const overrides = {
    // Run, not observed: the rotation editor is offered only for a server the panel acts on.
    "/api/servers": { body: { servers: [{ id: "s1", name: "Test Server #1", game: "hll", engagementMode: "active" }] } },
    "/api/templates": down,
    "/api/servers/s1/maprotation/sets": down,
    "/api/players/p1": profile,
    "/api/player-groups/for/76561198000000001": down,
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/moderation/messages`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the presets").first().waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No presets saved yet").count(), 0);

    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the saved rotations").waitFor({ timeout: 10_000 });

    await page.goto(`${base}#/events/schedule`, { waitUntil: "networkidle" });
    await page.locator("label", { hasText: /^Server/ }).locator("select").selectOption("s1");
    await page.getByText("Rotation when the event starts: couldn't read the saved rotations").waitFor({ timeout: 10_000 });

    await page.goto(`${base}#/players/~p1`, { waitUntil: "networkidle" });
    await page.getByText("Couldn't read the player's groups").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/* "Build a request" did nothing at all when the request couldn't be started. */
test("Build a request says when the request couldn't be started", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/requests/draft": (url, req) => (req.method === "POST" ? { status: 500, body: { error: "the database is not answering" } } : undefined),
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/moderation/requests`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Build a request" }).click();
    await page.getByText("Couldn't start a request").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The Discord match board drew its form over the defaults while its settings were unread, and kept
 * it when the read failed: one edit there, and Save wrote all four settings over the real ones.
 */
test("the match board offers no form until its settings are read", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers/s1/discord": (url, req) => (req.method === "GET" ? { status: 500, body: { error: "the database is not answering" } } : undefined),
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/discord/relay`, { waitUntil: "networkidle" });
    const board = page.locator(".panel", { hasText: "Live match board" });
    await board.getByText("Couldn't read the match board").waitFor({ timeout: 10_000 });
    assert.equal(await board.locator("input").count(), 0, "no fields to fill");
    assert.equal(await board.getByRole("button", { name: "Save" }).count(), 0, "nothing to save");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A live board the server couldn't work out comes back empty (a null result, as CRCON's does with
 * nothing in its cache). The page took that for one on its way and said "Loading…" for as long as
 * it lasted.
 */
test("public site: a live board that couldn't be worked out says so, not Loading…", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_live_game_stats": { body: { result: null, failed: false } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "load" });
    await page.getByText("Live stats are unavailable right now").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The stats site put the server's own error text in front of visitors: "No map for this ID" for a
 * round not on record, "rate limited" over past games, and "[object Object]" for a game log whose
 * read failed in the API's error handler.
 */
test("public site: a round, the past games and a game log that can't be shown say so in plain words", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [PUB_ALPHA] } },
    "/stats/alpha/api/get_map_scoreboard": (url) => ({ body: { result: null, failed: true, error: url.searchParams.get("map_id") === "41" ? "No map for this ID" : "command failed" } }),
    "/stats/alpha/api/get_scoreboard_maps": { body: { result: null, failed: true, error: "rate limited" } },
    "/api/public/alpha/log/42": { status: 500, body: { error: { code: "internal", message: "boom" } } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/games/41`, { waitUntil: "networkidle" });
    await page.getByText("This round isn't on record.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("No map for this ID").count(), 0);
    await page.goto(`${stub.base}/stats/alpha/games/42`, { waitUntil: "networkidle" });
    await page.getByText("This round is unavailable right now.").waitFor({ timeout: 10_000 });
    await page.goto(`${stub.base}/stats/alpha/games/42/log`, { waitUntil: "networkidle" });
    await page.getByText("The game log is unavailable right now.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("[object Object]").count(), 0);
    await page.goto(`${stub.base}/stats/alpha/games`, { waitUntil: "networkidle" });
    await page.getByText("Past games are unavailable right now.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("rate limited").count(), 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A game log line on the stats site would not break a long name: on a phone the line ran past the
 * card's edge, cutting off the name and the weapon after it.
 */
test("public site: a long name in a game log line wraps on a phone", { skip: SKIP }, async () => {
  const long = "ThisIsAVeryLongPlayerNameThatGoesOnAndOnAndOn";
  const log = { start: "2026-10-20T10:00:00.000Z", end: "2026-10-20T11:00:00.000Z", truncated: false, lines: [
    { t: 0, kind: "evt.match.started" },
    { t: 60, kind: "evt.kill", who: long, whom: "Smith", weapon: "M1 GARAND" },
    { t: 3600, kind: "evt.match.ended" },
  ] };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [PUB_ALPHA] } },
    "/api/public/alpha/log/42": { body: { log } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/games/42/log`, { waitUntil: "networkidle" });
    const line = page.locator(".log-row", { hasText: "M1 GARAND" });
    await line.waitFor({ timeout: 10_000 });
    assert.ok((await rightEdge(line.getByText(long))) <= 360, `the name ends at ${await rightEdge(line.getByText(long))}px`);
    assert.ok((await rightEdge(line.getByText("M1 GARAND", { exact: false }))) <= 360, "and the weapon after it");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The server stats page's regulars tables would not break a name: one long one widened the table
 * past a phone's edge and took the hours (or kills) column off the screen for every row.
 */
test("public site: a long name among the regulars keeps every figure on a phone screen", { skip: SKIP }, async () => {
  const long = "ThisIsAVeryLongPlayerNameThatGoesOnAndOnAndOn";
  const stats = {
    scannedMatches: 3, truncated: false,
    overview: { matches: 3, avgMinutes: 90, alliesWins: 2, axisWins: 1, attackersWinPct: null },
    maps: [], quality: { contested: 0, decisive: 0, stomp: 0, crash: 0, other: 0, scored: 0 },
    activity: [], seeding: null,
    records: { kills: [], combat: [], support: [] },
    regulars: { playtime: [{ name: "Smith", hours: 41 }, { name: long, hours: 37 }], kills: [] },
    classRecords: [], weaponRecords: [],
  };
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [PUB_ALPHA] } },
    "/api/public/alpha/stats": { body: { stats } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/server`, { waitUntil: "networkidle" });
    const table = page.locator("table.mini-table", { hasText: "Smith" });
    await table.waitFor({ timeout: 10_000 });
    for (const figure of ["41h", "37h"]) assert.ok((await rightEdge(table.getByText(figure))) <= 360, `${figure} ends at ${await rightEdge(table.getByText(figure))}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The group grant's comment box held a 220px minimum beside its words, and on a phone it ran past
 * the panel's edge.
 */
test("a group grant's comment box fits a phone", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, viewport: { width: 360, height: 780 }, overrides: {
    "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 0, createdByName: "owner", vipPerk: null }] } },
    "/api/player-groups/g1": { body: { members: [] } },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/players/groups`, { waitUntil: "networkidle" });
    const box = page.getByPlaceholder("who paid, what for, or which event");
    await box.waitFor({ timeout: 10_000 });
    const panelRight = await rightEdge(page.locator(".panel", { has: box }));
    assert.ok((await rightEdge(box)) <= panelRight, `the box ends at ${await rightEdge(box)}px, the panel at ${panelRight}px`);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/* The career page drew a reply without its player as it came, and the whole stats site went blank. */
test("public career page: a reply with nothing in it says the career is unavailable", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [{ ...PUB_ALPHA, playerIds: true }] } },
    "/api/public/alpha/player/76561198000000001": { body: {} },
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/stats/alpha/player/76561198000000001`, { waitUntil: "networkidle" });
    await page.getByText("This player's career is unavailable right now.").waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("rules: sections sort the list, each with its own pinned-elsewhere toggle — View all is the old list, and Select files rules in one move", { skip: SKIP }, async () => {
  const rule = (id, name, serverId, sectionId = null) => ({
    id, name, serverId, sectionId, enabled: true, eventKind: "evt.teamkill", match: null, threshold: 1,
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
      "/api/enforcer/rules": { body: {
        sections: [{ id: "sec1", name: "Player level rules" }],
        rules: [
          rule("r1", "minimum level here", "s1", "sec1"),
          rule("r2", "minimum level elsewhere", "s2", "sec1"),
          rule("r3", "tk policy unfiled", null),
        ],
        activity: {},
      } },
      "/api/enforcer/sections/assign": { body: { moved: 1, sectionId: "sec1" } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector("text=Player level rules");
    await page.waitForSelector("text=minimum level here");
    assert.ok(await page.locator("text=Other rules").count() >= 1, "rules in no section have a home of their own");
    assert.equal(await page.locator("text=minimum level elsewhere").count(), 0, "the section shows this server's rules");

    // The section's own button shows the rest of the section, not every other server's rule.
    await page.click('button:has-text("Show 1 rule pinned to other servers")');
    await page.waitForSelector("text=minimum level elsewhere");

    // View all: the single list, as before sections.
    await page.click('button:has-text("View all")');
    await page.waitForFunction(() => !window.document.body.innerText.includes("Other rules"));
    assert.equal(await page.locator("text=tk policy unfiled").count(), 1);
    await page.click('button:has-text("Show by section")');
    await page.waitForSelector("text=Other rules");

    // Select a rule anywhere, move it, and the move is one request naming the rules and the section.
    await page.click('button:has-text("Select rules")');
    await page.check('input[aria-label="Select tk policy unfiled"]');
    await page.waitForSelector("text=1 selected");
    await page.click('.rule-select-bar button:has-text("Move")');
    await page.waitForFunction(() => !window.document.querySelector(".rule-select-bar"));
    const move = stub.calls.find((c) => c.method === "POST" && c.path === "/api/enforcer/sections/assign");
    assert.deepEqual(move?.body, { ruleIds: ["r3"], sectionId: "sec1" });
  });
});

test("rules: a rule that would punish the same event twice is asked about before it is saved — and before it is switched on", { skip: SKIP }, async () => {
  const rule = (id, name, over = {}) => ({
    id, name, serverId: null, sectionId: null, enabled: true, eventKind: "evt.teamkill", match: null, threshold: 1,
    windowSec: 0, action: "kick", reason: null, hours: null, delaySec: 0, vipMinutes: 10,
    vipCooldownMinutes: 60, requireRoleIds: [], ...over,
  });
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: {
        sections: [],
        rules: [rule("r1", "TK kick"), rule("r2", "TK warning", { action: "message", enabled: false })],
        activity: {}, now: new Date().toISOString(),
      } },
      "/api/enforcer/rules/r2": { body: { rule: rule("r2", "TK warning", { action: "message" }) } },
    },
  }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.waitForSelector("text=TK kick");
    // A new rule: team kill → kick, the same as "TK kick". Saving asks first; Cancel saves nothing.
    await page.click('button:has-text("New rule")');
    const form = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: /^New rule/ }) });
    await form.locator('label:has-text("Name") input').first().fill("TK ban");
    await form.locator('button:has-text("Create rule")').click();
    await page.waitForSelector(".confirm-modal");
    assert.match(await page.locator(".confirm-modal").innerText(), /“TK kick” also kicks the player for the same event — they would be punished twice/);
    await page.locator(".confirm-modal button", { hasText: /^Cancel$/ }).click();
    assert.equal(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/enforcer/rules").length, 0, "nothing saved");
    await form.locator('button:has-text("Create rule")').click();
    await page.locator(".confirm-modal button", { hasText: /^Save anyway$/ }).click();
    await page.waitForFunction(() => !window.document.querySelector(".confirm-modal"));
    assert.equal(stub.calls.filter((c) => c.method === "POST" && c.path === "/api/enforcer/rules").length, 1, "saved once told");

    // Switching on a rule that only warns for what another kicks for asks too.
    await page.locator(".subcard", { hasText: "TK warning" }).locator('button:has-text("Enable")').click();
    await page.waitForSelector(".confirm-modal");
    assert.match(await page.locator(".confirm-modal").innerText(), /“TK kick” kicks the player for the same event while this rule only messages them/);
    await page.locator(".confirm-modal button", { hasText: /^Enable anyway$/ }).click();
    await page.waitForFunction(() => !window.document.querySelector(".confirm-modal"));
    assert.ok(stub.calls.some((c) => c.method === "PATCH" && c.path === "/api/enforcer/rules/r2"));
  });
});

test("chat filter: a managed rule held by its section or paused is named as such, with where to undo it", { skip: SKIP }, async () => {
  const config = { enabled: true, words: ["slur"], action: "punish", hours: null, reason: "", censor: false, censorApplied: {}, teamRuleId: "t1", unitRuleId: "u1" };
  const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/chat-filter": { body: { config, censorResults: [], rules: {
        team: { id: "t1", enabled: true, sectionOff: true, pausedUntil: null },
        unit: { id: "u1", enabled: true, sectionOff: false, pausedUntil: until },
      } } },
    },
  }, async (page) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/chatfilter`, { waitUntil: "networkidle" });
    const warn = page.locator(".callout", { hasText: "Not acting on" });
    await warn.waitFor();
    const text = await warn.innerText();
    assert.match(text, /Not acting on team or unit chat right now/, "its own switch is on, and still nothing acts");
    assert.match(text, /team chat is filed in a section that is switched off under Rules — switch that section back on there/);
    assert.match(text, /unit chat is paused until .* it comes back on its own then, or Resume it under Rules/);
    assert.doesNotMatch(text, /Press Save/, "a save lifts neither, so it is not offered as the fix");
  });
});

/*
 * The schedule trigger in the Rules editor: a group, a calendar, and the four things it may do to
 * the group's timed VIP. Everything per-player or on-server is gone, and the read-back sentence
 * says when, what and to whom.
 */
test("rules: a schedule picks a group and a calendar, offers only the group VIP actions, and reads back in words", { skip: SKIP }, async () => {
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/enforcer/rules": { body: { rules: [], activity: {} } },
      "/api/player-groups": { body: { groups: [{ id: "g1", name: "WW2 CVC", description: null, memberCount: 3, createdByName: "owner", vipPerk: null }] } },
      "/api/app-config": { body: { config: { timezone: "America/New_York" } } },
    },
  }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/rules`, { waitUntil: "networkidle" });
    await page.click('button:has-text("New rule")');
    await page.selectOption('label:has-text("On event") select', "app.schedule");
    await page.locator('select:has(option[value="g1"])').selectOption("g1");
    await page.locator('label:has-text("Repeat") select').selectOption("nth");
    await page.locator('label:has-text("Which") select').first().selectOption("1");
    await page.locator('label:has-text("Which") select').nth(1).selectOption("sat");
    await page.locator('input[type="time"]').fill("18:00");
    await page.waitForSelector("text=At (America/New_York)");
    const actions = await page.locator('label:has-text("Action") select option').evaluateAll((os) => os.map((o) => o.value));
    assert.deepEqual(actions, ["vip", "viprevoke", "viptrim", "vipreduce"]);
    for (const gone of ["Wait before acting", "Threshold (matches)", "Only act on players tagged", "Active from (players", "Safety limit", "Message after granting"]) {
      assert.equal(await page.locator(`text=${gone}`).count(), 0, `"${gone}" has no place in a schedule`);
    }
    await page.locator('label:has-text("Applies to") select').selectOption("");
    await page.waitForFunction(() => /On the first Saturday of every month at 18:00 → grant 30 days of VIP \(stacked\) to every member of group “WW2 CVC” on every server of their game/.test(window.document.body.innerText), null, { timeout: 5_000 });
    // Cutting back takes a span; taking away takes none.
    await page.selectOption('label:has-text("Action") select', "viptrim");
    await page.waitForSelector("text=Cut back to (at most)");
    await page.selectOption('label:has-text("Action") select', "viprevoke");
    assert.equal(await page.locator("text=Cut back to (at most)").count(), 0);
    await page.waitForFunction(() => /take timed VIP away from every member of group “WW2 CVC”/.test(window.document.body.innerText), null, { timeout: 5_000 });
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * One line told every panel on the Backup screen what the last action said: the same words showed
 * twice, in Full backup and in Export, and never in Import, where an archive is uploaded.
 */
test("Backup: what an action says shows once, in the panel it was taken in", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/data/options": { body: { supported: true, groups: [{ id: "players", label: "Players", hint: "every player" }] } },
    "/api/data/backups": { body: { backups: [] } },
    "/api/data/status": { body: { run: { status: "idle" }, upload: null } },
    "/api/data/upload": (url, req) => (req.method === "POST" ? { body: { bytes: 4 } } : undefined),
    "/api/data/backup": (url, req) => (req.method === "POST" ? { status: 500, body: { error: { code: "internal", message: "The backups folder is full." } } } : undefined),
  } }, async (page, { stub, errors }) => {
    const panel = (title) => page.locator("section.panel", { has: page.locator(".panel-title", { hasText: title }) });
    await page.goto(`${stub.base}/#/admin/backup`, { waitUntil: "networkidle" });
    await panel("Import").locator('input[type="file"]').setInputFiles({ name: "data-export.ndjson.gz", mimeType: "application/gzip", buffer: Buffer.from([0x1f, 0x8b, 0, 0]) });
    await panel("Import").getByText("Archive uploaded. Review, then import.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("Archive uploaded").count(), 1, "said once, in Import");

    await panel("Full backup").locator("button", { hasText: "Create full backup now" }).click();
    await panel("Full backup").getByText("The backups folder is full.").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText("The backups folder is full.").count(), 1, "said once, in Full backup");
    assert.equal(await page.getByText("Archive uploaded").count(), 0, "in place of what the upload said");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A run outlives the screen it was started from. Opened again while one was still going, the
 * Backup screen read it once and froze there, every button held, until the page was reloaded;
 * and the screen that was left went on asking after the run with nobody looking.
 */
test("Backup: a run still going is followed to its end, and a screen that was left stops asking", { skip: SKIP }, async () => {
  let reads = 0;
  const running = { run: { status: "running", kind: "backup", rows: 10 }, upload: null };
  const file = { name: "full-backup-20261025-120000.ndjson.gz", createdAt: "2026-10-25T12:00:00.000Z", bytes: 4096 };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/data/options": { body: { supported: true, groups: [] } },
    "/api/data/status": () => ({ body: ++reads <= 2 ? running : { run: { status: "done", kind: "backup", rows: 50 }, upload: null } }),
    "/api/data/backups": () => ({ body: { backups: reads > 2 ? [file] : [] } }),
  } }, async (page, { stub, errors }) => {
    await page.goto(`${stub.base}/#/admin/backup`, { waitUntil: "networkidle" });
    await page.getByText("Backing up… 10 row(s)").waitFor({ timeout: 10_000 });
    // Without a reload: it says it finished, its button is back and the new file is listed.
    await page.getByText("Full backup finished: 50 row(s).").waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole("button", { name: "Create full backup now" }).isEnabled(), true);
    await page.getByText(file.name).waitFor();
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // Started here and left while it runs: the screen that was left stops asking after it.
  let started = false;
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/data/options": { body: { supported: true, groups: [] } },
    "/api/data/status": () => ({ body: started ? running : { run: { status: "idle" }, upload: null } }),
    "/api/data/backups": { body: { backups: [] } },
    "/api/data/backup": (url, req) => (req.method === "POST" ? ((started = true), { body: { started: true } }) : undefined),
  } }, async (page, { stub }) => {
    await page.goto(`${stub.base}/#/admin/backup`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Create full backup now" }).click();
    await page.getByText("Backing up… 10 row(s)").waitFor({ timeout: 10_000 });
    await page.goto(`${stub.base}/#/settings`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const asked = () => stub.calls.filter((c) => c.path === "/api/data/status").length;
    const before = asked();
    await page.waitForTimeout(3500);
    assert.equal(asked(), before, "nobody is looking: the run is not asked after");
  });
});

/*
 * An answer missing its fields is what an endpoint gives before its feature has any data. These
 * screens crashed on one (their error card said they could not be shown), unseen by the route
 * sweeps until those read that card: the stand-in answers these endpoints with fixtures.
 */
test("Economy, Maps, Data trim and Backup survive answers missing their fields", { skip: SKIP }, async () => {
  const empty = { body: {} };
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/economy/activity": empty, "/api/servers/s1/maps": empty, "/api/trim/options": empty, "/api/data/status": empty,
    "/api/players/last-seen-drift": empty,
  } }, async (page, { stub, errors }) => {
    const crashed = () => page.getByText("This screen hit an error and could not be shown").count();
    // A full load each, so the wait for a quiet network covers the screen's own code and reads: a
    // change of the address's # alone does not wait for them.
    for (const [i, route] of ["players/economy", "maps/rotation", "maps/catalogue", "admin/trim", "admin/backup"].entries()) {
      await page.goto(`${stub.base}/?visit=${i}#/${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      assert.equal(await crashed(), 0, `${route} crashed on an answer missing its fields`);
    }
    // Data trim's check of last-seen times, answered the same way.
    await page.goto(`${stub.base}/?visit=trim#/admin/trim`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Check" }).last().click();
    await page.waitForTimeout(400);
    assert.equal(await crashed(), 0, "the last-seen check crashed on an answer missing its fields");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The same answers, met a step further in: Scheduled events reads the server's saved rotations once
 * one is picked, and Signatures draws what the player reads as a switch is pressed. Each crashed
 * into its "could not be shown" card, which only a walk through every choice found.
 */
test("Scheduled events and Signatures survive answers missing their fields once used", { skip: SKIP }, async () => {
  const empty = { body: {} };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/maprotation/sets": empty, "/api/signatures": empty } }, async (page, { stub, errors }) => {
    const crashed = () => page.getByText("This screen hit an error and could not be shown").count();
    await page.goto(`${stub.base}/?visit=events#/events/schedule`, { waitUntil: "networkidle" });
    await page.locator(".panel", { hasText: "Scheduled events" }).locator("label", { hasText: "Server" }).locator("select").selectOption("s1");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    assert.equal(await crashed(), 0, "picking the event's server crashed on saved rotations missing their list");
    await page.goto(`${stub.base}/?visit=templates#/admin/templates`, { waitUntil: "networkidle" });
    await page.locator("tr", { hasText: "Welcome / notice message" }).locator("label.toggle").click();
    await page.waitForTimeout(300);
    assert.equal(await crashed(), 0, "the welcome message's switch crashed on signatures missing their lines");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The whole panel, opened. Every top-level destination is visited in one authenticated browser
 * and must produce ZERO uncaught page errors — the flow tests prove features work, but only a
 * crawl notices the screen nobody deliberately tested this week rendering into a white page. A
 * stubbed endpoint answering 404 is fine (screens show their error strips); a component throwing
 * during render is not.
 */
test("crawl: every top-level route renders without an uncaught error", { skip: SKIP }, async () => {
  const { ROUTES } = await import("../lib/routes.ts");
  const tops = ROUTES.filter((r) => !r.parent && !r.hidden);
  assert.ok(tops.length >= 10, `the registry should offer a real app's worth of destinations (got ${tops.length})`);
  await withPage({ grants: OWNER_GRANTS }, async (page, { errors }) => {
    const broken = [];
    for (const [i, r] of tops.entries()) {
      errors.length = 0;
      // A full load each, so the wait for a quiet network covers the screen's own code and reads: a
      // change of the address's # alone does not wait for them, and a screen that crashed once its
      // data came in was looked at before it had.
      await page.goto(`${page.url().split("?")[0].split("#")[0]}?visit=${i}#${r.path}`, { waitUntil: "networkidle" }).catch((e) => broken.push(`${r.path}: navigation failed (${e.message})`));
      // A beat for effects that fire after network settle (charts, layout measurement).
      await page.waitForTimeout(150);
      if (errors.length) broken.push(`${r.path}: ${errors.join(" | ")}`);
      // A screen that crashed while drawing shows its boundary's words, not an uncaught error.
      if (await page.getByText("This screen hit an error and could not be shown").count()) broken.push(`${r.path}: the screen crashed`);
    }
    assert.deepEqual(broken, [], "every destination must render clean");
  });
});

/**
 * The approval queue on a PHONE: an approver has to be able to read what they are signing.
 *
 * Two things were wrong on a 390px screen. The reason — the sentence the whole decision rests on —
 * sat in a slot that truncates, with the full text in a `title` a phone cannot show, so it read
 * “three reports …”. And a filed CALL, which is about a server and has no player, printed the dash
 * that stands for "we do not know who", which reads as data that failed to load.
 */
test("the request queue is readable on a phone: the reason wraps, and a call shows no empty player", { skip: SKIP }, async () => {
  const line = (over) => ({
    id: "l1", seq: 0, serverId: "s1", capability: "player.watchlist", kind: "watch",
    payload: {}, playerId: null, playerName: null, state: "pending",
    decidedByName: null, decidedAt: null, denyReason: null, modified: null,
    appliedAt: null, applyError: null, canSign: true, signRefusal: null, ...over,
  });
  const REASON = "three separate reports of wallhacking in one night, all from different squads";
  const overrides = {
    "/api/requests": { body: {
      queue: [{
        id: "r1", requesterName: "TrialMod", status: "open", note: null,
        submittedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-03T00:00:00.000Z", own: false,
        lines: [
          line({ id: "lw", playerId: "76561198000000001", playerName: "Bandit", payload: { reason: REASON } }),
          line({ id: "lr", seq: 1, kind: "route", capability: "maps.catalogue", payload: {
            method: "PUT", route: "/api/servers/:id/maps/:mapId/name", url: "/api/servers/s1/maps/foy_warfare/name",
            params: { id: "s1", mapId: "foy_warfare" }, label: "Rename a map", body: { name: "Foy (Warfare)" },
          } }),
        ],
      }],
      mine: [],
    } },
    "/api/requests/history": { body: { decisions: [] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/moderation/requests`, { waitUntil: "networkidle" });
    await page.waitForSelector(".req-line", { timeout: 10_000 });

    const out = await page.evaluate(() => {
      const detail = window.document.querySelector(".req-line-detail");
      const d = detail?.getBoundingClientRect();
      const row = detail?.closest(".req-line")?.getBoundingClientRect();
      const rows = [...window.document.querySelectorAll(".req-line")];
      return {
        // Fully rendered, not ellipsised: the box is as tall as the text it holds.
        detailClipped: detail ? detail.scrollWidth > detail.clientWidth + 1 : true,
        detailShare: d && row ? d.width / row.width : 0,
        // The call's row (the one with no player link) must carry no placeholder dash.
        callRowText: rows.find((r) => !r.querySelector(".req-line-who"))?.textContent ?? "",
        playerRowText: rows.find((r) => r.querySelector(".req-line-who"))?.textContent ?? "",
        pageOverflows: window.document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    assert.ok(!out.detailClipped, "the reason is not cut off — a phone cannot show the title that held the rest");
    assert.ok(out.detailShare > 0.8, `the reason takes a line of its own (got ${(out.detailShare * 100).toFixed(0)}% of the row)`);
    assert.match(out.playerRowText, /all from different squads/, "the whole reason is on the page");
    assert.doesNotMatch(out.callRowText, /—/, "a filed call has no player, so it prints no placeholder for one");
    assert.match(out.callRowText, /Rename a map/);
    assert.ok(!out.pageOverflows, "the queue does not push the page sideways");
  });
});

test("a VIP revoke in the queue says what signing ends — a permanent grant is called out, with its note", { skip: SKIP }, async () => {
  const line = (over) => ({
    id: "l1", seq: 0, serverId: "s1", capability: "vip.revoke", kind: "vipRevoke",
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
          line({ id: "lp", payload: { playerId: "76561198000000009", grant: { expiration: null, comment: "paid — PayPal" } } }),
          line({ id: "ld", seq: 1, playerId: "76561198000000010", playerName: "Trial", payload: { playerId: "76561198000000010", grant: { expiration: "2026-12-01T00:00:00.000Z", comment: null } } }),
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
    assert.match(donor, /ends PERMANENT VIP · note “paid — PayPal”/, "the person signing sees it is permanent, and why it exists");
    const trial = rows.find((t) => t.includes("Trial")) ?? "";
    assert.match(trial, /VIP until /);
    assert.doesNotMatch(trial, /PERMANENT/);
  });
});

/**
 * Paying an EVENT: the attendance floor is on screen, and typing a zero means zero.
 *
 * An event carries its own "present at least N minutes" floor, chosen when it was scheduled, and
 * the API applies it whether or not this screen mentions it. The Payouts builder offered the box
 * only for a hand-typed window, so the person paying Friday night saw "3 were under the minutes"
 * with no floor anywhere on the page — and had no way to pay everyone who turned up.
 */
test("the payout builder shows an event's attendance floor and lets it be overridden", { skip: SKIP }, async () => {
  const events = [{
    id: "e1", name: "Friday Night", serverId: "s1", status: "closed",
    openMode: "at", openAnchor: "2026-08-28T19:00:00.000Z", openedAt: "2026-08-28T19:00:00.000Z",
    closeMode: "at", closeAnchor: "2026-08-28T23:00:00.000Z", closedAt: "2026-08-28T23:00:00.000Z",
    minMinutes: 30, mapVoteProfile: null, roster: null, createdBy: "owner", createdAt: "2026-08-01T00:00:00.000Z",
  }];
  const overrides = {
    "/api/payout-events": { body: { items: events } },
    "/api/payouts": { body: { items: [] } },
    "/api/payouts/preview": { body: { recipients: [], dropped: { unlinked: 0, noRole: 0, underMinutes: 0, removed: 0, noGameAccount: 0 } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/events/payouts`, { waitUntil: "networkidle" });
    await page.waitForSelector("select", { timeout: 10_000 });

    // Pick the event source, then the event.
    await page.getByLabel(/Recipients come from/i).selectOption("event");
    await page.waitForTimeout(300);
    await page.getByLabel(/^Event/).selectOption("e1");
    await page.waitForTimeout(400);

    const floor = page.getByLabel(/Present at least/i);
    assert.equal(await floor.count(), 1, "the floor is offered for an event, not only for a window");
    assert.equal(await floor.inputValue(), "30", "seeded from the event's own floor");

    // Preview sends it, so the list on screen is the list the floor produced.
    const previewBtn = page.getByRole("button", { name: /^Preview/i }).first();
    await previewBtn.click();
    await page.waitForTimeout(600);
    const first = stub.calls.filter((c) => c.path === "/api/payouts/preview").at(-1);
    assert.equal(first?.body?.source?.minMinutes, 30);

    // And a deliberate zero reaches the API as a zero — the event's stored floor is what the API
    // falls back to when the request names none, so "blank" could never have meant "no floor".
    await floor.fill("0");
    await page.waitForTimeout(200);
    await previewBtn.click();
    await page.waitForTimeout(600);
    const second = stub.calls.filter((c) => c.path === "/api/payouts/preview").at(-1);
    assert.equal(second?.body?.source?.minMinutes, 0, "an explicit 0 is sent, not omitted");
  });
});

/**
 * The events list says which server each event ran on, and whether it has been paid.
 *
 * Asked for by the staff who pay events: the list named neither, so finding Friday's unpaid event
 * meant opening the Payouts history and matching jobs to events by date. A closed event nobody has
 * paid is the one somebody has to go and do, so it must stand out; a payout that left people unpaid
 * says how many, since its retry is still to do.
 */
test("events list: Server and Payment columns — paid, awaiting payment, part paid", { skip: SKIP }, async () => {
  const ev = (o) => ({
    serverId: "s1", serverName: "Main", status: "closed", payment: null,
    openMode: "at", openAnchor: "2026-08-28T19:00:00.000Z", openedAt: "2026-08-28T19:00:00.000Z",
    closeMode: "at", closeAnchor: "2026-08-28T23:00:00.000Z", closedAt: "2026-08-28T23:00:00.000Z",
    minMinutes: 0, mapVoteProfile: null, rotationSetId: null, roster: [{ playerId: "p1", name: "Someone", minutes: 90 }],
    createdBy: "owner", createdAt: "2026-08-01T00:00:00.000Z",
    ...o,
  });
  const events = [
    ev({ id: "e1", name: "Awaiting night" }),
    ev({ id: "e2", name: "Paid night", payment: { state: "paid", unpaid: 0, at: "2026-08-29T00:10:00.000Z" } }),
    ev({ id: "e3", name: "Part night", payment: { state: "part", unpaid: 3, at: "2026-08-29T00:10:00.000Z" } }),
    ev({ id: "e4", name: "Paying night", payment: { state: "paying", unpaid: 0, at: "2026-08-29T00:10:00.000Z" } }),
    ev({ id: "e5", name: "Running night", status: "open", closedAt: null }),
    ev({ id: "e6", name: "Next week", status: "scheduled", openedAt: null, closedAt: null, serverId: "s2", serverName: "Seed" }),
    ev({ id: "e7", name: "Old night", serverId: "gone", serverName: null }),
    // Nobody came: there is nobody to pay, and a payout would be refused for want of recipients.
    ev({ id: "e8", name: "Empty night", roster: [] }),
  ];
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/payout-events": { body: { items: events } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/events/schedule`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.data tbody tr", { timeout: 10_000 });
    const table = page.locator("table.data", { has: page.locator("th", { hasText: "Window" }) });
    const headers = (await table.locator("thead th").allTextContents()).map((t) => t.trim());
    // Payment straight after the server, ahead of Status: on a phone the table scrolls sideways,
    // and these two columns are what the screen was asked to show without that.
    assert.deepEqual(headers.slice(0, 4), ["Event", "Server", "Payment", "Status"]);
    const cells = async (name) => {
      const row = table.locator("tbody tr", { hasText: name });
      const td = (await row.locator("td").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      return { server: td[1], payment: td[2], badge: await row.locator(".badge.warn-badge").count() };
    };

    const awaiting = await cells("Awaiting night");
    assert.equal(awaiting.server, "Main");
    assert.match(awaiting.payment, /^awaiting payment$/i);
    assert.equal(awaiting.badge, 1, "the one that wants doing stands out");

    const paid = await cells("Paid night");
    assert.match(paid.payment, /^✓ Paid \S/, "paid, with when");
    assert.equal(paid.badge, 0);

    const part = await cells("Part night");
    assert.match(part.payment, /^part paid 3 unpaid$/i);
    assert.equal(part.badge, 1);

    assert.equal((await cells("Paying night")).payment, "Paying…");
    assert.equal((await cells("Running night")).payment, "Not paid yet", "still running: not awaiting anything yet");
    const later = await cells("Next week");
    assert.equal(later.payment, "—");
    assert.equal(later.server, "Seed");
    assert.equal((await cells("Old night")).server, "a removed server");
    const empty = await cells("Empty night");
    assert.equal(empty.payment, "Nobody to pay", "not awaiting a payment that can never be made");
    assert.equal(empty.badge, 0);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The public stats site's own theme.
 *
 * Players cannot reach the panel's Settings screen, so /stats carries its own light/dark toggle
 * and defaults to dark whatever the OS says — proven by emulating a LIGHT system preference and
 * still expecting a dark first paint. The choice persists under the public site's own key and
 * never rewrites the panel's preference.
 */
test("public stats: dark by default on a light OS, own toggle, panel preference untouched", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { stub }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${stub.base}/stats`, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => window.document.documentElement.getAttribute("data-theme")), "dark",
      "the public default is dark even when the OS prefers light");

    await page.waitForSelector('button[aria-label="Switch to light mode"]', { timeout: 10_000 });
    await page.click('button[aria-label="Switch to light mode"]');
    assert.equal(await page.evaluate(() => window.document.documentElement.getAttribute("data-theme")), "light");
    assert.equal(await page.evaluate(() => window.localStorage.getItem("public.theme.mode")), "light", "stored under the public key");
    assert.equal(await page.evaluate(() => window.localStorage.getItem("panel.theme.mode")), null,
      "the public toggle never writes the panel's preference");

    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => window.document.documentElement.getAttribute("data-theme")), "light", "the choice survives a reload");
    await page.click('button[aria-label="Switch to dark mode"]');
    assert.equal(await page.evaluate(() => window.document.documentElement.getAttribute("data-theme")), "dark");
  });
});

/*
 * The public site wears the panel's own shell: the sidebar lists the open server's screens, the
 * open screen's sub-screens under it (a round's Players, Round report and Game log), and the other
 * servers below; it folds to a rail and remembers that. The HUD heads each server screen with the
 * live game, except on a finished round, which shows its own final score instead of the live one.
 */
test("public stats: the panel's sidebar carries the navigation, and the HUD heads each screen", { skip: SKIP }, async () => {
  const mkServer = (slug, name) => ({
    slug, name, game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  });
  const info = {
    current_map: { map: { id: "foy_warfare", pretty_name: "Foy Warfare" }, start: 1_760_000_000 },
    player_count: 87, max_player_count: 100, player_count_by_team: { allied: 44, axis: 43 },
    score: { allied: 4, axis: 1 }, time_remaining: 2712.0, name: { name: "Alpha 24/7", short_name: "" },
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
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [mkServer("alpha", "Alpha 24/7"), mkServer("bravo", "Bravo Seeding")] } },
    "/stats/alpha/api/get_public_info": { body: { result: info, failed: false } },
    "/stats/alpha/api/get_live_game_stats": { body: { result: { snapshot_timestamp: 1, refresh_interval_sec: 5, stats: [] }, failed: false } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    // The server's own screens are the first group; the Servers list below links each server too.
    const nav = (href) => page.locator(`aside.sidebar .nav-group:first-child a.nav-item[href="${href}"]`);
    const listed = (href) => page.locator(`aside.sidebar .nav-group:last-child a.nav-item[href="${href}"]`);
    assert.deepEqual([await nav("/stats/alpha").innerText(), await nav("/stats/alpha/games").innerText(), await nav("/stats/alpha/server").innerText()],
      ["Now playing", "Past games", "Server stats"], "the open server's screens, in the sidebar");
    assert.match(await nav("/stats/alpha/games").getAttribute("class"), /\bactive\b/, "a round is under Past games");
    const subs = await page.locator("aside.sidebar a.nav-subitem").evaluateAll((els) => els.map((a) => [a.getAttribute("href"), a.textContent, a.getAttribute("aria-current")]));
    assert.deepEqual(subs, [
      ["/stats/alpha/games/5", "Players", "page"],
      ["/stats/alpha/games/5/report", "Round report", null],
      ["/stats/alpha/games/5/log", "Game log", null],
    ], "the open round's screens hang under it, the showing one marked");
    assert.equal(await listed("/stats/bravo").count(), 1, "the other published server is listed");
    assert.equal(await listed("/stats").innerText(), "All servers");

    // A finished round's HUD carries ITS result, never the live game's.
    const scores = () => page.locator(".pub-hud .pub-side-score").allInnerTexts();
    assert.deepEqual(await scores(), ["2", "3"], "the round's own final score");
    assert.ok((await page.locator(".pub-hud").innerText()).includes("Carentan Warfare"));

    // The sidebar navigates, and the live screen's HUD is the live game.
    await nav("/stats/alpha").click();
    await page.waitForFunction(() => window.location.pathname === "/stats/alpha", null, { timeout: 5_000 });
    await page.waitForFunction(() => window.document.querySelectorAll(".pub-hud .pub-side-score").length === 2, null, { timeout: 10_000 });
    assert.deepEqual(await scores(), ["4", "1"], "the live score on the live screen");
    const hud = await page.locator(".pub-hud").innerText();
    assert.ok(hud.includes("Foy Warfare") && hud.includes("87/100") && hud.includes("45:12") && hud.includes("44 players"), `the HUD reads: ${hud}`);
    assert.deepEqual(await page.locator("aside.sidebar a.nav-subitem").evaluateAll((els) => els.map((a) => a.getAttribute("href"))),
      ["/stats/alpha", "/stats/alpha/report", "/stats/alpha/log"], "the live round's screens now hang under Now playing");

    // It folds to the panel's rail, and remembers.
    await page.click("aside.sidebar .collapse-btn");
    assert.match(await page.locator(".app-shell").getAttribute("class"), /\bcollapsed\b/);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".app-shell.collapsed", { timeout: 5_000 });
    assert.equal(await page.evaluate(() => window.localStorage.getItem("public.sidebar")), "collapsed");
  });
});

/*
 * On a phone the sidebar is the panel's drawer: shut, the page has the whole width; the burger
 * opens it; any navigation from it closes it (it covers what was just opened), and so do Escape
 * and the scrim.
 */
test("public stats on a phone: the sidebar is a drawer that navigation closes", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: false,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const round = {
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan Warfare" }, result: { allied: 2, axis: 3 }, player_stats: [],
  };
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round, failed: false } },
    "/api/public/alpha/report/5": { body: { report: { complete: false, bucketMinutes: 1, classSplit: [], weaponSplit: [], timeline: [], duels: [], awards: [], players: {} } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: { width: 390, height: 844 } }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector(".pub-hud", { timeout: 10_000 });
    const open = () => page.evaluate(() => window.document.querySelector(".app-shell").classList.contains("drawer-open"));
    const [docW, viewW] = await page.evaluate(() => [window.document.documentElement.scrollWidth, window.innerWidth]);
    assert.deepEqual([docW, viewW], [390, 390], "the shut drawer takes no width");
    assert.equal(await open(), false);

    await page.click("button.burger");
    assert.equal(await open(), true, "the burger opens it");
    await page.locator("aside.sidebar a.nav-subitem", { hasText: "Round report" }).click();
    await page.waitForFunction(() => window.location.pathname === "/stats/alpha/games/5/report", null, { timeout: 5_000 });
    assert.equal(await open(), false, "navigating closes it");

    await page.click("button.burger");
    await page.keyboard.press("Escape");
    assert.equal(await open(), false, "Escape closes it");
  });
});

/*
 * The live board's rows are CRCON's live rows: everyone the round's cache holds comes with no row id
 * at all, everyone else with id 0, and `team` is the side itself rather than detect_team's verdict.
 * A tap opens that one player's row, keyed by the player rather than by an id every row shares, and
 * each live row still wears its side.
 */
test("public live board: a tap opens one player's row, and live rows wear their side", { skip: SKIP }, async () => {
  const server = {
    slug: "alpha", name: "Alpha 24/7", game: "hll", playerIds: true,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  };
  const info = {
    current_map: { map: { id: "foy_warfare", pretty_name: "Foy Warfare" }, start: 1_760_000_000 },
    player_count: 5, max_player_count: 100, player_count_by_team: { allied: 1, axis: 2 },
    score: { allied: 2, axis: 2 }, time_remaining: 2712.0, name: { name: "Alpha 24/7", short_name: "" },
  };
  const live = (playerId, name, kills, overlay) => ({
    player_id: playerId, player: name, platform: "steam", steaminfo: null, kills, deaths: 2, teamkills: 0,
    kill_death_ratio: 1.5, combat: 10, offense: 0, defense: 0, support: 0, time_seconds: 600, kills_streak: 2,
    most_killed: {}, death_by: {}, weapons: { MP40: kills }, death_by_weapons: {}, ...overlay,
  });
  const stats = [
    live("76561198000000001", "Smith", 9, { team: "allies", faction: "us", status: "online" }),
    live("76561198000000002", "Jones", 7, { team: "axis", faction: "ger", status: "online" }),
    live("76561198000000003", "Brown", 5, { team: "axis", faction: "ger", status: "online" }),
    live("76561198000000004", "Green", 1, { id: 0, map_id: 0, team: null, units: [] }),
    live("76561198000000005", "White", 1, { id: 0, map_id: 0, team: null, units: [] }),
  ];
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [server] } },
    "/stats/alpha/api/get_public_info": { body: { result: info, failed: false } },
    "/stats/alpha/api/get_live_game_stats": { body: { result: { snapshot_timestamp: 1.5, stats, refresh_interval_sec: 5 }, failed: false } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard tbody tr", { timeout: 10_000 });
    const open = page.locator("table.scoreboard td[colspan]", { hasText: "Weapons" });
    const tap = (name) => page.locator("table.scoreboard tbody tr", { hasText: name }).first().click();
    assert.equal(await open.count(), 0, "nothing open to begin with");

    await tap("Jones");
    assert.equal(await open.count(), 1, "one tap opens one row, not every row the round's cache holds");
    assert.ok((await open.innerText()).includes("76561198000000002"), "and it is the row tapped");
    await tap("Green");
    assert.equal(await open.count(), 1, "nor every row sent with id 0");
    assert.ok((await open.innerText()).includes("76561198000000004"));
    await tap("Green");
    assert.equal(await open.count(), 0, "a second tap closes it");

    // The side arrives as a string on a live row, and still colours it and feeds the filter.
    const seg = await page.locator(".pub-sb-tools .seg").innerText();
    assert.ok(/Allies 1/.test(seg) && /Axis 2/.test(seg), `the side filter counts the live rows: ${seg}`);
    const bar = await page.locator("td.pub-sb-name", { hasText: "Jones" }).evaluate((td) => td.style.boxShadow);
    assert.ok(bar.includes("--side-red"), `Jones wears Axis red: ${bar}`);
  });
});

/*
 * Public career pages. A scoreboard name is a LINK exactly when the server publishes platform
 * ids and the row carries one; the page it lands on shows the career tiles and recent rounds,
 * each linking back to its round. On a server withholding ids, names stay plain text.
 */
test("public career page: scoreboard names link to careers only where ids are published", { skip: SKIP }, async () => {
  const mkServer = (slug, playerIds) => ({
    slug, name: slug, game: "hll", playerIds,
    sides: [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }],
    scoreFields: [], squadLabel: "Squad",
  });
  const row = (player_id) => ({
    id: 1, player_id, player: "Smith", platform: player_id ? "steam" : null, kills: 12, deaths: 2, teamkills: 0,
    kill_death_ratio: 6, combat: 100, offense: 0, defense: 0, support: 0, time_seconds: 600,
    kills_streak: 5, team: { side: "allies" }, weapons: {}, most_killed: {}, death_by: {},
  });
  const round = (r) => ({
    id: 5, start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T10:40:00.000Z", map_name: "carentan_warfare",
    map: { pretty_name: "Carentan" }, result: { allied: 5, axis: 0 }, player_stats: [r],
  });
  const overrides = {
    "/api/public/servers": { body: { site: { name: "Lynx" }, servers: [mkServer("alpha", true), mkServer("bravo", false)] } },
    "/stats/alpha/api/get_map_scoreboard": { body: { result: round(row("76561198000000001")), failed: false } },
    // Same scoreboard, but the ids-withholding server publishes a null player_id.
    "/stats/bravo/api/get_map_scoreboard": { body: { result: round(row(null)), failed: false } },
    "/api/public/alpha/player/76561198000000001": { body: {
      player: { name: "Smith", platform: "steam", platformId: "76561198000000001" },
      career: { kills: 217, deaths: 100, teamkills: 1, playtimeSec: 7200, visits: 5, combat: 900, offense: 0, defense: 0, support: 0, slSeconds: 3600, matchesPlayed: 10, matchesWon: 6, highestLevel: 141 },
      roles: [{ role: "Officer", seconds: 5400 }],
      weapons: [{ weapon: "M1 GARAND", kills: 4812 }],
      deathsTo: [{ weapon: "155MM HOWITZER [sFH 18]", deaths: 217 }],
      rounds: [{ seq: 9, map: "Foy Warfare", startedAt: "2026-08-01T08:00:00.000Z", endedAt: "2026-08-01T09:00:00.000Z", side: "allies", kills: 20, deaths: 4, won: true }],
    } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${stub.base}/stats/alpha/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard", { timeout: 10_000 });
    const nameLink = page.locator('a[href="/stats/alpha/player/76561198000000001"]');
    assert.equal(await nameLink.count(), 1, "the name is a career link when ids are published");
    await nameLink.click();
    await page.waitForSelector(".stat-tile", { timeout: 10_000 });
    const body = await page.locator("body").innerText();
    assert.ok(page.url().endsWith("/stats/alpha/player/76561198000000001"), "a pasteable career URL");
    assert.ok(body.includes("217"), "career kills render");
    assert.ok(body.includes("Officer"), "role time renders, named by the game");
    assert.ok(body.includes("M1 GARAND") && body.includes("4,812"), "career weapons render");
    assert.ok(body.includes("155MM HOWITZER [sFH 18]") && body.includes("217"), "the career died-to list renders");
    assert.ok(body.includes("Foy Warfare") && body.includes("Won"), "recent rounds render with results");
    assert.equal(await page.locator('a[href="/stats/alpha/games/9"]').count(), 1, "each round links back to its page");

    // The withholding server: same scoreboard, no links.
    await page.goto(`${stub.base}/stats/bravo/games/5`, { waitUntil: "networkidle" });
    await page.waitForSelector("table.scoreboard", { timeout: 10_000 });
    assert.equal(await page.locator('a[href^="/stats/bravo/player/"]').count(), 0, "no ids, no career links");
  });
});

test("double press: a rule section is made once", { skip: SKIP }, async () => {
  const overrides = {
    "/api/enforcer/rules": { body: { sections: [], rules: [], activity: {} } },
    "/api/enforcer/sections": { delayMs: SLOW_WRITE_MS, body: { section: { id: "sec1", name: "Player level rules" } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings`, { waitUntil: "networkidle" });
    await page.click('.hub-tabs button:has-text("Rules")');
    await page.locator('button:has-text("New section")').click();
    await page.getByPlaceholder("Section name").fill("Player level rules");
    await page.locator('button:has-text("Add section")').dblclick();
    await page.waitForFunction(() => !window.document.querySelector('input[placeholder^="Section name"]'), null, { timeout: 10_000 });
    assert.equal(writesTo(stub, "POST", "/api/enforcer/sections"), 1, "one press, one section");
  });
});

test("double press: a library map set is made once, by New and by Duplicate", { skip: SKIP }, async () => {
  const made = (name) => ({ set: { id: "new1", name, game: "hll", pool: { modeBuckets: [] } } });
  await withPage({ grants: OWNER_GRANTS, overrides: { ...MAPVOTE_FIXTURES, "/api/mapvote/sets": { delayMs: SLOW_WRITE_MS, body: made("New map set") } } }, async (page, { stub }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/votesetup`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Manage map sets" }).first().click();
    await page.locator('button:has-text("New map set")').dblclick();
    await page.waitForSelector('text=Created "New map set"', { timeout: 10_000 });
    assert.equal(writesTo(stub, "POST", "/api/mapvote/sets"), 1, "one press of New, one set");

    await page.locator('select[aria-label="Manage map sets"]').selectOption({ label: "default" });
    await page.locator('button:has-text("Duplicate")').first().dblclick();
    await page.waitForSelector('text=Created "default copy"', { timeout: 10_000 });
    assert.equal(writesTo(stub, "POST", "/api/mapvote/sets"), 2, "one press of Duplicate, one copy");
  });
});

test("player profile: opening another player leaves nothing of the last one on screen", { skip: SKIP }, async () => {
  const profile = (id, name) => ({ body: {
    player: { id, platformId: id, platform: "steam", name, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
    stats: { kills: 1, deaths: 1, teamkills: 0, playtimeSec: 60, visits: 1 },
    flags: {}, recentEvents: [], sessions: [], aliases: [], matches: [], canViewNotes: true, notes: [],
  } });
  const overrides = {
    "/api/players/gone": { status: 404, body: { error: "player not found" } },
    "/api/players/slow": { delayMs: STALE_MS, ...profile("slow", "STALE-PROFILE") },
    "/api/players/next": profile("next", "Next Player"),
    "/api/players/third": profile("third", "Third Player"),
    "/api/player-groups/for/next": { body: { groups: [{ id: "g1", name: "NEXT-GROUP" }] } },
    // The third player's groups answer late, which is the window the last player's chips sat in.
    "/api/player-groups/for/third": { delayMs: STALE_MS, body: { groups: [] } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/players/~gone`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /HTTP 404/.test(window.document.body.innerText), null, { timeout: 10_000 });
    // In the same view, the way a name inside a profile opens its player.
    await page.evaluate(() => { window.location.hash = "#/players/~next"; });
    await page.waitForSelector("h1:has-text('Next Player')", { timeout: 10_000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /HTTP 404/, "the last profile's failure is not this one's");

    // A slow profile, left for another before it answers.
    await page.evaluate(() => { window.location.hash = "#/players/~slow"; });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.location.hash = "#/players/~next"; });
    await page.waitForSelector("h1:has-text('Next Player')", { timeout: 10_000 });
    await page.waitForTimeout(STALE_MS + 800);
    const body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /STALE-PROFILE/, "the abandoned profile landed over the open one");
    assert.match(body, /Next Player/);

    // A note typed for this player, then the next one opened: the draft must not be waiting to be
    // filed on somebody else, and this player's group chips must not show on the next one.
    await page.waitForSelector("text=NEXT-GROUP", { timeout: 10_000 });
    await page.getByPlaceholder("Add a note…").fill("NOTE-FOR-NEXT");
    await page.evaluate(() => { window.location.hash = "#/players/~third"; });
    await page.waitForSelector("h1:has-text('Third Player')", { timeout: 10_000 });
    assert.equal(await page.getByPlaceholder("Add a note…").inputValue(), "", "a note typed for one player sat ready to be filed on the next");
    assert.doesNotMatch(await page.locator("body").innerText(), /NEXT-GROUP/, "the last player's groups showed on the next one");
  });
});

/*
 * Installable in Chrome, by Chrome's own judgement. Without icons a phone's Chrome offered only a
 * plain shortcut, a browser tab with the bar; "Install app" needs a 192 and a 512 px icon. DevTools
 * exposes the very check Chrome runs, so this asks it. A real profile, because Chrome never
 * installs from incognito, and localhost, which counts as secure like the live panel's HTTPS.
 */
test("Chrome itself judges the panel installable as an app", { skip: SKIP }, async () => {
  const { chromium } = await import("playwright-core");
  const stub = await startStub({ grants: OWNER_GRANTS });
  const profile = mkdtempSync(join(tmpdir(), "panel-install-"));
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: CHROMIUM, args: ["--no-sandbox"] });
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(stub.base.replace("127.0.0.1", "localhost"), { waitUntil: "networkidle" });
    const cdp = await ctx.newCDPSession(page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors, [], `Chrome would not install it: ${JSON.stringify(installabilityErrors)}`);
  } finally {
    await ctx.close();
    await stub.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

/*
 * Newer versions, on System, for the account made at setup: what changed, newest first, and how to
 * update. Anyone else — the API says there is nothing for them — sees no Updates panel at all, and
 * a repository GitHub keeps private is said plainly.
 */
test("System: the account made at setup sees what a newer version changes and how to update; nobody else sees a thing", { skip: SKIP }, async () => {
  const updates = (body) => ({ grants: OWNER_GRANTS, overrides: { "/api/updates": { body } } });
  const updatesPanel = (page) => page.locator("section.panel", { has: page.locator(".panel-title", { hasText: /^Updates$/ }) });
  const openSystem = async (page) => page.goto(`${page.url().split("#")[0]}#/admin/system`, { waitUntil: "networkidle" });
  await withPage(updates({
    shown: true, state: "available", commit: "abc1234", branch: "main", behindBy: 2, checkedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    changes: [
      { sha: "9f8e7d6c", title: "Ports: a host port other than 8080 no longer leaves the panel unreachable", date: "2026-10-21T19:45:00Z" },
      { sha: "1a2b3c4d", title: "Online access: a save is not undone by a read already on its way", date: "2026-10-21T19:30:00Z" },
    ],
  }), async (page, { errors }) => {
    await openSystem(page);
    await updatesPanel(page).waitFor({ timeout: 10_000 });
    const text = await updatesPanel(page).innerText();
    assert.match(text, /2 updates since this version \(abc1234 on main\)/);
    assert.match(text, /Ports: a host port other than 8080[\s\S]*Online access: a save is not undone/, "what changed, newest first");
    assert.match(text, /To update, run start\.bat/);
    assert.match(text, /checked 3 min ago/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
  await withPage(updates({ shown: false }), async (page) => {
    await openSystem(page);
    await page.locator(".panel-title", { hasText: "Services" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    assert.equal(await updatesPanel(page).count(), 0, "another owner: no Updates panel at all");
  });
  await withPage(updates({ shown: true, state: "unknown", commit: "abc1234", branch: "main", checkedAt: new Date().toISOString(),
    reason: "GitHub does not show this code's repository to the public (it is private), so newer versions cannot be checked." }), async (page) => {
    await openSystem(page);
    await updatesPanel(page).waitFor({ timeout: 10_000 });
    assert.match(await updatesPanel(page).innerText(), /it is private/);
  });
});

/*
 * The build stamp: /health/metrics carries the commit the running image was built from, and the
 * sidebar footer shows it. This exists so "did my update land" is answered by looking at the
 * screen instead of by comparing screenshots of a map. A menu tightened to fit a short window keeps
 * the host status to one line and leaves the stamp to its tooltip, which carries it at every size.
 */
test("the sidebar names the running commit", { skip: SKIP }, async () => {
  await withPage({}, async (page) => {
    await page.setViewportSize({ width: 1366, height: 1300 });
    await page.waitForSelector(".host-status", { timeout: 15_000 });
    await page.waitForFunction(() => /abc1234/.test(window.document.querySelector(".host-status")?.textContent ?? ""), null, { timeout: 15_000 });
    assert.match(await page.locator(".host-status").innerText(), /abc1234/, "the stamp from /health/metrics renders in the footer");
    await page.setViewportSize({ width: 1366, height: 650 });
    await page.waitForFunction(() => window.document.querySelector(".sidebar")?.dataset.fit?.includes("tight"), null, { timeout: 5_000 });
    assert.doesNotMatch(await page.locator(".host-status").innerText(), /abc1234/, "a laptop's window: one line, no stamp in it");
    assert.match(await page.locator(".host-status").getAttribute("title"), /v0\.0\.0 · abc1234/, "the stamp is in the tooltip");
  });
});

/*
 * Auto zones, reviewable. With the zones on, a learned warfare layer that nothing painted covers
 * shows the zones the bot enforces there — worked out from the stored learned layout — marked as
 * an auto zone. Nothing is saved for it; painting a square makes it the layer's own paint,
 * starting from the auto zone, and saving sends that. With the zones off the layer shows no
 * zones, only the learned layout and its prefill button.
 */
test("seeding areas: a learned layer shows its auto zone in the painter; painting over it makes it the layer's own", { skip: SKIP }, async () => {
  const CAPS = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "seeding.config", scopeType: "global", scopeId: null, level: "write" },
    { capability: "admin.moderation", scopeType: "global", scopeId: null, level: "write" },
  ];
  const prefill = { allies: ["A2", "B2"], axis: ["A8", "B8"], shared: [] };
  const overrides = (mode, seedingEnabled = true, dryRun = false, engagementMode = "observe") => ({
    "/api/servers": { body: { servers: [{ id: "s1", name: "Test Server #1", game: "hll", engagementMode }] } },
    "/api/zones": { body: { sets: [], maps: [{ key: "foy", label: "Foy" }] } },
    "/api/servers/s1/maps": { body: { catalogue: [{ id: "foy_warfare", prettyName: "Foy Warfare" }] } },
    "/api/servers/s1/seeding": { body: {
      config: {
        serverId: "s1", enabled: seedingEnabled, dryRun, positionalEnabled: false, containEnabled: mode === "on", layoutLearnEnabled: mode !== "off", containGraceSec: 60, containMaxPlayers: 0,
        containNotice: "", containZones: {}, paceEnabled: false, paceUnlockMinutes: [0, 0, 0, 0, 0], paceNotice: "",
      },
      roles: {}, weaponClasses: [], weapons: [], commanderAbilities: [], announcePreview: "", configured: true,
      containMaps: [{ key: "foy", label: "Foy" }],
      learnedLayouts: { "@foy_warfare": { status: "learned", axis: "y", alliesDir: -1, rounds: 2, agree: 2, prefill, autoZone: true, family: "foy" } },
    } },
  });

  // Seeding on but in dry-run, on a server in observe mode: the page says both — every action here
  // is only logged.
  await withPage({ grants: CAPS, overrides: overrides("on", true, true) }, async (page, { stub, errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    assert.equal(await page.locator(".zone-grid .zg-auto").count(), 4, "the auto zone's squares are drawn, marked as auto");
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 2);
    assert.equal(await page.locator(".zone-grid .zg-axis").count(), 2);
    assert.match(await page.locator('option:has-text("Foy Warfare")').innerText(), /auto zone/, "the map list says which layers have one");
    assert.match(await page.locator("body").innerText(), /Auto zone — what the bot enforces on this layer/);
    const shown = await page.locator("body").innerText();
    assert.doesNotMatch(shown, /Seeding is switched off/, "seeding on: no such notice");
    assert.match(shown, /Seeding is in dry-run on this server/, "dry-run: the rules here only log");
    assert.match(shown, /This server is in observe mode[\s\S]*These rules still evaluate/, "observe mode: said on this page too");
    assert.equal(await page.locator('button:has-text("Clear this map")').count(), 0, "nothing of the layer's own to clear");

    await page.locator(".zone-grid .zg").nth(42).click(); // C5, with the default allies brush
    assert.equal(await page.locator(".zone-grid .zg-auto").count(), 0, "it is the layer's own paint now");
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 3, "started from the auto zone, plus the new square");
    const card = page.locator("div.card").filter({ has: page.getByText("Seeding enforcement judged from live positions.") }).last();
    await card.locator("button.primary", { hasText: "Save" }).click();
    let put = null;
    for (let i = 0; i < 50 && !put; i++) {
      put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/servers/s1/seeding") ?? null;
      if (!put) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(put, "the save reached the API");
    const saved = put.body.containZones["@foy_warfare"];
    assert.deepEqual([...saved.allies].sort(), ["A2", "B2", "C5"]);
    assert.deepEqual([...saved.axis].sort(), ["A8", "B8"]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });

  // Learn only: the learned zones show for review, and say they are not enforced yet. Seeding
  // itself is off on this server, and the page says nothing here runs until it is on.
  await withPage({ grants: CAPS, overrides: overrides("learn", false) }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    assert.equal(await page.locator(".zone-grid .zg-auto").count(), 4, "learn only: the learned zones show for review");
    const body = await page.locator("body").innerText();
    assert.match(body, /will enforce once Seeding zones is On/);
    assert.match(body, /Seeding is switched off for this server/, "a server with seeding off says nothing here runs");
    assert.doesNotMatch(body, /Seeding is in dry-run/, "off says it all; no dry-run line on top");
  });

  // An active server, seeding on and live: no notice at all.
  await withPage({ grants: CAPS, overrides: overrides("off", true, false, "active") }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /Seeding is switched off|Seeding is in dry-run|observe mode/, "live and active: nothing to warn about");
    assert.equal(await page.locator(".zone-grid .zg-auto").count(), 0, "zones off: no auto zone");
    assert.equal(await page.locator(".zone-grid .zg-allies").count(), 0);
    assert.match(await page.locator('option:has-text("Foy Warfare")').innerText(), /· learned/);
    assert.equal(await page.locator('button:has-text("Prefill from learned layout")').count(), 1, "the learned layout can still prefill a paint");
  });
});

/*
 * The learned layout's words named the first side "Allies" on every server, while the paint
 * buttons beside them said "US" on a Vietnam one.
 */
test("seeding areas on a Vietnam server: the learned layout names the side as the paint buttons do", { skip: SKIP }, async () => {
  const HLLV = {
    id: "hllv", label: "Hell Let Loose: Vietnam", roles: {},
    sides: [
      { id: "allies", label: "US", color: "blue", teamValues: [1], parity: "odd" },
      { id: "axis", label: "NVA", color: "red", teamValues: [2], parity: "even" },
    ],
    squadLabel: "Platoon", scoreFields: [], squadLeaderRoles: [], configFields: [],
  };
  const CAPS = [
    { capability: "server.view", scopeType: "global", scopeId: null, level: "read" },
    { capability: "seeding.config", scopeType: "global", scopeId: null, level: "write" },
    { capability: "admin.moderation", scopeType: "global", scopeId: null, level: "write" },
  ];
  const prefill = { allies: ["A2", "B2"], axis: ["A8", "B8"], shared: [] };
  await withPage({ grants: CAPS, overrides: {
    "/api/servers": { body: { servers: [{ id: "s1", name: "NAM #1", game: "hllv", engagementMode: "active" }] } },
    "/api/games/hllv/descriptor": { body: { descriptor: HLLV } },
    "/api/zones": { body: { sets: [], maps: [{ key: "hue", label: "Hue" }] } },
    "/api/servers/s1/maps": { body: { catalogue: [{ id: "hue_warfare", prettyName: "Hue Warfare" }] } },
    "/api/servers/s1/seeding": { body: {
      config: {
        serverId: "s1", enabled: true, dryRun: false, positionalEnabled: false, containEnabled: false, layoutLearnEnabled: true, containGraceSec: 60, containMaxPlayers: 0,
        containNotice: "", containZones: {}, paceEnabled: false, paceUnlockMinutes: [0, 0, 0, 0, 0], paceNotice: "",
      },
      roles: {}, weaponClasses: [], weapons: [], commanderAbilities: [], announcePreview: "", configured: true,
      containMaps: [{ key: "hue", label: "Hue" }],
      learnedLayouts: { "@hue_warfare": { status: "learned", axis: "y", alliesDir: -1, rounds: 2, agree: 2, prefill, autoZone: true, family: "hue" } },
    } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/autosettings/zones`, { waitUntil: "networkidle" });
    await page.waitForSelector(".zone-grid .zg", { timeout: 15_000 });
    await page.getByRole("button", { name: "US", exact: true }).waitFor({ timeout: 10_000 });
    const body = await page.locator("body").innerText();
    assert.match(body, /vertical, US top \(north\)/, "the learned layout says US");
    assert.doesNotMatch(body, /Allies top/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The WW2 objectives picker: the field report behind this was "I highlight the first row's
 * selection, then click on any other row and it disappears." Two guarantees pinned here:
 * picks ACCUMULATE across rows (one per row, none lost to the next tap), and in teaching mode
 * every taught square stays marked on the map while the pen moves — the square just set used
 * to leave no trace at all once another option was armed, which read as the work being lost.
 */
test("WW2 objectives: a picked option LOOKS picked, stays looking picked across rows, and taught squares persist while teaching", { skip: SKIP }, async () => {
  const rows = [
    ["FLAK POSITION", "VAULAVILLE", "LA PRAIRIE"],
    ["ROUTE DU HARAS", "WESTERN APPROACH", "RUE DE GAMBOSVILLE"],
    ["HOSPICE", "SAINTE-MERE-EGLISE", "CHECKPOINT"],
    ["ARTILLERY BATTERY", "THE CEMETERY", "MAISON DU CRIQUE"],
    ["LES VIEUX VERGERS", "CROSS ROADS", "RUISSEAU DE FERME"],
  ];
  const overrides = {
    "/api/servers/s1/maps/objectives": { body: {
      rows, mapKey: "stmereeglise",
      points: [
        { game: "hll", mapKey: "stmereeglise", row: 0, idx: 0, name: null, sector: "B2" },
        { game: "hll", mapKey: "stmereeglise", row: 1, idx: 1, name: null, sector: "C5" },
        { game: "hll", mapKey: "stmereeglise", row: 2, idx: 0, name: null, sector: "D7" },
      ],
      mapId: "stmereeglise_warfare", saved: null,
    } },
  };
  // A phone-shaped page on purpose: the report came from one, where the row of options scrolls
  // sideways and the map is the only place the state of the five rows can actually be seen.
  await withPage({ overrides, viewport: { width: 390, height: 844 } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    const panel = page.locator("section.panel", { has: page.locator(".panel-title", { hasText: "Objectives" }) });
    await panel.waitFor({ timeout: 15000 });
    await panel.locator("button", { hasText: "FLAK POSITION" }).waitFor({ timeout: 15000 });

    // The RENDERED background, not the class string: the original bug was a selected option whose
    // class toggled correctly but whose pixels never changed (.ghost renders like a default button),
    // so the only on-screen difference was the last-tapped button's focus/hover. We park the pointer
    // on inert chrome and drop focus before reading, so neither can stand in for a real selected look.
    const bg = async (label) => {
      await panel.locator(".panel-title").hover();
      await page.evaluate(() => window.document.activeElement?.blur?.());
      await page.waitForTimeout(60);
      return panel.locator("button", { hasText: label }).first().evaluate((b) => window.getComputedStyle(b).backgroundColor);
    };
    const pickBadges = () => page.evaluate(() => {
      const img = window.document.querySelector("img.tac-map");
      return [...img.parentElement.querySelectorAll("span")].map((s) => s.textContent).filter((t) => /^\d$/.test(t)).sort();
    });

    // LA PRAIRIE is never picked: its background is the baseline "unpicked" look. Everything picked
    // must read as visibly different from THIS, with the pointer parked so the test is not fooled by
    // hover/focus — the exact thing that masked the bug on the real screen.
    const unpicked = await bg("LA PRAIRIE");

    // The report, verbatim: pick row 1, then tap other rows — the earlier pick must still LOOK picked.
    await panel.locator("button", { hasText: "FLAK POSITION" }).first().click();
    assert.notEqual(await bg("FLAK POSITION"), unpicked, "a picked option is visibly different from an unpicked one");
    assert.deepEqual(await pickBadges(), ["1"], "row 1's pick lights its taught square");

    await panel.locator("button", { hasText: "WESTERN APPROACH" }).first().click();
    assert.notEqual(await bg("FLAK POSITION"), unpicked, "row 1 still LOOKS picked after a row 2 tap (the reported bug)");
    assert.deepEqual(await pickBadges(), ["1", "2"]);
    await panel.locator("button", { hasText: "HOSPICE" }).first().click();
    assert.notEqual(await bg("FLAK POSITION"), unpicked, "and after a row 3 tap");
    assert.deepEqual(await pickBadges(), ["1", "2", "3"], "one highlight per picked row, all standing");
    await panel.locator("button", { hasText: "THE CEMETERY" }).first().click(); // row 4: no taught square
    assert.notEqual(await bg("THE CEMETERY"), unpicked, "an untaught pick still shows the picked style");
    assert.notEqual(await bg("FLAK POSITION"), unpicked, "every earlier pick still looks picked");
    assert.deepEqual(await pickBadges(), ["1", "2", "3"], "an untaught pick cannot erase the others' squares");

    // Teaching mode: every taught square is marked the whole time — and STAYS marked when the
    // pen moves to another row. This is the trace whose absence read as "it disappears".
    await panel.locator("label.toggle", { hasText: "Edit locations" }).click();
    await page.waitForFunction(() => window.document.querySelectorAll('[aria-label^="teach cell"]').length === 100);
    const taughtCells = () => page.evaluate(() =>
      [...window.document.querySelectorAll("[data-taught-cell]")].map((d) => d.getAttribute("data-taught-cell")).sort());
    assert.deepEqual(await taughtCells(), ["B2", "C5", "D7"], "all taught squares are visible in teaching mode");
    await panel.locator("button", { hasText: "FLAK POSITION" }).first().click(); // arm row 1's taught option
    await panel.locator("button", { hasText: "WESTERN APPROACH" }).first().click(); // move the pen to row 2
    assert.deepEqual(await taughtCells(), ["B2", "C5", "D7"], "moving the pen hides nothing already taught");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("leaving a server mid-request: the rotation and the vote controls never paint the abandoned one", { skip: SKIP }, async () => {
  /*
   * The same race the dashboard widgets were fixed for, on the two screens that had not been:
   * Maps → Rotation and Maps → Vote each wrote their own fetch and took whatever came back. Switch
   * server while the first request is still out and the old server's answer lands second, painting
   * over the new one — and these are not read-only tiles. The rotation's buttons and the vote's
   * Pause/Skip act on the SELECTED server while showing what that stale response carried.
   *
   * Three servers, as before: the race has to start after the page has settled, so server one is
   * the landing pad and the race is two → three.
   */
  const SLOW_MS = 1500;
  const server = (id, name) => ({ id, name, game: "hll", engagementMode: "observe" });
  const mapItem = (id, prettyName) => ({ id, prettyName, mode: "warfare", environment: "day", family: id });
  const mapsBody = (marker) => ({
    maps: [mapItem(`${marker}_id`, marker)],
    rotation: [mapItem(`${marker}_id`, marker)],
    current: mapItem(`${marker}_id`, marker),
    currentIndex: 0,
    changeable: null,
  });
  const voteBody = (marker, totalVotes) => ({
    enabled: true, surface: "native", channelId: "1", pollHours: 2, liveApply: true,
    postMatchApplyDelaySeconds: 300, pollResetDelaySeconds: 180, pauseBelowPlayers: 0,
    timezone: "UTC", activeProfile: null, reminders: [], profiles: [],
    state: {
      paused: false, pauseReason: null, overrideMapId: null,
      skipNext: false, reroll: false, startNow: false, resyncNow: false,
      sendMessageLayout: null, savedOptions: [], liveAppliedMapId: null, reopenAt: null,
      activePoll: {
        options: [{ id: `${marker}_id`, name: marker, votes: 3 }],
        profile: null, openedAt: new Date(Date.now() - 6e5).toISOString(),
        totalVotes, talliedAt: new Date().toISOString(),
      },
    },
  });

  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [server("s1", "Landing"), server("s2", "Slow"), server("s3", "Current")] } },
      "/api/servers/s1/maps": { body: mapsBody("LANDINGMAP") },
      "/api/servers/s1/mapvote/config": { body: voteBody("LANDINGPOLL", 1) },
      // The server we leave mid-request. Everything it returns is marked STALE.
      "/api/servers/s2/maps": { delayMs: SLOW_MS, body: mapsBody("STALEMAPS2") },
      "/api/servers/s2/mapvote/config": { delayMs: SLOW_MS, body: voteBody("STALEPOLLS2", 777) },
      // The server we end on. Answers at once, so it lands FIRST and the stale data arrives after.
      "/api/servers/s3/maps": { body: mapsBody("CORRECTMAPS3") },
      "/api/servers/s3/mapvote/config": { body: voteBody("CORRECTPOLLS3", 888) },
    },
  }, async (page, { errors }) => {
    const picker = 'select[aria-label="Active server"]';
    const base = page.url().split("#")[0];

    // --- the rotation ---
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /LANDINGMAP/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.selectOption(picker, "s2");
    await page.selectOption(picker, "s3");
    await page.waitForFunction(() => /CORRECTMAPS3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForTimeout(SLOW_MS + 800);
    let body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /STALEMAPS2/, "the abandoned server's rotation painted over the current one's");
    assert.match(body, /CORRECTMAPS3/, "the current server's rotation must still be on screen");
    assert.equal(await page.locator(picker).inputValue(), "s3");

    // --- the vote controls ---
    await page.selectOption(picker, "s1");
    await page.goto(`${base}#/maps/vote`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /LANDINGPOLL/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.selectOption(picker, "s2");
    await page.selectOption(picker, "s3");
    await page.waitForFunction(() => /CORRECTPOLLS3/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForTimeout(SLOW_MS + 800);
    body = await page.locator("body").innerText();
    assert.doesNotMatch(body, /STALEPOLLS2/, "the abandoned server's poll painted over the current one's");
    assert.doesNotMatch(body, /\b777\b/, "and so did its vote count — these buttons act on the SELECTED server");
    assert.match(body, /CORRECTPOLLS3/, "the current server's poll must still be on screen");
    assert.equal(await page.locator(picker).inputValue(), "s3");

    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("rotation: Check from game times itself by this browser's clock and never sticks on Checking…", { skip: SKIP }, async () => {
  /*
   * The issue check of the rotation page's Check from game (a95aeefd), driven in a real browser:
   *  - "checked …" came from the SERVER's clock, so a host whose clock lags (a Docker host after a
   *    sleep) made a check pressed a second ago read "2 h ago" — exactly what a failed check looks like;
   *  - a check overtaken by a server switch never let go of "Checking…": the button stayed disabled;
   *  - with the map in play and the next map both lit, nothing said which chip was next;
   *  - shuffle on with a ONE-map rotation (how the vote queues) raised the "list order is not what
   *    plays" warning, though there is nothing to reorder.
   */
  const SLOW_MS = 2500;
  const server = (id, name) => ({ id, name, game: "hll", engagementMode: "observe" });
  const mapItem = (id, prettyName) => ({ id, prettyName, mode: "warfare", environment: "day", family: id });
  const lagged = new Date(Date.now() - 2 * 3600_000).toISOString(); // the server's clock, two hours behind
  const a = mapItem("smdm_skirmish", "SMDM Skirmish");
  const b = mapItem("sme_skirmish", "SME Skirmish");
  const w = mapItem("smdm_warfare", "SMDM Warfare");
  const s1Body = {
    maps: [a, b, w], rotation: [a, b], current: w, currentIndex: -1, nextIndex: 1, next: b,
    queue: { maps: [a, b], nextIndex: 1, next: b }, shuffle: false, checkedAt: lagged, changeable: null,
  };
  const s2Body = {
    maps: [a, w], rotation: [w], current: a, currentIndex: -1, nextIndex: 0, next: w,
    queue: null, shuffle: true, checkedAt: lagged, changeable: null,
  };
  let slow = false;
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/servers": { body: { servers: [server("s1", "Hand rotation"), server("s2", "Voted")] } },
      "/api/servers/s1/maps": () => (slow ? { delayMs: SLOW_MS, body: s1Body } : { body: s1Body }),
      "/api/servers/s2/maps": { body: s2Body },
    },
  }, async (page, { errors }) => {
    const picker = 'select[aria-label="Active server"]';
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/maps/rotation`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => /Next up:\s*SME Skirmish/.test(window.document.body.innerText), null, { timeout: 15_000 });
    await page.waitForFunction(() => /checked\s+\S/.test(window.document.body.innerText), null, { timeout: 15_000 });
    let body = await page.locator("body").innerText();
    assert.match(body, /checked just now/, "timed by this browser's clock when the answer landed");
    assert.doesNotMatch(body, /checked 2 h ago/, "the server's lagging clock must not age a fresh check");
    assert.match(body, /shuffle off/);
    assert.match(body, /the game's queue agrees/, "two agreeing answers are what a passed check looks like");
    assert.match(body, /SME Skirmish · next/i, "the lit chip that is next says so (chips are set in capitals)");

    // A slow check, then a switch of server while it is still out.
    slow = true;
    await page.getByRole("button", { name: "Check from game" }).first().click();
    await page.getByRole("button", { name: "Checking…" }).first().waitFor({ timeout: 5_000 });
    await page.selectOption(picker, "s2");
    await page.waitForFunction(() => /Next up:\s*SMDM Warfare/.test(window.document.body.innerText), null, { timeout: 15_000 });
    // Past the slow answer too: it belongs to the server we left and must not hold this button.
    await page.waitForTimeout(SLOW_MS + 800);
    const button = page.getByRole("button", { name: "Check from game" }).first();
    assert.equal(await button.count(), 1, "the button must not be left reading Checking…");
    assert.equal(await button.isDisabled(), false, "and it must be pressable on the new server");

    body = await page.locator("body").innerText();
    assert.match(body, /shuffle on/, "one map in the rotation: shuffle is a note, nothing to reorder");
    assert.doesNotMatch(body, /Map shuffle is on/, "…not the list-order warning");
    assert.doesNotMatch(body, /SMDM Skirmish · next/i, "the server we left painted nothing here");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A chip types into the message it sits under — not into whichever box happened to have focus.
 * Seeding and Broadcast stack several messages on one page; typing in one and clicking another's
 * chip used to drop the placeholder into the first.
 */
test("a chip types into its own message box even while another box has focus", { skip: SKIP }, async () => {
  const config = { serverId: "s1", enabled: true, dryRun: false, intervalSec: 300, randomize: false, messages: ["Welcome to {server_name}"], updatedAt: "2026-09-26T00:00:00Z" };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/broadcast": { body: { config } } } }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/admin/broadcast`, { waitUntil: "networkidle" });
    const sendNow = page.locator("textarea").first();
    await sendNow.waitFor();
    const draft = page.locator('input[placeholder="Add a broadcast…"]');
    await draft.waitFor();
    await sendNow.fill("Now on ");
    await sendNow.focus();
    // The rotation's list is the second placeholder row on the page.
    await page.locator(".placeholder-hint").nth(1).locator(".placeholder-chip", { hasText: "{server_name}" }).click();
    assert.equal(await draft.inputValue(), "{server_name}", "the placeholder landed in the rotation's box");
    assert.equal(await sendNow.inputValue(), "Now on ", "the focused Broadcast-now box was left alone");
    // And the Broadcast-now row still serves its own box.
    await page.locator(".placeholder-hint").first().locator(".placeholder-chip", { hasText: "{map_name}" }).click();
    assert.equal(await sendNow.inputValue(), "Now on {map_name}");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Re-editing a player trigger: Edit on a row loads it into the builder exactly as it is, and
 * saving sends a PUT to that trigger — not a POST that would make a second one.
 */
test("a player trigger can be edited from the list: the builder loads it and saves in place", { skip: SKIP }, async () => {
  const trig = {
    id: "t1", playerId: "p1", playerName: "Critic_5", serverId: null, serverName: null, event: "connect",
    steps: [{ action: "message", message: "Welcome back {player_name}", hours: 0, points: 0, delaySec: 0 }],
    fireOnce: false, enabled: true, note: "old note", createdByName: "KREITZ", createdAt: "2026-09-26T16:57:19Z",
    firedCount: 0, lastFiredAt: null, disarmedAt: null, summary: "on connect, message (every time)",
  };
  const overrides = {
    "/api/player-triggers": { body: { triggers: [trig] } },
    "/api/players/p1/triggers": { body: { triggers: [trig], allowedActions: ["message", "kick", "vipremove"] } },
    "/api/players/p1/triggers/t1": { body: { trigger: trig } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/triggers`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: /^Edit$/ }).first().click();
    const box = page.locator("fieldset textarea").first();
    await box.waitFor();
    assert.equal(await box.inputValue(), "Welcome back {player_name}", "the builder holds the trigger as it is");
    assert.equal(await page.locator('input[placeholder^="e.g. Owner asked"]').inputValue(), "old note");
    await box.fill("Welcome back, {player_name} — VIP until {vip_until}");
    await page.locator("button", { hasText: "Save changes" }).click();
    await page.locator("button", { hasText: "Save changes" }).waitFor({ state: "detached" });
    const writes = stub.calls.filter((c) => c.path.startsWith("/api/players/p1/triggers") && c.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PUT", "an edit changes the trigger in place");
    assert.equal(writes[0].path, "/api/players/p1/triggers/t1");
    assert.equal(writes[0].body.steps[0].message, "Welcome back, {player_name} — VIP until {vip_until}");
    assert.equal(writes[0].body.fireOnce, false, "every field comes back as it was unless changed");
    assert.equal(writes[0].body.note, "old note");

    // Deleting the trigger that is open in the builder ends the edit — no Save left pointing at nothing.
    await page.locator("button", { hasText: /^Edit$/ }).first().click();
    await page.locator("button", { hasText: "Save changes" }).waitFor();
    await page.locator("tbody button", { hasText: /^Delete$/ }).first().click();
    await page.locator(".confirm-modal button", { hasText: /^Delete$/ }).click();
    await page.locator("button", { hasText: "Save changes" }).waitFor({ state: "detached" });
    assert.ok(await page.locator("button", { hasText: "Arm this trigger" }).isVisible(), "the builder is back to making a new one");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A player trigger on a roster condition ("when Flyboy plays a role"). The role chips are the
 * PLAYER's game's (a Vietnam Pilot is role 16, and so is a WW2 Gunner, the selected server's), only
 * the conditions their game has are offered, saving sends the chosen roles, and another condition
 * opens with its Rules trigger's own form.
 */
test("a player trigger on a roster condition offers the player's game's roles and saves them", { skip: SKIP }, async () => {
  const trig = {
    id: "t9", playerId: "p9", playerName: "Flyboy", serverId: null, serverName: null, event: "role", params: { roles: [16] },
    steps: [{ action: "message", message: "Off the chopper, {player_name}", hours: 0, points: 0, delaySec: 0 }],
    fireOnce: false, enabled: true, note: null, createdByName: "KREITZ", createdAt: "2026-10-10T16:57:19Z",
    firedCount: 0, lastFiredAt: null, disarmedAt: null, summary: "on playing Pilot, message (every time)",
  };
  const game = (id, roles) => ({ descriptor: { id, label: id, sides: [], scoreFields: [], squadLeaderRoles: [], squadLabel: "Squad", configFields: [], roles } });
  const overrides = {
    "/api/player-triggers": { body: { triggers: [trig] } },
    "/api/players/p9/triggers": { body: { triggers: [trig], allowedActions: ["message", "kick"], game: "hllv", rosterEvents: ["role", "lowlevel", "soloheli"] } },
    "/api/players/p9/triggers/t9": { body: { trigger: trig } },
    "/api/games/hll/descriptor": { body: game("hll", { 0: "Rifleman", 16: "Gunner" }) },
    "/api/games/hllv/descriptor": { body: game("hllv", { 0: "Rifleman", 16: "Pilot", 17: "Logistics Officer" }) },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/triggers`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: /^Edit$/ }).first().click();
    // The trigger's own role, already picked, named in the player's game.
    await page.locator(".chip-btn", { hasText: "✓ Pilot" }).waitFor();
    assert.equal(await page.locator(".chip-btn", { hasText: "Gunner" }).count(), 0, "the selected server's roles are not the player's");
    const offered = await page.locator('optgroup[label^="Something about them"] option').evaluateAll((os) => os.map((o) => o.value));
    assert.deepEqual(offered, ["role", "lowlevel", "soloheli"], "only the conditions the player's game has");

    await page.locator(".chip-btn", { hasText: /^Logistics Officer$/ }).click();
    await page.locator("button", { hasText: "Save changes" }).click();
    await page.locator("button", { hasText: "Save changes" }).waitFor({ state: "detached" });
    const writes = stub.calls.filter((c) => c.path.startsWith("/api/players/p9/triggers") && c.method !== "GET");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PUT");
    assert.equal(writes[0].body.event, "role");
    assert.deepEqual(writes[0].body.params, { roles: [16, 17] }, "the edit carries both roles");

    // Another condition opens with its Rules trigger's own knobs.
    await page.locator("button", { hasText: /^Edit$/ }).first().click();
    await page.locator('select:has(optgroup[label^="Something about them"])').selectOption("lowlevel");
    await page.waitForSelector("text=Minimum level to play");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Auto settings → Game rewards: the tab opens with every reward off and in dry run, a card can be
 * switched on and a tier added, and Save sends the whole thing.
 */
test("game rewards tab: switch kill streaks on, add a tier, save", { skip: SKIP }, async () => {
  const r = (points) => ({ vipHours: 0, points });
  const config = {
    topStats: { enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, broadcast: true, message: "m", categories: [{ id: "kills", enabled: true, ranks: [r(100)] }] },
    killStreaks: { enabled: false, dryRun: true, minPlayers: 20, message: "{streak} kills — {reward}", tiers: [{ kills: 10, reward: r(25) }] },
    playDays: { enabled: false, dryRun: true, minMinutes: 30, message: "m", tiers: [{ days: 3, reward: r(50) }], repeatEveryDays: 7 },
    seedDays: { enabled: false, dryRun: true, message: "m", tiers: [{ days: 3, reward: r(100) }], repeatEveryDays: 7 },
    matchEnd: { enabled: false, dryRun: true, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 0, reward: { vipHours: 24, points: 0 }, message: "m" },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/game-rewards": { body: { config, recent: [{ at: "2026-09-26T20:00:00Z", summary: "[dry-run] would reward Ace with 25 Points — 10-kill streak", player: "Ace" }] } } } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/gamerewards`, { waitUntil: "networkidle" });
    const card = page.locator('[data-panel-id="gamerewards-streaks"], .panel', { hasText: "Kill streaks" }).first();
    await card.waitFor();
    assert.match(await page.locator("body").innerText(), /would reward Ace/, "recent rewards are listed");
    await card.locator(".toggle, [role=switch], label", { hasText: /^Off$/ }).first().click();
    await card.locator("button", { hasText: "+ Add a tier" }).click();
    await page.locator("button", { hasText: /^Save$/ }).first().click();
    await page.waitForFunction(() => window.document.body.innerText.includes("Saved."));
    const put = stub.calls.find((c) => c.method === "PUT" && c.path === "/api/servers/s1/game-rewards");
    assert.ok(put, "saved");
    assert.equal(put.body.killStreaks.enabled, true);
    assert.equal(put.body.killStreaks.dryRun, true, "still a dry run until someone switches it live");
    assert.deepEqual(put.body.killStreaks.tiers.map((t) => t.kills), [10, 20]);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The message order is the SAVED one; a staff member's own card arrangement only replaces it when
 * they press "Use this arrangement". A save for any other reason must not quietly re-order it.
 */
test("game rewards: saving other changes keeps the saved message order; adopting an arrangement is a choice", { skip: SKIP }, async () => {
  const r = (vipHours) => ({ vipHours, points: 0 });
  const config = {
    order: ["topStats", "matchEnd", "bestSquads", "killStreaks", "playDays", "seedDays"],
    topStats: { enabled: true, dryRun: true, minMinutes: 20, minPlayers: 40, broadcast: true, message: "m", categories: [{ id: "kills", enabled: true, ranks: [r(12)] }] },
    bestSquads: { enabled: false, dryRun: true, minMinutes: 20, minPlayers: 40, minMembers: 2, metric: "score", scoring: "total", broadcast: true, showEveryone: true, message: "m", types: [{ id: "armor", enabled: true, ranks: [r(12)] }] },
    killStreaks: { enabled: false, dryRun: true, minPlayers: 20, message: "m", tiers: [] },
    playDays: { enabled: false, dryRun: true, minMinutes: 30, message: "m", tiers: [], repeatEveryDays: 7 },
    seedDays: { enabled: false, dryRun: true, message: "m", tiers: [], repeatEveryDays: 7 },
    matchEnd: { enabled: true, dryRun: true, minMatchMinutes: 60, minPlayedMinutes: 0, minPlayers: 0, reward: r(24), message: "m" },
  };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/servers/s1/game-rewards": { body: { config, recent: [] } } } }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/autosettings/gamerewards`, { waitUntil: "networkidle" });
    await page.locator("text=Match-end message order now").waitFor();
    assert.match(await page.locator("body").innerText(), /Top stats → Everyone at match end/);
    const save = page.locator("button", { hasText: /^Save$/ }).first();
    assert.equal(await save.isDisabled(), true, "a different layout alone is not an unsaved change");

    const end = page.locator(".panel").filter({ has: page.locator(".panel-head", { hasText: "Everyone at match end" }) }).first();
    await end.locator("textarea").first().fill("typo fixed");
    await save.click();
    await page.waitForFunction(() => window.document.body.innerText.includes("Saved."));
    const puts = () => stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/servers/s1/game-rewards");
    assert.deepEqual(puts()[0].body.order, config.order, "fixing a typo kept the saved order");

    await page.locator("button", { hasText: "Use this arrangement for messages" }).click();
    await save.click();
    await page.waitForFunction(() => window.document.body.innerText.split("Saved.").length > 1);
    const last = puts()[puts().length - 1];
    assert.deepEqual(last.body.order, ["matchEnd", "topStats", "bestSquads", "killStreaks", "playDays", "seedDays"], "the arrangement on screen, once chosen");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * Screens load on demand, so a panel updated under an open tab asks for screen files that are
 * gone. The screen area reloads the page once by itself; when the file is still missing it says
 * so with a Reload button — the sidebar stays, never a blank page — and going to another screen
 * clears it.
 */
test("a tab whose code cannot be fetched clears when another tab of the same section is picked", { skip: SKIP }, async () => {
  /*
   * The failure notice takes the whole screen area, the section's own tab bar with it, so the way
   * out is the sidebar's sub-items. It used to clear only when the DESTINATION changed: picking
   * Game log after Matches failed kept the notice up, and the only ways out were Reload or leaving
   * History altogether.
   */
  await withPage({ grants: OWNER_GRANTS }, async (page) => {
    const base = page.url().split("#")[0];
    await page.goto(`${base}#/history/logs`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hub-tabs", { timeout: 15_000 });
    // History and its Game log tab have arrived; any other screen file stands for one an update removed.
    const known = new Set(await page.evaluate(() => performance.getEntriesByType("resource")
      .map((e) => e.name).filter((n) => n.includes("/_next/static/chunks/"))));
    await page.route("**/_next/static/chunks/**", (route) => known.has(route.request().url()) ? route.continue() : route.abort());
    let loads = 0;
    page.on("load", () => { loads += 1; });
    const reloaded = page.waitForEvent("load", { timeout: 15_000 });
    await page.goto(`${base}#/history/matches`);
    await reloaded;
    await page.waitForSelector("text=The panel was updated while this tab was open", { timeout: 15_000 });
    assert.equal(await page.locator(".hub-tabs").count(), 0, "the notice stands in for the whole section, tab bar included");

    await page.unroute("**/_next/static/chunks/**");
    await page.goto(`${base}#/history/logs`); // the sidebar's Game log
    await page.waitForFunction(() => !window.document.body.innerText.includes("The panel was updated while this tab was open"), null, { timeout: 15_000 });
    await page.waitForSelector(".hub-tabs", { timeout: 15_000 });
    assert.equal(loads, 1, "no further reloads");
  });
});

/*
 * The plugin guide (docs/plugins.md) gives a screen for anyone to copy. Here it is, as written in the
 * guide, drawn inside the real panel the way a plugin's screen is: listed by the API, its code sent
 * as text, the panel's own React and kit handed to it. The API test beside this one loads the rest
 * of that plugin; together they keep the guide's example working.
 */
test("the plugin guide's example screen draws in the panel as the guide says", { skip: SKIP }, async () => {
  const guide = await readFile(join(here, "..", "..", "..", "docs", "plugins.md"), "utf8");
  const script = /^\*\*`hello\/page\.js`\*\*\n\n```js\n([\s\S]*?)\n```$/m.exec(guide)?.[1];
  const blurb = /^\s*blurb: "([^"]+)",$/m.exec(guide)?.[1];
  assert.ok(script && blurb, "the guide has the screen's code and its one-line description");
  const listed = { plugin: "hello", id: "hello", title: "Hello", section: "Monitor", blurb, permission: "hello.view", outright: false, ownerOnly: false };
  await withPage({
    grants: OWNER_GRANTS,
    overrides: {
      "/api/plugin-pages": { body: { pages: [listed] } },
      "/api/plugin-pages/hello/hello": { body: { script } },
      "/api/plugins/hello/greeting": { body: { text: "Hello, tester!", visits: 3 } },
    },
  }, async (page, { errors }) => {
    const group = (label) => page.locator(".nav-group", { has: page.locator(".nav-group-label", { hasText: label }) });
    await group("Monitor").locator(".nav-item", { hasText: "Hello" }).click({ timeout: 15_000 });
    await page.waitForFunction(() => /Hello, tester! Visit 3\./.test(window.document.body.innerText), null, { timeout: 15_000 });
    assert.equal(new URL(page.url()).hash, "#/hello");
    const header = await page.locator(".page-header").innerText();
    assert.match(header, /Hello/);
    assert.ok(header.includes(blurb), `the header carries the screen's description: ${header}`);
    assert.equal(await page.locator(".card", { hasText: "Hello, tester! Visit 3." }).count(), 1, "in a card, styled like the rest of the panel");
    assert.deepEqual(errors, [], errors.join("\n"));
  });
});

/*
 * More lists download: the game log — chat included, through its own filter — and staff activity
 * over a time range picked in the popup, read whole however many pages that takes; and the
 * watchlist as it stands.
 */
test("the game log and staff activity download over a time range, the watchlist as it stands", { skip: SKIP }, async () => {
  const at = "2026-10-20T18:30:00.000Z";
  const chats = Array.from({ length: 600 }, (_, i) => ({ ts: at, kind: "evt.chat.team", actorName: `Player ${i}`, actorPlayerId: `7656119800000${String(i).padStart(4, "0")}`, data: { message: `hello ${i}` } }));
  const logAsks = [];
  const auditAsks = [];
  await withPage({ grants: OWNER_GRANTS, overrides: {
    "/api/servers/s1/events": (url) => {
      const p = Object.fromEntries(url.searchParams);
      logAsks.push(p);
      const offset = Number(p.offset ?? 0);
      return { body: { events: chats.slice(offset, offset + Number(p.limit ?? 100)), total: chats.length, anchor: "2026-10-23T00:00:00.000Z" } };
    },
    "/api/audit": (url) => {
      auditAsks.push(Object.fromEntries(url.searchParams));
      return { body: { entries: [{ id: "a1", ts: at, actorUserId: "u1", actorName: "owner", action: "player.kick", targetType: "player", targetId: "p1", targetName: "Caereca", targetPlatformId: "76561198000000001", serverId: "s1", summary: "kicked Caereca for spawn camping" }], total: 1, anchor: "2026-10-23T00:00:00.000Z" } };
    },
    "/api/players/flagged": { body: { flags: [{ playerId: "p9", name: "Sus Guy", online: true, onlineServers: ["Test Server #1"], watchBy: "owner", watchAt: at,
      reasons: [{ id: "r1", reason: "aimbot reports", addedBy: "owner", addedAt: at, expiresAt: null }] }] } },
  } }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const popup = page.locator(".pa-modal");
    const save = async () => {
      const [file] = await Promise.all([page.waitForEvent("download"), popup.getByRole("button", { name: "Download", exact: true }).click()]);
      await popup.waitFor({ state: "detached" });
      return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
    };
    const day = String.raw`\d{4}-\d{2}-\d{2}`;

    // The game log's chat, over the last week: two pages, both on the first one's snapshot.
    await page.goto(`${base}#/history/logs`, { waitUntil: "networkidle" });
    await page.click(".seg-btn:has-text('Chat')");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await popup.waitFor();
    assert.equal(await popup.locator("select").nth(1).inputValue(), "24h", "the last day, unless picked otherwise");
    assert.match(await popup.innerText(), /Every line matching the log's category, search and player, in the time range picked\./);
    // Dates the wrong way round are said, and nothing is read.
    await popup.locator("select").nth(1).selectOption("custom");
    await popup.locator("input[type=datetime-local]").first().fill("2026-10-22T10:00");
    await popup.locator("input[type=datetime-local]").nth(1).fill("2026-10-21T10:00");
    const before = logAsks.length;
    await popup.getByRole("button", { name: "Download", exact: true }).click();
    await popup.getByText("The start has to come before the end.").waitFor();
    assert.equal(logAsks.length, before);
    await popup.locator("select").nth(1).selectOption("7d");
    const asked = logAsks.length;
    const log = await save();
    assert.match(log.name, new RegExp(`^game-log-test-server-1-chat-${day}\\.xlsx$`));
    const reads = logAsks.slice(asked);
    assert.deepEqual(reads.map((r) => [r.offset, r.anchor]), [["0", undefined], ["500", "2026-10-23T00:00:00.000Z"]]);
    assert.equal(reads[0].kinds, "evt.chat.team,evt.chat.squad");
    const from = Date.parse(reads[0].from);
    assert.ok(Math.abs(from - (Date.now() - 7 * 86_400_000)) < 60_000, `a week back, got ${reads[0].from}`);
    const sheet = unzipStored(log.bytes).get("xl/worksheets/sheet1.xml");
    assert.match(sheet, /<row r="601">/, "all 600 lines, under the heading");
    assert.match(sheet, />Team chat message</);
    assert.match(sheet, />hello 599</);

    // Staff activity, all of it, as JSON.
    await page.goto(`${base}#/admin/activity`, { waitUntil: "networkidle" });
    const trailPanel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Trail$/ }) });
    await trailPanel.getByRole("button", { name: "Download", exact: true }).click();
    await popup.waitFor();
    await popup.locator("select").first().selectOption("json");
    await popup.locator("select").nth(1).selectOption("all");
    const auditAsked = auditAsks.length;
    const trail = await save();
    assert.match(trail.name, new RegExp(`^staff-activity-test-server-1-${day}\\.json$`), "the server the trail is narrowed to");
    assert.equal(auditAsks[auditAsked].from, undefined, "everything: no start");
    assert.deepEqual(JSON.parse(trail.bytes.toString("utf8")), [{
      time: at, staff: "owner", action: "player.kick", target: "Caereca", targetGameId: "76561198000000001", server: "Test Server #1", detail: "kicked Caereca for spawn camping",
    }]);

    // The watchlist, as CSV.
    await page.goto(`${base}#/moderation/watched`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await popup.waitFor();
    await popup.locator("select").first().selectOption("csv");
    const watch = await save();
    assert.match(watch.name, new RegExp(`^watchlist-${day}\\.csv$`));
    assert.match(watch.bytes.toString("utf8"), /^\uFEFFPlayer,Player ID,Reasons,Watched by,Watched since \(.+\),Online now\r\nSus Guy,p9,aimbot reports \(owner\),owner,2026-10-2\d \d\d:30,Test Server #1\r\n$/);
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

test("phone notifications stay off until the switch is tapped, and each person picks which ones come", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me/push": (url) => (url ? { body: { key: PUSH_KEY, devices: [] } } : undefined) } }, async (page, { stub, errors }) => {
    await page.addInitScript(fakePush);
    // A new page, so the stand-in is in place before the panel loads (a hash change is not one).
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    const sw = page.getByRole("checkbox", { name: "On this device" });
    await sw.waitFor({ state: "attached" });
    assert.equal(await sw.isChecked(), false, "off to begin with");
    assert.equal(await page.evaluate(() => window.__push.asked), 0, "nothing asked before a tap");
    assert.ok(!stub.calls.some((c) => c.path === "/api/me/push" && c.method === "PUT"), "nothing sent before a tap");

    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").click();
    await page.waitForFunction(() => window.__push.sub !== null);
    const put = await (async () => {
      for (let i = 0; i < 100; i++) {
        const c = stub.calls.find((x) => x.path === "/api/me/push" && x.method === "PUT");
        if (c) return c;
        await page.waitForTimeout(30);
      }
      return null;
    })();
    assert.ok(put, "the subscription is handed to the panel's server");
    assert.equal(put.body.endpoint, "https://fcm.googleapis.com/fcm/send/device-1");
    assert.deepEqual(put.body.keys, { p256dh: "BPUB", auth: "AUTH" });
    assert.equal(put.body.origin, stub.base, "the address the panel is open at");
    assert.deepEqual(await page.evaluate(() => window.__push.key), [4, ...Array.from({ length: 64 }, (_, i) => i + 1)], "subscribed with the install's key");
    assert.equal(await page.evaluate(() => window.__push.asked), 1);

    // On: the first three choices on, the four that came later off until picked, and a test.
    for (const label of ["A player on the watchlist joins a server", "A request needs your approval", "A server stops answering, and when it's back"]) {
      assert.equal(await page.getByRole("checkbox", { name: label }).isChecked(), true, label);
    }
    for (const label of ["A player asks for an admin in chat", "The automatic rules kick or ban a player", "A server starts seeding, and when it goes live", "A request you sent is approved or denied", "A staff member bans a player", "A player is banned for good", "A staff member changes a setting", "A notice is posted for staff", "An admin goes into the admin camera", "A member buys something in the shop"]) {
      assert.equal(await page.getByRole("checkbox", { name: label }).isChecked(), false, label);
    }
    const saved = async (n) => {
      for (let i = 0; i < 100; i++) {
        const prefs = stub.calls.filter((c) => c.path === "/api/me/prefs" && c.body?.phoneAlerts);
        if (prefs.length >= n) return prefs[n - 1].body.phoneAlerts;
        await page.waitForTimeout(30);
      }
      return null;
    };
    await page.locator(".phone-alerts label.toggle", { hasText: "A player on the watchlist joins" }).click();
    assert.deepEqual(await saved(1), { watch: false, requests: true, servers: true, admin: false, automod: false, seeding: false, decided: false, bans: false, permabans: false, settings: false, notices: false, camera: false, shop: false, banRoles: [] }, "kept with the account's own settings");
    await page.locator(".phone-alerts label.toggle", { hasText: "A player asks for an admin in chat" }).click();
    assert.deepEqual(await saved(2), { watch: false, requests: true, servers: true, admin: true, automod: false, seeding: false, decided: false, bans: false, permabans: false, settings: false, notices: false, camera: false, shop: false, banRoles: [] }, "picked");
    assert.equal(await page.getByRole("checkbox", { name: "A player asks for an admin in chat" }).isChecked(), true);
    await page.getByRole("button", { name: "Send a test" }).click();
    await page.getByText("Sent. It should arrive in a few seconds.").waitFor();
    assert.equal(stub.calls.find((c) => c.path === "/api/me/push/test")?.body.endpoint, "https://fcm.googleapis.com/fcm/send/device-1");

    // Off: forgotten by the server and by the browser.
    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").first().click();
    await page.waitForFunction(() => window.__push.sub === null);
    assert.equal(stub.calls.find((c) => c.path === "/api/me/push/off")?.body.endpoint, "https://fcm.googleapis.com/fcm/send/device-1");
    assert.deepEqual(errors, []);
  });
});

test("signing out turns this device's notifications off", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me/push": { body: { key: PUSH_KEY, devices: [] } } } }, async (page, { stub }) => {
    await page.addInitScript(fakePush);
    // A new page, so the stand-in is in place before the panel loads (a hash change is not one).
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").click();
    await page.waitForFunction(() => window.__push.sub !== null);
    await page.locator(".settings-trigger").click();
    await page.getByRole("menuitem", { name: /Log out/ }).click();
    const off = async () => stub.calls.find((c) => c.path === "/api/me/push/off");
    for (let i = 0; i < 100 && !(await off()); i++) await page.waitForTimeout(30);
    assert.equal((await off())?.body.endpoint, "https://fcm.googleapis.com/fcm/send/device-1", "the server forgets the device as the sign-in ends");
  });
});

test("choices saved before the later notifications came keep those off until picked", { skip: SKIP }, async () => {
  // Saved by an earlier version, which had only the first three to choose from.
  const me = { body: { user: { id: "u1", username: "owner", displayName: "owner" }, limits: {}, roles: [], grants: OWNER_GRANTS,
    prefs: { phoneAlerts: { watch: false, requests: true, servers: true } } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": me, "/api/me/push": { body: { key: PUSH_KEY, devices: [] } } } }, async (page, { stub }) => {
    await page.addInitScript(fakePush);
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").click();
    await page.waitForFunction(() => window.__push.sub !== null);
    const box = (label) => page.getByRole("checkbox", { name: label });
    await box("A player asks for an admin in chat").waitFor({ state: "attached" });
    assert.equal(await box("A player on the watchlist joins a server").isChecked(), false, "as they left it");
    assert.equal(await box("A request needs your approval").isChecked(), true, "as they left it");
    for (const label of ["A player asks for an admin in chat", "The automatic rules kick or ban a player", "A server starts seeding, and when it goes live", "A request you sent is approved or denied", "A staff member bans a player", "A player is banned for good", "A staff member changes a setting", "A notice is posted for staff", "An admin goes into the admin camera", "A member buys something in the shop"]) {
      assert.equal(await box(label).isChecked(), false, `${label}: off, as the server reads it, until picked`);
    }
  });
});

test("staff bans can be narrowed to the roles a person picks; a removed role stays listed until unticked", { skip: SKIP }, async () => {
  const me = { body: { user: { id: "u1", username: "owner", displayName: "owner" }, limits: {}, roles: [], grants: OWNER_GRANTS,
    prefs: { phoneAlerts: { bans: true, banRoles: ["gone"] } } } };
  const roles = { body: { roles: [{ id: "r-trial", name: "Trial mod", grants: [], limits: {}, members: 3 }, { id: "r-senior", name: "Senior admin", grants: [], limits: {}, members: 1 }] } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": me, "/api/roles": roles, "/api/me/push": { body: { key: PUSH_KEY, devices: [] } } } }, async (page, { stub, errors }) => {
    await page.addInitScript(fakePush);
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").click();
    await page.waitForFunction(() => window.__push.sub !== null);
    const group = page.getByRole("group", { name: "Only bans by these roles" });
    await group.waitFor();
    assert.deepEqual((await group.locator(".toggle-label").allTextContents()).map((s) => s.trim()), ["Trial mod", "Senior admin", "A role that was removed"]);
    assert.equal(await group.getByRole("checkbox", { name: "A role that was removed" }).isChecked(), true, "still in force until unticked");
    const saved = () => stub.calls.filter((c) => c.path === "/api/me/prefs" && c.body?.phoneAlerts).at(-1)?.body.phoneAlerts.banRoles;
    await group.locator("label.toggle", { hasText: "Trial mod" }).click();
    for (let i = 0; i < 100 && !(saved() ?? []).includes("r-trial"); i++) await page.waitForTimeout(30);
    assert.deepEqual(saved(), ["gone", "r-trial"]);
    await group.locator("label.toggle", { hasText: "A role that was removed" }).click();
    for (let i = 0; i < 100 && (saved() ?? []).includes("gone"); i++) await page.waitForTimeout(30);
    assert.deepEqual(saved(), ["r-trial"]);
    assert.equal(await group.getByRole("checkbox", { name: "A role that was removed" }).count(), 0, "gone once unticked");
    // Staff bans off: no roles to pick.
    await page.locator(".phone-alerts > label.toggle", { hasText: "A staff member bans a player" }).click();
    await group.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  });

  // The list of roles could not be read: the picks stand, none reads as removed, and it says why.
  const failed = { status: 500, body: { error: { code: "internal", message: "The roles could not be read." } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": { body: { ...me.body, prefs: { phoneAlerts: { bans: true, banRoles: ["r-trial"] } } } }, "/api/roles": failed, "/api/me/push": { body: { key: PUSH_KEY, devices: [] } } } }, async (page, { stub }) => {
    await page.addInitScript(fakePush);
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".setting-switch", { hasText: "On this device" }).locator("label.toggle").click();
    await page.waitForFunction(() => window.__push.sub !== null);
    await page.getByText("The list of roles couldn't be loaded, so the roles can't be picked right now.").waitFor();
    assert.equal(await page.getByRole("group", { name: "Only bans by these roles" }).count(), 0);
    assert.equal(await page.getByText("A role that was removed").count(), 0, "a role it could not read about is not called removed");
    assert.ok(!stub.calls.some((c) => c.path === "/api/me/prefs" && c.body?.phoneAlerts), "and nothing was saved");
  });
});

test("a computer someone else turned notifications on for stays off for the next person who signs in", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me/push": { body: { key: PUSH_KEY, devices: [] } } } }, async (page, { stub }) => {
    await page.addInitScript(fakePush);
    await page.addInitScript(() => {
      // Left behind by whoever was signed in here before: their subscription, with their name on it.
      window.localStorage.setItem("panel.push.owner", "someone-else");
      const endpoint = "https://fcm.googleapis.com/fcm/send/theirs";
      window.__push.permission = "granted";
      window.__push.sub = {
        endpoint, options: { applicationServerKey: null },
        toJSON: () => ({ endpoint, keys: { p256dh: "X", auth: "Y" } }),
        unsubscribe: async () => { window.__push.sub = null; window.__push.unsubscribed += 1; return true; },
      };
    });
    await page.goto(`${stub.base}/#/settings`);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__push.unsubscribed === 1);
    assert.ok(!stub.calls.some((c) => c.path === "/api/me/push" && c.method === "PUT"), "not handed over as this person's");
    assert.equal(await page.getByRole("checkbox", { name: "On this device" }).isChecked(), false, "off, for them to turn on if they want");
  });
});

/*
 * Every walkthrough step points at something that is really on its screen, for someone holding just
 * that walkthrough's permissions — set up exactly as its picture was taken (test/walk-stage.mjs).
 * A button renamed or moved fails here, naming the step, rather than leaving Help ringing a
 * control that is not there any more.
 */
test("every walkthrough step points at a control that is on its screen", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page) => {
    const browser = page.context().browser();
    const missing = [];
    const queue = [...WALKTHROUGHS];
    // Four walkthroughs at a time, each against a stub holding its own permissions.
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        // In the state each step is about (its `stage`), as its picture is taken.
        const grants = walkGrants(w);
        const overrides = { ...WALK_FIXTURES };
        const stub = await startStub({ grants, overrides });
        const fresh = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        try {
          await fresh.addInitScript(() => window.localStorage.setItem("panel.token", "test-token"));
          for (const [n, step] of w.steps.entries()) {
            setStage(overrides, step, grants);
            const { el, why } = await stageStep(fresh, stub.base, step, n);
            if (el) await el.dispose();
            else missing.push(`${w.id} step ${n + 1}: ${why}`);
            // What Show me sets first (the Roster's Scoreboard) is on that screen too.
            for (const t of step.setup ?? []) {
              const sw = await findIn(fresh, t);
              if (sw) await sw.dispose();
              else missing.push(`${w.id} step ${n + 1}: what it sets first, ${JSON.stringify(t)}, is not there`);
            }
          }
        } finally {
          await fresh.close();
          await stub.close();
        }
      }
    }));
    assert.deepEqual(missing, [], `steps whose control is not on the screen:\n${missing.join("\n")}`);
  });
});

/*
 * A step names a panel by its name. A count or a choice can follow the name in the title ("Every map
 * (16)", "Players · [ABC]"), and that differs from one server to the next: the step finds the panel
 * whatever follows — here a catalogue of three maps, not the test server's sixteen.
 */
test("a walkthrough step finds a panel whose title carries a count, whatever the count", { skip: SKIP }, async () => {
  const walk = WALKTHROUGHS.find((w) => w.id === "see-maps");
  const step = walk.steps.find((s) => s.target.panel === "Every map" && !s.target.button);
  const mk = (id, prettyName) => ({ id, prettyName, mode: "warfare", environment: "day", family: id.split("_")[0], envGroup: "day" });
  const maps = [mk("foy_warfare", "Foy"), mk("kharkov_warfare", "Kharkov"), mk("hill400_warfare", "Hill 400")];
  const overrides = { ...WALK_FIXTURES, "/api/servers/s1/maps": { body: { maps, rotation: maps, current: maps[0], currentIndex: 0 } } };
  await withPage({ grants: walkGrants(walk), overrides }, async (page, { stub, errors }) => {
    const { el, why } = await stageStep(page, stub.base, step, 1);
    assert.ok(el, `the catalogue of three maps is found: ${why}`);
    assert.equal(await el.evaluate((e) => e.querySelector(".panel-title").textContent.trim()), "Every map (3)");
    assert.deepEqual(errors, []);
  });
});

test("Start here lists only the walkthroughs a person's permissions allow, and plays one as a slideshow", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("action.kick")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    const cards = page.locator(".walk-card-title");
    await cards.first().waitFor();
    assert.deepEqual(await cards.allTextContents(), [
      "Personal setup",
      "Find your way around", "Find help in the panel", "Use a screen's panels and lists", "Change your settings", "Change your password", "Read the staff notices", "Make the dashboard yours", "Do staff work from Discord", "Ask for what you cannot do yourself",
      "Kick a player", "Act on several players at once", "Watch a server live", "Look back at a round", "Read the game log",
      "Find a player", "See the leaderboard", "See the clans", "See the player triggers", "Change or remove a player trigger", "See the map in play", "See every map",
    ], "their setup, what everyone can do, and what they hold, nothing else");

    await page.locator(".walk-card", { hasText: "Kick a player" }).click();
    const dialog = page.getByRole("dialog", { name: "Kick a player" });
    await dialog.waitFor();
    const caption = dialog.locator(".walk-caption");
    // Five steps: where kicks are listed afterwards needs the staff trail, which they do not hold.
    assert.match(await caption.textContent(), /Step 1 of 5.*Open Live/);
    // The picture is the panel's own, and the ring is on it.
    const img = await dialog.locator(".walk-stage img").elementHandle();
    await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, img);
    const stage = await dialog.locator(".walk-stage").boundingBox();
    const ring = await dialog.locator(".walk-ring").boundingBox();
    assert.ok(ring.width > 0 && ring.x >= stage.x && ring.y >= stage.y && ring.x + ring.width <= stage.x + stage.width + 1 && ring.y + ring.height <= stage.y + stage.height + 1, "the ring sits on the picture");

    await dialog.getByRole("button", { name: "Next" }).click();
    assert.match(await caption.textContent(), /Step 2 of 5.*⋯/);
    await page.keyboard.press("ArrowRight");
    assert.match(await caption.textContent(), /Step 3 of 5.*Choose Kick/);
    await dialog.getByRole("button", { name: "Back" }).click();
    assert.match(await caption.textContent(), /Step 2 of 5/);
    await dialog.getByRole("button", { name: "Step 5", exact: true }).click();
    assert.match(await caption.textContent(), /Step 5 of 5.*Kick player/);
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  });
});

/*
 * "Show me on my screen" plays the walkthrough on the panel itself: the step's screen opens, its
 * control is ringed, and pressing that control moves on to the next step. The panel presses nothing
 * on anyone's behalf: a step whose control is not there yet says so and waits for it, a field waits
 * for Next, and ending it part way leaves whatever was open untouched.
 */
test("Show me on my screen rings each control on the panel and moves on as it is pressed", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("action.kick")], overrides: WALK_FIXTURES }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Kick a player" }).click();
    const slides = page.getByRole("dialog", { name: "Kick a player" });
    await slides.getByRole("button", { name: "Next" }).click();
    await slides.getByRole("button", { name: "Show me on my screen" }).click();
    await slides.waitFor({ state: "detached" });

    const note = page.getByRole("complementary", { name: "Walkthrough" });
    /** Wait for the ring to stand tight around this control. */
    const ringed = async (loc) => {
      const el = await loc.elementHandle();
      await page.waitForFunction((t) => {
        const ring = window.document.querySelector(".spot-ring");
        if (!ring) return false;
        const a = ring.getBoundingClientRect();
        const b = t.getBoundingClientRect();
        return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1 && a.width <= b.width + 14;
      }, el, { timeout: 5000 });
    };
    const more = page.locator('.player-actions button[aria-label="More"]').first();

    // From the step the slideshow was on: Live opens, and the row's ⋯ is ringed.
    await page.waitForFunction(() => window.location.hash.startsWith("#/live"));
    await ringed(more);
    await note.getByText("Step 2 of 5").waitFor();
    // Back to opening Live, and pressing it moves on.
    await note.getByRole("button", { name: "Back" }).click();
    await ringed(page.locator('.sidebar [data-route="live"]'));
    await page.locator('.sidebar [data-route="live"]').click();
    await ringed(more);

    // Next without opening the menu: Kick is not on the screen yet, and it says so.
    await note.getByRole("button", { name: "Next" }).click();
    await note.getByText("Not on your screen yet", { exact: false }).waitFor();
    assert.equal(await page.locator(".spot-ring").count(), 0, "nothing to ring");
    await more.click();
    const kick = page.locator(".pa-dropdown .pa-mi", { hasText: "Kick" });
    await ringed(kick);
    await kick.click();

    // In the dialog: the reason is for typing, so pressing into it does not move on.
    const dialog = page.getByRole("dialog", { name: /Kick player/ });
    await ringed(dialog.locator("label", { hasText: "Reason" }));
    await dialog.getByRole("textbox").first().click();
    await note.getByText("Step 4 of 5").waitFor();
    assert.equal(await note.getByText("Step 5 of 5").count(), 0, "still on the reason");
    await dialog.getByRole("textbox").first().fill("Teamkilling at spawn");
    await note.getByRole("button", { name: "Next" }).click();
    await ringed(dialog.getByRole("button", { name: "Kick player" }));

    // Done ends it with the dialog left as it was: nobody was kicked.
    await note.getByRole("button", { name: "Done" }).click();
    await note.waitFor({ state: "detached" });
    assert.equal(await page.locator(".spot-ring").count(), 0);
    await dialog.waitFor();
    assert.equal(stub.calls.filter((c) => c.method === "POST" && c.path.endsWith("/actions")).length, 0, "the walkthrough pressed nothing");
    assert.deepEqual(errors, []);
  });
});

/*
 * Getting started: each person is walked through their own settings once. Every choice applies the
 * moment it is made and is saved as Settings saves it; what is offered follows their permissions;
 * What's new waits until it is done; and it is not shown again — the account remembers, or this
 * device does when the account's save never landed.
 */
test("Getting started walks someone through their own settings once, applying each choice as it is made", { skip: SKIP }, async () => {
  const grants = [held("server.view", "read"), held("action.kick")];
  const me = (prefs) => ({ body: { user: { id: "u9", username: "newbie", displayName: "Newbie", createdAt: "2026-01-02T03:04:05.000Z" }, grants, limits: {}, roles: [], prefs } });
  let prefs = { setupSeen: 0, whatsNewSeen: 20 };
  await withPage({ grants, overrides: { ...WALK_FIXTURES, "/api/me": () => me(prefs) } }, async (page, { stub, errors }) => {
    const setup = page.getByRole("dialog", { name: "Getting started" });
    await setup.waitFor();
    assert.equal(await page.getByRole("dialog", { name: "What's new" }).count(), 0, "what changed waits until the setup is done");
    await setup.getByText("Welcome, Newbie").waitFor();
    await setup.getByRole("button", { name: "Let's start" }).click();

    // Each choice is on the panel the moment it is made.
    await setup.getByRole("button", { name: "Light", exact: true }).click();
    assert.equal(await page.evaluate(() => window.document.documentElement.getAttribute("data-theme")), "light");
    await setup.getByRole("button", { name: "Next" }).click();
    const textSize = () => page.evaluate(() => window.getComputedStyle(window.document.documentElement).fontSize);
    const before = await textSize();
    await setup.getByRole("button", { name: "Larger", exact: true }).click();
    assert.notEqual(await textSize(), before, "the text grew at once");
    await setup.getByRole("button", { name: "Cozy", exact: true }).click();
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByLabel("Times shown in").selectOption("Europe/London");
    await setup.getByRole("button", { name: "Next" }).click();
    // Where it opens: only screens this account can open.
    const landing = setup.getByLabel("Open the panel on");
    const offered = await landing.locator("option").allTextContents();
    assert.ok(offered.includes("Live") && !offered.includes("Administration"), offered.join(", "));
    await landing.selectOption({ label: "Live" });
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByRole("button", { name: "Top", exact: true }).click();
    await setup.getByRole("button", { name: "Next" }).click();

    // What they can do: their own walkthroughs, playable here, and back to the setup after.
    assert.deepEqual(await setup.locator(".walk-card-title").allTextContents(), [
      "Find your way around", "Find help in the panel", "Use a screen's panels and lists", "Change your settings", "Change your password", "Read the staff notices", "Make the dashboard yours", "Do staff work from Discord", "Ask for what you cannot do yourself",
      "Kick a player", "Act on several players at once", "Watch a server live", "Look back at a round", "Read the game log",
      "Find a player", "See the leaderboard", "See the clans", "See the player triggers", "Change or remove a player trigger", "See the map in play", "See every map",
    ]);
    await setup.locator(".walk-card", { hasText: "Kick a player" }).click();
    const slides = page.getByRole("dialog", { name: "Kick a player" });
    await slides.getByRole("button", { name: "Step 5", exact: true }).click();
    await slides.getByRole("button", { name: "Done" }).click();
    await setup.getByText("What you can do").waitFor();
    await setup.getByRole("button", { name: "Next" }).click();
    await setup.getByText("Finding your way around").waitFor();
    await setup.getByRole("button", { name: "Finish" }).click();
    await setup.waitFor({ state: "detached" });

    // Every choice reached the account, as Settings saves it, and then the setup was marked seen.
    const saved = Object.assign({}, ...stub.calls.filter((c) => c.method === "PUT" && c.path === "/api/me/prefs").map((c) => c.body));
    assert.deepEqual(
      { themeMode: saved.themeMode, fontScale: saved.fontScale, density: saved.density, timeZone: saved.timeZone, landing: saved.landing, phoneBar: saved.phoneBar, setupSeen: saved.setupSeen },
      { themeMode: "light", fontScale: 1.25, density: "cozy", timeZone: "Europe/London", landing: "live", phoneBar: "top", setupSeen: 1 },
    );
    // What's new had waited: it comes now.
    await page.getByRole("dialog", { name: "What's new" }).waitFor();
    await page.getByRole("button", { name: "Got it" }).click();

    // Not again: the account has been through it, or this device has.
    for (const [account, why] of [[1, "the account has been through it"], [0, "the account's save never landed: this device knows"]]) {
      prefs = { setupSeen: account, whatsNewSeen: 21 };
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      assert.equal(await setup.count(), 0, why);
    }
    assert.deepEqual(errors, []);
  });
});

test("Getting started can be skipped, and opened again from Help to show the way around", { skip: SKIP }, async () => {
  const me = { body: { user: { id: "u8", username: "skipper", displayName: "skipper" }, grants: OWNER_GRANTS, limits: {}, roles: [], prefs: { setupSeen: 0 } } };
  await withPage({ grants: OWNER_GRANTS, overrides: { "/api/me": me } }, async (page, { stub, errors }) => {
    const setup = page.getByRole("dialog", { name: "Getting started" });
    await setup.waitFor();
    await setup.getByRole("button", { name: "Skip setup" }).click();
    await setup.waitFor({ state: "detached" });
    assert.equal(stub.calls.filter((c) => c.path === "/api/me/prefs" && c.body?.setupSeen === 1).length, 1, "skipping counts as seen");

    await page.goto(`${page.url().split("#")[0]}?visit=2#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Personal setup" }).waitFor();
    assert.equal(await setup.count(), 0, "skipped once is skipped");
    await page.locator(".walk-card", { hasText: "Personal setup" }).click();
    await setup.waitFor();
    // To the end, and out onto the panel: the way around is pointed out on the screen itself.
    for (let i = 0; i < 7; i++) await setup.getByRole("button", { name: /^(Let's start|Next)$/ }).click();
    await setup.getByRole("button", { name: "Show me around" }).click();
    await setup.waitFor({ state: "detached" });
    const note = page.getByRole("complementary", { name: "Walkthrough" });
    await note.getByText("Find your way around").waitFor();
    await page.locator(".spot-ring").waitFor();
    assert.deepEqual(errors, []);
  });
});

/*
 * Show me around, at the end of Getting started, points the way around out on the screen itself.
 * What's new waited for the setup; it waits for that walkthrough too, rather than covering what it
 * points at, and comes once it is over.
 */
test("What's new waits while Show me around points the way out, and comes when it is over", { skip: SKIP }, async () => {
  const grants = [held("server.view", "read")];
  const me = { body: { user: { id: "u7", username: "touring", displayName: "Touring", createdAt: "2026-01-02T03:04:05.000Z" }, grants, limits: {}, roles: [], prefs: { setupSeen: 0, whatsNewSeen: 20 } } };
  await withPage({ grants, overrides: { ...WALK_FIXTURES, "/api/me": me } }, async (page, { errors }) => {
    const setup = page.getByRole("dialog", { name: "Getting started" });
    await setup.waitFor();
    for (let i = 0; i < 7; i++) await setup.getByRole("button", { name: /^(Let's start|Next)$/ }).click();
    await setup.getByRole("button", { name: "Show me around" }).click();
    await setup.waitFor({ state: "detached" });
    const note = page.getByRole("complementary", { name: "Walkthrough" });
    await note.getByText("Find your way around").waitFor();
    await page.locator(".spot-ring").waitFor();
    await page.waitForTimeout(400);
    const whatsNew = page.getByRole("dialog", { name: "What's new" });
    assert.equal(await whatsNew.count(), 0, "what changed waits while the way around is pointed out");
    await note.getByRole("button", { name: "Next" }).click();
    assert.equal(await whatsNew.count(), 0, "and from one step to the next");
    await note.getByRole("button", { name: "End the walkthrough" }).click();
    await note.waitFor({ state: "detached" });
    await whatsNew.waitFor();
    assert.deepEqual(errors, []);
  });
});

/*
 * A step can point into a player's profile, which is open "on" the Players screen rather than at an
 * address of its own: moving on to the next step must leave the profile open, not go back to the
 * directory the step names. And a step whose control is not on the screen yet waits for it.
 */
test("Show me on my screen keeps a player's profile open from one step to the next", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("player.notes")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Leave a note on a player" }).click();
    const slides = page.getByRole("dialog", { name: "Leave a note on a player" });
    await slides.getByRole("button", { name: "Step 5", exact: true }).click();
    await slides.getByRole("button", { name: "Show me on my screen" }).click();
    await slides.waitFor({ state: "detached" });

    // The notes box is on a profile, and none is open: the directory, and a note saying so.
    const note = page.getByRole("complementary", { name: "Walkthrough" });
    await page.waitForFunction(() => window.location.hash.startsWith("#/players"));
    await note.getByText("Not on your screen yet", { exact: false }).waitFor();
    // Opening a profile brings the box, and the ring to it.
    await page.locator(".panel", { hasText: "Directory" }).locator("tbody tr").first().click();
    const box = page.locator('input[placeholder^="Add a note"]');
    await box.waitFor();
    const ringedAround = async (loc) => {
      const el = await loc.elementHandle();
      await page.waitForFunction((t) => {
        const ring = window.document.querySelector(".spot-ring");
        if (!ring) return false;
        const a = ring.getBoundingClientRect();
        const b = t.getBoundingClientRect();
        return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1 && a.width <= b.width + 14;
      }, el, { timeout: 5000 });
    };
    await ringedAround(box);
    const profile = await page.evaluate(() => window.location.hash);
    assert.match(profile, /^#\/players\/~/, "a profile is open");

    // Next: the Add button on the same profile — still open.
    await note.getByRole("button", { name: "Next" }).click();
    await ringedAround(page.locator(".panel", { hasText: "Notes" }).getByRole("button", { name: "Add", exact: true }));
    assert.equal(await page.evaluate(() => window.location.hash), profile, "the profile stayed open");
    assert.deepEqual(errors, []);
  });
});

/*
 * A step whose control is already in front of the person leaves them where they are: "Open Live"
 * rings the menu's Live for them to press, rather than the panel going there itself.
 */
test("Show me on my screen leaves the screen alone when the step's control is already on it", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("action.kick")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Kick a player" }).click();
    await page.getByRole("dialog", { name: "Kick a player" }).getByRole("button", { name: "Show me on my screen" }).click();
    const live = page.locator('.sidebar [data-route="live"]');
    await page.waitForFunction((el) => {
      const ring = window.document.querySelector(".spot-ring");
      if (!ring) return false;
      const a = ring.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1;
    }, await live.elementHandle(), { timeout: 5000 });
    assert.match(await page.evaluate(() => window.location.hash), /^#\/help\/start/, "still on Help: pressing Live is the step");
    assert.deepEqual(errors, []);
  });
});

/*
 * Next, on a profile, to a step whose control is not on the screen yet (a menu item before the menu
 * is open): the profile stays open, and the note says to do the step before.
 */
test("Show me on my screen keeps a profile open for a step whose control is not there yet", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("player.watchlist")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Put a player on the watchlist" }).click();
    const slides = page.getByRole("dialog", { name: "Put a player on the watchlist" });
    await slides.getByRole("button", { name: "Step 5", exact: true }).click();
    await slides.getByRole("button", { name: "Show me on my screen" }).click();
    await slides.waitFor({ state: "detached" });
    const note = page.getByRole("complementary", { name: "Walkthrough" });
    await page.locator(".panel", { hasText: "Directory" }).locator("tbody tr").first().click();
    await page.locator('button[aria-label="Actions"]').waitFor();
    await page.waitForFunction(() => window.location.hash.startsWith("#/players/~"));
    const profile = await page.evaluate(() => window.location.hash);
    // Next without opening Actions: its menu item is not there, and the profile stays.
    await note.getByRole("button", { name: "Next" }).click();
    await note.getByText("Not on your screen yet", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => window.location.hash), profile, "the profile stayed open");
    assert.deepEqual(errors, []);
  });
});

// A step about the panel in another state (its `stage`: What's new open after an update) cannot be
// done by doing the step before. Show me says the control is there only in that state.
test("Show me on my screen says when a step's control is there only in another state", { skip: SKIP }, async () => {
  await withPage({ grants: [], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Find help in the panel" }).click();
    const slides = page.getByRole("dialog", { name: "Find help in the panel" });
    await slides.getByRole("button", { name: "Step 8", exact: true }).click();
    await slides.getByText("After an update, What's new opens once", { exact: false }).waitFor();
    await slides.getByRole("button", { name: "Show me on my screen" }).click();
    await slides.waitFor({ state: "detached" });
    const note = page.getByRole("complementary", { name: "Walkthrough" });
    await note.getByText("Not on your screen now. It is there only when the panel is as this step says.").waitFor();
    assert.equal(await note.getByText("It appears once you do the step before", { exact: false }).count(), 0);
    assert.deepEqual(errors, []);
  });
});

/*
 * The roster scrolls inside its own box, and a step about a player's ⋯ is about whichever player
 * the person is after. Scrolled down the box, the ring goes round a ⋯ on a row in view — row 1's
 * is still inside the window, hidden by the box, and the ring stood round it out of sight — and
 * pressing the ⋯ on any row does the step, not only on the row ringed.
 */
test("Show me on my screen rings a ⋯ in view as the roster scrolls, and moves on from any row's", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("action.punish")], overrides: WALK_FIXTURES, viewport: PHONE }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Punish a player" }).click();
    const slides = page.getByRole("dialog", { name: "Punish a player" });
    await slides.getByRole("button", { name: "Step 2", exact: true }).click();
    await slides.getByRole("button", { name: "Show me on my screen" }).click();
    await slides.waitFor({ state: "detached" });
    const note = page.getByRole("complementary", { name: "Walkthrough" });
    const box = page.locator(".scroll-x.roster");
    // The row whose ⋯ the ring goes round, or -1.
    const ringedRow = () => page.evaluate(() => {
      const ring = window.document.querySelector(".spot-ring");
      if (!ring) return -1;
      const a = ring.getBoundingClientRect();
      return [...window.document.querySelectorAll(".scroll-x.roster tbody tr")].findIndex((tr) => {
        const b = tr.querySelector('.player-actions button[aria-label="More"]')?.getBoundingClientRect();
        return Boolean(b) && a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1;
      });
    });
    await page.waitForFunction(() => window.document.querySelector(".spot-ring"));
    assert.equal(await ringedRow(), 0, "row 1's to begin with");
    // Down the box to the twelfth row: the ring follows to a row in view, and says nothing is missing.
    await box.evaluate((el) => { el.scrollTop = el.querySelectorAll("tbody tr")[11].offsetTop - el.querySelector("thead").offsetHeight; });
    let row = -1;
    for (let i = 0; i < 20 && row < 10; i++) { await page.waitForTimeout(150); row = await ringedRow(); }
    assert.ok(row >= 10, `the ring is round row ${row + 1}'s ⋯`);
    await page.waitForTimeout(1400);
    assert.equal(await note.locator(".spot-hint").count(), 0, "nothing said to be out of view");
    // The scrolling is the person's. The list's top at the top of the window, where a step's control
    // would be brought down from the edge: scrolling the list on is not scrolled back.
    const scroller = await box.evaluateHandle((el) => {
      for (let p = el.parentElement; p && p !== window.document.body; p = p.parentElement) {
        if (/(auto|scroll)/.test(window.getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
      }
      return window.document.scrollingElement;
    });
    await scroller.evaluate((sc, el) => { sc.scrollTop += el.getBoundingClientRect().top; }, await box.elementHandle());
    await box.evaluate((el) => { el.scrollTop += 200; });
    const where = () => box.evaluate((el, sc) => [Math.round(sc.scrollTop), Math.round(el.scrollTop)], scroller);
    const left = await where();
    await page.waitForTimeout(1000);
    assert.deepEqual(await where(), left, "nothing scrolled back");
    // Pushed out of view altogether: said so, with the way back to it.
    await page.addStyleTag({ content: ".scroll-x.roster { margin-top: 3000px; }" });
    await note.getByText("Out of view.").waitFor();
    await note.getByRole("button", { name: "Scroll to it" }).click();
    for (let i = 0; i < 20 && (row = await ringedRow()) < 0; i++) await page.waitForTimeout(150);
    assert.ok(row >= 0, "ringed again, in view");
    await page.waitForTimeout(400);
    assert.equal(await note.getByText("Out of view.").count(), 0);
    // Another row's ⋯ than the one ringed: the step is done, and the next is the menu it opened.
    await box.locator("tbody tr").nth(row + 2).locator('.player-actions button[aria-label="More"]').click();
    await note.getByText("Step 3 of", { exact: false }).waitFor();
    await note.getByText("Choose Punish.").waitFor();
    assert.deepEqual(errors, []);
  });
});

/*
 * Live keeps its Roster as it was left: on the Live feed, which hides every row, or folded away. A
 * step about a player's ⋯ is on the scoreboard, so Show me opens the panel and puts it on
 * Scoreboard as the step begins — the screen as the step's picture shows it — and there are rows to
 * ring. It took people to the feed, with nothing to press.
 */
test("Show me on my screen opens Live's Roster on its scoreboard, however it was left", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("action.punish")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    const base = page.url().split("#")[0];
    const roster = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Roster$/ }) });
    for (const left of ["on its feed", "folded"]) {
      await page.goto(`${base}?left=${left.length}#/live`, { waitUntil: "networkidle" });
      if (left === "folded") await roster.locator("button.panel-toggle").click();
      else await roster.getByRole("button", { name: "Live feed" }).click();
      await page.goto(`${base}?visit=${left.length}#/help/start`, { waitUntil: "networkidle" });
      await page.locator(".walk-card", { hasText: "Punish a player" }).click();
      const slides = page.getByRole("dialog", { name: "Punish a player" });
      await slides.getByRole("button", { name: "Step 2", exact: true }).click();
      await slides.getByRole("button", { name: "Show me on my screen" }).click();
      await slides.waitFor({ state: "detached" });
      // A ⋯ on a row, ringed: the scoreboard is showing.
      await page.waitForFunction(() => {
        const ring = window.document.querySelector(".spot-ring");
        const more = [...window.document.querySelectorAll('.player-actions button[aria-label="More"]')].find((b) => b.getClientRects().length);
        if (!ring || !more) return false;
        const a = ring.getBoundingClientRect(), b = more.getBoundingClientRect();
        return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1;
      }, undefined, { timeout: 10_000 }).catch(() => { throw new Error(`left ${left}: no row's ⋯ was ringed`); });
      assert.match(await roster.getByRole("button", { name: "Scoreboard" }).getAttribute("class"), /active/, `left ${left}: on Scoreboard`);
      // Set once, as the step began: back on the feed by the person's own choice, it stays there.
      await roster.getByRole("button", { name: "Live feed" }).click();
      await page.waitForTimeout(1000);
      assert.match(await roster.getByRole("button", { name: "Live feed" }).getAttribute("class"), /active/, `left ${left}: the feed, as the person chose`);
      await page.getByRole("complementary", { name: "Walkthrough" }).getByRole("button", { name: "End the walkthrough" }).click();
    }
    assert.deepEqual(errors, []);
  });
});

/*
 * Live is in the quick bar until someone swaps it out, or switches the bar off. Show me rings Live
 * in the bar where the person keeps it there; where they do not, the step goes through the menu: ☰,
 * then Live in it. The slideshow shows the menu's way to everyone — the bar is each person's own —
 * and says to open the menu first.
 */
test("a screen someone's quick bar does not hold is opened from the menu, on a phone", { skip: SKIP }, async () => {
  const grants = [held("server.view", "read")];
  const me = (prefs) => ({ body: { user: { id: "u1", username: "tester", displayName: "tester", createdAt: "2026-01-02T03:04:05.000Z" }, grants, limits: {}, roles: [], prefs: { whatsNewSeen: 99, ...prefs } } });
  const ringed = async (page, loc) => {
    const el = await loc.elementHandle();
    await page.waitForFunction((t) => {
      const ring = window.document.querySelector(".spot-ring");
      if (!ring) return false;
      const a = ring.getBoundingClientRect(), b = t.getBoundingClientRect();
      return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1 && a.width <= b.width + 14;
    }, el, { timeout: 10_000 });
  };
  for (const [bar, prefs, viaMenu] of [
    ["as it comes", {}, false],
    ["without Live", { phoneBar: "bottom", phoneBarItems: ["players", "search"] }, true],
    ["switched off", { phoneBar: "off" }, true],
  ]) {
    await withPage({ grants, overrides: { ...WALK_FIXTURES, "/api/me": me(prefs) }, viewport: PHONE }, async (page, { errors }) => {
      await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
      await page.locator(".walk-card", { hasText: "Watch a server live" }).click();
      const slides = page.getByRole("dialog", { name: "Watch a server live" });
      await slides.getByText("Step 1 of", { exact: false }).waitFor();
      assert.equal(await slides.getByText("Tap ☰ at the top left to open the menu first.").count(), 1, `the bar ${bar}: the slideshow's way is the menu's`);
      await slides.getByRole("button", { name: "Show me on my screen" }).click();
      await slides.waitFor({ state: "detached" });
      const note = page.getByRole("complementary", { name: "Walkthrough" });
      if (viaMenu) {
        await note.getByText("Tap ☰ to open the menu first.").waitFor();
        const burger = page.locator(".topbar .burger");
        await ringed(page, burger);
        const at = await burger.boundingBox();
        assert.ok(at.x < 80 && at.y < 120, `the bar ${bar}: ☰ is at the top left (${at.x}, ${at.y})`);
        await burger.click();
        await ringed(page, page.locator('.sidebar [data-route="live"]'));
        await page.locator('.sidebar [data-route="live"]').click();
      } else {
        await ringed(page, page.locator('.quick-bar [data-route="live"]'));
        await page.locator('.quick-bar [data-route="live"]').click();
      }
      await note.getByText("Step 2 of", { exact: false }).waitFor();
      assert.deepEqual(errors, []);
    });
  }
});

/*
 * On a phone the menu folds away behind ☰. A step pointing into it rings ☰ until the menu is open
 * — pressing ☰ opens the menu, it does not do the step — then the screen's entry in the menu, and,
 * with the menu still open over the page, the tab listed under it rather than the page's tab bar
 * behind the menu.
 */
test("Show me on my screen, on a phone, rings ☰ for what is in the menu, then the menu's entries", { skip: SKIP }, async () => {
  await withPage({ grants: [held("audit.trail", "read")], overrides: WALK_FIXTURES, viewport: PHONE }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    await page.locator(".walk-card", { hasText: "Look back at what staff did" }).click();
    const slides = page.getByRole("dialog", { name: "Look back at what staff did" });
    // The slideshow's four buttons sit two to a row: in one row each is squeezed into a column of words.
    const tops = await slides.locator(".pa-actions > button").evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
    assert.equal(tops.length, 4);
    assert.ok(tops[0] === tops[1] && tops[2] === tops[3] && tops[2] > tops[0], `rows at ${tops.join(", ")}`);
    await slides.getByRole("button", { name: "Show me on my screen" }).click();
    await slides.waitFor({ state: "detached" });
    const note = page.getByRole("complementary", { name: "Walkthrough" });
    const ringed = async (loc) => {
      const el = await loc.elementHandle();
      await page.waitForFunction((t) => {
        const ring = window.document.querySelector(".spot-ring");
        if (!ring) return false;
        const a = ring.getBoundingClientRect();
        const b = t.getBoundingClientRect();
        return a.left <= b.left + 1 && a.top <= b.top + 1 && a.right >= b.right - 1 && a.bottom >= b.bottom - 1 && a.width <= b.width + 14;
      }, el, { timeout: 5000 });
    };

    // Administration is in the closed menu: ☰ is ringed, and the note says to open the menu.
    const burger = page.locator(".topbar .burger");
    await ringed(burger);
    await note.getByText("Tap ☰ to open the menu first.").waitFor();
    await burger.click();
    // The menu is open: still the first step, now on the menu's entry.
    const admin = page.locator('.sidebar [data-route="admin"]');
    await ringed(admin);
    await note.getByText("Step 1 of", { exact: false }).waitFor();
    assert.equal(await note.getByText("Tap ☰ to open the menu first.").count(), 0, "the menu is open");
    await admin.click();
    // Administration has tabs, so the menu stays open with them listed: the tab there is ringed.
    const activity = page.locator('.sidebar [data-route="admin.activity"]');
    await note.getByText("Step 2 of", { exact: false }).waitFor();
    await ringed(activity);
    await activity.click();
    await note.getByText("Step 3 of", { exact: false }).waitFor();
    await ringed(page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Trail$/ }) }));
    assert.deepEqual(errors, []);
  });
});

/*
 * What a step points at can be taller than the window: a long panel, the roster. Show me on my
 * screen then shows its top — the panel's title, the roster's column names — clear of the screen's
 * heading that stays over the page, rings only the part of it that can be seen, and keeps the note
 * with Back and Next on the screen. Shown by its middle, the title was hidden, the ring ran off both
 * ends, and the note was placed above the top of the window.
 */
test("Show me on my screen shows the top of what is taller than the window, and keeps its note on the screen", { skip: SKIP }, async () => {
  const cases = [
    { walk: "Change your settings", step: 3, grants: [], top: { title: "Workspace" } },
    { walk: "Change your settings", step: 3, grants: [], top: { title: "Workspace" }, viewport: PHONE },
    { walk: "Watch a server live", step: 3, grants: [held("server.view", "read")], top: { css: ".scroll-x.roster thead th:nth-child(5)" }, within: ".scroll-x.roster" },
  ];
  for (const c of cases) {
    const where = `${c.walk} step ${c.step}${c.viewport ? " on a phone" : ""}`;
    await withPage({ grants: c.grants, overrides: WALK_FIXTURES, ...(c.viewport ? { viewport: c.viewport } : {}) }, async (page, { errors }) => {
      await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
      await page.locator(".walk-card", { hasText: c.walk }).click();
      const slides = page.getByRole("dialog", { name: c.walk });
      await slides.getByRole("button", { name: `Step ${c.step}`, exact: true }).click();
      await slides.getByRole("button", { name: "Show me on my screen" }).click();
      await slides.waitFor({ state: "detached" });
      const note = page.getByRole("complementary", { name: "Walkthrough" });
      await note.getByText(`Step ${c.step} of`, { exact: false }).waitFor();
      await page.locator(".spot-ring").waitFor();
      await page.waitForTimeout(400);
      const seen = await page.evaluate(([top, within]) => {
        const box = (el) => el.getBoundingClientRect();
        const head = top.title
          ? [...window.document.querySelectorAll(".panel-title")].find((t) => t.textContent.trim() === top.title)
          : window.document.querySelector(top.css);
        const h = box(head);
        const hit = window.document.elementFromPoint(h.left + Math.min(8, h.width / 2), h.top + h.height / 2);
        const ring = box(window.document.querySelector(".spot-ring"));
        const n = box(window.document.querySelector(".spot-note"));
        const w = within ? box(window.document.querySelector(within)) : null;
        return {
          headShown: h.top >= 0 && h.bottom <= window.innerHeight && Boolean(hit) && (hit === head || head.contains(hit)),
          ringTop: ring.top, headTop: h.top,
          ringInside: !w || (ring.top >= w.top - 8 && ring.bottom <= w.bottom + 8),
          noteOnScreen: n.top >= 0 && n.bottom <= window.innerHeight && n.left >= 0 && n.right <= window.innerWidth,
        };
      }, [c.top, c.within ?? null]);
      assert.ok(seen.headShown, `${where}: its top is in view, clear of the screen's heading`);
      assert.ok(seen.ringTop >= 0 && seen.ringTop <= seen.headTop, `${where}: the ring starts at its top, in the window`);
      assert.ok(seen.ringInside, `${where}: the ring goes round only what can be seen`);
      assert.ok(seen.noteOnScreen, `${where}: the note, with Back and Next, is on the screen`);
      await note.getByRole("button", { name: "Next" }).click();
      await note.getByText(`Step ${c.step + 1} of`, { exact: false }).waitFor();
      assert.deepEqual(errors, []);
    });
  }
});

/*
 * A walkthrough is its pictures and a line for each step. The longer notes the old How do I guides
 * brought into the steps are gone: nothing is folded under a step, on any step, Kick a player's
 * second (which held one) among them.
 */
test("a walkthrough's steps are a picture and a line each, with nothing folded under them", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("action.kick"), held("vip.revoke")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    for (const title of ["Kick a player", "Ask for what you cannot do yourself", "Take VIP away"]) {
      await page.locator(".walk-card", { hasText: title }).click();
      const slides = page.getByRole("dialog", { name: title });
      // Its words, not as drawn: the count is set in capitals.
      const of = Number((await slides.locator(".walk-count").textContent()).replace(/^Step 1 of /, ""));
      assert.ok(of > 1, `${title} has steps`);
      for (let n = 1; n <= of; n++) {
        await slides.getByRole("button", { name: `Step ${n}`, exact: true }).click();
        await slides.locator(".walk-count", { hasText: `Step ${n} of ${of}` }).waitFor();
        assert.equal(await slides.locator(".walk-caption details").count(), 0, `${title}, step ${n}: nothing folded under it`);
        assert.ok((await slides.locator(".walk-text").innerText()).trim().length > 0, `${title}, step ${n}: its line`);
      }
      await page.keyboard.press("Escape");
      await slides.waitFor({ state: "detached" });
    }
    assert.deepEqual(errors, []);
  });
});

/*
 * Start here's search box looks through the walkthroughs this person may follow, in the words they
 * would use: "boot" finds kicking for someone who may kick, banning finds nothing for someone who
 * may not ban, and the personal setup answers to what it sets up.
 */
test("Start here's search finds the walkthrough for what someone wants to do, among their own", { skip: SKIP }, async () => {
  await withPage({ grants: [held("server.view", "read"), held("action.kick")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}?visit=1#/help/start`, { waitUntil: "networkidle" });
    const panel = page.locator(".panel", { has: page.locator(".panel-title", { hasText: /^Start here$/ }) });
    const box = panel.getByPlaceholder("Search the walkthroughs…");
    const cards = () => panel.locator(".walk-card-title").allTextContents();
    await box.fill("how do I boot someone");
    await panel.getByText("1 walkthrough", { exact: true }).waitFor();
    assert.deepEqual(await cards(), ["Kick a player"]);
    // Banning is not theirs: what the search finds is how to ask for a ban.
    await box.fill("ban a player");
    await panel.getByText("1 walkthrough", { exact: true }).waitFor();
    assert.deepEqual(await cards(), ["Ask for what you cannot do yourself"]);
    await box.fill("zeppelin");
    await panel.getByText("No walkthrough matches").waitFor();
    assert.deepEqual(await cards(), [], "nothing that matches, nothing listed");
    await box.fill("dark theme");
    await panel.locator(".walk-card-title", { hasText: "Personal setup" }).waitFor();
    // Cleared, every group is back.
    await box.fill("");
    await panel.locator(".help-group-label", { hasText: "Player actions" }).waitFor();
    assert.ok((await cards()).includes("Find your way around"));
    assert.deepEqual(errors, []);
  });
});

/*
 * The Discord walkthrough's steps happen in Discord, where the panel the staff command opens has no
 * screen here: each draws that panel in its picture's place, as the bot draws it for this person —
 * under their community's own name for the command — opened where the step is, with its button
 * ringed. It moves as Discord does wherever moving changes nothing, and a button that does something
 * only says it works in Discord: the drawing asks the panel for nothing but the bot's screens, each
 * once however often the steps come back to it.
 */
test("the Discord walkthrough draws the staff panel in its steps, and moves through it without doing anything", { skip: SKIP }, async () => {
  const overrides = { "/api/discord/staff-panel": { body: { ...STAFF_PANEL.panel, command: { name: "stafftest", enabled: true } } } };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { stub, errors }) => {
    // Help's Staff command tab is gone into these steps: a link to it lands on Start here, as one to
    // any tab Help does not have.
    await page.goto(`${page.url().split("#")[0]}#/help/staff-command`, { waitUntil: "networkidle" });
    await page.locator(".panel-title", { hasText: "Start here" }).waitFor();
    assert.equal(await page.locator('[role="tab"]', { hasText: "Staff command" }).count(), 0, "no Staff command tab");
    await page.goto(`${page.url().split("#")[0]}#/help/start/~discord-staff`, { waitUntil: "networkidle" });
    const dialog = page.getByRole("dialog", { name: "Do staff work from Discord" });
    const drawing = dialog.getByRole("region", { name: "Staff command in Discord" });
    const button = (name) => drawing.getByRole("button", { name, exact: true });
    const step = async (n, text) => {
      await dialog.getByRole("button", { name: `Step ${n}`, exact: true }).click();
      await dialog.locator(".walk-text", { hasText: text }).waitFor();
    };
    const ringed = () => drawing.locator(".walk-ringed").allInnerTexts();
    await dialog.waitFor();
    // Linking Discord is on the panel's own screen: a picture.
    assert.equal(await dialog.locator(".walk-stage img").count(), 1);

    // The command's panel: drawn, not a picture, with the community's name for the command.
    await step(2, "The staff command opens this panel in Discord.");
    await button("Economy").waitFor();
    assert.equal(await dialog.locator(".walk-stage img").count(), 0, "no picture in Discord");
    assert.match(await drawing.innerText(), /Staff panel — pick a module/);
    assert.equal(await drawing.locator(".dpv-cmd").innerText(), "/stafftest");
    assert.deepEqual(await drawing.locator(".dpv-btn").allInnerTexts(), ["Servers", "Economy", "Moderation", "Maps & vote"]);
    // Each part's step opens it, and rings its button where the step is about one.
    await step(4, "Economy opens a member's card");
    await drawing.getByText("Top balances").waitFor();
    assert.deepEqual(await ringed(), []);
    await step(5, "Register / link accounts, in Economy");
    assert.deepEqual(await ringed(), ["Register / link accounts"]);
    await step(6, "Post the public VIP panel, in Economy");
    assert.deepEqual(await ringed(), ["Post the public VIP panel"]);
    // A part that starts by picking a server: the first of theirs, picked.
    await step(7, "Moderation fills a cart");
    await button("Review & send").waitFor();
    await step(9, "Change map now… or Set next map…");
    await drawing.getByText("Next in rotation", { exact: false }).waitFor();
    assert.deepEqual(await ringed(), ["Change map now…"]);
    await step(10, "Where the map vote is on");
    assert.deepEqual(await ringed(), ["⏸ Pause vote"]);
    // Pressed, a button that acts says so; Back goes back, as in Discord.
    await button("Change map now…").click();
    await dialog.locator(".dpv-note").getByText("does its work in Discord", { exact: false }).waitFor();
    await button("All servers").click();
    await drawing.locator("select.dpv-select").waitFor();
    // The steps again: each where it is, read once.
    await step(2, "The staff command opens this panel in Discord.");
    await button("Maps & vote").waitFor();
    await step(8, "Maps & vote picks a server");
    await drawing.getByText("Next in rotation", { exact: false }).waitFor();
    assert.deepEqual(stub.calls.filter((c) => c.path.startsWith("/api/discord")).map((c) => `${c.method} ${c.path}`),
      ["GET /api/discord/staff-panel", "GET /api/discord/staff-panel/moderation/s1", "GET /api/discord/staff-panel/maps/s1"],
      "the bot's screens, each once, and no press sent anywhere");
    assert.equal(await page.evaluate(() => window.location.hash), "#/help/start/~discord-staff", "nothing opened behind it");
    assert.deepEqual(errors, []);
  });
});

/*
 * On a phone the drawing fits the slideshow. And it is the person's own: without a linked Discord
 * the command answers only that it needs one, and a door to a part their permissions do not open is
 * refused, as Discord refuses the press.
 */
test("the Discord walkthrough's drawing fits a phone, and says what Discord would refuse", { skip: SKIP }, async () => {
  const { register: _register, ...parts } = STAFF_PANEL.panel.parts;
  const overrides = { "/api/discord/staff-panel": { body: { ...STAFF_PANEL.panel, linked: false, parts } } };
  await withPage({ grants: OWNER_GRANTS, overrides, viewport: PHONE }, async (page, { errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/help/start/~discord-staff`, { waitUntil: "networkidle" });
    const dialog = page.getByRole("dialog", { name: "Do staff work from Discord" });
    const drawing = dialog.getByRole("region", { name: "Staff command in Discord" });
    await dialog.getByRole("button", { name: "Step 7", exact: true }).click();
    await dialog.getByText("Your account is not linked to Discord", { exact: false }).waitFor();
    await drawing.getByRole("button", { name: "Review & send", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.document.documentElement.scrollWidth > window.innerWidth + 1), false, "the page does not scroll sideways");
    // Each of the cart's buttons inside the drawing, as Discord wraps a row too wide for a phone.
    const outside = await drawing.evaluate((d) => {
      const edge = d.getBoundingClientRect().right;
      return [...d.querySelectorAll(".dpv-btn")].filter((b) => b.getBoundingClientRect().right > edge + 1).map((b) => b.textContent);
    });
    assert.deepEqual(outside, [], "every button on the screen");
    await dialog.getByRole("button", { name: "Step 4", exact: true }).click();
    await drawing.getByText("Top balances").waitFor();
    await drawing.getByRole("button", { name: "Register / link accounts", exact: true }).click();
    await dialog.locator(".dpv-note").getByText("Your permissions don't open that part", { exact: false }).waitFor();
    assert.match(await drawing.innerText(), /Top balances/, "and stays where it was");
    assert.deepEqual(errors, []);
  });
});

/*
 * A server's screen can come back after the person has moved on: to another step, to a part, Back,
 * or to another server. What they asked for last is what the drawing shows, and it does not stay
 * marked as loading. Each race starts on a fresh page, so no server's screen is read already.
 */
test("the Discord walkthrough's drawing shows what was asked for last, however late a server's screen comes back", { skip: SKIP }, async () => {
  const SLOW = 1_000;
  const overrides = {
    "/api/discord/staff-panel/moderation/s1": { delayMs: SLOW, body: { message: STAFF_PANEL.moderation } },
    "/api/discord/staff-panel/moderation/s2": { delayMs: SLOW, body: { message: { ...STAFF_PANEL.moderation, content: "**Moderation** — LATE-S2" } } },
    "/api/discord/staff-panel/maps/s1": { delayMs: SLOW, body: { message: { ...STAFF_PANEL.maps, content: "**Maps & vote** — LATE-S1" } } },
    "/api/discord/staff-panel/maps/s2": { body: { message: { ...STAFF_PANEL.maps, content: "**Maps & vote** — PICKED-S2" } } },
  };
  await withPage({ grants: OWNER_GRANTS, overrides }, async (page, { errors }) => {
    const dialog = page.getByRole("dialog", { name: "Do staff work from Discord" });
    const drawing = dialog.getByRole("region", { name: "Staff command in Discord" });
    const button = (name) => drawing.getByRole("button", { name, exact: true });
    const step = (n) => dialog.getByRole("button", { name: `Step ${n}`, exact: true }).click();
    const fresh = async () => {
      await page.goto(`${page.url().split("#")[0]}#/help/start/~discord-staff`, { waitUntil: "networkidle" });
      await page.reload({ waitUntil: "networkidle" });
      await dialog.waitFor();
    };
    const loading = () => page.waitForFunction(() => window.document.querySelector(".dpv")?.getAttribute("aria-busy") === "true");
    // The late screen is in, with time to be drawn if it would be.
    const late = (server) => page.waitForEvent("requestfinished", (r) => new URL(r.url()).pathname === `/api/discord/staff-panel/${server}`);
    const settled = async (arrived) => { await arrived; await page.waitForTimeout(250); };
    const shows = async (text, why) => {
      assert.ok((await drawing.innerText()).includes(text), `${why}: shows ${text}`);
      assert.equal(await drawing.getAttribute("aria-busy"), "false", `${why}: not still loading`);
    };

    // Another step, before the step's own server comes back.
    await fresh();
    let arrived = late("moderation/s1");
    await step(7);
    await loading();
    await step(4);
    await drawing.getByText("Top balances").waitFor();
    await settled(arrived);
    await shows("Top balances", "a step left before its server came back");

    // Another step, before a server picked comes back.
    await fresh();
    await step(2);
    await button("Moderation").click();
    arrived = late("moderation/s2");
    await drawing.locator("select.dpv-select").selectOption("s2");
    await loading();
    await step(4);
    await drawing.getByText("Top balances").waitFor();
    await settled(arrived);
    await shows("Top balances", "a step opened while a server picked was coming");

    // Back, before a server picked comes back.
    await fresh();
    await step(2);
    await button("Moderation").click();
    arrived = late("moderation/s2");
    await drawing.locator("select.dpv-select").selectOption("s2");
    await loading();
    await button("‹ Back").click();
    await settled(arrived);
    await shows("Staff panel — pick a module", "Back pressed while a server picked was coming");

    // Another server picked, before the step's own server comes back.
    await fresh();
    await step(2);
    await button("Maps & vote").click();
    arrived = late("maps/s1");
    await step(8);
    await loading();
    await drawing.locator("select.dpv-select").selectOption("s2");
    await drawing.getByText("PICKED-S2").waitFor();
    await settled(arrived);
    await shows("PICKED-S2", "a server picked while the step's own was coming");
    assert.deepEqual(errors, []);
  });
});

/*
 * Show me on my screen, at a step in Discord, has no screen to open: the drawing opens in a window
 * over whatever screen the person is on, where the step is, with its button ringed like any other —
 * and pressing it moves on. Past the steps in Discord, the window goes and the next step's screen
 * opens as ever.
 */
test("Show me on my screen opens the Discord drawing over the screen the person is on", { skip: SKIP }, async () => {
  await withPage({ grants: OWNER_GRANTS }, async (page, { stub, errors }) => {
    await page.goto(`${page.url().split("#")[0]}#/players/vips`, { waitUntil: "networkidle" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("panel:walkthrough", { detail: { walkId: "discord-staff" } })));
    const dialog = page.getByRole("dialog", { name: "Do staff work from Discord" });
    await dialog.getByRole("button", { name: "Step 5", exact: true }).click();
    await dialog.getByRole("button", { name: "Show me on my screen" }).click();
    await dialog.waitFor({ state: "detached" });
    const windowed = page.locator(".spot-discord");
    const ringAround = async (name) => {
      const target = await windowed.getByRole("button", { name, exact: true }).boundingBox();
      await page.waitForFunction(([x, y]) => {
        const r = window.document.querySelector(".spot-ring")?.getBoundingClientRect();
        return Boolean(r && Math.abs(r.left + 4 - x) < 2 && Math.abs(r.top + 4 - y) < 2);
      }, [target.x, target.y]);
    };
    await windowed.getByRole("region", { name: "Staff command in Discord" }).getByText("Top balances").waitFor();
    await ringAround("Register / link accounts");
    assert.equal(await page.evaluate(() => window.location.hash), "#/players/vips", "over the screen they were on");
    assert.match(await page.locator(".spot-note .walk-count").textContent(), /^Step 5 of \d+$/);
    // Pressing the ringed button is doing the step.
    await windowed.getByRole("button", { name: "Register / link accounts", exact: true }).click();
    await page.locator(".spot-note").getByText(/Step 6 of \d+/).waitFor();
    await ringAround("Post the public VIP panel");
    // Past the last step in Discord, the next one's screen opens, and the window goes.
    for (const n of [7, 8, 9, 10, 11]) {
      await page.locator(".spot-note").getByRole("button", { name: "Next", exact: true }).click();
      await page.locator(".spot-note").getByText(new RegExp(`Step ${n} of \\d+`)).waitFor();
    }
    await page.waitForFunction(() => window.location.hash === "#/discord/setup");
    assert.equal(await windowed.count(), 0);
    assert.ok(!stub.calls.some((c) => c.path.startsWith("/api/discord") && c.method !== "GET"), "nothing sent to Discord");
    assert.deepEqual(errors, []);
  });
});

/*
 * The search at the top of the panel finds walkthroughs too, in a group of their own, and opens
 * one's slideshow over the screen the person is on.
 */
test("Search finds a walkthrough and opens its slideshow where the person is", { skip: SKIP }, async () => {
  await withPage({ grants: [held("moderation.bans", "read"), held("action.unban")], overrides: WALK_FIXTURES }, async (page, { errors }) => {
    const here = await page.evaluate(() => window.location.hash);
    await page.keyboard.press("Control+k");
    const input = page.getByPlaceholder(/^Search views/);
    await input.fill("unban");
    const item = page.locator(".cmdk-item", { hasText: "Lift a ban" });
    await item.waitFor();
    assert.ok((await page.locator(".cmdk-group-label").allTextContents()).includes("Walkthroughs"));
    await item.click();
    const slides = page.getByRole("dialog", { name: "Lift a ban" });
    await slides.waitFor();
    assert.equal(await page.evaluate(() => window.location.hash), here, "over the screen they were on");
    await slides.getByText("Step 1 of", { exact: false }).waitFor();
    // Walkthroughs are never offered past what the person may do.
    await page.keyboard.press("Escape");
    await slides.waitFor({ state: "detached" });
    await page.keyboard.press("Control+k");
    await input.fill("kick a player");
    await page.locator(".cmdk-empty, .cmdk-item").first().waitFor();
    assert.equal(await page.locator(".cmdk-item", { hasText: "Kick a player" }).count(), 0, "kicking is not theirs to do");
    assert.deepEqual(errors, []);
  });
});
