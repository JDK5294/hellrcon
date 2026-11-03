// The public demo (app/demo, lib/demo): the panel itself on a made-up community, answered in the
// visitor's browser. The stub stands in for the real API here, so every
// request it is sent from the demo is one the demo must never make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIP, withPage } from "./e2e-kit.mjs";
import { screenCrashed } from "./coverage-kit.mjs";
import { ROUTES } from "../lib/routes.ts";

/** The requests the real API was sent since `from`. */
const since = (stub, from) => stub.requests.slice(from);

/** Open the demo on this browser, where the real panel is signed in. */
async function openDemo(page, stub) {
  await page.goto(`${stub.base}/demo/`, { waitUntil: "networkidle" });
  await page.locator(".demo-bar").waitFor({ timeout: 10_000 });
}

/*
 * Every screen of the panel opens in the demo, as an owner sees it, from the demo's own answers:
 * not one request reaches the API. What the demo keeps in the browser is its own, and the real
 * panel's sign-in and settings on this device are as they were.
 */
test("the demo opens every screen on made-up data without one request to the real API, and leaves the real panel's storage alone", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    // The real panel on this device: its sign-in (e2e-kit's), and a look of its own.
    await page.evaluate(() => window.localStorage.setItem("panel.theme.mode", "light"));
    const from = stub.requests.length;
    await openDemo(page, stub);
    assert.match(await page.locator(".demo-bar").innerText(), /A made-up community\. What you change lasts until you reload\./);
    assert.equal(await page.evaluate(() => window.localStorage.getItem("panel.theme.mode")), "dark", "the demo's own look, not the real panel's");
    const crashed = [];
    for (const r of ROUTES) {
      await page.evaluate((hash) => { window.location.hash = hash; }, `#${r.path}`);
      await page.waitForTimeout(250);
      if (await screenCrashed(page)) crashed.push(r.id);
    }
    assert.deepEqual(crashed, [], "every screen draws");
    // Settings change in the demo, as people change them.
    await page.evaluate(() => window.localStorage.setItem("panel.theme.mode", "system"));
    assert.deepEqual(since(stub, from), [], "not one request reached the real API");
    assert.deepEqual(errors, [], "no uncaught page errors");

    await page.goto(stub.base, { waitUntil: "networkidle" });
    const real = await page.evaluate(() => ({ token: window.localStorage.getItem("panel.token"), theme: window.localStorage.getItem("panel.theme.mode"), keys: Object.keys(window.localStorage) }));
    assert.equal(real.token, "test-token", "the real panel is still signed in as it was");
    assert.equal(real.theme, "light", "and looks as it did");
    assert.deepEqual(real.keys.filter((k) => /demo/.test(k)), [], "nothing of the demo's is left in the real panel's storage");
  });
});

/*
 * Every address the real API answers at is answered in the page: the panel's own (/api) and a
 * server's public ones (/s/…/api, /stats/…/api), whichever way the request is written. Not one goes
 * over the network; a change is refused in the page too.
 */
test("the demo answers every address the API has in the page, its own and a server's public ones", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    await openDemo(page, stub);
    const sent = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (/^\/(?:api(?:\/|$)|(?:s|stats)\/[^/]+\/api\/)/i.test(path)) sent.push(`${r.method()} ${path}`);
    });
    const answered = await page.evaluate(async () => {
      const reads = ["/api/me", "/s/s1/api/get_status", "/stats/main/api/get_live_scoreboard", new URL("/api/servers", window.location.href).href, new Request("/api/players")];
      const statuses = await Promise.all(reads.map((r) => window.fetch(r).then((res) => res.status)));
      const change = await window.fetch(new Request("/api/servers/s1/actions", { method: "POST", body: "{}" })).then(async (res) => [res.status, (await res.json()).error?.message]);
      return { statuses, change };
    });
    assert.deepEqual(answered.statuses, [200, 200, 200, 200, 200], "each read answered");
    assert.deepEqual(answered.change, [400, "The demo doesn't keep this change. On your own panel it would be made."], "a change refused in the page");
    await page.waitForTimeout(300);
    assert.deepEqual(sent, [], "not one went over the network");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The demo is dark for every visitor, from its first paint: on a device that prefers light, and
 * where the real panel was set to light with an accent of its own. The browser's own bar is tinted
 * to match. The real panel keeps its own look.
 */
