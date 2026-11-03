/**
 * The ban-evasion tripwire — the check that survives a fresh game account.
 *
 * Every ACCOUNT id (XUID, Steam64, per-game EOS id) is useless against a banned player who buys a
 * new Xbox account: new account, new numbers, clean row. What they keep is their Discord, because
 * registration, VIP and the economy all run through it — so the moment that Discord is linked to
 * a new game account is the moment they identify themselves, and what is pinned here is that the
 * moment is not wasted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryRepository } from "@app/db";
import { flagBanEvasion } from "../dist/evasion.js";
import { addWatchReason } from "../dist/watch.js";
import { createHandler, createAppContext } from "../dist/app.js";

/** A banned WW2 account whose Discord is about to turn up on a new account. */
async function bannedSetup(repo: InMemoryRepository, discordId: string) {
  const banned = await repo.players.upsert({ game: "hll", platform: "xbox", platformId: "00028c38e7b748799a502ce7c3d41616", name: "CrimePays410" });
  await repo.externalLinks.set(banned.id, "discord", discordId);
  const ban = await repo.playerBans.create({
    game: "hll", playerId: banned.platformId, playerName: banned.name, kind: "perma",
    reason: "sexual harassment", scope: { mode: "all" }, createdByName: "staff",
  });
  return { banned, ban };
}

test("linking a banned player's Discord to a new account watchlists it, naming the ban", async () => {
  const repo = new InMemoryRepository();
  const { banned } = await bannedSetup(repo, "discord-1");
  const alt = await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: "0002fresh00000000000000000000001", name: "TotallyNewGuy" });

  const r = await flagBanEvasion(repo, alt, "discord-1", { via: "registration" });
  assert.equal(r.flagged, true);
  assert.equal(r.against?.playerId, banned.id);

  const flags = await repo.playerFlags.get(alt.id);
  assert.equal(flags?.watchlist, true);
  assert.match(flags?.watchReason ?? "", /ban evasion/);
  assert.match(flags?.watchReason ?? "", /CrimePays410/, "the reason names the account being evaded");
  assert.match(flags?.watchReason ?? "", /permanently banned/);

  const trail = await repo.audit.list({ q: "player.evasion" });
  assert.equal(trail.length, 1, "the trail records why the flag appeared");
  assert.match(trail[0]!.summary, /CrimePays410/);
});

test("a lifted ban trips nothing — the record is history, not suspicion", async () => {
  const repo = new InMemoryRepository();
  const { ban } = await bannedSetup(repo, "discord-2");
  await repo.playerBans.lift(ban.id, "staff");
  const alt = await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: "0002fresh00000000000000000000002", name: "Reformed" });

  const r = await flagBanEvasion(repo, alt, "discord-2", { via: "registration" });
  assert.equal(r.flagged, false);
  assert.equal((await repo.playerFlags.get(alt.id))?.watchlist ?? false, false);
});

test("a watch a staff member already placed is never overwritten — the tripwire adds its reason BESIDE theirs", async () => {
  const repo = new InMemoryRepository();
  await bannedSetup(repo, "discord-3");
  const alt = await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: "0002fresh00000000000000000000003", name: "AltAgain" });
  await addWatchReason(repo, alt.id, { reason: "seen teaming with cheaters", by: { userId: null, name: "PEPPER" } });

  const r = await flagBanEvasion(repo, alt, "discord-3", { via: "registration" });
  assert.equal(r.flagged, true, "a watch is made of reasons now — this one contributes its own");
  const reasons = await repo.watchReasons.list(alt.id);
  assert.equal(reasons.filter((x) => x.removedAt === null).length, 2, "the staff reason AND the tripwire's stand together");
  assert.ok(reasons.some((x) => x.reason === "seen teaming with cheaters" && x.removedAt === null), "the staff reason is untouched");
  assert.ok(reasons.some((x) => /ban evasion/.test(x.reason)), "the tripwire's reason names the evidence");

  // Same evidence again (the wire re-checks on every link event): deduped, nothing new recorded.
  const again = await flagBanEvasion(repo, alt, "discord-3", { via: "registration" });
  assert.equal(again.flagged, false, "an identical active reason already says this");
  assert.equal((await repo.watchReasons.list(alt.id)).length, 2);
});

test("a WATCHLISTED (not banned) account trips the wire too, with its own wording", async () => {
  const repo = new InMemoryRepository();
  const watched = await repo.players.upsert({ game: "hll", platform: "xbox", platformId: "0002watchedaccount0000000000000a", name: "SusPlayer" });
  await repo.externalLinks.set(watched.id, "discord", "discord-4");
  await repo.playerFlags.set(watched.id, { watchlist: true, watchReason: "griefing reports" }, { userId: null, name: "staff" });
  const alt = await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: "0002fresh00000000000000000000004", name: "NewName" });

  const r = await flagBanEvasion(repo, alt, "discord-4", { via: "registration" });
  assert.equal(r.flagged, true);
  assert.match((await repo.playerFlags.get(alt.id))?.watchReason ?? "", /on the watchlist/);
});

test("the panel's Link button trips the wire end-to-end", async () => {
  const repo = new InMemoryRepository();
  const ctx = await createAppContext(repo, { port: 0, sessionSecret: "test", webRoot: null });
  const handler = createHandler(ctx);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const jf = async (url: string, opts: RequestInit = {}) => {
      const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    await jf(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
    const login = await jf(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
    const auth = { authorization: `Bearer ${login.body.token as string}` };

    await bannedSetup(repo, "discord-5");
    const alt = await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: "0002fresh00000000000000000000005", name: "LinkedByStaff" });

    const linked = await jf(`${base}/api/players/${alt.id}/links`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ provider: "discord", externalId: "discord-5" }),
    });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const flags = await repo.playerFlags.get(alt.id);
    assert.equal(flags?.watchlist, true, "the link route runs the tripwire");
    assert.match(flags?.watchReason ?? "", /ban evasion/);
  } finally {
    server.close();
  }
});
