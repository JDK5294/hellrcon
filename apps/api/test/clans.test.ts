/**
 * Players → Clans over HTTP: one row per clan however it is spelled, the players behind any of
 * them, the staff choices on top (combine, split, rename, reset), who may make those choices, the
 * directory's clan filter, and a rule saved on the clan tag trigger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth, assertAsked } from "./harness.ts";
import type { Repository } from "@app/db";

async function staffAuth(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string; scopeType?: string; scopeId?: string | null }[]) {
  const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  const put = await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
    method: "PUT", headers: owner, body: JSON.stringify({ grants: grants.map((g) => ({ scopeType: "global", scopeId: null, ...g })) }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

/** Ana and Cid wear KLM (two spellings), Bob wore it and took it off, Dee wears RIVAL. */
async function seedClans(repo: Repository) {
  const now = Date.now();
  const at = (min: number) => new Date(now + min * 60_000).toISOString();
  const see = (id: string, name: string, min: number, clanTag?: string) =>
    repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611980000${id}`, name, ts: at(min), ...(clanTag !== undefined ? { clanTag } : {}) });
  const ana = await see("01", "Ana", -1, "[KLM]");
  const cid = await see("03", "Cid", -2, "ᴋʟᴍ");
  await see("02", "Bob", -3 * 1440, "[KLM]");
  const bob = await see("02", "Bob", -1);
  const dee = await see("04", "Dee", -1, "RIVAL");
  return { ana, bob, cid, dee };
}

test("clans: one row per clan however it is spelled; its players, now or before; search and focus", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const { ana, bob, cid } = await seedClans(repo);

    const list = await jf(`${base}/api/clans`, { headers: auth });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const byKey = new Map((list.body.clans as any[]).map((c) => [c.key, c]));
    const klm = byKey.get("klm");
    assert.ok(klm, "[KLM] and ᴋʟᴍ are one clan");
    assert.deepEqual([klm.label, klm.now, klm.ever], ["[KLM]", 2, 3], "named by its most-worn spelling; Bob took it off");
    assert.deepEqual((klm.spellings as any[]).map((s) => s.tag).sort(), ["[KLM]", "ᴋʟᴍ"]);
    assert.equal(list.body.clans[0].key, "klm", "most worn first");
    assert.equal(list.body.canEdit, true);

    // The search finds a clan by its letters, whatever the styling.
    const found = await jf(`${base}/api/clans?q=${encodeURIComponent("kl")}`, { headers: auth });
    assert.deepEqual((found.body.clans as any[]).map((c) => c.key), ["klm"]);
    // A profile's chip opens the tab on its clan: it leads the first page.
    const focused = await jf(`${base}/api/clans?focus=${encodeURIComponent("RIVAL")}`, { headers: auth });
    assert.equal(focused.body.focus, "rival");
    assert.equal(focused.body.clans[0].key, "rival");

    const members = await jf(`${base}/api/clans/members?key=klm`, { headers: auth });
    assert.equal(members.status, 200);
    assert.equal(members.body.total, 3);
    const rows = members.body.members as any[];
    assert.deepEqual(rows.slice(2).map((m) => [m.playerId, m.wearingNow, m.currentTag]), [[bob.id, false, null]], "the one who took it off comes last");
    assert.deepEqual(rows.slice(0, 2).map((m) => m.playerId).sort(), [ana.id, cid.id].sort());
    assert.deepEqual((await jf(`${base}/api/clans/members?key=klm&status=former`, { headers: auth })).body.members.map((m: any) => m.playerId), [bob.id]);
    // Two clans together: one list, each player once.
    const both = await jf(`${base}/api/clans/members?key=klm&key=rival&status=now`, { headers: auth });
    assert.equal(both.body.total, 3);
    assert.equal((await jf(`${base}/api/clans/members`, { headers: auth })).status, 400, "no clan picked");

    // The directory's clan filter: typed in any spelling, it finds everyone who wore any spelling.
    const dir = await jf(`${base}/api/players?clan=${encodeURIComponent("klm")}`, { headers: auth });
    assert.deepEqual((dir.body.players as any[]).map((p) => p.id).sort(), [ana.id, bob.id, cid.id].sort());
    assert.equal((await jf(`${base}/api/players?clan=${encodeURIComponent("ᴋ.ʟ.ᴍ")}`, { headers: auth })).body.total, 3);
    assert.equal((await jf(`${base}/api/players?clan=nobody`, { headers: auth })).body.total, 0);
  });
});

test("clans: combine, split, rename and reset — audited, one at a time, and the player tags write to do it", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await seedClans(repo);
    const post = (path: string, body: unknown, headers: Record<string, string> = auth) => jf(`${base}/api/clans/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const keys = async () => ((await jf(`${base}/api/clans`, { headers: auth })).body.clans as any[]).map((c) => [c.key, c.label, (c.spellings as any[]).map((s: any) => s.tag).sort()]);

    const combined = await post("combine", { keys: ["klm", "rival"], label: "Alliance" });
    assert.equal(combined.status, 200, JSON.stringify(combined.body));
    assert.deepEqual(await keys(), [["klm", "Alliance", ["RIVAL", "[KLM]", "ᴋʟᴍ"]]]);
    // A key from before the combine still finds the group's players.
    assert.equal((await jf(`${base}/api/clans/members?key=rival&status=now`, { headers: auth })).body.total, 3);
    assert.equal((await post("combine", { keys: ["klm", "rival"] })).status, 400, "already one clan: nothing to combine");
    assert.equal((await post("combine", { keys: ["klm", "nobodywore"] })).status, 400, "a clan nobody has worn is refused, not stored");
    assert.deepEqual(Object.keys((await repo.appConfig.get()).clanTags.merges), ["k:rival"], "nothing stored for it");

    assert.equal((await post("split", { tag: "RIVAL" })).status, 200);
    assert.deepEqual((await keys()).map((k) => k[0]).sort(), ["klm", "s:RIVAL"]);
    assert.equal((await post("split", { tag: "RIVAL" })).status, 400, "already a clan of its own");
    assert.equal((await post("split", { tag: "NEVERSEEN" })).status, 400);

    assert.equal((await post("rename", { key: "s:RIVAL", label: "Rivals" })).status, 200);
    assert.equal(((await keys()).find((k) => k[0] === "s:RIVAL") ?? [])[1], "Rivals");

    assert.equal((await post("reset", { key: "s:RIVAL" })).status, 200);
    assert.equal((await post("reset", { key: "klm" })).status, 200);
    assert.deepEqual((await keys()).map((k) => [k[0], k[1]]), [["klm", "[KLM]"], ["rival", "RIVAL"]], "back to the automatic grouping");
    assert.equal((await post("reset", { key: "klm" })).status, 400, "nothing left to reset");
    assert.deepEqual((await repo.appConfig.get()).clanTags, { merges: {}, labels: {} });

    const trail = (await repo.audit.list({ actions: ["clans.combine", "clans.split", "clans.rename", "clans.reset"] })).map((a) => a.action);
    assert.deepEqual([...trail].sort(), ["clans.combine", "clans.rename", "clans.reset", "clans.reset", "clans.split"]);
    assert.match((await repo.audit.list({ action: "clans.combine" }))[0]!.summary, /combined clan tags .* as “Alliance”/);

    // Reading is the directory's permission; changing the grouping is the player tags write — without
    // it, a change is asked for and the grouping stays as it is.
    const viewer = await staffAuth(base, auth, "viewer", [{ capability: "server.view", level: "read" }]);
    assert.equal((await jf(`${base}/api/clans`, { headers: viewer })).body.canEdit, false);
    assertAsked(await post("combine", { keys: ["klm", "rival"] }, viewer));
    assertAsked(await post("rename", { key: "klm", label: "x" }, viewer));
    assert.deepEqual((await repo.appConfig.get()).clanTags, { merges: {}, labels: {} }, "nothing was combined or renamed");
    const tagger = await staffAuth(base, auth, "tagger", [{ capability: "server.view", level: "read" }, { capability: "player.tags", level: "write" }]);
    assert.equal((await post("rename", { key: "klm", label: "Lynxes" }, tagger)).status, 200);
    const nobody = await staffAuth(base, auth, "nobody", [{ capability: "player.notes", level: "read" }]);
    assert.equal((await jf(`${base}/api/clans`, { headers: nobody })).status, 403);
  });
});

