import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildNudgeMessage, agoLabel, nudgePings, splitUnread } from "../src/nudge.ts";
import { postMessage } from "../dist/discord-poll.js";

const HOUR = 3_600_000;

test("agoLabel: hours under a day, then days+hours, never below 1h", () => {
  const t0 = Date.parse("2026-07-27T00:00:00Z");
  assert.equal(agoLabel("2026-07-27T00:00:00Z", t0 + 30 * 60_000), "1h"); // sub-hour clamps up
  assert.equal(agoLabel("2026-07-27T00:00:00Z", t0 + 5 * HOUR), "5h");
  assert.equal(agoLabel("2026-07-27T00:00:00Z", t0 + 52 * HOUR), "2d 4h");
});

test("nudge message @mentions linked staff and names the rest", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const msg = buildNudgeMessage("Rules v2", "2026-07-25T12:00:00Z", now, [
    { discordId: "111222333", name: "Kreitz" },
    { discordId: null, name: "OldSchool" },
  ]);
  assert.ok(msg.includes("**Rules v2**"));
  assert.ok(msg.includes("2d 0h"));
  assert.ok(msg.includes("<@111222333>"));
  assert.ok(!msg.includes("<@null>"));
  assert.ok(msg.includes("**OldSchool**"));
  assert.ok(msg.includes("Announcements"));
});

test("splitUnread: excused staff are never named, however long the notice sits", () => {
  const users = [{ id: "a", name: "Ana" }, { id: "b", name: "Bob" }, { id: "c", name: "Cid" }];
  // Ana read it; Bob is away (excused); Cid just hasn't opened it.
  const { named, excused } = splitUnread(users, new Set(["a"]), ["b"]);
  assert.deepEqual(named.map((u) => u.id), ["c"], "only the unexcused unread are named");
  assert.deepEqual(excused.map((u) => u.id), ["b"], "the excused-and-unread come back separately, for the receipt");
  // An excused member who DID read it is nobody's business either way — not in either list.
  const both = splitUnread(users, new Set(["b"]), ["b"]);
  assert.deepEqual(both.excused, [], "read beats excused: nothing to report");
  // A stale excusal for an account that no longer exists excuses nobody and breaks nothing.
  const stale = splitUnread(users, new Set(), ["gone"]);
  assert.deepEqual(stale.named.map((u) => u.id), ["a", "b", "c"]);
});

/*
 * The reminder's mentions notified nobody for a while: the bot's plain-text post was made to let no
 * ping through (right for relayed chat), and the reminder posts through it. It now lets through
 * exactly the linked staff it names — never a role, never everyone.
 */
test("the reminder pings exactly the linked staff it names; other plain posts ping nobody", async () => {
  const named = [
    { discordId: "111222333", name: "Kreitz" },
    { discordId: null, name: "OldSchool" },
    { discordId: "444555666", name: "Medic" },
  ];
  assert.deepEqual(nudgePings(named), ["111222333", "444555666"]);

  const bodies: { allowed_mentions?: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await postMessage("tok", "900", "📣 reminder", nudgePings(named));
    await postMessage("tok", "900", "a relayed line");
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(bodies[0]!.allowed_mentions, { parse: [], users: ["111222333", "444555666"] });
  assert.deepEqual(bodies[1]!.allowed_mentions, { parse: [] });

  // And the sweep hands the list over — it lives in the worker's loop, which a test cannot start.
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(src.includes("await postMessage(discordToken(), cfg.channelId, msg, nudgePings(named));"), "the sweep passes the pings");
});

test("the reminder shows the notice's title and staff names as typed", () => {
  const msg = buildNudgeMessage("Rules *v2*_final", "2026-07-25T12:00:00Z", Date.parse("2026-07-27T12:00:00Z"), [{ discordId: null, name: "old_school" }]);
  assert.ok(msg.includes("**Rules \\*v2\\*\\_final**"), msg);
  assert.ok(msg.includes("**old\\_school**"), msg);
});
