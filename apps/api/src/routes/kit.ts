/**
 * The route toolkit: everything a route module needs that is not a route.
 *
 * app.ts used to be one 5,000-line file holding the imports, these helpers, all 168 routes and the
 * request handler. The routes now live in sibling modules grouped by what they are about, which
 * leaves this as their shared vocabulary — the `route()` builder, the permission guards, the body
 * parsers, and the small game/host helpers several domains reach for.
 *
 * Nothing here is new. It was all lifted verbatim out of app.ts.
 */

import { buildAdminResponseAnalytics, pairAdminResponses } from "../analytics.js";
import type { ResponderAction } from "../analytics.js";
import { authenticate, displayNameOf, resolveAccess, roleGrants } from "../auth.js";
import type { Principal } from "../auth.js";
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson, str } from "../http.js";
import { NOT_ASKABLE, askOrCapture, fileRefusedWrite } from "../ask.js";
import { pathServerId, requestScope } from "../request-scope.js";
import { LIMIT_CATALOG, can, holdsOutright, type Grant } from "@app/access";
import { capabilityCatalog, capabilityDef, isUnknownCapability, outrightPluginPowers } from "../plugin-permissions.js";
import { GROUP_JOINED_KIND, GROUP_LEFT_KIND, NO_VIP_KIND, PLAYTIME_KIND, SCHEDULE_KIND, STATE_TRIGGERS, WEAPON_TRIGGER_KIND, isGroupTriggerKind, isStateTriggerKind, parseTriggerParams } from "@app/rules";
import { DISCORD_ALERTS_DEFAULTS, DISCORD_RELAY_CATEGORIES, DISCORD_STATUS_BOARD_DEFAULTS, DISCORD_STATUS_BOARD_MIN_SEC, MAPVOTE_MESSAGE_LAYOUTS, blankMapVoteState, kindsForCategories, TRIM_CATEGORIES, TRIM_DATASETS } from "@app/db";
import { RULE_CAP_PERIODS, type RuleCapPeriod } from "@app/db";
import { MAPVOTE_STARTUP_STATES, MATCH_MESSAGE_MAX, SEED_CHASE_CHECK_SEC, SEED_CHECK_SEC, getAppSetting, getFeaturePreset, isAppSettingKey } from "@app/db";
import type { AuditRow, AutoSettingsConfigPatch, AutoSettingsMatchMessage, AutoSettingsProfile, BroadcastConfigPatch, SeedBridgeTarget, DiscordAlertsConfig, DiscordCommandConfig, DiscordRelayConfigPatch, DiscordStatusBoardConfig, MapVoteLink, MapVoteMessageLayout, MapVoteReminder, MapVoteStartupState, MapVoteStateRow, NewRule, Repository, RoleAssignment, RoleRow, SeedingConfigPatch, ServerRow } from "@app/db";
import { getGame, listGames, rosterPlayerId } from "@app/games";
import { DEFAULT_POOL_CONFIG, POLL_OPTION_LIMIT, isSectorId } from "@app/maps";
import type { MapPoolConfig, MapVoteProfile } from "@app/maps";
import { createServerClient, normalizeGameBans } from "@app/rcon-core";
import { WEEKDAYS, recurrenceError } from "@app/schedule";
import type { Weekday } from "@app/schedule";
import { applySignature, createLogger, errors, signatureUseFor } from "@app/shared";
import { statfs } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import type { AppContext } from "../context.js";
import { GROUP_RULE_ACTIONS, SCHEDULE_ACTIONS, SCHEDULE_TAKING_ACTIONS, scheduleOf } from "../schedule-spec.js";

/** The triggers a VIP-granting rule may sit on — see parseRule. */
const VIP_ACTION_KINDS = new Set(["evt.player.disconnected", NO_VIP_KIND, PLAYTIME_KIND, GROUP_JOINED_KIND, GROUP_LEFT_KIND, SCHEDULE_KIND]);
// What a group-membership rule may do (GROUP_RULE_ACTIONS, shared with the enforcer, which checks
// it again at firing time). Membership is not presence — a player added to a group can be
// anywhere, or nowhere — so only what reaches somebody who is not on a server: VIP, points, a tag,
// a note. Not a ban either: whoever may edit a group could then ban anyone by adding them.
/** A rule's VIP time and cooldown top out at a year, in minutes. */
export const VIP_RULE_MAX_MINUTES = 365 * 24 * 60;

/** The longest window any analytics read covers: a custom range or "all time" beyond this is
 *  clipped to its most recent ten years. Past a decade the per-day and per-hour grids stop being a
 *  chart and become a very long wait. */
export const ANALYTICS_MAX_SPAN_DAYS = 3660;

/**
 * The window every analytics page asks about. Three forms, one parser, so the pages cannot drift
 * into meaning different things by "last 30 days":
 *   - `?days=N` back from now (1–365, default 30) — the preset buttons;
 *   - `?from=&to=` (ISO) — a custom range, or a page scoped to an EVENT's exact window. Wins over
 *     `days` when both parse. Up to ANALYTICS_MAX_SPAN_DAYS long, never past now;
 *   - `?all=1` — all time: from `earliest` (when this server's recorded history starts, which the
 *     caller reads — see resolveAnalyticsWindow) to now.
 * Junk falls back to the days form rather than erroring: a stale link should show a chart, not a 400.
 */
export function analyticsWindow(u: URLSearchParams, serverId?: string, earliest?: string | null): { serverId?: string; from: string; to: string } {
  const nowMs = Date.now();
  const maxSpan = ANALYTICS_MAX_SPAN_DAYS * 86_400_000;
  if (u.get("all") === "1") {
    const startMs = Date.parse(earliest ?? "");
    // No history yet: a day, so the page renders its "nothing yet" states rather than an error.
    const fromMs = Number.isFinite(startMs) ? Math.max(Math.min(startMs, nowMs - 86_400_000), nowMs - maxSpan) : nowMs - 86_400_000;
    return { serverId, from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() };
  }
  const fromMs = Date.parse(u.get("from") ?? "");
  const toRaw = Date.parse(u.get("to") ?? "");
  const toMs = Number.isFinite(toRaw) ? Math.min(toRaw, nowMs) : toRaw;
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs) {
    return { serverId, from: new Date(Math.max(fromMs, toMs - maxSpan)).toISOString(), to: new Date(toMs).toISOString() };
  }
  const days = Math.min(Math.max(Number(u.get("days") ?? 30) || 30, 1), 365);
  const to = new Date(nowMs);
  const from = new Date(to.getTime() - days * 86_400_000);
  return { serverId, from: from.toISOString(), to: to.toISOString() };
}

/** analyticsWindow, reading when the recorded history starts first when the caller asked for all
 *  time. Only then: every other form is pure arithmetic and costs no query. */
export async function resolveAnalyticsWindow(repo: Repository, u: URLSearchParams, serverId?: string): Promise<{ serverId?: string; from: string; to: string }> {
  const earliest = u.get("all") === "1" ? await repo.analytics.earliest(serverId).catch(() => null) : undefined;
  return analyticsWindow(u, serverId, earliest);
}

/**
 * How many rows a page may ask for. `?limit=` is the one number a caller picks that goes straight
 * into a query, so it is the one that has to be clamped rather than trusted.
 *
 * Every site wrote this as `Math.min(Number(u.get("limit") ?? D), MAX)` — with the offset parse on
 * the very next line getting it right. That min guards the top and nothing else: `?limit=abc` is
 * NaN, `?limit=-5` is -5, and both reach the database verbatim, where Postgres raises ("invalid
 * input syntax for type bigint", "LIMIT must not be negative") and a malformed request is answered
 * with a 500 instead of a page. The memory store, meanwhile, silently returns nothing for all
 * three — so the two stores disagreed about a query that should never have been asked.
 *
 * Two different situations, handled differently on purpose. Asking for MORE than the ceiling is a
 * real request the server is allowed to trim, so it clamps down. Anything that is not a positive
 * page size at all — blank, unparseable, zero, negative — is not a smaller request, it is no
 * request, and it gets the default. `?limit=` with nothing after it is the common one: a caller
 * building a query string out of a value that turned out to be undefined.
 */
export function pageLimit(u: URLSearchParams, def: number, max: number): number {
  const raw = Number(u.get("limit") ?? def);
  if (Number.isNaN(raw)) return def;
  if (raw === Infinity) return max; // "everything" is a request to trim, not a malformed one
  const n = Math.floor(raw);
  return n >= 1 ? Math.min(n, max) : def;
}

/** Where a page starts. Anything that is not a real position is the beginning. */
export function pageOffset(u: URLSearchParams): number {
  const n = Math.floor(Number(u.get("offset") ?? 0));
  return Number.isFinite(n) ? Math.max(n, 0) : 0;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, ctx: AppContext, params: Record<string, string>) => Promise<void>;

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/**
 * The timezone a read should be bucketed in — the VIEWER's, sent by the panel.
 *
 * "Which hours of the week are thin on cover" is a question about local time. Answered in UTC it is
 * not slightly off, it is answered about a different week: a Saturday-evening peak in US Central
 * lands on Sunday morning in a UTC grid. The panel sends its own resolved zone; anything we cannot
 * use falls back to UTC, which is exactly what every caller got before this existed.
 */
export function viewerTimeZone(src: IncomingMessage | URLSearchParams): string {
  // A header, not a query param: it applies to every read and no caller has to remember it.
  const raw = src instanceof URLSearchParams
    ? src.get("tz")
    : (Array.isArray(src.headers["x-time-zone"]) ? src.headers["x-time-zone"][0] : src.headers["x-time-zone"]);
  const tz = (raw ?? "").trim();
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/**
 * The snapshot a paged read is taken against.
 *
 * Offset paging assumes the list holds still, and the lists this panel pages through do not: the
 * game log gains a row every few seconds on a busy server. Ask for OFFSET 50 a minute after page
 * one and every row that arrived in between has pushed the window down — so page two starts inside
 * page one. The reader sees rows they just read, and never sees the ones squeezed out between the
 * two windows. Measured on a real database: ten events arriving mid-read repeated ten rows and hid
 * ten others.
 *
 * The fix is to pin the result set. Page one mints an anchor — the instant the read began — and the
 * response carries it back; every later page passes it in and is answered from the same snapshot.
 * Rows newer than the anchor are simply not part of this read; the reader refreshes to see them.
 *
 * An anchor only ever narrows a caller's own `to` bound, never widens it, so an explicit date
 * filter still wins.
 *
 * The anchor is the first instant NOT in the read — every store compares `ts < to` — so minting it
 * takes the next representable instant rather than the current one. Timestamps here are milliseconds,
 * and a row written in the SAME millisecond the read began is not newer than the read; with a bare
 * `Date.now()` it was excluded anyway, and both the page and its total quietly under-reported.
 * That is not theoretical: it made a suite test flap, because twelve rows written in a tight loop
 * and read immediately after regularly share a millisecond with the read that follows them.
 */
export function pageAnchor(u: URLSearchParams, userTo?: string): { anchor: string; to: string } {
  const raw = (u.get("anchor") ?? "").trim();
  // Only accept something that really is a timestamp — a junk anchor must not silently become
  // `to: "banana"` and filter everything out. An anchor handed back by a previous page is used
  // exactly as given: it already names an exclusive bound, and shifting it again on every page
  // would make each page read against a slightly different snapshot.
  const anchor = raw && !Number.isNaN(Date.parse(raw))
    ? new Date(raw).toISOString()
    : new Date(Date.now() + 1).toISOString();
  const to = userTo && userTo < anchor ? userTo : anchor;
  return { anchor, to };
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Every write registered through plain `route()`, by `METHOD /path` — with the handler, when it can
 * be asked for, so an approved request can run it again. (The server wrapper keeps its own,
 * REPLAYABLE_WRITES below.) A test holds this list to the labels and to NOT_ASKABLE.
 */
export const PLAIN_WRITES = new Map<string, Handler | null>();

export function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path
        .replace(/:[^/]+/g, (m) => {
          keys.push(m.slice(1));
          return "([^/]+)";
        })
        // A trailing `/*name` takes the whole rest of the path, slash first: the plugin routes,
        // whose paths below their prefix are the plugin's own business.
        .replace(/\/\*([a-zA-Z]+)$/, (_m, name: string) => {
          keys.push(name);
          return "(/.+)";
        }) +
      "$",
  );
  if (!WRITE_METHODS.has(method)) return { method, pattern, keys, handler };
  /*
   * A write a role can be granted ASKS when the caller lacks it: refused from inside its handler,
   * it is filed for whoever holds the permission — or captured, while the caller builds a request —
   * instead of answering 403 (see request-scope.ts). The server wrapper registers its routes before
   * calling here, so those are recognised and asked for the same way; NOT_ASKABLE says which writes
   * keep refusing, and why.
   */
  const key = replayKey(method, path);
  const viaServerRoute = REPLAYABLE_WRITES.has(key);
  const askable = viaServerRoute || !(key in NOT_ASKABLE);
  if (!viaServerRoute) PLAIN_WRITES.set(key, askable ? handler : null);
  if (!askable) return { method, pattern, keys, handler };
  return {
    method, pattern, keys,
    handler: (req, res, ctx, params) => requestScope.run({ ask: { method, path, params, req, ctx } }, () => handler(req, res, ctx, params)),
  };
}

/**
 * A route about ONE server: `/api/servers/:id/...`.
 *
 * Every one of these opened with the same six lines — resolve the principal, check the capability
 * SCOPED TO THE SERVER IN THE PATH, look that server up, 404 if it isn't there. Written out at
 * every call site that is a few hundred lines whose only job is to be identical, and each copy is
 * a chance to scope the permission to the wrong id, or to skip the 404 and hand the body a server
 * that does not exist.
 *
 * Declaring the requirement instead makes both unforgettable: a route registered this way cannot
 * run its body without them. The body receives `p`, `id` and `server` already resolved, under the
 * same names the inline version used.
 *
 * Routes whose capability depends on the request body (the admin actions, whose permission is the
 * action's own) still do it by hand — they cannot know what to check until they have read the body.
 */
export type ServerRouteHandler = (args: {
  req: IncomingMessage; res: ServerResponse; ctx: AppContext; params: Record<string, string>;
  p: Principal; id: string; server: ServerRow;
}) => Promise<void> | void;

/**
 * Every WRITE registered through `serverRoute`, by `METHOD /path`, so an approved request can run
 * the very same handler later.
 *
 * This is what makes the whole server-scoped surface requestable without twenty-six hand-written
 * branches in the approvals executor: the wrapper that gates these routes is also the one place
 * that can file them, and a filed line is nothing more than the call that was refused — method,
 * path, query and body — replayed when somebody signs it. A route added tomorrow is requestable
 * the moment it is written, with no second list to keep in step.
 */
export const REPLAYABLE_WRITES = new Map<string, { capability: string; handler: ServerRouteHandler }>();
export const replayKey = (method: string, path: string) => `${method} ${path}`;

/**
 * A route about ONE server: `/api/servers/:id/...`.
 *
 * Every one of these opened with the same six lines — resolve the principal, check the capability
 * SCOPED TO THE SERVER IN THE PATH, look that server up, 404 if it isn't there. Written out at
 * every call site that is a few hundred lines whose only job is to be identical, and each copy is
 * a chance to scope the permission to the wrong id, or to skip the 404 and hand the body a server
 * that does not exist.
 *
 * Declaring the requirement instead makes both unforgettable: a route registered this way cannot
 * run its body without them. The body receives `p`, `id` and `server` already resolved, under the
 * same names the inline version used.
 *
 * Routes whose capability depends on the request body (the admin actions, whose permission is the
 * action's own) still do it by hand — they cannot know what to check until they have read the body.
 *
 * WRITES ALSO ASK. Lacking the permission files the call as an approval request instead of
 * refusing it, and an open request builder captures it instead of running it — the same two fates
 * every player action already had, extended to map work, votes, seeding, console and configuration
 * by the wrapper they all share rather than by twenty-six copies of the same twelve lines.
 */
/**
 * Whether this requester is locked out of WRITING to this server by decommission (lifecycle
 * stage 2). A decommissioned server may be changed by ONE identity only — the setup account,
 * the install's first created login — and for everyone else the answer is a 404 identical to
 * "no such server": the listing already hides the row per reader, and a UUID saved from before
 * the decommission must not stay usable as a side door (config edits, VIP writes, game actions,
 * imports, purges). READS are deliberately not behind this: decommissioning keeps every record
 * retrievable — the server stops being changeable, not its history readable.
 *
 * Takes the row when the caller already fetched it, or the id when it did not.
 */
/**
 * The accounts a call acts AS: the caller — and, while an approved request is carried out, the
 * signer whose grants it runs with (the caller is then the requester). "Not on your own account"
 * guards ask about both: a request naming the signer's account must not delete, merge away or
 * demote it, which the signer could not do to it by hand.
 */
export function ownAccounts(p: Principal): Set<string> {
  return new Set(p.signer ? [p.user.id, p.signer.userId] : [p.user.id]);
}

export async function decommissionLocked(ctx: AppContext, p: Principal, server: string | ServerRow | null): Promise<boolean> {
  const row = typeof server === "string" ? await ctx.repo.servers.findById(server) : server;
  if (!row?.decommissionedAt) return false;
  // A preview sees what the role would, and a decommissioned server is the setup account's alone.
  return Boolean(p.preview) || p.user.id !== await ctx.repo.users.firstUserId();
}

export function serverRoute(
  method: string,
  path: string,
  capability: string,
  level: "read" | "write",
  handler: ServerRouteHandler,
): Route {
  if (level === "write") REPLAYABLE_WRITES.set(replayKey(method, path), { capability, handler });
  return route(method, path, async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    const server = await ctx.repo.servers.findById(id);
    if (!server) return sendError(res, 404, "server not found");
    if (level === "write") {
      // Before askOrCapture, so nobody can even FILE an approval request against a server that
      // does not exist for them.
      if (await decommissionLocked(ctx, p, server)) return sendError(res, 404, "server not found");
      const filed = await askOrCapture(ctx, p, { method, path, capability, req, params, serverId: id });
      if (filed) return sendJson(res, 202, filed);
    }
    /*
     * Reads still refuse — there is nothing to ask for in a read. For a write this is now a
     * backstop rather than the gate: `askOrCapture` answered 202 for everyone who lacks the
     * permission, so reaching a refusal here means it decided the caller may proceed. Kept because
     * a permission check that exists only implicitly is one refactor away from not existing.
     */
    if (!can(p.grants, capability, level, { serverId: id })) return sendForbidden(res, capability, level);
    await handler({ req, res, ctx, params, p, id, server });
  });
}

