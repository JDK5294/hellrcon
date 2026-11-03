/**
 * Seeding enforcement rows — seed.warn, seed.punish, seed.kick — as the reader may see them.
 *
 * The worker writes each row's line for anyone who can read the trail (see seedActionSummary in
 * @app/db): an open rule is named outright, while the seeding area and steamroll protection —
 * ground rules, configured on Map zones under the rules permission (admin.moderation) — read as a
 * plain "seeding rule", and a cap fight judged from position reads like one judged by score. A
 * holder of that permission gets the whole line back, rebuilt from the reason the row recorded.
 * Anyone else gets the row with its record taken off — every seeding row alike — and the wire
 * says no more than the line.
 *
 * Rows from before actions recorded a reason carry only the message the player was sent, which
 * can quote a ground rule's notice: for the permission's holders it becomes the line's detail,
 * and for everyone else it comes off with the rest.
 */
import { RESTRICTED_SEED_RULES, seedActionSummary } from "@app/db";

const SEED_ACTION = /^seed\.(warn|punish|kick)$/;

type Row = { action: string; summary: string; targetId: string | null; targetName: string | null; data: Record<string, unknown> | null };

export function seedingAuditFor<T extends Row>(rows: T[], full: boolean): T[] {
  return rows.map((row) => {
    const kind = SEED_ACTION.exec(row.action)?.[1];
    if (!kind || !row.data) return row;
    const d = row.data;
    if (!full) {
      // The line already says everything this reader may know; the data keeps only what it adds
      // nothing to — that it was a dry run, and the ladder step the line already counts.
      return { ...row, data: { ...(d.dryRun === true ? { dryRun: true } : {}), ...(d.step ? { step: d.step } : {}) } };
    }
    if (typeof d.rule !== "string") {
      const told = typeof d.message === "string" ? d.message.trim() : "";
      return told ? { ...row, summary: `${row.summary}: “${told}”` } : row;
    }
    if (!RESTRICTED_SEED_RULES.has(d.rule) && d.byPosition !== true) return row; // the stored line is whole
    return {
      ...row,
      summary: seedActionSummary({
        kind, name: row.targetName || row.targetId || "", dryRun: d.dryRun === true,
        rule: d.rule, detail: d.detail, byPosition: d.byPosition, step: d.step,
      }, true),
    };
  });
}
