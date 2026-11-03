import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";
import type { RuleRow, ServerRow } from "@app/db";
import { Enforcer, matchesRule, eventText, applyRuleVars } from "../dist/enforcer.js";

// Roster-trigger writes ride a paced per-server chain; this file's state-kind firings must not
// spend real time breathing between stub calls.
process.env.RULE_CROWD_PACE_MS = "0";

const stubBus = { on: () => () => {}, emit: () => {}, close: async () => {} } as any;
// A COMPLETE RuleRow, defaults matching the columns' own — a rule missing half its fields is a
// shape no store can produce, and judging one would test undefined where production reads values.
const rule = (over: Partial<RuleRow> = {}): RuleRow => ({
  id: "r1", name: "R", enabled: true, serverId: null, eventKind: "evt.teamkill",
  match: null, threshold: 1, windowSec: 0, action: "kick", reason: null, hours: null,
  delaySec: 0, vipMinutes: 10, vipCooldownMinutes: 60, requireRoleIds: [], immuneTags: [],
  immuneRoleIds: [], immuneLevel: 0, dryRun: false, escalateActions: [], escalateResetMinutes: 120,
  alertEnabled: true, alertChannelId: null, params: null, activeHours: null,
  playersMin: 0, playersMax: 0, breakerLimit: 10,
  matchMinutesMin: 0, matchMinutesMax: 0, countPerMatch: false, requireTags: [], capCount: 0, capPeriod: "day",
  actionTag: null, points: 0, sectionId: null, sectionOff: false, pausedUntil: null, pauseReason: null, pausedBy: null,
  createdAt: "", updatedAt: "",
  ...over,
});

test("matchesRule: kind, regex, disabled, invalid regex", () => {
  assert.equal(matchesRule(rule(), { kind: "evt.teamkill" }), true);
  assert.equal(matchesRule(rule(), { kind: "evt.kill" }), false);
  assert.equal(matchesRule(rule({ enabled: false }), { kind: "evt.teamkill" }), false);
  assert.equal(matchesRule(rule({ sectionId: "sec", sectionOff: true }), { kind: "evt.teamkill" }), false, "its section is switched off");
  const at = new Date("2026-10-08T12:00:00Z");
  assert.equal(matchesRule(rule({ pausedUntil: "2026-10-08T12:30:00.000Z" }), { kind: "evt.teamkill" }, at), false, "paused");
  assert.equal(matchesRule(rule({ pausedUntil: "2026-10-08T11:30:00.000Z" }), { kind: "evt.teamkill" }, at), true, "a pause that ran out is over");
  assert.equal(matchesRule(rule({ match: "satchel" }), { kind: "evt.teamkill", weapon: "SATCHEL" }), true);
  assert.equal(matchesRule(rule({ match: "satchel" }), { kind: "evt.teamkill", weapon: "RIFLE" }), false);
  assert.equal(matchesRule(rule({ match: "(" }), { kind: "evt.teamkill" }), false); // invalid regex never matches
  // Server scope: null hears every server; a pinned rule only hears its own.
  assert.equal(matchesRule(rule(), { kind: "evt.teamkill", serverId: "srv-a" }), true);
  assert.equal(matchesRule(rule({ serverId: "srv-a" }), { kind: "evt.teamkill", serverId: "srv-a" }), true);
  assert.equal(matchesRule(rule({ serverId: "srv-a" }), { kind: "evt.teamkill", serverId: "srv-b" }), false);
});

