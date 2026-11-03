/**
 * Players as records: the directory, profiles, notes, flags, tags, IP history, groups and the leaderboard.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson, str } from "../http.js";
import { syncGameRoles } from "../discord-game-roles.js";
import { badgesForPlayer } from "../discord-badges.js";
import { buildMatchAnalytics } from "../match-analytics.js";
import { buildCombatAnalytics } from "../player-combat.js";
import { LEADERBOARD_SORTS, UNATTRIBUTED_SERVER_ID, ruleSwitchedOn, type AuditRow, type LeaderboardSort, type MessageRenderer } from "@app/db";
import { rendererFor } from "../render-text.js";
import type { ServerRow } from "@app/db";
import type { AppContext } from "../context.js";
import type { Principal } from "../auth.js";
import { can, canAnywhere } from "@app/access";
import { getGame, resolveTeamSides, rosterPlayerId, teamSidesConfident } from "@app/games";
import { normalizeSession } from "@app/rcon-core";
import { GROUP_JOINED_KIND, GROUP_LEFT_KIND, PLAYER_ROSTER_EVENTS, PLAYER_ROSTER_EVENT_KIND, SCHEDULE_KIND, isGroupTriggerKind, resolveTriggerParams, stateTriggerAppliesTo } from "@app/rules";
import { communityGuild, guildRoles } from "../discord-guild.js";
import { background, createLogger } from "@app/shared";
import { inferMode } from "@app/maps";
import { computeGrantExpiration, neverShorter, requiredVipComment, connectGameClient, currentActorNames, decommissionLocked, readableAudit, gameClientFor, pageLimit, pageOffset, parseAdminGroups, requirePrincipal, serverScope, route, sendForbidden, parseHours, tempbanRefusal, tempbanMaxHours, crossGameIdError, type Route } from "./kit.js";
import { flagBanEvasion } from "../evasion.js";
import { applyWelcomeBonus } from "../discord-public.js";
import { vipIntegrityScanner } from "../vip-integrity.js";
import { describeMinutes, describePerkScope, heldBy, membershipKeyMissing, parseGroupVipPerk, perkServers, vipKeyMissing } from "../group-perks.js";
import { ACTION_CAPABILITY, TRIGGER_EVENTS, TRIGGER_ACTIONS, MAX_TRIGGER_STEPS, capabilitiesForSteps, chainDelayError, describeTrigger, parseEventParams, roleNamerFor, stepError, triggerGameOf, triggerLoopError } from "../player-triggers.js";
import type { PlayerTriggerEvent, PlayerTriggerAction, PlayerTriggerStep } from "@app/db";
import { addWatchReason, syncWatchFlag } from "../watch.js";
import { captureLine, fileRequest } from "../requests.js";
import { postApprovalCard } from "../approval-cards.js";
import { spellingsForText } from "./clans.js";
import type { BanScope } from "../ban-scope.js";

/** How near a ban's lift an unban on the trail must be to be that same lift: the unban routes record
 *  the unban and lift the ban in one go, a moment apart. */
const UNBAN_MATCH_MS = 60_000;

/** An expiry from a request body: absent/blank = watches until removed; otherwise a real future
 *  instant. Returned as an Error rather than thrown so routes answer 400 with the sentence. */
function parseWatchExpiry(v: unknown): string | null | Error {
  if (v === undefined || v === null || v === "") return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) return new Error("expiresAt is not a timestamp");
  if (t <= Date.now()) return new Error("expiresAt is in the past — an expired watch would lift itself immediately");
  return new Date(t).toISOString();
}

/*
 * The directory's page cursor: opaque to the client, so the shape can change without a version
 * negotiation, and validated on the way back in — it arrives from a URL, so it is untrusted.
 */
function encodeCursor(after: { value: string | number | null; id: string }): string {
  return Buffer.from(JSON.stringify(after), "utf8").toString("base64url");
}

function decodeCursor(raw: string | null): { value: string | number | null; id: string } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { value?: unknown; id?: unknown };
    if (typeof v?.id !== "string" || !v.id) return null;
    const value = v.value;
    if (value !== null && typeof value !== "string" && typeof value !== "number") return null;
    return { value: value ?? null, id: v.id };
  } catch {
    // A mangled cursor means page one, not a 500. Someone hand-edited a URL at worst.
    return null;
  }
}

/**
 * The servers out of THIS list that the reader may view.
 *
 * The one primitive behind every per-server read on a player: a player is one person across the
 * community, but the per-server records hanging off them — what was said in chat, who kicked
 * them, what they shot on which server — are that server's business, and `server.view` is a
 * SCOPED capability. Holding it somewhere is not a key to everywhere; `serverScope` exists for
 * the same reason on the boards, and this is its shape for reads that are already about one
 * player. Callers compare the result against the full list to decide whether anything is being
 * held back at all, because "no restriction" has to stay the query it always was.
 */
function viewable(p: Principal, servers: ServerRow[]): ServerRow[] {
  return servers.filter((sv) => can(p.grants, "server.view", "read", { serverId: sv.id }));
}

/** Whether the reader may open this server's VIP list — the VIPs page's own question, per server. */
function seesVipOn(p: Principal, serverId: string): boolean {
  return can(p.grants, "vip.grant", "read", { serverId }) || can(p.grants, "vip.revoke", "read", { serverId });
}

/**
 * Whose triggers this reader may SEE.
 *
 * A trigger is a standing instruction about a named player ON a server — who it names, what it
 * will do to them, and (for a scoped one) where. That makes the overview a per-server read, and
 * it was gated as if it were not: holding `server.view` read ANYWHERE returned every trigger on
 * every server, so a staff member trusted with one server read the moderation plans for the rest.
 * The same mistake the community-wide boards made before `serverScope` existed, in the same
 * shape: a filter that looked like a permission boundary and was not one.
 *
 * `includeRetired`: a trigger scoped to a RETIRED server is history and keeps its name — that
 * server still sits on everyone's Connections tab. A DECOMMISSIONED one is the opposite case:
 * stage 2 takes the server away from every account but the setup one, so its rows go with it
 * rather than printing its name to people it no longer exists for.
 *
 * `ids` is null when nothing is held back, so the common reader (an owner, an install-wide
 * admin) runs exactly the query this always ran.
 */
async function triggerScope(ctx: AppContext, p: Principal): Promise<{
  servers: ServerRow[];
  ids: string[] | null;
  may: (serverId: string | null) => boolean;
}> {
  const servers = await ctx.repo.servers.list({ includeRetired: true });
  const isSetupUser = !p.preview && p.user.id === (await ctx.repo.users.firstUserId());
  const allowed = viewable(p, servers.filter((sv) => isSetupUser || !sv.decommissionedAt));
  const open = new Set(allowed.map((sv) => sv.id));
  return {
    servers,
    ids: allowed.length === servers.length ? null : allowed.map((sv) => sv.id),
    // An "any server" trigger fires wherever the player turns up, so it belongs to anyone who may
    // see any server at all — the same somewhere-rule the create route gates it by.
    may: (serverId: string | null) => serverId === null || open.has(serverId),
  };
}

/** A rule's VIP row in the history: which rule, and whether it was a crash VIP (for a player who
 *  had dropped) or a roster rule's grant (for one who was here without VIP). */
function ruleVipComment(data: unknown): string {
  const d = (data ?? {}) as { ruleName?: string; eventKind?: string };
  return `${d.eventKind === "evt.player.disconnected" ? "crash VIP — " : ""}rule "${String(d.ruleName ?? "?")}"`;
}

const log = createLogger("players");

/**
 * A community Discord role's name, for the group it syncs. Null when Discord can't say.
 *
 * The members are the page and the role's name is only its label, so opening a group never waits
 * long on Discord: everyone asking shares one read, whatever it answers (names, no such role, or
 * nothing at all) is kept a minute, and a read slower than ROLE_NAME_WAIT_MS leaves the label off
 * this time and fills it in for the next open.
 */
const ROLE_NAME_TTL_MS = 60_000;
const ROLE_NAME_WAIT_MS = 1_500;
const roleNameCache = new Map<string, { at: number; name: string | null }>();
const roleNamesAsked = new Set<string>();
let roleNameRead: Promise<void> | null = null;

function rememberRoleNames(roles: { id: string; name: string }[]): void {
  const at = Date.now();
  for (const r of roles) roleNameCache.set(r.id, { at, name: r.name });
}

