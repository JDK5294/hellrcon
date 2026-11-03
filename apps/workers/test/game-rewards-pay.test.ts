/**
 * Game rewards' pay path end to end on the in-memory store and a fake game client: VIP + points +
 * the message, once only; paid permanent VIP untouched; dry-run pays nothing; top stats at a match
 * end; a day streak's tiers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository, GAME_REWARDS_DEFAULTS } from "@app/db";
import { combineParts, MESSAGE_SCREEN, payGameReward, reconnecting, screenLines, rewardDayStreak, rewardMatchEnd, rewardMatchEnded, rewardSeedDay, rewardTopStats, gameRewardsCache } from "../dist/game-rewards-pay.js";

const slog = { info() {}, warn() {}, debug() {}, error() {}, child() { return slog; } } as never;
function fakeClient(roster: { iD: string; name: string }[] = []) {
  const calls: { cmd: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    execute: async (cmd: string, params: Record<string, unknown>) => { calls.push({ cmd, params }); return null; },
    readState: async (kind: string) => (kind === "players" ? { players: roster } : null),
  };
}
async function world() {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "WW2", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, "active");
  const live = (await repo.servers.findById(server.id))!;
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000901", name: "Ace" });
  await repo.externalLinks.set(player.id, "discord", "d-901", "registration");
  gameRewardsCache.clear();
  return { repo, server: live, player };
}
const pay = (over: Record<string, unknown> = {}) => ({
  kind: "killStreak", ref: "streak:x:1:10", platformId: "76561198000000901", name: "Ace",
  reward: { vipHours: 24, points: 50 }, dryRun: false,
  message: "{streak} kills — you got {reward}, VIP until {vip_until}", vars: { streak: 10 }, what: "10-kill streak", ...over,
});

test("a live reward grants VIP, credits points and tells the player — exactly once", async () => {
  const { repo, server } = await world();
  const client = fakeClient();
  await payGameReward(repo, server, client, slog, pay() as never);
  const vip = await repo.vips.get(server.id, "76561198000000901");
  assert.ok(vip?.expiration && Date.parse(vip.expiration) > Date.now() + 23 * 3_600_000, "a day of VIP");
  assert.ok(client.calls.some((c) => c.cmd === "addVip"), "the game was told");
  assert.equal((await repo.economy.member("d-901"))?.balance, 50);
  const msg = client.calls.find((c) => c.cmd === "messagePlayer")!.params.message as string;
  assert.match(msg, /^10 kills — you got 1d of VIP and 50 Points, VIP until /);
  assert.doesNotMatch(msg, /\{/);

  await payGameReward(repo, server, client, slog, pay() as never);
  assert.equal(client.calls.filter((c) => c.cmd === "addVip").length, 1, "the same reward is never paid twice");
  assert.equal((await repo.economy.member("d-901"))?.balance, 50);
});

test("a paid permanent VIP is never touched — they are thanked instead", async () => {
  const { repo, server } = await world();
  await repo.vips.upsert({ serverId: server.id, playerId: "76561198000000901", expiration: null } as never);
  const client = fakeClient();
  await payGameReward(repo, server, client, slog, pay({ reward: { vipHours: 24, points: 0 }, message: "you got {reward}" }) as never);
  assert.equal((await repo.vips.get(server.id, "76561198000000901"))!.expiration, null);
  assert.equal(client.calls.filter((c) => c.cmd === "addVip").length, 0);
  assert.match(client.calls.find((c) => c.cmd === "messagePlayer")!.params.message as string, /already permanent/);
});

test("a group perk taking no rewards: its member is thanked like a permanent VIP and nothing banks; one taking them banks the hours", async () => {
  const { repo, server } = await world();
  const group = await repo.playerGroups.create({ name: "Staff", createdByName: "staff" });
  await repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false });
  await repo.vips.startGroupHold({ serverId: server.id, playerId: "76561198000000901", playerName: "Ace", groups: [{ id: group.id, name: "Staff", severanceMinutes: 0 }], createdByName: "group perks" });
  const client = fakeClient();
  await payGameReward(repo, server, client, slog, pay({ reward: { vipHours: 24, points: 0 }, message: "you got {reward}" }) as never);
  const held = (await repo.vips.get(server.id, "76561198000000901"))!;
  assert.equal(held.expiration, null, "the group's permanent VIP stands");
  assert.equal(held.groupHold!.bankedMs, 0, "nothing frozen for later");
  assert.equal(client.calls.filter((c) => c.cmd === "addVip").length, 0);
  assert.match(client.calls.find((c) => c.cmd === "messagePlayer")!.params.message as string, /already permanent/);
  const receipt = (await repo.audit.list({ actions: ["game.reward"] }))[0]!;
  assert.match(String((receipt.data as { vipSkipped?: string }).vipSkipped), /permanent VIP from group "Staff", whose perk takes no rewards/);

  await repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: true });
  await payGameReward(repo, server, client, slog, pay({ ref: "streak:x:1:20", reward: { vipHours: 24, points: 0 }, message: "you got {reward}" }) as never);
  assert.equal((await repo.vips.get(server.id, "76561198000000901"))!.groupHold!.bankedMs, 24 * 3_600_000, "a group taking rewards banks them");
});

test("dry run records what it would pay and pays nothing", async () => {
  const { repo, server } = await world();
  const client = fakeClient();
  await payGameReward(repo, server, client, slog, pay({ dryRun: true }) as never);
  assert.equal(client.calls.length, 0, "nothing sent to the game");
  assert.equal(await repo.vips.get(server.id, "76561198000000901"), null);
  const audit = await repo.audit.list({ actions: ["game.reward"] });
  assert.match(audit[0]!.summary, /^\[dry-run\] would reward Ace with 1d of VIP and 50 Points/);
});

test("top stats at a match end: the winner is paid, and the winners are broadcast", async () => {
  const { repo, server, player } = await world();
  const other = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000902", name: "Bee" });
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    topStats: { ...GAME_REWARDS_DEFAULTS.topStats, enabled: true, dryRun: false, minPlayers: 2, minMinutes: 0,
      categories: GAME_REWARDS_DEFAULTS.topStats.categories.map((c) => ({ ...c, enabled: c.id === "kills", ranks: [{ vipHours: 0, points: 30 }] })) },
  });
  const m = await repo.matches.open({ serverId: server.id, map: "carentan_warfare", startedAt: new Date(Date.now() - 3_600_000).toISOString() });
  await repo.matches.bumpStat({ matchId: m.id, playerId: player.id, serverId: server.id, playerName: "Ace", kills: 30 });
  await repo.matches.bumpStat({ matchId: m.id, playerId: other.id, serverId: server.id, playerName: "Bee", kills: 12 });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: "allies", alliedScore: 5, axisScore: 0, result: null });
  const client = fakeClient();
  await rewardTopStats(repo, server, client, slog, endedAt);
  assert.equal((await repo.economy.member("d-901"))?.balance, 30, "Ace, top kills, paid");
  assert.match(client.calls.find((c) => c.cmd === "broadcast")!.params.message as string, /kills: Ace \(30\)/);
  await rewardTopStats(repo, server, client, slog, endedAt);
  assert.equal((await repo.economy.member("d-901"))?.balance, 30, "a re-read match end pays nothing more");
});

test("days played in a row: tier 3 is paid on the third day, once", async () => {
  const { repo, server } = await world();
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    playDays: { ...GAME_REWARDS_DEFAULTS.playDays, enabled: true, dryRun: false, minMinutes: 30, tiers: [{ days: 3, reward: { vipHours: 0, points: 70 } }], repeatEveryDays: 0 },
  });
  for (const day of ["2026-09-24", "2026-09-25", "2026-09-26"]) {
    await repo.gameRewards.addDaySeconds(server.id, "play", day, [{ playerId: "76561198000000901", seconds: 1800 }]);
  }
  const client = fakeClient();
  await rewardDayStreak(repo, server, client, slog, "play", "76561198000000901", "Ace", "2026-09-26");
  await rewardDayStreak(repo, server, client, slog, "play", "76561198000000901", "Ace", "2026-09-26");
  assert.equal((await repo.economy.member("d-901"))?.balance, 70, "paid once");
  assert.match(client.calls.find((c) => c.cmd === "messagePlayer")!.params.message as string, /^3 days in a row/);
});

test("top stats: a category's own message, filled with the winner's own match numbers", async () => {
  const { repo, server, player } = await world();
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    topStats: { ...GAME_REWARDS_DEFAULTS.topStats, enabled: true, dryRun: false, minPlayers: 1, minMinutes: 0, broadcast: false,
      categories: GAME_REWARDS_DEFAULTS.topStats.categories.map((c) => ({ ...c, enabled: c.id === "kills", ranks: [{ vipHours: 0, points: 5 }],
        ...(c.id === "kills" ? { message: "{player_name}: {kills} kills, {deaths} deaths ({kd}) on {map} — {reward}" } : {}) })) },
  });
  const m = await repo.matches.open({ serverId: server.id, map: "carentan_warfare", startedAt: new Date(Date.now() - 3_600_000).toISOString() });
  await repo.matches.bumpStat({ matchId: m.id, playerId: player.id, serverId: server.id, playerName: "Ace", kills: 12, deaths: 4 });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: null, alliedScore: null, axisScore: null, result: null });
  const client = fakeClient();
  await rewardTopStats(repo, server, client, slog, endedAt);
  assert.equal(client.calls.find((c) => c.cmd === "messagePlayer")!.params.message, "Ace: 12 kills, 4 deaths (3.00) on Carentan — Warfare — 5 Points");
});

test("a stray old match-end line never reaches back to reward a later round", async () => {
  const { repo, server, player } = await world();
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    topStats: { ...GAME_REWARDS_DEFAULTS.topStats, enabled: true, dryRun: false, minPlayers: 1, minMinutes: 0 },
  });
  const m = await repo.matches.open({ serverId: server.id, map: "foy_warfare", startedAt: new Date(Date.now() - 3_600_000).toISOString() });
  await repo.matches.bumpStat({ matchId: m.id, playerId: player.id, serverId: server.id, playerName: "Ace", kills: 20 });
  await repo.matches.close(m.id, { endedAt: new Date().toISOString(), winner: null, alliedScore: null, axisScore: null, result: null });
  const client = fakeClient();
  await rewardTopStats(repo, server, client, slog, new Date(Date.now() - 2 * 3_600_000).toISOString()); // a whistle from hours ago
  assert.equal(client.calls.length, 0);
  assert.equal(await repo.economy.member("d-901"), null);
});

test("a seed payout made the next day (pay-last) counts for the day it was earned", async () => {
  const { repo, server } = await world();
  await repo.gameRewards.setConfig(server.id, { ...GAME_REWARDS_DEFAULTS, seedDays: { ...GAME_REWARDS_DEFAULTS.seedDays, enabled: true } });
  const yesterday = Date.now() - 86_400_000;
  await rewardSeedDay(repo, server, fakeClient(), slog, "76561198000000901", "Ace", yesterday);
  const days = await repo.gameRewards.days(server.id, "76561198000000901", "seed", "2000-01-01");
  assert.equal(days.length, 1);
  assert.equal(days[0]!.day, new Date(yesterday).toISOString().slice(0, 10), "yesterday, not today");
});

/*
 * A server whose Auto settings were never saved counted seeding days on UTC: seeding at 10pm in New
 * York landed on the next day. Its days are the community's.
 */
