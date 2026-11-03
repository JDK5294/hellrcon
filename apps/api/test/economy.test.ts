import { test } from "node:test";
import assert from "node:assert/strict";
import { claimPeriod, claimRef, claimPrefix, claimWindow, nextClaimAt, plusOneMonth, rollClaim } from "../dist/economy.js";
import { createRepository } from "@app/db";
import { FakeHllServer } from "./fake-hll-server.ts";
import { withServer, jsonFetch, assertAsked, askedFor } from "./harness.ts";

/*
 * WHICH DAY IT IS depends on where you are standing.
 *
 * The claim period is spelled into the ledger ref, and the ref is the cooldown — so the zone the
 * period is computed in decides what time of day "come back tomorrow" means. Computed in UTC, a
 * community on the American east coast has its daily claim reset at 8pm, in the middle of prime
 * time. Computed in the community's own zone, it resets at midnight where the members live.
 */
test("claim periods follow the COMMUNITY's calendar, not UTC's", () => {
  // 01:30 UTC on the 13th is still the evening of the 12th in New York.
  const lateUtc = new Date("2026-08-13T01:30:00.000Z");
  assert.equal(claimPeriod("daily", lateUtc, "UTC"), "2026-08-13");
  assert.equal(claimPeriod("daily", lateUtc, "America/New_York"), "2026-08-12", "still last night in New York");
  // Which means the two zones hand out DIFFERENT refs for the same instant — the whole point.
  assert.notEqual(claimRef("daily", "42", lateUtc, "America/New_York"), claimRef("daily", "42", lateUtc, "UTC"));

  // Month boundaries move too: 00:30 UTC on the 1st is still last month in New York.
  const monthEdge = new Date("2026-09-01T00:30:00.000Z");
  assert.equal(claimPeriod("monthly", monthEdge, "UTC"), "2026-09");
  assert.equal(claimPeriod("monthly", monthEdge, "America/New_York"), "2026-08");

  // The next opening is that zone's midnight, not UTC's.
  const next = nextClaimAt("daily", new Date("2026-08-12T18:00:00.000Z"), "America/New_York");
  assert.equal(next, "2026-08-13T04:00:00.000Z", "midnight in New York is 04:00 UTC in summer");

  // And across a DST change the day is 23 or 25 hours, which arithmetic on a 24-hour day gets
  // wrong: 2026-11-01 is when the US falls back, so midnight-to-midnight is 25 hours.
  const dstDay = nextClaimAt("daily", new Date("2026-11-01T05:30:00.000Z"), "America/New_York");
  assert.equal(dstDay, "2026-11-02T05:00:00.000Z", "the day after a fall-back still ends at local midnight");

  // A zone the runtime cannot parse falls back rather than throwing at the person claiming.
  assert.equal(claimPeriod("daily", lateUtc, "Mars/Olympus"), "2026-08-13");
});

test("claim periods are calendar periods, spelled into the ref", () => {
  const at = new Date("2026-08-12T23:59:59.000Z");
  assert.equal(claimPeriod("daily", at), "2026-08-12");
  assert.equal(claimPeriod("monthly", at), "2026-08");
  assert.equal(claimRef("daily", "42", at), "claim:daily:42:2026-08-12");
  assert.ok(claimRef("monthly", "42", at).startsWith(claimPrefix("monthly", "42")));
  // One second later is the NEXT day — the ref changes, so the unique index lets the new claim in.
  assert.notEqual(claimRef("daily", "42", at), claimRef("daily", "42", new Date("2026-08-13T00:00:00.000Z")));
});

test("nextClaimAt names the opening instant of the next period, across month and year ends", () => {
  assert.equal(nextClaimAt("daily", new Date("2026-08-12T05:00:00Z")), "2026-08-13T00:00:00.000Z");
  assert.equal(nextClaimAt("daily", new Date("2026-12-31T23:00:00Z")), "2027-01-01T00:00:00.000Z");
  assert.equal(nextClaimAt("monthly", new Date("2026-08-12T05:00:00Z")), "2026-09-01T00:00:00.000Z");
  assert.equal(nextClaimAt("monthly", new Date("2026-12-02T00:00:00Z")), "2027-01-01T00:00:00.000Z");
});

test("rollClaim stays inside the band, covers both ends, and survives an inverted band", () => {
  const band = { enabled: true, min: 15, max: 25 };
  assert.equal(rollClaim(band, () => 0), 15);
  assert.equal(rollClaim(band, () => 0.999999), 25);
  for (let i = 0; i < 200; i++) {
    const n = rollClaim(band);
    assert.ok(n >= 15 && n <= 25 && Number.isInteger(n), `rolled ${n}`);
  }
  // A hand-edited config with min > max pays the smaller number rather than throwing.
  assert.equal(rollClaim({ min: 25, max: 15 }, () => 0), 15);
  assert.equal(rollClaim({ min: 5, max: 5 }, () => 0.5), 5);
});

