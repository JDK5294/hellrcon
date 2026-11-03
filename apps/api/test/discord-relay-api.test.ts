import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiscordRelay } from "../dist/routes/kit.js";
import { withServer, jf, ownerAuth } from "./harness.ts";

async function makeServer(base: string, auth: Record<string, string>) {
  const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "dc", host: "127.0.0.1", port: 1, password: "x" }) });
  return created.body.server.id as string;
}

test("discord relay GET returns defaults + categories, then round-trips a PUT", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    const initial = await jf(`${base}/api/servers/${id}/discord`, { headers: auth });
    assert.equal(initial.status, 200);
    assert.equal(initial.body.configured, false);
    assert.equal(initial.body.config.enabled, false);
    assert.deepEqual(initial.body.categories, ["kills", "chat", "admin", "connections", "match"]);

    const put = await jf(`${base}/api/servers/${id}/discord`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, categories: ["kills", "admin"], channels: { kills: "123456789012345", admin: "  ", chat: "" },
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.enabled, true);
    assert.deepEqual(put.body.config.categories, ["kills", "admin"]);
    assert.equal(put.body.config.channels.kills, "123456789012345");
    assert.equal(put.body.config.channels.admin, null); // blank cleared
    assert.equal(put.body.config.channels.chat, null);

    const after = await jf(`${base}/api/servers/${id}/discord`, { headers: auth });
    assert.equal(after.body.configured, true);
    assert.equal(after.body.config.channels.kills, "123456789012345");

    const audit = await jf(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "discord.relay.config"));
  });
});

