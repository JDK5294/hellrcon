/**
 * The API's request handler, and the route table it dispatches against.
 *
 * The routes themselves live in ./routes, grouped by what they are about — this file is the
 * assembler. It was one 5,000-line module holding every route, every helper and the handler, which
 * meant no way to open "the players API" without opening all of it.
 *
 * Order matters here only in one respect: matching is first-declared-wins. Every pair of routes
 * where one's URLs can also match the other lives inside a single module, so the modules can be
 * listed in any order — there is a test that keeps that true.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger, toErrorResponse, isAppError } from "@app/shared";
import { sendJson, sendError } from "./http.js";
import { publicHostView } from "./public-host.js";
import { serveStatic, staticRel } from "./static.js";
import type { AppContext } from "./context.js";
import type { Route } from "./routes/kit.js";
import { adminRoutes } from "./routes/admin.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { communityRoutes } from "./routes/community.js";
import { authRoutes } from "./routes/auth.js";
import { pushRoutes } from "./routes/push.js";
import { setupRoutes } from "./routes/setup.js";
import { demoOn, onlineRoutes } from "./routes/online.js";
import { automationRoutes } from "./routes/automation.js";
import { discordRoutes } from "./routes/discord.js";
import { miscRoutes } from "./routes/misc.js";
import { serversRoutes } from "./routes/servers.js";
import { moderationRoutes } from "./routes/moderation.js";
import { pluginRoutes } from "./routes/plugins.js";
import { zoneRoutes } from "./routes/zones.js";
import { economyRoutes } from "./routes/economy.js";
import { payoutRoutes } from "./routes/payouts.js";
import { mapsRoutes } from "./routes/maps.js";
import { mapLibraryRoutes } from "./routes/map-library.js";
import { adminCamRoutes } from "./routes/admin-cam.js";
import { playersRoutes } from "./routes/players.js";
import { ingestRoutes } from "./routes/ingest.js";
import { crconNotGet, streamerRoutes } from "./routes/streamer.js";
import { dataPortRoutes } from "./routes/dataport.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { clanRoutes } from "./routes/clans.js";

// Re-exported so callers (index.ts, every API test) keep importing the app's entry points from
// here rather than having to know the internal split.
export { createAppContext } from "./context.js";
export type { AppContext, CrconTransformRun } from "./context.js";

/**
 * Every route, in the order the dispatcher tries them — FIRST match wins, so order is behaviour.
 *
 * Exported for the test that walks it looking for a route no request can ever reach: a literal
 * path registered after a `:param` route that swallows it. `/api/requests/draft` behind
 * `/api/requests/:id` is a 404 nobody would think to look for, and the only defence until now was
 * a comment asking the next person to keep the literals first.
 */
export const routes: Route[] = [
  ...adminRoutes,
  ...approvalsRoutes,
  ...analyticsRoutes,
  ...communityRoutes,
  ...authRoutes,
  ...pushRoutes,
  ...setupRoutes,
  ...onlineRoutes,
  ...automationRoutes,
  ...discordRoutes,
  ...miscRoutes,
  ...serversRoutes,
  ...moderationRoutes,
  ...pluginRoutes,
  ...zoneRoutes,
  ...economyRoutes,
  ...payoutRoutes,
  ...mapsRoutes,
  ...mapLibraryRoutes,
  ...adminCamRoutes,
  ...playersRoutes,
  ...clanRoutes,
  ...ingestRoutes,
  ...streamerRoutes,
  ...dataPortRoutes,
];

/** `/s/<serverId>/api/<command>` — the CRCON-compatible public surface (legacy mount). */
const STREAMER_PATH = /^\/s\/[^/]+\/api\//;
/** `/stats/<slug>/api/<command>` — the same surface on the public stats site's own address, so
 *  one base URL serves a server's page AND the API its overlay tools call. Everything else under
 *  /stats/ is the exported page, served by the static handler below. */
const STATS_API_PATH = /^\/stats\/[^/]+\/api\//;
/** One command at either CRCON mount, its name captured. */
const CRCON_COMMAND_PATH = /^\/(?:s|stats)\/[^/]+\/api\/([^/]+)$/;

