import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGameServer } from "./fake-hll-server.ts";
import { withServer } from "./harness.ts";

async function jsonFetch(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/*
 * A GAME of this scene's own.
 *
 * The fan-out tests below are about scope rules — "everywhere", "everywhere but", "the only
 * server there is" — and every one of them assumed the database held nothing but its own
 * servers. That is true per test on the in-memory store and false against Postgres, where the
 * file shares one database: "everywhere" reached the other tests' servers too, and "except the
 * only server there is" was not except-the-only-server at all.
 *
 * Rather than weaken the assertions to containment (which would stop them checking the thing
 * they exist to check), each scene registers its own game. Scope resolution is per game — a
 * standing rule never crosses one, which is itself a rule this file tests — so "everywhere" means
 * "everywhere in MY game" and the isolation comes from the product's own behaviour rather than
 * from hoping the table is empty.
 */
let gameSeq = 0;
async function ownGame(): Promise<string> {
  const { registerGame, HLL_GAME } = await import("@app/games");
  const id = `testgame${++gameSeq}`;
  registerGame({ ...HLL_GAME, id, label: `Test Game ${gameSeq}` });
  return id;
}

async function owner(base: string, game?: string): Promise<{ token: string; serverId: string; game: string }> {
  await jsonFetch(`${base}/api/auth/register`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "admin", password: "pw" }) });
  const token = login.body.token as string;
  const auth = { authorization: `Bearer ${token}` };
  // Create a server. Use a fast-refusing local address (127.0.0.1:1 → ECONNREFUSED instantly)
  // so the best-effort live-name resolution on create returns at once instead of hanging on a
  // TCP timeout. These action tests all return before the connect step anyway.
  const g = game ?? await ownGame();
  const created = await jsonFetch(`${base}/api/servers`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "t", game: g, host: "127.0.0.1", port: 1, password: "x" }),
  });
  return { token, serverId: (created.body.server as { id: string }).id, game: g };
}

test("action endpoint requires auth", async () => {
  await withServer(async (base) => {
    const r = await jsonFetch(`${base}/api/servers/whatever/actions`, { method: "POST", body: JSON.stringify({ action: "kick", playerId: "1" }) });
    assert.equal(r.status, 401);
  });
});

test("unknown action is rejected before any connection", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "explode", playerId: "1" }),
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body.error as { message?: string })?.message), /unknown action/);
  });
});

test("missing required field is rejected before any connection", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    // kick needs playerId
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "kick" }),
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body.error as { message?: string })?.message), /requires 'playerId'/);
    // message needs both playerId and message
    const r2 = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "message", playerId: "1" }),
    });
    assert.equal(r2.status, 400);
    assert.match(String((r2.body.error as { message?: string })?.message), /requires 'message'/);
  });
});

test("action on an unknown server is 404", async () => {
  await withServer(async (base) => {
    const { token } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/does-not-exist/actions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "kick", playerId: "1" }),
    });
    assert.equal(r.status, 404);
  });
});

/**
 * Ban length is one concept that five routes each parsed their own way. These pin the parser, and
 * in particular the two shapes that used to get through: a non-numeric string became NaN and was
 * handed to the game client, and Infinity passed a `> 0` check.
 */
test("a ban length that is not a number is refused before any connection", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    for (const hours of ["abc", "12h", {}, []]) {
      const res = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "tempban", playerId: "p1", reason: "r", hours }),
      });
      assert.equal(res.status, 400, `hours=${JSON.stringify(hours)} must be refused, got ${res.status}`);
      assert.match(String((res.body.error as { message?: string })?.message), /hours must be a number/);
    }
  });
});

