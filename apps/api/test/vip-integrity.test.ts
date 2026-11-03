/**
 * The paid-VIP integrity scan — the reconstruction of two field incidents from the audit trail.
 *
 * What is pinned: a permanent grant a PERSON made, later dated or destroyed by automation, is a
 * finding with the automated writes as evidence; anything a person decided afterwards (revoke,
 * reduce, deliberate dated replace, fresh permanent re-grant) closes the story; vip-sync's
 * permanent restores are the safety net working — never evidence, and since the third field
 * sighting they ANCHOR a story too, because a synced or imported permanent is as paid-for as a
 * hand-granted one; and the list is ordered the way staff should work it — already-lost grants
 * first, then the still-standing time bombs by fuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditVipIntegrity, type VipAuditEvent, type VipCurrentRow } from "../dist/vip-integrity.js";

const S = "srv-1";
const T = (n: number) => new Date(Date.parse("2026-09-01T00:00:00Z") + n * 3_600_000).toISOString();
const grant = (over: Partial<VipAuditEvent>): VipAuditEvent =>
  ({ ts: T(0), action: "vip.grant", automated: false, actorName: "staff", serverId: S, targetId: "p1", targetName: "Payer", data: { expiration: null }, ...over });

test("the field incident, end to end: dated by seeding, removed by the sweep, flagged as LOST with receipts", () => {
  const events: VipAuditEvent[] = [
    grant({ ts: T(0) }),
    // vip-sync restoring the permanent grant the game lost — the safety net, NOT evidence.
    grant({ ts: T(5), automated: true, actorName: "vip-sync", data: { expiration: null, reconcile: true } }),
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { hours: 72, expiration: T(82) } },
    { ts: T(83), action: "vip.revoke", automated: true, actorName: "vip-sync", serverId: S, targetId: "p1", data: { why: "expired", reconcile: true } },
    { ts: T(84), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "p1", data: { expiration: T(82) } },
  ];
  const [f, ...rest] = auditVipIntegrity(events, []);
  assert.deepEqual(rest, [], "one damaged grant, one finding");
  assert.equal(f!.verdict, "lost");
  assert.equal(f!.grantedBy, "staff");
  assert.equal(f!.permanentSince, T(0));
  assert.equal(f!.playerName, "Payer");
  assert.equal(f!.evidence.length, 3, "the seed write, the vip-sync removal and the sweep are all on the receipt");
  assert.match(f!.evidence[0]!, /seed reward wrote an expiration/);
  assert.match(f!.evidence[2]!, /expiry sweep removed the grant/);
});

test("a still-standing dated row is a TIME BOMB: flagged as downgraded with the date it will die", () => {
  const events = [grant({}), { ts: T(1), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(73) } } as VipAuditEvent];
  const current: VipCurrentRow[] = [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(73) }];
  const [f] = auditVipIntegrity(events, current);
  assert.equal(f!.verdict, "downgraded");
  assert.equal(f!.currentExpiration, T(73));
});

test("a person's own decisions close the story: revoke, reduce, dated replace, or a fresh permanent", () => {
  const seeds = (endTs: string, end: Partial<VipAuditEvent>): VipAuditEvent[] => [
    grant({}),
    { ts: endTs, action: "vip.grant", automated: false, actorName: "boss", serverId: S, targetId: "p1", data: {}, ...end } as VipAuditEvent,
  ];
  // Staff revoked it — no finding even though the row is gone.
  assert.deepEqual(auditVipIntegrity(seeds(T(2), { action: "vip.revoke", data: {} }), []), []);
  // Staff deliberately replaced permanent with a dated grant — theirs to decide.
  assert.deepEqual(auditVipIntegrity(seeds(T(2), { action: "vip.grant", data: { expiration: T(100) } }), [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(100) }]), []);
  // Staff took time back (the reduce route refuses permanent, but history may predate that).
  assert.deepEqual(auditVipIntegrity(seeds(T(2), { action: "vip.reduce", data: { after: T(50) } }), []), []);
  // The grant was lost AND staff already re-granted permanent: the fresh grant restarts the
  // story, and the standing permanent row closes it.
  const regranted: VipAuditEvent[] = [
    grant({ ts: T(0) }),
    { ts: T(1), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "p1", data: {} },
    grant({ ts: T(2), actorName: "rescuer" }),
  ];
  assert.deepEqual(auditVipIntegrity(regranted, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: null }]), []);
});

test("lost grants outrank time bombs, and bombs sort by fuse — the order staff should work in", () => {
  const events: VipAuditEvent[] = [
    grant({ ts: T(0), targetId: "bomb-late" }),
    { ts: T(1), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "bomb-late", data: { expiration: T(200) } },
    grant({ ts: T(0), targetId: "gone" }),
    { ts: T(2), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "gone", data: {} },
    grant({ ts: T(0), targetId: "bomb-soon" }),
    { ts: T(3), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "bomb-soon", data: { expiration: T(50) } },
  ];
  const current: VipCurrentRow[] = [
    { serverId: S, playerId: "bomb-late", playerName: null, expiration: T(200) },
    { serverId: S, playerId: "bomb-soon", playerName: null, expiration: T(50) },
  ];
  assert.deepEqual(auditVipIntegrity(events, current).map((f) => f.playerId), ["gone", "bomb-soon", "bomb-late"]);
});

test("an automated dated grant alone never starts a story — only a PERMANENT write anchors one", () => {
  // Crash VIP granting 10 minutes to a player with no permanent history is ordinary business.
  const events: VipAuditEvent[] = [
    { ts: T(0), action: "vip.grant", automated: true, actorName: "enforcer", serverId: S, targetId: "p9", data: { expiration: T(1) } },
    { ts: T(2), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "p9", data: {} },
  ];
  assert.deepEqual(auditVipIntegrity(events, []), []);
});


/*
 * The third field sighting: the permanent never passed through a person's hands on this
 * install — vip-sync restored it to the game all through August (each restore an automated
 * vip.grant with a null expiration, copied from the book of record) — and the pre-floor seed
 * reward then flattened it to a date. With a human-only anchor the scan had no story to tell
 * and the restore button never appeared, while the grant sat as a live time bomb.
 */
