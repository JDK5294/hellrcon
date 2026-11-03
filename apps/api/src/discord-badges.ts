/**
 * Community role badges — which emoji a player wears, resolved from the Discord roles their linked
 * account holds in the PUBLIC guild (config: AppConfig.roleBadges; matching: badgesForRoles).
 *
 * The design constraint is the LIVE ROSTER: it refreshes every ~15s for every watching admin, and
 * a hundred players × one Discord member-read each would turn every refresh into a rate-limited
 * crawl. So the roster path never awaits Discord:
 *
 *   - `badgesForRosterSync` answers from an in-process cache only. A player it does not know yet
 *     simply has no badge THIS refresh, and their id is queued.
 *   - one background drain works the queue at a gentle pace (serial, small gap), filling the cache
 *     via the same link → guild-member read the enforcer's role gate uses. The next poll wears the
 *     badges. Eventually-decorated, never-blocking — the same posture as the roster's best-effort
 *     identity capture.
 *
 * The PROFILE is one player and not polled, so it awaits `badgesForPlayer` directly (still cached).
 *
 * Cache entries hold the player's discord ROLE IDS, not the computed badges, so editing the badge
 * config repaints everyone on the next poll instead of waiting out a TTL. Failures cache briefly
 * as "unknown" (no badge, retry soon); definitive answers (linked-with-roles, not linked, not in
 * the guild) cache for the full TTL. A live role change shows up within the TTL — badges are
 * cosmetic, and ten minutes of lag is the right price for not hammering Discord.
 */
import { badgesForRoles } from "@app/db";
import type { Repository } from "@app/db";
import { communityGuild } from "./discord-guild.js";
import { memberRoles } from "./discord-roster.js";

const ROLE_TTL_MS = 10 * 60_000; // definitive answers
const RETRY_TTL_MS = 60_000; // Discord unavailable — try again soon, don't flap per poll
const FETCH_GAP_MS = 250; // between member reads while draining — polite, and fast enough

interface CacheEntry {
  /** roles held ([] = linked but none / not linked / not in guild); null = could not find out. */
  roleIds: string[] | null;
  atMs: number;
}

const cache = new Map<string, CacheEntry>(); // key: player db id
const queue = new Set<string>();
let draining = false;

async function resolveOne(repo: Repository, playerDbId: string): Promise<void> {
  const links = await repo.externalLinks.list(playerDbId).catch(() => null);
  if (links === null) return remember(playerDbId, null);
  const discordId = links.find((l) => l.provider === "discord")?.externalId;
  if (!discordId) return remember(playerDbId, []);
  const guild = await communityGuild(repo);
  if (!guild.guildId) return remember(playerDbId, []);
  /*
   * Through the shared roster: a busy server is a badge lookup per player, and each one used to be
   * its own request. One member-list read answers all of them, and answers the next hundred people
   * to connect for free — which is the difference between decoration that costs nothing and
   * decoration that spends the rate limit everything else is queued behind.
   *
   * The per-person fallback inside memberRoles keeps the BACKGROUND lane's original behaviour for
   * a guild whose list cannot be read.
   */
  const roles = await memberRoles(guild.guildId, discordId);
  return remember(playerDbId, roles);
}

/**
 * The cache is bounded, because a roster is a turnstile.
 *
 * One entry per player ever SEEN — which over months on a busy community is every player who has
 * ever joined, not the hundred currently playing. Nothing ever removed them: a stale entry is only
 * ignored by `fresh()`, never dropped, so the map grew for the life of the process. The enforcer
 * learned this already and prunes every one of its maps on a sweep; this is that, without needing
 * a timer of its own — the drain is the only thing that adds, so it is the natural place to tidy.
 */
const MAX_CACHE = 5000;

function pruneCache(): void {
  if (cache.size <= MAX_CACHE) return;
  // Stale entries first — they are worthless, and on a normal install that is the whole excess.
  for (const [id, e] of cache) if (!fresh(e)) cache.delete(id);
  if (cache.size <= MAX_CACHE) return;
  // Still over: drop the oldest, which are the players least likely to be on the server now.
  const byAge = [...cache.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
  for (const [id] of byAge.slice(0, cache.size - MAX_CACHE)) cache.delete(id);
}

function remember(playerDbId: string, roleIds: string[] | null): void {
  cache.set(playerDbId, { roleIds, atMs: Date.now() });
  pruneCache();
}

function fresh(e: CacheEntry | undefined): e is CacheEntry {
  return !!e && e.atMs > Date.now() - (e.roleIds === null ? RETRY_TTL_MS : ROLE_TTL_MS);
}

function drain(repo: Repository): void {
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      // Items added while draining are picked up in the same pass — Set iteration sees them.
      for (const id of queue) {
        queue.delete(id);
        if (fresh(cache.get(id))) continue; // another caller resolved it meanwhile
        await resolveOne(repo, id).catch(() => remember(id, null));
        await new Promise((r) => setTimeout(r, FETCH_GAP_MS));
      }
    } finally {
      draining = false;
      if (queue.size) drain(repo); // something landed after the loop read its last item
    }
  })();
}

export interface PlayerBadge { emoji: string; label: string }

/**
 * Badges for a roster's worth of players, answered synchronously from the cache — unknowns get
 * `[]` now and are queued for the background drain. With no badges configured this is a no-op
 * (nothing queued, nothing fetched): installs that never touch the feature never talk to Discord.
 */
export function badgesForRosterSync(
  repo: Repository,
  roleBadges: { id: string; emoji: string; label: string; roleIds: string[] }[],
  playerDbIds: (string | null | undefined)[],
): Map<string, PlayerBadge[]> {
  const out = new Map<string, PlayerBadge[]>();
  if (!roleBadges.length) return out;
  for (const id of playerDbIds) {
    if (!id) continue;
    const hit = cache.get(id);
    if (fresh(hit)) {
      out.set(id, hit.roleIds ? badgesForRoles(roleBadges, hit.roleIds) : []);
    } else {
      queue.add(id);
    }
  }
  if (queue.size) drain(repo);
  return out;
}

/** Badges for one player, awaited — the profile path. Cached like everything else. */
export async function badgesForPlayer(repo: Repository, playerDbId: string): Promise<PlayerBadge[]> {
  const { roleBadges } = await repo.appConfig.get();
  if (!roleBadges.length) return [];
  let hit = cache.get(playerDbId);
  if (!fresh(hit)) {
    await resolveOne(repo, playerDbId).catch(() => remember(playerDbId, null));
    hit = cache.get(playerDbId);
  }
  return hit?.roleIds ? badgesForRoles(roleBadges, hit.roleIds) : [];
}

