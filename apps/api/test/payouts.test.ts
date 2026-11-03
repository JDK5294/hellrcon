/**
 * Bulk payout, end to end over HTTP (docs/bulk-payout.md). The properties under test are the
 * module's reasons to exist: money moves through the one ledger path and lands exactly once,
 * VIP moves through grantDays and keeps its permanent guard, every recipient gets a receipt,
 * a duplicate run is refused, and a retry pays exactly the failed rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRepository, createIsolatedRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { FakeHllServer } from "./fake-hll-server.ts";
import { jf, ownerAuth, askedFor } from "./harness.ts";

process.env.PAYOUT_VIP_DELAY_MS = "0"; // pacing is for live game servers, not the test clock

async function withServer(fn: (base: string, repo: Awaited<ReturnType<typeof createRepository>>) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  // Close the repo as well as the socket: against a real Postgres the connection pool keeps the
  // event loop alive, so the file's tests all pass and the process then never exits.
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); await repo.close(); }
}
/**
 * The same, but starting from an EMPTY store — its own schema against Postgres, its own instance
 * in memory. The events-post tests need it: "there is nothing to announce" is one of the answers
 * under test, and against a real database every test in this file otherwise shares one schema, so
 * an event another test left open would be announced in this one's post.
 */
async function withCleanServer(fn: (base: string, repo: Awaited<ReturnType<typeof createIsolatedRepository>>["repo"]) => Promise<void>): Promise<void> {
  const { repo, cleanup } = await createIsolatedRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); await cleanup(); }
}
/** Poll the job until the background run settles — the same contract the panel lives on. */
async function settledJob(base: string, auth: Record<string, string>, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await jf(`${base}/api/payouts/${jobId}`, { headers: auth });
    if (r.body.job?.status && r.body.job.status !== "RUNNING") return r.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("payout never settled");
}

async function seedLinked(repo: Awaited<ReturnType<typeof createRepository>>, n: string, discordId: string, game = "hll") {
  const player = await repo.players.upsert({ game, platform: "steam", platformId: `7656119800000${n}`, name: `P${n}` });
  await repo.externalLinks.set(player.id, "discord", discordId, "test");
  return player;
}

test("currency payout: preview counts the excluded, dry run moves nothing, execute pays once through the ledger", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "S", host: "10.0.0.1", port: 1, password: "x" });
    const ana = await seedLinked(repo, "0501", "d-ana");
    const bob = await seedLinked(repo, "0502", "d-bob");
    const ghost = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000503", name: "Ghost" });
    for (const p of [ana, bob, ghost]) await repo.sessions.open(p.id, srv.id, new Date().toISOString());

    // Preview: the unlinked player is dropped AND counted — a silently shorter list is a ticket.
    const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked",
    }) });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.recipients.length, 2);
    assert.equal(preview.body.dropped.unlinked, 1);

    // Dry run: a full rehearsal with receipts, and not one point moves.
    const dry = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 150, serverIds: [], dryRun: true,
    }) });
    assert.equal(dry.status, 202);
    const drySettled = await settledJob(base, auth, dry.body.job.id);
    assert.equal(drySettled.job.status, "COMPLETE");
    assert.equal(drySettled.items.length, 2);
    assert.equal(drySettled.items[0].detail.balanceAfter, 150, "the rehearsal shows what WOULD happen");
    assert.equal(await repo.economy.member("d-ana"), null, "and no member row was even created");

    // Execute: both paid, receipts carry before/after, and the ledger is the record.
    const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 150, serverIds: [], dryRun: false,
    }) });
    assert.equal(run.status, 202);
    const settled = await settledJob(base, auth, run.body.job.id);
    assert.equal(settled.job.status, "COMPLETE");
    assert.equal(settled.job.successCount, 2);
    assert.equal((await repo.economy.member("d-ana"))?.balance, 150);
    assert.equal((await repo.economy.member("d-bob"))?.balance, 150);
    const ledger = await repo.economy.ledger("d-ana");
    assert.equal(ledger.length, 1);
    assert.match(ledger[0]!.reason, /Bulk payout: online players/);

    // The duplicate gate: the exact same payout again is refused, with the standing job named.
    const dupe = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 150, serverIds: [], dryRun: false,
    }) });
    assert.equal(dupe.status, 400);
    assert.match(String(dupe.body.error?.message ?? ""), /already ran/i);
    // A different amount is a different payout — allowed. (Also proves the gate is the key, not a lock on the feature.)
    const other = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 25, serverIds: [], dryRun: false,
    }) });
    assert.equal(other.status, 202);
    await settledJob(base, auth, other.body.job.id);
    assert.equal((await repo.economy.member("d-ana"))?.balance, 175);

    // History lists newest first and the job-level audit row exists.
    const hist = await jf(`${base}/api/payouts`, { headers: auth });
    assert.ok(hist.body.total >= 3);
    const audits = await repo.audit.list({ limit: 50 });
    assert.ok(audits.some((a) => a.action === "economy.payout" && !a.data?.dryRun), "a payout is a staff action on the record");
  });
});

test("VIP payout: lands through grantDays, keeps the permanent guard, and a window pays who was actually there", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    const srv = await repo.servers.create({ name: "Game", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
    try {
    const ana = await seedLinked(repo, "0601", "d-ana6");
    const perm = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000602", name: "Perma" });
    // Perma already holds PERMANENT VIP — the exact shape the downgrade bug destroyed once.
    await repo.vips.upsert({ serverId: srv.id, playerId: perm.platformId, playerName: perm.name, comment: "", expiration: null, createdByUserId: null, createdByName: "seed" });

    // A two-hour window: Ana for 90 minutes, Perma for 30, a third player for 5 (under the floor).
    const brief = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000603", name: "Brief" });
    const t = (min: number) => new Date(Date.parse("2026-08-21T18:00:00Z") + min * 60_000).toISOString();
    await repo.sessions.importOne({ playerId: ana.id, serverId: srv.id, connectedAt: t(0), disconnectedAt: t(90), durationSec: 5400 });
    await repo.sessions.importOne({ playerId: perm.id, serverId: srv.id, connectedAt: t(10), disconnectedAt: t(40), durationSec: 1800 });
    await repo.sessions.importOne({ playerId: brief.id, serverId: srv.id, connectedAt: t(20), disconnectedAt: t(25), durationSec: 300 });

    const source = { type: "window", serverId: srv.id, from: t(0), to: t(120), minMinutes: 20 };
    const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source, kind: "vip", audience: "everyone",
    }) });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.recipients.map((r: any) => r.displayName).sort(), ["P0601", "Perma"]);
    assert.equal(preview.body.dropped.underMinutes, 1, "ninety seconds to collect is what the floor is for");

    const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source, kind: "vip", audience: "everyone", amount: 7, serverIds: [srv.id], dryRun: false,
    }) });
    assert.equal(run.status, 202);
    const settled = await settledJob(base, auth, run.body.job.id);
    assert.equal(settled.job.status, "COMPLETE");
    assert.equal(settled.job.successCount, 2);

    // Ana got 7 real days, through the same path as a shop purchase.
    const anaVip = await repo.vips.get(srv.id, ana.platformId);
    assert.ok(anaVip?.expiration, "Ana's grant exists and expires");
    const days = (Date.parse(anaVip!.expiration!) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days < 7.1, `expected ~7 days, got ${days}`);
    // …and recorded as what it was: a bulk payout, not a shop purchase nobody made.
    assert.match(anaVip!.comment ?? "", /^bulk payout \(/);
    assert.doesNotMatch(anaVip!.comment ?? "", /VIP shop/);

    // Perma is UNTOUCHED: permanent absorbed the days rather than being replaced by them.
    const permVip = await repo.vips.get(srv.id, perm.platformId);
    assert.equal(permVip?.expiration, null, "permanent VIP survives a bulk payout — the downgrade bug stays dead");
    const permItem = settled.items.find((i: any) => i.displayName === "Perma");
    assert.equal(permItem.detail.servers[srv.id].alreadyPermanent, true, "and the receipt says so");
    } finally { fake.close(); }
  });
});

test("VIP payout to members a group perk holds: one taking no rewards absorbs the days, rehearsal and run alike; one taking them banks them", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    const srv = await repo.servers.create({ name: "Game", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
    try {
      const tag = Math.random().toString(36).slice(2, 7);
      const staffGroup = await repo.playerGroups.create({ name: `Staff ${tag}`, createdByName: "owner" });
      await repo.playerGroups.setVipPerk(staffGroup.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false });
      const donors = await repo.playerGroups.create({ name: `Donors ${tag}`, createdByName: "owner" });
      await repo.playerGroups.setVipPerk(donors.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: true });
      const held = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000611", name: "Held" });
      const banks = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000612", name: "Banks" });
      for (const [p, g] of [[held, staffGroup], [banks, donors]] as const) {
        await repo.vips.startGroupHold({ serverId: srv.id, playerId: p.platformId, playerName: p.name, groups: [{ id: g.id, name: g.name, severanceMinutes: 0 }], createdByName: "group perks" });
      }
      const t = (min: number) => new Date(Date.parse("2026-08-22T18:00:00Z") + min * 60_000).toISOString();
      await repo.sessions.importOne({ playerId: held.id, serverId: srv.id, connectedAt: t(0), disconnectedAt: t(60), durationSec: 3600 });
      await repo.sessions.importOne({ playerId: banks.id, serverId: srv.id, connectedAt: t(0), disconnectedAt: t(60), durationSec: 3600 });
      const source = { type: "window", serverId: srv.id, from: t(0), to: t(120), minMinutes: 20 };
      const pay = async (dryRun: boolean) => {
        const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({ source, kind: "vip", audience: "everyone", amount: 7, serverIds: [srv.id], dryRun }) });
        assert.equal(run.status, 202, JSON.stringify(run.body));
        return settledJob(base, auth, run.body.job.id);
      };
      const on = (settled: any, name: string) => settled.items.find((i: any) => i.displayName === name).detail.servers[srv.id];
      const bankedOf = async (playerId: string) => (await repo.vips.get(srv.id, playerId))!.groupHold!.bankedMs;

      const rehearsal = await pay(true);
      assert.equal(on(rehearsal, "Held").alreadyPermanent, true, "the rehearsal says the group's VIP absorbs them");
      assert.equal(on(rehearsal, "Banks").alreadyPermanent, false, "…and that the other group's banks them");
      const run = await pay(false);
      assert.equal(run.job.status, "COMPLETE");
      assert.equal(on(run, "Held").alreadyPermanent, true, "the receipt says nothing was added");
      assert.equal(await bankedOf(held.platformId), 0, "nothing frozen for later");
      assert.equal(await bankedOf(banks.platformId), 7 * 86_400_000, "a group taking rewards banks the days");
    } finally { fake.close(); }
  });
});