test("a seeding day is the community's day on a server with no zone of its own", async () => {
  const { repo, server } = await world();
  await repo.gameRewards.setConfig(server.id, { ...GAME_REWARDS_DEFAULTS, seedDays: { ...GAME_REWARDS_DEFAULTS.seedDays, enabled: true } });
  await repo.appConfig.set({ timezone: "America/New_York" });
  // 02:00 UTC on the 24th is 10pm on the 23rd in New York.
  await rewardSeedDay(repo, server, fakeClient(), slog, "76561198000000901", "Ace", Date.parse("2026-10-24T02:00:00Z"));
  const days = await repo.gameRewards.days(server.id, "76561198000000901", "seed", "2000-01-01");
  assert.deepEqual(days.map((d) => d.day), ["2026-10-23"]);
});

test("everyone at match end: every player on after an hour-plus match gets the day — once", async () => {
  const { repo, server } = await world();
  await repo.vips.upsert({ serverId: server.id, playerId: "76561198000000903", expiration: null } as never); // paid permanent
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    matchEnd: { ...GAME_REWARDS_DEFAULTS.matchEnd, enabled: true, dryRun: false, message: "Thanks {player_name}! {reward} for a {match_minutes}-minute match. VIP until {vip_until}." },
  });
  const m = await repo.matches.open({ serverId: server.id, map: "stmereeglise_warfare", startedAt: new Date(Date.now() - 70 * 60_000).toISOString() });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: null, alliedScore: null, axisScore: null, result: null });
  const client = fakeClient([{ iD: "76561198000000901", name: "Ace" }, { iD: "76561198000000902", name: "Bee" }, { iD: "76561198000000903", name: "Paid" }]);
  await rewardMatchEnd(repo, server, client, slog, endedAt);

  for (const id of ["76561198000000901", "76561198000000902"]) {
    const v = await repo.vips.get(server.id, id);
    assert.ok(v?.expiration && Date.parse(v.expiration) > Date.now() + 23 * 3_600_000, `${id} got a day`);
  }
  assert.equal((await repo.vips.get(server.id, "76561198000000903"))!.expiration, null, "paid permanent untouched");
  const msgs = client.calls.filter((c) => c.cmd === "messagePlayer");
  assert.equal(msgs.length, 3, "everyone is told");
  assert.match(msgs[0]!.params.message as string, /^Thanks Ace! 1d of VIP for a 70-minute match\. VIP until /);
  assert.match(msgs[2]!.params.message as string, /already permanent/);

  await rewardMatchEnd(repo, server, client, slog, endedAt);
  assert.equal(client.calls.filter((c) => c.cmd === "addVip").length, 2, "a re-read match end pays nobody twice");
});

