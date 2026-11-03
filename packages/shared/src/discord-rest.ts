/**
 * THE ONE DOOR TO DISCORD'S REST API — a shared, bucket-aware, priority-aware client.
 *
 * You cannot raise Discord's rate limits. They are enforced per bot token, there is no paid tier,
 * and running several tokens to spread the load is evasion: it gets the application banned. The
 * only real strategy is to stop tripping them, and that is an architecture problem rather than a
 * per-call one — eighteen call sites each doing a raw `fetch` cannot cooperate, because none of
 * them knows what the others just spent. The good pacing logic that existed lived in one file and
 * tracked one budget for every route it touched.
 *
 * What this adds, none of which is possible without a single choke point:
 *
 *  - PER-BUCKET SERIALISATION. Discord names the real bucket in `x-ratelimit-bucket`, and that is
 *    what is keyed on once it is known (a route template stands in until the first reply teaches
 *    us the hash). Calls in one bucket queue behind each other; different buckets run in parallel,
 *    so a slow member sweep never blocks a channel post.
 *
 *  - PROACTIVE WAITING. When a bucket's `remaining` hits zero we sleep out `reset-after` BEFORE
 *    the next call, instead of spending a request to be told what we already knew.
 *
 *  - A GLOBAL PAUSE. A 429 with `x-ratelimit-scope: global` (or a Cloudflare-level block) stops
 *    EVERY bucket, not just the one that earned it. This is the case a per-file limiter cannot
 *    see at all.
 *
 *  - PRIORITY LANES, which is the point of the whole exercise. A member pressing a button in the
 *    VIP panel must never queue behind a two-hundred-player badge sweep. `interactive` work jumps
 *    the queue; `background` work waits behind it and, while the token is under pressure, holds
 *    off entirely. Losing a badge refresh for a minute costs nothing; losing a registration costs
 *    a person their evening.
 *
 * Posture on failure is unchanged from what callers already expect: this returns the Response,
 * including a final 429, and never throws for a rate limit. A caller that wants to distinguish
 * "refused" from "could not ask" still reads the status.
 */

export type DiscordLane = "interactive" | "background";

export interface DiscordRestOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called on every 429, for logging and for the "are we rate limited?" counter. */
  onRateLimit?: (info: { routeKey: string; scope: string; waitMs: number; global: boolean }) => void;
  /** How long background work stands down after a 429 (ms). Interactive work is never held. */
  backgroundCooldownMs?: number;
  /** Deadline on one request (ms). See REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

export interface DiscordRequest {
  /**
   * The route TEMPLATE including major parameters, e.g. "GET /guilds/123/members".
   *
   * It only has to be stable and to separate genuinely different buckets — Discord's own bucket
   * hash replaces it the moment the first response arrives. Keep the guild/channel id in it:
   * those are "major parameters" and really are separate buckets.
   */
  routeKey: string;
  /** Path under the API root, e.g. "/guilds/1/members/2". */
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Defaults to "interactive": the safe default is the one that does not get starved. */
  lane?: DiscordLane;
  /** X-Audit-Log-Reason, when the call changes something a server owner may later ask about. */
  reason?: string;
}

interface Waiter {
  lane: DiscordLane;
  run: () => Promise<void>;
}

interface Bucket {
  interactive: Waiter[];
  background: Waiter[];
  draining: boolean;
  /** what the last response said is left of this window, and when it refills. */
  remaining: number | null;
  resetAtMs: number;
}

const API_ROOT = "https://discord.com/api/v10";
const MAX_429_RETRIES = 3;
/**
 * A hard deadline on every request, because in THIS client a hung socket is not one lost call.
 *
 * Requests in a bucket are drained one at a time, and the drain loop awaits each one. A `fetch`
 * with no deadline can hang for as long as the network lets it, and while it does, the bucket
 * stays `draining`, every request queued behind it waits, and each caller's promise never settles
 * — a badge sweep against a stalled connection would take the VIP panel's buttons down with it.
 * Serialising is the whole design, so the deadline has to live here: `request()` takes no signal,
 * and a caller therefore cannot supply one of its own.
 *
 * A timeout rejects the one call that earned it; the drain loop catches it and moves on.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export interface DiscordRest {
  request(req: DiscordRequest): Promise<Response>;
  /** Diagnostics, so "are we being rate limited?" is a question with an answer. */
  stats(): { rateLimitHits: number; globalPauses: number; queued: number; buckets: number; backgroundHeldUntilMs: number };
}