test("eventText reads a team switch in words, so a rule can name a direction or a count", () => {
  const swap = { kind: "evt.player.teamSwitched", actorName: "Bob", data: { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" } };
  assert.match(eventText(swap), /switched sides Allies → Axis/);
  const rule = { id: "r", enabled: true, eventKind: "evt.player.teamSwitched", match: "switched sides" } as any;
  assert.equal(matchesRule(rule, swap as any), true);
  assert.equal(matchesRule(rule, { kind: "evt.player.teamSwitched", actorName: "Bob", data: { from: "None", to: "Allies", change: "joined Allies" } } as any), false, "a join is no swap");
  assert.equal(matchesRule(rule, { kind: "evt.player.teamSwitched", actorName: "Bob", data: null } as any), false, "an older row with no teams");
  // What the Game log shows is what a rule can name — the count and the direction included.
  const second = { kind: "evt.player.teamSwitched", actorName: "Bob", data: { from: "None", to: "Allies", swapFrom: "Axis", swapCount: 2, change: "switched sides Axis → Allies" } };
  assert.equal(eventText(second), "Bob switched sides Axis → Allies (2nd this round)");
  assert.equal(matchesRule({ ...rule, match: "2nd this round" }, second as any), true);
  assert.equal(matchesRule({ ...rule, match: "2nd this round" }, swap as any), false);
  assert.equal(matchesRule({ ...rule, match: "→ Axis" }, swap as any), true);
  assert.equal(matchesRule({ ...rule, match: "→ Axis" }, second as any), false);
  // A rule watching one player's switches by name, written before switches had words, still fires.
  assert.equal(matchesRule({ ...rule, match: "^Bob$" }, second as any), true);
  assert.equal(matchesRule({ ...rule, match: "^Bob$" }, { ...second, actorName: "Bobby" } as any), false);
  // …and only a whole-name pattern: an exclusion is judged on the words, or it fires on what it leaves out.
  assert.equal(matchesRule({ ...rule, match: "^(?!.*→ Allies).*$" }, second as any), false, "every swap but onto Allies — not this one");
  assert.equal(matchesRule({ ...rule, match: "^(?!.*→ Allies).*$" }, swap as any), true);
  assert.equal(matchesRule({ ...rule, match: "Axis$" }, { ...second, actorName: "Bob Axis" } as any), false, "an end-anchored word is not a name pattern");
});

test("the team-switch trigger hears side swaps alone — never the drop to Unassigned, a join at connect, or a return to the same side", () => {
  const ev = (data: unknown) => ({ kind: "evt.player.teamSwitched", actorName: "Bob", data }) as any;
  const any = { id: "r", enabled: true, eventKind: "evt.player.teamSwitched", match: null } as any;
  assert.equal(matchesRule(any, ev({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" })), true, "the join that lands on the other side");
  assert.equal(matchesRule(any, ev({ from: "Allies", to: "Axis" })), true, "a direct line across");
  assert.equal(matchesRule(any, ev({ from: "Allies", to: "None", change: "left Allies" })), false, "the drop to Unassigned");
  assert.equal(matchesRule(any, ev({ from: "None", to: "Allies", change: "joined Allies" })), false, "joining at connect, or back to the side they left");
  assert.equal(matchesRule(any, ev(null)), false, "nothing to read");
  // Whatever the match names: the words of a drop or a join are no way back in.
  assert.equal(matchesRule({ ...any, match: "unassigned" }, ev({ from: "Allies", to: "None" })), false);
  assert.equal(matchesRule({ ...any, match: "joined" }, ev({ from: "None", to: "Allies" })), false);
  assert.equal(matchesRule({ ...any, match: "^Bob$" }, ev({ from: "Allies", to: "None" })), false, "nor a whole-name pattern");
  // Other kinds are not judged as switches.
  assert.equal(matchesRule({ ...any, eventKind: "evt.player.connected" }, { kind: "evt.player.connected", actorName: "Bob" } as any), true);
});

test("eventText composes searchable fields", () => {
  assert.match(eventText({ kind: "evt.chat.team", actorName: "Bob", data: { message: "hello scrub" } }), /hello scrub/);
});

/*
 * A fresh scene. The player id is unique PER CALL for the same reason the rules below are pinned
 * to their own server: on the in-memory store each scene builds its own repo, but against
 * Postgres every test in the file shares one database, and a fixed id makes one player row that
 * every test then edits in turn — bans, VIP grants and cooldowns from one test deciding what the
 * next one sees.
 */
let seq = 0;
async function seed() {
  const repo = await createRepository();
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611980000${String(++seq).padStart(5, "0")}`, name: "Griefer" });
  return { repo, player };
}

test("a server-scoped rule only acts on its own server's events", async () => {
  const { repo, player } = await seed();
  const a = await repo.servers.create({ name: "A", host: "h", port: 1, password: "x" });
  const b = await repo.servers.create({ name: "B", host: "h", port: 2, password: "x" });
  await repo.servers.setEngagementMode(a.id, "active");
  await repo.servers.setEngagementMode(b.id, "active");
  await repo.enforcerRules.create({ name: "A-only TK kick", serverId: a.id, eventKind: "evt.teamkill", action: "kick" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();
  // Same offence on both servers: only A's event fires the rule.
  await enf.onEvent({ kind: "evt.teamkill", serverId: b.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.equal(calls.length, 0, "the other server's event is not this rule's business");
  await enf.onEvent({ kind: "evt.teamkill", serverId: a.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.deepEqual(calls, [a.id]);
});

test("dry-run on observe: audits but never executes", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" }); // observe by default
  await repo.enforcerRules.create({ serverId: server.id, name: "TK kick", eventKind: "evt.teamkill", action: "kick", reason: "no TK" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  assert.equal(calls.length, 0, "executor not called on observe");
  const audit = await repo.audit.list({});
  const entry = audit.find((a) => a.action === "enforcer.dryrun");
  assert.ok(entry, "dry-run audited");
  assert.match(entry!.summary, /\[dry-run\]/);
});

test("dry-run when the server's autosettings automation is switched off, even on active", async () => {
  // The staged-migration case: the server is live for the map vote, but enforcement still belongs
  // to another system. The rule must audit what it WOULD have done and touch nothing.
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.servers.setAutomation(server.id, { autosettings: false });
  await repo.enforcerRules.create({ serverId: server.id, name: "TK kick", eventKind: "evt.teamkill", action: "kick", reason: "no TK" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  assert.equal(calls.length, 0, "executor not called while the switch is off");
  assert.ok((await repo.audit.list({})).some((a) => a.action === "enforcer.dryrun"), "still audited as a dry run");
});

test("execute on active: calls the executor and audits the action", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK kick", eventKind: "evt.teamkill", action: "kick", reason: "no TK" });

  const calls: Array<{ action: string; playerId: unknown }> = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ action, playerId: params.playerId }) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, "kick");
  assert.equal(calls[0]!.playerId, player.platformId); // resolved to the game id
  assert.ok((await repo.audit.list({})).some((a) => a.action === "enforcer.kick"));
});

test("threshold fires only after N matches in the window", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "3 TK", eventKind: "evt.teamkill", action: "kick", threshold: 3, windowSec: 60 });

  const calls: number[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => void calls.push(1) });
  await enf.refresh();
  const ev = { kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" };
  await enf.onEvent(ev);
  await enf.onEvent(ev);
  assert.equal(calls.length, 0, "not yet at threshold");
  await enf.onEvent(ev);
  assert.equal(calls.length, 1, "fires on the 3rd within the window");
});

test("blacklist action is now a real ban: game command + player_ban decision, temp with hours", async () => {
  // The action name survives from the era when it filed a blacklist record that never reached the
  // game. It now bans for real — this is the behaviour change docs/ban-model.md calls out.
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK blacklist", eventKind: "evt.teamkill", action: "blacklist", reason: "mass TK", hours: 72 });

  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ action, params }) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  // Hours on the rule → a temp ban at the game, with the player's game id.
  assert.equal(calls.length, 1, "the ban reaches the game");
  assert.equal(calls[0]!.action, "tempban");
  assert.equal(calls[0]!.params.playerId, player.platformId);
  assert.equal(calls[0]!.params.hours, 72);

  // And a decision row: temp, categorised as the enforcer's, scoped to the firing server only.
  const decisions = await repo.playerBans.list({ playerId: player.platformId });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.kind, "temp");
  assert.equal(decisions[0]!.reason, "mass TK");
  assert.equal(decisions[0]!.category, "enforcer");
  assert.deepEqual(decisions[0]!.scope, { mode: "servers", serverIds: [server.id] });
  assert.ok(decisions[0]!.expiresAt, "hours → decision expiry");
  assert.ok((await repo.audit.list({})).some((a) => a.action === "enforcer.blacklist"));

  // No hours on the rule → a permanent ban.
  await repo.enforcerRules.create({ serverId: server.id, name: "perma", eventKind: "evt.kill", action: "blacklist", reason: "cheat" });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.equal(calls[1]!.action, "permaban");
  const all = await repo.playerBans.list({ playerId: player.platformId });
  assert.ok(all.some((d) => d.kind === "perma"), "no hours → a permanent decision");
});

test("every firing publishes app.enforcement on the bus for the Discord automation alert", async (t) => {
  // The panel's address is the one Discord sign-in sends staff back to.
  const before = process.env.DISCORD_OAUTH_REDIRECT;
  process.env.DISCORD_OAUTH_REDIRECT = "https://admin.example.com/api/auth/discord/callback";
  t.after(() => { if (before === undefined) delete process.env.DISCORD_OAUTH_REDIRECT; else process.env.DISCORD_OAUTH_REDIRECT = before; });
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK guard", eventKind: "evt.teamkill", action: "tempban", reason: "8 TKs", hours: 24 });

  const emitted: Array<{ kind: string; evt: any }> = [];
  const bus = { on: () => () => {}, emit: (kind: string, evt: unknown) => void emitted.push({ kind, evt }), close: async () => {} } as any;
  const enf = new Enforcer({ repo, bus, execute: async () => {} });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  const e = emitted.find((x) => x.kind === "app.enforcement");
  assert.ok(e, "enforcement event published");
  assert.equal(e!.evt.serverId, server.id);
  assert.equal(e!.evt.actorName, "Griefer");
  assert.equal(e!.evt.data.ruleName, "TK guard");
  assert.equal(e!.evt.data.action, "tempban");
  assert.equal(e!.evt.data.hours, 24);
  assert.equal(e!.evt.data.dryRun, false);
  // The alert links the player's profile at that address — our own id, never the game id.
  assert.equal(e!.evt.data.profileUrl, `https://admin.example.com/#/players/~${player.id}`);

  // Without sign-in set up there is no address, so the firing links nothing. (Another player:
  // the first was just banned, and a removed player is not acted on again.)
  delete process.env.DISCORD_OAUTH_REDIRECT;
  const other = await repo.players.upsert({ platformId: "76561198099999777", platform: "steam", game: "hll", name: "Other" });
  emitted.length = 0;
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: other.id, actorName: "Other" });
  const unlinked = emitted.find((x) => x.kind === "app.enforcement");
  assert.ok(unlinked, "the second firing published too");
  assert.equal(unlinked!.evt.data.profileUrl, null);
});

// ---- delays, crash VIP, the role gate, and the idle clock ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a delayed action fires only if the player is still on the server", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "late welcome kick", eventKind: "evt.player.connected", action: "kick", reason: "closed", delaySec: 1 });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();

  // Still online when the delay runs out: the action lands.
  await repo.sessions.open(player.id, server.id, new Date().toISOString());
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.equal(calls.length, 0, "nothing fires before the delay");
  await sleep(1300);
  assert.deepEqual(calls, ["kick"]);

  // Gone before the delay runs out: kicking a ghost is not an action.
  const other = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000010", name: "Leaver" });
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: other.id, actorName: "Leaver" });
  await repo.sessions.open(other.id, server.id, new Date().toISOString());
  await repo.sessions.close(other.id, server.id, new Date().toISOString());
  await sleep(1300);
  assert.equal(calls.length, 1, "the departed player's action was dropped");
  await enf.stop();
});

test("crash VIP: a disconnect grants temporary VIP, recorded as a real grant", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "crash vip", eventKind: "evt.player.disconnected", action: "vip", vipMinutes: 15 });

  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ action, params }) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, "vip");
  const grant = await repo.vips.get(server.id, player.platformId);
  assert.ok(grant, "the grant row exists — the sweep will clean it up at expiry");
  assert.ok(grant!.expiration, "temporary, never permanent");
  const minutes = (Date.parse(grant!.expiration!) - Date.now()) / 60_000;
  assert.ok(minutes > 13 && minutes <= 15, `expires ~15 min out (got ${minutes.toFixed(1)})`);
  assert.match(grant!.comment ?? "", /VIP from rule "crash vip"/);
  assert.ok((await repo.audit.list({})).some((a) => a.action === "enforcer.vip"), "audited");
});

/*
 * The field incident's shape: a rule's VIP wrote "now + its minutes" straight over a grant that ran
 * far longer, cutting time players paid for. Its own pre-check normally stands down for a longer
 * grant, but a read that is stale by the time it writes (a reward landed in between) slipped past
 * it. The store now keeps the later date for every automated write, and the audit row records what
 * LANDED — so the integrity scan never reads the floor's work as a cut.
 */
