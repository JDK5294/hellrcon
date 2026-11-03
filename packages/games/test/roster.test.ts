import { test } from "node:test";
import assert from "node:assert/strict";
// Imported from dist (test script builds first): roster.ts imports its sibling team-sides.js, and
// strip-types can't resolve a .js specifier back to a .ts source — same pattern as the hll tests.
import { summarizeRoster, type RosterPlayerLike } from "../dist/roster.js";
import { HLL_GAME } from "../dist/index.js";
import type { GameDescriptor } from "../dist/types.js";

// Mirrors HLL_GAME.descriptor (hll.ts can't be imported here: the strip-types test runner doesn't
// rewrite its runtime .js imports). Held to the real thing by the guard test below rather than by
// anyone remembering — a mirror that silently drifts is worse than no mirror.
const descriptor = {
  sides: [
    { id: "allies", label: "Allies", teamValues: [1, 3], parity: "odd", color: "blue" },
    { id: "axis", label: "Axis", teamValues: [0], parity: "even", color: "red" },
  ],
  squadLeaderRoles: [4, 9, 12, 14],
  roles: {
    0: "Rifleman", 1: "Assault", 2: "Automatic Rifleman", 3: "Medic", 4: "Spotter",
    5: "Support", 6: "Machinegunner", 7: "Anti-Tank", 8: "Engineer", 9: "Officer",
    10: "Sniper", 11: "Crewman", 12: "Tank Commander", 13: "Commander",
    14: "Artillery Observer", 15: "Operator", 16: "Gunner",
  },
} as Pick<GameDescriptor, "sides" | "squadLeaderRoles" | "roles">;

const RIFLEMAN = 0;
const SPOTTER = 4;
const OFFICER = 9;
const CREWMAN = 11;
const TANK_COMMANDER = 12;
const ARTILLERY_OBSERVER = 14;
const GUNNER = 16;
/** A role number the descriptor has no name for — what the NEXT game update adding roles looks like. */
const UNKNOWN = 99;

/** n players on `team` in `squad`, all riflemen unless `withLeader` puts an officer among them. */
const squad = (team: number, name: string, n: number, withLeader: boolean): RosterPlayerLike[] =>
  Array.from({ length: n }, (_, i) => ({ team, platoon: name, role: withLeader && i === 0 ? OFFICER : RIFLEMAN }));

test("counts players, squads and roles per side", () => {
  const s = summarizeRoster([
    ...squad(1, "ABLE", 6, true),
    ...squad(1, "BAKER", 4, false),
    ...squad(0, "EASY", 6, true),
  ], descriptor);

  assert.equal(s.players, 16);
  assert.equal(s.bySide.allies!.players, 10);
  assert.equal(s.bySide.axis!.players, 6);
  assert.equal(s.bySide.allies!.squads, 2);
  assert.equal(s.bySide.axis!.squads, 1);
  assert.deepEqual(s.byRole, { [RIFLEMAN]: 14, [OFFICER]: 2 });
  assert.deepEqual(s.bySide.axis!.byRole, { [RIFLEMAN]: 5, [OFFICER]: 1 });
});

test("a squad with nobody in a leader role is reported, by side", () => {
  const s = summarizeRoster([
    ...squad(1, "ABLE", 6, true),
    ...squad(1, "BAKER", 4, false),
    ...squad(1, "CHARLIE", 3, false),
    ...squad(0, "EASY", 6, false),
  ], descriptor);

  assert.deepEqual(s.bySide.allies!.noSlSquads, ["BAKER", "CHARLIE"], "sorted, and only the leaderless ones");
  assert.deepEqual(s.bySide.axis!.noSlSquads, ["EASY"]);
});

