import { test } from "node:test";
import assert from "node:assert/strict";
// dist, not src — the same reason repo.test.ts reads dist.
import { InMemoryRepository, bankIfHeld, createIsolatedRepository, rewardsRefusedBy } from "../dist/index.js";
import type { Repository } from "../src/types.ts";

/**
 * A group perk's hold on a VIP grant, asked of both stores: the grant turns permanent with its
 * timed VIP frozen into a balance, time granted meanwhile adds to that balance, ordinary writes
 * cannot date it, and only the perk's release (or a person granting permanent outright) ends it.
 */
const DAY = 86_400_000;
const near = (a: number, b: number, slackMs = 120_000) => Math.abs(a - b) <= slackMs;

async function scenario(repo: Repository) {
  const server = await repo.servers.create({ name: "hold test", host: "10.9.9.9", port: 9, password: "x" });
  const sid = server.id;
  const cvc = { id: "g-cvc", name: "WW2 CVC", severanceMinutes: 2 * 1440 };

  // A player with ten days of timed VIP joins: the grant turns permanent, the ten days freeze.
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000001", playerName: "Ana", expiration: new Date(Date.now() + 10 * DAY).toISOString(), createdByName: "staff" });
  const held = await repo.vips.startGroupHold({ serverId: sid, playerId: "76561198000000001", playerName: "Ana", groups: [cvc], createdByName: "group perks" });
  assert.ok(held, "held");
  assert.equal(held!.expiration, null, "permanent while held");
  assert.ok(near(held!.groupHold!.bankedMs, 10 * DAY), `ten days frozen (got ${held!.groupHold!.bankedMs})`);
  assert.deepEqual(held!.groupHold!.groups, [cvc]);

  // Nobody's VIP before: a fresh permanent grant with nothing banked.
  const fresh = await repo.vips.startGroupHold({ serverId: sid, playerId: "76561198000000002", playerName: "Bob", groups: [cvc], createdByName: "group perks" });
  assert.equal(fresh!.expiration, null);
  assert.equal(fresh!.groupHold!.bankedMs, 0);
  assert.match(fresh!.comment ?? "", /WW2 CVC/);

  // Permanent VIP the group did not give is the player's own: no hold, nothing changes.
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000003", playerName: "Cid", expiration: null, createdByName: "staff" });
  assert.equal(await repo.vips.startGroupHold({ serverId: sid, playerId: "76561198000000003", groups: [cvc], createdByName: "group perks" }), null);
  assert.equal((await repo.vips.get(sid, "76561198000000003"))!.groupHold, null);

  // An ordinary write cannot date a held grant — not even one that says it replaces a permanent.
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000001", expiration: new Date(Date.now() + DAY).toISOString(), createdByName: "importer", replacePermanent: true });
  const still = (await repo.vips.get(sid, "76561198000000001"))!;
  assert.equal(still.expiration, null);
  assert.ok(still.groupHold);

  // Time granted while held goes to the balance: added, or topped up to at least an amount.
  const banked = await repo.vips.bankGroupHold(sid, "76561198000000001", { addMs: 3 * DAY });
  assert.ok(near(banked!.groupHold!.bankedMs, 13 * DAY));
  const toppedNot = await repo.vips.bankGroupHold(sid, "76561198000000001", { atLeastMs: 5 * DAY });
  assert.ok(near(toppedNot!.groupHold!.bankedMs, 13 * DAY), "at-least never lowers the balance");
  const topped = await repo.vips.bankGroupHold(sid, "76561198000000002", { atLeastMs: 5 * DAY });
  assert.equal(topped!.groupHold!.bankedMs, 5 * DAY);
  assert.equal(await repo.vips.bankGroupHold(sid, "76561198000000003", { addMs: DAY }), null, "a grant nobody holds is not banked into");

  // A person can take VIP of the player's own back out of the balance — some of it or all of it —
  // and the group's permanent stands either way. Never below nothing.
  const trimmed = await repo.vips.cutGroupHold(sid, "76561198000000002", { cutMs: 2 * DAY });
  assert.equal(trimmed!.removedMs, 2 * DAY);
  assert.equal(trimmed!.row.groupHold!.bankedMs, 3 * DAY);
  assert.equal(trimmed!.row.expiration, null, "still permanent: the group's VIP is not what was cut");
  assert.deepEqual(trimmed!.row.groupHold!.groups, [cvc]);
  const overdrawn = await repo.vips.cutGroupHold(sid, "76561198000000002", { cutMs: 10 * DAY });
  assert.equal(overdrawn!.removedMs, 3 * DAY, "only what was there comes off");
  assert.equal(overdrawn!.row.groupHold!.bankedMs, 0);
  await repo.vips.bankGroupHold(sid, "76561198000000002", { addMs: DAY });
  const cleared = await repo.vips.cutGroupHold(sid, "76561198000000002", { all: true });
  assert.equal(cleared!.removedMs, DAY);
  assert.equal(cleared!.row.groupHold!.bankedMs, 0);
  assert.ok((await repo.vips.get(sid, "76561198000000002"))!.groupHold, "still held");
  assert.equal(await repo.vips.cutGroupHold(sid, "76561198000000003", { all: true }), null, "a grant nobody holds is not cut");

  // The sources a hold remembers can be refreshed; a group ended without severance is recorded at 0.
  await repo.vips.setGroupHoldSources(sid, "76561198000000001", [cvc, { id: "g-streamers", name: "Streamers", severanceMinutes: 60 }]);
  assert.equal(await repo.vips.setGroupSeverance("g-cvc", 0), 2);
  const zeroed = (await repo.vips.get(sid, "76561198000000001"))!.groupHold!.groups;
  assert.deepEqual(zeroed.map((g) => [g.id, g.severanceMinutes]), [["g-cvc", 0], ["g-streamers", 60]]);

  // The holds are listable, the permanent player's own grant is not among them.
  assert.deepEqual((await repo.vips.groupHeld()).filter((v) => v.serverId === sid).map((v) => v.playerId).sort(), ["76561198000000001", "76561198000000002"]);
  // Held grants never expire (they are permanent) — the expiry sweep cannot see them.
  assert.ok(!(await repo.vips.expired(new Date(Date.now() + 365 * DAY).toISOString())).some((v) => v.serverId === sid && v.groupHold));

  // Release: dated again at the frozen balance (plus whatever severance the perk works out). A
  // release planned on numbers that have moved since — time banked meanwhile, a severance zeroed —
  // does nothing, and the next round plans again with the numbers as they are.
  const until = new Date(Date.now() + 13 * DAY).toISOString();
  const nowHold = (await repo.vips.get(sid, "76561198000000001"))!.groupHold!;
  assert.equal(await repo.vips.endGroupHold(sid, "76561198000000001", until, { bankedMs: nowHold.bankedMs - DAY, severanceMinutes: 60 }), null, "the balance moved");
  assert.equal(await repo.vips.endGroupHold(sid, "76561198000000001", until, { bankedMs: nowHold.bankedMs, severanceMinutes: 2880 }), null, "the severance moved");
  assert.ok((await repo.vips.get(sid, "76561198000000001"))!.groupHold, "still held after both refusals");
  const released = await repo.vips.endGroupHold(sid, "76561198000000001", until, { bankedMs: nowHold.bankedMs, severanceMinutes: 60 });
  assert.equal(released!.groupHold, null);
  assert.equal(Date.parse(released!.expiration!), Date.parse(until));
  assert.equal(await repo.vips.endGroupHold(sid, "76561198000000001", until), null, "ending twice ends nothing");

  // A person granting permanent outright takes the grant over: the hold is dropped.
  const mine = await repo.vips.upsert({ serverId: sid, playerId: "76561198000000002", expiration: null, createdByName: "staff", endsGroupHold: true });
  assert.equal(mine.expiration, null);
  assert.equal(mine.groupHold, null);

  // A banked pause froze its meter at its start: a hold begun mid-pause banks from the pause's start.
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000004", expiration: new Date(Date.now() + 4 * DAY).toISOString(), createdByName: "staff" });
  await repo.vips.setPause(sid, "76561198000000004", { until: new Date(Date.now() + DAY).toISOString(), reason: "timeout", by: "staff", mode: "banked", at: new Date(Date.now() - DAY).toISOString() });
  const pausedHold = await repo.vips.startGroupHold({ serverId: sid, playerId: "76561198000000004", groups: [cvc], createdByName: "group perks" });
  assert.ok(near(pausedHold!.groupHold!.bankedMs, 5 * DAY), `the paused day is not lost (got ${pausedHold!.groupHold!.bankedMs})`);
  assert.ok(pausedHold!.pausedUntil, "the timeout itself is untouched");

  // The perk itself rides on the group.
  const group = await repo.playerGroups.create({ name: `perk group ${Math.random().toString(36).slice(2, 7)}`, createdByName: "staff" });
  assert.equal(group.vipPerk, null);
  const withPerk = await repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "servers", serverIds: [sid] }, severanceMinutes: 2880 });
  // A perk saved without the rewards switch — every perk from before it — reads back with rewards on.
  assert.deepEqual(withPerk!.vipPerk, { game: "hll", scope: { mode: "servers", serverIds: [sid] }, severanceMinutes: 2880, bankRewards: true });
  assert.deepEqual((await repo.playerGroups.list()).find((g) => g.id === group.id)!.vipPerk, withPerk!.vipPerk);
  const noRewards = await repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false });
  assert.equal(noRewards!.vipPerk!.bankRewards, false);
  assert.equal((await repo.playerGroups.get(group.id))!.vipPerk!.bankRewards, false, "and keeps it");
  assert.equal((await repo.playerGroups.setVipPerk(group.id, null))!.vipPerk, null);
}