/**
 * Which servers a community-wide read should cover.
 *
 * The player directory, the leaderboard and the player-analytics page are not per-server screens
 * the way the console or the map rotation are: a player is one person across the whole community,
 * so these pages have to be able to ask "everyone" as well as "on this server". That freedom is
 * exactly how they went wrong — they could ONLY ask "everyone", while the sidebar displayed one
 * pinned server above them, so merged figures read as that server's.
 *
 * The answer here is a list, and the caller passes it straight to the store:
 *
 *   - `?serverId=<id>` — that one server, if the viewer may see it (403 otherwise).
 *   - no parameter, viewer can see every server — `undefined`, meaning no restriction at all.
 *   - no parameter, viewer is scoped — the servers they CAN see, summed.
 *
 * That last case is the part a single optional id could not express. Someone granted view on one
 * of five servers used to get an all-servers board: not just a wrong number, but five servers'
 * worth of player activity they had no grant for.
 *
 * Returns null after answering the request itself (403), so callers `if (!scope) return;`.
 */
export async function serverScope(
  req: IncomingMessage, res: ServerResponse, ctx: AppContext, p: Principal, capability: string,
): Promise<{ serverIds: string[] | undefined; requested: string | null; restricted: boolean } | null> {
  const requested = new URL(req.url ?? "", "http://x").searchParams.get("serverId");
  // includeRetired: this scope gates READS of history (audit, analytics, cam sessions) — a
  // retired server's past must stay visible to whoever could see it before the retirement.
  const all = await ctx.repo.servers.list({ includeRetired: true });
  // Whether this reader's GRANTS hold anything back, independent of what they asked to look at.
  // The two are not the same question, and conflating them is how a plain view filter started
  // behaving like a permission boundary — see AuditQuery.includeUnscoped.
  const visible = all.filter((s) => can(p.grants, capability, "read", { serverId: s.id }));
  const restricted = visible.length !== all.length;
  if (requested) {
    if (!can(p.grants, capability, "read", { serverId: requested })) {
      sendForbidden(res, capability, "read");
      return null;
    }
    return { serverIds: [requested], requested, restricted };
  }
  // Seeing everything is the only case that needs no restriction — and passing undefined rather
  // than the full id list also lets the store skip the filter entirely. A fresh install with no
  // servers configured lands here too, which is right: nothing to restrict to, and nothing to
  // hide. Unrestricted is also the only reading that includes history from before the per-server
  // split, which belongs to no server and so can only be shown to someone who can see them all.
  return { serverIds: restricted ? visible.map((s) => s.id) : undefined, requested: null, restricted };
}

/** A fresh map-vote state row. Central so new columns can't be forgotten at one of the call sites. */
/** Re-exported so callers here keep their local name; the definition lives with the type. */
export function emptyVoteState(serverId: string): MapVoteStateRow {
  return blankMapVoteState(serverId);
}

export async function requirePrincipal(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<Principal | null> {
  // An approved request's replay hands its principal in (the signer's grants, the requester's
  // name); a handler asking twice gets the same answer without a second session lookup.
  const scope = requestScope.getStore();
  if (scope?.principal) return scope.principal;
  const principal = await authenticate(req, ctx.repo, ctx.config);
  if (!principal) {
    sendError(res, 401, "unauthorized");
    return null;
  }
  // "View as" only looks. The panel holds back every write while it previews, and a write that
  // arrives anyway is refused here rather than carried out on the previewer's behalf.
  if (principal.preview && req.method !== "GET" && req.method !== "HEAD") {
    sendError(res, 403, "You're previewing a role — it's read-only. Exit the preview to make changes.");
    return null;
  }
  if (scope?.ask) {
    /*
     * Building a request: nothing pressed happens until submit. The write grants are held back for
     * this call, so the handler's own check refuses and the refusal is captured into the draft with
     * the exact permission and scope it found missing — the fate at submit is then decided on the
     * real grants. Reads are untouched: the handler still loads what it needs to validate.
     */
    const draft = await ctx.repo.approvals.findDraft(principal.user.id);
    if (draft && !draft.parkedAt) {
      scope.building = true;
      scope.principal = { ...principal, grants: principal.grants.map((g) => (g.level === "write" ? { ...g, level: "read" as const } : g)) };
      return scope.principal;
    }
    scope.principal = principal;
  }
  return principal;
}

/** Permission denial that says WHICH permission was missing — by its human label — and carries
 *  the machine-readable pair for clients. Every capability check reports through here so a
 *  denied staff member (or their admin) knows exactly what to grant.
 *
 *  Inside a write that can be asked for, a missing WRITE is not refused: the call is filed for
 *  whoever holds it (or captured into the request being built) and answered 202 — see
 *  request-scope.ts. `scope.serverId` is the server the check was made against, when the path does
 *  not already name it; leave it out for a check made anywhere (canAnywhere). */
export function sendForbidden(res: ServerResponse, capability: string, level: "read" | "write", scope?: { serverId: string | null }): void | Promise<void> {
  const s = requestScope.getStore();
  if (level === "write" && s?.ask) {
    // A server the path names is always the line's: an approved call is replayed on the line's
    // server, so a key checked on some other server must not move the call there.
    const serverId = pathServerId(s.ask.path, s.ask.params) ?? (scope ? scope.serverId : null);
    // A replay's refusal refuses — the signer lacked it too — and says what was missing, so the
    // request builder can ask for that instead of recording a failure.
    if (s.replay) s.refused = { capability, serverId };
    else if (s.principal && !res.headersSent) {
      const principal = s.principal;
      return fileRefusedWrite({ ask: s.ask, principal, building: s.building }, capability, serverId)
        .then((body) => sendJson(res, 202, body));
    }
  }
  const def = capabilityDef(capability);
  const label = def ? `${def.label} (${def.group})` : capability;
  sendError(res, 403, `missing permission: ${label} — ${level} access required`, { missing: { capability, level } });
}

/** Users with EFFECTIVE all-access (a global "*" at write, of their own or via a role held
 *  everywhere), for lockout guards. `excludeRoleId` evaluates the world as if that role no longer
 *  conferred ownership (for role-delete / role-edit guards). */
export async function effectiveOwnerIds(repo: AppContext["repo"], excludeRoleId?: string): Promise<Set<string>> {
  const roles = await repo.roles.list();
  // Ownership is the global "*" at WRITE — the same thing holdsOutright(grants, "*", "write") asks
  // on every owner-only route. A "*" at none is a lockout, and one anyone with user admin can plant
  // on a dummy account; at read it is an auditor. Counting either as an owner let the last real
  // owner be stripped because a decoy "owner" existed.
  const starRoles = roles.filter((r) => r.id !== excludeRoleId && r.grants.some((g) => g.capability === "*" && g.level === "write")).map((r) => r.id);
  // Ownership is all-access EVERYWHERE. A "*" confined to one server is full control of that
  // server, which is a different (and much smaller) thing — counting it here would let the last
  // real owner remove their own access because someone else runs one server. Both halves ask the
  // store that question directly; this used to walk every account and issue up to two queries each,
  // serially, on a path that runs on every permission save.
  const [direct, viaRole] = await Promise.all([
    repo.grants.userIdsWithGlobalCapability("*", "write"),
    repo.userRoles.unscopedMembersOf(starRoles),
  ]);
  // Those are the CANDIDATES. Each is then asked what they effectively hold, because a row is not
  // the answer: a personal "*" none beside an Owners role is the per-person lockout, and an owner
  // locked out that way must not count as the second owner that lets the real one be removed.
  // Owners are a handful of accounts, so this stays a few reads, not a walk of every user.
  const owners = new Set<string>();
  await Promise.all([...new Set([...direct, ...viaRole])].map(async (id) => {
    const { grants } = await resolveAccess(repo, id);
    const counted = excludeRoleId ? grants.filter((g) => g.source !== excludeRoleId) : grants;
    if (holdsOutright(counted, "*", "write")) owners.add(id);
  }));
  return owners;
}

/**
 * Read a set of scoped role assignments from a request body.
 *
 * Two shapes are accepted, because two callers grew up sending one each and both are reasonable:
 *
 *   roles:   [{ roleId, scopeId }]   the scoped form — scopeId null/absent means everywhere
 *   roleIds: [id]                    the original form, all of them global
 *
 * Keeping the second is not just kindness to old clients: "give them this role everywhere" stays
 * the common case and shouldn't need the longer shape to express.
 *
 * Every role and every named server is checked to exist, so a typo fails loudly instead of
 * quietly creating an assignment that grants nothing.
 */
export type ParsedRoleAssignments =
  | { ok: true; assignments: RoleAssignment[]; roles: RoleRow[] }
  | { ok: false; status: number; message: string };

export async function parseRoleAssignments(repo: Repository, body: Record<string, unknown>): Promise<ParsedRoleAssignments> {
  const raw: { roleId: string; scopeId: string | null }[] = [];
  if (Array.isArray(body.roles)) {
    for (const r of body.roles as Record<string, unknown>[]) {
      const roleId = str(r?.roleId).trim();
      if (!roleId) return { ok: false, status: 400, message: "each role needs a roleId" };
      const scopeId = r?.scopeId == null || r.scopeId === "" ? null : str(r.scopeId).trim();
      raw.push({ roleId, scopeId });
    }
  } else if (Array.isArray(body.roleIds)) {
    for (const id of body.roleIds as unknown[]) raw.push({ roleId: str(id).trim(), scopeId: null });
  } else {
    return { ok: false, status: 400, message: "roles or roleIds array is required" };
  }

  // Collapse exact duplicates; the same role at two different scopes is NOT a duplicate.
  const deduped = new Map<string, RoleAssignment>();
  for (const a of raw) deduped.set(`${a.roleId}|${a.scopeId ?? ""}`, a);
  const assignments = [...deduped.values()];

  const roles: RoleRow[] = [];
  for (const id of new Set(assignments.map((a) => a.roleId))) {
    const r = await repo.roles.get(id);
    // 400, not 404: the route's own resource (the user, the Discord role) is fine — it is the body
    // that names something that does not exist, same as an unknown server below.
    if (!r) return { ok: false, status: 400, message: `unknown role: ${id}` };
    roles.push(r);
  }
  for (const id of new Set(assignments.map((a) => a.scopeId).filter((s): s is string => s !== null))) {
    if (!(await repo.servers.findById(id))) return { ok: false, status: 400, message: `unknown server: ${id}` };
  }
  return { ok: true, assignments, roles };
}

/** The powers only ever held outright, strongest first: the global "*" at write (ownership), at read
 *  (which also opens every outright permission), then each outright permission a loaded plugin
 *  declares (plugin-permissions.ts) — and last any permission in the grants being judged that
 *  nothing loaded declares: a plugin that isn't running may have made it outright, and lifting a
 *  veto on it now would hand it out the moment the plugin is back. */
const outrightPowers = (...judged: Grant[][]): { capability: string; level: "read" | "write" }[] => [
  { capability: "*", level: "write" },
  { capability: "*", level: "read" },
  ...outrightPluginPowers(),
  ...[...new Set(judged.flat().map((g) => g.capability).filter(isUnknownCapability))]
    .flatMap((capability) => [{ capability, level: "write" as const }, { capability, level: "read" as const }]),
];

/**
 * Refuses a user-admin change that would leave someone holding what is only ever held outright — a
 * global "*" (at the level reached) or an outright-only permission — that they did not hold before,
 * unless the actor holds it outright too. Null when the change may go.
 *
 * User admin is gated with `canAnywhere`, which is scope-blind on purpose, so a "*" confined to one
 * server passes it. Without this, that server's admin could hand out a global "*" — through a grant,
 * a role, a role assignment, a Discord role mapping or Discord management — and own everything, every
 * plugin's outright permissions included.
 *
 * It judges the EFFECTIVE result, `before` against `after`, never the rows. Rows mislead both ways:
 * lifting a `none` veto adds no row yet confers what the veto held back (an owner's lockout, or an
 * outright permission kept from a global-read auditor), while turning a global "*" from write down to
 * read is a "new" row that confers nothing. Re-saving what someone already holds is never refused,
 * and nor is taking power away.
 */
export function outrightGain(actor: Grant[], before: Grant[], after: Grant[]): string | null {
  for (const { capability, level } of outrightPowers(before, after)) {
    if (!holdsOutright(after, capability, level) || holdsOutright(before, capability, level)) continue;
    if (holdsOutright(actor, capability, level)) continue;
    return capability === "*"
      ? `only someone who holds every permission on every server (at ${level}) can grant that everywhere`
      : `only someone who holds ${capability} on every server can grant it`;
  }
  return null;
}

/**
 * Refuses acting ON an account — resetting its password, signing it out, merging or deleting it —
 * that holds an outright power the actor does not. Null when the actor may.
 *
 * Taking over an account is holding what it holds: a user admin who could reset the owner's password
 * could sign in as the owner. So the line outrightGain draws for handing power out is drawn for
 * reaching it this way too, and only an owner can do these things to an owner.
 */
export function outrightTargetRefusal(actor: Grant[], target: Grant[]): string | null {
  for (const { capability, level } of outrightPowers(target)) {
    if (holdsOutright(target, capability, level) && !holdsOutright(actor, capability, level)) {
      return "this account holds permissions on every server that you do not — only someone who holds them too can do that";
    }
  }
  return null;
}

/** The grants a set of role assignments confers — each role's bundle at the scope it is assigned (a
 *  role assigned to one server confers nothing everywhere), under its own source, exactly as
 *  resolveAccess projects it. */
export function assignmentGrants(assignments: RoleAssignment[], roles: RoleRow[]): Grant[] {
  const byId = new Map(roles.map((r) => [r.id, r]));
  return assignments.flatMap((a) => {
    const role = byId.get(a.roleId);
    return role ? roleGrants(role, a.scopeId) : [];
  });
}

/** Validate a role bundle from a request body → clean grants/limits or an error string. */
export function parseRoleBundle(
  body: Record<string, unknown>,
  held: readonly { capability: string; level: string }[] = [],
): { grants?: { capability: string; level: "none" | "read" | "write" }[]; limits?: Record<string, number>; error?: string } {
  const out: ReturnType<typeof parseRoleBundle> = {};
  if (body.grants !== undefined) {
    if (!Array.isArray(body.grants)) return { error: "grants must be an array" };
    const known = new Set(capabilityCatalog().map((c) => c.key));
    // A permission nothing loaded declares — a plugin's, while it isn't running — stays where the
    // role already carries it, exactly so (the editor sends back every row); nothing new names it.
    const kept = new Set(held.map((g) => `${g.capability}|${g.level}`));
    const seen = new Set<string>();
    out.grants = [];
    for (const g of body.grants as Record<string, unknown>[]) {
      const capability = str(g.capability).trim();
      const level = str(g.level) as "none" | "read" | "write";
      if (capability !== "*" && !known.has(capability) && !kept.has(`${capability}|${level}`)) return { error: `unknown capability: ${capability}` };
      if (!["none", "read", "write"].includes(level)) return { error: "level must be none, read or write" };
      if (seen.has(capability)) continue;
      seen.add(capability);
      out.grants.push({ capability, level });
    }
  }
  if (body.limits !== undefined) {
    if (typeof body.limits !== "object" || body.limits === null || Array.isArray(body.limits)) return { error: "limits must be an object" };
    const knownLimits = new Set(LIMIT_CATALOG.map((l) => l.key));
    out.limits = {};
    for (const [k, v] of Object.entries(body.limits as Record<string, unknown>)) {
      if (!knownLimits.has(k)) return { error: `unknown limit: ${k}` };
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { error: `limit ${k} must be a positive number` };
      out.limits[k] = n;
    }
  }
  return out;
}

/** Admin actions exposed to the panel/API, mapped to logical RCON commands + required fields.
 *  Every one is a WRITE, so the engagement guard blocks them on `observe` servers automatically. */
/** A VIP grant is permanent (null), until an absolute instant, or a duration (optionally added
 *  onto an existing future expiry — "cumulative", like CRCON). Returns the ISO expiry or null.
 *  Throws a Validation error on bad input. `existing` is the current per-server expiry (or null). */
/**
 * The longest span any of these durations may name: a century.
 *
 * `new Date(x).toISOString()` does not saturate — past ±8.64e15 ms it throws a RangeError. So a VIP
 * grant of `days: 1e12`, a temp ban of `hours: 1e13` and a trim of `olderThanDays: 1e12` each
 * answered a permission-checked request with a 500 and a stack trace instead of "that is not a
 * duration". A century is longer than anything anyone means by these and leaves the arithmetic far
 * inside what a Date can hold, so the bound can be stated once and reused.
 */
export const MAX_DURATION_MS = 100 * 365 * 24 * 3_600_000;

/** True when `ms` is a duration this system is willing to treat as one. */
export const isSaneDuration = (ms: number): boolean => Number.isFinite(ms) && ms > 0 && ms <= MAX_DURATION_MS;

/** The same bound, expressed in the unit the ban routes take from the request body. */
export const MAX_BAN_HOURS = MAX_DURATION_MS / 3_600_000;

/**
 * A ban length in hours from a request body.
 *
 * Four routes read this field and four read it differently. Only one of them bounded it:
 *
 *   - the group bulk action did `Number(body.hours ?? 0)` and then `!(hours > 0)`, which refuses
 *     NaN (NaN > 0 is false) but accepts Infinity, because Infinity > 0 is true;
 *   - the single-player and bulk action routes on a server did `Number(body.hours ?? 0)` with no
 *     check at all, so `"abc"` reached the game client as NaN and `1e30` reached it as 1e30;
 *   - the per-role cap that is supposed to catch the large case reads
 *     `Number.isFinite(max) && hours > max`, so it does nothing at all when the actor's cap is
 *     unlimited — which is exactly the actor most able to send a silly number.
 *
 * Absent (or empty) means zero, because these routes share one body shape across every action and
 * only the ban actions look at this field; the caller decides whether zero is acceptable.
 *
 * Throws rather than returning an error so it reads like `boundedText`, the sibling helper for the
 * other free-form field these routes take — the route handler turns an AppError into a 400.
 */
export function parseHours(v: unknown, field = "hours"): number {
  if (v === undefined || v === null || v === "") return 0;
  // Only a number or a numeric string. `Number()` alone is too generous to trust with a ban length:
  // Number([]) is 0 and Number([5]) is 5, so a JSON array would coerce to a duration rather than be
  // refused — the kind of input that reaches this from a hand-rolled client, not from the panel.
  if (typeof v !== "number" && typeof v !== "string") throw errors.badRequest(`${field} must be a number`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw errors.badRequest(`${field} must be a number`);
  if (n < 0) throw errors.badRequest(`${field} cannot be negative`);
  if (n > MAX_BAN_HOURS) throw errors.badRequest(`${field} may be at most ${MAX_BAN_HOURS} (100 years)`);
  return n;
}

/**
 * The actor's per-role temp-ban cap, checked against a length they asked for.
 *
 * Returns the refusal message, or null when it is allowed. Three routes built the identical
 * message from the identical comparison; the wording of a refusal is part of the contract, so it
 * belongs in one place rather than three that can drift.
 */
export async function tempbanRefusal(repo: Repository, p: Principal, serverId: string, hours: number): Promise<string | null> {
  const max = await tempbanMaxHours(repo, p, serverId);
  return Number.isFinite(max) && hours > max ? `your temp-ban limit is ${max}h (asked for ${hours}h)` : null;
}

/**
 * Shared expiration math for panel-owned grants (VIP, console admins): the game only knows
 * permanent entries, so the expiry lives with us and the worker sweep enforces it.
 *
 * `existing` is the CURRENT GRANT ROW, or null when there is none — not its expiration. The
 * difference is the whole point. A permanent grant carries `expiration: null`, and so does the
 * absence of a grant, so a function handed only the expiration cannot tell "this player has VIP
 * forever" from "this player has no VIP". It used to be handed exactly that, and read the first as
 * the second: buying 30 days of VIP on top of permanent VIP replaced forever with a date a month
 * out. The member paid points to have their VIP taken away, and the audit line recorded it as an
 * ordinary grant.
 */
export function computeGrantExpiration(body: Record<string, unknown>, existing: { expiration: string | null } | null | undefined): string | null {
  const mode = str(body.mode) || (body.expiresAt ? "until" : body.days || body.hours ? "duration" : "permanent");
  if (mode === "permanent") return null;
  if (mode === "until") {
    const t = Date.parse(str(body.expiresAt));
    if (Number.isNaN(t)) throw errors.badRequest("mode 'until' requires a valid expiresAt datetime");
    // A past date is a typo, not a decision. Accepting it created a grant that was already
    // expired: the game was told AddVip, the next sweep (two minutes later) told it RemoveVip,
    // and staff got a "VIP expired" audit line for a grant they watched themselves make —
    // a wrong-year date-picker slip dressed up as the app misbehaving. The minute of slack
    // covers clock skew between browser and server, nothing more.
    if (t <= Date.now() - 60_000) throw errors.badRequest("expiresAt is in the past — pick a future date, or use mode 'permanent'");
    return new Date(t).toISOString();
  }
  if (mode === "duration") {
    const days = Number(body.days ?? 0);
    const hours = Number(body.hours ?? 0);
    const addMs = (days * 24 + hours) * 3_600_000;
    if (!(addMs > 0)) throw errors.badRequest("mode 'duration' requires a positive days/hours");
    if (!isSaneDuration(addMs)) throw errors.badRequest("that duration is too long — a grant may run at most 100 years");
    // Stacking onto permanent leaves permanent. There is no date to add days to, and the only
    // finite answer available is one that ENDS a grant that was never going to — which is a
    // downgrade, not an extension. Adding time never subtracts any.
    //
    // Only when stacking: an explicit "set to 30 days" with the stack box cleared is staff
    // deliberately replacing the grant, and replacing permanent with a date is theirs to decide.
    if (body.cumulative && existing && existing.expiration === null) return null;
    const now = Date.now();
    const prior = existing?.expiration ?? null;
    const future = prior && Date.parse(prior) > now ? Date.parse(prior) : now;
    const base = body.cumulative ? future : now; // cumulative stacks onto a still-valid grant
    return new Date(base + addMs).toISOString();
  }
  throw errors.badRequest(`unknown expiration mode '${mode}'`);
}

/**
 * The comment every VIP a person adds must carry: who paid, what for, which event. Players pay real
 * money for VIP, and a grant nobody wrote a word about is one nobody can account for later — so a
 * grant typed in the panel or the Discord panel is refused without one, wherever it is typed (the
 * VIP editor, the VIPs page, a request line, a Live selection, a group). Automated grants (rewards,
 * purchases, payouts, rules) write their own, and a request filed before this lands as it was filed.
 */
export const VIP_COMMENT_REQUIRED = "a comment is required for every VIP added — say who paid, what for, or which event";
export function requiredVipComment(v: unknown): string {
  const comment = boundedText(v, TEXT_MAX.note, "comment");
  if (!comment) throw errors.badRequest(VIP_COMMENT_REQUIRED);
  return comment;
}

/**
 * A VIP grant aimed at SEVERAL players — a group, a Live-view selection — never cuts anyone's time.
 * "Replace" (stacking off) or a fixed date means "at least this long", not "exactly this long":
 * aimed at one named person in the VIP editor, shortening is a deliberate edit, but across a list
 * it silently takes days off whoever already had more — time players may have paid for.
 */
export function neverShorter(existing: { expiration: string | null } | null | undefined, expiration: string | null): string | null {
  if (expiration === null) return null;
  const prior = existing?.expiration ? Date.parse(existing.expiration) : NaN;
  return Number.isFinite(prior) && prior > Date.parse(expiration) ? existing!.expiration : expiration;
}

/** When the API last sent each server a command that changes something, by server id (epoch ms).
 *  The Live page does not answer from a read the worker took before it (servers.ts sharedLiveRead):
 *  a roster read a second before a kick still lists the player just kicked. */
const lastWriteAt = new Map<string, number>();
export const lastGameWriteAt = (serverId: string): number => lastWriteAt.get(serverId) ?? 0;

/** A server's game client, configured from its stored connection row. Every route that talks to
 *  the game builds its client here — one place to change how clients are constructed. A command
 *  the game's table does not list as a read is noted in lastGameWriteAt once it is done, answered
 *  or not. */
export function gameClientFor(server: ServerRow) {
  const client = createServerClient({ protocol: server.protocol, engagementMode: server.engagementMode, commands: getGame(server.game)?.commands, lineKey: getGame(server.game)?.logLineKey });
  const execute = client.execute.bind(client);
  const raw = client.raw.bind(client);
  const noted = <T>(sent: Promise<T>): Promise<T> => sent.finally(() => { lastWriteAt.set(server.id, Date.now()); });
  client.execute = (command, params) => (client.commands[command]?.access === "read" ? execute(command, params) : noted(execute(command, params)));
  client.raw = (input) => noted(raw(input));
  return client;
}

/** …and the matching connect call (same shape everywhere: host/port/password + transport options). */
export async function connectGameClient(client: ReturnType<typeof createServerClient>, server: ServerRow) {
  try {
    const result = await client.connect({ host: server.host, port: server.port, password: server.password, headerMode: server.headerMode ?? "magic", crconBaseUrl: server.crconBaseUrl ?? undefined });
    void healthRepo?.servers.recordContact(server.id, { ok: true }).catch(() => {});
    return result;
  } catch (err) {
    void healthRepo?.servers.recordContact(server.id, { ok: false, error: (err as Error).message }).catch(() => {});
    throw err;
  }
}
/**
 * The repository the connect helper reports server reachability to, set once when the app context
 * is built. A module-level handle rather than a parameter because the helper is called from three
 * dozen places that have no business knowing about health bookkeeping — and because a health
 * signal that each caller has to opt into is one that silently stops covering new code.
 */
let healthRepo: Repository | null = null;
export function setHealthRepo(repo: Repository): void { healthRepo = repo; }

/**
 * Does this server actually hold the ban we are about to lift?
 *
 * An unban is the one admin action that CANNOT fail loudly. Every other command is about a player
 * connected right now, so a wrong id produces a visible nothing and somebody notices.
 * `RemoveTemporaryBan` / `RemovePermanentBan` take an id and drop the matching entry; handed an id
 * that matches no entry, the server does exactly what it was asked, finds nothing, and answers 200.
 * The panel then says "Unbanned", the ban list still holds the ban, and the player still cannot
 * join. Nothing anywhere in the stack can tell that apart from success.
 *
 * Ids from the wrong namespace are how it happens in practice. Every other write path refuses those
 * up front (`wrongGameIdError`), but unbans are deliberately exempt on both action routes: a ban
 * recorded under an id we would now reject — a pre-Vietnam decision, a CRCON-era import, something
 * typed by hand — has to stay liftable, and refusing by SHAPE would strand it forever. So the check
 * here is by FACT instead: ask the server what it holds, and let anything it really lists through
 * whatever its id looks like.
 *
 * Checked before the command rather than after it, because "after" cannot see this failure at all:
 * an id that was never in the list is not in the list afterwards either, which reads as a clean
 * lift.
 *
 * ## When this stays quiet
 *
 * Only a ban list we can positively READ is evidence. Protocols that do not expose a structured one
 * answer `[]` — legacy-text returns raw text, the bridge is read-only — and so does a server that
 * genuinely holds no bans. Those are indistinguishable from here, so an empty list means "no
 * evidence" and the unban proceeds untouched. Refusing on an empty list would break unbans on every
 * legacy-text server to catch a mistake on the servers that can already answer for themselves.
 *
 * Returns the refusal message, or null to proceed.
 */
export class UnbanTargetMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnbanTargetMissing";
  }
}

