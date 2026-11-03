/**
 * The transport's own limit.
 *
 * Discord rejects a message over 2000 characters outright — the whole post, not the tail — and a
 * rejection here is only logged, so the message is gone. The relay packs its lines to stay under
 * the cap, but ALERTS never go through the relay: they are built and handed straight to
 * `sendAlert`, interpolating text nobody bounds (a watchlist reason, an automod reason, the chat
 * behind an `!admin` request). So the cap belongs to the transport, where every path meets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiscordRestSink } from "../dist/sink.js";
import { createLogger } from "@app/shared";

const log = createLogger("test");

/** Capture what would go on the wire, without one. */
function captureFetch() {
  const calls: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("an over-long alert is truncated to fit, not dropped by Discord", async () => {
  const { calls, restore } = captureFetch();
  try {
    const sink = new DiscordRestSink("bot-token", log);
    // A watchlist reason someone pasted a wall of text into.
    const huge = "👁 **Watchlisted player joined** — **Griefer**: " + "x".repeat(5000);
    await sink.sendAlert("C1", huge, "900000000000000001");

    assert.equal(calls.length, 1, "one post");
    const content = String(calls[0]!.body.content);
    assert.ok(content.length <= 2000, `content fits the cap, got ${content.length}`);
    assert.ok(content.endsWith("…"), "and says it was cut");
    // The head survives: the mention, the headline and who it is about are the point of an alert.
    assert.ok(content.startsWith("<@&900000000000000001> "), "the role ping is intact");
    assert.match(content, /Watchlisted player joined/);
    assert.match(content, /Griefer/);
    // The mention is still constrained to that one role — truncating must not touch the policy.
    assert.deepEqual(calls[0]!.body.allowed_mentions, { parse: [], roles: ["900000000000000001"] });
  } finally {
    restore();
  }
});

test("a message that already fits is sent through untouched", async () => {
  const { calls, restore } = captureFetch();
  try {
    const sink = new DiscordRestSink("bot-token", log);
    await sink.send("C1", "Ana killed Bob (Thompson)");
    assert.equal(String(calls[0]!.body.content), "Ana killed Bob (Thompson)", "no truncation, no ellipsis");
    assert.deepEqual(calls[0]!.body.allowed_mentions, { parse: [] }, "relayed text can never ping");
  } finally {
    restore();
  }
});

/*
 * The bot token is set in the panel, and the bot keeps running while it changes: the sink reads it
 * at each post, so a new one is used straight away, and a removed one means Discord is off.
 */
test("the token is read at each post: a new one is used at once, and with none nothing is sent", async () => {
  const { calls, restore } = captureFetch();
  try {
    let token = "first.token.value";
    const sink = new DiscordRestSink(() => token, log);
    await sink.send("C1", "one");
    token = "second.token.value";
    await sink.send("C1", "two");
    token = "";
    await sink.sendAlert("C1", "three", null);
    assert.deepEqual(calls.map((c) => c.auth), ["Bot first.token.value", "Bot second.token.value"]);
  } finally {
    restore();
  }
});
