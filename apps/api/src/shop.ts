/**
 * The VIP shop: purchases and gifts, as a service (docs/vip-module.md §3).
 *
 * No HTTP in here — the staff routes call this today and the Discord panel calls it in a later
 * arc, with different actors and different idempotency keys but the SAME rules. The rules:
 *
 *   - Linking is the ticket. A purchase requires the buyer linked; a gift-VIP purchase requires
 *     both parties linked; a points gift requires both parties linked. A grant lands on a game id,
 *     and an unlinked member does not have one to land on.
 *   - One idempotency key per money movement. The ledger's unique ref index makes a replay (a
 *     Discord double-click, a retried request) return the first outcome instead of running twice.
 *   - Failure is visible. If no server accepts the grant, the debit is credited back as its own
 *     ledger row — never a silent rollback, so the member's history explains itself.
 *
 * The VIP days go through the SAME grant path staff use: cumulative duration onto any existing
 * grant, pause-aware (a paused VIP banks the time without reappearing in game), audited per server.
 */
import { randomUUID } from "node:crypto";
import { bankIfHeld, InsufficientBalance, type EconomyOffer, type PlayerRow, type Repository, type ServerRow, type VipRow } from "@app/db";
import { ObserveModeViolation } from "@app/rcon-core";
import { getGame } from "@app/games";
import { AppError, errors } from "@app/shared";
import { computeGrantExpiration, connectGameClient, gameClientFor } from "./routes/kit.js";
import { communityGuild, guildMember } from "./discord-guild.js";

export interface PurchaseInput {
  /** Who pays. */
  buyerDiscordId: string;
  offerId: string;
  /** Gift VIP: the days land on this member instead of the buyer. Both must be linked. */
  forDiscordId?: string | null;
  /** Idempotency key — becomes the debit's ledger ref. A replay returns the first outcome. */
  ref: string;
  /** The SERVICE or staff name the trail records — "shop" for the Discord surface, a staff name
   *  for the repair path. Never a member's name: the System page groups automated audit rows by
   *  this field, and stamping each buyer's name here minted a "service" per customer. */
  actorName: string;
  /** The member whose own press this is, when it is. Their ledger rows then carry their name
   *  (no "(by …)" — it was their own action) and the audit summaries say who bought. */
  memberName?: string | null;
  /**
   * The RECIPIENT's Discord roles, when the caller already knows them — an optimisation, never
   * the authority. Supply this ONLY for a self-purchase from a Discord press, where the presser
   * is the recipient and the interaction already carries their roles at press time.
   *
   * Left out (a gift, a staff run) the gate resolves them from Discord itself, so no caller can
   * skip the check by simply not looking.
   */
  recipientRoleIds?: string[];
}

export interface PurchaseOutcome {
  status: "ok" | "replay" | "refunded";
  offer: { id: string; label: string; points: number; days: number };
  balance: number;
  applied: { serverId: string; serverName: string; expiration: string | null }[];
  /**
   * `reason` is staff-grade — whatever actually went wrong, verbatim. `memberReason` is the
   * sentence safe to show the buyer: our own refusals (AppError) are written for members already,
   * but an RCON failure's message can carry the server's host and port, which has no business in
   * a Discord reply. The two exist because the ❌ message used to show NEITHER — only server
   * names — so a member whose purchase kept refunding (ticket-4764) had nothing to act on, staff
   * had nothing to look up, and the one string that explained it was computed and thrown away.
   */
  skipped: { serverId: string; serverName: string; reason: string; memberReason: string }[];
}

/** The servers an offer's scope names, plus the ids that no longer resolve (renamed into skips
 *  rather than silently shrinking the offer). */
async function offerServers(repo: Repository, offer: EconomyOffer): Promise<{ servers: ServerRow[]; missing: string[] }> {
  const all = await repo.servers.list();
  if (offer.scope.mode === "all") return { servers: all, missing: [] };
  const byId = new Map(all.map((s) => [s.id, s]));
  const servers: ServerRow[] = [];
  const missing: string[] = [];
  for (const id of offer.scope.serverIds) {
    const hit = byId.get(id);
    if (hit) servers.push(hit);
    else missing.push(id);
  }
  return { servers, missing };
}

