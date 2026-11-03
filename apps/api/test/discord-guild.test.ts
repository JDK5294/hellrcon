/**
 * Reading a guild's whole member list — the call that replaced one-lookup-per-person in the payout
 * preview.
 *
 * The paging is the part worth pinning. Discord answers up to a thousand members at a time and is
 * paged with `after=<last user id>`, so the cursor has to come from the page AS RECEIVED. Taking it
 * off the rows we kept restarts the next page behind any trailing row that was skipped, which
 * refetches the same members until the page ceiling is hit and the whole read is thrown away.
 *
 * And the outcome contract: anything other than `list` means "could not read the WHOLE list", never
 * a short answer. A caller that mistook a truncated list for a complete one would report the
 * missing people as holding no roles, which a tiered payout reads as "in no tier" and silently
 * drops them. The two failures are kept apart because they need opposite advice — a refused list is
 * a setting to change, a guild too large to page is a payout to narrow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guildMembers } from "../dist/discord-guild.js";

const PAGE = 1000;
/**
 * A stub Discord that serves `total` members in pages, recording the cursor it was asked for.
 *
 * `unreadable` marks members whose row arrives without a usable id. It is keyed on the MEMBER, not
 * on the position in the page, because that is how it would really behave: re-requesting the same
 * span returns the same unusable rows, rather than quietly healing on the second look.
 */
function discordWith(total: number, opts: { unreadable?: (id: number) => boolean } = {}) {
  const afters: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(String(url));
    const after = u.searchParams.get("after") ?? "";
    afters.push(after);
    const from = after === "0" ? 0 : Number(after) + 1;
    const rows: unknown[] = [];
    for (let i = from; i < Math.min(from + PAGE, total); i++) {
      // Ids ascend, which is the order Discord pages in.
      rows.push(opts.unreadable?.(i)
        ? { user: {}, roles: [] }
        : { user: { id: String(i), username: `u${i}` }, nick: null, roles: [`r${i % 3}`] });
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, afters };
}

test("a guild that fits in one page is one request", async () => {
  process.env.DISCORD_TOKEN = "test-token";
  const { fetchImpl, afters } = discordWith(40);
  const r = await guildMembers("g1", fetchImpl);
  assert.equal(r.kind, "list");
  assert.equal(r.kind === "list" && r.members.length, 40);
  assert.deepEqual(afters, ["0"], "no second call once a short page arrives");
  assert.deepEqual(r.kind === "list" && r.members[0],
    // username and nick are kept apart from the resolved display name: the staff-role sweep stores
    // both, and handing it one value for both rewrites every handle to a nickname.
    { userId: "0", name: "u0", username: "u0", nick: null, roleIds: ["r0"] });
});

test("a guild larger than one page is walked with the last id, not the page number", async () => {
  process.env.DISCORD_TOKEN = "test-token";
  const { fetchImpl, afters } = discordWith(2500);
  const r = await guildMembers("g1", fetchImpl);
  assert.equal(r.kind, "list");
  const members = r.kind === "list" ? r.members : [];
  assert.equal(members.length, 2500, "every member arrives exactly once");
  assert.equal(new Set(members.map((m) => m.userId)).size, 2500, "and nobody twice");
  assert.deepEqual(afters, ["0", "999", "1999"], "each page resumes after the previous page's last id");
});

test("a page that yields no usable id stops the walk instead of asking for it again", async () => {
  /*
   * A full page of rows with no usable id leaves the cursor with nothing to advance to. Refusing
   * the list is right either way — it is not complete, and the caller must not read it as one —
   * so this is about the COST of getting there, not the answer.
   *
   * Taking the cursor off the rows we kept meant re-sending the previous page's last id, which
   * asks Discord for the same unreadable page again, and again, until the page ceiling gives up:
   * every one of those requests through a rate limiter shared with everything else, to learn what
   * the second one already said. Reading the cursor off the page as received makes it two.
   */
  process.env.DISCORD_TOKEN = "test-token";
  const { fetchImpl, afters } = discordWith(2500, { unreadable: (id) => id >= PAGE && id < 2 * PAGE });
  const r = await guildMembers("g1", fetchImpl);
  assert.equal(r.kind, "unavailable", "an incomplete list is still refused");
  assert.equal(afters.length, 2, "and it stops at the page that could not move the cursor");
});

test("a guild too large to page through says SO, rather than blaming the bot's permissions", async () => {
  // The two failures need opposite advice — a setting to change versus a payout to narrow — so
  // they must not arrive as the same answer. Reading a truncated list as complete would also drop
  // everyone past the ceiling out of a tiered payout, which is why it is refused at all.
  process.env.DISCORD_TOKEN = "test-token";
  const { fetchImpl, afters } = discordWith(200_000);
  const r = await guildMembers("g1", fetchImpl);
  assert.equal(r.kind, "tooLarge");
  assert.equal(r.kind === "tooLarge" && r.seen, 25_000, "it reports how far it got");
  assert.equal(afters.length, 25, "and stops at the page ceiling rather than walking a whole huge guild");
});

test("a refused or unreadable list is never an empty guild, and a 403 names the intent", async () => {
  process.env.DISCORD_TOKEN = "test-token";
  // 403 is the Server Members intent being off — the most likely real failure, and the one worth
  // naming, because it is a switch someone has to go and flip.
  const denied = (async () => new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 })) as unknown as typeof fetch;
  const refused = await guildMembers("g1", denied);
  assert.equal(refused.kind, "unavailable");
  assert.match(refused.kind === "unavailable" ? refused.reason : "", /SERVER MEMBERS INTENT/);

  // A page that fails PART WAY through must discard what came before it.
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) {
      const rows = Array.from({ length: PAGE }, (_, i) => ({ user: { id: String(i), username: `u${i}` }, roles: [] }));
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;
  assert.equal((await guildMembers("g1", flaky)).kind, "unavailable", "one good page is not a guild");

  const garbage = (async () => new Response(JSON.stringify({ message: "not a list" }), { status: 200 })) as unknown as typeof fetch;
  assert.equal((await guildMembers("g1", garbage)).kind, "unavailable");

  const prev = process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_TOKEN;
  assert.equal((await guildMembers("g1", denied)).kind, "unavailable", "no bot token is 'could not ask', not 'nobody is here'");
  process.env.DISCORD_TOKEN = prev;
});
