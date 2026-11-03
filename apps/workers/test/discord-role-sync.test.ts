/**
 * The periodic Discord role resync — the decisions that grant or revoke real staff access.
 *
 * The invariants under test, in the order they can hurt:
 *   1. a member removed from the staff guild loses every panel role that same pass;
 *   2. a Discord role change re-projects through the role map (add AND remove);
 *   3. an OUTAGE never revokes anything — only an authoritative 404 does;
 *   4. hand-managed accounts are never touched, however their Discord looks;
 *   5. no-op passes write nothing (no audit spam from a quiet 5-minute cadence).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository, type Repository } from "@app/db";
import { syncDiscordRoles } from "../src/discord-role-sync.ts";

const GUILD = "g1";
const OPTS = { token: "bot-token", guildId: GUILD };

/** A fetch that answers per Discord user id: a member object, a status number, a prepared
 *  Response, or an Error. A bare 404 answers with Discord's real Unknown Member body — the
 *  error code is what the sync now requires before it treats a 404 as "this person left". */
function fakeFetch(answers: Record<string, unknown>): typeof fetch {
  return (async (url: unknown) => {
    const id = String(url).split("/").pop()!;
    const a = answers[id];
    if (a instanceof Error) throw a;
    if (a instanceof Response) return a;
    if (typeof a === "number") {
      const body = a === 404 ? { message: "Unknown Member", code: 10007 } : {};
      return new Response(JSON.stringify(body), { status: a });
    }
    return new Response(JSON.stringify(a ?? {}), { status: a ? 200 : 404 });
  }) as typeof fetch;
}

async function setup() {
  const repo: Repository = new InMemoryRepository();
  const admin = await repo.roles.create({ name: "Admin", grants: [{ capability: "*", level: "write" }], limits: {} });
  const mod = await repo.roles.create({ name: "Moderator", grants: [{ capability: "player.watchlist", level: "write" }], limits: {} });
  await repo.discordRoleMap.setForDiscordRole("d-admin", "Leadership", [{ roleId: admin.id, scopeId: null }]);
  await repo.discordRoleMap.setForDiscordRole("d-mod", "Mods", [{ roleId: mod.id, scopeId: null }]);
  const user = await repo.users.create({ username: "kreitz", discordId: "100000000000000001", discordUsername: "kreitz", discordNick: "KREITZ [LYNX]", discordManaged: true });
  await repo.userRoles.set(user.id, [{ roleId: admin.id, scopeId: null }]);
  return { repo, admin, mod, user };
}

test("a member removed from the staff guild loses every panel role the same pass", async () => {
  const { repo, user } = await setup();
  const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: fakeFetch({ [user.discordId!]: 404 }) });
  assert.equal(r.cleared, 1);
  assert.deepEqual(await repo.userRoles.listByUser(user.id), [], "no roles survive leaving the guild");
  const trail = await repo.audit.list({ limit: 5 });
  const entry = trail.find((a) => a.action === "user.roles_sync");
  assert.ok(entry, "the revocation is recorded");
  assert.equal(entry!.actorName, "discord-sync");
  assert.match(entry!.summary, /no longer in the staff Discord/);
  assert.match(entry!.summary, /Admin/, "the roles that were removed are named");
});

test("a Discord role change re-projects through the map — including downgrades", async () => {
  const { repo, mod, user } = await setup();
  // In Discord they now hold ONLY the mod role: the map must downgrade Admin → Moderator.
  const r = await syncDiscordRoles(repo, {
    ...OPTS,
    fetchImpl: fakeFetch({ [user.discordId!]: { roles: ["d-mod"], nick: "KREITZ [LYNX]", user: { username: "kreitz" } } }),
  });
  assert.equal(r.changed, 1);
  assert.deepEqual(await repo.userRoles.listByUser(user.id), [{ roleId: mod.id, scopeId: null }]);
  const trail = await repo.audit.list({ limit: 5 });
  const entry = trail.find((a) => a.action === "user.roles_sync")!;
  assert.match(entry.summary, /now: Moderator/);
  assert.match(entry.summary, /was: Admin/);
});