test("a ban length of Infinity or a silly magnitude is refused", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    // "Infinity" parses to Infinity, which is > 0, so the old positive-hours check let it past.
    for (const hours of ["Infinity", 1e30, "1e30"]) {
      const res = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action: "tempban", playerId: "p1", reason: "r", hours }),
      });
      assert.equal(res.status, 400, `hours=${JSON.stringify(hours)} must be refused, got ${res.status}`);
      assert.match(String((res.body.error as { message?: string })?.message), /must be a number|at most/);
    }
    const negative = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: auth, body: JSON.stringify({ action: "tempban", playerId: "p1", reason: "r", hours: -5 }),
    });
    assert.equal(negative.status, 400);
    assert.match(String((negative.body.error as { message?: string })?.message), /cannot be negative/);
  });
});

test("a plausible ban length still gets through the parser to the connection attempt", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const res = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "tempban", playerId: "p1", reason: "r", hours: 24 }),
    });
    // The server points at a closed port, so a valid request fails at CONNECT, not at validation.
    // That is the positive control: 400 here would mean the parser rejected something legitimate.
    assert.notEqual(res.status, 400, JSON.stringify(res.body));
  });
});

/**
 * HLL: Vietnam identifies players by a per-game EOS id. A Steam64 handed to a Vietnam server is a
 * command the game accepts and applies to NOBODY — the silent no-op that made every pre-fix
 * Vietnam VIP grant do nothing — so the API refuses it with the reason instead of relaying it.
 */
