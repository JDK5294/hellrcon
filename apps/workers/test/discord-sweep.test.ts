/**
 * Clearing a vote channel.
 *
 * The thing this has to get right is WHAT counts as ours. Deleting the previous ballot by id left
 * two kinds of litter behind — Discord's own "…'s poll has closed!" message, which is a separate
 * message that outlives the poll it describes, and any ballot whose id was lost to a restart — and
 * both are found only by asking who posted them. Equally, a channel where a person has spoken must
 * come out of a sweep with that person's message still in it.
 *
 * Discord is stubbed at `fetch`, which is the seam the client actually uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sweepOwnMessages } from "../dist/discord-poll.js";

const BOT = "900000000000000001";
const HUMAN = "900000000000000002";

/** A message id that encodes `ageMs` ago — the sweep dates messages from the id alone. */
function idAt(ageMs: number): string {
  return String((BigInt(Date.now() - ageMs) - 1_420_070_400_000n) << 22n);
}

interface Call { method: string; path: string; body: unknown }

/** Stand in for Discord: serves one page of history, records every call, and lets a test refuse
 *  specific endpoints (no Manage Messages, a rate limit) the way the real API would. */
function stubDiscord(messages: { id: string; author: string }[], opts: { refuse?: (path: string) => number | null } = {}) {
  const calls: Call[] = [];
  const store = new Map(messages.map((m) => [m.id, m]));
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/api/v10", "") + u.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const status = opts.refuse?.(path) ?? null;
    if (status) return new Response(JSON.stringify({ message: "no", retry_after: 0.25 }), { status });

    if (path === "/users/@me") return new Response(JSON.stringify({ id: BOT }), { status: 200 });
    if (path.startsWith("/channels/c1/messages?")) {
      // Newest first, like Discord. One page: the test fixtures are far under the page size.
      return new Response(JSON.stringify([...store.values()].map((m) => ({ id: m.id, author: { id: m.author } }))), { status: 200 });
    }
    if (method === "POST" && path === "/channels/c1/messages/bulk-delete") {
      for (const id of (body as { messages: string[] }).messages) store.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      store.delete(path.split("/").pop()!);
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, store, restore: () => { globalThis.fetch = original; } };
}

test("the sweep clears every message this bot left — polls, Discord's own close notices, strays", async () => {
  const live = idAt(1_000);
  const fixtures = [
    { id: live, author: BOT },                    // the ballot just posted — stays
    { id: idAt(60_000), author: BOT },            // Discord's "poll has closed!" message
    { id: idAt(120_000), author: BOT },           // the poll it describes
    { id: idAt(3_600_000), author: BOT },         // a ballot from an earlier round, id long forgotten
    { id: idAt(90_000), author: HUMAN },          // somebody talking — not ours to delete
  ];
  const d = stubDiscord(fixtures);
  try {
    const r = await sweepOwnMessages("tok", "c1", [live]);
    assert.equal(r.removed, 3, "three of ours were spent");
    assert.equal(r.refused, 0, "and nothing was refused");
    assert.deepEqual([...d.store.keys()].sort(), [live, fixtures[4]!.id].sort(),
      "the live ballot and the human's message are what remain");
    // One bulk call, not three deletes: a night's backlog must not be a request per message.
    assert.equal(d.calls.filter((c) => c.path.endsWith("bulk-delete")).length, 1);
    assert.equal(d.calls.filter((c) => c.method === "DELETE").length, 0);
  } finally { d.restore(); }
});

test("without Manage Messages the sweep still clears the channel, one message at a time", async () => {
  const live = idAt(1_000);
  const d = stubDiscord(
    [{ id: live, author: BOT }, { id: idAt(60_000), author: BOT }, { id: idAt(120_000), author: BOT }],
    { refuse: (p) => (p.endsWith("bulk-delete") ? 403 : null) },
  );
  try {
    const r = await sweepOwnMessages("tok", "c1", [live]);
    assert.equal(r.removed, 2, "the fallback deleted both");
    assert.deepEqual([...d.store.keys()], [live]);
    assert.equal(d.calls.filter((c) => c.method === "DELETE").length, 2, "one request each, which needs no permission");
  } finally { d.restore(); }
});

test("a message older than bulk delete's 14-day limit is deleted on its own, not with the batch", async () => {
  const live = idAt(1_000);
  const ancient = idAt(20 * 24 * 3_600_000);
  const d = stubDiscord([{ id: live, author: BOT }, { id: idAt(60_000), author: BOT }, { id: idAt(120_000), author: BOT }, { id: ancient, author: BOT }]);
  try {
    const r = await sweepOwnMessages("tok", "c1", [live]);
    assert.equal(r.removed, 3);
    assert.deepEqual([...d.store.keys()], [live]);
    // Bulk delete rejects the WHOLE batch if one member is too old, so the old one must be kept out.
    const bulk = d.calls.find((c) => c.path.endsWith("bulk-delete"))!;
    assert.ok(!(bulk.body as { messages: string[] }).messages.includes(ancient), "the ancient message was not in the batch");
    assert.ok(d.calls.some((c) => c.method === "DELETE" && c.path.endsWith(ancient)), "it was deleted by itself");
  } finally { d.restore(); }
});

