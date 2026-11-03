/**
 * The Economy hub on the staff panel: one launcher door to balances, VIP and history, with the
 * registration and VIP-launcher modules absorbed behind it.
 *
 * What is actually under test:
 *   - the hub REPLACES three launcher entries with one, without orphaning the absorbed modules
 *     (hidden modules stay pressable, their Back row leads to the hub, the hub's doors reach them);
 *   - the member card tells the truth about balance, links and VIP, and shows a write button only
 *     to someone whose grants would let the same press succeed;
 *   - the writes are real: an adjustment is a ledger row and an audit row, a VIP grant is a grant
 *     row the sweep respects, a revoke removes it — each attributed to the staff ACCOUNT;
 *   - per-server capability means it: vip.grant scoped to one server offers exactly that server.
 *
 * Everything drives the real handleInteraction with real signatures, like every panel test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createIsolatedRepository, type Repository } from "@app/db";
import { handleInteraction } from "../dist/discord.js";
import { DiscordModuleRegistry, registerBuiltinModules } from "../dist/discord-modules.js";

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
const MEMBER = "200000000000000002";

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

test("one launcher door: Economy is listed, the absorbed modules are not — but stay pressable with the hub as Back", async () => {
  const { repo } = await createIsolatedRepository();
  // Every capability involved, so absence from the launcher is HIDING, not a missing grant.
  await staffAccount(repo, [
    { capability: "economy.balances" }, { capability: "player.links" }, { capability: "economy.config" },
  ]);
  const call = caller(repo);

  const launcher = await call(press("sp:home::"));
  assert.match(content(launcher), /Economy/);
  assert.ok(!/Manual registration/.test(content(launcher)), "registration is a sub-panel now, not a launcher entry");
  assert.ok(!/VIP launcher/.test(content(launcher)), "so is the panel poster");

  // The hub's doors reach them…
  const hub = await call(press("sp:economy::"));
  assert.ok(allIds(hub).includes("sp:register::"), "a door to registration");
  assert.ok(allIds(hub).includes("sp:viplauncher::"), "a door to the panel poster");

  // …and leaving a sub-panel lands back on the hub, not two levels up.
  const sub = await call(press("sp:register::"));
  assert.ok(allIds(sub).includes("sp:economy::"), "the sub-panel's Back row leads to the hub");
  assert.ok(!allIds(sub).includes("sp:home::"), "not to the launcher");
});

test("the member card: balance, linked accounts, VIP — and write buttons only for grant holders", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, [{ capability: "economy.balances", level: "read" }]);
  const server = await repo.servers.create({ name: "WW2 #1", host: "h", port: 1, password: "x" });
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000009", name: "Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  await repo.economy.apply({ discordId: MEMBER, delta: 350, reason: "event prize", actorName: "seed", ref: "t:1" });
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: player.name, comment: null, expiration: null, createdByUserId: null, createdByName: "seed" });
  const call = caller(repo);

  const card = await call(press("sp:economy:member:", { values: [MEMBER] }));
  assert.match(content(card), /<@200000000000000002>/);
  assert.match(content(card), /350/);
  assert.match(content(card), /Lynx \(hll\)/);
  assert.match(content(card), /WW2 #1.*permanent/s, "the VIP line names the server and the term");
  // A reader sees the card; the writes are not offered to somebody whose press would only 403.
  const ids = allIds(card).join(" ");
  assert.ok(!ids.includes("adjm:"), "no adjust button without economy.balances write");
  assert.ok(!ids.includes("vips:"), "no grant button without vip.grant anywhere");
});

test("the member card leaves out a retired server's VIP until it is back; VIP history still names that server", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, [{ capability: "economy.balances", level: "read" }, { capability: "vip.revoke" }]);
  await repo.servers.create({ name: "WW2 #1", host: "h", port: 1, password: "x" });
  const gone = await repo.servers.create({ name: "Old Vietnam", host: "h", port: 2, password: "x" });
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000012", name: "Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  await repo.vips.upsert({ serverId: gone.id, playerId: player.platformId, playerName: player.name, comment: null, expiration: null, createdByUserId: null, createdByName: "seed" });
  await repo.audit.create({ actorName: "seed", action: "vip.grant", targetType: "player", targetId: player.platformId, targetName: player.name, serverId: gone.id, summary: "granted VIP" });
  const call = caller(repo);
  const card = () => call(press("sp:economy:member:", { values: [MEMBER] }));

  const before = await card();
  assert.match(content(before), /Old Vietnam.*permanent/s, "while the server is in use, its VIP is on the card");
  assert.ok(allIds(before).some((id) => id.includes("vipr:")), "with the revoke button");

  await repo.servers.setRetired(gone.id, true);
  const retired = await card();
  assert.match(content(retired), /\*\*VIP:\*\* none active/, "a retired server's VIP is not VIP the member has now");
  assert.ok(!content(retired).includes("Old Vietnam") && !content(retired).includes(gone.id), "not by name, and not by its raw id");
  assert.ok(!allIds(retired).some((id) => id.includes("vipr:")), "and nothing on the card to revoke");
  assert.ok(await repo.vips.get(gone.id, player.platformId), "the grant itself is kept");
  const history = await call(press(`sp:economy:viph:${MEMBER}`));
  assert.match(content(history), /granted on \*\*Old Vietnam\*\*/, "history names the retired server, not \"?\"");

  await repo.servers.setRetired(gone.id, false);
  assert.match(content(await card()), /Old Vietnam.*permanent/s, "back on the card once the server is back");
});

