/**
 * The Moderation panel on the staff /command: a volley cart that FIRES what the presser's own
 * grants cover and FILES one approval request for everything they lack.
 *
 * What is actually under test:
 *   - the flow end to end: server pick → roster targets (live read off the game) → action
 *     toggles with their detail modals → review marks → send;
 *   - fire is real: a held write reaches the game (the fake records the command), writes the
 *     same audit row the web route would — under the staff ACCOUNT, marked "via Discord panel" —
 *     and a tempban lands a playerBans decision row;
 *   - file is real: lacking writes become ONE open approval request whose lines carry the exact
 *     capability, kind and payload an approver needs — never a refusal;
 *   - a mixed volley does both at once, which is the whole point of the cart;
 *   - observe mode blocks the fire path with the web route's own words, and a watch on a player
 *     the panel has never seen skips with a warning instead of minting a broken line.
 *
 * Everything drives the real handleInteraction with real signatures, like every panel test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createIsolatedRepository, type Repository } from "@app/db";
import { handleInteraction } from "../dist/discord.js";
import { DiscordModuleRegistry, registerBuiltinModules } from "../dist/discord-modules.js";
import { wireModerationPanel } from "../dist/discord-moderation-wiring.js";
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

const STAFF = "100000000000000001";
const ALPHA = "76561198000000001";
const BRAVO = "76561198000000002";

async function staffAccount(repo: Repository, caps: { capability: string; level?: "read" | "write"; scopeId?: string | null }[]) {
  const user = await repo.users.create({ username: `staff-${STAFF}`, discordId: STAFF });
  for (const c of caps) {
    await repo.grants.create({
      userId: user.id, capability: c.capability,
      scopeType: c.scopeId ? "server" : "global", scopeId: c.scopeId ?? null, level: c.level ?? "write",
    });
  }
  return user;
}

/** A live game the panel can dial: fake server on a loopback port + its row, active by default. */
async function liveServer(repo: Repository, opts: { active?: boolean } = {}) {
  const fake = new FakeHllServer("pw");
  fake.players = [
    { iD: ALPHA, name: "Alpha", platform: "steam" },
    { iD: BRAVO, name: "Bravo", platform: "steam" },
  ];
  const port = await fake.listen();
  const server = await repo.servers.create({
    name: "WW2 #1", host: "127.0.0.1", port, password: "pw",
    engagementMode: opts.active === false ? "observe" : "active",
  });
  return { fake, server, key: server.id.replaceAll("-", "").slice(0, 8) };
}

function caller(repo: Repository) {
  // The executor and filing need only ctx.repo (the card post no-ops without DISCORD_TOKEN).
  wireModerationPanel({ repo } as unknown as Parameters<typeof wireModerationPanel>[0]);
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

const press = (customId: string, extra: Record<string, unknown> = {}) => ({
  type: 3, token: "tok", channel_id: "900", channel: { id: "900", name: "staff-cmds" },
  message: { id: "m1", flags: 64 },
  data: { custom_id: customId, ...extra },
  member: { user: { id: STAFF, username: "admin" }, roles: [] },
});
const submit = (customId: string, values: Record<string, string>) => ({
  type: 5, token: "tok", channel_id: "900", channel: { id: "900", name: "staff-cmds" },
  message: { id: "m1", flags: 64 },
  data: {
    custom_id: customId,
    components: Object.entries(values).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })),
  },
  member: { user: { id: STAFF, username: "admin" }, roles: [] },
});

const content = (b: Body): string => String((b.data as { content?: unknown }).content ?? "");
const allIds = (b: Body): string[] => {
  const rows = ((b.data as { components?: unknown }).components ?? []) as { components: { custom_id?: string }[] }[];
  return rows.flatMap((r) => r.components.map((c) => String(c.custom_id ?? "")));
};

