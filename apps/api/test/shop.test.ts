/**
 * The VIP shop service: linking gates, idempotent debits, real grants, visible refunds.
 *
 * The happy path runs against the fake HLL server (a real TCP listener speaking binary-v2), so it
 * proves the half AFTER `client.execute` succeeds — the vips row, the audit, the balance. The
 * refund path runs against a server on a closed port, which is exactly what a dead game server
 * looks like to the shop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext, type AppContext } from "../dist/app.js";
import { gift, purchase } from "../dist/shop.js";
import { fakeGameServer } from "./fake-hll-server.ts";
import { jsonFetch } from "./harness.ts";

async function withServer(fn: (base: string, ctx: AppContext, token: string) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const token = login.body.token as string;
  try { await fn(base, ctx, token); } finally { server.close(); }
}

const OFFER = { id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" as const }, enabled: true };

/** Seed the standard scene: a config with one enabled offer, a linked + funded buyer. */
/*
 * Ids are unique per scene. They were fixed strings, which works on the in-memory store (each
 * scene builds its own repo) and is quietly fatal against Postgres, where every test in the file
 * shares one database: the buyer's BALANCE carried from one test into the next, so a test that
 * funded 300 and spent 250 was asserting against whatever the previous tests had left lying
 * around. An economy is exactly the thing you want verified on the store that really holds it.
 */
let sceneSeq = 0;
async function scene(base: string, ctx: AppContext, token: string, opts: { fund?: number } = {}) {
  const auth = { authorization: `Bearer ${token}` };
  const n = String(++sceneSeq).padStart(2, "0");
  /** A Discord id belonging to this scene — same literal, scoped to this test. */
  const who = (id: string) => `${n}${id}`;
  /** …and a game id, for the friends and giftees each test invents. */
  const pid = (suffix: string) => `7656119810000${n}${suffix}`;
  await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
    currencyName: "Points", balanceCap: null,
    claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
    gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true },
    offers: [OFFER],
  }) });
  const buyer = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: pid("00"), name: "Buyer" });
  await ctx.repo.externalLinks.set(buyer.id, "discord", who("111111111111"), "registration");
  if (opts.fund) await ctx.repo.economy.apply({ discordId: who("111111111111"), delta: opts.fund, reason: "seed" });
  return { auth, buyer, who, pid };
}

test("purchase refuses before money moves: unknown offer, unlinked buyer, unlinked gift recipient", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who } = await scene(base, ctx, token, { fund: 1000 });
    const buy = (id: string, body: Record<string, unknown>) =>
      jsonFetch(`${base}/api/economy/members/${id}/purchase`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    assert.equal((await buy(who("111111111111"), { offerId: "nope" })).status, 400);
    // Unlinked buyer: refused, and their (nonexistent) balance never moves.
    assert.equal((await buy(who("222222222222"), { offerId: OFFER.id })).status, 400);
    assert.equal(await ctx.repo.economy.member(who("222222222222")), null, "no member row conjured by a refusal");
    // Gift for an unlinked recipient: refused, buyer keeps their points.
    const gift = await buy(who("111111111111"), { offerId: OFFER.id, forDiscordId: who("333333333333") });
    assert.equal(gift.status, 400);
    assert.equal((await ctx.repo.economy.member(who("111111111111")))?.balance, 1000);
    // Insufficient balance names the shortfall and leaves no ledger residue.
    await ctx.repo.economy.apply({ discordId: who("111111111111"), delta: -900, reason: "drain" });
    const broke = await buy(who("111111111111"), { offerId: OFFER.id });
    assert.equal(broke.status, 400);
    assert.equal((await ctx.repo.economy.member(who("111111111111")))?.balance, 100);
  });
});

