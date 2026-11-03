/**
 * Profiles: an ordered list of named specs, of which the FIRST whose conditions hold is active. A
 * spec combines a time window (window.ts) with an optional player-count condition. Order matters —
 * put the specific profiles first and a conditionless default last, exactly like the map-vote config.
 */
import { isWindowActive, type ScheduleWindow } from "./window.js";

export interface PlayerCountCondition {
  /** active only while the live player count is strictly below this. */
  playersBelow?: number;
  /** active only while the live player count is strictly above this. */
  playersAbove?: number;
}

/**
 * Per-side conditions, for profiles that should react to how the teams look rather than only how
 * full the server is: "axis short-handed", "teams lopsided by 15+", "both sides above 30".
 * Same strictness rules as the player count: below/above are strict, and a condition present with
 * the value unknown never matches — we won't guess.
 */
export interface TeamCountCondition {
  alliedBelow?: number;
  alliedAbove?: number;
  axisBelow?: number;
  axisAbove?: number;
  /** absolute difference between the two sides' headcounts. */
  teamDiffBelow?: number;
  teamDiffAbove?: number;
}

/**
 * How long the current match has been running, in minutes. "At least" is inclusive and "below" is
 * strict, so `{ matchMinutesAtLeast: 30, matchMinutesBelow: 60 }` is the half hour from minute 30
 * to minute 60 with no overlap into the next band. Unknown (no open match) never matches.
 */
export interface MatchTimeCondition {
  matchMinutesAtLeast?: number;
  matchMinutesBelow?: number;
}

/** A full activation spec: when (window) + how busy (player count) + how the teams look + how far
 *  into the match. */
export interface ScheduleSpec extends ScheduleWindow, PlayerCountCondition, TeamCountCondition, MatchTimeCondition {}

export interface ScheduleContext {
  /** live player count, if known. A spec with a player-count condition never matches when unknown. */
  playerCount?: number | null;
  /** live per-side headcounts, if known. Conditions on them never match when unknown. */
  alliedCount?: number | null;
  axisCount?: number | null;
  /** minutes since the current match started, if known. Match-time conditions never match when unknown. */
  matchMinutes?: number | null;
}

/** True if the player-count condition holds. Absent condition = always true; unknown count with a
 *  condition present = false (we won't guess). */
export function matchesPlayerCount(cond: PlayerCountCondition, count: number | null | undefined): boolean {
  const hasBelow = cond.playersBelow !== undefined;
  const hasAbove = cond.playersAbove !== undefined;
  if (!hasBelow && !hasAbove) return true;
  if (count === null || count === undefined) return false;
  if (hasBelow && !(count < (cond.playersBelow as number))) return false;
  if (hasAbove && !(count > (cond.playersAbove as number))) return false;
  return true;
}

/** One bound pair against one value, with the shared rules: absent = true, unknown value = false. */
function inBounds(value: number | null | undefined, below?: number, above?: number): boolean {
  if (below === undefined && above === undefined) return true;
  if (value === null || value === undefined) return false;
  if (below !== undefined && !(value < below)) return false;
  if (above !== undefined && !(value > above)) return false;
  return true;
}

/** True if the per-side conditions hold. The diff needs BOTH sides known — a diff against an
 *  unknown side would be a guess wearing a number. */
export function matchesTeamCounts(cond: TeamCountCondition, allied: number | null | undefined, axis: number | null | undefined): boolean {
  if (!inBounds(allied, cond.alliedBelow, cond.alliedAbove)) return false;
  if (!inBounds(axis, cond.axisBelow, cond.axisAbove)) return false;
  const wantsDiff = cond.teamDiffBelow !== undefined || cond.teamDiffAbove !== undefined;
  if (wantsDiff) {
    if (allied === null || allied === undefined || axis === null || axis === undefined) return false;
    if (!inBounds(Math.abs(allied - axis), cond.teamDiffBelow, cond.teamDiffAbove)) return false;
  }
  return true;
}

/** True if the match-time condition holds. Absent = true; unknown elapsed time with one present = false. */
export function matchesMatchTime(cond: MatchTimeCondition, minutes: number | null | undefined): boolean {
  const hasFrom = cond.matchMinutesAtLeast !== undefined;
  const hasBelow = cond.matchMinutesBelow !== undefined;
  if (!hasFrom && !hasBelow) return true;
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return false;
  if (hasFrom && !(minutes >= (cond.matchMinutesAtLeast as number))) return false;
  if (hasBelow && !(minutes < (cond.matchMinutesBelow as number))) return false;
  return true;
}

/** True if a spec is active at `now` given the context. */
export function isActive(spec: ScheduleSpec, now: Date, ctx: ScheduleContext = {}): boolean {
  return isWindowActive(spec, now)
    && matchesPlayerCount(spec, ctx.playerCount ?? null)
    && matchesTeamCounts(spec, ctx.alliedCount ?? null, ctx.axisCount ?? null)
    && matchesMatchTime(spec, ctx.matchMinutes ?? null);
}

/** A named profile with an optional spec. A profile with no `spec` is an unconditional default. */
export interface Profile {
  name: string;
  spec?: ScheduleSpec;
}

/** The first profile whose spec is active (order = priority). Returns null if none match. */
export function resolveProfile<T extends Profile>(profiles: T[], now: Date, ctx: ScheduleContext = {}): T | null {
  for (const p of profiles) {
    if (!p.spec) return p; // unconditional default
    if (isActive(p.spec, now, ctx)) return p;
  }
  return null;
}

/** Past this, an "open" match is a stale row (a missed match end), not a match still running. */
export const MATCH_MINUTES_CEILING = 6 * 60;

/**
 * Minutes since a match started, from the open match's start time; null when there is no open
 * match, the time is unreadable, it is in the future, or it is so old the row must be stale —
 * a match-time condition then simply doesn't match, rather than matching on a guess.
 */
/**
 * A rule's match-time window ("only from 5 minutes in", "only in the first 10 minutes"): open at
 * `matchMinutes` when at least `min` (0 = from the start) and under `max` (0 = to the end). With
 * either bound set, an unknown match clock (null) is CLOSED — a guess must not open a window.
 */
export function matchWindowOpen(min: number, max: number, matchMinutes: number | null): boolean {
  if (!(min > 0) && !(max > 0)) return true;
  if (matchMinutes === null) return false;
  if (min > 0 && matchMinutes < min) return false;
  if (max > 0 && matchMinutes >= max) return false;
  return true;
}

export function matchMinutesSince(startedAt: string | null | undefined, nowMs: number): number | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t) || t > nowMs) return null;
  const min = (nowMs - t) / 60_000;
  return min > MATCH_MINUTES_CEILING ? null : min;
}
