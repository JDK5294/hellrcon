import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jsonFetch } from "./harness.ts";

async function setup(base: string) {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const token = login.body.token as string;
  const auth = { authorization: `Bearer ${token}` };
  // fast-refusing host so create's live-name resolution returns immediately
  const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "s1", host: "127.0.0.1", port: 1, password: "x" }) });
  const serverId = (created.body.server as { id: string }).id;
  await jsonFetch(`${base}/api/servers/${serverId}/engagement`, { method: "POST", headers: auth, body: JSON.stringify({ mode: "active" }) });
  return { auth, serverId };
}

test("audit records the owner bootstrap and an engagement change; searchable", async () => {
  await withServer(async (base) => {
    const { auth } = await setup(base);
    const all = await jsonFetch(`${base}/api/audit`, { headers: auth });
    assert.equal(all.status, 200);
    const actions = (all.body.entries as any[]).map((e) => e.action);
    assert.ok(actions.includes("user.bootstrap"));
    assert.ok(actions.includes("server.engagement"));

    // text search narrows results
    const search = await jsonFetch(`${base}/api/audit?q=engagement`, { headers: auth });
    assert.ok((search.body.entries as any[]).every((e) => /engagement/i.test(e.action + e.summary)));
    assert.ok((search.body.entries as any[]).length >= 1);

    // action filter
    const filtered = await jsonFetch(`${base}/api/audit?action=server.engagement`, { headers: auth });
    assert.ok((filtered.body.entries as any[]).every((e) => e.action === "server.engagement"));
  });
});

test("staff summary rolls up per actor with an action breakdown — humans only, automation on request", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await setup(base);
    // The app's own automation writes actor-less rows (this is how the workers audit). They are a
    // different population from the humans and must not drown the staff statistics.
    for (let i = 0; i < 5; i++) {
      await repo.audit.create({ actorUserId: null, actorName: "system", action: "vip.expire", targetType: "player", targetId: String(i), targetName: `P${i}`, summary: "VIP expired" });
    }
    const r = await jsonFetch(`${base}/api/audit/staff`, { headers: auth });
    assert.equal(r.status, 200);
    const admin = (r.body.staff as any[]).find((s) => s.actorName === "admin");
    assert.ok(admin, "admin appears in the staff rollup");
    assert.ok(admin.count >= 2);
    assert.ok(admin.byAction["server.engagement"] >= 1);
    assert.ok(!(r.body.staff as any[]).some((s) => s.actorName === "system"), "the machinery is not a staff member");

    // The same numbers are still available — under the automation scope (the System page's view).
    const auto = await jsonFetch(`${base}/api/audit/staff?actors=auto`, { headers: auth });
    const system = (auto.body.staff as any[]).find((s) => s.actorName === "system");
    assert.ok(system, "the automation shows up in its own rollup");
    assert.equal(system.byAction["vip.expire"], 5);
    assert.ok(!(auto.body.staff as any[]).some((s) => s.actorName === "admin"), "and no human is mixed into it");
  });
});

test("audit requires auth", async () => {
  await withServer(async (base) => {
    const r = await jsonFetch(`${base}/api/audit`);
    assert.equal(r.status, 401);
  });
});

/*
 * Filtering the trail to one server used to DELETE a whole category of staff work from it.
 *
 * Community-level actions — player groups, notes, templates, accounts — belong to no game server,
 * so they carry no server_id, and the scoped read said "what happened on these servers" and threw
 * them away. The Activity page defaults its scope to the pinned server, so nobody had to opt in:
 * a staff member added players to a group all week and their own team could not find any of it.
 *
 * The two meanings of "these servers" are now distinct. For a reader who can see everything, a
 * server filter is a VIEW choice and community work stays in the answer. For a reader whose
 * grants restrict them, it is a boundary and it still holds.
 */
test("a server filter narrows the trail without hiding community-wide work", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId: server } = await setup(base);
    const other = await repo.servers.create({ name: "Offensive", game: "hll", host: "127.0.0.1", port: 2, password: "x", protocol: "binary-v2" });
    // A real actor id, or the rows count as automation and the human rollup skips them.
    const me = (await repo.users.list())[0]!;

    await repo.audit.create({ actorUserId: me.id, actorName: me.username, action: "player.kick", targetType: "player", targetId: "1", serverId: server, summary: "kick on Warfare" });
    await repo.audit.create({ actorUserId: me.id, actorName: me.username, action: "player.kick", targetType: "player", targetId: "2", serverId: other.id, summary: "kick on Offensive" });
    // The kind that vanished: no server, because there is no server it happened on.
    await repo.audit.create({ actorUserId: me.id, actorName: me.username, action: "group.member_add", targetType: "player", targetId: "3", summary: "added someone to a group" });

    const scoped = await jsonFetch(`${base}/api/audit?serverId=${server}`, { headers: auth });
    const summaries = (scoped.body.entries as any[]).map((e) => e.summary);
    assert.ok(summaries.includes("kick on Warfare"), "the chosen server's work is there");
    assert.ok(!summaries.includes("kick on Offensive"), "the other server's is not — it is still a filter");
    assert.ok(summaries.includes("added someone to a group"), "and the community-wide action is not silently dropped");

    // The per-staff rollup counts the same population, or the totals disagree with the list
    // sitting directly above them on the same page.
    const staff = await jsonFetch(`${base}/api/audit/staff?serverId=${server}`, { headers: auth });
    const row = (staff.body.staff as any[]).find((r) => r.actorUserId === me.id);
    assert.ok(row.byAction["group.member_add"], "group work is counted, not just listed");
  });
});

