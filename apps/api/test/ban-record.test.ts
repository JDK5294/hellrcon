/**
 * The half of a ban the closed-port tests can never reach: what happens AFTER the game accepts the
 * command. Driven against the fake HLL server, so `client.execute` genuinely succeeds and the
 * decision record, the audit summary and the unban's lift are all real behaviour under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGameServer } from "./fake-hll-server.ts";
import { withIsolatedServer as withServer } from "./harness.ts";

async function jsonFetch(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function ownerToken(base: string): Promise<string> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  return login.body.token as string;
}

test("a permaban that lands writes the decision: game ban + one player_ban row carrying the rule", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: "76561198000000001", playerName: "Cheat", reason: "aimbot", category: "cheating", scope: { mode: "all" } }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);

      // The game actually holds the ban…
      assert.ok(fake.permaBans.has("76561198000000001"), "the fake server recorded the ban");

      // …and the decision is one row, with the RULE, not its expansion.
      const rows = await repo.playerBans.list({ playerId: "76561198000000001", activeOnly: true });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind, "perma");
      assert.equal(rows[0]!.category, "cheating");
      assert.deepEqual(rows[0]!.scope, { mode: "all" });
      assert.equal(rows[0]!.expiresAt, null);

      // The audit trail names the rule so a reader can tell "banned here" from "banned everywhere".
      const trail = await jsonFetch(`${base}/api/audit?limit=20`, { headers: auth });
      const entry = (trail.body.entries as { action: string; summary: string }[]).find((e) => e.action === "player.permaban");
      assert.ok(entry, "audit row exists");
      assert.match(entry!.summary, /all servers \(including any added later\)/);
    } finally {
      fake.close();
    }
  });
});

test("a tempban records a real expiry date, not a count of hours", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const before = Date.now();
      const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "tempban", playerId: "p1", reason: "spam", hours: 48 }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(fake.tempBans.get("p1")?.hours, 48);

      const [row] = await repo.playerBans.list({ playerId: "p1", activeOnly: true });
      assert.equal(row!.kind, "temp");
      // No scope in the request → the decision covers exactly the server in the path.
      assert.deepEqual(row!.scope, { mode: "servers", serverIds: [serverId] });
      const expires = Date.parse(row!.expiresAt!);
      assert.ok(expires > before + 47 * 3_600_000 && expires < before + 49 * 3_600_000, row!.expiresAt!);
    } finally {
      fake.close();
    }
  });
});

test("a message action never records a duration, however the request arrived", async () => {
  // The panel's action modals share one form state whose hours default is 24, so a message (or a
  // kick) request can arrive CARRYING hours — and used to be recorded with them, which put
  // "Duration: 24 hours" on the profile's moderation history for an action that has no duration.
  // The record keeps only what the action consumed: tempban keeps its hours, nothing else does.
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "message", playerId: "p1", message: "hello", hours: 24 }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(fake.messages[0]?.playerId, "p1", "the message reached the game");

      const rows = await repo.audit.list({ targetId: "p1", limit: 10 });
      const msg = rows.find((a) => a.action === "player.message");
      assert.ok(msg, "the message is on the trail");
      assert.equal((msg!.data as { hours?: number } | null)?.hours, undefined, "no duration on a message");
      assert.equal((msg!.data as { message?: string } | null)?.message, "hello");

      // The same request shape as a tempban DOES keep its hours — the gate is the action, not the field.
      await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "tempban", playerId: "p1", reason: "spam", hours: 24 }),
      });
      const rows2 = await repo.audit.list({ targetId: "p1", limit: 10 });
      const ban = rows2.find((a) => a.action === "player.tempban");
      assert.equal((ban!.data as { hours?: number } | null)?.hours, 24, "a tempban's hours are the record");
    } finally {
      fake.close();
    }
  });
});

test("the unban lifts the decision and clears the game, and a failed ban records nothing", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: "p9", reason: "r" }),
      });
      assert.equal((await repo.playerBans.list({ playerId: "p9", activeOnly: true })).length, 1);

      const un = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_perma", playerId: "p9" }),
      });
      assert.equal(un.status, 200, JSON.stringify(un.body));
      assert.equal(fake.permaBans.has("p9"), false, "the game ban is gone");
      const rows = await repo.playerBans.list({ playerId: "p9" });
      assert.equal(rows.length, 1, "lifted, never deleted");
      assert.ok(rows[0]!.liftedAt, "the row is stamped lifted");

      // A ban aimed at a dead server records no decision — the reconciler must not later apply
      // something the operator watched fail.
      fake.close();
      const dead = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: "p10", reason: "r" }),
      });
      assert.notEqual(dead.status, 200);
      assert.equal((await repo.playerBans.list({ playerId: "p10" })).length, 0);
    } finally {
      fake.close();
    }
  });
});

/*
 * A partial unban narrows the decision instead of ending it.
 *
 * The unban dialog lets staff lift a ban on SOME of the servers it covers — and the record used
 * to answer any unban by stamping every decision of that kind lifted in full. A community-wide
 * ban lifted on one server then showed as over while the game still enforced it everywhere else,
 * and an armed reconciler would have read those live bans as strays and removed them — finishing
 * an unban nobody asked for.
 */
