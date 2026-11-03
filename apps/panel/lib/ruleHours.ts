/**
 * Which "Ban hours" field the rule editor shows, and what the save sends.
 *
 * One rule-level `hours` serves EVERY step of a rule — the base action and each rung of the
 * escalation ladder read the same number (a tempban's length; a full ban's, where typed hours
 * make it temporary and blank keeps it permanent). Extracted pure because the editor once decided
 * this inline and got a case wrong: with a ladder like "message, then ban" it never offered the
 * hours field at all, so every ladder ban was silently permanent with no way to set removal hours.
 *
 *  - "required": some step is a tempban. The API refuses a tempban with no length (Duration 0 on
 *    the wire is a ban that holds nobody), so the editor shows a defaulted, required field.
 *  - "optional": no tempban step, but some step — first action OR ladder rung — places a full
 *    ban. Typed hours make it a temp removal; blank keeps it permanent.
 *  - "none": no step bans. Hours mean nothing and save as null.
 *
 * A `blacklist` FIRST action keeps the optional reading even when its ladder tempbans — its blank
 * stays meaningful (permanent first ban), and if the tempban rung is then saved without hours the
 * API's refusal names exactly what to fill in.
 */
export type BanHoursMode = "required" | "optional" | "none";

export function banHoursMode(action: string | undefined, escalateActions: readonly string[] | undefined): BanHoursMode {
  const ladder = escalateActions ?? [];
  if (action === "tempban" || (action !== "blacklist" && ladder.includes("tempban"))) return "required";
  if (action === "blacklist" || ladder.includes("blacklist")) return "optional";
  return "none";
}

/** The `hours` the save body carries, per the mode above. Accepts the raw form value (inputs
 *  hand back strings); a cleared required field saves as 0 so the API's refusal — not a silent
 *  default — tells the author the tempban needs a length. */
export function ruleHoursForSave(action: string | undefined, escalateActions: readonly string[] | undefined, hours: number | string | null | undefined): number | null {
  const mode = banHoursMode(action, escalateActions);
  if (mode === "required") return Number(hours ?? 2);
  if (mode === "optional") return hours ? Number(hours) : null;
  return null;
}
