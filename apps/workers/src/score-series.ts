/**
 * Each player's score buckets through a round, for the round report's score charts.
 *
 * A point is read off CRCON's player cache (crcon-players.ts) as it stands after a recording pass:
 * the game's running figure plus what a reconnect banked in the p_* field. That sum is what the
 * live scoreboard publishes for the player, so a chart ends on the number the board shows, and a
 * reconnect never dips the line back to zero.
 *
 * The recorder takes a point a minute while a round runs, and one more on the pass that sees it
 * end. The store drops a point that repeats the player's last totals.
 */
import type { CrconPlayerCache, ScoreSeriesPoint } from "@app/db";

/** How often a running round gets a point. */
export const SCORE_SERIES_MS = 60_000;

/** The cache's totals as points at `sec` seconds into the round. A player who has scored nothing
 *  yet has no point: their line starts when their score does. */
export function scoreSeriesPoints(cache: CrconPlayerCache, sec: number): ScoreSeriesPoint[] {
  const points: ScoreSeriesPoint[] = [];
  for (const [platformId, line] of cache) {
    const combat = line.combat + line.p_combat;
    const offense = line.offense + line.p_offense;
    const defense = line.defense + line.p_defense;
    const support = line.support + line.p_support;
    if (combat + offense + defense + support <= 0) continue;
    points.push({ platformId, sec, combat, offense, defense, support });
  }
  return points;
}
