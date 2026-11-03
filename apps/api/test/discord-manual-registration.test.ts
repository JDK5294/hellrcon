/**
 * Manual registration on Discord — the staff-panel module that links a member to a game account
 * without the in-game code, and the machinery it needed: selects and modals on the STAFF panel.
 *
 * What is actually under test is the thing staff rely on when the self-service flow cannot work:
 * that a link written by hand is a real link (the member's VIP panel sees it), that it is
 * attributed to the staff ACCOUNT rather than to a Discord id, that neither side of an existing
 * link is silently overwritten, and that the welcome bonus cannot be farmed by registering
 * somebody twice.
 *
 * Everything drives the real handleInteraction with real signatures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createIsolatedRepository, type Repository } from "@app/db";
import { handleInteraction } from "../dist/discord.js";
import { DiscordModuleRegistry, registerBuiltinModules } from "../dist/discord-modules.js";
import { FakeHllServer } from "./fake-hll-server.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKeyHex: spki.subarray(spki.length - 32).toString("hex"),
    sign: (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex"),
  };
}

type Body = { type: number; data: Record<string, unknown> };

/** A staff member with the capability the module needs, linked to a Discord id. */
async function staffAccount(repo: Repository, discordId: string, capability = "player.links") {
  const user = await repo.users.create({ username: `staff-${discordId}`, discordId });
  await repo.grants.create({ userId: user.id, capability, scopeType: "global", scopeId: null, level: "write" });
  return user;
}

function caller(repo: Repository) {
  const registry = new DiscordModuleRegistry();
  registerBuiltinModules(registry, repo, async () => {});
  const { publicKeyHex, sign } = keypair();
  return async (interaction: Record<string, unknown>): Promise<Body> => {
    const body = JSON.stringify(interaction);
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body, { registry });
    await r.followUp;
    return r.body as Body;
  };
}

const press = (customId: string, discordUserId: string, extra: Record<string, unknown> = {}) => ({
  type: 3, token: "tok", channel_id: "900", channel: { id: "900", name: "staff-cmds" },
  message: { id: "m1", flags: 64 },
  data: { custom_id: customId, ...extra },
  member: { user: { id: discordUserId, username: "admin" }, roles: [] },
});
const submit = (customId: string, discordUserId: string, values: Record<string, string>) => ({
  type: 5, token: "tok", channel_id: "900", channel: { id: "900", name: "staff-cmds" },
  message: { id: "m1", flags: 64 },
  data: {
    custom_id: customId,
    components: Object.entries(values).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })),
  },
  member: { user: { id: discordUserId, username: "admin" }, roles: [] },
});

const content = (b: Body): string => String((b.data as { content?: unknown }).content ?? "");
const components = (b: Body): { type: number; components: { type: number; custom_id?: string }[] }[] =>
  ((b.data as { components?: unknown }).components ?? []) as never;

test("the module is on the launcher, and its root offers Discord's own member picker", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, "100000000000000001");
  const call = caller(repo);

  // Absorbed by the Economy hub: the launcher no longer lists it (the hub's door does), and
  // staff find it as Economy → Register / link accounts. Pressing it directly still works —
  // that is what the hub's door IS — which the root assertions below prove.
  const launcher = await call(press("sp:home::", "100000000000000001"));
  assert.ok(!/Manual registration/.test(content(launcher)), "hidden from the launcher — the Economy hub is its door");

  const root = await call(press("sp:register::", "100000000000000001"));
  // A user select (type 5) rather than a list of buttons: it searches the whole server as you
  // type, which is what the old bot needed a whole search screen to approximate.
  const rows = components(root);
  assert.ok(rows.some((r) => r.components.some((c) => c.type === 5)), "a user-select row");
  assert.ok(rows.some((r) => r.components.some((c) => c.custom_id === "sp:register:memberm:")), "and a typed-id escape hatch");
});

