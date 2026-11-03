/**
 * Running the instance: staff accounts and roles, the capability catalogue, message templates, retention, plugins, layouts and host health.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { displayNameOf, publicUser, resolveAccess, type Principal } from "../auth.js";
import type { AppContext } from "../context.js";
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson, str } from "../http.js";
import { LIMIT_CATALOG, ROLE_PRESETS, canAnywhere, hashPassword, holdsOutright, type Grant } from "@app/access";
import { capabilityCatalog, capabilityDef, isUnknownCapability } from "../plugin-permissions.js";
import { pluginsKnownTo } from "../plugin-http.js";
import { MESSAGE_TEMPLATE_KINDS, RULE_PAUSE_MAX_MINUTES, RuleSectionNameTaken, rulePaused, safeTimezone, TRIM_CATEGORY_INFO, TRIM_DATASETS, kindsForCategories } from "@app/db";
import { normalizeBadgeEmoji } from "@app/db";
import { discordRest, type AccessLevel } from "@app/shared";
import { isGroupTriggerKind, isStateTriggerKind, OUT_OF_ZONE_KIND, SCHEDULE_KIND, stateTriggerAppliesTo } from "@app/rules";
import type { ChatFilterConfig, NewRule, Repository, RoleBadgeDef, RuleRow, RuleSectionRow, RuleStatusRow } from "@app/db";
import { CHAT_FILTER_MAX_WORDS, CHAT_FILTER_MAX_WORD_LEN, chatFilterActionKey, managedRuleFields, normalizeChatFilterWords, planCensorPushes } from "../chat-filter.js";
import { randomUUID } from "node:crypto";
import { SIGNABLE_ACTIONS, SIGNABLE_ACTION_LABELS, parseSignatureActions } from "@app/shared";
import { resolveLayout } from "@app/widgets";
import type { LayoutConfig, Surface } from "@app/widgets";
import { assignmentGrants, connectGameClient, effectiveOwnerIds, gameClientFor, hostMetrics, outrightGain, outrightTargetRefusal, ownAccounts, parseHours, parseRoleAssignments, parseRoleBundle, parseRuleBody, requirePrincipal, route, ruleKeyMissing, sendForbidden, trimSpecFromBody, type Route } from "./kit.js";
import { communityGuild, guildRoleIds } from "../discord-guild.js";
import { RULE_STATE_KEYS, recordVersion, ruleSnapshot, snapshotChanged, whenSaved } from "../versions.js";
import { priorOf } from "../audit-changes.js";

/**
 * Validate one grant, for both routes that write them.
 *
 * They used to validate separately and had drifted apart, in a direction that mattered. The
 * permission-matrix editor (PUT) checked the capability against the catalogue and refused to
 * server-scope one the catalogue marks unscoped; the single-grant POST checked neither. That gap was
 * reachable: `canAnywhere` — which every admin route guards with, because "can this person administer
 * users at all" is not a per-server question — ignores scope entirely. So a server-scoped
 * `admin.users` grant, which POST accepted and the editor refused, conferred user-admin everywhere.
 *
 * `group` is rejected outright. The scope type is in the schema's CHECK constraint and `resolveLevel`
 * implements it correctly, but nothing populates `ResolveContext.serverGroupIds` — there is no
 * server-group concept in the app (the groups that exist group *players*). So a group-scoped grant
 * can never apply to anything. Accepting one meant an admin could set a permission that silently did
 * nothing, and worse in the deny direction: a group-scoped `none`, intended to lock someone out of a
 * set of servers, locked them out of nothing. Better a clear refusal than a control that lies.
 */
/** A per-screen panel arrangement, stored under `panel:<viewId>` — see the layout routes. */
const isPanelSurface = (surface: string): boolean => /^panel:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(surface);

/**
 * Strict parse of a panel-layout config (the shape lib/panelPrefs keeps client-side): panel ids in
 * display order, the collapsed and hidden sets, per-panel widths in twelfths, and the two "the user
 * has decided for themselves" flags. Unknown keys are dropped and every list is bounded, so a saved
 * row can't grow past what a screenful of panels can express.
 */
function parsePanelLayout(raw: Record<string, unknown>): Record<string, unknown> | null {
  const ids = (v: unknown): string[] | null => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 200) return null;
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== "string" || !x || x.length > 80) return null;
      out.push(x);
    }
    return out;
  };
  const order = ids(raw.order), collapsed = ids(raw.collapsed), hidden = ids(raw.hidden);
  if (!order || !collapsed || !hidden) return null;
  const widths: Record<string, number> = {};
  if (raw.widths !== undefined) {
    if (!raw.widths || typeof raw.widths !== "object" || Array.isArray(raw.widths)) return null;
    const entries = Object.entries(raw.widths as Record<string, unknown>);
    if (entries.length > 200) return null;
    for (const [k, v] of entries) {
      if (!k || k.length > 80 || typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 12) return null;
      widths[k] = v;
    }
  }
  return { order, collapsed, hidden, widths, touched: raw.touched === true, reordered: raw.reordered === true };
}

/**
 * Strict parse of a widget-surface layout config ({items: [{widgetId, visible, order, size}]}).
 * The registry bounds which SURFACES exist, but the config itself used to be stored verbatim —
 * any junk under 1MB, kept forever and re-served to every future page load. Only the four known
 * fields survive, bounded; anything else is refused now rather than stored.
 */
function parseWidgetLayout(raw: Record<string, unknown>): Record<string, unknown> | null {
  const items = raw.items === undefined ? [] : raw.items;
  if (!Array.isArray(items) || items.length > 500) return null;
  const out: { widgetId: string; visible: boolean; order: number; size?: { w: number; h: number } }[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") return null;
    const { widgetId, visible, order, size } = it as Record<string, unknown>;
    if (typeof widgetId !== "string" || !widgetId || widgetId.length > 120) return null;
    if (typeof visible !== "boolean" || typeof order !== "number" || !Number.isFinite(order)) return null;
    const entry: (typeof out)[number] = { widgetId, visible, order };
    if (size !== undefined) {
      const s = size as Record<string, unknown>;
      if (!s || typeof s !== "object" || typeof s.w !== "number" || typeof s.h !== "number"
        || !Number.isInteger(s.w) || !Number.isInteger(s.h) || s.w < 1 || s.w > 12 || s.h < 1 || s.h > 8) return null;
      entry.size = { w: s.w, h: s.h };
    }
    out.push(entry);
  }
  return { items: out };
}

/** Validate a new Edit VIP duration preset. Returns the parsed input, or an error string. */
function parseVipPreset(body: Record<string, unknown>): { kind: "add" | "pause"; label: string; days: number; hours: number; sortOrder?: number } | string {
  const kind = str(body.kind).trim();
  if (kind !== "add" && kind !== "pause") return "kind must be 'add' or 'pause'";
  const label = str(body.label).trim();
  if (!label) return "label is required";
  if (label.length > 80) return "label too long (max 80)";
  const days = Number(body.days ?? 0);
  const hours = Number(body.hours ?? 0);
  if (!Number.isInteger(days) || days < 0 || days > 3650) return "days must be a whole number between 0 and 3650";
  if (!Number.isInteger(hours) || hours < 0 || hours > 8760) return "hours must be a whole number between 0 and 8760";
  if (days === 0 && hours === 0) return "a preset must add some time — set days and/or hours";
  return { kind, label, days, hours, ...(body.sortOrder !== undefined ? { sortOrder: Number(body.sortOrder) || 0 } : {}) };
}

const grantRowKey = (g: { capability: string; scopeType: string; scopeId: string | null; level: string }) =>
  `${g.capability}|${g.scopeType}|${g.scopeId ?? ""}|${g.level}`;

function validateGrant(
  g: { capability?: unknown; scopeType?: unknown; scopeId?: unknown; level?: unknown },
  serverIds: Set<string>,
  held: ReadonlySet<string> = new Set(),
): { error: string } | { value: { capability: string; scopeType: "global" | "server"; scopeId: string | null; level: "none" | "read" | "write" } } {
  const capability = str(g.capability).trim();
  const scopeType = (str(g.scopeType) || "global") as "global" | "server" | "group";
  const level = str(g.level) as "none" | "read" | "write";
  const scopeId = scopeType === "global" ? null : str(g.scopeId).trim();

  if (!capability) return { error: "capability is required" };
  if (isUnknownCapability(capability)) {
    // A permission nothing loaded declares — a plugin's, while it isn't running. The editor sends
    // back every row the account holds, so the one it already holds, exactly as stored, goes
    // through as it is; anything else naming it is refused.
    const row = { capability, scopeType: scopeType as "global" | "server", scopeId, level };
    return held.has(grantRowKey(row)) ? { value: row } : { error: `unknown capability: ${capability}` };
  }
  if (scopeType === "group") return { error: "group-scoped grants are not supported — there are no server groups, so the grant would never apply" };
  if (!["global", "server"].includes(scopeType)) return { error: "scopeType must be global or server" };
  if (!["none", "read", "write"].includes(level)) return { error: "level must be none, read or write" };
  if (scopeType === "server") {
    if (!scopeId) return { error: "scopeId is required for a server-scoped grant" };
    if (!serverIds.has(scopeId)) return { error: `unknown server: ${scopeId}` };
    // "*" is exempt: a server-scoped wildcard is "full control of this one server", which is a real
    // grant. Any other capability the catalogue marks unscoped is community-wide, and scoping it
    // produces a grant that reads as limited and does not behave that way.
    if (capability !== "*" && !capabilityDef(capability)?.scoped) {
      return { error: `${capability} cannot be scoped per server` };
    }
  }
  return { value: { capability, scopeType: scopeType as "global" | "server", scopeId, level } };
}

/** Rule role-gate ids that are NOT in the community Discord server, when the list is readable —
 *  a gate saved against the wrong server's roles would silently fire for nobody. */
async function strayRoleGates(repo: Parameters<typeof communityGuild>[0], roleIds: string[]): Promise<string[]> {
  if (!roleIds.length) return [];
  const community = await communityGuild(repo);
  const known = await guildRoleIds(community.guildId);
  return known ? roleIds.filter((id) => !known.has(id)) : [];
}

/** Does this rule name a player group that is not there? Group triggers and schedules name one; an
 *  id the store cannot even parse is as missing as one that was deleted. */
async function ruleGroupMissing(repo: Repository, rule: { eventKind: string; params?: Record<string, unknown> | null }): Promise<boolean> {
  if (!isGroupTriggerKind(rule.eventKind) && rule.eventKind !== SCHEDULE_KIND) return false;
  const id = String((rule.params ?? {}).groupId ?? "").trim();
  return !id || !(await repo.playerGroups.get(id).catch(() => null));
}

/**
 * The section a rule body names: undefined when the body says nothing about it (leave it be),
 * null for "no section", the section when it exists, an error when it does not.
 */
async function ruleSectionFrom(repo: Repository, raw: unknown): Promise<RuleSectionRow | null | undefined | { error: string }> {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const id = str(raw);
  const section = (await repo.ruleSections.list()).find((x) => x.id === id);
  return section ?? { error: "that rule section no longer exists — refresh the page" };
}

/**
 * Everything a rule must pass to be saved beyond its own shape: the keys its steps need, a pinned
 * server that exists and a trigger that applies to its game, role gates in the community Discord,
 * a zone set and a player group that still exist. One list for every way a rule is saved — made,
 * edited, or put back from its history — so no door is laxer than another.
 */
async function ruleSaveRefusal(ctx: AppContext, grants: Grant[], value: NewRule): Promise<{ status: number; message: string } | { capability: string; serverId: string | null } | null> {
  const missing = ruleKeyMissing(grants, value);
  // The rule's server is where the key is missing — and where a request for it must be signed.
  if (missing) return { capability: missing, serverId: value.serverId ?? null };
  if (value.serverId) {
    const target = await ctx.repo.servers.findById(value.serverId);
    if (!target) return { status: 404, message: "server not found" };
    // A state trigger pinned to a game it doesn't apply to would save fine and then detect
    // nothing forever — worse, role ids collide across games (Vietnam's Pilot is WW2's
    // artillery Gunner), which is why the worker refuses to run it there. Refuse the save
    // instead of storing a rule that can only ever be a mystery.
    if (isStateTriggerKind(value.eventKind) && !stateTriggerAppliesTo(value.eventKind, target.game)) {
      return { status: 400, message: `${value.eventKind} does not apply to ${target.game} — this trigger's vehicles don't exist in that game. Pin the rule to a server of the right game, or leave it community-wide (it will run only where it applies).` };
    }
  }
  const strays = await strayRoleGates(ctx.repo, value.requireRoleIds ?? []);
  if (strays.length) return { status: 400, message: `role ${strays.join(", ")} is not in the community Discord server — a rule gated on it would never fire. Pick the role again from the list.` };
  // The zone trigger references a library record by id; a dangling reference would save fine
  // and then enforce nothing forever, so it is refused here like a stray role gate.
  if (value.eventKind === OUT_OF_ZONE_KIND && !(await ctx.repo.mapZones.get(String((value.params ?? {}).zoneSet ?? "")))) {
    return { status: 400, message: "that zone set no longer exists — pick one under Auto settings → Map zones" };
  }
  // A group rule names its group by id, and a dangling one would fire for nobody, forever.
  if (await ruleGroupMissing(ctx.repo, value)) return { status: 400, message: "that player group no longer exists — pick one under Players → Groups" };
  return null;
}
const sendRefusal = (res: Parameters<typeof sendError>[0], r: { status: number; message: string } | { capability: string; serverId: string | null }) =>
  ("capability" in r ? sendForbidden(res, r.capability, "write", { serverId: r.serverId }) : sendError(res, r.status, r.message));

