/**
 * Auto-moderation enforcer. Subscribes to the event bus and, for each `evt.*`, evaluates the
 * enabled rules; when one fires it acts on the offending player.
 *
 * Safety: on a server that isn't `active` (i.e. observe), the action is a DRY RUN — it is
 * recorded to the audit trail as "would-have-fired" but never sent to the game. That lets rules
 * be tuned against real traffic before a server is flipped to active. Every firing (dry-run,
 * executed, or failed) is audited under the actor "enforcer".
 */
import { RULE_MATCH_FALLBACK_MINUTES, automationEnabled, memberGameVerdict, ruleLive, rulePaused, ruleSwitchedOn, safeTimezone, type PlayerGroupEventRow, type Repository, type RuleRow, type ServerRow, type VipRow } from "@app/db";
import { renderActionText } from "./render-text.js";
import { playerProfileUrl } from "./panel-links.js";
import { GROUP_JOINED_KIND, GROUP_LEFT_KIND, SCHEDULE_KIND, WEAPON_TRIGGER_KIND, isGroupTriggerKind, isStateTriggerKind, resolveTriggerParams, restrictedWeaponReason } from "@app/rules";
import { parseVoteBallot } from "@app/maps";
import { MATCH_MINUTES_CEILING, describeRecurrence, isWindowActive, latestOccurrence, matchMinutesSince, matchWindowOpen, type Occurrence, type ScheduleWindow } from "@app/schedule";
import { runScheduleOccurrence } from "./group-schedule.js";
import { GROUP_RULE_ACTIONS, SCHEDULE_ACTIONS, scheduleOf } from "./schedule-spec.js";
import type { EventBus } from "@app/bus";
import { createServerClient, normalizeGameVips } from "@app/rcon-core";
import { getGame, isSideSwap, teamSwitchText } from "@app/games";
import { automatedSignerFrom, background, createLogger, restoreInProgress } from "@app/shared";
import { communityGuild, guildMember } from "./discord-guild.js";

const log = createLogger("enforcer");

/**
 * The one synthetic trigger: "no kills in the window". Every other kind is an event the log
 * produced; this one is the ABSENCE of events, so the enforcer keeps a per-player activity clock
 * (fed by the connect/kill events it already hears) and a timer walks it. The rule's `windowSec`
 * is the timeframe — an hour of silence from parked artillery — and one firing spends the window,
 * so a still-idle player is revisited once per window, not once per sweep.
 */
export const IDLE_KIND = "app.idle";

/** The subset of a bus event the enforcer reads. */
export interface EnforceEvent {
  kind: string;
  serverId?: string;
  actorPlayerId?: string | null;
  actorName?: string | null;
  victimPlayerId?: string | null;
  victimName?: string | null;
  weapon?: string | null;
  data?: Record<string, unknown> | null;
  ts?: string;
}

/**
 * Death triggers: the same kill events, read from the OTHER END.
 *
 * A kill event names two people, and every rule until now acted on the attacker — so "on a team
 * kill, warn the offender" was expressible and "when a player is team-killed, tell them how to
 * report it" was not. These synthetic kinds fire on the same underlying event and make the VICTIM
 * the subject: the player the action lands on, the player the threshold counts, and the player the
 * Discord role gate is checked against.
 *
 * Deliberately two kinds rather than one, mirroring kill/team-kill: dying to the enemy is the game
 * working, and being team-killed is something staff may want to answer.
 */
export const DEATH_KINDS: Record<string, string> = {
  "app.death": "evt.kill",
  "app.teamdeath": "evt.teamkill",
};

/**
 * Admin-camera triggers: the same `evt.admin.camera` event, split by DIRECTION.
 *
 * The raw kind fires on both halves of a visit, which makes "tell me when someone goes on cam"
 * ping twice and "act when someone LEAVES" inexpressible. These two read the event's `entered`
 * flag — the one boolean the whole cam pipeline (pairing, announcement, history) already keys on.
 * A camera line whose direction could not be parsed carries `entered: null` and matches neither:
 * an unreadable line is a gap in the record, not a firing.
 */
export const CAM_KINDS: Record<string, boolean> = {
  "app.admincam.enter": true,
  "app.admincam.exit": false,
};

/** action string → logical RCON command. */
const ACTION_COMMAND: Record<string, string> = {
  message: "messagePlayer",
  kick: "kickPlayer",
  punish: "punishPlayer",
  tempban: "tempBanPlayer",
  permaban: "permaBanPlayer",
  vip: "addVip",
  // Used by the player-trigger runner (rules don't offer these): remove a VIP entry, and move a
  // player to the other team immediately.
  vipremove: "removeVip",
  switch: "switchTeamNow",
};

/** Actions that only mean something while the player is still ON the server. A ban lands on an
 *  absent player; a message, punish or kick does not. `vip` is the inverse — see perform(). */
const NEEDS_PRESENCE = new Set(["message", "punish", "kick", "switch"]);
/** Actions that write only the APP's own records (a note, a tag on the profile) — never the game —
 *  so observe mode and the server's automation switch, which exist to protect the game, don't
 *  hold them. A rule's own trial switch still does. */
const APP_ONLY_ACTIONS = new Set(["note", "tag"]);
/** Actions the circuit breaker ignores: the breaker limits blast radius on the game, and these
 *  either write nothing to it (a note, a tag) or only ever ADD for the player (VIP, points) — and
 *  the perks' ordinary case is a crowd, a milestone or an empty-server welcome reached by dozens
 *  in the same tick, which would trip the breaker on the rule's first honest run. */
const BREAKER_EXEMPT_ACTIONS = new Set(["note", "tag", "vip", "points"]);
/**
 * Every action a rule may take — the rule parser's RULE_ACTIONS (a test pins the two together),
 * restated here because this is the last gate before a command reaches the game. A rule row that
 * never passed the parser — restored from an archive, or applied from an edited setup, both of
 * which write rows directly — must not be able to name anything else: above all the player
 * triggers' `vipremove`, which the shared executor would run with no permanent-VIP guard at all.
 */
export const ENFORCER_ACTIONS = new Set(["message", "kick", "punish", "tempban", "permaban", "blacklist", "vip", "note", "switch", "tag", "points"]);
/** The crash-VIP trigger — the one event whose VIP is for a player who has LEFT. */
const DISCONNECT_KIND = "evt.player.disconnected";

/** How long one read of a server's open match answers the match-time gates — see matchStartFor. */
const MATCH_START_TTL_MS = 15_000;
const DAY_MS = 86_400_000;

/**
 * The breath between game writes born from one ROSTER trigger's crowd — a whole server of
 * newcomers is that trigger's ordinary case, and a hundred back-to-back connects is a way to hurt
 * a live server (the same reason bulk payouts pace their VIP grants). Read lazily so tests set it
 * before firing rather than before import.
 */
const crowdPaceMs = (): number => {
  const n = Number(process.env.RULE_CROWD_PACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
};

/** How long one read of a server's game VIP list answers every VIP firing — see gameVipIds. */
const VIP_LIST_TTL_MS = 10_000;

/** How long after a kick/ban a disappearance still counts as enforcement rather than a crash. */
const REMOVAL_MEMORY_MS = 3 * 60_000;

/** The shortest no-kills window an idle rule judges by — what saving one enforces, too. */
const IDLE_WINDOW_MIN_MS = 60_000;

/** How long a role-gate answer stands before it is asked again. Short: a role granted or taken
 *  should reach the gate in minutes, and the read behind it is one Discord call. */
const ROLE_CACHE_TTL_MS = 5 * 60_000;

/** How many queued membership changes one drain takes at a time (it keeps taking until empty). */
const GROUP_EVENT_BATCH = 100;
/** A membership change older than this is history, not news: the drain drops it unfired. Only a
 *  panel that was down for a day leaves any behind. */
const GROUP_EVENT_STALE_MS = 24 * 60 * 60_000;
/** How long a change waits for its member to be seen on a server (a console id that could be
 *  either game; a Steam64 with no profile for points or a tag to land on), and how often it looks. */
const GROUP_EVENT_WAIT_MS = 30 * 24 * 60 * 60_000;
const GROUP_EVENT_RETRY_MS = 5 * 60_000;

/**
 * Whether a group rule needs the member's profile to act: points and a tag are written to it, a
 * per-player cap counts against it, and the Discord-role and tag gates read it. VIP needs only the
 * game id — a Steam64 is its own — and a note only a name.
 */
function groupRuleNeedsProfile(rule: RuleRow): boolean {
  const steps = [rule.action, ...(rule.escalateActions ?? [])];
  return steps.some((a) => a === "points" || a === "tag") || (rule.capCount ?? 0) > 0
    || rule.requireRoleIds.length > 0 || (rule.immuneRoleIds?.length ?? 0) > 0
    || (rule.requireTags?.length ?? 0) > 0 || (rule.immuneTags?.length ?? 0) > 0;
}

/**
 * Fill a rule's message tokens from the event.
 *
 * Death rules are what forced this: "you were killed by someone" is nearly useless, and the one
 * thing the victim wants to know is who. `{player_name}` is always whoever the rule acts on, so a
 * message reads the same on a kill rule and a death rule, while `{attacker_name}`/`{victim_name}`
 * name the two ends explicitly. Unknown tokens are left as written — the same forgiving contract
 * the player-rules framework's templates keep.
 */
export function applyRuleVars(template: string, e: EnforceEvent, subjectName: string, extra: Record<string, string> = {}): string {
  if (!template.includes("{")) return template;
  const vars: Record<string, string> = {
    ...extra,
    player_name: subjectName,
    attacker_name: e.actorName ?? "",
    victim_name: e.victimName ?? "",
    weapon: e.weapon ?? "",
    // What the state/weapon trigger detected, in a sentence ("solo tank — an armor squad needs at
    // least 2 crew"). Empty on plain event rules, so a template shared across kinds stays usable.
    violation: typeof (e.data as { violation?: unknown } | null)?.violation === "string" ? String((e.data as { violation: string }).violation) : "",
  };
  return template.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));
}

const TEAM_SWITCH_KIND = "evt.player.teamSwitched";

/**
 * A pattern written for a player's whole name: anchored at both ends ("^Bob$"), with no lookaround.
 * Team switches had no words until rules could already watch one player's switches by name, so
 * such a pattern is also tried against the name alone — and only such a pattern: an exclusion
 * ("^(?!.*→ Allies).*$") or an end-anchored word ("Axis$") must be judged on the text the Game
 * log shows, or it would fire on exactly the swaps it was written to leave out.
 */