/*
 * A sweep Discord refuses must SAY so.
 *
 * This is the failure that actually happened: the bot could post polls in the channel but not
 * delete them, so every round left another "poll has closed!" behind, and the only record of it
 * was a debug line nobody sees. "Removed nothing because there was nothing" and "removed nothing
 * because Discord said no" look identical in the channel and have completely different fixes, so
 * the result tells them apart and carries the status the operator needs.
 */
test("a channel the bot may not delete in reports the refusal and its status", async () => {
  const live = idAt(1_000);
  const d = stubDiscord(
    [{ id: live, author: BOT }, { id: idAt(60_000), author: BOT }, { id: idAt(120_000), author: BOT }],
    // No Manage Messages, and single deletes refused too — a channel the bot can only talk in.
    { refuse: (p) => (p.endsWith("bulk-delete") || p.startsWith("/channels/c1/messages/") ? 403 : null) },
  );
  try {
    const r = await sweepOwnMessages("tok", "c1", [live]);
    assert.equal(r.removed, 0, "nothing went");
    assert.equal(r.refused, 2, "and both refusals were counted, not swallowed");
    assert.equal(r.status, 403, "with the status that names the missing permission");
    assert.equal(d.store.size, 3, "the channel is untouched");
  } finally { d.restore(); }
});

/*
 * A message that was already deleted is not a refusal — a sweep racing a moderator's cleanup must
 * report success, or every such round would cry wolf about a permission that is perfectly fine.
 */
test("a message that has already gone counts as done, not refused", async () => {
  const live = idAt(1_000);
  const d = stubDiscord(
    [{ id: live, author: BOT }, { id: idAt(60_000), author: BOT }],
    { refuse: (p) => (p.endsWith("bulk-delete") ? 403 : p.startsWith("/channels/c1/messages/") ? 404 : null) },
  );
  try {
    const r = await sweepOwnMessages("tok", "c1", [live]);
    assert.equal(r.refused, 0, "404 is 'already gone', which is the outcome we wanted");
    assert.equal(r.status, 0);
  } finally { d.restore(); }
});

test("nothing of ours in the channel is no requests beyond the read", async () => {
  const d = stubDiscord([{ id: idAt(60_000), author: HUMAN }]);
  try {
    assert.deepEqual(await sweepOwnMessages("tok", "c1", []), { removed: 0, refused: 0, status: 0 });
    assert.equal(d.calls.filter((c) => c.method === "DELETE" || c.path.endsWith("bulk-delete")).length, 0);
  } finally { d.restore(); }
});

test("a moved vote channel is swept too — the old channel's spent ballot does not stand forever", async () => {
  /*
   * The on-open tidy only ever looked at the CURRENT vote channel. Staff who moved the vote to
   * another channel between rounds left the spent poll and Discord's own "poll has closed" notice
   * standing in the old one, with no future sweep ever visiting it again — the state row parked
   * the closing channel id on every close precisely for this, and nothing read it.
   */
  const { channelsToSweep } = await import("../dist/discord-poll.js");

  assert.deepEqual(channelsToSweep("c2", "c1"), ["c2", "c1"], "the channel the last vote closed in gets its visit");
  assert.deepEqual(channelsToSweep("c1", "c1"), ["c1"], "an unmoved channel is swept once, not twice");
  assert.deepEqual(channelsToSweep("c1", null), ["c1"], "no parked close, nothing extra");
  assert.deepEqual(channelsToSweep(null, "c1"), ["c1"]);
  assert.deepEqual(channelsToSweep("", ""), []);

  // And the visit is a REAL sweep: the old channel comes out empty of this bot's litter while a
  // person's message survives — the same author rule as everywhere else, per target channel.
  const spent = idAt(60_000);
  const notice = idAt(55_000); // Discord's own "poll has closed" line, posted by the bot user
  const human = idAt(50_000);
  const stub = stubDiscord([
    { id: spent, author: BOT },
    { id: notice, author: BOT },
    { id: human, author: HUMAN },
  ]);
  try {
    for (const target of channelsToSweep("c1", "c1")) {
      await sweepOwnMessages("tok", target, []);
    }
    assert.deepEqual([...stub.store.keys()], [human], "bot litter gone, the person's message untouched");
  } finally { stub.restore(); }
});
