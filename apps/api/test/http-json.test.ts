/**
 * JSON answers go packed for a client that takes it. A players list of 300 rows is 95 KB as JSON
 * and 6 KB packed; on a phone, or through the tunnel up a home connection, the size was the wait.
 *
 * The answer counts as sent the moment sendJson is called (headersSent), as it did before packing
 * took a moment: the request handler's error path and the plugin route each answer only when
 * nothing has been, and must not start a second answer while the first is being packed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { sendJson } from "../dist/http.js";

const big = { players: Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, lastSeen: "2026-10-27T21:00:00.000Z", kills: i * 13 })) };

async function withJson(answer: (res: ServerResponse) => void, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_req, res) => answer(res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}/`); } finally { server.close(); }
}

function rawGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a JSON answer goes packed for a client that takes it, and counts as sent at once", async () => {
  const sentAtOnce: boolean[] = [];
  await withJson((res) => { sendJson(res, 200, big); sentAtOnce.push(res.headersSent); }, async (url) => {
    const json = JSON.stringify(big);
    const br = await rawGet(url, { "accept-encoding": "gzip, deflate, br" });
    assert.equal(br.status, 200);
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(br.headers["vary"], "accept-encoding");
    assert.equal(br.headers["cache-control"], "no-store", "still never cached");
    assert.match(String(br.headers["content-type"]), /^application\/json/);
    assert.ok(br.body.length < json.length / 5, `packed ${br.body.length} of ${json.length} bytes`);
    assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString()), big);

    const gz = await rawGet(url, { "accept-encoding": "gzip" });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString()), big);

    const plain = await rawGet(url);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(plain.body.toString()), big);
  });
  assert.deepEqual(sentAtOnce, [true, true, true], "headersSent as soon as sendJson returns, packed or not");
});

test("a small JSON answer, and an error's, go as they are; a status survives packing", async () => {
  await withJson((res) => sendJson(res, 200, { ok: true }), async (url) => {
    const small = await rawGet(url, { "accept-encoding": "br" });
    assert.equal(small.headers["content-encoding"], undefined, "too small to gain");
    assert.deepEqual(JSON.parse(small.body.toString()), { ok: true });
  });
  await withJson((res) => sendJson(res, 404, { error: { message: "no such player" }, ...big }), async (url) => {
    const missing = await rawGet(url, { "accept-encoding": "br" });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers["content-encoding"], "br");
    assert.equal(JSON.parse(brotliDecompressSync(missing.body).toString()).error.message, "no such player");
  });
});
