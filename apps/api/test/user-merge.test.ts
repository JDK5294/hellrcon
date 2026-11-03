/**
 * Staff account merge — the fix for "I signed in with Discord before linking and now have two
 * accounts". Covers the repo merge semantics (history moves, reads dedupe keeping the earliest,
 * Discord identity transfers, duplicate deleted) and the admin route's gates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withServer, jf, askedFor } from "./harness.ts";

async function login(base: string, u: string, p: string) {
  const r = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

test("admin merge: history, reads, and Discord identity move to the survivor; duplicate deleted", async () => {
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");

    // The long-standing manual account (survivor) and the account a first Discord sign-in
    // auto-created (duplicate) — the duplicate carries history worth keeping.
    const survivor = await repo.users.create({ username: "old-manual" });
    const dup = await repo.users.create({ username: "lynx-kyle", discordId: "d-777", discordUsername: "kyle", discordNick: "LYNX Kyle", discordManaged: true });
    await repo.audit.create({ actorUserId: dup.id, actorName: "lynx-kyle", action: "action.kick", targetType: "player", targetId: "p1", targetName: "Frigo", summary: "kicked Frigo" });
    await repo.audit.create({ actorUserId: dup.id, actorName: "lynx-kyle", action: "user.password", targetType: "user", targetId: dup.id, targetName: "lynx-kyle", summary: "self" });
    const ann = await repo.announcements.create({ title: "rules", body: "b", published: true, authorUserId: dup.id });
    // Both accounts read the same notice — the merged receipt must keep the EARLIEST read and the ack.
    await repo.announcements.markRead(survivor.id, [ann.id]);
    await repo.announcements.markRead(dup.id, [ann.id]);
    const dupRead = (await repo.announcements.readsForUser(dup.id))[0]!;
    await repo.announcements.acknowledge(ann.id, dup.id);

    const r = await jf(`${base}/api/users/${survivor.id}/merge`, { method: "POST", headers: owner, body: JSON.stringify({ duplicateId: dup.id }) });
    assert.equal(r.status, 200);
    // Identity transferred: the survivor is now the Discord-linked account.
    assert.equal(r.body.user.discordId, "d-777");
    assert.equal(r.body.user.username, "old-manual");

    // Duplicate is gone; a Discord sign-in for d-777 would now find the survivor.
    assert.equal(await repo.users.findById(dup.id), null);
    assert.equal((await repo.users.findByDiscordId("d-777"))?.id, survivor.id);

    // History moved: both audit rows (actor AND the user-target one) now belong to the survivor.
    const moved = await repo.audit.list({ actorUserId: survivor.id, limit: 10 });
    assert.equal(moved.filter((a) => a.action === "action.kick").length, 1);
    assert.equal(moved.find((a) => a.action === "user.password")?.targetId, survivor.id);

    // Announcement authorship + reads: survivor has ONE receipt with the earliest read + the ack.
    const reads = await repo.announcements.readsForUser(survivor.id);
    assert.equal(reads.length, 1);
    assert.ok(reads[0]!.readAt <= dupRead.readAt);
    assert.ok(reads[0]!.acknowledgedAt);

    // The audit trail recorded the merge under the acting admin.
    const ownerRow = (await repo.users.list()).find((u) => u.username === "owner")!;
    const adminTrail = await repo.audit.list({ actorUserId: ownerRow.id, limit: 20 });
    assert.ok(adminTrail.some((a) => a.action === "user.merge"));
  });
});

test("admin merge gates: permission (asked for), self-merge, and self-as-duplicate are refused", async () => {
  await withServer(async (base, repo) => {
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
    const owner = await login(base, "owner", "pw");
    await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "pleb", password: "pw" }) });
    const pleb = await login(base, "pleb", "pw");
    const users = (await jf(`${base}/api/users`, { headers: owner })).body.users as { id: string; username: string }[];
    const ownerId = users.find((u) => u.username === "owner")!.id;
    const plebId = users.find((u) => u.username === "pleb")!.id;
    const other = await repo.users.create({ username: "spare" });

    const asked = await jf(`${base}/api/users/${other.id}/merge`, { method: "POST", headers: pleb, body: JSON.stringify({ duplicateId: plebId }) });
    assert.deepEqual(await askedFor(base, owner, asked), { capability: "admin.users", serverId: null });
    assert.ok(await repo.users.findById(plebId), "nothing merged on the asking");
    assert.equal((await jf(`${base}/api/users/${other.id}/merge`, { method: "POST", headers: owner, body: JSON.stringify({ duplicateId: other.id }) })).status, 400);
    // Deleting the account you are logged in as (as the "duplicate") would strand your session.
    assert.equal((await jf(`${base}/api/users/${other.id}/merge`, { method: "POST", headers: owner, body: JSON.stringify({ duplicateId: ownerId }) })).status, 400);
    assert.equal((await jf(`${base}/api/users/${other.id}/merge`, { method: "POST", headers: owner, body: JSON.stringify({}) })).status, 400);
    assert.equal((await jf(`${base}/api/users/${randomUUIDLike()}/merge`, { method: "POST", headers: owner, body: JSON.stringify({ duplicateId: other.id }) })).status, 404);
  });
});

function randomUUIDLike(): string { return "00000000-0000-4000-8000-000000000000"; }
