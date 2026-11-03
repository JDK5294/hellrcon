import { test } from "node:test";
import assert from "node:assert/strict";
// dist, not src — the same reason repo.test.ts reads dist.
import { InMemoryRepository, createIsolatedRepository, getFeaturePreset, memberGameVerdict } from "../dist/index.js";
import type { Repository } from "../src/types.ts";

/**
 * Group membership as a rule trigger, asked of both stores: a REAL change queues an event (a re-add
 * of someone already listed does not), taking events claims them (a second take gets nothing), and
 * deleting a group queues nothing — the queue is what the rule engine fires on, so a phantom join
 * would hand someone VIP for nothing.
 */
async function scenario(repo: Repository) {
  const group = await repo.playerGroups.create({ name: "WW2 CVC", createdByName: "staff" });
  const other = await repo.playerGroups.create({ name: "Casters", createdByName: "staff" });

  await repo.playerGroups.addMember({ groupId: group.id, playerId: "76561198000000001", playerName: "Ana", addedByName: "staff" });
  await repo.playerGroups.addMember({ groupId: group.id, playerId: "76561198000000001", playerName: "Ana B", addedByName: "staff" });
  await repo.playerGroups.addMember({ groupId: other.id, playerId: "76561198000000002", playerName: "Bob", addedByName: "staff" });
  assert.equal(await repo.playerGroups.removeMember(group.id, "76561198000000001"), true);
  assert.equal(await repo.playerGroups.removeMember(group.id, "76561198000000009"), false, "not listed: nothing to remove");

  const first = await repo.playerGroups.takeEvents(2);
  assert.deepEqual(first.map((e) => [e.kind, e.groupName, e.playerId]), [
    ["joined", "WW2 CVC", "76561198000000001"],
    ["joined", "Casters", "76561198000000002"],
  ], "oldest first, the re-add not counted, capped at the limit");
  assert.equal(first[0]!.playerName, "Ana");
  assert.deepEqual(first.map((e) => e.superseded), [true, false], "Ana's removal is queued behind her join");
  assert.deepEqual(await repo.playerGroups.takeEvents(50), [], "claimed: nobody else gets them, and Ana's removal waits behind her join");
  await repo.playerGroups.ackEvents(first.map((e) => e.id));
  const rest = await repo.playerGroups.takeEvents(50);
  assert.deepEqual(rest.map((e) => [e.kind, e.groupId, e.playerName]), [["left", group.id, "Ana B"]], "the removal names who it was");
  await repo.playerGroups.ackEvents(rest.map((e) => e.id));
  assert.deepEqual(await repo.playerGroups.takeEvents(50), [], "finished is gone");

  // Deleting a group is not a removal of its members.
  await repo.playerGroups.addMember({ groupId: other.id, playerId: "76561198000000003", playerName: "Cy", addedByName: "staff" });
  await repo.playerGroups.ackEvents((await repo.playerGroups.takeEvents(50)).map((e) => e.id));
  await repo.playerGroups.remove(other.id);
  assert.deepEqual(await repo.playerGroups.takeEvents(50), []);
}

test("group membership events: the memory store", async () => {
  await scenario(new InMemoryRepository());
});

test("group membership events: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await scenario(repo); } finally { await cleanup(); }
});

test("a member's game: the directory's word, a Steam64 is WW2, an unseen console id waits", () => {
  const gameOf = new Map([["0123456789abcdef0123456789abcdef", "hllv"]]);
  assert.equal(memberGameVerdict("76561198000000001", "hll", gameOf), "ok");
  assert.equal(memberGameVerdict("76561198000000001", "hllv", gameOf), "otherGame");
  assert.equal(memberGameVerdict("0123456789abcdef0123456789abcdef", "hllv", gameOf), "ok");
  assert.equal(memberGameVerdict("0123456789abcdef0123456789abcdef", "hll", gameOf), "otherGame");
  assert.equal(memberGameVerdict("fedcba9876543210fedcba9876543210", "hll", gameOf), "notSeen");
});

