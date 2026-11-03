/**
 * Weapon → class resolution. Kill and death breakdowns on a player profile group weapons into
 * buckets (rifle, SMG, armor, artillery, …), and which weapon belongs where is game knowledge, so
 * the buckets come from the game descriptor rather than being hardcoded anywhere in core or the
 * panel. Pure and dependency-free so it can run on either side of the API boundary.
 */
import type { GameDescriptor, GameWeaponClass } from "./types.js";

/** The bucket everything unmatched lands in — always present so a breakdown never drops kills. */
export const OTHER_WEAPON_CLASS: GameWeaponClass = { id: "other", label: "Other", patterns: [] };

/**
 * Classify one weapon string. Matching is case-insensitive substring, in descriptor order, first
 * match wins — see the ordering note on HLL's `weaponClasses`. A missing/blank weapon, or a game
 * with no classes declared, resolves to "Other" rather than throwing.
 */
export function classifyWeapon(descriptor: GameDescriptor | null | undefined, weapon: string | null | undefined): GameWeaponClass {
  const classes = descriptor?.weaponClasses;
  if (!classes?.length || !weapon) return OTHER_WEAPON_CLASS;
  const hay = weapon.toUpperCase();
  return classes.find((c) => c.patterns.some((p) => hay.includes(p.toUpperCase()))) ?? OTHER_WEAPON_CLASS;
}

/** The declared classes plus "Other", for callers that render a fixed set of buckets. */
export function weaponClassesOf(descriptor: GameDescriptor | null | undefined): GameWeaponClass[] {
  return [...(descriptor?.weaponClasses ?? []), OTHER_WEAPON_CLASS];
}
