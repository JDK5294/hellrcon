/**
 * GAME REWARDS — the decisions, kept pure so each rule is tested on its own (see GameRewardsConfig
 * in @app/db for what each kind is). The worker does the I/O: it feeds these the match's stats,
 * the kill/death stream and the day logs, and pays whatever they say is due — every payout behind
 * a once-only receipt, so nothing decided here can be paid twice.
 */
import type { GameRewardsConfig, PlayerMatchStatRow, RewardAmount, SquadMetric, SquadType, StreakTier, TopStatCategory } from "@app/db";

export const TOP_STAT_LABELS: Record<TopStatCategory, string> = {
  kills: "kills", kd: "K/D", kpm: "kills per minute", combat: "combat", offense: "offense", defense: "defense",
  support: "support", teamplay: "teamplay", commander: "commander", vehicles: "vehicles destroyed",
};

/** A ratio category needs enough kills to mean anything — 3 kills and no deaths is not the best K/D. */
export const RATIO_MIN_KILLS = 5;

/** Seconds a player spent in the match, from their per-role time (the unknown-role key counts too). */
export function playedSeconds(row: Pick<PlayerMatchStatRow, "roleSeconds">): number {
  return Object.values(row.roleSeconds ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

/** One category's value for one player, or null when they do not qualify for it at all. */
export function categoryValue(cat: TopStatCategory, row: PlayerMatchStatRow, commanderRoles: Set<string>, minSeconds: number): number | null {
  const played = playedSeconds(row);
  const commanderSecs = Object.entries(row.roleSeconds ?? {}).reduce((a, [k, v]) => a + (commanderRoles.has(k) ? Number(v) || 0 : 0), 0);
  if (cat === "commander") return commanderSecs >= minSeconds ? row.combat + row.support : null;
  if (played < minSeconds) return null;
  switch (cat) {
    case "kills": return row.kills;
    case "kd": return row.kills >= RATIO_MIN_KILLS ? row.kills / Math.max(1, row.deaths) : null;
    case "kpm": return row.kills >= RATIO_MIN_KILLS && played > 0 ? row.kills / (played / 60) : null;
    case "combat": return row.combat;
    case "offense": return row.offense;
    case "defense": return row.defense;
    case "support": return row.support;
    case "teamplay": return row.combat + row.support;
    case "vehicles": return row.vehiclesDestroyed;
  }
}

export interface TopStatWinner { category: TopStatCategory; rank: number; playerId: string; playerName: string | null; value: number; reward: RewardAmount }

/**
 * Each enabled category's winners, best first: a reward per rank, nobody placed on a zero, and
 * ties broken by kills then name so the same scoreboard always gives the same answer.
 */
export function rankTopStats(rows: PlayerMatchStatRow[], cfg: GameRewardsConfig["topStats"], commanderRoles: Set<string>): TopStatWinner[] {
  const out: TopStatWinner[] = [];
  const minSeconds = Math.max(0, cfg.minMinutes) * 60;
  for (const cat of cfg.categories) {
    if (!cat.enabled || !cat.ranks.length) continue;
    const scored = rows
      .map((r) => ({ r, v: categoryValue(cat.id, r, commanderRoles, minSeconds) }))
      .filter((x): x is { r: PlayerMatchStatRow; v: number } => x.v !== null && x.v > 0)
      .sort((a, b) => b.v - a.v || b.r.kills - a.r.kills || String(a.r.playerName ?? "").localeCompare(String(b.r.playerName ?? "")));
    scored.slice(0, cat.ranks.length).forEach((x, i) => out.push({
      category: cat.id, rank: i + 1, playerId: x.r.playerId, playerName: x.r.playerName, value: x.v, reward: cat.ranks[i]!,
    }));
  }
  return out;
}

/** A value the way a player reads it: ratios to two places, counts whole. */
export function formatStat(cat: TopStatCategory, v: number): string {
  return cat === "kd" || cat === "kpm" ? v.toFixed(2) : String(Math.round(v));
}

/** The match-end broadcast: each category's winner(s), one line. */
export function topStatsBroadcast(winners: TopStatWinner[]): string {
  const byCat = new Map<TopStatCategory, TopStatWinner[]>();
  for (const w of winners) byCat.set(w.category, [...(byCat.get(w.category) ?? []), w]);
  const parts = [...byCat].map(([cat, ws]) => `${TOP_STAT_LABELS[cat]}: ${ws.map((w) => `${w.playerName ?? "?"} (${formatStat(cat, w.value)})`).join(", ")}`);
  return parts.length ? `Top players this match — ${parts.join(" | ")}` : "";
}

/**
 * The winners list every player is sent at match end (like the topstats plugin): a line per
 * category in the panel's order, every rewarded place. Kept under `max` characters — lines past
 * it are left off rather than the message being cut mid-name.
 */
export function topStatsReport(winners: TopStatWinner[], categoryOrder: TopStatCategory[], max = 900): string {
  const byCat = new Map<TopStatCategory, TopStatWinner[]>();
  for (const w of winners) byCat.set(w.category, [...(byCat.get(w.category) ?? []), w]);
  // One short heading line: the map named here wrapped onto a second line, and a console screen
  // has no line to spare (the match that just ended is the one everyone is looking at anyway).
  const lines = ["Top players this match:"];
  for (const cat of categoryOrder) {
    const ws = (byCat.get(cat) ?? []).sort((a, b) => a.rank - b.rank);
    if (!ws.length) continue;
    const who = ws.map((w) => `${ws.length > 1 ? `${w.rank}. ` : ""}${w.playerName ?? "?"} (${formatStat(cat, w.value)})`).join(", ");
    const label = TOP_STAT_LABELS[cat];
    const line = `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${who}`;
    if ([...lines, line].join("\n").length > max) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

export const SQUAD_TYPE_LABELS: Record<SquadType, string> = {
  infantry: "infantry", armor: "armor", recon: "recon", artillery: "artillery", mortar: "mortar", helicopter: "helicopter",
};

/** One member's number for what squads are ranked by. */
export function squadMetricValue(metric: SquadMetric, row: PlayerMatchStatRow): number {
  switch (metric) {
    case "score": return row.combat + row.offense + row.defense + row.support;
    case "teamplay": return row.combat + row.support;
    case "kills": return row.kills;
    case "combat": return row.combat;
    case "offense": return row.offense;
    case "defense": return row.defense;
    case "support": return row.support;
  }
}

/**
 * The squad a player belonged to this match: the (team, squad, squad type) they spent the longest
 * in, read from the unit history the roster sampler keeps. A leg lasts until the next one; the
 * last lasts for whatever of the player's time the earlier legs leave. Unassigned legs (squad -1)
 * and roles no squad offers (the army commander) belong to no squad. Null when nothing does.
 */
export function mainSquad(row: Pick<PlayerMatchStatRow, "units" | "roleSeconds">, squadTypes: Record<string, number[]>): { team: number; squad: number; type: string } | null {
  const typeOf = (role: number): string | null => {
    for (const [type, roles] of Object.entries(squadTypes)) if (roles.includes(role)) return type;
    return null;
  };
  const legs = (row.units ?? []).filter((u) => u && Number.isFinite(Number(u.ts)));
  if (!legs.length) return null;
  const played = playedSeconds(row);
  const totals = new Map<string, { team: number; squad: number; type: string; seconds: number }>();
  let counted = 0;
  legs.forEach((leg, i) => {
    const next = legs[i + 1];
    const seconds = next ? Math.max(0, Number(next.ts) - Number(leg.ts)) : Math.max(0, played - counted);
    if (next) counted += seconds;
    const type = typeOf(Number(leg.role));
    const squad = Number(leg.squad);
    if (type === null || !Number.isFinite(squad) || squad < 0) return;
    const key = `${leg.team}:${squad}:${type}`;
    const cur = totals.get(key) ?? { team: Number(leg.team), squad, type, seconds: 0 };
    cur.seconds += seconds;
    totals.set(key, cur);
  });
  let best: { team: number; squad: number; type: string; seconds: number } | null = null;
  for (const t of totals.values()) if (!best || t.seconds > best.seconds) best = t;
  return best ? { team: best.team, squad: best.squad, type: best.type } : null;
}

export interface SquadPlacement {
  type: SquadType; rank: number; team: number; squad: number;
  /** the squad's number: its members' metric added up, or averaged. */
  value: number;
  /** what EACH member is paid. */
  reward: RewardAmount;
  members: PlayerMatchStatRow[];
}

/**
 * Each enabled squad type's best squads, best first, a reward per place for every member. A
 * squad is the players whose main squad it was (mainSquad), counting only those who played the
 * minimum; one with fewer than `minMembers` of them cannot place, and neither can one on zero.
 * Ties go to the bigger squad, then the lower team and squad number, so the same scoreboard always
 * gives the same answer. A type this game has no squads of is skipped.
 */
export function rankBestSquads(rows: PlayerMatchStatRow[], cfg: GameRewardsConfig["bestSquads"], squadTypes: Record<string, number[]>): SquadPlacement[] {
  const minSeconds = Math.max(0, cfg.minMinutes) * 60;
  const squads = new Map<string, { team: number; squad: number; type: string; members: PlayerMatchStatRow[] }>();
  for (const r of rows) {
    if (playedSeconds(r) < minSeconds) continue;
    const main = mainSquad(r, squadTypes);
    if (!main) continue;
    const key = `${main.team}:${main.squad}:${main.type}`;
    const s = squads.get(key) ?? { ...main, members: [] };
    s.members.push(r);
    squads.set(key, s);
  }
  const out: SquadPlacement[] = [];
  for (const t of cfg.types) {
    if (!t.enabled || !t.ranks.length || !squadTypes[t.id]) continue;
    const scored = [...squads.values()]
      .filter((s) => s.type === t.id && s.members.length >= Math.max(1, cfg.minMembers))
      .map((s) => {
        const total = s.members.reduce((a, m) => a + squadMetricValue(cfg.metric, m), 0);
        return { s, v: cfg.scoring === "average" ? total / s.members.length : total };
      })
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v || b.s.members.length - a.s.members.length || a.s.team - b.s.team || a.s.squad - b.s.squad);
    scored.slice(0, t.ranks.length).forEach((x, i) => out.push({
      type: t.id, rank: i + 1, team: x.s.team, squad: x.s.squad, value: x.v, reward: t.ranks[i]!, members: x.s.members,
    }));
  }
  return out;
}

/** A squad by its people — what players recognise, where a squad number means nothing. */
export function squadNames(members: { playerName: string | null }[], max = 3): string {
  const names = members.map((m) => m.playerName ?? "?").sort((a, b) => a.localeCompare(b));
  return names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max}` : names.join(", ");
}

/** A squad's number the way a player reads it: an average to one place, a total whole. */
export function formatSquadValue(v: number, scoring: "total" | "average"): string {
  return scoring === "average" ? v.toFixed(1) : String(Math.round(v));
}

/** The squad winners every player is sent at match end: a line per type in the panel's order,
 *  kept under `max` characters — lines past it are left off, not cut mid-name. */
export function bestSquadsReport(placed: SquadPlacement[], typeOrder: SquadType[], scoring: "total" | "average", max = 900): string {
  const lines = ["Best squads this match:"];
  for (const type of typeOrder) {
    const ps = placed.filter((p) => p.type === type).sort((a, b) => a.rank - b.rank);
    if (!ps.length) continue;
    const label = SQUAD_TYPE_LABELS[type];
    const who = ps.map((p) => `${ps.length > 1 ? `${p.rank}. ` : ""}${squadNames(p.members)} (${formatSquadValue(p.value, scoring)})`).join(", ");
    const line = `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${who}`;
    if ([...lines, line].join("\n").length > max) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/** The broadcast part: each type's winning squad. */
export function bestSquadsBroadcast(placed: SquadPlacement[], scoring: "total" | "average"): string {
  const parts = placed.filter((p) => p.rank === 1).map((p) => `${SQUAD_TYPE_LABELS[p.type]} squad: ${squadNames(p.members, 2)} (${formatSquadValue(p.value, scoring)})`);
  return parts.length ? `Best squads — ${parts.join(" | ")}` : "";
}

/**
 * Kills without dying, per player, for one server. A kill bumps the killer's run; ANY death (a
 * kill or a team kill against them) ends the victim's. Team kills never count toward a run. Each
 * tier is crossed once per life, and a life is named by the timestamp of its first kill — unique,
 * and stable enough to be a receipt ref.
 */
export class KillStreakTracker {
  private runs = new Map<string, { count: number; startedAt: string }>();

  /** Record a kill; returns the tiers this kill just reached (usually none, at most one). */
  kill(playerId: string, ts: string, tiers: { kills: number }[]): { kills: number; lifeRef: string }[] {
    const run = this.runs.get(playerId) ?? { count: 0, startedAt: ts };
    run.count += 1;
    this.runs.set(playerId, run);
    return tiers.filter((t) => t.kills === run.count).map((t) => ({ kills: t.kills, lifeRef: run.startedAt }));
  }

  death(playerId: string): void { this.runs.delete(playerId); }

  /** A new match: every run ends. */
  reset(): void { this.runs.clear(); }

  current(playerId: string): number { return this.runs.get(playerId)?.count ?? 0; }
}

/** YYYY-MM-DD in a timezone (the community's day, not the server's UTC one). */
export function dayIn(tz: string | null | undefined, ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** The day before a YYYY-MM-DD (calendar arithmetic, timezone-free). */
export function prevDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** How many days in a row, ending on `today`, the qualifying set holds — 0 if today does not. */
export function streakEndingOn(qualifying: Set<string>, today: string): { count: number; start: string } {
  let count = 0;
  let day = today;
  let start = today;
  while (qualifying.has(day)) { count += 1; start = day; day = prevDay(day); }
  return { count, start };
}

/**
 * The streak payouts due at a streak of `count` days: every tier reached (a receipt keeps each to
 * once per streak, so a tier missed while the worker was down is still paid when next checked),
 * plus the repeat past the top tier — every `repeatEveryDays` days, the top tier's reward again.
 */
export function streakPayoutsDue(count: number, tiers: StreakTier[], repeatEveryDays: number): { days: number; reward: RewardAmount; message?: string }[] {
  const sorted = [...tiers].filter((t) => t.days > 0).sort((a, b) => a.days - b.days);
  const due: { days: number; reward: RewardAmount; message?: string }[] = sorted.filter((t) => t.days <= count)
    .map((t) => ({ days: t.days, reward: t.reward, ...(t.message ? { message: t.message } : {}) }));
  const top = sorted[sorted.length - 1];
  if (top && repeatEveryDays > 0 && count > top.days && (count - top.days) % repeatEveryDays === 0) {
    due.push({ days: count, reward: top.reward, ...(top.message ? { message: top.message } : {}) });
  }
  return due;
}

/**
 * A top-stats winner's own match numbers, as message placeholders — so a message can say
 * "{kills} kills and {deaths} deaths, {kd} K/D over {minutes} minutes" about THEM.
 */
export function playerMatchVars(row: PlayerMatchStatRow): Record<string, string | number> {
  const minutes = Math.round(playedSeconds(row) / 60);
  return {
    kills: row.kills, deaths: row.deaths,
    kd: (row.kills / Math.max(1, row.deaths)).toFixed(2),
    kpm: minutes > 0 ? (row.kills / minutes).toFixed(2) : "0.00",
    combat: row.combat, offense: row.offense, defense: row.defense, support: row.support,
    teamplay: row.combat + row.support, vehicles: row.vehiclesDestroyed, minutes,
  };
}

/** Is there anything to pay at all? A 0 VIP / 0 points reward is a message-only thank-you. */
export const rewardIsEmpty = (r: RewardAmount) => !(r.vipHours > 0) && !(r.points > 0);