test("a recon or armour squad is led by its own leader role, not by an officer", () => {
  /*
   * Reported from a live server: the roster called out four squads a side as having no SL while
   * staff were looking straight at their leaders. They were the two-man recon and three-man armour
   * squads — the descriptor named only the infantry Officer, so a Spotter or a Tank Commander did
   * not count and every one of those squads was accused.
   */
  const s = summarizeRoster([
    { team: 1, platoon: "CHARLIE", role: SPOTTER }, { team: 1, platoon: "CHARLIE", role: 10 },
    { team: 1, platoon: "DOG", role: TANK_COMMANDER }, { team: 1, platoon: "DOG", role: CREWMAN },
    ...squad(0, "ABLE", 3, false),
  ], descriptor);

  assert.deepEqual(s.bySide.allies!.noSlSquads, [], "the spotter leads recon and the commander leads armour");
  assert.deepEqual(s.bySide.axis!.noSlSquads, ["ABLE"], "an infantry squad with no officer is still called out");
});

test("an artillery squad is led by its observer, and judged like any other without one", () => {
  // Reported live and the reason the role table got checked against the reference: the artillery
  // roles are 14-16, none of them existed here, so every artillery squad read as leaderless.
  const led = summarizeRoster([
    { team: 1, platoon: "EASY", role: ARTILLERY_OBSERVER },
    { team: 1, platoon: "EASY", role: GUNNER }, { team: 1, platoon: "EASY", role: 15 },
  ], descriptor);
  assert.deepEqual(led.bySide.allies!.noSlSquads, [], "the observer leads it");

  const unled = summarizeRoster([
    { team: 1, platoon: "EASY", role: GUNNER }, { team: 1, platoon: "EASY", role: 15 },
  ], descriptor);
  assert.deepEqual(unled.bySide.allies!.noSlSquads, ["EASY"], "gunners and operators do not");
});

test("a squad holding a role we cannot name is not accused of being leaderless", () => {
  /*
   * The artillery case above is fixed by knowing the roles. This is the rule for the next time the
   * game adds some and we do not know them yet: a role number with no name could be that squad
   * type's leader, so the summary declines rather than accusing the squad.
   *
   * "Cannot tell" is already how a descriptor with no leader roles at all behaves; this is that
   * rule one level down, per squad.
   */
  const s = summarizeRoster([
    { team: 1, platoon: "EASY", role: UNKNOWN }, { team: 1, platoon: "EASY", role: UNKNOWN },
    { team: 1, platoon: "EASY", role: RIFLEMAN },
    ...squad(0, "ABLE", 3, false),
  ], descriptor);

  assert.deepEqual(s.bySide.allies!.noSlSquads, [], "an unnamed role could be that squad type's leader");
  assert.deepEqual(s.bySide.axis!.noSlSquads, ["ABLE"], "a squad we can fully read is still judged");
  assert.equal(s.bySide.allies!.squads, 1, "and it is still counted as a squad");
});

test("the mirror above is the real HLL descriptor", () => {
  // This test file works from a hand-copied descriptor, and the leader-role bug above was a value
  // in the real one. Pin them together so a fix here cannot pass while production stays broken.
  assert.deepEqual([...HLL_GAME.descriptor.squadLeaderRoles].sort((a, b) => a - b), [SPOTTER, OFFICER, TANK_COMMANDER, ARTILLERY_OBSERVER]);
  assert.deepEqual(HLL_GAME.descriptor.sides, descriptor.sides);
  assert.deepEqual(HLL_GAME.descriptor.roles, descriptor.roles);
  /*
   * And that each id is the role we think it is. These are the wire values HLL sends on the v2
   * `players` read, cross-checked against hllrcon's Role table (hllrcon/data/roles.py) — the same
   * table CRCON resolves role names through. A renumbered catalogue gets caught here rather than
   * by staff watching the wrong squads get accused for a third time.
   */
  const roles = HLL_GAME.descriptor.roles;
  assert.equal(roles[SPOTTER], "Spotter");
  assert.equal(roles[OFFICER], "Officer");
  assert.equal(roles[TANK_COMMANDER], "Tank Commander");
  assert.equal(roles[ARTILLERY_OBSERVER], "Artillery Observer");
  assert.equal(roles[15], "Operator");
  assert.equal(roles[GUNNER], "Gunner");
  // 13 is the ARMY commander. The reference table calls it a leader because it owns its own slot,
  // but it does not lead a squad, and counting it would let one commander cover a leaderless squad.
  assert.equal(roles[13], "Commander");
  assert.ok(!HLL_GAME.descriptor.squadLeaderRoles.includes(13), "the army commander does not lead a squad");
});