test("everyone at match end: a match shorter than the minimum pays nothing", async () => {
  const { repo, server } = await world();
  await repo.gameRewards.setConfig(server.id, { ...GAME_REWARDS_DEFAULTS, matchEnd: { ...GAME_REWARDS_DEFAULTS.matchEnd, enabled: true, dryRun: false } });
  const m = await repo.matches.open({ serverId: server.id, map: "foy_warfare", startedAt: new Date(Date.now() - 40 * 60_000).toISOString() });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: null, alliedScore: null, axisScore: null, result: null });
  const client = fakeClient([{ iD: "76561198000000901", name: "Ace" }]);
  await rewardMatchEnd(repo, server, client, slog, endedAt);
  assert.equal(client.calls.length, 0);
});

test("everyone at match end read late: the players at the whistle are paid, not the next match's", async () => {
  const { repo, server, player } = await world();
  await repo.gameRewards.setConfig(server.id, { ...GAME_REWARDS_DEFAULTS, matchEnd: { ...GAME_REWARDS_DEFAULTS.matchEnd, enabled: true, dryRun: false, minPlayers: 1 } });
  const endedMs = Date.now() - 20 * 60_000; // backfilled after a restart: the whistle was 20 minutes ago
  const m = await repo.matches.open({ serverId: server.id, map: "foy_warfare", startedAt: new Date(endedMs - 70 * 60_000).toISOString() });
  await repo.sessions.open(player.id, server.id, new Date(endedMs - 60 * 60_000).toISOString());
  await repo.matches.bumpStat({ matchId: m.id, playerId: player.id, serverId: server.id, playerName: "Ace", kills: 3 });
  const endedAt = new Date(endedMs).toISOString();
  await repo.matches.close(m.id, { endedAt, winner: null, alliedScore: null, axisScore: null, result: null });
  await repo.stats.settleMatch(m.id, null);
  // The roster now is the NEXT match: Bee joined after the whistle.
  const client = fakeClient([{ iD: "76561198000000902", name: "Bee" }]);
  await rewardMatchEnd(repo, server, client, slog, endedAt);
  assert.equal(await repo.vips.get(server.id, "76561198000000902"), null, "Bee was not in that match");
  assert.ok((await repo.vips.get(server.id, "76561198000000901"))?.expiration, "Ace, on at the whistle, is paid");
});

