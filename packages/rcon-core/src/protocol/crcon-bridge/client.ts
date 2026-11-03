/**
 * Minimal HTTP client for an existing CRCON instance's public API. We only READ through it —
 * this is the coexistence path, so we never issue writes and never open a second RCON socket.
 *
 * CRCON wraps every response as `{ result, failed, error, command }` and authenticates with an
 * API key as a Bearer token. We reuse the server's `password` field as that API key and
 * `crconBaseUrl` as the instance URL.
 *
 * Every endpoint, its permission, and its response shape is catalogued in `docs/crcon-api.md` —
 * check there before adding a call rather than reading their source again.
 */
export interface CrconClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Minimum gap between request *starts*, in ms. All reads are serialized (one in flight) and
   *  spaced by at least this much, so a full data pull is a steady trickle, never a burst that
   *  could overwhelm the CRCON instance. Default 150ms (~6–7 req/s). */
  minIntervalMs?: number;
  /** Retries for transient failures (429 / 502 / 503 / 504 / network), with exponential backoff
   *  that honours a `Retry-After` header when present. Default 3. */
  maxRetries?: number;
  /**
   * Test seams for the request governor. Timing tests that measured real wall-clock gaps flaked
   * for months under parallel turbo load (#305, then again as test 18) — the queue was spacing
   * sends correctly and the MEASUREMENT was jittering. Injecting the clock and the sleep lets a
   * test assert the waits the governor decided on, which is the thing the interval exists to
   * guarantee, with no scheduler in the loop. Production always uses the defaults.
   */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The most of a CRCON response body this client will read.
 *
 * `fetch` resolves as soon as the HEADERS arrive; the body is read separately, afterwards. So the
 * request timeout — which was cleared the moment fetch resolved — never covered the part that
 * actually carries the data, and nothing bounded its size either. Measured against an endpoint
 * that answers with an endless JSON array: 110 seconds and 1,961 MB resident, for a call whose
 * declared timeout is ten seconds, ending in zero usable rows.
 *
 * That matters more here than for a normal HTTP client. This runs inside the worker, which holds
 * every server's connection, and the endpoint is somebody else's CRCON install reached over the
 * network — a big `get_historical_logs`, a proxy streaming an error page, or a host that is simply
 * not what the URL says it is.
 *
 * 32 MB matches what the two native transports allow, and is far above a real response: the
 * largest of these is a historical-log page, hundreds of kilobytes.
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Read a response body with a byte budget, cancelling the stream the moment it is exceeded.
 *
 * Declared length is checked first when the server offers one — no point streaming 2 GB to find
 * out — but the budget is enforced while reading too, because a chunked response has no
 * Content-Length and is exactly the case that hurt.
 */
async function readBounded(res: Response, command: string, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new CrconBridgeError(`CRCON response for ${command} declares ${declared} bytes (limit ${limit})`);
  }
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new CrconBridgeError(`CRCON response for ${command} exceeded ${limit} bytes — is this URL really a CRCON instance?`);
      }
      chunks.push(value);
    }
  } finally {
    // Hangs up on the sender rather than politely reading out a body we have already refused.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** HTTP statuses worth retrying: rate limit, request timeout, origin 5xx, and Cloudflare 52x. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

/** A CRCON structured log line. `raw` is the original game log text — exactly what our
 *  normalizer consumes — so a bridged server feeds the same pipeline as a direct one. */
export interface CrconLog {
  timestamp_ms?: number;
  raw?: string;
  action?: string;
}

export class CrconBridgeError extends Error {}

/** Internal marker for a retryable failure (429/5xx/network); never escapes the client. */
class TransientCrconError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) { super(message); this.retryAfterMs = retryAfterMs; }
}

