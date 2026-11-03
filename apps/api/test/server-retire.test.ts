/**
 * Staged server retirement, end to end: a retired server leaves the default list (and with it
 * every picker, worker and Discord surface), keeps a STABLE number for the others, stays fully
 * resolvable for history (an old trigger scoped to it keeps its name), and comes back whole.
 * Nothing about its data is touched — retirement is a visibility fact, not a deletion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth, askedFor } from "./harness.ts";

test("retire: hidden by default, stable numbering, history names intact, reversible", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string, port: number) =>
      (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x" }) })).body.server.id as string;
    await mk("Alpha", 11);
    const b = await mk("Bravo", 12);
    const c = await mk("Charlie", 13);

    // A trigger scoped to Bravo BEFORE retirement — the history that must stay readable after.
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000300", name: "Vet" });
    await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "hi", serverId: b }),
    });

    const r = await jf(`${base}/api/servers/${b}/retire`, { method: "POST", headers: auth });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.server.retiredAt, "the stamp says since when");

    // Gone from the default list — the same list every picker, worker and Discord module reads…
    const dflt = (await jf(`${base}/api/servers`, { headers: auth })).body.servers as { id: string; name: string; no: number }[];
    assert.deepEqual(dflt.map((s) => s.name), ["Alpha", "Charlie"]);
    // …and Charlie KEEPS his number: retiring server 2 must not renumber server 3 in anyone's head.
    assert.equal(dflt.find((s) => s.id === c)!.no, 3);

    // The Connections tab still sees it, marked.
    const withRet = (await jf(`${base}/api/servers?includeRetired=1`, { headers: auth })).body.servers as { id: string; retiredAt: string | null; no: number }[];
    assert.equal(withRet.length, 3);
    const bravo = withRet.find((s) => s.id === b)!;
    assert.ok(bravo.retiredAt);
    assert.equal(bravo.no, 2);

    // History keeps its name: the trigger overview still says "Bravo", not a raw id.
    const all = (await jf(`${base}/api/player-triggers`, { headers: auth })).body.triggers as { serverId: string | null; serverName: string | null }[];
    assert.equal(all.find((t) => t.serverId === b)!.serverName, "Bravo");

    // The receipts say what happened.
    const audits = await repo.audit.list({ actions: ["server.retire"] });
    assert.match(audits[0]!.summary, /retired Bravo/);
    assert.match(audits[0]!.summary, /every record kept/);

    // And it comes back whole.
    assert.equal((await jf(`${base}/api/servers/${b}/unretire`, { method: "POST", headers: auth })).status, 200);
    const back = (await jf(`${base}/api/servers`, { headers: auth })).body.servers as { name: string; no: number }[];
    assert.deepEqual(back.map((s) => s.name), ["Alpha", "Bravo", "Charlie"]);
    assert.equal((await repo.audit.list({ actions: ["server.unretire"] })).length, 1);
  });
});

test("decommission + delete: the setup account alone holds stages 2 and 3, and user history outlives the end", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base); // the FIRST login this install created — the setup account
    const mk = async (name: string, port: number) =>
      (await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x" }) })).body.server.id as string;
    const keeper = await mk("Keeper", 21);
    const goner = await mk("Goner", 22);

    // A second admin holding EVERY grant the permission editor can hand out — the point of the
    // gate is that none of it matters for stages 2 and 3.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "admin2", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [
        { capability: "server.manage", level: "write", scopeType: "global", scopeId: null },
        { capability: "admin.users", level: "write", scopeType: "global", scopeId: null },
        { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
      ] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin2", password: "pw" }) });
    const admin = { authorization: `Bearer ${l.body.token as string}` };

    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000400", name: "Regular" });
    // Parallel records on BOTH servers — the delete must take only the goner's.
    await repo.vips.upsert({ serverId: goner, playerId: player.platformId, playerName: "Regular", comment: "paid", expiration: null, createdByName: "staff" });
    await repo.vips.upsert({ serverId: keeper, playerId: player.platformId, playerName: "Regular", comment: "paid", expiration: null, createdByName: "staff" });
    const goneTrig = await repo.playerTriggers.create({ playerId: player.id, playerName: "Regular", serverId: goner, event: "connect", steps: [{ action: "message", message: "hi", hours: 0, points: 0, delaySec: 0 }], fireOnce: true, createdByName: "staff" });
    const keptTrig = await repo.playerTriggers.create({ playerId: player.id, playerName: "Regular", serverId: keeper, event: "connect", steps: [{ action: "message", message: "hi", hours: 0, points: 0, delaySec: 0 }], fireOnce: true, createdByName: "staff" });
    await repo.matches.open({ serverId: goner, map: "foy_warfare", startedAt: new Date().toISOString() });
    // USER history on the goner: a career, and a moderation record beside an ordinary kill.
    await repo.stats.bump(player.id, goner, { kills: 7, deaths: 2 });
    await repo.events.insert([
      { serverId: goner, ts: new Date().toISOString(), kind: "evt.player.kicked", actorPlayerId: player.id, actorName: "Regular", dedupeKey: "t-kick" },
      { serverId: goner, ts: new Date().toISOString(), kind: "evt.kill", actorPlayerId: player.id, actorName: "Regular", victimName: "Other", dedupeKey: "t-kill" },
    ]);

    // Stage order is the law: a LIVE server cannot be erased, even by the setup account.
    const early = await jf(`${base}/api/servers/${goner}`, { method: "DELETE", headers: owner });
    assert.equal(early.status, 409);
    assert.match(JSON.stringify(early.body), /retire the server first/);

    // Stage 1 is any connection manager's — admin2 parks it.
    assert.equal((await jf(`${base}/api/servers/${goner}/retire`, { method: "POST", headers: admin })).status, 200);
    // …but merely retired is not enough for the end.
    const notYet = await jf(`${base}/api/servers/${goner}`, { method: "DELETE", headers: owner });
    assert.equal(notYet.status, 409);
    assert.match(JSON.stringify(notYet.body), /decommission the server first/);

    // Stages 2 and 3 answer to WHO you are, not what you hold: every grant, still 403.
    const deniedDecom = await jf(`${base}/api/servers/${goner}/decommission`, { method: "POST", headers: admin });
    assert.equal(deniedDecom.status, 403);
    assert.match(JSON.stringify(deniedDecom.body), /setup account/);
    assert.equal((await jf(`${base}/api/servers/${goner}`, { method: "DELETE", headers: admin })).status, 403);

    // The setup account decommissions it — and it stops existing for anyone else, however they ask.
    const decom = await jf(`${base}/api/servers/${goner}/decommission`, { method: "POST", headers: owner });
    assert.equal(decom.status, 200, JSON.stringify(decom.body));
    assert.ok(decom.body.server.decommissionedAt);
    const adminSees = (await jf(`${base}/api/servers?includeRetired=1`, { headers: admin })).body;
    assert.equal(adminSees.isSetupUser, false);
    assert.equal((adminSees.servers as { id: string }[]).some((s) => s.id === goner), false, "gone from everyone else's Connections");
    const ownerSees = (await jf(`${base}/api/servers?includeRetired=1`, { headers: owner })).body;
    assert.equal(ownerSees.isSetupUser, true);
    assert.ok((ownerSees.servers as { id: string; decommissionedAt: string | null }[]).find((s) => s.id === goner)!.decommissionedAt);
    // The ladder unwinds in order too: no manager can yank a stage-2 server back live — and for
    // them the answer is the same 404 a wrong id gets, never a 409 that would confirm it exists.
    assert.equal((await jf(`${base}/api/servers/${goner}/unretire`, { method: "POST", headers: admin })).status, 404);
    // The setup account, who can see it, gets the honest state instead: recommission first.
    const yank = await jf(`${base}/api/servers/${goner}/unretire`, { method: "POST", headers: owner });
    assert.equal(yank.status, 409);
    assert.match(JSON.stringify(yank.body), /recommission/);

    // Reversible: recommission puts it back under Retired servers for everyone…
    assert.equal((await jf(`${base}/api/servers/${goner}/recommission`, { method: "POST", headers: owner })).status, 200);
    assert.ok(((await jf(`${base}/api/servers?includeRetired=1`, { headers: admin })).body.servers as { id: string }[]).some((s) => s.id === goner));
    // …and the final step requires taking stage 2 again.
    await jf(`${base}/api/servers/${goner}/decommission`, { method: "POST", headers: owner });
    const del = await jf(`${base}/api/servers/${goner}`, { method: "DELETE", headers: owner });
    assert.equal(del.status, 200, JSON.stringify(del.body));

    // Gone: the row, its match, its VIP (paid included — the confirm said so), its scoped trigger.
    assert.equal(await repo.servers.findById(goner), null);
    assert.equal(await repo.matches.getOpen(goner), null);
    assert.equal(await repo.vips.get(goner, player.platformId), null);
    assert.equal(await repo.playerTriggers.get(goneTrig.id), null);

    // USER HISTORY IS FOREVER: the career and the moderation record survive the final delete;
    // the ordinary kill event went with the server.
    const career = await repo.stats.get(player.id, goner);
    assert.equal(career?.kills, 7, "careers earned there keep counting");
    const kinds = (await repo.events.listByPlayer(player.id)).map((e) => e.kind);
    assert.ok(kinds.includes("evt.player.kicked"), "the moderation record stays on the profile");
    assert.ok(!kinds.includes("evt.kill"), "ordinary game events belonged to the server");

    // In its lane: the other server's records and the player identity are untouched.
    assert.ok(await repo.servers.findById(keeper));
    assert.ok(await repo.vips.get(keeper, player.platformId), "the keeper's paid VIP is exactly where it was");
    assert.ok(await repo.playerTriggers.get(keptTrig.id));
    assert.ok(await repo.players.findById(player.id), "the person is community data, not server data");

    // The audit trail outlives the server — the stage receipts and the deletion's own.
    assert.equal((await repo.audit.list({ actions: ["server.decommission"] })).length, 2);
    assert.equal((await repo.audit.list({ actions: ["server.recommission"] })).length, 1);
    const receipt = (await repo.audit.list({ actions: ["server.delete"] }))[0]!;
    assert.match(receipt.summary, /PERMANENTLY deleted decommissioned server Goner/);
    assert.match(receipt.summary, /User history is forever/);
  });
});

test("a decommissioned server has no side door: a saved UUID writes nothing, reads stay open", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const sid = (await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Hidden", host: "127.0.0.1", port: 31, password: "x" }) })).body.server.id as string;

    // A staff member who held every relevant grant BEFORE the decommission — and kept the UUID.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "keeper2", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [
        { capability: "server.manage", level: "write", scopeType: "global", scopeId: null },
        { capability: "server.engagement", level: "write", scopeType: "global", scopeId: null },
        { capability: "vip.grant", level: "write", scopeType: "global", scopeId: null },
        { capability: "crcon.pull", level: "write", scopeType: "global", scopeId: null },
        { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
      ] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "keeper2", password: "pw" }) });
    const admin = { authorization: `Bearer ${l.body.token as string}` };

    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000500", name: "Vip" });
    await repo.vips.upsert({ serverId: sid, playerId: player.platformId, playerName: "Vip", comment: "paid", expiration: null, createdByName: "staff" });

    // An ask FILED while the server was live — the one write that could otherwise still land
    // after the decommission, because signing replays the handler past the route's own checks.
    await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "asker2", password: "pw" }) });
    const al = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "asker2", password: "pw" }) });
    const filed = await jf(`${base}/api/servers/${sid}/maps/objective-points`, {
      method: "PUT", headers: { authorization: `Bearer ${al.body.token as string}` },
      body: JSON.stringify({ mapKey: "carentan", row: 0, idx: 0, name: "late teach" }),
    });
    assert.equal(filed.status, 202, JSON.stringify(filed.body));

    await jf(`${base}/api/servers/${sid}/retire`, { method: "POST", headers: owner });
    await jf(`${base}/api/servers/${sid}/decommission`, { method: "POST", headers: owner });

    // Every write answers the same 404 a wrong id would — not a 403, which would confirm the
    // server exists, and never a 202 request capture either.
    const writes: [string, string, string][] = [
      ["PUT", `/api/servers/${sid}/connection`, JSON.stringify({ host: "9.9.9.9" })],
      ["POST", `/api/servers/${sid}/engagement`, JSON.stringify({ mode: "active" })],
      ["POST", `/api/servers/${sid}/vips`, JSON.stringify({ playerId: player.platformId, playerName: "Vip", mode: "permanent" })],
      ["POST", `/api/servers/${sid}/purge`, "{}"],
      ["POST", `/api/servers/${sid}/unretire`, "{}"], // a 409 here used to say "it exists, and it is decommissioned"
      ["PUT", `/api/servers/${sid}/mapvote/config`, JSON.stringify({ enabled: false })], // the serverRoute kit path
    ];
    for (const [method, path, body] of writes) {
      const r = await jf(`${base}${path}`, { method, headers: admin, body });
      assert.equal(r.status, 404, `${method} ${path} answered ${r.status}: ${JSON.stringify(r.body)}`);
    }
    // Nothing moved: the paid VIP is exactly where it was, the connection unchanged.
    assert.ok(await repo.vips.get(sid, player.platformId));
    assert.equal((await repo.servers.findById(sid))!.host, "127.0.0.1");

    // Reads stay open — decommissioning keeps records retrievable; it is the CHANGING that stops.
    assert.equal((await jf(`${base}/api/servers/${sid}/matches`, { headers: admin })).status, 200);

    // The pre-decommission ask refuses to land even with the OWNER's signature: a decommissioned
    // server takes no queued writes — the state now decides, not the state at filing.
    const req = (await jf(`${base}/api/requests/${filed.body.requestId}`, { headers: owner })).body.request as { id: string; lines: { id: string }[] };
    const signed = await jf(`${base}/api/requests/${req.id}/lines/${req.lines[0]!.id}/approve`, { method: "POST", headers: owner, body: "{}" });
    assert.match(String(signed.body.applyError), /decommissioned/, JSON.stringify(signed.body));
    // Straight from the store — the objectives GET route reads the live game, not the database.
    assert.deepEqual(await repo.objectivePoints.forMap("hll", "carentan"), [], "nothing was taught");

    // And for the setup account nothing is hidden: writes work, and the ladder still answers.
    assert.equal((await jf(`${base}/api/servers/${sid}/connection`, { method: "PUT", headers: owner, body: JSON.stringify({ host: "10.0.0.1" }) })).status, 200);
    const yank = await jf(`${base}/api/servers/${sid}/unretire`, { method: "POST", headers: owner });
    assert.equal(yank.status, 409);
    assert.match(JSON.stringify(yank.body), /recommission/);
  });
});

test("the setup account cannot be deleted — the lifecycle keys are not up for grabs", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const ownerRow = (await repo.users.findByUsername("owner"))!;
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "usurper", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "admin.users", level: "write", scopeType: "global", scopeId: null }] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "usurper", password: "pw" }) });
    const usurper = { authorization: `Bearer ${l.body.token as string}` };

    // Deleting the first login would pass firstUserId — and with it decommission + delete — to
    // the next-oldest account. admin.users write is exactly "a permission", and no permission
    // may hold the keys.
    const del = await jf(`${base}/api/users/${ownerRow.id}`, { method: "DELETE", headers: usurper });
    assert.equal(del.status, 400, JSON.stringify(del.body));
    assert.match(JSON.stringify(del.body), /setup account/);
    assert.ok(await repo.users.findById(ownerRow.id), "the anchor is still there");
    assert.equal(await repo.users.firstUserId(), ownerRow.id);
  });
});

test("retire is gated by server.manage write — viewing staff can only ask to park a server", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const sid = (await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "S", host: "127.0.0.1", port: 14, password: "x" }) })).body.server.id as string;
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "viewer", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "server.view", level: "read", scopeType: "global", scopeId: null }] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "viewer", password: "pw" }) });
    const viewer = { authorization: `Bearer ${l.body.token as string}` };
    const asked = await jf(`${base}/api/servers/${sid}/retire`, { method: "POST", headers: viewer });
    assert.deepEqual(await askedFor(base, owner, asked), { capability: "server.manage", serverId: sid });
    assert.equal((await repo.servers.findById(sid))!.retiredAt, null, "not parked on the asking");
  });
});