test("a Steam64 aimed at a Vietnam server is refused with the reason, not relayed", async () => {
  await withServer(async (base) => {
    const { token } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    const created = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "vn", host: "127.0.0.1", port: 1, password: "x", game: "hllv" }),
    });
    const vnId = (created.body.server as { id: string }).id;
    const steam64 = "76561198000000001";

    const kicked = await jsonFetch(`${base}/api/servers/${vnId}/actions`, {
      method: "POST", headers: auth, body: JSON.stringify({ action: "kick", playerId: steam64 }),
    });
    assert.equal(kicked.status, 400, JSON.stringify(kicked.body));
    assert.match(String((kicked.body.error as { message?: string })?.message), /EOS id/);

    // An EOS-shaped id passes the guard and fails at CONNECT (closed port) — the positive control.
    const eosKick = await jsonFetch(`${base}/api/servers/${vnId}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "kick", playerId: "0002b45a7f5d4e8d9c1f000000000001" }),
    });
    assert.notEqual(eosKick.status, 400, JSON.stringify(eosKick.body));

    // Unbans are exempt: a record stored under the wrong id must stay liftable, so this too gets
    // past validation to the connection attempt.
    const unban = await jsonFetch(`${base}/api/servers/${vnId}/actions`, {
      method: "POST", headers: auth, body: JSON.stringify({ action: "unban_perma", playerId: steam64 }),
    });
    assert.notEqual(unban.status, 400, JSON.stringify(unban.body));

    // A VIP grant refuses BEFORE storing anything — no dead grant row the game will never honor.
    const vip = await jsonFetch(`${base}/api/servers/${vnId}/vips`, {
      method: "POST", headers: auth, body: JSON.stringify({ playerId: steam64, mode: "permanent", comment: "donor" }),
    });
    assert.equal(vip.status, 409, JSON.stringify(vip.body));
    assert.match(String((vip.body.error as { message?: string })?.message), /EOS id/);
    const rows = await jsonFetch(`${base}/api/servers/${vnId}/vips`, { headers: auth });
    const list = (rows.body.vips ?? rows.body.items ?? []) as { playerId: string }[];
    assert.ok(!list.some((v) => v.playerId === steam64), "no VIP row was stored for the unusable id");

    // The same Steam64 on a WW2 server sails through validation (fails at CONNECT, not at 400).
    const ww2 = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "ww2", host: "127.0.0.1", port: 1, password: "x" }),
    });
    const ww2Id = (ww2.body.server as { id: string }).id;
    const ww2Kick = await jsonFetch(`${base}/api/servers/${ww2Id}/actions`, {
      method: "POST", headers: auth, body: JSON.stringify({ action: "kick", playerId: steam64 }),
    });
    assert.notEqual(ww2Kick.status, 400, JSON.stringify(ww2Kick.body));
  });
});

/*
 * Multi-server bans.
 *
 * A ban lives in one game server's ban list, so "banned from the community" used to mean repeating
 * yourself per server and remembering to repeat the unban too. `serverIds` names the set instead.
 *
 * The servers in these tests point at a closed port, so nothing reaches a game: what is under test
 * is the ROUTING — which servers get attempted, which are refused and why, and whether the refusal
 * is the request's failure or one line of a report. The write itself is the same `client.execute`
 * call it always was, now in a loop.
 */

/** A second and third server, so "any combination" has something to combine. */
async function threeServers(base: string, token: string, game?: string): Promise<string[]> {
  const auth = { authorization: `Bearer ${token}` };
  const ids: string[] = [];
  for (const name of ["two", "three"]) {
    const r = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name, ...(game ? { game } : {}), host: "127.0.0.1", port: 1, password: "x" }),
    });
    ids.push((r.body.server as { id: string }).id);
  }
  return ids;
}

/** A staff account holding one capability on a named set of servers, and nothing else. */
let modSeq = 0;
async function scopedStaff(base: string, ownerToken: string, capability: string, serverIds: string[]) {
  const auth = { authorization: `Bearer ${ownerToken}` };
  // A NAME of its own. Usernames are unique community-wide, so a fixed "mod" meant the second
  // test to ask for one got a conflict instead of an account — and then read `.id` off nothing.
  const username = `mod${++modSeq}`;
  const created = await jsonFetch(`${base}/api/users`, {
    method: "POST", headers: auth, body: JSON.stringify({ username, password: "pw" }),
  });
  const userId = (created.body.user as { id: string }).id;
  const set = await jsonFetch(`${base}/api/users/${userId}/grants`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({ grants: serverIds.map((id) => ({ capability, level: "write", scopeType: "server", scopeId: id })) }),
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username, password: "pw" }) });
  return { authorization: `Bearer ${login.body.token as string}` };
}

test("serverIds is refused for actions that only mean anything where the player is", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    for (const action of ["kick", "punish", "message", "switch"]) {
      const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: auth,
        body: JSON.stringify({ action, playerId: "p1", message: "m", reason: "r", serverIds: [serverId] }),
      });
      assert.equal(r.status, 400, `${action} must refuse serverIds`);
      assert.match(String((r.body.error as { message?: string })?.message), /only for tempban/);
    }
  });
});

/*
 * A punish reaches the player as ONLY the reason text — the game's punish screen renders nothing
 * else we control — so a reason-less punish shows them a penalty with no explanation. One did,
 * and it cost an evening of "did staff just do that?". A kick stays reason-optional because our
 * "YOU HAVE BEEN KICKED" header makes even a blank one a complete message.
 */
test("a punish must say why; a kick need not", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    const bare = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: auth, body: JSON.stringify({ action: "punish", playerId: "p1" }),
    });
    assert.equal(bare.status, 400);
    assert.match(String((bare.body.error as { message?: string })?.message), /requires 'reason'/);
    // Same contract on the bulk route — it validates from the same table.
    const bulk = await jsonFetch(`${base}/api/servers/${serverId}/actions/bulk`, {
      method: "POST", headers: auth, body: JSON.stringify({ action: "punish", players: [{ playerId: "p1" }] }),
    });
    assert.equal(bulk.status, 400);
    assert.match(String((bulk.body.error as { message?: string })?.message), /requires 'reason'/);
    // A kick with no reason gets past validation (it dies later at the unreachable game server,
    // which is a 502 — proof the contract, not the connection, is what refused the punish above).
    const kick = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: auth, body: JSON.stringify({ action: "kick", playerId: "p1" }),
    });
    assert.notEqual(kick.status, 400, JSON.stringify(kick.body));
  });
});

test("an empty serverIds is a mistake, not 'all servers'", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r", serverIds: [] }),
    });
    // Reading [] as "everywhere" would turn a UI bug into a community-wide ban.
    assert.equal(r.status, 400);
    assert.match(String((r.body.error as { message?: string })?.message), /at least one server/);
  });
});

test("a ban names its servers and reports each one separately", async () => {
  await withServer(async (base) => {
    const { token, serverId, game } = await owner(base);
    const [two] = await threeServers(base, token, game);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r", serverIds: [serverId, two!, "not-a-server"] }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const results = r.body.results as { serverId: string; ok: boolean; error?: string }[];
    assert.equal(results.length, 3, "one line per named server, including the bogus one");
    assert.deepEqual(results.map((x) => x.serverId).sort(), [serverId, two!, "not-a-server"].sort());
    assert.match(String(results.find((x) => x.serverId === "not-a-server")?.error), /no such server/);
    // Nothing is listening on any of them, so nothing applied — and `ok` says so rather than
    // reporting success because the request itself was well formed.
    assert.equal(r.body.ok, false);
    assert.equal(r.body.applied, 0);
    assert.equal(r.body.failed, 3);
  });
});

test("a moderator bans on the servers they hold, not the one they are pinned to", async () => {
  await withServer(async (base) => {
    const { token, serverId, game } = await owner(base);
    const [two, three] = await threeServers(base, token, game);
    // Permission on #2 and #3 only — and the request is ADDRESSED to #1, exactly as it would be
    // if their panel were pinned there. Requiring the path server too would refuse the whole thing.
    const mod = await scopedStaff(base, token, "action.permaban", [two!, three!]);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: mod,
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r", serverIds: [serverId, two!, three!] }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const results = r.body.results as { serverId: string; ok: boolean; error?: string }[];
    const denied = results.find((x) => x.serverId === serverId)!;
    assert.match(String(denied.error), /do not have action\.permaban/);
    // The two they DO hold were attempted — they fail at the closed port, not at the gate.
    for (const id of [two!, three!]) {
      assert.doesNotMatch(String(results.find((x) => x.serverId === id)?.error), /do not have/, `${id} was attempted`);
    }
  });
});

test("naming only servers you cannot act on is a refusal, not an empty report", async () => {
  await withServer(async (base) => {
    const { token, serverId, game } = await owner(base);
    const [two, three] = await threeServers(base, token, game);
    const mod = await scopedStaff(base, token, "action.permaban", [two!]);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: mod,
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r", serverIds: [serverId, three!] }),
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
});

test("unbans fan out the same way bans do", async () => {
  await withServer(async (base) => {
    const { token, serverId, game } = await owner(base);
    const [two] = await threeServers(base, token, game);
    for (const action of ["unban_temp", "unban_perma"]) {
      const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, playerId: "p1", serverIds: [serverId, two!] }),
      });
      // Lifting a ban has to reach as far as setting one, or a player stays banned somewhere
      // nobody thinks to look.
      assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.body)}`);
      assert.equal((r.body.results as unknown[]).length, 2, `${action} attempted both servers`);
    }
  });
});

