"use client";
/**
 * The rich combat panels of a player profile — playstyle (rates, streaks, faction, melee),
 * kill/death types by weapon class, nemeses (most killed / most died to), squadmates (most played
 * with / against), habits (maps with outcomes, modes, servers), and a rolling-average form chart.
 * Renders the `combat` object GET /players/:id ships (built by the API's player-combat module).
 * Each section is its own <Panel>, so it collapses/reorders with the rest of the profile.
 */
import { useState } from "react";
import { fmt } from "../lib/api";
import { Panel } from "./Panel";
import { PlayerLink } from "./PlayerLink";
import { StatGrid, StatTile, BreakdownBars, Progression, SERIES_COUNT } from "./viz";
import { Time } from "./Time";
import { Nothing } from "./ui";
import { useGame } from "../lib/game";

interface ClassCount { id: string; label: string; count: number }
interface PersonCount { playerId: string | null; name: string; count: number }

export interface CombatAnalytics {
  window: { events: number; matches: number; firstEventAt: string | null };
  rates: { kpm: number | null; dpm: number | null };
  killTypes: ClassCount[];
  deathTypes: ClassCount[];
  melee: { kills: number; deaths: number; lastDeath: { ts: string; by: string; weapon: string } | null };
  streaks: { bestKillstreak: number; currentKillstreak: number; bestDeathstreak: number };
  mostKilled: PersonCount[];
  mostDiedTo: PersonCount[];
  playedWith: PersonCount[];
  playedAgainst: PersonCount[];
  faction: { allies: number; axis: number; alliesPct: number | null };
  maps: { map: string; count: number; wins: number; losses: number }[];
  modes: { name: string; count: number }[];
  servers: { serverId: string; name: string; count: number }[];
  rolling: { x: string; label: string; kd: number; winRate: number | null }[];
}

/** Colour follows the weapon class, never its rank: a fixed slot per class id, shared by the kill
 *  and death charts, so "sniper" is the same colour on both and re-sorting never repaints. */
const CLASS_SLOTS = ["rifle", "smg", "mg", "sniper", "armor", "explosive", "grenade", "artillery", "shotgun", "pistol", "melee", "other"];
const slotOf = (id: string) => {
  const i = CLASS_SLOTS.indexOf(id);
  return (i < 0 ? CLASS_SLOTS.length : i) % SERIES_COUNT;
};
const classBars = (rows: ClassCount[]) => rows.map((r) => ({ key: r.id, label: r.label, value: r.count, colorIndex: slotOf(r.id) }));

/** Ranked people list — the hllrecords-style dotted table, names clickable through to profiles. */
function PeopleList({ rows, empty }: { rows: PersonCount[]; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="recent-list">
      {rows.map((r, i) => (
        <div className="recent-card" key={r.playerId ?? r.name}>
          <span className="rc-title"><span className="muted" style={{ marginRight: 6 }}>{i + 1}.</span><PlayerLink playerId={r.playerId} name={r.name} /></span>
          <span className="rc-meta">×{r.count}</span>
        </div>
      ))}
    </div>
  );
}

