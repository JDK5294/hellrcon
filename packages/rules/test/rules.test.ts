// The state triggers' brains. Every decision that could warn, punish or kick a real player is a
// pure detect() over the roster, so this is where the edges live — the enforcer only plumbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATE_TRIGGERS, getStateTrigger, triggerParamFields, resolveTriggerParams, parseTriggerParams,
  GROUP_JOINED_KIND, GROUP_LEFT_KIND, SCHEDULE_KIND, isGroupTriggerKind, canonicalGroupId,
  restrictedWeaponReason, isStateTriggerKind, stateTriggerAppliesTo, WEAPON_TRIGGER_KIND, CLAN_TAG_KIND,
  RATIO_KIND, RATIO_TYPES, ratioPair,
  PLAYER_ROSTER_EVENT_KIND, ROSTER_TRIGGER_CLEAR_MS, isPlayerRosterEvent, rosterDetectParams,
  type RulePlayer,
} from "../dist/index.js";
import type { GameDescriptor } from "@app/games";

const descriptor = {
  id: "hll", label: "HLL", sides: [],
  roles: { 0: "Rifleman", 9: "Squad Leader", 11: "Crewman", 12: "Tank Commander" },
  squadLeaderRoles: [9], squadLabel: "squad", scoreFields: [], configFields: [],
} as unknown as GameDescriptor;

let n = 0;
function player(playerId: string, over: Partial<RulePlayer> = {}): RulePlayer {
  return { playerId, name: `P${++n}`, level: 50, role: 0, team: 1, squad: "ABLE", loadout: "", tags: [], ...over };
}

const detect = (kind: string, players: RulePlayer[], params: Record<string, unknown> = {}, d: GameDescriptor | null = descriptor) =>
  getStateTrigger(kind)!.detect({ players, params: resolveTriggerParams(kind, params), descriptor: d });

// ---- no leader ----

test("no_leader: flags every member of a leaderless squad, spares led squads, small squads and the unsquadded", () => {
  const players = [
    player("a1", { squad: "ABLE", role: 0 }), player("a2", { squad: "ABLE", role: 0 }),      // leaderless → both
    player("b1", { squad: "BAKER", role: 9 }), player("b2", { squad: "BAKER", role: 0 }),    // led → ok
    player("c1", { squad: "CHARLIE", role: 0 }),                                             // below minSquadSize
    player("d1", { squad: "", role: 0 }),                                                    // unsquadded
  ];
  const v = detect("app.state.no_leader", players);
  assert.deepEqual(v.map((x) => x.playerId).sort(), ["a1", "a2"]);
});

test("no_leader: a squad holding a role the descriptor cannot name is spared — that role could be its leader", () => {
  const players = [player("a1", { squad: "ABLE", role: 0 }), player("a2", { squad: "ABLE", role: 42 })];
  assert.equal(detect("app.state.no_leader", players).length, 0);
  // …and a game with no leader roles at all disables the trigger rather than flagging everyone.
  const noLeaders = { ...descriptor, squadLeaderRoles: [] } as GameDescriptor;
  const led = [player("b1", { squad: "BAKER", role: 9 }), player("b2", { squad: "BAKER", role: 0 })];
  assert.equal(detect("app.state.no_leader", led, {}, noLeaders).length, 0);
});

// ---- low level ----

test("low_level: flags below the minimum; level 0/unknown is never flagged", () => {
  const players = [player("low", { level: 10 }), player("ok", { level: 80 }), player("unknown", { level: 0 })];
  const v = detect("app.state.low_level", players, { minLevel: 25 });
  assert.deepEqual(v.map((x) => x.playerId), ["low"]);
});

// ---- restricted role ----

test("bad_role: denylist flags holders; allowlist flags everyone off it; reasons name the role", () => {
  const players = [player("tank", { role: 12 }), player("rifle", { role: 0 })];
  const deny = detect("app.state.bad_role", players, { disallowedRoles: [12] });
  assert.deepEqual(deny.map((x) => x.playerId), ["tank"]);
  assert.match(deny[0]!.reason, /Tank Commander/);
  const allow = detect("app.state.bad_role", players, { allowedRoles: [0] });
  assert.deepEqual(allow.map((x) => x.playerId), ["tank"]);
});

test("bad_role: an allowlist never punishes a role we do not know — but a denylist still names it", () => {
  // -1 is what the roster stamps when it has no role for someone yet: just connected, still in
  // the deploy screen, or a sample that omitted the field. Nobody chose it, so it is not a
  // violation of an allowlist — the alternative is kicking players over "role -1".
  const players = [
    player("unreported", { role: -1 }),
    player("unnamed", { role: 42 }),   // a real role this descriptor cannot name (game drift)
    player("rifle", { role: 0 }),
    player("tank", { role: 12 }),
  ];
  const allow = detect("app.state.bad_role", players, { allowedRoles: [0] });
  assert.deepEqual(allow.map((x) => x.playerId), ["tank"], "only a role we can actually judge is flagged");

  // A denylist is an admin naming a number on purpose, so it still fires on whatever they named.
  const deny = detect("app.state.bad_role", players, { disallowedRoles: [42] });
  assert.deepEqual(deny.map((x) => x.playerId), ["unnamed"]);
  assert.match(deny[0]!.reason, /role 42/, "an unnameable role reads as its number, not as a blank");
});

