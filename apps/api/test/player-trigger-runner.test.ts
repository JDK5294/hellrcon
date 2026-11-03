/**
 * The trigger RUNNER, driven directly: a real repo, a stub executor, events pushed by hand.
 * What is pinned: a chain fires every step and fills the message tokens; a one-shot is consumed
 * by a firing that landed and kept by one that missed; observe mode records a dry run and
 * consumes nothing; and the paid-VIP floor holds when a trigger grants VIP over permanent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryRepository, type PlayerTriggerStep } from "@app/db";
import { PlayerTriggerRunner } from "../dist/player-trigger-runner.js";

const stubBus = { on: () => () => {}, emit: () => {}, close: async () => {} } as never;
const step = (over: Partial<PlayerTriggerStep> = {}): PlayerTriggerStep =>
  ({ action: "message", message: "hi", hours: 0, points: 0, delaySec: 0, ...over });

async function scene(mode: "active" | "observe" = "active") {
  const repo = new InMemoryRepository();
  const server = await repo.servers.create({ name: "S", host: "h", port: 1, password: "x" });
  await repo.servers.setEngagementMode(server.id, mode);
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: "76561100000000900", name: "Nova" });
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const runner = new PlayerTriggerRunner({
    repo, bus: stubBus,
    execute: async (_sv, action, params) => { calls.push({ action, params }); },
  });
  const connect = { kind: "evt.player.connected", serverId: server.id, actorPlayerId: player.id, actorName: "Nova" };
  return { repo, server, player, calls, runner, connect };
}

test("a one-shot chain fires every step, fills the name token, consumes itself, and leaves a receipt", async () => {
  const { repo, player, calls, runner, connect } = await scene();
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ message: "Welcome back {player_name}!" }), step({ action: "vip", hours: 72 })],
    fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);

  assert.deepEqual(calls.map((c) => c.action), ["message", "vip"], "both steps of the chain landed");
  assert.match(String(calls[0]!.params.message), /Welcome back Nova!/, "the token filled with their name");
  const after = await repo.playerTriggers.get(trig.id);
  assert.equal(after!.firedCount, 1);
  assert.ok(after!.disarmedAt, "a one-shot that landed is spent");
  // …and it is a receipt, gone from the armed set, so a second connect does nothing.
  await runner.onEvent(connect as never);
  assert.equal(calls.length, 2, "no re-fire");
  const audits = await repo.audit.list({ actions: ["trigger.fire"] });
  assert.equal(audits.length, 1, "one firing, one receipt");
  assert.match(audits[0]!.summary, /grant 72h VIP/);
});

test("observe mode: a dry run records itself and CONSUMES NOTHING — armed until the server is", async () => {
  const { repo, player, calls, runner, connect } = await scene("observe");
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step()], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  assert.equal(calls.length, 0, "nothing reached the game");
  const after = await repo.playerTriggers.get(trig.id);
  assert.equal(after!.firedCount, 0);
  assert.equal(after!.disarmedAt, null, "the one-shot is still waiting for the day the server is armed");
  assert.equal((await repo.audit.list({ actions: ["trigger.dryrun"] })).length, 1);
});

test("a delayed presence step that finds the player gone is a MISS: skipped, and the one-shot stays armed", async () => {
  const { repo, player, calls, runner, connect } = await scene();
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    // 1s delay; the memory store has no open session for them, so the recheck reads them as gone.
    steps: [step({ delaySec: 1 })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  assert.equal(calls.length, 0, "nobody there to message");
  const after = await repo.playerTriggers.get(trig.id);
  assert.equal(after!.disarmedAt, null, "a message left waiting must not be used up by a miss");
  const audits = await repo.audit.list({ actions: ["trigger.error"] });
  assert.match(audits[0]!.summary, /left before the 1s delay/);
});

test("one trigger's delay never holds up the player's OTHER triggers on the same event", async () => {
  const { repo, player, calls, runner, connect } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vip", hours: 1, delaySec: 1 })], fireOnce: true, createdByName: "staff",
  });
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ message: "o7" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  const firing = runner.onEvent(connect as never);
  // The instant message must land while the OTHER trigger's 1s step is still waiting — a serial
  // loop over matches would make it queue behind the delay.
  const t0 = Date.now();
  while (!calls.some((c) => c.action === "message") && Date.now() - t0 < 700) await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some((c) => c.action === "message"), "the no-delay trigger fired immediately, not after its sibling's delay");
  await firing;
  assert.ok(calls.some((c) => c.action === "vip"), "the delayed trigger still landed");
});

test("delays LADDER: each step's delay counts from the step before it, so 1s + 1s lands at 2s", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  await repo.sessions.open(player.id, server.id, new Date().toISOString()); // present, so both messages land
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ delaySec: 1 }), step({ message: "second rung", delaySec: 1 })],
    fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  const t0 = Date.now();
  await runner.onEvent(connect as never);
  const elapsed = Date.now() - t0;
  assert.equal(calls.length, 2, "both rungs landed");
  assert.ok(elapsed >= 1900, `the ladder takes the SUM of the delays, not the longest one (took ${elapsed}ms, needs ~2000)`);
});

test("deleting a trigger while a step waits on its delay calls off the WHOLE rest of the ladder", async () => {
  const { repo, player, calls, runner, connect } = await scene();
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    // Two rungs: the delete lands during the first rung's delay, and the second rung — which has
    // no delay of its own — must be called off with it, not slipped in.
    steps: [step({ action: "vip", hours: 1, delaySec: 1 }), step({ action: "vip", hours: 2 })],
    fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  const firing = runner.onEvent(connect as never);
  await repo.playerTriggers.remove(trig.id); // staff pulls it back before the second runs out
  await firing;
  assert.equal(calls.length, 0, "no rung of the called-off ladder reached the game");
  const audits = await repo.audit.list({ actions: ["trigger.error"] });
  assert.match(audits[0]!.summary, /removed or disabled during the delay/);
});

test("a second event during a one-shot's pending delay does not start a second chain", async () => {
  const { repo, player, calls, runner, connect } = await scene();
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vip", hours: 1, delaySec: 1 })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  // A reconnect lands while the first chain's delay is still pending: once means once.
  await Promise.all([runner.onEvent(connect as never), runner.onEvent(connect as never)]);
  assert.equal(calls.filter((c) => c.action === "vip").length, 1, "one chain, one grant");
  assert.equal((await repo.playerTriggers.get(trig.id))!.firedCount, 1);
});

test("two points steps in one chain BOTH land — the ledger ref tells them apart", async () => {
  const { repo, player, runner, connect } = await scene();
  await repo.externalLinks.set(player.id, "discord", "disc-900");
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "points", points: 40 }), step({ action: "points", points: 60 })],
    fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  const member = await repo.economy.member("disc-900");
  assert.equal(member!.balance, 100, "both grants applied — the same-millisecond second step is not swallowed as a replay");
});

test("victim-side events: a death trigger fires for the one who DIED, and a kill event never fires it for the killer", async () => {
  const { repo, server, player, calls, runner } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "death",
    steps: [step({ message: "Unlucky {player_name} — hold W" })], fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  // Someone ELSE kills Nova: her death trigger fires.
  await runner.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: "killer-record", actorName: "Killer", victimPlayerId: player.id, victimName: "Nova" } as never);
  assert.equal(calls.length, 1, "the victim's death trigger fired");
  assert.match(String(calls[0]!.params.message), /Unlucky Nova/);
  // Nova gets a kill herself: NOT a death.
  await runner.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "Nova", victimPlayerId: "other", victimName: "Other" } as never);
  assert.equal(calls.length, 1, "her own kill does not fire her death trigger");
});

test("the game's name-only KICK line fires a kicked trigger by stored name", async () => {
  const { repo, server, player, runner } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "kicked",
    steps: [step({ action: "watch", message: "kicked by the game — keep an eye on them" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  // The KICK log line carries no id — only the name, in whatever case the game printed.
  await runner.onEvent({ kind: "evt.player.kicked", serverId: server.id, actorPlayerId: null, actorName: "NOVA" } as never);
  const flags = await repo.playerFlags.get(player.id);
  assert.equal(flags!.watchlist, true, "the watch landed off the name-only line");
  const reasons = await repo.watchReasons.list(player.id);
  assert.match(reasons[0]!.reason, /kicked by the game/);
});

test("a name-only line from a server of the OTHER game is someone else of the same name: no firing", async () => {
  // A player record is one game's. A vote line (like the game's own KICK and BAN lines) names its
  // player only by name, so an "any server" trigger on a WW2 player must not act on a Vietnam
  // player who happens to share the name: a watch or a ban would land on the wrong person.
  const { repo, server, player, runner } = await scene();
  const vietnam = await repo.servers.create({ name: "V", game: "hllv", host: "h", port: 2, password: "x" });
  await repo.servers.setEngagementMode(vietnam.id, "active");
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "votestart",
    steps: [step({ action: "watch", message: "started a vote" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent({ kind: "evt.vote.started", serverId: vietnam.id, actorPlayerId: null, actorName: "Nova" } as never);
  assert.equal((await repo.playerFlags.get(player.id))?.watchlist ?? false, false, "the WW2 player was not put on the watchlist");
  const untouched = await repo.playerTriggers.get(trig.id);
  assert.equal(untouched!.firedCount, 0, "not a firing");
  assert.equal(untouched!.disarmedAt, null, "the one-shot is still armed for the real player");
  assert.equal((await repo.audit.list({ actions: ["trigger.fire", "trigger.partial", "trigger.error", "trigger.dryrun"] })).length, 0, "nothing recorded about a stranger");
  // The same name on a server of their own game is them.
  await runner.onEvent({ kind: "evt.vote.started", serverId: server.id, actorPlayerId: null, actorName: "Nova" } as never);
  assert.equal((await repo.playerFlags.get(player.id))!.watchlist, true, "their own game's vote line fired it");
});

test("the loop brake: a banned trigger fires at most once a minute, however many BAN lines arrive", async () => {
  const { repo, server, player, calls, runner } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "banned",
    steps: [step({ action: "watch", message: "banned by the game" })], fireOnce: false, createdByName: "staff",
  });
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "banned",
    steps: [step({ message: "o7" })], fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  const bannedLine = { kind: "evt.player.banned", serverId: server.id, actorPlayerId: null, actorName: "Nova" };
  await runner.onEvent(bannedLine as never);
  await runner.onEvent(bannedLine as never); // a second BAN line seconds later — a cycle would look exactly like this
  assert.equal(calls.filter((c) => c.action === "message").length, 1, "one firing within the minute, not one per line");
  assert.equal((await repo.audit.list({ actions: ["trigger.fire"] })).length, 2, "each trigger fired exactly once");
});

test("vipremove: a dated grant is removed with an honest vip.revoke history row", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  const until = new Date(Date.now() + 48 * 3_600_000).toISOString();
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: "Nova", comment: "event reward", expiration: until, createdByName: "staff" });
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vipremove" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  assert.deepEqual(calls.map((c) => c.action), ["vipremove"], "the game was told to drop the entry");
  assert.equal(await repo.vips.get(server.id, player.platformId), null, "the panel record is gone");
  const history = await repo.audit.list({ actions: ["vip.revoke"] });
  assert.equal(history.length, 1, "the VIP history shows the revoke");
  assert.match(history[0]!.summary, /player trigger revoked VIP/);
});

test("vipremove NEVER touches a PERMANENT grant — and does not retry forever", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: "Nova", comment: "bought", expiration: null, createdByName: "staff" });
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vipremove" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  assert.equal(calls.length, 0, "nothing was sent to the game");
  const vip = await repo.vips.get(server.id, player.platformId);
  assert.equal(vip!.expiration, null, "the permanent grant is exactly where it was");
  assert.ok((await repo.playerTriggers.get(trig.id))!.disarmedAt, "the one-shot is spent — no refusal loop on every connect");
  const audits = await repo.audit.list({ actions: ["trigger.fire"] });
  assert.match(audits[0]!.summary, /PERMANENT — left untouched/);
});

test("vipremove: a grant made PERMANENT while the game was being told keeps its row, and gets its game entry back", async () => {
  // The step reads a dated grant, tells the game to drop it (a round trip of seconds), then
  // deletes the row. A purchase or a staff grant landing in that window made it permanent, and the
  // unconditional delete then took a paid permanent VIP away — automation doing what it never may.
  const { repo, server, player, connect } = await scene();
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: "Nova", comment: "event reward", expiration: new Date(Date.now() + 48 * 3_600_000).toISOString(), createdByName: "staff" });
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const runner = new PlayerTriggerRunner({
    repo, bus: stubBus,
    execute: async (_sv, action, params) => {
      calls.push({ action, params });
      // The permanent grant lands while the game call is in flight.
      if (action === "vipremove") {
        await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: "Nova", expiration: null, createdByName: "staff" });
      }
    },
  });
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vipremove" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  const vip = await repo.vips.get(server.id, player.platformId);
  assert.ok(vip, "the permanent grant's row is still there");
  assert.equal(vip!.expiration, null);
  assert.deepEqual(calls.map((c) => c.action), ["vipremove", "vip"], "and the game got back what was just removed");
  assert.equal((await repo.audit.list({ actions: ["vip.revoke"] })).length, 0, "no revoke is on the record");
  assert.match((await repo.audit.list({ actions: ["trigger.fire"] }))[0]!.summary, /became permanent while this ran/);
});

test("takepoints clamps at zero, and a VIP grant through a trigger shows in the VIP history", async () => {
  const { repo, player, runner, connect } = await scene();
  await repo.externalLinks.set(player.id, "discord", "disc-901");
  await repo.economy.apply({ discordId: "disc-901", delta: 30, reason: "seed", ref: "seed-901", actorName: "test" });
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "takepoints", points: 50 }), step({ action: "vip", hours: 24 })],
    fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  assert.equal((await repo.economy.member("disc-901"))!.balance, 0, "took the 30 they had, not 50 into the red");
  const grants = await repo.audit.list({ actions: ["vip.grant"] });
  assert.equal(grants.length, 1, "the VIP history shows the trigger's grant");
  assert.match(grants[0]!.summary, /player trigger granted VIP/);
});

test("the paid-VIP floor holds through a trigger: a permanent grant is never dated", async () => {
  const { repo, server, player, runner, connect } = await scene();
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: "Nova", comment: "bought", expiration: null, createdByName: "staff" });
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vip", hours: 72 })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.onEvent(connect as never);
  const vip = await repo.vips.get(server.id, player.platformId);
  assert.equal(vip!.expiration, null, "permanent stayed permanent");
  const audits = await repo.audit.list({ actions: ["trigger.fire"] });
  assert.match(audits[0]!.summary, /already permanent — VIP left as is/);
});

test("a trigger's VIP is a reward: a group perk taking none leaves the hold as it is, one taking them banks it", async () => {
  const { repo, server, player, runner, connect } = await scene();
  const group = await repo.playerGroups.create({ name: "Staff", createdByName: "staff" });
  await repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: false });
  await repo.vips.startGroupHold({ serverId: server.id, playerId: player.platformId, playerName: "Nova", groups: [{ id: group.id, name: "Staff", severanceMinutes: 0 }], createdByName: "group perks" });
  const fire = async () => {
    await repo.playerTriggers.create({
      playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
      steps: [step({ action: "vip", hours: 72 })], fireOnce: true, createdByName: "staff",
    });
    await runner.refresh();
    await runner.onEvent(connect as never);
  };
  await fire();
  assert.equal((await repo.vips.get(server.id, player.platformId))!.groupHold!.bankedMs, 0, "nothing frozen for later");
  const fired = await repo.audit.list({ actions: ["trigger.fire"] });
  assert.match(fired[0]!.summary, /permanent VIP from group "Staff", whose perk takes no rewards — VIP left as is/);

  await repo.playerGroups.setVipPerk(group.id, { game: "hll", scope: { mode: "all" }, severanceMinutes: 0, bankRewards: true });
  await fire();
  assert.equal((await repo.vips.get(server.id, player.platformId))!.groupHold!.bankedMs, 72 * 3_600_000, "a group taking rewards banks it");
});

test("editing a trigger while a step waits calls off the rest of the OLD version", async () => {
  const { repo, player, calls, runner, connect } = await scene();
  const trig = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vip", hours: 1, delaySec: 1 }), step({ action: "kick", message: "old plan" })],
    fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  const firing = runner.onEvent(connect as never);
  // Staff rewrite it mid-delay: the kick queued behind the wait belongs to a version that is gone.
  await repo.playerTriggers.edit(trig.id, { serverId: null, event: "connect", params: {}, steps: [step({ message: "new plan" })], fireOnce: false, note: null, editedByName: "staff" });
  await firing;
  assert.equal(calls.length, 0, "nothing from the replaced version reached the game");
  const audits = await repo.audit.list({ actions: ["trigger.error"] });
  assert.match(audits[0]!.summary, /edited during the delay/);
});

test("a server put in observe mode while a step waits calls off the rest of the ladder", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "connect",
    steps: [step({ action: "vip", hours: 1, delaySec: 1 }), step({ action: "vip", hours: 2 })],
    fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  const firing = runner.onEvent(connect as never);
  await repo.servers.setEngagementMode(server.id, "observe"); // the master safety, thrown mid-delay
  await firing;
  assert.equal(calls.length, 0, "no delayed rung reached the game once the server was in observe mode");
});

test("a weapon-kill trigger fires on a kill with a listed weapon, from the store's own params, and only then", async () => {
  const { repo, server, player, calls, runner } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "weaponkill", params: { weapons: "FLAMETHROWER" },
    steps: [step({ message: "No flamethrowers, {player_name}" })], fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  const kill = (weapon: string) => ({ kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "Nova", victimPlayerId: null, victimName: "Rex", weapon });
  await runner.onEvent(kill("M1 GARAND") as never);
  assert.equal(calls.length, 0, "a weapon it does not list fires nothing");
  await runner.onEvent(kill("M2 FLAMETHROWER") as never);
  assert.deepEqual(calls.map((c) => c.action), ["message"]);
  assert.match(String(calls[0]!.params.message), /No flamethrowers, Nova/);
});

test("a roster condition fires the trigger it was detected for — only that one — with what was seen", async () => {
  const { repo, server, player, calls, runner } = await scene();
  const tanks = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "role", params: { roles: [12] },
    steps: [step({ message: "{player_name}: {violation}" })], fireOnce: true, createdByName: "staff",
  });
  // The same player, the same condition, another role list: judged on its own by the worker.
  const crew = await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "role", params: { roles: [11] },
    steps: [step({ message: "crew" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  const seen = (triggerId: string) => ({
    kind: "app.playertrigger.roster", serverId: server.id, actorPlayerId: player.id, actorName: "Nova",
    data: { triggerId, event: "role", violation: "Tank Commander is not allowed here" },
  });
  await runner.onEvent(seen(tanks.id) as never);
  assert.deepEqual(calls.map((c) => c.action), ["message"]);
  assert.equal(String(calls[0]!.params.message), "Nova: Tank Commander is not allowed here", "{violation} carries what the roster showed");
  assert.ok((await repo.playerTriggers.get(tanks.id))!.disarmedAt, "a one-shot is spent by its firing");
  assert.equal((await repo.playerTriggers.get(crew.id))!.disarmedAt, null, "the other trigger was not detected, so it waits");
  // The audit names the condition in the server's game's words.
  const audits = await repo.audit.list({ actions: ["trigger.fire"] });
  assert.match(audits[0]!.summary, /player trigger \(on playing Tank Commander, message \(once\)\)/);
});

test("AFK: the minutes without a kill fire it once per quiet spell; a kill starts a new spell; leaving ends the clock", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "afk", params: { minutes: 10 },
    steps: [step({ message: "Still with us, {player_name}?" })], fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  const t0 = Date.parse("2026-10-14T12:00:00Z");
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  // Ingest opens the session on the same connect line it publishes, and closes it on the disconnect.
  await repo.sessions.open(player.id, server.id, at(0));
  await runner.onEvent({ ...connect, ts: at(0) } as never);
  await runner.runAfkSweep(t0 + 9 * 60_000);
  assert.equal(calls.length, 0, "nine quiet minutes: not yet");
  await runner.runAfkSweep(t0 + 10 * 60_000);
  assert.deepEqual(calls.map((c) => c.action), ["message"]);
  assert.equal(String(calls[0]!.params.message), "Still with us, Nova?");
  await runner.runAfkSweep(t0 + 30 * 60_000);
  assert.equal(calls.length, 1, "one quiet spell fires once");
  // A kill starts a new spell: ten more quiet minutes fire it again.
  await runner.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "Nova", victimName: "Rex", ts: at(31) } as never);
  await runner.runAfkSweep(t0 + 40 * 60_000);
  assert.equal(calls.length, 1, "nine minutes after the kill");
  await runner.runAfkSweep(t0 + 41 * 60_000);
  assert.equal(calls.length, 2, "a new spell — every time");
  // Leaving the server ends the clock there: a spell cut short by leaving never fires.
  await runner.onEvent({ kind: "evt.kill", serverId: server.id, actorPlayerId: player.id, actorName: "Nova", victimName: "Rex", ts: at(45) } as never);
  await repo.sessions.close(player.id, server.id, at(46));
  await runner.onEvent({ kind: "evt.player.disconnected", serverId: server.id, actorPlayerId: player.id, actorName: "Nova", ts: at(46) } as never);
  await runner.runAfkSweep(t0 + 90 * 60_000);
  assert.equal(calls.length, 2, "nobody to be AFK");
});

test("AFK: a player who left with no disconnect line (a crash, a restart) is taken off the clock, not acted on", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "afk", params: { minutes: 10 },
    steps: [step({ action: "tempban", hours: 2, message: "AFK" })], fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  const t0 = Date.parse("2026-10-14T12:00:00Z");
  await repo.sessions.open(player.id, server.id, new Date(t0).toISOString());
  await runner.onEvent({ ...connect, ts: new Date(t0).toISOString() } as never);
  // The server crashes and they never come back. The game logs no DISCONNECTED line, and the
  // worker's next roster read closes the session the roster no longer backs.
  await repo.sessions.closeAbsent(server.id, [], new Date(t0 + 60_000).toISOString(), new Date(t0 + 60_000).toISOString());

  await runner.runAfkSweep(t0 + 10 * 60_000);
  await runner.runAfkSweep(t0 + 20 * 60_000);
  assert.deepEqual(calls, [], "nothing is done to a player who is not there — a ban lands whether they are or not");
  assert.equal((runner as any).afkClocks.size, 0, "their clock is dropped");
});

test("AFK: presence that cannot be read fires nothing that round, and keeps the clock", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "afk", params: { minutes: 10 },
    steps: [step({ action: "kick", message: "AFK" })], fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  const t0 = Date.parse("2026-10-14T12:00:00Z");
  await repo.sessions.open(player.id, server.id, new Date(t0).toISOString());
  await runner.onEvent({ ...connect, ts: new Date(t0).toISOString() } as never);

  const read = repo.sessions.openServersFor;
  repo.sessions.openServersFor = async () => { throw new Error("database unavailable"); };
  await runner.runAfkSweep(t0 + 10 * 60_000);
  assert.equal(calls.length, 0, "unknown presence is not presence");
  assert.equal((runner as any).afkClocks.size, 1, "nor absence: the clock stays");

  repo.sessions.openServersFor = read;
  await runner.runAfkSweep(t0 + 11 * 60_000);
  assert.deepEqual(calls.map((c) => c.action), ["kick"], "back to normal on the next sweep");
});

test("AFK: a reconnect that lands while presence is being read keeps its new clock", async () => {
  const { repo, server, player, calls, runner, connect } = await scene();
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: null, event: "afk", params: { minutes: 10 },
    steps: [step({ action: "kick", message: "AFK" })], fireOnce: false, createdByName: "staff",
  });
  await runner.refresh();
  const t0 = Date.parse("2026-10-14T12:00:00Z");
  // A clock left over from before a crash: no session backs it any more.
  await runner.onEvent({ ...connect, ts: new Date(t0).toISOString() } as never);

  const read = repo.sessions.openServersFor;
  repo.sessions.openServersFor = async (ids: string[]) => {
    const answer = await read(ids); // taken before they are back
    const back = new Date(t0 + 10 * 60_000).toISOString();
    await repo.sessions.open(player.id, server.id, back);
    await runner.onEvent({ ...connect, ts: back } as never);
    return answer;
  };
  await runner.runAfkSweep(t0 + 10 * 60_000);
  assert.equal(calls.length, 0);
  assert.equal((runner as any).afkClocks.size, 1, "the clock the reconnect started is not dropped on the stale read");
});

test("AFK: a player already on the server when it is armed is clocked from then, not from when they joined", async () => {
  const { repo, server, player, calls, runner } = await scene();
  const t0 = Date.parse("2026-10-14T12:00:00Z");
  await repo.sessions.open(player.id, server.id, new Date(t0 - 3_600_000).toISOString());
  await repo.playerTriggers.create({
    playerId: player.id, playerName: "Nova", serverId: server.id, event: "afk", params: { minutes: 5 },
    steps: [step({ action: "kick", message: "AFK" })], fireOnce: true, createdByName: "staff",
  });
  await runner.refresh();
  await runner.runAfkSweep(t0);
  assert.equal(calls.length, 0, "an hour online already, but the clock starts when the trigger does");
  await runner.runAfkSweep(t0 + 5 * 60_000);
  assert.deepEqual(calls.map((c) => c.action), ["kick"]);
});
