/**
 * The player-trigger CRUD routes, end to end — the headline "message on reconnect", the
 * capability floor (you can only build what you could do by hand), and the one-shot lifecycle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth, askedFor } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const r = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "S", host: "127.0.0.1", port: 1, password: "x" }) });
  return r.body.server.id as string;
}
async function staff(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string }[]) {
  const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: owner, body: JSON.stringify({ grants: grants.map((g) => ({ scopeType: "global", scopeId: null, ...g })) }) });
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

test("the headline case: arm a one-time welcome message on reconnect, then it disarms", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000200", name: "Returner" });

    const create = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ event: "connect", action: "message", message: "Welcome back {player_name}!", fireOnce: true }),
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    const id = create.body.trigger.id as string;

    // It reads back as armed, once, on any server.
    const list = await jf(`${base}/api/players/${player.id}/triggers`, { headers: auth });
    assert.equal(list.body.triggers.length, 1);
    assert.equal(list.body.triggers[0].fireOnce, true);
    assert.equal(list.body.triggers[0].serverId, null);
    assert.match(list.body.triggers[0].summary, /on connect, message \(once\)/);

    // Simulate the firing the runner would do (disarm=true), and confirm the row becomes a receipt.
    await repo.playerTriggers.recordFire(id, true, new Date().toISOString());
    const after = await jf(`${base}/api/players/${player.id}/triggers`, { headers: auth });
    assert.equal(after.body.triggers[0].firedCount, 1);
    assert.ok(after.body.triggers[0].disarmedAt, "a fired one-shot is disarmed");
    // And it is no longer in the armed set the runner loads.
    assert.equal((await repo.playerTriggers.listArmed()).length, 0);
  });
});

test("you can only build what you could do by hand — the action's own capability gates creation", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    await makeServer(base, owner);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000201", name: "Target" });

    // A staff member who can message and see the directory, but cannot ban.
    const messenger = await staff(base, owner, "messenger", [
      { capability: "server.view", level: "read" },
      { capability: "action.message", level: "write" },
    ]);

    // The list tells them which actions they may build.
    const listed = await jf(`${base}/api/players/${player.id}/triggers`, { headers: messenger });
    assert.deepEqual([...listed.body.allowedActions].sort(), ["message"]);

    // Message: allowed.
    const ok = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: messenger, body: JSON.stringify({ event: "connect", action: "message", message: "hi" }),
    });
    assert.equal(ok.status, 201);

    // Perma ban: not theirs to build — they do not hold action.permaban, so it is asked of someone
    // who does, and nothing is built on the asking.
    const denied = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: messenger, body: JSON.stringify({ event: "teamkill", action: "permaban", message: "gone" }),
    });
    assert.deepEqual(await askedFor(base, owner, denied), { capability: "action.permaban", serverId: null });
    assert.deepEqual((await repo.playerTriggers.listByPlayer(player.id)).map((t) => t.steps[0]!.action), ["message"]);

    // The owner (all caps) may build the ban.
    const byOwner = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: owner, body: JSON.stringify({ event: "teamkill", action: "tempban", message: "no TK", hours: 6 }),
    });
    assert.equal(byOwner.status, 201, JSON.stringify(byOwner.body));
  });
});

test("validation: a VIP trigger needs hours, points needs points, a message needs text", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000202", name: "V" });
    const bad = (body: object) => jf(`${base}/api/players/${player.id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    assert.equal((await bad({ event: "connect", action: "vip", hours: 0 })).status, 400);
    assert.equal((await bad({ event: "connect", action: "points", points: 0 })).status, 400);
    assert.equal((await bad({ event: "connect", action: "message", message: "" })).status, 400);
    assert.equal((await bad({ event: "nope", action: "message", message: "x" })).status, 400);
    // "punished" is not buildable — the live game log has no PUNISH line to fire it.
    assert.equal((await bad({ event: "punished", action: "message", message: "x" })).status, 400);
    // A trigger must not cause the very line it fires on.
    const loop = await bad({ event: "banned", action: "tempban", message: "no", hours: 2 });
    assert.equal(loop.status, 400);
    assert.match(JSON.stringify(loop.body), /fires the trigger again/);
    // A valid VIP trigger with hours is accepted.
    assert.equal((await bad({ event: "connect", action: "vip", hours: 24 })).status, 201);
  });
});

test("disable, re-arm and delete round-trip; a foreign trigger id is a 404", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000203", name: "Round" });
    const other = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000204", name: "Other" });
    const id = (await jf(`${base}/api/players/${player.id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify({ event: "kill", action: "message", message: "nice" }) })).body.trigger.id;

    assert.equal((await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) })).body.trigger.enabled, false);
    assert.equal((await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: true }) })).body.trigger.enabled, true);
    // Someone else's player path must not reach this trigger.
    assert.equal((await jf(`${base}/api/players/${other.id}/triggers/${id}`, { method: "DELETE", headers: auth })).status, 404);
    assert.equal((await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jf(`${base}/api/players/${player.id}/triggers`, { headers: auth })).body.triggers.length, 0);
  });
});

test("a chain: several actions in one trigger, each with its own delay — and the summary says so", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000205", name: "Chained" });
    const r = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ event: "connect", steps: [
        { action: "message", message: "Welcome back {player_name}" },
        { action: "vip", hours: 72 },
        { action: "kick", message: "changed our minds", delaySec: 60 },
      ] }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.trigger.summary ?? (await jf(`${base}/api/players/${player.id}/triggers`, { headers: auth })).body.triggers[0].summary,
      /message \+ grant 72h VIP \+ wait 60s, then kick \(once\)/);
  });
});

test("a chain needs EVERY step's capability — one missing action denies the whole trigger", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    await makeServer(base, owner);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000206", name: "T" });
    const messenger = await staff(base, owner, "chainless", [
      { capability: "server.view", level: "read" },
      { capability: "action.message", level: "write" },
    ]);
    const denied = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: messenger,
      body: JSON.stringify({ event: "connect", steps: [
        { action: "message", message: "hello" },
        { action: "tempban", message: "and goodbye", hours: 2 },
      ] }),
    });
    assert.deepEqual(await askedFor(base, owner, denied), { capability: "action.tempban", serverId: null }, "holding action.message does not smuggle in a tempban");
    // The newer actions gate on their own trust too: watchlist, VIP removal, the economy debit.
    for (const [action, body, capability] of [
      ["watch", { action: "watch", message: "sus" }, "player.watchlist"],
      ["vipremove", { action: "vipremove" }, "vip.revoke"],
      ["takepoints", { action: "takepoints", points: 10 }, "economy.balances"],
      ["switch", { action: "switch" }, "action.switch"],
    ] as const) {
      const r = await jf(`${base}/api/players/${player.id}/triggers`, {
        method: "POST", headers: messenger, body: JSON.stringify({ event: "connect", steps: [body] }),
      });
      assert.deepEqual(await askedFor(base, owner, r), { capability, serverId: null }, `${action} must not ride on action.message`);
    }
    assert.deepEqual(await repo.playerTriggers.listByPlayer(player.id), [], "nothing was built on the asking");
  });
});

test("arming, disabling and deleting take hold NOW — the runner's armed set follows every mutation", async () => {
  await withServer(async (base, repo, ctx) => {
    const auth = await ownerAuth(base);
    const serverId = await makeServer(base, auth); // fresh servers are observe → firings are dry runs
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000209", name: "Now" });
    const connect = { kind: "evt.player.connected", serverId, actorPlayerId: player.id, actorName: "Now" };
    const dryruns = async () => (await repo.audit.list({ actions: ["trigger.dryrun"] })).length;

    // Armed a moment ago, fires on the very next connect — no waiting out the 10s refresh timer.
    const id = (await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "hi", fireOnce: false }),
    })).body.trigger.id as string;
    await ctx.playerTriggerRunner.onEvent(connect as never);
    assert.equal(await dryruns(), 1, "a just-armed trigger is already in the armed set");

    // Disabled a moment ago, silent on the very next connect.
    await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: false }) });
    await ctx.playerTriggerRunner.onEvent(connect as never);
    assert.equal(await dryruns(), 1, "a just-disabled trigger cannot fire out of the stale set");

    // Re-armed and then deleted: the delete wins immediately too.
    await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ enabled: true }) });
    await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "DELETE", headers: auth });
    await ctx.playerTriggerRunner.onEvent(connect as never);
    assert.equal(await dryruns(), 1, "a just-deleted trigger cannot fire out of the stale set");
  });
});

test("the overview lists EVERY player's triggers, armed first — no guessing whose it was", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const ana = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000210", name: "Ana" });
    const bob = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000211", name: "Bob" });
    await jf(`${base}/api/players/${ana.id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "hi Ana" }) });
    const spentId = (await jf(`${base}/api/players/${bob.id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify({ event: "kill", action: "message", message: "nice" }) })).body.trigger.id as string;
    await repo.playerTriggers.recordFire(spentId, true, new Date().toISOString());

    assert.equal((await jf(`${base}/api/player-triggers`)).status, 401, "no anonymous read");
    const all = await jf(`${base}/api/player-triggers`, { headers: auth });
    assert.equal(all.status, 200);
    const mine = (all.body.triggers as { playerId: string; playerName: string | null; summary: string; disarmedAt: string | null }[])
      .filter((t) => t.playerId === ana.id || t.playerId === bob.id);
    assert.equal(mine.length, 2, "both players' triggers in one list");
    assert.deepEqual(mine.map((t) => [t.playerName, t.disarmedAt === null]), [["Ana", true], ["Bob", false]],
      "named per player, and the armed one sorts before the spent one");
    assert.match(mine[0]!.summary, /on connect, message/);
  });
});

test("the overview is a per-SERVER read: one server's staff never see another's trigger plans", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const mk = async (name: string, port: number) =>
      (await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name, host: "127.0.0.1", port, password: "x" }) })).body.server.id as string;
    const alpha = await mk("Alpha", 41);
    const bravo = await mk("Bravo", 42);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000260", name: "Subject" });

    // Three standing instructions about the same person: one per server, one that follows them.
    const trig = async (serverId: string | null, message: string) =>
      (await jf(`${base}/api/players/${player.id}/triggers`, {
        method: "POST", headers: owner,
        body: JSON.stringify({ event: "connect", action: "message", message, ...(serverId ? { serverId } : {}) }),
      })).body.trigger.id as string;
    const onAlpha = await trig(alpha, "on Alpha");
    const onBravo = await trig(bravo, "on Bravo");
    const anywhere = await trig(null, "anywhere");

    // Staff trusted with ALPHA alone. A trigger names a player and what will be done to them, so
    // Bravo's plans are Bravo's staff's business — holding server.view somewhere is not a key to
    // every server's moderation plans.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "alpha-only", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "server.view", level: "read", scopeType: "server", scopeId: alpha }] }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "alpha-only", password: "pw" }) });
    const scoped = { authorization: `Bearer ${l.body.token as string}` };

    const idsSeenBy = async (headers: Record<string, string>, url: string) =>
      ((await jf(`${base}${url}`, { headers })).body.triggers as { id: string }[]).map((t) => t.id).sort();

    // The overview, and the profile tab — a profile is not a way around the same rule.
    for (const url of ["/api/player-triggers", `/api/players/${player.id}/triggers`]) {
      assert.deepEqual(await idsSeenBy(scoped, url), [onAlpha, anywhere].sort(),
        `${url}: their own server's trigger and the follow-them-anywhere one, never Bravo's`);
      assert.deepEqual(await idsSeenBy(owner, url), [onAlpha, onBravo, anywhere].sort(),
        `${url}: somebody who may see every server still sees every trigger`);
    }

    // Stage 2 reaches the overview too: a decommissioned server is gone for every account but the
    // setup one, so its rows stop naming it to everyone else.
    const admin = await staff(base, owner, "all-servers", [{ capability: "server.view", level: "read" }]);
    assert.deepEqual(await idsSeenBy(admin, "/api/player-triggers"), [onAlpha, onBravo, anywhere].sort(), "global read sees Bravo's while it is live");
    await jf(`${base}/api/servers/${bravo}/retire`, { method: "POST", headers: owner });
    await jf(`${base}/api/servers/${bravo}/decommission`, { method: "POST", headers: owner });
    assert.deepEqual(await idsSeenBy(admin, "/api/player-triggers"), [onAlpha, anywhere].sort(),
      "the decommissioned server's trigger goes with the server it belongs to");
    assert.deepEqual(await idsSeenBy(owner, "/api/player-triggers"), [onAlpha, onBravo, anywhere].sort(),
      "the setup account keeps the whole picture — nothing was deleted");

    // And it cannot be re-scoped onto a server that no longer exists for you.
    const late = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: admin, body: JSON.stringify({ event: "connect", action: "message", message: "late", serverId: bravo }),
    });
    assert.equal(late.status, 404, JSON.stringify(late.body));
  });
});

test("the per-role temp-ban hour cap holds for triggers — no longer than by hand", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const serverId = await makeServer(base, owner);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000208", name: "Capped" });
    // A moderator whose by-hand temp-bans top out at 24 hours.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "capped-mod", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({
        grants: [
          { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
          { capability: "action.tempban", level: "write", scopeType: "global", scopeId: null },
        ],
        limits: { "tempban.maxHours": 24 },
      }),
    });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "capped-mod", password: "pw" }) });
    const mod = { authorization: `Bearer ${l.body.token as string}` };

    // Past the cap: refused on a scoped trigger AND on an any-server one.
    const over = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: mod,
      body: JSON.stringify({ event: "teamkill", action: "tempban", message: "tk", hours: 100, serverId }),
    });
    assert.equal(over.status, 400, JSON.stringify(over.body));
    assert.match(JSON.stringify(over.body), /temp-ban limit is 24h/);
    const overAnywhere = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: mod,
      body: JSON.stringify({ event: "teamkill", action: "tempban", message: "tk", hours: 100 }),
    });
    assert.equal(overAnywhere.status, 400, "an any-server trigger answers to the cap too");
    // Within the cap it arms.
    const ok = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: mod,
      body: JSON.stringify({ event: "teamkill", action: "tempban", message: "tk", hours: 12 }),
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });
});

test("bounds: at most 5 steps, and a step's delay tops out at an hour", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000207", name: "B" });
    const msg = { action: "message", message: "x" };
    const six = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth, body: JSON.stringify({ event: "connect", steps: [msg, msg, msg, msg, msg, msg] }),
    });
    assert.equal(six.status, 400);
    const slow = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth, body: JSON.stringify({ event: "connect", steps: [{ ...msg, delaySec: 999999 }] }),
    });
    assert.equal(slow.status, 400, "a delay past the restart-honesty bound is refused");
    // Delays ladder (run back to back), so the bound holds on their SUM too.
    const ladder = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth, body: JSON.stringify({ event: "connect", steps: [{ ...msg, delaySec: 2000 }, { ...msg, delaySec: 2000 }] }),
    });
    assert.equal(ladder.status, 400, "each delay is legal alone, but the chain's total is past the hour");
  });
});

/*
 * Re-editing a trigger after it is made. Staff built "remove VIP on connect" rows and had no way
 * to change one short of deleting it and starting over (losing its history).
 */
