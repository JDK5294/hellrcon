/**
 * WALKTHROUGHS — Help's "Start here": each thing a permission lets someone do, shown one step at a
 * time on a picture of the panel with the control ringed, and on the person's own screen when they
 * ask ("Show me on my screen").
 *
 * Each person is shown the walkthroughs for what they hold, and nothing else. A walkthrough names
 * the permissions it is about (any of them makes it theirs), and each of its steps names the screen
 * it happens on: a step on a screen they cannot open is left out — or, unless it is marked
 * `optional`, the whole walkthrough is, since a walkthrough missing a step it needs would send them
 * somewhere that refuses them. The screens are judged by the same rule the menu uses
 * (lib/routes canOpenRoute), so a walkthrough can never offer a screen the menu would not.
 *
 * The pictures are rendered from the real panel by scripts/walkthrough-shots.mjs, which opens each
 * step as someone holding just that walkthrough's permissions, rings the target and writes the
 * image beside its position (lib/walkthroughShots.json). A browser test does the same without the
 * camera and fails when a step's control is no longer on its screen.
 *
 * Writing one:
 *  - A step is one thing to do, in a sentence or two, in the words on the screen.
 *  - `target` names what to ring by its words (lib/walkTarget). Steps that need a menu open or a
 *    field filled first say so in `before`; only the picture-taker and the test act on it — the
 *    panel never clicks anything on someone's behalf.
 *  - Every setting is explained somewhere: a step rings it, or a step about its panel or dialog
 *    names it in `fields` and says in its words what it does. The browser test opens
 *    every screen, folded panel, dialog and editor and fails on a setting neither rings nor names.
 *  - Never an owner-only screen: those are never shown in Help.
 */
import { hasCap, type ClientGrant } from "./access.ts";
import { ROUTES, canOpenRoute, minLevelFor, routeById } from "./routes.ts";
import type { WalkTarget } from "./walkTarget.ts";

/** Something done before a step's picture is taken: open a menu, open a dialog, type an example —
 *  or, in a list, pick the option with those words. */
export type WalkAction = { click: WalkTarget } | { fill: WalkTarget; value: string };

export interface WalkStep {
  /** What to do, in a sentence or two. */
  text: string;
  /** The screen it happens on: a route id ("live", "moderation.bans"). */
  route: string;
  /** What to ring. */
  target: WalkTarget;
  /** What has to happen first for the target to be there (a menu opened). */
  before?: WalkAction[];
  /** How its screen must be set for the target to be there, which a screen remembers from the last
   *  visit: a switch in a panel (the Roster on Scoreboard — its Live feed hides every row). The
   *  pictures start that way; Show me sets it as the step begins, where someone left it otherwise. */
  setup?: WalkTarget[];
  /** The state the panel must be in for the target to be there at all, when it is not how a panel
   *  usually stands: a CRCON pull running, a Vietnam server, a server in observe mode. Its picture
   *  is taken in that state (test/walk-stage STAGES); Show me can only find the control while the
   *  person's own panel is in it, and says so when it is not. */
  stage?: string;
  /** Shown only to those holding any of these too — and left out quietly for everyone else. */
  caps?: string[];
  /** The level those must be held at, when the step does more than look: posting the VIP panel in
   *  Discord is the write of the permission whose read only shows the economy's settings. */
  capLevel?: "write";
  /** And every one of these too, where the way to the step is another permission's: in Discord,
   *  the door to registering a member by hand is in Economy. */
  needs?: string[];
  /** A step that adds to the walkthrough but is not needed to follow it (where the result is
   *  listed, say): left out for whoever cannot open its screen, without hiding the rest. */
  optional?: boolean;
  /** What is different on a phone, where the menu folds away behind ☰ and the bar along the top
   *  holds Search and the account: the words, what to ring, what to do first. */
  phone?: { text?: string; target?: WalkTarget; before?: WalkAction[] };
  /** The settings this step explains, by the words their labels start with, as the screen shows
   *  them: each one in the panel or dialog the step is about. Its words say what each does, and
   *  Help's search finds the walkthrough by them. */
  fields?: string[];
  /** A step in Discord, in the panel the staff command opens there, which has no screen of the
   *  panel's to show or ring. Help draws that panel in the step's place instead, for whoever follows
   *  it (components/StaffPanelDrawing): the parts their permissions give them, under their
   *  community's name for the command, opened at `part` (at its list of parts without one), with
   *  the first of their servers picked where the part starts by picking one (`server`). Its route is
   *  IN_DISCORD, and its target points into the drawing (DISCORD_PANEL). */
  discord?: { part?: string; server?: boolean };
}

/** The route of a step in Discord (WalkStep.discord): no screen of the panel's. */
export const IN_DISCORD = "in-discord";
/** The name Help's drawing of the staff command's panel goes by, for a step to point into it. */
export const DISCORD_PANEL = "Staff command in Discord";

export interface Walkthrough {
  id: string;
  title: string;
  /** One sentence: what it shows. */
  blurb: string;
  /** Other words someone might search for it by: "boot" for kicking, "domain" for going online. */
  keywords?: string[];
  /** Any of these makes it this person's (each at its own lowest level). Empty: everyone's. */
  caps: string[];
  /** The level those must be held at, when doing it takes more than seeing it: giving VIP is the
   *  write of the permission whose read only shows who has it. */
  capLevel?: "write";
  /** And every one of these too, where the screen shows the controls only to holders of another
   *  permission as well — so the walkthrough goes only to those who will find them. */
  needs?: string[];
  /** Where it is listed: the permission group its permissions belong to. */
  group: string;
  steps: WalkStep[];
}

/** The order the groups are listed in: getting about first, then the permission groups. */
export const WALK_GROUPS = ["Getting around", "Player actions", "Bans & VIP", "Players", "Maps & votes", "Servers", "Automation", "Analytics", "Administration"] as const;

// ------------------------------------------------------------------ pieces several share ----

/** The ⋯ button on a roster row — on Live, the first row's. */
const ROW_MORE = '.player-actions button[aria-label="More"]';
/** The roster's rows are on its scoreboard, which Live remembers left on the feed. */
const SCOREBOARD: WalkTarget[] = [{ panel: "Roster", button: "Scoreboard" }];

const OPEN_LIVE: WalkStep = {
  text: "Open Live. Everyone on the server is listed, with their team and squad.",
  route: "live", target: { nav: "live" },
};
const ROW_MENU: WalkStep = {
  text: "Find the player, or search for them by name, and press ⋯ on their row.",
  route: "live", target: { css: ROW_MORE }, setup: SCOREBOARD,
};
/** "Choose <item>" on a roster row's ⋯ menu. */
const pick = (item: string, text: string): WalkStep => ({
  text, route: "live", before: [{ click: { css: ROW_MORE } }], target: { button: item }, setup: SCOREBOARD,
});
/** A step inside the dialog a menu item opens. */
const inDialog = (item: string, text: string, target: WalkTarget, fill?: [string, string]): WalkStep => ({
  text, route: "live", setup: SCOREBOARD,
  before: [
    { click: { css: ROW_MORE } }, { click: { button: item } },
    ...(fill ? [{ fill: { dialog: true, field: fill[0] }, value: fill[1] }] : []),
  ],
  target: { dialog: true, ...target },
});
/** A step in the Edit VIP popup a roster row's ⋯ opens, on one of its three tabs. */
const inVip = (tab: "Add VIP" | "Remove time" | "Pause VIP", text: string, target: WalkTarget, fills: [string, string][] = []): WalkStep => ({
  text, route: "live", setup: SCOREBOARD,
  before: [
    { click: { css: ROW_MORE } }, { click: { button: "★ Edit VIP" } },
    ...(tab === "Add VIP" ? [] : [{ click: { dialog: true, button: tab } }]),
    ...fills.map(([field, value]) => ({ fill: { dialog: true, field }, value })),
  ],
  target: { dialog: true, ...target },
});
const OPEN_MODERATION: WalkStep = { text: "Open Moderation.", route: "moderation.bans", target: { nav: "moderation" } };
/** Settings, from the person's name (on a phone, their initial in the bar along the top). */
const OPEN_SETTINGS: WalkStep = {
  text: "Your name, at the foot of the menu, opens Settings.", route: "settings", target: { css: ".sidebar-footer" },
  phone: { text: "Your initial, at the top right, opens Settings.", target: { css: ".topbar-account" } },
};
const OPEN_BANS: WalkStep = { text: "Open the Bans tab. Every ban is listed, newest first.", route: "moderation.bans", target: { tab: "Bans" } };
const OPEN_PLAYERS = (route: string): WalkStep => ({ text: "Open Players.", route, target: { nav: "players" } });
const OPEN_EVENTS = (route: string): WalkStep => ({ text: "Open Events.", route, target: { nav: "events" } });
/** Search, from the menu (on a phone, from the bar along the top). */
const OPEN_SEARCH: WalkAction[] = [{ click: { css: ".sidebar .cmdk-trigger" } }];
const OPEN_SEARCH_PHONE: WalkAction[] = [{ click: { css: ".topbar .cmdk-trigger" } }];
/** Your account's menu, from your name (on a phone, your initial opens the menu at it first). */
const OPEN_ACCOUNT: WalkAction[] = [{ click: { css: ".settings-trigger" } }];
const OPEN_ACCOUNT_PHONE: WalkAction[] = [{ click: { css: ".topbar-account" } }, { click: { css: ".settings-trigger" } }];
/** A walkthrough's slideshow, opened from Start here. */
const OPEN_WALK: WalkAction[] = [{ click: { panel: "Start here", button: "Find your way around" } }];
/** Getting started, opened again from Start here, at its nth page. */
const setupPage = (n: number): WalkAction[] => [
  { click: { panel: "Start here", button: "Personal setup" } },
  ...(n > 1 ? [{ click: { dialog: true, button: "Let's start" } }] : []),
  ...Array.from({ length: Math.max(0, n - 2) }, () => ({ click: { dialog: true, button: "Next" } })),
];
/** A request being built, and its review. */
const BUILD_REQUEST: WalkAction[] = [{ click: { button: "Build a request" } }];
/** A step in the staff command's panel in Discord, drawn in the step's place (WalkStep.discord): its
 *  list of parts, a part, or a part's screen for the first of the person's servers. */
const inDiscord = (part?: string, server = false): Pick<WalkStep, "route" | "discord"> =>
  ({ route: IN_DISCORD, discord: { ...(part ? { part } : {}), ...(server ? { server } : {}) } });
/** The drawing as a whole. */
const DRAWN: WalkTarget = { panel: DISCORD_PANEL };
/** The events list's Discord panel, folded until opened. */
const UNFOLD_POST: WalkAction[] = [{ click: { panel: "Post the list to Discord", css: ".panel-toggle" } }];

/** Opening a player's profile from the directory: the row-th player listed. */
const openProfile = (row = 1): WalkStep[] => [
  OPEN_PLAYERS("players.players"),
  { text: "Open the Directory tab.", route: "players.players", target: { tab: "Directory" } },
  { text: "Search for the player by name or id.", route: "players.players", target: { panel: "Directory", css: "input.search-input" } },
  { text: "Press their row to open their profile.", route: "players.players", target: { panel: "Directory", css: `tbody tr:nth-child(${row})` } },
];
/** A step on the profile of the row-th player in the directory, after what is done first there. */
const onProfile = (text: string, target: WalkTarget, then: WalkAction[] = [], row = 1): WalkStep => ({
  text, route: "players.players",
  before: [{ click: { panel: "Directory", css: `tbody tr:nth-child(${row})` } }, ...then],
  target,
});
const PROFILE_ACTIONS = 'button[aria-label="Actions"]';
/** Opening a staff member's page from Staff activity: the second listed, someone besides you. */
const OPEN_STAFF: WalkAction[] = [{ click: { panel: "The team", css: "button.player-link", nth: 1 } }];

/** An Analytics tab: open it, pick the time it covers, then what the walkthrough is about. */
const analytics = (tab: string, label: string, steps: [string, WalkTarget, string[]?, WalkAction[]?][]): WalkStep[] => [
  { text: "Open Analytics.", route: `analytics.${tab}`, target: { nav: "analytics" } },
  { text: `Open the ${label} tab.`, route: `analytics.${tab}`, target: { tab: label } },
  { text: "Pick the time it covers: the last week, month, year, or dates of your own.", route: `analytics.${tab}`, target: { css: "main .seg" } },
  {
    text: "Custom… asks for the first and the last day. Apply shows them.", route: `analytics.${tab}`,
    before: [{ click: { button: "Custom…" } }], target: { css: '.seg[aria-label="Time window"] + .control-row' },
  },
  ...steps.map(([text, target, fields, before]): WalkStep => ({ text, route: `analytics.${tab}`, target, ...(fields ? { fields } : {}), ...(before ? { before } : {}) })),
];

/** Save at a panel's head, with Discard beside it once something has changed. */
const saveOrDiscard = (route: string, panel: string, extra?: Partial<WalkStep>): WalkStep => ({
  text: "Press Save. Discard, beside it once something has changed, puts back what was last saved.", route, target: { panel, css: ".panel-actions" }, ...extra,
});
/** The saved-setups bar above a feature's settings (components/PresetBar). */
const savedSetups = (route: string, inPanel?: string): WalkStep => ({
  text: "Saved setups: name this whole setup and press Save current setup. Pick one to Apply it here, or Delete it.", route,
  target: { ...(inPanel ? { panel: inPanel } : {}), css: '[role="group"][aria-label="Saved setups"]' },
});

/** Where a kind of action is listed afterwards — a tab of Moderation, read with the staff trail. */
const listedUnder = (tab: string, route: string, text: string): WalkStep => ({
  text, route, target: { tab }, optional: true,
});