test("a failed recipient gets a FAIL receipt, the rest are paid, and retry pays exactly the failures", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    const srv = await repo.servers.create({ name: "Game", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
    try {
    const ok = await seedLinked(repo, "0701", "d-ok");
    // Linked, but their only game account is the OTHER game — no account can land on this server,
    // so this recipient fails while the loop carries on. (Continue past failures: docs/bulk-payout.md, "What keeps it safe" #3.)
    const wrongGame = await repo.players.upsert({ game: "hllv", platform: "steam", platformId: "76561198000000702", name: "Vietnam" });
    await repo.externalLinks.set(wrongGame.id, "discord", "d-viet", "test");
    for (const p of [ok, wrongGame]) await repo.sessions.open(p.id, srv.id, new Date().toISOString());

    const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "vip", audience: "linked", amount: 3, serverIds: [srv.id], dryRun: false,
    }) });
    assert.equal(run.status, 202);
    const settled = await settledJob(base, auth, run.body.job.id);
    assert.equal(settled.job.status, "COMPLETE_WITH_FAILURES");
    assert.equal(settled.job.successCount, 1);
    assert.equal(settled.job.failedCount, 1);
    const failRow = settled.items.find((i: any) => i.status === "FAIL");
    assert.match(failRow.error, /no .* account|no target server/i, "the receipt says why");

    // Retry: the candidate list is exactly the FAIL rows — the paid are not paid again.
    const retryPreview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "retry", jobId: settled.job.id }, kind: "vip", audience: "linked",
    }) });
    assert.equal(retryPreview.status, 200);
    assert.deepEqual(retryPreview.body.recipients.map((r: any) => r.displayName), ["Vietnam"]);
    } finally { fake.close(); }
  });
});

test("a run cut off part-way: a re-run is refused, and 'pay the rest' pays the unreached once — never the person granted just before the cut", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const fake = new FakeHllServer("pw");
    const port = await fake.listen();
    const srv = await repo.servers.create({ name: "Game", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
    try {
      const people = [await seedLinked(repo, "0901", "d-cut1"), await seedLinked(repo, "0902", "d-cut2"), await seedLinked(repo, "0903", "d-cut3")];
      for (const p of people) await repo.sessions.open(p.id, srv.id, new Date().toISOString());
      const body = JSON.stringify({ source: { type: "online", serverId: srv.id }, kind: "vip", audience: "linked", amount: 3, serverIds: [srv.id], dryRun: false });

      // The worst moment to die: the first grant has landed on the game, its receipt is not yet
      // written. (Before the fix the pacing pause sat exactly here, so a restart usually hit it.)
      const realSettle = repo.payouts.settleItem;
      let cut!: () => void;
      const cutoff = new Promise<void>((r) => { cut = r; });
      repo.payouts.settleItem = async () => { cut(); throw new Error("the process died"); };
      const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body });
      assert.equal(run.status, 202);
      await cutoff;
      await new Promise((r) => setTimeout(r, 50));
      repo.payouts.settleItem = realSettle;
      await repo.payouts.interruptStale(); // what the next boot does

      const granted = [];
      for (const p of people) if (await repo.vips.get(srv.id, p.platformId)) granted.push(p);
      assert.equal(granted.length, 1, "one person was reached before the cut");
      const first = granted[0]!;
      const firstExpiry = (await repo.vips.get(srv.id, first.platformId))!.expiration!;

      const cutJob = (await repo.payouts.get(run.body.job.id))!;
      assert.equal(cutJob.status, "INTERRUPTED");
      assert.equal(cutJob.successCount, 0, "no receipt says paid");
      assert.equal(cutJob.failedCount, 3, "all three are still owed a receipt — so the panel offers to pay the rest");

      // Running the same payout again would pay the reached a second time: refused, pointing at retry.
      const again = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body });
      assert.equal(again.status, 400);
      assert.match(String(again.body.error?.message ?? ""), /cut off part-way/i);

      // The retry's list is everyone without a PASS receipt — the unreached included.
      const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "retry", jobId: cutJob.id }, kind: "vip", audience: "linked",
      }) });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.recipients.length, 3);

      const retry = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "retry", jobId: cutJob.id }, kind: "vip", audience: "linked", amount: 3, serverIds: [srv.id], dryRun: false,
      }) });
      assert.equal(retry.status, 202);
      const settled = await settledJob(base, auth, retry.body.job.id);
      assert.equal(settled.job.status, "COMPLETE");
      assert.equal(settled.job.successCount, 3);

      // The person granted just before the cut is NOT granted again — VIP days add up.
      assert.equal((await repo.vips.get(srv.id, first.platformId))!.expiration, firstExpiry, "three days, not six");
      const firstRow = settled.items.find((i: any) => i.displayName === first.name);
      assert.equal(firstRow.detail.servers[srv.id].alreadyPaid, true, "and the receipt says why");
      for (const p of people.filter((x) => x.id !== first.id)) {
        const days = (Date.parse((await repo.vips.get(srv.id, p.platformId))!.expiration!) - Date.now()) / 86_400_000;
        assert.ok(days > 2.9 && days < 3.1, `the unreached got their three days (got ${days.toFixed(2)})`);
      }
    } finally { fake.close(); }
  });
});

test("currency cut off part-way: the retry pays under the original's ref, so a payment that landed before the cut is not paid twice", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Cash", host: "10.9.9.40", port: 40, password: "x" });
    const people = [await seedLinked(repo, "0911", "d-cash1"), await seedLinked(repo, "0912", "d-cash2")];
    for (const p of people) await repo.sessions.open(p.id, srv.id, new Date().toISOString());

    const realSettle = repo.payouts.settleItem;
    let cut!: () => void;
    const cutoff = new Promise<void>((r) => { cut = r; });
    repo.payouts.settleItem = async () => { cut(); throw new Error("the process died"); };
    const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 40, serverIds: [], dryRun: false,
    }) });
    assert.equal(run.status, 202);
    await cutoff;
    await new Promise((r) => setTimeout(r, 50));
    repo.payouts.settleItem = realSettle;
    await repo.payouts.interruptStale();

    const retry = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "retry", jobId: run.body.job.id }, kind: "currency", audience: "linked", amount: 40, serverIds: [], dryRun: false,
    }) });
    assert.equal(retry.status, 202);
    const settled = await settledJob(base, auth, retry.body.job.id);
    assert.equal(settled.job.status, "COMPLETE");
    for (const id of ["d-cash1", "d-cash2"]) assert.equal((await repo.economy.member(id))?.balance, 40, `${id} paid exactly once`);
    assert.equal(settled.items.filter((i: any) => i.detail.applied === false).length, 1, "the one paid before the cut is recognised, not re-paid");
  });
});

test("two clicks landing together pay the list once — the claim is taken before any wait", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Twice", host: "10.9.9.41", port: 41, password: "x" });
    const people = [await seedLinked(repo, "0921", "d-dbl1"), await seedLinked(repo, "0922", "d-dbl2")];
    for (const p of people) await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    const body = JSON.stringify({ source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 30, serverIds: [], dryRun: false });
    // A real database takes a moment to answer the duplicate lookup — the window both clicks slip
    // through when the claim is taken after it rather than before.
    const realFind = repo.payouts.findDuplicate;
    repo.payouts.findDuplicate = async (k) => { const seen = await realFind(k); await new Promise((r) => setTimeout(r, 40)); return seen; };
    const [a, b] = await Promise.all([
      jf(`${base}/api/payouts`, { method: "POST", headers: auth, body }),
      jf(`${base}/api/payouts`, { method: "POST", headers: auth, body }),
    ]);
    repo.payouts.findDuplicate = realFind;
    assert.deepEqual([a.status, b.status].sort(), [202, 400], "one runs, the other is refused");
    await settledJob(base, auth, (a.status === 202 ? a : b).body.job.id);
    for (const id of ["d-dbl1", "d-dbl2"]) assert.equal((await repo.economy.member(id))?.balance, 30, `${id} paid once`);
  });
});

test("a payout whose job could not be opened can be tried again — no claim is left behind", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Retryable", host: "10.9.9.42", port: 42, password: "x" });
    const p = await seedLinked(repo, "0931", "d-open1");
    await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    const body = JSON.stringify({ source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 12, serverIds: [], dryRun: false });
    // The field incident's shape: the job row itself refused (then, the index overflow).
    const realCreate = repo.payouts.create;
    repo.payouts.create = async () => { throw new Error("index row size 5688 exceeds btree version 4 maximum 2704"); };
    const first = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body });
    repo.payouts.create = realCreate;
    assert.notEqual(first.status, 202);
    const second = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body });
    assert.equal(second.status, 202, `not "already running": ${JSON.stringify(second.body.error ?? "")}`);
    await settledJob(base, auth, second.body.job.id);
    assert.equal((await repo.economy.member("d-open1"))?.balance, 12);
  });
});

test("a dry run cannot be 'retried' into real payments — it paid nobody", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Rehearsal", host: "10.9.9.43", port: 43, password: "x" });
    const p = await seedLinked(repo, "0941", "d-dry1");
    await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    const dry = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 5, serverIds: [], dryRun: true,
    }) });
    assert.equal(dry.status, 202);
    await settledJob(base, auth, dry.body.job.id);
    const retry = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "retry", jobId: dry.body.job.id }, kind: "currency", audience: "linked",
    }) });
    assert.equal(retry.status, 400);
    assert.match(String(retry.body.error?.message ?? ""), /dry run/i);
  });
});

test("one retry of a cut-off payout at a time — a second with a different list waits", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "OneAtATime", host: "10.9.9.44", port: 44, password: "x" });
    const people = [await seedLinked(repo, "0951", "d-one1"), await seedLinked(repo, "0952", "d-one2")];
    for (const p of people) await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    const realSettle = repo.payouts.settleItem;
    let cut!: () => void;
    const cutoff = new Promise<void>((r) => { cut = r; });
    repo.payouts.settleItem = async () => { cut(); throw new Error("the process died"); };
    const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 9, serverIds: [], dryRun: false,
    }) });
    await cutoff;
    await new Promise((r) => setTimeout(r, 50));
    await repo.payouts.interruptStale();

    // The first retry parks on its first receipt; the second (one name removed — a different key)
    // must not run beside it.
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atReceipt = new Promise<void>((r) => { reached = r; });
    repo.payouts.settleItem = async (...args) => { reached(); await parked; return realSettle(...args); };
    const retryBody = (removedKeys: string[]) => JSON.stringify({
      source: { type: "retry", jobId: run.body.job.id }, kind: "currency", audience: "linked", amount: 9, serverIds: [], dryRun: false, removedKeys,
    });
    const first = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: retryBody([]) });
    assert.equal(first.status, 202);
    await atReceipt;
    const second = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: retryBody(["d:d-one2"]) });
    assert.equal(second.status, 400);
    assert.match(String(second.body.error?.message ?? ""), /another retry of that payout is still running/i);
    release();
    repo.payouts.settleItem = realSettle;
    await settledJob(base, auth, first.body.job.id);
    for (const id of ["d-one1", "d-one2"]) assert.equal((await repo.economy.member(id))?.balance, 9, `${id} paid once`);
  });
});

test("a run that dies mid-list closes itself as cut off — 'pay the rest' is offered without a restart", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Blip", host: "10.9.9.45", port: 45, password: "x" });
    const people = [await seedLinked(repo, "0961", "d-blip1"), await seedLinked(repo, "0962", "d-blip2")];
    for (const p of people) await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    const realSettle = repo.payouts.settleItem;
    let calls = 0;
    // The first receipt lands; the second write fails (the database blinked).
    repo.payouts.settleItem = async (...args) => { if (++calls === 2) throw new Error("connection reset"); return realSettle(...args); };
    const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", amount: 7, serverIds: [], dryRun: false,
    }) });
    assert.equal(run.status, 202);
    const settled = await settledJob(base, auth, run.body.job.id);
    repo.payouts.settleItem = realSettle;
    assert.equal(settled.job.status, "INTERRUPTED", "no longer 'running' until the next restart");
    assert.equal(settled.job.successCount, 1);
    assert.equal(settled.job.failedCount, 1, "and the unpaid one is offered to 'pay the rest'");
  });
});

