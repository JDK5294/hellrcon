/**
 * Game rewards' settings: off and dry-run by default, validated, and — the part that matters with
 * paid VIP — only someone allowed to PAY VIP or points can switch a reward that pays it live.
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

test("game rewards: every kind starts off and in dry run", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const r = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: auth });
    assert.equal(r.status, 200);
    for (const k of ["topStats", "killStreaks", "playDays", "seedDays"]) {
      assert.equal(r.body.config[k].enabled, false, `${k} off`);
      assert.equal(r.body.config[k].dryRun, true, `${k} dry-run`);
    }
  });
});

test("game rewards: bounds and bad input are refused, one section saves without the rest", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/game-rewards`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
    assert.equal((await put({ killStreaks: { tiers: [{ kills: 1, reward: { points: 5 } }] } })).status, 400, "a 1-kill streak is not a streak");
    assert.equal((await put({ killStreaks: { tiers: [{ kills: 5, reward: {} }, { kills: 5, reward: {} }] } })).status, 400, "duplicate tiers");
    assert.equal((await put({ topStats: { categories: [{ id: "headshots" }] } })).status, 400);
    assert.equal((await put({ playDays: { tiers: [{ days: 3, reward: { vipHours: 99999 } }] } })).status, 400);
    const ok = await put({ killStreaks: { enabled: true, tiers: [{ kills: 15, reward: { points: 40 } }] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.config.killStreaks.tiers, [{ kills: 15, reward: { vipHours: 0, points: 40 } }]);
    assert.equal(ok.body.config.topStats.minPlayers, 40, "untouched sections keep their settings");
  });
});

test("game rewards: switching a paying reward live needs the permission to pay it", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const editor = await staff(base, owner, "autoonly", [{ capability: "autosettings.profiles", level: "write" }]);
    const put = (h: Record<string, string>, body: unknown) => jf(`${base}/api/servers/${id}/game-rewards`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    const config = async () => (await jf(`${base}/api/servers/${id}/game-rewards`, { headers: owner })).body.config;
    // Anything in dry run — or a message — is theirs to edit.
    assert.equal((await put(editor, { seedDays: { enabled: true, message: "thanks {player_name}" } })).status, 200);
    // Going live with a VIP reward is not: it is asked of someone who may grant VIP here.
    const live = await put(editor, { seedDays: { dryRun: false } });
    assert.deepEqual(await askedFor(base, owner, live), { capability: "vip.grant", serverId: id });
    assert.equal((await config()).seedDays.dryRun, true, "nothing went live on the asking");
    // The owner can; after that, the editor may still change the wording.
    assert.equal((await put(owner, { seedDays: { dryRun: false } })).status, 200);
    assert.equal((await put(editor, { seedDays: { message: "cheers {player_name}" } })).status, 200, "wording is not paying");
    // …but not raise what it pays.
    const tiers = (await config()).seedDays.tiers;
    const raise = await put(editor, { seedDays: { tiers: [{ days: 3, reward: { points: 100 } }, { days: 7, reward: { vipHours: 240 } }] } });
    assert.deepEqual(await askedFor(base, owner, raise), { capability: "vip.grant", serverId: id });
    assert.deepEqual((await config()).seedDays.tiers, tiers, "what it pays is unchanged");
  });
});

test("game rewards: per-category and per-tier messages save; blank ones fall back", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const r = await jf(`${base}/api/servers/${id}/game-rewards`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({
        topStats: { categories: [{ id: "kills", message: "{kills} kills!" }, { id: "support", message: "   " }] },
        killStreaks: { minPlayers: 30, tiers: [{ kills: 10, reward: { points: 5 }, message: "ten with {weapon}" }, { kills: 20, reward: { points: 9 }, message: "" }] },
      }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cats = r.body.config.topStats.categories as { id: string; message?: string }[];
    assert.equal(cats.find((c) => c.id === "kills")!.message, "{kills} kills!");
    assert.equal(cats.find((c) => c.id === "support")!.message, undefined, "blank = the card's message");
    assert.equal(r.body.config.killStreaks.minPlayers, 30);
    assert.deepEqual(r.body.config.killStreaks.tiers.map((t: { message?: string }) => t.message), ["ten with {weapon}", undefined]);
  });
});

test("everyone at match end: saved and bounded; going live with its day of VIP needs vip.grant", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const put = (h: Record<string, string>, body: unknown) => jf(`${base}/api/servers/${id}/game-rewards`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    assert.equal((await put(owner, { matchEnd: { minMatchMinutes: 9999 } })).status, 400);
    const ok = await put(owner, { matchEnd: { enabled: true, minMatchMinutes: 60, reward: { vipHours: 24 } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.config.matchEnd.dryRun, true, "still a dry run");
    const editor = await staff(base, owner, "autoonly2", [{ capability: "autosettings.profiles", level: "write" }]);
    assert.deepEqual(await askedFor(base, owner, await put(editor, { matchEnd: { dryRun: false } })), { capability: "vip.grant", serverId: id });
    const after = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: owner });
    assert.equal(after.body.config.matchEnd.dryRun, true, "still a dry run until someone who may grant VIP signs");
    assert.equal((await put(owner, { matchEnd: { dryRun: false } })).status, 200);
  });
});

test("game rewards: loosening WHO qualifies for a live reward is paying more, so it needs the permission too", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const put = (h: Record<string, string>, body: unknown) => jf(`${base}/api/servers/${id}/game-rewards`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    const live = await put(owner, {
      topStats: { enabled: true, dryRun: false, minPlayers: 40, minMinutes: 30, categories: [{ id: "kills", enabled: true, ranks: [{ vipHours: 24 }] }] },
      killStreaks: { enabled: true, dryRun: false, minPlayers: 40, tiers: [{ kills: 15, reward: { vipHours: 24 } }] },
      playDays: { enabled: true, dryRun: false, minMinutes: 60, tiers: [{ days: 3, reward: { vipHours: 24 } }] },
    });
    assert.equal(live.status, 200, JSON.stringify(live.body));
    const editor = await staff(base, owner, "autoonly3", [{ capability: "autosettings.profiles", level: "write" }]);
    const vipHere = { capability: "vip.grant", serverId: id };
    assert.deepEqual(await askedFor(base, owner, await put(editor, { topStats: { minPlayers: 2 } })), vipHere, "top stats at 2 players pays every empty-server round");
    assert.deepEqual(await askedFor(base, owner, await put(editor, { topStats: { minMinutes: 1 } })), vipHere);
    assert.deepEqual(await askedFor(base, owner, await put(editor, { killStreaks: { minPlayers: 2 } })), vipHere);
    assert.deepEqual(await askedFor(base, owner, await put(editor, { playDays: { minMinutes: 1 } })), vipHere, "a minute a day would pay the streak for a join");
    const held = (await jf(`${base}/api/servers/${id}/game-rewards`, { headers: owner })).body.config;
    assert.deepEqual([held.topStats.minPlayers, held.topStats.minMinutes, held.killStreaks.minPlayers, held.playDays.minMinutes], [40, 30, 40, 60], "no threshold moved");
    assert.equal((await put(editor, { playDays: { message: "{days} days in a row, {player_name}!" } })).status, 200, "wording is still theirs");
  });
});

test("game rewards: the card and category order saves, and re-arranging a live reward is not paying more", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const put = (h: Record<string, string>, body: unknown) => jf(`${base}/api/servers/${id}/game-rewards`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    const ids = (r: { body: Record<string, any> }): string[] => r.body.config.topStats.categories.map((c: { id: string }) => c.id);
    const first = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: owner });
    assert.deepEqual(first.body.config.order, ["matchEnd", "topStats", "bestSquads", "killStreaks", "playDays", "seedDays"]);
    const defaults = ids(first);

    // Editing a couple of categories leaves every category where it was.
    const live = await put(owner, { topStats: { enabled: true, dryRun: false, categories: [{ id: "support", enabled: true, ranks: [{ vipHours: 12 }] }, { id: "kills", enabled: true, ranks: [{ vipHours: 12 }] }] } });
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.deepEqual(ids(live), defaults, "a partial list is an edit, not a re-arrangement");

    // The full list, re-arranged — by someone who may not pay VIP: it pays nothing more.
    const editor = await staff(base, owner, "arranger", [{ capability: "autosettings.profiles", level: "write" }]);
    const arranged = ["support", ...defaults.filter((c) => c !== "support")];
    const moved = await put(editor, { order: ["topStats", "bogus", "matchEnd"], topStats: { categories: arranged.map((c) => ({ id: c })) } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.config.order, ["topStats", "matchEnd", "bestSquads", "killStreaks", "playDays", "seedDays"], "unknown dropped, missing kept at the end");
    assert.deepEqual(ids(moved), arranged);
    const again = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: owner });
    assert.deepEqual(ids(again), arranged, "and it survives a reload");
    assert.equal(again.body.config.topStats.categories.find((c: { id: string; ranks: { vipHours: number }[] }) => c.id === "support").ranks[0].vipHours, 12, "moving kept its reward");
  });
});

test("game rewards: the winners list goes to every player by default, and can be switched off", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    const first = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: owner });
    assert.equal(first.body.config.topStats.showEveryone, true);
    const off = await jf(`${base}/api/servers/${id}/game-rewards`, { method: "PUT", headers: owner, body: JSON.stringify({ topStats: { showEveryone: false } }) });
    assert.equal(off.status, 200);
    assert.equal(off.body.config.topStats.showEveryone, false);
  });
});

test("game rewards: recent rewards hold a full server's match end, each with its kind", async () => {
  await withServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const id = await makeServer(base, owner);
    await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: "w", serverId: id, summary: "#1 combat", data: { kind: "topStats" } });
    for (let i = 0; i < 80; i++) {
      await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: `p${i}`, serverId: id, summary: `match end ${i}`, data: { kind: "matchEnd" } });
    }
    const r = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: owner });
    assert.equal(r.body.recent.length, 81, "the winner paid just before 80 match-end lines is still there");
    assert.equal(r.body.recent.filter((x: { kind: string }) => x.kind === "topStats").length, 1);
  });
});

test("best squads: starts off in dry run, bad input is refused, and switching it live with points needs the payout key", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const r = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: auth });
    assert.equal(r.body.config.bestSquads.enabled, false);
    assert.equal(r.body.config.bestSquads.dryRun, true);
    assert.ok(r.body.config.order.includes("bestSquads"), "the card has a place in the message order");
    const put = (body: unknown, who = auth) => jf(`${base}/api/servers/${id}/game-rewards`, { method: "PUT", headers: who, body: JSON.stringify(body) });
    assert.equal((await put({ bestSquads: { types: [{ id: "navy" }] } })).status, 400, "no such squad type");
    assert.equal((await put({ bestSquads: { metric: "headshots" } })).status, 400);
    assert.equal((await put({ bestSquads: { scoring: "median" } })).status, 400);
    assert.equal((await put({ bestSquads: { minMembers: 9 } })).status, 400, "no squad has nine");
    const ok = await put({ bestSquads: { minMembers: 3, metric: "teamplay", scoring: "average", types: [{ id: "armor", enabled: true, ranks: [{ points: 40 }, { points: 20 }] }] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.config.bestSquads.minMembers, 3);
    assert.equal(ok.body.config.bestSquads.scoring, "average");
    assert.deepEqual(ok.body.config.bestSquads.types.find((t: any) => t.id === "armor").ranks, [{ vipHours: 0, points: 40 }, { vipHours: 0, points: 20 }]);
    // A settings editor without the payout key may change it in dry run, never switch it live.
    const editor = await staff(base, auth, "squads-editor", [{ capability: "autosettings.profiles", level: "write" }]);
    assert.equal((await put({ bestSquads: { message: "well played {squad_mates}" } }, editor)).status, 200, "a dry-run edit pays nothing");
    const live = await put({ bestSquads: { enabled: true, dryRun: false } }, editor);
    assert.deepEqual(await askedFor(base, auth, live), { capability: "economy.payout", serverId: id }, "live squad rewards pay points");
    const held = await jf(`${base}/api/servers/${id}/game-rewards`, { headers: auth });
    assert.deepEqual([held.body.config.bestSquads.enabled, held.body.config.bestSquads.dryRun], [false, true], "and it stays off in dry run");
    assert.equal((await put({ bestSquads: { enabled: true, dryRun: false } })).status, 200, "the owner may");
  });
});
