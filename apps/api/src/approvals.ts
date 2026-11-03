/**
 * The approvals spine: filing a request, and executing a line once someone signs it. Filing
 * needs no grant — lacking the write permission IS the ask.
 *
 * A request is filed by the SAME route that would have executed the action — the route runs all
 * of its validation, then lands here instead of at the game. So a line's payload has already
 * passed every check an executed action passes, and the approver is deciding a judgement call,
 * never debugging a malformed request.
 *
 * Execution happens AT APPROVAL, fresh, and the approver's AUTHORITY is what permits it: their
 * hour caps apply, so nobody can sign into existence a temp ban longer than they could issue
 * themselves. A failure to reach the game is recorded on the line (`applyError`), visibly, because
 * "approved but the server was down" must never read as "done".
 *
 * The ACTION IS THE REQUESTER'S, everywhere it is named. They found the player, made the call and
 * wrote the reason; the approver said yes. So the in-game notice is signed with the requester's
 * name, the game gets them as `adminName`, and the audit row, the ban decision and the VIP grant
 * all carry them too — with the approver recorded beside it (`data.approvedBy`, and the summary
 * says "approved by X"), because moving credit must not lose accountability. The approver's own
 * trail carries exactly one row for what they did: `request.approve`.
 *
 * It ran the other way at first — the approver's name on all of it — which put every request they
 * ever signed into their personal ban and kick counts, told the player to appeal to somebody who
 * had never seen the case, and left the moderator who handled it looking like they had done
 * nothing but fill in a form.
 */
import type { AppContext } from "./context.js";
import { displayNameOf, type Principal } from "./auth.js";
import { bankIfHeld, type ApprovalLineRow, type ApprovalRequestRow, type VipRow } from "@app/db";
import {
  ACTION_NOTICE_HEADER, ADMIN_ACTIONS, computeGrantExpiration, connectGameClient, describeGameRefusal,
  gameClientFor, renderActionText, signedText, signerFor, tempbanRefusal,
} from "./routes/kit.js";
import { str } from "./http.js";
import { PLAIN_WRITES, REPLAYABLE_WRITES, replayKey } from "./routes/kit.js";
import { replayHandler, replayPlainHandler } from "./replay.js";
import type { AskedRoute } from "./ask.js";
import { addWatchReason, syncWatchFlag } from "./watch.js";
// Filing lives in its own leaf (requests.ts) so the route wrapper can file a refused call
// without importing this executor; the cascade files from here.
import { fileRequest } from "./requests.js";
import { grantForHeld, heldBy } from "./group-perks.js";
import { approvalRefusal } from "@app/access";
// The queue, the signature, the cascade and the phone notifications all ask it; see its module.
import { signerCoverage } from "./sign-coverage.js";
export { signerCoverage };

/** A line as the trail names it: a filed call by its own words ("Add a player to a group"), an
 *  action by its kind and its player. */