test("without the capability the surface does not exist to you", async () => {
  await withServer(async (base) => {
    const auth = await ownerAuth(base);
    // The owner creates a second, grantless account — the default state of new staff.
    await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "junior", password: "pw" }) });
    const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "junior", password: "pw" }) });
    const junior = { authorization: `Bearer ${l.body.token as string}` };

    assert.equal((await jf(`${base}/api/payouts`, { headers: junior })).status, 403);
    assert.equal((await jf(`${base}/api/payouts/preview`, { method: "POST", headers: junior, body: JSON.stringify({ source: { type: "linked" }, kind: "currency", audience: "linked" }) })).status, 403);
    // Running one is asked of someone who may pay — filed, and nothing is paid on the asking.
    const jobs = async () => (await jf(`${base}/api/payouts`, { headers: auth })).body.total as number;
    const before = await jobs();
    const asked = await jf(`${base}/api/payouts`, { method: "POST", headers: junior, body: JSON.stringify({ source: { type: "linked" }, kind: "currency", audience: "linked", amount: 10, serverIds: [], dryRun: false }) });
    assert.deepEqual(await askedFor(base, auth, asked), { capability: "economy.payout", serverId: null });
    assert.equal(await jobs(), before, "no payout ran");
  });
});

test("payout events: match-boundary windows resolve retroactively, default the floor, and gate their states", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "S", host: "10.0.0.1", port: 1, password: "x" });
    const ana = await seedLinked(repo, "0701", "d-ana7");
    const bob = await seedLinked(repo, "0702", "d-bob7");

    // Last night, as the store recorded it: a round underway at 8pm, the first fresh round at
    // 20:22, and the round that straddles the 23:00 close anchor ending 23:25.
    const m1 = await repo.matches.open({ serverId: srv.id, map: "st marie", startedAt: "2026-08-20T19:30:00.000Z" });
    await repo.matches.close(m1.id, { endedAt: "2026-08-20T20:20:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    const m2 = await repo.matches.open({ serverId: srv.id, map: "carentan", startedAt: "2026-08-20T20:22:00.000Z" });
    await repo.matches.close(m2.id, { endedAt: "2026-08-20T21:10:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    const m3 = await repo.matches.open({ serverId: srv.id, map: "foy", startedAt: "2026-08-20T22:40:00.000Z" });
    await repo.matches.close(m3.id, { endedAt: "2026-08-20T23:25:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    await repo.sessions.open(ana.id, srv.id, "2026-08-20T20:00:00.000Z");
    await repo.sessions.close(ana.id, srv.id, "2026-08-20T23:00:00.000Z");
    await repo.sessions.open(bob.id, srv.id, "2026-08-20T20:30:00.000Z");
    await repo.sessions.close(bob.id, srv.id, "2026-08-20T20:45:00.000Z"); // 15 min — under the floor

    // Created AFTER the fact: the boundaries resolve on the spot, because presence and matches
    // were recorded whether or not anyone had scheduled anything (decision 3).
    const created = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Wednesday event", serverId: srv.id,
      openMode: "match_start_after", openAnchor: "2026-08-20T20:00:00Z",
      closeMode: "match_end_after", closeAnchor: "2026-08-20T23:00:00Z",
      minMinutes: 30,
    }) });
    assert.equal(created.status, 201);
    const ev = created.body.event;
    assert.equal(ev.status, "closed");
    assert.equal(ev.openedAt, "2026-08-20T20:22:00.000Z", "opens with the first FRESH round, not the one underway at 8pm");
    assert.equal(ev.closedAt, "2026-08-20T23:25:00.000Z", "the round being played at 11pm finishes and counts");
    assert.equal(ev.roster.length, 2, "the roster is materialised at close and keeps everyone; floors apply at payout time");

    // Paying the event: the event's own minutes floor applies by default.
    const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "event", eventId: ev.id }, kind: "currency", audience: "linked",
    }) });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.recipients.map((r: any) => r.displayName), ["P0701"]);
    assert.equal(preview.body.dropped.underMinutes, 1, "Bob's 15 minutes are under the event's 30-minute floor");
    assert.equal(preview.body.recipients[0].minutes, 158, "20:22 open to Ana's 23:00 disconnect");

    const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "event", eventId: ev.id }, kind: "currency", audience: "linked", amount: 500, serverIds: [], dryRun: false,
    }) });
    assert.equal(run.status, 202);
    const settled = await settledJob(base, auth, run.body.job.id);
    assert.equal(settled.job.status, "COMPLETE");
    assert.equal((await repo.economy.member("d-ana7"))?.balance, 500);
    assert.equal(await repo.economy.member("d-bob7"), null, "under the floor means not paid");

    // A future event sits scheduled: not payable yet, cancellable exactly once.
    const future = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Next week", serverId: srv.id,
      openMode: "at", openAnchor: "2099-01-01T20:00:00Z",
      closeMode: "at", closeAnchor: "2099-01-01T23:00:00Z",
    }) });
    assert.equal(future.status, 201);
    assert.equal(future.body.event.status, "scheduled");
    const early = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "event", eventId: future.body.event.id }, kind: "currency", audience: "linked",
    }) });
    assert.equal(early.status, 400);
    assert.match(String(early.body.error?.message ?? ""), /not opened yet/i);
    const cancelled = await jf(`${base}/api/payout-events/${future.body.event.id}/cancel`, { method: "POST", headers: auth });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.event.status, "cancelled");
    const again = await jf(`${base}/api/payout-events/${future.body.event.id}/cancel`, { method: "POST", headers: auth });
    assert.equal(again.status, 409, "cancelling a record, not a plan, is refused");

    // A backwards window is refused at the door.
    const backwards = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Backwards", serverId: srv.id,
      openMode: "at", openAnchor: "2099-01-02T20:00:00Z",
      closeMode: "at", closeAnchor: "2099-01-01T23:00:00Z",
    }) });
    assert.equal(backwards.status, 400);

    // The list reflects every state, newest first.
    const list = await jf(`${base}/api/payout-events`, { headers: auth });
    assert.equal(list.body.total, 2);
  });
});

test("the events list names each event's server and says whether it has been paid", async () => {
  // A clean store: the list is the answer under test, and against a shared database it would
  // carry every other test's events too.
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const main = await repo.servers.create({ name: "The [LYNX] Division #1 | MIC'S MANDATORY!!", host: "10.0.0.1", port: 1, password: "x" });
    await repo.servers.setNickname(main.id, "Main");
    const old = await repo.servers.create({ name: "Old Server", host: "10.0.0.2", port: 2, password: "x" });
    const gone = await repo.servers.create({ name: "Gone Server", host: "10.0.0.3", port: 3, password: "x" });
    const hidden = await repo.servers.create({ name: "Hidden Server", host: "10.0.0.4", port: 4, password: "x" });
    const ana = await seedLinked(repo, "0901", "d-ana9");
    await repo.sessions.open(ana.id, main.id, "2026-08-20T20:00:00.000Z");
    await repo.sessions.close(ana.id, main.id, "2026-08-20T22:00:00.000Z");
    const make = async (name: string, serverId: string, day = "2026-08-20") => {
      const r = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
        name, serverId, openMode: "at", openAnchor: `${day}T20:00:00Z`, closeMode: "at", closeAnchor: `${day}T22:00:00Z`,
      }) });
      assert.equal(r.status, 201, name);
      return r.body.event as { id: string; status: string };
    };
    const awaiting = await make("Awaiting", main.id);
    const paid = await make("Paid", main.id);
    const rehearsed = await make("Rehearsed", main.id);
    const owed = await make("Owed", main.id);
    const later = await make("Later", main.id, "2099-01-01");
    await make("On a retired server", old.id);
    await make("On a deleted server", gone.id);
    await make("On a decommissioned server", hidden.id);
    await repo.servers.setRetired(old.id, true);
    await repo.servers.remove(gone.id);
    await repo.servers.setRetired(hidden.id, true);
    await repo.servers.setDecommissioned(hidden.id, true);
    assert.equal(awaiting.status, "closed");
    assert.equal(later.status, "scheduled");

    const pay = async (eventId: string, dryRun: boolean) => {
      const r = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "event", eventId }, kind: "currency", audience: "linked", amount: 100, serverIds: [], dryRun,
      }) });
      assert.equal(r.status, 202);
      return (await settledJob(base, auth, r.body.job.id)).job as { id: string; status: string; completedAt: string };
    };
    const paidJob = await pay(paid.id, false);
    assert.equal(paidJob.status, "COMPLETE");
    await pay(rehearsed.id, true);
    // A run that failed two people, as the ledger records one.
    const failed = await repo.payouts.create({
      sourceType: "event", sourceRef: { type: "event", eventId: owed.id }, payoutType: "vip", amount: 7, serverIds: [main.id],
      audience: "everyone", dryRun: false, status: "RUNNING", requestedByUserId: null, requestedByName: "owner", totalCount: 5, duplicateKey: "owed-1",
    });
    await repo.payouts.finish(failed.id, { status: "COMPLETE_WITH_FAILURES", successCount: 3, failedCount: 2 });

    const read = async () => {
      const r = await jf(`${base}/api/payout-events?limit=50`, { headers: auth });
      assert.equal(r.status, 200);
      return new Map((r.body.items as any[]).map((e) => [e.name as string, e]));
    };
    let byName = await read();
    assert.equal(byName.get("Awaiting").serverName, "Main", "the staff nickname, as every other server picker says it");
    assert.equal(byName.get("On a retired server").serverName, "Old Server", "a retired server is still named");
    assert.equal(byName.get("On a deleted server").serverName, null, "a deleted one is not guessed at");
    assert.equal(byName.get("On a decommissioned server").serverName, "Hidden Server", "the setup account still sees the server it decommissioned");
    assert.equal(byName.get("Awaiting").payment, null, "closed and nobody paid: awaiting payment");
    assert.equal(byName.get("Later").payment, null);
    assert.equal(byName.get("Rehearsed").payment, null, "a dry run paid nobody");
    assert.deepEqual(byName.get("Paid").payment, { state: "paid", unpaid: 0, at: paidJob.completedAt });
    assert.deepEqual(byName.get("Owed").payment?.state, "part");
    assert.equal(byName.get("Owed").payment?.unpaid, 2);
    assert.equal(byName.get("On a retired server").payment, null);
    assert.equal(byName.get("On a deleted server").payment, null);

    // "Retry failures" running: the event is being paid. Finished with nobody left: paid.
    const retry = await repo.payouts.create({
      sourceType: "retry", sourceRef: { type: "retry", jobId: failed.id, rootJobId: failed.id }, payoutType: "vip", amount: 7, serverIds: [main.id],
      audience: "everyone", dryRun: false, status: "RUNNING", requestedByUserId: null, requestedByName: "owner", totalCount: 2, duplicateKey: "owed-2",
    });
    byName = await read();
    assert.equal(byName.get("Owed").payment?.state, "paying");
    await repo.payouts.finish(retry.id, { status: "COMPLETE", successCount: 2, failedCount: 0 });
    byName = await read();
    assert.equal(byName.get("Owed").payment?.state, "paid");
    assert.equal(byName.get("Owed").payment?.unpaid, 0);

    // Someone who may read events but not payouts sees the state, and nothing of what was paid.
    await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "scheduler", password: "pw" }) });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "scheduler", password: "pw" }) });
    const scheduler = await repo.users.findByUsername("scheduler");
    const role = await repo.roles.create({ name: "scheduler", grants: [{ capability: "events.manage", level: "read" }], createdByName: "owner" });
    await repo.userRoles.set(scheduler!.id, [{ roleId: role.id, scopeId: null }]);
    const asScheduler = await jf(`${base}/api/payout-events?limit=50`, { headers: { authorization: `Bearer ${login.body.token as string}` } });
    assert.equal(asScheduler.status, 200);
    const seen = (asScheduler.body.items as any[]).find((e) => e.id === paid.id);
    assert.deepEqual(Object.keys(seen.payment).sort(), ["at", "state", "unpaid"], "no amount, no recipients");
    assert.equal(seen.serverName, "Main");
    // Decommissioning takes a server away from every account but the setup one, name and all.
    const onHidden = (asScheduler.body.items as any[]).find((e) => e.name === "On a decommissioned server");
    assert.equal(onHidden.serverName, null, "to anyone else a decommissioned server is no server");
    assert.equal((asScheduler.body.items as any[]).find((e) => e.name === "On a retired server").serverName, "Old Server",
      "a retired one is still history everyone may read");
  });
});

