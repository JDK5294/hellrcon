import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CrconClient, extractLogs } from "../src/protocol/crcon-bridge/client.ts";
import { CrconBridgeAdapter } from "../dist/protocol/crcon-bridge/adapter.js";

// Minimal table: the bridge only consults `access` (it refuses all writes).
const TEST_COMMANDS = { kickPlayer: { logical: "kickPlayer", access: "write" as const } };

test("extractLogs handles ParsedLogsType and a bare array", () => {
  assert.equal(extractLogs({ logs: [{ raw: "a" }] }).length, 1);
  assert.equal(extractLogs([{ raw: "a" }, { raw: "b" }]).length, 2);
  assert.equal(extractLogs({ nope: 1 }).length, 0);
});

/** Fake CRCON: checks the Bearer key and answers with CRCON's `{ result, failed }` envelope. */
function fakeCrcon(apiKey: string): Promise<{ server: Server; base: string; seenAuth: string[] }> {
  const seenAuth: string[] = [];
  const server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result: null, failed: true, error: "bad key" }));
    }
    const url = new URL(req.url ?? "", "http://x");
    const send = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result, failed: false, error: null }));
    };
    if (url.pathname === "/api/get_gamestate") return send({ raw_time_remaining: "0:10:00", num_allied_players: 40 });
    if (url.pathname === "/api/get_players") return send([{ name: "Alice", player_id: "111" }]);
    if (url.pathname === "/api/get_recent_logs") {
      return send({
        actions: [],
        players: [],
        logs: [
          { timestamp_ms: Date.now(), raw: "KILL: Alice(Allies/111) -> Bob(Axis/222) with M1 GARAND" },
          { timestamp_ms: Date.now() - 3_600_000, raw: "OLD: should be filtered by the window" },
        ],
      });
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: null, failed: true, error: "unknown" }));
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seenAuth })),
  );
}

test("client sends the Bearer key and unwraps result", async () => {
  const { server, base } = await fakeCrcon("KEY");
  try {
    const client = new CrconClient({ baseUrl: base, apiKey: "KEY" });
    const players = (await client.get("get_players")) as { name: string }[];
    assert.equal(players[0]!.name, "Alice");
  } finally {
    server.close();
  }
});

test("client surfaces a bad key as an error", async () => {
  const { server, base } = await fakeCrcon("KEY");
  try {
    const client = new CrconClient({ baseUrl: base, apiKey: "WRONG" });
    await assert.rejects(() => client.get("get_players"), /rejected the API key/);
  } finally {
    server.close();
  }
});

test("adapter connects, reads log RAW lines within the window, and refuses writes", async () => {
  const { server, base } = await fakeCrcon("KEY");
  try {
    const adapter = new CrconBridgeAdapter(TEST_COMMANDS);
    await adapter.connect({ host: "ignored", port: 0, password: "KEY", crconBaseUrl: base });

    const lines = await adapter.readLogLines(60);
    assert.equal(lines.length, 1); // the hour-old entry is outside the 60s window
    assert.match(lines[0]!, /KILL: Alice/);

    // This fake serves no get_detailed_players (an older CRCON), so this is the FALLBACK path:
    // plain get_players still yields identity — player_id mapped to the protocol's `iD` spelling
    // that playerIdentityOf and every roster consumer read.
    const players = (await adapter.readState("players")) as { name: string; iD: string }[];
    assert.equal(players[0]!.name, "Alice");
    assert.equal(players[0]!.iD, "111");

    // read-only by design — writes rejected regardless of engagement mode
    await assert.rejects(() => adapter.execute("kickPlayer", { playerId: "1" }), /read-only/);

    await adapter.disconnect();
  } finally {
    server.close();
  }
});

/*
 * The bridge's roster reads must come back in the GAME PROTOCOL's shape, not CRCON's. CRCON says
 * team "allies"/"axis" and role "heavymachinegunner"; every consumer of a roster read — player
 * identity (`iD`), the stats sampler (numeric team/role, `scoreData.cOMBAT`), squad composition
 * (`platoon`) — reads the shape a direct v2 connection reports. When the bridge returned CRCON's
 * dicts verbatim, none of them could read a bridge-sourced roster, and the observe path silently
 * recorded no players and no stats at all.
 */