function lineWords(l: ApprovalLineRow): string {
  if (l.kind === "route") {
    const subject = Array.isArray(l.payload.subject) ? (l.payload.subject as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return `“${str(l.payload.label) || str(l.payload.route) || "a change"}”${subject.length ? ` (${subject.join(" · ")})` : ""}`;
  }
  return `${l.kind} on ${l.playerName || l.playerId || "?"}`;
}

/** A line's payload with any approve-with-modification applied — the GRANTED numbers execute. */
export function effectivePayload(line: ApprovalLineRow): Record<string, unknown> {
  const out = { ...line.payload };
  for (const [field, m] of Object.entries(line.modified ?? {})) out[field] = m.granted;
  return out;
}

/**
 * Execute one approved line: the approver's authority, `opts.credit`'s name on the record (the
 * requester's, when an approval path passes it). `error` is null on success, else the sentence the
 * caller records on the line; `banId` is the decision row a ban created, which the cap cascade
 * needs so the remainder extends THAT sentence rather than stacking a second one. Never throws
 * for game-side failures.
 */
export async function executeApprovedLine(
  ctx: AppContext, approver: Principal, line: ApprovalLineRow,
  opts: { suffix?: string; credit?: { userId: string; name: string } } = {},
): Promise<{ error: string | null; banId?: string; refused?: { capability: string; serverId: string | null } }> {
  /*
   * Who this counts as work FOR. Defaults to the person pressing the button, which is what the
   * builder's own-permission path wants (they are both), so only the approval path passes it.
   *
   * The NAME is re-read from the account rather than taken from the request, because a request
   * can sit for up to 48 hours per rung and the name on it was captured when it was filed. Names
   * follow the person here as everywhere else (`linkDiscord` exists to keep them current) — a
   * moderator who changed their Discord nick on Tuesday must not have Monday's name signed onto
   * an in-game ban notice the player is expected to appeal to. The stored name still stands in
   * when the account is gone.
   */
  const creditAccount = opts.credit ? await ctx.repo.users.findById(opts.credit.userId).catch(() => null) : null;
  const credit = opts.credit
    ? { userId: opts.credit.userId, name: creditAccount ? displayNameOf(creditAccount) : opts.credit.name }
    : { userId: approver.user.id, name: approver.name };
  const bySomeoneElse = credit.userId !== approver.user.id;
  const SUFFIX = opts.suffix ?? (bySomeoneElse ? ` (approved by ${approver.name})` : " (approved request)");
  const approvedBy = bySomeoneElse ? { approvedBy: approver.name, approvedByUserId: approver.user.id } : {};
  /*
   * A FILED CALL, replayed. Every server-scoped write (map work, votes, seeding, console, the
   * configuration screens) is requestable through the wrapper they share rather than through a
   * branch of its own here, so approving one means running the very handler the request was
   * refused by — with the approver's grants for authority and the requester's account for the
   * name on everything it writes. The handler audits, signs and records under `p`, so handing it
   * that pair is the whole of "their authority, your work" for a surface this executor knows
   * nothing else about.
   */
  if (line.kind === "route") {
    const asked = line.payload as unknown as AskedRoute;
    const key = replayKey(str(asked.method), str(asked.route));
    const entry = REPLAYABLE_WRITES.get(key);
    /*
     * A call filed from inside a plain route — a group, a rule, a role, the shop — carries no
     * server of its own unless its check named one. Its handler resolves everything itself and
     * re-checks every permission it needs against the signer's grants, so nothing here second-
     * guesses it: what it refuses lands on the line, like a game that could not be reached.
     */
    const plain = entry ? null : PLAIN_WRITES.get(key);
    if (plain) {
      if (line.serverId) {
        const at = await ctx.repo.servers.findById(line.serverId);
        if (!at) return { error: "the server this was requested on no longer exists" };
        if (at.decommissionedAt) return { error: "the server this was requested on has been decommissioned — it takes no queued changes" };
      }
      const account = await ctx.repo.users.findById(credit.userId).catch(() => null);
      const asRequester: Principal = {
        ...approver,
        user: account ?? { ...approver.user, id: credit.userId, username: credit.name, discordNick: null, discordUsername: null },
        name: credit.name,
        signer: { userId: approver.user.id, name: approver.name },
      };
      const params = { ...(asked.params ?? {}) as Record<string, string> };
      // As below: a server named by the path is the line's, not whatever the stored params say.
      if (line.serverId && str(asked.route).startsWith("/api/servers/:id")) params.id = line.serverId;
      const out = await replayPlainHandler(plain, {
        ctx, p: asRequester, params, path: str(asked.route),
        url: str(asked.url) || str(asked.route), method: str(asked.method) || "POST", body: asked.body,
        provenance: { suffix: SUFFIX, data: { requestId: line.requestId, ...approvedBy } },
      });
      return { error: out.error, ...(out.refused ? { refused: out.refused } : {}) };
    }
    if (!entry) return { error: `this kind of request cannot be applied any more — "${str(asked.label) || str(asked.route)}" is no longer a thing the app does` };
    /*
     * The line's capability is a SNAPSHOT of what the route wanted when it was filed; the registry
     * knows what it wants now. They differ only if somebody re-gated the route while a request sat
     * in the queue — rare, and exactly the case where the older, weaker permission must not be the
     * one that decides. The replay skips the wrapper's own check, so this is where that is caught.
     */
    if (entry.capability !== line.capability) {
      const stale = approvalRefusal({ userId: approver.user.id, grants: approver.grants }, entry.capability, line.serverId);
      if (stale) return { error: `this now needs ${entry.capability} — ${stale}` };
    }
    const server = line.serverId ? await ctx.repo.servers.findById(line.serverId) : null;
    if (!server) return { error: "the server this was requested on no longer exists" };
    // Same rule as the stale-capability check above: the state NOW decides, not the state at
    // filing. A line filed before the server was decommissioned must not be the one write that
    // still lands on it — a decommissioned server takes no queued writes from anyone.
    if (server.decommissionedAt) return { error: "the server this was requested on has been decommissioned — it takes no queued changes" };
    /*
     * The approver's grants, the requester's identity. If the requester's ACCOUNT is gone (they
     * left between filing and signing) the id and the name still travel together as a pair —
     * borrowing the approver's user row for a row that names somebody else would file the action
     * on the wrong person's profile, which is the exact mix-up this whole change is undoing.
     */
    const account = await ctx.repo.users.findById(credit.userId).catch(() => null);
    const asRequester: Principal = {
      ...approver,
      user: account ?? { ...approver.user, id: credit.userId, username: credit.name, discordNick: null, discordUsername: null },
      name: credit.name,
      // Whose grants these are, for the guards that ask "is this your own account?" (kit.ts).
      signer: { userId: approver.user.id, name: approver.name },
    };
    const out = await replayHandler(entry.handler, {
      ctx, p: asRequester, server, id: server.id,
      /*
       * The stored params, but the SERVER id comes from the line, not from them. They agree today
       * (the router matched them off the same path the line was filed from) and a handler reading
       * `params.id` rather than the `id` it is handed — several do — must not be the thing that
       * decides which server an approved call lands on.
       */
      params: { ...(asked.params ?? {}) as Record<string, string>, id: server.id },
      url: str(asked.url) || str(asked.route), method: str(asked.method) || "POST", body: asked.body,
      path: str(asked.route),
      // Whatever it records says which request it came through and who signed it, the same way a
      // player action's row does — the handler writes that row, so the stamp meets it there.
      provenance: { suffix: SUFFIX, data: { requestId: line.requestId, ...approvedBy } },
    });
    return { error: out.error, ...(out.refused ? { refused: out.refused } : {}) };
  }

  /*
   * The community-wide kinds come first, because they carry no server and the lookup below would
   * refuse them out of hand. A watch is a fact about a PERSON — it follows them to every server
   * this community runs, which is why the watchlist has never been scoped to one.
   */
  if (line.kind === "watch" || line.kind === "unwatch") {
    const player = str(line.payload.playerDbId) ? await ctx.repo.players.findById(str(line.payload.playerDbId)) : null;
    if (!player) return { error: "that player profile no longer exists" };
    const by = { userId: credit.userId, name: credit.name };
    if (line.kind === "watch") {
      const reason = str(line.payload.reason) || "on the watchlist";
      const { flags } = await addWatchReason(ctx.repo, player.id, { reason, by, expiresAt: str(line.payload.expiresAt) || null });
      await ctx.repo.audit.create({
        actorUserId: credit.userId, actorName: credit.name, action: "player.watchlist",
        targetType: "player", targetId: player.id, targetName: player.name,
        summary: `added a watch reason for ${player.name} — ${reason}${str(line.payload.expiresAt) ? ` (expires ${str(line.payload.expiresAt)})` : ""}${SUFFIX}`,
        data: { op: "add-reason", reason, expiresAt: str(line.payload.expiresAt) || undefined, watchlist: flags.watchlist, requestId: line.requestId, ...approvedBy },
      });
      return { error: null };
    }
    // Taking somebody off closes every active reason on them, other staff's included — which is
    // why it is the curate capability, and why it is worth asking for rather than doing quietly.
    await ctx.repo.watchReasons.removeAll(player.id, credit.name);
    await syncWatchFlag(ctx.repo, player.id, by);
    await ctx.repo.audit.create({
      actorUserId: credit.userId, actorName: credit.name, action: "player.flags",
      targetType: "player", targetId: player.id, targetName: player.name,
      summary: `removed ${player.name} from the watchlist${SUFFIX}`,
      data: { watchlist: false, requestId: line.requestId, ...approvedBy },
    });
    return { error: null };
  }

  const server = line.serverId ? await ctx.repo.servers.findById(line.serverId) : null;
  if (!server) return { error: "the server this was requested on no longer exists" };
  // As above: a decommissioned server takes no queued writes, whoever signs them.
  if (server.decommissionedAt) return { error: "the server this was requested on has been decommissioned — it takes no queued changes" };
  const body = effectivePayload(line);
  const playerId = str(body.playerId) || line.playerId || "";
  const playerName = str(body.playerName) || line.playerName || null;
  const spec = ADMIN_ACTIONS[line.kind];
  if (spec) {
    const hours = Number(body.hours ?? 0);
    if (line.kind === "tempban") {
      // Backstop only. approveLine caps the hours to the signer's own limit before this runs
      // (and files the remainder onwards), so reaching this means a caller skipped that — never
      // mint a ban longer than the signer could issue.
      const refusal = await tempbanRefusal(ctx.repo, approver, server.id, hours);
      if (refusal) return { error: refusal };
    }
    const sign = await signerFor(ctx, line.kind, credit.name);
    const cmdParams: Record<string, unknown> = {
      playerId,
      reason: signedText(sign, body.reason, "reason", undefined, ACTION_NOTICE_HEADER[line.kind] ?? ""),
      message: signedText(sign, body.message, "message"),
      hours,
      adminName: credit.name,
    };
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      // Placeholders are filled when the action EXECUTES — the approved text is the template, and
      // {vip_until} and friends should read as of now, not as of the request.
      await client.execute(spec.command, await renderActionText(ctx.repo, server, cmdParams, { playerId, playerName }, null, client));
    } catch (err) {
      /*
       * A signature lands minutes or hours after the request was filed, so the commonest failure
       * by far is "they already left" — and the wire says only "(500) command punishPlayer
       * failed: Unable to perform request". The approver then reads their own decision as broken
       * rather than as a target who went home. Same humanising the direct action route uses, on
       * the still-open connection: name the player, name the reason, say what would work.
       */
      return { error: await describeGameRefusal(client, server, line.kind, playerId, playerName ?? "", (err as Error).message)
        .catch(() => (err as Error).message) };
    } finally {
      await client.disconnect().catch(() => {});
    }
    // Same audit shape as a direct action — one record, under the name of whoever asked for it —
    // with the approver and the request threaded through so the profile timeline can say why it
    // happened and on whose authority.
    await ctx.repo.audit.create({
      actorUserId: credit.userId, actorName: credit.name, action: `player.${line.kind}`,
      targetType: "player", targetId: playerId, targetName: playerName ?? undefined, serverId: server.id,
      summary: `ran ${line.kind} on ${playerName || playerId}${str(body.reason) ? ` — ${str(body.reason)}` : ""}${SUFFIX}`,
      data: { playerId, reason: cmdParams.reason || undefined, message: cmdParams.message || undefined, hours: spec.needs.includes("hours") ? hours || undefined : undefined, requestId: line.requestId, ...approvedBy },
    });
    // …and the same decision records the direct route writes, because the reconciler and the
    // Bans page must not care which door an action came through.
    let banId: string | undefined;
    if (line.kind === "tempban" || line.kind === "permaban") {
      const row = await ctx.repo.playerBans.create({
        game: server.game, playerId, playerName,
        kind: line.kind === "permaban" ? "perma" : "temp",
        reason: str(body.reason) || "(no reason given)", category: str(body.category) || null,
        scope: { mode: "servers", serverIds: [server.id] },
        expiresAt: line.kind === "tempban" && hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null,
        createdByUserId: credit.userId, createdByName: credit.name,
      });
      banId = row.id;
    } else if (line.kind === "unban_temp" || line.kind === "unban_perma") {
      await ctx.repo.playerBans.liftAllFor(playerId, credit.name, line.kind === "unban_perma" ? "perma" : "temp");
    }
    return { error: null, banId };
  }

  if (line.kind === "tempban_extend") {
    /*
     * The over-cap split's second half. The capped portion already ran when the request was
     * filed; approving serves the FULL sentence in time actually banned:
     *   served    = how long the capped ban has kept them out so far (capped at its own length —
     *               a gap after it lapsed is playtime nobody can retroactively unplay)
     *   remaining = requested − served, measured at THIS moment
     * The decision row's expiry moves (one sentence, not a ban/unban/ban zigzag) and the game
     * gets an entry for the remainder. Deny needs no rollback — the capped ban stood on the
     * requester's own authority.
     */
    const totalHours = Number(body.hours ?? 0); // possibly approved-down
    const appliedHours = Number(line.payload.appliedHours ?? 0);
    const banStart = Date.parse(str(line.payload.banStart));
    if (totalHours <= appliedHours) return { error: `the ${appliedHours}h already applied covers this — nothing left to extend` };
    const servedMs = Number.isFinite(banStart) ? Math.max(0, Math.min(Date.now() - banStart, appliedHours * 3_600_000)) : 0;
    const remainingMs = totalHours * 3_600_000 - servedMs;
    if (remainingMs <= 0) return { error: `the ${totalHours}h asked for has already been served` };
    // An unban voids the extension: approving must not quietly re-ban a player somebody
    // deliberately released.
    const decision = str(line.payload.banDecisionId) ? await ctx.repo.playerBans.get(str(line.payload.banDecisionId)) : null;
    if (!decision || decision.liftedAt) return { error: "the ban this would extend was lifted — nothing to extend" };
    const remainingHours = Math.max(1, Math.ceil(remainingMs / 3_600_000));
    // The approver's own cap covers the REMAINDER they are signing into existence.
    const refusal = await tempbanRefusal(ctx.repo, approver, server.id, remainingHours);
    if (refusal) return { error: refusal };
    const sign = await signerFor(ctx, "tempban", credit.name);
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      await client.execute("tempBanPlayer", await renderActionText(ctx.repo, server, {
        playerId,
        reason: signedText(sign, line.payload.reason, "reason", undefined, ACTION_NOTICE_HEADER.tempban ?? ""),
        hours: remainingHours, adminName: credit.name,
      }, { playerId, playerName: line.playerName ?? null }, null, client));
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await client.disconnect().catch(() => {});
    }
    await ctx.repo.playerBans.setExpiry(decision.id, new Date(Date.now() + remainingMs).toISOString());
    const servedH = (servedMs / 3_600_000).toFixed(1);
    /*
     * `continues` marks this as bookkeeping on a decision that has already been counted, so the
     * staff pages skip it (`countableActions`). The trail and the player's own history keep it —
     * "extended to 48h total" is exactly what a reader needs — but nobody's ban count moves: this
     * is the SAME sentence reaching the length that was asked for in the first place. Counted, a
     * 48h ban that climbed two rungs read as three bans on the requester's record.
     */
    await ctx.repo.audit.create({
      actorUserId: credit.userId, actorName: credit.name, action: "player.tempban",
      targetType: "player", targetId: playerId, targetName: playerName ?? undefined, serverId: server.id,
      summary: `extended ${playerName || playerId}'s temp ban to ${totalHours}h total (served ${servedH}h, ${remainingHours}h more)${SUFFIX}`,
      data: { playerId, hours: totalHours, servedHours: Number(servedH), remainingHours, requestId: line.requestId, continues: decision.id, ...approvedBy },
    });
    return { error: null };
  }

  if (line.kind === "vip") {
    let existing = await ctx.repo.vips.get(server.id, playerId);
    let expiration: string | null;
    try { expiration = computeGrantExpiration(body, existing); }
    catch (err) { return { error: (err as Error).message }; }
    // Permanent VIP from a group perk: an approved length joins the VIP they get back on leaving
    // the group; an approved PERMANENT grant is a person's decision and makes the grant theirs —
    // whether or not a hold was there when it was read.
    const intent = grantForHeld(body);
    const banked = async (row: VipRow) => {
      await ctx.repo.audit.create({
        actorUserId: credit.userId, actorName: credit.name, action: "vip.grant",
        targetType: "player", targetId: playerId, targetName: playerName ?? undefined, serverId: server.id,
        summary: `granted VIP to ${playerName || playerId} on ${server.name} — they hold ${heldBy(row.groupHold!)}, so it was added to the VIP they get back on leaving${SUFFIX}`,
        data: { playerId, groupHeld: true, bankedMs: row.groupHold!.bankedMs, requestId: line.requestId, ...approvedBy },
      });
      return { error: null };
    };
    if (existing?.groupHold && intent.kind === "bank") {
      const basis = await bankIfHeld(ctx.repo, server.id, playerId, intent.change);
      if (basis.banked) return banked(basis.banked);
      // The hold ended between the read and the bank: grant from the row its release left.
      existing = basis.existing;
      expiration = computeGrantExpiration(body, existing);
    }
    const vipPaused = Boolean(existing?.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
    const client = gameClientFor(server);
    try {
      if (!vipPaused) {
        await connectGameClient(client, server);
        await client.execute("addVip", { playerId, description: playerName || "VIP" });
      }
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await client.disconnect().catch(() => {});
    }
    // No replacePermanent: an approved line names a length, not this player's standing grant,
    // and an approver who never saw "this will END a permanent VIP" has not decided that. The
    // store keeps permanent; the audit line records what actually stood after the write.
    const row = await ctx.repo.vips.upsert({ serverId: server.id, playerId, playerName, comment: str(body.comment) || null, expiration, createdByUserId: credit.userId, createdByName: credit.name, ...(intent.kind === "permanent" ? { endsGroupHold: true } : {}) });
    // A hold that began after the read took the dated grant into its frozen balance.
    if (row.groupHold) return banked(row);
    const kept = expiration !== null && row.expiration === null;
    await ctx.repo.audit.create({
      actorUserId: credit.userId, actorName: credit.name, action: "vip.grant",
      targetType: "player", targetId: playerId, targetName: playerName ?? undefined, serverId: server.id,
      summary: `granted VIP to ${playerName || playerId} on ${server.name} (${row.expiration ? `until ${row.expiration}` : kept ? "already permanent — kept" : "permanent"})${row.endedHold ? ` — it was ${heldBy(row.endedHold)}; it is theirs now, and leaving the group no longer ends it` : ""}${SUFFIX}`,
      data: { playerId, expiration: row.expiration, requestId: line.requestId, ...(kept ? { keptPermanent: true } : {}), ...(row.endedHold ? { endedGroupHold: true } : {}), ...approvedBy },
    });
    return { error: null };
  }

  if (line.kind === "vipRevoke") {
    const existing = await ctx.repo.vips.get(server.id, playerId);
    if (!existing) return { error: "no VIP grant on this server" };
    if (existing.groupHold) return { error: `they hold ${heldBy(existing.groupHold)} — remove them from the group to end it` };
    /*
     * Ending a PERMANENT grant takes a signer who was shown it was permanent — it is very often a
     * paid one. The line records the grant as it stood when it was asked for, and the card and the
     * queue say so; a grant that became permanent since (or a line from before lines said) was
     * never in front of whoever is signing, the same reason an approved grant never ends a
     * permanent one.
     */
    const asked = (line.payload.grant ?? null) as { expiration?: unknown } | null;
    if (existing.expiration === null && !(asked && asked.expiration === null)) {
      return { error: "their VIP is permanent, and this request did not show that when it was asked for — nobody signing it was told they would end a permanent grant. File it again from their VIP entry if it should still go" };
    }
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      await client.execute("removeVip", { playerId });
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await client.disconnect().catch(() => {});
    }
    // The same rule again at the write, because the game call is a round trip: a grant made
    // permanent, or taken into a group's hold, while it ran was never in front of the signer. Only
    // a line that showed a permanent grant may delete one; otherwise only a dated, unheld row goes,
    // and a grant that changed keeps its row and gets back the game entry just removed.
    const showedPermanent = Boolean(asked && asked.expiration === null);
    if (!(showedPermanent ? await ctx.repo.vips.remove(server.id, playerId) : await ctx.repo.vips.removeTimed(server.id, playerId))) {
      const now = await ctx.repo.vips.get(server.id, playerId);
      if (!now) return { error: "their VIP was removed while this was being applied" };
      if (!(now.pausedUntil && Date.parse(now.pausedUntil) > Date.now())) {
        const back = gameClientFor(server);
        try {
          await connectGameClient(back, server);
          await back.execute("addVip", { playerId, description: now.playerName || playerName || "VIP" });
        } catch { /* reported below either way: the grant stands, nothing was revoked */ } finally {
          await back.disconnect().catch(() => {});
        }
      }
      return { error: `their VIP changed while this was being applied — it is now ${now.groupHold ? heldBy(now.groupHold) : "permanent"}, and was left as it is. File it again from their VIP entry if it should still go` };
    }
    await ctx.repo.audit.create({
      actorUserId: credit.userId, actorName: credit.name, action: "vip.revoke",
      targetType: "player", targetId: playerId, targetName: playerName ?? undefined, serverId: server.id,
      summary: `revoked VIP from ${playerName || playerId} on ${server.name}${SUFFIX}`,
      data: { playerId, requestId: line.requestId, ...approvedBy },
    });
    return { error: null };
  }

  return { error: `unknown request kind '${line.kind}'` };
}

