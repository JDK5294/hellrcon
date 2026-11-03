"use client";
import { useEffect, useState } from "react";
import { fmtExact } from "../lib/time";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { deviceZone, useCommunityZone, zoneOptions } from "../lib/zones";
import { ALL_EVENT_KINDS, eventKindLabel } from "../lib/eventKinds";
import { numberOr, stripLeadingZeros } from "../lib/formNumber";
import { describeMinutes, joinMinutes, splitMinutes, VIP_SPAN_MAX_MINUTES, type VipUnit } from "../lib/vipSpan";
import { describeSchedule, scheduleWeekdays, SCHEDULE_DEFAULTS, WEEK, type ScheduleParams } from "../lib/scheduleText";
import { banHoursMode, ruleHoursForSave } from "../lib/ruleHours";
import { MAX_ESCALATION_STEPS } from "../lib/ruleLadder";
import { ruleClashes, type Clash } from "../lib/ruleClash";
import { rulesAMoveWouldArm } from "../lib/managedRules";
import { useToast, useConfirm } from "../lib/feedback";
import { ActionResult, AskNotice, EmptyState, PageHeader, RoleDisclosure, SkeletonLines, Toggle, roleListNote, type GuildRole, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { Time } from "./Time";
import { PresetBar } from "./PresetBar";
import { PlaceholderHint } from "./Placeholders";
import { StateTriggerParams, clanKeyText } from "./StateTriggerParams";
import { RecentlyDeleted, VersionHistory } from "./VersionHistory";
import type { DiffOptions } from "../lib/versionDiff";

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /** The Rules page section it is filed under (null = none — "Other rules"). */
  sectionId?: string | null;
  /** Its section's master switch is off: it holds fire whatever its own switch says. */
  sectionOff?: boolean;
  /** Paused until this instant (null = not paused), with who and why. It lifts itself. */
  pausedUntil?: string | null;
  pauseReason?: string | null;
  pausedBy?: string | null;
  /** null = fires on events from every server; a uuid pins it to that server. */
  serverId: string | null;
  eventKind: string;
  match: string | null;
  threshold: number;
  windowSec: number;
  action: string;
  escalateActions?: string[];
  escalateResetMinutes?: number;
  alertEnabled?: boolean;
  /** the rule's own Discord ping destination; null = the server's shared rules channel. */
  alertChannelId?: string | null;
  reason: string | null;
  hours: number | null;
  delaySec: number;
  vipMinutes: number;
  /** how long before the same player can earn another crash VIP from this rule (0 = no limit). */
  vipCooldownMinutes: number;
  requireRoleIds: string[];
  /** never act on players carrying one of these tags / holding one of these Discord roles. */
  immuneTags?: string[];
  immuneRoleIds?: string[];
  /** never act at or below this level (0 = off) — protects newcomers from the automod. */
  immuneLevel?: number;
  /** trial THIS rule: record what it would have done and touch nobody. */
  dryRun?: boolean;
  /** trigger-specific knobs for the state/weapon triggers; null for kinds that take none. */
  params?: Record<string, unknown> | null;
  /** when this rule may fire; null = always. Overnight windows wrap midnight. */
  activeHours?: { start: string; end: string; daysOfWeek?: string[]; timezone?: string } | null;
  /** population bounds: fire only between these player counts (0 = unbounded on that side). */
  playersMin?: number;
  playersMax?: number;
  /** the safety valve: acting on more than this many players in a minute disables the rule (0 = off). */
  breakerLimit?: number;
  /** minutes into the match the rule is live for: from min (0 = the start) to under max (0 = the end). */
  matchMinutesMin?: number;
  matchMinutesMax?: number;
  /** count the threshold across the current match instead of within the window. */
  countPerMatch?: boolean;
  /** only act on players carrying one of these tags (empty = anyone). */
  requireTags?: string[];
  /** at most this many firings per player per period (0 = no cap). */
  capCount?: number;
  capPeriod?: "match" | "day" | "week" | "month" | "ever";
  /** the tag an "add a tag" step puts on the player. */
  actionTag?: string | null;
  /** points a "grant points" rule pays per firing. */
  points?: number;
}

const CAP_PERIODS: { value: NonNullable<Rule["capPeriod"]>; label: string }[] = [
  { value: "match", label: "match" }, { value: "day", label: "day (24 hours)" }, { value: "week", label: "week (7 days)" },
  { value: "month", label: "month (30 days)" }, { value: "ever", label: "ever" },
];

// The triggers a rule can fire on. Drawn from the shared vocabulary rather than a list kept here:
// this copy had drifted four kinds behind it (kicked, banned, admin message, vote completed), so
// rules could not be written against events the ingest was already recording. "app.idle" is the
// one synthetic trigger — no kills in the window — the server keeps a clock for.
const IDLE_KIND = "app.idle";
const DEATH_KINDS = ["app.death", "app.teamdeath"];
// The raw admin-camera event fires on both halves of a visit; these two split it by direction, so
// "ping when someone goes ON cam" doesn't also ping when they come off it.
const CAM_KINDS = ["app.admincam.enter", "app.admincam.exit"];
/**
 * A trigger DERIVED from an event sits directly beneath that event in the picker, not in a lump
 * at the bottom of the list: somebody hunting for the admin-camera triggers looks where "Admin
 * camera" is, and finding them fifteen rows further down past the votes and the match events
 * reads as two unrelated features rather than one event with a finer grain.
 */
const DERIVED_AFTER: Record<string, string[]> = { "evt.admin.camera": CAM_KINDS };
/**
 * Roster-STATE triggers: what a player IS right now (their squad, level, role, name), detected by
 * the worker each tick, rather than something the log said they DID. Each carries its own knobs
 * (`params`), mirrored from the server's @app/rules schema — these were the standalone player-rule
 * module tabs before Rules became the one place server rule customization comes from.
 *
 * On event offers them as ONE choice (ROSTER_GROUP), with the check itself picked in a second list
 * beside it. Only the picker folds them together: a rule still stores its check's own kind, so a
 * rule saved before opens on its check and saves back exactly as it was.
 */
const STATE_KINDS = [
  "app.state.no_leader", "app.state.low_level", "app.state.role_level", "app.state.bad_role", "app.state.bad_name",
  "app.state.solo_tank", "app.state.solo_heli", "app.state.out_of_zone", "app.state.no_vip",
  "app.state.playtime", "app.state.no_discord", "app.state.kill_rate", "app.state.ratio", "app.state.clan_tag",
];
/** On event's one entry for every check above — never stored, only picked. */
const ROSTER_GROUP = "live-roster";
const ROSTER_GROUP_LABEL = "live roster — squads, levels, roles, names, kills and more";
/** Players wearing chosen clan tags — any spelling, as Players → Clans groups them. */
const CLAN_KIND = "app.state.clan_tag";
/** The roster triggers that carry VIP (beside crash VIP on disconnect). */
const NO_VIP_KIND = "app.state.no_vip";
const PLAYTIME_KIND = "app.state.playtime";
const NO_DISCORD_KIND = "app.state.no_discord";
const KILL_RATE_KIND = "app.state.kill_rate";
/** Two of this match's counts (kills, deaths, team kills) set against each other. */
const RATIO_KIND = "app.state.ratio";
const DISCONNECT_KIND = "evt.player.disconnected";
/** A kill with a listed weapon — an event with knobs, judged inline by the enforcer. */
const WEAPON_KIND = "app.weapon.restricted";
/**
 * Group triggers: a player added to, or removed from, a player group (Players → Groups). Fired as
 * the API drains its membership queue, on the servers of the member's own game. Membership is not
 * presence — the player may be on no server — so these take only what reaches somebody absent.
 */
const GROUP_JOINED_KIND = "app.group.joined";
const GROUP_LEFT_KIND = "app.group.left";
const GROUP_KINDS = [GROUP_JOINED_KIND, GROUP_LEFT_KIND];
const isGroupKind = (k?: string) => GROUP_KINDS.includes(k ?? "");
const GROUP_ACTIONS = ["vip", "points", "tag", "note"];
/**
 * The schedule trigger: the calendar (the 1st of every month, every Saturday…), acting on every
 * member of a group at once — grant VIP, take timed VIP away, or cut it back. Its taking actions
 * exist nowhere else, and it never touches permanent VIP or VIP a group perk holds.
 */
const SCHEDULE_KIND = "app.schedule";
const SCHEDULE_ACTIONS = ["vip", "viprevoke", "viptrim", "vipreduce"];
/** Triggers that name a player group in their params. */
const namesGroup = (k?: string) => isGroupKind(k) || k === SCHEDULE_KIND;
const EVENT_KINDS = [
  ...ALL_EVENT_KINDS.flatMap((k) => [k, ...(DERIVED_AFTER[k] ?? [])]),
  // No parent to sit beside: app.idle is the ABSENCE of events, and the death kinds read a kill
  // from the other end rather than refining it.
  IDLE_KIND,
  ...DEATH_KINDS,
  WEAPON_KIND,
  ...GROUP_KINDS,
  SCHEDULE_KIND,
];
// The kill kinds act on the ATTACKER; the death kinds are the same events read from the victim's
// end. The labels say so, because "kill" and "death" alone would not tell you who gets kicked.
const SYNTHETIC_LABELS: Record<string, string> = {
  "app.idle": "no kills in the window (AFK)",
  "app.death": "death — acts on the player who died",
  "app.teamdeath": "team-killed — acts on the victim",
  "app.admincam.enter": "admin camera — entered",
  "app.admincam.exit": "admin camera — left",
  "app.weapon.restricted": "kill with a restricted weapon",
  "app.group.joined": "player added to a group",
  "app.group.left": "player removed from a group",
  "app.schedule": "on a schedule — a whole group, on set dates",
  // Not synthetic, but the rule hears less than the feed's "Player switched team": only the
  // switch that lands on the other side, never the drop to Unassigned or a join.
  "evt.player.teamSwitched": "Player switched team — to the other side",
  "app.state.no_leader": "squad has no leader (live roster)",
  "app.state.low_level": "level below minimum (live roster)",
  "app.state.role_level": "level below minimum on chosen roles (live roster)",
  "app.state.bad_role": "restricted role (live roster)",
  "app.state.bad_name": "name violates the filter (live roster)",
  "app.state.solo_tank": "solo tank squad (live roster)",
  "app.state.solo_heli": "solo helicopter platoon (live roster, Vietnam)",
  "app.state.out_of_zone": "outside the allowed area (live positions)",
  "app.state.no_vip": "player has no VIP (live roster)",
  "app.state.playtime": "playtime milestone (live roster)",
  "app.state.no_discord": "no Discord link (live roster)",
  "app.state.kill_rate": "kill rate or K/D over a limit (live roster)",
  "app.state.ratio": "ratio over or under a limit (live roster)",
  "app.state.clan_tag": "player is wearing a clan tag (live roster)",
};
const isStateKind = (k?: string) => (k ?? "").startsWith("app.state.");
/** Paused at `nowMs` — a pause whose end is still ahead (a lapsed one is just in the past). */
const isPausedAt = (r: Pick<Rule, "pausedUntil">, nowMs: number) => Boolean(r.pausedUntil && Date.parse(r.pausedUntil) > nowMs);
/** Acting — its own switch, its section's master switch, and no pause still running. */
const isLive = (r: Pick<Rule, "enabled" | "sectionOff" | "pausedUntil">, nowMs: number) => r.enabled && !r.sectionOff && !isPausedAt(r, nowMs);
/** Fresh default params when the picker lands on a param-carrying trigger. Mirrors @app/rules. */
const DEFAULT_PARAMS: Record<string, Record<string, unknown>> = {
  "app.state.no_leader": { minSquadSize: 2 },
  "app.state.low_level": { minLevel: 25 },
  "app.state.role_level": { roles: [], minLevel: 50 },
  "app.state.bad_role": { disallowedRoles: [], allowedRoles: [] },
  "app.state.bad_name": { bannedSubstrings: "", blockUrls: false, bannedPattern: "" },
  "app.state.solo_tank": { tankRoles: [11, 12], minCrew: 2 },
  "app.state.solo_heli": { heliRoles: [16, 17], minCrew: 2 },
  "app.state.out_of_zone": { zoneSet: "", keepOut: false, exemptRoles: [] },
  "app.state.no_vip": { minMinutesOnline: 0 },
  "app.state.playtime": { hours: 20, periodDays: 0, allServers: false },
  "app.state.no_discord": { minMinutesOnline: 5 },
  "app.state.kill_rate": { minKills: 30, killsPer10Min: 25, minKd: 0 },
  "app.state.ratio": { ratio: "teamkills:kills", direction: "above", limit: 2, minCount: 10 },
  "app.state.clan_tag": { clans: [] },
  [WEAPON_KIND]: { disallowedWeapons: "", allowedWeapons: "" },
  [GROUP_JOINED_KIND]: { groupId: "" },
  [GROUP_LEFT_KIND]: { groupId: "" },
  [SCHEDULE_KIND]: { ...SCHEDULE_DEFAULTS },
};

