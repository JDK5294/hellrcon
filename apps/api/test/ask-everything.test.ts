import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { withIsolatedServer as withServer, jf, askedFor } from "./harness.ts";
import { sendForbidden } from "../dist/routes/kit.js";
import { renderCard } from "../dist/approval-cards.js";
import { requestScope } from "../dist/request-scope.js";

/*
 * Everything a role can see, it can ask for.
 *
 * The owner's report: staff could not put in a request to add someone to a group, though their head
 * admins could add them. Adding to a group with a VIP perk needs the VIP key on the perk's servers
 * as well as the groups key, and that second refusal — like every refusal outside the per-server
 * screens — was a plain 403 with no way to ask. Now a write refused for a missing permission is
 * filed for whoever holds it (or captured into the request being built), carrying exactly the
 * permission found missing; a signature replays the same call with the signer's authority, under
 * the requester's name.
 */

async function login(base: string, u: string, p: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}
async function owner(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = await login(base, "owner", "pw");
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "t", host: "127.0.0.1", port: 1, password: "x" }) });
  return { auth, serverId: (created.body.server as { id: string }).id };
}
async function staff(base: string, auth: Record<string, string>, username: string, grants: unknown[]) {
  await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
  const id = ((await jf(`${base}/api/users`, { headers: auth })).body.users as any[]).find((u) => u.username === username).id as string;
  const r = await jf(`${base}/api/users/${id}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants }) });
  assert.equal(r.status, 200, `grants for ${username}: ${JSON.stringify(r.body)}`);
  return { id, auth: await login(base, username, "pw") };
}
/** A group carrying a VIP perk over every server of the game. */
async function perkGroup(base: string, auth: Record<string, string>, repo: any, serverId: string) {
  const group = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "WW2 CVC" }) })).body.group as { id: string };
  const server = await repo.servers.findById(serverId);
  await repo.playerGroups.setVipPerk(group.id, { game: server.game, scope: { mode: "all" }, severanceMinutes: 0 });
  return group;
}
const RECRUIT = { playerId: "76561198000000777", playerName: "Recruit" };

test("adding someone to a VIP-perk group without the VIP key files a request; the key-holder's signature adds them", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const group = await perkGroup(base, auth, repo, serverId);
    // The owner's staff: the groups key, not the VIP key.
    const lead = await staff(base, auth, "lead", [{ capability: "player.groups", level: "write" }, { capability: "server.view", level: "read" }]);

    const add = await jf(`${base}/api/player-groups/${group.id}/members`, { method: "POST", headers: lead.auth, body: JSON.stringify(RECRUIT) });
    assert.equal(add.status, 202, JSON.stringify(add.body));
    assert.equal(add.body.requested, true, "filed, not refused");
    assert.equal(add.body.label, "Add a player to a group");
    assert.equal((await repo.playerGroups.members(group.id)).length, 0, "nothing happens before a signature");

    // It asks for the key that was missing, on the server the perk needs it on.
    const queue = (await jf(`${base}/api/requests`, { headers: auth })).body.queue as any[];
    const filed = queue.find((r) => r.id === add.body.requestId);
    assert.ok(filed, "it waits in the key-holder's queue");
    const line = filed.lines[0];
    assert.equal(line.kind, "route");
    assert.equal(line.capability, "vip.grant");
    assert.equal(line.serverId, serverId);
    assert.equal(line.payload.label, "Add a player to a group");
    assert.equal(line.canSign, true);

    // A colleague with only the groups key cannot sign what needs the VIP key.
    const peer = await staff(base, auth, "peer", [{ capability: "player.groups", level: "write" }]);
    assert.equal((await jf(`${base}/api/requests/${filed.id}/lines/${line.id}/approve`, { method: "POST", headers: peer.auth, body: "{}" })).status, 403);

    const signed = await jf(`${base}/api/requests/${filed.id}/lines/${line.id}/approve`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.applyError, null);
    const members = await repo.playerGroups.members(group.id);
    assert.deepEqual(members.map((m: { playerId: string }) => m.playerId), [RECRUIT.playerId], "the signature adds them");
    // The work is the requester's, with the signer beside it.
    const row = (await repo.audit.list({ actions: ["group.member_add"], limit: 5 }))[0]!;
    assert.equal(row.actorName, "lead");
    assert.match(row.summary, /\(approved by owner\)$/);
    assert.equal(row.data?.requestId, filed.id);
    // And the signer's trail names what they approved in words — the group and the player too.
    const approval = (await repo.audit.list({ actions: ["request.approve"], limit: 5 }))[0]!;
    assert.match(approval.summary, /^approved “Add a player to a group” \(group: WW2 CVC · player: 76561198000000777 \(named “Recruit” in the request\)\) \(requested by lead\)/);
  });
});

test("a signature short of a second key fails on the line — a replay never files another request", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const group = await perkGroup(base, auth, repo, serverId);
    // Can see groups, cannot change them: refused at the groups key itself.
    const viewer = await staff(base, auth, "viewer", [{ capability: "player.groups", level: "read" }]);
    const add = await jf(`${base}/api/player-groups/${group.id}/members`, { method: "POST", headers: viewer.auth, body: JSON.stringify(RECRUIT) });
    assert.equal(add.status, 202);
    const filed = (await jf(`${base}/api/requests/${add.body.requestId}`, { headers: auth })).body.request;
    assert.equal(filed.lines[0].capability, "player.groups");
    assert.equal(filed.lines[0].serverId, null, "a community-wide key, asked for anywhere");

    // Signed by someone with the groups key but not the VIP key the perk needs.
    const groupsAdmin = await staff(base, auth, "groupsAdmin", [{ capability: "player.groups", level: "write" }]);
    const before = (await repo.approvals.list()).length;
    const signed = await jf(`${base}/api/requests/${filed.id}/lines/${filed.lines[0].id}/approve`, { method: "POST", headers: groupsAdmin.auth, body: "{}" });
    assert.equal(signed.status, 200);
    assert.match(String(signed.body.applyError), /missing permission: Grant VIP/, "the line says what the signer lacked");
    assert.equal((await repo.playerGroups.members(group.id)).length, 0);
    assert.equal((await repo.approvals.list()).length, before, "the replay refused; it did not file again");
  });
});

test("in the request builder, a group add that needs a second key goes for a signature at submit, asking for it", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const group = await perkGroup(base, auth, repo, serverId);
    const lead = await staff(base, auth, "lead", [{ capability: "player.groups", level: "write" }, { capability: "server.view", level: "read" }]);
    assert.equal((await jf(`${base}/api/requests/draft`, { method: "POST", headers: lead.auth })).status, 200);

    const add = await jf(`${base}/api/player-groups/${group.id}/members`, { method: "POST", headers: lead.auth, body: JSON.stringify(RECRUIT) });
    assert.equal(add.status, 202);
    assert.equal(add.body.captured, true, "captured into the request being built");
    assert.equal((await repo.playerGroups.members(group.id)).length, 0, "nothing happens before submit");
    const draft = (await jf(`${base}/api/requests/draft`, { headers: lead.auth })).body.draft;
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.lines[0].capability, "player.groups", "captured at the first key the add needs");
    assert.equal(draft.lines[0].fate, "immediate", "which they hold");

    const submitted = await jf(`${base}/api/requests/draft/submit`, { method: "POST", headers: lead.auth, body: "{}" });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.deepEqual(submitted.body.applied, [], "not recorded as done — or as a failure");
    assert.ok(submitted.body.filed, "filed for a signature");
    assert.equal((await repo.playerGroups.members(group.id)).length, 0);
    const filed = (await jf(`${base}/api/requests/${submitted.body.filed}`, { headers: auth })).body.request;
    assert.equal(filed.lines.length, 1);
    assert.equal(filed.lines[0].state, "pending");
    assert.equal(filed.lines[0].capability, "vip.grant", "asking for the key it found missing");
    assert.equal(filed.lines[0].serverId, serverId);

    const signed = await jf(`${base}/api/requests/${filed.id}/lines/${filed.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(signed.body.applyError, null);
    assert.equal((await repo.playerGroups.members(group.id)).length, 1);
  });
});

