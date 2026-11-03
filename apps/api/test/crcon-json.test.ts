/**
 * The CRCON wire writer. Every expected string here comes from a source, not a guess: the float
 * spellings are zmij 1.0.23's own test expectations (tests/test.rs), the library orjson 3.12.0
 * formats floats with; the date spellings are orjson's datetime writer; the rounding is Python's
 * round(), ties to even on the double's exact value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPyFloat, pyDateNaive, pyDateUtc, pyDumps, pyFloat, pyInt, pyIntArgument, pyRepr, pyRound } from "../src/crcon-json.ts";

test("floats are spelled as orjson spells them (zmij's own expectations)", () => {
  const cases: [number, string][] = [
    [1.0, "1.0"], [0.0, "0.0"], [-0.0, "-0.0"],
    [43210.0, "43210.0"], [43210.1, "43210.1"], [10000.0, "10000.0"],
    [-5942736479622170.0, "-5942736479622170.0"],
    [5.444310685350916e+14, "544431068535091.6"],
    [6.62607015e-34, "6.62607015e-34"],
    [Number("2.9802322387695312e-08"), "2.9802322387695312e-8"],
    [Number("5.960464477539062e-07"), "5.960464477539062e-7"],
    [3.439070283483335e+35, "3.439070283483335e+35"],
    [1.3076622631878654e+65, "1.3076622631878654e+65"],
    [5e-324, "5e-324"], [1e-323, "1e-323"],
    // The edges of fixed notation: a leading digit at 10^-5 and 10^15 stays fixed, one step past
    // either is an exponent, and JavaScript would print both of those out in full.
    [1e-5, "0.00001"], [1e-6, "1e-6"], [1e15, "1000000000000000.0"], [1e16, "1e+16"],
    [0.125, "0.125"], [100, "100.0"], [66.67, "66.67"],
  ];
  for (const [x, want] of cases) assert.equal(formatPyFloat(x), want, String(x));
  assert.equal(formatPyFloat(Number.NaN), "null");
  assert.equal(formatPyFloat(Number.POSITIVE_INFINITY), "null");
});

test("round(x, 2) is Python's: ties go to even on the exact value", () => {
  assert.equal(pyRound(1 / 8, 2), 0.12, "1 kill over 8 deaths: 0.125 exactly, a tie, rounds to even");
  assert.equal(pyRound(3 / 8, 2), 0.38, "0.375 exactly: the tie goes up to the even 38");
  assert.equal(pyRound(2.675, 2), 2.67, "2.675 is stored just below, so down");
  assert.equal(pyRound(1.005, 2), 1, "1.005 is stored just below, so down");
  assert.equal(pyRound(2 / 3, 2), 0.67);
  assert.equal(pyRound(7, 2), 7);
  assert.equal(pyRound(-1 / 8, 2), -0.12);
  assert.equal(pyRound(12.5, 0), 12, "and at zero places too, the way round(12.5) is 12");
});

test("dates are Python datetimes as orjson writes them", () => {
  const at = Date.parse("2026-08-01T10:00:00.000Z");
  assert.equal(pyDateUtc(at), "2026-08-01T10:00:00+00:00");
  assert.equal(pyDateNaive(at), "2026-08-01T10:00:00", "naive: no offset at all");
  assert.equal(pyDateUtc(at + 123), "2026-08-01T10:00:00.123000+00:00", "microseconds only when there are some, six digits");
  assert.equal(pyDateNaive(at + 5), "2026-08-01T10:00:00.005000");
});

test("pyDumps writes orjson's bytes: compact, floats marked, dict order kept", () => {
  assert.equal(pyDumps({ a: 1, b: pyFloat(2), c: 0.5, d: null, e: [true, false, "x"] }), '{"a":1,"b":2.0,"c":0.5,"d":null,"e":[true,false,"x"]}');
  // A dict keyed by data keeps its order even when a key looks like an index, which a JavaScript
  // object would hoist to the front.
  const byName = new Map<string, number>([["Zed", 1], ["123", 2], ["Ann", 3]]);
  assert.equal(pyDumps(byName), '{"Zed":1,"123":2,"Ann":3}');
  assert.equal(JSON.stringify({ Zed: 1, "123": 2, Ann: 3 }), '{"123":2,"Zed":1,"Ann":3}', "which is the trap this avoids");
  assert.equal(pyDumps({ kept: 1, dropped: undefined }), '{"kept":1}');
  assert.equal(pyDumps("tab\tquote\"back\\ctrl\u0001é"), JSON.stringify("tab\tquote\"back\\ctrl\u0001é"), "strings escape exactly as JSON.stringify does");
  assert.equal(pyDumps(2 ** 60), "1152921504606846976", "a big whole number is an int's digits, not 1.15e+18");
});

test("int() of a request argument, and the repr() of what it raises, as Python 3.12 has them", () => {
  const value = (v: unknown) => { const r = pyIntArgument(v); return "value" in r ? r.value : r.error; };
  assert.equal(value("42"), 42);
  assert.equal(value(" +7\n"), 7, "a sign, and ASCII whitespace around it");
  assert.equal(value("1_000"), 1000, "underscores between digits");
  assert.equal(value(" 5　"), 5, "Unicode whitespace beyond ASCII");
  assert.equal(value("٣"), 3, "any Unicode decimal digit");
  assert.equal(value("\u001c7"), `ValueError("invalid literal for int() with base 10: '\\\\x1c7'")`, "\\x1c is isspace() but not int()'s whitespace");
  assert.equal(value("5.0"), `ValueError("invalid literal for int() with base 10: '5.0'")`);
  assert.equal(value("1__0"), `ValueError("invalid literal for int() with base 10: '1__0'")`);
  assert.equal(value("a'b"), `ValueError('invalid literal for int() with base 10: "a\\'b"')`, "repr() picks its quotes");
  assert.equal(value("x".repeat(300)), `ValueError("invalid literal for int() with base 10: '${"x".repeat(199)}")`, "the literal's repr is cut at 200 characters");
  assert.equal(value(undefined), `TypeError("int() argument must be a string, a bytes-like object or a real number, not 'NoneType'")`);
  assert.equal(value(["1", "2"]), `TypeError("int() argument must be a string, a bytes-like object or a real number, not 'list'")`, "a repeated key");
  assert.equal(pyRepr("tab\there​\u{1F600}"), "'tab\\there\\u200b\u{1F600}'", "escapes what is not printable, keeps what is");
  assert.equal(pyInt("12"), 12);
});
