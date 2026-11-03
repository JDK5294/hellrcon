/**
 * Roster-state triggers for the Rules engine — the player-rule scenarios that used to be
 * standalone "modules" with their own tabs, config rows and escalation machinery. Rules is the one
 * place server rule customization lives, so these are now TRIGGERS a rule can fire on, with the
 * scenario's knobs stored on the rule itself (`rule.params`) and everything else — immunity,
 * escalation, dry-run, alerts, audit — supplied by the enforcer like any other rule.
 *
 * Division of labour: the WORKER (which already reads each server's live roster every tick) runs
 * `detect` for each enabled state rule and emits a synthetic bus event per offending player,
 * carrying the rule's id; the ENFORCER hears it exactly like a log event and fires that one rule.
 * The event kind alone is not enough to match on — two rules on the same kind can carry different
 * params — which is why the rule id travels in the event and the enforcer requires it.
 *
 * `app.weapon.restricted` is the odd one out: a restricted-weapon kill IS an event, so it needs no
 * worker detection — the enforcer judges each kill event against the rule's weapon lists directly
 * (see `restrictedWeaponReason`).
 *
 * Every `detect` is PURE — (players, params, descriptor) → violations — so each scenario is
 * testable without a game server, a worker, or a database.
 */
import type { GameDescriptor } from "@app/games";
import { sectorOf } from "@app/maps";
import type { RuleField, RulePlayer, Violation } from "./contract.js";

export const STATE_KIND_PREFIX = "app.state.";
export const WEAPON_TRIGGER_KIND = "app.weapon.restricted";
export const OUT_OF_ZONE_KIND = "app.state.out_of_zone";
export const NO_VIP_KIND = "app.state.no_vip";
export const PLAYTIME_KIND = "app.state.playtime";
export const NO_DISCORD_KIND = "app.state.no_discord";
export const KILL_RATE_KIND = "app.state.kill_rate";
export const RATIO_KIND = "app.state.ratio";
export const CLAN_TAG_KIND = "app.state.clan_tag";
/** The counts a ratio rule can set against each other — this match's, from the live roster. */
export const RATIO_COUNTS = ["kills", "deaths", "teamkills"] as const;
export type RatioCount = (typeof RATIO_COUNTS)[number];
/** Every ordered pair of two different counts, as stored on the rule ("teamkills:kills"). */
export const RATIO_TYPES: string[] = RATIO_COUNTS.flatMap((a) => RATIO_COUNTS.filter((b) => b !== a).map((b) => `${a}:${b}`));
/** A stored ratio read back as its two counts (null = not one of RATIO_TYPES). */
export function ratioPair(v: unknown): [RatioCount, RatioCount] | null {
  const s = String(v ?? "").toLowerCase().replace(/\s+/g, "");
  if (!RATIO_TYPES.includes(s)) return null;
  const [a, b] = s.split(":");
  return [a as RatioCount, b as RatioCount];
}
/** How many tags one clan tag rule may name — enough for any alliance, short of a pasted dump. */
export const CLAN_TAG_RULE_MAX = 50;

/** The key a playtime rule's hours are annotated under: its scope and its period. */
export function playtimeKey(allServers: boolean, periodDays: number): string {
  return `${allServers ? "all" : "server"}|${Math.max(0, Math.round(periodDays))}`;
}

export const isStateTriggerKind = (kind: string): boolean => kind.startsWith(STATE_KIND_PREFIX);

/** The current map's paint for one zone rule — resolved by the worker from the referenced set. */
export interface ZoneCellSets { allies: Set<string>; axis: Set<string>; shared: Set<string> }

export interface StateDetectContext {
  players: RulePlayer[];
  /** the rule's stored params, already resolved over the trigger's defaults. */
  params: Record<string, unknown>;
  descriptor: GameDescriptor | null;
  /** the zone trigger's map-specific context, absent for every other trigger: THIS rule's zone
   *  set's cells for the map being played (null = the set paints nothing here → nothing to
   *  enforce), and side resolution with the session's headcounts as evidence. */
  zones?: ZoneCellSets | null;
  sideOfTeam?: (team: number) => string | null;
  /**
   * The clan tag trigger's grouping: which main tag a spelling belongs to, and what a main tag
   * saved in a rule reads as today (staff may have combined or split groups since). Supplied by
   * the worker from Players → Clans; absent = could not be read this tick, and the trigger then
   * flags nobody rather than match spellings staff deliberately split apart.
   */
  clans?: { ofTag(tag: string): string; ofKey(key: string): string } | null;
}

export interface StateTriggerDef {
  kind: string;
  label: string;
  blurb: string;
  /** game ids this trigger is meaningful for; empty/absent = any game (descriptor-guarded). */
  games?: string[];
  /** the trigger's own knobs — stored on the rule as `params`, rendered by the rule editor. */
  fields: RuleField[];
  detect(ctx: StateDetectContext): Violation[];
  /**
   * How the roster splits against this trigger, in words staff read on the rule card ("hold VIP":
   * 85, "have no VIP": 2) — the answer to "why isn't it firing". Optional: a trigger without one
   * shows only how many it flagged.
   */
  explain?(ctx: StateDetectContext): Record<string, number>;
}