test("bridge roster reads come back in the game protocol's shape, not CRCON's", async () => {
  const detailed = {
    fail_count: 0,
    players: {
      "76561198000000001": {
        name: "Abu", player_id: "76561198000000001", team: "allies", role: "heavymachinegunner",
        level: 152, loadout: "standard issue", unit_id: 0, unit_name: "able",
        kills: 12, deaths: 3, team_kills: 1, vehicle_kills: 2, vehicles_destroyed: 1,
        combat: 188, offense: 340, defense: 120, support: 65,
        platform: "steam", clan_tag: "LYNX", eos_id: "0002abcd", is_vip: true,
      },
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6": {
        name: "Cdr", player_id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", team: "axis", role: "armycommander",
        level: 89, loadout: "standard issue", unit_id: -1, unit_name: "command",
        kills: 1, deaths: 0, team_kills: 0, vehicle_kills: 0, vehicles_destroyed: 0,
        combat: 20, offense: 0, defense: 40, support: 300, platform: "epic", clan_tag: "", eos_id: "",
      },
      // Vocabulary CRCON adds after this table was written must degrade to "unassigned" — the
      // failure mode this guards is a NaN key accumulating seconds in the role clocks.
      "76561198000000002": {
        name: "New", player_id: "76561198000000002", team: "somethingnew", role: "futurerole",
        level: 3, unit_name: "unassigned", kills: 0, deaths: 0, combat: 0, offense: 0, defense: 0, support: 0,
      },
    },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const send = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result, failed: false, error: null }));
    };
    if (url.pathname === "/api/get_gamestate") return send({});
    if (url.pathname === "/api/get_detailed_players") return send(detailed);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: null, failed: true, error: "unknown" }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const adapter = new CrconBridgeAdapter(TEST_COMMANDS);
    await adapter.connect({ host: "ignored", port: 0, password: "KEY", crconBaseUrl: base });
    const roster = (await adapter.readState("players")) as Record<string, unknown>[];
    assert.equal(roster.length, 3);

    const abu = roster.find((r) => r.name === "Abu")!;
    assert.equal(abu.iD, "76561198000000001", "player_id becomes the protocol's iD");
    assert.equal(abu.team, 1, "'allies' becomes the protocol's team value");
    assert.equal(abu.role, 6, "'heavymachinegunner' becomes role 6");
    assert.equal(abu.level, 152);
    assert.equal(abu.platoon, "ABLE");
    assert.equal((abu.scoreData as Record<string, unknown>).cOMBAT, 188, "the server's own cOMBAT spelling");
    assert.equal((abu.scoreData as Record<string, unknown>).support, 65);
    assert.equal((abu.stats as Record<string, unknown>).vehicleKills, 2);
    assert.equal(abu.clanTag, "LYNX");
    assert.equal(abu.eosId, "0002abcd");

    const cdr = roster.find((r) => r.name === "Cdr")!;
    assert.equal(cdr.team, 0, "'axis' becomes the protocol's team value");
    assert.equal(cdr.role, 13, "'armycommander' is the Commander role");
    assert.equal(cdr.platoon, "", "'command' is CRCON's synthetic unit, not a squad");

    const unk = roster.find((r) => r.name === "New")!;
    assert.equal(unk.team, null, "an unknown team string degrades to unassigned…");
    assert.equal(unk.role, null, "…and an unknown role never becomes a NaN clock key");
  } finally {
    server.close();
  }
});

