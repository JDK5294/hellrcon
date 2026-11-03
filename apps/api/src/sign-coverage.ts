/**
 * How much of a ban line can THIS signer actually authorise?
 *
 * The chain's arithmetic, in one place, because four surfaces need the same answer: the queue
 * (offer a line only to someone who can move it along), the signature (cap what executes), the
 * cascade (file whatever is left), and the phone notification (tell only someone the queue would
 * offer the line to). Its own module for that last one: phone-alerts.ts asks it without importing
 * the executor in approvals.ts, which would put the approvals spine in an import cycle.
 *
 * A cap governs the TOTAL SENTENCE a person may put their name to, not the size of each command
 * they send. So a 24h moderator can authorise a ban of at most 24h — full stop. Once 24 of a 48h
 * ask are applied they cannot advance it by another minute; extending past their own ceiling is
 * somebody else's signature to give, which is the entire point of asking upwards.
 *
 * The tempting alternative — letting them authorise `served + cap`, since the COMMAND they would
 * send is only the unserved part — quietly defeats that: wait twelve hours and the same
 * moderator tops the ban up to 36h, wait again for 48h, and a player ends up serving a sentence
 * no one senior ever agreed to. Served time is deliberately absent from this calculation.
 * (It still matters when EXECUTING — the game entry covers what is left to serve — but not to
 * the question of who may authorise the sentence.)
 */
import type { ApprovalLineRow } from "@app/db";
import type { AppContext } from "./context.js";
import type { Principal } from "./auth.js";
import { tempbanMaxHours } from "./routes/kit.js";

export async function signerCoverage(
  ctx: Pick<AppContext, "repo">, p: Principal, line: ApprovalLineRow,
  modified?: Record<string, { requested: number; granted: number }> | null,
): Promise<{ total: number; covered: number; applied: number; partial: boolean; progress: boolean }> {
  const none = { total: 0, covered: 0, applied: 0, partial: false, progress: true };
  if ((line.kind !== "tempban" && line.kind !== "tempban_extend") || !line.serverId) return none;
  const total = Number(modified?.hours?.granted ?? line.payload.hours ?? 0);
  if (!(total > 0)) return none;
  const cap = await tempbanMaxHours(ctx.repo, p, line.serverId);
  if (!Number.isFinite(cap) || cap <= 0) return { total, covered: total, applied: 0, partial: false, progress: true };

  // A plain ban starts from nothing; an extend carries the total a previous signer already put
  // their name to. Advancing it means authorising a LONGER total than that.
  const applied = line.kind === "tempban_extend" ? Number(line.payload.appliedHours ?? 0) : 0;
  /*
   * FLOOR, and the whole-hour figure is the ONLY one anyone downstream uses.
   *
   * Rounding here was wrong twice over. Rounding UP hands a 24.6h cap the authority to sign 25h —
   * a cap that does not cap. Rounding DOWN onto the number already applied is worse: the line
   * still counts as "progress" (24.4 > 24), so it approves, grants 24 again, and files an
   * identical follow-up — which the same signer can approve again, for ever, re-banning the
   * player on every pass. Hours are whole; a signer may authorise the largest whole hour their
   * cap actually covers, and it has to be strictly more than what is already applied or they are
   * not moving the request anywhere.
   */
  const covered = Math.floor(Math.min(total, cap));
  return { total, covered, applied, partial: covered < total, progress: covered >= 1 && covered > applied };
}