test("a reward on top of existing VIP keeps that VIP's note (a paid receipt stays readable)", async () => {
  const { repo, server } = await world();
  const inTen = new Date(Date.now() + 10 * 86_400_000).toISOString();
  await repo.vips.upsert({ serverId: server.id, playerId: "76561198000000901", comment: "paid $5 — receipt 4411", expiration: inTen } as never);
  await payGameReward(repo, server, fakeClient() as never, slog, pay() as never);
  const v = (await repo.vips.get(server.id, "76561198000000901"))!;
  assert.equal(v.comment, "paid $5 — receipt 4411");
  assert.ok(Date.parse(v.expiration!) > Date.parse(inTen), "and the reward still stacked on");
});

test("a streak longer than the days read back is not re-paid every day", async () => {
  const { repo, server } = await world();
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    playDays: { ...GAME_REWARDS_DEFAULTS.playDays, enabled: true, dryRun: false, minMinutes: 30, tiers: [{ days: 3, reward: { vipHours: 0, points: 10 } }], repeatEveryDays: 0 },
  });
  // 200 days in a row: well past the first window read.
  const days: string[] = [];
  const d = new Date("2026-03-01T12:00:00Z");
  for (let i = 0; i < 200; i++) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  for (const day of days) await repo.gameRewards.addDaySeconds(server.id, "play", day, [{ playerId: "76561198000000901", seconds: 1800 }]);
  const client = fakeClient();
  for (const day of days.slice(-5)) await rewardDayStreak(repo, server, client, slog, "play", "76561198000000901", "Ace", day);
  assert.equal((await repo.economy.member("d-901"))?.balance, 10, "tier 3 once for the whole streak, not once a day");
});

