/**
 * The app context — everything a route handler is given besides the request itself.
 *
 * It lives in its own module rather than in app.ts because app.ts is now the assembler that
 * imports the route modules, and every one of those modules needs this type. Leaving it in app.ts
 * would make each route file import from the file that imports it.
 */
import type { Repository } from "@app/db";
import { ROLE_PRESETS } from "@app/access";
import type { ApiConfig } from "./config.js";
import type { PluginModule } from "@app/plugin-sdk";
import type { WidgetRegistry } from "@app/widgets";
import { buildPluginRuntime, type EventBus, type PluginRuntime } from "./plugin-host.js";
import { Enforcer } from "./enforcer.js";
import { PlayerTriggerRunner } from "./player-trigger-runner.js";
import { PhoneAlerts } from "./phone-alerts.js";
import { LoginThrottle } from "./rate-limit.js";
import { createTunnel, type Tunnel } from "./tunnel.js";
import { createUpdateCheck, type UpdateCheck } from "./updates.js";
import { createLogger } from "@app/shared";
// Value import, and safe: kit imports only the TYPE of AppContext back, which erases at compile time.
import { setHealthRepo } from "./routes/kit.js";

export interface AppContext {
  repo: Repository;
  config: ApiConfig;
  widgetRegistry: WidgetRegistry;
  bus: EventBus;
  pluginRuntime: PluginRuntime;
  enforcer: Enforcer;
  /** The per-player trigger runner. On the context for the same reason the enforcer is: the
   *  routes that mutate triggers refresh its armed set right away, so a trigger armed a moment
   *  before the player connects fires, and a just-deleted one cannot fire out of the stale set
   *  while the 10s timer catches up. */
  playerTriggerRunner: PlayerTriggerRunner;
  /** Phone notifications (phone-alerts.ts): on the bus for joins and outages, and told of every
   *  filed request by the approval card's post. */
  phoneAlerts: PhoneAlerts;
  /** Per-server "Apply to panel" runs. The transform used to be one long HTTP request, but a
   *  multi-million-row archive outlives any proxy/browser timeout (Cloudflare killed it every
   *  time in production) — so POST now starts it here and the panel polls the status route.
   *  In-memory on purpose: an API restart simply forgets a half-run, and re-running is safe. */
  crconTransforms: Map<string, CrconTransformRun>;
  /** The community-wide registration-role reconcile. Discord's per-guild role bucket paces this to
   *  a few writes per window, so a few hundred members is minutes of waiting — far past what a
   *  browser holds a request open for (the first version returned "Load failed" while the run
   *  carried on invisibly). Same shape as the Apply: POST starts it, the panel polls. */
  roleSync: { current: RoleSyncRun | null };
  /** Failed-login counters for POST /api/auth/login. On the context rather than module state so
   *  every test server starts with a clean slate. */
  loginThrottle: LoginThrottle;
  /** The one database export/import run at a time (whole-database work — two at once would fight
   *  over the same tables and the same archive file). Same in-memory job pattern as the CRCON
   *  transform: POST starts it, the panel polls, a restart forgets a half-run harmlessly.
   *  `uploading` covers the gap a run cannot: while an archive is still streaming onto disk,
   *  an import must not start reading it and a second upload must not interleave with it. */
  dataPortRun: { current: DataPortRun | null; uploading: boolean };
  /** Duplicate keys of payouts running RIGHT NOW in this process — the in-memory half of the
   *  double-run gate (the jobs table is the durable half). See docs/bulk-payout.md. */
  runningPayoutKeys: Set<string>;
  /** The Cloudflare tunnel this API runs from the token saved in the panel (tunnel.ts). Idle until
   *  given one: boot hands it the saved token, and the Online access routes the new one. */
  tunnel: Tunnel;
  /** Whether GitHub has newer code than this build (updates.ts), for the account made at setup. */
  updates: UpdateCheck;
}

