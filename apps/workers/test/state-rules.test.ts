/**
 * The worker's half of the state triggers — the plumbing that was acknowledged untested when the
 * scenarios moved onto rules. Everything that decides whether a synthetic event is emitted (rule
 * scoping, the cross-game guard, population bounds, per-(rule, player) pacing) is proven here;
 * the runner keeps only reads and the bus call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateVip, autoSettingsDuty, dueRosterTriggerFirings, dueStateFirings, holdsVip, pruneRosterTriggerMemory, pruneStateFiredAt, rosterToRulePlayer, rosterTriggerWatchesFor, stateRulesFor } from "../dist/state-rules.js";
import type { PlayerTriggerRow, RuleRow } from "@app/db";
import type { GameDescriptor } from "@app/games";

const descriptor = {
  id: "hll", label: "HLL", sides: [],
  roles: { 0: "Rifleman", 9: "Squad Leader", 11: "Crewman", 12: "Tank Commander" },
  squadLeaderRoles: [9], squadLabel: "squad", scoreFields: [], configFields: [],
} as unknown as GameDescriptor;

let n = 0;
const rule = (over: Partial<RuleRow> = {}): RuleRow => ({
  id: `r${++n}`, name: "R", enabled: true, serverId: null, eventKind: "app.state.solo_tank",
  match: null, threshold: 1, windowSec: 60, action: "message", reason: null, hours: null,
  delaySec: 0, vipMinutes: 10, vipCooldownMinutes: 60, requireRoleIds: [], immuneTags: [],
  immuneRoleIds: [], immuneLevel: 0, dryRun: false, escalateActions: [], escalateResetMinutes: 120,
  alertEnabled: true, alertChannelId: null, params: { tankRoles: [11, 12], minCrew: 2 },
  activeHours: null, playersMin: 0, playersMax: 0, breakerLimit: 10,
  matchMinutesMin: 0, matchMinutesMax: 0, countPerMatch: false, requireTags: [], capCount: 0, capPeriod: "day",
  actionTag: null, points: 0, sectionId: null, sectionOff: false, pausedUntil: null, pauseReason: null, pausedBy: null,
  createdAt: "", updatedAt: "",
  ...over,
});
const roster = (pl: Partial<Record<string, unknown>>) => ({ iD: "p", name: "P", level: 50, role: 0, team: 1, platoon: "ABLE", loadout: "", ...pl });

test("stateRulesFor: scope, the state prefix, and the cross-game guard all filter", () => {
  const server = { id: "s1", game: "hll" };
  const mine = rule({ serverId: "s1" });
  const wide = rule();
  const other = rule({ serverId: "s2" });
  const off = rule({ enabled: false });
  // Its own switch on, its section's off: held all the same. So is a rule paused right now.
  const sectionOff = rule({ sectionId: "sec", sectionOff: true });
  const now = Date.parse("2026-10-08T12:00:00Z");
  const paused = rule({ pausedUntil: "2026-10-08T12:30:00.000Z" });
  const pauseOver = rule({ pausedUntil: "2026-10-08T11:30:00.000Z" });
  const event = rule({ eventKind: "evt.teamkill" });
  const heli = rule({ eventKind: "app.state.solo_heli", params: { heliRoles: [16, 17], minCrew: 2 } });
  const picked = stateRulesFor([mine, wide, other, off, sectionOff, paused, pauseOver, event, heli], server, now).map((r) => r.id);
  assert.deepEqual(picked, [mine.id, wide.id, pauseOver.id],
    "another server's pin, a disabled rule, one whose section is off, one paused, an event rule, and Vietnam's heli trigger (role 16 is WW2's Gunner) all stay out");
  // …and the same heli rule IS this trigger's business on a Vietnam server.
  assert.ok(stateRulesFor([heli], { id: "s9", game: "hllv" }).length === 1);
});

test("dueStateFirings: detects, honours population bounds, and paces re-fires by windowSec", () => {
  const players = [rosterToRulePlayer(roster({ iD: "solo", role: 11 }))];
  const firedAt = new Map<string, number>();
  const base = { players, descriptor, firedAt, playerCount: 50 };
  const r = rule({ windowSec: 60 });

  const first = dueStateFirings({ ...base, rules: [r], nowMs: 1_000_000 });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.playerId, "solo");
  assert.match(first[0]!.reason, /solo tank/);

  // Still in violation 10s later: paced, not re-fired…
  assert.equal(dueStateFirings({ ...base, rules: [r], nowMs: 1_010_000 }).length, 0);
  // …and due again once the rule's own interval has passed.
  assert.equal(dueStateFirings({ ...base, rules: [r], nowMs: 1_061_000 }).length, 1);

  // Population bounds: below the floor and above the ceiling both hold fire (fresh pacing map so
  // the earlier grants can't mask the refusal).
  assert.equal(dueStateFirings({ ...base, firedAt: new Map(), rules: [rule({ playersMin: 60 })], nowMs: 2_000_000 }).length, 0, "12 short of the floor");
  assert.equal(dueStateFirings({ ...base, firedAt: new Map(), rules: [rule({ playersMax: 40 })], nowMs: 2_000_000 }).length, 0, "over the ceiling");
  assert.equal(dueStateFirings({ ...base, firedAt: new Map(), rules: [rule({ playersMin: 40, playersMax: 60 })], nowMs: 2_000_000 }).length, 1, "inside the window");
});

test("dueStateFirings: two rules on the same kind pace independently and both carry their own id", () => {
  const players = [rosterToRulePlayer(roster({ iD: "solo", role: 11 }))];
  const a = rule({ windowSec: 60 });
  const b = rule({ windowSec: 60, params: { tankRoles: [11], minCrew: 3 } });
  const firedAt = new Map<string, number>();
  const due = dueStateFirings({ rules: [a, b], players, playerCount: 50, descriptor, firedAt, nowMs: 1_000_000 });
  assert.deepEqual(due.map((d) => d.rule.id).sort(), [a.id, b.id].sort(), "each rule's detection is its own — the event will carry ITS id");
  assert.equal(firedAt.size, 2, "pacing is per (rule, player), never shared across rules");
});

test("rosterToRulePlayer reads the wire's own field names; the pacing map prunes by age", () => {
  const p = rosterToRulePlayer(roster({ iD: " 76561198000000001 ", name: "Tank", role: 12, platoon: "BAKER", team: 2, level: 150 }));
  assert.equal(p.playerId, "76561198000000001", "trimmed, from the v2 `iD` spelling");
  assert.equal(p.squad, "BAKER", "the game calls it a platoon; the detectors call it a squad");
  assert.equal(p.team, 2);
  assert.deepEqual(p.tags, [], "immunity is the enforcer's job");

  const firedAt = new Map([["r1|old", 0], ["r1|fresh", 3_500_000]]);
  pruneStateFiredAt(firedAt, 3_700_000);
  assert.deepEqual([...firedAt.keys()], ["r1|fresh"], "an hour-old entry can only ever allow an EARLIER re-fire — safe to drop");
});

test("zone rules: the paint travels per rule (two rules, two sets), positions ride the roster, and no paint means silence", () => {
  const zoneRule = (id: string, zoneSet: string) => rule({
    id, eventKind: "app.state.out_of_zone", params: { zoneSet }, windowSec: 60,
  });
  const rA = zoneRule("rA", "set-a"); // paints A1 for allies
  const rB = zoneRule("rB", "set-b"); // paints nothing on this map
  // Positions come off the same roster read every state rule shares — worldPosition, with the
  // deploy screen's exact (0,0) read as "not standing anywhere".
  const players = [
    rosterToRulePlayer(roster({ iD: "in", worldPosition: { x: -90000, y: -90000 } })),   // A1
    rosterToRulePlayer(roster({ iD: "out", worldPosition: { x: 70000, y: 70000 } })),    // I9
    rosterToRulePlayer(roster({ iD: "deploy", worldPosition: { x: 0, y: 0 } })),
  ];
  assert.equal(players[0]!.pos?.x, -90000, "the roster's position lands on the RulePlayer");
  assert.equal(players[2]!.pos, null, "(0,0) is the deploy screen, not a place");
  const due = dueStateFirings({
    rules: [rA, rB], players, playerCount: 3, descriptor, firedAt: new Map(), nowMs: Date.now(),
    zonesByRuleId: new Map([
      ["rA", { allies: new Set(["A1"]), axis: new Set<string>(), shared: new Set<string>() }],
      ["rB", null],
    ]),
    sideOfTeam: (t) => (t === 1 ? "allies" : t === 2 ? "axis" : null),
  });
  assert.deepEqual(due.map((d) => [d.rule.id, d.playerId]), [["rA", "out"]],
    "rule A flags the wanderer with ITS paint; rule B, unpainted here, fires on nobody");
});

// ---- the no-VIP trigger's inputs ----

test("holdsVip: permanent, still-dated and PAUSED all hold VIP; expired or absent does not", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const later = "2026-09-29T12:00:00Z", earlier = "2026-09-27T12:00:00Z";
  assert.equal(holdsVip({ playerId: "p", expiration: null, pausedUntil: null }, now), true);
  assert.equal(holdsVip({ playerId: "p", expiration: later, pausedUntil: null }, now), true);
  // A pause is a punishment in progress — a rule granting VIP to players "without" it must never
  // be the way around one.
  assert.equal(holdsVip({ playerId: "p", expiration: earlier, pausedUntil: later }, now), true);
  assert.equal(holdsVip({ playerId: "p", expiration: earlier, pausedUntil: null }, now), false);
  assert.equal(holdsVip({ playerId: "p", expiration: earlier, pausedUntil: earlier }, now), false);
  assert.equal(holdsVip(undefined, now), false);
});

test("annotateVip: our grants AND the game's own list count; an unreadable list leaves VIP unknown", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const players = ["ours", "game", "none"].map((id) => rosterToRulePlayer(roster({ iD: id, name: id })));
  const grants = [{ playerId: "ours", expiration: null, pausedUntil: null }];
  const seen = new Map<string, number>();
  const read = annotateVip(players, { grants, gameVipIds: new Set(["game"]), firstSeenMs: seen, nowMs: now });
  assert.deepEqual(read.map((p) => [p.playerId, p.vip]), [["ours", true], ["game", true], ["none", false]],
    "VIP set on the game outside the panel is VIP — a grant written over it would date it for the sweep");
  // The list could not be read: a grant of ours still says yes, but "no" is never guessed.
  const blind = annotateVip(players, { grants, gameVipIds: null, firstSeenMs: seen, nowMs: now });
  assert.deepEqual(blind.map((p) => [p.playerId, p.vip]), [["ours", true], ["game", null], ["none", null]]);
});

test("annotateVip: time on the server counts from first sight, and a player who leaves starts over", () => {
  const t0 = Date.parse("2026-09-28T12:00:00Z");
  const seen = new Map<string, number>();
  const a = rosterToRulePlayer(roster({ iD: "a", name: "a" })), b = rosterToRulePlayer(roster({ iD: "b", name: "b" }));
  annotateVip([a], { grants: [], gameVipIds: new Set(), firstSeenMs: seen, nowMs: t0 });
  const later = annotateVip([a, b], { grants: [], gameVipIds: new Set(), firstSeenMs: seen, nowMs: t0 + 40 * 60_000 });
  assert.deepEqual(later.map((p) => [p.playerId, Math.round(p.onlineMinutes ?? -1)]), [["a", 40], ["b", 0]]);
  annotateVip([b], { grants: [], gameVipIds: new Set(), firstSeenMs: seen, nowMs: t0 + 41 * 60_000 }); // a left
  const back = annotateVip([a, b], { grants: [], gameVipIds: new Set(), firstSeenMs: seen, nowMs: t0 + 50 * 60_000 });
  assert.deepEqual(back.map((p) => [p.playerId, Math.round(p.onlineMinutes ?? -1)]), [["a", 0], ["b", 10]]);
});

test("no-VIP rules fire through dueStateFirings like any roster rule — paced, bounded, only for the VIP-less", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const r = rule({ eventKind: "app.state.no_vip", action: "vip", params: { minMinutesOnline: 0 }, windowSec: 1800 });
  const players = annotateVip(["x", "y"].map((id) => rosterToRulePlayer(roster({ iD: id, name: id }))),
    { grants: [{ playerId: "y", expiration: null, pausedUntil: null }], gameVipIds: new Set(), firstSeenMs: new Map(), nowMs: now });
  const firedAt = new Map<string, number>();
  const first = dueStateFirings({ rules: [r], players, playerCount: 2, descriptor, firedAt, nowMs: now });
  assert.deepEqual(first.map((f) => f.playerId), ["x"]);
  assert.equal(dueStateFirings({ rules: [r], players, playerCount: 2, descriptor, firedAt, nowMs: now + 60_000 }).length, 0, "paced by the re-check interval");
});

test("a roster rule's match-time window is judged with the detection; an unknown match clock holds it", () => {
  const r = rule({ eventKind: "app.state.no_leader", params: { minSquadSize: 2 }, matchMinutesMax: 10 });
  const players = [roster({ iD: "a", role: 0, platoon: "ABLE" }), roster({ iD: "b", role: 0, platoon: "ABLE" })].map((pl) => rosterToRulePlayer(pl));
  const run = (matchMinutes: number | null) => dueStateFirings({ rules: [r], players, playerCount: 2, descriptor, firedAt: new Map(), nowMs: 1e9, matchMinutes });
  assert.equal(run(3).length, 2, "3 minutes in: inside the first 10");
  assert.equal(run(12).length, 0, "past it");
  assert.equal(run(null).length, 0, "no clock, no guess");
  assert.equal(dueStateFirings({ rules: [rule({ eventKind: "app.state.no_leader", params: { minSquadSize: 2 } })], players, playerCount: 2, descriptor, firedAt: new Map(), nowMs: 1e9, matchMinutes: null }).length, 2,
    "a rule with no window does not care whether the clock is known");
});

test("a ratio rule judges this match's counts straight from the live roster", () => {
  // The team killer from the report: 1 kill, 43 deaths, 36 team kills. Nothing is stamped or read
  // for a ratio rule — the counts are the roster's own, at every check.
  const players = [
    rosterToRulePlayer(roster({ iD: "tk", name: "TK", stats: { infantryKills: 1, vehicleKills: 0, deaths: 43, teamKills: 36 } })),
    rosterToRulePlayer(roster({ iD: "fine", name: "Fine", stats: { infantryKills: 30, vehicleKills: 2, deaths: 20, teamKills: 2 } })),
    rosterToRulePlayer(roster({ iD: "new", name: "New" })),
  ];
  const r = rule({ eventKind: "app.state.ratio", params: { ratio: "teamkills:kills", direction: "above", limit: 2, minCount: 10 } });
  const due = dueStateFirings({ rules: [r], players, playerCount: 50, descriptor, firedAt: new Map(), nowMs: 1e9 });
  assert.deepEqual(due.map((d) => [d.playerId, d.reason]), [["tk", "36 team kills to 1 kill — a ratio of 36, at or above 2"]]);
});

test("roster stamps: this match's kills, play minutes, Discord links and playtime, each unknown when unknowable", async () => {
  const { stampOnline, stampPlayMinutes, stampDiscord, stampPlaytime } = await import("../dist/state-rules.js");
  const p = rosterToRulePlayer(roster({ iD: "a", stats: { infantryKills: 30, vehicleKills: 4, deaths: 5, teamKills: 3 } }));
  assert.deepEqual([p.kills, p.deaths, p.teamkills], [34, 5, 3], "infantry + vehicle kills, and the team kills");
  const b = rosterToRulePlayer(roster({ iD: "b" }));
  assert.deepEqual([b.kills, b.deaths, b.teamkills], [null, null, null], "no stats reported = unknown, not zero");

  const t0 = 1e12;
  const seen = new Map<string, number>([["a", t0 - 50 * 60_000]]);
  const [online] = stampOnline([p], seen, t0);
  assert.equal(Math.round(online!.onlineMinutes!), 50);
  assert.equal(Math.round(stampPlayMinutes([online!], 12)[0]!.playMinutes!), 12, "on since the last match: only this match's minutes earned these kills");
  assert.equal(Math.round(stampPlayMinutes([online!], null)[0]!.playMinutes!), 50);

  const profileOf = new Map([["a", "prof-a"]]);
  assert.equal(stampDiscord([online!], profileOf, new Set(["prof-a"]))[0]!.discordLinked, true);
  assert.equal(stampDiscord([online!], profileOf, new Set())[0]!.discordLinked, false);
  assert.equal(stampDiscord([online!], profileOf, null)[0]!.discordLinked, null, "links unreadable: unknown");
  assert.equal(stampDiscord([online!], new Map(), new Set())[0]!.discordLinked, null, "not in the directory yet: unknown");

  const hours = stampPlaytime([online!], profileOf, new Map([["server|0", new Map([["prof-a", 36_000]])]]))[0]!.playtimeHours!;
  assert.equal(Math.round(hours["server|0"]! * 60), 10 * 60 + 50, "ten recorded hours plus the fifty minutes of this visit");
});

test("roster rules key players by the game's own identity: an empty iD beside a real id, and Vietnam's Id", async () => {
  const { getGame } = await import("@app/games");
  // A build that sends iD: "" with the id under another casing — `iD ?? id` read "" and dropped them.
  assert.equal(rosterToRulePlayer(roster({ iD: "", id: "76561198000000077" }), getGame("hll")).playerId, "76561198000000077");
  assert.equal(rosterToRulePlayer(roster({ iD: "", Id: "76561198000000078" })).playerId, "76561198000000078", "no module: still the first non-empty spelling");
  // Vietnam spells it `Id` (a per-game EOS id — THE id its commands take); `iD ?? id` read nothing.
  const v = { name: "V", level: 10, role: 0, team: 1, platoon: "", loadout: "", Id: "0002a1b2c3d4e5f6", steamId: "76561198000000079" };
  assert.equal(rosterToRulePlayer(v, getGame("hllv")).playerId, "0002a1b2c3d4e5f6");
});

test("a check reports per rule: the roster breakdown, flagged vs due, and why a rule held back", () => {
  const now = 1e12;
  const players = annotateVip(["a", "b", "c"].map((id) => rosterToRulePlayer(roster({ iD: id, name: id }))), {
    grants: [{ playerId: "a", expiration: null, pausedUntil: null }], gameVipIds: new Set(["b"]), firstSeenMs: new Map(), nowMs: now,
  });
  const noVip = rule({ eventKind: "app.state.no_vip", action: "vip", params: { minMinutesOnline: 0 } });
  const floored = rule({ eventKind: "app.state.no_vip", action: "vip", params: { minMinutesOnline: 0 }, playersMin: 50 });
  const windowed = rule({ eventKind: "app.state.no_vip", action: "vip", params: { minMinutesOnline: 0 }, matchMinutesMax: 10 });
  const report = new Map();
  const firedAt = new Map<string, number>();
  dueStateFirings({ rules: [noVip, floored, windowed], players, playerCount: 3, descriptor, firedAt, nowMs: now, matchMinutes: null, report });
  assert.deepEqual(report.get(noVip.id), { flagged: 1, due: 1, held: null, breakdown: { "hold a VIP grant here": 1, "on the game's own VIP list": 1, "no VIP": 1 } });
  assert.match(report.get(floored.id).held, /under its 50-player floor \(3 on\)/);
  assert.match(report.get(windowed.id).held, /match start, which isn't known/);
  // Next check inside the interval: still flagged, not due.
  const again = new Map();
  dueStateFirings({ rules: [noVip], players, playerCount: 3, descriptor, firedAt, nowMs: now + 1000, report: again });
  assert.deepEqual([again.get(noVip.id).flagged, again.get(noVip.id).due], [1, 0]);
});

test("clan tag rules: the roster's tag reaches the trigger, read through the grouping the worker hands in", () => {
  // The tag as the game typed it, trimmed; a roster entry without one reads as "".
  assert.equal(rosterToRulePlayer(roster({ clanTag: " [KLM] " })).clanTag, "[KLM]");
  assert.equal(rosterToRulePlayer(roster({})).clanTag, "");
  const players = [
    rosterToRulePlayer(roster({ iD: "a", clanTag: "[KLM]" })),
    rosterToRulePlayer(roster({ iD: "b", clanTag: "ᴋʟᴍ" })),
    rosterToRulePlayer(roster({ iD: "c", clanTag: "RIVAL" })),
  ];
  const clans = { ofTag: (t: string) => (t === "RIVAL" ? "rival" : "klm"), ofKey: (k: string) => k };
  const r = rule({ eventKind: "app.state.clan_tag", params: { clans: ["klm"] } });
  const base = { players, descriptor, playerCount: 50, rules: [r], nowMs: 1_000_000 };
  assert.deepEqual(dueStateFirings({ ...base, firedAt: new Map(), clans }).map((d) => d.playerId), ["a", "b"]);
  assert.deepEqual(dueStateFirings({ ...base, firedAt: new Map() }).map((d) => d.playerId), [], "no grouping read: nobody");
});

/** A player trigger as the store hands it over: on Bob's record, every time, armed. */
const ptrig = (over: Partial<PlayerTriggerRow> = {}): PlayerTriggerRow => ({
  id: `pt${++n}`, playerId: "rec-bob", playerName: "Bob", serverId: null, event: "role", params: { roles: [12] },
  steps: [{ action: "message", message: "x", hours: 0, points: 0, delaySec: 0 }], fireOnce: false, enabled: true, note: null,
  createdByUserId: null, createdByName: "staff", createdAt: "", firedCount: 0, lastFiredAt: null, disarmedAt: null,
  updatedAt: null, updatedByName: null,
  ...over,
});
const bobIs = new Map([["rec-bob", { platformId: "bob", game: "hll" }], ["rec-nam", { platformId: "nam", game: "hllv" }]]);