test("a trigger can be re-edited: event, actions, scope, once/every and note — history kept", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const serverId = await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000300", name: "Critic" });
    const other = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000301", name: "Other" });
    const made = await jf(`${base}/api/players/${player.id}/triggers`, {
      method: "POST", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "hi", fireOnce: true, note: "old note" }),
    });
    const id = made.body.trigger.id as string;
    await repo.playerTriggers.recordFire(id, false, new Date().toISOString());

    const edited = await jf(`${base}/api/players/${player.id}/triggers/${id}`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ event: "death", steps: [{ action: "message", message: "{player_name}, watch out" }, { action: "kick", message: "bye", delaySec: 30 }], serverId, fireOnce: false, note: "new note" }),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const t = edited.body.trigger;
    assert.equal(t.id, id, "the same trigger, changed in place");
    assert.equal(t.event, "death");
    assert.deepEqual(t.steps.map((s: { action: string }) => s.action), ["message", "kick"]);
    assert.equal(t.serverId, serverId);
    assert.equal(t.fireOnce, false);
    assert.equal(t.note, "new note");
    assert.equal(t.firedCount, 1, "its fire history is kept");
    assert.equal(t.createdByName, made.body.trigger.createdByName, "and who made it");
    assert.ok(t.updatedAt && t.updatedByName, "who edited it, and when, is stamped");

    // The trail keeps what it was and what it became.
    const trail = await jf(`${base}/api/audit?actions=trigger.update`, { headers: auth });
    const row = (trail.body.entries as { data?: { before?: { event: string }; after?: { event: string } } }[])[0]!;
    assert.equal(row.data?.before?.event, "connect");
    assert.equal(row.data?.after?.event, "death");

    // Another player's trigger id is not this player's to edit.
    const foreign = await jf(`${base}/api/players/${other.id}/triggers/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "x" }) });
    assert.equal(foreign.status, 404);
    // An edit is validated exactly like a create.
    const bad = await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ event: "connect", action: "message" }) });
    assert.equal(bad.status, 400, "a message step with no text is refused on edit too");
    assert.equal((await repo.playerTriggers.get(id))!.event, "death", "and a refused edit changes nothing");
  });
});

test("editing a spent one-shot keeps it spent unless re-arming is asked for", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000302", name: "Spent" });
    const made = await jf(`${base}/api/players/${player.id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "once" }) });
    const id = made.body.trigger.id as string;
    await repo.playerTriggers.recordFire(id, true, new Date().toISOString());

    const typo = await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "once (typo fixed)" }) });
    assert.equal(typo.status, 200);
    assert.ok(typo.body.trigger.disarmedAt, "fixing a receipt does not quietly arm it again");
    assert.equal((await repo.playerTriggers.listArmed()).length, 0);

    const again = await jf(`${base}/api/players/${player.id}/triggers/${id}`, { method: "PUT", headers: auth, body: JSON.stringify({ event: "connect", action: "message", message: "welcome back again", rearm: true }) });
    assert.equal(again.body.trigger.disarmedAt, null, "rearm arms it again");
    assert.equal((await repo.playerTriggers.listArmed()).length, 1, "and the runner's armed set picks it up");
  });
});

