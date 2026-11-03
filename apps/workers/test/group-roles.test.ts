/**
 * Discord role → group sync, the decisions: who the role puts in a group, who it takes out, and
 * the members it never touches — anyone a person added by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository } from "@app/db";
import { planGroupRoleSync, syncGroupRoles, type RoleGroupMember } from "../src/group-roles.ts";

const CVC = { id: "g-cvc", name: "WW2 CVC", discordRoleId: "role-cvc" };

test("the role's holders join with every linked account; hand-added members stay whatever their roles", () => {
  const plan = planGroupRoleSync({
    groups: [CVC],
    members: new Map<string, RoleGroupMember[]>([["g-cvc", [
      { playerId: "steam-ana", source: "discord" },   // still holds the role
      { playerId: "steam-old", source: "discord" },   // lost the role
      { playerId: "steam-hand", source: "panel" },     // added by a person, holds no role
    ]]]),
    holders: new Map([["role-cvc", new Set(["u-ana", "u-bob"])], ["role-other", new Set(["u-hand"])]]),
    accounts: new Map([
      ["u-ana", [{ platformId: "steam-ana", name: "Ana" }]],
      ["u-bob", [{ platformId: "steam-bob", name: "Bob" }, { platformId: "eos-bob", name: "Bob VN" }]],
      ["u-hand", [{ platformId: "steam-hand", name: "Hand" }]],
    ]),
  });
  assert.deepEqual(plan.add.map((a) => a.playerId).sort(), ["eos-bob", "steam-bob"], "both of Bob's games, Ana already listed");
  assert.deepEqual(plan.remove.map((r) => r.playerId), ["steam-old"], "only what the sync added and the role no longer covers");
});

test("a holder with no linked account adds nobody, and a member who holds the role but was added by hand is left as they are", () => {
  const plan = planGroupRoleSync({
    groups: [CVC],
    members: new Map([["g-cvc", [{ playerId: "steam-hand", source: "panel" as const }]]]),
    holders: new Map([["role-cvc", new Set(["u-unlinked", "u-hand"])]]),
    accounts: new Map([["u-unlinked", []], ["u-hand", [{ platformId: "steam-hand", name: "Hand" }]]]),
  });
  assert.deepEqual(plan, { add: [], remove: [] });
});

// --- The sweep, against a stand-in for Discord and the in-memory store ---

const GUILD = "900000000000000001";
const ROLE = "900000000000000777";

/** A Discord that answers the role list and one page of members — or fails where told to. */
function discord(opts: { roles?: string[]; members?: { id: string; roles: string[] }[]; failMembers?: boolean; failRoles?: boolean; calls?: string[] }) {
  return (async (url: string | URL) => {
    const u = String(url);
    opts.calls?.push(u.endsWith("/roles") ? "roles" : "members");
    if (u.endsWith(`/guilds/${GUILD}/roles`)) {
      if (opts.failRoles) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify((opts.roles ?? [ROLE]).map((id) => ({ id, name: `role ${id}` }))), { status: 200 });
    }
    if (u.includes(`/guilds/${GUILD}/members`)) {
      if (opts.failMembers) return new Response("nope", { status: 503 });
      // Paged like Discord: ascending ids after the cursor, up to the limit.
      const q = new URL(u).searchParams;
      const after = q.get("after") ?? "0";
      const page = [...(opts.members ?? [])].sort((a, b) => a.id.localeCompare(b.id)).filter((m) => m.id > after).slice(0, Number(q.get("limit") ?? 1000));
      return new Response(JSON.stringify(page.map((m) => ({ user: { id: m.id, username: m.id }, roles: m.roles }))), { status: 200 });
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
}

async function world() {
  const repo = new InMemoryRepository();
  const group = await repo.playerGroups.create({ name: "WW2 CVC", createdByName: "staff" });
  await repo.playerGroups.setDiscordRole(group.id, ROLE);
  const link = async (discordId: string, platformId: string, game = "hll") => {
    const p = await repo.players.upsert({ game, platform: game === "hll" ? "steam" : "epic", platformId, name: `N${platformId.slice(-2)}` });
    await repo.externalLinks.set(p.id, "discord", discordId);
  };
  await link("u-ana", "76561199300000001");
  await link("u-bob", "76561199300000002");
  await link("u-bob", "0123456789abcdef0123456789abcd02", "hllv");
  await link("u-old", "76561199300000003");
  await repo.playerGroups.syncAddMember({ groupId: group.id, roleId: ROLE, playerId: "76561199300000003", playerName: "Old", addedByName: "discord-sync" });
  await repo.playerGroups.addMember({ groupId: group.id, playerId: "76561199300000009", playerName: "Hand", addedByName: "staff" });
  await repo.playerGroups.ackEvents((await repo.playerGroups.takeEvents(100)).map((e) => e.id));
  return { repo, group };
}

test("the sweep lists every linked account of the role's holders, takes out its own who lost it, and leaves hand-added members", async () => {
  const { repo, group } = await world();
  const r = await syncGroupRoles(repo, { token: "t", guildId: GUILD, fetchImpl: discord({ members: [{ id: "u-ana", roles: [ROLE] }, { id: "u-bob", roles: [ROLE] }, { id: "u-old", roles: [] }] }) });
  assert.deepEqual([r.added, r.removed, r.skipped], [3, 1, undefined]);
  const members = await repo.playerGroups.members(group.id);
  assert.deepEqual(members.map((m) => [m.playerId, m.source]).sort(), [
    ["0123456789abcdef0123456789abcd02", "discord"],
    ["76561199300000001", "discord"],
    ["76561199300000002", "discord"],
    ["76561199300000009", "panel"],
  ]);
  const events = await repo.playerGroups.takeEvents(100);
  assert.deepEqual(events.map((e) => e.kind).sort(), ["joined", "joined", "joined", "left"], "the group's rules hear every change");
  const second = await syncGroupRoles(repo, { token: "t", guildId: GUILD, fetchImpl: discord({ members: [{ id: "u-ana", roles: [ROLE] }, { id: "u-bob", roles: [ROLE] }] }) });
  assert.deepEqual([second.added, second.removed], [0, 0], "in step: a second pass changes nothing");
});

test("nothing changes on a reading that isn't whole: Discord's members or roles unreadable, or the role not in the server", async () => {
  for (const [why, fetchImpl] of [
    ["members unreadable", discord({ failMembers: true })],
    ["roles unreadable", discord({ failRoles: true })],
    ["role not in the server", discord({ roles: ["900000000000000999"], members: [] })],
  ] as const) {
    const { repo, group } = await world();
    const r = await syncGroupRoles(repo, { token: "t", guildId: GUILD, fetchImpl });
    assert.equal(r.added + r.removed, 0, why);
    assert.equal((await repo.playerGroups.members(group.id)).length, 2, `${why}: the sync's own member is still listed`);
    if (why === "role not in the server") assert.deepEqual(r.missingRoles, ["WW2 CVC"]);
    else assert.ok(r.skipped, why);
  }
});

test("a linked-account lookup that fails ends the pass rather than reading as 'no accounts'", async () => {
  const { repo, group } = await world();
  repo.externalLinks.findPlayers = async () => { throw new Error("database blip"); };
  const r = await syncGroupRoles(repo, { token: "t", guildId: GUILD, fetchImpl: discord({ members: [{ id: "u-ana", roles: [ROLE] }] }) });
  assert.match(r.skipped ?? "", /couldn't be read/);
  assert.equal((await repo.playerGroups.members(group.id)).length, 2);
});

test("one role held by too many leaves its own group as it is; the other groups still sync", async () => {
  const { repo, group } = await world();
  const big = await repo.playerGroups.create({ name: "Everyone", createdByName: "staff" });
  const BIG = "900000000000000888";
  await repo.playerGroups.setDiscordRole(big.id, BIG);
  const crowd = Array.from({ length: 2001 }, (_, i) => ({ id: `u-crowd-${i}`, roles: [BIG] }));
  const lookups: string[] = [];
  const find = repo.externalLinks.findPlayers.bind(repo.externalLinks);
  repo.externalLinks.findPlayers = async (provider, id) => { lookups.push(id); return find(provider, id); };
  const r = await syncGroupRoles(repo, { token: "t", guildId: GUILD, fetchImpl: discord({ roles: [ROLE, BIG], members: [...crowd, { id: "u-ana", roles: [ROLE] }] }) });
  assert.equal(r.skipped, undefined);
  assert.match(r.notes[big.id]?.reason ?? "", /2001 members hold its role/);
  assert.equal(r.notes[big.id]?.roleId, BIG);
  assert.equal(r.notes[group.id], undefined);
  assert.deepEqual([r.added, r.removed], [1, 1], "WW2 CVC: Ana in, Old out");
  assert.deepEqual(lookups, ["u-ana"], "the crowd's accounts are never looked up");
  assert.equal((await repo.playerGroups.members(big.id)).length, 0);
});

test("the roles are read after the members, so a role deleted while the list was paging leaves its group alone", async () => {
  const calls: string[] = [];
  const { repo, group } = await world();
  const r = await syncGroupRoles(repo, { token: "t", guildId: GUILD, fetchImpl: discord({ calls, roles: [], members: [] }) });
  assert.deepEqual(calls, ["members", "roles"]);
  assert.deepEqual(r.missingRoles, ["WW2 CVC"]);
  assert.match(r.notes[group.id]?.reason ?? "", /not in the community Discord server/);
  assert.equal((await repo.playerGroups.members(group.id)).length, 2);
});

test("a group unlinked, moved to another role, or deleted while the pass was reading is not changed on the old reading", async () => {
  for (const change of ["unlinked", "moved", "deleted", "hand-added"] as const) {
    const { repo, group } = await world();
    const find = repo.externalLinks.findPlayers.bind(repo.externalLinks);
    let once = false;
    repo.externalLinks.findPlayers = async (provider, id) => {
      if (!once) {
        once = true;
        if (change === "unlinked") await repo.playerGroups.setDiscordRole(group.id, null);
        if (change === "moved") await repo.playerGroups.setDiscordRole(group.id, "900000000000000999");
        if (change === "deleted") await repo.playerGroups.remove(group.id);
        if (change === "hand-added") await repo.playerGroups.addMember({ groupId: group.id, playerId: "76561199300000001", playerName: "Ana", addedByName: "staff" });
      }
      return find(provider, id);
    };
    const r = await syncGroupRoles(repo, { token: "t", guildId: GUILD, fetchImpl: discord({ members: [{ id: "u-ana", roles: [ROLE] }] }) });
    const members = await repo.playerGroups.members(group.id);
    if (change === "hand-added") {
      assert.deepEqual([r.added, r.removed], [0, 1], "Ana is a person's now — not counted, not audited as the sync's");
      assert.deepEqual(members.map((m) => [m.playerId, m.source]).sort(), [["76561199300000001", "panel"], ["76561199300000009", "panel"]]);
      const adds = (await repo.audit.list({ actions: ["group.member_add"] })).filter((a) => a.actorName === "discord-sync");
      assert.equal(adds.length, 0);
    } else {
      assert.deepEqual([r.added, r.removed], [0, 0], change);
      assert.equal(members.length, change === "deleted" ? 0 : 2, change);
      if (change === "deleted") assert.deepEqual(await repo.playerGroups.groupsForPlayer("76561199300000001"), [], "no row left behind");
    }
  }
});
