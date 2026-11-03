/**
 * The economy's pure half: claim periods, refs and rolls. No I/O — the interesting rules live
 * here so they are testable without a store, and the routes/Discord handlers stay plumbing.
 *
 * A claim is "once per calendar period", not "once per rolling N hours": the period is spelled
 * into the ledger ref, and the ledger's unique ref index is what enforces it. That means there is
 * no cooldown row to keep in sync and no race two requests can win together — the second insert
 * simply finds the ref taken, at the only layer that can promise it.
 *
 * The calendar is the COMMUNITY's (app_config.timezone), not UTC. Which day it is depends on where
 * you are standing, and the people pressing the button are all standing in the same place.
 */
import type { EconomyClaim } from "@app/db";
import { safeTimezone, PERMANENT_KV_PREFIX } from "@app/db";
import { zonedParts } from "@app/schedule";

export type ClaimKind = "daily" | "monthly";

/** The calendar period a claim belongs to IN `tz`: "2026-08-12" for daily, "2026-08" for monthly. */
export function claimPeriod(kind: ClaimKind, now: Date = new Date(), tz = "UTC"): string {
  // The community's calendar day, not the world's. A daily claim that resets at UTC midnight
  // resets at 8pm for a community on the American east coast — in the middle of prime time, which
  // is the wrong end of the evening for "come back tomorrow".
  const p = zonedParts(now, safeTimezone(tz));
  const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return kind === "daily" ? day : day.slice(0, 7);
}

/** The at-most-once ledger ref for this member's claim in this period. */
export function claimRef(kind: ClaimKind, discordId: string, now: Date = new Date(), tz = "UTC"): string {
  return `claim:${kind}:${discordId}:${claimPeriod(kind, now, tz)}`;
}

/** Prefix matching every period's ref for this member+kind — what "last claimed" derives from. */
export function claimPrefix(kind: ClaimKind, discordId: string): string {
  return `claim:${kind}:${discordId}:`;
}

/**
 * When the next period opens, as an instant — what "come back tomorrow" renders from.
 *
 * Found by walking forward until the PERIOD STRING changes rather than by arithmetic on a
 * calendar, because the arithmetic is where zones go wrong: a day is not always 24 hours (it is 23
 * or 25 across a DST change), and "the 1st of next month" is a different instant in every zone.
 * Stepping an hour at a time and asking the same function the claim itself asks cannot disagree
 * with it, then a minute-level pass finds the exact boundary.
 */
export function nextClaimAt(kind: ClaimKind, now: Date = new Date(), tz = "UTC"): string {
  const zone = safeTimezone(tz);
  // Truncate to the minute first: period boundaries fall on one, so every candidate instant we
  // return should too — otherwise "next claim" carries whatever seconds the press happened on.
  const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const current = claimPeriod(kind, start, zone);
  const limit = kind === "daily" ? 26 : 32 * 24; // a day + slack, or a long month + slack

  // Coarse pass: the first hour that is already in the NEXT period. `floor` stays one hour behind
  // it, so the boundary is somewhere in the 60 minutes between them.
  let floorHour = start;
  for (let i = 1; i <= limit; i++) {
    const step = new Date(start.getTime() + i * 3_600_000);
    if (claimPeriod(kind, step, zone) !== current) break;
    floorHour = step;
  }
  // Fine pass: the first minute after `floor` that has turned over is the boundary itself.
  for (let m = 1; m <= 60; m++) {
    const step = new Date(floorHour.getTime() + m * 60_000);
    if (claimPeriod(kind, step, zone) !== current) return step.toISOString();
  }
  return new Date(floorHour.getTime() + 3_600_000).toISOString();
}

/**
 * One calendar month after `iso`, clamped to the month's length (Jan 31 → Feb 28/29).
 *
 * Deliberately not "30 days": twelve 30-day waits fit inside a year with five days to spare, so a
 * flat window quietly hands out a thirteenth monthly claim every few years. A month is a month.
 */
