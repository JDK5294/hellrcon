/**
 * LegacyTextConnection — the HLL legacy RCON transport: a raw TCP socket where the server sends
 * an XOR key on connect and every message (both directions) is XOR-encoded with it.
 *
 * The protocol has no length framing, so a response is read by accumulating bytes until the
 * socket goes idle for `idleMs` (or an overall `timeoutMs` cap). Commands are serialized — one
 * outstanding request at a time — which is exactly how the adapter drives it.
 */
import { Socket } from "node:net";
import { xorCrypt } from "./xor.js";

/**
 * The most this transport will accumulate for one response.
 *
 * There is no length framing here at all — a response is "everything that arrives until the socket
 * goes quiet" — so the only thing bounding a read was the 5-second hard timeout. On a LAN, and
 * certainly on loopback, five seconds is hundreds of megabytes, and the endpoint deciding how much
 * to send is the thing we are least able to trust: a game server having a bad day, a wrong port
 * answering with somebody else's stream, or a hostile one.
 *
 * Measured against a server that simply never stops talking: the read did not merely bloat, it
 * killed the process outright with ERR_STRING_TOO_LONG when the accumulated bytes were finally
 * turned into a string. This process holds EVERY server's connection, so that is not one server's
 * outage.
 *
 * 32 MB matches the cap the binary-v2 transport puts on a declared frame length, and is far above
 * anything real: the largest legacy response is a backtracked ShowLog, comfortably under a
 * megabyte.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface LegacyConnOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
  /** idle gap that marks a response complete (ms). */
  idleMs?: number;
  /** Refuse any response larger than this — the endless-stream guard. The default is far above
   *  the largest real legacy response (a backtracked ShowLog); tests lower it so proving the
   *  refusal does not require actually pumping 32MB through a loopback socket. */
  maxResponseBytes?: number;
}

export class LegacyRconError extends Error {}

interface Pending {
  chunks: Buffer[];
  /** Running total of `chunks`, so the budget check costs nothing per chunk. */
  bytes: number;
  resolve: (decoded: string) => void;
  reject: (err: Error) => void;
  idle: ReturnType<typeof setTimeout> | null;
  hard: ReturnType<typeof setTimeout>;
}

export class LegacyTextConnection {
  private socket: Socket | null = null;
  private xorkey: Buffer = Buffer.alloc(0);
  private keyResolve: (() => void) | null = null;
  private pending: Pending | null = null;
  private readonly opts: Required<LegacyConnOptions>;

