"use client";
/**
 * Match analytics — how rounds actually play out across the window.
 *
 * The per-map table is the point of this page. "Our server feels unbalanced" is almost never true of
 * the server; it is true of three maps in the rotation, and this is the screen that names them.
 *
 * Two guards against reading noise as signal:
 *   - every rate carries its denominator in the same row, so 100% over one round is visibly one round;
 *   - the ranked views apply a minimum sample, and say so.
 *
 * Reads GET /analytics/match?serverId&days.
 */
import { useCallback } from "react";
import { zoneLabel } from "../../lib/time";
import { api } from "../../lib/api";
import { useServers } from "../../lib/servers";
import { useGame } from "../../lib/game";
import { isFlag, useRemembered } from "../../lib/remembered";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, GoTo, NoServersPage, SkeletonLines, SkeletonRows, Explanation } from "../ui";
import { useSortable, SortTh } from "../../lib/sort";
import { StatTile, StatGrid, Bars, Heatmap, SplitBar, Progression } from "../viz";
import { AnalyticsBar, useAnalyticsRange, rangeQuery, rangeTimeoutMs, dur, enoughSample, hourLabel, num, pct, ReadPending } from "./shared";

interface MapStat {
  map: string;
  rounds: number;
  alliesWins: number;
  axisWins: number;
  alliesWinRate: number | null;
  avgMargin: number | null;
  blowoutRate: number | null;
  avgDurationSec: number | null;
}
interface Payload {
  window: { from: string; to: string };
  rounds: number;
  decided: number;
  alliesWins: number;
  axisWins: number;
  alliesWinRate: number | null;
  avgDurationSec: number | null;
  medianDurationSec: number | null;
  avgMargin: number | null;
  blowoutRate: number | null;
  byMap: MapStat[];
  byHour: number[];
  weekHour: number[][];
  timeline: { date: string; rounds: number; alliesWins: number; axisWins: number }[];
}

/** Below this many rounds a map's win rate is not worth ranking on. */
const MIN_ROUNDS = 5;

