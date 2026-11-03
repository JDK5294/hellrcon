// Integrity of the event vocabulary — the one table the game log, the profile's activity feed and
// the auto-mod rule editor all read from.
//
// It used to be three tables. The rule editor kept its own hand-written list of trigger kinds, and
// it had drifted four kinds behind: rules simply could not be written against player kicked, player
// banned, admin message or vote completed, all of which the ingest was recording the whole time.
// Nothing failed — the dropdown just quietly didn't offer them. These assertions are what makes the
// next addition show up everywhere at once instead of in one place and not the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_CATEGORIES, CATEGORISED_KINDS, EVENT_TAG, EVENT_KIND_LABEL, ALL_EVENT_KINDS, eventKindLabel, kindLabel, ordinal, teamSwitchText } from "../lib/eventKinds.ts";
// The game package's own wording — what rules match against. Read straight from source (it has
// no imports): the panel imports no workspace packages, so it keeps a copy, held to this one.
import { teamSwitchText as gameTeamSwitchText } from "../../../packages/games/src/team-switch.ts";

test("every kind has both a chip and a human name", () => {
  for (const k of ALL_EVENT_KINDS) {
    assert.ok(EVENT_TAG[k], `${k} has a name but no tag chip — it would render as a bare bullet`);
    assert.ok(EVENT_KIND_LABEL[k]?.trim(), `${k} has no human name`);
  }
  // And the other direction: a tag without a name is a kind the rule editor cannot offer.
  for (const k of Object.keys(EVENT_TAG)) {
    assert.ok(EVENT_KIND_LABEL[k], `${k} is rendered in the log but has no name for the rule editor`);
  }
});

test("every kind a filter can select is one the vocabulary knows", () => {
  const known = new Set(ALL_EVENT_KINDS);
  for (const k of CATEGORISED_KINDS) {
    assert.ok(known.has(k), `category filter offers ${k}, which nothing knows how to label or colour`);
  }
});

test("a human name never leaks the raw key", () => {
  for (const k of ALL_EVENT_KINDS) {
    const label = eventKindLabel(k);
    assert.ok(!label.startsWith("evt."), `${k} labels as "${label}" — the database key reached the screen`);
  }
  // An unknown kind still degrades to something readable rather than the key itself.
  assert.equal(eventKindLabel("evt.player.somethingNew"), "somethingNew");
});

test("the category list stays well formed", () => {
  const ids = new Set();
  for (const c of EVENT_CATEGORIES) {
    assert.ok(!ids.has(c.id), `duplicate category id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.label.trim(), `${c.id} has no label`);
  }
  // "All" is the only one allowed to match everything; any other empty list is a filter that
  // silently does nothing.
  for (const c of EVENT_CATEGORIES) {
    if (c.id !== "all") assert.ok(c.kinds.length > 0, `${c.id} selects no kinds, so it filters nothing`);
  }
});

// The owner's case: a player swapping sides to find the other team's garrisons. Unassigned sits
// between the sides, so a swap is the join onto the other side; ingest marks it, and every surface
// words it the same (the Discord relay's copy is pinned to these same strings).
test("a team switch reads as a person would say it", () => {
  assert.equal(teamSwitchText({ from: "None", to: "Allies", change: "joined Allies" }), "joined Allies");
  assert.equal(teamSwitchText({ from: "Allies", to: "None", change: "left Allies" }), "left Allies (unassigned)");
  assert.equal(teamSwitchText({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 }), "switched sides Allies → Axis");
  assert.equal(teamSwitchText({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 2 }), "switched sides Allies → Axis (2nd this round)");
  assert.equal(teamSwitchText({ from: "Allies", to: "Axis" }), "switched sides Allies → Axis", "a direct line across is a swap too");
  assert.equal(teamSwitchText({ from: "None", to: "None", change: "unassigned" }), "unassigned");
  assert.equal(teamSwitchText({ change: "joined Allies" }), "joined Allies", "a row with only its sentence");
  assert.equal(teamSwitchText(null), null, "an older row with nothing — the caller says 'switched team'");
  assert.equal(kindLabel("evt.player.teamSwitched"), "team switch", "never the raw 'teamSwitched'");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
});

test("the panel words a switch exactly as the game package does — the text rules match", () => {
  const cases = [
    { from: "None", to: "Allies" }, { from: "Allies", to: "None" }, { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 },
    { from: "None", to: "Allies", swapFrom: "Axis", swapCount: 2 }, { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 12 },
    { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 23 }, { from: "Allies", to: "Axis" }, { from: "None", to: "None" },
    { from: " none ", to: "UNASSIGNED" }, { from: "allies", to: "Allies" }, { change: "joined Allies" }, {}, null,
  ];
  for (const c of cases) assert.equal(teamSwitchText(c), gameTeamSwitchText(c), JSON.stringify(c));
});

test("team switches have a filter of their own, and no kind sits under two filters", () => {
  const sw = EVENT_CATEGORIES.find((c) => c.id === "teamswitches");
  assert.deepEqual(sw?.kinds, ["evt.player.teamSwitched"]);
  assert.ok(!EVENT_CATEGORIES.find((c) => c.id === "connections").kinds.includes("evt.player.teamSwitched"), "lost among every join and leave no more");
  const seen = new Map();
  for (const c of EVENT_CATEGORIES) for (const k of c.kinds) {
    assert.ok(!seen.has(k), `${k} is under both ${seen.get(k)} and ${c.id} — a filter that does not narrow, and a count that doubles`);
    seen.set(k, c.id);
  }
});
