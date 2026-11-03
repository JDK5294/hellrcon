/**
 * WHO or WHAT a filed call is about, in words an approver can sign.
 *
 * A path names its subject by id — `/api/users/4f1c…/roles`, `/api/player-groups/9a2e…/members` —
 * and the queue and the Discord card printed every path parameter but `id`, because on the
 * per-server screens `id` is the server and the line already names it. Off those screens `id` IS
 * the subject: "Set a staff account's roles" arrived with no account and "Delete a staff account"
 * with nothing at all, so an approver could sign away their own account without knowing it. Body
 * ids were no better ("roleIds", "duplicateId: 9a2e…").
 *
 * The names are read once, when the call is filed, and kept on the line: the queue and the card
 * say the same thing, and a later rename does not change what was asked. Anything that cannot be
 * named is printed as it came, so nothing a call is about goes unsaid.
 */
import type { AppContext } from "./context.js";
import { displayNameOf } from "./auth.js";
import { communityGuild, guildRoles } from "./discord-guild.js";

type Params = Record<string, string>;
type Body = Record<string, unknown>;

const quoted = (s: string) => `“${s.length > 60 ? `${s.slice(0, 60)}…` : s}”`;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function accountName(ctx: AppContext, id: string): Promise<string | null> {
  const user = await ctx.repo.users.findById(id);
  return user ? displayNameOf(user) : null;
}

/** An id the directory has never seen, with the name its request gave it marked as such. */
const unchecked = (id: string, claimed?: string) => (claimed ? `${id} (named ${quoted(claimed)} in the request)` : id);

/**
 * A player as the directory names them. The id is the profile's or, from some screens, the game's.
 * One the directory has never seen is printed as it came, and a name sent with it is marked as the
 * request's own words — never shown as if the app had checked it.
 */
async function playerWords(ctx: AppContext, id: string, claimed?: string): Promise<string> {
  const player = UUID.test(id) ? await ctx.repo.players.findById(id) : await ctx.repo.players.findByPlatformId(id);
  return `player: ${player ? player.name || id : unchecked(id, claimed)}`;
}

/** How many of a call's players are named before the rest are counted. */
const PLAYERS_SHOWN = 10;

/**
 * Several players at once — a bulk action, a bulk VIP grant — as the directory names them: the
 * first few, then how many more. "Run an action on several players · action: permaban" named
 * nobody, so a ban on any list at all was one signature away.
 */
async function playersWords(ctx: AppContext, list: unknown[]): Promise<string> {
  const claimed = new Map<string, string>();
  for (const x of list) {
    const id = str((x as Record<string, unknown> | null)?.playerId).trim();
    if (id && !claimed.has(id)) claimed.set(id, str((x as Record<string, unknown>).playerName));
  }
  const ids = [...claimed.keys()];
  if (!ids.length) return "players: none";
  const shown = ids.slice(0, PLAYERS_SHOWN);
  const known = new Map((await ctx.repo.players.findByPlatformIds(shown)).map((pl) => [pl.platformId, pl.name]));
  const words = shown.map((id) => known.get(id) || unchecked(id, claimed.get(id) || undefined));
  return `players (${ids.length}): ${words.join(", ")}${ids.length > shown.length ? ` +${ids.length - shown.length} more` : ""}`;
}

async function roleNames(ctx: AppContext, body: Body): Promise<string | null> {
  const wanted: { roleId: string; scopeId: string | null }[] = Array.isArray(body.roles)
    ? (body.roles as Record<string, unknown>[]).map((r) => ({ roleId: str(r?.roleId), scopeId: str(r?.scopeId) || null }))
    : Array.isArray(body.roleIds) ? (body.roleIds as unknown[]).map((id) => ({ roleId: str(id), scopeId: null })) : [];
  if (!Array.isArray(body.roles) && !Array.isArray(body.roleIds)) return null;
  if (!wanted.length) return "roles: none";
  const [roles, servers] = await Promise.all([ctx.repo.roles.getMany(wanted.map((w) => w.roleId)), ctx.repo.servers.list({ includeRetired: true })]);
  const role = new Map(roles.map((r) => [r.id, r.name]));
  const server = new Map(servers.map((s) => [s.id, s.name]));
  return `roles: ${wanted.map((w) => `${role.get(w.roleId) ?? w.roleId}${w.scopeId ? ` on ${server.get(w.scopeId) ?? w.scopeId}` : ""}`).join(", ")}`;
}

