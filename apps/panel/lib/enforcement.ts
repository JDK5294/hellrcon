/**
 * WHO can kick, punish or warn a player — every source, per family.
 *
 * FOUR systems act on players, and each files its own audit action:
 *   player.*       staff, by hand (the ⋯ menu, the profile, the bulk selection)
 *   seed.*         the seeding automod, while the server fills
 *   autosettings.* the retired auto-settings module runner — HISTORICAL rows only: the packaged
 *                  scenarios (no-solo-tank and friends) became Rules-engine triggers and new
 *                  firings audit under enforcer.*, but years of old entries still read from here
 *   enforcer.*     the Rules tab's own rules — the ones with thresholds, ladders and role gates
 *
 * The Moderation tabs answer one question — "has this player been dealt with?" — and it does not
 * care which of the four did it. The lists lived spelled out inside the tab definitions naming
 * only the first three, so every firing of a Rules-tab rule was invisible in Kicks, Punishments
 * and Warnings: the escalation ladders, the role-gated rules and the admin-camera triggers all
 * acted, audited, and showed up nowhere staff look for them.
 *
 * So the families live here, once, derived from one list of sources — and a test asserts every
 * source appears in every family. A fifth enforcement system cannot be added without either
 * appearing in these tabs or failing that test.
 *
 * Dry-runs are deliberately absent. The seeding and module runners name the KIND they would have
 * used (`seed.kick`), so those land in the right tab already; the enforcer files every dry-run
 * under one `enforcer.dryrun`, which belongs to no single family — a "would have kicked" is not
 * a kick, and a tab called Kicks should not imply one happened.
 */

/** The verb each source files, per family. Sources that spell a verb differently say so here. */
const SOURCES = ["player", "seed", "autosettings", "enforcer"] as const;
export type EnforcementSource = (typeof SOURCES)[number];

/** Family → the verb each source uses for it. The panel's "message" is the automods' "warn". */
const VERBS: Record<"kick" | "punish" | "warn", Record<EnforcementSource, string>> = {
  kick: { player: "kick", seed: "kick", autosettings: "kick", enforcer: "kick" },
  punish: { player: "punish", seed: "punish", autosettings: "punish", enforcer: "punish" },
  // A warning is a message to one player: staff and the enforcer send a `message`, the two
  // automods call the same thing a `warn`.
  warn: { player: "message", seed: "warn", autosettings: "warn", enforcer: "message" },
};

const family = (f: "kick" | "punish" | "warn"): string[] => SOURCES.map((s) => `${s}.${VERBS[f][s]}`);

/** Every audit action that means "this player was kicked", whoever did it. */
export const KICK_ACTIONS = family("kick");
/** Every audit action that means "this player was punished". */
export const PUNISH_ACTIONS = family("punish");
/** Every audit action that means "this player was warned/messaged". */
export const WARN_ACTIONS = family("warn");

/** Exported for the test that keeps the lists honest as sources are added. */
export const ENFORCEMENT_SOURCES = SOURCES;
