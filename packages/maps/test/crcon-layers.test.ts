/**
 * CRCON v12.3.0's layer resolution, against its own source (rcon/maps.py, rcon/game/hllv/maps.py
 * and the hllrcon 2.0.0.6 data it loads). Every expected dict is what Layer.model_dump() gives
 * for that id on a CRCON install, key for key and in order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { crconGuessMapFromLog, crconLayerDump, crconMapNameFromRecord, crconParseLayer, crconParseLayerOrUnknown } from "../dist/index.js";

const dump = (id: string, game = "hll") => crconLayerDump(crconParseLayer(id, game));
const SME = { id: "stmereeglise", name: "SAINTE-MÈRE-ÉGLISE", tag: "SME", pretty_name: "St. Mere Eglise", shortname: "SME", allies: { name: "us", team: "allies" }, axis: { name: "ger", team: "axis" }, orientation: "horizontal" };

test("a catalogued WW2 layer dumps exactly as CRCON's, computed names included", () => {
  const d = dump("stmereeglise_warfare");
  assert.deepEqual(d, {
    id: "stmereeglise_warfare", map: SME, game_mode: "warfare", attackers: null, environment: "day",
    pretty_name: "St. Mere Eglise Warfare", image_name: "stmereeglise-day.webp",
  });
  assert.deepEqual(Object.keys(d), ["id", "map", "game_mode", "attackers", "environment", "pretty_name", "image_name"], "no image_url: the model has none");
  assert.deepEqual(Object.keys(d.map as object), ["id", "name", "tag", "pretty_name", "shortname", "allies", "axis", "orientation"]);
  assert.equal(dump("stmereeglise_warfare_night").pretty_name, "St. Mere Eglise Warfare (Night)");
  assert.equal(dump("stmereeglise_warfare_night").image_name, "stmereeglise-night.webp");
  assert.equal(dump("stmereeglise_offensive_ger").pretty_name, "St. Mere Eglise Off. GER");
  assert.equal(dump("driel_offensive_us").pretty_name, "Driel Off. CW", "the attacking side's faction on THAT map");
  assert.equal(dump("SME_S_1944_Morning_P_Skirmish").pretty_name, "St. Mere Eglise Skirmish (Dawn)");
  assert.equal(dump("CAR_L_1944_Conquest_Day").pretty_name, "Carentan Conquest");
  assert.equal(dump("STMEREEGLISE_WARFARE").id, "stmereeglise_warfare", "looked up lowercased; the catalogue's own id comes back");
  assert.equal(dump("junobeach_conquest_day").map && (dump("junobeach_conquest_day").map as { allies: { name: string } }).allies.name, "can");
});

test("an uncatalogued WW2 id is parsed the way CRCON parses it, quirks included", () => {
  // The newer id shape with a known tag: the map is found by tag; an Offensive is always "allies"
  // attacking there, whatever the id says.
  const off = dump("CAR_L_1944_OffensiveGER_Dawn");
  assert.equal((off.map as { id: string }).id, "carentan");
  assert.deepEqual([off.game_mode, off.attackers, off.environment, off.pretty_name], ["offensive", "allies", "dawn", "Carentan Off. US (Dawn)"]);
  // An unknown tag: a stand-in map named after the tag.
  assert.deepEqual(dump("XYZ_L_1944_Warfare_Night"), {
    id: "XYZ_L_1944_Warfare_Night",
    map: { id: "xyz", name: "XYZ", tag: "XYZ", pretty_name: "Xyz", shortname: "XYZ", allies: { name: "us", team: "allies" }, axis: { name: "ger", team: "axis" }, orientation: "vertical" },
    game_mode: "warfare", attackers: null, environment: "night", pretty_name: "Xyz Warfare (Night)", image_name: "xyz-night.webp",
  });
  // The old shape outside the catalogue: attackers never set (CRCON's lookup cannot succeed).
  const legacy = dump("foo_offensive_ger_night");
  assert.deepEqual(legacy.map, { id: "foo", name: "Foo", tag: "FOO", pretty_name: "Foo", shortname: "Foo", allies: { name: "us", team: "allies" }, axis: { name: "ger", team: "axis" }, orientation: "vertical" });
  assert.deepEqual([legacy.game_mode, legacy.attackers, legacy.environment, legacy.pretty_name], ["offensive", null, "night", "Foo Off. (Night)"]);
  // The server between maps reports an "Untitled" layer: the unknown one.
  assert.deepEqual(dump("Untitled_42"), {
    id: "unknown",
    map: { id: "unknown", name: "unknown", tag: "", pretty_name: "unknown", shortname: "unknown", allies: { name: "us", team: "allies" }, axis: { name: "ger", team: "axis" }, orientation: "vertical" },
    game_mode: "warfare", attackers: null, environment: "day", pretty_name: "unknown Warfare", image_name: "unknown-day.webp",
  });
  // No shape at all: parse_layer raises, and the live game state's parse_layer_or_unknown falls back.
  assert.throws(() => crconParseLayer("foo", "hll"), /Unparsable layer 'foo'/);
  assert.equal(crconParseLayerOrUnknown("foo", "hll").id, "unknown");
});

test("a Vietnam layer comes from hllrcon's data, and an unknown one keeps its id", () => {
  const d = dump("wdeve_offensivenva_day", "hllv");
  assert.deepEqual(d, {
    id: "wdeve_offensivenva_day",
    map: { id: "wdeve", name: "CAM RANH PORT", tag: "CAM", pretty_name: "Cam Ranh Port", shortname: "Cam Ranh", allies: { name: "us", team: "allies" }, axis: { name: "nva", team: "axis" }, orientation: "horizontal" },
    game_mode: "offensive", attackers: "axis", environment: "day", pretty_name: "Cam Ranh Port Off. NVA", image_name: "wdeve-day.webp",
  });
  assert.equal((dump("wdevc_warfare_day", "hllv").map as { name: string }).name, "HUẾ OUTSKIRTS");
  // Not in the catalogue: never handed to the WW2 parser, kept on Vietnam's own unknown map.
  assert.deepEqual(dump("newmap_warfare", "hllv"), {
    id: "newmap_warfare",
    map: { id: "unknown", name: "unknown", tag: "", pretty_name: "unknown", shortname: "unknown", allies: { name: "unknown", team: "allies" }, axis: { name: "unknown", team: "axis" }, orientation: "vertical" },
    game_mode: "domination", attackers: null, environment: "day", pretty_name: "unknown Domination", image_name: "unknown-day.webp",
  });
});

test("a match log's map text is filed the way CRCON's guess_map_from_log files it", () => {
  const guess = (line: string, game = "hll") => crconGuessMapFromLog(line, game).id;
  // Display text, not a layer id: matched to the catalogue by the map's NAME (NFKC, casefolded),
  // then by mode, attacker and environment.
  assert.equal(guess("MATCH START CARENTAN Warfare"), "carentan_warfare");
  assert.equal(guess("[1:23 min (1784761672)] MATCH START sainte-mère-église warfare"), "stmereeglise_warfare", "searched anywhere in the raw line, any case");
  assert.equal(guess("MATCH START SAINTE-MÈRE-ÉGLISE Night Warfare"), "stmereeglise_warfare_night", "the environment picks among the map's layers");
  assert.equal(guess("MATCH START STALINGRAD Rain Warfare"), "stalingrad_warfare", "no such environment: the first of the map's layers in that mode");
  assert.equal(guess("MATCH START HU\u0308RTGEN FOREST Warfare"), "hurtgenforest_warfare_V2", "a decomposed Ü is the same name after NFKC");
  assert.equal(guess("MATCH START \uff23\uff21\uff32\uff25\uff2e\uff34\uff21\uff2e Warfare"), "carentan_warfare", "and so are fullwidth letters");
  assert.equal(guess("MATCH ENDED `KHARKOV Warfare` ALLIED (2 - 3) AXIS"), "kharkov_warfare", "the ended line's backticked form");
  // Vietnam's attacker token picks the side, from Vietnam's own catalogue.
  assert.equal(guess("MATCH START CAM RANH PORT NVA Offensive", "hllv"), "wdeve_offensivenva_day");
  assert.equal(guess("MATCH START CAM RANH PORT US Offensive", "hllv"), "wdeve_offensiveus_day");
  assert.equal(guess("MATCH START HUẾ OUTSKIRTS Warfare"), "unknown", "a Vietnam map means nothing to WW2's catalogue");
  for (const line of ["MATCH START CARENTAN", "MATCH START ", "MATCH START NOWHERE Warfare", "MATCH START CARENTAN Domination"]) {
    assert.equal(guess(line), "unknown", `${JSON.stringify(line)}: no map in that mode, or no mode at all`);
  }
  // Python's regex, not JavaScript's: its whitespace, its IGNORECASE, its enums, its `$`.
  assert.equal(guess("MATCH START CARENTAN\u0085Warfare"), "carentan_warfare", "\\x85 is whitespace to Python");
  assert.equal(guess("MATCH START CARENTAN\ufeffWarfare"), "unknown", "and \\ufeff is not");
  assert.equal(guess("MATCH START CARENTAN n\u0131ght Warfare"), "unknown", "a dotless ı satisfies IGNORECASE, then fails Environment()");
  assert.equal(guess("MATCH START CAM RANH PORT u\u017f Offensive", "hllv"), "wdeve_offensiveus_day", "the long s matches, and casefolds to s");
  assert.equal(guess("MATCH START CARENTAN S\u212aIRMISH"), "CAR_S_1944_Day_P_Skirmish", "the Kelvin sign matches k, and lowercases to it");
  assert.equal(guess("MATCH START CARENTAN Warfare\n"), "carentan_warfare");
  // A catalogue quirk kept: the first unknown-map Warfare layer is the pre-v9.8.0 "bla_".
  assert.equal(guess("MATCH START unknown Warfare"), "bla_");
});

test("a stored round's map reads as the id CRCON would have filed it under", () => {
  assert.equal(crconMapNameFromRecord("CARENTAN Warfare", "hll"), "carentan_warfare", "our ingest's MATCH START text is guessed from");
  assert.equal(crconMapNameFromRecord("CAM RANH PORT NVA Offensive", "hllv"), "wdeve_offensivenva_day");
  assert.equal(crconMapNameFromRecord("stmereeglise_warfare_night", "hll"), "stmereeglise_warfare_night", "a CRCON id is kept as it is");
  assert.equal(crconMapNameFromRecord("CAR_L_1944_OffensiveGER_Dawn", "hll"), "CAR_L_1944_OffensiveGER_Dawn", "catalogued or not");
  assert.equal(crconMapNameFromRecord("Foy", "hll"), "unknown", "neither a layer id nor text naming a mode");
  assert.equal(crconMapNameFromRecord(null, "hll"), "unknown");
  assert.equal(crconMapNameFromRecord("", "hllv"), "unknown");
});
