/**
 * Roster composition — what a live server looks like at one instant, reduced to counts.
 *
 * Two callers need the same answer and must not disagree about it:
 *   • the Live view, which shows which squads have no leader right now;
 *   • the roster-snapshot sampler, which writes this shape to the database every minute so
 *     composition can be charted over time (a snapshot is the only way to get it — nothing in the
 *     event log records who was playing what role, so it cannot be reconstructed after the fact).
 *
 * Pure and descriptor-driven, so it works for any game with sides, roles and squads. Side
 * resolution goes through `resolveTeamSides`, which corrects the descriptor's static guess against
 * the session's own headcounts — the snapshot must not encode a side mix-up that the Live view
 * would have corrected, or a week of history quietly reports the wrong team.
 *
 * Deliberately NOT in here: anything about who the players are. A snapshot is a shape, not a
 * roster; keeping names and ids out of it is what makes it cheap enough to store forever.
 */
import type { GameDescriptor } from "./types.js";
import { resolveTeamSides, type SessionHeadcounts } from "./team-sides.js";

/** The fields of a live player this reduction reads. Anything shaped like this will do. */
export interface RosterPlayerLike {
  team?: number | null;
  role?: number | null;
  /** squad/platoon name; blank or absent means unsquadded. */
  platoon?: string | null;
  squad?: string | null;
}

export interface SideComposition {
  /** players resolved to this side. */
  players: number;
  /** distinct named squads. */
  squads: number;
  /** squad names with nobody in a squad-leader role, sorted — the actionable list. */
  noSlSquads: string[];
  /** players not in any named squad. */
  unsquadded: number;
  /** role id → players in it. Only roles actually present appear. */
  byRole: Record<number, number>;
}

export interface RosterSummary {
  /** everyone on the roster, including players whose side couldn't be resolved. */
  players: number;
  /** side id → composition, for every side the descriptor declares (absent sides read as zero). */
  bySide: Record<string, SideComposition>;
  /** players whose team value resolved to no side at all (mid-switch, unassigned). */
  unassigned: number;
  /** every role present, across all sides — the union of the per-side `byRole` keys. */
  byRole: Record<number, number>;
}

const emptySide = (): SideComposition => ({ players: 0, squads: 0, noSlSquads: [], unsquadded: 0, byRole: {} });

const squadNameOf = (p: RosterPlayerLike): string => String(p.platoon ?? p.squad ?? "").trim();

/**
 * Reduce a live roster to composition counts.
 *
 * `session` is the same live read's session block when available; it is what lets side resolution
 * recover from a server build whose team encoding puts both teams on one side.
 */
export function summarizeRoster(
  players: RosterPlayerLike[],
  descriptor: Pick<GameDescriptor, "sides" | "squadLeaderRoles" | "roles"> | null | undefined,
  session?: SessionHeadcounts | null,
): RosterSummary {
  const sides = descriptor?.sides ?? [];
  const leaderRoles = new Set(descriptor?.squadLeaderRoles ?? []);
  /**
   * Roles the descriptor can actually name. A number outside this is one we cannot reason about —
   * except when the table is absent or empty, where there is nothing to compare against and every
   * role counts as known. An unpopulated role table must not silently disable what is built on it.
   */
  const known = descriptor?.roles;
  const namesRoles = known != null && Object.keys(known).length > 0;
  const knowsRole = (role: number): boolean => !namesRoles || known[role] != null;

  const teamCounts = new Map<number, number>();
  for (const p of players) {
    if (p.team == null) continue;
    teamCounts.set(p.team, (teamCounts.get(p.team) ?? 0) + 1);
  }
  const sideByTeam = resolveTeamSides(sides, teamCounts, session);

  const bySide: Record<string, SideComposition> = {};
  for (const s of sides) bySide[s.id] = emptySide();
  const byRole: Record<number, number> = {};
  // side/squad → whether anyone in it holds a leader role. Squads are per side: two teams routinely
  // both field a squad called BAKER, and counting them as one would hide a leaderless one.
  const squads = new Map<string, { side: string; name: string; hasLeader: boolean }>();
  let unassigned = 0;

  for (const p of players) {
    const sideId = p.team == null ? null : sideByTeam.get(p.team) ?? null;
    if (p.role != null) byRole[p.role] = (byRole[p.role] ?? 0) + 1;
    if (!sideId) { unassigned += 1; continue; }
    const side = (bySide[sideId] ??= emptySide());
    side.players += 1;
    if (p.role != null) side.byRole[p.role] = (side.byRole[p.role] ?? 0) + 1;

    const squad = squadNameOf(p);
    if (!squad) { side.unsquadded += 1; continue; }
    const key = `${sideId}\u0000${squad}`;
    const entry = squads.get(key) ?? { side: sideId, name: squad, hasLeader: false };
    // A game with no leader role declared has no such thing as a leaderless squad, so every squad
    // counts as led rather than every squad being flagged. Same for a squad holding a role the
    // descriptor cannot name: that role could be its leader, and there is no basis to say it is
    // not — HLL artillery squads were reported leaderless for exactly this reason.
    if (leaderRoles.size === 0 || (p.role != null && (leaderRoles.has(p.role) || !knowsRole(p.role)))) entry.hasLeader = true;
    squads.set(key, entry);
  }

  for (const s of squads.values()) {
    const side = bySide[s.side];
    if (!side) continue;
    side.squads += 1;
    if (!s.hasLeader) side.noSlSquads.push(s.name);
  }
  for (const side of Object.values(bySide)) side.noSlSquads.sort();

  return { players: players.length, bySide, unassigned, byRole };
}
