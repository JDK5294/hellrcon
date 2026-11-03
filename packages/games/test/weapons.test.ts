import test from "node:test";
import assert from "node:assert/strict";
import { HLL_WEAPON_CLASSES } from "../src/hll/weapons.ts";
import { classifyWeapon, weaponClassesOf } from "../src/weapons.ts";
import type { GameDescriptor } from "../src/types.ts";

// A descriptor stub carrying only what the classifier reads — the real HLL_GAME barrel can't load
// under strip-types (its relative imports use compiled .js specifiers), and classes are all it uses.
const HLL_DESC = { weaponClasses: HLL_WEAPON_CLASSES } as GameDescriptor;

const d = HLL_DESC;
const cls = (w: string | null) => classifyWeapon(d, w).id;

test("weapon classes: the specific bucket wins over the general one it overlaps", () => {
  // These are the pairs the ordering exists for: each left value contains the right value's pattern.
  assert.equal(cls("KARABINER 98K x8"), "sniper");
  assert.equal(cls("KARABINER 98K"), "rifle");
  assert.equal(cls("FG42 x4"), "sniper");
  assert.equal(cls("FG42"), "mg");
  assert.equal(cls("COAXIAL MG34"), "armor");
  assert.equal(cls("MG34"), "mg");
  // the AT launchers a rifleman carries are not vehicles, despite the shared prefix
  assert.equal(cls("PANZERSCHRECK"), "explosive");
  assert.equal(cls("PANZERFAUST 60"), "explosive");
  assert.equal(cls("PANZER IV AUSF. F1"), "armor");
  assert.equal(cls("FLAKPANZER IV"), "armor");
});

test("weapon classes: representative HLL weapons land in the right bucket", () => {
  assert.equal(cls("M1 GARAND"), "rifle");
  assert.equal(cls("MP40"), "smg");
  assert.equal(cls("THOMPSON"), "smg");
  assert.equal(cls("M97 TRENCH GUN"), "shotgun");
  assert.equal(cls("BROWNING M1919"), "mg");
  assert.equal(cls("COLT M1911"), "pistol");
  assert.equal(cls("MK2 GRENADE"), "grenade");
  assert.equal(cls("SATCHEL CHARGE"), "explosive");
  assert.equal(cls("PANZERSCHRECK"), "explosive");
  assert.equal(cls("155MM HOWITZER [M114]"), "artillery");
  assert.equal(cls("SHERMAN M4A3(75)W"), "armor");
  assert.equal(cls("M3 KNIFE"), "melee");
});

test("weapon classes: matching is case-insensitive", () => {
  assert.equal(cls("m1 garand"), "rifle");
  assert.equal(cls("Sherman M4A3"), "armor");
});

test("weapon classes: unknown, blank and undeclared all fall to Other rather than throwing", () => {
  assert.equal(cls("DEATH BY MAP"), "other");
  assert.equal(cls(""), "other");
  assert.equal(cls(null), "other");
  assert.equal(classifyWeapon(null, "MP40").id, "other");
  assert.equal(classifyWeapon({ ...d, weaponClasses: undefined }, "MP40").id, "other");
});

test("weaponClassesOf always ends with Other so a breakdown can't drop kills", () => {
  const ids = weaponClassesOf(d).map((c) => c.id);
  assert.equal(ids.at(-1), "other");
  assert.ok(ids.includes("melee"));
  assert.equal(weaponClassesOf(null).map((c) => c.id).join(), "other");
});

test("exactly one class is flagged melee (profiles report it separately)", () => {
  assert.deepEqual((d.weaponClasses ?? []).filter((c) => c.melee).map((c) => c.id), ["melee"]);
});

/*
 * The individual-weapon catalogue (CRCON v12.1.1's kill-log names, verbatim) that drives the
 * seeding picker. These pin the properties the picker and the exact-match config rely on, not the
 * list's contents — the list changes when the game does.
 */
test("weapon catalogue: names are unique, non-blank, and survive verbatim (case included)", async () => {
  const { HLL_WEAPON_NAMES, HLL_COMMANDER_ABILITIES } = await import("../src/hll/weapon-names.ts");
  assert.ok(HLL_WEAPON_NAMES.length > 150, "the whole table, not a sample");
  assert.equal(new Set(HLL_WEAPON_NAMES).size, HLL_WEAPON_NAMES.length, "no duplicates");
  for (const n of HLL_WEAPON_NAMES) assert.ok(n.trim().length > 0, "no blank names");
  // Two canaries for "someone tidied the data": the double space HLL itself emits, and an en-dash.
  assert.ok(HLL_WEAPON_NAMES.includes("PETARD 230MM  [M4A3 (105mm)]"), "the double space is the game's own");
  assert.ok(HLL_WEAPON_NAMES.includes("Fairbairn–Sykes"), "the en-dash is the game's own");
  // Commander abilities are their own lever, never rows of the weapon table.
  assert.deepEqual(HLL_COMMANDER_ABILITIES, ["BOMBING RUN", "STRAFING RUN", "PRECISION STRIKE"]);
  for (const a of HLL_COMMANDER_ABILITIES) assert.ok(!HLL_WEAPON_NAMES.includes(a), a);
});

test("weapon catalogue: upper-casing never collides two names (exact match depends on it)", async () => {
  const { HLL_WEAPON_NAMES } = await import("../src/hll/weapon-names.ts");
  const upper = HLL_WEAPON_NAMES.map((n) => n.toUpperCase());
  assert.equal(new Set(upper).size, upper.length, "no two names differ only by case");
});

test("every catalogue weapon lands in a real bucket, and vehicles are not SMGs", async () => {
  const { HLL_WEAPON_NAMES } = await import("../src/hll/weapon-names.ts");
  // Full coverage: an unmatched name silently piles into "Other", which reads as "we don't know
  // what this is" on a profile and buries it at the bottom of the seeding picker.
  const strays = HLL_WEAPON_NAMES.filter((n) => classifyWeapon(d, n).id === "other");
  assert.deepEqual(strays, []);
  // The bare vehicle is a roadkill; the same vehicle in brackets behind a gun is that gun. Before
  // the Vehicle bucket existed, "M3 Half-track" read as an SMG via the "M3 " pattern.
  assert.equal(cls("M3 Half-track"), "vehicle");
  assert.equal(cls("M2 Browning [M3 Half-track]"), "mg");
  assert.equal(cls("Jeep Willys"), "vehicle");
  assert.equal(cls("Opel Blitz (Supply)"), "vehicle");
});
