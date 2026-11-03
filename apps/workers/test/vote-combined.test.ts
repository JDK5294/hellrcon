/**
 * Both surfaces at once, and the registered-only gate. What is pinned here: the final score is
 * ONE vote per identity with the DISCORD ballot beating a dual voter's chat line, the
 * registered filter drops unlinked in-game voters and unregistered Discord clicks, a mid-vote
 * surface switch routes a single-surface handle to the half that understands it, and a half that
 * cannot answer a live read contributes zero to that READ without poisoning the close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CombinedVoteSurface, InGameChatVote, NativeDiscordPoll, discordMessageIdOf, mergeBallots, spareForSiblingVotes, type ChatBallotEvent, type SiblingVoteState } from "../dist/vote-surface.js";
import type { VoteSurface, VoteHandle } from "../dist/vote-surface.js";

const v = (discordId: string, name = discordId) => ({ discordId, name });

test("mergeBallots: a linked voter is deduped even with the toggle OFF, and the Discord ballot wins", () => {
  const merged = mergeBallots({
    optionCount: 2,
    // Dual voter D1 disagreed with themselves: option 1 on Discord, option 2 in game. One vote,
    // and Discord reigns — registered: null is the toggle-off case, so the dedupe is uncondition-
    // al for anyone whose in-game ballot carries a real Discord id.
    discord: [[v("D1"), v("D2")], []],
    ingame: [[v("player:p9", "Unlinked")], [v("D1")]],
    registeredDiscord: null, registeredIngameOnly: false,
  });
  assert.deepEqual(merged.counts, [3, 0]);
  assert.deepEqual(merged.voters[0]!.map((x) => x.discordId).sort(), ["D1", "D2", "player:p9"]);
  assert.deepEqual(merged.voters[1], [], "the in-game line of a dual voter is not a second vote");
});

test("mergeBallots: both gates on drops unlinked in-game voters and unregistered Discord clicks", () => {
  const merged = mergeBallots({
    optionCount: 2,
    discord: [[v("D1"), v("STRANGER")], []],
    ingame: [[], [v("player:p9", "Unlinked"), v("D2")]],
    registeredDiscord: new Set(["D1", "D2"]), registeredIngameOnly: true,
  });
  assert.deepEqual(merged.counts, [1, 1]);
  assert.deepEqual(merged.voters[0]!.map((x) => x.discordId), ["D1"]);
  assert.deepEqual(merged.voters[1]!.map((x) => x.discordId), ["D2"]);
});

test("mergeBallots: the gates stand alone — open Discord with registered-only in game, and vice versa", () => {
  // The posture this split exists for: anyone may click the poll, but a chat vote must come from
  // a registered player.
  const openDiscord = mergeBallots({
    optionCount: 2,
    discord: [[v("STRANGER")], []],
    ingame: [[], [v("player:p9", "Unlinked"), v("D2")]],
    registeredDiscord: null, registeredIngameOnly: true,
  });
  assert.deepEqual(openDiscord.counts, [1, 1], "the stranger's click counts; the unlinked chat vote does not");
  assert.deepEqual(openDiscord.voters[1]!.map((x) => x.discordId), ["D2"]);

  // And the mirror: a locked poll over an open in-game ballot.
  const openIngame = mergeBallots({
    optionCount: 2,
    discord: [[v("STRANGER")], []],
    ingame: [[], [v("player:p9", "Unlinked")]],
    registeredDiscord: new Set([]), registeredIngameOnly: false,
  });
  assert.deepEqual(openIngame.counts, [0, 1], "the unregistered click is discounted; the unlinked chat vote counts");
});

/** A scriptable half for driving the combined wrapper. */
function fakeSurface(kind: string, script: { tally?: number[]; voters?: { discordId: string; name: string }[][]; failTally?: boolean }): VoteSurface & { opened: number; closed: number } {
  return {
    kind, opened: 0, closed: 0,
    async open() { this.opened += 1; return { messageId: kind === "ingame" ? `ingame:${new Date().toISOString()}` : "d123", channelId: kind === "ingame" ? "ingame" : "C1" }; },
    async tally(_h: VoteHandle, n: number) { if (script.failTally) throw new Error("down"); return script.tally ?? Array.from({ length: n }, () => 0); },
    async close(h: VoteHandle, n: number) { this.closed += 1; return this.tally(h, n); },
    async voters(_h: VoteHandle, n: number) { return script.voters ?? Array.from({ length: n }, () => []); },
  };
}