test("clans: a tag whose letters spell an object's built-in name is a clan like any other", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    await seedClans(repo);
    // Folded to its bare letters, "[Constructor]" is keyed "constructor" — the name every plain
    // object answers with its own constructor function.
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000777", name: "Eve", ts: new Date().toISOString(), clanTag: "[Constructor]" });
    const post = (path: string, body: unknown) => jf(`${base}/api/clans/${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const clan = async () => ((await jf(`${base}/api/clans`, { headers: auth })).body.clans as any[]).find((c) => c.key === "constructor");

    const list = await jf(`${base}/api/clans`, { headers: auth });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual([(await clan()).label, (await clan()).customised], ["[Constructor]", false], "named by its spelling, nothing chosen for it");
    const found = await jf(`${base}/api/clans?q=${encodeURIComponent("con")}`, { headers: auth });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual((found.body.clans as any[]).map((c) => c.key), ["constructor"]);
    assert.equal((await post("reset", { key: "constructor" })).status, 400, "nothing to reset on a group nobody changed");

    assert.equal((await post("rename", { key: "constructor", label: "Builders" })).status, 200);
    assert.deepEqual([(await clan()).label, (await clan()).customised], ["Builders", true]);
    assert.match((await repo.audit.list({ action: "clans.rename" }))[0]!.summary, /named the clan \[Constructor\] “Builders”/);
  });
});

test("clans: a rule on the clan tag trigger saves its tags as a list, and refuses one with none", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const rule = (params: unknown) => jf(`${base}/api/enforcer/rules`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "Welcome KLM", eventKind: "app.state.clan_tag", action: "message", reason: "Welcome, {player_name}", windowSec: 1800, params }),
    });
    const saved = await rule({ clans: ["klm", "s:A,B"] });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.rule.params, { clans: ["klm", "s:A,B"] }, "stored as one sorted list");
    assert.equal((await rule({ clans: [] })).status, 400);
    const vip = await jf(`${base}/api/enforcer/rules`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "VIP for tags", eventKind: "app.state.clan_tag", action: "vip", vipMinutes: 60, params: { clans: ["klm"] } }),
    });
    assert.equal(vip.status, 400, "a typed tag is not a reason to hand out paid VIP");
  });
});

test("clans: a viewer limited to one server counts and lists that server's players only, as the directory does", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const mk = async (name: string) => (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name, host: "1.2.3.4", port: 28865, password: "x" }) })).body.server.id as string;
    const alpha = await mk("Alpha");
    const bravo = await mk("Bravo");
    const { ana, cid, dee } = await seedClans(repo);
    // Ana plays on Alpha, Cid on Bravo, Dee on both; Bob has no career row anywhere.
    await repo.stats.bumpMany([
      { playerId: ana.id, serverId: alpha, delta: { playtimeSec: 600 } },
      { playerId: cid.id, serverId: bravo, delta: { playtimeSec: 600 } },
      { playerId: dee.id, serverId: alpha, delta: { playtimeSec: 600 } },
      { playerId: dee.id, serverId: bravo, delta: { playtimeSec: 600 } },
    ]);
    const counts = async (headers: Record<string, string>) =>
      Object.fromEntries(((await jf(`${base}/api/clans`, { headers })).body.clans as any[]).map((c) => [c.key, [c.ever, c.now]]));

    // Seeing every server: everyone, Bob included.
    assert.deepEqual(await counts(auth), { klm: [3, 2], rival: [1, 1] });
    // Limited to Alpha: Alpha's players only — Cid plays elsewhere, Bob nowhere.
    const alphaOnly = await staffAuth(base, auth, "alphaonly", [{ capability: "server.view", level: "read", scopeType: "server", scopeId: alpha }]);
    assert.deepEqual(await counts(alphaOnly), { klm: [1, 1], rival: [1, 1] });
    const members = await jf(`${base}/api/clans/members?key=klm`, { headers: alphaOnly });
    assert.deepEqual([members.body.total, (members.body.members as any[]).map((m) => m.playerId)], [1, [ana.id]]);
    // The same boundary as the directory's clan filter.
    assert.deepEqual(((await jf(`${base}/api/players?clan=klm`, { headers: alphaOnly })).body.players as any[]).map((p) => p.id), [ana.id]);
  });
});