export const WALKTHROUGHS: Walkthrough[] = [
  // ---------------------------------------------------------------------- getting around ----
  {
    id: "getting-around",
    title: "Find your way around",
    blurb: "The menu, Search, the server picker and your account.",
    keywords: ["navigate", "menu", "find", "server picker", "account", "sign out"],
    caps: [],
    group: "Getting around",
    steps: [
      {
        text: "The menu lists every screen you can open. It follows your permissions, so it shows only what you can use.", route: "dashboard", target: { css: ".sidebar .nav" },
        phone: { text: "☰ opens the menu: every screen you can open. It follows your permissions, so it shows only what you can use.", target: { css: ".topbar .burger" } },
      },
      { text: "A screen with several parts lists them under its name in the menu once it is open.", route: "help.start", target: { css: ".sidebar .nav-subnav" } },
      {
        text: "« folds the menu down to its icons, for more room. » opens it again.", route: "dashboard", target: { css: ".sidebar .collapse-btn" },
        phone: { text: "On a phone, the quick bar keeps the screens you use most one tap away, and More opens the whole menu.", target: { css: ".quick-bar" } },
      },
      {
        text: "Search finds any screen, player or setting. Click it, or press Ctrl K.", route: "dashboard", target: { css: ".sidebar .cmdk-trigger" },
        phone: { text: "Search finds any screen, player or setting. Tap it.", target: { css: ".topbar .cmdk-trigger" } },
      },
      {
        text: "Type what you are after: a screen, a player by name or id, a server, or a walkthrough.", route: "dashboard",
        before: OPEN_SEARCH, target: { dialog: true, css: ".cmdk-input" }, phone: { before: OPEN_SEARCH_PHONE },
      },
      {
        text: "Press a result to go there, or pick it with ↑ and ↓ and press Enter. Before you type, it lists what you opened lately.", route: "dashboard",
        before: [...OPEN_SEARCH, { fill: { dialog: true, css: ".cmdk-input" }, value: "map" }], target: { dialog: true, css: ".cmdk-item" },
        phone: { before: [...OPEN_SEARCH_PHONE, { fill: { dialog: true, css: ".cmdk-input" }, value: "map" }] },
      },
      {
        text: "Back and forward step through the screens you have opened.", route: "dashboard", target: { css: ".sidebar .trail-nav" },
        phone: { target: { css: ".topbar .trail-nav" } },
      },
      {
        text: "Most screens show one server at a time. Pick which one here.", route: "dashboard", target: { css: ".sidebar .server-switcher" }, caps: ["server.view"],
        phone: { text: "Most screens show one server at a time. Tap its name to pick another.", target: { css: ".topbar .server-badge" } },
      },
      {
        text: "Your name opens your Settings, and signing out.", route: "dashboard", target: { css: ".sidebar-footer" },
        phone: { text: "Your initial opens your Settings, and signing out.", target: { css: ".topbar-account" } },
      },
      {
        text: "In its menu, Theme switches between your device's, light and dark at once.", route: "dashboard",
        before: OPEN_ACCOUNT, target: { css: ".settings-pop .sm-seg" }, phone: { before: OPEN_ACCOUNT_PHONE },
      },
      {
        text: "Appearance and API tokens open your Settings, Edit layout arranges the menu, and Log out signs you out.", route: "dashboard",
        before: OPEN_ACCOUNT, target: { css: ".settings-pop .sm-item" }, phone: { before: OPEN_ACCOUNT_PHONE },
      },
      {
        text: "Edit layout lists the menu's parts: tick those to show, and ↑ and ↓ put them in order.", route: "dashboard",
        before: [...OPEN_ACCOUNT, { click: { button: "▦ Edit layout" } }], target: { css: ".layout-item input" },
        phone: { before: [...OPEN_ACCOUNT_PHONE, { click: { button: "▦ Edit layout" } }] },
      },
      {
        text: "Save for me keeps it for you alone. Save as team default makes it where colleagues start.", route: "dashboard",
        before: [...OPEN_ACCOUNT, { click: { button: "▦ Edit layout" } }], target: { css: ".card:has(.layout-item) > .actions" },
        phone: { before: [...OPEN_ACCOUNT_PHONE, { click: { button: "▦ Edit layout" } }] },
      },
      { text: "Help, under Start here, keeps every walkthrough made for you.", route: "help.start", target: { tab: "Start here" } },
    ],
  },
  {
    id: "use-help",
    title: "Find help in the panel",
    blurb: "Walkthroughs, every screen, the words a message fills in, and what each update changed.",
    keywords: ["help", "guide", "manual", "tutorial", "how to", "documentation"],
    caps: [],
    group: "Getting around",
    steps: [
      { text: "Open Help.", route: "help.start", target: { nav: "help" } },
      { text: "Start here has a walkthrough for each thing you can do. Search them by saying what you want to do.", route: "help.start", target: { panel: "Start here", css: "input.search-input" } },
      {
        text: "Copy link, in a walkthrough, copies a link that opens it, to send to someone.", route: "help.start",
        before: [{ click: { panel: "Start here", button: "Find your way around" } }], target: { dialog: true, button: "🔗 Copy link" },
      },
      { text: "Back and Next, or the arrow keys, step through it. Done, on the last step, closes it.", route: "help.start", before: OPEN_WALK, target: { dialog: true, button: "Back" } },
      { text: "The dots under the picture go straight to any step.", route: "help.start", before: OPEN_WALK, target: { dialog: true, css: '[role="group"][aria-label="Steps"]' } },
      {
        text: "Show me on my screen plays it on the panel itself: each screen opens with its control ringed.", route: "help.start",
        before: OPEN_WALK, target: { dialog: true, button: "Show me on my screen" },
      },
      {
        text: "A note beside the ring says what to do. Back and Next move between steps, and ✕ ends it.", route: "help.start",
        before: [...OPEN_WALK, { click: { dialog: true, button: "Show me on my screen" } }], target: { css: ".spot-note" },
      },
      {
        text: "After an update, What's new opens once with what changed. Show me goes to where a change is.", route: "dashboard", stage: "whats-new",
        target: { dialog: true, button: "Show me" },
      },
      { text: "Got it closes it. Help keeps every update's notes, under What's new.", route: "dashboard", stage: "whats-new", target: { dialog: true, button: "Got it" } },
      {
        text: "Given more to do, you are shown the walkthroughs it opened, once. Press one to play it.", route: "dashboard", stage: "new-walkthroughs",
        target: { dialog: true, css: ".walk-card" },
      },
      { text: "Got it closes the list. Each is kept in Help, under Start here, with the rest.", route: "dashboard", stage: "new-walkthroughs", target: { dialog: true, button: "Got it" } },
      {
        text: "When the panel cannot reach its own server, it says so. Try again asks once more, and you stay signed in.", route: "dashboard", stage: "unreachable",
        target: { css: ".auth-card .actions" },
      },
      { text: "All pages lists every screen you can open, and what each one is for.", route: "help.pages", target: { tab: "All pages" } },
      { text: "Placeholders lists the words a message fills in for you, such as a player's name.", route: "help.placeholders", target: { tab: "Placeholders" } },
      { text: "What's new keeps what each update changed, newest first.", route: "help.whatsnew", target: { tab: "What's new" } },
    ],
  },
  {
    id: "use-screens",
    title: "Use a screen's panels and lists",
    blurb: "Fold panels away, read what they do, sort lists, save them as files and read charts.",
    keywords: ["panel", "fold", "collapse", "explanation", "sort", "download", "file", "chart", "key", "filter"],
    caps: [],
    group: "Getting around",
    steps: [
      OPEN_SETTINGS,
      { text: "Each part of a screen is a panel. Press its title to fold it away, and again to open it.", route: "settings", target: { panel: "Appearance", css: ".panel-toggle" } },
      { text: "Explanation opens more about what something does.", route: "settings", target: { panel: "Workspace", css: "summary" } },
      { text: "Arrange panels, at the foot of a screen, moves its panels and sets their widths, for you alone.", route: "settings", target: { button: "⧉ Arrange panels" } },
      {
        text: "There, ◀ and ▶ move a panel, or drag it by ⠿. ◉ hides it, and ◯ shows it again.", route: "settings",
        before: [{ click: { button: "⧉ Arrange panels" } }], target: { css: ".panel-move-btn" },
      },
      {
        text: "Its widths set how much of the row a panel takes: all of it, or part, beside others.", route: "settings",
        before: [{ click: { button: "⧉ Arrange panels" } }], target: { css: ".panel-widths" },
      },
      {
        text: "Done keeps it. Reset puts the screen back, and Save as team default makes it where colleagues start.", route: "settings",
        before: [{ click: { button: "⧉ Arrange panels" } }], target: { css: ".panel-toolbar" },
      },
      { text: "In a list, press a column's name to sort by it, and a player's name to open their profile.", route: "players.players", target: { panel: "Directory", css: "thead th" }, caps: ["server.view"] },
      {
        text: "Download saves a list as a file, as it stands: its search, filters and order.", route: "history.logs", target: { panel: "Game log", button: "Download" }, caps: ["server.view"],
        fields: ["Format", "Time range"],
      },
      { text: "Under a chart, press a key to show or hide it. All shows everything again.", route: "analytics.server", target: { panel: "Daily trend", button: "All" }, caps: ["analytics.server"] },
      {
        text: "When a search or a filter leaves a list empty, Clear filters shows all of it again.", route: "help.start",
        before: [{ fill: { panel: "Start here", css: "input.search-input" }, value: "zzzz" }], target: { panel: "Start here", button: "Clear filters" },
      },
      { text: "Refresh, or ↻, reads a list again, for what has changed since it opened.", route: "history.logs", target: { panel: "Game log", button: "Refresh" }, caps: ["server.view"] },
      {
        text: "When something cannot be read, the screen says so and why. Try again reads it once more.", route: "live", stage: "servers-unread",
        target: { button: "Try again" }, caps: ["server.view"],
      },
      {
        text: "A long list comes in pages: ‹ and › step through them, « and » go to the first and last.", route: "history.logs",
        target: { panel: "Game log", css: ".pager" }, caps: ["server.view"],
      },
      {
        ...inDialog("💬 Send message", "Under a box for a message or a reason, a saved preset fills it in with a press. + Save as preset keeps what you typed.", { css: ".preset-picker" }),
        caps: ["server.view"],
      },
      {
        text: "A player's id, marked ⧉, copies itself when pressed: the whole id, even where it is cut short.", route: "players.players",
        before: [{ click: { panel: "Directory", css: "tbody tr:nth-child(1)" } }], target: { css: "button.game-id" }, caps: ["server.view"],
      },
      {
        text: "In a dialog, Cancel or Close leaves without changing anything. So do Escape and a click beside it.", route: "help.start",
        before: [{ click: { panel: "Start here", button: "Find your way around" } }], target: { dialog: true },
      },
    ],
  },
  {
    id: "your-settings",
    title: "Change your settings",
    blurb: "How the panel looks and opens for you, and what reaches your phone.",
    keywords: ["settings", "preferences", "theme", "dark mode", "light mode", "colour", "color", "text size", "notifications", "what's new", "updates"],
    caps: [],
    group: "Getting around",
    steps: [
      OPEN_SETTINGS,
      {
        text: "Appearance: light or dark, and the colour the panel is drawn in.", route: "settings", target: { panel: "Appearance" },
        fields: ["Theme", "Accent"],
      },
      {
        text: "Workspace: where the panel opens, how tight it packs, how big its words are, and the quick bar on phones.", route: "settings", target: { panel: "Workspace" },
        fields: ["Open the panel on", "Density", "Screen size", "Text size", "Schedule times on your clock"],
      },
      {
        text: "Quick bar on phones puts the screens you use most one tap away, along the bottom or the top, or nowhere.", route: "settings", target: { panel: "Workspace", setting: "Quick bar on phones" },
        fields: ["Quick bar on phones", "Quick bar buttons"],
      },
      { text: "Switch What's new after an update off, and it no longer opens after each update. Help keeps every update's notes.", route: "settings", target: { setting: "What's new after an update" } },
      {
        text: "Phone notifications: what reaches your phone, and on which devices.", route: "settings", target: { panel: "Phone notifications" },
        fields: ["Notifications on this device"],
      },
      { text: "Personal setup, under Your setup in Help's Start here, goes through these again a page at a time.", route: "help.start", target: { panel: "Start here", button: "Personal setup" } },
      { text: "Let's start begins it. Skip setup, on every page, closes it and keeps what you chose so far.", route: "help.start", before: setupPage(1), target: { dialog: true, css: ".setup-actions" } },
      { text: "How it looks: light, dark or your device's, and the colour the panel is drawn in. Each applies at once.", route: "help.start", before: setupPage(2), target: { dialog: true, css: ".setup-step" } },
      { text: "Reading: how big the words are, and how close together the rows sit.", route: "help.start", before: setupPage(3), target: { dialog: true, css: ".setup-step" } },
      { text: "Your clock: the time zone dates show in, and each schedule on your own clock too.", route: "help.start", before: setupPage(4), target: { dialog: true, css: ".setup-step" } },
      { text: "Where it opens: the screen you land on, What's new after each update, and on a computer the screen size.", route: "help.start", before: setupPage(5), target: { dialog: true, css: ".setup-step" } },
      { text: "Notifications on this device, and where a phone's quick bar sits, or none.", route: "help.start", before: setupPage(6), target: { dialog: true, css: ".setup-step" } },
      { text: "What you can do: a walkthrough for each thing your permissions allow. Press one to play it.", route: "help.start", before: setupPage(7), target: { dialog: true, css: ".walk-card" } },
      { text: "Last, Show me around points out the menu, Search and your account. Finish closes it.", route: "help.start", before: setupPage(8), target: { dialog: true, css: ".setup-actions" } },
    ],
  },
  {
    id: "change-password",
    title: "Change your password",
    blurb: "A new password, which signs you out on every other device.",
    keywords: ["password", "sign in", "login", "security"],
    caps: [],
    group: "Getting around",
    steps: [
      OPEN_SETTINGS,
      { text: "Open Password, at the foot of Settings.", route: "settings", target: { panel: "Password", css: ".panel-toggle" } },
      {
        text: "Type your current password, then the new one twice.", route: "settings", fields: ["New password"],
        before: [{ click: { panel: "Password", css: ".panel-toggle" } }], target: { panel: "Password", field: "Current password" },
      },
      {
        text: "Press Change password. Every other device is signed out; this one stays signed in.", route: "settings",
        before: [{ click: { panel: "Password", css: ".panel-toggle" } }], target: { panel: "Password", button: "Change password" },
      },
    ],
  },
  {
    id: "read-notices",
    title: "Read the staff notices",
    blurb: "What the team has posted for everyone, and saying you have read it.",
    keywords: ["announcements", "notices", "news", "board", "acknowledge"],
    caps: [],
    group: "Getting around",
    steps: [
      { text: "Open Announcements. A number beside it says how many notices are new to you.", route: "community", target: { nav: "community" } },
      { text: "Notices lists what the team has posted, newest first. Ones you have not seen are marked NEW.", route: "community", target: { panel: "Notices" } },
      { text: "Press Acknowledge on a notice to tell the team you have read it.", route: "community", target: { panel: "Notices", button: "✓ Acknowledge" } },
    ],
  },
  {
    id: "arrange-dashboard",
    title: "Make the dashboard yours",
    blurb: "The tiles your dashboard shows, and the order they are in.",
    keywords: ["dashboard", "home", "tiles", "widgets", "layout"],
    caps: [],
    group: "Getting around",
    steps: [
      { text: "Open the Dashboard.", route: "dashboard", target: { nav: "dashboard" } },
      {
        text: "Along its top, what needs you: a watched player in game, a notice unread, a server only watched. Each has its button.", route: "dashboard",
        stage: "attention", target: { css: ".attention-list" },
      },
      { text: "Press Widgets.", route: "dashboard", target: { button: "Widgets" } },
      {
        text: "Turn on each tile you want to see. Your choice is saved to your account.", route: "dashboard",
        before: [{ click: { button: "Widgets" } }], target: { css: ".widget-picker" },
      },
      {
        text: "With every tile off, the dashboard is empty, and Choose widgets opens the list again.", route: "dashboard",
        before: [{ click: { button: "Widgets" } }, { click: { css: ".widget-picker label.toggle" } }], target: { button: "Choose widgets" },
      },
      { text: "Press Edit layout to drag the tiles into the order you like, then press Save.", route: "dashboard", target: { button: "Edit layout" } },
      {
        text: "There, ◀ and ▶ move a tile, its size button resizes it, and ◉ hides it.", route: "dashboard",
        before: [{ click: { button: "Edit layout" } }], target: { css: ".tile-controls" },
      },
      {
        text: "Save keeps the layout for you. Save as team default makes it where colleagues start, if they have not arranged their own.", route: "dashboard",
        before: [{ click: { button: "Edit layout" } }], target: { css: ".dash-head .actions" },
      },
    ],
  },
  {
    id: "discord-staff",
    title: "Do staff work from Discord",
    blurb: "The staff command in Discord, and whose permissions it follows.",
    keywords: ["discord", "slash command", "staff command", "bot", "link discord"],
    caps: [],
    group: "Getting around",
    steps: [
      {
        text: "Link Discord, in the menu under your name, ties your Discord to this panel account.", route: "dashboard", target: { css: ".sidebar-footer" },
        phone: { text: "Link Discord, in the menu under your initial at the top right, ties your Discord to this account.", target: { css: ".topbar-account" } },
      },
      // The panel the command opens lives in Discord, so each of these steps draws it, as it is for
      // the person following it. Its parts follow in the order it lists them, each for whoever it
      // opens to (the API's discord-*.ts modules, which the unit test reads), each rung there.
      { text: "The staff command opens this panel in Discord. It lists the parts your permissions give you.", ...inDiscord(), target: DRAWN },
      {
        text: "Servers lists each server you can see with its mode and game, and whether the panel is reading them.",
        ...inDiscord("servers"), target: DRAWN, caps: ["server.view"],
      },
      {
        text: "Economy opens a member's card, picked by name or by Discord id: their balance, their VIP and its history.",
        ...inDiscord("economy"), target: DRAWN, caps: ["economy.balances"],
      },
      {
        text: "Register / link accounts, in Economy, links a member's Discord to their game account by hand.",
        ...inDiscord("economy"), target: { panel: DISCORD_PANEL, button: "Register / link accounts" }, caps: ["player.links"], capLevel: "write", needs: ["economy.balances"],
      },
      {
        text: "Post the public VIP panel, in Economy, posts the button that opens each member's own VIP panel into the channel you are in.",
        ...inDiscord("economy"), target: { panel: DISCORD_PANEL, button: "Post the public VIP panel" }, caps: ["economy.config"], capLevel: "write", needs: ["economy.balances"],
      },
      {
        text: "Moderation fills a cart: add players from the roster or by id, turn on the actions for them all, then press Review & send.",
        ...inDiscord("moderation", true), target: DRAWN, caps: ["server.view"],
      },
      {
        text: "Maps & vote picks a server and shows its round: the map, what plays next and what the map vote is doing.",
        ...inDiscord("maps", true), target: DRAWN, caps: ["server.view"],
      },
      {
        text: "Change map now… or Set next map… picks a map, rotation first, and asks before doing it. Objectives… sets each sector's point.",
        ...inDiscord("maps", true), target: { panel: DISCORD_PANEL, button: "Change map now…" }, caps: ["maps.next"],
      },
      {
        text: "Where the map vote is on, its buttons pause or resume it, skip the one running, offer new maps or start a vote now.",
        ...inDiscord("maps", true), target: { panel: DISCORD_PANEL, button: "⏸ Pause vote" }, caps: ["mapvote.control"],
      },
      { text: "Slash command, on Discord's Setup & status tab, renames the staff command or switches it off.", route: "discord.setup", target: { panel: "Slash command", css: "label.toggle" }, caps: ["discord.setup"], fields: ["name", "description"] },
      { text: "Press Save name after a change.", route: "discord.setup", target: { panel: "Slash command", button: "Save name" }, caps: ["discord.setup"] },
      { text: "Then press Register command, to put the change into Discord.", route: "discord.setup", target: { panel: "Slash command", button: "Register command" }, caps: ["discord.setup"] },
    ],
  },
  {
    id: "ask-approval",
    title: "Ask for what you cannot do yourself",
    blurb: "Actions you lack the permission for go for approval. The answers are kept here.",
    keywords: ["request", "approval", "approve", "permission", "ask", "pending"],
    caps: [],
    group: "Getting around",
    steps: [
      { text: "Where you lack the permission for an action, such as a ban, its button reads Send for approval. Open Moderation to follow what you sent.", route: "moderation.requests", target: { nav: "moderation" } },
      { text: "Open the Requests tab.", route: "moderation.requests", target: { tab: "Requests" } },
      { text: "Your requests lists what you asked for, and each answer. A refusal always says why.", route: "moderation.requests", target: { panel: "Your requests" } },
      { text: "Withdraw takes back a request of yours that nobody has answered yet.", route: "moderation.requests", target: { panel: "Your requests", button: "Withdraw" } },
      { text: "Press Build a request to ask for several things at once. What you confirm is collected, not done, until you send it.", route: "moderation.requests", target: { button: "Build a request" } },
      { text: "Waiting on you lists what others asked for that your permissions let you approve or deny.", route: "moderation.requests", target: { panel: "Waiting on you" } },
      { text: "Approve does that line now, under your name.", route: "moderation.requests", target: { panel: "Waiting on you", css: ".req-line-acts > button:first-of-type" } },
      {
        text: "On a temporary ban, fewer hours in the box beside Approve approves less than was asked. Never more.", route: "moderation.requests",
        target: { panel: "Waiting on you", css: "input.req-line-hours" }, caps: ["action.tempban"],
      },
      { text: "Deny asks why first, and whoever asked reads your reason.", route: "moderation.requests", target: { panel: "Waiting on you", button: "Deny" }, fields: ["Why"] },
      { text: "Approve all approves every line of a request that is yours to answer, after asking.", route: "moderation.requests", target: { panel: "Waiting on you", button: "Approve all" } },
      {
        text: "While you build one, a bar at the top counts what is collected. Save draft keeps it; Exit drops it, after asking.", route: "moderation.requests",
        before: BUILD_REQUEST, target: { css: ".request-bar" },
      },
      {
        text: "Review & submit lists each line: done at once, or sent for approval. Remove takes one out.", route: "moderation.requests",
        before: [...BUILD_REQUEST, { click: { css: ".request-bar button" } }], target: { dialog: true, button: "Remove" },
      },
      {
        text: "Submit sends it all, and Keep building goes back to adding more.", route: "moderation.requests",
        before: [...BUILD_REQUEST, { click: { css: ".request-bar button" } }], target: { dialog: true, css: ".pa-actions" },
      },
      { text: "Completed, under your requests, opens those that are finished, each with its answer.", route: "moderation.requests", target: { panel: "Your requests", css: ".req-done > button" } },
    ],
  },

  // ---------------------------------------------------------------------- player actions ----
  {
    id: "message-player",
    title: "Send a player a message",
    blurb: "A message on one player's screen that stays until they close it.",
    keywords: ["dm", "pm", "whisper", "warn", "warning", "tell"],
    caps: ["action.message"],
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("💬 Send message", "Choose Send message."),
      { ...inDialog("💬 Send message", "Type the message. It stays on their screen until they close it.", { field: "Message" }) },
      inDialog("💬 Send message", "Press Send message.", { button: "Send message" }, ["Message", "Please stay with your squad."]),
      listedUnder("Warnings", "moderation.warnings", "Messages to one player are listed under Moderation, in Warnings."),
    ],
  },
  {
    id: "message-everyone",
    title: "Message everyone on a server",
    blurb: "One message to every player on the server at once.",
    keywords: ["all players", "everybody", "broadcast", "announce"],
    caps: ["action.message"],
    group: "Player actions",
    steps: [
      { text: "Open Moderation.", route: "moderation.messages", target: { nav: "moderation" } },
      { text: "Open the Messages tab.", route: "moderation.messages", target: { tab: "Messages" } },
      { text: "Type the message, or pick a saved one below it.", route: "moderation.messages", target: { panel: "Message everyone", field: "Message" } },
      {
        text: "Press Send to everyone. It shows on every player's screen until they close it.",
        route: "moderation.messages",
        before: [{ fill: { panel: "Message everyone", field: "Message" }, value: "Server restart in 10 minutes." }],
        target: { panel: "Message everyone", button: "Send to everyone" },
      },
    ],
  },
  {
    id: "punish-player",
    title: "Punish a player",
    blurb: "Kill a player where they stand, leaving them on the server.",
    keywords: ["kill", "slay", "punishment"],
    caps: ["action.punish"],
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("⚠️ Punish", "Choose Punish."),
      { ...inDialog("⚠️ Punish", "Write the reason. The player sees it, so write it for them.", { field: "Reason" }) },
      inDialog("⚠️ Punish", "Press Punish player. They die where they stand and stay on the server.", { button: "Punish player" }, ["Reason", "Teamkilling at spawn"]),
      listedUnder("Punishments", "moderation.punishments", "Every punish is listed under Moderation, in Punishments."),
    ],
  },
  {
    id: "kick-player",
    title: "Kick a player",
    blurb: "Remove a player from the server. They can join again.",
    keywords: ["boot", "remove", "throw out"],
    caps: ["action.kick"],
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("🥾 Kick", "Choose Kick."),
      inDialog("🥾 Kick", "Write the reason. The player sees it, so write it for them.", { field: "Reason" }),
      inDialog("🥾 Kick", "Press Kick player. They are removed from the server, and can join again.", { button: "Kick player" }, ["Reason", "Teamkilling at spawn"]),
      { ...listedUnder("Kicks", "moderation.kicks", "Every kick is listed under Moderation, in Kicks, with who did it and why.") },
    ],
  },
  {
    id: "temp-ban",
    title: "Ban a player for a while",
    blurb: "Keep a player off the server for a number of hours.",
    keywords: ["temporary", "suspend", "hours"],
    caps: ["action.tempban"],
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("⏱ Temp ban", "Choose Temp ban."),
      { ...inDialog("⏱ Temp ban", "Set how many hours it lasts, or pick the day it ends just below.", { field: "Hours" }), fields: ["…or until a date"] },
      { ...inDialog("⏱ Temp ban", "Write the reason. The player is shown it.", { field: "Reason" }) },
      inDialog("⏱ Temp ban", "With more than one server, Which servers sets where it holds: everywhere, all but those ticked, or only those ticked.", { css: ".scope-pick" }),
      inDialog("⏱ Temp ban", "Press Temp ban. They cannot join again until it ends.", { button: "Temp ban" }, ["Reason", "Teamkilling at spawn"]),
      { ...listedUnder("Bans", "moderation.bans", "Bans are listed under Moderation, in Bans, where they can be lifted early.") },
    ],
  },
  {
    id: "perma-ban",
    title: "Ban a player for good",
    blurb: "Keep a player off the server until someone lifts the ban.",
    keywords: ["permanent", "forever", "permaban"],
    caps: ["action.permaban"],
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("⛔ Perma ban", "Choose Perma ban."),
      inDialog("⛔ Perma ban", "Write the reason. The player is shown it.", { field: "Reason" }),
      inDialog("⛔ Perma ban", "Add a category if you like, such as cheating, so bans can be searched by it.", { field: "Category" }),
      inDialog("⛔ Perma ban", "With more than one server, Which servers sets where it holds: everywhere, all but those ticked, or only those ticked.", { css: ".scope-pick" }),
      inDialog("⛔ Perma ban", "Press Perma ban. They cannot join again until someone lifts it.", { button: "Perma ban" }, ["Reason", "Cheating"]),
      { ...listedUnder("Bans", "moderation.bans", "Bans are listed under Moderation, in Bans.") },
      { text: "Upload bans many players at once from a file. Players already banned, and lifted bans, are left alone.", route: "moderation.bans", target: { panel: "Bans", button: "Upload" }, caps: ["moderation.bans"], fields: ["A list downloaded from this page"] },
    ],
  },
  {
    id: "ban-by-id",
    title: "Ban a player who is not online",
    blurb: "A ban for someone who is not on the server now, found by name or id.",
    keywords: ["ban offline", "ban by id", "player id", "ban someone"],
    caps: ["action.tempban", "action.permaban"],
    needs: ["moderation.bans"],
    group: "Player actions",
    steps: [
      OPEN_MODERATION,
      OPEN_BANS,
      { text: "Press Ban a player… to ban someone who is not on the server now.", route: "moderation.bans", target: { panel: "Bans", button: "Ban a player…" } },
      {
        text: "Find the player by name or id, then choose a ban for some hours, until a date, or for good.", route: "moderation.bans",
        before: [{ click: { panel: "Bans", button: "Ban a player…" } }], target: { dialog: true, field: "Ban" },
        fields: ["Search a player", "Hours", "…or until a date"],
      },
      { text: "With more than one server, Which servers sets where it holds: everywhere, all but those ticked, or only those ticked.", route: "moderation.bans", before: [{ click: { panel: "Bans", button: "Ban a player…" } }], target: { dialog: true, css: ".scope-pick" } },
      {
        text: "Write the reason. The player is shown it, and it goes on the record.", route: "moderation.bans",
        before: [{ click: { panel: "Bans", button: "Ban a player…" } }], target: { dialog: true, field: "Reason" },
        fields: ["Category"],
      },
      {
        text: "Press Ban player.", route: "moderation.bans",
        before: [{ click: { panel: "Bans", button: "Ban a player…" } }], target: { dialog: true, button: "Ban player" },
      },
    ],
  },
  {
    id: "lift-ban",
    title: "Lift a ban",
    blurb: "Let a banned player join again.",
    keywords: ["unban", "remove ban", "pardon"],
    caps: ["action.unban"],
    group: "Player actions",
    steps: [
      OPEN_MODERATION,
      OPEN_BANS,
      { text: "Find the ban and press Unban. The player can join again straight away.", route: "moderation.bans", target: { panel: "Bans", button: "Unban" } },
      {
        text: "To lift every ban on one server, pick it in Server, then press Lift all on this server.", route: "moderation.bans",
        before: [{ fill: { panel: "Bans", field: "Server" }, value: "Server #1" }], target: { panel: "Bans", button: "Lift all on this server" },
      },
    ],
  },
  {
    id: "switch-team",
    title: "Move a player to the other team",
    blurb: "Switch a player's team straight away, mid-match.",
    keywords: ["swap", "change team", "move"],
    caps: ["action.switch"],
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("🔄 Switch team", "Choose Switch team."),
      inDialog("🔄 Switch team", "Press Switch team now. They move to the other team straight away.", { button: "Switch team now" }),
      listedUnder("Switches", "moderation.switches", "Team moves are listed under Moderation, in Switches."),
    ],
  },
  {
    id: "switch-on-death",
    title: "Move a player when they next die",
    blurb: "Switch a player's team at their next death, not mid-fight.",
    keywords: ["swap", "change team", "death"],
    caps: ["action.switch_death"],
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("🔄 Switch on death", "Choose Switch on death."),
      inDialog("🔄 Switch on death", "Press Switch team on death. They stay put until they next die, then move.", { button: "Switch team on death" }),
      listedUnder("Switches", "moderation.switches", "Team moves are listed under Moderation, in Switches."),
    ],
  },

  {
    id: "act-on-several",
    title: "Act on several players at once",
    blurb: "Tick players on Live, then do the same to all of them at once.",
    keywords: ["bulk", "many players", "selected", "tick", "select", "mass", "together"],
    caps: ["action.message", "action.punish", "action.kick", "action.tempban", "action.permaban", "action.switch", "action.switch_death"],
    capLevel: "write",
    group: "Player actions",
    steps: [
      OPEN_LIVE,
      {
        text: "Tick the box beside each player, or the box at the top for everyone shown.", route: "live",
        target: { panel: "Roster", css: "table input[type=checkbox]" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }],
      },
      {
        text: "Shown by squad, select beside a squad's name ticks all of it.", route: "live",
        target: { panel: "Roster", css: "tr.squad-head button" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Teams" }],
        before: [{ click: { panel: "Roster", button: "Teams" } }, { click: { panel: "Roster", css: ".team-side-head" } }],
      },
      {
        text: "Clear unticks everyone. Clear filters, beside a filtered roster, shows all of it again.", route: "live",
        target: { panel: "Roster", button: "Clear" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }, { click: { panel: "Roster", css: "tbody input[type=checkbox]" } }],
      },
      { text: "⋯ above the ticks lists what can be done to all of them.", route: "live", target: { panel: "Roster", button: "Bulk actions" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }, { click: { panel: "Roster", css: "tbody input[type=checkbox]" } }] },
      {
        text: "Choose what to do. Each asks what it needs, such as a reason, and is done to every player ticked.", route: "live",
        target: { css: ".pa-dropdown" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }, { click: { panel: "Roster", css: "tbody input[type=checkbox]" } }, { click: { panel: "Roster", button: "Bulk actions" } }],
      },
    ],
  },

  // --------------------------------------------------------------------------- bans & vip ----
  {
    id: "find-a-ban",
    title: "Look up a ban",
    blurb: "Who is banned, since when, where, why and by whom.",
    keywords: ["banned", "ban list", "search bans"],
    caps: ["moderation.bans"],
    group: "Bans & VIP",
    steps: [
      OPEN_MODERATION,
      OPEN_BANS,
      { text: "Platform is the community's ban record. Live is the game server's own list, as it stands now.", route: "moderation.bans", target: { panel: "Bans", css: ".seg" } },
      { text: "Search by name, id, reason or who banned them. Server shows only the bans covering one server.", route: "moderation.bans", target: { panel: "Bans", css: "input.search-input" }, fields: ["Server"] },
      { text: "Turn on Show lifted & expired to see bans that have ended too.", route: "moderation.bans", target: { panel: "Bans", field: "Show lifted" } },
    ],
  },
  {
    id: "adopt-game-bans",
    title: "Bring in the game's own bans",
    blurb: "Add bans placed in the game itself to the list, to search and lift here.",
    keywords: ["import", "game bans"],
    caps: ["moderation.bans.sync"],
    group: "Bans & VIP",
    steps: [
      OPEN_MODERATION,
      OPEN_BANS,
      { text: "Press Sync from servers. Bans placed in the game itself join the list.", route: "moderation.bans", target: { panel: "Bans", button: "Sync from servers" } },
      { text: "Sync with game works the other way: it puts the record's bans on this server where missing, and lifts what was lifted.", route: "moderation.bans", target: { panel: "Bans", button: "Sync with game" } },
    ],
  },
  {
    id: "see-vips",
    title: "See who has VIP",
    blurb: "Everyone with VIP on a server, and when it ends.",
    keywords: ["vip list", "reserved slot"],
    caps: ["vip.grant", "vip.revoke"],
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.vips"),
      { text: "Open the VIPs tab.", route: "players.vips", target: { tab: "VIPs" } },
      { text: "Current VIPs lists everyone with VIP on this server, and when it ends.", route: "players.vips", target: { panel: "Current VIPs", css: "table" } },
      { text: "Search by a player's name or ID. The count beside Current VIPs says how many match.", route: "players.vips", target: { panel: "Current VIPs", css: "input.search-input" } },
    ],
  },
  {
    id: "give-vip",
    title: "Give a player VIP",
    blurb: "VIP for good, until a date, or for some days.",
    keywords: ["add vip", "grant", "extend", "reserved slot"],
    caps: ["vip.grant"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.vips"),
      { text: "Open the VIPs tab.", route: "players.vips", target: { tab: "VIPs" } },
      {
        text: "Find the player by name, or paste their id.", route: "players.vips", target: { panel: "Grant / extend VIP", css: ".field" },
        fields: ["Player name", "Apply to all servers"],
      },
      { text: "Say who paid or what it is for. It stays with the grant, and is not sent to the game.", route: "players.vips", target: { panel: "Grant / extend VIP", field: "Comment" } },
      { text: "Choose for good, until a date, or a number of days and hours.", route: "players.vips", target: { panel: "Grant / extend VIP", css: ".seg" }, fields: ["Expires at", "Days", "Hours", "Stack onto existing time"] },
      { text: "Press Grant VIP.", route: "players.vips", target: { panel: "Grant / extend VIP", button: "Grant VIP" } },
      { text: "Upload gives VIP to many players from a file. VIP is only ever added or made longer, never shortened or taken away.", route: "players.vips", target: { panel: "Current VIPs", button: "Upload" }, fields: ["A list downloaded from this page"] },
      { text: "Sync with game makes the game's VIP list match the panel's, and says what it will change first. VIP added outside the panel is left alone.", route: "players.vips", target: { panel: "Current VIPs", button: "Sync with game" } },
    ],
  },
  {
    id: "check-vip",
    title: "Check that no VIP was lost",
    blurb: "Find VIP that automation dated, removed or shortened, and put it back.",
    keywords: ["integrity", "lost vip", "missing vip", "restore", "audit"],
    caps: ["vip.grant", "vip.revoke"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.vips"),
      { text: "Open the VIPs tab.", route: "players.vips", target: { tab: "VIPs" } },
      {
        text: "Open VIP integrity, and press Scan all servers. It reads the whole VIP history.", route: "players.vips",
        before: [{ click: { panel: "VIP integrity", css: ".panel-toggle" } }], target: { panel: "VIP integrity", button: "Scan all servers" },
      },
      {
        text: "Each finding says what was lost and what did it. Add the time back, or Restore permanent, puts it right; Ignore dismisses it.", route: "players.vips",
        before: [{ click: { panel: "VIP integrity", css: ".panel-toggle" } }, { click: { panel: "VIP integrity", button: "Scan all servers" } }], target: { panel: "VIP integrity", css: "tbody td:nth-child(2)" },
      },
      {
        text: "A long trail shows its first lines. Show all opens the rest, and Show fewer folds it again.", route: "players.vips",
        before: [{ click: { panel: "VIP integrity", css: ".panel-toggle" } }, { click: { panel: "VIP integrity", button: "Scan all servers" } }], target: { panel: "VIP integrity", css: "td.wrap > button" },
      },
      { text: "Scan again reads the whole VIP history afresh.", route: "players.vips", before: [{ click: { panel: "VIP integrity", css: ".panel-toggle" } }, { click: { panel: "VIP integrity", button: "Scan all servers" } }], target: { panel: "VIP integrity", button: "Scan again" } },
    ],
  },
  {
    id: "remove-vip",
    title: "Take VIP away",
    blurb: "End a player's VIP on a server.",
    keywords: ["remove", "revoke", "delete", "end vip"],
    caps: ["vip.revoke"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.vips"),
      { text: "Open the VIPs tab.", route: "players.vips", target: { tab: "VIPs" } },
      { text: "Find them under Current VIPs. VIP is often paid for, so read the comment first.", route: "players.vips", target: { panel: "Current VIPs", css: "tbody tr" } },
      { text: "Press Revoke. Their VIP on this server ends straight away.", route: "players.vips", target: { panel: "Current VIPs", button: "Revoke" } },
    ],
  },
  {
    id: "pause-vip",
    title: "Pause a player's VIP",
    blurb: "Take VIP away for a while as a punishment, then let it come back.",
    keywords: ["suspend", "freeze", "hold"],
    caps: ["vip.pause"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("★ Edit VIP", "Choose Edit VIP."),
      inVip("Add VIP", "Open the Pause VIP tab.", { button: "Pause VIP" }),
      inVip("Pause VIP", "Write the reason for the pause.", { field: "Reason" }),
      inVip("Pause VIP", "Choose whether their time keeps running, or is kept and given back when the pause ends.", { css: ".seg", nth: 1 }),
      {
        ...inVip("Pause VIP", "Set how long the pause lasts.", { field: "Days" }),
        fields: ["Time buttons", "Hours", "Pause on all servers"],
      },
      {
        ...onProfile("A VIP paused already says until when and why. ▶ Resume VIP now ends the pause early.", { dialog: true, button: "▶ Resume VIP now" },
          [{ click: { css: PROFILE_ACTIONS } }, { click: { button: "★ Edit VIP" } }, { click: { dialog: true, button: "Pause VIP" } }]),
        optional: true,
      },
      { ...inVip("Pause VIP", "Press Pause VIP. It comes back by itself when the pause ends.", { css: ".pa-actions button:last-child" }, [["Reason", "Teamkilling at spawn"], ["Days", "1"]]) },
    ],
  },
  {
    id: "give-vip-live",
    title: "Give VIP from Live",
    blurb: "VIP for one player, from their ⋯ on Live or the Actions on their profile.",
    keywords: ["add vip", "grant", "extend", "edit vip", "time buttons"],
    caps: ["vip.grant"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("★ Edit VIP", "Choose Edit VIP. Its tabs add VIP, take time back or pause it, and Add VIP is open first."),
      {
        ...inVip("Add VIP", "Pick a length: each time button adds its time. Or type the days and hours.", { css: '[aria-label="Time buttons"]' }),
        fields: ["Time buttons", "Days", "Hours"],
      },
      {
        ...inVip("Add VIP", "Or pick the day it ends, or switch on Permanent VIP for no end at all.", { field: "…or until an exact date" }),
        fields: ["Permanent VIP", "…or until an exact date", "Stack onto existing time"],
      },
      {
        ...inVip("Add VIP", "Say who paid or what it is for. It stays with the grant, and is not sent to the game.", { field: "Comment" }),
        fields: ["Comment", "Apply to all servers"],
      },
      inVip("Add VIP", "Press Grant VIP.", { css: ".pa-actions button:last-child" }, [["Comment", "Monthly supporter"]]),
    ],
  },
  {
    id: "give-vip-several",
    title: "Give VIP to several players at once",
    blurb: "Tick players on Live, and give them all the same VIP in one go.",
    keywords: ["bulk vip", "many players", "selected", "tick", "everyone ticked"],
    caps: ["vip.grant"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_LIVE,
      {
        text: "Tick the box beside each player, or the box at the top for everyone shown.", route: "live",
        target: { panel: "Roster", css: "table input[type=checkbox]" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }],
      },
      { text: "Press ⋯ above the ticks, and choose Grant VIP.", route: "live", target: { panel: "Roster", button: "Bulk actions" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }, { click: { panel: "Roster", css: "tbody input[type=checkbox]" } }] },
      {
        text: "Grant VIP gives each the same time. Nobody's VIP is ever cut: whoever has more keeps theirs.", route: "live",
        target: { dialog: true, field: "Days" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }, { click: { panel: "Roster", css: "tbody input[type=checkbox]" } }, { click: { panel: "Roster", button: "Bulk actions" } }, { click: { button: "⭐ Grant VIP" } }],
        fields: ["Days", "Hours", "Add on top", "At least this long", "Comment", "Then message each of them"],
      },
    ],
  },
  {
    id: "remove-vip-time",
    title: "Take back some VIP time",
    blurb: "A refund: some VIP time taken off again, from a player's ⋯ menu.",
    keywords: ["refund", "remove time", "shorten", "take time back"],
    caps: ["vip.revoke"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_LIVE,
      ROW_MENU,
      pick("★ Edit VIP", "Choose Edit VIP."),
      inVip("Add VIP", "Open the Remove time tab.", { button: "Remove time" }),
      inVip("Remove time", "Choose Remove some time, or Revoke entirely to end their VIP, permanent or not.", { css: '[aria-label="How much to take back"]' }),
      {
        ...inVip("Remove time", "Pick how much to take back: each time button adds its time.", { css: '[aria-label="Time buttons"]' }),
        fields: ["Time buttons", "Days", "Hours", "Remove on all servers"],
      },
      {
        ...inVip("Remove time", "Press Remove time.", { css: ".pa-actions button:last-child" }, [["Days", "1"]]),
      },
    ],
  },
  {
    id: "vip-presets",
    title: "Change the VIP time buttons",
    blurb: "The ready-made lengths staff pick from when giving or pausing VIP.",
    keywords: ["durations", "lengths", "buttons"],
    caps: ["vip.presets"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      { text: "Open Administration.", route: "admin.vippresets", target: { nav: "admin" } },
      { text: "Open the VIP presets tab.", route: "admin.vippresets", target: { tab: "VIP presets" } },
      { text: "Each button adds its time when staff give or pause VIP. Change a name or a length, and it saves.", route: "admin.vippresets", target: { panel: "VIP presets", css: ".preset-row" }, fields: ["Label", "Days", "Hours"] },
      { text: "Name a new button, set its days and hours, and press Add.", route: "admin.vippresets", target: { panel: "VIP presets", button: "Add" }, fields: ["New preset label"] },
      { text: "Delete takes a button away, once you say so. Staff stop seeing it at once.", route: "admin.vippresets", target: { panel: "VIP presets", button: "Delete" } },
    ],
  },
  {
    id: "see-vip-presets",
    title: "See the VIP time buttons",
    blurb: "The ready-made lengths staff pick when giving or pausing VIP.",
    keywords: ["durations", "lengths", "presets", "vip"],
    caps: ["vip.presets"],
    group: "Bans & VIP",
    steps: [
      { text: "Open Administration.", route: "admin.vippresets", target: { nav: "admin" } },
      { text: "Open the VIP presets tab.", route: "admin.vippresets", target: { tab: "VIP presets" } },
      { text: "Each ready-made length staff can pick when giving or pausing VIP. Without the permission, a change is sent for approval.", route: "admin.vippresets", target: { panel: "VIP presets" } },
    ],
  },
  {
    id: "see-economy",
    title: "See how members earn points",
    blurb: "The currency, its claims and gifts, and what new members get.",
    keywords: ["currency", "coins", "credits", "claims", "economy"],
    caps: ["economy.config"],
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.economy"),
      { text: "Open the Economy tab.", route: "players.economy", target: { tab: "Economy" } },
      { text: "Settings: the currency, its claims and gifts, and what members get for registering. Without the permission, a change is sent for approval.", route: "players.economy", target: { panel: "Settings" } },
      { text: "VIP panel launcher posts the message whose button opens each member's own VIP panel in Discord.", route: "players.economy", target: { panel: "VIP panel launcher" } },
    ],
  },
  {
    id: "see-shop",
    title: "See the VIP shop",
    blurb: "What members can buy with their points, and the price of each.",
    keywords: ["store", "buy", "price", "offers"],
    caps: ["economy.shop"],
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.economy"),
      { text: "Open the Economy tab.", route: "players.economy", target: { tab: "Economy" } },
      { text: "Shop offers: each offer, its price in points and the VIP days it gives. Without the permission, a change is sent for approval.", route: "players.economy", target: { panel: "Shop offers" } },
    ],
  },
  {
    id: "event-report",
    title: "See how an event went",
    blurb: "Who came and for how long, the rounds played, and who led.",
    keywords: ["attendance", "turnout", "event stats", "report"],
    caps: ["events.manage", "economy.payout"],
    group: "Bans & VIP",
    steps: [
      OPEN_EVENTS("events.report"),
      { text: "Open the Report tab.", route: "events.report", target: { tab: "Report" } },
      { text: "Pick the event. Only an event that has opened has a report.", route: "events.report", target: { panel: "Event report", field: "Event" } },
      { text: "Who came and for how long, the rounds played in its window, and who led the board.", route: "events.report", target: { panel: "Event report", css: ".stat-grid" } },
    ],
  },
  {
    id: "economy-settings",
    title: "Set how members earn points",
    blurb: "The currency's name, the daily and monthly claims, and gifts.",
    keywords: ["currency", "coins", "credits", "claims", "daily", "monthly", "gift"],
    caps: ["economy.config"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.economy"),
      { text: "Open the Economy tab.", route: "players.economy", target: { tab: "Economy" } },
      {
        text: "Name the currency members collect.", route: "players.economy", target: { panel: "Settings", field: "Currency name" },
        fields: ["Balance cap"],
      },
      {
        text: "Turn on the daily and monthly claims, and set how much each one gives.", route: "players.economy", target: { panel: "Settings", field: "Daily claim" },
        fields: ["Monthly claim", "min", "max"],
      },
      {
        text: "Member-to-member gifts let members give each other points. Gifting VIP lets them buy a shop offer for someone else.", route: "players.economy",
        target: { panel: "Settings", field: "Member-to-member" }, fields: ["Member-to-member", "minimum", "maximum", "Gifting VIP"],
      },
      {
        text: "Registration welcome pays points or VIP days to a member who links a game account.", route: "players.economy",
        target: { panel: "Settings", field: "Registration welcome" }, fields: ["Registration welcome", "Points", "VIP days", "Pay it again", "VIP days on all games", "Registration roles"],
      },
      {
        text: "Registration servers is where members may say they play when they register: every server, or only those ticked.", route: "players.economy",
        target: { panel: "Settings", css: ".setting-switch .scope-pick button" },
      },
      { text: "Press Save settings.", route: "players.economy", target: { panel: "Settings", button: "Save settings" } },
      {
        text: "Why can't someone see a button? checks one member against who may claim, by their Discord id.", route: "players.economy", fields: ["Discord user id"],
        before: [{ click: { panel: "Settings", css: 'details:has(input[placeholder="Discord user id"]) > summary' } }], target: { panel: "Settings", button: "Check" },
      },
      { text: "Reapply roles gives each linked member the Discord role for their game, and takes back roles no longer earned.", route: "players.economy", target: { panel: "Settings", button: "Reapply roles to all linked members" } },
      { text: "VIP panel launcher: paste a channel id and press Post launcher. The post keeps working, so post it once.", route: "players.economy", target: { panel: "VIP panel launcher", button: "Post launcher" }, fields: ["Channel id"] },
      {
        text: "v4 cutover import brings over the old bot's links, balances and welcomes, from its bot.db file.", route: "players.economy",
        before: [{ click: { panel: "v4 cutover import", css: ".panel-toggle" } }], target: { panel: "v4 cutover import", button: "Import" },
        fields: ["The v4 bot.db file"],
      },
    ],
  },
  {
    id: "shop-offers",
    title: "Set up the VIP shop",
    blurb: "What members can spend their points on, and the price of each.",
    keywords: ["store", "buy", "sell", "price", "purchase"],
    caps: ["economy.shop"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.economy"),
      { text: "Open the Economy tab.", route: "players.economy", target: { tab: "Economy" } },
      { text: "Press Add offer for each thing members can buy.", route: "players.economy", target: { panel: "Shop offers", button: "Add offer" } },
      { text: "Remove takes an offer out of the shop. Save offers keeps the change.", route: "players.economy", target: { panel: "Shop offers", button: "Remove" } },
      {
        text: "Name it as members will see it, then set its price and the days of VIP it gives.", route: "players.economy", fields: ["Points", "days", "Where it lands", "enabled"],
        before: [{ click: { panel: "Shop offers", button: "Add offer" } }],
        target: { panel: "Shop offers", css: 'label[title="Shown on the Discord button"]' },
      },
      {
        text: "Where it lands: All servers, or Only these and tick each server it lands on.", route: "players.economy",
        before: [{ click: { panel: "Shop offers", button: "Add offer" } }, { click: { panel: "Shop offers", button: "Only these" } }],
        target: { panel: "Shop offers", css: ".scope-pick" },
      },
      {
        text: "Press Save offers.", route: "players.economy",
        before: [
          { click: { panel: "Shop offers", button: "Add offer" } },
          { fill: { panel: "Shop offers", css: 'label[title="Shown on the Discord button"]' }, value: "Two weeks of VIP" },
        ],
        target: { panel: "Shop offers", button: "Save offers" },
      },
    ],
  },
  {
    id: "member-points",
    title: "Look up a member's points",
    blurb: "A member's points, and every change to them.",
    keywords: ["balance", "coins", "credits", "ledger"],
    caps: ["economy.balances"],
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.economy"),
      { text: "Open the Economy tab.", route: "players.economy", target: { tab: "Economy" } },
      { text: "Members lists everyone's points. Search by Discord name or id.", route: "players.economy", target: { panel: "Members", css: "input.search-input" } },
      { text: "Press a member to see every change to their points, and their linked game accounts.", route: "players.economy", target: { panel: "Members", css: "tbody tr" } },
      { text: "Above Activity, a kind keeps to it: purchases, gifts, claims, payouts and the rest. All shows every kind.", route: "players.economy", target: { panel: "Activity", css: ".scope-chip" } },
      { text: "In Activity, a member's name opens them in Members, with their whole ledger.", route: "players.economy", target: { panel: "Activity", css: "button.linklike" } },
    ],
  },
  {
    id: "adjust-points",
    title: "Add or take points by hand",
    blurb: "Change a member's points, with a reason kept on record.",
    keywords: ["give points", "take points", "balance", "coins", "credits"],
    caps: ["economy.balances"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_PLAYERS("players.economy"),
      { text: "Open the Economy tab.", route: "players.economy", target: { tab: "Economy" } },
      { text: "Press the member under Members.", route: "players.economy", target: { panel: "Members", css: "tbody tr" } },
      {
        text: "Type the amount: plus to add, minus to take. Then the reason, which goes on their record.", route: "players.economy",
        before: [{ click: { panel: "Members", css: "tbody tr" } }],
        target: { panel: "Members", css: 'input[type="number"]' },
      },
      {
        text: "Press Apply. Points given by hand are real currency, so give them sparingly.", route: "players.economy",
        before: [
          { click: { panel: "Members", css: "tbody tr" } },
          { fill: { panel: "Members", css: 'input[type="number"]' }, value: "100" },
          { fill: { panel: "Members", css: 'input[placeholder^="Reason"]' }, value: "Event prize" },
        ],
        target: { panel: "Members", button: "Apply" },
      },
    ],
  },
  {
    id: "past-payouts",
    title: "See past payouts",
    blurb: "Every bulk payout, and who was paid what.",
    keywords: ["paid", "rewards"],
    caps: ["economy.payout"],
    group: "Bans & VIP",
    steps: [
      OPEN_EVENTS("events.payouts"),
      { text: "Open the Payouts tab.", route: "events.payouts", target: { tab: "Payouts" } },
      { text: "Payout history lists every run, with a receipt for each person paid.", route: "events.payouts", target: { panel: "Payout history" } },
      { text: "Receipts lists each person a run paid, or could not pay and why.", route: "events.payouts", target: { panel: "Payout history", button: "Receipts" } },
    ],
  },
  {
    id: "run-payout",
    title: "Pay members in bulk",
    blurb: "Points or VIP days for everyone online, at an event, or linked.",
    keywords: ["pay", "reward", "bulk"],
    caps: ["economy.payout"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_EVENTS("events.payouts"),
      { text: "Open the Payouts tab.", route: "events.payouts", target: { tab: "Payouts" } },
      {
        text: "Choose who is paid: who is online now, who was on in a time window, who was at an event, or every linked member.", route: "events.payouts",
        target: { panel: "New payout", field: "Recipients come from" }, fields: ["Server", "From", "To", "Event", "Present at least", "Payout to retry"],
      },
      {
        text: "Choose points or VIP days, and how much.", route: "events.payouts", target: { panel: "New payout", field: "Pay" }, fields: ["Amount", "To", "Role", "VIP lands on"],
      },
      { text: "Press Preview recipients to see the exact list before anything is paid.", route: "events.payouts", target: { panel: "New payout", button: "Preview recipients" } },
      { text: "+ Split by role pays the members of each Discord role a different amount.", route: "events.payouts", target: { panel: "New payout", button: "+ Split by role" } },
      {
        text: "Pick each role and its amount; + Add another role tier adds one more. A blank amount pays the base amount.", route: "events.payouts",
        before: [{ click: { panel: "New payout", button: "+ Split by role" } }], target: { panel: "New payout", button: "+ Add another role tier" }, fields: ["Base amount", "Role", "Amount"],
      },
      { text: "Dry run goes through the payout without paying anyone, so you can see what it would do.", route: "events.payouts", target: { panel: "New payout", button: "Dry run" } },
      { text: "Press Pay when the list is right.", route: "events.payouts", target: { panel: "New payout", button: "Pay" } },
    ],
  },
  {
    id: "see-events",
    title: "See scheduled events",
    blurb: "The community's events, when each opens and closes.",
    keywords: ["event", "calendar"],
    caps: ["events.manage"],
    group: "Bans & VIP",
    steps: [
      OPEN_EVENTS("events.schedule"),
      { text: "Open the Events tab.", route: "events.schedule", target: { tab: "Events" } },
      { text: "Scheduled events lists each one: its server, when it opens and closes, and how long someone must be there to count.", route: "events.schedule", target: { panel: "Scheduled events", css: "table" } },
    ],
  },
  {
    id: "schedule-event",
    title: "Schedule a community event",
    blurb: "An event that opens and closes by itself, and counts who was there.",
    keywords: ["event", "calendar", "attendance"],
    caps: ["events.manage"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_EVENTS("events.schedule"),
      { text: "Open the Events tab.", route: "events.schedule", target: { tab: "Events" } },
      { text: "Name the event, and pick its server.", route: "events.schedule", target: { panel: "Scheduled events", field: "Name" }, fields: ["Server"] },
      { text: "Set how long someone must be there to count as attending.", route: "events.schedule", target: { panel: "Scheduled events", field: "Present at least" } },
      {
        text: "Set when it opens and when it closes.", route: "events.schedule", target: { panel: "Scheduled events", field: "Opens" }, fields: ["Open time", "Closes", "Close time"],
      },
      {
        text: "Map vote during the event pins one of its server's vote setups while it runs. Left alone, the schedule chooses.", route: "events.schedule",
        before: [{ fill: { panel: "Scheduled events", field: "Server" }, value: "Server #1" }], target: { panel: "Scheduled events", field: "Map vote" }, caps: ["mapvote.config"],
      },
      {
        text: "Rotation when the event starts puts a saved rotation on as it opens. Left alone, the rotation stays.", route: "events.schedule",
        before: [{ fill: { panel: "Scheduled events", field: "Server" }, value: "Server #1" }], target: { panel: "Scheduled events", field: "Rotation when the event starts" }, caps: ["maps.rotation"],
      },
      { text: "Press Schedule event.", route: "events.schedule", target: { panel: "Scheduled events", button: "Schedule event" } },
      { text: "Edit, on an event, opens it in the form above. Change it, then press Save changes.", route: "events.schedule", before: [{ click: { panel: "Scheduled events", button: "Edit" } }], target: { panel: "Scheduled events", button: "Save changes" } },
      { text: "Cancel edit leaves the event as it was.", route: "events.schedule", before: [{ click: { panel: "Scheduled events", button: "Edit" } }], target: { panel: "Scheduled events", button: "Cancel edit" } },
    ],
  },
  {
    id: "post-events-list",
    title: "Post the events list to Discord",
    blurb: "The coming events in a Discord channel, once or every week.",
    keywords: ["events", "discord", "post", "announce events", "weekly"],
    caps: ["events.manage"],
    capLevel: "write",
    group: "Bans & VIP",
    steps: [
      OPEN_EVENTS("events.schedule"),
      { text: "Open the Events tab.", route: "events.schedule", target: { tab: "Events" } },
      { text: "Post the list to Discord puts the coming events in a channel: those within the days you set.", route: "events.schedule", before: UNFOLD_POST, target: { panel: "Post the list to Discord", field: "Include events within" }, fields: ["Channel"] },
      { text: "Preview shows the post as it would read.", route: "events.schedule", before: UNFOLD_POST, target: { panel: "Post the list to Discord", button: "Preview" } },
      { text: "Post now sends it to the channel, once.", route: "events.schedule", before: UNFOLD_POST, target: { panel: "Post the list to Discord", button: "Post now" } },
      { text: "Post this automatically sends it by itself: On is the day, At the time.", route: "events.schedule", before: UNFOLD_POST, target: { panel: "Post the list to Discord", field: "On" }, fields: ["Post this automatically", "At"] },
    ],
  },

  // ------------------------------------------------------------------------------ players ----
  {
    id: "read-notes",
    title: "Read the notes on a player",
    blurb: "What staff have written about a player.",
    keywords: ["comments", "notes", "history"],
    caps: ["player.notes"],
    group: "Players",
    steps: [
      ...openProfile(),
      onProfile("Notes holds what staff have written about them.", { panel: "Notes" }),
    ],
  },
  {
    id: "add-note",
    title: "Leave a note on a player",
    blurb: "A note for the next admin, kept on the player's profile.",
    keywords: ["comment", "write"],
    caps: ["player.notes"],
    capLevel: "write",
    group: "Players",
    steps: [
      ...openProfile(),
      onProfile("Under Notes, write what the next admin should know.", { panel: "Notes", css: 'input[placeholder^="Add a note"]' }),
      onProfile("Press Add. The note is kept with who wrote it, and when.", { panel: "Notes", button: "Add" },
        [{ fill: { panel: "Notes", css: 'input[placeholder^="Add a note"]' }, value: "Warned about teamkilling at spawn." }]),
      onProfile("Add comment, in their Actions, writes a note from the menu too.", { button: "📝 Add comment" }, [{ click: { css: PROFILE_ACTIONS } }]),
      onProfile("Write the note, and press Add comment. It joins their notes, with your name.", { dialog: true, field: "Note" }, [{ click: { css: PROFILE_ACTIONS } }, { click: { button: "📝 Add comment" } }]),
    ],
  },
  {
    id: "see-watched",
    title: "See who is being watched",
    blurb: "Everyone on the watchlist, why, and who is online now.",
    keywords: ["suspects", "watch list", "track"],
    caps: ["player.watchlist"],
    group: "Players",
    steps: [
      { text: "Open Moderation.", route: "moderation.watched", target: { nav: "moderation" } },
      { text: "Open the Watched tab.", route: "moderation.watched", target: { tab: "Watched" } },
      { text: "Everyone on the watchlist, with why and who added them. Anyone online now is listed first.", route: "moderation.watched", target: { panel: "Watched players", css: "table" }, fields: ["Search names"] },
      { text: "Press a name to open their profile.", route: "moderation.watched", target: { panel: "Watched players", css: "tbody tr button" } },
    ],
  },
  {
    id: "watch-player",
    title: "Put a player on the watchlist",
    blurb: "Keep an eye on a player, with the reason on record.",
    keywords: ["suspect", "watch list", "track", "monitor"],
    caps: ["player.watchlist"],
    capLevel: "write",
    group: "Players",
    steps: [
      ...openProfile(),
      onProfile("Press Actions.", { css: PROFILE_ACTIONS }),
      onProfile("Choose Add to watchlist.", { button: "👁 Add" }, [{ click: { css: PROFILE_ACTIONS } }]),
      { ...onProfile("Write why. The reason is the record, so say what the next admin needs to know.", { dialog: true, field: "Reason" },
        [{ click: { css: PROFILE_ACTIONS } }, { click: { button: "👁 Add" } }]), fields: ["Expires"] },
      { ...onProfile("Press Add to watchlist. They are marked 👁 on every roster from now on.", { dialog: true, button: "Add to watchlist" },
        [{ click: { css: PROFILE_ACTIONS } }, { click: { button: "👁 Add" } }, { fill: { dialog: true, field: "Reason" }, value: "Teamkilling at spawn" }]) },
      {
        ...onProfile("On a watched player's profile, Edit under Watchlist changes a reason's wording. The earlier version stays on record.", { panel: "Watchlist", button: "Edit" }, [], 2),
      },
    ],
  },
  {
    id: "unwatch-player",
    title: "Take a player off the watchlist",
    blurb: "End a watch, keeping its reasons on record.",
    keywords: ["remove from watchlist", "stop watching"],
    caps: ["player.watchlist.curate"],
    group: "Players",
    steps: [
      ...openProfile(2),
      onProfile("Press Actions.", { css: PROFILE_ACTIONS }, [], 2),
      { ...onProfile("Choose Remove from watchlist. Every reason closes, and stays on the record.", { button: "👁 Remove from watchlist" }, [{ click: { css: PROFILE_ACTIONS } }], 2) },
      { ...onProfile("Under Watchlist on the profile, Remove beside a reason closes that one and keeps the rest.", { panel: "Watchlist", button: "Remove" }, [], 2), caps: ["player.watchlist"] },
      { ...onProfile("Remove from watchlist, under the reasons, closes them all at once, as the menu does. Without the permission, it asks to.", { panel: "Watchlist", css: ".actions > button.danger" }, [], 2), caps: ["player.watchlist"] },
      {
        ...onProfile("Edit, on a reason, changes its words or when it ends; left empty, it lasts until removed. Press Save.", { panel: "Watchlist", button: "Save" }, [{ click: { panel: "Watchlist", button: "Edit" } }], 2),
        fields: ["Reason", "Expires"], caps: ["player.watchlist"], capLevel: "write",
      },
    ],
  },
  {
    id: "flag-player",
    title: "Flag a player",
    blurb: "A short label everyone sees on a player.",
    keywords: ["tag", "label", "mark"],
    caps: ["player.tags"],
    group: "Players",
    steps: [
      ...openProfile(),
      onProfile("Press + Flag, beside their name.", { css: ".ptag-add" }),
      onProfile("Type a short label, such as a warning everyone should see.", { dialog: true, field: "Flag" }, [{ click: { css: ".ptag-add" } }]),
      onProfile("Press Add flag. The × on a flag takes it off again.", { dialog: true, button: "Add flag" },
        [{ click: { css: ".ptag-add" } }, { fill: { dialog: true, field: "Flag" }, value: "Mic spam" }]),
      onProfile("× on a flag takes it off, after asking. Without the permission, it asks for it to be taken off.", { css: ".ptag-x" }),
    ],
  },
  {
    id: "combine-clans",
    title: "Combine a clan's spellings",
    blurb: "Make two clan tags count as one clan, such as a sister tag.",
    keywords: ["merge", "tags", "clan tag"],
    caps: ["player.tags"],
    group: "Players",
    steps: [
      OPEN_PLAYERS("players.clans"),
      { text: "Open the Clans tab.", route: "players.clans", target: { tab: "Clans" } },
      { text: "Every clan tag players have worn, with how many wear it now. Spellings like ᴀʙᴄ are already combined.", route: "players.clans", target: { panel: "Clans", css: "table" } },
      { text: "Tick the tags that are one clan.", route: "players.clans", target: { panel: "Clans", css: 'tbody tr input[type="checkbox"]' } },
      {
        text: "Press Combine. Every spelling of each now counts as one clan.", route: "players.clans",
        before: [{ click: { panel: "Clans", css: 'tbody tr:nth-child(1) input[type="checkbox"]' } }, { click: { panel: "Clans", css: 'tbody tr:nth-child(2) input[type="checkbox"]' } }],
        target: { panel: "Clans", button: "Combine" },
      },
      {
        text: "Rename gives a clan the name the panel shows for it, whatever spellings its players wear.", route: "players.clans",
        target: { panel: "Clans", button: "Rename" }, fields: ["Clan name"],
      },
    ],
  },
  {
    id: "link-discord",
    title: "Link a player's Discord account",
    blurb: "Tie a Discord member to their game account.",
    keywords: ["connect", "discord account"],
    caps: ["player.links"],
    capLevel: "write",
    group: "Players",
    // On the second player, who is not linked yet: a linked one's Actions offer their Discord profile.
    steps: [
      ...openProfile(2),
      onProfile("Press Actions.", { css: PROFILE_ACTIONS }, [], 2),
      onProfile("Choose Link Discord.", { button: "🎮 Link Discord" }, [{ click: { css: PROFILE_ACTIONS } }], 2),
      onProfile("Paste their Discord user id. In Discord: right-click them, then Copy User ID.", { dialog: true, field: "Discord user id" },
        [{ click: { css: PROFILE_ACTIONS } }, { click: { button: "🎮 Link Discord" } }], 2),
      onProfile("Press Link Discord account. Claims, purchases and gifts in Discord then reach this player.", { dialog: true, button: "Link Discord account" },
        [{ click: { css: PROFILE_ACTIONS } }, { click: { button: "🎮 Link Discord" } }, { fill: { dialog: true, field: "Discord user id" }, value: "123456789012345678" }], 2),
    ],
  },
  {
    id: "see-discord-link",
    title: "See a player's Discord account",
    blurb: "The Discord account and other games linked to a player.",
    keywords: ["discord", "discord id", "linked account", "registration", "same account", "other game"],
    caps: ["player.links"],
    group: "Players",
    steps: [
      ...openProfile(),
      onProfile("Discord registration, at the foot of their profile, shows the Discord account linked to them.", { panel: "Discord registration" }),
      onProfile("To change it, paste their Discord user id.", { panel: "Discord registration", field: "Discord user id" }),
      onProfile("Press Change link, or Link for a player not linked yet. Without the permission, a change is sent for approval.", { panel: "Discord registration", css: ".actions > button.primary" },
        [{ fill: { panel: "Discord registration", field: "Discord user id" }, value: "123456789012345678" }]),
      onProfile("Unlink takes the link away, after asking.", { panel: "Discord registration", button: "Unlink" }),
      onProfile("🎮, beside a linked player's name, opens their Discord profile.", { css: 'button.status-chip[aria-label^="Discord linked"]' }),
      onProfile("In Actions, 🎮 Open Discord profile does the same. For a player not linked, it reads Link Discord… instead.", { button: "🎮" }, [{ click: { css: PROFILE_ACTIONS } }]),
    ],
  },
  {
    id: "ip-history",
    title: "See where a player joined from",
    blurb: "The addresses a player has joined from, and who else used them.",
    keywords: ["ip", "address", "alt", "alts", "smurf"],
    caps: ["player.ips"],
    group: "Players",
    steps: [
      ...openProfile(),
      onProfile("Open IP history. It starts folded away, as it is sensitive.", { panel: "IP history" }),
      onProfile("Each address they joined from, how often, and anyone else seen on it.", { panel: "IP history", css: "table" },
        [{ click: { panel: "IP history", css: ".panel-toggle" } }]),
    ],
  },
  {
    id: "see-groups",
    title: "See player groups",
    blurb: "Saved groups of players, and who is in each.",
    keywords: ["list", "roster"],
    caps: ["player.groups"],
    group: "Players",
    steps: [
      OPEN_PLAYERS("players.groups"),
      { text: "Open the Groups tab.", route: "players.groups", target: { tab: "Groups" } },
      { text: "Each group is a saved set of players: a clan-match roster, your streamers, an event squad. Pick one to see who is in it.", route: "players.groups", target: { panel: "Player groups" }, fields: ["Group"] },
    ],
  },
  {
    id: "manage-group",
    title: "Act on a whole group of players",
    blurb: "Make a group, fill it, and give VIP or a message to all of it.",
    keywords: ["mass", "bulk", "everyone in a group", "clan"],
    caps: ["player.groups"],
    capLevel: "write",
    group: "Players",
    steps: [
      OPEN_PLAYERS("players.groups"),
      { text: "Open the Groups tab.", route: "players.groups", target: { tab: "Groups" } },
      { text: "Press + New group and name it.", route: "players.groups", target: { panel: "Player groups", button: "+ New group" }, fields: ["Group name"] },
      { text: "Add players to it by name or id.", route: "players.groups", target: { panel: "Player groups", button: "Add to group" }, fields: ["Group", "Add a member"] },
      { text: "Under Apply to the whole group, choose what to do for everyone in it.", route: "players.groups", target: { panel: "Apply to the whole group", css: ".seg" } },
      {
        text: "Fill in the details, then press the button to do it for the whole group.", route: "players.groups", target: { panel: "Apply to the whole group", css: ".apply-whole-group" },
        fields: ["What to do", "How long", "Admin group", "Expires at", "Days", "Hours", "Stack onto existing time", "At least this long", "Comment", "Reason", "Move everyone to", "Message", "Amount per member", "Apply on"],
      },
      { text: "Remove takes one player out of the group.", route: "players.groups", target: { panel: "Player groups", button: "Remove" } },
      { text: "Upload adds the players in a file to the group. Nobody is taken out.", route: "players.groups", target: { panel: "Player groups", button: "Upload" }, fields: ["A list downloaded from this page"] },
      { text: "Sync from a Discord role keeps the group in step with a role: whoever holds it is in the group.", route: "players.groups", target: { panel: "Player groups", button: "Sync from a Discord role…" }, fields: ["Discord role"] },
      {
        text: "Pick the role, or paste its id, and press Link role.", route: "players.groups",
        before: [{ click: { panel: "Player groups", button: "Sync from a Discord role…" } }], target: { panel: "Player groups", button: "Link role" },
      },
      { text: "A group kept in step with a role names it. Change role picks another one.", route: "players.groups", before: [{ fill: { panel: "Player groups", css: 'select[aria-label="Group"]' }, value: "Clan members (1)" }], target: { button: "Change role" } },
      { text: "Unlink ends the sync. Who is in the group stays.", route: "players.groups", before: [{ fill: { panel: "Player groups", css: 'select[aria-label="Group"]' }, value: "Clan members (1)" }], target: { button: "Unlink" } },
      { text: "Rename gives the group another name.", route: "players.groups", target: { panel: "Player groups", button: "Rename" }, fields: ["New name"] },
      { text: "Delete takes the group and its list away. VIP given with a group action stays; a VIP perk asks first.", route: "players.groups", target: { panel: "Player groups", button: "Delete" } },
      { ...onProfile("Groups…, in a player's Actions, adds them to a group or takes them out.", { button: "👥 Groups" }, [{ click: { css: PROFILE_ACTIONS } }]), optional: true },
      {
        ...onProfile("In it, Add puts them in a group, and Remove takes them out of one they are in.", { dialog: true, css: ".pa-fields .row button" }, [{ click: { css: PROFILE_ACTIONS } }, { click: { button: "👥 Groups" } }]),
        optional: true,
      },
      {
        text: "On Live, tick players, press ⋯ above the ticks and choose Add to group to put them all in one.", route: "live",
        target: { dialog: true, field: "Group" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }], before: [{ click: { panel: "Roster", button: "Table" } }, { click: { panel: "Roster", css: "tbody input[type=checkbox]" } }, { click: { panel: "Roster", button: "Bulk actions" } }, { click: { button: "👥 Add to group" } }],
        optional: true,
      },
    ],
  },
  {
    id: "group-vip-perk",
    title: "Give a group VIP while they are in it",
    blurb: "Permanent VIP for everyone in a group, for as long as they are in it.",
    keywords: ["perk", "clan vip", "streamers", "group vip"],
    caps: ["player.groups"],
    capLevel: "write",
    needs: ["vip.grant", "vip.revoke"],
    group: "Players",
    steps: [
      OPEN_PLAYERS("players.groups"),
      { text: "Open the Groups tab, and pick the group.", route: "players.groups", target: { tab: "Groups" } },
      { text: "Press Set up a VIP perk. Everyone in the group then holds permanent VIP on the servers you choose.", route: "players.groups", target: { panel: "VIP perk", button: "Set up a VIP perk" } },
      {
        text: "With more than one server, Permanent VIP on sets where: every server, all but those ticked, or only those ticked.", route: "players.groups",
        before: [{ click: { panel: "VIP perk", button: "Set up a VIP perk" } }], target: { panel: "VIP perk", css: ".scope-pick" },
        caps: ["vip.grant"], capLevel: "write",
      },
      {
        text: "Set the time to add when someone leaves, and press Switch the perk on.", route: "players.groups",
        before: [{ click: { panel: "VIP perk", button: "Set up a VIP perk" } }], target: { panel: "VIP perk", button: "Switch the perk on" },
        fields: ["Severance on leaving", "Rewards add", "Rewards don't add"],
      },
      {
        text: "With the perk on, Change opens what it gives. Change it, and press Save perk.", route: "players.groups",
        before: [{ fill: { panel: "Player groups", css: 'select[aria-label="Group"]' }, value: "Clan members (1)" }, { click: { panel: "VIP perk", button: "Change" } }], target: { panel: "VIP perk", button: "Save perk" },
      },
      {
        text: "Switch off… ends the perk. Their permanent VIP from the group ends, and the timed VIP kept beneath it comes back.", route: "players.groups",
        before: [{ fill: { panel: "Player groups", css: 'select[aria-label="Group"]' }, value: "Clan members (1)" }], target: { panel: "VIP perk", button: "Switch off…" },
      },
      {
        text: "With time set for leaving, it asks whether to pay it on top. Then press Switch off.", route: "players.groups",
        before: [{ fill: { panel: "Player groups", css: 'select[aria-label="Group"]' }, value: "Clan members (1)" }, { click: { panel: "VIP perk", button: "Switch off…" } }], target: { dialog: true, css: '[role="radiogroup"][aria-label="Severance"]' }, fields: ["Severance"],
      },
      { text: "Timed VIP they already had is kept beneath it, and comes back when they leave the group.", route: "players.groups", target: { panel: "VIP perk" } },
    ],
  },

  // ------------------------------------------------------------------------------ servers ----
  {
    id: "watch-live",
    title: "Watch a server live",
    blurb: "Who is playing, the score, the map, and what is happening now.",
    keywords: ["online", "playing now", "scoreboard", "roster"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      OPEN_LIVE,
      { text: "The top shows the map, the score, the time left and how full the server is.", route: "live", target: { css: ".live-summary" } },
      {
        text: "Roster lists everyone playing. Press a column's name to sort by it.", route: "live", target: { panel: "Roster", css: "table" },
        setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }],
      },
      {
        text: "Above it, a team's name keeps the list to that team, and All shows everyone again.", route: "live", target: { panel: "Roster", css: ".team-filter" },
        setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }],
      },
      {
        text: "Search, or pick a squad or a role, to show only those players. Clear filters shows everyone again.", route: "live",
        target: { panel: "Roster", css: ".roster-filters" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Table" }],
        fields: ["Search the roster", "Filter by squad", "Filter by role"],
      },
      { text: "Teams shows the two sides side by side, each by squad. Table is one list of everyone.", route: "live", target: { panel: "Roster", button: "Teams" }, setup: SCOREBOARD },
      {
        text: "▾ beside a squad folds it away, and again opens it.", route: "live",
        target: { panel: "Roster", css: ".team-squad-head" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Teams" }], before: [{ click: { panel: "Roster", button: "Teams" } }],
      },
      {
        text: "⤢ on a side's name shows that side alone.", route: "live",
        target: { panel: "Roster", css: ".team-side-head" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Teams" }], before: [{ click: { panel: "Roster", button: "Teams" } }],
      },
      {
        text: "A side alone is the full table, by squad: a squad's name folds it. ← on the side's name shows both again.", route: "live",
        target: { panel: "Roster", css: ".locked-head" }, setup: [...SCOREBOARD, { panel: "Roster", button: "Teams" }],
        before: [{ click: { panel: "Roster", button: "Teams" } }, { click: { panel: "Roster", css: ".team-side-head" } }],
      },
      { text: "Live feed shows kills, chat and connections as they happen.", route: "live", target: { panel: "Roster", button: "Live feed" } },
      {
        text: "Choose what to show: chat, kills, team kills, votes and more. Search, or pick a player, to see less.", route: "live",
        target: { panel: "Roster", css: ".control-row" }, setup: [{ panel: "Roster", button: "Live feed" }], before: [{ click: { panel: "Roster", button: "Live feed" } }],
      },
    ],
  },
  {
    id: "past-rounds",
    title: "Look back at a round",
    blurb: "Rounds played on a server, and how each went.",
    keywords: ["matches", "games", "history", "scores"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      { text: "Open History.", route: "history.matches", target: { nav: "history" } },
      { text: "Open the Matches tab.", route: "history.matches", target: { tab: "Matches" } },
      { text: "Each round: its map, the result and how long it ran. Press one to see its scoreboard.", route: "history.matches", target: { panel: "Match history", css: "tbody tr" } },
      {
        text: "The round's page: who played on each side, and every player's line on the scoreboard.", route: "match",
        before: [{ click: { panel: "Match history", css: "tbody tr.row-link td:first-child" } }], target: { panel: "Scoreboard" },
      },
      {
        text: "← Back to matches returns to the list.", route: "match",
        before: [{ click: { panel: "Match history", css: "tbody tr.row-link td:first-child" } }], target: { button: "← Back to matches" },
      },
    ],
  },
  {
    id: "game-log",
    title: "Read the game log",
    blurb: "Chat, kills, connections and more, as the game recorded them.",
    keywords: ["logs", "chat log", "kill feed", "events"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      { text: "Open History.", route: "history.logs", target: { nav: "history" } },
      { text: "Open the Game log tab.", route: "history.logs", target: { tab: "Game log" } },
      {
        text: "Choose what to show: chat, kills, team kills, connections and more. Search, or pick a player, to see less.", route: "history.logs",
        target: { panel: "Game log", css: ".control-row" }, fields: ["Show", "Search names", "Filter to one player"],
      },
      { text: "Live adds each line as it happens. Off, the log is what was stored, a page at a time.", route: "history.logs", target: { panel: "Game log", field: "Live" } },
      { text: "Each line says who did what, and when. A name opens that player's profile.", route: "history.logs", target: { panel: "Game log", css: ".log-list" } },
    ],
  },
  {
    id: "find-player",
    title: "Find a player",
    blurb: "Anyone who has played on your servers, and their profile.",
    keywords: ["search", "look up", "lookup", "profile", "player list", "steam id", "directory"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      ...openProfile().slice(0, 3),
      {
        text: "A server nobody has played on yet says so. Show every server lists everyone your other servers know.", route: "players.players",
        stage: "no-players", target: { panel: "Directory", button: "Show every server" },
      },
      { text: "Watchlist shows only watched players. Filters narrows the list by platform, when they last played and more.", route: "players.players", target: { panel: "Directory", button: "Filters" }, fields: ["Show", "Watched"] },
      {
        text: "In Filters, Seen within keeps to who played lately, or Seen from and till take dates of your own.", route: "players.players",
        before: [{ click: { panel: "Directory", button: "Filters" } }], target: { panel: "Directory", css: ".dir-filters > .control-row:first-child .seg" }, fields: ["Any time", "24 h", "7 days", "30 days", "Seen from", "till"],
      },
      {
        text: "Watched and VIP keep to those players, Platform to one, and Clan tag to anyone who wore it.", route: "players.players",
        before: [{ click: { panel: "Directory", button: "Filters" } }], target: { panel: "Directory", css: ".dir-filters > .control-row:nth-child(2) .seg" }, fields: ["👁 Watched", "★ VIP", "Platform", "Clan tag"],
      },
      {
        text: "Perma banned keeps to players under a permanent ban.", route: "players.players", caps: ["moderation.bans"],
        before: [{ click: { panel: "Directory", button: "Filters" } }], target: { panel: "Directory", button: "🔨 Perma banned" },
      },
      {
        text: "With a filter on, Filters says how many. Reset clears them all.", route: "players.players",
        before: [{ click: { panel: "Directory", button: "Filters" } }, { click: { panel: "Directory", button: "24 h" } }], target: { panel: "Directory", button: "Reset" },
      },
      openProfile()[3]!,
      { ...onProfile("Their profile: how they play, on which servers, their recent sessions and the names they have used.", { panel: "Overview" }) },
      onProfile("Activity lists what they did, from chat and kills to what staff did to them.", { panel: "Activity" }),
      {
        ...onProfile("Choose a kind to see only that: chat, kills, team kills, team switches, moderation or connections.", { panel: "Activity", css: ".activity-controls" }),
      },
      {
        ...onProfile("Actions holds what can be done to them: the same menu as ⋯ beside a player on Live.", { css: PROFILE_ACTIONS }),
      },
      onProfile("🔗 Copy profile link copies a link that opens this profile, to send to someone.", { button: "🔗 Copy profile link" }),
      onProfile("View on… opens their page on stats sites outside the panel, in a new tab.", { button: "View on…" }),
      {
        ...onProfile("Pick a site. Each opens in a new tab.", { css: '.settings-menu [role="menu"]' }, [{ click: { button: "View on…" } }]),
      },
      onProfile("← Back to players returns to the list.", { button: "← Back to players" }),
    ],
  },
  {
    id: "see-leaderboard",
    title: "See the leaderboard",
    blurb: "Your players' career standings, ranked by what you choose.",
    keywords: ["top", "ranking", "best", "stats", "kd", "standings"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      OPEN_PLAYERS("players.leaderboard"),
      { text: "Open the Leaderboard tab.", route: "players.leaderboard", target: { tab: "Leaderboard" } },
      { text: "Rank by kills, K/D, the game's own scores, squad-leader time or playtime.", route: "players.leaderboard", target: { panel: "Leaderboard", css: 'select[aria-label="Rank by"]' } },
      { text: "Each player's standing across your servers. A name opens their profile.", route: "players.leaderboard", target: { panel: "Leaderboard", css: "table" } },
      { text: "Showing ranks them on one server's figures, or on every server's added together.", route: "players.leaderboard", target: { panel: "Leaderboard", css: ".scope-picker" } },
    ],
  },
  {
    id: "see-clans",
    title: "See the clans",
    blurb: "Every clan tag players have worn, and who wears each.",
    keywords: ["clan", "clan tag", "tags", "team", "members"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      OPEN_PLAYERS("players.clans"),
      { text: "Open the Clans tab.", route: "players.clans", target: { tab: "Clans" } },
      { text: "Each clan, its spellings counted as one, with how many wear its tag now and ever.", route: "players.clans", target: { panel: "Clans", css: "table" }, fields: ["Game", "Search clan tags"] },
      { text: "Tick a clan to list everyone who wears its tag, now or before.", route: "players.clans", target: { panel: "Clans", css: 'tbody input[type="checkbox"]' } },
      {
        text: "They are listed below, with when each last wore the tag. A name opens their profile.", route: "players.clans",
        before: [{ click: { panel: "Clans", css: 'tbody input[type="checkbox"]' } }], target: { panel: "Players" },
      },
      {
        text: "Above them, Both, Wearing now and Used to say whose tag counts. Seen within keeps to those seen lately.", route: "players.clans",
        before: [{ click: { panel: "Clans", css: 'tbody input[type="checkbox"]' } }], target: { panel: "Players", css: ".seg" },
        fields: ["Both", "Wearing now", "Used to", "Any time", "24 h", "7 days", "30 days"],
      },
      { text: "Clear, above the list, unticks every clan.", route: "players.clans", before: [{ click: { panel: "Clans", css: 'tbody input[type="checkbox"]' } }], target: { panel: "Clans", button: "Clear" } },
    ],
  },
  {
    id: "see-triggers",
    title: "See the player triggers",
    blurb: "Actions set to fire when one player does something.",
    keywords: ["trigger", "on connect", "on join", "fire once", "next time they join"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      OPEN_PLAYERS("players.triggers"),
      { text: "Open the Triggers tab.", route: "players.triggers", target: { tab: "Triggers" } },
      { text: "All triggers lists every player's, the ones still waiting to fire first. Press a player to open theirs.", route: "players.triggers", target: { panel: "All triggers" } },
      { text: "Player triggers watches one player: when they do something, an action fires, once or every time.", route: "players.triggers", target: { panel: "Player triggers" } },
    ],
  },
  {
    id: "set-trigger",
    title: "Set a trigger on a player",
    blurb: "An action that fires when one player does something, once or every time.",
    keywords: ["trigger", "on connect", "next time they join", "greet", "watch one player"],
    caps: ["action.message"],
    capLevel: "write",
    group: "Player actions",
    steps: [
      OPEN_PLAYERS("players.triggers"),
      { text: "Open the Triggers tab.", route: "players.triggers", target: { tab: "Triggers" } },
      {
        text: "Pick the player it is about. A name under All triggers starts one for them too.", route: "players.triggers",
        target: { panel: "Player triggers", css: 'input[placeholder^="Pick the player"]' },
      },
      {
        text: "When: something they do, or something about them on the live roster. Some ask for more.", route: "players.triggers",
        before: [{ click: { panel: "All triggers", css: "tbody button.linklike" } }], target: { panel: "Player triggers", css: 'select[aria-label="When"]' },
        fields: ["When", "Weapons", "Minutes without a kill", "Minimum level", "Roles", "Banned words", "Blocked pattern", "Block adverts", "Zone set", "Forbid the painted cells", "Only after they've been on", "Hours played", "Over the last", "Count every server", "Only once they have at least", "Kills per 10 minutes", "K/D at or above", "Ratio", "Fires when it is", "Limit", "Only once the two add up", "Find a clan tag", "Minimum squad size", "Minimum crew"],
      },
      {
        text: "Some ask you to pick: the roles, the clan tags, or a crew's roles. Press each one to pick it; ✓ marks those picked.", route: "players.triggers",
        before: [{ click: { panel: "All triggers", css: "tbody button.linklike" } }, { fill: { panel: "Player triggers", css: 'select[aria-label="When"]' }, value: "plays a role" }],
        target: { panel: "Player triggers", css: ".chips .chip-btn" },
      },
      {
        text: "Then: what to do, with its message or reason. Wait holds it back a while first.", route: "players.triggers",
        before: [{ click: { panel: "All triggers", css: "tbody button.linklike" } }], target: { panel: "Player triggers", css: 'select[aria-label="Then"]' },
        fields: ["Then", "Wait", "Message to send", "Watch reason", "Reason", "VIP length", "Ban length", "Points to"],
      },
      { text: "+ Add another action chains another, up to five, each after its own wait.", route: "players.triggers", before: [{ click: { panel: "All triggers", css: "tbody button.linklike" } }], target: { panel: "Player triggers", button: "+ Add another action" } },
      {
        text: "Pick the server, whether it fires once or every time, and why, in Note.", route: "players.triggers",
        before: [{ click: { panel: "All triggers", css: "tbody button.linklike" } }], target: { panel: "Player triggers", field: "Server" },
        fields: ["Server", "Fire once", "Fire every time", "Note"],
      },
      { text: "Press Arm this trigger.", route: "players.triggers", before: [{ click: { panel: "All triggers", css: "tbody button.linklike" } }], target: { panel: "Player triggers", button: "Arm this trigger" } },
    ],
  },
  {
    id: "manage-triggers",
    title: "Change or remove a player trigger",
    blurb: "Edit a trigger, switch it off, or delete it, from the list of every trigger.",
    keywords: ["trigger", "edit trigger", "disable", "re-arm", "plays a role"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      OPEN_PLAYERS("players.triggers"),
      { text: "Open the Triggers tab.", route: "players.triggers", target: { tab: "Triggers" } },
      { text: "Press a player's name to start a new trigger for them in the builder above.", route: "players.triggers", target: { panel: "All triggers", css: "tbody button.linklike" } },
      { text: "Edit opens a trigger in the builder above, to change it. A trigger can only do what you could do yourself.", route: "players.triggers", target: { panel: "All triggers", button: "Edit" } },
      {
        text: "Change what you need and press Save changes.", route: "players.triggers",
        before: [{ click: { panel: "All triggers", button: "Edit" } }], target: { panel: "Player triggers", button: "Save changes" },
        fields: ["Arm it again", "Keep it spent"],
      },
      { text: "Disable stops a trigger firing until you arm it again.", route: "players.triggers", target: { panel: "All triggers", button: "Disable" } },
      { text: "Delete removes a trigger for good.", route: "players.triggers", target: { panel: "All triggers", button: "Delete" } },
    ],
  },
  {
    id: "see-rotation",
    title: "See the map in play",
    blurb: "The map on a server now, read from the game.",
    keywords: ["current map", "map now", "which map", "rotation"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      { text: "Open Maps.", route: "maps.rotation", target: { nav: "maps" } },
      { text: "Open the Rotation tab.", route: "maps.rotation", target: { tab: "Rotation" } },
      { text: "In play shows the map on now. Check from game asks the server again.", route: "maps.rotation", target: { panel: "In play", button: "Check from game" } },
    ],
  },
  {
    id: "see-maps",
    title: "See every map",
    blurb: "The maps a server knows, by the names the panel shows.",
    keywords: ["map list", "maps", "catalogue", "families"],
    caps: ["server.view"],
    group: "Servers",
    steps: [
      { text: "Open Maps.", route: "maps.catalogue", target: { nav: "maps" } },
      { text: "Open the Catalogue tab.", route: "maps.catalogue", target: { tab: "Catalogue" } },
      { text: "Every map the server knows, by the name the panel shows for it. Search finds one by its name or id.", route: "maps.catalogue", target: { panel: "Every map" }, fields: ["Search maps"] },
      { text: "By family puts each map's versions together, such as day and night. Flat list goes back to one list.", route: "maps.catalogue", target: { panel: "Every map", css: "button[aria-pressed]" } },
    ],
  },
  {
    id: "see-admin-camera",
    title: "See who used the admin camera",
    blurb: "Every visit to the admin camera: who, where, when and for how long.",
    keywords: ["admin cam", "camera", "spectator", "who was watching"],
    caps: ["server.admins"],
    group: "Servers",
    steps: [
      { text: "Open History.", route: "history.admincam", target: { nav: "history" } },
      { text: "Open the Admin camera tab.", route: "history.admincam", target: { tab: "Admin camera" } },
      { text: "Each visit to the camera: who, on which server, when, and for how long.", route: "history.admincam", target: { panel: "Admin camera", css: "table" } },
      { text: "Narrow the list to one server, or one admin. Clear shows every visit again.", route: "history.admincam", target: { panel: "Admin camera", css: ".control-row" }, fields: ["Server", "Admin"] },
      { text: "Whether players are told in game when an admin goes into the camera.", route: "history.admincam", target: { panel: "Admin camera", css: ".setting-card" } },
      { text: "Is it working? asks the server picked in Server for its last hour of the camera, when this list looks wrongly empty.", route: "history.admincam", target: { panel: "Is it working?", button: "Check the last hour" }, fields: ["Server"] },
    ],
  },
  {
    id: "admin-camera-notice",
    title: "Tell players when an admin watches",
    blurb: "A line in game when an admin goes into the camera, and when they come out.",
    keywords: ["admin cam", "camera", "spectator", "announce", "notify"],
    caps: ["server.admins"],
    capLevel: "write",
    group: "Servers",
    steps: [
      { text: "Open History.", route: "history.admincam", target: { nav: "history" } },
      { text: "Open the Admin camera tab.", route: "history.admincam", target: { tab: "Admin camera" } },
      { text: "Turn on the announcement for this server. Off, the camera is still recorded, but nobody is told.", route: "history.admincam", target: { panel: "Admin camera", css: ".setting-card" } },
      {
        text: "Write what players read when an admin goes in, and when they come out. A box left empty says nothing.", route: "history.admincam",
        before: [{ click: { panel: "Admin camera", field: "Off" } }], target: { panel: "Admin camera", field: "When they enter" }, fields: ["When they leave"],
      },
      {
        text: "Press Save to keep the change.", route: "history.admincam",
        before: [{ click: { panel: "Admin camera", field: "Off" } }], target: { panel: "Admin camera", button: "Save" },
      },
    ],
  },
  {
    id: "see-connections",
    title: "See the servers' connections",
    blurb: "The game servers the panel talks to, and what each accepts.",
    keywords: ["servers", "connections", "commands", "game update"],
    caps: ["server.config"],
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.connections", target: { nav: "admin" } },
      { text: "Open the Connections tab.", route: "admin.connections", target: { tab: "Connections" } },
      { text: "Connections lists each game server the panel talks to.", route: "admin.connections", target: { panel: "Connections" } },
      { text: "Command check asks a server which game commands it accepts, to see what an update added.", route: "admin.connections", target: { panel: "Connections", button: "Command check" } },
      { text: "View live opens this server on Live.", route: "admin.connections", target: { panel: "Connections", button: "View live" } },
      { text: "Admin action opens a box to act on one player on this server.", route: "admin.connections", target: { panel: "Connections", button: "Admin action" } },
      {
        text: "Find the player, then pick the action and what it asks, a message, a reason or hours, and press Apply.", route: "admin.connections",
        before: [{ click: { panel: "Connections", button: "Admin action" } }], target: { panel: "Connections", button: "Apply" }, fields: ["Search a player", "Action", "Message", "Reason", "Hours"],
      },
      {
        text: "View live shows this server's roster here, as on Live: a table or both teams, searched and filtered.", route: "admin.connections",
        target: { panel: "Connections", button: "View live" }, fields: ["Table", "Teams", "Search the roster", "Filter by squad", "Filter by role"],
      },
      { text: "Act, on a player's row, opens Admin action with that player filled in.", route: "admin.connections", before: [{ click: { panel: "Connections", button: "View live" } }], target: { panel: "Connections", button: "Act" } },
      { text: "Above the roster, a team's name keeps it to that team, and All shows everyone again.", route: "admin.connections", before: [{ click: { panel: "Connections", button: "View live" } }], target: { panel: "Connections", css: ".team-filter" } },
      { text: "In Teams, a side's name shows that side alone, as the full table, and ← goes back to both.", route: "admin.connections", before: [{ click: { panel: "Connections", button: "View live" } }, { click: { panel: "Connections", button: "Teams" } }], target: { panel: "Connections", css: ".team-side-head" } },
      { text: "A squad's name folds its players away, and opens them again.", route: "admin.connections", before: [{ click: { panel: "Connections", button: "View live" } }, { click: { panel: "Connections", button: "Teams" } }], target: { panel: "Connections", css: ".team-squad-head" } },
    ],
  },
  {
    id: "edit-connection",
    title: "Rename a server or change its connection",
    blurb: "The name staff see, and the address and password the panel uses.",
    keywords: ["ip", "port", "password", "rename server"],
    caps: ["server.manage"],
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.connections", target: { nav: "admin" } },
      { text: "Open the Connections tab.", route: "admin.connections", target: { tab: "Connections" } },
      { text: "Panel nickname is the name staff see for this server.", route: "admin.connections", target: { panel: "Connections", field: "Panel nickname" } },
      { text: "Game corrects which game this server runs, which decides how its roster, roles, sides and maps are read.", route: "admin.connections", target: { panel: "Connections", field: "Game" } },
      { text: "Press Connection to change the address, port or password the panel uses.", route: "admin.connections", target: { panel: "Connections", button: "Connection" } },
      {
        text: "Press Save & test.", route: "admin.connections",
        before: [{ click: { panel: "Connections", button: "Connection" } }],
        target: { panel: "Connections", button: "Save & test" },
      },
      { text: "↻ Name reads the server's own name from it again.", route: "admin.connections", target: { panel: "Connections", button: "↻ Name" } },
      { text: "Retire this server… takes it out of every list but this tab. Nothing is deleted, and it can come back.", route: "admin.connections", target: { panel: "Connections", button: "Retire this server…" } },
      { text: "Retired servers lists them. Bring back puts one in every list again, as it was.", route: "admin.connections", target: { panel: "Retired servers", button: "Bring back" } },
    ],
  },
  {
    id: "add-server",
    title: "Add a game server",
    blurb: "Connect the panel to another game server.",
    keywords: ["connect", "new server"],
    caps: ["server.add"],
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.connections", target: { nav: "admin" } },
      { text: "Open the Connections tab.", route: "admin.connections", target: { tab: "Connections" } },
      { text: "Press Add server.", route: "admin.connections", target: { panel: "Connections", button: "Add server" } },
      {
        text: "Fill in its game, address, port and RCON password, as your game server host gives them. A blank name is read from it.", route: "admin.connections",
        before: [{ click: { panel: "Connections", button: "Add server" } }],
        target: { panel: "Connections", field: "Host" }, fields: ["Name (optional)", "Game", "Protocol", "Port", "RCON password", "CRCON API key", "CRCON base URL"],
      },
      {
        text: "Press Add.", route: "admin.connections",
        before: [{ click: { panel: "Connections", button: "Add server" } }],
        target: { panel: "Connections", button: "Add" },
      },
    ],
  },
  {
    id: "engagement",
    title: "Switch a server to active or observe",
    blurb: "Switch a server between active and observe.",
    keywords: ["read only", "observe mode", "active mode"],
    caps: ["server.engagement"],
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.connections", target: { nav: "admin" } },
      { text: "Open the Connections tab.", route: "admin.connections", target: { tab: "Connections" } },
      { text: "Active lets the panel act on the server. Switch to observe, and it only watches: no kicks, messages or automations.", route: "admin.connections", target: { panel: "Connections", button: "Switch to observe" } },
      { text: "A server in observe mode reads and changes nothing. Switch to active lets the panel act on it.", route: "admin.connections", target: { panel: "Connections", button: "Switch to active" } },
      { text: "Publish stats puts this server on the public stats site. Press it again to take it off.", route: "admin.connections", target: { panel: "Connections", button: "Publish stats" } },
      { text: "Published, its button reads Unpublish stats, which takes the page down again.", route: "admin.connections", stage: "published", target: { panel: "Connections", button: "Unpublish stats" } },
      {
        text: "Its page takes a URL name, for the address players share, and a public name. Save keeps them.", route: "admin.connections", stage: "published",
        target: { panel: "Connections", css: ".subcard .subcard .row" },
      },
      {
        text: "Publish player ids shows each player's id beside their name, as CRCON's page does. Off, names only.", route: "admin.connections", stage: "published",
        target: { panel: "Connections", css: ".subcard .subcard label.toggle" },
      },
      { text: "Automation lists what the panel does on this server by itself, each with its own switch.", route: "admin.connections", target: { panel: "Connections", button: "Automation" } },
      {
        text: "Each part has its switch: the vote, broadcasts, seeding, auto settings and rules, the VIP and admin sweeps, the ban and VIP checks.", route: "admin.connections",
        before: [{ click: { panel: "Connections", button: "Automation" } }], target: { panel: "Connections", css: ".admin-panel" },
        fields: ["Map vote", "Broadcast", "Seeding", "Auto settings & rules", "VIP expiry sweep", "Console admin expiry sweep", "Ban reconciliation", "Fix what it finds", "VIP reconciliation"],
      },
    ],
  },
  {
    id: "see-live-settings",
    title: "See a server's game settings",
    blurb: "Auto-balance, kicks, VIP slots and more, read from the game.",
    keywords: ["autobalance", "idle", "vip slots", "game settings"],
    caps: ["server.config"],
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.live", target: { nav: "admin" } },
      { text: "Open the Live settings tab.", route: "admin.live", target: { tab: "Live settings" } },
      { text: "The game's own settings for this server, read from it: balance, kicks and limits, VIP and messages.", route: "admin.live", target: { panel: "Balance & fair play" } },
    ],
  },
  {
    id: "change-live-settings",
    title: "Change a server's game settings",
    blurb: "Set auto-balance, kicks, VIP slots and more on the game.",
    keywords: ["autobalance", "idle kick", "vip slots", "game settings"],
    caps: ["server.config"],
    capLevel: "write",
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.live", target: { nav: "admin" } },
      { text: "Open the Live settings tab.", route: "admin.live", target: { tab: "Live settings" } },
      { text: "Balance & fair play: auto-balance and how far apart the teams may get, and whether players may start a vote kick.", route: "admin.live", target: { panel: "Balance & fair play" }, fields: ["Auto-balance", "Vote kick"] },
      { text: "Press its Save. Each setting saves on its own, straight to the game.", route: "admin.live", target: { panel: "Balance & fair play", button: "Save" } },
      { text: "Each setting has its own Save. Kicks & limits holds the ping and idle kicks, and the join queue.", route: "admin.live", target: { panel: "Kicks & limits", button: "Save" }, fields: ["High-ping kick", "Idle kick", "Team-switch cooldown", "Max queued players"] },
      { text: "VIP & messaging holds the VIP slots and what players are told, each with its own Save too.", route: "admin.live", target: { panel: "VIP & messaging", button: "Save" }, fields: ["VIP slots", "Welcome message", "Notice message"] },
      { text: "Map shuffle, under Maps, plays the rotation in the game's own shuffled order instead of as it is listed.", route: "admin.live", target: { panel: "Maps", button: "Save" }, fields: ["Map shuffle"] },
      { text: "Reload reads the settings from the server again.", route: "admin.live", target: { button: "Reload" } },
    ],
  },
  {
    id: "see-console-admins",
    title: "See who is a console admin",
    blurb: "Players with the game's own admin powers, such as the admin camera.",
    keywords: ["in-game admins", "admin camera", "admins"],
    caps: ["server.admins"],
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.admins", target: { nav: "admin" } },
      { text: "Open the Console admins tab.", route: "admin.admins", target: { tab: "Console admins" } },
      { text: "Everyone with in-game admin powers on this server, their group, and when it ends.", route: "admin.admins", target: { panel: "Console admins", css: "table" } },
    ],
  },
  {
    id: "make-console-admin",
    title: "Make a player a console admin",
    blurb: "Give a player the game's own admin powers, for good or for a while.",
    keywords: ["in-game admin", "admin camera", "give admin"],
    caps: ["server.admins"],
    capLevel: "write",
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.admins", target: { nav: "admin" } },
      { text: "Open the Console admins tab.", route: "admin.admins", target: { tab: "Console admins" } },
      { text: "Find the player by name, or paste their id.", route: "admin.admins", target: { panel: "Console admins", css: ".field" } },
      { text: "Pick their admin group. Spectator gives the admin camera alone.", route: "admin.admins", target: { panel: "Console admins", field: "Group" } },
      { text: "Choose for good, until a date, or for some days and hours.", route: "admin.admins", target: { panel: "Console admins", css: ".seg" }, fields: ["Expires at", "Days", "Hours", "Stack onto existing time"] },
      { text: "Comment says why, for staff alone. Apply to all servers makes them an admin on every server you may.", route: "admin.admins", target: { panel: "Console admins", field: "Comment" }, fields: ["Apply to all servers"] },
      { text: "Press Make them an admin.", route: "admin.admins", target: { panel: "Console admins", button: "Make them an admin" } },
      { ...pick("🎥 Console admin", "On Live, Console admin… in a player's ⋯ menu does the same for that one player."), optional: true },
      {
        ...inDialog("🎥 Console admin", "There, pick their admin group, and whether it is for good. Note says why, for staff alone.", { field: "Admin group" }),
        fields: ["Admin group", "Permanent", "Time buttons", "Days", "Hours", "Stack onto existing time", "Note", "Apply to all servers"],
        optional: true,
      },
    ],
  },
  {
    id: "crcon-backup",
    title: "Find the CRCON backup",
    blurb: "Where the copy of your CRCON history is kept, and checked.",
    keywords: ["import", "history"],
    caps: ["crcon.pull", "crcon.apply"],
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.connections", target: { nav: "admin" } },
      { text: "Open the Connections tab.", route: "admin.connections", target: { tab: "Connections" } },
      { text: "CRCON backup holds the copy of this server's CRCON history, with checks that it came across whole.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)" } },
      { text: "Start backup pull copies this server's CRCON history into an archive here, read with the URL and key above. Nothing changes yet.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Start backup pull" }, fields: ["CRCON URL", "CRCON API key"] },
      { text: "While a pull runs, it says Pulling…, and Pause holds it where it is.", route: "admin.connections", stage: "crcon-running", target: { panel: "CRCON backup (full data pull)", button: "Pause" }, caps: ["crcon.pull"], capLevel: "write" },
      { text: "A paused pull carries on with Resume, read with a new URL or key if one is typed above.", route: "admin.connections", stage: "crcon-paused", target: { panel: "CRCON backup (full data pull)", button: "Resume" }, caps: ["crcon.pull"], capLevel: "write" },
      { text: "Start over begins it again from the top, after asking. What is archived already is kept and skipped.", route: "admin.connections", stage: "crcon-paused", target: { panel: "CRCON backup (full data pull)", button: "Start over" }, caps: ["crcon.pull"], capLevel: "write" },
      { text: "One stopped on an error says why. Retry failures fetches again only what failed.", route: "admin.connections", stage: "crcon-stopped", target: { panel: "CRCON backup (full data pull)", button: "Retry failures" }, caps: ["crcon.pull"], capLevel: "write" },
      {
        text: "Once it is done, Retry and top up fetch again only what failed, and any data types added since.", route: "admin.connections", stage: "crcon-done",
        target: { panel: "CRCON backup (full data pull)", css: 'button[title^="Re-fetch only what failed (plus"]' }, caps: ["crcon.pull"], capLevel: "write",
      },
      { text: "Run another full pull fetches everything again, after asking.", route: "admin.connections", stage: "crcon-done", target: { panel: "CRCON backup (full data pull)", button: "Run another full pull" }, caps: ["crcon.pull"], capLevel: "write" },
      { text: "Dry run goes through the whole archive and says what Apply would bring in, writing nothing.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Dry run" } },
      { text: "Apply to panel brings the archive into the panel.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Apply to panel" } },
      { text: "Export backup saves the archive as a file.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Export backup" } },
      { text: "Upload backup… brings an archive file back in.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Upload backup…" } },
      { text: "Check import integrity looks for history that came across mixed up with another server's.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Check import integrity" } },
      { text: "Check VIP expiries finds any VIP whose end date was moved off what staff set, and offers to give it back.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Check VIP expiries" } },
      { text: "Delete archive… removes the stored copy of this server's CRCON history, after asking. What was imported stays.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Delete archive" }, caps: ["crcon.pull"], capLevel: "write" },
    ],
  },
  {
    id: "wipe-server-data",
    title: "Wipe a server's history",
    blurb: "Delete every record a server holds, live and imported, to start it clean.",
    keywords: ["wipe", "delete history", "start over", "purge"],
    caps: ["crcon.pull"],
    capLevel: "write",
    group: "Servers",
    steps: [
      { text: "Open Administration.", route: "admin.connections", target: { nav: "admin" } },
      { text: "Open the Connections tab.", route: "admin.connections", target: { tab: "Connections" } },
      { text: "Wipe this server's data… deletes every record on this server, live and imported, bans and VIP too. It asks first.", route: "admin.connections", target: { panel: "CRCON backup (full data pull)", button: "Wipe this server" } },
    ],
  },

  // ------------------------------------------------------------------------- maps & votes ----
  {
    id: "change-map-now",
    title: "Change the map now",
    blurb: "Load another map straight away, ending the round in progress.",
    keywords: ["switch map", "load map", "next map"],
    caps: ["maps.next"],
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.catalogue", target: { nav: "maps" } },
      { text: "Open the Catalogue tab: every map the server can play.", route: "maps.catalogue", target: { tab: "Catalogue" } },
      { text: "Press Change now on the map you want. It ends the round in progress, so warn the players first.", route: "maps.catalogue", target: { button: "Change now" } },
    ],
  },
  {
    id: "edit-rotation",
    title: "Change the map rotation",
    blurb: "Which maps play, in what order, after the one in progress.",
    keywords: ["map list", "map order", "cycle", "map pool"],
    caps: ["maps.rotation"],
    capLevel: "write",
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.rotation", target: { nav: "maps" } },
      { text: "Open the Rotation tab.", route: "maps.rotation", target: { tab: "Rotation" } },
      { text: "In play shows the map being played. Check from game asks the game again what plays next.", route: "maps.rotation", target: { button: "Check from game" } },
      { text: "Move a map up or down the rotation with ↑ and ↓, or take it out with ✕.", route: "maps.rotation", target: { button: "↑" } },
      { text: "Search a map to add, and pick it: it joins the end of the rotation.", route: "maps.rotation", target: { panel: "Edit rotation", css: 'input[placeholder^="Search a map to add"]' } },
      { text: "Pick a saved rotation and press Apply set, to put it in place in one go.", route: "maps.rotation", target: { panel: "Edit rotation", button: "Apply set" }, fields: ["Saved rotation"] },
      { text: "Name the order and press Save rotation as a set, to put it back in one step later.", route: "maps.rotation", target: { panel: "Edit rotation", button: "Save rotation as a set" }, fields: ["Name this rotation"] },
    ],
  },
  {
    id: "rename-maps",
    title: "Rename how a map is shown",
    blurb: "The name a map goes by in the panel and in votes.",
    keywords: ["map names", "display name"],
    caps: ["maps.names"],
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.catalogue", target: { nav: "maps" } },
      { text: "Open the Catalogue tab.", route: "maps.catalogue", target: { tab: "Catalogue" } },
      { text: "Press Rename beside a map to change how the panel and votes name it. The game itself is not changed.", route: "maps.catalogue", target: { button: "Rename" } },
      {
        text: "Type the name and press Save. Reset to auto puts back the name the panel worked out.", route: "maps.catalogue",
        before: [{ click: { panel: "Every map", button: "Rename" } }], target: { panel: "Every map", button: "Save" }, fields: ["Name"],
      },
      { text: "Set family puts a map with its other versions, when the panel has read its name differently.", route: "maps.catalogue", target: { panel: "Every map", button: "Set family" } },
      {
        text: "Type a family to join it, or a new one to start, and press Save. Reset to inferred undoes it.", route: "maps.catalogue",
        before: [{ click: { panel: "Every map", button: "Set family" } }], target: { panel: "Every map", button: "Save" }, fields: ["Family"],
      },
    ],
  },
  {
    id: "choose-objectives",
    title: "Choose the objectives",
    blurb: "What the match is fought over, row by row.",
    keywords: ["objectives", "layout", "sectors", "strongpoints", "game layout"],
    caps: ["maps.next"],
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.rotation", target: { nav: "maps" } },
      { text: "Open the Rotation tab.", route: "maps.rotation", target: { tab: "Rotation" } },
      {
        text: "Objectives has five rows, three choices in each. Pick one in each row, or leave it on Random.", route: "maps.rotation",
        target: { panel: "Objectives", css: ".obj-opts" },
      },
      { text: "Re-read asks the server for its choices again, after the map changes.", route: "maps.rotation", target: { panel: "Objectives", button: "Re-read" } },
      {
        text: "Press Set these objectives.", route: "maps.rotation", target: { panel: "Objectives", button: "Set these objectives" },
      },
      { text: "On Vietnam the layout is saved for the map: pick how long it stands, from the next play to until cleared.", route: "maps.rotation", stage: "vietnam", target: { panel: "Objectives", css: ".actions > select" } },
      { text: "Then press Save the layout. Nothing restarts, and it is used each time the map plays.", route: "maps.rotation", stage: "vietnam", target: { panel: "Objectives", button: "Save the layout" } },
      { text: "A layout saved for the map shows above the rows. Clear saved layout gives the choice back to the server.", route: "maps.rotation", stage: "vietnam", target: { panel: "Objectives", button: "Clear saved layout" } },
      {
        text: "Edit locations teaches the map where each choice is: pick a choice, then tap its square on the map.", route: "maps.rotation",
        target: { panel: "Objectives", field: "Edit locations" }, caps: ["maps.names"], fields: ["Map grid"],
      },
    ],
  },
  {
    id: "follow-map-vote",
    title: "Follow the map vote",
    blurb: "How the vote for the next map is going.",
    keywords: ["votes", "poll"],
    caps: ["mapvote.config"],
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.vote", target: { nav: "maps" } },
      { text: "Open the Vote tab.", route: "maps.vote", target: { tab: "Vote" } },
      { text: "Map vote shows the vote in progress: the maps offered and how each is doing.", route: "maps.vote", target: { panel: "Map vote" } },
    ],
  },
  {
    id: "vote-setup",
    title: "Set up the map vote",
    blurb: "Whether players vote on the next map, where, and from which maps.",
    keywords: ["poll", "votemap", "map vote"],
    caps: ["mapvote.config"],
    capLevel: "write",
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.votesetup", target: { nav: "maps" } },
      { text: "Open the Vote setup tab.", route: "maps.votesetup", target: { tab: "Vote setup" } },
      { text: "Turn the vote on here. Off, no vote is held at all.", route: "maps.votesetup", target: { panel: "Vote setup", css: ".setting-card" } },
      {
        text: "Choose where players vote: a Discord poll, or in game.", route: "maps.votesetup", target: { panel: "Vote setup", field: "Voting surface" },
        fields: ["In-game votes", "Discord votes", "Discord channel ID", "Discord poll card lifetime"],
      },
      { text: "Map sets say which maps a vote can offer, and schedules say when each set is used.", route: "maps.votesetup", target: { panel: "Vote setup", button: "Manage map sets" } },
      { text: "Times are in sets the clock this server reads its schedules on.", route: "maps.votesetup", target: { panel: "Vote setup", field: "Times are in" } },
      {
        text: "Timing: whether the leading map is queued as votes come in, the waits after a match, and when the vote pauses.", route: "maps.votesetup",
        target: { panel: "Vote setup", field: "After a match ends" },
        fields: ["Keep the next map", "Only decide the next map", "After a match ends", "Clear the channel", "And leave the next map alone", "Pause voting while fewer than", "If the bot restarts"],
      },
      saveOrDiscard("maps.votesetup", "Vote setup"),
      { text: "Manage schedules says when the vote offers each map set, such as quieter maps at night.", route: "maps.votesetup", target: { panel: "Vote setup", button: "Manage schedules" } },
      { text: "In Manage map sets, pick a set to change it, or New map set starts one.", route: "maps.votesetup", before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }], target: { panel: "Vote setup", css: '.control-row:has(select[aria-label="Manage map sets"])' } },
      {
        text: "A set on the older day and night counts offers Convert this set: it builds the set by game mode, offering what it did.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }], target: { panel: "Vote setup", button: "Convert this set" },
      },
      {
        text: "By game mode, each mode is a category. In the vote is how many of its maps a vote offers; Remove drops the category.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "seeding" }], target: { panel: "Vote setup", css: ".mapset-bucket > .control-row > .row" },
      },
      {
        text: "The boxes under a category cap each time of day it may draw. All at 0, any time of day will do.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "seeding" }], target: { panel: "Vote setup", css: ".mapset-envs" }, fields: ["Any time", "Day", "Night", "Dusk", "Morning", "Overcast", "Rain"],
      },
      { text: "Add a mode adds a category for another mode this server plays.", route: "maps.votesetup", before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "seeding" }], target: { panel: "Vote setup", css: ".actions:has(> span.hint)" } },
      {
        text: "Always offer puts maps in every vote of this set, on top of what it draws. Choose maps opens them; Done folds them away.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }], target: { panel: "Vote setup", css: ".setting-card > .row > button[aria-expanded]" },
      },
      {
        text: "Press a map to pick it, or a map's name to pick all its versions. Filter maps finds one, and Clear lets them all go.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }, { click: { panel: "Vote setup", css: ".setting-card > .row > button[aria-expanded]" } }], target: { panel: "Vote setup", css: ".mapgrid" },
      },
      { text: "▸ Advanced holds the rest of the set's settings.", route: "maps.votesetup", before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }], target: { panel: "Vote setup", css: ".setting-card > button[aria-expanded]" } },
      {
        text: "There: how many rounds a played map, or its whole family, rests, and whether one map may be offered twice. Never offer these is a veto.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }, { click: { panel: "Vote setup", css: ".setting-card > button[aria-expanded]" } }], target: { panel: "Vote setup", css: ".setting-card > button[aria-expanded] + .setting-card" },
        fields: ["Don't re-offer the last", "…and rest whole map families for", "Can the same map appear twice?"],
      },
      {
        text: "Save map set keeps it. Duplicate copies it, and Delete removes it for every server, after asking.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }], target: { panel: "Vote setup", css: ".setting-card > .actions:has(> button.danger)" }, fields: ["Name"],
      },
      {
        text: "History, under it, lists each saved change. Restore the version before this goes back one.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }, { click: { panel: "Vote setup", css: ".library-history summary" } }], target: { panel: "Vote setup", button: "Restore the version before this" },
      },
      {
        text: "Recently deleted, under the list, brings a deleted one back with Restore.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage map sets" } }, { click: { panel: "Vote setup", css: ".library-deleted summary" } }], target: { panel: "Vote setup", css: ".library-deleted button" },
      },
      { text: "In Manage schedules, pick a schedule to change it, or New schedule starts one.", route: "maps.votesetup", before: [{ click: { panel: "Vote setup", button: "Manage schedules" } }], target: { panel: "Vote setup", css: '.control-row:has(select[aria-label="Manage schedules"])' } },
      {
        text: "Its days, hours and player counts say when it applies; left blank, it always does. Specific dates are for one-off events.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Manage schedules" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage schedules"]' }, value: "Daytime" }], target: { panel: "Vote setup", css: ".daypick" },
        fields: ["Name", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "From (time of day)", "Until", "Only when fewer players than", "Only when more players than", "Specific dates"],
      },
      { text: "Save schedule keeps it. Duplicate copies it, and Delete removes it for every server, after asking.", route: "maps.votesetup", before: [{ click: { panel: "Vote setup", button: "Manage schedules" } }, { fill: { panel: "Vote setup", css: 'select[aria-label="Manage schedules"]' }, value: "Daytime" }], target: { panel: "Vote setup", css: ".setting-card > .actions:has(> button.danger)" } },
      { text: "Add a map set to this server pairs one more set with a schedule. The vote uses the pair whose schedule fits.", route: "maps.votesetup", target: { panel: "Vote setup", button: "Add a map set to this server" } },
      { text: "Add a reminder sends players a line during the match, pointing them to the vote.", route: "maps.votesetup", target: { panel: "Vote setup", button: "Add a reminder" } },
      {
        text: "Set how many minutes in it is sent, what it says, and what follows: the maps, or the maps with their votes. Remove takes it off.", route: "maps.votesetup",
        before: [{ click: { panel: "Vote setup", button: "Add a reminder" } }], target: { panel: "Vote setup", button: "Remove" }, fields: ["min into the match", "Reminder", "Then"],
      },
      savedSetups("maps.votesetup", "Vote setup"),
    ],
  },
  {
    id: "vote-control",
    title: "Pause the vote, or force a map",
    blurb: "Step in on a vote that is running or has just been decided.",
    keywords: ["pause vote", "force map", "override"],
    caps: ["mapvote.control"],
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.vote", target: { nav: "maps" } },
      { text: "Open the Vote tab.", route: "maps.vote", target: { tab: "Vote" } },
      { text: "Pause stops the vote for now. A button that cannot be pressed now says why.", route: "maps.vote", target: { panel: "Map vote", button: "Pause" } },
      { text: "Resume carries a paused vote on, offering the same maps again.", route: "maps.vote", target: { panel: "Map vote", button: "Resume" } },
      { text: "Force next map picks the next map whatever the votes say.", route: "maps.vote", target: { panel: "Map vote", button: "Force next map" } },
      {
        text: "Pick one of the maps on offer, or search for any map on the server. Cancel leaves the vote alone.", route: "maps.vote",
        before: [{ click: { panel: "Map vote", button: "Force next map" } }], target: { panel: "Map vote", css: 'input[placeholder^="Search a map to force"]' },
      },
      {
        text: "While a vote runs, the maps on its ballot come first: press one to make it the next map.", route: "maps.vote",
        before: [{ click: { panel: "Map vote", button: "Force next map" } }], target: { panel: "Map vote", css: "p.hint + .actions" },
      },
      { text: "Clear forced map lets the vote decide again.", route: "maps.vote", target: { panel: "Map vote", button: "Clear forced map" } },
    ],
  },
  {
    id: "run-vote",
    title: "Run a map vote by hand",
    blurb: "Open a vote now, offer other maps, skip one, and tell players how it stands.",
    keywords: ["start vote", "new options", "skip vote", "map list", "standings"],
    caps: ["mapvote.control"],
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.vote", target: { nav: "maps" } },
      { text: "Open the Vote tab.", route: "maps.vote", target: { tab: "Vote" } },
      { text: "Start vote opens a vote now, instead of waiting for the match to end.", route: "maps.vote", target: { panel: "Map vote", button: "Start vote" } },
      { text: "New options closes the vote and offers a different set of maps.", route: "maps.vote", target: { panel: "Map vote", button: "New options" } },
      { text: "Skip vote closes the vote without picking a winner.", route: "maps.vote", target: { panel: "Map vote", button: "Skip vote" } },
      { text: "Re-read maps reads the server's map list again, then opens a fresh vote.", route: "maps.vote", target: { panel: "Map vote", button: "Re-read maps" } },
      { text: "Tell players: maps sends the maps on offer to everyone in the game.", route: "maps.vote", target: { panel: "Map vote", button: "Tell players: maps" } },
      { text: "Tell players: standings sends how the vote stands right now.", route: "maps.vote", target: { panel: "Map vote", button: "Tell players: standings" } },
    ],
  },
  {
    id: "see-vote-setup",
    title: "See how the map vote is set up",
    blurb: "Whether players vote on the next map, where, and how.",
    keywords: ["map vote", "poll", "votemap", "settings"],
    caps: ["mapvote.config"],
    group: "Maps & votes",
    steps: [
      { text: "Open Maps.", route: "maps.votesetup", target: { nav: "maps" } },
      { text: "Open the Vote setup tab.", route: "maps.votesetup", target: { tab: "Vote setup" } },
      { text: "Whether players vote, in Discord or in game, who may, and when the result applies. Without the permission, a change is sent for approval.", route: "maps.votesetup", target: { panel: "Vote setup" } },
    ],
  },
  {
    id: "mapvote-history",
    title: "Look back at map votes",
    blurb: "Every vote, how it was decided, and which maps win.",
    keywords: ["votes", "poll results", "winner", "history"],
    caps: ["mapvote.config"],
    group: "Maps & votes",
    steps: [
      { text: "Open History.", route: "history.mapvotes", target: { nav: "history" } },
      { text: "Open the Map votes tab.", route: "history.mapvotes", target: { tab: "Map votes" } },
      { text: "Every vote, newest first, and how it was decided. Open one to see how it broke down.", route: "history.mapvotes", target: { panel: "Every vote" } },
      { text: "Which maps win: how often each is offered, and how often players pick it.", route: "history.mapvotes", target: { panel: "Which maps win" } },
      { text: "Who votes: the people deciding your rotation, and how often they win.", route: "history.mapvotes", target: { panel: "Who votes" } },
      { text: "In Every vote, Show the maps opens one vote: each map that was offered, and its votes.", route: "history.mapvotes", target: { panel: "Every vote", button: "Show the" } },
    ],
  },

  // --------------------------------------------------------------------------- automation ----
  {
    id: "rotating-broadcasts",
    title: "Set up the rotating broadcasts",
    blurb: "Lines that scroll across the top of every player's screen in turn.",
    keywords: ["announcements", "scrolling", "message of the day", "ticker"],
    caps: ["broadcast.config"],
    capLevel: "write",
    group: "Automation",
    steps: [
      { text: "Open Administration.", route: "admin.broadcast", target: { nav: "admin" } },
      { text: "Open the Broadcast tab.", route: "admin.broadcast", target: { tab: "Broadcast" } },
      { text: "Rotating broadcasts scroll across the top left of every player's screen, one after another.", route: "admin.broadcast", target: { panel: "Rotating broadcasts" } },
      { text: "Enable rotation is its switch. Dry-run writes down what it would send and shows players nothing; Live shows it.", route: "admin.broadcast", target: { panel: "Rotating broadcasts", setting: "Enable rotation" }, fields: ["Dry-run"] },
      { text: "Every, under Timing, is the time between messages: one of these, or Custom in seconds.", route: "admin.broadcast", target: { panel: "Rotating broadcasts", css: ".control-row > .chip-btn" }, fields: ["Custom (sec)"] },
      { text: "Shuffle order picks the next message at random.", route: "admin.broadcast", target: { panel: "Rotating broadcasts", setting: "Shuffle order" } },
      { text: "Each message is a box to edit. Type a new one in the box under them and press Add.", route: "admin.broadcast", target: { panel: "Rotating broadcasts", button: "Add" }, fields: ["Broadcast", "Add a broadcast"] },
      saveOrDiscard("admin.broadcast", "Rotating broadcasts"),
      {
        text: "Live welcome message keeps the game's welcome text filled in. Set it up, then press its own Save.", route: "admin.broadcast",
        target: { panel: "Live welcome message", css: ".panel-actions" }, fields: ["On", "Off", "Welcome message", "Update at most every"],
      },
      savedSetups("admin.broadcast"),
      { text: "Broadcast now sends one line across everyone's screen, once: type it, then press Broadcast now.", route: "admin.broadcast", target: { panel: "Broadcast now", button: "Broadcast now" }, caps: ["action.message"], fields: ["Broadcast text"] },
    ],
  },
  {
    id: "see-broadcasts",
    title: "See what players are shown in game",
    blurb: "The lines that scroll across every player's screen, and the live welcome.",
    keywords: ["announcements", "scrolling", "ticker", "welcome", "join"],
    caps: ["broadcast.config"],
    group: "Automation",
    steps: [
      { text: "Open Administration.", route: "admin.broadcast", target: { nav: "admin" } },
      { text: "Open the Broadcast tab.", route: "admin.broadcast", target: { tab: "Broadcast" } },
      { text: "Rotating broadcasts scroll across the top of every player's screen, one after another.", route: "admin.broadcast", target: { panel: "Rotating broadcasts" } },
      { text: "The live welcome is what each player is shown as they join. Without the permission, a change is sent for approval.", route: "admin.broadcast", target: { panel: "Live welcome message" } },
    ],
  },
  {
    id: "auto-profiles",
    title: "Let a server change its own settings",
    blurb: "Profiles that switch the server's settings by time or player count.",
    keywords: ["automation", "schedule settings", "player count"],
    caps: ["autosettings.profiles"],
    capLevel: "write",
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.settings", target: { nav: "autosettings" } },
      { text: "Open the Server settings tab.", route: "autosettings.settings", target: { tab: "Server settings" } },
      {
        text: "Enable auto settings switches the profiles on. Dry-run, under it, records what they would change, until it says Live.", route: "autosettings.settings",
        target: { panel: "Profiles", setting: "Enable auto settings" }, fields: ["Dry-run", "Default timezone"],
      },
      { text: "Press Add profile. A profile changes the server's settings at a time of day, or at a player count.", route: "autosettings.settings", target: { panel: "Profiles", button: "Add profile" } },
      {
        text: "Name it. ↑ and ↓ set which profile comes first, as the first that matches wins, and Delete takes one away.", route: "autosettings.settings",
        before: [{ click: { panel: "Profiles", button: "Add profile" } }], target: { panel: "Profiles", button: "Delete" }, fields: ["profile name"],
      },
      {
        text: "+ When… adds what must hold: a time, days, dates or months, how many are on, or how long the match has run.", route: "autosettings.settings",
        before: [{ click: { panel: "Profiles", button: "Add profile" } }], target: { panel: "Profiles", css: 'select[aria-label="Add a condition"]' },
        fields: ["Add a condition", "From", "To", "Dates", "Months", "Total players are", "Allies players are", "Axis players are", "Team-size gap is", "Match has been running", "Time zone"],
      },
      {
        text: "Day is… asks which days: press each day it holds on. None picked means every day.", route: "autosettings.settings",
        before: [{ click: { panel: "Profiles", button: "Add profile" } }, { fill: { panel: "Profiles", css: 'select[aria-label="Add a condition"]' }, value: "Day is…" }],
        target: { panel: "Profiles", css: ".chips .chip-btn" },
      },
      {
        text: "+ Then… adds what it does: set a server setting, turn an automation on or off, apply a saved setup, queue a map or apply a template.", route: "autosettings.settings",
        before: [{ click: { panel: "Profiles", button: "Add profile" } }], target: { panel: "Profiles", css: 'select[aria-label="Add a change"]' }, fields: ["Add a change", "Set", "Turn", "Apply", "Queue next map"],
      },
      saveOrDiscard("autosettings.settings", "Profiles"),
      { text: "Timed match messages are sent to players at set times in each round. Add a timed message for each one.", route: "autosettings.settings", target: { panel: "Timed match messages", button: "Add a timed message" } },
      {
        text: "Set its minute, how many must be on, its switch and its words. ✕ takes one off.", route: "autosettings.settings",
        before: [{ click: { panel: "Timed match messages", button: "Add a timed message" } }], target: { panel: "Timed match messages", css: 'textarea[aria-label="Message"]' },
        fields: ["Minutes into the match", "Players on at least", "On", "Message"],
      },
      saveOrDiscard("autosettings.settings", "Timed match messages", { text: "Save and Discard here keep, or put back, both panels: profiles and timed messages are saved together." }),
    ],
  },
  {
    id: "see-auto-settings",
    title: "See a server's automatic settings",
    blurb: "The profiles that switch a server's settings, and its timed lines in each round.",
    keywords: ["automation", "profiles", "player count", "schedule settings"],
    caps: ["autosettings.profiles"],
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.settings", target: { nav: "autosettings" } },
      { text: "Open the Server settings tab.", route: "autosettings.settings", target: { tab: "Server settings" } },
      { text: "Profiles: the settings the server switches to at a time of day, or at a player count.", route: "autosettings.settings", target: { panel: "Profiles" } },
      { text: "Timed match messages are sent to players at set times in each round. Without the permission, a change is sent for approval.", route: "autosettings.settings", target: { panel: "Timed match messages" } },
    ],
  },
  {
    id: "game-rewards",
    title: "Reward players for playing",
    blurb: "What players earn for playing on a server.",
    keywords: ["rewards", "points", "vip for playing"],
    caps: ["autosettings.profiles"],
    capLevel: "write",
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.gamerewards", target: { nav: "autosettings" } },
      { text: "Open the Game rewards tab.", route: "autosettings.gamerewards", target: { tab: "Game rewards" } },
      {
        text: "Each card has its own switch, and starts in dry run, which only records what it would pay. Live pays for real.", route: "autosettings.gamerewards",
        target: { panel: "Everyone at match end", css: '[role="group"][aria-label="Reward switches"]' },
      },
      {
        text: "Everyone at match end pays each player on when a long enough match ends, with the message they are sent.", route: "autosettings.gamerewards",
        target: { panel: "Everyone at match end" }, fields: ["Reward switches", "Only matches that run at least", "A player must have played at least", "Only when at least", "VIP hours", "Points", "Message"],
      },
      {
        text: "Top stats per match rewards the best players in each category when a match ends.", route: "autosettings.gamerewards", target: { panel: "Top stats per match" },
        fields: ["Reward switches", "Only matches with at least", "A player must play at least", "Message every player", "Only the winners", "Broadcast each", "Don't broadcast", "Kills", "K/D", "Kills per minute", "Combat", "Offense", "Defense", "Support", "Teamplay", "Commander", "Vehicles destroyed", "VIP hours", "Points", "Leave blank", "Message to each winner"],
      },
      {
        text: "In a category, each place is paid its own reward. + Add a place pays one more place, and ✕ takes one off.", route: "autosettings.gamerewards",
        target: { panel: "Top stats per match", button: "+ Add a place" },
      },
      {
        text: "Best squads per match rewards the best squad of each kind, every member of it.", route: "autosettings.gamerewards", target: { panel: "Best squads per match", button: "+ Add a place" },
        fields: ["Reward switches", "Only matches with at least", "A member must play at least", "A squad needs at least", "Rank squads by", "How a squad's score is counted", "Message every player", "Only the winning squads", "Broadcast each", "Don't broadcast", "Infantry squads", "Armor", "Recon teams", "Artillery squads", "Mortar platoons", "Helicopter platoons", "VIP hours", "Points", "Leave blank", "Message to each member"],
      },
      {
        text: "Kill streaks rewards kills without dying, at each tier you add with + Add a tier.", route: "autosettings.gamerewards", target: { panel: "Kill streaks", button: "+ Add a tier" },
        fields: ["Reward switches", "Only while at least", "kills", "VIP hours", "Points", "Leave blank", "Message"],
      },
      {
        text: "Days played in a row rewards players who come back day after day, at each tier of days.", route: "autosettings.gamerewards", target: { panel: "Days played in a row", button: "+ Add a tier" },
        fields: ["Reward switches", "A day counts after", "days", "VIP hours", "Points", "Leave blank", "After the last tier", "Message"],
      },
      {
        text: "Days seeding in a row rewards players who help fill the server, day after day.", route: "autosettings.gamerewards", target: { panel: "Days seeding in a row", button: "+ Add a tier" },
        fields: ["Reward switches", "days", "VIP hours", "Points", "Leave blank", "After the last tier", "Message"],
      },
      saveOrDiscard("autosettings.gamerewards", "Game rewards", { text: "Press Save, on the Game rewards panel at the top. Discard puts back what was last saved." }),
    ],
  },
  {
    id: "see-game-rewards",
    title: "See what players earn for playing",
    blurb: "The rewards a server gives for playing, and who was given them lately.",
    keywords: ["rewards", "points for playing", "streaks", "vip for playing"],
    caps: ["autosettings.profiles"],
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.gamerewards", target: { nav: "autosettings" } },
      { text: "Open the Game rewards tab.", route: "autosettings.gamerewards", target: { tab: "Game rewards" } },
      { text: "Each kind of reward has its own switch, such as one for everyone who plays a whole match.", route: "autosettings.gamerewards", target: { panel: "Everyone at match end" } },
      { text: "Recent rewards lists who was given what, and when. Pick a kind to see only those.", route: "autosettings.gamerewards", target: { panel: "Recent rewards" }, fields: ["Top stats", "Best squads", "Match end", "Kill streaks", "Days played", "Days seeding"] },
    ],
  },
  {
    id: "auto-templates",
    title: "Save a server's setup as a template",
    blurb: "Keep a server's automatic settings under a name, for any server.",
    keywords: ["template", "copy settings"],
    caps: ["autosettings.templates"],
    capLevel: "write",
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.settings", target: { nav: "autosettings" } },
      { text: "Open the Server settings tab.", route: "autosettings.settings", target: { tab: "Server settings" } },
      { text: "Name it and press Save current as template, to keep this server's setup for any server later.", route: "autosettings.settings", target: { panel: "Templates", button: "Save current as template" }, fields: ["template name"] },
      { text: "Pick a template and press Apply to this server. ✕ beside one in the list deletes it.", route: "autosettings.settings", target: { panel: "Templates", button: "Apply to this server" }, fields: ["Template to apply"] },
    ],
  },
  {
    id: "seeding",
    title: "Set up seeding",
    blurb: "Rules while a server fills up, and when it counts as live.",
    keywords: ["seed", "populate", "fill up", "low population"],
    caps: ["seeding.config"],
    capLevel: "write",
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.seeding", target: { nav: "autosettings" } },
      { text: "Open the Seeding tab.", route: "autosettings.seeding", target: { tab: "Seeding" } },
      { text: "Seed target is how many players make the server live. Below it, the seeding rules apply.", route: "autosettings.seeding", target: { panel: "Population thresholds", field: "Seed target" }, fields: ["Min players"] },
      {
        text: "Phase stability holds a change between seeding and live until it lasts.", route: "autosettings.seeding",
        target: { panel: "Phase stability" }, fields: ["Confirm delay", "Hysteresis"],
      },
      { text: "Check speed: how often the server is checked, and how often while it is seeding.", route: "autosettings.seeding", target: { panel: "Check speed" }, fields: ["Check the server every", "Fast check while seeding"] },
      { text: "Press a role to keep seeders off it, such as tanks or artillery, and press it again to allow it.", route: "autosettings.seeding", target: { panel: "Disallowed roles while seeding", css: ".chip-btn" } },
      { text: "Disallowed weapons: whole families and single guns, and Extra weapons for any the chips leave out.", route: "autosettings.seeding", target: { panel: "Disallowed weapons while seeding" }, fields: ["Extra weapons"] },
      {
        text: "Open a family to block a single gun: press it to block it, and again to allow it.", route: "autosettings.seeding",
        before: [{ click: { panel: "Disallowed weapons while seeding", css: ".weapon-group summary" } }], target: { panel: "Disallowed weapons while seeding", css: ".weapon-group .chip-btn" },
      },
      { text: "Select all blocks a whole family, guns added to it later too. Clear all allows it again.", route: "autosettings.seeding", target: { panel: "Disallowed weapons while seeding", css: ".weapon-group > button" } },
      { text: "Anyone breaking them is warned, then punished, then kicked. Set the messages and how many of each.", route: "autosettings.seeding", target: { panel: "Escalation — warnings" }, fields: ["Max warnings", "Warn interval", "Warn message"] },
      { text: "Immunity: who seeding leaves alone, by level or by a tag on their name.", route: "autosettings.seeding", target: { panel: "Immunity" }, fields: ["Immune at/below level", "Immune tags"] },
      { text: "Announcement: what each player who joins while seeding is told.", route: "autosettings.seeding", target: { panel: "Announcement" }, fields: ["Message for each player"] },
      { text: "Enable seeding automation is the master switch for this server's seeding rules and rewards.", route: "autosettings.seeding", target: { setting: "Enable seeding automation" } },
      { text: "Dry-run records what seeding would do, and does none of it, until you switch it to Live.", route: "autosettings.seeding", target: { setting: "Dry-run" } },
      {
        text: "Cap fight: while the server fills, the winning team may hold the middle but not push on.", route: "autosettings.seeding", target: { panel: "Cap fight (warfare)" },
        fields: ["Block attacking the next point", "Team counts as winning at", "Skip warnings", "How the rule is worded"],
      },
      { text: "After the warnings come punishes, then a kick. Set how many of each, and what the player is told.", route: "autosettings.seeding", target: { panel: "Escalation — punishes & kick" }, fields: ["Max punishes", "Punish interval", "Punish message", "Kick after max punishes", "Kick message"] },
      savedSetups("autosettings.seeding"),
      { text: "Press Save, at the top of the page, to keep every change at once.", route: "autosettings.seeding", target: { button: "Save" } },
      { text: "Save seeding config, at the foot of the page, saves every change above at once.", route: "autosettings.seeding", target: { button: "Save seeding config" } },
      {
        text: "Discard, beside it once something has changed, puts back what was last saved.", route: "autosettings.seeding",
        before: [{ fill: { panel: "Population thresholds", field: "Seed target" }, value: "41" }], target: { button: "Discard" },
      },
    ],
  },
  {
    id: "see-seeding",
    title: "See how seeding is set up",
    blurb: "When a server counts as live, and what is not allowed until then.",
    keywords: ["seed", "seeding rules", "populate", "low population"],
    caps: ["seeding.config"],
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.seeding", target: { nav: "autosettings" } },
      { text: "Open the Seeding tab.", route: "autosettings.seeding", target: { tab: "Seeding" } },
      { text: "Population thresholds: how many players make the server live. Below that, the seeding rules apply.", route: "autosettings.seeding", target: { panel: "Population thresholds" } },
      { text: "The roles not allowed while seeding. Whoever plays one is warned, then punished, then kicked.", route: "autosettings.seeding", target: { panel: "Disallowed roles while seeding" } },
      { text: "Immunity: the players seeding leaves alone. Without the permission, a change is sent for approval.", route: "autosettings.seeding", target: { panel: "Immunity" } },
    ],
  },
  {
    id: "seed-reward",
    title: "Reward the players who seed",
    blurb: "VIP time or points for everyone who helped a server fill up.",
    keywords: ["seeders", "reward", "vip"],
    caps: ["seeding.rewards"],
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.seeding", target: { nav: "autosettings" } },
      { text: "Open the Seeding tab.", route: "autosettings.seeding", target: { tab: "Seeding" } },
      { text: "Seed reward gives VIP time or points to everyone who stayed to seed. Set how much of each.", route: "autosettings.seeding", target: { panel: "Seed reward", field: "VIP duration" } },
      { text: "Minimum seed time is how long someone must seed to earn it.", route: "autosettings.seeding", target: { panel: "Seed reward", field: "Minimum seed time" } },
      {
        text: "Reward seeders switches it on. Set the points, how soon a seeder can be paid again, and the message.", route: "autosettings.seeding",
        target: { panel: "Seed reward", setting: "Reward seeders" }, fields: ["Reward seeders", "Points", "Don't pay the same seeder again", "Cumulative VIP", "Reward message", "Currency note"],
      },
      { text: "A last seed that went unpaid says so. Pay last seed pays everyone who met the minimum, as it would have.", route: "autosettings.seeding", target: { panel: "Seed reward", button: "Pay last seed" } },
      { text: "One paid to only some says how many are owed, and Retry pays just those.", route: "autosettings.seeding", stage: "seed-owed", target: { panel: "Seed reward", button: "Retry" } },
      { text: "Add a bridge server pays seeders VIP on another of your servers too.", route: "autosettings.seeding", target: { panel: "Seed reward", button: "Add a bridge server" } },
      {
        text: "Pick the server and the hours of VIP it gives. Remove takes it off again.", route: "autosettings.seeding",
        before: [{ click: { panel: "Seed reward", button: "Add a bridge server" } }], target: { panel: "Seed reward", css: ".row:has(> select)" },
      },
      { text: "Recent seed payouts lists who was rewarded after each round that went live.", route: "autosettings.seeding", target: { panel: "Recent seed payouts" } },
    ],
  },
  {
    id: "automation-history",
    title: "Look back at what automation did",
    blurb: "Everything seeding and the auto settings did by themselves.",
    keywords: ["automation", "history", "log", "seeding"],
    caps: ["autosettings.profiles", "seeding.config"],
    group: "Automation",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.history", target: { nav: "autosettings" } },
      { text: "Open the History tab.", route: "autosettings.history", target: { tab: "History" } },
      { text: "Automation history lists what the panel did by itself, newest first, and to whom.", route: "autosettings.history", target: { panel: "Automation history" } },
      { text: "Press a kind, such as Seeding, to see only that. Press it again to see everything.", route: "autosettings.history", target: { panel: "Automation history", css: ".chips .chip-btn" } },
      { text: "Rule narrows the list to what one rule did.", route: "autosettings.history", target: { panel: "Automation history", css: 'select[aria-label="Rule"]' }, caps: ["admin.moderation"] },
      { text: "Search a player, a rule or a detail. This server only keeps to the server picked at the top.", route: "autosettings.history", target: { panel: "Automation history", css: ".panel-actions" } },
    ],
  },
  {
    id: "discord-relay",
    title: "Send a server's alerts to Discord",
    blurb: "A Discord channel for a server's relay and its alerts.",
    keywords: ["alerts", "notifications", "channel", "webhook"],
    caps: ["discord.relay"],
    capLevel: "write",
    group: "Automation",
    steps: [
      { text: "Open Discord.", route: "discord.relay", target: { nav: "discord" } },
      { text: "Open the Relay & alerts tab.", route: "discord.relay", target: { tab: "Relay & alerts" } },
      { text: "Enable relay turns on posting this server's game events to Discord.", route: "discord.relay", target: { panel: "Relay & alerts", css: ".setting-card" } },
      {
        text: "Turn on each kind of event to post, and paste the Discord channel id it posts in.", route: "discord.relay", target: { panel: "Relay & alerts", css: 'input[placeholder="Channel id"]' },
        fields: ["Admin", "Chat", "Kills", "Connections", "Match", "Ping role", "Team kills only", "Include every vote cast"],
      },
      {
        text: "Ping alerts post at once and can ping a role: a call for an admin, a watched player joining, a rule firing, the server going dark.", route: "discord.relay",
        target: { panel: "Relay & alerts", field: "Chat trigger" },
        fields: ["Admin requests", "Chat trigger", "Channel id", "Ping role id", "Watchlist joins", "Player rules firing", "Server went dark"],
      },
      saveOrDiscard("discord.relay", "Relay & alerts"),
      { text: "Test posts a sample to the channel, to check it arrives.", route: "discord.relay", target: { panel: "Relay & alerts", button: "Test" } },
      {
        text: "Live match board keeps one post up to date with the round in play: its channel, its title, and how often it is redrawn.", route: "discord.relay",
        target: { panel: "Live match board", css: ".setting-card" }, fields: ["Channel id", "Board title", "Update every"],
      },
      saveOrDiscard("discord.relay", "Live match board", { text: "The board has its own Save, and its own Discard." }),
      { text: "Match board badge is your community's picture in the board's corner. Pick a file to replace it; Remove takes it away.", route: "discord.relay", target: { panel: "Match board badge", button: "Remove" }, fields: ["Replace the badge", "Upload a badge"] },
    ],
  },
  {
    id: "see-relay",
    title: "See what a server posts to Discord",
    blurb: "The game events a server posts to Discord, and its live match board.",
    keywords: ["relay", "alerts", "notifications", "match board", "channel"],
    caps: ["discord.relay"],
    group: "Automation",
    steps: [
      { text: "Open Discord.", route: "discord.relay", target: { nav: "discord" } },
      { text: "Open the Relay & alerts tab.", route: "discord.relay", target: { tab: "Relay & alerts" } },
      { text: "Relay & alerts: each kind of game event this server posts, and the channel it goes to.", route: "discord.relay", target: { panel: "Relay & alerts" } },
      { text: "Live match board: one post in Discord, kept up to date with the round in play.", route: "discord.relay", target: { panel: "Live match board" } },
    ],
  },
  {
    id: "message-templates",
    title: "Keep ready-made messages and reasons",
    blurb: "The messages and reasons staff pick from instead of typing.",
    keywords: ["presets", "canned", "reasons", "messages"],
    caps: ["templates.manage"],
    group: "Automation",
    steps: [
      { text: "Open Administration.", route: "admin.templates", target: { nav: "admin" } },
      { text: "Open the Templates tab.", route: "admin.templates", target: { tab: "Templates" } },
      { text: "Templates are the messages and reasons staff pick from, by kind. Change one's words in its box, and it saves.", route: "admin.templates", target: { panel: "Templates" }, fields: ["Template"] },
      { text: "Type a new one under its kind, and press Add.", route: "admin.templates", target: { panel: "Templates", css: 'input[placeholder^="Add a"]' } },
      {
        text: "Signatures are added to the end of what players are sent: a staff member's name, and a second line such as your Discord.", route: "admin.templates",
        target: { panel: "Signatures" }, fields: ["Staff signature", "Second signature", "Sign with staff name", "Add the second line"],
      },
      { text: "Press Save, which shows once something has changed.", route: "admin.templates", before: [{ click: { panel: "Signatures", css: "td label.toggle" } }], target: { panel: "Signatures", css: ".panel-actions" } },
      { text: "Press Add to keep a new one.", route: "admin.templates", target: { panel: "Templates", button: "Add" } },
      { text: "Delete takes one away. Staff stop seeing it at once.", route: "admin.templates", target: { panel: "Templates", button: "Delete" } },
    ],
  },

  // ---------------------------------------------------------------------------- analytics ----
  {
    id: "analytics-server", title: "See how busy a server is", blurb: "When people play, who comes back, and how the server is doing.",
    keywords: ["stats", "statistics", "population", "busy"],
    caps: ["analytics.server"], group: "Analytics",
    steps: [
      ...analytics("server", "Server", [
        ["When people play shows the busy and the quiet hours of each day of the week.", { panel: "When people play" }, ["Show"]],
        ["New vs returning shows how many players are new, and how many come back.", { panel: "New vs returning" }],
      ]),
      { text: "One event's own numbers are on Events, under Report: who came, the rounds and who led.", route: "events.report", target: { nav: "events" } },
    ],
  },
  {
    id: "analytics-match", title: "See how rounds go", blurb: "How long rounds run on each map, and which side wins.",
    keywords: ["stats", "rounds", "win rate", "maps"],
    caps: ["analytics.match"], group: "Analytics",
    steps: [
      ...analytics("match", "Matches", [
        ["Per map compares the maps: how long rounds run, and which side wins.", { panel: "Per map" }],
        ["Showing, above it, keeps to maps played enough to compare. Press it to show every map.", { panel: "Per map", button: "Showing" }],
        ["Outcomes over time shows each day's rounds and which side won them. Last…, or All, picks how far back it draws.", { panel: "Outcomes over time" }, ["Window"]],
      ]),
      { text: "One event's own numbers are on Events, under Report: who came, the rounds and who led.", route: "events.report", target: { nav: "events" } },
    ],
  },
  {
    id: "analytics-player", title: "See who plays", blurb: "The players as a whole, and one player against the rest.",
    keywords: ["stats", "players"],
    caps: ["analytics.player"], group: "Analytics",
    steps: analytics("player", "Players", [
      ["Look up a player: search for one by name to see their numbers beside everyone else's.", { panel: "Look up a player" }, ["Search a player"]],
      ["Showing, in The population, picks one server's players, or every server's added together.", { panel: "The population", css: ".scope-picker" }],
      ["Where players come from shows the platforms they play on, day by day. Last…, or All, picks how far back it draws.", { panel: "Where players come from" }, ["Window"]],
    ]),
  },
  {
    id: "analytics-combat", title: "See what the fighting looks like", blurb: "Weapons, team kills and who does the killing.",
    keywords: ["stats", "kills", "weapons", "team kills"],
    caps: ["analytics.combat"], group: "Analytics",
    steps: analytics("combat", "Combat", [
      ["What kills people shows the weapons and roles doing the killing.", { panel: "What kills people" }],
      ["Showing, above Per weapon, keeps to weapons with enough kills to compare. Press it for every weapon.", { panel: "Per weapon", button: "Showing" }],
      ["Team kills by player ranks who team kills the most.", { panel: "Team kills by player" }],
      ["Over time shows the kills and team kills of each day. Last…, or All, picks how far back it draws.", { panel: "Over time" }, ["Window"]],
    ]),
  },
  {
    id: "analytics-composition", title: "See team balance and roles", blurb: "How even the teams are, and which roles get played.",
    keywords: ["stats", "balance", "roles", "classes"],
    caps: ["analytics.composition"], group: "Analytics",
    steps: analytics("composition", "Composition", [
      ["Side balance shows how even the two teams were.", { panel: "Side balance" }],
      ["Leaderless squads over time shows how often squads played without a leader.", { panel: "Leaderless squads over time" }],
    ]),
  },
  {
    id: "analytics-announcements", title: "See who your announcements reach", blurb: "How many staff have read each announcement.",
    keywords: ["read receipts", "notices"],
    caps: ["analytics.announcements"], group: "Analytics",
    steps: [
      { text: "Open Analytics.", route: "analytics.announcements", target: { nav: "analytics" } },
      { text: "Open the Announcements tab.", route: "analytics.announcements", target: { tab: "Announcements" } },
      { text: "Reach shows how many staff have seen each announcement.", route: "analytics.announcements", target: { panel: "Reach" } },
    ],
  },
  {
    id: "analytics-staff", title: "See the staff team's work", blurb: "Who does what, how long players wait, and the cover across the week.",
    keywords: ["stats", "moderators", "activity"],
    caps: ["analytics.staff"], group: "Analytics",
    steps: analytics("staff", "Staff", [
      ["How long players wait shows how long a call for an admin goes unanswered.", { panel: "How long players wait" }],
      ["Showing, in The team, picks one server's work, or every server's added together.", { panel: "The team", css: ".scope-picker" }],
      ["Workload over time shows how much staff did each day. Last…, or All, picks how far back it draws.", { panel: "Workload over time" }, ["Window"]],
      [
        "Under Per person, Roles keeps to members of the roles picked. Clear brings everyone back.", { panel: "Per person", css: '.control-row:has(> [role="group"][aria-label="Filter by role"])' }, undefined,
        [{ click: { panel: "Per person", button: "Roles" } }, { click: { panel: "Per person", css: ".seg-btn" } }],
      ],
      ["Cover across the week shows the hours with staff about, and the hours without.", { panel: "Cover across the week" }],
    ]),
  },
  {
    id: "analytics-mapvote", title: "See how map votes go", blurb: "Which maps are offered, how often they win, and the turnout.",
    keywords: ["stats", "votes"],
    caps: ["analytics.mapvote"], group: "Analytics",
    steps: analytics("mapvote", "Map votes", [
      ["Per map shows how often each map is offered, and how often it wins.", { panel: "Per map" }],
      ["Showing, above it, keeps to maps offered enough to compare. Press it for every map.", { panel: "Per map", button: "Showing" }],
      ["Turnout over time shows how many players vote. Last…, or All, picks how far back it draws.", { panel: "Turnout over time" }, ["Window"]],
    ]),
  },

  // ------------------------------------------------------------------------ administration ----
  {
    id: "staff-trail",
    title: "Look back at what staff did",
    blurb: "Everything staff did: who, what, to whom, and when.",
    keywords: ["audit", "log", "history", "who did"],
    caps: ["audit.trail"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.activity", target: { nav: "admin" } },
      { text: "Open the Staff activity tab.", route: "admin.activity", target: { tab: "Staff activity" } },
      { text: "Trail lists everything staff did, here or through the Discord bot: who did it, what, and to whom.", route: "admin.activity", target: { panel: "Trail" }, fields: ["Search actions"] },
      { text: "Press an action, or anywhere on its row, to see exactly what it did.", route: "admin.activity", target: { panel: "Trail", css: "button.audit-action" } },
      {
        text: "A saved setting shows where it sits, what it was, and what it became. Everything else the action kept is under Details.", route: "admin.activity",
        before: [{ click: { panel: "Trail", css: "button.audit-action", nth: 2 } }], target: { dialog: true, css: ".audit-changes" },
      },
      { text: "Moderation has a tab for each kind of action too. Open the Kicks tab: every kick, and who made it.", route: "moderation.kicks", target: { tab: "Kicks" } },
      { text: "Each of those lists is newest first. Search it by player, reason or staff member.", route: "moderation.kicks", target: { panel: "Kicks", css: "input.search-input" } },
      { text: "Open the Punishments tab: every punish, by hand, by a rule or by seeding, and who gave it.", route: "moderation.punishments", target: { panel: "Punishments" }, fields: ["Search player"] },
      { text: "Open the Switches tab: every player staff moved to the other team.", route: "moderation.switches", target: { panel: "Team switches" }, fields: ["Search player"] },
      { text: "Open the Warnings tab: every message sent to one player.", route: "moderation.warnings", target: { panel: "Warnings" }, fields: ["Search player"] },
    ],
  },
  {
    id: "staff-profiles",
    title: "See a staff member's work",
    blurb: "Each staff member, and what they have done.",
    keywords: ["moderators", "admins", "staff"],
    caps: ["staff.profiles"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.activity", target: { nav: "admin" } },
      { text: "Open the Staff activity tab.", route: "admin.activity", target: { tab: "Staff activity" } },
      { text: "The team lists each staff member who acted in the time picked, with how much they did.", route: "admin.activity", target: { panel: "The team" } },
      { text: "Press a name to open their profile: what they did, and when.", route: "admin.activity", target: { panel: "The team", css: "button.player-link" } },
      { text: "Showing picks one server's work, or every server's added together.", route: "admin.activity", target: { panel: "The team", css: ".scope-picker" } },
      {
        text: "Roles keeps to the members of the roles picked, and Clear brings everyone back.", route: "admin.activity",
        before: [{ click: { panel: "The team", button: "Roles" } }, { click: { panel: "The team", css: ".seg-btn" } }], target: { panel: "The team", css: '.control-row:has(> [role="group"][aria-label="Filter by role"])' },
      },
      { text: "Totals: how much they did, of which kinds, and on how many players and servers.", route: "admin.activity", before: OPEN_STAFF, target: { panel: "Totals" } },
      { text: "Showing, at the top of their page, picks one server's actions, or every server's.", route: "admin.activity", before: OPEN_STAFF, target: { css: ".scope-picker" } },
      { text: "🔗 Copy profile link copies a link that opens this page, to send to someone.", route: "admin.activity", before: OPEN_STAFF, target: { button: "🔗 Copy profile link" } },
      { text: "Press Actions for each thing they did, newest first.", route: "admin.activity", before: OPEN_STAFF, target: { button: "Actions" } },
      {
        text: "Narrow the list to one kind of action, or to dates.", route: "admin.activity",
        before: [...OPEN_STAFF, { click: { button: "Actions" } }], target: { panel: "Actions", css: "select" },
      },
      {
        text: "Press an action, or anywhere on its row, to see exactly what it did.", route: "admin.activity",
        before: [...OPEN_STAFF, { click: { button: "Actions" } }], target: { panel: "Actions", css: "button.audit-action" },
      },
    ],
  },
  {
    id: "request-history",
    title: "Look back at every request",
    blurb: "Every finished request: who asked, who decided, and why.",
    keywords: ["approvals", "requests"],
    caps: ["moderation.requests.history"],
    group: "Administration",
    steps: [
      { text: "Open Moderation.", route: "moderation.requests", target: { nav: "moderation" } },
      { text: "Open the Requests tab.", route: "moderation.requests", target: { tab: "Requests" } },
      { text: "All request history lists every finished request: who asked, who approved or denied it, and why.", route: "moderation.requests", target: { panel: "All request history" }, fields: ["Filter by player"] },
    ],
  },
  {
    id: "post-notice",
    title: "Post a notice for staff",
    blurb: "A notice on the staff board, for everyone on the team.",
    keywords: ["announcement", "notice", "board", "news"],
    caps: ["community.edit"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Announcements.", route: "community", target: { nav: "community" } },
      { text: "Give the notice a title, and write it below.", route: "community", target: { panel: "Post a notice", field: "Title" }, fields: ["Body"] },
      { text: "Turn off Post immediately to keep it as a draft for now.", route: "community", target: { panel: "Post a notice", field: "Post immediately" } },
      { text: "Press Add notice. Staff are told there is something new.", route: "community", target: { panel: "Post a notice", button: "Add notice" } },
      { text: "Under Notices, Edit opens a notice to change its title and words.", route: "community", target: { panel: "Notices", button: "Edit" } },
      { text: "Change its Title and Body, then press Save.", route: "community", before: [{ click: { panel: "Notices", button: "Edit" } }], target: { panel: "Notices", button: "Save" }, fields: ["Title", "Body"] },
      { text: "Unpost takes a notice down without deleting it. On a draft, Post puts it up.", route: "community", target: { panel: "Notices", css: ".subcard > .actions > button:nth-child(2)" } },
      { text: "Delete removes a notice, after asking.", route: "community", target: { panel: "Notices", button: "Delete" } },
    ],
  },
  {
    id: "see-nudge",
    title: "See the reminder about unread notices",
    blurb: "The reminder in Discord for staff who have not read the latest notices.",
    keywords: ["remind", "reminder", "unread", "nudge"],
    caps: ["community.edit"],
    group: "Administration",
    steps: [
      { text: "Open Discord.", route: "discord.relay", target: { nav: "discord" } },
      { text: "Open the Relay & alerts tab.", route: "discord.relay", target: { tab: "Relay & alerts" } },
      { text: "Unread-notice nudge reminds staff in Discord who still have not opened the latest notices.", route: "discord.relay", target: { panel: "Unread-notice nudge" } },
    ],
  },
  {
    id: "set-nudge",
    title: "Remind staff about unread notices",
    blurb: "A reminder in Discord for staff who have not read the latest notices.",
    keywords: ["remind", "reminder", "unread", "nudge"],
    caps: ["community.edit"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Discord.", route: "discord.relay", target: { nav: "discord" } },
      { text: "Open the Relay & alerts tab.", route: "discord.relay", target: { tab: "Relay & alerts" } },
      {
        text: "Unread-notice nudge: switch it on, give the channel, and how many hours to wait before reminding.", route: "discord.relay", target: { panel: "Unread-notice nudge" },
        fields: ["Enable nudge", "Excused staff"],
      },
      saveOrDiscard("discord.relay", "Unread-notice nudge"),
    ],
  },
  {
    id: "see-rules",
    title: "See the rules that act by themselves",
    blurb: "The rules that message, punish, kick or ban without anyone pressing.",
    keywords: ["automod", "automation", "auto moderation"],
    caps: ["admin.moderation"],
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.rules", target: { nav: "autosettings" } },
      { text: "Open the Rules tab.", route: "autosettings.rules", target: { tab: "Rules" } },
      { text: "Every rule for this server: what sets it off, and what it does then.", route: "autosettings.rules", target: { panel: "Rules" } },
      { text: "Open the History tab to see what each rule did, and to whom.", route: "autosettings.history", target: { tab: "History" } },
    ],
  },
  {
    id: "make-rule",
    title: "Make a rule that acts by itself",
    blurb: "A rule that deals with team kills, chat, idling and more, unattended.",
    keywords: ["automod", "automation", "auto moderation", "trigger"],
    caps: ["admin.moderation"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.rules", target: { nav: "autosettings" } },
      { text: "Open the Rules tab.", route: "autosettings.rules", target: { tab: "Rules" } },
      { text: "Press New rule.", route: "autosettings.rules", target: { button: "New rule" } },
      {
        text: "Name it, and choose where it applies: one server, or every one. Section, if you keep them, files it.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Name" },
        fields: ["Applies to", "Section"],
      },
      {
        text: "Choose what sets it off: a team kill, a chat message, a player joining, and more.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "On event" },
      },
      {
        text: "Match is the words that set it off, in chat or the game log. Threshold and Window ask for so many times in so many seconds.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Match (optional regex)" },
        fields: ["Threshold (matches)", "Window (seconds)", "Wait before acting (seconds)", "Count per match", "No kills for (seconds)", "Re-check interval (seconds)"],
      },
      {
        text: "Live roster checks who is on the server; pick the check in Live roster check: a squad, a level, a crew, a name, a kill rate, a ratio.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }, { fill: { panel: "New rule", field: "On event" }, value: "live roster — squads, levels, roles, names, kills and more" }], target: { panel: "New rule", field: "Live roster check" },
        fields: ["Live roster check", "Minimum squad size to enforce", "Minimum level to play", "Minimum level for these roles", "Banned words", "Blocked pattern", "Block adverts / URLs", "Minimum crew", "Zone set", "Forbid the painted cells", "Only after they've been on for", "Hours played", "Over the last", "Count every server", "Only once they have at least", "Kills per 10 minutes", "K/D at or above", "Find a clan tag", "Disallowed weapons", "Allowed weapons"],
      },
      {
        text: "A ratio sets two of a player's counts this match against each other: kills, deaths or team kills.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }, { fill: { panel: "New rule", field: "On event" }, value: "live roster — squads, levels, roles, names, kills and more" }, { fill: { panel: "New rule", field: "Live roster check" }, value: "ratio over or under a limit" }], target: { panel: "New rule", field: "Ratio" },
        fields: ["Ratio", "Fires when it is", "Limit", "Only once the two add up"],
      },
      {
        text: "Where it asks you to pick, such as roles, clan tags or days, press each one; ✓ marks those picked.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }, { fill: { panel: "New rule", field: "On event" }, value: "live roster — squads, levels, roles, names, kills and more" }, { fill: { panel: "New rule", field: "Live roster check" }, value: "level below minimum on chosen roles" }], target: { panel: "New rule", css: ".chips .chip-btn" },
      },
      {
        text: "A group change, or a date on the calendar, acts on a player group: pick the group, and when a calendar rule runs.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "On event" },
        fields: ["Group", "Repeat", "Day of the month", "Which", "Dates (comma-separated", "At (", "VIP to grant", "Cut back to (at most)", "Cut back by", "Stack onto the time they already have"],
      },
      {
        text: "Choose what it does, from a message to a ban, and the words the player sees.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Action" },
      },
      {
        text: "The action's own settings: how long VIP lasts and how often, a tag, points, a ban's hours, and the words sent.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Action" },
        fields: ["VIP for", "Once per player every", "Message after granting", "Tag to add", "Note on the tag", "Points to grant", "Message after paying", "Message after switching", "Ban hours", "Reason / message"],
      },
      {
        text: "+ escalate on repeat adds what happens the next time, such as a punish, then a kick. The last step repeats.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", button: "+ escalate on repeat" },
      },
      {
        text: "Only act on players tagged, and never on those tagged or at or below a level, keeps a rule off whoever it should spare.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Only act on players tagged" },
        fields: ["Never act on players tagged", "Never act at or below level"],
      },
      {
        text: "Only during set hours keeps it to a time of day. Active from and up to keep it to a number of players, or minutes of the match.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Active from (players" },
        fields: ["Only during set hours", "From", "Until", "Timezone", "Active up to", "Active from minute", "…until minute"],
      },
      {
        text: "At most sets how often it may act on one player, a match, a day or ever. Safety limit stops it acting on too many at once.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Safety limit" },
        fields: ["At most (times per player"],
      },
      {
        text: "Trial run records what the rule would do and touches nobody. Try a new rule that way first.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Trial run" },
      },
      {
        text: "Ping Discord when this rule fires posts each firing, to the channel id given here or the shared rules channel.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", field: "Ping Discord" },
        fields: ["Alert channel id"],
      },
      {
        text: "Press Create rule.", route: "autosettings.rules",
        before: [{ click: { button: "New rule" } }], target: { panel: "New rule", button: "Create rule" },
      },
      {
        ...savedSetups("autosettings.rules"),
      },
    ],
  },
  {
    id: "chat-filter",
    title: "Filter words in chat",
    blurb: "Words that, said in chat, get the player a message, a kick or a ban.",
    keywords: ["profanity", "swear", "slurs", "bad words", "language", "censor"],
    caps: ["moderation.chatfilter"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.chatfilter", target: { nav: "autosettings" } },
      { text: "Open the Chat filter tab.", route: "autosettings.chatfilter", target: { tab: "Chat filter" } },
      { text: "Watched words is the list to look out for in team and unit chat, a word or a short phrase a line.", route: "autosettings.chatfilter", target: { panel: "Watched words" }, fields: ["one word or short phrase"] },
      { text: "Its switch acts on whoever says one. Choose the action, the hours if it bans, and the words they are sent.", route: "autosettings.chatfilter", target: { panel: "Act on players", field: "Action" }, fields: ["Act when a watched word", "Ban hours", "Reason / message"] },
      { text: "Press Save chat filter.", route: "autosettings.chatfilter", target: { button: "Save chat filter" } },
      { text: "Game censor's switch also adds the list to each server's own banned words, which the game stars out for everyone.", route: "autosettings.chatfilter", target: { panel: "Game censor" }, fields: ["Also add the list"] },
    ],
  },
  {
    id: "see-chat-filter",
    title: "See the words watched in chat",
    blurb: "The words looked out for in chat, and what happens to whoever says one.",
    keywords: ["profanity", "swear", "slurs", "bad words", "censor"],
    caps: ["moderation.chatfilter"],
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.chatfilter", target: { nav: "autosettings" } },
      { text: "Open the Chat filter tab.", route: "autosettings.chatfilter", target: { tab: "Chat filter" } },
      { text: "Watched words: the list looked out for in team and unit chat.", route: "autosettings.chatfilter", target: { panel: "Watched words" } },
      { text: "Act on players: what happens to whoever says one. Without the permission, a change is sent for approval.", route: "autosettings.chatfilter", target: { panel: "Act on players" } },
    ],
  },
  {
    id: "manage-rules",
    title: "Switch, pause or tidy the rules",
    blurb: "Turn a rule off or hold it a while, file rules in sections, bring one back.",
    keywords: ["disable rule", "pause rule", "sections", "duplicate rule", "deleted rules", "rule history", "restore"],
    caps: ["admin.moderation"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.rules", target: { nav: "autosettings" } },
      { text: "Open the Rules tab.", route: "autosettings.rules", target: { tab: "Rules" } },
      { text: "Disable stops a rule, and Enable starts it again.", route: "autosettings.rules", target: { panel: "Rules", css: ".subcard > .row > .actions > button:first-child" } },
      { text: "Pause holds a rule for a while, and Cancel pause closes it without pausing.", route: "autosettings.rules", target: { panel: "Rules", css: 'button[title^="Hold this rule"]' } },
      {
        text: "Pick how long, say why, then press Pause. It switches itself back on when the time is up.", route: "autosettings.rules",
        before: [{ click: { panel: "Rules", css: 'button[title^="Hold this rule"]' } }], target: { panel: "Rules", css: ".rule-pause-form button.primary" }, fields: ["30 minutes", "2 hours", "Until", "Why"],
      },
      { text: "A paused rule says until when, and why. Resume now ends the pause early.", route: "autosettings.rules", target: { panel: "Rules", button: "Resume now" } },
      { text: "Edit opens a rule's settings, the same as a new rule's.", route: "autosettings.rules", target: { panel: "Rules", button: "Edit" } },
      { text: "Duplicate starts a new rule from a copy of this one.", route: "autosettings.rules", target: { panel: "Rules", css: 'button[title^="Start a new rule from a copy"]' } },
      { text: "History lists each saved change to a rule, and Close history folds it away.", route: "autosettings.rules", target: { panel: "Rules", css: 'button[title^="Every saved change"]' } },
      {
        text: "Restore the version before this goes back one change.", route: "autosettings.rules",
        before: [{ click: { panel: "Rules", button: "History" } }], target: { panel: "Rules", button: "Restore the version before this" },
      },
      { text: "Delete takes a rule away, after asking.", route: "autosettings.rules", target: { panel: "Rules", button: "Delete" } },
      { text: "Recently deleted lists the rules taken away lately, and Hide deleted rules folds the list.", route: "autosettings.rules", target: { panel: "Rules", css: 'button[title^="Rules deleted lately"]' } },
      {
        text: "Rules pinned to another server are left out of this one's list. Show them lists them, and Show only this server's rules hides them.", route: "autosettings.rules",
        target: { css: ".recent-list + .actions > button" },
      },
      {
        text: "Restore brings one back as it was: on or off, in its section if that is still there.", route: "autosettings.rules",
        before: [{ click: { panel: "Rules", button: "Recently deleted" } }], target: { panel: "Recently deleted rules", button: "Restore" },
      },
      {
        text: "A section files rules under a heading. Its switch holds them all at once; Rename and Remove change it, and its rules stay.", route: "autosettings.rules",
        target: { panel: "Team play", css: ".panel-actions .control-row" },
      },
      {
        text: "Rename asks for the new name. Press Save to keep it.", route: "autosettings.rules",
        before: [{ click: { panel: "Team play", button: "Rename" } }], target: { panel: "Team play", button: "Save" }, fields: ["Section name"],
      },
      { text: "New section adds one.", route: "autosettings.rules", target: { panel: "Rules", button: "New section" } },
      {
        text: "Name it, then press Add section.", route: "autosettings.rules",
        before: [{ click: { panel: "Rules", button: "New section" } }], target: { panel: "Rules", button: "Add section" }, fields: ["Section name"],
      },
      { text: "View all lists every rule in one list, and Show by section puts the sections back.", route: "autosettings.rules", target: { panel: "Rules", css: ".card > .actions > button:first-child" } },
      { text: "Select rules files several at once, and Stop selecting ends it.", route: "autosettings.rules", target: { panel: "Rules", css: ".card > .actions > button:last-child" } },
      {
        text: "Tick the rules, pick a section under Move to, then press Move.", route: "autosettings.rules",
        before: [{ click: { panel: "Rules", button: "Select rules" } }], target: { panel: "Rules", css: ".rule-select-bar" }, fields: ["Select"],
      },
    ],
  },
  {
    id: "map-zones",
    title: "Keep players to parts of a map",
    blurb: "Parts of a map players must keep to, or keep out of.",
    keywords: ["zones", "areas", "boundaries", "out of bounds"],
    caps: ["moderation.zones"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.zones", target: { nav: "autosettings" } },
      { text: "Open the Map zones tab.", route: "autosettings.zones", target: { tab: "Map zones" } },
      { text: "A zone set marks parts of a map, painted once and used by any rule. Pick the game, name one and press Create.", route: "autosettings.zones", target: { panel: "Zone sets", button: "Create" }, fields: ["Game", "new set name"] },
      {
        text: "Pick a set to paint it, then the map. Paint as picks whose ground a square becomes: either team's, or Both teams.", route: "autosettings.zones",
        before: [{ click: { panel: "Zone sets", css: ".chips .chip-btn" } }], target: { panel: "Painting", css: ".row .chip-btn" }, fields: ["Map"],
      },
      {
        text: "Clear this map wipes its squares, and Save changes keeps them.", route: "autosettings.zones",
        before: [{ click: { panel: "Zone sets", css: ".chips .chip-btn" } }], target: { panel: "Painting", css: ".row > button:not(.chip-btn)" },
      },
      {
        text: "Press a square to paint it. Both teams marks ground either side may hold.", route: "autosettings.zones",
        before: [{ click: { panel: "Zone sets", css: ".chips .chip-btn" } }], target: { panel: "Painting", css: '[role="group"][aria-label="Zone sectors"]' },
      },
      { text: "Delete this set takes it away, once no rule uses it.", route: "autosettings.zones", before: [{ click: { panel: "Zone sets", css: ".chips .chip-btn" } }], target: { panel: "Painting", button: "Delete this set" } },
      { text: "On the Rules tab, a rule for players outside the allowed area keeps them inside the zones, or out of them.", route: "autosettings.rules", target: { tab: "Rules" }, caps: ["admin.moderation"] },
    ],
  },
  {
    id: "ground-rules",
    title: "Set the seeding ground rules",
    blurb: "Where seeders may go, the cap fight by position, and how fast attackers may push.",
    keywords: ["seeding zones", "front line", "steamroll", "positions", "learn layouts"],
    caps: ["admin.moderation"],
    capLevel: "write",
    needs: ["seeding.config"],
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.zones", target: { nav: "autosettings" } },
      { text: "Open the Map zones tab.", route: "autosettings.zones", target: { tab: "Map zones" } },
      { text: "Seeding zones: Off; Learn only, where the panel learns each map's lines and holds no one to them; or On.", route: "autosettings.zones", target: { button: "Learn only" } },
      {
        text: "Grace period: how long a seeder may stand on the other side's ground before the ladder. Stand down at ends it as the server fills.", route: "autosettings.zones",
        target: { panel: "Ground rules", field: "Grace period" }, fields: ["Stand down at", "How the rule is worded"],
      },
      {
        text: "Paint each layer's zones: choose the map and who the paint is for, then press the squares.", route: "autosettings.zones",
        target: { panel: "Ground rules", css: '[role="group"][aria-label="Seeding area sectors"]' }, fields: ["Map"],
      },
      { text: "Paint as picks whose ground a square becomes: either team's, or Both teams, free to both.", route: "autosettings.zones", target: { panel: "Ground rules", css: ".chip-btn" } },
      { text: "Also judge the cap fight by position catches a player past the front line, not only by their offense score.", route: "autosettings.zones", target: { setting: "Also judge the cap fight by position" } },
      {
        text: "Steamroll protection sets the earliest minute attackers may reach each point of an offensive round.", route: "autosettings.zones",
        target: { panel: "Ground rules", setting: "Steamroll protection" }, fields: ["Point"],
      },
      { text: "Press Save. These rules save on their own; the rest of seeding stays on its own tab.", route: "autosettings.zones", target: { button: "Save" } },
    ],
  },
  {
    id: "see-zones",
    title: "See the map zones",
    blurb: "The parts of maps marked out, for rules to keep players in or out of.",
    keywords: ["zones", "areas", "boundaries", "out of bounds"],
    caps: ["moderation.zones", "admin.moderation"],
    group: "Administration",
    steps: [
      { text: "Open Auto settings.", route: "autosettings.zones", target: { nav: "autosettings" } },
      { text: "Open the Map zones tab.", route: "autosettings.zones", target: { tab: "Map zones" } },
      { text: "Zone sets: parts of maps marked out once, for any rule to use, and the rules that use each.", route: "autosettings.zones", target: { panel: "Zone sets" } },
    ],
  },
  {
    id: "see-data-sizes",
    title: "See how much old data is kept",
    blurb: "How much of the game's history the panel is holding, by kind.",
    keywords: ["storage", "disk", "size"],
    caps: ["admin.trim"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.trim", target: { nav: "admin" } },
      { text: "Open the Data trim tab.", route: "admin.trim", target: { tab: "Data trim" } },
      { text: "Choose an age, and press Check sizes to see how much of each kind is older than that.", route: "admin.trim", target: { panel: "Data trim", button: "Check sizes" } },
    ],
  },
  {
    id: "trim-data",
    title: "Trim old data",
    blurb: "Let go of old kills, chat and snapshots to keep the database small.",
    keywords: ["delete", "clean up", "storage", "disk"],
    caps: ["admin.trim"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.trim", target: { nav: "admin" } },
      { text: "Open the Data trim tab.", route: "admin.trim", target: { tab: "Data trim" } },
      { text: "Choose how old data must be to go, in days, or press 30d, 90d, 180d or 365d.", route: "admin.trim", target: { panel: "Data trim", field: "Older than" }, fields: ["30d", "90d", "180d", "365d"] },
      {
        text: "Tick each kind to trim: the game's events, such as kills and chat, and the records the panel keeps, such as play sessions.", route: "admin.trim",
        target: { panel: "Data trim", field: "Kills" }, fields: ["Joins and leaves", "Kills", "Team kills", "Chat", "Team switches", "In-game votes", "Moderation in game", "Match start and end", "Roster snapshots", "Play sessions", "Match history", "Map-vote history", "Admin camera sessions", "IP history", "Name and clan-tag history", "Staff activity", "Plugin key-value rows"],
      },
      { text: "Keep Write a backup first on. The trim cannot be undone, and the backup is the only copy left.", route: "admin.trim", target: { panel: "Data trim", field: "Write a backup first" } },
      { text: "Press Trim.", route: "admin.trim", target: { panel: "Data trim", button: "Trim" } },
      { text: "Last-seen clocks: Check finds players marked as seen later than any record of them.", route: "admin.trim", target: { panel: "Last-seen clocks", button: "Check" } },
      { text: "Repair puts those clocks back. It never moves one forward, so it is safe to run any time.", route: "admin.trim", target: { panel: "Last-seen clocks", button: "Repair" } },
    ],
  },
  {
    id: "see-backups",
    title: "Find the panel's backups",
    blurb: "Where the panel's backups are made and kept.",
    keywords: ["restore", "backup"],
    caps: ["admin.data"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.backup", target: { nav: "admin" } },
      { text: "Open the Backup tab.", route: "admin.backup", target: { tab: "Backup" } },
      { text: "Full backup is a copy of everything, which can be put back whole. One can be made by itself each night, too.", route: "admin.backup", target: { panel: "Full backup" } },
    ],
  },
  {
    id: "make-backup",
    title: "Back up the panel",
    blurb: "A copy of everything now, or a file of just the parts you pick.",
    keywords: ["export", "save", "restore"],
    caps: ["admin.data"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.backup", target: { nav: "admin" } },
      { text: "Open the Backup tab.", route: "admin.backup", target: { tab: "Backup" } },
      { text: "Press Create full backup now for a copy of everything. Do it before any big change.", route: "admin.backup", target: { panel: "Full backup", button: "Create full backup now" } },
      { text: "Nightly automatic backup: its switch, the hour it runs on the community's clock, and how many to keep.", route: "admin.backup", target: { panel: "Full backup", css: ".card .control-row" } },
      {
        text: "Or, under Export, tick just the parts you want and press Export for a file of them.", route: "admin.backup", target: { panel: "Export", button: "Export" },
        fields: ["App settings", "Server connections", "Staff accounts & roles", "Per-server feature settings", "Maps", "Message templates", "Players & careers", "Names & clan tags", "Player notes", "Discord links", "VIP & console admins", "Economy", "Bulk payouts", "Bans", "Watch history", "Approval requests", "Player groups", "Staff announcements", "Game log", "Match history", "Play sessions", "Roster snapshots", "Map-vote history", "Admin camera sessions", "IP history", "Staff activity"],
      },
      { text: "Select everything ticks every part to export.", route: "admin.backup", target: { panel: "Export", button: "Select everything" } },
      { text: "Clear unticks every part.", route: "admin.backup", target: { panel: "Export", button: "Clear" } },
      { text: "Check sizes shows how big each part is, before you export.", route: "admin.backup", target: { panel: "Export", button: "Check sizes" } },
      { text: "Under Full backup, Restore puts every record back as it was in that file, after asking. Anything changed since is gone.", route: "admin.backup", target: { panel: "Full backup", button: "Restore" } },
      { text: "Delete removes a backup file, after asking.", route: "admin.backup", target: { panel: "Full backup", button: "Delete" } },
      { text: "Import brings back a file exported from a panel. What is already here always stays; importing only adds.", route: "admin.backup", target: { panel: "Import", button: "Import" }, fields: ["Archive file"] },
    ],
  },
  {
    id: "see-system",
    title: "See how the panel itself is running",
    blurb: "The panel's version, how busy its machine is, and its background services.",
    keywords: ["status", "health", "version", "uptime", "cpu", "memory", "disk", "services"],
    caps: ["audit.trail"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.system", target: { nav: "admin" } },
      { text: "Open the System tab.", route: "admin.system", target: { tab: "System" } },
      { text: "System: how long the panel has run, and how busy its machine is.", route: "admin.system", target: { panel: "System" } },
      { text: "Services: each part of the panel at work in the background, and whether it is well.", route: "admin.system", target: { panel: "Services" } },
      {
        text: "The foot of the menu shows whether its machine is online, its version and load. After an update, Panel updated — tap to reload appears.", route: "admin.system", target: { css: ".sidebar .host-status" },
      },
    ],
  },
  {
    id: "team-layout",
    title: "Set a screen's layout for the whole team",
    blurb: "Arrange a screen's panels as everyone first sees them.",
    keywords: ["layout", "arrange", "default layout"],
    caps: ["layout.edit"],
    group: "Administration",
    steps: [
      OPEN_LIVE,
      { text: "Press Arrange panels, at the foot of the screen.", route: "live", target: { button: "⧉ Arrange panels" } },
      {
        text: "Move panels with ◀ and ▶, set their widths, and hide what is not needed.", route: "live",
        before: [{ click: { button: "⧉ Arrange panels" } }], target: { button: "◀" },
      },
      {
        text: "Press Save as team default. Anyone who has not arranged the screen themselves starts from it.", route: "live",
        before: [{ click: { button: "⧉ Arrange panels" } }], target: { button: "Save as team default" },
      },
    ],
  },
  {
    id: "see-accounts",
    title: "See the staff accounts",
    blurb: "Everyone who can sign in to the panel, and their roles.",
    keywords: ["users", "staff", "logins"],
    caps: ["admin.users"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.users", target: { nav: "admin" } },
      { text: "Open the Users & roles tab.", route: "admin.users", target: { tab: "Users & roles" } },
      { text: "Accounts lists everyone who can sign in to the panel, and the roles that give them their permissions.", route: "admin.users", target: { panel: "Accounts" } },
      { text: "Request builder: how much staff may see while they put a request together. It never lets them do more.", route: "admin.users", target: { panel: "Request builder" }, fields: ["While building, staff can see at most", "Discard unsubmitted drafts after"] },
    ],
  },
  {
    id: "add-staff",
    title: "Add a staff member",
    blurb: "An account for someone new, with the access they need.",
    keywords: ["user", "account", "moderator", "admin", "login"],
    caps: ["admin.users"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.users", target: { nav: "admin" } },
      { text: "Open the Users & roles tab.", route: "admin.users", target: { tab: "Users & roles" } },
      { text: "Under Add a user, give them a username and a password to sign in with.", route: "admin.users", target: { panel: "Add a user", field: "Username" }, fields: ["Password"] },
      { text: "They sign in on the panel's own page, with that username and password.", route: "admin.users", stage: "signed-out", target: { css: ".auth-card form" } },
      { text: "Pick their starting access: a role, a ready-made set of permissions, or none to set it up below.", route: "admin.users", target: { panel: "Add a user", field: "Starting access" } },
      { text: "Press Create user.", route: "admin.users", target: { panel: "Add a user", button: "Create user" } },
    ],
  },
  {
    id: "make-role",
    title: "Make a role",
    blurb: "A set of permissions to give staff, such as Moderator.",
    keywords: ["permissions", "rank", "access"],
    caps: ["admin.users"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.users", target: { nav: "admin" } },
      { text: "Open the Users & roles tab.", route: "admin.users", target: { tab: "Users & roles" } },
      { text: "Name the role. Under Start from, copy a role you already have, or start blank.", route: "admin.users", target: { panel: "Roles", field: "New role name" }, fields: ["Start from"] },
      { text: "Press Create role, then choose what it may do. Everyone given the role gets those permissions.", route: "admin.users", target: { panel: "Roles", button: "Create role" } },
    ],
  },
  {
    id: "edit-staff",
    title: "Change a staff member's access",
    blurb: "Their roles and permissions, a new password, or ending their sessions.",
    keywords: ["permissions", "reset password", "password", "sign out", "merge accounts", "remove a user", "access"],
    caps: ["admin.users"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.users", target: { nav: "admin" } },
      { text: "Open the Users & roles tab.", route: "admin.users", target: { tab: "Users & roles" } },
      { text: "Under Accounts, Edit permissions opens what someone may do: their roles, and any permissions of their own.", route: "admin.users", target: { panel: "Accounts", button: "Edit permissions" } },
      {
        text: "Add a role gives them another role. The servers under a role pick where it applies, and × takes it away.", route: "admin.users",
        before: [{ click: { panel: "Accounts", button: "Edit permissions" } }], target: { panel: "Accounts", css: 'select[aria-label="Add a role"]' },
      },
      {
        text: "Beside a role, Every server covers every server, those added later too. Tick servers instead to keep it to them.", route: "admin.users",
        before: [{ click: { panel: "Accounts", button: "Edit permissions", nth: 2 } }], target: { panel: "Accounts", css: ".role-chip .scope-chips" },
      },
      {
        text: "A Discord member's roles follow Discord. Take manual control sets them here instead; Hand back to Discord returns them.", route: "admin.users",
        before: [{ click: { panel: "Accounts", button: "Edit permissions", nth: 1 } }], target: { panel: "Accounts", css: ".perm-editor .callout button" },
      },
      {
        text: "Apply preset copies a ready-made set, from Viewer to Owner, onto their own permissions. Clear all takes theirs away.", route: "admin.users",
        before: [{ click: { panel: "Accounts", button: "Edit permissions" } }], target: { panel: "Accounts", css: '[role="group"][aria-label="Individual permissions"]' },
      },
      {
        text: "Global is what they may do on every server. A server's name adds more on that server only.", route: "admin.users",
        before: [{ click: { panel: "Accounts", button: "Edit permissions", nth: 1 } }], target: { panel: "Accounts", css: ".perm-scopes" },
      },
      {
        text: "Each permission of their own is –, Read, Write or Block, on top of their roles. Block refuses it whatever a role gives.", route: "admin.users",
        before: [{ click: { panel: "Accounts", button: "Edit permissions", nth: 1 } }], target: { panel: "Accounts", button: "Block" }, fields: ["–", "Read", "Write", "no limit"],
      },
      { text: "Save changes keeps what you changed, and Discard puts back what was there.", route: "admin.users", before: [{ click: { panel: "Accounts", button: "Edit permissions" } }], target: { panel: "Accounts", css: ".perm-save" } },
      { text: "Collapse folds it away. What is not saved yet is kept, and marked unsaved changes.", route: "admin.users", before: [{ click: { panel: "Accounts", button: "Edit permissions" } }], target: { panel: "Accounts", button: "Collapse" } },
      { text: "Reset password sets a new one they can sign in with at once. Sessions already open stay signed in.", route: "admin.users", target: { panel: "Accounts", button: "Reset password" }, fields: ["New password"] },
      { text: "Sign out everywhere ends every session and API token they have, after asking: for a leaked password.", route: "admin.users", target: { panel: "Accounts", button: "Sign out everywhere" } },
      {
        text: "Merge… folds a duplicate account into this one: pick it, then press Merge. This account is the one kept.", route: "admin.users",
        target: { panel: "Accounts", button: "Merge" }, fields: ["Duplicate account"],
      },
      { text: "Delete removes the account, after asking. It cannot be undone.", route: "admin.users", target: { panel: "Accounts", button: "Delete" } },
    ],
  },
  {
    id: "edit-role",
    title: "Change or remove a role",
    blurb: "What a role may do, for everyone who holds it.",
    keywords: ["role permissions", "rename role", "delete role", "view as"],
    caps: ["admin.users"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.users", target: { nav: "admin" } },
      { text: "Open the Users & roles tab.", route: "admin.users", target: { tab: "Users & roles" } },
      { text: "Under Roles, Edit opens what a role may do. A change reaches everyone who holds the role.", route: "admin.users", target: { panel: "Roles", button: "Edit" } },
      {
        text: "Each permission is –, Read or Write. Block keeps this role from giving it, though another role still can.", route: "admin.users",
        before: [{ click: { panel: "Roles", button: "Edit" } }], target: { panel: "Roles", button: "Block" }, fields: ["–", "Read", "Write"],
      },
      {
        text: "Some permissions have a limit under them, such as the longest temporary ban in hours. Left empty, there is none.", route: "admin.users",
        before: [{ click: { panel: "Roles", button: "Edit" } }], target: { panel: "Roles", css: "input.perm-limit-input" }, fields: ["no limit"],
      },
      { text: "Copy permissions from starts from another role's. Clear all empties this one.", route: "admin.users", before: [{ click: { panel: "Roles", button: "Edit" } }], target: { panel: "Roles", css: ".perm-presets" } },
      { text: "Save changes keeps what you changed, and Discard puts back what was there.", route: "admin.users", before: [{ click: { panel: "Roles", button: "Edit" } }], target: { panel: "Roles", css: ".perm-save" } },
      { text: "Collapse folds it away. What is not saved yet is kept, and marked unsaved changes.", route: "admin.users", before: [{ click: { panel: "Roles", button: "Edit" } }], target: { panel: "Roles", button: "Collapse" } },
      { text: "View as shows the panel as someone with only this role would see it: read only, and never past your own access.", route: "admin.users", target: { panel: "Roles", button: "View as" } },
      { text: "A bar at the top says whose view it is. Exit preview goes back to your own.", route: "admin.users", before: [{ click: { panel: "Roles", button: "View as" } }], target: { button: "Exit preview" } },
      { text: "Rename gives the role another name.", route: "admin.users", target: { panel: "Roles", button: "Rename" }, fields: ["Role name"] },
      { text: "Delete removes the role, after asking. Its members lose what it gave them.", route: "admin.users", target: { panel: "Roles", button: "Delete" } },
    ],
  },
  {
    id: "community-clock",
    title: "Set the community's time zone",
    blurb: "The clock every schedule runs on, and when daily claims reset.",
    keywords: ["time zone", "timezone", "clock", "midnight", "community clock"],
    caps: ["admin.users"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.users", target: { nav: "admin" } },
      { text: "Open the Users & roles tab.", route: "admin.users", target: { tab: "Users & roles" } },
      { text: "Community time zone is the clock every schedule runs on. Daily and monthly claims reset at its midnight.", route: "admin.users", target: { panel: "Community time zone" } },
      { text: "Pick the zone. Without the permission, a change is sent for approval.", route: "admin.users", target: { setting: "Community time zone" } },
    ],
  },
  {
    id: "discord-setup",
    title: "Connect the Discord bot",
    blurb: "The bot behind Discord sign-in, relays and the shop.",
    keywords: ["bot token", "discord app", "sign in with discord"],
    caps: ["discord.setup"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Discord.", route: "discord.setup", target: { nav: "discord" } },
      { text: "Open the Setup & status tab.", route: "discord.setup", target: { tab: "Setup & status" } },
      { text: "Each line says what is set and what is missing, and where in Discord's Developer Portal to find it.", route: "discord.setup", target: { panel: "Setup & status", css: ".drm-list" } },
      {
        text: "Fill in what is missing, then press Save.", route: "discord.setup", target: { panel: "Setup & status", button: "Save" },
        fields: ["Bot token", "Application id", "Public key", "OAuth client id", "OAuth client secret", "Staff server id", "Sign-in return address"],
      },
      { text: "Public Discord server: your community's own server, where members link and claim. It saves on its own.", route: "discord.setup", target: { panel: "Public Discord server", button: "Save" }, fields: ["Public server id"] },
      { text: "Approvals relay posts each new request in a channel, for staff to answer there. It has its own Save.", route: "discord.setup", target: { panel: "Approvals relay", button: "Save" }, fields: ["Approvals channel id", "Mention role id"] },
      { text: "+ Add badge adds one: an emoji, what it means, and the roles that earn it.", route: "discord.setup", target: { panel: "Community badges", button: "+ Add badge" } },
      { text: "Community badges give members with a role an emoji beside their name. Save badges keeps them.", route: "discord.setup", target: { panel: "Community badges", button: "Save badges" }, fields: ["Emoji", "Means"] },
    ],
  },
  {
    id: "see-discord-setup",
    title: "See how the Discord bot is set up",
    blurb: "What the Discord bot has, what it still needs, and what it posts.",
    keywords: ["bot", "status", "approvals", "badges"],
    caps: ["discord.setup"],
    group: "Administration",
    steps: [
      { text: "Open Discord.", route: "discord.setup", target: { nav: "discord" } },
      { text: "Open the Setup & status tab.", route: "discord.setup", target: { tab: "Setup & status" } },
      { text: "Each line says what is set and what is missing, and where in Discord's Developer Portal to find it.", route: "discord.setup", target: { panel: "Setup & status", css: ".drm-list" } },
      { text: "Approvals relay posts each new request in a Discord channel, for staff to answer there.", route: "discord.setup", target: { panel: "Approvals relay" } },
      { text: "Community badges: the emoji members can wear beside their name.", route: "discord.setup", target: { panel: "Community badges" } },
    ],
  },
  {
    id: "see-signin",
    title: "See how staff sign in with Discord",
    blurb: "Signing in with Discord, and the panel role each Discord role gives.",
    keywords: ["sign in with discord", "login", "roles", "role sync"],
    caps: ["admin.users"],
    group: "Administration",
    steps: [
      { text: "Open Discord.", route: "discord.signin", target: { nav: "discord" } },
      { text: "Open the Sign-in & roles tab.", route: "discord.signin", target: { tab: "Sign-in & roles" } },
      { text: "Sign-in & roles: how staff sign in with Discord, and the panel role each Discord role gives.", route: "discord.signin", target: { panel: "Sign-in & roles" } },
      { text: "With it set up, the page that signs staff in offers Sign in with Discord, below the password.", route: "discord.signin", stage: "signed-out", target: { css: ".discord-btn" } },
    ],
  },
  {
    id: "online-access",
    title: "Put the panel online",
    blurb: "Reach the panel from anywhere, at your own address.",
    keywords: ["domain", "internet", "tunnel", "cloudflare", "https", "remote access", "demo"],
    caps: ["admin.online"],
    capLevel: "write",
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.online", target: { nav: "admin" } },
      { text: "Open the Online access tab.", route: "admin.online", target: { tab: "Online access" } },
      { text: "A Cloudflare tunnel needs no open ports. Paste its token here: Explanation, below, says how to make one.", route: "admin.online", target: { panel: "Put the panel online", field: "Tunnel token" } },
      { text: "Press Save. It says Connected within a few seconds.", route: "admin.online", target: { panel: "Put the panel online", button: "Save" } },
      { text: "Or, on a VM with its own address, type the panel's domain under Your own domain, then press its Save.", route: "admin.online", target: { panel: "Put the panel online", field: "The panel's domain" } },
      { text: "Once saved, the domain is a link that opens the panel there.", route: "admin.online", target: { panel: "Put the panel online", css: ".online-status a" } },
      { text: "Remove takes away the tunnel's token, or the domain.", route: "admin.online", target: { panel: "Put the panel online", button: "Remove" } },
      {
        text: "Public stats site: its own address, the name it goes by, and how shared links start. Press Save.", route: "admin.online",
        target: { panel: "Public stats site", button: "Save" }, fields: ["Its own address", "Community name", "Shareable address"],
      },
      { text: "Turn on the public demo to let anyone try the panel on made-up data. It saves as you turn it.", route: "admin.online", target: { panel: "Public demo", css: "label.toggle" } },
      { text: "Share this link. In the demo, Walkthroughs at the top opens Help's walkthroughs.", route: "admin.online", target: { panel: "Public demo", css: ".demo-link" } },
    ],
  },
  {
    id: "see-online",
    title: "See how the panel is reached online",
    blurb: "Whether the panel can be reached from anywhere, and at what address.",
    keywords: ["domain", "internet", "tunnel", "remote access", "address", "demo"],
    caps: ["admin.online"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.online", target: { nav: "admin" } },
      { text: "Open the Online access tab.", route: "admin.online", target: { tab: "Online access" } },
      { text: "Put the panel online: a tunnel or the panel's own domain, and whether it is connected.", route: "admin.online", target: { panel: "Put the panel online" } },
      { text: "Public demo: whether anyone can try the panel on made-up data, and the link to share.", route: "admin.online", target: { panel: "Public demo" } },
    ],
  },
  {
    id: "api-token",
    title: "Make an API token",
    blurb: "A key that lets a script or a bot use the panel as you.",
    keywords: ["key", "bot", "script", "integration"],
    caps: ["api.tokens"],
    group: "Administration",
    steps: [
      OPEN_SETTINGS,
      { text: "Open API tokens.", route: "settings", target: { panel: "API tokens" } },
      {
        text: "Name it for what will use it, and press Create token. It is shown once, so copy it then.", route: "settings", fields: ["Token name"],
        before: [{ click: { panel: "API tokens", css: ".panel-toggle" } }], target: { panel: "API tokens", button: "Create token" },
      },
      {
        text: "Copy puts the new token on your clipboard. It is shown this once.", route: "settings",
        before: [{ click: { panel: "API tokens", css: ".panel-toggle" } }, { click: { panel: "API tokens", button: "Create token" } }], target: { panel: "API tokens", button: "Copy" },
      },
      {
        text: "Your tokens are listed with when each was made and ends. Revoke stops one working, after asking.", route: "settings",
        before: [{ click: { panel: "API tokens", css: ".panel-toggle" } }], target: { panel: "API tokens", button: "Revoke" },
      },
    ],
  },
  {
    id: "rcon-console",
    title: "Send a command to the game server",
    blurb: "The game's own commands, for anything the panel has no button for.",
    keywords: ["command", "raw", "console"],
    caps: ["admin.console"],
    group: "Administration",
    steps: [
      { text: "Open Administration.", route: "admin.console", target: { nav: "admin" } },
      { text: "Open the RCON console tab.", route: "admin.console", target: { tab: "RCON console" } },
      { text: "Pick a command. What it needs is asked for below it.", route: "admin.console", target: { panel: "Send a command", field: "Command" }, fields: ["Version", "Info type", "Value", "Seconds back", "Filter"] },
      { text: "Press Send. The game's answer is shown under it.", route: "admin.console", target: { panel: "Send a command", button: "Send" } },
      { text: "+ Advanced sends a command with settings typed by hand, for what the form has no box for.", route: "admin.console", target: { panel: "Send a command", button: "+ Advanced" } },
      { text: "Type the request as JSON; it overrides the form above. − Advanced folds it away again.", route: "admin.console", before: [{ click: { panel: "Send a command", button: "+ Advanced" } }], target: { panel: "Send a command", button: "− Advanced" }, fields: ["raw request body"] },
      { text: "Copy all copies every answer so far, to share.", route: "admin.console", target: { panel: "Send a command", button: "Copy all" } },
      {
        text: "On each answer, Copy copies the answer alone, and +cmd the command with it.", route: "admin.console",
        before: [{ fill: { panel: "Send a command", field: "Command" }, value: "GetDisplayableCommands" }, { click: { panel: "Send a command", button: "Send" } }],
        target: { panel: "Send a command", css: ".console-entry .row" },
      },
      { text: "Clear empties the list of answers.", route: "admin.console", target: { panel: "Send a command", button: "Clear" } },
    ],
  },
];

