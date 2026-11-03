import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, ownerAuth } from "./harness.ts";

/*
 * A failed analytics read must reach the page in words. It used to be a 502, and the install sits
 * behind Cloudflare, which swaps an origin 502 for its own bodyless page — so a database error on
 * the 90-day window reached staff as "the proxy in front of the API did not answer".
 */
test("a failed analytics read is a 500 that names the read and the database's reason — never a 502", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "an", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const real = repo.analytics.concurrency;
    repo.analytics.concurrency = async () => { throw new Error("could not resize shared memory segment"); };
    try {
      const r = await jf(`${base}/api/analytics/server?serverId=${id}&days=90`, { headers: auth });
      assert.equal(r.status, 500);
      const err = r.body.error as { code: string; message: string };
      assert.equal(err.code, "READ_FAILED");
      assert.match(err.message, /the concurrency read failed: could not resize shared memory segment/);
    } finally {
      repo.analytics.concurrency = real;
    }
    assert.equal((await jf(`${base}/api/analytics/server?serverId=${id}&days=90`, { headers: auth })).status, 200);
  });
});

test("analytics windows: all time starts where this server's history does; custom ranges run past a year", async () => {
  const { analyticsWindow, ANALYTICS_MAX_SPAN_DAYS } = await import("../dist/routes/kit.js");
  const now = Date.now();
  const q = (s: string) => new URLSearchParams(s);
  // All time from the earliest record; never before the ten-year cap; a day when there is nothing yet.
  const start = new Date(now - 800 * 86_400_000).toISOString();
  assert.equal(analyticsWindow(q("all=1"), "s", start).from, start);
  const ancient = new Date(now - 20 * 365 * 86_400_000).toISOString();
  assert.ok(Date.parse(analyticsWindow(q("all=1"), "s", ancient).from) >= now - ANALYTICS_MAX_SPAN_DAYS * 86_400_000 - 5_000);
  const none = analyticsWindow(q("all=1"), "s", null);
  assert.ok(Math.abs(Date.parse(none.to) - Date.parse(none.from) - 86_400_000) < 5_000);
  // A custom 18-month range is kept as asked (the old cap sent it back to 30 days)…
  const from = new Date(now - 540 * 86_400_000).toISOString(), to = new Date(now - 86_400_000).toISOString();
  assert.deepEqual(analyticsWindow(q(`from=${from}&to=${to}`)), { serverId: undefined, from, to });
  // …a future end is clipped to now, and an inverted range falls back to the days form.
  assert.ok(Date.parse(analyticsWindow(q(`from=${from}&to=${new Date(now + 9e9).toISOString()}`)).to) <= Date.now());
  const inverted = analyticsWindow(q(`from=${to}&to=${from}&days=7`));
  assert.ok(Math.abs(Date.parse(inverted.to) - Date.parse(inverted.from) - 7 * 86_400_000) < 5_000);

  // Through the route: all=1 opens the window at the server's first recorded round.
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "hist", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;
    const first = new Date(now - 700 * 86_400_000).toISOString();
    const m = await repo.matches.open({ serverId: id, map: "Foy", startedAt: first });
    await repo.matches.close(m.id, { endedAt: new Date(Date.parse(first) + 3_600_000).toISOString(), winner: "allies", alliedScore: 5, axisScore: 0, result: "ALLIES WIN 5 - 0" });
    const r = await jf(`${base}/api/analytics/match?serverId=${id}&all=1`, { headers: auth });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body.window as { from: string }).from, first);
  });
});
