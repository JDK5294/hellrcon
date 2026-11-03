"use client";
/**
 * The roster as two teams, side by side, each grouped by squad.
 *
 * The scoreboard answers "who is on this server". This answers a different question — "how do the
 * two teams compare, squad by squad" — and a single ranked table cannot, because the two teams are
 * interleaved and a squad's members are scattered down it. Staff asked for the split so they can
 * see at a glance that Able has six and the other side's Able has two, or that one team is
 * carrying three squads with no leader.
 *
 * It stays side-by-side on a phone deliberately. Stacking is the reflexive responsive answer and
 * it would remove the comparison, which is the entire point of the view; where two panes do not
 * fit, each takes the roster's width and the container scrolls sideways a whole side at a time
 * instead (see .team-split). Each pane also scrolls vertically on its own, so reading one team
 * never scrolls the other away.
 *
 * Tapping a pane's header LOCKS that side, and the lock is not this component's business: the
 * Scoreboard takes over and renders the full data table for that one team, grouped by squad. That
 * is deliberate. Once a side has the screen to itself there is nothing left for a bespoke row to
 * do that the table does not already do better — sortable columns, tick boxes, the bulk menu, the
 * same numbers in the same order as everywhere else in the app. The compressed row here exists
 * only because two panes share the width; it is a compromise, not a design to extend.
 */
import { Fragment, useState } from "react";
import { useGame } from "../lib/game";
import { PlayerLink } from "./PlayerLink";
import { PlayerActions } from "./PlayerActions";
import { roleIconUrl } from "../lib/gameAssets";
import { levelClass } from "../lib/colors";
import type { LivePlayer } from "./Servers";

/**
 * Team kills past which a player is called out.
 *
 * Five, and fixed rather than configurable — a threshold nobody ever tunes is a settings row that
 * costs more than it earns. It lives here as one exported constant so the split view and the
 * scoreboard cannot drift into disagreeing about who is worth looking at.
 *
 * Deliberately generous: a couple of team kills in a round is a satchel gone wrong, and flagging
 * those would train staff to ignore the colour entirely.
 */
export const TK_FLAG_AT = 5;
export const isTkFlagged = (p: LivePlayer): boolean => (p.stats?.teamKills ?? 0) >= TK_FLAG_AT;

const killsOf = (p: LivePlayer) => (p.stats?.infantryKills ?? 0) + (p.stats?.vehicleKills ?? 0);

/**
 * A kill count in words, for a side's or a squad's heading — here and on the locked side's table.
 *
 * Spelled out, never "5k": in a heading that reads as five thousand. And one kill is "1 kill".
 */
export const killCount = (n: number): string => `${n} kill${n === 1 ? "" : "s"}`;

/**
 * Does this squad have nobody in a leader role?
 *
 * Shared with the scoreboard's squad rows so the two surfaces cannot disagree about which squads
 * are leaderless. "No squad" is a bucket, not a squad, so it cannot be missing anything; a game
 * whose descriptor names no leader roles cannot answer the question at all, and says nothing
 * rather than accusing every squad.
 */
export function missingLeader(
  squad: string,
  players: LivePlayer[],
  leaderRoles: number[],
  knowsRole: (role?: number) => boolean,
): boolean {
  if (squad === "No squad" || leaderRoles.length === 0) return false;
  /*
   * A squad holding a role the descriptor cannot name is not judged.
   *
   * The descriptor already declines to answer for a game that names no leader roles at all —
   * "cannot tell" is not the same as "leaderless", and answering anyway accuses every squad. This
   * is the same rule one level down: if a member's role number is one we have no name for, it
   * could be that squad type's leader, and we have no basis to say otherwise. Staff reported this
   * against artillery squads, whose roles are outside the fourteen this app knows.
   *
   * Conservative in the safe direction on purpose. A missed callout is a squad staff can still see
   * on the roster; a false one trains them to stop reading the flag, and drives the auto-mod rule
   * to warn players who are doing nothing wrong.
   */
  if (players.some((p) => p.role != null && !knowsRole(p.role))) return false;
  const set = new Set(leaderRoles);
  return !players.some((p) => p.role != null && set.has(p.role));
}

/**
 * The tooltip on a "no SL" badge: which roles count as leaders, and which roles this squad is
 * actually fielding.
 *
 * Worth the extra line because of how the last two of these were diagnosed — a screenshot from a
 * live round, a guess, a round trip. The flag is a claim about roles, so it should show its work:
 * anyone looking at a squad they believe is led can read straight off the badge whether the app
 * disagrees about who the leader is or about which roles lead. Unknown role numbers are named
 * "Role N" by the descriptor's own fallback, which is exactly what a game update adding a role
 * would look like here.
 */
