/**
 * The multi-reason watchlist. A watch used to be a boolean with one reason field, so a second
 * staff member's concern either overwrote the first or vanished — the "Add to watchlist" option
 * simply disappeared once anyone was first. What is pinned here: reasons ACCUMULATE, each one
 * edits and removes on its own with its previous versions retrievable, an expiry lapses a reason
 * on its own clock, and the flag every roster reads never disagrees with the reasons.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { createRepository } from "@app/db";
import { createHandler, createAppContext } from "../dist/app.js";
import { jf, ownerAuth, askedFor } from "./harness.ts";

async function withRepoServer(fn: (base: string, repo: any) => Promise<void>): Promise<void> {
  const repo = await createRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`, repo); } finally { server.close(); }
}
let seq = 0;
async function seedPlayer(repo: any) {
  return repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611980001${String(++seq).padStart(5, "0")}`, name: `Watched${seq}` });
}

test("reasons accumulate: a second concern lands beside the first, and the old route appends too", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const player = await seedPlayer(repo);

    const a = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "racial slurs in chat" }) });
    assert.equal(a.status, 201);
    assert.equal(a.body.flags.watchlist, true, "the first reason arms the watch");
    const b = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "suspected teaming" }) });
    assert.equal(b.status, 201);

    // The pre-reasons route appends as well — a client that predates the model contributes
    // instead of overwriting, which is what "add to watchlist" always should have meant.
    const legacy = await jf(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ watchlist: true, reason: "ban evasion suspicion" }) });
    assert.equal(legacy.status, 200);

    const w = await jf(`${base}/api/players/${player.id}/watch`, { headers: auth });
    assert.equal(w.body.watched, true);
    const active = (w.body.reasons as any[]).filter((r) => r.removedAt === null);
    assert.deepEqual(active.map((r) => r.reason).sort(), ["ban evasion suspicion", "racial slurs in chat", "suspected teaming"]);

    // An empty reason is refused — a 👁 with nothing to say is not a record.
    assert.equal((await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "  " }) })).status, 400);
  });
});

test("an edit keeps the previous version retrievable, and closed history cannot be rewritten", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const player = await seedPlayer(repo);
    const made = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "original wording" }) });
    const id = made.body.reason.id as string;

    const edited = await jf(`${base}/api/players/${player.id}/watch/reasons/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ reason: "sharper wording" }) });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.reason.reason, "sharper wording");
    assert.equal(edited.body.reason.edits.length, 1);
    assert.equal(edited.body.reason.edits[0].reason, "original wording", "what it used to say is on the row");
    assert.equal(edited.body.reason.edits[0].editedBy, "owner");

    // The change is in the trail too, before AND after.
    const audit = await jf(`${base}/api/audit?limit=10`, { headers: auth });
    const row = (audit.body.entries as any[]).find((e) => e.data?.op === "edit-reason");
    assert.equal(row?.data?.before?.reason, "original wording");
    assert.equal(row?.data?.after?.reason, "sharper wording");

    // Close it; a removed reason is history and refuses edits.
    assert.equal((await jf(`${base}/api/players/${player.id}/watch/reasons/${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jf(`${base}/api/players/${player.id}/watch/reasons/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ reason: "rewrite attempt" }) })).status, 400);
  });
});

test("removing one reason keeps the watch standing; removing the last lifts it — nothing is deleted", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const player = await seedPlayer(repo);
    const a = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "first" }) });
    const b = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "second" }) });

    const afterOne = await jf(`${base}/api/players/${player.id}/watch/reasons/${a.body.reason.id}`, { method: "DELETE", headers: auth });
    assert.equal(afterOne.body.flags.watchlist, true, "one reason down, the other keeps the watch");
    const afterTwo = await jf(`${base}/api/players/${player.id}/watch/reasons/${b.body.reason.id}`, { method: "DELETE", headers: auth });
    assert.equal(afterTwo.body.flags.watchlist, false, "the last reason lifts the watch");

    const w = await jf(`${base}/api/players/${player.id}/watch`, { headers: auth });
    assert.equal(w.body.watched, false);
    assert.equal((w.body.reasons as any[]).length, 2, "closed reasons stay on the record");
    assert.ok((w.body.reasons as any[]).every((r) => r.removedAt && r.removedBy === "owner"));

    // The old remove-from-watchlist closes EVERYTHING at once.
    await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "third" }) });
    await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "fourth" }) });
    const off = await jf(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: auth, body: JSON.stringify({ watchlist: false }) });
    assert.equal(off.body.flags.watchlist, false);
    const all = await jf(`${base}/api/players/${player.id}/watch`, { headers: auth });
    assert.ok((all.body.reasons as any[]).every((r) => r.removedAt !== null));
  });
});

test("expirations: the past is refused, a lapsed reason stops counting, and the sweep disarms the flag", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const player = await seedPlayer(repo);

    assert.equal((await jf(`${base}/api/players/${player.id}/watch/reasons`, {
      method: "POST", headers: auth, body: JSON.stringify({ reason: "late", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    })).status, 400, "an already-past expiry would lift itself immediately");

    // A real (very short) expiry, end to end through the route.
    const made = await jf(`${base}/api/players/${player.id}/watch/reasons`, {
      method: "POST", headers: auth, body: JSON.stringify({ reason: "one-night watch", expiresAt: new Date(Date.now() + 80).toISOString() }),
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.flags.watchlist, true);

    await sleep(120);
    // Lapsed: the reason no longer counts anywhere that filters on active…
    const flaggedRow = ((await jf(`${base}/api/players/flagged`, { headers: auth })).body.flags as any[])
      .find((f) => f.playerId === player.id);
    assert.deepEqual(flaggedRow?.reasons ?? [], [], "a lapsed reason is not an active one");
    // …and the sweep's query names the player so the cached flag can be disarmed.
    const lapsed = await repo.watchReasons.lapsedWatchers();
    assert.ok(lapsed.includes(player.id), "the expiry sweep finds the lapsed watch");
    await repo.playerFlags.set(player.id, { watchlist: false }, { userId: null, name: "watch-expiry" });
    assert.equal((await repo.playerFlags.get(player.id))?.watchlist, false);
  });
});

test("curation is its own permission: base write adds and edits its OWN, never removes", async () => {
  await withRepoServer(async (base, repo) => {
    const owner = await ownerAuth(base);
    const player = await seedPlayer(repo);

    // A trial mod: watchlist write, NO curation.
    const u = await jf(`${base}/api/users`, { method: "POST", headers: owner, body: JSON.stringify({ username: "trial", password: "pw" }) });
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [{ capability: "player.watchlist", level: "write", scopeType: "global", scopeId: null }] }),
    });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "trial", password: "pw" }) });
    const trial = { authorization: `Bearer ${login.body.token as string}` };

    // The owner records a reason; the trial mod records their own beside it.
    const owners = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: owner, body: JSON.stringify({ reason: "seen teaming" }) });
    const mine = await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: trial, body: JSON.stringify({ reason: "chat spam" }) });
    assert.equal(mine.status, 201, "adding is the base write");

    // Their OWN wording they may sharpen — the previous version stays on the row…
    const editMine = await jf(`${base}/api/players/${player.id}/watch/reasons/${mine.body.reason.id}`, { method: "PATCH", headers: trial, body: JSON.stringify({ reason: "chat spam, repeated after warning" }) });
    assert.equal(editMine.status, 200);
    assert.equal(editMine.body.reason.edits[0].reason, "chat spam");
    // …and the watch feed tells them which rows are theirs.
    const w = await jf(`${base}/api/players/${player.id}/watch`, { headers: trial });
    assert.deepEqual((w.body.reasons as any[]).map((r) => [r.reason, r.own]).sort(),
      [["chat spam, repeated after warning", true], ["seen teaming", false]]);

    // Another staff member's reason is theirs: no edit — the request it files asks for the
    // missing half.
    const curate = { capability: "player.watchlist.curate", serverId: null };
    const reasons = async () => ((await jf(`${base}/api/players/${player.id}/watch`, { headers: owner })).body.reasons as { reason: string }[]).map((r) => r.reason).sort();
    const editTheirs = await jf(`${base}/api/players/${player.id}/watch/reasons/${owners.body.reason.id}`, { method: "PATCH", headers: trial, body: JSON.stringify({ reason: "rewritten" }) });
    assert.deepEqual(await askedFor(base, owner, editTheirs), curate);

    // Removal is curation even for their OWN row — what went into the record stays.
    assert.deepEqual(await askedFor(base, owner, await jf(`${base}/api/players/${player.id}/watch/reasons/${mine.body.reason.id}`, { method: "DELETE", headers: trial })), curate);
    assert.deepEqual(await askedFor(base, owner, await jf(`${base}/api/players/${player.id}/watch/reasons/${owners.body.reason.id}`, { method: "DELETE", headers: trial })), curate);
    assert.deepEqual(await reasons(), ["chat spam, repeated after warning", "seen teaming"], "nothing rewritten or removed on the asking");
    /*
     * Lifting the watch closes other staff's reasons, so it is curation — but curation they lack
     * is an ASK, not a wall: the same call files a request for someone who holds it, exactly like
     * every other action in the app. What must not happen is the watch coming off.
     */
    const lift = await jf(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: trial, body: JSON.stringify({ watchlist: false }) });
    assert.equal(lift.status, 202, JSON.stringify(lift.body));
    assert.equal(lift.body.requested, true);
    assert.equal((await jf(`${base}/api/players/${player.id}/watch`, { headers: owner })).body.watched, true, "still watched — only a request was filed");
    // The legacy add direction still works for them.
    assert.equal((await jf(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: trial, body: JSON.stringify({ watchlist: true, reason: "third concern" }) })).status, 200);

    // Granted the curation half, the same person can prune anyone's rows and lift the watch.
    await jf(`${base}/api/users/${u.body.user.id as string}/grants`, {
      method: "PUT", headers: owner,
      body: JSON.stringify({ grants: [
        { capability: "player.watchlist", level: "write", scopeType: "global", scopeId: null },
        { capability: "player.watchlist.curate", level: "write", scopeType: "global", scopeId: null },
      ] }),
    });
    assert.equal((await jf(`${base}/api/players/${player.id}/watch/reasons/${owners.body.reason.id}`, { method: "DELETE", headers: trial })).status, 200);
    assert.equal((await jf(`${base}/api/players/${player.id}/flags`, { method: "PATCH", headers: trial, body: JSON.stringify({ watchlist: false }) })).status, 200);
  });
});

test("the watched feed carries every active reason, not just the newest", async () => {
  await withRepoServer(async (base, repo) => {
    const auth = await ownerAuth(base);
    const player = await seedPlayer(repo);
    await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "alpha" }) });
    await jf(`${base}/api/players/${player.id}/watch/reasons`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "beta" }) });
    const row = ((await jf(`${base}/api/players/flagged`, { headers: auth })).body.flags as any[])
      .find((f) => f.playerId === player.id);
    assert.deepEqual((row?.reasons as any[]).map((r) => r.reason).sort(), ["alpha", "beta"]);
  });
});
