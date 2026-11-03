/**
 * The menu and the window it sits in (lib/menuFit). The scroll that keeps the open screen's entry
 * in view moves as little as it can, and shows the tab you are on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_FRAME, FIT_STEPS, menuScrollTop, screenRoom, scrollToShow, stepsToFit } from "../lib/menuFit.ts";
import { DEFAULT_USER_PREFS, SCREEN_SIZES, readScreenSize } from "../lib/userPrefs.ts";

test("the menu moves only as far as it must to show the open screen's entry", () => {
  // A view 400 tall, scrolled to 100: rows 100–500 are on screen.
  assert.equal(scrollToShow(100, 400, 150, 300), 100, "already in view: no move");
  assert.equal(scrollToShow(100, 400, 40, 90), 40, "above the view: up to its top");
  assert.equal(scrollToShow(100, 400, 520, 600), 200, "below the view: just far enough that its bottom shows");
  assert.equal(scrollToShow(0, 400, 300, 900), 300, "taller than the view: its top stays in view");
  assert.equal(scrollToShow(100, 400, 100, 500), 100, "exactly the view: no move");
});

test("the open entry is shown whole when it fits; else its name at the top, down past the open tab; else the open tab", () => {
  // A view 300 tall, scrolled to the top: rows 0–300 are on screen.
  assert.equal(menuScrollTop(0, 300, [400, 650], [600, 620]), 350, "fits: the least move that shows all of it");
  assert.equal(menuScrollTop(0, 300, [400, 800], [430, 450]), 400, "too tall: its name at the top, the open tab and the next ones under it");
  assert.equal(menuScrollTop(400, 300, [400, 800], [520, 540]), 400, "its name and the open tab already in view: no jolt");
  assert.equal(menuScrollTop(0, 300, [400, 800], [760, 780]), 480, "the open tab too far below the name: the open tab");
  assert.equal(menuScrollTop(500, 300, [400, 800], [760, 780]), 500, "and once it is in view, stepping on does not move the list");
  assert.equal(menuScrollTop(200, 300, [100, 130], [100, 130]), 100, "a screen without tabs, above the view: up to it");
});

test("the menu takes the fewest steps that make it fit, and all of them when none is enough", () => {
  assert.equal(stepsToFit([600], 650), 0, "fits as it is: no step");
  assert.equal(stepsToFit([1095, 891, 782], 800), 2, "the first that fits");
  assert.equal(stepsToFit([1095, 891, 782, 640], 650), 3, "a laptop's window: down to the rules");
  assert.equal(stepsToFit([1505, 1249, 1140, 976], 650), 3, "none fits: every step measured, and the menu scrolls");
  assert.deepEqual([...FIT_STEPS], ["snug", "tight", "lines", "tabs-above"], "least noticeable first");
});

test("the screen sizes run from the smallest to the largest, and each packs the menu for its browser window", () => {
  const area = (s) => s.id.split("x").reduce((a, b) => Number(a) * Number(b));
  assert.equal(SCREEN_SIZES[0].id, "1280x720", "the smallest common size first");
  assert.equal(SCREEN_SIZES.at(-1).id, "3840x2160", "4K last");
  for (let i = 1; i < SCREEN_SIZES.length; i++) assert.ok(area(SCREEN_SIZES[i]) > area(SCREEN_SIZES[i - 1]), `${SCREEN_SIZES[i].id} after ${SCREEN_SIZES[i - 1].id}`);
  assert.equal(screenRoom("1366x768"), 648, "a 1366 × 768 laptop: its height less the browser's frame, about 650px");
  assert.equal(screenRoom("3840x2160"), 2160 - BROWSER_FRAME);
  assert.equal(screenRoom("auto"), null, "Automatic: the window itself");
  assert.equal(DEFAULT_USER_PREFS.screenSize, "auto", "Automatic until someone picks");
  assert.equal(readScreenSize("1920x1080"), "1920x1080");
  assert.equal(readScreenSize("1919x1079"), "auto", "a size the list does not have is Automatic");
  assert.equal(readScreenSize(undefined), "auto");
});
