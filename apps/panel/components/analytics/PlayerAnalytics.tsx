"use client";
/**
 * Player analytics — the population as a whole, plus one player measured against it.
 *
 * The profile screen already answers "what has this player done". This page answers the question a
 * profile cannot: "is that a lot?". 412 kills means nothing until you know it is the 87th percentile
 * of the people who actually play here — so the search box is not a shortcut to the profile, it is
 * a comparison against the distributions on the same screen.
 *
 * Reads GET /analytics/player?days[&playerId].
 */
import { useCallback } from "react";
import { zoneLabel } from "../../lib/time";
import { api } from "../../lib/api";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, ScopePicker, SkeletonLines, SkeletonRows, Explanation } from "../ui";
import { useServers } from "../../lib/servers";
import { isPickedPlayer, useRemembered } from "../../lib/remembered";
import { useScope } from "../../lib/scope";
import { PlayerPicker, type PickedPlayer } from "../PlayerPicker";
import { PlayerLink } from "../PlayerLink";
import { Time } from "../Time";
import { useSortable, SortTh } from "../../lib/sort";
import { StatTile, StatGrid, Bars, Heatmap, SplitBar, Progression } from "../viz";
import { AnalyticsBar, useAnalyticsRange, rangeQuery, rangeTimeoutMs, counted, dec, dur, hourLabel, hours, num, pct, ReadPending } from "./shared";

