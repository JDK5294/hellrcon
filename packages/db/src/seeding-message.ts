/**
 * THE SEEDING ANNOUNCEMENT — the greeting a player gets on joining a server that is filling, with
 * the rules that are actually in force spelled out under it.
 *
 * Why this is composed rather than typed: the announcement and the enforcement are the same
 * policy, and when a human maintains both by hand they drift. Someone bans armour in the picker
 * and forgets the greeting still says "no artillery", and the first a player hears of the real
 * rule is the punish. The lists below are read from the config that does the punishing, so the
 * message cannot describe a policy the server is not enforcing.
 *
 * CRCON does the same job with `{disallowed_roles}` / `{disallowed_weapons}` tokens the admin
 * places in their template (rcon/automods/seeding_rules.py, v12.1.1). Those tokens work here too —
 * an admin who wants the lists mid-sentence writes them and they are substituted in place. The
 * difference is the default: with no tokens present the lists are APPENDED under the message,
 * because "restrictions are listed automatically" should not depend on remembering a token.
 *
 * Lives in @app/db, beside the config row it reads, because both the worker (which sends the
 * message) and the API (which shows the admin a preview of it) must produce the same text — the
 * same reason presetGameMismatch lives here rather than in one of its two callers.
 */
import type { SeedingConfigRow } from "./types.js";

/** How to render the ids a seeding config stores. Both come from the game descriptor. */
export interface SeedingLabels {
  /** descriptor role number → label ("Commander"). */
  role: (role: number) => string;
  /** weapon-class id → label ("artillery" → "Artillery"). */
  weaponClass: (id: string) => string;
}

/**
 * A restriction line lists at most this many items before summarising the rest. An admin who bans
 * forty individual weapons would otherwise generate a wall of text in a message box the player has
 * to dismiss — and the fortieth entry teaches nobody anything the first eight didn't.
 */
const MAX_ITEMS_PER_LINE = 8;

function joinCapped(items: string[]): string {
  if (items.length <= MAX_ITEMS_PER_LINE) return items.join(", ");
  const shown = items.slice(0, MAX_ITEMS_PER_LINE);
  return `${shown.join(", ")} +${items.length - shown.length} more`;
}

/**
 * The three restriction lists a seeding config expresses, already rendered for a player to read.
 * Weapons fold three storage shapes into one list, because a player does not care which picker
 * produced a rule: whole families, individually picked weapons, and the free-text extras.
 */
