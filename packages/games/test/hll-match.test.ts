import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMatchResult, resultMapName, sameMapName } from "../src/hll/match.ts";

test("parses a named winning side + score", () => {
  const o = parseMatchResult("`Carentan Warfare` ALLIED (2 - 3)");
  assert.equal(o.winner, "allies");
  assert.equal(o.alliedScore, 2);
  assert.equal(o.axisScore, 3);
});

test("parses AXIS winner", () => {
  const o = parseMatchResult("Foy Warfare AXIS (5 - 0)");
  assert.equal(o.winner, "axis");
  assert.equal(o.alliedScore, 5);
  assert.equal(o.axisScore, 0);
});

test("infers winner from a decisive score when no side is named", () => {
  const o = parseMatchResult("SME Offensive (3 - 2)");
  assert.equal(o.winner, "allies"); // left (allied) > right (axis)
  assert.equal(o.alliedScore, 3);
  assert.equal(o.axisScore, 2);
});

test("uses a pre-extracted score string and leaves winner null on a draw", () => {
  const o = parseMatchResult("Kursk Warfare", "2 - 2");
  assert.equal(o.winner, null);
  assert.equal(o.alliedScore, 2);
  assert.equal(o.axisScore, 2);
});

test("no score, no side → all null", () => {
  const o = parseMatchResult("Stalingrad Warfare");
  assert.deepEqual(o, { winner: null, alliedScore: null, axisScore: null });
});

test("the modern flanked line names NO winner — the score is the verdict", () => {
  // "ALLIED (2 - 3) AXIS": both sides are scoreboard column labels. Reading the first token as
  // the winner recorded every round in the field as an Allied win — a 122–0 season, and rounds
  // Axis won 3–2 wearing "Winner: Allies" on their own detail page.
  const axisWon = parseMatchResult("`Kharkov Warfare` ALLIED (2 - 3) AXIS");
  assert.equal(axisWon.winner, "axis");
  assert.equal(axisWon.alliedScore, 2);
  assert.equal(axisWon.axisScore, 3);

  const alliesWon = parseMatchResult("`CARENTAN NIGHT Warfare` ALLIED (5 - 0) AXIS");
  assert.equal(alliesWon.winner, "allies");
  assert.equal(alliesWon.alliedScore, 5);
  assert.equal(alliesWon.axisScore, 0);

  // A tied flanked line has no winner to name, and none may be invented.
  assert.equal(parseMatchResult("`Foy Warfare` ALLIED (2 - 2) AXIS").winner, null);
});

test("in the flanked shape the numbers follow the labels, whichever order the game prints", () => {
  const o = parseMatchResult("`Foy Warfare` AXIS (3 - 2) ALLIED");
  assert.equal(o.axisScore, 3);
  assert.equal(o.alliedScore, 2);
  assert.equal(o.winner, "axis");
});

test("resultMapName reads only the unambiguous backticked map; sameMapName forgives presentation", () => {
  assert.equal(resultMapName("`Kharkov Warfare` ALLIED (2 - 3) AXIS"), "Kharkov Warfare");
  assert.equal(resultMapName("Foy Warfare AXIS (5 - 0)"), null, "no backticks = no trusted name");
  assert.equal(resultMapName(""), null);
  assert.equal(sameMapName("CARENTAN NIGHT  Warfare", "carentan night warfare"), true);
  assert.equal(sameMapName("Kharkov Warfare", "Foy Warfare"), false);
});

test("the score is read even when it is not the end of the line", () => {
  // The old regex anchored "(a - b)" to the end of the string, so the modern line's trailing
  // side label hid the score entirely and every round leaned on the sampled live score.
  const o = parseMatchResult("`Kharkov Warfare` ALLIED (1 - 4) AXIS");
  assert.equal(o.alliedScore, 1);
  assert.equal(o.axisScore, 4);
});
