/**
 * The public VIP panel (docs/vip-module.md §4): status, claims, buying, and both gift flows —
 * driven through the real interaction host against the fake game server. The rules under test
 * are the decisions: buttons render from configuration, linking gates everything, the
 * interaction id is the idempotency key, and money never moves twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createIsolatedRepository } from "@app/db";
import { handleInteraction } from "../dist/discord.js";
import { PublicModuleRegistry, registerPublicModules } from "../dist/discord-public.js";
import { FakeHllServer } from "./fake-hll-server.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey as KeyObject).export({ format: "der", type: "spki" }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString("hex");
  const sign = (ts: string, body: string) => edSign(null, Buffer.from(ts + body), privateKey).toString("hex");
  return { publicKeyHex, sign };
}

let interactionSeq = 0;

async function scene() {
  const { repo } = await createIsolatedRepository();
  const fake = new FakeHllServer("pw");
  const port = await fake.listen();
  const server = await repo.servers.create({ name: "Shop #1", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
  await repo.economy.setConfig({
    currencyName: "Gold Coins", balanceCap: null,
    claims: { daily: { enabled: true, min: 10, max: 20 }, monthly: { enabled: false, min: 475, max: 525 } },
    gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true },
    offers: [
      { id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [] },
      { id: "hidden", label: "Retired", points: 1, days: 1, scope: { mode: "all" }, enabled: false, roleIds: [] },
    ],
  });
  // Two linked members: the buyer and a friend.
  const buyerPlayer = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000301", name: "Buyer" });
  await repo.externalLinks.set(buyerPlayer.id, "discord", "111000111", "registration");
  const friendPlayer = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000302", name: "Friend" });
  await repo.externalLinks.set(friendPlayer.id, "discord", "222000222", "registration");
  await repo.economy.apply({ discordId: "111000111", delta: 600, reason: "seed" });

  const registry = new PublicModuleRegistry();
  registerPublicModules(registry, repo);
  const patches: { body: { content?: string; components?: unknown[] } }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    patches.push({ body: JSON.parse(String(init?.body ?? "{}")) as { content?: string } });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const { publicKeyHex, sign } = keypair();
  const call = async (interaction: Record<string, unknown>) => {
    const body = JSON.stringify(interaction);
    const ts = String(Math.floor(Date.now() / 1000));
    return handleInteraction(repo, publicKeyHex, { signature: sign(ts, body), timestamp: ts }, body, { publicRegistry: registry, appId: "app7", fetchImpl });
  };
  const deferred = async (r: Awaited<ReturnType<typeof call>>) => {
    assert.ok(r.followUp, "expected a deferred interaction");
    await r.followUp;
    return patches.at(-1)!.body;
  };
  return { repo, fake, server, call, deferred, buyerPlayer, friendPlayer };
}

/**
 * What Discord answers when the app asks which roles somebody holds.
 *
 * A press carries the PRESSER's roles, so a self-purchase needs no lookup; a gift is about
 * somebody else, and their roles can only be had by asking. These two helpers stand in for that
 * ask — everything not aimed at discord.com still goes through the real fetch.
 */
