import { test } from "node:test";
import assert from "node:assert/strict";
import { communityAutomationConfig, matchAdminPing, matchWatchlist, matchAutomation, matchServerDark } from "../dist/alerts.js";
import type { DiscordAlertsConfig } from "@app/db";

function alerts(over: Partial<DiscordAlertsConfig> = {}): DiscordAlertsConfig {
  return {
    adminPing: { enabled: true, channelId: "C_ADMIN", mentionRoleId: "R1", trigger: "!admin" },
    watchlist: { enabled: true, channelId: "C_WATCH", mentionRoleId: "R2" },
    automation: { enabled: false, channelId: null, mentionRoleId: null },
    serverDark: { enabled: true, channelId: "C_DARK", mentionRoleId: "R3" },
    ...over,
  };
}

test("admin-ping: fires on a chat message that starts with the trigger", () => {
  const a = matchAdminPing({ kind: "evt.chat.team", actorName: "Bob", data: { message: "!admin someone is cheating" } }, alerts(), "Server 1");
  assert.ok(a);
  assert.equal(a!.channelId, "C_ADMIN");
  assert.equal(a!.mentionRoleId, "R1");
  assert.match(a!.text, /Admin request/);
  assert.match(a!.text, /Bob/);
  assert.match(a!.text, /someone is cheating/);
  assert.match(a!.text, /Server 1/);
});

test("admin-ping: does not fire for non-trigger chat, non-chat events, or when disabled/no channel", () => {
  assert.equal(matchAdminPing({ kind: "evt.chat.team", actorName: "B", data: { message: "hello" } }, alerts()), null);
  assert.equal(matchAdminPing({ kind: "evt.kill", actorName: "B", data: { message: "!admin x" } }, alerts()), null);
  assert.equal(matchAdminPing({ kind: "evt.chat.team", data: { message: "!admin x" } }, alerts({ adminPing: { enabled: false, channelId: "C", mentionRoleId: null, trigger: "!admin" } })), null);
  assert.equal(matchAdminPing({ kind: "evt.chat.team", data: { message: "!admin x" } }, alerts({ adminPing: { enabled: true, channelId: null, mentionRoleId: null, trigger: "!admin" } })), null);
});

test("admin-ping: custom trigger, case-insensitive", () => {
  const a = matchAdminPing({ kind: "evt.chat.squad", actorName: "X", data: { message: "@STAFF help" } }, alerts({ adminPing: { enabled: true, channelId: "C", mentionRoleId: null, trigger: "@staff" } }));
  assert.ok(a);
  assert.match(a!.text, /help/);
});

test("watchlist: fires on a connect for a watched player only", () => {
  const on = matchWatchlist({ kind: "evt.player.connected", actorName: "Sniper" }, alerts(), true, "S2");
  assert.ok(on);
  assert.equal(on!.channelId, "C_WATCH");
  assert.match(on!.text, /Watchlisted player joined/);
  assert.match(on!.text, /Sniper/);
  // not watched → nothing
  assert.equal(matchWatchlist({ kind: "evt.player.connected", actorName: "Nobody" }, alerts(), false), null);
  // wrong event kind → nothing
  assert.equal(matchWatchlist({ kind: "evt.player.disconnected", actorName: "Sniper" }, alerts(), true), null);
  // disabled → nothing
  assert.equal(matchWatchlist({ kind: "evt.player.connected", actorName: "S" }, alerts({ watchlist: { enabled: false, channelId: "C", mentionRoleId: null } }), true), null);
});