test("no server accepts the grant → the debit is credited back as its own visible ledger row", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who } = await scene(base, ctx, token, { fund: 300 });
    // A server exists but its game is unreachable (closed port) — the offer covers it, the grant
    // fails, the shop makes the buyer whole.
    await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dead", host: "127.0.0.1", port: 1, password: "x" }) });
    const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "refunded");
    assert.equal(r.body.applied.length, 0);
    assert.equal(r.body.skipped.length, 1);
    assert.equal(r.body.balance, 300, "made whole");
    // BOTH movements are on the ledger — the history explains itself.
    const ledger = await ctx.repo.economy.ledger(who("111111111111"), { limit: 10 });
    assert.equal(ledger[0]!.delta, OFFER.points);
    assert.match(ledger[0]!.reason, /refund/);
    assert.equal(ledger[1]!.delta, -OFFER.points);

    /*
     * WHY it refunded must survive the moment (ticket-4764: a member's screenshot of a bare ❌
     * was the entire record). Two audiences, two strings:
     *  - reason (staff): the raw failure, verbatim — here a socket error naming host and port;
     *  - memberReason: safe for Discord — an infrastructure failure is generalised, because a
     *    connect refusal's "127.0.0.1:1" has no business in a member-facing reply.
     * And an audit row carries the whole picture, so staff answer the ticket from the trail
     * instead of re-deriving the grant loop.
     */
    assert.ok(r.body.skipped[0].reason, "the raw failure is recorded");
    assert.match(r.body.skipped[0].memberReason, /could not be reached/);
    assert.ok(!/127\.0\.0\.1/.test(r.body.skipped[0].memberReason), "no host:port in the member-facing sentence");
    const trail = await ctx.repo.audit.list({ limit: 20 });
    const row = trail.find((a) => a.action === "vip.purchase_refunded");
    assert.ok(row, "the refund leaves an audit row");
    assert.match(row!.summary, /dead/, "the audit names the server that refused");
  });
});

/*
 * The buyer-shaped refusal: the offer's server runs a game the buyer has no linked account on.
 * This is ticket-4764's most likely shape — a WW2-linked member buying a Vietnam offer — and the
 * one sentence that lets them fix it themselves ("no <game> account linked") is OUR wording, so
 * it must reach the member verbatim rather than be generalised away with the socket errors.
 */
test("a buyer with no account on the offer's game is told exactly that, in the member-safe reason", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who } = await scene(base, ctx, token, { fund: 300 });
    const made = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "viet", host: "127.0.0.1", port: 1, password: "x" }) });
    // The server runs Vietnam; the scene's buyer is linked to an hll account only.
    const flip = await jsonFetch(`${base}/api/servers/${made.body.server.id}/game`, { method: "POST", headers: auth, body: JSON.stringify({ game: "hllv" }) });
    assert.equal(flip.status, 200, `switching the server to Vietnam failed: ${JSON.stringify(flip.body)}`);
    const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "refunded");
    assert.equal(r.body.balance, 300, "made whole");
    assert.match(r.body.skipped[0].memberReason, /account linked/, "our own refusal reaches the member verbatim");
    assert.equal(r.body.skipped[0].memberReason, r.body.skipped[0].reason, "member and staff read the same sentence when it is safe");
  });
});

/*
 * A replay has to say which outcome it is replaying.
 *
 * The debit's ref is spent whether the purchase SUCCEEDED or refunded itself, so answering every
 * replay with "that purchase already went through" tells the member their VIP is live when the
 * grant reached nobody and their points were handed back — and sends them to staff to find out
 * why nothing happened. The refund rides a ref derived from the debit's, so the ledger knows.
 */
test("a replay of a purchase that refunded itself reports the refund, not a success", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who } = await scene(base, ctx, token, { fund: 300 });
    await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dead", host: "127.0.0.1", port: 1, password: "x" }) });
    const first = await purchase(ctx.repo, { buyerDiscordId: who("111111111111"), offerId: OFFER.id, ref: "buy:double-press", actorName: "test" });
    assert.equal(first.status, "refunded");
    assert.equal(first.balance, 300, "made whole");

    const again = await purchase(ctx.repo, { buyerDiscordId: who("111111111111"), offerId: OFFER.id, ref: "buy:double-press", actorName: "test" });
    assert.equal(again.status, "refunded", "the second press describes the same failed purchase");
    assert.equal(again.balance, 300, "and moves nothing");
    // A purchase that really did land still reads as a plain replay — the two are told apart.
    await ctx.repo.economy.apply({ discordId: who("111111111111"), delta: -50, reason: "landed", ref: "buy:landed" });
    const landed = await purchase(ctx.repo, { buyerDiscordId: who("111111111111"), offerId: OFFER.id, ref: "buy:landed", actorName: "test" });
    assert.equal(landed.status, "replay");
  });
});

