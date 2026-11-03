// Integrity of the route registry — the table the sidebar, breadcrumbs, URLs, page titles and the
// command palette all read from. A mistake here is silently wrong everywhere at once (a nav entry
// that leads nowhere, a tab you can only reach by luck, two screens claiming the same URL), so the
// invariants are asserted rather than assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUTES, SECTIONS, routeById, tabsOf, trailFor, locationFromPath, pathFor, canOpenRoute, minLevelFor } from "../lib/routes.ts";
import { hasCap, isOwner } from "../lib/access.ts";
// Read straight out of @app/access rather than importing the package. The panel deliberately does
// not depend on it — lib/access.ts is a hand-written client mirror so no server code ships to the
// browser — but the catalogue is plain data with no imports of its own, and the whole point of
// these assertions is that the registry cannot drift from it.
import { CAPABILITY_CATALOG, ROLE_PRESETS } from "../../../packages/access/src/capabilities.ts";

test("every route is uniquely identified and addressable", () => {
  const ids = new Set(), paths = new Set();
  for (const r of ROUTES) {
    assert.ok(!ids.has(r.id), `duplicate route id: ${r.id}`);
    assert.ok(!paths.has(r.path), `duplicate path: ${r.path} (${r.id})`);
    ids.add(r.id); paths.add(r.path);
    assert.ok(r.path.startsWith("/"), `${r.id} path must start with /`);
    // The promise the registry makes: everything explains itself in one sentence.
    assert.ok(r.title && r.title.trim(), `${r.id} needs a title`);
    assert.ok(r.blurb && r.blurb.length > 20, `${r.id} needs a real description`);
  }
});

/*
 * The ground rules moved onto Map zones and answer to its permission, so the page's search words
 * and description, and the permission's own description, have to say so — or the section is found
 * only by whoever already knows where it went, and a role editor grants it without being told.
 */
test("the ground rules on Map zones are findable, and the permission that opens them says so", () => {
  const zones = routeById("autosettings.zones");
  for (const word of ["ground rules", "seeding areas", "steamroll"]) assert.ok(zones.keywords.includes(word), `Map zones' search words name "${word}"`);
  assert.match(zones.blurb, /ground rules/i, "and its description does");
  const rules = CAPABILITY_CATALOG.find((c) => c.key === "admin.moderation");
  assert.match(rules.description, /Map zones/);
  assert.match(rules.description, /ground rules/i);
});

test("tabs belong to a real destination and are named <view>.<tab>", () => {
  for (const r of ROUTES.filter((x) => x.parent)) {
    const parent = routeById(r.parent);
    assert.ok(parent, `${r.id} has unknown parent ${r.parent}`);
    assert.ok(!parent.parent, `${r.id}: tabs can't nest under another tab`);
    assert.ok(r.id.startsWith(`${r.parent}.`), `${r.id} must be named "${r.parent}.<tab>"`);
    assert.ok(r.hidden, `${r.id} is a tab, so it must not appear as its own sidebar entry`);
  }
});

test("every sidebar destination sits in a known section", () => {
  for (const r of ROUTES.filter((x) => !x.parent && !x.hidden && x.section)) {
    assert.ok(SECTIONS.includes(r.section), `${r.id}: unknown section ${r.section}`);
  }
});

test("paths round-trip: a URL resolves to the location that generates it", () => {
  for (const r of ROUTES) {
    const loc = locationFromPath(r.path);
    if (r.parent) {
      assert.equal(loc.view, r.parent, `${r.path} should resolve to view ${r.parent}`);
      assert.equal(loc.tab, r.id.slice(r.parent.length + 1), `${r.path} tab mismatch`);
    } else {
      assert.equal(loc.view, r.id, `${r.path} should resolve to view ${r.id}`);
      assert.equal(loc.tab, undefined);
    }
    assert.equal(pathFor(loc.view, loc.tab), r.path, `${r.id} does not round-trip`);
  }
});

test("unknown paths degrade instead of dead-ending", () => {
  assert.deepEqual(locationFromPath("/"), { view: "dashboard" });
  assert.deepEqual(locationFromPath(""), { view: "dashboard" });
  // A tab the registry doesn't list (a dynamic auto-mod module) still resolves to its destination.
  assert.deepEqual(locationFromPath("/autosettings/mod:level"), { view: "autosettings", tab: "mod:level" });
  // A plugin view we've never heard of keeps its own id rather than silently becoming the dashboard.
  assert.deepEqual(locationFromPath("/some-plugin"), { view: "some-plugin" });
});