export default function MatchAnalytics() {
  const { serverId, servers } = useServers();
  // The sides in the server's game's words: US and NVA on Vietnam.
  const game = useGame();
  const allies = game.sideName("allies"), axis = game.sideName("axis");
  const [range, setRange] = useAnalyticsRange("match");
  const [rankedOnly, setRankedOnly] = useRemembered("analytics.match.rankedOnly", true, isFlag, "session");
  const load = useCallback(
    () => api<Payload>(`/analytics/match?serverId=${encodeURIComponent(serverId)}&${rangeQuery(range)}`, { timeoutMs: rangeTimeoutMs(range) }),
    [serverId, range],
  );
  const { data, error, reload } = useResource(serverId ? load : null);

  const sort = useSortable<MapStat>({
    map: (m) => m.map,
    rounds: (m) => m.rounds,
    winRate: (m) => m.alliesWinRate ?? -1,
    margin: (m) => m.avgMargin ?? -1,
    blowouts: (m) => m.blowoutRate ?? -1,
    duration: (m) => m.avgDurationSec ?? -1,
  }, "rounds", "desc", "analytics.match.maps");

  if (!servers.length) return <NoServersPage routeId="analytics.match">Rounds are analysed from the matches the panel records as a server is played.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to analyse its rounds.</p></div>;

  const maps = (data?.byMap ?? []).filter((m) => !rankedOnly || enoughSample(m.rounds, MIN_ROUNDS));
  // The two extremes worth calling out by name, from ranked maps only.
  const ranked = (data?.byMap ?? []).filter((m) => enoughSample(m.rounds, MIN_ROUNDS) && m.alliesWinRate != null);
  const mostLopsided = [...ranked].sort((a, b) => Math.abs((b.alliesWinRate ?? 0.5) - 0.5) - Math.abs((a.alliesWinRate ?? 0.5) - 0.5))[0];
  const closest = [...ranked].sort((a, b) => Math.abs((a.alliesWinRate ?? 0.5) - 0.5) - Math.abs((b.alliesWinRate ?? 0.5) - 0.5))[0];

  return (
    <PanelGroup viewId="analytics.match">
      <Panel id="overview" caps="open" title="Overview" subtitle="every round in the window">
        <AnalyticsBar
          range={range}
          onRange={setRange}
          shown={(data as { window?: { from: string; to: string } } | null | undefined)?.window}
          onRefresh={reload}
          scope={data ? `${num(data.rounds)} round${data.rounds === 1 ? "" : "s"}, ${num(data.decided)} decided` : null}
        />
        <ActionResult error={error} />
        {!data ? <ReadPending error={error} said><SkeletonLines lines={3} /></ReadPending> : (
          <>
            <StatGrid>
              <StatTile
                label={`${allies} win rate`}
                value={pct(data?.alliesWinRate)}
                sub={`${num(data?.alliesWins)}–${num(data?.axisWins)} of ${num(data?.decided)} decided`}
                accent
              />
              {/* Only ENDED rounds enter this window, so "ongoing" was a word this number could
                  never contain. What it really counts: rounds that finished while the panel was
                  not watching (a worker restart across the whistle leaves no result to record)
                  and the rare genuine tie. */}
              <StatTile label="Rounds" value={num(data?.rounds)} sub={`${num((data?.rounds ?? 0) - (data?.decided ?? 0))} ended with no recorded result`} />
              <StatTile label="Median length" value={dur(data?.medianDurationSec)} sub={`mean ${dur(data?.avgDurationSec)}`} />
              <StatTile label="Blowouts" value={pct(data?.blowoutRate)} sub="ended at the maximum score gap" />
              <StatTile label="Average margin" value={data?.avgMargin == null ? "—" : data.avgMargin.toFixed(2)} sub="final score gap" />
              <StatTile label="Maps played" value={num(data?.byMap?.length)} sub={`${num(ranked.length)} with ${MIN_ROUNDS}+ rounds`} />
            </StatGrid>
            <SplitBar
              slices={[
                { key: "allies", label: `${allies} wins`, value: data?.alliesWins ?? 0, colorIndex: 0 },
                { key: "axis", label: `${axis} wins`, value: data?.axisWins ?? 0, colorIndex: 1 },
              ]}
              empty="No decided rounds in this window."
            />
          </>
        )}
      </Panel>

      {data && ranked.length > 0 && (
        <Panel id="callouts" caps="open" title="Worth knowing" subtitle={`from maps with ${MIN_ROUNDS} or more rounds`}>
          <StatGrid>
            {mostLopsided && (
              <StatTile
                label="Most one-sided map"
                value={mostLopsided.map}
                sub={`${pct(mostLopsided.alliesWinRate)} ${allies} over ${num(mostLopsided.rounds)} round${mostLopsided.rounds === 1 ? "" : "s"}`}
              />
            )}
            {closest && (
              <StatTile
                label="Closest map"
                value={closest.map}
                sub={`${pct(closest.alliesWinRate)} ${allies} over ${num(closest.rounds)} round${closest.rounds === 1 ? "" : "s"}`}
              />
            )}
          </StatGrid>
          <Explanation>
            A one-sided map is not automatically a bad map — but if it is one-sided AND long AND
            frequent, it is quietly costing you players. The rotation is edited under{" "}
            <GoTo view="maps">Maps</GoTo>.
          </Explanation>
        </Panel>
      )}

      <Panel
        id="bymap"
        caps="open"
        title="Per map"
        subtitle="win rate, one-sidedness and length, by map"
        actions={
          <button type="button" className="ghost mini" onClick={() => setRankedOnly((v) => !v)}>
            {rankedOnly ? `Showing ${MIN_ROUNDS}+ rounds` : "Showing every map"}
          </button>
        }
      >
        {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={6} /></ReadPending> : (
          maps.length === 0
            ? <p className="nothing">{rankedOnly ? `No map has ${MIN_ROUNDS} rounds in this window yet.` : "No rounds recorded in this window."}</p>
            : (
              <div className="scroll-x">
                <table>
                  <thead><tr>
                    <SortTh s={sort} k="map">Map</SortTh>
                    <SortTh s={sort} k="rounds" numeric>Rounds</SortTh>
                    <SortTh s={sort} k="winRate" numeric>{allies} win rate</SortTh>
                    <SortTh s={sort} k="margin" numeric>Avg margin</SortTh>
                    <SortTh s={sort} k="blowouts" numeric>Blowouts</SortTh>
                    <SortTh s={sort} k="duration" numeric>Avg length</SortTh>
                  </tr></thead>
                  <tbody>
                    {sort.sorted(maps).map((m) => (
                      <tr key={m.map}>
                        <td>{m.map}</td>
                        <td className="num">{num(m.rounds)}</td>
                        <td className="num">
                          {pct(m.alliesWinRate)}
                          <span className="muted fs-xs"> {m.alliesWins}–{m.axisWins}</span>
                        </td>
                        <td className="num">{m.avgMargin == null ? "—" : m.avgMargin.toFixed(2)}</td>
                        <td className="num">{pct(m.blowoutRate)}</td>
                        <td className="num">{dur(m.avgDurationSec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
        {data && maps.length > 0 && (
          <>
            <h4 className="an-h">Rounds per map</h4>
            <Bars data={maps.map((m) => ({ label: m.map, value: m.rounds }))} colorIndex={0} empty="No rounds." />
          </>
        )}
      </Panel>

      <Panel id="when" caps="open" title="When rounds start" subtitle="rotation rhythm across the week">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          <>
            <Heatmap grid={data?.weekHour ?? []} label="rounds" empty="No rounds recorded in this window yet." />
            {/* The zone the buckets were computed in (the display zone rides every request as
                x-time-zone) — this heading said UTC while the chart was drawn on the community's
                clock, which read as "this data is in the wrong zone" to anyone who checked. */}
            <h4 className="an-h">By hour of day ({zoneLabel()})</h4>
            <Bars
              data={(data?.byHour ?? []).map((v, h) => ({ label: hourLabel(h), value: v }))}
              colorIndex={1}
              empty="No rounds recorded in this window."
            />
          </>
        )}
      </Panel>

      <Panel id="timeline" caps="open" title="Outcomes over time" subtitle="wins per side, per day">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          (data?.timeline?.length ?? 0) === 0
            ? <p className="nothing">No days with finished rounds in this window.</p>
            : (
              <Progression
                points={(data?.timeline ?? []).map((t) => ({
                  x: t.date,
                  label: t.date,
                  values: { allies: t.alliesWins, axis: t.axisWins, rounds: t.rounds },
                }))}
                series={[
                  { key: "allies", label: `${allies} wins`, colorIndex: 0 },
                  { key: "axis", label: `${axis} wins`, colorIndex: 1 },
                  { key: "rounds", label: "Rounds played", colorIndex: 2 },
                ]}
              />
            )
        )}
        <p className="muted fs-xs">
          Open any single round for its own scoreboard from the match history:{" "}
          <GoTo view="history" tab="matches">Matches</GoTo>
        </p>
      </Panel>
    </PanelGroup>
  );
}