  constructor(opts: LegacyConnOptions) {
    // Per-field fallbacks: callers pass `timeoutMs: undefined` explicitly, which a spread over
    // defaults would turn back into undefined.
    this.opts = {
      host: opts.host,
      port: opts.port,
      password: opts.password,
      timeoutMs: opts.timeoutMs ?? 5_000,
      idleMs: opts.idleMs ?? 150,
      maxResponseBytes: opts.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    };
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      const onErr = (err: Error) => reject(new LegacyRconError(`legacy-text connect failed: ${err.message}`));
      socket.once("error", onErr);
      // Destroy as well as reject: rejecting alone unblocks the caller but leaves the OS still
      // dialing for its own ~2-minute timeout — a dangling handle that keeps the process alive,
      // the same gap the binary transport's openSocket closes with its settled-flag.
      socket.setTimeout(this.opts.timeoutMs, () => { socket.destroy(); reject(new LegacyRconError("legacy-text connect timed out")); });
      // The server sends the XOR key as the very first bytes after the socket opens.
      const keyReady = new Promise<void>((r) => (this.keyResolve = r));
      socket.on("data", (buf) => this.onData(buf));
      socket.connect(this.opts.port, this.opts.host, () => {
        keyReady.then(() => {
          socket.setTimeout(0);
          socket.off("error", onErr);
          // Forget the socket as well as failing the exchange — the binary transport's rule, for
          // the same reason: a destroyed socket still accepts write(), so keeping it turns every
          // later send into a wait for an error that may be slow to come. A null socket makes the
          // next send fail immediately with "not connected", which is the runners' reconnect cue.
          socket.on("error", () => { this.socket = null; this.failPending("socket error"); });
          socket.on("close", () => { this.socket = null; this.failPending("connection closed"); });
          resolve();
        });
      });
    });

    // Authenticate; the server answers SUCCESS / FAIL. Close the socket on any failure so a
    // rejected connect leaves no lingering handle.
    try {
      const resp = await this.send(`Login ${this.opts.password}`);
      if (resp.trim().toUpperCase() !== "SUCCESS") throw new LegacyRconError("legacy-text login failed (bad password)");
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /** Send a command line and resolve with the decoded response text. */
  send(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.socket) return reject(new LegacyRconError("not connected"));
      if (this.pending) return reject(new LegacyRconError("a command is already in flight"));
      const hard = setTimeout(() => this.finalizePending(), this.opts.timeoutMs);
      this.pending = { chunks: [], bytes: 0, resolve, reject, idle: null, hard };
      this.socket.write(xorCrypt(Buffer.from(command, "utf8"), this.xorkey));
    });
  }

  close(): void {
    this.failPending("connection closed");
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(buf: Buffer): void {
    if (this.xorkey.length === 0) {
      // First message after connect is the XOR key itself (sent in the clear).
      this.xorkey = Buffer.from(buf);
      this.keyResolve?.();
      this.keyResolve = null;
      return;
    }
    if (!this.pending) return; // stray data outside a request/response — ignore
    this.pending.chunks.push(buf);
    this.pending.bytes += buf.length;
    if (this.pending.bytes > this.opts.maxResponseBytes) {
      // Nothing downstream can make sense of a response this size, and every further chunk only
      // makes the eventual decode worse. Fail the request and tear the socket down so the caller's
      // reconnect runs — the same answer binary-v2 gives an over-long declared frame.
      this.failPending(`response exceeded ${this.opts.maxResponseBytes} bytes — the server is not speaking this protocol`);
      this.socket?.destroy();
      this.socket = null;
      return;
    }
    if (this.pending.idle) clearTimeout(this.pending.idle);
    this.pending.idle = setTimeout(() => this.finalizePending(), this.opts.idleMs);
  }

  /** Resolve the in-flight request with whatever has accumulated (idle gap or hard timeout). */
  private finalizePending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.idle) clearTimeout(p.idle);
    clearTimeout(p.hard);
    /*
     * Zero bytes is not a response — it is the ABSENCE of one, and the two must not be confused.
     *
     * The idle timer only arms after the first chunk, so the only way to get here empty is the
     * hard timeout: the full timeoutMs passed and the server said nothing at all. Resolving ""
     * reported that as success, and the callers made it worse in exactly the quiet way: the
     * player-list parser read "" as a server with nobody on it, message-everyone messaged no one
     * while claiming it had, and a seeding tick was fed a phantom empty roster. No legacy command
     * legitimately answers with zero bytes — even "nothing to report" is the literal EMPTY — so
     * an empty accumulation is always the peer not answering, and that is an error.
     */
    if (p.bytes === 0) {
      p.reject(new LegacyRconError(`no response within ${this.opts.timeoutMs}ms`));
      return;
    }
    // Both timers land here, so this runs in a TIMER callback: a throw escapes as an uncaught
    // exception rather than rejecting the promise somebody is awaiting, and with crash handlers
    // installed that ends the process. Decoding is the step that can throw (a buffer past V8's
    // maximum string length raises ERR_STRING_TOO_LONG), so it answers the caller either way.
    let text: string;
    try {
      text = xorCrypt(Buffer.concat(p.chunks), this.xorkey).toString("utf8");
    } catch (err) {
      p.reject(new LegacyRconError(`legacy-text could not decode the response: ${(err as Error).message}`));
      return;
    }
    p.resolve(text);
  }

  private failPending(reason: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.idle) clearTimeout(p.idle);
    clearTimeout(p.hard);
    p.reject(new LegacyRconError(`legacy-text ${reason}`));
  }
}
