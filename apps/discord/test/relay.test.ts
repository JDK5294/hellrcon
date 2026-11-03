import { test } from "node:test";
import assert from "node:assert/strict";
import { Relay, chunkLines, type MessageSink, type RelayConfig } from "../dist/relay.js";
import type { Category } from "../dist/format.js";
import { createLogger } from "@app/shared";

const log = createLogger("test");

class FakeSink implements MessageSink {
  sent: Array<{ channel: string; content: string }> = [];
  async send(channel: string, content: string): Promise<void> {
    this.sent.push({ channel, content });
  }
}

function cfg(over: Partial<RelayConfig> = {}): RelayConfig {
  const channels = { kills: "C_KILLS", chat: null, admin: "C_ADMIN", connections: null, match: "C_ADMIN" } as Record<Category, string | null>;
  return { channels, enabled: new Set<Category>(["kills", "admin", "match"]), flushMs: 1000, ...over };
}

test("buffers events and flushes one combined message per channel", async () => {
  const sink = new FakeSink();
  const relay = new Relay(sink, cfg(), log);
  relay.handle({ kind: "evt.kill", actorName: "A", victimName: "B" });
  relay.handle({ kind: "evt.kill", actorName: "C", victimName: "D" });
  relay.handle({ kind: "evt.player.kicked", actorName: "E" });
  assert.equal(sink.sent.length, 0, "nothing sent before flush");
  await relay.flush();

  const kills = sink.sent.find((m) => m.channel === "C_KILLS");
  const admin = sink.sent.find((m) => m.channel === "C_ADMIN");
  assert.ok(kills && admin);
  assert.equal(kills!.content.split("\n").length, 2, "two kills coalesced into one message");
  assert.match(admin!.content, /E kicked/);
});

test("drops events for disabled categories and null channels", async () => {
  const sink = new FakeSink();
  // 'match' enabled but routed to a null channel; 'connections' not enabled at all.
  const relay = new Relay(sink, cfg({ channels: { kills: "C", chat: null, admin: null, connections: "X", match: null } as Record<Category, string | null>, enabled: new Set<Category>(["kills", "match"]) }), log);
  relay.handle({ kind: "evt.player.connected", actorName: "A" }); // connections not enabled
  relay.handle({ kind: "evt.match.started" }); // enabled but channel null
  relay.handle({ kind: "evt.kill", actorName: "A", victimName: "B" }); // kept
  await relay.flush();
  assert.equal(sink.sent.length, 1);
  assert.equal(sink.sent[0]!.channel, "C");
});

test("lines are stamped on the config's community clock, not UTC", async () => {
  const sink = new FakeSink();
  const relay = new Relay(sink, cfg({ timezone: () => "America/New_York" }), log);
  // 22:56 UTC in February is 17:56 in New York (EST) — the clock staff actually watched it on.
  relay.handle({ kind: "evt.kill", ts: "2026-02-11T22:56:00.000Z", actorName: "A", victimName: "B" });
  await relay.flush();
  assert.match(sink.sent[0]!.content, /`17:56:00`/);
});

test("flush clears buffers so a second flush sends nothing", async () => {
  const sink = new FakeSink();
  const relay = new Relay(sink, cfg(), log);
  relay.handle({ kind: "evt.kill", actorName: "A", victimName: "B" });
  await relay.flush();
  await relay.flush();
  assert.equal(sink.sent.length, 1);
});

test("chunkLines packs under the cap and truncates an overlong line", () => {
  const lines = ["aaaa", "bbbb", "cccc"];
  const chunks = chunkLines(lines, 9); // "aaaa\nbbbb" = 9 chars, then "cccc"
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "aaaa\nbbbb");
  assert.equal(chunks[1], "cccc");

  const [big] = chunkLines(["x".repeat(50)], 10);
  assert.equal(big!.length, 10);
  assert.match(big!, /…$/);
});