/** A 70-minute match Ace tops in kills and K/D, with Ace and Bee on at the end. */
async function doubleWinner(order: string[], categories: string[], showEveryone = true) {
  const { repo, server, player } = await world();
  const other = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000902", name: "Bee" });
  const byId = new Map(GAME_REWARDS_DEFAULTS.topStats.categories.map((c) => [c.id, c]));
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    order: order as never,
    topStats: { ...GAME_REWARDS_DEFAULTS.topStats, enabled: true, dryRun: false, minPlayers: 2, minMinutes: 0, broadcast: false, showEveryone,
      categories: [...categories, ...[...byId.keys()].filter((id) => !categories.includes(id))].map((id) => ({
        ...byId.get(id as never)!, enabled: id === "kills" || id === "kd", ranks: [{ vipHours: 0, points: 10 }],
        message: id === "kills" ? "KILLS #{rank}" : "KD #{rank}",
      })) as never },
    matchEnd: { ...GAME_REWARDS_DEFAULTS.matchEnd, enabled: true, dryRun: false, reward: { vipHours: 24, points: 0 }, message: "END {player_name} {reward}" },
  });
  const m = await repo.matches.open({ serverId: server.id, map: "carentan_warfare", startedAt: new Date(Date.now() - 70 * 60_000).toISOString() });
  await repo.matches.bumpStat({ matchId: m.id, playerId: player.id, serverId: server.id, playerName: "Ace", kills: 30 });
  await repo.matches.bumpStat({ matchId: m.id, playerId: other.id, serverId: server.id, playerName: "Bee", kills: 12, deaths: 6 });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: null, alliedScore: null, axisScore: null, result: null });
  const client = fakeClient([{ iD: "76561198000000901", name: "Ace" }, { iD: "76561198000000902", name: "Bee" }]);
  await rewardMatchEnded(repo, server, client, slog, endedAt);
  return client.calls.filter((c) => c.cmd === "messagePlayer").map((c) => ({ to: c.params.playerId, text: c.params.message as string }));
}

test("a match end messages each player ONCE, with every reward they earned, in the panel's order", async () => {
  const msgs = await doubleWinner(["matchEnd", "topStats", "killStreaks", "playDays", "seedDays"], ["kills", "kd"], false);
  const ace = msgs.filter((m) => m.to === "76561198000000901");
  assert.equal(ace.length, 1, "Ace won two categories and the match-end day — one message, not three");
  assert.equal(ace[0]!.text, "END Ace 1d of VIP\n\nKILLS #1\n\nKD #1");
  assert.deepEqual(msgs.filter((m) => m.to === "76561198000000902").map((m) => m.text), ["END Bee 1d of VIP"]);
});

test("re-arranging the cards and categories re-orders the combined message", async () => {
  const msgs = await doubleWinner(["topStats", "matchEnd", "killStreaks", "playDays", "seedDays"], ["kd", "kills"], false);
  assert.equal(msgs.find((m) => m.to === "76561198000000901")!.text, "KD #1\n\nKILLS #1\n\nEND Ace 1d of VIP");
});

