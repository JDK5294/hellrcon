/**
 * The payout engine's rules, each pinned by the failure it prevents. This is money and VIP at
 * bulk scale — every test here is a support ticket that should never get filed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  duplicateKey, recipientKey, resolveRecipients, validateExecution, windowMinutes,
  type PayoutCandidate,
} from "../dist/index.js";

const linked = (n: string, extra: Partial<PayoutCandidate> = {}): PayoutCandidate =>
  ({ discordId: `d-${n}`, playerId: `p-${n}`, displayName: n, ...extra });
const unlinked = (n: string, extra: Partial<PayoutCandidate> = {}): PayoutCandidate =>
  ({ discordId: null, playerId: `p-${n}`, displayName: n, ...extra });

test("currency reaches linked users only, whatever audience the caller claims", () => {
  // "everyone" must not widen currency: an unlinked player has no balance row to credit, so the
  // rule lives in the engine rather than trusting each surface to remember it.
  const r = resolveRecipients([linked("Ana"), unlinked("Bob")], { kind: "currency", audience: "everyone" });
  assert.deepEqual(r.recipients.map((x) => x.displayName), ["Ana"]);
  assert.equal(r.dropped.unlinked, 1, "and the drop is counted, not silent");
});

test("VIP honours the audience: everyone, linked, or role", () => {
  const cands = [
    linked("Ana", { roleIds: ["r1"] }),
    linked("Bob", { roleIds: [] }),
    unlinked("Cid", { roleIds: [] }),
  ];
  assert.equal(resolveRecipients(cands, { kind: "vip", audience: "everyone" }).recipients.length, 3);
  assert.equal(resolveRecipients(cands, { kind: "vip", audience: "linked" }).recipients.length, 2);
  const role = resolveRecipients(cands, { kind: "vip", audience: "role", roleId: "r1" });
  assert.deepEqual(role.recipients.map((x) => x.displayName), ["Ana"]);
  assert.equal(role.dropped.noRole, 1);
  assert.equal(role.dropped.unlinked, 1, "a role is a Discord attribute, so role implies linked");
});

test("unreadable roles refuse the resolve rather than shrinking the list", () => {
  // "Discord was down" must never be read as "they held no role" — the exact mistake the guild
  // lookup's three-outcome shape exists to prevent, kept intact here.
  assert.throws(
    () => resolveRecipients([linked("Ana", { roleIds: null })], { kind: "vip", audience: "role", roleId: "r1" }),
    /could not read Discord roles/,
  );
});

test("a VIP recipient with no game account is dropped: there is nowhere to land the grant", () => {
  const r = resolveRecipients(
    [{ discordId: "d-x", playerId: null, displayName: "GhostLink" }, linked("Ana")],
    { kind: "vip", audience: "linked" },
  );
  assert.deepEqual(r.recipients.map((x) => x.displayName), ["Ana"]);
  assert.equal(r.dropped.noGameAccount, 1);
});

test("one person is one recipient, however many accounts point at them", () => {
  // Two game accounts on one Discord (one per game) must not be paid twice; and when the same
  // person arrives once unlinked (roster) and once linked (directory), the merged row keeps
  // both ids.
  const r = resolveRecipients([
    { discordId: "d-1", playerId: "p-hll", displayName: "Ana" },
    { discordId: "d-1", playerId: "p-viet", displayName: "Ana" },
  ], { kind: "currency", audience: "linked" });
  assert.equal(r.recipients.length, 1);

  const merged = resolveRecipients([
    { discordId: null, playerId: "p-1", displayName: "Ana (in game)" },
    { discordId: "d-1", playerId: "p-1", displayName: "Ana" },
  ], { kind: "vip", audience: "everyone" });
  // Different keys (p: vs d:) — the unlinked sighting stands alone, which is correct for
  // "everyone": the engine cannot know p-1 belongs to d-1 unless the caller says so by giving
  // the candidate both ids in one row. Callers that know the link pass it.
  assert.equal(merged.recipients.length, 2);
});

test("manual removals and the minutes floor are applied, and both are counted", () => {
  const r = resolveRecipients(
    [linked("Ana", { minutes: 45 }), linked("Bob", { minutes: 45 }), linked("Cid", { minutes: 5 })],
    { kind: "currency", audience: "linked", minMinutes: 20, removedKeys: [recipientKey({ discordId: "d-Bob", playerId: "p-Bob" })] },
  );
  assert.deepEqual(r.recipients.map((x) => x.displayName), ["Ana"]);
  assert.equal(r.dropped.removed, 1);
  assert.equal(r.dropped.underMinutes, 1, "ninety seconds to collect is exactly what the floor is for");
});

test("window minutes count only the overlap, and sum split sessions", () => {
  const mins = windowMinutes([
    // Around the whole window: only the window's two hours count.
    { playerId: "p-1", connectedAt: "2026-08-21T16:00:00Z", disconnectedAt: "2026-08-21T23:00:00Z" },
    // Two visits inside it: 30 + 40.
    { playerId: "p-2", connectedAt: "2026-08-21T18:00:00Z", disconnectedAt: "2026-08-21T18:30:00Z" },
    { playerId: "p-2", connectedAt: "2026-08-21T19:00:00Z", disconnectedAt: "2026-08-21T19:40:00Z" },
    // Entirely before it: zero, and absent rather than zero.
    { playerId: "p-3", connectedAt: "2026-08-21T10:00:00Z", disconnectedAt: "2026-08-21T11:00:00Z" },
  ], "2026-08-21T18:00:00Z", "2026-08-21T20:00:00Z");
  assert.equal(mins.get("p-1"), 120);
  assert.equal(mins.get("p-2"), 70);
  assert.equal(mins.has("p-3"), false);
});

test("the duplicate key is order-blind and server-aware for VIP only", () => {
  const base = { sourceType: "online" as const, sourceRef: "srv-1", amount: 30 };
  const ab = [{ discordId: "d-a", playerId: null }, { discordId: "d-b", playerId: null }];
  const ba = [...ab].reverse();
  assert.equal(
    duplicateKey({ ...base, kind: "vip", serverIds: ["s2", "s1"], recipients: ab }),
    duplicateKey({ ...base, kind: "vip", serverIds: ["s1", "s2"], recipients: ba }),
    "the same payout in a different order is the same payout",
  );
  assert.notEqual(
    duplicateKey({ ...base, kind: "vip", serverIds: ["s1"], recipients: ab }),
    duplicateKey({ ...base, kind: "vip", serverIds: ["s2"], recipients: ab }),
    "VIP on a different server is a different payout",
  );
  assert.equal(
    duplicateKey({ ...base, kind: "currency", serverIds: ["s1"], recipients: ab }),
    duplicateKey({ ...base, kind: "currency", serverIds: ["s2"], recipients: ab }),
    "currency is community-wide, so the server list must not split its identity",
  );
});

test("validateExecution refuses what cannot succeed, whole and with a reason", () => {
  const ana = { discordId: "d-a", playerId: "p-a", displayName: "Ana", sourceName: null, minutes: null };
  const ok = { kind: "currency" as const, amount: 100, serverIds: [], recipients: [ana], previewReady: true };
  validateExecution(ok); // the happy path must not throw
  assert.throws(() => validateExecution({ ...ok, previewReady: false }), /preview/i);
  assert.throws(() => validateExecution({ ...ok, recipients: [] }), /no eligible/i);
  assert.throws(() => validateExecution({ ...ok, amount: 0 }), /whole number above zero/i);
  assert.throws(() => validateExecution({ ...ok, amount: 2.5 }), /whole number/i);
  assert.throws(() => validateExecution({ kind: "vip", amount: 7, serverIds: [], recipients: [ana], previewReady: true }), /at least one server/i);
  assert.throws(
    () => validateExecution({ ...ok, recipients: [{ ...ana, discordId: null }] }),
    /no Discord link/i,
    "belt and braces: even a tampered recipient list cannot push currency at the unlinked",
  );
  assert.throws(
    () => validateExecution({ kind: "vip", amount: 7, serverIds: ["s1"], recipients: [{ ...ana, playerId: null }], previewReady: true }),
    /no game account/i,
  );
});

/* --------------------------------- event boundary resolution -------------------------------- */