export async function unbanTargetMissing(
  client: ReturnType<typeof createServerClient>,
  server: { game: string },
  action: string,
  playerId: string,
): Promise<string | null> {
  const kind = action === "unban_perma" ? "perma" : "temp";
  let listed: { playerId: string }[] | null;
  try {
    listed = normalizeGameBans(await client.execute(kind === "perma" ? "getPermaBans" : "getTempBans"), kind);
  } catch {
    listed = null; // the read failed; we know nothing, so we block nothing
  }
  return unbanTargetMissingIn(listed, server, action, playerId);
}

/**
 * The judgement half of `unbanTargetMissing`, over an already-read list — so a BULK unban reads
 * the server's list once for two hundred players instead of two hundred times. `null`/empty list
 * still means "no evidence, block nothing" (see above).
 */
export function unbanTargetMissingIn(
  listed: { playerId: string }[] | null,
  server: { game: string },
  action: string,
  playerId: string,
): string | null {
  if (!listed || !listed.length) return null; // unreadable or empty — no evidence either way
  const kind = action === "unban_perma" ? "perma" : "temp";
  const id = playerId.trim();
  if (listed.some((b) => b.playerId.trim() === id)) return null;

  // The server can list its bans, and this is not one of them. The id's namespace is nearly always
  // the reason, so say so — "it didn't work" alone just has staff clicking the button again.
  const namespaceHint = wrongGameIdError(server, id);
  return namespaceHint
    ? `this server holds no ${kind} ban under ${id}, and would have reported the lift as done. ${namespaceHint}`
    : `this server holds no ${kind} ban under ${id} — it lists ${listed.length} ${kind} ban(s) and none of them is that id. Lifting it here would report success and change nothing. Check the id against the server's own list (Bans → Live), which shows the ids it recognises.`;
}

/**
 * After the 200: is the ban STILL on the server's list?
 *
 * `unbanTargetMissing` above catches the id that was never there; this catches the other lie —
 * the server matched the command, answered 200, and kept the entry anyway. Nothing else in the
 * stack can see that: the response is a success, and the panel would stamp the decision lifted
 * while the player stays locked out.
 *
 * Same evidence rules as the pre-check, in reverse: only a list we can positively READ convicts.
 * An unreadable post-read (legacy text answers raw strings; the read can simply fail) is silence,
 * not proof, and must not turn every successful unban on those servers into a reported failure.
 * And because the list read races the server's own removal, a first sighting gets one grace pause
 * before convicting — a lift that actually landed must never be failed by a stale read.
 *
 * Returns the refusal message, or null when the lift held (or could not be checked).
 */
export async function unbanStillListed(
  client: ReturnType<typeof createServerClient>,
  action: string,
  playerId: string,
  retryDelayMs = 750,
): Promise<string | null> {
  const kind = action === "unban_perma" ? "perma" : "temp";
  const id = playerId.trim();
  const read = async (): Promise<{ playerId: string }[] | null> => {
    try {
      return normalizeGameBans(await client.execute(kind === "perma" ? "getPermaBans" : "getTempBans"), kind);
    } catch {
      return null; // the read failed; we know nothing, so we claim nothing
    }
  };
  const still = (listed: { playerId: string }[] | null) => listed !== null && listed.some((b) => b.playerId.trim() === id);
  if (!still(await read())) return null;
  await new Promise((r) => setTimeout(r, retryDelayMs));
  if (!still(await read())) return null;
  return `the server answered as if the lift succeeded, but its ${kind}-ban list still holds ${id}. Nothing was recorded as lifted. Check the entry on Bans → Live and lift it from there — if it keeps coming back, the game server itself is refusing to drop it.`;
}

/** Effective temp-ban hour cap for this principal on this server (Infinity = no cap; owners are
 *  never limited). Union rule: each source that allows the action contributes its cap (or
 *  unlimited if it sets none) and the most permissive wins. Used by the single action route AND
 *  bulk group actions, so a per-role hour limit can't be dodged by banning through a group. */
export async function tempbanMaxHours(repo: Repository, p: Principal, serverId: string): Promise<number> {
  // No separate "*" test: can() already treats a wildcard grant as matching any capability, and
  // unlike a bare scan for "*" it honours the grant's scope. A wildcard confined to another
  // server must not lift the cap here.
  const candidates: number[] = [];
  if (can(p.personalGrants, "action.tempban", "write", { serverId })) {
    candidates.push((await repo.userLimits.get(p.user.id))["tempban.maxHours"] ?? Infinity);
  }
  // Walk the ASSIGNMENTS, not the distinct roles: a role held only on another server allows
  // nothing here, so its hour cap must not join the union and raise the ceiling.
  const byId = new Map(p.roles.map((r) => [r.id, r]));
  for (const a of p.assignments) {
    const r = byId.get(a.roleId);
    if (!r) continue;
    if (can(roleGrants(r, a.scopeId), "action.tempban", "write", { serverId })) candidates.push(r.limits["tempban.maxHours"] ?? Infinity);
  }
  return candidates.length ? Math.max(...candidates) : Infinity;
}

/** The game module's editable settings, keyed by field — the config editor is descriptor-driven,
 *  so this holds no per-game data. */
export function configFieldsFor(game: string) {
  return new Map((getGame(game)?.descriptor.configFields ?? []).map((f) => [f.field, f]));
}

/** Pull a scalar out of a v2 getter response: `{ key: value }`, or the value itself if primitive. */
export function extractConfigValue(result: unknown, key: string): unknown {
  if (result && typeof result === "object" && key in (result as Record<string, unknown>)) return (result as Record<string, unknown>)[key];
  // The same key in another case ("Enable" for "enable"): the wire is not consistently cased, and
  // a getter that answered in the other one read as "unknown" on the settings page.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const hit = Object.keys(result as Record<string, unknown>).find((k) => k.toLowerCase() === key.toLowerCase());
    if (hit !== undefined) return (result as Record<string, unknown>)[hit];
  }
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "string") return result;
  return null;
}

/** Sum CPU idle+total ticks across cores (for a delta-based busy%). */
export function cpuTicks(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
  return { idle, total };
}

/** Host metrics for the machine the panel runs on (self-hosted box / VPS). */
export async function hostMetrics(): Promise<Record<string, unknown>> {
  const a = cpuTicks();
  await new Promise((r) => setTimeout(r, 120));
  const b = cpuTicks();
  const idleD = b.idle - a.idle, totalD = b.total - a.total;
  const cpuPct = totalD > 0 ? Math.round((1 - idleD / totalD) * 100) : 0;

  const totalMem = os.totalmem(), freeMem = os.freemem();
  const memory = { usedBytes: totalMem - freeMem, totalBytes: totalMem, pct: Math.round((1 - freeMem / totalMem) * 100) };

  let disk: { usedBytes: number; totalBytes: number; pct: number } | null = null;
  try {
    const s = await statfs("/");
    const totalBytes = s.blocks * s.bsize, freeBytes = s.bfree * s.bsize;
    if (totalBytes > 0) disk = { usedBytes: totalBytes - freeBytes, totalBytes, pct: Math.round((1 - freeBytes / totalBytes) * 100) };
  } catch { /* statfs unavailable — omit disk */ }

  return {
    online: true,
    cpuPct,
    memory,
    disk,
    uptimeSec: Math.round(os.uptime()),
    hostname: os.hostname(),
    node: process.version,
    appVersion: process.env.APP_VERSION ?? null,
    // Baked into the image by the start scripts (compose build arg → Dockerfile ENV). `||`, not
    // `??`: a manual `docker compose` run bakes an empty string, which is "no stamp", not a stamp.
    appCommit: process.env.APP_COMMIT || null,
  };
}

// Each admin action is its own fine-grained capability — a role can allow kicks but not bans.
export const ADMIN_ACTIONS: Record<string, { command: string; needs: string[]; cap: string }> = {
  message: { command: "messagePlayer", needs: ["playerId", "message"], cap: "action.message" },
  kick: { command: "kickPlayer", needs: ["playerId"], cap: "action.kick" },
  // A punish REQUIRES a reason where a kick does not: the game's kick notice gets our
  // "YOU HAVE BEEN KICKED" header (see ACTION_NOTICE_HEADER), so a blank kick still reads as a
  // complete message — but the punish screen renders only what we send, and a blank one shows the
  // player a penalty with no explanation. That exact screen reached a player and cost staff an
  // evening of "was that us?"; every surface now has to say why.
  punish: { command: "punishPlayer", needs: ["playerId", "reason"], cap: "action.punish" },
  tempban: { command: "tempBanPlayer", needs: ["playerId", "hours"], cap: "action.tempban" },
  permaban: { command: "permaBanPlayer", needs: ["playerId"], cap: "action.permaban" },
  unban_temp: { command: "removeTempBan", needs: ["playerId"], cap: "action.unban" },
  unban_perma: { command: "removePermaBan", needs: ["playerId"], cap: "action.unban" },
  switch: { command: "switchTeamNow", needs: ["playerId"], cap: "action.switch" },
  switch_death: { command: "switchTeamOnDeath", needs: ["playerId"], cap: "action.switch_death" },
};

// "note" touches nobody in game: the firing is recorded (audit + optional Discord ping) and that
// is the whole action — what an admin-camera or "watched thing happened" rule wants.
//
// "switch" moves the player to the other team now; "tag" puts a profile tag on them (which other
// rules can then gate on); "points" pays community points to their linked Discord account.
export const RULE_ACTIONS = new Set(["message", "kick", "punish", "tempban", "permaban", "blacklist", "vip", "note", "switch", "tag", "points"]);
/**
 * How many steps a rule's ladder may have after its first action. Offences are remembered per
 * player for the rule's forget window, through a kick and a rejoin, and once the ladder runs out
 * its last step repeats: with four steps, "message, message, punish, punish, kick" kicked the same
 * rejoining player over and over, with no room left to go on to a ban. Nine leaves that room
 * (ten offences in all). The rule editor offers steps up to the same number
 * (apps/panel/lib/ruleLadder.ts), and a panel test holds the two together.
 */
