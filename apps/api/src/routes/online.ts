/**
 * Administration → Online access: how people reach this install from the internet — a Cloudflare
 * tunnel the API runs itself (tunnel.ts), or the install's own domain behind the HTTPS proxy a VM
 * install runs (infra/Caddyfile) — the public stats site's own address and the name it goes by,
 * and whether the public demo is shown. All of it set in the panel and kept with the install's
 * settings, none of it in infra/.env.
 */
import { canAnywhere } from "@app/access";
import { installEnvSetting } from "@app/db";
import type { AppContext } from "../context.js";
import { refreshInstallEnv } from "../install-env.js";
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { deployRoute } from "../setup.js";
import { parseTunnelToken } from "../tunnel.js";
import { panelBaseUrl } from "../panel-links.js";
import { normalizeHost } from "../public-host.js";
import { requirePrincipal, route, sendForbidden, type Route } from "./kit.js";

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NAME_MAX = 60;
/** The panel's own domain, served with HTTPS by the proxy (infra/Caddyfile). */
const DOMAIN_KEY = "online.domain";
/** The public demo: "on" shows it to anyone, anything else hides it. */
const DEMO_KEY = "online.demo";
/** Where the HTTPS proxy answers inside the stack — asked only to say whether it runs. */
const proxyUrl = () => process.env.DOMAIN_PROXY_URL || "http://caddy:80/";

