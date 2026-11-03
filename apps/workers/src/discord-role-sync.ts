/**
 * Periodic Discord role resync — the time-based half of "the staff Discord is the source of truth".
 *
 * Sign-in already projects a member's Discord roles through the role map onto their panel roles,
 * but sign-in is the only moment it happened — so a role granted, revoked, or a member removed in
 * Discord changed nothing here until that person next logged in. Their OLD session kept its OLD
 * roles indefinitely. The Users editor even promised "overwritten on their next login or the
 * periodic sync" while no periodic sync existed. This runner is that sync.
 *
 * Every pass, for each user with a linked Discord account:
 *   - fetch their staff-guild membership with the bot token (same read the /command gate uses);
 *   - refresh the stored @handle and nickname (names drift; identity is the Discord id);
 *   - if the account is Discord-managed, recompute the mapped role assignments and REPLACE the
 *     stored ones when they differ. A 404 means they left (or were kicked from) the guild — all
 *     panel roles are removed on the spot, which strips every capability from any session they
 *     still hold, because grants are recomputed from the database on each request.
 *
 * Hand-managed accounts (discordManaged=false) keep their roles untouched — that flag exists so an
 * admin can pin roles deliberately — but their names still refresh.
 *
 * Failure posture: a Discord outage or rate-limit KEEPS the current roles (revoking access because
 * Discord blinked would lock the whole staff out); only an authoritative 404 revokes. Every real
 * change writes an audit row under the "discord-sync" automation actor, so the trail shows exactly
 * when access appeared or vanished and which roles moved.
 */
import type { Repository, RoleAssignment, UserRow } from "@app/db";
import { mappedRoleAssignments } from "@app/access";
import { guildMembers } from "@app/shared";

export interface RoleSyncOptions {
  token: string;
  guildId: string;
  fetchImpl?: typeof fetch;
}

export interface RoleSyncResult {
  /** linked users examined */
  checked: number;
  /** users whose role assignments were replaced with a different set */
  changed: number;
  /** users whose roles were cleared because they are no longer in the staff guild */
  cleared: number;
  /** users skipped because Discord answered with an error (roles kept as-is) */
  errors: number;
}

/** The guild-member read, shaped for tests: roles + the two display names. */
interface MemberInfo {
  roleIds: string[];
  handle: string | null;
  nick: string | null;
}

function parseMember(member: unknown): MemberInfo {
  const m = member as { roles?: unknown; nick?: string | null; user?: { username?: string; global_name?: string | null } } | null;
  const roles = Array.isArray(m?.roles) ? m.roles.filter((r): r is string => typeof r === "string") : [];
  return {
    roleIds: roles,
    handle: m?.user?.username || null,
    nick: m?.nick || m?.user?.global_name || null,
  };
}

/** Order-insensitive equality of two assignment sets. */
function sameAssignments(a: RoleAssignment[], b: { roleId: string; scopeId: string | null }[]): boolean {
  const key = (x: { roleId: string; scopeId?: string | null }) => `${x.roleId}|${x.scopeId ?? ""}`;
  const as = a.map(key).sort().join(",");
  const bs = b.map(key).sort().join(",");
  return as === bs;
}

const displayName = (u: UserRow): string => u.discordNick || u.discordUsername || u.username;