// ---- name filter ----

test("bad_name: banned words, adverts and patterns each flag; an invalid regex matches nothing", () => {
  const players = [
    player("word", { name: "xX_slur_Xx" }),
    player("ad", { name: "JOIN discord.gg/xyz" }),
    player("pat", { name: "clan|IMPOSTER" }),
    player("ok", { name: "Legit" }),
  ];
  assert.deepEqual(detect("app.state.bad_name", players, { bannedSubstrings: "slur" }).map((x) => x.playerId), ["word"]);
  assert.deepEqual(detect("app.state.bad_name", players, { blockUrls: true }).map((x) => x.playerId), ["ad"]);
  assert.deepEqual(detect("app.state.bad_name", players, { bannedPattern: "impost(e|o)r" }).map((x) => x.playerId), ["pat"]);
  assert.equal(detect("app.state.bad_name", players, { bannedPattern: "([unclosed" }).length, 0);
});

// ---- solo vehicle squads ----

test("solo_tank: flags a lone crewman, spares a crewed squad and infantry; teams are independent", () => {
  const players = [
    player("solo", { squad: "ABLE", team: 1, role: 11 }),
    player("t1", { squad: "BAKER", team: 1, role: 12 }), player("t2", { squad: "BAKER", team: 1, role: 11 }),
    player("i1", { squad: "CHARLIE", team: 1, role: 0 }),
    player("mirror", { squad: "ABLE", team: 2, role: 0 }), // same squad name, other team — not ABLE's crew
  ];
  const v = detect("app.state.solo_tank", players);
  assert.deepEqual(v.map((x) => x.playerId), ["solo"]);
});

test("solo_heli: flags a lone pilot's platoon on Vietnam wording, spares a full crew", () => {
  const hllv = { ...descriptor, id: "hllv", roles: { 0: "Rifleman", 16: "Pilot", 17: "Logistics Officer" }, squadLabel: "platoon" } as unknown as GameDescriptor;
  const players = [
    player("lonepilot", { squad: "EAGLE", role: 16 }),
    player("p1", { squad: "HAWK", role: 16 }), player("p2", { squad: "HAWK", role: 17 }),
  ];
  const v = detect("app.state.solo_heli", players, {}, hllv);
  assert.deepEqual(v.map((x) => x.playerId), ["lonepilot"]);
  assert.match(v[0]!.reason, /helicopter platoon/, "the reason speaks the game's own squad word");
});

// ---- the kill-derived weapon trigger ----

test("restrictedWeaponReason: denylist substring match; allowlist refuses everything off it; no weapon = no judgement", () => {
  assert.match(restrictedWeaponReason("M2 FLAMETHROWER", { disallowedWeapons: "flamethrower, satchel" })!, /not allowed/);
  assert.equal(restrictedWeaponReason("M1 GARAND", { disallowedWeapons: "flamethrower" }), null);
  assert.match(restrictedWeaponReason("M1 GARAND", { allowedWeapons: "KARABINER" })!, /allowed-weapons list/);
  assert.equal(restrictedWeaponReason("", { disallowedWeapons: "anything" }), null);
});

// ---- param validation (the save-time half both rule routes share) ----

test("parseTriggerParams: fields are typed, bounded, defaulted; roles are checked against the game", () => {
  const roles = new Set([0, 9, 11, 12]);
  const ok = parseTriggerParams("app.state.solo_tank", { tankRoles: [11, 12, 12], minCrew: 3 }, roles);
  // No minPlayers here: population bounds live on the RULE (playersMin/Max), beside active hours.
  assert.deepEqual(ok, { params: { tankRoles: [11, 12], minCrew: 3 } });
  assert.match((parseTriggerParams("app.state.solo_tank", { tankRoles: [77] }, roles) as { error: string }).error, /not a role this game has/);
  assert.match((parseTriggerParams("app.state.solo_tank", { minCrew: "lots" }, roles) as { error: string }).error, /must be a number/);
  // Kinds that take no params store none.
  assert.deepEqual(parseTriggerParams("evt.teamkill", { anything: true }, roles), { params: null });
});