test("adjusting points is a ledger row, an audit row, and a card that shows the new balance", async () => {
  const { repo } = await createIsolatedRepository();
  const staff = await staffAccount(repo, [{ capability: "economy.balances", level: "write" }]);
  await repo.economy.apply({ discordId: MEMBER, delta: 100, reason: "seed", actorName: "seed", ref: "t:1" });
  const call = caller(repo);

  const modal = await call(press(`sp:economy:adjm:${MEMBER}`));
  assert.equal(modal.type, 9, "the adjustment asks for amount + reason in a form");

  const after = await call(submit(`sp:economy:adj:${MEMBER}`, { delta: "250", reason: "tournament prize" }));
  assert.match(content(after), /\+250/);
  assert.match(content(after), /350/, "the card re-renders with the new balance");

  const ledger = await repo.economy.ledger(MEMBER);
  assert.equal(ledger[0]!.delta, 250);
  assert.match(ledger[0]!.reason, /tournament prize/);
  const audit = await repo.audit.list({ action: "economy.adjust" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actorUserId, staff.id, "attributed to the staff ACCOUNT, not the Discord id");
  assert.match(audit[0]!.summary, /via Discord panel/);

  // A reason is not optional — it is the row other staff read.
  const refused = await call(submit(`sp:economy:adj:${MEMBER}`, { delta: "50", reason: "  " }));
  assert.match(content(refused), /reason is required/i);
  assert.equal(await repo.economy.ledgerCount(MEMBER), 2, "nothing was written");
});

test("the ledger pages, newest first, and says what moved and why", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, [{ capability: "economy.balances", level: "read" }]);
  for (let i = 1; i <= 12; i++) {
    await repo.economy.apply({ discordId: MEMBER, delta: i, reason: `drop ${i}`, actorName: "seed", ref: `t:${i}` });
  }
  const call = caller(repo);
  const page0 = await call(press(`sp:economy:hist:${MEMBER}:0`));
  assert.match(content(page0), /page 1\/2/);
  assert.match(content(page0), /drop 12/, "newest first");
  assert.ok(!/drop 1\b/.test(content(page0)), "the oldest waits on page 2");
  assert.ok(allIds(page0).includes(`sp:economy:hist:${MEMBER}:1`), "an Older button");

  const page1 = await call(press(`sp:economy:hist:${MEMBER}:1`));
  assert.match(content(page1), /drop 1\b/);
});

/*
 * Under a VIP purchase, staff read on each server when its days start and when that VIP now ends —
 * a gift's too, since staff answer for every VIP. The dates come from each server's grant in the
 * trail, found by the purchase's ref; a ledger row that is not a purchase reads none, even when a
 * grant shares its ref (the welcome bonus pays its points and its days under one).
 */
