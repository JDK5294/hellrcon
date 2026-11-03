// Picking a round's artwork from the files the panel ships. The directory is the manifest, so
// these are the real filenames — if the art set changes, this test changes with it rather than
// silently disagreeing with a hardcoded list somewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBoardLogo, nationsFor, pickMapArt } from "../dist/map-art.js";
import { InMemoryRepository } from "@app/db";

const FILES = [
  "carentan-day.webp", "carentan-dusk.webp", "carentan-night.webp", "carentan-rain.webp",
  "foy-day.webp", "foy-night.webp",
  "hill400-day.webp", "hurtgenforest-day.webp",
  "stmariedumont-day.webp", "stmariedumont-night.webp",
  "stmereeglise-dawn.webp", "stmereeglise-day.webp", "stmereeglise-night.webp",
  "main-menu.webp", "unknown.webp", "unknown-day.webp",
];

test("the raw id the server sends picks its own art", () => {
  assert.equal(pickMapArt(FILES, "stmereeglise_offensive_us"), "stmereeglise-day.webp");
  assert.equal(pickMapArt(FILES, "carentan_warfare_night"), "carentan-night.webp");
  assert.equal(pickMapArt(FILES, "foy_warfare"), "foy-day.webp");
});

test("printable names work too, accents and spelled-out saints included", () => {
  assert.equal(pickMapArt(FILES, "SAINTE-MÈRE-ÉGLISE"), "stmereeglise-day.webp");
  assert.equal(pickMapArt(FILES, "HÜRTGEN FOREST"), "hurtgenforest-day.webp");
  assert.equal(pickMapArt(FILES, "Hill 400"), "hill400-day.webp");
  // Longest match wins, so the two saints never take each other's picture.
  assert.equal(pickMapArt(FILES, "SAINTE-MARIE-DU-MONT Night"), "stmariedumont-night.webp");
});

test("time of day is honoured, and falls back rather than blanking", () => {
  assert.equal(pickMapArt(FILES, "foy_warfare_night"), "foy-night.webp");
  // No dusk art for Foy: walk the fallbacks instead of returning nothing.
  assert.equal(pickMapArt(FILES, "foy_warfare_dusk"), "foy-day.webp");
  // Overcast/morning are day to the engine and we ship no such files; dawn is the first fallback.
  assert.equal(pickMapArt(FILES, "stmereeglise_warfare_overcast"), "stmereeglise-dawn.webp");
});

test("a map with no art is null — a board without a picture, not a broken one", () => {
  assert.equal(pickMapArt(FILES, "someunreleasedmap_warfare"), null);
  assert.equal(pickMapArt(FILES, ""), null);
  assert.equal(pickMapArt(FILES, null), null);
  assert.equal(pickMapArt([], "foy_warfare"), null);
});

// The nations on the scoreline are keyed by GAME first, map second. The regression this pins:
// the old map-only lookup defaulted every unknown map to US/GERMANY, so the Vietnam server's
// Discord board flew GERMANY (Balkenkreuz and all) over the NVA.
test("HLL maps pick their real allied nation, US and Germany by default", () => {
  assert.deepEqual(nationsFor("hll", "carentan_warfare"), [
    { code: "us", name: "UNITED STATES" }, { code: "ger", name: "GERMANY" },
  ]);
  assert.deepEqual(nationsFor("hll", "elalamein_warfare")?.[0], { code: "gb", name: "UNITED KINGDOM" });
  assert.deepEqual(nationsFor("hll", "KURSK")?.[0], { code: "rus", name: "SOVIET UNION" });
});

test("a Vietnam round is US against NORTH VIETNAM on every map — never a WW2 nation", () => {
  assert.deepEqual(nationsFor("hllv", "CAM RANH PORT"), [
    { code: "us", name: "UNITED STATES" }, { code: "nva", name: "NORTH VIETNAM" },
  ]);
  // Vietnam's matchup is map-independent, so an unknown or missing map changes nothing.
  assert.deepEqual(nationsFor("hllv", null)?.[1].name, "NORTH VIETNAM");
});

test("a game the nations table doesn't know gets null, not somebody else's war", () => {
  assert.equal(nationsFor("hll3", "somemap"), null);
  assert.equal(nationsFor(null, "carentan_warfare"), null);
});

test("the match board's badge is the one uploaded, and there is none until somebody uploads one", async () => {
  const repo = new InMemoryRepository();
  assert.equal(await loadBoardLogo(repo), null, "nothing is built in: the board carries only its server's name");
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
  await repo.brandImages.set("board-badge", { mime: "image/png", bytes: png, by: "owner" });
  assert.deepEqual([...(await loadBoardLogo(repo))!], [...png]);
  // A store that cannot answer leaves the board without a badge rather than without a board.
  const broken = { brandImages: { get: async () => { throw new Error("database down"); } } };
  assert.equal(await loadBoardLogo(broken as never), null);
});