test("a finished event nobody means to pay can be marked as needing no payout, and the mark undone", async () => {
  // Staff found no way out of "Awaiting payment" for an event that was never going to be paid: a
  // closed event refuses cancel, and should — it is a record with a report. The mark is the way.
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Main", host: "10.0.0.1", port: 1, password: "x" });
    const make = async (name: string, day: string) => {
      const r = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
        name, serverId: srv.id, openMode: "at", openAnchor: `${day}T20:00:00Z`, closeMode: "at", closeAnchor: `${day}T22:00:00Z`,
      }) });
      assert.equal(r.status, 201, name);
      return r.body.event as { id: string; status: string };
    };
    const practice = await make("Practice night", "2026-08-20");
    const later = await make("Next month", "2099-01-01");
    assert.equal(practice.status, "closed");
    const mark = (id: string, noPayout: unknown, headers: Record<string, string> = auth) =>
      jf(`${base}/api/payout-events/${id}/no-payout`, { method: "POST", headers, body: JSON.stringify({ noPayout }) });
    const audits = async () => (await repo.audit.list({ actions: ["economy.payoutEvent.noPayout"], limit: 50 })).length;

    const marked = await mark(practice.id, true);
    assert.equal(marked.status, 200);
    assert.equal(marked.body.event.status, "closed", "still a record: closed, with its report");
    assert.equal(marked.body.event.noPayoutBy, "owner");
    const at = marked.body.event.noPayoutAt as string;
    assert.ok(at);
    const listed = (await jf(`${base}/api/payout-events`, { headers: auth })).body.items.find((e: any) => e.id === practice.id);
    assert.equal(listed.noPayoutAt, at, "the list carries the mark, which is what the screen reads");
    assert.equal(listed.payment, null, "and no payout was made");
    assert.equal((await jf(`${base}/api/payout-events/${practice.id}/report`, { headers: auth })).status, 200, "the report is still there");

    // A double press is one decision: the first mark's time stands, and the trail has one entry.
    const again = await mark(practice.id, true);
    assert.equal(again.status, 200);
    assert.equal(again.body.event.noPayoutAt, at);
    assert.equal(await audits(), 1);

    const undone = await mark(practice.id, false);
    assert.equal(undone.status, 200);
    assert.equal(undone.body.event.noPayoutAt, null);
    assert.equal(undone.body.event.noPayoutBy, null, "undoing clears who as well as when");
    assert.equal(await audits(), 2);

    assert.equal((await mark(later.id, true)).status, 409, "an event still to happen has nothing to decide yet");
    assert.equal((await mark(practice.id, "yes")).status, 400);
    assert.equal((await mark("00000000-0000-4000-8000-000000000001", true)).status, 404);

    // Deciding not to pay is a scheduling act, not a reading one.
    const accountWith = async (username: string, level: "read" | "write") => {
      await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
      const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
      const user = await repo.users.findByUsername(username);
      const role = await repo.roles.create({ name: username, grants: [{ capability: "events.manage", level }], createdByName: "owner" });
      await repo.userRoles.set(user!.id, [{ roleId: role.id, scopeId: null }]);
      return { authorization: `Bearer ${login.body.token as string}` };
    };
    assert.deepEqual(await askedFor(base, auth, await mark(practice.id, true, await accountWith("reader", "read"))), { capability: "events.manage", serverId: null });
    assert.equal((await repo.payoutEvents.get(practice.id))!.noPayoutAt, null, "not marked on the asking");
    const scheduler = await mark(practice.id, true, await accountWith("scheduler", "write"));
    assert.equal(scheduler.status, 200, "whoever runs the events may say this one is not being paid");
    assert.equal(scheduler.body.event.noPayoutBy, "scheduler");
  });
});

test("event report and map-vote pin: analytics over the exact window, a validated profile pin, and the widened read gate", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "S", host: "10.0.0.1", port: 1, password: "x" });
    const ana = await seedLinked(repo, "0801", "d-ana8");
    const bob = await seedLinked(repo, "0802", "d-bob8");

    // The night on record: two rounds, Ana on for both, Bob for the tail of the first.
    const m1 = await repo.matches.open({ serverId: srv.id, map: "carentan", startedAt: "2026-08-20T20:00:00.000Z" });
    await repo.matches.bumpStat({ matchId: m1.id, playerId: ana.id, serverId: srv.id, playerName: "P0801", kills: 20, deaths: 5 });
    await repo.matches.bumpStat({ matchId: m1.id, playerId: bob.id, serverId: srv.id, playerName: "P0802", kills: 7, deaths: 9 });
    await repo.matches.close(m1.id, { endedAt: "2026-08-20T21:00:00.000Z", winner: "allies", alliedScore: 3, axisScore: 2, result: null });
    const m2 = await repo.matches.open({ serverId: srv.id, map: "foy", startedAt: "2026-08-20T21:05:00.000Z" });
    await repo.matches.bumpStat({ matchId: m2.id, playerId: ana.id, serverId: srv.id, playerName: "P0801", kills: 10, deaths: 4 });
    await repo.matches.close(m2.id, { endedAt: "2026-08-20T22:00:00.000Z", winner: "axis", alliedScore: 1, axisScore: 4, result: null });
    await repo.sessions.open(ana.id, srv.id, "2026-08-20T19:55:00.000Z");
    await repo.sessions.close(ana.id, srv.id, "2026-08-20T22:00:00.000Z");
    await repo.sessions.open(bob.id, srv.id, "2026-08-20T20:30:00.000Z");
    await repo.sessions.close(bob.id, srv.id, "2026-08-20T21:00:00.000Z");

    // A profile to pin: profiles hydrate from the map library, named after the set.
    await repo.mapSets.create({ name: "Event maps", game: "hll", pool: { dayCount: 5 } });
    await repo.mapVote.setConfig(srv.id, { profiles: [{ mapSet: "Event maps", schedule: null }] });

    // A pin naming a profile the server does not have is refused at the door, naming what it has.
    const typo = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Typo", serverId: srv.id, openMode: "at", openAnchor: "2026-08-20T20:00:00Z",
      closeMode: "at", closeAnchor: "2026-08-20T22:00:00Z", mapVoteProfile: "Evnt maps",
    }) });
    assert.equal(typo.status, 400);
    assert.match(String(typo.body.error?.message ?? ""), /Event maps/, "the refusal lists the real profiles");

    const created = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Wednesday", serverId: srv.id, openMode: "at", openAnchor: "2026-08-20T20:00:00Z",
      closeMode: "at", closeAnchor: "2026-08-20T22:00:00Z", mapVoteProfile: "Event maps",
    }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.event.mapVoteProfile, "Event maps");
    assert.equal(created.body.event.status, "closed", "a past hard window resolves on creation");

    // The report: attendance over the exact window, the rounds inside it, the board summed.
    const rep = await jf(`${base}/api/payout-events/${created.body.event.id}/report`, { headers: auth });
    assert.equal(rep.status, 200);
    const r = rep.body.report;
    assert.equal(r.window.live, false);
    assert.equal(r.attendance.players, 2);
    assert.equal(r.attendance.peakConcurrent, 2, "both on together between 20:30 and 21:00");
    const anaRow = r.attendance.list.find((x: any) => x.name === "P0801");
    assert.equal(anaRow.minutes, 120, "Ana's 19:55 connect clips to the 20:00 open");
    assert.deepEqual(r.rounds.map((m: any) => m.map), ["carentan", "foy"]);
    assert.equal(r.rounds[0].durationSec, 3600);
    assert.deepEqual(r.top.map((t: any) => [t.name, t.kills]), [["P0801", 30], ["P0802", 7]], "kills summed across the event's rounds");

    // The widened gate: an analytics-only account can list events and read reports, but cannot
    // create events or run payouts — reading how Friday went is not minting currency.
    await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "analyst", password: "pw" }) });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "analyst", password: "pw" }) });
    const analystAuth = { authorization: `Bearer ${login.body.token as string}` };
    const analyst = await repo.users.findByUsername("analyst");
    const role = await repo.roles.create({ name: "analyst", grants: [{ capability: "analytics.server", level: "read" }], createdByName: "owner" });
    await repo.userRoles.set(analyst!.id, [{ roleId: role.id, scopeId: null }]);
    const listAsAnalyst = await jf(`${base}/api/payout-events`, { headers: analystAuth });
    assert.equal(listAsAnalyst.status, 200);
    const repAsAnalyst = await jf(`${base}/api/payout-events/${created.body.event.id}/report`, { headers: analystAuth });
    assert.equal(repAsAnalyst.status, 200);
    const createAsAnalyst = await jf(`${base}/api/payout-events`, { method: "POST", headers: analystAuth, body: JSON.stringify({
      name: "Nope", serverId: srv.id, openMode: "at", openAnchor: "2099-01-01T00:00:00Z", closeMode: "at", closeAnchor: "2099-01-02T00:00:00Z",
    }) });
    assert.deepEqual(await askedFor(base, auth, createAsAnalyst), { capability: "events.manage", serverId: null });
    assert.ok(!(await repo.payoutEvents.list({ limit: 500, offset: 0 })).some((e) => e.name === "Nope"), "not scheduled on the asking");

    // A scheduled event has no window yet — the report says so instead of inventing one.
    const future = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Later", serverId: srv.id, openMode: "at", openAnchor: "2099-01-01T00:00:00Z", closeMode: "at", closeAnchor: "2099-01-02T00:00:00Z",
    }) });
    const early = await jf(`${base}/api/payout-events/${future.body.event.id}/report`, { headers: auth });
    assert.equal(early.status, 400);
  });
});

