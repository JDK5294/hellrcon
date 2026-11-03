/**
 * calc_weapon_type_usage and PlayerStats.detect_team (rcon/models.py, v12.3.0), over CRCON's own
 * weapon tables, as bytes: a ratio is an int or a float exactly where Python's is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crconDetectTeam, crconWeaponTypeUsage } from "../dist/crcon-weapons.js";
import { jsonbOrdered, pyDumps } from "../dist/crcon-json.js";

const leg = (ts: number, team: number) => ({ ts, team, squad: 0, role: 0 });
const team = (units: { ts: number; team: number; squad: number; role: number }[] | null, matchTime: number | null, weapons: Record<string, number> = {}, deaths: Record<string, number> = {}) =>
  pyDumps(crconDetectTeam(units, matchTime, jsonbOrdered(weapons), jsonbOrdered(deaths)));

test("a jsonb dict comes back shortest key first, then byte for byte", () => {
  assert.deepEqual([...jsonbOrdered({ bb: 1, "é": 4, a: 2, ab: 3, "M1 GARAND": 5 }).keys()], ["a", "ab", "bb", "é", "M1 GARAND"], "é is two UTF-8 bytes, after b");
});

test("kills by type follow the weapons in jsonb order, from CRCON's table", () => {
  const usage = crconWeaponTypeUsage(jsonbOrdered({ "MK2 GRENADE": 1, "M1 GARAND": 2, "BOMBING RUN": 1, "MP40": 3, "M16A1": 9 }));
  assert.equal(pyDumps(usage), '{"infantry":5,"commander":1,"grenade":1}', "MP40 and M1 GARAND first by length; a Vietnam weapon has no type");
});

test("detect_team from the unit history: one team is strong, two is the longer one, mixed", () => {
  assert.equal(team([leg(0, 1)], 5400), '{"side":"allies","confidence":"strong","ratio":100}');
  assert.equal(team([leg(600, 2), leg(0, 1)], 5400), '{"side":"axis","confidence":"mixed","ratio":88.89}', "sorted by ts; mixed even past 85 here");
  assert.equal(team([leg(0, 1), leg(100, 2)], 200), '{"side":"unknown","confidence":"mixed","ratio":50}');
  assert.equal(team([leg(0, 1), leg(100, 2), leg(200, 1)], 300), '{"side":"allies","confidence":"mixed","ratio":66.67}', "each leg until the next, the last until match_time");
  assert.equal(team([leg(0, 1), leg(100, 2)], 0), '{"side":"allies","confidence":"mixed","ratio":100.0}', "a match_time of 0 ends the last leg at once: a float 100");
  assert.equal(team([leg(0, -111)], 5400, { "M1 GARAND": 1 }), '{"side":"allies","confidence":"strong","ratio":100.0}', "unassigned legs say nothing; the weapons decide");
});

test("detect_team from the weapons: kills with a side's weapon, deaths to the other's", () => {
  assert.equal(team(null, 5400, { "M1 GARAND": 3, MP40: 1 }), '{"side":"allies","confidence":"mixed","ratio":75.0}');
  assert.equal(team(null, 5400, { "M1 GARAND": 3, MP40: 1 }, { MP40: 6 }), '{"side":"allies","confidence":"strong","ratio":90.0}', "past 85 is strong here");
  assert.equal(team(null, 5400, { "M1 GARAND": 1, MP40: 1 }), '{"side":"unknown","confidence":"mixed","ratio":50}');
  assert.equal(team(null, 5400, { "Canadian Sten Mk.II": 4 }), '{"side":"unknown","confidence":"strong","ratio":0}', "CRCON gives the Canadian weapons no side");
  assert.equal(team([], 5400), '{"side":"unknown","confidence":"strong","ratio":0}');
});