test("the demo is dark from its first paint, whatever the device prefers and the real panel was set to", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => { window.localStorage.setItem("panel.theme.mode", "light"); window.localStorage.setItem("panel.theme.accent", "#ff5d8f"); });
    // The look once the page's markup has been read, before the panel has drawn anything of its own.
    await page.addInitScript(() => window.document.addEventListener("DOMContentLoaded", () => {
      const r = window.document.documentElement;
      // The browser's bar takes the first tint tag that applies to this device.
      const bar = [...window.document.querySelectorAll('meta[name="theme-color"]')].find((m) => !m.media || window.matchMedia(m.media).matches)?.getAttribute("content");
      window.__parsed = { theme: r.getAttribute("data-theme"), accent: r.style.getPropertyValue("--accent"), bar };
    }));
    const look = () => page.evaluate(() => {
      const r = window.document.documentElement;
      const bar = [...window.document.querySelectorAll('meta[name="theme-color"]')].find((m) => !m.media || window.matchMedia(m.media).matches)?.getAttribute("content");
      return { theme: r.getAttribute("data-theme"), accent: r.style.getPropertyValue("--accent"), bar };
    });
    const dark = { theme: "dark", accent: "", bar: "#0a0c10" };
    // Put on by the page itself, ahead of everything the panel draws.
    const html = await (await fetch(`${stub.base}/demo/`)).text();
    const putOn = html.indexOf("setAttribute('data-theme','dark')");
    assert.ok(putOn > 0 && putOn < html.indexOf('class="auth-wrap"'), "the dark look comes before the page's first markup");
    await openDemo(page, stub);
    assert.deepEqual(await page.evaluate(() => window.__parsed), dark, "dark as the page is read");
    assert.deepEqual(await look(), dark, "and the panel keeps it so");
    // Settings applies the look the panel has stored: the demo's own.
    await page.evaluate(() => { window.location.hash = "#/settings"; });
    await page.locator(".panel-title", { hasText: /^Appearance$/ }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    assert.deepEqual(await look(), dark, "in Settings too");
    await page.goto(stub.base, { waitUntil: "networkidle" });
    assert.deepEqual(await look(), { theme: "light", accent: "#ff5d8f", bar: "#f5f7fa" }, "the real panel keeps its own look");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A change the demo does not keep is answered in words that say so, as a refusal would be on the
 * real panel, and what was on screen goes back to how it was.
 */
test("a change the demo does not keep says so", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    const from = stub.requests.length;
    await openDemo(page, stub);
    await page.evaluate(() => { window.location.hash = "#/admin/online"; });
    const panel = page.locator(".panel").filter({ has: page.locator(".panel-title", { hasText: /^Public demo$/ }) });
    await panel.locator("label.toggle").click();
    await panel.getByText("The demo doesn't keep this change. On your own panel it would be made.").waitFor({ timeout: 10_000 });
    assert.equal(await panel.locator("label.toggle input").isChecked(), true, "the switch goes back");
    assert.deepEqual(since(stub, from), [], "and the change went nowhere");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The panel's other pages, and its API by an address, would leave the demo: a link to one stays
 * put and the bar says why. A file made in the page still downloads, and other sites open.
 */
test("a link out of the demo is not followed, and the bar says why", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub }) => {
    const from = stub.requests.length;
    await openDemo(page, stub);
    const at = page.url();
    await page.evaluate(() => {
      const a = window.document.createElement("a");
      a.href = "/stats/some-server";
      a.textContent = "the stats site";
      a.id = "out";
      window.document.querySelector(".demo-bar").append(a);
    });
    await page.locator("#out").click();
    await page.locator(".demo-bar", { hasText: "That link leads out of the demo." }).waitFor({ timeout: 5_000 });
    assert.equal(page.url(), at, "still in the demo");
    assert.equal(await page.evaluate(() => window.open("/api/me")), null, "nor does a window open on the API");
    // A click on a link in the page, as a download button makes one; the default (the download) is not run.
    const kept = await page.evaluate(() => {
      const a = window.document.createElement("a");
      a.href = window.URL.createObjectURL(new window.Blob(["made here"]));
      window.document.body.append(a);
      let defaultDone = false;
      a.addEventListener("click", (e) => { defaultDone = !e.defaultPrevented; e.preventDefault(); });
      a.dispatchEvent(new window.MouseEvent("click", { cancelable: true, bubbles: true }));
      a.remove();
      return defaultDone;
    });
    assert.equal(kept, true, "a file made in the page downloads");
    assert.deepEqual(since(stub, from), [], "nothing reached the real API");
  });
});