test("combined parts: in order, the same line once, and never cut mid-part when too long", () => {
  assert.deepEqual(combineParts([{ order: 2, text: "b" }, { order: 1, text: " a " }, { order: 3, text: "a" }]), ["a\n\nb"]);
  const long = "x".repeat(600);
  assert.deepEqual(combineParts([{ order: 1, text: long }, { order: 2, text: "y".repeat(600) }, { order: 3, text: "z" }]), [long, `${"y".repeat(600)}\n\nz`]);
});

const REPORT = "Top players this match:\nKills: Ace (30)\nK/D: Ace (30.00)";

test("every player is sent the top-stats winners, winners or not — inside their one message, after their own", async () => {
  const msgs = await doubleWinner(["matchEnd", "topStats", "killStreaks", "playDays", "seedDays"], ["kills", "kd"]);
  assert.deepEqual(msgs.filter((m) => m.to === "76561198000000902").map((m) => m.text), [`END Bee 1d of VIP\n\n${REPORT}`], "Bee won nothing and still sees the winners");
  assert.deepEqual(msgs.filter((m) => m.to === "76561198000000901").map((m) => m.text), [`END Ace 1d of VIP\n\nKILLS #1\n\nKD #1\n\n${REPORT}`], "the winner: their own rewards, then the list");
});

test("the winners list follows the category order too", async () => {
  const msgs = await doubleWinner(["topStats", "matchEnd", "killStreaks", "playDays", "seedDays"], ["kd", "kills"]);
  assert.equal(msgs.find((m) => m.to === "76561198000000902")!.text, "END Bee 1d of VIP\n\nTop players this match:\nK/D: Ace (30.00)\nKills: Ace (30)");
});

test("the game dropping the connection mid-payout: reconnect, and everyone is still paid", async () => {
  const { repo, server } = await world();
  await repo.gameRewards.setConfig(server.id, { ...GAME_REWARDS_DEFAULTS, matchEnd: { ...GAME_REWARDS_DEFAULTS.matchEnd, enabled: true, dryRun: false, message: "gg {player_name}" } });
  const m = await repo.matches.open({ serverId: server.id, map: "omaha_warfare", startedAt: new Date(Date.now() - 90 * 60_000).toISOString() });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: null, alliedScore: null, axisScore: null, result: null });
  const roster = ["901", "902", "903", "904"].map((n) => ({ iD: `76561198000000${n}`, name: `P${n}` }));
  // The map change: after the second grant the socket is gone until someone reconnects.
  let connected = true, grants = 0, reconnects = 0;
  const calls: { cmd: string; params: Record<string, unknown> }[] = [];
  const raw = {
    execute: async (cmd: string, params: Record<string, unknown>) => {
      if (!connected) throw new Error("not connected");
      calls.push({ cmd, params });
      if (cmd === "addVip" && ++grants === 2) connected = false;
      return null;
    },
    readState: async () => ({ players: roster }),
  };
  const sturdy = reconnecting(raw, async () => { reconnects++; connected = true; }, slog, { waitMs: 1 });
  await rewardMatchEnded(repo, server, sturdy, slog, endedAt);
  for (const r of roster) assert.ok((await repo.vips.get(server.id, r.iD))?.expiration, `${r.name} got their day`);
  assert.equal(reconnects, 1);
  assert.equal(calls.filter((c) => c.cmd === "messagePlayer").length, 4, "and everyone was told");
});

test("a payout that delivered nothing is not marked paid — and nobody is told they earned it", async () => {
  const { repo, server } = await world();
  const dead = { execute: async () => { throw new Error("not connected"); }, readState: async () => null };
  await payGameReward(repo, server, dead as never, slog, pay({ reward: { vipHours: 24, points: 0 } }) as never);
  assert.equal(await repo.vips.get(server.id, "76561198000000901"), null);
  const client = fakeClient();
  await payGameReward(repo, server, client, slog, pay({ reward: { vipHours: 24, points: 0 } }) as never);
  assert.ok((await repo.vips.get(server.id, "76561198000000901"))?.expiration, "evaluated again, it pays");
  assert.equal(client.calls.filter((c) => c.cmd === "messagePlayer").length, 1);
});