/**
 * The member's account ON A PARTICULAR GAME.
 *
 * A player row is one game's account, and the two games do not share ids: HLL: Vietnam issues its
 * own, so a member who plays both has two rows carrying two different ids. This used to return
 * whichever row had been seen most recently and hand it to every server an offer covered — so a
 * purchase reaching the Vietnam server was sent a WW2 id, which the server took and matched against
 * nobody. The buyer's points were spent and no VIP appeared, with nothing anywhere saying why.
 *
 * Refusing is the point when there is no account for that game. Granting with the other game's id
 * is the silent failure this replaces, and "register on that server first" is something the member
 * can actually act on.
 */
async function linkedPlayerFor(repo: Repository, discordId: string, role: string, game: string): Promise<PlayerRow> {
  const players = await requireLinked(repo, discordId, role);
  const onGame = players.filter((p) => p.game === game);
  if (!onGame.length) {
    const label = getGame(game)?.label ?? game;
    throw errors.badRequest(`the ${role} has no ${label} account linked — they need to register on a ${label} server before VIP can reach them there`);
  }
  return onGame[0]!;
}

/**
 * The recipient's Discord roles, asked of Discord itself — the authority behind a gated offer.
 *
 * Refuses rather than guessing when the answer cannot be had. "We could not read their roles" is
 * not "they hold none", and a purchase that quietly proceeded on the difference would spend a
 * member's balance on VIP that the gate exists to say will not fit.
 */
async function recipientRoles(repo: Repository, discordId: string, offerLabel: string, isGift: boolean): Promise<string[]> {
  const who = isGift ? `<@${discordId}>` : "you";
  const member = await guildMember((await communityGuild(repo)).guildId, discordId);
  if (member.kind === "member") return member.roleIds;
  if (member.kind === "notInGuild") {
    throw errors.badRequest(`**${offerLabel}** is limited by Discord role, and ${isGift ? `${who} is` : "you are"} not in the community Discord server — so that role cannot be checked. Nothing was spent.`);
  }
  throw errors.badRequest(`**${offerLabel}** is limited by Discord role and Discord could not be asked which roles ${who} ${isGift ? "has" : "have"} (${member.reason}) — refusing rather than guessing. Nothing was spent; try again shortly.`);
}

/** Linked to ANY game account — the bar for moving points, which never touch a game server. */
async function requireLinked(repo: Repository, discordId: string, role: string): Promise<PlayerRow[]> {
  const players = await repo.externalLinks.findPlayers("discord", discordId);
  if (!players.length) throw errors.badRequest(`the ${role} is not linked to a game account — linking is required before anything can land in game`);
  return players;
}

/** What one server did with the days. `alreadyPermanent` is not a failure — the member has VIP
 *  there and keeps it — but no time was added, which the caller has to be able to say out loud. */
export interface GrantDaysOutcome {
  expiration: string | null;
  alreadyPermanent: boolean;
  /** The player holds permanent VIP from a group perk: the days went to the frozen balance they
   *  get back on leaving it (not refunded — they keep them). */
  banked?: boolean;
  /** `alreadyPermanent` because a group perk that takes no rewards holds the VIP here — these
   *  groups (vip-holds.ts rewardsRefusedBy). */
  refusedBy?: string[];
}

/** Grant `days` of VIP on one server, exactly like the staff route: cumulative, pause-aware,
 *  audited. Throws on refusal (observe mode, connection). Exported because the registration bonus
 *  (discord-public.ts) and bulk payouts (payouts.ts) are the same grant for a different reason —
 *  `via` names that reason on the VIP row and in the trail, because a payout recorded as a "VIP
 *  shop" purchase is a false record the moment anyone disputes paid VIP. */