interface Distribution {
  buckets: { label: string; value: number }[];
  median: number;
  p90: number;
  p99: number;
  max: number;
}
interface Top { playerId: string; name: string; platform: string; kills: number; deaths: number; teamkills: number; kd: number }
interface Subject {
  playerId: string;
  platformId: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  stats: { kills: number; deaths: number; teamkills: number; visits: number; playtimeSec: number } | null;
  kd: number;
  killsPercentile: number;
  kdPercentile: number;
  weekHour: number[][];
  sessions: number;
  playtimeSec: number;
}
interface Payload {
  window: { from: string; to: string };
  sampled: number;
  activity: {
    byHour: number[];
    byDow: number[];
    weekHour: number[][];
    daily: { date: string; sessions: number; players: number; seconds: number }[];
    sessions: number;
    uniquePlayers: number;
    totalSeconds: number;
    medianSec: number;
    p90Sec: number;
  };
  mix: { newPlayers: number; returningPlayers: number; newPlayersWhoCameBack: number };
  killDistribution: Distribution;
  kdDistribution: Distribution;
  top: Top[];
  subject: Subject | null;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Turn a percentile into the phrasing people actually use. 87th percentile = "top 13%". */
const standing = (p: number): string => (p >= 50 ? `top ${100 - p}%` : `bottom ${p || 1}%`);

export default function PlayerAnalytics() {
  const { servers } = useServers();
  const [range, setRange] = useAnalyticsRange("player");
  // The one analytics page that took no server. It measured a player against every server's
  // population at once while the sidebar named a single one, so the percentile compared them
  // against people they had never played beside.
  const [scopeId, setScope] = useScope("analytics.player.scope");
  const [picked, setPicked] = useRemembered<PickedPlayer | null>("analytics.player.picked", null, isPickedPlayer, "session");
  const subjectId = picked?.playerId ?? "";
  const load = useCallback(
    () => api<Payload>(`/analytics/player?${rangeQuery(range)}${scopeId ? `&serverId=${encodeURIComponent(scopeId)}` : ""}${subjectId ? `&playerId=${encodeURIComponent(subjectId)}` : ""}`, { timeoutMs: rangeTimeoutMs(range) }),
    [range, scopeId, subjectId],
  );
  const { data, error, reload } = useResource(load);

  const sort = useSortable<Top>({
    name: (t) => t.name,
    kills: (t) => t.kills,
    deaths: (t) => t.deaths,
    kd: (t) => t.kd,
    teamkills: (t) => t.teamkills,
  }, "kills", "desc", "analytics.player.top");

  const a = data?.activity;
  const mix = data?.mix;
  const s = data?.subject;

  return (
    <PanelGroup viewId="analytics.player">
      <Panel id="population" caps="open" title="The population" subtitle="everyone who played in this window">
        <ScopePicker servers={servers} value={scopeId} onChange={setScope} noun="Population and standings" />
        <AnalyticsBar
          range={range}
          onRange={setRange}
          shown={(data as { window?: { from: string; to: string } } | null | undefined)?.window}
          onRefresh={reload}
          scope={data ? `ranked against the top ${counted(data.sampled, "player")} by kills` : null}
        />
        <ActionResult error={error} />
        {!data ? <ReadPending error={error} said><SkeletonLines lines={3} /></ReadPending> : (
          <StatGrid>
            <StatTile label="Players seen" value={num(a?.uniquePlayers)} sub={`${num(a?.sessions)} sessions`} accent />
            <StatTile label="Time played" value={hours(a?.totalSeconds)} sub="everyone combined" />
            <StatTile label="Median session" value={dur(a?.medianSec)} sub={`90th percentile ${dur(a?.p90Sec)}`} />
            <StatTile label="New this window" value={num(mix?.newPlayers)} sub={`${num(mix?.returningPlayers)} already known`} />
            <StatTile label="Median kills" value={num(data?.killDistribution?.median)} sub={`90th ${num(data?.killDistribution?.p90)} · best ${num(data?.killDistribution?.max)}`} />
            <StatTile label="Median K/D" value={dec(data?.kdDistribution?.median, 2)} sub={`90th ${dec(data?.kdDistribution?.p90, 2)}`} />
          </StatGrid>
        )}
      </Panel>

      <Panel id="search" caps="open" title="Look up a player" subtitle="where one player sits in all of this">
        <PlayerPicker value={picked} onChange={setPicked} placeholder="Search a player by name…" allowRawId={false} />
        {picked && !s && !error && <SkeletonLines lines={2} />}
        {s && (
          <>
            <div className="an-subject">
              <h4 className="an-h">
                <PlayerLink playerId={s.platformId} name={s.name} /> <span className="muted fs-xs">open full profile</span>
              </h4>
            </div>
            <StatGrid>
              <StatTile
                label="Kills"
                value={num(s.stats?.kills)}
                sub={`${standing(s.killsPercentile)} of the ranked population`}
                accent
              />
              <StatTile label="K/D" value={dec(s.kd, 2)} sub={standing(s.kdPercentile)} />
              <StatTile label="Deaths" value={num(s.stats?.deaths)} sub={counted(s.stats?.teamkills, "team kill")} />
              <StatTile label="Time played" value={hours(s.playtimeSec)} sub={counted(s.stats?.visits, "visit")} />
              <StatTile label="First seen" value={<Time iso={s.firstSeen} />} sub={<>last seen <Time iso={s.lastSeen} /></>} />
              <StatTile label="Sessions charted" value={num(s.sessions)} sub="most recent 200" />
            </StatGrid>
            <h4 className="an-h">When they play</h4>
            <Explanation>
              Their own week × hour pattern, in the same shape as the population chart below — so you can
              see at a glance whether someone plays when you are already busy or when cover is thin.
            </Explanation>
            <Heatmap grid={s.weekHour} label="sessions" empty="No sessions recorded for this player yet." />
          </>
        )}
        {!picked && (
          <Explanation>
            Pick a player to see their standing against every distribution on this page. Their full
            history, notes and moderation record stay on their profile.
          </Explanation>
        )}
      </Panel>

      <Panel id="distributions" caps="open" title="How players compare" subtitle="the shape of the population, not just its average">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          <>
            <h4 className="an-h">Kills</h4>
            <Bars
              data={(data?.killDistribution?.buckets ?? []).map((b) => ({ label: b.label, value: b.value }))}
              colorIndex={0}
              format={(n) => counted(n, "player")}
              empty="Nobody has recorded kills yet."
            />
            <p className="muted fs-xs">
              Median {num(data?.killDistribution?.median)} · 90th percentile {num(data?.killDistribution?.p90)} ·
              99th {num(data?.killDistribution?.p99)} · highest {num(data?.killDistribution?.max)}
            </p>
            <h4 className="an-h">Kill/death ratio</h4>
            <Bars
              data={(data?.kdDistribution?.buckets ?? []).map((b) => ({ label: b.label, value: b.value }))}
              colorIndex={1}
              format={(n) => counted(n, "player")}
              empty="Not enough recorded rounds yet."
            />
            <Explanation>
              Medians and percentiles are the honest summary here — a mean K/D is dragged around by a
              handful of extreme players and describes nobody.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="when" caps="open" title="When people play" subtitle="the whole population's rhythm">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          <>
            <Heatmap grid={a?.weekHour ?? []} label="sessions" empty="No sessions recorded in this window yet." />
            {/* The zone the buckets were computed in (the display zone rides every request as
                x-time-zone) — this heading said UTC while the chart was drawn on the community's
                clock, which read as "this data is in the wrong zone" to anyone who checked. */}
            <h4 className="an-h">By hour of day ({zoneLabel()})</h4>
            <Bars data={(a?.byHour ?? []).map((v, h) => ({ label: hourLabel(h), value: v }))} colorIndex={0} empty="No sessions." />
            <h4 className="an-h">By day of week</h4>
            <Bars data={(a?.byDow ?? []).map((v, d) => ({ label: DOW[d] ?? String(d), value: v }))} colorIndex={1} empty="No sessions." />
          </>
        )}
      </Panel>