test("purchase against a live game: debit, cumulative grant, audits — and a replay pays nothing", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, buyer, who } = await scene(base, ctx, token, { fund: 600 });
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "ok");
      assert.equal(r.body.balance, 350);
      assert.equal(r.body.applied.length, 1);

      // The grant is the real staff-path grant: a vips row with ~14 days on the clock, the game
      // told to AddVip, and a vip.grant audit row attributed to the shop actor.
      const vip = await ctx.repo.vips.get(serverId, buyer.platformId);
      assert.ok(vip, "vips row written");
      const days = (Date.parse(vip!.expiration!) - Date.now()) / 86_400_000;
      assert.ok(days > 13.9 && days < 14.1, `expiration ~14 days out (got ${days.toFixed(2)})`);
      assert.ok(fake.received.includes("AddVip"), `game saw AddVip (got: ${fake.received.join(", ")})`);
      const audits = await ctx.repo.audit.list({});
      assert.ok(audits.some((a) => a.action === "vip.grant" && a.actorUserId === null), "shop grant audited");
      assert.ok(audits.some((a) => a.action === "economy.purchase"), "staff purchase audited");

      // Replay THROUGH THE SERVICE with the original ref: nothing moves, nothing extends.
      const ref = (await ctx.repo.economy.ledger(who("111111111111"), { limit: 5 })).find((e) => e.delta === -OFFER.points)!.ref!;
      const again = await purchase(ctx.repo, { buyerDiscordId: who("111111111111"), offerId: OFFER.id, ref, actorName: "replay" });
      assert.equal(again.status, "replay");
      assert.equal(again.balance, 350, "no second debit");
      assert.equal((await ctx.repo.vips.get(serverId, buyer.platformId))!.expiration, vip!.expiration, "no second extension");

      // A second REAL purchase stacks: cumulative duration onto the still-valid grant.
      const second = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
      assert.equal(second.body.status, "ok");
      const stacked = await ctx.repo.vips.get(serverId, buyer.platformId);
      const stackedDays = (Date.parse(stacked!.expiration!) - Date.now()) / 86_400_000;
      assert.ok(stackedDays > 27.9 && stackedDays < 28.1, `second purchase stacks to ~28 days (got ${stackedDays.toFixed(2)})`);
    } finally {
      fake.close();
    }
  });
});

test("gifting VIP has its own switch: offers existing is not consent", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who, pid } = await scene(base, ctx, token, { fund: 300 });
    const friend = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: pid("03"), name: "Pal" });
    await ctx.repo.externalLinks.set(friend.id, "discord", who("777777777777"), "registration");
    // Same offers, same linked pair — only the switch is off.
    await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      currencyName: "Points", balanceCap: null,
      claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: false }, offers: [OFFER],
    }) });
    const refused = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id, forDiscordId: who("777777777777") }) });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /gifting VIP is switched off/i);
    assert.equal((await ctx.repo.economy.member(who("111111111111")))?.balance, 300, "nothing moved");
    // Buying for YOURSELF is untouched by the gift switch: it reaches the grant stage (which then
    // refunds, since this scene's only server is unreachable) rather than being refused up front.
    await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dead", host: "127.0.0.1", port: 1, password: "x" }) });
    const own = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
    assert.equal(own.status, 200);
    assert.equal(own.body.status, "refunded");
  });
});

test("gift of VIP lands the days on the recipient's game id, not the buyer's", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, buyer, who, pid } = await scene(base, ctx, token, { fund: 300 });
    const friend = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: pid("01"), name: "Friend" });
    await ctx.repo.externalLinks.set(friend.id, "discord", who("444444444444"), "registration");
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id, forDiscordId: who("444444444444") }) });
      assert.equal(r.body.status, "ok");
      assert.ok(await ctx.repo.vips.get(serverId, friend.platformId), "recipient got the VIP");
      assert.equal(await ctx.repo.vips.get(serverId, buyer.platformId), null, "buyer did not");
      assert.equal(r.body.balance, 50, "buyer paid");
    } finally {
      fake.close();
    }
  });
});