test("a claim end to end: the ref makes the second same-day claim a no-op", async () => {
  const repo = await createRepository();
  const at = new Date("2026-08-12T10:00:00Z");
  const ref = claimRef("daily", "d9", at);
  const first = await repo.economy.apply({ discordId: "d9", delta: 20, reason: "daily claim", ref });
  const again = await repo.economy.apply({ discordId: "d9", delta: 20, reason: "daily claim", ref });
  assert.equal(first.applied, true);
  assert.equal(again.applied, false);
  assert.equal(again.member.balance, 20, "claimed once, paid once");
  // Tomorrow's ref is a different key, so tomorrow's claim goes through.
  const tomorrow = await repo.economy.apply({ discordId: "d9", delta: 20, reason: "daily claim", ref: claimRef("daily", "d9", new Date("2026-08-13T10:00:00Z")) });
  assert.equal(tomorrow.applied, true);
  assert.equal(tomorrow.member.balance, 40);
});

// ---------------------------------------------------------------------------
// The staff routes: gating, config validation, and the manual adjustment.
// ---------------------------------------------------------------------------

async function login(base: string, u: string, p: string) {
  const r = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

async function owner(base: string): Promise<Record<string, string>> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return login(base, "owner", "pw");
}

test("economy routes are gated on economy.manage", async () => {
  await withServer(async (base, repo) => {
    assert.equal((await jsonFetch(`${base}/api/economy/config`)).status, 401);
    const auth = await owner(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = await login(base, "plain", "pw");
    assert.equal((await jsonFetch(`${base}/api/economy/config`, { headers: plain })).status, 403);
    assert.equal((await jsonFetch(`${base}/api/economy/members`, { headers: plain })).status, 403);
    // An adjustment is asked for, not made.
    assertAsked(await jsonFetch(`${base}/api/economy/members/12345678/adjust`, { method: "POST", headers: plain, body: JSON.stringify({ delta: 5, reason: "x" }) }));
    assert.equal((await repo.economy.member("12345678"))?.balance ?? 0, 0, "no points moved");
    // The owner reads the seeded defaults.
    const cfg = await jsonFetch(`${base}/api/economy/config`, { headers: auth });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.config.currencyName, "Points");
    assert.deepEqual(cfg.body.config.offers, []);
  });
});

/*
 * The settings and the shop are two permissions, and each half of the economy answers to its own.
 * One permission stood for both, the shop's: Economy settings alone could save nothing on its own
 * screen (every save was sent for approval), trim nothing, and was refused the progress of a role
 * reconcile it had started; VIP shop offers could change the rates and the cap, and could not read
 * the document its offers live in.
 */
