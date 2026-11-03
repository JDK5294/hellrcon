import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHllServer } from "./fake-hll-server.ts";
import { withServer, jf, assertAsked, askedFor } from "./harness.ts";

async function owner(base: string): Promise<{ auth: Record<string, string>; serverId: string }> {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = { authorization: `Bearer ${l.body.token as string}` };
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "g", host: "127.0.0.1", port: 1, password: "x" }) });
  return { auth, serverId: (created.body.server as { id: string }).id };
}

test("player groups: auth + capability gates, CRUD + membership round-trip", async () => {
  await withServer(async (base) => {
    const { auth } = await owner(base);

    assert.equal((await jf(`${base}/api/player-groups`)).status, 401);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    const denied = await jf(`${base}/api/player-groups`, { headers: plain });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.missing?.capability, "player.groups");
    // Creating one without the permission is asked for, not done.
    assertAsked(await jf(`${base}/api/player-groups`, { method: "POST", headers: plain, body: JSON.stringify({ name: "Asked" }) }));
    assert.deepEqual((await jf(`${base}/api/player-groups`, { headers: auth })).body.groups, [], "nothing was created");

    // Create; duplicate names (case-insensitive) are refused.
    assert.equal((await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({}) })).status, 400);
    const created = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Streamers", description: "cam candidates" }) });
    assert.equal(created.status, 201);
    const gid = created.body.group.id as string;
    assert.equal((await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "streamers" }) })).status, 409);

    // Membership: add, idempotent re-add (name refresh), list, per-player lookup, remove.
    assert.equal((await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({}) })).status, 400);
    const add = await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000001", playerName: "Kreitz" }) });
    assert.equal(add.status, 201);
    await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000002" }) });
    const readd = await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000001", playerName: "KREITZ" }) });
    assert.equal(readd.status, 201);
    assert.equal(readd.body.member.playerName, "KREITZ");

    const detail = await jf(`${base}/api/player-groups/${gid}`, { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.group.memberCount, 2);
    assert.deepEqual((detail.body.members as { playerId: string }[]).map((m) => m.playerId), ["76561198000000001", "76561198000000002"]);

    const mine = await jf(`${base}/api/player-groups/for/76561198000000001`, { headers: auth });
    assert.deepEqual((mine.body.groups as { id: string }[]).map((g) => g.id), [gid]);

    assert.equal((await jf(`${base}/api/player-groups/${gid}/members/76561198000000002`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/members/76561198000000002`, { method: "DELETE", headers: auth })).status, 404);

    // Rename (conflict guarded), then delete takes the members with it.
    const other = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Clan A" }) });
    assert.equal((await jf(`${base}/api/player-groups/${gid}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "clan a" }) })).status, 409);
    assert.equal((await jf(`${base}/api/player-groups/${gid}`, { method: "PUT", headers: auth, body: JSON.stringify({ name: "Casters" }) })).status, 200);
    assert.equal((await jf(`${base}/api/player-groups/${other.body.group.id}`, { method: "DELETE", headers: auth })).status, 200);
    const list = await jf(`${base}/api/player-groups`, { headers: auth });
    assert.deepEqual((list.body.groups as { name: string }[]).map((g) => g.name), ["Casters"]);
  });
});