test("points gift: minimum, linking, headroom, and the two-row transfer", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who, pid } = await scene(base, ctx, token, { fund: 500 });
    const friend = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: pid("02"), name: "Giftee" });
    await ctx.repo.externalLinks.set(friend.id, "discord", who("555555555555"), "registration");
    const send = (body: Record<string, unknown>) =>
      jsonFetch(`${base}/api/economy/members/${who("111111111111")}/gift`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    assert.equal((await send({ toDiscordId: who("555555555555"), amount: 3 })).status, 400, "below the configured minimum");
    // The ceiling bounds ONE gift. With it set to 100, a 400 goes nowhere near the balance.
    await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      currencyName: "Points", balanceCap: null,
      claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: true, minAmount: 5, maxAmount: 100 }, vipGifting: { enabled: true }, offers: [OFFER],
    }) });
    const aboveCeiling = await send({ toDiscordId: who("555555555555"), amount: 400 });
    assert.equal(aboveCeiling.status, 400);
    assert.match(aboveCeiling.body.error.message, /at most 100 Points/);
    assert.equal((await ctx.repo.economy.member(who("111111111111")))?.balance, 500, "the giver kept every point");
    // …and the cap lifts again when it is blank.
    await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      currencyName: "Points", balanceCap: null,
      claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true }, offers: [OFFER],
    }) });
    assert.equal((await send({ toDiscordId: who("666666666666"), amount: 50 })).status, 400, "unlinked recipient");
    assert.equal((await send({ toDiscordId: who("111111111111"), amount: 50 })).status, 400, "self-gift");

    const ok = await send({ toDiscordId: who("555555555555"), amount: 200 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "ok");
    assert.equal(ok.body.fromBalance, 300);
    assert.equal(ok.body.toBalance, 200);
    // Two ledger rows, one story: the debit carries the ref, the credit rides gift-in:<ref>.
    const inRow = (await ctx.repo.economy.ledger(who("555555555555"), { limit: 5 }))[0]!;
    assert.ok(inRow.ref?.startsWith("gift-in:"), "credit ref pairs with the debit");

    // A cap makes headroom a refusal, not a burn: recipient at 200 with cap 250 can take 50, not 200.
    await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      currencyName: "Points", balanceCap: 250,
      claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true },
      offers: [OFFER],
    }) });
    const over = await send({ toDiscordId: who("555555555555"), amount: 200 });
    assert.equal(over.status, 400);
    assert.match(over.body.error.message, /can only hold 50 more/);
    assert.equal((await ctx.repo.economy.member(who("111111111111")))?.balance, 300, "giver kept their points");

    // Switching gifting off closes the door entirely.
    await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      currencyName: "Points", balanceCap: null,
      claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: false, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true },
      offers: [OFFER],
    }) });
    assert.equal((await send({ toDiscordId: who("555555555555"), amount: 50 })).status, 400);
  });
});

/*
 * A gift is two transactions, and the gap between them is where points can vanish.
 *
 * The debit commits, then the credit does. A process that dies in between leaves the giver charged
 * and the recipient unpaid, with the points existing nowhere — and the retry used to find the debit
 * ref spent, report "that gift already went through", and leave it that way forever. The credit is
 * idempotent on its own ref, so running it on the replay path finishes an interrupted gift while an
 * ordinary double-press still changes nothing.
 */
test("a gift interrupted between its two legs is finished by the retry, not declared done", async () => {
  await withServer(async (base, ctx, token) => {
    const { who, pid } = await scene(base, ctx, token, { fund: 500 });
    const friend = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: pid("04"), name: "Half Paid" });
    await ctx.repo.externalLinks.set(friend.id, "discord", who("777777777777"), "registration");
    // The debit on its own: exactly the ledger an interrupted gift leaves behind.
    await ctx.repo.economy.apply({ discordId: who("111111111111"), delta: -60, reason: "gift to Half Paid", ref: "gift:interrupted", actorName: "test" });
    assert.equal(await ctx.repo.economy.member(who("777777777777")), null, "the recipient was never paid");

    const heal = await gift(ctx.repo, { fromDiscordId: who("111111111111"), toDiscordId: who("777777777777"), amount: 60, ref: "gift:interrupted", actorName: "test" });
    assert.equal(heal.status, "replay");
    assert.equal(heal.toBalance, 60, "the credit leg finished");
    assert.equal(heal.fromBalance, 440, "and the giver was not charged a second time");

    // A third press is a true replay: both refs are spent and nothing moves.
    const again = await gift(ctx.repo, { fromDiscordId: who("111111111111"), toDiscordId: who("777777777777"), amount: 60, ref: "gift:interrupted", actorName: "test" });
    assert.equal(again.status, "replay");
    assert.equal(again.fromBalance, 440);
    assert.equal(again.toBalance, 60);
    assert.equal((await ctx.repo.economy.ledger(who("777777777777"), { limit: 10 })).length, 1, "one credit row, not three");
  });
});

