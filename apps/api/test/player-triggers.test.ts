/**
 * The pure player-trigger logic: which bus event stands for which trigger events (and for WHOM —
 * a kill is the actor's "kill" and the victim's "death"), whether a trigger matches, and the
 * one-shot disarm decision. No server, no clock, no database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerSubjectsOf, triggerMatches, triggerLoopError, shouldDisarm, describeTrigger, describeStep, stepError, capabilitiesForSteps, parseEventParams, roleNamerFor, triggerGameOf, ACTION_CAPABILITY, TRIGGER_ACTIONS, TRIGGER_EVENTS, MAX_TRIGGER_STEPS } from "../dist/player-triggers.js";
import type { PlayerTriggerRow, PlayerTriggerStep } from "@app/db";

const step = (over: Partial<PlayerTriggerStep> = {}): PlayerTriggerStep =>
  ({ action: "message", message: "welcome back", hours: 0, points: 0, delaySec: 0, ...over });
const base: PlayerTriggerRow = {
  id: "t1", playerId: "player-record-1", playerName: "Nova", serverId: null,
  event: "connect", steps: [step()],
  fireOnce: true, enabled: true, note: null, createdByUserId: null, createdByName: "staff",
  createdAt: "2026-09-17T00:00:00Z", firedCount: 0, lastFiredAt: null, disarmedAt: null, params: {}, updatedAt: null, updatedByName: null,
};
const t = (over: Partial<PlayerTriggerRow> = {}): PlayerTriggerRow => ({ ...base, ...over });
const ev = (over: Record<string, unknown> = {}) => ({ kind: "evt.player.connected", serverId: "srv-1", actorPlayerId: "player-record-1", actorName: "Nova", ...over });

test("triggerSubjectsOf: each bus kind names its trigger events and their subjects", () => {
  assert.deepEqual(triggerSubjectsOf(ev() as never).map((s) => s.event), ["connect"]);
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.player.disconnected" }) as never).map((s) => s.event), ["disconnect"]);
  // A kill names TWO people: the actor's kill (and, when the weapon is one a trigger lists, their
  // weapon kill) and the victim's death.
  const kill = triggerSubjectsOf(ev({ kind: "evt.kill", victimPlayerId: "victim-1", victimName: "Rex" }) as never);
  assert.deepEqual(kill.map((s) => [s.event, s.playerId]), [["kill", "player-record-1"], ["death", "victim-1"], ["weaponkill", "player-record-1"]]);
  const tk = triggerSubjectsOf(ev({ kind: "evt.teamkill", victimPlayerId: "victim-1" }) as never);
  assert.deepEqual(tk.map((s) => s.event), ["teamkill", "teamkilled", "weaponkill"]);
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.player.teamSwitched" }) as never).map((s) => s.event), ["teamswitch"]);
  // The admin camera: one event for both halves of a visit, told apart by `entered`.
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.admin.camera", data: { entered: true } }) as never).map((s) => s.event), ["camenter"]);
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.admin.camera", data: { entered: false } }) as never).map((s) => s.event), ["camexit"]);
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.admin.camera", data: { entered: null } }) as never), [], "an unreadable direction is neither");
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.chat.squad" }) as never).map((s) => s.event), ["chat"]);
  // The game's own moderation lines: kicked/banned/punished, name-only on the wire.
  const kicked = triggerSubjectsOf(ev({ kind: "evt.player.kicked", actorPlayerId: null }) as never);
  assert.deepEqual(kicked.map((s) => [s.event, s.playerId, s.playerName]), [["kicked", null, "Nova"]]);
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.player.banned" }) as never).map((s) => s.event), ["banned"]);
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.player.punished" }) as never).map((s) => s.event), ["punished"]);
  // Not a player action → no subjects.
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.match.ended" }) as never), []);
  assert.deepEqual(triggerSubjectsOf(ev({ kind: "evt.admin.camera" }) as never), []);
});

test("a trigger matches only its own player, event, and server scope", () => {
  // The headline case: this player connects, on any server.
  assert.equal(triggerMatches(t(), ev() as never), true);
  // Wrong player.
  assert.equal(triggerMatches(t(), ev({ actorPlayerId: "someone-else", actorName: "Other" }) as never), false);
  // Wrong event kind (a kill does not fire a connect trigger).
  assert.equal(triggerMatches(t(), ev({ kind: "evt.kill" }) as never), false);
  // Server-scoped trigger: fires on its server, not another.
  assert.equal(triggerMatches(t({ serverId: "srv-1" }), ev({ serverId: "srv-1" }) as never), true);
  assert.equal(triggerMatches(t({ serverId: "srv-1" }), ev({ serverId: "srv-2" }) as never), false);
  // Any-server trigger fires wherever.
  assert.equal(triggerMatches(t({ serverId: null }), ev({ serverId: "srv-9" }) as never), true);
});

test("victim-side matching: a death trigger fires for the one who DIED, not the killer", () => {
  const killEv = ev({ kind: "evt.kill", actorPlayerId: "killer-1", actorName: "Killer", victimPlayerId: "player-record-1", victimName: "Nova" });
  assert.equal(triggerMatches(t({ event: "death" }), killEv as never), true);
  assert.equal(triggerMatches(t({ event: "kill" }), killEv as never), false, "they did not get the kill — they died");
});

test("name fallback: the game's name-only kick line matches by stored name, and ONLY when there is no id", () => {
  const kickedEv = ev({ kind: "evt.player.kicked", actorPlayerId: null, actorName: "nova" }); // case differs
  assert.equal(triggerMatches(t({ event: "kicked" }), kickedEv as never), true, "name matches case-insensitively");
  assert.equal(triggerMatches(t({ event: "kicked", playerName: "SomebodyElse" }), kickedEv as never), false);
  // An id on the event is authoritative: a rename cannot hijack an id-keyed subject.
  const idEv = ev({ kind: "evt.player.kicked", actorPlayerId: "someone-else", actorName: "Nova" });
  assert.equal(triggerMatches(t({ event: "kicked" }), idEv as never), false, "same name but a DIFFERENT id is a different person");
});

test("a trigger can never cause the line it fires on, and 'punished' is not buildable", () => {
  // The game log has no PUNISH line — an armed "gets punished" trigger would never fire, so the
  // builder does not offer it (the subjects map still reads imported rows).
  assert.ok(!(TRIGGER_EVENTS as string[]).includes("punished"));
  assert.match(triggerLoopError("banned", [step({ action: "tempban" })])!, /fires the trigger again, forever/);
  assert.match(triggerLoopError("banned", [step({ action: "permaban" })])!, /forever/);
  assert.match(triggerLoopError("kicked", [step({ action: "kick" })])!, /KICK line/);
  // Escalation the other way round is legitimate: a kick into a ban prints a BAN line, which a
  // kicked trigger does not fire on.
  assert.equal(triggerLoopError("kicked", [step({ action: "tempban" })]), null);
  assert.equal(triggerLoopError("banned", [step({ action: "watch" })]), null);
  assert.equal(triggerLoopError("connect", [step({ action: "kick" })]), null);
});

test("the Rules tab's player events: a side swap, a kill with a listed weapon, the admin camera", () => {
  // A side swap fires; the drop to Unassigned on the way across, and joining a team, do not.
  const swap = (data: Record<string, unknown>) => ev({ kind: "evt.player.teamSwitched", data });
  assert.equal(triggerMatches(t({ event: "teamswitch" }), swap({ from: "None", to: "Axis", swapFrom: "Allies" }) as never), true);
  assert.equal(triggerMatches(t({ event: "teamswitch" }), swap({ from: "Allies", to: "Axis" }) as never), true);
  assert.equal(triggerMatches(t({ event: "teamswitch" }), swap({ from: "Allies", to: "None" }) as never), false, "dropping to Unassigned is not a change of side");
  assert.equal(triggerMatches(t({ event: "teamswitch" }), swap({ from: "None", to: "Axis" }) as never), false, "joining a side is not a switch");

  // A weapon kill: any listed part of the weapon's name, either case, team kills included — and
  // it is the KILLER's, never the victim's.
  const armed = t({ event: "weaponkill", params: { weapons: "flamethrower, SATCHEL" } });
  const killWith = (weapon: string, over: Record<string, unknown> = {}) => ev({ kind: "evt.kill", weapon, victimPlayerId: "victim-1", ...over });
  assert.equal(triggerMatches(armed, killWith("M2 FLAMETHROWER") as never), true);
  assert.equal(triggerMatches(armed, killWith("SATCHEL") as never), true);
  assert.equal(triggerMatches(armed, killWith("SATCHEL", { kind: "evt.teamkill" }) as never), true, "a team kill with it counts");
  assert.equal(triggerMatches(armed, killWith("M1 GARAND") as never), false, "a weapon the trigger does not list");
  assert.equal(triggerMatches(armed, killWith("SATCHEL", { actorPlayerId: "killer-2", victimPlayerId: "player-record-1" }) as never), false, "being killed with it is not getting a kill with it");
  assert.equal(triggerMatches(t({ event: "weaponkill", params: {} }), killWith("SATCHEL") as never), false, "a list of nothing matches nothing");

  // The admin camera, by direction.
  const cam = (entered: boolean | null) => ev({ kind: "evt.admin.camera", data: { entered } });
  assert.equal(triggerMatches(t({ event: "camenter" }), cam(true) as never), true);
  assert.equal(triggerMatches(t({ event: "camenter" }), cam(false) as never), false);
  assert.equal(triggerMatches(t({ event: "camexit" }), cam(false) as never), true);
  assert.equal(triggerMatches(t({ event: "camexit" }), cam(null) as never), false);

  // A trigger on a team switch cannot switch their team — that is another switch, forever.
  assert.match(triggerLoopError("teamswitch", [step({ action: "switch" })])!, /another team switch/);
  assert.equal(triggerLoopError("teamswitch", [step({ action: "kick", message: "stay put" })]), null);
});

test("parseEventParams: a weapon kill needs its weapons; every other event stores nothing", () => {
  assert.deepEqual(parseEventParams("weaponkill", { weapons: " flamethrower ,, SATCHEL " }), { params: { weapons: "flamethrower, SATCHEL" } });
  assert.match((parseEventParams("weaponkill", { weapons: " , " }) as { error: string }).error, /at least one weapon/);
  assert.match((parseEventParams("weaponkill", undefined) as { error: string }).error, /at least one weapon/);
  assert.match((parseEventParams("weaponkill", { weapons: "X".repeat(501) }) as { error: string }).error, /too long/);
  assert.deepEqual(parseEventParams("teamswitch", { weapons: "SATCHEL" }), { params: {} }, "settings an event does not take are dropped");
  assert.deepEqual(parseEventParams("connect", null), { params: {} });
  for (const e of ["teamswitch", "weaponkill", "camenter", "camexit"]) assert.ok((TRIGGER_EVENTS as string[]).includes(e), `${e} is buildable`);
});

/** The Rules tab's live-roster conditions, as the worker reports them for one trigger. */
const ROSTER_EVENTS = ["role", "lowlevel", "rolelevel", "badname", "outofzone", "novip", "playtime", "nodiscord", "killrate", "ratio", "clantag", "noleader", "solotank", "soloheli"];