test("parseTriggerParams: a configuration that can never fire is refused with the fix named", () => {
  const roles = new Set([0]);
  assert.match((parseTriggerParams("app.state.bad_role", {}, roles) as { error: string }).error, /matches nobody/);
  assert.match((parseTriggerParams("app.state.bad_name", {}, roles) as { error: string }).error, /something to match/);
  assert.match((parseTriggerParams("app.state.bad_name", { bannedPattern: "([bad" }, roles) as { error: string }).error, /not a valid regular expression/);
  assert.match((parseTriggerParams(WEAPON_TRIGGER_KIND, {}, roles) as { error: string }).error, /matches nothing/);
  assert.match((parseTriggerParams("app.state.solo_tank", { tankRoles: [] }, roles) as { error: string }).error, /vehicle role/);
});

test("the trigger catalogue is coherent: unique kinds, state prefix, param fields for every kind", () => {
  const kinds = STATE_TRIGGERS.map((t) => t.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const k of kinds) {
    assert.ok(isStateTriggerKind(k), `${k} carries the state prefix`);
    assert.ok(triggerParamFields(k).length > 0, `${k} declares its params`);
  }
  assert.ok(!isStateTriggerKind(WEAPON_TRIGGER_KIND), "the weapon trigger is event-derived, not worker-detected");
  assert.ok(triggerParamFields(WEAPON_TRIGGER_KIND).length > 0);
});

test("stateTriggerAppliesTo: role-id collisions make this load-bearing — heli is Vietnam-only, tank serves both, universal triggers serve anything", () => {
  // HLL: Vietnam's Pilot (16) is WW2's artillery Gunner (16): a solo-heli rule run against a WW2
  // roster would read an under-crewed artillery squad as a lone pilot. The worker asks this
  // before detecting, so the collision can never fire a rule.
  assert.equal(stateTriggerAppliesTo("app.state.solo_heli", "hll"), false);
  assert.equal(stateTriggerAppliesTo("app.state.solo_heli", "hllv"), true);
  assert.equal(stateTriggerAppliesTo("app.state.solo_tank", "hll"), true);
  assert.equal(stateTriggerAppliesTo("app.state.solo_tank", "hllv"), true);
  assert.equal(stateTriggerAppliesTo("app.state.no_leader", "hll"), true);
  assert.equal(stateTriggerAppliesTo("app.state.no_leader", "hllv"), true);
  assert.equal(stateTriggerAppliesTo("app.state.nonsense", "hll"), false, "an unknown kind applies nowhere");
});

// ---- out of zone ----
// The grid is ±100,000 world units cut 10×10, so a cell is 20,000 wide: A1's middle is
// (-90000, -90000), B1's is (-70000, -90000), E5's is (-10000, -10000).
const zoneCells = (allies: string[], axis: string[], shared: string[]) =>
  ({ allies: new Set(allies), axis: new Set(axis), shared: new Set(shared) });
const sideOf = (t: number) => (t === 1 ? "allies" : t === 2 ? "axis" : null);
const zoneDetect = (players: RulePlayer[], params: Record<string, unknown>, zones: ReturnType<typeof zoneCells> | null) =>
  getStateTrigger("app.state.out_of_zone")!.detect({
    players, params: resolveTriggerParams("app.state.out_of_zone", { zoneSet: "z1", ...params }),
    descriptor, zones, sideOfTeam: sideOf,
  });

test("out_of_zone keep-in: own cells plus shared admit; an unpainted side is unrestricted; the deploy screen and unknown sides never fire", () => {
  const zones = zoneCells(["A1"], [], ["E5"]);
  const inA1 = player("a", { team: 1, pos: { x: -90000, y: -90000 } });
  const inB1 = player("b", { team: 1, pos: { x: -70000, y: -90000 } });
  const inE5 = player("c", { team: 1, pos: { x: -10000, y: -10000 } });
  const axisAnywhere = player("d", { team: 2, pos: { x: 50000, y: 50000 } });   // axis painted nothing → free
  const deployScreen = player("e", { team: 1, pos: null });
  const unknownSide = player("f", { team: 3, pos: { x: -70000, y: -90000 } });
  const hits = zoneDetect([inA1, inB1, inE5, axisAnywhere, deployScreen, unknownSide], {}, zones);
  assert.deepEqual(hits.map((v) => v.playerId), ["b"], "only the allies player standing outside A1∪E5");
  assert.match(hits[0]!.reason, /B1/, "the sentence names where they actually are");
});

test("out_of_zone keep-out: painted cells are no-go — per side for side paint, for everyone in shared", () => {
  const zones = zoneCells(["A1"], [], ["E5"]);
  const alliesInA1 = player("a", { team: 1, pos: { x: -90000, y: -90000 } });
  const axisInA1 = player("b", { team: 2, pos: { x: -90000, y: -90000 } });    // A1 forbids ALLIES only
  const axisInE5 = player("c", { team: 2, pos: { x: -10000, y: -10000 } });    // shared forbids both
  const alliesElsewhere = player("d", { team: 1, pos: { x: 90000, y: 90000 } });
  const hits = zoneDetect([alliesInA1, axisInA1, axisInE5, alliesElsewhere], { keepOut: true }, zones);
  assert.deepEqual(hits.map((v) => v.playerId).sort(), ["a", "c"]);
  assert.match(hits[0]!.reason, /restricted/);
});