/** Is the HTTPS proxy running? Any answer at all says yes; it redirects every plain request. */
async function proxyRunning(): Promise<boolean> {
  try {
    await fetch(proxyUrl(), { redirect: "manual", signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the public demo shown? The demo (/demo) is a copy of the panel running on made-up data in the
 * visitor's own browser, its walkthroughs a press away. Off until someone turns it on; its page
 * answers 404 while it is off (app.ts).
 */
export async function demoOn(ctx: AppContext): Promise<boolean> {
  return (await ctx.repo.installSettings.get(DEMO_KEY)) === "on";
}

/** Everything the Online access tab shows. */
async function onlineView(ctx: AppContext) {
  const domain = normalizeHost(await ctx.repo.installSettings.get(DOMAIN_KEY));
  return {
    route: deployRoute(),
    tunnel: { set: Boolean(process.env.CLOUDFLARE_TUNNEL_TOKEN), ...ctx.tunnel.status() },
    domain: { host: domain, proxy: await proxyRunning() },
    statsSite: statsSite(ctx),
    demo: { on: await demoOn(ctx) },
  };
}

/** What the panel shows: the values as set (blank = not set), and the address links start with. */
function statsSite(ctx: AppContext) {
  return {
    host: ctx.config.publicStatsHost ?? null,
    origin: (process.env.PUBLIC_STATS_ORIGIN ?? "").trim() || null,
    name: ctx.config.publicStatsName ?? null,
    shareable: ctx.config.publicStatsOrigin ?? null,
  };
}

export const onlineRoutes: Route[] = [
  route("GET", "/api/online", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.online", "read")) return sendForbidden(res, "admin.online", "read");
    sendJson(res, 200, await onlineView(ctx));
  }),

  /**
   * The Cloudflare tunnel's token: pasted from the dashboard (the whole install command will do),
   * kept encrypted, and run straight away; an empty one stops the tunnel. Never filed for
   * approval, since the request would carry the token.
   */
  route("PUT", "/api/online/tunnel", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.online", "write")) return sendForbidden(res, "admin.online", "write");
    const given = str((await readJsonBody(req)).token).trim();
    const parsed = given ? parseTunnelToken(given) : null;
    if (given && !parsed) return sendError(res, 400, "that is not a tunnel token — copy the long string from the tunnel's install command in the Cloudflare dashboard");
    await ctx.repo.installSettings.set(installEnvSetting("CLOUDFLARE_TUNNEL_TOKEN")!.key, parsed?.token ?? "", { secret: true, by: p.name });
    await refreshInstallEnv(ctx.repo, ctx.config);
    ctx.tunnel.set(parsed?.token ?? null);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "online.tunnel",
      targetType: "system", targetId: "tunnel",
      summary: parsed ? `put the panel online through Cloudflare tunnel ${parsed.tunnelId}` : "took the panel off its Cloudflare tunnel",
      data: { tunnelId: parsed?.tunnelId ?? null },
    }).catch(() => {});
    sendJson(res, 200, await onlineView(ctx));
  }),

  /**
   * The panel's own domain, for the HTTPS proxy a VM install runs: the proxy fetches a certificate
   * for it the first time it is visited (the ask below). An empty one removes it.
   */
  route("PUT", "/api/online/domain", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.online", "write")) return sendForbidden(res, "admin.online", "write");
    const host = normalizeHost(str((await readJsonBody(req)).host)) ?? "";
    if (host && !HOSTNAME.test(host)) return sendError(res, 400, "the panel's domain is a hostname, like panel.example.com");
    if (host && host === normalizeHost(ctx.config.publicStatsHost)) return sendError(res, 400, "that is the stats site's address — the panel needs one of its own");
    const before = normalizeHost(await ctx.repo.installSettings.get(DOMAIN_KEY));
    await ctx.repo.installSettings.set(DOMAIN_KEY, host, { by: p.name });
    if (before !== (host || null)) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "online.domain",
        targetType: "system", targetId: "domain",
        summary: host ? `set the panel's own domain to ${host}` : "removed the panel's own domain",
        data: { before, after: host || null },
      }).catch(() => {});
    }
    sendJson(res, 200, await onlineView(ctx));
  }),

  /**
   * The HTTPS proxy asks before it fetches a certificate for an address it was visited on: yes for
   * the panel's own domain and the stats site's address, no for anything else, so a stranger's
   * hostname pointed at this server gets nothing.
   */
  route("GET", "/api/online/tls-ask", async (req, res, ctx) => {
    const asked = normalizeHost(new URL(req.url ?? "", "http://x").searchParams.get("domain"));
    const own = [normalizeHost(await ctx.repo.installSettings.get(DOMAIN_KEY)), normalizeHost(ctx.config.publicStatsHost)].filter(Boolean);
    if (asked && own.includes(asked)) return sendJson(res, 200, { ok: true });
    sendError(res, 404, "not an address of this panel");
  }),

  /**
   * The stats site's own address, the address its links start with, and the community name it
   * wears. An empty field clears. In force at once: the next request on that address is the stats
   * site, and every link the panel hands out starts with it.
   */
  route("PUT", "/api/online/stats-site", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.online", "write")) return sendForbidden(res, "admin.online", "write");
    const body = await readJsonBody(req);
    const host = normalizeHost(str(body.host)) ?? "";
    if (host && !HOSTNAME.test(host)) return sendError(res, 400, "the stats site's address is a hostname, like stats.example.com");
    // On the stats site's address the panel does not exist (public-host.ts), so the address the
    // panel is reached on must never become it — that would lock everyone out of the panel there.
    // That includes the panel's own domain, set on this same screen: the save may arrive on another
    // address entirely (the PC's localhost:8080), so the request's own host does not cover it.
    const panelHosts = [
      normalizeHost(req.headers.host), normalizeHost(panelBaseUrl()), normalizeHost(await ctx.repo.installSettings.get(DOMAIN_KEY)),
    ].filter(Boolean);
    if (host && panelHosts.includes(host)) return sendError(res, 400, "that is the panel's own address — the stats site needs an address of its own, or none");
    let origin = str(body.origin).trim();
    if (origin) {
      let u: URL;
      try { u = new URL(origin); } catch { return sendError(res, 400, "the shareable address is a web address, like https://stats.example.com"); }
      if (u.protocol !== "https:" && u.protocol !== "http:") return sendError(res, 400, "the shareable address starts with https://");
      origin = u.origin;
    }
    const name = str(body.name).trim();
    if (name.length > NAME_MAX) return sendError(res, 400, `the community name is at most ${NAME_MAX} characters`);

    const before = statsSite(ctx);
    const next: Record<string, string> = { PUBLIC_STATS_HOST: host, PUBLIC_STATS_ORIGIN: origin, PUBLIC_STATS_NAME: name };
    for (const [env, value] of Object.entries(next)) {
      await ctx.repo.installSettings.set(installEnvSetting(env)!.key, value, { by: p.name });
    }
    await refreshInstallEnv(ctx.repo, ctx.config);
    const after = statsSite(ctx);
    const said: string[] = [];
    if (before.host !== after.host) said.push(after.host ? `its own address is now ${after.host}` : "it no longer has an address of its own (it is at /stats on the panel's)");
    if (before.origin !== after.origin) said.push(after.origin ? `its links start ${after.origin}` : "its links start with its own address again");
    if (before.name !== after.name) said.push(after.name ? `it is called “${after.name}”` : "it no longer has a community name");
    if (said.length) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "stats.site",
        targetType: "system", targetId: "stats-site",
        summary: `changed the public stats site: ${said.join("; ")}`,
        data: { before, after },
      }).catch(() => {});
    }
    sendJson(res, 200, await onlineView(ctx));
  }),

  /** The public demo, on or off. In force at once: the next visit finds it so. */
  route("PUT", "/api/online/demo", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.online", "write")) return sendForbidden(res, "admin.online", "write");
    const on = (await readJsonBody(req)).on;
    if (typeof on !== "boolean") return sendError(res, 400, "say whether the demo is on: true or false");
    const before = await demoOn(ctx);
    await ctx.repo.installSettings.set(DEMO_KEY, on ? "on" : "", { by: p.name });
    if (before !== on) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "online.demo",
        targetType: "system", targetId: "demo",
        summary: on ? "turned the public demo on" : "turned the public demo off",
        data: { on },
      }).catch(() => {});
    }
    sendJson(res, 200, await onlineView(ctx));
  }),
];