test("the hour cap is applied per server, not once for the whole fan-out", async () => {
  await withServer(async (base) => {
    const { token, serverId, game } = await owner(base);
    const [two] = await threeServers(base, token, game);
    const auth = { authorization: `Bearer ${token}` };
    const created = await jsonFetch(`${base}/api/users`, {
      method: "POST", headers: auth, body: JSON.stringify({ username: "mod", password: "pw" }),
    });
    const userId = (created.body.user as { id: string }).id;
    // Two hours on #1, unlimited on #2. A cap that was read once from the path server would let
    // the tighter limit leak onto the other, or the looser one wash the tighter one away.
    const set = await jsonFetch(`${base}/api/users/${userId}/grants`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({
        grants: [
          { capability: "action.tempban", level: "write", scopeType: "server", scopeId: serverId },
          { capability: "action.tempban", level: "write", scopeType: "server", scopeId: two! },
        ],
        limits: { "tempban.maxHours": 2 },
      }),
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const login = await jsonFetch(`${base}/api/auth/login`, { method: "POST", body: JSON.stringify({ username: "mod", password: "pw" }) });
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: { authorization: `Bearer ${login.body.token as string}` },
      body: JSON.stringify({ action: "tempban", playerId: "p1", reason: "r", hours: 48, serverIds: [serverId, two!] }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const results = r.body.results as { serverId: string; ok: boolean; error?: string }[];
    // Both are capped at 2h by the account-wide limit, so both refuse 48 — and each says so on
    // its own line rather than one refusal standing in for servers it never looked at.
    for (const x of results) assert.match(String(x.error), /limit is 2h/, JSON.stringify(x));
  });
});

test("addressing one server keeps the old failure semantics exactly", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    // No serverIds: a connection failure is still the REQUEST's failure (502 upstream), not a
    // 200 carrying a report. Panels written against the old shape must not start seeing success.
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r" }),
    });
    assert.equal(r.status, 502, JSON.stringify(r.body));
  });
});