test("mapped roles held in Discord flow IN, not only out", async () => {
  const { repo, admin, mod, user } = await setup();
  const r = await syncDiscordRoles(repo, {
    ...OPTS,
    fetchImpl: fakeFetch({ [user.discordId!]: { roles: ["d-admin", "d-mod"], user: { username: "kreitz" } } }),
  });
  assert.equal(r.changed, 1);
  const held = (await repo.userRoles.listByUser(user.id)).map((a) => a.roleId).sort();
  assert.deepEqual(held, [admin.id, mod.id].sort());
});

test("an outage keeps every role — only an authoritative 404 revokes", async () => {
  const { repo, admin, user } = await setup();
  for (const answer of [500, 429, new Error("socket hang up")]) {
    const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: fakeFetch({ [user.discordId!]: answer }) });
    assert.equal(r.errors, 1, `${String(answer)} counts as an error`);
    assert.equal(r.cleared + r.changed, 0);
    assert.deepEqual(await repo.userRoles.listByUser(user.id), [{ roleId: admin.id, scopeId: null }],
      `roles survive a ${String(answer)} from Discord`);
  }
});

test("a 404 that is not Unknown Member keeps every role — an unknown guild must not strip the staff", async () => {
  const { repo, admin, user } = await setup();
  // The bot was kicked from the guild (or the guild id is wrong): Discord answers 404 with
  // Unknown Guild for EVERY member lookup. Clearing on it would revoke the whole staff.
  const unknownGuild = new Response(JSON.stringify({ message: "Unknown Guild", code: 10004 }), { status: 404 });
  const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: fakeFetch({ [user.discordId!]: unknownGuild }) });
  assert.equal(r.errors, 1);
  assert.equal(r.cleared, 0);
  assert.deepEqual(await repo.userRoles.listByUser(user.id), [{ roleId: admin.id, scopeId: null }]);
});

test("a 200 whose body cannot be read keeps every role — it is an outage, not an empty membership", async () => {
  const { repo, admin, user } = await setup();
  const torn = new Response("{\"roles\": [\"d-", { status: 200 }); // connection cut mid-body
  const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: fakeFetch({ [user.discordId!]: torn }) });
  assert.equal(r.errors, 1);
  assert.equal(r.changed + r.cleared, 0);
  assert.deepEqual(await repo.userRoles.listByUser(user.id), [{ roleId: admin.id, scopeId: null }]);
});

test("hand-managed accounts are never touched, whatever Discord says", async () => {
  const { repo, admin, user } = await setup();
  await repo.users.linkDiscord(user.id, { discordId: user.discordId!, managed: false });
  // Even a 404 (left the guild) must not strip a hand-managed account.
  const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: fakeFetch({ [user.discordId!]: 404 }) });
  assert.equal(r.cleared, 0);
  assert.deepEqual(await repo.userRoles.listByUser(user.id), [{ roleId: admin.id, scopeId: null }]);
});

test("a quiet pass writes nothing — no audit spam from the cadence", async () => {
  const { repo, user } = await setup();
  const before = (await repo.audit.list({ limit: 50 })).length;
  // Discord agrees with the stored state exactly (admin via d-admin, names unchanged).
  const r = await syncDiscordRoles(repo, {
    ...OPTS,
    fetchImpl: fakeFetch({ [user.discordId!]: { roles: ["d-admin"], nick: "KREITZ [LYNX]", user: { username: "kreitz" } } }),
  });
  assert.equal(r.changed + r.cleared + r.errors, 0);
  assert.equal((await repo.audit.list({ limit: 50 })).length, before, "no audit rows from a no-op pass");
});

test("names refresh for every linked account, roles only for managed ones", async () => {
  const { repo, admin, user } = await setup();
  await repo.users.linkDiscord(user.id, { discordId: user.discordId!, managed: false });
  await syncDiscordRoles(repo, {
    ...OPTS,
    // Renamed in Discord AND stripped of mapped roles — the name must follow, the roles must not.
    fetchImpl: fakeFetch({ [user.discordId!]: { roles: [], nick: "KREITZ [LYNX] (ret.)", user: { username: "kreitz" } } }),
  });
  const after = await repo.users.findById(user.id);
  assert.equal(after!.discordNick, "KREITZ [LYNX] (ret.)");
  assert.deepEqual(await repo.userRoles.listByUser(user.id), [{ roleId: admin.id, scopeId: null }]);
});