test("watchlist: the ping carries WHY they're watched and by whom, when known", () => {
  const rich = matchWatchlist({ kind: "evt.player.connected", actorName: "Sniper" }, alerts(), { watched: true, reason: "repeat TK on seed", by: "OldAdmin" }, "S2");
  assert.ok(rich);
  assert.match(rich!.text, /repeat TK on seed/);
  assert.match(rich!.text, /watched by OldAdmin/);
  // watched with no stored details (pre-provenance rows) still fires, just without the extras
  const bare = matchWatchlist({ kind: "evt.player.connected", actorName: "Sniper" }, alerts(), { watched: true });
  assert.ok(bare);
  assert.match(bare!.text, /Sniper/);
  assert.doesNotMatch(bare!.text, /watched by/);
  // an unwatched object form → nothing
  assert.equal(matchWatchlist({ kind: "evt.player.connected", actorName: "N" }, alerts(), { watched: false, reason: "stale" }), null);
});

test("matchAutomation: reports enforcer firings with rule/action/player; off or wrong kind → null", () => {
  const alerts = {
    adminPing: { enabled: false, channelId: null, mentionRoleId: null, trigger: "!admin" },
    watchlist: { enabled: false, channelId: null, mentionRoleId: null },
    automation: { enabled: true, channelId: "C_AUTO", mentionRoleId: "R1" },
    serverDark: { enabled: false, channelId: null, mentionRoleId: null },
  };
  const evt = {
    kind: "app.enforcement", serverId: "s1", actorName: "Frigo",
    data: { ruleName: "TK guard", action: "tempban", hours: 24, reason: "8 team kills in 30s", dryRun: false, error: null },
  };
  const a = matchAutomation(evt, alerts, "LYNX 1");
  assert.ok(a);
  assert.equal(a!.channelId, "C_AUTO");
  assert.equal(a!.mentionRoleId, "R1");
  assert.match(a!.text, /Rule fired/);
  assert.match(a!.text, /tempban 24h/);
  assert.match(a!.text, /Frigo/);
  assert.match(a!.text, /TK guard/);
  assert.match(a!.text, /LYNX 1/);

  // dry-run and failure are labeled
  const dry = matchAutomation({ ...evt, data: { ...evt.data, dryRun: true } }, alerts);
  assert.match(dry!.text, /dry-run/);
  const failed = matchAutomation({ ...evt, data: { ...evt.data, error: "boom" } }, alerts);
  assert.match(failed!.text, /FAILED/);

  // A "blacklist" firing is a real ban and says so — the legacy key never reaches staff, and a
  // temp removal names its length just like a tempban does.
  const tempBan = matchAutomation({ ...evt, data: { ...evt.data, action: "blacklist", hours: 48 } }, alerts);
  assert.match(tempBan!.text, /\*\*ban 48h\*\*/);
  assert.doesNotMatch(tempBan!.text, /blacklist/);
  const permBan = matchAutomation({ ...evt, data: { ...evt.data, action: "blacklist", hours: null } }, alerts);
  assert.match(permBan!.text, /permanent ban/);

  // disabled / missing channel / other kinds → null
  assert.equal(matchAutomation(evt, { ...alerts, automation: { ...alerts.automation, enabled: false } }), null);
  assert.equal(matchAutomation(evt, { ...alerts, automation: { ...alerts.automation, channelId: null } }), null);
  assert.equal(matchAutomation({ ...evt, kind: "evt.kill" }, alerts), null);
});

/**
 * The alert config is a jsonb column, so a section can simply not be there — a row written before
 * that section existed, or one edited by hand. Every event on that server runs through all three
 * matchers, so `alerts.adminPing.enabled` on such a row is not a degraded alert: it is a TypeError
 * on every event, which with crash handlers installed is the bot exiting and exiting again on the
 * next event after the restart. A missing section means the alert is off.
 */