export const MAX_ESCALATION_STEPS = 9;
/*
 * A rule whose action is VIP hands out something players pay for, on its own, for as long as it
 * runs — so saving one takes the VIP grant power (on the rule's server, or everywhere for a
 * community-wide rule), not just rule editing. Switching one OFF stays with rule editors: that
 * only ever stops grants, and it is what someone reaching for the brakes needs to be able to do.
 */
function canGrantVipByRule(grants: Parameters<typeof can>[0], serverId: string | null | undefined): boolean {
  return can(grants, "vip.grant", "write", serverId ? { serverId } : {});
}

/**
 * The keys a rule's OWN powers need beyond rule editing, as the capability a save is missing (null
 * = none). VIP above; paying points mints currency, which is what the bulk-payout key guards; and
 * a tag is a label staff otherwise need the tag key to write — and one other rules can gate on.
 */
export function ruleKeyMissing(grants: Parameters<typeof can>[0], rule: { action: string; escalateActions?: string[]; serverId?: string | null }): string | null {
  const steps = [rule.action, ...(rule.escalateActions ?? [])];
  if (steps.includes("vip") && !canGrantVipByRule(grants, rule.serverId)) return "vip.grant";
  // A schedule that takes VIP away (revoke, cut back) is a standing revoke: the revoke key, on the
  // rule's server or everywhere for a community-wide one — what a person needs to do it by hand.
  if (steps.some((a) => SCHEDULE_TAKING_ACTIONS.has(a)) && !can(grants, "vip.revoke", "write", rule.serverId ? { serverId: rule.serverId } : {})) return "vip.revoke";
  if (steps.includes("points") && !can(grants, "economy.payout", "write")) return "economy.payout";
  if (steps.includes("tag") && !can(grants, "player.tags", "write")) return "player.tags";
  return null;
}

/** Perks, not steps: a rule cannot escalate INTO one, and one cannot escalate. */
const PERK_ACTIONS = new Set(["vip", "points"]);
/** The most a "grant points" rule may pay per firing. */
export const RULE_POINTS_MAX = 100_000;

/** Rule triggers the log does not emit under that name — see parseRuleBody for what each means. */
export const RULE_SYNTHETIC_KINDS = new Set(["app.idle", "app.death", "app.teamdeath", "app.admincam.enter", "app.admincam.exit"]);

/**
 * The actions that may name MORE THAN ONE server in a single call (`serverIds`).
 *
 * Bans and only bans. A ban is a standing decision about whether someone is welcome, and staff
 * make that decision about the community rather than about one address — but the game stores it
 * per server, so acting on all of them has to be one deliberate request or it gets half-done.
 * Everything else here happens to a player who is connected RIGHT NOW: kicking, punishing or
 * messaging someone on a server they are not on is not a stricter version of the action, it is
 * nothing at all.
 */
export const FANOUT_ACTIONS = new Set(["tempban", "permaban", "unban_temp", "unban_perma"]);

/**
 * A function that signs one action's player-facing text, ready to apply to every field that
 * reaches the game.
 *
 * Built once per request rather than per field or per target: a bulk kick of two hundred players
 * is one config read, and every one of those players sees exactly the same wording. Returning a
 * closure instead of the config keeps the "which half does THIS action want" decision in one place
 * — the call sites just wrap their text.
 *
 * The staff name is the PANEL name (Discord nick, then Discord handle, then username), never the
 * acting admin's in-game alias: half the staff play under something nobody recognises, and the
 * point of signing is to be recognised.
 *
 * Pass a NAME rather than a principal where the signature belongs to somebody other than the
 * account making the call — an approved request signs with the REQUESTER's name, because the
 * action is theirs and they are the one the player will come back to about it.
 */
export interface Signer {
  (text: string): string;
  /** Characters this signature adds to a non-empty body, so a caller can bound the whole string. */
  readonly overhead: number;
}

export async function signerFor(ctx: AppContext, action: string, p: Principal | string): Promise<Signer> {
  const cfg = await ctx.repo.signatures.get();
  const use = signatureUseFor(cfg.actions, action);
  const plain = Object.assign((text: string) => text, { overhead: 0 });
  if (!use.staff && !use.custom) return plain; // nothing to add; skip the work entirely
  const staffName = typeof p === "string" ? p : displayNameOf(p.user);
  const sign = (text: string) => applySignature(text, { ...cfg, use, staffName });
  // Measured against a one-character body rather than derived from the config, so the arithmetic
  // cannot drift from applySignature's own rules about blank halves and separators.
  return Object.assign(sign, { overhead: sign("x").length - 1 });
}

/**
 * The opening line the GAME does not write for itself.
 *
 * Hell Let Loose heads its own notice for some actions and not others: a perma ban arrives as
 * "PERMANENTLY BANNED BY THE ADMINISTRATOR!" above whatever the admin typed, but a kick arrives as
 * the bare reason with no indication of what just happened. A player kicked with "stop blocking the
 * spawn" reads a notice that could equally be an admin message and never learns they were removed;
 * the appeal line underneath then makes no sense either. So we write the missing header ourselves.
 *
 * Only for actions the game leaves bare. Adding one where the game already prints its own would
 * say it twice, which is why this is a table of exceptions rather than a line for every action.
 */
export const ACTION_NOTICE_HEADER: Record<string, string> = {
  kick: "YOU HAVE BEEN KICKED",
};

/**
 * A player-facing field, bounded so that the SIGNED string still fits, then signed.
 *
 * The bound and the signature were applied in the wrong order: the typed reason was checked against
 * its 500-character limit and the signature was appended afterwards, so a long reason plus both
 * lines reached the game at nearly a thousand characters. The game truncates without telling
 * anybody, and because the signature sits at the end, the part it cuts is the appeal link — the one
 * piece of a ban message that exists to be read.
 *
 * Refused rather than silently trimmed, because a staff member who is 40 characters over can shorten
 * their own wording; nobody can recover a message the game already ate. The limit in the message is
 * the real one, and it says why it shrank.
 */
export function signedText(sign: Signer, v: unknown, field: string, max = TEXT_MAX.reason, header = ""): string {
  // The header is part of what reaches the game, so it eats into the same budget as the signature.
  // Counted here rather than glued on afterwards, for exactly the reason the signature is: text
  // appended after the bound is text the game silently truncates.
  const lead = header ? `${header}\n` : "";
  const room = Math.max(0, max - sign.overhead - lead.length);
  const s = str(v).trim();
  if (s.length > room) {
    const because = [sign.overhead ? `the ${sign.overhead}-character signature` : "", lead ? `the "${header}" line` : ""].filter(Boolean).join(" and ");
    throw errors.badRequest(because
      ? `${field} is too long (max ${room} characters once ${because} ${because.includes(" and ") ? "are" : "is"} added)`
      : `${field} is too long (max ${room} characters)`);
  }
  // An empty body still gets the header — "you were kicked" with no stated reason is a complete
  // message, and it is the one the player most needs. The signature keeps its own blank rules.
  return s || lead ? sign(`${lead}${s}`) : "";
}