test("rosterTriggerWatchesFor: armed roster conditions, in scope, for a player of THIS server's game", () => {
  const mine = ptrig({ serverId: "s1" });
  const wide = ptrig();
  const watches = rosterTriggerWatchesFor([
    mine, wide,
    ptrig({ serverId: "s2" }),                                     // another server's
    ptrig({ enabled: false }),                                     // switched off
    ptrig({ disarmedAt: "2026-10-01T00:00:00Z" }),                 // a spent one-shot
    ptrig({ event: "connect" }),                                   // an event, not a condition
    ptrig({ playerId: "rec-nam" }),                                // a Vietnam account: role ids mean other roles there
    ptrig({ playerId: "rec-ghost" }),                              // a player the lookup could not place
    ptrig({ event: "soloheli", params: { heliRoles: [16], minCrew: 2 } }), // no helicopters in WW2
  ], bobIs, { id: "s1", game: "hll" });
  assert.deepEqual(watches.map((w) => w.trigger.id), [mine.id, wide.id]);
  // "Plays a role" is the restricted-role detector with those roles disallowed and no allowlist,
  // looked for under the player's game id.
  assert.equal(watches[0]!.kind, "app.state.bad_role");
  assert.deepEqual(watches[0]!.params, { disallowedRoles: [12], allowedRoles: [] });
  assert.equal(watches[0]!.platformId, "bob");
});