/*
 * The two games do not share player ids.
 *
 * A member who plays both has two accounts — one row per game, each carrying an id only that game's
 * servers can address. The shop used to resolve the recipient ONCE, taking whichever account had
 * been seen most recently, and hand that single id to every server the offer covered. A purchase
 * reaching the Vietnam server was therefore sent a WW2 id: the server took the command, matched
 * nobody, and the buyer's points were gone with no VIP and nothing anywhere saying why.
 */
test("VIP shop: each server is granted with the account for ITS game, never another game's id", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who, pid, buyer } = await scene(base, ctx, token, { fund: 1000 });
    const ww2 = await fakeGameServer(base, token, "ww2");
    const nam = await fakeGameServer(base, token, "nam", "hllv");
    try {
      // The buyer already has a WW2 account (from `scene`). Give them a Vietnam one too — a separate
      // row with a different id, which is what a second game actually looks like.
      const namAccount = await ctx.repo.players.upsert({ game: "hllv", platform: "epic", platformId: pid("-nam"), name: "Buyer (Nam)" });
      await ctx.repo.externalLinks.set(namAccount.id, "discord", who("111111111111"), "registration");

      const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
      assert.equal(r.status, 200);
      assert.equal(r.body.applied.length, 2, `both servers should have taken it: ${JSON.stringify(r.body.skipped)}`);

      // Each server's VIP list holds the id from ITS OWN game, and neither holds the other's.
      assert.deepEqual((await ctx.repo.vips.list(ww2.serverId)).map((v) => v.playerId), [buyer.platformId], "the WW2 server got the WW2 id");
      assert.deepEqual((await ctx.repo.vips.list(nam.serverId)).map((v) => v.playerId), [namAccount.platformId], "and the Vietnam server got the Vietnam id");
    } finally { await ww2.fake.close(); await nam.fake.close(); }
  });
});

test("VIP shop: a member with no account on a server's game is told so, not granted silently", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who } = await scene(base, ctx, token, { fund: 1000 });
    // WW2 account only (from `scene`), and the offer reaches a Vietnam server.
    const nam = await fakeGameServer(base, token, "nam", "hllv");
    try {
      const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
      // The skip names the missing account rather than granting with the WW2 id and leaving the
      // member to wonder where their VIP went.
      const skipped = (r.body.skipped ?? []) as { serverId: string; reason: string }[];
      assert.ok(skipped.some((sk) => sk.serverId === nam.serverId && /account linked/.test(sk.reason)), `expected a named refusal, got ${JSON.stringify(skipped)}`);
      assert.equal((await ctx.repo.vips.list(nam.serverId)).length, 0, "and no VIP was written with the wrong game's id");
    } finally { await nam.fake.close(); }
  });
});

/*
 * Buying VIP must never COST you VIP.
 *
 * Reported from production: a member holding permanent VIP bought a VIP offer with shop points and
 * watched their grant change from permanent to a date a month out. The days were stacked onto an
 * `expiration` of null, which the grant math read as "no VIP yet" rather than "VIP forever", so the
 * purchase replaced an unlimited grant with a finite one. The member paid to be downgraded.
 */