test("a shared walkthrough link round-trips, and a link to a How do I guide still lands in Help", () => {
  // #/help/start/~<id> is what a walkthrough's Copy link produces — the router must read the id
  // back out, and pathFor must rebuild the identical path, or shared links rot silently.
  assert.deepEqual(locationFromPath("/help/start/~watch-player"),
    { view: "help", tab: "start", subject: "watch-player" });
  assert.equal(pathFor("help", "start", "watch-player"), "/help/start/~watch-player");
  // The How do I guides are gone; a link to one, pasted before, still lands on Start here, which
  // says the walkthrough it names is not there.
  assert.deepEqual(locationFromPath("/help/guides/~watch-a-player"),
    { view: "help", tab: "start", subject: "watch-a-player" });
  assert.deepEqual(locationFromPath("/help/guides"), { view: "help", tab: "start" });
});

test("breadcrumb trails describe where you actually are", () => {
  assert.deepEqual(trailFor("players", "vips").map((r) => r.title), ["Players", "VIPs"]);
  assert.deepEqual(trailFor("live").map((r) => r.title), ["Live"]);
  // An unknown tab doesn't fabricate a crumb.
  assert.deepEqual(trailFor("players", "nope").map((r) => r.title), ["Players"]);
});

test("hubs that have tabs declare more than one", () => {
  for (const r of ROUTES.filter((x) => !x.parent)) {
    const tabs = tabsOf(r.id);
    assert.ok(tabs.length !== 1, `${r.id} declares exactly one tab — either add more or drop the tab`);
  }
});

/*
 * ---- The permission half of the registry ----
 *
 * apps/api guards its routes and asserts those guards against the capability catalogue. Nothing
 * asserted the PANEL's half, and that is where the drift collected: the catalogue and the API
 * agreed perfectly while the sidebar quietly refused to show four destinations to the people
 * entitled to them. These three tests close that loop.
 */

test("every capability the registry gates on is a real capability", () => {
  const known = new Set(CAPABILITY_CATALOG.map((c) => c.key));
  const strays = [];
  for (const r of ROUTES) for (const cap of r.caps ?? []) {
    if (!known.has(cap)) strays.push(`${r.id} gates on "${cap}", which no role can hold`);
  }
  assert.deepEqual(strays, [], strays.join("\n"));
});

/*
 * The containment rule. The sidebar shows a destination when you hold any of ITS capabilities, and
 * only then offers the tabs beneath it — so a capability that appears on a tab and not on its
 * parent describes a screen you own and cannot navigate to. Four of these existed at once: a VIP
 * manager and a group manager could not open Players, a map-vote operator could not open Maps, and
 * whoever looked after console admins could not open History to read the admin-camera log.
 */
test("a destination's capabilities cover every tab beneath it", () => {
  const gaps = [];
  for (const parent of ROUTES.filter((r) => !r.parent)) {
    const tabs = tabsOf(parent.id);
    if (!tabs.length || !parent.caps?.length) continue; // an ungated destination is always reachable
    const held = new Set(parent.caps);
    for (const t of tabs) for (const cap of t.caps ?? []) {
      if (!held.has(cap)) gaps.push(`${t.id} needs "${cap}", but ${parent.id} does not list it — its holder gets no nav entry`);
    }
  }
  assert.deepEqual(gaps, [], gaps.join("\n"));
});

/*
 * A capability with no destination is not automatically wrong — most of them gate a CONTROL (a kick
 * button, a note field) rather than a screen. But "we added a feature and forgot the nav" looks
 * exactly like a capability nothing routes to, so every such case is listed here with the reason.
 * Add a capability and this test makes you say which kind it is.
 */