test("crash VIP over a longer grant read stale: the grant keeps its date, and the audit records what landed", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "crash vip", eventKind: "evt.player.disconnected", action: "vip", vipMinutes: 15 });
  const paidUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: "Griefer", comment: "paid 30 days", expiration: paidUntil, createdByName: "staff" });
  // The stale read: the rule's pre-check asks before the grant it is about to overwrite is visible.
  const realGet = repo.vips.get.bind(repo.vips);
  let stale = true;
  repo.vips.get = async (sid: string, pid: string) => { if (stale) { stale = false; return null; } return realGet(sid, pid); };

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  assert.deepEqual(calls, ["vip"], "the rule fired on the stale read");
  const grant = await realGet(server.id, player.platformId);
  assert.equal(grant!.expiration, paidUntil, "the paid 30 days stand — a rule's VIP only ever adds time");
  assert.equal(grant!.comment, "paid 30 days", "and the grant's note is kept");
  const row = (await repo.audit.list({})).find((a) => a.action === "enforcer.vip");
  assert.equal((row?.data as { expiration?: string } | null)?.expiration, paidUntil, "the audit row says what landed, not the 15 minutes asked for");
});

test("crash VIP: a kicked player's disconnect is enforcement, not a crash", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "crash vip", eventKind: "evt.player.disconnected", action: "vip" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.player.kicked", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.equal(calls.length, 0, "the kick explains the disconnect — nothing is granted");
  assert.equal(await repo.vips.get(server.id, player.platformId), null);
});

test("crash VIP: the game's NAME-ONLY kick line still arms the guard", async () => {
  // The real KICK/BAN log lines carry the player's name and no id — the shape the test above
  // never exercised, which is how an AFK-kicked player's forced disconnect read as a crash and
  // came with a ten-minute VIP as a parting gift.
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "crash vip", eventKind: "evt.player.disconnected", action: "vip" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  // "KICK: [Griefer] HAS BEEN KICKED. [...]" — a name, no id, exactly as the parser emits it.
  await enf.onEvent({ kind: "evt.player.kicked", serverId: server.id, actorName: player.name });
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: player.name });
  assert.equal(calls.length, 0, "the name-only kick explains the disconnect — nothing is granted");
  assert.equal(await repo.vips.get(server.id, player.platformId), null);
});

test("crash VIP: the enforcer's own kick is remembered even with no KICK line at all", async () => {
  // The enforcer performs a removal itself (an idle kick, a TK tempban) — it knows the identity
  // in full and must not need the game's log line to avoid rewarding its own enforcement.
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK kick", eventKind: "evt.teamkill", action: "kick", reason: "no tk" });
  await repo.enforcerRules.create({ serverId: server.id, name: "crash vip", eventKind: "evt.player.disconnected", action: "vip" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: player.name });
  assert.deepEqual(calls, ["kick"]);
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: player.name });
  assert.deepEqual(calls, ["kick"], "the disconnect after our own kick is enforcement, not a crash");
  assert.equal(await repo.vips.get(server.id, player.platformId), null);
});

test("a ladder that escalates into tempban never sends a zero-hour ban", async () => {
  // Rules saved before hours were required for ladder tempbans carry hours: null — and a
  // Duration: 0 tempban on the v2 wire is a ban that holds nobody, recorded as a success.
  // The engine floors it to the editor's own default instead.
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK ladder", eventKind: "evt.teamkill", action: "message", reason: "zero-hour (ladder3)",
    escalateActions: ["tempban"], escalateResetMinutes: 120,
  });

  const seen: { action: string; hours: unknown }[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => {
    if (String(params.reason ?? "").includes("(ladder3)")) seen.push({ action, hours: params.hours });
  } });
  await enf.refresh();
  const tk = { kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: player.name };
  await enf.onEvent(tk);
  await enf.onEvent(tk);
  assert.deepEqual(seen.map((s) => s.action), ["message", "tempban"]);
  assert.equal(seen[1]!.hours, 2, "a legacy null-hours ladder tempban goes out with a real duration");
});

/**
 * The farm the cooldown exists to stop, staged exactly as it happened: take the grant, let it run
 * out, disconnect again. `vipWouldAdd` cannot see this — an expired grant has nothing to lose, so
 * it says yes every time, and the expiry rolls forward forever. Only the cooldown says no.
 */
async function crashVipSetup(cooldownMinutes?: number) {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  // Pinned to its own server on purpose. A community-wide rule (serverId null) also fires on
  // every OTHER server's events, so the two-server test below could not tell which rule granted.
  const rule = await repo.enforcerRules.create({
    name: "crash vip", serverId: server.id, eventKind: "evt.player.disconnected", action: "vip", vipMinutes: 10,
    ...(cooldownMinutes === undefined ? {} : { vipCooldownMinutes: cooldownMinutes }),
  });
  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  const disconnect = () => enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  // Wind the grant they just took past its expiry, the way the VIP sweep eventually would. A
  // fixture winding the clock, not a writer: it says so, since the store refuses any unflagged
  // write that moves a grant earlier.
  const expireTheirVip = () => repo.vips.upsert({
    serverId: server.id, playerId: player.platformId, playerName: player.name,
    comment: "spent", expiration: new Date(Date.now() - 1000).toISOString(), createdByUserId: null, createdByName: "enforcer", mayShorten: true,
  });
  return { repo, player, server, rule, enf, calls, disconnect, expireTheirVip };
}

test("crash VIP cooldown: an expired grant does not entitle the player to another one", async () => {
  const { calls, disconnect, expireTheirVip } = await crashVipSetup(); // default 60 min

  await disconnect();
  assert.deepEqual(calls, ["vip"], "the first crash is covered");

  await expireTheirVip();
  await disconnect();
  assert.deepEqual(calls, ["vip"], "still one grant — the cooldown refused the re-farm");
});

test("crash VIP cooldown: 0 means no limit, and staff have to choose it", async () => {
  const { calls, disconnect, expireTheirVip } = await crashVipSetup(0);

  await disconnect();
  await expireTheirVip();
  await disconnect();
  assert.deepEqual(calls, ["vip", "vip"], "no cooldown configured, no cooldown applied");
});

test("crash VIP cooldown: once it lapses, the next real crash is covered again", async () => {
  const { repo, calls, disconnect, expireTheirVip } = await crashVipSetup(60);

  await disconnect();
  await expireTheirVip();
  // Their grant now reads as an hour and a minute old — the cooldown has run out.
  (repo.enforcerRules as any).lastVipGrantAt = async () => new Date(Date.now() - 61 * 60_000).toISOString();
  await disconnect();
  assert.deepEqual(calls, ["vip", "vip"], "a genuine crash an hour later is not punished for the first one");
});

/**
 * The reason the stamp lives in the store and not in a Map on the Enforcer: a restart must not
 * hand everyone a fresh allowance. A deploy is exactly the window someone farming it would learn
 * to wait for.
 */
test("crash VIP cooldown survives a restart of the enforcer", async () => {
  const { repo, server, player, calls, disconnect, expireTheirVip } = await crashVipSetup(60);

  await disconnect();
  assert.deepEqual(calls, ["vip"]);
  await expireTheirVip();

  const restarted: string[] = [];
  const enf2 = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void restarted.push(action) });
  await enf2.refresh();
  await enf2.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.deepEqual(restarted, [], "the new process remembers what the old one granted");
});

test("crash VIP cooldown is per rule and per server, not global to the player", async () => {
  const { repo, player, rule, calls, disconnect, expireTheirVip } = await crashVipSetup(60);
  await disconnect();
  await expireTheirVip();

  // A second server with its own rule: the same player crashing there is a separate question.
  const other = await repo.servers.create({ name: "s2", host: "h", port: 2, password: "x" });
  await repo.servers.setEngagementMode(other.id, "active");
  const rule2 = await repo.enforcerRules.create({ name: "crash vip 2", serverId: other.id, eventKind: "evt.player.disconnected", action: "vip", vipCooldownMinutes: 60 });

  const enf2Calls: string[] = [];
  const enf2 = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void enf2Calls.push(action) });
  await enf2.refresh();
  await enf2.onEvent({ kind: "evt.player.disconnected", serverId: other.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.deepEqual(enf2Calls, ["vip"], "the other server's rule has its own cooldown to spend");
  assert.deepEqual(calls, ["vip"]);

  // Assert WHICH rule spent it, not just how many grants happened: a count alone would pass if
  // some other rule had fired, and the first rule's cooldown must still be untouched over there.
  assert.ok(await repo.enforcerRules.lastVipGrantAt(rule2.id, other.id, player.platformId), "the second server's own rule granted it");
  assert.equal(await repo.enforcerRules.lastVipGrantAt(rule.id, other.id, player.platformId), null, "the first rule did not reach the second server");
});

