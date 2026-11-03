/**
 * Thin client for the panel REST API. Same origin as the panel, so paths are relative to
 * `/api`. The bearer token lives in localStorage; SSE passes it via query string because
 * EventSource can't set headers.
 */
const TOKEN_KEY = "panel.token";

import { resetTrail } from "./trail";
import { announceFiled, filedMessage, isFiled } from "./filed";
import { proxyAnswer } from "./gateway";
export { ADDED_TO_REQUEST, SENT_FOR_APPROVAL, onRequestFiled, type FiledNotice } from "./filed";
import { effectiveZone, fmtExact } from "./time";

/**
 * Read-only role preview (lib/rolePreview). While a preview is on, the whole panel is a
 * simulation of what a lesser role sees, so no write may leave the browser — a stray POST would
 * change the world from inside a "just looking" mode. Every read names the role instead, and the
 * API answers it as that role would be answered, never past what the previewer may see: narrowing
 * only the panel's own screens left whatever a screen showed without asking first (the dashboard's
 * cards, the server list) on the previewer's own access. Set by the preview provider on enter/exit;
 * checked in api() below. A module variable, not React state, because api() is a plain function.
 */
let previewRoleId: string | null = null;
export function setRolePreview(roleId: string | null): void { previewRoleId = roleId; }

/**
 * What every request to the API carries: the sign-in, and the role being previewed. For the few
 * requests that cannot go through api() (a file's bytes either way). The account's own read
 * (`/me`) never names the role: its grants are the previewer's real ones, which the panel narrows
 * from, and the next read after the preview must not find them narrowed.
 */
export function authHeaders(path = ""): Record<string, string> {
  const token = getToken();
  const own = path === "/me" || path.startsWith("/me?");
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(previewRoleId && !own ? { "x-preview-role": previewRoleId } : {}),
  };
}

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(TOKEN_KEY) || "";
}
// Both writes reset the navigation trail: these two functions are the choke point every identity
// change goes through — password login, the Discord OAuth handoff, sign out, session expiry —
// and the trail is the last ten screens of whoever was signed in before. On a shared computer
// that history is not the next person's to walk back through.
/** Request-mode state is SESSION state, like the trail: it must not survive a sign-out and greet
 *  the next account on this browser with an auto-entered builder and someone else's return page.
 *  (Keys owned by lib/requestMode.tsx — kept in step there.) */
function resetRequestMode(): void {
  window.localStorage.removeItem("panel.requestMode");
  window.localStorage.removeItem("panel.requestMode.return");
}
export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  resetTrail();
  resetRequestMode();
  // A sign-in ends any role preview: the flag is module state, and left set it would refuse the
  // NEXT account's writes with a message about a preview they never started.
  previewRoleId = null;
}
export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  resetTrail();
  resetRequestMode();
  previewRoleId = null; // same reason as setToken — identity changes end the simulation
}
/**
 * A renewed sign-in for the SAME account (the API's /me hands one back while the panel is in use).
 * Nothing about who is signed in changes, so unlike setToken this leaves the trail, request mode
 * and any role preview exactly as they are — renewing must not cost anyone their place.
 */
export function renewToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

/**
 * A failed request, carrying what the server actually said.
 *
 * `status` is the HTTP status, or 0 when no answer arrived at all — a timeout, a dropped
 * connection, a proxy that hung up. That distinction is the point of this class: "the server
 * refused your credential" (401) and "the panel could not reach the server" look identical to a
 * caller that only sees a message, and code that treats the second as the first throws away a
 * perfectly good session because the network blinked.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
  }
}

/** A write filed for approval instead of done (the 202 lib/api raises): news, not a failure, so it
 *  keeps the screen's own line rather than popping up as one. */
export function wasFiled(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 202;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /**
   * Give up after this long. 0 disables it, for the handful of calls that are legitimately slow
   * (a trim deleting millions of rows, a first CRCON pull).
   */
  timeoutMs?: number;
  /** Take the 202 "filed instead of done" envelope as a normal answer, and say so yourself. */
  raw202?: boolean;
}

/**
 * Long enough that no healthy request comes close, short enough that a wedged backend is reported
 * rather than waited on. A minute of nothing is already a fault, not slowness.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** The browser tests shorten this so they don't have to wait a real minute to prove the point. */
const defaultTimeout = (): number => {
  const injected = (globalThis as { __API_TIMEOUT_MS__?: number }).__API_TIMEOUT_MS__;
  return typeof injected === "number" && injected > 0 ? injected : DEFAULT_TIMEOUT_MS;
};

/** The browser's own IANA zone, or "" when the runtime won't say (then the API stays on UTC). */
function viewerTimeZone(): string {
  // The DISPLAY zone, so analytics buckets ("which hours are thin on cover") land on the same
  // clock every timestamp on screen is written in — the community's, unless this person chose
  // their own. The device zone only answers when neither is set yet (pre-boot requests).
  try {
    return effectiveZone();
  } catch {
    return "";
  }
}

/*
 * A 202 from a write means "not done — filed instead", and it can now come back from screens that
 * never asked about approvals: every server-scoped write (map work, votes, seeding, console,
 * configuration) files a request when the caller lacks the permission, and captures into the cart
 * while one is being built.
 *
 * Returning that body normally would let a hundred call sites announce "Saved" for something that
 * has not happened, which is the one lie this whole feature exists to avoid. So it is raised
 * instead: every screen already has a path for "your write did not go through", and this IS that,
 * with better news. The words and the listener live in `lib/filed` (a module with no imports of
 * its own), because the toast layer and the inline error strip read them too.
 *
 * Screens that want to say something richer ("Banned 24h now — the rest went for approval") pass
 * `raw202` and handle the envelope themselves.
 */