export function noLeaderTip(
  players: LivePlayer[],
  leaderRoles: number[],
  roleName: (role?: number) => string,
  squadLabel: string,
): string {
  const counts = new Map<string, number>();
  for (const p of players) {
    const name = p.role == null ? "no role" : roleName(p.role);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const has = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
  const leads = leaderRoles.map((r) => roleName(r)).join(", ");
  return `Nobody in a ${squadLabel.toLowerCase()}-leader role.\nLeader roles: ${leads}\nThis ${squadLabel.toLowerCase()}: ${has}`;
}

export interface TeamSplitProps {
  players: LivePlayer[];
  serverId?: string;
  /** Tapping a pane header hands that side to the caller, which renders it as the full table. */
  onLock?: (sideId: string) => void;
  canFlags?: boolean; canActions?: boolean; canGroups?: boolean; canVip?: boolean; canVipPause?: boolean;
  onChanged?: () => void;
}

interface Squad { squad: string; players: LivePlayer[] }
interface Side { id: string; label: string; color: string; players: LivePlayer[]; squads: Squad[] }

export function TeamSplit({ players, serverId, onLock, canFlags, canActions, canVip, canVipPause, onChanged }: TeamSplitProps) {
  const game = useGame();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsed((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  // `side` is attached server-side and already corrected against the session's headcounts — the
  // local team→side guess has mislabelled whole lobbies, so it is only the fallback. A null side
  // means "on neither team" and stays null.
  const sideIdOf = (p: LivePlayer) => (p.side !== undefined ? p.side : game.sideOf(p.team)?.id ?? null);

  // The descriptor's first two sides are the ones that face each other; anyone the game has not
  // placed yet (joining, spectating, a team value we do not recognise) goes in a third column
  // rather than being silently dropped or shoved onto a side they are not on.
  const declared = game.sides.slice(0, 2);
  const sides: Side[] = declared.map((s) => ({ id: s.id, label: s.label, color: s.color ?? "neutral", players: [], squads: [] }));
  const unplaced: Side = { id: "~unplaced", label: "Unassigned", color: "neutral", players: [], squads: [] };
  for (const p of players) {
    const id = sideIdOf(p);
    (sides.find((s) => s.id === id) ?? unplaced).players.push(p);
  }
  const columns = unplaced.players.length ? [...sides, unplaced] : sides;

  for (const side of columns) {
    const bySquad = new Map<string, LivePlayer[]>();
    for (const p of side.players) {
      const squad = p.platoon || "No squad";
      bySquad.set(squad, [...(bySquad.get(squad) ?? []), p]);
    }
    side.squads = [...bySquad.entries()]
      // "No squad" last: it is a bucket, not a squad, and it is usually the biggest one.
      .sort((a, b) => (a[0] === "No squad" ? 1 : b[0] === "No squad" ? -1 : a[0].localeCompare(b[0])))
      .map(([squad, list]) => ({ squad, players: list.slice().sort((x, y) => killsOf(y) - killsOf(x)) }));
  }

  return (
    <div className="team-split">
      {columns.map((side) => {
        const kills = side.players.reduce((a, p) => a + killsOf(p), 0);
        const tks = side.players.reduce((a, p) => a + (p.stats?.teamKills ?? 0), 0);
        return (
          <section key={side.id} className={`team-side side-${side.color}`}>
            {/* The header is the lock control, and it says so — an invisible affordance on a phone
                is no affordance. */}
            <button
              type="button"
              className="team-side-head"
              title={`Show only ${side.label}, as the full table`}
              onClick={() => onLock?.(side.id)}
            >
              <span aria-hidden>⤢</span>
              <span>{side.label}</span>
              <span className="muted">{side.players.length}</span>
              <span className="team-side-stats">
                {killCount(kills)}{tks > 0 && <> · <span className="tk-hot">{tks} TK</span></>}
              </span>
            </button>
            <div className="team-side-body">
              {side.squads.length === 0 && <p className="team-split-empty">Nobody on this side.</p>}
              {side.squads.map((sq) => {
                const key = `${side.id}/${sq.squad}`;
                const shut = collapsed.has(key);
                const sqKills = sq.players.reduce((a, p) => a + killsOf(p), 0);
                const noLeader = missingLeader(sq.squad, sq.players, game.squadLeaderRoles, game.knowsRole);
                return (
                  <Fragment key={key}>
                    <button type="button" className="team-squad-head" onClick={() => toggle(key)} aria-expanded={!shut}>
                      <span aria-hidden>{shut ? "▸" : "▾"}</span>
                      <span>{sq.squad}</span>
                      <span className="muted">({sq.players.length})</span>
                      {noLeader && <span className="nosl" title={noLeaderTip(sq.players, game.squadLeaderRoles, game.roleName, game.squadLabel)}>no SL</span>}
                      <span className="team-squad-sub">{killCount(sqKills)}</span>
                    </button>
                    {!shut && sq.players.map((p, i) => {
                      const role = game.roleName(p.role);
                      const icon = roleIconUrl(role, game.descriptor?.id);
                      const tk = p.stats?.teamKills ?? 0;
                      return (
                        <div key={(p.iD || p.id || i) as React.Key} className={`team-row${isTkFlagged(p) ? " tk-flag" : ""}`}>
                          {icon ? <img className="role-icon" src={icon} alt={role} title={role} /> : null}
                          {/* An empty level keeps its width, or that one name would start out of line. */}
                          <span className={`team-row-num team-row-level ${p.level != null ? levelClass(p.level) : ""}`} title="Level">{p.level ?? ""}</span>
                          <span className="team-row-name">
                            <PlayerLink playerId={p.playerDbId || p.iD || p.id} name={p.name || ""} />
                          </span>
                          {p.vip && <span className="mark vip" title="VIP" aria-label="VIP">★</span>}
                          {p.watch && <span className="mark watch" title="Watched" aria-label="Watched">👁</span>}
                          {/* Team kills before the K/D, so the K/D stays in its column beside the ⋯. */}
                          {tk > 0 && <span className={`team-row-num${isTkFlagged(p) ? " tk-hot" : ""}`} title="Team kills">{tk} TK</span>}
                          <span className="team-row-num team-row-kd" title="Kills / deaths">
                            {killsOf(p)}/{p.stats?.deaths ?? 0}
                          </span>
                          {(canFlags || canActions || canVip || canVipPause) && (
                            <PlayerActions
                              player={{ playerId: p.iD || p.id || "", dbId: p.playerDbId, name: p.name, watch: p.watch, watchReason: p.watchReason, watchBy: p.watchBy, vip: p.vip }}
                              serverId={serverId} canActions={canActions} canVip={canVip} canVipPause={canVipPause} onChanged={onChanged}
                            />
                          )}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