test("a modal opens as the first response and its submit is routed back", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, "100000000000000001");
  const call = caller(repo);

  // Type 9 = MODAL. This is the whole reason the staff panel learned modals: without it, staff
  // could not type anything into the panel at all.
  const modal = await call(press("sp:register:memberm:", "100000000000000001"));
  assert.equal(modal.type, 9);
  assert.equal((modal.data as { custom_id?: string }).custom_id, "sp:register:memberid:");

  const back = await call(submit("sp:register:memberid:", "100000000000000001", { discordId: "200000000000000002" }));
  assert.equal(back.type, 7, "the submit edits the panel in place");
  assert.match(content(back), /<@200000000000000002>/);
  assert.match(content(back), /Not linked/);
});

test("picking a player writes a real link, attributed to the staff account, and pays the welcome bonus once", async () => {
  const { repo } = await createIsolatedRepository();
  const staff = await staffAccount(repo, "100000000000000001");
  await repo.economy.setConfig({ registration: { bonusPoints: 50, bonusDays: 0, bonusAllGames: false } });
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Rifleman" });
  const call = caller(repo);

  const form = await call(press("sp:register:idm:200000000000000002", "100000000000000001"));
  assert.equal(form.type, 9, "the button opens a form rather than guessing");

  const linked = await call(submit("sp:register:id:200000000000000002", "100000000000000001", { playerId: "76561198000000001", name: "" }));
  assert.match(content(linked), /Rifleman/);
  assert.match(content(linked), /<@200000000000000002>/);

  // The link is the real one the member's own VIP panel reads.
  const found = await repo.externalLinks.findPlayers("discord", "200000000000000002");
  assert.deepEqual(found.map((p) => p.id), [player.id]);

  // Attribution is the staff ACCOUNT — a Discord id is not a staff member.
  const audit = await repo.audit.list({ limit: 20 });
  const row = audit.find((a) => a.action === "player.link");
  assert.ok(row, "linking by hand is a staff action");
  assert.equal(row!.actorUserId, staff.id);
  assert.equal((row!.data as { via?: string }).via, "discord-manual");

  // The bonus rides the same ledger ref as self-service, so a second registration pays nothing.
  assert.equal((await repo.economy.member("200000000000000002"))!.balance, 50);
  await repo.externalLinks.set(player.id, "discord", null, "test");
  await call(submit("sp:register:id:200000000000000002", "100000000000000001", { playerId: "76561198000000001", name: "" }));
  assert.equal((await repo.economy.member("200000000000000002"))!.balance, 50, "registering twice must not pay twice");
});

test("neither side of an existing link is overwritten without an explicit second press", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, "100000000000000001");
  const mine = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Rifleman" });
  const theirs = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000002", name: "Medic" });
  await repo.externalLinks.set(theirs.id, "discord", "200000000000000002", "test");
  const call = caller(repo);

  // 2002 already holds Medic; pointing them at Rifleman must stop and say so.
  const conflict = await call(submit("sp:register:id:200000000000000002", "100000000000000001", { playerId: "76561198000000001", name: "" }));
  assert.match(content(conflict), /Already linked/);
  assert.match(content(conflict), /Medic/);
  assert.deepEqual((await repo.externalLinks.findPlayers("discord", "200000000000000002")).map((p) => p.id), [theirs.id], "nothing moved");

  // The override is its own button — and its own audit row.
  const forced = await call(press(`sp:register:force:200000000000000002:steam|76561198000000001`, "100000000000000001"));
  assert.match(content(forced), /Rifleman/);
  assert.deepEqual((await repo.externalLinks.findPlayers("discord", "200000000000000002")).map((p) => p.id), [mine.id]);
  const row = (await repo.audit.list({ limit: 20 })).find((a) => a.action === "player.link");
  assert.equal((row!.data as { replaced?: boolean }).replaced, true, "the trail says a link was taken off another account");
});

/*
 * A replace clears only the SAME game's link, so the account the trail names as replaced has to be
 * that one. It was the first of the member's links in any game — and that list is ordered by who
 * was seen last, so a member who had just played Vietnam had their Vietnam account named.
 */