/** Count players into labelled buckets — the shape every explain() returns. */
function tally(players: RulePlayer[], bucket: (p: RulePlayer) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of players) { const k = bucket(p); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

/** Group a roster by team + squad; players in no squad are skipped (they cannot be a squad). */
function squads(players: RulePlayer[]): RulePlayer[][] {
  const groups = new Map<string, RulePlayer[]>();
  for (const p of players) {
    if (!p.squad) continue;
    const key = `${p.team}|${p.squad}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  return [...groups.values()];
}

/** Under-crewed vehicle squads (solo tank / solo helicopter share this): a squad counts as a
 *  vehicle crew if ANY member is on one of the vehicle roles; fewer members than the minimum
 *  flags them all. */
function underCrewedSquads(players: RulePlayer[], vehicleRoles: Set<number>, minCrew: number, reason: string): Violation[] {
  if (vehicleRoles.size === 0) return [];
  const violations: Violation[] = [];
  for (const members of squads(players)) {
    if (!members.some((m) => vehicleRoles.has(m.role))) continue;
    if (members.length >= minCrew) continue; // properly crewed
    for (const m of members) violations.push({ playerId: m.playerId, name: m.name, reason });
  }
  return violations;
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);
const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : [];

const URL_RE = /(https?:\/\/|discord\.gg\/|www\.|\b\w+\.(com|net|org|gg|io|tv|xyz)\b)/i;

const COUNT_WORDS: Record<RatioCount, [string, string]> = { kills: ["kill", "kills"], deaths: ["death", "deaths"], teamkills: ["team kill", "team kills"] };
const twoPlaces = (n: number): number => Math.round(n * 100) / 100;

/**
 * One ratio rule's judgement of a player, shared by detect and explain so the card's split is the
 * detector's: the bucket staff read, and the violation's sentence when it fires. The ratio is
 * judged to two places, as the limit is kept; a second count of 0 counts as 1.
 */
function ratioJudge(params: Record<string, unknown>): (p: RulePlayer) => { label: string; reason?: string } {
  const pair = ratioPair(params.ratio);
  const below = params.direction === "below";
  const limit = Number(params.limit);
  const minCount = Math.max(1, Number(params.minCount ?? 1));
  // A ratio or a way this build doesn't know, or "at or above 0" (everyone), flags nobody — a rule
  // restored from a file never went through parseTriggerParams.
  if (!pair || (!below && params.direction !== "above") || !(limit >= 0) || (!below && limit === 0)) {
    return () => ({ label: "nothing judged (the ratio or limit can't be used)" });
  }
  const [a, b] = pair;
  const few = `${COUNT_WORDS[a][1]} and ${COUNT_WORDS[b][1]} add up to under ${minCount}`;
  const side = below ? "below" : "above";
  return (p) => {
    const x = p[a], y = p[b];
    if (x == null || y == null) return { label: "counts not reported" };
    if (x + y < minCount) return { label: few };
    const ratio = twoPlaces(x / Math.max(1, y));
    if (below ? ratio > limit : ratio < limit) return { label: "within the limit" };
    return {
      label: `at or ${side} the limit`,
      reason: `${x} ${COUNT_WORDS[a][x === 1 ? 0 : 1]} to ${y} ${COUNT_WORDS[b][y === 1 ? 0 : 1]} — a ratio of ${ratio}, at or ${side} ${limit}`,
    };
  };
}

export const STATE_TRIGGERS: StateTriggerDef[] = [
  {
    kind: "app.state.no_leader",
    label: "Squad has no leader",
    blurb: "Fires on every member of a squad with nobody on a squad-leader role. Which roles lead comes from the game itself.",
    fields: [
      { key: "minSquadSize", label: "Minimum squad size to enforce", type: "int", default: 2, min: 1, help: "Ignore squads smaller than this." },
    ],
    detect({ players, params, descriptor }): Violation[] {
      const leaderRoles = new Set(descriptor?.squadLeaderRoles ?? []);
      // No leader roles defined for this game → nothing this trigger can meaningfully check.
      if (leaderRoles.size === 0) return [];
      // Nor can it check a squad holding a role the descriptor cannot name: that role could be the
      // squad type's own leader. This fires against real players, so it errs toward saying
      // nothing — HLL artillery squads were once warned for having artillery roles.
      const known = descriptor?.roles;
      const namesRoles = known != null && Object.keys(known).length > 0;
      const minSize = Math.max(1, Number(params.minSquadSize ?? 2));
      const squadLabel = descriptor?.squadLabel ?? "squad";
      const violations: Violation[] = [];
      for (const members of squads(players)) {
        if (members.length < minSize) continue;
        if (members.some((m) => leaderRoles.has(m.role))) continue; // has a leader
        if (namesRoles && members.some((m) => m.role != null && known[m.role] == null)) continue;
        for (const m of members) violations.push({ playerId: m.playerId, name: m.name, reason: `your ${squadLabel} has no squad leader` });
      }
      return violations;
    },
  },
  {
    kind: "app.state.low_level",
    label: "Level below minimum",
    blurb: "Fires on players below a minimum level (level 0/unknown is never flagged).",
    fields: [
      { key: "minLevel", label: "Minimum level to play", type: "int", default: 25, min: 1, max: 1000, help: "Players below this are flagged." },
    ],
    detect({ players, params }): Violation[] {
      const min = Math.max(0, Number(params.minLevel ?? 0));
      if (min <= 0) return [];
      return players
        .filter((p) => p.level > 0 && p.level < min)
        .map((p) => ({ playerId: p.playerId, name: p.name, reason: `level ${p.level} is below the minimum of ${min}` }));
    },
  },
  {
    kind: "app.state.role_level",
    label: "Level below minimum (role)",
    blurb: "Fires on players below a minimum level WHILE HOLDING one of the chosen roles — a level floor for armor, command or pilots instead of the whole server. Which roles exist comes from the game itself; level 0/unknown is never flagged.",
    fields: [
      { key: "roles", label: "Roles this floor covers", type: "roles", default: [], help: "Players on any of these roles must meet the level below. The list is the game's own." },
      { key: "minLevel", label: "Minimum level for these roles", type: "int", default: 50, min: 1, max: 1000, help: "Chosen-role players below this are flagged." },
    ],
    detect({ players, params, descriptor }): Violation[] {
      const roles = new Set(nums(params.roles));
      const min = Math.max(0, Number(params.minLevel ?? 0));
      if (roles.size === 0 || min <= 0) return [];
      // The reason names the ROLE, not just the number: "Tank Commander needs level 50" is a
      // sentence the player can act on (drop the role), where the whole-roster trigger's wording
      // would read as "leave the server".
      const roleName = (r: number) => descriptor?.roles?.[r] ?? `role ${r}`;
      return players
        .filter((p) => roles.has(p.role) && p.level > 0 && p.level < min)
        .map((p) => ({ playerId: p.playerId, name: p.name, reason: `${roleName(p.role)} needs level ${min} — you are level ${p.level}` }));
    },
  },
  {
    kind: "app.state.bad_role",
    label: "Restricted role",
    blurb: "Fires on players holding a disallowed role, or (allowlist mode) any role not explicitly allowed.",
    fields: [
      { key: "disallowedRoles", label: "Disallowed roles", type: "roles", default: [], help: "Players on any of these roles are flagged." },
      { key: "allowedRoles", label: "Allowed roles (allowlist)", type: "roles", default: [], help: "Leave empty to allow every role except the disallowed ones. If set, ONLY these roles are permitted." },
    ],
    detect({ players, params, descriptor }): Violation[] {
      const disallowed = new Set(nums(params.disallowedRoles));
      const allowed = new Set(nums(params.allowedRoles));
      const known = descriptor?.roles;
      const namesRoles = known != null && Object.keys(known).length > 0;
      const roleName = (r: number) => known?.[r] ?? `role ${r}`;
      const out: Violation[] = [];
      for (const p of players) {
        // A role we do not know is not a role a player chose. The roster stamps -1 when it has no
        // role for someone (just connected, still in the deploy screen, a sample that omitted it),
        // and an ALLOWLIST would otherwise read "unknown" as "forbidden" and punish them for it —
        // with "role -1 is not allowed here" as the reason. Same caution as the no-leader trigger:
        // against real players, err toward saying nothing. A DENYLIST still fires on any role an
        // admin named by number, known to the descriptor or not.
        const unknownRole = p.role < 0 || (namesRoles && known[p.role] == null);
        const banned = disallowed.has(p.role);
        const notAllowed = allowed.size > 0 && !allowed.has(p.role) && !unknownRole;
        if (banned || notAllowed) out.push({ playerId: p.playerId, name: p.name, reason: `${roleName(p.role)} is not allowed here` });
      }
      return out;
    },
  },
  {
    kind: "app.state.bad_name",
    label: "Name violates the filter",
    blurb: "Fires on players whose name contains a banned word, looks like an advert/URL, or matches a blocked pattern. A player can't rename mid-session, so a ladder ending in kick is the usual pairing.",
    fields: [
      { key: "bannedSubstrings", label: "Banned words", type: "text", default: "", help: "Comma-separated. A name containing any of these (case-insensitive) is flagged." },
      { key: "blockUrls", label: "Block adverts / URLs", type: "bool", default: false, help: "Flag names that look like adverts — http(s)://, www., discord.gg invites, or common domains." },
      { key: "bannedPattern", label: "Blocked pattern (regex)", type: "text", default: "", help: "Advanced: a regular expression; names matching it (case-insensitive) are flagged. Leave blank if unsure." },
    ],
    detect({ players, params }): Violation[] {
      const subs = listOf(params.bannedSubstrings).map((s) => s.toLowerCase()).filter(Boolean);
      const blockUrls = params.blockUrls === true;
      const pattern = typeof params.bannedPattern === "string" ? params.bannedPattern.trim() : "";
      let re: RegExp | null = null;
      if (pattern) { try { re = new RegExp(pattern, "i"); } catch { re = null; } } // an invalid regex matches nothing
      const out: Violation[] = [];
      for (const p of players) {
        const name = p.name ?? "";
        const lower = name.toLowerCase();
        let reason = "";
        if (subs.some((s) => lower.includes(s))) reason = "name contains a banned word";
        else if (blockUrls && URL_RE.test(name)) reason = "name looks like an advert/URL";
        else if (re && re.test(name)) reason = "name matches a blocked pattern";
        if (reason) out.push({ playerId: p.playerId, name, reason });
      }
      return out;
    },
  },
  {
    kind: OUT_OF_ZONE_KIND,
    label: "Player outside the allowed area",
    blurb: "Fires on players standing outside the areas a zone set paints for their team (or, inverted, inside forbidden ones) — judged from live positions on the tactical map's own A1–J10 grid. Zone sets are painted per map under Auto settings → Map zones.",
    fields: [
      { key: "zoneSet", label: "Zone set", type: "text", default: "", help: "Which painted set to enforce — created under Map zones." },
      { key: "keepOut", label: "Forbid the painted cells instead", type: "bool", default: false, help: "Off: each team must STAY IN its painted cells (plus shared). On: the painted cells are no-go areas." },
      { key: "exemptRoles", label: "Exempt roles", type: "roles", default: [], help: "Players on these roles may roam anywhere (e.g. the commander, recon)." },
    ],
    detect({ players, params, zones, sideOfTeam }): Violation[] {
      // No paint for the map being played = nothing to enforce there. The worker resolves the
      // set → this map's cells before calling; a missing/foreign set also lands here as null.
      if (!zones) return [];
      const keepOut = params.keepOut === true;
      const exempt = new Set(nums(params.exemptRoles));
      const out: Violation[] = [];
      for (const p of players) {
        // Deploy screen / no position this tick: not standing anywhere, so not standing wrong.
        if (!p.pos) continue;
        if (exempt.has(p.role)) continue;
        const side = sideOfTeam?.(p.team) ?? null;
        // A side we cannot resolve cannot be judged against per-side paint — err toward silence,
        // the same caution every roster trigger applies to unknowns.
        if (side !== "allies" && side !== "axis") continue;
        const own = side === "allies" ? zones.allies : zones.axis;
        const cell = sectorOf(p.pos.x, p.pos.y);
        if (keepOut) {
          if (own.has(cell) || zones.shared.has(cell)) {
            out.push({ playerId: p.playerId, name: p.name, reason: `in a restricted area (${cell})` });
          }
        } else {
          // A team with NO cells of its own on this map is unrestricted there — the same reading
          // the seeding containment gives an empty side. Shared cells widen a restricted team's
          // ground; they never create a restriction by themselves.
          if (own.size === 0) continue;
          if (!own.has(cell) && !zones.shared.has(cell)) {
            out.push({ playerId: p.playerId, name: p.name, reason: `outside your team's allowed area (you are in ${cell})` });
          }
        }
      }
      return out;
    },
  },
  {
    kind: NO_VIP_KIND,
    label: "Player has no VIP",
    blurb: "Fires on players who hold NO VIP on this server — no grant in the panel (permanent, dated or paused) and nothing on the game's own VIP list. Pair it with the VIP action to give them VIP (with an optional message after), or with Message to tell them how to get it. When the game's VIP list can't be read, nobody is flagged.",
    fields: [
      { key: "minMinutesOnline", label: "Only after they've been on for (minutes)", type: "int", default: 0, min: 0, max: 1440, help: "0 = as soon as they're seen. A few minutes skips players who join and leave straight away." },
    ],
    detect({ players, params }): Violation[] {
      const minMinutes = Math.max(0, Number(params.minMinutesOnline ?? 0));
      return players
        // `false` only: unknown (null/undefined) is never read as "no VIP" — a paid VIP the tick
        // could not see must not be offered, or granted over, something they already have.
        .filter((p) => p.vip === false && (minMinutes <= 0 || (p.onlineMinutes ?? 0) >= minMinutes))
        .map((p) => ({ playerId: p.playerId, name: p.name, reason: "you don't have VIP" }));
    },
    explain({ players, params }) {
      const minMinutes = Math.max(0, Number(params.minMinutesOnline ?? 0));
      return tally(players, (p) =>
        p.vip === true ? (p.vipSource === "game" ? "on the game's own VIP list" : "hold a VIP grant here")
          : p.vip !== false ? "VIP unknown — the game's VIP list could not be read"
            : minMinutes > 0 && (p.onlineMinutes ?? 0) < minMinutes ? `no VIP, on for under ${minMinutes} min`
              : "no VIP");
    },
  },
  {
    kind: PLAYTIME_KIND,
    label: "Playtime milestone",
    blurb: "Fires on players on the server who have played at least the hours you set — all time or over the last N days, on this server or every server. Pair it with VIP, points or a message to reward regulars, and with \"at most once per player\" so a milestone pays once.",
    fields: [
      { key: "hours", label: "Hours played", type: "int", default: 20, min: 1, max: 100000, help: "They qualify once their playtime reaches this." },
      { key: "periodDays", label: "Over the last (days, 0 = all time)", type: "int", default: 0, min: 0, max: 3650, help: "30 = hours played in the last 30 days." },
      { key: "allServers", label: "Count every server (off = this server only)", type: "bool", default: false },
    ],
    detect({ players, params }): Violation[] {
      const hours = Math.max(1, Number(params.hours ?? 20));
      const periodDays = Math.max(0, Number(params.periodDays ?? 0));
      const key = playtimeKey(params.allServers === true, periodDays);
      const span = periodDays > 0 ? ` in the last ${periodDays} day${periodDays === 1 ? "" : "s"}` : "";
      return players
        .filter((p) => (p.playtimeHours?.[key] ?? -1) >= hours)
        .map((p) => ({ playerId: p.playerId, name: p.name, reason: `${Math.floor(p.playtimeHours![key]!)} hours played${span}` }));
    },
    explain({ players, params }) {
      const hours = Math.max(1, Number(params.hours ?? 20));
      const key = playtimeKey(params.allServers === true, Math.max(0, Number(params.periodDays ?? 0)));
      return tally(players, (p) => {
        const h = p.playtimeHours?.[key];
        return h === undefined ? "playtime unknown (not in the player directory yet, or unreadable)" : h >= hours ? `${hours}+ hours` : `under ${hours} hours`;
      });
    },
  },
  {
    kind: NO_DISCORD_KIND,
    label: "No Discord link",
    blurb: "Fires on players whose game account is not linked to a Discord account — the link that role gates, points and VIP registration need. Pair it with a message telling them how to link. When links can't be read, nobody is flagged.",
    fields: [
      { key: "minMinutesOnline", label: "Only after they've been on for (minutes)", type: "int", default: 5, min: 0, max: 1440, help: "Gives a new arrival a few minutes before the message." },
    ],
    detect({ players, params }): Violation[] {
      const minMinutes = Math.max(0, Number(params.minMinutesOnline ?? 0));
      return players
        .filter((p) => p.discordLinked === false && (minMinutes <= 0 || (p.onlineMinutes ?? 0) >= minMinutes))
        .map((p) => ({ playerId: p.playerId, name: p.name, reason: "your Discord account isn't linked" }));
    },
    explain({ players, params }) {
      const minMinutes = Math.max(0, Number(params.minMinutesOnline ?? 0));
      return tally(players, (p) =>
        p.discordLinked === true ? "Discord linked"
          : p.discordLinked !== false ? "link unknown (not in the player directory yet, or unreadable)"
            : minMinutes > 0 && (p.onlineMinutes ?? 0) < minMinutes ? `not linked, on for under ${minMinutes} min`
              : "not linked");
    },
  },
  {
    kind: KILL_RATE_KIND,
    label: "Kill rate or K/D over a limit",
    blurb: "Fires on players whose kills this match run far ahead of normal — above a kills-per-10-minutes rate or a K/D — once they have at least the minimum kills. Meant for \"record & ping\" so staff can take a look; a strong player is not proof of anything.",
    fields: [
      { key: "minKills", label: "Only once they have at least (kills)", type: "int", default: 30, min: 1, max: 1000, help: "Rates on a handful of kills are noise." },
      { key: "killsPer10Min", label: "Kills per 10 minutes at or above (0 = off)", type: "int", default: 25, min: 0, max: 1000, help: "25 = two and a half kills a minute, sustained." },
      { key: "minKd", label: "K/D at or above (0 = off)", type: "int", default: 0, min: 0, max: 1000, help: "Kills divided by deaths this match (no deaths counts as one)." },
    ],
    detect({ players, params }): Violation[] {
      const minKills = Math.max(1, Number(params.minKills ?? 30));
      const rate = Math.max(0, Number(params.killsPer10Min ?? 0));
      const kdMin = Math.max(0, Number(params.minKd ?? 0));
      const out: Violation[] = [];
      for (const p of players) {
        const kills = Number(p.kills ?? 0);
        if (!(kills >= minKills)) continue;
        const kd = kills / Math.max(1, Number(p.deaths ?? 0));
        // The rate needs a time base; with none (null) only the K/D can speak. A base under a few
        // minutes stays silent too: a rejoin mid-match keeps the match's kills but restarts our
        // clock, and 45 real kills over 2 tracked minutes must not read as 225 per 10.
        const per10 = p.playMinutes != null && p.playMinutes >= 3 ? (kills / p.playMinutes) * 10 : null;
        const byRate = rate > 0 && per10 !== null && per10 >= rate;
        const byKd = kdMin > 0 && kd >= kdMin;
        if (!byRate && !byKd) continue;
        out.push({
          playerId: p.playerId, name: p.name,
          reason: `${kills} kills, K/D ${kd.toFixed(1)}${per10 !== null ? `, ${per10.toFixed(1)} kills per 10 min` : ""}`,
        });
      }
      return out;
    },
    explain(ctx) {
      const minKills = Math.max(1, Number(ctx.params.minKills ?? 30));
      const flagged = new Set(this.detect(ctx).map((v) => v.playerId));
      return tally(ctx.players, (p) =>
        flagged.has(p.playerId) ? "over the limit"
          : p.kills == null ? "kills not reported"
            : Number(p.kills) < minKills ? `under ${minKills} kills` : "within the limits");
    },
  },
  {
    kind: RATIO_KIND,
    label: "Ratio over or under a limit",
    blurb: "Fires on players whose ratio of two of this match's counts — kills, deaths or team kills, the first divided by the second — is at or above a limit (or at or below it), once the two counts add up to the minimum. Read from the live roster at each check, so nothing is written until it fires.",
    fields: [
      { key: "ratio", label: "Ratio", type: "text", default: "teamkills:kills", help: "Two of kills, deaths and team kills: the first divided by the second (a second count of 0 counts as 1)." },
      { key: "direction", label: "Fires when it is", type: "text", default: "above", help: "above: at or above the limit. below: at or below it." },
      { key: "limit", label: "Limit", type: "number", default: 2, min: 0, max: 1000, help: "Up to two decimal places: 0.5 is one for every two." },
      { key: "minCount", label: "Minimum of the two counts added together", type: "int", default: 10, min: 1, max: 1000, help: "A ratio on a handful of kills is noise." },
    ],
    detect({ players, params }): Violation[] {
      const judge = ratioJudge(params);
      return players.flatMap((p) => {
        const { reason } = judge(p);
        return reason ? [{ playerId: p.playerId, name: p.name, reason }] : [];
      });
    },
    explain({ players, params }) {
      const judge = ratioJudge(params);
      return tally(players, (p) => judge(p).label);
    },
  },
  {
    kind: CLAN_TAG_KIND,
    label: "Player is wearing a clan tag",
    blurb: "Fires on players wearing one of the chosen clan tags — any spelling of it, as Players → Clans groups them.",
    fields: [
      { key: "clans", label: "Clan tags", type: "list", default: [], help: "The tags to act on, as listed under Players → Clans." },
    ],
    detect({ players, params, clans }): Violation[] {
      if (!clans) return [];
      const want = new Set(listOf(params.clans).map((k) => clans.ofKey(k)));
      if (!want.size) return [];
      const out: Violation[] = [];
      for (const p of players) {
        const tag = (p.clanTag ?? "").trim();
        if (tag && want.has(clans.ofTag(tag))) out.push({ playerId: p.playerId, name: p.name, reason: `wearing the clan tag ${tag}` });
      }
      return out;
    },
    explain(ctx) {
      const flagged = new Set(this.detect(ctx).map((v) => v.playerId));
      return tally(ctx.players, (p) =>
        flagged.has(p.playerId) ? "wearing a chosen tag" : (p.clanTag ?? "").trim() ? "another tag" : "no tag");
    },
  },
  {
    kind: "app.state.solo_tank",
    label: "Solo tank squad",
    blurb: "Fires on players crewing an armor squad with fewer than the minimum crew — the lone tanker holding a tank the team needs.",
    games: ["hll", "hllv"],
    fields: [
      { key: "tankRoles", label: "Tank roles", type: "roles", default: [11, 12], help: "Roles that make a squad count as armor (default: Crewman, Tank Commander)." },
      { key: "minCrew", label: "Minimum crew", type: "int", default: 2, min: 1, max: 6, help: "An armor squad with fewer members than this is flagged." },
    ],
    detect({ players, params, descriptor }): Violation[] {
      const minCrew = Math.max(1, Number(params.minCrew ?? 2));
      const squadLabel = descriptor?.squadLabel ?? "squad";
      return underCrewedSquads(players, new Set(nums(params.tankRoles)), minCrew, `solo tank — an armor ${squadLabel} needs at least ${minCrew} crew`);
    },
  },
  {
    kind: "app.state.solo_heli",
    label: "Solo helicopter platoon",
    blurb: "Fires on players crewing a helicopter platoon with fewer than the minimum crew — the solo pilot holding a platoon. HLL: Vietnam.",
    games: ["hllv"],
    fields: [
      { key: "heliRoles", label: "Helicopter roles", type: "roles", default: [16, 17], help: "Roles that make a platoon count as a helicopter crew (default: Pilot, Logistics Officer)." },
      { key: "minCrew", label: "Minimum crew", type: "int", default: 2, min: 1, max: 6, help: "A helicopter platoon with fewer members than this is flagged." },
    ],
    detect({ players, params, descriptor }): Violation[] {
      const minCrew = Math.max(1, Number(params.minCrew ?? 2));
      const squadLabel = descriptor?.squadLabel ?? "squad";
      return underCrewedSquads(players, new Set(nums(params.heliRoles)), minCrew, `solo helicopter — a helicopter ${squadLabel} needs at least ${minCrew} crew`);
    },
  },
];

