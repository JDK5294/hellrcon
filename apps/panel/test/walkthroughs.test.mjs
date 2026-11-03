// Help's walkthroughs (lib/walkthroughs.ts): each about permissions that exist, listed under their
// group, on screens Help may show — each step with its picture on a computer and on a phone, every
// permission with one — and each person shown only the ones their own permissions let them follow. The browser half (test/e2e-2) checks every step's
// control is really on its screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCORD_PANEL, IN_DISCORD, WALKTHROUGHS, WALK_GROUPS, onPhone, searchWalkthroughs, stageKey, walkthroughsFor } from "../lib/walkthroughs.ts";
import { ROUTES, minLevelFor, routeById } from "../lib/routes.ts";
import { CAPABILITY_CATALOG } from "../../../packages/access/src/capabilities.ts";
import { STAGES, walkGrants } from "./walk-stage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const IMAGES = join(here, "..", "public", "walkthroughs");
/** The two sets of pictures: a computer's screen, and a phone's, where each step is as onPhone has it. */
const SCREENS = [
  { name: "computer", shots: JSON.parse(readFileSync(join(here, "..", "lib", "walkthroughShots.json"), "utf8")), images: IMAGES, step: (s) => s },
  { name: "phone", shots: JSON.parse(readFileSync(join(here, "..", "lib", "walkthroughShotsPhone.json"), "utf8")), images: join(IMAGES, "phone"), step: onPhone },
];
const CATALOG = new Map(CAPABILITY_CATALOG.map((c) => [c.key, c]));
const g = (capability, level = "write", extra = {}) => ({ capability, scopeType: "global", scopeId: null, level, ...extra });
const ids = (grants) => walkthroughsFor(grants).map((w) => w.id);
const walk = (grants, id) => walkthroughsFor(grants).find((w) => w.id === id);

/** A target names one thing to find it by, or only where to look (a dialog, a panel). */
function wellFormed(t) {
  const by = ["nav", "tab", "button", "field", "setting", "css"].filter((k) => t[k] !== undefined);
  return by.length === 1 || (by.length === 0 && (t.dialog || t.panel));
}

/** One thing to do, said shortly: the picture shows the rest. */
function wellWritten(text, at) {
  assert.ok(text.length <= 140, `${at}: ${text.length} characters is a paragraph, not a step`);
  assert.ok(text.split(/(?<=[.!?])\s+/).length <= 2, `${at}: at most two sentences`);
  assert.match(text, /[.!?]$/, `${at}: a whole sentence`);
}

