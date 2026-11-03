/**
 * Time as people read it — the pure formatters (the <Time> cell that uses them is a component).
 *
 * Every timestamp in the panel used to render as a full locale string — "7/27/2026, 6:33:56 PM".
 * But nearly every column showing a time exists to answer *how recently*: when was this player last
 * seen, when was that ban set, when was the notice posted. A full timestamp makes you do date
 * arithmetic to answer that; "3 min ago" answers it at a glance.
 *
 * So the relative form is what's displayed, and the exact instant is always one hover away — never
 * lost, just not shouted. Anything older than a week shows the date instead of an ever-growing
 * "63 days ago", which stops being useful long before it stops being true.
 */

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/**
 * THE zone every timestamp in the panel is written in.
 *
 * Undefined = the device's zone, which is where every install starts. The app sets it at boot to
 * the person's own preference, falling back to the community zone (Settings → Community time
 * zone) — so an admin in London reading a New York community's panel sees the community's clock
 * unless they have asked for their own. One module-level value rather than a context, because
 * the formatters below are plain functions called from a hundred render sites, and threading a
 * provider through all of them would be a refactor in service of nothing.
 */
let displayZone: string | undefined;

/** Set the display zone (null/"" = the device's). Callers re-render on their own; the shared
 *  30-second clock brings long-lived timestamp cells along shortly after. */
export function setDisplayZone(tz: string | null | undefined): void {
  displayZone = tz || undefined;
}
export function getDisplayZone(): string | undefined {
  return displayZone;
}

/** The IANA zone timestamps are currently written in — the display zone, else the device's. */
export function effectiveZone(): string {
  if (displayZone) return displayZone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** A short label for the current display zone — "EDT" beside a date input, so what zone a typed
 *  time means is never a guess. Falls back to the IANA name when no abbreviation exists. */
export function zoneLabel(at = new Date()): string {
  const tz = effectiveZone();
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch { return tz; }
}

/** Exact, unambiguous, for tooltips and anywhere the precise instant is the point — written in
 *  the display zone. An unusable zone falls back to the device's rather than showing nothing. */
export function fmtExact(iso?: string | null): string {
  if (!iso) return "";
  try {
    if (displayZone) {
      try { return new Date(iso).toLocaleString(undefined, { timeZone: displayZone }); } catch { /* bad zone → device */ }
    }
    return new Date(iso).toLocaleString();
  } catch { return String(iso); }
}

/** The DATE alone, in the display zone — for "since 12 Aug" tiles where the clock is noise.
 *  A bare `toLocaleDateString()` renders the DEVICE's date, which near midnight is a different
 *  day from the one every other timestamp on screen names. */
export function fmtDay(iso?: string | null): string {
  if (!iso) return "";
  try {
    if (displayZone) {
      try { return new Date(iso).toLocaleDateString(undefined, { timeZone: displayZone }); } catch { /* bad zone → device */ }
    }
    return new Date(iso).toLocaleDateString();
  } catch { return String(iso); }
}

/** The TIME alone, in the display zone — the "refreshed 9:31 PM" stamps. Same reason: a device
 *  clock beside community-zone timestamps reads as a discrepancy, not a convenience. */
export function fmtClock(at: Date = new Date()): string {
  try {
    if (displayZone) {
      try { return at.toLocaleTimeString(undefined, { timeZone: displayZone }); } catch { /* bad zone → device */ }
    }
    return at.toLocaleTimeString();
  } catch { return at.toISOString().slice(11, 19); }
}

/** Minutes east of UTC that `tz` sits at the given instant (DST-correct, via Intl). */
function zoneOffsetMin(tz: string, at: Date): number {
  // Truncate to the minute FIRST: the formatted parts carry no seconds, so comparing them against
  // an instant that still has some makes the difference a fraction of a minute — which rounded to
  // a phantom one-minute offset and had a UTC viewer told that 00:00 UTC was 12:01 AM for them.
  const whole = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(whole)) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour === "24" ? "0" : p.hour), Number(p.minute));
  return Math.round((asUtc - whole.getTime()) / 60_000);
}

/**
 * An "HH:MM" wall-clock time written in `tz`, read back on the viewer's own clock — "20:00" UTC
 * becomes "4:00 PM" for someone in New York. Null when the viewer's zone shows the same wall time
 * (no hint needed) or the input isn't a clock time. Schedule times are stored in the CONFIG's zone
 * because the engine evaluates them there; this is only how a human double-checks them.
 */