test("a roster condition fires the ONE trigger the worker judged it for", () => {
  const seen = (over: Record<string, unknown> = {}) =>
    ev({ kind: "app.playertrigger.roster", data: { triggerId: "t1", event: "role", violation: "Tank Commander is not allowed here", ...over } });
  // The detection names its condition and whose it is…
  assert.deepEqual(triggerSubjectsOf(seen() as never).map((s) => [s.event, s.playerId]), [["role", "player-record-1"]]);
  // …and nothing when the condition is not one this build knows, or not a roster condition at all.
  assert.deepEqual(triggerSubjectsOf(seen({ event: "flying" }) as never), []);
  assert.deepEqual(triggerSubjectsOf(seen({ event: "connect" }) as never), [], "only roster conditions travel this way");

  const role = t({ event: "role", params: { roles: [12] } });
  assert.equal(triggerMatches(role, seen() as never), true);
  // The same player with a second trigger on the same condition (another role list): that one is
  // judged on its own, so this detection is not its.
  assert.equal(triggerMatches(t({ id: "t2", event: "role", params: { roles: [11] } }), seen() as never), false);
  assert.equal(triggerMatches(role, seen({ event: "novip" }) as never), false, "the same trigger id on another condition");
  // Scope, switch and spent receipts hold as for any event.
  assert.equal(triggerMatches(t({ event: "role", serverId: "srv-2" }), seen() as never), false);
  assert.equal(triggerMatches(t({ event: "role", enabled: false }), seen() as never), false);
  assert.equal(triggerMatches(t({ event: "role", disarmedAt: "2026-09-17T01:00:00Z" }), seen() as never), false);
  // A roster detection of someone else is not this player's, whatever trigger id it names.
  assert.equal(triggerMatches(role, { ...seen(), actorPlayerId: "someone-else", actorName: "Other" } as never), false);
  for (const e of ROSTER_EVENTS) assert.ok((TRIGGER_EVENTS as string[]).includes(e), `${e} is buildable`);
});