/** The words for ONE path parameter; null or undefined to print it as it came. */
async function nameParam(ctx: AppContext, route: string, key: string, value: string, params: Params): Promise<string | null | undefined> {
  const area = route.split("/")[2] ?? "";
  if (area === "users" && key === "id") { const n = await accountName(ctx, value); return n && `account: ${n}`; }
  if (area === "users" && key === "grantId") {
    const grant = (await ctx.repo.grants.listByUser(params.id ?? "")).find((g) => g.id === value);
    return grant && `permission: ${grant.capability} ${grant.level}${grant.scopeId ? ` on one server` : ""}`;
  }
  if (area === "roles" && key === "id") { const r = await ctx.repo.roles.get(value); return r && `role: ${r.name}`; }
  if (area === "player-groups" && key === "id") { const g = await ctx.repo.playerGroups.get(value); return g && `group: ${g.name}`; }
  if (key === "playerId" || (area === "players" && key === "id")) return playerWords(ctx, decodeURIComponent(value));
  if (area === "players" && key === "tagId") {
    const player = UUID.test(params.id ?? "") ? params.id! : (await ctx.repo.players.findByPlatformId(params.id ?? ""))?.id ?? "";
    const tag = (await ctx.repo.playerTags.list(player)).find((t) => t.id === value);
    return tag && `tag: ${quoted(tag.label)}`;
  }
  if (area === "players" && key === "reasonId") { const r = await ctx.repo.watchReasons.get(value); return r && `reason: ${quoted(r.reason)}`; }
  if (area === "players" && key === "triggerId") {
    const t = await ctx.repo.playerTriggers.get(value);
    return t && `trigger: ${t.event}${t.note ? ` ${quoted(t.note)}` : ""}`;
  }
  if (area === "enforcer" && route.includes("/rules/")) { const r = await ctx.repo.enforcerRules.get(value); return r && `rule: ${quoted(r.name)}`; }
  if (area === "enforcer" && route.includes("/sections/")) { const s = (await ctx.repo.ruleSections.list()).find((x) => x.id === value); return s && `section: ${quoted(s.name)}`; }
  if (route.includes("/versions/:id")) {
    const v = await ctx.repo.configVersions.get(value);
    return v && `${v.kind === "rule" ? "rule" : v.kind === "mapSet" ? "map set" : "schedule"} ${quoted(v.targetName ?? v.targetId)} as saved ${v.createdAt.slice(0, 16).replace("T", " ")} UTC`;
  }
  if (area === "zones" && key === "id") { const z = await ctx.repo.mapZones.get(value); return z && `zone set: ${quoted(z.name)}`; }
  if (area === "mapvote" && route.includes("/sets/")) { const m = await ctx.repo.mapSets.get(value); return m && `map set: ${quoted(m.name)}`; }
  if (area === "mapvote" && route.includes("/schedules/")) { const s = await ctx.repo.voteSchedules.get(value); return s && `schedule: ${quoted(s.name)}`; }
  if (area === "presets" && key === "presetId") {
    const p = (await ctx.repo.featurePresets.list(route.split("/")[3] ?? "")).find((x) => x.id === value);
    return p && `preset: ${quoted(p.name)}`;
  }
  if (area === "autosettings" && key === "templateId") return `template: ${quoted(value)}`;
  if (area === "templates" && key === "id") { const t = (await ctx.repo.templates.list()).find((x) => x.id === value); return t && `template: ${quoted(t.title || t.body)}`; }
  if (area === "vip-presets" && key === "id") { const v = (await ctx.repo.vipPresets.list()).find((x) => x.id === value); return v && `preset: ${quoted(v.label)}`; }
  if (area === "economy" && key === "discordId") { const m = await ctx.repo.economy.member(value); return `member: ${m?.discordName || value}`; }
  if (area === "economy" && key === "groupId") { const g = await ctx.repo.playerGroups.get(value); return g && `group: ${g.name}`; }
  if (area === "payout-events" && key === "id") { const e = await ctx.repo.payoutEvents.get(value); return e && `event: ${quoted(e.name)}`; }
  if (area === "community" && key === "id") { const a = await ctx.repo.announcements.get(value); return a && `notice: ${quoted(a.title)}`; }
  if (area === "discord" && key === "discordRoleId") {
    // Named by Discord when the bot can read the server's roles — the request's own
    // `discordRoleName` is whatever its sender typed.
    const name = (await guildRoles((await communityGuild(ctx.repo)).guildId))?.find((r) => r.id === value)?.name;
    return `Discord role: ${name ? `${name} (${value})` : value}`;
  }
  return null;
}

/** Ids a call carries in its BODY, named. */
async function bodySubjects(ctx: AppContext, method: string, route: string, body: Body): Promise<string[]> {
  const out: string[] = [];
  if (route === "/api/users/:id/roles" || route === "/api/discord/role-map/:discordRoleId") {
    const roles = await roleNames(ctx, body);
    if (roles) out.push(roles);
  }
  if (route === "/api/users/:id/merge" && str(body.duplicateId)) {
    out.push(`merging in and deleting: ${(await accountName(ctx, str(body.duplicateId))) ?? str(body.duplicateId)}`);
  }
  // A whole permission set, an account's or a role's: what it BECOMES is the thing being signed.
  if (Array.isArray(body.grants) && ((route === "/api/users/:id/grants" && method === "PUT") || route === "/api/roles" || route === "/api/roles/:id")) {
    const grants = (body.grants as Record<string, unknown>[]).map((g) => `${str(g?.capability)} ${str(g?.level) || "read"}${g?.scopeId ? " on one server" : ""}`);
    out.push(grants.length ? `permissions become: ${grants.slice(0, 8).join(", ")}${grants.length > 8 ? ` +${grants.length - 8} more` : ""}` : "permissions become: none");
  }
  // Players a call carries in its body rather than its path: the one a group gains, a VIP cut
  // comes off, a console admin is made of, an integrity finding is dismissed for — or a list.
  if (str(body.playerId)) out.push(await playerWords(ctx, str(body.playerId), str(body.playerName) || undefined));
  if (Array.isArray(body.players)) out.push(await playersWords(ctx, body.players));
  return out;
}

/**
 * The subject of a call, as the words the queue and the card print ahead of its body. Never
 * throws: a lookup that fails prints the id as it came.
 */
export async function describeSubject(ctx: AppContext, method: string, route: string, params: Params, body: unknown): Promise<string[]> {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Body;
  const out: string[] = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    if (!value) continue;
    // On the per-server screens `id` is the server, which the line carries and names already.
    if (key === "id" && route.startsWith("/api/servers/:id")) continue;
    out.push((await nameParam(ctx, route, key, value, params).catch(() => null)) ?? `${key}: ${value}`);
  }
  out.push(...await bodySubjects(ctx, method, route, b).catch(() => []));
  return out;
}