test("per-server resolve overrides the default routing; unknown server falls back to default", async () => {
  const sink = new FakeSink();
  // Default (env) routes kills → C_DEFAULT. Server "s1" overrides kills → C_S1; server "s2" has no
  // override so it uses the default.
  const relay = new Relay(sink, cfg({
    channels: { kills: "C_DEFAULT", chat: null, admin: null, connections: null, match: null } as Record<Category, string | null>,
    enabled: new Set<Category>(["kills"]),
    resolve: (serverId) => serverId === "s1"
      ? { enabled: new Set<Category>(["kills"]), channels: { kills: "C_S1", chat: null, admin: null, connections: null, match: null } as Record<Category, string | null> }
      : serverId === "s3"
        ? { enabled: new Set<Category>(), channels: {} as Record<Category, string | null> } // disabled server relays nothing
        : null,
  }), log);
  relay.handle({ kind: "evt.kill", actorName: "A", victimName: "B", serverId: "s1" });
  relay.handle({ kind: "evt.kill", actorName: "C", victimName: "D", serverId: "s2" });
  relay.handle({ kind: "evt.kill", actorName: "E", victimName: "F", serverId: "s3" });
  await relay.flush();

  assert.ok(sink.sent.find((m) => m.channel === "C_S1"), "s1 routed to its own channel");
  assert.ok(sink.sent.find((m) => m.channel === "C_DEFAULT"), "s2 fell back to the default channel");
  assert.equal(sink.sent.filter((m) => m.content.includes("E")).length, 0, "disabled server relayed nothing");
});

test("a failing sink doesn't throw out of flush", async () => {
  const boom: MessageSink = {
    async send() {
      throw new Error("network");
    },
  };
  const relay = new Relay(boom, cfg(), log);
  relay.handle({ kind: "evt.kill", actorName: "A", victimName: "B" });
  await relay.flush(); // must resolve, not reject
  assert.ok(true);
});

test("per-category fine-tuning: team-kills-only filter and one role ping per batch", async () => {
  class MentionSink extends FakeSink {
    alerts: Array<{ channel: string; content: string; role: string | null }> = [];
    async sendAlert(channel: string, content: string, role: string | null): Promise<void> {
      this.alerts.push({ channel, content, role });
    }
  }
  const sink = new MentionSink();
  const all = { kills: "C_K", chat: "C_C", admin: null, connections: null, match: null } as Record<Category, string | null>;
  const relay = new Relay(sink, cfg({
    channels: all,
    enabled: new Set<Category>(["kills", "chat"]),
    resolve: () => ({
      enabled: new Set<Category>(["kills", "chat"]),
      channels: all,
      options: { kills: { teamkillsOnly: true, mentionRoleId: "999" } },
    }),
  }), log);

  relay.handle({ kind: "evt.kill", actorName: "A", victimName: "B", serverId: "s1" }); // filtered out
  relay.handle({ kind: "evt.teamkill", actorName: "TK", victimName: "V", serverId: "s1" }); // kept
  relay.handle({ kind: "evt.chat.team", actorName: "P1", data: { message: "gg" }, serverId: "s1" }); // untouched category
  await relay.flush();

  // Kills channel: only the team kill, delivered through the mention path with exactly role 999.
  const killAlert = sink.alerts.find((a) => a.channel === "C_K");
  assert.ok(killAlert, "kills batch went through the mention path");
  assert.equal(killAlert!.role, "999");
  assert.match(killAlert!.content, /TEAMKILL/);
  assert.ok(!killAlert!.content.includes("**A**"), "regular kill was filtered out");

  // Chat has no options configured → relays as always, plain send.
  const chat = sink.sent.find((m) => m.channel === "C_C");
  assert.ok(chat, "chat batch used plain send");
  assert.match(chat!.content, /gg/);
});

