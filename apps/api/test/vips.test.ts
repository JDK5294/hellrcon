import { test } from "node:test";
import assert from "node:assert/strict";
import { withIsolatedServer as withServer, jsonFetch, askedFor } from "./harness.ts";
import { fakeGameServer } from "./fake-hll-server.ts";

async function login(base: string, u: string, p: string) {
  const r = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: u, password: p }) });
  return { authorization: `Bearer ${r.body.token as string}` };
}

async function owner(base: string): Promise<{ auth: Record<string, string>; serverId: string }> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const auth = await login(base, "owner", "pw");
  const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "t", host: "127.0.0.1", port: 1, password: "x" }) });
  return { auth, serverId: (created.body.server as { id: string }).id };
}

test("VIP list requires auth", async () => {
  await withServer(async (base) => {
    assert.equal((await jsonFetch(`${base}/api/servers/x/vips`)).status, 401);
  });
});

test("VIP list is gated by vip.grant/vip.revoke; owner sees an empty list", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plain", password: "pw" }) });
    const plain = await login(base, "plain", "pw");
    assert.equal((await jsonFetch(`${base}/api/servers/${serverId}/vips`, { headers: plain })).status, 403);
    const ok = await jsonFetch(`${base}/api/servers/${serverId}/vips`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.vips, []);
  });
});

