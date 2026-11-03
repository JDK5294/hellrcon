/**
 * The maths behind the five analytics pages.
 *
 * Everything here is a PURE function over rows the caller has already fetched, for two reasons:
 * it can be tested without a database, and it keeps the "what does this number mean" decisions in
 * one readable place instead of scattered through SQL and JSX.
 *
 * A rule that shows up repeatedly below: a rate computed from a tiny denominator is noise wearing
 * a percentage sign. "100% win rate" over two rounds tells you nothing, and putting it at the top
 * of a leaderboard actively misleads. Every ranked rate here therefore carries its denominator,
 * and the callers that sort by one apply a minimum sample.
 */
import type { MatchRow, AuditRow, PlayerMatchStatRow, PlatformBreakdown, PlatformTrend, PlayerBanRow } from "@app/db";
import { emptyPlatformSums, emptyPlatformTrendRow } from "@app/db";
import { WEEKDAYS, zonedParts } from "@app/schedule";

/** weekday name -> 0-6, matching the grid's Sun-first row order. */
const WEEKDAY_INDEX: Record<string, number> = Object.fromEntries(WEEKDAYS.map((d, i) => [d, i]));

// ---------------------------------------------------------------- shared shapes

export interface Bucketed { label: string; value: number }

/** A 7×24 grid, [day 0=Sunday][hour], counting timestamps. The shape the heatmap wants. */
/*
 * Every "by hour", "by day" and week grid on the analytics pages was bucketed in UTC. For a
 * community that is not on UTC that is not a rounding error — it moves activity to the wrong DAY.
 * A Saturday 8pm peak in US Central lands at 02:00 Sunday in a UTC grid, so the busiest evening of
 * the week reads as dead, Sunday morning reads as busy, and the "hours with nothing at all" figure
 * points staff at the wrong gaps to cover. The charts were confidently wrong rather than empty,
 * which is the harder kind to notice.
 *
 * Buckets are therefore taken in a caller-supplied zone, defaulting to UTC so an old client that
 * sends none gets exactly what it got before. `zonedParts` is @app/schedule's — the same hardened
 * one the map-vote and auto-settings windows use, so there is one timezone implementation here, and
 * an unusable zone falls back to UTC rather than throwing.
 */
export const UTC = "UTC";

/** Hour of day (0-23) in `tz`, or null when the timestamp isn't one. */
export function hourIn(ts: string, tz: string): number | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(zonedParts(d, tz).minutes / 60);
}

/** Calendar date "YYYY-MM-DD" in `tz` — NOT ts.slice(0, 10), which is always the UTC date. */
export function dayIn(ts: string, tz: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function weekHourGrid(timestamps: string[], tz: string = UTC): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const ts of timestamps) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const p = zonedParts(d, tz);
    const row = grid[WEEKDAY_INDEX[p.weekday] ?? 0]!;
    const hour = Math.floor(p.minutes / 60);
    row[hour] = (row[hour] ?? 0) + 1;
  }
  return grid;
}

/** Quantile over an already-unsorted list, matching Postgres' percentile_cont interpolation. */
export function quantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return Math.round(v[lo]! + (v[hi]! - v[lo]!) * (pos - lo));
}

// ---------------------------------------------------------------- matches

export interface MapStat {
  map: string;
  rounds: number;
  alliesWins: number;
  axisWins: number;
  /** Allied win share over DECIDED rounds only; null when none were decided. */
  alliesWinRate: number | null;
  /** Mean absolute score gap — how one-sided this map tends to be. 5-0 is a stomp, 3-2 is a game. */
  avgMargin: number | null;
  /** Share of decided rounds that ended 5-0 (or the mode's equivalent maximum gap). */
  blowoutRate: number | null;
  avgDurationSec: number | null;
}

export interface MatchTrends {
  rounds: number;
  decided: number;
  alliesWins: number;
  axisWins: number;
  /** Overall allied win share over decided rounds — the headline balance number. */
  alliesWinRate: number | null;
  avgDurationSec: number | null;
  medianDurationSec: number | null;
  avgMargin: number | null;
  blowoutRate: number | null;
  byMap: MapStat[];
  /** Rounds started per hour of day / day of week, and the week×hour grid. */
  byHour: number[];
  weekHour: number[][];
  /** Round outcomes over time, oldest first — for the trend line. */
  timeline: { date: string; rounds: number; alliesWins: number; axisWins: number }[];
}

