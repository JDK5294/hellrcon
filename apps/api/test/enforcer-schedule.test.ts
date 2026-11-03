/**
 * The schedule trigger: a rule on the calendar ("the 1st of every month at 00:00") that acts on
 * every member of a group — grant VIP, take timed VIP away, or cut it back.
 *
 * What a community counts on: each occurrence runs ONCE (a restart, a second API process or a
 * second look at the clock never repeats a grant); one missed while the panel was down runs when
 * it is back, and only the latest; saving a rule never fires a moment already gone; and only
 * timed VIP is ever touched — permanent VIP, VIP a group perk holds, and VIP the game lists that
 * the panel never granted are left exactly as they are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsolatedRepository, type Repository, type RuleRow, type ServerRow } from "@app/db";
import { Enforcer } from "../dist/enforcer.js";
import { auditVipIntegrity } from "../dist/vip-integrity.js";
import { withServer, jf, askedFor } from "./harness.ts";

process.env.RULE_CROWD_PACE_MS = "0";
const stubBus = { on: () => () => {}, emit: () => {}, close: async () => {} } as any;
const DAY = 86_400_000;
const A = "76561199200000001"; // never seen, Steam64: a WW2 player
const B = "76561199200000002"; // ten days of timed VIP
const C = "76561199200000003"; // permanent VIP of their own
const D = "76561199200000004"; // held by a group perk
const E = "0123456789abcdef0123456789abcde1"; // seen on Vietnam
const F = "fedcba9876543210fedcba9876543211"; // a console id nobody has seen

/** 01:00 UTC on the 1st of the month `ahead` months after now — after any rule saved today. */
function firstOf(ahead: number, day = 1): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + ahead, day, 1, 0));
}

async function scene(fn: (s: {
  repo: Repository; enf: Enforcer; ww2: ServerRow; vn: ServerRow;
  calls: { serverId: string; action: string; playerId: unknown }[];
  group: { id: string; name: string };
  rule: (action: string, extra?: Record<string, unknown>) => Promise<RuleRow>;
}) => Promise<void>, opts: { gameVips?: Set<string>; bus?: unknown } = {}) {
  const { repo, cleanup } = await createIsolatedRepository();
  try {
    const ww2 = await repo.servers.create({ name: "WW2 #1", game: "hll", host: "10.0.0.1", port: 1, password: "x", engagementMode: "active" });
    const vn = await repo.servers.create({ name: "Vietnam #1", game: "hllv", host: "10.0.0.2", port: 1, password: "x", engagementMode: "active" });
    const group = await repo.playerGroups.create({ name: "WW2 CVC", createdByName: "staff" });
    for (const id of [A, B, C, D, E, F]) await repo.playerGroups.addMember({ groupId: group.id, playerId: id, playerName: `P${id.slice(-1)}`, addedByName: "staff" });
    await repo.playerGroups.ackEvents((await repo.playerGroups.takeEvents(100)).map((e) => e.id));
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: E, name: "Viet" });
    await repo.vips.upsert({ serverId: ww2.id, playerId: B, playerName: "PB", expiration: new Date(Date.now() + 10 * DAY).toISOString(), createdByName: "staff" });
    await repo.vips.upsert({ serverId: ww2.id, playerId: C, playerName: "PC", expiration: null, createdByName: "staff" });
    await repo.vips.startGroupHold({ serverId: ww2.id, playerId: D, playerName: "PD", groups: [{ id: "g-perk", name: "Streamers", severanceMinutes: 0 }], createdByName: "group perks" });
    const calls: { serverId: string; action: string; playerId: unknown }[] = [];
    const enf = new Enforcer({
      repo, bus: (opts.bus ?? stubBus) as typeof stubBus,
      execute: async (server: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ serverId: server.id, action, playerId: params.playerId }),
      readGameVipIds: async () => opts.gameVips ?? new Set<string>(),
    });
    const rule = async (action: string, extra: Record<string, unknown> = {}) => {
      const r = await repo.enforcerRules.create({ serverId: null, name: `Monthly ${action}`, eventKind: "app.schedule", action, vipMinutes: 30 * 1440, params: { groupId: group.id, repeat: "monthly", monthDay: 1, time: "00:00", stack: true }, ...extra } as any);
      await enf.refresh();
      return r;
    };
    await fn({ repo, enf, ww2, vn, calls, group, rule });
  } finally {
    await cleanup();
  }
}

