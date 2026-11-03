/**
 * ONE slash command, and its name is CONFIGURATION.
 *
 * Two rules are under test here, and the first is the one that shapes the bot: there is exactly
 * one command, and everything else is a button inside the panel it opens. A second command was
 * built and removed — a read-only `/status` that duplicated the panel's Servers module — so the
 * count itself is asserted, not just the behaviour of the one that remains.
 *
 * The second rule is that the name Discord is told about and the name the dispatcher answers to
 * are the same string. Renaming the command in the panel and having it then not respond is the
 * exact failure this file exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createIsolatedRepository } from "@app/db";
import { commandSchemas, handleInteraction, registerCommands, staffGuildAccess } from "../dist/discord.js";
import { DiscordModuleRegistry } from "../dist/discord-modules.js";
import { withIsolatedServer as withServer, jsonFetch, assertAsked } from "./harness.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKeyHex: spki.subarray(spki.length - 32).toString("hex"),
    sign: (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex"),
  };
}

/** Fire a slash command at the interactions handler as Discord would, signed for now. */
async function runCommand(repo: Awaited<ReturnType<typeof createIsolatedRepository>>["repo"], name: string, roles: string[] | null = []) {
  const { publicKeyHex, sign } = keypair();
  const ts = String(Math.floor(Date.now() / 1000));
  // roles === null is a DM: no member object at all, which is the case a role gate must refuse.
  const body = JSON.stringify(roles === null
    ? { type: 2, data: { name }, user: { id: "77", username: "someone" } }
    : { type: 2, data: { name }, member: { user: { id: "77", username: "someone" }, roles } });
  return handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body);
}

test("the bot registers exactly one command, and it is the panel launcher", async () => {
  const { repo } = await createIsolatedRepository();
  const cfg = await repo.discordCommands.get();
  assert.equal(cfg.name, "staff");
  assert.equal(cfg.enabled, true);
  // ONE. A second entry here would mean a second surface to find, permission and register, when
  // the panel already lists exactly what the presser is allowed to do.
  assert.deepEqual(commandSchemas(cfg).map((c) => c.name), ["staff"]);
});

test("a renamed command is what gets registered AND what answers", async () => {
  const { repo } = await createIsolatedRepository();
  await repo.discordCommands.set({ name: "lynx", description: "Open the LYNX panel", enabled: true });
  const cfg = await repo.discordCommands.get();

  // Registration installs the new name…
  assert.deepEqual(commandSchemas(cfg).map((c) => c.name), ["lynx"]);
  assert.equal(commandSchemas(cfg)[0]!.description, "Open the LYNX panel");

  // …and the dispatcher answers to it. This instance has no module registry wired, so the
  // launcher itself can't render; what matters is that /lynx is RECOGNISED as the command and
  // the old name is not.
  const renamed = await runCommand(repo, "lynx");
  assert.equal(renamed.status, 200);
  assert.doesNotMatch(String((renamed.body as any).data.content), /Unknown command/);
  const old = await runCommand(repo, "staff");
  assert.match(String((old.body as any).data.content), /Unknown command: staff/, "the old name must go dead once renamed");
});

test("switched off empties the payload and says so if the command is still pressed", async () => {
  const { repo } = await createIsolatedRepository();
  await repo.discordCommands.set({ enabled: false });
  const cfg = await repo.discordCommands.get();
  // PUT is a replace, so an empty payload is a deleted command — that is how "off" reaches Discord.
  assert.deepEqual(commandSchemas(cfg), []);
  // Until somebody presses Register, Discord still shows it. Saying "switched off" beats
  // "Unknown command", which reads like a bug in the bot.
  const pressed = await runCommand(repo, "staff");
  assert.match(String((pressed.body as any).data.content), /switched off/);
});

/*
 * ONE COMMAND, EVERY SERVER, ONE GATE.
 *
 * The install is GLOBAL — every guild the bot is in, including ones it joins later — because any
 * per-guild list is a list somebody has to remember to update, and forgetting shows up as "the
 * command isn't there" with nothing the user can do about it.
 *
 * Being visible everywhere is safe because visibility is not access. Who may OPEN the panel is the
 * staff guild's role map: the same mapped roles that decide who may sign in to the web panel,
 * asked of Discord at press time. Take somebody's staff role away and both doors shut at once.
 */
