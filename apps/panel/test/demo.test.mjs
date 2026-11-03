// The public demo's own API (lib/demo/server), which answers the panel in the visitor's browser,
// run here without one: its lists page, filter and sort as the real ones do, a change it does not
// keep says so, the round on Live plays on and the stream says what happens in it, its screens have
// something to show where a busy community's would, and no id it hands out can be a real player's.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOT_KEPT, createDemoServer } from "../lib/demo/server.ts";
import { BUILT_COMMIT, bundleIsStale } from "../lib/version.ts";
import { WALK_FIXTURES } from "./walk-stage.mjs";
import { OWNER_GRANTS, stageAnswers } from "./stage-answers.mjs";

const STAFF_PANEL = JSON.parse(readFileSync(new URL("./staff-panel-sample.json", import.meta.url), "utf8"));
const ask = (s, method, path, body = null) => s.answer({ method, url: new URL(`http://demo${path}`), body });
const get = (s, path) => ask(s, "GET", path).body;

test("the demo's lists come a page at a time, filtered and sorted as the real ones are", () => {
  const s = createDemoServer(STAFF_PANEL);
  const first = get(s, "/api/players?limit=25&offset=0");
  const second = get(s, "/api/players?limit=25&offset=25");
  assert.equal(first.total, 400);
  assert.equal(first.players.length, 25);
  assert.equal(new Set([...first.players, ...second.players].map((p) => p.id)).size, 50, "the second page goes on from the first");
  const vips = get(s, "/api/players?vip=1&limit=500");
  assert.ok(vips.total > 10 && vips.total < 400 && vips.players.every((p) => p.vip), "filtered");
  const name = first.players[3].name;
  assert.ok(get(s, `/api/players?q=${encodeURIComponent(name.toLowerCase())}`).players.some((p) => p.name === name), "found by name");
  const kills = get(s, "/api/players?sort=kills&sortDir=desc&limit=20").players.map((p) => p.kills);
  assert.deepEqual(kills, [...kills].sort((a, b) => b - a), "sorted");

  const board = get(s, "/api/leaderboard?sort=combat&offset=10&limit=10");
  assert.equal(board.total, 400);
  assert.ok(board.leaderboard[0].combat <= get(s, "/api/leaderboard?sort=combat&offset=0&limit=10").leaderboard[9].combat, "the standings go on down the pages");

  const log = get(s, "/api/servers/s1/events?kinds=evt.kill&limit=50&offset=0");
  assert.ok(log.total > 100 && log.events.length === 50 && log.events.every((e) => e.kind === "evt.kill"));
  const who = log.events[0].actorPlayerId;
  assert.ok(get(s, `/api/servers/s1/events?player=${who}&limit=500`).events.every((e) => e.actorPlayerId === who || e.victimPlayerId === who), "one player's part of the log");

  const profile = get(s, `/api/players/${first.players[0].id}`);
  assert.equal(profile.player.name, first.players[0].name, "each player has a profile");
  assert.ok(Array.isArray(profile.statsByServer) && Array.isArray(profile.recentEvents));
  assert.equal(get(s, "/api/players/p1").player.name, "Caereca", "the stage's own players are still there");

  const rounds = get(s, "/api/servers/s1/matches?limit=25&offset=25");
  assert.equal(rounds.total, 60);
  assert.equal(rounds.matches.length, 25);
  assert.equal(get(s, `/api/matches/${rounds.matches[0].id}`).match.map, rounds.matches[0].map, "each round opens");
});

