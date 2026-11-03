// The drawn match board. Pixels aren't assertable, but the things that would silently ruin the
// picture are: a missing font (every label renders as nothing), a decode failure on the artwork,
// and a scoreline that isn't sectors being drawn as though it were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderBoardImage, BOARD_W, BOARD_H, EMPTY_TOTALS } from "../dist/board-image.js";

const ART = join(import.meta.dirname, "..", "..", "panel", "public", "game", "hll");
const SIDES = [{ id: "allies", label: "Allies", color: "blue" }, { id: "axis", label: "Axis", color: "red" }];
const TOTALS = {
  allies: { players: 50, kills: 490, deaths: 464, combat: 8362, offense: 7500, defense: 13220, support: 10602 },
  axis: { players: 50, kills: 464, deaths: 490, combat: 7355, offense: 4800, defense: 13580, support: 9191 },
};
const LEADERS = [
  { label: "MOST KILLS", name: "Piggles", value: 52, sideId: "allies" },
  { label: "HIGHEST COMBAT", name: "[LYNX] Hot Dog 7", value: 833, sideId: "allies" },
  { label: "HIGHEST OFFENSE", name: "[SOG] Pvt Ghillie", value: 480, sideId: "axis" },
  { label: "HIGHEST DEFENSE", name: "[LGN] iiYsL", value: 620, sideId: "allies" },
  { label: "HIGHEST SUPPORT", name: "[LGN] iiYsL", value: 1984, sideId: "allies" },
];
const at = new Date("2026-08-03T20:58:00.000Z");
const base = {
  serverName: "The [LYNX] Division #1 | MIC'S MANDATORY!! | LVL50+ SL ENCOURAGED",
  sides: SIDES, totals: TOTALS, leaders: LEADERS, vips: 35, at,
  session: {
    mapName: "PURPLE HEART LANE", gameMode: "Warfare", alliedScore: 3, axisScore: 2,
    playerCount: 100, maxPlayerCount: 100, remainingMatchTime: 3385,
    queueCount: 6, maxQueueCount: 6, vipQueueCount: 742, maxVipQueueCount: 2,
  },
};

/** JPEG carries its dimensions in the SOF0 segment; read them rather than trusting the encoder. */
function jpegSize(buf: Buffer): { w: number; h: number } {
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("no JPEG frame header");
}

test("the board renders at its declared size, as a JPEG", async () => {
  const buf = await renderBoardImage({
    ...base,
    art: await readFile(join(ART, "maps", "purpleheartlane-rain.webp")),
    emblems: {
      allies: await readFile(join(ART, "teams", "us_colored.webp")),
      axis: await readFile(join(ART, "teams", "ger_colored.webp")),
    },
    // The community badge is optional, and its presence changes the header's geometry — the title
    // gets narrower to make room — so the test that draws everything draws one too. None ships with
    // the program, so an emblem stands in for the one a community uploads.
    logo: await readFile(join(ART, "teams", "ger_colored.webp")),
    factionNames: { allies: "UNITED STATES", axis: "GERMANY" },
  });
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8); // SOI — it really is a JPEG
  assert.deepEqual(jpegSize(buf), { w: BOARD_W, h: BOARD_H });
  // Discord rejects attachments over its per-message limit; a board that big would never post.
  assert.ok(buf.length < 4_000_000, `board is ${buf.length} bytes`);
});

test("the headline is the operator's title when they set one, and a guess when they do not", async () => {
  const { headline } = await import("../dist/board-image.js");
  // Without one, everything after the first separator is rules rather than a name.
  assert.equal(headline("The [LYNX] Division #1 | MIC'S MANDATORY!! | LVL50+"), "THE [LYNX] DIVISION #1");
  assert.equal(headline("Plain Server"), "PLAIN SERVER");
  // A separator in the first three characters means the guess found nothing worth printing.
  assert.equal(headline("#1 | Some Community"), "#1 | SOME COMMUNITY");
  // With one, verbatim: case is theirs, and a pipe in it is theirs too.
  assert.equal(headline("whatever the server is called", "The [LYNX] Division"), "The [LYNX] Division");
  assert.equal(headline("Server", "  spaced  "), "spaced");
  // Empty and blank titles are not titles.
  assert.equal(headline("Plain Server", ""), "PLAIN SERVER");
  assert.equal(headline("Plain Server", "   "), "PLAIN SERVER");
});

test("a font is actually available — without one every label draws as nothing", async () => {
  const { GlobalFonts } = await import("@napi-rs/canvas");
  assert.ok(GlobalFonts.families.length > 0, "no fonts installed: the board would render blank");
});

test("missing artwork, missing emblems and an empty round still draw", async () => {
  // The degrade path: an unknown map, a game with no bundled emblems, nobody on the server.
  const buf = await renderBoardImage({
    serverName: "S", sides: SIDES, totals: {}, leaders: [], vips: 0, at,
    session: {}, art: null, emblems: {},
  });
  assert.deepEqual(jpegSize(buf), { w: BOARD_W, h: BOARD_H });
});

test("corrupt artwork is skipped rather than thrown", async () => {
  const buf = await renderBoardImage({ ...base, art: Buffer.from("not an image at all"), emblems: { allies: Buffer.from("nope") } });
  assert.deepEqual(jpegSize(buf), { w: BOARD_W, h: BOARD_H });
});

test("the weathering is fixed for a round — the board redraws every minute and must not crawl", async () => {
  const twice = await Promise.all([renderBoardImage({ ...base, art: null, emblems: {} }), renderBoardImage({ ...base, art: null, emblems: {} })]);
  assert.ok(twice[0].equals(twice[1]), "same round drew two different boards: the grit is not seeded");
  // A different map is a different round, and gets its own dirt.
  const other = await renderBoardImage({ ...base, session: { ...base.session, mapName: "CARENTAN" }, art: null, emblems: {} });
  assert.ok(!other.equals(twice[0]));
});

test("a scoreline that isn't sectors still renders — the front line just says so", async () => {
  // Skirmish scores in the hundreds; drawing five caps from that would be an invention.
  const buf = await renderBoardImage({
    ...base,
    session: { ...base.session, alliedScore: 340, axisScore: 120 },
    totals: { allies: EMPTY_TOTALS, axis: EMPTY_TOTALS },
  });
  assert.deepEqual(jpegSize(buf), { w: BOARD_W, h: BOARD_H });
});