test("a forced replace names the account it took the link off — never the member's other game", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, "100000000000000001");
  const member = "200000000000000004";
  const oldWw2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000041", name: "Old WW2", ts: "2026-01-01T00:00:00.000Z" });
  // Seen more recently, so it is the first of their links.
  const vn = await repo.players.upsert({ game: "hllv", platform: "steam", platformId: "vn-eos-000041", name: "Rifleman VN", ts: "2026-06-01T00:00:00.000Z" });
  await repo.externalLinks.set(oldWw2.id, "discord", member, "test");
  await repo.externalLinks.set(vn.id, "discord", member, "test");
  const newWw2 = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000042", name: "New WW2" });
  const call = caller(repo);

  await call(press(`sp:register:force:${member}:steam|76561198000000042`, "100000000000000001"));
  const held = await repo.externalLinks.findPlayers("discord", member);
  assert.deepEqual(held.map((p) => p.id).sort(), [vn.id, newWw2.id].sort(), "the WW2 link moved; Vietnam's stands");
  const row = (await repo.audit.list({ limit: 20 })).find((a) => a.action === "player.link");
  assert.equal((row!.data as { replacedPlayerId?: string }).replacedPlayerId, oldWw2.id, "the trail names the WW2 account");
});

test("unlink asks first, then clears every link and leaves the points alone", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, "100000000000000001");
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Rifleman" });
  await repo.externalLinks.set(player.id, "discord", "200000000000000002", "test");
  await repo.economy.apply({ discordId: "200000000000000002", delta: 40, reason: "test", ref: "test:1", actorName: "test" }, {});
  const call = caller(repo);

  const confirm = await call(press("sp:register:unlinkc:200000000000000002", "100000000000000001"));
  assert.match(content(confirm), /Unlink/);
  assert.equal((await repo.externalLinks.findPlayers("discord", "200000000000000002")).length, 1, "asking is not doing");

  const done = await call(press("sp:register:unlink:200000000000000002", "100000000000000001"));
  assert.match(content(done), /Unlinked/);
  assert.equal((await repo.externalLinks.findPlayers("discord", "200000000000000002")).length, 0);
  assert.equal((await repo.economy.member("200000000000000002"))!.balance, 40, "points belong to the Discord account");
  assert.ok((await repo.audit.list({ limit: 20 })).some((a) => a.action === "player.unlink"));
});

/*
 * The staff paths move the per-game registration role the same way self-service does: the link
 * puts it on, the unlink takes it off, and a forced replace takes it off the DISPLACED account.
 * Discord is stubbed at global fetch; role calls are all that reach it here.
 */