export function localClock(tz: string | undefined, hhmm: string | undefined, now = new Date()): string | null {
  if (!tz || !hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  try {
    const shift = -now.getTimezoneOffset() - zoneOffsetMin(tz, now);
    if (shift === 0) return null;
    const [h, m] = hhmm.split(":").map(Number);
    const t = (((h! * 60 + m! + shift) % 1440) + 1440) % 1440;
    return new Date(2000, 0, 1, Math.floor(t / 60), t % 60).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch { return null; }
}

/** A start–end window in `tz` on the viewer's clock: "4:00 PM–11:00 PM your time". Null when moot. */
export function localWindowHint(tz: string | undefined, start: string | undefined, end: string | undefined, now = new Date()): string | null {
  // "24:00" is how the schedule spells end-of-day; as a clock it is midnight.
  const norm = (v: string | undefined) => ((v || "00:00") === "24:00" ? "00:00" : (v || "00:00"));
  const s = localClock(tz, norm(start), now);
  const e = localClock(tz, norm(end), now);
  if (s === null || e === null) return null; // same wall clock as the viewer, or not a clock time
  return `${s}–${e} your time`;
}

/**
 * The overnight-window footgun, said before it bites: the schedule engine reads day and time as
 * independent AND-conditions, so a "fri 22:00–02:00" profile goes DEAD at midnight — the spill
 * into Saturday fails the weekday check, which is never what the person who wrote "Friday night"
 * meant. The engine's reading is deliberate (changing it would re-time every stored window), so
 * the editor warns instead: this returns the warning when a wrapping window (start > end) meets a
 * day filter that does not include the following day, and null everywhere the setup is fine.
 */
export function overnightSpillHint(daysOfWeek: string[] | undefined, start: string | undefined, end: string | undefined): string | null {
  const min = (v: string | undefined): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? "").trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const s = min(start), e = min(end);
  if (s === null || e === null || s <= e) return null; // not a wrapping window
  const order = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const days = (daysOfWeek ?? []).map((d) => d.toLowerCase()).filter((d) => order.includes(d));
  if (days.length === 0 || days.length === 7) return null; // every day: the wrap always lands on a selected day
  const chosen = new Set(days);
  const cut = order.filter((d) => chosen.has(d) && !chosen.has(order[(order.indexOf(d) + 1) % 7]!));
  if (cut.length === 0) return null;
  return `this window wraps past midnight, and after midnight counts as the NEXT day — on ${cut.join(", ")} it stops at 00:00. Add the following day to run to ${end}.`;
}

/** "just now" · "3 min ago" · "5 h ago" · "yesterday" · "12 Mar" · "12 Mar 2025". */
export function fmtRelative(iso?: string | null, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const diff = now - t;

  // Future timestamps are usually expiries ("VIP until…"), which read naturally the other way.
  if (diff < -MIN) {
    const ahead = -diff;
    if (ahead < HOUR) return `in ${Math.round(ahead / MIN)} min`;
    if (ahead < DAY) return `in ${Math.round(ahead / HOUR)} h`;
    if (ahead < 7 * DAY) return `in ${Math.round(ahead / DAY)} d`;
    // The year, when it is not this one — the same rule the past branch below uses, and it was
    // missing here. Future dates are mostly expiries, so a permanent-ish VIP running to 2028 read
    // as a bare "12 Mar" and looked like it lapsed a fortnight ago.
    return dateInZone(t, yearOf(t) === yearOf(now)
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" });
  }
  if (diff < 45_000) return "just now";
  if (diff < HOUR) return `${Math.round(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} h ago`;
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)} d ago`;
  const sameYear = yearOf(t) === yearOf(now);
  return dateInZone(t, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** The calendar year an instant falls in, IN THE DISPLAY ZONE — which is the zone the date beside
 *  it is written in. Reading the device's year instead disagreed with the printed date for the few
 *  hours around new year when the two zones are in different years. */
function yearOf(t: number): number {
  if (displayZone) {
    try {
      return Number(new Intl.DateTimeFormat("en-US", { timeZone: displayZone, year: "numeric" }).format(new Date(t)));
    } catch { /* bad zone → device */ }
  }
  return new Date(t).getFullYear();
}

/** A date string in the display zone — the calendar day can differ from the device's near midnight. */
function dateInZone(t: number, opts: Intl.DateTimeFormatOptions): string {
  if (displayZone) {
    try { return new Date(t).toLocaleDateString(undefined, { ...opts, timeZone: displayZone }); } catch { /* bad zone → device */ }
  }
  return new Date(t).toLocaleDateString(undefined, opts);
}

/**
 * A `datetime-local` input's value ("YYYY-MM-DDTHH:MM"), read as a wall-clock time IN THE DISPLAY
 * ZONE, as an ISO instant — or null for junk, never a guess. This is what makes "7:30 PM" typed
 * into an event mean 7:30 the community's time whatever device the admin happens to be holding;
 * `Date.parse` alone reads it in the device's zone, which is exactly the mismatch it replaces.
 * DST-correct: the offset is refined against the resolved instant, so a wall time on the far side
 * of a transition lands on the right side of it.
 */
export function wallToIso(wall: string): string | null {
  return wallToIsoIn(wall, effectiveZone());
}

/** wallToIso in a NAMED zone — a file's times, read back in the zone its column heading says
 *  they were written in, whatever this person's display zone is today. */
export function wallToIsoIn(wall: string, tz: string): string | null {
  if (!wall || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(wall)) return null;
  const asUtc = Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}Z`);
  if (!Number.isFinite(asUtc)) return null;
  try {
    let t = asUtc - zoneOffsetMin(tz, new Date(asUtc)) * MIN;
    t = asUtc - zoneOffsetMin(tz, new Date(t)) * MIN;
    return new Date(t).toISOString();
  } catch {
    const t = Date.parse(wall);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
}

/**
 * Replace raw ISO timestamps embedded in a sentence with the same instant written for a person,
 * in the display zone. Audit summaries and grant notes were composed with the ISO string inline
 * ("granted VIP … until 2026-08-22T21:30:00.000Z"), and those sentences are stored — so the fix
 * that reaches every historical row is to translate them where they are READ, not rewrite them.
 */
const ISO_IN_TEXT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/g;
export function humanizeIsoInText(text?: string | null): string {
  if (!text) return "";
  return text.replace(ISO_IN_TEXT, (iso) => fmtExact(iso) || iso);
}

/** The inverse: an ISO instant as a `datetime-local` value in the display zone, for prefills. */
export function isoToWall(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  try {
    return new Date(t + zoneOffsetMin(effectiveZone(), new Date(t)) * MIN).toISOString().slice(0, 16);
  } catch { return ""; }
}