test("a ban cannot fan out to a server running a different game", async () => {
  // Player ids do not cross games: HLL keys players by Steam64/XPlay id, HLL: Vietnam by its own
  // per-game EOS id. Sending one game's id to the other's server would no-op at best and report
  // a success that never happened at worst — so the route refuses the mismatched target on its
  // own line and still tries the ones where the id means something.
  const { registerGame, HLL_GAME } = await import("@app/games");
  registerGame({ ...HLL_GAME, id: "othergame", label: "Other Game" });
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    const made = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "viet", game: "othergame", host: "127.0.0.1", port: 1, password: "x" }),
    });
    const otherId = (made.body.server as { id: string }).id;

    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "permaban", playerId: "76561198000000001", reason: "r", serverIds: [serverId, otherId] }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const results = r.body.results as { serverId: string; ok: boolean; error?: string }[];
    const other = results.find((x) => x.serverId === otherId);
    assert.ok(other && !other.ok, "the different-game server must be refused");
    assert.match(String(other!.error), /different game/, JSON.stringify(other));
    // The same-game target was still attempted (it fails on the dead test address, but with a
    // connection error — proof the guard didn't take it down too).
    const same = results.find((x) => x.serverId === serverId);
    assert.ok(same && !same.ok && !/different game/.test(String(same.error)), JSON.stringify(same));
  });
});

/*
 * Scope as a RULE.
 *
 * `serverIds` says which servers a ban reaches TODAY. It cannot say whether the staff member meant
 * "the community" or "those three", and only the first should cover a server we stand up next
 * month. These tests are about that distinction surviving the request — the write itself is the
 * same loop as above, still hitting a closed port.
 *
 * What the AUDIT ROW says about the rule is not asserted here, and cannot be: the row is written
 * after a successful `client.execute`, which never happens against a dead address. The phrasing is
 * covered by ban-scope.test.ts, which tests `describeBanScope` directly.
 */

test("'everywhere' reaches every server of the game without naming one", async () => {
  await withServer(async (base) => {
    const { token, serverId, game } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    const [two, three] = await threeServers(base, token, game);

    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r", scope: { mode: "all" } }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const hit = (r.body.results as { serverId: string }[]).map((x) => x.serverId).sort();
    assert.deepEqual(hit, [serverId, two, three].sort());
  });
});

test("'everywhere but' reaches the rest and skips the exception entirely", async () => {
  await withServer(async (base) => {
    const { token, serverId, game } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    const [two, three] = await threeServers(base, token, game);

    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r", scope: { mode: "except", serverIds: [two] } }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const hit = (r.body.results as { serverId: string }[]).map((x) => x.serverId).sort();
    // Not "attempted and refused" — an excluded server is not a target at all, so it produces no
    // line in the report. A row saying "skipped" would read as a failure to someone scanning it.
    assert.deepEqual(hit, [serverId, three].sort());
  });
});