const CONTROLS_NOT_DESTINATIONS = {
  // The Maps tabs are one destination; these are the separate controls ON them, now that "map
  // control" is no longer a single permission.
  "maps.next": "the set-next-map control on the Maps tabs, which server.view already opens",
  "maps.rotation": "the rotation editor on the Maps tabs",
  "maps.names": "the rename control on the Maps tabs",
  "mapvote.control": "the pause / force-winner / re-roll / skip buttons on the map vote surface",
  "server.add": "the 'Add server' form on Administration → Connections",
  "crcon.apply": "the 'Apply to panel' button on the CRCON backup screen",
  "autosettings.templates": "the save/apply template controls inside Auto settings",
  "moderation.bans.sync": "the 'Sync from servers' button on the Bans list",
  "moderation.requests.history": "the 'All request history' panel inside Moderation → Requests — the tab itself is open to everyone (filing and signing need no permission), so this grants a panel on it rather than a destination",
  "economy.shop": "the shop-offer editor inside the Economy tab",
  "economy.balances": "the member balance list and hand-adjust control inside the Economy tab",
  "staff.profiles": "the per-colleague profile page, reached by clicking a name in the audit trail",
  "action.kick": "a button in the action dialogs",
  "action.punish": "a button in the action dialogs",
  "action.tempban": "a button in the action dialogs",
  "action.permaban": "a button in the action dialogs",
  "action.unban": "a button on the Bans list",
  "action.switch": "a button in the action dialogs",
  "action.switch_death": "a button in the action dialogs",
  "vip.pause": "a tab inside the Edit VIP popup",
  "player.notes": "a panel on the player profile",
  "player.watchlist": "the watch control on the player profile and the live roster",
  "player.watchlist.curate": "the Edit/Remove controls on other staff's watch reasons, and 'Remove from watchlist' — profile Watchlist panel and the ⋯ menu",
  "player.tags": "the tag editor on the player profile",
  "player.links": "the identity-link editor on the player profile",
  "player.ips": "a self-gating panel on the player profile (it asks and renders nothing on 403)",
  "layout.edit": "the 'Save as team default' buttons — nav layout editor, dashboard edit mode, and every page's Arrange mode",
  "api.tokens": "the 'Create token' form in the API tokens card on Settings, which is open to everyone",
  "seeding.rewards": "the Seed reward and Recent seed payouts panels on Auto settings → Seeding, which Seeding opens",
};

test("every capability either opens a destination or is a named control", () => {
  const routed = new Set(ROUTES.flatMap((r) => r.caps ?? []));
  const unexplained = CAPABILITY_CATALOG
    .map((c) => c.key)
    .filter((key) => !routed.has(key) && !(key in CONTROLS_NOT_DESTINATIONS));
  assert.deepEqual(unexplained, [],
    "these capabilities reach no screen in the nav. If that's deliberate, say where they DO apply in CONTROLS_NOT_DESTINATIONS:\n" + unexplained.join("\n"));
  // …and the list must not outlive the capabilities it explains.
  const stale = Object.keys(CONTROLS_NOT_DESTINATIONS).filter((key) => !CAPABILITY_CATALOG.some((c) => c.key === key));
  assert.deepEqual(stale, [], "CONTROLS_NOT_DESTINATIONS explains capabilities that no longer exist: " + stale.join(", "));
});

test("links from before the reorganisation still land somewhere sensible", () => {
  // Each of these used to be its own destination; every one is now a tab. A bookmark from then
  // must not dead-end.
  const cases = {
    "/vips": { view: "players", tab: "vips" },
    // The blacklist folded into Bans, then Moderation grew tabs around it — so the old ban
    // bookmark lands on the Bans TAB rather than on whichever tab happens to come first.
    "/bans": { view: "moderation", tab: "bans" },
    "/blacklist": { view: "moderation", tab: "bans" },
    // Broadcast left the Automation section to become an Administration tab.
    "/broadcast": { view: "admin", tab: "broadcast" },
    "/logs": { view: "history", tab: "logs" },
    // "/events" changed owners twice: the retired plain event list pointed at the game log for a
    // while, and the path now belongs to the Events hub (scheduled windows, payouts, reports) —
    // the word means community events, and a years-old bookmark landing there is the least-wrong
    // of the two destinations.
    "/events": { view: "events" },
    "/servers": { view: "admin", tab: "connections" },
    "/config": { view: "admin", tab: "live" },          // the Config hub merged into Administration
    "/config/live": { view: "admin", tab: "live" },
    "/config/admins": { view: "admin", tab: "admins" },
    "/console": { view: "admin", tab: "console" },      // the raw console became an Admin tab
    "/autosettings": { view: "autosettings" },              // now the real Auto settings destination
    "/automod": { view: "autosettings" },                   // merged into Auto settings
    "/automod/rules": { view: "autosettings", tab: "rules" },
    "/config/auto": { view: "autosettings", tab: "settings" },
    "/users": { view: "admin", tab: "users" },
    "/enforcer": { view: "autosettings" },                  // renamed path, same destination
  };
  for (const [from, want] of Object.entries(cases)) {
    assert.deepEqual(locationFromPath(from), want, `${from} should resolve to ${JSON.stringify(want)}`);
  }
});