// ------------------------------------------------------------------------------- engine ----

/** Play a walkthrough on the panel itself, from one of its steps ("Show me on my screen"): the
 *  shell listens (app/page.tsx) and loads components/WalkSpotlight to do it. */
export function showOnScreen(walkId: string, step = 0): void {
  window.dispatchEvent(new CustomEvent("panel:walk", { detail: { walkId, step } }));
}

/** Holds any of these, each at its own lowest level (or the level asked)? Empty asks nothing. */
const holdsAny = (grants: ClientGrant[], caps: string[] | undefined, level?: "write") =>
  !caps?.length || caps.some((c) => hasCap(grants, c, level ?? minLevelFor(c)));

/** A screen shows its tab bar only to someone who can open more than one of its tabs. */
function tabBarShown(grants: ClientGrant[], routeId: string): boolean {
  const parent = routeById(routeId)?.parent;
  return Boolean(parent) && ROUTES.filter((r) => r.parent === parent && canOpenRoute(grants, r)).length > 1;
}

/** May this person follow the step: open its screen — and, for a tab, the screen holding it, whose
 *  entry in the menu is the way to it — and hold what it asks besides. */
export function stepOpens(grants: ClientGrant[], step: WalkStep): boolean {
  // In Discord there is no screen to open: the drawing is everyone's, each seeing their own parts.
  if (step.discord) return holdsAny(grants, step.caps, step.capLevel) && !step.needs?.some((c) => !holdsAny(grants, [c]));
  const route = routeById(step.route);
  const holder = route?.parent ? routeById(route.parent) : undefined;
  return Boolean(route) && !route!.ownerOnly && canOpenRoute(grants, route!) && (!holder || canOpenRoute(grants, holder))
    && holdsAny(grants, step.caps, step.capLevel) && !step.needs?.some((c) => !holdsAny(grants, [c]));
}