test("combined: one handle carries both halves; live tally sums; close merges exactly", async () => {
  const discord = fakeSurface("native", { tally: [3, 1], voters: [[v("D1"), v("D2"), v("D3")], [v("D4")]] });
  const ingame = fakeSurface("ingame", { tally: [0, 2], voters: [[], [v("D1"), v("player:p7", "Con")]] });
  const both = new CombinedVoteSurface(discord, ingame, {});
  const handle = await both.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);
  assert.match(handle.messageId, /^d123\|ingame:/);
  assert.equal(handle.channelId, "C1", "the Discord channel stays the handle's channel — the state persists it");

  assert.deepEqual(await both.tally(handle, 2), [3, 3], "live reads are the cheap raw sum");

  // Close is EXACT: D1 voted on Discord (option A) and in game (option B) — one vote, Discord
  // wins — while p7's in-game-only ballot for B still counts. A: D1+D2+D3; B: D4+p7.
  assert.deepEqual(await both.close(handle, 2), [3, 2]);
  assert.equal(discord.closed, 1, "the poll is taken down so late clicks stop");
  const voters = await both.voters(handle, 2);
  assert.deepEqual(voters[0]!.map((x) => x.discordId).sort(), ["D1", "D2", "D3"]);
  assert.deepEqual(voters[1]!.map((x) => x.discordId).sort(), ["D4", "player:p7"]);
});

test("combined: a single-surface handle routes to its own half; a dead half zeroes a live read only", async () => {
  const discord = fakeSurface("native", { tally: [2, 0], voters: [[v("D1"), v("D2")], []] });
  const ingame = fakeSurface("ingame", { tally: [0, 1], voters: [[], [v("D9")]] });
  const both = new CombinedVoteSurface(discord, ingame, {});

  // The vote opened before the config switched to "both": an ingame-only handle keeps counting
  // the in-game ballots, and the absent Discord half contributes nothing.
  const g = { messageId: "ingame:2026-09-15T00:00:00.000Z", channelId: "ingame" };
  assert.deepEqual(await both.tally(g, 2), [0, 1]);
  assert.deepEqual(await both.close(g, 2), [0, 1]);

  // A Discord outage during a live read: that half reads zero, the vote is not poisoned.
  const flaky = new CombinedVoteSurface(fakeSurface("native", { failTally: true }), ingame, {});
  assert.deepEqual(await flaky.tally({ messageId: "d1|ingame:2026-09-15T00:00:00.000Z", channelId: "C1" }, 2), [0, 1]);
});

test("combined + registered-only: the Discord-only wrapper is where unregistered clicks stop counting", async () => {
  const discord = fakeSurface("native", { voters: [[v("D1"), v("STRANGER")], [v("D2")]] });
  const both = new CombinedVoteSurface(discord, null, {
    registeredOnlyDiscord: true,
    registeredAmong: async (ids) => new Set(ids.filter((id) => id.startsWith("D"))),
  });
  const handle = await both.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);
  assert.equal(handle.messageId, "d123", "no in-game half — the plain Discord handle stands");
  assert.deepEqual(await both.close(handle, 2), [1, 1], "the stranger's click is not a counted ballot");
});