test("a config missing a section reads as off, not as a crash", () => {
  const chat = { kind: "evt.chat.team", serverId: "s1", actorName: "Bob", data: { message: "!admin help" } };
  const join = { kind: "evt.player.connected", serverId: "s1", actorName: "Bob", actorPlayerId: "p1" };
  const fired = { kind: "app.enforcement", serverId: "s1", actorName: "Bob", data: { action: "kick" } };

  // Each matcher, against a config that is missing exactly its own section.
  const partial = alerts() as unknown as Record<string, unknown>;
  assert.equal(matchAdminPing(chat, { ...partial, adminPing: undefined } as never), null);
  assert.equal(matchWatchlist(join, { ...partial, watchlist: undefined } as never, true), null);
  assert.equal(matchAutomation(fired, { ...partial, automation: undefined } as never), null);

  // And against no config at all, which is what an empty jsonb column deserializes to.
  for (const empty of [{}, null, undefined]) {
    assert.equal(matchAdminPing(chat, empty as never), null);
    assert.equal(matchWatchlist(join, empty as never, true), null);
    assert.equal(matchAutomation(fired, empty as never), null);
  }
});

/*
 * Per-rule pinging. The server-wide alert says WHERE rule firings go; each rule says whether it is
 * one of them. Both have to agree — an all-or-nothing channel is how a noisy idle-kick rule gets
 * the whole thing muted, taking the twice-a-week temp bans with it.
 */
test("matchAutomation: a rule that opted out of pinging is silent, and an absent flag still pings", () => {
  const alerts = {
    adminPing: { enabled: false, channelId: null, mentionRoleId: null, trigger: "!admin" },
    watchlist: { enabled: false, channelId: null, mentionRoleId: null },
    automation: { enabled: true, channelId: "C_AUTO", mentionRoleId: null },
    serverDark: { enabled: false, channelId: null, mentionRoleId: null },
  };
  const evt = (alertEnabled?: boolean) => ({
    kind: "app.enforcement", serverId: "s1", actorName: "Frigo",
    data: { ruleName: "Idle kick", action: "kick", reason: null, hours: null, dryRun: false, error: null,
      ...(alertEnabled === undefined ? {} : { alertEnabled }) },
  });
  assert.equal(matchAutomation(evt(false), alerts), null, "the rule was silenced");
  assert.ok(matchAutomation(evt(true), alerts), "the rule opted in");
  // Absent = on: an event from before the field existed, or from any other publisher, must not go
  // silently unreported — the same defensive reading the rest of this file applies to config.
  assert.ok(matchAutomation(evt(undefined), alerts), "an absent flag is not a refusal");
  // The rule's own switch never overrides the server's: alert off = nothing, whatever the rule says.
  assert.equal(matchAutomation(evt(true), { ...alerts, automation: { ...alerts.automation, enabled: false } }), null);
});

/*
 * A firing on ONE player links that player's profile: the enforcer sends the finished link, and
 * the alert prints it after the name with fixed words. Reports about many players — a group
 * schedule, the safety breaker — send none, and nothing but an http(s) link is ever printed.
 */