test("the same squad name on both teams is two squads, judged separately", () => {
  // Both teams routinely field a squad called BAKER. Merging them would let one side's officer
  // cover for the other side's leaderless squad — the exact thing the readout exists to catch.
  const s = summarizeRoster([...squad(1, "BAKER", 6, true), ...squad(0, "BAKER", 6, false)], descriptor);
  assert.deepEqual(s.bySide.allies!.noSlSquads, []);
  assert.deepEqual(s.bySide.axis!.noSlSquads, ["BAKER"]);
  assert.equal(s.bySide.allies!.squads, 1);
  assert.equal(s.bySide.axis!.squads, 1);
});

test("unsquadded players count toward their side but form no squad", () => {
  const s = summarizeRoster([
    ...squad(1, "ABLE", 4, true),
    { team: 1, platoon: "", role: RIFLEMAN },
    { team: 1, role: RIFLEMAN },
  ], descriptor);
  assert.equal(s.bySide.allies!.players, 6);
  assert.equal(s.bySide.allies!.unsquadded, 2);
  assert.equal(s.bySide.allies!.squads, 1);
});

test("a collapsed team encoding is decided by the session headcounts, not by the fallback guess", () => {
  // Console builds have produced lobbies where BOTH team values (1 and 3) map to allies under the
  // static rules. The resolver always separates them, but without evidence it can only guess which
  // is which — and a wrong guess written to a snapshot misreports that side for as long as the row
  // is kept. Here the guess and the truth disagree, so this pins that the session wins.
  const players = [...squad(1, "ABLE", 40, true), ...squad(3, "EASY", 30, true)];

  const guessed = summarizeRoster(players, descriptor);
  assert.equal(guessed.bySide.allies!.players, 40, "fallback: the higher team value is flipped to axis");
  assert.equal(guessed.bySide.axis!.players, 30);

  const known = summarizeRoster(players, descriptor, { alliedPlayerCount: 30, axisPlayerCount: 40 });
  assert.equal(known.bySide.allies!.players, 30, "the session says the 30 are allies, and it is believed");
  assert.equal(known.bySide.axis!.players, 40);
});

test("a game with no leader role has no leaderless squads", () => {
  const noLeaders = { ...descriptor, squadLeaderRoles: [] };
  const s = summarizeRoster(squad(1, "ABLE", 5, false), noLeaders);
  assert.equal(s.bySide.allies!.squads, 1);
  assert.deepEqual(s.bySide.allies!.noSlSquads, [], "not 'every squad is leaderless'");
});

test("an empty roster is zeroes, not missing sides", () => {
  const s = summarizeRoster([], descriptor);
  assert.equal(s.players, 0);
  assert.equal(s.unassigned, 0);
  assert.deepEqual(Object.keys(s.bySide).sort(), ["allies", "axis"], "both sides present at zero");
  assert.equal(s.bySide.allies!.players, 0);
});

test("no descriptor: everyone is unassigned rather than silently bucketed", () => {
  const s = summarizeRoster(squad(1, "ABLE", 5, true), null);
  assert.equal(s.players, 5);
  assert.equal(s.unassigned, 5);
  assert.deepEqual(s.bySide, {});
  assert.deepEqual(s.byRole, { [RIFLEMAN]: 4, [OFFICER]: 1 }, "roles are still countable without sides");
});