test("a SYNCED permanent anchors the story: vip-sync restores + seed flatten = a downgraded finding", () => {
  const events: VipAuditEvent[] = [
    grant({ ts: T(0), automated: true, actorName: "vip-sync" }),
    grant({ ts: T(5), automated: true, actorName: "vip-sync" }),
    // The pre-floor seed reward writes a date over it…
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(82) } },
    // …and later rewards legitimately stack the now-dated row: more receipts, same story.
    { ts: T(82), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(154) } },
  ];
  const out = auditVipIntegrity(events, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(154) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, "downgraded");
  assert.equal(out[0]!.grantedBy, "vip-sync");
  assert.equal(out[0]!.permanentSince, T(0), "the FIRST proof anchors; later restores confirm rather than restart");
  assert.equal(out[0]!.currentExpiration, T(154), "the fuse is the STACKED date, not the first flatten");
  assert.equal(out[0]!.evidence.length, 2, "both seed writes ride along as the receipt");

  // The same restores with the permanent still standing: the safety net working, no finding.
  const standing = auditVipIntegrity(events.slice(0, 2), [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: null }]);
  assert.deepEqual(standing, []);
});

/*
 * The generalisation the fourth field report asked for: DATED time is defended too. A grant is a
 * grant however it was earned — staff-given days, seed-reward hours — and any automated write
 * that moves its expiry EARLIER is hours taken from a player. The verdict carries exactly how
 * many, so the remedy is "stack that much back on", not "guess".
 */