test("VIP grant validates player + mode before touching the game", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    // missing playerId
    assert.equal((await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ mode: "permanent" }) })).status, 400);
    // until without a date
    const badUntil = await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "abc", mode: "until", comment: "donor" }) });
    assert.equal(badUntil.status, 400);
    // until with a PAST date — a wrong-year date-picker slip. Accepting it created a grant that
    // was already expired: AddVip went to the game, the next sweep removed it two minutes later,
    // and the audit said "VIP expired" about a grant staff watched themselves make.
    const pastUntil = await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "abc", mode: "until", expiresAt: new Date(Date.now() - 86_400_000).toISOString(), comment: "donor" }) });
    assert.equal(pastUntil.status, 400);
    assert.match(String((pastUntil.body as { error?: { message?: string } }).error?.message ?? ""), /in the past/);
    // duration with no time
    const badDur = await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "abc", mode: "duration", days: 0, hours: 0, comment: "donor" }) });
    assert.equal(badDur.status, 400);
    // no comment — every VIP a person adds says who paid, what for, or which event
    for (const comment of [undefined, "", "   "]) {
      const noComment = await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "abc", mode: "permanent", comment }) });
      assert.equal(noComment.status, 400, `comment ${JSON.stringify(comment)} is refused`);
      assert.match(String((noComment.body as { error?: { message?: string } }).error?.message ?? ""), /a comment is required for every VIP added/);
    }
    // unknown server
    assert.equal((await jsonFetch(`${base}/api/servers/nope/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "abc" }) })).status, 404);
  });
});

// The Add tab's "…or until an exact date" path: the DATE the staff picked is the expiry that
// lands, to the millisecond — not a duration approximation of it. Exercised on a paused grant
// so the (unreachable) game server is legitimately skipped and the ledger half still runs.
test("VIP grant mode 'until' lands the exact date on the ledger", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const target = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await repo.vips.upsert({ serverId, playerId: "u1", expiration: new Date(Date.now() + 86_400_000).toISOString(), createdByName: "owner" });
    await repo.vips.setPause(serverId, "u1", { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "t", by: "owner" });
    const r = await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "u1", mode: "until", expiresAt: target, comment: "event winner" }) });
    assert.equal(r.status, 200);
    assert.equal((await repo.vips.get(serverId, "u1"))!.expiration, target);
  });
});

test("repo tracks expiry: permanent vs timed, and the sweep query", async () => {
  await withServer(async (_base, repo) => {
    const s = await repo.servers.create({ name: "s", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "active" } as any);
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await repo.vips.upsert({ serverId: s.id, playerId: "perm", expiration: null, createdByName: "owner" });
    await repo.vips.upsert({ serverId: s.id, playerId: "soon", expiration: past, createdByName: "owner" });
    await repo.vips.upsert({ serverId: s.id, playerId: "later", expiration: future, createdByName: "owner" });

    assert.equal((await repo.vips.list(s.id)).length, 3);
    const expired = await repo.vips.expired(new Date().toISOString());
    assert.deepEqual(expired.map((v) => v.playerId), ["soon"]); // permanent + future excluded

    // upsert keeps the original creator, updates expiration
    const updated = await repo.vips.upsert({ serverId: s.id, playerId: "soon", expiration: future, createdByName: "someone-else" });
    assert.equal(updated.createdByName, "owner");
    assert.equal(updated.expiration, future);
    assert.equal((await repo.vips.expired(new Date().toISOString())).length, 0);

    assert.equal(await repo.vips.remove(s.id, "perm"), true);
    assert.equal((await repo.vips.list(s.id)).length, 2);
  });
});

test("config read/write is gated by server.config", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plainc", password: "pw" }) });
    const plain = await login(base, "plainc", "pw");
    assert.equal((await jsonFetch(`${base}/api/servers/${serverId}/config`, { headers: plain })).status, 403);
    // The write half is filed for approval rather than refused (docs/approvals.md); the read
    // half above still refuses, because there is nothing to ask for in a read.
    assert.equal((await jsonFetch(`${base}/api/servers/${serverId}/config`, { method: "POST", headers: plain, body: JSON.stringify({ highPing: 500 }) })).status, 202);
  });
});

test("config write rejects unknown settings before connecting; unknown server 404", async () => {
  await withServer(async (base) => {
    const { auth, serverId } = await owner(base);
    const bad = await jsonFetch(`${base}/api/servers/${serverId}/config`, { method: "POST", headers: auth, body: JSON.stringify({ notAThing: 1 }) });
    assert.equal(bad.status, 400);
    assert.equal((await jsonFetch(`${base}/api/servers/nope/config`, { headers: auth })).status, 404);
  });
});

test("VIP pause: a VIP timeout — grant survives, keeps accumulating, resume restores", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000031", name: "Pausee" });
    await repo.vips.upsert({ serverId, playerId: player.platformId, playerName: "Pausee", comment: null, expiration: new Date(Date.now() + 48 * 3_600_000).toISOString(), createdByUserId: null, createdByName: "owner" });

    // Punishments need a reason; a player with no VIP can't be paused.
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 24 }) })).status, 400);
    const nobody = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000032", name: "NoVip" });
    assert.equal((await jsonFetch(`${base}/api/players/${nobody.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 24, reason: "x" }) })).status, 404);

    const paused = await jsonFetch(`${base}/api/players/${player.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 24, reason: "toxic in chat" }) });
    assert.equal(paused.status, 200);
    const row = await repo.vips.get(serverId, player.platformId);
    assert.equal(row!.pauseReason, "toxic in chat");
    assert.equal(row!.pausedBy, "owner");
    assert.ok(row!.pausedUntil);
    const beforeExpiry = row!.expiration!;

    // Accumulate while paused: a fresh grant extends the expiration but never touches the pause.
    const grant = await jsonFetch(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: player.platformId, mode: "duration", hours: 24, cumulative: true, comment: "donor" }) });
    assert.equal(grant.status, 200);
    const after = await repo.vips.get(serverId, player.platformId);
    assert.ok(Date.parse(after!.expiration!) > Date.parse(beforeExpiry), "expiration extended while paused");
    assert.equal(after!.pauseReason, "toxic in chat", "the grant did not clear the pause");

    // The profile shows the pause; the audit trail records it like a ban (staff stats read audit).
    const prof = await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth });
    assert.equal((prof.body.vipStatus as any[])[0].pauseReason, "toxic in chat");
    const audit = await jsonFetch(`${base}/api/audit`, { headers: auth });
    assert.ok((audit.body.entries as any[]).some((e) => e.action === "player.vippause" && String(e.summary).includes("toxic in chat")));

    // Lapse detection for the worker sweep: a pause whose clock ran out is served up.
    await repo.vips.setPause(serverId, player.platformId, { until: new Date(Date.now() - 1000).toISOString(), reason: "old", by: "x" });
    assert.ok((await repo.vips.pauseLapsed(new Date().toISOString())).some((v) => v.playerId === player.platformId));

    // Resume clears it (audited); resuming an unpaused VIP is a clean 404.
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip/resume`, { method: "POST", headers: auth })).status, 200);
    assert.equal((await repo.vips.get(serverId, player.platformId))!.pausedUntil, null);
    assert.ok(((await jsonFetch(`${base}/api/audit`, { headers: auth })).body.entries as any[]).some((e) => e.action === "player.vipresume"));
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip/resume`, { method: "POST", headers: auth })).status, 404);
  });
});

test("VIP pause (banked): the meter freezes — paused time is returned on resume, and a frozen grant cannot expire", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000033", name: "Banked" });
    const expiration = new Date(Date.now() + 10 * 3_600_000).toISOString();
    await repo.vips.upsert({ serverId, playerId: player.platformId, playerName: "Banked", comment: null, expiration, createdByUserId: null, createdByName: "owner" });

    const paused = await jsonFetch(`${base}/api/players/${player.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 24, reason: "cooldown", mode: "banked" }) });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.mode, "banked");
    assert.equal((await repo.vips.get(serverId, player.platformId))!.pauseMode, "banked");

    // Rewind the pause anchor two hours so the resume has real elapsed time to give back.
    const startedAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await repo.vips.setPause(serverId, player.platformId, { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "cooldown", by: "owner", mode: "banked", at: startedAgo });

    // A banked-frozen grant is invisible to the expiry sweep even if its expiration has passed…
    await repo.vips.upsert({ serverId, playerId: player.platformId, playerName: "Banked", comment: null, expiration: new Date(Date.now() - 1000).toISOString(), createdByUserId: null, createdByName: "owner" });
    assert.ok(!(await repo.vips.expired(new Date().toISOString())).some((v) => v.playerId === player.platformId), "frozen grant does not expire");
    await repo.vips.upsert({ serverId, playerId: player.platformId, playerName: "Banked", comment: null, expiration, createdByUserId: null, createdByName: "owner" });

    // …and resume returns the elapsed pause time onto the expiry (~2h here).
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip/resume`, { method: "POST", headers: auth })).status, 200);
    const after = await repo.vips.get(serverId, player.platformId);
    assert.equal(after!.pausedUntil, null);
    const gainedMs = Date.parse(after!.expiration!) - Date.parse(expiration);
    assert.ok(gainedMs >= 1.9 * 3_600_000 && gainedMs <= 2.2 * 3_600_000, `banked ~2h back, got ${(gainedMs / 3_600_000).toFixed(2)}h`);

    // A running-mode pause with a past expiration IS expired — that loss is the punishment.
    const runner = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000034", name: "Runner" });
    await repo.vips.upsert({ serverId, playerId: runner.platformId, playerName: "Runner", comment: null, expiration: new Date(Date.now() - 1000).toISOString(), createdByUserId: null, createdByName: "owner" });
    await repo.vips.setPause(serverId, runner.platformId, { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "tk", by: "owner", mode: "running" });
    assert.ok((await repo.vips.expired(new Date().toISOString())).some((v) => v.playerId === runner.platformId), "running-mode pause still expires");
  });
});

test("VIP pause can target one server; without a serverId it pauses every grant", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const other = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "t2", host: "127.0.0.1", port: 2, password: "x" }) });
    const otherId = (other.body.server as { id: string }).id;
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000035", name: "Scoped" });
    for (const sid of [serverId, otherId])
      await repo.vips.upsert({ serverId: sid, playerId: player.platformId, playerName: "Scoped", comment: null, expiration: null, createdByUserId: null, createdByName: "owner" });

    // Scoped pause: only the named server's grant is touched.
    const one = await jsonFetch(`${base}/api/players/${player.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 24, reason: "scoped", serverId }) });
    assert.equal(one.status, 200);
    assert.ok((await repo.vips.get(serverId, player.platformId))!.pausedUntil, "target server paused");
    assert.equal((await repo.vips.get(otherId, player.platformId))!.pausedUntil, null, "other server untouched");
    // A serverId where the player holds no grant is a clean 404, not an everything-pause.
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 24, reason: "x", serverId: "nope" }) })).status, 404);

    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip/resume`, { method: "POST", headers: auth })).status, 200);
    // Unscoped pause: every grant.
    assert.equal((await jsonFetch(`${base}/api/players/${player.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 24, reason: "all" }) })).status, 200);
    assert.ok((await repo.vips.get(serverId, player.platformId))!.pausedUntil);
    assert.ok((await repo.vips.get(otherId, player.platformId))!.pausedUntil);
  });
});