/**
 * The kill-derived trigger's knobs. Not a StateTriggerDef — a restricted-weapon kill is an EVENT,
 * so the enforcer judges it inline (no worker detection, no synthetic emission).
 */
export const WEAPON_TRIGGER_FIELDS: RuleField[] = [
  { key: "disallowedWeapons", label: "Disallowed weapons", type: "text", default: "", help: "Comma-separated, case-insensitive substring match (e.g. FLAMETHROWER, SATCHEL, 150MM). A kill with any of these fires the rule." },
  { key: "allowedWeapons", label: "Allowed weapons (allowlist)", type: "text", default: "", help: "Leave blank to allow everything except the disallowed list. If set, ONLY kills with these weapons are permitted; anything else fires the rule." },
];

/**
 * Group triggers: a player ADDED to, or REMOVED from, a named player group (Players → Groups).
 *
 * Neither a roster state nor a log line — the store queues each real membership change (a re-add
 * of someone already listed is not a join) and the enforcer drains the queue, firing the rules
 * that watch that group on the servers of the member's own game. Membership is not presence, so
 * these carry only what reaches an absent player: VIP, points, a tag, a note.
 */
export const GROUP_JOINED_KIND = "app.group.joined";
export const GROUP_LEFT_KIND = "app.group.left";
export const isGroupTriggerKind = (kind: string): boolean => kind === GROUP_JOINED_KIND || kind === GROUP_LEFT_KIND;
export const GROUP_TRIGGER_FIELDS: RuleField[] = [
  { key: "groupId", label: "Group", type: "text", default: "", help: "The player group whose membership this rule watches." },
];