/*
 * The Moderation tabs must name EVERY system that acts on a player.
 *
 * Four do — staff by hand, the seeding automod, the auto-settings rule modules, and the Rules
 * tab's enforcer — and the tabs listed only the first three, so every firing of a Rules-tab rule
 * (ladders, role gates, the admin-camera triggers) audited correctly and appeared in none of
 * them. The lists are now derived from one source list; this asserts they cover it, and that the
 * prefixes are the ones the server actually writes rather than ones we agree with ourselves on.
 */
test("every enforcement source appears in every Moderation family", async () => {
  const { KICK_ACTIONS, PUNISH_ACTIONS, WARN_ACTIONS, ENFORCEMENT_SOURCES } = await import("../lib/enforcement.ts");
  for (const [name, list] of [["kicks", KICK_ACTIONS], ["punishments", PUNISH_ACTIONS], ["warnings", WARN_ACTIONS]]) {
    assert.equal(list.length, ENFORCEMENT_SOURCES.length, `${name} does not list one action per source`);
    for (const src of ENFORCEMENT_SOURCES) {
      assert.ok(list.some((a) => a.startsWith(`${src}.`)), `the ${name} tab cannot see anything ${src}.* does`);
    }
  }
});

/*
 * …and no system is MISSING. The check above is self-consistent by construction — it derives the
 * sources from the same list the tabs do — so it cannot notice a fifth system nobody declared,
 * which is exactly how the enforcer went unlisted. This one goes the other way: it discovers the
 * audit-action families from the SERVER's own source and demands each be declared here.
 */
test("no enforcement system writes audit actions the Moderation tabs cannot see", async () => {
  const { readFileSync } = await import("node:fs");
  // The seeding automod's row is built in workers/src/seeding.ts (seedActionAudit), next to the plan.
  const src = ["../../api/src/enforcer.ts", "../../workers/src/index.ts", "../../workers/src/seeding.ts", "../../api/src/routes/servers.ts"]
    .map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
  const { ENFORCEMENT_SOURCES } = await import("../lib/enforcement.ts");

  // The audit action each enforcement system files, as written: the verb is decided at runtime,
  // so every one of them builds `prefix.${verb}` at the point it audits. Anchored on the audit
  // field itself rather than on any template that looks similar — plain prose in an error message
  // is not an audit action.
  const found = new Set();
  for (const m of src.matchAll(/(?:\baction:|\bauditAction\s*=)[^`\n]*`([a-z]+)\.\$\{/g)) found.add(m[1]);
  // Three families since the player-rule modules became Rules triggers: the worker's own
  // `autosettings.${verb}` enforcement writer retired with them (its remaining audits are fixed
  // strings), and their firings now audit under the enforcer's prefix like every other rule.
  assert.ok(found.size >= 3, `only found ${[...found]} — the scan stopped matching how the server writes audit actions`);
  for (const prefix of found) {
    assert.ok(
      ENFORCEMENT_SOURCES.includes(prefix),
      `"${prefix}.*" audit actions are written by the server but no Moderation tab lists them — add it to lib/enforcement.ts (this is the bug that hid every Rules-tab firing)`,
    );
  }
});

/*
 * The registry is the ONE place a screen says what it is for. That only holds if nothing re-types a
 * blurb: `Hub` normally reads the header line straight out of here, but a hub that passes its own
 * `subtitle` (the Auto settings hub prefixes "Editing <server>") overrides that lookup, and the
 * copy it substituted drifted — the Seeding header still promised "a VIP reward once it goes live"
 * long after the reward could also pay community points, while search, help and the landing picker
 * showed the corrected sentence. Nobody sees both at once, so nothing catches it by reading.
 */
test("no component re-types a route's blurb", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../components/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  assert.ok(files.length > 20, "component scan found almost nothing — the path is wrong");
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const r of ROUTES) {
      assert.ok(
        !src.includes(r.blurb),
        `components/${f} contains "${r.id}"'s blurb verbatim — read it from the registry (routeById) instead, or the two copies will disagree`,
      );
    }
  }
});

