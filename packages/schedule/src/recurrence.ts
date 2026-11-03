/**
 * Recurrence: "when does this happen?" — the calendar half of a schedule, where the window engine
 * beside it answers "is it on right now?".
 *
 * A window is a state (on between 18:00 and 23:00); a recurrence is a list of moments (the 1st of
 * every month at 00:00). Something that must happen ONCE per moment — a monthly VIP grant to a
 * group — cannot be built from a window: "is it the 1st?" stays true all day, and a process that
 * was down at midnight never sees the edge at all. So this answers the question a once-per-moment
 * runner actually asks: what is the most recent moment at or before now? The runner keeps its own
 * record of which moments it has acted on (a claim per moment), which is what makes "never twice"
 * and "catch up once after an outage" the same rule: the latest moment, if not yet claimed.
 *
 * Every moment is a wall-clock date and time in a timezone, and its identity is the PERIOD it
 * belongs to: the local month ("2026-11") for a monthly or nth-weekday recurrence — one per month,
 * so moving the day or the time after this month's has run waits for next month instead of
 * running twice — and the local date ("2026-11-07") for weekly and listed dates, one per day.
 *
 * Pure and timezone-correct via Intl, like the window engine; DST gaps resolve to the nearest real
 * instant rather than throwing.
 */
import { WEEKDAYS, zonedParts, type Weekday } from "./window.js";

export type RecurrenceRepeat = "monthly" | "weekly" | "dates" | "nth";

export interface Recurrence {
  /**
   * monthly — day `monthDay` of every month (31 means the last day in shorter months);
   * weekly  — every one of `weekdays`;
   * dates   — exactly the listed `dates` ("YYYY-MM-DD");
   * nth     — the `nth` `nthWeekday` of every month ("the first Saturday"; -1 = the last one).
   */
  repeat: RecurrenceRepeat;
  monthDay?: number;
  weekdays?: Weekday[];
  dates?: string[];
  nth?: number;
  nthWeekday?: Weekday;
  /** "HH:MM", 24-hour, in the timezone the recurrence is read in. */
  time: string;
}

/** One moment: its identity (the period it belongs to — see above) and the instant it falls on. */
export interface Occurrence { key: string; at: Date }

const pad2 = (n: number) => String(n).padStart(2, "0");
const DAY_MS = 86_400_000;
/** How far back the calendar walk looks: past a year, nothing a monthly or weekly rule can mean. */
const LOOKBACK_DAYS = 400;