/**
 * The schedule trigger: a rule that fires on the CALENDAR — the 1st of every month, every
 * Saturday, the first Saturday of the month, or listed dates — and acts on every member of a
 * group at once: grant VIP, take timed VIP away, or cut it back (to a span, or by an amount).
 * Read in the community's timezone; each moment runs once, and a moment missed while the panel
 * was down runs once when it is back (the latest one only — see @app/schedule's recurrence).
 */
export const SCHEDULE_KIND = "app.schedule";
export const SCHEDULE_REPEATS = ["monthly", "weekly", "nth", "dates"] as const;
export const SCHEDULE_TRIGGER_FIELDS: RuleField[] = [
  { key: "groupId", label: "Group", type: "text", default: "", help: "The player group whose members the rule acts on." },
  { key: "repeat", label: "Repeat", type: "text", default: "monthly", help: "monthly, weekly, nth (e.g. the first Saturday) or dates." },
  { key: "monthDay", label: "Day of the month", type: "int", default: 1, min: 1, max: 31, help: "31 runs on the last day of shorter months." },
  { key: "weekdays", label: "Days of the week", type: "text", default: "", help: "Comma-separated: mon, tue, wed, thu, fri, sat, sun." },
  { key: "nth", label: "Which one", type: "int", default: 1, min: -1, max: 4, help: "1 to 4, or -1 for the last." },
  { key: "nthWeekday", label: "Day of the week", type: "text", default: "sat" },
  { key: "dates", label: "Dates", type: "text", default: "", help: "Comma-separated YYYY-MM-DD." },
  { key: "time", label: "Time", type: "text", default: "00:00", help: "HH:MM, 24-hour, in the community's timezone." },
  { key: "stack", label: "Stack onto existing time", type: "bool", default: true, help: "For a VIP grant: add the time on top (on) or make sure everyone has at least that much (off)." },
];