/*
 * The real panel's service worker (phone notifications) is registered for the whole address, the
 * demo's pages too. The demo cannot reach it: signing out of the demo, which turns notifications off
 * on the real panel, leaves the device's alone — and the demo starts again, still signed in.
 */
test("signing out of the demo starts it again, and leaves the device's notifications alone", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    await page.evaluate(async () => { await window.navigator.serviceWorker.register("/sw.js", { scope: "/" }); await window.navigator.serviceWorker.ready; });
    await openDemo(page, stub);
    assert.equal(await page.evaluate(async () => (await window.navigator.serviceWorker.getRegistration("/")) === undefined), true, "out of the demo's reach");
    assert.equal(await page.evaluate(() => "PushManager" in window), false, "and no notifications to turn on");
    await page.locator(".settings-trigger").click();
    await page.getByRole("menuitem", { name: /Log out/ }).click();
    await page.waitForLoadState("networkidle");
    await page.locator(".demo-bar").waitFor({ timeout: 10_000 });
    assert.equal(new URL(page.url()).pathname, "/demo/", "the demo again");
    await page.goto(stub.base, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(async () => Boolean(await window.navigator.serviceWorker.getRegistration("/"))), true, "the device's registration is still there");
    assert.equal(await page.evaluate(() => window.localStorage.getItem("panel.token")), "test-token", "and the real panel still signed in");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The made-up community is big enough to page through, and its lists answer as the real ones do:
 * the players go on page after page, and a search narrows them.
 */
test("the demo's players fill page after page, and a search narrows them", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    const from = stub.requests.length;
    await openDemo(page, stub);
    await page.evaluate(() => { window.location.hash = "#/players"; });
    const pager = page.locator(".load-more.pager").first();
    const counted = () => pager.locator("span").first().innerText();
    await pager.locator(".pager-where", { hasText: /^Page 1 of 8$/ }).waitFor({ timeout: 10_000 });
    assert.match(await counted(), /^1–50 of 400 /);
    const firstRow = () => page.locator("tbody tr").first().innerText();
    const before = await firstRow();
    await pager.getByTitle("Next page").click();
    await pager.locator(".pager-where", { hasText: /^Page 2 of 8$/ }).waitFor({ timeout: 10_000 });
    assert.match(await counted(), /^51–100 of 400 /);
    // The pager moves on as it is pressed; the page's rows land a moment after.
    await page.waitForFunction((b) => window.document.querySelector("tbody tr")?.innerText !== b, before, { timeout: 10_000 });
    assert.notEqual(await firstRow(), before, "another page of players");
    await page.getByPlaceholder("Search name or ID…").fill("Badger");
    await page.waitForFunction(() => [...window.document.querySelectorAll("tbody tr")].length > 0
      && [...window.document.querySelectorAll("tbody tr")].every((r) => r.textContent.includes("Badger")), null, { timeout: 10_000 });
    assert.deepEqual(since(stub, from), [], "nothing reached the real API");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * A round is being played on the first server: Live's feed shows it as it happens, and the
 * scoreboard's kills go up.
 */
test("Live plays a round in the demo: the feed shows it as it happens, and the kills go up", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    const from = stub.requests.length;
    await openDemo(page, stub);
    await page.evaluate(() => { window.location.hash = "#/live"; });
    // Both sides' kills, as the header counts them.
    const killsRow = page.locator(".team-stats .ts-row").filter({ has: page.locator(".ts-label", { hasText: /^Kills$/ }) });
    const kills = () => killsRow.locator(".ts-val").allInnerTexts().then((v) => v.reduce((n, t) => n + Number(t.replace(/\D/g, "")), 0));
    await killsRow.waitFor({ timeout: 10_000 });
    const was = await kills();
    assert.ok(was > 100, `a round some way in: ${was} kills so far`);
    await page.getByRole("button", { name: "Live feed" }).click();
    const rows = page.locator(".live-feed .live-row");
    await rows.first().waitFor({ timeout: 15_000 });
    // It opens on the round being played, not on a round from Help's pictures.
    const map = await page.evaluate(() => window.fetch("/api/servers/s1/live").then((r) => r.json()).then((l) => l.session.mapName));
    const round = page.locator("span", { hasText: /^this round · / });
    await round.waitFor({ timeout: 10_000 });
    assert.match(await round.innerText(), new RegExp(`^this round · ${map} Warfare · from `));
    assert.doesNotMatch(await page.locator(".live-feed").innerText(), /Caereca|Kestrel|Quillon|Marlow/, "none of the pictures' players");
    // The feed holds the round so far, as many rows as it shows: what happens next comes in on top.
    const top = await rows.first().innerText();
    await page.waitForFunction((t) => window.document.querySelector(".live-feed .live-row")?.innerText !== t, top, { timeout: 15_000 });
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.waitForFunction(async (w) => {
      const vals = [...window.document.querySelectorAll(".team-stats .ts-row")].find((r) => r.querySelector(".ts-label")?.textContent === "Kills")?.querySelectorAll(".ts-val") ?? [];
      return [...vals].reduce((n, v) => n + Number(v.textContent.replace(/\D/g, "")), 0) > w;
    }, was, { timeout: 15_000 });
    assert.deepEqual(since(stub, from), [], "nothing reached the real API");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/*
 * The demo's screens have something on them where a busy community's would: server analytics'
 * heatmap of every day and its split by platform, and the rotation the dashboard's tile lists, the
 * map Live is playing marked.
 */
test("the demo's server analytics draw the heatmap and the platforms, and the dashboard lists the rotation", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    const from = stub.requests.length;
    await openDemo(page, stub);
    await page.evaluate(() => { window.location.hash = "#/analytics/server"; });
    const when = page.locator(".panel", { hasText: "When people play" }).first();
    await when.locator("rect.hm-cell").first().waitFor({ timeout: 10_000 });
    assert.equal(await when.locator("rect.hm-cell").count(), 5 * 24, "a square for every hour of every day");
    const platforms = page.locator(".panel", { hasText: "By platform" }).first();
    await platforms.locator("tbody tr").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await platforms.locator("tbody tr td:first-child").allInnerTexts(), ["Steam (PC)", "Epic (PC)"], "the community's platforms, the bigger first");
    assert.equal(await platforms.locator("svg.viz-chart polyline").count(), 2, "a line for each across the window");

    // The map Live is playing, from the demo's own read.
    const map = await page.evaluate(() => window.fetch("/api/servers/s1/live").then((r) => r.json()).then((l) => l.session.mapName));
    await page.evaluate(() => { window.location.hash = "#/dashboard"; });
    const rows = page.locator(".maprot-row");
    await rows.first().waitFor({ timeout: 10_000 });
    assert.ok(await rows.count() >= 3, "the maps the server plays through");
    assert.equal(await page.locator(".maprot-row.current .recent-label").innerText(), map, "the one Live is playing marked");
    // The watched players the community's own lists mark, as the VIPs are.
    const watched = await page.evaluate(() => window.fetch("/api/players?watched=1&limit=1").then((r) => r.json()).then((r) => r.total));
    await page.locator(".vw-tab", { hasText: `Watched (${watched})` }).waitFor({ timeout: 10_000 });
    assert.deepEqual(since(stub, from), [], "nothing reached the real API");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});

/* One link serves the demo and its walkthroughs: the demo's bar opens Help's, and Start over comes back. */
test("the demo's bar opens Help's walkthroughs, and Start over brings the demo back to its start", { skip: SKIP }, async () => {
  await withPage({ grants: [] }, async (page, { stub, errors }) => {
    const from = stub.requests.length;
    await openDemo(page, stub);
    await page.locator(".demo-bar a", { hasText: /^Walkthroughs$/ }).click();
    await page.waitForFunction(() => window.location.hash === "#/help/start", null, { timeout: 10_000 });
    await page.locator(".panel-title", { hasText: /^Start here$/ }).waitFor({ timeout: 10_000 });
    await page.getByText("Find your way around", { exact: true }).waitFor();
    await page.locator(".demo-bar button", { hasText: /^Start over$/ }).click();
    await page.waitForFunction(() => window.location.pathname === "/demo/" && !window.location.hash.startsWith("#/help"), null, { timeout: 10_000 });
    await page.locator(".demo-bar").waitFor({ timeout: 10_000 });
    await page.locator(".maprot-row").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(since(stub, from), [], "nothing reached the real API");
    assert.deepEqual(errors, [], "no uncaught page errors");
  });
});