/**
 * The player groups, read once and shared for a minute — the group triggers' picker and every
 * rule's read-back sentence ask for the same list. Listing groups takes the groups permission;
 * without it the answer says so instead of looking like a community with no groups.
 */
type GroupList = { groups: { id: string; name: string }[] } | { error: string };
let groupListCache: { at: number; read: Promise<GroupList> } | null = null;
function groupList(): Promise<GroupList> {
  if (!groupListCache || Date.now() - groupListCache.at > 60_000) {
    groupListCache = {
      at: Date.now(),
      read: api<{ groups?: { id: string; name: string }[] }>("/player-groups")
        .then((r) => ({ groups: (r.groups ?? []).map((g) => ({ id: g.id, name: g.name })) }), (e) => ({ error: (e as Error).message })),
    };
  }
  return groupListCache.read;
}
/** Group id → name, for the rules that name a group (an empty map until — or unless — it loads). */
function useGroupNames(wanted: boolean): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    void groupList().then((r) => { if (alive && "groups" in r) setNames(new Map(r.groups.map((g) => [g.id, g.name]))); });
    return () => { alive = false; };
  }, [wanted]);
  return names;
}
const kindLabelPlus = (k: string) => SYNTHETIC_LABELS[k] ?? eventKindLabel(k);
/** A check as Live roster check lists it: its label, without saying "live roster" again. */
const checkLabel = (k: string) => kindLabelPlus(k).replace(/ \(live (?:roster|positions)\)$/, "").replace(" (live roster, ", " (");
const isDeathKind = (k?: string) => DEATH_KINDS.includes(k ?? "");
/** Steps a rule can take on a player — first action or any rung of the ladder. */
const ACTIONS = ["message", "kick", "punish", "tempban", "permaban", "blacklist", "switch", "tag", "note"];
/** The reason field reads differently where the action carries its own effect. */
const REASON_LABELS: Record<string, string> = {
  tag: "Note on the tag (optional)",
  points: "Message after paying (optional)",
  switch: "Message after switching (optional)",
};
/** Rewards: a first action only — nothing escalates into one, and one never escalates. */
const REWARD_ACTIONS = ["points"];
// "blacklist" is the stored action name from the era when it filed a record instead of banning.
// It now places a REAL ban (temp with hours, permanent without) — existing rules keep working,
// so the value stays and only the label tells the truth about what it does today.
const ACTION_LABELS: Record<string, string> = {
  blacklist: "ban (temp with hours, else permanent)",
  vip: "grant VIP",
  switch: "switch team now",
  tag: "add a tag to the player",
  points: "grant community points",
  note: "record & ping only (touches nobody in game)",
  viprevoke: "take their timed VIP away",
  viptrim: "cut timed VIP back to…",
  vipreduce: "cut timed VIP back by…",
};
const actionLabel = (a: string) => ACTION_LABELS[a] ?? a;
/** The editor's own words for each field, so a rule's history reads like the form it was saved from. */
const RULE_FIELD_LABELS: Record<string, string> = {
  name: "Name", serverId: "Applies to", eventKind: "Trigger", match: "Match text", threshold: "Count", windowSec: "Within (seconds)",
  action: "Action", escalateActions: "Then, on repeat", escalateResetMinutes: "Ladder resets after (minutes)", reason: "Message / reason",
  hours: "Ban hours", delaySec: "Wait first (seconds)", vipMinutes: "VIP minutes", vipCooldownMinutes: "VIP cooldown (minutes)",
  requireRoleIds: "Only Discord roles", immuneTags: "Exempt tags", immuneRoleIds: "Exempt Discord roles", immuneLevel: "Exempt at or below level",
  dryRun: "Trial run", alertEnabled: "Discord ping", alertChannelId: "Ping channel", params: "Trigger settings", activeHours: "Active hours",
  playersMin: "Only with at least (players)", playersMax: "Only with at most (players)", breakerLimit: "Safety limit",
  matchMinutesMin: "From minute", matchMinutesMax: "Until minute", countPerMatch: "Count per match", requireTags: "Only players tagged",
  capCount: "At most per player", capPeriod: "Per", actionTag: "Tag to add", points: "Points",
};
/** How a rule's saved versions read: triggers, steps and servers by name, not by stored key. Its
 *  own switch and its section are left out — switching and filing are not saves. */
function useRuleDiff(): DiffOptions {
  const { servers } = useServers();
  return {
    labels: RULE_FIELD_LABELS,
    ignore: ["enabled", "sectionId"],
    format: (path, v) => {
      if (path === "eventKind" && typeof v === "string") return kindLabelPlus(v);
      if ((path === "action" || path === "escalateActions") && typeof v === "string") return actionLabel(v);
      if (path === "serverId") return v ? servers.find((s) => s.id === v)?.name ?? "one server" : "every server";
      return undefined;
    },
  };
}
const TEAM_SWITCH_KIND = "evt.player.teamSwitched";
/** The steps a rule on this kind may take. Moving a player writes a team switch of its own, so a
 *  team-switch rule that switched them would fire on its own action (the API refuses it too). */
const actionsFor = (kind?: string) => (kind === TEAM_SWITCH_KIND ? ACTIONS.filter((a) => a !== "switch") : ACTIONS);
const blank = (): Partial<Rule> => ({ name: "", serverId: null, eventKind: "evt.teamkill", action: "kick", match: "", threshold: 1, windowSec: 0, reason: "", hours: null, enabled: true, delaySec: 0, vipMinutes: 10, vipCooldownMinutes: 60, requireRoleIds: [], immuneTags: [], immuneRoleIds: [], immuneLevel: 0, dryRun: false, escalateActions: [], escalateResetMinutes: 120, alertEnabled: true, alertChannelId: null, playersMin: 0, playersMax: 0, breakerLimit: 10, matchMinutesMin: 0, matchMinutesMax: 0, countPerMatch: false, requireTags: [], capCount: 0, capPeriod: "day", actionTag: null, points: 0 });

/** `admin.moderation`: read lists the rules, write creates, edits, toggles and deletes them. */
interface RuleActivity { lastFiredAt: string; count: number }
/** What a roster rule saw on its latest check of one server, and the latest reason a firing of it
 *  was held back there (see the API's rule_status). */
interface RuleStatus {
  ruleId: string; serverId: string;
  checkedAt: string | null;
  check: { roster: number; flagged: number; sent: number; paced: number; unknownPlayers: number; held: string | null; breakdown: Record<string, number> } | null;
  skippedAt: string | null; skipReason: string | null; skipPlayer: string | null;
}