test("a server that stays down: one full round of reconnecting, then each later command fails fast", async () => {
  let reconnects = 0;
  const dead = { execute: async () => { throw new Error("not connected"); }, readState: async () => { throw new Error("not connected"); } };
  const sturdy = reconnecting(dead, async () => { reconnects++; throw new Error("connect ECONNREFUSED"); }, slog, { tries: 3, waitMs: 1 });
  await assert.rejects(sturdy.execute("addVip", {}));
  assert.equal(reconnects, 3, "the first command rides out the whole backoff");
  await assert.rejects(sturdy.execute("addVip", {}));
  await assert.rejects(sturdy.execute("messagePlayer", {}));
  assert.equal(reconnects, 5, "later ones try once each, not the whole round again");
});

test("a command the game REFUSED is not retried", async () => {
  let reconnects = 0, calls = 0;
  const refusing = { execute: async () => { calls++; throw Object.assign(new Error("(400) command AddVip failed: bad id"), { statusCode: 400 }); }, readState: async () => null };
  const sturdy = reconnecting(refusing, async () => { reconnects++; }, slog, { waitMs: 1 });
  await assert.rejects(sturdy.execute("addVip", {}));
  assert.equal(calls, 1);
  assert.equal(reconnects, 0);
});

test("points that failed to land are not marked paid either", async () => {
  const { repo, server } = await world();
  const apply = repo.economy.apply.bind(repo.economy);
  repo.economy.apply = (async () => { throw new Error("database unavailable"); }) as never;
  await payGameReward(repo, server, fakeClient(), slog, pay({ reward: { vipHours: 0, points: 40 } }) as never);
  repo.economy.apply = apply;
  await payGameReward(repo, server, fakeClient(), slog, pay({ reward: { vipHours: 0, points: 40 } }) as never);
  assert.equal((await repo.economy.member("d-901"))?.balance, 40, "paid on the next evaluation");
});

test("a console cannot scroll: own rewards always on screen; the winners list cut to the room left", () => {
  const own = "Thank you KREITZ for playing on LYNX! You earned 1d of VIP for a 90-minute match. Your VIP now runs until Jul 4, 2027, 10:10 AM EDT.\n\nUp next Sainte-Mère-Église — Warfare";
  const mine = "Top defense this match — #1 with 1760! You earned 12h of VIP.";
  const report = ["Top players this match:", "Kills: Whittle (74)", "K/D: Bad Brains (15.00)", "Combat: Qui Gon Him (2210)", "Offense: altom14 (1480)",
    "Defense: KREITZ (1760)", "Support: CptNick (4539)", "Teamplay: Oddball (4952)", "Commander: CptNick (4759)"].join("\n");
  // The screenshot's case: the match-end thank-you, a defense win, and the list.
  const [msg, ...more] = combineParts([{ order: 0, text: own }, { order: 10_300, text: mine }, { order: Number.MAX_SAFE_INTEGER, text: report, filler: true }]);
  assert.equal(more.length, 0, "one message");
  assert.ok(msg!.startsWith(`${own}\n\n${mine}\n\nTop players this match:\nKills: Whittle (74)`), "own rewards first, then as much of the list as fits");
  assert.ok(screenLines(msg!) <= MESSAGE_SCREEN.lines, `fits one screen (${screenLines(msg!)} lines)`);
  assert.ok(!msg!.includes("Commander:"), "the list's tail is what gives way");
  // A non-winner has room for the whole list.
  assert.deepEqual(combineParts([{ order: 0, text: own }, { order: Number.MAX_SAFE_INTEGER, text: report, filler: true }]).length, 1);
  // No room for even a heading and one winner: the list is left out, never a heading alone.
  const full = Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n");
  assert.deepEqual(combineParts([{ order: 0, text: full }, { order: 1, text: report, filler: true }]), [full]);
});

