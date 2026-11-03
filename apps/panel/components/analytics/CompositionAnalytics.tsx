"use client";
/**
 * Composition analytics — what the server LOOKED like, rather than what happened on it.
 *
 * Every other analytics page is built from the admin log, which records actions: kills, joins,
 * bans, votes. None of it records what people were *playing*, so "were we short of officers on
 * Saturday nights", "does one side keep getting stacked" and "how often do squads run without a
 * leader" had no answer at all — not a bad answer, none. A background sampler now writes the shape
 * of each server every minute, and this page reads those samples back.
 *
 * That origin is stated on the page rather than hidden, because it has a consequence a reader must
 * know: the history starts when sampling started. A window reaching further back than that is not
 * showing a quiet server, it is showing a period nobody was writing down.
 *
 * Reads GET /analytics/composition?serverId&days.
 */
import { useCallback } from "react";
import { api } from "../../lib/api";
import { useServers } from "../../lib/servers";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, Callout, NoServersPage, SkeletonLines, SkeletonRows, Explanation } from "../ui";
import { useSortable, SortTh } from "../../lib/sort";
import { StatTile, StatGrid, Bars, SplitBar, Progression, SERIES_COUNT } from "../viz";
import { AnalyticsBar, useAnalyticsRange, rangeQuery, rangeTimeoutMs, dec, num, pct, ReadPending } from "./shared";

interface SideStat { sideId: string; avgPlayers: number; share: number }
interface RoleStat { role: number; avgPlayers: number; share: number }
interface MapStat { map: string; samples: number; avgPlayers: number; noSlAvg: number }
interface Payload {
  window: { from: string; to: string };
  samples: number;
  sampleSec: number;
  firstAt: string | null;
  lastAt: string | null;
  avgPlayers: number | null;
  peakPlayers: number | null;
  bySide: SideStat[];
  byRole: RoleStat[];
  noSl: { squadSamples: number; avgSquads: number; sampleShare: number } | null;
  daily: { date: string; samples: number; avgPlayers: number; noSlAvg: number; roleShare: Record<string, number> }[];
  byMap: MapStat[];
  roles: Record<string, string>;
  sides: { id: string; label: string; color: string | null }[];
  squadLabel: string;
}

/** A map needs this many samples before its numbers are worth ranking against another map's. */
const MIN_MAP_SAMPLES = 10;
/** Roles charted individually over time. The rest fold into one "Other" line rather than becoming
 *  an 8th, 9th and 10th hue — see the palette's fixed slot order. */
const TRACKED_ROLES = SERIES_COUNT - 1;