const realFetch = globalThis.fetch;
const savedEnv = { token: process.env.DISCORD_TOKEN };
function stubGuildRoles(byUserId: Record<string, string[]>) {
  process.env.DISCORD_TOKEN = "bot-token";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("discord.com")) return realFetch(url, init);
    const id = u.split("/members/")[1];
    const roles = id ? byUserId[id] : undefined;
    return roles
      ? new Response(JSON.stringify({ roles, user: { username: `d${id}` } }), { status: 200 })
      : new Response("no such member", { status: 404 });
  }) as typeof fetch;
}
function restoreGuildRoles() {
  globalThis.fetch = realFetch;
  if (savedEnv.token === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = savedEnv.token;
}

const press = (customId: string, discordUserId: string, opts: { id?: string; selected?: string[]; roles?: string[] } = {}): Record<string, unknown> => ({
  type: 3, id: opts.id ?? `ix${++interactionSeq}`, token: "tok7",
  data: { custom_id: customId, ...(opts.selected ? { values: opts.selected } : {}) },
  // `roles` is what Discord sends with a guild press — the source the claim gate reads.
  member: { user: { id: discordUserId, username: `d${discordUserId}` }, roles: opts.roles ?? [] }, message: { flags: 64 },
});
const submit = (customId: string, values: Record<string, string>, discordUserId: string): Record<string, unknown> => ({
  type: 5, id: `ix${++interactionSeq}`, token: "tok7",
  data: { custom_id: customId, components: Object.entries(values).map(([id, value]) => ({ components: [{ custom_id: id, value }] })) },
  member: { user: { id: discordUserId, username: `d${discordUserId}` } }, message: { flags: 64 },
});

test("the root renders from configuration: balance, VIP status, and one button per enabled thing", async () => {
  const s = await scene();
  try {
    await s.repo.vips.upsert({ serverId: s.server.id, playerId: "76561198000000301", playerName: "Buyer", expiration: new Date(Date.now() + 7 * 86_400_000).toISOString(), createdByName: "test" });
    const r = await s.call(press("pp:vip::", "111000111"));
    const data = (r.body as { data: { content: string; components: { components: { custom_id: string; label?: string }[] }[] } }).data;
    assert.match(data.content, /Linked: \*\*Buyer\*\*/);
    assert.match(data.content, /Balance: \*\*600 Gold Coins\*\*/);
    assert.match(data.content, /Shop #1.*until/);
    const ids = data.components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(ids.includes("pp:vip:claim:daily"), "daily claim on (monthly off)");
    assert.ok(!ids.includes("pp:vip:claim:monthly"));
    assert.ok(ids.includes("pp:vip:buyask:two_weeks"), "one button per ENABLED offer");
    assert.ok(!ids.some((i) => i.includes("hidden")), "disabled offers get no button");
    assert.ok(ids.includes("pp:vip:giftpick:"), "gifting is on, so the button exists");
    assert.ok(ids.includes("pp:vip:giftvippick:"), "VIP gifting is on, so that button exists too");

    // Somebody else's grant on the same server is not theirs. The status lines are gathered per
    // LINKED ACCOUNT now (one read each instead of one per server × account), so the panel has to
    // keep answering with the presser's own VIP and only that.
    await s.repo.vips.upsert({ serverId: s.server.id, playerId: "76561198000000302", playerName: "Friend", expiration: new Date(Date.now() + 30 * 86_400_000).toISOString(), createdByName: "test" });
    const mine = (await s.call(press("pp:vip::", "111000111"))).body as { data: { content: string } };
    assert.equal((mine.data.content.match(/• \*\*Shop #1\*\*/g) ?? []).length, 1, "one line — their own grant, not the friend's");
  } finally {
    s.fake.close();
  }
});

test("each gift kind answers to its own switch — off means no button and no back door", async () => {
  const s = await scene();
  try {
    const both = (cfg: { gifting: boolean; vipGifting: boolean }) => s.repo.economy.setConfig({
      currencyName: "Gold Coins", balanceCap: null,
      claims: { daily: { enabled: true, min: 10, max: 20 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: cfg.gifting, minAmount: 5, maxAmount: 100 },
      vipGifting: { enabled: cfg.vipGifting },
      offers: [{ id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [] }],
    });
    const idsNow = async () => {
      const r = await s.call(press("pp:vip::", "111000111"));
      const data = (r.body as { data: { components: { components: { custom_id: string }[] }[] } }).data;
      return data.components.flatMap((row) => row.components.map((c) => c.custom_id));
    };

    // VIP gifting off, points gifting on: the offers still sell, only the gift route closes.
    await both({ gifting: true, vipGifting: false });
    let ids = await idsNow();
    assert.ok(ids.includes("pp:vip:buyask:two_weeks"), "buying for yourself is untouched");
    assert.ok(ids.includes("pp:vip:giftpick:"));
    assert.ok(!ids.includes("pp:vip:giftvippick:"), "no Gift VIP button");
    // …and a stale button from before the switch flipped is refused, not honoured.
    const stale = await s.call(press("pp:vip:giftvipsel:", "111000111", { selected: ["222000222"] }));
    assert.match((stale.body as { data: { content: string } }).data.content, /switched off/i);

    // The mirror image: VIP gifting on, points gifting off.
    await both({ gifting: false, vipGifting: true });
    ids = await idsNow();
    assert.ok(!ids.includes("pp:vip:giftpick:"), "no points-gift button");
    assert.ok(ids.includes("pp:vip:giftvippick:"));
    const stalePoints = await s.call(press("pp:vip:giftpick:", "111000111"));
    assert.match((stalePoints.body as { data: { content: string } }).data.content, /switched off/i);

    // The ceiling refuses an oversized points gift once gifting is back on.
    await both({ gifting: true, vipGifting: true });
    const over = await s.call(submit("pp:vip:gift:222000222", { amount: "400" }, "111000111"));
    assert.match((over.body as { data: { content: string } }).data.content, /at most 100 Gold Coins/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600, "nothing left the giver");
    const ok = await s.call(submit("pp:vip:gift:222000222", { amount: "100" }, "111000111"));
    assert.match((ok.body as { data: { content: string } }).data.content, /Sent \*\*100 Gold Coins\*\*/);
  } finally {
    s.fake.close();
  }
});

test("claims: the band pays, the period refuses a second, and no link is needed", async () => {
  const s = await scene();
  try {
    const r = await s.call(press("pp:vip:claim:daily", "111000111"));
    const first = (r.body as { data: { content: string } }).data.content;
    assert.match(first, /\+\d+ Gold Coins/);
    const paid = Number(/\+(\d+)/.exec(first)![1]);
    assert.ok(paid >= 10 && paid <= 20, `paid ${paid}, inside the band`);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600 + paid);

    const again = await s.call(press("pp:vip:claim:daily", "111000111"));
    assert.match((again.body as { data: { content: string } }).data.content, /Already claimed.*come back/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600 + paid, "paid once");

    // An UNLINKED member claims too. The balance is keyed on the Discord id and always was — the
    // link is what a purchase needs, because that is when VIP days have to reach a game account.
    const unlinked = await s.call(press("pp:vip:claim:daily", "999888777"));
    assert.match((unlinked.body as { data: { content: string } }).data.content, /\+\d+ Gold Coins/);
    assert.ok(((await s.repo.economy.member("999888777"))?.balance ?? 0) >= 10, "an unlinked member was paid");
  } finally {
    s.fake.close();
  }
});

/**
 * Points take weeks to accumulate and a purchase cannot be undone — the VIP days land on a game
 * server immediately and the economy has no return path. A panel of primary-styled buttons where
 * one press is final produces mistakes, and every one of them reaches staff as a refund request
 * they have no button for either. So the offer button asks, and only the confirmation buys.
 */
test("an offer button asks before it spends, and says purchases are non-refundable", async () => {
  const s = await scene();
  try {
    const ask = await s.call(press("pp:vip:buyask:two_weeks", "111000111"));
    const body = (ask.body as { data: { content: string; components: { components: { custom_id: string; label: string }[] }[] } }).data;

    assert.match(body.content, /Gold Coins purchases are non-refundable/i, "the warning names the currency");
    assert.match(body.content, /verify you wish to purchase \*\*Two Weeks\*\*/i, "and the offer being bought");
    assert.match(body.content, /250 Gold Coins/, "and what it costs");

    // The important half: asking is not buying.
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600, "nothing was spent");
    assert.equal(await s.repo.vips.get(s.server.id, "76561198000000301"), null, "and no VIP was granted");
    assert.ok(!s.fake.received.includes("AddVip"), "the game server was never touched");

    const buttons = body.components.flatMap((r) => r.components);
    const confirm = buttons.find((c) => c.custom_id.startsWith("pp:vip:buy:two_weeks:"));
    assert.ok(confirm, "the confirmation carries the purchase the offer button used to make directly");
    assert.ok(buttons.some((c) => /cancel/i.test(c.label)), "and a way to say no");

    // Confirming is what pays.
    const done = await s.deferred(await s.call(press(confirm!.custom_id, "111000111")));
    assert.match(done.content!, /✅ \*\*Two Weeks\*\*/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "now it is spent");
  } finally {
    s.fake.close();
  }
});

test("a double-click on Confirm buys once: the confirmation screen, not each press, is the purchase", async () => {
  // The panel only shows "thinking" while the grant reaches the game, and Confirm stays pressable
  // the whole time. Two presses are two interactions with two ids — and used to be two purchases.
  const s = await scene();
  try {
    const ask = await s.call(press("pp:vip:buyask:two_weeks", "111000111", { id: "ixASK1" }));
    const confirm = (ask.body as { data: { components: { components: { custom_id: string }[] }[] } }).data.components
      .flatMap((r) => r.components).find((c) => c.custom_id.startsWith("pp:vip:buy:"))!;
    assert.equal(confirm.custom_id, "pp:vip:buy:two_weeks:ixASK1", "the screen's own id rides on its Confirm");
    const first = await s.deferred(await s.call(press(confirm.custom_id, "111000111")));
    const second = await s.deferred(await s.call(press(confirm.custom_id, "111000111")));
    assert.match(first.content!, /✅ \*\*Two Weeks\*\*/);
    assert.match(second.content!, /already went through/, "the second press is the same purchase");
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "one debit");
    assert.equal(s.fake.received.filter((c) => c === "AddVip").length, 1, "one grant");

    // Asking again is a new screen, so buying the same offer twice on purpose still works.
    const again = await s.call(press("pp:vip:buyask:two_weeks", "111000111", { id: "ixASK2" }));
    const confirm2 = (again.body as { data: { components: { components: { custom_id: string }[] }[] } }).data.components
      .flatMap((r) => r.components).find((c) => c.custom_id.startsWith("pp:vip:buy:"))!;
    assert.match((await s.deferred(await s.call(press(confirm2.custom_id, "111000111")))).content!, /✅/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 100);

    // A VIP gift's Confirm is the same: one screen, one purchase.
    await s.repo.economy.apply({ discordId: "111000111", delta: 500, reason: "top up" });
    const gift = await s.call(press("pp:vip:buyforask:two_weeks:222000222", "111000111", { id: "ixASK3" }));
    const giftConfirm = (gift.body as { data: { components: { components: { custom_id: string }[] }[] } }).data.components
      .flatMap((r) => r.components).find((c) => c.custom_id.startsWith("pp:vip:buyfor:"))!;
    assert.equal(giftConfirm.custom_id, "pp:vip:buyfor:two_weeks:222000222:ixASK3");
    assert.match((await s.deferred(await s.call(press(giftConfirm.custom_id, "111000111")))).content!, /✅ \*\*Two Weeks\*\* for <@222000222>/);
    assert.match((await s.deferred(await s.call(press(giftConfirm.custom_id, "111000111")))).content!, /already went through/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "the gift was paid for once");
  } finally {
    s.fake.close();
  }
});

test("cancelling a purchase spends nothing and lands back on the panel", async () => {
  const s = await scene();
  try {
    await s.call(press("pp:vip:buyask:two_weeks", "111000111"));
    const back = await s.call(press("pp:vip:cancel:", "111000111"));
    assert.match((back.body as { data: { content: string } }).data.content, /VIP panel/, "the panel is what comes back");
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600, "and the balance is untouched");
  } finally {
    s.fake.close();
  }
});

/**
 * An offer the panel is still showing may since have been withdrawn — the screen is ephemeral but
 * it sits open indefinitely. Confirming is where that is caught, so a member is not walked through
 * a confirmation for something that would be refused a moment later.
 */
test("the confirmation re-checks the offer rather than trusting the button", async () => {
  const s = await scene();
  try {
    const cfg = await s.repo.economy.config();
    await s.repo.economy.setConfig({ offers: cfg.offers.map((o) => ({ ...o, enabled: false })) });
    const ask = await s.call(press("pp:vip:buyask:two_weeks", "111000111"));
    assert.match((ask.body as { data: { content: string } }).data.content, /no longer available/i);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600);
  } finally {
    s.fake.close();
  }
});

/**
 * Too few points is the refusal members meet most, and it is said before the confirmation: asking
 * somebody to confirm a purchase that will be refused a moment later is worse than the refusal
 * (the re-check above). When a Confirm drawn earlier is pressed anyway, or a gift is bigger than
 * the balance, the answer is in words: the store's own "insufficient balance: has 100, needs 250"
 * is not a sentence for a member.
 */
test("not enough points: said before the confirmation, and in words after it", async () => {
  const s = await scene();
  try {
    await s.repo.economy.apply({ discordId: "111000111", delta: -500, reason: "spent elsewhere" });
    const ask = await s.call(press("pp:vip:buyask:two_weeks", "111000111"));
    const body = (ask.body as { data: { content: string; components?: { components: { custom_id: string }[] }[] } }).data;
    assert.match(body.content, /\*\*Two Weeks\*\* costs \*\*250 Gold Coins\*\*, and you have \*\*100\*\*/);
    const buttons = (body.components ?? []).flatMap((r) => r.components);
    assert.ok(!buttons.some((c) => c.custom_id.startsWith("pp:vip:buy:")), "no Confirm for a purchase that cannot be paid for");
    const forFriend = await s.call(press("pp:vip:buyforask:two_weeks:222000222", "111000111"));
    assert.match((forFriend.body as { data: { content: string } }).data.content, /costs \*\*250 Gold Coins\*\*, and you have \*\*100\*\*/, "a VIP gift too");

    // A Confirm drawn while they could still afford it.
    const done = await s.deferred(await s.call(press("pp:vip:buy:two_weeks:ixOLD", "111000111")));
    assert.match(done.content!, /❌ \*\*Two Weeks\*\* costs 250 Gold Coins and the balance is 100\. Nothing was spent\./);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 100);
    assert.equal(await s.repo.vips.get(s.server.id, "76561198000000301"), null);

    // A points gift bigger than the balance.
    const gift = await s.call(submit("pp:vip:gift:222000222", { amount: "300" }, "111000111"));
    assert.match((gift.body as { data: { content: string } }).data.content, /❌ A gift of 300 Gold Coins is more than the balance of 100\. Nothing was sent\./);
    assert.equal((await s.repo.economy.member("222000222"))?.balance ?? 0, 0);
  } finally {
    s.fake.close();
  }
});