import { resolveEventBoundaries, validateEventSchedule, type PayoutEventBounds } from "../dist/index.js";

/** A tiny match calendar: rounds as [startedAt, endedAt|null], answering the two lookups the
 *  way the real store does — earliest start >= iso, earliest END >= iso among finished rounds. */
function calendar(rounds: [string, string | null][]) {
  return {
    firstMatchStartedAtOrAfter: (iso: string) => {
      const hits = rounds.filter(([s]) => Date.parse(s) >= Date.parse(iso)).map(([s]) => s).sort();
      return hits[0] ?? null;
    },
    firstMatchEndedAtOrAfter: (iso: string) => {
      const hits = rounds.filter((r): r is [string, string] => r[1] != null && Date.parse(r[1]) >= Date.parse(iso)).map(([, e]) => e).sort();
      return hits[0] ?? null;
    },
  };
}

const scheduled = (over: Partial<PayoutEventBounds> = {}): PayoutEventBounds => ({
  status: "scheduled",
  openMode: "at", openAnchor: "2026-08-21T20:00:00.000Z", openedAt: null,
  closeMode: "at", closeAnchor: "2026-08-21T23:00:00.000Z", closedAt: null,
  ...over,
});

test("a hard-time boundary resolves to the ANCHOR, not the sweep time", async () => {
  // The poller waking 40 minutes late must not shrink the window: sessions were recorded all
  // along, so the boundary is where it was scheduled, not where the sweep happened to run.
  const t = await resolveEventBoundaries(scheduled(), "2026-08-21T20:40:00Z", calendar([]));
  assert.deepEqual(t, { openedAt: "2026-08-21T20:00:00.000Z" });
  assert.equal(await resolveEventBoundaries(scheduled(), "2026-08-21T19:59:00Z", calendar([])), null, "and not a second early");
});

