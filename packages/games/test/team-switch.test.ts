import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine } from "../dist/hll/log.js";
import { describeSwitchHistory, describeTeamSwitch, foldTeamSwitches, isSideSwap, isUnassigned, parseTeamSwitchBody, teamSwitchText, NO_SWITCHES } from "../dist/team-switch.js";

const ctx = { serverId: "srv-1" };

test("a TEAMSWITCH line keeps both teams, in words — the line's own stamp and name as ever", () => {
  const e = normalizeLine("[1:03 min (1779974682)] TEAMSWITCH ilike2maps (Allies > None)", ctx) as any;
  assert.equal(e.kind, "evt.player.teamSwitched");
  assert.equal(e.playerName, "ilike2maps");
  assert.equal(e.ts, new Date(1779974682 * 1000).toISOString());
  assert.deepEqual(e.data, { from: "Allies", to: "None", change: "left Allies" });
  assert.equal(e.playerId, undefined, "the game's line carries no id — ingest links it by name");

  const join = normalizeLine("TEAMSWITCH AB_Moss EGS (None > Allies)", ctx) as any;
  assert.equal(join.playerName, "AB_Moss EGS");
  assert.deepEqual(join.data, { from: "None", to: "Allies", change: "joined Allies" });
});

test("a name carrying its own brackets stays whole — the teams are the LAST bracket", () => {
  const e = normalizeLine("TEAMSWITCH Bob (TTV) (Axis > None)", ctx) as any;
  assert.equal(e.playerName, "Bob (TTV)");
  assert.equal(e.data.from, "Axis");
  assert.equal(e.data.to, "None");
  assert.deepEqual(parseTeamSwitchBody("TEAMSWITCH a>b (None > Axis)"), { name: "a>b", from: "None", to: "Axis" });
  assert.equal(parseTeamSwitchBody("TEAMSWITCH (None > Axis)"), null, "no name, no event");
  assert.equal(normalizeLine("TEAMSWITCH nobody", ctx), null);
});