export function seedingRestrictions(
  config: Pick<SeedingConfigRow, "disallowedRoles" | "disallowedWeaponClasses" | "disallowedWeapons" | "disallowedWeaponNames" | "disallowedCommanderAbilities">,
  labels: SeedingLabels,
): { roles: string[]; weapons: string[]; abilities: string[] } {
  const roles = (config.disallowedRoles ?? []).map(labels.role).filter(Boolean);
  const weapons = [
    ...(config.disallowedWeaponClasses ?? []).map(labels.weaponClass).filter(Boolean),
    ...(config.disallowedWeaponNames ?? []),
    ...(config.disallowedWeapons ?? []),
  ];
  const abilities = [...(config.disallowedCommanderAbilities ?? [])];
  // Deduped case-insensitively, keeping first appearance: a class label and a picked name can
  // collide ("Mortar" the family, "MORTAR" the Vietnam weapon), and reading the same restriction
  // twice makes the message look broken.
  const dedupe = (list: string[]) => {
    const seen = new Set<string>();
    return list.filter((x) => {
      const k = x.toUpperCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  return { roles: dedupe(roles), weapons: dedupe(weapons), abilities: dedupe(abilities) };
}

/** The tokens an admin may place to position the lists themselves (CRCON's names, plus ours). */
const LIST_TOKENS = ["disallowed_roles", "disallowed_weapons", "disallowed_commander_abilities"] as const;

/**
 * The message a joining player actually receives: the admin's text, with the restrictions either
 * substituted where they placed a token or appended underneath.
 *
 * Returns the message verbatim when nothing is restricted — a greeting that ends in an empty
 * "Not allowed while seeding:" heading reads like a bug, and on a server with no restrictions
 * there is genuinely nothing to say.
 */
export function composeSeedingAnnounce(
  config: Pick<SeedingConfigRow, "announceMessage" | "seedTarget" | "disallowedRoles" | "disallowedWeaponClasses" | "disallowedWeapons" | "disallowedWeaponNames" | "disallowedCommanderAbilities" | "capFightEnabled" | "capFightMaxCaps" | "capFightNotice"> &
    Partial<Pick<SeedingConfigRow, "containEnabled" | "containNotice">>,
  labels: SeedingLabels,
): string {
  const base = (config.announceMessage ?? "").trim();
  if (!base) return "";
  const { roles, weapons, abilities } = seedingRestrictions(config, labels);
  // The cap-fight rule is policy like the lists above, so the greeting must state it too — the
  // player who pushed the 4th point should have been told before the warn, not by it.
  const capFight = config.capFightEnabled === true;

  // Placed tokens win: an admin who wrote one has said where the list belongs. `none` rather than
  // an empty string, so a sentence built around the token still reads as a sentence.
  const placed = LIST_TOKENS.some((t) => base.includes(`{${t}}`));
  if (placed) {
    const vars: Record<string, string> = {
      disallowed_roles: roles.length ? joinCapped(roles) : "none",
      disallowed_weapons: weapons.length ? joinCapped(weapons) : "none",
      disallowed_commander_abilities: abilities.length ? joinCapped(abilities) : "none",
      seed_target: String(config.seedTarget),
    };
    return base.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));
  }

  const lines: string[] = [];
  if (roles.length) lines.push(`Roles: ${joinCapped(roles)}`);
  if (weapons.length) lines.push(`Weapons: ${joinCapped(weapons)}`);
  if (abilities.length) lines.push(`Commander abilities: ${joinCapped(abilities)}`);
  // The operator's own wording (capFightNotice); blank keeps the line out — the rule still
  // enforces, but some communities say this in the base greeting text instead.
  if (capFight) {
    const notice = (config.capFightNotice ?? "").trim();
    if (notice) lines.push(notice);
  }
  // Containment states itself the same way: policy the server enforces belongs in the greeting,
  // in the operator's words, and blank keeps the line out on the same terms as the cap fight.
  if (config.containEnabled === true) {
    const notice = (config.containNotice ?? "").trim();
    if (notice) lines.push(notice);
  }
  if (!lines.length) return base;
  return `${base}\n\nNot allowed while seeding:\n${lines.join("\n")}`;
}

/*
 * WHY A SEEDING ACTION HAPPENED — the line each warn, punish and kick the seeding automod sends
 * files on the trail, as Auto settings → History, Activity and the Kicks, Punishments and Warnings
 * records show it.
 *
 * "kick Bob — seeding rule" could have been any of seven rules, so every action carries which rule
 * it enforced and what the player did, and the line says so in the words of the screen that sets
 * the rule up: "warn Bob — seeding, disallowed role: Tank Commander (warning 1 of 2)".
 *
 * The seeding area and steamroll protection are ground rules, configured on Map zones under the
 * rules permission (admin.moderation), and so is judging the cap fight from where a player stands.
 * The line written to the trail is for anyone who can read the trail, so it keeps those to what
 * anyone may know: the area and pace rules read as a plain "seeding rule", and a cap fight judged
 * by position reads exactly like one judged by score. `full` writes the whole line, for the readers
 * the API has checked hold the permission.
 * Lives here because the worker writes the line and the API rewrites it for those readers.
 */

/** The seeding rules an action can enforce. */
export type SeedRule = "role" | "weapon" | "ability" | "capFight" | "zone" | "pace";

/** The ground rules (configured under the rules permission): what they caught is that permission's to read. */
export const RESTRICTED_SEED_RULES: ReadonlySet<string> = new Set<SeedRule>(["zone", "pace"]);

/** Which rule a seeding action enforced and what the player did — its line's "why". */
export interface SeedActionReason {
  rule: SeedRule;
  /** what, specifically: the role, the weapon, the caps their team held… */
  detail: string;
  /** a cap fight judged from where the player stood rather than their score (a ground rule's detail). */
  byPosition?: boolean;
  /** which step of the ladder a warn or punish was: the nth of the most configured. */
  step?: { n: number; of: number };
}

/** Each rule as its line names it, in the words of its card on the Seeding screens. */
const SEED_RULE_LINE: Record<SeedRule, string> = {
  role: "seeding, disallowed role",
  weapon: "seeding, disallowed weapon",
  ability: "seeding, commander ability",
  capFight: "seeding, cap fight",
  zone: "seeding area",
  // Not "seeding": steamroll protection runs the whole round, not only while the server fills.
  pace: "steamroll protection",
};

/**
 * One seeding action in words. Takes the reason as the trail stores it — loose, since a row read
 * back can hold anything — and says only "seeding rule" for a reason it cannot read.
 */
export function seedActionSummary(
  a: { kind: string; name: string; dryRun?: boolean; rule?: unknown; detail?: unknown; byPosition?: unknown; step?: unknown },
  full = false,
): string {
  const head = `${a.dryRun ? "[dry-run] would " : ""}${a.kind} ${a.name}`;
  const s = (a.step ?? null) as { n?: unknown; of?: unknown } | null;
  const step = s && typeof s.n === "number" && typeof s.of === "number" && s.of > 0
    ? ` (${a.kind === "warn" ? "warning" : a.kind} ${s.n} of ${s.of})`
    : "";
  const rule = typeof a.rule === "string" && Object.hasOwn(SEED_RULE_LINE, a.rule) ? (a.rule as SeedRule) : null;
  if (!rule || (!full && RESTRICTED_SEED_RULES.has(rule))) return `${head} — seeding rule${step}`;
  const detail = typeof a.detail === "string" ? a.detail.trim() : "";
  const positional = full && rule === "capFight" && a.byPosition === true;
  const what = positional ? `past the front line${detail ? `, ${detail}` : ""}` : detail;
  return `${head} — ${SEED_RULE_LINE[rule]}${positional ? " by position" : ""}${what ? `: ${what}` : ""}${step}`;
}