export function plusOneMonth(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).getUTCDate();
  return new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(day, lastDayOfTarget),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  )).toISOString();
}

/** What a press would do right now: the ref it would write, whether it is open, and when it opens. */
export interface ClaimWindow {
  ref: string;
  ready: boolean;
  /** When it next opens. Null only when it is open now. */
  nextAt: string | null;
}

/**
 * Whether this member may claim, and under which ref — the ONE place the two kinds differ.
 *
 * DAILY is a shared calendar day. Everyone's resets together at midnight in the community's zone,
 * which is what "the daily" means to the people pressing it, and a member who claims at 23:58 and
 * again at 00:02 has simply caught two days.
 *
 * MONTHLY is a per-member cooldown, and must be: a shared calendar month is exploitable by anybody
 * who reads a calendar. Boost on the 30th, claim the month that is nearly over, wait two days for
 * the rollover, claim again — two payouts for one month of boosting, repeatable every time. So the
 * clock starts when THEY last claimed, and a month has to pass before it starts again, whoever else
 * claimed when.
 *
 * The ref stays deterministic in both cases, because that is what makes this race-proof: two
 * simultaneous presses compute the SAME ref and the ledger's unique index refuses the second. For
 * monthly the ref names the claim it follows (`after<ms>`), so it advances only when a claim lands.
 */
export function claimWindow(
  kind: ClaimKind, discordId: string, lastClaimAt: string | null, now: Date = new Date(), tz = "UTC",
): ClaimWindow {
  if (kind === "daily") {
    const period = claimPeriod("daily", now, tz);
    const ready = !lastClaimAt || claimPeriod("daily", new Date(lastClaimAt), tz) !== period;
    return { ref: `claim:daily:${discordId}:${period}`, ready, nextAt: ready ? null : nextClaimAt("daily", now, tz) };
  }
  // Anchored on the last claim's instant, so the ref is stable for as long as the claim is closed
  // and changes exactly once when a new one lands. Never claimed = `after0`.
  const ref = `claim:monthly:${discordId}:after${lastClaimAt ? Date.parse(lastClaimAt) : 0}`;
  if (!lastClaimAt) return { ref, ready: true, nextAt: null };
  const opensAt = plusOneMonth(lastClaimAt);
  const ready = now.getTime() >= Date.parse(opensAt);
  return { ref, ready, nextAt: ready ? null : opensAt };
}

/**
 * Roll a claim amount: a whole number in [min, max]. Bands are normalized rather than trusted —
 * an inverted band from a hand-edited config pays the smaller number, it does not throw at the
 * one person who pressed the button.
 */
export function rollClaim(claim: Pick<EconomyClaim, "min" | "max">, rng: () => number = Math.random): number {
  const lo = Math.max(0, Math.trunc(Math.min(claim.min, claim.max)));
  const hi = Math.max(0, Math.trunc(Math.max(claim.min, claim.max)));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * The registration flow's key-value namespace — one constant, because the welcome marker is
 * written by the Discord flow and read by the bot-database import, and the two lived in separate
 * files each declaring their own copy with a comment asking the next reader to keep them equal.
 */
export const REGISTRATION_KV_NS = "vip-registration";

/**
 * The marker recording that this member's registration VIP-DAYS bonus has been paid.
 *
 * `keep:`-prefixed on purpose (see PERMANENT_KV_PREFIX): this row has no expiry and no repair
 * path, and it is the only thing standing between a member and a second helping of welcome VIP.
 * plugin_kv is otherwise scratch and is aged out by write time, so without the prefix a routine
 * data trim quietly re-armed the payout months after the fact.
 *
 * The POINTS half of the same bonus needs no marker: it rides the economy ledger's unique ref,
 * which is never trimmed.
 */
export function dayBonusKey(scope: string): string {
  return `${PERMANENT_KV_PREFIX}daysBonus:${scope}`;
}