test("group apply: validation + capability before any RCON; unreachable server = 409, no stored grants", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const created = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Match roster" }) });
    const gid = created.body.group.id as string;

    // Empty group is refused before anything else is attempted.
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vip", serverId, comment: "event" }) })).status, 400);
    await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000001", playerName: "A" }) });

    // Unknown action / bad per-action input → 400 with no connection needed.
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "nuke", serverId }) })).status, 400);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vip", serverId, mode: "until", comment: "event" }) })).status, 400);
    // VIP without a comment: every VIP a person adds says who paid, what for, or which event.
    const silent = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vip", serverId, mode: "permanent" }) });
    assert.equal(silent.status, 400);
    assert.match(String(silent.body.error?.message ?? ""), /a comment is required for every VIP added/);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "consoleAdmin", serverId }) })).status, 400);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "tempban", serverId, hours: 0, reason: "x" }) })).status, 400);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "tempban", serverId, hours: 2 }) })).status, 400);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "message", serverId }) })).status, 400);
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vip", serverId: "nope", comment: "event" }) })).status, 404);

    // A user without the underlying action capability cannot do it themselves: it is asked for, under
    // the action's own permission, and nothing is granted.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain2", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain2", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    const deniedApply = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: plain, body: JSON.stringify({ action: "vip", serverId, comment: "event" }) });
    assert.equal((await askedFor(base, auth, deniedApply)).capability, "vip.grant");
    assert.deepEqual(await repo.vips.list(serverId), [], "nothing was granted");

    // Server observe/unreachable: per-member skipped, nothing applied → 409, and the VIP store stays empty.
    const res = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vip", serverId, mode: "permanent", comment: "event" }) });
    assert.equal(res.status, 409);
    assert.deepEqual(await repo.vips.list(serverId), []);

    // The removal counterparts are real actions with their own capability mapping…
    const deniedRevoke = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: plain, body: JSON.stringify({ action: "vipRevoke", serverId }) });
    assert.equal((await askedFor(base, auth, deniedRevoke)).capability, "vip.revoke");
    const deniedAdminRm = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: plain, body: JSON.stringify({ action: "consoleAdminRemove", serverId }) });
    assert.equal((await askedFor(base, auth, deniedAdminRm)).capability, "server.admins");

    // …and a revoke that never reached the game must not delete the tracked grant: the store
    // row is only removed after the game write succeeds, so a dead server loses nothing.
    await repo.vips.upsert({ serverId, playerId: "76561198000000001", playerName: "A", comment: null, expiration: null, createdByUserId: null, createdByName: "owner" });
    const revokeRes = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vipRevoke", serverId }) });
    assert.equal(revokeRes.status, 409, "unreachable server applies nothing");
    assert.ok(await repo.vips.get(serverId, "76561198000000001"), "tracked VIP survives a failed revoke");
  });
});

test("bulk actions endpoint: validation + capability + observe short-circuit, before any RCON", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    const players = [{ playerId: "76561198000000001", playerName: "A" }, { playerId: "76561198000000002" }];

    assert.equal((await jf(`${base}/api/servers/${serverId}/actions/bulk`, { method: "POST", body: JSON.stringify({ action: "kick", players }) })).status, 401);
    assert.equal((await jf(`${base}/api/servers/nope/actions/bulk`, { method: "POST", headers: auth, body: JSON.stringify({ action: "kick", players }) })).status, 404);
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions/bulk`, { method: "POST", headers: auth, body: JSON.stringify({ action: "nuke", players }) })).status, 400);
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions/bulk`, { method: "POST", headers: auth, body: JSON.stringify({ action: "kick", players: [] }) })).status, 400);
    // Required fields still enforced (message needs message, tempban needs hours).
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions/bulk`, { method: "POST", headers: auth, body: JSON.stringify({ action: "message", players }) })).status, 400);
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions/bulk`, { method: "POST", headers: auth, body: JSON.stringify({ action: "tempban", players, reason: "x" }) })).status, 400);

    // A user without that action's capability cannot run it: it is asked for under the action's own cap.
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plainb", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plainb", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };
    const denied = await jf(`${base}/api/servers/${serverId}/actions/bulk`, { method: "POST", headers: plain, body: JSON.stringify({ action: "kick", players, reason: "x" }) });
    const asked = await askedFor(base, auth, denied);
    assert.equal(asked.capability, "action.kick");
    assert.equal(asked.serverId, serverId);

    // Observe-mode server: refused up front, before any connection is attempted.
    assert.equal((await jf(`${base}/api/servers/${serverId}/actions/bulk`, { method: "POST", headers: auth, body: JSON.stringify({ action: "kick", players, reason: "bye" }) })).status, 409);
  });
});