test("out_of_zone: exempt roles roam anywhere, and no paint for this map means no policy at all", () => {
  const zones = zoneCells(["A1"], ["J10"], []);
  const commander = player("a", { team: 1, role: 12, pos: { x: 50000, y: 50000 } });
  const grunt = player("b", { team: 1, role: 0, pos: { x: 50000, y: 50000 } });
  const hits = zoneDetect([commander, grunt], { exemptRoles: [12] }, zones);
  assert.deepEqual(hits.map((v) => v.playerId), ["b"], "the exempt role walks, the grunt is flagged");
  assert.deepEqual(zoneDetect([grunt], {}, null), [], "zones null = the set paints nothing here = silence");
});

test("out_of_zone params: a rule with no zone set is refused at save, not stored inert", () => {
  const parsed = parseTriggerParams("app.state.out_of_zone", { zoneSet: "" }, new Set([0, 12]));
  assert.ok("error" in parsed && /zone set/.test(parsed.error));
  const ok = parseTriggerParams("app.state.out_of_zone", { zoneSet: "abc", keepOut: true, exemptRoles: [12] }, new Set([0, 12]));
  assert.ok("params" in ok && ok.params?.keepOut === true);
});

// ---- level below minimum (role) ----

test("role_level: the floor binds only the chosen roles, names the role, and spares the unknown-level", () => {
  const players = [
    player("tc", { role: 12, level: 30 }),  // Tank Commander under the floor → flagged, by name
    player("cw", { role: 11, level: 30 }),  // Crewman under the floor → flagged
    player("ok", { role: 12, level: 80 }),  // meets the floor
    player("rf", { role: 0, level: 5 }),    // low level but not a covered role — the whole-roster rule's business
    player("nv", { role: 12, level: 0 }),   // level unknown — never flagged, same rule as low_level
  ];
  const v = detect("app.state.role_level", players, { roles: [11, 12], minLevel: 50 });
  assert.deepEqual(v.map((x) => x.playerId).sort(), ["cw", "tc"]);
  const tc = v.find((x) => x.playerId === "tc")!;
  assert.match(tc.reason, /Tank Commander needs level 50/, "the reason names the role, not just a number");
  assert.match(tc.reason, /level 30/, "and tells the player where they stand");
});

test("role_level: a floor covering no roles is refused at save, not stored as a rule that never fires", () => {
  const bad = parseTriggerParams("app.state.role_level", { roles: [], minLevel: 50 }, new Set([0, 11, 12]));
  assert.ok("error" in bad && /at least one role/.test(bad.error));
  const good = parseTriggerParams("app.state.role_level", { roles: [12], minLevel: 50 }, new Set([0, 11, 12]));
  assert.ok("params" in good && Array.isArray((good.params as Record<string, unknown>).roles));
  // …and a role id the game does not have is caught by the shared roles-field check.
  const stray = parseTriggerParams("app.state.role_level", { roles: [99], minLevel: 50 }, new Set([0, 11, 12]));
  assert.ok("error" in stray && /not a role this game has/.test(stray.error));
});

// ---- no VIP ----

test("no_vip: flags only a player KNOWN to hold no VIP — holding or unknown is left alone", () => {
  const hits = detect("app.state.no_vip", [
    player("none", { vip: false }),
    player("holds", { vip: true }),
    player("unknown", { vip: null }),       // the game's list could not be read
    player("unstamped"),                    // the worker never annotated (no field at all)
  ]);
  assert.deepEqual(hits.map((h) => h.playerId), ["none"]);
  assert.match(hits[0]!.reason, /VIP/);
  assert.equal(stateTriggerAppliesTo("app.state.no_vip", "hll"), true);
  assert.equal(stateTriggerAppliesTo("app.state.no_vip", "hllv"), true);
});

test("no_vip: 'only after N minutes' waits for time on the server; 0 fires at once", () => {
  const players = [player("new", { vip: false, onlineMinutes: 2 }), player("old", { vip: false, onlineMinutes: 45 }), player("blank", { vip: false })];
  assert.deepEqual(detect("app.state.no_vip", players, { minMinutesOnline: 30 }).map((h) => h.playerId), ["old"]);
  assert.deepEqual(detect("app.state.no_vip", players, { minMinutesOnline: 0 }).map((h) => h.playerId), ["new", "old", "blank"]);
  assert.deepEqual(detect("app.state.no_vip", players).map((h) => h.playerId), ["new", "old", "blank"], "defaults to 0");
});

// ---- playtime, Discord link, kill rate ----