test("match_start_after opens at the first round starting AT/after the anchor", async () => {
  // An 8pm event must not slice into the round already underway at 8pm.
  const cal = calendar([
    ["2026-08-21T19:30:00.000Z", "2026-08-21T20:20:00.000Z"], // underway at 8pm — skipped
    ["2026-08-21T20:22:00.000Z", null],                        // the first NEW round
  ]);
  const t = await resolveEventBoundaries(scheduled({ openMode: "match_start_after" }), "2026-08-21T20:30:00Z", cal);
  assert.deepEqual(t, { openedAt: "2026-08-21T20:22:00.000Z" });
  const empty = await resolveEventBoundaries(scheduled({ openMode: "match_start_after" }), "2026-08-21T20:30:00Z",
    calendar([["2026-08-21T19:30:00.000Z", null]]));
  assert.equal(empty, null, "no new round yet = still waiting, however late the clock runs");
});

test("match_end_after closes when the round being played at closing time finishes", async () => {
  const cal = calendar([
    ["2026-08-21T22:40:00.000Z", "2026-08-21T23:25:00.000Z"], // straddles 11pm; its END is the boundary
  ]);
  const ev = scheduled({ status: "open", openedAt: "2026-08-21T20:00:00.000Z", closeMode: "match_end_after" });
  const t = await resolveEventBoundaries(ev, "2026-08-21T23:30:00Z", cal);
  assert.deepEqual(t, { closedAt: "2026-08-21T23:25:00.000Z" });
  const still = await resolveEventBoundaries(ev, "2026-08-21T23:30:00Z", calendar([["2026-08-21T22:40:00.000Z", null]]));
  assert.equal(still, null, "the straddling round is unfinished: the event stays open for it");
});

test("one late sweep opens AND closes an event nobody was watching", async () => {
  // The retroactive case decision 3 exists for: the worker slept through the whole event, and a
  // single transition resolves both boundaries exactly as they would have resolved live.
  const cal = calendar([
    ["2026-08-21T20:05:00.000Z", "2026-08-21T20:55:00.000Z"],
    ["2026-08-21T22:50:00.000Z", "2026-08-21T23:40:00.000Z"],
  ]);
  const ev = scheduled({ openMode: "match_start_after", closeMode: "match_end_after" });
  const t = await resolveEventBoundaries(ev, "2026-08-22T09:00:00Z", cal);
  assert.deepEqual(t, { openedAt: "2026-08-21T20:05:00.000Z", closedAt: "2026-08-21T23:40:00.000Z" });
});

test("a close boundary is clamped to no earlier than the open", async () => {
  // No round started until after the close anchor: the window closes empty instead of negative.
  const cal = calendar([["2026-08-21T23:30:00.000Z", "2026-08-22T00:15:00.000Z"]]);
  const ev = scheduled({ openMode: "match_start_after" }); // close 'at' 23:00 < open 23:30
  const t = await resolveEventBoundaries(ev, "2026-08-22T01:00:00Z", cal);
  assert.deepEqual(t, { openedAt: "2026-08-21T23:30:00.000Z", closedAt: "2026-08-21T23:30:00.000Z" });
});

