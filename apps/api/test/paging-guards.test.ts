/**
 * What every paged route does with a `?limit=` that is not a page size.
 *
 * The clamp was written as `Math.min(Number(u.get("limit") ?? D), MAX)` at six call sites, with the
 * offset parse on the next line getting it right. That min guards the ceiling and nothing else, so
 * `?limit=abc` arrived as NaN and `?limit=-5` as -5, and both went into the query verbatim.
 * Postgres refuses them — "invalid input syntax for type bigint", "LIMIT must not be negative" —
 * which turns a malformed request into a 500. The memory store instead returned an empty page for
 * all three, so a dev never saw it and the two stores disagreed about the same request.
 *
 * These run against the memory store, where the symptom is the quieter one: a page that reads as
 * "there is nothing here" for a list that is full.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { jf, ownerAuth } from "./harness.ts";

async function withRepoServer(fn: (base: string, repo: any) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); }
}

/** Every way a caller can hand a route something that is not a page size. */
const JUNK = ["abc", "-5", "0", "", "1e9", "999999999", "NaN", "Infinity", "-Infinity", "1.5"];

/**
 * What each of those means on a route whose default is 100 and whose ceiling is 500. Asking for
 * more than the ceiling is a real request the server trims; anything that is not a positive page
 * size is not a smaller request but no request, and takes the default.
 */
const EXPECTED: [string, number][] = [
  ["abc", 100], ["", 100], ["NaN", 100], ["-5", 100], ["0", 100], ["-Infinity", 100],
  ["Infinity", 500], ["1e9", 500], ["999999999", 500],
  ["1.5", 1], ["3", 3], ["500", 500],
];

test("a nonsense ?limit is clamped to a real page, never passed through", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "pg-guard", host: "127.0.0.1", port: 1, password: "x" }) });
    const id = created.body.server.id as string;

    const t = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    await repo.events.insert(Array.from({ length: 6 }, (_, i) => ({
      serverId: id, ts: t(i), kind: "evt.kill", actorPlayerId: null, actorName: `A${i}`,
      victimPlayerId: null, victimName: `V${i}`, weapon: "M1 GARAND", data: null, dedupeKey: `k${i}`,
    })));

    for (const [limit, want] of EXPECTED) {
      const r = await jf(`${base}/api/servers/${id}/events?limit=${encodeURIComponent(limit)}`, { headers: auth });
      assert.equal(r.status, 200, `limit=${limit} should still be a page, not an error`);
      // The route echoes the size it actually used, which is the contract the panel pages against.
      assert.equal(r.body.limit, want, `limit=${limit} resolved to ${String(r.body.limit)}, expected ${want}`);
      // And the page is actually filled — the failure this replaces was an empty list, not an error.
      assert.equal(r.body.events.length, Math.min(want, 6), `limit=${limit} returned ${r.body.events.length} rows`);
      // The total describes the whole result set, never the page.
      assert.equal(r.body.total, 6);
    }
  });
});

test("a nonsense ?offset starts at the beginning", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "off-guard", host: "127.0.0.1", port: 2, password: "x" }) });
    const id = created.body.server.id as string;
    const t = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
    await repo.events.insert(Array.from({ length: 4 }, (_, i) => ({
      serverId: id, ts: t(i), kind: "evt.kill", actorPlayerId: null, actorName: `A${i}`,
      victimPlayerId: null, victimName: null, weapon: "K98", data: null, dedupeKey: `o${i}`,
    })));

    for (const offset of ["abc", "-10", "", "NaN", "-Infinity"]) {
      const r = await jf(`${base}/api/servers/${id}/events?offset=${encodeURIComponent(offset)}`, { headers: auth });
      assert.equal(r.status, 200, `offset=${offset} should still answer`);
      assert.equal(r.body.offset, 0, `offset=${offset} escaped as ${String(r.body.offset)}`);
      assert.equal(r.body.events.length, 4);
    }
  });
});

/**
 * The same junk against every OTHER paged route. They each had their own copy of the clamp, so
 * fixing one proves nothing about the other five — this is the sweep that keeps them together.
 */