test("shortened: an automated write that moves a dated expiry earlier is a finding with the hours counted", () => {
  const events: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(240) } }), // staff gave 10 days
    // The pre-floor seed reward replaces it with now+72h — 158 hours taken…
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(82) } },
    // …and a later reward stacking the row is ordinary business, not more damage.
    { ts: T(82), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(154) } },
  ];
  const out = auditVipIntegrity(events, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(154) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, "shortened");
  assert.equal(out[0]!.lostMs, 158 * 3_600_000, "expected T(240), got T(82): 158 hours owed");
  assert.equal(out[0]!.currentExpiration, T(154));
  assert.equal(out[0]!.evidence.length, 1, "only the write that took time is evidence");
  assert.match(out[0]!.evidence[0]!, /moved the expiry earlier/);
});

test("shortened survives the row's death: hours taken stay owed after the sweep ends the grant", () => {
  const events: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(240) } }),
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(82) } },
    { ts: T(83), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "p1", data: {} },
  ];
  const out = auditVipIntegrity(events, []);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, "shortened");
  assert.equal(out[0]!.currentExpiration, null, "the row is gone — the add-back starts from now");
  assert.equal(out[0]!.lostMs, 158 * 3_600_000);
});

test("no finding from ordinary reward stacking, and a person's own writes reset the dated story", () => {
  // Rewards only ever extending: nothing to defend.
  const stacking: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(72) } }),
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(144) } },
  ];
  assert.deepEqual(auditVipIntegrity(stacking, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(144) }]), []);

  // Damage followed by a person re-granting: their decision is the new truth, story reset.
  const humanReset: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(240) } }),
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(82) } },
    grant({ ts: T(20), data: { expiration: T(100) } }),
  ];
  assert.deepEqual(auditVipIntegrity(humanReset, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(100) }]), []);

  // A seed-EARNED grant is defended exactly like a staff-given one.
  const earned: VipAuditEvent[] = [
    { ts: T(0), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", targetName: "Seeder", data: { expiration: T(72) } },
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(40) } },
  ];
  const out = auditVipIntegrity(earned, [{ serverId: S, playerId: "p1", playerName: "Seeder", expiration: T(40) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, "shortened");
  assert.equal(out[0]!.lostMs, 32 * 3_600_000);
  assert.equal(out[0]!.grantedBy, "seeding", "the earner's own reward established the entitlement");
});

/*
 * The dismissal. An Ignore is itself a human decision recorded in the same trail the scan
 * reads, so it closes the story like any other decision — and closes it only up to its own
 * instant: damage automation does AFTERWARDS anchors a fresh story and surfaces again. An old
 * dismissal can never swallow new damage.
 */
test("an ignore closes the story it judged, and only that story — later damage surfaces fresh", () => {
  const damaged: VipAuditEvent[] = [
    grant({ ts: T(0) }),
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(82) } },
  ];
  // Staff dismiss it: the downgraded finding is gone.
  const ignored: VipAuditEvent[] = [
    ...damaged,
    { ts: T(20), action: "vip.integrity_ignore", automated: false, actorName: "KREITZ", serverId: S, targetId: "p1", data: {} },
  ];
  assert.equal(auditVipIntegrity(damaged, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(82) }]).length, 1, "the finding exists before the dismissal");
  assert.deepEqual(auditVipIntegrity(ignored, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(82) }]), []);

  // Automation takes time AFTER the dismissal: a new story, a new finding — anchored after it.
  const newDamage: VipAuditEvent[] = [
    ...ignored,
    { ts: T(30), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(100) } },
    { ts: T(40), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(60) } },
  ];
  const out = auditVipIntegrity(newDamage, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(60) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, "shortened");
  assert.equal(out[0]!.lostMs, 40 * 3_600_000, "only the post-dismissal loss is counted");
  assert.ok(out[0]!.permanentSince >= T(20), "the fresh story anchors after the dismissal");
});