test("closed and cancelled events never transition again", async () => {
  const done = scheduled({ status: "closed", openedAt: "2026-08-21T20:00:00.000Z", closedAt: "2026-08-21T23:00:00.000Z" });
  assert.equal(await resolveEventBoundaries(done, "2026-08-22T09:00:00Z", calendar([])), null);
  assert.equal(await resolveEventBoundaries(scheduled({ status: "cancelled" }), "2026-08-22T09:00:00Z", calendar([])), null);
});

test("validateEventSchedule refuses backwards and zero-width hard windows", () => {
  const base = { openMode: "at" as const, openAnchor: "2026-08-21T20:00:00Z", closeMode: "at" as const, closeAnchor: "2026-08-21T23:00:00Z" };
  validateEventSchedule(base); // a past window is legal — retroactive payout is a feature
  assert.throws(() => validateEventSchedule({ ...base, closeAnchor: "2026-08-21T19:00:00Z" }), /before the open/i);
  assert.throws(() => validateEventSchedule({ ...base, closeAnchor: base.openAnchor }), /zero minutes/i);
  // equal anchors under match modes are a real shape: "the first round after 8pm", opened and closed
  validateEventSchedule({ ...base, openMode: "match_start_after", closeMode: "match_end_after", closeAnchor: base.openAnchor });
  assert.throws(() => validateEventSchedule({ ...base, openAnchor: "not a time" }), /not a time/i);
});

test("sweepPayoutEvents materialises the roster at close, open sessions included", async () => {
  // The player still connected at the whistle has no disconnect row yet — only clipping the open
  // sessions into the window keeps them; only materialising at all lets the event outlive trim.
  const { sweepPayoutEvents } = await import("../dist/index.js");
  const ev = {
    id: "ev1", serverId: "s1", status: "open" as const,
    openMode: "at" as const, openAnchor: "2026-08-21T20:00:00.000Z", openedAt: "2026-08-21T20:00:00.000Z",
    closeMode: "at" as const, closeAnchor: "2026-08-21T22:00:00.000Z", closedAt: null,
  };
  const applied: any[] = [];
  const store = {
    payoutEvents: {
      pending: async () => [ev],
      applyTransition: async (id: string, t: unknown) => { applied.push([id, t]); },
    },
    matches: {
      firstStartedAfter: async () => null,
      firstEndedAfter: async () => null,
    },
    sessions: {
      inWindow: async () => [
        { playerId: "pl-a", connectedAt: "2026-08-21T20:00:00.000Z", disconnectedAt: "2026-08-21T21:30:00.000Z" },
      ],
      openOnServer: async () => new Map([["pl-b", "2026-08-21T21:00:00.000Z"]]), // still on at close
    },
    players: {
      findByIds: async (ids: string[]) => ids.map((id) => ({ id, name: id === "pl-a" ? "Ana" : null, platformId: `pf-${id}` })),
    },
  };
  const res = await sweepPayoutEvents(store, "2026-08-21T22:05:00.000Z");
  assert.deepEqual(res, { opened: 0, closed: 1 });
  const [id, t] = applied[0];
  assert.equal(id, "ev1");
  assert.equal(t.closedAt, "2026-08-21T22:00:00.000Z");
  assert.deepEqual(t.roster, [
    { playerId: "pl-a", name: "Ana", minutes: 90 },
    { playerId: "pl-b", name: "pf-pl-b", minutes: 60 }, // 21:00 → clipped at the 22:00 close
  ]);
});

test("an event's span is bounded — the window is read as raw session intervals, not sampled", async () => {
  // Unbounded, {open: 2020, close: 2030} asked the API to fold every session a server ever
  // recorded. A quarter covers a season; past it the honest answer is "narrow it", never a
  // truncated list of who gets paid.
  const { MAX_WINDOW_DAYS } = await import("../dist/index.js");
  const at = (iso: string) => ({ openMode: "at" as const, openAnchor: "2026-08-21T20:00:00Z", closeMode: "at" as const, closeAnchor: iso });
  validateEventSchedule(at("2026-11-01T20:00:00Z")); // 72 days — fine
  assert.throws(() => validateEventSchedule(at("2036-08-21T20:00:00Z")), /at most 92 days/);
  assert.equal(MAX_WINDOW_DAYS, 92);
  // The boundary itself is legal, and one day past it is not.
  const open = Date.parse("2026-08-21T20:00:00Z");
  validateEventSchedule(at(new Date(open + MAX_WINDOW_DAYS * 86_400_000).toISOString()));
  assert.throws(() => validateEventSchedule(at(new Date(open + (MAX_WINDOW_DAYS + 1) * 86_400_000).toISOString())), /at most 92 days/);
});

