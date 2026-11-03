/**
 * The shared member roster — the cache that exists because Discord's rate limits cannot be raised.
 *
 * They are per bot token, there is no paid tier, and spreading load across several tokens is API
 * abuse that gets the application banned. So the only lever is to ASK LESS. Every role question in
 * the app used to be its own request; this holds one member list and serves all of them from it.
 *
 * What is pinned here is the request COUNT, because that is the entire point, plus the two rules
 * that keep it honest: a failure is never read as an empty guild, and a failed read does not turn
 * the cache into an amplifier by retrying the whole walk on every lookup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guildRoster, memberRoles, resetRoster } from "../dist/discord-roster.js";

const GUILD = "g-roster";

/** Installs a stub Discord for the duration of one test, counting what it was asked for. */
function withDiscord(handler: (url: string) => Response) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const listOf = (members: { id: string; roles: string[] }[]) =>
  new Response(JSON.stringify(members.map((m) => ({ user: { id: m.id, username: m.id }, nick: null, roles: m.roles }))), { status: 200 });

test("many lookups, one request — and the cache is what makes the second one free", async () => {
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  const d = withDiscord(() => listOf([{ id: "u1", roles: ["r1"] }, { id: "u2", roles: ["r2"] }]));
  try {
    assert.deepEqual(await memberRoles(GUILD, "u1"), ["r1"]);
    assert.deepEqual(await memberRoles(GUILD, "u2"), ["r2"]);
    assert.deepEqual(await memberRoles(GUILD, "u1"), ["r1"]);
    assert.equal(d.calls.length, 1, "three questions, one member-list read");

    // Somebody the complete list does not mention is not in the guild — an empty set, not unknown.
    assert.deepEqual(await memberRoles(GUILD, "nobody"), []);
    assert.equal(d.calls.length, 1);
  } finally { d.restore(); }
});

test("concurrent callers share one fetch instead of racing into several", async () => {
  // A payout preview and a badge sweep arriving together is the real case: without single-flight
  // they would each start a full walk of the guild.
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  const d = withDiscord(() => listOf([{ id: "u1", roles: ["r1"] }]));
  try {
    const answers = await Promise.all([
      memberRoles(GUILD, "u1"), memberRoles(GUILD, "u1"), guildRoster(GUILD), memberRoles(GUILD, "u1"),
    ]);
    assert.equal(d.calls.length, 1, "four callers at once, one request");
    assert.deepEqual(answers[0], ["r1"]);
  } finally { d.restore(); }
});

test("a stale roster is refetched, and maxAgeMs 0 forces a fresh read", async () => {
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  let roles = ["old"];
  const d = withDiscord(() => listOf([{ id: "u1", roles }]));
  try {
    assert.deepEqual(await memberRoles(GUILD, "u1"), ["old"]);
    roles = ["new"];
    assert.deepEqual(await memberRoles(GUILD, "u1"), ["old"], "still inside the TTL");
    // Anything that must not be stale asks for age zero and pays for a request.
    assert.deepEqual(await memberRoles(GUILD, "u1", { maxAgeMs: 0 }), ["new"]);
    assert.equal(d.calls.length, 2);
  } finally { d.restore(); }
});

test("a refused list falls back per person, and does not re-walk the guild on every lookup", async () => {
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  const d = withDiscord((url) => (/\/members\?/.test(url)
    // The Server Members intent switched off: refused, every time.
    ? new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 })
    : new Response(JSON.stringify({ user: { username: "u" }, roles: ["solo"] }), { status: 200 })));
  try {
    assert.deepEqual(await memberRoles(GUILD, "u1"), ["solo"], "the per-person path still answers");
    assert.deepEqual(await memberRoles(GUILD, "u2"), ["solo"]);
    assert.deepEqual(await memberRoles(GUILD, "u3"), ["solo"]);
    const listAttempts = d.calls.filter((u) => /\/members\?/.test(u)).length;
    assert.equal(listAttempts, 1, "the failed list is not retried per lookup — a cache must not become an amplifier");

    const r = await guildRoster(GUILD);
    assert.equal(r.kind, "unavailable", "and the reason survives the backoff rather than going blank");
    assert.match(r.kind === "unavailable" ? r.reason : "", /403/);
  } finally { d.restore(); }
});