test("in-game registered-only: unlinked ballots do not count, linked ones carry the real Discord id", async () => {
  const store: ChatBallotEvent[] = [
    { ts: "2026-09-15T02:00:05.000Z", actorPlayerId: "p1", actorName: "Able", data: { message: "1" } },
    { ts: "2026-09-15T02:00:04.000Z", actorPlayerId: "p2", actorName: "NoLink", data: { message: "1" } },
    { ts: "2026-09-15T02:00:03.000Z", actorPlayerId: null, actorName: "NameOnly", data: { message: "2" } },
  ];
  const links: Record<string, string> = { p1: "D1" };
  const surface = new InGameChatVote({
    serverId: "s1",
    query: async (q) => store.filter((e) => e.ts >= q.from).slice(q.offset, q.offset + q.limit),
    announce: async () => {},
    registeredOnly: true,
    linkOf: async (playerId) => links[playerId] ?? null,
  });
  const handle = { messageId: "ingame:2026-09-15T02:00:00.000Z", channelId: "ingame" };
  assert.deepEqual(await surface.tally(handle, 2), [1, 0], "only the linked ballot counts");
  const voters = await surface.voters(handle, 2);
  assert.deepEqual(voters[0], [{ discordId: "D1", name: "Able" }], "counted under the REAL Discord id — the dedupe key");
});

test("combined: a half whose voter list cannot be read falls back to its own counts, not to zero", async () => {
  /*
   * Reading who voted costs one Discord request PER OPTION, issued the moment a match ends. That
   * read used to swallow its own failure into an empty answer, so a rate limit there did not read
   * as "we could not tell" — it read as "nobody voted for that map", and the merged result was
   * settled and announced on what survived.
   */
  const ingame = fakeSurface("ingame", { tally: [0, 1], voters: [[], [v("player:p7", "Con")]] });
  const blindDiscord: VoteSurface = {
    kind: "native",
    async open() { return { messageId: "d123", channelId: "C1" }; },
    async tally() { return [5, 2]; },            // the poll card can still be read
    async close() { return [5, 2]; },
    async voters() { throw new Error("429 Too Many Requests"); }, // but not who cast them
  };
  const warnings: string[] = [];
  const both = new CombinedVoteSurface(blindDiscord, ingame, { log: { warn: (m) => { warnings.push(m); } } });
  const handle = { messageId: "d123|ingame:2026-09-15T00:00:00.000Z", channelId: "C1" };

  assert.deepEqual(await both.close(handle, 2), [5, 3], "the 5 and 2 are kept; p7's in-game ballot still adds one");
  assert.ok(warnings.some((w) => /Discord ballot could not be read/.test(w)), "and it is reported, not hidden");

  // The names we DO have are still recorded, so the history is as complete as the reads allowed.
  const voters = await both.voters(handle, 2);
  assert.deepEqual(voters[0], []);
  assert.deepEqual(voters[1]!.map((x) => x.discordId), ["player:p7"]);
});

test("combined: a registration check that FAILS does not mean nobody is registered", async () => {
  /*
   * "Which of these are registered" has three answers, and a database hiccup is the third one. It
   * used to collapse to the empty set, which is the same value as "none of them" — so with the
   * Discord gate on, one failed lookup at close time discounted every click and handed the vote to
   * whatever the other half said.
   */
  const discord = fakeSurface("native", { tally: [2, 1], voters: [[v("D1"), v("D2")], [v("D3")]] });
  const warnings: string[] = [];
  const both = new CombinedVoteSurface(discord, null, {
    registeredOnlyDiscord: true,
    registeredAmong: async () => { throw new Error("database is having a moment"); },
    log: { warn: (m) => { warnings.push(m); } },
  });
  const handle = await both.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);

  assert.deepEqual(await both.close(handle, 2), [2, 1], "every ballot we could read still counts");
  assert.ok(warnings.some((w) => /could not check who is registered/.test(w)), "and the unapplied gate is reported");

  // And the gate still works when the check simply answers.
  const strict = new CombinedVoteSurface(
    fakeSurface("native", { voters: [[v("D1"), v("STRANGER")], [v("D3")]] }), null,
    { registeredOnlyDiscord: true, registeredAmong: async (ids) => new Set(ids.filter((id) => id.startsWith("D"))) },
  );
  const h2 = await strict.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);
  assert.deepEqual(await strict.close(h2, 2), [1, 1], "a working check still discounts the stranger");
});

