import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";
import { codeForStatus, errors } from "@app/shared";

export interface Json {
  [k: string]: unknown;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // no-store: every JSON answer here is live state (grants, rosters, bans). Without an explicit
  // header, browsers cache heuristically — which is how a permission grant took ten minutes to
  // reach the person it was given to: their browser kept replaying a stale /api/me.
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  const encoding = payload.length >= COMPRESS_FROM ? acceptedEncoding(res.req) : null;
  if (!encoding) {
    res.writeHead(status, headers);
    res.end(payload);
    return;
  }
  // The head goes now and the body once it is packed, so the answer counts as sent from here on
  // (headersSent) — a handler's error after it, or a plugin's missing answer, must not start a
  // second one in the moment the packing takes.
  res.writeHead(status, { ...headers, "content-encoding": encoding, vary: "accept-encoding" });
  compress(Buffer.from(payload), encoding, (err, packed) => {
    if (res.destroyed || res.writableEnded) return;
    if (err) res.destroy(err);
    else res.end(packed);
  });
}

/**
 * Text answers go packed when the client takes it: brotli, else gzip. A players list of 300 rows is
 * 95 KB as JSON and 6 KB packed, so on a phone, or through the tunnel up a home connection, most of
 * the wait was the size. Packing such a list takes about a millisecond; nothing is stored.
 */
export type Encoding = "br" | "gzip";

/** Smaller than this, packing saves less than it costs. */
export const COMPRESS_FROM = 1024;

/** What the request's Accept-Encoding takes, best first; `q=0` is a refusal. */
export function acceptedEncoding(req: IncomingMessage | undefined): Encoding | null {
  const header = req?.headers["accept-encoding"];
  if (!header) return null;
  const takes = new Set<string>();
  for (const part of String(header).split(",")) {
    const [name, ...params] = part.split(";").map((p) => p.trim().toLowerCase());
    const q = params.find((p) => p.startsWith("q="));
    if (name && !(q && Number(q.slice(2)) === 0)) takes.add(name);
  }
  return takes.has("br") ? "br" : takes.has("gzip") ? "gzip" : null;
}

/** Brotli at quality 5: about gzip's speed, and smaller. */
export function compress(body: Buffer, encoding: Encoding, done: (err: Error | null, packed: Buffer) => void): void {
  if (encoding === "br") {
    brotliCompress(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } }, done);
  } else {
    gzip(body, { level: 6 }, done);
  }
}

/** Consistent error body: `{ error: { code, message, requestId, ...extra } }`. `extra` carries
 *  machine-readable detail (e.g. which permission was missing) for clients that want more than
 *  the message. */
export function sendError(res: ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
  const requestId = (res as ServerResponse & { requestId?: string }).requestId;
  sendJson(res, status, { error: { code: codeForStatus(status), message, requestId, ...extra } });
}

/**
 * Stream a file to the response, with the one listener that keeps a missing file from taking the
 * process down with it.
 *
 * `createReadStream` opens LAZILY: it never throws where it is called, it emits `error` a tick
 * later. So a `try { createReadStream(f).pipe(res) } catch {}` around it catches nothing, and an
 * `error` on a stream nobody is listening to is an unhandled `error` event, which in Node is a
 * thrown exception with no request to attach it to. The file going missing between the check and
 * the read is not hypothetical — a backup can be deleted mid-download, and a WEB_ROOT pointing at
 * the wrong directory means every single page request takes this path.
 *
 * The 200 waits for `open`, which is what makes the 404 possible at all: writing the header first
 * and discovering the file is missing afterwards leaves nothing to say but a reset connection, and
 * a reader gets "fetch failed" instead of an answer. Exactly one of `open` and `error` fires.
 */
export function sendFile(res: ServerResponse, file: string, headers: Record<string, string>): void {
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } else {
      // Headers are out and the body is short: nothing left but to cut it, so the client sees a
      // truncated response rather than a socket that hangs open forever.
      res.destroy();
    }
  });
  // The client hanging up mid-download must close the file handle rather than leave it draining
  // into a socket nobody is reading.
  res.on("close", () => stream.destroy());
  stream.once("open", () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
}

/**
 * Each request's parsed body, once read. A stream can be read only once, and a write refused for a
 * missing permission is filed as a request carrying its body — often after the handler has already
 * read and validated it.
 */
const parsedBodies = new WeakMap<IncomingMessage, Json>();

export async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<Json> {
  const cached = parsedBodies.get(req);
  if (cached) return cached;
  const body = await parseJsonBody(req, limitBytes);
  parsedBodies.set(req, body);
  return body;
}

async function parseJsonBody(req: IncomingMessage, limitBytes: number): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw errors.badRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Json) : {};
  } catch {
    throw errors.badRequest("invalid JSON body");
  }
}

/** Read the raw request body as a string (needed when the exact bytes matter, e.g. verifying a
 *  Discord interaction signature). Does not parse. */
export async function readRawBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw errors.badRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
}

/** The same read, kept as BYTES — for the one route that accepts a binary file (the old bot's bot.db,
 *  for the cutover import). A SQLite file through a utf8 decode is corruption, not a body. */
export async function readRawBodyBuffer(req: IncomingMessage, limitBytes = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw errors.badRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Text limits, so a free-text field is bounded once rather than at each of the two dozen places
 * one is read.
 *
 * Some routes already capped their text and most did not — eight of twenty-two — which is the kind
 * of gap that only shows up as a surprise later: a reason field is copied into the audit summary
 * and, for an in-game action, handed to the game server, so an unbounded one bloats the trail and
 * gets truncated by the game with no warning. These are generous. They exist to stop nonsense, not
 * to second-guess a moderator writing a careful note.
 */
export const TEXT_MAX = {
  /** A label someone reads in a list: a role, a group, a server, a template. */
  name: 200,
  /** Something said to a player in game, or a reason recorded against them. */
  reason: 500,
  /** A note or comment kept for other staff, where the detail is the point. */
  note: 2000,
  /** A noticeboard post — the one place long-form is expected. */
  post: 5000,
} as const;

/**
 * A trimmed string from a request body, refused past `max`.
 *
 * Throws rather than returning an error, because every caller here is a route and the handler turns
 * an AppError into a 400 carrying this message. `field` names the field so the message says which
 * one was too long instead of just that something was.
 */
export function boundedText(v: unknown, max: number, field: string): string {
  const s = str(v).trim();
  if (s.length > max) throw errors.badRequest(`${field} is too long (max ${max} characters)`);
  return s;
}

/** 302 redirect to another location (used by the Discord OAuth callback to bounce back to the panel). */
export function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}