// The refund case: "they charged back the donation, take the month back." Before this route,
// that meant staff reading the expiry and re-granting with hand-computed dates — the exact math
// the Add presets exist to avoid. Reduce takes the same days/hours and moves the expiry DOWN.
test("VIP time removal: the Add calculator in reverse — subtract, use up, and honest refusals", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const reduce = (body: Record<string, unknown>) =>
      jsonFetch(`${base}/api/servers/${serverId}/vips/reduce`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    const errMsg = (r: { body: Record<string, any> }) => String((r.body as { error?: { message?: string } }).error?.message ?? "");

    // Taking time away is the revoke power in smaller units — it gates on vip.revoke, so a
    // partial removal is never a way around lacking the removal permission.
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plainr", password: "pw" }) });
    const plain = await login(base, "plainr", "pw");
    const asked = await jsonFetch(`${base}/api/servers/${serverId}/vips/reduce`, { method: "POST", headers: plain, body: JSON.stringify({ playerId: "x", days: 1 }) });
    assert.deepEqual(await askedFor(base, auth, asked), { capability: "vip.revoke", serverId });
    assert.deepEqual(await repo.audit.list({ actions: ["vip.reduce"] }), [], "no time removed on the asking");

    assert.equal((await reduce({ days: 1 })).status, 400, "playerId is required");
    assert.equal((await reduce({ playerId: "x", days: 0, hours: 0 })).status, 400, "zero time to remove is refused");

    // Every refusal names the fact about the grant that stopped it.
    const none = await reduce({ playerId: "ghost", days: 1 });
    assert.equal(none.status, 409);
    assert.match(errMsg(none), /no VIP grant/);

    await repo.vips.upsert({ serverId, playerId: "perm", expiration: null, createdByName: "owner" });
    const perm = await reduce({ playerId: "perm", days: 1 });
    assert.equal(perm.status, 409);
    assert.match(errMsg(perm), /permanent/);
    assert.ok(await repo.vips.get(serverId, "perm"), "the permanent grant is untouched");

    // 10 days minus 3 days leaves 7 — a pure ledger move (the game only knows permanent VIP, so
    // while time remains nothing is sent to it), and the original creator survives.
    const tenDaysOut = Date.now() + 10 * 86_400_000;
    await repo.vips.upsert({ serverId, playerId: "timed", playerName: "Timed", expiration: new Date(tenDaysOut).toISOString(), createdByName: "someone-else" });
    const cut = await reduce({ playerId: "timed", days: 3 });
    assert.equal(cut.status, 200);
    assert.equal((cut.body.applied as any[]).length, 1);
    assert.equal((cut.body.applied as any[])[0].removed, false);
    const row = (await repo.vips.get(serverId, "timed"))!;
    const drift = Math.abs(Date.parse(row.expiration!) - (tenDaysOut - 3 * 86_400_000));
    assert.ok(drift < 5000, `7 days remain (off by ${drift}ms)`);
    assert.equal(row.createdByName, "someone-else", "a reduction is not a re-grant — the creator stands");
    assert.equal(row.playerName, "Timed", "the stored name survives too");
    assert.ok(((await jsonFetch(`${base}/api/audit`, { headers: auth })).body.entries as any[])
      .some((e) => e.action === "vip.reduce" && String(e.summary).includes("3d")), "audited with the amount removed");

    // Taking back more than remains ends the VIP now — row deleted, not parked at a past date
    // for the sweep to trip over. The grant is PAUSED first so the game half is legitimately
    // skipped (a paused VIP is already off the game; the test server address is unreachable).
    await repo.vips.setPause(serverId, "timed", { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "t", by: "owner" });
    const gone = await reduce({ playerId: "timed", days: 30 });
    assert.equal(gone.status, 200);
    assert.equal((gone.body.applied as any[])[0].removed, true);
    assert.ok(!(await repo.vips.get(serverId, "timed")), "the used-up grant is removed outright");

    // A grant that already lapsed has nothing left to take.
    await repo.vips.upsert({ serverId, playerId: "past", expiration: new Date(Date.now() - 1000).toISOString(), createdByName: "owner" });
    const past = await reduce({ playerId: "past", hours: 1 });
    assert.equal(past.status, 409);
    assert.match(errMsg(past), /already expired/);

    // …but the SAME past date under a banked pause is a frozen meter, not a lapsed grant — the
    // expiry sweep skips frozen rows and so does this refusal. The reduction moves the stored
    // date and the row survives for resume to settle; deleting it would eat the banked time.
    await repo.vips.upsert({ serverId, playerId: "banked", expiration: new Date(Date.now() - 1000).toISOString(), createdByName: "owner" });
    await repo.vips.setPause(serverId, "banked", { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "b", by: "owner", mode: "banked" });
    const frozen = await reduce({ playerId: "banked", hours: 2 });
    assert.equal(frozen.status, 200);
    assert.equal((frozen.body.applied as any[])[0].removed, false, "a frozen grant is reduced, never deleted");
    assert.ok(await repo.vips.get(serverId, "banked"), "the frozen row survives with the reduced date");
  });
});