test("the cart end to end: pick the server, add from the live roster, toggle an action through its modal", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "action.kick", scopeId: server.id },
    ]);
    const call = caller(repo);

    const launcher = await call(press("sp:home::"));
    assert.match(content(launcher), /Moderation/);

    const pick = await call(press("sp:moderation::"));
    assert.match(content(pick), /pick the server/i);
    assert.ok(allIds(pick).includes("sp:moderation:srv:"), "the server select is there");

    const cart = await call(press("sp:moderation:srv:", { values: [key] }));
    assert.match(content(cart), /Targets \(0\)/);

    // The roster comes off the GAME, not a table — the fake's two names, alphabetical.
    const picker = await call(press("sp:moderation:pl:"));
    assert.match(content(picker), /2 online/);
    const added = await call(press("sp:moderation:padd:0", { values: [ALPHA] }));
    assert.match(content(added), /In the cart \(1\): Alpha/);

    const back = await call(press("sp:moderation:b:"));
    assert.match(content(back), /Targets \(1\)/);

    // Toggling an action on opens its detail modal; the submit lands it in the cart, reason shown.
    const modal = await call(press("sp:moderation:tog:kick"));
    assert.equal(modal.type, 9, "kick asks its reason in a modal");
    assert.equal((modal.data as { custom_id?: string }).custom_id, "sp:moderation:det:kick");
    const withAct = await call(submit("sp:moderation:det:kick", { reason: "teamkilling at spawn" }));
    assert.match(content(withAct), /Kick — teamkilling at spawn/);

    // Toggling again removes it — the ✔ is a switch, not a stack.
    const removed = await call(press("sp:moderation:tog:kick"));
    assert.match(content(removed), /Actions \(0\)/);
  } finally {
    fake.close();
  }
});

test("fire: a held write executes — the game gets the command, the trail gets the staff account (via Discord panel)", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    const staff = await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "action.message", scopeId: server.id },
      { capability: "action.tempban", scopeId: server.id },
    ]);
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: ALPHA, name: "Alpha" });
    const call = caller(repo);

    await call(press("sp:moderation:srv:", { values: [key] }));
    // By-id entry this time — the other door onto the target list.
    const modal = await call(press("sp:moderation:addm:"));
    assert.equal(modal.type, 9);
    const withTarget = await call(submit("sp:moderation:addid:", { pid: ALPHA }));
    assert.match(content(withTarget), /Alpha/, "the id resolved to the directory name");

    await call(press("sp:moderation:tog:message"));
    await call(submit("sp:moderation:det:message", { message: "watch the teamkills" }));
    await call(press("sp:moderation:tog:tempban"));
    await call(submit("sp:moderation:det:tempban", { hours: "24", reason: "teamkilling" }));

    const review = await call(press("sp:moderation:rev:"));
    assert.match(content(review), /1 target\(s\) × 2 action\(s\)/);
    assert.match(content(review), /✅ .*Message.*fires now/);
    assert.match(content(review), /✅ .*Temp ban 24h.*fires now/);

    const sent = await call(press("sp:moderation:go:"));
    assert.match(content(sent), /✅ .*Message.*\*\*Alpha\*\*/);
    assert.match(content(sent), /✅ .*Temp ban.*\*\*Alpha\*\*/);

    // The game really got both…
    assert.equal(fake.messages.length, 1);
    assert.match(fake.messages[0]!.message, /watch the teamkills/);
    assert.equal(fake.tempBans.get(ALPHA)?.hours, 24);
    // …the audit rows carry the STAFF ACCOUNT and the panel's provenance…
    const trail = await repo.audit.list({ actions: ["player.message", "player.tempban"], limit: 10 });
    assert.equal(trail.length, 2);
    for (const row of trail) {
      assert.equal(row.actorUserId, staff.id);
      assert.match(row.summary, /via Discord panel/);
    }
    // …the tempban is a decision row like the web's, and nothing was filed.
    const bans = await repo.playerBans.list({ playerId: ALPHA });
    assert.equal(bans.length, 1);
    assert.equal(bans[0]!.kind, "temp");
    assert.equal((await repo.approvals.list({ status: ["open"] })).length, 0);
  } finally {
    fake.close();
  }
});

