import test from "node:test";
import assert from "node:assert/strict";
import { buildCombatAnalytics, type CombatInput } from "../src/player-combat.ts";
import { HLL_GAME } from "@app/games";
import { inferMode } from "@app/maps";
import type { EvtRow, PlayerMatchRow, PlayerMatchStatRow } from "@app/db";

const ME = "p-me";
let seq = 0;
/** kill event `n` seconds after epoch-ish base — later calls are LATER in time. */
function kill(actor: string | null, actorName: string, victim: string | null, victimName: string, weapon: string, kind = "evt.kill"): EvtRow {
  seq += 1;
  return {
    id: `e${seq}`, serverId: "s1", ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(), kind,
    actorPlayerId: actor, actorName, victimPlayerId: victim, victimName, weapon, data: null, dedupeKey: null,
  };
}
function mrow(over: Partial<PlayerMatchRow>): PlayerMatchRow {
  seq += 1;
  return {
    matchId: `m${seq}`, playerId: ME, serverId: "s1", playerName: "Me", side: "allies",
    kills: 5, deaths: 5, teamkills: 0, updatedAt: "2026-07-01T00:00:00.000Z",
    combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
    roleSeconds: {}, slSeconds: 0, killsAndAssists: 0, killsAndAssistsPrev: 0,
    deathsAndRedeploys: 0, deathsAndRedeploysPrev: 0, units: [], won: null, presentAtEnd: null,
    map: "carentan_warfare", startedAt: new Date(1_700_000_000_000 + seq * 60_000).toISOString(),
    endedAt: new Date(1_700_000_000_000 + seq * 60_000 + 30_000).toISOString(), winner: "allies", seq,
    ...over,
  };
}
function line(matchId: string, playerId: string, name: string, side: "allies" | "axis" | null): PlayerMatchStatRow {
  return {
    matchId, playerId, serverId: "s1", playerName: name, side, kills: 1, deaths: 1, teamkills: 0,
    combat: 0, offense: 0, defense: 0, support: 0, vehicleKills: 0, vehiclesDestroyed: 0,
    roleSeconds: {}, slSeconds: 0, killsAndAssists: 0, killsAndAssistsPrev: 0,
    deathsAndRedeploys: 0, deathsAndRedeploysPrev: 0, units: [], won: null, presentAtEnd: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}
function build(over: Partial<CombatInput>): ReturnType<typeof buildCombatAnalytics> {
  return buildCombatAnalytics({
    playerId: ME, events: [], matches: [], participants: [],
    career: { kills: 0, deaths: 0, playtimeSec: 0 },
    descriptor: HLL_GAME.descriptor, serverNames: new Map([["s1", "LYNX #1"]]), modeOf: inferMode,
    ...over,
  });
}

test("kill/death types bucket by weapon class; nemeses count both directions; teamkills stay out of the mix", () => {
  // oldest→newest as written; the repo returns newest first, so reverse at the end
  const evs = [
    kill(ME, "Me", "p2", "Pepper", "M1 GARAND"),
    kill(ME, "Me", "p2", "Pepper", "M1 GARAND"),
    kill(ME, "Me", "p3", "Biggs", "MP40"),
    kill(ME, "Me", "p4", "Gunter", "M3 KNIFE"),
    kill("p2", "Pepper", ME, "Me", "KARABINER 98K x8"),
    kill("p2", "Pepper", ME, "Me", "155MM HOWITZER [M114]"),
    kill("p9", "Friendly", ME, "Me", "MP40", "evt.teamkill"), // a TK death: no death-type bucket
  ].reverse();
  const a = build({ events: evs });

  assert.deepEqual(a.killTypes.map((k) => [k.id, k.count]), [["rifle", 2], ["melee", 1], ["smg", 1]]);
  assert.deepEqual(a.deathTypes.map((k) => [k.id, k.count]).sort(), [["artillery", 1], ["sniper", 1]]);
  assert.deepEqual(a.mostKilled[0], { playerId: "p2", name: "Pepper", count: 2 });
  assert.deepEqual(a.mostDiedTo.map((p) => p.name), ["Pepper"]);
  assert.equal(a.melee.kills, 1);
  assert.equal(a.melee.deaths, 0);
});

test("streaks walk time forward: best/current killstreak and best deathstreak; TK deaths break a streak", () => {
  const evs = [
    kill(ME, "Me", "a", "A", "MP40"),
    kill(ME, "Me", "b", "B", "MP40"),
    kill(ME, "Me", "c", "C", "MP40"),           // streak 3
    kill("x", "X", ME, "Me", "MP40"),           // death
    kill(ME, "Me", "d", "D", "MP40"),
    kill("y", "Y", ME, "Me", "MP40", "evt.teamkill"), // TK still puts you on the ground
    kill(ME, "Me", "e", "E", "MP40"),
    kill(ME, "Me", "f", "F", "MP40"),           // current streak 2
  ].reverse();
  const a = build({ events: evs });
  assert.equal(a.streaks.bestKillstreak, 3);
  assert.equal(a.streaks.currentKillstreak, 2);
  assert.equal(a.streaks.bestDeathstreak, 1);

  // most recent melee death is the FIRST one seen in newest-first order
  const evs2 = [
    kill("x", "X", ME, "Me", "M3 KNIFE"),
    kill("z", "Zed", ME, "Me", "FELDSPATEN"),
  ].reverse();
  const b = build({ events: evs2 });
  assert.equal(b.melee.deaths, 2);
  assert.equal(b.melee.lastDeath?.by, "Zed");
  assert.equal(b.melee.lastDeath?.weapon, "FELDSPATEN");
});

test("played with/against from shared match lines, split by recorded side; unknown sides unattributed", () => {
  const m1 = mrow({ side: "allies" });
  const m2 = mrow({ side: "axis" });
  const parts = [
    line(m1.matchId, ME, "Me", "allies"),
    line(m1.matchId, "q1", "Clutch", "allies"),
    line(m1.matchId, "q2", "Imperial", "axis"),
    line(m2.matchId, "q1", "Clutch", "axis"),      // same side as me again (I was axis in m2)
    line(m2.matchId, "q3", "Mystery", null),       // side unknown → neither list
  ];
  const a = build({ matches: [m2, m1], participants: parts });
  assert.deepEqual(a.playedWith[0], { playerId: "q1", name: "Clutch", count: 2 });
  assert.deepEqual(a.playedAgainst.map((p) => p.name), ["Imperial"]);
});

test("habits: faction split, maps with outcomes, inferred modes, servers by name; rates from career", () => {
  const rows = [
    mrow({ map: "carentan_warfare", side: "allies", winner: "allies" }),
    mrow({ map: "carentan_warfare", side: "allies", winner: "axis" }),
    mrow({ map: "foy_offensive_ger", side: "axis", winner: "axis" }),
    mrow({ map: "foy_offensive_ger", side: "allies", winner: null, endedAt: null }), // in progress
  ];
  const a = build({ matches: rows, career: { kills: 1420, deaths: 1517, playtimeSec: 134 * 3600 } });
  assert.equal(a.faction.allies, 3);
  assert.equal(a.faction.axis, 1);
  assert.equal(a.faction.alliesPct, 0.75);
  const carentan = a.maps.find((m) => m.map === "carentan_warfare")!;
  assert.deepEqual([carentan.count, carentan.wins, carentan.losses], [2, 1, 1]);
  assert.deepEqual(a.modes, [{ name: "warfare", count: 2 }, { name: "offensive", count: 2 }].sort((x, y) => y.count - x.count));
  assert.deepEqual(a.servers, [{ serverId: "s1", name: "LYNX #1", count: 4 }]);
  assert.equal(a.rates.kpm, Number((1420 / (134 * 60)).toFixed(2)));
  assert.equal(a.rates.dpm, Number((1517 / (134 * 60)).toFixed(2)));
});

test("rolling series averages over the window, oldest→newest, and win-rate skips undecided matches", () => {
  const rows: PlayerMatchRow[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push(mrow({ kills: i < 6 ? 10 : 2, deaths: 2, side: "allies", winner: i % 2 ? "allies" : "axis" }));
  }
  const newestFirst = [...rows].reverse();
  const a = build({ matches: newestFirst });
  assert.equal(a.rolling.length, 12);
  assert.equal(a.rolling[0]!.kd, 5);                      // first point = just that match
  assert.ok(a.rolling.at(-1)!.kd < 3);                    // late window dominated by the weak run
  assert.equal(a.rolling.at(-1)!.winRate, 0.5);           // alternating results
  assert.ok(a.rolling.every((p, i, arr) => i === 0 || arr[i - 1]!.x <= p.x)); // chronological
});

test("empty inputs produce a calm zero shape (no NaN, no nulls where lists are expected)", () => {
  const a = build({});
  assert.equal(a.rates.kpm, null);
  assert.deepEqual(a.killTypes, []);
  assert.deepEqual(a.mostKilled, []);
  assert.equal(a.faction.alliesPct, null);
  assert.deepEqual(a.rolling, []);
  assert.equal(a.melee.lastDeath, null);
  assert.equal(a.window.firstEventAt, null);
});