/** "every 30 minutes" / "every 5 minutes" — the page states its own resolution. */
const resolution = (sec: number): string => (sec >= 3600 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 60)} min`);

export default function CompositionAnalytics() {
  const { serverId, servers } = useServers();
  const [range, setRange] = useAnalyticsRange("composition");
  const load = useCallback(
    () => api<Payload>(`/analytics/composition?serverId=${encodeURIComponent(serverId)}&${rangeQuery(range)}`, { timeoutMs: rangeTimeoutMs(range) }),
    [serverId, range],
  );
  const { data, error, reload } = useResource(serverId ? load : null);

  const mapSort = useSortable<MapStat>({
    map: (m) => m.map,
    samples: (m) => m.samples,
    avgPlayers: (m) => m.avgPlayers,
    noSlAvg: (m) => m.noSlAvg,
  }, "samples", "desc", "analytics.composition.maps");

  if (!servers.length) return <NoServersPage routeId="analytics.composition">Composition is sampled from the live roster of a connected server.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to see how it was made up.</p></div>;

  const roleName = (id: number | string) => data?.roles?.[String(id)] ?? `Role ${id}`;
  const sideName = (id: string) => data?.sides?.find((s) => s.id === id)?.label ?? id;
  const squad = data?.squadLabel ?? "squad";

  // The roles that get their own line over time; everything else is summed into "Other" so the
  // shares still add to the whole.
  const tracked = (data?.byRole ?? []).slice(0, TRACKED_ROLES);
  const trackedIds = new Set(tracked.map((r) => String(r.role)));
  const hasOther = (data?.byRole ?? []).length > TRACKED_ROLES;
  const roleSeries = [
    ...tracked.map((r, i) => ({ key: String(r.role), label: roleName(r.role), colorIndex: i })),
    ...(hasOther ? [{ key: "__other", label: "Other roles", colorIndex: TRACKED_ROLES }] : []),
  ];
  const rolePoints = (data?.daily ?? []).map((d) => {
    const values: Record<string, number> = {};
    let other = 0;
    for (const [role, share] of Object.entries(d.roleShare ?? {})) {
      if (trackedIds.has(role)) values[role] = Math.round(share * 1000) / 10;
      else other += share;
    }
    // A role absent from a day is 0% that day, not a gap in the line.
    for (const id of trackedIds) values[id] ??= 0;
    if (hasOther) values.__other = Math.round(other * 1000) / 10;
    return { x: d.date, values };
  });

  const rankedMaps = (data?.byMap ?? []).filter((m) => m.samples >= MIN_MAP_SAMPLES);
  const noSlSeries = [{ key: "noSl", label: `Leaderless ${squad}s`, colorIndex: 3 }];
  const noSlPoints = (data?.daily ?? []).map((d) => ({ x: d.date, values: { noSl: d.noSlAvg } }));
  // Two sides that should be even: how far off the bigger one is. With more or fewer than two
  // sides "balance" isn't a single number, so the tile simply doesn't claim one.
  const twoSided = (data?.bySide ?? []).length === 2;
  const skew = twoSided ? Math.abs((data!.bySide[0]!.share - data!.bySide[1]!.share)) : null;

  return (
    <PanelGroup viewId="analytics.composition">
      <Panel id="overview" caps="open" title="Overview" subtitle="sampled from the live roster">
        <AnalyticsBar
          range={range}
          onRange={setRange}
          shown={(data as { window?: { from: string; to: string } } | null | undefined)?.window}
          onRefresh={reload}
          scope={data ? `${num(data.samples)} samples, one every ${resolution(data.sampleSec)}` : null}
        />
        <ActionResult error={error} />
        {!data ? <ReadPending error={error} said><SkeletonLines lines={3} /></ReadPending> : data?.samples === 0 ? (
          <Callout variant="info">
            No samples in this window yet. Composition is recorded by the background worker roughly
            once a minute, and only from the moment it started — a window reaching back before that
            has nothing to show, however busy the server was.
          </Callout>
        ) : (
          <>
            <StatGrid>
              <StatTile label="Average players" value={data?.avgPlayers == null ? "—" : dec(data.avgPlayers)} sub="across every sample, empty ones included" accent />
              <StatTile label="Busiest sample" value={num(data?.peakPlayers)} sub={`highest count seen at a ${resolution(data?.sampleSec ?? 0)} resolution`} />
              <StatTile
                label="Side skew"
                value={skew == null ? "—" : pct(skew, 1)}
                sub={twoSided
                  ? `${sideName(data!.bySide[0]!.sideId)} ${pct(data!.bySide[0]!.share)} · ${sideName(data!.bySide[1]!.sideId)} ${pct(data!.bySide[1]!.share)}`
                  : "needs exactly two sides to mean anything"}
              />
              <StatTile
                label={`Leaderless ${squad}s`}
                value={data?.noSl == null ? "—" : dec(data.noSl.avgSquads)}
                sub={data?.noSl ? `on average, across ${num(data.noSl.squadSamples)} samples that had ${squad}s` : "no samples had squads"}
              />
              <StatTile
                label="Samples with one"
                value={data?.noSl == null ? "—" : pct(data.noSl.sampleShare)}
                sub={`share of populated samples with at least one leaderless ${squad}`}
              />
              <StatTile
                label="Covered from"
                value={data?.firstAt ? data.firstAt.slice(0, 10) : "—"}
                sub={data?.lastAt ? `to ${data.lastAt.slice(0, 10)}` : "nothing sampled yet"}
              />
            </StatGrid>
            <Explanation>
              None of this can be reconstructed after the fact: the game log records what players
              did, never what they were playing. These are periodic samples of the live roster, so
              the record begins where sampling began — and anything shorter than{" "}
              {resolution(data?.sampleSec ?? 0)} can fall between two of them.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="sides" caps="open" title="Side balance" subtitle="share of everyone who was playing">
        {!data ? <ReadPending error={error}><SkeletonLines lines={2} /></ReadPending> : (
          <>
            <SplitBar
              slices={(data?.bySide ?? []).map((s, i) => ({
                key: s.sideId, label: sideName(s.sideId), value: Math.round(s.share * 1000), colorIndex: i,
              }))}
              format={(n) => `${(n / 10).toFixed(1)}%`}
              empty="No sampled players to split between the sides yet."
            />
            <Explanation>
              Shares of sampled players, not of matches won. Players caught mid-switch belong to no
              side and are left out of both, so the split describes only those who were on a team.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="roles" caps="open" title="Role mix" subtitle="what people chose to play">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          <>
            <Bars
              data={(data?.byRole ?? []).map((r) => ({
                label: roleName(r.role),
                value: Math.round(r.share * 1000) / 10,
                hint: `${dec(r.avgPlayers)} players on average`,
              }))}
              format={(n) => `${n.toFixed(1)}%`}
              colorIndex={1}
              empty="No roles recorded in this window."
            />
            <Explanation>
              Weighted by population: a busy sample counts for more than a near-empty one, so this is
              the share of actual playing time spent in each role rather than the mix on a typical
              quiet moment.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="role-trend" caps="open" title="Role mix over time" subtitle="share per day">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : rolePoints.length < 2 ? (
          <p className="nothing">At least two days of samples are needed before a trend means anything.</p>
        ) : (
          <>
            <Progression points={rolePoints} series={roleSeries} format={(n) => `${n}%`} />
            <Explanation>
              Each line is that role&rsquo;s share of players, in percent. Shares rather than counts on
              purpose: counts would mostly draw the server filling up and emptying, which the
              population chart already shows.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="leaderless" caps="open" title={`Leaderless ${squad}s over time`} subtitle="average per sample, per day">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : noSlPoints.length < 2 ? (
          <p className="nothing">Not enough days sampled to draw a trend yet.</p>
        ) : (
          <>
            <Progression points={noSlPoints} series={noSlSeries} />
            <Explanation>
              A {squad} counts as leaderless when nobody in it holds a squad-leader role. This is the
              same condition the no-leader rule in Auto settings acts on, so a rule that is working
              should show as this line coming down.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="maps" caps="open" title="By map" subtitle={`how full, and how well led, each map ran`}>
        {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={4} /></ReadPending> : rankedMaps.length === 0 ? (
          <p className="nothing">
            No map has {MIN_MAP_SAMPLES} samples in this window yet — too little to compare one against another.
          </p>
        ) : (
          <>
            <div className="scroll-x">
              <table>
                <thead><tr>
                  <SortTh s={mapSort} k="map">Map</SortTh>
                  <SortTh s={mapSort} k="samples" numeric>Samples</SortTh>
                  <SortTh s={mapSort} k="avgPlayers" numeric>Avg players</SortTh>
                  <SortTh s={mapSort} k="noSlAvg" numeric>Leaderless {squad}s</SortTh>
                </tr></thead>
                <tbody>
                  {mapSort.sorted(rankedMaps).map((m) => (
                    <tr key={m.map}>
                      <td>{m.map}</td>
                      <td className="num">{num(m.samples)}</td>
                      <td className="num">{dec(m.avgPlayers)}</td>
                      <td className="num">{dec(m.noSlAvg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Explanation>
              Samples, not rounds: a map that ran twice for an hour each has roughly twice the
              samples of one that ran once. Maps below {MIN_MAP_SAMPLES} samples are hidden rather
              than ranked on a couple of readings.
            </Explanation>
          </>
        )}
      </Panel>
    </PanelGroup>
  );
}
