/**
 * Read a number out of a form field where BLANK must mean "the default", not zero.
 *
 * A cleared `<input type="number">` hands back `""`, not `undefined`. So the usual
 * `Number(f.field ?? fallback)` never reaches its fallback — `??` only fires on null/undefined —
 * and `Number("")` is 0. Wherever 0 is rejected by the API that surfaces as a validation error,
 * which is survivable. Wherever 0 is a LEGAL value it is worse than that: the field silently
 * saves something the staff member never chose.
 *
 * Crash VIP's cooldown is exactly that case — 0 means "no limit", the one setting that lets a
 * player farm the grant — so an empty box has to fall back to the default instead of disabling
 * the protection.
 */
export function numberOr(value: unknown, fallback: number): number {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * What a number box should SHOW for what was typed: leading zeros dropped ("012" → "12", "00" →
 * "0"), everything else as typed. A controlled number input left to itself keeps "012" on screen
 * — the browser reads it as 12, which equals the state, so nothing ever rewrites the text.
 */
export function stripLeadingZeros(raw: string): string {
  return raw.replace(/^(-?)0+(?=\d)/, "$1");
}