test("buying VIP while already permanent: the grant survives, and the points come back", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, buyer, who } = await scene(base, ctx, token, { fund: 600 });
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      // The offer is scoped to THIS server rather than "all". A community-wide offer fans out to
      // every server in the database, which against Postgres includes the unreachable ones other
      // tests created — so the purchase failed on a dead socket long before reaching the question
      // this test is asking.
      await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
        currencyName: "Points", balanceCap: null,
        claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
        gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true },
        offers: [{ ...OFFER, scope: { mode: "servers" as const, serverIds: [serverId] } }],
      }) });
      // Staff grant permanent VIP the ordinary way, so the row under test is a real one.
      await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: buyer.platformId, playerName: buyer.name, mode: "permanent", comment: "paid lifetime" }) });
      assert.equal((await ctx.repo.vips.get(serverId, buyer.platformId))!.expiration, null, "permanent to begin with");

      const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
      assert.equal(r.status, 200);
      assert.equal((await ctx.repo.vips.get(serverId, buyer.platformId))!.expiration, null, "STILL permanent — this is the whole bug");

      // Every server the offer covered was already permanent, so the purchase bought nothing and
      // says so, in the skip AND on the ledger, instead of pocketing the points for a no-op.
      assert.equal(r.body.status, "refunded");
      assert.equal(r.body.applied.length, 0);
      assert.match((r.body.skipped as { reason: string }[])[0]!.reason, /already has permanent VIP/);
      assert.equal(r.body.balance, 600, "made whole");
      assert.match((await ctx.repo.economy.ledger(who("111111111111"), { limit: 1 }))[0]!.reason, /already permanent VIP everywhere/);
    } finally {
      fake.close();
    }
  });
});

test("buying VIP while a group that takes no rewards holds it: nothing frozen for later, and the points come back", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, buyer, who } = await scene(base, ctx, token, { fund: 600 });
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
        currencyName: "Points", balanceCap: null,
        claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
        gifting: { enabled: true, minAmount: 5, maxAmount: null }, vipGifting: { enabled: true },
        offers: [{ ...OFFER, scope: { mode: "servers" as const, serverIds: [serverId] } }],
      }) });
      const group = await ctx.repo.playerGroups.create({ name: `Staff ${Math.random().toString(36).slice(2, 7)}`, createdByName: "owner" });
      await ctx.repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false });
      await ctx.repo.vips.startGroupHold({ serverId, playerId: buyer.platformId, playerName: buyer.name, groups: [{ id: group.id, name: group.name, severanceMinutes: 0 }], createdByName: "group perks" });
      const banked = async () => (await ctx.repo.vips.get(serverId, buyer.platformId))!.groupHold!.bankedMs;
      const buy = () => jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });

      // The group's VIP is permanent and takes no purchases: there was nothing to sell them.
      const r = await buy();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.status, "refunded");
      assert.equal(r.body.applied.length, 0);
      const reason = (r.body.skipped as { reason: string; memberReason: string }[])[0]!;
      assert.match(reason.reason, new RegExp(`^already has permanent VIP here, from group “${group.name}”, which takes no rewards or purchases`));
      assert.equal(reason.memberReason, reason.reason, "the member is told the same");
      assert.equal(r.body.balance, 600, "made whole");
      assert.equal(await banked(), 0, "nothing frozen to come back when they leave");

      // The same group taking rewards: the purchase stands, and the days wait beneath the hold.
      await ctx.repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: true });
      const again = await buy();
      assert.equal(again.body.status, "ok", JSON.stringify(again.body));
      assert.equal(again.body.balance, 350);
      assert.equal(await banked(), 14 * 86_400_000);
      assert.equal((await ctx.repo.vips.get(serverId, buyer.platformId))!.expiration, null, "still the group's permanent VIP");
    } finally {
      fake.close();
    }
  });
});