/** A purchase that already went through answers as one, even when it spent the whole balance. */
test("a replay of a purchase that spent everything is still a replay, not a refusal", async () => {
  const s = await scene();
  try {
    await s.repo.economy.apply({ discordId: "111000111", delta: -350, reason: "spent elsewhere" });
    const first = await s.deferred(await s.call(press("pp:vip:buy:two_weeks:ixALL", "111000111")));
    assert.match(first.content!, /✅/);
    const again = await s.deferred(await s.call(press("pp:vip:buy:two_weeks:ixALL", "111000111")));
    assert.match(again.content!, /already went through/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 0);
  } finally {
    s.fake.close();
  }
});

test("buying: the grant is real, and the same interaction id can never pay twice", async () => {
  const s = await scene();
  try {
    const done = await s.deferred(await s.call(press("pp:vip:buy:two_weeks", "111000111", { id: "ixBUY" })));
    assert.match(done.content!, /✅ \*\*Two Weeks\*\*.*14 days of VIP on Shop #1/);
    assert.match(done.content!, /Balance \*\*350/);
    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000301"), "VIP landed on the buyer's game id");
    assert.ok(s.fake.received.includes("AddVip"));

    // A Discord retry re-delivers the SAME interaction id — the ref finds the debit and stops.
    const replay = await s.deferred(await s.call(press("pp:vip:buy:two_weeks", "111000111", { id: "ixBUY" })));
    assert.match(replay.content!, /already went through/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "one debit");

    // Broke members are told so, with their money intact.
    const broke = await s.deferred(await s.call(press("pp:vip:buy:two_weeks", "111000111")));
    assert.match(broke.content!, /✅/); // second real purchase: 350 ≥ 250, stacks
    const third = await s.deferred(await s.call(press("pp:vip:buy:two_weeks", "111000111")));
    assert.match(third.content!, /❌ \*\*Two Weeks\*\* costs 250 Gold Coins and the balance is 100\. Nothing was spent\./);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 100);
  } finally {
    s.fake.close();
  }
});

