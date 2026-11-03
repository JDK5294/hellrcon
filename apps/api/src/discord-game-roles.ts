/**
 * Per-game registration roles: the Discord role a member wears because they have a linked account
 * for that game (economy config, `registration.gameRoles`).
 *
 * One entry point, and it RECONCILES rather than "adds" or "removes": read which games the member
 * is linked for, then bring the configured roles into line — add the roles of linked games, take
 * off the roles of games they no longer hold. Every path that touches a link (self-service verify,
 * the staff panel's manual link/unlink/replace, the profile's Set Discord) calls this after the
 * write, and none of them has to reason about which direction the change went. Replaying it is
 * harmless — Discord's role PUT/DELETE are idempotent.
 *
 * Best-effort throughout: a missing token, a member who left the guild, a role above the bot's
 * reach — none of those may fail the link itself. The link is the record; the role is furniture.
 */
import type { Repository } from "@app/db";
import { createLogger } from "@app/shared";
import { discordAuthConfig } from "./discord-auth.js";
import { discordRest } from "@app/shared";

const log = createLogger("game-roles");


/**
 * One role call, paced by the SHARED Discord limiter (@app/shared).
 *
 * This file used to carry its own: a module-level budget, its own 429 retry, its own sleep. It was
 * right about the mechanics — a bulk reconcile with no pacing had every call come back 429 — but it
 * could only ever see its own traffic. One budget covered every route it touched, and nothing it
 * learned reached the badge sweep, the relay, or the VIP panel, which spend the same token. A
 * global 429 earned elsewhere was invisible to it.
 *
 * The shared client keeps the same behaviour per bucket and adds what one file cannot have: a
 * global pause every caller obeys, and a background lane that yields to whoever is waiting on a
 * button. Role writes stay INTERACTIVE — a registration is not finished until its role lands.
 */
async function roleFetch(guildId: string, discordUserId: string, roleId: string, method: "PUT" | "DELETE", reason: string): Promise<Response> {
  return discordRest().request({
    // The guild is the major parameter, so it belongs in the key; Discord's own bucket hash
    // replaces this the moment the first response names one.
    routeKey: `${method} /guilds/${guildId}/members/roles`,
    path: `/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`,
    method,
    reason,
  });
}

/** What a reconcile did, so a BULK one can report instead of only whispering into the log. */
export interface GameRoleSyncResult { applied: number; removed: number; absent: number; refused: number }

const ZERO: GameRoleSyncResult = { applied: 0, removed: 0, absent: 0, refused: 0 };

/** Bring the member's per-game registration roles into line with their links. Never throws. */
export async function syncGameRoles(repo: Repository, discordUserId: string): Promise<GameRoleSyncResult> {
  const out: GameRoleSyncResult = { ...ZERO };
  try {
    const { gameRoles } = (await repo.economy.config()).registration;
    const entries = Object.entries(gameRoles ?? {}).filter(([, roleId]) => roleId);
    if (!entries.length) return out;
    const token = process.env.DISCORD_TOKEN;
    // The COMMUNITY guild — where members live and where the role picker read its list from.
    // Empty falls back to the staff guild, same as everything else community-facing.
    const guildId = (await repo.appConfig.get()).communityGuildId || discordAuthConfig().guildId || process.env.DISCORD_GUILD_ID || "";
    if (!token || !guildId) return out;

    const linkedGames = new Set((await repo.externalLinks.findPlayers("discord", discordUserId)).map((p) => p.game));
    for (const [game, roleId] of entries) {
      const wanted = linkedGames.has(game);
      const r = await roleFetch(guildId, discordUserId, roleId, wanted ? "PUT" : "DELETE", `game registration (${game})`);
      // 404 is a member who left (or was never in) the community guild — normal, not worth a log
      // per press. 403 is the one an operator can fix (role above the bot, missing permission).
      if (r.ok) { if (wanted) out.applied += 1; else out.removed += 1; }
      else if (r.status === 404) out.absent += 1;
      else {
        out.refused += 1;
        log.warn("game role sync refused", { discordUserId, game, roleId, method: wanted ? "PUT" : "DELETE", status: r.status });
      }
    }
  } catch (err) {
    log.warn("game role sync failed", { discordUserId, err: (err as Error).message });
  }
  return out;
}

/**
 * Reconcile EVERY linked member, and say what happened.
 *
 * The repair for links written by a path that skipped the per-link reconcile — the cutover
 * import did exactly that, so a member could be linked, hold their balance, and still be missing
 * the registration role that link is supposed to earn them. Nothing revisits a role on its own, so
 * without this the only fix was unlinking and relinking each member by hand.
 *
 * Sequential on purpose: this is Discord's per-guild role bucket, and a hundred members firing at
 * once buys nothing but 429s. Safe to re-run — the underlying call is a reconcile, not a toggle.
 */
export async function syncAllGameRoles(
  repo: Repository,
  onProgress?: (done: number, total: number) => void,
): Promise<GameRoleSyncResult & { members: number }> {
  const ids = await repo.externalLinks.distinctExternalIds("discord");
  const total: GameRoleSyncResult & { members: number } = { ...ZERO, members: ids.length };
  let done = 0;
  for (const id of ids) {
    const r = await syncGameRoles(repo, id);
    total.applied += r.applied; total.removed += r.removed;
    total.absent += r.absent; total.refused += r.refused;
    onProgress?.(++done, ids.length);
  }
  log.info("bulk game role reconcile finished", { ...total });
  return total;
}
