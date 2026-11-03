"use client";
/**
 * Map vote analytics — whether the vote is working.
 *
 * Two numbers carry this page:
 *   - TURNOUT: a vote nobody answers is not democracy, it's a delay before the map changes anyway.
 *   - OVERRIDE RATE: how often staff overruled the result. A high rate means either the pool is
 *     wrong or the vote isn't trusted, and both are fixable — but only if somebody can see it.
 *
 * Per-map win rate carries its offer count in the same row, because "won 100% of votes" over one
 * appearance is the single easiest way to misread this screen.
 *
 * Reads GET /analytics/mapvote?serverId&days.
 */
import { useCallback } from "react";
import { api } from "../../lib/api";
import { useServers } from "../../lib/servers";
import { isFlag, useRemembered } from "../../lib/remembered";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, GoTo, NoServersPage, SkeletonLines, SkeletonRows } from "../ui";
import { useSortable, SortTh } from "../../lib/sort";
import { StatTile, StatGrid, Bars, SplitBar, Progression } from "../viz";
import { AnalyticsBar, useAnalyticsRange, rangeQuery, rangeTimeoutMs, dec, enoughSample, num, pct } from "./shared";

interface MapVoteStat {
  mapId: string;
  name: string;
  offered: number;
  won: number;
  winRate: number | null;
  votes: number;
}
interface Payload {
  window: { from: string; to: string } | null;
  votesHeld: number;
  decidedByVote: number;
  overridden: number;
  overrideRate: number | null;
  totalBallots: number;
  avgTurnout: number | null;
  maps: MapVoteStat[];
  timeline: { date: string; votes: number; ballots: number }[];
}

/** Below this many offers a map's win rate is not worth ranking on. */
const MIN_OFFERS = 3;