export default function Enforcer({ canManage = true }: { canManage?: boolean }) {
  const { serverId } = useServers();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [activity, setActivity] = useState<Record<string, RuleActivity>>({});
  const [status, setStatus] = useState<Record<string, RuleStatus[]>>({});
  // The server's clock at the last read — what "has the check stopped reporting" is judged against,
  // so a phone whose clock is off cannot call a live rule stale.
  const [statusNow, setStatusNow] = useState<string | null>(null);
  const [error, setError] = useState("");
  // The New Rule form's starting values: null = closed, blank() = fresh, a copied rule = Duplicate.
  const [draft, setDraft] = useState<Partial<Rule> | null>(null);
  const [sections, setSections] = useState<RuleSection[]>([]);
  // By section, or every rule in one list as it has always been ("View all"). Remembered on this
  // device only — a convenience, not a setting anyone else should inherit.
  const [view, setView] = useState<"sections" | "all">("sections");
  useEffect(() => { setView(readRulesView()); }, []);
  // Each list's own "pinned to other servers" switch, keyed by section ("" = Other rules,
  // "all" = the single list of View all).
  const [openElsewhere, setOpenElsewhere] = useState<Record<string, boolean>>({});
  // "Select rules": tick rules anywhere on the page, then file them all under one section.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moveTo, setMoveTo] = useState("");
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [addingBusy, setAddingBusy] = useState(false); // in flight: Enter twice would make two sections
  const [showDeleted, setShowDeleted] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  /*
   * The list answers for THE SERVER YOU ARE ON. Every rule used to render here regardless of its
   * pin, so three servers' welcome messages and TK policies interleaved into one wall — reading
   * one server's policy meant mentally deleting the other servers' rules, and the wall only grows.
   * Community-wide rules stay: they genuinely run here. The rest wait behind one labelled button
   * rather than disappearing, because a rule no view admits to is a rule somebody recreates.
   */
  const runsHere = (r: Rule) => !serverId || !r.serverId || r.serverId === serverId;
  const scoped = rules?.filter(runsHere) ?? null;
  const knownSections = new Set(sections.map((x) => x.id));
  const sectionOf = (r: Rule) => (r.sectionId && knownSections.has(r.sectionId) ? r.sectionId : "");
  // Sections show once there is one to show; until then the page is the single list it always was.
  const bySection = view === "sections" && sections.length > 0;

  const load = () => api<{ rules: Rule[]; sections?: RuleSection[]; activity?: Record<string, RuleActivity>; status?: Record<string, RuleStatus[]>; now?: string }>("/enforcer/rules")
    .then((r) => { setRules(r.rules); setSections(r.sections ?? []); setActivity(r.activity ?? {}); setStatus(r.status ?? {}); setStatusNow(r.now ?? null); })
    .catch((e) => setError(e.message));
  // Re-read every 30 seconds — the roster check's own cadence — so a rule's status line says what
  // it saw just now, not when the page was opened.
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    return () => clearInterval(t);
  }, []);

  // The COMMUNITY server's roles for the "only players holding…" gate — the same guild (and the
  // same reason) as the VIP panel's claim gates: the players being gated live in the public Discord.
  const [guildRoles, setGuildRoles] = useState<GuildRole[]>([]);
  const [guildRolesNote, setGuildRolesNote] = useState("");
  useEffect(() => {
    api<{ roles?: GuildRole[]; error?: string; botConfigured?: boolean }>("/discord/roles?guild=community")
      .then((r) => { setGuildRoles(r.roles ?? []); setGuildRolesNote(roleListNote(r)); })
      // Said as what it is: the chips' own fallback sends staff to set up the bot.
      .catch((e) => { setGuildRoles([]); setGuildRolesNote(`Couldn't read the Discord role list: ${(e as Error).message}`); });
  }, []);

  if (error) return <div className="card"><ActionResult error={error} /></div>;

  const card = (r: Rule, allServers: boolean) => (
    <RuleCard key={r.id} rule={r} fired={activity[r.id]} status={(status[r.id] ?? []).filter((st) => !serverId || st.serverId === serverId || allServers)} statusNow={statusNow} onChange={load} canManage={canManage} guildRoles={guildRoles} guildRolesNote={guildRolesNote} sections={sections} allRules={rules ?? []}
      selectable={selecting} selected={selected.has(r.id)}
      onSelect={(on) => setSelected((cur) => { const next = new Set(cur); if (on) next.add(r.id); else next.delete(r.id); return next; })}
      onDuplicate={() => {
        // Everything but identity travels — its section included; nothing is saved until Save.
        const { id: _id, ...rest } = r;
        setDraft({ ...rest, name: `${r.name} (copy)` });
        window.scrollTo({ top: 0, behavior: "smooth" });
      }} />
  );
  /** One list of rules: this server's (and community-wide) ones, and behind its own button the
   *  ones pinned to other servers — a rule no view admits to is a rule somebody recreates. */
  const renderRules = (list: Rule[], key: string, emptyNote: string) => {
    const here = list.filter(runsHere);
    const away = list.length - here.length;
    const open = !!openElsewhere[key];
    const shownHere = open ? list : here;
    return (
      <>
        {shownHere.length === 0 && emptyNote && <p className="nothing">{emptyNote}</p>}
        {/* rules run in their own priority order, so they are a list inside one panel */}
        <div className="recent-list">{shownHere.map((r) => card(r, open))}</div>
        {away > 0 && (
          <div className="actions">
            <button className="ghost mini" onClick={() => setOpenElsewhere((m) => ({ ...m, [key]: !open }))}>
              {open ? "Show only this server's rules" : `Show ${away} rule${away === 1 ? "" : "s"} pinned to other servers`}
            </button>
          </div>
        )}
      </>
    );
  };
  const chooseView = (v: "sections" | "all") => { setView(v); writeRulesView(v); };
  async function addSection(e: React.FormEvent) {
    e.preventDefault();
    const name = newSectionName.trim();
    if (!name) return;
    setAddingBusy(true);
    try {
      await api("/enforcer/sections", { method: "POST", body: { name } });
      setNewSectionName(""); setAdding(false); chooseView("sections"); load();
    } catch (err) { toast.error((err as Error).message); } finally { setAddingBusy(false); }
  }
  async function moveSelected() {
    if (!selected.size) return;
    // A rule held only by its section's switch starts firing the moment it leaves for somewhere
    // that holds nothing — asked first, not discovered in Activity.
    const armed = rulesAMoveWouldArm(rules ?? [], selected, moveTo || null, sections);
    if (armed.length && !(await confirm({
      title: `Start ${armed.length === 1 ? `"${armed[0]!.name}"` : `${armed.length} rules`} firing?`,
      body: `${armed.length === 1 ? "It is" : `${armed.map((r) => `"${r.name}"`).join(", ")} are`} held by ${armed.length === 1 ? "its" : "their"} section's switch, which is off. Moved to ${moveTo ? `"${sections.find((x) => x.id === moveTo)?.name ?? "that section"}"` : "Other rules"}, nothing holds ${armed.length === 1 ? "it" : "them"} any more, so ${armed.length === 1 ? "it starts" : "they start"} acting on players straight away.`,
      confirmLabel: "Move anyway",
    }))) return;
    setMoving(true);
    try {
      const r = await api<{ moved: number }>("/enforcer/sections/assign", { method: "POST", body: { ruleIds: [...selected], sectionId: moveTo || null } });
      const where = moveTo ? sections.find((x) => x.id === moveTo)?.name ?? "the section" : "Other rules";
      toast.success(`Moved ${r.moved} rule${r.moved === 1 ? "" : "s"} to ${where}`);
      setSelected(new Set()); setSelecting(false); load();
    } catch (err) { toast.error((err as Error).message); } finally { setMoving(false); }
  }

  return (
    <div role="region" aria-label="Rules">
      <div className="card">
        <PageHeader
          title="Rules"
          subtitle="Rules react to live events and act on the offending player. On observe servers actions are dry-run (logged to Activity, never sent)."
          actions={canManage ? (
            <button className="primary" onClick={() => setDraft(draft ? null : { ...blank(), serverId: serverId || null })}>{draft ? "Close" : "New rule"}</button>
          ) : undefined}
        />
        {canManage && <AskNotice capability="admin.moderation" serverId={serverId} />}
        {rules && (sections.length > 0 || canManage) && (
          <div className="actions">
            {sections.length > 0 && (view === "all"
              ? <button className="ghost mini" onClick={() => chooseView("sections")}>Show by section</button>
              : <button className="ghost mini" title="Every rule in one list, as before sections" onClick={() => chooseView("all")}>View all</button>)}
            {canManage && <button className="ghost mini" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "New section"}</button>}
            <button className="ghost mini" title="Rules deleted lately — each one can be brought back as it was" onClick={() => setShowDeleted((v) => !v)}>{showDeleted ? "Hide deleted rules" : "Recently deleted"}</button>
            {canManage && rules.length > 0 && (
              <button className="ghost mini" onClick={() => { setSelecting((v) => !v); setSelected(new Set()); setMoveTo(sections[0]?.id ?? ""); }}>
                {selecting ? "Stop selecting" : "Select rules"}
              </button>
            )}
          </div>
        )}
        {adding && (
          <form className="control-row" style={{ marginTop: 10 }} onSubmit={addSection}>
            <input value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)} placeholder="Section name, e.g. Player level rules" maxLength={200} autoFocus />
            <button className="primary mini" type="submit" disabled={addingBusy || !newSectionName.trim()}>Add section</button>
          </form>
        )}
      </div>

      {/* A saved setup here captures the rules PINNED TO THIS SERVER, so a new server can be given
          the same policy in one step. Community-wide rules already apply everywhere and are
          deliberately left out — see the rules entry in the feature-preset catalog. */}
      {serverId && <PresetBar feature="rules" featureLabel="Player rules" serverId={serverId} canManage={canManage} onApplied={load} />}

      <PanelGroup viewId="enforcer">
        {showDeleted && (
          <Panel id="rules-deleted" caps="open" title="Recently deleted rules" subtitle="Brought back as they were — on or off, in their section if it is still there">
            <RecentlyDeleted listUrl="/enforcer/deleted-rules" restoreUrl={(id) => `/enforcer/versions/${id}/restore`} canRestore={canManage} noun="rule" onRestored={() => load()} />
          </Panel>
        )}
        {draft && (
          <Panel id="new" caps="open" title={draft.name ? `New rule — from "${draft.name.replace(/ \(copy\)$/, "")}"` : "New rule"}>
            {/* A rule made from a server's own rules page defaults to THAT server; a Duplicate
                starts from the copied rule's whole shape. Keyed so switching sources resets the
                form instead of bleeding one draft into the next. */}
            <RuleForm key={draft.name || "blank"} initial={draft} onSaved={() => { setDraft(null); load(); }} onCancel={() => setDraft(null)} guildRoles={guildRoles} guildRolesNote={guildRolesNote} sections={sections} allRules={rules ?? []} />
          </Panel>
        )}
        {!bySection && (
          <Panel id="rules" caps="open" title="Rules" subtitle={scoped ? String((openElsewhere.all ? rules : scoped)?.length ?? 0) : undefined}>
            {!rules && <SkeletonLines lines={3} />}
            {rules && !rules.length && !draft && (
              <EmptyState icon="🤖" title="No rules yet">
                A rule watches for something in the log — a team kill, a banned word, a player joining
                or crashing out, an hour with no kills — and acts on that player without anyone being
                online. It can wait first (welcome a player 30 seconds in, kick them if they&apos;re
                still here) or hand a crash victim temporary VIP so the queue doesn&apos;t punish a
                game crash. On a server in observe mode every action is dry-run, so you can watch what
                it would have done in Activity before going live.
              </EmptyState>
            )}
            {rules && rules.length > 0 && renderRules(rules, "all", draft ? "" : "No rules run on this server yet — the button below shows the ones pinned elsewhere.")}
          </Panel>
        )}
        {/* By section: one panel per section, arranged like any other panel (Arrange panels), each
            with its own "pinned to other servers" — then everything filed nowhere. */}
        {bySection && rules && sections.map((sec) => {
          const filed = rules.filter((r) => sectionOf(r) === sec.id);
          const off = sec.enabled === false;
          return (
            <Panel key={sec.id} id={`section-${sec.id}`} caps="open" title={sec.name} subtitle={`${filed.filter(runsHere).length}${off ? " · switched off" : ""}`}
              actions={canManage ? <SectionTools section={sec} filed={filed} onChange={load} /> : undefined}>
              {off && (
                <p className="hint mt-0 section-off-note notice">
                  This section is switched off, so none of its rules fire. Each rule keeps its own on/off setting for
                  when the section is switched back on.
                </p>
              )}
              {renderRules(filed, sec.id, filed.length
                ? "None of this section's rules run on this server — the button below shows the rest."
                : canManage ? "Nothing in this section yet — Select rules, then move them here." : "Nothing in this section yet.")}
            </Panel>
          );
        })}
        {bySection && rules && (() => {
          const loose = rules.filter((r) => !sectionOf(r));
          return (
            <Panel id="rules-other" caps="open" title="Other rules" subtitle={String(loose.filter(runsHere).length)}>
              {renderRules(loose, "", loose.length ? "None of the rules outside a section run on this server — the button below shows them." : "Every rule is in a section.")}
            </Panel>
          );
        })()}
      </PanelGroup>
      {selecting && (
        <div className="rule-select-bar control-row">
          <strong>{selected.size} selected</strong>
          <label className="inline">Move to
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              {sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              <option value="">Other rules (no section)</option>
            </select>
          </label>
          <button className="primary mini" disabled={!selected.size || moving} onClick={moveSelected}>{moving ? "Moving…" : "Move"}</button>
          <button className="ghost mini" onClick={() => { setSelecting(false); setSelected(new Set()); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

interface RuleSection { id: string; name: string; enabled?: boolean }

const RULES_VIEW_KEY = "enforcer.rulesView";
function readRulesView(): "sections" | "all" {
  try { return localStorage.getItem(RULES_VIEW_KEY) === "all" ? "all" : "sections"; } catch { return "sections"; }
}
function writeRulesView(v: "sections" | "all") {
  try { localStorage.setItem(RULES_VIEW_KEY, v); } catch { /* a private window keeps the choice for this visit only */ }
}

/**
 * A section's own controls in its panel header: its master switch, rename it, or remove it (its
 * rules stay, on no section). The switch holds every rule filed here without touching any rule's
 * own switch, so switching back on restores exactly what was on before.
 */
function SectionTools({ section, filed: filedRules, onChange }: { section: RuleSection; filed: Rule[]; onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(section.name);
  const [switching, setSwitching] = useState(false);
  const filed = filedRules.length;
  const on = section.enabled !== false;
  async function flip(next: boolean) {
    const ownOn = filedRules.filter((r) => r.enabled).length;
    if (!next && !(await confirm({
      title: `Switch off every rule in "${section.name}"?`,
      body: `${ownOn ? `${ownOn} rule${ownOn === 1 ? "" : "s"} that ${ownOn === 1 ? "is" : "are"} on stop${ownOn === 1 ? "s" : ""} firing` : "None of its rules are on right now, so nothing stops firing"} until you switch the section back on. Each rule keeps its own on/off setting, so switching back on brings back exactly what was on.`,
      confirmLabel: "Switch off",
    }))) return;
    setSwitching(true);
    try {
      await api(`/enforcer/sections/${section.id}`, { method: "PATCH", body: { enabled: next } });
      toast.success(next ? `"${section.name}" is on — ${ownOn} rule${ownOn === 1 ? "" : "s"} back on` : `"${section.name}" switched off`);
      onChange();
    } catch (err) { toast.error((err as Error).message); } finally { setSwitching(false); }
  }
  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === section.name) { setRenaming(false); return; }
    try { await api(`/enforcer/sections/${section.id}`, { method: "PATCH", body: { name: name.trim() } }); setRenaming(false); onChange(); }
    catch (err) { toast.error((err as Error).message); }
  }
  async function remove() {
    // Switched off, the section is holding its rules — removing it switches the ones that are on
    // off one by one (the server does it), so nothing starts firing. Said before, not after.
    const heldOn = on ? 0 : filedRules.filter((r) => r.enabled).length;
    const ok = await confirm({
      title: `Remove the section "${section.name}"?`,
      body: !filed ? "It has no rules in it."
        : heldOn ? `Its ${filed} rule${filed === 1 ? "" : "s"} move${filed === 1 ? "s" : ""} to Other rules. The section is switched off and holding ${filed === 1 ? "it" : "them"}, so ${heldOn === filed ? (filed === 1 ? "it is" : "they are") : `the ${heldOn} that ${heldOn === 1 ? "is" : "are"} on ${heldOn === 1 ? "is" : "are"}`} switched off one by one — nothing starts firing. Switch on the ones you want back.`
          : `Its ${filed} rule${filed === 1 ? "" : "s"} stay${filed === 1 ? "s" : ""} exactly as ${filed === 1 ? "it is" : "they are"}, under Other rules.`,
      confirmLabel: "Remove section", danger: true,
    });
    if (!ok) return;
    try { await api(`/enforcer/sections/${section.id}`, { method: "DELETE" }); onChange(); }
    catch (err) { toast.error((err as Error).message); }
  }
  if (renaming) {
    return (
      <form className="control-row" onSubmit={rename}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus aria-label="Section name" />
        <button className="primary mini" type="submit">Save</button>
        <button className="ghost mini" type="button" onClick={() => { setRenaming(false); setName(section.name); }}>Cancel</button>
      </form>
    );
  }
  return (
    <span className="control-row">
      <Toggle checked={on} disabled={switching} label={on ? "Section on" : "Section off"} onChange={flip}
        title={on ? "Switch off every rule in this section at once" : "Switch this section's rules back on"} />
      <button className="ghost mini" onClick={() => setRenaming(true)}>Rename</button>
      <button className="ghost mini" onClick={remove}>Remove</button>
    </span>
  );
}

/** The tags a clan tag rule names, for its read-back sentence. */
function clanTagsText(params: unknown): string {
  const list = Array.isArray((params as { clans?: unknown } | null | undefined)?.clans) ? ((params as { clans: unknown[] }).clans).map(String) : [];
  return list.length ? list.map(clanKeyText).join(" / ") : "(none picked yet)";
}

/** A ratio rule's pair, way and limit, for its read-back sentence: "team kills to kills is at or above 2". */
function ratioText(params: unknown): string {
  const p = (params ?? {}) as { ratio?: unknown; direction?: unknown; limit?: unknown };
  const words: Record<string, string> = { kills: "kills", deaths: "deaths", teamkills: "team kills" };
  const [a = "", b = ""] = String(p.ratio ?? "").split(":");
  const pair = words[a] && words[b] ? `${words[a]} to ${words[b]}` : "ratio";
  return `a player's ${pair} is at or ${p.direction === "below" ? "below" : "above"} ${Number(p.limit ?? 0)} (live roster)`;
}

function summarize(r: Partial<Rule>, groupNames: Map<string, string> = new Map()): string {
  const thr = (r.threshold ?? 1) > 1 ? ` ×${r.threshold} ${r.countPerMatch ? "in one match" : `within ${r.windowSec}s`}` : "";
  const m = r.match ? ` matching /${r.match}/i` : "";
  const wait = (r.delaySec ?? 0) > 0 ? `, wait ${r.delaySec}s,` : "";
  const groupId = String((r.params as { groupId?: unknown } | null | undefined)?.groupId ?? "");
  if (r.eventKind === SCHEDULE_KIND) return summarizeSchedule(r, groupNames);
  const group = groupNames.get(groupId) ? `group “${groupNames.get(groupId)}”` : groupId ? "a group" : "a group (none picked yet)";
  // "When evt.teamkill → kick" made staff read a database key to understand their own rule.
  const when = r.eventKind === IDLE_KIND
    ? `no kills for ${r.windowSec ?? 0}s`
    : isDeathKind(r.eventKind)
      ? `${r.eventKind === "app.teamdeath" ? "a player is team-killed" : "a player dies"}${m}${thr}`
      : r.eventKind === GROUP_JOINED_KIND ? `a player is added to ${group}`
        : r.eventKind === GROUP_LEFT_KIND ? `a player is removed from ${group}`
          : r.eventKind === CLAN_KIND ? `a player is wearing the clan tag ${clanTagsText(r.params)}${thr}`
            : r.eventKind === RATIO_KIND ? `${ratioText(r.params)}${thr}`
              : `${kindLabelPlus(r.eventKind ?? "")}${m}${thr}`;
  // The cooldown belongs in the sentence: it is the difference between a perk and a farm, and a
  // staff member reading their own rule should not have to open the editor to find out which.
  // Read through the same blank-means-default rule the form saves by, so the live preview cannot
  // promise "no cooldown" for an empty box that is about to save the default.
  const cooldown = numberOr(r.vipCooldownMinutes, 60);
  const cool = cooldown > 0 ? `, at most once every ${describeMinutes(cooldown)}` : ", with NO cooldown";
  // In the SENTENCE the ban length is decided — the rule either has hours or it doesn't — so the
  // editor's conditional label ("temp with hours, else permanent") resolves to what this rule
  // will actually do, hours included. The select options keep the conditional wording; only the
  // read-back says the outcome.
  const resolved = (a: string): string =>
    a === "tempban" ? `temp ban${r.hours && r.hours > 0 ? ` ${r.hours}h` : ""}`
      : a === "blacklist" ? (r.hours && r.hours > 0 ? `ban ${r.hours}h` : "permanent ban")
        : a === "tag" ? `tag "${r.actionTag ?? ""}"`
          : a === "points" ? `grant ${numberOr(r.points, 0)} point${numberOr(r.points, 0) === 1 ? "" : "s"}`
            : actionLabel(a);
  const vipFor = describeMinutes(numberOr(r.vipMinutes, 10));
  const act = r.action === "vip"
    ? r.eventKind === DISCONNECT_KIND
      ? `grant ${vipFor} of VIP to rejoin${cool}`
      : isGroupKind(r.eventKind)
        ? `grant ${vipFor} of VIP${r.serverId ? "" : " on every server of their game"}${cool}${r.reason ? `, then message "${r.reason}" if they're on` : ""}`
        : `grant ${vipFor} of VIP${cool}${r.reason ? `, then message "${r.reason}"` : ""}`
    : resolved(r.action ?? "");
  // The ladder is part of the policy, so it is part of the sentence: a rule that reads "message"
  // but kicks on the third offence would otherwise be a surprise only the audit trail explains.
  const ladder = (r.escalateActions?.length ?? 0) > 0 ? `, then ${r.escalateActions!.map(resolved).join(", then ")} on repeat` : "";
  const gateBits: string[] = [];
  if ((r.requireRoleIds?.length ?? 0) > 0) gateBits.push(`${r.requireRoleIds!.length} Discord role${r.requireRoleIds!.length === 1 ? "" : "s"}`);
  if ((r.requireTags?.length ?? 0) > 0) gateBits.push(`tagged ${r.requireTags!.join("/")}`);
  const gate = gateBits.length ? ` (only ${gateBits.join(", ")})` : "";
  // Only the EXCEPTION is worth a word. Pinging is the default, so saying so on every rule would
  // be noise about noise; a rule that has been silenced is the one you want to see at a glance —
  // and so is one whose ping goes somewhere other than the shared channel.
  const quiet = r.alertEnabled === false ? " · no Discord ping" : r.alertChannelId ? " · pings its own channel" : "";
  // Exemptions and the trial switch both change whether this rule touches anybody, so they belong
  // in the sentence rather than behind an Edit click.
  const exemptCount = (r.immuneRoleIds?.length ?? 0) + (r.immuneTags?.length ?? 0);
  const exemptBits: string[] = [];
  if (exemptCount > 0) exemptBits.push(`${exemptCount} role${exemptCount === 1 ? "" : "s"}/tag${exemptCount === 1 ? "" : "s"}`);
  if ((r.immuneLevel ?? 0) > 0) exemptBits.push(`level ≤ ${r.immuneLevel}`);
  const exempt = exemptBits.length ? `, except ${exemptBits.join(" and ")}` : "";
  const trial = r.dryRun === true ? " · TRIAL RUN (touches nobody)" : "";
  // The window is part of the policy: a rule that only bites at night must SAY so, or the
  // daytime "why didn't it fire" question lands on the wrong suspect.
  const DAY_SHORT: Record<string, string> = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
  const hours = r.activeHours
    ? ` · active ${r.activeHours.start}–${r.activeHours.end}${r.activeHours.daysOfWeek?.length ? ` ${r.activeHours.daysOfWeek.map((d) => DAY_SHORT[d] ?? d).join("/")}` : ""} (${r.activeHours.timezone ?? "UTC"})`
    : "";
  const pmin = r.playersMin ?? 0; const pmax = r.playersMax ?? 0;
  const pop = pmin > 0 && pmax > 0 ? ` · ${pmin}–${pmax} players` : pmin > 0 ? ` · ${pmin}+ players` : pmax > 0 ? ` · ≤${pmax} players` : "";
  // Only the absence of the brake is worth a word — it is on by default, and a rule that opted
  // out of its own safety valve should say so where staff read.
  const brake = (r.breakerLimit ?? 10) === 0 ? " · NO SAFETY LIMIT" : "";
  const mmin = numberOr(r.matchMinutesMin, 0); const mmax = numberOr(r.matchMinutesMax, 0);
  const inMatch = mmin > 0 && mmax > 0 ? ` · ${mmin}–${mmax} min into the match` : mmin > 0 ? ` · from ${mmin} min into the match` : mmax > 0 ? ` · first ${mmax} min of the match` : "";
  const capN = numberOr(r.capCount, 0);
  const capPeriod = r.capPeriod ?? "day";
  const cap = capN > 0 ? ` · at most ${capN}× per player ${capPeriod === "ever" ? "ever" : `per ${capPeriod}`}` : "";
  return `When ${when}${wait} → ${act}${ladder}${r.reason && r.action !== "vip" ? ` "${r.reason}"` : ""}${gate}${exempt}${trial}${quiet}${hours}${pop}${inMatch}${cap}${brake}`;
}

/** A schedule rule's read-back: when, what, to whom — and what it never touches. */
function summarizeSchedule(r: Partial<Rule>, groupNames: Map<string, string>): string {
  const p = { ...SCHEDULE_DEFAULTS, ...((r.params ?? {}) as ScheduleParams) };
  const group = groupNames.get(String(p.groupId)) ? `group “${groupNames.get(String(p.groupId))}”` : p.groupId ? "the group" : "a group (none picked yet)";
  const amount = describeMinutes(numberOr(r.vipMinutes, 10));
  const what = r.action === "viprevoke" ? `take timed VIP away from every member of ${group}`
    : r.action === "viptrim" ? `cut every member of ${group} back to at most ${amount} of VIP`
      : r.action === "vipreduce" ? `take ${amount} of VIP from every member of ${group}`
        : `grant ${amount} of VIP (${p.stack === false ? "at least that long" : "stacked"}) to every member of ${group}`;
  const where = r.serverId ? "" : " on every server of their game";
  const trial = r.dryRun === true ? " · TRIAL RUN (touches nobody)" : "";
  const quiet = r.alertEnabled === false ? " · no Discord ping" : r.alertChannelId ? " · pings its own channel" : "";
  return `${describeSchedule(p).replace(/^./, (c) => c.toUpperCase())} → ${what}${where} · permanent VIP and group-perk VIP are never touched${trial}${quiet}`;
}

function RuleCard({ rule, fired, status, statusNow, onChange, canManage, guildRoles, guildRolesNote, onDuplicate, sections, allRules = [], selectable = false, selected = false, onSelect }: { rule: Rule; fired?: RuleActivity; status?: RuleStatus[]; statusNow?: string | null; onChange: () => void; canManage: boolean; guildRoles: GuildRole[]; guildRolesNote: string; onDuplicate: () => void; sections: RuleSection[]; allRules?: Rule[]; selectable?: boolean; selected?: boolean; onSelect?: (on: boolean) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [history, setHistory] = useState(false);
  const ruleDiff = useRuleDiff();
  const groupNames = useGroupNames(namesGroup(rule.eventKind));
  // The server's clock at the last read (the page re-reads every 30 seconds) — a phone whose clock
  // is off must not call a pause over early, or still running when it has ended.
  const nowMs = statusNow ? Date.parse(statusNow) : 0;
  const paused = rule.enabled && !rule.sectionOff && isPausedAt(rule, nowMs);
  const live = isLive(rule, nowMs);

  async function toggle() {
    // Switching a rule ON is when it starts acting — the moment to say it would double up on another.
    if (!rule.enabled) {
      const clashes = ruleClashes({ ...rule, enabled: true }, allRules);
      if (clashes.length && !(await confirm(clashConfirm(clashes, "Enable anyway")))) return;
    }
    try { await api(`/enforcer/rules/${rule.id}`, { method: "PATCH", body: { enabled: !rule.enabled } }); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function resume() {
    try { await api(`/enforcer/rules/${rule.id}/pause`, { method: "DELETE" }); toast.success(`"${rule.name}" is back on`); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function remove() {
    if (!(await confirm({ title: `Delete rule "${rule.name}"?`, body: "It can be brought back as it was from Recently deleted.", confirmLabel: "Delete", danger: true }))) return;
    try { await api(`/enforcer/rules/${rule.id}`, { method: "DELETE" }); onChange(); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className={`subcard${selectable && selected ? " selected" : ""}`}>
      <div className="row">
        <div>
          {selectable && (
            <input type="checkbox" className="rule-select" checked={selected} onChange={(e) => onSelect?.(e.target.checked)} aria-label={`Select ${rule.name}`} />
          )}
          <strong>{rule.name}</strong>{" "}
          {!rule.enabled ? <span className="badge observe">off</span>
            : rule.sectionOff ? <span className="badge observe" title="Its section is switched off. This rule's own switch is still on, so it comes back when the section does.">off — section switched off</span>
              : paused ? <span className="badge observe">paused · back <Time iso={rule.pausedUntil} /></span>
                : <span className="badge active">on</span>}{" "}
          <RuleScopeBadge serverId={rule.serverId} />
          {/* Proof of life. A rule mis-scoped to the wrong server, gated on a role nobody holds,
              or watching an event the log stopped emitting looks exactly like one quietly keeping
              the peace — until this says it has done nothing all week. */}
          {live && (
            fired
              ? <span className="badge" title={`Last fired ${fmtExact(fired.lastFiredAt)}`}>
                  fired {fired.count}× · <Time iso={fired.lastFiredAt} />
                </span>
              : <span className="badge observe" title="No firings in the last 7 days — check the trigger, the scope and any role gate">quiet 7d</span>
          )}
          <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>{summarize(rule, groupNames)}</div>
          {paused && (
            <div className="rule-pause" style={{ fontSize: "0.82rem", marginTop: 4 }}>
              Paused by {rule.pausedBy || "staff"} until {fmtExact(rule.pausedUntil!)}{rule.pauseReason ? <> — {rule.pauseReason}</> : null}.
              It switches itself back on then.{" "}
              {canManage && <button className="ghost mini" onClick={resume}>Resume now</button>}
            </div>
          )}
          {live && <RuleStatusLines rule={rule} status={status ?? []} now={statusNow ?? null} />}
        </div>
        {canManage && (
          <div className="actions mt-0">
            <button className="ghost" onClick={toggle}>{rule.enabled ? "Disable" : "Enable"}</button>
            {rule.enabled && !rule.sectionOff && !paused && (
              <button className="ghost" title="Hold this rule for a while — it switches itself back on" onClick={() => setPausing((v) => !v)}>{pausing ? "Cancel pause" : "Pause"}</button>
            )}
            <button className="ghost" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
            <button className="ghost" title="Start a new rule from a copy of this one" onClick={onDuplicate}>Duplicate</button>
            <button className="ghost" title="Every saved change to this rule, and a way back" onClick={() => setHistory((v) => !v)}>{history ? "Close history" : "History"}</button>
            <button className="danger" onClick={remove}>Delete</button>
          </div>
        )}
        {!canManage && (
          <div className="actions mt-0">
            <button className="ghost" onClick={() => setHistory((v) => !v)}>{history ? "Close history" : "History"}</button>
          </div>
        )}
      </div>
      {pausing && !paused && <PauseForm rule={rule} onDone={() => { setPausing(false); onChange(); }} onCancel={() => setPausing(false)} />}
      {history && (
        <div className="setting-card rule-history" style={{ marginTop: 8, padding: 10 }}>
          {/* A restore rewrites the rule under an open editor, so the editor closes rather than
              saving its stale copy back over it. */}
          <VersionHistory listUrl={`/enforcer/rules/${rule.id}/versions`} restoreUrl={(id) => `/enforcer/versions/${id}/restore`}
            canRestore={canManage} diff={ruleDiff} noun="rule" onRestored={() => { setEditing(false); onChange(); }} />
        </div>
      )}
      {editing && <RuleForm initial={rule} ruleId={rule.id} onSaved={() => { setEditing(false); onChange(); }} onCancel={() => setEditing(false)} guildRoles={guildRoles} guildRolesNote={guildRolesNote} sections={sections} allRules={allRules} />}
    </div>
  );
}

/**
 * Pause a rule for a while — an event night, a misbehaving trigger being looked into. It holds fire
 * until then and switches itself back on, so there is nothing to remember to undo; the reason is
 * required because the card shows it to every other staff member who wonders why it went quiet.
 */
const PAUSE_SPANS: [string, string][] = [["30", "30 minutes"], ["120", "2 hours"], ["until", "Until a date…"]];
function PauseForm({ rule, onDone, onCancel }: { rule: Rule; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const [span, setSpan] = useState("30");
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = reason.trim() !== "" && (span !== "until" || until !== "");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    // A datetime-local value is the time on this device's clock face — read as such, then sent
    // as the instant it names.
    const body = span === "until" ? { until: new Date(until).toISOString(), reason: reason.trim() } : { minutes: Number(span), reason: reason.trim() };
    setBusy(true);
    try {
      await api(`/enforcer/rules/${rule.id}/pause`, { method: "POST", body });
      toast.success(`Paused "${rule.name}"`);
      onDone();
    } catch (err) { toast.error((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <form className="setting-card rule-pause-form" style={{ marginTop: 8, padding: 10 }} onSubmit={submit}>
      <div className="chips">
        {PAUSE_SPANS.map(([v, label]) => (
          <button key={v} type="button" className={span === v ? "badge active chip-btn" : "badge chip-btn"} aria-pressed={span === v} onClick={() => setSpan(v)}>{label}</button>
        ))}
      </div>
      {span === "until" && (
        <label>Until
          <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      )}
      <label>Why
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. event night — no TK kicks" />
      </label>
      <p className="hint m-0">It holds fire until then and switches itself back on — nothing to remember to undo.</p>
      <div className="actions">
        <button className="primary mini" type="submit" disabled={busy || !ready}>{busy ? "Pausing…" : "Pause"}</button>
        <button className="ghost mini" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * "Why isn't this rule firing", answered where the rule is. A roster rule says what its latest
 * check of the roster saw — how the players split against it, how many it flagged and sent — and
 * any rule says the latest reason the enforcer held one of its firings back. A roster rule that
 * has never reported, or stopped reporting, says that too: that is the check not running at all.
 */
function RuleStatusLines({ rule, status, now }: { rule: Rule; status: RuleStatus[]; now: string | null }) {
  const { servers } = useServers();
  const name = (id: string) => servers.find((sv) => sv.id === id)?.name ?? "a server";
  const roster = isStateKind(rule.eventKind);
  const lines: React.ReactNode[] = [];
  if (roster && !status.some((st) => st.checkedAt)) {
    lines.push(<span key="none">Not checked yet. The live-roster check runs every 30 seconds on a server whose <em>Auto settings &amp; rules</em> automation is on and whose connection is up.</span>);
  }
  for (const st of status) {
    const c = st.check;
    if (roster && st.checkedAt && c) {
      const stale = now !== null && Date.parse(now) - Date.parse(st.checkedAt) > 3 * 60_000;
      const parts = Object.entries(c.breakdown).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
      lines.push(
        <span key={`c-${st.serverId}`} style={stale ? { color: "var(--warn)" } : undefined}>
          {stale ? "Last checked " : "Checked "}<Time iso={st.checkedAt} /> on {name(st.serverId)}: {c.roster} on the roster{parts.length ? ` — ${parts.join(" · ")}` : ""}.
          {c.held ? ` Held back: ${c.held}.` : ` ${c.flagged} flagged, ${c.sent} sent to act on.`}
          {c.paced > 0 && ` ${c.paced} already handled within the re-check interval.`}
          {c.unknownPlayers > 0 && ` ${c.unknownPlayers} not in the player directory yet — tried again next check.`}
          {stale && " The roster check has stopped reporting: the server's automation switch may be off or its connection down."}
        </span>,
      );
    }
    if (st.skippedAt && st.skipReason) {
      lines.push(
        <span key={`s-${st.serverId}`}>
          Last held back <Time iso={st.skippedAt} /> on {name(st.serverId)}{st.skipPlayer ? ` (${st.skipPlayer})` : ""}: {st.skipReason}.
        </span>,
      );
    }
  }
  if (!lines.length) return null;
  return <div className="muted rule-status" style={{ fontSize: "0.8rem", marginTop: 4, display: "grid", gap: 2 }}>{lines}</div>;
}

/**
 * When this rule may fire — the native replacement for the retired profile trick of flipping
 * whole modules by schedule. Off = always (stored null, the column default). The window pairs
 * with, never replaces, the enabled switch: a rule outside its hours still reads as ON with its
 * hours beside it, instead of mysteriously off.
 */
const DAY_LABELS: [string, string][] = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
function ActiveHoursEditor({ value, onChange }: {
  value: { start: string; end: string; daysOfWeek?: string[]; timezone?: string } | null;
  onChange: (v: { start: string; end: string; daysOfWeek?: string[]; timezone?: string } | null) => void;
}) {
  const communityTz = useCommunityZone();
  const zones = zoneOptions(communityTz);
  const on = value !== null;
  const days = value?.daysOfWeek ?? [];
  const toggleDay = (d: string) => {
    if (!value) return;
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    onChange({ ...value, daysOfWeek: next.length ? next : undefined });
  };
  return (
    <div style={{ marginTop: 6 }}>
      <Toggle checked={on} label="Only during set hours (off = always active)"
        onChange={(v) => onChange(v
          // The community's zone (falling back to this device's) is what "10pm" means to the
          // person typing it; UTC-by-default is how a night window lands mid-afternoon.
          ? { start: "22:00", end: "06:00", timezone: communityTz ?? deviceZone() }
          : null)} />
      {on && value && (
        <div style={{ marginTop: 6 }}>
          <div className="grid">
            <label>From<input type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} /></label>
            <label>Until<input type="time" value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} /></label>
            <label>Timezone
              <select value={value.timezone ?? "UTC"} onChange={(e) => onChange({ ...value, timezone: e.target.value })}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                {value.timezone && !zones.includes(value.timezone) && <option value={value.timezone}>{value.timezone}</option>}
              </select>
            </label>
          </div>
          <div className="chips" style={{ marginTop: 4 }}>
            {DAY_LABELS.map(([d, label]) => (
              <button key={d} type="button" className={days.includes(d) ? "badge active chip-btn" : "badge chip-btn"} onClick={() => toggleDay(d)}>{days.includes(d) ? "✓ " : ""}{label}</button>
            ))}
          </div>
          <Explanation>
            An end before the start wraps past midnight (22:00–06:00 is the night). No days ticked
            = every day. Outside the window the rule simply holds fire — it stays enabled.
          </Explanation>
        </div>
      )}
    </div>
  );
}

/**
 * The knobs for a param-carrying trigger, mirrored from the server's @app/rules schema. Bespoke
 * per kind rather than schema-fetched: six small forms beat a round-trip for a field list that
 * changes only when the trigger itself does — and the API re-validates every save regardless.
 * Role chips render from the pinned server's game; a community-wide rule edits with that game's
 * labels, which is the best labelling available from where the editor stands.
 */
function TriggerParams({ kind, value, onChange }: { kind: string; value: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const put = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  // The group triggers name a player group; listing them takes the groups permission.
  const [groups, setGroups] = useState<GroupList | null>(null);
  useEffect(() => {
    if (!namesGroup(kind)) return;
    let alive = true;
    void groupList().then((r) => { if (alive) setGroups(r); });
    return () => { alive = false; };
  }, [kind]);
  const communityZone = useCommunityZone();
  if (namesGroup(kind)) {
    const list = groups && "groups" in groups ? groups.groups : [];
    const picked = String(value.groupId ?? "");
    const groupPicker = (
        <label>Group
          <select value={picked} onChange={(e) => put("groupId", e.target.value)}>
            <option value="">— pick a group —</option>
            {/* A rule saved against a group you cannot list (or one since deleted) keeps its id. */}
            {picked && !list.some((g) => g.id === picked) && <option value={picked}>{groups && "groups" in groups ? "a deleted group" : "the group this rule names"}</option>}
            {list.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          {groups && "error" in groups && <span className="hint">The groups couldn&apos;t be listed ({groups.error}) — listing them takes the player groups permission.</span>}
          {groups && "groups" in groups && list.length === 0 && <span className="hint">No groups yet — make one under Players → Groups first.</span>}
        </label>
    );
    if (kind !== SCHEDULE_KIND) return <div className="grid">{groupPicker}</div>;
    const sp = { ...SCHEDULE_DEFAULTS, ...(value as ScheduleParams) };
    const days = scheduleWeekdays(sp);
    const toggleDay = (id: string) => put("weekdays", (days.includes(id) ? days.filter((d) => d !== id) : [...days, id]).join(","));
    return (
      <div>
        <div className="grid">
          {groupPicker}
          <label>Repeat
            <select value={String(sp.repeat)} onChange={(e) => put("repeat", e.target.value)}>
              <option value="monthly">Every month, on a day of the month</option>
              <option value="nth">Every month, on a weekday (e.g. the first Saturday)</option>
              <option value="weekly">Every week, on chosen days</option>
              <option value="dates">On dates I list</option>
            </select>
          </label>
          {sp.repeat === "monthly" && (
            <label>Day of the month
              <input type="number" min={1} max={31} value={Number(sp.monthDay)} onChange={(e) => put("monthDay", Number(e.target.value))} />
              <span className="hint">31 runs on the last day of shorter months.</span>
            </label>
          )}
          {sp.repeat === "nth" && (
            <label>Which
              <span className="control-row">
                <select value={String(sp.nth)} onChange={(e) => put("nth", Number(e.target.value))}>
                  <option value="1">first</option><option value="2">second</option><option value="3">third</option><option value="4">fourth</option><option value="-1">last</option>
                </select>
                <select value={String(sp.nthWeekday)} onChange={(e) => put("nthWeekday", e.target.value)}>
                  {WEEK.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <span className="muted">of every month</span>
              </span>
            </label>
          )}
          {sp.repeat === "dates" && (
            <label>Dates (comma-separated, YYYY-MM-DD)
              <input value={String(sp.dates)} onChange={(e) => put("dates", e.target.value)} placeholder="2026-12-25, 2027-01-01" />
            </label>
          )}
          <label>At ({communityZone ?? "community time"})
            <input type="time" value={String(sp.time)} onChange={(e) => put("time", e.target.value)} />
            <span className="hint">Read in the community&apos;s time zone (Administration → Users &amp; roles → Community time zone).</span>
          </label>
        </div>
        {sp.repeat === "weekly" && (
          <div className="field">
            <div className="field-label">On</div>
            <div className="chips">
              {WEEK.map((d) => (
                <button key={d.id} type="button" className={days.includes(d.id) ? "badge active chip-btn" : "badge chip-btn"} onClick={() => toggleDay(d.id)}>{days.includes(d.id) ? "✓ " : ""}{d.short}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  // The roster triggers' knobs and the restricted-weapon trigger's — shared with Player triggers.
  return <StateTriggerParams kind={kind} value={value} onChange={onChange} />;
}

/**
 * A VIP time or cooldown: a number and a unit, saved as minutes. Keeps its own text so "1." or a
 * cleared box survive typing; blank reports "" so the save falls back to the default (formNumber).
 */
function VipSpanField({ label, minutes, min, onChange }: { label: string; minutes: unknown; min: number; onChange: (m: number | "") => void }) {
  const start = minutes === "" || minutes === null || minutes === undefined ? null : splitMinutes(Number(minutes));
  const [unit, setUnit] = useState<VipUnit>(start?.unit ?? "minutes");
  const [raw, setRaw] = useState<string>(start ? String(start.value) : "");
  const emit = (r: string, u: VipUnit) => { const m = joinMinutes(r, u); onChange(Number.isFinite(m) ? m : ""); };
  const over = Number.isFinite(joinMinutes(raw, unit)) && joinMinutes(raw, unit) > VIP_SPAN_MAX_MINUTES;
  return (
    <label>{label}
      <span className="control-row">
        <input type="number" min={min} step="any" style={{ width: 90 }} value={raw}
          onChange={(e) => { const r = stripLeadingZeros(e.target.value); setRaw(r); emit(r, unit); }} />
        <select value={unit} onChange={(e) => { const u = e.target.value as VipUnit; setUnit(u); emit(raw, u); }}>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </span>
      {over && <span className="hint">A year is the most a rule can give.</span>}
    </label>
  );
}

/** The question asked before a save or a switch-on that would double up on another rule. */
function clashConfirm(clashes: Clash[], confirmLabel: string) {
  return {
    title: clashes.length === 1 ? "This rule clashes with another" : `This rule clashes with ${clashes.length} others`,
    body: (
      <div className="rule-clashes">
        <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>{clashes.map((c, i) => <li key={i}>{c.text}</li>)}</ul>
        <p className="hint m-0">Same trigger, the same servers and the same count. If that is what you want — say, two rules on purpose — go ahead.</p>
      </div>
    ),
    confirmLabel,
  };
}

function RuleForm({ initial, ruleId, onSaved, onCancel, guildRoles, guildRolesNote, sections = [], allRules = [] }: { initial: Partial<Rule>; ruleId?: string; onSaved: () => void; onCancel: () => void; guildRoles: GuildRole[]; guildRolesNote: string; sections?: RuleSection[]; allRules?: Rule[] }) {
  const confirm = useConfirm();
  // A team-switch rule saved before it was refused the move (the move is itself a team switch):
  // its action cannot be shown — the list no longer offers it — so it opens on "message" with a
  // note saying so, rather than showing one action and saving another.
  const legacyMove = initial.eventKind === TEAM_SWITCH_KIND && (initial.action === "switch" || (initial.escalateActions ?? []).includes("switch"));
  const [f, setF] = useState<Partial<Rule>>({
    ...initial, match: initial.match ?? "", reason: initial.reason ?? "", requireRoleIds: initial.requireRoleIds ?? [], immuneTags: initial.immuneTags ?? [], immuneRoleIds: initial.immuneRoleIds ?? [], requireTags: initial.requireTags ?? [],
    ...(legacyMove ? { action: initial.action === "switch" ? "message" : initial.action, escalateActions: (initial.escalateActions ?? []).filter((a) => a !== "switch") } : {}),
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Rule) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const isIdle = f.eventKind === IDLE_KIND;
  const isState = isStateKind(f.eventKind);
  const hasParams = Boolean(DEFAULT_PARAMS[f.eventKind ?? ""]);
  const isDisconnect = f.eventKind === DISCONNECT_KIND;
  const isTeamSwitch = f.eventKind === TEAM_SWITCH_KIND;
  const isNoVip = f.eventKind === NO_VIP_KIND;
  const isGroup = isGroupKind(f.eventKind);
  const isSchedule = f.eventKind === SCHEDULE_KIND;
  const vipTrigger = isNoVip || f.eventKind === PLAYTIME_KIND;
  const groupNames = useGroupNames(isGroup || isSchedule);
  // Counting per match only means something where occurrences are counted: plain events, above 1.
  const canCountPerMatch = !isIdle && !isState && !isDisconnect && !isGroup && !isSchedule && Number(f.threshold ?? 1) > 1;
  const scheduleParams = { ...SCHEDULE_DEFAULTS, ...((f.params ?? {}) as ScheduleParams) };
  const perMatch = canCountPerMatch && f.countPerMatch === true;
  // Which Ban hours field to show — decided over the WHOLE ladder, not just the first action,
  // because one rule-level hours serves every rung (lib/ruleHours spells out the three cases).
  const hoursMode = banHoursMode(f.action, f.escalateActions);
  // The event decides the action family: a disconnected player can only be granted VIP (nothing
  // else reaches them), "player has no VIP" starts at granting it, and VIP means nothing anywhere
  // else — switching kinds snaps to legal. Landing on a VIP trigger also resets the VIP time to
  // that trigger's scale: minutes to rejoin after a crash, a day for somebody without VIP.
  const setKind = (eventKind: string) => {
    const patch: Partial<Rule> = { eventKind };
    if (eventKind === DISCONNECT_KIND) Object.assign(patch, { action: "vip", vipMinutes: 10, vipCooldownMinutes: 60 });
    else if (eventKind === NO_VIP_KIND) Object.assign(patch, { action: "vip", vipMinutes: 1440, vipCooldownMinutes: 30 * 1440 });
    // A milestone reward: a week of VIP, once a month, until someone decides otherwise. A
    // milestone stays reached, so the rule starts with a per-player limit too.
    else if (eventKind === PLAYTIME_KIND) Object.assign(patch, { action: "vip", vipMinutes: 7 * 1440, vipCooldownMinutes: 30 * 1440, capCount: 1, capPeriod: "month" });
    // A group change is one event, not a count, and its rule takes only what reaches somebody who
    // may be on no server — starting at a week of VIP, with no limit until someone sets one.
    else if (isGroupKind(eventKind)) Object.assign(patch, { action: GROUP_ACTIONS.includes(f.action ?? "") ? f.action : "vip", vipMinutes: 7 * 1440, vipCooldownMinutes: 0, threshold: 1, windowSec: 0, escalateActions: [], countPerMatch: false });
    // A schedule starts as the monthly grant it was asked for: thirty days, stacked.
    else if (eventKind === SCHEDULE_KIND) Object.assign(patch, { action: SCHEDULE_ACTIONS.includes(f.action ?? "") ? f.action : "vip", vipMinutes: 30 * 1440, threshold: 1, windowSec: 0, delaySec: 0, escalateActions: [], countPerMatch: false });
    else if (f.action === "vip") patch.action = "message";
    // The schedule's taking actions exist nowhere else.
    if (eventKind !== SCHEDULE_KIND && ["viprevoke", "viptrim", "vipreduce"].includes(patch.action ?? f.action ?? "")) patch.action = "message";
    // A strong player is not proof of anything: the kill-rate trigger starts at "tell staff" —
    // once a match per player, not once a minute for as long as they keep it up.
    if (eventKind === KILL_RATE_KIND) Object.assign(patch, { action: "note", capCount: 1, capPeriod: "match" });
    // A cam rule almost always means "tell me", not "punish the admin" — preset, not forced.
    if (CAM_KINDS.includes(eventKind)) patch.action = "note";
    if (eventKind === IDLE_KIND && (Number(f.windowSec) || 0) < 60) patch.windowSec = 1800;
    // Param-carrying triggers start from their defaults — carrying another kind's params over
    // would save knobs the new trigger cannot read. State triggers pace by windowSec (the
    // re-check interval), so give it a sane starting cadence too.
    patch.params = DEFAULT_PARAMS[eventKind] ? { ...DEFAULT_PARAMS[eventKind] } : null;
    if (isStateKind(eventKind) && (Number(f.windowSec) || 0) < 30) patch.windowSec = 60;
    // Somebody without VIP stays without it until a grant lands: a message-only rule re-checking
    // every minute would say the same thing to them sixty times an hour.
    if (eventKind === NO_VIP_KIND || eventKind === NO_DISCORD_KIND || eventKind === PLAYTIME_KIND || eventKind === CLAN_KIND) patch.windowSec = 1800;
    // A team-switch rule cannot move the player (see actionsFor) — off the action and the ladder.
    if (eventKind === TEAM_SWITCH_KIND) {
      if ((patch.action ?? f.action) === "switch") patch.action = "message";
      if ((f.escalateActions ?? []).includes("switch")) patch.escalateActions = (f.escalateActions ?? []).filter((a) => a !== "switch");
    }
    setF({ ...f, ...patch });
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const body = {
      name: f.name, serverId: f.serverId ?? null, eventKind: f.eventKind, action: f.action,
      match: (f.match as string)?.trim() || null,
      threshold: Number(f.threshold ?? 1), windowSec: Number(f.windowSec ?? 0),
      reason: (f.reason as string)?.trim() || null,
      // Hours ride along whenever ANY step bans — tempban or full ban, first action or ladder
      // rung — because the enforcer reads the one rule-level hours for every rung. The mode
      // logic lives in lib/ruleHours; deciding it inline here once dropped the ladder-ban case
      // and made every "then ban" step permanent with no way to set removal hours.
      hours: ruleHoursForSave(f.action, f.escalateActions, f.hours),
      delaySec: Number(f.delaySec ?? 0),
      // Blank must fall back to the default, not to zero — for the cooldown, zero is the one
      // value that turns the anti-farm protection off. See lib/formNumber.
      vipMinutes: numberOr(f.vipMinutes, 10),
      vipCooldownMinutes: numberOr(f.vipCooldownMinutes, 60),
      requireRoleIds: f.requireRoleIds ?? [],
      immuneTags: f.immuneTags ?? [],
      immuneRoleIds: f.immuneRoleIds ?? [],
      immuneLevel: numberOr(f.immuneLevel, 0),
      dryRun: f.dryRun === true,
      // A crash-VIP rule never carries a ladder — the API refuses it, and the UI never offers it.
      escalateActions: f.action === "vip" || f.action === "points" || isGroup || isSchedule ? [] : (f.escalateActions ?? []).filter(Boolean),
      escalateResetMinutes: numberOr(f.escalateResetMinutes, 120),
      alertEnabled: f.alertEnabled !== false,
      alertChannelId: (f.alertChannelId ?? "").trim() || null,
      params: f.params ?? null,
      activeHours: f.activeHours ?? null,
      playersMin: numberOr(f.playersMin, 0),
      playersMax: numberOr(f.playersMax, 0),
      breakerLimit: numberOr(f.breakerLimit, 10),
      matchMinutesMin: numberOr(f.matchMinutesMin, 0),
      matchMinutesMax: numberOr(f.matchMinutesMax, 0),
      countPerMatch: perMatch,
      requireTags: f.requireTags ?? [],
      capCount: numberOr(f.capCount, 0),
      capPeriod: f.capPeriod ?? "day",
      actionTag: (f.actionTag ?? "").trim() || null,
      points: numberOr(f.points, 0),
      // Filing only: a section that has since been removed files the rule nowhere.
      sectionId: f.sectionId && sections.some((x) => x.id === f.sectionId) ? f.sectionId : null,
    };
    // Re-filing a rule its section's switch is holding sets it firing on save — asked first.
    if (ruleId && initial.enabled !== false && initial.sectionOff) {
      const armed = rulesAMoveWouldArm([{ id: ruleId, enabled: true, sectionOff: true, sectionId: initial.sectionId ?? null }], new Set([ruleId]), body.sectionId ?? null, sections);
      const where = body.sectionId ? `"${sections.find((x) => x.id === body.sectionId)?.name ?? "that section"}"` : "Other rules";
      if (armed.length && !(await confirm({
        title: "Start this rule firing?",
        body: `It is held by its section's switch, which is off. Filed under ${where}, nothing holds it any more, so it starts acting on players as soon as it is saved.`,
        confirmLabel: "Save anyway",
      }))) { setBusy(false); return; }
    }
    // A rule that would punish the same player twice for one event — or warn them in the same
    // breath as punishing them — is asked about before it is saved, not discovered in Activity.
    const clashes = ruleClashes({
      ...body, id: ruleId, name: body.name ?? "", eventKind: body.eventKind ?? "", action: body.action ?? "",
      enabled: ruleId ? initial.enabled !== false : true,
      sectionOff: sections.find((x) => x.id === body.sectionId)?.enabled === false,
    }, allRules);
    if (clashes.length && !(await confirm(clashConfirm(clashes, "Save anyway")))) { setBusy(false); return; }
    try {
      if (ruleId) await api(`/enforcer/rules/${ruleId}`, { method: "PATCH", body });
      else await api("/enforcer/rules", { method: "POST", body });
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 12 }}>
      {legacyMove && <p className="hint notice">This rule moved the player to the other team. A team-switch rule can&apos;t — the move is itself a team switch, so the rule would set itself off — and it has been held since. Moving is taken off below; check what it should do instead and save.</p>}
      <div className="grid">
        <label>Name<input value={f.name ?? ""} onChange={set("name")} required /></label>
        <label>Applies to
          <ServerScopeSelect value={f.serverId ?? null} onChange={(v) => setF({ ...f, serverId: v })} />
        </label>
        {sections.length > 0 && (
          <label>Section
            <select value={f.sectionId && sections.some((x) => x.id === f.sectionId) ? f.sectionId : ""} onChange={(e) => setF({ ...f, sectionId: e.target.value || null })}>
              <option value="">Other rules (no section)</option>
              {sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
        )}
        <label>On event
          <select value={isState ? ROSTER_GROUP : f.eventKind} onChange={(e) => setKind(e.target.value === ROSTER_GROUP ? STATE_KINDS[0]! : e.target.value)}>
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{kindLabelPlus(k)}</option>)}
            <option value={ROSTER_GROUP}>{ROSTER_GROUP_LABEL}</option>
          </select>
        </label>
        {isState && (
          <label>Live roster check
            <select value={f.eventKind} onChange={(e) => setKind(e.target.value)}>{STATE_KINDS.map((k) => <option key={k} value={k}>{checkLabel(k)}</option>)}</select>
          </label>
        )}
        {!isIdle && !hasParams && <label>Match (optional regex)<input value={(f.match as string) ?? ""} onChange={set("match")} placeholder={isTeamSwitch ? "e.g. 2nd this round" : "e.g. slur|racist"} />
          {/* What a team switch reads as — the join onto the other side is the swap. */}
          {isTeamSwitch && <span className="hint">Fires only when a player lands on the other side &mdash; never for dropping to Unassigned, joining at connect, or coming back to the side they left. Leave the match empty for every swap, or name part of what the Game log shows (&ldquo;switched sides Allies → Axis (2nd this round)&rdquo;), like &ldquo;2nd this round&rdquo; or &ldquo;→ Axis&rdquo;. Count per match to catch repeat swappers; staff moves and the game&rsquo;s own balancing land on the other side too, so start it on a trial run.</span>}</label>}
        <label>Action
          <select value={f.action} onChange={set("action")} disabled={isDisconnect}>
            {isDisconnect
              ? <option value="vip">{actionLabel("vip")}</option>
              : (isGroup ? GROUP_ACTIONS : isSchedule ? SCHEDULE_ACTIONS : [...(vipTrigger ? ["vip"] : []), ...actionsFor(f.eventKind), ...REWARD_ACTIONS]).map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
          </select>
        </label>
        {!isIdle && !isState && !isDisconnect && !isGroup && !isSchedule && <label>Threshold (matches)<input type="number" min="1" value={f.threshold ?? 1} onChange={set("threshold")} /></label>}
        {!perMatch && !isGroup && !isSchedule && <label>{isIdle ? "No kills for (seconds)" : isState ? "Re-check interval (seconds)" : "Window (seconds)"}<input type="number" min={isIdle ? 60 : isState ? 30 : 0} value={f.windowSec ?? 0} onChange={set("windowSec")} /></label>}
        {!isSchedule && <label>Wait before acting (seconds)<input type="number" min="0" max="3600" value={f.delaySec ?? 0} onChange={set("delaySec")} /></label>}
        {/* A schedule's amount: what it grants, or what it cuts back to or by (a revoke takes it all). */}
        {isSchedule && f.action !== "viprevoke" && <VipSpanField key={`sched-${f.action}`} label={f.action === "viptrim" ? "Cut back to (at most)" : f.action === "vipreduce" ? "Cut back by" : "VIP to grant"} minutes={f.vipMinutes} min={1}
          onChange={(m) => setF({ ...f, vipMinutes: m as number })} />}
        {f.action !== "vip" && !isSchedule && <label>{REASON_LABELS[f.action ?? ""] ?? "Reason / message"}<input value={(f.reason as string) ?? ""} onChange={set("reason")} placeholder={f.action === "points" ? "+{points} points for playing with us!" : isDeathKind(f.eventKind) ? "Killed by {attacker_name} — report team kills in Discord." : hasParams ? "{violation} — fills with what was detected" : ""} />
          <PlaceholderHint extra={["attacker_name", "victim_name", "weapon", "violation", ...(f.action === "points" ? ["points"] : [])]} /></label>}
        {/* A crash VIP's player is gone — nobody to read a message. Anywhere else the grant can
            say something, sent AFTER it lands so {vip_until} reads the VIP just given. */}
        {f.action === "vip" && !isDisconnect && !isSchedule && <label>Message after granting (optional{isGroup ? " — sent only if they're on the server" : ""})<input value={(f.reason as string) ?? ""} onChange={set("reason")} placeholder={isGroup ? "Welcome to the team — VIP until {vip_until}" : "You've got VIP until {vip_until} — welcome in!"} />
          <PlaceholderHint /></label>}
        {/* Keyed on the trigger so switching kinds remounts them on that kind's defaults. */}
        {f.action === "vip" && !isSchedule && <VipSpanField key={`vip-${f.eventKind}`} label="VIP for" minutes={f.vipMinutes} min={1}
          onChange={(m) => setF({ ...f, vipMinutes: m as number })} />}
        {f.action === "vip" && !isSchedule && <VipSpanField key={`cool-${f.eventKind}`} label="Once per player every (0 = no limit)" minutes={f.vipCooldownMinutes} min={0}
          onChange={(m) => setF({ ...f, vipCooldownMinutes: m as number })} />}
        {(f.action === "tag" || (f.escalateActions ?? []).includes("tag")) && (
          <label>Tag to add<input value={f.actionTag ?? ""} onChange={(e) => setF({ ...f, actionTag: e.target.value })} placeholder="e.g. warned" required /></label>
        )}
        {f.action === "points" && <label>Points to grant<input type="number" min="1" max="100000" value={f.points ?? 0} onChange={set("points")} /></label>}
        {/* Shown whenever any step bans — a ladder rung counts: its ban reads this same field. */}
        {hoursMode === "required" && <label>Ban hours<input type="number" min="1" value={f.hours ?? 2} onChange={set("hours")} /></label>}
        {hoursMode === "optional" && <label>Ban hours (blank = permanent ban)<input type="number" min="1" value={f.hours ?? ""} onChange={set("hours")} /></label>}
      </div>
      {canCountPerMatch && (
        <Toggle checked={perMatch} onChange={(v) => setF({ ...f, countPerMatch: v })}
          label={`Count per match — ${f.threshold ?? 1} in one match, instead of within the window`} />
      )}
      {hasParams && <TriggerParams kind={f.eventKind!} value={(f.params as Record<string, unknown>) ?? DEFAULT_PARAMS[f.eventKind!]!} onChange={(p) => setF({ ...f, params: p })} />}
      {isSchedule && f.action === "vip" && (
        <Toggle checked={scheduleParams.stack !== false} onChange={(v) => setF({ ...f, params: { ...scheduleParams, stack: v } })}
          label={scheduleParams.stack !== false ? "Stack onto the time they already have" : "Make sure everyone has at least this long (never shortens)"} />
      )}
      {!isSchedule && <>
      <RoleDisclosure label="Only for players holding" emptyLabel="anyone" someLabel="any of these Discord roles"
        roles={guildRoles} note={guildRolesNote} value={f.requireRoleIds ?? []}
        onChange={(ids) => setF({ ...f, requireRoleIds: ids })} />
      {(f.requireRoleIds?.length ?? 0) > 0 && (
        <p className="hint">Role gates need the player linked over the VIP panel&apos;s registration — an unlinked player never passes one.</p>
      )}
      {/* The exemptions. Seeding and the packaged rule modules have always had these; rules — the
          only ones that can ban — did not, so a team-kill rule punished your own admins with no
          way to say otherwise. */}
      <RoleDisclosure label="Never act on players holding" emptyLabel="nobody is exempt" someLabel="any of these Discord roles"
        roles={guildRoles} note={guildRolesNote} value={f.immuneRoleIds ?? []}
        onChange={(ids) => setF({ ...f, immuneRoleIds: ids })} />
      <div className="grid">
        <label>Only act on players tagged (comma-separated, blank = anyone)
          <input value={(f.requireTags ?? []).join(", ")} placeholder="e.g. new, watchlist"
            onChange={(e) => setF({ ...f, requireTags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} />
        </label>
        <label>Never act on players tagged (comma-separated)
          <input value={(f.immuneTags ?? []).join(", ")} placeholder="e.g. staff, trusted"
            onChange={(e) => setF({ ...f, immuneTags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} />
        </label>
        <label>Never act at or below level (0 = off)
          <input type="number" min="0" max="1000" value={f.immuneLevel ?? 0}
            onChange={(e) => setF({ ...f, immuneLevel: Number(e.target.value) })} />
        </label>
      </div>
      <Explanation>
        Tags come from a player&apos;s profile, roles from your community Discord, and the level is
        whatever the server last reported for them. Any one of them makes this rule skip the player
        entirely — no warning, no ladder step. A player never seen on a roster has no known level
        and is not exempt by it; and if Discord cannot be reached the rule holds fire rather than
        risk acting on someone it was told to leave alone.
      </Explanation>
      <ActiveHoursEditor value={f.activeHours ?? null} onChange={(v) => setF({ ...f, activeHours: v })} />
      </>}
      {!isSchedule && <div className="grid" style={{ marginTop: 6 }}>
        {!isGroup && <>
        <label>Active from (players, 0 = any)
          <input type="number" min="0" max="100" value={f.playersMin ?? 0} onChange={set("playersMin")} />
          <span className="hint">Below this population the rule holds fire — seeding is left alone.</span>
        </label>
        <label>Active up to (players, 0 = any)
          <input type="number" min="0" max="100" value={f.playersMax ?? 0} onChange={set("playersMax")} />
        </label>
        <label>Active from minute of the match (0 = from the start)
          <input type="number" min="0" max="600" value={f.matchMinutesMin ?? 0} onChange={set("matchMinutesMin")} />
        </label>
        <label>…until minute (0 = to the end)
          <input type="number" min="0" max="600" value={f.matchMinutesMax ?? 0} onChange={set("matchMinutesMax")} />
          <span className="hint">&ldquo;Only in the first 10 minutes&rdquo; is 0 and 10. If the match start isn&apos;t known, a rule with a window here holds fire.</span>
        </label>
        </>}
        {/* A group rule's VIP lands once per server of the member's game; this cap counts across
            servers and would stop at the first — the VIP "once per player every…" above is its limit. */}
        {!(isGroup && f.action === "vip") && <label>At most (times per player, 0 = no limit)
          <span className="control-row">
            <input type="number" min="0" max="1000" style={{ width: 90 }} value={f.capCount ?? 0} onChange={set("capCount")} />
            <span className="muted">per</span>
            <select value={f.capPeriod ?? "day"} onChange={set("capPeriod")}>
              {CAP_PERIODS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </span>
          <span className="hint">Counts this rule&apos;s own firings on the player, restarts included — &ldquo;1 per ever&rdquo; is a one-time welcome.</span>
        </label>}
        <label>Safety limit (players per minute, 0 = off)
          <input type="number" min="0" max="1000" value={f.breakerLimit ?? 10} onChange={set("breakerLimit")} />
          <span className="hint">If this rule acts on more than this many players inside a minute it disables itself and pings its alert channel — the brake for a mistyped list.</span>
        </label>
      </div>}
      {/* Per rule, because "tell me about the automod" is not one appetite: the idle-kick firing
          forty times a night is what makes somebody mute the channel, and muting it takes the
          twice-a-week temp bans with it. On by default; the server-wide alert (channel + role)
          still has to be set up under Discord for any of it to arrive. */}
      {/* Per rule, not per server: observe mode already rehearses EVERY rule at once, which is
          the wrong grain for trying one new rule out while the rest keep working. */}
      <Toggle checked={f.dryRun === true} onChange={(v) => setF({ ...f, dryRun: v })}
        label="Trial run — record what it would do, touch nobody" />
      <Toggle checked={f.alertEnabled !== false} onChange={(v) => setF({ ...f, alertEnabled: v })}
        label="Ping Discord when this rule fires" />
      {f.alertEnabled !== false && (
        <div className="grid" style={{ marginTop: 6 }}>
          <label>Alert channel id (blank = the shared rules channel)
            <input value={f.alertChannelId ?? ""} placeholder="Channel id (optional)"
              onChange={(e) => setF({ ...f, alertChannelId: e.target.value })} />
          </label>
          <Explanation>
            A channel set here stands on its own — this rule pings it even if the server-wide
            &ldquo;Player rules firing&rdquo; alert is off. Right-click the channel in Discord →
            Copy Channel ID.
          </Explanation>
        </div>
      )}

      {f.action !== "vip" && f.action !== "points" && !isGroup && !isSchedule && (
        <div className="rule-escalation">
          <span className="field-label m-0">If they keep doing it</span>
          {/* Step N of the ladder = offence N+1; the last step repeats for every offence past it.
              Rendered as sentence chips rather than a list editor: "then X, then Y" is how staff
              would say the policy out loud. */}
          {(f.escalateActions ?? []).map((a, i) => (
            <span key={i} className="control-row rule-esc-step">
              <span className="muted">then</span>
              <select value={a} onChange={(e) => {
                const next = [...(f.escalateActions ?? [])];
                next[i] = e.target.value;
                setF({ ...f, escalateActions: next });
              }}>
                {actionsFor(f.eventKind).map((x) => <option key={x} value={x}>{actionLabel(x)}</option>)}
              </select>
              <button type="button" className="ghost mini" title="Remove this step"
                onClick={() => setF({ ...f, escalateActions: (f.escalateActions ?? []).filter((_, x) => x !== i) })}>✕</button>
            </span>
          ))}
          {(f.escalateActions ?? []).length < MAX_ESCALATION_STEPS && (
            <button type="button" className="ghost mini"
              onClick={() => setF({ ...f, escalateActions: [...(f.escalateActions ?? []), "punish"] })}>
              + escalate on repeat
            </button>
          )}
          {(f.escalateActions ?? []).length > 0 && (
            <label className="inline">Forget offences after (minutes)
              <input type="number" min="0" max="10080" style={{ width: 90 }}
                value={f.escalateResetMinutes ?? 120}
                onChange={set("escalateResetMinutes")} />
            </label>
          )}
          {(f.escalateActions ?? []).length > 0 && (
            <p className="hint">
              First offence: {actionLabel(f.action ?? "")}. {(f.escalateActions ?? []).map((a, i) => `Offence ${i + 2}: ${actionLabel(a)}`).join(". ")}.
              {" "}The last step repeats. One reason/message serves every step; offences are per player and forgotten after the window above (0 = only on restart).
              {/* The ladder sits at the bottom of the form and the hours field near the top —
                  without this pointer, "then ban" reads like a step with no length control. */}
              {hoursMode !== "none" && <> Banning steps take their length from the &ldquo;Ban hours&rdquo; field above{hoursMode === "optional" ? " (blank = permanent)" : ""}.</>}
            </p>
          )}
        </div>
      )}
      {(Number(f.delaySec) || 0) > 0 && (
        <Explanation>While waiting, presence is re-checked: message/punish/kick and a no-VIP grant only land if the player is still on the server; crash VIP only if they haven&apos;t already made it back in.</Explanation>
      )}
      {f.action === "vip" && isDisconnect && (
        <Explanation>Crash VIP: a player who disconnects gets temporary VIP so the queue doesn&apos;t punish a game crash. Kicked or banned players never get it, and it never shortens VIP they already hold. Cleaned up automatically when it expires.</Explanation>
      )}
      {f.eventKind === PLAYTIME_KIND && (
        <Explanation>
          Fires for players on the server whose playtime has reached the hours set — recorded visits plus the one in progress.
          Set &ldquo;at most once per player&rdquo; (or the VIP &ldquo;once per player every…&rdquo;) to how often a milestone should pay, or it pays again every re-check.
        </Explanation>
      )}
      {f.eventKind === CLAN_KIND && (
        <Explanation>
          Fires for players on the server wearing any spelling of the chosen tags. Players type their own tags, so anyone can put one on.
          The re-check interval is how often someone still wearing it hears this again.
        </Explanation>
      )}
      {f.eventKind === KILL_RATE_KIND && (
        <Explanation>
          Reads this match&apos;s kills and deaths from the live roster. The rate is measured over the time they&apos;ve played this match.
          A great player trips it too — &ldquo;record &amp; ping&rdquo; lets staff take a look before anything happens to them.
        </Explanation>
      )}
      {f.eventKind === RATIO_KIND && (
        <Explanation>
          Reads this match&apos;s kills, deaths and team kills from the live roster at each re-check, so nothing is written until it fires.
          Team kills to kills at or above 2 catches someone killing twice as many of their own side as the enemy; the minimum keeps a match&apos;s first minutes out of it.
        </Explanation>
      )}
      {isNoVip && (
        <Explanation>
          Fires for players on the server with no VIP at all — not ours, not on the game&apos;s own list, and not
          paused. Anyone holding VIP of any kind is never touched, a grant never shortens anything, and if the
          game&apos;s VIP list can&apos;t be read the rule waits rather than guess.
          {f.action === "vip" && <> The &ldquo;once per player&rdquo; limit is what stops a returning player getting it again the moment it runs out — set it to how often you mean them to have it.</>}
          {f.action !== "vip" && <> The re-check interval is how often a player still without VIP hears this again.</>}
        </Explanation>
      )}
      {f.action !== "vip" && (
        <p className="hint">
          Message tokens: <code>{"{player_name}"}</code> (whoever the rule acts on), <code>{"{attacker_name}"}</code>,
          {" "}<code>{"{victim_name}"}</code>, <code>{"{weapon}"}</code>. Anything else is left as you typed it.
        </p>
      )}
      {isDeathKind(f.eventKind) && (
        <Explanation>
          This is the kill event read from the other end: the action lands on the player who <em>died</em>, not the
          one who killed them, and the threshold counts their deaths. On a busy server every death fires, so a
          threshold — say 5 deaths within 60 seconds — is usually what you want. Punish would kill an
          already-dead player, so message is the action that fits.
        </Explanation>
      )}
      {(f.eventKind === "evt.chat.team" || f.eventKind === "evt.chat.squad") && (
        <Explanation>
          Map-vote ballots are exempt: a chat line that is just a number (&ldquo;2&rdquo;, &ldquo;!3&rdquo;) is how
          players vote in the in-game map vote, so it never fires a chat rule and never counts toward its
          threshold — this rule included. Everything else in chat counts as normal.
        </Explanation>
      )}
      {isSchedule && (
        <Explanation>
          Runs {describeSchedule(scheduleParams)}, in the community&apos;s time zone, on every member of the group at once
          — each member on the servers of their own game ({f.serverId ? "this rule: only the server above" : "or only the server above, if you pin one"}).
          Each date runs once; if the panel was down when one came round, it runs as soon as it is back — only the latest
          missed date, never a backlog. A date that had already passed when you save the rule doesn&apos;t run.
          {" "}Only <strong>timed</strong> VIP is touched: permanent VIP, VIP a group perk holds, and VIP set on the game outside
          the panel are left exactly as they are; a grant never shortens anyone, and a cut back that uses a grant up removes it.
          Servers in observe mode, with rules switched off, or whose VIP expiry the panel doesn&apos;t run are skipped. Each run
          is one entry in Auto settings → History, with everyone it left alone and why.
          {" "}On a group a schedule acts on, adding members takes the key it uses — VIP grant to grant, VIP revoke to take away.
        </Explanation>
      )}
      {isGroup && (
        <Explanation>
          Fires within seconds of a player being {f.eventKind === GROUP_JOINED_KIND ? "added to" : "removed from"} the group
          — from the Groups page or a profile — whether or not they are on a server. VIP lands on each server of their own
          game ({f.serverId ? "this rule: only the server above" : "or only the server above, if you pin one"}); points, a tag
          or a note happen once. Re-adding someone already listed is not a join. A console player the panel has never seen
          could belong to either game, so the rule waits for them to join a server once (and points or a tag wait for any
          player with no profile yet); it runs then, if that is within 30 days. A waiting change is dropped if the member
          is removed (or added back) first, or if this rule is saved, switched off or on, or taken out of its trial run
          meanwhile — the rule acts only on changes made since it was last saved.
          {f.action === "vip" && <> It never shortens VIP they already hold, and members holding permanent VIP are left as they are.</>}
          {" "}On a group this rule watches, adding or removing a member takes the keys this rule uses — VIP grant for VIP, the payout key for points, the tag key for tags.
        </Explanation>
      )}
      {isIdle && (
        <Explanation>Checked about once a minute against players seen connecting or killing. The clock starts when they join and resets on every kill (team kills included); a still-idle player is acted on once per window. Note: the punish action only lands on a spawned player.</Explanation>
      )}
      <p className="muted fs-sm">{summarize(f, groupNames)}</p>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>{ruleId ? "Save" : "Create rule"}</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
      <ActionResult error={err} />
    </form>
  );
}

/** "All servers" or the one server this rule is pinned to. */
function RuleScopeBadge({ serverId }: { serverId: string | null }) {
  const { servers } = useServers();
  if (!serverId) return <span className="badge">all servers</span>;
  return <span className="badge">{servers.find((s) => s.id === serverId)?.name ?? "unknown server"}</span>;
}

function ServerScopeSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { servers } = useServers();
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">All servers</option>
      {servers.map((s) => <option key={s.id} value={s.id}>{s.name} only</option>)}
    </select>
  );
}
