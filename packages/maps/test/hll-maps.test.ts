import { test } from "node:test";
import assert from "node:assert/strict";
import { inferMode, inferEnvironment, inferEnvironmentGroup, inferFamily, prettifyMapId, describeMaps, describeMap } from "../dist/index.js";

test("inferMode: warfare / offensive / skirmish", () => {
  assert.equal(inferMode("carentan_warfare"), "warfare");
  assert.equal(inferMode("carentan_offensive_ger"), "offensive");
  assert.equal(inferMode("stmereeglise_offensiveus"), "offensive");
  assert.equal(inferMode("SMDM_S_1944_skirmish"), "skirmish");
});

test("inferEnvironment + day/night group", () => {
  assert.equal(inferEnvironment("foy_warfare_night"), "night");
  assert.equal(inferEnvironment("foy_warfare_dusk"), "dusk");
  assert.equal(inferEnvironment("foy_warfare"), "day");
  assert.equal(inferEnvironmentGroup("night"), "night");
  assert.equal(inferEnvironmentGroup("dusk"), "day");
  assert.equal(inferEnvironmentGroup("day"), "day");
});

test("inferFamily strips mode/team/time; overrides apply", () => {
  assert.equal(inferFamily("carentan_warfare"), "carentan");
  assert.equal(inferFamily("carentan_offensive_ger"), "carentan");
  assert.equal(inferFamily("foy_warfare_night"), "foy");
  // both offensive variants of St Marie du Mont collapse to one family (hardcoded override)
  assert.equal(inferFamily("stmariedumont_off_us"), "stmariedumont");
  assert.equal(inferFamily("stmariedumont_off_ger"), "stmariedumont");
});

test("prettifyMapId: name + mode/variant labels", () => {
  assert.equal(prettifyMapId("PHL_L_1944"), "Purple Heart Lane — Warfare");
  assert.equal(prettifyMapId("carentan_offensive_ger"), "Carentan — Offensive GER");
  assert.match(prettifyMapId("foy_warfare_night"), /^Foy — Warfare Night$/);
});

/*
 * A map reaches us two ways and BOTH have to prettify: as a layer id from the rotation, and as the
 * game's own display name off the MATCH START line — which is what a recorded round stores, and
 * therefore what the public stats site prints. The display spelling used to keep its mode word in
 * the name and lose its capitals ("Đăk tô airfield warfare — Warfare"), because every marker here
 * was written with underscores and nothing folded the spaces in.
 */
test("prettifyMapId reads the game's display name as well as the layer id", () => {
  assert.equal(prettifyMapId("Đăk Tô Airfield Warfare"), "Đăk Tô Airfield — Warfare");
  assert.equal(prettifyMapId("wdevd_warfare_day"), "Đăk Tô Airfield — Warfare Day", "the id spelling is unchanged");
  assert.equal(prettifyMapId("Quảng Ngãi Warfare"), "Quảng Ngãi — Warfare", "every word keeps its capital, not just the first");
  assert.equal(prettifyMapId("Carentan Warfare"), "Carentan — Warfare");
  // A display name puts the attacker BEFORE the mode; an id puts it after. Both mean the same
  // round, and neither should leave the faction stranded in the map's name.
  assert.equal(prettifyMapId("Vạn Tường US Offensive"), "Vạn Tường — Offensive US");
  assert.equal(prettifyMapId("Huế Outskirts NVA Offensive"), "Huế Outskirts — Offensive NVA");
});

test("describeMaps de-duplicates case-insensitively, preserving order", () => {
  const items = describeMaps(["carentan_warfare", "CARENTAN_WARFARE", "foy_warfare"]);
  assert.deepEqual(items.map((i) => i.id), ["carentan_warfare", "foy_warfare"]);
  assert.equal(items[0]!.family, "carentan");
  assert.equal(items[1]!.mode, "warfare");
});

// ---- HLL: Vietnam (WDEV_A–F, from the release reference export) ----

