/**
 * The plugins' surface of the API: the list of what is loaded, widget data, the pages plugins add
 * to the panel, and every route a plugin answers under `/api/plugins/<id>/…`.
 *
 * One module, because the catch-all at the bottom also matches every other address here: matching
 * is first-declared-wins, and the widget-data route has to be met before it.
 */
import { canAnywhere } from "@app/access";
import { errors } from "@app/shared";
import { authenticate, authenticateByQuery, type Principal } from "../auth.js";
import { sendError, sendJson } from "../http.js";
import { mayOpenPage, pluginRequest, pluginResponse, pluginsKnownTo, viewerFor } from "../plugin-http.js";
import { pluginPermission } from "../plugin-permissions.js";
import type { AppContext } from "../context.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requirePrincipal, route, sendForbidden, type Route } from "./kit.js";

/** The path below `/api/plugins/<id>`, as it arrived: still escaped, so a plugin's own route table
 *  decodes each parameter exactly once and an escaped slash never turns into a real one. */
const RAW_REST = /^\/api\/plugins\/[^/]+(\/.*)$/;

/** The plugin route a request lands on, matched on the path below `/api/plugins/<id>`. */
function matchRoute(req: IncomingMessage, ctx: AppContext, pluginId: string) {
  const rest = RAW_REST.exec(new URL(req.url ?? "", "http://x").pathname)?.[1] ?? "/";
  return ctx.pluginRuntime.routes.match(pluginId, req.method ?? "GET", rest);
}

/** Signing in by `?token=`: the only way an EventSource can, so a stream route takes it too. */
async function tokenPrincipal(req: IncomingMessage, ctx: AppContext): Promise<Principal | null> {
  return authenticateByQuery(req, ctx.repo, ctx.config);
}

/**
 * Hands a signed-in request to the plugin, which decides for itself what this viewer may do there
 * (viewer.holds, against the permissions it declared). Every route below signs the caller in
 * FIRST, whatever the address, so an anonymous caller is told nothing about which plugin routes
 * exist.
 */
async function dispatch(req: IncomingMessage, res: ServerResponse, ctx: AppContext, pluginId: string, p: Principal): Promise<void> {
  const found = matchRoute(req, ctx, pluginId);
  if (!found) return sendError(res, 404, "not found");
  const stream = found.route.stream;
  const reauth = async () => {
    const again = (await authenticate(req, ctx.repo, ctx.config)) ?? (stream ? await tokenPrincipal(req, ctx) : null);
    return again ? viewerFor(pluginId, again) : null;
  };
  await found.route.handler(
    pluginRequest(req, pluginId, found.params, viewerFor(pluginId, p)),
    pluginResponse(req, res, pluginId, { stream, reauth }),
  );
  // A handler that answered nothing would leave the browser waiting for ever.
  if (!res.headersSent) sendError(res, 500, "the plugin sent no answer");
}

export const pluginRoutes: Route[] = [
  // Loaded plugins (id/name/version/capabilities). Panel content, so server.view gates it. This list
  // is open to every member of staff, so a plugin that asks to be unlisted is named only to someone
  // who may open one of its pages, and marked as unlisted for them.
  route("GET", "/api/plugins", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    const plugins = pluginsKnownTo(ctx.pluginRuntime.host.list(), ctx.pluginRuntime.pages.list(), p)
      .map((m) => ({ id: m.id, name: m.name, version: m.version, apiVersion: m.apiVersion, capabilities: m.capabilities, ...(m.unlisted ? { unlisted: true } : {}) }));
    sendJson(res, 200, { plugins });
  }),

  // Data backing a plugin widget's `{ source: { kind: "plugin", key } }` blocks. Requires login;
  // the plugin's registered provider runs server-side and returns JSON.
  route("GET", "/api/plugins/:id/data", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    const key = new URL(req.url ?? "", "http://x").searchParams.get("key") ?? "";
    if (!key) return sendError(res, 400, "key query parameter is required");
    try {
      const result = await ctx.pluginRuntime.getPluginData(params.id!, key);
      if (!result.found) return sendError(res, 404, `no data provider for plugin '${params.id}' key '${key}'`);
      sendJson(res, 200, { data: result.data ?? null });
    } catch (err) {
      throw errors.upstream(`plugin data provider failed: ${(err as Error).message}`, { plugin: params.id, key });
    }
  }),

  /*
   * The pages plugins add to the panel that THIS viewer may open — and only those, so a
   * need-to-know page is not even named to anyone else. Each says what opens it, so the panel can
   * ask the same question of a role being previewed.
   */
  route("GET", "/api/plugin-pages", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const pages = ctx.pluginRuntime.pages.list().filter((pg) => mayOpenPage(pg, p)).map((pg) => {
      const perm = pg.permission === undefined ? undefined : pluginPermission(`${pg.pluginId}.${pg.permission}`);
      return {
        plugin: pg.pluginId, id: pg.id, title: pg.title, section: pg.section, blurb: pg.blurb ?? "",
        permission: perm?.key ?? null, outright: perm?.outright ?? false, ownerOnly: pg.ownerOnly === true,
      };
    });
    sendJson(res, 200, { pages });
  }),

  // A page's code, for a viewer who may open it. Anyone else is told what an address that does not
  // exist is told: the code of a need-to-know page is never even confirmed to be there.
  route("GET", "/api/plugin-pages/:plugin/:page", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const page = ctx.pluginRuntime.pages.get(params.plugin!, params.page!);
    if (!page || !mayOpenPage(page, p)) return sendError(res, 404, "not found");
    const [script, style] = await Promise.all([page.script(), page.style?.() ?? ""]);
    sendJson(res, 200, { script, style });
  }),

  // Everything else under a plugin's prefix is the plugin's own. Last, so the routes above are met
  // first. A stream route signs in by header or by `?token=`; every other one by header.
  route("GET", "/api/plugins/:id/*rest", async (req, res, ctx, params) => {
    const stream = matchRoute(req, ctx, params.id!)?.route.stream === true;
    const p = stream
      ? (await authenticate(req, ctx.repo, ctx.config)) ?? (await tokenPrincipal(req, ctx))
      : await requirePrincipal(req, res, ctx);
    if (!p) {
      if (stream) sendError(res, 401, "unauthorized"); // requirePrincipal answers for itself
      return;
    }
    await dispatch(req, res, ctx, params.id!, p);
  }),
  route("POST", "/api/plugins/:id/*rest", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    await dispatch(req, res, ctx, params.id!, p);
  }),
  route("PUT", "/api/plugins/:id/*rest", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    await dispatch(req, res, ctx, params.id!, p);
  }),
  route("DELETE", "/api/plugins/:id/*rest", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    await dispatch(req, res, ctx, params.id!, p);
  }),
];