test("a standing rule never crosses games, even saying 'everywhere'", async () => {
  const { registerGame, HLL_GAME } = await import("@app/games");
  registerGame({ ...HLL_GAME, id: "othergame2", label: "Other Game" });
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const auth = { authorization: `Bearer ${token}` };
    await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "viet", game: "othergame2", host: "127.0.0.1", port: 1, password: "x" }),
    });

    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "permaban", playerId: "76561198000000001", reason: "r", scope: { mode: "all" } }),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The other game's server is not even attempted: a Steam64 does not exist there, so there is
    // nothing to ban and nothing to report.
    assert.deepEqual((r.body.results as { serverId: string }[]).map((x) => x.serverId), [serverId]);
  });
});

test("a scope that covers nothing is refused rather than silently doing nothing", async () => {
  await withServer(async (base) => {
    const { token, serverId } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      // "everywhere except the only server there is" resolves to no target at all.
      body: JSON.stringify({ action: "permaban", playerId: "p1", reason: "r", scope: { mode: "except", serverIds: [serverId] } }),
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(String((r.body.error as { message?: string })?.message), /covers no/);
  });
});

/*
 * The game refusing a command is not an infrastructure fault — and must not be a 502. A 502 both
 * misdirects staff toward the connection AND gets replaced by proxies (Cloudflare-style) with a
 * bodyless page, which is how "player is offline" once reached a moderator as a naked "HTTP 502".
 * A refusal is a 409 with words: who wasn't there, or why the game said no.
 */
test("punishing a player who is not on the server is a 409 that says so, not a 502", async () => {
  await withServer(async (base) => {
    const { token } = await owner(base);
    const s = await fakeGameServer(base, token, "live");
    try {
      s.fake.players = [{ iD: "76561198000000201", name: "Alpha Wolf" }];
      const r = await jsonFetch(`${base}/api/servers/${s.serverId}/actions`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "punish", playerId: "76561198000000999", playerName: "GhostGuy", reason: "tk" }),
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      const msg = String((r.body.error as { message?: string })?.message);
      assert.match(msg, /GhostGuy is not on live right now/);
      assert.match(msg, /currently on this server/);
      assert.equal(s.fake.punished.length, 0);
    } finally { s.fake.close(); }
  });
});

test("a punish the game refuses for a present player explains the spawned-in rule", async () => {
  await withServer(async (base) => {
    const { token } = await owner(base);
    const s = await fakeGameServer(base, token, "live");
    try {
      s.fake.players = [{ iD: "76561198000000201", name: "Alpha Wolf" }];
      s.fake.punishRefusal = "Player is dead"; // what the real game does between death and redeploy
      const r = await jsonFetch(`${base}/api/servers/${s.serverId}/actions`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "punish", playerId: "76561198000000201", playerName: "Alpha Wolf", reason: "tk" }),
      });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(String((r.body.error as { message?: string })?.message), /spawned in/);
    } finally { s.fake.close(); }
  });
});

test("a punish that lands is a 200, audited, and reaches the game", async () => {
  await withServer(async (base) => {
    const { token } = await owner(base);
    const s = await fakeGameServer(base, token, "live");
    try {
      s.fake.players = [{ iD: "76561198000000201", name: "Alpha Wolf" }];
      const r = await jsonFetch(`${base}/api/servers/${s.serverId}/actions`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "punish", playerId: "76561198000000201", playerName: "Alpha Wolf", reason: "tk" }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true);
      assert.equal(s.fake.punished.length, 1);
      assert.match(s.fake.punished[0]!.reason, /tk/);
      const audit = await jsonFetch(`${base}/api/audit`, { headers: { authorization: `Bearer ${token}` } });
      assert.ok((audit.body.entries as { action: string }[]).some((e) => e.action === "player.punish"));
    } finally { s.fake.close(); }
  });
});