test("discord relay PUT validation + test-send guards", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/discord`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    assert.equal((await put({ categories: "nope" })).status, 400);
    assert.equal((await put({ categories: ["bogus"] })).status, 400);
    assert.equal((await put({ channels: { kills: "not-a-number" } })).status, 400);
    assert.equal((await put({ channels: { bogus: "123456" } })).status, 400);
    assert.equal((await jf(`${base}/api/servers/nope/discord`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) })).status, 404);

    // test-send: unknown category → 400; and with no DISCORD_TOKEN in the test env → 409 before any network.
    assert.equal((await jf(`${base}/api/servers/${id}/discord/test`, { method: "POST", headers: auth, body: JSON.stringify({ category: "bogus" }) })).status, 400);
    const noToken = await jf(`${base}/api/servers/${id}/discord/test`, { method: "POST", headers: auth, body: JSON.stringify({ category: "kills" }) });
    assert.ok(noToken.status === 409 || noToken.status === 400, "test-send is refused without a token/channel");
  });
});

test("discord alerts round-trip + validation", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);

    // Defaults present on GET.
    const initial = await jf(`${base}/api/servers/${id}/discord`, { headers: auth });
    assert.equal(initial.body.config.alerts.adminPing.enabled, false);
    assert.equal(initial.body.config.alerts.adminPing.trigger, "!admin");

    const put = await jf(`${base}/api/servers/${id}/discord`, { method: "PUT", headers: auth, body: JSON.stringify({
      alerts: {
        adminPing: { enabled: true, channelId: "111111111111", mentionRoleId: "222222222222", trigger: "@staff" },
        watchlist: { enabled: true, channelId: "333333333333", mentionRoleId: "" },
      },
    }) });
    assert.equal(put.status, 200);
    assert.equal(put.body.config.alerts.adminPing.trigger, "@staff");
    assert.equal(put.body.config.alerts.adminPing.mentionRoleId, "222222222222");
    assert.equal(put.body.config.alerts.watchlist.channelId, "333333333333");
    assert.equal(put.body.config.alerts.watchlist.mentionRoleId, null); // blank cleared

    // Validation: non-numeric channel id, non-numeric role id, empty trigger.
    const bad = (alerts: unknown) => jf(`${base}/api/servers/${id}/discord`, { method: "PUT", headers: auth, body: JSON.stringify({ alerts }) });
    assert.equal((await bad({ adminPing: { channelId: "abc" } })).status, 400);
    assert.equal((await bad({ watchlist: { mentionRoleId: "xyz" } })).status, 400);
    assert.equal((await bad({ adminPing: { trigger: "" } })).status, 400);
  });
});

test("status board: round-trip, the worker's message id survives a save, and a channel change drops it", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    const put = (body: unknown) => jf(`${base}/api/servers/${id}/discord`, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    const initial = await jf(`${base}/api/servers/${id}/discord`, { headers: auth });
    assert.equal(initial.body.config.statusBoard.enabled, false);
    assert.equal(initial.body.config.statusBoard.messageId, null);
    assert.equal(initial.body.config.statusBoard.intervalSec, 60);

    const saved = await put({ statusBoard: { enabled: true, channelId: "123456789012345", intervalSec: 90 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.statusBoard.enabled, true);
    assert.equal(saved.body.config.statusBoard.channelId, "123456789012345");
    assert.equal(saved.body.config.statusBoard.intervalSec, 90);

    // The message id is the worker's state, not a form field: a client that sends one is ignored.
    const spoofed = await put({ statusBoard: { enabled: true, channelId: "123456789012345", intervalSec: 120, messageId: "999" } });
    assert.equal(spoofed.body.config.statusBoard.messageId, null, "the panel cannot set the message id");
    assert.equal(spoofed.body.config.statusBoard.intervalSec, 120);

    // The headline the operator types, kept exactly as typed apart from surrounding whitespace.
    const titled = await put({ statusBoard: { title: "  The [LYNX] Division  " } });
    assert.equal(titled.body.config.statusBoard.title, "The [LYNX] Division");
    // Cleared back to the derived headline by emptying the box, not by a separate control.
    assert.equal((await put({ statusBoard: { title: "" } })).body.config.statusBoard.title, null);

    // Validation.
    assert.equal((await put({ statusBoard: "nope" })).status, 400);
    assert.equal((await put({ statusBoard: { title: "x".repeat(49) } })).status, 400);
    assert.equal((await put({ statusBoard: { channelId: "not-numeric" } })).status, 400);
    assert.equal((await put({ statusBoard: { intervalSec: 5 } })).status, 400);
    assert.equal((await put({ statusBoard: { intervalSec: 99999 } })).status, 400);

    // A partial patch leaves the untouched fields alone.
    const partial = await put({ statusBoard: { enabled: false } });
    assert.equal(partial.body.config.statusBoard.channelId, "123456789012345");
    assert.equal(partial.body.config.statusBoard.intervalSec, 120);

    // Moving channels abandons the old message rather than editing one that isn't there.
    const moved = await put({ statusBoard: { channelId: "555555555555" } });
    assert.equal(moved.body.config.statusBoard.messageId, null);
    assert.equal(moved.body.config.statusBoard.channelId, "555555555555");
  });
});

test("a config save carries the worker's board message id through, and only a channel change clears it", () => {
  const existing = { statusBoard: { enabled: true, channelId: "111111111111", messageId: "m-1", intervalSec: 60, imageName: "foy-day.webp", title: "The [LYNX] Division" } };

  // Editing anything else must leave the id alone: losing it makes the next worker tick post a
  // SECOND board, which is the one failure mode the whole design exists to rule out.
  const same = parseDiscordRelay({ statusBoard: { intervalSec: 300 } }, existing);
  assert.ok("value" in same);
  assert.equal(same.value.statusBoard!.messageId, "m-1");
  assert.equal(same.value.statusBoard!.channelId, "111111111111");
  assert.equal(same.value.statusBoard!.enabled, true);

  // Turning the board off keeps the id too — it is still the message we own, and switching back on
  // should resume editing it rather than leave an orphan behind.
  const off = parseDiscordRelay({ statusBoard: { enabled: false } }, existing);
  assert.ok("value" in off);
  assert.equal(off.value.statusBoard!.messageId, "m-1");

  // The artwork is attached to that message, so it survives with it.
  assert.equal(same.value.statusBoard!.imageName, "foy-day.webp");
  // The headline is not attached to anything, so it survives a channel move as well as an edit.
  assert.equal(same.value.statusBoard!.title, "The [LYNX] Division");

  // A different channel makes the id meaningless: it names a message we are no longer drawing in.
  const moved = parseDiscordRelay({ statusBoard: { channelId: "222222222222" } }, existing);
  assert.ok("value" in moved);
  assert.equal(moved.value.statusBoard!.messageId, null);
  assert.equal(moved.value.statusBoard!.imageName, null, "the picture is abandoned with the message");
  assert.equal(moved.value.statusBoard!.title, "The [LYNX] Division", "the headline is not the message's");

  // No stored row at all: defaults, and nothing invented.
  const fresh = parseDiscordRelay({ statusBoard: { enabled: true, channelId: "333333333333" } }, null);
  assert.ok("value" in fresh);
  assert.deepEqual(fresh.value.statusBoard, { enabled: true, channelId: "333333333333", intervalSec: 60, messageId: null, imageName: null, title: null });

  // Relay edits that never mention the board leave it entirely out of the patch.
  const unrelated = parseDiscordRelay({ enabled: true }, existing);
  assert.ok("value" in unrelated);
  assert.equal(unrelated.value.statusBoard, undefined);
});

test("discord relay config gated by server.config; unauthenticated is 401", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const id = await makeServer(base, auth);
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jf(`${base}/api/servers/${id}/discord`, { headers: plain })).status, 403);
    // A server-scoped WRITE without the permission is filed for approval now (202), not
    // refused — the read half beside it still is. See docs/approvals.md.
    assert.equal((await jf(`${base}/api/servers/${id}/discord`, { method: "PUT", headers: plain, body: JSON.stringify({ enabled: true }) })).status, 202);
    assert.equal((await jf(`${base}/api/servers/${id}/discord`)).status, 401);
  });
});