/* ------------------------------------------------------------------------------------------- *
 * The BULK path: one member-list read for the whole staff.
 *
 * The tests above all answer 404 to the list URL, so they exercise the per-person fallback — which
 * is what keeps a guild whose list cannot be read working exactly as it did. These cover the path
 * that now runs normally, and the reason it exists: this sweep repeats every few minutes forever,
 * and per-person it was one request per staff member each pass, all serialised into one rate-limit
 * bucket shared with everything a person is waiting on.
 * ------------------------------------------------------------------------------------------- */

/** A fetch that serves the guild member LIST, and records how many requests it took. */
function fakeListFetch(members: { id: string; roles: string[]; nick?: string; username?: string }[]) {
  const calls: string[] = [];
  const impl = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (/\/members\?/.test(u)) {
      const after = new URL(u).searchParams.get("after") ?? "0";
      // One short page: everybody, then done.
      if (after !== "0") return new Response("[]", { status: 200 });
      return new Response(JSON.stringify(members.map((m) => ({
        user: { id: m.id, username: m.username ?? m.id }, nick: m.nick ?? null, roles: m.roles,
      }))), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "Unknown Member", code: 10007 }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

test("the whole staff is read in ONE request, and roles still project through the map", async () => {
  const { repo, mod, user } = await setup();
  // Nine more linked staff, so a per-person sweep would be ten requests.
  for (let i = 2; i <= 10; i++) {
    await repo.users.create({
      username: `staff${i}`, discordId: `10000000000000000${i}`, discordUsername: `staff${i}`,
      discordNick: null, discordManaged: true,
    });
  }
  const all = (await repo.users.list()).filter((u) => u.discordId);
  const { impl, calls } = fakeListFetch(all.map((u) => ({ id: u.discordId!, roles: ["d-mod"], username: u.username })));

  const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: impl });
  assert.equal(r.checked, 10);
  assert.equal(calls.length, 1, "ten staff, one request — the point of the whole change");
  assert.match(calls[0]!, /\/members\?limit=1000/);
  assert.equal(r.errors, 0);
  // The projection is unchanged: d-mod maps to Moderator, replacing the Admin they held.
  assert.deepEqual((await repo.userRoles.listByUser(user.id)).map((x) => x.roleId), [mod.id]);
});

test("absent from a complete list is 'they left' — managed roles go, hand-managed stay", async () => {
  const { repo, admin, user } = await setup();
  const pinned = await repo.users.create({
    username: "pinned", discordId: "100000000000000009", discordUsername: "pinned",
    discordNick: null, discordManaged: false,
  });
  await repo.userRoles.set(pinned.id, [{ roleId: admin.id, scopeId: null }]);

  // Neither of them appears in the list Discord returns.
  const { impl } = fakeListFetch([{ id: "999999999999999999", roles: [] }]);
  const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: impl });

  assert.equal(r.cleared, 1, "the managed account loses everything");
  assert.deepEqual(await repo.userRoles.listByUser(user.id), []);
  assert.deepEqual((await repo.userRoles.listByUser(pinned.id)).map((x) => x.roleId), [admin.id],
    "a hand-managed account is never touched, however the guild looks");
});

test("a quiet pass writes nothing — a five-minute cadence must not fill the audit trail", async () => {
  const { repo, admin, user } = await setup();
  const { impl } = fakeListFetch([{ id: user.discordId!, roles: ["d-admin"], username: "kreitz", nick: "KREITZ [LYNX]" }]);
  const before = (await repo.audit.list({ limit: 100 })).length;
  const r = await syncDiscordRoles(repo, { ...OPTS, fetchImpl: impl });
  assert.equal(r.changed, 0);
  assert.equal(r.cleared, 0);
  assert.deepEqual((await repo.userRoles.listByUser(user.id)).map((x) => x.roleId), [admin.id]);
  assert.equal((await repo.audit.list({ limit: 100 })).length, before, "nothing drifted, so nothing was written");
});