test("every walkthrough is about real permissions, under their group, on screens Help may show", () => {
  const seen = new Set();
  for (const w of WALKTHROUGHS) {
    assert.ok(!seen.has(w.id), `${w.id}: one walkthrough per id`);
    seen.add(w.id);
    assert.ok(WALK_GROUPS.includes(w.group), `${w.id}: "${w.group}" is not a group Start here lists`);
    assert.ok(w.title.length <= 40 && w.blurb.length <= 90, `${w.id}: a short title and a one-line blurb`);
    for (const k of w.keywords ?? []) assert.match(k, /^[a-z0-9][a-z0-9 '-]*$/, `${w.id}: "${k}" is a word or two someone would search for`);
    for (const c of w.caps) {
      assert.ok(CATALOG.has(c), `${w.id}: "${c}" is not a permission`);
      assert.equal(CATALOG.get(c).group, w.group, `${w.id}: listed under ${w.group}, but "${c}" is a ${CATALOG.get(c).group} permission`);
    }
    if (!w.caps.length) assert.equal(w.group, "Getting around", `${w.id}: only getting around is for everyone`);
    for (const c of w.needs ?? []) assert.ok(CATALOG.has(c), `${w.id}: "${c}" is not a permission`);
    assert.ok(w.steps.length > 0, `${w.id}: has steps`);
    for (const [n, s] of w.steps.entries()) {
      const at = `${w.id} step ${n + 1}`;
      if (s.discord) {
        // In Discord: no screen, and nothing to do first — the drawing opens where the step is.
        assert.equal(s.route, IN_DISCORD, `${at}: a step in Discord is on no screen`);
        assert.equal(routeById(IN_DISCORD), undefined, `no screen is called "${IN_DISCORD}"`);
        assert.ok(!s.before && !s.setup && !s.stage && !s.phone, `${at}: nothing is done first in Discord, and a phone draws it the same`);
        assert.equal(s.target.panel, DISCORD_PANEL, `${at}: it points into the drawing of the panel`);
      } else {
        const route = routeById(s.route);
        assert.ok(route, `${at}: "${s.route}" is not a screen`);
        assert.ok(!route.ownerOnly, `${at}: an owner-only screen is never shown in Help`);
      }
      for (const c of [...(s.caps ?? []), ...(s.needs ?? [])]) assert.ok(CATALOG.has(c), `${at}: "${c}" is not a permission`);
      if (s.capLevel) assert.ok(s.caps?.length && s.caps.every((c) => minLevelFor(c) === "read"), `${at}: write asks more only of a permission whose read is less`);
      // A state its picture is taken in, by a name the stage knows (test/walk-stage STAGES).
      if (s.stage !== undefined) assert.ok(Object.hasOwn(STAGES, s.stage), `${at}: "${s.stage}" is not a state the stage can be put in`);
      // As it is on a computer, and as it is on a phone.
      for (const [v, as] of [["", s], [" on a phone", onPhone(s)]]) {
        assert.ok(wellFormed(as.target), `${at}${v}: the target names one thing to find it by`);
        for (const a of as.before ?? []) assert.ok(wellFormed(a.click ?? a.fill), `${at}${v}: what is done first names one thing`);
        wellWritten(as.text, `${at}${v}`);
      }
      if (s.phone) assert.ok(Object.keys(s.phone).length > 0 && Object.keys(s.phone).every((k) => ["text", "target", "before"].includes(k)), `${at}: a phone's words, target or first actions`);
    }
  }
});

/*
 * A step that explains settings names each by the words its label starts with, once, and is about
 * where they are — the panel or the dialog — so the browser tests can find each one there.
 */
test("a step names the settings it explains by their labels' words, once each, where they are", () => {
  for (const w of WALKTHROUGHS) for (const [i, s] of w.steps.entries()) {
    if (s.fields === undefined) continue;
    const at = `${w.id} step ${i + 1}`;
    assert.ok(s.fields.length > 0, `${at}: names at least one setting`);
    assert.ok(s.target.panel || s.target.dialog, `${at}: its target says where the settings are, a panel or a dialog`);
    for (const f of s.fields) assert.ok(typeof f === "string" && f.length > 0 && f.length <= 80 && f.trim() === f, `${at}: "${f}" is the start of a label`);
    assert.equal(new Set(s.fields).size, s.fields.length, `${at}: each setting named once`);
  }
});

/*
 * What the coverage tests take as explained once for every screen (test/coverage-kit) is explained,
 * in "Use a screen's panels and lists", which everyone is shown.
 */
test("the controls every screen shares are explained once, where everyone can follow it", () => {
  const w = WALKTHROUGHS.find((x) => x.id === "use-screens");
  assert.deepEqual(w.caps, [], "everyone's");
  const said = w.steps.map((s) => s.text).join(" ");
  for (const words of ["fold it away", "Explanation", "Arrange panels", "column's name", "Download", "a key", "Clear filters", "Refresh", "↻", "copies", "pages", "preset", "Try again", "Cancel", "Close"]) {
    assert.ok(said.includes(words), `"Use a screen's panels and lists" does not explain "${words}"`);
  }
});

test("the menu's machine status, and the button an update brings, are explained", () => {
  // The button shows only once the panel is updated under a tab left open, which no picture or
  // browser test can bring about: its step is held to its words here, as the menu says them.
  const src = readFileSync(join(here, "..", "components", "SidebarStatus.tsx"), "utf8");
  const at = src.indexOf('className="hs-stale"');
  assert.ok(at > 0, "the menu offers to reload");
  const words = src.slice(src.indexOf("}>", at) + 2, src.indexOf("</button>", at)).trim();
  const steps = WALKTHROUGHS.flatMap((w) => w.steps).filter((s) => /\.host-status\b/.test(s.target.css ?? ""));
  assert.equal(steps.length, 1, "one step rings the menu's status");
  assert.ok(steps[0].text.includes(words), `its step says "${words}"`);
});

test("every permission has a walkthrough of its own", () => {
  // Whatever someone is given, Start here can show them how to use it.
  const covered = new Set(WALKTHROUGHS.flatMap((w) => w.caps));
  assert.deepEqual(CAPABILITY_CATALOG.map((c) => c.key).filter((k) => !covered.has(k)), [], "permissions no walkthrough is about");
});

test("every screen has a walkthrough for each permission that opens it", () => {
  // Whichever permission puts a screen in someone's menu, holding it alone (at the least level it
  // opens with) gives them a walkthrough with a step on that screen. A hub is its tabs.
  const hubs = new Set(ROUTES.filter((r) => r.parent).map((r) => r.parent));
  const gaps = [];
  for (const r of ROUTES) {
    if (hubs.has(r.id) || r.ownerOnly) continue;
    const by = r.caps?.length ? r : (r.parent ? routeById(r.parent) : r);
    const ways = by.caps?.length ? by.caps.map((c) => [c, by.capLevel ?? minLevelFor(c)]) : [[null, null]];
    for (const [c, level] of ways) {
      const pair = `${r.id} via ${c ?? "everyone"}`;
      if (!walkthroughsFor(c ? [g(c, level)] : []).some((w) => w.steps.some((s) => s.route === r.id))) gaps.push(pair);
    }
  }
  assert.deepEqual(gaps, [], "screens a permission opens, with no walkthrough on them for it");
});

test("every step has its picture on a computer and on a phone, ringed inside it, and every picture belongs to a step", () => {
  for (const screen of SCREENS) {
    const used = new Set();
    for (const w of WALKTHROUGHS) {
      for (const [n, s] of w.steps.entries()) {
        // A step in Discord has no picture: the slideshow draws the panel it is in.
        if (s.discord) continue;
        const key = stageKey(screen.step(s));
        used.add(key);
        const shot = screen.shots[key];
        assert.ok(shot, `${w.id} step ${n + 1} has no ${screen.name} picture: run scripts/walkthrough-shots.mjs`);
        assert.ok(shot.w > 0 && shot.h > 0 && Array.isArray(shot.ring) && shot.ring.length === 4, `${w.id} step ${n + 1}: the ${screen.name} picture's size and its ring`);
        assert.ok(existsSync(join(screen.images, `${key}.webp`)), `${w.id} step ${n + 1}: the ${screen.name} picture ${key}.webp is missing`);
      }
    }
    assert.deepEqual(Object.keys(screen.shots).filter((k) => !used.has(k)), [], `${screen.name} pictures listed that no step shows`);
    const files = readdirSync(screen.images, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name);
    assert.deepEqual(files.filter((f) => !used.has(f.replace(/\.webp$/, ""))), [], `${screen.name} picture files no step shows`);
  }
  // The ring is inside its picture, and starts where what it rings starts: something taller than
  // the window is shown from its top, title and all — not by its middle, ringed off both ends.
  for (const screen of SCREENS) {
    for (const [key, { w, h, ring: [x, y, rw, rh] }] of Object.entries(screen.shots)) {
      assert.ok(x >= 0 && y >= 0 && x + rw <= w && y + rh <= h, `${screen.name} picture ${key}: its ring runs out of it`);
      assert.ok(y > 0 || y + rh < h, `${screen.name} picture ${key} shows the middle of what it rings, not its top: delete it and run scripts/walkthrough-shots.mjs`);
    }
  }
  // On a phone the menu folds away behind ☰: a screen's entry in it is ringed with the menu open,
  // and the slideshow says to open it first.
  const phone = SCREENS[1].shots;
  for (const w of WALKTHROUGHS) {
    for (const [n, s] of w.steps.entries()) {
      if (onPhone(s).target.nav) assert.equal(phone[stageKey(onPhone(s))].menu, true, `${w.id} step ${n + 1}: ringed in the open menu on a phone`);
    }
  }
  // A walkthrough's pictures are taken as someone holding what it asks and no more
  // (test/walk-stage.mjs): someone shown every one of its steps, at the level each asks.
  for (const w of WALKTHROUGHS) assert.equal(walkthroughsFor(walkGrants(w)).find((x) => x.id === w.id)?.steps.length, w.steps.length, `${w.id}: its pictures' person is shown every step`);
});

test("each person is shown the walkthroughs for what they hold, with only the steps they can take", () => {
  // Nobody holds anything: finding their way around — without the server picker they cannot use —
  // Help, their settings and password, staff notices, the dashboard and the staff command in
  // Discord. Asking for approval is followed on Moderation, which they cannot open.
  const everyone = ["getting-around", "use-help", "use-screens", "your-settings", "change-password", "read-notices", "arrange-dashboard", "discord-staff"];
  assert.deepEqual(ids([]), everyone);
  assert.ok(ids([g("server.view", "read")]).includes("ask-approval"), "anyone who can open Moderation can");
  assert.equal(walk([], "getting-around").steps.some((s) => /server picker|Pick which one/.test(s.text)), false);
  assert.equal(walk([g("server.view", "read")], "getting-around").steps.length, 14);

  // Kicking, one player or several: theirs once they hold it and can open Live, where it happens.
  const viewer = ids([g("server.view", "read")]);
  const kicker = [g("server.view", "read"), g("action.kick")];
  assert.deepEqual(ids(kicker).filter((id) => !viewer.includes(id)), ["kick-player", "act-on-several"]);
  assert.equal(walk(kicker, "kick-player").steps.length, 5, "where kicks are listed needs the staff trail");
  const auditor = [...kicker, g("audit.trail", "read")];
  assert.equal(walk(auditor, "kick-player").steps.at(-1).route, "moderation.kicks", "with it, the last step shows where kicks are listed");
  assert.deepEqual(ids([g("action.kick")]), everyone, "without Live there is nowhere to kick from");
  assert.deepEqual(ids([g("server.view", "read"), g("action.kick", "read")]), viewer, "read is no level of kicking");

  // A request's wider view lends a look at screens, not the permission to act on them.
  assert.deepEqual(ids([g("server.view", "read"), g("action.kick", "write", { source: "request-view" })]), viewer);

  // Each walkthrough asks for its own screens: messaging everyone needs no roster, messaging one does.
  assert.deepEqual(ids([g("action.message")]), [...everyone, "ask-approval", "message-everyone"], "messaging opens Moderation, where requests are followed");
  assert.deepEqual(ids([g("action.unban")]), everyone, "lifting a ban happens on the ban list");
  assert.ok(ids([g("action.unban"), g("moderation.bans", "read")]).includes("lift-ban"));

  // Seeing who has VIP is the read of the permission; giving it is the write.
  assert.ok(ids([g("vip.grant", "read")]).includes("see-vips"));
  assert.ok(!ids([g("vip.grant", "read")]).includes("give-vip"), "read gives no VIP");
  assert.ok(ids([g("vip.grant")]).includes("give-vip"));

  // A tab is pressed only where there is a tab bar: a screen with one tab for this person shows none.
  const tabStep = (grants) => walk(grants, "economy-settings").steps.some((s) => s.target.tab === "Economy");
  assert.equal(tabStep([g("economy.config")]), false, "Economy is their only tab under Players");
  assert.equal(tabStep([g("economy.config"), g("server.view", "read")]), true, "beside the directory's tabs, it is one to press");

  // A screen shows each control to the permission the server checks for it, and the walkthrough
  // goes with that permission alone — not to holders of another map or server permission.
  assert.ok(ids([g("server.view", "read"), g("maps.rotation")]).includes("edit-rotation"), "the rotation editor is on their screen");
  assert.ok(!ids([g("server.view", "read"), g("maps.next")]).includes("edit-rotation"), "setting the next map shows no rotation editor");
  assert.ok(ids([g("server.add")]).includes("add-server"), "Add server is on their screen");
  assert.ok(!ids([g("server.manage")]).includes("add-server"), "looking after the servers there adds none");

  // The owner: every walkthrough, every step.
  const all = walkthroughsFor([g("*")]);
  assert.deepEqual(all.map((w) => w.id), WALKTHROUGHS.map((w) => w.id));
  for (const w of all) assert.equal(w.steps.length, WALKTHROUGHS.find((x) => x.id === w.id).steps.length, `${w.id}: every step`);
});

/*
 * The staff command's panel lives in Discord, where no screen test looks: its parts are read from
 * the API, as it registers them (apps/api/src/discord-modules.ts). A part left off the panel's own
 * list is reached through a door in the part its Back leads to, and is known by the door's name.
 */
const API = join(here, "..", "..", "api", "src");
function staffCommandParts() {
  const files = readdirSync(API).filter((f) => /^discord-[\w-]+\.ts$/.test(f)).map((f) => readFileSync(join(API, f), "utf8"));
  const register = files.join("\n").match(/export function registerBuiltinModules[\s\S]*?\n\}/)[0];
  const parts = [...register.matchAll(/registry\.register\((?:\{ \.\.\.)?(\w+)\(.*?\)(?:, hidden: true, backTo: "(\w+)" \})?\);/g)].map(([, factory, backTo]) => {
    const src = files.find((f) => f.includes(`export function ${factory}(`));
    const body = src.slice(src.indexOf(`export function ${factory}(`)).split("\nexport ")[0];
    const [, id, label, capability, level = "read"] = body.match(/\bid: "(\w+)",\s*label: "([^"]+)",\s*description: "[^"]*",[\s\S]*?\bcapability: "([\w.]+)",(?:\s*capabilityLevel: "(read|write)",)?/);
    const door = backTo ? files.join("\n").match(new RegExp(`label: "([^"]+)", customId: "", moduleId: "${id}"`))?.[1] : undefined;
    return { id, label, capability, level, backTo, name: door ?? label };
  });
  assert.equal(parts.length, register.match(/registry\.register\(/g).length, "every part the API registers is read");
  return parts;
}

test("every part of the staff command in Discord has its step, for whoever may open it", () => {
  const parts = staffCommandParts();
  const byId = new Map(parts.map((p) => [p.id, p]));
  for (const p of parts) {
    const hub = p.backTo ? byId.get(p.backTo) : undefined;
    assert.ok(!p.backTo || (hub && p.name !== p.label), `${p.label}: its door, in ${p.backTo}, is found`);
    const opens = [g(p.capability, p.level), ...(hub ? [g(hub.capability, hub.level)] : [])];
    const told = (grants) => walk(grants, "discord-staff").steps.some((s) => s.text.startsWith(`${p.name} `) || s.text.startsWith(`${p.name},`));
    assert.ok(told(opens), `${p.label}: a step starts with "${p.name}" for whoever may open it`);
    assert.equal(told([]), false, `${p.label}: and not for whoever may not`);
    if (p.level === "write" && minLevelFor(p.capability) === "read") assert.equal(told([g(p.capability, "read"), ...opens.slice(1)]), false, `${p.label}: reading ${p.capability} does not open it`);
    if (hub) assert.equal(told(opens.slice(0, 1)), false, `${p.label}: without ${hub.label}, there is no door to it`);
  }
});

/*
 * Help's drawing of the staff command is the bot's own screens: in the browser tests, the
 * stand-in API's sample of them (test/staff-panel-sample.json), drawn once by the bot's code. Each
 * button and picker in it must still be one the bot draws, or a walkthrough step would show what
 * Discord does not.
 */
test("every button and picker in the drawing of the staff command is one the bot draws", () => {
  const sample = JSON.parse(readFileSync(join(here, "staff-panel-sample.json"), "utf8"));
  const src = readdirSync(API).filter((f) => /^discord-[\w-]+\.ts$/.test(f)).map((f) => readFileSync(join(API, f), "utf8")).join("\n");
  const screens = [sample.panel.home, ...Object.values(sample.panel.parts).map((p) => p.message), sample.maps, sample.moderation];
  const drawn = screens.flatMap((m) => m.components.flatMap((row) => row.components.map((c) => c.label ?? c.placeholder)));
  assert.ok(drawn.length > 40, "the launcher, every part and the two servers' screens");
  for (const words of drawn) assert.ok(src.includes(`"${words}"`), `"${words}" is not something the bot draws`);
  // Each part is in it, so a step ringing one finds it.
  assert.deepEqual(Object.keys(sample.panel.parts).sort(), staffCommandParts().map((p) => p.id).sort());
});

/*
 * Some lists reach a screen from the server: what Data trim can trim, the parts Backup can export,
 * each game's own settings. A browser test sees only the stage's few, so each list is read here
 * from where it is defined, and the step about it names every one.
 */
const REPO = join(here, "..", "..", "..");
const labelsIn = (file, opener) => {
  const src = readFileSync(join(REPO, file), "utf8");
  const m = opener.exec(src);
  assert.ok(m, `${opener} is in ${file}`);
  // To the bracket that closes the list.
  let depth = 0, end = src.length;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) { end = i; break; }
  }
  return [...src.slice(m.index, end).matchAll(/label: "([^"]+)"/g)].map((x) => x[1]);
};
const fieldsOf = (id, test) => WALKTHROUGHS.find((w) => w.id === id).steps.filter(test).flatMap((s) => s.fields ?? []);