test("sweep findings: the report counts who is still playing, and a window cannot be unbounded", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "S", host: "10.0.0.1", port: 1, password: "x" });
    const stayed = await seedLinked(repo, "0901", "d-stayed");
    const left = await seedLinked(repo, "0902", "d-left");

    // An evening that has finished. One player left before the whistle; the other is STILL on —
    // which means they have no closed session row at all, only the live one.
    const m = await repo.matches.open({ serverId: srv.id, map: "foy", startedAt: "2026-08-20T20:00:00.000Z" });
    await repo.matches.close(m.id, { endedAt: "2026-08-20T22:00:00.000Z", winner: null, alliedScore: null, axisScore: null, result: null });
    await repo.sessions.open(left.id, srv.id, "2026-08-20T20:00:00.000Z");
    await repo.sessions.close(left.id, srv.id, "2026-08-20T21:00:00.000Z");
    await repo.sessions.open(stayed.id, srv.id, "2026-08-20T20:00:00.000Z"); // never closed

    const created = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Thursday", serverId: srv.id,
      openMode: "at", openAnchor: "2026-08-20T20:00:00Z",
      closeMode: "at", closeAnchor: "2026-08-20T22:00:00Z",
    }) });
    assert.equal(created.status, 201);
    const ev = created.body.event;
    assert.equal(ev.status, "closed");
    // The roster written at close has both — open sessions are unioned and clipped to the close.
    assert.deepEqual(ev.roster.map((r: any) => r.minutes).sort((a: number, b: number) => a - b), [60, 120]);

    // …and the REPORT must agree with it. It used to drop anyone still connected, because only
    // closed sessions are in the table — so the payout paid two and the report showed one.
    const rep = await jf(`${base}/api/payout-events/${ev.id}/report`, { headers: auth });
    assert.equal(rep.status, 200);
    assert.equal(rep.body.report.attendance.players, 2, "the player who never disconnected is still an attendee");
    assert.equal(rep.body.report.attendance.peakConcurrent, 2);
    const paid = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "event", eventId: ev.id }, kind: "currency", audience: "linked",
    }) });
    assert.equal(paid.body.recipients.length, rep.body.report.attendance.players,
      "the report and the payout answer the same question with the same number");

    // A window nobody could mean: refused whole, rather than folding every session row on record.
    const huge = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "window", serverId: srv.id, from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" },
      kind: "currency", audience: "linked",
    }) });
    assert.equal(huge.status, 400);
    assert.match(String(huge.body.error?.message ?? ""), /at most 92 days/);
    // A normal one still works.
    const sane = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
      source: { type: "window", serverId: srv.id, from: "2026-08-20T20:00:00Z", to: "2026-08-20T22:00:00Z" },
      kind: "currency", audience: "linked",
    }) });
    assert.equal(sane.status, 200);
    assert.equal(sane.body.recipients.length, 2);

    // The same bound at event creation, so a decade-wide event cannot be saved and then swept.
    const wide = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "A decade", serverId: srv.id,
      openMode: "at", openAnchor: "2026-01-01T00:00:00Z", closeMode: "at", closeAnchor: "2036-01-01T00:00:00Z",
    }) });
    assert.equal(wide.status, 400);
    assert.match(String(wide.body.error?.message ?? ""), /at most 92 days/);
  });
});

test("sweep findings: a live event's report shows the round being played, and its scoreboard", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "S", host: "10.0.0.1", port: 1, password: "x" });
    const ana = await seedLinked(repo, "1001", "d-ana10");

    // An event that is still OPEN, with one finished round and one still being played. The live
    // round is the one staff opening the report during an event are asking about — and it used to
    // be invisible, because the window query is finished rounds only.
    const done = await repo.matches.open({ serverId: srv.id, map: "carentan", startedAt: "2026-08-20T20:05:00.000Z" });
    await repo.matches.bumpStat({ matchId: done.id, playerId: ana.id, serverId: srv.id, playerName: "P1001", kills: 5, deaths: 1 });
    await repo.matches.close(done.id, { endedAt: "2026-08-20T21:00:00.000Z", winner: "allies", alliedScore: 3, axisScore: 1, result: null });
    const live = await repo.matches.open({ serverId: srv.id, map: "foy", startedAt: "2026-08-20T21:05:00.000Z" });
    await repo.matches.bumpStat({ matchId: live.id, playerId: ana.id, serverId: srv.id, playerName: "P1001", kills: 4, deaths: 2 });
    await repo.sessions.open(ana.id, srv.id, "2026-08-20T20:00:00.000Z");

    // Opens on the clock, closes when the round running at 23:00 ends — which has not happened.
    const created = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Live one", serverId: srv.id,
      openMode: "at", openAnchor: "2026-08-20T20:00:00Z",
      closeMode: "match_end_after", closeAnchor: "2026-08-20T23:00:00Z",
    }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.event.status, "open", "no round has ended past the close anchor yet");

    const rep = await jf(`${base}/api/payout-events/${created.body.event.id}/report`, { headers: auth });
    assert.equal(rep.status, 200);
    assert.equal(rep.body.report.window.live, true);
    assert.deepEqual(rep.body.report.rounds.map((m: any) => m.map), ["carentan", "foy"], "the round in play is on the list");
    const playing = rep.body.report.rounds[1];
    assert.equal(playing.endedAt, null);
    assert.equal(playing.durationSec, null, "which is what the panel draws as 'in play'");
    // Its scoreboard counts too — 5 kills from the finished round plus 4 from the live one.
    assert.deepEqual(rep.body.report.top.map((t: any) => [t.name, t.kills]), [["P1001", 9]]);
  });
});

/**
 * Events are their own permission, and pinning maps from one is still a map-vote power.
 *
 * Both halves shipped gated on `economy.payout` — the "trust them with the whole float" grant —
 * which had two consequences worth a test each. Letting somebody run Friday night meant also
 * letting them mint currency for the entire community; and the map-vote profile pin, which
 * decides what everybody plays for the length of the event, needed none of the grant that editing
 * the same profiles directly needs.
 */
