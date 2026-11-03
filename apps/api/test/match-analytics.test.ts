import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatchAnalytics } from "../src/match-analytics.ts";
import type { PlayerMatchAggregate, PlayerMatchRow, EvtRow } from "@app/db";

function mrow(p: Partial<PlayerMatchRow>): PlayerMatchRow {
  return {
    matchId: "m", playerId: "p1", serverId: "s", playerName: "Ally", side: "allies",
    kills: 0, deaths: 0, teamkills: 0, updatedAt: "2026-07-01T00:00:00Z",
    combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
    roleSeconds: {}, slSeconds: 0, killsAndAssists: 0, killsAndAssistsPrev: 0,
    deathsAndRedeploys: 0, deathsAndRedeploysPrev: 0, units: [], won: null, presentAtEnd: null,
    map: "Carentan", startedAt: "2026-07-01T10:00:00Z", endedAt: "2026-07-01T10:40:00Z", winner: "allies", seq: 1,
    ...p,
  };
}
function kill(actorPlayerId: string | null, weapon: string): EvtRow {
  return { id: Math.random().toString(36).slice(2), serverId: "s", ts: "2026-07-01T10:10:00Z", kind: "evt.kill", actorPlayerId, actorName: "Ally", victimPlayerId: "z", victimName: "Foe", weapon, data: null, dedupeKey: null };
}

test("winRate + progression order + won flags", () => {
  const agg: PlayerMatchAggregate = { matches: 3, wins: 2, losses: 1, kills: 30, deaths: 15, teamkills: 1 };
  // newest first (as the repo returns)
  const matches: PlayerMatchRow[] = [
    mrow({ matchId: "m3", map: "Foy", startedAt: "2026-07-03T10:00:00Z", kills: 12, deaths: 4, side: "axis", winner: "allies" }),   // loss
    mrow({ matchId: "m2", map: "SME", startedAt: "2026-07-02T10:00:00Z", kills: 8, deaths: 8, side: "allies", winner: "allies" }),   // win
    mrow({ matchId: "m1", map: "Carentan", startedAt: "2026-07-01T10:00:00Z", kills: 10, deaths: 3, side: "allies", winner: "allies" }), // win
  ];
  const events: EvtRow[] = [kill("p1", "M1 GARAND"), kill("p1", "M1 GARAND"), kill("p1", "THOMPSON"), kill("other", "MP40")];
  const a = buildMatchAnalytics(agg, matches, "p1", events);

  assert.equal(a.winRate, 2 / 3);
  assert.equal(a.recent.length, 3);
  assert.equal(a.recent[0]!.won, false); // m3 axis vs allies winner
  assert.equal(a.recent[2]!.won, true);  // m1 allies win

  // progression is oldest→newest
  assert.deepEqual(a.progression.map((p) => p.label), ["Carentan", "SME", "Foy"]);
  assert.equal(a.progression[0]!.kd, 3.33); // rounded to 2dp for display

  // only the player's own kills counted, most-used first
  assert.equal(a.weapons[0]!.weapon, "M1 GARAND");
  assert.equal(a.weapons[0]!.kills, 2);
  assert.ok(!a.weapons.some((w) => w.weapon === "MP40")); // other player's kill excluded
});

test("no attributed matches → null win rate", () => {
  const agg: PlayerMatchAggregate = { matches: 1, wins: 0, losses: 0, kills: 3, deaths: 1, teamkills: 0 };
  const a = buildMatchAnalytics(agg, [mrow({ side: null, winner: null, endedAt: null })], "p1", []);
  assert.equal(a.winRate, null);
  assert.equal(a.recent[0]!.won, null);
});
