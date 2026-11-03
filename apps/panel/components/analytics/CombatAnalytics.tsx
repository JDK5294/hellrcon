"use client";
/**
 * Combat analytics — what people are actually killing each other with, and how much of it lands on
 * teammates.
 *
 * The friendly-fire half is the reason this page is worth having. Team kills are recorded as their
 * own event kind and, until now, were only ever visible one line at a time in the game log — so
 * "is friendly fire getting worse" and "who keeps doing it" were questions nobody could answer
 * without reading the log by hand.
 *
 * Both team-kill rankings are rates with their denominators attached: four team kills across a
 * 200-kill session is a bad night, four across six is somebody to look at, and a table that showed
 * only the count would rank those two identically.
 *
 * Reads GET /analytics/combat?serverId&days.
 */
import { useCallback } from "react";
import { zoneLabel } from "../../lib/time";
import { api } from "../../lib/api";
import { useServers } from "../../lib/servers";
import { isFlag, useRemembered } from "../../lib/remembered";
import { useResource } from "../../lib/resource";
import { PanelGroup, Panel } from "../Panel";
import { ActionResult, GoTo, NoServersPage, SkeletonLines, SkeletonRows, Explanation } from "../ui";
import { PlayerLink } from "../PlayerLink";
import { useSortable, SortTh } from "../../lib/sort";
import { StatTile, StatGrid, Bars, Heatmap, SplitBar, Progression } from "../viz";
import { AnalyticsBar, useAnalyticsRange, rangeQuery, rangeTimeoutMs, counted, dec, hourLabel, num, pct, ReadPending } from "./shared";

interface WeaponStat {
  weapon: string;
  classId: string;
  className: string;
  kills: number;
  teamkills: number;
  share: number;
  tkRate: number | null;
}
interface Payload {
  window: { from: string; to: string };
  kills: number;
  teamkills: number;
  killers: number;
  victims: number;
  tkRate: number | null;
  weapons: WeaponStat[];
  classes: { id: string; label: string; kills: number; teamkills: number; share: number }[];
  friendlyFireWeapons: WeaponStat[];
  daily: { date: string; kills: number; teamkills: number }[];
  weekHour: number[][];
  byHour: number[];
  topKillers: { playerId: string; name: string; kills: number }[];
  topTeamkillers: { playerId: string; name: string; teamkills: number; kills: number }[];
  byMap: { map: string; kills: number; teamkills: number }[];
}

/** A weapon needs this many kills before its friendly-fire rate is worth ranking on. */
const MIN_KILLS = 20;

