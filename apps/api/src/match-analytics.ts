/**
 * Pure shaping of a player's match history into the figures the profile's match-analytics UI needs —
 * a win-rate, a per-match K/D progression series (oldest→newest for the line chart), a recent-matches
 * list with per-round outcome, and a top-weapons breakdown drawn from their recent kill events. Kept
 * out of the route so it's unit-testable with fixture rows (no DB/HTTP).
 */
import type { PlayerMatchAggregate, PlayerMatchRow, EvtRow } from "@app/db";

export interface RecentMatch {
  matchId: string;
  map: string | null;
  startedAt: string;
  endedAt: string | null;
  kills: number;
  deaths: number;
  teamkills: number;
  side: "allies" | "axis" | null;
  winner: "allies" | "axis" | null;
  /** true/false when both side + winner are known, else null (in-progress or unattributable). */
  won: boolean | null;
}
export interface ProgressionPoint { x: string; label: string; kills: number; deaths: number; kd: number }
export interface WeaponStat { weapon: string; kills: number }

export interface MatchAnalytics {
  aggregate: PlayerMatchAggregate;
  winRate: number | null; // 0..1 over attributed (win+loss) matches, or null if none
  recent: RecentMatch[];
  progression: ProgressionPoint[];
  weapons: WeaponStat[];
}

const kd = (k: number, d: number) => (d ? k / d : k);

/** Was this a win for the player? Needs both their side and the match winner. */
function wonMatch(row: PlayerMatchRow): boolean | null {
  if (!row.endedAt || !row.winner || !row.side) return null;
  return row.side === row.winner;
}

/**
 * @param aggregate  the player's rolled-up win/loss + combat totals
 * @param matches    their per-match lines joined with the match, NEWEST first (as the repo returns)
 * @param playerId   the player's internal id (to attribute kill weapons to them, not their killers)
 * @param recentEvents  recent events for the player (their own kills mined for the weapon breakdown)
 * @param maxRecent  how many recent matches to surface (default 12)
 */
export function buildMatchAnalytics(aggregate: PlayerMatchAggregate, matches: PlayerMatchRow[], playerId: string, recentEvents: EvtRow[], maxRecent = 12): MatchAnalytics {
  const decided = aggregate.wins + aggregate.losses;
  const winRate = decided > 0 ? aggregate.wins / decided : null;

  const recent: RecentMatch[] = matches.slice(0, maxRecent).map((m) => ({
    matchId: m.matchId, map: m.map, startedAt: m.startedAt, endedAt: m.endedAt,
    kills: m.kills, deaths: m.deaths, teamkills: m.teamkills, side: m.side, winner: m.winner, won: wonMatch(m),
  }));

  // Progression is oldest→newest so the line reads left-to-right in time.
  const progression: ProgressionPoint[] = [...matches].reverse().map((m) => ({
    x: m.startedAt, label: m.map ?? m.startedAt.slice(5, 10),
    kills: m.kills, deaths: m.deaths, kd: Number(kd(m.kills, m.deaths).toFixed(2)),
  }));

  // Top weapons from the player's own kills in the recent event window.
  const weaponCounts = new Map<string, number>();
  for (const e of recentEvents) {
    if (e.kind !== "evt.kill" || !e.weapon || e.actorPlayerId !== playerId) continue;
    weaponCounts.set(e.weapon, (weaponCounts.get(e.weapon) ?? 0) + 1);
  }
  const weapons = [...weaponCounts.entries()]
    .map(([weapon, kills]) => ({ weapon, kills }))
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 8);

  return { aggregate, winRate, recent, progression, weapons };
}