/** A scheduled rule's occurrence is claimed once, by whoever gets there first, and dies with its rule. */
async function claims(repo: Repository) {
  const rule = await repo.enforcerRules.create({ name: "Monthly VIP", eventKind: "app.schedule", action: "vip", params: { groupId: "g" } } as never);
  assert.equal(await repo.enforcerRules.claimOccurrence(rule.id, "2026-11"), true, "the first claim takes it");
  assert.equal(await repo.enforcerRules.claimOccurrence(rule.id, "2026-11"), false, "a second never does");
  const twins = await Promise.all([repo.enforcerRules.claimOccurrence(rule.id, "2026-12"), repo.enforcerRules.claimOccurrence(rule.id, "2026-12")]);
  assert.deepEqual(twins.filter(Boolean).length, 1, "two claims in the same instant: exactly one wins");
  await repo.enforcerRules.remove(rule.id);
  assert.equal(await repo.enforcerRules.claimOccurrence(rule.id, "2027-01"), false, "a deleted rule claims nothing");
  assert.equal(await repo.enforcerRules.claimOccurrence("00000000-0000-0000-0000-000000000000", "2027-01"), false);
}

test("scheduled rule claims: the memory store", async () => {
  await claims(new InMemoryRepository());
});

test("scheduled rule claims: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await claims(repo); } finally { await cleanup(); }
});

/**
 * Who listed a member travels with them; the sync's own add and removal land only while the group
 * still follows the role the sync read, and its removal takes only its own.
 */
async function sources(repo: Repository) {
  const ROLE = "900000000000000777";
  const group = await repo.playerGroups.create({ name: "Synced", createdByName: "staff" });
  const sync = (playerId: string, roleId = ROLE, groupId = group.id) =>
    repo.playerGroups.syncAddMember({ groupId, roleId, playerId, playerName: "Synced", addedByName: "discord-sync" });
  const unsync = (playerId: string, roleId = ROLE, groupId = group.id) => repo.playerGroups.syncRemoveMember({ groupId, roleId, playerId });

  assert.equal(await sync("76561198000000102"), false, "not linked: the sync adds nobody");
  assert.equal((await repo.playerGroups.setDiscordRole(group.id, ROLE))!.discordRoleId, ROLE);
  assert.equal(await sync("76561198000000102", "900000000000000778"), false, "linked to another role since the read");
  await repo.playerGroups.addMember({ groupId: group.id, playerId: "76561198000000101", playerName: "Hand", addedByName: "staff" });
  assert.equal(await sync("76561198000000101"), false, "already listed by a person: theirs, and not counted as an add");
  assert.equal(await sync("76561198000000102"), true);
  assert.equal(await sync("76561198000000102"), false, "listed already");
  // A person's re-add keeps who listed them first.
  await repo.playerGroups.addMember({ groupId: group.id, playerId: "76561198000000102", playerName: "Synced", addedByName: "staff" });
  const bySource = Object.fromEntries((await repo.playerGroups.members(group.id)).map((m) => [m.playerId, m.source]));
  assert.deepEqual(bySource, { "76561198000000101": "panel", "76561198000000102": "discord" });
  const joins = await repo.playerGroups.takeEvents(50);
  assert.deepEqual(joins.map((e) => [e.kind, e.playerId]), [
    ["joined", "76561198000000101"], ["joined", "76561198000000102"],
  ], "each real add queued its event once");
  await repo.playerGroups.ackEvents(joins.map((e) => e.id));

  assert.equal(await unsync("76561198000000101"), false, "a hand-added member is not the sync's to remove");
  assert.equal(await unsync("76561198000000102", "900000000000000778"), false, "the group follows another role now");
  assert.equal(await unsync("76561198000000102"), true);
  const left = await repo.playerGroups.takeEvents(50);
  assert.deepEqual(left.map((e) => [e.kind, e.playerId, e.groupName]), [["left", "76561198000000102", "Synced"]]);
  await repo.playerGroups.ackEvents(left.map((e) => e.id));

  await sync("76561198000000103");
  assert.equal((await repo.playerGroups.setDiscordRole(group.id, null))!.discordRoleId, null);
  assert.equal(await unsync("76561198000000103"), false, "unlinked since the read: the sync's members stay");
  assert.equal((await repo.playerGroups.members(group.id)).length, 2, "unlinking keeps every member");

  // A group deleted since the read: nothing added, nothing left behind, nothing thrown.
  const gone = await repo.playerGroups.create({ name: "Gone", createdByName: "staff" });
  await repo.playerGroups.setDiscordRole(gone.id, ROLE);
  await repo.playerGroups.remove(gone.id);
  assert.equal(await sync("76561198000000104", ROLE, gone.id), false);
  assert.deepEqual(await repo.playerGroups.members(gone.id), []);
  assert.deepEqual((await repo.playerGroups.groupsForPlayer("76561198000000104")), []);
}