test("gifting points: select the person, type the amount, the two-row transfer lands", async () => {
  const s = await scene();
  try {
    const pick = await s.call(press("pp:vip:giftpick:", "111000111"));
    const rows = (pick.body as { data: { components: { components: { type: number; custom_id: string }[] }[] } }).data.components;
    const select = rows.flatMap((r) => r.components).find((c) => c.type === 5);
    assert.ok(select, "a user-select row renders");
    assert.equal(select!.custom_id, "pp:vip:giftsel:");

    const modal = await s.call(press("pp:vip:giftsel:", "111000111", { selected: ["222000222"] }));
    assert.equal((modal.body as { type: number }).type, 9);
    assert.equal((modal.body as { data: { custom_id: string } }).data.custom_id, "pp:vip:gift:222000222");

    const sent = await s.call(submit("pp:vip:gift:222000222", { amount: "40" }, "111000111"));
    assert.match((sent.body as { data: { content: string } }).data.content, /Sent \*\*40 Gold Coins\*\* to <@222000222>/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 560);
    assert.equal((await s.repo.economy.member("222000222"))?.balance, 40);

    const tiny = await s.call(submit("pp:vip:gift:222000222", { amount: "2" }, "111000111"));
    assert.match((tiny.body as { data: { content: string } }).data.content, /❌.*at least 5/);
  } finally {
    s.fake.close();
  }
});