test("community settings and one server's settings are asked for the same way", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const junior = await staff(base, auth, "junior", [{ capability: "server.view", level: "read" }]);

    // Users & roles territory: the app-wide settings.
    const zone = await jf(`${base}/api/app-config`, { method: "PUT", headers: junior.auth, body: JSON.stringify({ timezone: "Asia/Tokyo" }) });
    assert.equal(zone.status, 202);
    assert.equal(zone.body.label, "Change the app-wide settings");
    assert.notEqual((await repo.appConfig.get()).timezone, "Asia/Tokyo");
    // One server's switches, through a plain route: the line names the server in the path.
    const auto = await jf(`${base}/api/servers/${serverId}/automation`, { method: "PUT", headers: junior.auth, body: JSON.stringify({ automation: { mapvote: false } }) });
    assert.equal(auto.status, 202, JSON.stringify(auto.body));
    const autoLine = (await jf(`${base}/api/requests/${auto.body.requestId}`, { headers: auth })).body.request.lines[0];
    assert.equal(autoLine.capability, "server.engagement");
    assert.equal(autoLine.serverId, serverId);

    for (const id of [zone.body.requestId, auto.body.requestId]) {
      const r = (await jf(`${base}/api/requests/${id}`, { headers: auth })).body.request;
      const signed = await jf(`${base}/api/requests/${id}/lines/${r.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(signed.body.applyError, null, JSON.stringify(signed.body));
    }
    assert.equal((await repo.appConfig.get()).timezone, "Asia/Tokyo");
    assert.equal((await repo.servers.findById(serverId))!.automation.mapvote, false);
  });
});

test("writes set aside keep refusing, and reads never ask", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);
    const junior = await staff(base, auth, "junior", [{ capability: "server.view", level: "read" }, { capability: "admin.data", level: "read" }]);
    // A password rides in the body: a request would keep it in the queue in plain text.
    const account = await jf(`${base}/api/users`, { method: "POST", headers: junior.auth, body: JSON.stringify({ username: "x", password: "secret-pw" }) });
    assert.equal(account.status, 403);
    assert.match(String(account.body.error?.message), /missing permission/);
    // Owner only: there is nobody a request could reach.
    assert.equal((await jf(`${base}/api/data/restore`, { method: "POST", headers: junior.auth, body: "{}" })).status, 403);
    // A read has nothing to ask for.
    assert.equal((await jf(`${base}/api/audit`, { headers: junior.auth })).status, 403);
    assert.equal(((await jf(`${base}/api/requests`, { headers: junior.auth })).body.mine as any[]).length, 0, "none of that filed anything");
  });
});

test("a key checked on one server asks for it there: VIP pause and resume name the server the VIP is on", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "other", host: "127.0.0.2", port: 2, password: "x" }) });
    const junior = await staff(base, auth, "junior", [{ capability: "server.view", level: "read" }]);
    const pid = "76561198000000901";
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: pid, name: "Payer" });
    await repo.vips.upsert({ serverId, playerId: pid, playerName: "Payer", comment: null, expiration: new Date(Date.now() + 30 * 86_400_000).toISOString(), createdByUserId: null, createdByName: "staff" });

    const pause = await jf(`${base}/api/players/${pid}/vip/pause`, { method: "POST", headers: junior.auth, body: JSON.stringify({ reason: "spam", hours: 2 }) });
    assert.deepEqual(await askedFor(base, auth, pause), { capability: "vip.pause", serverId });
    assert.equal((await repo.vips.get(serverId, pid))!.pausedUntil ?? null, null, "not paused on the asking");

    await repo.vips.setPause(serverId, pid, { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "earlier", by: "owner" });
    const resume = await jf(`${base}/api/players/${pid}/vip/resume`, { method: "POST", headers: junior.auth, body: "{}" });
    assert.deepEqual(await askedFor(base, auth, resume), { capability: "vip.pause", serverId });
    assert.ok((await repo.vips.get(serverId, pid))!.pausedUntil, "still paused on the asking");
  });
});

test("a server the path names is always the request's: an approved call is replayed there", async () => {
  // A response that goes nowhere: a replay's refusal still answers 403.
  const res = () => {
    const r = { headersSent: false, writeHead: () => { r.headersSent = true; return r; }, setHeader: () => r, end: () => r };
    return r as unknown as ServerResponse;
  };
  const scope = (path: string, params: Record<string, string>) => ({ ask: { method: "PUT", path, params, req: {}, ctx: {} }, principal: {}, replay: true }) as any;

  // A key checked on another server (a seeding bridge's stop) must not move the call off the
  // server whose screen it changes.
  const onServer = scope("/api/servers/:id/seeding", { id: "path-server" });
  await requestScope.run(onServer, () => sendForbidden(res(), "vip.grant", "write", { serverId: "other-server" }));
  assert.deepEqual(onServer.refused, { capability: "vip.grant", serverId: "path-server" });
  // Off a server path, the server the check was made against is the one asked about.
  const offServer = scope("/api/payout-events", {});
  await requestScope.run(offServer, () => sendForbidden(res(), "mapvote.config", "write", { serverId: "event-server" }));
  assert.deepEqual(offServer.refused, { capability: "mapvote.config", serverId: "event-server" });
});

/*
 * An approved request runs with the signer's grants under the requester's name — so a guard that
 * asks "is this your own account?" must ask it of the signer too. Otherwise a request naming the
 * signer's own account did to it what the signer could never do by hand: deleted it, merged it
 * away, or took their user-admin access.
 */
test("a request naming the signer's own account cannot delete, merge away or demote it", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await owner(base);
    const admin = await staff(base, auth, "useradmin", [{ capability: "admin.users", level: "write" }, { capability: "server.view", level: "read" }]);
    const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
    const signLast = async (filed: { status: number; body: Record<string, unknown> }) => {
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      const r = ((await jf(`${base}/api/requests`, { headers: admin.auth })).body.queue as any[]).find((q) => q.id === filed.body.requestId);
      assert.ok(r, "it waits in the user admin's queue");
      const signed = await jf(`${base}/api/requests/${r.id}/lines/${r.lines[0].id}/approve`, { method: "POST", headers: admin.auth, body: "{}" });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      return signed.body.applyError as string | null;
    };

    const del = await signLast(await jf(`${base}/api/users/${admin.id}`, { method: "DELETE", headers: asker.auth }));
    assert.match(String(del), /your own account/);
    assert.ok(await repo.users.findById(admin.id), "the signer's account is still there");

    const merge = await signLast(await jf(`${base}/api/users/${asker.id}/merge`, { method: "POST", headers: asker.auth, body: JSON.stringify({ duplicateId: admin.id }) }));
    assert.match(String(merge), /signing it/);
    assert.ok(await repo.users.findById(admin.id), "not merged away");

    const demote = await signLast(await jf(`${base}/api/users/${admin.id}/grants`, { method: "PUT", headers: asker.auth, body: JSON.stringify({ grants: [{ capability: "server.view", level: "read" }] }) }));
    assert.match(String(demote), /your own user-admin access/);
    assert.ok((await repo.grants.listByUser(admin.id)).some((g: { capability: string; level: string }) => g.capability === "admin.users" && g.level === "write"), "still a user admin");
  });
});

test("a staff member can ask for a permission for themselves, and the owner's signature gives it", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await owner(base);
    const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
    const ask = await jf(`${base}/api/users/${asker.id}/grants`, { method: "POST", headers: asker.auth, body: JSON.stringify({ capability: "vip.grant", level: "write", scopeType: "global", scopeId: null }) });
    assert.equal(ask.status, 202, JSON.stringify(ask.body));
    const r = ((await jf(`${base}/api/requests`, { headers: auth })).body.queue as any[]).find((q) => q.id === ask.body.requestId);
    const signed = await jf(`${base}/api/requests/${r.id}/lines/${r.lines[0].id}/approve`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    // It used to stop at "you cannot remove your own user-admin access" — access they never had.
    assert.equal(signed.body.applyError, null);
    assert.ok((await repo.grants.listByUser(asker.id)).some((g: { capability: string; level: string }) => g.capability === "vip.grant" && g.level === "write"));
  });
});

/*
 * What an approver reads must say WHO or WHAT a call is about. The path names it by id, and the
 * queue and the Discord card printed every path parameter but `id` — the server, on the per-server
 * screens, but the subject itself everywhere else: "Delete a staff account" came with no account.
 */
test("a filed call names its subject: the account, the roles, the group and the player — in the queue, on the card and in the trail", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
    const target = await staff(base, auth, "target", [{ capability: "server.view", level: "read" }]);
    const head = await repo.roles.create({ name: "Head Admin", grants: [] });
    const lineOf = async (filed: { status: number; body: Record<string, unknown> }) => {
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      const r = ((await jf(`${base}/api/requests`, { headers: auth })).body.queue as any[]).find((q) => q.id === filed.body.requestId);
      return { request: r, line: r.lines[0] };
    };

    const del = await lineOf(await jf(`${base}/api/users/${target.id}`, { method: "DELETE", headers: asker.auth }));
    assert.deepEqual(del.line.payload.subject, ["account: target"]);

    const roles = await lineOf(await jf(`${base}/api/users/${target.id}/roles`, { method: "PUT", headers: asker.auth, body: JSON.stringify({ roleIds: [head.id] }) }));
    assert.deepEqual(roles.line.payload.subject, ["account: target", "roles: Head Admin"]);
    // A role's permissions: what the role becomes is what is being signed.
    const edit = await lineOf(await jf(`${base}/api/roles/${head.id}`, { method: "PUT", headers: asker.auth, body: JSON.stringify({ grants: [{ capability: "admin.users", level: "write" }] }) }));
    assert.deepEqual(edit.line.payload.subject, ["role: Head Admin", "permissions become: admin.users write"]);
    const setGrants = await lineOf(await jf(`${base}/api/users/${target.id}/grants`, { method: "PUT", headers: asker.auth, body: JSON.stringify({ grants: [{ capability: "vip.grant", level: "write" }, { capability: "server.view", level: "read" }] }) }));
    assert.deepEqual(setGrants.line.payload.subject, ["account: target", "permissions become: vip.grant write, server.view read"]);

    const group = await perkGroup(base, auth, repo, serverId);
    const add = await lineOf(await jf(`${base}/api/player-groups/${group.id}/members`, { method: "POST", headers: asker.auth, body: JSON.stringify(RECRUIT) }));
    // A player the directory has never seen: the name is the request's own, and says so.
    assert.deepEqual(add.line.payload.subject, ["group: WW2 CVC", "player: 76561198000000777 (named “Recruit” in the request)"]);

    // The Discord card says the same.
    const card = String(renderCard((await repo.approvals.get(roles.request.id))!, () => null, null).content);
    assert.match(card, /account: target · roles: Head Admin/);
    // And so does the trail, filed and signed.
    const filedRow = (await repo.audit.list({ actions: ["request.file"], limit: 10 })).find((a) => a.targetId === del.request.id)!;
    assert.match(filedRow.summary, /Delete a staff account \(account: target\)/);
    const signed = await jf(`${base}/api/requests/${del.request.id}/lines/${del.line.id}/deny`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "no" }) });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    const denied = (await repo.audit.list({ actions: ["request.deny"], limit: 5 }))[0]!;
    assert.match(denied.summary, /“Delete a staff account” \(account: target\)/);

    // A per-server screen's call is named the same way: its server is the line's own, so only
    // the rest of the path is printed.
    const rename = await lineOf(await jf(`${base}/api/servers/${serverId}/maps/foy_warfare/name`, { method: "PUT", headers: asker.auth, body: JSON.stringify({ name: "Foy (Warfare)" }) }));
    assert.deepEqual(rename.line.payload.subject, ["mapId: foy_warfare"]);
  });
});

/*
 * The name a call arrives with is the caller's. The panel sends the roster's, but anything at all
 * can be sent, and the queue and the Discord card print it beside the action: a kick filed on one
 * player's id under another player's name read as that other player to whoever signed it.
 */
test("a request names the player as the directory knows them, not as the call named them", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
    const known = "76561198000000901";
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: known, name: "Griefer" });
    const kickAs = (playerId: string, playerName: string, extra: Record<string, unknown> = {}) =>
      jf(`${base}/api/servers/${serverId}/actions`, { method: "POST", headers: asker.auth, body: JSON.stringify({ action: "kick", playerId, playerName, reason: "x", ...extra }) });

    const kick = await kickAs(known, "Model Citizen");
    assert.equal(kick.status, 202, JSON.stringify(kick.body));
    const filed = (await repo.approvals.get(kick.body.requestId as string))!;
    assert.equal(filed.lines[0]!.playerName, "Griefer", "the queue prints the directory's name");
    const card = String(renderCard(filed, () => "Server 1", null).content);
    assert.match(card, /\*\*Kick\*\* Griefer on Server 1/);
    assert.doesNotMatch(card, /Model Citizen/);
    const trail = (await repo.audit.list({ actions: ["request.file"], limit: 5 })).find((a) => a.targetId === filed.id)!;
    assert.match(trail.summary, /kick Griefer/);
    assert.doesNotMatch(trail.summary, /Model Citizen/);

    // An id the directory has never seen keeps the name it came with: there is nothing to check it against.
    const stranger = await kickAs("76561198000000902", "Stranger");
    assert.equal((await repo.approvals.get(stranger.body.requestId as string))!.lines[0]!.playerName, "Stranger");

    // And a filed call's subject: the member added is the directory's player, whatever the body calls them.
    const group = await perkGroup(base, auth, repo, serverId);
    const add = await jf(`${base}/api/player-groups/${group.id}/members`, { method: "POST", headers: asker.auth, body: JSON.stringify({ playerId: known, playerName: "Model Citizen" }) });
    assert.equal(add.status, 202, JSON.stringify(add.body));
    assert.deepEqual((await repo.approvals.get(add.body.requestId as string))!.lines[0]!.payload.subject, ["group: WW2 CVC", "player: Griefer"]);

    // The same in the request being built.
    assert.equal((await kickAs(known, "Model Citizen", { draft: true })).status, 202);
    assert.equal((await repo.approvals.findDraft(asker.id))!.lines[0]!.playerName, "Griefer");
  });
});

/*
 * Some calls carry their players in the BODY: "Run an action on several players · action:
 * permaban · changes players" named nobody, so a ban on any list at all was one signature away,
 * and "Remove VIP time" showed an id.
 */
test("the players a call carries in its body are named: a VIP cut, a dismissed finding, a bulk action", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
    const known = "76561198000000901";
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: known, name: "Griefer" });
    const subjectOf = async (path: string, body: unknown) => {
      const filed = await jf(`${base}${path}`, { method: "POST", headers: asker.auth, body: JSON.stringify(body) });
      assert.equal(filed.status, 202, JSON.stringify(filed.body));
      return (await repo.approvals.get(filed.body.requestId as string))!.lines[0]!.payload.subject;
    };

    assert.deepEqual(await subjectOf(`/api/servers/${serverId}/vips/reduce`, { playerId: known, days: 30 }), ["player: Griefer"]);
    assert.deepEqual(await subjectOf("/api/vips/integrity/ignore", { serverId, playerId: known, playerName: "Model Citizen" }), ["player: Griefer"]);

    const bulk = await subjectOf(`/api/servers/${serverId}/actions/bulk`, {
      action: "permaban", reason: "x",
      players: [{ playerId: known, playerName: "Model Citizen" }, { playerId: "76561198000000902", playerName: "Stranger" }, { playerId: known, playerName: "Model Citizen" }],
    });
    assert.deepEqual(bulk, ["players (2): Griefer, 76561198000000902 (named “Stranger” in the request)"]);
    // A long list names the first ten and counts the rest — never a silent cut.
    const many = Array.from({ length: 12 }, (_, i) => ({ playerId: `7656119800000${String(i).padStart(4, "0")}` }));
    assert.deepEqual(await subjectOf(`/api/servers/${serverId}/vips/bulk`, { players: many, mode: "duration", days: 1, comment: "event" }),
      [`players (12): ${many.slice(0, 10).map((m) => m.playerId).join(", ")} +2 more`]);
    // A VIP grant asked for without its comment is refused, not filed: signed, it could never land.
    const before = (await repo.approvals.list({})).length;
    const silent = await jf(`${base}/api/servers/${serverId}/vips/bulk`, { method: "POST", headers: asker.auth, body: JSON.stringify({ players: many, mode: "duration", days: 1 }) });
    assert.equal(silent.status, 400, JSON.stringify(silent.body));
    assert.equal((await repo.approvals.list({})).length, before, "nothing was filed");
  });
});

/*
 * A Discord role mapping confers panel roles on everyone holding the Discord role, and the call
 * names that role by id plus a `discordRoleName` its sender typed. Signing "Head Admins → Head
 * Admin" when the id is the Recruit role hands Head Admin to every recruit.
 */
test("a Discord role a call is about is named by Discord, never by the call", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await owner(base);
    const asker = await staff(base, auth, "asker", [{ capability: "server.view", level: "read" }]);
    const head = await repo.roles.create({ name: "Head Admin", grants: [] });
    await repo.appConfig.set({ communityGuildId: "g1" });
    const realFetch = globalThis.fetch;
    const priorToken = process.env.DISCORD_TOKEN;
    // Only Discord is faked — the test drives the API over real HTTP.
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith("https://discord.com")) return realFetch(url as never, init);
      if (u.endsWith("/guilds/g1/roles")) return new Response(JSON.stringify([{ id: "111", name: "Recruit" }, { id: "222", name: "Head Admins" }]), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    process.env.DISCORD_TOKEN = "t";
    try {
      const tie = await jf(`${base}/api/discord/role-map/111`, { method: "PUT", headers: asker.auth, body: JSON.stringify({ discordRoleName: "Head Admins", roleIds: [head.id] }) });
      assert.equal(tie.status, 202, JSON.stringify(tie.body));
      assert.deepEqual((await repo.approvals.get(tie.body.requestId as string))!.lines[0]!.payload.subject, ["Discord role: Recruit (111)", "roles: Head Admin"]);

      // Discord out of reach: the id as it came — still never the call's own word for it.
      delete process.env.DISCORD_TOKEN;
      const blind = await jf(`${base}/api/discord/role-map/111`, { method: "PUT", headers: asker.auth, body: JSON.stringify({ discordRoleName: "Head Admins", roleIds: [head.id] }) });
      assert.equal(blind.status, 202, JSON.stringify(blind.body));
      assert.deepEqual((await repo.approvals.get(blind.body.requestId as string))!.lines[0]!.payload.subject, ["Discord role: 111", "roles: Head Admin"]);
    } finally {
      globalThis.fetch = realFetch;
      if (priorToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = priorToken;
    }
  });
});

test("a preview is a read: whoever can see Data trim counts what a trim would remove, then asks for the trim", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);
    const viewer = await staff(base, auth, "trimviewer", [{ capability: "admin.trim", level: "read" }]);
    const stranger = await staff(base, auth, "stranger", [{ capability: "server.view", level: "read" }]);
    const spec = JSON.stringify({ categories: ["kills"], olderThanDays: 365 });

    const counted = await jf(`${base}/api/trim/preview`, { method: "POST", headers: viewer.auth, body: spec });
    assert.equal(counted.status, 200, JSON.stringify(counted.body));
    assert.equal(typeof (counted.body.perCategory as Record<string, number>).kills, "number");
    assert.equal((await jf(`${base}/api/trim/preview`, { method: "POST", headers: stranger.auth, body: spec })).status, 403, "the screen's read is still needed");

    const trim = await jf(`${base}/api/trim`, { method: "POST", headers: viewer.auth, body: JSON.stringify({ categories: ["kills"], olderThanDays: 365, backup: false }) });
    assert.deepEqual(await askedFor(base, auth, trim), { capability: "admin.trim", serverId: null });
  });
});