test("file: lacking every write, the volley becomes ONE open request with the exact lines — never a refusal", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    const staff = await staffAccount(repo, [{ capability: "server.view", level: "read" }]);
    const call = caller(repo);

    await call(press("sp:moderation:srv:", { values: [key] }));
    await call(press("sp:moderation:pl:"));
    await call(press("sp:moderation:padd:0", { values: [ALPHA] }));
    await call(press("sp:moderation:padd:0", { values: [BRAVO] }));
    await call(press("sp:moderation:b:"));
    await call(press("sp:moderation:tog:permaban"));
    await call(submit("sp:moderation:det:permaban", { reason: "cheating" }));

    const review = await call(press("sp:moderation:rev:"));
    assert.match(content(review), /📨 .*Perma ban.*filed for approval/);

    const sent = await call(press("sp:moderation:go:"));
    assert.match(content(sent), /One request filed.*2 line\(s\)/);

    const open = await repo.approvals.list({ status: ["open"] });
    assert.equal(open.length, 1, "two lacking lines, ONE request");
    assert.equal(open[0]!.requesterUserId, staff.id);
    const lines = open[0]!.lines;
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.kind, "permaban");
      assert.equal(line.capability, "action.permaban");
      assert.equal(line.serverId, server.id);
      assert.equal(line.payload.reason, "cheating");
    }
    assert.deepEqual(lines.map((l) => l.playerId).sort(), [ALPHA, BRAVO]);
    // Nothing reached the game, and the trail shows a filing, not an action.
    assert.equal(fake.permaBans.size, 0);
    assert.equal((await repo.audit.list({ actions: ["request.file"], limit: 5 })).length, 1);
  } finally {
    fake.close();
  }
});

test("a mixed volley fires what it may and files the rest in the same press", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "action.message", scopeId: server.id },
      // no action.permaban — that half must file
    ]);
    const call = caller(repo);

    await call(press("sp:moderation:srv:", { values: [key] }));
    await call(press("sp:moderation:pl:"));
    await call(press("sp:moderation:padd:0", { values: [ALPHA] }));
    await call(press("sp:moderation:b:"));
    await call(press("sp:moderation:tog:message"));
    await call(submit("sp:moderation:det:message", { message: "final warning" }));
    await call(press("sp:moderation:tog:permaban"));
    await call(submit("sp:moderation:det:permaban", { reason: "cheating" }));

    const review = await call(press("sp:moderation:rev:"));
    assert.match(content(review), /✅ .*Message.*fires now/);
    assert.match(content(review), /📨 .*Perma ban.*filed for approval/);

    const sent = await call(press("sp:moderation:go:"));
    assert.match(content(sent), /✅ .*Message/);
    assert.match(content(sent), /📨 .*Perma ban/);
    assert.match(content(sent), /One request filed.*1 line\(s\)/);

    assert.equal(fake.messages.length, 1, "the message fired");
    assert.equal(fake.permaBans.size, 0, "the ban did NOT — it went to the queue");
    const open = await repo.approvals.list({ status: ["open"] });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.lines.length, 1);
    assert.equal(open[0]!.lines[0]!.kind, "permaban");
  } finally {
    fake.close();
  }
});

