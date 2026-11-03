/**
 * Discord role → player group sync — the decisions, kept pure so they can be tested without a
 * database, a bot token or Discord.
 *
 * A group may be linked to a role in the community Discord. Every pass, whoever holds the role
 * and has linked a game account is a member — every linked account, one per game, since groups
 * are community-wide — and whoever the SYNC added and no longer holds it is not. Members a person
 * added by hand are theirs: the sync never removes them, whatever roles they hold.
 *
 * Membership moving is what makes the group's perk, its rules and its schedules act, so the sync
 * acts only on a COMPLETE reading: the sweep around this hands it nothing unless the whole member
 * list arrived and every linked-account lookup answered. A partial reading would look exactly like
 * people losing the role, and cost them their VIP.
 */

import type { Repository } from "@app/db";
import { discordRest, guildMembers } from "@app/shared";

export interface RoleGroup { id: string; name: string; discordRoleId: string }
export interface RoleGroupMember { playerId: string; source: "panel" | "discord" }
/** A Discord member's linked game accounts — one per game. */
export interface LinkedAccount { platformId: string; name: string | null }

export interface RoleSyncPlan {
  add: { groupId: string; groupName: string; playerId: string; playerName: string | null; discordUserId: string }[];
  remove: { groupId: string; groupName: string; playerId: string }[];
}

/**
 * @param holders role id → the Discord user ids holding it (from one complete member list).
 * @param accounts Discord user id → their linked game accounts (complete for every holder).
 */
export function planGroupRoleSync(input: {
  groups: RoleGroup[];
  members: Map<string, RoleGroupMember[]>;
  holders: Map<string, Set<string>>;
  accounts: Map<string, LinkedAccount[]>;
}): RoleSyncPlan {
  const plan: RoleSyncPlan = { add: [], remove: [] };
  for (const g of input.groups) {
    const current = new Map((input.members.get(g.id) ?? []).map((m) => [m.playerId, m.source]));
    const desired = new Map<string, { name: string | null; discordUserId: string }>();
    for (const userId of input.holders.get(g.discordRoleId) ?? []) {
      for (const acct of input.accounts.get(userId) ?? []) {
        if (!desired.has(acct.platformId)) desired.set(acct.platformId, { name: acct.name, discordUserId: userId });
      }
    }
    for (const [playerId, who] of desired) {
      if (!current.has(playerId)) plan.add.push({ groupId: g.id, groupName: g.name, playerId, playerName: who.name, discordUserId: who.discordUserId });
    }
    for (const [playerId, source] of current) {
      if (source === "discord" && !desired.has(playerId)) plan.remove.push({ groupId: g.id, groupName: g.name, playerId });
    }
  }
  return plan;
}

// --- The sweep around the plan: read Discord and the directory, then apply ---

const API = "https://discord.com/api/v10";
/** More holders of one role than this is a mistake (a role everybody holds), not a team. */
export const MAX_ROLE_HOLDERS = 2000;

export interface GroupRoleSyncOptions { token: string; guildId: string; fetchImpl?: typeof fetch }
export interface GroupRoleSyncResult {
  groups: number; added: number; removed: number;
  /** Why the pass changed nothing at all (Discord unreadable, a lookup failed…). */
  skipped?: string;
  /** Groups left as they are because their role is not in the server (deleted, or another server's). */
  missingRoles: string[];
  /** Why a group was left as it is this pass, by group id, with the role it was read against —
   *  for the Groups page, which shows it only while the group still follows that role. */
  notes: Record<string, { roleId: string; reason: string }>;
}

/** Every role id in the guild, or null when Discord could not say. */
async function guildRoleIds(guildId: string, fetchImpl: typeof fetch, token: string): Promise<Set<string> | null> {
  try {
    const r = fetchImpl === fetch
      ? await discordRest().request({ routeKey: `GET /guilds/${guildId}/roles`, path: `/guilds/${guildId}/roles` })
      : await fetchImpl(`${API}/guilds/${guildId}/roles`, { headers: { authorization: `Bot ${token}` } });
    if (!r.ok) return null;
    const roles = (await r.json()) as { id?: unknown }[];
    return Array.isArray(roles) ? new Set(roles.map((x) => String(x.id ?? "")).filter(Boolean)) : null;
  } catch {
    return null;
  }
}

/**
 * One pass over every group linked to a Discord role.
 *
 * Nothing changes unless everything was read: the guild's whole member list (a partial one is
 * refused by guildMembers), its role list, and every holder's linked accounts — any failure ends
 * the pass with the reason, and the next pass tries again. The roles are read AFTER the members, so
 * a role deleted while the member list was paging counts as gone rather than as held by nobody. A
 * group whose role is not in the server (deleted in Discord, or a role id from another server), or
 * is held by more than MAX_ROLE_HOLDERS, is left exactly as it is: the other groups still sync.
 * Every change lands only while its group is still linked to the role this pass read.
 */