test("unbanning on one server narrows a community-wide decision; unbanning the rest ends it", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const a = await fakeGameServer(base, token, "one");
    const b = await fakeGameServer(base, token, "two");
    try {
      // A community-wide ban: lands on both servers, one decision with the standing rule.
      const ban = await jsonFetch(`${base}/api/servers/${a.serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: "p77", reason: "r", scope: { mode: "all" } }),
      });
      assert.equal(ban.status, 200, JSON.stringify(ban.body));
      assert.ok(a.fake.permaBans.has("p77") && b.fake.permaBans.has("p77"), "banned on both");

      // Lift it on server A only — the game side clears there and nowhere else.
      const partial = await jsonFetch(`${base}/api/servers/${a.serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_perma", playerId: "p77", serverIds: [a.serverId] }),
      });
      assert.equal(partial.status, 200, JSON.stringify(partial.body));
      assert.equal(a.fake.permaBans.has("p77"), false, "lifted on A");
      assert.equal(b.fake.permaBans.has("p77"), true, "still banned on B");

      // The decision is still ACTIVE, narrowed to exclude A — and still a standing rule, so a
      // server added next month inherits it.
      const active = await repo.playerBans.list({ playerId: "p77", activeOnly: true });
      assert.equal(active.length, 1, "the decision survives the partial lift");
      const scope = active[0]!.scope as { mode: string; serverIds?: string[] };
      assert.equal(scope.mode, "except");
      assert.deepEqual(scope.serverIds, [a.serverId]);

      // Lifting the remaining server ends the decision for real.
      const rest = await jsonFetch(`${base}/api/servers/${b.serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_perma", playerId: "p77", serverIds: [b.serverId] }),
      });
      assert.equal(rest.status, 200, JSON.stringify(rest.body));
      assert.equal((await repo.playerBans.list({ playerId: "p77", activeOnly: true })).length, 0, "now lifted");
      const rows = await repo.playerBans.list({ playerId: "p77" });
      assert.equal(rows.length, 1, "one decision, lifted — never deleted");
      assert.ok(rows[0]!.liftedAt);
    } finally {
      a.fake.close();
      b.fake.close();
    }
  });
});

test("the seed reads the game's ban lists, collapses community-wide bans, and re-runs clean", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const a = await fakeGameServer(base, token, "one");
    const b = await fakeGameServer(base, token, "two");
    try {
      // Banned everywhere → should collapse to the rule. Banned on one → stays a literal list.
      a.fake.permaBans.set("pAll", { playerId: "pAll", playerName: "Everywhere", reason: "cheating", by: "old-admin" });
      b.fake.permaBans.set("pAll", { playerId: "pAll", playerName: "Everywhere", reason: "cheating", by: "old-admin" });
      a.fake.tempBans.set("pOne", { playerId: "pOne", reason: "spam", by: "old-admin", hours: 48 });

      const r = await jsonFetch(`${base}/api/bans/seed`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.created, 2);
      assert.equal(r.body.collapsed, 1);

      const all = (await repo.playerBans.list({ playerId: "pAll" }))[0]!;
      assert.deepEqual(all.scope, { mode: "all" }, "banned on every server means the community");
      assert.equal(all.playerName, "Everywhere");
      const one = (await repo.playerBans.list({ playerId: "pOne" }))[0]!;
      assert.deepEqual(one.scope, { mode: "servers", serverIds: [a.serverId] });
      assert.equal(one.kind, "temp");
      assert.ok(one.expiresAt, "a game temp ban seeds a real expiry date");

      // Re-running duplicates nothing: everything found is already on record.
      const again = await jsonFetch(`${base}/api/bans/seed`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(again.body.created, 0, JSON.stringify(again.body));
      assert.equal(again.body.skippedExisting, 2);

      // And the Bans page reads the decisions — no audit replay, no 500-entry window.
      const page = await jsonFetch(`${base}/api/bans`, { headers: auth });
      const rows = page.body.bans as { playerId: string; scope: { mode: string }; active: boolean }[];
      assert.equal(rows.length, 2);
      assert.ok(rows.every((x) => x.active));
      assert.equal(rows.find((x) => x.playerId === "pAll")?.scope.mode, "all");
    } finally {
      a.fake.close();
      b.fake.close();
    }
  });
});

/*
 * An unban that would change nothing must not report success.
 *
 * This is the failure staff hit on HLL: Vietnam. `RemovePermanentBan` takes an id and drops the
 * matching entry; handed an id the server has never heard of — a Steam64 where the game keys
 * everyone by a per-game EOS id, or a record imported under the other game's namespace — it does
 * exactly as asked, matches nothing, and answers 200. Every layer above read that as a clean lift:
 * the route returned ok, the audit trail recorded an unban, the decision was stamped lifted, and
 * the player stayed banned. The ban list is the only thing that knew, so it gets asked first.
 */
test("an unban the server cannot act on is refused, not reported as done", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token, "vietnam", "hllv");
    try {
      // The game holds a ban under the id it actually uses…
      const eos = "0002bd1f4c7a4e2b9f61aa0c3d5e7788";
      await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: eos, reason: "griefing" }),
      });
      assert.ok(fake.permaBans.has(eos), "the fake server recorded the ban");

      // …and a decision recorded under the OTHER game's namespace is asked to lift it.
      const steam64 = "76561198000000123";
      await repo.playerBans.create({
        game: "hllv", playerId: steam64, playerName: "Same human, wrong id", kind: "perma",
        reason: "imported", scope: { mode: "servers", serverIds: [serverId] },
        expiresAt: null, createdByName: "import",
      });
      const un = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_perma", playerId: steam64 }),
      });

      // 409, not 502: the caller may do this, the server just has nothing to do it to. A 502
      // would send staff looking at the connection, which is the one thing that is fine.
      assert.equal(un.status, 409, `expected a refusal, got ${JSON.stringify(un.body)}`);
      // The message has to name the cause, or staff just click the button again.
      const said = JSON.stringify(un.body);
      assert.match(said, /holds no perma ban under 76561198000000123/);
      assert.match(said, /EOS/, "and points at the namespace, which is the real fix");

      // Nothing moved: the real ban stands, and the decision is NOT stamped lifted.
      assert.ok(fake.permaBans.has(eos), "the ban the server actually holds is untouched");
      const rows = await repo.playerBans.list({ playerId: steam64 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.liftedAt, null, "a lift that did not happen must not be recorded");
      const audit = await repo.audit.list({ limit: 50 });
      assert.equal(audit.filter((a) => a.action === "player.unban_perma").length, 0, "no audit row for a no-op");

      // And the id the server DOES list still lifts cleanly — the guard is by fact, not by shape.
      const ok = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_perma", playerId: eos }),
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(fake.permaBans.has(eos), false, "the real ban is gone");
    } finally {
      fake.close();
    }
  });
});

/*
 * The Bans page's "Sync with game": a server that lost its ban file gets the standing decisions
 * replayed with the plan read first — the staff-driven twin of the armed worker sweep, born the
 * day the same wipe class took a whole VIP list.
 */
test("ban sync: dry-run names the gap; apply restores standing bans, lifts dead ones, leaves foreign alone", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      // Two standing decisions, landed on the game...
      await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: "cheat1", playerName: "Cheat One", reason: "aimbot" }),
      });
      await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "tempban", playerId: "hot1", hours: 48, reason: "cool off" }),
      });
      assert.equal(fake.permaBans.size + fake.tempBans.size, 2);

      // ...then the server loses its ban file. Nothing notices — that is the point of the button.
      fake.permaBans.clear(); fake.tempBans.clear();
      // And it holds one ban nobody decided in the panel (placed from the in-game console).
      fake.permaBans.set("console-ban", { playerId: "console-ban", reason: "by hand", by: "ingame" });

      // Dry-run: the plan names the two missing bans, writes nothing.
      const plan = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.equal(plan.body.applied, false);
      assert.equal((plan.body.apply as unknown[]).length, 2);
      assert.equal((plan.body.foreign as unknown[]).length, 1);
      assert.equal(fake.permaBans.size, 1, "a dry-run must not write");

      // Apply: both come back; the console ban is untouched; read-back proves the count moved.
      const r = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((r.body.restored as string[]).length, 2);
      assert.equal(r.body.before, 1);
      assert.equal(r.body.after, 3);
      assert.ok(fake.permaBans.has("cheat1"));
      assert.ok(fake.tempBans.has("hot1"));
      assert.ok(fake.permaBans.has("console-ban"), "foreign bans are never removed");
      // The temp ban keeps (roughly) its decision's remaining time, not a fresh 48h... within
      // rounding: the decision was minted moments ago, so the re-applied duration is still 48.
      assert.equal(fake.tempBans.get("hot1")?.hours, 48);

      // A decision lifted in the record while still enforced on the game is cleaned up too.
      const rows = await repo.playerBans.list({ playerId: "cheat1", activeOnly: true });
      await repo.playerBans.lift(rows[0]!.id, "admin");
      const r2 = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      assert.deepEqual(r2.body.lifted, ["cheat1"]);
      assert.equal(fake.permaBans.has("cheat1"), false);
    } finally {
      fake.close();
    }
  });
});

/*
 * A temp ban the game still lists after its own time ran out. HLL keeps the entry and refuses to
 * remove it — "(400) Request was invalid" — so a sync that tried failed on every finished ban (21
 * of 37 on a live WW2 server, all 24-hour team-kill bans from the day before). It now leaves them
 * be and says so, still lifts what is running, and names whoever the game does refuse.
 */
test("ban sync leaves a temp ban the game lists after its own time ran out, and names whoever it could not lift", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
      // Two 24-hour team-kill bans: one placed 30 hours ago (over), one 6 hours ago and since
      // unbanned in the record (still running on the game).
      fake.tempBans.set("tk-old", { playerId: "tk-old", playerName: "Gunplay", reason: "team kills", by: "rules", hours: 24, at: hoursAgo(30) });
      fake.tempBans.set("tk-new", { playerId: "tk-new", playerName: "Flashlight555", reason: "team kills", by: "rules", hours: 24, at: hoursAgo(6) });
      await repo.playerBans.create({ game: "hll", playerId: "tk-old", playerName: "Gunplay", kind: "temp", reason: "team kills", scope: { mode: "all" }, expiresAt: hoursAgo(6), createdByName: "rules", createdAt: hoursAgo(30) });
      const running = await repo.playerBans.create({ game: "hll", playerId: "tk-new", playerName: "Flashlight555", kind: "temp", reason: "team kills", scope: { mode: "all" }, expiresAt: hoursAgo(-18), createdByName: "rules", createdAt: hoursAgo(6) });
      await repo.playerBans.lift(running.id, "admin");

      const plan = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.deepEqual(plan.body.ranOut, [{ playerId: "tk-old", playerName: "Gunplay" }], "the finished ban is named as run out");
      assert.deepEqual(plan.body.lift, [{ playerId: "tk-new", kind: "temp" }], "the running one is still lifted");

      const removals = () => fake.received.filter((c) => c === "RemoveTemporaryBan").length;
      const r = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.lifted, ["tk-new"]);
      assert.deepEqual(r.body.skipped, [], "nothing refused: the finished ban was never sent");
      assert.equal(removals(), 1, "one removal, for the running ban");
      assert.ok(fake.tempBans.has("tk-old"), "the game goes on listing it, as HLL does");
      assert.deepEqual(r.body.ranOut, [{ playerId: "tk-old", playerName: "Gunplay" }]);

      // A ban the game does refuse is named, with the game's own answer.
      fake.tempBans.set("tk-new", { playerId: "tk-new", playerName: "Flashlight555", reason: "team kills", by: "rules", hours: 24, at: hoursAgo(6) });
      fake.failing.add("RemoveTemporaryBan");
      const refused = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      const skipped = refused.body.skipped as { playerId: string; playerName: string | null; reason: string }[];
      assert.equal(skipped.length, 1, JSON.stringify(refused.body));
      assert.equal(skipped[0]!.playerName, "Flashlight555");
      assert.match(skipped[0]!.reason, /removeTempBan failed/, "with the game's own answer");
    } finally {
      fake.close();
    }
  });
});

/*
 * The same finished bans with no decision behind them — another tool's, as an older CRCON's TK ban
 * on connect still placed them on the live WW2 server: they have run out, rather than been "placed
 * outside the panel", so nobody is asked to adopt a ban that holds nobody. One still running is
 * outside the panel exactly as before.
 */
test("ban sync counts a finished temp ban nobody decided as run out, never as placed outside the panel", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
      fake.tempBans.set("tk-done", { playerId: "tk-done", playerName: "Rifleman_A", reason: "team kill on connect", by: "by automated bot", hours: 24, at: hoursAgo(40) });
      fake.tempBans.set("tk-live", { playerId: "tk-live", playerName: "Rifleman_B", reason: "team kill on connect", by: "by automated bot", hours: 24, at: hoursAgo(8) });

      const plan = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: "{}" });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.deepEqual(plan.body.ranOut, [{ playerId: "tk-done", playerName: "Rifleman_A" }], "named off the game's own list");
      assert.deepEqual((plan.body.foreign as { playerId: string }[]).map((f) => f.playerId), ["tk-live"], "only the running one is outside the panel");

      const r = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.lifted, r.body.skipped], [[], []]);
      assert.equal(fake.received.filter((c) => c === "RemoveTemporaryBan").length, 0, "neither is ever sent");
      assert.deepEqual(r.body.ranOut, [{ playerId: "tk-done", playerName: "Rifleman_A" }]);
      assert.deepEqual((r.body.foreign as { playerId: string }[]).map((f) => f.playerId), ["tk-live"]);
    } finally {
      fake.close();
    }
  });
});

/*
 * Bans → Live is the game's own list, finished temp bans and all: each entry says whether its time
 * ran out by the game's own record, so the page can say so rather than offer an Unban it refuses.
 */
test("the live ban list flags a temp ban whose own time ran out", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
      fake.tempBans.set("tk-done", { playerId: "tk-done", playerName: "Rifleman_A", reason: "team kill on connect", by: "by automated bot", hours: 24, at: hoursAgo(40) });
      fake.tempBans.set("tk-live", { playerId: "tk-live", playerName: "Rifleman_B", reason: "team kill on connect", by: "by automated bot", hours: 24, at: hoursAgo(8) });
      // Long placed, and with hours on its entry: a perma ban still never runs out.
      fake.permaBans.set("cheat", { playerId: "cheat", playerName: "Rifleman_C", reason: "cheating", by: "admin", hours: 24, at: hoursAgo(5000) });

      const r = await jsonFetch(`${base}/api/servers/${serverId}/bans/live`, { headers: auth });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const flags = Object.fromEntries((r.body.bans as { playerId: string; ranOut: boolean }[]).map((b) => [b.playerId, b.ranOut]));
      assert.deepEqual(flags, { "tk-done": true, "tk-live": false, cheat: false }, "only the finished temp ban has run out — never a perma ban");
    } finally {
      fake.close();
    }
  });
});

/*
 * The other lie: the pre-check passes (the ban IS listed), the server answers 200 — and keeps
 * the entry anyway. Nothing in the response can tell that apart from success, so the list is
 * read back after the command, and a lift the list still shows is failed honestly: no audit
 * row, no decision stamped lifted, a 409 naming what actually happened.
 */
test("an unban the server accepted but did not perform is failed, not recorded", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token, "liar");
    try {
      const id = "76561198000000777";
      await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: id, reason: "cheating" }),
      });
      assert.ok(fake.permaBans.has(id));

      // The server starts answering 200 to Remove*Ban while deleting nothing.
      fake.unbanSilentlyFails = true;
      const un = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_perma", playerId: id }),
      });
      assert.equal(un.status, 409, `expected the lie to be caught, got ${JSON.stringify(un.body)}`);
      assert.match(JSON.stringify(un.body), /still holds/,
        "the refusal says the list kept the entry, not that the id was missing");

      // Nothing was recorded: the decision is not stamped lifted and no unban audit row exists.
      const rows = await repo.playerBans.list({ playerId: id });
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((r) => r.liftedAt === null), "a lift the list disproved is not recorded");
      const audit = await repo.audit.list({ limit: 50 });
      assert.equal(audit.filter((a) => a.action === "player.unban_perma").length, 0);

      // The server starts behaving again: the same click now lifts, records, and reports 200.
      fake.unbanSilentlyFails = false;
      const ok = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_perma", playerId: id }),
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(fake.permaBans.has(id), false);
      const lifted = await repo.playerBans.list({ playerId: id });
      assert.ok(lifted.some((r) => r.liftedAt !== null), "the real lift is recorded");
    } finally {
      fake.close();
    }
  });
});

test("bulk unbans are recorded only after the list confirms them", async () => {
  await withServer(async (base, repo) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token, "bulk-liar");
    try {
      const a = "76561198000000801";
      const b = "76561198000000802";
      for (const pid of [a, b]) {
        await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
          method: "POST", headers: auth,
          body: JSON.stringify({ action: "tempban", playerId: pid, reason: "tk", hours: 2 }),
        });
      }
      // The fake accepts both removals but drops NEITHER — the whole batch is a lie.
      fake.unbanSilentlyFails = true;
      const un = await jsonFetch(`${base}/api/servers/${serverId}/actions/bulk`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_temp", players: [{ playerId: a }, { playerId: b }] }),
      });
      // Nothing applied → the bulk route's own 409, and no decision was narrowed for either.
      assert.equal(un.status, 409, JSON.stringify(un.body));
      const rows = [...await repo.playerBans.list({ playerId: a }), ...await repo.playerBans.list({ playerId: b })];
      assert.ok(rows.length >= 2);
      assert.ok(rows.every((r) => r.liftedAt === null), "no bulk lift is recorded when the list kept both");

      // Honest server: the same bulk call lifts both, records both.
      fake.unbanSilentlyFails = false;
      const ok = await jsonFetch(`${base}/api/servers/${serverId}/actions/bulk`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "unban_temp", players: [{ playerId: a }, { playerId: b }] }),
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal((ok.body.applied as unknown[]).length, 2);
      assert.equal(fake.tempBans.size, 0);
    } finally {
      fake.close();
    }
  });
});

/*
 * A ban's stored reason is what staff TYPED. When ban sync carries it to a server that lost it,
 * the placeholders must fill for that player there — never reach the game as raw braces.
 */
test("ban sync fills a stored reason's placeholders for the player on the server it lands on", async () => {
  await withServer(async (base) => {
    const token = await ownerToken(base);
    const auth = { authorization: `Bearer ${token}` };
    const { fake, serverId } = await fakeGameServer(base, token);
    try {
      await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "permaban", playerId: "brace1", playerName: "Brace Face", reason: "{player_name}: cheating — appeal on Discord" }),
      });
      assert.match(fake.permaBans.get("brace1")!.reason, /^Brace Face: cheating/, "the first landing was filled");
      fake.permaBans.clear(); // the server loses its ban file
      const r = await jsonFetch(`${base}/api/servers/${serverId}/bans/reconcile`, { method: "POST", headers: auth, body: JSON.stringify({ apply: true }) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const back = fake.permaBans.get("brace1")!.reason;
      assert.match(back, /Brace Face: cheating — appeal on Discord/, "the replayed ban reads as the first one did");
      assert.doesNotMatch(back, /\{player_name\}/, "no raw placeholder reaches the game");
    } finally {
      fake.close();
    }
  });
});