/** The public demo's page in the export (demo/ and anything else of its), as `serveStatic` would
 *  find it: the same file under another spelling — //demo/, /DEMO on a disk that ignores case — is
 *  still its. */
const DEMO_FILE = /^demo(?![\w-])/i;

/**
 * Sent from the public demo's page on this panel. The demo answers every request the panel makes in
 * the visitor's own browser and sends none here (lib/demo/install), so anything from its page that
 * reaches the API anyway — a link or a picture's address it did not catch, a form — is refused: the
 * demo never reads or changes anything of this install's, whoever opens it, signed in or not. The
 * browser names the page a request comes from (Referer), in full for a request to its own site.
 */
function fromDemoPage(req: IncomingMessage): boolean {
  const referer = req.headers.referer;
  if (!referer) return false;
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return false;
  }
  const sameSite = req.headers["sec-fetch-site"] === "same-origin" || from.host === req.headers.host;
  return sameSite && DEMO_FILE.test(staticRel(from.pathname));
}

const logger = createLogger("api");

export function createHandler(ctx: AppContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Node hands the request's address over as written, and one that is not a URL at all
    // ("http://[", "//[::1") makes this throw. Outside the error handling below, that rejected the
    // handler, and an unhandled rejection ends the process (process-guards): one such request
    // restarted the panel for everyone. It is a bad request.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return sendError(res, 400, "bad request");
    }
    // On the dedicated public-stats hostname only the public surface exists, and short paths
    // (stats.example.com/nam) are folded under /stats before routing. See public-host.ts.
    const view = publicHostView(req.headers.host, url.pathname, ctx.config.publicStatsHost);
    if (!view.allowed) return sendError(res, 404, "not found");
    const path = view.path;
    const method = req.method ?? "GET";

    // Correlation id on every request — returned as a header and in every error body, so a
    // user-reported failure can be traced straight to the matching log line.
    const requestId = randomUUID();
    (res as ServerResponse & { requestId?: string }).requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const log = logger.child({ requestId, method, path });

    try {
      // Streamer mode lives OUTSIDE /api/ on purpose: a CRCON tool is configured with a base URL
      // and appends `/api/<command>` itself, so the base has to be a prefix we own
      // (`/s/<serverId>`). Matching is otherwise identical — the handler, not this dispatch, is
      // what decides an anonymous caller may proceed. See routes/streamer.ts.
      if (path.startsWith("/api/") || STREAMER_PATH.test(path) || STATS_API_PATH.test(path)) {
        if (fromDemoPage(req)) return sendError(res, 403, "the public demo cannot reach this panel");
        // The CRCON mounts take GET alone, and answer every other method as CRCON does.
        const crcon = method === "GET" ? null : CRCON_COMMAND_PATH.exec(path);
        if (crcon) return crconNotGet(req, res, crcon[1]!);
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.pattern.exec(path);
          if (!m) continue;
          const params: Record<string, string> = {};
          // An escape that does not decode ("%E0%A4%A", "%ZZ") names nothing any route takes: a bad
          // request, like an address that does not parse, not a server error with a stack in the log.
          try {
            r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
          } catch {
            return sendError(res, 400, "bad request");
          }
          await r.handler(req, res, ctx, params);
          return;
        }
        return sendError(res, 404, "not found");
      }
      // The public demo exists only while Online access shows it.
      if (DEMO_FILE.test(staticRel(path)) && !(await demoOn(ctx))) return sendError(res, 404, "not found");
      await serveStatic(req, res, ctx.config.webRoot, path);
    } catch (err) {
      const { status, body } = toErrorResponse(err, requestId);
      // 5xx = unexpected: log full detail (incl. stack). 4xx = expected client error: log briefly.
      if (status >= 500) log.error("request failed", { err, status, code: body.error.code });
      else log.warn("request rejected", { status, code: body.error.code, reason: isAppError(err) ? err.message : undefined });
      if (!res.headersSent) sendJson(res, status, body);
    }
  };
}
