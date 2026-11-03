import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDiscordConfig } from "../dist/config.js";

test("defaults: kills/admin/match enabled, chat/connections off", () => {
  const c = loadDiscordConfig({ DISCORD_TOKEN: "t", DISCORD_CHANNEL_ID: "C" });
  assert.equal(c.token, "t");
  assert.deepEqual([...c.relay.enabled].sort(), ["admin", "kills", "match"]);
  assert.equal(c.relay.channels.kills, "C"); // falls back to default channel
  assert.equal(c.relay.channels.chat, "C");
  assert.equal(c.hasTarget, true);
});

test("per-category channel overrides the default", () => {
  const c = loadDiscordConfig({ DISCORD_TOKEN: "t", DISCORD_CHANNEL_ID: "DEF", DISCORD_KILLS_CHANNEL_ID: "K" });
  assert.equal(c.relay.channels.kills, "K");
  assert.equal(c.relay.channels.admin, "DEF");
});

test("DISCORD_RELAY_CATEGORIES narrows and validates the set", () => {
  const c = loadDiscordConfig({ DISCORD_TOKEN: "t", DISCORD_CHANNEL_ID: "C", DISCORD_RELAY_CATEGORIES: "kills, chat, bogus" });
  assert.deepEqual([...c.relay.enabled].sort(), ["chat", "kills"]); // 'bogus' ignored
});

test("no channels → hasTarget false", () => {
  const c = loadDiscordConfig({ DISCORD_TOKEN: "t" });
  assert.equal(c.hasTarget, false);
});

test("no token → token null", () => {
  const c = loadDiscordConfig({ DISCORD_CHANNEL_ID: "C" });
  assert.equal(c.token, null);
});

test("invalid flush ms falls back to 2000", () => {
  assert.equal(loadDiscordConfig({ DISCORD_FLUSH_MS: "-5" }).relay.flushMs, 2000);
  assert.equal(loadDiscordConfig({ DISCORD_FLUSH_MS: "500" }).relay.flushMs, 500);
});