/*
 * Registration is global, and the guild-scoped sweep covers EVERY guild the bot is in.
 *
 * A guild-scoped command outranks the global one of the same name, so one left behind by an older
 * build keeps showing in that server's picker forever. The sweep used to run over the two ids we
 * keep in config — the staff guild and the community guild — which meant any OTHER Discord the bot
 * had been added to kept the old command with nothing ever going back to look. So the list comes
 * from Discord (`/users/@me/guilds`), not from what we remembered to write down.
 */
test("registration is global, and it clears guild-scoped copies in every guild the bot is in", async () => {
  const { repo } = await createIsolatedRepository();
  const cfg = await repo.discordCommands.get();
  const calls: { path: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  // The bot is in three servers; config only knows about the first.
  const guilds = JSON.stringify([{ id: "111111111111111111" }, { id: "222222222222222222" }, { id: "333333333333333333" }]);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: String(init?.body ?? "") });
    return new Response(path === "/api/v10/users/@me/guilds" ? guilds : "[]", { status: 200 });
  }) as typeof fetch;
  try {
    const first = await registerCommands("tok", "app1", cfg, ["111111111111111111"]);
    assert.equal(calls[0]!.path, "/api/v10/applications/app1/commands", "the install itself is global");
    assert.match(calls[0]!.body, /"staff"/);
    assert.deepEqual(first.names, ["staff"]);

    // Every guild is emptied, including the two nobody wrote down anywhere.
    const cleared = calls.filter((c) => c.path.includes("/guilds/") && c.path.endsWith("/commands"));
    assert.deepEqual(cleared.map((c) => c.path.split("/guilds/")[1]!.replace("/commands", "")).sort(),
      ["111111111111111111", "222222222222222222", "333333333333333333"]);
    assert.ok(cleared.every((c) => c.body === "[]"), "cleared means an empty list, not a rewrite");
    assert.deepEqual(first.clearedGuilds.sort(), ["111111111111111111", "222222222222222222", "333333333333333333"]);

    // A guild that refuses (no applications.commands scope there) is reported, not fatal…
    calls.length = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v10/users/@me/guilds") return new Response(guilds, { status: 200 });
      return path.includes("/guilds/") ? new Response("missing access", { status: 403 }) : new Response("[]", { status: 200 });
    }) as typeof fetch;
    const refused = await registerCommands("tok", "app1", cfg, ["111111111111111111"]);
    assert.deepEqual(refused.names, ["staff"], "the global install still stands");
    assert.deepEqual(refused.clearedGuilds, [], "and it does not claim to have cleared what it could not");

    // Not being able to LIST the guilds falls back to the ids we do hold, rather than sweeping none.
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v10/users/@me/guilds") return new Response("nope", { status: 403 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const blind = await registerCommands("tok", "app1", cfg, ["111111111111111111"]);
    assert.deepEqual(blind.clearedGuilds, ["111111111111111111"]);

    // …but the global install failing is the whole operation failing, and it says why.
    globalThis.fetch = (async () => new Response("bad name", { status: 400 })) as typeof fetch;
    await assert.rejects(registerCommands("tok", "app1", cfg, []), /400/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * Run the command with Discord's staff-guild member lookup stubbed: `roles` is what the staff
 * guild says this account holds, or null for "not a member of that guild at all".
 */
async function runWithStaffRoles(repo: Awaited<ReturnType<typeof createIsolatedRepository>>["repo"], roles: string[] | null) {
  const { publicKeyHex, sign } = keypair();
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 2, data: { name: "staff" }, member: { user: { id: "77", username: "someone" }, roles: ["irrelevant-public-role"] } });
  const fetchImpl = (async (url: string | URL | Request) => {
    assert.match(String(url), /\/guilds\/111111111111111111\/members\/77$/, "the STAFF guild is asked, about this user");
    return roles === null ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ roles }), { status: 200 });
  }) as typeof fetch;
  return handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body, { fetchImpl, registry: new DiscordModuleRegistry() });
}

