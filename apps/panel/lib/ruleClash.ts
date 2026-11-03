/**
 * Rules that would act on the same player for the same thing — the warning the rule editor shows
 * before a save, and the Enable button before switching a rule on. Two shapes count:
 *
 *  - punished twice: both rules punish (kick, ban, punish, switch team) for the same event;
 *  - warned and punished at once: one only messages while the other punishes the same event, so
 *    the warning lands with — or after — the punishment it was meant to come before.
 *
 * "The same event" is strict on purpose, because a false alarm on every save teaches staff to
 * click through the real one. Same trigger, servers they share, the same match text (or none on
 * either side), the same trigger settings, and the SAME count: "message at 1 team kill" beside
 * "kick at 3" is a ladder built from two rules, which is a choice, not a clash. A rule that is
 * off, held by its section, or on a trial run touches nobody, so it clashes with nothing. Only the
 * first step is compared — a rule's own ladder is its author's design.
 */
export interface ClashRule {
  id?: string;
  name: string;
  enabled?: boolean;
  sectionOff?: boolean;
  dryRun?: boolean;
  serverId: string | null;
  eventKind: string;
  match?: string | null;
  threshold?: number;
  windowSec?: number;
  countPerMatch?: boolean;
  params?: Record<string, unknown> | null;
  action: string;
}

export interface Clash {
  other: { id?: string; name: string };
  kind: "punishedTwice" | "warnedAndPunished";
  text: string;
}

const PUNISH: Record<string, string> = {
  kick: "kicks", punish: "punishes", tempban: "temp-bans", permaban: "bans", blacklist: "bans", switch: "switches the team of",
};
const WARN: Record<string, string> = { message: "messages" };

/** JSON with keys sorted, so two settings objects that say the same thing compare equal. */
function stable(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, val]) => val !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, norm(val)]));
    }
    return x;
  };
  return JSON.stringify(norm(v ?? null));
}

const acts = (r: ClashRule) => r.enabled !== false && !r.sectionOff && !r.dryRun;
const sharesServer = (a: ClashRule, b: ClashRule) => !a.serverId || !b.serverId || a.serverId === b.serverId;
const sameText = (a: ClashRule, b: ClashRule) => {
  const x = (a.match ?? "").trim().toLowerCase();
  const y = (b.match ?? "").trim().toLowerCase();
  return !x || !y || x === y;
};
/** The same count of the same event: one hit, or N in the same window (or N in one match). For
 *  "no kills in the window" the window IS the trigger, so it must match too. */
function sameCount(a: ClashRule, b: ClashRule): boolean {
  const ta = Math.max(1, Number(a.threshold ?? 1)), tb = Math.max(1, Number(b.threshold ?? 1));
  if (ta !== tb) return false;
  if (a.eventKind === "app.idle") return Number(a.windowSec ?? 0) === Number(b.windowSec ?? 0);
  if (ta === 1) return true;
  if (Boolean(a.countPerMatch) !== Boolean(b.countPerMatch)) return false;
  return Boolean(a.countPerMatch) || Number(a.windowSec ?? 0) === Number(b.windowSec ?? 0);
}

/** What the candidate would clash with among `others` (itself, by id, left out). */
export function ruleClashes(candidate: ClashRule, others: ClashRule[], what = "the same event"): Clash[] {
  if (!acts(candidate)) return [];
  const out: Clash[] = [];
  for (const o of others) {
    if (candidate.id && o.id === candidate.id) continue;
    if (!acts(o) || o.eventKind !== candidate.eventKind) continue;
    if (!sharesServer(candidate, o) || !sameText(candidate, o) || !sameCount(candidate, o)) continue;
    if (stable(candidate.params) !== stable(o.params)) continue;
    const mine = candidate.action, theirs = o.action;
    if (PUNISH[mine] && PUNISH[theirs]) {
      out.push({ other: { id: o.id, name: o.name }, kind: "punishedTwice",
        text: `“${o.name}” also ${PUNISH[theirs]} the player for ${what} — they would be punished twice.` });
    } else if (WARN[mine] && PUNISH[theirs]) {
      out.push({ other: { id: o.id, name: o.name }, kind: "warnedAndPunished",
        text: `“${o.name}” ${PUNISH[theirs]} the player for ${what} while this rule only messages them — the warning would arrive with the punishment, not before it.` });
    } else if (PUNISH[mine] && WARN[theirs]) {
      out.push({ other: { id: o.id, name: o.name }, kind: "warnedAndPunished",
        text: `“${o.name}” only messages the player for ${what} while this rule ${PUNISH[mine]} them — the warning would arrive with the punishment, not before it.` });
    }
  }
  return out;
}