test("gifting VIP: select the person, pick the offer, the days land on THEIR game id", async () => {
  const s = await scene();
  try {
    const offers = await s.call(press("pp:vip:giftvipsel:", "111000111", { selected: ["222000222"] }));
    const rows = (offers.body as { data: { components: { components: { custom_id: string }[] }[] } }).data.components;
    const buyBtn = rows.flatMap((r) => r.components).find((c) => c.custom_id.startsWith("pp:vip:buyforask:"));
    assert.ok(buyBtn, "one offer button per enabled offer");
    assert.equal(buyBtn!.custom_id, "pp:vip:buyforask:two_weeks:222000222");

    // The offer button asks first — it spends nothing on its own.
    const ask = await s.call(press(buyBtn!.custom_id, "111000111"));
    const askBody = (ask.body as { data: { content: string; components: { components: { custom_id: string; label: string }[] }[] } }).data;
    assert.match(askBody.content, /non-refundable/i);
    assert.match(askBody.content, /<@222000222>/, "and says who it is for");
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600, "nothing is spent by asking");

    const confirm = askBody.components.flatMap((r) => r.components).find((c) => c.custom_id.startsWith("pp:vip:buyfor:"));
    assert.ok(confirm, "the confirmation offers a button that actually buys");
    const done = await s.deferred(await s.call(press(confirm!.custom_id, "111000111")));
    assert.match(done.content!, /✅ \*\*Two Weeks\*\* for <@222000222>/);
    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000302"), "the FRIEND got the VIP");
    assert.equal(await s.repo.vips.get(s.server.id, "76561198000000301"), null, "the buyer did not");
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "the buyer paid");
  } finally {
    s.fake.close();
  }
});

/*
 * A claim can be a perk rather than a universal handout: "only boosters get the monthly".
 *
 * Two things have to hold, and the second is the one that is easy to get wrong. The button must
 * not be drawn for someone who cannot use it — an offer that answers "not for you" is worse than
 * no offer — AND the press must be refused on its own, because a panel sits open in Discord for
 * as long as the member leaves it there and roles are taken away as well as given.
 */
test("claims can be restricted to roles: hidden without it, refused even if pressed", async () => {
  const s = await scene();
  try {
    const BOOSTER = "900000000000000001";
    await s.repo.economy.setConfig({
      claims: {
        daily: { enabled: true, min: 10, max: 20, roleIds: [BOOSTER] },
        monthly: { enabled: true, min: 475, max: 525, roleIds: [] },
      },
    });

    // Without the role: the monthly (ungated) is offered, the daily is not there at all.
    const plain = await s.call(press("pp:vip::", "111000111"));
    const plainIds = (plain.body as { data: { components: { components: { custom_id: string }[] }[] } }).data
      .components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(!plainIds.includes("pp:vip:claim:daily"), "a claim they cannot make is not drawn");
    assert.ok(plainIds.includes("pp:vip:claim:monthly"), "an empty role list still means everyone");

    // Pressing it anyway — a stale panel, or a hand-built interaction — is refused, and pays nothing.
    const refused = await s.call(press("pp:vip:claim:daily", "111000111"));
    assert.match((refused.body as { data: { content: string } }).data.content, /particular role/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600, "a refused claim pays nothing");

    // With the role: the button is back and the claim pays.
    const asBooster = await s.call(press("pp:vip::", "111000111", { roles: [BOOSTER] }));
    const boosterIds = (asBooster.body as { data: { components: { components: { custom_id: string }[] }[] } }).data
      .components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(boosterIds.includes("pp:vip:claim:daily"));
    const paid = await s.call(press("pp:vip:claim:daily", "111000111", { roles: [BOOSTER] }));
    assert.match((paid.body as { data: { content: string } }).data.content, /Gold Coins/);
    assert.ok(((await s.repo.economy.member("111000111"))?.balance ?? 0) > 600, "the claim paid");
  } finally {
    s.fake.close();
  }
});

/*
 * Shop offers take a role gate too, and it sits on WHOEVER RECEIVES THE VIP.
 *
 * A community running WW2 and Vietnam sold both games' VIP to everybody: a Vietnam-only member
 * was shown WW2 offers they had no account to receive on, and only found out after spending.
 * The gate says where the days may land, so it follows the recipient — which means buying for
 * yourself needs the role, while GIFTING only needs it of your friend. Someone who plays only
 * Vietnam can still spend their own balance on WW2 VIP for someone who plays WW2.
 */
