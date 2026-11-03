/**
 * Plugin routes and pages: the tables the plugin runtime fills, and the request and response a
 * plugin's handler is given in place of Node's own.
 *
 * Everything under `/api/plugins/<id>/…` that is not the host's own widget-data endpoint lands
 * here (routes/plugins.ts). The host has signed the caller in before a handler runs; what the
 * caller may do there is the plugin's own business, asked through `viewer.holds` against the
 * permissions the plugin declared.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpMethod, PluginManifest, PluginPageDef, PluginRequest, PluginResponse, PluginRouteHandler, PluginStream, PluginViewer, StreamOptions } from "@app/plugin-sdk";
import { canAnywhere, holdsOutright } from "@app/access";
import type { Principal } from "./auth.js";
import { readJsonBody, sendError, sendJson } from "./http.js";
import { pluginPermission } from "./plugin-permissions.js";

interface PluginRoute {
  method: HttpMethod;
  pattern: RegExp;
  keys: string[];
  handler: PluginRouteHandler;
  stream: boolean;
}

export class PluginRouteTable {
  private byPlugin = new Map<string, PluginRoute[]>();

  register(pluginId: string, method: HttpMethod, path: string, handler: PluginRouteHandler, opts: { stream: boolean }): void {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
    const list = this.byPlugin.get(pluginId) ?? [];
    if (list.some((r) => r.method === method && r.pattern.source === pattern.source)) throw new Error(`plugin ${pluginId}: ${method} ${path} is registered twice`);
    list.push({ method, pattern, keys, handler, stream: opts.stream });
    this.byPlugin.set(pluginId, list);
  }

  unregister(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }

  /** The route `rest` (the path after `/api/plugins/<id>`) lands on, first declared first. */
  match(pluginId: string, method: string, rest: string): { route: PluginRoute; params: Record<string, string> } | null {
    for (const route of this.byPlugin.get(pluginId) ?? []) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(rest);
      if (!m) continue;
      const params: Record<string, string> = {};
      try {
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      } catch {
        return null; // a malformed escape names no route
      }
      return { route, params };
    }
    return null;
  }
}

export interface RegisteredPage extends PluginPageDef {
  pluginId: string;
}

export class PluginPageTable {
  private pages = new Map<string, RegisteredPage>();