/*
 * Both ends of an entry were stored as whatever string the write site happened to have, and both
 * decayed. The actor froze as a username, so an admin who later linked Discord kept showing up
 * under the old name on every past action — under a different name than the same person wears on
 * every other screen. The target was whatever `playerName` the client sent, which for the action
 * routes is usually nothing, so the reader fell back to the target TYPE and printed the literal
 * word "player" as the name of the person who had been kicked.
 *
 * Neither is trusted for display now. The historical strings stay on the row — they are the record
 * of what things were called at the time, and an appeal argues about exactly that — but the names
 * a reader sees are resolved live.
 */
test("the trail names people, not ids: both ends resolve to what they are called now", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await setup(base);
    const me = (await repo.users.list())[0]!;
    // The merge case: the account is renamed by linking Discord, long after it acted.
    await repo.users.linkDiscord(me.id, { discordId: "9", username: "kreitz", nick: "KREITZ [LYNX]" });

    const player = await repo.players.upsert({ game: "hll", platform: "psn", platformId: "0ff4c9412aa7d6037f83", name: "KREITZ" });

    // Written the way the action routes write it: keyed by the GAME id, with no target name at all.
    await repo.audit.create({
      actorUserId: me.id, actorName: "admin", action: "player.kick",
      targetType: "player", targetId: player.platformId, serverId,
      summary: "admin ran kick",
    });

    // By action, not by position: setup's own entries land in the same millisecond and `ts DESC`
    // has no tiebreaker, so "the newest row" is not reliably the one this test wrote.
    const entries = (await jsonFetch(`${base}/api/audit`, { headers: auth })).body.entries as any[];
    const entry = entries.find((e) => e.action === "player.kick")!;
    assert.equal(entry.actorDisplayName, "KREITZ [LYNX]", "the actor's name NOW, not the one frozen at write time");
    assert.equal(entry.actorName, "admin", "and the historical name is still on the row");
    assert.equal(entry.targetDisplayName, "KREITZ", "resolved from the players table, though nothing was stored");
    assert.equal(entry.targetPlatformId, player.platformId, "the game id rides along so it can be copied");
    assert.equal(entry.targetName, null, "nothing was captured at the time, and we do not invent one");
  });
});

test("a target we have never seen keeps its stored name rather than vanishing", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await setup(base);
    // An id typed straight into the console: no player row will ever match it.
    await repo.audit.create({
      actorUserId: null, actorName: "someone", action: "player.permaban",
      targetType: "player", targetId: "76561190000000000", targetName: "GhostAccount",
      summary: "banned an id we have no record of",
    });
    const entries = (await jsonFetch(`${base}/api/audit`, { headers: auth })).body.entries as any[];
    const entry = entries.find((e) => e.action === "player.permaban")!;
    assert.equal(entry.targetDisplayName, "GhostAccount", "the stored name is the fallback, not dead weight");
    assert.equal(entry.targetPlatformId, null, "and we do not pretend to know their game id");
  });
});

/**
 * `?actions=a,b` — one record built from several audit actions.
 *
 * The Moderation tabs are each a slice of the trail, and some slices are more than one action: a
 * ban is a temp ban OR a permanent one, a switch is immediate OR on death. The store has always
 * supported the list; only the HTTP layer did not, which left the caller making two requests and
 * merging two independently-paged lists — something that cannot be done correctly, because page
 * one of each is not page one of the union.
 */
test("the trail can be filtered by several actions at once", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await setup(base);
    // Action names unique to this test. Against a real Postgres every test in the file shares one
    // database, so asserting a TOTAL over names its neighbours also write ("player.kick") counts
    // their rows too — which is a bug in the test, not in the filter.
    const A = "sweep.alpha", B = "sweep.beta", C = "sweep.gamma";
    for (const action of [A, A, B, C]) {
      await repo.audit.create({ actorUserId: null, actorName: "tester", action, summary: `did ${action}` });
    }

    const one = await jsonFetch(`${base}/api/audit?actions=${A}`, { headers: auth });
    assert.equal(one.status, 200);
    assert.deepEqual([...new Set((one.body.entries as any[]).map((e) => e.action))], [A]);
    assert.equal(one.body.total, 2);

    const two = await jsonFetch(`${base}/api/audit?actions=${A},${B}`, { headers: auth });
    const kinds = new Set((two.body.entries as any[]).map((e) => e.action));
    assert.deepEqual([...kinds].sort(), [A, B].sort(), "both, and nothing else");
    assert.equal(two.body.total, 3, "the total counts the union, not one of the halves");

    // Blank entries and stray whitespace are dropped rather than becoming a filter matching nothing.
    const messy = await jsonFetch(`${base}/api/audit?actions=%20${A}%20,,`, { headers: auth });
    assert.deepEqual([...new Set((messy.body.entries as any[]).map((e) => e.action))], [A]);

    // An empty list is not a filter at all — it must not silently return nothing.
    const empty = await jsonFetch(`${base}/api/audit?actions=`, { headers: auth });
    assert.ok((empty.body.entries as any[]).length > 4, "an empty actions list falls back to the whole trail");
  });
});
