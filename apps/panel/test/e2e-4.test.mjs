// Walkthrough coverage where the other coverage tests never look (test/coverage-kit): the panel in
// its other states (test/walk-stage STAGES), the overlays and modes around the screens, and the
// panel as someone who may look at everything and change nothing sees it — whose buttons read
// "Send for approval" where everyone else's do the thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP, withPage, held, PHONE } from "./e2e-kit.mjs";
import { startStub } from "./stub-api.mjs";
import { STAGES, WALK_FIXTURES, stageFor } from "./walk-stage.mjs";
import { ROUTES, canOpenRoute } from "../lib/routes.ts";
import { CAPABILITY_CATALOG } from "../../../packages/access/src/capabilities.ts";
import { ALL_STEPS, DIALOGS, KNOWN_GAPS, MENUS, SUBJECT_PAGES, act, coverageOf, dialogOpen, menuItems, namedForDialog, namedForDownload, overlayOpen, press, pressItem, recordGaps, ringed, screenCrashed, stepsOn, unansweredReads, uncovered, unfold } from "./coverage-kit.mjs";

const EVERYTHING = CAPABILITY_CATALOG.map((c) => held(c.key, "write"));
const hubs = new Set(ROUTES.filter((r) => r.parent).map((r) => r.parent));
/** Every screen a person can open from the menu (Help's lists are Help: explained once there). */
const SCREENS = ROUTES.filter((r) => !hubs.has(r.id) && !r.ownerOnly).map((r) => ({ path: r.path, routes: [r.id], help: r.id.startsWith("help.") }));
const steps = (routes) => (routes === "all" ? ALL_STEPS : stepsOn(routes));
const words = (a) => a.click?.button ?? a.click?.field ?? a.click?.css ?? a.value;

/** What a screen keeps for the tab's life, and a request this browser is building (lib/requestMode):
 *  the screen before's, not the next one's. */
async function forget(page) {
  await page.evaluate(() => {
    window.sessionStorage.clear();
    for (const k of Object.keys(window.localStorage)) if (k.startsWith("panel.panels.") || k.startsWith("panel.requestMode")) window.localStorage.removeItem(k);
  }).catch(() => {});
}

/** Run each of `jobs` on a page and a stub of its own, `width` at a time, every one to its end: one
 *  failing leaves none of the others running with its stub open. The first failure is thrown. */
async function sideBySide(jobs, width, { grants, overrides }) {
  const failures = [];
  await withPage({ grants: [] }, async (first) => {
    const browser = first.context().browser();
    const queue = [...jobs];
    await Promise.all(Array.from({ length: width }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const stub = await startStub({ grants, overrides: typeof overrides === "function" ? overrides(job) : overrides });
        const page = await browser.newPage();
        try {
          await page.addInitScript(() => window.localStorage.setItem("panel.token", "test-token"));
          await job.run(page, stub);
        } catch (e) {
          failures.push(e);
        } finally {
          await page.close().catch(() => {});
          await stub.close();
        }
      }
    }));
  });
  if (failures.length) throw failures[0];
}

