import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTeamSides, staticSideOf, teamSidesConfident } from "../src/team-sides.ts";
import type { GameSide } from "../src/types.ts";

// Mirrors HLL_GAME.descriptor.sides (hll.ts can't be imported here: the strip-types test runner
// doesn't rewrite its runtime .js imports). Keep in sync if the descriptor's sides ever change.
const sides: GameSide[] = [
  { id: "allies", label: "Allies", teamValues: [1, 3], parity: "odd", color: "blue" },
  { id: "axis", label: "Axis", teamValues: [0], parity: "even", color: "red" },
];
const counts = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

test("static mapping: observed values + parity fallback", () => {
  assert.equal(staticSideOf(sides, 0)?.id, "axis"); // observed
  assert.equal(staticSideOf(sides, 1)?.id, "allies"); // observed
  assert.equal(staticSideOf(sides, 3)?.id, "allies"); // observed
  assert.equal(staticSideOf(sides, 2)?.id, "axis"); // parity guess (even)
  assert.equal(staticSideOf(sides, 5)?.id, "allies"); // parity guess (odd)
});

test("normal lobby (0 vs 1) keeps the static mapping", () => {
  const m = resolveTeamSides(sides, counts({ 0: 40, 1: 42 }));
  assert.equal(m.get(0), "axis");
  assert.equal(m.get(1), "allies");
});

test("the console 0/2 lobby: session headcounts decide who is who", () => {
  // The exact live failure: both 0 and 2 statically land on axis (everyone shown as Axis).
  // Session says allies=9, axis=8; the roster has 8 on team 0 and 9 on team 2.
  const m = resolveTeamSides(sides, counts({ 0: 8, 2: 9 }), { alliedPlayerCount: 9, axisPlayerCount: 8 });
  assert.equal(m.get(0), "axis");
  assert.equal(m.get(2), "allies");
  // …and mirrored counts flip the assignment, not the rule.
  const m2 = resolveTeamSides(sides, counts({ 0: 9, 2: 8 }), { alliedPlayerCount: 8, axisPlayerCount: 9 });
  assert.equal(m2.get(0), "axis"); // team 0 has 9 players = the session's axis count
  assert.equal(m2.get(2), "allies");
});

test("collapsed guess without usable headcounts: explicit value wins, the guessed one flips", () => {
  // 0 is an observed axis value; 2 is only a parity guess → 2 flips to allies.
  const even = resolveTeamSides(sides, counts({ 0: 8, 2: 8 }));
  assert.equal(even.get(0), "axis");
  assert.equal(even.get(2), "allies");
  // Both explicit (1 and 3 are both observed allies values) → the higher flips.
  const odd = resolveTeamSides(sides, counts({ 1: 10, 3: 10 }));
  assert.equal(odd.get(1), "allies");
  assert.equal(odd.get(3), "axis");
});

test("three equal groups: the two values the descriptor lists are the teams; a single-team roster keeps the static rule", () => {
  const three = resolveTeamSides(sides, counts({ 0: 5, 1: 5, 2: 5 }));
  assert.equal(three.get(0), "axis");
  assert.equal(three.get(1), "allies");
  assert.equal(three.get(2), null, "a third group is on neither team");
  const one = resolveTeamSides(sides, counts({ 0: 30 }));
  assert.equal(one.get(0), "axis");
});

test("a player mid team-switch doesn't collapse both real teams onto one side", () => {
  // Seen live on a full server: 49 v 49 with one person switching teams, so the roster carried a
  // THIRD team value holding a single player. The correction used to require exactly two values
  // and gave up, leaving the static map's collapse in place — both 49-player teams labelled Axis,
  // every kill credited to one side and zero to the other.
  const m = resolveTeamSides(sides, counts({ 0: 49, 2: 49, 1: 1 }), { alliedPlayerCount: 49, axisPlayerCount: 49 });
  assert.equal(m.get(0), "axis", "team 0 is the descriptor's explicit axis value");
  assert.equal(m.get(2), "allies", "the other big group is the other side");
  assert.notEqual(m.get(0), m.get(2), "the two real teams are never the same side");
});