test("group apply: a server-scoped grant works on its server, and all-servers is not gated on the pinned one", async () => {
  await withServer(async (base) => {
    const { auth, serverId: serverA } = await owner(base);
    const b = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "g2", host: "127.0.0.1", port: 2, password: "x" }) });
    const serverB = (b.body.server as { id: string }).id;

    const created = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Casters B" }) });
    const gid = created.body.group.id as string;
    await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000009", playerName: "S" }) });

    // Staff member: console-admin rights on server B ONLY.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "scoped", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ grants: [
        { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
        { capability: "server.admins", level: "write", scopeType: "server", scopeId: serverB },
      ] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "scoped", password: "pw" }) });
    const scoped = { authorization: `Bearer ${l.body.token as string}` };
    const applyBody = (extra: Record<string, unknown>) => JSON.stringify({ action: "consoleAdmin", group: "spectator", mode: "permanent", ...extra });

    // Aiming at server A (no rights there) is asked for, at server A; aiming at server B is allowed —
    // it only fails later because the fake game server is unreachable (409, not 403).
    const onA = await askedFor(base, auth, await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: scoped, body: applyBody({ serverId: serverA }) }));
    assert.deepEqual(onA, { capability: "server.admins", serverId: serverA });
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: scoped, body: applyBody({ serverId: serverB }) })).status, 409);
    // All-servers used to be gated on the BASE server's permission, refusing this user outright
    // even though the target filter would have kept only server B. Now it gates on holding the
    // capability anywhere, and the filter does the scoping.
    assert.equal((await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: scoped, body: applyBody({ serverId: serverA, allServers: true }) })).status, 409);
  });
});

/**
 * Messaging a group leaves a trail.
 *
 * Every other branch of the bulk-apply loop records its decision — VIP, console admin, temp ban,
 * team switch — and the message branch did not, so the one bulk action a player is actually told
 * about was the one nobody could later be asked about. It also meant the Moderation → Warnings tab,
 * which reads `player.message` out of the trail, silently missed every group message.
 */
test("a group message is recorded in the audit trail, like every other bulk action", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const auth = { authorization: `Bearer ${l.body.token as string}` };

      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const srv = await repo.servers.create({ name: "msg", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);

      const made = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "squad" }) });
      const gid = (made.body.group as { id: string }).id;
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000501", playerName: "One" }) });
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000502", playerName: "Two" }) });

      const applied = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "message", serverId: srv.id, message: "keep it civil please" }),
      });
      assert.equal(applied.status, 200);
      const results = applied.body.results as { applied: unknown[] }[];
      assert.equal(results[0]!.applied.length, 2);

      // One entry per player, under the same action name the single-player route uses — so both
      // land in the same record rather than the bulk ones being filed somewhere else.
      const trail = await jf(`${base}/api/audit?actions=player.message`, { headers: auth });
      const entries = trail.body.entries as { targetId: string; summary: string; data?: Record<string, unknown> }[];
      assert.equal(entries.length, 2, "both group members are on the trail");
      assert.deepEqual(entries.map((e) => e.targetId).sort(), ["76561198000000501", "76561198000000502"]);
      assert.match(entries[0]!.summary, /keep it civil please/, "the trail records what was actually said");
      assert.equal(entries[0]!.data?.bulk, true, "and that it came from a group apply");
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

/**
 * Field incident: staff sent a group message with {player_name} and {vip_until} and every member
 * received the braces verbatim. Group messages now render per member — each player reads their
 * own name and their own VIP on the server the message went to — and the trail keeps both what
 * was typed and what was sent.
 */