export default function CombatAnalytics() {
  const { serverId, servers } = useServers();
  const [range, setRange] = useAnalyticsRange("combat");
  const [rankedOnly, setRankedOnly] = useRemembered("analytics.combat.rankedOnly", true, isFlag, "session");
  const load = useCallback(
    () => api<Payload>(`/analytics/combat?serverId=${encodeURIComponent(serverId)}&${rangeQuery(range)}`, { timeoutMs: rangeTimeoutMs(range) }),
    [serverId, range],
  );
  const { data, error, reload } = useResource(serverId ? load : null);

  const weaponSort = useSortable<WeaponStat>({
    weapon: (w) => w.weapon,
    className: (w) => w.className,
    kills: (w) => w.kills,
    share: (w) => w.share,
    teamkills: (w) => w.teamkills,
    tkRate: (w) => w.tkRate ?? -1,
  }, "kills", "desc", "analytics.combat.weapons");

  const tkSort = useSortable<Payload["topTeamkillers"][number]>({
    name: (t) => t.name,
    teamkills: (t) => t.teamkills,
    kills: (t) => t.kills,
    // Their personal friendly-fire rate: the column that separates "unlucky" from "a problem".
    rate: (t) => (t.kills ? (t.teamkills / t.kills) * 100 : t.teamkills * 100),
  }, "teamkills", "desc", "analytics.combat.tk");

  if (!servers.length) return <NoServersPage routeId="analytics.combat">Weapon and friendly-fire figures are read from the kill log of a connected server.</NoServersPage>;
  if (!serverId) return <div className="card"><p className="muted">Select a server to analyse its combat.</p></div>;

  const weapons = (data?.weapons ?? []).filter((w) => !rankedOnly || w.kills >= MIN_KILLS);
  const worstMap = [...(data?.byMap ?? [])]
    .filter((m) => m.kills >= 200)
    .sort((a, b) => (b.teamkills / b.kills) - (a.teamkills / a.kills))[0];

  return (
    <PanelGroup viewId="analytics.combat">
      <Panel id="overview" caps="open" title="Overview" subtitle="every kill recorded in the window">
        <AnalyticsBar
          range={range}
          onRange={setRange}
          shown={(data as { window?: { from: string; to: string } } | null | undefined)?.window}
          onRefresh={reload}
          scope={data ? `${counted(data.kills, "kill")} from ${counted(data.killers, "player")}` : null}
        />
        <ActionResult error={error} />
        {!data ? <ReadPending error={error} said><SkeletonLines lines={3} /></ReadPending> : (
          <>
            <StatGrid>
              <StatTile label="Kills" value={num(data?.kills)} sub={`${counted(data?.killers, "player")} did the killing`} accent />
              <StatTile label="Team kills" value={num(data?.teamkills)} sub="friendly fire, recorded separately" />
              <StatTile
                label="Friendly-fire rate"
                value={data?.tkRate == null ? "—" : `${dec(data.tkRate, 2)}%`}
                sub="team kills per 100 kills"
              />
              <StatTile label="Distinct victims" value={num(data?.victims)} sub="people who died at least once" />
              <StatTile label="Weapons in use" value={num(data?.weapons?.length)} sub={`${num(weapons.length)} with ${MIN_KILLS}+ kills`} />
              <StatTile
                label="Worst map for friendly fire"
                value={worstMap?.map ?? "—"}
                sub={worstMap ? `${dec((worstMap.teamkills / worstMap.kills) * 100, 2)}% of ${counted(worstMap.kills, "kill")}` : "not enough rounds yet"}
              />
            </StatGrid>
            <Explanation>
              Every rate here is per 100 kills rather than a raw count, because a count only tells you
              which weapon is popular. Individual lines, with names and timestamps, are in the{" "}
              <GoTo view="history" tab="logs">game log</GoTo>.
            </Explanation>
          </>
        )}
      </Panel>

      <Panel id="classes" caps="open" title="What kills people" subtitle="by weapon class">
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          <>
            <SplitBar
              slices={(data?.classes ?? []).slice(0, 7).map((c, i) => ({
                key: c.id, label: c.label, value: c.kills, colorIndex: i,
              }))}
              empty="No kills recorded in this window."
            />
            <Explanation>
              Classes come from the game descriptor, so a weapon we don&rsquo;t recognise lands in
              &ldquo;Other&rdquo; rather than being dropped — the shares always add up to every kill.
            </Explanation>
            <h4 className="an-h">Team kills by class</h4>
            <Bars
              data={(data?.classes ?? []).map((c) => ({
                label: c.label,
                value: c.teamkills,
                hint: c.kills ? `${dec((c.teamkills / c.kills) * 100, 2)}% of ${counted(c.kills, "kill")}` : undefined,
              }))}
              colorIndex={3}
              empty="No team kills in this window — which is the ideal outcome."
            />
          </>
        )}
      </Panel>

      <Panel
        id="weapons"
        caps="open"
        title="Per weapon"
        subtitle="usage and friendly-fire rate"
        actions={
          <button type="button" className="ghost mini" onClick={() => setRankedOnly((v) => !v)}>
            {rankedOnly ? `Showing ${MIN_KILLS}+ kills` : "Showing every weapon"}
          </button>
        }
      >
        {!data ? <ReadPending error={error}><SkeletonRows rows={8} cols={6} /></ReadPending> : (
          weapons.length === 0
            ? <p className="nothing">{rankedOnly ? `No weapon has ${MIN_KILLS} kills in this window yet.` : "No kills recorded in this window."}</p>
            : (
              <>
                <div className="scroll-x">
                  <table>
                    <thead><tr>
                      <SortTh s={weaponSort} k="weapon">Weapon</SortTh>
                      <SortTh s={weaponSort} k="className">Class</SortTh>
                      <SortTh s={weaponSort} k="kills" numeric>Kills</SortTh>
                      <SortTh s={weaponSort} k="share" numeric>Share</SortTh>
                      <SortTh s={weaponSort} k="teamkills" numeric>Team kills</SortTh>
                      <SortTh s={weaponSort} k="tkRate" numeric>FF rate</SortTh>
                    </tr></thead>
                    <tbody>
                      {weaponSort.sorted(weapons).map((w) => (
                        <tr key={w.weapon}>
                          <td>{w.weapon}</td>
                          <td className="muted">{w.className}</td>
                          <td className="num">{num(w.kills)}</td>
                          <td className="num">{pct(w.share, 1)}</td>
                          <td className="num">{num(w.teamkills)}</td>
                          <td className="num">{w.tkRate == null ? "—" : `${dec(w.tkRate, 2)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h4 className="an-h">Most-used weapons</h4>
                <Bars data={weapons.slice(0, 20).map((w) => ({ label: w.weapon, value: w.kills }))} colorIndex={0} empty="No kills." />
              </>
            )
        )}
      </Panel>

      <Panel id="friendlyfire" caps="open" title="Friendly fire by weapon" subtitle={`worst offenders, from weapons with ${MIN_KILLS}+ kills`}>
        {!data ? <ReadPending error={error}><SkeletonLines lines={3} /></ReadPending> : (
          (data?.friendlyFireWeapons?.length ?? 0) === 0
            ? <p className="nothing">No weapon has caused a team kill in this window.</p>
            : (
              <>
                <Bars
                  data={(data?.friendlyFireWeapons ?? []).map((w) => ({
                    label: w.weapon,
                    value: Math.round((w.tkRate ?? 0) * 100) / 100,
                    hint: `${counted(w.teamkills, "team kill")} across ${counted(w.kills, "kill")}`,
                  }))}
                  colorIndex={3}
                  format={(n) => `${n}%`}
                  empty="No team kills."
                />
                <Explanation>
                  Ranked by team kills per 100 kills, not by count — otherwise the list is just the
                  most popular rifle every time. The {MIN_KILLS}-kill floor keeps a weapon that killed
                  one teammate and nobody else off the top.
                </Explanation>
              </>
            )
        )}
      </Panel>

      <Panel id="teamkillers" caps="open" title="Team kills by player" subtitle="count and personal rate, worst first">
        {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={4} /></ReadPending> : (
          (data?.topTeamkillers?.length ?? 0) === 0
            ? <p className="nothing">Nobody team-killed in this window.</p>
            : (
              <>
                <div className="scroll-x">
                  <table>
                    <thead><tr>
                      <SortTh s={tkSort} k="name">Player</SortTh>
                      <SortTh s={tkSort} k="teamkills" numeric>Team kills</SortTh>
                      <SortTh s={tkSort} k="kills" numeric>Kills</SortTh>
                      <SortTh s={tkSort} k="rate" numeric>Their FF rate</SortTh>
                    </tr></thead>
                    <tbody>
                      {tkSort.sorted(data?.topTeamkillers ?? []).map((t) => (
                        <tr key={t.playerId}>
                          <td><PlayerLink playerId={t.playerId} name={t.name} /></td>
                          <td className="num">{num(t.teamkills)}</td>
                          <td className="num">{num(t.kills)}</td>
                          <td className="num">{t.kills ? `${dec((t.teamkills / t.kills) * 100, 1)}%` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Explanation>
                  Sort by rate rather than count to find the people worth a word: high count with high
                  kills is usually somebody who plays a lot, high rate on few kills usually is not.
                  Automatic responses to this are configured under{" "}
                  <GoTo view="autosettings">Auto settings</GoTo>.
                </Explanation>
              </>
            )
        )}
      </Panel>

      <Panel id="killers" caps="open" title="Top killers" subtitle="who is doing the damage">
        {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={2} /></ReadPending> : (
          (data?.topKillers?.length ?? 0) === 0
            ? <p className="nothing">No kills recorded in this window.</p>
            : (
              <Bars
                data={(data?.topKillers ?? []).slice(0, 20).map((k) => ({ label: k.name, value: k.kills }))}
                colorIndex={0}
                empty="No kills."
              />
            )
        )}
      </Panel>

      <Panel id="bymap" caps="open" title="Per map" subtitle="kills and friendly fire, by the round they happened in">
        {!data ? <ReadPending error={error}><SkeletonRows rows={6} cols={4} /></ReadPending> : (
          (data?.byMap?.length ?? 0) === 0
            ? <p className="nothing">No kills could be attributed to a recorded round in this window.</p>
            : (
              <div className="scroll-x">
                <table>
                  <thead><tr>
                    <th>Map</th>
                    <th className="num">Kills</th>
                    <th className="num">Team kills</th>
                    <th className="num">FF rate</th>
                  </tr></thead>
                  <tbody>
                    {(data?.byMap ?? []).map((m) => (
                      <tr key={m.map}>
                        <td>{m.map}</td>
                        <td className="num">{num(m.kills)}</td>
                        <td className="num">{num(m.teamkills)}</td>
                        <td className="num">{m.kills ? `${dec((m.teamkills / m.kills) * 100, 2)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </Panel>

      <Panel id="when" caps="open" title="When the fighting happens" subtitle="kills across the week">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          <>
            <Heatmap grid={data?.weekHour ?? []} label="kills" empty="No kills recorded in this window yet." />
            {/* The zone the buckets were computed in (the display zone rides every request as
                x-time-zone) — this heading said UTC while the chart was drawn on the community's
                clock, which read as "this data is in the wrong zone" to anyone who checked. */}
            <h4 className="an-h">By hour of day ({zoneLabel()})</h4>
            <Bars
              data={(data?.byHour ?? []).map((v, h) => ({ label: hourLabel(h), value: v }))}
              colorIndex={0}
              empty="No kills recorded in this window."
            />
          </>
        )}
      </Panel>

      <Panel id="timeline" caps="open" title="Over time" subtitle="kills and team kills per day">
        {!data ? <ReadPending error={error}><SkeletonLines lines={4} /></ReadPending> : (
          (data?.daily?.length ?? 0) === 0
            ? <p className="nothing">No days with recorded kills in this window.</p>
            : (
              <>
                <Progression
                  points={(data?.daily ?? []).map((d) => ({ x: d.date, label: d.date, values: { kills: d.kills } }))}
                  series={[{ key: "kills", label: "Kills", colorIndex: 0 }]}
                />
                {/* Team kills are two orders of magnitude smaller than kills. On the same axis the
                    line would sit flat on zero; a second axis would let us fake a shape. Its own
                    chart is the honest option. */}
                <h4 className="an-h">Team kills per day</h4>
                <Bars
                  data={(data?.daily ?? []).map((d) => ({
                    label: d.date.slice(5),
                    value: d.teamkills,
                    hint: d.kills ? `${dec((d.teamkills / d.kills) * 100, 2)}% of ${counted(d.kills, "kill")}` : d.date,
                  }))}
                  colorIndex={3}
                  empty="No team kills in this window."
                />
              </>
            )
        )}
      </Panel>
    </PanelGroup>
  );
}
