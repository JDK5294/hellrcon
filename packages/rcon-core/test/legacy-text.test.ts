import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { xorCrypt } from "../src/protocol/legacy-text/xor.ts";
import { parsePlayerIds, parseShowLog } from "../src/protocol/legacy-text/parse.ts";
// Transport + adapter import sibling `./x.js` modules, so they must come from the built dist
// (strip-types can't follow those); the package's test script runs `tsc -b` first.
import { LegacyTextConnection } from "../dist/protocol/legacy-text/connection.js";
import { LegacyTextAdapter } from "../dist/protocol/legacy-text/adapter.js";

// Minimal command table — unit tests exercise the ADAPTER MECHANICS, not a game's real table
// (game tables live in @app/games and are tested there).
const TEST_COMMANDS = {
  getPlayers: { logical: "getPlayers", access: "read" as const, legacyText: { build: () => "Get PlayerIds" } },
  getAdminLog: { logical: "getAdminLog", access: "read" as const, legacyText: { build: (p: Record<string, unknown>) => `ShowLog ${Math.max(1, Math.ceil(Number(p.seconds ?? 60) / 60))}` } },
  kickPlayer: { logical: "kickPlayer", access: "write" as const, legacyText: { build: (p: Record<string, unknown>) => `Kick "${p.playerId}" "${p.reason ?? ""}"` } },
  getObjectives: { logical: "getObjectives", access: "read" as const },
};

// ---- pure units ----
test("xorCrypt is its own inverse and cycles the key", () => {
  const key = Buffer.from([9, 42, 7, 200]);
  const msg = Buffer.from("Login hunter2 — with spaces", "utf8");
  const enc = xorCrypt(msg, key);
  assert.notDeepEqual(enc, msg);
  assert.deepEqual(xorCrypt(enc, key), msg);
});

test("parsePlayerIds drops the count and splits name : uid", () => {
  const { players } = parsePlayerIds("2\t(ABC) Kestrel : 76561198000000042\tAnotherName : 12345678901234567\t");
  assert.equal(players.length, 2);
  assert.deepEqual(players[0], { name: "(ABC) Kestrel", iD: "76561198000000042" });
  assert.equal(players[1]!.iD, "12345678901234567");
});

test("parseShowLog handles EMPTY and newline splitting", () => {
  assert.deepEqual(parseShowLog("EMPTY"), []);
  assert.deepEqual(parseShowLog("line one\nline two\n"), ["line one", "line two"]);
});

// ---- transport + adapter against a fake XOR server ----
const KEY = Buffer.from([13, 37, 88, 200, 5]);

/** A tiny stand-in for a legacy HLL server: sends the XOR key on connect, then answers the
 *  XOR-encoded command lines it receives. `password` decides whether Login succeeds. */