test("an edit needs the capabilities of BOTH the trigger as it is and as it will be", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    await makeServer(base, owner);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000303", name: "Gated" });
    const messenger = await staff(base, owner, "messenger2", [
      { capability: "server.view", level: "read" },
      { capability: "action.message", level: "write" },
    ]);
    // The owner's kick trigger: the messenger cannot touch it at all…
    const kick = await jf(`${base}/api/players/${player.id}/triggers`, { method: "POST", headers: owner, body: JSON.stringify({ event: "connect", action: "kick", message: "no" }) });
    const soften = await jf(`${base}/api/players/${player.id}/triggers/${kick.body.trigger.id}`, { method: "PUT", headers: messenger, body: JSON.stringify({ event: "connect", action: "message", message: "hi" }) });
    assert.deepEqual(await askedFor(base, owner, soften), { capability: "action.kick", serverId: null }, "not even to turn it into something they could do");
    assert.equal((await repo.playerTriggers.get(kick.body.trigger.id))!.steps[0]!.action, "kick", "still the owner's kick");
    // …and cannot turn their own message trigger into a kick.
    const own = await jf(`${base}/api/players/${player.id}/triggers`, { method: "POST", headers: messenger, body: JSON.stringify({ event: "connect", action: "message", message: "hi" }) });
    assert.equal(own.status, 201);
    const escalate = await jf(`${base}/api/players/${player.id}/triggers/${own.body.trigger.id}`, { method: "PUT", headers: messenger, body: JSON.stringify({ event: "connect", action: "kick", message: "gotcha" }) });
    assert.deepEqual(await askedFor(base, owner, escalate), { capability: "action.kick", serverId: null });
    assert.equal((await repo.playerTriggers.get(own.body.trigger.id))!.steps[0]!.action, "message");
  });
});