test("no id the demo or Help's pictures hand out can be a real player's", () => {
  const s = createDemoServer(STAFF_PANEL);
  // The first Steam account is 76561197960265728: an id from there up could be someone's.
  const real = (where, text) => [...text.matchAll(/(?<!\d)7656119\d{10}(?!\d)/g)].filter((m) => BigInt(m[0]) >= 76561197960265728n).map((m) => `${where}: ${m[0]}`);
  // What Help's pictures are taken from, whether or not the demo answers with it.
  const stage = stageAnswers(OWNER_GRANTS, STAFF_PANEL);
  const drawn = [];
  for (const [path, entry] of Object.entries(WALK_FIXTURES)) {
    const url = new URL(`http://stage${path}`);
    for (const method of ["GET", "POST"]) drawn.push(...real(`stage ${method} ${path}`, JSON.stringify((typeof entry === "function" ? entry(url, { method }) : entry) ?? null)));
  }
  for (const [path, entry] of Object.entries(stage)) drawn.push(...real(`stub ${path}`, JSON.stringify((typeof entry === "function" ? entry(new URL(`http://stage${path}`)) : entry) ?? null)));
  assert.deepEqual(drawn, [], "Help's pictures");
  const paths = new Set([...Object.keys(WALK_FIXTURES), ...Object.keys(stage)]);
  for (const p of ["/api/players?limit=500", "/api/servers/s1/events?limit=500", "/api/servers/s1/vips", "/api/bans", "/api/leaderboard?limit=500", "/api/servers/s1/live"]) paths.add(p);
  const first = get(s, "/api/players?limit=500").players;
  for (const p of first.slice(0, 20)) paths.add(`/api/players/${p.id}`);
  assert.deepEqual([...paths].flatMap((path) => real(path, JSON.stringify(ask(s, "GET", path).body ?? null))), [], "the demo");
  assert.ok(first.some((p) => p.platform === "steam") && first.some((p) => p.platform === "epic"), "players of both platforms");
});

test("a change the demo does not keep says so; the visitor's own settings and arrangements stay until reload", () => {
  const s = createDemoServer(STAFF_PANEL);
  const refused = ask(s, "POST", "/api/servers/s1/vips", { playerId: "x" });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.message, NOT_KEPT);

  assert.equal(ask(s, "PUT", "/api/me/prefs", { landing: "players" }).status, 200);
  assert.equal(get(s, "/api/me").prefs.landing, "players", "a setting is kept");
  assert.ok(get(s, "/api/me").prefs.setupSeen, "and setup is never asked for");

  const tiles = get(s, "/api/layout/dashboard").widgets;
  assert.ok(tiles.length > 5, "the dashboard a new install has");
  const flipped = { items: tiles.map((w, i) => ({ widgetId: w.id, visible: w.id === "dash-killfeed" ? false : w.visible, order: tiles.length - i })) };
  assert.equal(ask(s, "PUT", "/api/layout/dashboard", { config: flipped }).status, 200);
  const after = get(s, "/api/layout/dashboard");
  assert.equal(after.source, "user");
  assert.equal(after.widgets.find((w) => w.id === "dash-killfeed").visible, false, "arranged as the visitor left it");
  assert.equal(ask(s, "DELETE", "/api/layout/dashboard").body.removed, true);
  assert.equal(get(s, "/api/layout/dashboard").source, "default", "and back to the default");

  assert.equal(ask(s, "PUT", "/api/layout/panel:online", { config: { order: ["demo"] } }).status, 200);
  assert.deepEqual(get(s, "/api/layout/panel:online").config, { order: ["demo"] }, "a screen's panels as arranged");
  assert.equal(get(s, "/api/plugin-pages").pages.length, 0, "no plugins");
});

test("the demo's host is the build the page came with, so the menu never offers a reload for an update", () => {
  const m = get(createDemoServer(STAFF_PANEL, "0123abc"), "/api/health/metrics");
  assert.equal(m.appCommit, "0123abc", "the commit the page was built from");
  assert.equal(bundleIsStale("0123abc", m.appCommit), false);
  assert.equal(m.appVersion, null, "and no made-up version number");
  assert.ok(typeof m.cpuPct === "number" && typeof m.memory.pct === "number", "the figures the menu draws");
  assert.equal(get(createDemoServer(STAFF_PANEL), "/api/health/metrics").appCommit, BUILT_COMMIT, "this build's own, unless told");
});