test("VIP time removal never ends a grant made permanent while the game was being told", async () => {
  // Taking back more than remains removes the grant: the game first, then the row. A purchase
  // landing in between made it permanent, which has no time to subtract — and the unconditional
  // delete then ended it anyway.
  const { fakeGameServer } = await import("./fake-hll-server.ts");
  await withServer(async (base, repo) => {
    const { auth } = await owner(base);
    const s = await fakeGameServer(base, auth.authorization!.slice("Bearer ".length), "live");
    try {
      const pid = "76561198000000036";
      await repo.vips.upsert({ serverId: s.serverId, playerId: pid, playerName: "Refund", expiration: new Date(Date.now() + 2 * 86_400_000).toISOString(), createdByName: "owner" });
      s.fake.vips.set(pid, { playerId: pid, comment: "Refund" });
      s.fake.onCommand = async (name) => {
        if (name === "RemoveVip") await repo.vips.upsert({ serverId: s.serverId, playerId: pid, playerName: "Refund", expiration: null, replacePermanent: true, createdByName: "shop" } as any);
      };
      const r = await jsonFetch(`${base}/api/servers/${s.serverId}/vips/reduce`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: pid, days: 30 }) });
      s.fake.onCommand = null;
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(String((r.body as { error?: { message?: string } }).error?.message ?? ""), /changed while this ran/);
      assert.equal((await repo.vips.get(s.serverId, pid))?.expiration, null, "the permanent grant stands");
      assert.ok(s.fake.vips.has(pid), "and the game got back the entry just removed");
    } finally { s.fake.close(); }
  });
});

