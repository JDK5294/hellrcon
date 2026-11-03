/**
 * The score series' packed form (match_score_series.packed): each of a point's five numbers as its
 * change since the same number one point earlier, zigzag-encoded, as a base-128 varint. These pin
 * the bytes themselves (an install's stored series must keep reading the same), that every series
 * comes back exactly as it went in, falls and big totals included, and what the packing saves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { packScoreSeries, unpackScoreSeries } from "../src/score-series-pack.ts";

test("score series packing: the stored bytes, number by number", () => {
  // Point 1 from zero: 60s, combat 1, offense 0, defense 0, support 300 (two bytes: 600 = 4×128 + 88).
  // Point 2: +60s, combat falls by 1 (zigzag 1), support falls by 100 (zigzag 199 = 128 + 71).
  const bytes = packScoreSeries([60, 1, 0, 0, 300, 120, 0, 0, 0, 200]);
  assert.deepEqual([...bytes], [120, 2, 0, 0, 216, 4, 120, 1, 0, 0, 199, 1]);
  assert.deepEqual(unpackScoreSeries(bytes), [60, 1, 0, 0, 300, 120, 0, 0, 0, 200]);
});

test("score series packing: a whole round comes back exactly, falls and totals past 32 bits included", () => {
  // A 90-minute round for one player: steady combat, bursts of offense and defense, support in
  // big lumps, and one reconnect that drops every total back to zero.
  const flat: number[] = [];
  let [combat, offense, defense, support] = [0, 0, 0, 0];
  for (let m = 1; m <= 90; m++) {
    if (m === 47) [combat, offense, defense, support] = [0, 0, 0, 0];
    combat += (m * 7) % 23;
    offense += m % 9 === 0 ? 140 : (m * 13) % 20;
    defense += m % 11 === 0 ? 260 : (m * 5) % 17;
    support += m % 4 === 0 ? 600 : 0;
    flat.push(m * 60, combat, offense, defense, support);
  }
  assert.deepEqual(unpackScoreSeries(packScoreSeries(flat)), flat);
  // Arithmetic, never 32-bit bit operators: a total past 2³¹ (or 2³²) is kept whole, rising and falling.
  const big = [5, 2 ** 31 + 7, 2 ** 33, 0, 1, 65, 3, 2 ** 33 + 1, 2 ** 40, 0];
  assert.deepEqual(unpackScoreSeries(packScoreSeries(big)), big);
});

test("score series packing: about 70% smaller than four bytes a number", () => {
  const flat: number[] = [];
  let [combat, offense, defense, support] = [0, 0, 0, 0];
  for (let m = 1; m <= 90; m++) {
    combat += (m * 7) % 23;
    offense += (m * 13) % 41;
    defense += (m * 5) % 37;
    support += m % 4 === 0 ? 150 : 0;
    flat.push(m * 60, combat, offense, defense, support);
  }
  const bytes = packScoreSeries(flat);
  // 90 points at 20 bytes is 1800 as plain ints. Packed: a byte a number, and a second byte for
  // each of the 22 lumps of 150 support.
  assert.equal(bytes.length, 90 * 5 + 22);
  assert.ok(bytes.length <= 1800 * 0.3, `${bytes.length} bytes for 90 points`);
});

test("score series packing: only whole points are kept; a number that is not finite is stored as 0", () => {
  // A trailing partial point is left out, as the readers have always left it out.
  assert.deepEqual(unpackScoreSeries(packScoreSeries([60, 1, 2, 3, 4, 120, 5])), [60, 1, 2, 3, 4]);
  // Bytes that stop mid-number or mid-point give up the unfinished part and nothing else.
  const bytes = packScoreSeries([60, 1, 0, 0, 300, 120, 0, 0, 0, 200]);
  assert.deepEqual(unpackScoreSeries(bytes.subarray(0, bytes.length - 1)), [60, 1, 0, 0, 300]);
  assert.deepEqual(unpackScoreSeries(bytes.subarray(0, 5)), []);
  assert.deepEqual(unpackScoreSeries(new Uint8Array(0)), []);
  assert.deepEqual(unpackScoreSeries(packScoreSeries([60, Number.NaN, Infinity, 2.6, -1.4])), [60, 0, 0, 3, -1]);
});