/** A schedule rule's weekdays param, normalised: "Sat, sun" → ["sat", "sun"]. */
export function scheduleWeekdays(v: unknown): string[] {
  return [...new Set(listOf(v).map((d) => d.trim().toLowerCase().slice(0, 3)).filter(Boolean))];
}

/** Judge one kill's weapon against a rule's lists. Returns the violation sentence, or null. */
export function restrictedWeaponReason(weapon: string | null | undefined, params: Record<string, unknown>): string | null {
  const upper = (weapon ?? "").toUpperCase();
  if (!upper) return null;
  const disallowed = listOf(params.disallowedWeapons).map((s) => s.toUpperCase());
  const allowed = listOf(params.allowedWeapons).map((s) => s.toUpperCase());
  if (disallowed.some((d) => upper.includes(d))) return `${weapon} is not allowed here`;
  if (allowed.length > 0 && !allowed.some((a) => upper.includes(a))) return `${weapon} is not on the allowed-weapons list`;
  return null;
}

export function getStateTrigger(kind: string): StateTriggerDef | undefined {
  return STATE_TRIGGERS.find((t) => t.kind === kind);
}

/**
 * Does this state trigger mean anything on this game? The worker must ask before detecting: role
 * ids COLLIDE across games — HLL: Vietnam's Pilot (16) is WW2's artillery Gunner (16) — so a
 * community-wide solo-helicopter rule run against a WW2 roster would read an under-crewed
 * artillery squad as a lone pilot and warn people for a vehicle their game does not have.
 */