test("playtime: reads the hours for ITS OWN shape (scope + period), and only once they reach the mark", async () => {
  const { playtimeKey } = await import("../dist/index.js");
  const month = playtimeKey(false, 30), ever = playtimeKey(true, 0);
  const players = [
    player("reg", { playtimeHours: { [month]: 25, [ever]: 400 } }),
    player("new", { playtimeHours: { [month]: 3, [ever]: 3 } }),
    player("unknown"),
  ];
  assert.deepEqual(detect("app.state.playtime", players, { hours: 20, periodDays: 30 }).map((h) => h.playerId), ["reg"]);
  assert.deepEqual(detect("app.state.playtime", players, { hours: 300, allServers: true }).map((h) => h.playerId), ["reg"]);
  assert.match(detect("app.state.playtime", players, { hours: 20, periodDays: 30 })[0]!.reason, /25 hours played in the last 30 days/);
  assert.equal(detect("app.state.playtime", players, { hours: 20, periodDays: 7 }).length, 0, "a shape nobody computed reads as unknown, never as zero-or-more");
});

test("no_discord: flags only players KNOWN to be unlinked, after the minutes asked for", () => {
  const players = [
    player("un", { discordLinked: false, onlineMinutes: 10 }),
    player("fresh", { discordLinked: false, onlineMinutes: 1 }),
    player("linked", { discordLinked: true, onlineMinutes: 30 }),
    player("unknown", { discordLinked: null, onlineMinutes: 30 }),
  ];
  assert.deepEqual(detect("app.state.no_discord", players, { minMinutesOnline: 5 }).map((h) => h.playerId), ["un"]);
});

test("kill_rate: a rate over time played or a K/D, once past the minimum kills; no time base = K/D only", () => {
  const players = [
    player("hot", { kills: 60, deaths: 10, playMinutes: 20 }),   // 30 per 10 min, K/D 6
    player("slow", { kills: 60, deaths: 2, playMinutes: 60 }),   // 10 per 10 min, K/D 30
    player("few", { kills: 8, deaths: 0, playMinutes: 2 }),      // under the minimum kills
    player("clockless", { kills: 40, deaths: 1, playMinutes: null }),
  ];
  assert.deepEqual(detect("app.state.kill_rate", players, { minKills: 30, killsPer10Min: 25, minKd: 0 }).map((h) => h.playerId), ["hot"]);
  assert.deepEqual(detect("app.state.kill_rate", players, { minKills: 30, killsPer10Min: 0, minKd: 20 }).map((h) => h.playerId), ["slow", "clockless"]);
  // A rejoin mid-match keeps the match's kills but restarts our clock: under 3 tracked minutes the
  // rate stays silent (45 kills over 2 minutes is NOT 225 per 10), while the K/D may still speak.
  const rejoined = [player("back", { kills: 45, deaths: 40, playMinutes: 2 })];
  assert.deepEqual(detect("app.state.kill_rate", rejoined, { minKills: 30, killsPer10Min: 25, minKd: 0 }), []);
  assert.deepEqual(detect("app.state.kill_rate", [player("real", { kills: 45, deaths: 40, playMinutes: 3 })], { minKills: 30, killsPer10Min: 25, minKd: 0 }).map((h) => h.playerId), ["real"]);
  assert.match(detect("app.state.kill_rate", players, { minKills: 30, killsPer10Min: 25 })[0]!.reason, /60 kills, K\/D 6\.0, 30\.0 kills per 10 min/);
  assert.match((parseTriggerParams("app.state.kill_rate", { killsPer10Min: 0, minKd: 0 }, new Set()) as { error: string }).error, /matches nobody/);
});