test("the panel opens on staff-guild roles — the same mapped roles that let someone sign in", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  process.env.DISCORD_TOKEN = "bot-token";
  process.env.DISCORD_GUILD_ID = "111111111111111111";
  try {
    const { repo } = await createIsolatedRepository();
    const role = await repo.roles.create({ name: "Moderator", grants: [{ capability: "server.view", level: "read" }], limits: {} });
    await repo.discordRoleMap.setForDiscordRole("900000000000000001", "Staff", [{ roleId: role.id, scopeId: null }]);

    // Holding the mapped staff role: past the gate (and on to the account check, which is a
    // different refusal — this account has never signed in).
    const ok = await runWithStaffRoles(repo, ["900000000000000001"]);
    assert.doesNotMatch(String((ok.body as any).data.content), /for staff/);

    // In the staff server but without a mapped role — exactly what being removed from staff looks
    // like, and it needs no cleanup anywhere in this app.
    const stripped = await runWithStaffRoles(repo, ["900000000000000002"]);
    assert.match(String((stripped.body as any).data.content), /for staff/);

    // Not in the staff server at all: the public-Discord member who types it out of curiosity.
    // Note their PUBLIC roles ride along on the interaction and count for nothing.
    const outsider = await runWithStaffRoles(repo, null);
    assert.match(String((outsider.body as any).data.content), /for staff/);
  } finally {
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});

test("a Discord blip is not a bypass, and an unconfigured bot does not pretend to gate", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  process.env.DISCORD_TOKEN = "bot-token";
  process.env.DISCORD_GUILD_ID = "111111111111111111";
  const { repo } = await createIsolatedRepository();
  const role = await repo.roles.create({ name: "Moderator", grants: [{ capability: "server.view", level: "read" }], limits: {} });
  await repo.discordRoleMap.setForDiscordRole("900000000000000001", "Staff", [{ roleId: role.id, scopeId: null }]);
  const { publicKeyHex, sign } = keypair();
  const fire = (fetchImpl: typeof fetch) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 2, data: { name: "staff" }, member: { user: { id: "77", username: "someone" } } });
    return handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body, { fetchImpl, registry: new DiscordModuleRegistry() });
  };
  try {
    // Discord 500s, or the request dies: refuse and say to retry. Letting a press through because
    // the check failed would make an outage the way in.
    const down = await fire((async () => new Response("oops", { status: 500 })) as typeof fetch);
    assert.match(String((down.body as any).data.content), /try again/i);
    const threw = await fire((async () => { throw new Error("socket hang up"); }) as typeof fetch);
    assert.match(String((threw.body as any).data.content), /try again/i);

    // No token or no staff guild = nothing to ask. The linked-account check stands alone rather
    // than the app claiming a gate it cannot enforce.
    delete process.env.DISCORD_TOKEN;
    const unchecked = await fire((async () => { throw new Error("must not be called"); }) as typeof fetch);
    assert.match(String((unchecked.body as any).data.content), /No staff account/);
  } finally {
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});

test("the staff-guild verdict is cached briefly — a volley of presses is one member read, but a blip never sticks", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  process.env.DISCORD_TOKEN = "bot-token";
  // Its own guild id, so this test's cache keys cannot collide with any other test's.
  process.env.DISCORD_GUILD_ID = "111111111111111112";
  const { repo } = await createIsolatedRepository();
  const role = await repo.roles.create({ name: "Moderator", grants: [{ capability: "server.view", level: "read" }], limits: {} });
  await repo.discordRoleMap.setForDiscordRole("900000000000000001", "Staff", [{ roleId: role.id, scopeId: null }]);
  const memberJson = () => new Response(JSON.stringify({ roles: ["900000000000000001"], user: { username: "m" } }), { status: 200 });
  try {
    // The check runs on EVERY panel press, and the moderation cart made a dozen presses in half a
    // minute normal — Discord must see ONE member read for the lot, not one per press.
    let calls = 0;
    const counting = (async () => { calls++; return memberJson(); }) as typeof fetch;
    assert.equal((await staffGuildAccess(repo, "88", { fetchImpl: counting, cache: true })).ok, true);
    assert.equal((await staffGuildAccess(repo, "88", { fetchImpl: counting, cache: true })).ok, true);
    assert.equal((await staffGuildAccess(repo, "88", { fetchImpl: counting, cache: true })).ok, true);
    assert.equal(calls, 1, "the second and third press rode the cached verdict");

    // A failed check is an outage, not an answer: the next press must reach Discord again —
    // caching CHECK_FAILED would lock staff out for the TTL over one dropped request.
    let flakyCalls = 0;
    const flaky = (async () => {
      flakyCalls++;
      return flakyCalls === 1 ? new Response("oops", { status: 500 }) : memberJson();
    }) as typeof fetch;
    const down = await staffGuildAccess(repo, "99", { fetchImpl: flaky, cache: true });
    assert.equal(down.ok, false);
    const back = await staffGuildAccess(repo, "99", { fetchImpl: flaky, cache: true });
    assert.equal(back.ok, true, "the retry reached Discord — the blip was never cached");
    assert.equal(flakyCalls, 2);
  } finally {
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});