export function PlayerCombatPanels({ c }: { c: CombatAnalytics }) {
  // "allies"/"axis" are the stored ids; the game names them (US/NVA on Vietnam).
  const game = useGame();
  const hasEvents = c.window.events > 0;
  const hasMatches = c.window.matches > 0;
  if (!hasEvents && !hasMatches) return null; // nothing recorded → no empty shells

  const alliesPct = c.faction.alliesPct;
  const factionLabel = alliesPct == null ? "—" : alliesPct >= 0.5 ? `${Math.round(alliesPct * 100)}% ${game.sideName("allies")}` : `${Math.round((1 - alliesPct) * 100)}% ${game.sideName("axis")}`;
  // The event window is trimmable history, so every figure derived from it says what it covers.
  const windowNote = `Based on the last ${c.window.events.toLocaleString()} recorded kills/deaths` +
    (c.window.firstEventAt ? ` (since ${fmt(c.window.firstEventAt).split(",")[0]})` : "") +
    (hasMatches ? ` and ${c.window.matches} tracked matches.` : ".");

  return (
    <>
      <Panel id="playstyle" caps="open" title="Playstyle" subtitle={factionLabel !== "—" ? `favours ${factionLabel}` : undefined}>
        <StatGrid>
          <StatTile label="Kills / min" value={c.rates.kpm ?? "—"} sub="career playtime" accent />
          <StatTile label="Deaths / min" value={c.rates.dpm ?? "—"} sub="career playtime" />
          <StatTile label="Best killstreak" value={c.streaks.bestKillstreak} sub={c.streaks.currentKillstreak > 1 ? `${c.streaks.currentKillstreak} and counting` : undefined} />
          <StatTile label="Worst deathstreak" value={c.streaks.bestDeathstreak} />
          <StatTile label="Melee kills" value={c.melee.kills} sub={c.melee.deaths ? `${c.melee.deaths} melee deaths` : "never knifed"} />
          <StatTile label="Faction" value={factionLabel} sub={alliesPct != null ? `${c.faction.allies}× ${game.sideName("allies")} · ${c.faction.axis}× ${game.sideName("axis")}` : undefined} />
        </StatGrid>
        {c.melee.lastDeath && (
          <p className="muted mb-0">
            Last knifed by <strong>{c.melee.lastDeath.by}</strong> ({c.melee.lastDeath.weapon}) on <Time iso={c.melee.lastDeath.ts} />.
          </p>
        )}
        <p className="muted" style={{ marginBottom: 0, fontSize: "0.75rem" }}>{windowNote}</p>
      </Panel>

      {hasEvents && (
        <Panel id="kill-types" caps="open" title="Kill & death types" subtitle="by weapon class">
          <div className="two-col">
            <div>
              <h3 className="combat-h">Kills by</h3>
              <BreakdownBars data={classBars(c.killTypes)} empty="No kills in the window." />
            </div>
            <div>
              <h3 className="combat-h">Died to</h3>
              <BreakdownBars data={classBars(c.deathTypes)} empty="No deaths in the window." />
            </div>
          </div>
        </Panel>
      )}

      {(c.mostKilled.length > 0 || c.mostDiedTo.length > 0) && (
        <Panel id="nemeses" caps="open" title="Nemeses" subtitle="most killed · most died to">
          <div className="two-col">
            <div>
              <h3 className="combat-h">Most killed</h3>
              <PeopleList rows={c.mostKilled} empty="No victims yet." />
            </div>
            <div>
              <h3 className="combat-h">Most died to</h3>
              <PeopleList rows={c.mostDiedTo} empty="Nobody has got them yet." />
            </div>
          </div>
        </Panel>
      )}

      {(c.playedWith.length > 0 || c.playedAgainst.length > 0) && (
        <Panel id="squadmates" caps="open" title="Squadmates" subtitle="from shared tracked matches">
          <div className="two-col">
            <div>
              <h3 className="combat-h">Most played with</h3>
              <PeopleList rows={c.playedWith} empty="No shared-side matches tracked." />
            </div>
            <div>
              <h3 className="combat-h">Most played against</h3>
              <PeopleList rows={c.playedAgainst} empty="No opposing-side matches tracked." />
            </div>
          </div>
        </Panel>
      )}

      {hasMatches && (
        <Panel id="habits" caps="open" title="Habits" subtitle="maps · modes · servers">
          <div className="two-col">
            <div>
              <h3 className="combat-h">Most played maps</h3>
              {!c.maps.length && <Nothing>No maps recorded.</Nothing>}
              <div className="recent-list">
                {c.maps.map((m) => (
                  <div className="recent-card" key={m.map}>
                    <span className="rc-title">{m.map}</span>
                    <span className="rc-meta">{m.count}× · {m.wins}W–{m.losses}L</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              {c.modes.length > 1 && (
                <>
                  <h3 className="combat-h">Game modes</h3>
                  <BreakdownBars data={c.modes.map((m, i) => ({ key: m.name, label: m.name, value: m.count, colorIndex: i }))} />
                </>
              )}
              {c.servers.length > 1 && (
                <>
                  <h3 className="combat-h" style={{ marginTop: c.modes.length > 1 ? 14 : 0 }}>Servers</h3>
                  <div className="recent-list">
                    {c.servers.map((s) => (
                      <div className="recent-card" key={s.serverId}>
                        <span className="rc-title">{s.name}</span>
                        <span className="rc-meta">{s.count} match{s.count === 1 ? "" : "es"}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </Panel>
      )}

      {c.rolling.length >= 3 && <FormPanel rolling={c.rolling} />}
    </>
  );
}

/** Rolling-average form over recent matches. K/D and win-rate live on different scales, so they are
 *  a metric SWITCH (one axis at a time), never two lines on a dual axis. */
function FormPanel({ rolling }: { rolling: CombatAnalytics["rolling"] }) {
  const [metric, setMetric] = useState<"kd" | "winRate">("kd");
  const points = rolling
    .filter((p) => metric === "kd" || p.winRate != null)
    .map((p) => ({ x: p.x, label: p.label, values: { [metric]: metric === "kd" ? p.kd : Math.round((p.winRate ?? 0) * 100) } }));
  return (
    <Panel id="form" caps="open" title="Form" subtitle="rolling average over the last 10 matches">
      <div className="viz-toggles">
        <button className={`viz-toggle${metric === "kd" ? " active" : ""}`} onClick={() => setMetric("kd")}>K/D</button>
        <button className={`viz-toggle${metric === "winRate" ? " active" : ""}`} onClick={() => setMetric("winRate")}>Win rate %</button>
      </div>
      <Progression
        points={points}
        series={[metric === "kd" ? { key: "kd", label: "K/D (rolling 10)", colorIndex: 0 } : { key: "winRate", label: "Win rate % (rolling 10)", colorIndex: 2 }]}
      />
    </Panel>
  );
}