/*
 * Help lists every screen but the owner-only ones (asserted on their own below), and never a page a
 * plugin adds: those join the registry only for the viewers the API lists them to, and help is the
 * page people screen-share to train new staff.
 */
test("help lists every screen but the owner-only ones, and never a plugin's page", async () => {
  const { HELP_ROUTES, ROUTES, setPluginPages } = await import("../lib/routes.ts");
  const ownerOnly = (r) => r.ownerOnly || (r.parent && routeById(r.parent)?.ownerOnly);
  try {
    setPluginPages([{ plugin: "demo", id: "demo-page", title: "Demo Page", section: "Monitor", blurb: "A page a plugin adds.", permission: "demo.view", outright: true, ownerOnly: false }]);
    assert.equal(HELP_ROUTES.length, ROUTES.filter((r) => !ownerOnly(r)).length, "help must not quietly lose anything else");
    assert.ok(!HELP_ROUTES.some((r) => r.id === "demo-page"), "a plugin's page is not in help");
  } finally {
    setPluginPages([]);
  }
});

/*
 * ---- Owner-only screens ----
 *
 * No capability in the catalogue is owner-only — every one of them can be handed to a role, and the
 * Administrator preset holds all but one — so an owner screen is gated by `ownerOnly` and nothing
 * else, through the one predicate every nav surface asks. These pin the three ways that goes wrong:
 * a stray capability on the row (which would open it to whoever holds that capability), help
 * listing it (help is screen-shared to train staff), and the predicate counting something short of
 * a GLOBAL wildcard at write — which the API refuses an owner-only plugin page to (plugin-http.ts).
 */
const g = (capability, level, extra = {}) => ({ capability, level, scopeType: "global", scopeId: null, ...extra });
const OWNER = [g("*", "write")];
const ADMIN_PRESET = ROLE_PRESETS.find((p) => p.key === "admin").grants.map((x) => g(x.capability, x.level, { source: "role-admin" }));

test("owner-only screens carry no capabilities, and help never lists them", async () => {
  const { HELP_ROUTES } = await import("../lib/routes.ts");
  // None of the panel's own screens is owner-only today (a plugin's page can be); any that is must
  // carry no caps and stay out of help.
  const owned = ROUTES.filter((r) => r.ownerOnly);
  for (const r of owned) {
    assert.deepEqual(r.caps ?? [], [], `${r.id} is owner-only, so it must carry no caps — a capability would open it to its holders`);
    assert.equal(r.capLevel, undefined, `${r.id}: a capLevel means nothing on an owner-only row`);
    assert.ok(!HELP_ROUTES.some((h) => h.id === r.id || h.parent === r.id), `help lists ${r.id}`);
  }
});

test("only a GLOBAL wildcard at write is an owner", () => {
  assert.equal(isOwner(OWNER), true);
  assert.equal(isOwner([g("*", "write", { source: "role-owner" })]), true, "the Owner role, held through a role");
  assert.equal(isOwner([g("*", "write", { scopeType: undefined })]), true, "no scope says global, as the API reads it");
  // Full control of ONE server is not ownership — the API's owner routes resolve global grants only.
  assert.equal(isOwner([g("*", "write", { scopeType: "server", scopeId: "s1" })]), false);
  // The request builder's view elevation is a global "*" — at read, under its own source.
  assert.equal(isOwner([g("*", "read", { source: "request-view" })]), false);
  assert.equal(isOwner([g("*", "write", { source: "request-view" })]), false, "excluded by source, not only by level");
  assert.equal(isOwner([g("*", "read")]), false);
  assert.equal(isOwner(ADMIN_PRESET), false, "the Administrator preset holds every capability but is not an owner");
  // Vetoes as the server resolves them: a personal "*" none is the lockout; a role's binds that role.
  assert.equal(isOwner([g("*", "write", { source: "role-owner" }), g("*", "none")]), false);
  assert.equal(isOwner([g("*", "write", { source: "role-owner" }), g("*", "none", { source: "role-owner" })]), false);
  assert.equal(isOwner([g("*", "write", { source: "role-owner" }), g("*", "none", { source: "role-trial" })]), true);
  // A server-scoped block only blocks that server — ownership is global.
  assert.equal(isOwner([g("*", "write"), g("*", "none", { scopeType: "server", scopeId: "s1", source: "role-x" })]), true);
});

