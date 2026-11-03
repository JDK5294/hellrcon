import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSeedingAnnounce, seedActionSummary, seedingRestrictions, RESTRICTED_SEED_RULES } from "../src/seeding-message.ts";
import { SEEDING_DEFAULTS } from "../src/types.ts";

const LABELS = {
  role: (r: number) => ({ 13: "Commander", 10: "Sniper" }[r] ?? `role ${r}`),
  weaponClass: (id: string) => ({ artillery: "Artillery", armor: "Armor" }[id] ?? id),
};
const cfg = (over: Partial<typeof SEEDING_DEFAULTS> = {}) => ({ ...SEEDING_DEFAULTS, ...over });

test("the restrictions are appended under the message, in the words a player reads", () => {
  const out = composeSeedingAnnounce(cfg({
    announceMessage: "We are seeding — special rules apply!",
    disallowedRoles: [13, 10],
    disallowedWeaponClasses: ["artillery"],
    disallowedWeaponNames: ["MG42"],
    disallowedCommanderAbilities: ["BOMBING RUN"],
  }), LABELS);
  assert.equal(out, [
    "We are seeding — special rules apply!",
    "",
    "Not allowed while seeding:",
    "Roles: Commander, Sniper",       // labels, never the raw role numbers
    "Weapons: Artillery, MG42",       // the family label and the individually picked gun, one list
    "Commander abilities: BOMBING RUN",
  ].join("\n"));
});

test("only the lines that have content appear, and free-text extras are listed too", () => {
  const out = composeSeedingAnnounce(cfg({
    announceMessage: "Seeding!",
    disallowedWeapons: ["150MM"],
  }), LABELS);
  assert.equal(out, "Seeding!\n\nNot allowed while seeding:\nWeapons: 150MM");
});

test("nothing restricted = the message verbatim, with no empty heading", () => {
  assert.equal(composeSeedingAnnounce(cfg({ announceMessage: "Welcome!" }), LABELS), "Welcome!");
  // And a blank message stays blank — the caller reads that as "do not greet anyone".
  assert.equal(composeSeedingAnnounce(cfg({ announceMessage: "   " }), LABELS), "");
});

/*
 * CRCON puts the lists where the admin placed a token (rcon/automods/seeding_rules.py). Those
 * tokens work here too, and when one is present it OWNS the placement — appending as well would
 * print every restriction twice.
 */
test("a placed token is substituted in place, and suppresses the appended block", () => {
  const out = composeSeedingAnnounce(cfg({
    announceMessage: "No {disallowed_weapons} until we hit {seed_target} players. Thanks!",
    disallowedWeaponClasses: ["artillery", "armor"],
    disallowedRoles: [13],
    seedTarget: 40,
  }), LABELS);
  assert.equal(out, "No Artillery, Armor until we hit 40 players. Thanks!");
  assert.ok(!out.includes("Not allowed while seeding"), "the block is not appended as well");
});

test("a token with nothing to list reads as a sentence, and unknown tokens are left alone", () => {
  const out = composeSeedingAnnounce(cfg({
    announceMessage: "Roles blocked: {disallowed_roles}. Ping {admin} for help.",
  }), LABELS);
  assert.equal(out, "Roles blocked: none. Ping {admin} for help.");
});

test("a long list is capped rather than filling the player's screen", () => {
  const names = Array.from({ length: 20 }, (_, i) => `GUN${i + 1}`);
  const out = composeSeedingAnnounce(cfg({ announceMessage: "Seeding!", disallowedWeaponNames: names }), LABELS);
  assert.match(out, /Weapons: GUN1, GUN2, GUN3, GUN4, GUN5, GUN6, GUN7, GUN8 \+12 more$/);
});

test("a family and a weapon of the same name are listed once", () => {
  // Vietnam has both a "Mortar" class and a "MORTAR" weapon; reading the same rule twice looks
  // like a bug to the player.
  const r = seedingRestrictions(
    cfg({ disallowedWeaponClasses: ["mortar"], disallowedWeaponNames: ["MORTAR"] }),
    { ...LABELS, weaponClass: (id) => (id === "mortar" ? "Mortar" : id) },
  );
  assert.deepEqual(r.weapons, ["Mortar"]);
});

test("the cap-fight rule appears in the greeting when enabled — a policy, like the lists", () => {
  const on = composeSeedingAnnounce(cfg({ announceMessage: "Seeding!", capFightEnabled: true }), LABELS);
  assert.equal(on, "Seeding!\n\nNot allowed while seeding:\nAttacking the next point while your team is winning");
  // Off = not promised: the greeting lists only what the server will actually enforce.
  const off = composeSeedingAnnounce(cfg({ announceMessage: "Seeding!" }), LABELS);
  assert.equal(off, "Seeding!");
});

