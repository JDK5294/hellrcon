"use client";
/**
 * One round, in full — the match report, not just the match result.
 *
 * The scoreboard rows were always recorded; what this page adds is everything the round's own
 * kill stream can say, assembled server-side (see match-report.ts): who topped what (awards),
 * how the round FLOWED minute by minute, which weapon classes each side killed with, who kept
 * meeting whom (duels), and a per-player drill-in — weapons, nemeses, streaks, lives, roles —
 * one tap on any scoreboard row.
 *
 * Honesty rule: every extra reads from the kill log, and a round imported without one (or played
 * before events were captured) has none — those panels say so in words instead of drawing empty
 * axes, and the scoreboard the page always had still renders.
 *
 * Sides wear the same two colours everywhere on the page — series slot 1 (blue) for allies-style,
 * slot 2 (red-orange) for axis-style, matching the side badges' semantics — and every chart names
 * the sides in text as well, so identity is never colour alone.
 */
import { Fragment, useCallback, useMemo } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/resource";
import { PanelGroup, Panel } from "./Panel";
import { PlayerLink } from "./PlayerLink";
import { fmtDuration } from "./PlayerScorePanel";
import { ActionResult, EmptyState, PageHeader, SkeletonRows, Explanation } from "./ui";
import { StatGrid, StatTile, Progression, SideSplit, KillRace, PlayerRoundCharts, type ProgPoint, type ScoreTuple, type TimelineTuple } from "./viz";
import { Time } from "./Time";
import { mapImageUrl } from "../lib/gameAssets";
import { useSortable, SortTh } from "../lib/sort";
import { useGame } from "../lib/game";
import { isFlagMap, useRemembered } from "../lib/remembered";

interface MatchRow {
  id: string; serverId: string; serverName: string | null; map: string | null;
  startedAt: string; endedAt: string | null;
  winner: "allies" | "axis" | null; alliedScore: number | null; axisScore: number | null; result: string | null;
  initialMorale?: number | null; alliedMorale?: number | null; axisMorale?: number | null;
  sectorLayout: string[] | null; sectorLayoutBy: string | null; sectorLayoutAt: string | null;
}
interface StatRow {
  matchId: string; playerId: string; playerName: string | null;
  side: "allies" | "axis" | null; kills: number; deaths: number; teamkills: number;
  // The round's FINAL score buckets as the game reported them. Optional: a round imported without
  // them, or one played before the sampler existed, has kills only.
  combat?: number; offense?: number; defense?: number; support?: number; slSeconds?: number;
  vehicleKills?: number; killsAndAssists?: number;
  /** seconds per raw role number this round — "what did they actually play". */
  roleSeconds?: Record<string, number>;
}
interface PlayerDetail {
  side: "allies" | "axis" | null;
  weapons: [string, number][]; deathByWeapons: [string, number][];
  mostKilled: [string, number][]; deathBy: [string, number][];
  timeline: TimelineTuple[];
  killsStreak: number; deathsWithoutKillStreak: number;
  longestLifeSecs: number | null; shortestLifeSecs: number | null; deathsByTk: number;
  /** Their score buckets through the round; absent for rounds played before they were recorded. */
  scores?: ScoreTuple[];
}
interface Report {
  complete: boolean;
  classSplit: { classId: string; label: string; allies: number; axis: number }[];
  weaponSplit: { weapon: string; allies: number; axis: number }[];
  bucketMinutes: number;
  timeline: { minute: number; allies: number; axis: number }[];
  duels: { aId: string; aName: string; bId: string; bName: string; aKills: number; bKills: number }[];
  awards: { id: string; label: string; emoji: string; playerId: string; playerName: string; value: string }[];
  players: Record<string, PlayerDetail>;
}
/** Players on each side at one minute mark; null = no roster sample near it (a gap, not zero). */
interface HeadcountPoint { minute: number; allies: number | null; axis: number | null }