test("a dry-run crash VIP does not burn the player's cooldown", async () => {
  // Tuning a rule in observe mode must not cost players their next real crash VIP.
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" }); // observe
  await repo.enforcerRules.create({ serverId: server.id, name: "crash vip", eventKind: "evt.player.disconnected", action: "vip", vipCooldownMinutes: 60 });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  const fire = () => enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  await fire();
  assert.deepEqual(calls, [], "observe mode executes nothing");
  assert.ok((await repo.audit.list({})).some((a) => a.action === "enforcer.dryrun"), "but it is audited");

  await repo.servers.setEngagementMode(server.id, "active");
  await enf.refresh();
  await fire();
  assert.deepEqual(calls, ["vip"], "the dry run left the cooldown unspent");
});

test("crash VIP never shortens VIP the player already holds", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: player.name, comment: "staff grant", expiration: null, createdByUserId: null, createdByName: "staff" });
  await repo.enforcerRules.create({ serverId: server.id, name: "crash vip", eventKind: "evt.player.disconnected", action: "vip" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.equal(calls.length, 0, "a permanent grant has nothing to gain");
  const grant = await repo.vips.get(server.id, player.platformId);
  assert.equal(grant!.expiration, null, "the permanent grant is untouched");
});

test("a role-gated rule never fires for an unlinked player", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "boosters only", eventKind: "evt.player.disconnected", action: "vip", requireRoleIds: ["123456789012345678"] });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.equal(calls.length, 0, "no Discord link = no role = the gate holds");
});

test("app.idle: the clock starts at connect, resets on a kill, and fires once per window", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "afk", eventKind: "app.idle", action: "punish", reason: "no kills", windowSec: 60 });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();

  // Connected two minutes ago, silent since: over the 60s window. (Ingest opens the session on the
  // same connect line it publishes.)
  const connectedAt = new Date(Date.now() - 120_000).toISOString();
  await repo.sessions.open(player.id, server.id, connectedAt);
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", ts: connectedAt });
  await enf.runIdleSweep();
  assert.deepEqual(calls, ["punish"]);
  // Still idle a moment later: the firing spent the window — no repeat yet.
  await enf.runIdleSweep();
  assert.equal(calls.length, 1, "one firing per window, not one per sweep");

  // A kill resets the clock entirely.
  await enf.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", ts: new Date().toISOString() });
  (enf as any).idleFiredAt.clear(); // window cooldown aside, the fresh clock alone must protect them
  await enf.runIdleSweep();
  assert.equal(calls.length, 1, "a player who just killed is not idle");

  // And a disconnect takes them off the clock.
  await enf.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  await enf.runIdleSweep();
  assert.equal(calls.length, 1, "nobody on the clock, nothing to flag");
});

test("app.idle: a player who left with no disconnect line (a crash, a restart) is taken off the clock, not acted on every window", async () => {
  const { repo, player: gone } = await seed();
  const stays = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000061", name: "Parked" });
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  // A ladder that ends in a ban: a ban lands on a player id whether or not anyone is there.
  await repo.enforcerRules.create({ serverId: server.id, name: "afk", eventKind: "app.idle", action: "kick", escalateActions: ["tempban"], hours: 2, reason: "afk", windowSec: 60 });

  const hit: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, p: Record<string, unknown>) => void hit.push(`${action} ${String(p.playerId)}`) });
  await enf.refresh();
  // Both connected ten minutes ago and have been quiet since; ingest opens the session on the same
  // connect line it publishes.
  const at = new Date(Date.now() - 600_000).toISOString();
  for (const p of [gone, stays]) {
    await repo.sessions.open(p.id, server.id, at);
    await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: p.id, actorName: p.name, ts: at });
  }
  // The server crashes; one of them never comes back. The game logs no DISCONNECTED line for
  // anybody, and the worker's next roster read closes the session the roster no longer backs.
  await repo.sessions.closeAbsent(server.id, [stays.id], new Date().toISOString(), new Date().toISOString());

  for (let window = 0; window < 3; window++) {
    await enf.runIdleSweep();
    (enf as any).idleFiredAt.clear(); // the next window
  }
  assert.ok(!hit.some((h) => h.endsWith(gone.platformId)), `nothing was done to the player who left: ${JSON.stringify(hit)}`);
  assert.deepEqual(hit, [`kick ${stays.platformId}`, `tempban ${stays.platformId}`, `tempban ${stays.platformId}`], "the one still here is judged as before");
  assert.equal((enf as any).idleClocks.size, 1, "the clock of the player who left is dropped, not kept for the life of the process");
});

test("app.idle: presence that cannot be read fires nothing that round, and keeps every clock", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "afk", eventKind: "app.idle", action: "kick", reason: "afk", windowSec: 60 });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  const at = new Date(Date.now() - 600_000).toISOString();
  await repo.sessions.open(player.id, server.id, at);
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", ts: at });

  const read = repo.sessions.openServersFor;
  repo.sessions.openServersFor = async () => { throw new Error("database unavailable"); };
  await enf.runIdleSweep();
  assert.equal(calls.length, 0, "unknown presence is not presence");
  assert.equal((enf as any).idleClocks.size, 1, "nor absence: the clock stays");

  repo.sessions.openServersFor = read;
  await enf.runIdleSweep();
  assert.deepEqual(calls, ["kick"], "back to normal on the next sweep");
});

test("app.idle: a reconnect that lands while presence is being read keeps its new clock", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "afk", eventKind: "app.idle", action: "kick", reason: "afk", windowSec: 60 });

  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {} });
  await enf.refresh();
  // A clock left over from before a crash: no session backs it any more.
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", ts: new Date(Date.now() - 600_000).toISOString() });

  const read = repo.sessions.openServersFor;
  repo.sessions.openServersFor = async (ids: string[]) => {
    const answer = await read(ids); // taken before the player is back
    const now = new Date().toISOString();
    await repo.sessions.open(player.id, server.id, now);
    await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", ts: now });
    return answer;
  };
  await enf.runIdleSweep();
  assert.equal((enf as any).idleClocks.size, 1, "the clock the reconnect started is not dropped on the stale read");
});

// ---- death triggers: the same kill events, read from the victim's end ----

test("a death rule acts on the VICTIM, while a kill rule on the same event acts on the attacker", async () => {
  const { repo, player: killer } = await seed();
  const victim = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000021", name: "Victim" });
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "warn the killer", eventKind: "evt.teamkill", action: "message", reason: "no TK" });
  await repo.enforcerRules.create({ serverId: server.id, name: "console the victim", eventKind: "app.teamdeath", action: "message", reason: "sorry about that" });

  const hit: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, _a: string, p: Record<string, unknown>) => void hit.push(String(p.playerId)) });
  await enf.refresh();
  await enf.onEvent({
    kind: "evt.teamkill", serverId: server.id,
    actorPlayerId: killer.id, actorName: "Griefer",
    victimPlayerId: victim.id, victimName: "Victim",
  });

  assert.equal(hit.length, 2, "one event, two rules, two different subjects");
  assert.ok(hit.includes(killer.platformId), "the kill rule reached the attacker");
  assert.ok(hit.includes(victim.platformId), "the death rule reached the victim");
});

test("a death rule's threshold counts the player who kept dying, not the killers", async () => {
  const { repo } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const victim = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000031", name: "Spawncamped" });
  const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000032", name: "KillerA" });
  const b = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000033", name: "KillerB" });
  await repo.enforcerRules.create({ serverId: server.id, name: "spawn camped", eventKind: "app.death", action: "message", reason: "rough spawn", threshold: 3, windowSec: 60 });

  const hit: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, _a: string, p: Record<string, unknown>) => void hit.push(String(p.playerId)) });
  await enf.refresh();
  // Three deaths for ONE victim, at the hands of three different attackers: the threshold is the
  // victim's, so this reaches it. Counted per attacker it never would.
  for (const killer of [a, b, a]) {
    await enf.onEvent({
      kind: "evt.kill", serverId: server.id,
      actorPlayerId: killer.id, actorName: killer.name,
      victimPlayerId: victim.id, victimName: "Spawncamped",
    });
  }
  assert.deepEqual(hit, [victim.platformId], "fired once, on the third death, at the victim");
});