test("VIP presets: seeded defaults, calculator building blocks, own edit permission", async () => {
  await withServer(async (base, repo) => {
    const { auth } = await owner(base);
    // The starter set mirrors the popup defaults: add = Help skip queue / 1 day / 1 week / 1 month.
    const seeded = await jsonFetch(`${base}/api/vip-presets`, { headers: auth });
    assert.equal(seeded.status, 200);
    const adds = (seeded.body.presets as any[]).filter((p) => p.kind === "add");
    const pauses = (seeded.body.presets as any[]).filter((p) => p.kind === "pause");
    assert.deepEqual(adds.map((p) => p.label), ["Help skip queue", "1 day", "1 week", "1 month"]);
    assert.deepEqual(pauses.map((p) => p.label), ["1 day", "1 week", "1 month"]);

    // Reading needs a VIP capability; editing needs vip.presets specifically.
    await jsonFetch(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username: "plainp", password: "pw" }) });
    const plain = await login(base, "plainp", "pw");
    assert.equal((await jsonFetch(`${base}/api/vip-presets`, { headers: plain })).status, 403);
    const asked = await jsonFetch(`${base}/api/vip-presets`, { method: "POST", headers: plain, body: JSON.stringify({ kind: "add", label: "x", hours: 1 }) });
    assert.deepEqual(await askedFor(base, auth, asked), { capability: "vip.presets", serverId: null });
    assert.ok(!(await repo.vipPresets.list()).some((p) => p.label === "x"), "no preset saved on the asking");

    // A preset is a duration, so zero time is refused — as is an unknown tab.
    assert.equal((await jsonFetch(`${base}/api/vip-presets`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "add", label: "nothing" }) })).status, 400);
    assert.equal((await jsonFetch(`${base}/api/vip-presets`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "weird", label: "x", hours: 1 }) })).status, 400);

    const created = await jsonFetch(`${base}/api/vip-presets`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "pause", label: "2 hours", hours: 2 }) });
    assert.equal(created.status, 201);
    const id = (created.body.preset as { id: string }).id;
    const patched = await jsonFetch(`${base}/api/vip-presets/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ label: "3 hours", hours: 3 }) });
    assert.equal(patched.status, 200);
    assert.equal((patched.body.preset as any).hours, 3);
    // Editing down to zero time is refused too — the check sees the merged row, not just the patch.
    assert.equal((await jsonFetch(`${base}/api/vip-presets/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ hours: 0 }) })).status, 400);
    assert.equal((await jsonFetch(`${base}/api/vip-presets/${id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await jsonFetch(`${base}/api/vip-presets/${id}`, { method: "DELETE", headers: auth })).status, 404);
  });
});

// The import writes through importOne, never upsert, and that difference is the whole guard: a
// backup is a photograph of VIP state on the day it was taken, while the panel has kept granting
// and expiring VIPs ever since. Every case below is one way `upsert` would have corrupted a live
// grant — extending one that should lapse, cutting one staff had extended, and turning a timed
// grant permanent wherever CRCON happened to hold no expiry.
test("importOne keeps the live grant; upsert lets the archive win (the two VIP policies)", async () => {
  await withServer(async (_base, repo) => {
    const s = await repo.servers.create({ name: "s", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "active" } as any);
    const live = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const archiveLater = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const archiveEarlier = new Date(Date.now() + 86_400_000).toISOString();

    for (const [playerId, archive] of [["extends", archiveLater], ["shortens", archiveEarlier], ["permanent", null]] as const) {
      await repo.vips.upsert({ serverId: s.id, playerId, expiration: live, comment: "granted in the panel", createdByName: "owner" });
      const { row, inserted } = await repo.vips.importOne({ serverId: s.id, playerId, expiration: archive, comment: "Imported from CRCON", createdByName: "importer" });
      assert.equal(inserted, false, `${playerId}: an existing grant is never re-inserted`);
      assert.equal(row.expiration, live, `${playerId}: the live expiry stands`);
      assert.equal(row.comment, "granted in the panel", `${playerId}: the live row is returned untouched`);
      assert.equal((await repo.vips.get(s.id, playerId))!.expiration, live, `${playerId}: and nothing was written`);
    }

    // A VIP the panel has never heard of IS the import's to create — that is the historical data
    // the import exists to bring across.
    const fresh = await repo.vips.importOne({ serverId: s.id, playerId: "onlyInCrcon", expiration: archiveLater, comment: "Imported from CRCON", createdByName: "importer" });
    assert.equal(fresh.inserted, true);
    assert.equal(fresh.row.expiration, archiveLater);

    // Idempotent: the second apply of the same archive inserts nothing and moves nothing.
    const again = await repo.vips.importOne({ serverId: s.id, playerId: "onlyInCrcon", expiration: archiveEarlier, comment: "Imported from CRCON", createdByName: "importer" });
    assert.equal(again.inserted, false);
    assert.equal((await repo.vips.get(s.id, "onlyInCrcon"))!.expiration, archiveLater);

    // The pause is live state too, and an import must not disturb it.
    await repo.vips.setPause(s.id, "extends", { pausedUntil: new Date(Date.now() + 86_400_000).toISOString(), reason: "timeout", by: "owner", mode: "banked" } as any);
    await repo.vips.importOne({ serverId: s.id, playerId: "extends", expiration: archiveLater, createdByName: "importer" });
    const paused = (await repo.vips.get(s.id, "extends"))!;
    assert.equal(paused.pauseReason, "timeout", "the pause survives an import");
    assert.equal(paused.expiration, live);
  });
});

// The forensic half: the fix above stops NEW damage, but an apply already ran with the old
// unconditional upsert. This reproduces exactly what that did to a live grant and proves the
// drift report finds it — using nothing but the audit trail, the only surviving record of what
// was set — and that the restore gives back time it CUT, and never takes any away: VIP is paid
// for, and a longer row is not something a bulk restore may shorten.
test("VIP drift: what an old-style import moved is found, and only time it cut is given back", async () => {
  await withServer(async (_base, repo) => {
    const s = await repo.servers.create({ name: "s", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "active" } as any);
    const granted = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const later = new Date(Date.now() + 400 * 86_400_000).toISOString();
    const sooner = new Date(Date.now() + 86_400_000).toISOString();
    const grant = async (playerId: string, expiration: string | null) => {
      await repo.vips.upsert({ serverId: s.id, playerId, expiration, comment: "panel grant", createdByName: "owner" });
      await repo.audit.create({
        actorUserId: null, actorName: "owner", action: "vip.grant", targetType: "player", targetId: playerId,
        serverId: s.id, summary: `granted VIP until ${expiration ?? "forever"}`, data: { playerId, expiration },
      });
    };
    for (const playerId of ["extended", "shortened", "madePermanent", "untouched"]) await grant(playerId, granted);
    await grant("givenExpiry", null); // a paid permanent grant
    await new Promise((r) => setTimeout(r, 5)); // the import happens after the grants

    // The old behaviour, verbatim: upsert with the archive's expiration, no audit row written.
    await repo.vips.upsert({ serverId: s.id, playerId: "extended", expiration: later, createdByName: "importer" });
    await repo.vips.upsert({ serverId: s.id, playerId: "shortened", expiration: sooner, createdByName: "importer", mayShorten: true }); // the old cut — refused today unless asked for
    await repo.vips.upsert({ serverId: s.id, playerId: "madePermanent", expiration: null, createdByName: "importer" });
    await repo.vips.upsert({ serverId: s.id, playerId: "givenExpiry", expiration: sooner, createdByName: "importer", replacePermanent: true } as any);

    const moved = await repo.crconSnapshot.vipsMovedByImport(s.id);
    assert.deepEqual(
      new Map(moved.map((m) => [m.playerId, m.direction])),
      new Map([["extended", "extended"], ["shortened", "shortened"], ["madePermanent", "made-permanent"], ["givenExpiry", "given-an-expiry"]]),
      "every way it moves is found, and the untouched grant is not reported",
    );

    // A VIP with no grant on record is unjudgeable and must stay out of the report entirely —
    // that is a pure import creation, which is legitimate history, not damage.
    await repo.vips.upsert({ serverId: s.id, playerId: "onlyFromCrcon", expiration: granted, comment: "Imported from CRCON", createdByName: "importer" });
    assert.equal((await repo.crconSnapshot.vipsMovedByImport(s.id)).some((m) => m.playerId === "onlyFromCrcon"), false);

    // Asked to restore all four, it gives back only what was CUT.
    const restored = await repo.crconSnapshot.restoreVipExpirations(s.id, ["extended", "shortened", "madePermanent", "givenExpiry"]);
    assert.deepEqual(restored.map((r) => r.playerId).sort(), ["givenExpiry", "shortened"]);
    assert.equal((await repo.vips.get(s.id, "shortened"))!.expiration, granted, "time cut short is given back");
    assert.equal((await repo.vips.get(s.id, "givenExpiry"))!.expiration, null, "a paid permanent is permanent again");
    assert.equal((await repo.vips.get(s.id, "extended"))!.expiration, later, "a longer expiry is never cut in bulk");
    assert.equal((await repo.vips.get(s.id, "madePermanent"))!.expiration, null, "and permanent VIP is never made dated");

    // What was given back drops out of the report; the longer ones stay in it for staff to judge.
    assert.deepEqual((await repo.crconSnapshot.vipsMovedByImport(s.id)).map((m) => m.playerId).sort(), ["extended", "madePermanent"]);
  });
});

// The report's reference is the newest DELIBERATE setting of an expiry, not only a staff grant.
// Counting grants alone listed every seeder rewarded since their last grant as "moved by an
// import" — and the restore that used to follow it cut the reward away — and read a cut staff made
// as one to undo.
test("VIP drift: a seed or game reward, or a staff cut, is a setting — never import damage", async () => {
  await withServer(async (_base, repo) => {
    const s = await repo.servers.create({ name: "s", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "active" } as any);
    const day = 86_400_000;
    // Each date computed ONCE: a row and the record of setting it must agree to the millisecond.
    const base = Date.now();
    const at = (days: number) => new Date(base + days * day).toISOString();
    const [bought, seeded, rewarded, cutTo, dry, reWritten, importCut] = [at(30), at(33), at(31), at(10), at(90), at(60), at(2)];
    const pause = () => new Promise((r) => setTimeout(r, 5));
    const audit = (action: string, playerId: string, data: Record<string, unknown>) => repo.audit.create({
      actorUserId: null, actorName: "x", action, targetType: "player", targetId: playerId, serverId: s.id, summary: action, data,
    });
    for (const id of ["seeded", "rewarded", "cut", "removed", "dryRun"]) {
      await repo.vips.upsert({ serverId: s.id, playerId: id, expiration: bought, comment: "bought", createdByName: "shop" });
      await audit("vip.grant", id, { playerId: id, expiration: bought });
    }
    await pause();

    // Earned on top of the grant: a seed reward and a game reward, each recording what it set.
    await repo.vips.upsert({ serverId: s.id, playerId: "seeded", expiration: seeded, createdByName: "seeding" });
    await audit("seed.reward", "seeded", { hours: 72, expiration: seeded });
    await repo.vips.upsert({ serverId: s.id, playerId: "rewarded", expiration: rewarded, createdByName: "game rewards" });
    await audit("game.reward", "rewarded", { vipGiven: 24, expiration: rewarded });
    // A staff cut, recording what it left.
    await repo.vips.upsert({ serverId: s.id, playerId: "cut", expiration: cutTo, createdByName: "owner", mayShorten: true }); // a person removing time
    await audit("vip.reduce", "cut", { before: bought, after: cutTo, removed: false });
    // A cut that removed the VIP; something unrecorded writes a row again afterwards.
    await audit("vip.reduce", "removed", { before: bought, after: null, removed: true });
    // A dry-run reward set nothing.
    await audit("seed.reward", "dryRun", { dryRun: true, expiration: dry });
    await pause();
    await repo.vips.upsert({ serverId: s.id, playerId: "removed", expiration: reWritten, createdByName: "importer", mayShorten: true });

    const moved = await repo.crconSnapshot.vipsMovedByImport(s.id);
    assert.deepEqual(moved.map((m) => m.playerId), [], `nothing here is an import's damage: ${JSON.stringify(moved)}`);
    assert.deepEqual(await repo.crconSnapshot.restoreVipExpirations(s.id, ["seeded", "rewarded", "cut", "removed", "dryRun"]), []);
    assert.equal(Date.parse((await repo.vips.get(s.id, "seeded"))!.expiration!), Date.parse(seeded), "the seed reward stands");
    assert.equal(Date.parse((await repo.vips.get(s.id, "rewarded"))!.expiration!), Date.parse(rewarded), "so does the game reward");
    assert.equal(Date.parse((await repo.vips.get(s.id, "cut"))!.expiration!), Date.parse(cutTo), "and the staff cut");

    // A dry run is no reference: an import that cuts the grant is still measured against the grant.
    await pause();
    await repo.vips.upsert({ serverId: s.id, playerId: "dryRun", expiration: importCut, createdByName: "importer", mayShorten: true });
    const cutByImport = await repo.crconSnapshot.vipsMovedByImport(s.id);
    assert.deepEqual(cutByImport.map((m) => [m.playerId, m.direction]), [["dryRun", "shortened"]]);
    await repo.crconSnapshot.restoreVipExpirations(s.id, ["dryRun"]);
    assert.equal(Date.parse((await repo.vips.get(s.id, "dryRun"))!.expiration!), Date.parse(bought), "given back to the grant, not the dry run's 90 days");
  });
});

