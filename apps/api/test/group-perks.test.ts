import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeHllServer } from "./fake-hll-server.ts";
import { withServer, jf, askedFor } from "./harness.ts";
import { auditVipIntegrity, type VipAuditEvent } from "../dist/vip-integrity.js";

/**
 * Group VIP perks, the API's half: a perk takes the VIP keys it exercises (groups promise to add
 * convenience, never power), switching one off or deleting its group asks about the severance out
 * loud, and every VIP surface treats a grant the perk holds as the permanent VIP it is — time
 * granted to a held player banks for when they leave, and nobody takes it away but the group.
 */
const DAY = 86_400_000;

async function owner(base: string) {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}
async function staff(base: string, auth: Record<string, string>, username: string, grants: unknown[]) {
  const u = await jf(`${base}/api/users`, { method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }) });
  await jf(`${base}/api/users/${u.body.user.id as string}/grants`, { method: "PUT", headers: auth, body: JSON.stringify({ grants }) });
  const l = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${l.body.token as string}` };
}

test("a VIP perk takes the keys it uses — to set up, to add or remove members, to switch off, to delete its group", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const srv = (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: "WW2 #1", host: "127.0.0.1", port: 1, password: "x" }) })).body.server as { id: string; game: string };
    const gid = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "WW2 CVC" }) })).body.group.id as string;
    const perk = { game: srv.game, scope: { mode: "all" }, severanceMinutes: 2 * 1440 };
    // Saved as it was sent, with the rewards switch on — a body that does not mention it is a page from before it.
    const saved = { ...perk, bankRewards: true };

    const groupsOnly = await staff(base, auth, "groupsonly", [
      { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
      { capability: "player.groups", level: "write", scopeType: "global", scopeId: null },
    ]);
    const vipStaff = await staff(base, auth, "vipstaff", [
      { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
      { capability: "player.groups", level: "write", scopeType: "global", scopeId: null },
      { capability: "vip.grant", level: "write", scopeType: "server", scopeId: srv.id },
      { capability: "vip.revoke", level: "write", scopeType: "server", scopeId: srv.id },
    ]);

    // Validation first.
    const put = (h: Record<string, string>, body: unknown) => jf(`${base}/api/player-groups/${gid}/perk`, { method: "PUT", headers: h, body: JSON.stringify(body) });
    assert.equal((await put(auth, { ...perk, game: "chess" })).status, 400);
    assert.equal((await put(auth, { ...perk, scope: { mode: "servers", serverIds: [] } })).status, 400);
    assert.equal((await put(auth, { ...perk, severanceMinutes: 400 * 1440 })).status, 400);
    assert.equal((await put(auth, { ...perk, scope: { mode: "servers", serverIds: ["nope"] } })).status, 400, "covers no server");

    // Groups access alone cannot point a perk at anyone — it asks someone holding the VIP keys on
    // its servers; those keys can.
    const denied = await put(groupsOnly, perk);
    assert.deepEqual(await askedFor(base, auth, denied), { capability: "vip.grant", serverId: srv.id });
    assert.equal((await repo.playerGroups.get(gid))!.vipPerk, null, "no perk until it is signed");
    const set = await put(vipStaff, perk);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.group.vipPerk, saved);

    // On a perk group, membership is a VIP grant: adding needs vip.grant, removing vip.revoke.
    const add = (h: Record<string, string>) => jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: h, body: JSON.stringify({ playerId: "76561198000000001", playerName: "Ana" }) });
    const listed = async () => (await repo.playerGroups.members(gid)).map((m) => m.playerId);
    assert.deepEqual(await askedFor(base, auth, await add(groupsOnly)), { capability: "vip.grant", serverId: srv.id });
    assert.deepEqual(await listed(), [], "not added on the asking");
    assert.equal((await add(vipStaff)).status, 201);
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/player-groups/${gid}/members/76561198000000001`, { method: "DELETE", headers: groupsOnly })), { capability: "vip.revoke", serverId: srv.id });
    assert.deepEqual(await listed(), ["76561198000000001"], "not removed on the asking");
    assert.equal((await jf(`${base}/api/player-groups/${gid}/members/76561198000000001`, { method: "DELETE", headers: vipStaff })).status, 200);
    await add(vipStaff);

    // The group page reports who the perk holds.
    await repo.vips.startGroupHold({ serverId: srv.id, playerId: "76561198000000001", playerName: "Ana", groups: [{ id: gid, name: "WW2 CVC", severanceMinutes: 2880 }], createdByName: "group perks" });
    const detail = await jf(`${base}/api/player-groups/${gid}`, { headers: auth });
    assert.equal(detail.body.perkStatus.heldPlayers, 1);
    assert.equal((await jf(`${base}/api/player-groups/${gid}`, { headers: vipStaff })).body.perkStatus.held.length, 1);
    // Whose VIP stands where is VIP data: groups access alone sees the perk, not who it holds.
    const blind = await jf(`${base}/api/player-groups/${gid}`, { headers: groupsOnly });
    assert.equal(blind.status, 200);
    assert.deepEqual(blind.body.group.vipPerk, saved, "the perk itself is the group's");
    assert.equal(blind.body.perkStatus.heldPlayers, 0);
    assert.deepEqual(blind.body.perkStatus.held, []);

    // Switching off asks about the severance every time, and needs the revoke key.
    assert.equal((await jf(`${base}/api/player-groups/${gid}/perk`, { method: "DELETE", headers: vipStaff })).status, 400);
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/player-groups/${gid}/perk?severance=0`, { method: "DELETE", headers: groupsOnly })), { capability: "vip.revoke", serverId: srv.id });
    assert.deepEqual((await repo.playerGroups.get(gid))!.vipPerk, saved, "still on until it is signed");
    const off = await jf(`${base}/api/player-groups/${gid}/perk?severance=0`, { method: "DELETE", headers: vipStaff });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.group.vipPerk, null);
    assert.equal((await repo.vips.get(srv.id, "76561198000000001"))!.groupHold!.groups[0]!.severanceMinutes, 0, "without severance: recorded for the release");

    // Deleting a perk group asks the same question.
    await put(vipStaff, perk);
    assert.equal((await jf(`${base}/api/player-groups/${gid}`, { method: "DELETE", headers: vipStaff })).status, 400);
    assert.deepEqual(await askedFor(base, auth, await jf(`${base}/api/player-groups/${gid}?severance=1`, { method: "DELETE", headers: groupsOnly })), { capability: "vip.revoke", serverId: srv.id });
    assert.ok(await repo.playerGroups.get(gid), "the group stands until it is signed");
    assert.equal((await jf(`${base}/api/player-groups/${gid}?severance=1`, { method: "DELETE", headers: vipStaff })).status, 200);
    const audits = await repo.audit.list({ actions: ["group.perk", "group.delete"] });
    assert.ok(audits.some((a) => /set up the VIP perk/.test(a.summary)));
    assert.ok(audits.some((a) => /plus 2 days severance/.test(a.summary)), "the delete says what leavers get");
  });
});

test("a held player: grants bank, revoke and reduce take only the VIP of their own beneath the hold, bulk group VIP skips it, permanent takes it over", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const srv = await repo.servers.create({ name: "WW2 live", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const ana = "76561198000000011";
      await repo.vips.upsert({ serverId: srv.id, playerId: ana, playerName: "Ana", expiration: new Date(Date.now() + 10 * DAY).toISOString(), createdByName: "staff" });
      await repo.vips.startGroupHold({ serverId: srv.id, playerId: ana, playerName: "Ana", groups: [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 0 }], createdByName: "group perks" });
      const banked = async () => (await repo.vips.get(srv.id, ana))!.groupHold!.bankedMs;
      const before = await banked();

      // Two days stacked: banked, still permanent, nothing new told to the game.
      const grant = (body: Record<string, unknown>) => jf(`${base}/api/servers/${srv.id}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: ana, playerName: "Ana", comment: "donor", ...body }) });
      const stacked = await grant({ mode: "duration", days: 2, cumulative: true });
      assert.equal(stacked.status, 200, JSON.stringify(stacked.body));
      assert.match(stacked.body.applied[0].note, /WW2 CVC.*get back on leaving/, "the receipt says where the time went");
      assert.ok(Math.abs(await banked() - (before + 2 * DAY)) < 5_000);
      assert.equal((await repo.vips.get(srv.id, ana))!.expiration, null);
      // A date tops the balance up to at least that far.
      await grant({ mode: "until", expiresAt: new Date(Date.now() + 30 * DAY).toISOString() });
      assert.ok(Math.abs(await banked() - 30 * DAY) < 60_000);

      // The profile names the group and the frozen time.
      await repo.players.upsert({ game: "hll", platform: "steam", platformId: ana, name: "Ana" });
      const prof = await jf(`${base}/api/players/${ana}`, { headers: auth });
      const status = (prof.body.vipStatus as { expiration: string | null; groupHold: { groups: string[]; bankedMs: number } | null }[])[0]!;
      assert.equal(status.expiration, null);
      assert.deepEqual(status.groupHold!.groups, ["WW2 CVC"]);
      assert.ok(Math.abs(status.groupHold!.bankedMs - 30 * DAY) < 60_000);

      // Removing time, or revoking, takes the VIP of their own frozen beneath the hold. The group's
      // permanent stands while they are listed, and the game hears nothing — it keeps them VIP.
      const sentBefore = fake!.received.length;
      const reduce = await jf(`${base}/api/servers/${srv.id}/vips/reduce`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: ana, days: 1 }) });
      assert.equal(reduce.status, 200, JSON.stringify(reduce.body));
      assert.ok(Math.abs(await banked() - 29 * DAY) < 60_000, "a day off the frozen time");
      assert.ok(Math.abs(reduce.body.applied[0].held.bankedMs - 29 * DAY) < 60_000, "the receipt says what is left");
      const revoke = await jf(`${base}/api/servers/${srv.id}/vips/${ana}`, { method: "DELETE", headers: auth });
      assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
      assert.ok(Math.abs(revoke.body.held[0].removedMs - 29 * DAY) < 60_000, "the rest of their own VIP");
      assert.match(revoke.body.held[0].heldBy, /WW2 CVC/);
      const after = (await repo.vips.get(srv.id, ana))!;
      assert.equal(after.expiration, null, "still permanent — the group's");
      assert.ok(after.groupHold, "still held");
      assert.equal(after.groupHold!.bankedMs, 0, "nothing of their own left to come back");
      assert.equal(fake!.received.length, sentBefore, "the game was told nothing");
      // Nothing of their own left beneath it: nothing more to take, and the refusal says how it ends.
      const again = await jf(`${base}/api/servers/${srv.id}/vips/${ana}`, { method: "DELETE", headers: auth });
      assert.equal(again.status, 409);
      assert.match(JSON.stringify(again.body), /no VIP of their own beneath it — remove them from the group to end it/);
      const reduceAgain = await jf(`${base}/api/servers/${srv.id}/vips/reduce`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: ana, days: 1 }) });
      assert.equal(reduceAgain.status, 409, JSON.stringify(reduceAgain.body));
      // Both recorded as written under the hold — the VIP-per-day history keeps counting them as VIP.
      const own = await repo.audit.list({ actions: ["vip.revoke", "vip.reduce"] });
      assert.equal(own.length, 2);
      assert.ok(own.every((a) => (a.data as { groupHeld?: boolean } | null)?.groupHeld === true), JSON.stringify(own.map((a) => a.data)));

      // A group-wide grant leaves held members alone.
      const gid = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Everyone" }) })).body.group.id as string;
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: ana, playerName: "Ana" }) });
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: "76561198000000012", playerName: "Bob" }) });
      const bulk = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vip", serverId: srv.id, mode: "duration", days: 3, comment: "event" }) });
      assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
      const r = (bulk.body.results as { applied: { playerId: string }[]; skipped: { playerId: string; reason: string }[] }[])[0]!;
      assert.deepEqual(r.applied.map((x) => x.playerId), ["76561198000000012"]);
      assert.match(r.skipped.find((x) => x.playerId === ana)!.reason, /left alone until they leave/);

      // Granting PERMANENT outright makes the grant the staff member's: the hold ends, permanent stays.
      const mine = await grant({ mode: "permanent" });
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      const row = (await repo.vips.get(srv.id, ana))!;
      assert.equal(row.expiration, null);
      assert.equal(row.groupHold, null);

      // The VIP history tells the story in words.
      const history = await jf(`${base}/api/players/${ana}/vip-history`, { headers: auth });
      assert.ok((history.body.history as { comment: string | null }[]).some((h) => /get back on leaving their group/.test(h.comment ?? "")));
      const ownRevoke = (history.body.history as { action: string; held?: boolean; comment: string | null }[]).find((h) => h.action === "revoked");
      assert.ok(ownRevoke?.held, "the revoke is marked as written under the hold");
      assert.match(ownRevoke!.comment ?? "", /their own VIP revoked .* the group's VIP stands/);
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("a perk's rewards switch: saved with the perk, kept by a page from before it, a yes or a no — and a person's grant still banks under it", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const srv = await repo.servers.create({ name: "WW2 live", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const gid = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Staff (rewards switch)" }) })).body.group.id as string;
      // Only this server: "every server" would reach other suites' servers in a shared database.
      const put = (body: Record<string, unknown>) => jf(`${base}/api/player-groups/${gid}/perk`, { method: "PUT", headers: auth, body: JSON.stringify({ game: "hll", scope: { mode: "servers", serverIds: [srv.id] }, severanceMinutes: 0, ...body }) });

      assert.equal((await put({ bankRewards: "no" })).status, 400, "a yes or a no");
      const off = await put({ bankRewards: false });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal(off.body.group.vipPerk.bankRewards, false);
      // A page from before the switch saves the perk without it: the switch stays where it was.
      const old = await put({ severanceMinutes: 60 });
      assert.equal(old.status, 200, JSON.stringify(old.body));
      assert.equal(old.body.group.vipPerk.bankRewards, false, "kept");
      assert.equal(old.body.group.vipPerk.severanceMinutes, 60);
      const summaries = (await repo.audit.list({ actions: ["group.perk"] })).map((a) => a.summary);
      assert.ok(summaries.some((s) => /rewards don't add to the frozen VIP/.test(s)), JSON.stringify(summaries));

      // A person's grant is not a reward: under a group that takes none, it still waits beneath the hold.
      const ana = "76561198000000021";
      await repo.vips.startGroupHold({ serverId: srv.id, playerId: ana, playerName: "Ana", groups: [{ id: gid, name: "Staff (rewards switch)", severanceMinutes: 60 }], createdByName: "group perks" });
      const grant = await jf(`${base}/api/servers/${srv.id}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: ana, playerName: "Ana", comment: "paid $10", mode: "duration", days: 2, cumulative: true }) });
      assert.equal(grant.status, 200, JSON.stringify(grant.body));
      assert.match(grant.body.applied[0].note, /get back on leaving/);
      assert.equal((await repo.vips.get(srv.id, ana))!.groupHold!.bankedMs, 2 * DAY);

      const on = await put({ bankRewards: true });
      assert.equal(on.body.group.vipPerk.bankRewards, true);
      assert.ok((await repo.audit.list({ actions: ["group.perk"] })).some((a) => /rewards add to the frozen VIP/.test(a.summary)));
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("the integrity scan: a group hold and its release are the perk working, and the released date is defended", () => {
  const ev = (ts: string, action: string, automated: boolean, data: Record<string, unknown> = {}): VipAuditEvent =>
    ({ ts, action, automated, actorName: automated ? "group perks" : "staff", serverId: "s1", targetId: "p1", data });
  const base = [
    ev("2026-01-01T00:00:00.000Z", "vip.grant", false, { expiration: "2026-03-01T00:00:00.000Z" }),
    ev("2026-01-10T00:00:00.000Z", "vip.group_hold", true, { bankedMs: 50 * DAY }),
    ev("2026-01-20T00:00:00.000Z", "vip.grant", true, { groupHeld: true, bankedMs: 60 * DAY }),
    ev("2026-02-01T00:00:00.000Z", "vip.group_release", true, { expiration: "2026-04-02T00:00:00.000Z", bankedMs: 60 * DAY }),
  ];
  // Held, then released to a date: no finding, though a "permanent" was ended by automation.
  assert.deepEqual(auditVipIntegrity(base, [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: "2026-04-02T00:00:00.000Z" }]), []);
  // While held the row is permanent: nothing to find either.
  assert.deepEqual(auditVipIntegrity(base.slice(0, 3), [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: null }]), []);
  // An automated write cutting the released date afterwards IS damage, measured from the release.
  const cut = [...base, ev("2026-02-05T00:00:00.000Z", "seed.reward", true, { expiration: "2026-03-02T00:00:00.000Z" })];
  const findings = auditVipIntegrity(cut, [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: "2026-03-02T00:00:00.000Z" }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.verdict, "shortened");
  assert.equal(findings[0]!.lostMs, 31 * DAY);
});

test("the integrity scan: damage found before a hold is still found after it — the hold settles nothing", () => {
  const ev = (ts: string, action: string, automated: boolean, data: Record<string, unknown> = {}): VipAuditEvent =>
    ({ ts, action, automated, actorName: automated ? "seeding" : "staff", serverId: "s1", targetId: "p1", data });
  // A permanent grant automation dated, then a group perk held it and let it go.
  const flattened = [
    ev("2026-01-01T00:00:00.000Z", "vip.grant", false, { expiration: null }),
    ev("2026-01-05T00:00:00.000Z", "seed.reward", true, { expiration: "2026-02-15T00:00:00.000Z" }),
    ev("2026-01-10T00:00:00.000Z", "vip.group_hold", true, { bankedMs: 36 * DAY }),
    ev("2026-02-01T00:00:00.000Z", "vip.group_release", true, { expiration: "2026-03-09T00:00:00.000Z", bankedMs: 36 * DAY }),
  ];
  // Held: the grant stands permanent, so nothing to report yet.
  assert.deepEqual(auditVipIntegrity(flattened.slice(0, 3), [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: null }]), []);
  // Released to a date: the downgrade is still there, with the hold in its receipt.
  const after = auditVipIntegrity(flattened, [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: "2026-03-09T00:00:00.000Z" }]);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.verdict, "downgraded");
  assert.equal(after[0]!.permanentSince, "2026-01-01T00:00:00.000Z");
  assert.ok(after[0]!.evidence.some((x) => /group perk began holding/.test(x)) && after[0]!.evidence.some((x) => /let go of it, dated 2026-03-09/.test(x)));
  // And swept away at that date: lost.
  assert.equal(auditVipIntegrity([...flattened, ev("2026-03-09T00:05:00.000Z", "vip.expire", true, { expiration: "2026-03-09T00:00:00.000Z" })], [])[0]!.verdict, "lost");

  // Hours automation took before the hold stay owed after it, and the released date is defended too.
  const taken = [
    ev("2026-01-01T00:00:00.000Z", "vip.grant", false, { expiration: "2026-03-01T00:00:00.000Z" }),
    ev("2026-01-05T00:00:00.000Z", "seed.reward", true, { expiration: "2026-02-20T00:00:00.000Z" }),
    ev("2026-01-10T00:00:00.000Z", "vip.group_hold", true, { bankedMs: 41 * DAY }),
    ev("2026-02-01T00:00:00.000Z", "vip.group_release", true, { expiration: "2026-04-01T00:00:00.000Z", bankedMs: 41 * DAY }),
    ev("2026-02-02T00:00:00.000Z", "seed.reward", true, { expiration: "2026-03-25T00:00:00.000Z" }),
  ];
  const owed = auditVipIntegrity(taken, [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: "2026-03-25T00:00:00.000Z" }]);
  assert.equal(owed.length, 1);
  assert.equal(owed[0]!.verdict, "shortened");
  assert.equal(owed[0]!.lostMs, 9 * DAY + 7 * DAY);

  // A story owed nothing still closes at the hold, as before.
  const clean = [
    ev("2026-01-01T00:00:00.000Z", "vip.grant", false, { expiration: "2026-03-01T00:00:00.000Z" }),
    ev("2026-01-10T00:00:00.000Z", "vip.group_hold", true, { bankedMs: 50 * DAY }),
  ];
  assert.deepEqual(auditVipIntegrity(clean, [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: null }]), []);
});

test("the integrity scan: a person taking the VIP of their own from beneath a hold settles the story — time granted there does not", () => {
  const ev = (ts: string, action: string, automated: boolean, data: Record<string, unknown> = {}): VipAuditEvent =>
    ({ ts, action, automated, actorName: automated ? "seeding" : "staff", serverId: "s1", targetId: "p1", data });
  // A permanent grant automation dated, then held: the debt rides through the hold.
  const owed = [
    ev("2026-01-01T00:00:00.000Z", "vip.grant", false, { expiration: null }),
    ev("2026-01-05T00:00:00.000Z", "seed.reward", true, { expiration: "2026-02-15T00:00:00.000Z" }),
    ev("2026-01-10T00:00:00.000Z", "vip.group_hold", true, { bankedMs: 36 * DAY }),
  ];
  const release = (expiration: string, bankedMs: number) => ev("2026-02-01T00:00:00.000Z", "vip.group_release", true, { expiration, bankedMs });
  const row = (expiration: string) => [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration }];
  // Untouched, the release brings the downgrade back up — owed, with add-back on offer.
  assert.equal(auditVipIntegrity([...owed, release("2026-03-09T00:00:00.000Z", 36 * DAY)], row("2026-03-09T00:00:00.000Z")).length, 1);
  // Staff revoking the VIP of their own beneath the hold decided it: nothing to add back after the release.
  const revoked = [...owed, ev("2026-01-20T00:00:00.000Z", "vip.revoke", false, { groupHeld: true, removedMs: 36 * DAY, bankedMs: 0 }), release("2026-02-01T00:00:00.000Z", 0)];
  assert.deepEqual(auditVipIntegrity(revoked, row("2026-02-01T00:00:00.000Z")), []);
  // A reduction there is a person deciding too — and the released date is defended from then on.
  const reduced = [...owed, ev("2026-01-20T00:00:00.000Z", "vip.reduce", false, { groupHeld: true, removedMs: DAY, bankedMs: 35 * DAY }), release("2026-03-08T00:00:00.000Z", 35 * DAY)];
  assert.deepEqual(auditVipIntegrity(reduced, row("2026-03-08T00:00:00.000Z")), []);
  assert.equal(auditVipIntegrity([...reduced, ev("2026-02-02T00:00:00.000Z", "seed.reward", true, { expiration: "2026-03-01T00:00:00.000Z" })], row("2026-03-01T00:00:00.000Z"))[0]?.verdict, "shortened");
  // Time GRANTED under the hold changes no story: the debt still rides on.
  const granted = [...owed, ev("2026-01-20T00:00:00.000Z", "vip.grant", false, { groupHeld: true, bankedMs: 40 * DAY }), release("2026-03-13T00:00:00.000Z", 40 * DAY)];
  assert.equal(auditVipIntegrity(granted, row("2026-03-13T00:00:00.000Z")).length, 1);
});

test("linking a group to a Discord role hands the sync its membership — so it takes the keys membership takes; unlinking keeps everyone", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const srv = (await jf(`${base}/api/servers`, { method: "POST", headers: auth, body: JSON.stringify({ name: `WW2 roles ${Date.now()}`, host: "127.0.0.1", port: 1, password: "x" }) })).body.server as { id: string; game: string };
    const gid = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: `Synced CVC ${Date.now()}` }) })).body.group.id as string;
    const groupsOnly = await staff(base, auth, `rolesgroupsonly${Date.now()}`, [
      { capability: "server.view", level: "read", scopeType: "global", scopeId: null },
      { capability: "player.groups", level: "write", scopeType: "global", scopeId: null },
    ]);
    const link = (h: Record<string, string>, roleId: unknown) => jf(`${base}/api/player-groups/${gid}/discord-role`, { method: "PUT", headers: h, body: JSON.stringify({ roleId }) });

    assert.match(JSON.stringify((await link(auth, "not-a-role")).body), /not a Discord role id/);
    // A plain group: membership moves nothing, so group access is enough.
    assert.equal((await link(groupsOnly, "900000000000000777")).status, 200);
    // A perk group: the sync would hand out and end permanent VIP, so it takes the VIP keys.
    await jf(`${base}/api/player-groups/${gid}/perk`, { method: "PUT", headers: auth, body: JSON.stringify({ game: srv.game, scope: { mode: "all" }, severanceMinutes: 0 }) });
    const refused = await link(groupsOnly, "900000000000000778");
    assert.deepEqual(await askedFor(base, auth, refused), { capability: "vip.grant", serverId: srv.id });
    assert.equal((await repo.playerGroups.get(gid))!.discordRoleId, "900000000000000777", "still linked to the role it had");
    const ok = await link(auth, "900000000000000778");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.group.discordRoleId, "900000000000000778");
    const detail = await jf(`${base}/api/player-groups/${gid}`, { headers: auth });
    assert.deepEqual(detail.body.discordRole, { id: "900000000000000778", name: null, problem: null }, "no bot token here, so no name — the id still says which role");
    // Why the sync left it as it was, when it did — but only a note read against the role it follows now.
    await repo.heartbeats.upsert({ name: "group_role_sync", status: "running", detail: { notes: { [gid]: { roleId: "900000000000000777", reason: "old role's note" } } } });
    assert.equal((await jf(`${base}/api/player-groups/${gid}`, { headers: auth })).body.discordRole.problem, null);
    await repo.heartbeats.upsert({ name: "group_role_sync", status: "running", detail: { notes: { [gid]: { roleId: "900000000000000778", reason: "2001 members hold its role" } } } });
    assert.equal((await jf(`${base}/api/player-groups/${gid}`, { headers: auth })).body.discordRole.problem, "2001 members hold its role");
    await repo.heartbeats.upsert({ name: "group_role_sync", status: "running", detail: { skipped: "the Discord server's roles couldn't be read", notes: {} } });
    assert.match((await jf(`${base}/api/player-groups/${gid}`, { headers: auth })).body.discordRole.problem, /^the last sync changed nothing: the Discord server's roles/);

    // Unlinking only stops the changes: group access, and every member stays.
    assert.equal(await repo.playerGroups.syncAddMember({ groupId: gid, roleId: "900000000000000778", playerId: "76561199400000001", playerName: "Synced", addedByName: "discord-sync" }), true);
    const off = await link(groupsOnly, null);
    assert.equal(off.status, 200);
    assert.equal(off.body.group.discordRoleId, null);
    assert.equal((await repo.playerGroups.members(gid)).length, 1);
    const trail = (await repo.audit.list({ actions: ["group.discord_role"] })).map((a) => a.summary);
    assert.ok(trail.some((t) => /unlinked group .* its members stay listed/.test(t)));
    assert.ok(trail.some((t) => /linked group .* to the Discord role 900000000000000778 — whoever holds it is kept listed/.test(t)));
  });
});

test("grants racing a hold: one begun after the read banks the time, one ended before the bank grants from the dated row, permanent takes over either way", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const srv = await repo.servers.create({ name: "WW2 race", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const src = [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 0 }];
      const grant = (playerId: string, body: Record<string, unknown>) => jf(`${base}/api/servers/${srv.id}/vips`, { method: "POST", headers: auth, body: JSON.stringify({ playerId, playerName: "P", comment: "donor", ...body }) });
      // The reconciler landing in the gap: right after the route reads the grant.
      const realGet = repo.vips.get.bind(repo.vips);
      let afterRead: (() => Promise<unknown>) | null = null;
      repo.vips.get = async (sid: string, pid: string) => {
        const row = await realGet(sid, pid);
        const f = afterRead;
        afterRead = null;
        if (f) await f();
        return row;
      };

      // Ten days timed; the hold begins after the read; seven days stacked land in the frozen balance.
      const bob = "76561198000000021";
      await repo.vips.upsert({ serverId: srv.id, playerId: bob, expiration: new Date(Date.now() + 10 * DAY).toISOString(), createdByName: "staff" });
      afterRead = () => repo.vips.startGroupHold({ serverId: srv.id, playerId: bob, groups: src, createdByName: "group perks" });
      const late = await grant(bob, { mode: "duration", days: 7, cumulative: true });
      assert.equal(late.status, 200, JSON.stringify(late.body));
      assert.match(late.body.applied[0].note, /WW2 CVC.*get back on leaving/);
      const bobRow = (await realGet(srv.id, bob))!;
      assert.equal(bobRow.expiration, null);
      assert.ok(Math.abs(bobRow.groupHold!.bankedMs - 17 * DAY) < 60_000, `seventeen days frozen (got ${bobRow.groupHold!.bankedMs})`);

      // Held with five days frozen; the hold ends between the read and the bank: two days stack on
      // the dated row the release left — never on the permanent it replaced.
      const cid = "76561198000000022";
      await repo.vips.upsert({ serverId: srv.id, playerId: cid, expiration: new Date(Date.now() + 5 * DAY).toISOString(), createdByName: "staff" });
      await repo.vips.startGroupHold({ serverId: srv.id, playerId: cid, groups: src, createdByName: "group perks" });
      const realBank = repo.vips.bankGroupHold.bind(repo.vips);
      let once = true;
      repo.vips.bankGroupHold = async (sid, pid, change) => {
        if (once) { once = false; await repo.vips.endGroupHold(sid, pid, new Date(Date.now() + 5 * DAY).toISOString()); }
        return realBank(sid, pid, change);
      };
      const ended = await grant(cid, { mode: "duration", days: 2, cumulative: true });
      assert.equal(ended.status, 200, JSON.stringify(ended.body));
      const cidRow = (await realGet(srv.id, cid))!;
      assert.equal(cidRow.groupHold, null);
      assert.ok(cidRow.expiration, "dated — not permanent VIP for a two-day grant");
      assert.ok(Math.abs(Date.parse(cidRow.expiration!) - (Date.now() + 7 * DAY)) < 60_000, `seven days (got ${cidRow.expiration})`);

      // Permanent granted outright while a hold begins after the read: the grant is the person's.
      const dee = "76561198000000023";
      await repo.vips.upsert({ serverId: srv.id, playerId: dee, expiration: new Date(Date.now() + 3 * DAY).toISOString(), createdByName: "staff" });
      afterRead = () => repo.vips.startGroupHold({ serverId: srv.id, playerId: dee, groups: src, createdByName: "group perks" });
      assert.equal((await grant(dee, { mode: "permanent" })).status, 200);
      const deeRow = (await realGet(srv.id, dee))!;
      assert.equal(deeRow.expiration, null);
      assert.equal(deeRow.groupHold, null, "not the group's to end when they leave");
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("a group-wide VIP grant that meets a hold begun after its read says where the time went", async () => {
  let fake: FakeHllServer | null = null;
  try {
    await withServer(async (base, repo) => {
      const auth = await owner(base);
      fake = new FakeHllServer("pw");
      const port = await fake.listen();
      const srv = await repo.servers.create({ name: "WW2 apply", game: "hll", protocol: "binary-v2", host: "127.0.0.1", port, password: "pw", engagementMode: "active" } as never);
      const ana = "76561198000000041";
      await repo.vips.upsert({ serverId: srv.id, playerId: ana, expiration: new Date(Date.now() + 10 * DAY).toISOString(), createdByName: "staff" });
      const gid = (await jf(`${base}/api/player-groups`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Apply race" }) })).body.group.id as string;
      await jf(`${base}/api/player-groups/${gid}/members`, { method: "POST", headers: auth, body: JSON.stringify({ playerId: ana, playerName: "Ana" }) });
      const realGet = repo.vips.get.bind(repo.vips);
      let once = true;
      repo.vips.get = async (sid: string, pid: string) => {
        const row = await realGet(sid, pid);
        if (once && pid === ana) { once = false; await repo.vips.startGroupHold({ serverId: sid, playerId: pid, groups: [{ id: "g-cvc", name: "WW2 CVC", severanceMinutes: 0 }], createdByName: "group perks" }); }
        return row;
      };
      const r = await jf(`${base}/api/player-groups/${gid}/apply`, { method: "POST", headers: auth, body: JSON.stringify({ action: "vip", serverId: srv.id, mode: "duration", days: 7, cumulative: true, comment: "event" }) });
      repo.vips.get = realGet;
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const res = (r.body.results as { applied: { playerId: string; note: string }[] }[])[0]!;
      assert.match(res.applied.find((x) => x.playerId === ana)!.note, /WW2 CVC.*get back on leaving/);
      const audit = (await repo.audit.list({ actions: ["vip.grant"] })).find((a) => a.targetId === ana)!;
      assert.equal((audit.data as { groupHeld?: boolean }).groupHeld, true, "the scan reads it as banked time, not a permanent grant");
      assert.ok(Math.abs((await realGet(srv.id, ana))!.groupHold!.bankedMs - 17 * DAY) < 60_000);
    });
  } finally {
    await (fake as FakeHllServer | null)?.close();
  }
});

test("the integrity scan: a sync restoring a held grant's game entry keeps the story the hold carried", () => {
  const ev = (ts: string, action: string, automated: boolean, data: Record<string, unknown> = {}): VipAuditEvent =>
    ({ ts, action, automated, actorName: automated ? "seeding" : "staff", serverId: "s1", targetId: "p1", data });
  const taken = [
    ev("2026-01-01T00:00:00.000Z", "vip.grant", false, { expiration: "2026-03-01T00:00:00.000Z" }),
    ev("2026-01-05T00:00:00.000Z", "seed.reward", true, { expiration: "2026-02-20T00:00:00.000Z" }),
    ev("2026-01-10T00:00:00.000Z", "vip.group_hold", true, { bankedMs: 41 * DAY }),
    ev("2026-01-20T00:00:00.000Z", "vip.grant", true, { expiration: null }),
    ev("2026-02-01T00:00:00.000Z", "vip.group_release", true, { expiration: "2026-04-01T00:00:00.000Z", bankedMs: 41 * DAY }),
  ];
  const owed = auditVipIntegrity(taken, [{ serverId: "s1", playerId: "p1", playerName: "Ana", expiration: "2026-04-01T00:00:00.000Z" }]);
  assert.equal(owed.length, 1);
  assert.equal(owed[0]!.verdict, "shortened");
  assert.equal(owed[0]!.lostMs, 9 * DAY);
});

/*
 * A perk never takes over a permanent the player already owns, so that grant carries no hold — and
 * the VIP page used to show such a member exactly like everybody else's permanent. The VIP list now
 * names the perk groups covering the server that list each player; the page shows the group, with
 * their own permanent paused beneath it. Display only: the grant itself is untouched.
 */
test("the VIP list names the perk groups covering the server that list each player — and only those", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const ww2 = await repo.servers.create({ name: "WW2 #1", game: "hll", host: "127.0.0.1", port: 1, password: "x", engagementMode: "active" } as never);
    const other = await repo.servers.create({ name: "WW2 #2", game: "hll", host: "127.0.0.1", port: 2, password: "x", engagementMode: "active" } as never);
    const own = "76561198000000501";   // permanent of their own, in a perk group
    const dated = "76561198000000502"; // dated VIP, in a perk group
    const plain = "76561198000000503"; // permanent of their own, in a group with no perk
    const outside = "76561198000000504"; // in a perk group that does not cover this server
    for (const pid of [own, plain, outside]) await repo.vips.upsert({ serverId: ww2.id, playerId: pid, expiration: null, createdByName: "staff" });
    await repo.vips.upsert({ serverId: ww2.id, playerId: dated, expiration: new Date(Date.now() + 9 * DAY).toISOString(), createdByName: "staff" });

    const cvc = await repo.playerGroups.create({ name: "WW2 CVC", createdByName: "staff" });
    await repo.playerGroups.setVipPerk(cvc.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0 } as never);
    const noPerk = await repo.playerGroups.create({ name: "Streamers", createdByName: "staff" });
    const elsewhere = await repo.playerGroups.create({ name: "WW2 #2 crew", createdByName: "staff" });
    await repo.playerGroups.setVipPerk(elsewhere.id, { game: "hll", scope: { mode: "servers", serverIds: [other.id] }, severanceMinutes: 0 } as never);
    for (const pid of [own, dated]) await repo.playerGroups.addMember({ groupId: cvc.id, playerId: pid, addedByName: "staff" });
    await repo.playerGroups.addMember({ groupId: noPerk.id, playerId: plain, addedByName: "staff" });
    await repo.playerGroups.addMember({ groupId: elsewhere.id, playerId: outside, addedByName: "staff" });

    const list = await jf(`${base}/api/servers/${ww2.id}/vips`, { headers: auth });
    assert.equal(list.status, 200);
    const groupsOf = (pid: string) => (list.body.vips as { playerId: string; perkGroups?: { id: string; name: string }[] }[]).find((v) => v.playerId === pid)?.perkGroups;
    assert.deepEqual(groupsOf(own), [{ id: cvc.id, name: "WW2 CVC" }], "a member of a perk group covering the server");
    assert.deepEqual(groupsOf(dated), [{ id: cvc.id, name: "WW2 CVC" }]);
    assert.equal(groupsOf(plain), undefined, "a group with no VIP perk says nothing about VIP");
    assert.equal(groupsOf(outside), undefined, "a perk scoped to other servers does not cover this one");
    // Display only: the permanent of their own is exactly as it was.
    const row = (await repo.vips.get(ww2.id, own))!;
    assert.equal(row.expiration, null);
    assert.equal(row.groupHold, null);
  });
});

/*
 * Only where the perk acts. On a server in observe mode, or whose VIP expiry the panel does not run,
 * the perk neither starts nor releases a hold; and a console id the directory has never seen waits
 * until it has been. There the group gives the player nothing, so the VIP list must not show the
 * group with their own permanent "paused" beneath it — and the revoke must not promise that the
 * group takes over: it would leave a player who may have paid for that permanent with no VIP.
 */
test("the VIP list names a player's perk groups only where the perk acts: an armed server running VIP expiry, a player of its game", async () => {
  await withServer(async (base, repo) => {
    const auth = await owner(base);
    const armed = await repo.servers.create({ name: "WW2 armed", game: "hll", host: "127.0.0.1", port: 1, password: "x", engagementMode: "active" } as never);
    const watching = await repo.servers.create({ name: "WW2 observe", game: "hll", host: "127.0.0.1", port: 2, password: "x", engagementMode: "observe" } as never);
    const crcon = await repo.servers.create({ name: "WW2 CRCON VIP", game: "hll", host: "127.0.0.1", port: 3, password: "x", engagementMode: "active" } as never);
    await repo.servers.setAutomation(crcon.id, { vipSweep: false });
    const steam = "76561198000000601";                  // a Steam64: a WW2 player, seen or not
    const unseen = "a2c4e6f8b0d2a2c4e6f8b0d2a2c4e6f8";  // a console id the directory has never seen
    const seen = "b1d3f5a7c9e1b1d3f5a7c9e1b1d3f5a7";    // a console id seen on WW2
    await repo.players.upsert({ game: "hll", platform: "xbox", platformId: seen, name: "Seen on console" });
    for (const sid of [armed.id, watching.id, crcon.id]) {
      for (const pid of [steam, unseen, seen]) await repo.vips.upsert({ serverId: sid, playerId: pid, expiration: null, createdByName: "staff" });
    }
    const cvc = await repo.playerGroups.create({ name: "WW2 CVC", createdByName: "staff" });
    await repo.playerGroups.setVipPerk(cvc.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0 } as never);
    for (const pid of [steam, unseen, seen]) await repo.playerGroups.addMember({ groupId: cvc.id, playerId: pid, addedByName: "staff" });

    const groupsOn = async (serverId: string) => {
      const list = await jf(`${base}/api/servers/${serverId}/vips`, { headers: auth });
      assert.equal(list.status, 200);
      const rows = list.body.vips as { playerId: string; perkGroups?: { id: string; name: string }[] }[];
      assert.equal(rows.length, 3, "every grant is still listed — only the annotation is held back");
      return (pid: string) => rows.find((v) => v.playerId === pid)?.perkGroups;
    };
    const onArmed = await groupsOn(armed.id);
    assert.deepEqual(onArmed(steam), [{ id: cvc.id, name: "WW2 CVC" }], "a Steam64 member on an armed server running VIP expiry");
    assert.deepEqual(onArmed(seen), [{ id: cvc.id, name: "WW2 CVC" }], "a console member the directory has seen on this game");
    assert.equal(onArmed(unseen), undefined, "a console id never seen waits, as the perk does");
    const onWatching = await groupsOn(watching.id);
    for (const pid of [steam, unseen, seen]) assert.equal(onWatching(pid), undefined, "observe mode: the perk writes nothing here");
    const onCrcon = await groupsOn(crcon.id);
    for (const pid of [steam, unseen, seen]) assert.equal(onCrcon(pid), undefined, "VIP expiry off: CRCON owns VIP here, the perk writes nothing");
  });
});