export interface DataPortRun {
  kind: "export" | "import" | "backup" | "restore";
  status: "running" | "done" | "error";
  startedAt: string;
  updatedAt: string;
  /** rows written (export) or processed (import) so far. */
  rows: number;
  /** which groups an export was asked for — shown while it runs and kept for the record. */
  groups?: string[];
  /** export result: the archive on the host. */
  file?: string;
  fileBytes?: number;
  /** import result: the per-table report. */
  report?: import("@app/db").DataPortReport;
  error?: string;
}

export interface RoleSyncRun {
  status: "running" | "done" | "error";
  startedAt: string;
  updatedAt: string;
  done: number;
  total: number;
  result?: { members: number; applied: number; removed: number; absent: number; refused: number };
  error?: string;
}

export interface CrconTransformRun {
  status: "running" | "done" | "error";
  startedAt: string;
  updatedAt: string;
  /** archive records processed so far (ticks every few thousand). */
  processed: number;
  /** "scan" while the pre-scan reads the archive for names (counts LINES), "apply" during the real pass. */
  phase?: "scan" | "apply";
  /** True when this run parsed into a throwaway store: the full report with zero writes. */
  dry?: boolean;
  summary?: import("./crcon-transform.js").TransformSummary;
  error?: string;
}

/** Seed the factory presets as REAL, editable roles — once. After that the live roles are the
 *  only source of truth: rename/tune/delete them freely, they never come back on their own. */
async function seedDefaultRoles(repo: Repository): Promise<void> {
  if (await repo.pluginKv.get("core", "rolesSeeded")) return;
  if (!(await repo.roles.list()).length) {
    for (const p of ROLE_PRESETS) {
      await repo.roles.create({
        name: p.label, description: p.description,
        grants: p.grants.map((g) => ({ capability: g.capability, level: g.level })),
        limits: { ...(p.limits ?? {}) }, createdByName: null,
      });
    }
  }
  await repo.pluginKv.set("core", "rolesSeeded", true);
}

/** Assemble the full app context: plugin runtime (host + widget registry + bus) + the
 *  auto-moderation enforcer (subscribes to the bus). */
export async function createAppContext(repo: Repository, config: ApiConfig, plugins?: PluginModule[]): Promise<AppContext> {
  await seedDefaultRoles(repo);
  // Every RCON dial the API makes reports whether the server answered, through this handle.
  setHealthRepo(repo);
  const runtime = await buildPluginRuntime(repo, plugins);
  const enforcer = new Enforcer({ repo, bus: runtime.bus });
  await enforcer.start();
  // Per-player triggers ride the same bus, separate from the server-wide enforcer.
  const playerTriggerRunner = new PlayerTriggerRunner({ repo, bus: runtime.bus });
  await playerTriggerRunner.start();
  const phoneAlerts = new PhoneAlerts({ repo, bus: runtime.bus });
  phoneAlerts.start();
  // A RUNNING payout after a restart is a driver that no longer exists: mark it INTERRUPTED so
  // the history says what happened, and its receipts + retry say what to do about it.
  await repo.payouts.interruptStale().then((n) => {
    if (n > 0) console.warn(`[payouts] ${n} payout job(s) were interrupted by the restart — their receipts say who was reached; retry pays the rest`);
  }).catch(() => {});
  return { repo, config, widgetRegistry: runtime.registry, bus: runtime.bus, pluginRuntime: runtime, enforcer, playerTriggerRunner, phoneAlerts, crconTransforms: new Map(), roleSync: { current: null }, loginThrottle: new LoginThrottle(), dataPortRun: { current: null, uploading: false }, runningPayoutKeys: new Set(), tunnel: createTunnel({ log: createLogger("tunnel") }), updates: createUpdateCheck({ commit: process.env.APP_COMMIT, branch: process.env.APP_BRANCH, repo: process.env.APP_REPO }) };
}