/**
 * The perk's rewards switch, asked of both stores through the one helper every time grant uses: a
 * reward on a grant held by a group that takes none banks nothing and comes back as the held
 * (permanent) grant, which every caller's "already permanent" path answers; a person's grant still
 * banks; one refusing group among those holding decides; a group gone or switched off refuses nothing.
 */
async function rewardSwitch(repo: Repository) {
  const server = await repo.servers.create({ name: "reward switch", host: "10.9.9.5", port: 9, password: "x" });
  const sid = server.id;
  const tag = Math.random().toString(36).slice(2, 7);
  const takes = await repo.playerGroups.create({ name: `Donors ${tag}`, createdByName: "staff" });
  await repo.playerGroups.setVipPerk(takes.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: true });
  const refuses = await repo.playerGroups.create({ name: `Staff ${tag}`, createdByName: "staff" });
  await repo.playerGroups.setVipPerk(refuses.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false });
  const src = (g: { id: string; name: string }) => ({ id: g.id, name: g.name, severanceMinutes: 0 });
  const hold = (playerId: string, groups: { id: string; name: string }[]) =>
    repo.vips.startGroupHold({ serverId: sid, playerId, groups: groups.map(src), createdByName: "group perks" });
  const bankedOf = async (playerId: string) => (await repo.vips.get(sid, playerId))!.groupHold!.bankedMs;
  const reward = (playerId: string) => bankIfHeld(repo, sid, playerId, { addMs: DAY }, { reward: true });

  // A group that takes rewards: the day banks, as it always did.
  await hold("76561198000000041", [takes]);
  const banked = await reward("76561198000000041");
  assert.equal(banked.banked?.groupHold?.bankedMs, DAY);
  assert.deepEqual(await rewardsRefusedBy(repo, banked.banked!.groupHold!), []);

  // A group that takes none: nothing banked; the held grant comes back, permanent, with the group named.
  await hold("76561198000000042", [refuses]);
  const refused = await reward("76561198000000042");
  assert.equal(refused.banked, undefined);
  assert.equal(refused.existing?.expiration, null, "the held grant, permanent — the caller's own permanent path answers it");
  assert.ok(refused.existing?.groupHold, "still held");
  assert.deepEqual(refused.refusedBy, [refuses.name]);
  assert.equal(await bankedOf("76561198000000042"), 0, "nothing frozen for later");
  // A person's grant is not a reward: it still banks.
  assert.equal((await bankIfHeld(repo, sid, "76561198000000042", { addMs: DAY })).banked?.groupHold?.bankedMs, DAY);

  // Held by both: the one refusing decides.
  await hold("76561198000000043", [takes, refuses]);
  assert.deepEqual((await reward("76561198000000043")).refusedBy, [refuses.name]);
  assert.equal(await bankedOf("76561198000000043"), 0);

  // Switched back on, rewards bank again — nothing refused meanwhile is owed.
  await repo.playerGroups.setVipPerk(refuses.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: true });
  assert.equal((await reward("76561198000000042")).banked?.groupHold?.bankedMs, 2 * DAY);
  // A group whose perk is gone, or that is gone itself, is releasing the hold: it refuses nothing.
  await repo.playerGroups.setVipPerk(refuses.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false });
  await repo.playerGroups.setVipPerk(refuses.id, null);
  assert.deepEqual(await rewardsRefusedBy(repo, (await repo.vips.get(sid, "76561198000000042"))!.groupHold!), []);
  assert.deepEqual(await rewardsRefusedBy(repo, { since: new Date().toISOString(), bankedMs: 0, groups: [{ id: "a-group-long-gone", name: "Gone", severanceMinutes: 0 }] }), []);
}

