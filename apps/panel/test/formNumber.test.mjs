// A cleared number input hands back "", not undefined. `Number(f.x ?? fallback)` therefore never
// reaches its fallback and yields 0 — which for crash VIP's cooldown is the one setting that
// turns the anti-farm protection OFF. An empty box has to mean "the default", never "disabled".
import { test } from "node:test";
import assert from "node:assert/strict";
import { numberOr } from "../lib/formNumber.ts";

test("a cleared field falls back to the default rather than to zero", () => {
  assert.equal(numberOr("", 60), 60, "the bug this exists for: blank must not disable the cooldown");
  assert.equal(numberOr(undefined, 60), 60);
  assert.equal(numberOr(null, 60), 60);
});

test("a deliberate zero is kept — 'no limit' stays choosable", () => {
  assert.equal(numberOr(0, 60), 0);
  assert.equal(numberOr("0", 60), 0, "the form hands numbers back as strings");
});

test("real values pass through, as the strings the form supplies", () => {
  assert.equal(numberOr("90", 60), 90);
  assert.equal(numberOr(90, 60), 90);
  assert.equal(numberOr("1440", 10), 1440);
});

test("garbage falls back instead of poisoning the payload with NaN", () => {
  // Number("wat") is NaN, which serialises to null and lands as a confusing 400 (or worse, a
  // stored NaN) rather than the value the staff member thought they left alone.
  assert.equal(numberOr("wat", 60), 60);
  assert.equal(numberOr({}, 60), 60);
});

test("a number box drops leading zeros as you type", async () => {
  const { stripLeadingZeros } = await import("../lib/formNumber.ts");
  assert.equal(stripLeadingZeros("012"), "12", "the '012' a box showed after typing past its 0");
  assert.equal(stripLeadingZeros("010"), "10");
  assert.equal(stripLeadingZeros("00"), "0", "zero itself stays");
  assert.equal(stripLeadingZeros("0"), "0");
  assert.equal(stripLeadingZeros(""), "", "an emptied box stays empty while editing");
  assert.equal(stripLeadingZeros("120"), "120", "only LEADING zeros");
  assert.equal(stripLeadingZeros("0.5"), "0.5");
});

test("the game-rewards screen uses the tidying number box everywhere", async () => {
  const { readFile } = await import("node:fs/promises");
  const screen = await readFile(new URL("../components/GameRewards.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(screen, /type="number"/, "no raw number input left to show '012'");
  const field = await readFile(new URL("../components/NumField.tsx", import.meta.url), "utf8");
  assert.match(field, /stripLeadingZeros\(e\.target\.value\)/);
  assert.match(field, /value=\{draft \?\? String\(value\)\}/, "the box shows the tidied text, not the browser's own");
});