test("an over-cap temp ban fires at the cap and files the remainder as an extension — the web's split, in Discord", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    const staff = await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "action.tempban", scopeId: server.id },
    ]);
    await repo.userLimits.replace(staff.id, { "tempban.maxHours": 24 });
    const call = caller(repo);

    await call(press("sp:moderation:srv:", { values: [key] }));
    await call(press("sp:moderation:pl:"));
    await call(press("sp:moderation:padd:0", { values: [ALPHA] }));
    await call(press("sp:moderation:b:"));
    await call(press("sp:moderation:tog:tempban"));
    await call(submit("sp:moderation:det:tempban", { hours: "72", reason: "teamkilling" }));

    // The split is disclosed on the review screen, not discovered after Send.
    const review = await call(press("sp:moderation:rev:"));
    assert.match(content(review), /fires at your 24h limit now; the remaining hours file/);

    const sent = await call(press("sp:moderation:go:"));
    assert.match(content(sent), /✅ .*Temp ban 72h.*24h applied \(your limit\)/);
    assert.match(content(sent), /One request filed.*1 line\(s\)/);

    // The game got the capped sentence — that much was always theirs to give…
    assert.equal(fake.tempBans.get(ALPHA)?.hours, 24);
    // …the decision row carries the capped expiry…
    const bans = await repo.playerBans.list({ playerId: ALPHA });
    assert.equal(bans.length, 1);
    const hoursLeft = (Date.parse(bans[0]!.expiresAt!) - Date.now()) / 3_600_000;
    assert.ok(hoursLeft > 23 && hoursLeft <= 24, `expiry ~24h out, got ${hoursLeft.toFixed(2)}h`);
    // …and the remainder is ONE extension line pinned to that decision, so approval grows the
    // same sentence instead of stacking a second ban.
    const open = await repo.approvals.list({ status: ["open"] });
    assert.equal(open.length, 1);
    assert.equal(open[0]!.lines.length, 1);
    const line = open[0]!.lines[0]!;
    assert.equal(line.kind, "tempban_extend");
    assert.equal(line.capability, "action.tempban");
    assert.equal(line.payload.hours, 72);
    assert.equal(line.payload.appliedHours, 24);
    assert.equal(line.payload.banDecisionId, bans[0]!.id);
  } finally {
    fake.close();
  }
});

test("observe mode blocks the fire path; a watch fires community-wide but skips a player the panel has never seen", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo, { active: false });
  try {
    const staff = await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "action.kick", scopeId: server.id },
      { capability: "player.watchlist" },
    ]);
    // Alpha has a profile (the watch has a person to attach to); Bravo does not.
    const alpha = await repo.players.upsert({ game: "hll", platform: "steam", platformId: ALPHA, name: "Alpha" });
    const call = caller(repo);

    await call(press("sp:moderation:srv:", { values: [key] }));
    await call(press("sp:moderation:pl:"));
    await call(press("sp:moderation:padd:0", { values: [ALPHA] }));
    await call(press("sp:moderation:padd:0", { values: [BRAVO] }));
    await call(press("sp:moderation:b:"));
    await call(press("sp:moderation:tog:kick"));
    await call(submit("sp:moderation:det:kick", { reason: "afk" }));
    await call(press("sp:moderation:tog:watch"));
    await call(submit("sp:moderation:det:watch", { reason: "repeat teamkiller" }));

    // Review says up front the held kick will NOT fire on a read-only server.
    const review = await call(press("sp:moderation:rev:"));
    assert.match(content(review), /⛔ .*Kick.*observe mode/);
    assert.match(content(review), /✅ .*Watch.*fires now/, "the watch touches no game — observe mode does not bind it");

    const sent = await call(press("sp:moderation:go:"));
    assert.match(content(sent), /⛔ .*Kick.*\*\*Alpha\*\*.*observe mode/);
    assert.match(content(sent), /✅ .*Watch.*\*\*Alpha\*\*/);
    assert.match(content(sent), /⚠️ .*Watch.*\*\*Bravo\*\*.*no profile/);

    // The kick never reached the game; the watch is a real reason row on Alpha's profile.
    assert.ok(!fake.received.includes("PunishPlayer") && !fake.received.some((n) => /Kick/i.test(n)), "no kick was sent");
    const reasons = (await repo.watchReasons.listActiveByPlayers([alpha.id])).get(alpha.id) ?? [];
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!.reason, /repeat teamkiller/);
    const trail = await repo.audit.list({ actions: ["player.watchlist"], limit: 5 });
    assert.equal(trail.length, 1);
    assert.equal(trail[0]!.actorUserId, staff.id);
    assert.match(trail[0]!.summary, /via Discord panel/);
    // Nothing was filed: every line either fired, was blocked, or was skipped with its warning.
    assert.equal((await repo.approvals.list({ status: ["open"] })).length, 0);
  } finally {
    fake.close();
  }
});