test("bridge reads the map rotation instead of rejecting the kind", async () => {
  // Every caller tolerates a failed rotation read, so when this kind fell through to the adapter's
  // "unknown state kind" default, a bridge-sourced server simply showed an empty rotation — on the
  // Maps view, the status board and the vote preview — and said nothing about why. CRCON returns
  // its own flattened shape; the game's reader already accepts it.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const send = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result, failed: false, error: null }));
    };
    if (url.pathname === "/api/get_gamestate") return send({});
    if (url.pathname === "/api/get_map_rotation") return send({ maps: ["carentan_warfare", "foy_warfare", "hill400_warfare"], current_index: 1 });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: null, failed: true, error: "unknown" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const adapter = new CrconBridgeAdapter(TEST_COMMANDS);
    await adapter.connect({ host: "ignored", port: 0, password: "KEY", crconBaseUrl: base });
    const rot = (await adapter.readState("maprotation")) as { maps: string[]; current_index: number };
    assert.deepEqual(rot.maps, ["carentan_warfare", "foy_warfare", "hill400_warfare"]);
    assert.equal(rot.current_index, 1);
  } finally {
    server.close();
  }
});

test("recentLogs hands CRCON's newest-first list over in chronological order", async () => {
  const { server, base } = await fakeCrcon("KEY");
  try {
    const client = new CrconClient({ baseUrl: base, apiKey: "KEY" });
    const logs = await client.recentLogs(10);
    assert.equal(logs.length, 2);
    // The fake serves newest-first, as real CRCON does (its log history is a newest-first list).
    // Ingest pairs each connect with its disconnect and buckets kills by "which match is open at
    // this point in the batch", so the client must deliver oldest-first — this returned as-is
    // for a long time while its own comment claimed otherwise.
    assert.ok(logs[0]!.timestamp_ms! < logs[1]!.timestamp_ms!, "oldest entry first");
    assert.match(logs[1]!.raw!, /KILL: Alice/);
  } finally {
    server.close();
  }
});

test("adapter requires a crconBaseUrl", async () => {
  const adapter = new CrconBridgeAdapter(TEST_COMMANDS);
  await assert.rejects(() => adapter.connect({ host: "x", port: 0, password: "KEY" }), /requires crconBaseUrl/);
});

test("client serializes requests and spaces them by minIntervalMs", async () => {
  /*
   * Third attempt at this test, and the first that cannot flake. The first two measured real
   * wall-clock gaps between arrivals at a local server, and under the full turbo battery the
   * OS scheduler compressed or stretched the observed gaps past any margin we picked — 30ms
   * flaked (#305), then 60ms flaked again. The queue was always spacing sends correctly; the
   * measurement was jittering.
   *
   * So measure the DECISIONS, not the clock. The client takes an injected `now`/`sleep`; fake
   * time only advances when the governor sleeps, so the waits it requests are exact numbers:
   * with a 120ms interval and instant responses, request 1 waits nothing and every later one
   * waits exactly 120. Serialization is asserted where it is true or false regardless of load —
   * the server counts in-flight requests, which must never exceed one.
   */
  let t = 1_000_000; // far from lastStart's epoch-0 default, as a real clock is
  const waits: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const server = createServer((req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(new URL(req.url ?? "/", "http://x").pathname.split("/").pop() ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: [], failed: false }));
    res.on("finish", () => { inFlight -= 1; });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new CrconClient({
      baseUrl: base, apiKey: "K", minIntervalMs: 120,
      now: () => t,
      sleep: async (ms) => { waits.push(ms); t += ms; },
    });
    await Promise.all([client.get("a"), client.get("b"), client.get("c"), client.get("d")]);
    assert.deepEqual(order, ["a", "b", "c", "d"], "the queue preserves call order");
    assert.equal(maxInFlight, 1, "at most one request is ever in flight");
    // The first request finds the interval already elapsed; each of the other three is held for
    // the full gap, because fake time does not move while a request is being served.
    assert.deepEqual(waits, [120, 120, 120], "the governor spaces every consecutive start by the interval");
  } finally {
    server.close();
  }
});

test("client retries transient 503s then succeeds", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits < 3) { // fail twice, then serve
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      return res.end(JSON.stringify({ result: null, failed: true }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: { ok: true }, failed: false }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new CrconClient({ baseUrl: base, apiKey: "K", minIntervalMs: 0, maxRetries: 3 });
    const out = (await client.get("flaky")) as { ok: boolean };
    assert.equal(out.ok, true);
    assert.equal(hits, 3); // two retries then success
  } finally {
    server.close();
  }
});