/*
 * A stored rule as a request body parseRuleBody can re-derive it from — the shared half of every
 * merge-then-revalidate edit (the PATCH route, the chat filter's managed rules).
 *
 * EVERY field the validator reads has to appear here, or an edit destroys it. parseRuleBody
 * re-derives the whole rule from what it is handed, and an absent key is not "leave it alone" to
 * it — it is the default. A field missing from this list is silently reset by any edit at all:
 * the escalation ladder once was, so renaming a rule wiped its "then punish, then kick" — no
 * error, no audit line, just a rule that quietly stopped escalating.
 */
function ruleBodyFrom(existing: RuleRow): Record<string, unknown> {
  return {
    name: existing.name, enabled: existing.enabled, serverId: existing.serverId, eventKind: existing.eventKind,
    match: existing.match, threshold: existing.threshold, windowSec: existing.windowSec, action: existing.action,
    reason: existing.reason, hours: existing.hours, delaySec: existing.delaySec, vipMinutes: existing.vipMinutes,
    vipCooldownMinutes: existing.vipCooldownMinutes, requireRoleIds: existing.requireRoleIds,
    immuneTags: existing.immuneTags, immuneRoleIds: existing.immuneRoleIds, immuneLevel: existing.immuneLevel, dryRun: existing.dryRun,
    escalateActions: existing.escalateActions, escalateResetMinutes: existing.escalateResetMinutes,
    alertEnabled: existing.alertEnabled, alertChannelId: existing.alertChannelId,
    params: existing.params, activeHours: existing.activeHours,
    playersMin: existing.playersMin, playersMax: existing.playersMax, breakerLimit: existing.breakerLimit,
    matchMinutesMin: existing.matchMinutesMin, matchMinutesMax: existing.matchMinutesMax, countPerMatch: existing.countPerMatch,
    requireTags: existing.requireTags, capCount: existing.capCount, capPeriod: existing.capPeriod,
    actionTag: existing.actionTag, points: existing.points,
  };
}

/**
 * The guards every change to ONE account's access answers to, judged on what it EFFECTIVELY holds
 * before and after — personal grants plus every role, each at its scope, as resolveAccess builds
 * them. Rows cannot answer these: a global "*" row at none is a lockout, not an owner, and a lifted
 * veto changes what someone holds without adding a row. Returns the refusal, or null.
 */
async function accessChangeRefusal(
  ctx: AppContext, p: Principal, userId: string, before: Grant[], after: Grant[],
): Promise<{ status: number; message: string } | null> {
  // An account that outranks the actor is not theirs to change at all — not even to take power
  // away: demoting an owner (or adding a veto to one) and THEN resetting the account would reach
  // the owner's sign-in by two steps where one is refused.
  const outranked = await targetRefusal(ctx, p, userId, before);
  if (outranked) return { status: 403, message: outranked };
  const gained = outrightGain(p.grants, before, after);
  if (gained) return { status: 403, message: gained };
  // Lockout guards: never let the panel talk anyone into an unrecoverable state.
  if (holdsOutright(before, "*", "write") && !holdsOutright(after, "*", "write")) {
    const owners = await effectiveOwnerIds(ctx.repo);
    owners.delete(userId);
    if (!owners.size) return { status: 400, message: "cannot remove all-access from the only owner — make another user owner first" };
  }
  // The same scope-blind question every user-admin route asks, so "you would lose this" means it.
  // Asked of the signer too while a request is carried out: one naming the signer's own account
  // must not demote them. Only a LOSS is refused — a requester who never held it may still be
  // given something else.
  if (ownAccounts(p).has(userId) && canAnywhere(before, "admin.users", "write") && !canAnywhere(after, "admin.users", "write")) {
    return { status: 400, message: "you cannot remove your own user-admin access" };
  }
  return null;
}

/**
 * Refuses acting on `targetId` when it outranks the actor: it holds an outright power the actor
 * does not (outrightTargetRefusal), or it is the install's setup account. The setup account's
 * server-lifecycle keys answer to identity (users.firstUserId), not to any grant — so even demoted,
 * it is a key a user admin must not be able to reach by resetting it, signing it out, merging it
 * or re-granting it. The account itself and owners may. Null when the actor may.
 */
async function targetRefusal(ctx: AppContext, p: Principal, targetId: string, targetGrants: Grant[]): Promise<string | null> {
  const outranks = outrightTargetRefusal(p.grants, targetGrants);
  if (outranks) return outranks;
  if (!ownAccounts(p).has(targetId) && !holdsOutright(p.grants, "*", "write") && targetId === await ctx.repo.users.firstUserId()) {
    return "this is the install's setup account — only an owner can change it";
  }
  return null;
}

/** A role, or a Discord mapping, that hands out a power the actor does not hold outright is not
 *  theirs to change: editing it could take that power from people who hold it (a veto added to the
 *  owners' role), and deleting it certainly does. */
const roleOutranks = (actor: Grant[], grants: Grant[]): string | null =>
  outrightTargetRefusal(actor, grants) && "this role carries permissions on every server that you do not — only someone who holds them too can change it";

/** A role's bundle as one source held everywhere — the most it can confer on any holder. Roles only
 *  ever add across sources, and a role held on one server confers nothing everywhere. */
const heldEverywhere = (grants: { capability: string; level: AccessLevel }[]): Grant[] =>
  grants.map((g) => ({ capability: g.capability, level: g.level, scopeType: "global", scopeId: null, source: "role" }));

/**
 * Turning Discord management ON hands an account's roles to the Discord role map: the next sweep or
 * Discord sign-in replaces them with whatever the person's Discord roles map to. Which roles those
 * will be cannot be known here — they are handed out in Discord, outside the panel, at any time — so
 * it is judged as if the account held every mapped one. An owner who demoted someone by switching
 * them to manual is not undone by a user admin switching them back. Null when it may go.
 */
async function discordManagementRefusal(ctx: AppContext, p: Principal, userId: string): Promise<string | null> {
  const mappings = await ctx.repo.discordRoleMap.list();
  const [roles, access] = await Promise.all([
    ctx.repo.roles.getMany([...new Set(mappings.map((m) => m.roleId))]),
    resolveAccess(ctx.repo, userId),
  ]);
  // A mapping row IS an assignment: a role, and the server it applies on (null for everywhere).
  const mapped = assignmentGrants(mappings, roles);
  const gained = outrightGain(p.grants, access.grants, [...access.personalGrants, ...mapped]);
  return gained && `${gained} — the Discord role map can hand this account a role that carries it`;
}


/**
 * A managed chat-filter rule as the Chat filter screen reports it: its own switch, and the two
 * things that hold a rule without touching that switch — its section's master switch, and a pause
 * still running. Each is undone in a different place (Save here puts the rule's own switch back; a
 * section and a pause are undone under Rules), so the screen is told which. Null when it is gone.
 */
async function chatFilterRuleState(repo: Repository, id: string | null): Promise<{ id: string; enabled: boolean; sectionOff: boolean; pausedUntil: string | null } | null> {
  if (!id) return null;
  const rule = await repo.enforcerRules.get(id).catch(() => null);
  return rule ? { id: rule.id, enabled: rule.enabled, sectionOff: rule.sectionOff, pausedUntil: rulePaused(rule) ? rule.pausedUntil : null } : null;
}

/** The app-wide settings the Discord bot's setup tab saves — the public Discord server, the
 *  approvals relay and the community badges — which answer to discord.setup, not admin.users. */
const DISCORD_APP_CONFIG = new Set(["communityGuildId", "roleBadges", "approvalsChannelId", "approvalsMentionRoleId"]);