test("an event that never finds its close boundary closes at the maximum span", async () => {
  // A match_end_after event on a server that then runs no rounds has nothing to resolve against,
  // so it stayed open forever — and an open event's window is [openedAt, now], which grows
  // without limit under every read. The safety close bounds every window by construction, and
  // closes with a real roster rather than leaving the event stuck until somebody cancels it.
  const { MAX_WINDOW_MS } = await import("../dist/index.js");
  const openedAt = "2026-05-01T20:00:00.000Z";
  const ev = scheduled({ status: "open", openedAt, closeMode: "match_end_after", closeAnchor: "2026-05-01T23:00:00.000Z" });
  const noRounds = calendar([]);

  // A day later, still open: nothing has changed and nothing is forced.
  assert.equal(await resolveEventBoundaries(ev, "2026-05-02T20:00:00Z", noRounds), null);
  // One tick before the cap, still open.
  const cap = Date.parse(openedAt) + MAX_WINDOW_MS;
  assert.equal(await resolveEventBoundaries(ev, new Date(cap - 1000).toISOString(), noRounds), null);
  // At the cap it closes, AT the cap — not at whenever the sweep happened to notice.
  const t = await resolveEventBoundaries(ev, new Date(cap + 5 * 86_400_000).toISOString(), noRounds);
  assert.deepEqual(t, { closedAt: new Date(cap).toISOString() });

  // A real boundary still wins over the safety close: the round that ends inside the span closes
  // it, and the cap never comes into play.
  const ended = await resolveEventBoundaries(ev, new Date(cap + 5 * 86_400_000).toISOString(),
    calendar([["2026-05-01T22:40:00.000Z", "2026-05-01T23:25:00.000Z"]]));
  assert.deepEqual(ended, { closedAt: "2026-05-01T23:25:00.000Z" });
});

test("role tiers: first matching tier decides the amount, and order is priority", () => {
  const cands = [
    linked("Booster", { roleIds: ["r-boost", "r-member"] }), // holds both — the FIRST tier wins
    linked("Member", { roleIds: ["r-member"] }),
    linked("Base", { roleIds: ["r-member", "r-other"] }),
    linked("Outsider", { roleIds: ["r-other"] }),
    unlinked("Ghost", { roleIds: [] }),
  ];
  const r = resolveRecipients(cands, {
    kind: "currency", audience: "linked",
    tiers: [{ roleId: "r-boost", amount: 100 }, { roleId: "r-member", amount: null }],
  });
  assert.deepEqual(
    r.recipients.map((x) => [x.displayName, x.amount, x.tierRoleId]).sort(),
    [["Base", null, "r-member"], ["Booster", 100, "r-boost"], ["Member", null, "r-member"]],
    "the booster gets the booster rate; null means the base amount; the tier's role rides along",
  );
  assert.equal(r.dropped.noRole, 1, "no tier role, no payout — tiers are a restriction");
  assert.equal(r.dropped.unlinked, 1, "roles are a Discord fact, so tiers imply linked");
});

test("role tiers refuse unreadable roles rather than shrinking the list", () => {
  assert.throws(
    () => resolveRecipients([linked("Ana", { roleIds: null })], {
      kind: "currency", audience: "linked", tiers: [{ roleId: "r1", amount: 5 }],
    }),
    /could not read Discord roles/,
  );
});

test("role tiers take over from the audience, and change the duplicate key", () => {
  // With tiers present the audience/roleId pair is ignored — a tier IS the role restriction —
  // so a caller passing a stale audience cannot narrow or widen a tiered payout.
  const cands = [linked("Ana", { roleIds: ["r1"] })];
  const r = resolveRecipients(cands, { kind: "vip", audience: "role", roleId: "r-unrelated", tiers: [{ roleId: "r1", amount: 3 }] });
  assert.equal(r.recipients.length, 1);

  const base = { sourceType: "event" as const, sourceRef: "{}", kind: "currency" as const, amount: 50, serverIds: [], recipients: cands };
  const untiered = duplicateKey(base);
  const tiered = duplicateKey({ ...base, tiers: [{ roleId: "r1", amount: 100 }, { roleId: "r2", amount: null }] });
  const reordered = duplicateKey({ ...base, tiers: [{ roleId: "r2", amount: null }, { roleId: "r1", amount: 100 }] });
  assert.notEqual(untiered, tiered, "the same payout with tiers is a different payout");
  assert.notEqual(tiered, reordered, "tier order is priority, so reordering is a different payout");
  assert.ok(!untiered.includes("|tiers:"), "an untiered key stays byte-identical to what old jobs recorded");
});