test("the demo's server analytics have every day's hours, and a split by platform that adds up to the page's totals", () => {
  const a = get(createDemoServer(STAFF_PANEL), "/api/analytics/server?serverId=s1&days=30");
  const hours = a.concurrency.dayHour;
  assert.deepEqual(hours.map((d) => d.date), a.scores.daily.map((d) => d.date), "a row for every day");
  assert.ok(hours.every((d) => d.hours.length === 24 && d.hours.every((n) => Number.isInteger(n) && n >= 0 && n <= 100)), "players online each hour, up to a full server");
  assert.equal(Math.max(...hours.flatMap((d) => d.hours)), a.concurrency.peak, "the busiest hour is the window's peak");

  const rows = a.platform.rows;
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  assert.deepEqual(rows.map((r) => r.platform), ["steam", "epic"], "the community's own platforms");
  assert.deepEqual(
    [sum("players"), sum("newPlayers"), sum("sessions"), sum("shortSessions"), sum("playtimeSec")],
    [a.activity.uniquePlayers, a.mix.newPlayers, a.activity.sessions, a.activity.shortSessions, a.activity.totalSeconds],
    "the page's own totals",
  );
  for (const r of rows) {
    const days = a.platformTrend.rows.filter((t) => t.platform === r.platform);
    assert.equal(days.length, a.scores.daily.length, `${r.platform}: every day`);
    // The panel adds the days up this way, and each line of its chart ends at the table's number.
    const total = (k) => days.reduce((n, t) => n + t[k], 0);
    assert.deepEqual([total("firstPlayers"), total("firstNewPlayers"), total("firstVips"), total("kills"), total("slSeconds")], [r.players, r.newPlayers, r.vips, r.kills, r.slSeconds], r.platform);
    assert.ok(days.every((t) => t.firstPlayers <= t.players && t.firstNewPlayers <= t.firstPlayers && t.firstVips <= t.vips), `${r.platform}: nobody is met for the first time twice`);
    assert.ok(r.players < total("players") && r.vips < total("vips"), `${r.platform}: a regular counts once, not once a day`);
    assert.ok(r.kills > 0 && r.deaths > 0 && r.combat > 0 && r.scoredRounds === r.rounds, `${r.platform}: rounds played and scored`);
  }
  assert.deepEqual(a.vipDaily.map((d) => d.vips), a.scores.daily.map((d) => a.platformTrend.rows.filter((t) => t.date === d.date).reduce((n, t) => n + t.vips, 0)), "VIPs each day, every platform together");
});

test("the round on Live plays on, the stream says what happens in it, and a finished round joins the history", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2026-10-30T20:00:00Z") });
  try {
    const s = createDemoServer(STAFF_PANEL);
    const kills = (live) => live.players.reduce((n, p) => n + p.kills, 0);
    const start = get(s, "/api/servers/s1/live");
    const rotation = () => get(s, "/api/servers/s1/maprotation").mapRotation;
    const atStart = rotation();
    assert.ok(atStart.mAPS.length >= 3 && atStart.mAPS.every((m) => m.name && m.gameMode === "Warfare"), "the maps the server plays through");
    assert.equal(atStart.mAPS[atStart.currentIndex].name, start.session.mapName, "the one being played marked");
    assert.equal(start.session.playerCount, 98);
    assert.ok(start.session.alliedScore + start.session.axisScore >= 4 && start.session.remainingMatchTime < 90 * 60, "a round some way in, its sectors held");
    assert.ok(kills(start) > 100, "its kills so far on the scoreboard");
    const heard = [];
    const everyone = [];
    const stop = s.stream(new URL("http://demo/api/events/stream?token=demo&serverId=s1"), (d) => heard.push(JSON.parse(d)));
    const stopAll = s.stream(new URL("http://demo/api/events/stream?token=demo"), (d) => everyone.push(JSON.parse(d)));
    const quiet = [];
    const stopQuiet = s.stream(new URL("http://demo/api/events/stream?token=demo&serverId=s2"), (d) => quiet.push(d));
    mock.timers.tick(60_000);
    stopQuiet();
    assert.deepEqual(quiet, [], "the second server, where nothing is being played, hears nothing");
    assert.ok(heard.length >= 8, `a minute of the round: ${heard.length} things happened`);
    assert.ok(heard.every((e) => e.serverId === "s1" && e.kind.startsWith("evt.")));
    assert.equal(everyone.length, heard.length, "the same, unfiltered");
    const now = get(s, "/api/servers/s1/live");
    assert.equal(kills(now) - kills(start), heard.filter((e) => e.kind === "evt.kill").length, "Live's scoreboard counts the kills the feed showed");
    assert.ok(now.session.remainingMatchTime < start.session.remainingMatchTime, "the clock runs");
    assert.equal(get(s, "/api/servers/s1/events?limit=1").events[0].ts, heard.at(-1).ts, "the Game log has them too");

    stop();
    const was = heard.length;
    mock.timers.tick(10_000);
    assert.equal(heard.length, was, "a stream closed hears nothing more");
    // Ninety minutes on, the round is over (or won outright), another is under way, and the one played is in the history.
    for (let i = 0; i < 95; i++) mock.timers.tick(60_000);
    stopAll();
    assert.ok(everyone.some((e) => e.kind === "evt.match.ended") && everyone.some((e) => e.kind === "evt.match.started"));
    assert.ok(get(s, "/api/servers/s1/matches?limit=1").total > 60, "the round played is in the history");
    const later = rotation();
    const ended = everyone.filter((e) => e.kind === "evt.match.ended").length;
    assert.equal(later.currentIndex, (atStart.currentIndex + ended) % later.mAPS.length, `the rotation moves on a map for each of the ${ended} rounds played`);
    assert.equal(later.mAPS[later.currentIndex].name, get(s, "/api/servers/s1/live").session.mapName, "the one now being played");
  } finally {
    mock.timers.reset();
  }
});