test("the ledger gives each VIP purchase's dates on every server it landed on, a gift's and a group-held one's included", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, [{ capability: "economy.balances", level: "read" }]);
  const ww2 = await repo.servers.create({ name: "WW2 *main*", host: "10.0.0.1", port: 1, password: "x" });
  const viet = await repo.servers.create({ name: "Vietnam", host: "10.0.0.2", port: 2, password: "x" });
  await repo.economy.apply({ discordId: MEMBER, delta: 1000, reason: "seed", ref: "t:seed" });
  await repo.economy.apply({ discordId: MEMBER, delta: 50, reason: "welcome: linked account", ref: `bonus:${MEMBER}` });
  await repo.economy.apply({ discordId: MEMBER, delta: -250, reason: "VIP shop: Both — gift for Pal", ref: "buy:ixBOTH" });
  await repo.economy.apply({ discordId: MEMBER, delta: -100, reason: "VIP shop: Week", ref: "staff-buy:abc" });
  const grant = (serverId: string, ref: string, data: Record<string, unknown>) => repo.audit.create({
    actorUserId: null, actorName: "shop", action: "vip.grant", targetType: "player", targetId: "p-pal", serverId, summary: "granted",
    data: { playerId: "p-pal", days: 14, ref, via: "VIP shop", ...data },
  });
  await grant(ww2!.id, `bonus:${MEMBER}`, { expiration: "2026-11-07T12:00:00.000Z", days: 7, via: "registration bonus" });
  await grant(ww2!.id, "buy:ixBOTH", { expiration: "2026-11-14T12:00:00.000Z" });
  await grant(viet!.id, "buy:ixBOTH", { expiration: "2026-12-01T12:00:00.000Z" });
  await grant(ww2!.id, "staff-buy:abc", { groupHeld: true, bankedMs: 604_800_000, days: 7 });
  const call = caller(repo);
  const lines = content(await call(press(`sp:economy:hist:${MEMBER}:0`))).split("\n");
  const t = (iso: string) => `<t:${Date.parse(iso) / 1000}:f>`;
  const both = lines.findIndex((l) => l.startsWith("−250 — VIP shop: Both — gift for Pal"));
  assert.ok(both >= 0, lines.join(" | "));
  assert.deepEqual(lines.slice(both + 1, both + 3), [
    `-# WW2 \\*main\\*: VIP from ${t("2026-10-31T12:00:00.000Z")} until ${t("2026-11-14T12:00:00.000Z")}`,
    `-# Vietnam: VIP from ${t("2026-11-17T12:00:00.000Z")} until ${t("2026-12-01T12:00:00.000Z")}`,
  ], "each server the gift landed on, in the order granted: its days' start and the VIP's end there");
  const week = lines.findIndex((l) => l.startsWith("−100 — VIP shop: Week"));
  assert.equal(lines[week + 1], "-# WW2 \\*main\\*: days saved for when the group's permanent VIP ends", "a group holds their VIP: the days wait");
  const welcome = lines.findIndex((l) => l.startsWith("+50 — welcome: linked account"));
  assert.ok(welcome >= 0 && !lines[welcome + 1]!.startsWith("-# "), "the welcome bonus is not a purchase");
  assert.equal(lines.filter((l) => l.startsWith("-# ")).length, 3);
});