test("the straggler is on neither team — not filed under whatever side its team value guesses", () => {
  // The two real teams are 0 and 2 here, so team 1 is not Allies on this read even though the
  // descriptor lists it: its occupant is mid-switch, and the game counts them on no side.
  const m = resolveTeamSides(sides, counts({ 0: 49, 2: 49, 1: 1 }));
  assert.equal(m.get(1), null);
});

test("players not yet on a team are never counted onto one — a full team shows 50, not 52", () => {
  // Seen live: 99 connected, the game's own headcounts 50 Allies / 47 Axis, and two players on
  // the team-select screen under a third team value. Whatever that value is, they belong to no side.
  for (const stray of [3, 5, 255, 2]) {
    const m = resolveTeamSides(sides, counts({ 1: 50, 0: 47, [stray]: 2 }), { alliedPlayerCount: 50, axisPlayerCount: 47 });
    assert.equal(m.get(stray), null, `team value ${stray}`);
    assert.equal(m.get(1), "allies");
    assert.equal(m.get(0), "axis");
  }
});

test("a quiet server: one real team plus somebody loading in is not a player on the other side", () => {
  // Three on Axis, the session says zero Allies, and one more player sits on a second team value.
  const m = resolveTeamSides(sides, counts({ 0: 3, 5: 1 }), { alliedPlayerCount: 0, axisPlayerCount: 3 });
  assert.equal(m.get(0), "axis");
  assert.equal(m.get(5), null, "the game has nobody on Allies");
  // Without headcounts there is no evidence, and two groups stay the two teams.
  assert.equal(resolveTeamSides(sides, counts({ 0: 3, 5: 1 })).get(5), "allies");
  // And once the second group IS on a team, the session says so and it is one.
  assert.equal(resolveTeamSides(sides, counts({ 0: 3, 1: 1 }), { alliedPlayerCount: 1, axisPlayerCount: 3 }).get(1), "allies");
});

test("ties in group size resolve deterministically rather than by map order", () => {
  // Equal counts must not make the answer depend on which value happened to be seen first.
  const a = resolveTeamSides(sides, counts({ 0: 49, 2: 49 }));
  const b = resolveTeamSides(sides, counts({ 2: 49, 0: 49 }));
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("three roughly-equal groups still separate the top two", () => {
  // Defensive: whatever the third value is, the two biggest still have to be different sides.
  const m = resolveTeamSides(sides, counts({ 0: 30, 2: 28, 4: 5 }));
  assert.notEqual(m.get(0), m.get(2));
});

/*
 * The confidence probe: whether a read's answer rests on evidence (static separation, or exact
 * headcounts) rather than the last-resort flip. The live sampler writes its remembered mapping
 * only on confident reads, so a half-loaded lobby — one team visible, equal headcounts — cannot
 * repaint what a confident read already established.
 */
test("teamSidesConfident: evidence says yes, the last-resort flip says no", () => {
  // Static separates 0 (axis) from 1 (allies) on its own — confident regardless of session.
  assert.equal(teamSidesConfident(sides, counts({ 0: 40, 1: 42 })), true);
  // Collapsed onto one side statically, but the headcounts match the roster exactly — that is
  // the same evidence resolveTeamSides itself corrects from, so it counts as confident.
  assert.equal(teamSidesConfident(sides, counts({ 0: 8, 2: 9 }), { alliedPlayerCount: 9, axisPlayerCount: 8 }), true);
  // Equal headcounts (match start) decide nothing.
  assert.equal(teamSidesConfident(sides, counts({ 0: 9, 2: 9 }), { alliedPlayerCount: 9, axisPlayerCount: 9 }), false);
  // One visible team proves nothing about which side it is.
  assert.equal(teamSidesConfident(sides, counts({ 2: 5 })), false);
});