export function createDiscordRest(opts: DiscordRestOptions = {}): DiscordRest {
  // Resolved at CALL time, not construction: the singleton is built on first use and would
  // otherwise pin whatever `fetch` happened to be then, silently bypassing anything that swaps the
  // global later — instrumentation, a proxy, or a test's stub.
  const doFetch: typeof fetch = (...args) => (opts.fetchImpl ?? fetch)(...args);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms))));
  const backgroundCooldownMs = opts.backgroundCooldownMs ?? 30_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const buckets = new Map<string, Bucket>();
  /** route template → Discord's own bucket hash, learned from the first response. */
  const bucketIdByRoute = new Map<string, string>();
  let globalPauseUntilMs = 0;
  /** Background work stands down until this instant after any 429 — interactive never does. */
  let backgroundHeldUntilMs = 0;
  let rateLimitHits = 0;
  let globalPauses = 0;

  const bucketFor = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = { interactive: [], background: [], draining: false, remaining: null, resetAtMs: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  /** Wait out anything that applies to EVERY request: a global 429, and (background only) the
   *  stand-down that follows one. */
  async function waitForGates(lane: DiscordLane): Promise<void> {
    for (;;) {
      const until = Math.max(globalPauseUntilMs, lane === "background" ? backgroundHeldUntilMs : 0);
      const wait = until - now();
      if (wait <= 0) return;
      await sleep(wait);
    }
  }

  function readLimitHeaders(bucket: Bucket, res: Response, routeKey: string): void {
    const id = res.headers.get("x-ratelimit-bucket");
    // Re-key onto Discord's own bucket the first time it names one: several route templates can
    // share a bucket, and only the hash knows that.
    if (id && bucketIdByRoute.get(routeKey) !== id) {
      bucketIdByRoute.set(routeKey, id);
      if (!buckets.has(id)) buckets.set(id, bucket);
    }
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
    if (Number.isFinite(remaining)) bucket.remaining = remaining;
    if (Number.isFinite(resetAfter)) bucket.resetAtMs = now() + resetAfter * 1000 + 100;
  }

  /** How long a 429 says to wait: the body is authoritative, the header is the fallback. */
  async function retryDelay(res: Response): Promise<number> {
    let ms = Number(res.headers.get("retry-after")) * 1000;
    try {
      const body = (await res.clone().json()) as { retry_after?: number };
      if (typeof body.retry_after === "number") ms = body.retry_after * 1000;
    } catch { /* the header value stands */ }
    return Number.isFinite(ms) && ms > 0 ? ms : 1000;
  }

  async function fire(req: DiscordRequest, bucket: Bucket): Promise<Response> {
    const token = opts.token ?? process.env.DISCORD_TOKEN ?? "";
    const lane = req.lane ?? "interactive";
    for (let attempt = 0; ; attempt++) {
      await waitForGates(lane);
      // Spend the window before the request, not on one already known to be refused.
      if (bucket.remaining !== null && bucket.remaining <= 0) {
        const wait = bucket.resetAtMs - now();
        if (wait > 0) await sleep(wait);
        bucket.remaining = null;
      }
      const headers: Record<string, string> = {
        authorization: `Bot ${token}`,
        ...(req.body === undefined ? {} : { "content-type": "application/json" }),
        ...(req.reason ? { "x-audit-log-reason": req.reason } : {}),
        ...(req.headers ?? {}),
      };
      const res = await doFetch(`${API_ROOT}${req.path}`, {
        method: req.method ?? "GET",
        headers,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      readLimitHeaders(bucket, res, req.routeKey);
      if (res.status !== 429) return res;

      rateLimitHits += 1;
      const scope = res.headers.get("x-ratelimit-scope") ?? "";
      const isGlobal = res.headers.get("x-ratelimit-global") === "true" || scope === "global";
      const waitMs = await retryDelay(res);
      opts.onRateLimit?.({ routeKey: req.routeKey, scope, waitMs, global: isGlobal });
      // Every 429 buys background work a stand-down, whichever lane earned it: the cheapest way
      // to protect a person pressing a button is to stop the sweeps for a moment.
      backgroundHeldUntilMs = Math.max(backgroundHeldUntilMs, now() + Math.max(waitMs, backgroundCooldownMs));
      if (isGlobal) {
        globalPauses += 1;
        globalPauseUntilMs = Math.max(globalPauseUntilMs, now() + waitMs + 100);
      } else {
        bucket.remaining = 0;
        bucket.resetAtMs = now() + waitMs + 100;
      }
      // Hand a persistent 429 back rather than sitting inside it forever; the caller decides.
      if (attempt >= MAX_429_RETRIES) return res;
    }
  }

  function drain(key: string): void {
    const bucket = bucketFor(key);
    if (bucket.draining) return;
    bucket.draining = true;
    void (async () => {
      try {
        for (;;) {
          // Interactive first, always: that is the entire priority mechanism.
          const next = bucket.interactive.shift() ?? bucket.background.shift();
          if (!next) return;
          await next.run();
        }
      } finally {
        bucket.draining = false;
        if (bucket.interactive.length || bucket.background.length) drain(key);
      }
    })();
  }

  return {
    request(req: DiscordRequest): Promise<Response> {
      const lane = req.lane ?? "interactive";
      const key = bucketIdByRoute.get(req.routeKey) ?? req.routeKey;
      const bucket = bucketFor(key);
      return new Promise<Response>((resolve, reject) => {
        const waiter: Waiter = {
          lane,
          run: async () => {
            try { resolve(await fire(req, bucket)); } catch (err) { reject(err as Error); }
          },
        };
        (lane === "interactive" ? bucket.interactive : bucket.background).push(waiter);
        drain(key);
      });
    },
    stats() {
      let queued = 0;
      for (const b of buckets.values()) queued += b.interactive.length + b.background.length;
      return { rateLimitHits, globalPauses, queued, buckets: buckets.size, backgroundHeldUntilMs };
    },
  };
}

/** The process-wide client. One token, one limiter — a second instance would defeat the point. */
let shared: DiscordRest | null = null;
export function discordRest(): DiscordRest {
  if (!shared) shared = createDiscordRest();
  return shared;
}
/** Tests only: drop the singleton so one case's buckets cannot pace another's. */
export function resetDiscordRest(): void {
  shared = null;
}