// The VIP reconciler, armed, puts a VIP back on a game that lost them and records it as a grant —
// with the row's CURRENT expiry, because copying the row to the game is all it does. Counted as a
// setting, that echo made an import's cut the value staff "set": the wiped-list incident and an
// old import together, and the cut vanished from the repair report as soon as the game was fixed.
test("VIP drift: the reconciler copying a grant back to the game is not a setting", async () => {
  await withServer(async (_base, repo) => {
    const s = await repo.servers.create({ name: "s", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "active" } as any);
    const base = Date.now();
    const at = (days: number) => new Date(base + days * 86_400_000).toISOString();
    const [bought, importCut] = [at(30), at(2)];
    const pause = () => new Promise((r) => setTimeout(r, 5));
    await repo.vips.upsert({ serverId: s.id, playerId: "wiped", expiration: bought, comment: "bought", createdByName: "shop" });
    await repo.audit.create({ actorUserId: null, actorName: "shop", action: "vip.grant", targetType: "player", targetId: "wiped", serverId: s.id, summary: "bought", data: { playerId: "wiped", expiration: bought } });
    await pause();
    // An old-style import cuts the row, recording nothing.
    await repo.vips.upsert({ serverId: s.id, playerId: "wiped", expiration: importCut, createdByName: "importer", mayShorten: true });
    await pause();
    // The game loses its VIP list; the reconciler restores the entry — exactly what it audits.
    await repo.audit.create({
      actorUserId: null, actorName: "vip-sync", action: "vip.grant", targetType: "player", targetId: "wiped", serverId: s.id,
      summary: "restored the VIP grant for wiped on s — the game was not listing it",
      data: { playerId: "wiped", expiration: importCut, reconcile: true },
    });

    const moved = await repo.crconSnapshot.vipsMovedByImport(s.id);
    assert.deepEqual(moved.map((m) => [m.playerId, m.direction]), [["wiped", "shortened"]], "the cut is still found");
    assert.equal(Date.parse(moved[0]!.grantedExpiration!), Date.parse(bought), "measured against what was bought, not the reconciler's copy");
    await repo.crconSnapshot.restoreVipExpirations(s.id, ["wiped"]);
    assert.equal(Date.parse((await repo.vips.get(s.id, "wiped"))!.expiration!), Date.parse(bought), "and the bought time is given back");
  });
});

