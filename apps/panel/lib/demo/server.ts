/**
 * The public demo's API (app/demo): every request the panel makes, answered in the visitor's own
 * browser from a made-up community. Nothing is sent anywhere, so the demo can neither read nor
 * change a real install, its servers or its players, whoever opens it.
 *
 * What answers, first match first:
 *  1. the routes below — the account, its settings, its dashboard and its arrangement of panels,
 *     kept until the page is reloaded — the made-up community's lists (lib/demo/community), and
 *     server analytics' crossplay split (lib/demo/analytics);
 *  2. the walkthrough stage (test/walk-stage.mjs): each screen as Help's pictures show it;
 *  3. the test stub's answers (test/stage-answers.mjs), a quiet community under all of that;
 *  4. for any other read, nothing: every screen copes with an empty answer.
 * Any other change is refused, in words that say the demo does not keep it (NOT_KEPT).
 */
import { HLL_DESCRIPTOR, OWNER_GRANTS, stageAnswers } from "../../test/stage-answers.mjs";
import { WALK_FIXTURES } from "../../test/walk-stage.mjs";
import { DASHBOARD_WIDGETS, resolveLayout, type LayoutConfig } from "../../../../packages/widgets/src/index.ts";
import { SETUP_VERSION } from "../gettingStarted.ts";
import { BUILT_COMMIT } from "../version.ts";
import { WHATS_NEW } from "../whatsNew.ts";
import { withPlatforms, type StageServerAnalytics } from "./analytics.ts";
import { addCommunity } from "./community.ts";
import { createMatch } from "./match.ts";

export interface DemoRequest {
  method: string;
  url: URL;
  /** The request's JSON, or null; `{ file: true }` for a file being sent. */
  body: unknown;
}

export interface DemoAnswer {
  status: number;
  body?: unknown;
  /** An answer that is not JSON (a picture), as text of this type. */
  raw?: string;
  type?: string;
}

/** What a change the demo does not keep is answered with. */
export const NOT_KEPT = "The demo doesn't keep this change. On your own panel it would be made.";

type Fixture = { status?: number; body?: unknown; raw?: string; type?: string } | undefined;
type FixtureEntry = Fixture | ((url: URL, req: { method: string }) => Fixture);
/** A route's answer; undefined leaves the request to the walkthrough stage's answers. */
type Handler = (req: DemoRequest, params: Record<string, string>) => DemoAnswer | undefined;

const ok = (body: unknown): DemoAnswer => ({ status: 200, body });
const refused = (status: number, message: string): DemoAnswer => ({ status, body: { error: { code: "demo", message } } });

