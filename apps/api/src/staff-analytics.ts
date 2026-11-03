/**
 * Pure aggregation of a staff member's audit trail into the shapes the staff-profile analytics UI
 * needs — a coarse category breakdown, top targets/servers, and a daily activity series (for the
 * progression chart). Kept out of the route so it's unit-testable with fixture rows, no DB/HTTP.
 */
import type { AuditRow } from "@app/db";
import { UTC, dayIn } from "./analytics.js";

/**
 * SEVEN HUES, and that is a hard ceiling, not a coincidence.
 *
 * The order IS the colour-slot order in the panel's breakdown and radar, and the validated
 * categorical palette has seven slots — past which `seriesVar` folds everything into slot 7 rather
 * than inventing an eighth hue. Adding `punishments` as an eighth once did not add a colour; it
 * gave two differently-labelled bars the SAME one, which is the exact thing the fold prevents.
 *
 * `other` is what made room for `requests` without an eighth hue. It is the RESIDUAL bucket — the
 * leftovers, not a kind of work — so it is drawn in neutral ink (`seriesVar(-1)`), which no hue can
 * be confused with under any colour vision. That is a long-standing convention for an "Other"
 * slice, not a shortcut: it costs no palette slot, so seven hues cover seven real categories and
 * the residual stays visibly residual. It MUST therefore stay LAST in this list.
 *
 * `blacklist` made room earlier. This app's ban model folded the blacklist into bans (see
 * docs/ban-model.md — the blacklist is a filing cabinet, and the Moderation hub says so), so
 * counting blacklist actions as their own kind of staff work contradicted the model everything
 * else already moved to. They are ban decisions, and they are counted as such.
 *
 * An EIGHTH HUED category needs an eighth validated palette slot in BOTH themes first — see
 * `viz/palette.ts`. Appending one here without that is silently drawing two series in one colour.
 */
export type StaffCategory = "bans" | "kicks" | "vips" | "messages" | "moves" | "punishments" | "requests" | "other";
export const STAFF_CATEGORIES: StaffCategory[] = ["bans", "kicks", "vips", "messages", "moves", "punishments", "requests", "other"];
/** The residual bucket: drawn in neutral ink, so it consumes no categorical hue. Always last. */
export const RESIDUAL_CATEGORY: StaffCategory = "other";

/** Map a dotted audit action ("player.tempban", "vip.grant", …) to a coarse category so the UI can
 *  draw a breakdown / radar / progression toggles without knowing every action verb. */
export function categorizeAction(action: string): StaffCategory {
  const a = action.toLowerCase();
  /*
   * Approval paperwork is its own kind of work, and it is FIRST because the verb that follows
   * `request.` is not what happened — nobody banned anybody by approving a request. An approver's
   * profile now reads "requests: 12" instead of burying a night of judgement calls in "other",
   * which is exactly what it is: filing, signing off, and turning down other people's actions.
   * The action those requests carried out is credited to the person who asked for it (see
   * approvals.ts), so this never double-counts a ban.
   */
  if (/^request\./.test(a)) return "requests";
  // Blacklisting IS a ban decision in this app's model, so it is counted with them.
  if (/(tempban|permaban|unban|blacklist|\bban\b|ban$)/.test(a)) return "bans";
  if (/kick/.test(a)) return "kicks";
  if (/vip/.test(a)) return "vips";
  // Before "messages", because that branch matched `punish` and swallowed it: a punish KILLS the
  // player — it is a penalty, and the nearest thing to a kick — so every punishment a staff member
  // handed out was drawn on their profile as a message they had sent.
  if (/punish/.test(a)) return "punishments";
  if (/(broadcast|message|welcome|\bsay\b|template)/.test(a)) return "messages";
  if (/(switch|move|team)/.test(a)) return "moves";
  return "other";
}

export interface StaffTarget { id: string | null; name: string; count: number }
export interface StaffServerStat { serverId: string; count: number }
export interface StaffDaily { date: string; total: number; byCategory: Record<StaffCategory, number> }

export interface StaffAnalytics {
  total: number;
  firstAt: string | null;
  lastAt: string | null;
  byAction: Record<string, number>;
  byCategory: Record<StaffCategory, number>;
  topTargets: StaffTarget[];
  topServers: StaffServerStat[];
  daily: StaffDaily[];
}

const zeroCats = (): Record<StaffCategory, number> =>
  Object.fromEntries(STAFF_CATEGORIES.map((c) => [c, 0])) as Record<StaffCategory, number>;

/**
 * Roll a set of audit rows (already filtered to one actor) into the analytics payload.
 *
 * `targetDisplayName` is optional because the row type does not carry it — the caller resolves it
 * (see `readableAudit`) when it wants "most acted on" to read as people rather than as ids.
 */
export function buildStaffAnalytics(entries: (AuditRow & { targetDisplayName?: string | null })[], tz: string = UTC): StaffAnalytics {
  const byAction: Record<string, number> = {};
  const byCategory = zeroCats();
  const targets = new Map<string, StaffTarget>();
  const servers = new Map<string, number>();
  const days = new Map<string, StaffDaily>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for (const e of entries) {
    byAction[e.action] = (byAction[e.action] ?? 0) + 1;
    const cat = categorizeAction(e.action);
    byCategory[cat] += 1;

    /*
     * PLAYERS only. "Top targets" is a list of people this admin has acted on, and the panel draws
     * every row as a player link — so a row whose target is a request, a role or a setting arrived
     * as a raw uuid with a dead link beside it. Filing five approval requests put five uuids at the
     * top of a moderator's "most acted on", above the player they were actually about.
     */
    if (e.targetType === "player" && (e.targetId || e.targetName)) {
      const key = e.targetId ?? e.targetName!;
      const t = targets.get(key) ?? { id: e.targetId, name: e.targetDisplayName || e.targetName || e.targetId || "?", count: 0 };
      t.count += 1;
      targets.set(key, t);
    }
    if (e.serverId) servers.set(e.serverId, (servers.get(e.serverId) ?? 0) + 1);

    const date = dayIn(e.ts, tz); // calendar day in the viewer's zone, not UTC
    let d = days.get(date);
    if (!d) { d = { date, total: 0, byCategory: zeroCats() }; days.set(date, d); }
    d.total += 1;
    d.byCategory[cat] += 1;

    if (!firstAt || e.ts < firstAt) firstAt = e.ts;
    if (!lastAt || e.ts > lastAt) lastAt = e.ts;
  }

  return {
    total: entries.length,
    firstAt,
    lastAt,
    byAction,
    byCategory,
    topTargets: [...targets.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    topServers: [...servers.entries()].map(([serverId, count]) => ({ serverId, count })).sort((a, b) => b.count - a.count),
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