test("the Rules tab's player events: a weapon kill saves its weapons, a switch-on-switch is refused", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000290", name: "Sapper" });
    const post = (body: Record<string, unknown>) => jf(`${base}/api/players/${player.id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    // A weapon kill carries its weapons, normalized, and the summary names them.
    const made = await post({ event: "weaponkill", params: { weapons: "flamethrower ,SATCHEL" }, action: "message", message: "No flamethrowers here", fireOnce: false });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.trigger.params, { weapons: "flamethrower, SATCHEL" });
    const listed = await jf(`${base}/api/players/${player.id}/triggers`, { headers: auth });
    assert.match(listed.body.triggers[0].summary, /^on kill with flamethrower, SATCHEL, message \(every time\)$/);
    assert.deepEqual((await repo.playerTriggers.listArmed())[0]?.params, { weapons: "flamethrower, SATCHEL" }, "the runner's armed set carries the weapons");

    // An edit replaces them.
    const id = made.body.trigger.id as string;
    const edited = await jf(`${base}/api/players/${player.id}/triggers/${id}`, {
      method: "PUT", headers: auth, body: JSON.stringify({ event: "weaponkill", params: { weapons: "150MM" }, action: "message", message: "No artillery", fireOnce: false }),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.trigger.params, { weapons: "150MM" });

    // Refused: a weapon kill with no weapons, and a team switch that switches them again.
    const noWeapons = await post({ event: "weaponkill", action: "message", message: "x" });
    assert.equal(noWeapons.status, 400);
    assert.match(noWeapons.body.error.message, /at least one weapon/);
    const loop = await post({ event: "teamswitch", action: "switch" });
    assert.equal(loop.status, 400);
    assert.match(loop.body.error.message, /another team switch/);

    // The other two need nothing, and settings they do not take are not stored.
    const swap = await post({ event: "teamswitch", params: { weapons: "SATCHEL" }, action: "message", message: "Stay on your side" });
    assert.equal(swap.status, 201);
    assert.deepEqual(swap.body.trigger.params, {});
    assert.equal((await post({ event: "camenter", action: "message", message: "On cam" })).status, 201);
  });
});

test("roster conditions: the player's own game decides the roles and the conditions on offer", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const ww2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000291", name: "Tanker" });
    const nam = await repo.players.upsert({ game: "hllv", platform: "steam", platformId: "76561100000000292", name: "Flyboy" });
    const post = (id: string, body: Record<string, unknown>) => jf(`${base}/api/players/${id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    // Plays a role: only the roles are stored, and the summary names them in the player's game.
    const made = await post(ww2.id, { event: "role", params: { roles: [12, 11] }, action: "message", message: "{violation}", fireOnce: false });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.trigger.params, { roles: [12, 11] });
    const listed = await jf(`${base}/api/players/${ww2.id}/triggers`, { headers: auth });
    assert.equal(listed.body.triggers[0].summary, "on playing Tank Commander or Crewman, message (every time)");
    // The builder learns the player's game and the conditions it has: no helicopters in WW2.
    assert.equal(listed.body.game, "hll");
    assert.ok(listed.body.rosterEvents.includes("role") && listed.body.rosterEvents.includes("solotank"));
    assert.ok(!listed.body.rosterEvents.includes("soloheli"), "WW2 has no helicopters");
    assert.ok((await jf(`${base}/api/players/${nam.id}/triggers`, { headers: auth })).body.rosterEvents.includes("soloheli"));

    // Role 16 is a Gunner in WW2 and a Pilot in Vietnam: the overview names each in its own game.
    assert.equal((await post(nam.id, { event: "role", params: { roles: [16] }, action: "message", message: "x" })).status, 201);
    assert.equal((await post(ww2.id, { event: "role", params: { roles: [16] }, action: "message", message: "x" })).status, 201);
    const all = await jf(`${base}/api/player-triggers`, { headers: auth });
    const summaries = (all.body.triggers as { playerName: string; summary: string }[]).map((t) => `${t.playerName}: ${t.summary}`);
    assert.ok(summaries.includes("Flyboy: on playing Pilot, message (once)"), summaries.join("\n"));
    assert.ok(summaries.includes("Tanker: on playing Gunner, message (once)"), summaries.join("\n"));

    // Refused: a role the player's game doesn't have, no role at all, a condition their game lacks.
    const stray = await post(ww2.id, { event: "role", params: { roles: [99] }, action: "message", message: "x" });
    assert.equal(stray.status, 400);
    assert.match(stray.body.error.message, /role 99 is not a role this player's game has/);
    assert.match((await post(ww2.id, { event: "role", params: { roles: [] }, action: "message", message: "x" })).body.error.message, /pick at least one role/);
    const heli = await post(ww2.id, { event: "soloheli", params: { heliRoles: [16], minCrew: 2 }, action: "message", message: "x" });
    assert.equal(heli.status, 400);
    assert.match(heli.body.error.message, /isn't something this player's game has/);

    // Every other condition stores its Rules trigger's settings, defaults filled in.
    const level = await post(ww2.id, { event: "lowlevel", params: {}, action: "kick", message: "Come back at level 25" });
    assert.equal(level.status, 201, JSON.stringify(level.body));
    assert.deepEqual(level.body.trigger.params, { minLevel: 25 });

    // An edit is checked the same way, against the same game.
    const bad = await jf(`${base}/api/players/${ww2.id}/triggers/${made.body.trigger.id}`, {
      method: "PUT", headers: auth, body: JSON.stringify({ event: "role", params: { roles: [99] }, action: "message", message: "x" }),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /role 99/);
  });
});

test("AFK and vote triggers: the AFK minutes are saved and checked; the vote events need nothing", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await makeServer(base, auth);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000293", name: "Idle" });
    const post = (body: Record<string, unknown>) => jf(`${base}/api/players/${player.id}/triggers`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const afk = await post({ event: "afk", params: { minutes: 15 }, action: "kick", message: "AFK" });
    assert.equal(afk.status, 201, JSON.stringify(afk.body));
    assert.deepEqual(afk.body.trigger.params, { minutes: 15 });
    const listed = await jf(`${base}/api/players/${player.id}/triggers`, { headers: auth });
    assert.match(listed.body.triggers[0].summary, /^on 15 minutes without a kill, kick \(once\)$/);
    const bad = await post({ event: "afk", params: { minutes: 0 }, action: "kick", message: "AFK" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /from 1 to 180/);
    assert.equal((await post({ event: "votestart", action: "message", message: "No vote kicks, please" })).status, 201);
    assert.equal((await post({ event: "votecast", action: "message", message: "x" })).status, 201);
  });
});
