/**
 * A schedule window: "when is this active?" by wall-clock in a timezone. Generalizes the earlier bot's
 * profile matcher (`_window_contains` / `_profile_days/dates/players_match`) — day-of-week, dates,
 * and an overnight-aware time window — and adds months and years.
 *
 * Every field is optional and additive: an absent field means "any", and all present fields must
 * hold. Pure and timezone-correct (via Intl), so it's the shared brain for auto-settings profiles,
 * map-vote profiles, and anything else that turns on/off by date/time.
 */

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface ScheduleWindow {
  /** IANA timezone the window is evaluated in (default "UTC"). */
  timezone?: string;
  /** active only on these weekdays (empty/absent = any). */
  daysOfWeek?: Weekday[];
  /** active only in these months, 1-12 (empty/absent = any). */
  months?: number[];
  /** active only in these years (empty/absent = any). */
  years?: number[];
  /** active only on these dates: "MM-DD" (recurring each year) or "YYYY-MM-DD" (exact). */
  dates?: string[];
  /** time-of-day window "HH:MM". Supports overnight wraparound (start > end). Omit BOTH for all-day. */
  start?: string;
  end?: string;
}

interface ZonedParts { year: number; month: number; day: number; weekday: Weekday; minutes: number }

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Intl throws a RangeError on an unusable timezone — including the empty string, which is what a
 * blank form field or an older row saved before the API validated one looks like. This engine runs
 * inside a worker tick that decides which map-vote profile and which auto-settings are in force, so
 * a throw there takes down scheduling for the whole server, on every tick, forever.
 *
 * The API rejects a bad zone on save, so this should never fire. It exists because this is a shared
 * library — the plugin SDK hands it to third-party code, and rows can predate the validator — and
 * because "an hour off" beats "nothing runs".
 */
function safeFormatter(tz: string): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = {
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
  }
}

/** "HH:MM" → minutes past midnight, or null when it is not a time at all. */
function timeMinutesOrNull(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** The wall-clock components of `date` in `tz`. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const fmt = safeFormatter(tz);
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") parts[p.type] = p.value;
  const wd = (parts.weekday ?? "Sun").slice(0, 3).toLowerCase() as Weekday;
  const hour = Number(parts.hour) % 24; // h23 gives 0-23, but guard "24" just in case
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: wd, minutes: hour * 60 + Number(parts.minute),
  };
}

/**
 * True if `nowMinutes` is inside [start,end). Equal bounds = all day; start>end wraps past midnight.
 *
 * An unparseable bound makes the window INACTIVE, never active. This matters more than it looks:
 * the old parse produced NaN, every comparison against NaN was false, and the overnight branch then
 * fell through to `nowMinutes < end` — so a mistyped start turned a "night only" window into one
 * that was on for most of the day. A window that silently stops matching is a bug someone notices;
 * a window that silently matches everything applies the wrong map set to a full server.
 */
export function windowContains(nowMinutes: number, start: string, end: string): boolean {
  const s = timeMinutesOrNull(start);
  const e = timeMinutesOrNull(end);
  if (s === null || e === null) return false;
  if (s === e) return true;
  if (s < e) return s <= nowMinutes && nowMinutes < e;
  return nowMinutes >= s || nowMinutes < e; // overnight
}

/** True if the window is active at `now`. */
export function isWindowActive(win: ScheduleWindow, now: Date): boolean {
  const p = zonedParts(now, win.timezone ?? "UTC");
  if (win.daysOfWeek?.length && !win.daysOfWeek.map((d) => d.toLowerCase()).includes(p.weekday)) return false;
  if (win.months?.length && !win.months.includes(p.month)) return false;
  if (win.years?.length && !win.years.includes(p.year)) return false;
  if (win.dates?.length) {
    const mmdd = `${pad2(p.month)}-${pad2(p.day)}`;
    const ymd = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    const wanted = new Set(win.dates.map((d) => d.trim()));
    if (!wanted.has(mmdd) && !wanted.has(ymd)) return false;
  }
  if (win.start !== undefined || win.end !== undefined) {
    if (!windowContains(p.minutes, win.start ?? "00:00", win.end ?? "00:00")) return false;
  }
  return true;
}