test("Vietnam layer ids derive their real names, modes and families", () => {
  const warfare = describeMap("wdeve_warfare_day");
  assert.equal(warfare.prettyName, "Cam Ranh Port — Warfare Day");
  assert.equal(warfare.mode, "warfare");
  assert.equal(warfare.family, "wdeve");
  assert.equal(warfare.environment, "day");

  // The two modes Vietnam adds — and their family must strip the mode marker, or every
  // conquest/domination layer becomes its own family and the variety rules stop working.
  assert.equal(describeMap("wdeva_conquest_day").mode, "conquest");
  assert.equal(describeMap("wdeva_conquest_day").family, "wdeva");
  assert.equal(describeMap("wdevf_domination_day").mode, "domination");
  assert.equal(describeMap("wdevf_domination_day").family, "wdevf");

  // Offensive layers name the attacker, same as HLL's "Offensive GER" convention.
  assert.equal(describeMap("wdevc_offensivenva_day").prettyName, "Huế Outskirts — Offensive NVA Day");
  assert.equal(describeMap("wdevd_offensiveus_day").mode, "offensive");
  assert.equal(describeMap("wdevd_offensiveus_day").family, "wdevd");

  // The MAP ids (session/sector answers) spell the underscore out — same names.
  assert.equal(describeMap("WDEV_A").prettyName.startsWith("Vạn Tường"), true);
  assert.equal(describeMap("WDEV_F").prettyName.startsWith("Thanh Hòa Bridge"), true);
});

test("all six Vietnam families resolve, across every layer the export ships", () => {
  const layers = ["a", "b", "c", "d", "e", "f"].flatMap((m) =>
    ["warfare", "offensivenva", "offensiveus", "domination", "conquest"].map((mode) => `wdev${m}_${mode}_day`));
  const items = describeMaps(layers);
  assert.equal(items.length, 30);
  const families = new Set(items.map((i) => i.family));
  assert.deepEqual([...families].sort(), ["wdeva", "wdevb", "wdevc", "wdevd", "wdeve", "wdevf"]);
  // No layer falls back to a raw token name like "Wdeve" — every one carries its alias.
  for (const i of items) assert.doesNotMatch(i.prettyName, /^Wdev/, i.id);
});

// ---- HLL Update 21: Conquest comes to WW2, with Juno Beach and compact large-layer ids ----

/*
 * The announcement named five ConquestMaps ids. Two spelling problems hid in them: `junobeach`
 * had no display alias (→ "Junobeach"), and `oma_l_1944` had no prefix alias at all (→ "Oma").
 * Worse, the compact large-layer spelling minted its own FAMILY (car_l_1944), so a vote pool
 * could offer Carentan twice — once as carentan_warfare, once as its conquest layer — which is
 * exactly what family de-dup exists to prevent.
 */
test("Update 21 conquest layers derive real names, the conquest mode, and the classic families", () => {
  const juno = describeMap("junobeach_conquest_day");
  assert.equal(juno.prettyName, "Juno Beach — Conquest Day");
  assert.equal(juno.mode, "conquest");
  assert.equal(juno.family, "junobeach");

  const oma = describeMap("oma_l_1944_conquest_day");
  assert.equal(oma.prettyName, "Omaha Beach — Conquest Day");
  assert.equal(oma.mode, "conquest");
  assert.equal(oma.family, "omahabeach", "the compact spelling is the same place as omahabeach_warfare");

  assert.equal(describeMap("car_l_1944_conquest_day").prettyName, "Carentan — Conquest Day");
  assert.equal(describeMap("car_l_1944_conquest_day").family, "carentan");
  assert.equal(describeMap("sme_l_1944_conquest_day").family, "stmereeglise");
  assert.equal(describeMap("smdm_l_1944_conquest_day").family, "stmariedumont");

  // The fold reaches the existing compact skirmish ids too — same place, same family…
  assert.equal(describeMap("CAR_S_1944_Day_P_Skirmish").family, "carentan");
  // …and never swallows a real word or another game's ids.
  assert.equal(describeMap("junobeach_conquest_day").family, "junobeach");
  assert.equal(describeMap("wdeve_conquest_day").family, "wdeve");
});