test("shop offers are gated on the recipient: your own game to buy, their game to gift", async () => {
  const s = await scene();
  const WW2_REG = "920000000000000001";     // what registering on a WW2 server earns
  const VIETNAM_REG = "920000000000000002"; // …and on a Vietnam one
  try {
    await s.repo.appConfig.set({ communityGuildId: "222222222222222222" });
    await s.repo.economy.setConfig({
      vipGifting: { enabled: true },
      offers: [
        { id: "ww2_2w", label: "WW2-Two Weeks", points: 250, days: 14, scope: { mode: "servers", serverIds: [s.server.id] }, enabled: true, roleIds: [WW2_REG] },
        { id: "viet_2w", label: "VIETNAM-Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [VIETNAM_REG] },
        { id: "open_2w", label: "Anyone-Two Weeks", points: 250, days: 14, scope: { mode: "servers", serverIds: [s.server.id] }, enabled: true, roleIds: [] },
      ],
    });
    // What Discord says each member holds, for the lookups a gift makes. The buyer (111000111)
    // plays Vietnam only; the friend (222000222) plays WW2 only.
    stubGuildRoles({ "111000111": [VIETNAM_REG], "222000222": [WW2_REG] });
    const idsWith = async (roles: string[]) => {
      const r = await s.call(press("pp:vip::", "111000111", { roles }));
      return (r.body as { data: { components: { components: { custom_id: string }[] }[] } }).data
        .components.flatMap((row) => row.components.map((c) => c.custom_id));
    };

    // The panel sells YOU what you can receive: registered for WW2 only, you see WW2 and the
    // ungated offer, and no Vietnam offer at all.
    const ww2Only = await idsWith([WW2_REG]);
    assert.ok(ww2Only.includes("pp:vip:buyask:ww2_2w"));
    assert.ok(!ww2Only.includes("pp:vip:buyask:viet_2w"), "no VIP for a game they do not play");
    assert.ok(ww2Only.includes("pp:vip:buyask:open_2w"), "an empty role list still means everyone");

    // The mirror image, and then somebody registered for both.
    const vietOnly = await idsWith([VIETNAM_REG]);
    assert.ok(vietOnly.includes("pp:vip:buyask:viet_2w") && !vietOnly.includes("pp:vip:buyask:ww2_2w"));
    const both = await idsWith([WW2_REG, VIETNAM_REG]);
    assert.ok(both.includes("pp:vip:buyask:ww2_2w") && both.includes("pp:vip:buyask:viet_2w"), "registered for both, offered both");

    // Registered for neither: only the ungated offer survives — the gate is per offer, never a
    // blanket over the shop.
    const neither = await idsWith([]);
    assert.deepEqual(neither.filter((i) => i.startsWith("pp:vip:buyask:")), ["pp:vip:buyask:open_2w"]);

    // Buying a game you are not registered for, from a stale button: refused, and told why.
    const refused = await s.deferred(await s.call(press("pp:vip:buy:ww2_2w", "111000111", { roles: [VIETNAM_REG] })));
    assert.match(refused.content!, /not registered for that game/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600, "a refused purchase charges nothing");

    // THE GIFT: the Vietnam-only member pays for WW2 VIP, because the FRIEND is registered for
    // WW2 and the friend is who it has to fit.
    const picked = await s.call(press("pp:vip:giftvipsel:", "111000111", { selected: ["222000222"], roles: [VIETNAM_REG] }));
    const giftIds = (picked.body as { data: { components: { components: { custom_id: string }[] }[] } }).data
      .components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(giftIds.includes("pp:vip:buyforask:ww2_2w:222000222"), "the offer list follows the RECIPIENT, not the payer");
    assert.ok(!giftIds.includes("pp:vip:buyforask:viet_2w:222000222"), "…so the payer's own game is not on this list");
    const gifted = await s.deferred(await s.call(press("pp:vip:buyfor:ww2_2w:222000222", "111000111", { roles: [VIETNAM_REG] })));
    assert.match(gifted.content!, /✅ \*\*WW2-Two Weeks\*\* for <@222000222>/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "600 − 250, paid by the Vietnam player");
    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000302"), "VIP landed on the friend");

    // And a gift the RECIPIENT cannot receive is refused before any money moves — even though the
    // payer holds the role themselves, which is exactly the case a payer-side gate got wrong.
    const badGift = await s.deferred(await s.call(press("pp:vip:buyfor:viet_2w:222000222", "111000111", { roles: [VIETNAM_REG] })));
    assert.match(badGift.content!, /cannot receive/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "still nothing extra spent");
  } finally {
    restoreGuildRoles();
    s.fake.close();
  }
});

/*
 * An empty role list is "none were seen", not "they hold none".
 *
 * A press that arrives without a member object carries no roles, and looks exactly like a member
 * who has none. Trusting it refuses a gated offer with "you are not registered for that game" —
 * told to somebody who IS registered, which is the worst possible version of this message. So an
 * empty list falls through to asking Discord, and only what Discord says decides.
 */
test("a gated self-purchase with no roles on the press asks Discord rather than refusing", async () => {
  const s = await scene();
  const WW2_REG = "920000000000000001";
  try {
    await s.repo.appConfig.set({ communityGuildId: "222222222222222222" });
    await s.repo.economy.setConfig({
      offers: [{ id: "ww2_2w", label: "WW2-Two Weeks", points: 250, days: 14, scope: { mode: "servers", serverIds: [s.server.id] }, enabled: true, roleIds: [WW2_REG] }],
    });
    // Discord says this member holds the role; the press just did not carry it.
    stubGuildRoles({ "111000111": [WW2_REG] });
    const bought = await s.deferred(await s.call(press("pp:vip:buy:ww2_2w", "111000111", { roles: [] })));
    assert.match(bought.content!, /✅ \*\*WW2-Two Weeks\*\*/, "the lookup, not the empty press, decides");
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350);

    // And when Discord says they do NOT hold it, the refusal stands — with nothing spent.
    stubGuildRoles({ "111000111": [] });
    const refused = await s.deferred(await s.call(press("pp:vip:buy:ww2_2w", "111000111", { roles: [] })));
    assert.match(refused.content!, /not registered for that game/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 350, "still 350 — the refusal charged nothing");
  } finally {
    restoreGuildRoles();
    s.fake.close();
  }
});