function wholeNamePattern(match: string): boolean {
  return /^\^.*\$$/.test(match) && !/\(\?[=!<]/.test(match);
}

/** Text a rule's `match` regex is tested against. A team switch adds what it was, in the words
 *  the Game log and the relay show ("switched sides Allies → Axis (2nd this round)"), so a rule
 *  can narrow its swaps — a direction, the second one this round — by what staff read. */
export function eventText(e: EnforceEvent): string {
  const d = e.data ?? {};
  const sw = e.kind === TEAM_SWITCH_KIND ? teamSwitchText(e.data) : null;
  return [e.actorName, e.victimName, e.weapon, typeof d.message === "string" ? d.message : "", typeof d.reason === "string" ? d.reason : "", sw ?? ""].filter(Boolean).join(" ");
}

/**
 * Who this rule acts on. Death rules mean the victim; everything else means the actor.
 *
 * One function so the three places that must agree — the action's target, the threshold's counter,
 * and the role gate's subject — cannot drift apart. A death rule whose threshold counted the
 * KILLER would be a spawn-camp detector wearing a death rule's name.
 */
export function ruleSubject(rule: RuleRow, e: EnforceEvent): { playerId: string | null; name: string } {
  return DEATH_KINDS[rule.eventKind]
    ? { playerId: e.victimPlayerId ?? null, name: e.victimName ?? "" }
    : { playerId: e.actorPlayerId ?? null, name: e.actorName ?? "" };
}

/** Does the event match the rule's kind and optional regex? (Threshold handled separately.)
 *  `now` is injectable for tests; production always means the wall clock. */
export function matchesRule(rule: RuleRow, e: EnforceEvent, now: Date = new Date()): boolean {
  if (!ruleLive(rule, now.getTime())) return false;
  // Active hours gate the FIRING, judged when the event arrives — a delayed action decided
  // inside the window still lands after its delay, which is what "acted at 05:59" means.
  if (rule.activeHours && !isWindowActive(rule.activeHours as ScheduleWindow, now)) return false;

  // A scoped rule only hears its own server's events; null = community-wide (the default).
  if (rule.serverId && rule.serverId !== e.serverId) return false;
  if (isStateTriggerKind(rule.eventKind)) {
    // State events are synthesized PER RULE by the worker (the rule's params drove the detection),
    // so the kind alone is not a match: a sibling rule on the same kind carries different params,
    // and firing it from this event would enforce knobs its author never set.
    if (e.kind !== rule.eventKind) return false;
    if (((e.data ?? {}) as { ruleId?: unknown }).ruleId !== rule.id) return false;
  } else if (rule.eventKind === WEAPON_TRIGGER_KIND) {
    // The kill-derived trigger: judged inline against THIS rule's weapon lists — a restricted
    // weapon is an event with extra params, not a roster state, so no worker round-trip.
    if (e.kind !== "evt.kill" && e.kind !== "evt.teamkill") return false;
    if (restrictedWeaponReason(e.weapon, resolveTriggerParams(rule.eventKind, rule.params)) === null) return false;
  } else if (isGroupTriggerKind(rule.eventKind)) {
    // Fired per rule by the membership drain (runGroupEvents); the group is the trigger's knob.
    if (e.kind !== rule.eventKind) return false;
    if (((e.data ?? {}) as { groupId?: unknown }).groupId !== resolveTriggerParams(rule.eventKind, rule.params).groupId) return false;
  } else if (rule.eventKind in CAM_KINDS) {
    if (e.kind !== "evt.admin.camera") return false;
    if (((e.data ?? {}) as { entered?: boolean | null }).entered !== CAM_KINDS[rule.eventKind]) return false;
  } else if ((DEATH_KINDS[rule.eventKind] ?? rule.eventKind) !== e.kind) return false;
  // A death rule with no resolvable victim is refused HERE rather than later, so an unactionable
  // event never counts toward the threshold — otherwise deaths we cannot act on would push a
  // "died 5 times" rule over the line and fire it on the wrong evidence.
  if (DEATH_KINDS[rule.eventKind] && !e.victimPlayerId) return false;
  // The team-switch trigger hears side swaps alone: the player landing on the other side. The game
  // writes Unassigned between the sides, so every swap comes as a drop to Unassigned and a join,
  // and every connect is a join too — none of those lines is a switch of team, and none counts.
  if (rule.eventKind === TEAM_SWITCH_KIND && !isSideSwap(e.data)) return false;
  /*
   * A chat line that IS a vote ballot never matches a chat rule — not this one, not any rule
   * written later. The in-game map vote asks players to type a bare number in team or unit chat,
   * so a spam rule counting chat messages was punishing people for voting: cast "2", change your
   * mind to "3" inside the window, and the rule that says "×2 within 60s" fires on you. Exempted
   * at the gate, so the line neither fires a rule nor counts toward any threshold. Unconditional
   * on purpose — players cannot be expected to know the exact minutes a vote is open, and a bare
   * one-or-two-digit number is noise, never abuse. The shape is decided by parseVoteBallot, the
   * SAME parser the vote counter uses, so what the vote solicits and what rules ignore can never
   * fork.
   */
  if (e.kind === "evt.chat.team" || e.kind === "evt.chat.squad") {
    const msg = (e.data ?? {}) as { message?: unknown };
    if (typeof msg.message === "string" && parseVoteBallot(msg.message) !== null) return false;
  }
  if (rule.match) {
    try {
      const re = new RegExp(rule.match, "i");
      if (!re.test(eventText(e)) && !(e.kind === TEAM_SWITCH_KIND && wholeNamePattern(rule.match) && re.test(e.actorName ?? ""))) return false;
    } catch {
      return false; // an invalid regex never matches (and never throws into ingestion)
    }
  }
  return true;
}

export interface EnforcerDeps {
  repo: Repository;
  bus: EventBus;
  /** Execute an action on an ACTIVE server. Observe servers never reach here (dry-run). */
  execute?: (server: ServerRow, action: string, params: Record<string, unknown>) => Promise<void>;
  /** The game's own VIP list (player ids), or null when it cannot be read. Goes wherever `execute`
   *  goes: with a custom executor (tests, embedding) and no reader, there is no real game to ask,
   *  so the list reads as empty. */
  readGameVipIds?: (server: ServerRow) => Promise<Set<string> | null>;
  refreshMs?: number;
  /** cadence of the app.idle clock walk (tests drive runIdleSweep directly instead). */
  idleSweepMs?: number;
  /** cadence of the group-membership drain (tests drive runGroupEvents directly instead). */
  groupEventMs?: number;
  /** how long a membership change waiting for its member is put back for (GROUP_EVENT_RETRY_MS). */
  groupRetryMs?: number;
  /** cadence of the schedule clock (tests drive runSchedules directly instead). */
  scheduleMs?: number;
}

/** Default executor: connect in active mode and issue the mapped write command. */
export function defaultExecutor(): (server: ServerRow, action: string, params: Record<string, unknown>) => Promise<void> {
  return async (server, action, params) => {
    const command = ACTION_COMMAND[action];
    if (!command) throw new Error(`unknown enforcer action: ${action}`);
    const client = createServerClient({ protocol: server.protocol, engagementMode: "active", commands: getGame(server.game)?.commands, lineKey: getGame(server.game)?.logLineKey });
    try {
      await client.connect({ host: server.host, port: server.port, password: server.password, headerMode: server.headerMode ?? "magic", crconBaseUrl: server.crconBaseUrl ?? undefined });
      await client.execute(command, params);
    } finally {
      await client.disconnect().catch(() => {});
    }
  };
}

/** Default VIP-list reader: the game's own list, through the same connection shape the executor uses. */
export function defaultGameVipReader(): (server: ServerRow) => Promise<Set<string> | null> {
  return async (server) => {
    const client = createServerClient({ protocol: server.protocol, engagementMode: "active", commands: getGame(server.game)?.commands, lineKey: getGame(server.game)?.logLineKey });
    try {
      await client.connect({ host: server.host, port: server.port, password: server.password, headerMode: server.headerMode ?? "magic", crconBaseUrl: server.crconBaseUrl ?? undefined });
      const listed = normalizeGameVips(await client.execute("getVipIds"));
      return listed ? new Set(listed.map((v) => v.playerId)) : null;
    } catch {
      return null;
    } finally {
      await client.disconnect().catch(() => {});
    }
  };
}

export class Enforcer {
  private rules: RuleRow[] = [];
  private windows = new Map<string, number[]>(); // `${ruleId}|${actor}` → recent match times (ms)
  // Per-player activity clock for the app.idle trigger: `${serverId}|${actorPlayerId}` → when
  // they last connected or killed. Fed by events, so a worker restart starts everyone fresh —
  // the direction that flags nobody wrongly.
  private idleClocks = new Map<string, { serverId: string; actorPlayerId: string; actorName: string; lastActiveMs: number }>();
  private idleFiredAt = new Map<string, number>(); // `${ruleId}|${clockKey}` → last firing (ms)
  // Kicks and bans, briefly remembered: the disconnect that follows one is enforcement, and the
  // crash-VIP action must not reward it.
  private recentRemovals = new Map<string, number>(); // `${serverId}|${actorPlayerId}` → ms
  // Role-gate answers by actorPlayerId; only ANSWERS are cached ("couldn't ask" retries).
  private roleCache = new Map<string, { roleIds: string[]; atMs: number }>();
  /**
   * Escalation memory: `${ruleId}|${subject}` → how many times this rule has fired on this player,
   * and when it last did. In-process on purpose, like the threshold windows above: a ladder is a
   * short-horizon "tonight" memory, and forgetting it on restart errs in the direction that warns
   * somebody twice rather than the one that kicks them for last week.
   */
  private offences = new Map<string, { count: number; lastMs: number }>();
  /**
   * Circuit-breaker memory: ruleId → the distinct subjects this rule ACTED on in the last minute.
   * Real actions only — dry-runs and notes touch nobody, so they cannot constitute blast radius.
   */
  private breakerWindow = new Map<string, Map<string, number>>();
  /** Latest known player count per server, from the roster snapshots ingest already records.
   *  Cached briefly so a busy kill feed doesn't turn the population gate into a query per event. */
  private countCache = new Map<string, { count: number | null; atMs: number }>();
  // Timers for delayed actions. Cleared on stop, so a stopped enforcer never acts late; they do
  // not survive a restart either, which a delay measured in seconds can afford.
  private pending = new Set<ReturnType<typeof setTimeout>>();
  private unsub?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private idleTimer?: ReturnType<typeof setInterval>;
  private readonly repo: Repository;
  private readonly bus: EventBus;
  private readonly execute: (server: ServerRow, action: string, params: Record<string, unknown>) => Promise<void>;
  private readonly readGameVipIds: (server: ServerRow) => Promise<Set<string> | null>;
  private vipListCache = new Map<string, { at: number; read: Promise<Set<string> | null> }>();
  /** serverId → when its open match started (ms; null = no usable answer), and when we asked. */
  private matchCache = new Map<string, { startMs: number | null; atMs: number }>();
  /** `${ruleId}|${subject}|r|d` → firings that passed the per-player cap and are not yet in the
   *  audit trail — see perform(). Without it, a burst of events counts the same empty trail twice. */
  private capInflight = new Map<string, number>();
  /** serverId → the tail of that server's paced write chain — see pacedExecute. */
  private crowdChain = new Map<string, Promise<void>>();
  /** `${ruleId}|${serverId}|${reason}` → when that hold-back was last recorded — see held(). */
  private heldNotedAt = new Map<string, number>();
  private readonly refreshMs: number;
  private readonly idleSweepMs: number;
  private readonly groupEventMs: number;
  private groupTimer?: ReturnType<typeof setInterval>;
  /** The drain in flight, so a timer tick and a route's nudge never take the queue twice over. */
  private groupDrain: Promise<void> | null = null;
  private readonly groupRetryMs: number;
  private readonly scheduleMs: number;
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private scheduleRun: Promise<void> | null = null;

  constructor(deps: EnforcerDeps) {
    this.repo = deps.repo;
    this.bus = deps.bus;
    this.execute = deps.execute ?? defaultExecutor();
    this.readGameVipIds = deps.readGameVipIds ?? (deps.execute ? async () => new Set<string>() : defaultGameVipReader());
    this.refreshMs = deps.refreshMs ?? 10_000;
    this.idleSweepMs = deps.idleSweepMs ?? 60_000;
    this.groupEventMs = deps.groupEventMs ?? 5_000;
    this.groupRetryMs = deps.groupRetryMs ?? GROUP_EVENT_RETRY_MS;
    // Every 15 seconds, not every minute: the check is in memory until something is due, and a
    // short tick narrows the moment in which a person re-saving a rule could land between an
    // occurrence and its claim. (A rules setup re-applied unchanged keeps its rules as they are.)
    this.scheduleMs = deps.scheduleMs ?? 15_000;
  }

  async start(): Promise<void> {
    await this.refresh();
    // Both of these used to be bare `void` calls. With crash handlers installed that makes an
    // unhandled rejection an exit, so a database blip on the ten-second rule refresh — or one
    // malformed event reaching `onEvent` — took the whole API down. The bus guards what a
    // synchronous subscriber throws; it never sees the promise an async one returns.
    this.timer = setInterval(() => background(log, "enforcer rule refresh", () => this.refresh()), this.refreshMs);
    this.timer.unref?.(); // never keep the process (or a test run) alive on the refresh timer
    this.idleTimer = setInterval(() => background(log, "enforcer idle sweep", () => this.runIdleSweep()), this.idleSweepMs);
    this.idleTimer.unref?.();
    this.groupTimer = setInterval(() => background(log, "enforcer group membership", () => this.runGroupEvents()), this.groupEventMs);
    this.groupTimer.unref?.();
    // The schedule clock: every few seconds, and once now — an occurrence missed while the panel
    // was down runs as soon as it is back.
    this.scheduleTimer = setInterval(() => background(log, "enforcer schedules", () => this.runSchedules()), this.scheduleMs);
    this.scheduleTimer.unref?.();
    background(log, "enforcer schedules", () => this.runSchedules());
    this.unsub = this.bus.on("*", (e) => background(log, "enforcer event", () => this.onEvent(e as EnforceEvent)));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.groupTimer) clearInterval(this.groupTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.unsub?.();
  }

  /** Reload rules from the store (called on a timer and after any rule mutation). */
  async refresh(): Promise<void> {
    this.rules = await this.repo.enforcerRules.list();
    // Prune the threshold windows while we're here. Entries are only deleted when a rule FIRES,
    // so every actor who matched once and never again would otherwise sit in the map until the
    // process restarts — a slow, unbounded leak on a busy server. An entry whose newest hit is
    // older than its rule's window (or whose rule is gone) can never contribute to a firing. A
    // per-match rule's window is the match, not its windowSec (often 0): pruned by windowSec, every
    // refresh emptied it, and "twice in one match" could only ever count to one between refreshes.
    // The longest a match can run bounds it — overThreshold drops hits from before the start.
    const windowByRule = new Map(this.rules.map((r) => [r.id, r.countPerMatch ? MATCH_MINUTES_CEILING * 60_000 : (r.windowSec || 0) * 1000]));
    const now = Date.now();
    for (const [key, hits] of this.windows) {
      const windowMs = windowByRule.get(key.slice(0, key.indexOf("|")));
      if (windowMs === undefined || hits.length === 0 || now - hits[hits.length - 1]! > windowMs) this.windows.delete(key);
    }
    for (const [key, at] of this.recentRemovals) if (now - at > REMOVAL_MEMORY_MS) this.recentRemovals.delete(key);
    // Offence ladders decay by their own rule's reset window (0 = keep until restart); a ladder
    // whose rule is gone can never be read again.
    const resetByRule = new Map(this.rules.map((r) => [r.id, (r.escalateResetMinutes ?? 120) * 60_000]));
    for (const [key, st] of this.offences) {
      const resetMs = resetByRule.get(key.slice(0, key.indexOf("|")));
      if (resetMs === undefined || (resetMs > 0 && now - st.lastMs > resetMs)) this.offences.delete(key);
    }
    // The role cache leaked for the same reason, one map over: its TTL is applied when an entry is
    // READ, so a stale one is correctly ignored and then kept forever. Every distinct player who
    // ever tripped a role-gated rule held a slot for the life of the process. Expired entries can
    // never be returned, so dropping them here costs nothing and bounds the map by "players seen
    // in the last five minutes" rather than "players ever seen".
    for (const [key, hit] of this.roleCache) if (now - hit.atMs > ROLE_CACHE_TTL_MS) this.roleCache.delete(key);
    // Breaker windows and count cache decay on the same sweep: entries older than their horizon
    // can never influence a decision again.
    for (const [ruleId, subjects] of this.breakerWindow) {
      for (const [subject, at] of subjects) if (now - at > 60_000) subjects.delete(subject);
      if (!subjects.size) this.breakerWindow.delete(ruleId);
    }
    for (const [sid, hit] of this.countCache) if (now - hit.atMs > 60_000) this.countCache.delete(sid);
    for (const [sid, hit] of this.matchCache) if (now - hit.atMs > 60_000) this.matchCache.delete(sid);
  }

  /**
   * Game writes born from a ROSTER trigger ride a per-server chain with a breath between them —
   * crowds are those triggers' ordinary case, and each write opens its own connection. The caller
   * gets its own write's outcome (a failed grant is still that firing's failure); only the NEXT
   * write waits out the gap. Event-kind firings are naturally spread and stay immediate.
   */
  private pacedExecute(server: ServerRow, stateKind: boolean, action: string, params: Record<string, unknown>): Promise<void> {
    if (!stateKind) return this.execute(server, action, params);
    const prev = this.crowdChain.get(server.id) ?? Promise.resolve();
    const run = prev.then(() => this.execute(server, action, params));
    const tail = run.catch(() => {}).then(() => {
      const gap = crowdPaceMs();
      // Not unref'd: the NEXT write in the chain is real pending work waiting on this timer, and
      // an unref'd gap would let an otherwise-idle process exit with that write still queued.
      return gap > 0 ? new Promise<void>((r) => setTimeout(r, gap)) : undefined;
    });
    this.crowdChain.set(server.id, tail as Promise<void>);
    return run;
  }

  /**
   * When this server's current match started (ms since epoch), or null when there is no usable
   * answer: no open match, or one whose start is unreadable, in the future or implausibly old.
   * Shared for a few seconds per server, and dropped when the log says a match started or ended.
   */
  private async matchStartFor(serverId: string): Promise<number | null> {
    const now = Date.now();
    const hit = this.matchCache.get(serverId);
    if (hit && now - hit.atMs < MATCH_START_TTL_MS) return hit.startMs;
    let startMs: number | null = null;
    try {
      const open = await this.repo.matches.getOpen(serverId);
      if (open?.startedAt && matchMinutesSince(open.startedAt, now) !== null) startMs = Date.parse(open.startedAt);
    } catch { /* unreadable = unknown */ }
    this.matchCache.set(serverId, { startMs, atMs: now });
    return startMs;
  }

  /**
   * Remember why this rule just held a firing back — shown on the rule's card, because a rule that
   * quietly does nothing looks exactly like one with nothing to do. Once a minute per rule and
   * reason at most: an event rule can be held back on every kill.
   */
  private held(rule: RuleRow, serverId: string, reason: string, playerName?: string | null): void {
    const key = `${rule.id}|${serverId}|${reason}`;
    const now = Date.now();
    if (now - (this.heldNotedAt.get(key) ?? 0) < 60_000) return;
    this.heldNotedAt.set(key, now);
    if (this.heldNotedAt.size > 5000) for (const [k, at] of this.heldNotedAt) if (now - at > 60_000) this.heldNotedAt.delete(k);
    void this.repo.enforcerRules.recordSkip(rule.id, serverId, reason, playerName || null).catch(() => {});
  }

  /** Is the rule's match-time window open on this server right now? Unknown match = closed. */
  private async matchWindowOpenFor(rule: RuleRow, serverId: string | null | undefined): Promise<boolean> {
    if (!(rule.matchMinutesMin > 0) && !(rule.matchMinutesMax > 0)) return true;
    if (!serverId) return false;
    const start = await this.matchStartFor(serverId);
    return matchWindowOpen(rule.matchMinutesMin, rule.matchMinutesMax, start === null ? null : (Date.now() - start) / 60_000);
  }

  /** Where the per-player cap starts counting: null = ever. "This match" with no known match
   *  start reads as the last RULE_MATCH_FALLBACK_MINUTES. */
  private async capSince(rule: RuleRow, serverId: string, nowMs: number): Promise<string | null> {
    switch (rule.capPeriod) {
      case "ever": return null;
      case "month": return new Date(nowMs - 30 * DAY_MS).toISOString();
      case "week": return new Date(nowMs - 7 * DAY_MS).toISOString();
      case "match": return new Date((await this.matchStartFor(serverId)) ?? nowMs - RULE_MATCH_FALLBACK_MINUTES * 60_000).toISOString();
      default: return new Date(nowMs - DAY_MS).toISOString();
    }
  }

  /**
   * The server's player count, as best the API can know it: the latest roster snapshot the worker
   * records every minute. Null = no usable answer (never sampled, or the snapshot is stale enough
   * that the ingest is clearly down) — and the population gate HOLDS FIRE on null rather than
   * guessing, the same evidence rule as every reconciler.
   */
  private async playerCountFor(serverId: string): Promise<number | null> {
    const hit = this.countCache.get(serverId);
    const now = Date.now();
    if (hit && now - hit.atMs < 30_000) return hit.count;
    let count: number | null = null;
    try {
      const snap = await this.repo.rosterSnapshots.latest(serverId);
      if (snap && now - Date.parse(snap.ts) < 5 * 60_000) count = snap.playerCount;
    } catch { /* unreadable = unknown */ }
    this.countCache.set(serverId, { count, atMs: now });
    return count;
  }

  /**
   * Trip the safety valve: disable the rule, say why in the audit trail, and ping the rule's own
   * alert channel through the same pipeline as its firings. The rule is not deleted and not
   * dry-run — it is OFF, loudly, until a person has read what it was about to do.
   */
  private async tripBreaker(rule: RuleRow, server: ServerRow, hitCount: number): Promise<void> {
    // Events are handled concurrently, so two in-flight firings can both decide to trip. The
    // store is the arbiter: whoever finds the rule already off says nothing — one trip, one
    // audit entry, one ping.
    const current = await this.repo.enforcerRules.get(rule.id).catch(() => null);
    if (!current?.enabled) return;
    await this.repo.enforcerRules.update(rule.id, { enabled: false });
    await this.repo.audit.create({
      actorUserId: null, actorName: "enforcer", action: "rule.breaker",
      targetType: "rule", targetId: rule.id, targetName: rule.name, serverId: server.id,
      summary: `rule "${rule.name}" DISABLED ITSELF on ${server.name}: it acted on ${hitCount} players inside a minute (safety limit ${rule.breakerLimit}). Review the rule, then re-enable it.`,
      data: { ruleId: rule.id, breakerLimit: rule.breakerLimit, hitCount },
    }).catch(() => {});
    // Rides the existing "Rule fired" alert so it lands where this rule already reports.
    this.bus.emit("app.enforcement", {
      kind: "app.enforcement", serverId: server.id, ts: new Date().toISOString(),
      actorName: `${hitCount} players inside a minute`,
      data: {
        ruleName: rule.name, action: "DISABLED ITSELF (safety limit)", reason: null, hours: null,
        dryRun: false, error: null, alertEnabled: rule.alertEnabled !== false, alertChannelId: rule.alertChannelId ?? null,
      },
    });
    this.breakerWindow.delete(rule.id);
    await this.refresh();
    log.warn("rule breaker tripped", { rule: rule.id, name: rule.name, hitCount, limit: rule.breakerLimit });
  }

  async onEvent(e: EnforceEvent): Promise<void> {
    if (!e || typeof e.kind !== "string") return;
    this.trackLifecycle(e);
    for (const rule of this.rules) {
      // Group rules fire from the membership queue alone (runGroupEvents), schedules from their
      // clock (runSchedules) — never from something on the bus that merely wears the kind's name.
      if (isGroupTriggerKind(rule.eventKind) || rule.eventKind === SCHEDULE_KIND) continue;
      if (!matchesRule(rule, e)) continue;
      // The match-time window, before the threshold: an event outside the window must not count
      // toward it either. State events arrive already judged by the worker against its own clock.
      if (!isStateTriggerKind(rule.eventKind) && !(await this.matchWindowOpenFor(rule, e.serverId))) continue;
      if (!(await this.overThreshold(rule, e))) continue;
      try {
        await this.fire(rule, e);
      } catch (err) {
        log.warn("enforcer fire failed", { rule: rule.id, err: (err as Error).message });
      }
    }
  }

  /** Keep the idle clocks and the kick/ban memory current from the events flowing past anyway. */
  private trackLifecycle(e: EnforceEvent): void {
    if (!e.serverId) return;
    // A new match (or the end of one) makes the cached match start wrong at once — ask again.
    if (e.kind === "evt.match.started" || e.kind === "evt.match.ended") this.matchCache.delete(e.serverId);
    if (e.kind === "evt.player.kicked" || e.kind === "evt.player.banned") {
      // The game's KICK/BAN log lines carry a NAME and no id, so the id-gated branch this used to
      // share never saw them: the removal memory stayed empty, and the crash-VIP guard it exists
      // to arm read every enforced disconnect as a crash worth a queue skip — an AFK kick came
      // with a VIP as a parting gift. Remember the removal under whatever identity the line
      // offers; the guard checks both keys.
      if (e.actorPlayerId) {
        this.idleClocks.delete(`${e.serverId}|${e.actorPlayerId}`);
        this.recentRemovals.set(`${e.serverId}|${e.actorPlayerId}`, Date.now());
      }
      if (e.actorName) this.recentRemovals.set(`${e.serverId}|name:${e.actorName}`, Date.now());
      return;
    }
    if (!e.actorPlayerId) return;
    const key = `${e.serverId}|${e.actorPlayerId}`;
    if (e.kind === "evt.player.connected") {
      // The seat is occupied again, by direct evidence — a kicked player who rejoined must be
      // reachable by messages and punishes immediately, not muted for the removal memory's TTL.
      this.recentRemovals.delete(key);
      if (e.actorName) this.recentRemovals.delete(`${e.serverId}|name:${e.actorName}`);
    }
    if (e.kind === "evt.player.connected" || e.kind === "evt.kill" || e.kind === "evt.teamkill") {
      this.idleClocks.set(key, {
        serverId: e.serverId, actorPlayerId: e.actorPlayerId, actorName: e.actorName ?? "",
        lastActiveMs: Date.parse(e.ts ?? "") || Date.now(),
      });
    } else if (e.kind === "evt.player.disconnected") {
      this.idleClocks.delete(key);
    }
  }

  /**
   * Walk the idle clocks against every enabled `app.idle` rule. Public so tests can drive it
   * directly; in production the sweep timer calls it once a minute. Only players the enforcer has
   * SEEN connect or kill are on the clock — after a restart, the already-connected-and-silent are
   * invisible until their next event, which misses some AFKs briefly and never flags anyone
   * wrongly. Nor is anybody the sessions no longer place on that server (dropDepartedClocks).
   */
  async runIdleSweep(): Promise<void> {
    const now = Date.now();
    if (!(await this.dropDepartedClocks(now))) return;
    const idleRules = this.rules.filter((r) => ruleLive(r) && r.eventKind === IDLE_KIND);
    if (!idleRules.length) {
      this.idleFiredAt.clear();
      return;
    }
    for (const rule of idleRules) {
      const windowMs = Math.max(IDLE_WINDOW_MIN_MS, (rule.windowSec || 0) * 1000);
      for (const [key, clock] of this.idleClocks) {
        if (now - clock.lastActiveMs < windowMs) continue;
        const firedKey = `${rule.id}|${key}`;
        if (now - (this.idleFiredAt.get(firedKey) ?? 0) < windowMs) continue; // one firing per window
        const e: EnforceEvent = {
          kind: IDLE_KIND, serverId: clock.serverId, actorPlayerId: clock.actorPlayerId,
          actorName: clock.actorName, ts: new Date().toISOString(),
        };
        if (!matchesRule(rule, e)) continue; // server scope + the optional name regex
        if (!(await this.matchWindowOpenFor(rule, e.serverId))) continue;
        this.idleFiredAt.set(firedKey, now);
        try {
          await this.fire(rule, e);
        } catch (err) {
          log.warn("enforcer idle fire failed", { rule: rule.id, err: (err as Error).message });
        }
      }
    }
    for (const k of this.idleFiredAt.keys()) {
      if (!this.idleClocks.has(k.slice(k.indexOf("|") + 1))) this.idleFiredAt.delete(k);
    }
  }

  /**
   * Take off the clock everybody who left without a disconnect the log reported.
   *
   * A clock ends on the DISCONNECTED line, and the game does not always write one: a server crash
   * or restart logs nothing, and a worker restart misses what happened while it was down. The
   * clock then ran on for somebody who was gone, for the life of the process — and an idle rule
   * fired on them every window, climbing its ladder as it went, up to a ban step that lands on a
   * player id whether or not anyone is there. The open sessions are the presence the worker keeps
   * honest from the live roster (it closes the ones the roster no longer backs), and what a delayed
   * action re-checks before it acts.
   *
   * Only clocks quiet for the shortest window are asked about; nobody else can be idle yet.
   * Returns false when presence could not be read: unknown is neither here nor gone, so that round
   * fires nothing and drops nothing.
   */
  private async dropDepartedClocks(now: number): Promise<boolean> {
    const quiet = [...this.idleClocks].filter(([, clock]) => now - clock.lastActiveMs >= IDLE_WINDOW_MIN_MS);
    if (!quiet.length) return true;
    const on = await this.repo.sessions.openServersFor([...new Set(quiet.map(([, clock]) => clock.actorPlayerId))]).catch(() => null);
    if (!on) return false;
    for (const [key, clock] of quiet) {
      // Only the clock that was asked about: a reconnect while the read ran started a new one.
      if (this.idleClocks.get(key) === clock && !on.get(clock.actorPlayerId)?.includes(clock.serverId)) this.idleClocks.delete(key);
    }
    return true;
  }

  /** Sliding-window threshold: fire once the same SUBJECT hits `threshold` matches within the
   *  window, then reset their window (cooldown) so it doesn't spam. Counting the subject rather
   *  than the actor is what makes "died 5 times in 60 seconds" mean the player who kept dying. */
  /**
   * The group triggers: drain the store's queue of membership changes and fire the rules watching
   * each group.
   *
   * A change belongs to no server, so each matching rule fans it out — to its own server, or for a
   * community-wide rule to every server — but only to servers of the member's OWN game: groups mix
   * both games' accounts, and a WW2 Steam64 granted VIP on a Vietnam server is a write that matches
   * nobody. Some changes have to WAIT for their member: a console id the directory has never seen
   * could be either game, and a Steam64 it has not met has no profile for points, a tag, a cap or
   * a role gate to work on (VIP and a note need only the id). Those rules wait — the change goes
   * back in the queue for them alone and is looked at again every few minutes, firing once the
   * member has joined a server, for up to GROUP_EVENT_WAIT_MS — while the rest fire now.
   *
   * Taking is claiming, so a change fires once even with two API processes, and stays queued while
   * it runs so the member's next change waits behind it everywhere; one that arrives with no rule
   * watching is simply consumed. A waiting change is dropped once a later change of the same
   * member is queued behind it (they were removed, or added back, meanwhile), and a rule acts only
   * on changes made after it was last saved. The rules are read fresh for each batch (not from the
   * cache another process's edit may not have reached), before anything is taken. Single-flight:
   * a route's nudge and the timer share a run.
   */
  runGroupEvents(): Promise<void> {
    // A restore is replacing the tables underneath: memberships, rules and players are half
    // loaded. The queue keeps until it is done (the marker is the API's own, written by the restore).
    if (restoreInProgress()) return Promise.resolve();
    if (this.groupDrain) return this.groupDrain;
    this.groupDrain = this.drainGroupEvents().finally(() => { this.groupDrain = null; });
    return this.groupDrain;
  }

  private async drainGroupEvents(): Promise<void> {
    // Until the queue reads empty — not until a short batch — so a change queued while this run
    // was busy (the nudge that found it in flight and joined it) is still this run's to fire.
    // A change this run put back to wait is not this run's again, however soon it comes due.
    const putBack = new Set<string>();
    for (;;) {
      // Read before taking: a rules or servers read that fails leaves the queue as it is.
      const rules = (await this.repo.enforcerRules.list()).filter((r) => ruleLive(r) && isGroupTriggerKind(r.eventKind));
      const servers = await this.repo.servers.list();
      const events = await this.repo.playerGroups.takeEvents(GROUP_EVENT_BATCH);
      if (!events.length) return;
      const again = events.filter((ev) => putBack.has(ev.id));
      for (const ev of again) await this.repo.playerGroups.deferEvent(ev, ev.notBefore, ev.ruleIds).catch(() => {});
      const now = events.filter((ev) => !putBack.has(ev.id));
      if (!now.length) return;
      // No rule watches any group: every change is simply consumed.
      if (!rules.length) { await this.repo.playerGroups.ackEvents(now.map((ev) => ev.id)); continue; }
      for (const id of await this.fireGroupEvents(now, rules, servers)) putBack.add(id);
    }
  }

  /** Fires what can fire; finishes (acks) each change or puts it back to wait for its member, and
   *  returns the ids of the ones put back. */
  private async fireGroupEvents(events: PlayerGroupEventRow[], rules: RuleRow[], servers: ServerRow[]): Promise<string[]> {
    const deferred: string[] = [];
    const finish = (ev: PlayerGroupEventRow) => this.repo.playerGroups.ackEvents([ev.id]).catch((err) => {
      log.warn("a group membership change could not be finished — its claim lapses within the hour", { groupId: ev.groupId, playerId: ev.playerId, err: (err as Error).message });
    });
    // An unreadable directory places nobody by sighting; a Steam64 still places itself.
    const known = await this.repo.players.findByPlatformIds([...new Set(events.map((ev) => ev.playerId))]).catch(() => []);
    const rowById = new Map(known.map((pl) => [pl.platformId, pl]));
    const gameOf = new Map(known.map((pl) => [pl.platformId, pl.game]));
    const nowMs = Date.now();
    for (const ev of events) {
      const age = nowMs - Date.parse(ev.createdAt);
      // A change that has been waiting for its member keeps its own, longer clock below.
      const waited = ev.ruleIds !== null;
      if (!waited && age > GROUP_EVENT_STALE_MS) {
        log.warn("group membership change too old to act on — dropped", { groupId: ev.groupId, playerId: ev.playerId, at: ev.createdAt });
        await finish(ev);
        continue;
      }
      const kind = ev.kind === "joined" ? GROUP_JOINED_KIND : GROUP_LEFT_KIND;
      const row = rowById.get(ev.playerId) ?? null;
      const name = ev.playerName || row?.name || ev.playerId;
      /*
       * A change that waited is only still true if nothing moved since: a later change of the same
       * member queued behind it, or the membership as it stands now (a deleted group queues no
       * change of its own), says they were removed — or added back — meanwhile. Then nothing it
       * waited for is done, whether or not the member has turned up in the meantime.
       */
      /*
       * How a wait ends, said where the wait was said (a rule's status is kept per server), so it
       * replaces the "waiting" line: on the first server the member could not yet be placed on, as
       * when they had not been seen, and on the first of their own game's, as when they had no
       * profile. `except`: servers the change has just run on, whose own record says so.
       */
      const endWait = (r: RuleRow, why: string, except: ReadonlySet<string> = new Set()) => {
        const targets = r.serverId ? servers.filter((sv) => sv.id === r.serverId) : servers;
        const slots = new Set<string>();
        const unseen = targets.find((sv) => memberGameVerdict(ev.playerId, sv.game, new Map()) !== "otherGame");
        const own = targets.find((sv) => memberGameVerdict(ev.playerId, sv.game, gameOf) === "ok");
        if (unseen) slots.add(unseen.id);
        if (own) slots.add(own.id);
        for (const sid of slots) if (!except.has(sid)) this.held(r, sid, why, name);
      };
      if (waited) {
        const pending = rules.filter((r) => ev.ruleIds!.includes(r.id));
        const noteAll = (why: string) => { for (const r of pending) endWait(r, why); };
        let listed: boolean | null = null;
        if (!ev.superseded) {
          try { listed = (await this.repo.playerGroups.groupsForPlayer(ev.playerId)).some((g) => g.id === ev.groupId); }
          catch {
            // Can't tell: it waits another round rather than act on a membership it could not read.
            try { await this.repo.playerGroups.deferEvent(ev, new Date(nowMs + this.groupRetryMs).toISOString(), ev.ruleIds); deferred.push(ev.id); }
            catch { await finish(ev); }
            continue;
          }
        }
        if (ev.superseded || (kind === GROUP_JOINED_KIND ? !listed : listed)) {
          noteAll(kind === GROUP_JOINED_KIND
            ? "was removed before it could run (or the group was deleted) — nothing was done"
            : "was added back before it could run — nothing was done");
          await finish(ev);
          continue;
        }
      }
      const waiting: { rule: RuleRow; serverId: string; why: string }[] = [];
      for (const rule of rules) {
        const waitedFor = waited && ev.ruleIds!.includes(rule.id);
        if (rule.eventKind !== kind || resolveTriggerParams(kind, rule.params).groupId !== ev.groupId) {
          // Pointed at another group (or the other kind of change) while this waited for it.
          if (waitedFor) endWait(rule, "the rule was changed while this waited — nothing was done");
          continue;
        }
        if (waited && !waitedFor) continue;
        const targets = rule.serverId ? servers.filter((sv) => sv.id === rule.serverId) : servers;
        if (!targets.length) continue;
        // A rule acts on the changes made after it was last saved. One saved since — switched out
        // of its trial run, its action or servers edited, or new — never acts on an older change
        // that waited (or queued) through the save: whoever made the change was checked against the
        // keys of the rule as it stood then (membershipKeyMissing), not as it stands now.
        if (Date.parse(rule.updatedAt) > Date.parse(ev.createdAt)) {
          if (waited) endWait(rule, "the rule was saved after this change was made, so it doesn't act on it");
          continue;
        }
        // Saved through the rule editor, a group rule can only do what reaches an absent player; a
        // rule that arrived by import or restore never went through it, so it is asked again here.
        const steps = [rule.action, ...(rule.escalateActions ?? [])];
        if (steps.some((a) => !GROUP_RULE_ACTIONS.has(a))) {
          const why = "its action isn't one a group rule can take (VIP, points, a tag or a note) — open the rule and save it again";
          if (waited) endWait(rule, why); else this.held(rule, targets[0]!.id, why, name);
          continue;
        }
        const unplaced = targets.find((sv) => memberGameVerdict(ev.playerId, sv.game, gameOf) === "notSeen");
        if (unplaced) {
          waiting.push({ rule, serverId: unplaced.id, why: "hasn't been seen on a server yet (a console id could belong to either game)" });
          continue;
        }
        const eligible = targets.filter((sv) => memberGameVerdict(ev.playerId, sv.game, gameOf) === "ok");
        // Seen at last — on the other game: none of this rule's servers is theirs.
        if (waited && !eligible.length) { endWait(rule, "turned out to play the other game — nothing was done here"); continue; }
        if (!row && groupRuleNeedsProfile(rule) && eligible.length) {
          waiting.push({ rule, serverId: eligible[0]!.id, why: "has no profile yet (points, a tag, a limit or a role check need one)" });
          continue;
        }
        // VIP lives per server, so it lands on each of the member's game's servers. Everything else
        // a group rule does — points, a tag, a note — belongs to the PLAYER, and doing it once per
        // server would pay them twice; it fires once, on a server whose rules run when there is one
        // (where they are switched off it would be a trial run), else an armed one.
        const runsRules = (sv: ServerRow) => sv.engagementMode === "active" && automationEnabled(sv.automation, "autosettings");
        const at = rule.action === "vip"
          ? eligible
          : [...eligible.filter(runsRules), ...eligible.filter((sv) => !runsRules(sv) && sv.engagementMode === "active"), ...eligible.filter((sv) => sv.engagementMode !== "active")].slice(0, 1);
        const ranOn = new Map<string, string>();
        for (const server of at) {
          const e: EnforceEvent = {
            kind, serverId: server.id,
            actorPlayerId: row && row.game === server.game ? row.id : null,
            actorName: name,
            ts: ev.createdAt,
            data: {
              groupId: ev.groupId, groupName: ev.groupName, playerId: ev.playerId,
              violation: kind === GROUP_JOINED_KIND ? `added to group "${ev.groupName}"` : `removed from group "${ev.groupName}"`,
            },
          };
          if (!matchesRule(rule, e)) continue;
          ranOn.set(server.id, server.name);
          try {
            await this.fire(rule, e);
          } catch (err) {
            log.warn("enforcer group rule failed", { rule: rule.id, err: (err as Error).message });
          }
        }
        // Where the wait was said on a server it did not run on (a console id said on the first
        // server, run on their own game's), that line ends too.
        if (waited) endWait(rule, ranOn.size ? `the wait is over — it ran on ${[...ranOn.values()].join(", ")}` : "the wait is over, but it no longer matched the rule — nothing was done", new Set(ranOn.keys()));
      }
      if (!waiting.length) { await finish(ev); continue; }
      // A later change of the same member is queued behind this one: they were removed (or added
      // back) since, so what waited for them here is moot — and their next change goes on now.
      if (ev.superseded) {
        for (const w of waiting) this.held(w.rule, w.serverId, `${w.why}, and was ${kind === GROUP_JOINED_KIND ? "removed" : "added back"} before it could run — nothing was done`, name);
        await finish(ev);
        continue;
      }
      // Waiting has an end: a member never seen in a month is not coming for this change.
      if (age > GROUP_EVENT_WAIT_MS) {
        for (const w of waiting) this.held(w.rule, w.serverId, `${w.why} and still hadn't joined a server ${Math.round(GROUP_EVENT_WAIT_MS / 86_400_000)} days later — nothing was done`, name);
        await finish(ev);
        continue;
      }
      try {
        await this.repo.playerGroups.deferEvent(ev, new Date(nowMs + this.groupRetryMs).toISOString(), waiting.map((w) => w.rule.id));
        deferred.push(ev.id);
        for (const w of waiting) this.held(w.rule, w.serverId, `waiting: ${w.why} — it runs when they first join a server`, name);
      } catch (err) {
        log.warn("a group membership change could not be put back to wait — dropped", { groupId: ev.groupId, playerId: ev.playerId, err: (err as Error).message });
        for (const w of waiting) this.held(w.rule, w.serverId, `${w.why}, and the change couldn't be kept waiting (a database error) — nothing was done`, name);
        await finish(ev);
      }
    }
    return deferred;
  }

  /**
   * The schedule trigger's clock: for each scheduled rule, the latest occurrence at or before now
   * (the 1st of this month at 00:00, last Saturday at 20:00…), in the community's timezone — run
   * once, if this is the first look at it since it came round.
   *
   * "Once" is the database's: claiming an occurrence inserts its row, so two API processes, a
   * restart, or a minute that overruns can never run one twice. "Catch up" falls out of asking
   * for the LATEST occurrence: one missed while the panel was down runs when it is back, and only
   * that one — a month of downtime does not pay out four Saturdays at once. An occurrence that
   * passed before the rule was last saved (created, edited, switched on) is not run: saving a
   * rule never fires a moment already gone. A restore stands the clock down until it is done.
   */
  runSchedules(now: Date = new Date()): Promise<void> {
    if (restoreInProgress()) return Promise.resolve();
    if (this.scheduleRun) return this.scheduleRun;
    this.scheduleRun = this.checkSchedules(now).finally(() => { this.scheduleRun = null; });
    return this.scheduleRun;
  }

  private async checkSchedules(now: Date): Promise<void> {
    // Its OWN switch on — a rule held only by its section is still read here, so the date it misses
    // is marked skipped rather than left to run late (below).
    const candidates = this.rules.filter((r) => r.enabled && r.eventKind === SCHEDULE_KIND);
    if (!candidates.length) return;
    // The community's clock decides which occurrence is due. A read that fails waits for the next
    // tick rather than guess UTC — that would run (and claim) a monthly grant hours early.
    let config;
    try { config = await this.repo.appConfig.get(); } catch (err) {
      log.warn("schedules: the community time zone couldn't be read — the clock waits a tick", { err: (err as Error).message });
      return;
    }
    const tz = safeTimezone(config?.timezone);
    for (const cached of candidates) {
      if (!this.occurrenceDue(cached, now, tz)) continue;
      // Re-read before claiming: the rule as it stands now decides — switched off or edited in
      // the last few seconds, it is judged on what it says, not on the cached copy.
      const rule = await this.repo.enforcerRules.get(cached.id).catch(() => null);
      if (!rule?.enabled || rule.eventKind !== SCHEDULE_KIND) continue;
      const occ = this.occurrenceDue(rule, now, tz);
      if (!occ) continue;
      if (!ruleSwitchedOn(rule)) {
        // Its section is switched off: this date is SKIPPED, not saved for later. Claimed, so
        // switching the section back on cannot run a grant (or a cut) that came due while it was
        // off — the same as a rule switched off and on again, whose save moves its start past it.
        if (await this.repo.enforcerRules.claimOccurrence(rule.id, occ.key).catch(() => false)) {
          await this.scheduleSkipped(rule, occ, tz, "its section on the Rules page was switched off");
        }
        continue;
      }
      if (rulePaused(rule, now.getTime())) {
        // Paused: skipped the same way — a pause holds fire, it does not queue it for later.
        if (await this.repo.enforcerRules.claimOccurrence(rule.id, occ.key).catch(() => false)) {
          const until = new Date(rule.pausedUntil!).toISOString().replace("T", " ").slice(0, 16);
          await this.scheduleSkipped(rule, occ, tz, `it was paused until ${until} UTC${rule.pauseReason ? ` (${rule.pauseReason})` : ""}`);
        }
        continue;
      }
      // The editor only saves the four schedule actions; a rule that came in by import or restore
      // never went through it. Anything else is held, unclaimed, until someone saves it properly.
      if (!SCHEDULE_ACTIONS.has(rule.action)) {
        const sid = rule.serverId ?? (await this.repo.servers.list().catch(() => []))[0]?.id;
        if (sid) this.held(rule, sid, "its action isn't one a schedule can take (grant, take away or cut back timed VIP) — open the rule and save it again");
        continue;
      }
      if (!(await this.repo.enforcerRules.claimOccurrence(rule.id, occ.key).catch(() => false))) continue;
      try {
        await this.runSchedule(rule, occ, tz);
      } catch (err) {
        log.warn("scheduled rule failed", { rule: rule.id, occurrence: occ.key, err: (err as Error).message });
      }
    }
  }

  /** A date a held schedule rule let pass: said on the rule card and in the audit trail, so "why
   *  didn't the monthly VIP happen" has an answer. Not an enforcer.* entry — it fired on no one. */
  private async scheduleSkipped(rule: RuleRow, occ: Occurrence, tz: string, why: string): Promise<void> {
    const sid = rule.serverId ?? (await this.repo.servers.list().catch(() => []))[0]?.id;
    if (sid) this.held(rule, sid, `it came round while ${why}, so that date was skipped`);
    await this.repo.audit.create({
      actorUserId: null, actorName: "enforcer", action: "rule.schedule.skipped",
      targetType: "rule", targetId: rule.id, targetName: rule.name, serverId: rule.serverId,
      summary: `scheduled rule "${rule.name}" came round (${describeRecurrence(scheduleOf(rule.params))}, ${tz}) while ${why} — nothing was done; it runs again on its next date`,
      data: { ruleId: rule.id, occurrence: occ.key, why },
    }).catch((err) => log.warn("schedule skip not recorded", { rule: rule.id, err: (err as Error).message }));
  }

  /** The occurrence of this rule that is due now, or null. */
  private occurrenceDue(rule: RuleRow, now: Date, tz: string): Occurrence | null {
    const occ = latestOccurrence(scheduleOf(rule.params), now, tz);
    if (!occ) return null;
    return occ.at.getTime() >= Date.parse(rule.updatedAt) ? occ : null;
  }

  private async runSchedule(rule: RuleRow, occ: Occurrence, tz: string): Promise<void> {
    const run = await runScheduleOccurrence({
      repo: this.repo,
      exec: (server, action, params) => this.pacedExecute(server, true, action, params),
      gameVipIds: (server) => this.gameVipIds(server),
    }, rule, occ.key);
    const when = `${describeRecurrence(scheduleOf(rule.params))} (${tz})`;
    const applied = run.results.filter((r) => r.applied);
    const skipped = run.results.filter((r) => !r.applied);
    const players = new Set(applied.map((r) => r.playerId)).size;
    const verb = rule.action === "vip" ? "granted VIP to" : rule.action === "viprevoke" ? "revoked timed VIP from" : "cut back timed VIP for";
    const summary = run.groupName === null
      ? `scheduled rule "${rule.name}" came round (${when}) but its group no longer exists — nothing was done`
      : `${run.dryRun ? "[trial run] " : ""}scheduled rule "${rule.name}" (${when}): ${run.dryRun ? "would have " : ""}${verb} ${players} of ${run.members} member${run.members === 1 ? "" : "s"} of "${run.groupName}"`
        + `${skipped.length ? ` — ${skipped.length} left alone` : ""}${run.serverSkips.length ? `; skipped ${run.serverSkips.map((x) => `${x.serverName} (${x.reason})`).join(", ")}` : ""}`;
    if (run.groupName === null) {
      // The rule card reads its "held back" line per server: a community-wide rule's goes on the first.
      const sid = rule.serverId ?? (await this.repo.servers.list().catch(() => []))[0]?.id;
      if (sid) this.held(rule, sid, "its group no longer exists — pick another group or delete the rule");
    }
    await this.repo.audit.create({
      actorUserId: null, actorName: "enforcer", action: "enforcer.schedule",
      targetType: "rule", targetId: rule.id, targetName: rule.name, serverId: rule.serverId,
      summary,
      data: {
        ruleId: rule.id, ruleName: rule.name, eventKind: rule.eventKind, action: rule.action, occurrence: occ.key,
        dryRun: run.dryRun, groupName: run.groupName, members: run.members, applied: applied.length, players,
        // The receipt, bounded: who was left alone and why reads best on the record itself.
        skipped: skipped.slice(0, 100).map((r) => ({ playerId: r.playerId, playerName: r.playerName, serverName: r.serverName, why: r.note })),
        serverSkips: run.serverSkips,
      },
    });
    // A community-wide rule belongs to no one server: the Discord bot routes its alert by the
    // rule's own channel, else an automation channel a server has switched on (communityWide).
    this.bus.emit("app.enforcement", {
      kind: "app.enforcement", serverId: rule.serverId ?? undefined, ts: new Date().toISOString(), actorName: run.groupName ?? rule.name,
      data: {
        ruleName: rule.name, action: rule.action, reason: summary, hours: null,
        dryRun: run.dryRun, error: run.groupName === null ? "the group no longer exists" : null,
        alertEnabled: rule.alertEnabled !== false, alertChannelId: rule.alertChannelId ?? null,
        ...(rule.serverId ? {} : { communityWide: true }),
      },
    });
  }

  private async overThreshold(rule: RuleRow, e: EnforceEvent): Promise<boolean> {
    if ((rule.threshold ?? 1) <= 1) return true;
    const subject = ruleSubject(rule, e);
    // `subject.playerId` is genuinely null when unresolved (unlike perform()'s `playerId`, which is
    // an initialised ""), so `??` does fall through to the name here and each named subject keeps
    // its own window. Only a subject with NO name at all shares one, which is the correct reading:
    // there is nothing to tell those events apart by.
    // A per-match count is one server's: a community-wide rule hears every server, and a hit in
    // another server's round falls inside this one's window without being any part of its match.
    // (A time window stays the player's across servers — they are on one at a time.)
    const key = `${rule.id}|${rule.countPerMatch ? `${e.serverId ?? ""}|` : ""}${subject.playerId ?? subject.name ?? "?"}`;
    // Per match, the window opens at the match's start ("3 team kills in one match"); an unknown
    // start reads as the last RULE_MATCH_FALLBACK_MINUTES rather than as forever.
    const matchStart = rule.countPerMatch && e.serverId ? await this.matchStartFor(e.serverId) : null;
    const now = Date.now();
    const floor = rule.countPerMatch ? matchStart ?? now - RULE_MATCH_FALLBACK_MINUTES * 60_000 : now - rule.windowSec * 1000;
    const arr = (this.windows.get(key) ?? []).filter((t) => t >= floor);
    arr.push(now);
    if (arr.length >= rule.threshold) {
      this.windows.delete(key);
      return true;
    }
    this.windows.set(key, arr);
    return false;
  }

  private async fire(rule: RuleRow, e: EnforceEvent): Promise<void> {
    const serverId = e.serverId;
    if (!serverId) return;
    // Weapon-trigger firings carry their violation sentence like state events do, so `{violation}`
    // fills the same way in both. Computed here (not in matchesRule) so the pure matcher stays a
    // predicate; matchesRule has already proven this is non-null.
    if (rule.eventKind === WEAPON_TRIGGER_KIND) {
      const violation = restrictedWeaponReason(e.weapon, resolveTriggerParams(rule.eventKind, rule.params)) ?? "";
      e = { ...e, data: { ...(e.data ?? {}), violation } };
    }
    const server = await this.repo.servers.findById(serverId);
    if (!server) return;

    /*
     * Population bounds, judged where the count can be known. State events arrive ALREADY judged
     * — the worker gated them against the live roster it had in hand — so re-judging here against
     * a snapshot up to a minute old could only disagree with better evidence. Event rules have no
     * roster in hand, so the latest snapshot answers; an unknown count holds fire rather than
     * letting a dead ingest decide either way.
     */
    if ((rule.playersMin > 0 || rule.playersMax > 0) && !isStateTriggerKind(rule.eventKind) && !isGroupTriggerKind(rule.eventKind)) {
      const count = await this.playerCountFor(server.id);
      if (count === null) {
        log.warn("rule population gate unverifiable — holding fire", { rule: rule.id, serverId: server.id });
        this.held(rule, server.id, "the player count isn't known (no recent roster reading), so its player limits can't be checked");
        return;
      }
      if (rule.playersMin > 0 && count < rule.playersMin) return this.held(rule, server.id, `under its ${rule.playersMin}-player floor (${count} on)`);
      if (rule.playersMax > 0 && count > rule.playersMax) return this.held(rule, server.id, `over its ${rule.playersMax}-player ceiling (${count} on)`);
    }

    // Resolve the SUBJECT's in-game id (needed for the RCON command) via our player record. For a
    // death rule that is the victim, not the killer.
    const subject = ruleSubject(rule, e);
    let playerId = "";
    let playerName = subject.name;
    let subjectLevel: number | null = null;
    if (subject.playerId) {
      const pl = await this.repo.players.findById(subject.playerId);
      if (pl) {
        playerId = pl.platformId;
        playerName = pl.name || playerName;
        subjectLevel = pl.level ?? null;
      }
    }
    // A group member the directory has not met yet (a Steam64 added by id before their first
    // visit) has no profile to resolve, but the member id IS their game id — and the drain only
    // hands one over for a server of their own game.
    if (!playerId && isGroupTriggerKind(rule.eventKind) && typeof e.data?.playerId === "string") playerId = e.data.playerId;
    // NO early return on a missing game id. Which actions need one depends on the LADDER STEP,
    // not on the rule, so the check belongs in perform() where the step is known — a `note`
    // issues no game command and must fire on the name alone. Admin-camera lines are exactly
    // where this bites: a camera line with no resolvable player id is routine (see the
    // adminCam.open comment in postgres.ts), so requiring one here made cam-notify rules
    // silently never fire on the servers that need them most.

    // A group change can name a member with no profile yet (a Steam64 added by id before their
    // first visit). Nothing about them can be read — not their Discord roles, not their tags — so a
    // group rule that gates or exempts on either holds rather than act on a guess.
    if (isGroupTriggerKind(rule.eventKind) && !subject.playerId && (rule.requireRoleIds.length || rule.immuneRoleIds?.length || rule.immuneTags?.length)) {
      return this.held(rule, server.id, "the player has no profile yet, so the rule's Discord-role and tag checks can't be made", playerName);
    }
    // The Discord role gate, before any wait: identity is static, so an ineligible player never
    // occupies a timer. "Could not ask" is not "doesn't hold it" — the rule holds fire and says
    // so, rather than letting a Discord outage decide either way.
    if (rule.requireRoleIds.length && subject.playerId) {
      const held = await this.discordRoles(subject.playerId);
      if (held === null) {
        log.warn("enforcer rule skipped: Discord role gate unverifiable", { rule: rule.id, playerId });
        return this.held(rule, server.id, "Discord couldn't be reached to check the required roles", playerName);
      }
      if (!held.some((r) => rule.requireRoleIds.includes(r))) return this.held(rule, server.id, "doesn't hold a required Discord role (or has no Discord link)", playerName);
    }

    /*
     * The EXEMPTIONS, checked before the delay for the same reason: an exempt player never
     * occupies a timer.
     *
     * "Could not ask" holds fire here exactly as it does for the required-role gate above, and
     * for the stronger reason: an unverifiable answer on an inclusion gate risks not punishing a
     * stranger, while an unverifiable answer on an EXEMPTION risks punishing your own admin. Both
     * mistakes are avoided by doing nothing until Discord can be reached.
     */
    // Level first: it is already in hand from the player row resolved above, so an exempt
    // newcomer never costs a tag read or a Discord call. Unknown level is NOT exemption — a
    // player we have never seen on a roster is not evidence of a low one.
    if ((rule.immuneLevel ?? 0) > 0 && subjectLevel !== null && subjectLevel > 0 && subjectLevel <= rule.immuneLevel) return this.held(rule, server.id, `exempt: level ${subjectLevel}`, playerName);
    // One tag read serves both tag checks below.
    let tagLabels: string[] | null | undefined;
    const readTags = async (id: string): Promise<string[] | null> => {
      if (tagLabels === undefined) tagLabels = await this.repo.playerTags.list(id).then((ts) => ts.map((t) => t.label), () => null);
      return tagLabels;
    };
    // The positive tag gate: only players carrying one of these tags. A subject with no profile
    // carries no tags, so it is not in the set; an unreadable list holds fire, like the role gate.
    if (rule.requireTags?.length) {
      if (!subject.playerId) return this.held(rule, server.id, "the player has no profile, so no tags", playerName);
      const tags = await readTags(subject.playerId);
      if (tags === null) {
        log.warn("enforcer rule skipped: required tags unreadable", { rule: rule.id, playerId });
        return this.held(rule, server.id, "the player's tags couldn't be read", playerName);
      }
      if (!tags.some((t) => rule.requireTags.includes(t))) return this.held(rule, server.id, "doesn't carry a required tag", playerName);
    }
    if (rule.immuneTags?.length && subject.playerId) {
      const tags = await readTags(subject.playerId);
      if (tags === null) {
        log.warn("enforcer rule skipped: immune tags unreadable", { rule: rule.id, playerId });
        return this.held(rule, server.id, "the player's tags couldn't be read", playerName);
      }
      if (tags.some((t) => rule.immuneTags.includes(t))) return this.held(rule, server.id, "exempt: carries an exempt tag", playerName);
    }
    if (rule.immuneRoleIds?.length && subject.playerId) {
      const held = await this.discordRoles(subject.playerId);
      if (held === null) {
        log.warn("enforcer rule skipped: exempt-role gate unverifiable", { rule: rule.id, playerId });
        return this.held(rule, server.id, "Discord couldn't be reached to check the exempt roles", playerName);
      }
      if (held.some((r) => rule.immuneRoleIds.includes(r))) return this.held(rule, server.id, "exempt: holds an exempt Discord role", playerName);
    }

    // The delay: act delaySec later, re-checking presence then — a welcome 30 seconds in, a kick
    // only if they are still here, a crash VIP only if they are still gone.
    if ((rule.delaySec ?? 0) > 0) {
      const timer = setTimeout(() => {
        this.pending.delete(timer);
        background(log, "enforcer delayed action", async () => {
          // Up to an hour can pass. Act under the rule and server AS THEY ARE NOW, not as they were
          // when this was queued: a rule switched off or deleted in the meantime does nothing, and
          // a server flipped to observe mode gets a dry run — the master safety must not be
          // outrun by a timer.
          const [nowRule, nowServer] = await Promise.all([
            this.repo.enforcerRules.get(rule.id).catch(() => null),
            this.repo.servers.findById(server.id).catch(() => null),
          ]);
          if (!nowRule || !ruleLive(nowRule) || !nowServer) return;
          if (nowRule.serverId && nowRule.serverId !== nowServer.id) return;
          await this.perform(nowRule, e, nowServer, subject.playerId, playerId, playerName, true);
        });
      }, rule.delaySec * 1000);
      timer.unref?.();
      this.pending.add(timer);
      return;
    }
    // Undelayed, the triggering event itself is the presence truth: a player who just connected
    // is here, one who just disconnected is gone. No session read needed (or trustworthy — the
    // session row settles in the same ingest batch this event arrived from).
    await this.perform(rule, e, server, subject.playerId, playerId, playerName, false);
  }

  /**
   * Where this player currently sits on the rule's ladder (decay applied) — a PEEK, no advance.
   * The step decides the action, and the action decides the presence semantics below, so it must
   * be known before the short-circuits; but a short-circuited firing must not climb the ladder,
   * so advancing waits until the moment we commit.
   */
  private ladderStep(rule: RuleRow, key: string, nowMs: number): number {
    if (!rule.escalateActions?.length) return 0;
    const st = this.offences.get(key);
    if (!st) return 0;
    const resetMs = (rule.escalateResetMinutes ?? 120) * 60_000;
    if (resetMs > 0 && nowMs - st.lastMs > resetMs) { this.offences.delete(key); return 0; }
    return st.count;
  }

  private async perform(rule: RuleRow, e: EnforceEvent, server: ServerRow, subjectId: string | null, playerId: string, playerName: string, recheckPresence: boolean): Promise<void> {
    // The EFFECTIVE action for this firing: the rule's own action on a first offence, then its
    // escalation steps on repeats, the last step repeating. steps[] is never empty, so a rule
    // without a ladder behaves exactly as it always has.
    const nowMs = Date.now();
    // Falls back to the NAME, like the threshold window's key already does. Now that a note can
    // fire with no ids at all, `??` alone would key every unidentified subject to the same empty
    // string — one shared ladder, so two different admins on cam would escalate each other.
    const ladderKey = `${rule.id}|${subjectId || playerId || playerName || "?"}`;
    const stateKind = isStateTriggerKind(e.kind);
    // A group change can be a crowd too — a Discord role handed to fifty people at once.
    const groupKind = isGroupTriggerKind(e.kind);
    const exec = (a: string, p: Record<string, unknown>) => this.pacedExecute(server, stateKind || groupKind, a, p);
    const steps = [rule.action, ...(rule.escalateActions ?? [])];
    const step = Math.min(this.ladderStep(rule, ladderKey, nowMs), steps.length - 1);
    const action = steps[step]!;
    if (!ENFORCER_ACTIONS.has(action)) {
      log.warn("enforcer rule skipped: an action no rule may take", { rule: rule.id, action });
      return this.held(rule, server.id, `its action "${action}" is not one a rule can take — open the rule and save it again`, playerName);
    }
    // Moving a player writes a team switch of its own: a team-switch rule that moves them would
    // fire on its own move, back and forth, for as long as they stayed. Saving refuses it now;
    // this holds the rules stored before it did (and any preset or restore that brings one back)
    // — the whole rule, wherever the move sits on its ladder, so it reads as broken rather than
    // messaging once and then stalling on the rung it can never take.
    if (e.kind === TEAM_SWITCH_KIND && steps.includes("switch")) {
      return this.held(rule, server.id, "a team-switch rule cannot move the player — the move is itself a team switch; open the rule and pick another action", playerName);
    }

    // Every action but `note` ends in an RCON command keyed by the game id, so without one there
    // is nothing to do — and a command naming an empty player would either error or, worse, be
    // accepted and match nobody. A note names the player only in the record, so it proceeds.
    if (!playerId && action !== "note") return this.held(rule, server.id, "the player's game id isn't known to the panel yet", playerName);

    // A player this enforcer (or a staff kick/ban the log reported) removed moments ago is not
    // there to message, punish, or kick again. The burst that got them banned keeps arriving for
    // a few more polls — kills logged before the removal — and each event re-fired presence
    // actions at an empty seat: commands the game refuses, reading as the bot hammering a player
    // it already banned. The memory is short (REMOVAL_MEMORY_MS) and a reconnect clears it, so a
    // kicked player who walks straight back in is reachable again.
    if (NEEDS_PRESENCE.has(action)) {
      if ((subjectId && this.recentRemovals.has(`${server.id}|${subjectId}`))
        || (playerName && this.recentRemovals.has(`${server.id}|name:${playerName}`))) return;
    }

    if (recheckPresence && subjectId) {
      const on = await this.repo.sessions.openServers(subjectId).catch(() => null);
      const present = on === null ? null : on.includes(server.id);
      if (action === "vip" && e.kind === DISCONNECT_KIND) {
        // A crash VIP holds fire unless the player is POSITIVELY still gone — back in (or
        // unknowable) means the queue is not their problem.
        if (present !== false) return;
      } else if (action === "vip" && present === false && !groupKind) {
        // A VIP from a roster rule (the no-VIP trigger) is for somebody who is HERE: one who left
        // during the wait has not stayed "N minutes", and the message after it would reach nobody.
        // A group rule's VIP never asked for presence — joining a group happens anywhere.
        return this.held(rule, server.id, "left before the wait ran out", playerName);
      } else if (NEEDS_PRESENCE.has(action) && present === false) {
        return; // they left before the delay ran out; there is nobody to message or kick
      }
    }
    if (action === "vip") {
      // A kick or ban explains the disconnect: enforcement, not a crash, and never rewarded.
      // Checked by id AND by name, because the game's own KICK line only carries the name.
      if (subjectId && this.recentRemovals.has(`${server.id}|${subjectId}`)) return;
      if (playerName && this.recentRemovals.has(`${server.id}|name:${playerName}`)) return;
      // VIP set on the GAME outside the panel has no row of ours, so vipWouldAdd below cannot see
      // it — and writing a dated row over it would hand it to the expiry sweep, which would take
      // the player's real VIP away when ours ran out. Read the game's own list; one we cannot read
      // grants nothing (the direction that can never cost a player their VIP).
      // A listed player WITH a row of ours is ours to extend (vipWouldAdd decides); only a listing
      // we hold no row for is the game-only VIP that must be left alone.
      const listed = await this.gameVipIds(server);
      if (listed === null) {
        log.warn("enforcer VIP skipped: the game's VIP list could not be read", { rule: rule.id, playerId });
        return this.held(rule, server.id, "the game's VIP list couldn't be read, so no VIP was granted", playerName);
      }
      if (listed.has(playerId) && !(await this.repo.vips.get(server.id, playerId).catch(() => null))) {
        return this.held(rule, server.id, "already VIP on the game's own list (set outside the panel)", playerName);
      }
      // A grant that already reaches further (or a pause staff imposed) always wins — the crash
      // grant may only ever ADD access, so with nothing to add there is nothing to do or audit.
      if (!(await this.vipWouldAdd(server, rule, playerId))) return this.held(rule, server.id, "already holds VIP that lasts at least as long (or is paused)", playerName);
      // The frequency limit. vipWouldAdd caps the CEILING (never more than vipMinutes from now,
      // never additive) but not the rate: without this, disconnecting just before each grant runs
      // out rolls the expiry forward forever — a permanent queue skip, farmed.
      if (await this.vipOnCooldown(server, rule, playerId)) return this.held(rule, server.id, "had VIP from this rule too recently (its once-per-player limit)", playerName);
    }

    // Automation has no name, so only the second signature line can apply — see applySignature.
    // A rule that fires on every teamkill would otherwise arrive as an unattributable sentence
    // with nowhere to appeal it, which is the exact gap signatures exist to close.
    const sign = automatedSignerFrom(await this.repo.signatures.get(), action);
    const plain = applyRuleVars(rule.reason ?? "", e, playerName, { points: String(rule.points ?? 0) });
    const signed = sign(plain);
    // A tempban with no hours goes out as Duration: 0 on the v2 wire — a ban that holds nobody,
    // recorded as a success. The legacy text path already clamps to a real duration; give v2 the
    // same floor (the editor's own default), which is what a ladder that escalates into tempban
    // on a rule saved before hours were required needs.
    const hours = action === "tempban" && !(rule.hours && rule.hours > 0) ? 2 : rule.hours ?? 0;
    const params: Record<string, unknown> = { playerId, reason: signed, message: signed, hours, adminName: "enforcer" };
    // Two independent reasons to hold fire, both downgrading to a dry run rather than to silence:
    // observe mode (the master safety), and the server's "Auto settings & rules" automation switch
    // being off — the staged-migration case where another system still owns enforcement there. The
    // audit trail still records what WOULD have fired, which is exactly what tuning rules against
    // real traffic before a handover needs.
    //
    // A note is exempt from both: it never touches the game, so there is nothing for observe mode
    // to protect — the record and the Discord ping ARE the action, and "tell me when someone goes
    // on admin cam" should keep working on a server that is otherwise read-only.
    // Three ways to hold fire, all downgrading to a dry run rather than to silence: the RULE's own
    // trial switch (this rule, deliberately, while its neighbours keep enforcing), and the two
    // environmental ones — observe mode and the server's automation switch. Only the environmental
    // pair exempt a `note`: they protect the GAME from writes, and a note issues none. The rule's
    // own switch means "I am not ready for this rule to do anything yet", which includes noting.
    const dryRun = rule.dryRun === true
      || (!APP_ONLY_ACTIONS.has(action) && (server.engagementMode !== "active" || !automationEnabled(server.automation, "autosettings")));
    /*
     * The circuit breaker, checked at the last gate before a real action: would acting on THIS
     * player push the rule past its safety limit of distinct players inside a minute? If so the
     * player is spared, the rule disables itself, and staff get told — a mistyped weapon list or
     * a too-high minimum level must not finish kicking half the server before anyone wakes up.
     * Dry-runs and notes never count and never trip: blast radius is measured in real actions.
     */
    /*
     * The per-player cap: at most capCount firings on this player per period, counted from the
     * rule's own rows in the audit trail (so a restart forgives nobody) plus the firings already
     * past this gate whose rows are not written yet — the check-and-reserve below runs without an
     * await between them, so two events in the same instant cannot both take the last slot. A
     * trial run counts its trial firings; a count we cannot read holds fire.
     */
    let releaseCap = (): void => {};
    if ((rule.capCount ?? 0) > 0) {
      if (!subjectId) {
        log.warn("enforcer rule skipped: a per-player cap needs a known player", { rule: rule.id, playerName });
        return this.held(rule, server.id, "its per-player limit needs a player with a profile", playerName);
      }
      const since = await this.capSince(rule, server.id, nowMs);
      const counted = await this.repo.enforcerRules.firingCount(rule.id, subjectId, since, dryRun).catch(() => null);
      if (counted === null) {
        log.warn("enforcer rule skipped: per-player cap unverifiable", { rule: rule.id, playerId });
        return this.held(rule, server.id, "its per-player limit couldn't be checked", playerName);
      }
      const capKey = `${rule.id}|${subjectId}|${dryRun ? "d" : "r"}`;
      const pending = this.capInflight.get(capKey) ?? 0;
      if (counted + pending >= rule.capCount) return this.held(rule, server.id, `reached its limit of ${rule.capCount} per ${rule.capPeriod === "ever" ? "player, ever" : rule.capPeriod}`, playerName);
      this.capInflight.set(capKey, pending + 1);
      let released = false;
      releaseCap = () => {
        if (released) return;
        released = true;
        const left = (this.capInflight.get(capKey) ?? 1) - 1;
        if (left > 0) this.capInflight.set(capKey, left);
        else this.capInflight.delete(capKey);
      };
    }

    if (!dryRun && !BREAKER_EXEMPT_ACTIONS.has(action) && (rule.breakerLimit ?? 10) > 0) {
      const nowBreaker = Date.now();
      const subjects = this.breakerWindow.get(rule.id) ?? new Map<string, number>();
      for (const [sub, at] of subjects) if (nowBreaker - at > 60_000) subjects.delete(sub);
      const subjectKey = subjectId || playerId || playerName || "?";
      if (!subjects.has(subjectKey) && subjects.size >= rule.breakerLimit) {
        releaseCap();
        await this.tripBreaker(rule, server, subjects.size + 1);
        return;
      }
      subjects.set(subjectKey, nowBreaker);
      this.breakerWindow.set(rule.id, subjects);
    }

    /*
     * NOW the ladder climbs — after the last gate that can still call the whole firing off.
     *
     * It used to advance further up, on the reasoning that every short-circuit was behind it. The
     * breaker is not: it SPARES this player (that is its entire purpose) and returns. Advancing
     * first meant a player the safety valve deliberately protected came out of it one rung
     * higher, so once staff fixed the rule and switched it back on, their next offence was met
     * with the step above the one they never received. Being spared must not cost anything.
     */
    if (rule.escalateActions?.length) this.offences.set(ladderKey, { count: step + 1, lastMs: nowMs });
    let error: string | undefined;
    // The crash VIP's expiry, recorded on the row so the player's VIP history can show the grant
    // their VIP status box is showing — it used to be the one grant that timeline never listed.
    let vipExpiration: string | null = null;
    let vipMessaged: boolean | null = null;
    const extra: Record<string, unknown> = {};
    // The rule's message after an action that carries one of its own (a grant, a switch): sent only
    // to a player who is here, and a message that fails leaves the action standing.
    const followUp = async (): Promise<void> => {
      if (e.kind === DISCONNECT_KIND || !(rule.reason ?? "").trim()) return;
      // A group change names somebody who may be on no server: message only one who is on this one.
      if (groupKind) {
        const on = subjectId ? await this.repo.sessions.openServers(subjectId).catch(() => null) : null;
        if (!on?.includes(server.id)) return;
      }
      vipMessaged = await exec("message", await renderActionText(this.repo, server, params, { playerId, playerName }))
        .then(() => true, () => false);
    };
    if (!dryRun) {
      try {
        if (action === "blacklist") await this.banForRule(server, rule, playerId, playerName, String(params.reason ?? ""), plain, exec);
        else if (action === "tag") {
          if (!subjectId) throw new Error("no player profile to tag");
          extra.tagged = await this.tagForRule(rule, subjectId, plain);
        } else if (action === "points") {
          if (!subjectId) throw new Error("no player profile to pay");
          Object.assign(extra, await this.pointsForRule(server, rule, subjectId));
          await followUp();
        } else if (action === "switch") {
          await exec("switch", { playerId });
          await followUp();
        }
        else if (action === "vip") {
          const granted = await this.vipForRule(server, rule, playerId, playerName, exec);
          // A hold that began after the read took the time into its frozen balance, or permanent
          // VIP granted meanwhile absorbed it: either way no date stood.
          if (granted.held) Object.assign(extra, { groupHeld: true, bankedMs: granted.held.bankedMs });
          else if (granted.expiration === null) Object.assign(extra, { keptPermanent: true });
          else vipExpiration = granted.expiration;
          // The rule's message, AFTER the grant so {vip_until}/{vip_remaining} read the VIP just
          // given. Only for players who are here — a crash VIP's player is by definition gone.
          // A message that fails leaves the grant standing; the row records it.
          await followUp();
        }
        // Shared placeholders ({vip_until}, {server_name}…) on top of the rule's own tokens,
        // filled for this player on this server — no reads unless the text uses one.
        else if (action !== "note") await exec(action, await renderActionText(this.repo, server, params, { playerId, playerName }));
      } catch (err) {
        error = (err as Error).message;
      }
      // The enforcer knows its own removals with full identity — remember them here too, so the
      // disconnect that follows one of its kicks or bans never reads as a crash, even when the
      // game's name-only KICK line is late or missed entirely.
      if (!error && (action === "kick" || action === "tempban" || action === "permaban" || action === "blacklist")) {
        if (subjectId) this.recentRemovals.set(`${server.id}|${subjectId}`, Date.now());
        if (playerName) this.recentRemovals.set(`${server.id}|name:${playerName}`, Date.now());
      }
    }

    // A capped rule's firing is counted in rule_firings (never trimmed), then the reservation is
    // released — from then on the count itself carries it. A failure spares the allowance.
    if ((rule.capCount ?? 0) > 0 && subjectId && !error) {
      await this.repo.enforcerRules.recordFiring(rule.id, subjectId, dryRun)
        .catch((err) => log.warn("could not count a capped rule's firing", { rule: rule.id, err: (err as Error).message }));
    }
    await this.repo.audit.create({
      actorUserId: null,
      actorName: "enforcer",
      action: dryRun ? "enforcer.dryrun" : error ? "enforcer.error" : `enforcer.${action}`,
      targetType: "player",
      targetId: subjectId ?? null,
      targetName: playerName,
      serverId: server.id,
      // The step is named when a ladder is climbing, so the trail reads "punish (offence 2/3)"
      // rather than leaving staff to wonder why the same rule did two different things.
      summary: `${dryRun ? "[dry-run] " : ""}rule "${rule.name}" → ${action}${steps.length > 1 ? ` (offence ${step + 1}${step + 1 >= steps.length ? "+" : ""} of ${steps.length})` : ""} ${playerName}${plain ? ` (${plain})` : ""}${error ? ` — FAILED: ${error}` : ""}`,
      /*
       * Enough for the profile to explain the decision without a lookup: which rule, what tripped
       * it, and where on the ladder it landed. The row carried only `ruleId` before, so the
       * moderation timeline could show that SOMETHING automated had acted and never what or why —
       * which is the first question anyone opens that row to answer, and the one an appeal turns
       * on. `ruleName` is denormalised deliberately: a rule that was later renamed or deleted must
       * not erase the reason a player was kicked six weeks ago.
       */
      data: {
        ruleId: rule.id, ruleName: rule.name, eventKind: rule.eventKind, action,
        ...(steps.length > 1 ? { escalationStep: step + 1, escalationOf: steps.length } : {}),
        playerId, dryRun, error,
        ...(vipExpiration && !error ? { expiration: vipExpiration } : {}),
        ...(vipMessaged !== null ? { messaged: vipMessaged } : {}),
        ...extra,
      },
    }).finally(releaseCap);

    // Tell Discord (when the server's "Rule fired" alert is configured): the bot relays this bus
    // event as an immediate alert, so staff see the auto-mod firing where they live.
    //
    // The event is emitted whatever the rule's alert setting says — it is the record that this
    // happened, and suppressing it would hide the firing from anything else that ever listens.
    // `alertEnabled` rides along and the DISCORD side decides, which is where "is this worth a
    // ping" belongs.
    this.bus.emit("app.enforcement", {
      kind: "app.enforcement",
      serverId: server.id,
      ts: new Date().toISOString(),
      actorName: playerName,
      data: {
        ruleName: rule.name, action, reason: rule.reason ?? null, hours: rule.hours ?? null,
        dryRun, error: error ?? null, alertEnabled: rule.alertEnabled !== false,
        // The rule's own destination rides along too; the Discord side falls back to the server's
        // shared "Player rules firing" channel when it is null.
        alertChannelId: rule.alertChannelId ?? null,
        // The player's profile in the panel, for the alert to link. Null when there is no
        // profile to open, or no panel address (see panel-links).
        profileUrl: playerProfileUrl(subjectId),
      },
    });
  }

  /**
   * The `blacklist` action is now a REAL ban — the game command plus a player_ban decision.
   *
   * It used to file a record that never reached the game: the "apply as a live ban" step its page
   * promised was never built, so a rule with this action quietly did nothing. That era is over,
   * and it is called out in the release note because a rule written expecting a no-op will start
   * banning people. Rule hours make it a temp ban; none make it permanent. Scoped to the server
   * the rule fired on — an automated action should never reach further than its own evidence.
   */
  /**
   * Whether this rule granted this player a crash VIP too recently to grant another.
   *
   * Read from the store rather than memory on purpose: this is the anti-farm limit, and one that
   * forgot everything on restart would be no limit at all — a deploy would open the window. A
   * cooldown of 0 disables it. An unreadable store answers "not on cooldown": the failure that
   * grants a VIP someone probably deserved beats the one that silently stops the feature working.
   */
  private async vipOnCooldown(server: ServerRow, rule: RuleRow, playerId: string): Promise<boolean> {
    const cooldownMs = (rule.vipCooldownMinutes ?? 0) * 60_000;
    if (cooldownMs <= 0) return false;
    const last = await this.repo.enforcerRules.lastVipGrantAt(rule.id, server.id, playerId).catch(() => null);
    if (!last) return false;
    const since = Date.now() - Date.parse(last);
    if (!Number.isFinite(since) || since >= cooldownMs) return false;
    log.info("enforcer crash VIP skipped: player still on cooldown", {
      rule: rule.id, playerId, minutesLeft: Math.ceil((cooldownMs - since) / 60_000),
    });
    return true;
  }

  /** Whether a crash-VIP grant would actually extend this player's access right now. */
  /**
   * The `tag` action: put the rule's tag on the player's profile. Already carrying it is not an
   * error and not a second row — returns whether a tag was added. The tag's note says which rule.
   */
  private async tagForRule(rule: RuleRow, subjectId: string, note: string): Promise<boolean> {
    const label = (rule.actionTag ?? "").trim();
    if (!label) throw new Error("the rule has no tag to add");
    const current = await this.repo.playerTags.list(subjectId);
    if (current.some((t) => t.label === label)) return false;
    await this.repo.playerTags.add({ playerId: subjectId, label, note: note || `added by rule "${rule.name}"`, createdByName: `rule "${rule.name}"` });
    return true;
  }

  /**
   * The `points` action: pay the rule's points to the Discord account linked to this player, through
   * the same ledger (and balance cap) every other payout uses. No link is a failure the row names —
   * and, being a failure, it never counts against a per-player cap.
   */
  private async pointsForRule(server: ServerRow, rule: RuleRow, subjectId: string): Promise<{ pointsGiven: number; balance: number }> {
    const discordId = (await this.repo.externalLinks.list(subjectId)).find((l) => l.provider === "discord")?.externalId ?? null;
    if (!discordId) throw new Error("no Discord link — points need a linked account");
    // An unreadable config fails the firing (and spares the cap) rather than paying past the
    // balance cap it couldn't see.
    const eco = await this.repo.economy.config();
    const out = await this.repo.economy.apply(
      { discordId, delta: rule.points, reason: `Rule "${rule.name}" on ${server.name}`, ref: `rule:${rule.id}:${subjectId}:${Date.now()}`, actorName: "rules" },
      { maxBalance: eco?.balanceCap ?? null },
    );
    return { pointsGiven: out.entry.delta, balance: out.member.balance };
  }

  /**
   * The game's VIP list, shared for a few seconds per server. The no-VIP trigger's first pass on a
   * full server fires for dozens of players in the same tick, and each of them reading the list
   * over its own connection is dozens of logins for one answer. A failed read is not kept — the
   * next firing asks again.
   */
  private async gameVipIds(server: ServerRow): Promise<Set<string> | null> {
    const now = Date.now();
    const hit = this.vipListCache.get(server.id);
    if (hit && now - hit.at < VIP_LIST_TTL_MS) return hit.read;
    const read = this.readGameVipIds(server).catch(() => null);
    this.vipListCache.set(server.id, { at: now, read });
    const ids = await read;
    if (ids === null && this.vipListCache.get(server.id)?.read === read) this.vipListCache.delete(server.id);
    return ids;
  }

  private async vipWouldAdd(server: ServerRow, rule: RuleRow, playerId: string): Promise<boolean> {
    const existing = await this.repo.vips.get(server.id, playerId).catch(() => null);
    if (!existing) return true;
    const target = Date.now() + (rule.vipMinutes || 10) * 60_000;
    const paused = Boolean(existing.pausedUntil && Date.parse(existing.pausedUntil) > Date.now());
    const active = !existing.expiration || Date.parse(existing.expiration) > Date.now();
    return !paused && !(active && (!existing.expiration || Date.parse(existing.expiration) >= target));
  }

  /**
   * The `vip` action: temporary VIP so a crashed player skips the queue back in. The game command
   * plus a panel grant row whose expiration the VIP sweep already enforces — the same shape as
   * every other grant, so it shows on the profile and cleans itself up within a sweep of expiry.
   */
  private async vipForRule(server: ServerRow, rule: RuleRow, playerId: string, playerName: string, exec: (a: string, p: Record<string, unknown>) => Promise<void>): Promise<{ expiration: string | null; held: VipRow["groupHold"] }> {
    const expiration = new Date(Date.now() + (rule.vipMinutes || 10) * 60_000).toISOString();
    await exec("vip", { playerId, description: playerName || playerId });
    const row = await this.repo.vips.upsert({
      serverId: server.id, playerId, playerName: playerName || playerId,
      comment: `VIP from rule "${rule.name}"`, expiration, createdByUserId: null, createdByName: "enforcer",
    });
    // Start the cooldown LAST, so only a grant that actually landed counts against the player. A
    // dry run never reaches here (perform() skips the whole branch), which is what lets staff tune
    // a rule in observe mode without burning anyone's next real crash VIP.
    await this.repo.enforcerRules.recordVipGrant(rule.id, server.id, playerId);
    // What LANDED, not what was asked: the store keeps the later of the grant's date and this one
    // (a rule's VIP only ever adds time), and the audit row is the VIP integrity scan's evidence —
    // recording the asked-for date over a longer grant would read as a cut that never happened.
    return { expiration: row.expiration, held: row.groupHold };
  }

  /**
   * The Discord roles held by the member this player is linked to, in the COMMUNITY guild — the
   * same guild (and gate shape) as the VIP panel's buttons. `[]` for an unlinked player (no link,
   * no roles, definitively); `null` when we could not find out, which callers must never read as
   * "no". Answers cache briefly; failures retry on the next firing.
   */
  private async discordRoles(actorPlayerId: string): Promise<string[] | null> {
    const hit = this.roleCache.get(actorPlayerId);
    if (hit && hit.atMs > Date.now() - ROLE_CACHE_TTL_MS) return hit.roleIds;
    const remember = (roleIds: string[]): string[] => {
      this.roleCache.set(actorPlayerId, { roleIds, atMs: Date.now() });
      return roleIds;
    };
    const links = await this.repo.externalLinks.list(actorPlayerId).catch(() => null);
    if (links === null) return null;
    const discordId = links.find((l) => l.provider === "discord")?.externalId;
    if (!discordId) return remember([]);
    const guild = await communityGuild(this.repo);
    if (!guild.guildId) return null;
    const member = await guildMember(guild.guildId, discordId);
    if (member.kind === "member") return remember(member.roleIds);
    if (member.kind === "notInGuild") return remember([]);
    return null; // unavailable — could not ask
  }

  private async banForRule(server: ServerRow, rule: RuleRow, playerId: string, playerName: string, signedReason: string, plainReason: string, exec: (a: string, p: Record<string, unknown>) => Promise<void>): Promise<void> {
    const hours = rule.hours && rule.hours > 0 ? rule.hours : 0;
    await exec(hours > 0 ? "tempban" : "permaban",
      { playerId, reason: signedReason, hours, adminName: "enforcer" });
    await this.repo.playerBans.create({
      game: server.game, playerId, playerName,
      kind: hours > 0 ? "temp" : "perma",
      // The token-filled text, not the raw template: a ban book that reads "{attacker_name}" is a
      // record nobody can act on months later.
      reason: plainReason || `rule "${rule.name}"`,
      category: "enforcer",
      scope: { mode: "servers", serverIds: [server.id] },
      expiresAt: hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null,
      createdByName: "enforcer",
    });
  }
}