test("matchAutomation: a firing on one player links their profile", () => {
  const alerts = {
    adminPing: { enabled: false, channelId: null, mentionRoleId: null, trigger: "!admin" },
    watchlist: { enabled: false, channelId: null, mentionRoleId: null },
    automation: { enabled: true, channelId: "C_AUTO", mentionRoleId: null },
    serverDark: { enabled: false, channelId: null, mentionRoleId: null },
  };
  const url = "https://admin.example.com/#/players/~9b2f0c1e-0000-4000-8000-000000000001";
  const evt = (extra: Record<string, unknown> = {}) => ({
    kind: "app.enforcement", serverId: "s1", actorName: "Newsted",
    data: { ruleName: "8 tks in 10s=24hr", action: "tempban", hours: 24, reason: "teamkilling is not allowed", dryRun: false, error: null, profileUrl: url, ...extra },
  });

  const linked = matchAutomation(evt(), alerts, "WW2");
  assert.equal(linked!.text, `🤖 **Rule fired** on **WW2** — **tempban 24h** → **Newsted** ([profile](<${url}>)) · rule “8 tks in 10s=24hr” (teamkilling is not allowed)`);
  // The dry-run and failure labels still close the line.
  assert.match(matchAutomation(evt({ dryRun: true }), alerts, "WW2")!.text, /\)\) · rule .* — dry-run/);

  // No link, or anything that is not an http(s) one: the line is exactly as before.
  const plain = matchAutomation(evt({ profileUrl: null }), alerts, "WW2");
  assert.equal(plain!.text, "🤖 **Rule fired** on **WW2** — **tempban 24h** → **Newsted** · rule “8 tks in 10s=24hr” (teamkilling is not allowed)");
  assert.doesNotMatch(matchAutomation(evt({ profileUrl: undefined }), alerts, "WW2")!.text, /profile/);
  assert.doesNotMatch(matchAutomation(evt({ profileUrl: "javascript:alert(1)" }), alerts, "WW2")!.text, /profile/);
  assert.doesNotMatch(matchAutomation(evt({ profileUrl: "https://x.example/a) [boom](https://evil.example" }), alerts, "WW2")!.text, /profile/, "a link that could break out of the markdown is dropped");

  // A group schedule's report names a group, not a player: nothing to link.
  const group = matchAutomation({ kind: "app.enforcement", actorName: "WW2 CVC", data: { ruleName: "Monthly CVC VIP", action: "vip", reason: "granted VIP to 12 of 15 members", dryRun: false, error: null, communityWide: true } },
    communityAutomationConfig([alerts] as never));
  assert.doesNotMatch(group!.text, /profile/);
});

/*
 * Per-rule CHANNELS. One shared channel for every rule is exactly what got it muted; a rule can
 * now carry its own destination. The channel on the rule stands alone — an explicit "ping HERE"
 * must not go quiet because the server-wide default alert is off — while rules without one keep
 * flowing to the shared channel exactly as before.
 */
test("matchAutomation: a rule's own channel wins, and stands alone when the shared alert is off", () => {
  const alerts = {
    adminPing: { enabled: false, channelId: null, mentionRoleId: null, trigger: "!admin" },
    watchlist: { enabled: false, channelId: null, mentionRoleId: null },
    automation: { enabled: true, channelId: "C_SHARED", mentionRoleId: "R1" },
    serverDark: { enabled: false, channelId: null, mentionRoleId: null },
  };
  const evt = (extra: Record<string, unknown> = {}) => ({
    kind: "app.enforcement", serverId: "s1", actorName: "CamAdmin",
    data: { ruleName: "cam watch", action: "note", reason: null, hours: null, dryRun: false, error: null, ...extra },
  });

  // Own channel set → it wins over the shared one (mention role still comes from the alert).
  const own = matchAutomation(evt({ alertChannelId: "C_CAM" }), alerts);
  assert.equal(own!.channelId, "C_CAM");
  assert.equal(own!.mentionRoleId, "R1");
  // No own channel → the shared channel, exactly as before.
  assert.equal(matchAutomation(evt(), alerts)!.channelId, "C_SHARED");

  // Shared alert off entirely: the rule with its own channel still pings; the one without stays quiet.
  const off = { ...alerts, automation: { ...alerts.automation, enabled: false } };
  assert.equal(matchAutomation(evt({ alertChannelId: "C_CAM" }), off)!.channelId, "C_CAM");
  assert.equal(matchAutomation(evt(), off), null);
  // And with no automation section at all (pre-section jsonb rows), the own channel still works.
  assert.equal(matchAutomation(evt({ alertChannelId: "C_CAM" }), { ...alerts, automation: undefined } as never)!.channelId, "C_CAM");
  assert.equal(matchAutomation(evt({ alertChannelId: "C_CAM" }), { ...alerts, automation: undefined } as never)!.mentionRoleId, null);

  // The rule's own SILENCE switch still beats everything — a silenced rule pings nowhere.
  assert.equal(matchAutomation(evt({ alertChannelId: "C_CAM", alertEnabled: false }), alerts), null);
});