/*
 * Gifting VIP takes the same role gate a claim does — same semantics, every step of the flow.
 *
 * Three doors lead to the same purchase (the entry button, the person picker, the offer button),
 * and a stale panel or a hand-built interaction can knock on any of them. Each refuses on its
 * own; nothing relies on the button "not having been drawn".
 */
test("gifting VIP can be restricted to roles: hidden without it, and every step refuses alone", async () => {
  const s = await scene();
  try {
    const PATRON = "910000000000000001";
    await s.repo.economy.setConfig({ vipGifting: { enabled: true, roleIds: [PATRON] } });

    // Without the role the button is not drawn…
    const plain = await s.call(press("pp:vip::", "111000111"));
    const plainIds = (plain.body as { data: { components: { components: { custom_id: string }[] }[] } }).data
      .components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(!plainIds.includes("pp:vip:giftvippick:"), "no Gift VIP button without the role");

    // …and each step of the flow refuses a press on its own, with no money moved.
    for (const attempt of [
      press("pp:vip:giftvippick:", "111000111"),
      press("pp:vip:giftvipsel:", "111000111", { selected: ["222000222"] }),
    ]) {
      const r = await s.call(attempt);
      assert.match((r.body as { data: { content: string } }).data.content, /particular role/);
    }
    const buyfor = await s.deferred(await s.call(press("pp:vip:buyfor:two_weeks:222000222", "111000111")));
    assert.match(buyfor.content!, /particular role/);
    assert.equal((await s.repo.economy.member("111000111"))?.balance, 600, "nothing was charged");
    assert.equal(await s.repo.vips.get(s.server.id, "76561198000000302"), null, "no VIP moved");

    // With the role, the whole flow opens back up.
    const withRole = await s.call(press("pp:vip::", "111000111", { roles: [PATRON] }));
    const roleIds2 = (withRole.body as { data: { components: { components: { custom_id: string }[] }[] } }).data
      .components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(roleIds2.includes("pp:vip:giftvippick:"));
    const done = await s.deferred(await s.call(press("pp:vip:buyfor:two_weeks:222000222", "111000111", { roles: [PATRON] })));
    assert.match(done.content!, /✅ \*\*Two Weeks\*\* for <@222000222>/);
  } finally {
    s.fake.close();
  }
});

/*
 * The History button: the member's own ledger, newest first, paged — "where did my points go"
 * answered without asking staff to open the app.
 */
test("the panel's History shows the member's ledger, newest first, and pages through it", async () => {
  const s = await scene();
  try {
    // Root offers it, to linked and unlinked members alike (the balance is theirs either way).
    const root = await s.call(press("pp:vip::", "111000111"));
    const ids = (root.body as { data: { components: { components: { custom_id: string }[] }[] } }).data
      .components.flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(ids.includes("pp:vip:history:0"), "the History button is on the root");

    // A few movements on top of the 600 seed row.
    await s.repo.economy.apply({ discordId: "111000111", delta: 15, reason: "daily claim" });
    await s.repo.economy.apply({ discordId: "111000111", delta: -250, reason: "shop: Two Weeks", actorName: "d111000111" });
    const view = await s.call(press("pp:vip:history:0", "111000111"));
    const content = (view.body as { data: { content: string } }).data.content;
    assert.match(content, /Gold Coins history/);
    assert.match(content, /balance \*\*365\*\*/);
    assert.match(content, /\*\*-250\*\* — shop: Two Weeks/);
    assert.match(content, /\*\*\+15\*\* — daily claim/);
    // Newest first: the debit row appears before the claim, which appears before the seed.
    assert.ok(content.indexOf("-250") < content.indexOf("+15"), "newest first");
    assert.match(content, /<t:\d+:R>/, "times are Discord timestamps, in the reader's zone");

    // Eleven more rows forces a second page, and its pager ids are distinct and correct.
    for (let i = 0; i < 11; i++) await s.repo.economy.apply({ discordId: "111000111", delta: 1, reason: `tick ${i}` });
    const p1 = await s.call(press("pp:vip:history:0", "111000111"));
    assert.match((p1.body as { data: { content: string } }).data.content, /page 1\/2/);
    const p2 = await s.call(press("pp:vip:history:1", "111000111"));
    const page2 = (p2.body as { data: { content: string } }).data.content;
    assert.match(page2, /page 2\/2/);
    assert.match(page2, /seed/, "the oldest row lives on the last page");
    // An unlinked member with no rows gets an answer, not an error.
    const empty = await s.call(press("pp:vip:history:0", "444555666"));
    assert.match((empty.body as { data: { content: string } }).data.content, /Nothing yet/);
  } finally {
    s.fake.close();
  }
});

test("the panel's History shows reasons and staff names as written", async () => {
  const s = await scene();
  try {
    await s.repo.economy.apply({ discordId: "111000111", delta: 5, reason: "gift from *big*_lynx", actorName: "mod_one" });
    const view = await s.call(press("pp:vip:history:0", "111000111"));
    const content = (view.body as { data: { content: string } }).data.content;
    assert.match(content, /gift from \\\*big\\\*\\_lynx \(by mod\\_one\)/);
  } finally {
    s.fake.close();
  }
});

/*
 * A VIP purchase's line says what it bought: when its days start and when the VIP now ends. Nothing
 * edits a ledger row, and the row is written before the grant it pays for, so the dates come from
 * each server's grant in the trail, found by the purchase's ref. A second purchase starts where the
 * first ends. A gift's dates are the friend's VIP, and stay theirs.
 */