/**
 * The walkthroughs this person may follow, each with only the steps they can take. What they
 * HOLD, that is: the wider view an open request lends (source "request-view") is a look at screens
 * for building the request, not permission to do what is on them.
 */
export function walkthroughsFor(grants: ClientGrant[]): Walkthrough[] {
  const own = grants.filter((g) => g.source !== "request-view");
  return WALKTHROUGHS.flatMap((w) => {
    if (!holdsAny(own, w.caps, w.capLevel) || w.needs?.some((c) => !holdsAny(own, [c]))) return [];
    // A step a person cannot take hides the walkthrough, unless the step is only an extra. A tab
    // to press is no step at all for someone whose screen has only that tab, and no tab bar.
    if (w.steps.some((s) => !s.optional && !s.caps && !s.target.tab && !stepOpens(own, s))) return [];
    const steps = w.steps.filter((s) => stepOpens(own, s) && (!s.target.tab || tabBarShown(own, s.route)));
    return steps.length ? [{ ...w, steps }] : [];
  });
}

/** Open a walkthrough's slideshow wherever the person is (Search finds them): the shell listens
 *  (app/page.tsx). */
export function openWalkthrough(walkId: string): void {
  window.dispatchEvent(new CustomEvent("panel:walkthrough", { detail: { walkId } }));
}

