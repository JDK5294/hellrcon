/**
 * The "player has no VIP" roster trigger on the enforcer's side: VIP for somebody who is HERE.
 * The worker decides who lacks VIP; the enforcer is the last gate before a grant, and a grant is
 * something players pay for — so it re-checks the game's own list, never shortens, never trips
 * the breaker on a full server of newcomers, and sends the rule's message only after the grant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";
import type { ServerRow } from "@app/db";
import { Enforcer } from "../dist/enforcer.js";

const stubBus = { on: () => () => {}, emit: () => {}, close: async () => {} } as any;
const NO_VIP = "app.state.no_vip";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Roster-trigger writes ride a paced per-server chain; these tests fire bursts and must not
// spend real seconds breathing between stub calls. The pacing test sets its own gap and restores this.
process.env.RULE_CROWD_PACE_MS = "0";

// Unique ids per call: against Postgres every test in the file shares one database.
let seq = 0;
async function scene(opts: { rule?: Record<string, unknown>; gameVips?: () => Set<string> | null } = {}) {
  const repo = await createRepository();
  const server = await repo.servers.create({ name: "s", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const rule = await repo.enforcerRules.create({
    serverId: server.id, name: "Welcome VIP", eventKind: NO_VIP, action: "vip", vipMinutes: 1440,
    vipCooldownMinutes: 30 * 1440, windowSec: 1800, params: { minMinutesOnline: 0 }, ...opts.rule,
  } as any);
  const calls: { action: string; params: Record<string, unknown>; at: number }[] = [];
  let listReads = 0;
  const enf = new Enforcer({
    repo, bus: stubBus,
    execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ action, params, at: Date.now() }),
    readGameVipIds: async () => { listReads++; return opts.gameVips ? opts.gameVips() : new Set<string>(); },
  });
  await enf.refresh();
  const newPlayer = async () => repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611990000${String(++seq).padStart(5, "0")}`, name: `New${seq}` });
  const fire = async (p: { id: string; name: string }) =>
    enf.onEvent({ kind: NO_VIP, serverId: server.id, actorPlayerId: p.id, actorName: p.name, data: { ruleId: rule.id, violation: "you don't have VIP" } });
  return { repo, server, rule, enf, calls, fire, newPlayer, reads: () => listReads };
}

test("no-VIP rule: a player here without VIP is granted it, recorded as a real dated grant", async () => {
  const { repo, server, calls, fire, newPlayer } = await scene();
  const p = await newPlayer();
  await fire(p);
  assert.deepEqual(calls.map((c) => c.action), ["vip"], "no message configured, none sent");
  const grant = await repo.vips.get(server.id, p.platformId);
  assert.ok(grant?.expiration, "dated — never permanent");
  const hours = (Date.parse(grant!.expiration!) - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24, `a day, as configured (got ${hours.toFixed(2)}h)`);
  assert.match(grant!.comment ?? "", /VIP from rule "Welcome VIP"/);
  const row = (await repo.audit.list({ actions: ["enforcer.vip"] }))[0];
  assert.equal((row?.data as { eventKind?: string })?.eventKind, NO_VIP);
});

test("no-VIP rule: the optional message goes out AFTER the grant, and reads the VIP just given", async () => {
  const { repo, calls, fire, newPlayer } = await scene({ rule: { reason: "Welcome! VIP for {vip_remaining}" } });
  const p = await newPlayer();
  await fire(p);
  assert.deepEqual(calls.map((c) => c.action), ["vip", "message"]);
  const msg = String(calls[1]!.params.message ?? "");
  assert.match(msg, /^Welcome! VIP for /);
  assert.doesNotMatch(msg, /no VIP|\{vip_remaining\}/, "rendered against the grant that just landed");
  const row = (await repo.audit.list({ actions: ["enforcer.vip"] }))[0];
  assert.equal((row?.data as { messaged?: boolean })?.messaged, true);
});

test("no-VIP rule: VIP on the game's own list with no row of ours is left alone — a dated row over it would hand it to the sweep", async () => {
  const listed = new Set<string>();
  const { repo, server, calls, fire, newPlayer } = await scene({ gameVips: () => listed });
  const p = await newPlayer();
  listed.add(p.platformId);
  await fire(p);
  assert.equal(calls.length, 0);
  assert.equal(await repo.vips.get(server.id, p.platformId), null, "nothing written");
});

test("no-VIP rule: a game VIP list that cannot be read grants nothing", async () => {
  const { calls, fire, newPlayer } = await scene({ gameVips: () => null });
  await fire(await newPlayer());
  assert.equal(calls.length, 0);
});

test("no-VIP rule: VIP they already hold is never shortened — permanent, longer, or paused", async () => {
  const { repo, server, calls, fire, newPlayer } = await scene();
  const perm = await newPlayer(), longer = await newPlayer(), paused = await newPlayer();
  const base = { serverId: server.id, createdByUserId: null, createdByName: "admin" };
  await repo.vips.upsert({ ...base, playerId: perm.platformId, playerName: perm.name, comment: "paid", expiration: null });
  await repo.vips.upsert({ ...base, playerId: longer.platformId, playerName: longer.name, comment: "paid", expiration: new Date(Date.now() + 5 * 86_400_000).toISOString() });
  // Paused, with LESS time left than the rule gives: the pause is a punishment in progress, and a
  // rule for players "without" VIP must not be the way around it.
  await repo.vips.upsert({ ...base, playerId: paused.platformId, playerName: paused.name, comment: "paid", expiration: new Date(Date.now() + 3_600_000).toISOString() });
  await repo.vips.setPause(server.id, paused.platformId, { until: new Date(Date.now() + 86_400_000).toISOString(), reason: "timeout", by: "admin" });
  for (const p of [perm, longer, paused]) await fire(p);
  assert.equal(calls.length, 0);
  assert.equal((await repo.vips.get(server.id, perm.platformId))!.expiration, null, "the permanent is still permanent");
});

test("no-VIP rule: a whole server of newcomers does not trip the breaker — a grant only ever adds", async () => {
  const { repo, rule, calls, fire, newPlayer, reads } = await scene({ rule: { breakerLimit: 2 } });
  for (let i = 0; i < 6; i++) await fire(await newPlayer());
  assert.equal(calls.filter((c) => c.action === "vip").length, 6);
  assert.equal((await repo.enforcerRules.get(rule.id))!.enabled, true, "still on");
  assert.equal(reads(), 1, "one read of the game's VIP list served the whole burst");
});

test("no-VIP rule: a crowd's grants go to the game one at a time with a breath between writes", async () => {
  // Roster triggers fire for a whole server at once; each game write opens its own connection.
  // The paced chain keeps a burst from being a burst — every write after the first waits the gap.
  process.env.RULE_CROWD_PACE_MS = "60";
  try {
    const { calls, fire, newPlayer } = await scene();
    const players = [await newPlayer(), await newPlayer(), await newPlayer()];
    await Promise.all(players.map((p) => fire(p)));
    const at = calls.filter((c) => c.action === "vip").map((c) => c.at);
    assert.equal(at.length, 3, "every newcomer still got their grant");
    for (let i = 1; i < at.length; i++) {
      assert.ok(at[i]! - at[i - 1]! >= 50, `write ${i + 1} waited out the gap (came ${at[i]! - at[i - 1]!}ms after the last)`);
    }
  } finally {
    process.env.RULE_CROWD_PACE_MS = "0";
  }
});

test("no-VIP rule: once granted, the cooldown holds even after the VIP runs out", async () => {
  const { repo, server, calls, fire, newPlayer } = await scene();
  const p = await newPlayer();
  await fire(p);
  await repo.vips.upsert({ serverId: server.id, playerId: p.platformId, playerName: p.name, comment: "spent", expiration: new Date(Date.now() - 1000).toISOString(), createdByUserId: null, createdByName: "enforcer" });
  await fire(p);
  assert.equal(calls.length, 1, "30-day cooldown: not again this month");
});

test("no-VIP rule with a delay: being on the server is the point — the grant lands for a player still here", async () => {
  const { repo, server, calls, fire, newPlayer, enf } = await scene({ rule: { delaySec: 1 } });
  const p = await newPlayer();
  await repo.sessions.open(p.id, server.id, new Date().toISOString());
  await fire(p);
  await sleep(1300);
  assert.deepEqual(calls.map((c) => c.action), ["vip"], "a crash VIP would hold fire here; this one must not");
  await enf.stop();
});

test("no-VIP rule with a delay: a player who left during the wait is not granted", async () => {
  const { repo, server, calls, fire, newPlayer, enf } = await scene({ rule: { delaySec: 1 } });
  const p = await newPlayer();
  await repo.sessions.open(p.id, server.id, new Date().toISOString());
  await fire(p);
  await repo.sessions.close(p.id, server.id, new Date().toISOString());
  await sleep(1300);
  assert.equal(calls.length, 0, "gone before the grant — they did not stay, and the message would reach nobody");
  await enf.stop();
});

test("a held-back grant says why on the rule's status — the game list unreadable, or VIP set outside the panel", async () => {
  const blind = await scene({ gameVips: () => null });
  await blind.fire(await blind.newPlayer());
  const st = (await blind.repo.enforcerRules.statuses()).find((x) => x.ruleId === blind.rule.id);
  assert.match(st?.skipReason ?? "", /game's VIP list couldn't be read/);

  const listed = new Set<string>();
  const outside = await scene({ gameVips: () => listed });
  const p = await outside.newPlayer();
  listed.add(p.platformId);
  await outside.fire(p);
  const st2 = (await outside.repo.enforcerRules.statuses()).find((x) => x.ruleId === outside.rule.id);
  assert.match(st2?.skipReason ?? "", /already VIP on the game's own list/);
  assert.equal(st2?.skipPlayer, p.name);
});