test("each half of the economy answers to its own permission", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const staff = async (username: string, capability: string, level = "write") => {
      const made = await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
      await jsonFetch(`${base}/api/users/${made.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants: [{ capability, level, scopeType: "global", scopeId: null }] }) });
      return login(base, username, "pw");
    };
    const settings = await staff("settings", "economy.config");
    const shop = await staff("shop", "economy.shop");
    const reader = await staff("reader", "economy.config", "read");
    const offer = { id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [] };
    const doc = async (headers: Record<string, string>) => (await jsonFetch(`${base}/api/economy/config`, { headers })).body.config;
    const put = (headers: Record<string, string>, body: unknown) => jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers, body: JSON.stringify(body) });

    // Both halves read the one document.
    const start = await doc(settings);
    assert.equal(start.currencyName, "Points");
    assert.deepEqual(await doc(shop), start, "the shop reads the document its offers live in");

    // Economy settings saves the settings, the offers sent back as they were...
    assert.equal((await put(settings, { ...start, currencyName: "Gold" })).status, 200);
    assert.equal((await repo.economy.config()).currencyName, "Gold");
    // ...and a change to the offers is asked for, not made.
    assert.equal((await askedFor(base, auth, await put(settings, { ...(await doc(settings)), offers: [offer] }))).capability, "economy.shop");
    assert.deepEqual((await repo.economy.config()).offers, [], "no offer was added");

    // VIP shop offers saves the offers, the settings sent back as they are...
    assert.equal((await put(shop, { ...(await doc(shop)), offers: [offer] })).status, 200);
    assert.equal((await repo.economy.config()).offers.length, 1);
    // ...and a change to the cap is asked for, not made.
    assert.equal((await askedFor(base, auth, await put(shop, { ...(await doc(shop)), balanceCap: 50 }))).capability, "economy.config");
    assert.equal((await repo.economy.config()).balanceCap, null, "the cap is as it was");
    // Changing nothing is still a save, and one only those who may save make.
    assert.equal((await askedFor(base, auth, await put(reader, await doc(reader)))).capability, "economy.config");

    // Trimming to the cap is the cap's (no cap is set, so it is refused on its merits, not filed);
    // the reconcile's progress is read by whoever may start one.
    assert.equal((await jsonFetch(`${base}/api/economy/trim-balances`, { method: "POST", headers: settings })).status, 400);
    assert.equal((await askedFor(base, auth, await jsonFetch(`${base}/api/economy/trim-balances`, { method: "POST", headers: shop }))).capability, "economy.config");
    assert.equal((await jsonFetch(`${base}/api/economy/resync-game-roles/status`, { headers: settings })).status, 200);

    // A stored document today's rules refuse cannot be told apart by halves: a save needs both.
    await repo.economy.setConfig({ currencyName: "" });
    assert.equal((await askedFor(base, auth, await put(settings, { ...(await doc(settings)), currencyName: "Gold" }))).capability, "economy.shop");
    assert.equal((await askedFor(base, auth, await put(shop, { ...(await doc(shop)), currencyName: "Gold" }))).capability, "economy.config");
  });
});

test("config PUT validates offers and claims, and a good write persists + audits", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const good = {
      currencyName: "Gold Coins", balanceCap: 10_000,
      claims: { daily: { enabled: true, min: 15, max: 25, roleIds: [] }, monthly: { enabled: true, min: 475, max: 525, roleIds: ["900000000000000001"] } },
      gifting: { enabled: true, minAmount: 5, maxAmount: 500 }, vipGifting: { enabled: true, roleIds: ["910000000000000001"] },
      registration: { bonusDays: 0, bonusPoints: 100, bonusAllGames: false, gameRoles: { hll: "920000000000000001" } },
      offers: [
        { id: "two_weeks", label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true },
        { id: "month_s1", label: "31 Days #1", points: 450, days: 31, scope: { mode: "servers", serverIds: ["s1"] }, enabled: true },
      ],
    };
    const put = (body: unknown) => jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    // Refusals, each naming its offence: duplicate id, empty server scope, inverted claim band.
    assert.equal((await put({ ...good, offers: [good.offers[0], { ...good.offers[1], id: "two_weeks" }] })).status, 400);
    assert.equal((await put({ ...good, offers: [{ ...good.offers[1], scope: { mode: "servers", serverIds: [] } }] })).status, 400);
    assert.equal((await put({ ...good, claims: { ...good.claims, daily: { enabled: true, min: 30, max: 20 } } })).status, 400);
    // Role gates are Discord ids or nothing: a role NAME here would be accepted by us and then
    // silently match nobody, since what arrives on a press is ids.
    assert.equal((await put({ ...good, claims: { ...good.claims, daily: { ...good.claims.daily, roleIds: ["@boosters"] } } })).status, 400);
    assert.equal((await put({ ...good, claims: { ...good.claims, daily: { ...good.claims.daily, roleIds: "900000000000000001" } } })).status, 400);
    // The VIP-gift gate takes the same rule, and the game-role map refuses what it cannot mean:
    // an unknown game would sit in the config assigning nothing forever, a name is not a role id.
    assert.equal((await put({ ...good, vipGifting: { enabled: true, roleIds: ["@patrons"] } })).status, 400);
    assert.equal((await put({ ...good, registration: { ...good.registration, gameRoles: { quake: "920000000000000001" } } })).status, 400);
    assert.equal((await put({ ...good, registration: { ...good.registration, gameRoles: { hll: "@vets" } } })).status, 400);
    assert.equal((await put({ ...good, currencyName: "" })).status, 400);
    // A gift ceiling under its own floor is nonsense; blank (null) means no ceiling and is fine.
    assert.equal((await put({ ...good, gifting: { enabled: true, minAmount: 50, maxAmount: 10 } })).status, 400);
    assert.equal((await put({ ...good, gifting: { enabled: true, minAmount: 5, maxAmount: null } })).status, 200);

    const ok = await put(good);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.config.currencyName, "Gold Coins");
    assert.equal(ok.body.config.offers.length, 2);
    assert.deepEqual(ok.body.config.offers[1].scope, { mode: "servers", serverIds: ["s1"] });
    // Persisted, not just echoed — and the change is on the audit trail.
    const back = await jsonFetch(`${base}/api/economy/config`, { headers: auth });
    assert.equal(back.body.config.balanceCap, 10_000);
    assert.equal(back.body.config.gifting.maxAmount, 500);
    assert.equal(back.body.config.vipGifting.enabled, true);
    assert.deepEqual(back.body.config.claims.monthly.roleIds, ["900000000000000001"], "the claim's role gate persists");
    assert.deepEqual(back.body.config.claims.daily.roleIds, [], "and an empty gate means everyone");
    assert.deepEqual(back.body.config.vipGifting.roleIds, ["910000000000000001"], "the VIP-gift gate persists");
    assert.deepEqual(back.body.config.registration.gameRoles, { hll: "920000000000000001" }, "the per-game registration role persists");
    // A save that omits gameRoles (an older panel build) keeps the stored map; "" clears one game.
    const noRoles = await put({ ...good, registration: { bonusDays: 0, bonusPoints: 100, bonusAllGames: false } });
    assert.deepEqual(noRoles.body.config.registration.gameRoles, { hll: "920000000000000001" }, "absent is not cleared");
    const cleared = await put({ ...good, registration: { ...good.registration, gameRoles: { hll: "" } } });
    assert.deepEqual(cleared.body.config.registration.gameRoles, {}, "an empty value clears the game's role");
    assert.ok((await repo.audit.list({})).some((a) => a.action === "economy.manage"));
  });
});

test("adjust creates the member, trims at the cap, refuses overdrafts, and audits", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    await jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify({
      currencyName: "Points", balanceCap: 100,
      claims: { daily: { enabled: false, min: 15, max: 25 }, monthly: { enabled: false, min: 475, max: 525 } },
      gifting: { enabled: false, minAmount: 1, maxAmount: null }, vipGifting: { enabled: false }, offers: [],
    }) });
    const adjust = (id: string, body: unknown) =>
      jsonFetch(`${base}/api/economy/members/${id}/adjust`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    // Validation: zero delta, missing reason, non-numeric id.
    assert.equal((await adjust("12345678", { delta: 0, reason: "x" })).status, 400);
    assert.equal((await adjust("12345678", { delta: 5 })).status, 400);
    assert.equal((await adjust("not-an-id", { delta: 5, reason: "x" })).status, 400);

    // "Give the tournament winner 500" with a 100 cap: the member is created and the credit trims.
    const win = await adjust("12345678", { delta: 500, reason: "tournament winner", discordName: "Winner" });
    assert.equal(win.status, 200);
    assert.equal(win.body.entry.delta, 100, "credit trimmed to the cap");
    assert.equal(win.body.member.balance, 100);

    // A debit below zero is refused outright — money never goes negative.
    assert.equal((await adjust("12345678", { delta: -150, reason: "clawback" })).status, 400);

    const audits = (await repo.audit.list({})).filter((a) => a.action === "economy.adjust");
    assert.equal(audits.length, 1);
    assert.equal((audits[0]!.data as { requested: number }).requested, 500);
    assert.equal((audits[0]!.data as { applied: number }).applied, 100);

    // The roster + detail reads see the result; search matches name and id.
    const members = await jsonFetch(`${base}/api/economy/members?q=winn`, { headers: auth });
    assert.equal(members.body.total, 1);
    const byId = await jsonFetch(`${base}/api/economy/members?q=12345678`, { headers: auth });
    assert.equal(byId.body.total, 1);
    const none = await jsonFetch(`${base}/api/economy/members?q=zzz`, { headers: auth });
    assert.equal(none.body.total, 0);
    const detail = await jsonFetch(`${base}/api/economy/members/12345678`, { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.member.balance, 100);
    assert.equal(detail.body.ledger.length, 1);
    assert.equal(detail.body.total, 1);
    // Unlinked so far — the panel renders the "claims and purchases will refuse" hint from this.
    assert.deepEqual(detail.body.players, []);
    assert.equal((await jsonFetch(`${base}/api/economy/members/999999999`, { headers: auth })).status, 404);

    // Link a game account to the member's Discord id: the detail now names it. Plural on purpose —
    // one row per game once a second game exists.
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000077", name: "Winner IG" });
    await repo.externalLinks.set(player.id, "discord", "12345678", "registration");
    const linked = await jsonFetch(`${base}/api/economy/members/12345678`, { headers: auth });
    assert.equal(linked.body.players.length, 1);
    assert.equal(linked.body.players[0].name, "Winner IG");
    assert.equal(linked.body.players[0].platformId, "76561198000000077");
  });
});

/*
 * A GATE POINTED AT THE WRONG DISCORD IS AN INVISIBLE FEATURE.
 *
 * Role ids belong to the server they came from. The VIP panel is read in the PUBLIC server, so a
 * gate naming a role from anywhere else matches nobody — and nothing downstream can notice, because
 * hiding a claim the presser cannot make is the designed behaviour. A misdirected gate and a
 * working gate are drawn identically: no button, no message, no log line.
 *
 * The one moment it is catchable is the save, against the roles that server actually has. And only
 * when Discord positively disproves the id: no token, an outage, the bot not in the server all
 * leave the check unable to prove anything, and an unprovable suspicion must never stand between
 * staff and their settings.
 */
test("a claim gate naming a role the public Discord does not have is refused at save", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  const realFetch = globalThis.fetch;
  // Only Discord is stubbed; the test's own calls to the local API go through the real fetch.
  const stub = (ids: string[] | null) => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes("discord.com")) return realFetch(url, init);
      if (!ids) return new Response("nope", { status: 403 });
      return new Response(JSON.stringify(ids.map((id) => ({ id, name: `role ${id}` }))), { status: 200 });
    }) as typeof fetch;
  };
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      await repo.appConfig.set({ communityGuildId: "222222222222222222" });
      process.env.DISCORD_TOKEN = "bot-token";
      process.env.DISCORD_GUILD_ID = "111111111111111111";
      const base_ = {
        currencyName: "Points", balanceCap: null,
        claims: { daily: { enabled: true, min: 15, max: 25, roleIds: [] }, monthly: { enabled: true, min: 475, max: 525, roleIds: [] } },
        gifting: { enabled: false, minAmount: 1, maxAmount: null }, vipGifting: { enabled: false, roleIds: [] }, offers: [],
      };
      const put = (body: unknown) => jsonFetch(`${base}/api/economy/config`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

      // The public server has one role. A gate on it saves.
      stub(["900000000000000001"]);
      const good = { ...base_, claims: { ...base_.claims, monthly: { ...base_.claims.monthly, roleIds: ["900000000000000001"] } } };
      assert.equal((await put(good)).status, 200);

      // The staff server's TECH SUPPORT role is a perfectly real role — in the wrong server. This
      // is the whole bug: it passes every shape check, saves, and hides the claim from everybody.
      const stray = { ...base_, claims: { ...base_.claims, monthly: { ...base_.claims.monthly, roleIds: ["800000000000000009"] } } };
      const refused = await put(stray);
      assert.equal(refused.status, 400);
      assert.match((refused.body.error as { message: string }).message, /800000000000000009/, "the refusal names the id that will never match");
      assert.match((refused.body.error as { message: string }).message, /monthly claim/, "and which gate it came from");
      // Refused means NOT saved — the stored gate is still the one that works.
      assert.deepEqual((await jsonFetch(`${base}/api/economy/config`, { headers: auth })).body.config.claims.monthly.roleIds, ["900000000000000001"]);

      // Every gate on the screen takes the same check, not just the claims.
      assert.equal((await put({ ...base_, vipGifting: { enabled: true, roleIds: ["800000000000000009"] } })).status, 400);
      // …including a shop offer's, which is the gate most likely to be set from the wrong list:
      // it is copied off a registration role, and those get created in whichever server is open.
      const strayOffer = await put({ ...base_, offers: [{ id: "ww2_2w", label: "WW2-Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: ["800000000000000009"] }] });
      assert.equal(strayOffer.status, 400);
      assert.match((strayOffer.body.error as { message: string }).message, /WW2-Two Weeks/, "the refusal names the offer, not just the id");

      // Discord unreachable: the id cannot be disproved, so the save goes through. An outage must
      // never be the reason staff cannot change their own settings.
      stub(null);
      assert.equal((await put(stray)).status, 200);

      // Same when there is no bot token at all.
      delete process.env.DISCORD_TOKEN;
      stub(["900000000000000001"]);
      assert.equal((await put(stray)).status, 200);
    });
  } finally {
    globalThis.fetch = realFetch;
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});

/*
 * THE STAFF REPAIR PATH RUNS THE GATE TOO.
 *
 * "Their click failed, run it for them" is the reason the staff purchase route exists, and it is
 * also the obvious way to accidentally build a bypass: no roles arrive in a staff request, so the
 * cheapest implementation has none to check and sails through every gate. So the service asks
 * Discord what the RECIPIENT holds — the same predicate the button runs — and when Discord cannot
 * answer, a gated offer refuses rather than guessing.
 */
test("a staff-run purchase checks the recipient's real Discord roles against the offer's gate", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  const realFetch = globalThis.fetch;
  /** Stub only Discord: `roles` null = the member lookup fails (an outage). */
  const stub = (roles: string[] | null) => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes("discord.com")) return realFetch(url, init);
      if (String(url).includes("/members/")) {
        return roles ? new Response(JSON.stringify({ roles, user: { username: "buyer" } }), { status: 200 })
          : new Response("nope", { status: 503 });
      }
      return new Response(JSON.stringify([{ id: WW2_REG, name: "WWII REGISTERED" }]), { status: 200 });
    }) as typeof fetch;
  };
  const WW2_REG = "920000000000000001";
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      process.env.DISCORD_TOKEN = "bot-token";
      process.env.DISCORD_GUILD_ID = "111111111111111111";
      // A real (fake) game server, so the offer that DOES go through has somewhere to land.
      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      await repo.servers.create({ name: "Shop #1", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000401", name: "Buyer" });
      await repo.externalLinks.set(player.id, "discord", "111000111", "test");
      await repo.economy.apply({ discordId: "111000111", delta: 600, reason: "seed" });
      await repo.economy.setConfig({
        offers: [
          { id: "ww2_2w", label: "WW2-Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [WW2_REG] },
          { id: "open_2w", label: "Anyone-Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [] },
        ],
      });
      const buy = (offerId: string) => jsonFetch(`${base}/api/economy/members/111000111/purchase`, {
        method: "POST", headers: auth, body: JSON.stringify({ offerId }),
      });

      // The member does not hold the role: staff running it for them is refused, and pays nothing.
      stub([]);
      const refused = await buy("ww2_2w");
      assert.equal(refused.status, 400);
      assert.match((refused.body.error as { message: string }).message, /not registered for that game/i);
      assert.equal((await repo.economy.member("111000111"))?.balance, 600, "a refused purchase charges nothing");

      // Discord cannot say: a gated offer refuses rather than assuming the best.
      stub(null);
      const blind = await buy("ww2_2w");
      assert.equal(blind.status, 400);
      assert.match((blind.body.error as { message: string }).message, /could not be asked/i);
      assert.equal((await repo.economy.member("111000111"))?.balance, 600, "and still charges nothing");

      // An UNGATED offer is untouched by any of this — no roles are needed, so an outage or a
      // missing token must not stop the shop working.
      stub(null);
      assert.equal((await buy("open_2w")).status, 200);
      assert.equal((await repo.economy.member("111000111"))?.balance, 350, "600 − 250");
    });
  } finally {
    (fake as FakeHllServer | null)?.close();
    globalThis.fetch = realFetch;
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});

/*
 * The member's ledger and the activity feed carry, beside a VIP purchase, what it landed as on each
 * server — the Economy screen shows it under the purchase's line.
 */
test("a VIP purchase's ledger row carries when its days start and when the VIP ends, in the member's ledger and the activity feed", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const server = await repo.servers.create({ name: "Shop #1", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000402", name: "Buyer" });
      await repo.externalLinks.set(player.id, "discord", "111000222", "test");
      await repo.economy.apply({ discordId: "111000222", delta: 600, reason: "seed" });
      await repo.economy.setConfig({ offers: [{ id: "open_2w", label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: true, roleIds: [] }] });
      const before = Date.now();
      const buy = await jsonFetch(`${base}/api/economy/members/111000222/purchase`, { method: "POST", headers: auth, body: JSON.stringify({ offerId: "open_2w" }) });
      assert.equal(buy.status, 200);
      const end = (await repo.vips.get(server.id, "76561198000000402"))!.expiration!;
      const expected = [{
        serverId: server.id, serverName: "Shop #1", playerId: "76561198000000402",
        from: new Date(Date.parse(end) - 14 * 86_400_000).toISOString(), until: end, held: false,
      }];
      assert.ok(Date.parse(expected[0]!.from) >= before - 5, "the days start when they were bought");
      const detail = await jsonFetch(`${base}/api/economy/members/111000222`, { headers: auth });
      assert.equal(detail.body.ledger.length, 2);
      assert.deepEqual(detail.body.ledger[0].vip, expected, "the purchase, newest first, with its dates");
      assert.equal(detail.body.ledger[1].vip, undefined, "the seed is not a purchase");
      const feed = await jsonFetch(`${base}/api/economy/activity?kind=purchase`, { headers: auth });
      assert.equal(feed.body.entries.length, 1);
      assert.deepEqual(feed.body.entries[0].vip, expected, "the activity feed says the same");
    });
  } finally {
    (fake as FakeHllServer | null)?.close();
  }
});

/*
 * THE GATE EXPLAINS ITSELF.
 *
 * A refused gate is silent by design — a claim you cannot make is absent, not greyed out. That is
 * right for members and blinding for staff, because "switched off", "pointed at a role nobody here
 * holds" and "working exactly as intended" are all drawn as the same empty space. The only way to
 * tell them apart was to hand somebody a role and go look in Discord.
 *
 * So the check runs the real gate against a real member's real roles and says which of those it is.
 */
test("gate-check says which claims a member would see, and why not for the rest", async () => {
  const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
  const realFetch = globalThis.fetch;
  const GUILD = "222222222222222222";
  const TECH = "500000000000000003";   // a role of THIS server, which the member holds
  const PATRON = "900000000000000002";  // a role of this server, which they do not
  const STRAY = "800000000000000009";   // a real role — of a DIFFERENT server
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("discord.com")) return realFetch(url, init);
    if (u.includes("/members/")) {
      return new Response(JSON.stringify({ roles: [TECH], user: { username: "kreitz" } }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { id: GUILD, name: "@everyone" }, { id: TECH, name: "TECH SUPPORT" }, { id: PATRON, name: "Patron" },
    ]), { status: 200 });
  }) as typeof fetch;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      await repo.appConfig.set({ communityGuildId: GUILD });
      process.env.DISCORD_TOKEN = "bot-token";
      process.env.DISCORD_GUILD_ID = "111111111111111111";
      await repo.economy.setConfig({
        claims: {
          daily: { enabled: true, min: 15, max: 25, roleIds: [] },          // ungated
          monthly: { enabled: true, min: 475, max: 525, roleIds: [TECH] },  // gated on what they hold
        },
        vipGifting: { enabled: true, roleIds: [PATRON] },                   // gated on what they do not
      });

      const r = await jsonFetch(`${base}/api/economy/gate-check?discordId=555000555000555000`, { headers: auth });
      assert.equal(r.status, 200);
      assert.equal(r.body.member.found, true);
      assert.equal(r.body.member.name, "kreitz");
      const by = Object.fromEntries((r.body.checks as any[]).map((c) => [c.key, c]));
      assert.equal(by.daily.verdict, "ungated");
      assert.equal(by.daily.wouldShow, true);
      assert.equal(by.monthly.verdict, "allowed", "they hold the gate role, so the button is drawn");
      assert.equal(by.monthly.wouldShow, true);
      assert.equal(by.vipGifting.verdict, "lacks-role");
      assert.equal(by.vipGifting.wouldShow, false);
      // The role names come back resolved — nobody should have to read an id to understand this.
      assert.equal(by.monthly.required[0].name, "TECH SUPPORT");
      assert.equal(by.monthly.required[0].inGuild, true);

      // Switched off outranks the gate: the reason it is hidden is the switch, not the roles.
      await repo.economy.setConfig({ claims: { daily: { enabled: true, min: 15, max: 25, roleIds: [] }, monthly: { enabled: false, min: 475, max: 525, roleIds: [TECH] } } });
      const off = await jsonFetch(`${base}/api/economy/gate-check?discordId=555000555000555000`, { headers: auth });
      const monthlyOff = (off.body.checks as any[]).find((c) => c.key === "monthly");
      assert.equal(monthlyOff.enabled, false);
      assert.equal(monthlyOff.wouldShow, false, "an off claim is hidden however good the roles are");

      // And the misdirected gate is called out for what it is: a role of some OTHER server, which
      // nobody here can ever hold, so the feature is off for everybody with no message anywhere.
      await repo.economy.setConfig({ claims: { daily: { enabled: true, min: 15, max: 25, roleIds: [] }, monthly: { enabled: true, min: 475, max: 525, roleIds: [STRAY] } } });
      const stray = await jsonFetch(`${base}/api/economy/gate-check?discordId=555000555000555000`, { headers: auth });
      const monthlyStray = (stray.body.checks as any[]).find((c) => c.key === "monthly");
      assert.equal(monthlyStray.required[0].inGuild, false, "not a role of this server");
      assert.equal(monthlyStray.wouldShow, false);

      // A junk id is refused before anything is asked of Discord.
      assert.equal((await jsonFetch(`${base}/api/economy/gate-check?discordId=nope`, { headers: auth })).status, 400);
    });
  } finally {
    globalThis.fetch = realFetch;
    if (DISCORD_TOKEN === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = DISCORD_TOKEN;
    if (DISCORD_GUILD_ID === undefined) delete process.env.DISCORD_GUILD_ID; else process.env.DISCORD_GUILD_ID = DISCORD_GUILD_ID;
  }
});

/*
 * THE BOOST-AND-ROLLOVER DOUBLE CLAIM.
 *
 * Monthly used to be a shared calendar month: everyone's reset on the 1st, together. That is a
 * published schedule, and it can be read as an instruction — boost on the 30th, claim the month
 * that is nearly over, wait two days for the rollover, claim again. Two payouts for one month of
 * boosting, repeatable every time, and the ledger would show both as legitimate.
 *
 * So monthly is a per-MEMBER cooldown: the clock starts when THEY last claimed. Daily deliberately
 * stays a shared calendar day — everyone's turning over at midnight together is what "the daily"
 * means, and catching 23:58 and 00:02 is two days, not an exploit.
 */
test("monthly is a per-member month, so claiming near the rollover cannot pay twice", () => {
  const tz = "America/New_York";
  const boostDay = new Date("2026-08-30T18:00:00.000Z");

  // The old exploit, replayed: claim on the 30th, come back on the 1st.
  const first = claimWindow("monthly", "d1", null, boostDay, tz);
  assert.equal(first.ready, true, "never claimed, so it is open");
  const secondOfSeptember = new Date("2026-09-01T18:00:00.000Z");
  const after = claimWindow("monthly", "d1", boostDay.toISOString(), secondOfSeptember, tz);
  assert.equal(after.ready, false, "two days is not a month, whatever the calendar rolled over to");
  assert.equal(after.nextAt, "2026-09-30T18:00:00.000Z", "a month from THEIR claim, not from the 1st");

  // A month later to the hour: open again. Not a day early…
  assert.equal(claimWindow("monthly", "d1", boostDay.toISOString(), new Date("2026-09-29T18:00:00.000Z"), tz).ready, false);
  assert.equal(claimWindow("monthly", "d1", boostDay.toISOString(), new Date("2026-09-30T18:00:00.000Z"), tz).ready, true);

  // Short months clamp instead of overflowing into March: Jan 31 + a month is Feb 28.
  assert.equal(plusOneMonth("2026-01-31T12:00:00.000Z"), "2026-02-28T12:00:00.000Z");
  assert.equal(plusOneMonth("2028-01-31T12:00:00.000Z"), "2028-02-29T12:00:00.000Z", "and Feb 29 in a leap year");
  assert.equal(plusOneMonth("2026-12-15T12:00:00.000Z"), "2027-01-15T12:00:00.000Z", "across the year end");

  // The ref advances only when a claim LANDS, so two simultaneous presses build the same string and
  // the ledger's unique index refuses the second — the check above is for the message, not the money.
  const a = claimWindow("monthly", "d1", boostDay.toISOString(), new Date("2026-10-05T00:00:00.000Z"), tz);
  const b = claimWindow("monthly", "d1", boostDay.toISOString(), new Date("2026-10-05T00:00:01.000Z"), tz);
  assert.equal(a.ref, b.ref, "same last claim, same ref — a race cannot pay twice");
  assert.notEqual(a.ref, claimWindow("monthly", "d1", "2026-10-05T00:00:00.000Z", new Date("2026-11-06T00:00:00.000Z"), tz).ref);

  // DAILY is untouched: still the shared calendar day, still resetting for everyone at midnight.
  const lateEvening = new Date("2026-08-12T23:58:00-04:00");
  const justAfterMidnight = new Date("2026-08-13T00:02:00-04:00");
  assert.equal(claimWindow("daily", "d1", lateEvening.toISOString(), justAfterMidnight, tz).ready, true,
    "a new day is a new claim, four minutes later — that is the daily working");
  assert.equal(claimWindow("daily", "d1", justAfterMidnight.toISOString(), justAfterMidnight, tz).ready, false);
});

/*
 * GROUP GRANTS: one action credits every member of a player group. Members are game accounts and
 * balances are Discord accounts, so each member resolves through their link — no link is a skip
 * with the reason on the receipt, and two game accounts on one Discord are one PERSON, paid once.
 */
test("group economy grant: linked members credited once per person, the rest skipped with reasons", async () => {
  await withServer(async (base, repo) => {
    await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "grp-eco-owner", password: "pw" }) });
    const l = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "grp-eco-owner", password: "pw" }) });
    const auth = { authorization: `Bearer ${l.body.token as string}` };

    const created = await jsonFetch(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Eco Winners" }) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const gid = created.body.group.id as string;
    const ids = ["76561199100000001", "76561199100000002", "76561199100000003"];
    for (const pid of ids) {
      await jsonFetch(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: pid }) });
    }
    // One linked member, one unlinked, and a second game account on the SAME Discord.
    const a = await repo.players.upsert({ game: "hll", platform: "steam", platformId: ids[0]!, name: "Linked" });
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: ids[1]!, name: "Unlinked" });
    const c = await repo.players.upsert({ game: "hllv", platform: "steam", platformId: ids[2]!, name: "SameHuman" });
    await repo.externalLinks.set(a.id, "discord", "555000111222333", "registration");
    await repo.externalLinks.set(c.id, "discord", "555000111222333", "registration");

    const url = `${base}/api/economy/groups/${gid}/adjust`;
    assert.equal((await jsonFetch(url, { method: "POST", headers: auth, body: JSON.stringify({ delta: 0, reason: "x" }) })).status, 400);
    assert.equal((await jsonFetch(url, { method: "POST", headers: auth, body: JSON.stringify({ delta: 100 }) })).status, 400, "a reason is required");
    assert.equal((await jsonFetch(`${base}/api/economy/groups/00000000-0000-4000-8000-0000000000ec/adjust`, { method: "POST", headers: auth, body: JSON.stringify({ delta: 100, reason: "x" }) })).status, 404);

    const r = await jsonFetch(url, { method: "POST", headers: auth, body: JSON.stringify({ delta: 250, reason: "event prize" }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const applied = r.body.applied as { playerId: string; applied: number; balance: number }[];
    const skipped = r.body.skipped as { playerId: string; reason: string }[];
    assert.deepEqual(applied.map((x) => x.playerId), [ids[0]], "exactly the linked member, once");
    assert.equal(applied[0]!.applied, 250);
    assert.equal(applied[0]!.balance, 250);
    assert.equal(skipped.length, 2);
    assert.match(skipped.find((x) => x.playerId === ids[1])!.reason, /no Discord link/);
    assert.match(skipped.find((x) => x.playerId === ids[2])!.reason, /same Discord account/);

    // A second grant stacks — the ledger is ordinary economy rows, cap and all.
    const again = await jsonFetch(url, { method: "POST", headers: auth, body: JSON.stringify({ delta: -50, reason: "correction" }) });
    assert.equal(again.status, 200);
    assert.equal((again.body.applied as { balance: number }[])[0]!.balance, 200);

    // The permission is economy.balances write — player.groups alone grants nothing here; it asks.
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "grp-eco-plain", password: "pw" }) });
    const pl = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "grp-eco-plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${pl.body.token as string}` };
    assertAsked(await jsonFetch(url, { method: "POST", headers: plain, body: JSON.stringify({ delta: 100, reason: "x" }) }));
    assert.equal((await repo.economy.member("555000111222333"))?.balance, 200, "no points moved");
  });
});
