/**
 * The leftovers that belong to no single domain: the game descriptors and the event stream.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { authenticate, authenticateByQuery } from "../auth.js";
import { sendError, sendJson } from "../http.js";
import { can, canAnywhere } from "@app/access";
import { getGame, listGames } from "@app/games";
import { requirePrincipal, route, sendForbidden, type Route } from "./kit.js";

export const miscRoutes: Route[] = [
  // --- Game modules ---
  // Registered games (id + label) — feeds the Add Server form's game selector.
  route("GET", "/api/games", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    sendJson(res, 200, { games: listGames().map((g) => ({ id: g.id, label: g.label, protocols: g.protocols })) });
  }),

  // --- Game descriptors ---
  // JSON-safe domain data for a game (factions, roles, score fields, config schema). The panel
  // renders vocabulary from this — no game constants in the UI.
  route("GET", "/api/games/:id/descriptor", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const mod = getGame(params.id!);
    if (!mod) return sendError(res, 404, `unknown game '${params.id}'`);
    sendJson(res, 200, { descriptor: mod.descriptor });
  }),

  // Live event stream (Server-Sent Events). Pushes each `evt.*` as it's stored — this is what
  // makes the panel update in real time from the always-on worker (via the Redis bus).
  // Browsers' EventSource can't set headers, so the token may come from `?token=` as well as
  // the Authorization header. Optional `?serverId=` narrows the stream to one server.
  route("GET", "/api/events/stream", async (req, res, ctx) => {
    const url = new URL(req.url ?? "", "http://x");
    const reauthenticate = async () =>
      (await authenticate(req, ctx.repo, ctx.config))
      ?? (await authenticateByQuery(req, ctx.repo, ctx.config));
    let principal = await reauthenticate();
    if (!principal) return sendError(res, 401, "unauthorized");
    const serverId = url.searchParams.get("serverId") || null;
    // Entry: a named server is checked against that server; an unscoped stream only needs a grant
    // SOMEWHERE, because what it may carry is decided per event below rather than up front.
    const allowed = serverId
      ? can(principal.grants, "server.view", "read", { serverId })
      : canAnywhere(principal.grants, "server.view", "read");
    if (!allowed) return sendForbidden(res, "server.view", "read");

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // disable proxy buffering so events flush immediately
    });
    res.write("retry: 3000\n\n"); // tell the browser to reconnect ~3s after a drop
    res.write(": connected\n\n");

    // Authorize every event against the grants, not just the connection. The old code checked once
    // and then filtered on the query parameter, which got both directions wrong: an unscoped stream
    // ignored a per-server `none` veto (the veto is server-scoped, so it never applied to a check
    // made with no scope), and a per-server moderator could not open the unscoped stream at all.
    // A grant lookup per event is cheap — it is an array walk over the principal's own grants.
    const visible = new Map<string, boolean>();
    const maySee = (sid: string | undefined): boolean => {
      if (!sid) return true; // instance-wide event, not about any one server
      let ok = visible.get(sid);
      if (ok === undefined) {
        ok = can(principal!.grants, "server.view", "read", { serverId: sid });
        visible.set(sid, ok);
      }
      return ok;
    };
    /**
     * The write buffer is the one unbounded thing on this connection, so it gets a ceiling.
     *
     * A client that DISCONNECTS is handled below. The dangerous client is the one that stays
     * connected and stops READING — a frozen laptop, a phone that wandered off wifi mid-TCP, a
     * tab suspended with the window open. Every `res.write` to it succeeds and buffers in this
     * process, fed by the busiest producer in the app (a full server's kill feed), for as long
     * as the socket stays technically alive. That is a slow memory leak per stalled viewer,
     * invisible until several of them add up.
     *
     * When the buffer passes the cap, the connection is ended rather than throttled: SSE has no
     * way to tell a browser "slow down", and the client's own `retry:` reconnects it in seconds
     * with fresh state — which for a live feed is strictly better than a backlog of stale events.
     */
    const MAX_BUFFERED_BYTES = 1_000_000;
    const send = (event: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      const e = event as { serverId?: string };
      if (serverId && e.serverId !== serverId) return; // scoped stream: skip other servers
      if (!maySee(e.serverId)) return;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        cleanup();
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = ctx.bus.on("*", send);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    // The heartbeat comment keeps intermediaries from closing an idle connection — and, on the same
    // tick, re-reads the principal.
    //
    // This stream is the one place in the app that holds a decision open indefinitely. Grants and
    // the session epoch were read once at connect, so revoking someone's access — or locking out a
    // compromised account, which is the whole point of the epoch — left their open stream feeding
    // them live events for as long as the browser stayed on the page. A tab left open overnight is
    // a night of events after the revoke.
    //
    // Re-reading costs one session lookup per connection per 25 seconds, which is nothing next to
    // the events the same connection is already carrying. A session that no longer resolves ends
    // the response; grants that changed take effect immediately, because the per-server decisions
    // cached in `visible` are dropped with them.
    const heartbeat = setInterval(() => void (async () => {
      if (res.writableEnded) return;
      const fresh = await reauthenticate().catch(() => principal); // a db blip must not sign anyone out
      if (!fresh) { cleanup(); res.end(); return; }
      principal = fresh;
      visible.clear();
      if (!res.writableEnded) res.write(": ping\n\n");
    })(), 25_000);
    req.on("close", cleanup);
    res.on("error", cleanup);
    /*
     * Belt-and-braces: the response's 'close' is the signal DOCUMENTED to mean "this connection
     * is over", whatever Node version is underneath. On current Node the request's 'close' above
     * does fire on a client disconnect (verified by test), but its semantics moved once already —
     * since Node 15 it is tied to message completion, which for an unconsumed GET body leans on
     * stream-dumping internals — and if it moved again the fallback would be a write failing,
     * which on a quiet stream is the 25-second heartbeat at best. `writableEnded` cannot catch it
     * either: it only turns true after OUR end(), never on the client's destroy. cleanup() is
     * idempotent, so listening on all three costs nothing.
     */
    res.on("close", cleanup);
  }),
];