async function communityRoleName(repo: Parameters<typeof communityGuild>[0], roleId: string): Promise<string | null> {
  const fresh = () => {
    const hit = roleNameCache.get(roleId);
    return hit && Date.now() - hit.at < ROLE_NAME_TTL_MS ? hit : null;
  };
  const hit = fresh();
  if (hit) return hit.name;
  roleNamesAsked.add(roleId);
  roleNameRead ??= (async () => {
    const roles = await guildRoles((await communityGuild(repo)).guildId).catch(() => null);
    const at = Date.now();
    for (const id of roleNamesAsked) roleNameCache.set(id, { at, name: null });
    roleNamesAsked.clear();
    rememberRoleNames(roles ?? []);
  })().finally(() => { roleNameRead = null; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([roleNameRead, new Promise<void>((resolve) => { timer = setTimeout(resolve, ROLE_NAME_WAIT_MS); })]);
  clearTimeout(timer);
  return fresh()?.name ?? null;
}

/** Why a group-held grant is skipped: whose perk holds it, and that it lasts until they leave. */
function heldReason(hold: { groups: { name: string }[] }): string {
  const names = hold.groups.map((g) => `"${g.name}"`).join(", ");
  return `holds permanent VIP from group ${names || "perk"} — left alone until they leave it`;
}

/**
 * What a watched player's flag leaves out for a reader the watchlist permission doesn't cover: why,
 * by whom and since when. The flag's last change goes too — on a watched row it is the watch's own
 * (whoever armed it, and when), and the panel shows it wherever the author is missing.
 */
const WATCH_PROVENANCE_WITHHELD = { watchReason: null, watchBy: null, watchAt: null, updatedByName: null, updatedAt: null } as const;

export const playersRoutes: Route[] = [
  // --- Player groups ---
  // Named sets of players (clan-vs-clan rosters, streamers, event squads), keyed by GAME player
  // id, so a group is global. They exist to be acted on in bulk: POST /apply loops the group
  // through the SAME primitives as the single-player features (VIP grant, console admin, temp
  // ban, team swap, message). Managing groups needs player.groups; applying an action needs
  // that action's own capability — group membership never lowers the bar for what it triggers.
  route("GET", "/api/player-groups", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "read")) return sendForbidden(res, "player.groups", "read");
    sendJson(res, 200, { groups: await ctx.repo.playerGroups.list() });
  }),

  route("POST", "/api/player-groups", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const body = await readJsonBody(req);
    const name = str(body.name).trim();
    if (!name) return sendError(res, 400, "name is required");
    if ((await ctx.repo.playerGroups.list()).some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return sendError(res, 409, `a group named "${name}" already exists`);
    }
    const group = await ctx.repo.playerGroups.create({ name, description: str(body.description) || null, createdByUserId: p.user.id, createdByName: p.name });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.create",
      targetType: "group", targetId: group.id, targetName: name,
      summary: `created player group "${name}"`,
    });
    sendJson(res, 201, { group });
  }),

  route("PUT", "/api/player-groups/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const body = await readJsonBody(req);
    const patch: { name?: string; description?: string | null } = {};
    if (body.name !== undefined) {
      const name = str(body.name).trim();
      if (!name) return sendError(res, 400, "name cannot be blank");
      if ((await ctx.repo.playerGroups.list()).some((g) => g.id !== params.id && g.name.toLowerCase() === name.toLowerCase())) {
        return sendError(res, 409, `a group named "${name}" already exists`);
      }
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = str(body.description) || null;
    const before = await ctx.repo.playerGroups.get(params.id!);
    const group = await ctx.repo.playerGroups.update(params.id!, patch);
    if (!group) return sendError(res, 404, "group not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.update",
      targetType: "group", targetId: group.id, targetName: group.name,
      // A rename is the one edit that makes older entries hard to follow — every one of them names
      // the group as it was called then — so the summary says both halves.
      summary: before && before.name !== group.name
        ? `renamed group "${before.name}" to "${group.name}"`
        : `edited group "${group.name}"`,
      data: { groupId: group.id, before: before ? { name: before.name, description: before.description } : null, patch },
    });
    sendJson(res, 200, { group });
  }),

  route("DELETE", "/api/player-groups/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    // A group carrying a VIP perk takes its members' permanent VIP with it — the same as switching
    // the perk off, so the same key, and the same question asked out loud: do they get the
    // severance? Nobody's VIP is decided by a default.
    let severanceNote = "";
    if (group.vipPerk) {
      const severance = new URL(req.url ?? "", "http://x").searchParams.get("severance");
      if (severance !== "0" && severance !== "1") return sendError(res, 400, "this group carries a VIP perk — say whether its members get the severance when their permanent VIP ends (severance=1) or not (severance=0)");
      const missing = vipKeyMissing(p.grants, perkServers(group.vipPerk, await ctx.repo.servers.list()), ["vip.revoke"]);
      if (missing) return sendForbidden(res, missing.capability, "write", { serverId: missing.server?.id ?? null });
      // The answer is recorded on every hold before the group goes (and again after, below — a
      // hold the worker began in between records it too): a release pays what was chosen.
      await ctx.repo.vips.setGroupSeverance(group.id, severance === "1" ? group.vipPerk.severanceMinutes : 0);
      severanceNote = severance === "0" ? " — its members' permanent VIP ends with their frozen VIP given back, without severance" : ` — its members' permanent VIP ends with their frozen VIP given back plus ${describeMinutes(group.vipPerk.severanceMinutes)} severance`;
    }
    await ctx.repo.playerGroups.remove(group.id);
    if (group.vipPerk) await ctx.repo.vips.setGroupSeverance(group.id, new URL(req.url ?? "", "http://x").searchParams.get("severance") === "1" ? group.vipPerk.severanceMinutes : 0);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.delete",
      targetType: "group", targetId: group.id, targetName: group.name,
      summary: `deleted player group "${group.name}" (${group.memberCount} member${group.memberCount === 1 ? "" : "s"})${severanceNote}`,
      ...(group.vipPerk ? { data: { groupId: group.id, vipPerk: group.vipPerk } } : {}),
    });
    sendJson(res, 200, { ok: true });
  }),

  route("GET", "/api/player-groups/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "read")) return sendForbidden(res, "player.groups", "read");
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    const members = await ctx.repo.playerGroups.members(group.id);
    // What the perk is doing: who holds permanent VIP through this group, and what the last
    // reconcile could not do (members not yet seen, VIP of their own, quiet servers…). Whose VIP
    // stands where — and the time frozen under it — is VIP data, so only the servers whose VIP list
    // the reader may see are counted; the perk itself and the reconcile's tallies are the group's.
    let perkStatus: Record<string, unknown> | null = null;
    if (group.vipPerk) {
      const held = (await ctx.repo.vips.groupHeld())
        .filter((v) => v.groupHold?.groups.some((g) => g.id === group.id))
        .filter((v) => can(p.grants, "vip.grant", "read", { serverId: v.serverId }) || can(p.grants, "vip.revoke", "read", { serverId: v.serverId }));
      const beat = (await ctx.repo.heartbeats.list().catch(() => [])).find((h) => h.name === "group_perks");
      const notes = ((beat?.detail as { notes?: Record<string, unknown> } | null)?.notes ?? {})[group.id] ?? null;
      perkStatus = {
        heldPlayers: new Set(held.map((v) => v.playerId)).size,
        heldGrants: held.length,
        held: held.map((v) => ({ serverId: v.serverId, playerId: v.playerId, bankedMs: v.groupHold?.bankedMs ?? 0, since: v.groupHold?.since ?? null })),
        notes, checkedAt: beat?.updatedAt ?? null,
      };
    }
    // Live rules watching this group's membership, as counts only — the rules themselves are the
    // rule editors' to read. Enough for the Groups page to say why adding someone may ask for a
    // key the group alone does not need.
    const watching = (await ctx.repo.enforcerRules.list()).filter((r) => ruleSwitchedOn(r) && !r.dryRun && (isGroupTriggerKind(r.eventKind) || r.eventKind === SCHEDULE_KIND)
      && String(resolveTriggerParams(r.eventKind, r.params).groupId ?? "") === group.id);
    const watchedByRules = {
      joined: watching.filter((r) => r.eventKind === GROUP_JOINED_KIND).length,
      left: watching.filter((r) => r.eventKind === GROUP_LEFT_KIND).length,
      scheduled: watching.filter((r) => r.eventKind === SCHEDULE_KIND).length,
    };
    // The Discord role that keeps this group listed, by name where Discord can say — and why the
    // last sync pass left the group as it was, if it did (a note read against another role is
    // the old role's, not this one's).
    let discordRole: { id: string; name: string | null; problem: string | null } | null = null;
    if (group.discordRoleId) {
      const beat = (await ctx.repo.heartbeats.list().catch(() => [])).find((h) => h.name === "group_role_sync");
      const sync = (beat?.detail ?? {}) as { skipped?: unknown; notes?: Record<string, { roleId?: unknown; reason?: unknown } | undefined> };
      const note = sync.notes?.[group.id];
      const problem = typeof sync.skipped === "string" ? `the last sync changed nothing: ${sync.skipped}`
        : note?.roleId === group.discordRoleId && typeof note.reason === "string" ? note.reason : null;
      discordRole = { id: group.discordRoleId, name: await communityRoleName(ctx.repo, group.discordRoleId).catch(() => null), problem };
    }
    sendJson(res, 200, { group, members, perkStatus, watchedByRules, discordRole });
  }),

  route("POST", "/api/player-groups/:id/members", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    const body = await readJsonBody(req);
    const playerId = str(body.playerId).trim();
    if (!playerId) return sendError(res, 400, "playerId is required");
    // On a group carrying a VIP perk, membership IS a VIP grant — the VIP key answers for it.
    const missingKey = await membershipKeyMissing(ctx.repo, p.grants, group, "add");
    if (missingKey) return sendForbidden(res, missingKey.capability, "write", { serverId: missingKey.server?.id ?? null });
    const member = await ctx.repo.playerGroups.addMember({ groupId: group.id, playerId, playerName: str(body.playerName) || null, addedByName: p.name });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.member_add",
      targetType: "player", targetId: playerId, targetName: str(body.playerName) || undefined,
      summary: `added ${str(body.playerName) || playerId} to group "${group.name}"`,
      data: { groupId: group.id, groupName: group.name },
    });
    // A rule watching this group fires on the enforcer's own few-second drain; nudged here so a
    // "VIP on joining" lands while the person who added them is still looking.
    background(log, "group membership rules", () => ctx.enforcer.runGroupEvents());
    sendJson(res, 201, { member });
  }),

  route("DELETE", "/api/player-groups/:id/members/:playerId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    const playerId = params.playerId!;
    // …and leaving one ends a permanent VIP: the revoke key answers for that.
    const missingKey = await membershipKeyMissing(ctx.repo, p.grants, group, "remove");
    if (missingKey) return sendForbidden(res, missingKey.capability, "write", { serverId: missingKey.server?.id ?? null });
    const removed = await ctx.repo.playerGroups.removeMember(group.id, playerId);
    if (!removed) return sendError(res, 404, "not a member of this group");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.member_remove",
      targetType: "player", targetId: playerId,
      summary: `removed ${playerId} from group "${group.name}"`,
      data: { groupId: group.id, groupName: group.name },
    });
    background(log, "group membership rules", () => ctx.enforcer.runGroupEvents());
    sendJson(res, 200, { ok: true });
  }),

  /*
   * The group's VIP perk: while listed, permanent VIP on the servers it covers, timed VIP frozen
   * beneath it; on leaving, the frozen VIP back plus the severance. Setting one up needs the keys
   * it exercises — vip.grant and vip.revoke on every server it covers, and vip.revoke on any the
   * old perk covered (narrowing it ends VIP there). The worker applies it within a minute or so.
   */
  route("PUT", "/api/player-groups/:id/perk", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    const parsed = parseGroupVipPerk(await readJsonBody(req), group.vipPerk);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    const servers = await ctx.repo.servers.list();
    const covered = perkServers(parsed.perk, servers);
    if (!covered.length) return sendError(res, 400, "that choice covers no server yet — pick at least one server of the game");
    const missing = vipKeyMissing(p.grants, covered, ["vip.grant", "vip.revoke"])
      ?? (group.vipPerk ? vipKeyMissing(p.grants, perkServers(group.vipPerk, servers), ["vip.revoke"]) : null);
    if (missing) return sendForbidden(res, missing.capability, "write", { serverId: missing.server?.id ?? null });
    const updated = await ctx.repo.playerGroups.setVipPerk(group.id, parsed.perk);
    if (!updated) return sendError(res, 404, "group not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.perk",
      targetType: "group", targetId: group.id, targetName: group.name,
      summary: `${group.vipPerk ? "changed" : "set up"} the VIP perk on group "${group.name}": permanent VIP on ${describePerkScope(parsed.perk, servers)} while listed, ${describeMinutes(parsed.perk.severanceMinutes)} severance on leaving, ${parsed.perk.bankRewards === false ? "rewards don't add to the frozen VIP" : "rewards add to the frozen VIP"}`,
      data: { groupId: group.id, before: group.vipPerk, vipPerk: parsed.perk },
    });
    sendJson(res, 200, { group: updated });
  }),

  /** Switch the perk off: every member's permanent VIP ends — frozen VIP back, with the severance
   *  or without (`severance=1|0`, asked every time). Needs vip.revoke where it covered. */
  route("DELETE", "/api/player-groups/:id/perk", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    if (!group.vipPerk) return sendError(res, 404, "this group has no VIP perk");
    const severance = new URL(req.url ?? "", "http://x").searchParams.get("severance");
    if (severance !== "0" && severance !== "1") return sendError(res, 400, "say whether the members get the severance when their permanent VIP ends (severance=1) or not (severance=0)");
    const servers = await ctx.repo.servers.list();
    const missing = vipKeyMissing(p.grants, perkServers(group.vipPerk, servers), ["vip.revoke"]);
    if (missing) return sendForbidden(res, missing.capability, "write", { serverId: missing.server?.id ?? null });
    // The answer is recorded on every hold before the perk goes, and again after — a hold the
    // worker began in between records it too: a release pays what was chosen.
    const sev = severance === "1" ? group.vipPerk.severanceMinutes : 0;
    await ctx.repo.vips.setGroupSeverance(group.id, sev);
    const updated = await ctx.repo.playerGroups.setVipPerk(group.id, null);
    await ctx.repo.vips.setGroupSeverance(group.id, sev);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.perk",
      targetType: "group", targetId: group.id, targetName: group.name,
      summary: `switched off the VIP perk on group "${group.name}" — its members' permanent VIP ends with their frozen VIP given back${severance === "1" ? ` plus ${describeMinutes(group.vipPerk.severanceMinutes)} severance` : ", without severance"}`,
      data: { groupId: group.id, before: group.vipPerk, vipPerk: null, severance: severance === "1" },
    });
    sendJson(res, 200, { group: updated });
  }),

  /*
   * Link a group to a role in the community Discord — or unlink it. While linked, the worker keeps
   * whoever holds the role (with a linked game account) listed, and takes out whoever IT listed
   * once they lose the role; members a person added stay. Linking hands every future membership
   * change to the sync, so it takes the keys those changes take (membershipKeyMissing, both ways —
   * the group's perk and the rules watching it). Unlinking only stops the changes: group access
   * alone, and every member stays where they are.
   */
  route("PUT", "/api/player-groups/:id/discord-role", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "write")) return sendForbidden(res, "player.groups", "write");
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    const body = await readJsonBody(req);
    const roleId = body.roleId === null || body.roleId === undefined || body.roleId === "" ? null : str(body.roleId).trim();
    let roleName: string | null = null;
    if (roleId) {
      if (!/^\d{5,25}$/.test(roleId)) return sendError(res, 400, "that is not a Discord role id — in Discord: Server Settings → Roles → right-click the role → Copy Role ID");
      const community = await communityGuild(ctx.repo);
      if (roleId === community.guildId) return sendError(res, 400, "that is @everyone — every member of the server holds it, which is not a group");
      // Refuse only what Discord can positively disprove: an outage must not block the setting.
      const roles = await guildRoles(community.guildId);
      if (roles && !roles.some((r) => r.id === roleId)) {
        return sendError(res, 400, community.fellBack
          ? "that role is not in your staff Discord server, and that is the only server configured — if your players are in a separate public server, set its id under Administration → Discord first"
          : "that role is not in the community Discord server — pick one of its roles");
      }
      roleName = roles?.find((r) => r.id === roleId)?.name ?? null;
      if (roles) rememberRoleNames(roles);
      const missing = (await membershipKeyMissing(ctx.repo, p.grants, group, "add")) ?? (await membershipKeyMissing(ctx.repo, p.grants, group, "remove"));
      if (missing) return sendForbidden(res, missing.capability, "write", { serverId: missing.server?.id ?? null });
    }
    const updated = await ctx.repo.playerGroups.setDiscordRole(group.id, roleId);
    if (!updated) return sendError(res, 404, "group not found");
    const label = roleName ? `@${roleName}` : roleId ?? "";
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.discord_role",
      targetType: "group", targetId: group.id, targetName: group.name,
      summary: roleId
        ? `linked group "${group.name}" to the Discord role ${label} — whoever holds it is kept listed`
        : `unlinked group "${group.name}" from its Discord role — its members stay listed`,
      data: { groupId: group.id, before: group.discordRoleId, discordRoleId: roleId },
    });
    sendJson(res, 200, { group: updated });
  }),

  // Which groups a GAME player id belongs to — the profile's "in groups" strip + add-to-group menu.
  route("GET", "/api/player-groups/for/:playerId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.groups", "read")) return sendForbidden(res, "player.groups", "read");
    sendJson(res, 200, { groups: await ctx.repo.playerGroups.groupsForPlayer(params.playerId!) });
  }),

  // Apply a bulk action to every member of a group. The action decides the capability required —
  // exactly the one its single-player equivalent uses — so groups add convenience, never power:
  //   vip → vip.grant · consoleAdmin → server.admins · tempban → action.tempban (hour limits
  //   enforced) · switch → action.switch · message → action.message
  // vip/consoleAdmin carry the usual expiration modes (permanent | until | duration) and land in
  // the same stores, so the worker sweep expires bulk grants like any other. `switch` moves members
  // to a SPECIFIC side: it reads the live roster and only flips members who are online and on the
  // wrong team. Per-member results come back as applied/skipped per server; 409 if nothing applied.
  route("POST", "/api/player-groups/:id/apply", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const group = await ctx.repo.playerGroups.get(params.id!);
    if (!group) return sendError(res, 404, "group not found");
    const body = await readJsonBody(req);
    const action = str(body.action);
    const capOf: Record<string, string> = {
      vip: "vip.grant", vipRevoke: "vip.revoke",
      consoleAdmin: "server.admins", consoleAdminRemove: "server.admins",
      tempban: "action.tempban", switch: "action.switch", message: "action.message",
    };
    const cap = Object.hasOwn(capOf, action) ? capOf[action] : undefined;
    if (!cap) return sendError(res, 400, `unknown group action '${action}'. Known: ${Object.keys(capOf).join(", ")}`);
    // VIP needs the comment typed (kit.ts requiredVipComment) — checked before the permission, whose
    // refusal files the call as a request that could never be signed into a grant without one. It
    // is the note of every VIP the apply creates, and in the VIP history of every member it
    // reaches; a member who already had VIP keeps their own note (a paid grant's receipt).
    const vipComment = action === "vip" ? requiredVipComment(body.comment) : null;
    const baseId = str(body.serverId);
    // All-servers requests gate on holding the capability ANYWHERE — the target filter below
    // applies the per-server scope. Single-server requests gate on that exact server, so a staff
    // member with rights on one server can aim there even while pinned elsewhere.
    if (!(body.allServers ? canAnywhere(p.grants, cap, "write") : can(p.grants, cap, "write", { serverId: baseId }))) return sendForbidden(res, cap, "write", { serverId: body.allServers ? null : baseId || null });
    const base = await ctx.repo.servers.findById(baseId);
    if (!base) return sendError(res, 404, "server not found");
    const members = await ctx.repo.playerGroups.members(group.id);
    if (!members.length) return sendError(res, 400, "the group has no members");

    // Per-action input validation, once, before touching any server.
    const adminGroup = str(body.group).trim();
    if (action === "consoleAdmin" && !adminGroup) return sendError(res, 400, "group is required (one of the server's admin groups)");
    const reason = boundedText(body.reason, TEXT_MAX.reason, "reason");
    const banHours = parseHours(body.hours);
    if (action === "tempban" && !(banHours > 0)) return sendError(res, 400, "tempban requires positive hours");
    if (action === "tempban" && !reason) return sendError(res, 400, "tempban requires a reason");
    const message = boundedText(body.message, TEXT_MAX.reason, "message");
    if (action === "message" && !message) return sendError(res, 400, "message text is required");
    const targetSide = str(body.side).trim();
    if (action === "vip" || action === "consoleAdmin") {
      try { computeGrantExpiration(body, null); } catch (err) { return sendError(res, 400, (err as Error).message); }
    }
    // Console admin keeps its automatic "group: …" note when none is typed.
    const comment = vipComment ?? (boundedText(body.comment, TEXT_MAX.note, "comment") || `group: ${group.name}`);

    const all = await ctx.repo.servers.list();
    const targets = body.allServers ? all.filter((s) => can(p.grants, cap, "write", { serverId: s.id })) : [base];
    const results: { serverId: string; serverName: string; applied: { playerId: string; playerName: string | null; note?: string }[]; skipped: { playerId: string; playerName: string | null; reason: string }[] }[] = [];

    for (const server of targets) {
      const applied: { playerId: string; playerName: string | null; note?: string }[] = [];
      const skipped: { playerId: string; playerName: string | null; reason: string }[] = [];
      results.push({ serverId: server.id, serverName: server.name, applied, skipped });
      // Placeholders in the message / ban reason are filled per MEMBER on this server; one renderer
      // per server so the group shares one VIP-list read.
      let renderer: MessageRenderer | null = null;

      // Everything here is a write; short-circuit observe servers instead of failing member by member.
      if (server.engagementMode !== "active") {
        for (const m of members) skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: "observe mode (read-only)" });
        continue;
      }
      // Bulk can't dodge per-role tempban hour caps.
      if (action === "tempban") {
        const refusal = await tempbanRefusal(ctx.repo, p, server.id, banHours);
        if (refusal) {
          for (const m of members) skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: refusal });
          continue;
        }
      }

      const sides = getGame(server.game)?.descriptor.sides ?? [];
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);

        // Per-server one-time reads: admin-group validation / the live roster for team swaps.
        if (action === "consoleAdmin") {
          const groups = parseAdminGroups(await client.execute("getAdminGroups").catch(() => null));
          if (groups.length && !groups.includes(adminGroup)) {
            for (const m of members) skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: `"${adminGroup}" is not one of this server's admin groups (${groups.join(", ")})` });
            continue;
          }
        }
        let teamById: Map<string, number> | null = null;
        let sideByTeam: Map<number, string | null> | null = null;
        if (action === "switch") {
          if (!sides.some((s) => s.id === targetSide)) {
            for (const m of members) skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: `side must be one of: ${sides.map((s) => s.id).join(", ")}` });
            continue;
          }
          // Same team→side resolution as /live: static guess corrected by the session headcounts,
          // so a mislabeled lobby can't send the whole group the wrong way.
          const [players, session] = await Promise.all([
            client.readState("players"),
            client.readState("session").catch(() => null),
          ]);
          const roster = Array.isArray(players) ? players : Array.isArray((players as { players?: unknown[] })?.players) ? (players as { players: unknown[] }).players : [];
          teamById = new Map((roster as Record<string, unknown>[])
            .map((pl) => [rosterPlayerId(pl), Number(pl?.team)] as [string, number])
            .filter(([pid]) => pid));
          const teamCounts = new Map<number, number>();
          for (const t of teamById.values()) if (Number.isFinite(t)) teamCounts.set(t, (teamCounts.get(t) ?? 0) + 1);
          // Normalized, not cast: the raw headcount keys are protocol-specific (the CRCON bridge
          // says `num_allied_players`), and a cast that only fits binary-v2 silently turns the
          // headcount correction off everywhere else.
          const heads = session == null ? null : normalizeSession(session);
          // A move BY SIDE on a guess can send the group the wrong way: with even teams the
          // resolver falls back to a guess that can come out backwards, moving everyone already
          // on the target side away and skipping the rest as "already there". Refuse instead.
          if (!teamSidesConfident(sides, teamCounts, heads)) {
            for (const m of members) skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: "the server can't tell which team is which right now (even teams) — try again in a moment" });
            continue;
          }
          sideByTeam = resolveTeamSides(sides, teamCounts, heads);
        }

        for (const m of members) {
          const who = m.playerName || m.playerId;
          // A group mixes both games' accounts freely, and a WW2 member's Steam64 is an id the
          // Vietnam server accepts and matches against nobody. Refuse those members with the
          // reason; removals stay exempt so records under a wrong id can still be cleaned up.
          if (action !== "vipRevoke" && action !== "consoleAdminRemove") {
            const idRefusal = await crossGameIdError(ctx.repo, server, m.playerId);
            if (idRefusal) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: idRefusal }); continue; }
          }
          try {
            if (action === "vip") {
              const existing = await ctx.repo.vips.get(server.id, m.playerId);
              // Permanent VIP a group perk gives is left alone until they leave that group.
              if (existing?.groupHold) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: heldReason(existing.groupHold) }); continue; }
              const expiration = neverShorter(existing, computeGrantExpiration(body, existing));
              // Paused VIP: bank the time (upsert below) but never re-add to the game mid-timeout.
              const vipPaused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
              if (!vipPaused) await client.execute("addVip", { playerId: m.playerId, description: m.playerName || comment });
              // No replacePermanent: a group grant is aimed at the group, not at any one member's
              // standing grant — a paid permanent VIP in the list keeps permanent (the store's
              // floor), and the receipt says so instead of claiming the date that was not written.
              const row = await ctx.repo.vips.upsert({ serverId: server.id, playerId: m.playerId, playerName: m.playerName, comment: existing ? null : comment, expiration, createdByUserId: p.user.id, createdByName: p.name });
              // A hold that began after the read: a dated grant went to its frozen balance, a
              // permanent one left it as it is.
              if (row.groupHold) {
                // A permanent grant left the hold as it is: nothing was granted, so no receipt says so.
                if (!expiration) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: heldReason(row.groupHold) }); continue; }
                const note = `holds ${heldBy(row.groupHold)} — added to the VIP they get back on leaving`;
                await ctx.repo.audit.create({
                  actorUserId: p.user.id, actorName: p.name, action: "vip.grant",
                  targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                  summary: `granted VIP to ${who} on ${server.name} via group "${group.name}" — ${note}`,
                  data: { playerId: m.playerId, groupHeld: true, bankedMs: row.groupHold.bankedMs, comment, groupId: group.id },
                });
                applied.push({ playerId: m.playerId, playerName: m.playerName, note });
                continue;
              }
              // Kept whether it stood at the read or was granted since: a dated apply the store's
              // floor absorbed made nothing permanent.
              const keptPermanent = row.expiration === null && (existing?.expiration === null || expiration !== null);
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "vip.grant",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `granted VIP to ${who} on ${server.name} via group "${group.name}" (${row.expiration ? `until ${row.expiration}` : keptPermanent ? "already permanent — kept" : "permanent"})`,
                data: { playerId: m.playerId, expiration: row.expiration, comment, groupId: group.id, ...(keptPermanent ? { keptPermanent: true } : {}) },
              });
              applied.push({ playerId: m.playerId, playerName: m.playerName, note: row.expiration ? `until ${row.expiration}` : keptPermanent ? "already permanent — kept" : "permanent" });
            } else if (action === "consoleAdmin") {
              const existing = await ctx.repo.consoleAdmins.get(server.id, m.playerId);
              const expiration = computeGrantExpiration(body, existing);
              await client.execute("addAdmin", { playerId: m.playerId, group: adminGroup, comment: m.playerName || comment });
              await ctx.repo.consoleAdmins.upsert({ serverId: server.id, playerId: m.playerId, playerName: m.playerName, adminGroup, comment, expiration, createdByUserId: p.user.id, createdByName: p.name });
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "server.admin_add",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `made ${who} a console admin (${adminGroup}) on ${server.name} via group "${group.name}" (${expiration ? `until ${expiration}` : "permanent"})`,
                data: { playerId: m.playerId, group: adminGroup, expiration, groupId: group.id },
              });
              applied.push({ playerId: m.playerId, playerName: m.playerName, note: expiration ? `until ${expiration}` : "permanent" });
            } else if (action === "vipRevoke") {
              // Only rows we actually track — a member with no VIP here is a skip, not a failure,
              // so revoking across a mixed group reads as "3 revoked, 5 had none".
              const existing = await ctx.repo.vips.get(server.id, m.playerId);
              if (!existing) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: "no VIP on this server" }); continue; }
              if (existing.groupHold) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: heldReason(existing.groupHold) }); continue; }
              await client.execute("removeVip", { playerId: m.playerId });
              await ctx.repo.vips.remove(server.id, m.playerId);
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "vip.revoke",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `revoked VIP from ${who} on ${server.name} via group "${group.name}"`,
                data: { playerId: m.playerId, groupId: group.id },
              });
              applied.push({ playerId: m.playerId, playerName: m.playerName });
            } else if (action === "consoleAdminRemove") {
              const existing = await ctx.repo.consoleAdmins.get(server.id, m.playerId);
              if (!existing) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: "not a console admin on this server" }); continue; }
              await client.execute("removeAdmin", { playerId: m.playerId });
              await ctx.repo.consoleAdmins.remove(server.id, m.playerId);
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "server.admin_remove",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `removed console admin from ${who} on ${server.name} via group "${group.name}"`,
                data: { playerId: m.playerId, groupId: group.id },
              });
              applied.push({ playerId: m.playerId, playerName: m.playerName });
            } else if (action === "tempban") {
              await client.execute("tempBanPlayer", { playerId: m.playerId, reason: await (renderer ??= rendererFor(ctx.repo, server, client)).render(reason, m), hours: banHours, adminName: p.name });
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "player.tempban",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `temp-banned ${who} for ${banHours}h on ${server.name} via group "${group.name}" — ${reason}`,
                data: { playerId: m.playerId, reason, hours: banHours, groupId: group.id },
              });
              // The decision record, same as every other ban path — otherwise the reconciler meets
              // a game ban with nothing behind it and reports a panel action as an outside one.
              // A group apply names its servers explicitly, so the scope is this one.
              await ctx.repo.playerBans.create({
                game: server.game, playerId: m.playerId, playerName: m.playerName,
                kind: "temp", reason, scope: { mode: "servers", serverIds: [server.id] },
                expiresAt: banHours > 0 ? new Date(Date.now() + banHours * 3_600_000).toISOString() : null,
                createdByUserId: p.user.id, createdByName: p.name,
              });
              applied.push({ playerId: m.playerId, playerName: m.playerName, note: `${banHours}h` });
            } else if (action === "message") {
              const sent = await (renderer ??= rendererFor(ctx.repo, server, client)).render(message, m);
              await client.execute("messagePlayer", { playerId: m.playerId, message: sent });
              // Every other branch of this loop records its decision; this one did not, so
              // messaging a whole group left no trail at all — the one bulk action a player could
              // be told about and staff could not later be asked about. Same action name as the
              // single-player route (`player.message`), so both land in the same record.
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "player.message",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `messaged ${who} on ${server.name} via group "${group.name}" — ${sent.slice(0, 120)}`,
                data: { playerId: m.playerId, message: sent, ...(sent !== message ? { template: message } : {}), groupId: group.id, bulk: true },
              });
              applied.push({ playerId: m.playerId, playerName: m.playerName });
            } else if (action === "switch") {
              const team = teamById!.get(m.playerId);
              if (team === undefined) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: "not online" }); continue; }
              const sideId = sideByTeam!.get(team) ?? null;
              if (sideId === targetSide) { skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: `already on ${targetSide}` }); continue; }
              await client.execute("switchTeamNow", { playerId: m.playerId });
              await ctx.repo.audit.create({
                actorUserId: p.user.id, actorName: p.name, action: "player.switch",
                targetType: "player", targetId: m.playerId, targetName: m.playerName ?? undefined, serverId: server.id,
                summary: `moved ${who} to ${targetSide} on ${server.name} via group "${group.name}"`,
                data: { playerId: m.playerId, side: targetSide, groupId: group.id },
              });
              applied.push({ playerId: m.playerId, playerName: m.playerName, note: `→ ${targetSide}` });
            }
          } catch (err) {
            skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: (err as Error).message });
          }
        }
      } catch (err) {
        // Connection-level failure: everyone not yet processed on this server is skipped.
        const done = new Set([...applied, ...skipped].map((r) => r.playerId));
        for (const m of members) if (!done.has(m.playerId)) skipped.push({ playerId: m.playerId, playerName: m.playerName, reason: (err as Error).message });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }

    const totalApplied = results.reduce((n, r) => n + r.applied.length, 0);
    // One group-level audit row so the trail shows the bulk operation as a single intent too.
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "group.apply",
      targetType: "group", targetId: group.id, targetName: group.name,
      summary: `applied ${action} to group "${group.name}" (${group.memberCount} members): ${totalApplied} applied across ${results.length} server${results.length === 1 ? "" : "s"}`,
      data: { action, results: results.map((r) => ({ serverId: r.serverId, applied: r.applied.length, skipped: r.skipped.length })) },
    });
    if (!totalApplied) return sendError(res, 409, `nothing applied: ${results.flatMap((r) => r.skipped.slice(0, 3).map((s) => `${s.playerName || s.playerId} (${s.reason})`)).slice(0, 5).join("; ")}`);
    sendJson(res, 200, { results });
  }),

  // One person's voting record. Reached from a player profile: the game player is joined to a
  // Discord account through external_links, and the ballots are keyed on that Discord id.
  route("GET", "/api/players/:id/mapvote", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Seeing the player at all is server.view; seeing how they vote is map-vote access — the same
    // permission that shows the ballot on the vote history page.
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    if (!canAnywhere(p.grants, "mapvote.config", "read")) return sendForbidden(res, "mapvote.config", "read");
    const rawId = params.id!;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const player = (isUuid ? await ctx.repo.players.findById(rawId) : null) ?? await ctx.repo.players.findByPlatformId(rawId);
    if (!player) return sendError(res, 404, "player not found");
    const url = new URL(req.url ?? "", "http://x");
    const serverId = url.searchParams.get("serverId") || undefined;
    // Ballots are taken on each server's own vote, so a reader sees the servers where they hold
    // both gates, and only those. Both were checked "anywhere" alone: map-vote access on one server
    // read a player's ballots on every server, and `?serverId` named any server directly.
    const all = await ctx.repo.servers.list({ includeRetired: true }); // history outlives a retirement
    const allowed = all.filter((s) => can(p.grants, "server.view", "read", { serverId: s.id }) && can(p.grants, "mapvote.config", "read", { serverId: s.id }));
    if (serverId && !allowed.some((s) => s.id === serverId)) return sendForbidden(res, "mapvote.config", "read");
    const serverIds = allowed.length === all.length ? undefined : allowed.map((s) => s.id);

    // No linked Discord account means no ballots to find — say so plainly rather than returning an
    // empty list that reads as "this player never votes".
    const links = await ctx.repo.externalLinks.list(player.id);
    const discordId = links.find((l) => l.provider === "discord")?.externalId ?? null;
    if (!discordId) {
      return sendJson(res, 200, { linked: false, discordId: null, totals: { votes: 0, wins: 0, firstVotedAt: null, lastVotedAt: null }, preferences: [], ballots: [] });
    }
    const [totals, preferences, ballots] = await Promise.all([
      ctx.repo.mapVote.voterTotals(discordId, serverId, serverIds),
      ctx.repo.mapVote.preferences(discordId, { serverId, serverIds, limit: 25 }),
      ctx.repo.mapVote.ballots(discordId, { serverId, serverIds, limit: 50 }),
    ]);
    sendJson(res, 200, { linked: true, discordId, totals, preferences, ballots });
  }),

  route("GET", "/api/players", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    // `?serverId=` narrows the directory to the people who play on that server, with that server's
    // figures in the stat columns. Without it, everyone, careers summed — but never wider than the
    // servers this viewer may see.
    const scope = await serverScope(req, res, ctx, p, "server.view");
    if (!scope) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    // "Only perma banned" lists who is banned for good — the Bans page's answer, which its
    // permission gates there and on the profile, and which no row here shows. Without it the
    // filter is refused: ignored, the whole list would read as its answer. ("Only VIPs" is not
    // like it: every row marks a VIP holder ★, as the Live roster does.)
    if (u.get("permaBanned") === "1" && !canAnywhere(p.grants, "moderation.bans", "read")) return sendForbidden(res, "moderation.bans", "read");
    const limit = pageLimit(u, 100, 500);
    const offset = pageOffset(u);
    // Records-style directory: every row is enriched (career stats + flags) and the whole filter
    // set runs in the store — name/id text, platform, a last-seen window, watched/VIP only, sort.
    const sortParam = u.get("sort") ?? "";
    const filters = {
      ...(scope.serverIds ? { serverIds: scope.serverIds } : {}),
      q: u.get("q")?.trim() || undefined,
      platform: u.get("platform")?.trim() || undefined,
      // `?game=` narrows to one game's accounts. Set by every picker behind a per-server action:
      // the games issue different player ids, so offering the other game's rows there offers ids
      // the target server would accept and apply to nobody.
      game: u.get("game")?.trim() || undefined,
      seenFrom: u.get("seenFrom")?.trim() || undefined,
      seenTill: u.get("seenTill")?.trim() || undefined,
      watchedOnly: u.get("watched") === "1",
      vipOnly: u.get("vip") === "1",
      permaBannedOnly: u.get("permaBanned") === "1",
      // `?clan=` — anyone who has worn that clan tag, in any spelling of it (Players → Clans groups
      // them). Typed text finds its group, so "abc" and "[ABC]" are the same filter.
      ...(u.get("clan")?.trim() ? { clanTags: await spellingsForText(ctx.repo, (await ctx.repo.appConfig.get()).clanTags, u.get("clan")!) } : {}),
      sort: ["lastSeen", "firstSeen", "name", "platform", "kills", "teamkills", "playtime", "visits"].includes(sortParam) ? (sortParam as "lastSeen") : undefined,
      sortDir: u.get("sortDir") === "asc" ? ("asc" as const) : ("desc" as const),
    };
    /*
     * The directory is the one paged list that cannot be pinned to a moment in time. The game log
     * and the audit trail only ever gain rows, so an upper time bound freezes them — but this is a
     * view of MUTABLE rows: last_seen changes on every connect, kills on every fight. The value a
     * row is sorted by moves under the reader, so offset paging repeats rows or skips them
     * depending on which way it moved.
     *
     * So this one pages by keyset: the cursor names the exact position in the ordering that the
     * last page ended at, and the next page is whatever comes after it. Correct however the rows
     * underneath change. Offset still works when no cursor is given, so a caller that never sends
     * one behaves exactly as before.
     */
    const after = decodeCursor(u.get("cursor"));
    const [players, total] = await Promise.all([
      ctx.repo.players.directory({ ...filters, limit, ...(after ? { after } : { offset }) }),
      ctx.repo.players.directoryCount(filters),
    ]);
    // The cursor for the NEXT page, built from the last row this one returned. Absent on a short
    // page, which is how the panel knows it has reached the end.
    const last = players.length === limit ? players[players.length - 1] : undefined;
    const cursor = last ? encodeCursor({ value: last.sortKey, id: last.id }) : null;
    sendJson(res, 200, { players, total, offset, limit, cursor, serverId: scope.requested });
  }),

  // Watched players — the watchlist tab, the dashboard cards, the live-roster 👁. VIP-only rows
  // are deliberately NOT here: every consumer filters to the watchlist, and the live view's ★
  // comes from the real grants. Must be declared before /players/:id so "flagged" isn't
  // captured as an id.
  route("GET", "/api/players/flagged", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    const flags = await ctx.repo.playerFlags.listWatched();
    const servers = await ctx.repo.servers.list({ includeRetired: true }); // labels history — retired names must resolve
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    // Enrich with the player's name AND whether they're on a server right now — a watchlist is for
    // acting on someone, and "watched and online" is the row that actually needs attention.
    // Both lookups are done for the whole list at once: per row it was two queries each, so a
    // watchlist of two hundred people cost four hundred round-trips to render one table.
    const ids = flags.map((f) => f.playerId);
    const [named, openByPlayer, reasonsByPlayer] = await Promise.all([
      ctx.repo.players.findByIds(ids),
      ctx.repo.sessions.openServersFor(ids),
      // Every ACTIVE reason rides along — the Watched tab searches and shows all of them, not
      // just the newest one the cached flag carries.
      ctx.repo.watchReasons.listActiveByPlayers(ids),
    ]);
    const nameById = new Map(named.map((pl) => [pl.id, pl.name]));
    // A watchlist entry is player-level, so the row itself needs no scoping — but "where they are
    // right now" is server data, and the entry check above is scope-blind. Narrow the sighting to
    // servers this viewer can actually see, or a one-server moderator learns the roster of every
    // other server by watching one player.
    const visible = (sid: string) => can(p.grants, "server.view", "read", { serverId: sid });
    // Who is watched is everyone's here; why, by whom and since when are the watchlist
    // permission's, as on the profile — this list served them to anyone who sees a server.
    const seesWhy = canAnywhere(p.grants, "player.watchlist", "read");
    const enriched = flags.map((f) => {
      const open = (openByPlayer.get(f.playerId) ?? []).filter(visible);
      return {
        ...f,
        ...(seesWhy ? {} : WATCH_PROVENANCE_WITHHELD),
        name: nameById.get(f.playerId) ?? null,
        online: open.length > 0,
        onlineServers: open.map((sid) => serverName.get(sid) ?? sid),
        reasons: seesWhy ? (reasonsByPlayer.get(f.playerId) ?? []).map((r) => ({
          id: r.id, reason: r.reason, addedBy: r.addedBy, addedAt: r.addedAt, expiresAt: r.expiresAt,
        })) : [],
      };
    });
    // Online first, then most recently flagged — the actionable rows float to the top.
    enriched.sort((a, b) => Number(b.online) - Number(a.online) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    sendJson(res, 200, { flags: enriched });
  }),

  // The profile's activity feed, paged over the player's WHOLE recorded history — the profile
  // body carries only a recent slice, which made "show me everything this player did" impossible
  // and quietly capped every category filter at the last 50 rows.
  route("GET", "/api/players/:id/events", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    const rawId = params.id!;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const player = (isUuid ? await ctx.repo.players.findById(rawId) : null) ?? await ctx.repo.players.findByPlatformId(rawId);
    if (!player) return sendError(res, 404, "player not found");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const limit = pageLimit(u, 50, 200);
    const offset = pageOffset(u);
    const kinds = (u.get("kinds") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    const serverId = u.get("serverId") || undefined;
    // This feed carries what a person SAID in chat, and who kicked, banned or messaged them —
    // per-server records, on a route gated only by holding server.view somewhere. Both halves
    // were open: the unfiltered read returned every server's rows, and `?serverId` named one
    // directly with nothing checking it against the reader's grants. Same shape the admin-camera
    // history already refuses (see admin-cam.ts), now answered the same way.
    const all = await ctx.repo.servers.list({ includeRetired: true }); // history outlives a retirement
    const allowed = viewable(p, all);
    if (serverId && !allowed.some((sv) => sv.id === serverId)) return sendForbidden(res, "server.view", "read");
    const serverIds = allowed.length === all.length ? undefined : allowed.map((sv) => sv.id);
    const [events, total] = await Promise.all([
      ctx.repo.events.listByPlayer(player.id, limit, kinds.length ? kinds : undefined, { offset, serverId, serverIds }),
      ctx.repo.events.countByPlayer(player.id, kinds.length ? kinds : undefined, serverId, serverIds),
    ]);
    sendJson(res, 200, { events, total, offset, limit });
  }),

  route("GET", "/api/players/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    // Accept either our internal player id (a uuid) or the game platform id (from a live read),
    // so a name clicked anywhere — scoreboard, killfeed, moderation log — opens the profile.
    const rawId = params.id!;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const player = (isUuid ? await ctx.repo.players.findById(rawId) : null) ?? await ctx.repo.players.findByPlatformId(rawId);
    if (!player) return sendError(res, 404, "player not found");
    /*
     * The reader's server boundary, decided once for the per-server OBSERVATIONAL reads below.
     *
     * The rule already lived here — `visibleStats` drops career rows for servers the reader may
     * not view — but the reads that go through the event stream were never held to it, so the
     * activity feed handed over what a player SAID in chat on every server in the community, and
     * the combat window every kill. Same rule, same grant, the halves that were missed.
     *
     * What stays whole on purpose: the merged career TOTAL (the person's whole record, the same
     * figure the public stats site publishes), and the moderation block further down — see the
     * note there.
     */
    const allServers = await ctx.repo.servers.list({ includeRetired: true }); // labels careers/sessions/VIPs from a retired server's era
    const allowed = viewable(p, allServers);
    const serverIds = allowed.length === allServers.length ? undefined : allowed.map((sv) => sv.id);
    const [stats, statsByServer, flags, recentEvents, aliases, playerVips, servers, sessions, tags, openServers, links, watchHistory, allAdmins, roleBadges] = await Promise.all([
      ctx.repo.stats.get(player.id),
      ctx.repo.stats.byServer(player.id),
      ctx.repo.playerFlags.get(player.id),
      ctx.repo.events.listByPlayer(player.id, 50, undefined, { serverIds }),
      ctx.repo.playerAliases.list(player.id),
      // This player's grants alone — it was vips.list(), every grant in the community fetched
      // and filtered in JS to find one person's, on every profile open.
      ctx.repo.vips.listByPlayer(player.platformId),
      Promise.resolve(allServers), // already read above, for the boundary
      ctx.repo.sessions.list(player.id, 15),
      ctx.repo.playerTags.list(player.id),
      ctx.repo.sessions.openServers(player.id),
      ctx.repo.externalLinks.list(player.id),
      ctx.repo.playerFlags.watchHistory(player.id),
      // Console-admin grants (the 🎥 chip) — the whole table, filtered below; grants are dozens,
      // not thousands, and the repo has no by-player read.
      ctx.repo.consoleAdmins.list(),
      // Community role badges — awaited here (one member read, cached) because a profile is one
      // player and not polled; the roster's cache-only shortcut would leave the first open blank.
      badgesForPlayer(ctx.repo, player.id).catch(() => []),
    ]);
    /*
     * The SAME ACCOUNT'S other directory rows — the lookup behind "this player has a linked
     * Steam/Xbox id, where else does it appear?".
     *
     * A platform account id is permanent per account (a Steam64 or an Xbox XUID never changes;
     * renames touch the display name only), so the same number turning up on two rows means the
     * same human: typically their WW2 and Vietnam accounts, which the two games key by different
     * per-game ids. Three joins cover the shapes the data actually takes:
     *   - another row LINKS the same identity this row links (both games captured the account id);
     *   - another row is KEYED by an id this row links (WW2 keys Steam players by the Steam64
     *     that Vietnam only carries as a link);
     *   - another row LINKS the id this row is keyed by (the same join read from the other end).
     * Discord stays out of it — that link means "this member's account", and the member panel
     * already owns that story.
     */
    const gameLinks = links.filter((l) => l.provider !== "discord");
    const sameAccount = new Map<string, typeof player>();
    for (const l of gameLinks) {
      for (const o of await ctx.repo.externalLinks.findPlayersByExternalId(l.externalId)) if (o.id !== player.id) sameAccount.set(o.id, o);
      const keyed = await ctx.repo.players.findByPlatformId(l.externalId);
      if (keyed && keyed.id !== player.id) sameAccount.set(keyed.id, keyed);
    }
    for (const o of await ctx.repo.externalLinks.findPlayersByExternalId(player.platformId)) if (o.id !== player.id) sameAccount.set(o.id, o);

    // Split alias history into past names + clan tags; the current name/clan aren't "past", so drop
    // the entry that still matches the live value from each list.
    const currentClan = aliases.filter((a) => a.kind === "clan").sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0]?.value ?? null;
    const pastNames = aliases.filter((a) => a.kind === "name" && a.value !== player.name);
    const clanTags = aliases.filter((a) => a.kind === "clan");
    // VIP status per server (from our own grants, keyed by the game player id = platformId).
    // Not a retired server's: the grant is kept (retiring stamps the server and touches nothing
    // else, and bringing it back brings its VIP back), but the server is gone from everywhere
    // else, and its VIP read here as VIP the player has now.
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const retired = new Set(servers.filter((s) => s.retiredAt).map((s) => s.id));
    // And only the servers whose VIP list the reader may open: that page asks per server, and a
    // grant's comment is often what was paid for it.
    // And only VIP that has not run out — by the expiry sweep's own rule (vips.expired): past its
    // date, unless a banked pause froze it. The sweep takes such a row away within minutes, but on
    // a server in observe mode, or one that refuses the removal, it stays, and read as VIP held now.
    const nowIso = new Date().toISOString();
    const ranOut = (v: { expiration: string | null; pauseMode: string | null; pausedUntil: string | null }) =>
      v.expiration !== null && v.expiration <= nowIso && !(v.pauseMode === "banked" && v.pausedUntil !== null);
    const vipStatus = playerVips
      .filter((v) => !retired.has(v.serverId) && seesVipOn(p, v.serverId) && !ranOut(v))
      .map((v) => ({
        serverId: v.serverId, serverName: serverName.get(v.serverId) ?? v.serverId, expiration: v.expiration,
        pausedUntil: v.pausedUntil, pauseReason: v.pauseReason, pausedBy: v.pausedBy, pauseMode: v.pauseMode,
        // Permanent because a group perk holds it: whose, and the timed VIP frozen beneath it.
        groupHold: v.groupHold ? { groups: v.groupHold.groups.map((g) => g.name), bankedMs: v.groupHold.bankedMs } : null,
      }));
    // Console-admin status per server, live grants only — the same shape VIP takes, because it is
    // the same kind of decision (a grant, per server, with an expiry the panel owns). And not a
    // retired server's, for the same reason as VIP.
    const consoleAdminStatus = allAdmins
      .filter((a) => a.playerId === player.platformId && !retired.has(a.serverId) && can(p.grants, "server.admins", "read", { serverId: a.serverId }))
      .filter((a) => !a.expiration || Date.parse(a.expiration) > Date.now())
      .map((a) => ({ serverId: a.serverId, serverName: serverName.get(a.serverId) ?? a.serverId, adminGroup: a.adminGroup, expiration: a.expiration }));
    // Per-server presence, held to the same rule as the career rows beside it.
    const sessionsOut = sessions
      .filter((sn) => can(p.grants, "server.view", "read", { serverId: sn.serverId }))
      .map((sn) => ({ ...sn, serverName: serverName.get(sn.serverId) ?? sn.serverId }));
    // Notes are permission-gated: only returned to users with the player.notes read capability.
    const canNotes = canAnywhere(p.grants, "player.notes", "read");
    const notes = canNotes ? await ctx.repo.playerNotes.list(player.id) : undefined;
    /*
     * The profile is a hub for data that has its own gated page elsewhere, and until now it was the
     * back door into most of them.
     *
     * A Viewer — `server.view` and nothing else — cannot open Moderation → Bans, cannot open
     * Players → VIPs. They could open any player's profile and read both anyway: the ban with its
     * reason, every VIP grant and who paused it. The capabilities existed and were enforced on
     * their own pages; the profile simply never asked.
     *
     * Each block is now gated by the SAME capability its own page uses, and gated at the API rather
     * than in the component — a hidden panel whose data is still in the JSON is a tidier screen, not
     * a boundary, and anyone can read the network response. The panel receives a `canView*` flag and
     * obeys it, which is the pattern notes have always used.
     *
     * Moderation history moves from `staff.analytics` to `moderation.bans`. staff.analytics answers
     * "who on our team did what", which is a question about STAFF; this is the record of what was
     * done to a PLAYER, which is the Bans page's data with kicks and punishes alongside. Anyone
     * holding only staff.analytics loses this panel and keeps the Staff activity page it belongs to.
     */
    const canVipView = canAnywhere(p.grants, "vip.grant", "read");
    const canBansView = canAnywhere(p.grants, "moderation.bans", "read");
    const canWatchView = canAnywhere(p.grants, "player.watchlist", "read");
    // Which Discord and platform accounts this record is linked to — and so the same person's rows
    // in other games — is who a player IS: it answers to Player identity links, whose read is seeing
    // them and whose write is changing them (PATCH …/links below).
    const canLinksView = canAnywhere(p.grants, "player.links", "read");
    // Moderation history (bans/kicks/punishes + auto-mod) is the Bans page's data about a person.
    // Manual actions are audited by the game player id (platformId); enforcer/notes/flags by our
    // internal id — so we query both target keys and keep the player.* / enforcer.* actions.
    // A profile is community-wide, so the gate is "may you see moderation history at all" — a
    // moderator whose grant is scoped to one server still qualifies. Which SERVERS' actions they
    // then see is a separate question, answered by the trail itself.
    const canMod = canBansView;
    /**
     * Enforcement and messages are read SEPARATELY, and that is the whole point.
     *
     * Both used to come from one newest-200 read across all four kinds, merged and cut to thirty.
     * On an imported archive that is not a mix — a chatty server records hundreds of admin messages
     * per player and a handful of kicks, so the two hundred were all messages, the thirty were all
     * messages, and a ban from six months ago was not merely below the fold but never fetched. The
     * profile section people open to ask "has this player been dealt with before?" answered with a
     * wall of MESSAGE and nothing else.
     *
     * Read apart, they cannot crowd each other out, and the merge below gives enforcement the
     * slots it needs before messages take what is left.
     */
    const [byId, byPlatform, enforcementEvents, messageEvents, banRecord] = await Promise.all([
      ctx.repo.audit.list({ targetId: player.id, limit: 100 }),
      player.platformId !== player.id ? ctx.repo.audit.list({ targetId: player.platformId, limit: 100 }) : Promise.resolve([]),
      // Moderation the archive import recorded as EVENTS (CRCON's received_actions + admin-log
      // lines). Only imported rows join the panel: a live admin event usually has an audit twin
      // (the panel action that caused it), and merging those would double-show every kick.
      // Deliberately NOT narrowed by server, unlike the feed above. This block is the person's
      // disciplinary record — user history — and it is gated as such (canMod, below). It also
      // merges two sources for the same acts: the panel's audit rows and the events an archive
      // import recorded. Narrowing one source and not the other would show a kick when it came
      // from the panel and hide the same kick when it came from the import, which is worse than
      // either answer. If this should ever narrow, both halves narrow together.
      ctx.repo.events.listByPlayer(player.id, 100, ["evt.player.kicked", "evt.player.banned", "evt.player.punished"]),
      ctx.repo.events.listByPlayer(player.id, 100, ["evt.admin.message"]),
      // The player's ban decisions in this game, lifted and run out included: those in force mark
      // the profile banned, and each one lifted is an unban in the history.
      ctx.repo.playerBans.list({ playerId: player.platformId }).then((rows) => rows.filter((b) => b.game === player.game)),
    ]);
    const modEvents = [...enforcementEvents, ...messageEvents];
    const seen = new Set<string>();
    const modRows = [...byId, ...byPlatform]
      .filter((a) => (a.action.startsWith("player.") || a.action.startsWith("enforcer.")) && !seen.has(a.id) && seen.add(a.id))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    const importedMod = modEvents
      .filter((e) => e.dedupeKey?.startsWith("crcon:"))
      .map((e) => {
        const d = (e.data ?? {}) as { reason?: string; message?: string; by?: string; banType?: string };
        const action = e.kind === "evt.player.kicked" ? "player.kick"
          : e.kind === "evt.player.punished" ? "player.punish"
          : e.kind === "evt.admin.message" ? "player.message"
          : d.banType === "temp" ? "player.tempban" : "player.permaban";
        /**
         * What was actually said, under the name the row means it by.
         *
         * This read only ever looked at `reason`, and a message imported from CRCON does not have
         * one — its text is stored as `message` (see the MESSAGE cases in crcon-transform). So the
         * text was imported, kept, and then dropped on the way out: the profile showed a stack of
         * "MESSAGE · by CRCON" rows that expanded to a server name and nothing else, and the one
         * thing a reader opens that row to see was the one thing missing.
         *
         * A message's text is a MESSAGE, not a reason, so it is handed over under that key and the
         * detail labels it "Message sent" — the same as a message this panel sent itself. The
         * fallback covers the other import path, which files a received_action's text as `reason`
         * whatever the action was.
         */
        const text = action === "player.message" ? (d.message || d.reason || "") : (d.reason || "");
        return {
          id: `evt:${e.id}`, ts: e.ts, action, actorUserId: null, actorName: d.by || "CRCON",
          targetType: "player", targetId: player.id, targetName: player.name || null,
          serverId: e.serverId, summary: text,
          data: text ? (action === "player.message" ? { message: text } : { reason: text }) : null,
          // Imported from a log, so nobody here took it — but it was a person on the old system,
          // not our machinery, and the flag only ever means "the app did this".
          automated: false,
        } satisfies AuditRow;
      });
    // Resolved for display like the Trail is: the rows carried whatever name the client happened
    // to send, which for the action routes is usually nothing — so the panel fell back to the
    // target TYPE and every entry read "player · by admin".
    /**
     * Thirty rows, with enforcement first in the queue for them.
     *
     * A flat newest-thirty is the right answer when the kinds arrive in comparable numbers and the
     * wrong one here: messages outnumber kicks by orders of magnitude on an imported archive, so
     * sorting by time alone hands every slot to them. Enforcement claims what it needs, messages
     * fill the rest, and the result is sorted by time so it still reads as one timeline.
     */
    const MOD_ROWS = 30;
    /**
     * Every lifted ban, as an unban in the history — from the ban record, which keeps who lifted it
     * and when, whichever way it was lifted.
     *
     * An unban from the player's menu, the Bans page or an approved request is on the trail against
     * the player, and in the history already. Lift all, which clears a whole server, records one
     * entry for the server and none for each player — so a ban lifted that way never showed here,
     * and the history ended at the ban as if it still stood. A lift the trail already has (an unban
     * of the same kind within a minute of it) is not said twice.
     */
    const unbansOnTrail = modRows.filter((a) => a.action === "player.unban_perma" || a.action === "player.unban_temp")
      .map((a) => ({ kind: a.action === "player.unban_perma" ? "perma" : "temp", at: Date.parse(a.ts) }));
    const where = (scope: BanScope) => {
      const names = (ids: string[] | undefined) => (ids ?? []).map((id) => allServers.find((sv) => sv.id === id)?.name ?? "a removed server").join(", ");
      return scope.mode === "all" ? "every server" : scope.mode === "except" ? `every server but ${names(scope.serverIds)}` : names(scope.serverIds) || "no server";
    };
    const liftedBans = banRecord
      .filter((b) => b.liftedAt !== null && !unbansOnTrail.some((u) => u.kind === b.kind && Math.abs(u.at - Date.parse(b.liftedAt!)) <= UNBAN_MATCH_MS))
      .map((b) => ({
        id: `ban:${b.id}:lifted`, ts: b.liftedAt!, action: `player.unban_${b.kind}`, actorUserId: null, actorName: b.liftedByName || "unknown",
        targetType: "player", targetId: player.id, targetName: player.name || null, serverId: null,
        summary: `lifted the ${b.kind} ban placed on ${b.createdAt} by ${b.createdByName || "unknown"} (${where(b.scope as BanScope)})${b.reason ? ` — ${b.reason}` : ""}`,
        data: null,
        automated: false,
      } satisfies AuditRow));
    const all = [...modRows, ...importedMod, ...liftedBans];
    const isEnforcement = (a: { action: string }) => !a.action.endsWith(".message");
    const enforcement = all.filter(isEnforcement).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MOD_ROWS);
    const messages = all.filter((a) => !isEnforcement(a)).sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, Math.max(0, MOD_ROWS - enforcement.length));
    const moderation = canMod
      ? await readableAudit(ctx, [...enforcement, ...messages].sort((a, b) => b.ts.localeCompare(a.ts)))
      : undefined;
    // The player's active ban DECISIONS — this game's, as the ban record has them and Moderation →
    // Bans counts them: not lifted, not run out. The profile's ⛔ and ⏱ come from them too. They
    // came from the trail's newest ban or unban, which the record outlives both ways: Lift all
    // lifts every decision with one row for the server and no unban for each player, and a temp
    // ban the ban sync put back on the game was logged without its hours, so it never ran out —
    // and profiles went on marking players banned whose bans the Bans page listed as over.
    const activeBans = banRecord.filter((b) => b.liftedAt === null && (b.expiresAt === null || b.expiresAt > nowIso));
    const perma = activeBans.find((b) => b.kind === "perma");
    const permaBan = perma ? { ts: perma.createdAt, reason: perma.reason } : null;
    // Of several temp bans, the one that holds longest: no end before any end, then the latest.
    const temp = activeBans.filter((b) => b.kind === "temp").sort((a, b) => (b.expiresAt ?? "~").localeCompare(a.expiresAt ?? "~"))[0];
    const tempBan = temp ? { ts: temp.createdAt, expiresAt: temp.expiresAt, reason: temp.reason } : null;
    const banDecisions = activeBans
      .map((b) => ({ id: b.id, kind: b.kind, reason: b.reason, category: b.category, expiresAt: b.expiresAt, scope: b.scope }));
    // Being on a server right now is that server's live roster: only the servers the reader may
    // view, as the watchlist's own "online" already is.
    const onlineServers = openServers
      .filter((sid) => can(p.grants, "server.view", "read", { serverId: sid }))
      .map((sid) => ({ serverId: sid, serverName: serverName.get(sid) ?? sid }));
    // Match analytics: per-round history + win-rate + K/D progression + weapon breakdown.
    const [matchAgg, matchRows] = await Promise.all([
      ctx.repo.matches.aggregateForPlayer(player.id),
      ctx.repo.matches.listForPlayer(player.id, 100),
    ]);
    const matchAnalytics = buildMatchAnalytics(matchAgg, matchRows, player.id, recentEvents);
    // Rich combat analytics: a deep kill/death window (kinds-filtered so chat can't dilute it) plus
    // every participant line of the player's recent matches. The descriptor comes from the game the
    // player's matches were on (falling back to the first server) so the weapon buckets fit.
    const [combatEvents, matchParticipants] = await Promise.all([
      ctx.repo.events.listByPlayer(player.id, 2000, ["evt.kill", "evt.teamkill"], { serverIds }),
      ctx.repo.matches.participants(matchRows.map((m) => m.matchId)),
    ]);
    const combatGame = servers.find((s) => s.id === matchRows[0]?.serverId)?.game ?? servers[0]?.game;
    const combat = buildCombatAnalytics({
      playerId: player.id,
      events: combatEvents,
      matches: matchRows,
      participants: matchParticipants,
      career: { kills: stats?.kills ?? 0, deaths: stats?.deaths ?? 0, playtimeSec: stats?.playtimeSec ?? 0 },
      descriptor: getGame(combatGame)?.descriptor ?? null,
      serverNames: serverName,
      modeOf: inferMode,
    });
    // `stats` is the career — every server summed, which is what a profile means. `statsByServer`
    // breaks it back down, so "600 kills" can be read as where they were actually earned, and is
    // narrowed to servers this viewer may see: a profile is community-wide, a server's numbers
    // are not.
    // The unattributed bucket is history from before stats carried a server, on an install that
    // ran several. It is real play and belongs in the career total, but no server can claim it —
    // so it is shown to anyone who can see the profile at all, named for what it is rather than
    // as an all-zero uuid.
    const visibleStats = statsByServer.filter((s) =>
      s.serverId === UNATTRIBUTED_SERVER_ID || (s.serverId != null && can(p.grants, "server.view", "read", { serverId: s.serverId })));
    sendJson(res, 200, {
      player, stats,
      statsByServer: visibleStats.map((s) => ({
        ...s,
        serverName: s.serverId === UNATTRIBUTED_SERVER_ID
          ? "Before per-server tracking"
          : serverName.get(s.serverId!) ?? s.serverId,
      })),
      /*
       * The watch BOOLEAN stays: it is the 👁 mark, and the live roster shows it to anyone who can
       * see the roster at all, so hiding it here would only make the profile disagree with the
       * page you clicked through from. What is withheld is the provenance — the reason, who set it
       * and when, and the full spell history — because "suspected of cheating, watched by X" is a
       * staff note about a person, not a marker.
       */
      flags: (() => {
        const f = flags ?? { playerId: player.id, watchlist: false, vip: false, updatedByName: null, updatedAt: null, watchReason: null, watchBy: null, watchAt: null };
        return canWatchView ? f : { ...f, ...WATCH_PROVENANCE_WITHHELD };
      })(),
      watchHistory: canWatchView ? watchHistory : undefined,
      canViewWatch: canWatchView,
      recentEvents, notes, canViewNotes: canNotes, pastNames, clanTags, currentClan,
      vipStatus: canVipView ? vipStatus : undefined, canViewVip: canVipView,
      // The 🎥 chip's data, gated like the Console admins page it summarises. Badges are NOT
      // gated: they are community furniture (the roster shows them to everyone who can see the
      // roster), and a profile that disagrees with the page you clicked through from reads as
      // a bug, not as discretion.
      consoleAdminStatus: canAnywhere(p.grants, "server.admins", "read") ? consoleAdminStatus : undefined,
      roleBadges,
      sessions: sessionsOut, moderation, canViewModeration: canMod,
      tags, onlineNow: onlineServers.length > 0, onlineServers, links: canLinksView ? links : undefined,
      // The same account's other rows, ready to click through — name + game so the panel can say
      // "also their Vietnam account" without a second request.
      sameAccount: canLinksView ? [...sameAccount.values()].map((o) => ({ playerId: o.id, name: o.name, game: o.game, platformId: o.platformId })) : undefined,
      canViewLinks: canLinksView,
      banStatus: canBansView ? { tempBan, permaBan } : undefined, canViewBans: canBansView,
      // Ban decisions are the Bans page's data about a person, so they share its gate.
      banDecisions: canBansView ? banDecisions : undefined,
      matchAnalytics, combat,
    });
  }),

  // Custom player flags/tags — add/remove a short colored label. Gated by the player.flags cap
  // (same as watchlist/VIP), and audited.
  route("POST", "/api/players/:id/tags", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.tags", "write")) return sendForbidden(res, "player.tags", "write");
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const body = await readJsonBody(req);
    const label = str(body.label).trim();
    if (!label) return sendError(res, 400, "label is required");
    const tag = await ctx.repo.playerTags.add({ playerId: player.id, label, note: boundedText(body.note, TEXT_MAX.note, "note") || null, createdByName: p.name });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.tag",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `flagged ${player.name}: ${label}`,
    });
    sendJson(res, 201, { tag });
  }),

  route("DELETE", "/api/players/:id/tags/:tagId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.tags", "write")) return sendForbidden(res, "player.tags", "write");
    const removed = await ctx.repo.playerTags.remove(params.tagId!);
    if (!removed) return sendError(res, 404, "tag not found");
    // Adding a tag was on the trail and removing one was not, so a tag could come off a player
    // with no record of who took it off — the half of the pair that actually gets questioned.
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.tag_remove",
      targetType: "player", targetId: params.id!,
      summary: `removed the tag "${removed.label}" from a player`,
      data: { label: removed.label, note: removed.note, tagId: params.tagId, addedBy: removed.createdByName },
    });
    sendJson(res, 200, { ok: true });
  }),

  // Link (or clear) an external identity on a player — (provider, externalId), e.g. discord.
  // Generic on purpose: integrations/plugins add providers without core schema changes.
  // Gated by player.flags (same as watch/VIP/tags) and audited.
  route("PATCH", "/api/players/:id/links", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.links", "write")) return sendForbidden(res, "player.links", "write");
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const body = await readJsonBody(req);
    const provider = str(body.provider).trim().toLowerCase();
    if (!provider) return sendError(res, 400, "provider is required");
    const externalId = str(body.externalId).trim() || null;
    // One identity, one player PER GAME. Without this check the same Discord id could quietly
    // land on two players of one game, and every reverse lookup from then on picks one at random:
    // claims pay the wrong person, ballots double-count. Across games it is the NORMAL state —
    // one human holds a WW2 account and a Vietnam account — so only a same-game holder refuses.
    if (externalId) {
      const holders = await ctx.repo.externalLinks.findPlayers(provider, externalId);
      const other = holders.find((h) => h.id !== player.id && h.game === player.game);
      if (other) {
        return sendError(res, 409, `that ${provider} id is already linked to ${other.name} — clear it there first`);
      }
    }
    // What was there before the write — role sync needs to know who LOST the game, not just who
    // gained it, and after the set that information is gone.
    const previous = provider === "discord"
      ? (await ctx.repo.externalLinks.list(player.id)).find((l) => l.provider === "discord")?.externalId ?? null
      : null;
    await ctx.repo.externalLinks.set(player.id, provider, externalId, p.name);
    let welcome: string[] = [];
    // Per-game registration roles follow the link, both directions: clearing here is exactly how
    // staff re-open a member's self-service registration, and the role must not outlive the link.
    if (provider === "discord") {
      if (externalId) await syncGameRoles(ctx.repo, externalId);
      if (previous && previous !== externalId) await syncGameRoles(ctx.repo, previous);
      // The evasion tripwire: a fresh game account is clean by construction, but the Discord it
      // just linked is not — if it also owns a banned account, this one gets watchlisted now.
      if (externalId) await flagBanEvasion(ctx.repo, player, externalId, { via: "panel link" }).catch(() => {});
      /*
       * The registration welcome — paid on a FIRST link whoever makes it, so a member staff link
       * from here is welcomed exactly as one who typed the in-game code, or whom staff linked from
       * Discord. Only for a link this save made (not a clear, not a re-save of the link already
       * there), and through the same function as those two: its key is what keeps an account paid
       * once (per game with bonusPerGame), whichever way it was linked first. A bonus that fails
       * never undoes the link — the link is the record, and the next link pays what did not land.
       */
      if (externalId && externalId !== previous) {
        try {
          await ctx.repo.economy.ensureMember(externalId);
          welcome = (await applyWelcomeBonus(ctx.repo, externalId, player)).map((b) => b.replace(/\*\*/g, ""));
        } catch (err) {
          log.warn("registration welcome on a panel link failed — the link stands", { playerId: player.id, err: (err as Error).message });
        }
      }
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.link",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `${externalId ? "linked" : "cleared"} ${provider} for ${player.name}${welcome.length ? ` — welcome bonus paid: ${welcome.join(" and ")}` : ""}`,
      ...(welcome.length ? { data: { welcome } } : {}),
    });
    sendJson(res, 200, { links: await ctx.repo.externalLinks.list(player.id), ...(welcome.length ? { welcome } : {}) });
  }),

  // IP history — sensitive, so it has its own capability instead of riding on player.view. Each
  // row also carries who ELSE was seen on that address (the alt-account cross-reference), already
  // resolved to names so the panel needs no second round-trip.
  route("GET", "/api/players/:id/ips", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.ips", "read")) return sendForbidden(res, "player.ips", "read");
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const rows = await ctx.repo.playerIps.list(player.id);
    // Two queries for the whole page rather than one per address plus one per sharer: someone with
    // fifty recorded addresses was several hundred round-trips to open their IP tab.
    const sightings = await ctx.repo.playerIps.byIps(rows.map((r) => r.ip));
    const sharersByIp = new Map<string, string[]>();
    for (const o of sightings) {
      if (o.playerId === player.id) continue;
      const held = sharersByIp.get(o.ip) ?? [];
      // Capped per address: the panel shows a handful, and a shared VPN exit can have thousands.
      if (held.length < 10 && !held.includes(o.playerId)) sharersByIp.set(o.ip, [...held, o.playerId]);
    }
    const sharerNames = new Map(
      (await ctx.repo.players.findByIds([...sharersByIp.values()].flat())).map((sp) => [sp.id, sp.name]),
    );
    const ips = rows.map((r) => ({
      ...r,
      sharedWith: (sharersByIp.get(r.ip) ?? []).map((id) => ({ playerId: id, name: sharerNames.get(id) ?? id })),
    }));
    sendJson(res, 200, { ips });
  }),

  /**
   * Every VIP grant and revoke for one player, oldest last.
   *
   * The VIP list answers "who has one now"; it cannot answer "was this taken away in March and
   * given back last week, and by whom". The audit log has recorded that all along — vip.grant and
   * vip.revoke carry the player as their target — so this is a read of history we already keep,
   * not new bookkeeping.
   */
  route("GET", "/api/players/:id/vip-history", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // There is no "vip" capability — the catalog splits it into vip.grant and vip.revoke, and
    // capability matching is exact, so the old `can(…, "vip", …)` here matched only the owner's
    // wildcard and 403'd every admin who actually holds VIP rights. Either side of the pair can
    // read the history, mirroring the nav, and `canAnywhere` because the history spans servers.
    if (!canAnywhere(p.grants, "vip.grant", "read") && !canAnywhere(p.grants, "vip.revoke", "read")) {
      return sendForbidden(res, "vip.grant", "read");
    }
    const player = await ctx.repo.players.findById(params.id!);
    // Entries are keyed by the platform id — the value the grant route was given — so an entry can
    // exist for a player we have no row for, and the raw id is the right fallback lookup.
    const targetId = player?.platformId ?? params.id!;
    // vip.reduce is part of this story on purpose: the timeline exists to answer "why is my VIP
    // gone (or shorter)?", and a reduction is precisely that answer. Its rows carry the new expiry
    // in `after` (null when the subtraction used the grant up) and the amount in removedDays/Hours.
    //
    // vip.expire and seed.reward joined for the same reason, learned the hard way: a player's
    // PAID permanent VIP was rewritten to a dated grant by the seed reward and then removed by
    // the expiry sweep — and this view, the exact screen staff open to investigate, showed
    // neither event. "28 grants, 1 revoke" with the destroying write invisible between them is
    // how the loss read as a mystery instead of a receipt. A seed.reward row appears only when
    // it actually moved the expiration (dry runs and permanent-kept skips changed nothing).
    // game.reward too: a top-stats, streak or days-in-a-row reward that paid VIP moved this
    // player's expiry exactly like a seed reward does, and the profile's VIP status would show
    // time this timeline could not account for.
    // Rule VIP (crash VIP, the no-VIP trigger) comes from the rule enforcer, which keys its rows by
    // the player's PROFILE id rather than the game id — read separately and merged, newest first.
    const entries = [
      ...await ctx.repo.audit.list({ targetId, actions: ["vip.grant", "vip.revoke", "vip.reduce", "vip.expire", "vip.group_hold", "vip.group_release"], limit: 200 }),
      // Rewards read apart, and only those that moved the expiry: a regular collects a points-only
      // game.reward every match and a seeder a reward row most days, and in one shared page they
      // crowded the grants — the rows this timeline exists for — out of it.
      ...await ctx.repo.audit.list({ targetId, actions: ["seed.reward", "game.reward"], dataExpirationSet: true, limit: 150 }),
      ...(player ? await ctx.repo.audit.list({ targetId: player.id, actions: ["enforcer.vip"], limit: 50 }) : []),
    ].sort((a, b) => b.ts.localeCompare(a.ts));
    const servers = await ctx.repo.servers.list({ includeRetired: true }); // VIP history predating a retirement stays readable
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const nameById = await currentActorNames(ctx);
    const rows = entries.filter((e) => {
      // Each server's part of the story only to someone who may open that server's VIP list.
      if (e.serverId && !seesVipOn(p, e.serverId)) return false;
      if (e.action !== "seed.reward" && e.action !== "game.reward" && e.action !== "enforcer.vip") return true;
      // Only a reward that actually MOVED the expiry: dry runs, points-only rewards and
      // permanent-kept skips changed nothing about this player's VIP.
      const d = (e.data ?? {}) as { expiration?: string | null; dryRun?: boolean };
      return Boolean(d.expiration) && !d.dryRun;
    });
    sendJson(res, 200, {
      history: rows.map((e) => {
        const d = (e.data ?? {}) as { expiration?: string | null; comment?: string | null; after?: string | null; removedDays?: number; removedHours?: number; removedMs?: number; bankedMs?: number; severanceMinutes?: number; groupHeld?: boolean };
        const hours = (ms: number | undefined) => `${Math.round((ms ?? 0) / 3_600_000)}h`;
        return {
          id: e.id,
          ts: e.ts,
          action: e.action === "vip.grant" ? "granted"
            : e.action === "vip.group_hold" ? "group perk"
            : e.action === "vip.group_release" ? "group perk ended"
            : e.action === "vip.reduce" ? "reduced"
            : e.action === "vip.expire" ? "expired"
            : e.action === "seed.reward" ? "seed reward"
            : e.action === "game.reward" ? "game reward"
            : e.action === "enforcer.vip" ? "rule VIP" : "revoked",
          by: (e.actorUserId && nameById.get(e.actorUserId)) || e.actorName,
          byUserId: e.actorUserId,
          serverId: e.serverId,
          serverName: e.serverId ? serverName.get(e.serverId) ?? null : null,
          expiration: e.action === "vip.reduce" ? d.after ?? null : d.expiration ?? null,
          // Written while a group perk held the grant: the row stayed permanent (the group's), and
          // the change landed in the VIP of their own frozen beneath it.
          held: d.groupHeld === true,
          comment: e.action === "vip.group_hold" ? `permanent while in the group${d.bankedMs ? ` — ${hours(d.bankedMs)} of timed VIP frozen` : ""}`
            : e.action === "vip.group_release" ? `left the group — ${d.bankedMs ? `${hours(d.bankedMs)} given back` : "nothing frozen"}${d.severanceMinutes ? ` + ${hours(d.severanceMinutes * 60_000)} severance` : ""}`
            : e.action === "vip.grant" && d.groupHeld ? `${d.comment ? `${d.comment} — ` : ""}added to the VIP they get back on leaving their group`
            : e.action === "vip.revoke" && d.groupHeld ? `their own VIP revoked (${hours(d.removedMs)} they would have got back on leaving their group) — the group's VIP stands while they are listed`
            : e.action === "vip.reduce" && d.groupHeld ? `${hours(d.removedMs)} taken from the VIP they get back on leaving their group — ${hours(d.bankedMs)} left`
            : e.action === "vip.reduce"
            ? `${[d.removedDays ? `${d.removedDays}d` : "", d.removedHours ? `${d.removedHours}h` : ""].filter(Boolean).join(" ")} taken back`
            : e.action === "vip.expire" ? "grant reached its expiration — removed by the sweep"
            : e.action === "seed.reward" ? "seed reward moved the expiry"
            : e.action === "enforcer.vip" ? ruleVipComment(e.data)
            : e.action === "game.reward" ? `game reward moved the expiry${typeof (e.data as { vipGiven?: number } | null)?.vipGiven === "number" ? ` (+${(e.data as { vipGiven: number }).vipGiven}h)` : ""}`
            : d.comment ?? null,
        };
      }),
    });
  }),

  /**
   * VIP integrity: permanent grants automation dated or destroyed, and DATED grants whose
   * expiry automation moved earlier — the scan behind "I cannot have players losing VIP they
   * paid for", extended to hours they earned. Findings come
   * with the receipts (which automated write, when) and are ordered worst-first: already-lost
   * grants, then standing rows by how soon their wrongly-written date will remove them. The
   * VIPs page renders this with a restore button beside each row.
   */
  route("GET", "/api/vips/integrity", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "vip.grant", "read") && !canAnywhere(p.grants, "vip.revoke", "read")) {
      return sendForbidden(res, "vip.grant", "read");
    }
    // The WHOLE VIP slice of the audit trail, oldest first, streamed through the scan a page at a
    // time. It used to stop at 20,000 rows — taken oldest first, so on a busy install (the VIP sync
    // writes a row for every grant it puts back on the game) the rows it dropped were the NEWEST:
    // every dismissal and every add-back, which is why both came straight back on the next recheck.
    // Nothing is held but the per-player stories, so there is no cap to outgrow.
    const scan = vipIntegrityScanner();
    let scanned = 0;
    let cursor: string | null = null;
    do {
      const page: { rows: AuditRow[]; next: string | null } = await ctx.repo.audit.vipTimeline(cursor, 5000);
      for (const e of page.rows) {
        // A rule's VIP (crash VIP, the no-VIP trigger) keys its row by the player's PROFILE id; the
        // scan keys by game id, which the row carries in its data.
        let targetId = e.targetId;
        if (e.action === "enforcer.vip") {
          const pid = (e.data as { playerId?: unknown } | null)?.playerId;
          if (typeof pid !== "string" || !pid) continue;
          targetId = pid;
        }
        scan.feed({ ts: e.ts, action: e.action, automated: e.automated, actorName: e.actorName, serverId: e.serverId, targetId, targetName: e.targetName, data: e.data });
        scanned += 1;
      }
      cursor = page.next;
    } while (cursor);
    const vips = await ctx.repo.vips.list();
    const servers = await ctx.repo.servers.list({ includeRetired: true }); // findings name retired servers honestly
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const findings = scan.findings(vips.map((v) => ({ serverId: v.serverId, playerId: v.playerId, playerName: v.playerName, expiration: v.expiration })));
    sendJson(res, 200, {
      // The whole trail is read, as a finding's story can start anywhere; each finding is shown to
      // someone who may open that server's VIP list.
      findings: findings.filter((f) => seesVipOn(p, f.serverId)).map((f) => ({ ...f, serverName: serverName.get(f.serverId) ?? null })),
      scanned,
    });
  }),

  /*
   * Dismiss one integrity finding: "this removal was intentional". Persisted as an AUDIT event
   * rather than a table of its own, because the scan already reads the trail and already treats
   * a person's decision as the close of a story — the dismissal simply IS one. That also scopes
   * it correctly for free: it closes the story up to this instant, and anything automation takes
   * afterwards anchors a fresh story and surfaces again. Recorded with the dismisser's name, so
   * "why does this player not show" is answerable from Staff activity like any other decision.
   */
  route("POST", "/api/vips/integrity/ignore", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const body = await readJsonBody(req);
    const serverId = str(body.serverId);
    const playerId = str(body.playerId);
    if (!serverId || !playerId) return sendError(res, 400, "serverId and playerId are required");
    // Either VIP write permission on THAT server: endorsing a removal is the same judgement
    // call as making one, and a scoped moderator's reach stays their servers.
    if (!can(p.grants, "vip.grant", "write", { serverId }) && !can(p.grants, "vip.revoke", "write", { serverId })) {
      return sendForbidden(res, "vip.revoke", "write", { serverId });
    }
    const server = await ctx.repo.servers.findById(serverId);
    if (!server) return sendError(res, 404, "server not found");
    const playerName = boundedText(body.playerName, 120, "playerName") || null;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "vip.integrity_ignore",
      targetType: "player", targetId: playerId, targetName: playerName ?? undefined, serverId,
      summary: `dismissed the VIP integrity finding for ${playerName || playerId} on ${server.name} — judged the removal intentional`,
      data: {},
    });
    sendJson(res, 200, { ignored: true });
  }),

  /**
   * Per-player triggers — "when THIS player <event>, <action>", once or every time. The player-
   * scoped sibling of the server Rules engine; see player-triggers.ts. Reading the list needs only
   * player-directory access, but CREATING one is gated by the SAME capability the action would need
   * done by hand: a tempban trigger needs action.tempban, a VIP trigger needs vip.grant, points
   * need economy.balances. A trigger can never do what its author could not.
   */
  /** The overview: every player's triggers in one list, armed first — so an armed trigger is
   *  findable without remembering whose profile it lives on. Same read gate as the per-player
   *  list; its own path (not under /api/players/:id) so the :id resolver never swallows it. */
  route("GET", "/api/player-triggers", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    const scope = await triggerScope(ctx, p);
    const triggers = await ctx.repo.playerTriggers.listAll(undefined, scope.ids ?? undefined);
    const serverName = new Map(scope.servers.map((sv) => [sv.id, sv.name]));
    // Each summary names roles in its own player's game: one lookup for the whole list.
    const gameOf = new Map((await ctx.repo.players.findByIds([...new Set(triggers.map((t) => t.playerId))]).catch(() => [])).map((pl) => [pl.id, pl.game]));
    sendJson(res, 200, {
      triggers: triggers.map((t) => ({ ...t, serverName: t.serverId ? serverName.get(t.serverId) ?? null : null, summary: describeTrigger(t, roleNamerFor(gameOf.get(t.playerId))) })),
    });
  }),

  route("GET", "/api/players/:id/triggers", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    // :id may arrive as our record id or as the game's platform id (the player picker hands the
    // latter) — resolve either so the tab works from a search hit or a profile link alike.
    const player = (await ctx.repo.players.findById(params.id!)) ?? (await ctx.repo.players.findByPlatformId(params.id!));
    if (!player) return sendError(res, 404, "player not found");
    const scope = await triggerScope(ctx, p);
    const serverName = new Map(scope.servers.map((sv) => [sv.id, sv.name]));
    // Same scope rule as the overview — a profile is not a way around it. One player's list is
    // short, so it filters here rather than in the query.
    const triggers = (await ctx.repo.playerTriggers.listByPlayer(player.id)).filter((t) => scope.may(t.serverId));
    const roleName = roleNamerFor(player.game);
    sendJson(res, 200, {
      triggers: triggers.map((t) => ({ ...t, serverName: t.serverId ? serverName.get(t.serverId) ?? null : null, summary: describeTrigger(t, roleName) })),
      // The player's game: the builder offers ITS roles for the roster conditions (role ids
      // collide across games, so the panel's own server is the wrong list to pick from), and only
      // the conditions that game has (no helicopters in WW2).
      game: player.game,
      rosterEvents: PLAYER_ROSTER_EVENTS.filter((ev) => stateTriggerAppliesTo(PLAYER_ROSTER_EVENT_KIND[ev], player.game)),
      // What THIS staff member may build — the panel greys out actions they cannot grant.
      allowedActions: TRIGGER_ACTIONS.filter((a) => {
        const need = ACTION_CAPABILITY[a];
        return canAnywhere(p.grants, need.cap, need.level);
      }),
    });
  }),

  route("POST", "/api/players/:id/triggers", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const player = (await ctx.repo.players.findById(params.id!)) ?? (await ctx.repo.players.findByPlatformId(params.id!));
    if (!player) return sendError(res, 404, "player not found");
    const body = await readJsonBody(req);
    const parsed = await readTriggerDefinition(ctx, p, body, player.game);
    if ("error" in parsed) return sendError(res, parsed.status, parsed.error);
    const { event, params: eventParams, steps, serverId, fireOnce, note } = parsed.def;
    for (const need of capabilitiesForSteps(steps)) {
      if (!mayBuildStep(p, need, serverId)) return sendForbidden(res, need.cap, need.level, { serverId: serverId });
    }
    const capRefusal = await triggerTempbanRefusal(ctx, p, steps, serverId);
    if (capRefusal) return sendError(res, 400, capRefusal);

    const trigger = await ctx.repo.playerTriggers.create({
      playerId: player.id, playerName: player.name, serverId, event, params: eventParams, steps, fireOnce, note,
      createdByUserId: p.user.id, createdByName: p.name,
    });
    // The runner's armed set learns about it NOW, same as the enforcer after a rule edit — a
    // welcome message armed a moment before the player connects must not miss its firing to the
    // 10-second timer.
    await ctx.playerTriggerRunner.refresh();
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "trigger.create",
      targetType: "player", targetId: player.id, targetName: player.name, serverId,
      summary: `set a player trigger on ${player.name || player.platformId}: ${describeTrigger(trigger, roleNamerFor(player.game))}${serverId ? "" : " (any server)"}`,
      data: { triggerId: trigger.id, event, params: eventParams, steps, fireOnce },
    });
    sendJson(res, 201, { trigger });
  }),

  route("PATCH", "/api/players/:id/triggers/:triggerId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const owner = (await ctx.repo.players.findById(params.id!)) ?? (await ctx.repo.players.findByPlatformId(params.id!));
    const trigger = await ctx.repo.playerTriggers.get(params.triggerId!);
    if (!trigger || !owner || trigger.playerId !== owner.id) return sendError(res, 404, "trigger not found");
    // Editing (enable/disable, note) needs every step's own capability, same as creating it.
    for (const need of capabilitiesForSteps(trigger.steps)) {
      const allowed = trigger.serverId ? can(p.grants, need.cap, "write", { serverId: trigger.serverId }) : canAnywhere(p.grants, need.cap, "write");
      if (!allowed) return sendForbidden(res, need.cap, need.level, { serverId: trigger.serverId });
    }
    const body = await readJsonBody(req);
    const patch: { enabled?: boolean; note?: string | null } = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled === true;
    if (body.note !== undefined) patch.note = boundedText(body.note, TEXT_MAX.note, "note") || null;
    // A zone set holds only the triggers that are switched on, so one deleted while this was off
    // surfaces here: refused like a save naming it, not armed to watch nothing.
    if (patch.enabled === true && trigger.event === "outofzone" && !(await ctx.repo.mapZones.get(String(trigger.params?.zoneSet ?? "")))) {
      return sendError(res, 400, "that zone set no longer exists — edit the trigger and pick one under Auto settings → Map zones");
    }
    const updated = await ctx.repo.playerTriggers.update(trigger.id, patch);
    // A disable takes hold NOW — a trigger switched off must not fire out of the stale armed set.
    await ctx.playerTriggerRunner.refresh();
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "trigger.update",
      targetType: "player", targetId: trigger.playerId, targetName: trigger.playerName ?? undefined, serverId: trigger.serverId,
      summary: `${patch.enabled === false ? "disabled" : patch.enabled === true ? "re-armed" : "edited"} a player trigger (${describeTrigger(trigger, roleNamerFor(owner.game))})`,
      data: { triggerId: trigger.id },
    });
    sendJson(res, 200, { trigger: updated });
  }),

  /**
   * Re-edit a trigger after it is made: its event, actions, scope, once/every and note. Whose
   * trigger it is does not change (that is a different trigger), and neither does its history —
   * author, fire count, last fired. Two gates, both needed: the editor must hold every capability
   * the trigger ALREADY uses on its current scope (to touch it at all, same as disable/delete), and
   * everything the NEW version would do, checked exactly as a create is. A spent one-shot stays
   * spent unless `rearm` is sent — fixing a typo on an old receipt must not quietly arm it again.
   */
  route("PUT", "/api/players/:id/triggers/:triggerId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const owner = (await ctx.repo.players.findById(params.id!)) ?? (await ctx.repo.players.findByPlatformId(params.id!));
    const trigger = await ctx.repo.playerTriggers.get(params.triggerId!);
    if (!trigger || !owner || trigger.playerId !== owner.id) return sendError(res, 404, "trigger not found");
    for (const need of capabilitiesForSteps(trigger.steps)) {
      const allowed = trigger.serverId ? can(p.grants, need.cap, "write", { serverId: trigger.serverId }) : canAnywhere(p.grants, need.cap, "write");
      if (!allowed) return sendForbidden(res, need.cap, need.level, { serverId: trigger.serverId });
    }
    const body = await readJsonBody(req);
    const parsed = await readTriggerDefinition(ctx, p, body, owner.game);
    if ("error" in parsed) return sendError(res, parsed.status, parsed.error);
    for (const need of capabilitiesForSteps(parsed.def.steps)) {
      if (!mayBuildStep(p, need, parsed.def.serverId)) return sendForbidden(res, need.cap, need.level, { serverId: parsed.def.serverId });
    }
    const capRefusal = await triggerTempbanRefusal(ctx, p, parsed.def.steps, parsed.def.serverId);
    if (capRefusal) return sendError(res, 400, capRefusal);
    const rearm = body.rearm === true && trigger.disarmedAt !== null;
    const updated = await ctx.repo.playerTriggers.edit(trigger.id, { ...parsed.def, editedByName: p.name, rearm });
    if (!updated) return sendError(res, 404, "trigger not found");
    // The armed set learns the new version NOW; a chain mid-delay sees updatedAt move and stops.
    await ctx.playerTriggerRunner.refresh();
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "trigger.update",
      targetType: "player", targetId: trigger.playerId, targetName: trigger.playerName ?? undefined, serverId: updated.serverId,
      summary: `edited a player trigger on ${trigger.playerName || owner.platformId}: ${describeTrigger(trigger, roleNamerFor(owner.game))} → ${describeTrigger(updated, roleNamerFor(owner.game))}${rearm ? " (armed again)" : ""}`,
      data: {
        triggerId: trigger.id, rearm,
        before: { event: trigger.event, params: trigger.params, steps: trigger.steps, serverId: trigger.serverId, fireOnce: trigger.fireOnce, note: trigger.note },
        after: { event: updated.event, params: updated.params, steps: updated.steps, serverId: updated.serverId, fireOnce: updated.fireOnce, note: updated.note },
      },
    });
    sendJson(res, 200, { trigger: updated });
  }),

  route("DELETE", "/api/players/:id/triggers/:triggerId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const owner = (await ctx.repo.players.findById(params.id!)) ?? (await ctx.repo.players.findByPlatformId(params.id!));
    const trigger = await ctx.repo.playerTriggers.get(params.triggerId!);
    if (!trigger || !owner || trigger.playerId !== owner.id) return sendError(res, 404, "trigger not found");
    for (const need of capabilitiesForSteps(trigger.steps)) {
      const allowed = trigger.serverId ? can(p.grants, need.cap, "write", { serverId: trigger.serverId }) : canAnywhere(p.grants, need.cap, "write");
      if (!allowed) return sendForbidden(res, need.cap, need.level, { serverId: trigger.serverId });
    }
    await ctx.repo.playerTriggers.remove(trigger.id);
    // Deletion takes hold NOW — a removed trigger must not fire out of the stale armed set.
    await ctx.playerTriggerRunner.refresh();
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "trigger.delete",
      targetType: "player", targetId: trigger.playerId, targetName: trigger.playerName ?? undefined, serverId: trigger.serverId,
      summary: `removed a player trigger (${describeTrigger(trigger, roleNamerFor(owner.game))})`,
      data: { triggerId: trigger.id },
    });
    sendJson(res, 200, { ok: true });
  }),

  route("POST", "/api/players/:id/notes", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.notes", "write")) return sendForbidden(res, "player.notes", "write");
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const body = str((await readJsonBody(req)).body).trim();
    if (!body) return sendError(res, 400, "note body is required");
    const note = await ctx.repo.playerNotes.create({ playerId: player.id, authorUserId: p.user.id, authorName: p.name, body });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "note.create",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `noted ${player.name}: ${body.slice(0, 80)}`,
    });
    sendJson(res, 201, { note });
  }),

  route("PATCH", "/api/players/:id/flags", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const body = await readJsonBody(req);
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    /*
     * VIP is NOT settable here any more.
     *
     * There used to be two VIPs: a real grant on a server, and a cosmetic star anyone with
     * player.flags could tick or untick. Two sources for one fact is one too many — staff could
     * clear the star off a player who genuinely held VIP, or leave one lit on a player whose grant
     * expired months ago, and the profile then disagreed with the game. The star is now purely a
     * read of the grants, so there is nothing here to set.
     */
    if (body.vip !== undefined) {
      return sendError(res, 400, "vip is not a flag — VIP is a grant. Use the Edit VIP action (vip.grant / vip.revoke); the star follows the grant automatically.");
    }
    if (typeof body.watchlist !== "boolean") return sendError(res, 400, "provide watchlist (boolean)");
    /*
     * Per DIRECTION, and each direction can be captured or asked for like any other action:
     * adding to the watchlist is the base write; taking somebody off it closes every reason on
     * them — including other staff's — which is curation, and the likeliest thing a newer
     * moderator has to ask somebody else for.
     */
    const flagLine = () => ({
      serverId: null,
      capability: body.watchlist === false ? "player.watchlist.curate" : "player.watchlist",
      kind: body.watchlist === false ? "unwatch" : "watch",
      payload: { playerDbId: player.id, playerId: player.platformId, playerName: player.name, reason: boundedText(body.reason, TEXT_MAX.reason, "reason") || undefined },
      playerId: player.platformId, playerName: player.name,
    });
    if (body.draft === true) return sendJson(res, 202, await captureLine(ctx, p, flagLine()));
    const direction = body.watchlist === false ? "player.watchlist.curate" : "player.watchlist";
    if (!canAnywhere(p.grants, direction, "write")) {
      const filed = await fileRequest(ctx, p, [flagLine()]);
      void postApprovalCard(ctx, filed.id);
      return sendJson(res, 202, { requested: true, requestId: filed.id });
    }
    /*
     * A watch is made of REASONS now (watch_reasons), and this older route keeps its contract by
     * mapping onto them: watch-on ADDS a reason beside whatever is already recorded (it used to
     * silently overwrite the standing one), watch-off closes every active reason. The flag every
     * consumer reads is the cache the sync maintains.
     */
    const by = { userId: p.user.id, name: p.name };
    let flags;
    if (body.watchlist === true) {
      const reason = boundedText(body.reason, TEXT_MAX.reason, "reason");
      const current = await ctx.repo.playerFlags.get(player.id);
      if (reason) {
        ({ flags } = await addWatchReason(ctx.repo, player.id, { reason, by }));
      } else if (current?.watchlist) {
        // Re-asserting a standing watch with nothing to say changes nothing — and must not: the
        // provenance on the flag is the story staff read, and a placeholder reason would displace
        // it. (Also the safe reading for a pre-migration watch with no reason rows yet.)
        flags = current;
      } else {
        ({ flags } = await addWatchReason(ctx.repo, player.id, { reason: "on the watchlist", by }));
      }
    } else {
      await ctx.repo.watchReasons.removeAll(player.id, p.name);
      flags = await syncWatchFlag(ctx.repo, player.id, by);
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.flags",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `${flags.watchlist ? "added" : "removed"} ${player.name} ${flags.watchlist ? "to" : "from"} the watchlist${body.watchlist === true && flags.watchReason ? ` — ${flags.watchReason}` : ""}`,
      data: { watchlist: flags.watchlist, ...(flags.watchReason ? { watchReason: flags.watchReason } : {}) },
    });
    sendJson(res, 200, { flags });
  }),

  // --- The watch record itself: every reason, active and closed, with each row's edit history.
  //     Read is the watch capability's read half — the same person who can see the 👁 can see why.
  route("GET", "/api/players/:id/watch", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.watchlist", "read")) return sendForbidden(res, "player.watchlist", "read");
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const [flags, reasons] = await Promise.all([
      ctx.repo.playerFlags.get(player.id),
      ctx.repo.watchReasons.list(player.id),
    ]);
    // `own` is decided HERE, against the caller's account id, so the panel can offer Edit on
    // exactly the rows this route's PATCH will accept — the client never guesses ownership.
    sendJson(res, 200, {
      watched: flags?.watchlist ?? false,
      reasons: reasons.map((r) => ({ ...r, own: r.addedByUserId !== null && r.addedByUserId === p.user.id })),
    });
  }),

  // Add one reason. Arms the watch when it is the first; on an already-watched player it sits
  // beside the existing reasons — which is what "add to watchlist" always should have meant.
  route("POST", "/api/players/:id/watch/reasons", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const body = await readJsonBody(req);
    const reason = boundedText(body.reason, TEXT_MAX.reason, "reason");
    if (!reason) return sendError(res, 400, "reason is required — a watch with nothing to say is a 👁 nobody can act on");
    const expiresAt = parseWatchExpiry(body.expiresAt);
    if (expiresAt instanceof Error) return sendError(res, 400, expiresAt.message);
    /*
     * Validated first, then routed — same shape as every other action: the builder captures it,
     * and someone without the write files it. A watch is a moderation decision like any other, so
     * "I think this player needs watching" is a thing to be able to ASK for; it used to be the one
     * action on the player menu that fired mid-build and 403'd without the permission, while the
     * bar overhead promised nothing had been executed.
     */
    const watchLine = () => ({
      serverId: null, capability: "player.watchlist", kind: "watch",
      payload: { playerDbId: player.id, playerId: player.platformId, playerName: player.name, reason, expiresAt: expiresAt ?? undefined },
      playerId: player.platformId, playerName: player.name,
    });
    if (body.draft === true) return sendJson(res, 202, await captureLine(ctx, p, watchLine()));
    if (!canAnywhere(p.grants, "player.watchlist", "write")) {
      const filed = await fileRequest(ctx, p, [watchLine()]);
      void postApprovalCard(ctx, filed.id);
      return sendJson(res, 202, { requested: true, requestId: filed.id });
    }
    const { reason: row, flags } = await addWatchReason(ctx.repo, player.id, { reason, by: { userId: p.user.id, name: p.name }, expiresAt });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.watchlist",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `added a watch reason for ${player.name} — ${reason}${expiresAt ? ` (expires ${expiresAt})` : ""}`,
      data: { op: "add-reason", reasonId: row?.id, reason, expiresAt },
    });
    sendJson(res, 201, { reason: row, flags });
  }),

  // Edit one reason's text and/or expiry. The previous version is archived on the row FIRST —
  // "pre edits should remain retrievable" is a moderation-record requirement, not a nicety.
  route("PATCH", "/api/players/:id/watch/reasons/:reasonId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.watchlist", "write")) return sendForbidden(res, "player.watchlist", "write");
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const existing = await ctx.repo.watchReasons.get(params.reasonId!);
    if (!existing || existing.playerId !== player.id) return sendError(res, 404, "watch reason not found");
    if (existing.removedAt) return sendError(res, 400, "this reason was removed — closed history cannot be rewritten");
    // Your OWN reason you may sharpen (every previous version stays on the row); another staff
    // member's is theirs until a curator says otherwise. Ownership is the account id — a row
    // from before the split carries none and reads as "not provably yours".
    const own = existing.addedByUserId !== null && existing.addedByUserId === p.user.id;
    if (!own && !canAnywhere(p.grants, "player.watchlist.curate", "write")) {
      return sendForbidden(res, "player.watchlist.curate", "write");
    }
    const body = await readJsonBody(req);
    const patch: { reason?: string; expiresAt?: string | null } = {};
    if (body.reason !== undefined) {
      const text = boundedText(body.reason, TEXT_MAX.reason, "reason");
      if (!text) return sendError(res, 400, "reason cannot be blank — remove it instead");
      patch.reason = text;
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = parseWatchExpiry(body.expiresAt);
      if (expiresAt instanceof Error) return sendError(res, 400, expiresAt.message);
      patch.expiresAt = expiresAt;
    }
    if (patch.reason === undefined && patch.expiresAt === undefined) return sendError(res, 400, "nothing to change — provide reason and/or expiresAt");
    const row = await ctx.repo.watchReasons.edit(existing.id, patch, p.name);
    const flags = await syncWatchFlag(ctx.repo, player.id, { userId: p.user.id, name: p.name });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.watchlist",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `edited a watch reason for ${player.name} — now: ${row?.reason}`,
      // The before/after pair rides in the trail too, so the change is reviewable even there.
      data: { op: "edit-reason", reasonId: existing.id, before: { reason: existing.reason, expiresAt: existing.expiresAt }, after: { reason: row?.reason, expiresAt: row?.expiresAt } },
    });
    sendJson(res, 200, { reason: row, flags });
  }),

  // Remove ONE reason (closing it, never deleting). The watch stands while other reasons remain.
  // Curation-only — your OWN included, by request: what went into the record stays until someone
  // trusted with the record says otherwise. (You can still sharpen your own wording; the edit
  // path above allows that because every previous version remains readable.)
  route("DELETE", "/api/players/:id/watch/reasons/:reasonId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "player.watchlist.curate", "write")) return sendForbidden(res, "player.watchlist.curate", "write");
    const player = await ctx.repo.players.findById(params.id!);
    if (!player) return sendError(res, 404, "player not found");
    const existing = await ctx.repo.watchReasons.get(params.reasonId!);
    if (!existing || existing.playerId !== player.id) return sendError(res, 404, "watch reason not found");
    const row = await ctx.repo.watchReasons.remove(existing.id, p.name);
    if (!row) return sendError(res, 400, "this reason is already removed");
    const flags = await syncWatchFlag(ctx.repo, player.id, { userId: p.user.id, name: p.name });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.watchlist",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `removed a watch reason from ${player.name} — ${existing.reason}${flags.watchlist ? "" : "; that was the last one, so the watch is lifted"}`,
      data: { op: "remove-reason", reasonId: existing.id, reason: existing.reason, stillWatched: flags.watchlist },
    });
    sendJson(res, 200, { reason: row, flags });
  }),

  // --- VIP pause: a VIP timeout as a moderation action. The grant survives — its expiration keeps
  //     running (the lost time IS the punishment) and grants/seeding still extend it — but the VIP
  //     comes off the game and nothing re-adds it until the pause lapses (the worker sweep restores
  //     it) or staff resume early. Pauses every grant the caller may pause; audited like a ban. ---
  route("POST", "/api/players/:id/vip/pause", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const rawId = params.id!;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const player = (isUuid ? await ctx.repo.players.findById(rawId) : null) ?? await ctx.repo.players.findByPlatformId(rawId);
    if (!player) return sendError(res, 404, "player not found");
    const body = await readJsonBody(req);
    const reason = str(body.reason).trim().slice(0, 500);
    if (!reason) return sendError(res, 400, "reason is required — it is the punishment record");
    const hours = Number(body.hours);
    if (!Number.isFinite(hours) || hours <= 0) return sendError(res, 400, "hours must be a positive number");
    if (hours > 24 * 365) return sendError(res, 400, "a pause runs at most a year — revoke the VIP instead");
    // 'running' (the harsher default): the expiration keeps ticking — the lost time is the
    // punishment. 'banked': the meter freezes; the paused time is added back on resume/lapse.
    const mode: "running" | "banked" = str(body.mode) === "banked" ? "banked" : "running";
    const startedAt = new Date().toISOString();
    const until = new Date(Date.now() + hours * 3_600_000).toISOString();

    // Optional scope: pause only the grant on ONE server (the popup's "this server only" choice).
    // Absent = every grant the caller may pause, which is also the pre-scoping behaviour.
    const onlyServerId = str(body.serverId).trim();
    // Not a retired server's grant: the profile no longer shows it, the server is out of every loop,
    // and a pause there would be a game write to a server this panel has let go. Its grant waits,
    // untouched, for the server to come back, as the worker's own pause sweep leaves it.
    const live = new Set((await ctx.repo.servers.list()).map((s) => s.id));
    const grants = (await ctx.repo.vips.listByPlayer(player.platformId)).filter((v) => live.has(v.serverId) && (!onlyServerId || v.serverId === onlyServerId));
    if (!grants.length) return sendError(res, 404, onlyServerId ? "this player holds no VIP grant on that server" : "this player holds no VIP grant");
    const targets = grants.filter((v) => can(p.grants, "vip.pause", "write", { serverId: v.serverId }));
    if (!targets.length) return sendForbidden(res, "vip.pause", "write", { serverId: grants.length === 1 ? grants[0]!.serverId : null });

    const applied: string[] = [];
    const gameErrors: string[] = [];
    for (const v of targets) {
      const server = await ctx.repo.servers.findById(v.serverId);
      if (!server) continue;
      // Take the VIP off the game NOW (active servers only; observe can't write — record-only
      // there, same posture as every other action). A failed game write still records the pause:
      // the row-level pause is what stops re-adds and drives every display.
      if (server.engagementMode === "active") {
        const client = gameClientFor(server);
        try { await connectGameClient(client, server); await client.execute("removeVip", { playerId: v.playerId }); }
        catch (err) { gameErrors.push(`${server.name}: ${(err as Error).message}`); }
        finally { await client.disconnect().catch(() => {}); }
      }
      await ctx.repo.vips.setPause(v.serverId, v.playerId, { until, reason, by: p.name, mode, at: startedAt });
      applied.push(server.name);
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.vippause",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `paused VIP for ${player.name || player.platformId} for ${hours}h (${mode === "banked" ? "hours banked" : "time keeps running"}) — ${reason}${applied.length ? ` (${applied.join(", ")})` : ""}`,
      data: { playerId: player.platformId, hours, until, reason, mode, servers: applied, gameErrors },
    });
    sendJson(res, 200, { until, mode, applied, gameErrors });
  }),

  // Resume early: clear the pause and put the VIP back on the game (if the grant is still valid).
  route("POST", "/api/players/:id/vip/resume", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const rawId = params.id!;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const player = (isUuid ? await ctx.repo.players.findById(rawId) : null) ?? await ctx.repo.players.findByPlatformId(rawId);
    if (!player) return sendError(res, 404, "player not found");
    const onlyServerId = str((await readJsonBody(req)).serverId).trim();
    // A pause on a retired server stays as it is and runs out once the server is back (see pause).
    const live = new Set((await ctx.repo.servers.list()).map((s) => s.id));
    const paused = (await ctx.repo.vips.listByPlayer(player.platformId)).filter((v) => v.pausedUntil && live.has(v.serverId) && (!onlyServerId || v.serverId === onlyServerId));
    if (!paused.length) return sendError(res, 404, "this player's VIP is not paused");
    const targets = paused.filter((v) => can(p.grants, "vip.pause", "write", { serverId: v.serverId }));
    if (!targets.length) return sendForbidden(res, "vip.pause", "write", { serverId: paused.length === 1 ? paused[0]!.serverId : null });

    const now = Date.now();
    // Each server's expiry after the banked time came back — the integrity scan reads it, so time
    // returned by a pause is defended like any other.
    const banked: { serverId: string; expiration: string }[] = [];
    const applied: string[] = [];
    const gameErrors: string[] = [];
    for (const v of targets) {
      const server = await ctx.repo.servers.findById(v.serverId);
      if (!server) continue;
      // Banked pause: the meter was frozen, so give back exactly the time the pause actually
      // lasted. (Running pauses give nothing back — the lost time was the punishment.)
      const bankMs = v.pauseMode === "banked" && v.expiration && v.pausedAt ? Math.max(0, now - Date.parse(v.pausedAt)) : 0;
      const expiration = bankMs > 0 ? new Date(Date.parse(v.expiration!) + bankMs).toISOString() : v.expiration;
      const stillValid = !expiration || Date.parse(expiration) > now;
      if (server.engagementMode === "active" && stillValid) {
        const client = gameClientFor(server);
        try { await connectGameClient(client, server); await client.execute("addVip", { playerId: v.playerId, description: v.playerName || player.name || "VIP" }); }
        catch (err) { gameErrors.push(`${server.name}: ${(err as Error).message}`); }
        finally { await client.disconnect().catch(() => {}); }
      }
      if (bankMs > 0) {
        // thawsPause: this date is already measured from now (see NewVip.thawsPause).
        await ctx.repo.vips.upsert({ serverId: v.serverId, playerId: v.playerId, playerName: v.playerName, comment: v.comment, expiration, createdByUserId: v.createdByUserId, createdByName: v.createdByName, thawsPause: true });
        if (expiration) banked.push({ serverId: v.serverId, expiration });
      }
      await ctx.repo.vips.setPause(v.serverId, v.playerId, null);
      applied.push(server.name);
    }
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "player.vipresume",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `resumed VIP for ${player.name || player.platformId}${applied.length ? ` (${applied.join(", ")})` : ""}`,
      data: { playerId: player.platformId, servers: applied, gameErrors, ...(banked.length ? { banked } : {}) },
    });
    sendJson(res, 200, { applied, gameErrors });
  }),

  // Career leaderboard (aggregated stats, kept forever — independent of raw-event trimming).
  route("GET", "/api/leaderboard", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "server.view", "read")) return sendForbidden(res, "server.view", "read");
    // `?serverId=` ranks one server; without it the board covers every server the viewer may see.
    // It used to always merge every server's careers into one ranking, under a sidebar pinned to
    // one of them — so two populations were ranked against each other and labelled as one.
    const scope = await serverScope(req, res, ctx, p, "server.view");
    if (!scope) return;
    const url = new URL(req.url ?? "", "http://x");
    // The whitelist is derived from the store's own union, so a column added there is orderable
    // here the same day. It used to be four hardcoded names, which meant the score buckets and
    // squad-leader time the sampler had been collecting for months could be ASKED for and were
    // silently answered with the kill board — the worst kind of wrong, because it looks right.
    const sortParam = url.searchParams.get("sort") ?? "kills";
    const sort: LeaderboardSort = (LEADERBOARD_SORTS as readonly string[]).includes(sortParam)
      ? (sortParam as LeaderboardSort)
      : "kills";
    // A page of the standings (`offset` places down), and how many players they rank in `total`.
    const [leaderboard, total] = await Promise.all([
      ctx.repo.stats.leaderboard(sort, pageLimit(url.searchParams, 50, 500), scope.serverIds, pageOffset(url.searchParams)),
      ctx.repo.stats.leaderboardCount(scope.serverIds),
    ]);
    sendJson(res, 200, {
      sort,
      // Echoed so the page can say what it is showing rather than leaving the reader to assume.
      serverId: scope.requested,
      leaderboard,
      total,
    });
  }),
];