/** Validate + normalize an enforcer rule request body. */
export function parseRuleBody(body: Record<string, unknown>): { value: NewRule } | { error: string } {
  const name = boundedText(body.name, TEXT_MAX.name, "rule name");
  const eventKind = str(body.eventKind).trim();
  const action = str(body.action).trim();
  if (!name) return { error: "name is required" };
  /*
   * Synthetic kinds are the ones the log does not produce as such:
   *   app.idle           — the ABSENCE of kills over a window (a clock, not an event);
   *   app.death          — a kill event read from the victim's end;
   *   app.teamdeath      — a team-kill event read from the victim's end;
   *   app.admincam.enter — an admin-camera event, ENTRIES only;
   *   app.admincam.exit  — the same event, EXITS only (evt.admin.camera itself fires on both).
   * Everything else must be a real evt.* kind.
   */
  // Beyond the log's own evt.* kinds and the synthetic readings of them, a rule can fire on a
  // roster STATE the worker detects each tick (app.state.* — solo tank, no squad leader, level,
  // role, name) or on a restricted-weapon kill (judged inline by the enforcer). Their knobs ride
  // on the rule as `params`, validated below against the trigger's own schema.
  const stateKind = isStateTriggerKind(eventKind) && STATE_TRIGGERS.some((t) => t.kind === eventKind);
  // A player added to or removed from a player group (Players → Groups): fired by the enforcer
  // as it drains the store's membership queue, on the servers of the member's own game.
  const groupKind = isGroupTriggerKind(eventKind);
  // On the calendar (the 1st of every month, every Saturday…), acting on every member of a group:
  // run by the enforcer's schedule clock, never by an event.
  const scheduleKind = eventKind === SCHEDULE_KIND;
  if (!eventKind.startsWith("evt.") && !RULE_SYNTHETIC_KINDS.has(eventKind) && !stateKind && eventKind !== WEAPON_TRIGGER_KIND && !groupKind && !scheduleKind) {
    return { error: `eventKind must be an evt.* kind (e.g. evt.teamkill), one of ${[...RULE_SYNTHETIC_KINDS].join(", ")}, a state trigger (${STATE_TRIGGERS.map((t) => t.kind).join(", ")}), ${WEAPON_TRIGGER_KIND}, a group trigger (${GROUP_JOINED_KIND}, ${GROUP_LEFT_KIND}), or ${SCHEDULE_KIND}` };
  }
  // A schedule acts on a whole group's VIP and nothing else; its taking actions exist nowhere else.
  if (scheduleKind && !SCHEDULE_ACTIONS.has(action)) {
    return { error: "a schedule acts on its group's VIP: grant it (vip), take timed VIP away (viprevoke), cut it back to a span (viptrim), or cut it back by an amount (vipreduce)" };
  }
  if (!RULE_ACTIONS.has(action) && !scheduleKind) return { error: `action must be one of ${[...RULE_ACTIONS].join(", ")}` };
  // The event decides the action family. A player who DISCONNECTED cannot be messaged, punished
  // or kicked — the only things that make sense are VIP waiting for their return, or a note
  // (which reaches nobody by design) — and VIP for showing up (or for team-killing) is not a
  // rule anyone means.
  // Three triggers carry VIP: a crash (disconnected — VIP waiting for their return), the roster's
  // "player has no VIP" (VIP for somebody here without it) and "playtime milestone" (VIP for the
  // regulars). Anywhere else a VIP grant is a reward for whatever tripped the rule — a team kill,
  // a chat line — which is not a rule anyone means.
  if (action === "vip" && !VIP_ACTION_KINDS.has(eventKind)) {
    return { error: "the vip action only makes sense on 'player disconnected' (crash VIP), 'player has no VIP', 'playtime milestone', or a player being added to or removed from a group" };
  }
  if (groupKind && !GROUP_RULE_ACTIONS.has(action)) {
    return { error: "a group rule can grant VIP or points, add a tag, or record a note — being added to a group isn't being on a server, so a message, kick or move may reach nobody, and a ban would let anyone who edits the group ban whoever they add" };
  }
  if (eventKind === "evt.player.disconnected" && action !== "vip" && action !== "note") {
    return { error: "a disconnected player can only be granted VIP or noted — nothing else can reach them" };
  }
  const match = str(body.match).trim() || null;
  if (match) {
    try {
      new RegExp(match);
    } catch {
      return { error: "match is not a valid regular expression" };
    }
  }
  // Math.max(1, NaN) is NaN, so these needed a finiteness check of their own: a rule stored with a
  // NaN threshold never fires and shows as a number in the editor.
  const rawThreshold = Number(body.threshold ?? 1);
  const rawWindow = Number(body.windowSec ?? 0);
  if (!Number.isFinite(rawThreshold)) return { error: "threshold must be a number" };
  if (!Number.isFinite(rawWindow)) return { error: "windowSec must be a number" };
  let threshold = Math.max(1, rawThreshold);
  const windowSec = Math.max(0, rawWindow);
  if (eventKind === "app.idle") {
    if (windowSec < 60) return { error: "the no-kills window must be at least 60 seconds" };
    threshold = 1; // "no kills for the window" has no Nth occurrence to count
  }
  if (groupKind || scheduleKind) threshold = 1; // one join, or one date, is the whole event — no Nth to count
  let stateWindowSec = windowSec;
  if (stateKind) {
    // For a state trigger windowSec is the RE-CHECK cadence (how often a persisting violation
    // fires again, climbing the ladder) — the same reinterpretation app.idle already makes.
    if (stateWindowSec === 0) stateWindowSec = 60;
    if (stateWindowSec < 30) return { error: "the re-check interval must be at least 30 seconds" };
    threshold = 1; // a persisting state is paced by the interval, not counted in occurrences
  }
  /*
   * "N times within 0 seconds" can never happen, and the editor makes it easy to ask for: a blank
   * rule starts at threshold 1 / window 0, so raising the threshold and leaving the window alone
   * saved an ENABLED rule that could not fire once. The enforcer's sliding window keeps only hits
   * inside `windowSec`, so with no window nothing but a same-millisecond burst ever counts — the
   * rule sat in the list looking armed and did nothing, forever, with nothing anywhere saying why.
   * Both kinds above pin threshold to 1 and reinterpret the window, so only plain event rules
   * reach this.
   */
  // Counting per MATCH ("3 team kills in one match") is a window of its own, so it lifts the
  // rule above. Only plain event rules count occurrences — idle and state kinds pinned threshold
  // to 1 above — so on those the switch would mean nothing and is not stored.
  const countPerMatch = body.countPerMatch === true && eventKind !== "app.idle" && !stateKind && !groupKind && !scheduleKind && threshold > 1;
  if (threshold > 1 && windowSec <= 0 && !countPerMatch) {
    return { error: "a threshold above 1 needs a window — counting occurrences within 0 seconds can never fire" };
  }
  // The trigger's own knobs. Role fields are checked against the union of every registered game's
  // roles — a rule can be community-wide, so refusing another game's valid id here would make
  // "everywhere" rules impossible to save; the detector only ever meets rosters of its own game.
  const paramsParsed = parseTriggerParams(eventKind, body.params, new Set(listGames().flatMap((g) => Object.keys(getGame(g.id)?.descriptor.roles ?? {}).map(Number))));
  if ("error" in paramsParsed) return { error: paramsParsed.error };
  // The calendar itself: a schedule that can never come round is refused with the fix named.
  if (scheduleKind) {
    const calendar = recurrenceError(scheduleOf(paramsParsed.params));
    if (calendar) return { error: calendar };
  }
  const rawDelay = Number(body.delaySec ?? 0);
  if (!Number.isFinite(rawDelay) || rawDelay < 0 || rawDelay > 3600) return { error: "delaySec must be between 0 and 3600" };
  // Up to a year: a crash VIP is minutes, but the no-VIP trigger hands out days ("three days of
  // VIP for anyone here without it"). The editor picks the unit; the store keeps minutes.
  const rawVipMinutes = Number(body.vipMinutes ?? 10);
  if (!Number.isFinite(rawVipMinutes) || rawVipMinutes < 1 || rawVipMinutes > VIP_RULE_MAX_MINUTES) return { error: `vipMinutes must be between 1 and ${VIP_RULE_MAX_MINUTES} (a year)` };
  // 0 = no limit, which staff have to choose deliberately: the default is an hour because a crash
  // VIP with no cooldown can be farmed by disconnecting just before each grant expires.
  const rawVipCooldown = Number(body.vipCooldownMinutes ?? 60);
  if (!Number.isFinite(rawVipCooldown) || rawVipCooldown < 0 || rawVipCooldown > VIP_RULE_MAX_MINUTES) return { error: `vipCooldownMinutes must be between 0 and ${VIP_RULE_MAX_MINUTES} (0 = no limit)` };
  const requireRoleIds = (Array.isArray(body.requireRoleIds) ? body.requireRoleIds : []).map((x) => str(x).trim()).filter(Boolean);
  for (const id of requireRoleIds) if (!/^\d{5,25}$/.test(id)) return { error: `"${id}" is not a Discord role id` };
  // The exemptions: never act on these players. Same shapes as their positive counterparts — tags
  // are free text the tag editor writes, roles are snowflakes picked from the guild.
  const immuneTags = [...new Set((Array.isArray(body.immuneTags) ? body.immuneTags : []).map((t) => str(t).trim()).filter(Boolean))];
  if (immuneTags.length > 20) return { error: "at most 20 immune tags" };
  for (const t of immuneTags) if (t.length > TEXT_MAX.name) return { error: `immune tag "${t.slice(0, 20)}…" is too long` };
  const immuneRoleIds = [...new Set((Array.isArray(body.immuneRoleIds) ? body.immuneRoleIds : []).map((x) => str(x).trim()).filter(Boolean))];
  for (const id of immuneRoleIds) if (!/^\d{5,25}$/.test(id)) return { error: `"${id}" is not a Discord role id` };
  // A role on both lists is a contradiction the editor should never produce, and silently letting
  // one win would make the rule's behaviour depend on which check runs first.
  const contradiction = immuneRoleIds.find((id) => requireRoleIds.includes(id));
  if (contradiction) return { error: `role ${contradiction} is both required and exempt — a rule cannot fire only for a role and never for it` };
  // The positive tag gate: only players carrying one of these profile tags.
  const requireTags = [...new Set((Array.isArray(body.requireTags) ? body.requireTags : []).map((t) => str(t).trim()).filter(Boolean))];
  if (requireTags.length > 20) return { error: "at most 20 required tags" };
  for (const t of requireTags) if (t.length > TEXT_MAX.name) return { error: `required tag "${t.slice(0, 20)}…" is too long` };
  const tagClash = requireTags.find((t) => immuneTags.includes(t));
  if (tagClash) return { error: `tag "${tagClash}" is both required and exempt — a rule cannot fire only for a tag and never for it` };
  // Level exemption: 0 = off. Bounded generously — the games' own ceilings differ and rise with
  // patches, so this only refuses input that is not a level at all.
  const rawImmuneLevel = Number(body.immuneLevel ?? 0);
  if (!Number.isFinite(rawImmuneLevel) || rawImmuneLevel < 0 || rawImmuneLevel > 1000) {
    return { error: "immuneLevel must be between 0 and 1000 (0 = no level exemption)" };
  }
  // A rule.hours is the length of the ban the rule will hand out, so it gets the same bound as one
  // typed by a person. null means the action has no duration (kick, warn).
  const hours = body.hours === undefined || body.hours === null || body.hours === "" ? null : parseHours(body.hours, "hours");
  // Blank/absent = community-wide; the route checks a non-null id names a real server.
  const serverId = str(body.serverId).trim() || null;

  /**
   * The escalation ladder: follow-up actions for repeat offences, so "message, then punish, then
   * kick" is one rule rather than three kept in step by hand. The base action is always step one.
   *
   * `vip` is excluded on both ends: it is a perk with its own anti-farm cooldown, not an
   * enforcement step — a rule cannot escalate INTO handing out VIP, and a crash-VIP rule has
   * nothing to escalate.
   */
  // Bounded like the rule's name directly above: this reaches the player as the message or the ban
  // reason, and `boundedText` is the helper that already says how long such a thing may be.
  const reasonText = boundedText(body.reason, TEXT_MAX.reason, "rule reason").trim() || null;
  const escalateActions = (Array.isArray(body.escalateActions) ? body.escalateActions : []).map((a) => str(a).trim()).filter(Boolean);
  if (escalateActions.length > MAX_ESCALATION_STEPS) return { error: `at most ${MAX_ESCALATION_STEPS} escalation steps after the first action` };
  for (const a of escalateActions) {
    if (!RULE_ACTIONS.has(a) || PERK_ACTIONS.has(a)) return { error: `escalation step "${a}" must be one of ${[...RULE_ACTIONS].filter((x) => !PERK_ACTIONS.has(x)).join(", ")}` };
  }
  if (escalateActions.length && groupKind) return { error: "a group rule cannot escalate — joining or leaving a group is not an offence to repeat" };
  if (escalateActions.length && scheduleKind) return { error: "a schedule cannot escalate — it runs on the calendar, not on anything a player repeats" };
  if (escalateActions.length && action === "vip") return { error: "a VIP rule cannot escalate — VIP is a perk, not a first offence" };
  if (escalateActions.length && action === "points") return { error: "a points rule cannot escalate — points are a reward, not a first offence" };
  // Moving a player writes a team switch of its own, so a team-switch rule that moves them would
  // answer itself — back and forth, a swap counted each time, until the ladder kicked them.
  if (eventKind === "evt.player.teamSwitched" && (action === "switch" || escalateActions.includes("switch"))) {
    return { error: "a team-switch rule cannot move the player — the move is itself a team switch, and the rule would fire on its own action" };
  }
  // The tag an "add a tag" step puts on the player — needed wherever that step sits.
  const actionTag = str(body.actionTag).trim() || null;
  if ((action === "tag" || escalateActions.includes("tag")) && !actionTag) return { error: "a rule that adds a tag needs the tag to add" };
  if (actionTag && actionTag.length > TEXT_MAX.name) return { error: "the tag to add is too long" };
  // The points a "grant points" rule pays.
  const rawPoints = Number(body.points ?? 0);
  if (!Number.isFinite(rawPoints) || rawPoints < 0 || rawPoints > RULE_POINTS_MAX) return { error: `points must be between 0 and ${RULE_POINTS_MAX}` };
  if (action === "points" && !(rawPoints >= 1)) return { error: "a points rule needs the points to grant (1 or more)" };
  // A roster state holds tick after tick — a milestone stays reached — so a points rule on one
  // would pay again at every re-check. It must say how often a player may be paid.
  if (action === "points" && stateKind && !(Number(body.capCount ?? 0) >= 1)) {
    return { error: "points on a roster trigger pay again at every re-check — set \"at most N times per player\" to how often a player may be paid" };
  }
  // A tempban needs a length WHEREVER it sits on the ladder: with no hours the v2 wire sends
  // Duration 0 — a ban that holds nobody, recorded as a success — and the editor only offered
  // the hours box for a tempban FIRST action, so "message, then tempban" saved unenforceable.
  if ((action === "tempban" || escalateActions.includes("tempban")) && (hours === null || hours <= 0)) {
    return { error: "a rule that tempbans — as its first action or on escalation — needs Ban hours" };
  }
  const rawEscReset = Number(body.escalateResetMinutes ?? 120);
  if (!Number.isFinite(rawEscReset) || rawEscReset < 0 || rawEscReset > 10080) {
    return { error: "escalateResetMinutes must be between 0 and 10080 (0 = only forgets on restart)" };
  }

  /*
   * Active hours: when this rule may fire (null/absent = always). Validated hard at save time
   * because the runtime window engine deliberately fails CLOSED on junk — a mistyped start would
   * silently turn the rule off rather than error, which is the failure mode nobody notices until
   * a night of it. Overnight windows (start > end) are legal and wrap midnight; equal bounds are
   * refused because "active from 22:00 to 22:00" reads as all-day to the engine and as a typo to
   * everyone else — leaving active hours off is how "always" is said.
   */
  let activeHours: NewRule["activeHours"] = null;
  if (body.activeHours !== undefined && body.activeHours !== null) {
    const raw = body.activeHours;
    if (typeof raw !== "object" || Array.isArray(raw)) return { error: "activeHours must be an object { start, end, daysOfWeek?, timezone? }" };
    const ah = raw as Record<string, unknown>;
    const time = (v: unknown): string | null => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(str(v).trim());
      if (!m) return null;
      const h = Number(m[1]); const min = Number(m[2]);
      return h <= 23 && min <= 59 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
    };
    const start = time(ah.start);
    const end = time(ah.end);
    if (!start || !end) return { error: "active hours need a start and end time as HH:MM (24-hour)" };
    if (start === end) return { error: "active hours start and end are the same minute — for an always-on rule, leave active hours off" };
    const daysOfWeek = [...new Set((Array.isArray(ah.daysOfWeek) ? ah.daysOfWeek : []).map((d) => str(d).trim().toLowerCase()).filter(Boolean))];
    for (const d of daysOfWeek) {
      if (!(WEEKDAYS as string[]).includes(d)) return { error: `"${d}" is not a weekday — use ${WEEKDAYS.join(", ")}` };
    }
    const timezone = str(ah.timezone).trim();
    if (timezone) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
      catch { return { error: `"${timezone}" is not a timezone the server recognises — use an IANA name like America/New_York` }; }
    }
    activeHours = { start, end, ...(daysOfWeek.length ? { daysOfWeek } : {}), ...(timezone ? { timezone } : {}) };
  }

  // Population bounds, pairing with active hours: fire only while the server holds between
  // playersMin and playersMax players (0 = unbounded on that side).
  const rawPlayersMin = Number(body.playersMin ?? 0);
  const rawPlayersMax = Number(body.playersMax ?? 0);
  if (!Number.isFinite(rawPlayersMin) || rawPlayersMin < 0 || rawPlayersMin > 100) return { error: "playersMin must be between 0 and 100 (0 = no floor)" };
  if (!Number.isFinite(rawPlayersMax) || rawPlayersMax < 0 || rawPlayersMax > 100) return { error: "playersMax must be between 0 and 100 (0 = no ceiling)" };
  if (rawPlayersMin > 0 && rawPlayersMax > 0 && rawPlayersMin > rawPlayersMax) {
    return { error: "the population floor is above the ceiling — a window from 60 down to 40 players matches no server" };
  }
  // Minutes into the match (0 = unbounded on that side). Bounded well past any real match, like the
  // auto-settings profiles' match clock, so a typo cannot read as "never".
  const rawMatchMin = Number(body.matchMinutesMin ?? 0);
  const rawMatchMax = Number(body.matchMinutesMax ?? 0);
  if (!Number.isFinite(rawMatchMin) || rawMatchMin < 0 || rawMatchMin > 600) return { error: "matchMinutesMin must be between 0 and 600 (0 = from the start)" };
  if (!Number.isFinite(rawMatchMax) || rawMatchMax < 0 || rawMatchMax > 600) return { error: "matchMinutesMax must be between 0 and 600 (0 = to the end)" };
  if (rawMatchMax > 0 && rawMatchMax <= rawMatchMin) {
    return { error: `the match window can never be open — "before ${rawMatchMax} minutes" ends before "from ${rawMatchMin} minutes" begins` };
  }
  // The per-player cap: at most capCount firings per player per period (0 = no cap).
  const rawCapCount = Number(body.capCount ?? 0);
  if (!Number.isFinite(rawCapCount) || rawCapCount < 0 || rawCapCount > 1000) return { error: "capCount must be between 0 and 1000 (0 = no cap)" };
  const capPeriod = (str(body.capPeriod).trim() || "day") as RuleCapPeriod;
  if (!RULE_CAP_PERIODS.includes(capPeriod)) return { error: `capPeriod must be one of ${RULE_CAP_PERIODS.join(", ")}` };
  // The safety valve. Bounded, and 0 is a deliberate opt-out someone must type.
  const rawBreaker = Number(body.breakerLimit ?? 10);
  if (!Number.isFinite(rawBreaker) || rawBreaker < 0 || rawBreaker > 1000) return { error: "breakerLimit must be between 0 and 1000 (0 = no safety limit)" };

  // The rule's own alert channel (blank = the server's shared "Player rules firing" channel).
  // Same shape check as every other pasted Discord id in the app.
  const alertChannelId = str(body.alertChannelId).trim() || null;
  if (alertChannelId && !/^\d{5,25}$/.test(alertChannelId)) {
    return { error: "alertChannelId is not a Discord channel id (right-click the channel → Copy Channel ID)" };
  }

  // A group rule fires for a member who may be on no server at all, so nothing measured ON a
  // server — its player count, how far into the match it is, chat text — can gate it. Stored as
  // "off" rather than refused: the editor does not offer them for these triggers.
  const onServer = !groupKind && !scheduleKind;
  return { value: {
    name, eventKind, action, enabled: body.enabled !== false, serverId, match: onServer ? match : null, threshold, windowSec: stateKind ? stateWindowSec : onServer ? windowSec : 0,
    reason: reasonText, hours, params: paramsParsed.params,
    // A schedule acts on its group as a whole, at its own time: no wait, and no per-player gate
    // (Discord role, tag, level) — the group IS the selection.
    delaySec: scheduleKind ? 0 : Math.round(rawDelay), vipMinutes: Math.round(rawVipMinutes),
    vipCooldownMinutes: Math.round(rawVipCooldown), requireRoleIds: scheduleKind ? [] : requireRoleIds,
    immuneTags: scheduleKind ? [] : immuneTags, immuneRoleIds: scheduleKind ? [] : immuneRoleIds, immuneLevel: scheduleKind ? 0 : Math.round(rawImmuneLevel),
    // Absent = live, matching the column default: the trial switch is something an author turns
    // ON deliberately, and a client that predates it must not park every rule it saves.
    dryRun: body.dryRun === true,
    escalateActions, escalateResetMinutes: Math.round(rawEscReset),
    // Absent = on, matching the column default: a client that predates the field must not silence
    // the rule it is editing.
    alertEnabled: body.alertEnabled !== false,
    alertChannelId,
    activeHours: scheduleKind ? null : activeHours,
    playersMin: onServer ? Math.round(rawPlayersMin) : 0, playersMax: onServer ? Math.round(rawPlayersMax) : 0,
    breakerLimit: Math.round(rawBreaker),
    matchMinutesMin: onServer ? Math.round(rawMatchMin) : 0, matchMinutesMax: onServer ? Math.round(rawMatchMax) : 0,
    countPerMatch, requireTags: scheduleKind ? [] : requireTags,
    // A group rule's VIP fans out to every server of the member's game, and the per-player cap
    // counts firings across servers — it would stop at the first. Its own VIP cooldown (kept per
    // server) is the limit that fits; the cap stays for the once-per-change actions.
    capCount: (groupKind && action === "vip") || scheduleKind ? 0 : Math.round(rawCapCount), capPeriod,
    actionTag: action === "tag" || escalateActions.includes("tag") ? actionTag : null,
    points: action === "points" ? Math.round(rawPoints) : 0,
  } };
}

/** Validate a seeding-config patch. `validRoles` is the descriptor's role-id set (disallowedRoles /
 *  never-empty immuneTags are validated against it); `validWeaponClasses` / `validWeaponNames` /
 *  `validAbilities` are the game's own tables (names and abilities compared upper-cased, which is
 *  how they are stored). Only keys present in `body` are included, so a PUT can send a partial
 *  patch. */
export function parseSeedingBody(
  body: Record<string, unknown>,
  validRoles: Set<number>,
  validWeaponClasses: Set<string> = new Set(),
  validWeaponNames: Set<string> = new Set(),
  validAbilities: Set<string> = new Set(),
): { value: SeedingConfigPatch } | { error: string } {
  const patch: SeedingConfigPatch = {};
  const num = (v: unknown) => Number(v);
  const bools: (keyof SeedingConfigPatch)[] = ["enabled", "dryRun", "kickAfter", "rewardEnabled", "rewardCumulative", "capFightEnabled", "capFightSkipWarning", "containEnabled", "containAutoEnabled", "positionalEnabled", "paceEnabled", "layoutLearnEnabled"];
  for (const k of bools) if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k] === true;

  if (body.capFightMaxCaps !== undefined) {
    // CRCON's own bounds (max_caps: ge=2, le=4) — in warfare a team always holds ≥1 cap and 5 has
    // already won, so only 2–4 describe a "winning" threshold that can still be enforced.
    const v = num(body.capFightMaxCaps);
    if (!Number.isFinite(v) || v < 2 || v > 4) return { error: "capFightMaxCaps must be between 2 and 4" };
    patch.capFightMaxCaps = Math.round(v);
  }

  if (body.seedTarget !== undefined) {
    const v = num(body.seedTarget);
    if (!Number.isFinite(v) || v < 1 || v > 200) return { error: "seedTarget must be between 1 and 200" };
    patch.seedTarget = Math.round(v);
  }
  if (body.minPlayers !== undefined) {
    const v = num(body.minPlayers);
    if (!Number.isFinite(v) || v < 0) return { error: "minPlayers must be >= 0" };
    patch.minPlayers = Math.round(v);
  }
  if (patch.seedTarget !== undefined && patch.minPlayers !== undefined && patch.minPlayers >= patch.seedTarget) {
    return { error: "minPlayers must be less than seedTarget" };
  }
  if (body.paceUnlockMinutes !== undefined) {
    if (!Array.isArray(body.paceUnlockMinutes) || body.paceUnlockMinutes.length !== 5) {
      return { error: "paceUnlockMinutes must be five numbers — one unlock minute per point" };
    }
    const mins = (body.paceUnlockMinutes as unknown[]).map(num);
    for (const m of mins) if (!Number.isFinite(m) || m < 0 || m > 240) return { error: "each pace unlock must be 0\u2013240 minutes" };
    patch.paceUnlockMinutes = mins.map((m) => Math.round(m));
  }
  if (body.disallowedRoles !== undefined) {
    if (!Array.isArray(body.disallowedRoles)) return { error: "disallowedRoles must be an array of role numbers" };
    const roles = (body.disallowedRoles as unknown[]).map(num);
    for (const r of roles) if (!validRoles.has(r)) return { error: `unknown role id ${r} for this game` };
    patch.disallowedRoles = [...new Set(roles)];
  }
  if (body.disallowedWeaponClasses !== undefined) {
    if (!Array.isArray(body.disallowedWeaponClasses)) return { error: "disallowedWeaponClasses must be an array of class ids" };
    const classes = (body.disallowedWeaponClasses as unknown[]).map((c) => str(c).trim()).filter(Boolean);
    // Validated against the game's own class table, same as roles: a typo'd id would sit silent
    // in the config matching nothing, which reads as "weapon rules are on" while none apply.
    for (const c of classes) if (!validWeaponClasses.has(c)) return { error: `unknown weapon class "${c}" for this game` };
    patch.disallowedWeaponClasses = [...new Set(classes)];
  }
  if (body.disallowedWeapons !== undefined) {
    if (!Array.isArray(body.disallowedWeapons)) return { error: "disallowedWeapons must be an array of strings" };
    const subs = [...new Set((body.disallowedWeapons as unknown[]).map((w) => str(w).trim().toUpperCase()).filter(Boolean))];
    // Bounded like every list a request can grow; a 1-char substring would match most of the
    // weapon table, which is a foot-gun rather than a rule.
    if (subs.length > 40) return { error: "at most 40 extra weapon entries — use the class chips for whole families" };
    for (const w of subs) {
      if (w.length < 2) return { error: `weapon entry "${w}" is too short — one character would match nearly everything` };
      if (w.length > 40) return { error: `weapon entry "${w.slice(0, 20)}…" is longer than 40 characters` };
    }
    patch.disallowedWeapons = subs;
  }
  if (body.disallowedWeaponNames !== undefined) {
    if (!Array.isArray(body.disallowedWeaponNames)) return { error: "disallowedWeaponNames must be an array of strings" };
    const names = [...new Set((body.disallowedWeaponNames as unknown[]).map((w) => str(w).trim().toUpperCase()).filter(Boolean))];
    // Validated against the game's own weapon table, same as classes: these are PICKED, never
    // typed, so an unknown name is a bug or a stale client — not a preference to store.
    for (const n of names) if (!validWeaponNames.has(n)) return { error: `unknown weapon "${n}" for this game — pick from the weapon list` };
    patch.disallowedWeaponNames = names;
  }
  if (body.disallowedCommanderAbilities !== undefined) {
    if (!Array.isArray(body.disallowedCommanderAbilities)) return { error: "disallowedCommanderAbilities must be an array of strings" };
    const abilities = [...new Set((body.disallowedCommanderAbilities as unknown[]).map((a) => str(a).trim().toUpperCase()).filter(Boolean))];
    for (const a of abilities) if (!validAbilities.has(a)) return { error: `unknown commander ability "${a}" for this game` };
    patch.disallowedCommanderAbilities = abilities;
  }
  if (body.immuneTags !== undefined) {
    if (!Array.isArray(body.immuneTags)) return { error: "immuneTags must be an array of strings" };
    patch.immuneTags = [...new Set((body.immuneTags as unknown[]).map((t) => str(t).trim()).filter(Boolean))];
  }
  const nonNeg: [keyof SeedingConfigPatch, string][] = [
    ["immuneLevel", "immuneLevel"], ["maxWarnings", "maxWarnings"], ["warnIntervalSec", "warnIntervalSec"],
    ["maxPunishes", "maxPunishes"], ["punishIntervalSec", "punishIntervalSec"], ["minSeedMinutes", "minSeedMinutes"],
    ["rewardDelaySec", "rewardDelaySec"], ["phaseConfirmSec", "phaseConfirmSec"], ["phaseHysteresis", "phaseHysteresis"],
    ["containGraceSec", "containGraceSec"], ["containMaxPlayers", "containMaxPlayers"],
  ];
  for (const [k, label] of nonNeg) {
    if (body[k] === undefined) continue;
    const v = num(body[k]);
    if (!Number.isFinite(v) || v < 0) return { error: `${label} must be >= 0` };
    (patch as Record<string, unknown>)[k] = Math.round(v);
  }
  // Check speeds: blank/null = the install's default; otherwise bounded, so a typo can neither
  // hammer the game server nor leave a seeding rule asleep for an hour.
  for (const [k, b, label] of [["checkSec", SEED_CHECK_SEC, "the seeding check"], ["chaseCheckSec", SEED_CHASE_CHECK_SEC, "the fast check"]] as const) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === "") { patch[k] = null; continue; }
    const v = num(body[k]);
    if (!Number.isFinite(v) || v < b.min || v > b.max) return { error: `${label} must be ${b.min}–${b.max} seconds (blank = default)` };
    patch[k] = Math.round(v);
  }
  /*
   * The reward's two halves. Zero is "not this one" for each of them, which is what makes VIP,
   * points, or both a setting rather than three code paths — so neither may be validated as
   * "> 0" any more. What must not be storable is the reward being switched ON with both at zero:
   * that promises the seeders something and hands them nothing. The pair can only be judged
   * against the CURRENT config (this is a patch), so the route checks it after merging.
   */
  for (const [k, label, max] of [["rewardHours", "rewardHours", 24 * 365], ["rewardPoints", "rewardPoints", 1_000_000]] as const) {
    if (body[k] === undefined) continue;
    const v = num(body[k]);
    if (!Number.isFinite(v) || v < 0) return { error: `${label} must be >= 0 (0 = do not give this)` };
    if (v > max) return { error: `${label} must be at most ${max}` };
    (patch as Record<string, unknown>)[k] = Math.round(v);
  }
  if (body.rewardBridge !== undefined) {
    // Shape only, here — whether each server EXISTS and whether the saver may pay VIP on it are
    // repo questions, answered in the route. Same hour bounds as the seeded server's own reward.
    if (!Array.isArray(body.rewardBridge)) return { error: "rewardBridge must be an array of { serverId, hours }" };
    if (body.rewardBridge.length > 8) return { error: "at most 8 bridge targets" };
    const targets: SeedBridgeTarget[] = [];
    const seen = new Set<string>();
    for (const raw of body.rewardBridge as unknown[]) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const serverId = str(r.serverId).trim();
      if (!serverId) return { error: "every bridge target names a server" };
      if (seen.has(serverId)) return { error: "a bridge lists each server once — one row, the hours it pays there" };
      seen.add(serverId);
      const hours = num(r.hours);
      if (!Number.isFinite(hours) || hours < 1) return { error: "bridge hours must be at least 1 — a stop that pays nothing is not a stop, remove the row instead" };
      if (hours > 24 * 365) return { error: `bridge hours must be at most ${24 * 365}` };
      targets.push({ serverId, hours: Math.round(hours) });
    }
    patch.rewardBridge = targets;
  }
  /*
   * The five texts seeding SENDS TO PLAYERS, and the only player-facing text in the app that had
   * no length limit at all. A one-shot broadcast is capped at 1000 characters and so is a message
   * to everyone; these go to every joining player, every cycle, and could be pasted at any size.
   * The announcement also has the restriction list appended to it now, so an unbounded base grew
   * further on the way out. Same ceiling as the one-shot paths they are the automated twin of.
   */
  const strs: (keyof SeedingConfigPatch)[] = [
    "announceMessage", "warnMessage", "punishMessage", "kickMessage", "rewardMessage",
    // The currency footnote, both halves — same ceiling, for the same reason: they are appended to
    // the reward a player is shown in game, not stored as a note.
    "rewardLinkedNote", "rewardUnlinkedNote", "rewardRepeatMessage",
    // The cap-fight rule in the operator's words — the greeting line and the warn's {violation}.
    "capFightNotice",
    // Containment's line, same contract.
    "containNotice",
    "paceNotice",
  ];
  for (const k of strs) {
    if (body[k] === undefined) continue;
    const v = str(body[k]);
    if (v.length > 1000) return { error: `${k} is longer than 1000 characters — it is sent to a player in game, not stored as a note` };
    (patch as Record<string, unknown>)[k] = v;
  }
  /*
   * Containment zones: map key → three sector lists. The sector vocabulary is closed (isSectorId,
   * "A1".."J10" — the exact grid the picker draws and the worker judges), so anything else in a
   * list is a bug or a hand-crafted request, not a preference to store. Keys are folded map-family
   * names from zoneKeyOf; their charset is checked but not their existence, because the catalogue
   * grows with game patches and a drawn zone must not be deleted by a validator that lags it.
   */
  if (body.containZones !== undefined) {
    const zones = parseZonePaint(body.containZones, "containZones");
    if ("error" in zones) return { error: zones.error };
    patch.containZones = zones.value;
  }
  return { value: patch };
}