test("a monthly grant: once per month, timed VIP only, each member at their own game's servers", async () => {
  await scene(async ({ repo, enf, ww2, vn, calls, rule }) => {
    await rule("vip");
    const at = firstOf(1);
    await enf.runSchedules(at);
    const got = (pid: string) => calls.filter((c) => c.action === "vip" && c.playerId === pid).map((c) => c.serverId);
    assert.deepEqual(got(A), [ww2.id], "a Steam64 never seen is a WW2 player");
    assert.deepEqual(got(B), [ww2.id]);
    assert.deepEqual(got(E), [vn.id], "the directory places the console id in Vietnam");
    for (const pid of [C, D, F]) assert.deepEqual(got(pid), [], `${pid} is left alone`);
    const b = await repo.vips.get(ww2.id, B);
    assert.ok(Math.abs(Date.parse(b!.expiration!) - (Date.now() + 40 * DAY)) < 60_000, "stacked: ten days plus thirty");
    assert.equal((await repo.vips.get(ww2.id, C))!.expiration, null, "permanent stays permanent");
    assert.ok((await repo.vips.get(ww2.id, D))!.groupHold, "the perk's hold is untouched");

    const run = (await repo.audit.list({ actions: ["enforcer.schedule"] }))[0]!;
    const data = run.data as { players: number; members: number; skipped: { playerId: string; why: string }[]; occurrence: string };
    assert.equal(data.players, 3);
    assert.equal(data.members, 6);
    assert.match(data.skipped.find((x) => x.playerId === C)!.why, /permanent VIP/);
    assert.match(data.skipped.find((x) => x.playerId === D)!.why, /group "Streamers"/);
    assert.match(data.skipped.find((x) => x.playerId === F)!.why, /hasn't been seen/);
    assert.match(run.summary, /granted VIP to 3 of 6 members of "WW2 CVC"/);

    // Once: the same moment looked at again, later the same month, or by a second engine.
    calls.length = 0;
    await enf.runSchedules(at);
    await enf.runSchedules(new Date(at.getTime() + 10 * DAY));
    const twin = new Enforcer({ repo, bus: stubBus, execute: async () => void calls.push({ serverId: "twin", action: "vip", playerId: null }), readGameVipIds: async () => new Set() });
    await twin.refresh();
    await twin.runSchedules(at);
    assert.equal(calls.length, 0, "an occurrence runs once, however many look at the clock");
  });
});

test("catch-up runs the latest missed occurrence once; a moment that passed before the rule was saved never runs", async () => {
  await scene(async ({ repo, enf, calls, rule }) => {
    await rule("vip");
    // Saved today: this month's 1st has already gone by.
    await enf.runSchedules(new Date());
    assert.equal(calls.length, 0, "saving a rule never fires a moment already gone");
    // Down from before the 1st of next month until the 5th of the month after: one run, not two.
    await enf.runSchedules(firstOf(2, 5));
    assert.ok(calls.length > 0, "back up: the latest occurrence runs");
    const runs = await repo.audit.list({ actions: ["enforcer.schedule"] });
    assert.equal(runs.length, 1, "only the latest — a missed month is not paid out with it");
  });
});

test("a schedule whose section is off when it comes round skips that date — switching the section back on never runs it late", async () => {
  await scene(async ({ repo, enf, calls, rule }) => {
    const r = await rule("vip");
    const sec = await repo.ruleSections.create("Monthly perks");
    await repo.enforcerRules.setSection([r.id], sec.id);
    await repo.ruleSections.setEnabled(sec.id, false);
    await enf.refresh();
    const at = firstOf(1);
    await enf.runSchedules(at);
    assert.equal(calls.length, 0, "held: nobody granted");
    const skips = await repo.audit.list({ actions: ["rule.schedule.skipped"] });
    assert.equal(skips.length, 1, "the skipped date is on the record");
    assert.match(skips[0]!.summary, /section .* switched off/);
    assert.equal((await repo.audit.list({ actions: ["enforcer.schedule"] })).length, 0, "and it fired on no one");
    // Back on later that month: the date it was held through stays skipped, and is noted once.
    await repo.ruleSections.setEnabled(sec.id, true);
    await enf.refresh();
    await enf.runSchedules(new Date(at.getTime() + DAY));
    assert.equal(calls.length, 0, "a date it was held through is not run late");
    assert.equal((await repo.audit.list({ actions: ["rule.schedule.skipped"] })).length, 1);
    await enf.runSchedules(firstOf(2));
    assert.ok(calls.length > 0, "the next date runs");
  });
});

test("a schedule paused when it comes round skips that date, says why, and runs again on its next", async () => {
  await scene(async ({ repo, enf, calls, rule }) => {
    const r = await rule("vip");
    const at = firstOf(1);
    await repo.enforcerRules.setPause(r.id, { until: new Date(at.getTime() + 2 * 3_600_000).toISOString(), reason: "event weekend", by: "Ana" });
    await enf.refresh();
    await enf.runSchedules(at);
    assert.equal(calls.length, 0, "paused: nobody granted");
    const skips = await repo.audit.list({ actions: ["rule.schedule.skipped"] });
    assert.equal(skips.length, 1);
    assert.match(skips[0]!.summary, /paused until .* \(event weekend\)/);
    // The pause over, later that month: the date it was paused through is not run late.
    await enf.runSchedules(new Date(at.getTime() + DAY));
    assert.equal(calls.length, 0);
    await enf.runSchedules(firstOf(2));
    assert.ok(calls.length > 0, "the next date runs");
  });
});

test("revoke and cuts move timed VIP only; a cut that uses a grant up removes it; the integrity scan reads them as decisions", async () => {
  await scene(async ({ repo, enf, ww2, calls, rule }) => {
    // A has 2 days, B 10 days (from the scene), C permanent, D held.
    await repo.vips.upsert({ serverId: ww2.id, playerId: A, playerName: "PA", expiration: new Date(Date.now() + 2 * DAY).toISOString(), createdByName: "staff" });
    await rule("viptrim", { vipMinutes: 5 * 1440, name: "Trim to five" });
    await enf.runSchedules(firstOf(1));
    assert.ok(Math.abs(Date.parse((await repo.vips.get(ww2.id, B))!.expiration!) - (Date.now() + 5 * DAY)) < 60_000, "ten days cut back to five");
    assert.ok(Math.abs(Date.parse((await repo.vips.get(ww2.id, A))!.expiration!) - (Date.now() + 2 * DAY)) < 60_000, "two days is already under five");
    assert.equal(calls.length, 0, "a trim with time left only moves our expiry");

    await rule("vipreduce", { vipMinutes: 3 * 1440, name: "Cut by three" });
    await enf.runSchedules(firstOf(1));
    assert.equal(await repo.vips.get(ww2.id, A), null, "two days minus three: used up, removed");
    assert.ok(calls.some((c) => c.action === "vipremove" && c.playerId === A), "and taken off the game");
    assert.ok(Math.abs(Date.parse((await repo.vips.get(ww2.id, B))!.expiration!) - (Date.now() + 2 * DAY)) < 60_000, "five minus three");

    await rule("viprevoke", { name: "Revoke" });
    await enf.runSchedules(firstOf(1));
    assert.equal(await repo.vips.get(ww2.id, B), null, "timed VIP taken away");
    assert.equal((await repo.vips.get(ww2.id, C))!.expiration, null, "permanent VIP never touched");
    assert.ok((await repo.vips.get(ww2.id, D))!.groupHold, "the perk's hold never touched");

    const events = (await repo.audit.list({ limit: 500 })).filter((a) => a.action.startsWith("vip.")).map((a) => ({
      ts: a.ts, action: a.action, automated: a.actorUserId === null, actorName: a.actorName, serverId: a.serverId, targetId: a.targetId, targetName: a.targetName, data: a.data,
    }));
    assert.deepEqual(auditVipIntegrity(events, [{ serverId: ww2.id, playerId: C, playerName: "PC", expiration: null }]), [], "a configured cut is the rule doing as it was told, not damage");
  });
});

test("servers that don't run rules or VIP expiry are skipped whole, the game's own VIP is left alone, and a trial run writes nothing", async () => {
  await scene(async ({ repo, enf, ww2, vn, calls, rule }) => {
    await repo.servers.setAutomation(vn.id, { vipSweep: false });
    await rule("vip", { dryRun: true, name: "Trial" });
    await enf.runSchedules(firstOf(1));
    assert.equal(calls.length, 0, "a trial run touches nobody");
    assert.equal(await repo.vips.get(ww2.id, A), null);
    const run = (await repo.audit.list({ actions: ["enforcer.schedule"] }))[0]!;
    // Only B: A's VIP is the game's own (no grant of ours), and Vietnam is skipped whole.
    assert.match(run.summary, /^\[trial run\] .*would have granted VIP to 1 of 6/);
    assert.match(run.summary, /Vietnam #1 \(the panel doesn't run VIP expiry/);
    const skipped = (run.data as { skipped: { playerId: string; why: string }[] }).skipped;
    assert.match(skipped.find((x) => x.playerId === A)!.why, /game's own list that the panel didn't grant/);
  }, { gameVips: new Set([A]) });
});

test("a schedule's save: only VIP actions, a calendar that comes round, the revoke key for taking — and its group's members take its keys", async () => {
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${(await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) })).body.token as string}` };
    const mk = async (username: string, grants: unknown[]) => {
      const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
      await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants }) });
      return { authorization: `Bearer ${(await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) })).body.token as string}` };
    };
    const g = (capability: string, level = "write") => ({ capability, level, scopeType: "global", scopeId: null });
    const granter = await mk("granter", [g("server.view", "read"), g("admin.moderation"), g("vip.grant"), g("player.groups")]);
    const groupsOnly = await mk("groupsonly2", [g("server.view", "read"), g("player.groups")]);
    const gid = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: `Sched ${Date.now()}` }) })).body.group.id as string;
    const params = { groupId: gid, repeat: "monthly", monthDay: 1, time: "00:00" };
    const save = (h: Record<string, string>, body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: h, body: JSON.stringify({ name: "s", eventKind: "app.schedule", action: "vip", vipMinutes: 1440, params, ...body }) });

    assert.match(JSON.stringify((await save(auth, { action: "message" })).body), /a schedule acts on its group's VIP/);
    assert.match(JSON.stringify((await save(auth, { params: { ...params, monthDay: 0 } })).body), /at least 1|1 to 31/);
    assert.match(JSON.stringify((await save(auth, { params: { ...params, repeat: "weekly", weekdays: "" } })).body), /day of the week/);
    assert.match(JSON.stringify((await save(auth, { params: { ...params, time: "25:00" } })).body), /HH:MM/);
    assert.match(JSON.stringify((await save(auth, { action: "viprevoke", escalateActions: ["note"] })).body), /cannot escalate/);
    // Taking VIP away is a standing revoke: the revoke key, which the grant key is not — asked for.
    const rulesBefore = (await repo.enforcerRules.list()).length;
    const noRevoke = await save(granter, { action: "viptrim" });
    assert.equal((await askedFor(base, auth, noRevoke)).capability, "vip.revoke");
    assert.equal((await repo.enforcerRules.list()).length, rulesBefore, "nothing was saved");
    const ok = await save(granter, { delaySec: 30, requireRoleIds: ["123456789012345678"], activeHours: { start: "10:00", end: "12:00" }, threshold: 3, windowSec: 60 });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const r = ok.body.rule as Record<string, unknown>;
    assert.deepEqual([r.delaySec, r.requireRoleIds, r.activeHours, r.threshold, r.windowSec], [0, [], null, 1, 0], "the group is the selection and the calendar the clock");

    // The monthly grant goes to whoever is listed on the day: adding someone takes the grant key.
    await repo.servers.create({ name: `Sched WW2 ${Date.now()}`, game: "hll", host: "10.0.0.3", port: 1, password: "x" });
    const add = (h: Record<string, string>, playerId: string) => jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: h, body: JSON.stringify({ playerId, playerName: "P" }) });
    const refused = await add(groupsOnly, "76561199200000021");
    assert.equal((await askedFor(base, auth, refused)).capability, "vip.grant");
    assert.ok(!(await repo.playerGroups.members(gid)).some((m) => m.playerId === "76561199200000021"), "nobody was added");
    assert.equal((await add(granter, "76561199200000021")).status, 201);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/members/76561199200000021`, { method: "DELETE", headers: groupsOnly })).status, 200, "removing someone only spares them");
    const detail = await jf(`${base}/api/player-groups/${gid}`, { headers: auth });
    assert.equal(detail.body.watchedByRules.scheduled, 1);
  });
});

