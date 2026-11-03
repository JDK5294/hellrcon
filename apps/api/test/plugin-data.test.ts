import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import killfeed from "@app/plugin-killfeed";
import { createHandler, createAppContext } from "../dist/app.js";
import { jsonFetch } from "./harness.ts";

// The killfeed example no longer ships as a built-in, so these tests load it explicitly —
// it stays the reference plugin for proving the data-provider and layout pipelines.
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null }, [killfeed]);
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function token(base: string): Promise<string> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return login.body.token as string;
}

test("plugin data endpoint requires auth", async () => {
  await withServer(async (base) => {
    const r = await jsonFetch(`${base}/api/plugins/killfeed/data?key=summary`);
    assert.equal(r.status, 401);
  });
});

test("serves the example killfeed's data provider", async () => {
  await withServer(async (base) => {
    const auth = { authorization: `Bearer ${await token(base)}` };
    const r = await jsonFetch(`${base}/api/plugins/killfeed/data?key=summary`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.data, "number"); // killCount (0 in a fresh process)
  });
});

test("missing key → 400, unknown provider → 404", async () => {
  await withServer(async (base) => {
    const auth = { authorization: `Bearer ${await token(base)}` };
    const noKey = await jsonFetch(`${base}/api/plugins/killfeed/data`, { headers: auth });
    assert.equal(noKey.status, 400);
    const unknown = await jsonFetch(`${base}/api/plugins/killfeed/data?key=nope`, { headers: auth });
    assert.equal(unknown.status, 404);
    const noPlugin = await jsonFetch(`${base}/api/plugins/ghost/data?key=summary`, { headers: auth });
    assert.equal(noPlugin.status, 404);
  });
});

test("layout exposes the killfeed widget's declarative view + pluginId", async () => {
  await withServer(async (base) => {
    const auth = { authorization: `Bearer ${await token(base)}` };
    const r = await jsonFetch(`${base}/api/layout/admin`, { headers: auth });
    assert.equal(r.status, 200);
    const kf = (r.body.widgets as any[]).find((w) => w.id === "killfeed:feed");
    assert.ok(kf, "killfeed widget present");
    assert.equal(kf.pluginId, "killfeed");
    assert.ok(Array.isArray(kf.view?.blocks) && kf.view.blocks.length > 0);
  });
});