function fakeServer(password: string): Promise<{ server: Server; port: number }> {
  const server = createServer((socket: Socket) => {
    socket.write(KEY); // key first, in the clear
    socket.on("data", (buf) => {
      const cmd = xorCrypt(buf, KEY).toString("utf8");
      const reply = (text: string) => socket.write(xorCrypt(Buffer.from(text, "utf8"), KEY));
      if (cmd.startsWith("Login ")) return reply(cmd === `Login ${password}` ? "SUCCESS" : "FAIL");
      if (cmd === "Get PlayerIds") return reply("2\tAlice : 111\tBob : 222\t");
      if (cmd.startsWith("ShowLog")) return reply("[1 sec (100)] KILL: Alice(Allies/111) -> Bob(Axis/222) with M1 GARAND");
      if (cmd.startsWith("Message ") || cmd.startsWith("Kick ") || cmd.startsWith("PermaBan ")) return reply("SUCCESS");
      reply("FAIL");
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

test("connects, logs in, and reads players + logs over the XOR transport", async () => {
  const { server, port } = await fakeServer("secret");
  try {
    const adapter = new LegacyTextAdapter(TEST_COMMANDS);
    await adapter.connect({ host: "127.0.0.1", port, password: "secret" });

    const players = (await adapter.readState("players")) as { players: { name: string; iD: string }[] };
    assert.equal(players.players.length, 2);
    assert.equal(players.players[0]!.iD, "111");

    const lines = await adapter.readLogLines(60);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /KILL: Alice/);

    await adapter.disconnect();
  } finally {
    server.close();
  }
});

test("write commands succeed on SUCCESS and reads reject unsupported kinds", async () => {
  const { server, port } = await fakeServer("secret");
  try {
    const adapter = new LegacyTextAdapter(TEST_COMMANDS);
    await adapter.connect({ host: "127.0.0.1", port, password: "secret" });
    const r = await adapter.execute("kickPlayer", { playerId: "111", reason: "afk" });
    assert.deepEqual(r, { ok: true });
    await assert.rejects(() => adapter.execute("getObjectives"), /not supported on the legacy-text/);
    await assert.rejects(() => adapter.readState("session"), /does not expose 'session'/);
    await adapter.disconnect();
  } finally {
    server.close();
  }
});

test("wrong password fails the login", async () => {
  const { server, port } = await fakeServer("secret");
  try {
    const adapter = new LegacyTextAdapter(TEST_COMMANDS);
    await assert.rejects(() => adapter.connect({ host: "127.0.0.1", port, password: "nope" }), /login failed/);
  } finally {
    server.close();
  }
});

test("LegacyTextConnection round-trips a raw command", async () => {
  const { server, port } = await fakeServer("secret");
  try {
    const conn = new LegacyTextConnection({ host: "127.0.0.1", port, password: "secret", idleMs: 40 });
    await conn.connect();
    const resp = await conn.send("Get PlayerIds");
    assert.match(resp, /Alice : 111/);
    conn.close();
  } finally {
    server.close();
  }
});

/*
 * The legacy transport has no length framing at all — a response is "everything until the socket
 * goes quiet" — so the only thing bounding a read was the 5-second hard timeout. Five seconds on a
 * LAN is hundreds of megabytes, and the endpoint deciding how much to send is the one we can trust
 * least: a game server having a bad day, a wrong port answering with somebody else's stream, or a
 * hostile one.
 *
 * Measured before the cap existed, against a server that simply never stops talking: the read did
 * not bloat, it KILLED THE PROCESS with ERR_STRING_TOO_LONG — thrown out of a timer callback, so
 * not even the caller's `await` could catch it. This process holds every server's connection.
 */
test("legacy-text: an endless response is refused instead of swallowed", async () => {
  let stopped = false;
  const accepted = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.write(KEY);
    socket.on("error", () => { /* we hang up on it; that is the point */ });
    socket.on("data", (buf) => {
      const cmd = xorCrypt(buf, KEY).toString("utf8");
      if (cmd.startsWith("Login ")) return void socket.write(xorCrypt(Buffer.from("SUCCESS"), KEY));
      // Never stop. Every chunk resets the idle timer, so nothing short of the budget ends this.
      const chunk = xorCrypt(Buffer.alloc(512 * 1024, 0x41), KEY);
      const pump = () => { while (socket.writable && !stopped && socket.write(chunk)) { /* fill */ } };
      socket.on("drain", pump);
      pump();
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;

  // A generous hard timeout ON PURPOSE. The invariant is "the byte cap refuses an endless
  // response" — but the default 5s hard timeout can also end a request, by RESOLVING with
  // whatever accumulated. Taking the clock out of the picture leaves the cap as the only thing
  // that can end this request — which is the thing being tested.
  //
  // The cap itself is lowered to 2MB (a knob that exists for exactly this test): at the real
  // 32MB this is a race between the pump and the 150ms idle window, and a loaded machine (the
  // full battery runs every package at once) stalls the pump long enough for the idle gap to
  // fire first — resolving instead of rejecting. One 512KB-chunk burst clears 2MB before any
  // idle window can open, so the refusal is deterministic. The production default is untouched,
  // and the companion test below proves normal traffic clears the budget.
  const conn = new LegacyTextConnection({ host: "127.0.0.1", port, password: "x", timeoutMs: 60_000, maxResponseBytes: 2 * 1024 * 1024 });
  try {
    await conn.connect();
    // A rejection is the whole point: the alternative is a resolve carrying hundreds of megabytes,
    // or the crash that used to happen instead.
    await assert.rejects(
      () => conn.send("Get PlayerIds"),
      /exceeded .* bytes|could not decode/,
      "an unbounded response must fail the request, not accumulate",
    );
    // And the socket is gone, so the caller's reconnect runs rather than reusing a wedged one.
    await assert.rejects(() => conn.send("Get PlayerIds"), /not connected/, "the connection is torn down, not left open");
  } finally {
    // EVERY exit path, failure included. When the assertion failed (the old flake), the accepted
    // socket and the still-open connection kept the event loop alive — node never exited, and the
    // whole test battery hung on this one process instead of reporting the failure.
    stopped = true;
    conn.close();
    for (const s of accepted) s.destroy();
    server.close();
  }
});

test("legacy-text: a normal-sized response is unaffected by the budget", async () => {
  // The cap must be a backstop, not a new limit on real traffic — the largest legacy response is a
  // backtracked ShowLog, orders of magnitude under it.
  const big = "x".repeat(200_000);
  const server = createServer((socket: Socket) => {
    socket.write(KEY);
    socket.on("data", (buf) => {
      const cmd = xorCrypt(buf, KEY).toString("utf8");
      socket.write(xorCrypt(Buffer.from(cmd.startsWith("Login ") ? "SUCCESS" : big, "utf8"), KEY));
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const conn = new LegacyTextConnection({ host: "127.0.0.1", port, password: "x" });
    await conn.connect();
    assert.equal((await conn.send("Get PlayerIds")).length, big.length);
    conn.close();
  } finally {
    server.close();
  }
});

test("legacy-text: a server that never answers is a timeout error, not an empty success", async () => {
  /*
   * The idle timer arms only after the first chunk, so a peer that says nothing rides the hard
   * timeout — and that used to RESOLVE with "", which every caller then mistook for data: the
   * player-list parser read it as a server with nobody on it, and message-everyone messaged no
   * one while reporting success. "No answer" and "answered with nothing" are different facts,
   * and only the second exists in this protocol (its own idea of nothing is the literal EMPTY).
   */
  const server = createServer((socket: Socket) => {
    socket.write(KEY);
    socket.on("data", (buf) => {
      const cmd = xorCrypt(buf, KEY).toString("utf8");
      const reply = (text: string) => socket.write(xorCrypt(Buffer.from(text, "utf8"), KEY));
      if (cmd.startsWith("Login ")) return reply("SUCCESS");
      // Any other command: dead air.
    });
  });
  const port = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));
  const conn = new LegacyTextConnection({ host: "127.0.0.1", port, password: "pw", timeoutMs: 300 });
  try {
    await conn.connect();
    await assert.rejects(conn.send("Get PlayerIds"), /no response within 300ms/);
  } finally {
    conn.close();
    server.close();
  }
});

test("legacy-text: a dropped connection makes the NEXT send fail fast as 'not connected'", async () => {
  // The reconnect cue the runners key on. Keeping the dead socket meant the next send wrote into
  // it and waited for a socket error to wander in; forgetting it answers immediately.
  const server = createServer((socket: Socket) => {
    socket.write(KEY);
    socket.on("data", (buf) => {
      const cmd = xorCrypt(buf, KEY).toString("utf8");
      if (cmd.startsWith("Login ")) return socket.write(xorCrypt(Buffer.from("SUCCESS", "utf8"), KEY));
      socket.destroy(); // the server goes away mid-conversation
    });
  });
  const port = await new Promise<number>((r) => server.listen(0, () => r((server.address() as AddressInfo).port)));
  const conn = new LegacyTextConnection({ host: "127.0.0.1", port, password: "pw", timeoutMs: 500 });
  try {
    await conn.connect();
    await assert.rejects(conn.send("Get PlayerIds"), /socket error|connection closed|no response/);
    await assert.rejects(conn.send("Get PlayerIds"), /not connected/);
  } finally {
    conn.close();
    server.close();
  }
});
