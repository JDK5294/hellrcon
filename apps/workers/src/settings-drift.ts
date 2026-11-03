/**
 * Settings drift — the comparison that lets the auto-settings runner HOLD a profile's settings
 * instead of merely setting them once.
 *
 * The runner applies a profile's settings on the edge (the active profile CHANGED) and then
 * trusts the server to keep them. Game servers do not return the favour: a patch or restore
 * resets settings to defaults, and because the profile has not changed, the runner never speaks
 * again — the operator re-enters their base settings by hand and wonders what the automation is
 * for. This module is the pure half of the fix: given what the profile WANTS and what the server
 * currently REPORTS, say exactly which fields drifted. The runner re-writes those and only those.
 *
 * Only READABLE fields participate. A field the descriptor gives no `read` for (welcome message,
 * VIP slots) cannot be compared, so it stays edge-only — claiming drift on a value we cannot see
 * would mean rewriting every write-only field every tick, which is noise at best and a broadcast
 * spammer at worst. Same for a field the server did not answer (absent from `current`): "couldn't
 * read" is never "drifted" — the same evidence rule as the reconcilers.
 *
 * Comparison is by the field's declared KIND, not by string equality: the wire returns booleans
 * where profiles store "on", numbers where profiles store "90", and a naive === would report
 * eternal drift and rewrite the same value every thirty seconds forever.
 */
import type { GameConfigField } from "@app/games";

/** Pull a scalar out of a getter's answer: `{ key: value }`, or the value itself if primitive.
 *  (The API's config editor has the same logic; the worker cannot import from an app.) */
export function extractSettingValue(result: unknown, key: string): unknown {
  if (result && typeof result === "object" && key in (result as Record<string, unknown>)) return (result as Record<string, unknown>)[key];
  // The same key in another case ("Enable" for "enable"), as the API's reader accepts: a profile
  // holding a field whose getter answers in the other case would otherwise never read it back.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const hit = Object.keys(result as Record<string, unknown>).find((k) => k.toLowerCase() === key.toLowerCase());
    if (hit !== undefined) return (result as Record<string, unknown>)[hit];
  }
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "string") return result;
  return undefined;
}

/** The same boolean vocabulary the command tables accept ("on"/"true"/"1"/1/true). */
const truthy = (v: unknown): boolean => v === true || v === "true" || v === "on" || v === "1" || Number(v) === 1;

export interface SettingDrift {
  field: string;
  want: string | number | boolean;
  have: unknown;
}

export function settingsDrift(
  fields: Map<string, GameConfigField>,
  desired: Record<string, string | number | boolean>,
  current: Record<string, unknown>,
): SettingDrift[] {
  const out: SettingDrift[] = [];
  for (const [field, want] of Object.entries(desired)) {
    const spec = fields.get(field);
    if (!spec?.read || !spec.write) continue; // write-only or unknown: edge-only, never "drifted"
    if (!(field in current)) continue; // the server did not answer — no evidence, no drift
    const have = current[field];
    if (have === null || have === undefined) continue;
    // A numeric field whose answer does not parse is an answer we cannot READ, not a wrong
    // value — same rule as an absent one. Claiming drift here would rewrite forever against a
    // server whose build answers in a shape we don't know.
    if (spec.kind === "num" && !Number.isFinite(Number(have))) continue;
    const same =
      spec.kind === "bool" ? truthy(want) === truthy(have)
      : spec.kind === "num" ? Number(want) === Number(have)
      : String(want).trim() === String(have).trim();
    if (!same) out.push({ field, want, have });
  }
  return out;
}

/** Stable identity for a drift set, so a PERSISTENT drift (a value the server clamps, a dry-run
 *  finding) is audited once rather than every tick — same convention as the reconcilers. */
export function driftSignature(drift: SettingDrift[]): string {
  return drift.map((d) => `${d.field}:${String(d.want)}<-${String(d.have)}`).sort().join(",");
}

/**
 * The profile's settings that can be WRITTEN but never read back (welcome message, VIP slots,
 * max queue). Drift on them is unknowable, so `settingsDrift` excludes them — but when it catches
 * a wipe on the READABLE fields, that is the best evidence available that the write-only ones
 * were reset too, and the runner re-teaches them in the same pass. Keys that are not game fields
 * at all (preset:/app: entries) never appear in the descriptor map, so they fall out naturally.
 */
export function writeOnlySettings(
  fields: Map<string, GameConfigField>,
  desired: Record<string, string | number | boolean>,
): { field: string; want: string | number | boolean }[] {
  return Object.entries(desired)
    .filter(([field]) => { const s = fields.get(field); return Boolean(s?.write) && !s?.read; })
    .map(([field, want]) => ({ field, want }));
}