test("a death whose victim we cannot resolve is not counted and not acted on", async () => {
  const { repo, player: killer } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "deaths", eventKind: "app.death", action: "message", reason: "x", threshold: 2, windowSec: 60 });

  const hit: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => void hit.push("fired") });
  await enf.refresh();
  // Two unresolvable deaths must not push the threshold — they are not evidence about anyone.
  for (let i = 0; i < 2; i++) {
    await enf.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: killer.id, actorName: "Griefer", victimName: "Ghost" });
  }
  assert.equal(hit.length, 0);
});

/*
 * A threshold counts ONE person, even when the only thing identifying them is a name.
 *
 * Admin-camera rules are the case that has no player id to count by — a camera line the log could
 * not resolve to one of our player rows is routine — so the window falls back to the name. Three
 * admins going on cam is three people, not one person three times; the rule may only fire on
 * somebody's own third visit. Nothing else pins the name fallback, and a coarser key here would be
 * invisible until a rule punished the wrong admin.
 */
test("a threshold counts each admin separately when only a name identifies them", async () => {
  const { repo } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({
    serverId: server.id, name: "cam churn", eventKind: "app.admincam.enter",
    action: "note", reason: "on cam", threshold: 3, windowSec: 60,
  });

  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {} });
  await enf.refresh();
  // Three DIFFERENT admins, none of them resolvable to one of our player rows. Under the old key
  // these three shared a window and the third one fired the rule.
  for (const name of ["Alice", "Bob", "Cara"]) {
    await enf.onEvent({ kind: "evt.admin.camera", serverId: server.id, actorName: name, data: { entered: true } });
  }
  const after3 = (await repo.audit.list({ serverId: server.id })).filter((a) => a.action.startsWith("enforcer."));
  assert.equal(after3.length, 0, "three different people are not one person hitting a threshold");

  // The same person three times over is what the rule is actually for.
  for (let i = 0; i < 3; i++) {
    await enf.onEvent({ kind: "evt.admin.camera", serverId: server.id, actorName: "Alice", data: { entered: true } });
  }
  const fired = (await repo.audit.list({ serverId: server.id })).filter((a) => a.action.startsWith("enforcer."));
  assert.equal(fired.length, 1, "Alice's own third visit fires it");
  assert.equal(fired[0]!.targetName, "Alice");
});

test("message tokens name both ends of the kill", async () => {
  const { repo, player: killer } = await seed();
  const victim = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000041", name: "Victim" });
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "tell them who", eventKind: "app.teamdeath", action: "message",
    reason: "{player_name}, you were team-killed by {attacker_name} with {weapon}. {unknown_token}",
  });

  let sent = "";
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, _a: string, p: Record<string, unknown>) => void (sent = String(p.message)) });
  await enf.refresh();
  await enf.onEvent({
    kind: "evt.teamkill", serverId: server.id,
    actorPlayerId: killer.id, actorName: "Griefer",
    victimPlayerId: victim.id, victimName: "Victim", weapon: "SATCHEL",
  });
  assert.match(sent, /Victim, you were team-killed by Griefer with SATCHEL\./);
  assert.match(sent, /\{unknown_token\}/, "an unknown token is left as written");
});

test("dying is not activity: a player killed repeatedly while AFK still trips the idle rule", async () => {
  const { repo, player: killer } = await seed();
  const victim = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000051", name: "Parked" });
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "afk", eventKind: "app.idle", action: "message", reason: "afk", windowSec: 60 });

  const hit: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, _a: string, p: Record<string, unknown>) => void hit.push(String(p.playerId)) });
  await enf.refresh();
  // Connected two minutes ago, then killed twice since — deaths, not kills.
  const connectedAt = new Date(Date.now() - 120_000).toISOString();
  await repo.sessions.open(victim.id, server.id, connectedAt);
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: victim.id, actorName: "Parked", ts: connectedAt });
  await enf.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: killer.id, actorName: "Griefer", victimPlayerId: victim.id, victimName: "Parked", ts: new Date().toISOString() });
  await enf.runIdleSweep();
  assert.deepEqual(hit, [victim.platformId], "being killed is not being at the keyboard");
});

test("the Discord role cache is evicted, not just ignored, once it goes stale", async () => {
  // Its TTL was applied when an entry was READ, so a stale answer was correctly ignored and then
  // kept for the life of the process: every distinct player who ever tripped a role-gated rule
  // held a slot forever. The two maps beside it are pruned on refresh for exactly this reason.
  //
  // A leak is not observable from behaviour — only from the structure — so this reads the map.
  const { repo } = await seed();
  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {} });
  const cache = (enf as any).roleCache as Map<string, { roleIds: string[]; atMs: number }>;
  const now = Date.now();
  cache.set("stale", { roleIds: ["r1"], atMs: now - 6 * 60_000 });  // past the 5-minute TTL
  cache.set("fresh", { roleIds: ["r1"], atMs: now - 30_000 });      // still answerable
  assert.equal(cache.size, 2);

  await enf.refresh();

  assert.deepEqual([...cache.keys()], ["fresh"], "the entry that could never be returned again is gone");
  await enf.stop();
});

/**
 * Escalation: one rule, three consequences. The rule's own action is the first offence; the
 * ladder's steps are the repeats, the last repeating — so "message, then punish, then kick" no
 * longer means three rules with staggered thresholds kept in step by hand.
 */
test("a rule with a ladder steps through its actions on repeat offences", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const ladderRule = await repo.enforcerRules.create({ serverId: server.id, name: "TK ladder", eventKind: "evt.teamkill", action: "message", reason: "no TK (ladder)",
    escalateActions: ["punish", "kick"], escalateResetMinutes: 120,
  });

  // Only THIS rule's firings are counted: against a shared Postgres database, rules left behind by
  // earlier tests also hear the event, and counting their actions would fail this test for reasons
  // that have nothing to do with the ladder. The rule's own reason text is the filter.
  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => {
    if (String(params.reason ?? "").includes("no TK (ladder)")) calls.push(action);
  } });
  await enf.refresh();

  const tk = { kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" };
  const back = { kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" };
  await enf.onEvent(tk);
  await enf.onEvent(tk);
  await enf.onEvent(tk); // third offence: the ladder kicks them off the server
  // A kicked player can only offend again after RECONNECTING — and the removal memory holds
  // presence actions until that connect arrives (a TK logged after the kick is the pre-removal
  // log tail, and there is nobody there to act on).
  await enf.onEvent(back);
  await enf.onEvent(tk); // fourth offence: the last step repeats — it does not fall off the ladder
  assert.deepEqual(calls, ["message", "punish", "kick", "kick"]);

  // The trail names the effective action and the step, so two different consequences from one
  // rule read as escalation rather than as a bug.
  const audit = (await repo.audit.list({ limit: 30 })).filter((a) => (a.data as { ruleId?: string } | null)?.ruleId === ladderRule.id);
  const acts = audit.map((a) => a.action).sort();
  assert.deepEqual(acts, ["enforcer.kick", "enforcer.kick", "enforcer.message", "enforcer.punish"]);
  const stepped = audit.find((a) => a.action === "enforcer.punish");
  assert.match(stepped!.summary, /offence 2 of 3/);
});

test("the ladder forgets after its reset window, and rules without one behave as before", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK ladder", eventKind: "evt.teamkill", action: "message", reason: "forgetful (ladder2)",
    escalateActions: ["kick"], escalateResetMinutes: 1, // one minute of memory
  });
  await repo.enforcerRules.create({ serverId: server.id, name: "plain", eventKind: "evt.kill", action: "punish", reason: "plain (ladder2)" });

  // Same shared-database armor as the test above: only these two rules' firings count.
  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => {
    if (String(params.reason ?? "").includes("(ladder2)")) calls.push(action);
  } });
  await enf.refresh();

  const tk = { kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "G" };
  await enf.onEvent(tk);
  assert.deepEqual(calls, ["message"]);

  // Age the offence past the reset window by reaching into the ladder map — the decay is time-based
  // and the test must not sleep a minute.
  const offences = (enf as unknown as { offences: Map<string, { count: number; lastMs: number }> }).offences;
  for (const [k, st] of offences) offences.set(k, { ...st, lastMs: st.lastMs - 2 * 60_000 });
  await enf.onEvent(tk);
  assert.deepEqual(calls, ["message", "message"], "a forgotten ladder starts at the first step again");

  // A ladderless rule repeats its one action forever, exactly as it always has.
  const kill = { kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "G" };
  await enf.onEvent(kill);
  await enf.onEvent(kill);
  assert.deepEqual(calls.slice(-2), ["punish", "punish"]);
});