test("the winners list names a winner the kill stream never named", async () => {
  const { repo, server, player } = await world();
  const other = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000902", name: "Bee" });
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    topStats: { ...GAME_REWARDS_DEFAULTS.topStats, enabled: true, dryRun: false, minPlayers: 2, minMinutes: 0, broadcast: false, message: "",
      categories: GAME_REWARDS_DEFAULTS.topStats.categories.map((c) => ({ ...c, enabled: c.id === "kills", ranks: [{ vipHours: 0, points: 10 }] })) as never },
  });
  const m = await repo.matches.open({ serverId: server.id, map: "omaha_warfare", startedAt: new Date(Date.now() - 70 * 60_000).toISOString() });
  await repo.matches.bumpStat({ matchId: m.id, playerId: player.id, serverId: server.id, kills: 30 }); // no name on the line
  await repo.matches.bumpStat({ matchId: m.id, playerId: other.id, serverId: server.id, playerName: "Bee", kills: 3 });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: null, alliedScore: null, axisScore: null, result: null });
  const client = fakeClient([{ iD: "76561198000000902", name: "Bee" }]);
  await rewardMatchEnded(repo, server, client, slog, endedAt);
  const bee = client.calls.find((c) => c.cmd === "messagePlayer" && c.params.playerId === "76561198000000902")!.params.message as string;
  assert.match(bee, /Kills: Ace \(30\)/);
  assert.doesNotMatch(bee, /\?/);
});

test("best squads at a match end: every member of the winning tank crew is paid, once — and the whistle sends ONE broadcast for top stats and squads", async () => {
  const { repo, server, player } = await world();
  const bee = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000902", name: "Bee" });
  await repo.externalLinks.set(bee.id, "discord", "d-902", "registration");
  await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561198000000903", name: "Cid" });
  await repo.gameRewards.setConfig(server.id, {
    ...GAME_REWARDS_DEFAULTS,
    topStats: { ...GAME_REWARDS_DEFAULTS.topStats, enabled: true, dryRun: false, minPlayers: 0, minMinutes: 0,
      categories: GAME_REWARDS_DEFAULTS.topStats.categories.map((c) => ({ ...c, enabled: c.id === "kills", ranks: [{ vipHours: 0, points: 5 }] })) },
    bestSquads: { ...GAME_REWARDS_DEFAULTS.bestSquads, enabled: true, dryRun: false, minPlayers: 0, minMinutes: 0, minMembers: 2,
      types: GAME_REWARDS_DEFAULTS.bestSquads.types.map((t) => ({ ...t, enabled: t.id === "armor", ranks: [{ vipHours: 0, points: 40 }] })) },
  });
  const m = await repo.matches.open({ serverId: server.id, map: "carentan_warfare", startedAt: new Date(Date.now() - 3_600_000).toISOString() });
  // Ace and Bee crew one tank; Cid is in an infantry squad on the other side.
  await repo.stats.sampleRoster({ serverId: server.id, matchId: m.id, sampleSec: 600, players: [
    { platformId: "76561198000000901", name: "Ace", role: 12, side: "allies", squad: 1, score: { combat: 300, support: 100 } },
    { platformId: "76561198000000902", name: "Bee", role: 11, side: "allies", squad: 1, score: { combat: 200 } },
    { platformId: "76561198000000903", name: "Cid", role: 6, side: "axis", squad: 0, score: { combat: 900 } },
  ] });
  await repo.matches.bumpStat({ matchId: m.id, playerId: player.id, serverId: server.id, playerName: "Ace", kills: 10 });
  const endedAt = new Date().toISOString();
  await repo.matches.close(m.id, { endedAt, winner: "allies", alliedScore: 5, axisScore: 0, result: null });
  const client = fakeClient();
  await rewardMatchEnded(repo, server, client, slog, endedAt);
  assert.equal((await repo.economy.member("d-902"))?.balance, 40, "Bee, the crewman, paid");
  assert.equal((await repo.economy.member("d-901"))?.balance, 45, "Ace: 40 for the tank and 5 for top kills");
  const broadcasts = client.calls.filter((c) => c.cmd === "broadcast");
  assert.equal(broadcasts.length, 1, "one broadcast — a second would replace the first on screen");
  assert.match(broadcasts[0]!.params.message as string, /kills: Ace \(10\) \| Best squads — armor squad: Ace, Bee \(600\)/);
  const toBee = client.calls.find((c) => c.cmd === "messagePlayer" && c.params.playerId === "76561198000000902")!.params.message as string;
  assert.match(toBee, /Best armor squad this match — #1 with 600, with Ace! You earned 40 Points/);
  // A re-read whistle pays nothing more.
  await rewardMatchEnded(repo, server, client, slog, endedAt);
  assert.equal((await repo.economy.member("d-902"))?.balance, 40);
  assert.equal((await repo.economy.member("d-901"))?.balance, 45);
});