test("every kind the server lists for Data trim and Backup, and every game's setting, has its step", () => {
  const trim = fieldsOf("trim-data", (s) => s.target.field === "Kills");
  const kinds = [...labelsIn("packages/db/src/types.ts", /export const TRIM_CATEGORY_INFO\b[^=]*= \[/), ...labelsIn("packages/db/src/types.ts", /export const TRIM_DATASETS\b[^=]*= \[/)];
  assert.ok(kinds.length > 10, "Data trim's kinds are read");
  for (const label of kinds) assert.ok(trim.includes(label), `Data trim's "${label}" is not named`);
  const exported = fieldsOf("make-backup", (s) => s.target.panel === "Export" && s.target.button === "Export");
  const parts = labelsIn("packages/db/src/types.ts", /export const DATA_EXPORT_GROUPS\b[^=]*= \[/);
  assert.ok(parts.length > 10, "Export's parts are read");
  for (const label of parts) assert.ok(exported.includes(label), `Export's "${label}" is not named`);
  const live = fieldsOf("change-live-settings", () => true);
  for (const game of ["hll", "hllv"]) {
    const settings = labelsIn(`packages/games/src/${game}.ts`, /configFields: \[/);
    assert.ok(settings.length > 5, `${game}'s settings are read`);
    for (const label of settings) assert.ok(live.some((f) => label.startsWith(f)), `${game}'s "${label}" is not named on Live settings`);
  }
});

test("a search finds the walkthrough for what someone wants to do, among those they may follow", () => {
  const all = walkthroughsFor([g("*")]);
  const found = (q) => searchWalkthroughs(all, q).map((w) => w.id);
  assert.equal(found("kick")[0], "kick-player");
  assert.equal(found("boot a player")[0], "kick-player", "the words someone uses, not only the panel's");
  assert.deepEqual(found("how do I unban someone"), ["lift-ban"], "the words around what they want say nothing");
  assert.equal(found("bans")[0], "temp-ban", "a plural asks what its singular does");
  assert.equal(found("give vip")[0], "give-vip", "a title holding the words comes first");
  assert.ok(found("give vip").every((id) => /vip/.test(id) || searchWalkthroughs([WALKTHROUGHS.find((w) => w.id === id)], "vip").length), "all of the words, when some match all of them");
  assert.deepEqual(found("how do i"), [], "nothing asked, nothing found");
  // A setting is found by its own name.
  assert.deepEqual(found("shuffle").sort(), ["change-live-settings", "rotating-broadcasts"], "the setting that does it, and the broadcasts' own");
  // Beside everything else Search lists, only walkthroughs matching every word.
  assert.ok(found("ban appeal").length > 0, "Start here lists what matches the most words");
  assert.deepEqual(searchWalkthroughs(all, "ban appeal", { every: true }), [], "Search lists only what matches them all");
  assert.deepEqual(searchWalkthroughs(all, "welcome message", { every: true }).map((w) => w.id).sort(), ["change-live-settings", "rotating-broadcasts"], "a setting, by its own name, and the panel that keeps it filled in");
  assert.equal(searchWalkthroughs(all, "boot a player", { every: true })[0]?.id, "kick-player");
  // Only what this person may follow: someone who may kick finds kicking, and no banning.
  const kicker = walkthroughsFor([g("server.view", "read"), g("action.kick")]);
  assert.deepEqual(searchWalkthroughs(kicker, "kick").map((w) => w.id), ["kick-player"]);
  // Banning is not theirs: what a search for it finds is how to ask for one.
  assert.deepEqual(searchWalkthroughs(kicker, "ban").map((w) => w.id), ["ask-approval"]);
  assert.deepEqual(searchWalkthroughs(kicker, "ban a player").map((w) => w.id), ["ask-approval"], "never a walkthrough on a word most hold alone");
});

/* The words staff use for their everyday tasks each find a walkthrough, and a setting by its name. */
test("everyday words find a walkthrough", () => {
  const all = walkthroughsFor([g("*")]);
  assert.deepEqual(searchWalkthroughs(walkthroughsFor([]), "accent").map((w) => w.id), ["your-settings"], "found by a setting it names");
  for (const phrase of ["give vip", "admin cam", "group", "message", "change map", "map vote", "kick", "punish", "switch team", "ban"]) {
    assert.ok(searchWalkthroughs(all, phrase).length > 0, `no walkthrough is found by "${phrase}"`);
  }
});

/*
 * What Show me sets as a step begins is a switch a screen remembers, named by its panel and its
 * words — never a step of the person's, so nothing it teaches. Every step about a player on Live's
 * roster sets the Roster to Scoreboard: its Live feed, where Live may have been left, hides the rows.
 */
test("what Show me sets first is a switch in a named panel, and the roster's steps set Scoreboard", () => {
  for (const w of WALKTHROUGHS) for (const [i, s] of w.steps.entries()) {
    for (const t of s.setup ?? []) {
      assert.deepEqual(Object.keys(t).sort(), ["button", "panel"], `${w.id} step ${i + 1}: ${JSON.stringify(t)} is a button in a panel`);
    }
  }
  const onRow = WALKTHROUGHS.flatMap((w) => w.steps).filter((s) => s.route === "live"
    && [s.target, ...(s.before ?? []).map((a) => a.click)].some((t) => t?.css?.includes('aria-label="More"')));
  assert.ok(onRow.length > 20, `only ${onRow.length} steps on a roster row`);
  for (const s of onRow) assert.ok(s.setup?.some((t) => t.panel === "Roster" && t.button === "Scoreboard"), `"${s.text}" sets the Roster to Scoreboard`);
});

test("a picture is named by what it shows, not by the words under it", () => {
  const step = { route: "live", target: { css: "a" }, before: [{ click: { css: "b" } }] };
  assert.equal(stageKey(step), stageKey({ ...step, text: "other words" }), "the words do not change the picture");
  assert.equal(stageKey(step), stageKey(structuredClone(step)), "the same stage, the same name");
  assert.notEqual(stageKey(step), stageKey({ ...step, route: "players.players" }));
  assert.notEqual(stageKey(step), stageKey({ ...step, target: { css: "c" } }));
  assert.notEqual(stageKey(step), stageKey({ ...step, before: [] }));
  assert.match(stageKey(step), /^[0-9a-z]+$/, "safe as a file name");
});
