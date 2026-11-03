/**
 * Which map set is in charge, over EVERY combination of time and player count — computed exactly,
 * not sampled.
 *
 * A vote's map sets are matched first-wins against a schedule AND a player-count gate, so coverage
 * is genuinely two-dimensional: "18:00–23:00 uses prime time" is only true above whatever count the
 * seeding set claims, and "the rest of the day falls back to defaults" is only true at counts no
 * set claims. Anything that fixes one axis to read the other — a heat grid at 60 players, a
 * sentence per day — states something that is false at other counts. Staff then discover the hole
 * when a Tuesday-morning vote offers the wrong maps.
 *
 * The escape is that both axes are piecewise constant. Every predicate in play changes value only
 * at a bound the config itself names: a window's start/end, a `playersBelow`, a `playersAbove`.
 * Cutting each axis at those bounds gives rectangles inside which the answer cannot change, so
 * evaluating one point per rectangle is not a sample — it is the whole rectangle's answer. The
 * result is a handful of exact regions ("under 40 players: seeding, all day"), however many hours
 * or counts they span.
 *
 * The predicates are the shared engine's own (`windowContains`, `matchesPlayerCount`) applied to a
 * weekday/minute/count triple rather than an instant, so this cannot drift from what the worker
 * decides. Only the Date→wall-clock step is replaced, which is the part that is about a moment in
 * time rather than about a schedule.
 *
 * Calendar-gated sets (a D-Day set on 06-06) are deliberately NOT folded into the weekly picture —
 * they are not part of a normal week — and are reported separately so they are never simply missing.
 *
 * Timezones: the report's axes are drawn in the CONFIG's timezone, but each profile may carry its
 * own `spec.timezone`, and the worker honours it (`spec.timezone ?? config timezone`). A profile in
 * another zone is therefore evaluated at its own local wall-clock — shifted by the offset difference
 * in effect at `at` — so the picture matches what actually runs. The one blind spot is a DST
 * transition: the offset is sampled once at `at`, so a zone-crossing profile can draw an hour off
 * during the other half of the year. That is the display only; the worker recomputes per tick.
 */
import { windowContains, matchesPlayerCount, zonedParts, type Weekday } from "@app/schedule";
import type { MapVoteProfile } from "./profiles.js";

/** Monday-first, which is how the panel's day picker reads. */
export const COVERAGE_WEEK: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** A stretch of the day, and the set that owns it. `null` = no set matches; engine defaults apply. */
export interface CoverageSpan {
  /** minutes past midnight, half-open [startMinute, endMinute). */
  startMinute: number;
  endMinute: number;
  profile: string | null;
}

/** One player-count band and how the day divides inside it. `maxPlayers` null = unbounded above. */
export interface CoverageBand {
  minPlayers: number;
  maxPlayers: number | null;
  spans: CoverageSpan[];
}

/** Days that behave identically, and the bands they share. */
export interface CoverageGroup {
  days: Weekday[];
  bands: CoverageBand[];
}

export interface CoverageReport {
  groups: CoverageGroup[];
  /** sets left out of the weekly picture because they only apply on named dates/months/years. */
  calendarOnly: { name: string; when: string }[];
  /** true when some (day, time, count) combination matches no set at all. */
  hasGaps: boolean;
}

/** A set gated on dates/months/years cannot be placed on a generic week. */
function calendarGate(p: MapVoteProfile): string | null {
  const s = p.spec;
  if (!s) return null;
  const bits: string[] = [];
  if (s.dates?.length) bits.push(s.dates.join(", "));
  if (s.months?.length) bits.push(`month ${s.months.join(", ")}`);
  if (s.years?.length) bits.push(`year ${s.years.join(", ")}`);
  return bits.length ? bits.join(" · ") : null;
}

/**
 * Offset from UTC in minutes for `tz` at `at` (positive east of Greenwich). Built on the schedule
 * package's own zonedParts so an unusable zone name degrades the same way it does there: to UTC.
 */
function tzOffsetMin(tz: string, at: Date): number {
  const p = zonedParts(at, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day) + p.minutes * 60_000;
  const truncated = Math.floor(at.getTime() / 60_000) * 60_000; // zonedParts is minute-precise
  return Math.round((wallAsUtc - truncated) / 60_000);
}

/** A weekly profile plus how far its own wall-clock sits from the config's (0 for same zone). */
interface ShiftedProfile {
  profile: MapVoteProfile;
  /** minutes to ADD to a config-axis minute to get this profile's local minute. */
  diff: number;
}

const wrapMinute = (m: number): number => ((m % 1440) + 1440) % 1440;