// ---- admin-camera triggers + the note action ----

test("matchesRule: the cam kinds split one event by direction; unknown direction matches neither", () => {
  const enter = rule({ eventKind: "app.admincam.enter" });
  const exit = rule({ eventKind: "app.admincam.exit" });
  assert.equal(matchesRule(enter, { kind: "evt.admin.camera", data: { entered: true } }), true);
  assert.equal(matchesRule(enter, { kind: "evt.admin.camera", data: { entered: false } }), false);
  assert.equal(matchesRule(exit, { kind: "evt.admin.camera", data: { entered: false } }), true);
  assert.equal(matchesRule(exit, { kind: "evt.admin.camera", data: { entered: true } }), false);
  // A camera line whose direction did not parse carries entered:null — a gap in the record, not
  // a firing for either rule.
  assert.equal(matchesRule(enter, { kind: "evt.admin.camera", data: { entered: null } }), false);
  assert.equal(matchesRule(exit, { kind: "evt.admin.camera", data: {} }), false);
  assert.equal(matchesRule(enter, { kind: "evt.kill" }), false, "only the camera event qualifies");
  // The raw kind keeps its old meaning: both halves.
  assert.equal(matchesRule(rule({ eventKind: "evt.admin.camera" }), { kind: "evt.admin.camera", data: { entered: false } }), true);
});

test("a note rule records and pings but never touches the game — even on an observe server", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" }); // observe by default
  await repo.enforcerRules.create({ serverId: server.id, name: "cam watch", eventKind: "app.admincam.enter", action: "note", reason: "went on cam",
    alertChannelId: "123456789012345",
  });

  const calls: string[] = [];
  const emitted: { kind?: string; data?: Record<string, unknown> }[] = [];
  const bus = { on: () => () => {}, emit: (_k: string, e: unknown) => void emitted.push(e as never), close: async () => {} } as any;
  const enf = new Enforcer({ repo, bus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();

  await enf.onEvent({ kind: "evt.admin.camera", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", data: { entered: true } });
  assert.equal(calls.length, 0, "a note has nothing to execute");
  const audit = await repo.audit.list({ serverId: server.id });
  const entry = audit.find((a) => a.action === "enforcer.note");
  assert.ok(entry, "recorded as a REAL firing — a note touches nothing, so observe mode has nothing to protect");
  assert.ok(!audit.some((a) => a.action === "enforcer.dryrun"), "not downgraded to a dry-run");
  const evt = emitted.find((e) => e?.kind === "app.enforcement");
  assert.ok(evt, "the firing reaches the bus for the Discord ping");
  assert.equal(evt!.data?.alertChannelId, "123456789012345", "the rule's own channel rides along");
  assert.equal(evt!.data?.dryRun, false);

  // The other half of the visit is not this rule's trigger.
  await enf.onEvent({ kind: "evt.admin.camera", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", data: { entered: false } });
  const after = await repo.audit.list({ serverId: server.id });
  assert.equal(after.filter((a) => a.action === "enforcer.note").length, 1, "leaving cam did not fire the enter rule");
});

/*
 * A note fires on the NAME alone. Requiring a resolvable game id for it was a real gap rather
 * than a theoretical one: admin-camera log lines with no readable player id are routine (the
 * store's own open() documents matching those sessions by name for exactly that reason), so a
 * cam-notify rule would have gone silent on the servers that produce them.
 */
test("a note fires without a resolvable game id; anything that touches the game still cannot", async () => {
  const repo = await createRepository();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "cam watch", eventKind: "app.admincam.enter", action: "note", reason: "on cam" });
  await repo.enforcerRules.create({ serverId: server.id, name: "cam kick", eventKind: "app.admincam.enter", action: "kick", reason: "no" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();
  // No actorPlayerId at all — the id was missing or unreadable on the log line.
  await enf.onEvent({ kind: "evt.admin.camera", serverId: server.id, actorPlayerId: null, actorName: "GhostAdmin", data: { entered: true } });

  const audit = await repo.audit.list({ serverId: server.id });
  const noted = audit.find((a) => a.action === "enforcer.note");
  assert.ok(noted, "the note recorded the firing with the name it had");
  assert.match(noted!.summary, /GhostAdmin/);
  assert.equal(noted!.targetId, null, "no player row to point at, and that is fine for a note");
  assert.equal(calls.length, 0, "the kick rule had no game id to name, so it stood down");
  assert.ok(!audit.some((a) => a.action === "enforcer.kick"), "and audited nothing it did not do");
});

test("a note ladder step still fires when the id is missing, but a game step does not", async () => {
  const repo = await createRepository();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  // note first, kick on the repeat: the first offence is actionable without an id, the second is not.
  await repo.enforcerRules.create({ serverId: server.id, name: "escalating cam", eventKind: "app.admincam.enter", action: "note",
    escalateActions: ["kick"], escalateResetMinutes: 0,
  });
  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();
  const evt = { kind: "evt.admin.camera", serverId: server.id, actorPlayerId: null, actorName: "GhostAdmin", data: { entered: true } };
  await enf.onEvent(evt);
  await enf.onEvent(evt);
  const audit = await repo.audit.list({ serverId: server.id });
  assert.equal(audit.filter((a) => a.action === "enforcer.note").length, 1, "step one noted");
  assert.equal(calls.length, 0, "step two needed a game id it never had");
});

test("two unidentified subjects climb their own ladders, not a shared one", async () => {
  // With no ids to key on, the ladder fell back to one empty key per rule — so the second admin's
  // first offence inherited the first admin's step and skipped straight to the escalation.
  const repo = await createRepository();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "cam ladder", eventKind: "app.admincam.enter", action: "note",
    escalateActions: ["note"], escalateResetMinutes: 0,
  });
  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {} });
  await enf.refresh();
  const cam = (name: string) => ({ kind: "evt.admin.camera", serverId: server.id, actorPlayerId: null, actorName: name, data: { entered: true } });
  await enf.onEvent(cam("AdminOne"));
  await enf.onEvent(cam("AdminTwo"));

  const audit = await repo.audit.list({ serverId: server.id });
  const two = audit.find((a) => a.targetName === "AdminTwo");
  assert.ok(two, "the second admin's firing was recorded");
  assert.match(two!.summary, /offence 1/, "and it is THEIR first offence, not a continuation of the first admin's");
});

// ---- parity with the other three enforcement systems: exemptions + a per-rule trial run ----

test("an immune tag makes a rule skip the player entirely", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.playerTags.add({ playerId: player.id, label: "staff", createdByName: "owner" });
  await repo.enforcerRules.create({ serverId: server.id, name: "TK kick", eventKind: "evt.teamkill", action: "kick", immuneTags: ["staff"] });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  assert.equal(calls.length, 0, "the exempt player was not acted on");
  const audit = await repo.audit.list({ serverId: server.id });
  assert.equal(audit.length, 0, "and nothing was recorded — a skip is not a firing");
});

test("a tag that is not on the immune list still gets acted on", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.playerTags.add({ playerId: player.id, label: "watched", createdByName: "owner" });
  await repo.enforcerRules.create({ serverId: server.id, name: "TK kick", eventKind: "evt.teamkill", action: "kick", immuneTags: ["staff"] });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  assert.deepEqual(calls, [server.id], "immunity is per tag, not 'has any tag'");
});

test("a rule on trial audits what it would have done and touches nobody", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active"); // the SERVER is live…
  await repo.enforcerRules.create({ serverId: server.id, name: "new tk rule", eventKind: "evt.teamkill", action: "kick", reason: "no TK", dryRun: true });
  await repo.enforcerRules.create({ serverId: server.id, name: "proven rule", eventKind: "evt.teamkill", action: "punish", reason: "no TK" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, a: string) => void calls.push(a) });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  // …so the rule NOT on trial still enforces. That is the whole point of the per-rule grain:
  // observe mode would have parked both.
  assert.deepEqual(calls, ["punish"], "only the trial rule held back");
  const audit = await repo.audit.list({ serverId: server.id });
  assert.ok(audit.some((a) => a.action === "enforcer.dryrun" && /new tk rule/.test(a.summary)), "the trial recorded what it would have done");
  assert.ok(audit.some((a) => a.action === "enforcer.punish"), "and its neighbour really acted");
});