test("ratio: two of this match's counts against a limit, either way, once the two add up to the minimum", () => {
  assert.deepEqual(RATIO_TYPES, ["kills:deaths", "kills:teamkills", "deaths:kills", "deaths:teamkills", "teamkills:kills", "teamkills:deaths"]);
  assert.deepEqual(ratioPair(" TeamKills : Kills "), ["teamkills", "kills"]);
  assert.equal(ratioPair("kills:kills"), null);
  assert.equal(ratioPair("score:kills"), null);
  const players = [
    player("tk", { kills: 1, deaths: 43, teamkills: 36 }),   // the report: 36 team kills to 1 kill
    player("fine", { kills: 32, deaths: 20, teamkills: 2 }),
    player("early", { kills: 0, deaths: 3, teamkills: 2 }),  // 2 to 0, but only 2 counts in all
    player("edge", { kills: 5, deaths: 5, teamkills: 10 }),  // exactly 2: "at or above" takes it
    player("unknown", { kills: null, deaths: null, teamkills: null }),
  ];
  const ids = (params: Record<string, unknown>) => detect(RATIO_KIND, players, params).map((h) => h.playerId);
  assert.deepEqual(ids({}), ["tk", "edge"], "team kills to kills at or above 2, from 10 counts — the defaults");
  assert.deepEqual(ids({ ratio: "kills:deaths", direction: "below", limit: 0.1 }), ["tk"], "1 kill to 43 deaths is 0.02");
  assert.deepEqual(ids({ ratio: "teamkills:deaths", limit: 0.5 }), ["tk", "edge"]);
  assert.deepEqual(ids({ minCount: 2 }), ["tk", "early", "edge"], "a lower minimum takes the early one: 2 team kills to no kills is 2");
  assert.deepEqual(ids({ minCount: 38 }), [], "1 + 36 is under 38");
  assert.equal(detect(RATIO_KIND, players)[0]!.reason, "36 team kills to 1 kill — a ratio of 36, at or above 2");
  // A second count of 0 counts as 1, and one of anything reads in the singular.
  assert.deepEqual(detect(RATIO_KIND, [player("z", { kills: 12, deaths: 0, teamkills: 0 })], { ratio: "kills:deaths", limit: 10 }).map((h) => h.reason),
    ["12 kills to 0 deaths — a ratio of 12, at or above 10"]);
  assert.deepEqual(detect(RATIO_KIND, [player("s", { kills: 9, deaths: 1, teamkills: 1 })], { ratio: "teamkills:deaths", direction: "below", limit: 1, minCount: 2 }).map((h) => h.reason),
    ["1 team kill to 1 death — a ratio of 1, at or below 1"]);
  // Judged to two places, as the limit is kept: 10 to 30 is 0.33, at or below 0.33.
  assert.deepEqual(detect(RATIO_KIND, [player("third", { kills: 10, deaths: 30, teamkills: 0 })], { ratio: "kills:deaths", direction: "below", limit: 0.33 }).map((h) => h.reason),
    ["10 kills to 30 deaths — a ratio of 0.33, at or below 0.33"]);
  // A rule that never went through the save checks (an import, a restore) flags nobody rather
  // than everyone: a ratio or a way this build doesn't know, or at or above 0.
  assert.deepEqual(ids({ ratio: "score:kills" }), []);
  assert.deepEqual(ids({ ratio: "kills:deaths", direction: "Below", limit: 0.1 }), [], "not read as at or above 0.1");
  assert.deepEqual(ids({ limit: 0 }), []);
  assert.deepEqual(ids({ ratio: "kills:deaths", direction: "below", limit: 0 }), [], "below 0 means none of the first count: nobody here");
  assert.deepEqual(detect(RATIO_KIND, [player("zero", { kills: 0, deaths: 12, teamkills: 0 })], { ratio: "kills:deaths", direction: "below", limit: 0 }).map((h) => h.playerId), ["zero"]);
});

test("ratio params: one spelling stored, the limit to two places, and a rule that would match everyone refused", () => {
  const ok = (raw: unknown) => { const r = parseTriggerParams(RATIO_KIND, raw, new Set()); return "params" in r ? r.params : r; };
  const err = (raw: unknown) => String((parseTriggerParams(RATIO_KIND, raw, new Set()) as { error?: string }).error);
  assert.deepEqual(ok({}), { ratio: "teamkills:kills", direction: "above", limit: 2, minCount: 10 });
  assert.deepEqual(ok({ ratio: " Kills : Deaths ", direction: "Below", limit: 0.333, minCount: 9.6 }), { ratio: "kills:deaths", direction: "below", limit: 0.33, minCount: 10 });
  assert.deepEqual(ok({ direction: "below", limit: 0 }), { ratio: "teamkills:kills", direction: "below", limit: 0, minCount: 10 }, "at or below 0: none of the first count");
  assert.match(err({ ratio: "kills:kills" }), /Ratio must be one of kills:deaths, kills:teamkills, deaths:kills, deaths:teamkills, teamkills:kills, teamkills:deaths/);
  assert.match(err({ ratio: "score:kills" }), /Ratio must be one of/);
  assert.match(err({ direction: "over" }), /Fires when it is must be above or below/);
  assert.match(err({ limit: "a lot" }), /Limit must be a number/);
  assert.match(err({ limit: -1 }), /Limit must be at least 0/);
  assert.match(err({ limit: 1001 }), /Limit must be at most 1000/);
  assert.match(err({ minCount: 0 }), /Minimum of the two counts added together must be at least 1/);
  assert.match(err({ limit: 0 }), /set a limit above 0 — at or above 0, this rule matches everyone who reaches the minimum/);
  assert.match(err({ limit: 0.004 }), /set a limit above 0/, "a limit that rounds to 0 is 0");
});