test("a failed refresh serves the roster in hand instead of amplifying into per-person lookups", async () => {
  /*
   * The refresh most likely to fail is the one that fires while Discord is rate-limiting — and
   * answering it with a failure sent every caller down the per-person fallback: fifty lookups
   * against the API that was already struggling, while a minute-old roster sat unused in the
   * cache. Amplification at the worst possible moment, which is the exact thing this file
   * exists to prevent.
   */
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  let broken = false;
  const d = withDiscord(() => (broken ? new Response("nope", { status: 500 }) : listOf([{ id: "u1", roles: ["r1"] }])));
  try {
    assert.deepEqual(await memberRoles(GUILD, "u1"), ["r1"], "primes the cache");
    broken = true;
    await new Promise((r) => setTimeout(r, 15));
    // Expired for this caller (maxAgeMs 10) and the refresh fails: the roster in hand answers.
    assert.deepEqual(await memberRoles(GUILD, "u1", { maxAgeMs: 10 }), ["r1"], "the last good roster stands in for the failure");
    assert.equal(d.calls.filter((u) => /\/members\/u1$/.test(u)).length, 0, "and nobody paid a per-person lookup for it");
    // Inside the failure backoff the same answer comes back without another walk being attempted.
    assert.deepEqual(await memberRoles(GUILD, "u1", { maxAgeMs: 10 }), ["r1"]);
    assert.equal(d.calls.filter((u) => /\/members\?/.test(u)).length, 2, "one prime, one failed refresh — no extra list attempts");
    // Forced-fresh still refuses the stale answer: an access decision gets "unknown", never
    // "whatever we had before the outage".
    assert.equal(await memberRoles(GUILD, "u1", { maxAgeMs: 0 }), null);
  } finally { d.restore(); }
});

test("an outage is never read as an empty guild", async () => {
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  const d = withDiscord(() => new Response("nope", { status: 500 }));
  try {
    assert.equal(await memberRoles(GUILD, "u1"), null,
      "null is 'could not find out' — a caller reading it as 'holds nothing' would revoke everybody");
  } finally { d.restore(); }
});

test("two guilds do not share one slot — a community runs a staff server AND a public one", async () => {
  /*
   * Three ways a single slot went wrong, all of them silent:
   *   - one cache entry thrashes when the two alternate, so it never hits and every miss walks a
   *     whole guild — worse than the per-person call it replaced;
   *   - one in-flight promise hands the SECOND guild's caller the FIRST guild's roster;
   *   - one failure slot replays whichever guild failed most recently for whichever is asked next,
   *     reporting the wrong cause for the wrong server.
   */
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  const d = withDiscord((url) => (url.includes("/guilds/staff/")
    ? listOf([{ id: "u1", roles: ["staff-role"] }])
    : listOf([{ id: "u1", roles: ["public-role"] }])));
  try {
    // Concurrent, different guilds: each must get its own answer, not whichever started first.
    const [staff, community] = await Promise.all([memberRoles("staff", "u1"), memberRoles("public", "u1")]);
    assert.deepEqual(staff, ["staff-role"]);
    assert.deepEqual(community, ["public-role"], "the second guild must not be served the first guild's roster");
    assert.equal(d.calls.length, 2, "two guilds, two reads");

    // Alternating afterwards is free — both are cached, neither evicts the other.
    await memberRoles("staff", "u1");
    await memberRoles("public", "u1");
    await memberRoles("staff", "u1");
    assert.equal(d.calls.length, 2, "no thrashing between the two");
  } finally { d.restore(); }
});

test("one guild's failure is not reported as another's", async () => {
  resetRoster();
  process.env.DISCORD_TOKEN = "test-token";
  const d = withDiscord((url) => {
    if (url.includes("/guilds/broken/")) return new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 });
    if (/\/members\?/.test(url)) return listOf([{ id: "u1", roles: ["fine"] }]);
    return new Response("{}", { status: 404 });
  });
  try {
    assert.equal((await guildRoster("broken")).kind, "unavailable");
    // The healthy guild is asked immediately afterwards, inside the broken one's backoff window.
    const ok = await guildRoster("healthy");
    assert.equal(ok.kind, "roster", "a working server must not inherit a broken one's backoff");
    assert.deepEqual(await memberRoles("healthy", "u1"), ["fine"]);
  } finally { d.restore(); }
});