const margin = (m: MatchRow): number | null =>
  m.alliedScore != null && m.axisScore != null ? Math.abs(m.alliedScore - m.axisScore) : null;

const durationOf = (m: MatchRow): number | null =>
  m.endedAt ? Math.max(0, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 1000)) : null;

/** The largest score gap the mode can produce, inferred from what we've actually seen. */
function maxGap(matches: MatchRow[]): number {
  const gaps = matches.map(margin).filter((n): n is number => n != null);
  return gaps.length ? Math.max(...gaps) : 5;
}

export function buildMatchTrends(matches: MatchRow[], tz: string = UTC): MatchTrends {
  const decidedRounds = matches.filter((m) => m.winner === "allies" || m.winner === "axis");
  const gapCeiling = maxGap(matches);
  const margins = matches.map(margin).filter((n): n is number => n != null);
  const durations = matches.map(durationOf).filter((n): n is number => n != null);

  const byMapKey = new Map<string, MatchRow[]>();
  for (const m of matches) {
    const key = m.map ?? "Unknown";
    byMapKey.set(key, [...(byMapKey.get(key) ?? []), m]);
  }
  const byMap: MapStat[] = [...byMapKey.entries()].map(([map, rows]) => {
    const dec = rows.filter((r) => r.winner === "allies" || r.winner === "axis");
    const mg = rows.map(margin).filter((n): n is number => n != null);
    const dur = rows.map(durationOf).filter((n): n is number => n != null);
    const alliesWins = dec.filter((r) => r.winner === "allies").length;
    return {
      map,
      rounds: rows.length,
      alliesWins,
      axisWins: dec.length - alliesWins,
      alliesWinRate: dec.length ? alliesWins / dec.length : null,
      avgMargin: mg.length ? mg.reduce((a, b) => a + b, 0) / mg.length : null,
      blowoutRate: mg.length ? mg.filter((g) => g >= gapCeiling).length / mg.length : null,
      avgDurationSec: dur.length ? Math.round(dur.reduce((a, b) => a + b, 0) / dur.length) : null,
    };
  }).sort((a, b) => b.rounds - a.rounds);

  const byHour = Array<number>(24).fill(0);
  for (const m of matches) {
    const h = hourIn(m.startedAt, tz);
    if (h !== null) byHour[h] = (byHour[h] ?? 0) + 1;
  }

  const perDay = new Map<string, { rounds: number; alliesWins: number; axisWins: number }>();
  for (const m of matches) {
    const key = dayIn(m.startedAt, tz);
    const d = perDay.get(key) ?? { rounds: 0, alliesWins: 0, axisWins: 0 };
    d.rounds += 1;
    if (m.winner === "allies") d.alliesWins += 1;
    else if (m.winner === "axis") d.axisWins += 1;
    perDay.set(key, d);
  }

  const alliesWins = decidedRounds.filter((m) => m.winner === "allies").length;
  return {
    rounds: matches.length,
    decided: decidedRounds.length,
    alliesWins,
    axisWins: decidedRounds.length - alliesWins,
    alliesWinRate: decidedRounds.length ? alliesWins / decidedRounds.length : null,
    avgDurationSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    medianDurationSec: durations.length ? quantile(durations, 0.5) : null,
    avgMargin: margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null,
    blowoutRate: margins.length ? margins.filter((g) => g >= gapCeiling).length / margins.length : null,
    byMap,
    byHour,
    weekHour: weekHourGrid(matches.map((m) => m.startedAt), tz),
    timeline: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
  };
}

// ---------------------------------------------------------------- staff

export interface StaffMember {
  userId: string | null;
  name: string;
  actions: number;
  /** Share of all staff actions in the window — how the load is split. */
  share: number;
  lastAt: string | null;
  byCategory: Record<string, number>;
  /** Roles the account holds, so the page can narrow the team to "just the Admins". */
  roleIds: string[];
}

export interface StaffTeamAnalytics {
  totalActions: number;
  activeStaff: number;
  members: StaffMember[];
  /** Everyone on the team, whether or not they acted in the window. */
  totalStaff: number;
  /** Actions per hour of day / week×hour — where the cover is thin. */
  weekHour: number[][];
  byHour: number[];
  byAction: Bucketed[];
  timeline: { date: string; actions: number }[];
  /** Hours of the week (0–167) with no staff action at all in the window. */
  uncoveredHours: number;
  /** The share of one person's work in the busiest slot — a concentration warning. */
  busiestShare: number | null;
}