test("permanent on one server does not block the days landing on another", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, buyer, who } = await scene(base, ctx, token, { fund: 600 });
    const ww2 = await fakeGameServer(base, token, "ww2");
    const second = await fakeGameServer(base, token, "second");
    try {
      // Permanent on one of the two servers the "all" offer covers — the shape a booster is in.
      await jsonFetch(`${base}/api/servers/${ww2.serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: buyer.platformId, playerName: buyer.name, mode: "permanent", comment: "paid lifetime" }) });

      const r = await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });
      assert.equal(r.body.status, "ok", "a purchase that landed somewhere is a purchase");
      assert.equal(r.body.balance, 350, "and is paid for once");
      assert.equal((await ctx.repo.vips.get(ww2.serverId, buyer.platformId))!.expiration, null, "permanent kept");
      const days = (Date.parse((await ctx.repo.vips.get(second.serverId, buyer.platformId))!.expiration!) - Date.now()) / 86_400_000;
      assert.ok(days > 13.9 && days < 14.1, `and the other server got the 14 days (got ${days.toFixed(2)})`);
    } finally { await ww2.fake.close(); await second.fake.close(); }
  });
});

/*
 * The same defect reached the staff path, which is how a permanent VIP could be downgraded by an
 * admin adding time to it — the opposite of what "Stack onto existing time" says on the tin.
 */
test("staff stacking days onto permanent VIP extends nothing and destroys nothing", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, buyer } = await scene(base, ctx, token, { fund: 0 });
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const grant = (body: Record<string, unknown>) =>
        jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: buyer.platformId, playerName: buyer.name, comment: "donor", ...body }) });

      await grant({ mode: "permanent" });
      await grant({ mode: "duration", days: 30, cumulative: true });
      assert.equal((await ctx.repo.vips.get(serverId, buyer.platformId))!.expiration, null, "adding time to forever leaves forever");

      // Unticking the box is an explicit replacement, and staff are allowed to make it.
      const set = await grant({ mode: "duration", days: 30, cumulative: false });
      assert.equal(set.status, 200);
      assert.ok((await ctx.repo.vips.get(serverId, buyer.platformId))!.expiration, "a deliberate set still sets");
    } finally {
      fake.close();
    }
  });
});

/*
 * A gift is two transactions, and the second one can fail.
 *
 * `purchase` already answers "the thing you paid for could not be delivered" by refunding
 * visibly; a gift did not, so a credit that failed after the debit committed left the giver short
 * and the recipient unpaid, with the points existing nowhere. Idempotency does not heal that on its
 * own: healing needs a retry carrying the SAME ref, and neither caller has one — the staff route
 * mints a fresh uuid per press, and a re-pressed Discord button is a new interaction id.
 *
 * The repo is wrapped so only the CREDIT leg fails, which is the shape a dropped connection between
 * the two transactions takes.
 */
test("a gift whose credit fails refunds the giver instead of destroying the points", async () => {
  await withServer(async (base, ctx, token) => {
    const { who, pid } = await scene(base, ctx, token, { fund: 500 });
    const friend = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: pid("07"), name: "Giftee" });
    await ctx.repo.externalLinks.set(friend.id, "discord", who("777777777777"), "registration");

    const realApply = ctx.repo.economy.apply.bind(ctx.repo.economy);
    const brokenCredit = {
      ...ctx.repo,
      economy: {
        ...ctx.repo.economy,
        apply: async (entry: any, opts?: any) => {
          if (String(entry.ref ?? "").startsWith("gift-in:")) throw new Error("connection terminated");
          return realApply(entry, opts);
        },
      },
    } as typeof ctx.repo;

    await assert.rejects(
      () => gift(brokenCredit, { fromDiscordId: who("111111111111"), toDiscordId: who("777777777777"), amount: 200, ref: "staff-gift:broken", actorName: "owner" }),
      /could not be delivered/,
    );

    // The giver is whole again, the recipient got nothing, and the ledger says why rather than
    // leaving a bare debit for somebody to puzzle over.
    assert.equal((await ctx.repo.economy.member(who("111111111111")))?.balance, 500, "the giver was made whole");
    assert.equal((await ctx.repo.economy.member(who("777777777777")))?.balance ?? 0, 0, "the recipient got nothing");
    const rows = await ctx.repo.economy.ledger(who("111111111111"), { limit: 5 });
    assert.ok(rows.some((r) => r.ref === "refund:staff-gift:broken" && r.delta === 200), "the refund is a real, readable row");
    assert.ok(rows.some((r) => r.ref === "staff-gift:broken" && r.delta === -200), "so is the debit it answers");
  });
});

/*
 * …but a credit that COMMITTED and only failed to report must not be refunded — that would mint
 * points. The ledger is asked what really happened before anything is undone.
 */
test("a gift whose credit landed before the error is reported as the success it was", async () => {
  await withServer(async (base, ctx, token) => {
    const { who, pid } = await scene(base, ctx, token, { fund: 500 });
    const friend = await ctx.repo.players.upsert({ game: "hll", platform: "steam", platformId: pid("08"), name: "Giftee" });
    await ctx.repo.externalLinks.set(friend.id, "discord", who("888888888888"), "registration");

    const realApply = ctx.repo.economy.apply.bind(ctx.repo.economy);
    const lostAnswer = {
      ...ctx.repo,
      economy: {
        ...ctx.repo.economy,
        apply: async (entry: any, opts?: any) => {
          const out = await realApply(entry, opts);
          // Committed, then the connection dropped on the way back.
          if (String(entry.ref ?? "").startsWith("gift-in:")) throw new Error("connection terminated");
          return out;
        },
      },
    } as typeof ctx.repo;

    const out = await gift(lostAnswer, { fromDiscordId: who("111111111111"), toDiscordId: who("888888888888"), amount: 200, ref: "staff-gift:lost", actorName: "owner" });
    assert.equal(out.status, "ok");
    assert.equal((await ctx.repo.economy.member(who("111111111111")))?.balance, 300, "the giver paid once");
    assert.equal((await ctx.repo.economy.member(who("888888888888")))?.balance, 200, "the recipient kept the gift");
    const rows = await ctx.repo.economy.ledger(who("111111111111"), { limit: 5 });
    assert.ok(!rows.some((r) => r.ref?.startsWith("refund:")), "no refund was invented for a gift that landed");
  });
});

/*
 * The Economy Activity route: one feed across members, the shop's own writes visible in it the
 * moment they happen, gated on the balances read like every member screen.
 */
test("economy activity: the feed lists the movements the shop just made, filtered and gated", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who } = await scene(base, ctx, token, { fund: 1000 });
    // A refunded purchase (dead server) and a staff adjustment — two families in one scene.
    await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dead", host: "127.0.0.1", port: 1, password: "x" }) });
    await jsonFetch(`${base}/api/economy/members/${who("111111111111")}/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: OFFER.id }) });

    const feed = await jsonFetch(`${base}/api/economy/activity?limit=50`, { headers: auth });
    assert.equal(feed.status, 200);
    assert.ok(feed.body.kinds.some((k: { id: string }) => k.id === "purchase"), "the vocabulary rides along for the filter chips");
    const reasons = feed.body.entries.map((e: { reason: string; kind: string }) => `${e.kind}:${e.reason}`);
    assert.ok(reasons.some((r: string) => r.startsWith("refund:refund:")), `the refund is in the feed (${reasons.join(" | ")})`);
    assert.ok(reasons.some((r: string) => r.startsWith("adjust:seed")), "the funding adjustment is in the feed");

    // Kind filter narrows; a typo'd kind is named, not silently emptied.
    const refunds = await jsonFetch(`${base}/api/economy/activity?kind=refund`, { headers: auth });
    assert.ok(refunds.body.entries.length >= 1);
    assert.ok(refunds.body.entries.every((e: { kind: string }) => e.kind === "refund"));
    const typo = await jsonFetch(`${base}/api/economy/activity?kind=purchases`, { headers: auth });
    assert.equal(typo.status, 400);
    assert.match(typo.body.error?.message ?? "", /unknown kind/);

    // Gated: no principal, no feed.
    assert.equal((await jsonFetch(`${base}/api/economy/activity`)).status, 401);
  });
});