test("combined: the close reports whether it was exact, so the channel post can say so", async () => {
  // A fully-read, fully-gated close is exact, and the result may be announced as counted.
  const clean = new CombinedVoteSurface(
    fakeSurface("native", { voters: [[v("D1")], [v("D2")]] }),
    fakeSurface("ingame", { voters: [[], [v("player:p7", "Con")]] }),
    {},
  );
  const h1 = await clean.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);
  assert.equal(clean.closeWasExact(h1), undefined, "nothing to report before the close");
  assert.deepEqual(await clean.close(h1, 2), [1, 2]);
  assert.equal(clean.closeWasExact(h1), true);

  // A half we could not read by name: the number stands, but it is not exact.
  const blind: VoteSurface = {
    kind: "native",
    async open() { return { messageId: "d123", channelId: "C1" }; },
    async tally() { return [4, 0]; },
    async close() { return [4, 0]; },
    async voters() { throw new Error("429"); },
  };
  const partial = new CombinedVoteSurface(blind, fakeSurface("ingame", { voters: [[], [v("player:p7", "Con")]] }), { log: { warn: () => {} } });
  const h2 = { messageId: "d123|ingame:2026-09-15T00:00:00.000Z", channelId: "C1" };
  assert.deepEqual(await partial.close(h2, 2), [4, 1]);
  assert.equal(partial.closeWasExact(h2), false, "a fallback must not be announced as a counted tally");

  // A gate we could not apply is the other way to be inexact.
  const ungated = new CombinedVoteSurface(fakeSurface("native", { voters: [[v("D1")], []] }), null, {
    registeredOnlyDiscord: true,
    registeredAmong: async () => { throw new Error("down"); },
    log: { warn: () => {} },
  });
  const h3 = await ungated.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);
  assert.deepEqual(await ungated.close(h3, 2), [1, 0]);
  assert.equal(ungated.closeWasExact(h3), false, "the gate did not run, so 'registered voters only' would be a lie");
});

