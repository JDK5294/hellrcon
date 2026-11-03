/**
 * Seeding enforces the way CRCON does by default: the offense-score cap fight, roles and weapons.
 * Everything judged from where players stand is off until its OWN switch is on — one switch per
 * job: the seeding zones (paint where painted, the auto fence everywhere else), the cap fight by
 * position, and steamroll protection. No switch needs another to be on as well.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SEEDING_DEFAULTS, type SeedingConfigRow } from "@app/db";
import { planSeedingTick, blankAxisCal, capFightByPosition, CAP_POS_GRACE_SEC, type AxisCalState, type SeedRosterPlayer, type Phase } from "../dist/seeding.js";

const cfg = (patch: Partial<SeedingConfigRow> = {}): SeedingConfigRow =>
  ({ serverId: "srv-1", ...SEEDING_DEFAULTS, phaseConfirmSec: 0, phaseHysteresis: 0, updatedAt: new Date(0).toISOString(), ...patch });
const player = (id: string, over: Partial<SeedRosterPlayer> = {}): SeedRosterPlayer => ({ playerId: id, name: id, level: 50, role: 0, tags: [], ...over });
const tick = (input: Partial<Parameters<typeof planSeedingTick>[0]> & { config: SeedingConfigRow; roster: SeedRosterPlayer[] }) =>
  planSeedingTick({
    progress: new Map(), escalation: new Map(), prevPhase: "seeding" as Phase, pendingPhase: null, pendingSinceMs: 0,
    elapsedSec: 30, nowMs: 1_000_000, lastRewardMs: 0, roleName: (r) => `role${r}`, ...input,
  });
function calState(ax: number, bx: number, n = 20): AxisCalState {
  const st = blankAxisCal("foy_warfare");
  st.allies = { x: ax * n, y: 0, n };
  st.axis = { x: bx * n, y: 0, n };
  return st;
}

test("every rule judged by position is off by default; the cap fight's follows its own switch", () => {
  assert.equal(SEEDING_DEFAULTS.positionalEnabled, false);
  assert.equal(SEEDING_DEFAULTS.containEnabled, false);
  assert.equal(SEEDING_DEFAULTS.paceEnabled, false);
  assert.equal(capFightByPosition(cfg()), false);
  assert.equal(capFightByPosition(cfg({ positionalEnabled: true })), true);
});

test("at the defaults no player is punished for WHERE they stand — not past the line, not off their ground", () => {
  // Learn only learns and never enforces, and the old auto-zones switch means nothing: set or
  // not, they arm nothing.
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, containAutoEnabled: true, layoutLearnEnabled: true, containGraceSec: 0,
    minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const session = { gameMode: "warfare", alliedScore: 3, axisScore: 2, mapId: "foy_warfare" };
  const home = [player("w", { side: "allies" as const, offense: null, pos: { x: -80_000, y: 0 } })];
  const deep = [player("w", { side: "allies" as const, offense: null, pos: { x: 70_000, y: 0 } })];
  let t = tick({ config, roster: home, session, axisCal: calState(-80_000, 80_000), nowMs: 900_000 });
  t = tick({ config, roster: home, session, axisCal: t.axisCal, nowMs: 950_000 });
  const a = tick({ config, roster: deep, session, axisCal: t.axisCal, nowMs: 1_000_000 });
  const b = tick({ config, roster: deep, session, axisCal: a.axisCal, capPosState: a.capPosState, containState: a.containState,
    capEscalation: a.capEscalation, containEscalation: a.containEscalation, nowMs: 1_000_000 + (CAP_POS_GRACE_SEC + 30) * 1000 });
  assert.equal(a.actions.length + b.actions.length, 0);
  assert.equal(b.containState.size, 0, "the auto fence is not even watching");
});

test("the seeding zones need their own switch and nothing else: on, the auto fence watches an unpainted map", () => {
  // Cap fight by position off, the old auto-zones switch off: the zones' one switch is enough.
  const config = cfg({ containEnabled: true, containGraceSec: 0, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const session = { gameMode: "warfare", alliedScore: 2, axisScore: 2, mapId: "foy_warfare" };
  const home = [player("w", { side: "allies" as const, pos: { x: -80_000, y: 0 } })];
  const deep = [player("w", { side: "allies" as const, pos: { x: 70_000, y: 0 } })];
  let t = tick({ config, roster: home, session, axisCal: calState(-80_000, 80_000), nowMs: 900_000 });
  t = tick({ config, roster: home, session, axisCal: t.axisCal, containState: t.containState, nowMs: 950_000 });
  const a = tick({ config, roster: deep, session, axisCal: t.axisCal, containState: t.containState, nowMs: 1_000_000 });
  assert.equal(a.containState.size, 1, "standing on the other team's ground starts the grace");
  const b = tick({ config, roster: deep, session, axisCal: a.axisCal, containState: a.containState, containEscalation: a.containEscalation, nowMs: 1_010_000 });
  assert.deepEqual(b.actions.map((x) => x.kind), ["warn"]);
});

test("steamroll protection needs its own switch and nothing else", () => {
  const config = cfg({ paceEnabled: true, minPlayers: 1 });
  const session = { gameMode: "offensive", alliedScore: 0, axisScore: 0, mapId: "foy_offensive_us" };
  const t = tick({ config, roster: [player("a", { side: "allies" as const, pos: { x: 0, y: 0 } })], session, roundStartMs: 900_000, prevPhase: "live" as Phase });
  assert.ok(t.paceNote, "the pace rule reports on the round");
  assert.doesNotMatch(t.paceNote!, /switched off/, "no second switch holds it back");
  assert.match(t.paceNote!, /offensive round/);
});

test("the CRCON-style score cap fight still works: a winning-team player whose offense climbs is warned", () => {
  const config = cfg({ capFightEnabled: true, capFightMaxCaps: 3, minPlayers: 1, maxWarnings: 1, warnIntervalSec: 0 });
  const session = { gameMode: "warfare", alliedScore: 3, axisScore: 2 };
  const winner = (offense: number) => [player("w", { side: "allies" as const, offense })];
  const t1 = tick({ config, roster: winner(100), session });
  const t2 = tick({ config, roster: winner(120), session, capOffense: t1.capOffense, capEscalation: t1.capEscalation });
  assert.deepEqual(t2.actions.map((x) => x.kind), ["warn"]);
});

test("the remembered team→side mapping is forgotten when the map changes — last match's answer is not this match's fact", async () => {
  const { enforcementSides, forgetSidesOnNewMap } = await import("../dist/seeding.js");
  const memory = new Map<number, string | null>();
  const tracker = { mapId: null as string | null };
  // A confident read on Foy places the teams; unconfident reads defer to it for the rest of Foy.
  forgetSidesOnNewMap(memory, tracker, "foy_warfare");
  enforcementSides(new Map([[1, "allies"], [2, "axis"]]), true, memory);
  forgetSidesOnNewMap(memory, tracker, "FOY_WARFARE"); // casing wobble is the same map
  assert.deepEqual([...enforcementSides(new Map([[1, "axis"], [2, "allies"]]), false, memory).values()], ["allies", "axis"]);
  // Carentan starts: the memory is gone, and an unconfident read places nobody.
  forgetSidesOnNewMap(memory, tracker, "carentan_warfare");
  assert.deepEqual([...enforcementSides(new Map([[1, "axis"], [2, "allies"]]), false, memory).values()], [null, null]);
});