/**
 * A zone paint: map key → three sector lists. Shared between the seeding containment config and
 * the zone-set library — one vocabulary, one validator. The sector vocabulary is closed
 * (isSectorId, "A1".."J10" — the exact grid the picker draws and the worker judges), so anything
 * else in a list is a bug or a hand-crafted request, not a preference to store. Keys are folded
 * map-family names from zoneKeyOf; their charset is checked but not their existence, because the
 * catalogue grows with game patches and a drawn zone must not be deleted by a validator that
 * lags it.
 */
export function parseZonePaint(
  raw: unknown,
  label: string,
): { value: Record<string, { allies: string[]; axis: string[]; shared: string[] }> } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: `${label} must be an object of {mapKey: {allies, axis, shared}}` };
  const entries = Object.entries(raw as Record<string, unknown>);
  // Per-LAYER keys ("@stmereeglise_warfare") sit beside the family keys, so the ceiling is the
  // layer count, not the family count.
  if (entries.length > 400) return { error: `${label} covers more maps than either game ships` };
  const zones: Record<string, { allies: string[]; axis: string[]; shared: string[] }> = {};
  for (const [key, val] of entries) {
    if (!/^([a-z0-9]{1,64}|@[a-z0-9_]{1,80})$/.test(key)) return { error: `${label} key "${key.slice(0, 30)}" is not a map family or @layer id` };
    if (typeof val !== "object" || val === null || Array.isArray(val)) return { error: `${label}["${key}"] must be {allies, axis, shared}` };
    const lists: { allies: string[]; axis: string[]; shared: string[] } = { allies: [], axis: [], shared: [] };
    for (const side of ["allies", "axis", "shared"] as const) {
      const cells = (val as Record<string, unknown>)[side] ?? [];
      if (!Array.isArray(cells)) return { error: `${label}["${key}"].${side} must be an array of sector ids` };
      const clean = [...new Set(cells.map((c) => str(c).trim().toUpperCase()))].filter(Boolean);
      for (const c of clean) if (!isSectorId(c)) return { error: `"${c.slice(0, 10)}" is not a sector (A1–J10)` };
      lists[side] = clean;
    }
    // A map whose three lists are all empty says nothing — dropped rather than stored, so the
    // paint reads as the policy it is and "delete this map's zones" is just saving it empty.
    if (lists.allies.length || lists.axis.length || lists.shared.length) zones[key] = lists;
  }
  return { value: zones };
}

/**
 * The one seeding rule that cannot be judged from a patch alone: a reward that is switched on has
 * to be a reward. Applied to the MERGED config, because "turn the points off" and "turn the VIP
 * off" arrive as separate patches and only their combination is wrong.
 */
export function seedRewardRefusal(cfg: { rewardEnabled: boolean; rewardHours: number; rewardPoints: number }): string | null {
  if (!cfg.rewardEnabled) return null;
  if (cfg.rewardHours > 0 || cfg.rewardPoints > 0) return null;
  return "the seed reward is switched on but gives nothing — set VIP hours, points, or both (or switch the reward off)";
}

/** Validate a broadcast-config PUT body into a partial patch. Messages are trimmed; blank ones are
 *  dropped so the rotation never emits an empty broadcast. */
export function parseBroadcastBody(body: Record<string, unknown>): { value: BroadcastConfigPatch } | { error: string } {
  const patch: BroadcastConfigPatch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;
  if (body.dryRun !== undefined) patch.dryRun = body.dryRun === true;
  if (body.randomize !== undefined) patch.randomize = body.randomize === true;
  if (body.intervalSec !== undefined) {
    const v = Number(body.intervalSec);
    if (!Number.isFinite(v) || v < 30) return { error: "intervalSec must be at least 30 seconds" };
    if (v > 86400) return { error: "intervalSec must be at most 86400 (24h)" };
    patch.intervalSec = Math.round(v);
  }
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) return { error: "messages must be an array of strings" };
    const list = (body.messages as unknown[]).map((m) => str(m).trim()).filter(Boolean);
    for (const m of list) if (m.length > 1000) return { error: "each message must be at most 1000 chars" };
    patch.messages = list;
  }
  return { value: patch };
}

/**
 * Validate a slash-command PUT body: `{ name?, description?, enabled? }` for the one command.
 *
 * Discord's own rules, enforced here rather than discovered as a 400 from Discord on the Register
 * press: a name is 1–32 chars of lowercase letters, digits, `-` and `_` (Discord also allows other
 * scripts; this is the safe subset), and a description is 1–100 chars.
 */
export function parseDiscordCommands(
  body: Record<string, unknown>,
  current: DiscordCommandConfig,
): { value: Partial<Omit<DiscordCommandConfig, "updatedAt">> } | { error: string } {
  const name = (body.name === undefined ? current.name : str(body.name)).trim().toLowerCase();
  const description = (body.description === undefined ? current.description : str(body.description)).trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) return { error: "the command name must be 1–32 chars of lowercase letters, numbers, - or _" };
  if (description.length < 1 || description.length > 100) return { error: "the command description must be 1–100 chars" };
  // Deliberately no "who may use it" field. Who may open the panel is the staff guild's role map
  // (Discord → Sign-in & roles), the same list that decides who may sign in — so removing somebody
  // from staff in Discord closes both doors at once, with nothing else to remember.
  return { value: { name, description, enabled: body.enabled === undefined ? current.enabled : body.enabled === true } };
}

/** Validate a Discord-relay PUT body: enabled flag, an enabled-category subset, and a category→
 *  channel-id map (numeric Discord ids; blank clears). Unknown categories are rejected.
 *
 *  `existing` is the stored config, needed only by the status board: its `messageId` is state the
 *  WORKER owns (the one message it keeps editing), so a config save must carry it through rather
 *  than let the panel set or silently erase it. */
export function parseDiscordRelay(body: Record<string, unknown>, existing?: { statusBoard?: DiscordStatusBoardConfig } | null): { value: DiscordRelayConfigPatch } | { error: string } {
  const known = new Set<string>(DISCORD_RELAY_CATEGORIES);
  const patch: DiscordRelayConfigPatch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;
  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories)) return { error: "categories must be an array" };
    const cats = (body.categories as unknown[]).map((c) => str(c).trim());
    for (const c of cats) if (!known.has(c)) return { error: `unknown category "${c}"` };
    patch.categories = [...new Set(cats)];
  }
  if (body.channels !== undefined) {
    if (typeof body.channels !== "object" || body.channels === null || Array.isArray(body.channels)) return { error: "channels must be an object" };
    const out: Record<string, string | null> = {};
    for (const [cat, v] of Object.entries(body.channels as Record<string, unknown>)) {
      if (!known.has(cat)) return { error: `unknown category "${cat}"` };
      const id = str(v).trim();
      if (id && !/^\d{5,25}$/.test(id)) return { error: `channel id for "${cat}" must be a Discord channel id (numeric)` };
      out[cat] = id || null;
    }
    patch.channels = out;
  }
  if (body.alerts !== undefined) {
    if (typeof body.alerts !== "object" || body.alerts === null) return { error: "alerts must be an object" };
    const a = body.alerts as Record<string, unknown>;
    const id = (v: unknown) => str(v).trim();
    const okId = (v: string) => v === "" || /^\d{5,25}$/.test(v);
    const rule = (raw: unknown, dflt: { enabled: boolean; channelId: string | null; mentionRoleId: string | null }) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const channelId = id(r.channelId);
      const mentionRoleId = id(r.mentionRoleId);
      if (!okId(channelId)) return { error: "channel id must be a Discord id (numeric)" as const };
      if (!okId(mentionRoleId)) return { error: "mention role id must be a Discord id (numeric)" as const };
      return { value: { enabled: r.enabled === undefined ? dflt.enabled : r.enabled === true, channelId: channelId || null, mentionRoleId: mentionRoleId || null } };
    };
    const ap = rule(a.adminPing, DISCORD_ALERTS_DEFAULTS.adminPing);
    if ("error" in ap) return { error: `adminPing: ${ap.error}` };
    const trigger = a.adminPing && typeof a.adminPing === "object" && (a.adminPing as Record<string, unknown>).trigger !== undefined
      ? str((a.adminPing as Record<string, unknown>).trigger).trim() : DISCORD_ALERTS_DEFAULTS.adminPing.trigger;
    if (trigger.length < 1 || trigger.length > 40) return { error: "adminPing trigger must be 1–40 chars" };
    const wl = rule(a.watchlist, DISCORD_ALERTS_DEFAULTS.watchlist);
    if ("error" in wl) return { error: `watchlist: ${wl.error}` };
    const auto = rule(a.automation, DISCORD_ALERTS_DEFAULTS.automation);
    if ("error" in auto) return { error: `automation: ${auto.error}` };
    const dark = rule(a.serverDark, DISCORD_ALERTS_DEFAULTS.serverDark);
    if ("error" in dark) return { error: `serverDark: ${dark.error}` };
    const alerts: DiscordAlertsConfig = {
      adminPing: { ...ap.value, trigger },
      watchlist: wl.value,
      automation: auto.value,
      serverDark: dark.value,
    };
    patch.alerts = alerts;
  }
  if (body.categoryOptions !== undefined) {
    if (typeof body.categoryOptions !== "object" || body.categoryOptions === null || Array.isArray(body.categoryOptions)) return { error: "categoryOptions must be an object" };
    const out: Record<string, { mentionRoleId?: string | null; teamkillsOnly?: boolean; includeVoteBallots?: boolean }> = {};
    for (const [cat, raw] of Object.entries(body.categoryOptions as Record<string, unknown>)) {
      if (!known.has(cat)) return { error: `unknown category "${cat}"` };
      if (!raw || typeof raw !== "object") return { error: `options for "${cat}" must be an object` };
      const o = raw as Record<string, unknown>;
      const opts: { mentionRoleId?: string | null; teamkillsOnly?: boolean; includeVoteBallots?: boolean } = {};
      if (o.mentionRoleId !== undefined) {
        const id = str(o.mentionRoleId).trim();
        if (id && !/^\d{5,25}$/.test(id)) return { error: `mention role id for "${cat}" must be a Discord role id (numeric)` };
        opts.mentionRoleId = id || null;
      }
      if (o.teamkillsOnly !== undefined) opts.teamkillsOnly = o.teamkillsOnly === true;
      if (o.includeVoteBallots !== undefined) opts.includeVoteBallots = o.includeVoteBallots === true;
      out[cat] = opts;
    }
    patch.categoryOptions = out;
  }
  if (body.statusBoard !== undefined) {
    if (typeof body.statusBoard !== "object" || body.statusBoard === null || Array.isArray(body.statusBoard)) return { error: "statusBoard must be an object" };
    const b = body.statusBoard as Record<string, unknown>;
    const prev = existing?.statusBoard ?? DISCORD_STATUS_BOARD_DEFAULTS;
    const channelId = b.channelId === undefined ? prev.channelId : str(b.channelId).trim() || null;
    if (channelId && !/^\d{5,25}$/.test(channelId)) return { error: "statusBoard channel id must be a Discord channel id (numeric)" };
    let intervalSec = prev.intervalSec;
    if (b.intervalSec !== undefined) {
      const v = Number(b.intervalSec);
      if (!Number.isFinite(v) || v < DISCORD_STATUS_BOARD_MIN_SEC) return { error: `statusBoard intervalSec must be at least ${DISCORD_STATUS_BOARD_MIN_SEC} seconds` };
      if (v > 3600) return { error: "statusBoard intervalSec must be at most 3600 (1h)" };
      intervalSec = Math.round(v);
    }
    // The headline, when the operator would rather say it than have it derived from the server name.
    // Capped because the board shrinks it to fit and a sentence would arrive unreadably small.
    let title = prev.title ?? null;
    if (b.title !== undefined) {
      title = str(b.title).trim() || null;
      if (title && title.length > 48) return { error: "statusBoard title must be at most 48 characters" };
    }
    // Moving the board to a different channel abandons the message it was keeping current: that id
    // names a message in a channel we no longer draw in, so the worker must post a fresh one there.
    // Otherwise the id is carried through untouched — it is the worker's, not the panel's.
    const kept = channelId === prev.channelId;
    patch.statusBoard = {
      enabled: b.enabled === undefined ? prev.enabled : b.enabled === true,
      channelId,
      intervalSec,
      title,
      messageId: kept ? prev.messageId : null,
      // The artwork rides on that message, so it is abandoned with it.
      imageName: kept ? prev.imageName ?? null : null,
    };
  }
  return { value: patch };
}

/** Validate an auto-settings PUT body. Profiles carry a schedule spec (same shape as map-vote) plus
 *  a `settings` map whose keys must be WRITABLE config fields for the game; values are coerced by the
 *  field kind. First-match order is preserved. `fields` is the game's config-field map. */