export async function grantDays(repo: Repository, server: ServerRow, player: PlayerRow, days: number, actorName: string, ref: string, memberName?: string | null, via = "VIP shop"): Promise<GrantDaysOutcome> {
  // Permanent VIP a group perk holds: the days join the frozen balance they get back on leaving
  // the group — bought or earned, the time is theirs. Nothing changes on the game.
  const banked = async (row: VipRow): Promise<GrantDaysOutcome> => {
    await repo.audit.create({
      actorUserId: null, actorName, action: "vip.grant",
      targetType: "player", targetId: player.platformId, targetName: player.name, serverId: server.id,
      summary: `granted ${days} day${days === 1 ? "" : "s"} of VIP to ${player.name} on ${server.name} — ${via}${memberName ? `, bought by ${memberName}` : ""}; they hold permanent VIP from a group, so the days wait for them when they leave it`,
      data: { playerId: player.platformId, groupHeld: true, bankedMs: row.groupHold!.bankedMs, days, ref, via, ...(memberName ? { buyer: memberName } : {}) },
    });
    return { expiration: null, alreadyPermanent: false, banked: true };
  };
  // Every caller is a reward or a purchase — never a person granting by hand — so a group perk that
  // takes no rewards holds the grant like permanent VIP of their own: nothing to add.
  const basis = await bankIfHeld(repo, server.id, player.platformId, { addMs: days * 86_400_000 }, { reward: true });
  if (basis.banked) return banked(basis.banked);
  const existing = basis.existing;
  const expiration = computeGrantExpiration({ mode: "duration", days, cumulative: true }, existing);
  // Permanent absorbs the days rather than being replaced by them (see computeGrantExpiration).
  // Nothing is written in that case: the row already says what it needs to, and an upsert would
  // only restamp the comment and the granter onto a grant this purchase did not make.
  const alreadyPermanent = Boolean(existing) && existing!.expiration === null;
  if (alreadyPermanent) return { expiration: null, alreadyPermanent: true, ...(basis.refusedBy ? { refusedBy: basis.refusedBy } : {}) };
  const client = gameClientFor(server);
  const vipPaused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
  try {
    if (!vipPaused) {
      await connectGameClient(client, server);
      await client.execute("addVip", { playerId: player.platformId, description: player.name });
    }
    const row = await repo.vips.upsert({ serverId: server.id, playerId: player.platformId, playerName: player.name, comment: `${via} (${memberName ?? actorName})`, expiration, createdByUserId: null, createdByName: memberName ?? actorName });
    // A hold that began after the read took the days into its frozen balance; permanent VIP
    // granted meanwhile absorbed them (the store's floor kept it permanent).
    if (row.groupHold) return banked(row);
    if (row.expiration === null) return { expiration: null, alreadyPermanent: true };
    await repo.audit.create({
      actorUserId: null, actorName, action: "vip.grant",
      targetType: "player", targetId: player.platformId, targetName: player.name, serverId: server.id,
      // What landed: the store keeps the later of the grant's date and this one.
      summary: `granted VIP to ${player.name} on ${server.name} (until ${row.expiration}) — ${via}${memberName ? `, bought by ${memberName}` : ""}`,
      data: { playerId: player.platformId, expiration: row.expiration, days, ref, via, ...(memberName ? { buyer: memberName } : {}) },
    });
    return { expiration: row.expiration, alreadyPermanent: false };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

export async function purchase(repo: Repository, input: PurchaseInput): Promise<PurchaseOutcome> {
  const cfg = await repo.economy.config();
  const offer = cfg.offers.find((o) => o.id === input.offerId);
  if (!offer || !offer.enabled) throw errors.badRequest("that offer does not exist (or is disabled)");
  const offerOut = { id: offer.id, label: offer.label, points: offer.points, days: offer.days };

  // Linking first, before any money moves: buyer always; the recipient too when this is a gift.
  const isGift = Boolean(input.forDiscordId && input.forDiscordId !== input.buyerDiscordId);
  // Gifting VIP is its own switch: selling VIP is not consent to it changing hands.
  if (isGift && !cfg.vipGifting.enabled) throw errors.badRequest("gifting VIP is switched off");
  await requireLinked(repo, input.buyerDiscordId, "buyer");
  const forDiscordId = isGift ? input.forDiscordId! : input.buyerDiscordId;
  const recipientRole = isGift ? "recipient" : "buyer";
  const recipient = (await requireLinked(repo, forDiscordId, recipientRole))[0]!;

  /**
   * The offer's role gate, on WHOEVER RECEIVES THE VIP, enforced before any money moves.
   *
   * The gate says who the days may land on, so it follows the recipient rather than the payer.
   * That is what makes a gift work the way a gift should: someone who plays only Vietnam can
   * spend their own balance on WW2 VIP for a friend who does play WW2, because the friend is the
   * one it has to fit. Buying for yourself is the same rule with the same person on both sides —
   * you must hold the role, and are told plainly when you do not.
   *
   * It also agrees with a rule that predates it. VIP days can only land on an account for that
   * server's game, so an unregistered recipient was always refused per server and refunded; this
   * catches the same case up front, before the points move and before staff see a failed grant.
   *
   * Checked here and not only at render time because a Discord panel persists for the presser:
   * a button drawn before the gate existed, or while the recipient still held the role, is still
   * live. Hiding a button is presentation; this is the protection.
   */
  const requiredRoles = offer.roleIds ?? [];
  if (requiredRoles.length) {
    // A gift's roles are never the presser's, so they are always looked up. For a self-purchase
    // the press already carries them — but an EMPTY list is "none were seen", not "they hold
    // none": a press that arrived without a member object (a DM) looks identical to a member with
    // no roles. Refusing on it would tell somebody who is registered that they are not, so an
    // empty list falls through to the authoritative lookup. That costs a round trip only on the
    // path that was about to refuse anyway.
    const known = isGift ? undefined : input.recipientRoleIds;
    const roles = known?.length ? known : await recipientRoles(repo, forDiscordId, offer.label, isGift);
    if (!roles.some((r) => requiredRoles.includes(r))) {
      throw errors.badRequest(isGift
        ? `<@${forDiscordId}> cannot receive **${offer.label}** — they do not have the Discord role it requires, which usually means they are not registered for that game. Nothing was spent.`
        : `**${offer.label}** is not available to you — you do not have the Discord role it requires, which usually means you are not registered for that game. Register on it first, then press Refresh.`);
    }
  }

  const { servers, missing } = await offerServers(repo, offer);
  if (!servers.length) throw errors.badRequest("this offer's servers no longer exist — staff need to fix the offer");
  // One offer can cover servers of DIFFERENT GAMES, and a member's account on one game is not
  // addressable on the other. Resolved per server below rather than once here, which is what sent a
  // WW2 id to the Vietnam server and spent the buyer's points on nothing.

  // Debit. A replay (same ref) pays nothing and grants nothing — the first run already did both.
  // Too few points is the store's refusal, and it is answered after the replay check rather than
  // ahead of the debit: a double-click on a purchase that spent the whole balance is still "that
  // went through". The store says it as "insufficient balance: has 100, needs 250", which is
  // true and not a sentence to hand a member.
  const debit = await repo.economy.apply({
    discordId: input.buyerDiscordId,
    delta: -offer.points,
    reason: `VIP shop: ${offer.label}${isGift ? ` — gift for ${recipient.name}` : ""}`,
    ref: input.ref,
    // Their own press wears no actor — "(by …)" is for somebody ELSE touching your balance —
    // and their name rides discordName, where the member record keeps it anyway.
    actorName: input.memberName ? null : input.actorName,
    ...(input.memberName ? { discordName: input.memberName } : {}),
  }).catch((err: unknown) => {
    if (err instanceof InsufficientBalance) throw errors.badRequest(`**${offer.label}** costs ${offer.points} ${cfg.currencyName} and the balance is ${err.balance}. Nothing was spent.`);
    throw err;
  });
  if (!debit.applied) {
    // A replay, but of WHAT? The first run may have refunded itself because no server took the
    // grant, and answering "that purchase already went through" to a press that bought nothing
    // sends the member to staff to ask where their VIP is. The refund rides a ref derived from
    // this one, so the ledger already knows which of the two happened.
    const refunded = await repo.economy.lastEntryWithRefPrefix(input.buyerDiscordId, `refund:${input.ref}`);
    return { status: refunded ? "refunded" : "replay", offer: offerOut, balance: debit.member.balance, applied: [], skipped: [] };
  }

  const applied: PurchaseOutcome["applied"] = [];
  const skipped: PurchaseOutcome["skipped"] = missing.map((id) => ({ serverId: id, serverName: id, reason: "server no longer exists", memberReason: "server no longer exists — staff need to fix the offer" }));
  for (const server of servers) {
    try {
      const onThisGame = await linkedPlayerFor(repo, forDiscordId, recipientRole, server.game);
      const outcome = await grantDays(repo, server, onThisGame, offer.days, input.actorName, input.ref, input.memberName);
      // Days onto permanent VIP buy nothing here. Counting it as applied would charge for a change
      // that did not happen and answer "VIP added" to a member whose panel looks identical after;
      // as a skip it says so, and — if EVERY server the offer covers is already permanent — the
      // purchase falls through to the refund below instead of quietly taking the points.
      if (outcome.alreadyPermanent) {
        // Permanent VIP from a group whose perk takes no rewards reads the same — the member's VIP
        // here is permanent — with the group named, so nobody has to guess why their days did not stack.
        const why = outcome.refusedBy?.length
          ? `already has permanent VIP here, from group ${outcome.refusedBy.map((n) => `“${n}”`).join(", ")}, which takes no rewards or purchases — nothing to add`
          : "already has permanent VIP here — nothing to add";
        skipped.push({ serverId: server.id, serverName: server.name, reason: why, memberReason: why });
      } else applied.push({ serverId: server.id, serverName: server.name, expiration: outcome.expiration });
    } catch (err) {
      const observe = err instanceof ObserveModeViolation || (err as Error).name === "ObserveModeViolation";
      // Our own refusals (AppError) are worded for members — "no Vietnam account linked" is
      // exactly what the buyer needs to hear. Anything else is infrastructure (a connect refusal
      // names the host and port) and reaches the member only as "could not be reached".
      const ours = err instanceof AppError || observe;
      skipped.push({
        serverId: server.id, serverName: server.name,
        reason: observe ? "observe mode (read-only)" : (err as Error).message,
        memberReason: observe ? "the server is in read-only mode"
          : ours ? (err as Error).message
          : "the game server could not be reached — try again in a few minutes, or ask staff",
      });
    }
  }

  // Nothing landed anywhere: credit back, visibly. Deliberately NOT cap-trimmed — a refund that
  // the cap eats would turn a failed purchase into a fine. Partial success stands as a purchase
  // (VIP is live on the servers that took it); the skips name the ones staff need to look at.
  if (!applied.length) {
    // The ledger row is what the member reads back a week later, so it names WHICH of the two
    // happened: a purchase that could not land, or one there was nothing left to buy.
    const allPermanent = skipped.length > 0 && skipped.every((s) => s.reason.startsWith("already has permanent VIP"));
    const refund = await repo.economy.apply({
      discordId: input.buyerDiscordId,
      delta: offer.points,
      reason: allPermanent
        ? `refund: ${offer.label} — already permanent VIP everywhere this offer covers`
        : `refund: ${offer.label} — no server accepted the grant`,
      ref: `refund:${input.ref}`,
      actorName: input.memberName ? null : input.actorName,
      ...(input.memberName ? { discordName: input.memberName } : {}),
    });
    // The trail staff read when a member brings a screenshot of the ❌. The refund used to leave
    // only two ledger rows; WHY every server refused lived nowhere, so a ticket meant re-deriving
    // this loop by hand.
    await repo.audit.create({
      actorUserId: null, actorName: input.actorName, action: "vip.purchase_refunded",
      targetType: "player", targetId: forDiscordId, targetName: recipient.name, 
      summary: `refunded ${offer.points}${input.memberName ? ` to ${input.memberName}` : ""} on "${offer.label}"${isGift ? ` (gift for ${recipient.name})` : ""} — ${skipped.map((s) => `${s.serverName}: ${s.reason}`).join("; ") || "no server accepted the grant"}`,
      data: { offerId: offer.id, ref: input.ref, buyerDiscordId: input.buyerDiscordId, skipped },
    }).catch(() => { /* the refund itself already stands; the trail is best-effort */ });
    return { status: "refunded", offer: offerOut, balance: refund.member.balance, applied, skipped };
  }
  return { status: "ok", offer: offerOut, balance: debit.member.balance, applied, skipped };
}

export interface GiftInput {
  fromDiscordId: string;
  toDiscordId: string;
  amount: number;
  /** Idempotency key — the debit's ref; the matching credit rides on `gift-in:<ref>`. */
  ref: string;
  /** Service or staff name for the trail — see PurchaseInput.actorName. */
  actorName: string;
  /** The gifting member, when the press is their own — see PurchaseInput.memberName. */
  memberName?: string | null;
}

/**
 * A points gift between members. Both parties linked (decision 1), a configured minimum, and a
 * configured per-gift maximum (null = uncapped). The maximum bounds ONE gift — it is a brake on a
 * fat finger and on emptying a balance in a single press, not a daily allowance.
 *
 * The recipient's cap headroom is checked up front so a gift REFUSES rather than burning the
 * overflow; the cap-trim on the credit remains as the backstop if balances move between the check
 * and the write, and the trimmed delta would still be visible on the ledger row.
 */
export async function gift(repo: Repository, input: GiftInput): Promise<{ status: "ok" | "replay"; fromBalance: number; toBalance: number }> {
  const cfg = await repo.economy.config();
  if (!cfg.gifting.enabled) throw errors.badRequest("gifting is switched off");
  const amount = Math.trunc(input.amount);
  const min = Math.max(1, cfg.gifting.minAmount);
  if (!Number.isInteger(input.amount) || amount < min) throw errors.badRequest(`a gift must be at least ${min} ${cfg.currencyName}`);
  const max = cfg.gifting.maxAmount;
  if (max !== null && amount > max) throw errors.badRequest(`a single gift can be at most ${max} ${cfg.currencyName}`);
  if (input.fromDiscordId === input.toDiscordId) throw errors.badRequest("you cannot gift yourself");
  await requireLinked(repo, input.fromDiscordId, "giver");
  const toPlayer = (await requireLinked(repo, input.toDiscordId, "recipient"))[0]!;

  if (cfg.balanceCap !== null) {
    const to = await repo.economy.member(input.toDiscordId);
    const headroom = cfg.balanceCap - (to?.balance ?? 0);
    if (amount > headroom) throw errors.badRequest(`the recipient can only hold ${Math.max(0, headroom)} more ${cfg.currencyName}`);
  }

  const debit = await repo.economy.apply({
    discordId: input.fromDiscordId, delta: -amount,
    reason: `gift to ${toPlayer.name}`, ref: input.ref,
    actorName: input.memberName ? null : input.actorName,
    ...(input.memberName ? { discordName: input.memberName } : {}),
  }).catch((err: unknown) => {
    // The store's own words are not a member's (see purchase).
    if (err instanceof InsufficientBalance) throw errors.badRequest(`A gift of ${amount} ${cfg.currencyName} is more than the balance of ${err.balance}. Nothing was sent.`);
    throw err;
  });
  // The two legs are two transactions, so a failure between them leaves the giver charged and the
  // recipient unpaid — points that exist nowhere. The credit is idempotent on its own ref, so an
  // ordinary double-press finds it already there and changes nothing.
  //
  // What idempotency alone does NOT do is heal a half-finished gift: healing needs a retry carrying
  // the SAME ref, and neither caller has one to give — the staff route mints a fresh uuid per press
  // and a re-pressed Discord button is a new interaction id. So the giver stayed short until
  // somebody noticed and adjusted a balance by hand. `purchase` above already answers this shape of
  // failure by refunding visibly; a gift that could not be delivered does the same.
  let credit;
  try {
    credit = await repo.economy.apply(
      // The sender lives in the REASON now, not the actor: the receiver still learns who to
      // thank, without the sender's name becoming a "service" in the machinery rollup.
      { discordId: input.toDiscordId, delta: amount, reason: input.memberName ? `gift from ${input.memberName}` : `gift received`, ref: `gift-in:${input.ref}`, actorName: input.memberName ? null : input.actorName },
      { maxBalance: cfg.balanceCap },
    );
  } catch (err) {
    // The credit may have COMMITTED and then failed to report (a connection dropped after the
    // transaction landed). Refunding on that would mint points, so the ledger is asked what really
    // happened before anything is undone.
    const landed = await repo.economy.lastEntryWithRefPrefix(input.toDiscordId, `gift-in:${input.ref}`).catch(() => null);
    if (!landed) {
      await repo.economy.apply({
        discordId: input.fromDiscordId, delta: amount,
        reason: `refund: gift to ${toPlayer.name} could not be delivered`,
        ref: `refund:${input.ref}`,
        actorName: input.memberName ? null : input.actorName,
        ...(input.memberName ? { discordName: input.memberName } : {}),
      }).catch(() => { /* the throw below is what the caller acts on; the debit stands for staff */ });
      throw errors.badRequest(`the gift could not be delivered (${(err as Error).message}) — nothing was spent`);
    }
    // It did land: report the gift as the success it was.
    const to = await repo.economy.member(input.toDiscordId);
    return { status: debit.applied ? "ok" : "replay", fromBalance: debit.member.balance, toBalance: to?.balance ?? 0 };
  }
  return { status: debit.applied ? "ok" : "replay", fromBalance: debit.member.balance, toBalance: credit.member.balance };
}

/** A one-shot ref for surfaces with no natural idempotency key of their own (the staff panel).
 *  Discord interactions pass their interaction id instead, which IS the natural key. */
export function staffRef(kind: "buy" | "gift"): string {
  return `staff-${kind}:${randomUUID()}`;
}