/**
 * The races around a hold, asked of both stores: a dated write that read the row before the hold
 * began is banked (never lost, never cutting frozen time); a refresh planned on numbers that moved
 * — or on a perk switched off or changed since — does nothing; the expiry sweep and a schedule's
 * revoke delete only what they meant to.
 */
async function races(repo: Repository) {
  const server = await repo.servers.create({ name: "race test", host: "10.9.9.8", port: 9, password: "x" });
  const sid = server.id;
  const g = await repo.playerGroups.create({ name: `race group ${Math.random().toString(36).slice(2, 7)}`, createdByName: "staff" });
  await repo.playerGroups.setVipPerk(g.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 60 });
  const src = { id: g.id, name: g.name, severanceMinutes: 60 };
  await repo.vips.startGroupHold({ serverId: sid, playerId: "76561198000000011", groups: [src], createdByName: "group perks" });

  // A grant that read the row before the hold began: its time goes to the frozen balance…
  const late = await repo.vips.upsert({ serverId: sid, playerId: "76561198000000011", expiration: new Date(Date.now() + 20 * DAY).toISOString(), createdByName: "shop" });
  assert.equal(late.expiration, null, "still permanent while held");
  assert.ok(near(late.groupHold!.bankedMs, 20 * DAY), `banked (got ${late.groupHold!.bankedMs})`);
  // …and a cut that read it before the hold never reaches frozen time.
  const cut = await repo.vips.upsert({ serverId: sid, playerId: "76561198000000011", expiration: new Date(Date.now() + 2 * DAY).toISOString(), createdByName: "schedule" });
  assert.ok(near(cut.groupHold!.bankedMs, 20 * DAY), "the larger stands");

  // A refresh planned on what the hold remembered, against the perk as configured now.
  const pid = "76561198000000011";
  assert.equal(await repo.vips.setGroupHoldSources(sid, pid, [{ ...src, name: "renamed" }], [{ ...src, severanceMinutes: 30 }]), null, "the hold moved since the read");
  assert.equal(await repo.vips.setGroupHoldSources(sid, pid, [{ ...src, severanceMinutes: 90 }], [src]), null, "the perk is not set to that severance");
  assert.equal((await repo.vips.setGroupHoldSources(sid, pid, [{ ...src, name: "renamed" }], [src]))!.groupHold!.groups[0]!.name, "renamed");
  // A person decides the severance as the perk ends: recorded at once, and an older plan cannot undo it.
  assert.equal(await repo.vips.setGroupSeverance(g.id, 0), 1);
  await repo.playerGroups.setVipPerk(g.id, null);
  assert.equal(await repo.vips.setGroupHoldSources(sid, pid, [src], [{ ...src, severanceMinutes: 0 }]), null, "the perk is gone");
  assert.equal((await repo.vips.get(sid, pid))!.groupHold!.groups[0]!.severanceMinutes, 0);

  // The sweep's delete: only a row still past its date, and not one a perk holds.
  const past = new Date(Date.now() - DAY).toISOString();
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000012", expiration: past, createdByName: "staff" });
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000013", expiration: new Date(Date.now() + DAY).toISOString(), createdByName: "staff" });
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000014", expiration: null, createdByName: "staff" });
  assert.equal(await repo.vips.removeExpired(sid, "76561198000000013"), false, "extended since the read");
  assert.equal(await repo.vips.removeExpired(sid, pid), false, "held");
  assert.equal(await repo.vips.removeExpired(sid, "76561198000000014"), false, "permanent");
  assert.equal(await repo.vips.removeExpired(sid, "76561198000000012"), true);
  // A schedule's revoke: only timed VIP.
  assert.equal(await repo.vips.removeTimed(sid, pid), false, "held");
  assert.equal(await repo.vips.removeTimed(sid, "76561198000000014"), false, "permanent");
  assert.equal(await repo.vips.removeTimed(sid, "76561198000000013"), true);
  assert.deepEqual((await repo.vips.list(sid)).map((v) => v.playerId).sort(), [pid, "76561198000000014"]);

  // A schedule's cut moves only a timed grant still there: not a held one, a permanent one, or
  // one removed since.
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000015", expiration: new Date(Date.now() + 9 * DAY).toISOString(), createdByName: "staff" });
  const cutTo = new Date(Date.now() + 3 * DAY).toISOString();
  assert.equal((await repo.vips.updateTimedExpiration(sid, "76561198000000015", cutTo))!.expiration, cutTo);
  assert.equal(await repo.vips.updateTimedExpiration(sid, pid, cutTo), null, "held");
  assert.equal(await repo.vips.updateTimedExpiration(sid, "76561198000000014", cutTo), null, "permanent");
  assert.equal(await repo.vips.updateTimedExpiration(sid, "76561198000000099", cutTo), null, "gone");
  assert.equal(await repo.vips.get(sid, "76561198000000099"), null, "nothing made");

  // A read is a copy: a write after it never changes what the reader holds.
  const read = (await repo.vips.get(sid, "76561198000000015"))!;
  await repo.vips.startGroupHold({ serverId: sid, playerId: "76561198000000015", groups: [], createdByName: "group perks" });
  assert.equal(read.groupHold, null);
  assert.equal(read.expiration, cutTo);

  // A person's permanent grant reports the hold it ended — one begun after their read included.
  const took = await repo.vips.upsert({ serverId: sid, playerId: "76561198000000015", expiration: null, createdByName: "staff", endsGroupHold: true });
  assert.ok(took.endedHold, "the hold it ended");
  assert.equal(took.groupHold, null);
  assert.equal((await repo.vips.upsert({ serverId: sid, playerId: "76561198000000015", expiration: null, createdByName: "staff", endsGroupHold: true })).endedHold ?? null, null, "nothing to end the second time");

  // Under a banked VIP timeout the grant's clock stopped when it began: a late dated write is
  // banked from there; the timeout's end (already measured from now) is not counted twice.
  const pausedAt = new Date(Date.now() - 2 * DAY).toISOString();
  const frozenExp = new Date(Date.now() + 8 * DAY).toISOString(); // ten days left when the timeout began
  await repo.vips.upsert({ serverId: sid, playerId: "76561198000000016", expiration: frozenExp, createdByName: "staff" });
  await repo.vips.setPause(sid, "76561198000000016", { until: new Date(Date.now() + DAY).toISOString(), reason: "timeout", by: "staff", mode: "banked", at: pausedAt });
  const h = await repo.vips.startGroupHold({ serverId: sid, playerId: "76561198000000016", groups: [src], createdByName: "group perks" });
  assert.ok(near(h!.groupHold!.bankedMs, 10 * DAY), "ten days frozen at the hold");
  const stacked = await repo.vips.upsert({ serverId: sid, playerId: "76561198000000016", expiration: new Date(Date.parse(frozenExp) + DAY).toISOString(), createdByName: "shop" });
  assert.ok(near(stacked.groupHold!.bankedMs, 11 * DAY), `a day stacked on the frozen clock is a day (got ${stacked.groupHold!.bankedMs / DAY})`);
  const thawed = await repo.vips.upsert({ serverId: sid, playerId: "76561198000000016", expiration: new Date(Date.now() + 10 * DAY).toISOString(), createdByName: "staff", thawsPause: true });
  assert.ok(near(thawed.groupHold!.bankedMs, 11 * DAY), "the timeout's end gives back nothing new");
}

