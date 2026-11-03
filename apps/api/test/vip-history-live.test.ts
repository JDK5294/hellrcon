import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGameServer } from "./fake-hll-server.ts";
import { withServer, jf } from "./harness.ts";

async function ownerToken(base: string): Promise<string> {
  await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return login.body.token as string;
}

type Row = { action: string; by: string; expiration: string | null; comment: string | null };

/*
 * The profile's VIP history has to account for every VIP the profile's status shows. A grant made
 * from the live view (the same route the VIPs page uses) lands there; so does a game reward that
 * paid VIP — which used to be missing, leaving time on the status box nothing in the timeline
 * explained.
 */
test("VIP history shows a live-view grant and a game reward that paid VIP", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const pid = "00028c38e7b748799a502ce7c3d41616";
      const player = await repo.players.upsert({ game: "hll", platform: "xbox", platformId: pid, name: "Qui Gon Him" });
      const g = await jf(`${base}/api/servers/${serverId}/vips`, { method: "POST", headers: auth, body: JSON.stringify({
        playerId: pid, playerName: "Qui Gon Him", mode: "duration", days: 3, hours: 0, cumulative: true, allServers: false, comment: "donor",
      }) });
      assert.equal(g.status, 200, JSON.stringify(g.body));
      assert.equal((g.body.applied as unknown[]).length, 1);

      const exp = new Date(Date.now() + 5 * 86_400_000).toISOString();
      await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: pid, serverId,
        summary: "rewarded", data: { kind: "topStats", expiration: exp, vipGiven: 48, pointsGiven: 0 } });
      // A points-only reward and a dry run moved nothing: not VIP history.
      await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: pid, serverId,
        summary: "rewarded", data: { kind: "streak", vipGiven: 0, pointsGiven: 100 } });
      await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: pid, serverId,
        summary: "[dry-run]", data: { dryRun: true, expiration: exp } });

      // A regular's points-only rewards, one per match — more than the timeline's page. They must
      // not crowd the grant out (they did, when every game.reward shared the grants' page).
      for (let i = 0; i < 250; i++) {
        await repo.audit.create({ actorUserId: null, actorName: "game rewards", action: "game.reward", targetType: "player", targetId: pid, serverId,
          summary: "points", data: { kind: "everyone", vipGiven: 0, pointsGiven: 10 } });
      }
      // Crash VIP: the enforcer keys its row by the PROFILE id; only a grant that landed shows.
      const crashExp = new Date(Date.now() + 10 * 60_000).toISOString();
      await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "enforcer.vip", targetType: "player", targetId: player.id, serverId,
        summary: "rule", data: { ruleName: "Crash VIP", action: "vip", playerId: pid, dryRun: false, expiration: crashExp } });
      await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "enforcer.vip", targetType: "player", targetId: player.id, serverId,
        summary: "rule", data: { ruleName: "Crash VIP", action: "vip", playerId: pid, dryRun: false, error: "game refused" } });
      // The no-VIP roster trigger's grant: same row, a player who was HERE — not a crash.
      const welcomeExp = new Date(Date.now() + 86_400_000).toISOString();
      await repo.audit.create({ actorUserId: null, actorName: "enforcer", action: "enforcer.vip", targetType: "player", targetId: player.id, serverId,
        summary: "rule", data: { ruleName: "Welcome VIP", eventKind: "app.state.no_vip", action: "vip", playerId: pid, dryRun: false, expiration: welcomeExp } });

      const h = await jf(`${base}/api/players/${player.id}/vip-history`, { headers: auth });
      const rows = h.body.history as Row[];
      const ruled = rows.filter((r) => r.action === "rule VIP");
      assert.equal(ruled.length, 2, "the failed firing moved nothing");
      const crash = ruled.find((r) => r.expiration === crashExp);
      assert.match(crash?.comment ?? "", /Crash VIP/);
      const welcome = ruled.find((r) => r.expiration === welcomeExp);
      assert.equal(welcome?.comment, 'rule "Welcome VIP"', "a roster rule's grant is not called a crash VIP");
      assert.ok(rows.some((r) => r.action === "granted" && r.by === "admin"), "the live-view grant");
      const game = rows.filter((r) => r.action === "game reward");
      assert.equal(game.length, 1, "only the reward that moved the expiry");
      assert.equal(game[0]!.expiration, exp);
      assert.match(game[0]!.comment ?? "", /\+48h/);
    } finally { fake.close(); }
  });
});

test("the VIP popup reports a grant that landed nowhere instead of toasting success", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../panel/components/EditVip.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("if (r.applied && r.applied.length === 0) throw new Error(`VIP was NOT granted"), "nothing applied is an error");
  assert.ok(src.includes("if (skipped.length) toast.error("), "a partial grant names the servers it missed");
});

test("the profile's VIP history reloads with the profile, so a grant made there shows at once", async () => {
  const { readFileSync } = await import("node:fs");
  const players = readFileSync(new URL("../../panel/components/Players.tsx", import.meta.url), "utf8");
  const history = readFileSync(new URL("../../panel/components/VipHistory.tsx", import.meta.url), "utf8");
  // The profile's resolved id, not the address's: a profile opened by the player's game id found
  // the grants and lost the rule VIP rows (filed under the profile id).
  assert.ok(players.includes("<VipHistory playerId={profileId} reloadKey={data} />"), "keyed to the profile's own data and id");
  // The reader's VIP permission is a key too: without one the timeline isn't asked for at all.
  assert.ok(/\[playerId, reloadKey, sees\]/.test(history), "a new key refetches the timeline");
});