export function parseAutoSettings(body: Record<string, unknown>, fields: ReturnType<typeof configFieldsFor>): { value: AutoSettingsConfigPatch } | { error: string } {
  const patch: AutoSettingsConfigPatch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;
  if (body.dryRun !== undefined) patch.dryRun = body.dryRun === true;
  if (body.timezone !== undefined) {
    const tz = str(body.timezone).trim() || "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return { error: `invalid timezone "${tz}"` }; }
    patch.timezone = tz;
  }
  if (body.profiles !== undefined) {
    if (!Array.isArray(body.profiles)) return { error: "profiles must be an array" };
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const dateRe = /^(\d{4}-)?\d{2}-\d{2}$/;
    const wd = new Set<string>(WEEKDAYS);
    const seen = new Set<string>();
    const profiles: AutoSettingsProfile[] = [];
    for (const [i, raw] of (body.profiles as unknown[]).entries()) {
      if (!raw || typeof raw !== "object") return { error: `profile ${i} must be an object` };
      const r = raw as Record<string, unknown>;
      const name = str(r.name).trim();
      if (!name) return { error: `profile ${i} needs a name` };
      const key = name.toLowerCase();
      if (seen.has(key)) return { error: `duplicate profile name "${name}"` };
      seen.add(key);
      const profile: AutoSettingsProfile = { name, settings: {} };
      if (r.spec !== undefined && r.spec !== null) {
        if (typeof r.spec !== "object") return { error: `profile "${name}" spec must be an object` };
        const s = r.spec as Record<string, unknown>;
        const spec: AutoSettingsProfile["spec"] = {};
        if (s.timezone !== undefined) { const tz = str(s.timezone).trim(); try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); spec.timezone = tz; } catch { return { error: `profile "${name}" has an invalid timezone` }; } }
        if (s.daysOfWeek !== undefined) { const d = (Array.isArray(s.daysOfWeek) ? s.daysOfWeek : []).map((x) => str(x).toLowerCase()); for (const x of d) if (!wd.has(x)) return { error: `profile "${name}" has an invalid weekday "${x}"` }; spec.daysOfWeek = d; }
        if (s.months !== undefined) { const m = (Array.isArray(s.months) ? s.months : []).map(Number); for (const x of m) if (!(x >= 1 && x <= 12)) return { error: `profile "${name}" months must be 1-12` }; spec.months = m; }
        if (s.years !== undefined) spec.years = (Array.isArray(s.years) ? s.years : []).map(Number).filter(Number.isFinite);
        if (s.dates !== undefined) { const dts = (Array.isArray(s.dates) ? s.dates : []).map((x) => str(x).trim()).filter(Boolean); for (const x of dts) if (!dateRe.test(x)) return { error: `profile "${name}" date "${x}" must be MM-DD or YYYY-MM-DD` }; spec.dates = dts; }
        for (const k of ["start", "end"] as const) if (s[k] !== undefined) { const v = str(s[k]).trim(); if (!hhmm.test(v)) return { error: `profile "${name}" ${k} must be HH:MM` }; spec[k] = v; }
        for (const k of ["playersBelow", "playersAbove", "alliedBelow", "alliedAbove", "axisBelow", "axisAbove", "teamDiffBelow", "teamDiffAbove"] as const) if (s[k] !== undefined && s[k] !== null) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0) return { error: `profile "${name}" ${k} must be >= 0` }; spec[k] = Math.round(v); }
        // Minutes into the match. Bounded well past any real match so a typo can't read as "never".
        for (const k of ["matchMinutesAtLeast", "matchMinutesBelow"] as const) if (s[k] !== undefined && s[k] !== null) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0 || v > 600) return { error: `profile "${name}" match minutes must be 0–600` }; spec[k] = Math.round(v); }
        if (spec.matchMinutesAtLeast !== undefined && spec.matchMinutesBelow !== undefined && spec.matchMinutesBelow <= spec.matchMinutesAtLeast) {
          return { error: `profile "${name}" can never match: "match has run less than ${spec.matchMinutesBelow} minutes" ends before "at least ${spec.matchMinutesAtLeast}" begins` };
        }
        profile.spec = spec;
      }
      const rawSettings = (r.settings ?? {}) as Record<string, unknown>;
      if (typeof rawSettings !== "object" || Array.isArray(rawSettings)) return { error: `profile "${name}" settings must be an object` };
      for (const [field, v] of Object.entries(rawSettings)) {
        // "preset:" keys apply a named feature preset (the value is the preset's name). The
        // feature must exist in the catalog; the name is looked up at APPLY time, so renaming or
        // deleting a preset later degrades to a logged warning, not a save-time failure.
        if (field.startsWith("preset:")) {
          const def = getFeaturePreset(field.slice("preset:".length));
          if (!def) return { error: `profile "${name}" references presets for an unknown feature "${field}"` };
          const presetName = str(v).trim();
          if (!presetName) return { error: `profile "${name}" needs a preset name for "${def.label}"` };
          profile.settings[field] = presetName;
          continue;
        }
        // "app:" keys are the app's own automation switches (broadcast, map vote, seeding, …) —
        // validated against the curated catalog, not the game descriptor.
        if (isAppSettingKey(field)) {
          const app = getAppSetting(field);
          if (!app) return { error: `profile "${name}" has an unknown app setting "${field}"` };
          profile.settings[field] = v === true || v === "true";
          continue;
        }
        const fspec = fields.get(field);
        if (!fspec?.write) return { error: `profile "${name}" has an unknown setting "${field}"` };
        if (fspec.kind === "num") { const n = Number(v); if (!Number.isFinite(n)) return { error: `profile "${name}" setting "${field}" must be a number` }; profile.settings[field] = n; }
        else if (fspec.kind === "bool") profile.settings[field] = v === true || v === "true";
        else profile.settings[field] = str(v);
      }
      if (r.nextMap !== undefined && r.nextMap !== null) {
        const m = str(r.nextMap).trim();
        if (m) profile.nextMap = m;
      }
      if (r.applyTemplate !== undefined && r.applyTemplate !== null) {
        const t = str(r.applyTemplate).trim();
        if (t) profile.applyTemplate = t;
      }
      profiles.push(profile);
    }
    patch.profiles = profiles;
  }
  if (body.matchMessages !== undefined) {
    if (!Array.isArray(body.matchMessages)) return { error: "matchMessages must be an array" };
    if (body.matchMessages.length > MATCH_MESSAGE_MAX) return { error: `at most ${MATCH_MESSAGE_MAX} timed match messages` };
    const out: AutoSettingsMatchMessage[] = [];
    for (const [i, raw] of (body.matchMessages as unknown[]).entries()) {
      if (!raw || typeof raw !== "object") return { error: `timed message ${i + 1} must be an object` };
      const r = raw as Record<string, unknown>;
      const minutes = Number(r.minutes);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 600) return { error: `timed message ${i + 1}: minutes after match start must be 0–600` };
      const message = str(r.message).trim();
      if (!message) return { error: `timed message ${i + 1} has no text` };
      // Same ceiling as every other message sent to a player in game.
      if (message.length > 1000) return { error: `timed message ${i + 1} is longer than 1000 characters` };
      const minPlayers = r.minPlayers === undefined || r.minPlayers === null || r.minPlayers === "" ? 0 : Number(r.minPlayers);
      if (!Number.isFinite(minPlayers) || minPlayers < 0 || minPlayers > 200) return { error: `timed message ${i + 1}: minimum players must be 0–200` };
      out.push({ minutes: Math.round(minutes), message, minPlayers: Math.round(minPlayers), enabled: r.enabled !== false });
    }
    patch.matchMessages = out;
  }
  return { value: patch };
}

/**
 * The first `limit` distinct map ids, compared as the vote engine compares them (ignoring case).
 * One pass that stops once it has enough: the list comes from the client and can be as long as a
 * request body allows, and the pairwise de-duplication this replaced was quadratic in that length.
 */
function firstUniqueMaps(ids: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Merge a request body's pool settings over DEFAULT_POOL_CONFIG (light coercion; unknown keys ignored). */
export function parsePoolConfig(body: Record<string, unknown>): MapPoolConfig {
  const d = DEFAULT_POOL_CONFIG;
  const num = (v: unknown, f: number) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : f);
  const arr = (v: unknown, f: string[]) => (Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : f);
  const bool = (v: unknown, f: boolean) => (typeof v === "boolean" ? v : f);
  // Mode-first categories: [{ mode, counts: { day: 3, night: 1 }, maps: [] }]. Coerced rather than
  // rejected, in the same spirit as the rest of this function — a count that is not a number is a
  // zero, and a category with no mode is dropped, so a malformed body cannot reach the engine.
  const modeBuckets = Array.isArray(body.modeBuckets)
    ? (body.modeBuckets as unknown[]).flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const r = raw as Record<string, unknown>;
        const mode = str(r.mode).trim().toLowerCase();
        if (!mode) return [];
        const limits: Record<string, number> = {};
        // `counts` is the pre-ceiling spelling of `limits`; read either so a set saved between the
        // two shapes still loads.
        const rawLimits = (r.limits ?? r.counts) as Record<string, unknown> | undefined;
        if (rawLimits && typeof rawLimits === "object") {
          for (const [env, v] of Object.entries(rawLimits)) {
            const key = str(env).trim().toLowerCase();
            const n = num(v, 0);
            if (key && n > 0) limits[key] = n;
          }
        }
        // Absent count = the ceilings ARE the quota, which is how the engine reads it too. An
        // explicit 0 is preserved — it means "this mode contributes nothing", not "use the sum".
        const count = r.count === undefined || r.count === null
          ? Object.values(limits).reduce((a, b) => a + b, 0)
          : num(r.count, 0);
        return [{ mode, count, limits, maps: arr(r.maps, []) }];
      })
    : undefined;
  return {
    ...(modeBuckets ? { modeBuckets } : {}),
    dayCount: num(body.dayCount, d.dayCount), nightCount: num(body.nightCount, d.nightCount), wildcardCount: num(body.wildcardCount, d.wildcardCount),
    duplicateMaps: bool(body.duplicateMaps, d.duplicateMaps),
    // Enumerated so a typo can never reach the engine; falls back to the default rule.
    variety: body.variety === "random" || body.variety === "per-map" || body.variety === "per-map-mode" ? body.variety : d.variety,
    variantPreference: body.variantPreference === "prefer-day" ? "prefer-day" : "random",
    battleModes: arr(body.battleModes, d.battleModes), wildcardModes: arr(body.wildcardModes, d.wildcardModes),
    // Per-bucket overrides. Defaulted to [] rather than to the inherited list, because [] is how
    // the engine spells "no opinion" — writing battleModes in here would freeze a copy of it and
    // stop the bucket following later edits to the set-wide value.
    dayModes: arr(body.dayModes, []), nightModes: arr(body.nightModes, []),
    dayMaps: arr(body.dayMaps, []), nightMaps: arr(body.nightMaps, []), wildcardMaps: arr(body.wildcardMaps, []),
    allowedMaps: arr(body.allowedMaps, d.allowedMaps), blacklistMaps: arr(body.blacklistMaps, d.blacklistMaps),
    excludePlayedMaps: num(body.excludePlayedMaps, d.excludePlayedMaps),
    excludePlayedFamilies: num(body.excludePlayedFamilies, d.excludePlayedFamilies ?? 0),
    previousPollExclusionMode: body.previousPollExclusionMode === "hard" ? "hard" : "soft",
    enforceCount: num(body.enforceCount, d.enforceCount), enforcedMaps: arr(body.enforcedMaps, d.enforcedMaps),
    // Added after the draw (MapPoolConfig.alwaysOffer). One entry per map, and no more than a
    // single poll can carry — past that they would only ever be reported as having no room.
    alwaysOffer: firstUniqueMaps(arr(body.alwaysOffer, []), POLL_OPTION_LIMIT),
    // Clamped, not just defaulted: the vote surface refuses a poll with more answers than it
    // takes, so a stored number above the limit is a vote that never posts at all.
    maxOptions: Math.min(num(body.maxOptions, d.maxOptions) || d.maxOptions, POLL_OPTION_LIMIT),
    // The explicit rotation lineup (rotation apply reads it; the vote engine ignores it).
    // Bounded: a rotation is a lineup, and past ~50 entries HLL's own list stops cooperating.
    sequence: arr(body.sequence, []).slice(0, 50),
  };
}

/**
 * Validate a map set's pool as OVERRIDES: run the full parser for the coercion and the bounds, then
 * keep only the keys the caller actually sent. A set stores what it changes about the engine's
 * defaults, so materialising every default into it would freeze today's defaults into every set.
 */
export function parsePoolOverrides(raw: unknown, label: string): { value: Partial<MapPoolConfig> } | { error: string } {
  if (raw === undefined || raw === null) return { value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: `${label} pool must be an object` };
  const given = raw as Record<string, unknown>;
  const full = parsePoolConfig(given) as unknown as Record<string, unknown>;
  const partial: Partial<MapPoolConfig> = {};
  for (const k of Object.keys(given)) if (k in full) (partial as Record<string, unknown>)[k] = full[k];
  return { value: partial };
}

/**
 * Validate a schedule spec — the WHEN half, now a library record of its own and so parsed on its
 * own. `label` only names the thing in the error message ("schedule \"Friday teatime\" …"), so the
 * same checks read correctly whether the spec arrived attached to a profile or by itself.
 */
export function parseScheduleSpec(raw: unknown, label: string): { value: MapVoteProfile["spec"] } | { error: string } {
  if (raw === undefined || raw === null) return { value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: `${label} spec must be an object` };
  const s = raw as Record<string, unknown>;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const dateRe = /^(\d{4}-)?\d{2}-\d{2}$/;
  const wd = new Set<string>(WEEKDAYS);
  const spec: MapVoteProfile["spec"] = {};
  if (s.timezone !== undefined) { const tz = str(s.timezone).trim(); try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); spec.timezone = tz; } catch { return { error: `${label} has an invalid timezone` }; } }
  if (s.daysOfWeek !== undefined) { const d = (Array.isArray(s.daysOfWeek) ? s.daysOfWeek : []).map((x) => str(x).toLowerCase()); for (const x of d) if (!wd.has(x)) return { error: `${label} has an invalid weekday "${x}"` }; spec.daysOfWeek = d as Weekday[]; }
  if (s.months !== undefined) { const m = (Array.isArray(s.months) ? s.months : []).map(Number); for (const x of m) if (!(x >= 1 && x <= 12)) return { error: `${label} months must be 1-12` }; spec.months = m; }
  if (s.years !== undefined) spec.years = (Array.isArray(s.years) ? s.years : []).map(Number).filter(Number.isFinite);
  if (s.dates !== undefined) { const dts = (Array.isArray(s.dates) ? s.dates : []).map((x) => str(x).trim()).filter(Boolean); for (const x of dts) if (!dateRe.test(x)) return { error: `${label} date "${x}" must be MM-DD or YYYY-MM-DD` }; spec.dates = dts; }
  for (const k of ["start", "end"] as const) if (s[k] !== undefined) { const v = str(s[k]).trim(); if (!hhmm.test(v)) return { error: `${label} ${k} must be HH:MM` }; spec[k] = v; }
  for (const k of ["playersBelow", "playersAbove"] as const) if (s[k] !== undefined && s[k] !== null) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0) return { error: `${label} ${k} must be >= 0` }; spec[k] = Math.round(v); }
  return { value: spec };
}

/**
 * Validate a map-vote config body. `profiles` is now a list of PAIRINGS — `[{ mapSet, schedule? }]`
 * naming rows in the shared library — rather than the settings themselves, which is what makes one
 * curated set usable on every server. The names are resolved by the route against the library, so
 * this only checks shape; an unknown name is a 400 there, where the library is in hand.
 */
export function parseMapVoteConfig(body: Record<string, unknown>): { value: { timezone: string; profiles: MapVoteLink[]; enabled: boolean; surface: string; channelId: string | null; pollHours: number; reminders: MapVoteReminder[]; liveApply: boolean; postMatchApplyDelaySeconds: number; pollResetDelaySeconds: number; tidyChannel: boolean; pauseBelowPlayers: number; registeredOnlyIngame: boolean; registeredOnlyDiscord: boolean; startupState: MapVoteStartupState } } | { error: string } {
  const timezone = str(body.timezone).trim() || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { return { error: `invalid timezone "${timezone}"` }; }
  const enabled = body.enabled === true;
  // "native" = a native Discord poll; "ingame" = players type the option's number in game chat
  // (the CRCON votemap shape — the one console players can reach); "both" runs the two at once
  // and combines the ballots for the final score; "embed" is reserved.
  const surface = ["embed", "ingame", "both"].includes(String(body.surface)) ? String(body.surface) : "native";
  // Two gates, one per surface. A body carrying the RETIRED single flag (a parked request-builder
  // draft, an old client) means "both": that is what the flag did, and losing a protection someone
  // turned on is the one wrong reading.
  const legacyRegisteredOnly = body.registeredOnly === true;
  const registeredOnlyIngame = body.registeredOnlyIngame === true || legacyRegisteredOnly;
  const registeredOnlyDiscord = body.registeredOnlyDiscord === true || legacyRegisteredOnly;
  const channelRaw = str(body.channelId).trim();
  if (channelRaw && !/^\d{5,25}$/.test(channelRaw)) return { error: "channelId must be a Discord channel id (numeric)" };
  const channelId = channelRaw || null;
  const pollHours = body.pollHours === undefined ? 24 : Math.round(Number(body.pollHours));
  if (!Number.isFinite(pollHours) || pollHours < 1 || pollHours > 768) return { error: "pollHours must be between 1 and 768" };
  if (body.profiles !== undefined && !Array.isArray(body.profiles)) return { error: "profiles must be an array" };
  const rawProfiles = (body.profiles ?? []) as unknown[];
  const profiles: MapVoteLink[] = [];
  for (const [i, raw] of rawProfiles.entries()) {
    if (!raw || typeof raw !== "object") return { error: `map set ${i + 1} must be an object` };
    const r = raw as Record<string, unknown>;
    const mapSet = str(r.mapSet).trim();
    if (!mapSet) return { error: `map set ${i + 1} needs a set name` };
    const schedule = r.schedule == null ? null : str(r.schedule).trim() || null;
    profiles.push({ mapSet, schedule });
  }
  // Match-start reminders: [{ minutesAfterMatchStart >= 0, message, layout }]. `layout` decides what
  // is listed under the message in game: nothing, the map names, or the names with live vote counts.
  const reminders: MapVoteReminder[] = [];
  if (body.reminders !== undefined) {
    if (!Array.isArray(body.reminders)) return { error: "reminders must be an array" };
    for (const [i, raw] of (body.reminders as unknown[]).entries()) {
      if (!raw || typeof raw !== "object") return { error: `reminder ${i} must be an object` };
      const r = raw as Record<string, unknown>;
      const minutes = Number(r.minutesAfterMatchStart);
      if (!Number.isFinite(minutes) || minutes < 0) return { error: `reminder ${i}: minutesAfterMatchStart must be >= 0` };
      const message = str(r.message).trim();
      if (!message) return { error: `reminder ${i} needs a message` };
      // Bounded like every other thing this app says to a player in game. It was the one such
      // field with no limit, and it is not decorative: the reminder is sent to each player
      // individually, so an over-long one is not one rejected message but one per person on the
      // server. The options list is appended to it, which `buildVoteAnnouncement` bounds in turn.
      if (message.length > TEXT_MAX.reason) {
        return { error: `reminder ${i}: the message is longer than ${TEXT_MAX.reason} characters` };
      }
      const layout = r.layout === undefined ? "none" : str(r.layout).trim();
      if (!MAPVOTE_MESSAGE_LAYOUTS.includes(layout as MapVoteMessageLayout)) {
        return { error: `reminder ${i}: layout must be one of ${MAPVOTE_MESSAGE_LAYOUTS.join(", ")}` };
      }
      reminders.push({ minutesAfterMatchStart: Math.round(minutes), message, layout: layout as MapVoteMessageLayout });
    }
  }
  const liveApply = body.liveApply === undefined ? true : body.liveApply === true;
  const secs = (key: "postMatchApplyDelaySeconds" | "pollResetDelaySeconds", fallback: number, max: number) => {
    if (body[key] === undefined) return fallback;
    const v = Math.round(Number(body[key]));
    return Number.isFinite(v) && v >= 0 && v <= max ? v : NaN;
  };
  const postMatchApplyDelaySeconds = secs("postMatchApplyDelaySeconds", 300, 3600);
  if (Number.isNaN(postMatchApplyDelaySeconds)) return { error: "postMatchApplyDelaySeconds must be between 0 and 3600" };
  const pollResetDelaySeconds = secs("pollResetDelaySeconds", 180, 3600);
  if (Number.isNaN(pollResetDelaySeconds)) return { error: "pollResetDelaySeconds must be between 0 and 3600" };
  // Default true: a superseded ballot has no function, and the tally lives in the panel either way.
  const tidyChannel = body.tidyChannel === undefined ? true : Boolean(body.tidyChannel);
  const pauseBelowPlayers = body.pauseBelowPlayers === undefined ? 0 : Math.round(Number(body.pauseBelowPlayers));
  if (!Number.isFinite(pauseBelowPlayers) || pauseBelowPlayers < 0 || pauseBelowPlayers > 100) {
    return { error: "pauseBelowPlayers must be between 0 and 100" };
  }
  // Absent means "remember", so a client that predates this field keeps today's behaviour rather
  // than silently acquiring an opinion about restarts.
  const startupState = body.startupState === undefined ? "remember" : String(body.startupState);
  if (!(MAPVOTE_STARTUP_STATES as readonly string[]).includes(startupState)) {
    return { error: `startupState must be one of ${MAPVOTE_STARTUP_STATES.join(", ")}` };
  }
  return { value: { timezone, profiles, enabled, surface, channelId, pollHours, reminders, liveApply, postMatchApplyDelaySeconds, pollResetDelaySeconds, tidyChannel, pauseBelowPlayers, registeredOnlyIngame, registeredOnlyDiscord, startupState: startupState as MapVoteStartupState } };
}