/** A hold begins only while every group naming it still carries its perk at that severance. */
async function whilePerks(repo: Repository) {
  const server = await repo.servers.create({ name: "perk check", host: "10.9.9.6", port: 9, password: "x" });
  const g = await repo.playerGroups.create({ name: `perk check ${Math.random().toString(36).slice(2, 7)}`, createdByName: "staff" });
  await repo.playerGroups.setVipPerk(g.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 120 });
  const start = (playerId: string, severanceMinutes: number) => repo.vips.startGroupHold({ serverId: server.id, playerId, groups: [{ id: g.id, name: g.name, severanceMinutes }], createdByName: "group perks", whilePerks: true });
  assert.equal(await start("76561198000000031", 60), null, "planned on another severance");
  assert.ok((await start("76561198000000031", 120))?.groupHold, "as the perk stands");
  await repo.playerGroups.setVipPerk(g.id, null);
  assert.equal(await start("76561198000000032", 120), null, "switched off since the plan");
  assert.equal(await repo.vips.get(server.id, "76561198000000032"), null, "and nothing made");
}

test("group hold perk check: the memory store", async () => {
  await whilePerks(new InMemoryRepository());
});

test("a perk's rewards switch: the memory store", async () => {
  await rewardSwitch(new InMemoryRepository());
});

test("a perk's rewards switch: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await rewardSwitch(repo); } finally { await cleanup(); }
});

test("group hold perk check: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await whilePerks(repo); } finally { await cleanup(); }
});

test("group holds: the memory store", async () => {
  await scenario(new InMemoryRepository());
});

test("group hold races: the memory store", async () => {
  await races(new InMemoryRepository());
});

test("group hold races: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await races(repo); } finally { await cleanup(); }
});

test("group holds: the Postgres store", { skip: !process.env.DATABASE_URL }, async () => {
  const { repo, cleanup } = await createIsolatedRepository();
  try { await scenario(repo); } finally { await cleanup(); }
});
