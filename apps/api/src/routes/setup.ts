/**
 * First-run setup: where the install stands, the setup-code check, a connection test for the first
 * game server, and the walk-through's end. The code itself is enforced on account creation
 * (routes/auth.ts); the reasons are in setup.ts.
 */
import { canAnywhere } from "@app/access";
import { getGame, listGames } from "@app/games";
import type { ServerRow } from "@app/db";
import { fetchLiveServerName } from "../discovery.js";
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { clientAddrOf } from "../rate-limit.js";
import { deployRoute, SETUP_CODE_KEY, SETUP_STAGE_KEY, SETUP_THROTTLE_KEY, setupCodesMatch, setupLockedOut, WHERE_THE_CODE_IS } from "../setup.js";
import { logger, requirePrincipal, route, sendForbidden, type Route } from "./kit.js";

export const setupRoutes: Route[] = [
  /**
   * Public, like /api/auth/status: whether the install still needs its owner, whether creating one
   * takes the setup code, whether the owner is part-way through the walk-through, how the install
   * was put on its machine, and whether its Cloudflare tunnel is connected (the start scripts ask,
   * to retire the separate tunnel container older installs ran). Nothing in it helps anyone claim
   * the install.
   */
  route("GET", "/api/setup/status", async (_req, res, ctx) => {
    const needed = (await ctx.repo.users.count()) === 0;
    const codeRequired = needed && (await ctx.repo.installSettings.get(SETUP_CODE_KEY)) !== null;
    const stage = (await ctx.repo.installSettings.get(SETUP_STAGE_KEY)) === "walkthrough" ? "walkthrough" : null;
    sendJson(res, 200, { needed, codeRequired, stage, route: deployRoute(), tunnel: ctx.tunnel.status().state });
  }),

  /** The setup page's first step: is this the code? Throttled the same way account creation is. */
  route("POST", "/api/setup/verify", async (req, res, ctx) => {
    const held = await ctx.repo.installSettings.get(SETUP_CODE_KEY);
    if (held === null) return sendError(res, 409, "this install is already set up — sign in instead");
    const addr = clientAddrOf(req.headers, req.socket?.remoteAddress ?? undefined);
    const gate = ctx.loginThrottle.check(SETUP_THROTTLE_KEY, addr);
    if (!gate.allowed) {
      res.setHeader("retry-after", String(gate.retryAfterSec));
      return sendError(res, 429, setupLockedOut(gate.retryAfterSec));
    }
    const body = await readJsonBody(req);
    if (!setupCodesMatch(body.code, held)) {
      ctx.loginThrottle.fail(SETUP_THROTTLE_KEY, addr);
      logger.warn("wrong setup code", { addr });
      return sendError(res, 403, `that is not this install's setup code — ${WHERE_THE_CODE_IS}`);
    }
    sendJson(res, 200, { ok: true });
  }),

  /**
   * Try a game server's details before saving them: connect, read its name, disconnect. Nothing
   * is stored. The walk-through's "Test connection"; the same check Administration → Connections
   * runs when a server is added, without the add.
   */
  route("POST", "/api/setup/test-server", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.add", "write")) return sendForbidden(res, "server.add", "write");
    const body = await readJsonBody(req);
    const host = str(body.host).trim();
    const port = Number(body.port);
    const password = str(body.password);
    if (!host || !password) return sendError(res, 400, "the server's address and RCON password are required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, "the RCON port must be a whole number between 1 and 65535");
    const game = str(body.game).trim().toLowerCase() || "hll";
    if (!getGame(game)) return sendError(res, 400, `unknown game '${game}'. Known: ${listGames().map((g) => g.id).join(", ")}`);
    const probe = { protocol: "binary-v2", game, host, port, password, headerMode: "magic", crconBaseUrl: null } as unknown as ServerRow;
    try {
      const name = await fetchLiveServerName(probe, 6000);
      sendJson(res, 200, { ok: true, name });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: (err as Error).message || "could not connect" });
    }
  }),

  /** The owner finished (or skipped) the walk-through: the panel opens normally from here on. */
  route("POST", "/api/setup/finish", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    await ctx.repo.installSettings.set(SETUP_STAGE_KEY, null);
    sendJson(res, 200, { ok: true });
  }),
];
