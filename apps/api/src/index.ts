/**
 * @app/api entrypoint — the API-first backbone. Every capability lives here; the web
 * panel, app, and bot are all clients of it.
 *
 * The HTTP server starts listening BEFORE the database is ready and serves a self-refreshing
 * "starting" page until boot completes. A slow or stuck boot (migrations, a held lock, a
 * recovering Postgres) is then visible in the browser instead of an endless blank "Loading…"
 * tab, and /api/* callers get a clean 503 with the current boot phase.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRepository } from "@app/db";
import { createLogger, installCrashHandlers, APP_NAME } from "@app/shared";
import { loadApiConfig } from "./config.js";
import { createHandler, createAppContext } from "./app.js";
import { wireModerationPanel } from "./discord-moderation-wiring.js";
import { discoverServersFromEnv } from "./discovery.js";
import { resolveSessionSecret } from "./session-secret.js";
import { settleSetupCode } from "./setup.js";
import { settleInstallEnv } from "./install-env.js";

const log = createLogger("api");

function sendStarting(req: IncomingMessage, res: ServerResponse, phase: string): void {
  if (req.url?.startsWith("/api/")) {
    res.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "3", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "starting", phase }));
    return;
  }
  res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "3", "cache-control": "no-store" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${APP_NAME} — starting</title></head>` +
      `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font-family:system-ui,sans-serif">` +
      `<div style="text-align:center;padding:2rem"><h1 style="font-weight:600;margin:0 0 .5rem">${APP_NAME} is starting</h1>` +
      `<p style="color:#9aa3ad;margin:0">${phase}… this page refreshes itself.</p></div></body></html>`,
  );
}

async function main(): Promise<void> {
  const config = loadApiConfig();

  let phase = "connecting to the database";
  let shuttingDown = false;
  let ready: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;
  const server = createServer((req, res) => {
    if (ready) void ready(req, res);
    else sendStarting(req, res, phase);
  });
  // The install sits behind a Cloudflare tunnel, and cloudflared pools its origin connections for
  // up to 90s idle. Node's default idle keep-alive is 5s: Node closes a socket the proxy still
  // believes is open, the proxy sends the next request down it, and the user gets a bare 502 that
  // no log on our side ever records. Holding idle sockets LONGER than the proxy does makes the
  // proxy always be the side that closes. headersTimeout must exceed keepAliveTimeout, or Node
  // cuts the same sockets on the headers clock instead.
  server.keepAliveTimeout = 95_000;
  server.headersTimeout = 96_000;
  server.listen(config.port, () => {
    log.info("http up, booting", { port: config.port });
  });

  // A fault anywhere in a route handler, a plugin, or a background promise ends the process. That
  // is the right outcome — but it has to be legible, so stop accepting new connections and say why
  // in the same log stream as everything else, rather than letting Node print a bare stack.
  // The tunnel's cloudflared goes with the API: it is started below, once the context exists.
  let stopTunnel: () => Promise<void> = async () => {};
  installCrashHandlers(log, {
    beforeExit: () => Promise.all([stopTunnel(), new Promise<void>((resolve) => server.close(() => resolve()))]).then(() => {}),
  });

  // SIGTERM is how every container runtime asks us to stop. Without this the process is killed
  // outright and in-flight requests are cut mid-response; closing the server first lets them land.
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    void stopTunnel();
    server.close(() => process.exit(0));
    // A keep-alive connection can hold the server open indefinitely; don't wait forever for it.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  phase = "preparing the database (running migrations)";
  const repo = await createRepository();
  log.info("storage selected", { storage: process.env.DATABASE_URL ? "postgres" : "in-memory", persisted: Boolean(process.env.DATABASE_URL) });
  // Before anything can sign a login: SESSION_SECRET's own value, or the install's stored key.
  const signing = await resolveSessionSecret(repo, config);
  log.info("login signing key", { from: signing === "env" ? "SESSION_SECRET" : "the install's own (kept in the database)" });
  // A brand-new install holds a one-time code its owner account takes (setup.ts). The start
  // scripts read it from the file and open the setup page with it filled in; this line is the
  // copy for anyone who started the stack some other way.
  const setupCode = await settleSetupCode(repo);
  if (setupCode) log.info(`Setup code: ${setupCode} — open the panel and enter it to create the owner account`, { setupCode });
  // The Discord app and the public stats site are set in the panel (install-env.ts). An install
  // that set them in infra/.env carries them over once; the panel's values are in force from then on.
  const carried = await settleInstallEnv(repo, config);
  if (carried.length) log.info("settings carried over from infra/.env — they are changed in the panel from now on", { settings: carried });

  // Auto-discover servers defined in the environment (SERVER_<n>_*). No-op if none are set.
  phase = "discovering game servers";
  await discoverServersFromEnv(repo).catch((err) => log.error("server discovery failed", { err }));

  phase = "loading configuration and plugins";
  const ctx = await createAppContext(repo, config);
  // From the root, not from context.ts: the wiring imports the approvals spine, which must stay
  // out of the context → plugin-host → discord-* import knot (import-cycles.test.ts).
  wireModerationPanel(ctx);
  // The Cloudflare tunnel, from the token saved in the panel (or carried over from infra/.env).
  ctx.tunnel.set(process.env.CLOUDFLARE_TUNNEL_TOKEN || null);
  stopTunnel = () => ctx.tunnel.stop();
  ready = createHandler(ctx);
  log.info("api listening", { port: config.port, webPanel: Boolean(config.webRoot) });
}

main().catch((err) => {
  log.error("failed to start", { err });
  process.exit(1);
});
