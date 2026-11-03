/**
 * Serving the built panel from disk. What is pinned here is the failure path, because that is the
 * one that used to be fatal.
 *
 * `createReadStream` opens lazily: it never throws where it is called, it emits `error` a tick
 * later. The old code wrapped it in a `try/catch`, which therefore caught nothing, and an `error`
 * on a stream with no listener is an unhandled `error` event — a thrown exception with no request
 * to attach it to. A WEB_ROOT pointing one directory too high, or an export missing index.html,
 * meant the FIRST browser request took the process down instead of answering 404.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serveStatic } from "../dist/static.js";

async function withRoot(root: string | null, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    void serveStatic(req, res, root, new URL(req.url ?? "/", "http://x").pathname);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

test("a real file is served with its own content type", async () => {
  const root = mkdtempSync(join(tmpdir(), "webroot-"));
  try {
    writeFileSync(join(root, "index.html"), "<h1>panel</h1>");
    mkdirSync(join(root, "_next"));
    writeFileSync(join(root, "_next", "app.js"), "console.log(1)");
    writeFileSync(join(root, "manifest.webmanifest"), JSON.stringify({ name: "panel", orientation: "any" }));
    await withRoot(root, async (base) => {
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(await page.text(), "<h1>panel</h1>");

      // An unknown path is the SPA falling back to the shell, not a 404.
      const deep = await fetch(`${base}/community/notices`);
      assert.equal(deep.status, 200);
      assert.equal(await deep.text(), "<h1>panel</h1>");

      const asset = await fetch(`${base}/_next/app.js`);
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /javascript/);

      // The home-screen manifest goes out as one: a phone reading it decides how the panel opens.
      const manifest = await fetch(`${base}/manifest.webmanifest`);
      assert.equal(manifest.status, 200);
      assert.match(manifest.headers.get("content-type") ?? "", /^application\/manifest\+json/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cache headers: hashed bundles forever, HTML never without asking, other assets an hour", async () => {
  // Before these headers existed browsers cached HEURISTICALLY, and index.html — which names the
  // content-hashed bundles — could be replayed for ten-plus minutes after an update: a stale panel
  // against a new API, which is exactly the version-skew and "my permissions haven't shown up"
  // reports from the field.
  const root = mkdtempSync(join(tmpdir(), "webroot-cache-"));
  try {
    writeFileSync(join(root, "index.html"), "<h1>panel</h1>");
    mkdirSync(join(root, "_next", "static", "chunks"), { recursive: true });
    writeFileSync(join(root, "_next", "static", "chunks", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(root, "icon.svg"), "<svg/>");
    await withRoot(root, async (base) => {
      const hashed = await fetch(`${base}/_next/static/chunks/app-abc123.js`);
      assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");

      // The shell itself, and the SPA fallback serving it under another name, both revalidate.
      for (const path of ["/", "/index.html", "/community/notices"]) {
        const page = await fetch(`${base}${path}`);
        assert.equal(page.headers.get("cache-control"), "no-cache", `${path} must revalidate`);
      }

      const asset = await fetch(`${base}/icon.svg`);
      assert.equal(asset.headers.get("cache-control"), "public, max-age=3600");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a web root with no index.html answers 404 instead of taking the process down", async () => {
  // The misconfiguration this is really about: WEB_ROOT set to a directory that exists but is not
  // a panel build. Every request falls through to the SPA shell, which is not there.
  const root = mkdtempSync(join(tmpdir(), "webroot-empty-"));
  try {
    await withRoot(root, async (base) => {
      for (const path of ["/", "/anything", "/stats/some-slug"]) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 404, `${path} answers, rather than killing the server`);
        assert.equal(await res.text(), "not found");
      }
      // Still serving: the point is that the first bad request did not end the process.
      assert.equal((await fetch(`${base}/`)).status, 404);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no WEB_ROOT at all says so, rather than looking like a missing page", async () => {
  await withRoot(null, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /WEB_ROOT/);
  });
});

test("a path that climbs out of the web root cannot reach the host's files", async () => {
  const root = mkdtempSync(join(tmpdir(), "webroot-esc-"));
  try {
    writeFileSync(join(root, "index.html"), "<h1>panel</h1>");
    writeFileSync(join(root, "..", "secret-neighbour.txt"), "not yours");
    await withRoot(root, async (base) => {
      // Both spellings land on the SPA shell — the traversal is stripped, not followed.
      for (const path of ["/../secret-neighbour.txt", "/..%2fsecret-neighbour.txt"]) {
        const res = await fetch(`${base}${path}`);
        assert.notEqual(await res.text(), "not yours", `${path} must not escape the web root`);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(root, "..", "secret-neighbour.txt"), { force: true });
  }
});

/** One GET with exactly these headers, and the raw bytes that came back (fetch would unpack them). */
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