test("a game reward's extension is part of the timeline: cutting back below it is a loss", () => {
  const events: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(240) } }), // staff gave 10 days
    // A top-stats reward stacks 48h onto it…
    { ts: T(10), action: "game.reward", automated: true, actorName: "game rewards", serverId: S, targetId: "p1", data: { expiration: T(288), vipGiven: 48 } },
    // …a points-only reward writes no expiry and is not part of the story…
    { ts: T(11), action: "game.reward", automated: true, actorName: "game rewards", serverId: S, targetId: "p1", data: { vipGiven: 0, pointsGiven: 100 } },
    // …and an automated write back to T(264) takes 24h of it. Unread, the reward was invisible
    // and T(264) looked later than the staff grant's T(240) — no loss at all.
    { ts: T(20), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(264) } },
  ];
  const out = auditVipIntegrity(events, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(264) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.verdict, "shortened");
  assert.equal(out[0]!.lostMs, 24 * 3_600_000);
});

test("VIP earned only from a game reward is defended too", () => {
  const events: VipAuditEvent[] = [
    { ts: T(0), action: "game.reward", automated: true, actorName: "game rewards", serverId: S, targetId: "p1", data: { expiration: T(72), vipGiven: 72 } },
    { ts: T(5), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(30) } },
  ];
  const out = auditVipIntegrity(events, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(30) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.lostMs, 42 * 3_600_000);
});

test("time a banked pause gave back is defended: a later cut into it is a loss", () => {
  const events: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(240) } }),
    // The lapse sweep returns 24 frozen hours on this server…
    { ts: T(30), action: "player.vipresume", automated: true, actorName: "system", serverId: S, targetId: "p1", data: { playerId: "p1", bankedMs: 24 * 3_600_000, expiration: T(264) } },
    // …and a later automated write back to T(250) takes 14 of them.
    { ts: T(40), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(250) } },
  ];
  const out = auditVipIntegrity(events, [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(250) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.lostMs, 14 * 3_600_000);
});

test("a staff resume lists each server's returned expiry, and only ever extends", () => {
  const S2 = "srv-2";
  const events: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(240) } }),
    grant({ ts: T(0), serverId: S2, data: { expiration: T(100) } }),
    // One row for several servers, targeted at the profile rather than a server.
    { ts: T(30), action: "player.vipresume", automated: false, actorName: "staff", serverId: null, targetId: "profile-uuid",
      data: { playerId: "p1", banked: [{ serverId: S, expiration: T(260) }, { serverId: S2, expiration: T(90) }] } },
    { ts: T(40), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(250) } },
  ];
  const out = auditVipIntegrity(events, [
    { serverId: S, playerId: "p1", playerName: "Payer", expiration: T(250) },
    { serverId: S2, playerId: "p1", playerName: "Payer", expiration: T(100) },
  ]);
  assert.equal(out.length, 1, "server 2's earlier listed date never shortens its story");
  assert.equal(out[0]!.serverId, S);
  assert.equal(out[0]!.lostMs, 10 * 3_600_000);
});

test("a reduction that uses a grant up ends it — never a lost permanent; a scheduled rule's cut is a decision, a loose one is time taken", () => {
  const usedUp: VipAuditEvent[] = [
    grant({ data: { expiration: T(48) } }),
    { ts: T(2), action: "vip.reduce", automated: false, actorName: "staff", serverId: S, targetId: "p1", data: { before: T(48), after: null, removed: true } },
  ];
  assert.deepEqual(auditVipIntegrity(usedUp, []), [], "a refund that took everything is the person's call, and the row being gone is its result");

  const scheduled: VipAuditEvent[] = [
    grant({ data: { expiration: T(240) } }),
    { ts: T(2), action: "vip.reduce", automated: true, actorName: "enforcer", serverId: S, targetId: "p1", data: { before: T(240), after: T(120), decidedByRule: true } },
  ];
  const standing = [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: T(120) }];
  assert.deepEqual(auditVipIntegrity(scheduled, standing), [], "a configured cut is the rule doing what it was told");
  const loose = scheduled.map((e, i) => (i === 1 ? { ...e, data: { before: T(240), after: T(120) } } : e));
  assert.equal(auditVipIntegrity(loose, standing)[0]?.verdict, "shortened", "the same write with no decision behind it is hours taken");
});