// ---------------------------------------------------------------------------
// The routes behind the panel's editor and its Register button.
// ---------------------------------------------------------------------------

async function login(base: string, u: string, p: string) {
  const r = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

async function owner(base: string): Promise<Record<string, string>> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return login(base, "owner", "pw");
}

test("the command route is gated on admin.users", async () => {
  await withServer(async (base) => {
    assert.equal((await jsonFetch(`${base}/api/discord/commands`)).status, 401);
    const auth = await owner(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = await login(base, "plain", "pw");
    assert.equal((await jsonFetch(`${base}/api/discord/commands`, { headers: plain })).status, 403);
    // Changing or registering the command is asked for, not done — the name below is untouched.
    assertAsked(await jsonFetch(`${base}/api/discord/commands`, { method: "PUT", headers: plain, body: JSON.stringify({ name: "asked" }) }));
    assertAsked(await jsonFetch(`${base}/api/discord/commands/register`, { method: "POST", headers: plain }));
    const read = await jsonFetch(`${base}/api/discord/commands`, { headers: auth });
    assert.equal(read.status, 200);
    assert.equal(read.body.config.name, "staff");
  });
});

test("the PUT enforces Discord's own naming rules before Discord has to", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const put = (body: unknown) => jsonFetch(`${base}/api/discord/commands`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    // Each refusal is a name Discord would have rejected on the Register press instead, where the
    // error is far away from the field that caused it.
    assert.equal((await put({ name: "" })).status, 400);
    assert.equal((await put({ name: "two words" })).status, 400);
    assert.equal((await put({ name: "Staff" })).status, 200, "an uppercase name is folded, not refused");
    assert.equal((await put({ name: "x".repeat(33) })).status, 400);
    assert.equal((await put({ name: "ok", description: "" })).status, 400);
    assert.equal((await put({ name: "ok", description: "d".repeat(101) })).status, 400);

    // A partial patch leaves the fields it does not mention alone.
    assert.equal((await put({ name: "lynx", description: "Open the LYNX panel", enabled: true })).status, 200);
    const only = await put({ enabled: false });
    assert.equal(only.body.config.name, "lynx");
    assert.equal(only.body.config.description, "Open the LYNX panel");

    // A good write persists and leaves a trail.
    const ok = await put({ name: "lynx", description: "Open the LYNX panel", enabled: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.config.name, "lynx");
    assert.equal((await repo.discordCommands.get()).description, "Open the LYNX panel");
    const audit = await repo.audit.list({ limit: 20 });
    assert.ok(audit.some((a) => a.action === "discord.commands.config"), "renaming a command is a staff action");
  });
});

test("Register refuses, in words, when the bot credentials are missing", async () => {
  const { DISCORD_TOKEN, DISCORD_APP_ID } = process.env;
  delete process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_APP_ID;
  try {
    await withServer(async (base) => {
      const auth = await owner(base);
      // The GET says the button will not work, so the panel can explain it rather than fail on press.
      const read = await jsonFetch(`${base}/api/discord/commands`, { headers: auth });
      assert.equal(read.body.canRegister, false);
      const r = await jsonFetch(`${base}/api/discord/commands/register`, { method: "POST", headers: auth });
      assert.equal(r.status, 409);
      assert.match(String(r.body.error.message), /bot token is set — add it under Discord → Setup & status/, "and says where it is set");
    });
  } finally {
    if (DISCORD_TOKEN !== undefined) process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_APP_ID !== undefined) process.env.DISCORD_APP_ID = DISCORD_APP_ID;
  }
});

/*
 * TWO DISCORDS, not one.
 *
 * A community is usually a staff server people are invited into and a public one everybody joins.
 * DISCORD_GUILD_ID is the staff one: it decides who may sign in and which roles map to panel roles.
 * The claim gates need the PUBLIC server's roles, because that is where the members are — asking
 * the only guild the app knew about is why the claim picker offered staff roles and nothing else.
 */
