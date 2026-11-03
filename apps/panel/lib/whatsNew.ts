/**
 * What's new — what each update changed, said so that someone opening the panel for the first time
 * understands it. The panel shows the builds a person hasn't seen once, after an update
 * (components/WhatsNew), and keeps every one under Help → What's new.
 *
 * Every update that brings a new feature adds a release at the TOP, numbered one more than the
 * newest build here and dated the day it was made. Bug and stability fixes get none: this is for
 * what people can do now that they could not before, so the numbers skip the updates that only
 * fixed things (their notes were taken out, their numbers left unused). The number is what the
 * panel keeps track of: a person is shown every build above the last one they closed, however many
 * came the same day. (Keyed by date, as it was at first, a second update on the same day was never
 * shown.)
 * The words are for a person with no experience of the panel or of how it is built, and
 * test/whats-new.test.mjs holds them to it:
 *
 *  - say what they can do now, and where — not how it was built, or what was wrong with the code;
 *  - short sentences, everyday words: no "API", "sync", "cache", "token", "export" or "toggle";
 *  - one thing per item, a few words of title, two or three sentences under it.
 *
 * `where` names the screens an item is about. Someone who can open none of them doesn't see the
 * item, and "Show me" takes them to the first one they can open. `search` opens Search instead.
 */
export interface WhatsNewItem {
  title: string;
  text: string;
  where?: string[];
  search?: boolean;
}
export interface WhatsNewRelease {
  /** The update's build number: one more than the build before it. */
  build: number;
  /** The day the update was made: YYYY-MM-DD. */
  date: string;
  items: WhatsNewItem[];
}