/*
 * The fourth field sighting: a player whose only VIP was ever crash VIP sat on the list as
 * "shortened" with an add-back. Two crash VIPs a moment apart were recorded with the second
 * expiry EARLIER than the first, and the scan read that as time taken. A rule's own VIP is
 * minutes the rule hands out for free and manages itself; nobody paid for or earned them.
 */
const ruleVip = (ts: string, expiration: string): VipAuditEvent =>
  ({ ts, action: "enforcer.vip", automated: true, actorName: "enforcer", serverId: S, targetId: "p1", targetName: "Crasher", data: { playerId: "p1", expiration } });

test("crash VIP alone is never a finding, however its writes were recorded", () => {
  const events: VipAuditEvent[] = [
    ruleVip(T(0), T(2)),
    ruleVip(T(0.01), T(1)), // the second crash VIP, recorded 36 seconds later with the earlier expiry
    // The VIP sync copying the rule's grant onto the game is nobody paying for it either.
    { ts: T(0.5), action: "vip.grant", automated: true, actorName: "vip-sync", serverId: S, targetId: "p1", data: { expiration: T(1), reconcile: true } },
    ruleVip(T(0.6), T(0.9)),
  ];
  assert.deepEqual(auditVipIntegrity(events, [{ serverId: S, playerId: "p1", playerName: "Crasher", expiration: T(0.9) }]), [], "while it stands");
  const lapsed = [...events, { ts: T(1), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "p1", data: {} } as VipAuditEvent];
  assert.deepEqual(auditVipIntegrity(lapsed, []), [], "and once the sweep has ended it");
});

test("a rule's VIP cutting time somebody paid for or earned is still a finding, and only that time is owed", () => {
  // Ten days bought in the shop; the pre-floor crash VIP wrote now+1h over them.
  const bought: VipAuditEvent[] = [
    { ts: T(0), action: "vip.grant", automated: true, actorName: "VIP shop", serverId: S, targetId: "p1", data: { expiration: T(240), days: 10 } },
    ruleVip(T(10), T(11)),
  ];
  const [cut] = auditVipIntegrity(bought, [{ serverId: S, playerId: "p1", playerName: "Crasher", expiration: T(11) }]);
  assert.equal(cut?.verdict, "shortened");
  assert.equal(cut!.lostMs, 229 * 3_600_000);
  assert.match(cut!.evidence[0]!, /enforcer moved the expiry earlier/);

  // Crash VIP first, then a day of seed reward on top, then a crash VIP cut: the seeding hours
  // were earned, the rule's own minutes never were.
  const earned: VipAuditEvent[] = [
    ruleVip(T(0), T(1)),
    { ts: T(0.5), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(25) } },
    ruleVip(T(2), T(3)),
    { ts: T(3), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "p1", data: {} },
  ];
  const out = auditVipIntegrity(earned, []);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.lostMs, 22 * 3_600_000, "T(25) cut to T(3)");
});

test("hours taken stay owed when the grant lapses and automation grants VIP again later", () => {
  const cutThenLapsed: VipAuditEvent[] = [
    grant({ ts: T(0), data: { expiration: T(240) } }), // staff gave 10 days
    { ts: T(10), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(82) } },
    { ts: T(83), action: "vip.expire", automated: true, actorName: "system", serverId: S, targetId: "p1", data: {} },
  ];
  for (const later of [
    { ts: T(100), action: "seed.reward", automated: true, actorName: "seeding", serverId: S, targetId: "p1", data: { expiration: T(172) } } as VipAuditEvent,
    ruleVip(T(100), T(101)),
  ]) {
    const out = auditVipIntegrity([...cutThenLapsed, later], [{ serverId: S, playerId: "p1", playerName: "Payer", expiration: later.data!.expiration as string }]);
    assert.equal(out.length, 1, `still owed after a later ${later.action}`);
    assert.equal(out[0]!.verdict, "shortened");
    assert.equal(out[0]!.lostMs, 158 * 3_600_000);
    assert.equal(out[0]!.grantedBy, "staff", "the finding still names the grant the time was taken from");
    assert.equal(out[0]!.evidence.length, 1);
  }
});