test("a server we cannot reach at all is still an upstream fault (502)", async () => {
  await withServer(async (base) => {
    // owner()'s server points at 127.0.0.1:1 — nothing listens, connect refuses instantly.
    const { token, serverId } = await owner(base);
    const r = await jsonFetch(`${base}/api/servers/${serverId}/actions`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "punish", playerId: "76561198000000201", reason: "tk" }),
    });
    assert.equal(r.status, 502, JSON.stringify(r.body));
  });
});

/*
 * The shape guard above is blind on console: BOTH games issue 32-hex EOS-style ids that look
 * identical, so a Vietnam id pasted at a WW2 server (or the reverse) passed shape validation,
 * the game accepted the ban, and it matched NOBODY — while the panel recorded a decision that
 * never banned anyone. The directory closes the gap: platform_id is the sole identity key and
 * each row's game is stamped at first sighting, so any id we have ever seen is an id whose game
 * we know.
 */
test("a console id the directory knows belongs to the OTHER game is refused, both directions", async () => {
  await withServer(async (base, repo) => {
    const { token } = await owner(base, "hll");
    const auth = { authorization: `Bearer ${token}` };
    const ww2 = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "ww2", host: "127.0.0.1", port: 1, password: "x", game: "hll" }),
    });
    const ww2Id = (ww2.body.server as { id: string }).id;
    const vn = await jsonFetch(`${base}/api/servers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ name: "vn", host: "127.0.0.1", port: 1, password: "x", game: "hllv" }),
    });
    const vnId = (vn.body.server as { id: string }).id;

    // The directory has seen both of them — each on their own game. Same 32-hex shape.
    const vietnamPlayer = "0002cb51e95e40538440e20a11491f36";
    const ww2Player = "00028c38e7b748799a502ce7c3d41616";
    await repo.players.upsert({ game: "hllv", platform: "xbox", platformId: vietnamPlayer, name: "CrimePays" });
    await repo.players.upsert({ game: "hll", platform: "xbox", platformId: ww2Player, name: "SchrockDaddy" });

    // Vietnam id aimed at the WW2 server: refused with the reason, and NO decision row written.
    const before = (await repo.playerBans.list()).length;
    const banned = await jsonFetch(`${base}/api/servers/${ww2Id}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "tempban", playerId: vietnamPlayer, hours: 2, reason: "tk" }),
    });
    assert.equal(banned.status, 400, JSON.stringify(banned.body));
    assert.match(String((banned.body.error as { message?: string })?.message), /do not cross games/);
    assert.equal((await repo.playerBans.list()).length, before, "a refused ban records no decision");

    // WW2 console id aimed at the Vietnam server — the direction shape can NEVER catch (it is
    // not Steam64-shaped). The directory catches it.
    const reverse = await jsonFetch(`${base}/api/servers/${vnId}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "kick", playerId: ww2Player }),
    });
    assert.equal(reverse.status, 400, JSON.stringify(reverse.body));
    assert.match(String((reverse.body.error as { message?: string })?.message), /do not cross games/);

    // The same id on ITS OWN game's server sails through validation (fails at CONNECT, not 400):
    // the guard must never lock a player out of the game they actually belong to.
    const own = await jsonFetch(`${base}/api/servers/${ww2Id}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "kick", playerId: ww2Player }),
    });
    assert.notEqual(own.status, 400, JSON.stringify(own.body));

    // An id the directory has NEVER seen still passes: banning a player by id before their first
    // sighting is the one workflow raw-id entry exists for.
    const unseen = await jsonFetch(`${base}/api/servers/${ww2Id}/actions`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ action: "kick", playerId: "000299999999999999999999999999ff" }),
    });
    assert.notEqual(unseen.status, 400, JSON.stringify(unseen.body));
  });
});