test("the rotation the dashboard lists is the round Live plays, however long nobody looked", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2026-10-30T20:00:00Z") });
  try {
    const s = createDemoServer(STAFF_PANEL);
    mock.timers.tick(3 * 3_600_000);
    const rotation = get(s, "/api/servers/s1/maprotation").mapRotation;
    assert.equal(rotation.mAPS[rotation.currentIndex].name, get(s, "/api/servers/s1/live").session.mapName);
    assert.equal(get(s, "/api/servers/s1/matches?limit=1").matches[0].durationSec, 90 * 60, "the round whose clock ran out meanwhile lasted its ninety minutes, not the three hours");
  } finally {
    mock.timers.reset();
  }
});

test("a round in the demo lasts as long as one does: the one open goes on a while, and most run the clock", () => {
  const open = Date.parse("2026-10-30T20:00:00Z");
  mock.timers.enable({ apis: ["Date", "setInterval"], now: open });
  try {
    const s = createDemoServer(STAFF_PANEL);
    const ended = [];
    const stop = s.stream(new URL("http://demo/api/events/stream?token=demo"), (d) => { const e = JSON.parse(d); if (e.kind === "evt.match.ended") ended.push(Date.parse(e.ts)); });
    for (let i = 0; i < 24 * 60; i++) mock.timers.tick(60_000);
    stop();
    assert.ok(ended[0] - open >= 15 * 60_000, `the round on Live when the demo opens is still being played a quarter of an hour on (it ended after ${Math.round((ended[0] - open) / 60_000)} minutes)`);
    const minutes = get(s, "/api/servers/s1/matches?limit=500").matches.filter((m) => Number(m.id.slice(2)) > 60).map((m) => m.durationSec / 60);
    assert.ok(minutes.length >= 14 && minutes.length <= 24, `a day of rounds: ${minutes.length}`);
    assert.ok(minutes.filter((m) => m >= 89.5).length * 2 >= minutes.length, `most run the full ninety minutes: ${minutes.map(Math.round).join(", ")}`);
    assert.ok(Math.min(...minutes) >= 20, "none is won outright inside twenty minutes");
  } finally {
    mock.timers.reset();
  }
});