test("firings become the rule's proof of life — count and last-fired, per rule", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const busy = await repo.enforcerRules.create({ serverId: server.id, name: "tk kick", eventKind: "evt.teamkill", action: "kick", reason: "no TK" });
  const quiet = await repo.enforcerRules.create({ serverId: server.id, name: "never", eventKind: "evt.vote.cast", action: "message", reason: "hm" });

  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {} });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  // A kick removes them; the second offence needs the reconnect the real world requires.
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const activity = await repo.enforcerRules.activity(since);
  assert.equal(activity.get(busy.id)?.count, 2, "both firings counted");
  assert.ok(activity.get(busy.id)!.lastFiredAt >= since);
  assert.equal(activity.get(quiet.id), undefined, "a rule that never fired stays absent — that IS the signal");

  // The window is honoured: nothing counts from before it.
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await repo.enforcerRules.activity(future)).size, 0);
});

test("a rule can spare newcomers by level, and an unknown level is not a low one", async () => {
  const repo = await createRepository();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  // Level arrives with the roster sighting, which is the only place it is ever visible.
  const rookie = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611981000${String(++seq).padStart(5, "0")}`, name: "Rookie", level: 4 });
  const veteran = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611981000${String(++seq).padStart(5, "0")}`, name: "Veteran", level: 250 });
  const stranger = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611981000${String(++seq).padStart(5, "0")}`, name: "Stranger" });
  await repo.enforcerRules.create({ serverId: server.id, name: "tk kick", eventKind: "evt.teamkill", action: "kick", reason: "no TK", immuneLevel: 10 });

  const hit: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, _a: string, params: Record<string, unknown>) => void hit.push(String(params.playerId)) });
  await enf.refresh();
  for (const who of [rookie, veteran, stranger]) {
    await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: who.id, actorName: who.name });
  }
  assert.ok(!hit.includes(rookie.platformId), "the newcomer was spared");
  assert.ok(hit.includes(veteran.platformId), "the veteran was not");
  assert.ok(hit.includes(stranger.platformId), "and a player whose level we have never seen is NOT treated as low");
});

test("a level seen once is remembered, and a sighting without one does not erase it", async () => {
  const repo = await createRepository();
  const first = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611981000${String(seq + 900).padStart(5, "0")}`, name: "Ada", level: 42 });
  assert.equal(first.level, 42);
  // The CRCON importer and the log ingest both upsert players from sightings that carry no level.
  const again = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611981000${String(seq + 900).padStart(5, "0")}`, name: "Ada" });
  assert.equal(again.level, 42, "not seeing a level is not evidence of not having one");
  const promoted = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611981000${String(seq + 900).padStart(5, "0")}`, name: "Ada", level: 43 });
  assert.equal(promoted.level, 43, "a fresher reading wins");
});

test("an automated action records why it happened, not just that it did", async () => {
  // The profile's moderation timeline reads these fields to explain a decision nobody chose one
  // at a time. Without them a row could say the automod had acted and never what earned it.
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK guard", eventKind: "evt.teamkill", action: "message", reason: "no team killing",
    escalateActions: ["punish", "kick"], escalateResetMinutes: 0,
  });
  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {} });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });

  const rows = (await repo.audit.list({ serverId: server.id })).filter((a) => a.action.startsWith("enforcer."));
  const second = rows.find((a) => (a.data as { escalationStep?: number })?.escalationStep === 2);
  assert.ok(second, "the repeat offence is recorded as one");
  const d = second!.data as Record<string, unknown>;
  assert.equal(d.ruleName, "TK guard", "the rule is named on the row, so renaming it later cannot erase the explanation");
  assert.equal(d.eventKind, "evt.teamkill", "and what tripped it");
  assert.equal(d.escalationOf, 3, "…and how long the ladder was, so '2' means something");
  assert.ok(typeof d.ruleId === "string" && d.ruleId, "the id stays for linking back to a rule that still exists");
});

/*
 * The roster-state and weapon triggers — the player-rule scenarios that used to be standalone
 * modules. State events are synthesized per rule by the worker; the enforcer must fire ONLY the
 * rule whose id rides in the event, and the weapon trigger judges kill events against the rule's
 * own lists inline.
 */
test("matchesRule: a state event fires only the rule whose id it carries", () => {
  const solo = rule({ id: "solo-1", eventKind: "app.state.solo_tank", params: { tankRoles: [11, 12], minCrew: 2 } });
  assert.equal(matchesRule(solo, { kind: "app.state.solo_tank", data: { ruleId: "solo-1", violation: "solo tank" } }), true);
  assert.equal(matchesRule(solo, { kind: "app.state.solo_tank", data: { ruleId: "solo-2", violation: "solo tank" } }), false,
    "a sibling rule's detection ran with different params — firing this one from it would enforce knobs its author never set");
  assert.equal(matchesRule(solo, { kind: "evt.teamkill" }), false);
});

test("matchesRule: the weapon trigger judges kills against the rule's own lists", () => {
  const r = rule({ eventKind: "app.weapon.restricted", params: { disallowedWeapons: "FLAMETHROWER, SATCHEL" } });
  assert.equal(matchesRule(r, { kind: "evt.kill", weapon: "M2 FLAMETHROWER" }), true);
  assert.equal(matchesRule(r, { kind: "evt.teamkill", weapon: "SATCHEL" }), true, "a team-kill with the weapon counts too");
  assert.equal(matchesRule(r, { kind: "evt.kill", weapon: "M1 GARAND" }), false);
  assert.equal(matchesRule(r, { kind: "evt.chat.team", weapon: "SATCHEL" }), false);
});

test("a state firing acts on the player and fills {violation}; a weapon firing computes its own", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const stateRule = await repo.enforcerRules.create({
    serverId: server.id, name: "No solo tank", eventKind: "app.state.solo_tank", action: "message",
    reason: "{violation}", params: { tankRoles: [11, 12], minCrew: 2 },
  });
  await repo.enforcerRules.create({
    serverId: server.id, name: "No flame", eventKind: "app.weapon.restricted", action: "punish",
    reason: "{violation}", params: { disallowedWeapons: "FLAMETHROWER" },
  });

  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ action, params }) });
  await enf.refresh();

  await enf.onEvent({
    kind: "app.state.solo_tank", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer",
    data: { ruleId: stateRule.id, violation: "solo tank — an armor squad needs at least 2 crew" },
  });
  await enf.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", weapon: "M2 FLAMETHROWER" });

  assert.equal(calls.length, 2, "one firing each");
  const msg = calls.find((c) => c.action === "message")!;
  assert.match(String(msg.params.message), /solo tank — an armor squad needs at least 2 crew/, "the worker's detected sentence fills {violation}");
  const punish = calls.find((c) => c.action === "punish")!;
  assert.match(String(punish.params.reason), /M2 FLAMETHROWER is not allowed here/, "the weapon firing computes its violation inline");

  // A state event carrying an unknown ruleId fires nothing — no rule owns that detection.
  await enf.onEvent({ kind: "app.state.solo_tank", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer", data: { ruleId: "nope", violation: "x" } });
  assert.equal(calls.length, 2);
});

