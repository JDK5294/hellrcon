/**
 * The rule actions that carry an effect of their own: switch team (then an optional message), add a
 * tag (once — never a duplicate row), and grant points (to the linked Discord account, through the
 * ledger; no link is a failure the row names).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository } from "@app/db";
import type { ServerRow } from "@app/db";
import { ENFORCER_ACTIONS, Enforcer } from "../dist/enforcer.js";
import { RULE_ACTIONS } from "../dist/routes/kit.js";

const stubBus = { on: () => () => {}, emit: () => {}, close: async () => {} } as any;

let seq = 0;
async function scene(rule: Record<string, unknown>, opts: { observe?: boolean } = {}) {
  const repo = await createRepository();
  const server = await repo.servers.create({ name: "Main", host: "h", port: 1, password: "x" });
  if (!opts.observe) await repo.servers.setEngagementMode(server.id, "active");
  const r = await repo.enforcerRules.create({ serverId: server.id, name: "R", eventKind: "evt.teamkill", ...rule } as any);
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const enf = new Enforcer({ repo, bus: stubBus, execute: async (_s: ServerRow, action: string, params: Record<string, unknown>) => void calls.push({ action, params }) });
  await enf.refresh();
  const player = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611960000${String(++seq).padStart(5, "0")}`, name: `P${seq}` });
  const fire = (p: { id: string; name: string } = player) => enf.onEvent({ kind: "evt.teamkill", serverId: server.id, actorPlayerId: p.id, actorName: p.name });
  const rows = async () => (await repo.audit.list({})).filter((a) => a.action.startsWith("enforcer."));
  return { repo, server, rule: r, calls, player, fire, rows };
}

test("switch: moves the player now, then sends the rule's message", async () => {
  const { calls, fire, player } = await scene({ action: "switch", reason: "Moved to even the teams" });
  await fire();
  assert.deepEqual(calls.map((c) => c.action), ["switch", "message"]);
  assert.equal(calls[0]!.params.playerId, player.platformId);
  assert.match(String(calls[1]!.params.message), /Moved to even the teams/);
});

test("tag: added once with the rule named on it; a second firing adds no duplicate", async () => {
  const { repo, calls, fire, player, rows } = await scene({ action: "tag", actionTag: "tk-warned", reason: "team kill" });
  await fire();
  await fire();
  const tags = await repo.playerTags.list(player.id);
  assert.deepEqual(tags.map((t) => t.label), ["tk-warned"]);
  assert.match(tags[0]!.createdByName, /rule "R"/);
  assert.equal(calls.length, 0, "a tag touches nothing in game");
  const data = (await rows()).map((a) => (a.data as { tagged?: boolean }).tagged);
  assert.deepEqual(data.sort(), [false, true]);
});

test("tag lands on an observe-mode server too — it writes our records, never the game", async () => {
  const { repo, fire, player } = await scene({ action: "tag", actionTag: "seen" }, { observe: true });
  await fire();
  assert.deepEqual((await repo.playerTags.list(player.id)).map((t) => t.label), ["seen"]);
});

test("a ladder can tag: message first, then tag on the repeat", async () => {
  const { repo, calls, fire, player } = await scene({ action: "message", reason: "careful", escalateActions: ["tag"], actionTag: "repeat-tk" });
  await fire();
  assert.equal((await repo.playerTags.list(player.id)).length, 0);
  await fire();
  assert.deepEqual(calls.map((c) => c.action), ["message"]);
  assert.deepEqual((await repo.playerTags.list(player.id)).map((t) => t.label), ["repeat-tk"]);
});

test("points: paid to the linked Discord account through the ledger, then the message with {points}", async () => {
  const { repo, calls, fire, player, rows } = await scene({ action: "points", points: 25, reason: "+{points} for you" });
  const discordId = `4000000000000${String(seq).padStart(5, "0")}`;
  await repo.externalLinks.set(player.id, "discord", discordId);
  await fire();
  const member = await repo.economy.member(discordId);
  assert.equal(member?.balance, 25);
  assert.deepEqual(calls.map((c) => c.action), ["message"]);
  assert.equal(String(calls[0]!.params.message), "+25 for you");
  const row = (await rows())[0]!;
  assert.equal(row.action, "enforcer.points");
  assert.equal((row.data as { pointsGiven?: number }).pointsGiven, 25);
});

test("a crowd of tags does not trip the breaker — a tag writes nothing to the game", async () => {
  const { repo, rule, fire, player } = await scene({ action: "tag", actionTag: "regular", breakerLimit: 2 });
  await fire(); // the scene's own player…
  for (let i = 0; i < 4; i++) { // …and four more inside the same minute, through the same enforcer
    const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611960000${String(++seq).padStart(5, "0")}`, name: `P${seq}` });
    await fire(p);
    assert.deepEqual((await repo.playerTags.list(p.id)).map((t) => t.label), ["regular"]);
  }
  assert.equal((await repo.enforcerRules.get(rule.id))!.enabled, true, "still on — a tag's blast radius is a label");
  assert.deepEqual((await repo.playerTags.list(player.id)).map((t) => t.label), ["regular"]);
});

test("points: an unreadable economy config fails the firing — never an uncapped payment — and spares the cap", async () => {
  const { repo, rule, calls, fire, player, rows } = await scene({ action: "points", points: 10, capCount: 1, capPeriod: "ever" });
  const discordId = `4200000000000${String(seq).padStart(5, "0")}`;
  await repo.externalLinks.set(player.id, "discord", discordId);
  const realConfig = repo.economy.config.bind(repo.economy);
  repo.economy.config = async () => { throw new Error("economy config unreadable"); };
  await fire();
  repo.economy.config = realConfig;
  assert.equal((await repo.economy.member(discordId))?.balance ?? 0, 0, "nothing paid blind");
  const row = (await rows())[0]!;
  assert.equal(row.action, "enforcer.error");
  assert.equal(calls.length, 0, "no follow-up message for a payment that didn't happen");
  // The config is readable again: the next firing pays — the failed one did not use the allowance.
  await fire();
  assert.equal((await repo.economy.member(discordId))?.balance, 10);
  assert.equal(await repo.enforcerRules.firingCount(rule.id, player.id, null, false), 1);
});

test("points: no Discord link is a failure the row names — and it never uses up a capped allowance", async () => {
  const { repo, rule, calls, fire, player, rows } = await scene({ action: "points", points: 10, capCount: 1, capPeriod: "ever" });
  await fire();
  const row = (await rows())[0]!;
  assert.equal(row.action, "enforcer.error");
  assert.match(row.summary, /no Discord link/);
  assert.equal(calls.length, 0);
  // They link, and the next firing pays — the failed one did not count.
  const discordId = `4100000000000${String(seq).padStart(5, "0")}`;
  await repo.externalLinks.set(player.id, "discord", discordId);
  await fire();
  assert.equal((await repo.economy.member(discordId))?.balance, 10);
  assert.equal(await repo.enforcerRules.firingCount(rule.id, player.id, null, false), 1);
});

test("a rule row that names an action no rule may take does nothing — above all, it cannot remove VIP", async () => {
  // Written straight to the store, as a restored archive or an edited setup would: no parser.
  const { repo, server, rule, calls, fire, player } = await scene({ action: "vipremove" });
  await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: player.name, comment: "paid", expiration: null, createdByUserId: null, createdByName: "admin" });
  await fire();
  assert.equal(calls.length, 0, "nothing reached the game");
  assert.equal((await repo.vips.get(server.id, player.platformId))?.expiration, null, "the paid permanent VIP stands");
  const st = (await repo.enforcerRules.statuses()).find((x) => x.ruleId === rule.id);
  assert.match(st?.skipReason ?? "", /not one a rule can take/, "and the rule's card says why it does nothing");
});

test("event firings stay immediate — the crowd pacing is for roster triggers, never a teamkill", async () => {
  // A big gap that would be unmissable if event-kind writes were wrongly put on the paced chain.
  process.env.RULE_CROWD_PACE_MS = "200";
  try {
    const { repo, calls, fire } = await scene({ action: "kick", reason: "no TK" });
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
      const p = await repo.players.upsert({ game: "hll", platform: "steam", platformId: `765611960000${String(++seq).padStart(5, "0")}`, name: `P${seq}` });
      await fire(p);
    }
    assert.equal(calls.filter((c) => c.action === "kick").length, 3);
    assert.ok(Date.now() - start < 200, "three kicks back to back, no breath inserted between them");
  } finally {
    delete process.env.RULE_CROWD_PACE_MS;
  }
});

test("the enforcer's action list is exactly the rule parser's", () => {
  assert.deepEqual([...ENFORCER_ACTIONS].sort(), [...RULE_ACTIONS].sort());
});

test("a delayed action obeys the rule and server as they are when it fires — switched off, or put in observe mode", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Switched off during the wait: nothing happens.
  const off = await scene({ action: "kick", reason: "bye", delaySec: 1 });
  await off.repo.sessions.open(off.player.id, off.server.id, new Date().toISOString());
  await off.fire();
  await off.repo.enforcerRules.update(off.rule.id, { enabled: false });
  await sleep(1300);
  assert.equal(off.calls.length, 0, "a rule switched off mid-delay does not act");

  // Server flipped to observe during the wait: the kick becomes a dry run.
  const obs = await scene({ action: "kick", reason: "bye", delaySec: 1 });
  await obs.repo.sessions.open(obs.player.id, obs.server.id, new Date().toISOString());
  await obs.fire();
  await obs.repo.servers.setEngagementMode(obs.server.id, "observe");
  await sleep(1300);
  assert.equal(obs.calls.length, 0, "observe mode is not outrun by a timer");
  assert.ok((await obs.rows()).some((a) => a.action === "enforcer.dryrun"), "recorded as what it would have done");
});

test("a 'points once, ever' rule stays once after the audit log is trimmed", async () => {
  const { repo, fire, player } = await scene({ action: "points", points: 50, capCount: 1, capPeriod: "ever" });
  const discordId = `4300000000000${String(seq).padStart(5, "0")}`;
  await repo.externalLinks.set(player.id, "discord", discordId);
  await fire();
  assert.equal((await repo.economy.member(discordId))?.balance, 50);
  // Data retention's "Staff activity" trim clears the audit log — the trail the cap used to count.
  await repo.trimData.run(["audit"], new Date(Date.now() + 60_000).toISOString(), null);
  await fire();
  assert.equal((await repo.economy.member(discordId))?.balance, 50, "paid once — the trim did not re-arm the milestone");
});