/**
 * Approve one pending line as `p`: the conditional transition, the execution, the record. Shared
 * by the panel routes and the Discord relay — one decision path, whatever surface pressed it.
 *
 * THE CASCADE. A signer applies as much of the ask as their own authority covers, and whatever
 * is left over is filed onwards for someone with more. A 48h temp ban signed by a moderator
 * capped at 24h used to dead-end — "approved, but not applied: your temp-ban limit is 24h" — so
 * their real authority over the first 24 hours was thrown away and the request died in place.
 * Now the 24h lands immediately and the remaining 24h becomes a fresh `tempban_extend` request in
 * the ORIGINAL requester's name, climbing to whoever can cover it. That is the point of the
 * chain: coverage extends upwards, one signature at a time, instead of every request needing to
 * find the one person senior enough to swallow it whole.
 */
export async function approveLine(
  ctx: AppContext, p: Principal, req: ApprovalRequestRow, line: ApprovalLineRow,
  modified: Record<string, { requested: number; granted: number }> | null,
): Promise<{ line: ApprovalLineRow; applyError: string | null; cascaded?: { appliedHours: number; requestedHours: number; requestId: string } } | { refusal: string } | { raced: true }> {
  // The deadline is enforced AT SIGNING, not just by the sweep: between the deadline and the
  // sweep's next pass the request still reads "open", and an approval in that window would
  // execute something the contract says aged out. Denials stay possible until the sweep closes
  // it — a late reason still beats a silent expiry, and a denial executes nothing.
  if (req.expiresAt && Date.parse(req.expiresAt) <= Date.now()) {
    return { refusal: "this request has expired — nothing executes from an expired request" };
  }
  const refusal = approvalRefusal({ userId: p.user.id, grants: p.grants }, line.capability, line.serverId);
  if (refusal) return { refusal };

  /*
   * How much of this can the signer actually cover? Their cap is applied as a MODIFICATION —
   * recorded as asked→granted on the line, exactly like an approve-down typed by hand — so the
   * execution below is within their authority by construction and the record says what they
   * signed for rather than what they wished they could.
   */
  const cover = await signerCoverage(ctx, p, line, modified);
  if (!cover.progress) {
    return { refusal: `your temp-ban limit does not reach past the ${cover.applied}h already applied — this needs someone with a longer limit` };
  }
  let cascade: { asked: number; covered: number } | null = null;
  if (cover.partial) {
    cascade = { asked: cover.total, covered: cover.covered };
    // `requested` stays the ORIGINAL ask, not the figure this signer was reduced to — the record
    // reads "48 asked, 24 granted" even when the approver had already typed 40 of their own.
    const askedOriginally = Number(line.payload.hours ?? cover.total);
    modified = { ...(modified ?? {}), hours: { requested: askedOriginally, granted: cover.covered } };
  }

  const decided = await ctx.repo.approvals.decideLine(line.id, { state: "approved", byUserId: p.user.id, byName: p.name, modified });
  if (!decided) return { raced: true }; // somebody else got there first — their stamp stands
  // Executed on the approver's authority, credited to the requester whose work it is.
  const exec = await executeApprovedLine(ctx, p, decided, { credit: { userId: req.requesterUserId, name: req.requesterName } });
  const applyError = exec.error;
  const applied = (await ctx.repo.approvals.markApplied(decided.id, applyError))!;

  /*
   * The remainder climbs — but only if the covered part actually landed. If the game refused it
   * there is nothing to extend, and filing a follow-up would ask somebody to top up a ban that
   * does not exist.
   */
  let cascaded: { appliedHours: number; requestedHours: number; requestId: string } | undefined;
  if (cascade && !applyError && line.serverId) {
    // The follow-up always describes the SAME sentence on the SAME decision row: what has been
    // applied so far, what was asked in total, and when the clock started. So a request can climb
    // as many rungs as the community has — each signer adds what they may, and whatever is still
    // short files onwards again.
    const banId = exec.banId ?? (str(line.payload.banDecisionId) || undefined);
    if (banId) {
      const onwards = await fileRequest(
        ctx,
        { user: { id: req.requesterUserId }, name: req.requesterName },
        [{
          serverId: line.serverId, capability: "action.tempban", kind: "tempban_extend",
          payload: {
            playerId: line.playerId ?? undefined, playerName: line.playerName ?? null,
            reason: str(line.payload.reason) || undefined,
            hours: cascade.asked, appliedHours: cascade.covered,
            banStart: str(line.payload.banStart) || new Date().toISOString(),
            banDecisionId: banId,
          },
          playerId: line.playerId, playerName: line.playerName,
        }],
        {
          note: `the rest of a ${cascade.asked}h ban — ${p.name} covered it to ${cascade.covered}h`,
          // The same ask, still climbing: it must not read as a second request the asker made.
          continues: req.id,
        },
      );
      cascaded = { appliedHours: cascade.covered, requestedHours: cascade.asked, requestId: onwards.id };
    }
  }

  await ctx.repo.audit.create({
    actorUserId: p.user.id, actorName: p.name, action: "request.approve",
    targetType: "request", targetId: req.id, serverId: line.serverId ?? undefined,
    summary: `approved ${lineWords(line)} (requested by ${req.requesterName})${modified ? ` — modified: ${Object.entries(modified).map(([f, m]) => `${f} ${m.requested}→${m.granted}`).join(", ")}` : ""}${cascaded ? ` — covered ${cascaded.appliedHours}h of ${cascaded.requestedHours}h, the rest filed for approval` : ""}${applyError ? ` — execution failed: ${applyError}` : ""}`,
    data: { requestId: req.id, lineId: line.id, kind: line.kind, requestedBy: req.requesterName, requestedByUserId: req.requesterUserId, modified: modified ?? undefined, applyError: applyError ?? undefined, cascadedTo: cascaded?.requestId },
  });
  await ctx.repo.approvals.settle(req.id);
  return { line: applied, applyError, cascaded };
}

/** Deny one pending line — the same authority as approving it, exercised the other way, and the
 *  reason is mandatory at every surface because the requester reads it. */
export async function denyLine(
  ctx: AppContext, p: Principal, req: ApprovalRequestRow, line: ApprovalLineRow, reason: string,
): Promise<{ line: ApprovalLineRow } | { refusal: string } | { raced: true }> {
  const refusal = approvalRefusal({ userId: p.user.id, grants: p.grants }, line.capability, line.serverId);
  if (refusal) return { refusal };
  const decided = await ctx.repo.approvals.decideLine(line.id, { state: "denied", byUserId: p.user.id, byName: p.name, denyReason: reason });
  if (!decided) return { raced: true };
  await ctx.repo.audit.create({
    actorUserId: p.user.id, actorName: p.name, action: "request.deny",
    targetType: "request", targetId: req.id, serverId: line.serverId ?? undefined,
    summary: `denied ${lineWords(line)} (requested by ${req.requesterName}) — ${reason}`,
    data: { requestId: req.id, lineId: line.id, kind: line.kind, reason, requestedBy: req.requesterName, requestedByUserId: req.requesterUserId },
  });
  await ctx.repo.approvals.settle(req.id);
  return { line: decided };
}
