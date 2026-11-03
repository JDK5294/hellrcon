/**
 * The score charts' points, read off CRCON's player cache (score-series.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CrconPlayerStat } from "@app/db";
import { scoreSeriesPoints } from "../src/score-series.ts";

const line = (over: Partial<CrconPlayerStat> = {}): CrconPlayerStat => ({
  combat: 0, p_combat: 0, offense: 0, p_offense: 0, defense: 0, p_defense: 0, support: 0, p_support: 0,
  vehicle_kills: 0, p_vehicle_kills: 0, vehicles_destroyed: 0, p_vehicles_destroyed: 0,
  kills_and_assists: 0, p_kills_and_assists: 0, deaths_and_redeploys: 0, p_deaths_and_redeploys: 0,
  p_unit: { ts: 0, team: 1, squad: 0, role: 0 }, units: [], level: 10,
  p_coord: { x: 0, y: 0, z: 0 }, has_spawned: true, names: ["Able"], status: "online",
  ...over,
});

test("a point is each bucket's running figure plus what a reconnect banked, at the pass's second", () => {
  const points = scoreSeriesPoints([
    ["steam-able", line({ combat: 40, offense: 20, defense: 0, support: 15 })],
    // Reconnected once: the game counts from 0 again, and the 300 combat and 60 support it had
    // before sit in the p_* fields. The live board shows 340 and 75, so the chart must too.
    ["steam-baker", line({ combat: 40, p_combat: 300, support: 15, p_support: 60 })],
  ], 600);
  assert.deepEqual(points, [
    { platformId: "steam-able", sec: 600, combat: 40, offense: 20, defense: 0, support: 15 },
    { platformId: "steam-baker", sec: 600, combat: 340, offense: 0, defense: 0, support: 75 },
  ]);
});

test("a player who has scored nothing yet has no point", () => {
  assert.deepEqual(scoreSeriesPoints([["steam-new", line()]], 130), [], "their line starts when their score does");
  assert.equal(scoreSeriesPoints([["steam-medic", line({ support: 5 })]], 130).length, 1, "any one bucket is enough");
});