/**
 * The team page's work categories — SIXTEEN, split as finely as the audit verbs allow.
 *
 * The first cut of this used seven, matching the validated palette's slot count so every category
 * could keep its own hue. The product decision came back the other way: separation beats hue
 * uniqueness here ("I truthfully don't care if colors are reused"), because these render as
 * labelled rows in the per-member mix — the LABEL carries identity, the colour is decoration —
 * and a category you cannot see is worse than a colour you have seen before. The panel cycles the
 * seven validated hues rather than inventing new ones, so nothing unvalidated is ever drawn; the
 * one place hue-per-category still matters (a chart with no labels beside the marks) must not use
 * this list without folding it first.
 *
 * Exported because the staff route's category-hide filter and the tests must agree with the
 * builder about what a key means — three private copies of this mapping is how they drift.
 */
export const TEAM_CATEGORIES = [
  { key: "messages", label: "Messages" },
  { key: "kicks", label: "Kicks" },
  { key: "punishes", label: "Punishes" },
  { key: "switches", label: "Team switches" },
  { key: "tempbans", label: "Temp bans" },
  { key: "permabans", label: "Perma bans" },
  { key: "unbans", label: "Unbans" },
  { key: "banrecord", label: "Ban record" },
  { key: "vip", label: "VIP" },
  { key: "records", label: "Notes & flags" },
  { key: "maprotation", label: "Map rotation" },
  { key: "mapvotes", label: "Map votes" },
  { key: "economy", label: "Economy & payouts" },
  { key: "settings", label: "Settings & automation" },
  { key: "approvals", label: "Approvals & requests" },
  { key: "other", label: "Other" },
] as const;

export function teamCategoryOf(action: string): string {
  const a = action.toLowerCase();
  // Approval paperwork, FIRST: the verb after `request.` is what was asked for, not what this
  // person did — approving a ban is not banning. The action itself is credited to the requester
  // (approvals.ts), so it is counted once, over there, as the ban it is.
  if (a.startsWith("request.")) return "approvals";
  if (a === "message.all" || a === "player.message" || /(broadcast\.send|\bwelcome\b)/.test(a)) return "messages";
  if (/kick/.test(a)) return "kicks";
  if (/punish/.test(a)) return "punishes";
  if (/switch/.test(a)) return "switches";
  // Unban before the ban shapes: "unban_perma" contains both verbs and lifting is its own work.
  if (/unban/.test(a)) return "unbans";
  if (/tempban/.test(a)) return "tempbans";
  if (/(permaban|blacklist)/.test(a)) return "permabans";
  // The record-keeping around bans (seeding the book, adopting game lists) — not banning anybody.
  if (/(\bban\b|ban$|bans\.)/.test(a)) return "banrecord";
  if (a.startsWith("vip.")) return "vip";
  // What staff write ABOUT players: notes, the watchlist, tags, identity links.
  if (/^player\.(note|watchlist|flag|tag|link|evasion)/.test(a)) return "records";
  if (a.startsWith("mapvote")) return "mapvotes";
  if (a.startsWith("map")) return "maprotation";
  if (/^(economy|payout)\./.test(a)) return "economy";
  // The panel-configuration catch-all: server settings, automation, integrations, imports — the
  // work that is real but is not moderation, and the bucket a config-heavy owner hides to stop
  // their profile skewing the moderation picture.
  if (/^(config|server|autosettings|seeding|broadcast|discord|admin|data|import|events|templates|rules?)\./.test(a)) return "settings";
  return "other";
}

const CATEGORY_OF = teamCategoryOf;

/**
 * The trail reduced to ACTS OF STAFFING — what the staff pages count. The audit trail itself never
 * changes: every row stays in the record, in the player's own history and in the Trail. Only the
 * counting is filtered, and the rule behind both filters is the same one: one act, one row.
 *
 * ONE VOLLEY, ONE ACTION. The bulk route writes a row PER TARGET on purpose — those rows are what
 * each player's own moderation history reads — but counted raw they made one select-all message to
 * a hundred players outweigh a week of individual work on the staff pages. Rows the write path
 * marked `data.bulk` collapse to their first row per (actor, action, server, minute); everything
 * unmarked passes through untouched.
 *
 * The minute bucket means a volley straddling a minute boundary counts twice. Accepted: the bulk
 * route sends sequentially and a hundred targets finish in seconds, and keying any wider would
 * merge two genuinely separate volleys fired close together.
 *
 * A CONTINUATION IS NOT A NEW ACT. A row marked `data.continues` carries on a decision that has
 * already been counted — the second half of an over-cap temp ban is the SAME sentence extended to
 * the length originally asked for, not a second ban. Counted, one 48h ban read as two bans on the
 * requester's record, and grew another one every time it climbed a rung: the split is an artefact
 * of who may sign what, and it has no business showing up in anybody's numbers.
 */
