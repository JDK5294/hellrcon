/**
 * The VIP reconcile route, driven against the fake game server — including the incident that
 * forced the feature: a server whose VIP list is EMPTY while the grants table is full. The fake's
 * `vips` map can be wiped mid-test, which is exactly what happened in production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGameServer } from "./fake-hll-server.ts";
import { withServer } from "./harness.ts";

async function jsonFetch(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function ownerToken(base: string): Promise<string> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return login.body.token as string;
}

test("the wiped-list incident: dry-run names every missing grant; apply restores them and read-back verifies", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      // Three grants through the real route — the fake's VIP list records them...
      for (const pid of ["v1", "v2", "v3"]) {
        await jsonFetch(`${base}/api/servers/${serverId}/vips`, {
          method: "POST", headers: auth, body: JSON.stringify({ playerId: pid, playerName: `Player ${pid}`, mode: "permanent", comment: "donor" }),
        });
      }
      assert.equal(fake.vips.size, 3);

      // ...and then the server loses them, the way the real one did. Nothing notices.
      fake.vips.clear();

      // Dry-run: the plan says what is wrong and writes nothing.
      const plan = await jsonFetch(`${base}/api/servers/${serverId}/vips/reconcile`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.equal(plan.body.applied, false);
      assert.equal(plan.body.onGame, 0);
      assert.equal((plan.body.apply as unknown[]).length, 3);
      assert.equal(fake.vips.size, 0, "a dry-run must not write");

      // Apply: the grants land back on the game, and the response proves it by re-reading.
      const r = await jsonFetch(`${base}/api/servers/${serverId}/vips/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((r.body.restored as string[]).length, 3);
      assert.equal(r.body.before, 0);
      assert.equal(r.body.after, 3);
      assert.equal(r.body.warning, undefined);
      assert.equal(fake.vips.size, 3, "the game holds the list again");
      // The display NAME reaches the game, never the raw id — same rule as the grant route.
      assert.equal(fake.vips.get("v1")?.comment, "Player v1");
    } finally {
      fake.close();
    }
  });
});

test("a paused VIP is removed from the game and never re-added; foreign entries are left alone", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      await jsonFetch(`${base}/api/servers/${serverId}/vips`, {
        method: "POST", headers: auth, body: JSON.stringify({ playerId: "timeout-guy", playerName: "Timeout Guy", mode: "permanent", comment: "donor" }),
      });
      // A VIP timeout: the row survives, the game entry must stay gone for a week. (Set via the
      // repo — the pause route's own tests cover its HTTP surface.)
      await repo.vips.setPause(serverId, "timeout-guy", {
        until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reason: "test", by: "admin", mode: "running",
      });
      // The game still lists them (as if the entry crept back via a restore), plus one entry
      // nobody granted through the panel.
      fake.vips.set("console-granted", { playerId: "console-granted", comment: "old bot" });

      const r = await jsonFetch(`${base}/api/servers/${serverId}/vips/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.removed, ["timeout-guy"], "the paused VIP's game entry is removed");
      assert.deepEqual(r.body.restored, [], "and NOT re-added — that would undo the timeout");
      assert.equal(fake.vips.has("timeout-guy"), false);
      assert.equal(fake.vips.has("console-granted"), true, "foreign entries are reported, never touched");
      assert.equal((r.body.foreign as { playerId: string }[])[0]?.playerId, "console-granted");
    } finally {
      fake.close();
    }
  });
});
