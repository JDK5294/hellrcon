/**
 * CRCON's record of a round as it starts, against its own source (rcon/hooks.py
 * handle_new_match_start, v12.3.0): the live layer or the guess, guessed, match_time and
 * initial_morale.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordRoundStart } from "../src/round-start.ts";

const START = Date.UTC(2026, 9, 12, 20, 0, 0);
const SOON = START + 10_000;
const carentanNight = { mapId: "carentan_warfare_night", gameMode: "Warfare", matchTime: 5400, initialMorale: 0 };

test("a recent MATCH START on the live map files the LIVE layer, not the guess", () => {
  // The guess from "CARENTAN Warfare" is carentan_warfare; the live layer is on the same map.
  assert.deepEqual(recordRoundStart("CARENTAN Warfare", "hll", START, SOON, carentanNight), { map: "carentan_warfare_night", guessed: false, matchTime: 5400, initialMorale: 0 });
  assert.equal(recordRoundStart("CARENTAN Warfare", "hll", START, START + 5 * 60_000 - 1, carentanNight).guessed, false, "under five minutes is recent");
});

test("an old line, or another map live, files the guess; match_time still comes from the live timer", () => {
  assert.deepEqual(recordRoundStart("CARENTAN Warfare", "hll", START, START + 5 * 60_000, carentanNight), { map: "carentan_warfare", guessed: true, matchTime: 5400, initialMorale: null }, "five minutes old");
  assert.deepEqual(recordRoundStart("CARENTAN Warfare", "hll", START, SOON, { ...carentanNight, mapId: "foy_warfare" }), { map: "carentan_warfare", guessed: true, matchTime: 5400, initialMorale: null }, "another map live");
  assert.deepEqual(recordRoundStart(null, "hll", START, SOON, carentanNight), { map: "unknown", guessed: true, matchTime: 5400, initialMorale: null }, "no map text at all");
});

test("a live mode that disagrees with the live layer's records no match_time and no morale", () => {
  const transition = { mapId: "CAR_L_1944_Conquest_Day", gameMode: "Warfare", matchTime: 5400, initialMorale: 500 };
  assert.deepEqual(recordRoundStart("CARENTAN Conquest", "hll", START, SOON, transition), { map: "CAR_L_1944_Conquest_Day", guessed: false, matchTime: 0, initialMorale: null });
  const conquest = { ...transition, gameMode: "Conquest", matchTime: 3600 };
  assert.deepEqual(recordRoundStart("CARENTAN Conquest", "hll", START, SOON, conquest), { map: "CAR_L_1944_Conquest_Day", guessed: false, matchTime: 3600, initialMorale: 500 });
});

test("an Offensive's match_time is five objective timers, in both games", () => {
  assert.equal(recordRoundStart("CARENTAN Offensive", "hll", START, SOON, { mapId: "carentan_offensive_us", gameMode: "Offensive", matchTime: 5400 }).matchTime, 9000);
  assert.deepEqual(recordRoundStart("CAM RANH PORT NVA Offensive", "hllv", START, SOON, { mapId: "wdeve_offensivenva_day", gameMode: "NVA Offensive", matchTime: 1800, initialMorale: 0 }), {
    map: "wdeve_offensivenva_day", guessed: false, matchTime: 9000, initialMorale: 0,
  });
});
