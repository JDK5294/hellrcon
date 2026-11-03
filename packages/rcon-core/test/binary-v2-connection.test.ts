import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { BinaryV2Connection } from "../dist/protocol/binary-v2/connection.js";
import { packHeader } from "../dist/protocol/binary-v2/frame.js";

/**
 * A stand-in game server, so the read loop can be driven with bytes a real server would never
 * send. This is the only place in the system that parses length-prefixed frames off a socket, and
 * it runs inside the worker that holds EVERY server's connection — a wedged or unbounded read loop
 * there is not one server's problem.
 */
async function withFakeServer(
  onSocket: (sock: Socket, say: (name: string, body: Record<string, unknown> | string, status?: number) => void) => void,
  run: (conn: BinaryV2Connection) => Promise<void>,
  opts: { skipHandshake?: boolean } = {},
): Promise<void> {
  let server: Server | undefined;
  let conn: BinaryV2Connection | undefined;
  try {
    server = createServer((sock) => {
      const say = (name: string, body: Record<string, unknown> | string, status = 200) => {
        const payload = Buffer.from(JSON.stringify({
          name, version: 2, statusCode: status, statusMessage: "OK",
          contentBody: typeof body === "string" ? body : JSON.stringify(body),
        }), "utf8");
        // requestId 0 is fine: the connection matches on the id it sent, and the handshake below
        // replies to whatever came in.
        sock.write(Buffer.concat([packHeader("magic", 1, payload.length), payload]));
      };
      // Our end may be destroyed mid-write (that IS the behaviour under test), so the fake
      // server must tolerate the reset rather than take the test process down with it.
      sock.on("error", () => {});
      onSocket(sock, say);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    conn = new BinaryV2Connection({ host: "127.0.0.1", port, password: "pw", timeoutMs: 1500 });
    if (!opts.skipHandshake) await conn.connect();
    await run(conn);
  } finally {
    conn?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  }
}

/** Reply to the two handshake commands, then hand control to the test. */
function handshakeThen(after: (sock: Socket, reply: (id: number, body: string) => void) => void) {
  return (sock: Socket) => {
    let seen = 0;
    const reply = (id: number, body: string) => {
      const payload = Buffer.from(JSON.stringify({ name: "x", version: 2, statusCode: 200, statusMessage: "OK", contentBody: body }), "utf8");
      sock.write(Buffer.concat([packHeader("magic", id, payload.length), payload]));
    };
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      // Every request carries its id at bytes 4..8 of the header.
      const id = chunk.readUInt32LE(4);
      seen++;
      if (seen === 1) return reply(id, "");        // ServerConnect -> empty xor key
      if (seen === 2) return reply(id, "token-1"); // Login -> auth token
      after(sock, reply);
    });
  };
}

test("a well-formed exchange round-trips over a real socket", async () => {
  await withFakeServer(
    handshakeThen((sock, reply) => reply(3, JSON.stringify({ ok: true }))),
    async (conn) => {
      const r = await conn.exchange("GetServerInformation", 2, { Name: "session" });
      assert.equal(r.statusCode, 200);
      assert.equal(r.content, JSON.stringify({ ok: true }));
    },
  );
});

test("a body length the connection could never satisfy is refused, not buffered", async () => {
  // bodyLen is a uint32 read straight off the wire. Announcing ~3.5 GB and sending nothing after
  // it used to leave the read loop appending every subsequent chunk to a buffer waiting for a body
  // that will never arrive — the worker grows until it dies, taking every server's ingest with it.
  await withFakeServer(
    handshakeThen((sock) => {
      sock.write(packHeader("magic", 3, 3_500_000_000));
      // Then keep feeding it, as a live server's other traffic would.
      const spam = Buffer.alloc(64 * 1024, 0x41);
      for (let i = 0; i < 40; i++) sock.write(spam);
    }),
    async (conn) => {
      await assert.rejects(
        () => conn.exchange("GetServerInformation", 2, { Name: "session" }),
        /too large|frame|length/i,
        "an impossible frame must be rejected outright",
      );
    },
  );
});