export function countableActions<T extends Pick<AuditRow, "ts" | "action" | "actorUserId" | "actorName" | "serverId" | "data">>(entries: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const d = e.data as { bulk?: unknown; continues?: unknown } | null;
    if (d?.continues) continue;
    if (d?.bulk !== true) { out.push(e); continue; }
    const key = `${e.actorUserId ?? e.actorName}|${e.action}|${e.serverId ?? ""}|${e.ts.slice(0, 16)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * @param roster every staff ACCOUNT, so the team table lists the whole team rather than only
 *   whoever happened to act in the window. A quiet fortnight is a fact about a person worth
 *   seeing — leaving them out silently turned "no actions" into "no such staff member".
 */
export function buildStaffTeamAnalytics(
  entries: AuditRow[],
  tz: string = UTC,
  roster: { userId: string; name: string; roleIds?: string[] }[] = [],
): StaffTeamAnalytics {
  const byMember = new Map<string, StaffMember>();
  for (const r of roster) {
    byMember.set(r.userId, { userId: r.userId, name: r.name, actions: 0, share: 0, lastAt: null, byCategory: {}, roleIds: r.roleIds ?? [] });
  }
  const byAction = new Map<string, number>();
  const perDay = new Map<string, number>();
  const byHour = Array<number>(24).fill(0);

  for (const e of entries) {
    const key = e.actorUserId ?? `name:${e.actorName}`;
    const m = byMember.get(key) ?? { userId: e.actorUserId ?? null, name: e.actorName, actions: 0, share: 0, lastAt: null, byCategory: {}, roleIds: [] };
    m.actions += 1;
    const cat = CATEGORY_OF(e.action);
    m.byCategory[cat] = (m.byCategory[cat] ?? 0) + 1;
    if (!m.lastAt || e.ts > m.lastAt) m.lastAt = e.ts;
    byMember.set(key, m);

    byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
    const day = dayIn(e.ts, tz);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    const h = hourIn(e.ts, tz);
    if (h !== null) byHour[h] = (byHour[h] ?? 0) + 1;
  }

  const total = entries.length;
  const members = [...byMember.values()]
    .map((m) => ({ ...m, share: total ? m.actions / total : 0 }))
    // Busiest first, then alphabetical — so the tail of quiet staff reads as a list rather than
    // in whatever order the roster query happened to return.
    .sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  const active = members.filter((m) => m.actions > 0);

  // In `tz` like every other bucket in this payload: this grid is what `uncoveredHours` reads, so
  // a UTC grid pointed staff at the wrong gaps to cover — the exact wrong-day failure described at
  // the top of this file, surviving here because the sibling byHour was zoned and this was not.
  const weekHour = weekHourGrid(entries.map((e) => e.ts), tz);
  const uncoveredHours = weekHour.flat().filter((n) => n === 0).length;

  return {
    totalActions: total,
    // "Active" means acted in this window; `members` is the whole team including the quiet ones.
    activeStaff: active.length,
    totalStaff: members.length,
    members,
    weekHour,
    byHour,
    byAction: [...byAction.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    timeline: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, actions]) => ({ date, actions })),
    uncoveredHours,
    busiestShare: active[0]?.share ?? null,
  };
}

// ---------------------------------------------------------------- admin response

export interface AdminRequest {
  ts: string;
  serverId: string;
  playerName: string | null;
  playerId: string | null;
  message: string;
  /** Seconds until a staff action followed on the same server; null if none ever did. */
  responseSec: number | null;
  respondedBy: string | null;
  respondedAction: string | null;
}

export interface AdminResponseAnalytics {
  requests: number;
  answered: number;
  unanswered: number;
  /** Share of calls that got a staff action within the cutoff. */
  answeredRate: number | null;
  medianSec: number | null;
  p90Sec: number | null;
  /** Calls per hour of day / week×hour — when your players need someone and whether one is there. */
  byHour: number[];
  weekHour: number[][];
  /** Median response in each hour of the day, null where there were no answered calls. */
  medianByHour: (number | null)[];
  /** Slowest first — the calls worth reading back. */
  slowest: AdminRequest[];
  recent: AdminRequest[];
}

/** A staff action, reduced to what pairing needs. */
export interface ResponderAction { ts: string; serverId: string | null; actorName: string; action: string }

/**
 * Pair each admin call with the first staff action that followed it on the same server.
 *
 * This is a HEURISTIC and the page says so. We cannot know that a given kick was caused by a given
 * `!admin` — only that staff did something afterwards. Three rules keep it from flattering anyone:
 *
 *   - only actions on the SAME server count (a ban on another server is not an answer here);
 *   - a cutoff (default 30 minutes) past which a call is "unanswered" rather than credited to
 *     whatever unrelated thing happened two hours later;
 *   - one action answers one call. Without that, a single kick would be credited to all fifteen
 *     calls that preceded it and the median would collapse toward zero on exactly the nights when
 *     staff were most overwhelmed — the opposite of the truth.
 *
 * Both lists must be sorted OLDEST FIRST.
 */
export function pairAdminResponses(
  requests: { ts: string; serverId: string; playerName: string | null; playerId: string | null; message: string }[],
  actions: ResponderAction[],
  cutoffSec = 1800,
): AdminRequest[] {
  const used = new Set<number>();
  return requests.map((r) => {
    const limit = Date.parse(r.ts) + cutoffSec * 1000;
    const idx = actions.findIndex((a, i) =>
      !used.has(i) && a.serverId === r.serverId && a.ts >= r.ts && Date.parse(a.ts) <= limit);
    if (idx < 0) return { ...r, responseSec: null, respondedBy: null, respondedAction: null };
    used.add(idx);
    const a = actions[idx]!;
    return {
      ...r,
      responseSec: Math.max(0, Math.round((Date.parse(a.ts) - Date.parse(r.ts)) / 1000)),
      respondedBy: a.actorName,
      respondedAction: a.action,
    };
  });
}

export function buildAdminResponseAnalytics(paired: AdminRequest[], tz: string = UTC): AdminResponseAnalytics {
  const answered = paired.filter((r) => r.responseSec != null);
  const times = answered.map((r) => r.responseSec!);
  const byHour = Array<number>(24).fill(0);
  const perHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const r of paired) {
    const h = hourIn(r.ts, tz);
    if (h === null) continue;
    byHour[h] = (byHour[h] ?? 0) + 1;
    if (r.responseSec != null) perHour[h]!.push(r.responseSec);
  }
  return {
    requests: paired.length,
    answered: answered.length,
    unanswered: paired.length - answered.length,
    answeredRate: paired.length ? answered.length / paired.length : null,
    medianSec: times.length ? quantile(times, 0.5) : null,
    p90Sec: times.length ? quantile(times, 0.9) : null,
    byHour,
    // In `tz` for the same reason as the staff grid: "when do players call and is anyone there"
    // is a question about the community's evenings, not UTC's.
    weekHour: weekHourGrid(paired.map((r) => r.ts), tz),
    medianByHour: perHour.map((v) => (v.length ? quantile(v, 0.5) : null)),
    slowest: [...answered].sort((a, b) => b.responseSec! - a.responseSec!).slice(0, 10),
    recent: [...paired].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 25),
  };
}

// ---------------------------------------------------------------- map votes

export interface MapVoteStat {
  mapId: string;
  name: string;
  offered: number;
  won: number;
  /** Wins per offer. Carries `offered` so a 1-for-1 map isn't presented as a 100% favourite. */
  winRate: number | null;
  votes: number;
}

export interface MapVoteAnalytics {
  votesHeld: number;
  decidedByVote: number;
  overridden: number;
  /** Share of finished votes a human overrode — high means the vote isn't trusted. */
  overrideRate: number | null;
  totalBallots: number;
  avgTurnout: number | null;
  maps: MapVoteStat[];
  timeline: { date: string; votes: number; ballots: number }[];
}

/** The fields of a stored vote this module actually reads — a structural subset of the repo row. */
export interface VoteHistoryRow {
  decidedAt: string;
  outcome: string;
  winnerName: string | null;
  totalVotes: number;
}

/** The fields of a stored tally row this module reads — a structural subset of `MapVoteTally`. */
export interface VoteTallyRow {
  mapId: string;
  name: string;
  offered: number;
  won: number;
  votes: number;
}

export function buildMapVoteAnalytics(history: VoteHistoryRow[], tally: VoteTallyRow[], tz: string = UTC): MapVoteAnalytics {
  const decidedByVote = history.filter((h) => h.outcome === "vote").length;
  const overridden = history.filter((h) => h.outcome === "override").length;
  const finished = decidedByVote + overridden;
  const ballots = history.map((h) => h.totalVotes);
  const totalBallots = ballots.reduce((a, b) => a + b, 0);

  const perDay = new Map<string, { votes: number; ballots: number }>();
  for (const h of history) {
    const key = dayIn(h.decidedAt, tz);
    const d = perDay.get(key) ?? { votes: 0, ballots: 0 };
    d.votes += 1;
    d.ballots += h.totalVotes;
    perDay.set(key, d);
  }

  return {
    votesHeld: history.length,
    decidedByVote,
    overridden,
    overrideRate: finished ? overridden / finished : null,
    totalBallots,
    avgTurnout: history.length ? totalBallots / history.length : null,
    maps: tally.map((t) => ({
      mapId: t.mapId,
      name: t.name,
      offered: t.offered,
      won: t.won,
      winRate: t.offered ? t.won / t.offered : null,
      votes: t.votes,
    })).sort((a, b) => b.offered - a.offered),
    timeline: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
  };
}

// ---------------------------------------------------------------- combat

export interface WeaponStat {
  weapon: string;
  classId: string;
  className: string;
  kills: number;
  teamkills: number;
  /** Share of all kills in the window — "is this the meta, or one person's habit". */
  share: number;
  /** Team kills per 100 kills WITH THIS WEAPON. Some weapons are simply dangerous to teammates. */
  tkRate: number | null;
}

export interface CombatSummary {
  kills: number;
  teamkills: number;
  killers: number;
  victims: number;
  /** Team kills per 100 kills, server-wide — the headline "how bad is friendly fire here". */
  tkRate: number | null;
  weapons: WeaponStat[];
  /** The same kills grouped into the descriptor's weapon classes. */
  classes: { id: string; label: string; kills: number; teamkills: number; share: number }[];
  /** Weapons that hurt teammates out of proportion to their use, worst first. */
  friendlyFireWeapons: WeaponStat[];
}

/**
 * Bucket raw weapon counts using the game's own class list.
 *
 * `classify` is injected rather than imported so this stays pure and game-agnostic: the caller
 * passes `(w) => classifyWeapon(descriptor, w)` and a game with no declared classes still gets a
 * complete breakdown under "Other" instead of an empty chart.
 */
export function buildCombatSummary(
  totals: { kills: number; teamkills: number; killers: number; victims: number },
  byWeapon: { weapon: string; kills: number; teamkills: number }[],
  classify: (weapon: string) => { id: string; label: string },
): CombatSummary {
  const weapons: WeaponStat[] = byWeapon.map((w) => {
    const c = classify(w.weapon);
    return {
      weapon: w.weapon,
      classId: c.id,
      className: c.label,
      kills: w.kills,
      teamkills: w.teamkills,
      share: totals.kills ? w.kills / totals.kills : 0,
      // Per 100 kills with the weapon, so a rifle with 3 TKs in 9,000 kills doesn't rank beside
      // a satchel with 3 in 12. Null when the weapon has no ordinary kills to divide by.
      tkRate: w.kills ? (w.teamkills / w.kills) * 100 : null,
    };
  });

  const byClass = new Map<string, { id: string; label: string; kills: number; teamkills: number }>();
  for (const w of weapons) {
    const c = byClass.get(w.classId) ?? { id: w.classId, label: w.className, kills: 0, teamkills: 0 };
    c.kills += w.kills;
    c.teamkills += w.teamkills;
    byClass.set(w.classId, c);
  }

  return {
    ...totals,
    tkRate: totals.kills ? (totals.teamkills / totals.kills) * 100 : null,
    weapons,
    classes: [...byClass.values()]
      .map((c) => ({ ...c, share: totals.kills ? c.kills / totals.kills : 0 }))
      .sort((a, b) => b.kills - a.kills),
    // A minimum of 20 kills before a weapon can be called a friendly-fire problem: the same
    // small-denominator rule as everywhere else, or the top of this list is always some weapon
    // that killed one teammate and nobody else.
    friendlyFireWeapons: weapons
      .filter((w) => w.teamkills > 0 && w.kills >= 20)
      .sort((a, b) => (b.tkRate ?? 0) - (a.tkRate ?? 0))
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------- players

export interface PlayerDistribution {
  /** Histogram buckets of a measure across the population. */
  buckets: { label: string; value: number }[];
  median: number;
  p90: number;
  p99: number;
  max: number;
}

/** Bucket a population measure into readable bands rather than a raw histogram of every value. */
export function distribute(values: number[], edges: number[], format: (n: number) => string): PlayerDistribution {
  const buckets = edges.map((edge, i) => {
    const next = edges[i + 1];
    const label = next == null ? `${format(edge)}+` : i === 0 && edge === 0 ? `<${format(next)}` : `${format(edge)}–${format(next)}`;
    const value = values.filter((v) => v >= edge && (next == null || v < next)).length;
    return { label, value };
  });
  return {
    buckets,
    median: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
    max: values.length ? Math.max(...values) : 0,
  };
}

/** Where one value sits in a population, 0–100. Used to tell a player "top 3%" rather than "412 kills". */
export function percentileOf(value: number, population: number[]): number {
  if (!population.length) return 0;
  const below = population.filter((v) => v < value).length;
  return Math.round((below / population.length) * 100);
}

/** Squad-level rollup for one round's scoreboard — who actually carried, and who fed. */
export function matchStandouts(stats: PlayerMatchStatRow[]): {
  topKills: PlayerMatchStatRow[];
  topKd: PlayerMatchStatRow[];
  worstTk: PlayerMatchStatRow[];
} {
  const kd = (s: PlayerMatchStatRow) => (s.deaths ? s.kills / s.deaths : s.kills);
  return {
    topKills: [...stats].sort((a, b) => b.kills - a.kills).slice(0, 5),
    // A minimum of 5 kills keeps a 1-kill-0-death cameo off the top of the K/D list.
    topKd: [...stats].filter((s) => s.kills >= 5).sort((a, b) => kd(b) - kd(a)).slice(0, 5),
    worstTk: [...stats].filter((s) => s.teamkills > 0).sort((a, b) => b.teamkills - a.teamkills).slice(0, 5),
  };
}

// ---------------------------------------------------------------- the platform split's bans and VIP

/** The platform split's own columns that are not about play, on top of the stores' sums. */
export type PlatformRow = PlatformBreakdown["rows"][number] & { tempBans: number; permaBans: number; vips: number };
export type PlatformDayRow = PlatformTrend["rows"][number] & {
  tempBans: number; permaBans: number; vips: number;
  /** players whose first day with VIP in the window this is: added up, the distinct VIPs so far. */
  firstVips: number;
};

/** The calendar date after "YYYY-MM-DD" (a date, not an instant: no zone can move it). */
const nextDate = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Bans and VIP, folded into the By platform rows.
 *
 * The card compares platforms on whichever metric is picked, and these three live outside sessions
 * and rounds, so the stores' grouped scans cannot produce them:
 *
 *  - Temp bans and perma bans are ban DECISIONS made in the window whose rule covers the server
 *    being looked at (a community-wide ban covers every server of its game, as on the ban list),
 *    counted under the banned player's platform, and per local day for the lines. A decision is
 *    placed by when it was made; one synced off a game server keeps the game's own time.
 *  - VIPs are the players who held VIP on the server: on each local day, everybody whose VIP ran
 *    for any part of it, and over the window, everybody who held it at some point in it. Who held
 *    it when is rebuilt from the VIP history (vip-history.ts), which leaves out grants under an hour.
 *
 * Every VIP count is of PEOPLE: one player with VIP on two servers is one VIP in a view of every
 * server. A player the directory has never seen counts under "unknown", the same as a session
 * would. A platform the stores did not report gets a row with every other sum at zero. `vipDaily`
 * is the same count for every platform together, for every local day in the window, nothing left
 * out: a day nobody held VIP is a zero, not a missing day. Each VIP is also counted once more, on
 * the first day they held it in the window (`firstVips`), which is what the chart's running count
 * adds up: it ends at the window's VIPs, where adding up the days would count a VIP once a day.
 */
export function foldPlatformModeration(
  breakdown: PlatformBreakdown["rows"],
  trend: PlatformTrend["rows"],
  m: {
    bans: Pick<PlayerBanRow, "playerId" | "kind" | "createdAt" | "game" | "scope">[];
    /** Who held VIP when, grants under an hour left out: [from, to) in epoch milliseconds. */
    vipStretches: { playerId: string; from: number; to: number }[];
    /** The platform the directory holds for a game id, if it knows the player at all. */
    platformOf: (playerId: string) => string | undefined;
    /** Does a decision's rule cover the server being looked at? Always, for every server at once. */
    covers: (ban: Pick<PlayerBanRow, "game" | "scope">) => boolean;
    from: string; to: string; tz: string;
  },
): { rows: PlatformRow[]; trend: PlatformDayRow[]; vipDaily: { date: string; vips: number }[] } {
  const platformOf = (playerId: string) => m.platformOf(playerId) || "unknown";
  const rows = new Map<string, PlatformRow>(breakdown.map((r) => [r.platform, { ...r, tempBans: 0, permaBans: 0, vips: 0 }]));
  const row = (platform: string): PlatformRow => {
    const r = rows.get(platform) ?? { platform, ...emptyPlatformSums(), tempBans: 0, permaBans: 0, vips: 0 };
    rows.set(platform, r);
    return r;
  };
  const days = new Map<string, PlatformDayRow>(trend.map((r) => [`${r.date}|${r.platform}`, { ...r, tempBans: 0, permaBans: 0, vips: 0, firstVips: 0 }]));
  const day = (date: string, platform: string): PlatformDayRow => {
    const key = `${date}|${platform}`;
    const r = days.get(key) ?? { ...emptyPlatformTrendRow(date, platform), tempBans: 0, permaBans: 0, vips: 0, firstVips: 0 };
    days.set(key, r);
    return r;
  };

  const from = Date.parse(m.from), to = Date.parse(m.to);
  for (const b of m.bans) {
    const at = Date.parse(b.createdAt);
    if (!(at >= from && at < to) || !m.covers(b)) continue;
    const platform = platformOf(b.playerId);
    const column = b.kind === "perma" ? "permaBans" : "tempBans";
    row(platform)[column] += 1;
    day(dayIn(b.createdAt, m.tz), platform)[column] += 1;
  }

  // Sets, not sums: a player's runs on two servers, or two runs in one day, are one VIP.
  const inWindow = new Map<string, Set<string>>(); // platform → players
  const onDay = new Map<string, Set<string>>(); // "date|platform" → players
  const add = (map: Map<string, Set<string>>, key: string, playerId: string) => {
    const ids = map.get(key) ?? new Set<string>();
    ids.add(playerId);
    map.set(key, ids);
  };
  const firstDay = new Map<string, { date: string; platform: string }>(); // player → first day with VIP
  for (const s of m.vipStretches) {
    const a = Math.max(s.from, from), b = Math.min(s.to, to);
    if (b <= a) continue;
    const platform = platformOf(s.playerId);
    add(inWindow, platform, s.playerId);
    // Every local day the run touches, its first and its last included.
    const first = dayIn(new Date(a).toISOString(), m.tz);
    const last = dayIn(new Date(b - 1).toISOString(), m.tz);
    for (let d = first; d <= last; d = nextDate(d)) add(onDay, `${d}|${platform}`, s.playerId);
    const known = firstDay.get(s.playerId);
    if (!known || first < known.date) firstDay.set(s.playerId, { date: first, platform });
  }
  for (const [platform, ids] of inWindow) row(platform).vips = ids.size;
  for (const { date, platform } of firstDay.values()) day(date, platform).firstVips += 1;
  const perDate = new Map<string, number>();
  for (const [key, ids] of onDay) {
    const [date, platform] = key.split("|") as [string, string];
    day(date, platform).vips = ids.size;
    perDate.set(date, (perDate.get(date) ?? 0) + ids.size); // one player, one platform: no one twice
  }
  const vipDaily: { date: string; vips: number }[] = [];
  if (to > from) {
    const last = dayIn(new Date(to - 1).toISOString(), m.tz);
    for (let d = dayIn(m.from, m.tz); d <= last; d = nextDate(d)) vipDaily.push({ date: d, vips: perDate.get(d) ?? 0 });
  }

  return {
    rows: [...rows.values()].sort((a, b) => b.players - a.players || b.kills - a.kills || a.platform.localeCompare(b.platform)),
    trend: [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform)),
    vipDaily,
  };
}
