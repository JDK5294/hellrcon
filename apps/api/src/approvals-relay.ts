/**
 * The Discord relay for approval requests — OPTIONAL, and additive by design.
 *
 * When (and only when) a bot token exists AND the community set an approvals channel
 * (app-config → approvalsChannelId), every filed request posts a card there and the card edits
 * itself as lines are decided — the same coverage story the Requests tab tells, pushed to where
 * staff already are. Two buttons ride on an open card: "Approve all I can" and "Deny…" (a modal
 * that demands the reason, because the requester reads it). A press resolves the presser through
 * their LINKED STAFF ACCOUNT and flows through the exact same approveLine/denyLine the panel
 * uses — one permission model, one audit trail, whichever surface pressed the button.
 *
 * The panel never depends on any of this: with the channel blank, nothing posts, nothing changes.
 * Every send/edit here is fire-and-forget from the caller's point of view — a Discord outage must
 * never fail a filing or an approval that already happened.
 *
 * The CARD — what a request looks like in Discord, and posting/editing it — lives in
 * `approval-cards.ts`, because filing a request has to be able to post one without importing the
 * decision path (and, through it, the executor and the routing layer). What stays here is the
 * half that genuinely needs those: a button press, turned into a decision.
 */
import type { AppContext } from "./context.js";
import { displayNameOf, resolveAccess, type Principal } from "./auth.js";
import { approveLine, denyLine } from "./approvals.js";
// The card itself (rendering, posting, editing) is a leaf — see approval-cards.ts.
import { postApprovalCard, updateApprovalCard } from "./approval-cards.js";

/**
 * A button press from the relay card, resolved through the presser's linked staff account and
 * run through the SAME per-line decision path as the panel. Returns the sentence Discord shows
 * the presser (always ephemeral — the card itself is the shared record).
 */
export async function decideFromDiscord(
  ctx: AppContext,
  d: { discordUserId: string; requestId: string; verb: "all" | "deny"; reason?: string },
): Promise<string> {
  const account = await ctx.repo.users.findByDiscordId(d.discordUserId);
  if (!account) return "No staff account is linked to your Discord — sign in to the panel with Discord first.";
  const access = await resolveAccess(ctx.repo, account.id);
  const p: Principal = { user: account, name: displayNameOf(account), ...access };
  const r = await ctx.repo.approvals.get(d.requestId);
  if (!r) return "That request no longer exists.";
  if (r.status !== "open") return `That request is already ${r.status}.`;

  if (d.verb === "deny") {
    const reason = (d.reason ?? "").trim();
    if (!reason) return "A reason is required — the requester reads it.";
    let denied = 0; let refusal: string | null = null;
    for (const line of r.lines) {
      if (line.state !== "pending") continue;
      const out = await denyLine(ctx, p, r, line, reason);
      if ("refusal" in out) refusal = out.refusal;
      else if ("line" in out) denied++;
    }
    await updateApprovalCard(ctx, r.id);
    if (!denied) return refusal ?? "Nothing was still waiting on this request.";
    return `Denied ${denied} line${denied === 1 ? "" : "s"} — your reason is on the card and in the requester's panel.`;
  }

  let approved = 0; let failed = 0; let skipped = 0; let climbed = 0; let refusal: string | null = null;
  for (const line of r.lines) {
    if (line.state !== "pending") continue;
    const out = await approveLine(ctx, p, r, line, null);
    if ("refusal" in out) { skipped++; refusal = out.refusal; }
    else if ("raced" in out) skipped++;
    else {
      approved++;
      if (out.applyError) failed++;
      /*
       * The cascade has to reach the channel it was pressed in.
       *
       * A capped signer covers what their own limit reaches and the remainder is filed onwards as
       * a fresh request. The panel posts a card for that follow-up; this path did not, so a
       * partial approval pressed in Discord applied 24 of 48 hours and then went silent — the
       * request existed, but the only surface anybody was watching never heard of it, and the
       * presser was told "Approved 1 line" as though the ask were finished.
       */
      if (out.cascaded) { climbed++; void postApprovalCard(ctx, out.cascaded.requestId); }
    }
  }
  await updateApprovalCard(ctx, r.id);
  if (!approved) return refusal ? `Nothing signed: ${refusal}` : "Nothing was still waiting on this request.";
  // Not "in your name": you authorised it, the requester's name is the one that went to the game
  // and onto the record. Saying otherwise here is how an approver ends up surprised by their own
  // staff-activity page.
  const parts = [`Approved ${approved} line${approved === 1 ? "" : "s"} — carried out under ${r.requesterName}'s name`];
  if (failed) parts.push(`${failed} could not reach the game — see the card`);
  if (climbed) parts.push(`${climbed === 1 ? "one ban went" : `${climbed} bans went`} as far as your limit reaches; the rest is filed for a longer limit (new card above)`);
  if (skipped) parts.push(`${skipped} left for someone with the right permissions`);
  return parts.join(" · ") + ".";
}
