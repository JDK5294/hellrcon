/**
 * CRCON's player statistics (rcon/player_stats.py, v12.3.0) and the log lines they read, against
 * values worked out by hand from CRCON's own rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crconLiveStats, crconRows, crconStatsByPlayer, crconTimeWindowStats, type CrconLogLine } from "../dist/crcon-stats.js";
import { crconLogLines } from "../dist/crcon-logs.js";
import { pyDumps } from "../dist/crcon-json.js";
import type { CrconPlayerCache, CrconPlayerStat, EvtRow } from "@app/db";

const T = Date.UTC(2026, 9, 12, 20, 0, 0);
const at = (sec: number) => T + sec * 1000;
const line = (action: string, sec: number, over: Partial<CrconLogLine> = {}): CrconLogLine => ({
  action, timestampMs: at(sec), player_name_1: null, player_id_1: null, player_name_2: null, player_id_2: null, weapon: null, raw: "", ...over,
});
const kill = (sec: number, a: [string, string], v: [string, string], weapon: string, action = "KILL") =>
  line(action, sec, { player_id_1: a[0], player_name_1: a[1], player_id_2: v[0], player_name_2: v[1], weapon });
const ABLE: [string, string] = ["p1", "Able"];
const BAKER: [string, string] = ["p2", "Baker"];
const CHARLIE: [string, string] = ["p3", "Charlie"];
const DOG: [string, string] = ["p4", "Dog"];
const EASY: [string, string] = ["p5", "Easy"];
const noPlatform = () => null;

test("a player's figures from their log lines, as BaseStats counts them", () => {
  const logs = [
    line("CONNECTED", 0, { player_id_1: "p1", player_name_1: "Able" }),
    kill(60, ABLE, BAKER, "M1 GARAND"),
    kill(70, ABLE, CHARLIE, "M1 GARAND"),
    kill(100, BAKER, ABLE, "MP40"),
    kill(130, ABLE, DOG, "M1 GARAND", "TEAM KILL"),
    kill(150, ABLE, BAKER, "THOMPSON"),
    kill(200, EASY, ABLE, "KAR98K", "TEAM KILL"),
    line("VOTE STARTED", 210, { player_id_1: "p1", player_name_1: "Able", player_id_2: "p2", player_name_2: "Baker" }),
    line("VOTE", 220, { player_id_1: "p1", player_name_1: "Able", raw: "VOTESYS: Player [Able] voted [PV_Favour] for VoteID[2]" }),
    line("VOTE", 230, { player_id_1: "p1", player_name_1: "Able", raw: "VOTESYS: Player [Able] voted [PV_Ignored] for VoteID[3]" }),
    line("DISCONNECTED", 300, { player_id_1: "p1", player_name_1: "Able" }),
  ];
  const figures = crconStatsByPlayer(new Map([["p1", logs]]), [{ name: "Able", player_id: "p1" }], {
    storedPlatform: () => "steam", sessionTime: () => 600, firstAppearance: () => at(-10),
  });
  const a = figures.get("p1")!;
  assert.deepEqual(
    [a.kills, a.deaths, a.teamkills, a.deaths_by_tk, a.nb_vote_started, a.nb_voted_yes, a.nb_voted_no],
    [3, 1, 1, 1, 1, 1, 0],
    "a team kill counts as neither a kill nor a death",
  );
  assert.deepEqual([...a.weapons], [["M1 GARAND", 2], ["THOMPSON", 1]], "team kills add no weapon");
  assert.deepEqual([...a.most_killed], [["p2", 2], ["p3", 1]], "keyed by the victim's id, first met first");
  assert.deepEqual([...a.death_by], [["p2", 1]], "a team kill names no killer here either");
  assert.deepEqual([...a.death_by_weapons], [["MP40", 1]]);
  assert.deepEqual([a.kills_streak, a.deaths_without_kill_streak, a.teamkills_streak, a.deaths_by_tk_streak], [2, 1, 1, 1]);
  // CONNECTED moved the spawn to 0; the deaths at 100 and 200 lived 100 seconds each; the
  // disconnect at 300 measures 100 more without moving the spawn.
  assert.deepEqual([a.longest_life_secs, a.shortest_life_secs, a.lastSpawnMs], [100, 0, at(200)], "the shortest life never leaves 0");
  assert.equal(a.platform, "steam");
  const [row] = crconRows(figures, null, { publish: true });
  const json = pyDumps(row);
  assert.ok(json.includes(`"time_seconds":600,"last_spawn":"2026-10-12T20:03:20+00:00","kills_per_minute":0.3,"deaths_per_minute":0.1,"kill_death_ratio":3.0,`), json);
});

test("a row starts as get_default_player_stats; the rates stay the int 0 until a line is read", () => {
  const figures = crconStatsByPlayer(new Map(), [{ name: "Able", player_id: "p1", platform: "epic" }], {
    storedPlatform: () => "steam", sessionTime: () => 125.9, firstAppearance: () => null,
  });
  assert.equal(pyDumps(crconRows(figures, null, { publish: true })),
    `[{"id":0,"player_id":"p1","player":"Able","platform":"epic","steaminfo":null,"map_id":0,"kills":0,"kills_streak":0,`
    + `"deaths":0,"deaths_without_kill_streak":0,"teamkills":0,"teamkills_streak":0,"deaths_by_tk":0,"deaths_by_tk_streak":0,`
    + `"nb_vote_started":0,"nb_voted_yes":0,"nb_voted_no":0,"time_seconds":125,"last_spawn":null,"kills_per_minute":0,`
    + `"deaths_per_minute":0,"kill_death_ratio":0,"longest_life_secs":0,"shortest_life_secs":0,"combat":0,"offense":0,`
    + `"defense":0,"support":0,"most_killed":{},"death_by":{},"weapons":{},"death_by_weapons":{},"team":null,"units":[],`
    + `"level":0,"vehicles_destroyed":0,"vehicle_kills":0,"kills_and_assists":0,"deaths_and_redeploys":0}]`);
  const ids = crconStatsByPlayer(new Map(), [{ name: "Able", player_id: "p1" }, { name: "Able2", player_id: "p1" }, { name: "Baker", player_id: "p2", platform: "" }], {
    storedPlatform: (id) => (id === "p2" ? "xsx" : null), sessionTime: () => 0, firstAppearance: () => null,
  });
  assert.deepEqual([...ids.values()].map((f) => [f.player_id, f.player, f.platform]), [["p1", "Able2", null], ["p2", "Baker", "xsx"]],
    "an id's last record, at its first place; an empty platform falls back to the stored one");
});

test("the round's cache is laid over a row it holds: buckets summed, side and faction, status, and no id, map_id or units", () => {
  const cached = (over: Partial<CrconPlayerStat>): CrconPlayerStat => ({
    combat: 10, p_combat: 5, offense: 20, p_offense: 0, defense: 30, p_defense: 1, support: 40, p_support: 2,
    vehicle_kills: 1, p_vehicle_kills: 1, vehicles_destroyed: 2, p_vehicles_destroyed: 0,
    kills_and_assists: 7, p_kills_and_assists: 3, deaths_and_redeploys: 4, p_deaths_and_redeploys: 1,
    p_unit: { ts: 100, team: 2, squad: 1, role: 0 }, units: [{ ts: 100, team: 2, squad: 1, role: 0 }],
    level: 55, p_coord: { x: 0, y: 0, z: 0 }, has_spawned: true, names: ["Able"], status: "offline", ...over,
  });
  const cache: CrconPlayerCache = [["p1", cached({})], ["p3", cached({ p_unit: { ts: 5, team: -111, squad: -111, role: -111 }, status: "online" })]];
  const figures = crconStatsByPlayer(new Map(), [{ name: "Able", player_id: "p1" }, { name: "Baker", player_id: "p2" }, { name: "Charlie", player_id: "p3" }], {
    storedPlatform: noPlatform, sessionTime: () => 0, firstAppearance: () => null,
  });
  const rows = crconRows(figures, { name: "carentan_warfare", playerStats: cache }, { publish: true });
  assert.equal(pyDumps(rows[0]),
    `{"player_id":"p1","player":"Able","platform":null,"steaminfo":null,"kills":0,"kills_streak":0,"deaths":0,`
    + `"deaths_without_kill_streak":0,"teamkills":0,"teamkills_streak":0,"deaths_by_tk":0,"deaths_by_tk_streak":0,`
    + `"nb_vote_started":0,"nb_voted_yes":0,"nb_voted_no":0,"time_seconds":0,"last_spawn":null,"kills_per_minute":0,`
    + `"deaths_per_minute":0,"kill_death_ratio":0,"longest_life_secs":0,"shortest_life_secs":0,"combat":15,"offense":20,`
    + `"defense":31,"support":42,"most_killed":{},"death_by":{},"weapons":{},"death_by_weapons":{},"team":"axis","level":55,`
    + `"vehicles_destroyed":2,"vehicle_kills":2,"kills_and_assists":10,"deaths_and_redeploys":5,"faction":"ger","status":"offline"}`);
  assert.equal(Object.keys(rows[1]!)[0], "id", "a player the cache does not hold keeps the defaults");
  assert.deepEqual([rows[2]!.team, rows[2]!.faction, rows[2]!.status], [null, null, "online"], "an unassigned unit has no side");
  // CRCON reads the faction with the WWII parser whatever the game: a Vietnam layer gets its placeholder.
  const vietnam = crconRows(figures, { name: "wdevc_warfare_day", playerStats: cache }, { publish: true });
  assert.equal(vietnam[0]!.faction, "ger");
});

test("a server keeping ids private keys nemeses by name and withholds the player's own id", () => {
  const logs = [kill(10, ABLE, BAKER, "M1 GARAND"), kill(20, ABLE, ["p9", "Baker"], "M1 GARAND"), kill(30, CHARLIE, ABLE, "MP40")];
  const figures = crconStatsByPlayer(new Map([["p1", logs]]), [{ name: "Able", player_id: "p1" }], {
    storedPlatform: noPlatform, sessionTime: () => 60, firstAppearance: () => null,
  });
  const names: Record<string, string> = { p2: "Baker", p9: "Baker", p3: "Charlie" };
  const [row] = crconRows(figures, null, { publish: false, nameOf: (id) => names[id] ?? null });
  assert.equal(row!.player_id, null);
  assert.deepEqual([...(row!.most_killed as Map<string, number>)], [["Baker", 2]], "two ids sharing a name share a key");
  assert.deepEqual([...(row!.death_by as Map<string, number>)], [["Charlie", 1]]);
});

test("LiveStats reads each connected player's current session, and only lines it can file under an id", () => {
  const now = at(1000);
  const sessions: Record<string, { startMs: number | null; ended: boolean }> = {
    p1: { startMs: at(700), ended: false },
    p2: { startMs: at(100), ended: true },
  };
  const logs = [
    kill(650, ABLE, CHARLIE, "M1 GARAND"),
    kill(700, ABLE, CHARLIE, "M1 GARAND"),
    kill(800, ABLE, BAKER, "M1 GARAND"),
    line("VOTE", 810, { player_name_1: "Able", raw: "PV_Favour" }),
    line("VOTE", 820, { player_name_1: "Able", player_id_1: "p1", raw: "PV_Favour" }),
  ];
  const run = (nowMs: number) => crconLiveStats({
    nowMs,
    players: [{ name: "Baker", player_id: "p2", platform: "ps5" }, { name: "Able", player_id: "p1", platform: "steam" }, { name: "Nobody", player_id: "" }, { name: "Charlie", player_id: "p3" }],
    session: (id) => sessions[id] ?? null,
    storedPlatform: noPlatform,
    logs,
  });
  const live = run(now);
  assert.deepEqual([...live.keys()], ["p2", "p1", "p3"], "the game's order; a player without an id is dropped");
  const able = live.get("p1")!;
  assert.deepEqual([able.time_seconds, able.kills, able.nb_voted_yes, able.lastSpawnMs], [300, 2, 1, at(700)],
    "the kill at the session's first second counts; the vote without an id is filed under nobody");
  const baker = live.get("p2")!;
  assert.deepEqual([baker.time_seconds, baker.deaths, baker.lastSpawnMs, baker.rated], [0, 0, at(100), false],
    "an ended session counts nothing, but its start is still the first appearance");
  assert.deepEqual([live.get("p3")!.time_seconds, live.get("p3")!.lastSpawnMs], [0, null], "no profile: no time, no spawn");
  // Half a second later the session is still 300 whole seconds, so it reads from 700.5: the
  // line at 700 falls outside it.
  assert.equal(run(now + 500).get("p1")!.kills, 1);
});

test("TimeWindowStats pieces sessions together from connects and disconnects, and guesses a first sighting late", () => {
  const F = at(0);
  const U = at(3600);
  const logs = [
    kill(60, CHARLIE, ABLE, "MP40"),
    line("CONNECTED", 600, { player_id_1: "p2", player_name_1: "Baker" }),
    line("DISCONNECTED", 900, { player_id_1: "p4", player_name_1: "Dog" }),
    line("DISCONNECTED", 1200, { player_id_1: "p2", player_name_1: "Baker" }),
    line("CONNECTED", 1500, { player_id_1: "p2", player_name_1: "Baker" }),
    line("CONNECTED", 1600, { player_id_1: "p5", player_name_1: "Easy" }),
    line("CONNECTED", 1700, { player_id_1: "p5", player_name_1: "Easy" }),
    line("VOTE", 1800, { player_name_1: "Able", raw: "PV_Against" }),
    line("VOTE", 1810, { player_name_1: "Stranger", raw: "PV_Against" }),
    line("TEAMSWITCH", 1900, { player_name_1: "Able2" }),
  ];
  const cache: CrconPlayerCache = [["p1", { names: ["Able", "Able2"] } as CrconPlayerStat]];
  const stats = crconTimeWindowStats({ logs, fromMs: F, untilMs: U, cooldownSec: 100, cachedPlayers: cache, storedPlatform: () => "steam" });
  assert.deepEqual([...stats.keys()], ["p3", "p1", "p2", "p4", "p5"], "everyone a line names, by an id or a name the cache knows");
  const row = (id: string) => stats.get(id)!;
  // Able: first seen at 60 without a connect, credited from 180; open at the end, so to 3500.
  assert.deepEqual([row("p1").time_seconds, row("p1").lastSpawnMs, row("p1").nb_voted_no, row("p1").player], [3320, at(60), 1, "Able2"]);
  assert.deepEqual([row("p1").longest_life_secs, row("p1").shortest_life_secs], [0, -120], "a death before the guessed spawn is a negative life");
  assert.equal(row("p2").time_seconds, 600 + 2000, "600 to 1200, then 1500 to the end less the cooldown");
  assert.deepEqual([row("p4").time_seconds, row("p4").lastSpawnMs], [0, at(900)], "a disconnect alone is a session of nothing");
  assert.equal(row("p5").time_seconds, 0, "two connects and no disconnect: CRCON gives up on the session");
  assert.equal(row("p3").platform, "steam");
  // Live, the window runs to now with no cooldown.
  const live = crconTimeWindowStats({ logs, fromMs: F, untilMs: U, cooldownSec: 0, cachedPlayers: cache, storedPlatform: noPlatform });
  assert.equal(live.get("p1")!.time_seconds, 3420);
});

const evt = (kind: string, sec: number, over: Partial<EvtRow> = {}): EvtRow => ({
  id: `e${sec}`, serverId: "s", ts: new Date(at(sec)).toISOString(), kind,
  actorPlayerId: null, actorName: null, victimPlayerId: null, victimName: null, weapon: null, data: null, dedupeKey: null, ...over,
});

test("our events read as the lines CRCON's parser and log loop keep", () => {
  const platform: Record<string, string> = { u1: "p1", u2: "p2", u3: "p3" };
  const round = (startSec: number, endSec: number | null, players: CrconPlayerCache) => ({ startMs: at(startSec), endMs: endSec === null ? null : at(endSec), players });
  const statOf = (names: string[], status: "online" | "offline") => ({ names, status }) as CrconPlayerStat;
  const events = [
    evt("evt.vote.cast", 50, { actorName: "Able", data: { choice: "PV_Favour", content: "VOTESYS: Player [Able] voted [PV_Favour] for VoteID[1]" } }),
    evt("evt.kill", 20, { actorPlayerId: "u1", actorName: "Able", victimPlayerId: "u2", victimName: "Baker", weapon: "M1 GARAND", data: { playerTeam: "Allies", victimTeam: "Axis" } }),
    evt("evt.kill", 30, { actorPlayerId: "u1", actorName: "Able", victimPlayerId: "u2", victimName: "Baker", weapon: "M1 GARAND", data: { playerTeam: "None", victimTeam: "Axis" } }),
    evt("evt.kill", 32, { actorPlayerId: "u1", actorName: "Able", victimPlayerId: "u2", victimName: "Baker", weapon: "M1 GARAND", data: { playerTeam: null, victimTeam: null } }),
    evt("evt.kill", 33, { actorPlayerId: "u2", actorName: "Baker", victimPlayerId: "u1", victimName: "Able", weapon: "MP40" }),
    evt("evt.admin.camera", 35, { actorPlayerId: "u3", actorName: "Charlie", data: { entered: true } }),
    evt("evt.player.teamSwitched", 40, { actorPlayerId: "u2", actorName: "Shared" }),
    evt("evt.vote.started", 45, { actorName: "Baker", data: { target: "Able" } }),
    evt("evt.vote.cast", 500, { actorName: "Able", data: { content: "VOTESYS: Player [Able] voted [PV_Against] for VoteID[2]" } }),
  ];
  const lines = crconLogLines(events, (id) => platform[id] ?? null, [
    round(0, 100, [["p1", statOf(["Able", "Shared"], "offline")], ["p2", statOf(["Baker", "Shared"], "online")]]),
  ]);
  assert.deepEqual(lines.map((l) => [l.action, l.timestampMs - T, l.player_id_1, l.player_name_1, l.player_id_2, l.player_name_2]), [
    ["KILL", 20000, "p1", "Able", "p2", "Baker"],
    ["KILL", 33000, "p2", "Baker", "p1", "Able"],
    ["TEAMSWITCH", 40000, "p2", "Shared", null, null],
    ["VOTE STARTED", 45000, "p2", "Baker", "p1", "Able"],
    ["VOTE", 50000, "p1", "Able", null, null],
    ["VOTE", 500000, null, "Able", null, null],
  ], "oldest first; a kill tagged other than Allies/Axis (or untagged) and the camera line are not CRCON lines, a kill stored before tags were kept is; names resolve inside the round only, an online player taking a shared name");
  assert.equal(lines[4]!.raw, "VOTESYS: Player [Able] voted [PV_Favour] for VoteID[1]");
  assert.equal(lines[0]!.weapon, "M1 GARAND");
});