test("membership sources: the memory store", async () => {
  await sources(new InMemoryRepository());
});

test("membership sources: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await sources(repo); } finally { await cleanup(); }
});

/**
 * A change waiting for its member: taken again only once due, for the rules still waiting, in its
 * member's order — a removal never overtakes the join it follows, even while another taker holds
 * the join — while other members' changes go on past it. A claim a dead taker left is dropped.
 */
async function waits(repo: Repository) {
  const group = await repo.playerGroups.create({ name: `Waits ${Math.random().toString(36).slice(2, 7)}`, createdByName: "staff" });
  const P = "fedcba9876543210fedcba98765432aa", Q = "76561198000000201";
  await repo.playerGroups.addMember({ groupId: group.id, playerId: P, playerName: "Xbox", addedByName: "staff" });
  await repo.playerGroups.removeMember(group.id, P);
  await repo.playerGroups.addMember({ groupId: group.id, playerId: Q, playerName: "Ana", addedByName: "staff" });

  const first = await repo.playerGroups.takeEvents(10);
  assert.deepEqual(first.map((e) => [e.playerId, e.kind, e.superseded]), [[P, "joined", true], [Q, "joined", false]], "P's removal waits behind P's join");
  assert.deepEqual([first[0]!.ruleIds, typeof first[0]!.notBefore], [null, "string"]);
  const join = first[0]!;
  await repo.playerGroups.ackEvents([first[1]!.id]);
  // Another taker meanwhile: P's join is claimed, so P's removal is not theirs to take.
  assert.deepEqual(await repo.playerGroups.takeEvents(10), []);

  // Put back for later: nothing of P's is taken meanwhile — not even the removal, which is due.
  await repo.playerGroups.deferEvent(join, new Date(Date.now() + 60_000).toISOString(), ["rule-a"]);
  await repo.playerGroups.addMember({ groupId: group.id, playerId: "76561198000000202", playerName: "Bob", addedByName: "staff" });
  const bob = await repo.playerGroups.takeEvents(10);
  assert.deepEqual(bob.map((e) => e.playerId), ["76561198000000202"], "another member goes on past it");
  await repo.playerGroups.ackEvents(bob.map((e) => e.id));

  // Due again (as if the wait were over): it comes first, as it was, for its rules only.
  await repo.playerGroups.deferEvent(join, new Date(Date.now() - 1000).toISOString(), ["rule-a"]);
  const back = await repo.playerGroups.takeEvents(10);
  assert.deepEqual(back.map((e) => [e.id, e.kind, e.ruleIds, e.createdAt, e.superseded]), [[join.id, "joined", ["rule-a"], join.createdAt, true]]);

  // Its taker dies holding it: after an hour the claim is dropped, never handed out twice.
  const memory = repo as unknown as { playerGroupEvents?: { id: string; claimedAt?: string | null }[] };
  if (memory.playerGroupEvents) { for (const e of memory.playerGroupEvents) if (e.id === join.id) e.claimedAt = new Date(Date.now() - 2 * 3_600_000).toISOString(); }
  else await (repo as unknown as { pool: { query: (q: string, v: unknown[]) => Promise<unknown> } }).pool.query("UPDATE player_group_events SET claimed_at = now() - interval '2 hours' WHERE id = $1", [join.id]);
  const after = await repo.playerGroups.takeEvents(10);
  assert.deepEqual(after.map((e) => [e.playerId, e.kind]), [[P, "left"]], "the join is gone; the removal goes on");
  await repo.playerGroups.ackEvents(after.map((e) => e.id));
  assert.deepEqual(await repo.playerGroups.takeEvents(10), []);
}