/** Open a screen fresh, every folded panel opened. */
async function open(page, base, path, n) {
  await forget(page);
  await page.goto(`${base}/?cover=${n}#${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  await unfold(page);
}

/*
 * Each state a step can ask for, and the screens it changes: what they show then is explained by
 * a step on them, as on every screen the panel usually shows — or is listed in KNOWN_GAPS.states.
 * A CRCON pull in each of its states, the public stats switched on, a seed paid to only some of its
 * seeders, a server nobody has played on,
 * the dashboard with a watched player in game and a notice unread;
 * a Vietnam server, no server connected and a server list that could not be read, on every screen;
 * the panel out of reach, signed out, and the two notices that open by themselves — what's new
 * after an update, and the walkthroughs a person's new permissions opened — over the screens.
 */
const STATE_VIEWS = [
  ...["crcon-running", "crcon-paused", "crcon-stopped", "crcon-done", "published"].map((stage) => ({ stage, views: [{ path: "/admin/connections", routes: ["admin.connections"] }] })),
  { stage: "no-players", views: [{ path: "/players/directory", routes: ["players.players"] }] },
  { stage: "seed-owed", views: [{ path: "/autosettings/seeding", routes: ["autosettings.seeding"] }] },
  { stage: "attention", views: [{ path: "/dashboard", routes: ["dashboard"] }] },
  ...["vietnam", "no-servers", "servers-unread"].map((stage) => ({ stage, views: SCREENS })),
  ...["unreachable", "signed-out"].map((stage) => ({ stage, shell: false, views: [{ path: "/", routes: "all" }] })),
  ...["whats-new", "new-walkthroughs"].map((stage) => ({ stage, scope: "dialog", views: [{ path: "/live", routes: "all" }] })),
];

test("every control the panel shows only in another state has a walkthrough step", { skip: SKIP }, async () => {
  assert.deepEqual(STATE_VIEWS.map((s) => s.stage).sort(), Object.keys(STAGES).sort(), "every stage is looked at");
  const missing = [];
  const empty = new Set();
  const crashed = [];
  const errors = [];
  // Three states at a time, each against a stub answering as that state does.
  const jobs = STATE_VIEWS.map(({ stage, views, scope = "main", shell = true }) => ({ stage, run: async (page, stub) => {
    page.on("pageerror", (e) => errors.push(`${stage}: ${e}`));
    let n = 0;
    for (const { path, routes, help = false } of views) {
      await open(page, stub.base, path, ++n);
      if (await screenCrashed(page)) { crashed.push(`${stage} › ${path}`); continue; }
      // A notice that opens by itself is open, or there is nothing here to explain.
      assert.ok(scope !== "dialog" || await overlayOpen(page), `${stage}: nothing opened by itself over ${path}`);
      for (const what of await uncovered(page, scope, coverageOf(steps(routes)), { help })) missing.push(`${stage} › ${path}: ${what}`);
    }
    // Signed out, or the panel out of reach, the screens never ask for anything.
    if (shell) for (const r of unansweredReads(stub)) empty.add(`${stage}: ${r}`);
  } }));
  await sideBySide(jobs, 3, { grants: EVERYTHING, overrides: (job) => stageFor({ stage: job.stage }, EVERYTHING) });
  assert.deepEqual(errors, [], "errors on the page");
  missing.sort();
  recordGaps("states", missing);
  assert.deepEqual(crashed, [], "screens that crashed into their \"could not be shown\" card");
  assert.deepEqual([...empty].sort(), [], "reads a state answered with nothing: give each its data in STAGES or WALK_FIXTURES (test/walk-stage)");
  assert.deepEqual(missing, KNOWN_GAPS.states, "controls a state shows that no walkthrough step rings, and settings none names");
});

/*
 * What opens over the screens, or turns one into something else, on a computer and on a phone:
 * Search, the account's menu and the menu's layout editor, a screen's panels being arranged, a
 * request being built and its review, the panel viewed as a role, a walkthrough's slideshow and
 * Show me on my screen, and Getting started, page by page. Each is explained by a step on the
 * screen it is opened from — or, for what is the same over every screen, by any step — or listed
 * in KNOWN_GAPS.overlays.
 */
const OVERLAYS = (phone) => {
  const search = { css: phone ? ".topbar .cmdk-trigger" : ".sidebar .cmdk-trigger" };
  const account = phone ? [{ click: { css: ".topbar-account" } }, { click: { css: ".settings-trigger" } }] : [{ click: { css: ".settings-trigger" } }];
  const card = { click: { panel: "Start here", button: "Find your way around" } };
  const setup = [{ click: { panel: "Start here", button: "Personal setup" } }, { click: { dialog: true, button: "Let's start" } }];
  const next = { click: { dialog: true, button: "Next" } };
  return [
    { path: "/", acts: [{ click: search }], scope: "dialog", routes: "all" },
    { path: "/", acts: [{ click: search }, { fill: { dialog: true, css: ".cmdk-input" }, value: "ban" }], scope: "dialog", routes: "all" },
    { path: "/", acts: account, scope: "dialog", routes: "all" },
    { path: "/", acts: [...account, { click: { button: "▦ Edit layout" } }], scope: "main", routes: "all" },
    { path: "/settings", acts: [{ click: { button: "⧉ Arrange panels" } }], scope: "main", routes: "all" },
    { path: "/moderation/requests", acts: [{ click: { button: "Build a request" } }], scope: "shell", routes: "all" },
    { path: "/moderation/requests", acts: [{ click: { button: "Build a request" } }, { click: { css: ".request-bar button" } }], scope: "dialog", routes: "all" },
    { path: "/admin/users", acts: [{ click: { panel: "Roles", button: "View as" } }], scope: "shell", routes: "all" },
    { path: "/help/start", acts: [card], scope: "dialog", routes: ["help.start"] },
    { path: "/help/start", acts: [card, { click: { dialog: true, button: "Show me on my screen" } }], scope: "shell", routes: "all" },
    { path: "/help/start", acts: [setup[0]], scope: "dialog", routes: ["help.start"] },
    // Getting started's pages after the first: each Next one further.
    ...Array.from({ length: 7 }, (_, k) => ({ path: "/help/start", acts: [...setup, ...Array(k).fill(next)], scope: "dialog", routes: ["help.start"] })),
  ];
};

test("every control in the overlays and modes around the screens has a walkthrough step", { skip: SKIP }, async () => {
  const missing = [];
  for (const phone of [false, true]) {
    await withPage({ grants: EVERYTHING, overrides: WALK_FIXTURES, ...(phone ? { viewport: PHONE } : {}) }, async (page, { stub, errors }) => {
      let n = 0;
      const said = new Set();
      for (const { path, acts, scope, routes } of OVERLAYS(phone)) {
        await forget(page);
        await page.goto(`${stub.base}/?overlay=${++n}#${path}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(250);
        const place = `${phone ? "phone" : "computer"} › ${path} › ${acts.map(words).join(" › ")}`;
        // A dialog a step leads into, by ringing what opens it, has its foot explained by that step,
        // and the settings a step names for it, by opening it first, are named — as in e2e-1.
        const opener = acts[0].click;
        const opts = scope === "dialog" ? { dialogNamed: namedForDialog(steps(routes), opener), reached: await ringed(page, steps(routes), opener) } : {};
        for (const a of acts) assert.ok(await act(page, a), `${place}: nothing to do for ${JSON.stringify(a)}`);
        await page.waitForTimeout(400);
        for (const what of await uncovered(page, scope, coverageOf(steps(routes)), opts)) {
          // Each once on each screen: Getting started's foot is on every page of it.
          const key = `${phone} ${scope} ${what}`;
          if (!said.has(key)) missing.push(`${place}: ${what}`);
          said.add(key);
        }
        await page.keyboard.press("Escape");
      }
      assert.deepEqual(errors, []);
    });
  }
  recordGaps("overlays", missing);
  assert.deepEqual(missing, KNOWN_GAPS.overlays, "controls in an overlay or a mode that no walkthrough step rings, and settings none names");
});