test("validateExecution refuses a zero or fractional tier amount", () => {
  const recipients = [{ discordId: "d-1", playerId: "p-1", displayName: "Ana", sourceName: null, minutes: null }];
  const ok = { kind: "currency" as const, amount: 50, serverIds: [], recipients, previewReady: true };
  validateExecution({ ...ok, tiers: [{ roleId: "r1", amount: null }, { roleId: "r2", amount: 10 }] });
  assert.throws(() => validateExecution({ ...ok, tiers: [{ roleId: "r1", amount: 0 }] }), /whole number above zero/);
  assert.throws(() => validateExecution({ ...ok, tiers: [{ roleId: "r1", amount: 2.5 }] }), /whole number above zero/);
  assert.throws(() => validateExecution({ ...ok, tiers: [{ roleId: "", amount: 5 }] }), /needs a role/);
});

/**
 * One Discord, two game accounts — which this app models on purpose (the ban-evasion tripwire is
 * built on it). The audience rules ask about a PERSON, so they have to see one.
 */
test("a person's accounts are folded before the rules run, not after", () => {
  // 20 + 25 minutes across two of their own accounts. Judged per account, a 30-minute floor threw
  // both away and the person went unpaid despite being on for three quarters of an hour.
  const r = resolveRecipients([
    { discordId: "d1", playerId: "p1", displayName: "Kreitz", minutes: 20 },
    { discordId: "d1", playerId: "p2", displayName: "Kreitz (alt)", minutes: 25 },
  ], { kind: "currency", audience: "everyone", minMinutes: 22 });
  assert.equal(r.recipients.length, 1, "one person");
  assert.equal(r.dropped.underMinutes, 0);
  // The MAX, never the sum: two accounts can be connected at once, so summing would credit
  // presence nobody had. It is also no longer whichever sighting happened to arrive last.
  assert.equal(r.recipients[0]!.minutes, 25);
  assert.equal(r.recipients[0]!.displayName, "Kreitz", "first sighting names them");
  assert.equal(r.recipients[0]!.playerId, "p1");

  // Under the floor for the person too: dropped ONCE, because it is one person.
  const under = resolveRecipients([
    { discordId: "d1", playerId: "p1", displayName: "Kreitz", minutes: 5 },
    { discordId: "d1", playerId: "p2", displayName: "Kreitz (alt)", minutes: 8 },
  ], { kind: "currency", audience: "everyone", minMinutes: 30 });
  assert.deepEqual(under.recipients, []);
  assert.equal(under.dropped.underMinutes, 1, "one person, one drop — the preview counts people");
});

test("a tier still resolves once for a person with two accounts", () => {
  // Roles are looked up by DISCORD id, so both of a person's accounts carry the same list — this
  // guards that folding first did not disturb the tier match or double the payment.
  const r = resolveRecipients([
    { discordId: "d1", playerId: "p1", displayName: "Kreitz", roleIds: ["boost"] },
    { discordId: "d1", playerId: "p2", displayName: "Kreitz (alt)", roleIds: ["boost"] },
  ], { kind: "currency", audience: "everyone", tiers: [{ roleId: "boost", amount: 100 }] });
  assert.equal(r.recipients.length, 1);
  assert.equal(r.dropped.noRole, 0);
  assert.equal(r.recipients[0]!.amount, 100);
});

test("two DIFFERENT people are still two people", () => {
  const r = resolveRecipients([
    { discordId: "d1", playerId: "p1", displayName: "Kreitz", minutes: 40 },
    { discordId: "d2", playerId: "p2", displayName: "Caereca", minutes: 40 },
    { discordId: null, playerId: "p3", displayName: "Stranger", minutes: 40 },
  ], { kind: "currency", audience: "everyone", minMinutes: 10 });
  assert.deepEqual(r.recipients.map((x) => x.displayName), ["Caereca", "Kreitz"]);
  assert.equal(r.dropped.unlinked, 1);
});