test("combined: the Discord gate with nothing wired up to answer it counts everyone, not no one", async () => {
  // A caller's mistake, not a finding about the voters. The empty set that used to stand in here
  // discounted every ballot — the same zero the failed-check path was fixed to stop producing.
  const warnings: string[] = [];
  const both = new CombinedVoteSurface(
    fakeSurface("native", { voters: [[v("D1"), v("D2")], [v("D3")]] }), null,
    { registeredOnlyDiscord: true, log: { warn: (m) => { warnings.push(m); } } }, // no registeredAmong
  );
  const handle = await both.open("Vote", [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never);
  assert.deepEqual(await both.close(handle, 2), [2, 1], "every ballot counts when the gate cannot be applied");
  assert.ok(warnings.some((w) => /no registration check was provided/.test(w)));
  assert.equal(both.closeWasExact(handle), false, "and the post must not call it 'registered voters only'");
});

test("the channel sweep's keep id is the id DISCORD knows, whatever surface minted the handle", async () => {
  /*
   * The field report behind this: staff switched the vote to Both, and every new ballot vanished
   * moments after it was posted — "the new vote options were just cleared with the old vote
   * options". The tidy sweep on open spares a message only when its RAW snowflake is in the keep
   * list, and it was handed the stored handle verbatim. A combined handle is
   * "<discordId>|ingame:<iso>", which matches nothing Discord returns, so the sweep deleted the
   * spent ballot AND the one it had just posted.
   *
   * These pins drive the REAL surfaces' open() rather than string literals, so if the handle
   * format ever changes shape again, this fails before a channel does.
   */
  const opts = [{ id: "a", name: "A" }, { id: "b", name: "B" }] as never;

  // A combined handle: the keep id is the Discord half, exactly as Discord will report it.
  const both = new CombinedVoteSurface(fakeSurface("native", {}), fakeSurface("ingame", {}), {});
  const combined = await both.open("Vote", opts);
  assert.match(combined.messageId, /^d123\|ingame:/, "the stored id really is composite — the thing the sweep was handed");
  assert.equal(discordMessageIdOf(combined.messageId), "d123", "the sweep must keep d123, not the composite");

  // A Discord-only wrapper (the registered-gate case) mints a plain handle; it passes through.
  const gated = new CombinedVoteSurface(fakeSurface("native", {}), null, { registeredOnlyDiscord: true, registeredAmong: async () => new Set() });
  assert.equal(discordMessageIdOf((await gated.open("Vote", opts)).messageId), "d123");

  // A pure in-game vote has no Discord half at all: nothing to keep, and nothing to hand the wire.
  const ingame = new InGameChatVote({ serverId: "s1", query: async () => [], announce: async () => {} });
  assert.equal(discordMessageIdOf((await ingame.open("Vote", opts)).messageId), null);

  // And the empty cases stay quiet rather than inventing an id.
  assert.equal(discordMessageIdOf(null), null);
  assert.equal(discordMessageIdOf(undefined), null);
  assert.equal(discordMessageIdOf(""), null);
});

test("a bare Discord surface reads its own half of a combined handle, and knows when it has none", async (t) => {
  /*
   * The surface is rebuilt from config every tick, so switching "Both" → "Discord only" mid-vote
   * hands NativeDiscordPoll the combined handle. Sent to the wire verbatim, every read 404s: the
   * tally froze, close couldn't expire the poll, and the winner came from stale counts. The
   * surface now asks Discord about the half Discord knows — and a handle with no Discord half at
   * all (switched from "In-game only") answers zero without a doomed round trip.
   */
  const calls: { method: string; path: string }[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/v10/, "");
    calls.push({ method: init?.method ?? "GET", path });
    if (path === "/channels/c1/messages/d123") {
      return new Response(JSON.stringify({ poll: { results: { answer_counts: [{ id: 1, count: 4 }, { id: 2, count: 1 }] } } }), { status: 200 });
    }
    if (path === "/channels/c1/polls/d123/expire") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ message: "Unknown Message" }), { status: 404 });
  }) as typeof fetch;

  const surface = new NativeDiscordPoll("tok", "c1", 4);
  const combined = { messageId: "d123|ingame:2026-09-15T02:00:00.000Z", channelId: "c1" };

  assert.deepEqual(await surface.tally(combined, 2), [4, 1], "the live Discord poll keeps counting across the switch");
  assert.deepEqual(calls, [{ method: "GET", path: "/channels/c1/messages/d123" }], "the wire saw the snowflake, never the composite");

  calls.length = 0;
  assert.deepEqual(await surface.close(combined, 2), [4, 1]);
  assert.deepEqual(calls.map((c) => c.path), ["/channels/c1/polls/d123/expire", "/channels/c1/messages/d123"], "close expires the real poll");

  // No Discord half: there IS no poll, and zero is the truth — not a 404 dressed up as one.
  calls.length = 0;
  const ingameOnly = { messageId: "ingame:2026-09-15T02:00:00.000Z", channelId: "c1" };
  assert.deepEqual(await surface.tally(ingameOnly, 3), [0, 0, 0]);
  assert.deepEqual(await surface.close(ingameOnly, 3), [0, 0, 0]);
  assert.deepEqual(await surface.voters(ingameOnly, 3), [[], [], []]);
  assert.equal(calls.length, 0, "no round trips for a poll that never existed");
});