test("waiting membership changes: the memory store", async () => {
  await waits(new InMemoryRepository());
});

test("waiting membership changes: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await waits(repo); } finally { await cleanup(); }
});

/** A rules setup applied again keeps the rules it describes unchanged — ids, claims and all. */
async function reapply(repo: Repository) {
  const server = await repo.servers.create({ name: "setup test", host: "10.9.9.7", port: 9, password: "x" });
  const preset = getFeaturePreset("rules")!;
  const monthly = await repo.enforcerRules.create({ serverId: server.id, name: "Monthly VIP", eventKind: "app.schedule", action: "vip", vipMinutes: 60, params: { groupId: "00000000-0000-4000-8000-000000000001", repeat: "monthly", monthDay: 1, time: "00:00", stack: true } } as never);
  const tk = await repo.enforcerRules.create({ serverId: server.id, name: "TK warn", eventKind: "evt.player.teamkill", action: "message", reason: "careful" } as never);
  assert.equal(await repo.enforcerRules.claimOccurrence(monthly.id, "2026-11"), true);
  const config = await preset.snapshot(repo, server.id);

  await preset.apply(repo, server.id, config);
  const after = (await repo.enforcerRules.list()).filter((r) => r.serverId === server.id);
  assert.deepEqual(after.map((r) => r.id).sort(), [monthly.id, tk.id].sort(), "nothing deleted and made again");
  assert.equal(after.find((r) => r.id === monthly.id)!.updatedAt, monthly.updatedAt);
  assert.equal(await repo.enforcerRules.claimOccurrence(monthly.id, "2026-11"), false, "its claims kept");

  // A section's switch is not part of what a rule does: a setup saved while the section was off is
  // the same setup once it is back on, and a row that carries the switch anyway is read past it.
  const sec = await repo.ruleSections.create(`Setup section ${Math.random().toString(36).slice(2, 7)}`);
  await repo.enforcerRules.setSection([monthly.id], sec.id);
  await repo.ruleSections.setEnabled(sec.id, false);
  await repo.enforcerRules.setPause(tk.id, { until: new Date(Date.now() + 3_600_000).toISOString(), reason: "event", by: "staff" });
  const whileOff = await preset.snapshot(repo, server.id) as { rules: Record<string, unknown>[] };
  assert.ok(whileOff.rules.every((r) => !("sectionOff" in r)), "the section's switch is not saved into a setup");
  assert.ok(whileOff.rules.every((r) => !("pausedUntil" in r) && !("pauseReason" in r) && !("pausedBy" in r)), "nor is a pause");
  await repo.enforcerRules.setPause(tk.id, null);
  await repo.ruleSections.setEnabled(sec.id, true);
  await preset.apply(repo, server.id, { rules: whileOff.rules.map((r) => ({ ...r, sectionOff: true, pausedUntil: new Date(Date.now() + 3_600_000).toISOString(), pauseReason: "x", pausedBy: "y" })) });
  assert.deepEqual((await repo.enforcerRules.list()).filter((r) => r.serverId === server.id).map((r) => r.id).sort(), [monthly.id, tk.id].sort(),
    "kept, not deleted and made again");
  await repo.enforcerRules.setSection([monthly.id], null); // back as the first snapshot saw it

  // A rule the setup describes differently is replaced; the rest stay.
  const changed = { rules: (config as { rules: Record<string, unknown>[] }).rules.map((r) => (r.name === "TK warn" ? { ...r, reason: "stop" } : r)) };
  await preset.apply(repo, server.id, changed);
  const again = (await repo.enforcerRules.list()).filter((r) => r.serverId === server.id);
  assert.ok(again.some((r) => r.id === monthly.id), "the unchanged schedule stays");
  assert.ok(!again.some((r) => r.id === tk.id) && again.some((r) => r.name === "TK warn" && r.reason === "stop"), "the changed rule is replaced");
  assert.equal(again.length, 2);
}

test("rules setup re-applied: the memory store", async () => {
  await reapply(new InMemoryRepository());
});

test("rules setup re-applied: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await reapply(repo); } finally { await cleanup(); }
});