/*
 * The panel's code went out as it is on disk: 3 MB of text that packs to under 1 MB, which on a
 * phone — or through the tunnel, up a home connection — was most of the wait. Its text files now go
 * packed for a browser that takes it (brotli, else gzip), packed once and kept in memory; pictures
 * are packed already and go as they are, as does anything too small to gain.
 */
test("the panel's text files go packed for a browser that takes it; pictures and tiny files as they are", async () => {
  const root = mkdtempSync(join(tmpdir(), "webroot-pack-"));
  try {
    const code = Array.from({ length: 400 }, (_, i) => `export const line${i} = "the panel's code, line ${i}";`).join("\n");
    const page = `<!doctype html><title>panel</title>${"<p>shell</p>".repeat(200)}`;
    mkdirSync(join(root, "_next", "static", "chunks"), { recursive: true });
    writeFileSync(join(root, "_next", "static", "chunks", "app-abc123.js"), code);
    writeFileSync(join(root, "index.html"), page);
    writeFileSync(join(root, "tiny.js"), "console.log(1)");
    writeFileSync(join(root, "picture.webp"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251)));
    await withRoot(root, async (base) => {
      const js = `${base}/_next/static/chunks/app-abc123.js`;
      const br = await rawGet(js, { "accept-encoding": "gzip, deflate, br" });
      assert.equal(br.status, 200);
      assert.equal(br.headers["content-encoding"], "br", "brotli when it is offered");
      assert.equal(br.headers["vary"], "accept-encoding");
      assert.match(String(br.headers["content-type"]), /javascript/);
      assert.equal(br.headers["cache-control"], "public, max-age=31536000, immutable", "its cache rule unchanged");
      assert.equal(Number(br.headers["content-length"]), br.body.length);
      assert.ok(br.body.length < code.length / 4, `packed ${br.body.length} of ${code.length} bytes`);
      assert.equal(brotliDecompressSync(br.body).toString(), code);
      // Kept: the second time is the same bytes.
      assert.deepEqual((await rawGet(js, { "accept-encoding": "br" })).body, br.body);

      const gz = await rawGet(js, { "accept-encoding": "gzip" });
      assert.equal(gz.headers["content-encoding"], "gzip");
      assert.equal(gunzipSync(gz.body).toString(), code);
      // q=0 refuses one.
      assert.equal((await rawGet(js, { "accept-encoding": "br;q=0, gzip" })).headers["content-encoding"], "gzip");

      const plain = await rawGet(js);
      assert.equal(plain.headers["content-encoding"], undefined, "as it is for a client that takes nothing");
      assert.equal(plain.body.toString(), code);

      // The shell, under its own name or as the fallback for a deep link.
      for (const path of ["/", "/community/notices"]) {
        const shell = await rawGet(`${base}${path}`, { "accept-encoding": "br" });
        assert.equal(shell.headers["content-encoding"], "br", path);
        assert.equal(brotliDecompressSync(shell.body).toString(), page);
      }

      const picture = await rawGet(`${base}/picture.webp`, { "accept-encoding": "br" });
      assert.equal(picture.headers["content-encoding"], undefined, "a picture is packed already");
      assert.deepEqual(picture.body, readFileSync(join(root, "picture.webp")));
      const tiny = await rawGet(`${base}/tiny.js`, { "accept-encoding": "br" });
      assert.equal(tiny.headers["content-encoding"], undefined, "too small to gain");
      assert.equal(tiny.body.toString(), "console.log(1)");

      // A new build under the same name is packed afresh, not answered from what was kept.
      writeFileSync(join(root, "index.html"), `${page}<p>new build</p>`);
      const rebuilt = await rawGet(`${base}/`, { "accept-encoding": "br" });
      assert.equal(brotliDecompressSync(rebuilt.body).toString(), `${page}<p>new build</p>`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