test("a framing error tears the connection down instead of wedging it", async () => {
  // The magic word is checked on every frame. When it fails, the buffer is poisoned: every later
  // chunk re-throws on the same bytes. Rejecting the waiter without closing the socket left the
  // connection alive-but-useless — each new command failed, and because nothing ever closed, the
  // reconnect that would have fixed it never ran.
  await withFakeServer(
    handshakeThen((sock) => {
      sock.write(Buffer.from("this is not a valid frame header at all", "utf8"));
    }),
    async (conn) => {
      await assert.rejects(() => conn.exchange("GetServerInformation", 2, { Name: "session" }), /.*/);
      // The telling part: the NEXT command must fail as "not connected", not hang or reject on the
      // same stale bytes. That is what makes the caller reconnect.
      await assert.rejects(
        () => conn.exchange("GetServerInformation", 2, { Name: "session" }),
        /not connected/i,
        "after a framing error the socket must be closed so the caller reconnects",
      );
    },
  );
});

test("a large response split across many chunks is reassembled", async () => {
  // 142 maps of catalogue arrives in a great many TCP segments. Correctness first, but this also
  // pins the reassembly path that the O(n^2) concat made slow.
  const big = { maps: Array.from({ length: 2000 }, (_, i) => `map_${i}_warfare`) };
  const bodyText = JSON.stringify(big);
  await withFakeServer(
    handshakeThen((sock, _reply) => {
      const payload = Buffer.from(JSON.stringify({ name: "x", version: 2, statusCode: 200, statusMessage: "OK", contentBody: bodyText }), "utf8");
      const framed = Buffer.concat([packHeader("magic", 3, payload.length), payload]);
      // Dribble it out in small pieces, the way a real stream arrives.
      for (let i = 0; i < framed.length; i += 500) sock.write(framed.subarray(i, i + 500));
    }),
    async (conn) => {
      const r = await conn.exchange("getMapReferenceList", 2, "AddMapToRotation");
      assert.equal(r.content, bodyText);
      assert.equal(JSON.parse(r.content).maps.length, 2000);
    },
  );
});

test("two frames arriving in one chunk are both consumed", async () => {
  // TCP gives no message boundaries: a reply can share a packet with the next one.
  await withFakeServer(
    handshakeThen((sock) => {
      const mk = (id: number, body: string) => {
        const p = Buffer.from(JSON.stringify({ name: "x", version: 2, statusCode: 200, statusMessage: "OK", contentBody: body }), "utf8");
        return Buffer.concat([packHeader("magic", id, p.length), p]);
      };
      sock.write(Buffer.concat([mk(3, "first"), mk(4, "second")]));
    }),
    async (conn) => {
      assert.equal((await conn.exchange("a", 2, "")).content, "first");
    },
  );
});

test("a request over the 4 KB protocol limit is refused before it touches the socket", async () => {
  // The limit is the game's, and the penalty is the part that matters: the server treats an
  // oversized request as a protocol VIOLATION and rejects the whole connection, not just the
  // command (documented for HLL: Vietnam, and the safe assumption for HLL). Refusing it client
  // side turns "the socket died and every queued command failed with it" into one clear error
  // naming the actual problem.
  await withFakeServer(
    // The first request to actually REACH the socket after the handshake is the small follow-up —
    // #4, because the rejected oversized request consumed #3 without ever being written.
    handshakeThen((sock, reply) => reply(4, JSON.stringify({ ok: true }))),
    async (conn) => {
      await assert.rejects(
        () => conn.exchange("AddBannedWords", 2, { BannedWords: ["x".repeat(5000)] }),
        /4096-byte RCON limit/,
        "an oversized request is a local error, not a dropped connection",
      );
      // And the connection survives it: the next, normal-sized command still works. If the guard
      // had written the frame anyway, a real server would have torn the socket down here.
      const r = await conn.exchange("GetServerInformation", 2, { Name: "session" });
      assert.equal(r.statusCode, 200);
    },
  );
});