// The policy that decides which side owns an expiry, exercised through the REAL transform entry
// point rather than the repo, because the default is the thing that matters: an import is a
// MIGRATION off CRCON, so CRCON's expirations are the newer ones and must land. Getting this
// backwards silently freezes a whole community's VIP list at whatever the panel happened to hold.
test("the archive's VIP expirations win by default, and the top-up policy is opt-in", async () => {
  const { transformCrconArchive } = await import("../dist/crcon-transform.js");
  const { crconBackupFile } = await import("@app/shared");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  for (const [policy, expected] of [[undefined, "archive"], ["archive", "archive"], ["live", "live"]] as const) {
    await withServer(async (_base, repo) => {
      const srv = await repo.servers.create({ name: "s", game: "hll", protocol: "binary-v2", host: "h", port: 1, password: "x", engagementMode: "active" } as any);
      const panelExpiry = new Date(Date.UTC(2026, 0, 1)).toISOString();
      const crconExpiry = new Date(Date.UTC(2027, 0, 1)).toISOString();
      const pid = "76561198000009001";
      await repo.vips.upsert({ serverId: srv.id, playerId: pid, expiration: panelExpiry, comment: "panel", createdByName: "owner" });

      const file = crconBackupFile(srv.id);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ dataType: "vip", key: pid, raw: { player_id: pid, name: "Vip", expiration: crconExpiry } }) + "\n");

      const summary = await transformCrconArchive(repo, srv, { userId: null, name: "importer" }, undefined, policy ? { vipPolicy: policy } : undefined);
      const got = (await repo.vips.get(srv.id, pid))!;
      if (expected === "archive") {
        assert.equal(Date.parse(got.expiration!), Date.parse(crconExpiry), `policy=${policy ?? "(default)"}: CRCON's expiry lands`);
        assert.equal(summary.vips, 1);
        assert.equal(summary.vipsKept, 0);
      } else {
        assert.equal(Date.parse(got.expiration!), Date.parse(panelExpiry), "policy=live: the panel's expiry stands");
        assert.equal(summary.vips, 0);
        assert.equal(summary.vipsKept, 1);
      }
      // Neither policy disturbs a VIP timeout — that is panel-only state CRCON cannot express.
      assert.equal(got.pausedUntil, null);
    });
  }
});

