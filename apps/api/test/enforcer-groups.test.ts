/**
 * Group triggers: a rule that fires when a player is added to, or removed from, a player group.
 *
 * The store queues every REAL membership change and the enforcer drains the queue. What the
 * drain owes the community: a change fires once (a re-add is not a join), only the rules
 * watching THAT group hear it, and a member is acted on only where their id means something —
 * the servers of their own game. Groups mix WW2 Steam64s and Vietnam EOS ids freely; granting a
 * WW2 id VIP on a Vietnam server is a write that reaches nobody, and an EOS id the panel has
 * never seen could be either game, so it waits rather than being guessed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsolatedRepository, type Repository, type ServerRow } from "@app/db";
import { Enforcer } from "../dist/enforcer.js";
import { withServer, jf, askedFor } from "./harness.ts";

process.env.RULE_CROWD_PACE_MS = "0";
const stubBus = { on: () => () => {}, emit: () => {}, close: async () => {} } as any;
const STEAM_NEW = "76561199100000001";
const EOS_VN = "0123456789abcdef0123456789abcdef";
const EOS_UNSEEN = "fedcba9876543210fedcba9876543210";

async function scene(fn: (s: {
  repo: Repository; enf: Enforcer; ww2a: ServerRow; ww2b: ServerRow; vn: ServerRow;
  calls: { serverId: string; action: string; playerId: unknown }[];
  group: { id: string; name: string };
}) => Promise<void>, opts: { groupRetryMs?: number } = {}) {
  const { repo, cleanup } = await createIsolatedRepository();
  try {
    const mk = async (name: string, game: string) => {
      const s = await repo.servers.create({ name, game, host: "10.0.0.1", port: 1, password: "x", engagementMode: "active" });
      return s;
    };
    const ww2a = await mk("WW2 #1", "hll"), ww2b = await mk("WW2 #2", "hll"), vn = await mk("Vietnam #1", "hllv");
    const group = await repo.playerGroups.create({ name: "WW2 CVC", createdByName: "staff" });
    const calls: { serverId: string; action: string; playerId: unknown }[] = [];
    const enf = new Enforcer({
      repo, bus: stubBus,
      execute: async (server: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ serverId: server.id, action, playerId: params.playerId }),
      readGameVipIds: async () => new Set<string>(),
      ...(opts.groupRetryMs !== undefined ? { groupRetryMs: opts.groupRetryMs } : {}),
    });
    await fn({ repo, enf, ww2a, ww2b, vn, calls, group });
  } finally {
    await cleanup();
  }
}

test("joined: VIP lands on the servers of the member's own game — a Steam64 never seen included — and an unseen console id waits", async () => {
  await scene(async ({ repo, enf, ww2a, ww2b, vn, calls, group }) => {
    const rule = await repo.enforcerRules.create({ serverId: null, name: "CVC welcome VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 7 * 1440, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: EOS_VN, name: "Viet" });
    await enf.refresh();

    for (const id of [STEAM_NEW, EOS_VN, EOS_UNSEEN]) await repo.playerGroups.addMember({ groupId: group.id, playerId: id, playerName: id.slice(0, 4), addedByName: "staff" });
    await enf.runGroupEvents();

    const where = (pid: string) => calls.filter((c) => c.action === "vip" && c.playerId === pid).map((c) => c.serverId).sort();
    assert.deepEqual(where(STEAM_NEW), [ww2a.id, ww2b.id].sort(), "every WW2 server, never Vietnam — with no profile needed for a Steam64");
    assert.deepEqual(where(EOS_VN), [vn.id], "the directory places the console id in Vietnam");
    assert.deepEqual(where(EOS_UNSEEN), [], "an id that could be either game waits");
    const exp = (await repo.vips.get(ww2a.id, STEAM_NEW))?.expiration;
    assert.ok(exp && Date.parse(exp) > Date.now() + 6.9 * 86_400_000, "a dated week of VIP");
    const skips = (await repo.enforcerRules.statuses()).filter((st) => st.ruleId === rule.id && /hasn't been seen/.test(st.skipReason ?? ""));
    assert.equal(skips.length, 1, "the wait is said, once");

    // Re-adding someone already listed is not a join.
    calls.length = 0;
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "renamed", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.equal(calls.length, 0);
  });
});

test("left: only the rules watching that group hear it; a pinned rule acts on its own server alone", async () => {
  await scene(async ({ repo, enf, ww2a, ww2b, calls, group }) => {
    const elsewhere = await repo.playerGroups.create({ name: "Casters", createdByName: "staff" });
    await repo.enforcerRules.create({ serverId: ww2b.id, name: "CVC parting VIP", eventKind: "app.group.left", action: "vip", vipMinutes: 1440, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    await repo.enforcerRules.create({ serverId: null, name: "Casters leave note", eventKind: "app.group.left", action: "note", params: { groupId: elsewhere.id } } as any);
    await repo.enforcerRules.create({ serverId: null, name: "CVC join note", eventKind: "app.group.joined", action: "note", params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "Ana", addedByName: "staff" });
    await enf.runGroupEvents();
    calls.length = 0;
    await repo.playerGroups.removeMember(group.id, STEAM_NEW);
    await enf.runGroupEvents();
    assert.deepEqual(calls.map((c) => [c.serverId, c.action]), [[ww2b.id, "vip"]], "the pinned server only, and no other group's rule");
    assert.equal(await repo.vips.get(ww2a.id, STEAM_NEW), null);
    const notes = (await repo.audit.list({ actions: ["enforcer.note"] })).map((a) => (a.data as { ruleName?: string }).ruleName);
    assert.deepEqual(notes, ["CVC join note"], "a note belongs to the player: once per change, not once per server — and the Casters rule never");
  });
});

test("a group rule fires from the queue alone — an event on the bus wearing its name does nothing", async () => {
  await scene(async ({ repo, enf, ww2a, calls, group }) => {
    await repo.enforcerRules.create({ serverId: null, name: "CVC welcome VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    await enf.refresh();
    const pl = await repo.players.upsert({ game: "hll", platform: "steam", platformId: STEAM_NEW, name: "Ana" });
    await enf.onEvent({ kind: "app.group.joined", serverId: ww2a.id, actorPlayerId: pl.id, actorName: "Ana", data: { groupId: group.id, playerId: STEAM_NEW } });
    assert.equal(calls.length, 0);
  });
});

test("a group rule's save: only what reaches someone off-server, the group must exist, on-server gates are dropped", async () => {
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${(await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) })).body.token as string}` };
    const group = await repo.playerGroups.create({ name: `Rule group ${Date.now()}`, createdByName: "staff" });
    const save = (body: Record<string, unknown>) => jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "g", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, params: { groupId: group.id }, ...body }) });
    assert.match((await save({ action: "message", reason: "hi" })).body.error?.message ?? (await save({ action: "message", reason: "hi" })).body.error, /group rule can grant VIP or points/);
    assert.match(JSON.stringify((await save({ action: "permaban" })).body), /a ban would let anyone who edits the group ban/);
    assert.match(JSON.stringify((await save({ params: {} })).body), /pick the player group/);
    assert.match(JSON.stringify((await save({ params: { groupId: "00000000-0000-0000-0000-000000000000" } })).body), /no longer exists/);
    assert.match(JSON.stringify((await save({ params: { groupId: "not-a-uuid" } })).body), /no longer exists/);
    assert.match(JSON.stringify((await save({ action: "note", escalateActions: ["note"] })).body), /cannot escalate/);
    const ok = await save({ threshold: 5, windowSec: 60, playersMin: 20, matchMinutesMin: 10, match: "x" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const r = ok.body.rule as Record<string, unknown>;
    assert.deepEqual([r.threshold, r.windowSec, r.playersMin, r.matchMinutesMin, r.match], [1, 0, 0, 0, null], "nothing measured on a server gates a membership change");
  });
});

test("a watched group's membership takes the keys the rule uses — and adding someone fires it", async () => {
  await withServer(async (base, repo, ctx) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${(await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) })).body.token as string}` };
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "groupsonly", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [
      { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
      { capability: "player.groups", level: "write", scopeType: "global", scopeId: null },
    ] }) });
    const groupsOnly = { authorization: `Bearer ${(await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "groupsonly", password: "pw" }) })).body.token as string}` };
    const gid = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: `Watched ${Date.now()}` }) })).body.group.id as string;
    const add = (h: Record<string, string>, playerId: string) => jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: h, body: JSON.stringify({ playerId, playerName: "P" }) });
    // A membership change has no server of its own; the rule acts on a server of the member's game.
    await repo.servers.create({ name: `WW2 for groups ${Date.now()}`, game: "hll", host: "10.0.0.2", port: 1, password: "x" });

    // A note rule moves nothing: anyone who may edit the group may change it, and it fires.
    const note = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "join note", eventKind: "app.group.joined", action: "note", params: { groupId: gid } }) });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    assert.equal((await add(groupsOnly, "76561199100000011")).status, 201);
    await ctx.enforcer.runGroupEvents();
    const fired = await repo.audit.list({ actions: ["enforcer.note"] });
    assert.ok(fired.some((a) => (a.data as { ruleName?: string }).ruleName === "join note" && a.targetName === "P"), "the route's change reached the rule");

    // A VIP rule does: adding someone hands them VIP, so it takes VIP grant — asked for, without it.
    const vip = await jf(`${base}/api/enforcer/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "join VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, params: { groupId: gid } }) });
    assert.equal(vip.status, 201, JSON.stringify(vip.body));
    const refused = await add(groupsOnly, "76561199100000012");
    assert.equal((await askedFor(base, auth, refused)).capability, "vip.grant");
    assert.ok(!(await repo.playerGroups.members(gid)).some((m) => m.playerId === "76561199100000012"), "nobody was added");
    assert.equal((await add(auth, "76561199100000012")).status, 201);
    // Removing is not what the VIP rule watches; switched off, it asks for nothing.
    assert.equal((await jf(`${base}/api/player-groups/${gid}/members/76561199100000012`, { method: "DELETE", headers: groupsOnly })).status, 200);
    await jf(`${base}/api/enforcer/rules/${vip.body.rule.id as string}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    assert.equal((await add(groupsOnly, "76561199100000013")).status, 201);
  });
});

test("a member with no profile can't be checked against a rule's Discord roles or tags — the rule holds rather than guess", async () => {
  await scene(async ({ repo, enf, calls, group }) => {
    const rule = await repo.enforcerRules.create({ serverId: null, name: "Role-gated welcome", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, vipCooldownMinutes: 0, requireRoleIds: ["123456789012345678"], params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "Ana", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.equal(calls.length, 0, "no VIP for someone whose roles can't be read");
    const why = (await repo.enforcerRules.statuses()).find((st) => st.ruleId === rule.id)?.skipReason ?? "";
    assert.match(why, /no profile yet/);
  });
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reasons = async (repo: Repository, ruleId: string) => (await repo.enforcerRules.statuses()).filter((st) => st.ruleId === ruleId).map((st) => st.skipReason ?? "");

test("a console id nobody has seen waits — and gets it when they join a server", async () => {
  await scene(async ({ repo, enf, vn, calls, group }) => {
    const join = await repo.enforcerRules.create({ serverId: null, name: "CVC welcome VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 1440, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: EOS_UNSEEN, playerName: "Xbox", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.equal(calls.length, 0);
    assert.ok((await reasons(repo, join.id)).some((r) => /^waiting: hasn't been seen on a server yet/.test(r)), "the wait is said");
    await pause(60);
    await enf.runGroupEvents();
    assert.equal(calls.length, 0, "still not seen: it waits again");
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: EOS_UNSEEN, name: "Xbox" });
    await pause(60);
    await enf.runGroupEvents();
    assert.deepEqual(calls.filter((c) => c.action === "vip").map((c) => [c.serverId, c.playerId]), [[vn.id, EOS_UNSEEN]]);
    assert.deepEqual(await repo.playerGroups.takeEvents(10), [], "nothing left waiting");
  }, { groupRetryMs: 30 });
});

test("removed before they were ever seen: the waiting join is dropped, and the removal runs (in order) once they join a server", async () => {
  await scene(async ({ repo, enf, calls, group }) => {
    const join = await repo.enforcerRules.create({ serverId: null, name: "CVC welcome VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 1440, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    await repo.enforcerRules.create({ serverId: null, name: "CVC leave note", eventKind: "app.group.left", action: "note", params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: EOS_UNSEEN, playerName: "Xbox", addedByName: "staff" });
    await enf.runGroupEvents();
    await repo.playerGroups.removeMember(group.id, EOS_UNSEEN);
    await pause(60);
    await enf.runGroupEvents();
    assert.ok((await reasons(repo, join.id)).some((r) => /was removed before it could run/.test(r)), "the join is let go, and says why");
    assert.equal((await repo.audit.list({ actions: ["enforcer.note"] })).length, 0, "the removal waits for them too — its note needs to know their game");
    // They join a Vietnam server: the removal's note runs (it waited on its own clock, so however
    // long that took it is not dropped as old).
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: EOS_UNSEEN, name: "Xbox" });
    await pause(60);
    await enf.runGroupEvents();
    assert.equal(calls.filter((c) => c.action === "vip").length, 0, "no VIP for someone who already left");
    assert.equal((await repo.audit.list({ actions: ["enforcer.note"] })).length, 1);
    assert.deepEqual(await repo.playerGroups.takeEvents(10), []);
  }, { groupRetryMs: 30 });
});

test("removed while the join waited, then seen before it ran again: the join is still dropped", async () => {
  await scene(async ({ repo, enf, calls, group }) => {
    const join = await repo.enforcerRules.create({ serverId: null, name: "CVC welcome VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 1440, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: EOS_UNSEEN, playerName: "Xbox", addedByName: "staff" });
    await enf.runGroupEvents();
    await repo.playerGroups.removeMember(group.id, EOS_UNSEEN);
    // Seen before the retry: nothing is left to wait for, but they are no longer a member.
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: EOS_UNSEEN, name: "Xbox" });
    await pause(60);
    await enf.runGroupEvents();
    assert.equal(calls.filter((c) => c.action === "vip").length, 0, "no VIP for someone who already left");
    assert.ok((await reasons(repo, join.id)).some((r) => /was removed before it could run/.test(r)));
    assert.deepEqual(await repo.playerGroups.takeEvents(10), []);
  }, { groupRetryMs: 30 });
});

test("a dropped wait is said where the wait was said — no rule line keeps saying \"waiting\"", async () => {
  // The Vietnam server comes first in the list: a Steam64's wait is said on its own game's server.
  const { repo, cleanup } = await createIsolatedRepository();
  try {
    await repo.servers.create({ name: "Vietnam #1", game: "hllv", host: "10.0.0.1", port: 1, password: "x", engagementMode: "active" });
    await repo.servers.create({ name: "WW2 #1", game: "hll", host: "10.0.0.1", port: 2, password: "x", engagementMode: "active" });
    const group = await repo.playerGroups.create({ name: "WW2 CVC", createdByName: "staff" });
    const enf = new Enforcer({ repo, bus: stubBus, execute: async () => {}, readGameVipIds: async () => new Set<string>(), groupRetryMs: 30 });
    const tag = await repo.enforcerRules.create({ serverId: null, name: "CVC tag", eventKind: "app.group.joined", action: "tag", actionTag: "CVC", params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "Ana", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.ok((await reasons(repo, tag.id)).some((r) => /^waiting: has no profile yet/.test(r)));
    await repo.playerGroups.removeMember(group.id, STEAM_NEW);
    await pause(60);
    await enf.runGroupEvents();
    const said = await reasons(repo, tag.id);
    assert.ok(said.some((r) => /was removed before it could run/.test(r)), said.join(" | "));
    assert.ok(!said.some((r) => /^waiting:/.test(r)), `no line still says waiting: ${said.join(" | ")}`);
  } finally {
    await cleanup();
  }
});

test("every way a wait ends says so where the wait was said: the rule saved meanwhile, or the member on the other game", async () => {
  await scene(async ({ repo, enf, ww2a, calls, group }) => {
    // Saved while a Steam64's tag waited for a profile: dropped, and its line says why.
    const tag = await repo.enforcerRules.create({ serverId: null, name: "CVC tag", eventKind: "app.group.joined", action: "tag", actionTag: "CVC", params: { groupId: group.id } } as any);
    // Pinned to a WW2 server, waiting on a console id that turns out to play Vietnam (another
    // group, so the two rules' lines are their own).
    const scrims = await repo.playerGroups.create({ name: "Scrims", createdByName: "staff" });
    const vip = await repo.enforcerRules.create({ serverId: ww2a.id, name: "Scrims VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, vipCooldownMinutes: 0, params: { groupId: scrims.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "Ana", addedByName: "staff" });
    await repo.playerGroups.addMember({ groupId: scrims.id, playerId: EOS_UNSEEN, playerName: "Xbox", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.ok((await reasons(repo, tag.id)).some((r) => /^waiting: has no profile yet/.test(r)));
    assert.ok((await reasons(repo, vip.id)).some((r) => /^waiting: hasn't been seen/.test(r)));
    await pause(5);
    await repo.enforcerRules.update(tag.id, { name: "CVC tag (renamed)" });
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: EOS_UNSEEN, name: "Xbox" });
    await pause(60);
    await enf.runGroupEvents();
    const tagSaid = await reasons(repo, tag.id), vipSaid = await reasons(repo, vip.id);
    assert.ok(tagSaid.some((r) => /saved after this change was made/.test(r)), tagSaid.join(" | "));
    assert.ok(vipSaid.some((r) => /turned out to play the other game/.test(r)), vipSaid.join(" | "));
    assert.ok(![...tagSaid, ...vipSaid].some((r) => /^waiting:/.test(r)), "no line still says waiting");
    assert.equal(calls.filter((c) => c.action === "vip").length, 0);
    assert.deepEqual(await repo.playerGroups.takeEvents(10), []);
  }, { groupRetryMs: 30 });
});

test("a group deleted while a join waits: the join is dropped when its member turns up", async () => {
  await scene(async ({ repo, enf, calls, group }) => {
    await repo.enforcerRules.create({ serverId: null, name: "CVC welcome VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 1440, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: EOS_UNSEEN, playerName: "Xbox", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.ok(await repo.playerGroups.remove(group.id));
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: EOS_UNSEEN, name: "Xbox" });
    await pause(60);
    await enf.runGroupEvents();
    assert.equal(calls.length, 0, "no VIP from a group that no longer exists");
    assert.deepEqual(await repo.playerGroups.takeEvents(10), []);
  }, { groupRetryMs: 30 });
});

test("a rule saved after a change was made doesn't act on it — switched out of its trial run while the change waited", async () => {
  await scene(async ({ repo, enf, calls, group }) => {
    const rule = await repo.enforcerRules.create({ serverId: null, name: "CVC welcome VIP (trial)", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, vipCooldownMinutes: 0, dryRun: true, params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: EOS_UNSEEN, playerName: "Xbox", addedByName: "staff" });
    await enf.runGroupEvents();
    await pause(5);
    await repo.enforcerRules.update(rule.id, { dryRun: false });
    await repo.players.upsert({ game: "hllv", platform: "epic", platformId: EOS_UNSEEN, name: "Xbox" });
    await pause(60);
    await enf.runGroupEvents();
    assert.equal(calls.length, 0, "the add was let through on the trial rule's keys, not the live one's");
    assert.ok((await reasons(repo, rule.id)).some((r) => /saved after this change was made/.test(r)));
    assert.deepEqual(await repo.playerGroups.takeEvents(10), []);
  }, { groupRetryMs: 30 });
});

test("a Steam64 with no profile: VIP lands now, a tag waits for the profile — and the VIP is not granted twice", async () => {
  await scene(async ({ repo, enf, ww2a, ww2b, calls, group }) => {
    await repo.enforcerRules.create({ serverId: null, name: "CVC VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 1440, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    const tag = await repo.enforcerRules.create({ serverId: null, name: "CVC tag", eventKind: "app.group.joined", action: "tag", actionTag: "CVC", params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "Ana", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.deepEqual(calls.filter((c) => c.action === "vip").map((c) => c.serverId).sort(), [ww2a.id, ww2b.id].sort());
    assert.ok((await reasons(repo, tag.id)).some((r) => /^waiting: has no profile yet/.test(r)));
    const pl = await repo.players.upsert({ game: "hll", platform: "steam", platformId: STEAM_NEW, name: "Ana" });
    await pause(60);
    await enf.runGroupEvents();
    assert.deepEqual((await repo.playerTags.list(pl.id)).map((t) => t.label), ["CVC"], "the tag lands once there is a profile");
    assert.equal(calls.filter((c) => c.action === "vip").length, 2, "the VIP rule already fired — it is not part of the wait");
  }, { groupRetryMs: 30 });
});

test("a change that waited a month for its member is let go, said once", async () => {
  await scene(async ({ repo, enf, calls, group }) => {
    const rule = await repo.enforcerRules.create({ serverId: null, name: "CVC VIP", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    // The rule as it stood a month ago (saved before the change was made).
    const list = repo.enforcerRules.list.bind(repo.enforcerRules);
    repo.enforcerRules.list = async () => (await list()).map((r) => ({ ...r, updatedAt: "2020-01-01T00:00:00.000Z" }));
    await enf.refresh();
    // They are still listed (a waiting join for someone removed since is dropped for that alone);
    // the add's own queued change is finished, leaving the month-old one.
    await repo.playerGroups.addMember({ groupId: group.id, playerId: EOS_UNSEEN, playerName: "Xbox", addedByName: "staff" });
    await repo.playerGroups.ackEvents((await repo.playerGroups.takeEvents(10)).map((e) => e.id));
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await repo.playerGroups.deferEvent({ id: "00000000-0000-4000-8000-000000000031", groupId: group.id, groupName: group.name, playerId: EOS_UNSEEN, playerName: "Xbox", kind: "joined", createdAt: old, notBefore: old, ruleIds: [rule.id] }, old, [rule.id]);
    await enf.runGroupEvents();
    assert.equal(calls.length, 0);
    assert.ok((await reasons(repo, rule.id)).some((r) => /still hadn't joined a server 30 days later/.test(r)));
    assert.deepEqual(await repo.playerGroups.takeEvents(10), []);
  });
});

test("rules are read fresh for each drain, an imported rule with an action no group rule may take is held, and an id in another spelling still matches", async () => {
  await scene(async ({ repo, enf, calls, group, ww2a }) => {
    const ban = await repo.enforcerRules.create({ serverId: null, name: "Imported ban", eventKind: "app.group.joined", action: "permaban", reason: "x", params: { groupId: group.id } } as any);
    const off = await repo.enforcerRules.create({ serverId: null, name: "Switched off elsewhere", eventKind: "app.group.joined", action: "vip", vipMinutes: 60, vipCooldownMinutes: 0, params: { groupId: group.id } } as any);
    const loud = await repo.enforcerRules.create({ serverId: ww2a.id, name: "Upper-case id", eventKind: "app.group.joined", action: "note", params: { groupId: `{${group.id.toUpperCase()}}` } } as any);
    await enf.refresh();
    // Another process switches one off; this one's cache still says on.
    await repo.enforcerRules.update(off.id, { enabled: false });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: STEAM_NEW, name: "Ana" });
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "Ana", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.deepEqual(calls, [], "no ban, and no VIP from the rule switched off");
    assert.ok((await reasons(repo, ban.id)).some((r) => /isn't one a group rule can take/.test(r)));
    const notes = (await repo.audit.list({ actions: ["enforcer.note"] })).map((a) => (a.data as { ruleName?: string }).ruleName);
    assert.deepEqual(notes, [loud.name], "the same group, however its id was spelled");
  });
});

test("points, a tag or a note go to a server whose rules run, not one with rules switched off", async () => {
  await scene(async ({ repo, enf, ww2a, ww2b, group }) => {
    await repo.servers.setAutomation(ww2a.id, { autosettings: false });
    await repo.enforcerRules.create({ serverId: null, name: "CVC note", eventKind: "app.group.joined", action: "note", params: { groupId: group.id } } as any);
    await enf.refresh();
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: STEAM_NEW, name: "Ana" });
    await repo.playerGroups.addMember({ groupId: group.id, playerId: STEAM_NEW, playerName: "Ana", addedByName: "staff" });
    await enf.runGroupEvents();
    assert.deepEqual((await repo.audit.list({ actions: ["enforcer.note"] })).map((a) => a.serverId), [ww2b.id]);
  });
});
