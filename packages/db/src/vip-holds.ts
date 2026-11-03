/**
 * Granting time to a player whose VIP a group perk may hold — the one read-then-bank every time
 * grant shares (staff, approvals, the shop, the Discord panel, seed and game rewards, triggers).
 */
import type { Repository, VipGroupHold, VipRow } from "./types.js";

/**
 * The groups holding this grant whose perk takes no rewards (GroupVipPerk.bankRewards false) —
 * none when rewards add to the frozen balance. Read from each group's perk as it stands now: the
 * hold remembers which groups hold it, not how their switch is set. A group gone, or its perk
 * switched off, is releasing the hold rather than holding it, and refuses nothing.
 */
export async function rewardsRefusedBy(repo: Pick<Repository, "playerGroups">, hold: VipGroupHold): Promise<string[]> {
  const names: string[] = [];
  for (const source of hold.groups) {
    const group = await repo.playerGroups.get(source.id);
    if (group?.vipPerk && group.vipPerk.bankRewards === false) names.push(group.name);
  }
  return names;
}

/**
 * The row a TIME grant builds on, with a group perk's hold dealt with first.
 *
 * While a perk holds the grant, time given to the player goes to the frozen balance they get back
 * on leaving the group (vips.bankGroupHold): that is `banked`, and the caller writes nothing more.
 * Otherwise `existing` is the row to compute the grant from — read AGAIN when the hold ended
 * between the first read and the bank (the player just left the group, or the perk was switched
 * off). Building on the first read there would stack the time onto the permanent the release has
 * just dated — which the grant maths keeps permanent — and a time grant would hand out permanent
 * VIP. (A hold that BEGINS after the read is the store's to catch: it banks a dated write on a
 * held grant.)
 *
 * A `reward` (anything a person did not grant by hand) on a grant held by a group whose perk takes
 * no rewards banks nothing: `existing` is the held grant itself, permanent, so the caller's own
 * "already permanent — nothing to add" path answers it, exactly as it answers permanent VIP of the
 * player's own; `refusedBy` names the groups, for the record.
 */
export async function bankIfHeld(
  repo: Pick<Repository, "vips" | "playerGroups">,
  serverId: string,
  playerId: string,
  change: { addMs?: number; atLeastMs?: number },
  opts: { reward?: boolean } = {},
): Promise<{ banked: VipRow; existing?: undefined; refusedBy?: undefined } | { banked?: undefined; existing: VipRow | null; refusedBy?: string[] }> {
  let existing = await repo.vips.get(serverId, playerId);
  // Ending and beginning again between two reads is leaving and rejoining in the same moment;
  // a few tries settle it.
  for (let tries = 0; existing?.groupHold && tries < 3; tries++) {
    if (opts.reward) {
      const refusedBy = await rewardsRefusedBy(repo, existing.groupHold);
      if (refusedBy.length) return { existing, refusedBy };
    }
    const row = await repo.vips.bankGroupHold(serverId, playerId, change);
    if (row?.groupHold) return { banked: row };
    existing = await repo.vips.get(serverId, playerId);
  }
  return { existing };
}