export async function syncGroupRoles(repo: Repository, opts: GroupRoleSyncOptions): Promise<GroupRoleSyncResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const linked = (await repo.playerGroups.list()).filter((g) => g.discordRoleId);
  const result: GroupRoleSyncResult = { groups: linked.length, added: 0, removed: 0, missingRoles: [], notes: {} };
  if (!linked.length) return result;
  const list = await guildMembers(opts.guildId, fetchImpl, opts.token);
  if (list.kind !== "list") return { ...result, skipped: list.kind === "tooLarge" ? `the Discord server has more members than one read covers (${list.seen}+)` : list.reason };
  const roles = await guildRoleIds(opts.guildId, fetchImpl, opts.token);
  if (!roles) return { ...result, skipped: "the Discord server's roles couldn't be read" };

  const holders = new Map<string, Set<string>>();
  const wanted = new Set(linked.map((g) => g.discordRoleId!));
  for (const m of list.members) {
    for (const r of m.roleIds) if (wanted.has(r)) (holders.get(r) ?? holders.set(r, new Set()).get(r)!).add(m.userId);
  }
  const groups = linked.filter((g) => {
    const role = g.discordRoleId!;
    if (!roles.has(role)) {
      result.missingRoles.push(g.name);
      result.notes[g.id] = { roleId: role, reason: "its role is not in the community Discord server (deleted, or another server's) — the group is left as it is" };
      return false;
    }
    const held = holders.get(role)?.size ?? 0;
    if (held > MAX_ROLE_HOLDERS) {
      result.notes[g.id] = { roleId: role, reason: `${held} members hold its role — more than a group sync takes on (${MAX_ROLE_HOLDERS}), so the group is left as it is` };
      return false;
    }
    return true;
  });
  if (!groups.length) return result;

  const users = [...new Set(groups.flatMap((g) => [...(holders.get(g.discordRoleId!) ?? [])]))];
  const accounts = new Map<string, LinkedAccount[]>();
  for (const userId of users) {
    // Unreadable is not "no accounts": treating it so would remove a member for a database blip.
    let rows;
    try { rows = await repo.externalLinks.findPlayers("discord", userId); }
    catch { return { ...result, skipped: "a member's linked game accounts couldn't be read" }; }
    accounts.set(userId, rows.map((p) => ({ platformId: p.platformId, name: p.name || null })));
  }
  const members = new Map<string, RoleGroupMember[]>();
  for (const g of groups) members.set(g.id, (await repo.playerGroups.members(g.id)).map((m) => ({ playerId: m.playerId, source: m.source })));

  const roleOf = new Map(groups.map((g) => [g.id, g.discordRoleId!]));
  const plan = planGroupRoleSync({ groups: groups.map((g) => ({ id: g.id, name: g.name, discordRoleId: g.discordRoleId! })), members, holders, accounts });
  for (const a of plan.add) {
    // Lands only while the group is still linked to this role, and only for someone not listed —
    // a person may have listed them, or unlinked the group, since the read.
    if (!(await repo.playerGroups.syncAddMember({ groupId: a.groupId, roleId: roleOf.get(a.groupId)!, playerId: a.playerId, playerName: a.playerName, addedByName: "discord-sync" }))) continue;
    result.added++;
    await repo.audit.create({
      actorUserId: null, actorName: "discord-sync", action: "group.member_add",
      targetType: "player", targetId: a.playerId, targetName: a.playerName ?? undefined,
      summary: `added ${a.playerName || a.playerId} to group "${a.groupName}" — they hold its Discord role`,
      data: { groupId: a.groupId, groupName: a.groupName, discordUserId: a.discordUserId, source: "discord" },
    }).catch(() => {});
  }
  for (const r of plan.remove) {
    // Only a membership the sync added (a person may have re-listed them since the read), and only
    // while the group still follows this role.
    if (!(await repo.playerGroups.syncRemoveMember({ groupId: r.groupId, roleId: roleOf.get(r.groupId)!, playerId: r.playerId }))) continue;
    result.removed++;
    await repo.audit.create({
      actorUserId: null, actorName: "discord-sync", action: "group.member_remove",
      targetType: "player", targetId: r.playerId,
      summary: `removed ${r.playerId} from group "${r.groupName}" — they no longer hold its Discord role`,
      data: { groupId: r.groupId, groupName: r.groupName, source: "discord" },
    }).catch(() => {});
  }
  return result;
}