test("client gives up after maxRetries and surfaces the error", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ result: null, failed: true }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = new CrconClient({ baseUrl: base, apiKey: "K", minIntervalMs: 0, maxRetries: 2 });
    await assert.rejects(() => client.get("always503"), /503/);
  } finally {
    server.close();
  }
});

/*
 * The bridge talks HTTP to somebody else's CRCON install, and `fetch` resolves as soon as the
 * HEADERS arrive — the body is read separately, afterwards. The request timeout was cleared the
 * moment fetch resolved, so it never covered the part that actually carries the data, and nothing
 * bounded its size either.
 *
 * Measured against an endpoint answering with an endless JSON array: 110 seconds and 1,961 MB
 * resident, on a client whose declared timeout is ten seconds, ending in zero usable rows. This
 * runs inside the worker that holds every server's connection.
 */
test("crcon bridge: an endless response body is refused, not swallowed", async () => {
  let stop = false;
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"result":{"logs":[');
    const row = JSON.stringify({ timestamp_ms: 1, raw: "x".repeat(4000) }) + ",";
    const pump = () => { while (!stop && res.write(row)) { /* never finish */ } };
    res.on("drain", pump);
    pump();
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const c = new CrconClient({ baseUrl: base, apiKey: "k", maxRetries: 0 });
    const t0 = Date.now();
    await assert.rejects(() => c.recentLogs(10), /exceeded \d+ bytes/, "an unbounded body must fail the call");
    // Fast, because the stream is cancelled at the budget rather than read to its end. Without the
    // cap this took nearly two minutes.
    assert.ok(Date.now() - t0 < 30_000, `refusing took ${Date.now() - t0}ms — the stream is not being cancelled`);
  } finally {
    stop = true;
    server.close();
  }
});

test("crcon bridge: an over-large Content-Length is refused before the body is read", async () => {
  // When the server declares the size there is no reason to stream 2 GB to find out.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": String(64 * 1024 * 1024) });
    res.end("{}"); // never actually sent in full; the client should not get this far
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const c = new CrconClient({ baseUrl: base, apiKey: "k", maxRetries: 0 });
    await assert.rejects(() => c.recentLogs(10), /declares \d+ bytes/);
  } finally {
    server.close();
  }
});

test("crcon bridge: an over-large body is fatal, not retried", async () => {
  // Re-requesting a body that is too big just downloads it again, three more times, for the same
  // answer — so this is a CrconBridgeError, not a transient one.
  let requests = 0;
  let stop = false;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = "x".repeat(1 << 20);
    const pump = () => { while (!stop && res.write(chunk)) { /* keep going */ } };
    res.on("drain", pump);
    pump();
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const c = new CrconClient({ baseUrl: base, apiKey: "k", maxRetries: 3, minIntervalMs: 0 });
    await assert.rejects(() => c.recentLogs(10), /exceeded/);
    assert.equal(requests, 1, `a too-large body was requested ${requests} times`);
  } finally {
    stop = true;
    server.close();
  }
});

test("crcon bridge: an ordinary response is unaffected, and non-JSON is still tolerated", async () => {
  // The cap is a backstop, not a new limit — and a proxy's HTML error page must still read as an
  // empty result rather than throwing with a stack full of markup.
  const big = Array.from({ length: 2_000 }, (_, i) => ({ timestamp_ms: i, raw: `line ${i}` }));
  const server = createServer((req, res) => {
    if ((req.url ?? "").includes("get_recent_logs")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result: { logs: big }, failed: false }));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>gateway error</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const c = new CrconClient({ baseUrl: base, apiKey: "k", maxRetries: 0, minIntervalMs: 0 });
    assert.equal((await c.recentLogs(2000)).length, 2_000, "a real response of thousands of rows still arrives whole");
    assert.deepEqual(await c.get("get_gamestate"), {}, "an HTML error page reads as empty, not as a throw");
  } finally {
    server.close();
  }
});