test("matchesRule: active hours gate the firing — overnight wrap, weekdays and timezone all honoured", () => {
  // 22:00-06:00 UTC, Fri+Sat only. 2026-01-02 is a Friday.
  const night = rule({ activeHours: { start: "22:00", end: "06:00", daysOfWeek: ["fri", "sat"], timezone: "UTC" } });
  const e = { kind: "evt.teamkill" };
  assert.equal(matchesRule(night, e, new Date("2026-01-02T23:30:00Z")), true, "Friday night, inside");
  assert.equal(matchesRule(night, e, new Date("2026-01-03T05:59:00Z")), true, "the overnight wrap reaches Saturday morning");
  assert.equal(matchesRule(night, e, new Date("2026-01-02T12:00:00Z")), false, "Friday noon is outside the window");
  assert.equal(matchesRule(night, e, new Date("2026-01-05T23:30:00Z")), false, "Monday night is the right hour on the wrong day");
  // The timezone is the window's, not the server's: 23:30 UTC is 18:30 in New York — outside.
  const nyNight = rule({ activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York" } });
  assert.equal(matchesRule(nyNight, e, new Date("2026-01-02T23:30:00Z")), false);
  assert.equal(matchesRule(nyNight, e, new Date("2026-01-03T03:30:00Z")), true, "22:30 in New York");
  // No window = always, exactly as before.
  assert.equal(matchesRule(rule(), e, new Date("2026-01-02T12:00:00Z")), true);
});

/*
 * The circuit breaker: a rule that ACTS on more than its safety limit of distinct players inside
 * a minute disables itself instead of finishing the job a typo started.
 */
test("the breaker trips at the limit: the next player is spared, the rule disables itself and audits why", async () => {
  const { repo } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const r = await repo.enforcerRules.create({ serverId: server.id, name: "typo rule", eventKind: "evt.kill", action: "punish", breakerLimit: 2 });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, _a: string, params: Record<string, unknown>) => void calls.push(String(params.playerId)) });
  await enf.refresh();
  for (let i = 1; i <= 4; i++) {
    const pl = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656119811111100${i}`, name: `P${i}` });
    await enf.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: pl.id, actorName: pl.name });
  }
  assert.equal(calls.length, 2, "exactly the limit acted on — the third distinct player trips the valve instead");
  const after = await repo.enforcerRules.get(r.id);
  assert.equal(after?.enabled, false, "the rule disabled itself");
  const audit = await repo.audit.list({ action: "rule.breaker" });
  assert.equal(audit.length, 1);
  assert.match(audit[0]!.summary, /DISABLED ITSELF/);
  assert.equal((audit[0]!.data as { ruleId?: string }).ruleId, r.id, "the trip is filed under the rule for the history view");
});

test("the breaker never counts dry-runs — a trial rule can rehearse on the whole server", async () => {
  const { repo } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const r = await repo.enforcerRules.create({ serverId: server.id, name: "trial", eventKind: "evt.kill", action: "punish", breakerLimit: 2, dryRun: true });
  const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {} });
  await enf.refresh();
  for (let i = 1; i <= 5; i++) {
    const pl = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `7656119822222200${i}`, name: `P${i}` });
    await enf.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: pl.id, actorName: pl.name });
  }
  assert.equal((await repo.enforcerRules.get(r.id))?.enabled, true, "rehearsals are not blast radius");
});

/*
 * Population bounds on EVENT rules, judged from the roster snapshot the worker records: inside
 * fires, outside holds, and an unknown count holds rather than guesses. (State rules arrive
 * pre-judged by the worker against the live roster.)
 */
test("population bounds gate event rules by the latest snapshot; an unknown count holds fire", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "full-only", eventKind: "evt.teamkill", action: "kick", playersMin: 40 });

  const calls: string[] = [];
  const mkEnforcer = () => new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow) => void calls.push(s.id) });

  // No snapshot at all → unknown → hold fire.
  let enf = mkEnforcer(); await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "G" });
  assert.equal(calls.length, 0, "an unknown count never fires a bounded rule");

  // A seeding-sized server → below the floor → hold. Fresh enforcer per step: the count is cached.
  await repo.rosterSnapshots.record({ serverId: server.id, ts: new Date(Date.now() - 60_000).toISOString(), playerCount: 12, composition: {} });
  enf = mkEnforcer(); await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "G" });
  assert.equal(calls.length, 0, "12 players is below the 40 floor");

  // A full server → fires.
  await repo.rosterSnapshots.record({ serverId: server.id, ts: new Date().toISOString(), playerCount: 80, composition: {} });
  enf = mkEnforcer(); await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "G" });
  assert.deepEqual(calls, [server.id]);
});

/*
 * Being spared by the breaker must not cost the spared player anything.
 *
 * The ladder used to advance before the breaker gate, so the one player the valve exists to
 * protect came out of it a rung higher than they went in — and met the step above the one they
 * never received as soon as staff fixed the rule and switched it back on.
 */
test("the player the breaker spares does not climb the ladder for it", async () => {
  const { repo } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const rule = await repo.enforcerRules.create({
    serverId: server.id, name: "spared ladder", eventKind: "evt.teamkill", action: "message",
    reason: "no TK (spared)", escalateActions: ["punish", "kick"], escalateResetMinutes: 120,
    breakerLimit: 1, // one distinct player per minute: the SECOND player trips it
  });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => {
    if (String(params.reason ?? "").includes("no TK (spared)")) calls.push(action);
  } });
  await enf.refresh();

  const first = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198333333001", name: "First" });
  const spared = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198333333002", name: "Spared" });
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: first.id, actorName: "First" });
  // The second distinct player fills the valve: they are spared and the rule turns itself off.
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: spared.id, actorName: "Spared" });
  assert.deepEqual(calls, ["message"], "only the first player was acted on");
  assert.equal((await repo.enforcerRules.get(rule.id))?.enabled, false, "the rule disabled itself");

  // Staff review the rule, widen the valve and switch it back on. The spared player's NEXT
  // offence is their first — a message, not the punish above it.
  await repo.enforcerRules.update(rule.id, { enabled: true, breakerLimit: 10 });
  await enf.refresh();
  await enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: spared.id, actorName: "Spared" });
  assert.deepEqual(calls, ["message", "message"], "the spared player starts at the bottom, where they were left");
});

test("presence actions hold fire on a player the removal memory says is gone — until they reconnect", async () => {
  const { repo, player } = await seed();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  await repo.enforcerRules.create({ serverId: server.id, name: "TK warn", eventKind: "evt.teamkill", action: "message", reason: "stop it" });

  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  const tk = { kind: "evt.teamkill", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" };

  // Reachable: the warning goes out.
  await enf.onEvent(tk);
  assert.deepEqual(calls, ["message"]);

  // The game reports them banned — and the TK burst logged BEFORE the removal keeps arriving for
  // a few more polls. Every one of these used to fire messagePlayer at an empty seat, which read
  // as the bot hammering a player it had already banned.
  await enf.onEvent({ kind: "evt.player.banned", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  await enf.onEvent({ ...tk, victimName: "A" });
  await enf.onEvent({ ...tk, victimName: "B" });
  assert.deepEqual(calls, ["message"], "nobody is there to message");

  // They come back (a kick served, a ban lifted): reachable again at once, not after the TTL.
  await enf.onEvent({ kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Griefer" });
  await enf.onEvent({ ...tk, victimName: "C" });
  assert.deepEqual(calls, ["message", "message"]);
});

test("a vote-ballot chat line never matches a chat rule — voting is not spam", () => {
  /*
   * The in-game map vote asks players to type a bare number in team or unit chat, and the
   * community's spam rule ("Team chat message ×2 within 60s → message, then kick") was counting
   * those lines: cast "2", change your mind to "3", get warned for voting. Ballot-shaped lines
   * are exempt AT THE GATE — they neither fire a chat rule nor count toward its threshold — for
   * every rule that exists and every rule written later. The shape is parseVoteBallot, the same
   * parser the vote counter uses, so what the vote solicits and what rules ignore cannot fork.
   */
  const chatRule = rule({ eventKind: "evt.chat.team" });
  const ev = (message: string, kind = "evt.chat.team") => ({ kind, actorPlayerId: "p1", actorName: "Voter", data: { message } });

  // Every shape the vote counter accepts is exempt.
  for (const ballot of ["2", " 2 ", "!3", "3.", "12", "!10."]) {
    assert.equal(matchesRule(chatRule, ev(ballot)), false, `"${ballot}" is a ballot, not chat traffic`);
  }
  assert.equal(matchesRule(rule({ eventKind: "evt.chat.squad" }), ev("2", "evt.chat.squad")), false, "unit chat votes too");

  // Conversation still counts — including numbers embedded in sentences and 3+ digits.
  for (const talk of ["3 tanks on E5", "hello", "1944", "vote 2", "222"]) {
    assert.equal(matchesRule(chatRule, ev(talk)), true, `"${talk}" is conversation and still matches`);
  }

  // A rule whose own regex targets numbers cannot reach a ballot either — "entirely" means
  // no future rule can opt back in by accident.
  assert.equal(matchesRule(rule({ eventKind: "evt.chat.team", match: "^\\d+$" }), ev("2")), false);

  // Non-chat kinds are untouched by the exemption.
  assert.equal(matchesRule(rule({ eventKind: "evt.teamkill" }), { kind: "evt.teamkill", data: { message: "2" } }), true);
});

test("a rule's message leaves {constructor}/{__proto__} as typed — an attacker's name cannot pull in JS internals", () => {
  const out = applyRuleVars("{constructor} {__proto__} killed by {attacker_name}", { actorName: "{constructor}" } as never, "Victim");
  assert.equal(out, "{constructor} {__proto__} killed by {constructor}");
});