export const adminRoutes: Route[] = [
  route("GET", "/api/health", async (_req, res) => sendJson(res, 200, { status: "ok", phase: 4 })),

  // Newer versions (updates.ts), for the account made at setup alone: the person who installed
  // the panel and runs its start script, not everyone with owner-level access. Anyone else is told
  // there is nothing for them.
  route("GET", "/api/updates", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (p.preview || p.user.id !== await ctx.repo.users.firstUserId()) return sendJson(res, 200, { shown: false });
    sendJson(res, 200, { shown: true, ...(await ctx.updates.status()) });
  }),

  // Host metrics for the box the panel runs on (same idea as CRCON's footer, which reports its own
  // self-hosted/VPS machine — not the game host). Read from node:os + statfs. Auth-only.
  route("GET", "/api/health/metrics", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "audit.trail", "read")) return sendForbidden(res, "audit.trail", "read");
    sendJson(res, 200, await hostMetrics());
  }),

  // Background-service health for the System view. Combines the API's own in-process services
  // (live) with worker/other-process heartbeats from the DB (classified by freshness).
  route("GET", "/api/health/services", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "audit.trail", "read")) return sendForbidden(res, "audit.trail", "read");
    const now = Date.now();
    const STALE_MS = 60_000;
    type Svc = { name: string; group: string; status: "running" | "degraded" | "down"; detail: Record<string, unknown>; updatedAt?: string };
    const services: Svc[] = [];

    // In-process (this API): reported live.
    services.push({ name: "api", group: "in-process", status: "running", detail: { node: process.version, phase: 4 } });
    services.push({ name: "enforcer", group: "in-process", status: ctx.enforcer ? "running" : "down", detail: {} });
    services.push({ name: "player_triggers", group: "in-process", status: ctx.playerTriggerRunner ? "running" : "down", detail: {} });
    // Counted as Loaded plugins lists them for this viewer: an unlisted plugin is not given away as
    // a number to someone the list does not name it to.
    services.push({ name: "plugins", group: "in-process", status: "running", detail: { loaded: pluginsKnownTo(ctx.pluginRuntime.host.list(), ctx.pluginRuntime.pages.list(), p).length } });
    const redis = !!process.env.REDIS_URL;
    services.push({ name: "event_bus", group: "in-process", status: redis ? "running" : "degraded", detail: { backend: redis ? "redis" : "in-process (no REDIS_URL)" } });
    // "Are we being rate limited by Discord?" — a question that used to be answerable only by
    // reading logs. A global pause is the one worth flagging: it stops every Discord feature at
    // once, so it is degraded, not a curiosity.
    const dr = discordRest().stats();
    services.push({
      name: "discord_api", group: "in-process",
      status: dr.globalPauses > 0 ? "degraded" : "running",
      detail: {
        rateLimitHits: dr.rateLimitHits, globalPauses: dr.globalPauses,
        queued: dr.queued, buckets: dr.buckets,
        backgroundHeld: dr.backgroundHeldUntilMs > now ? `${Math.ceil((dr.backgroundHeldUntilMs - now) / 1000)}s` : "no",
      },
    });
    let dbOk = true;
    try { await ctx.repo.servers.list(); } catch { dbOk = false; }
    services.push({ name: "database", group: "in-process", status: dbOk ? "running" : "down", detail: { backend: process.env.DATABASE_URL ? "postgres" : "memory" } });

    // Other processes: from heartbeats. Expected worker services show "down" if never seen.
    const beats = await ctx.repo.heartbeats.list();
    const byName = new Map(beats.map((b) => [b.name, b]));
    const classify = (b: { status: string; updatedAt: string }): "running" | "degraded" | "down" => {
      if (b.status !== "running") return b.status === "stopped" ? "down" : "down"; // stopped/fatal/exited → down
      return now - Date.parse(b.updatedAt) > STALE_MS ? "degraded" : "running";
    };
    for (const expected of ["ingestion", "vip_sweep"]) {
      const b = byName.get(expected);
      if (!b) { services.push({ name: expected, group: "worker", status: "down", detail: { note: "no heartbeat — worker not running?" } }); continue; }
      services.push({ name: b.name, group: "worker", status: classify(b), detail: { ...(b.detail ?? {}), lastSeenSec: Math.round((now - Date.parse(b.updatedAt)) / 1000) }, updatedAt: b.updatedAt });
      byName.delete(expected);
    }
    for (const b of byName.values()) {
      services.push({ name: b.name, group: "worker", status: classify(b), detail: { ...(b.detail ?? {}), lastSeenSec: Math.round((now - Date.parse(b.updatedAt)) / 1000) }, updatedAt: b.updatedAt });
    }

    const summary = {
      running: services.filter((s) => s.status === "running").length,
      degraded: services.filter((s) => s.status === "degraded").length,
      down: services.filter((s) => s.status === "down").length,
    };
    sendJson(res, 200, { services, summary });
  }),

  // --- Message/reason template library (the editable presets behind the pickers) ---
  // Anyone who can act (server.view) can READ them (the pickers need them); managing needs server.config.
  route("GET", "/api/templates", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    const kind = new URL(req.url ?? "", "http://x").searchParams.get("kind") ?? undefined;
    if (kind && !MESSAGE_TEMPLATE_KINDS.includes(kind as typeof MESSAGE_TEMPLATE_KINDS[number])) return sendError(res, 400, "unknown kind");
    sendJson(res, 200, { templates: await ctx.repo.templates.list(kind), kinds: MESSAGE_TEMPLATE_KINDS });
  }),

  /**
   * Signatures — the two optional lines appended to whatever a player is shown.
   *
   * They live beside the templates because they are the same job: the words a player reads. A
   * template is what you say; a signature is who said it and where to go next.
   *
   * Read is open to anyone who can act (server.view), because the action dialogs preview what the
   * player will actually receive and a preview that silently omits the signature is a lie. Editing
   * is templates.manage — the same grant that owns the rest of the wording.
   */
  /**
   * The community's clock (docs: one zone, set once).
   *
   * Read is open to every signed-in account. Every staff screen reads its clock from here — a page
   * that cannot ask has to guess, and guessed UTC for a shop manager or an analyst who sees no
   * server — and the Discord bot's setup tab shows the values it saves. Nothing kept here is a
   * secret: a time zone, Discord ids, badge emoji, backup hours. Editing is admin.users: changing it
   * moves when the daily claim resets and how every schedule reads. The Discord settings kept in
   * the same store answer to discord.setup instead (DISCORD_APP_CONFIG).
   */
  route("GET", "/api/app-config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    sendJson(res, 200, { config: await ctx.repo.appConfig.get() });
  }),

  route("PUT", "/api/app-config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const body = await readJsonBody(req);
    /*
     * One store, two permissions. The Discord settings kept here — the public Discord server, the
     * approvals relay and the community badges — sit on the bot's setup tab and answer to the bot's
     * setup permission; the rest (the clock, backups, the request builder's settings) to user & role
     * admin, as all of it did before the bot's setup was carved off. A save is judged by what it sends.
     */
    const sent = Object.keys(body).filter((k) => body[k] !== undefined);
    const needs = new Set(sent.map((k) => (DISCORD_APP_CONFIG.has(k) ? "discord.setup" : "admin.users")));
    if (!needs.size) needs.add("admin.users");
    for (const cap of needs) if (!canAnywhere(p.grants, cap, "write")) return sendForbidden(res, cap, "write");
    const patch: { timezone?: string; communityGuildId?: string; roleBadges?: RoleBadgeDef[]; approvalsChannelId?: string; approvalsMentionRoleId?: string; requestCeilingRoleId?: string; requestDraftTtlHours?: number; autoBackupEnabled?: boolean; autoBackupHour?: number; autoBackupKeep?: number } = {};
    // Nightly automatic backups (the worker's sweep reads these).
    if (body.autoBackupEnabled !== undefined) {
      if (typeof body.autoBackupEnabled !== "boolean") return sendError(res, 400, "autoBackupEnabled must be true or false");
      patch.autoBackupEnabled = body.autoBackupEnabled;
    }
    if (body.autoBackupHour !== undefined) {
      const n = Number(body.autoBackupHour);
      if (!Number.isInteger(n) || n < 0 || n > 23) return sendError(res, 400, "autoBackupHour is an hour of the community's day, 0–23");
      patch.autoBackupHour = n;
    }
    if (body.autoBackupKeep !== undefined) {
      const n = Number(body.autoBackupKeep);
      // 60 nightly archives is two months of history; past that the folder is a disk-eater and a
      // copy job, not a safety net.
      if (!Number.isInteger(n) || n < 1 || n > 60) return sendError(res, 400, "autoBackupKeep is how many automatic archives to keep, 1–60");
      patch.autoBackupKeep = n;
    }
    // The approvals relay destination — optional, empty = off. Same id shape the alert channels use.
    for (const key of ["approvalsChannelId", "approvalsMentionRoleId"] as const) {
      if (body[key] !== undefined) {
        const v = str(body[key]).trim();
        if (v && !/^\d{5,25}$/.test(v)) return sendError(res, 400, `${key} is not a Discord id (right-click the ${key === "approvalsChannelId" ? "channel" : "role"} → Copy ID)`);
        patch[key] = v;
      }
    }
    // The request builder's visibility ceiling: "" = no ceiling (everything readable), otherwise
    // an existing PANEL role — validated here so the elevation never points at a ghost.
    if (body.requestCeilingRoleId !== undefined) {
      const v = str(body.requestCeilingRoleId).trim();
      if (v && !(await ctx.repo.roles.get(v))) return sendError(res, 400, "requestCeilingRoleId does not name an existing role");
      patch.requestCeilingRoleId = v;
    }
    // How long an unsubmitted draft survives untouched before the sweep deletes it. 0 = forever.
    if (body.requestDraftTtlHours !== undefined) {
      const n = Number(body.requestDraftTtlHours);
      if (!Number.isInteger(n) || n < 0 || n > 8760) return sendError(res, 400, "requestDraftTtlHours must be a whole number of hours, 0 (keep forever) to 8760 (a year)");
      patch.requestDraftTtlHours = n;
    }
    if (body.timezone !== undefined) {
      const tz = str(body.timezone).trim();
      // Checked here rather than swallowed by the store's fallback: a typo silently becoming UTC
      // is precisely the failure this whole setting exists to end.
      if (safeTimezone(tz, "") === "") return sendError(res, 400, `"${tz}" is not a time zone the runtime knows (use an IANA name like America/New_York)`);
      patch.timezone = tz;
    }
    if (body.communityGuildId !== undefined) {
      const gid = str(body.communityGuildId).trim();
      if (gid && !/^\d{5,25}$/.test(gid)) return sendError(res, 400, "communityGuildId must be a numeric Discord server id (or blank to use the staff server)");
      patch.communityGuildId = gid;
    }
    if (body.roleBadges !== undefined) {
      if (!Array.isArray(body.roleBadges)) return sendError(res, 400, "roleBadges must be an array");
      if (body.roleBadges.length > 20) return sendError(res, 400, "at most 20 badges — past that the marks column is a ransom note");
      const badges: RoleBadgeDef[] = [];
      for (const raw of body.roleBadges as Record<string, unknown>[]) {
        // Measured and trimmed by GRAPHEME, never by .length: a family emoji is 11 UTF-16 units
        // and a flag is 4, so a code-unit cap rejects perfectly ordinary emoji and — worse — cuts
        // them in half, which stores the hatched .notdef box beside somebody's name. normalize
        // also repairs a value some other length cap already mangled on the way here.
        const emoji = normalizeBadgeEmoji(str(raw?.emoji), 2);
        const label = str(raw?.label).trim();
        if (!emoji) return sendError(res, 400, "every badge needs an emoji");
        // A generous backstop against a pasted essay; the grapheme slice above already did the
        // real work, so this only ever fires on something pathological.
        if (str(raw?.emoji).length > 64) return sendError(res, 400, "that is not an emoji — paste a single character");
        if (label.length > 60) return sendError(res, 400, "badge labels are at most 60 characters");
        if (!Array.isArray(raw?.roleIds)) return sendError(res, 400, "each badge needs roleIds (an array of Discord role ids)");
        const roleIds = [...new Set((raw.roleIds as unknown[]).map((r) => str(r).trim()).filter(Boolean))];
        if (!roleIds.length) return sendError(res, 400, `badge ${emoji} has no roles — it would never appear on anyone`);
        if (roleIds.length > 20) return sendError(res, 400, `badge ${emoji} lists more than 20 roles`);
        for (const rid of roleIds) {
          if (!/^\d{5,25}$/.test(rid)) return sendError(res, 400, `badge ${emoji}: "${rid}" is not a Discord role id`);
        }
        // The id survives edits when the client sends it back, so a badge keeps its identity; a
        // new row gets one here rather than trusting the browser to invent unique ids.
        const id = /^[0-9a-f-]{8,40}$/i.test(str(raw?.id).trim()) ? str(raw.id).trim() : randomUUID();
        badges.push({ id, emoji, label, roleIds });
      }
      patch.roleBadges = badges;
    }
    const before = await ctx.repo.appConfig.get();
    const cfg = await ctx.repo.appConfig.set(patch);
    if (cfg.timezone !== before.timezone) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "app.timezone",
        targetType: "system", targetId: "app-config",
        summary: `set the community time zone to ${cfg.timezone} (was ${before.timezone})`,
        data: { from: before.timezone, to: cfg.timezone },
      });
    }
    if (cfg.communityGuildId !== before.communityGuildId) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "app.community-guild",
        targetType: "system", targetId: "app-config",
        summary: cfg.communityGuildId
          ? `set the public Discord server to ${cfg.communityGuildId}`
          : "cleared the public Discord server (the staff server is used for both)",
        data: { from: before.communityGuildId, to: cfg.communityGuildId },
      });
    }
    if (cfg.approvalsChannelId !== before.approvalsChannelId) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "app.approvals-relay",
        targetType: "system", targetId: "app-config",
        summary: cfg.approvalsChannelId
          ? `pointed the approvals relay at Discord channel ${cfg.approvalsChannelId}`
          : "switched the approvals relay off",
        data: { from: before.approvalsChannelId, to: cfg.approvalsChannelId },
      });
    }
    if (cfg.requestCeilingRoleId !== before.requestCeilingRoleId) {
      const named = cfg.requestCeilingRoleId ? (await ctx.repo.roles.get(cfg.requestCeilingRoleId))?.name : null;
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "app.request-ceiling",
        targetType: "system", targetId: "app-config",
        summary: cfg.requestCeilingRoleId
          ? `capped the request builder's view at what “${named ?? cfg.requestCeilingRoleId}” can see`
          : "removed the request builder's view ceiling (builders see everything readable)",
        data: { from: before.requestCeilingRoleId, to: cfg.requestCeilingRoleId },
      });
    }
    if (cfg.requestDraftTtlHours !== before.requestDraftTtlHours) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "app.request-ceiling",
        targetType: "system", targetId: "app-config",
        summary: cfg.requestDraftTtlHours
          ? `unsubmitted request drafts now expire after ${cfg.requestDraftTtlHours}h untouched`
          : "unsubmitted request drafts are now kept forever",
        data: { from: before.requestDraftTtlHours, to: cfg.requestDraftTtlHours },
      });
    }
    if (patch.roleBadges !== undefined && JSON.stringify(cfg.roleBadges) !== JSON.stringify(before.roleBadges)) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "app.role-badges",
        targetType: "system", targetId: "app-config",
        summary: cfg.roleBadges.length
          ? `updated the community role badges — ${cfg.roleBadges.map((b) => b.emoji).join(" ")} (${cfg.roleBadges.length})`
          : "removed all community role badges",
        data: { from: before.roleBadges, to: cfg.roleBadges },
      });
    }
    sendJson(res, 200, { config: cfg });
  }),

  route("GET", "/api/signatures", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    sendJson(res, 200, { ...(await ctx.repo.signatures.get()), signable: SIGNABLE_ACTIONS.map((id) => ({ id, label: SIGNABLE_ACTION_LABELS[id] })) });
  }),

  route("PUT", "/api/signatures", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "templates.manage", "write")) return sendForbidden(res, "templates.manage", "write");
    const body = await readJsonBody(req);
    const patch: { staffLine?: string; customLine?: string; actions?: ReturnType<typeof parseSignatureActions> } = {};
    for (const k of ["staffLine", "customLine"] as const) {
      if (body[k] === undefined) continue;
      const v = str(body[k]).trim();
      // The game truncates a long reason silently. A signature that pushes the actual reason off
      // the end would be worse than no signature at all.
      if (v.length > 200) return sendError(res, 400, `${k} must be 200 characters or fewer`);
      patch[k] = v;
    }
    // Unknown action keys are dropped rather than rejected: the signable list can shrink, and a
    // stale key in a saved config should not make the page unsavable.
    if (body.actions !== undefined) patch.actions = parseSignatureActions(body.actions);
    const cfg = await ctx.repo.signatures.set(patch);
    const on = Object.entries(cfg.actions).filter(([, u]) => u.staff || u.custom).map(([a]) => a);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "signatures.update",
      summary: `updated the player-facing signatures (${on.length ? `signing ${on.join(", ")}` : "nothing signed"})`,
      data: { actions: cfg.actions },
    });
    sendJson(res, 200, cfg);
  }),

  route("POST", "/api/templates", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "templates.manage", "write")) return sendForbidden(res, "templates.manage", "write");
    const body = await readJsonBody(req);
    const kind = str(body.kind).trim();
    if (!MESSAGE_TEMPLATE_KINDS.includes(kind as typeof MESSAGE_TEMPLATE_KINDS[number])) return sendError(res, 400, `kind must be one of: ${MESSAGE_TEMPLATE_KINDS.join(", ")}`);
    const text = str(body.body).trim();
    if (!text) return sendError(res, 400, "body is required");
    if (text.length > 1000) return sendError(res, 400, "body too long (max 1000)");
    const template = await ctx.repo.templates.create({ kind, title: boundedText(body.title, TEXT_MAX.name, "title"), body: text, sortOrder: Number(body.sortOrder ?? 0) || 0 });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "template.create",
      targetType: "template", targetId: template.id, targetName: template.title,
      summary: `added the ${template.kind} template "${template.title}"`,
      data: { kind: template.kind },
    });
    sendJson(res, 201, { template });
  }),

  route("PATCH", "/api/templates/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "templates.manage", "write")) return sendForbidden(res, "templates.manage", "write");
    const body = await readJsonBody(req);
    const patch: { kind?: string; title?: string; body?: string; sortOrder?: number } = {};
    if (body.kind !== undefined) {
      const kind = str(body.kind).trim();
      if (!MESSAGE_TEMPLATE_KINDS.includes(kind as typeof MESSAGE_TEMPLATE_KINDS[number])) return sendError(res, 400, "unknown kind");
      patch.kind = kind;
    }
    if (body.title !== undefined) patch.title = boundedText(body.title, TEXT_MAX.name, "title");
    if (body.body !== undefined) {
      const text = str(body.body).trim();
      if (!text) return sendError(res, 400, "body cannot be empty");
      if (text.length > 1000) return sendError(res, 400, "body too long (max 1000)");
      patch.body = text;
    }
    if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder) || 0;
    const template = await ctx.repo.templates.update(params.id!, patch);
    if (!template) return sendError(res, 404, "template not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "template.update",
      targetType: "template", targetId: template.id, targetName: template.title,
      summary: `edited the ${template.kind} template "${template.title}"`,
      data: { changed: Object.keys(patch) },
    });
    sendJson(res, 200, { template });
  }),

  route("DELETE", "/api/templates/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "templates.manage", "write")) return sendForbidden(res, "templates.manage", "write");
    const before = (await ctx.repo.templates.list()).find((t) => t.id === params.id);
    const ok = await ctx.repo.templates.remove(params.id!);
    if (!ok) return sendError(res, 404, "template not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "template.delete",
      targetType: "template", targetId: params.id!, targetName: before?.title,
      summary: `deleted the template "${before?.title ?? params.id}"`,
      data: { kind: before?.kind ?? null, body: before?.body ?? null },
    });
    sendJson(res, 200, { ok: true });
  }),

  // --- VIP duration presets (the calculator buttons on the Edit VIP popup) ---
  // Readable by anyone who can use either tab of the popup; editing is its own capability so the
  // community decides who curates the button set.
  route("GET", "/api/vip-presets", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "vip.grant", "read") && !canAnywhere(p.grants, "vip.pause", "read") && !canAnywhere(p.grants, "vip.presets", "read"))
      return sendForbidden(res, "vip.grant", "read");
    sendJson(res, 200, { presets: await ctx.repo.vipPresets.list() });
  }),

  route("POST", "/api/vip-presets", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "vip.presets", "write")) return sendForbidden(res, "vip.presets", "write");
    const body = await readJsonBody(req);
    const parsed = parseVipPreset(body);
    if (typeof parsed === "string") return sendError(res, 400, parsed);
    const preset = await ctx.repo.vipPresets.create(parsed);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "vip_preset.create",
      targetType: "setting", targetId: preset.id, targetName: preset.label,
      summary: `added the VIP preset "${preset.label}"`,
      data: { days: preset.days, hours: preset.hours },
    });
    sendJson(res, 201, { preset });
  }),

  route("PATCH", "/api/vip-presets/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "vip.presets", "write")) return sendForbidden(res, "vip.presets", "write");
    const body = await readJsonBody(req);
    const patch: { label?: string; days?: number; hours?: number; sortOrder?: number } = {};
    if (body.label !== undefined) {
      const label = str(body.label).trim();
      if (!label) return sendError(res, 400, "label cannot be empty");
      if (label.length > 80) return sendError(res, 400, "label too long (max 80)");
      patch.label = label;
    }
    if (body.days !== undefined) {
      const days = Number(body.days);
      if (!Number.isInteger(days) || days < 0 || days > 3650) return sendError(res, 400, "days must be a whole number between 0 and 3650");
      patch.days = days;
    }
    if (body.hours !== undefined) {
      const hours = Number(body.hours);
      if (!Number.isInteger(hours) || hours < 0 || hours > 8760) return sendError(res, 400, "hours must be a whole number between 0 and 8760");
      patch.hours = hours;
    }
    if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder) || 0;
    if (patch.days !== undefined || patch.hours !== undefined) {
      const current = (await ctx.repo.vipPresets.list()).find((r) => r.id === params.id);
      if (!current) return sendError(res, 404, "preset not found");
      if ((patch.days ?? current.days) === 0 && (patch.hours ?? current.hours) === 0)
        return sendError(res, 400, "a preset must add some time — set days and/or hours");
    }
    const preset = await ctx.repo.vipPresets.update(params.id!, patch);
    if (!preset) return sendError(res, 404, "preset not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "vip_preset.update",
      targetType: "setting", targetId: preset.id, targetName: preset.label,
      summary: `edited the VIP preset "${preset.label}"`,
      data: { changed: Object.keys(patch), days: preset.days, hours: preset.hours },
    });
    sendJson(res, 200, { preset });
  }),

  route("DELETE", "/api/vip-presets/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "vip.presets", "write")) return sendForbidden(res, "vip.presets", "write");
    const before = (await ctx.repo.vipPresets.list()).find((r) => r.id === params.id);
    const ok = await ctx.repo.vipPresets.remove(params.id!);
    if (!ok) return sendError(res, 404, "preset not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "vip_preset.delete",
      targetType: "setting", targetId: params.id!, targetName: before?.label,
      summary: `deleted the VIP preset "${before?.label ?? params.id}"`,
      data: { days: before?.days ?? null, hours: before?.hours ?? null },
    });
    sendJson(res, 200, { ok: true });
  }),

  // --- User & role management (requires admin.users) ---
  route("GET", "/api/capabilities", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "read")) return sendForbidden(res, "admin.users", "read");
    sendJson(res, 200, { capabilities: capabilityCatalog(), presets: ROLE_PRESETS, limits: LIMIT_CATALOG });
  }),

  route("GET", "/api/users", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "read")) return sendForbidden(res, "admin.users", "read");
    const users = await ctx.repo.users.list();
    const roleName = new Map((await ctx.repo.roles.list()).map((r) => [r.id, r.name]));
    const rolesByUser = await ctx.repo.userRoles.listByUsers(users.map((u) => u.id));
    const withGrants = await Promise.all(users.map(async (u) => ({
      ...publicUser(u),
      grants: await ctx.repo.grants.listByUser(u.id),
      limits: await ctx.repo.userLimits.get(u.id),
      roles: (rolesByUser.get(u.id) ?? []).map((a) => ({ id: a.roleId, name: roleName.get(a.roleId) ?? "?", scopeId: a.scopeId })),
    })));
    sendJson(res, 200, { users: withGrants });
  }),

  route("GET", "/api/users/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "read")) return sendForbidden(res, "admin.users", "read");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    sendJson(res, 200, { user: publicUser(user), grants: await ctx.repo.grants.listByUser(user.id) });
  }),

  route("POST", "/api/users", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const body = await readJsonBody(req);
    // Same bound as the register route: this name outlives the account in audit summaries.
    const username = boundedText(body.username, TEXT_MAX.name, "username");
    const password = str(body.password);
    if (!username || !password) return sendError(res, 400, "username and password are required");
    if (await ctx.repo.users.findByUsername(username)) return sendError(res, 409, "username already exists");
    const user = await ctx.repo.users.create({ username, passwordHash: await hashPassword(password), email: str(body.email) || null });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.create",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `created user ${displayNameOf(user)}`,
    });
    sendJson(res, 201, { user: publicUser(user) });
  }),

  route("POST", "/api/users/:id/grants", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    const body = await readJsonBody(req);
    const serverIds = new Set((await ctx.repo.servers.list()).map((s) => s.id));
    const checked = validateGrant(body, serverIds);
    if ("error" in checked) return sendError(res, 400, checked.error);
    const { capability, scopeType, scopeId, level } = checked.value;
    // A personal grant, so it lands beside everything the user already holds. A `none` here is a
    // veto, and one on the last owner's "*" is as much a lockout as stripping their grants.
    const access = await resolveAccess(ctx.repo, user.id);
    const refusal = await accessChangeRefusal(ctx, p, user.id, access.grants, [...access.grants, checked.value]);
    if (refusal) return sendError(res, refusal.status, refusal.message);
    const grant = await ctx.repo.grants.create({ userId: user.id, capability, scopeType, scopeId, level });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "grant.create",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `granted ${displayNameOf(user)} ${level} on ${capability} (${scopeType}${scopeId ? `:${scopeId}` : ""})`,
      data: { capability, scopeType, scopeId, level },
    });
    sendJson(res, 201, { grant });
  }),

  route("DELETE", "/api/users/:id/grants/:grantId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    // The grant has to be THIS user's. Removing by id alone took any grant off any account while the
    // trail named whichever user the URL happened to carry, and skipped every guard below with it.
    const access = await resolveAccess(ctx.repo, user.id);
    const personal = await ctx.repo.grants.listByUser(user.id);
    if (!personal.some((g) => g.id === params.grantId)) return sendError(res, 404, "grant not found");
    // Removing a grant can CONFER: the one removed may be a veto — the owner's lockout on someone, or
    // an outright permission kept from a global-read auditor — so it is judged like any other edit.
    const after = [...personal.filter((g) => g.id !== params.grantId), ...access.roleDerivedGrants];
    const refusal = await accessChangeRefusal(ctx, p, user.id, access.grants, after);
    if (refusal) return sendError(res, refusal.status, refusal.message);
    const ok = await ctx.repo.grants.remove(params.grantId!);
    if (!ok) return sendError(res, 404, "grant not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "grant.revoke",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `revoked a grant from ${displayNameOf(user)}`,
    });
    sendJson(res, 200, { revoked: true });
  }),

  // Replace a user's ENTIRE grant set in one call — what the permission-matrix editor saves.
  // This is what makes permissions tunable after the fact: the editor sends the desired end
  // state; we validate it, guard the lockout cases, then swap it in atomically enough (grants
  // are additive-only between delete and insert; a failed insert can't grant more than asked).
  route("PUT", "/api/users/:id/grants", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    const body = await readJsonBody(req);
    const input = Array.isArray(body.grants) ? (body.grants as Record<string, unknown>[]) : null;
    if (!input) return sendError(res, 400, "grants array is required");

    const serverIds = new Set((await ctx.repo.servers.list()).map((s) => s.id));
    const current = await ctx.repo.grants.listByUser(user.id);
    const held = new Set(current.map(grantRowKey));
    const seen = new Set<string>();
    const next: { capability: string; scopeType: "global" | "server"; scopeId: string | null; level: "none" | "read" | "write" }[] = [];
    for (const g of input) {
      const checked = validateGrant(g, serverIds, held);
      if ("error" in checked) return sendError(res, 400, checked.error);
      const { capability, scopeType, scopeId, level } = checked.value;
      const dedupe = `${capability}|${scopeType}|${scopeId ?? ""}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      next.push({ capability, scopeType, scopeId, level });
    }

    // Roles count — access held via a role survives this edit, so only the personal share changes.
    // Already scoped by resolveAccess — re-deriving with roleGrants(r) would flatten a role held
    // on one server into a global grant and wrongly report the user as still an owner.
    const targetAccess = await resolveAccess(ctx.repo, user.id);
    const refusal = await accessChangeRefusal(ctx, p, user.id, targetAccess.grants, [...next, ...targetAccess.roleDerivedGrants]);
    if (refusal) return sendError(res, refusal.status, refusal.message);

    // Optional action limits (see LIMIT_CATALOG): numeric caps refining a capability.
    let limits: Record<string, number> | undefined;
    if (body.limits !== undefined) {
      if (typeof body.limits !== "object" || body.limits === null || Array.isArray(body.limits)) return sendError(res, 400, "limits must be an object");
      const knownLimits = new Set(LIMIT_CATALOG.map((l) => l.key));
      limits = {};
      for (const [k, v] of Object.entries(body.limits as Record<string, unknown>)) {
        if (!knownLimits.has(k)) return sendError(res, 400, `unknown limit: ${k}`);
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return sendError(res, 400, `limit ${k} must be a positive number`);
        limits[k] = n;
      }
    }

    // What the save replaces, so the trail can say exactly which permissions changed.
    const before = priorOf({
      grants: current.map((g) => ({ capability: g.capability, scopeType: g.scopeType, scopeId: g.scopeId, level: g.level })),
      ...(limits !== undefined ? { limits: await ctx.repo.userLimits.get(user.id) } : {}),
    }, { grants: next, ...(limits !== undefined ? { limits } : {}) });
    for (const g of current) await ctx.repo.grants.remove(g.id);
    const created = [];
    for (const g of next) created.push(await ctx.repo.grants.create({ userId: user.id, ...g }));
    if (limits !== undefined) await ctx.repo.userLimits.replace(user.id, limits);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "grant.set",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `set ${displayNameOf(user)}'s permissions (${created.length} grant${created.length === 1 ? "" : "s"})`,
      data: { grants: next, limits, before },
    });
    sendJson(res, 200, { grants: created, limits: await ctx.repo.userLimits.get(user.id) });
  }),

  // Reset a user's password (admin.users write). Their existing sessions/tokens stay valid —
  // this is "help a locked-out staffer", not a security revocation tool. That tool is the route
  // below, which this one deliberately does NOT do for you: the sessions a password reset would
  // end usually belong to the same person who forgot the password.
  route("PATCH", "/api/users/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    // Setting someone's password is being able to sign in as them — a Discord-only account included,
    // since this gives it one. So an account holding more than the actor does is not theirs to reset.
    const refusal = await targetRefusal(ctx, p, user.id, (await resolveAccess(ctx.repo, user.id)).grants);
    if (refusal) return sendError(res, 403, refusal);
    const body = await readJsonBody(req);
    const password = str(body.password);
    if (!password) return sendError(res, 400, "password is required");
    await ctx.repo.users.setPassword(user.id, await hashPassword(password));
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.password",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `reset ${displayNameOf(user)}'s password`,
    });
    sendJson(res, 200, { ok: true });
  }),

  /*
   * Lock an account out, right now (admin.users write).
   *
   * The one thing the panel could not do. Web sessions are stateless signed tokens with a week's
   * life, so a leaked one kept every power the account has — banning players, rewriting server
   * config, issuing RCON — until it expired on its own; and API tokens were self-service only, so
   * nobody but the holder could revoke one. Between them, the only lockout available was deleting
   * the account, which throws away its roles, grants and Discord link and cannot be undone.
   *
   * It does both halves on purpose. A session is what an attacker arrives with; a token they mint
   * afterwards is how they stay, so ending one without the other is not a lockout. The account
   * itself is untouched — its roles, grants and history are exactly where they were, and the
   * person signs back in and re-mints whatever they were using.
   */
  route("POST", "/api/users/:id/revoke-sessions", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    // Signing someone out is acting on their account like the reset above: not on one that holds
    // more than the actor does. Your own account always passes — it holds exactly what you hold.
    const refusal = await targetRefusal(ctx, p, user.id, (await resolveAccess(ctx.repo, user.id)).grants);
    if (refusal) return sendError(res, 403, refusal);
    const epoch = await ctx.repo.users.revokeSessions(user.id);
    if (epoch === null) return sendError(res, 404, "user not found");
    const tokens = await ctx.repo.tokens.removeAllForUser(user.id);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.revoke_sessions",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `signed ${displayNameOf(user)} out everywhere${tokens > 0 ? ` and revoked ${tokens} API token${tokens === 1 ? "" : "s"}` : ""}`,
      data: { sessionEpoch: epoch, tokensRevoked: tokens },
    });
    // Revoking your OWN account is allowed and does what it says: the response is the last thing
    // this session gets. Saying so is kinder than the next request failing with no explanation.
    sendJson(res, 200, { ok: true, sessionEpoch: epoch, tokensRevoked: tokens, self: user.id === p.user.id });
  }),

  // Merge one staff account into another (admin): the duplicate's audit history, authorship, and
  // notice reads move to the survivor, its Discord identity transfers when the survivor lacks one,
  // and the duplicate is deleted. The survivor keeps its OWN roles/grants/limits. For the "old
  // manual account + new Discord-created account" split — pick the account to keep as :id.
  route("POST", "/api/users/:id/merge", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const body = await readJsonBody(req);
    const duplicateId = str(body.duplicateId);
    if (!duplicateId) return sendError(res, 400, "duplicateId is required");
    if (duplicateId === params.id) return sendError(res, 400, "cannot merge an account into itself");
    if (duplicateId === p.user.id) return sendError(res, 400, "you cannot merge away the account you are logged into — log in as the surviving account (or another admin) instead");
    if (ownAccounts(p).has(duplicateId)) return sendError(res, 400, "this would merge away the account signing it — someone else has to sign it");
    const [survivor, duplicate] = await Promise.all([ctx.repo.users.findById(params.id!), ctx.repo.users.findById(duplicateId)]);
    if (!survivor || !duplicate) return sendError(res, 404, "user not found");
    // Merging deletes the duplicate, so it answers to everything DELETE does. The setup account
    // holds the server-lifecycle keys by identity (users.firstUserId): merged away, they would pass
    // to the next-oldest login — the takeover the delete route refuses.
    if (duplicate.id === await ctx.repo.users.firstUserId()) {
      return sendError(res, 400, "this is the setup account — the first login this install created. It holds the server decommission/delete keys and cannot be merged away");
    }
    // Both directions are acting on an account: the duplicate is deleted, and the survivor takes the
    // duplicate's history as its own and, when it has none, its Discord sign-in.
    const [survivorAccess, duplicateAccess] = await Promise.all([resolveAccess(ctx.repo, survivor.id), resolveAccess(ctx.repo, duplicate.id)]);
    const refusal = (await targetRefusal(ctx, p, survivor.id, survivorAccess.grants)) ?? (await targetRefusal(ctx, p, duplicate.id, duplicateAccess.grants));
    if (refusal) return sendError(res, 403, refusal);
    // The duplicate's grants and roles die with it — the survivor keeps only its own.
    const owners = await effectiveOwnerIds(ctx.repo);
    if (owners.has(duplicate.id)) {
      owners.delete(duplicate.id);
      if (!owners.size) return sendError(res, 400, "cannot merge away the only owner");
    }
    /*
     * A Discord identity carried over keeps its managed flag, and a managed account's roles are
     * whatever the Discord role map hands its Discord roles at the next sweep or sign-in. That is
     * turning management on for the survivor, so it answers to the same judgement as the toggle;
     * where the toggle would be refused, the identity arrives on manual instead. The merge still
     * happens — the survivor keeps the roles it has, and an owner can switch management on.
     */
    const toManual = !survivor.discordId && !!duplicate.discordId && duplicate.discordManaged && !!(await discordManagementRefusal(ctx, p, survivor.id));
    if (toManual) await ctx.repo.users.setDiscordManaged(duplicate.id, false);
    const merged = await ctx.repo.users.merge(survivor.id, duplicate.id);
    if (!merged) {
      // The duplicate is still here, so it goes back the way it was: switched to manual only for a
      // merge that did not happen, it would keep the change with nothing on the trail to say so.
      if (toManual) await ctx.repo.users.setDiscordManaged(duplicate.id, true).catch(() => {});
      return sendError(res, 500, "merge failed");
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.merge",
      targetType: "user", targetId: survivor.id, targetName: survivor.username,
      summary: `merged account "${duplicate.username}" into "${survivor.username}" (history combined, duplicate deleted${toManual ? ", Discord roles set to manual" : ""})`,
      data: { duplicateId: duplicate.id, duplicateUsername: duplicate.username, ...(toManual ? { discordManaged: false } : {}) },
    });
    sendJson(res, 200, { user: publicUser(merged) });
  }),

  // Toggle whether a Discord-linked user's roles are managed by the Discord mapping. Turning it OFF
  // hands control to the admin (the login + background sweep stop overwriting their roles); turning it
  // ON hands control back to Discord (their roles will re-sync on next login / sweep).
  route("PUT", "/api/users/:id/discord-managed", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    const outranked = await targetRefusal(ctx, p, user.id, (await resolveAccess(ctx.repo, user.id)).grants);
    if (outranked) return sendError(res, 403, outranked);
    if (!user.discordId) return sendError(res, 400, "user is not linked to Discord");
    const body = await readJsonBody(req);
    const managed = body.managed === true;
    // Handing control back to Discord can confer — see discordManagementRefusal. Taking it away never does.
    if (managed && !user.discordManaged) {
      const refusal = await discordManagementRefusal(ctx, p, user.id);
      if (refusal) return sendError(res, 403, refusal);
    }
    const updated = await ctx.repo.users.setDiscordManaged(user.id, managed);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.discord_managed",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `set ${displayNameOf(user)}'s roles to ${managed ? "Discord-managed" : "manual override"}`,
      data: { managed },
    }).catch(() => {});
    sendJson(res, 200, { user: publicUser(updated ?? user) });
  }),

  route("DELETE", "/api/users/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    if (ownAccounts(p).has(user.id)) return sendError(res, 400, "you cannot delete your own account");
    // The setup account is the anchor of the server-lifecycle keys: decommission and delete
    // answer to users.firstUserId, not to any grant. If this account could be deleted, the keys
    // would silently pass to the next-oldest login — deleting the founder would be a way to TAKE
    // them, which is precisely what tying them to an identity instead of a permission forbids.
    if (user.id === await ctx.repo.users.firstUserId()) {
      return sendError(res, 400, "this is the setup account — the first login this install created. It holds the server decommission/delete keys and cannot be deleted");
    }
    // Nor an account holding more than the actor does: only an owner deletes an owner.
    const refusal = await targetRefusal(ctx, p, user.id, (await resolveAccess(ctx.repo, user.id)).grants);
    if (refusal) return sendError(res, 403, refusal);
    // Deleting the only owner would orphan the instance (roles count as ownership too).
    const owners = await effectiveOwnerIds(ctx.repo);
    if (owners.has(user.id)) {
      owners.delete(user.id);
      if (!owners.size) return sendError(res, 400, "cannot delete the only owner");
    }
    await ctx.repo.users.remove(user.id);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.delete",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `deleted user ${displayNameOf(user)}`,
    });
    sendJson(res, 200, { ok: true });
  }),

  // --- Custom roles: reusable permission bundles (grants + limits). A user's effective access
  //     is the UNION of their roles plus individual grants; editing a role updates every member.
  route("GET", "/api/roles", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "read")) return sendForbidden(res, "admin.users", "read");
    const roles = await ctx.repo.roles.list();
    const withMembers = await Promise.all(roles.map(async (r) => ({ ...r, members: (await ctx.repo.userRoles.members(r.id)).length })));
    sendJson(res, 200, { roles: withMembers });
  }),

  route("POST", "/api/roles", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const body = await readJsonBody(req);
    const name = boundedText(body.name, TEXT_MAX.name, "name");
    if (!name) return sendError(res, 400, "name is required");
    if (await ctx.repo.roles.findByName(name)) return sendError(res, 409, "a role with that name already exists");
    const bundle = parseRoleBundle(body);
    if (bundle.error) return sendError(res, 400, bundle.error);
    // A role can be assigned everywhere, so its grants are judged as if they were.
    const escalation = outrightGain(p.grants, [], heldEverywhere(bundle.grants ?? []));
    if (escalation) return sendError(res, 403, escalation);
    const role = await ctx.repo.roles.create({
      name, description: str(body.description).trim() || null,
      grants: bundle.grants ?? [], limits: bundle.limits ?? {}, createdByName: p.name,
    });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "role.create",
      targetType: "role", targetId: role.id, targetName: role.name,
      summary: `created role "${role.name}" (${role.grants.length} grant${role.grants.length === 1 ? "" : "s"})`,
      data: { grants: role.grants, limits: role.limits },
    });
    sendJson(res, 201, { role });
  }),

  route("PUT", "/api/roles/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const role = await ctx.repo.roles.get(params.id!);
    if (!role) return sendError(res, 404, "role not found");
    const body = await readJsonBody(req);
    const bundle = parseRoleBundle(body, role.grants);
    if (bundle.error) return sendError(res, 400, bundle.error);
    const name = body.name !== undefined ? boundedText(body.name, TEXT_MAX.name, "name") : undefined;
    if (name !== undefined) {
      if (!name) return sendError(res, 400, "name cannot be empty");
      const existing = await ctx.repo.roles.findByName(name);
      if (existing && existing.id !== role.id) return sendError(res, 409, "a role with that name already exists");
    }
    /*
     * Judged on the bundle itself, held everywhere, before and after — the most it confers on any
     * holder. That covers every member at once (roles only ever add across sources, and one held on
     * a single server confers nothing everywhere), and also whoever a Discord mapping hands the role
     * to next, whom no member list names yet. A veto lifted counts as conferring; a level lowered
     * does not.
     */
    const outranks = roleOutranks(p.grants, heldEverywhere(role.grants));
    if (outranks) return sendError(res, 403, outranks);
    if (bundle.grants) {
      const escalation = outrightGain(p.grants, heldEverywhere(role.grants), heldEverywhere(bundle.grants));
      if (escalation) return sendError(res, 403, escalation);
      // Lockout guard: a role that stops conferring ownership must not take the last owner with it.
      const owns = (grants: { capability: string; level: AccessLevel }[]) => holdsOutright(heldEverywhere(grants), "*", "write");
      if (owns(role.grants) && !owns(bundle.grants) && !(await effectiveOwnerIds(ctx.repo, role.id)).size) {
        return sendError(res, 400, "removing all-access from this role would leave no owner");
      }
    }
    const asRecorded = (r: { name: string; description?: string | null; grants: unknown; limits: unknown }) => ({ name: r.name, description: r.description ?? null, grants: r.grants, limits: r.limits });
    // Copied before the write: the in-memory store hands back its live row.
    const before = priorOf(asRecorded(role), asRecorded(role));
    const updated = await ctx.repo.roles.update(role.id, {
      name, description: body.description !== undefined ? (str(body.description).trim() || null) : undefined,
      grants: bundle.grants, limits: bundle.limits,
    });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "role.update",
      targetType: "role", targetId: role.id, targetName: updated!.name,
      summary: `updated role "${updated!.name}"`,
      data: { grants: updated!.grants, limits: updated!.limits, before, after: asRecorded(updated!) },
    });
    sendJson(res, 200, { role: updated });
  }),

  route("DELETE", "/api/roles/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const role = await ctx.repo.roles.get(params.id!);
    if (!role) return sendError(res, 404, "role not found");
    const outranks = roleOutranks(p.grants, heldEverywhere(role.grants));
    if (outranks) return sendError(res, 403, outranks);
    // Deleting a role never confers anything (roles only add), but it can take the last owner with it.
    if (holdsOutright(heldEverywhere(role.grants), "*", "write") && !(await effectiveOwnerIds(ctx.repo, role.id)).size) {
      return sendError(res, 400, "deleting this role would leave no owner");
    }
    // The request builder's view ceiling must never dangle: a deleted ceiling fails closed (no
    // elevation at all), which silently breaks the builder's browsing — refuse with the fix named.
    if ((await ctx.repo.appConfig.get()).requestCeilingRoleId === role.id) {
      return sendError(res, 400, "this role is the request builder's view ceiling — pick another ceiling under Users & roles first");
    }
    await ctx.repo.roles.remove(role.id);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "role.delete",
      targetType: "role", targetId: role.id, targetName: role.name,
      summary: `deleted role "${role.name}"`,
    });
    sendJson(res, 200, { ok: true });
  }),

  // Replace a user's role set. Effective access updates immediately (roles resolve per request).
  route("PUT", "/api/users/:id/roles", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.users", "write")) return sendForbidden(res, "admin.users", "write");
    const user = await ctx.repo.users.findById(params.id!);
    if (!user) return sendError(res, 404, "user not found");
    const body = await readJsonBody(req);
    // Two accepted shapes. `roles: [{roleId, scopeId}]` is the scoped form; `roleIds: [id]` stays
    // valid and means "everywhere", so an older client (or a script) keeps working unchanged.
    const parsed = await parseRoleAssignments(ctx.repo, body);
    if (!parsed.ok) return sendError(res, parsed.status, parsed.message);
    const { assignments, roles } = parsed;
    // Judged against the user's access AFTER the change: their personal grants stay and the role set
    // is replaced, each role at the scope it is assigned — one server's role confers nothing everywhere.
    const access = await resolveAccess(ctx.repo, user.id);
    const refusal = await accessChangeRefusal(ctx, p, user.id, access.grants, [...access.personalGrants, ...assignmentGrants(assignments, roles)]);
    if (refusal) return sendError(res, refusal.status, refusal.message);
    const byId = new Map(roles.map((r) => [r.id, r]));
    await ctx.repo.userRoles.set(user.id, assignments);
    // The scope belongs in the trail: "Moderator" and "Moderator on Warfare" are different grants
    // of access, and a log that cannot tell them apart cannot answer who gave whom what.
    const servers = new Map((await ctx.repo.servers.list({ includeRetired: true })).map((s) => [s.id, s.name])); // history labels
    const describe = (a: { roleId: string; scopeId: string | null }) => {
      const name = byId.get(a.roleId)?.name ?? a.roleId;
      return a.scopeId ? `${name} on ${servers.get(a.scopeId) ?? a.scopeId}` : name;
    };
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "user.roles",
      targetType: "user", targetId: user.id, targetName: displayNameOf(user),
      summary: `set ${displayNameOf(user)}'s roles: ${assignments.map(describe).join(", ") || "none"}`,
      data: { assignments },
    });
    sendJson(res, 200, { roles: assignments.map((a) => ({ id: a.roleId, name: byId.get(a.roleId)?.name ?? a.roleId, scopeId: a.scopeId })) });
  }),

  // --- Auto-moderation rules (requires admin.moderation) ---
  // A rule's Discord role gate must name roles from the COMMUNITY server — the same save-time
  // refusal the economy's claim gates got, for the same reason: a wrong-server role id silently
  // fires for nobody. Refused only when the guild list is readable and positively disagrees.
  route("GET", "/api/chat-filter", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.chatfilter", "read")) return sendForbidden(res, "moderation.chatfilter", "read");
    const cfg = await ctx.repo.chatFilter.get();
    // The two managed rules live under Rules like any other, where staff can delete or switch them
    // off — and then this screen went on saying "acting on players: on" while nothing acted. The
    // filter's own switch is not proof it is running; the rules are. Report what is actually there.
    sendJson(res, 200, {
      config: cfg,
      rules: { team: await chatFilterRuleState(ctx.repo, cfg.teamRuleId), unit: await chatFilterRuleState(ctx.repo, cfg.unitRuleId) },
    });
  }),

  /*
   * The dedicated chat filter (apps/api/src/chat-filter.ts is the model). One PUT does three
   * things, in an order chosen so a refusal leaves nothing half-done:
   *   1. validate everything — the word list's own bounds, then BOTH managed rule bodies through
   *      parseRuleBody, the same door every hand-written rule goes through;
   *   2. upsert the two managed rules (team + unit chat), preserving whatever staff added to
   *      them by hand — exemptions, a ladder, alert routing, active hours all survive a save
   *      because the managed fields are overlaid on the existing row, not a fresh one;
   *   3. push the censor diff to each ACTIVE server's native banned-words list, per server and
   *      best-effort — a dark server is reported in the response and retried on the next save,
   *      because `censorApplied` only advances on a push that succeeded.
   */
  route("PUT", "/api/chat-filter", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.chatfilter", "write")) return sendForbidden(res, "moderation.chatfilter", "write");
    const body = await readJsonBody(req);

    const words = normalizeChatFilterWords(body.words);
    if (words.length > CHAT_FILTER_MAX_WORDS) return sendError(res, 400, `at most ${CHAT_FILTER_MAX_WORDS} words — past that the filter needs a different shape, not a longer list`);
    const tooLong = words.find((w) => w.length > CHAT_FILTER_MAX_WORD_LEN);
    if (tooLong) return sendError(res, 400, `"${tooLong.slice(0, 60)}" is longer than ${CHAT_FILTER_MAX_WORD_LEN} characters — the list takes words and short phrases`);
    const enabled = body.enabled === true;
    const censor = body.censor === true;
    if ((enabled || censor) && words.length === 0) return sendError(res, 400, "add at least one word — an empty list would match everything, which is a different feature");
    const action = str(body.action) || "punish";
    if (!["message", "punish", "kick", "tempban", "blacklist"].includes(action)) {
      return sendError(res, 400, "action must be one of message, punish, kick, tempban, blacklist");
    }
    const hours = body.hours === undefined || body.hours === null || body.hours === "" ? null : parseHours(body.hours, "hours");
    const reason = boundedText(body.reason, TEXT_MAX.reason, "reason").trim();
    const managed = { enabled, words, action: action as ChatFilterConfig["action"], hours, reason };

    const cfg = await ctx.repo.chatFilter.get();
    /*
     * The filter acts through two community-wide rules, and the chat filter is its own permission,
     * so it must not be a side door to the rules permission's auto-kick and auto-ban. Whoever
     * switches it on, or changes what it does, needs that action's own permission somewhere — the
     * rule an "any server" trigger follows: automation must not do what its author could not do by
     * hand. Editing the words of a filter already acting keeps standing on whoever set its action.
     */
    if (enabled && (!cfg.enabled || cfg.action !== managed.action || (cfg.hours ?? null) !== hours)) {
      const need = chatFilterActionKey(managed.action, hours);
      if (!canAnywhere(p.grants, need, "write")) return sendForbidden(res, need, "write");
    }

    // Validate BOTH rule bodies before writing either — the pair moves together or not at all.
    const upserts: { which: "team" | "unit"; existing: RuleRow | null; value: NewRule }[] = [];
    if (words.length > 0) {
      for (const which of ["team", "unit"] as const) {
        const id = which === "team" ? cfg.teamRuleId : cfg.unitRuleId;
        const existing = id ? await ctx.repo.enforcerRules.get(id) : null;
        const merged = { ...(existing ? ruleBodyFrom(existing) : {}), ...managedRuleFields(managed, which) };
        const parsed = parseRuleBody(merged);
        if ("error" in parsed) return sendError(res, 400, parsed.error);
        upserts.push({ which, existing, value: parsed.value });
      }
    }
    let teamRuleId = cfg.teamRuleId;
    let unitRuleId = cfg.unitRuleId;
    for (const u of upserts) {
      const rule = u.existing
        ? await ctx.repo.enforcerRules.update(u.existing.id, u.value)
        : await ctx.repo.enforcerRules.create(u.value);
      if (u.which === "team") teamRuleId = rule?.id ?? null; else unitRuleId = rule?.id ?? null;
    }
    // Words emptied out: nothing to match, so the managed rules just park (kept, with their
    // history and hand-added settings, exactly like flipping the enabled switch off).
    if (words.length === 0) {
      for (const id of [cfg.teamRuleId, cfg.unitRuleId]) {
        const existing = id ? await ctx.repo.enforcerRules.get(id) : null;
        if (existing?.enabled) await ctx.repo.enforcerRules.update(existing.id, { ...(parseRuleBody(ruleBodyFrom(existing)) as { value: NewRule }).value, enabled: false });
      }
    }
    await ctx.enforcer.refresh();

    // The censor half. Wanted = the list when on, nothing when off — switching the censor off is
    // a removal push (the game must stop starring words we no longer stand behind), never amnesia.
    const servers = await ctx.repo.servers.list();
    const known = new Set(servers.map((s) => s.id));
    const applied: Record<string, string[]> = Object.fromEntries(Object.entries(cfg.censorApplied).filter(([id]) => known.has(id)));
    const wanted = censor ? words : [];
    const censorResults: { serverId: string; name: string; ok: boolean; added: number; removed: number; error?: string }[] = [];
    for (const push of planCensorPushes(servers, wanted, applied)) {
      const server = servers.find((s) => s.id === push.serverId)!;
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);
        if (push.add.length) await client.execute("banProfanity", { words: push.add });
        if (push.remove.length) await client.execute("unbanProfanity", { words: push.remove });
        applied[push.serverId] = wanted;
        censorResults.push({ serverId: push.serverId, name: push.name, ok: true, added: push.add.length, removed: push.remove.length });
      } catch (err) {
        censorResults.push({ serverId: push.serverId, name: push.name, ok: false, added: 0, removed: 0, error: (err as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }

    // The list and its switches as they stood and as saved, so the trail can say exactly what changed.
    const kept = (c: { enabled: boolean; words: string[]; action: string; hours: number | null; reason: string; censor: boolean }) =>
      ({ enabled: c.enabled, words: c.words, action: c.action, hours: c.hours ?? null, reason: c.reason, censor: c.censor });
    const before = priorOf(kept(cfg), kept(cfg));
    const config = await ctx.repo.chatFilter.set({ ...managed, censor, censorApplied: applied, teamRuleId, unitRuleId });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "chatfilter.update", targetType: "config", targetId: "chat-filter", targetName: "Chat filter",
      summary: `saved the chat filter: ${words.length} word(s), ${enabled ? `acting with ${action}` : "not acting on players"}, game censor ${censor ? "on" : "off"}`,
      data: { words: words.length, action, enabled, censor, censorResults, before, after: kept({ ...managed, censor }) },
    });
    // The same rule state the GET reports, so a save that repaired a deleted rule clears the
    // warning it was shown under without a reload — and one held by its section or a pause,
    // which a save does not lift, keeps saying so.
    sendJson(res, 200, {
      config, censorResults,
      rules: {
        team: upserts.some((u) => u.which === "team") ? await chatFilterRuleState(ctx.repo, teamRuleId) : null,
        unit: upserts.some((u) => u.which === "unit") ? await chatFilterRuleState(ctx.repo, unitRuleId) : null,
      },
    });
  }),

  route("GET", "/api/enforcer/rules", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "read")) return sendForbidden(res, "admin.moderation", "read");
    // Proof of life alongside the definition: when each rule last fired and how often this week.
    // Best-effort — a rule list that fails to load because the audit trail hiccuped would be a
    // worse trade than a page with no activity marks on it.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const activity = await ctx.repo.enforcerRules.activity(since).catch(() => new Map<string, { lastFiredAt: string; count: number }>());
    // What each roster rule saw on its latest check, and the latest reason a firing was held back
    // — per server, since a community-wide rule is checked on each. Best-effort like activity.
    const statuses: RuleStatusRow[] = await ctx.repo.enforcerRules.statuses().catch(() => []);
    const status: Record<string, RuleStatusRow[]> = {};
    for (const st of statuses) (status[st.ruleId] ??= []).push(st);
    sendJson(res, 200, {
      rules: await ctx.repo.enforcerRules.list(),
      sections: await ctx.repo.ruleSections.list(),
      activity: Object.fromEntries(activity),
      activitySince: since,
      status,
      now: new Date().toISOString(),
    });
  }),

  route("POST", "/api/enforcer/rules", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const body = await readJsonBody(req);
    const parsed = parseRuleBody(body);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    const refusal = await ruleSaveRefusal(ctx, p.grants, parsed.value);
    if (refusal) return sendRefusal(res, refusal);
    const section = await ruleSectionFrom(ctx.repo, body.sectionId);
    if (section && "error" in section) return sendError(res, 400, section.error);
    const rule = await ctx.repo.enforcerRules.create({ ...parsed.value, sectionId: section?.id ?? null });
    await ctx.enforcer.refresh();
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "rule.create", targetType: "rule", targetId: rule.id, targetName: rule.name, summary: `created rule "${rule.name}"`, data: { rule } });
    sendJson(res, 201, { rule });
  }),

  route("PATCH", "/api/enforcer/rules/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const body = await readJsonBody(req);
    /*
     * The patch used to copy body values straight into the store: PATCH was the unvalidated door
     * beside a validated POST, so a rule could be edited into a NaN threshold, an unknown action,
     * or a vip/teamkill pairing the create route refuses. Merging the edit over the stored rule
     * and re-running the SAME validation closes it — one set of rules, both doors.
     */
    const existing = await ctx.repo.enforcerRules.get(params.id!);
    if (!existing) return sendError(res, 404, "rule not found");
    // Taken before the write — the in-memory store's row is the one the write changes.
    const beforeSnap = ruleSnapshot(existing);
    const merged: Record<string, unknown> = ruleBodyFrom(existing);
    for (const k of Object.keys(merged)) {
      if (body[k] !== undefined) merged[k] = body[k];
    }
    const onlyTurningOff = Object.keys(body).every((k) => k === "enabled") && body.enabled === false;
    let rule: Awaited<ReturnType<typeof ctx.repo.enforcerRules.update>>;
    if (onlyTurningOff) {
      // Switching a rule OFF is never refused for what the rule says — not by today's checks on a
      // rule stored before them (a team-switch rule that moves the player), nor by a role since
      // deleted from Discord. It is the one edit that can only make a rule do less, so it writes
      // that and nothing else.
      rule = await ctx.repo.enforcerRules.update(params.id!, { enabled: false });
    } else {
      const parsed = parseRuleBody(merged);
      if ("error" in parsed) return sendError(res, 400, parsed.error);
      const refusal = await ruleSaveRefusal(ctx, p.grants, parsed.value);
      if (refusal) return sendRefusal(res, refusal);
      // The section rides along when the edit names one — filing is not behaviour, so it is not
      // part of the rule body the checks above judge.
      const section = await ruleSectionFrom(ctx.repo, body.sectionId);
      if (section && "error" in section) return sendError(res, 400, section.error);
      rule = await ctx.repo.enforcerRules.update(params.id!, { ...parsed.value, enabled: parsed.value.enabled ?? existing.enabled, ...(section !== undefined ? { sectionId: section?.id ?? null } : {}) });
    }
    if (!rule) return sendError(res, 404, "rule not found");
    // Version history: an edit that changed what the rule does — not its switch or its section.
    const afterSnap = ruleSnapshot(rule);
    if (snapshotChanged(beforeSnap, afterSnap, RULE_STATE_KEYS)) {
      await recordVersion(ctx.repo, p, { kind: "rule", targetId: rule.id, targetName: rule.name, change: "edit", before: beforeSnap, after: afterSnap });
    }
    await ctx.enforcer.refresh();
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "rule.update", targetType: "rule", targetId: rule.id, targetName: rule.name, summary: `updated rule "${rule.name}"${body.enabled !== undefined ? ` (${rule.enabled ? "enabled" : "disabled"})` : ""}` });
    sendJson(res, 200, { rule });
  }),

  route("DELETE", "/api/enforcer/rules/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const rule = await ctx.repo.enforcerRules.get(params.id!);
    const snap = rule ? ruleSnapshot(rule) : null;
    const ok = await ctx.repo.enforcerRules.remove(params.id!);
    if (!ok) return sendError(res, 404, "rule not found");
    // Kept whole, so Recently deleted can bring it back exactly as it was.
    if (rule && snap) await recordVersion(ctx.repo, p, { kind: "rule", targetId: rule.id, targetName: rule.name, change: "delete", before: snap, after: null });
    await ctx.enforcer.refresh();
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "rule.delete", targetType: "rule", targetId: params.id!, targetName: rule?.name ?? null, summary: `deleted rule "${rule?.name ?? params.id}"` });
    sendJson(res, 200, { deleted: true });
  }),

  /*
   * Version history: each save of a rule, newest first — who, when, and the rule before and after,
   * which the panel reads as what changed. Readable by whoever can read the rules.
   */
  route("GET", "/api/enforcer/rules/:id/versions", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "read")) return sendForbidden(res, "admin.moderation", "read");
    sendJson(res, 200, { versions: await ctx.repo.configVersions.list("rule", params.id!) });
  }),

  /** Deleted rules not brought back since, newest first — each one Restore away. */
  route("GET", "/api/enforcer/deleted-rules", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "read")) return sendForbidden(res, "admin.moderation", "read");
    const standing = new Set((await ctx.repo.enforcerRules.list()).map((r) => r.id));
    sendJson(res, 200, { deleted: (await ctx.repo.configVersions.deletions("rule")).filter((v) => !standing.has(v.targetId)) });
  }),

  /*
   * Put a rule back as it was before a save — or bring a deleted rule back, under its own id so its
   * history follows it. Judged by today's checks like any save (a role since removed from Discord,
   * a group since deleted), and kept in the history itself, so a restore can be undone the same
   * way. An earlier version comes back with the rule's switch and section as they are NOW:
   * restoring what a rule does is not switching it on.
   */
  route("POST", "/api/enforcer/versions/:id/restore", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const v = await ctx.repo.configVersions.get(params.id!);
    if (!v || v.kind !== "rule") return sendError(res, 404, "that version is no longer kept");
    if (!v.before) return sendError(res, 400, "this entry has no earlier version to put back");
    const current = await ctx.repo.enforcerRules.get(v.targetId);
    if (v.change === "delete") {
      if (current) return sendError(res, 409, "that rule is back already");
      const parsed = parseRuleBody(v.before);
      if ("error" in parsed) return sendError(res, 400, `the deleted rule doesn't pass today's checks: ${parsed.error}`);
      const refusal = await ruleSaveRefusal(ctx, p.grants, parsed.value);
      if (refusal) return sendRefusal(res, refusal);
      // Its section only if that still exists — a shelf removed since files it nowhere.
      const section = await ruleSectionFrom(ctx.repo, v.before.sectionId ?? null);
      const rule = await ctx.repo.enforcerRules.create({ ...parsed.value, id: v.targetId, sectionId: section && !("error" in section) ? section.id : null });
      await recordVersion(ctx.repo, p, { kind: "rule", targetId: rule.id, targetName: rule.name, change: "restore", before: null, after: ruleSnapshot(rule) });
      await ctx.enforcer.refresh();
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "rule.restore", targetType: "rule", targetId: rule.id, targetName: rule.name,
        summary: `brought back the deleted rule "${rule.name}" (deleted ${whenSaved(v.createdAt)}${v.actorName ? ` by ${v.actorName}` : ""}) — ${rule.enabled ? "on" : "off"}, as it was`,
        data: { versionId: v.id },
      });
      return sendJson(res, 201, { rule });
    }
    if (!current) return sendError(res, 404, "that rule has been deleted — bring it back from Recently deleted first");
    const merged: Record<string, unknown> = ruleBodyFrom(current);
    for (const [k, val] of Object.entries(v.before)) if (k in merged && !RULE_STATE_KEYS.includes(k)) merged[k] = val;
    const parsed = parseRuleBody(merged);
    if ("error" in parsed) return sendError(res, 400, `that version doesn't pass today's checks: ${parsed.error}`);
    const refusal = await ruleSaveRefusal(ctx, p.grants, parsed.value);
    if (refusal) return sendRefusal(res, refusal);
    const beforeSnap = ruleSnapshot(current);
    const switchedOn = current.enabled;
    const rule = await ctx.repo.enforcerRules.update(current.id, { ...parsed.value, enabled: switchedOn });
    if (!rule) return sendError(res, 404, "rule not found");
    await recordVersion(ctx.repo, p, { kind: "rule", targetId: rule.id, targetName: rule.name, change: "restore", before: beforeSnap, after: ruleSnapshot(rule) });
    await ctx.enforcer.refresh();
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "rule.restore", targetType: "rule", targetId: rule.id, targetName: rule.name,
      summary: `put rule "${rule.name}" back as it was before ${v.actorName ? `${v.actorName}'s` : "the"} change of ${whenSaved(v.createdAt)}`,
      data: { versionId: v.id },
    });
    sendJson(res, 200, { rule });
  }),

  /*
   * Pause a rule for a while: it holds fire until then and switches itself back on after — nothing
   * to remember to undo. `minutes` (30 minutes, 2 hours…) or `until` (a date and time). A reason is
   * required: the rule card says who paused it and why, so nobody has to ask. A pause never writes
   * the rule's own switch, and an edit never lifts it.
   */
  route("POST", "/api/enforcer/rules/:id/pause", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const existing = await ctx.repo.enforcerRules.get(params.id!);
    if (!existing) return sendError(res, 404, "rule not found");
    const body = await readJsonBody(req);
    const reason = boundedText(body.reason, TEXT_MAX.reason, "reason").trim();
    if (!reason) return sendError(res, 400, "say why it is paused — the rule card shows the reason to the rest of the staff");
    if (body.minutes !== undefined && body.until !== undefined) return sendError(res, 400, "send minutes or until, not both");
    let untilMs: number;
    if (body.minutes !== undefined) {
      const minutes = Number(body.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > RULE_PAUSE_MAX_MINUTES) return sendError(res, 400, `minutes must be a whole number from 1 to ${RULE_PAUSE_MAX_MINUTES}`);
      untilMs = Date.now() + minutes * 60_000;
    } else if (body.until !== undefined) {
      untilMs = Date.parse(str(body.until));
      if (!Number.isFinite(untilMs)) return sendError(res, 400, "until must be a date and time");
      if (untilMs <= Date.now() + 30_000) return sendError(res, 400, "until has to be in the future");
      if (untilMs > Date.now() + RULE_PAUSE_MAX_MINUTES * 60_000) return sendError(res, 400, "a pause can last a year at most — switch the rule off instead");
    } else {
      return sendError(res, 400, "how long? send minutes, or until");
    }
    const until = new Date(untilMs).toISOString();
    const rule = await ctx.repo.enforcerRules.setPause(existing.id, { until, reason, by: p.name });
    if (!rule) return sendError(res, 404, "rule not found");
    await ctx.enforcer.refresh();
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "rule.pause", targetType: "rule", targetId: rule.id, targetName: rule.name,
      summary: `paused rule "${rule.name}" until ${until.replace("T", " ").slice(0, 16)} UTC — ${reason}`,
      data: { until, reason },
    });
    sendJson(res, 200, { rule });
  }),

  /** Lift a pause early. One that already ran out has nothing left to lift: it is tidied away
   *  without a word in the trail. */
  route("DELETE", "/api/enforcer/rules/:id/pause", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const existing = await ctx.repo.enforcerRules.get(params.id!);
    if (!existing) return sendError(res, 404, "rule not found");
    // Read before the write: the in-memory store hands back its live row, which the write changes.
    const was = rulePaused(existing) ? { pausedUntil: existing.pausedUntil!, pausedBy: existing.pausedBy, pauseReason: existing.pauseReason } : null;
    const rule = existing.pausedUntil ? await ctx.repo.enforcerRules.setPause(existing.id, null) : existing;
    if (!rule) return sendError(res, 404, "rule not found");
    if (was) {
      await ctx.enforcer.refresh();
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "rule.resume", targetType: "rule", targetId: rule.id, targetName: rule.name,
        summary: `resumed rule "${rule.name}" early — it was paused until ${was.pausedUntil.replace("T", " ").slice(0, 16)} UTC${was.pausedBy ? ` by ${was.pausedBy}` : ""}${was.pauseReason ? ` (${was.pauseReason})` : ""}`,
        data: was,
      });
    }
    sendJson(res, 200, { rule });
  }),

  /*
   * Rule sections: named shelves the Rules page sorts rules onto ("Player level rules", "Group
   * rules"). Organisation only — nothing here changes what any rule does, so filing a rule asks
   * for the rules permission alone, whatever the rule's own action would need to be SAVED.
   */
  route("GET", "/api/enforcer/sections", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "read")) return sendForbidden(res, "admin.moderation", "read");
    sendJson(res, 200, { sections: await ctx.repo.ruleSections.list() });
  }),

  route("POST", "/api/enforcer/sections", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const body = await readJsonBody(req);
    const name = boundedText(body.name, TEXT_MAX.name, "section name").trim();
    if (!name) return sendError(res, 400, "a section needs a name");
    if ((await ctx.repo.ruleSections.list()).some((x) => x.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, `there is already a section called "${name}"`);
    let section;
    try { section = await ctx.repo.ruleSections.create(name); } catch (err) {
      if (err instanceof RuleSectionNameTaken) return sendError(res, 409, err.message);
      throw err;
    }
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "rule.section.create", targetType: "rule_section", targetId: section.id, targetName: section.name, summary: `added the rule section "${section.name}"` });
    sendJson(res, 201, { section });
  }),

  /*
   * Rename a section, and/or flip its master switch (`enabled`). The switch is the one thing about a
   * section that changes behaviour: off holds every rule filed under it, while each rule's own
   * switch stays as it was — so switching the section back on brings back exactly what was on.
   */
  route("PATCH", "/api/enforcer/sections/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const body = await readJsonBody(req);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return sendError(res, 400, "enabled must be true or false");
    if (body.name === undefined && body.enabled === undefined) return sendError(res, 400, "nothing to change — send a name, or enabled");
    const all = await ctx.repo.ruleSections.list();
    const before = all.find((x) => x.id === params.id);
    if (!before) return sendError(res, 404, "section not found");
    let section: RuleSectionRow | null = before;
    if (body.name !== undefined) {
      const name = boundedText(body.name, TEXT_MAX.name, "section name").trim();
      if (!name) return sendError(res, 400, "a section needs a name");
      if (all.some((x) => x.id !== before.id && x.name.toLowerCase() === name.toLowerCase())) return sendError(res, 409, `there is already a section called "${name}"`);
      if (name !== before.name) {
        try { section = await ctx.repo.ruleSections.rename(before.id, name); } catch (err) {
          if (err instanceof RuleSectionNameTaken) return sendError(res, 409, err.message);
          throw err;
        }
        if (!section) return sendError(res, 404, "section not found");
        await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "rule.section.rename", targetType: "rule_section", targetId: section.id, targetName: section.name, summary: `renamed the rule section "${before.name}" to "${section.name}"` });
      }
    }
    if (typeof body.enabled === "boolean" && body.enabled !== before.enabled) {
      section = await ctx.repo.ruleSections.setEnabled(before.id, body.enabled);
      if (!section) return sendError(res, 404, "section not found");
      await ctx.enforcer.refresh();
      const filed = (await ctx.repo.enforcerRules.list()).filter((r) => r.sectionId === section!.id);
      const own = filed.filter((r) => r.enabled).length;
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "rule.section.switch", targetType: "rule_section", targetId: section.id, targetName: section.name,
        summary: body.enabled
          ? `switched the rule section "${section.name}" back on — ${own} of its ${filed.length} rule${filed.length === 1 ? "" : "s"} ${own === 1 ? "is" : "are"} on again`
          : `switched the rule section "${section.name}" off — its ${filed.length} rule${filed.length === 1 ? "" : "s"} hold fire until it is back on`,
        data: { enabled: body.enabled, rules: filed.map((r) => ({ id: r.id, name: r.name, ownSwitch: r.enabled })) },
      });
    }
    sendJson(res, 200, { section });
  }),

  route("DELETE", "/api/enforcer/sections/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const section = (await ctx.repo.ruleSections.list()).find((x) => x.id === params.id);
    if (!section) return sendError(res, 404, "section not found");
    // Its rules stay, on no section — a shelf going away never takes what was on it.
    const filedRules = (await ctx.repo.enforcerRules.list()).filter((r) => r.sectionId === section.id);
    const filed = filedRules.length;
    // …and never arms what it was holding. A switched-off section holds every rule on it whatever
    // its own switch says; with the section gone, the rules' own switches would decide, and every
    // one of them left on would start firing that moment. So those are switched off first, one by
    // one, and stay off until someone switches them back on.
    const held = section.enabled === false ? filedRules.filter((r) => r.enabled) : [];
    for (const r of held) await ctx.repo.enforcerRules.update(r.id, { enabled: false });
    await ctx.repo.ruleSections.remove(section.id);
    if (held.length) await ctx.enforcer.refresh();
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "rule.section.delete", targetType: "rule_section", targetId: section.id, targetName: section.name,
      summary: `removed the rule section "${section.name}"${filed ? ` (its ${filed} rule${filed === 1 ? "" : "s"} moved to Other rules${held.length ? `; it was switched off, so the ${held.length} that ${held.length === 1 ? "was" : "were"} on ${held.length === 1 ? "was" : "were"} switched off rather than set firing` : ""})` : ""}`,
      ...(held.length ? { data: { switchedOff: held.map((r) => ({ id: r.id, name: r.name })) } } : {}),
    });
    sendJson(res, 200, { deleted: true, rulesUnfiled: filed, switchedOff: held.length });
  }),

  /** File rules under a section — or none (`sectionId: null`) — in one go. */
  route("POST", "/api/enforcer/sections/assign", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.moderation", "write")) return sendForbidden(res, "admin.moderation", "write");
    const body = await readJsonBody(req);
    const ruleIds = Array.isArray(body.ruleIds) ? [...new Set(body.ruleIds.map((x) => str(x)).filter(Boolean))] : [];
    if (!ruleIds.length) return sendError(res, 400, "pick at least one rule to move");
    if (ruleIds.length > 500) return sendError(res, 400, "at most 500 rules at once");
    if (body.sectionId === undefined) return sendError(res, 400, "sectionId is required (null = no section)");
    const section = await ruleSectionFrom(ctx.repo, body.sectionId);
    if (section && "error" in section) return sendError(res, 400, section.error);
    const known = new Map((await ctx.repo.enforcerRules.list()).map((r) => [r.id, r]));
    const missing = ruleIds.filter((id) => !known.has(id));
    if (missing.length) return sendError(res, 404, `${missing.length === 1 ? "a rule" : `${missing.length} rules`} no longer exist${missing.length === 1 ? "s" : ""} — refresh the page`);
    const moved = await ctx.repo.enforcerRules.setSection(ruleIds, section?.id ?? null);
    const sectionName = section ? section.name : "Other rules";
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "rule.section.assign", targetType: "rule_section", targetId: section?.id ?? null, targetName: sectionName,
      summary: `moved ${moved} rule${moved === 1 ? "" : "s"} to "${sectionName}"`,
      data: { ruleIds, rules: ruleIds.map((id) => known.get(id)?.name ?? id) },
    });
    sendJson(res, 200, { moved, sectionId: section?.id ?? null });
  }),

  // --- Customizable UI layout ---
  // Resolve the effective widget arrangement for a surface: the caller's user layout if any,
  // else the instance layout, else registry defaults. New widgets always appear.
  //
  // `panel:<viewId>` surfaces are the same storage and scope rules WITHOUT the widget registry:
  // every Panel-based screen persists its arrangement (order, widths, hidden, collapse) here, but
  // the set of panels on a view lives client-side and depends on the caller's capabilities — so
  // the server stores the choices verbatim and the panel resolves them against what it actually
  // mounts, exactly as it already must when a saved id no longer exists.
  route("GET", "/api/layout/:surface", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const surfaceId = params.surface!;
    const userLayout = await ctx.repo.layouts.get(surfaceId, "user", p.user.id);
    const instanceLayout = userLayout ? null : await ctx.repo.layouts.get(surfaceId, "instance", "");
    const source = userLayout ? "user" : instanceLayout ? "instance" : "default";
    if (isPanelSurface(surfaceId)) {
      return sendJson(res, 200, { surface: surfaceId, source, config: userLayout?.config ?? instanceLayout?.config ?? null });
    }
    const all = ctx.widgetRegistry.list(surfaceId as Surface); // includes plugin-registered widgets
    if (all.length === 0) return sendError(res, 404, "unknown surface");
    // Capability-gated widgets are filtered out for users who lack the grant, so a gated tile
    // (e.g. Team activity) never reaches an unauthorized dashboard. Held anywhere, as the tiles' own
    // reads ask: a scope-less `can` counted global grants alone, so staff granted their servers one
    // by one were offered none of the tiles for the servers they can see.
    const defs = all.filter((d) => !d.capability || canAnywhere(p.grants, d.capability, "read"));
    const saved = (userLayout?.config ?? instanceLayout?.config ?? null) as LayoutConfig | null;
    sendJson(res, 200, { surface: surfaceId, source, widgets: resolveLayout(defs, saved) });
  }),

  // Save a layout. Default scope is the user's own; instance scope needs layout.edit.
  route("PUT", "/api/layout/:surface", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const surfaceId = params.surface!;
    const panel = isPanelSurface(surfaceId);
    if (!panel && ctx.widgetRegistry.list(surfaceId as Surface).length === 0) return sendError(res, 404, "unknown surface");
    const body = await readJsonBody(req);
    const scope = str(body.scope) === "instance" ? "instance" : "user";
    if (scope === "instance" && !canAnywhere(p.grants, "layout.edit", "write")) return sendForbidden(res, "layout.edit", "write");
    let config: Record<string, unknown>;
    if (panel) {
      // Strict parse: only the known keys are stored (which also bounds the row), and anything
      // malformed is refused now rather than kept for every future page load to trip on.
      const parsed = body.config && typeof body.config === "object" ? parsePanelLayout(body.config as Record<string, unknown>) : null;
      if (!parsed) return sendError(res, 400, "malformed panel layout config");
      // Panel surface names are minted by the caller, so without a ceiling any signed-in account
      // could grow the layouts table without bound. The app has nowhere near this many screens;
      // an existing surface can always still be re-saved.
      if (scope === "user" && !(await ctx.repo.layouts.get(surfaceId, "user", p.user.id))) {
        const held = await ctx.repo.layouts.countForScope("user", p.user.id);
        if (held >= 300) return sendError(res, 400, "too many saved layouts for this account — reset some pages first");
      }
      config = parsed;
    } else {
      const parsed = parseWidgetLayout((body.config && typeof body.config === "object" ? body.config : { items: [] }) as Record<string, unknown>);
      if (!parsed) return sendError(res, 400, "malformed layout config");
      config = parsed;
    }
    const row = await ctx.repo.layouts.set(surfaceId, scope, scope === "user" ? p.user.id : "", config);
    // Your own layout is your business. The INSTANCE default rewrites what every colleague sees
    // when they next log in, which is a change to the shared product and belongs on the trail.
    if (scope === "instance") {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "layout.instance",
        targetType: "setting", targetId: surfaceId,
        summary: `changed the default ${surfaceId} layout for everyone`,
        data: { surface: surfaceId, config },
      });
    }
    sendJson(res, 200, { saved: true, scope, updatedAt: row.updatedAt });
  }),

  // Forget the caller's OWN saved arrangement, so the surface falls back to the instance default
  // (if staff set one) and then the built-ins — the server half of every "Reset" button. Own
  // scope only: clearing the instance default is done by saving a fresh one over it.
  route("DELETE", "/api/layout/:surface", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const surfaceId = params.surface!;
    if (!isPanelSurface(surfaceId) && ctx.widgetRegistry.list(surfaceId as Surface).length === 0) return sendError(res, 404, "unknown surface");
    const removed = await ctx.repo.layouts.remove(surfaceId, "user", p.user.id);
    sendJson(res, 200, { removed });
  }),

  // Manual data-trim: what can be trimmed, what a cutoff would remove, then the removal itself
  // (with optional backup). Admin only.

  // The catalog the panel renders — categories AND datasets from the same source the stores
  // validate against, so a type added in @app/db appears in the UI without a panel change and a
  // type missing there cannot be offered here.
  route("GET", "/api/trim/options", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.trim", "read")) return sendForbidden(res, "admin.trim", "read");
    sendJson(res, 200, { categories: TRIM_CATEGORY_INFO, datasets: TRIM_DATASETS });
  }),

  route("POST", "/api/trim/preview", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Counting removes nothing: whoever can see the screen sees what a trim would remove, and can
    // then ask for the trim itself.
    if (!canAnywhere(p.grants, "admin.trim", "read")) return sendForbidden(res, "admin.trim", "read");
    const spec = await trimSpecFromBody(req);
    if ("error" in spec) return sendError(res, 400, spec.error);
    // Exact counts at exactly this cutoff — per event category and per dataset, so every toggle
    // row in the panel can say what it is worth before anything is deleted.
    const perCategory: Record<string, number> = {};
    for (const c of spec.categories) {
      perCategory[c] = await ctx.repo.events.countForTrim({ kinds: kindsForCategories([c]), olderThanIso: spec.olderThanIso });
    }
    const datasets = await ctx.repo.trimData.preview(spec.datasets, spec.olderThanIso);
    const events = Object.values(perCategory).reduce((a, b) => a + b, 0);
    const total = events + Object.values(datasets).reduce((a, b) => a + b, 0);
    sendJson(res, 200, { events, perCategory, datasets, total, olderThan: spec.olderThanIso });
  }),

  route("POST", "/api/trim", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.trim", "write")) return sendForbidden(res, "admin.trim", "write");
    const spec = await trimSpecFromBody(req);
    if ("error" in spec) return sendError(res, 400, spec.error);
    const events = spec.kinds.length ? await ctx.repo.events.trim(spec) : null;
    const datasets = await ctx.repo.trimData.run(spec.datasets, spec.olderThanIso, spec.backupDir);
    const total = (events?.deleted ?? 0) + Object.values(datasets).reduce((a, b) => a + b.deleted, 0);
    const result = { events, datasets, total };
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "data.trim",
      targetType: "setting", targetId: "trim",
      // Deleting history is the one action whose own record has to survive it, so the row carries
      // the whole spec and the counts — the deleted rows cannot be consulted afterwards. (An audit
      // trim CAN remove earlier trim records; this row is newer than the cutoff by definition.)
      summary: `trimmed stored data — ${total} row(s) (${[...spec.categories, ...spec.datasets].join(", ")}) older than ${spec.olderThanIso.slice(0, 10)}`,
      data: { spec: { categories: spec.categories, datasets: spec.datasets, olderThanIso: spec.olderThanIso, backup: Boolean(spec.backupPath || spec.backupDir) }, result },
    });
    sendJson(res, 200, result);
  }),

  // Last-seen drift: who carries a "last seen" no sighting supports, and the repair that lowers
  // them back to the evidence. This lives as its own action because the damage outlives the bug
  // that caused it — a clock a bad import bumped stays wrong forever otherwise (the store only
  // ever widens last_seen forward), and pinning the repair to the end of a 20-minute archive
  // apply made it impossible to tell whether it had run at all.
  route("GET", "/api/players/last-seen-drift", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.trim", "read")) return sendForbidden(res, "admin.trim", "read");
    const limit = Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit") ?? 20);
    sendJson(res, 200, await ctx.repo.players.lastSeenDrift(Number.isFinite(limit) ? limit : 20));
  }),

  route("POST", "/api/players/last-seen-drift/repair", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "admin.trim", "write")) return sendForbidden(res, "admin.trim", "write");
    const repaired = await ctx.repo.players.settleLastSeenFromEvidence();
    if (repaired > 0) {
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "admin.last_seen_repair",
        targetType: "player", targetId: "", targetName: `${repaired} player(s)`,
        summary: `repaired ${repaired} last-seen clock(s) that no sighting supported`,
      });
    }
    sendJson(res, 200, { repaired });
  }),
];