export function stateTriggerAppliesTo(kind: string, game: string | null | undefined): boolean {
  const def = getStateTrigger(kind);
  if (!def) return false;
  return !def.games || def.games.length === 0 || (game != null && def.games.includes(game));
}

/** The param fields a rule of this kind carries (empty for kinds that take none). */
export function triggerParamFields(kind: string): RuleField[] {
  if (kind === WEAPON_TRIGGER_KIND) return WEAPON_TRIGGER_FIELDS;
  if (isGroupTriggerKind(kind)) return GROUP_TRIGGER_FIELDS;
  if (kind === SCHEDULE_KIND) return SCHEDULE_TRIGGER_FIELDS;
  return getStateTrigger(kind)?.fields ?? [];
}

/** A rule's stored params resolved over the trigger's field defaults — what detect/judging read. */
export function resolveTriggerParams(kind: string, stored: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of triggerParamFields(kind)) out[f.key] = f.default;
  const merged = { ...out, ...(stored ?? {}) };
  // One spelling of a group's id everywhere it is compared — including a rule that arrived by
  // import or restore and never went through parseTriggerParams.
  if (isGroupTriggerKind(kind) || kind === SCHEDULE_KIND) merged.groupId = canonicalGroupId(merged.groupId);
  return merged;
}

/**
 * A group's id as both stores write it: a lowercase, hyphenated UUID. Postgres reads other
 * spellings of a UUID (upper case, braces, no hyphens) as the same id while every comparison in
 * the app is by string — a rule saved with one of those would reach the group's members while the
 * membership checks that look for it by id never saw it. Anything that is not a UUID stays as given.
 */