test("profile: VIP on a retired server is not shown, the grant is kept, and it comes back with the server", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "old", host: "127.0.0.1", port: 1, password: "x" }) });
    const oldId = (created.body.server as { id: string }).id;
    const grant = async (sid: string, platformId: string) => {
      const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId, name: platformId });
      await repo.vips.upsert({ serverId: sid, playerId: platformId, playerName: platformId, comment: null, expiration: null, createdByUserId: null, createdByName: "owner" });
      return player;
    };
    const both = await grant(serverId, "76561198000000041");
    await grant(oldId, both.platformId);
    const onlyOld = await grant(oldId, "76561198000000042");
    const shown = async (id: string) => ((await jsonFetch(`${base}/api/players/${id}`, { headers: auth })).body.vipStatus as { serverId: string }[]).map((v) => v.serverId).sort();
    assert.deepEqual(await shown(both.id), [serverId, oldId].sort());

    assert.equal((await jsonFetch(`${base}/api/servers/${oldId}/retire`, { method: "POST", headers: auth })).status, 200);
    assert.deepEqual(await shown(both.id), [serverId], "the retired server's VIP is not shown");
    assert.deepEqual(await shown(onlyOld.id), [], "and a player whose only VIP was there shows none (the profile's VIP star reads this list)");
    assert.ok(await repo.vips.get(oldId, both.platformId), "the grant itself is kept");
    assert.ok(await repo.vips.get(oldId, onlyOld.platformId));

    assert.equal((await jsonFetch(`${base}/api/servers/${oldId}/unretire`, { method: "POST", headers: auth })).status, 200);
    assert.deepEqual(await shown(both.id), [serverId, oldId].sort(), "back with the server");
    assert.deepEqual(await shown(onlyOld.id), [oldId]);
  });
});

test("profile: console admin on a retired server is not shown either; the grant is kept and comes back with the server", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const created = await jsonFetch(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "old", host: "127.0.0.1", port: 1, password: "x" }) });
    const oldId = (created.body.server as { id: string }).id;
    const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000043", name: "Cam" });
    for (const sid of [serverId, oldId]) await repo.consoleAdmins.upsert({ serverId: sid, playerId: player.platformId, adminGroup: "spectator", createdByName: "owner" });
    const shown = async () => ((await jsonFetch(`${base}/api/players/${player.id}`, { headers: auth })).body.consoleAdminStatus as { serverId: string }[]).map((a) => a.serverId).sort();
    assert.deepEqual(await shown(), [serverId, oldId].sort());

    assert.equal((await jsonFetch(`${base}/api/servers/${oldId}/retire`, { method: "POST", headers: auth })).status, 200);
    assert.deepEqual(await shown(), [serverId], "the retired server's console admin is not shown");
    assert.ok(await repo.consoleAdmins.get(oldId, player.platformId), "the grant itself is kept");

    assert.equal((await jsonFetch(`${base}/api/servers/${oldId}/unretire`, { method: "POST", headers: auth })).status, 200);
    assert.deepEqual(await shown(), [serverId, oldId].sort(), "back with the server");
  });
});

test("profile: pausing and resuming VIP leaves a retired server's grant, and its game, alone", async () => {
  await withServer(async (base, repo) => {
    const { auth, serverId } = await owner(base);
    const { fake, serverId: oldId } = await fakeGameServer(base, String(auth.authorization).replace(/^Bearer /, ""), "old");
    try {
      const upsertGrant = (sid: string, platformId: string) =>
        repo.vips.upsert({ serverId: sid, playerId: platformId, playerName: platformId, comment: null, expiration: null, createdByUserId: null, createdByName: "owner" });
      const both = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000051", name: "Both" });
      await upsertGrant(serverId, both.platformId);
      await upsertGrant(oldId, both.platformId);
      // A pause already standing on the old server when it was retired: it runs out once the server is back.
      const earlier = { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "earlier", by: "owner", mode: "running" as const, at: new Date().toISOString() };
      await repo.vips.setPause(oldId, both.platformId, earlier);
      const onlyOld = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000052", name: "OnlyOld" });
      await upsertGrant(oldId, onlyOld.platformId);
      assert.equal((await jsonFetch(`${base}/api/servers/${oldId}/retire`, { method: "POST", headers: auth })).status, 200);
      fake.received.length = 0;

      const paused = await jsonFetch(`${base}/api/players/${both.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 2, reason: "toxic in chat" }) });
      assert.equal(paused.status, 200, JSON.stringify(paused.body));
      assert.deepEqual(paused.body.applied, ["t"], "only the live server's grant is paused");
      assert.equal((await repo.vips.get(serverId, both.platformId))!.pauseReason, "toxic in chat");
      assert.equal((await repo.vips.get(oldId, both.platformId))!.pauseReason, "earlier", "the retired server's grant is left as it was");
      assert.equal((await jsonFetch(`${base}/api/players/${onlyOld.id}/vip/pause`, { method: "POST", headers: auth, body: JSON.stringify({ hours: 2, reason: "x" }) })).status, 404,
        "a player whose only VIP is on a retired server has none to pause, as the profile shows");

      const resumed = await jsonFetch(`${base}/api/players/${both.id}/vip/resume`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      assert.deepEqual(resumed.body.applied, ["t"]);
      assert.equal((await repo.vips.get(serverId, both.platformId))!.pausedUntil, null);
      assert.equal((await repo.vips.get(oldId, both.platformId))!.pauseReason, "earlier", "its pause stands until the server is back");
      assert.deepEqual(fake.received, [], "nothing was sent to the retired server's game");
    } finally { fake.close(); }
  });
});