export async function api<T = any>(path: string, { method = "GET", body, timeoutMs = defaultTimeout(), raw202 = false }: ApiOptions = {}): Promise<T> {
  // A role preview is look-only: refuse any non-GET before it reaches the wire, with words that
  // name the mode rather than a bare 4xx. GET/HEAD read the same data the previewed role would.
  if (previewRoleId && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") {
    throw new ApiError("You're previewing a role — it's read-only. Exit the preview to make changes.", 0);
  }
  // Without this, a server that accepts the connection but never answers leaves every screen on a
  // loading skeleton forever, with nothing on the page saying why — which makes the one failure
  // that most needs explaining the one the panel explains least.
  const ctl = timeoutMs > 0 ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        // Charts that bucket by hour or day are answering a question about LOCAL time — "which
        // hours of the week are thin on cover" is meaningless in UTC for a community that isn't on
        // it. Sent on every request so no caller has to remember it; the API ignores it where it
        // doesn't apply, and falls back to UTC if it can't use the zone.
        ...(viewerTimeZone() ? { "x-time-zone": viewerTimeZone() } : {}),
        ...authHeaders(path),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl?.signal,
    });
  } catch (err) {
    // Distinguish "took too long" from "couldn't reach it at all" — they need different fixes, and
    // the generic "Failed to fetch" tells the reader neither.
    if ((err as Error)?.name === "AbortError") {
      throw new ApiError(`The server did not respond within ${Math.round(timeoutMs / 1000)}s — it may be restarting or overloaded.`, 0, { cause: err });
    }
    throw new ApiError(`Could not reach the server (${(err as Error)?.message || "network error"}).`, 0, { cause: err });
  } finally {
    if (timer) clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw refusalOf(res.status, data);
  if (!raw202 && isFiled(res.status, data)) {
    announceFiled(data);
    throw new ApiError(filedMessage(data), 202);
  }
  return data as T;
}

/** A refused answer, in words. */
function refusalOf(status: number, data: unknown): ApiError {
  // error body is { error: { code, message, requestId } }; surface the request id so a user
  // can quote it when reporting a problem.
  const e = (data as { error?: { message?: string; requestId?: string } } | null)?.error || {};
  const rid = e.requestId ? ` (ref ${e.requestId})` : "";
  // A gateway status with NO parseable body did not come from our API — the proxy in front of
  // it answered (Cloudflare and friends replace an origin 502 with their own page, time out
  // requests with a 504 of their own, and answer 530 while their tunnel to this computer is
  // down). A bare "HTTP 530" reads like a fault in the panel; lib/gateway says what it is.
  const gateway = !e.message ? proxyAnswer(status) : null;
  return new ApiError(gateway ?? (e.message || `HTTP ${status}`) + rid, status);
}

/**
 * The same words, for the few requests that cannot go through api() — a file's bytes, either way.
 * Each read its refusal its own way: most said only "download failed (409)" where the API had said
 * why (an export still being written, an upload already under way), and one failed on a proxy's
 * error page with a parse error in place of either.
 */
export async function refusal(res: Response): Promise<ApiError> {
  return refusalOf(res.status, await res.json().catch(() => null));
}

/** URL for the live event stream, with the token (and optional server scope) in the query. */
export function streamUrl(serverId?: string): string {
  const qs = new URLSearchParams({ token: getToken() });
  if (serverId) qs.set("serverId", serverId);
  // A stream cannot carry headers, so a preview's role rides in the address like the sign-in.
  if (previewRoleId) qs.set("previewRole", previewRoleId);
  return `/api/events/stream?${qs.toString()}`;
}

/** The browser tests shorten this so a reopened stream does not cost them a real wait. */
const streamRetryMs = (): number => {
  const injected = (globalThis as { __STREAM_RETRY_MS__?: number }).__STREAM_RETRY_MS__;
  return typeof injected === "number" && injected > 0 ? injected : 5_000;
};

/**
 * The live event stream, kept open for as long as the screen wants it. Returns the closer.
 *
 * EventSource retries a dropped connection by itself, but only with the address it was opened
 * with, and that address carries the sign-in. A screen left open for days outlives that sign-in
 * now that the panel renews it while in use (renewToken), and the browser stops for good on the
 * refusal that follows — as it does on a proxy's error page while the API restarts. So when the
 * browser gives up, a new stream is opened on the current sign-in. Signed out, it stays closed.
 */
export function openStream(serverId: string | undefined, on: { message: (data: string) => void; open?: () => void; error?: () => void }): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    if (closed || !getToken()) return;
    const es = new EventSource(streamUrl(serverId));
    source = es;
    es.onopen = () => on.open?.();
    es.onmessage = (e) => on.message(String(e.data));
    es.onerror = () => {
      on.error?.();
      if (es.readyState === EventSource.CLOSED && !closed) retry = setTimeout(connect, streamRetryMs());
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    source?.close();
  };
}

export function fmt(iso?: string): string {
  // One formatter for the whole panel: lib/time's fmtExact writes the display zone (the person's
  // preference, else the community's), so a second device-zone copy here would be the drift.
  return fmtExact(iso);
}