test("the clock waits when the community time zone can't be read, rather than guessing UTC and claiming early", async () => {
  await scene(async ({ repo, enf, calls, rule }) => {
    const r = await rule("vip");
    const at = firstOf(1);
    const real = repo.appConfig.get.bind(repo.appConfig);
    repo.appConfig.get = async () => { throw new Error("database blip"); };
    await enf.runSchedules(at);
    assert.equal(calls.length, 0);
    repo.appConfig.get = real;
    await enf.runSchedules(at);
    assert.ok(calls.length > 0, "the next tick runs it");
    assert.equal(await repo.enforcerRules.claimOccurrence(r.id, `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`), false, "claimed once, by the tick that ran it");
  });
});

test("a community-wide schedule's alert says so; an imported one whose action no schedule may take is held, not claimed", async () => {
  const emitted: { kind: string; serverId?: string; data?: Record<string, unknown> }[] = [];
  const bus = { on: () => () => {}, emit: (_k: string, e: never) => void emitted.push(e), close: async () => {} };
  await scene(async ({ repo, enf, calls, rule }) => {
    await rule("vip");
    const odd = await rule("permaban");
    const at = firstOf(1);
    await enf.runSchedules(at);
    const alert = emitted.find((e) => e.kind === "app.enforcement");
    assert.ok(alert, "one alert for the run");
    assert.equal(alert!.serverId, undefined);
    assert.equal(alert!.data?.communityWide, true, "the bot routes it without a server of its own");
    assert.ok(!calls.some((c) => c.action !== "vip"), "nothing but the grant ran");
    const held = (await repo.enforcerRules.statuses()).filter((st) => st.ruleId === odd.id).map((st) => st.skipReason ?? "");
    assert.ok(held.some((x) => /isn't one a schedule can take/.test(x)));
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
    assert.equal(await repo.enforcerRules.claimOccurrence(odd.id, key), true, "never claimed — it can still run once someone saves it properly");
  }, { bus });
});

test("a cut on a grant that vanished while the run was busy says so — and makes no grant of its own", async () => {
  await scene(async ({ repo, enf, ww2, rule }) => {
    await rule("vipreduce", { vipMinutes: 60 });
    // B's grant is revoked by someone else right after the run reads it.
    const realGet = repo.vips.get.bind(repo.vips);
    repo.vips.get = async (sid: string, pid: string) => {
      const row = await realGet(sid, pid);
      if (pid === B && row) await repo.vips.remove(sid, pid);
      return row;
    };
    await enf.runSchedules(firstOf(1));
    repo.vips.get = realGet;
    assert.equal(await repo.vips.get(ww2.id, B), null, "the cut did not bring the grant back");
    const run = (await repo.audit.list({ actions: ["enforcer.schedule"] }))[0]!;
    const skipped = (run.data as { skipped?: { playerId: string; why: string }[] }).skipped ?? [];
    assert.match(skipped.find((x) => x.playerId === B)?.why ?? "", /no VIP here any more/);
    assert.equal((await repo.audit.list({ actions: ["vip.reduce"] })).length, 0, "no cut recorded");
  });
});
