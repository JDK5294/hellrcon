/**
 * A rule's VIP time and cooldown, which the API stores in MINUTES but staff think of in whatever
 * unit fits: a crash VIP is "10 minutes", the no-VIP trigger's grant is "3 days", its cooldown
 * "30 days". The editor shows a number and a unit; saving multiplies back to minutes.
 */
export type VipUnit = "minutes" | "hours" | "days";

export const VIP_UNIT_MINUTES: Record<VipUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** The API's ceiling for both fields: a year. */
export const VIP_SPAN_MAX_MINUTES = 365 * 1440;

/** Stored minutes → the largest unit that shows them exactly (90 → 90 minutes, 4320 → 3 days). */
export function splitMinutes(min: number): { value: number; unit: VipUnit } {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m > 0 && m % 1440 === 0) return { value: m / 1440, unit: "days" };
  if (m > 0 && m % 60 === 0) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}

/** A typed number in a unit → whole minutes. Blank/NaN stays NaN so the form's default-on-blank
 *  rule (lib/formNumber) still applies to it. */
export function joinMinutes(value: number | string, unit: VipUnit): number {
  if (value === "" || value === null || value === undefined) return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * VIP_UNIT_MINUTES[unit]) : NaN;
}

/** "90" → "1h 30m", "4320" → "3 days". For the rule's read-back sentence. */
export function describeMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  if (min % 1440 === 0) { const d = min / 1440; return `${d} day${d === 1 ? "" : "s"}`; }
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? "" : "s"}`;
}

/** A span in milliseconds as staff say it — a group perk's frozen balance: "13 days", "1.5 days",
 *  "5 hours", "20 minutes", "none". */
export function describeSpanMs(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min <= 0) return "none";
  if (min >= 1440) return min % 1440 === 0 ? `${min / 1440} day${min === 1440 ? "" : "s"}` : `${(min / 1440).toFixed(1)} days`;
  if (min >= 60) { const h = Math.round(min / 60); return `${h} hour${h === 1 ? "" : "s"}`; }
  return `${min} minute${min === 1 ? "" : "s"}`;
}