/*
 * The cap-fight line is the operator's to word (capFightNotice) — it was the one line of the
 * greeting staff could not edit, hardcoded while everything around it was a setting. Blank keeps
 * the line out entirely: some communities state this rule in the base greeting text and the list
 * repeating it read as the bot stuttering. Enforcement is not affected by the wording (the
 * planner falls back to a stock violation phrase when this is blank — tested in the workers).
 */
test("the cap-fight greeting line is the operator's words, and blank keeps it out", () => {
  const worded = composeSeedingAnnounce(
    cfg({ announceMessage: "Seeding!", capFightEnabled: true, capFightNotice: "Do NOT push the 4th point" }), LABELS);
  assert.equal(worded, "Seeding!\n\nNot allowed while seeding:\nDo NOT push the 4th point");
  const blank = composeSeedingAnnounce(
    cfg({ announceMessage: "Seeding!", capFightEnabled: true, capFightNotice: "  " }), LABELS);
  assert.equal(blank, "Seeding!", "a blank notice leaves no dangling heading behind");
});

test("containment states itself in the greeting on the cap fight's terms: enabled + worded, or absent", () => {
  const on = composeSeedingAnnounce(cfg({
    announceMessage: "Seeding!", containEnabled: true, containNotice: "Leaving your team's seeding area",
  }), LABELS);
  assert.match(on, /Not allowed while seeding:\nLeaving your team's seeding area/);
  // Blank wording keeps the line out; disabled keeps it out whatever the wording says.
  assert.equal(composeSeedingAnnounce(cfg({ announceMessage: "Seeding!", containEnabled: true, containNotice: " " }), LABELS), "Seeding!");
  assert.equal(composeSeedingAnnounce(cfg({ announceMessage: "Seeding!", containEnabled: false, containNotice: "Stay put" }), LABELS), "Seeding!");
});

test("a seeding action's line names the rule and what the player did — not just \"seeding rule\"", () => {
  const line = (rule: string, detail: string, over: Record<string, unknown> = {}, full = false) =>
    seedActionSummary({ kind: "warn", name: "Bob", rule, detail, step: { n: 1, of: 2 }, ...over }, full);
  assert.equal(line("role", "Tank Commander"), "warn Bob — seeding, disallowed role: Tank Commander (warning 1 of 2)");
  assert.equal(line("weapon", "M1919 BROWNING", { kind: "punish", step: { n: 2, of: 2 } }), "punish Bob — seeding, disallowed weapon: M1919 BROWNING (punish 2 of 2)");
  assert.equal(line("ability", "BOMBING RUN"), "warn Bob — seeding, commander ability: BOMBING RUN (warning 1 of 2)");
  assert.equal(line("capFight", "their team already held 3 caps"), "warn Bob — seeding, cap fight: their team already held 3 caps (warning 1 of 2)");
  assert.equal(line("role", "Tank Commander", { kind: "kick", step: undefined }), "kick Bob — seeding, disallowed role: Tank Commander", "a kick is the end of the ladder, not a step on it");
  assert.equal(line("role", "Tank Commander", { dryRun: true }), "[dry-run] would warn Bob — seeding, disallowed role: Tank Commander (warning 1 of 2)");
});

test("the restricted rules read as a plain seeding rule unless the line is written in full", () => {
  assert.deepEqual([...RESTRICTED_SEED_RULES].sort(), ["pace", "zone"]);
  const at = (rule: string, detail: string, full: boolean, over: Record<string, unknown> = {}) =>
    seedActionSummary({ kind: "warn", name: "Bob", rule, detail, step: { n: 1, of: 2 }, ...over }, full);
  assert.equal(at("zone", "outside their team's drawn area", false), "warn Bob — seeding rule (warning 1 of 2)");
  assert.equal(at("pace", "reached point 4 before it opens at minute 40", false), "warn Bob — seeding rule (warning 1 of 2)");
  assert.equal(at("zone", "outside their team's drawn area", true), "warn Bob — seeding area: outside their team's drawn area (warning 1 of 2)");
  assert.equal(at("pace", "reached point 4 before it opens at minute 40", true), "warn Bob — steamroll protection: reached point 4 before it opens at minute 40 (warning 1 of 2)");
  // Judged by position: the open line is the score half's line, word for word.
  const pos = { byPosition: true };
  assert.equal(at("capFight", "their team already held 3 caps", false, pos), at("capFight", "their team already held 3 caps", false));
  assert.equal(at("capFight", "their team already held 3 caps", true, pos), "warn Bob — seeding, cap fight by position: past the front line, their team already held 3 caps (warning 1 of 2)");
  // Nothing readable: the old line, never a guess.
  assert.equal(seedActionSummary({ kind: "kick", name: "Bob" }), "kick Bob — seeding rule");
  assert.equal(seedActionSummary({ kind: "kick", name: "Bob", rule: "constructor" }, true), "kick Bob — seeding rule");
});