test("server-dark: fires on the worker's dark verdict, recovers on the recovered verdict, honors the switch", () => {
  const dark = matchServerDark({ kind: "app.server.dark", serverId: "s1", data: { minutes: 5 } }, alerts(), "Server 1");
  assert.ok(dark);
  assert.equal(dark!.channelId, "C_DARK");
  assert.equal(dark!.mentionRoleId, "R3");
  assert.match(dark!.text, /unreachable/i);
  assert.match(dark!.text, /5 minute/);
  assert.match(dark!.text, /Server 1/);

  const back = matchServerDark({ kind: "app.server.recovered", serverId: "s1", data: { minutes: 12 } }, alerts(), "Server 1");
  assert.match(back!.text, /back/i);
  assert.match(back!.text, /12 minute/);

  // Off, no channel, or an unrelated event → nothing.
  assert.equal(matchServerDark({ kind: "app.server.dark", data: { minutes: 5 } }, alerts({ serverDark: { enabled: false, channelId: "C", mentionRoleId: null } })), null);
  assert.equal(matchServerDark({ kind: "app.server.dark", data: { minutes: 5 } }, alerts({ serverDark: { enabled: true, channelId: null, mentionRoleId: null } })), null);
  assert.equal(matchServerDark({ kind: "evt.kill", data: { minutes: 5 } }, alerts()), null);
  // A config row from before this alert existed (section missing) reads as OFF, never a throw.
  assert.equal(matchServerDark({ kind: "app.server.dark", data: { minutes: 5 } }, alerts({ serverDark: undefined as never })), null);
});

test("a community-wide rule's report: its own channel, else the first server reporting automation, else nowhere", () => {
  const off = { automation: { enabled: false, channelId: "C_OFF", mentionRoleId: null } };
  const on = { automation: { enabled: true, channelId: "C_AUTO", mentionRoleId: "R2" } };
  const evt = {
    kind: "app.enforcement", actorName: "WW2 CVC",
    data: { ruleName: "Monthly CVC VIP", action: "vip", reason: "granted VIP to 12 of 15 members", dryRun: false, error: null, communityWide: true },
  };
  const picked = communityAutomationConfig([off, on] as never);
  const a = matchAutomation(evt, picked);
  assert.equal(a!.channelId, "C_AUTO");
  assert.equal(a!.mentionRoleId, "R2");
  assert.doesNotMatch(a!.text, / on \*\*/, "no one server named");
  assert.equal(matchAutomation(evt, communityAutomationConfig([off] as never)), null, "no server reports automation");
  const own = matchAutomation({ ...evt, data: { ...evt.data, alertChannelId: "C_RULE" } }, communityAutomationConfig([off] as never));
  assert.equal(own!.channelId, "C_RULE", "the rule's own channel stands alone");
});

test("an alert shows the player's name and words as written: no disguised link, no stray formatting", () => {
  const a = matchAdminPing({ kind: "evt.chat.team", actorName: "B_ob", data: { message: "!admin [help](https://evil.example)" } }, alerts(), "Server 1");
  assert.ok(a);
  assert.ok(a!.text.includes("**B\\_ob**: \\[help\\](https://evil.example)"), a!.text);
  const w = matchWatchlist({ kind: "evt.player.connected", actorName: "*Sneaky*" }, alerts(), { watched: true, reason: "uses *walls*", by: "_Head_" });
  assert.ok(w!.text.includes("**\\*Sneaky\\***"), w!.text);
  // Staff words are quoted as they wrote them too.
  assert.ok(w!.text.includes("“uses \\*walls\\*” (watched by \\_Head\\_)"), w!.text);
  const r = matchAutomation({ kind: "app.enforcement", actorName: "Eve", data: { ruleName: "No_links", action: "kick", reason: "said [x](https://evil.example)", alertChannelId: "C1" } }, alerts());
  assert.ok(r!.text.includes("(said \\[x\\](https://evil.example))"), r!.text);
  assert.ok(r!.text.includes("rule “No\\_links”"), r!.text);
});
