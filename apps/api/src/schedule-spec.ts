/**
 * A scheduled rule's calendar, read off its params — the one translation the save-time check and
 * the runner share, so what was validated is exactly what runs. The params' shape belongs to
 * @app/rules (SCHEDULE_TRIGGER_FIELDS); the calendar maths to @app/schedule.
 */
import { canonicalGroupId, resolveTriggerParams, scheduleWeekdays, SCHEDULE_KIND } from "@app/rules";
import { WEEKDAYS, type Recurrence, type RecurrenceRepeat, type Weekday } from "@app/schedule";

/** What a schedule rule may do to its group's members. Timed VIP only, never a permanent grant. */
export const SCHEDULE_ACTIONS = new Set(["vip", "viprevoke", "viptrim", "vipreduce"]);
/**
 * What a rule on a group's membership may do — what reaches a player who is not on a server: VIP,
 * points, a tag, a note. Checked when the rule is saved and again whenever one fires, since a rule
 * that came in by import or restore never went through the save.
 */
export const GROUP_RULE_ACTIONS = new Set(["vip", "points", "tag", "note"]);
/** The ones that take VIP away — the revoke key's, where a grant takes the grant key. */
export const SCHEDULE_TAKING_ACTIONS = new Set(["viprevoke", "viptrim", "vipreduce"]);

const isWeekday = (d: string): d is Weekday => (WEEKDAYS as string[]).includes(d);

/** The recurrence a schedule rule's params describe (defaults filled in, as stored). */
export function scheduleOf(params: Record<string, unknown> | null | undefined): Recurrence {
  const p = resolveTriggerParams(SCHEDULE_KIND, params);
  const list = (v: unknown) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    repeat: String(p.repeat) as RecurrenceRepeat,
    monthDay: Number(p.monthDay),
    weekdays: scheduleWeekdays(p.weekdays).filter(isWeekday),
    nth: Number(p.nth),
    nthWeekday: (isWeekday(String(p.nthWeekday)) ? String(p.nthWeekday) : undefined) as Weekday | undefined,
    dates: list(p.dates),
    time: String(p.time ?? ""),
  };
}

/** The group a schedule (or group-trigger) rule names. */
export function ruleGroupId(params: Record<string, unknown> | null | undefined): string {
  return canonicalGroupId((params ?? {}).groupId);
}