test("the panel's History says when each VIP purchase's days start and when the VIP ends — a gift's dates stay with the friend", async () => {
  const s = await scene();
  try {
    await s.repo.economy.apply({ discordId: "111000111", delta: 500, reason: "top up" });
    const before = Date.now();
    await s.deferred(await s.call(press("pp:vip:buy:two_weeks", "111000111", { id: "ixFIRST" })));
    await s.deferred(await s.call(press("pp:vip:buy:two_weeks", "111000111", { id: "ixSECOND" })));
    await s.deferred(await s.call(press("pp:vip:buyfor:two_weeks:222000222", "111000111", { id: "ixGIFT" })));
    const after = Date.now();
    const view = await s.call(press("pp:vip:history:0", "111000111"));
    const lines = (view.body as { data: { content: string } }).data.content.split("\n");
    const purchases = lines.flatMap((l, i) => (/^\*\*-250\*\* — VIP shop: Two Weeks — <t:\d+:R>$/.test(l) ? [i] : []));
    assert.equal(purchases.length, 2, `two purchases of their own: ${lines.join(" | ")}`);
    const [second, first] = purchases as [number, number];
    const datesUnder = (i: number) => {
      const m = /^-# Shop #1: VIP from <t:(\d+):f> until <t:(\d+):f>$/.exec(lines[i + 1] ?? "");
      assert.ok(m, `the line after "${lines[i]}" gives the dates: "${lines[i + 1]}"`);
      return { from: Number(m[1]) * 1000, until: Number(m[2]) * 1000 };
    };
    const one = datesUnder(first);
    const two = datesUnder(second);
    const DAY = 86_400_000;
    // Discord's stamps are whole seconds, so each instant is within a second of the real one.
    assert.ok(one.from >= before - 1000 && one.from <= after, "the first purchase's days start when it was bought");
    assert.ok(Math.abs(one.until - one.from - 14 * DAY) <= 1000, "and run its 14 days");
    assert.ok(Math.abs(two.from - one.until) <= 1000, "the second's days start where the first's end");
    assert.ok(Math.abs(two.until - two.from - 14 * DAY) <= 1000, "and run 14 more");
    const vip = await s.repo.vips.get(s.server.id, "76561198000000301");
    assert.ok(vip?.expiration && Math.abs(Date.parse(vip.expiration) - two.until) <= 1000, "the last end is the VIP's end now");
    // The gift: the line says who it was for; when the friend's VIP ends is not the buyer's to read.
    const gift = lines.findIndex((l) => l.includes("VIP shop: Two Weeks — gift for Friend"));
    assert.ok(gift >= 0, "the gift's line is there");
    assert.doesNotMatch(lines[gift + 1] ?? "", /^-# /, "with no dates beneath it");
    assert.ok(await s.repo.vips.get(s.server.id, "76561198000000302"), "though the friend's VIP did land");
    // Nothing else grows a date line: the top up and the seed are not purchases.
    assert.equal(lines.filter((l) => l.startsWith("-# ")).length, 2, "dates under the two purchases only");
  } finally {
    s.fake.close();
  }
});

/*
 * The leaderboard is the economy's only social surface — without it a balance is a private number
 * with nothing to chase, which is why the old bot had one and why its absence was the last thing
 * blocking that bot being switched off.
 */
test("leaderboard: standings richest first, the caller's own line marked, paged", async () => {
  const s = await scene();
  try {
    // Three more members around the caller (who starts on 600), enough to spill onto a second page.
    for (let i = 0; i < 12; i++) {
      await s.repo.economy.apply({ discordId: `9000${i}`, discordName: `Rich${i}`, delta: 1000 + i, reason: "seed", ref: `seed:${i}`, actorName: "test" });
    }
    const r = await s.call(press("pp:vip:leaderboard:0", "111000111"));
    const data = (r.body as { data: { content: string; components?: { components: { custom_id: string }[] }[] } }).data;

    // Richest first: the top line is the biggest balance seeded, and it is numbered 1.
    assert.match(data.content, /^1\. Rich11 — \*\*1011\*\*$/m, "top of the board is the richest");
    // The caller is on 600, so they are NOT on page one — but their balance still shows.
    assert.match(data.content, /You have \*\*600\*\*/, "their own balance is always in the header");
    assert.match(data.content, /page 1\/2/);
    const ids = (data.components ?? []).flatMap((row) => row.components.map((c) => c.custom_id));
    assert.ok(ids.includes("pp:vip:leaderboard:1"), "there is a next page to reach");

    // Page two holds the caller, and their line is the marked one.
    const p2 = (await s.call(press("pp:vip:leaderboard:1", "111000111"))).body as { data: { content: string } };
    assert.match(p2.data.content, /\*\*d111000111\*\* ←/, "the caller's own row is marked wherever it lands");

    // A stale button naming a page that no longer exists must clamp, not throw or render empty.
    const far = (await s.call(press("pp:vip:leaderboard:99", "111000111"))).body as { data: { content: string } };
    assert.match(far.data.content, /page 2\/2/, "an out-of-range page clamps to the last one");

    // Names as their owners typed them: "*star*" is a name on the board, not italics.
    await s.repo.economy.apply({ discordId: "90099", discordName: "*star*_one", delta: 5000, reason: "seed", ref: "seed:star", actorName: "test" });
    const top = (await s.call(press("pp:vip:leaderboard:0", "111000111"))).body as { data: { content: string } };
    assert.match(top.data.content, /^1\. \\\*star\\\*\\_one — \*\*5000\*\*$/m);
  } finally {
    s.fake.close();
  }
});
