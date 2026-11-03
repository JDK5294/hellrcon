/**
 * The /staff module panel (docs/discord-modules.md): the custom_id codec, the launcher, the
 * per-press capability gate, host-owned Back, deferred follow-ups, and plugin registration.
 *
 * Everything drives the REAL handleInteraction with real signatures — the codec refusing a bad
 * id matters exactly as much as the verifier refusing a bad signature, so neither is stubbed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createRepository } from "@app/db";
import { PluginHost, definePlugin, type DiscordModuleDef } from "@app/plugin-sdk";
import { handleInteraction } from "../dist/discord.js";
import {
  DiscordModuleRegistry, decodeCustomId, encodeCustomId, registerBuiltinModules,
  renderLauncher, renderModuleView,
} from "../dist/discord-modules.js";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  const sign = (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex");
  return { publicKeyHex, sign };
}

type Interaction = Record<string, unknown>;
function makeCaller(repo: Awaited<ReturnType<typeof createRepository>>, registry: DiscordModuleRegistry, extra: { appId?: string; fetchImpl?: typeof fetch } = {}) {
  const { publicKeyHex, sign } = keypair();
  return (interaction: Interaction) => {
    const body = JSON.stringify(interaction);
    const ts = String(Math.floor(Date.now() / 1000));
    return handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body, { registry, ...extra });
  };
}

const press = (customId: string, discordUserId: string, channelId = "555000555", channelName = "staff-cmds"): Interaction => ({
  type: 3, token: "tok_1", channel_id: channelId, channel: { id: channelId, name: channelName },
  data: { custom_id: customId }, member: { user: { id: discordUserId, username: "presser" } },
});
const slash = (name: string, discordUserId: string, channelName = "staff-cmds"): Interaction => ({
  type: 2, token: "tok_1", channel_id: "555000555", channel: { id: "555000555", name: channelName },
  data: { name }, member: { user: { id: discordUserId, username: "presser" } },
});

test("custom_id codec: roundtrip, colons in state, refusals, foreign ids", () => {
  assert.equal(encodeCustomId("vip", "buy", "offer_x:3"), "sp:vip:buy:offer_x:3");
  assert.deepEqual(decodeCustomId("sp:vip:buy:offer_x:3"), { moduleId: "vip", action: "buy", state: "offer_x:3" });
  assert.deepEqual(decodeCustomId("sp:my_plug.panel::"), { moduleId: "my_plug.panel", action: "", state: "" });
  // Not ours: other surfaces' component ids pass through untouched (null, not an error).
  assert.equal(decodeCustomId("vote:round:2"), null);
  assert.equal(decodeCustomId("sp:UPPER::"), null);
  // Refused at RENDER time: a too-long id is a bug at the source, not a dead button later.
  assert.throws(() => encodeCustomId("vip", "buy", "x".repeat(120)), /too long/);
  assert.throws(() => encodeCustomId("Bad Id!", "open"), /bad module id/);
});

test("the launcher pages past Discord's component limits; module views always carry Back", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `m${i}`, label: `Module ${i}`, capability: "server.view", open: () => ({ content: "x" }),
  }));
  const page0 = renderLauncher(many, 0);
  // 20 buttons per page (4 rows of 5) + the pager row.
  assert.equal(page0.components.length, 5);
  const pager = (page0.components[4] as { components: { label: string; disabled?: boolean }[] }).components;
  assert.equal(pager[0]!.disabled, true, "Prev disabled on the first page");
  const page1 = renderLauncher(many, 1);
  const rows1 = page1.components as { components: unknown[] }[];
  assert.equal(rows1[0]!.components.length, 5);
  assert.equal(rows1.length, 2, "5 remaining modules + the pager row");

  const view = renderModuleView("vip", { content: "hello", rows: [[{ label: "Buy", customId: "buy:offer" }]] });
  const last = (view.components.at(-1) as { components: { custom_id: string }[] }).components[0]!;
  assert.equal(last.custom_id, "sp:home::", "the host's Back row is always appended");
  const first = (view.components[0] as { components: { custom_id: string }[] }).components[0]!;
  assert.equal(first.custom_id, "sp:vip:buy:offer");
});

test("staff views may hold selects, and the rows they cost are charged before the buttons are sliced", () => {
  // The staff panel and the public one are one renderer now, and this is the rule that made them
  // worth merging: a select costs a row, so do the escape row — charge for them FIRST or the last
  // button row is silently dropped. The public roster shipped that bug (page 1/5, no way to
  // page), which is exactly the shape the manual-registration roster has.
  const view = renderModuleView("register", {
    content: "pick",
    select: { customId: "pick:s1", placeholder: "Choose", options: [{ label: "Rifleman", value: "steam|1" }] },
    userSelect: { customId: "member" },
    rows: [
      [{ label: "a", customId: "a" }], [{ label: "b", customId: "b" }],
      [{ label: "c", customId: "c" }], [{ label: "d", customId: "d" }],
    ],
  });
  const rows = view.components as { components: { type: number; custom_id: string }[] }[];
  assert.ok(rows.length <= 5, "Discord's five-row ceiling is never exceeded");
  assert.equal(rows[0]!.components[0]!.type, 3, "the string select leads");
  assert.equal(rows[0]!.components[0]!.custom_id, "sp:register:pick:s1", "routed with the staff prefix");
  assert.ok(rows.some((r) => r.components[0]!.type === 5), "the user select survived the slice");
  assert.equal(rows.at(-1)!.components[0]!.custom_id, "sp:home::", "and so did Back");
});

test("/staff: unlinked users are told to link; permissions decide the launcher's contents", async () => {
  const repo = await createRepository();
  const registry = new DiscordModuleRegistry();
  registerBuiltinModules(registry, repo);
  const call = makeCaller(repo, registry);

  // Nobody linked to this Discord id → the link message, not an empty panel.
  const unlinked = await call(slash("staff", "999000111"));
  assert.match(((unlinked.body as { data: { content: string } }).data).content, /No staff account/);

  // An account with server.view sees the Servers module…
  const staff = await repo.users.create({ username: "mod", discordId: "111222333" });
  await repo.grants.create({ userId: staff.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const panel = await call(slash("staff", "111222333"));
  const data = (panel.body as { data: { content: string; components: unknown[]; flags: number } }).data;
  assert.match(data.content, /Servers/);
  assert.equal(data.flags, 64, "the launcher is ephemeral");
  assert.ok(data.components.length >= 1);

  // …while a linked account with NO grants gets the empty-panel explanation.
  await repo.users.create({ username: "plain", discordId: "444555666" });
  const empty = await call(slash("staff", "444555666"));
  assert.match(((empty.body as { data: { content: string } }).data).content, /don't have access to any modules/);
});

test("a press re-checks capability NOW, dispatches into the module, and Back returns home", async () => {
  const repo = await createRepository();
  await repo.servers.create({ name: "Alpha", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "observe" } as never);
  const registry = new DiscordModuleRegistry();
  registerBuiltinModules(registry, repo);
  const call = makeCaller(repo, registry);

  const staff = await repo.users.create({ username: "mod2", discordId: "777000777" });
  const grant = await repo.grants.create({ userId: staff.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });

  // Open the Servers module: an UPDATE (the panel navigates in place), with the server listed
  // and the host's Back row attached.
  const open = await call(press("sp:servers::", "777000777"));
  const view = (open.body as { type: number; data: { content: string; components: { components: { custom_id: string }[] }[] } });
  assert.equal(view.type, 7);
  assert.match(view.data.content, /Alpha/);
  assert.equal(view.data.components.at(-1)!.components[0]!.custom_id, "sp:home::");

  // Back re-renders the launcher.
  const home = await call(press("sp:home::", "777000777"));
  assert.match((home.body as { data: { content: string } }).data.content, /Staff panel/);

  // The button is still on their screen — but the grant is gone, and the press is refused.
  await repo.grants.remove(grant.id);
  const refused = await call(press("sp:servers::", "777000777"));
  assert.match((refused.body as { data: { content: string } }).data.content, /don't have access/);

  // A module that never existed is a calm message, not a crash.
  await repo.grants.create({ userId: staff.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const gone = await call(press("sp:ghost::", "777000777"));
  assert.match((gone.body as { data: { content: string } }).data.content, /no longer installed/);
});

test("Servers lists the servers the presser may see, numbered as the panel numbers them", async () => {
  const repo = await createRepository();
  const mk = (name: string) => repo.servers.create({ name, game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "observe" } as never);
  await mk("Alpha");
  const bravo = await mk("Bravo");
  const charlie = await mk("Charlie");
  await repo.servers.setRetired(bravo.id, true);
  const registry = new DiscordModuleRegistry();
  registerBuiltinModules(registry, repo);
  const call = makeCaller(repo, registry);
  const open = async (discordUserId: string) =>
    ((await call(press("sp:servers::", discordUserId))).body as { data: { content: string } }).data.content;

  // One server's grant: that server alone, under the number everyone else knows it by — the
  // panel counts every server ever added, the retired Bravo included, so Charlie stays #3.
  const one = await repo.users.create({ username: "one", discordId: "101000101" });
  await repo.grants.create({ userId: one.id, capability: "server.view", scopeType: "server", scopeId: charlie.id, level: "read" });
  const narrow = await open("101000101");
  assert.match(narrow, /Servers \(1\)/);
  assert.match(narrow, /\*\*#3 Charlie\*\*/);
  assert.doesNotMatch(narrow, /Alpha/, "a server the grant does not reach is not named");

  // Every server: the live ones, numbered the same way; the retired one is not listed.
  const all = await repo.users.create({ username: "all", discordId: "202000202" });
  await repo.grants.create({ userId: all.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const wide = await open("202000202");
  assert.match(wide, /Servers \(2\)/);
  assert.match(wide, /\*\*#1 Alpha\*\*/);
  assert.match(wide, /\*\*#3 Charlie\*\*/);
  assert.doesNotMatch(wide, /Bravo/);
});

test("a deferred module ACKs inside the budget and edits the original message when done", async () => {
  const repo = await createRepository();
  const registry = new DiscordModuleRegistry();
  registry.register({
    id: "slowpoke", label: "Slowpoke", capability: "server.view", defer: true,
    open: async () => { await new Promise((r) => setTimeout(r, 20)); return { content: "took a while, worth it" }; },
  });
  const patches: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    patches.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const call = makeCaller(repo, registry, { appId: "app123", fetchImpl });

  const staff = await repo.users.create({ username: "mod3", discordId: "888000888" });
  await repo.grants.create({ userId: staff.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });

  const r = await call(press("sp:slowpoke::", "888000888"));
  assert.equal((r.body as { type: number }).type, 6, "DEFERRED_UPDATE inside the 3-second budget");
  assert.ok(r.followUp, "the work continues after the ACK");
  await r.followUp;
  assert.equal(patches.length, 1);
  assert.match(patches[0]!.url, /webhooks\/app123\/tok_1\/messages\/@original/);
  assert.match(patches[0]!.body, /took a while/);
});

/*
 * Discord leaves a panel's buttons pressable while a deferred press runs, so a double-click ran the
 * work twice — a moderation volley fired twice, a map loaded twice. One slow press per panel.
 */
test("a second press on a panel while its slow press runs is acknowledged and dropped — the work runs once", async () => {
  const repo = await createRepository();
  const registry = new DiscordModuleRegistry();
  let runs = 0;
  let finish!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  registry.register({
    id: "slowpoke", label: "Slowpoke", capability: "server.view", defer: true,
    open: async () => { runs++; await gate; return { content: `ran ${runs}` }; },
  });
  const patches: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    patches.push(String(init?.body ?? ""));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const call = makeCaller(repo, registry, { appId: "app123", fetchImpl });
  const staff = await repo.users.create({ username: "mod4", discordId: "888000999" });
  await repo.grants.create({ userId: staff.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const onPanel = (messageId: string): Interaction => ({ ...press("sp:slowpoke::", "888000999"), message: { id: messageId, flags: 64 } });

  const first = await call(onPanel("panel-1"));
  const second = await call(onPanel("panel-1"));
  assert.equal((second.body as { type: number }).type, 6, "acknowledged inside the budget");
  assert.equal(second.followUp, undefined, "and dropped: no second run, no second edit");
  // Another panel is its own: the same person's press there is not held up.
  const other = await call(onPanel("panel-2"));
  assert.ok(other.followUp, "a different panel runs");
  finish();
  await Promise.all([first.followUp, other.followUp]);
  assert.equal(runs, 2, "panel-1 once, panel-2 once");
  assert.equal(patches.length, 2);
  // The dropped press is not in the trail as an action somebody took.
  const used = (await repo.audit.list({ limit: 50 })).filter((a) => a.action === "discord.module.open");
  assert.equal(used.length, 2);

  // Once its press has answered, the panel takes presses again.
  const after = await call(onPanel("panel-1"));
  assert.ok(after.followUp, "the panel is free once its press has answered");
  await after.followUp;
  assert.equal(runs, 3);
});

test("plugins add modules through the SDK: namespaced id, gone again on unload", async () => {
  const registry = new DiscordModuleRegistry();
  const plug = definePlugin({
    manifest: { id: "shoppy", name: "Shoppy", version: "1.0.0", apiVersion: 1, capabilities: ["discord"] },
    activate(host) {
      host.discord!.registerModule({
        id: "panel", label: "Shop", capability: "economy.config",
        open: () => ({ content: "shop things" }),
      } as DiscordModuleDef);
    },
  });
  const host = new PluginHost({
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) as never,
    events: { on: () => () => {} },
    ui: { registerWidget: () => {}, provideData: () => {} },
    storage: { get: async () => undefined, set: async () => {} },
    discord: { registerModule: (d) => registry.register(d), unregisterModule: (id) => registry.unregister(id) },
  });
  await host.load(plug);
  assert.ok(registry.get("shoppy.panel"), "namespaced with a dot — the colon belongs to the custom_id");
  assert.equal(registry.get("panel"), undefined, "the bare id never lands in the shared map");
  await host.unload("shoppy");
  assert.equal(registry.get("shoppy.panel"), undefined, "a stale button cannot dispatch into unloaded code");
});

/*
 * "Staff launches vip panel opener" — from inside Discord, in the channel they are standing in.
 *
 * The launcher message is what the public ever sees of the VIP system, and for a long time the
 * only way to post it was an API call nothing in the app made. This is the module that posts it,
 * and what matters is that it takes a confirming press (posting twice makes two launchers), that
 * the channel comes from the interaction rather than being typed, and that economy.manage — not
 * merely "can open /staff" — is what admits you.
 */
test("VIP launcher module: economy.manage only, posts the opener into the channel it was run in", async () => {
  const repo = await createRepository();
  const posted: { channelId: string; message: { content: string; components: unknown[] } }[] = [];
  const registry = new DiscordModuleRegistry();
  registerBuiltinModules(registry, repo, async (channelId, message) => void posted.push({ channelId, message }));
  const call = makeCaller(repo, registry, { appId: "app1", fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });

  // A staff account with server.view but no economy.manage cannot even see it on the launcher.
  const viewer = await repo.users.create({ username: "viewer", discordId: "800000001" });
  await repo.grants.create({ userId: viewer.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });
  const theirPanel = await call(slash("staff", "800000001"));
  assert.doesNotMatch(((theirPanel.body as { data: { content: string } }).data).content, /VIP launcher/);
  const refused = await call(press("sp:viplauncher:post:", "800000001"));
  assert.match(((refused.body as { data: { content: string } }).data).content, /don't have access/);
  assert.equal(posted.length, 0, "a refused press must not post anything");

  // With economy.manage write, it is on the launcher and opening it ASKS rather than posting.
  const manager = await repo.users.create({ username: "manager", discordId: "800000002" });
  await repo.grants.create({ userId: manager.id, capability: "economy.config", scopeType: "global", scopeId: null, level: "write" });
  const opened = await call(press("sp:viplauncher::", "800000002"));
  await opened.followUp;
  assert.equal(posted.length, 0, "opening the module posts nothing — the press does");

  // The confirming press posts into the channel Discord said the interaction came from.
  const done = await call(press("sp:viplauncher:post:", "800000002", "123123123", "vip-signup"));
  await done.followUp;
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.channelId, "123123123", "the channel comes from the interaction, not a typed id");
  const button = (posted[0]!.message.components[0] as { components: { custom_id: string }[] }).components[0]!;
  assert.equal(button.custom_id, "pp:vip::", "the posted button opens the PUBLIC panel, with a static id that survives restarts");

  // A permanent public message is something somebody answers for later: WHO, WHEN, WHICH CHANNEL.
  const trail = await repo.audit.list({});
  const posting = trail.find((a) => a.action === "economy.launcher");
  assert.ok(posting, "posting a launcher is a staff action and must be on the trail");
  assert.equal(posting!.actorUserId, manager.id, "attributed to the staff ACCOUNT, not the Discord id");
  assert.match(posting!.summary, /#vip-signup/, "the channel is named in the sentence, not buried in data");
  assert.equal((posting!.data as { channelId: string }).channelId, "123123123");
  assert.equal((posting!.data as { via: string }).via, "discord", "and which surface it was done from");
});

/*
 * Everything staff do through Discord has to be answerable afterwards.
 *
 * The trap this guards is that the panel is a REMOTE CONTROL: a staff member can open modules and
 * act on the community from their phone, in a channel, with no browser session and nothing in the
 * web app's request log. If the record depended on each module remembering to write one, the first
 * module anybody added in a hurry would be a hole. So the HOST writes it, and this asserts the
 * host does — for the command itself, for opening a module, and for acting inside one.
 */
test("the staff panel records itself: who ran it, what they opened, and what they pressed", async () => {
  const repo = await createRepository();
  await repo.servers.create({ name: "Alpha", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "observe" } as never);
  const registry = new DiscordModuleRegistry();
  registerBuiltinModules(registry, repo, async () => { /* not used here */ });
  const call = makeCaller(repo, registry, { appId: "app1", fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch });

  const staff = await repo.users.create({ username: "onduty", discordId: "900000001" });
  await repo.grants.create({ userId: staff.id, capability: "server.view", scopeType: "global", scopeId: null, level: "read" });

  await call(slash("staff", "900000001", "mod-chat"));
  await call(press("sp:servers::", "900000001", "555000555", "mod-chat"));

  const trail = await repo.audit.list({});
  const opened = trail.find((a) => a.action === "discord.panel.open");
  assert.ok(opened, "running the command is recorded");
  assert.equal(opened!.actorUserId, staff.id);
  assert.match(opened!.summary, /opened the staff panel in #mod-chat/);
  assert.equal((opened!.data as { discordUserId: string }).discordUserId, "900000001", "the Discord id rides along for matching back");

  const module = trail.find((a) => a.action === "discord.module.open");
  assert.ok(module, "opening a module is recorded");
  assert.match(module!.summary, /opened \*\*Servers\*\*/);
  assert.equal(module!.targetId, "servers");

  // A press that is refused for lack of permission is NOT recorded as use — nothing happened.
  const outsider = await repo.users.create({ username: "nogrants", discordId: "900000002" });
  await call(press("sp:servers::", "900000002"));
  assert.equal(trail.length > 0 && (await repo.audit.list({})).filter((a) => a.actorUserId === outsider.id).length, 0);
});