/** "HH:MM" → minutes past midnight, or null. */
function minutesOf(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** How far `tz` is ahead of UTC at `at`, in ms (to the minute — no real zone is finer). */
function offsetMs(at: number, tz: string): number {
  const p = zonedParts(new Date(at), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

/**
 * The instant a wall-clock date and time in `tz` falls on. Two passes, because the offset to
 * subtract is the one in force at the ANSWER, which on a DST-change day differs from the one at
 * the first guess. A time the clocks skip (02:30 on a spring-forward night) lands an hour off,
 * on a real instant, rather than nowhere.
 */
export function zonedTimeToInstant(year: number, month: number, day: number, minutes: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const first = guess - offsetMs(guess, tz);
  return new Date(guess - offsetMs(first, tz));
}

/** Does this calendar date (a local date — year, month 1-12, day, weekday) carry a moment? */
function dateMatches(r: Recurrence, year: number, month: number, day: number, weekday: Weekday): boolean {
  if (r.repeat === "monthly") {
    const want = Math.min(Math.max(1, Math.round(r.monthDay ?? 1)), daysInMonth(year, month));
    return day === want;
  }
  if (r.repeat === "weekly") return (r.weekdays ?? []).includes(weekday);
  if (r.repeat === "nth") {
    if (weekday !== r.nthWeekday) return false;
    const nth = Math.round(r.nth ?? 1);
    return nth === -1 ? day + 7 > daysInMonth(year, month) : Math.ceil(day / 7) === nth;
  }
  return false;
}

/**
 * The most recent moment of `r` at or before `now`, read in `tz` — or null when there is none
 * (an unreadable time, no weekdays picked, only future dates, nothing in the last year).
 */
export function latestOccurrence(r: Recurrence, now: Date, tz: string): Occurrence | null {
  const minutes = minutesOf(r.time);
  if (minutes === null) return null;
  const nowMs = now.getTime();
  if (r.repeat === "dates") {
    let best: Occurrence | null = null;
    for (const raw of r.dates ?? []) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
      if (!m) continue;
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) continue;
      const at = zonedTimeToInstant(y, mo, d, minutes, tz);
      if (at.getTime() <= nowMs && (!best || at.getTime() > best.at.getTime())) best = { key: `${y}-${pad2(mo)}-${pad2(d)}`, at };
    }
    return best;
  }
  // Walk local calendar dates backwards from today. The dates themselves are zone-free once
  // "today" is known, so a UTC-midnight Date is just a calendar cursor here.
  const today = zonedParts(now, tz);
  let cursor = Date.UTC(today.year, today.month - 1, today.day);
  for (let i = 0; i < LOOKBACK_DAYS; i += 1, cursor -= DAY_MS) {
    const c = new Date(cursor);
    const [y, mo, d] = [c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate()];
    if (!dateMatches(r, y, mo, d, WEEKDAYS[c.getUTCDay()]!)) continue;
    const at = zonedTimeToInstant(y, mo, d, minutes, tz);
    if (at.getTime() <= nowMs) return { key: r.repeat === "weekly" ? `${y}-${pad2(mo)}-${pad2(d)}` : `${y}-${pad2(mo)}`, at };
  }
  return null;
}

/**
 * Why a recurrence can never produce a moment, or null when it can. The save-time check: a
 * schedule that never fires is not a quiet schedule, it is a broken one somebody is counting on.
 */
export function recurrenceError(r: Recurrence): string | null {
  if (minutesOf(r.time) === null) return "the time must be HH:MM, 24-hour (00:00 to 23:59)";
  if (r.repeat === "monthly") {
    const d = Number(r.monthDay);
    if (!Number.isInteger(d) || d < 1 || d > 31) return "the day of the month must be 1 to 31 (31 runs on the last day of shorter months)";
    return null;
  }
  if (r.repeat === "weekly") return (r.weekdays ?? []).length ? null : "pick at least one day of the week";
  if (r.repeat === "nth") {
    const n = Number(r.nth);
    if (!(n === -1 || (Number.isInteger(n) && n >= 1 && n <= 4))) return "pick which one — the first to the fourth, or the last";
    return r.nthWeekday && WEEKDAYS.includes(r.nthWeekday) ? null : "pick the day of the week";
  }
  if (r.repeat === "dates") {
    const dates = r.dates ?? [];
    if (!dates.length) return "list at least one date (YYYY-MM-DD)";
    for (const raw of dates) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > daysInMonth(Number(m[1]), Number(m[2]))) {
        return `"${String(raw).trim()}" is not a date — write it as YYYY-MM-DD`;
      }
    }
    return null;
  }
  return "repeat must be monthly, weekly, nth (e.g. the first Saturday) or dates";
}

const ORDINAL = (n: number) => (n === -1 ? "last" : n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`);
const DAY_NAME: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const dayOfMonth = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;

/** "on the 1st of every month at 00:00", "every Saturday and Sunday at 20:00", "on the last Friday
 *  of every month at 21:00", "on 2026-12-25 at 12:00" — for audit summaries. */
export function describeRecurrence(r: Recurrence): string {
  const at = `at ${String(r.time ?? "").trim()}`;
  if (r.repeat === "monthly") return `on the ${Number(r.monthDay) >= 31 ? "last day" : dayOfMonth(Number(r.monthDay) || 1)} of every month ${at}`;
  if (r.repeat === "weekly") {
    // Monday first: "Saturday and Sunday" is how a weekend is said.
    const names = (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as Weekday[]).filter((d) => (r.weekdays ?? []).includes(d)).map((d) => DAY_NAME[d]);
    return `every ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "—"} ${at}`;
  }
  if (r.repeat === "nth") return `on the ${ORDINAL(Number(r.nth))} ${DAY_NAME[r.nthWeekday ?? "sat"]} of every month ${at}`;
  const dates = (r.dates ?? []).map((d) => String(d).trim());
  return `on ${dates.length > 3 ? `${dates.slice(0, 3).join(", ")} and ${dates.length - 3} more` : dates.join(", ")} ${at}`;
}