/*
 * Migration 156 carved the chat filter and the zone sets off the rules permission, and the bot's
 * setup and online access off user & role admin. Each tab opens for its own key — from the sidebar
 * too, so its parent opens for it alone — and no longer for the key it came from. The zone sets are
 * still read by the rules permission, whose editor picks one for every zone rule.
 */
test("canOpenRoute: the carved-off permissions open their own tabs, and the keys they came from no longer do", () => {
  const only = (capability) => [g(capability, "write")];
  for (const [route, opens, not] of [
    ["autosettings.chatfilter", "moderation.chatfilter", "admin.moderation"],
    ["discord.setup", "discord.setup", "admin.users"],
    ["admin.online", "admin.online", "admin.users"],
  ]) {
    assert.equal(canOpenRoute(only(opens), routeById(route)), true, `${opens} opens ${route}`);
    assert.equal(canOpenRoute(only(not), routeById(route)), false, `${not} no longer opens ${route}`);
  }
  for (const c of ["moderation.zones", "admin.moderation"]) assert.equal(canOpenRoute(only(c), routeById("autosettings.zones")), true, `${c} opens Map zones`);
  for (const [parent, c] of [["autosettings", "moderation.chatfilter"], ["autosettings", "moderation.zones"], ["discord", "discord.setup"], ["admin", "admin.online"]]) {
    assert.equal(canOpenRoute(only(c), routeById(parent)), true, `${c} alone opens ${parent}`);
  }
});

test("canOpenRoute: owner-only rows open for owners alone; every other row reads exactly as before", () => {
  const tab = { ownerOnly: true };
  const scoped = [g("*", "write", { scopeType: "server", scopeId: "s1" })];
  assert.equal(canOpenRoute(OWNER, tab), true);
  assert.equal(canOpenRoute(ADMIN_PRESET, tab), false, "an Administrator is never offered it");
  assert.equal(canOpenRoute(scoped, tab), false, "nor is a single server's owner");
  assert.equal(canOpenRoute([g("*", "read", { source: "request-view" })], tab), false, "nor someone building a request");
  assert.equal(canOpenRoute([], tab), false);
  // …while that server-scoped "*" still opens the Administration hub itself, as it always has.
  assert.equal(canOpenRoute(scoped, routeById("admin")), true);

  // The predicate replaced inline copies in the shell and Help; for every row that is not
  // owner-only (or `outright`, below) it must give the answer those copies gave.
  const before = (grants, r) => !r.caps?.length || r.caps.some((c) => hasCap(grants, c, r.capLevel ?? minLevelFor(c)));
  const sets = [OWNER, ADMIN_PRESET, scoped, [], [g("server.view", "read")], [g("admin.console", "read")], [g("admin.console", "write")]];
  for (const r of ROUTES.filter((x) => !x.ownerOnly && !x.outright)) {
    for (const grants of sets) assert.equal(canOpenRoute(grants, r), before(grants, r), `${r.id} with ${JSON.stringify(grants).slice(0, 80)}`);
  }
});

/*
 * An `outright` row opens only on a GLOBAL grant the account holds itself — the same answer the
 * API gives (holdsOutright in @app/access). A "*" confined to one server and the global read an
 * open request draft lends both used to open it, while every call behind it answered 404.
 */
test("canOpenRoute: an outright row needs the account's own global grant", async (t) => {
  const { setPluginPages, pluginRouteById } = await import("../lib/routes.ts");
  t.after(() => setPluginPages([]));
  // A plugin's page granted by name only, as the API lists one.
  setPluginPages([{ plugin: "demo", id: "demo-page", title: "Demo Page", section: "Monitor", blurb: "A page a plugin adds.", permission: "demo.view", outright: true, ownerOnly: false }]);
  const row = pluginRouteById("demo-page");
  const cap = row.caps[0];
  assert.equal(canOpenRoute(OWNER, row), true, "the owner's global \"*\" opens it");
  assert.equal(canOpenRoute([g(cap, "read")], row), true, "so does the capability granted by name, globally");
  assert.equal(canOpenRoute([g("*", "write", { scopeType: "server", scopeId: "s1" })], row), false, "a one-server \"*\" does not");
  assert.equal(canOpenRoute([g("*", "read", { source: "request-view" })], row), false, "nor the read an open request draft lends");
  assert.equal(canOpenRoute([g(cap, "read", { source: "request-view" })], row), false, "even naming the capability");
  assert.equal(canOpenRoute([], row), false);
});