/*
 * The actor/member split. Shop presses used to stamp `discord:<member>` as the audit actor, so
 * the System page's machinery rollup grew a one-row "service" per customer. The service is the
 * actor now; the member rides the summaries and their own ledger rows — which also drop the
 * "(by …)" suffix, because a member's own press is not somebody else acting on their balance.
 */
test("a member's press audits as the service and ledgers as themself", async () => {
  await withServer(async (base, ctx, token) => {
    const { auth, who } = await scene(base, ctx, token, { fund: 300 });
    await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dead", host: "127.0.0.1", port: 1, password: "x" }) });
    const out = await purchase(ctx.repo, {
      buyerDiscordId: who("111111111111"), offerId: OFFER.id, ref: "buy:split",
      actorName: "shop", memberName: "BEAST",
    });
    assert.equal(out.status, "refunded");

    const trail = await ctx.repo.audit.list({ limit: 50 });
    const refunded = trail.find((r) => r.action === "vip.purchase_refunded");
    assert.ok(refunded, "the refund is on the record");
    assert.equal(refunded.actorName, "shop", "the SERVICE is the actor — never the customer");
    assert.match(refunded.summary, /BEAST/, "and the member is named in the sentence instead");
    assert.ok(!trail.some((r) => r.actorName.startsWith("discord:")), "no per-member service names minted");

    const debit = await ctx.repo.economy.lastEntryWithRefPrefix(who("111111111111"), "buy:split");
    assert.ok(debit, "the debit row exists");
    assert.equal(debit.actorName, null, "their own press wears no actor on their own ledger");
  });
});