/** Parse a `Retry-After` header (delta-seconds or an HTTP date) into ms, capped so a bad value
 *  can't stall the whole import. Returns undefined when absent/unparseable. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, 30_000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), 30_000);
  return undefined;
}

export class CrconClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  // Serialized request queue: every get() chains onto the previous one, so at most one request is
  // ever in flight and starts are spaced by minIntervalMs. This is the single choke point that
  // keeps even a full "pull everything" pass from bursting against the CRCON instance.
  private tail: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: CrconClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 150);
    this.maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleep;
  }

  /** GET `${baseUrl}/api/${command}` with the Bearer key; unwrap CRCON's `{ result, failed }`.
   *  Serialized behind the shared queue and spaced by `minIntervalMs`; transient failures retry
   *  with backoff. */
  async get(command: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const run = this.tail.then(async () => {
      const wait = this.minIntervalMs - (this.now() - this.lastStart);
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return this.getWithRetry(command, query);
    });
    // Keep the chain alive whether this call resolves or rejects, so one failure doesn't wedge the queue.
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** One command with bounded retries on transient (429/5xx/network) failures. */
  private async getWithRetry(command: string, query: Record<string, string | number | undefined>): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.getOnce(command, query);
      } catch (err) {
        const retry = err instanceof TransientCrconError;
        if (!retry || attempt >= this.maxRetries) {
          throw retry ? new CrconBridgeError((err as Error).message) : err;
        }
        // Honour Retry-After when the server gave one; otherwise exponential backoff (0.5s, 1s, 2s…).
        const backoff = (err as TransientCrconError).retryAfterMs ?? 500 * 2 ** attempt;
        await this.sleep(backoff);
        attempt += 1;
      }
    }
  }

  /** A single GET attempt. Throws TransientCrconError for retryable conditions. */
  private async getOnce(command: string, query: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/api/${command}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));

    const ac = new AbortController();
    // The timer stays armed until the BODY has been read, not just until the headers land. It used
    // to be cleared the moment `fetch` resolved, which left the part that carries the data with no
    // deadline of any kind — a slow trickle could hold the request open indefinitely.
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" }, signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      // Network errors / timeouts are worth a retry.
      throw new TransientCrconError(`CRCON request failed (${command}): ${(err as Error).message}`);
    }
    try {
      return await this.readResponse(res, command);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Status handling + the bounded body read, split out so the abort timer can wrap all of it. */
  private async readResponse(res: Response, command: string): Promise<unknown> {
    if (res.status === 401 || res.status === 403) throw new CrconBridgeError(`CRCON rejected the API key (${res.status}) for ${command}`);
    // Retryable: rate limit (429), request timeout (408), origin 5xx (500/502/503/504), and the
    // Cloudflare gateway/timeout family (520-524) — a hosted CRCON behind a proxy emits these under
    // load, and a long pull shouldn't abort on a single transient blip.
    if (TRANSIENT_STATUS.has(res.status)) {
      throw new TransientCrconError(`CRCON returned ${res.status} for ${command}`, parseRetryAfter(res.headers.get("retry-after")));
    }
    if (!res.ok) throw new CrconBridgeError(`CRCON returned ${res.status} for ${command}`);

    // A body over budget is NOT retryable: re-requesting it would just download it again, three
    // more times, and the answer would be the same each time.
    const text = await readBounded(res, command, MAX_BODY_BYTES);
    let body: { result?: unknown; failed?: boolean; error?: unknown } = {};
    // Non-JSON is tolerated exactly as before — a proxy's HTML error page reads as an empty result
    // rather than an exception with a stack full of markup.
    try { body = JSON.parse(text) as typeof body; } catch { body = {}; }
    if (body && typeof body === "object" && body.failed) {
      throw new CrconBridgeError(`CRCON command ${command} failed: ${String(body.error ?? "unknown error")}`);
    }
    // Newer CRCON wraps payloads in `result`; tolerate a bare body for older/edge responses.
    return body && typeof body === "object" && "result" in body ? body.result : body;
  }

  /** Recent structured logs, returned OLDEST-first — chronological — whatever order CRCON sent. */
  async recentLogs(count: number): Promise<CrconLog[]> {
    const result = await this.get("get_recent_logs", { end: count });
    const logs = extractLogs(result);
    // CRCON serves these most-recent-first (its log history is a newest-first list; the endpoint's
    // own early-stop-on-old-timestamp logic depends on that). Batch order downstream is not
    // cosmetic: ingest pairs each connect with its disconnect and attributes kills to whichever
    // match is open at that point in the batch, so a reversed batch closes the wrong session and
    // mis-buckets kills at round boundaries. Sort by the structured millisecond timestamp — a
    // stable sort, not a blind reverse, so a response CRCON someday sends already-chronological
    // (or with the odd timestampless line, which keeps its relative position) cannot be made worse.
    return logs
      .slice()
      .sort((a, b) => (typeof a.timestamp_ms === "number" && typeof b.timestamp_ms === "number" ? a.timestamp_ms - b.timestamp_ms : 0));
  }
}

/** Pull the log array out of ParsedLogsType (`{ logs: [...] }`) or a bare array. */
export function extractLogs(result: unknown): CrconLog[] {
  if (Array.isArray(result)) return result as CrconLog[];
  if (result && typeof result === "object") {
    const logs = (result as { logs?: unknown }).logs;
    if (Array.isArray(logs)) return logs as CrconLog[];
  }
  return [];
}