/** One sync pass over every linked user. Callers gate on token/guildId being configured. */
export async function syncDiscordRoles(repo: Repository, { token, guildId, fetchImpl = fetch }: RoleSyncOptions): Promise<RoleSyncResult> {
  const result: RoleSyncResult = { checked: 0, changed: 0, cleared: 0, errors: 0 };
  const linked = (await repo.users.list()).filter((u) => u.discordId);
  if (!linked.length) return result;
  const mappings = await repo.discordRoleMap.list();
  const roleNames = new Map((await repo.roles.list()).map((r) => [r.id, r.name]));
  const named = (roles: { roleId: string }[]) =>
    [...new Set(roles.map((r) => roleNames.get(r.roleId) ?? r.roleId))].join(", ") || "none";

  /**
   * Apply one member's Discord state to one user. Shared by both paths below so the rules — names
   * refresh for everyone, roles only for managed accounts, and only an AUTHORITATIVE absence
   * revokes — are written once and cannot drift apart.
   */
  const applyMember = async (u: UserRow, member: MemberInfo): Promise<void> => {
    if ((member.handle && member.handle !== u.discordUsername) || (member.nick && member.nick !== u.discordNick)) {
      await repo.users.linkDiscord(u.id, {
        discordId: u.discordId!,
        username: member.handle ?? u.discordUsername,
        nick: member.nick ?? u.discordNick,
      }).catch(() => {});
    }
    if (!u.discordManaged) return;
    const mapped = mappedRoleAssignments(member.roleIds, mappings);
    const current = await repo.userRoles.listByUser(u.id);
    if (sameAssignments(current, mapped)) return;
    await repo.userRoles.set(u.id, mapped);
    result.changed++;
    await repo.audit.create({
      actorUserId: null, actorName: "discord-sync", action: "user.roles_sync",
      targetType: "user", targetId: u.id, targetName: displayName(u),
      summary: mapped.length
        ? `synced panel roles for ${displayName(u)} from the Discord role map (now: ${named(mapped)}; was: ${named(current)})`
        : `removed all panel roles from ${displayName(u)} — their Discord roles no longer map to any panel role (was: ${named(current)})`,
      data: { discordId: u.discordId, before: current, after: mapped },
    }).catch(() => {});
  };

  /** They are gone from the guild: managed accounts lose every panel role on the spot. */
  const revoke = async (u: UserRow): Promise<void> => {
    if (!u.discordManaged) return;
    const current = await repo.userRoles.listByUser(u.id);
    if (!current.length) return;
    await repo.userRoles.set(u.id, []);
    result.cleared++;
    await repo.audit.create({
      actorUserId: null, actorName: "discord-sync", action: "user.roles_sync",
      targetType: "user", targetId: u.id, targetName: displayName(u),
      summary: `removed all panel roles from ${displayName(u)} — no longer in the staff Discord (was: ${named(current)})`,
      data: { discordId: u.discordId, before: current, after: [] },
    }).catch(() => {});
  };

  /*
   * ONE member-list read for the whole staff, instead of one request per person.
   *
   * This sweep runs every few minutes forever, and per-person it was N requests each pass — all
   * sharing a route key, so the limiter runs them one at a time and the sweep spends a large slice
   * of the token's budget doing what a single list request answers. That budget is shared with
   * every button a person is waiting on.
   *
   * Absence from a COMPLETE list is authoritative — it is the same statement Discord's "Unknown
   * Member" 404 makes, and guildMembers refuses to return a partial list precisely so this reading
   * is safe. Anything short of a complete list falls through to the per-person loop below, which
   * keeps the old behaviour (and its unknown-guild protection) exactly.
   */
  const all = await guildMembers(guildId, fetchImpl, token);
  if (all.kind === "list") {
    const byUser = new Map(all.members.map((m) => [m.userId, m]));
    for (const u of linked) {
      result.checked++;
      const m = byUser.get(u.discordId!);
      if (!m) { await revoke(u); continue; }
      await applyMember(u, { roleIds: m.roleIds, handle: m.username, nick: m.nick });
    }
    return result;
  }

  for (const u of linked) {
    result.checked++;
    let res: Response;
    try {
      res = await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/members/${u.discordId}`, {
        headers: { authorization: `Bot ${token}` },
        // A deadline, because this loop is sequential: one socket that hangs holds up every staff
        // member after it, and the sweep runs on a timer, so the next tick starts a second pass
        // through the same list while the first is still stuck on person three. Timing out lands
        // in the catch below — counted as an error, roles untouched, retried next pass.
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      result.errors++;
      continue;
    }

    if (res.status === 404) {
      // Discord's 404 covers more than "this member left": an unknown GUILD (the bot was kicked,
      // or the id is misconfigured) answers 404 for every lookup too, and clearing on that would
      // strip the entire staff's access in one pass. Only the body's "Unknown Member" error code
      // (10007) is authoritative about a PERSON; anything else on a 404 is a configuration
      // problem and keeps roles like any other outage.
      const errBody = (await res.json().catch(() => null)) as { code?: number } | null;
      if (errBody?.code !== 10007) { result.errors++; continue; }
      // Authoritatively not in the staff guild any more.
      await revoke(u);
      continue;
    }

    if (!res.ok) {
      // Rate limit, outage, missing permission — none of these are "this person lost access", so
      // none of them may cost anyone their roles. Keep everything and let the next pass retry.
      result.errors++;
      continue;
    }

    // A 200 whose body cannot be read is an outage shape, not a membership statement — parsing
    // it as "no roles" would replace a managed user's assignments with nothing.
    const memberBody = await res.json().catch(() => null);
    if (!memberBody || typeof memberBody !== "object") { result.errors++; continue; }
    const member = parseMember(memberBody);

    // Names refresh for every linked account: what the team calls this person is Discord's to say,
    // whether or not their ROLES are.
    await applyMember(u, member);
  }
  return result;
}
