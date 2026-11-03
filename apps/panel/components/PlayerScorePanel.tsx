"use client";
/**
 * The half of a player's record that isn't the kill log.
 *
 * The roster sampler has been recording the game's own score buckets — combat, offense, defense,
 * support — plus vehicle work, squad-leader time and time in each role, every sixty seconds, since
 * the panel first watched the server. None of it had anywhere to appear, so a profile showed a
 * player entirely through kills and deaths: the person who spends a round holding a point, driving
 * supply or leading a squad looked identical to someone who did nothing at all.
 *
 * Every figure here is optional. A store that predates the expanded stat set sends none of them,
 * and a player the sampler has never seen has zeroes — in both cases the panel says so plainly
 * rather than drawing an empty chart.
 */
import { useGame } from "../lib/game";
import { StatGrid, StatTile } from "./viz/StatTile";
import { BreakdownBars } from "./viz/BreakdownBars";

export interface ScoreStats {
  combat?: number;
  offense?: number;
  defense?: number;
  support?: number;
  vehicleKills?: number;
  vehiclesDestroyed?: number;
  roleSeconds?: Record<string, number>;
  slSeconds?: number;
  highestLevel?: number;
  matchesPlayed?: number;
  matchesWon?: number;
}

/** Seconds as a coarse duration. Sub-minute reads as "<1m" rather than "0m", which looks broken. */
export function fmtDuration(sec?: number): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  if (s === 0) return "—";
  if (s < 60) return "<1m";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h >= 10) return `${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** True when the sampler has actually contributed something — otherwise the panel is noise. */
export function hasScoreData(s: ScoreStats | null | undefined): boolean {
  if (!s) return false;
  const totals = (s.combat ?? 0) + (s.offense ?? 0) + (s.defense ?? 0) + (s.support ?? 0);
  const roles = Object.values(s.roleSeconds ?? {}).reduce((a, b) => a + b, 0);
  return totals > 0 || roles > 0 || (s.slSeconds ?? 0) > 0 || (s.matchesPlayed ?? 0) > 0;
}

/**
 * Time in each role, biggest first. The keys are the game's own raw role numbers — the descriptor
 * names them, so this works for any game the panel supports without a per-game table here.
 */
export function RoleSplit({ roleSeconds, max = 8 }: { roleSeconds?: Record<string, number>; max?: number }) {
  const { roleName } = useGame();
  const rows = Object.entries(roleSeconds ?? {})
    .map(([role, sec]) => ({ role: Number(role), sec }))
    // Negative keys are sentinels, not roles: "-1" is time imported from CRCON, which knows how
    // long someone played a round but not what they played. It counts toward playtime totals
    // (which sum the map), just never in a by-role breakdown.
    .filter((r) => r.sec > 0 && r.role >= 0)
    .sort((a, b) => b.sec - a.sec);
  if (rows.length === 0) return <p className="muted fs-sm">No role time recorded yet.</p>;

  // Everything past the top few folds into one row, so a long tail of thirty-second stints doesn't
  // bury the two roles the player actually plays.
  const head = rows.slice(0, max);
  const tailSec = rows.slice(max).reduce((a, r) => a + r.sec, 0);
  const data = head.map((r, i) => ({
    key: String(r.role),
    label: roleName(r.role) || `Role ${r.role}`,
    value: r.sec,
    colorIndex: i,
    valueLabel: fmtDuration(r.sec),
  }));
  if (tailSec > 0) data.push({ key: "other", label: `${rows.length - max} more`, value: tailSec, colorIndex: max, valueLabel: fmtDuration(tailSec) });
  return <BreakdownBars data={data} />;
}

export function PlayerScoreStats({ stats }: { stats: ScoreStats }) {
  const winRate = stats.matchesPlayed ? Math.round(((stats.matchesWon ?? 0) / stats.matchesPlayed) * 100) : null;
  return (
    <>
      <StatGrid>
        <StatTile label="Combat" value={(stats.combat ?? 0).toLocaleString()} />
        <StatTile label="Offense" value={(stats.offense ?? 0).toLocaleString()} />
        <StatTile label="Defense" value={(stats.defense ?? 0).toLocaleString()} />
        <StatTile label="Support" value={(stats.support ?? 0).toLocaleString()} />
        <StatTile label="Squad-leader time" value={fmtDuration(stats.slSeconds)} accent />
        <StatTile label="Vehicle kills" value={(stats.vehicleKills ?? 0).toLocaleString()} sub={`${(stats.vehiclesDestroyed ?? 0).toLocaleString()} vehicles destroyed`} />
        <StatTile label="Rounds" value={(stats.matchesPlayed ?? 0).toLocaleString()} sub={winRate === null ? undefined : `${winRate}% won`} />
        {/* The game's level only ever climbs, so the highest we have seen is the current one. */}
        <StatTile label="Level" value={stats.highestLevel ? String(stats.highestLevel) : "—"} />
      </StatGrid>

      {((stats.combat ?? 0) + (stats.offense ?? 0) + (stats.defense ?? 0) + (stats.support ?? 0)) > 0 && (
        <div style={{ marginTop: 14 }}>
          {/* Side by side these say what KIND of player this is — the shape is the point, not the
              absolute numbers, which depend entirely on how much they have played. */}
          <BreakdownBars data={[
            { key: "combat", label: "Combat", value: stats.combat ?? 0, colorIndex: 5 },
            { key: "offense", label: "Offense", value: stats.offense ?? 0, colorIndex: 2 },
            { key: "defense", label: "Defense", value: stats.defense ?? 0, colorIndex: 0 },
            { key: "support", label: "Support", value: stats.support ?? 0, colorIndex: 3 },
          ]} />
        </div>
      )}

      <h3 className="combat-h" style={{ marginTop: 18 }}>Time by role</h3>
      <RoleSplit roleSeconds={stats.roleSeconds} />
    </>
  );
}