test("a group message fills {player_name} and {vip_until} for each member", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const auth = { authorization: `Bearer ${l.body.token as string}` };

      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const srv = await repo.servers.create({ name: "msg", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      await repo.vips.upsert({ serverId: srv.id, playerId: "76561198000000601", name: "Paid", comment: "", expiration: null } as never);

      const made = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "vips" }) });
      const gid = (made.body.group as { id: string }).id;
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000601", playerName: "Paid" }) });
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000602", playerName: "Free" }) });

      const template = "Hi {player_name}, your VIP runs until {vip_until}.";
      const applied = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: auth, body: JSON.stringify({ action: "message", serverId: srv.id, message: template }),
      });
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      const got = new Map(fake!.messages.map((m) => [m.playerId, m.message]));
      assert.equal(got.get("76561198000000601"), "Hi Paid, your VIP runs until permanent.");
      assert.equal(got.get("76561198000000602"), "Hi Free, your VIP runs until no VIP.");
      for (const m of fake!.messages) assert.doesNotMatch(m.message, /\{/, "no braces reach a player");

      const trail = await jf(`${base}/api/audit?actions=player.message`, { headers: auth });
      const paid = (trail.body.entries as { targetId: string; data?: Record<string, unknown> }[]).find((e) => e.targetId === "76561198000000601")!;
      assert.equal(paid.data?.message, "Hi Paid, your VIP runs until permanent.", "the trail shows what the player actually read");
      assert.equal(paid.data?.template, template, "and what staff typed");
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

/**
 * The same, on the Vietnam server — and reaching back across the games. A Vietnam player's id is
 * an EOS id the WW2 server has never heard of, so "{vip_until:WW2}" has to find their WW2 account
 * through the Discord link registration made, exactly as the seed-reward bridge does.
 */
test("a Vietnam group message fills placeholders, including the member's WW2 VIP", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const auth = { authorization: `Bearer ${l.body.token as string}` };

      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const ww2 = await repo.servers.create({ name: "WW2", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port: 1, password: "pw", engagementMode: "active" } as never);
      const nam = await repo.servers.create({ name: "Vietnam", game: "hllv", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);

      // One person, two games: an EOS id on Vietnam, a Steam64 on WW2, joined by their Discord.
      const namRow = await repo.players.upsert({ game: "hllv", platform: "steam", platformId: "eos-0001", name: "Grunt" } as never);
      const ww2Row = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000777", name: "Grunt" } as never);
      await repo.externalLinks.set(namRow.id, "discord", "555000111", "registration");
      await repo.externalLinks.set(ww2Row.id, "discord", "555000111", "registration");
      await repo.vips.upsert({ serverId: ww2.id, playerId: "76561198000000777", expiration: null } as never);

      const made = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "nam squad" }) });
      const gid = (made.body.group as { id: string }).id;
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "eos-0001", playerName: "Grunt" }) });

      const applied = await jf(`${base}/api/player-groups/${gid}/apply`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "message", serverId: nam.id, message: "{player_name}: Vietnam VIP {vip_until}, WW2 VIP {vip_until:WW2}" }),
      });
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.deepEqual(fake!.messages.map((m) => m.message), ["Grunt: Vietnam VIP no VIP, WW2 VIP permanent"]);
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

/*
 * A group move BY SIDE needs to know which raw team number is which side. With the teams' numbers
 * both mapping to one side and even headcounts, the resolver can only guess — and a backwards
 * guess moves everyone already on the target side away. The move is refused instead of guessed.
 */
test("a group team switch refuses rather than guess which team is which", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
      const auth = { authorization: `Bearer ${l.body.token as string}` };
      fake = new FakeHllServer("pw");
      // Team values 1 and 3 are both listed as Allies, one player each, and the session's
      // headcounts are equal: nothing tells the two teams apart.
      fake.players = [
        { iD: "76561198000000601", name: "One", team: 1 },
        { iD: "76561198000000602", name: "Two", team: 3 },
      ];
      fake.session = { alliedPlayerCount: 1, axisPlayerCount: 1 };
      const port = await fake.listen();
      const srv = await repo.servers.create({ name: "sw", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const made = await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "movers" }) });
      const gid = (made.body.group as { id: string }).id;
      for (const [id, name] of [["76561198000000601", "One"], ["76561198000000602", "Two"]]) {
        await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: id, playerName: name }) });
      }
      const res = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "switch", serverId: srv.id, side: "axis" }) });
      assert.equal(res.status, 409, "nothing applied — nobody was moved on a guess");
      assert.match(String(res.body.error?.message ?? ""), /can't tell which team is which/, "and the reason is named");
      assert.ok(!fake.received.some((c) => /switch/i.test(c)), "no switch command reached the game");
    });
  } finally {
    (fake as FakeHllServer | null)?.close();
  }
});