test("events.manage schedules without minting, and pinning an event's maps still needs mapvote.config on that server", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    // Names unique to this test: against a real Postgres every test in the file shares one
    // database, and map-set names carry a unique index.
    const srv = await repo.servers.create({ name: "Perm S", host: "10.0.0.1", port: 1, password: "x" });
    const other = await repo.servers.create({ name: "Perm Other", host: "10.0.0.2", port: 1, password: "x" });
    await repo.mapSets.create({ name: "Permission maps", game: "hll", pool: { dayCount: 5 } });
    await repo.mapVote.setConfig(srv.id, { profiles: [{ mapSet: "Permission maps", schedule: null }] });

    /** A staff account holding exactly the given grants and nothing else. */
    const staff = async (username: string, grants: { capability: string; level: "read" | "write"; scopeType?: "global" | "server" | "group"; scopeId?: string | null }[]) => {
      await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
      const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
      const user = await repo.users.findByUsername(username);
      for (const g of grants) {
        await repo.grants.create({ userId: user!.id, scopeType: "global", scopeId: null, ...g });
      }
      return { authorization: `Bearer ${login.body.token as string}` };
    };
    const schedule = (headers: Record<string, string>, body: Record<string, unknown>) =>
      jf(`${base}/api/payout-events`, { method: "POST", headers, body: JSON.stringify({
        serverId: srv.id, openMode: "at", openAnchor: "2099-01-01T00:00:00Z", closeMode: "at", closeAnchor: "2099-01-02T00:00:00Z", ...body,
      }) });

    // The host: may open and close windows, may not touch the float.
    const host = await staff("host", [{ capability: "events.manage", level: "write" }]);
    const made = await schedule(host, { name: "Friday" });
    assert.equal(made.status, 201, "scheduling an event needs events.manage, not the payout grant");
    assert.equal((await jf(`${base}/api/payout-events`, { headers: host })).status, 200);
    const cancelled = await jf(`${base}/api/payout-events/${made.body.event.id}/cancel`, { method: "POST", headers: host });
    assert.equal(cancelled.status, 200);

    // Same account, the money surface: nothing to read, and a payout is only ever asked for.
    const scheduled = async (name: string) => (await repo.payoutEvents.list({ limit: 500, offset: 0 })).some((e) => e.name === name);
    const jobsBefore = (await jf(`${base}/api/payouts`, { headers: auth })).body.total as number;
    assert.equal((await jf(`${base}/api/payouts`, { headers: host })).status, 403);
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/payouts`, { method: "POST", headers: host, body: "{}" })), { capability: "economy.payout", serverId: null });
    assert.equal((await jf(`${base}/api/payouts`, { headers: auth })).body.total, jobsBefore, "no payout ran");
    assert.equal((await jf(`${base}/api/payouts/preview`, { method: "POST", headers: host, body: "{}" })).status, 403);

    // The escalation: scheduling rights alone must not decide what the server plays.
    // It is asked of someone holding the map-vote key on THE EVENT'S server.
    const pinned = await schedule(host, { name: "Pinned", mapVoteProfile: "Permission maps" });
    assert.deepEqual(await askedFor(base, auth, pinned), { capability: "mapvote.config", serverId: srv.id }, "pinning a map-vote profile is a map-vote power");
    assert.equal(await scheduled("Pinned"), false, "and nothing is scheduled on the asking");

    // Held on the WRONG server it is still no: that capability is scoped, and so is this check.
    const elsewhere = await staff("elsewhere", [
      { capability: "events.manage", level: "write" },
      { capability: "mapvote.config", level: "write", scopeType: "server", scopeId: other.id },
    ]);
    assert.deepEqual(await askedFor(base, auth, await schedule(elsewhere, { name: "Wrong server", mapVoteProfile: "Permission maps" })), { capability: "mapvote.config", serverId: srv.id });
    assert.equal(await scheduled("Wrong server"), false);
    assert.equal((await schedule(elsewhere, { name: "No pin" })).status, 201, "without a pin the same account schedules fine");

    // Held on THIS server, the pin goes through.
    const mapper = await staff("mapper", [
      { capability: "events.manage", level: "write" },
      { capability: "mapvote.config", level: "write", scopeType: "server", scopeId: srv.id },
    ]);
    const ok = await schedule(mapper, { name: "Event night", mapVoteProfile: "Permission maps" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.event.mapVoteProfile, "Permission maps");

    // Paying is not scheduling: economy.payout write alone is asked for events.manage, as anyone
    // without it is — each permission answers for its own job.
    const treasurer = await staff("treasurer", [{ capability: "economy.payout", level: "write" }]);
    assert.deepEqual(await askedFor(base, auth, await schedule(treasurer, { name: "Payouts only" })), { capability: "events.manage", serverId: null });
    assert.equal(await scheduled("Payouts only"), false);

    // And read-level events.manage is a read: it lists, it does not schedule.
    const watcher = await staff("watcher", [{ capability: "events.manage", level: "read" }]);
    assert.equal((await jf(`${base}/api/payout-events`, { headers: watcher })).status, 200);
    assert.deepEqual(await askedFor(base, auth, await schedule(watcher, { name: "Nope" })), { capability: "events.manage", serverId: null });
    assert.equal(await scheduled("Nope"), false);
  });
});

test("role tiers: each recipient is paid their first matching tier's amount, and the record says so", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "S", host: "10.0.0.9", port: 1, password: "x" });
    const boost = await seedLinked(repo, "0901", "d-boost");
    const member = await seedLinked(repo, "0902", "d-member");
    const outsider = await seedLinked(repo, "0903", "d-outsider");
    for (const p of [boost, member, outsider]) await repo.sessions.open(p.id, srv.id, new Date().toISOString());

    // A community guild + bot token, with Discord itself stood in for: the member lookups answer
    // each person's roles, everything else passes through to the real fetch (the test's own HTTP).
    await repo.appConfig.set({ communityGuildId: "999000" });
    const prevToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test-token";
    const rolesByUser: Record<string, string[]> = {
      "d-boost": ["100001", "100002"], // holds BOTH tier roles — the first tier must win
      "d-member": ["100002"],
      "d-outsider": ["100003"],        // holds neither tier role — dropped, counted
    };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const m = /guilds\/999000\/members\/([^/?]+)$/.exec(url);
      if (m) {
        const roles = rolesByUser[m[1]!];
        return roles
          ? new Response(JSON.stringify({ user: { username: m[1] }, roles }), { status: 200 })
          : new Response("{}", { status: 404 });
      }
      return real(input as never, init);
    }) as typeof fetch;

    try {
      const tiers = [{ roleId: "100001", amount: 100 }, { roleId: "100002", amount: null }];
      // Preview: per-person amounts and the tier that decided each; the outsider is counted out loud.
      const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", tiers,
      }) });
      assert.equal(preview.status, 200);
      const byName = new Map((preview.body.recipients as { displayName: string; amount: number | null; tierRoleId: string }[]).map((r) => [r.displayName, r]));
      assert.equal(byName.size, 2);
      assert.equal(byName.get("P0901")!.amount, 100, "the booster gets the booster tier");
      assert.equal(byName.get("P0901")!.tierRoleId, "100001", "…and the first matching tier wins over the second");
      assert.equal(byName.get("P0902")!.amount, null, "a blank tier amount means the base amount");
      assert.equal(preview.body.dropped.noRole, 1, "no tier role, no payout — and it is counted");

      // Execute with base amount 50: booster banks 100, member banks 50, receipts carry each figure.
      const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked", tiers,
        amount: 50, serverIds: [], dryRun: false,
      }) });
      assert.equal(run.status, 202);
      const settled = await settledJob(base, auth, run.body.job.id);
      assert.equal(settled.job.status, "COMPLETE");
      assert.equal((await repo.economy.member("d-boost"))?.balance, 100);
      assert.equal((await repo.economy.member("d-member"))?.balance, 50);
      assert.equal((await repo.economy.member("d-outsider")), null, "outside every tier, nothing lands");
      const items = settled.items as { displayName: string; detail: { amount?: number; tierRoleId?: string } }[];
      assert.equal(items.find((i) => i.displayName === "P0901")!.detail.amount, 100, "the receipt states the tier amount");
      assert.equal(items.find((i) => i.displayName === "P0902")!.detail.amount, 50);
      assert.deepEqual(settled.job.sourceRef.tiers, tiers, "the job records the rule that priced each person");

      // The same payout with the tiers REORDERED is a different payout: order is priority.
      const reordered = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked",
        tiers: [tiers[1], tiers[0]], amount: 50, serverIds: [], dryRun: false,
      }) });
      assert.equal(reordered.status, 202);
      const settled2 = await settledJob(base, auth, reordered.body.job.id);
      assert.equal(settled2.job.status, "COMPLETE");
      assert.equal((await repo.economy.member("d-boost"))?.balance, 150, "member tier first now, so the booster gets the base 50");

      // A zero tier amount is refused whole, before anything is paid.
      const bad = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked",
        tiers: [{ roleId: "100001", amount: 0 }], amount: 50, serverIds: [], dryRun: false,
      }) });
      assert.equal(bad.status, 400);
    } finally {
      globalThis.fetch = real;
      if (prevToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = prevToken;
    }
  });
});

/**
 * Editing an event after it is scheduled — plans move, and until this route existed the only way
 * to change one was to cancel it and start again (which loses the audit thread and, if it had
 * already opened, the presence it had accrued).
 *
 * The three properties: a scheduled event takes every field; a running one refuses to have its
 * start or its server rewritten out from under the players already in it, while still letting the
 * end be pushed out; a finished one refuses entirely. The window is re-validated as it will STAND,
 * not as the patch reads, so a one-field edit cannot leave the pair backwards.
 */
test("payout events can be edited while they can still change: fully when scheduled, forward-only when open, never once closed", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Edit A", host: "10.4.0.1", port: 1, password: "x" });
    const other = await repo.servers.create({ name: "Edit B", host: "10.4.0.2", port: 1, password: "x" });

    const made = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Saturday", serverId: srv.id,
      openMode: "at", openAnchor: "2099-03-07T20:00:00Z", closeMode: "at", closeAnchor: "2099-03-07T23:00:00Z",
      minMinutes: 30,
    }) });
    assert.equal(made.status, 201);
    const id = made.body.event.id as string;

    // Scheduled: everything moves, including the server and the whole window.
    const moved = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({
      name: "Sunday", serverId: other.id,
      openAnchor: "2099-03-08T19:00:00Z", closeAnchor: "2099-03-08T22:30:00Z", minMinutes: 45,
    }) });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.event.name, "Sunday");
    assert.equal(moved.body.event.serverId, other.id);
    assert.equal(moved.body.event.openAnchor, "2099-03-08T19:00:00.000Z");
    assert.equal(moved.body.event.minMinutes, 45);

    // A one-field edit is checked against the event as it will stand, not against itself.
    const backwards = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({
      closeAnchor: "2099-03-08T18:00:00Z",
    }) });
    assert.equal(backwards.status, 400, "a new end before the existing start is refused");
    assert.equal((await jf(`${base}/api/payout-events/${id}`, { headers: auth })).body.event.closeAnchor, "2099-03-08T22:30:00.000Z");

    const empty = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: auth, body: "{}" });
    assert.equal(empty.status, 400, "an edit that changes nothing is a mistake, not a save");
    assert.equal((await jf(`${base}/api/payout-events/00000000-0000-0000-0000-0000000000ee`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ name: "Ghost" }),
    })).status, 404);

    // Now one that is RUNNING: opened for real, not yet closed.
    await repo.payoutEvents.applyTransition(id, { openedAt: "2099-03-08T19:02:00.000Z" });
    const frozen = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({
      openAnchor: "2099-03-08T12:00:00Z",
    }) });
    assert.equal(frozen.status, 400);
    assert.match(String(frozen.body.error?.message ?? ""), /already opened/i);
    assert.equal((await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ serverId: srv.id }) })).status, 400,
      "the server it is running on is settled too");
    const extended = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({
      name: "Sunday (extended)", closeAnchor: "2099-03-09T01:00:00Z", minMinutes: 20,
    }) });
    assert.equal(extended.status, 200, "the end can still be pushed out mid-event");
    assert.equal(extended.body.event.closeAnchor, "2099-03-09T01:00:00.000Z");
    assert.equal(extended.body.event.minMinutes, 20);
    assert.equal(extended.body.event.serverId, other.id);

    // And once it is a record, it is a record.
    await repo.payoutEvents.applyTransition(id, { closedAt: "2099-03-09T01:05:00.000Z", roster: [] });
    const late = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ name: "Too late" }) });
    assert.equal(late.status, 409);
    assert.equal((await jf(`${base}/api/payout-events/${id}`, { headers: auth })).body.event.name, "Sunday (extended)");

    // The edit is on the record: who changed what, both sides.
    const audit = await jf(`${base}/api/audit?action=economy.payoutEvent.update`, { headers: auth });
    assert.equal(audit.status, 200);
    assert.ok(audit.body.entries.length >= 2, "every accepted edit is audited");
    assert.ok(audit.body.entries.some((e: any) => e.data?.before?.name === "Saturday"), "the audit says what it was, not only what it is");
  });
});

/**
 * The events list, posted to Discord.
 *
 * The property that matters is the SPELLING: every instant in the post is Discord's unix
 * timestamp markup, so a community spread across zones each reads it on their own clock. A wall
 * clock composed here would be right for whoever pressed the button and wrong for everyone else,
 * and nothing in the message could tell them so — hence the assertions that no ISO string and no
 * AM/PM/UTC ever reach the text.
 */
test("the events post shows an event's name as typed", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Post S", host: "10.5.0.2", port: 1, password: "x" });
    const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const end = new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000).toISOString();
    const made = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Clan_vs_Clan *finals*", serverId: srv.id, openMode: "at", openAnchor: start, closeMode: "at", closeAnchor: end,
    }) });
    assert.equal(made.status, 201);
    const post = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({ days: 7, preview: true }) });
    assert.ok(String(post.body.message).includes("**Clan\\_vs\\_Clan \\*finals\\***"), String(post.body.message));
  });
});

test("the events post is unix timestamps only, covers the days asked for, and its schedule is stored with the latch", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Post S", host: "10.5.0.1", port: 1, password: "x" });
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const soonEnd = new Date(Date.now() + 2 * 86_400_000 + 3 * 3_600_000).toISOString();
    const far = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const farEnd = new Date(Date.now() + 40 * 86_400_000 + 3 * 3_600_000).toISOString();

    const near = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "This week", serverId: srv.id, openMode: "at", openAnchor: soon, closeMode: "at", closeAnchor: soonEnd,
    }) });
    assert.equal(near.status, 201);
    await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Next month", serverId: srv.id, openMode: "at", openAnchor: far, closeMode: "at", closeAnchor: farEnd,
    }) });

    // A week out: the near event only.
    const week = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({ days: 7, preview: true }) });
    assert.equal(week.status, 200);
    assert.equal(week.body.posted, false, "a preview posts nothing");
    const text = String(week.body.message);
    assert.ok(text.includes("This week"), "the event inside the window is listed");
    assert.ok(!text.includes("Next month"), "the one outside it is not");
    assert.ok(text.includes("Post S"), "and it says which server");
    assert.match(text, /<t:\d{9,}:F>/, "instants are Discord timestamp markup");
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), "no ISO timestamp leaks into a message people read");
    assert.ok(!/\b(AM|PM|UTC|GMT)\b/.test(text), "and no wall clock is composed for one zone");

    // Typed days-out: 60 reaches the far one, 1 reaches neither and is refused rather than posting
    // an empty list into a channel.
    const long = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({ days: 60, preview: true }) });
    assert.ok(String(long.body.message).includes("Next month"));
    const none = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({ days: 1, preview: true }) });
    assert.equal(none.status, 409);
    assert.equal((await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({ days: 0, preview: true }) })).status, 400);
    assert.equal((await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({ days: 400, preview: true }) })).status, 400);

    // Someone who can only read the events previews like anyone — a preview is a read, so it is
    // never filed as a request — and posting is what they ask for.
    await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "postreader", password: "pw" }) });
    const readerLogin = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "postreader", password: "pw" }) });
    const readerUser = await repo.users.findByUsername("postreader");
    await repo.grants.create({ userId: readerUser!.id, scopeType: "global", scopeId: null, capability: "events.manage", level: "read" });
    const reader = { authorization: `Bearer ${readerLogin.body.token as string}` };
    const peek = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: reader, body: JSON.stringify({ days: 7, preview: true }) });
    assert.equal(peek.status, 200, JSON.stringify(peek.body));
    assert.ok(String(peek.body.message).includes("This week"));
    const posting = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: reader, body: JSON.stringify({ days: 7, channelId: "123456789012345" }) });
    assert.deepEqual(await askedFor(base, auth, posting), { capability: "events.manage", serverId: null });

    // The schedule: stored, validated, and enabling it needs somewhere to post.
    const seeded = await jf(`${base}/api/payout-events/post-config`, { headers: auth });
    assert.equal(seeded.status, 200);
    assert.equal(seeded.body.config.enabled, false);
    assert.equal((await jf(`${base}/api/payout-events/post-config`, { method: "PUT", headers: auth, body: JSON.stringify({ enabled: true }) })).status, 400,
      "on, with nowhere to post, is not a setting");
    assert.equal((await jf(`${base}/api/payout-events/post-config`, { method: "PUT", headers: auth, body: JSON.stringify({ channelId: "not-an-id" }) })).status, 400);
    assert.equal((await jf(`${base}/api/payout-events/post-config`, { method: "PUT", headers: auth, body: JSON.stringify({ weekday: 9 }) })).status, 400);
    assert.equal((await jf(`${base}/api/payout-events/post-config`, { method: "PUT", headers: auth, body: JSON.stringify({ atHour: 24 }) })).status, 400);

    const saved = await jf(`${base}/api/payout-events/post-config`, { method: "PUT", headers: auth, body: JSON.stringify({
      enabled: true, channelId: "123456789012345", daysAhead: 10, weekday: 1, atHour: 9, atMinute: 30,
    }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.enabled, true);
    assert.equal(saved.body.config.daysAhead, 10);
    assert.equal(saved.body.config.weekday, 1);
    assert.equal(saved.body.config.atHour, 9);

    // The latch, and why moving the time clears it: a post moved from 9:30 to 10:00 must still go
    // out today, not tomorrow.
    await repo.payoutEvents.setPostConfig({ lastPostedOn: "2026-09-07" });
    const retimed = await jf(`${base}/api/payout-events/post-config`, { method: "PUT", headers: auth, body: JSON.stringify({ atHour: 10 }) });
    assert.equal(retimed.body.config.lastPostedOn, null, "changing the time re-arms today's post");
    assert.equal(retimed.body.config.channelId, "123456789012345", "and leaves everything else alone");

    // days defaults to the stored window, so "Post now" sends what the schedule would have sent.
    const dflt = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({ preview: true }) });
    assert.ok(String(dflt.body.message).includes("next 10 days"));
  });
});

/** Posting for real: the one call that leaves the building, and the audit it leaves behind. */
test("post now sends the built message to the configured channel, and says so if Discord refuses", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Send S", host: "10.5.1.1", port: 1, password: "x" });
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Tomorrow", serverId: srv.id, openMode: "at", openAnchor: soon,
      closeMode: "at", closeAnchor: new Date(Date.parse(soon) + 3_600_000).toISOString(),
    }) });

    const prevToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test-token";
    const real = globalThis.fetch;
    const sent: { channel: string; content: string }[] = [];
    let refuse = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const m = /channels\/(\d+)\/messages$/.exec(url);
      if (m) {
        if (refuse) return new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 });
        sent.push({ channel: m[1]!, content: JSON.parse(String(init?.body ?? "{}")).content });
        return new Response(JSON.stringify({ id: "1" }), { status: 200 });
      }
      return real(input as never, init);
    }) as typeof fetch;

    try {
      const posted = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({
        days: 7, channelId: "987654321098765",
      }) });
      assert.equal(posted.status, 200);
      assert.equal(posted.body.posted, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.channel, "987654321098765");
      assert.ok(sent[0]!.content.includes("Tomorrow"));
      assert.match(sent[0]!.content, /<t:\d{9,}:/, "what actually left the building is timestamp markup");

      const audit = await jf(`${base}/api/audit?action=economy.payoutEvent.post`, { headers: auth });
      assert.ok(audit.body.entries.length >= 1, "a message sent to the community is on the record");

      refuse = true;
      const rejected = await jf(`${base}/api/payout-events/post`, { method: "POST", headers: auth, body: JSON.stringify({
        days: 7, channelId: "987654321098765",
      }) });
      assert.equal(rejected.status, 502, "a channel the bot cannot reach is reported, not swallowed");
      assert.equal(sent.length, 1);
    } finally {
      globalThis.fetch = real;
      if (prevToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = prevToken;
    }
  });
});

/**
 * A tiered payout over a whole community must not ask Discord about each person in turn.
 *
 * This is the bug that made "Preview recipients" sit there and then fail with "the server did not
 * respond within 60s". A tiered payout needs every candidate's roles, and asking per member is one
 * Discord round trip each — all carrying the same route key, so the shared limiter puts them in a
 * single bucket and runs them one at a time, waiting out the window whenever it empties. That is
 * the limiter doing its job; the caller was the problem. A few dozen linked members was already
 * longer than the panel waits.
 *
 * So: past the crossover it reads the guild's member list instead — one request for the first
 * thousand people. What is pinned here is the call SHAPE, because that is the whole fix.
 */
test("a tiered payout over a large community reads the member list once instead of asking per person", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Bulk", host: "10.7.0.1", port: 1, password: "x" });

    // Forty linked members: comfortably past the point where the list is the cheaper question.
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const discordId = `d-bulk-${String(i).padStart(3, "0")}`;
      const p = await seedLinked(repo, `1${String(i).padStart(3, "0")}`, discordId);
      await repo.sessions.open(p.id, srv.id, new Date().toISOString());
      ids.push(discordId);
    }
    await repo.appConfig.set({ communityGuildId: "999111" });
    const prevToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test-token";

    // Every third person is an ADMIN, the rest are TECH SUPPORT — so both tiers and the "in the
    // guild but in neither tier" case are all represented.
    const roleOf = (i: number) => (i % 3 === 0 ? ["200001"] : i % 3 === 1 ? ["200002"] : ["200003"]);
    const listCalls: string[] = [];
    let perMemberCalls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/guilds\/999111\/members\?/.test(url)) {
        listCalls.push(url);
        const body = ids.map((id, i) => ({ user: { id, username: id }, nick: null, roles: roleOf(i) }));
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (/guilds\/999111\/members\/[^/?]+$/.test(url)) {
        perMemberCalls += 1;
        return new Response("{}", { status: 404 });
      }
      return real(input as never, init);
    }) as typeof fetch;

    try {
      const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked",
        tiers: [{ roleId: "200001", amount: 100 }, { roleId: "200002", amount: null }],
      }) });
      assert.equal(preview.status, 200);

      assert.equal(listCalls.length, 1, "one member-list read answers the whole community");
      assert.equal(perMemberCalls, 0, "and not a single per-person lookup");
      assert.match(listCalls[0]!, /limit=1000/, "asks for a full page rather than trickling");

      // The answer is still exactly right, which is the part the speed must not have cost.
      const admins = ids.filter((_, i) => i % 3 === 0).length;
      const techs = ids.filter((_, i) => i % 3 === 1).length;
      assert.equal(preview.body.recipients.length, admins + techs);
      assert.equal(preview.body.dropped.noRole, ids.length - admins - techs, "the third role is in no tier, and is counted out loud");
      const byName = new Map(preview.body.recipients.map((r: any) => [r.discordId, r.amount]));
      assert.equal(byName.get("d-bulk-000"), 100, "an ADMIN gets the tier amount");
      assert.equal(byName.get("d-bulk-001"), null, "a blank tier still means the base amount");
    } finally {
      globalThis.fetch = real;
      if (prevToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = prevToken;
    }
  });
});

/**
 * When the member list cannot be read, say why — do not quietly go back to the slow path.
 *
 * The list read 403s for as long as the bot lacks the Server Members intent, which is a setting
 * someone has to go and change. Falling back to per-person lookups there just reproduces the
 * original bug: a minute of nothing, then "the server did not respond", which names nothing
 * actionable. Under the cap the fallback really is fine and still runs.
 */
test("a payout too big for per-person lookups says the member list is the problem", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "NoIntent", host: "10.7.1.1", port: 1, password: "x" });
    for (let i = 0; i < 200; i++) {
      const p = await seedLinked(repo, `2${String(i).padStart(3, "0")}`, `d-noi-${i}`);
      await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    }
    await repo.appConfig.set({ communityGuildId: "999222" });
    const prevToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test-token";

    let perMemberCalls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // The Server Members intent is off: the list is refused, every time.
      if (/guilds\/999222\/members\?/.test(url)) return new Response(JSON.stringify({ message: "Missing Access" }), { status: 403 });
      if (/guilds\/999222\/members\/[^/?]+$/.test(url)) {
        perMemberCalls += 1;
        return new Response(JSON.stringify({ user: { id: "x" }, roles: [] }), { status: 200 });
      }
      return real(input as never, init);
    }) as typeof fetch;

    try {
      const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked",
        tiers: [{ roleId: "200001", amount: 100 }],
      }) });
      assert.equal(preview.status, 400);
      assert.match(String(preview.body.error?.message ?? ""), /SERVER MEMBERS INTENT/,
        "the message names the setting to change, not just that something went wrong");
      assert.equal(perMemberCalls, 0, "and it refuses up front rather than grinding through 200 lookups first");
    } finally {
      globalThis.fetch = real;
      if (prevToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = prevToken;
    }
  });
});

/**
 * A Discord server too big to page through is a different problem from one the bot cannot read,
 * and it needs the opposite advice: narrow the payout, versus go and change a setting. They used
 * to arrive as the same answer, which sent anyone with a large community off to switch on an
 * intent that was already on.
 */
test("a community too large to page through is told to narrow the payout, not to change a setting", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Huge", host: "10.7.2.1", port: 1, password: "x" });
    for (let i = 0; i < 200; i++) {
      const p = await seedLinked(repo, `3${String(i).padStart(3, "0")}`, `d-huge-${i}`);
      await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    }
    await repo.appConfig.set({ communityGuildId: "999333" });
    const prevToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test-token";

    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      // Always a FULL page, so the walk never reaches an end and hits the ceiling instead.
      if (/guilds\/999333\/members\?/.test(url)) {
        const after = Number(new URL(url).searchParams.get("after") ?? "0");
        const rows = Array.from({ length: 1000 }, (_, i) => ({ user: { id: String(after + i + 1) }, roles: [] }));
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      return real(input as never, init);
    }) as typeof fetch;

    try {
      const preview = await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked",
        tiers: [{ roleId: "300001", amount: 100 }],
      }) });
      assert.equal(preview.status, 400);
      const message = String(preview.body.error?.message ?? "");
      assert.match(message, /more than \d+ members/, "it says what the actual problem is");
      assert.match(message, /Narrow the payout/i, "and what to do about it");
      assert.doesNotMatch(message, /SERVER MEMBERS INTENT/,
        "the bot's permissions are not the problem here, and saying they are sends someone to fix the wrong thing");
    } finally {
      globalThis.fetch = real;
      if (prevToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = prevToken;
    }
  });
});

/**
 * Editing a PINNED event without map-vote rights.
 *
 * The panel sends the whole form back on every save, so an unchanged map pin rides along with a
 * rename. Treating that as an exercise of the pinning power meant somebody holding events.manage
 * but not mapvote.config could not edit a pinned event at all — refused over a field the panel does
 * not even show them without that grant, so the error named a control they could not see.
 *
 * The pin still cannot be CHANGED without the grant, which is the rule that actually matters.
 */
test("resending an unchanged map pin is not an exercise of the pinning power", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "Pin S", host: "10.8.0.1", port: 1, password: "x" });
    const other = await repo.servers.create({ name: "Pin Other", host: "10.8.0.2", port: 1, password: "x" });
    await repo.mapSets.create({ name: "Pinned maps", game: "hll", pool: { dayCount: 5 } });
    await repo.mapVote.setConfig(srv.id, { profiles: [{ mapSet: "Pinned maps", schedule: null }] });

    // Scheduled with a pin, by someone who holds both grants.
    const made = await jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Pinned night", serverId: srv.id,
      openMode: "at", openAnchor: "2099-05-01T20:00:00Z", closeMode: "at", closeAnchor: "2099-05-01T23:00:00Z",
      mapVoteProfile: "Pinned maps",
    }) });
    assert.equal(made.status, 201);
    const id = made.body.event.id as string;

    // A host: schedules events, has no say over map votes.
    await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "pinhost", password: "pw" }) });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "pinhost", password: "pw" }) });
    const user = await repo.users.findByUsername("pinhost");
    await repo.grants.create({ userId: user!.id, scopeType: "global", scopeId: null, capability: "events.manage", level: "write" });
    const host = { authorization: `Bearer ${login.body.token as string}` };

    // Renaming, with the stored pin coming back untouched in the same body.
    const renamed = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: host, body: JSON.stringify({
      name: "Pinned night (moved)", mapVoteProfile: "Pinned maps",
    }) });
    assert.equal(renamed.status, 200, "an unchanged pin must not refuse an edit to everything else");
    assert.equal(renamed.body.event.name, "Pinned night (moved)");
    assert.equal(renamed.body.event.mapVoteProfile, "Pinned maps", "and the pin is still there afterwards");

    // The rule that does matter: they still cannot point it somewhere new.
    await repo.mapSets.create({ name: "Other maps", game: "hll", pool: { dayCount: 5 } });
    await repo.mapVote.setConfig(srv.id, { profiles: [{ mapSet: "Pinned maps", schedule: null }, { mapSet: "Other maps", schedule: null }] });
    const repinned = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: host, body: JSON.stringify({
      mapVoteProfile: "Other maps",
    }) });
    assert.deepEqual(await askedFor(base, auth, repinned), { capability: "mapvote.config", serverId: srv.id }, "changing the pin is still a map-vote power");
    assert.equal((await jf(`${base}/api/payout-events/${id}`, { headers: auth })).body.event.mapVoteProfile, "Pinned maps");

    // Nor carry the same pin name onto another server, where it is a different pool entirely.
    const moved = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: host, body: JSON.stringify({
      serverId: other.id, mapVoteProfile: "Pinned maps",
    }) });
    assert.deepEqual(await askedFor(base, auth, moved), { capability: "mapvote.config", serverId: other.id }, "the same name on another server is a new pin, not the old one");
    const still = (await jf(`${base}/api/payout-events/${id}`, { headers: auth })).body.event;
    assert.deepEqual([still.serverId, still.mapVoteProfile], [srv.id, "Pinned maps"], "nothing moved on the asking");

    // And clearing it needs nothing — it hands the choice back to the schedule.
    const cleared = await jf(`${base}/api/payout-events/${id}`, { method: "PATCH", headers: host, body: JSON.stringify({
      mapVoteProfile: null,
    }) });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.event.mapVoteProfile, null);
  });
});

/**
 * Two roles, each with its own amount, and no base amount — the shape a tiered payout is built in.
 *
 * A blank tier means "pay the base", so the base matters the moment one tier is left blank, and not
 * before. Requiring it regardless meant the obvious way to use this feature — price every role you
 * are paying, leave the base empty — was refused as incomplete, both at the Pay button and at the
 * door. Nothing would ever have read the number it was asking for.
 */
test("every tier priced needs no base amount, and a blank tier still requires one", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "NoBase", host: "10.9.0.1", port: 1, password: "x" });
    const tech = await seedLinked(repo, "0401", "d-tech");
    const admin = await seedLinked(repo, "0402", "d-admin");
    for (const p of [tech, admin]) await repo.sessions.open(p.id, srv.id, new Date().toISOString());
    await repo.appConfig.set({ communityGuildId: "999444" });
    const prevToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "test-token";
    const rolesByUser: Record<string, string[]> = { "d-tech": ["400001"], "d-admin": ["400002"] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const m = /guilds\/999444\/members\/([^/?]+)$/.exec(url);
      if (m) {
        const roles = rolesByUser[m[1]!];
        return roles ? new Response(JSON.stringify({ user: { username: m[1] }, roles }), { status: 200 }) : new Response("{}", { status: 404 });
      }
      return real(input as never, init);
    }) as typeof fetch;

    try {
      // TECH SUPPORT 50, ADMIN 100, base left empty.
      const tiers = [{ roleId: "400001", amount: 50 }, { roleId: "400002", amount: 100 }];
      const body = (over: Record<string, unknown> = {}) => JSON.stringify({
        source: { type: "online", serverId: srv.id }, kind: "currency", audience: "linked",
        tiers, serverIds: [], dryRun: false, ...over,
      });

      assert.equal((await jf(`${base}/api/payouts/preview`, { method: "POST", headers: auth, body: body() })).status, 200);
      const run = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: body({ amount: "" }) });
      assert.equal(run.status, 202, "a payout where every tier prices itself is complete without a base");
      const settled = await settledJob(base, auth, run.body.job.id);
      assert.equal(settled.job.status, "COMPLETE");
      assert.equal((await repo.economy.member("d-tech"))?.balance, 50);
      assert.equal((await repo.economy.member("d-admin"))?.balance, 100);

      // Leave one tier blank and the base is load-bearing again — and says so.
      const mixed = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: body({
        amount: "", tiers: [{ roleId: "400001", amount: 50 }, { roleId: "400002", amount: null }],
      }) });
      assert.equal(mixed.status, 400);
      assert.match(String(mixed.body.error?.message ?? ""), /tier left blank pays the base/i,
        "the message explains which tier made the base necessary");

      // And with no tiers at all, the amount is the whole payout — still required.
      const untiered = await jf(`${base}/api/payouts`, { method: "POST", headers: auth, body: body({ amount: "", tiers: [] }) });
      assert.equal(untiered.status, 400);
      assert.match(String(untiered.body.error?.message ?? ""), /above zero/i);
    } finally {
      globalThis.fetch = real;
      if (prevToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = prevToken;
    }
  });
});

/*
 * The event's ROTATION half: a saved lineup attached to the event, applied by the worker when it
 * opens. Validation lives at the door — a set that cannot yield a concrete lineup would otherwise
 * sit silent until event night, exactly the failure mode the vote pin's checks exist to prevent.
 */
test("an event's rotation set: lineup sets round-trip, recipes and ghosts are refused, clearing needs nothing", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const srv = await repo.servers.create({ name: "EvRot", host: "10.9.9.9", port: 29901, password: "x" });
    const lineup = await repo.mapSets.create({ name: "Friday lineup", game: "hll", pool: { sequence: ["foy_warfare", "carentan_warfare"] } });
    const recipe = await repo.mapSets.create({ name: "Dice night", game: "hll", pool: { dayCount: 3 } });
    const post = (extra: Record<string, unknown>) => jf(`${base}/api/payout-events`, { method: "POST", headers: auth, body: JSON.stringify({
      name: "Event", serverId: srv.id, openMode: "at", openAnchor: "2099-01-01T20:00:00Z",
      closeMode: "at", closeAnchor: "2099-01-01T22:00:00Z", ...extra,
    }) });

    assert.match(String((await post({ rotationSetId: recipe.id })).body.error?.message ?? ""), /recipe/,
      "a counts-and-rules set is refused when the event is written, not on event night");
    assert.match(String((await post({ rotationSetId: "00000000-0000-4000-8000-000000000042" })).body.error?.message ?? ""), /no longer exists/);

    const created = await post({ name: "Friday", rotationSetId: lineup.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.event.rotationSetId, lineup.id);

    // Clearing hands the rotation back to staff — no grant question, same as unpinning the vote.
    const evId = created.body.event.id as string;
    const cleared = await jf(`${base}/api/payout-events/${evId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ rotationSetId: "" }) });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.event.rotationSetId, null);
    // …and re-attaching through the edit path validates like create.
    assert.match(String((await jf(`${base}/api/payout-events/${evId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ rotationSetId: recipe.id }) })).body.error?.message ?? ""), /recipe/);

    // A host without the rotation key on the event's server asks for it — there, not anywhere.
    await jf(`${base}/api/auth/register`, { method: "POST", headers: auth, body: JSON.stringify({ username: "rothost", password: "pw" }) });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "rothost", password: "pw" }) });
    const user = await repo.users.findByUsername("rothost");
    await repo.grants.create({ userId: user!.id, scopeType: "global", scopeId: null, capability: "events.manage", level: "write" });
    const host = { authorization: `Bearer ${login.body.token as string}` };
    const rotationHere = { capability: "maps.rotation", serverId: srv.id };
    const scheduled = await jf(`${base}/api/payout-events`, { method: "POST", headers: host, body: JSON.stringify({
      name: "Host night", serverId: srv.id, openMode: "at", openAnchor: "2099-02-01T20:00:00Z", closeMode: "at", closeAnchor: "2099-02-01T22:00:00Z", rotationSetId: lineup.id,
    }) });
    assert.deepEqual(await askedFor(base, auth, scheduled), rotationHere);
    assert.ok(!(await repo.payoutEvents.list({ limit: 500, offset: 0 })).some((e) => e.name === "Host night"), "not scheduled on the asking");
    const attached = await jf(`${base}/api/payout-events/${evId}`, { method: "PATCH", headers: host, body: JSON.stringify({ rotationSetId: lineup.id }) });
    assert.deepEqual(await askedFor(base, auth, attached), rotationHere);
    assert.equal((await repo.payoutEvents.get(evId))!.rotationSetId, null, "not attached on the asking");
  });
});

/*
 * Both lists come a page at a time, up to 500 to a page: the panel's pages go up to 200, and a page
 * cut short at 100 started the next one past rows nobody was shown.
 */
test("payout events and runs come a page at a time, up to 500 to a page, with how many there are", async () => {
  await withCleanServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const server = await repo.servers.create({ name: "Paged", host: "10.0.0.9", port: 9, password: "x" });
    for (let i = 0; i < 230; i++) {
      await repo.payoutEvents.create({ name: `Event ${i}`, serverId: server.id, openMode: "at", openAnchor: "2099-01-01T20:00:00.000Z",
        closeMode: "at", closeAnchor: "2099-01-01T22:00:00.000Z", minMinutes: 0, mapVoteProfile: null, rotationSetId: null, createdBy: "test" });
      await repo.payouts.create({ sourceType: "linked", sourceRef: {}, payoutType: "currency", amount: 1, serverIds: [], audience: "linked",
        dryRun: true, status: "COMPLETE", requestedByUserId: null, requestedByName: "test", totalCount: 0, duplicateKey: `paged-${i}` });
    }
    for (const path of ["/api/payout-events", "/api/payouts"]) {
      const ids = (r: { body: Record<string, any> }) => (r.body.items as { id: string }[]).map((x) => x.id);
      const all = await jf(`${base}${path}?limit=500`, { headers: auth });
      assert.equal(all.body.items.length, 230, `${path}: every one on a page of 500`);
      assert.equal(all.body.total, 230);
      const first = await jf(`${base}${path}?limit=200`, { headers: auth });
      const rest = await jf(`${base}${path}?offset=200&limit=200`, { headers: auth });
      assert.equal(first.body.items.length, 200, `${path}: a page of 200 holds 200`);
      assert.deepEqual([...ids(first), ...ids(rest)], ids(all), `${path}: two pages are the whole list, in order`);
      assert.equal((await jf(`${base}${path}?limit=900`, { headers: auth })).body.limit, 500, `${path}: more than 500 is trimmed to 500`);
    }
  });
});