test("parseEventParams: a roster condition is checked against the PLAYER's game", () => {
  const err = (r: { params: unknown } | { error: string }) => ("error" in r ? r.error : "");
  const hll = triggerGameOf("hll");
  // Plays a role: the roles alone, deduplicated, whole numbers, and in this game.
  assert.deepEqual(parseEventParams("role", { roles: [12, 12, 11.2] }, hll), { params: { roles: [12, 11] } });
  assert.match(err(parseEventParams("role", { roles: [] }, hll)), /pick at least one role/);
  assert.match(err(parseEventParams("role", { roles: [99] }, hll)), /role 99 is not a role this player's game has/);
  // Every other condition is its Rules trigger's own check, defaults included — "trigger" for "rule".
  assert.deepEqual(parseEventParams("lowlevel", {}, hll), { params: { minLevel: 25 } });
  assert.match(err(parseEventParams("clantag", { clans: [] }, hll)), /with none, this trigger matches nobody/);
  assert.match(err(parseEventParams("rolelevel", { roles: [99], minLevel: 50 }, hll)), /role 99 is not a role this game has/);
  assert.match(err(parseEventParams("lowlevel", { minLevel: 0 }, hll)), /at least 1/);
  assert.deepEqual(parseEventParams("ratio", { ratio: "Kills:Deaths", direction: "below", limit: 0.25 }, hll), { params: { ratio: "kills:deaths", direction: "below", limit: 0.25, minCount: 10 } });
  assert.match(err(parseEventParams("ratio", { limit: 0 }, hll)), /at or above 0, this trigger matches everyone/);
  // A condition the player's game doesn't have is refused; the game that has it takes it.
  assert.match(err(parseEventParams("soloheli", { heliRoles: [16], minCrew: 2 }, hll)), /isn't something this player's game has/);
  assert.ok("params" in parseEventParams("soloheli", { heliRoles: [16], minCrew: 2 }, triggerGameOf("hllv")));
  // The game's own role table: id 16 is a Gunner in WW2 and a Pilot in Vietnam.
  assert.equal(roleNamerFor("hll")(16), "Gunner");
  assert.equal(roleNamerFor("hllv")(16), "Pilot");
  assert.equal(roleNamerFor("nope")(3), "role 3");
  assert.equal(roleNamerFor(null)(3), "role 3");
});

test("a roster condition's summary names its settings, in the player's game's words", () => {
  const rn = roleNamerFor("hll");
  assert.equal(describeTrigger(t({ event: "role", params: { roles: [11, 12], }, fireOnce: false }), rn), "on playing Crewman or Tank Commander, message (every time)");
  assert.equal(describeTrigger(t({ event: "role", params: { roles: [12] } })), "on playing role 12, message (once)", "without the game's names a role is a number");
  assert.match(describeTrigger(t({ event: "rolelevel", params: { roles: [11, 12, 13], minLevel: 50 } }), rn), /^on level below 50 on Crewman, Tank Commander or Commander, /);
  assert.match(describeTrigger(t({ event: "lowlevel", params: { minLevel: 30 } })), /^on level below 30, /);
  assert.match(describeTrigger(t({ event: "playtime", params: { hours: 100, periodDays: 30, allServers: true } })), /^on reaching 100 hours played in the last 30 days on every server, /);
  assert.match(describeTrigger(t({ event: "playtime", params: { hours: 20, periodDays: 0, allServers: false } })), /^on reaching 20 hours played, /);
  assert.match(describeTrigger(t({ event: "clantag", params: { clans: ["s:ABC", "~★", "XYZ"] } })), /^on wearing ABC, ★ or XYZ, /);
  assert.match(describeTrigger(t({ event: "outofzone", params: { keepOut: true } })), /^on standing in a no-go area, /);
  assert.match(describeTrigger(t({ event: "outofzone", params: { keepOut: false } })), /^on leaving the allowed area, /);
  assert.match(describeTrigger(t({ event: "ratio", params: { ratio: "teamkills:kills", direction: "above", limit: 2 } })), /^on a ratio of team kills to kills at or above 2, /);
  assert.match(describeTrigger(t({ event: "ratio", params: { ratio: "kills:deaths", direction: "below", limit: 0.5 } })), /^on a ratio of kills to deaths at or below 0\.5, /);
  for (const e of ROSTER_EVENTS) assert.doesNotMatch(describeTrigger(t({ event: e as never, params: {} })), new RegExp(`^on ${e},`), `${e} reads as words`);
});

test("a disabled or already-spent one-shot never matches, even handed a stale row", () => {
  assert.equal(triggerMatches(t({ enabled: false }), ev() as never), false);
  assert.equal(triggerMatches(t({ disarmedAt: "2026-09-17T01:00:00Z" }), ev() as never), false);
});

test("shouldDisarm: a one-shot arms exactly one firing; an every-time never disarms", () => {
  assert.equal(shouldDisarm(t({ fireOnce: true })), true);
  assert.equal(shouldDisarm(t({ fireOnce: false })), false);
});

test("every action carries a creation capability, and the map is exactly the action set", () => {
  for (const a of TRIGGER_ACTIONS) {
    assert.ok(ACTION_CAPABILITY[a], `${a} must name a required capability`);
    assert.equal(ACTION_CAPABILITY[a].level, "write");
  }
  // The book-of-record grants gate on their own trust, not a generic one.
  assert.equal(ACTION_CAPABILITY.vip.cap, "vip.grant");
  assert.equal(ACTION_CAPABILITY.vipremove.cap, "vip.revoke");
  assert.equal(ACTION_CAPABILITY.points.cap, "economy.balances");
  assert.equal(ACTION_CAPABILITY.takepoints.cap, "economy.balances");
  assert.equal(ACTION_CAPABILITY.tempban.cap, "action.tempban");
  assert.equal(ACTION_CAPABILITY.switch.cap, "action.switch");
  assert.equal(ACTION_CAPABILITY.watch.cap, "player.watchlist");
});

test("describeTrigger reads like a sentence — every step, its delay, and the once/every-time tail", () => {
  assert.match(describeTrigger(t({ event: "connect", fireOnce: true })), /on connect, message \(once\)/);
  assert.match(describeTrigger(t({ event: "teamkill", steps: [step({ action: "vip", hours: 24 })], fireOnce: false })), /on teamkill, grant 24h VIP \(every time\)/);
  assert.match(describeTrigger(t({ event: "kill", steps: [step({ action: "points", points: 50 })] })), /grant 50 points/);
  // The chain the tab was asked for: several actions, each at its own offset, in one sentence.
  const chain = t({ steps: [step(), step({ action: "vip", hours: 72 }), step({ action: "kick", delaySec: 60 })] });
  assert.match(describeTrigger(chain), /message \+ grant 72h VIP \+ wait 60s, then kick \(once\)/);
  assert.equal(describeStep(step({ action: "tempban", hours: 6, delaySec: 30 })), "wait 30s, then temp-ban 6h");
  assert.equal(describeStep(step({ action: "vipremove" })), "remove VIP");
  assert.equal(describeStep(step({ action: "takepoints", points: 25 })), "take 25 points");
  assert.equal(describeStep(step({ action: "switch" })), "switch team");
  assert.equal(describeStep(step({ action: "watch" })), "watchlist");
  // The new events read as words, not ids.
  assert.match(describeTrigger(t({ event: "weaponkill", params: { weapons: "SATCHEL" } })), /^on kill with SATCHEL, message \(once\)$/);
  assert.match(describeTrigger(t({ event: "teamswitch" })), /^on team switch, /);
  assert.match(describeTrigger(t({ event: "camenter" })), /^on admin camera on, /);
  assert.match(describeTrigger(t({ event: "camexit" })), /^on admin camera off, /);
});

test("capabilitiesForSteps: creation must hold EVERY step's capability, deduped", () => {
  const caps = capabilitiesForSteps([step(), step({ action: "message" }), step({ action: "tempban" }), step({ action: "vip" })]);
  assert.deepEqual(caps.map((c) => c.cap).sort(), ["action.message", "action.tempban", "vip.grant"]);
});

test("stepError refuses the shapes that would fire as nothing, and bounds the delay", () => {
  assert.equal(stepError(step()), null);
  assert.match(stepError(step({ message: null }))!, /needs a message/);
  assert.match(stepError(step({ action: "tempban", message: null }))!, /needs a reason/);
  assert.match(stepError(step({ action: "vip", hours: 0 }))!, /length in hours/);
  assert.match(stepError(step({ action: "points", points: 0 }))!, /positive number of points/);
  assert.match(stepError(step({ action: "takepoints", points: 0 }))!, /positive number of points/);
  assert.match(stepError(step({ action: "watch", message: null }))!, /needs a reason/);
  assert.equal(stepError(step({ action: "vipremove", message: null })), null, "removing VIP needs no text");
  assert.equal(stepError(step({ action: "switch", message: null })), null, "a switch needs no text");
  assert.match(stepError(step({ delaySec: 999999 }))!, /between 0 and 3600/);
  assert.ok(MAX_TRIGGER_STEPS >= 3, "a chain must at least fit message + VIP + points");
});

test("votes and AFK: a vote's starter and its voters by name; the AFK clock fires its one trigger", () => {
  const err = (r: { params: unknown } | { error: string }) => ("error" in r ? r.error : "");
  // The VOTESYS lines carry a name and no id: the subject is the name, matched to the stored one.
  const started = triggerSubjectsOf(ev({ kind: "evt.vote.started", actorPlayerId: null, data: { voteType: "PVT_Kick", target: "Rex" } }) as never);
  assert.deepEqual(started.map((s) => [s.event, s.playerId, s.playerName]), [["votestart", null, "Nova"]]);
  assert.equal(triggerMatches(t({ event: "votestart" }), ev({ kind: "evt.vote.started", actorPlayerId: null }) as never), true);
  assert.equal(triggerMatches(t({ event: "votestart" }), ev({ kind: "evt.vote.started", actorPlayerId: null, actorName: "Rex" }) as never), false, "someone else's vote");
  assert.equal(triggerMatches(t({ event: "votecast" }), ev({ kind: "evt.vote.cast", actorPlayerId: null }) as never), true);
  assert.equal(triggerMatches(t({ event: "votecast" }), ev({ kind: "evt.vote.started", actorPlayerId: null }) as never), false, "starting a vote is not voting");
  // The AFK clock's firing is for ONE trigger: each waits its own minutes.
  const quiet = (triggerId: string) => ev({ kind: "app.playertrigger.afk", data: { triggerId, minutes: 10 } });
  assert.equal(triggerMatches(t({ event: "afk", params: { minutes: 10 } }), quiet("t1") as never), true);
  assert.equal(triggerMatches(t({ id: "t2", event: "afk", params: { minutes: 30 } }), quiet("t1") as never), false);
  for (const e of ["votestart", "votecast", "afk"]) assert.ok((TRIGGER_EVENTS as string[]).includes(e), `${e} is buildable`);
  // AFK minutes: whole, 1 to 180, the Rules tab's 10 when unsaid. The vote events store nothing.
  assert.deepEqual(parseEventParams("afk", {}), { params: { minutes: 10 } });
  assert.deepEqual(parseEventParams("afk", { minutes: 25 }), { params: { minutes: 25 } });
  assert.match(err(parseEventParams("afk", { minutes: 0 })), /from 1 to 180/);
  assert.match(err(parseEventParams("afk", { minutes: 7.5 })), /whole number/);
  assert.match(err(parseEventParams("afk", { minutes: 181 })), /from 1 to 180/);
  assert.deepEqual(parseEventParams("votestart", { minutes: 5 }), { params: {} });
  assert.match(describeTrigger(t({ event: "afk", params: { minutes: 25 } })), /^on 25 minutes without a kill, /);
  assert.match(describeTrigger(t({ event: "votestart" })), /^on starting a vote, /);
  assert.match(describeTrigger(t({ event: "votecast" })), /^on voting, /);
});