test("Live's feed opens on the round being played: its map, its start, and what has happened in it", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2026-10-30T20:00:00Z") });
  try {
    const s = createDemoServer(STAFF_PANEL);
    const live = get(s, "/api/servers/s1/live");
    const read = get(s, "/api/servers/s1/round/events?limit=1000");
    assert.equal(read.round.map, `${live.session.mapName} Warfare`, "the map Live is playing");
    assert.ok(Math.abs(Date.parse(read.round.startedAt) - (Date.now() - (90 * 60 - live.session.remainingMatchTime) * 1000)) <= 1000, "from when Live's clock started");
    assert.ok(read.events.length > 100 && read.events.every((e) => e.serverId === "s1" && e.ts >= read.round.startedAt), "what happened in it, nothing from before");
    assert.deepEqual(read.events.map((e) => e.ts), read.events.map((e) => e.ts).sort().reverse(), "newest first");
    assert.equal(read.events.filter((e) => e.kind === "evt.kill").length, live.players.reduce((n, p) => n + p.kills, 0), "the kills Live's scoreboard counts");
    assert.ok(!read.events.some((e) => ["p1", "p2", "p3"].includes(e.actorPlayerId)), "none of Help's pictures' players");
    assert.equal(get(s, "/api/servers/s1/round/events?limit=5").events.length, 5, "as many as asked for");
    const chat = get(s, "/api/servers/s1/round/events?kinds=evt.chat.team,evt.chat.squad&limit=1000").events;
    assert.ok(chat.length > 0 && chat.every((e) => e.kind.startsWith("evt.chat.")), "only the kinds asked for");
    // Read on its own, with nothing else asked in between, it has the round up to now.
    mock.timers.tick(30_000);
    assert.ok(get(s, "/api/servers/s1/round/events?limit=1").events[0].ts > read.events[0].ts, "the round played on to the moment it is read");

    // The next round, once this one is over: its own start, and only its own events.
    const stop = s.stream(new URL("http://demo/api/events/stream?token=demo&serverId=s1"), () => {});
    for (let i = 0; i < 70; i++) mock.timers.tick(60_000);
    stop();
    const next = get(s, "/api/servers/s1/round/events?limit=1000");
    assert.ok(next.round.startedAt > read.round.startedAt, "a new round");
    assert.equal(next.round.map, `${get(s, "/api/servers/s1/live").session.mapName} Warfare`);
    assert.equal(next.events.at(-1).kind, "evt.match.started", "it opens with the round's start");
    assert.ok(next.events.every((e) => e.ts >= next.round.startedAt));
  } finally {
    mock.timers.reset();
  }
});

test("the demo's ban record searches as the real one does, and shows lifted and ended bans only when asked", () => {
  const s = createDemoServer(STAFF_PANEL);
  const all = get(s, "/api/bans?history=1").bans;
  const current = get(s, "/api/bans").bans;
  assert.ok(all.some((b) => !b.active) && current.length > 0, "some lifted or ended, some in force");
  assert.deepEqual(current.map((b) => b.id), all.filter((b) => b.active).map((b) => b.id), "only those in force, unless asked for");
  const name = all[0].playerName;
  const found = get(s, `/api/bans?history=1&q=${encodeURIComponent(name.toLowerCase())}`).bans;
  assert.ok(found.length >= 1 && found.length < all.length && found.every((b) => b.playerName === name || `${b.reason} ${b.category} ${b.by}`.toLowerCase().includes(name.toLowerCase())), "a search narrows them");
  const cheats = get(s, "/api/bans?history=1&q=cheating").bans;
  assert.ok(cheats.length > 0 && cheats.every((b) => b.category === "cheating" || /cheating/i.test(b.reason)), "by reason");
  assert.equal(get(s, "/api/bans?history=1&q=server%20%232").bans.length, all.length, "a ban that covers every server is found by either server's name");
});

test("the demo's watchlist is the community's watched players, those playing now first, each with why", () => {
  const s = createDemoServer(STAFF_PANEL);
  const flags = get(s, "/api/players/flagged").flags;
  const watched = get(s, "/api/players?watched=1&limit=500");
  assert.deepEqual(flags.map((f) => f.playerId).sort(), watched.players.map((p) => p.id).sort(), "everyone the directory marks as watched");
  const playing = new Set(get(s, "/api/servers/s1/live").players.map((p) => p.id));
  assert.ok(flags.every((f) => f.watchlist && f.online === playing.has(f.playerId) && f.onlineServers.length === Number(f.online)), "online when on Live's roster");
  const firstAway = flags.findIndex((f) => !f.online);
  assert.ok(firstAway > 0 && flags.slice(firstAway).every((f) => !f.online), "those playing now first");
  const away = flags.slice(firstAway).map((f) => f.updatedAt);
  assert.deepEqual(away, [...away].sort().reverse(), "then the most recently flagged");
  assert.ok(flags.every((f) => f.name && f.watchReason && f.reasons[0].reason === f.watchReason && f.watchBy && f.watchAt), "who, why, by whom and since when");
});