/**
 * A trigger's definition out of a request body — event, action steps, scope, once/every, note —
 * with every SHAPE check a trigger answers to: each step valid, the chain's total delay bounded,
 * no trigger that causes its own event, a real server. Shared by create and edit, so an edit can
 * never build what a create would have refused. The PERMISSION checks follow in each route, in
 * this order: every step's capability (mayBuildStep), then the temp-ban cap (triggerTempbanRefusal).
 */
async function readTriggerDefinition(ctx: AppContext, p: Principal, body: Record<string, unknown>, game: string | null): Promise<
  | { def: { event: PlayerTriggerEvent; params: Record<string, unknown>; steps: PlayerTriggerStep[]; serverId: string | null; fireOnce: boolean; note: string | null } }
  | { status: number; error: string }
> {
  const event = str(body.event) as PlayerTriggerEvent;
  if (!TRIGGER_EVENTS.includes(event)) return { status: 400, error: `event must be one of: ${TRIGGER_EVENTS.join(", ")}` };
  // What the event needs beyond itself (the weapons a weapon-kill trigger listens for, a roster
  // condition's knobs), checked against the player's own game.
  const eventParams = parseEventParams(event, body.params, triggerGameOf(game));
  if ("error" in eventParams) return { status: 400, error: eventParams.error };
  // The allowed-area trigger names a zone set by id, as the Rules tab's does: one that is gone
  // would save fine and then watch nothing, forever.
  if (event === "outofzone" && !(await ctx.repo.mapZones.get(String(eventParams.params.zoneSet ?? "")))) {
    return { status: 400, error: "that zone set no longer exists — pick one under Auto settings → Map zones" };
  }

  // The steps: one or several actions, each with its own params and delay. The single-action
  // body shape (action/message/hours/points at the top level) still parses as one step, so
  // nothing scripted against the first version breaks.
  const rawSteps: unknown[] = Array.isArray(body.steps) && body.steps.length
    ? body.steps
    : [{ action: body.action, message: body.message, hours: body.hours, points: body.points, delaySec: body.delaySec }];
  if (rawSteps.length > MAX_TRIGGER_STEPS) return { status: 400, error: `a trigger may chain at most ${MAX_TRIGGER_STEPS} actions` };
  const steps: PlayerTriggerStep[] = [];
  for (const raw of rawSteps) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const step: PlayerTriggerStep = {
      action: str(r.action) as PlayerTriggerAction,
      message: boundedText(r.message, TEXT_MAX.note, "message") || null,
      hours: Math.max(0, Math.floor(Number(r.hours) || 0)),
      points: Math.max(0, Math.floor(Number(r.points) || 0)),
      delaySec: Math.max(0, Math.floor(Number(r.delaySec) || 0)),
    };
    const bad = stepError(step);
    if (bad) return { status: 400, error: bad };
    steps.push(step);
  }
  // Delays run back to back, so the honesty bound holds on their SUM, not just each step.
  const slowChain = chainDelayError(steps);
  if (slowChain) return { status: 400, error: slowChain };
  // A trigger must not be able to cause the very log line it fires on.
  const loop = triggerLoopError(event, steps);
  if (loop) return { status: 400, error: loop };

  // A specific server, or "any". A named server must be one this staff member can act on.
  let serverId: string | null = null;
  if (body.serverId != null && str(body.serverId) !== "") {
    const server = await ctx.repo.servers.findById(str(body.serverId));
    if (!server) return { status: 404, error: "server not found" };
    // A decommissioned server is not there to be scoped to — same 404 every other write gives.
    if (await decommissionLocked(ctx, p, server)) return { status: 404, error: "server not found" };
    serverId = server.id;
  }

  const fireOnce = body.fireOnce !== false; // default to the safe one-shot
  const note = boundedText(body.note, TEXT_MAX.note, "note") || null;
  return { def: { event, params: eventParams.params, steps, serverId, fireOnce, note } };
}

