import { test } from "node:test";
import assert from "node:assert/strict";
import { describeMaps, resolveCurrentMapId, resolveListedMapId } from "../dist/index.js";

/*
 * The bug this exists to prevent, in the shape it actually appeared:
 *
 * the map vote collapses the rotation down to the single map it is queuing, so a live server's
 * rotation is one entry long and its "current index" points at the map about to play. Every screen
 * that asked the rotation what was on now was told the NEXT map — the Maps tab said Quảng Ngãi
 * while players were on Vạn Tường, and renamed itself each time the poll's lead changed. The worker
 * had it worse: it banked that same wrong map as recently-played, barring the just-won map from the
 * next vote while the map everybody was on stayed eligible.
 */
const CAT = describeMaps([
  "wdevb_offensivenva_day",
  "wdevb_warfare_day",
  "wdevd_warfare_day",
  "carentan_warfare",
]);

test("the map in play comes from the session, not the rotation's current index", () => {
  // The rotation is collapsed to the queued winner, exactly as the vote leaves it.
  const rotation = { maps: ["wdevb_offensivenva_day"], currentIndex: 0 };
  const id = resolveCurrentMapId({
    session: { mapId: "wdevd_warfare_day", mapName: "VẠN TƯỜNG", gameMode: "Warfare" },
    rotation,
    catalogue: CAT,
  });
  assert.equal(id, "wdevd_warfare_day", "the session is the authority on what is running");
  assert.notEqual(id, rotation.maps[0], "and the queued next map is never mistaken for it");
});

test("a build that reports no map id is matched back by its printable name", () => {
  const id = resolveCurrentMapId({
    // Accented free text, and the id it belongs to shares not one character with it. The catalogue
    // labels it "Đăk Tô Airfield — Warfare Day"; the session says only the name.
    session: { mapName: "ĐĂK TÔ AIRFIELD", gameMode: "Warfare" },
    rotation: { maps: ["carentan_warfare"], currentIndex: 0 },
    catalogue: CAT,
  });
  assert.equal(id, "wdevd_warfare_day");
});

test("a name two variants answer to is settled by the mode, never guessed", () => {
  // Both of these are Quảng Ngãi; only the mode separates them, and the session gives it as free
  // text ("NVA Offensive") that has to be read loosely enough to find "offensive" inside it.
  const offensive = resolveCurrentMapId({
    session: { mapName: "QUẢNG NGÃI", gameMode: "NVA Offensive" },
    rotation: null,
    catalogue: CAT,
  });
  assert.equal(offensive, "wdevb_offensivenva_day");

  const warfare = resolveCurrentMapId({
    session: { mapName: "QUẢNG NGÃI", gameMode: "Warfare" },
    rotation: null,
    catalogue: CAT,
  });
  assert.equal(warfare, "wdevb_warfare_day");

  // With no mode to go on it refuses rather than picking one of the two.
  assert.equal(resolveCurrentMapId({ session: { mapName: "QUẢNG NGÃI" }, rotation: null, catalogue: CAT }), null);
});

test("an unresolvable name falls back to the rotation rather than picking one at random", () => {
  // A rotation answer is wrong in a knowable way; a coin flip between two real maps is not, and it
  // feeds map exclusion for the next vote.
  const id = resolveCurrentMapId({
    session: { mapName: "SOMEWHERE ELSE" },
    rotation: { maps: ["carentan_warfare"], currentIndex: 0 },
    catalogue: CAT,
  });
  assert.equal(id, "carentan_warfare");
});

test("no session and no rotation is null, not an invented map", () => {
  assert.equal(resolveCurrentMapId({}), null);
  assert.equal(resolveCurrentMapId({ session: {}, rotation: { maps: [], currentIndex: 0 }, catalogue: CAT }), null);
});

/*
 * The play queue names its maps by level path where the rotation has the layer id. Shown raw, the
 * field's queue entry read "Game Bnw Maps Fra Smdm Smdm Day — Skirmish Day" and could never compare
 * equal to the rotation's own entry for the same map. Matched by what the game says each entry is.
 */
test("a listed map resolves to the rotation's layer id by the game's own description of it", () => {
  const rotation = [
    { id: "SMDM_S_1944_Day_P_Skirmish", name: "ST MARIE DU MONT", gameMode: "Skirmish", timeOfDay: "Day" },
    { id: "SME_S_1944_Day_P_Skirmish", name: "SAINTE-MÈRE-ÉGLISE", gameMode: "Skirmish", timeOfDay: "Day" },
  ];
  const catalogue = describeMaps(["SMDM_S_1944_Day_P_Skirmish", "SME_S_1944_Day_P_Skirmish", "carentan_warfare", "carentan_warfare_night"]);
  const ctx = { rotation, catalogue };
  const queued = (id: string, name: string, gameMode = "Skirmish", timeOfDay = "Day") => ({ id, name, gameMode, timeOfDay });
  assert.equal(resolveListedMapId(queued("/Game/BNW/Maps/FRA/SMDM/SMDM_Day_Skirmish", "ST MARIE DU MONT"), ctx), "SMDM_S_1944_Day_P_Skirmish");
  assert.equal(resolveListedMapId(queued("/Game/BNW/Maps/FRA/SME/SME_Day_Skirmish", "Sainte-Mère-Église"), ctx), "SME_S_1944_Day_P_Skirmish",
    "accents and case fold the same way on both sides");
  // An id the app already knows is used as it is (any case).
  assert.equal(resolveListedMapId(queued("smdm_s_1944_day_p_skirmish", ""), ctx), "SMDM_S_1944_Day_P_Skirmish");
  // Not in the rotation: the catalogue map with that name and mode, time of day breaking a tie.
  assert.equal(resolveListedMapId(queued("/Game/x/carentan_n", "CARENTAN", "Warfare", "Night"), ctx), "carentan_warfare_night");
  // Nothing matches: the id stays as given rather than becoming a guessed map.
  assert.equal(resolveListedMapId(queued("/Game/x/unknown", "NOWHERE"), ctx), "/Game/x/unknown");
});