/*
 * The panel as someone holding every permission at read only sees it: each screen they can open,
 * the profiles, the menus of a player's actions and the dialogs their items and the screens'
 * buttons open. What they cannot do themselves reads "Send for approval", "Ask to…" — explained
 * by a step as the button everyone else presses is, or listed in KNOWN_GAPS.readOnly.
 */
test("every control someone who may only look sees has a walkthrough step", { skip: SKIP }, async () => {
  const grants = CAPABILITY_CATALOG.map((c) => held(c.key, "read"));
  const missing = [];
  const errors = [];
  // Each gap once on each page, whichever way it was reached there.
  const said = new Set();
  const note = (place, list) => {
    const page = place.split(" › ")[0];
    for (const what of list) if (!said.has(`${page} ${what}`)) { said.add(`${page} ${what}`); missing.push(`${place}: ${what}`); }
  };
  const screens = [...SCREENS.filter((s) => canOpenRoute(grants, ROUTES.find((r) => r.id === s.routes[0]))), ...SUBJECT_PAGES.map(([path, routes]) => ({ path, routes }))];
  // Live's roster on its scoreboard, as a table, a player ticked where they may be.
  const setUp = async (page, base, path, setup, n) => {
    await open(page, base, path, n);
    if (!setup) return;
    const roster = page.locator(".panel", { hasText: "Roster" });
    await roster.getByRole("button", { name: "Scoreboard", exact: true }).click();
    await roster.locator(".seg-btn", { hasText: "Table" }).first().click();
    // Someone who may only look may not tick players for what to do to them all.
    const tick = page.locator(".scoreboard tbody tr input[type=checkbox]");
    if (setup === "ticked" && await tick.count()) await tick.first().check();
  };
  // Three looks at once, each on a page of its own: the screens, the menus of a player's actions
  // and what their items open, and the dialogs the screens' buttons open.
  const parts = [
    async (page, base) => {
      let n = 0;
      for (const { path, routes, help = false } of screens) {
        await open(page, base, path, ++n);
        note(path, await uncovered(page, "main", coverageOf(stepsOn(routes)), { help }));
      }
    },
    async (page, base) => {
      let n = 0;
      for (const [path, routes, opener, setup] of MENUS) {
        const cover = coverageOf(stepsOn(routes));
        await setUp(page, base, path, setup, ++n);
        if (!(await press(page, opener))) continue;
        await page.waitForTimeout(250);
        const items = await menuItems(page);
        note(`${path} › ${opener.button ?? "⋯"}`, await uncovered(page, "dialog", cover, { reached: true }));
        for (const item of items) {
          await setUp(page, base, path, setup, ++n);
          await press(page, opener);
          await page.waitForTimeout(250);
          const reached = await ringed(page, stepsOn(routes), { button: item });
          await pressItem(page, item);
          await page.waitForTimeout(300);
          if (await dialogOpen(page)) note(`${path} › ${item}`, await uncovered(page, "dialog", cover, { dialogNamed: namedForDialog(stepsOn(routes), { button: item }), reached }));
        }
      }
    },
    async (page, base) => {
      let n = 0;
      // Those still offered to someone who may only look.
      for (const [path, routes, opener] of DIALOGS) {
        await open(page, base, path, ++n);
        const download = /^Download\b/.test(opener.button ?? "");
        const reached = download || /^[✕×]$/.test(opener.button ?? "") || await ringed(page, stepsOn(routes), opener);
        if (!(await press(page, opener))) continue;
        await page.waitForTimeout(300);
        if (!(await overlayOpen(page))) continue;
        note(`${path} › ${opener.button ?? opener.css}`, await uncovered(page, "dialog", coverageOf(stepsOn(routes)), { dialogNamed: download ? namedForDownload() : namedForDialog(stepsOn(routes), opener), reached }));
        await page.keyboard.press("Escape");
      }
    },
  ];
  await sideBySide(parts.map((part) => ({ run: async (page, stub) => {
    page.on("pageerror", (e) => errors.push(String(e)));
    await part(page, stub.base);
  } })), parts.length, { grants, overrides: WALK_FIXTURES });
  assert.deepEqual(errors, []);
  missing.sort();
  recordGaps("readOnly", missing);
  assert.deepEqual(missing, KNOWN_GAPS.readOnly, "controls someone who may only look sees that no walkthrough step rings, and settings none names");
});