/** May this author build a step needing `need` on this scope? THE gate: chaining a message to a
 *  tempban is exactly as privileged as doing both by hand — an "any server" trigger needs each
 *  capability somewhere; a scoped one needs each on that server. */
function mayBuildStep(p: Principal, need: ReturnType<typeof capabilitiesForSteps>[number], serverId: string | null): boolean {
  return serverId ? can(p.grants, need.cap, "write", { serverId }) : canAnywhere(p.grants, need.cap, "write");
}

/**
 * The per-role temp-ban hour cap, held for triggers too — a trigger must not ban longer than its
 * author could by hand. A scoped trigger answers to the cap on that server; an "any server" one to
 * the most permissive cap on any server they can temp-ban on (the same somewhere-rule as the gate).
 */
async function triggerTempbanRefusal(ctx: AppContext, p: Principal, steps: PlayerTriggerStep[], serverId: string | null): Promise<string | null> {
  for (const st of steps) {
    if (st.action !== "tempban") continue;
    const hours = st.hours > 0 ? st.hours : 2; // the runner's default length answers to the cap too
    let refusal: string | null = null;
    if (serverId) {
      refusal = await tempbanRefusal(ctx.repo, p, serverId, hours);
    } else {
      const caps: number[] = [];
      for (const sv of await ctx.repo.servers.list()) {
        if (can(p.grants, "action.tempban", "write", { serverId: sv.id })) caps.push(await tempbanMaxHours(ctx.repo, p, sv.id));
      }
      const max = caps.length ? Math.max(...caps) : 0;
      if (Number.isFinite(max) && hours > max) refusal = `your temp-ban limit is ${max}h (asked for ${hours}h)`;
    }
    if (refusal) return refusal;
  }
  return null;
}