/** A route's address with its `:names`, as a pattern that captures them. */
function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return "([^/]+)"; })}$`);
  return { pattern, keys };
}

/**
 * The demo's own API: one per page, its records kept for as long as the page is open. `staffPanel`
 * is the bot's own drawing of its Discord panel (test/staff-panel-sample.json); `built` is the
 * commit the page was built from (lib/version).
 */
export function createDemoServer(staffPanel: unknown, built: string | null = BUILT_COMMIT) {
  const stage = stageAnswers(OWNER_GRANTS, staffPanel) as Record<string, unknown>;
  const fixtures = WALK_FIXTURES as Record<string, FixtureEntry>;

  /** The visitor's settings: set up and every update seen, so nothing opens over the screen. */
  let prefs: Record<string, unknown> = { setupSeen: SETUP_VERSION, whatsNewSeen: WHATS_NEW[0]?.build ?? 0 };
  /** Panels arranged by the visitor, by screen. */
  const layouts = new Map<string, unknown>();
  /** The dashboard's tiles as the visitor arranged them: the install's defaults until then. */
  let dashboard: LayoutConfig | null = null;

  const routes: { method: string; pattern: RegExp; keys: string[]; handle: Handler }[] = [];
  const on = (method: string, path: string, handle: Handler) => routes.push({ method, ...compile(path), handle });

  on("GET", "/api/me", () => {
    const me = stage["/api/me"] as Record<string, unknown>;
    return ok({
      ...me,
      user: { id: "u1", username: "demo", displayName: "Demo admin", discordNick: null, role: "owner", hasPassword: true, createdAt: "2026-01-02T03:04:05.000Z" },
      prefs,
    });
  });
  on("PUT", "/api/me/prefs", (req) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return refused(400, "expected an object of preferences");
    prefs = { ...prefs, ...(req.body as Record<string, unknown>) };
    return ok({ prefs });
  });
  // Plugins are not part of the demo.
  on("GET", "/api/plugin-pages", () => ok({ pages: [] }));
  on("GET", "/api/plugins", () => ok({ plugins: [] }));
  // The host: the demo runs the very build it came with, so it reports that build's commit, and the
  // menu never offers a reload for an update (lib/version).
  on("GET", "/api/health/metrics", () => ok({ ...(stage["/api/health/metrics"] as object), hostname: "demo", appVersion: null, appCommit: built }));
  // Server analytics: the stage's, with the crossplay split it leaves out.
  on("GET", "/api/analytics/server", () => ok(withPlatforms(stage["/api/analytics/server"] as StageServerAnalytics)));
  // The dashboard's tiles, as a new install has them, and as the visitor arranges them.
  on("GET", "/api/layout/dashboard", () => ok({ surface: "dashboard", source: dashboard ? "user" : "default", widgets: resolveLayout(DASHBOARD_WIDGETS, dashboard) }));
  on("PUT", "/api/layout/dashboard", (req) => {
    const config = (req.body as { config?: { items?: unknown } } | null)?.config;
    if (!config || !Array.isArray(config.items)) return refused(400, "malformed layout config");
    dashboard = config as LayoutConfig;
    return ok({ saved: true, scope: "user", updatedAt: new Date().toISOString() });
  });
  on("DELETE", "/api/layout/dashboard", () => {
    const removed = dashboard !== null;
    dashboard = null;
    return ok({ removed });
  });
  // Arranging a screen's panels, kept until the page is reloaded.
  on("GET", "/api/layout/:surface", (req, { surface }) => {
    if (!surface!.startsWith("panel:")) return answerFixture(req) ?? ok({});
    const config = layouts.get(surface!);
    return ok({ surface, source: config ? "user" : "default", config: config ?? null });
  });
  on("PUT", "/api/layout/:surface", (req, { surface }) => {
    const config = (req.body as { config?: unknown } | null)?.config;
    if (!surface!.startsWith("panel:") || !config || typeof config !== "object") return refused(400, NOT_KEPT);
    layouts.set(surface!, config);
    return ok({ saved: true, scope: "user", updatedAt: new Date().toISOString() });
  });
  on("DELETE", "/api/layout/:surface", (_req, { surface }) => ok({ removed: layouts.delete(surface!) }));
  // Read marks, which the panel sends as screens are looked at.
  on("POST", "/api/me/announcements-seen", () => ok({ ok: true }));
  on("POST", "/api/community/announcements/read", () => ok({ ok: true }));
  // Linking a Discord account would leave the demo for Discord.
  on("GET", "/api/auth/discord/link/start", () => refused(400, "The demo can't link a Discord account."));
  // The round being played on the first server: Live's own read, the rotation it plays through,
  // the round so far that Live's feed opens on, and the stream below.
  on("GET", "/api/servers/s1/live", () => ok(match.live(Date.now())));
  on("GET", "/api/servers/s1/maprotation", () => ok({ mapRotation: match.rotation(Date.now()) }));
  on("GET", "/api/servers/s1/round/events", (req) => {
    const u = req.url.searchParams;
    const kinds = (u.get("kinds") ?? "").split(",").filter(Boolean);
    return ok(match.round(Date.now(), Math.min(1000, Math.max(1, Number(u.get("limit")) || 300)), kinds.length ? kinds : undefined));
  });
  // The community at scale, its players' profiles and its rounds drawn as the stage draws its own.
  const community = addCommunity(on, Date.now(), {
    profile: (answerFixture({ method: "GET", url: new URL("http://demo/api/players/p1"), body: null })?.body ?? {}) as Record<string, unknown>,
    match: (answerFixture({ method: "GET", url: new URL("http://demo/api/matches/m1"), body: null })?.body ?? {}) as Record<string, unknown>,
    onServer: () => match.onServer(),
  });
  const match = createMatch(community, Date.now());

  /** The walkthrough stage's answer, or the stub's, for a read. */
  function answerFixture(req: DemoRequest): DemoAnswer | undefined {
    const path = req.url.pathname;
    const entry = fixtures[path];
    const fixed = typeof entry === "function" ? entry(req.url, { method: req.method }) : entry;
    if (fixed) return { status: fixed.status ?? 200, body: fixed.body ?? {}, raw: fixed.raw, type: fixed.type };
    const base = stage[path];
    const body = typeof base === "function" ? (base as (url: URL) => unknown)(req.url) : base;
    if (body !== undefined) return ok(body);
    return undefined;
  }

  return {
    answer(req: DemoRequest): DemoAnswer {
      const path = req.url.pathname;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(path);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });
        const answer = r.handle(req, params);
        if (answer) return answer;
      }
      if (req.method !== "GET") return refused(400, NOT_KEPT);
      return answerFixture(req) ?? ok(/\/descriptor$/.test(path) ? { descriptor: HLL_DESCRIPTOR } : {});
    },
    /**
     * The live stream: what happens in the round as it happens, for one server (`serverId`) or all.
     * The round plays on while someone listens. Returns how to stop.
     */
    stream(url: URL, send: (data: string) => void): () => void {
      const only = url.searchParams.get("serverId");
      const stop = match.listen((e) => { if (!only || only === e.serverId) send(JSON.stringify(e)); });
      const timer = setInterval(() => match.advance(Date.now()), 1_000);
      return () => { stop(); clearInterval(timer); };
    },
  };
}

export type DemoServer = ReturnType<typeof createDemoServer>;