      <Panel id="growth" caps="open" title="Where players come from" subtitle="new arrivals against the regulars">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          <>
            <SplitBar
              slices={[
                { key: "returning", label: "Returning players", value: mix?.returningPlayers ?? 0, colorIndex: 0 },
                { key: "new", label: "New players", value: mix?.newPlayers ?? 0, colorIndex: 1 },
              ]}
              empty="Nobody played in this window."
            />
            <StatGrid>
              <StatTile
                label="Newcomers who stayed"
                value={pct(mix && mix.newPlayers ? mix.newPlayersWhoCameBack / mix.newPlayers : null)}
                sub={`${num(mix?.newPlayersWhoCameBack)} of ${num(mix?.newPlayers)}`}
                accent
              />
            </StatGrid>
            {(a?.daily?.length ?? 0) > 0 && (
              <>
                <h4 className="an-h">Players per day</h4>
                <Progression
                  points={(a?.daily ?? []).map((d) => ({ x: d.date, label: d.date, values: { players: d.players, sessions: d.sessions } }))}
                  series={[
                    { key: "players", label: "Distinct players", colorIndex: 0 },
                    { key: "sessions", label: "Sessions", colorIndex: 1 },
                  ]}
                />
              </>
            )}
          </>
        )}
      </Panel>

      <Panel id="top" caps="open" title="Top of the population" subtitle="the sample every percentile on this page is measured against">
        {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={5} /></ReadPending> : (
          (data?.top?.length ?? 0) === 0
            ? <p className="nothing">No player statistics recorded yet.</p>
            : (
              <div className="scroll-x">
                <table>
                  <thead><tr>
                    <SortTh s={sort} k="name">Player</SortTh>
                    <SortTh s={sort} k="kills" numeric>Kills</SortTh>
                    <SortTh s={sort} k="deaths" numeric>Deaths</SortTh>
                    <SortTh s={sort} k="kd" numeric>K/D</SortTh>
                    <SortTh s={sort} k="teamkills" numeric>Team kills</SortTh>
                  </tr></thead>
                  <tbody>
                    {sort.sorted(data?.top ?? []).map((t) => (
                      <tr key={t.playerId}>
                        <td><PlayerLink playerId={t.playerId} name={t.name} /></td>
                        <td className="num">{num(t.kills)}</td>
                        <td className="num">{num(t.deaths)}</td>
                        <td className="num">{dec(t.kd, 2)}</td>
                        <td className="num">{num(t.teamkills)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </Panel>
    </PanelGroup>
  );
}