test("VIP grant: per-server capability decides the offer, the press writes the grant and the trail", async () => {
  const { repo } = await createIsolatedRepository();
  const a = await repo.servers.create({ name: "Alpha", host: "h", port: 1, password: "x" });
  await repo.servers.create({ name: "Bravo", host: "h", port: 2, password: "x" });
  // vip.grant on Alpha ONLY — the pick list must offer exactly that.
  const staff = await staffAccount(repo, [
    { capability: "economy.balances", level: "read" },
    { capability: "vip.grant", scopeId: a.id },
  ]);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000010", name: "Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  await repo.vipPresets.create({ kind: "add", label: "3 days", days: 3, hours: 0 });
  const call = caller(repo);

  const pick = await call(press(`sp:economy:vips:${MEMBER}`));
  assert.match(content(pick), /permissions reach \(1\)/, "the scope is the presser's grants, not the server list");

  const key = a.id.replaceAll("-", "").slice(0, 8);
  const dur = await call(press(`sp:economy:vipd:${MEMBER}`, { values: [key] }));
  assert.match(content(dur), /STACKS/);
  assert.ok(allIds(dur).includes(`sp:economy:vipn:${MEMBER}:${key}:h72`), "the community's own preset, as hours");

  // Every VIP added carries a comment: the duration opens a form asking for it.
  const form = await call(press(`sp:economy:vipn:${MEMBER}:${key}:h72`));
  assert.equal(form.type, 9, "the duration asks for a comment in a form");
  const formData = form.data as { custom_id?: string; components?: { components: { custom_id: string; required?: boolean }[] }[] };
  assert.equal(formData.custom_id, `sp:economy:vipa:${MEMBER}:${key}:h72`, "the form carries the duration to the grant");
  const field = formData.components?.[0]?.components[0];
  assert.equal(field?.custom_id, "comment");
  assert.equal(field?.required, true);
  // A blank comment, or a duration button drawn before the form existed (no form, no comment),
  // grants nothing.
  const blank = await call(submit(`sp:economy:vipa:${MEMBER}:${key}:h72`, { comment: "   " }));
  assert.match(content(blank), /comment is required for every VIP added/);
  const stale = await call(press(`sp:economy:vipa:${MEMBER}:${key}:h72`));
  assert.match(content(stale), /comment is required for every VIP added/);
  assert.equal(await repo.vips.get(a.id, player.platformId), null, "nothing was granted");

  const done = await call(submit(`sp:economy:vipa:${MEMBER}:${key}:h72`, { comment: "won the knife fight" }));
  assert.match(content(done), /✅ \*\*Alpha\*\*/);
  assert.match(content(done), /observe mode: recorded/, "an observe server takes the row, not the command");
  const row = await repo.vips.get(a.id, player.platformId);
  assert.ok(row, "the grant row exists");
  const hoursLeft = (Date.parse(row!.expiration!) - Date.now()) / 3_600_000;
  assert.ok(hoursLeft > 71 && hoursLeft <= 72, `72h from now, got ${hoursLeft}`);
  assert.equal(row!.comment, "won the knife fight", "the grant's note is the comment typed for it");
  const audit = await repo.audit.list({ action: "vip.grant" });
  assert.equal(audit[0]!.actorUserId, staff.id);
  assert.match(audit[0]!.summary, /via Discord panel/);
  assert.equal((audit[0]!.data as { comment?: string }).comment, "won the knife fight", "and it is in their VIP history");
});

test("VIP grant, custom days: the form asks for the days and the comment together", async () => {
  const { repo } = await createIsolatedRepository();
  const a = await repo.servers.create({ name: "Alpha", host: "h", port: 1, password: "x" });
  await staffAccount(repo, [
    { capability: "economy.balances", level: "read" },
    { capability: "vip.grant", scopeId: a.id },
  ]);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000011", name: "Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  const call = caller(repo);
  const key = a.id.replaceAll("-", "").slice(0, 8);

  const form = await call(press(`sp:economy:vipm:${MEMBER}:${key}`));
  assert.equal(form.type, 9);
  const ids = ((form.data as { components?: { components: { custom_id: string }[] }[] }).components ?? []).map((r) => r.components[0]!.custom_id);
  assert.deepEqual(ids, ["days", "comment"]);
  const blank = await call(submit(`sp:economy:vipc:${MEMBER}:${key}`, { days: "30", comment: "" }));
  assert.match(content(blank), /comment is required for every VIP added/);
  assert.equal(await repo.vips.get(a.id, player.platformId), null, "nothing was granted");

  const done = await call(submit(`sp:economy:vipc:${MEMBER}:${key}`, { days: "30", comment: "paid $10" }));
  assert.match(content(done), /✅ \*\*Alpha\*\*/);
  const row = await repo.vips.get(a.id, player.platformId);
  assert.equal(row!.comment, "paid $10");
  const daysLeft = (Date.parse(row!.expiration!) - Date.now()) / 86_400_000;
  assert.ok(daysLeft > 29.9 && daysLeft <= 30, `30 days from now, got ${daysLeft}`);
});

