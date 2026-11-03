/**
 * The match board badge: uploaded in the panel, kept by the store, read back as the image itself.
 * Nothing is built in (one community's badge used to ship inside the program, on every install's
 * board), an upload is judged by its own bytes, and it answers to the match board's permission.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth, assertAsked } from "./harness.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 255]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

const badge = (base: string, auth: Record<string, string>, opts: RequestInit = {}) =>
  fetch(`${base}/api/discord/board-badge`, { ...opts, headers: { ...auth, ...(opts.headers as Record<string, string> | undefined) } });
const upload = (base: string, auth: Record<string, string>, body: Buffer, type = "application/octet-stream") =>
  badge(base, auth, { method: "PUT", headers: { "content-type": type }, body });

async function staffAuth(base: string, owner: Record<string, string>, username: string, grants: { capability: string; level: string; scopeType?: string; scopeId?: string | null }[]) {
  const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username, password: "pw" }) });
  const put = await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
    method: "PUT", headers: owner,
    body: JSON.stringify({ grants: grants.map((g) => ({ scopeType: "global", scopeId: null, ...g })) }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

test("match board badge: none until one is uploaded, the same bytes back, replaced whole, removed", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    assert.equal((await badge(base, auth)).status, 404, "nothing is built in");

    const put = await upload(base, auth, PNG);
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, mime: "image/png", bytes: PNG.length });
    const got = await badge(base, auth);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG, "byte for byte");

    // Typed by its own bytes, not by what the upload said it was.
    assert.equal((await upload(base, auth, JPG, "image/png")).status, 200);
    const again = await badge(base, auth);
    assert.equal(again.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), JPG, "the new one replaces the old whole");

    const del = await jf(`${base}/api/discord/board-badge`, { method: "DELETE", headers: auth });
    assert.equal(del.status, 200);
    assert.equal(del.body.removed, true);
    assert.equal((await badge(base, auth)).status, 404);
    const twice = await jf(`${base}/api/discord/board-badge`, { method: "DELETE", headers: auth });
    assert.equal(twice.body.removed, false, "nothing left to remove");

    // The trail says what happened, once each: removing nothing is not news.
    const audit = await jf(`${base}/api/audit`, { headers: auth });
    const lines = (audit.body.entries as { action: string; summary: string }[]).filter((e) => e.action === "discord.board-badge").map((e) => e.summary);
    assert.deepEqual(lines.sort(), ["removed the match board badge", "replaced the match board badge", "set the match board badge"]);
  });
});

test("match board badge: only a PNG, JPG or WebP of 2 MB or less is taken", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    const text = await upload(base, auth, Buffer.from("not an image at all"), "image/png");
    assert.equal(text.status, 400);
    assert.match(((await text.json()) as { error: { message: string } }).error.message, /must be a PNG, JPG or WebP image/);
    assert.equal((await upload(base, auth, Buffer.alloc(0))).status, 400, "an empty upload is no image");

    const big = Buffer.concat([PNG, Buffer.alloc(2_000_001 - PNG.length)]);
    const tooBig = await upload(base, auth, big);
    assert.equal(tooBig.status, 400);
    assert.match(((await tooBig.json()) as { error: { message: string } }).error.message, /larger than 2 MB/);
    assert.equal((await badge(base, auth)).status, 404, "a refused upload stores nothing");

    assert.equal((await upload(base, auth, Buffer.concat([PNG, Buffer.alloc(2_000_000 - PNG.length)]))).status, 200, "exactly 2 MB is taken");
    assert.equal((await upload(base, auth, WEBP)).status, 200);
    assert.equal((await badge(base, auth)).headers.get("content-type"), "image/webp");
  });
});

test("match board badge: seen with the match board's permission anywhere, changed only with it for every server", async () => {
  await withServer(async (base) => {
    const owner = await ownerAuth(base);
    const made = await jf(`${base}/api/servers`, { method: "POST", headers: owner, body: JSON.stringify({ name: "Alpha", host: "127.0.0.1", port: 1, password: "x" }) });
    const serverId = made.body.server.id as string;

    const nobody = await staffAuth(base, owner, "nobody", []);
    assert.equal((await badge(base, nobody)).status, 403, "no match board permission, no badge");

    const reader = await staffAuth(base, owner, "reader", [{ capability: "discord.relay", level: "read" }]);
    assert.equal((await badge(base, reader)).status, 404, "a reader may look");
    assert.equal((await upload(base, reader, PNG)).status, 403, "an upload is never filed for approval: the file cannot wait in a request");
    assertAsked(await jf(`${base}/api/discord/board-badge`, { method: "DELETE", headers: reader }), "removing it is asked for, like any write");

    // One badge on every server's board: the match board's permission for one server sees it, but is
    // not enough to change it for all of them.
    const oneServer = await staffAuth(base, owner, "oneserver", [{ capability: "discord.relay", level: "write", scopeType: "server", scopeId: serverId }]);
    assert.equal((await badge(base, oneServer)).status, 404, "a one-server manager may look");
    assert.equal((await upload(base, oneServer, PNG)).status, 403, "but not change every server's board");
    const everyServer = await staffAuth(base, owner, "everyserver", [{ capability: "discord.relay", level: "write" }]);
    assert.equal((await upload(base, everyServer, PNG)).status, 200);
    assert.equal((await badge(base, reader)).status, 200, "and everyone who may see it sees the same one");
  });
});