const SIDE_COLOR = { allies: 0, axis: 1 } as const;

const dur = (a: string, b: string | null) => {
  if (!b) return "in progress";
  const mins = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
};

/** "3m 41s" for lives — seconds granularity matters at this scale. */
const secs = (s: number | null) => (s === null ? "—" : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

function PairTable({ title, rows, empty }: { title: string; rows: [string, number][]; empty: string }) {
  return (
    <div className="pd-block">
      <div className="hint">{title}</div>
      {rows.length === 0 ? <p className="muted fs-sm">{empty}</p> : (
        <table className="mini-table"><tbody>
          {rows.map(([k, n]) => (
            <tr key={k}><td>{k}</td><td className="num">{n}</td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

export function MatchDetail({ matchId, onBack }: { matchId: string; onBack: () => void }) {
  // Sides are stored as the cross-game "allies"/"axis" ids; what a human reads is the active
  // game's own word for them (US/NVA on Vietnam), so every side label here asks the descriptor.
  const game = useGame();
  const loader = useCallback(
    () => api<{ match: MatchRow; stats: StatRow[]; report: Report; headcount?: HeadcountPoint[] }>(`/matches/${encodeURIComponent(matchId)}`),
    [matchId],
  );
  const { data, error } = useResource(loader);
  // The rows opened and the kill race as they were left, per round, for the sitting: a player opened
  // from either comes back to the same round, not to every row shut and the race back on kills.
  const [open, setOpen] = useRemembered<Record<string, boolean>>(`match.${matchId}.open`, {}, isFlagMap, "session");

  const report = data?.report;
  const sort = useSortable<StatRow>({
    player: (s) => s.playerName ?? s.playerId,
    side: (s) => s.side ?? "",
    kills: (s) => s.kills,
    deaths: (s) => s.deaths,
    kd: (s) => (s.deaths ? s.kills / s.deaths : s.kills),
    streak: (s) => report?.players[s.playerId]?.killsStreak ?? 0,
    teamkills: (s) => s.teamkills,
    combat: (s) => s.combat ?? 0,
    offense: (s) => s.offense ?? 0,
    defense: (s) => s.defense ?? 0,
    support: (s) => s.support ?? 0,
    vehicles: (s) => s.vehicleKills ?? 0,
    slSeconds: (s) => s.slSeconds ?? 0,
  }, "kills", "desc", "matchdetail");

  /*
   * The score columns only appear when this round actually carries them. A round the panel saw
   * only the end of, or one imported from a kill log, has none — and five empty columns on every
   * historic round would be worse than not offering them at all.
   */
  const hasScores = useMemo(
    () => (data?.stats ?? []).some((s) => (s.combat ?? 0) + (s.offense ?? 0) + (s.defense ?? 0) + (s.support ?? 0) + (s.slSeconds ?? 0) > 0),
    [data],
  );
  const hasVehicles = useMemo(() => (data?.stats ?? []).some((s) => (s.vehicleKills ?? 0) > 0), [data]);

  // Per-side totals, so the scoreboard has a headline rather than only rows.
  const sides = useMemo(() => {
    const rows = data?.stats ?? [];
    const of = (side: "allies" | "axis") => {
      const r = rows.filter((s) => s.side === side);
      return { players: r.length, kills: r.reduce((n, s) => n + s.kills, 0), deaths: r.reduce((n, s) => n + s.deaths, 0) };
    };
    return { allies: of("allies"), axis: of("axis") };
  }, [data]);

  // Award chips by row, so the scoreboard names its standouts inline like the highlights strip.
  const awardsByPlayer = useMemo(() => {
    const m = new Map<string, { emoji: string; label: string; value: string }[]>();
    for (const a of report?.awards ?? []) m.set(a.playerId, [...(m.get(a.playerId) ?? []), a]);
    return m;
  }, [report]);

  const flowPoints: ProgPoint[] = useMemo(
    () => (report?.timeline ?? []).map((t) => ({ x: `${t.minute}m`, values: { allies: t.allies, axis: t.axis } })),
    [report],
  );

  const headcountPoints: ProgPoint[] = useMemo(
    () => (data?.headcount ?? []).map((h) => ({ x: `${h.minute}m`, label: `${h.minute}m`, values: { allies: h.allies, axis: h.axis } })),
    [data],
  );

  if (error) return <div className="card"><button className="ghost" onClick={onBack}>← Back</button><ActionResult error={error} /></div>;
  if (!data) return <div className="card"><SkeletonRows rows={6} cols={5} /></div>;

  const { match, stats } = data;
  const art = match.map ? mapImageUrl(match.map, game.descriptor?.id) : null;
  const roundSecs = match.endedAt ? Math.max(1, Math.round((Date.parse(match.endedAt) - Date.parse(match.startedAt)) / 1000)) : null;
  const sideLabel = { allies: game.sideName("allies"), axis: game.sideName("axis") };
  // Whether the kill race gets its score switch: a round recorded with scores, on a game that has them.
  const raceScores = !!report && Object.values(report.players).some((d) => d.scores?.length) && (game.descriptor?.scoreFields.length ?? 0) > 0;

  // "What did they play" — the round's per-role seconds folded to the top few, named by the game.
  const rolesOf = (s: StatRow): [string, number][] =>
    Object.entries(s.roleSeconds ?? {})
      .filter(([role, sec]) => Number(role) >= 0 && sec > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([role, sec]) => [game.roleName(Number(role)) || `Role ${role}`, sec]);

  return (
    <div>
      <div className="card">
        <button className="ghost mb-2" onClick={onBack}>← Back to matches</button>
        <PageHeader
          title={match.map || "Unknown map"}
          crumbs={["Monitor", "History", "Matches"]}
          subtitle={<>{match.serverName ?? "this server"} · <Time iso={match.startedAt} /> · {dur(match.startedAt, match.endedAt)}</>}
        />
        {art && <img className="match-art" src={art} alt="" />}
        <StatGrid>
          <StatTile label="Winner" value={match.winner ? sideLabel[match.winner] : "—"} accent={Boolean(match.winner)} />
          <StatTile label="Score" value={match.alliedScore !== null && match.axisScore !== null ? `${match.alliedScore} – ${match.axisScore}` : "—"} sub={`${sideLabel.allies.toLowerCase()} – ${sideLabel.axis.toLowerCase()}`} />
          {/* Conquest rounds only: the morale drain the round actually ended on. Absent on every
              round not scored in morale, so the tile never shows a 0–0 that reads as a wipe. */}
          {match.initialMorale != null && match.initialMorale > 0 && (
            <StatTile label="Morale" value={`${match.alliedMorale ?? "—"} – ${match.axisMorale ?? "—"}`} sub={`of ${match.initialMorale} each at the start`} />
          )}
          <StatTile label="Players" value={stats.length.toLocaleString()} />
          <StatTile label="Kills" value={stats.reduce((n, s) => n + s.kills, 0).toLocaleString()} />
          <StatTile label={sideLabel.allies} value={`${sides.allies.kills} k`} sub={`${sides.allies.players} player${sides.allies.players === 1 ? "" : "s"}`} />
          <StatTile label={sideLabel.axis} value={`${sides.axis.kills} k`} sub={`${sides.axis.players} player${sides.axis.players === 1 ? "" : "s"}`} />
        </StatGrid>
        {match.result && <p className="muted fs-sm">{match.result}</p>}
        {/* Only shown when staff actually set a layout. The game never reports the objectives a
            round ran, so absence here means "nobody set one", not "we failed to capture it" —
            hence the explicit wording rather than an empty five-slot placeholder. */}
        {match.sectorLayout && match.sectorLayout.length > 0 && (
          <div className="sector-layout">
            <div className="muted fs-sm">
              Objectives set by {match.sectorLayoutBy ?? "staff"}
              {match.sectorLayoutAt && <> · <Time iso={match.sectorLayoutAt} /></>}
            </div>
            <ol className="sector-layout-row">
              {match.sectorLayout.map((s, i) => (
                <li key={i}><span className="muted fs-sm">{i + 1}</span> {s}</li>
              ))}
            </ol>
          </div>
        )}
      </div>

      <PanelGroup viewId="matchdetail">
        {report && report.awards.length > 0 && (
          <Panel id="highlights" caps="open" title="Highlights" subtitle={`${report.awards.length}`}>
            <div className="award-grid">
              {report.awards.map((a) => (
                <div key={a.id} className="award-chip" title={a.label}>
                  <span className="award-emoji" aria-hidden>{a.emoji}</span>
                  <span className="award-body">
                    <span className="award-label">{a.label}</span>
                    <span className="award-who"><PlayerLink playerId={a.playerId} name={a.playerName} /> · <strong>{a.value}</strong></span>
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {report && (
          <Panel id="flow" caps="open" title="How the round flowed" subtitle={report.complete ? `kills per ${report.bucketMinutes > 1 ? `${report.bucketMinutes} min` : "minute"}` : undefined}>
            {!report.complete ? (
              <p className="muted notice">No kill log was captured for this round — imported rounds and rounds older than the event history carry the result and scoreboard only.</p>
            ) : (
              <Progression
                points={flowPoints}
                series={[
                  { key: "allies", label: sideLabel.allies, colorIndex: SIDE_COLOR.allies },
                  { key: "axis", label: sideLabel.axis, colorIndex: SIDE_COLOR.axis },
                ]}
                windows={[]}
              />
            )}
          </Panel>
        )}

        <Panel id="headcount" caps="open" title="Players on each side" subtitle={headcountPoints.length ? "minute by minute" : undefined}>
          {headcountPoints.length === 0 ? (
            <p className="hint notice">No roster samples for this round. The app samples the roster once a minute while it watches a server, so a round imported from elsewhere, played while the app wasn&apos;t running, or whose samples were trimmed has none.</p>
          ) : (
            <>
              <Explanation>One reading a minute, from the roster the app samples while it watches the server; players between sides (joining, or mid-switch) are on neither line. A break in a line is a minute with no sample — the app restarting, say — not an empty side.</Explanation>
              <Progression
                points={headcountPoints}
                series={[
                  { key: "allies", label: sideLabel.allies, colorIndex: SIDE_COLOR.allies },
                  { key: "axis", label: sideLabel.axis, colorIndex: SIDE_COLOR.axis },
                ]}
                windows={[]}
              />
            </>
          )}
        </Panel>

        {report && report.complete && Object.keys(report.players).length >= 2 && (
          <Panel id="race" caps="open" title="The kill race" subtitle={`every player's ${raceScores ? "kills and scores" : "kills"} over the round`}>
            <Explanation>One line per player, coloured by side; the leaders are named where they finish. Hover or tap a line for who it is and their count at that moment, click to keep it lit, or search a name to pick one player out of a full server.{raceScores ? " The switch races each score the same way." : ""}</Explanation>
            <KillRace
              // Keyed by the internal id, never the name: two people can wear one name in a round,
              // and here we can tell them apart — so both get their own line.
              players={Object.entries(report.players).map(([pid, d]) => ({
                id: pid,
                name: stats.find((s) => s.playerId === pid)?.playerName || "[No Name]",
                side: d.side, timeline: d.timeline, scores: d.scores,
              }))}
              roundSecs={roundSecs}
              sides={[
                { id: "allies", label: sideLabel.allies, colorIndex: SIDE_COLOR.allies },
                { id: "axis", label: sideLabel.axis, colorIndex: SIDE_COLOR.axis },
              ]}
              scoreFields={game.descriptor?.scoreFields ?? []}
              remember={`match.${matchId}.race`}
            />
          </Panel>
        )}

        {report && report.complete && report.classSplit.length > 0 && (
          <Panel id="classes" caps="open" title="Kills by class" subtitle={`${sideLabel.allies} vs ${sideLabel.axis}`}>
            <SideSplit
              rows={report.classSplit.map((c) => ({ label: c.label, left: c.allies, right: c.axis }))}
              left={{ label: sideLabel.allies, colorIndex: SIDE_COLOR.allies }}
              right={{ label: sideLabel.axis, colorIndex: SIDE_COLOR.axis }}
            />
          </Panel>
        )}

        {report && report.complete && report.weaponSplit.length > 0 && (
          <Panel id="weapons" caps="open" title="Top weapons" subtitle="the round's most-used, per side">
            <SideSplit
              rows={report.weaponSplit.map((w) => ({ label: w.weapon, left: w.allies, right: w.axis }))}
              left={{ label: sideLabel.allies, colorIndex: SIDE_COLOR.allies }}
              right={{ label: sideLabel.axis, colorIndex: SIDE_COLOR.axis }}
            />
          </Panel>
        )}

        {report && report.duels.length > 0 && (
          <Panel id="duels" caps="open" title="Duels" subtitle="who kept meeting whom">
            <p className="hint">The pairs who ran into each other most, both directions counted — the first name got the better of it.</p>
            <div className="scroll-x">
              <table className="mini-table duels">
                <tbody>
                  {report.duels.map((d) => (
                    <tr key={`${d.aId}|${d.bId}`}>
                      <td className="duel-a"><PlayerLink playerId={d.aId} name={d.aName} /></td>
                      <td className="num duel-score"><strong>{d.aKills}</strong> – {d.bKills}</td>
                      <td><PlayerLink playerId={d.bId} name={d.bName} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        <Panel id="scoreboard" caps="open" title="Scoreboard" subtitle={`${stats.length} player${stats.length === 1 ? "" : "s"}`}>
          {stats.length === 0 && (
            <EmptyState icon="🎯" title="No scoreboard for this round">
              Per-player lines are built from the kill stream, so a round the panel only saw the end
              of — or one imported without its kill log — has the result but no scoreboard.
            </EmptyState>
          )}
          {stats.length > 0 && (
            <>
              {report?.complete && <p className="hint">Tap a row for that player&apos;s round — weapons, nemesis, streaks and roles.</p>}
              <div className="scroll-x">
                <table className="scoreboard">
                  <thead><tr>
                    <SortTh s={sort} k="player">Player</SortTh>
                    <SortTh s={sort} k="side">Side</SortTh>
                    <SortTh s={sort} k="kills" numeric>Kills</SortTh>
                    <SortTh s={sort} k="deaths" numeric>Deaths</SortTh>
                    <SortTh s={sort} k="kd" numeric>K/D</SortTh>
                    {report?.complete && <SortTh s={sort} k="streak" numeric>Streak</SortTh>}
                    <SortTh s={sort} k="teamkills" numeric>TK</SortTh>
                    {hasVehicles && <SortTh s={sort} k="vehicles" numeric>Veh</SortTh>}
                    {hasScores && <>
                      <SortTh s={sort} k="combat" numeric>Combat</SortTh>
                      <SortTh s={sort} k="offense" numeric>Off</SortTh>
                      <SortTh s={sort} k="defense" numeric>Def</SortTh>
                      <SortTh s={sort} k="support" numeric>Sup</SortTh>
                      <SortTh s={sort} k="slSeconds" numeric>SL time</SortTh>
                    </>}
                  </tr></thead>
                  <tbody>
                    {sort.sorted(stats).map((s) => {
                      const detail = report?.players[s.playerId];
                      const chips = awardsByPlayer.get(s.playerId) ?? [];
                      const expanded = Boolean(open[s.playerId]) && Boolean(detail);
                      const cols = 6 + (report?.complete ? 1 : 0) + (hasVehicles ? 1 : 0) + (hasScores ? 5 : 0);
                      return (
                        <Fragment key={s.playerId}>
                          <tr
                            className={detail ? "row-expandable" : undefined}
                            aria-expanded={detail ? expanded : undefined}
                            onClick={detail ? () => setOpen((o) => ({ ...o, [s.playerId]: !o[s.playerId] })) : undefined}
                          >
                            {/* The player LINK stays a link (profile); the row click is the drill-in. */}
                            <td onClick={(e) => e.stopPropagation()}>
                              <PlayerLink playerId={s.playerId} name={s.playerName || "[No Name]"} />
                              {chips.map((c) => <span key={c.label} className="award-inline" title={`${c.label}: ${c.value}`} aria-label={c.label}>{c.emoji}</span>)}
                            </td>
                            <td>{s.side ? <span className={`badge side-${s.side}`}>{sideLabel[s.side]}</span> : <span className="muted">—</span>}</td>
                            <td className="num">{s.kills}</td>
                            <td className="num">{s.deaths}</td>
                            <td className="num">{(s.deaths ? s.kills / s.deaths : s.kills).toFixed(2)}</td>
                            {report?.complete && <td className="num">{detail?.killsStreak || ""}</td>}
                            <td className="num">{s.teamkills || ""}</td>
                            {hasVehicles && <td className="num">{s.vehicleKills || ""}</td>}
                            {hasScores && <>
                              <td className="num">{s.combat || ""}</td>
                              <td className="num">{s.offense || ""}</td>
                              <td className="num">{s.defense || ""}</td>
                              <td className="num">{s.support || ""}</td>
                              <td className="num">{s.slSeconds ? fmtDuration(s.slSeconds) : ""}</td>
                            </>}
                          </tr>
                          {expanded && detail && (
                            <tr className="row-detail">
                              <td colSpan={cols}>
                                <div className="pd-grid">
                                  {(detail.timeline.length > 0 || (detail.scores?.length ?? 0) > 0) && (
                                    <div className="pd-block pd-timeline">
                                      <PlayerRoundCharts timeline={detail.timeline} scores={detail.scores} roundSecs={roundSecs}
                                        colorIndex={s.side ? SIDE_COLOR[s.side] : 2} scoreFields={game.descriptor?.scoreFields ?? []}
                                        remember={`match.${matchId}.rows.${s.playerId}.chart`} />
                                    </div>
                                  )}
                                  <PairTable title="Kills by weapon" rows={detail.weapons} empty="No kills recorded." />
                                  <PairTable title="Died to" rows={detail.deathByWeapons} empty="Never died. Respect." />
                                  <PairTable title="Victims" rows={detail.mostKilled} empty="—" />
                                  <PairTable title="Nemesis" rows={detail.deathBy} empty="—" />
                                  <div className="pd-block">
                                    <div className="hint">The round</div>
                                    <table className="mini-table"><tbody>
                                      <tr><td>Longest killstreak</td><td className="num">{detail.killsStreak}</td></tr>
                                      <tr><td>Worst dry spell</td><td className="num">{detail.deathsWithoutKillStreak}</td></tr>
                                      <tr><td>Longest life</td><td className="num">{secs(detail.longestLifeSecs)}</td></tr>
                                      <tr><td>Shortest life</td><td className="num">{secs(detail.shortestLifeSecs)}</td></tr>
                                      {detail.deathsByTk > 0 && <tr><td>Deaths to own team</td><td className="num">{detail.deathsByTk}</td></tr>}
                                    </tbody></table>
                                  </div>
                                  {rolesOf(s).length > 0 && (
                                    <div className="pd-block">
                                      <div className="hint">Played as</div>
                                      <table className="mini-table"><tbody>
                                        {rolesOf(s).map(([role, sec]) => (
                                          <tr key={role}><td>{role}</td><td className="num">{fmtDuration(sec)}</td></tr>
                                        ))}
                                      </tbody></table>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