test("Unassigned sits between the sides: a swap is the join onto the other side, not either line alone", () => {
  // Joining at connect, then Allies → Unassigned → Axis, then back again.
  let s = NO_SWITCHES;
  const step = (from: string, to: string) => { const r = describeTeamSwitch({ from, to }, s); s = r.after; return r.data; };
  assert.deepEqual(step("None", "Allies"), { from: "None", to: "Allies", change: "joined Allies" }, "the first pick is no swap");
  assert.deepEqual(step("Allies", "None"), { from: "Allies", to: "None", change: "left Allies" });
  assert.deepEqual(step("None", "Axis"), { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" });
  assert.equal(step("Axis", "None").change, "left Axis");
  assert.deepEqual(step("None", "Allies"), { from: "None", to: "Allies", swapFrom: "Axis", swapCount: 2, change: "switched sides Axis → Allies" });
  assert.deepEqual(s, { lastSide: "Allies", swaps: 2 });
});

test("dropping to Unassigned and coming back to the same side is not a swap", () => {
  const s = foldTeamSwitches([{ from: "None", to: "Axis" }, { from: "Axis", to: "None" }, { from: "None", to: "Axis" }]);
  assert.deepEqual(s, { lastSide: "Axis", swaps: 0 });
  assert.equal(describeTeamSwitch({ from: "None", to: "axis" }, s).data.change, "joined axis", "case aside, the same side");
});

test("the other side without a 'left' line first (a reconnect), or a direct line across, is still a swap", () => {
  const afterReconnect = describeTeamSwitch({ from: "None", to: "Axis" }, { lastSide: "Allies", swaps: 0 });
  assert.equal(afterReconnect.data.swapFrom, "Allies");
  const direct = describeTeamSwitch({ from: "Allies", to: "Axis" });
  assert.equal(direct.data.change, "switched sides Allies → Axis");
  assert.equal(direct.data.swapCount, 1);
});

test("Unassigned is None, Unassigned or blank — anything else is a side", () => {
  for (const t of ["None", "none", "Unassigned", "", "  ", null, undefined]) assert.equal(isUnassigned(t), true, String(t));
  for (const t of ["Allies", "Axis", "US", "NVA"]) assert.equal(isUnassigned(t), false, t);
});

test("a stored switch reads as every surface shows it — and as rules match it", () => {
  assert.equal(teamSwitchText({ from: "None", to: "Allies", change: "joined Allies" }), "joined Allies");
  assert.equal(teamSwitchText({ from: "Allies", to: "None" }), "left Allies (unassigned)");
  assert.equal(teamSwitchText({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 }), "switched sides Allies → Axis");
  assert.equal(teamSwitchText({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 2 }), "switched sides Allies → Axis (2nd this round)");
  assert.equal(teamSwitchText({ from: "None", to: "Allies", swapFrom: "Axis", swapCount: 13 }), "switched sides Axis → Allies (13th this round)");
  assert.equal(teamSwitchText({ from: "Allies", to: "Axis" }), "switched sides Allies → Axis");
  assert.equal(teamSwitchText({ from: "None", to: "None" }), "unassigned");
  assert.equal(teamSwitchText({ change: "joined Allies" }), "joined Allies");
  assert.equal(teamSwitchText(null), null);
  // What describeTeamSwitch stores reads back the same.
  let s = NO_SWITCHES;
  for (const [from, to, text] of [["None", "Allies", "joined Allies"], ["Allies", "None", "left Allies (unassigned)"], ["None", "Axis", "switched sides Allies → Axis"], ["Axis", "None", "left Axis (unassigned)"], ["None", "Allies", "switched sides Axis → Allies (2nd this round)"]] as const) {
    const r = describeTeamSwitch({ from, to }, s);
    s = r.after;
    assert.equal(teamSwitchText(r.data), text);
  }
});

test("a side swap is the player landing on the other side — never the drop to Unassigned or a join", () => {
  assert.equal(isSideSwap({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 }), true, "the join completing Allies → None → Axis");
  assert.equal(isSideSwap({ from: "Allies", to: "Axis" }), true, "a direct line across");
  assert.equal(isSideSwap({ from: "Allies", to: "None" }), false, "the drop to Unassigned");
  assert.equal(isSideSwap({ from: "Allies", to: "Unassigned", swapFrom: "Axis" }), false, "nothing that ends on Unassigned");
  assert.equal(isSideSwap({ from: "None", to: "Allies" }), false, "joining at connect, or coming back to the side they left");
  assert.equal(isSideSwap({ from: "None", to: "allies", swapFrom: "Allies" }), false, "the same side, case aside");
  assert.equal(isSideSwap({ change: "switched sides Allies → Axis" }), false, "no teams to read");
  assert.equal(isSideSwap(null), false);
  // What reads as "switched sides" is a swap, and nothing else is — the trigger and the log agree.
  let s = NO_SWITCHES;
  for (const [from, to] of [["None", "Allies"], ["Allies", "None"], ["None", "Allies"], ["Allies", "None"], ["None", "Axis"], ["Axis", "Allies"], ["Allies", "None"], ["None", "Allies"]] as const) {
    const r = describeTeamSwitch({ from, to }, s);
    s = r.after;
    assert.equal(isSideSwap(r.data), teamSwitchText(r.data)!.startsWith("switched sides"), `${from} > ${to}`);
  }
  assert.equal(s.swaps, 2);
});

test("a history read at once: per player, per round, a leave before a join in the same second, and no round across a long gap", () => {
  const H = 3_600_000;
  const rows = [
    { ts: 5 * 60_000, who: "id:a", step: { from: "None", to: "Axis" } },       // 0
    { ts: 0, who: "id:a", step: { from: "None", to: "Allies" } },              // 1 (out of order on purpose)
    { ts: 5 * 60_000, who: "id:a", step: { from: "Allies", to: "None" } },     // 2 same second as 0: read first
    { ts: 6 * 60_000, who: "id:b", step: { from: "None", to: "Allies" } },     // 3 another player: his own round
    { ts: 2 * H, who: "id:a", step: { from: "None", to: "Allies" } },          // 4 after the edge at 1h: a new round
    { ts: 2 * H + 4 * H, who: "id:a", step: { from: "None", to: "Axis" } },    // 5 four hours on, no edge: no swap
  ];
  const d = describeSwitchHistory(rows, [1 * H], 3 * H);
  assert.equal(d[1]!.change, "joined Allies");
  assert.equal(d[2]!.change, "left Allies");
  assert.deepEqual(d[0], { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" });
  assert.equal(d[3]!.change, "joined Allies");
  assert.equal(d[4]!.change, "joined Allies");
  assert.equal(d[5]!.change, "joined Axis");
});