test("explain: the roster in words, so a quiet rule says why", () => {
  const explain = (kind: string, players: RulePlayer[], params: Record<string, unknown> = {}) =>
    getStateTrigger(kind)!.explain!({ players, params: resolveTriggerParams(kind, params), descriptor });
  assert.deepEqual(explain("app.state.no_vip", [
    player("g", { vip: true, vipSource: "grant" }), player("l", { vip: true, vipSource: "game" }),
    player("u", { vip: null }), player("n", { vip: false, onlineMinutes: 1 }), player("y", { vip: false, onlineMinutes: 9 }),
  ], { minMinutesOnline: 3 }), {
    "hold a VIP grant here": 1, "on the game's own VIP list": 1, "VIP unknown — the game's VIP list could not be read": 1,
    "no VIP, on for under 3 min": 1, "no VIP": 1,
  });
  assert.deepEqual(explain("app.state.kill_rate", [player("hot", { kills: 60, deaths: 1, playMinutes: 10 }), player("calm", { kills: 40, deaths: 30, playMinutes: 60 }), player("few", { kills: 2 }), player("none")], { minKills: 30, killsPer10Min: 25 }),
    { "over the limit": 1, "within the limits": 1, "under 30 kills": 1, "kills not reported": 1 });
  assert.deepEqual(explain(RATIO_KIND, [player("tk", { kills: 1, deaths: 43, teamkills: 36 }), player("fine", { kills: 32, deaths: 20, teamkills: 2 }), player("early", { kills: 0, deaths: 3, teamkills: 2 }), player("none")]),
    { "at or above the limit": 1, "within the limit": 1, "team kills and kills add up to under 10": 1, "counts not reported": 1 });
  assert.deepEqual(explain(RATIO_KIND, [player("tk", { kills: 1, deaths: 43, teamkills: 36 })], { ratio: "kills:deaths", direction: "below", limit: 0.1 }), { "at or below the limit": 1 });
  assert.deepEqual(explain(RATIO_KIND, [player("tk", { kills: 1, deaths: 43, teamkills: 36 })], { limit: 0 }), { "nothing judged (the ratio or limit can't be used)": 1 });
});

test("group and schedule triggers: the group is required, the schedule's fields arrive normalised", () => {
  const roles = new Set<number>();
  for (const kind of [GROUP_JOINED_KIND, GROUP_LEFT_KIND, SCHEDULE_KIND]) {
    assert.match((parseTriggerParams(kind, {}, roles) as { error: string }).error, /pick the player group/);
  }
  assert.ok(isGroupTriggerKind(GROUP_JOINED_KIND) && isGroupTriggerKind(GROUP_LEFT_KIND) && !isGroupTriggerKind(SCHEDULE_KIND));
  assert.deepEqual(parseTriggerParams(GROUP_JOINED_KIND, { groupId: " g1 " }, roles), { params: { groupId: "g1" } });

  const ok = parseTriggerParams(SCHEDULE_KIND, { groupId: "g1", repeat: "weekly", weekdays: "Saturday, sun, sat", dates: "2026-12-25,\n2027-01-01", nthWeekday: "FRI" }, roles) as { params: Record<string, unknown> };
  assert.equal(ok.params.weekdays, "sat,sun");
  assert.equal(ok.params.dates, "2026-12-25,2027-01-01");
  assert.equal(ok.params.nthWeekday, "fri");
  assert.equal(ok.params.time, "00:00", "defaults fill in");
  assert.equal(ok.params.stack, true);
  assert.match((parseTriggerParams(SCHEDULE_KIND, { groupId: "g1", repeat: "yearly" }, roles) as { error: string }).error, /repeat must be one of/);
  assert.match((parseTriggerParams(SCHEDULE_KIND, { groupId: "g1", nth: 9 }, roles) as { error: string }).error, /at most 4/);
});

test("a group's id has one spelling wherever a rule names it — saved, or brought in by import", () => {
  const id = "0f8b3c1a-9d2e-4b7f-8a6c-5e4d3c2b1a09";
  for (const spelt of [id.toUpperCase(), `{${id}}`, id.replace(/-/g, ""), ` ${id} `]) {
    assert.equal(canonicalGroupId(spelt), id, spelt);
    assert.equal(resolveTriggerParams(GROUP_JOINED_KIND, { groupId: spelt }).groupId, id, "read back canonical");
    assert.equal(resolveTriggerParams(SCHEDULE_KIND, { groupId: spelt }).groupId, id);
    const parsed = parseTriggerParams(GROUP_JOINED_KIND, { groupId: spelt }, new Set());
    assert.equal("params" in parsed && parsed.params!.groupId, id, "stored canonical");
  }
  assert.equal(canonicalGroupId("not-a-uuid"), "not-a-uuid", "anything else is left as given");
});

// ---- clan tag ----