export default function MapVoteAnalytics() {
  const { serverId, servers } = useServers();
  const [range, setRange] = useAnalyticsRange("mapvote");
  const [rankedOnly, setRankedOnly] = useRemembered("analytics.mapvote.rankedOnly", true, isFlag, "session");
  const load = useCallback(
    () => api<Payload>(`/analytics/mapvote?serverId=${encodeURIComponent(serverId)}&${rangeQuery(range)}`, { timeoutMs: rangeTimeoutMs(range) }),
    [serverId, range],
  );
  const { data, error, reload } = useResource(serverId ? load : null);

  const sort = useSortable<MapVoteStat>({
    name: (m) => m.name,
    offered: (m) => m.offered,
    won: (m) => m.won,
    winRate: (m) => m.winRate ?? -1,
    votes: (m) => m.votes,
  }, "offered", "desc", "analytics.mapvote.maps");

  if (!servers.length) return <NoServersPage routeId="analytics.mapvote">Vote results are recorded as polls run on a connected server.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to see its vote history.</p></div>;

  const maps = (data?.maps ?? []).filter((m) => !rankedOnly || enoughSample(m.offered, MIN_OFFERS));
  const ranked = (data?.maps ?? []).filter((m) => enoughSample(m.offered, MIN_OFFERS) && m.winRate != null);
  const favourite = [...ranked].sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
  const ignored = [...ranked].sort((a, b) => (a.winRate ?? 0) - (b.winRate ?? 0))[0];
  const overrideHigh = data?.overrideRate != null && data.overrideRate >= 0.25;

  return (
    <PanelGroup viewId="analytics.mapvote">
      <Panel id="overview" caps="open" title="Overview" subtitle="every vote decided in the window">
        <AnalyticsBar
          range={range}
          onRange={setRange}
          shown={(data as { window?: { from: string; to: string } } | null | undefined)?.window}
          onRefresh={reload}
          scope={data ? `${num(data.votesHeld)} votes, ${num(data.totalBallots)} ballots` : null}
        />
        <ActionResult error={error} />
        {!data && !error ? <SkeletonLines lines={3} /> : (
          <>
            <StatGrid>
              <StatTile label="Votes held" value={num(data?.votesHeld)} sub={`${num(data?.decidedByVote)} settled by the vote`} accent />
              <StatTile label="Average turnout" value={dec(data?.avgTurnout, 1)} sub="ballots per vote" />
              <StatTile
                label="Override rate"
                value={pct(data?.overrideRate)}
                sub={`${num(data?.overridden)} results overruled by staff`}
              />
              <StatTile label="Ballots cast" value={num(data?.totalBallots)} sub="across every vote in the window" />
            </StatGrid>
            <SplitBar
              slices={[
                { key: "vote", label: "Settled by the vote", value: data?.decidedByVote ?? 0, colorIndex: 0 },
                { key: "override", label: "Overridden by staff", value: data?.overridden ?? 0, colorIndex: 1 },
              ]}
              empty="No finished votes in this window."
            />
            {overrideHigh && (
              <p className="muted fs-xs notice">
                A quarter or more of results were overruled. That usually means the candidate pool is
                offering maps the rotation does not actually want — the pool and its profiles are edited
                under <GoTo view="mapvote">Map vote</GoTo>.
              </p>
            )}
          </>
        )}
      </Panel>

      {data && ranked.length > 0 && (
        <Panel id="callouts" caps="open" title="What players pick" subtitle={`from maps offered ${MIN_OFFERS} or more times`}>
          <StatGrid>
            {favourite && (
              <StatTile
                label="Most wanted"
                value={favourite.name}
                sub={`won ${pct(favourite.winRate)} of ${num(favourite.offered)} appearances`}
              />
            )}
            {ignored && (
              <StatTile
                label="Least wanted"
                value={ignored.name}
                sub={`won ${pct(ignored.winRate)} of ${num(ignored.offered)} appearances`}
              />
            )}
          </StatGrid>
          <p className="muted fs-xs">
            A map that is offered often and never wins is taking a candidate slot from one that would.
          </p>
        </Panel>
      )}

      <Panel
        id="bymap"
        caps="open"
        title="Per map"
        subtitle="how often offered, how often chosen"
        actions={
          <button type="button" className="ghost mini" onClick={() => setRankedOnly((v) => !v)}>
            {rankedOnly ? `Showing ${MIN_OFFERS}+ offers` : "Showing every map"}
          </button>
        }
      >
        {!data && !error ? <SkeletonRows rows={6} cols={5} /> : (
          maps.length === 0
            ? <p className="nothing">{rankedOnly ? `No map has been offered ${MIN_OFFERS} times yet.` : "No maps have been offered in a vote yet."}</p>
            : (
              <>
                <div className="scroll-x">
                  <table>
                    <thead><tr>
                      <SortTh s={sort} k="name">Map</SortTh>
                      <SortTh s={sort} k="offered" numeric>Offered</SortTh>
                      <SortTh s={sort} k="won" numeric>Won</SortTh>
                      <SortTh s={sort} k="winRate" numeric>Win rate</SortTh>
                      <SortTh s={sort} k="votes" numeric>Ballots</SortTh>
                    </tr></thead>
                    <tbody>
                      {sort.sorted(maps).map((m) => (
                        <tr key={m.mapId}>
                          <td>{m.name}</td>
                          <td className="num">{num(m.offered)}</td>
                          <td className="num">{num(m.won)}</td>
                          <td className="num">{pct(m.winRate)}</td>
                          <td className="num">{num(m.votes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h4 className="an-h">Ballots received, per map</h4>
                <Bars data={maps.map((m) => ({ label: m.name, value: m.votes, hint: `${m.won} wins from ${m.offered} appearances` }))} colorIndex={0} empty="No ballots yet." />
              </>
            )
        )}
      </Panel>

      <Panel id="turnout" caps="open" title="Turnout over time" subtitle="votes held and ballots cast, per day">
        {!data && !error ? <SkeletonLines lines={4} /> : (
          (data?.timeline?.length ?? 0) === 0
            ? <p className="nothing">No votes decided in this window.</p>
            : (
              <Progression
                points={(data?.timeline ?? []).map((t) => ({ x: t.date, label: t.date, values: { ballots: t.ballots, votes: t.votes } }))}
                series={[
                  { key: "ballots", label: "Ballots cast", colorIndex: 0 },
                  { key: "votes", label: "Votes held", colorIndex: 1 },
                ]}
              />
            )
        )}
        <p className="muted fs-xs">
          Each individual poll, with its full tally, is in the vote history:{" "}
          <GoTo view="history" tab="mapvotes">Map votes</GoTo>
        </p>
      </Panel>
    </PanelGroup>
  );
}