/** Every config-axis minute at which some window opens or closes. Always includes midnight. */
function timeBounds(profiles: ShiftedProfile[]): number[] {
  const out = new Set<number>([0]);
  for (const { profile: p, diff } of profiles) {
    for (const v of [p.spec?.start, p.spec?.end]) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
      if (!m) continue;
      const minutes = (Number(m[1]) % 24) * 60 + Number(m[2]);
      // The bound lives in the profile's own wall-clock; place it where it falls on the config axis.
      out.add(wrapMinute(minutes - diff));
    }
    // A zone-shifted profile's day-of-week gate flips at ITS midnight, which is mid-day here.
    if (diff !== 0) out.add(wrapMinute(-diff));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Every player count at which some gate flips. `playersBelow: 40` means active for 0–39, so the
 * change happens AT 40; `playersAbove: 40` means active from 41, so the change happens at 41.
 */
function playerBounds(profiles: ShiftedProfile[]): number[] {
  const out = new Set<number>([0]);
  for (const { profile: p } of profiles) {
    if (typeof p.spec?.playersBelow === "number") out.add(Math.max(0, p.spec.playersBelow));
    if (typeof p.spec?.playersAbove === "number") out.add(Math.max(0, p.spec.playersAbove + 1));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * First-wins, on the same rules the worker uses, for one exact (day, minute, count) point on the
 * config axis. Each profile is asked at ITS OWN wall-clock — the config-axis point shifted by the
 * profile's offset difference, carrying across midnight into the neighbouring weekday.
 */
function winnerAt(profiles: ShiftedProfile[], dayIndex: number, minute: number, players: number): string | null {
  for (const { profile: p, diff } of profiles) {
    const s = p.spec;
    if (!s) return p.name; // no conditions at all — an unconditional catch-all
    let localMinute = minute + diff;
    let di = dayIndex;
    while (localMinute < 0) { localMinute += 1440; di = (di + 6) % 7; }
    while (localMinute >= 1440) { localMinute -= 1440; di = (di + 1) % 7; }
    const localDay: Weekday = COVERAGE_WEEK[di]!;
    if (s.daysOfWeek?.length && !s.daysOfWeek.map((d) => String(d).toLowerCase()).includes(localDay)) continue;
    if (s.start !== undefined || s.end !== undefined) {
      if (!windowContains(localMinute, s.start ?? "00:00", s.end ?? "00:00")) continue;
    }
    if (!matchesPlayerCount(s, players)) continue;
    return p.name;
  }
  return null;
}

/** Adjacent spans naming the same set are one span. */
function mergeSpans(spans: CoverageSpan[]): CoverageSpan[] {
  const out: CoverageSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && last.profile === s.profile && last.endMinute === s.startMinute) last.endMinute = s.endMinute;
    else out.push({ ...s });
  }
  return out;
}

const sameSpans = (a: CoverageSpan[], b: CoverageSpan[]): boolean =>
  a.length === b.length && a.every((s, i) => s.startMinute === b[i]!.startMinute && s.endMinute === b[i]!.endMinute && s.profile === b[i]!.profile);

/**
 * The full picture: for every weekday, every player band, and every stretch of the day, which set
 * rules — with identical bands and identical days folded together so the answer stays small.
 */
export function describeCoverage(profiles: MapVoteProfile[], configTimezone = "UTC", at: Date = new Date()): CoverageReport {
  const calendarOnly: { name: string; when: string }[] = [];
  const weekly: ShiftedProfile[] = [];
  const configOffset = tzOffsetMin(configTimezone, at);
  for (const p of profiles) {
    const gate = calendarGate(p);
    if (gate) calendarOnly.push({ name: p.name, when: gate });
    // The worker evaluates each profile in `spec.timezone ?? config timezone` (resolveActivePool
    // spreads the fallback under the spec), so a profile without its own zone shifts by nothing.
    else weekly.push({ profile: p, diff: p.spec?.timezone ? tzOffsetMin(p.spec.timezone, at) - configOffset : 0 });
  }

  const times = timeBounds(weekly);
  const counts = playerBounds(weekly);
  let hasGaps = false;

  const perDay = COVERAGE_WEEK.map((day, dayIndex) => {
    const bands: CoverageBand[] = [];
    for (let ci = 0; ci < counts.length; ci++) {
      const minPlayers = counts[ci]!;
      const maxPlayers = ci + 1 < counts.length ? counts[ci + 1]! : null;
      const spans = mergeSpans(times.map((start, ti) => {
        const end = ti + 1 < times.length ? times[ti + 1]! : 1440;
        const profile = winnerAt(weekly, dayIndex, start, minPlayers);
        if (profile === null) hasGaps = true;
        return { startMinute: start, endMinute: end, profile };
      }));
      // A band that divides the day exactly like the one below it is not a distinct band.
      const prev = bands[bands.length - 1];
      if (prev && sameSpans(prev.spans, spans)) prev.maxPlayers = maxPlayers;
      else bands.push({ minPlayers, maxPlayers, spans });
    }
    return { day, bands };
  });

  // Days that divide up identically are one line, so a schedule with no day rules reads "every day".
  const groups: CoverageGroup[] = [];
  for (const { day, bands } of perDay) {
    const last = groups[groups.length - 1];
    const same = last && last.bands.length === bands.length
      && last.bands.every((b, i) => b.minPlayers === bands[i]!.minPlayers && b.maxPlayers === bands[i]!.maxPlayers && sameSpans(b.spans, bands[i]!.spans));
    if (same) last!.days.push(day);
    else groups.push({ days: [day], bands });
  }

  return { groups, calendarOnly, hasGaps };
}
