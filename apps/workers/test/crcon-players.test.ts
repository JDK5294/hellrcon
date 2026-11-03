/**
 * CRCON's per-round player cache (record_player_stats in rcon/logs/loop.py, v12.3.0) and the
 * roster parsing under it (parse_raw_player_info against hllrcon 2.0.0.6's tables).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crconDetailedPlayer, recordCrconPlayers, type CrconDetailedPlayer } from "../src/crcon-players.ts";

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Able", iD: "76561190000000001", platform: "steam", clanTag: "", team: 1, role: 0, platoon: "ABLE", level: 40, loadout: "standard",
  stats: { infantryKills: 3, deaths: 2, teamKills: 0, vehicleKills: 1, vehiclesDestroyed: 0 },
  scoreData: { cOMBAT: 10, offense: 20, defense: 30, support: 40 },
  worldPosition: { x: 1, y: 2, z: 3 },
  ...over,
});

test("a roster entry reads as CRCON's detailed player: side from the faction, squad from the platoon's letter", () => {
  assert.deepEqual(crconDetailedPlayer(raw(), "hll"), {
    name: "Able", team: "allies", role: 0, unitId: 0, level: 40, kills: 3, deaths: 2,
    combat: 10, offense: 20, defense: 30, support: 40, vehicleKills: 1, vehiclesDestroyed: 0,
    worldPosition: { x: 1, y: 2, z: 3 },
  });
  const p = (over: Record<string, unknown>, game = "hll") => crconDetailedPlayer(raw(over), game);
  assert.equal(p({ team: 0 }).team, "axis", "Germany");
  assert.equal(p({ team: 4 }).team, "axis", "the Afrika Korps");
  assert.equal(p({ team: 6 }).team, "allies", "Canada");
  assert.equal(p({ team: 7 }).team, null, "unassigned");
  assert.equal(p({ team: 9 }).team, null, "a faction hllrcon does not know");
  assert.equal(p({ platoon: "BAKER" }).unitId, 1);
  assert.equal(p({ platoon: "" }).unitId, 0, "no squad is squad 0, like Able");
  assert.equal(p({ platoon: "able" }).unitId, 32, "ord() of the first letter, whatever its case");
  assert.equal(p({ role: 13, platoon: "" }).unitId, -1, "the commander is unit -1");
  assert.equal(p({ role: 42 }).role, null, "a role hllrcon does not know");
  assert.equal(p({ team: 6 }, "hllv").team, "axis", "Vietnam's NVA");
  assert.equal(p({ team: 1 }, "hllv").team, "allies");
  assert.equal(p({ team: 0 }, "hllv").team, null, "Vietnam's unassigned");
  assert.equal(p({ role: 20, platoon: "" }, "hllv").unitId, -1, "Vietnam's commander");
  assert.equal(p({ role: 1 }, "hllv").role, null, "no Assault in Vietnam");
});

test("an entry CRCON cannot parse becomes its fallback record: zeros, no side, no unit", () => {
  assert.deepEqual(crconDetailedPlayer(raw({ stats: undefined }), "hll"), {
    name: "Able", team: null, role: null, unitId: null, level: 0, kills: 0, deaths: 0,
    combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
    worldPosition: { x: 0, y: 0, z: 0 },
  });
  assert.equal(crconDetailedPlayer(raw({ level: "x" }), "hll").unitId, null);
});

const START = 1_760_000_000;
const player = (over: Partial<CrconDetailedPlayer> = {}): CrconDetailedPlayer => ({
  name: "Able", team: "allies", role: 0, unitId: 1, level: 40, kills: 3, deaths: 2,
  combat: 10, offense: 20, defense: 30, support: 40, vehicleKills: 1, vehiclesDestroyed: 0,
  worldPosition: { x: 1, y: 2, z: 3 }, ...over,
});
const roster = (...entries: [string, CrconDetailedPlayer][]) => new Map(entries);

test("a player first seen gets a line of zeros and an unassigned unit, and nothing more from that sample", () => {
  const cache = recordCrconPlayers([], roster(["a", player()]), 200, START, START + 200);
  assert.deepEqual(cache, [["a", {
    combat: 0, p_combat: 0, offense: 0, p_offense: 0, defense: 0, p_defense: 0, support: 0, p_support: 0,
    vehicle_kills: 0, p_vehicle_kills: 0, vehicles_destroyed: 0, p_vehicles_destroyed: 0,
    kills_and_assists: 0, p_kills_and_assists: 0, deaths_and_redeploys: 0, p_deaths_and_redeploys: 0,
    p_unit: { ts: 200, team: -111, squad: -111, role: -111 }, units: [], level: 40,
    p_coord: { x: 1, y: 2, z: 3 }, has_spawned: false, names: ["Able"], status: "online",
  }]]);
});

test("the round's first two minutes add and mark players but record nothing else", () => {
  const first = recordCrconPlayers([], roster(["a", player()]), 10, START, START + 10);
  const held = recordCrconPlayers(first, roster(["a", player({ worldPosition: { x: 9, y: 9, z: 9 }, combat: 99 })], ["b", player({ name: "Baker" })]), 120, START, START + 120);
  assert.deepEqual(held[0], first[0], "120 seconds in is still inside the window");
  assert.equal(held[1]![0], "b", "a newcomer is still added");
  const gone = recordCrconPlayers(held, roster(["b", player({ name: "Baker" })]), 60, START, START + 60);
  assert.equal(gone[0]![1].status, "offline", "a leaver is still marked");
  assert.deepEqual(gone[0]![1].units, [{ ts: 60, team: -111, squad: -111, role: -111 }]);
});

test("the first move takes the game's figures as they stand; a later drop is a reconnect, banked", () => {
  let cache = recordCrconPlayers([], roster(["a", player()]), 130, START, START + 130);
  // Moved, and the leaked opening figures were lower than nothing: taken as they are, not banked.
  cache = recordCrconPlayers(cache, roster(["a", player({ worldPosition: { x: 5, y: 2, z: 3 }, combat: 50, kills: 4, deaths: 1 })]), 140, START, START + 140);
  let a = cache[0]![1];
  assert.equal(a.has_spawned, true);
  assert.deepEqual([a.combat, a.p_combat, a.kills_and_assists, a.deaths_and_redeploys], [50, 0, 4, 1]);
  assert.deepEqual(a.units, [{ ts: 140, team: 1, squad: 1, role: 0 }], "the unassigned opening unit gives way to the real one");
  // Gone, then back with the game's counters reset: the old totals go to p_*.
  cache = recordCrconPlayers(cache, roster(), 150, START, START + 150);
  assert.equal(cache[0]![1].status, "offline");
  cache = recordCrconPlayers(cache, roster(["a", player({ worldPosition: { x: 7, y: 2, z: 3 }, combat: 5, kills: 1, deaths: 0, name: "Able2" })]), 160, START, START + 160);
  a = cache[0]![1];
  assert.equal(a.status, "online");
  assert.deepEqual([a.combat, a.p_combat, a.kills_and_assists, a.p_kills_and_assists, a.deaths_and_redeploys, a.p_deaths_and_redeploys], [5, 50, 1, 4, 0, 1]);
  assert.deepEqual(a.units, [
    { ts: 140, team: 1, squad: 1, role: 0 },
    { ts: 150, team: -111, squad: -111, role: -111 },
    { ts: 160, team: 1, squad: 1, role: 0 },
  ]);
  assert.deepEqual(a.names, ["Able", "Able2"], "a new name joins the list");
  assert.deepEqual(a.p_unit, { ts: 160, team: 1, squad: 1, role: 0 });
});

test("figures read before a player first moves are not banked when the spawn resets them", () => {
  // The game shows the last round's figures until a player loads in; CRCON records them, then
  // takes the first moving sample as it stands rather than banking the leaked totals.
  let cache = recordCrconPlayers([], roster(["a", player()]), 130, START, START + 130);
  cache = recordCrconPlayers(cache, roster(["a", player({ combat: 300 })]), 140, START, START + 140);
  assert.deepEqual([cache[0]![1].combat, cache[0]![1].has_spawned], [300, false]);
  cache = recordCrconPlayers(cache, roster(["a", player({ combat: 5, worldPosition: { x: 4, y: 2, z: 3 } })]), 150, START, START + 150);
  assert.deepEqual([cache[0]![1].combat, cache[0]![1].p_combat, cache[0]![1].has_spawned], [5, 0, true]);
});

test("a figure that did not drop is replaced, not banked; a unit leg only when side, squad or role moves", () => {
  let cache = recordCrconPlayers([], roster(["a", player()]), 130, START, START + 130);
  cache = recordCrconPlayers(cache, roster(["a", player({ worldPosition: { x: 5, y: 2, z: 3 } })]), 140, START, START + 140);
  cache = recordCrconPlayers(cache, roster(["a", player({ combat: 80, level: 41 })]), 150, START, START + 150);
  cache = recordCrconPlayers(cache, roster(["a", player({ combat: 90, role: 3 })]), 160, START, START + 160);
  const a = cache[0]![1];
  assert.deepEqual([a.combat, a.p_combat, a.level], [90, 0, 40], "level follows the roster");
  assert.deepEqual(a.units.map((u) => u.ts), [140, 160], "the medic swap is a leg; the level change is not");
});

test("players keep the order they were first seen in, and the cache passed in is untouched", () => {
  const first = recordCrconPlayers([], roster(["b", player({ name: "B" })], ["a", player()]), 130, START, START + 130);
  const snapshot = JSON.stringify(first);
  const next = recordCrconPlayers(first, roster(["a", player()], ["c", player({ name: "C" })], ["b", player({ name: "B" })]), 140, START, START + 140);
  assert.deepEqual(next.map(([id]) => id), ["b", "a", "c"]);
  assert.equal(JSON.stringify(first), snapshot);
});