test("every filter the demo's lists offer narrows them: a player's activity, the directory, a server's board", () => {
  const s = createDemoServer(STAFF_PANEL);
  const log = get(s, "/api/servers/s1/events?limit=500").events;
  // Someone whose part of the log is more than kills.
  const someone = log.find((e) => e.kind === "evt.kill" && log.some((o) => o.actorPlayerId === e.actorPlayerId && o.kind !== "evt.kill")).actorPlayerId;
  const all = get(s, `/api/players/${someone}/events?limit=200`);
  const kills = get(s, `/api/players/${someone}/events?kinds=evt.kill&limit=200`);
  assert.ok(kills.total > 0 && kills.total < all.total && kills.events.every((e) => e.kind === "evt.kill"), "a player's activity, by kind");
  assert.equal(get(s, `/api/players/${someone}/events?serverId=s2`).total, 0, "and by server");
  assert.equal(get(s, `/api/players/${someone}/events?serverId=s1`).total, all.total);

  const owl = get(s, "/api/players?clan=owl&limit=500");
  assert.ok(owl.total > 0 && owl.total < 400 && owl.players.every((p) => p.name.startsWith("[OWL] ")), "the directory, by clan");
  assert.equal(get(s, "/api/players?clan=%5BOWL%5D&limit=500").total, owl.total, "[OWL] and owl are one clan");
  const forGood = new Set(get(s, "/api/bans").bans.filter((b) => b.type === "perma").map((b) => b.playerId));
  const banned = get(s, "/api/players?permaBanned=1&limit=500");
  assert.ok(banned.total > 0 && banned.total === new Set([...forGood]).size && banned.players.every((p) => forGood.has(p.platformId)), "by a ban for good");
  assert.equal(get(s, "/api/players?serverId=s1").total, 400, "by server: everyone plays on the first");
  assert.equal(get(s, "/api/players?serverId=s2").total, 0, "and the second has seen nobody");
  assert.equal(get(s, "/api/players?game=hllv").total, 0, "by game");

  assert.equal(get(s, "/api/leaderboard?serverId=s1").total, 400, "a server's board");
  assert.equal(get(s, "/api/leaderboard?serverId=s2").total, 0);
});

test("the game log read a page at a time keeps to the moment its first page was read, as the round plays on", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2026-10-30T20:00:00Z") });
  try {
    const s = createDemoServer(STAFF_PANEL);
    const before = get(s, "/api/servers/s1/events?limit=100&offset=0").events;
    const first = get(s, "/api/servers/s1/events?limit=50&offset=0");
    assert.ok(first.anchor, "page one says the moment it was read");
    // The round plays on, and ends: new rows on top.
    const stop = s.stream(new URL("http://demo/api/events/stream?token=demo&serverId=s1"), () => {});
    for (let i = 0; i < 70; i++) mock.timers.tick(60_000);
    stop();
    const second = get(s, `/api/servers/s1/events?limit=50&offset=50&anchor=${encodeURIComponent(first.anchor)}`);
    assert.deepEqual(second.events.map((e) => e.ts), before.slice(50).map((e) => e.ts), "page two goes on from page one");
    assert.equal(second.total, first.total, "the same read");
    assert.notDeepEqual(get(s, "/api/servers/s1/events?limit=50&offset=50").events.map((e) => e.ts), second.events.map((e) => e.ts), "unpinned, the rows would have moved");
    assert.ok(get(s, "/api/servers/s1/events?limit=1").total > first.total, "a new read has what happened since");
  } finally {
    mock.timers.reset();
  }
});

test("the round never adds anything to a moment already read, however often it is read", () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2026-10-30T20:00:00Z") });
  try {
    const s = createDemoServer(STAFF_PANEL);
    const upTo = (at) => get(s, `/api/servers/s1/events?limit=1&to=${encodeURIComponent(at)}`).total;
    const read = [];
    for (let i = 0; i < 300; i++) {
      // Reads at uneven moments, some between two things happening, some across several.
      mock.timers.tick(500 + (i % 7) * 300);
      get(s, "/api/servers/s1/live");
      const at = new Date(Date.now()).toISOString();
      read.push([at, upTo(at)]);
    }
    for (const [at, n] of read) assert.equal(upTo(at), n, `nothing was added before ${at} once that moment was read`);
  } finally {
    mock.timers.reset();
  }
});