/** Words that say nothing about what someone wants: "how do I ban someone" is a search for "ban". */
const FILLER = new Set(["a", "an", "and", "are", "at", "be", "can", "do", "does", "for", "from", "get", "how", "i", "in", "into", "is", "it", "me", "my", "of", "on", "or", "out", "someone", "somebody", "the", "their", "them", "to", "want", "way", "what", "when", "where", "who", "why", "with", "you", "your"]);
const wordsIn = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The words a walkthrough is found by, by where they are: its title; its blurb and keywords; its
 *  steps and the screens they are on. */
function searchedWords(w: Pick<Walkthrough, "title" | "blurb" | "keywords" | "steps">): string[][] {
  return [
    wordsIn(w.title),
    wordsIn([w.blurb, ...(w.keywords ?? [])].join(" ")),
    wordsIn(w.steps.flatMap((s) => [s.text, ...(s.fields ?? []), routeById(s.route)?.title ?? "", routeById(routeById(s.route)?.parent ?? "")?.title ?? ""]).join(" ")),
  ];
}

/** A word found in a quarter of all walkthroughs or more ("player", "server") says little alone. */
const commonWords = new Map<string, boolean>();
function common(word: string): boolean {
  let known = commonWords.get(word);
  if (known === undefined) {
    const holding = WALKTHROUGHS.filter((w) => searchedWords(w).some((words) => words.some((x) => x.startsWith(word)))).length;
    known = holding >= WALKTHROUGHS.length / 4;
    commonWords.set(word, known);
  }
  return known;
}