test("VIP grant on a permanent leaves the record alone — no restamped comment, no false grant trail", async () => {
  const { repo } = await createIsolatedRepository();
  const a = await repo.servers.create({ name: "Alpha", host: "h", port: 1, password: "x" });
  await staffAccount(repo, [
    { capability: "economy.balances", level: "read" },
    { capability: "vip.grant", scopeId: a.id },
  ]);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000012", name: "Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  // A permanent someone PAID for, with the sale's own paper trail on it.
  await repo.vips.upsert({ serverId: a.id, playerId: player.platformId, playerName: player.name, comment: "paid", expiration: null, createdByUserId: null, createdByName: "seed" });
  const call = caller(repo);

  const key = a.id.replaceAll("-", "").slice(0, 8);
  const done = await call(submit(`sp:economy:vipa:${MEMBER}:${key}:h72`, { comment: "seeded the server" }));
  assert.match(content(done), /— \*\*Alpha\*\* — already permanent; left untouched/);
  const row = await repo.vips.get(a.id, player.platformId);
  assert.equal(row!.expiration, null, "still permanent");
  assert.equal(row!.comment, "paid", "the sale's comment was not overwritten by the press's");
  assert.equal(row!.createdByName, "seed", "the original granter still owns the record");
  assert.equal((await repo.audit.list({ action: "vip.grant" })).length, 0, "no grant row for a grant that changed nothing");
});

test("VIP revoke removes the grant and records who took it", async () => {
  const { repo } = await createIsolatedRepository();
  const a = await repo.servers.create({ name: "Alpha", host: "h", port: 1, password: "x" });
  await staffAccount(repo, [
    { capability: "economy.balances", level: "read" },
    { capability: "vip.revoke", scopeId: a.id },
  ]);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000011", name: "Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  await repo.vips.upsert({ serverId: a.id, playerId: player.platformId, playerName: player.name, comment: null, expiration: null, createdByUserId: null, createdByName: "seed" });
  const call = caller(repo);

  const key = a.id.replaceAll("-", "").slice(0, 8);
  const done = await call(press(`sp:economy:viprc:${MEMBER}`, { values: [key] }));
  assert.match(content(done), /✅ \*\*Alpha\*\* — revoked/);
  // An observe server takes the revoke on the record only, as it takes a grant, and says so: a bare
  // "revoked" read as the VIP gone from the game, where it stays.
  assert.match(content(done), /observe mode: taken off the record, not off the game/);
  assert.equal(await repo.vips.get(a.id, player.platformId), null);
  const audit = await repo.audit.list({ action: "vip.revoke" });
  assert.equal(audit.length, 1);
  assert.match(audit[0]!.summary, /via Discord panel/);
});