  register(pluginId: string, def: PluginPageDef): void {
    const other = this.pages.get(def.id);
    if (other) throw new Error(`plugin ${pluginId}: the page ${def.id} is already ${other.pluginId === pluginId ? "registered" : `plugin ${other.pluginId}'s`}`);
    this.pages.set(def.id, { ...def, pluginId });
  }

  unregister(pluginId: string): void {
    for (const [id, p] of this.pages) if (p.pluginId === pluginId) this.pages.delete(id);
  }

  list(): RegisteredPage[] {
    return [...this.pages.values()];
  }

  get(pluginId: string, pageId: string): RegisteredPage | undefined {
    const p = this.pages.get(pageId);
    return p?.pluginId === pluginId ? p : undefined;
  }
}

/** The viewer a plugin is handed: who this is, and the one question it may ask of their grants. */
export function viewerFor(pluginId: string, p: Principal): PluginViewer {
  return {
    userId: p.user.id,
    name: p.name,
    owner: holdsOutright(p.grants, "*", "write"),
    holds: (key, level = "read") => {
      // Looked up under the asking plugin's own id, so another plugin's permission is out of reach.
      const def = pluginPermission(`${pluginId}.${key}`);
      if (!def) return false;
      return def.outright ? holdsOutright(p.grants, def.key, level) : canAnywhere(p.grants, def.key, level);
    },
  };
}

/** May this principal open the page — and so see it listed, and fetch its code? */
export function mayOpenPage(page: RegisteredPage, p: Principal): boolean {
  if (page.ownerOnly && !holdsOutright(p.grants, "*", "write")) return false;
  return page.permission === undefined || viewerFor(page.pluginId, p).holds(page.permission);
}

/**
 * The loaded plugins this principal is told of: every listed one, and an unlisted one only to
 * someone who may open one of its pages — it is in their menu already, so naming it tells them
 * nothing new. The plugin list and the System page's count both ask this, so the two agree.
 */
export function pluginsKnownTo(loaded: PluginManifest[], pages: RegisteredPage[], p: Principal): PluginManifest[] {
  return loaded.filter((m) => !m.unlisted || pages.some((pg) => pg.pluginId === m.id && mayOpenPage(pg, p)));
}

/** Whether the viewer came over HTTPS: directly, or through a tunnel or proxy that says so. */
export function overHttps(req: IncomingMessage): boolean {
  return String(req.headers["x-forwarded-proto"] ?? "").toLowerCase().includes("https")
    || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

const COOKIE_NAME = /^[a-z0-9_]{1,32}$/;
/** What a cookie value may hold without quoting: base64url, hex, dotted tokens. */
const COOKIE_VALUE = /^[A-Za-z0-9._~-]{0,4096}$/;
const wireCookie = (pluginId: string, name: string) => `pl_${pluginId.replace(/-/g, "_")}_${name}`;

/** How often an open stream re-checks its viewer. A setter, so the suites need not wait 25s. */
let heartbeatMs = 25_000;
export function setPluginStreamHeartbeat(ms: number): void {
  heartbeatMs = ms;
}
/** A viewer this far behind is ended: the browser reconnects and starts from a fresh frame. */
const MAX_BUFFERED_BYTES = 1_000_000;

export function pluginRequest(req: IncomingMessage, pluginId: string, params: Record<string, string>, viewer: PluginViewer): PluginRequest {
  const query = new URL(req.url ?? "", "http://x").searchParams;
  return {
    params,
    query,
    viewer,
    https: overHttps(req),
    body: async () => (await readJsonBody(req)) as Record<string, unknown>,
    cookie: (name) => {
      const want = wireCookie(pluginId, name);
      for (const part of (req.headers.cookie ?? "").split(";")) {
        const [k, ...rest] = part.trim().split("=");
        if (k === want) return rest.join("=");
      }
      return "";
    },
  };
}

/**
 * The response a handler writes to. `reauth` signs the caller in again and builds their viewer
 * afresh — what a stream's heartbeat asks.
 */
export function pluginResponse(
  req: IncomingMessage,
  res: ServerResponse,
  pluginId: string,
  opts: { stream: boolean; reauth: () => Promise<PluginViewer | null> },
): PluginResponse {
  const cookies: string[] = [];
  return {
    json: (status, body) => sendJson(res, status, body),
    error: (status, message) => sendError(res, status, message),
    notFound: () => sendError(res, 404, "not found"),
    header: (name, value) => {
      if (name.toLowerCase() === "set-cookie") throw new Error("a cookie is set with res.cookie");
      res.setHeader(name, value);
    },
    cookie: (name, value, maxAgeSecs) => {
      if (!COOKIE_NAME.test(name)) throw new Error(`bad cookie name: ${name}`);
      if (!COOKIE_VALUE.test(value)) throw new Error("a cookie value is letters, digits and . _ ~ - only");
      const age = Math.max(0, Math.floor(maxAgeSecs));
      cookies.push(`${wireCookie(pluginId, name)}=${value}; HttpOnly; Path=/api/plugins/${pluginId}; SameSite=Strict; Max-Age=${age}${overHttps(req) ? "; Secure" : ""}`);
      res.setHeader("set-cookie", cookies);
    },
    stream: (streamOpts) => {
      if (!opts.stream) throw new Error("only a route registered with stream: true can stream");
      return openStream(req, res, streamOpts ?? {}, opts.reauth);
    },
  };
}

function openStream(req: IncomingMessage, res: ServerResponse, opts: StreamOptions, reauth: () => Promise<PluginViewer | null>): PluginStream {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(": connected\n\n");
  let closed = false;
  const listeners: (() => void)[] = [];
  const end = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
    for (const cb of listeners.splice(0)) {
      try { cb(); } catch { /* the rest still run */ }
    }
  };
  // The heartbeat signs the viewer in again and asks the plugin whether they still qualify: a
  // permission revoked, a session ended, the plugin's own switch flipped — each ends the stream
  // within a beat, not when the tab next reloads. Any failure ends it too (fail closed); the
  // browser reconnects in seconds and is admitted afresh.
  const heartbeat = setInterval(() => void (async () => {
    if (closed) return;
    if (res.destroyed || res.writableEnded) return end();
    const viewer = await reauth();
    if (!viewer || (opts.recheck && !(await opts.recheck(viewer)))) return end();
    if (!closed && !res.writableEnded) res.write(": ping\n\n");
  })().catch(() => end()), heartbeatMs);
  req.on("close", end);
  // The caller may have left while the handler was still deciding to stream.
  if (req.destroyed || res.destroyed) end();
  return {
    send: (data) => {
      if (closed || res.writableEnded || res.destroyed) return false;
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        end();
        return false;
      }
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    get closed() {
      return closed;
    },
    onClose: (cb) => {
      if (closed) cb();
      else listeners.push(cb);
    },
    end,
  };
}
