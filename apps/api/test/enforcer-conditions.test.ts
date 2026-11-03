/**
 * Conditions every rule can carry: a window of minutes into the match, a threshold counted per
 * match, an "only players tagged" gate, and a per-player cap on how often it fires.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";
import type { ServerRow } from "@app/db";
import { Enforcer } from "../dist/enforcer.js";

const stubBus = { on: () => () => {}, emit: () => {}, close: async () => {} } as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// Unique ids per call: against Postgres every test in the file shares one database.
let seq = 0;
async function scene(rule: Record<string, unknown>) {
  const repo = await createRepository();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const r = await repo.enforcerRules.create({ serverId: server.id, name: "R", eventKind: "evt.teamkill", action: "message", reason: "stop", ...rule } as any);
  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string) => void calls.push(action) });
  await enf.refresh();
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611970000${String(++seq).padStart(5, "0")}`, name: `P${seq}` });
  const tk = (p = player) => enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: p.id, actorName: p.name });
  return { repo, server, rule: r, enf, calls, player, tk };
}

test("match window: fires inside the minutes asked for, holds outside them — and with no known match", async () => {
  const early = await scene({ matchMinutesMax: 10 });
  await early.tk();
  assert.equal(early.calls.length, 0, "no open match: the window cannot be judged, so it holds fire");

  await early.repo.matches.open({ serverId: early.server.id, map: "foy", startedAt: minutesAgo(4) });
  await early.enf.onEvent({ kind: "evt.match.started", serverId: early.server.id });
  await early.tk();
  assert.deepEqual(early.calls, ["message"], "4 minutes in: inside 'the first 10 minutes'");

  const late = await scene({ matchMinutesMin: 5, matchMinutesMax: 30 });
  await late.repo.matches.open({ serverId: late.server.id, map: "foy", startedAt: minutesAgo(45) });
  await late.tk();
  assert.equal(late.calls.length, 0, "45 minutes in: past the window");
});

test("per-match counting: '2 team kills in one match' forgets the last match's kills", async () => {
  const { repo, server, enf, calls, tk } = await scene({ threshold: 2, windowSec: 0, countPerMatch: true });
  await repo.matches.open({ serverId: server.id, map: "foy", startedAt: minutesAgo(30) });
  await tk();
  assert.equal(calls.length, 0, "one so far");
  await sleep(5);
  // A new match starts: the kill from the last one no longer counts.
  await repo.matches.open({ serverId: server.id, map: "carentan", startedAt: new Date().toISOString() });
  await enf.onEvent({ kind: "evt.match.started", serverId: server.id });
  await tk();
  assert.equal(calls.length, 0, "the earlier kill was last match's");
  await tk();
  assert.deepEqual(calls, ["message"], "two in this match");
});

test("per-match counting survives the rule refresh between hits — the window is the match, not windowSec", async () => {
  // The refresh timer prunes threshold windows by the rule's window. A per-match rule's windowSec
  // is 0, so it used to empty the count every refresh: "twice in one match" never reached two
  // unless both landed between two refreshes.
  const { repo, server, enf, calls, tk } = await scene({ threshold: 2, windowSec: 0, countPerMatch: true });
  await repo.matches.open({ serverId: server.id, map: "foy", startedAt: minutesAgo(30) });
  await tk();
  await sleep(5);
  await enf.refresh();
  await tk();
  assert.deepEqual(calls, ["message"], "the first hit was still counted after the refresh");
});

test("a community-wide per-match count is each server's own: a hit in another server's match is no part of this one's", async () => {
  // A community-wide rule hears every server, and the same player can play two servers' rounds an
  // hour apart. "Twice in one match" means one match — not one here and one there, both inside the
  // later match's window.
  const repo = await createRepository();
  const a = await repo.servers.create({ name: "A", host: "h", port: 1, password: "x" });
  const b = await repo.servers.create({ name: "B", host: "h", port: 2, password: "x" });
  for (const s of [a, b]) {
    await repo.servers.setEngagementMode(s.id, "active");
    await repo.matches.open({ serverId: s.id, map: "foy", startedAt: minutesAgo(30) });
  }
  await repo.enforcerRules.create({ serverId: null, name: "R", eventKind: "evt.teamkill", action: "message", reason: "stop", threshold: 2, windowSec: 0, countPerMatch: true } as any);
  const calls: string[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (s: ServerRow, action: string) => void calls.push(`${s.name}:${action}`) });
  await enf.refresh();
  const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611970000${String(++seq).padStart(5, "0")}`, name: `P${seq}` });
  const tk = (s: ServerRow) => enf.onEvent({ kind: "evt.teamkill", serverId: s.id, actorPlayerId: p.id, actorName: p.name });
  await tk(a);
  await tk(b);
  assert.deepEqual(calls, [], "one in each server's match — neither match has two");
  await tk(b);
  assert.deepEqual(calls, ["B:message"], "the second in B's match");
});

test("a side-swap rule: the second swap in the match messages, a drop to Unassigned and back is no swap", async () => {
  const { repo, server, enf, calls, player } = await scene({ eventKind: "evt.player.teamSwitched", match: "switched sides", threshold: 2, windowSec: 0, countPerMatch: true });
  await repo.matches.open({ serverId: server.id, map: "foy", startedAt: minutesAgo(10) });
  const sw = (data: Record<string, unknown>) => enf.onEvent({ kind: "evt.player.teamSwitched", serverId: server.id, actorPlayerId: player.id, actorName: player.name, data });
  await sw({ from: "None", to: "Allies", change: "joined Allies" });
  await sw({ from: "Allies", to: "None", change: "left Allies" });
  await sw({ from: "None", to: "Allies", change: "joined Allies" });
  await sw({ from: "Allies", to: "None", change: "left Allies" });
  await sw({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" });
  assert.equal(calls.length, 0, "one swap so far; joins and leaves never matched");
  await sleep(5);
  await enf.refresh();
  await sw({ from: "Axis", to: "None", change: "left Axis" });
  await sw({ from: "None", to: "Allies", swapFrom: "Axis", swapCount: 2, change: "switched sides Axis → Allies" });
  assert.deepEqual(calls, ["message"], "the second swap this match");
});

test("a team-switch rule with no match counts the side swaps alone — drops to Unassigned and joins never add up", async () => {
  const { repo, server, enf, calls, player } = await scene({ eventKind: "evt.player.teamSwitched", match: "", threshold: 2, windowSec: 0, countPerMatch: true });
  await repo.matches.open({ serverId: server.id, map: "foy", startedAt: minutesAgo(10) });
  const sw = (data: Record<string, unknown>) => enf.onEvent({ kind: "evt.player.teamSwitched", serverId: server.id, actorPlayerId: player.id, actorName: player.name, data });
  await sw({ from: "None", to: "Allies", change: "joined Allies" });
  await sw({ from: "Allies", to: "None", change: "left Allies" });
  await sw({ from: "None", to: "Allies", change: "joined Allies" });
  await sw({ from: "Allies", to: "None", change: "left Allies" });
  assert.deepEqual(calls, [], "a connect, two drops to Unassigned and a return to the same side: no switch of team");
  await sw({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1, change: "switched sides Allies → Axis" });
  assert.deepEqual(calls, [], "one swap");
  await sw({ from: "Axis", to: "None", change: "left Axis" });
  await sw({ from: "None", to: "Allies", swapFrom: "Axis", swapCount: 2, change: "switched sides Axis → Allies" });
  assert.deepEqual(calls, ["message"], "the second swap this match");
});

test("a stored team-switch rule that moves the player is held — its own move would set it off again", async () => {
  const { server, enf, calls, player } = await scene({ eventKind: "evt.player.teamSwitched", action: "switch", match: "" });
  await enf.onEvent({ kind: "evt.player.teamSwitched", serverId: server.id, actorPlayerId: player.id, actorName: player.name, data: { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 } });
  assert.deepEqual(calls, [], "never moved");
  // A ladder that moves anywhere is held whole — visibly broken, rather than messaging once and
  // then stalling on a rung it can never take.
  const ladder = await scene({ eventKind: "evt.player.teamSwitched", action: "message", escalateActions: ["switch"], match: "" });
  const sw = () => ladder.enf.onEvent({ kind: "evt.player.teamSwitched", serverId: ladder.server.id, actorPlayerId: ladder.player.id, actorName: ladder.player.name, data: { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 } });
  await sw();
  await sw();
  assert.deepEqual(ladder.calls, []);
});

test("a section switched off holds its rules without writing their own switches; back on, they fire again", async () => {
  const { repo, rule, enf, calls, tk } = await scene({});
  const sec = await repo.ruleSections.create(`Section ${++seq}`);
  await repo.enforcerRules.setSection([rule.id], sec.id);
  await repo.ruleSections.setEnabled(sec.id, false);
  await enf.refresh();
  await tk();
  assert.deepEqual(calls, [], "held by its section");
  assert.equal((await repo.enforcerRules.get(rule.id))?.enabled, true, "the rule's own switch was never written");
  await repo.ruleSections.setEnabled(sec.id, true);
  await enf.refresh();
  await tk();
  assert.deepEqual(calls, ["message"], "back on with its section");
});

test("a paused rule holds fire until the pause ends or is lifted — its own switch never written", async () => {
  const { repo, rule, enf, calls, tk } = await scene({});
  await repo.enforcerRules.setPause(rule.id, { until: new Date(Date.now() + 30 * 60_000).toISOString(), reason: "event", by: "staff" });
  await enf.refresh();
  await tk();
  assert.deepEqual(calls, [], "paused");
  assert.equal((await repo.enforcerRules.get(rule.id))?.enabled, true);
  await repo.enforcerRules.setPause(rule.id, null);
  await enf.refresh();
  await tk();
  assert.deepEqual(calls, ["message"], "lifted: it fires again");
});

test("tag gate: only players carrying a listed tag; an exemption tag still wins its own way", async () => {
  const { repo, calls, tk, player } = await scene({ requireTags: ["watch"] });
  await tk();
  assert.equal(calls.length, 0, "untagged: not this rule's business");
  await repo.playerTags.add({ playerId: player.id, label: "watch", createdByName: "admin" });
  await tk();
  assert.deepEqual(calls, ["message"]);
});

test("per-player cap: at most N per period, counted from the trail, and a same-instant burst cannot slip past", async () => {
  const { repo, rule, calls, tk, player, enf } = await scene({ capCount: 1, capPeriod: "day" });
  await Promise.all([tk(), tk(), tk()]);
  assert.deepEqual(calls, ["message"], "three at once, one firing");
  await tk();
  assert.equal(calls.length, 1, "still one today");
  // Another player has their own allowance.
  const other = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611970000${String(++seq).padStart(5, "0")}`, name: "Other" });
  await tk(other);
  assert.equal(calls.length, 2);
  // A restarted enforcer reads the same trail — nobody's allowance resets.
  const again: string[] = [];
  const enf2 = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, a: string) => void again.push(a) });
  await enf2.refresh();
  await enf2.onEvent({ kind: "evt.teamkill", serverId: rule.serverId!, actorPlayerId: player.id, actorName: player.name });
  assert.equal(again.length, 0, "the restart forgave nobody");
  assert.equal(await repo.enforcerRules.firingCount(rule.id, player.id, null, false), 1);
  void enf;
});

test("per-player cap on a trial run counts trial firings, not real ones", async () => {
  const { repo, rule, calls, tk, player } = await scene({ capCount: 2, capPeriod: "ever", dryRun: true });
  await tk(); await tk(); await tk();
  assert.equal(calls.length, 0, "a trial touches nobody");
  assert.equal(await repo.enforcerRules.firingCount(rule.id, player.id, null, true), 2, "the trial stops where the real rule would");
});

test("per-player cap per match: a new match is a new allowance", async () => {
  const { repo, server, enf, calls, tk } = await scene({ capCount: 1, capPeriod: "match" });
  await repo.matches.open({ serverId: server.id, map: "foy", startedAt: minutesAgo(20) });
  await tk(); await tk();
  assert.equal(calls.length, 1);
  await sleep(5);
  await repo.matches.open({ serverId: server.id, map: "carentan", startedAt: new Date().toISOString() });
  await enf.onEvent({ kind: "evt.match.started", serverId: server.id });
  await tk();
  assert.equal(calls.length, 2, "the next match gets its own");
});