test("clan_tag: any spelling of a chosen tag, read through the Clans tab's grouping; unreadable grouping flags nobody", () => {
  // The grouping the worker hands in: two spellings of KLM fold together, and a group saved in the
  // rule as "lynx" has since been combined into KLM (ofKey follows it there).
  const groupOf: Record<string, string> = { "[KLM]": "klm", "ᴋʟᴍ": "klm", "LYNX": "klm", "RIVAL": "rival" };
  const clans = { ofTag: (t: string) => groupOf[t] ?? t.toLowerCase(), ofKey: (k: string) => (k === "lynx" ? "klm" : k) };
  const players = [
    player("a", { clanTag: "[KLM]" }), player("b", { clanTag: "ᴋʟᴍ" }), player("c", { clanTag: "LYNX" }),
    player("d", { clanTag: "RIVAL" }), player("e", { clanTag: "" }), player("f"),
  ];
  const def = getStateTrigger(CLAN_TAG_KIND)!;
  const run = (keys: string[], c: typeof clans | null = clans) =>
    def.detect({ players, params: resolveTriggerParams(CLAN_TAG_KIND, { clans: keys }), descriptor, clans: c }).map((v) => v.playerId);
  assert.deepEqual(run(["klm"]), ["a", "b", "c"], "every spelling of the group");
  assert.deepEqual(run(["lynx"]), ["a", "b", "c"], "a saved key follows its group after a combine");
  assert.deepEqual(run(["rival", "klm"]), ["a", "b", "c", "d"]);
  assert.deepEqual(run([]), [], "nothing chosen matches nobody");
  assert.deepEqual(run(["klm"], null), [], "no grouping this tick: hold fire rather than guess");
  const hit = def.detect({ players, params: { clans: ["rival"] }, descriptor, clans })[0]!;
  assert.equal(hit.reason, "wearing the clan tag RIVAL", "the {violation} token names the spelling they wear");
  assert.deepEqual(def.explain!({ players, params: { clans: ["klm"] }, descriptor, clans }), { "wearing a chosen tag": 3, "another tag": 1, "no tag": 2 });

  // Saved as a real list (a split spelling's key may hold a comma), in one order whatever order it
  // was picked in (so the clash check sees the same tags as the same rule), refused when empty or bloated.
  const ok = parseTriggerParams(CLAN_TAG_KIND, { clans: ["s:A,B", "klm", "klm", " "] }, new Set());
  assert.deepEqual("params" in ok ? ok.params : ok, { clans: ["klm", "s:A,B"] });
  const reordered = parseTriggerParams(CLAN_TAG_KIND, { clans: ["klm", "s:A,B"] }, new Set());
  assert.deepEqual("params" in reordered ? reordered.params : reordered, { clans: ["klm", "s:A,B"] });
  assert.match(String((parseTriggerParams(CLAN_TAG_KIND, { clans: [] }, new Set()) as { error: string }).error), /at least one clan tag/);
  assert.match(String((parseTriggerParams(CLAN_TAG_KIND, { clans: Array.from({ length: 51 }, (_, i) => `t${i}`) }, new Set()) as { error: string }).error), /at most 50/);
  assert.equal(stateTriggerAppliesTo(CLAN_TAG_KIND, "hllv"), true, "every game: Vietnam's tags arrive the day the game sends them");
});

test("player triggers offer every roster trigger the Rules tab has, each judged by that trigger", () => {
  // A roster trigger added to the Rules tab is offered to player triggers too, or this fails.
  const mapped = Object.values(PLAYER_ROSTER_EVENT_KIND).sort();
  assert.deepEqual(mapped, STATE_TRIGGERS.map((t) => t.kind).sort());
  assert.equal(new Set(mapped).size, mapped.length, "one condition per trigger");
  // "Plays a role" is the restricted-role trigger with the roles disallowed and no allowlist; every
  // other condition reads its trigger's own params, over that trigger's defaults.
  assert.deepEqual(rosterDetectParams("role", { roles: [11, 12] }), { disallowedRoles: [11, 12], allowedRoles: [] });
  assert.deepEqual(rosterDetectParams("role", null), { disallowedRoles: [], allowedRoles: [] });
  assert.deepEqual(rosterDetectParams("lowlevel", {}), { minLevel: 25 });
  assert.deepEqual(rosterDetectParams("solotank", { minCrew: 3 }), { tankRoles: [11, 12], minCrew: 3 });
  assert.deepEqual(rosterDetectParams("ratio", { limit: 3 }), { ratio: "teamkills:kills", direction: "above", limit: 3, minCount: 10 });
  const role = getStateTrigger(PLAYER_ROSTER_EVENT_KIND.role)!;
  const flagged = role.detect({ players: [player("a", { role: 12 }), player("b", { role: 11 })], params: rosterDetectParams("role", { roles: [12] }), descriptor });
  assert.deepEqual(flagged.map((v) => [v.playerId, v.reason]), [["a", "Tank Commander is not allowed here"]]);
  assert.equal(isPlayerRosterEvent("role"), true);
  assert.equal(isPlayerRosterEvent("connect"), false);
  assert.equal(isPlayerRosterEvent("toString"), false, "not fooled by an object's own keys");
  assert.equal(ROSTER_TRIGGER_CLEAR_MS, 120_000);
});
