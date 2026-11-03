/**
 * The Cloudflare tunnel, run by the API itself from the token saved in the panel (Administration →
 * Online access) — no separate container, nothing typed into infra/.env.
 *
 * cloudflared is shipped in the image and run as a child process: the token goes in its
 * environment (TUNNEL_TOKEN), never on its command line where `ps` would show it, and its metrics
 * listener on this machine's loopback answers whether it holds connections to Cloudflare (`/ready`).
 * If it exits it is started again, waiting longer each time up to a minute, for as long as a token
 * is set. Saving another token restarts it with that one; removing the token stops it.
 *
 * The tunnel's public hostnames point at this API (http://localhost:8080 — the connector runs in
 * the API's own container; an older setup's http://api:8080 reaches the same place).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Logger } from "@app/shared";

export type TunnelState = "off" | "connecting" | "connected" | "missing" | "failing";

export interface TunnelStatus {
  state: TunnelState;
  /** Connections to Cloudflare's edge while connected (cloudflared keeps four). */
  connections: number;
  /** The tunnel the token belongs to, so the panel can name it. */
  tunnelId: string | null;
  /** cloudflared's last complaint, while it is not connected. */
  detail: string | null;
}

export interface Tunnel {
  /** Run with this token, or stop (null). The same token again changes nothing. */
  set(token: string | null): void;
  status(): TunnelStatus;
  stop(): Promise<void>;
}

/**
 * What a pasted token becomes. The dashboard shows it inside a whole command
 * (`cloudflared service install eyJ…`, `cloudflared tunnel run --token eyJ…`), so the token is the
 * last word that decodes to one: base64 of {"a": account, "t": tunnel id, "s": secret}.
 */
export function parseTunnelToken(given: string): { token: string; tunnelId: string } | null {
  for (const word of given.trim().split(/\s+/).reverse()) {
    try {
      const v = JSON.parse(Buffer.from(word, "base64").toString("utf8")) as { a?: unknown; t?: unknown; s?: unknown };
      if (typeof v.a === "string" && typeof v.t === "string" && typeof v.s === "string" && v.a && v.t && v.s) return { token: word, tunnelId: v.t };
    } catch { /* not this word */ }
  }
  return null;
}

const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 60_000;
const READY_POLL_MS = 5_000;

export function createTunnel(opts: {
  log: Logger;
  bin?: string;
  metricsPort?: number;
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  restartMinMs?: number;
  readyPollMs?: number;
}): Tunnel {
  const { log } = opts;
  const bin = opts.bin ?? process.env.CLOUDFLARED_BIN ?? "cloudflared";
  const port = opts.metricsPort ?? 20241;
  const spawn = opts.spawnImpl ?? nodeSpawn;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const restartMin = opts.restartMinMs ?? RESTART_MIN_MS;
  const pollMs = opts.readyPollMs ?? READY_POLL_MS;

  let token: string | null = null;
  let child: ChildProcess | null = null;
  let state: TunnelState = "off";
  let connections = 0;
  let detail: string | null = null;
  let backoff = restartMin;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const tunnelId = () => (token ? parseTunnelToken(token)?.tunnelId ?? null : null);

  async function poll(): Promise<void> {
    if (!child) return;
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(3_000) });
      const body = (await r.json().catch(() => ({}))) as { readyConnections?: number };
      connections = r.ok ? Number(body.readyConnections ?? 0) : 0;
      if (r.ok && connections > 0) {
        if (state !== "connected") log.info("Cloudflare tunnel connected", { connections, tunnelId: tunnelId() });
        state = "connected";
        detail = null;
        backoff = restartMin;
      } else if (state === "connected") {
        state = "connecting";
      }
    } catch {
      connections = 0;
      if (state === "connected") state = "connecting";
    }
  }

  function start(): void {
    if (!token || child) return;
    state = "connecting";
    connections = 0;
    const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${port}`, "run"], {
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = proc;
    let tail = "";
    let partial = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-4_000);
      // cloudflared writes every line to stderr. Its last error is what the panel shows — the one
      // that says what went wrong, not the indented "try the following" lines it prints after it.
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const m = /\bERR (\S.*?)(?:\s+event=\d+)?\s*$/.exec(line);
        if (m && !m[1]!.startsWith("Please try the following")) detail = m[1]!.slice(0, 300);
      }
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (child !== proc) return;
      child = null;
      if (err.code === "ENOENT") {
        state = "missing";
        detail = "cloudflared is not installed where the panel runs";
        log.warn("Cloudflare tunnel cannot start: cloudflared is not installed", { bin });
        return;
      }
      state = "failing";
      detail = err.message;
      schedule();
    });
    proc.on("exit", (code) => {
      if (child !== proc) return;
      child = null;
      connections = 0;
      if (!token) { state = "off"; return; }
      state = "failing";
      log.warn("Cloudflare tunnel stopped — starting it again", { code, detail, retryInMs: backoff, tail: tail.slice(-300) });
      schedule();
    });
    if (!pollTimer) pollTimer = setInterval(() => void poll(), pollMs);
  }

  function schedule(): void {
    if (restartTimer || !token) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, RESTART_MAX_MS);
    restartTimer = setTimeout(() => { restartTimer = null; start(); }, wait);
  }

  function halt(): Promise<void> {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const proc = child;
    child = null;
    connections = 0;
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(kill); resolve(); };
      const kill = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5_000);
      proc.once("exit", done);
      proc.kill("SIGTERM");
    });
  }

  return {
    set(next) {
      const wanted = next?.trim() || null;
      // The same token again: already running, waiting to restart, or known not to start.
      if (wanted === token) return;
      token = wanted;
      backoff = restartMin;
      detail = null;
      state = wanted ? "connecting" : "off";
      void halt().then(() => { if (wanted && token === wanted) start(); });
    },
    status: () => ({ state, connections, tunnelId: tunnelId(), detail }),
    stop: async () => { token = null; await halt(); state = "off"; },
  };
}
