// The off-thread renderer is a place to run renderBoardImage, not a different implementation: it
// must produce byte-identical output, and it must not freeze the event loop while doing it — the
// loop it would freeze also runs every server's ingest.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderBoardImage } from "../dist/board-image.js";
import { renderBoardOffThread, closeBoardRenderer } from "../dist/board-render.js";

// The runner tracks the thread's handle even unref'd; without this the test process never exits.
after(() => closeBoardRenderer());

const ART = join(import.meta.dirname, "..", "..", "panel", "public", "game", "hll");

test("the threaded render matches the inline render byte for byte, without blocking the loop", async () => {
  const input = {
    serverName: "The [LYNX] Division #1",
    session: { mapName: "PURPLE HEART LANE", gameMode: "Warfare", alliedScore: 3, axisScore: 2, playerCount: 100, maxPlayerCount: 100, remainingMatchTime: 3385 },
    sides: [{ id: "allies", label: "Allies" }, { id: "axis", label: "Axis" }],
    totals: {}, leaders: [], vips: 0, at: new Date("2026-08-03T20:58:00.000Z"),
    art: await readFile(join(ART, "maps", "purpleheartlane-rain.webp")),
    emblems: {},
  };
  await renderBoardOffThread(input); // first call warms the thread's ground cache

  let last = performance.now();
  let worstGap = 0;
  const beat = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 25);
  const threaded = await renderBoardOffThread(input);
  worstGap = Math.max(worstGap, performance.now() - last);
  clearInterval(beat);

  assert.ok(threaded.equals(await renderBoardImage(input)), "thread and inline renders diverged");
  // The inline render freezes the loop for seconds; anything near that here means the thread
  // isn't actually being used. Generous bound: CI boxes stutter, but not by seconds.
  assert.ok(worstGap < 500, `event loop was frozen for ${Math.round(worstGap)}ms during an off-thread render`);
});
