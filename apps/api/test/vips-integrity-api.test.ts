/**
 * The integrity endpoints end to end: the scan reads the trail, the dismissal writes to the
 * same trail, and the next scan believes it — no side table, no cache to disagree with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jf, ownerAuth, askedFor } from "./harness.ts";

test("ignore round-trip: a dismissed finding leaves the scan, recorded as the dismisser's own act", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const s = await repo.servers.create({ name: "S", host: "127.0.0.1", port: 71, password: "p" });
    // The damage, as the trail records it: a human permanent, then the pre-floor seed reward
    // writing a date over it, with the row standing dated today.
    await repo.audit.create({ actorUserId: null, actorName: "importer", action: "vip.grant", targetType: "player", targetId: "765-a", targetName: "Payer", serverId: s.id, summary: "s", data: { expiration: null } });
    await repo.audit.create({ actorUserId: null, actorName: "seeding", action: "seed.reward", targetType: "player", targetId: "765-a", targetName: "Payer", serverId: s.id, summary: "s", data: { expiration: "2026-09-30T00:00:00.000Z" } });
    await repo.vips.upsert({ serverId: s.id, playerId: "765-a", playerName: "Payer", comment: null, expiration: "2026-09-30T00:00:00.000Z", createdByUserId: null, createdByName: "seeding" });

    const before = await jf(`${base}/api/vips/integrity`, { headers: auth });
    assert.equal((before.body.findings as unknown[]).length, 1, "the damaged grant is a finding");

    const ignore = await jf(`${base}/api/vips/integrity/ignore`, { method: "POST", headers: auth, body: JSON.stringify({ serverId: s.id, playerId: "765-a", playerName: "Payer" }) });
    assert.equal(ignore.status, 200);

    const after = await jf(`${base}/api/vips/integrity`, { headers: auth });
    assert.deepEqual(after.body.findings, [], "the dismissal closed the story");

    const trail = await repo.audit.list({ actions: ["vip.integrity_ignore"], limit: 10 });
    assert.equal(trail.length, 1);
    assert.equal(trail[0]!.automated, false, "a dismissal is a person's act, on the record");
    assert.match(trail[0]!.summary, /judged the removal intentional/);
  });
});

test("ignore is gated: no VIP write permission on that server, no dismissal — only a request for one", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const s = await repo.servers.create({ name: "S", host: "127.0.0.1", port: 72, password: "p" });
    await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plainv", password: "pw" }) });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "plainv", password: "pw" }) });
    const plain = { authorization: `Bearer ${login.body.token as string}` };
    const r = await jf(`${base}/api/vips/integrity/ignore`, { method: "POST", headers: plain, body: JSON.stringify({ serverId: s.id, playerId: "765-a" }) });
    assert.deepEqual(await askedFor(base, auth, r), { capability: "vip.revoke", serverId: s.id }, "asked of someone holding a VIP key on THAT server");
    assert.deepEqual(await repo.audit.list({ actions: ["vip.integrity_ignore"], limit: 10 }), [], "nothing dismissed on the asking");
  });
});

/*
 * The field report: "every finding I ignore shows up again when I recheck, and every player I add
 * time back to shows again — they're not getting their time back or it isn't actually checking".
 * The scan read 20,000 audit rows oldest first and stopped. On an install whose VIP sync writes a
 * row for every grant it puts back on the game, the rows it dropped were the NEWEST — every
 * dismissal and every add-back. These replay the damage behind a history longer than that window.
 */
// Audit rows written back to back can share a millisecond in the test store, and a tie is broken
// by id — so each ordered step waits a moment, and the trail reads in the order it describes.
const tick = () => new Promise((r) => setTimeout(r, 3));
const NOISE = 20_050;
async function longVipHistory(repo: { audit: { create(a: object): Promise<unknown> } }, serverId: string): Promise<void> {
  // The expiry sweep ending grants nobody is tracking: rows the scan reads and drops, no findings.
  for (let i = 0; i < NOISE; i++) {
    await repo.audit.create({ actorUserId: null, actorName: "system", action: "vip.expire", targetType: "player", targetId: `noise-${i % 700}`, serverId, summary: "expired", data: {} });
  }
}