/**
 * The walkthroughs that answer a search, best first. A word matches the start of a word in the
 * walkthrough — "ban" finds "banned" — weighed by where: its title, then its blurb and keywords,
 * then its steps and the screens they are on. When some walkthroughs match every word searched,
 * only those are listed: "give vip" is about VIP, not everything that gives. When none does, those
 * matching the most words — but never on a word most walkthroughs hold alone: "ban a player" from
 * someone who may not ban finds nothing, not every walkthrough about players. `every` asks for
 * walkthroughs matching every word or none, for a search listing them beside other things.
 */
export function searchWalkthroughs<W extends Pick<Walkthrough, "title" | "blurb" | "keywords" | "steps">>(walks: W[], query: string, { every = false } = {}): W[] {
  // "bans" finds "ban": a plural asks for what its singular does.
  const asked = wordsIn(query).filter((w) => !FILLER.has(w)).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  if (!asked.length) return [];
  const scored = walks.map((w) => {
    const places = searchedWords(w);
    const matched: string[] = [];
    let score = 0;
    for (const a of asked) {
      const at = places.findIndex((words) => words.some((x) => x.startsWith(a)));
      if (at !== -1) { matched.push(a); score += 3 - at; }
    }
    return { w, matched, score };
  }).filter((r) => r.matched.length === asked.length || (!every && r.matched.some((a) => !common(a))));
  const most = Math.max(0, ...scored.map((r) => r.matched.length));
  return scored.filter((r) => r.matched.length === most).sort((a, b) => b.score - a.score).map((r) => r.w);
}

/** The step as it is on a phone: its own words, target and first actions where it has them. */
export function onPhone(step: WalkStep): WalkStep {
  if (!step.phone) return step;
  const { phone, ...rest } = step;
  return { ...rest, text: phone.text ?? step.text, target: phone.target ?? step.target, before: phone.before ?? step.before };
}

/**
 * The picture a step shows, named by what it shows: the screen, what is done first, and what is
 * ringed. Steps that show the same thing share one picture (every player action starts on the same
 * roster), and a step whose screen or target changes gets a new name, so a stale picture is never
 * served for it. FNV-1a, so the script and the panel name it the same way without a library.
 */
export function stageKey(step: Pick<WalkStep, "route" | "target" | "before" | "stage">): string {
  const text = JSON.stringify([step.route, step.target, step.before ?? [], ...(step.stage ? [step.stage] : [])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