test("every paged route survives the same junk", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const created = await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "sweep", host: "127.0.0.1", port: 3, password: "x" }) });
    const id = created.body.server.id as string;
    await repo.players.upsert({ game: "hll", platform: "steam", platformId: "765_sweep_1", name: "Someone" });

    const paths = [
      `/api/servers/${id}/matches`,
      `/api/servers/${id}/mapvote/history`,
      `/api/players`,
      `/api/leaderboard`,
      `/api/audit`,
    ];
    for (const path of paths) {
      for (const limit of JUNK) {
        const r = await jf(`${base}${path}?limit=${encodeURIComponent(limit)}`, { headers: auth });
        assert.equal(r.status, 200, `${path}?limit=${limit} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
      }
    }
  });
});

/**
 * The edge of the snapshot itself.
 *
 * Every store compares `ts < to`, so the anchor names the first instant NOT in the read. Minting it
 * as `new Date()` therefore excluded rows written in the very millisecond the read began — rows
 * that are not newer than the read, just simultaneous with it. Both the page and its total
 * under-reported, and it made a suite test flap: twelve rows written in a tight loop and read
 * immediately after regularly land in the same millisecond as the read that follows them.
 *
 * The loop is the point. A single sample would pass either way whenever the clock happens to tick
 * between the two calls; hundreds of iterations back to back cannot all miss.
 */
test("the snapshot includes the millisecond it was taken in", async () => {
  const { pageAnchor } = await import("../dist/routes/kit.js");
  for (let i = 0; i < 500; i++) {
    const written = Date.now(); // stands for a row landing right now
    const { anchor, to } = pageAnchor(new URLSearchParams());
    assert.ok(Date.parse(anchor) > written, `a row written at ${written} fell outside an anchor of ${anchor}`);
    assert.equal(to, anchor, "with no explicit `to`, the bound IS the anchor");
  }
});

test("an anchor handed back is used exactly as given", async () => {
  const { pageAnchor } = await import("../dist/routes/kit.js");
  // Page two must read against page one's snapshot, not a fresh one shifted a millisecond further
  // along — otherwise every page has a slightly different bound and the pinning is undone.
  const first = pageAnchor(new URLSearchParams());
  const second = pageAnchor(new URLSearchParams(`anchor=${encodeURIComponent(first.anchor)}`));
  assert.equal(second.anchor, first.anchor);
  assert.equal(second.to, first.anchor);

  // A caller's own upper bound still wins when it is tighter, and is ignored when it is looser.
  const tight = pageAnchor(new URLSearchParams(`anchor=${encodeURIComponent(first.anchor)}`), "2020-01-01T00:00:00.000Z");
  assert.equal(tight.to, "2020-01-01T00:00:00.000Z", "an explicit date filter narrows the snapshot");
  const loose = pageAnchor(new URLSearchParams(`anchor=${encodeURIComponent(first.anchor)}`), "2999-01-01T00:00:00.000Z");
  assert.equal(loose.to, first.anchor, "…but cannot widen it past the snapshot");

  // Junk never becomes the bound.
  const junk = pageAnchor(new URLSearchParams("anchor=banana"));
  assert.ok(!Number.isNaN(Date.parse(junk.anchor)), "a junk anchor is replaced, not passed through");
});

/*
 * A duration is a number a staff member types, and `new Date(x).toISOString()` does not saturate —
 * past ±8.64e15 ms it throws a RangeError. So an absurd VIP duration or trim
 * window answered a permission-checked request with a 500 and a stack trace instead of saying the
 * number was not a duration. Same shape as the ?limit guard above: the input is bounded at the
 * edge, once, rather than trusted into arithmetic that cannot represent it.
 */
test("an absurd duration is refused, not crashed on", async () => {
  await withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    const srv = await jf(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "S", host: "10.0.0.1", port: 28011, password: "p" }),
    });
    assert.equal(srv.status, 201);
    const serverId = srv.body.server.id as string;

    // VIP grant: days so large the expiry cannot be represented.
    const vip = await jf(`${base}/api/servers/${serverId}/vips`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ playerId: "76561", playerName: "Ada", mode: "duration", days: 1e12, comment: "donor" }),
    });
    assert.equal(vip.status, 400, `expected a 400, got ${vip.status}`);

    // Trim: the window is subtracted rather than added, and ran off the other end.
    const trim = await jf(`${base}/api/trim/preview`, {
      method: "POST", headers: auth, body: JSON.stringify({ categories: ["kills"], olderThanDays: 1e12 }),
    });
    assert.equal(trim.status, 400, `expected a 400, got ${trim.status}`);

    // And a sane duration still gets THROUGH validation, so the bound did not just refuse
    // everything. A fresh server is in observe mode, so the grant is then refused as read-only
    // (409) — which is the point: it reached the mode guard, meaning the duration was accepted.
    const ok = await jf(`${base}/api/servers/${serverId}/vips`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ playerId: "76562", playerName: "Bo", mode: "duration", days: 30, comment: "donor" }),
    });
    assert.notEqual(ok.status, 400, "a 30-day grant is a valid duration");
    assert.notEqual(ok.status, 500, "and must never crash");

    // The trim window has no mode guard, so it is the clean positive control.
    const okTrim = await jf(`${base}/api/trim/preview`, {
      method: "POST", headers: auth, body: JSON.stringify({ categories: ["kills"], olderThanDays: 30 }),
    });
    assert.equal(okTrim.status, 200, `a 30-day trim window must still be accepted, got ${okTrim.status}`);
  });
});

test("a server port must be a real port", async () => {
  await withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    // `!port` catches "" and NaN and nothing else, so these three were all stored and only failed
    // later, at dial time, with a message about the socket rather than the number.
    for (const port of [99999, -5, 1.5]) {
      const r = await jf(`${base}/api/servers`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ name: "S", host: "10.0.0.1", port, password: "p" }),
      });
      assert.equal(r.status, 400, `port ${port} should be refused, got ${r.status}`);
    }
  });
});

/*
 * Free text is bounded at the edge too, and for the same reason as the numbers above: the field
 * that matters most is a reason on an in-game action, which is copied into the audit summary AND
 * handed to the game server. Eight of twenty-two write routes capped their text and the rest did
 * not, so what happened to an over-long one depended on which screen you were on.
 */
test("free text is refused when it is absurdly long", async () => {
  await withRepoServer(async (base) => {
    const auth = await ownerAuth(base);
    const huge = "x".repeat(50_000);

    // A name on a list someone reads.
    const srv = await jf(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: huge, host: "10.0.0.1", port: 28012, password: "p" }),
    });
    assert.equal(srv.status, 400, `expected 400, got ${srv.status}`);
    assert.match(String(srv.body.error?.message ?? ""), /too long/i, "and it says which field and what the limit is");

    // A noticeboard post — the one place long-form is expected, so the bound is generous but real.
    const ann = await jf(`${base}/api/community/announcements`, {
      method: "POST", headers: auth, body: JSON.stringify({ title: "ok", body: huge }),
    });
    assert.equal(ann.status, 400, `expected 400, got ${ann.status}`);

    // …and normal-length text still goes through, so the bound is not simply refusing everything.
    const ok = await jf(`${base}/api/community/announcements`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ title: "Server maintenance", body: "We are restarting at 0200 UTC." }),
    });
    assert.equal(ok.status, 201, `a normal post must still be accepted, got ${ok.status}`);
  });
});
