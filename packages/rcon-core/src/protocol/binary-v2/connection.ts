/**
 * A single HLL v2 binary RCON socket connection: handshake, request/response framing,
 * and XOR. Exchanges are serialized (one in-flight at a time) which keeps the XOR-key
 * handshake correct and the request/response pairing simple.
 */
import net from "node:net";
import { packHeader, unpackHeader, headerSize, xor, type HeaderMode } from "./frame.js";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How long a connection may sit quiet before TCP starts probing the peer. Long-lived RCON
 * connections poll on intervals measured in seconds to minutes, so silence is normal and must not
 * be mistaken for death; probes only need to be frequent enough that a server which really has gone
 * (crash, restart, network drop) is noticed within a poll or two rather than never.
 */
const KEEPALIVE_MS = 30_000;

/**
 * The largest response body we will wait for. `bodyLen` is a uint32 read straight off the wire, so
 * without a ceiling a single desynced or corrupted header can announce ~4 GB and the read loop will
 * sit there appending every subsequent byte to a buffer, waiting for a body that never comes, until
 * the process dies. That process holds EVERY server's connection, so it is not one server's outage.
 *
 * 32 MB is far above anything real: the largest thing the game returns is the full map catalogue
 * and a backtracked admin log, both comfortably under a megabyte.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The largest request the server accepts. Documented for HLL: Vietnam ("content exceeds 4KB" is a
 * protocol violation) and almost certainly the same undocumented rule in HLL — and the penalty is
 * not a failed command but a REJECTED CONNECTION, which every later command on this socket then
 * pays for. Refusing the oversized request here turns a dropped socket into a clear error naming
 * the actual problem, and costs nothing when requests are normal-sized (they all are: the largest
 * legitimate write is a banned-words list at a few hundred bytes).
 */
const MAX_REQUEST_BYTES = 4 * 1024;

export interface ConnectionOptions {
  host: string;
  port: number;
  password: string;
  headerMode?: HeaderMode;
  timeoutMs?: number;
}

export interface RconResponse {
  requestId: number;
  name: string;
  version: number;
  statusCode: number;
  statusMessage: string;
  content: string;
}

export class RconConnectionError extends Error {}
export class RconCommandError extends RconConnectionError {
  constructor(public statusCode: number, message: string) {
    super(`(${statusCode}) ${message}`.trim());
  }
}