export function canonicalGroupId(v: unknown): string {
  const s = String(v ?? "").trim();
  const hex = s.replace(/[{}-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return s;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Validate a rule's params for its trigger kind — the save-time half, shared by POST and PATCH so
 * there is one set of rules. Beyond per-field shape checks, a configuration that can NEVER fire is
 * refused with the fix named: a rule whose lists are all empty is not a lenient rule, it is a rule
 * somebody believes is protecting the server while it matches nothing.
 */
export function parseTriggerParams(
  kind: string,
  raw: unknown,
  validRoles: Set<number>,
): { params: Record<string, unknown> | null } | { error: string } {
  const fields = triggerParamFields(kind);
  if (!fields.length) return { params: null }; // this kind takes no params; store none
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const params: Record<string, unknown> = {};
  for (const f of fields) {
    const v = body[f.key];
    if (v === undefined) { params[f.key] = f.default; continue; }
    if (f.type === "int" || f.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `${f.label} must be a number` };
      if (f.min !== undefined && n < f.min) return { error: `${f.label} must be at least ${f.min}` };
      if (f.max !== undefined && n > f.max) return { error: `${f.label} must be at most ${f.max}` };
      params[f.key] = f.type === "int" ? Math.round(n) : twoPlaces(n);
    } else if (f.type === "bool") {
      params[f.key] = v === true;
    } else if (f.type === "text") {
      const s = typeof v === "string" ? v.trim() : "";
      if (s.length > 500) return { error: `${f.label} is too long (max 500 characters)` };
      params[f.key] = s;
    } else if (f.type === "list") {
      // Sorted: the list is a set, and one spelling of it lets the clash check see two rules
      // naming the same tags in a different order as the same rule.
      const items = [...new Set(listOf(v).map((x) => x.trim()).filter(Boolean))].sort();
      if (items.length > CLAN_TAG_RULE_MAX) return { error: `${f.label}: at most ${CLAN_TAG_RULE_MAX}` };
      if (items.some((x) => x.length > 200)) return { error: `${f.label}: an entry is too long` };
      params[f.key] = items;
    } else { // roles
      const ids = nums(v).map(Math.round);
      if (validRoles.size > 0) {
        const stray = ids.find((r) => !validRoles.has(r));
        if (stray !== undefined) return { error: `${f.label}: role ${stray} is not a role this game has — pick from the list` };
      }
      params[f.key] = [...new Set(ids)];
    }
  }
  // Never-fires refusals, per kind.
  if (kind === "app.state.bad_role" && !(params.disallowedRoles as number[]).length && !(params.allowedRoles as number[]).length) {
    return { error: "pick at least one disallowed role, or fill the allowlist — with both empty this rule matches nobody" };
  }
  if (kind === "app.state.bad_name") {
    const pattern = String(params.bannedPattern ?? "");
    if (pattern) { try { new RegExp(pattern, "i"); } catch { return { error: "Blocked pattern is not a valid regular expression" }; } }
    if (!String(params.bannedSubstrings ?? "").trim() && params.blockUrls !== true && !pattern) {
      return { error: "give the name filter something to match — banned words, the advert/URL switch, or a pattern" };
    }
  }
  if (kind === CLAN_TAG_KIND && !(params.clans as string[]).length) {
    return { error: "pick at least one clan tag — with none, this rule matches nobody" };
  }
  if (kind === KILL_RATE_KIND && !(Number(params.killsPer10Min) > 0) && !(Number(params.minKd) > 0)) {
    return { error: "set a kills-per-10-minutes limit, a K/D limit, or both — with both off this rule matches nobody" };
  }
  if (kind === RATIO_KIND) {
    // One spelling stored, as the clash check compares params.
    const pair = ratioPair(params.ratio);
    if (!pair) return { error: `Ratio must be one of ${RATIO_TYPES.join(", ")}` };
    params.ratio = pair.join(":");
    params.direction = String(params.direction).toLowerCase();
    if (params.direction !== "above" && params.direction !== "below") return { error: "Fires when it is must be above or below" };
    if (params.direction === "above" && !(Number(params.limit) > 0)) {
      return { error: "set a limit above 0 — at or above 0, this rule matches everyone who reaches the minimum" };
    }
  }
  if (kind === WEAPON_TRIGGER_KIND && !String(params.disallowedWeapons ?? "").trim() && !String(params.allowedWeapons ?? "").trim()) {
    return { error: "list at least one disallowed weapon, or fill the allowlist — with both empty this rule matches nothing" };
  }
  if ((kind === "app.state.solo_tank" && !(params.tankRoles as number[]).length)
    || (kind === "app.state.solo_heli" && !(params.heliRoles as number[]).length)) {
    return { error: "pick at least one vehicle role — with none, no squad can count as a vehicle crew" };
  }
  if (kind === "app.state.role_level" && !(params.roles as number[]).length) {
    return { error: "pick at least one role — a level floor covering no roles matches nobody" };
  }
  if (kind === OUT_OF_ZONE_KIND && !String(params.zoneSet ?? "").trim()) {
    return { error: "pick a zone set — without one there is nothing painted to enforce" };
  }
  if ((isGroupTriggerKind(kind) || kind === SCHEDULE_KIND) && !String(params.groupId ?? "").trim()) {
    return { error: "pick the player group this rule is about" };
  }
  if (isGroupTriggerKind(kind) || kind === SCHEDULE_KIND) params.groupId = canonicalGroupId(params.groupId);
  if (kind === SCHEDULE_KIND) {
    // The calendar itself is checked by the API against @app/schedule (recurrenceError); here,
    // only the shape this package owns: which repeat, and its fields in their stored form.
    if (!(SCHEDULE_REPEATS as readonly string[]).includes(String(params.repeat))) {
      return { error: `repeat must be one of ${SCHEDULE_REPEATS.join(", ")}` };
    }
    params.weekdays = scheduleWeekdays(params.weekdays).join(",");
    params.nthWeekday = String(params.nthWeekday ?? "").trim().toLowerCase().slice(0, 3);
    params.dates = listOf(params.dates).join(",");
  }
  return { params };
}