test("an idle connection stays usable — quiet is normal, not death", async () => {
  // `socket.setTimeout` arms an IDLE timer, and this connection is idle by design: the runners that
  // hold it poll on intervals of seconds to minutes. It used to be armed with the REQUEST timeout
  // and to destroy the socket when it fired, so every quiet gap longer than one request timeout
  // killed a perfectly healthy connection — and because the dead socket was kept, the next command
  // wrote into it and then waited the full timeout for a reply that could never arrive. In
  // production that read as "timeout waiting for response to GetServerInformation" on a server that
  // was up and answering everything else.
  await withFakeServer(
    handshakeThen((sock, reply) => reply(3, JSON.stringify({ ok: true }))),
    async (conn) => {
      // Longer than the 1500 ms request timeout this connection was built with.
      await new Promise((r) => setTimeout(r, 2200));
      const r = await conn.exchange("GetServerInformation", 2, { Name: "maprotation" });
      assert.equal(r.statusCode, 200, "a connection that was merely quiet must still answer");
    },
  );
});

test("a refused handshake takes its socket with it", async () => {
  // A wrong password is not exotic: it is what every server shows after a password rotation, on
  // every reconnect, for as long as nobody fixes the config. The connection used to throw and
  // quietly keep the open socket — five refused logins measured five live sockets, none of them
  // readable, none of them closed by anything. The runners all happen to wrap connect() in a
  // finally that disconnects, so this never became a file-descriptor leak in production; an
  // object that fails to initialise still must not leave its own socket behind on the assumption
  // that some caller will tidy up for it.
  let opened = 0;
  let closed = 0;
  const server = createServer((sock) => {
    opened++;
    sock.on("close", () => closed++);
    sock.on("error", () => {});
    let seen = 0;
    sock.on("data", (chunk) => {
      const id = chunk.readUInt32LE(4);
      seen++;
      const ok = seen === 1; // ServerConnect succeeds, Login is rejected
      const payload = Buffer.from(JSON.stringify({
        name: "x", version: 2,
        statusCode: ok ? 200 : 401,
        statusMessage: ok ? "OK" : "Unauthorized",
        contentBody: "",
      }), "utf8");
      sock.write(Buffer.concat([packHeader("magic", id, payload.length), payload]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    for (let i = 0; i < 3; i++) {
      const conn = new BinaryV2Connection({ host: "127.0.0.1", port, password: "wrong", timeoutMs: 1500 });
      // Deliberately no close() in a finally: the point is that the connection cleans up after
      // its own failed handshake, without help.
      await assert.rejects(() => conn.connect(), /401|Unauthorized/, "a rejected login is an error");
      await assert.rejects(
        () => conn.exchange("GetServerInformation", 2, { Name: "session" }),
        /not connected/,
        "and leaves nothing usable behind",
      );
    }
    // Let the FINs land before counting.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(opened, 3, "three attempts, three sockets");
    assert.equal(closed, 3, "and every one of them closed");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a socket that dies fails the next command at once instead of timing out", async () => {
  // A destroyed socket accepts write() and silently drops it. Keeping it meant every later command
  // burned a full request timeout, forever, because nothing ever concluded it had to reconnect.
  // "not connected" is the answer the runners act on.
  await withFakeServer(
    handshakeThen((sock) => sock.destroy()),
    async (conn) => {
      await assert.rejects(() => conn.exchange("GetServerInformation", 2, { Name: "maprotation" }));
      const started = Date.now();
      await assert.rejects(
        () => conn.exchange("GetServerInformation", 2, { Name: "maprotation" }),
        /not connected/,
        "the connection must know its socket is gone",
      );
      assert.ok(Date.now() - started < 1000, "and say so immediately, not after the request timeout");
    },
  );
});