/** Minimal async mutex so exchanges run one at a time. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class BinaryV2Connection {
  private sock: net.Socket | null = null;
  private xorkey: Buffer | null = null;
  private authToken = "";
  private requestId = 0;
  private readonly headerMode: HeaderMode;
  private readonly timeoutMs: number;
  private readonly mutex = new Mutex();

  // read-loop state
  private recv = Buffer.alloc(0);
  private pending: { requestId: number; resolve: (r: RconResponse) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly opts: ConnectionOptions) {
    this.headerMode = opts.headerMode ?? "magic";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    await this.openSocket();

    // Handshake: ServerConnect (plaintext) yields the XOR key; Login yields the auth token.
    //
    // Any failure here — a wrong password, a 5xx from the server, a timeout, a framing fault —
    // must take the socket with it. Without this the object threw while quietly holding an open,
    // authenticated-nowhere socket that nothing would ever read from or close: measured at five
    // refused logins, five live sockets. Every current caller happens to wrap connect() in a
    // finally that disconnects, so this was not leaking file descriptors in practice; a
    // connection that fails to initialise should still not leave its own socket behind for a
    // caller to notice.
    try {
      const hello = await this.exchange("ServerConnect", 2, "");
      this.raiseForStatus(hello);
      this.xorkey = Buffer.from(hello.content, "base64");

      const login = await this.exchange("Login", 2, this.opts.password);
      this.raiseForStatus(login);
      this.authToken = login.content;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /**
   * The TCP half of connecting, with a deadline that actually exists.
   *
   * `socket.setTimeout(ms)` only EMITS a 'timeout' event — node explicitly does not sever the
   * connection, the listener has to. There was no listener, so the deadline this code documented
   * did nothing at all: against a host that drops SYNs rather than refusing them (a firewall rule,
   * a machine that went away, a wrong port on a live box) the attempt sat there for the OS's own
   * TCP timeout, minutes rather than the configured seconds. A refused connection was always fine
   * — that is an immediate ECONNREFUSED — which is exactly why the gap stayed invisible: it only
   * shows up on the failure mode where the peer says nothing back.
   */
  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(err);
      };
      sock.setTimeout(this.timeoutMs);
      sock.once("timeout", () => fail(new RconConnectionError(
        `timed out connecting to ${this.opts.host}:${this.opts.port} after ${this.timeoutMs}ms`,
      )));
      sock.once("error", (err) => fail(new RconConnectionError(err.message)));
      sock.once("connect", () => {
        if (settled) return; // the deadline already fired and destroyed this socket
        settled = true;
        sock.removeAllListeners("error");
        sock.removeAllListeners("timeout");
        // The CONNECT attempt gets a deadline; the established connection must not. `setTimeout`
        // arms an IDLE timer — it fires when nothing has been sent or received for that long — and
        // an RCON connection is idle by design between polls. Left armed, it destroyed a perfectly
        // healthy connection after every quiet gap, and the next command then wrote into a dead
        // socket and waited the full request timeout for a reply that could never come. Keepalive
        // is what this was reaching for: it detects a peer that has actually gone away.
        sock.setTimeout(0);
        sock.setKeepAlive(true, KEEPALIVE_MS);
        this.sock = sock;
        sock.on("data", (chunk) => this.onData(chunk));
        sock.on("error", (err) => this.dropped(new RconConnectionError(err.message)));
        sock.on("close", () => this.dropped(new RconConnectionError("socket closed")));
        resolve();
      });
    });
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  /** Send a command and await its response. Serialized via the mutex. */
  exchange(name: string, version: number, content: Record<string, unknown> | string): Promise<RconResponse> {
    return this.mutex.run(() => this.sendAndReceive(name, version, content));
  }

  private sendAndReceive(name: string, version: number, content: Record<string, unknown> | string): Promise<RconResponse> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new RconConnectionError("not connected"));

    const requestId = ++this.requestId;
    const body = Buffer.from(
      JSON.stringify({
        authToken: this.authToken || "",
        version,
        name,
        contentBody: typeof content === "string" ? content : JSON.stringify(content),
      }),
      "utf8",
    );
    if (body.length > MAX_REQUEST_BYTES) {
      return Promise.reject(new RconConnectionError(
        `request ${name} is ${body.length} bytes — over the ${MAX_REQUEST_BYTES}-byte RCON limit, and the server would drop the whole connection rather than just this command`,
      ));
    }
    const message = Buffer.concat([packHeader(this.headerMode, requestId, body.length), xor(body, this.xorkey)]);

    return new Promise<RconResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.requestId === requestId) this.pending = null;
        reject(new RconConnectionError(`timeout waiting for response to ${name} (#${requestId})`));
      }, this.timeoutMs);

      this.pending = {
        requestId,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      sock.write(message);
    });
  }

  private onData(chunk: Buffer): void {
    // Concat only when there IS a leftover partial frame. In the common case — one whole response
    // per chunk — this skips a full copy of the buffer per packet, which is what made reassembling
    // a large split response quadratic.
    this.recv = this.recv.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.recv, chunk]);
    const hSize = headerSize(this.headerMode);
    while (this.recv.length >= hSize) {
      let header;
      try {
        header = unpackHeader(this.headerMode, this.recv);
      } catch (err) {
        // A bad header means the stream is no longer aligned, and nothing downstream can realign
        // it: the same bytes would throw again on every later chunk. Tear the socket down so the
        // caller's reconnect runs, instead of leaving a connection that is open and useless.
        this.fail(err instanceof Error ? err : new RconConnectionError(String(err)));
        return;
      }
      if (header.bodyLen > MAX_BODY_BYTES) {
        this.fail(new RconConnectionError(
          `response frame too large: ${header.bodyLen} bytes (limit ${MAX_BODY_BYTES}) — the stream is out of sync`,
        ));
        return;
      }
      if (this.recv.length < hSize + header.bodyLen) break; // wait for the rest
      const bodyEnc = this.recv.subarray(hSize, hSize + header.bodyLen);
      this.recv = this.recv.subarray(hSize + header.bodyLen);

      const bodyBuf = xor(Buffer.from(bodyEnc), this.xorkey);
      let response: RconResponse;
      try {
        const parsed = JSON.parse(bodyBuf.toString("utf8"));
        response = {
          requestId: header.requestId,
          name: String(parsed.name ?? ""),
          version: Number(parsed.version ?? 0),
          statusCode: Number(parsed.statusCode ?? 0),
          statusMessage: String(parsed.statusMessage ?? ""),
          content: String(parsed.contentBody ?? ""),
        };
      } catch (err) {
        // The frame was well-formed but its contents were not. The stream is still aligned (we
        // consumed exactly bodyLen), so only this exchange is lost — keep the connection.
        this.failPending(new RconConnectionError(`failed to parse response body: ${String(err)}`));
        return;
      }

      const waiter = this.pending;
      if (waiter && waiter.requestId === header.requestId) {
        this.pending = null;
        waiter.resolve(response);
      }
      // else: stray/duplicate frame — ignore (serialized exchanges shouldn't produce these)
    }
  }

  /**
   * The socket went away (closed, errored, reset by the peer). Reject whatever was in flight AND
   * forget the socket.
   *
   * Forgetting it is the part that matters: a destroyed socket accepts `write()` and silently drops
   * it, so a connection that kept its dead socket answered every later command with a timeout —
   * twenty seconds of waiting, per call, forever, because nothing ever noticed it had to reconnect.
   * A null socket makes the next call fail immediately with "not connected", which every runner
   * already treats as its cue to rebuild the connection.
   */
  private dropped(err: Error): void {
    this.recv = Buffer.alloc(0);
    this.sock = null;
    this.failPending(err);
  }

  /** Reject whatever is in flight. The connection stays usable. */
  private failPending(err: Error): void {
    const waiter = this.pending;
    this.pending = null;
    waiter?.reject(err);
  }

  /**
   * Reject what's in flight AND close the connection, for faults the stream cannot recover from.
   * Dropping the buffer matters as much as closing the socket: a half-frame left behind would be
   * parsed as the start of the next connection's data if this object were ever reused.
   */
  private fail(err: Error): void {
    this.recv = Buffer.alloc(0);
    this.failPending(err);
    this.close();
  }

  private raiseForStatus(r: RconResponse): void {
    if (r.statusCode !== 200) throw new RconCommandError(r.statusCode, r.statusMessage);
  }
}