test("two servers sharing a vote channel spare each other's live ballots instead of erasing them", () => {
  /*
   * Nothing stops two servers pointing their votes at one channel, and the tidy sweep works BY
   * AUTHOR, sparing only the sweeping server's own new ballot — so server A's open deleted
   * server B's live poll, and B's next open returned the favour: each round, every vote erased
   * the other. The spare list now asks what the siblings still need in the target channel.
   */
  const siblings = (over: Partial<SiblingVoteState> = {}): SiblingVoteState[] => [{
    serverId: "B", activeMessageId: "d999|ingame:2026-09-15T02:00:00.000Z",
    activeChannelId: "shared", configChannelId: "shared", pauseNoticeId: null, ...over,
  }];

  // The live combined ballot's DISCORD half is spared — the id Discord actually reports.
  assert.deepEqual(spareForSiblingVotes("shared", "A", siblings()), ["d999"]);
  // A plain Discord ballot passes through as-is.
  assert.deepEqual(spareForSiblingVotes("shared", "A", siblings({ activeMessageId: "d777" })), ["d777"]);
  // A sibling voting in ANOTHER channel needs nothing here.
  assert.deepEqual(spareForSiblingVotes("shared", "A", siblings({ activeChannelId: "elsewhere", configChannelId: "elsewhere" })), []);
  // A pure in-game vote has no message in any channel to spare.
  assert.deepEqual(spareForSiblingVotes("shared", "A", siblings({ activeMessageId: "ingame:2026-09-15T02:00:00.000Z" })), []);
  // The sweeping server itself is never a sibling — its own new ballot rides the keep parameter.
  assert.deepEqual(spareForSiblingVotes("shared", "B", siblings()), []);
  // A paused sibling's standing notice survives too: sweeping it turns "voting is paused" into
  // a silently missing vote.
  assert.deepEqual(
    spareForSiblingVotes("shared", "A", siblings({ activeMessageId: null, pauseNoticeId: "n42" })),
    ["n42"],
  );
  // A state row from before channels were tracked falls back to the config's channel.
  assert.deepEqual(spareForSiblingVotes("shared", "A", siblings({ activeChannelId: null })), ["d999"]);
});

/*
 * The live read with the in-game half's voters beside the counts, for the public vote_status: the
 * counts are the raw sum, as `tally`; the voters are the in-game half's, or null when there is no
 * in-game half or it could not be read this time (a failed read is not an empty ballot).
 */
test("combined: the live read carries the in-game half's voters beside the summed counts", async () => {
  const chatLine = (ts: string, id: string, name: string, message: string): ChatBallotEvent => ({ ts, actorPlayerId: id, actorName: name, data: { message } });
  const store = [chatLine("2026-10-13T20:00:05.000Z", "p2", "Baker", "2")];
  const ingame = new InGameChatVote({ serverId: "s1", query: async (q) => store.filter((e) => e.ts >= q.from).slice(q.offset, q.offset + q.limit), announce: async () => {} });
  const handle = { messageId: "d123|ingame:2026-10-13T20:00:00.000Z", channelId: "C1" };
  const both = new CombinedVoteSurface(fakeSurface("native", { tally: [3, 1] }), ingame, {});
  assert.deepEqual(await both.tallyWithVoters(handle, 2), { counts: [3, 2], ingame: [[], [{ name: "Baker", key: "p2" }]] });

  const downIngame = new InGameChatVote({ serverId: "s1", query: async () => { throw new Error("db down"); }, announce: async () => {} });
  const flaky = new CombinedVoteSurface(fakeSurface("native", { tally: [3, 1] }), downIngame, {});
  assert.deepEqual(await flaky.tallyWithVoters(handle, 2), { counts: [3, 1], ingame: null }, "unread is unknown, not nobody");

  const discordOnly = new CombinedVoteSurface(fakeSurface("native", { tally: [3, 1] }), null, {});
  assert.deepEqual(await discordOnly.tallyWithVoters({ messageId: "d123", channelId: "C1" }, 2), { counts: [3, 1], ingame: null });
});
