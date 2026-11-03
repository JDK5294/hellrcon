/**
 * A schedule rule's calendar in words — "on the 1st of every month at 00:00", "every Saturday and
 * Sunday at 20:00", "on the first Saturday of every month at 18:00". The panel's mirror of the
 * API's describeRecurrence (@app/schedule): the panel deliberately depends on no workspace
 * package, so the sentence is written twice, the way lib/banScope mirrors the ban scope.
 */
export type ScheduleRepeat = "monthly" | "weekly" | "nth" | "dates";

/** The schedule trigger's params, as the rule stores them (see @app/rules SCHEDULE_TRIGGER_FIELDS). */
export interface ScheduleParams {
  groupId?: string;
  repeat?: ScheduleRepeat | string;
  monthDay?: number;
  weekdays?: string;
  nth?: number;
  nthWeekday?: string;
  dates?: string;
  time?: string;
  stack?: boolean;
}

export const SCHEDULE_DEFAULTS: Required<ScheduleParams> = {
  groupId: "", repeat: "monthly", monthDay: 1, weekdays: "", nth: 1, nthWeekday: "sat", dates: "", time: "00:00", stack: true,
};

/** Monday first — "Saturday and Sunday" is how a weekend is said. */
export const WEEK: { id: string; short: string; name: string }[] = [
  { id: "mon", short: "Mon", name: "Monday" }, { id: "tue", short: "Tue", name: "Tuesday" },
  { id: "wed", short: "Wed", name: "Wednesday" }, { id: "thu", short: "Thu", name: "Thursday" },
  { id: "fri", short: "Fri", name: "Friday" }, { id: "sat", short: "Sat", name: "Saturday" },
  { id: "sun", short: "Sun", name: "Sunday" },
];

const listOf = (v: unknown) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const ordinalDay = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;
const which = (n: number) => (n === -1 ? "last" : ["first", "second", "third", "fourth"][n - 1] ?? `${n}th`);
const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "");

/** The days a weekly schedule runs on, as ids in week order. */
export function scheduleWeekdays(p: ScheduleParams): string[] {
  const chosen = new Set(listOf(p.weekdays).map((d) => d.toLowerCase().slice(0, 3)));
  return WEEK.map((d) => d.id).filter((id) => chosen.has(id));
}

export function describeSchedule(p: ScheduleParams): string {
  const at = `at ${String(p.time ?? "").trim() || "—"}`;
  if (p.repeat === "weekly") {
    const days = scheduleWeekdays(p).map((id) => WEEK.find((d) => d.id === id)!.name);
    return days.length ? `every ${and(days)} ${at}` : "every week (no day picked yet)";
  }
  if (p.repeat === "nth") {
    const day = WEEK.find((d) => d.id === String(p.nthWeekday ?? "").toLowerCase())?.name ?? "—";
    return `on the ${which(Number(p.nth ?? 1))} ${day} of every month ${at}`;
  }
  if (p.repeat === "dates") {
    const dates = listOf(p.dates);
    if (!dates.length) return "on set dates (none listed yet)";
    return `on ${dates.length > 3 ? `${dates.slice(0, 3).join(", ")} and ${dates.length - 3} more` : and(dates)} ${at}`;
  }
  const d = Number(p.monthDay ?? 1);
  return `on the ${d >= 31 ? "last day" : ordinalDay(d || 1)} of every month ${at}`;
}