test("a dismissal past 20,000 older VIP rows still closes its finding", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const s = await repo.servers.create({ name: "S", host: "127.0.0.1", port: 73, password: "p" });
    await repo.audit.create({ actorUserId: null, actorName: "importer", action: "vip.grant", targetType: "player", targetId: "765-a", targetName: "Payer", serverId: s.id, summary: "s", data: { expiration: null } });
    await tick();
    await repo.audit.create({ actorUserId: null, actorName: "seeding", action: "seed.reward", targetType: "player", targetId: "765-a", targetName: "Payer", serverId: s.id, summary: "s", data: { expiration: "2026-09-30T00:00:00.000Z" } });
    await tick();
    await repo.vips.upsert({ serverId: s.id, playerId: "765-a", playerName: "Payer", expiration: "2026-09-30T00:00:00.000Z", createdByName: "seeding" });
    await longVipHistory(repo, s.id);

    const before = await jf(`${base}/api/vips/integrity`, { headers: auth });
    assert.deepEqual((before.body.findings as { playerId: string }[]).map((f) => f.playerId), ["765-a"]);
    assert.ok((before.body.scanned as number) > NOISE, `the whole history is read (${before.body.scanned as number} rows)`);

    await jf(`${base}/api/vips/integrity/ignore`, { method: "POST", headers: auth, body: JSON.stringify({ serverId: s.id, playerId: "765-a", playerName: "Payer" }) });
    const after = await jf(`${base}/api/vips/integrity`, { headers: auth });
    assert.deepEqual(after.body.findings, [], "the dismissal — the newest row in the trail — is read, and the finding stays closed");
  });
});

test("time added back past 20,000 older VIP rows clears the finding", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const s = await repo.servers.create({ name: "S", host: "127.0.0.1", port: 74, password: "p" });
    // A seed reward ran the grant to June; a rule's write moved it back to January — hours taken.
    await repo.audit.create({ actorUserId: null, actorName: "seeding", action: "seed.reward", targetType: "player", targetId: "765-b", targetName: "Grape", serverId: s.id, summary: "s", data: { expiration: "2030-06-01T00:00:00.000Z" } });
    await tick();
    await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: "765-b", targetName: "Grape", serverId: s.id, summary: "s", data: { expiration: "2030-01-01T00:00:00.000Z" } });
    await tick();
    await repo.vips.upsert({ serverId: s.id, playerId: "765-b", playerName: "Grape", expiration: "2030-01-01T00:00:00.000Z", createdByName: "game rewards" });
    await longVipHistory(repo, s.id);
    // In a VIP timeout, so the add-back skips the (unreachable) game and still lands on the ledger.
    await repo.vips.setPause(s.id, "765-b", { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "t", by: "owner" });

    const before = await jf(`${base}/api/vips/integrity`, { headers: auth });
    const f = (before.body.findings as { playerId: string; verdict: string; lostMs: number }[]).find((x) => x.playerId === "765-b");
    assert.equal(f?.verdict, "shortened");
    // The panel's "Add … back": the taken hours stacked onto what stands.
    const hours = Math.ceil(f!.lostMs / 3_600_000);
    const added = await jf(`${base}/api/servers/${s.id}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "765-b", playerName: "Grape", mode: "duration", days: Math.floor(hours / 24), hours: hours % 24, cumulative: true, comment: "time added back — VIP integrity scan" }) });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const after = await jf(`${base}/api/vips/integrity`, { headers: auth });
    assert.deepEqual(after.body.findings, [], "the add-back — the newest row — is read, and the player is off the list");
  });
});

test("CRCON's year-3000 grant dated down by automation reads as a downgraded PERMANENT grant, and Restore clears it", async () => {
  await withServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const s = await repo.servers.create({ name: "WW2", host: "127.0.0.1", port: 75, password: "p" });
    // The screenshots, row for row: the VIP sync put a year-3000 grant back on the game, then a
    // rule's VIP wrote "now + 3 days" over it.
    await repo.audit.create({ actorUserId: null, actorName: "vip-sync", action: "vip.grant", targetType: "player", targetId: "765-c", targetName: "Dads_soup", serverId: s.id, summary: "restored", data: { playerId: "765-c", expiration: "3000-01-04T00:00:00.000Z", reconcile: true } });
    await tick();
    await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "enforcer.vip", targetType: "player", targetId: "profile-c", targetName: "Dads_soup", serverId: s.id, summary: "rule VIP", data: { playerId: "765-c", expiration: "2026-10-03T07:17:42.131Z" } });
    await tick();
    await repo.vips.upsert({ serverId: s.id, playerId: "765-c", playerName: "Dads_soup", expiration: "2026-10-03T07:17:42.131Z", createdByName: "enforcer" });

    const before = await jf(`${base}/api/vips/integrity`, { headers: auth });
    const f = (before.body.findings as { playerId: string; verdict: string; lostMs?: number; evidence: string[] }[]).find((x) => x.playerId === "765-c");
    assert.equal(f?.verdict, "downgraded", "a permanent grant dated down — not 'shortened' by eight and a half million hours");
    assert.equal(f?.lostMs, undefined);
    assert.match(f!.evidence.join("\n"), /rule VIP wrote an expiration of 2026-10-03/);

    await repo.vips.setPause(s.id, "765-c", { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "t", by: "owner" });
    const restored = await jf(`${base}/api/servers/${s.id}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "765-c", playerName: "Dads_soup", mode: "permanent", comment: "restored — VIP integrity scan" }) });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await repo.vips.get(s.id, "765-c"))!.expiration, null, "permanent again");
    const after = await jf(`${base}/api/vips/integrity`, { headers: auth });
    assert.deepEqual(after.body.findings, []);
  });
});