test("a roster condition fires when it STARTS, once while it lasts, and again only after it has been gone", () => {
  const [watch] = rosterTriggerWatchesFor([ptrig({ event: "role", params: { roles: [12] } })], bobIs, { id: "s1", game: "hll" });
  const lastTrue = new Map<string, number>();
  const bob = (role: number) => rosterToRulePlayer(roster({ iD: "bob", name: "Bob", role }));
  const at = (players: ReturnType<typeof bob>[], nowMs: number) =>
    dueRosterTriggerFirings({ watches: [watch!], players, descriptor, lastTrue, nowMs });
  assert.deepEqual(at([bob(0)], 0), [], "not on the role");
  const first = at([bob(12)], 30_000);
  assert.deepEqual(first.map((f) => [f.event, f.name, f.reason]), [["role", "Bob", "Tank Commander is not allowed here"]], "takes the role: fires");
  assert.deepEqual(at([bob(12)], 60_000), [], "still on it: the same occurrence");
  assert.deepEqual(at([bob(0)], 90_000), [], "off it");
  assert.deepEqual(at([bob(12)], 120_000), [], "back on it within two minutes: still the same occurrence");
  const someoneElse = rosterToRulePlayer(roster({ iD: "other", name: "Other", role: 12 }));
  assert.deepEqual(at([someoneElse], 150_000), [], "Bob off the server: nothing to judge, and another Tank Commander is not Bob");
  assert.equal(at([bob(12)], 240_000).length, 1, "back after two minutes gone: a new occurrence");
  // Re-editing the trigger is a new version, and starts over.
  const edited = { ...watch!, trigger: { ...watch!.trigger, updatedAt: "2026-10-14T00:00:00Z" } };
  assert.equal(dueRosterTriggerFirings({ watches: [edited], players: [bob(12)], descriptor, lastTrue, nowMs: 250_000 }).length, 1);
  // The memory keeps only conditions seen within two minutes.
  pruneRosterTriggerMemory(lastTrue, 300_000);
  assert.equal(lastTrue.size, 2);
  pruneRosterTriggerMemory(lastTrue, 370_000);
  assert.equal(lastTrue.size, 0);
});

