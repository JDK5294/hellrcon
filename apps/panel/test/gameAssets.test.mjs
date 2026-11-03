// Map artwork resolution. The server names maps the way the game prints them — accented, with the
// saints spelled out — while the bundled art is named in flat ASCII families. Every mismatch here
// shows up as a card with no picture on it, silently, so the spellings are pinned down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapFamilyOf, mapImageUrl, mapIconUrl, tacMapUrl, roleIconUrl, factionIconUrls } from "../lib/gameAssets.ts";

test("accented and spelled-out map names find their family", () => {
  // The live bug: SAINTE-MÈRE-ÉGLISE squashed to "saintemreglise" and matched nothing, so the
  // most-played map in the rotation was the one map that never had artwork.
  assert.equal(mapFamilyOf("SAINTE-MÈRE-ÉGLISE"), "stmereeglise");
  assert.equal(mapFamilyOf("Sainte-Mère-Église Offensive"), "stmereeglise");
  assert.equal(mapFamilyOf("SAINTE-MARIE-DU-MONT"), "stmariedumont");
  assert.equal(mapFamilyOf("HÜRTGEN FOREST"), "hurtgenforest");
});

test("raw ids, pretty names and bare families all resolve to the same family", () => {
  for (const text of ["stmereeglise_off_ger", "St. Mere Eglise", "stmereeglise", "SAINTE-MÈRE-ÉGLISE"]) {
    assert.equal(mapFamilyOf(text), "stmereeglise", text);
  }
  // Longest match wins, so the two saints never take each other's art.
  assert.equal(mapFamilyOf("SAINTE-MARIE-DU-MONT Warfare"), "stmariedumont");
});

test("a resolved map yields a banner, a thumbnail and a tactical map", () => {
  assert.match(mapImageUrl("SAINTE-MÈRE-ÉGLISE", "hll") ?? "", /\/game\/hll\/maps\/stmereeglise-\w+\.webp$/);
  assert.match(mapIconUrl("SAINTE-MÈRE-ÉGLISE", "hll") ?? "", /\/game\/hll\/map-icons\/stmereeglise-\w+\.webp$/);
  assert.equal(tacMapUrl("SAINTE-MÈRE-ÉGLISE", "hll"), "/game/hll/tac-maps/stmereeglise.webp");
  // Time of day is honoured when the art covers it, and falls back rather than vanishing.
  assert.match(mapImageUrl("FOY Night", "hll") ?? "", /foy-night\.webp$/);
  assert.match(mapImageUrl("FOY Dusk", "hll") ?? "", /foy-day\.webp$/, "no dusk art for Foy — fall back, don't blank");
});

test("an unknown map is null everywhere rather than a broken image", () => {
  for (const text of ["", null, undefined, "SOME UNRELEASED MAP"]) {
    assert.equal(mapFamilyOf(text), null);
    assert.equal(mapImageUrl(text, "hll"), null);
    assert.equal(tacMapUrl(text, "hll"), null);
  }
});

/*
 * The artwork is Hell Let Loose's WW2 set and answers for that game ONLY.
 *
 * This was got wrong twice. `factionIconUrls` flew a Balkenkreuz over the NVA until it learned to
 * ask which game was playing; the map and role resolvers went on answering for anything, so a
 * Vietnam roster drew WW2 role icons and a Vietnam map was one unlucky substring away from wearing
 * a Normandy photograph. The family match is a SUBSTRING search over WW2 names, so "no collision
 * today" is luck, not a guarantee — the game has to be part of the question.
 */
test("artwork answers for Hell Let Loose and refuses for every other game", () => {
  // The WW2 server keeps everything it had.
  assert.ok(mapImageUrl("SAINTE-MÈRE-ÉGLISE", "hll"));
  assert.ok(tacMapUrl("FOY", "hll"));
  assert.ok(roleIconUrl("Rifleman", "hll"));
  assert.ok(factionIconUrls("KURSK", "hll").allies);

  // A game with no art at all gets none of it, and never the other war's.
  for (const game of ["hll3", null, undefined]) {
    assert.equal(mapImageUrl("SAINTE-MÈRE-ÉGLISE", game), null, `map banner for ${game}`);
    assert.equal(mapIconUrl("SAINTE-MÈRE-ÉGLISE", game), null, `map icon for ${game}`);
    assert.equal(tacMapUrl("FOY", game), null, `tac map for ${game}`);
    assert.equal(roleIconUrl("Rifleman", game), null, `role icon for ${game}`);
    assert.deepEqual(factionIconUrls("KURSK", game), { allies: null, axis: null }, `emblems for ${game}`);
  }

  // Vietnam ships its OWN emblems and role icons now, so it gets those — from its own set. Its
  // maps are still not bundled, and saying "no art" there is the honest answer.
  assert.equal(mapImageUrl("SAINTE-MÈRE-ÉGLISE", "hllv"), null, "Vietnam has no map art yet");
  assert.equal(tacMapUrl("FOY", "hllv"), null, "nor tactical maps");
  const nam = factionIconUrls("QUẢNG NGÃI", "hllv");
  assert.match(nam.allies ?? "", /\/game\/hllv\/teams\/us/, "US for the allied side");
  assert.match(nam.axis ?? "", /\/game\/hllv\/teams\/nva/, "NVA for the axis side — never a Balkenkreuz");
  assert.match(roleIconUrl("Rifleman", "hllv") ?? "", /\/game\/hllv\/roles\//, "its own rifleman, not the WW2 one");
  assert.ok(roleIconUrl("Mortar Support", "hllv"), "and roles the WW2 set never had");

  // The two sets never cross: a WW2 request stays in /game/hll, a Vietnam one in /game/hllv.
  assert.match(roleIconUrl("Rifleman", "hll") ?? "", /\/game\/hll\/roles\//);
  assert.match(factionIconUrls("KURSK", "hll").axis ?? "", /\/game\/hll\/teams\/ger/);
  // A role only Vietnam fields gets nothing from the WW2 set rather than a lookalike.
  assert.equal(roleIconUrl("Mortar Support", "hll"), null);
});

test("the family match stays a substring search — which is why the game gate carries the weight", () => {
  // Not a Vietnam map today, but the shape of the accident the gate exists to prevent: any map id
  // containing a WW2 family name would inherit its art if the game were not asked first.
  assert.equal(mapFamilyOf("FOY BRIDGE"), "foy", "substring matching is the mechanism, by design");
  assert.equal(mapImageUrl("FOY BRIDGE", "hllv"), null, "...and the game gate is what makes it safe");
});