export const WHATS_NEW: WhatsNewRelease[] = [
  {
    build: 53,
    date: "2026-11-01",
    items: [
      {
        title: "See exactly what a staff action changed",
        text: "Press an action in Staff activity, or on a staff member's page, to see exactly what it did. A save lists each setting it changed, what it was, and what it became. For auto settings, that includes which profile.",
        where: ["admin.activity"],
      },
    ],
  },
  {
    build: 52,
    date: "2026-10-31",
    items: [
      {
        title: "VIP purchases show their dates",
        text: "A VIP purchase in the points history now says when its days start and when the VIP ends, on each server it reached. Members see it under History on the Discord VIP panel, and staff see it in Economy too.",
        where: ["players.economy"],
      },
    ],
  },
  {
    build: 51,
    date: "2026-10-30",
    items: [
      {
        title: "A public demo of the panel",
        text: "Online access can now show anyone a copy of the panel filled with made-up players and matches, to click around in. Nothing done there reaches your servers. It stays off until you turn it on.",
        where: ["admin.online"],
      },
    ],
  },
  {
    build: 50,
    date: "2026-10-28",
    items: [
      {
        title: "More lists come in pages",
        text: "Scheduled events, payout history, staff notices and the leaderboard now reach all the way back, a page at a time. A payout's recipients and receipts, the request history and seed reward rounds show a page at a time too. Changing a row keeps you on its page.",
        where: ["events.schedule", "events.payouts", "community", "players.leaderboard"],
      },
    ],
  },
  {
    build: 49,
    date: "2026-10-28",
    items: [
      {
        title: "Long lists come in pages",
        text: "VIPs, bans, the watchlist, player rules, backups, and a player's notes and IP history now show a page at a time, like the players list. Choose how many rows a page holds beneath each list. Searching and sorting still cover all of it.",
        where: ["players.vips", "moderation.bans", "moderation.watched"],
      },
    ],
  },
  {
    build: 46,
    date: "2026-10-27",
    items: [
      {
        title: "The Discord panel, in its walkthrough",
        text: "The Do staff work from Discord walkthrough now draws the staff command's panel in each of its steps, as Discord shows it to you. Show me on my screen opens it over the screen you are on. Help's Staff command tab is gone.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 42,
    date: "2026-10-27",
    items: [
      {
        title: "See the staff command in Help",
        text: "Help has a Staff command tab that draws what the command opens in Discord, with the parts your permissions give you. The Do staff work from Discord walkthrough now shows each part there.",
        // Its tab has gone since, into the walkthrough's steps (build 46).
        where: ["help.start"],
      },
    ],
  },
  {
    build: 38,
    date: "2026-10-27",
    items: [
      {
        title: "Shorter walkthroughs",
        text: "Help's walkthroughs under Start here are back to a picture and a line for each step. The longer notes the old How do I guides brought in are gone.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 37,
    date: "2026-10-27",
    items: [
      {
        title: "Live roster checks in one place",
        text: "Rules' On event now has one live roster choice, and the check itself is picked beside it, in Live roster check. Rules made before open on their check and keep working as they were.",
        where: ["autosettings.rules"],
      },
      {
        title: "A ratio check for rules",
        text: "A new live roster check sets two of a player's counts this match against a limit: kills, deaths or team kills. Team kills to kills at or above 2 finds someone killing twice as many of their own side as the enemy. Player triggers can watch one player for it too.",
        where: ["autosettings.rules", "players.triggers"],
      },
    ],
  },
  {
    build: 36,
    date: "2026-10-27",
    items: [
      {
        title: "Walkthroughs for the rest of the panel",
        text: "Help's walkthroughs now also cover what opens over a screen: Search, your account's menu, Getting started, a request being built, and arranging a screen's panels. They also show the panel in its other states, such as a server running Vietnam or a list that could not be read.",
        where: ["help.start"],
      },
      {
        title: "Pictures with two servers",
        text: "Help's pictures now show a community with two servers, one of them in observe mode. Where a ban or a reward asks which servers, that is shown too.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 35,
    date: "2026-10-27",
    items: [
      {
        title: "Walkthroughs for every button",
        text: "Help's walkthroughs now point at every button, not only the settings. New ones show how to change a staff member's access or a role, pause or file rules, and post the events list to Discord.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 34,
    date: "2026-10-26",
    items: [
      {
        title: "Walkthroughs for every setting",
        text: "Help's walkthroughs now explain every setting in Auto settings and Administration too, from rules and profiles to the console and backups.",
        where: ["help.start"],
      },
      {
        title: "Find a game setting by its name",
        text: "Searching Help for a game setting, such as the welcome message or map shuffle, now finds the walkthrough that changes it.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 33,
    date: "2026-10-26",
    items: [
      {
        title: "Walkthroughs for more screens",
        text: "Help's walkthroughs now say what each setting does on Moderation, Events, History, Analytics, Maps, Discord, Game rewards and Seeding. They also explain Clear filters, Refresh and copying a player's id, wherever those appear.",
        where: ["help.start"],
      },
      {
        title: "The staff command, part by part",
        text: "The walkthrough on doing staff work from Discord now shows every part of the staff command's panel, each to whoever may use it. It covers servers, the economy, registering members, posting the VIP panel, moderation and maps.",
        where: ["help.start"],
      },
      {
        title: "Tell players when an admin watches",
        text: "A new walkthrough shows how to have players told in game when an admin goes into the camera, and in what words.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 32,
    date: "2026-10-26",
    items: [
      {
        title: "Walkthroughs name every setting",
        text: "Help's walkthroughs now say what each setting does on Settings, Live and the Players screens, and in the windows they open. Search in Help finds a walkthrough by the name of a setting it explains.",
        where: ["help.start"],
      },
      {
        title: "New walkthroughs",
        text: "New walkthroughs show how to act on several players at once from Live, and how to set a trigger on a player. Others give or take back VIP from a player's menu, and check that no VIP was lost.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 31,
    date: "2026-10-26",
    items: [
      {
        title: "The Teams view fits a phone",
        text: "On a phone, Live's Teams view now shows one whole side at a time: swipe for the other. Names, levels and kills line up, and a squad's kills are spelled out. A side opened on its own drops the Team and Squad columns, and its squad headings stay the size of the rows.",
        where: ["live"],
      },
    ],
  },
  {
    build: 28,
    date: "2026-10-26",
    items: [
      {
        title: "Walkthroughs explain more",
        text: "A walkthrough step can now open Explanation for more about it: why it works that way, what happens next and what to watch for. Search reads it too, so it finds more.",
        where: ["help.start"],
      },
      {
        title: "How do I is now part of Start here",
        text: "Help's How do I guides are now walkthroughs under Start here, with pictures, and their extra detail opens under Explanation. A link to an old guide opens its walkthrough.",
        where: ["help.start"],
      },
      {
        title: "More steps for profiles and rounds",
        text: "Walkthroughs now cover a player's profile, from copying its link to editing a watch reason, plus a staff member's page and a round's page.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 27,
    date: "2026-10-26",
    items: [
      {
        title: "Choose whether What's new opens",
        text: "What's new no longer has to open after every update. Switch it off in Settings, under Workspace, or in Getting started. Help keeps every update's notes either way.",
        where: ["settings"],
      },
      {
        title: "The community's time zone has moved",
        text: "The community's time zone is now set in Administration, under Users & roles, beside the other settings for the whole community. Settings keeps your own clock.",
        where: ["admin.users"],
      },
      {
        title: "Map buttons follow their own permissions",
        text: "On Maps, changing the rotation, renaming a map and changing the map now each go with their own permission. Add server goes with Add a server.",
        where: ["maps.rotation", "maps.catalogue", "admin.connections"],
      },
      {
        title: "Discord links and events: own permission",
        text: "A player's Discord registration now goes with Player identity links, which can be given to see it or to change it. Scheduling events goes with Community events, not Bulk payouts.",
        where: ["players.players", "events.schedule", "events.payouts"],
      },
    ],
  },
  {
    build: 26,
    date: "2026-10-26",
    items: [
      {
        title: "Panels, lists and charts, explained",
        text: "A new walkthrough shows how every screen works: folding panels, reading their explanations, sorting lists, saving them as files and reading charts.",
        where: ["help.start"],
      },
      {
        title: "More steps for VIP, bans and groups",
        text: "Walkthroughs now cover uploading VIP and bans from a file, matching them with the game, banning someone offline, group VIP perks, triggers and payouts.",
        where: ["help.start"],
      },
      {
        title: "More steps for votes and servers",
        text: "Walkthroughs now cover running a map vote by hand, saving a rotation or vote setup, each server's own buttons and its CRCON backup.",
        where: ["help.start"],
      },
      {
        title: "More steps for automation and Discord",
        text: "Walkthroughs now cover the seeding ground rules, game reward cards, Discord tests and saves, saved setups, data repairs and restoring a backup. Every button on every screen now has a walkthrough step, or is explained in Use a screen's panels and lists.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 25,
    date: "2026-10-25",
    items: [
      {
        title: "Walkthroughs for looking things up",
        text: "Start here now has walkthroughs for looking things up. Find a player, read the leaderboard and clans, and see the map in play, a round's scoreboard and who used the admin camera.",
        where: ["help.start"],
      },
      {
        title: "Walkthroughs for VIP, the shop and votes",
        text: "Start here now walks you through the VIP presets, and the points economy and its shop. It also shows how map votes are set up, how past ones went, and how an event went.",
        where: ["help.start"],
      },
      {
        title: "Walkthroughs for automation and Discord",
        text: "Start here now walks you through how seeding, game rewards and the chat filter are set up. It also covers what a server posts to Discord, and what automation did lately.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 24,
    date: "2026-10-25",
    items: [
      {
        title: "Walkthroughs on your phone",
        text: "On a phone, each walkthrough now shows the panel as it looks on a phone. Where a step starts in the menu, it says to open the menu with ☰ first.",
        where: ["help.start"],
      },
      {
        title: "Show me on my screen, on a phone",
        text: "On a phone, Show me on my screen now points at ☰ when the next step is in the menu. Once the menu is open, it points at what to tap in it.",
        where: ["help.start"],
      },
      {
        title: "Search for a walkthrough",
        text: "Start here has a search box: say what you want to do, such as ban a player, and the walkthroughs for it are listed. Search at the top of the panel finds them too.",
        where: ["help.start"],
      },
      {
        title: "Told about new walkthroughs",
        text: "When you are given something new to do, the panel tells you which walkthroughs are now yours. It waits for the next screen you open, so it never interrupts what you are doing.",
        where: ["help.start"],
      },
      {
        title: "Walkthroughs for everyone",
        text: "Start here now shows everyone how to use Help, change their settings and password, read staff notices and arrange the dashboard. Staff who can open Moderation also see how to ask for approval.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 23,
    date: "2026-10-25",
    items: [
      {
        title: "Walkthroughs for running the panel",
        text: "Start here now has walkthroughs for running the panel too: staff accounts and roles, the rules, the chat filter, backups, Discord and game commands. Each one shows only to staff whose permissions cover it.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 22,
    date: "2026-10-25",
    items: [
      {
        title: "More walkthroughs in Help",
        text: "Start here now has walkthroughs for players, servers, maps, automation and analytics too: notes, the watchlist, groups, rounds, game settings, the map vote, seeding and charts. Each one shows only to staff whose permissions cover it.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 21,
    date: "2026-10-25",
    items: [
      {
        title: "Walkthroughs in Help",
        text: "Help now opens on Start here, with walkthroughs of what your permissions let you do. Each step shows a picture of the panel with the button to press ringed. Click through with Next and Back.",
        where: ["help.start"],
      },
      {
        title: "Set up the panel your way",
        text: "Everyone is now walked through their own settings once: how the panel looks, its text size, your clock and where it opens. Each choice applies straight away. Open it again any time from Help, under Start here.",
        where: ["help.start"],
      },
      {
        title: "Show me on my screen",
        text: "Any walkthrough in Help can now play on the panel itself. Press Show me on my screen, and the right screen opens with the button to press ringed. Press it, and the next step is shown.",
        where: ["help.start"],
      },
    ],
  },
  {
    build: 16,
    date: "2026-10-24",
    items: [
      {
        title: "The menu keeps your page in view",
        text: "On a smaller screen the menu can be longer than the window. It now scrolls itself to the screen you're on, so you can always see where you are.",
      },
      {
        title: "The menu fits your screen",
        text: "The menu now tightens its spacing to fit your window, so every screen in it shows without scrolling on most laptops. On a big monitor it stays as roomy as before.",
      },
      {
        title: "Choose your screen size",
        text: "Settings, Workspace has a new Screen size choice. Automatic fits the window you're in, or pick your screen from the list, from small laptops to 4K monitors. Each device keeps its own.",
        where: ["settings"],
      },
    ],
  },
  {
    build: 15,
    date: "2026-10-24",
    items: [
      {
        title: "Your badge on the match board",
        text: "The match board's corner badge is now uploaded under Discord, Relay & alerts. No badge is built in any more, so upload your community's badge there to keep one on the board.",
        where: ["discord.relay"],
      },
      {
        title: "A new app icon",
        text: "The panel's icon on a phone's home screen is now the program's own mark. Before, it was one community's badge.",
      },
    ],
  },
  {
    build: 4,
    date: "2026-10-24",
    items: [
      {
        title: "Discord roles in rules and groups",
        text: "Staff who edit the rules can now pick Discord roles, so a rule can leave your own staff alone. Staff who manage player groups can tie a group to a role. Before, those role lists stayed empty.",
        where: ["autosettings.rules", "players.groups"],
      },
    ],
  },
  {
    build: 3,
    date: "2026-10-24",
    items: [
      {
        title: "Admin camera on the public stats site",
        text: "The game log on the public stats site now shows when an admin enters or leaves the admin camera, by name. Pick Admin camera there to see only those lines. The round being played shows them too, within about 30 seconds.",
      },
      {
        title: "Save a round's game log",
        text: "The game log on the public stats site can now be saved as a file, for Excel or any other spreadsheet. It holds the lines the log shows, with its filter and name search.",
      },
      {
        title: "Smaller permissions to hand out",
        text: "The chat filter, map zones and seed rewards now each have a permission of their own. So do the Discord bot's setup and putting the panel online. Everyone keeps what they had. Setting the chat filter to kick or ban also takes the kick or ban permission.",
        where: ["admin.users"],
      },
    ],
  },
  {
    build: 2,
    date: "2026-10-23",
    items: [
      {
        title: "More phone notifications",
        text: "Besides the first three, Settings now offers many more to pick from. Among them: calls for an admin, automatic kicks and bans, seeding news, answers to your requests, staff bans by role, changed settings and shop purchases. Each stays off until you pick it.",
        where: ["settings"],
      },
      {
        title: "Pick the shortcut bar's buttons",
        text: "In Settings, pick which screens the shortcut bar holds and in what order, up to four, or turn the bar off. Screens a plugin adds can go on it too.",
        where: ["settings"],
      },
      {
        title: "Search opens on your recent list",
        text: "Opening Search now shows only the players and screens you opened last. Type to find any other screen, player or server. On a phone, each screen's name now stays whole beside its description.",
        search: true,
      },
      {
        title: "Choose who can give a bot their access",
        text: "Settings can make keys that let a bot or script act as you. Making and using one now takes its own permission, set in Users & roles. Without it, a person's keys stop working. Anyone who already had a key keeps the permission.",
        where: ["admin.users"],
      },
    ],
  },
  {
    build: 1,
    date: "2026-10-23",
    items: [
      {
        title: "Notifications on your phone",
        text: "The panel can now tell you when a player on the watchlist joins, when a request needs your approval, or when a server stops answering. It stays off until you turn it on in Settings. On an iPhone, first add the panel to your Home Screen and open it from there.",
        where: ["settings"],
      },
      {
        title: "A shortcut bar on phones",
        text: "On a phone, a bar with Live, Players, Bans, Search and More keeps the main screens one tap away. You can move it to the top or the bottom of the screen in Settings.",
        where: ["settings"],
      },
      {
        title: "Search finds players",
        text: "Type a player's name or ID into Search to open their profile. Search is at the top of the screen, and Ctrl+K opens it on a computer.",
        where: ["players"],
        search: true,
      },
      {
        title: "Go back to what you opened",
        text: "Open Search without typing anything to see the players and screens you opened last. Tap one to go straight back to it.",
        search: true,
      },
      {
        title: "Download lists",
        text: "VIPs, bans, player groups, payouts, the game log, staff activity and the watchlist each have a Download button. The file opens in Excel or any spreadsheet app. For the game log and staff activity, you pick a time range first.",
        where: ["players.vips", "moderation.bans", "players.groups", "events.payouts", "history.logs", "admin.activity", "moderation.watched"],
      },
      {
        title: "Upload a list again",
        text: "A VIP, ban or group member list you downloaded can be uploaded again, for example to bring VIPs back on a new server. Before anything changes, you see what each line will do. VIP is only ever added or made longer, never shortened.",
        where: ["players.vips", "moderation.bans", "players.groups"],
      },
      {
        title: "Stay signed in",
        text: "If you open the panel at least once a week, it keeps you signed in. It asks you to sign in again only after 30 days.",
      },
      {
        title: "See the exact time",
        text: "Tap a time like “5 min ago” to see the exact date and time, and tap it again to go back. On a computer, you can also point at it with the mouse.",
      },
    ],
  },
];

/**
 * A stored "seen" marker, as a build: a number (or its digits) is that build. A date is a marker
 * from before builds were numbered, when build 1 was the only release there was, so it means build
 * 1 — and everything since is new to that person. Anything else is nothing seen.
 */
export function seenBuild(v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 1;
  return 0;
}

/**
 * The builds to show this person after an update: every one above the last they closed. A person
 * who has never closed one is shown only what came after the day their account was made — someone
 * new to the panel has nothing to compare it with, so for them nothing is "new".
 */
export function unseenReleases(seen: number | null | undefined, accountCreatedAt: string | null | undefined, releases: WhatsNewRelease[] = WHATS_NEW): WhatsNewRelease[] {
  if (seen) return releases.filter((r) => r.build > seen);
  const since = (accountCreatedAt ?? "").slice(0, 10);
  return since ? releases.filter((r) => r.date > since) : [];
}

const seenKey = (who: string) => `panel.whatsNewSeen.${who}`;

/** The newest build this person has closed: their account's word for it — or this device's, when
 *  the account's save never landed (offline at the time), so it doesn't come back here. */
export function lastSeen(who: string, account: unknown): number | undefined {
  let here = "";
  try { here = localStorage.getItem(seenKey(who)) ?? ""; } catch { /* nothing kept here */ }
  return Math.max(seenBuild(account), seenBuild(here)) || undefined;
}

/** Closed: every build up to the newest is seen. Returns its number, for the account. */
export function markSeen(who: string, releases: WhatsNewRelease[] = WHATS_NEW): number {
  const build = releases[0]?.build ?? 0;
  try { localStorage.setItem(seenKey(who), String(build)); } catch { /* the account keeps it */ }
  return build;
}