test("a squad check judges the player's squad; two triggers on one player each run their own settings", () => {
  const solo = ptrig({ event: "solotank", params: { tankRoles: [11, 12], minCrew: 2 } });
  const crewman = ptrig({ event: "role", params: { roles: [11] } });
  const commander = ptrig({ event: "role", params: { roles: [12] } });
  const watches = rosterTriggerWatchesFor([solo, crewman, commander], bobIs, { id: "s1", game: "hll" });
  const bobAlone = [rosterToRulePlayer(roster({ iD: "bob", name: "Bob", role: 12, platoon: "BAKER" }))];
  const fired = dueRosterTriggerFirings({ watches, players: bobAlone, descriptor, lastTrue: new Map(), nowMs: 0 });
  assert.deepEqual(fired.map((f) => f.trigger.id).sort(), [solo.id, commander.id].sort(), "solo in a tank, on Tank Commander — not on Crewman");
  // A crewman beside him crews the tank: the squad check is quiet.
  const crewed = [...bobAlone, rosterToRulePlayer(roster({ iD: "amy", name: "Amy", role: 11, platoon: "BAKER" }))];
  assert.deepEqual(dueRosterTriggerFirings({ watches: [watches[0]!], players: crewed, descriptor, lastTrue: new Map(), nowMs: 0 }), []);
});

test("auto settings with its switch off: none of its own work, but a roster player trigger is still watched, with a connection only for one", () => {
  assert.deepEqual(autoSettingsDuty(true, 0), { own: true, connect: true }, "on: everything, as before");
  assert.deepEqual(autoSettingsDuty(true, 3), { own: true, connect: true });
  // A trigger is a person's instruction about one player, not the switch's to turn off — the
  // trigger runner fires every other kind with the switch off, and this kind must not differ.
  assert.deepEqual(autoSettingsDuty(false, 1), { own: false, connect: true }, "off, with a roster trigger armed: watch for it");
  assert.deepEqual(autoSettingsDuty(false, 0), { own: false, connect: false }, "off, and nothing to watch: no connection");
});