/*
 * Plugin pages join the registry at runtime, from the API's list of the ones this viewer may open.
 * They answer routeById like any screen (the tab title, the sidebar's sections, the palette), carry
 * their permission as caps so role previews narrow them the same way, and can never take an address
 * a built-in screen owns or once owned.
 */
test("plugin pages join the registry: addressable, gated like any route, never over a built-in screen", async () => {
  const { setPluginPages, pluginRoutes, pluginRouteById, OUTRIGHT_CAPS } = await import("../lib/routes.ts");
  const { previewGrantsForRole } = await import("../lib/access.ts");
  const page = (over) => ({ plugin: "demo", id: "demo-page", title: "Demo Page", section: "Monitor", blurb: "A page a plugin adds.", permission: "demo.view", outright: true, ownerOnly: false, ...over });
  try {
    setPluginPages([
      page(),
      page({ id: "demo-open", permission: null, outright: false, section: "Nowhere" }),
      page({ id: "demo-owner", permission: null, outright: false, ownerOnly: true }),
      page({ id: "live", title: "Impostor" }), // a built-in destination's id
      page({ id: "users" }), // a built-in screen's OLD address (legacy redirect)
      page({ id: "demo-page", title: "Twice" }), // the same id again
    ]);
    assert.deepEqual(pluginRoutes().map((r) => r.id), ["demo-page", "demo-open", "demo-owner"], "built-in addresses, old or new, stay the panel's");
    assert.equal(routeById("live")?.title, "Live");
    const demo = routeById("demo-page");
    assert.deepEqual({ path: demo.path, title: demo.title, section: demo.section, caps: demo.caps, outright: demo.outright, plugin: pluginRouteById("demo-page").plugin },
      { path: "/demo-page", title: "Demo Page", section: "Monitor", caps: ["demo.view"], outright: true, plugin: "demo" });
    assert.equal(routeById("demo-open").section, undefined, "a section the sidebar does not have is no section");
    assert.deepEqual(locationFromPath("/demo-page"), { view: "demo-page" });
    assert.equal(pathFor("demo-page"), "/demo-page");

    // Gated exactly like a built-in route.
    const g = (capability, level = "read", scopeType = "global", scopeId = null) => ({ capability, level, scopeType, scopeId });
    assert.equal(canOpenRoute([g("demo.view")], demo), true);
    assert.equal(canOpenRoute([], demo), false);
    assert.equal(canOpenRoute([g("*", "write", "server", "s1")], demo), false, "an outright permission is not reached by a one-server wildcard");
    assert.equal(canOpenRoute([], routeById("demo-open")), true);
    assert.equal(canOpenRoute([g("demo.view")], routeById("demo-owner")), false);
    assert.equal(canOpenRoute([g("*", "write")], routeById("demo-owner")), true);

    // A role preview asks the outright question of the previewer too.
    assert.ok(OUTRIGHT_CAPS.has("demo.view"));
    const real = [g("*", "write", "server", "s1"), g("server.view")];
    assert.equal(canOpenRoute(previewGrantsForRole(real, [{ capability: "demo.view", level: "read" }], OUTRIGHT_CAPS), demo), false,
      "a preview never opens a page the previewer could not open themselves");
    assert.equal(canOpenRoute(previewGrantsForRole([g("demo.view")], [{ capability: "server.view", level: "read" }], OUTRIGHT_CAPS), demo), false,
      "nor one the role does not hold");
    assert.equal(canOpenRoute(previewGrantsForRole([g("demo.view")], [{ capability: "demo.view", level: "read" }], OUTRIGHT_CAPS), demo), true);

    // A fresh list replaces the old one, outright permissions with it; the panel's own stay.
    const builtInOutright = [...OUTRIGHT_CAPS].filter((c) => c !== "demo.view");
    setPluginPages([]);
    assert.deepEqual(pluginRoutes(), []);
    assert.equal(routeById("demo-page"), undefined);
    assert.deepEqual([...OUTRIGHT_CAPS].sort(), builtInOutright.sort());
  } finally {
    setPluginPages([]);
  }
});