/** Extract the installable-map ids from a GetClientReferenceData("AddMapToRotation") response. The
 *  v2 shape is { dialogueParameters: [{ iD: "MapName", valueMember: "a,b,c" }] }; we also tolerate a
 *  bare comma string or an array (legacy fallback). */
/** The stock HLL admin groups — the fallback offered when the game server can't be asked
 *  (GetAdminGroups) because it's offline or in a protocol that doesn't expose them. */
export const HLL_DEFAULT_ADMIN_GROUPS = ["owner", "senior", "junior", "spectator"];

/** GetAdminGroups → the group names an admin can be added under (e.g. owner, senior, junior, spectator). */
export function parseAdminGroups(raw: unknown): string[] {
  const rows = (raw as { groupNames?: unknown[] } | null)?.groupNames ?? (Array.isArray(raw) ? raw : []);
  return rows.map((x) => str(x)).filter(Boolean);
}

/**
 * The id a per-player command is about to send, checked against the target server's game.
 *
 * HLL: Vietnam identifies players by a per-game EOS id; a Steam64 is an id the server accepts and
 * matches against nobody, so a command carrying one is a silent no-op — the exact failure that made
 * every Vietnam VIP grant do nothing. Player rows and roster reads now carry the right id, which
 * leaves the ids that arrive from OUTSIDE those paths: one typed into a picker's raw-id fallback,
 * or a player-group member whose account belongs to the other game. Refusing here, by shape, turns
 * that silent nothing into an error naming the fix.
 *
 * Returns the refusal message, or null when the id is fine for this server.
 */
export function wrongGameIdError(server: { game: string }, playerId: string): string | null {
  if (server.game === "hllv" && /^765\d{14}$/.test(playerId.trim())) {
    return `${playerId.trim()} is a Steam64 id — HLL: Vietnam identifies players by their per-game EOS id, so the server would accept this command and apply it to nobody. Pick the player from the live roster or their Vietnam directory entry instead.`;
  }
  return null;
}

/**
 * The same refusal, extended with what the player DIRECTORY knows — the check the shape test
 * cannot make on console.
 *
 * Shape catches exactly one mistake: a Steam64 aimed at Vietnam. It is blind in every other
 * direction, because on console BOTH games issue 32-hex EOS-style ids that look identical — the
 * exact ids a console community pastes into a ban dialog. So a Vietnam id sent to a WW2 server
 * (or the reverse) sailed through, the game accepted the command, matched it against nobody, and
 * the panel recorded a ban that never banned anyone.
 *
 * The directory can tell them apart where shape cannot: platform_id is the sole identity key and
 * each row's `game` is stamped at creation from the server that first saw it — ids never migrate
 * between games (migration 028) — so any id we have EVER seen is an id whose game we know. Known
 * to the OTHER game is refused with the fix named. An id we have never seen still passes: banning
 * a player by id before their first sighting is the one workflow raw-id entry exists for, and the
 * directory has no grounds to refuse it.
 */
export async function crossGameIdError(repo: Repository, server: { game: string }, playerId: string): Promise<string | null> {
  const shape = wrongGameIdError(server, playerId);
  if (shape) return shape;
  const id = playerId.trim();
  if (!id) return null;
  // Unreadable directory = no evidence either way; the action proceeds as it always did.
  const known = await repo.players.findByPlatformId(id).catch(() => null);
  if (!known || known.game === server.game) return null;
  const label = (g: string) => getGame(g)?.label ?? g;
  return `${id} is ${known.name ? `${known.name}'s ` : "a "}${label(known.game)} id — this is a ${label(server.game)} server, and player ids do not cross games: the server would accept the command and apply it to nobody. Open the player's ${label(server.game)} directory entry (or their row on this server's live roster) and act from there instead.`;
}

/** The 5×3 objective grid parser now lives with the game module (packages/games/src/hll/state.ts),
 *  where the worker can reach it too; re-exported so the API's existing imports keep working. */
export { parseObjectiveRows } from "@app/games";

export interface MatchRecord { map: string | null; startedAt: string; endedAt: string | null; durationSec: number | null; result: string | null; score: string | null }
/** Pair match.started/ended events (any order) into rounds, newest first. A start opens a round; the
 *  next end closes it (duration + result). Unmatched starts (ongoing) and ends (no start seen) are
 *  still returned so nothing is silently dropped. */
export function pairMatches(events: { kind: string; ts: string; data?: Record<string, unknown> | null }[]): MatchRecord[] {
  // "`CARENTAN NIGHT Warfare` ALLIED (5 - 0) AXIS" → "CARENTAN NIGHT Warfare". The old strip only
  // removed a trailing "(…)", so the modern line — which puts the second side label AFTER the
  // score — kept the whole scoreboard in the map cell of any round whose start was never seen.
  const mapFromResult = (r: string) => r
    .replace(/\s*\b(?:ALLIED|ALLIES|AXIS|US|NVA|NORTH|SOUTH)\b\s*\(\s*\d+\s*[-–]\s*\d+\s*\)\s*(?:\b(?:ALLIED|ALLIES|AXIS|US|NVA|NORTH|SOUTH)\b)?\s*$/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/`/g, "")
    .trim() || null;
  const sorted = events.filter((e) => e.kind === "evt.match.started" || e.kind === "evt.match.ended").sort((a, b) => a.ts.localeCompare(b.ts));
  const out: MatchRecord[] = [];
  let open: MatchRecord | null = null;
  for (const e of sorted) {
    if (e.kind === "evt.match.started") {
      if (open) out.push(open); // previous round never got an end
      open = { map: str(e.data?.map) || null, startedAt: e.ts, endedAt: null, durationSec: null, result: null, score: null };
    } else {
      const result = str(e.data?.result) || null;
      const score = str(e.data?.score) || null;
      if (open) {
        open.endedAt = e.ts;
        open.durationSec = Math.max(0, Math.round((Date.parse(e.ts) - Date.parse(open.startedAt)) / 1000));
        open.result = result; open.score = score;
        if (!open.map && result) open.map = mapFromResult(result);
        out.push(open); open = null;
      } else {
        out.push({ map: result ? mapFromResult(result) : null, startedAt: e.ts, endedAt: e.ts, durationSec: 0, result, score });
      }
    }
  }
  if (open) out.push(open);
  return out.reverse();
}

/** Where trim backups land — the event slice and the per-dataset archives share the directory. */
export const TRIM_BACKUP_DIR = "/data/backups";

/** Build a trim request from a body of { categories:[], datasets:[], olderThanDays, backup? }.
 *  At least one category or dataset; unknown ids of either kind are refused by name, because a
 *  typo that silently trimmed nothing would read as "already clean". */
export async function trimSpecFromBody(req: IncomingMessage): Promise<{ kinds: string[]; categories: string[]; datasets: string[]; olderThanIso: string; backupPath: string | null; backupDir: string | null } | { error: string }> {
  const body = await readJsonBody(req);
  const categories = Array.isArray(body.categories) ? (body.categories as unknown[]).map(String) : [];
  const datasets = Array.isArray(body.datasets) ? (body.datasets as unknown[]).map(String) : [];
  const bogusCategories = categories.filter((c) => !Object.hasOwn(TRIM_CATEGORIES, c));
  if (bogusCategories.length) return { error: `unknown category(s): ${bogusCategories.join(", ")}` };
  const known = new Set(TRIM_DATASETS.map((d) => d.id));
  const bogus = datasets.filter((d) => !known.has(d));
  if (bogus.length) return { error: `unknown dataset(s): ${bogus.join(", ")}` };
  const kinds = kindsForCategories(categories);
  if (kinds.length === 0 && datasets.length === 0) return { error: "pick at least one event category or dataset" };
  /*
   * A cutoff has to be SAID, not implied. Zero is a legitimate answer here ("everything older than
   * now"), which is also the most destructive one — so every value that is not a number must not
   * quietly become it. `Number(null)`, `Number("")` and `Number([])` are all 0, and the panel's
   * days box is free text, so a cleared field or a typo arrived as JSON null and asked to delete
   * the lot. Only a real number, or a string that is one, is a cutoff.
   */
  const raw = body.olderThanDays;
  const days = typeof raw === "number" ? raw
    : typeof raw === "string" && raw.trim() !== "" ? Number(raw)
    : NaN;
  if (!Number.isFinite(days) || days < 0) return { error: "olderThanDays must be a non-negative number" };
  // Zero is legitimate here ("everything older than now"), so this cannot use isSaneDuration —
  // but the upper bound is the same one, and without it the subtraction below throws.
  if (days * 86_400_000 > MAX_DURATION_MS) return { error: "olderThanDays must be at most 36500 (100 years)" };
  const olderThanIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const backupPath = body.backup && kinds.length ? `${TRIM_BACKUP_DIR}/trim-${categories.join("-")}-${Date.now()}.ndjson.gz` : null;
  const backupDir = body.backup && datasets.length ? TRIM_BACKUP_DIR : null;
  return { kinds, categories, datasets, olderThanIso, backupPath, backupDir };
}

export const logger = createLogger("api");

/**
 * "How long do players wait for an admin" — assembled from two things we already record.
 *
 * The call itself is a chat line starting with the server's configured trigger (the same one the
 * Discord admin-ping alert matches, default "!admin"), so a community that renamed the trigger
 * still gets the right answer. The response is the next audited staff action on that server.
 *
 * Scanning every server's chat would be a query per server per request; the window is capped and
 * each server's search is pushed into SQL, so this stays one bounded read per connected server.
 */
export async function adminResponseFor(ctx: AppContext, win: { from: string; to: string }, audit: AuditRow[], tz: string = "UTC") {
  const servers = await ctx.repo.servers.list();
  const requests: { ts: string; serverId: string; playerName: string | null; playerId: string | null; message: string }[] = [];
  await Promise.all(servers.map(async (s) => {
    const cfg = await ctx.repo.discordRelay.getConfig(s.id);
    const trigger = (cfg?.alerts?.adminPing?.trigger || "!admin").trim();
    if (!trigger) return;
    const rows = await ctx.repo.events.query({
      serverId: s.id,
      kinds: ["evt.chat.team", "evt.chat.squad"],
      q: trigger,
      from: win.from,
      to: win.to,
      limit: 500,
    });
    for (const e of rows) {
      const message = String((e.data as { message?: unknown } | null)?.message ?? "");
      // `q` is a substring search, so re-check that the line actually STARTS with the trigger —
      // "no need to !admin this" is somebody talking about it, not a call for help.
      if (!message.trim().toLowerCase().startsWith(trigger.toLowerCase())) continue;
      requests.push({ ts: e.ts, serverId: s.id, playerName: e.actorName, playerId: e.actorPlayerId, message });
    }
  }));

  // Staff actions, oldest first, as the pairing expects. Config edits are excluded: changing a
  // setting in the panel is not answering someone in game, and counting it would make a quiet
  // night look responsive.
  const actions: ResponderAction[] = audit
    .filter((a) => !a.action.startsWith("config.") && !a.action.startsWith("server."))
    .map((a) => ({ ts: a.ts, serverId: a.serverId ?? null, actorName: a.actorName, action: a.action }))
    .sort((x, y) => x.ts.localeCompare(y.ts));

  requests.sort((x, y) => x.ts.localeCompare(y.ts));
  return buildAdminResponseAnalytics(pairAdminResponses(requests, actions), tz);
}

/** userId → current display name, for resolving historical audit rows. The users table is small
 *  (a staff list), so one read per request is cheaper than joining per row. */
export async function currentActorNames(ctx: AppContext): Promise<Map<string, string>> {
  const users = await ctx.repo.users.list();
  return new Map(users.map((u) => [u.id, displayNameOf(u)]));
}

/** An audit row with both ends resolved to what a person would call them. */
export interface ReadableAudit extends AuditRow {
  /** The actor's name NOW — a Discord link or a rename propagates to every past entry. */
  actorDisplayName: string;
  /** The target's current in-game name, when the target is a player we know. */
  targetDisplayName: string | null;
  /** The target player's game id, so a reader can copy it without decoding `targetId`. */
  targetPlatformId: string | null;
}

/**
 * Resolve who did it and who it was done to, for a page of audit rows.
 *
 * Both ends were stored as whatever string the write site happened to have. That decays in two
 * ways nobody notices until they read the trail back:
 *
 *  - the ACTOR is a username frozen at write time, so an admin who later linked Discord (or was
 *    merged into another account) still shows up under the old name for everything they have ever
 *    done — and under a different name than the same person on every other screen;
 *  - the TARGET is whatever `playerName` the client sent, which for the action routes is often
 *    nothing at all. The reader then fell back to `targetType` and rendered the literal word
 *    "player" as the name of the person who was kicked.
 *
 * So neither is trusted for display. The actor is looked up in the (small) staff list, and every
 * target id in the page — a mix of internal uuids and game platform ids, depending on which route
 * wrote it — is resolved in ONE query. `actorName` and `targetName` are untouched: they are the
 * historical record of what things were called at the time, and the UI reveals them when they
 * disagree with what it shows.
 */
export async function readableAudit(ctx: AppContext, rows: AuditRow[]): Promise<ReadableAudit[]> {
  const nameById = await currentActorNames(ctx);
  const targetIds = rows.filter((r) => r.targetType === "player" && r.targetId).map((r) => r.targetId!);
  const players = targetIds.length ? await ctx.repo.players.findByAnyIds(targetIds) : [];
  const byKey = new Map<string, { name: string; platformId: string }>();
  for (const p of players) {
    const entry = { name: p.name, platformId: p.platformId };
    byKey.set(p.id, entry);
    byKey.set(p.platformId, entry);
  }
  return rows.map((r) => {
    const target = r.targetType === "player" && r.targetId ? byKey.get(r.targetId) : undefined;
    return {
      ...r,
      actorDisplayName: (r.actorUserId && nameById.get(r.actorUserId)) || r.actorName,
      // The stored name is the fallback, not the preference: it is right for a target we no longer
      // have a row for (a one-off id typed into the console), and wrong the moment they rename.
      targetDisplayName: target?.name || r.targetName || null,
      targetPlatformId: target?.platformId ?? null,
    };
  });
}

/** The actions that only reach a player who is CONNECTED right now. A ban is a standing decision
 *  and lands whether or not they are on the server; a punish, kick, message or team switch is a
 *  thing done to a body in the match. */
export const LIVE_PLAYER_ACTIONS = new Set(["message", "kick", "punish", "switch", "switch_death"]);

/**
 * Turn a game-refused admin action into words a moderator can act on.
 *
 * The game answering "no" to a punish almost always means one of two mundane things — the player
 * is not on this server, or they are not spawned in (HLL can only punish a living body). The wire
 * message for both is an opaque status line, so this asks the still-open connection for the
 * roster and says which one it was. Best-effort: if the roster read fails too, the game's own
 * message is still returned rather than nothing.
 *
 * Shared by the direct action route and the APPROVAL path, which needs it more: a request is
 * signed minutes or hours after it was filed, by which time the player has usually left — and
 * "(500) command punishPlayer failed: Unable to perform request" tells the approver nothing about
 * why their signature did nothing.
 */
export async function describeGameRefusal(
  client: { readState: (kind: "players") => Promise<unknown> },
  target: ServerRow,
  action: string,
  playerId: string,
  playerName: string,
  gameMessage: string,
): Promise<string> {
  const who = playerName || playerId;
  if (LIVE_PLAYER_ACTIONS.has(action)) {
    const online = await client.readState("players").then((raw) => {
      const list = Array.isArray(raw) ? raw : Array.isArray((raw as { players?: unknown[] })?.players) ? (raw as { players: unknown[] }).players : [];
      return new Set((list as Record<string, unknown>[]).map((pl) => rosterPlayerId(pl)));
    }).catch(() => null);
    if (online && !online.has(playerId)) {
      return `${who} is not on ${target.name} right now — a ${action} only reaches a player who is currently on this server. They may have left, or be on one of your other servers.`;
    }
    if (action === "punish" && online?.has(playerId)) {
      return `the game refused to punish ${who} (${gameMessage}). A punish only lands while the player is spawned in — not while they are dead or sitting on the deploy screen. Try again once they spawn, or kick instead.`;
    }
  }
  return `the game refused the ${action}: ${gameMessage}`;
}

export { renderActionText } from "../render-text.js";