test("passesCategoryFilters is permissive without options", async () => {
  const { passesCategoryFilters } = await import("../dist/relay.js");
  assert.equal(passesCategoryFilters("kills", "evt.kill"), true);
  assert.equal(passesCategoryFilters("kills", "evt.kill", { teamkillsOnly: false }), true);
  assert.equal(passesCategoryFilters("kills", "evt.kill", { teamkillsOnly: true }), false);
  assert.equal(passesCategoryFilters("kills", "evt.teamkill", { teamkillsOnly: true }), true);
});

test("individual ballots stay out of the admin channel unless the category opts in", async () => {
  const { passesCategoryFilters } = await import("../dist/relay.js");
  // The default — and the reason the kind can be mapped at all without burying the admin channel
  // under one line per player per vote.
  assert.equal(passesCategoryFilters("admin", "evt.vote.cast"), false);
  assert.equal(passesCategoryFilters("admin", "evt.vote.cast", { mentionRoleId: "1" }), false);
  assert.equal(passesCategoryFilters("admin", "evt.vote.cast", { includeVoteBallots: false }), false);
  assert.equal(passesCategoryFilters("admin", "evt.vote.cast", { includeVoteBallots: true }), true);
  // The vote's start and result are never filtered — they are one line each.
  assert.equal(passesCategoryFilters("admin", "evt.vote.started"), true);
  assert.equal(passesCategoryFilters("admin", "evt.vote.completed"), true);
});

test("admin camera use reaches the admin channel; ballots do not, by default", async () => {
  const sink = new FakeSink();
  const relay = new Relay(sink, cfg(), log);
  relay.handle({ kind: "evt.admin.camera", actorName: "Mod", data: { message: "entered spectator" } });
  relay.handle({ kind: "evt.vote.cast", actorName: "Voter", data: { content: "yes" } });
  relay.handle({ kind: "evt.vote.started", actorName: "Starter", data: { voteType: "kick", target: "Griefer" } });
  await relay.flush();

  const admin = sink.sent.find((m) => m.channel === "C_ADMIN");
  assert.ok(admin, "the admin batch was posted");
  assert.match(admin!.content, /Mod used admin camera/);
  assert.match(admin!.content, /vote started/);
  assert.ok(!admin!.content.includes("Voter"), "a ballot must not appear without includeVoteBallots");
});

/*
 * Flushes are SERIALIZED. A Discord send can be slow on purpose (a rate-limit retry holds a chunk
 * for seconds) and the timer keeps firing — without a guard, a second flush ran beside the first
 * and posted NEWER lines between an in-flight flush's older chunks, so a channel's feed read out
 * of order. The proof: hold the first chunk of a two-chunk flush open, flush newer lines
 * meanwhile, and demand the channel still receives old chunk 1, old chunk 2, new lines.
 */
test("a slow send cannot let a later flush overtake the chunks still in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const sink = new (class implements MessageSink {
    sent: string[] = [];
    private first = true;
    async send(_channel: string, content: string): Promise<void> {
      const wasFirst = this.first;
      this.first = false;
      if (wasFirst) await gate; // the first chunk hangs, as a rate-limited send does
      this.sent.push(content);
    }
  })();
  // maxLen small enough that two kills need two chunks — the reorder needs a gap to land in.
  const relay = new Relay(sink, cfg({ maxLen: 30 }), log);
  relay.handle({ kind: "evt.kill", actorName: "Old1", victimName: "X" });
  relay.handle({ kind: "evt.kill", actorName: "Old2", victimName: "X" });
  const firstFlush = relay.flush();
  relay.handle({ kind: "evt.kill", actorName: "New3", victimName: "X" });
  const secondFlush = relay.flush();
  release();
  await Promise.all([firstFlush, secondFlush]);
  assert.equal(sink.sent.length, 3);
  assert.match(sink.sent[0]!, /Old1/);
  assert.match(sink.sent[1]!, /Old2/, "the in-flight flush finishes before the next one speaks");
  assert.match(sink.sent[2]!, /New3/);
});