test("manual link and unlink move the configured game role with the link", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, "100000000000000001");
  await repo.appConfig.set({ communityGuildId: "777000777" });
  await repo.economy.setConfig({ registration: { bonusPoints: 0, bonusDays: 0, bonusAllGames: false, gameRoles: { hll: "888000888" } } });
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "Rifleman" });
  const { DISCORD_TOKEN } = process.env;
  process.env.DISCORD_TOKEN = "bot-tok";
  const roleCalls: { method: string; url: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    roleCalls.push({ method: init?.method ?? "GET", url: String(url) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const call = caller(repo);
    await call(submit("sp:register:id:200000000000000002", "100000000000000001", { playerId: "76561198000000001", name: "" }));
    assert.deepEqual(roleCalls.map((c) => c.method), ["PUT"], "linking assigns the game's role");
    assert.ok(roleCalls[0]!.url.includes("/guilds/777000777/members/200000000000000002/roles/888000888"));

    // Force the same player onto ANOTHER member: they gain the role, the displaced account loses it.
    roleCalls.length = 0;
    await call(press("sp:register:force:200000000000000003:steam|76561198000000001", "100000000000000001"));
    const moved = roleCalls.map((c) => [c.method, /members\/(\d+)\//.exec(c.url)?.[1]]);
    assert.deepEqual(moved.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
      ["DELETE", "200000000000000002"],
      ["PUT", "200000000000000003"],
    ], "the role followed the link");

    roleCalls.length = 0;
    await call(press("sp:register:unlink:200000000000000003", "100000000000000001"));
    assert.deepEqual(roleCalls.map((c) => c.method), ["DELETE"], "unlinking takes the role back");
  } finally {
    globalThis.fetch = realFetch;
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
  }
});

test("the module is gated on player.flags like every other write in the app", async () => {
  const { repo } = await createIsolatedRepository();
  // Signed in and linked, but holding only a read grant on something else.
  const user = await repo.users.create({ username: "watcher", discordId: "100000000000000002" });
  await repo.grants.create({ userId: user.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const call = caller(repo);

  const launcher = await call(press("sp:home::", "100000000000000002"));
  assert.doesNotMatch(content(launcher), /Manual registration/, "not offered");
  const forced = await call(press("sp:register::", "100000000000000002"));
  assert.match(content(forced), /don't have access/, "and refused even when the id is typed by hand");
});

/*
 * Which capability opens this screen.
 *
 * Manual registration rewrites WHO a player is — it points a Discord identity at a game account,
 * and the override moves that person's VIP, points and ban history with it. The catalogue says to
 * grant that sparingly and the Moderator preset leaves `player.links` out on purpose, with a
 * comment saying why. The module asked for `player.watchlist` instead, which every moderator
 * holds at write — so the bot handed out the exact authority the web panel withholds. The two
 * doors have to ask the same question.
 */
test("only player.links opens manual registration — a moderator's watchlist write does not", async () => {
  const { repo } = await createIsolatedRepository();
  const call = caller(repo);

  // A moderator: watchlist at write (the preset's own grant), and no identity-link rights.
  await staffAccount(repo, "100000000000000010", "player.watchlist");
  const asMod = await call(press("sp:register::", "100000000000000010"));
  assert.match(content(asMod), /don't have access/i,
    "watchlist write must not reach the screen that rewrites identity links");
  const modLauncher = await call(press("sp:home::", "100000000000000010"));
  assert.doesNotMatch(content(modLauncher), /Manual registration/, "nor may they see it on the launcher");

  // The capability the web panel demands for the same operation does open it.
  await staffAccount(repo, "100000000000000011", "player.links");
  const asLinker = await call(press("sp:register::", "100000000000000011"));
  assert.doesNotMatch(content(asLinker), /don't have access/i, JSON.stringify(asLinker.data));
});

test("the panel shows players' names as written", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, "100000000000000001");
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000001", name: "*KLM*_Rifle" });
  const theirs = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000002", name: "_Medic_" });
  await repo.externalLinks.set(theirs.id, "discord", "200000000000000002", "test");
  const call = caller(repo);

  const card = await call(press("sp:register:member:200000000000000002", "100000000000000001"));
  assert.match(content(card), /Linked to \*\*\\_Medic\\_\*\*/, "the member card");
  const conflict = await call(submit("sp:register:id:200000000000000002", "100000000000000001", { playerId: "76561198000000001", name: "" }));
  assert.match(content(conflict), /already linked to \*\*\\_Medic\\_\*\*/, "a conflict");
  const forced = await call(press("sp:register:force:200000000000000002:steam|76561198000000001", "100000000000000001"));
  assert.match(content(forced), /✅ \*\*\\\*KLM\\\*\\_Rifle\*\* is now linked/, "the receipt");
  const unlinked = await call(press("sp:register:unlink:200000000000000002", "100000000000000001"));
  assert.match(content(unlinked), /Unlinked from \*\*\\\*KLM\\\*\\_Rifle\*\*/, "the unlink");
  // The other side of a conflict: the player is the one already linked, to another member.
  await repo.externalLinks.set(theirs.id, "discord", "200000000000000002", "test");
  const taken = await call(submit("sp:register:id:200000000000000003", "100000000000000001", { playerId: "76561198000000002", name: "" }));
  assert.match(content(taken), /\*\*\\_Medic\\_\*\* is already linked to <@200000000000000002>/, "the player's side of a conflict");

  // The roster search says what was typed, as typed — matched or not.
  const fake = new FakeHllServer("pw");
  const port = await fake.listen();
  try {
    fake.players = [{ iD: "76561198000000003", name: "x_y_z" }];
    const srv = await repo.servers.create({ name: "Roster", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
    const found = await call(submit(`sp:register:find:200000000000000003:${srv.id}`, "100000000000000001", { q: "x_y" }));
    assert.match(content(found), /matching "x\\_y"/, "a search with matches");
    const none = await call(submit(`sp:register:find:200000000000000003:${srv.id}`, "100000000000000001", { q: "no_one" }));
    assert.match(content(none), /matches "no\\_one"/, "a search with none");
  } finally {
    fake.close();
  }
});