test("the roles endpoint serves the staff server by default and the public one on request", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  process.env.DISCORD_TOKEN = "bot-token";
  process.env.DISCORD_GUILD_ID = "111111111111111111";
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  // Only Discord is stubbed. The test's own requests to the local API server go through the real
  // fetch — swallowing those was the first version of this test, and it "failed" for that reason.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("discord.com")) return realFetch(url, init);
    asked.push(String(url));
    return new Response(JSON.stringify([{ id: "9001", name: "Boosters" }]), { status: 200 });
  }) as typeof fetch;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      await repo.appConfig.set({ communityGuildId: "222222222222222222" });

      const staff = await jsonFetch(`${base}/api/discord/roles`, { headers: auth });
      assert.equal(staff.body.guildId, "111111111111111111", "the default is the staff server (the role map's)");

      const community = await jsonFetch(`${base}/api/discord/roles?guild=community`, { headers: auth });
      assert.equal(community.body.guildId, "222222222222222222", "?guild=community asks the public server");
      assert.ok(asked.some((u) => u.includes("/guilds/222222222222222222/roles")), "and actually asks Discord for THAT guild");
      assert.equal(community.body.fellBack, false, "a configured public server is not a substitution");

      // No public server configured is not an error — a community with one Discord uses it for both.
      await repo.appConfig.set({ communityGuildId: "" });
      const fallback = await jsonFetch(`${base}/api/discord/roles?guild=community`, { headers: auth });
      assert.equal(fallback.body.guildId, "111111111111111111", "blank falls back to the staff server");
      // But it SAYS so. Silence here is how a role gate dies: the picker offers staff roles, the
      // gate stores a staff role id, the VIP panel reads public-server roles, nothing ever matches,
      // and a claim nobody can make is drawn exactly like a claim switched off.
      assert.equal(fallback.body.fellBack, true, "the substitution is reported, not made quietly");
      // Only for the caller who asked for the public server — the role map wanted the staff one.
      assert.equal((await jsonFetch(`${base}/api/discord/roles`, { headers: auth })).body.fellBack, false);
    });
  } finally {
    globalThis.fetch = realFetch;
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});

/*
 * Managed roles are FLAGGED, not filtered.
 *
 * The old list dropped every managed role because a bot cannot hand them out — which threw away
 * exactly the roles a community gates its perks on: Server Booster, and the Patreon / Twitch /
 * donor roles owned by integrations. "Boosters only" is the most common claim rule there is, and
 * it could not be expressed at all. Gating reads any role; only the pickers that ASSIGN one care
 * about `managed`, and they have the flag to filter on.
 */
test("the roles list keeps managed roles (booster, patron) and flags them for assigning pickers", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  process.env.DISCORD_TOKEN = "bot-token";
  process.env.DISCORD_GUILD_ID = "333333333333333333";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("discord.com")) return realFetch(url, init);
    return new Response(JSON.stringify([
      { id: "333333333333333333", name: "@everyone" },
      { id: "1001", name: "Member", managed: false },
      // The booster role exactly as Discord serves it: managed, tagged, value null.
      { id: "1002", name: "Server Booster", managed: true, tags: { premium_subscriber_role: null } },
      // An integration's role — a Patreon tier, a donor rank. Gated on constantly; never assignable.
      { id: "1003", name: "Patron", managed: true, tags: { integration_id: "42" } },
    ]), { status: 200 });
  }) as typeof fetch;
  try {
    await withServer(async (base) => {
      const auth = await owner(base);
      const r = await jsonFetch(`${base}/api/discord/roles`, { headers: auth });
      const roles = r.body.roles as { id: string; name: string; managed?: boolean }[];
      assert.deepEqual(roles.map((x) => x.name).sort(), ["Member", "Patron", "Server Booster"],
        "every role but @everyone — the gates need the managed ones most of all");
      assert.equal(roles.find((x) => x.name === "Server Booster")?.managed, true, "flagged so assigning pickers can skip it");
      assert.equal(roles.find((x) => x.name === "Patron")?.managed, true);
      assert.equal(roles.find((x) => x.name === "Member")?.managed, false);
    });
  } finally {
    globalThis.fetch = realFetch;
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});