test("VIP revoke on a grant a group perk holds takes the VIP of their own beneath it, and the group's stays", async () => {
  const { repo } = await createIsolatedRepository();
  const a = await repo.servers.create({ name: "Alpha", host: "h", port: 1, password: "x" });
  await staffAccount(repo, [
    { capability: "economy.balances", level: "read" },
    { capability: "vip.revoke", scopeId: a.id },
  ]);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000012", name: "Clan" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  await repo.vips.upsert({ serverId: a.id, playerId: player.platformId, playerName: player.name, expiration: new Date(Date.now() + 5 * 86_400_000).toISOString(), createdByName: "seed" });
  await repo.vips.startGroupHold({ serverId: a.id, playerId: player.platformId, playerName: player.name, groups: [{ id: "g1", name: "WW2 CVC", severanceMinutes: 0 }], createdByName: "group perks" });
  const call = caller(repo);
  const key = a.id.replaceAll("-", "").slice(0, 8);
  // The card names what stands before anyone presses Revoke, as the web profile does: the group's
  // permanent, and the VIP of their own frozen beneath it.
  const before = await call(press("sp:economy:member:", { values: [MEMBER] }));
  assert.match(content(before), /\*\*Alpha\*\* — \*\*permanent\*\* — group “WW2 CVC”, 5 days frozen for when they leave/);

  const done = await call(press(`sp:economy:viprc:${MEMBER}`, { values: [key] }));
  assert.match(content(done), /✅ \*\*Alpha\*\* — their own VIP removed \(\d+h\); the group's VIP stays/);
  const after = await call(press("sp:economy:member:", { values: [MEMBER] }));
  assert.match(content(after), /\*\*Alpha\*\* — \*\*permanent\*\* — group “WW2 CVC”(?!,)/, "the group's VIP, nothing frozen beneath it any more");
  assert.doesNotMatch(content(after), /frozen for when they leave/);
  const row = (await repo.vips.get(a.id, player.platformId))!;
  assert.equal(row.expiration, null, "still permanent — the group's");
  assert.equal(row.groupHold!.bankedMs, 0, "the frozen time is gone");
  const audit = await repo.audit.list({ action: "vip.revoke" });
  assert.equal(audit.length, 1);
  assert.equal((audit[0]!.data as { groupHeld?: boolean }).groupHeld, true);
  // The card's VIP history does not call it a revoke of their VIP — they still have the group's.
  const history = await call(press(`sp:economy:viph:${MEMBER}`));
  assert.match(content(history), /own VIP revoked \(group VIP kept\) on \*\*Alpha\*\*/);
  assert.doesNotMatch(content(history), /🔴 revoked/);

  // Nothing of their own left beneath it: nothing to revoke, and the card says how it ends.
  const again = await call(press(`sp:economy:viprc:${MEMBER}`, { values: [key] }));
  assert.match(content(again), /nothing of their own beneath it; remove them from the group to end it/);
  assert.ok((await repo.vips.get(a.id, player.platformId))!.groupHold, "still held");
});

test("forged pages clamp to zero instead of reaching SQL as a negative OFFSET", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, [{ capability: "economy.balances" }]);
  const call = caller(repo);

  // act:-3 and hist:…:-2 are buttons we never draw. The old parse handed the ledger a negative
  // OFFSET, which Postgres refuses — a failure banner from a forged press. Both mean page 0 now.
  const act = await call(press("sp:economy:act:-3"));
  assert.ok(!/failed:/.test(content(act)), "no failure banner on activity");
  assert.match(content(act), /newest first · page 1\/1/);
  const hist = await call(press(`sp:economy:hist:${MEMBER}:-2`));
  assert.ok(!/failed:/.test(content(hist)), "no failure banner on history");
});

/*
 * The panel is Discord text, and the names in it are typed by their owners: "*star*" turned
 * italic, and a clan tag "*KLM*" lost its asterisks.
 */
test("the hub's top list and the member card show names as written", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, [{ capability: "economy.balances", level: "read" }]);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000010", name: "*KLM* Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  await repo.economy.apply({ discordId: MEMBER, discordName: "*star*_one", delta: 350, reason: "event prize", actorName: "seed", ref: "t:names" });
  const call = caller(repo);

  const hub = await call(press("sp:economy::"));
  assert.match(content(hub), /1\. \*\*\\\*star\\\*\\_one\*\*/, "the top list");
  const card = await call(press("sp:economy:member:", { values: [MEMBER] }));
  assert.match(content(card), /\(\*\*\\\*star\\\*\\_one\*\*\)/, "the member's Discord name");
  assert.match(content(card), /\\\*KLM\\\* Lynx \(hll\)/, "their game account");
});

test("the ledger, the activity feed and VIP history show reasons and names as written", async () => {
  const { repo } = await createIsolatedRepository();
  await staffAccount(repo, [{ capability: "economy.balances", level: "read" }]);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000010", name: "Lynx" });
  await repo.externalLinks.set(player.id, "discord", MEMBER);
  await repo.economy.apply({ discordId: MEMBER, discordName: "*star*_one", delta: 5, reason: "prize for *top*_fragger", actorName: "mod_one", ref: "t:typed" });
  await repo.audit.create({ actorUserId: null, actorName: "vip_admin", action: "vip.grant", targetType: "player", targetId: player.platformId, targetName: "Lynx", serverId: null, summary: "granted VIP" });
  const call = caller(repo);

  const hist = await call(press(`sp:economy:hist:${MEMBER}:0`));
  assert.match(content(hist), /prize for \\\*top\\\*\\_fragger · by mod\\_one/, "the ledger");
  const act = await call(press("sp:economy:act:0"));
  assert.match(content(act), /\*\*\\\*star\\\*\\_one\*\* — prize for \\\*top\\\*\\_fragger/, "the activity feed");
  const vip = await call(press(`sp:economy:viph:${MEMBER}`));
  assert.match(content(vip), /by vip\\_admin/, "VIP history");
});
