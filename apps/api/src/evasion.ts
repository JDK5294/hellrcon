/**
 * The ban-evasion tripwire — the check that survives a fresh game account.
 *
 * A banned player who buys a new Xbox account arrives with a new XUID, a new per-game id, and a
 * clean directory row: every ACCOUNT id is useless against them, by construction. What they keep
 * is their DISCORD — this community runs registration, VIP and the economy through it, so an
 * evader who wants any of that links the same Discord account to their new game account. That
 * link is the moment they identify themselves.
 *
 * So every place a Discord link is written (self-service registration, the staff panel's manual
 * registration, the profile's Link button) calls this with the accounts that Discord ALREADY
 * owns. If any of them holds an active ban — or sits on the watchlist — the new account is
 * watchlisted on the spot, with a reason naming the account it is presumably evading, and the
 * trail records why. The watchlist is the right landing place: it highlights the player on every
 * roster, the watch views show them the moment they are on a server, and staff decide what to do
 * with eyes open.
 *
 * Deliberately a FLAG, never a block: bans bind accounts, and whether "same Discord as a banned
 * account" merits a ban of its own is a judgment (siblings share consoles; accounts change
 * hands). Nothing here changes what the member sees either — a refusal that says "we noticed"
 * teaches evaders to make a fresh Discord too, and the one they kept is the only thread there is.
 */
import type { PlayerRow, Repository } from "@app/db";
import { createLogger } from "@app/shared";
import { addWatchReason } from "./watch.js";

const log = createLogger("evasion");

/** The automation actor the flag and the audit row are recorded under. */
const ACTOR = "evasion-check";

export interface EvasionCheckResult {
  flagged: boolean;
  /** The linked account that tripped the wire, when one did. */
  against?: { playerId: string; name: string; why: string };
}

/**
 * Check a just-written (or just-attempted) Discord link and flag the player if the same Discord
 * owns a banned or watchlisted account. Best-effort by contract: callers `.catch` it, because a
 * failed check must never break a registration.
 *
 * `others` lets callers that already hold the Discord's account list (every link path loads it to
 * enforce one-account-per-game) pass it in — both to save the read and because the manual paths
 * CLEAR old links before writing the new one, and the pre-clear list is the honest one.
 */
export async function flagBanEvasion(
  repo: Repository,
  player: PlayerRow,
  discordId: string,
  opts: { via: string; others?: PlayerRow[] } = { via: "link" },
): Promise<EvasionCheckResult> {
  const others = (opts.others ?? await repo.externalLinks.findPlayers("discord", discordId))
    .filter((o) => o.id !== player.id);
  if (!others.length) return { flagged: false };

  // The first account with an active ban wins the wording; a watch-only hit is the fallback.
  let hit: { other: PlayerRow; why: string } | null = null;
  for (const other of others) {
    const bans = (await repo.playerBans.list({ playerId: other.platformId, activeOnly: true })).filter((b) => b.liftedAt === null);
    const perma = bans.find((b) => b.kind === "perma") ?? bans[0];
    if (perma) {
      hit = { other, why: `${perma.kind === "perma" ? "permanently banned" : "temp-banned"}${perma.reason ? `: ${perma.reason}` : ""}` };
      break;
    }
    if (!hit) {
      const flags = await repo.playerFlags.get(other.id);
      if (flags?.watchlist) hit = { other, why: `on the watchlist${flags.watchReason ? `: ${flags.watchReason}` : ""}` };
    }
  }
  if (!hit) return { flagged: false };

  // A watch is made of REASONS now, so a staff member's existing watch is never overwritten —
  // this adds its own reason beside theirs. Deduped on the exact text: the tripwire re-checks on
  // every link event, and five identical rows say less than one.
  const reason = `possible ban evasion — this Discord account also owns ${hit.other.name || hit.other.platformId}, who is ${hit.why}`.slice(0, 480);
  const added = await addWatchReason(repo, player.id, { reason, by: { userId: null, name: ACTOR }, skipIfDuplicate: true });
  if (!added.reason) return { flagged: false, against: { playerId: hit.other.id, name: hit.other.name, why: hit.why } };
  await repo.audit.create({
    actorUserId: null, actorName: ACTOR, action: "player.evasion",
    targetType: "player", targetId: player.id, targetName: player.name,
    summary: `watchlisted ${player.name || player.platformId} — their Discord also owns ${hit.other.name || hit.other.platformId} (${hit.why}); link came via ${opts.via}`,
    data: { discordId, otherPlayerId: hit.other.id, otherPlatformId: hit.other.platformId, via: opts.via },
  }).catch(() => { /* the flag is the protection; the trail row must not undo it */ });
  log.info("possible ban evasion flagged", { player: player.name, other: hit.other.name, via: opts.via });
  return { flagged: true, against: { playerId: hit.other.id, name: hit.other.name, why: hit.why } };
}