/*
 * A volley takes as long as its slowest game command, and the cart used to be cleared only once it
 * had all fired — so a Send pressed meanwhile on another open panel found the cart still there and
 * fired every line again, and filed a second request for the lines the presser lacks.
 */
test("one cart sent from two panels at once fires once and files once", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "action.message", scopeId: server.id },
      // no action.permaban — that half files
    ]);
    const call = caller(repo);
    await call(press("sp:moderation:srv:", { values: [key] }));
    await call(press("sp:moderation:pl:"));
    await call(press("sp:moderation:padd:0", { values: [ALPHA] }));
    await call(press("sp:moderation:b:"));
    await call(press("sp:moderation:tog:message"));
    await call(submit("sp:moderation:det:message", { message: "once, please" }));
    await call(press("sp:moderation:tog:permaban"));
    await call(submit("sp:moderation:det:permaban", { reason: "cheating" }));

    const fromPanel = (id: string) => ({ ...press("sp:moderation:go:"), message: { id, flags: 64 } });
    const answers = (await Promise.all([call(fromPanel("m1")), call(fromPanel("m2"))])).map(content);
    assert.equal(answers.filter((a) => /\*\*Sent\*\*/.test(a)).length, 1, `one panel sent it: ${answers.join(" | ")}`);
    assert.ok(answers.some((a) => /already on its way/.test(a)), "the other was told it is already going");
    assert.equal(fake.messages.filter((m) => m.playerId === ALPHA).length, 1, "the message reached the game once");
    assert.equal((await repo.approvals.list({ status: ["open"] })).length, 1, "one request filed, not two");
  } finally {
    fake.close();
  }
});

/*
 * The panel is Discord text, and the names in it are the players' own: a clan tag "*KLM*" lost
 * its asterisks to italics, and a "[x](https://…)" name or reason showed as a link.
 */
test("names and typed reasons show as written in the cart, the review and the receipt", async () => {
  const { repo } = await createIsolatedRepository();
  const { fake, server, key } = await liveServer(repo);
  fake.players = [{ iD: ALPHA, name: "*KLM* Sm_ith", platform: "steam" }];
  try {
    await staffAccount(repo, [
      { capability: "server.view", level: "read" },
      { capability: "action.kick", scopeId: server.id },
    ]);
    const call = caller(repo);
    await call(press("sp:moderation:srv:", { values: [key] }));
    await call(press("sp:moderation:pl:"));
    const added = await call(press("sp:moderation:padd:0", { values: [ALPHA] }));
    assert.match(content(added), /In the cart \(1\): \\\*KLM\\\* Sm\\_ith/);
    const cart = await call(press("sp:moderation:b:"));
    assert.match(content(cart), /Targets \(1\):\*\* \\\*KLM\\\* Sm\\_ith/);
    await call(press("sp:moderation:tog:kick"));
    const withAct = await call(submit("sp:moderation:det:kick", { reason: "said [free VIP](https://phish.example)" }));
    assert.match(content(withAct), /Kick — said \\\[free VIP\\\]\(https:\/\/phish\.example\)/, "no disguised link, the address whole");
    const review = await call(press("sp:moderation:rev:"));
    assert.match(content(review), /\*\*Targets:\*\* \\\*KLM\\\* Sm\\_ith/);
    const sent = await call(press("sp:moderation:go:"));
    assert.match(content(sent), /✅ .*Kick.*\*\*\\\*KLM\\\* Sm\\_ith\*\*/);
  } finally {
    fake.close();
  }
});
