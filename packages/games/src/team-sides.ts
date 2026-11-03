/**
 * Team → side resolution for a LIVE roster.
 *
 * The static descriptor mapping (teamValues, then parity) is a best guess, and HLL's team
 * encoding genuinely varies by server build: captures have shown axis as 0 with allies as 1 or 3,
 * and console builds have produced lobbies whose two team values BOTH land on one side under the
 * static rules (seen live: every player labeled Axis). A real match always has two sides, so when
 * the static guess collapses like that we correct it here, using evidence from the same live read:
 *
 *   1. static mapping (explicit teamValues, then parity fallback) — kept whenever it already
 *      yields two distinct sides;
 *   2. the session's own headcounts (alliedPlayerCount / axisPlayerCount): if the two team
 *      values' roster counts match the session's two headcounts exactly (and unambiguously),
 *      the counts decide which value is which side;
 *   3. last resort: keep the value the descriptor lists explicitly, flip the parity-guessed one
 *      (both-or-neither explicit → flip the higher value; observed encodings put axis low).
 *
 * Pure and game-agnostic (any 2-sided game descriptor works), so both the API's /live enrichment
 * and the bulk team-move action share the exact same decision.
 */
import type { GameSide } from "./types.js";

export interface SessionHeadcounts {
  alliedPlayerCount?: number;
  axisPlayerCount?: number;
}

/** Static descriptor lookup: explicit teamValues first, parity fallback second. */
export function staticSideOf(sides: GameSide[], team: number): GameSide | null {
  const listed = sides.find((s) => s.teamValues.includes(team));
  if (listed) return listed;
  const parity = team % 2 === 0 ? "even" : "odd";
  return sides.find((s) => s.parity === parity) ?? null;
}

/**
 * Team values by headcount, biggest first — the first two are the real teams. A tie (a quiet
 * seeding server can have one player on a team and one sitting unassigned) goes to a value the
 * descriptor lists over one it does not, then to the lower number.
 */
function rankTeams(sides: GameSide[], teamCounts: Map<number, number>): number[] {
  const listed = (t: number) => (sides.some((s) => s.teamValues.includes(t)) ? 0 : 1);
  return [...teamCounts.keys()].sort((x, y) => (teamCounts.get(y)! - teamCounts.get(x)!) || listed(x) - listed(y) || x - y);
}

/**
 * Resolve every team value present on the roster to a side id — null for players on neither of
 * the two real teams.
 * `teamCounts`: raw team value → number of players on it (from the roster read).
 * `session`: the same live read's session block, when available.
 */
export function resolveTeamSides(
  sides: GameSide[],
  teamCounts: Map<number, number>,
  session?: SessionHeadcounts | null,
): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (const team of teamCounts.keys()) out.set(team, staticSideOf(sides, team)?.id ?? null);
  // Corrections only make sense for a classic 2-sided game.
  if (sides.length !== 2) return out;
  const values = [...teamCounts.keys()];
  if (values.length < 2) return out;

  // The two BIGGEST groups are the real sides. A live roster is not always exactly two values: a
  // player caught mid team-switch, or sitting unassigned after connecting, occupies a third value
  // of their own. This used to require exactly two and give up otherwise — so on a full 49v49
  // server, one person switching teams was enough to abandon the correction and leave both real
  // teams labelled Axis, with team stats crediting all 1,517 kills to one side and zero to the
  // other. A straggler must not get a vote on which side is which.
  const [a, b] = rankTeams(sides, teamCounts) as [number, number];
  // Everyone outside those two groups is on NO team — loading in, on the team-select screen,
  // mid-switch. The static guess would file them under a side anyway (parity puts most stray
  // values on Allies), which showed 52 Allies on a server the game itself held at 50.
  for (const t of values) if (t !== a && t !== b) out.set(t, null);
  const ac = teamCounts.get(a)!;
  const bc = teamCounts.get(b)!;
  const sAllied = session?.alliedPlayerCount;
  const sAxis = session?.axisPlayerCount;
  // A quiet server: one real team, and the second group is somebody loading in. The session says
  // the other side is empty and the biggest group alone is everyone on a team — so the second
  // group is on no team either, not the first player of the other side.
  if (sAllied != null && sAxis != null && (sAllied === 0 || sAxis === 0) && ac === sAllied + sAxis) {
    out.set(b, null);
    return out;
  }
  if (out.get(a) !== out.get(b)) return out; // static already distinguishes them — done

  // The static guess collapsed both teams onto one side. First tie-breaker: the session's own
  // headcounts, matched against the roster counts from the same read.
  const [allies, axis] = sides.find((s) => s.id === "allies") && sides.find((s) => s.id === "axis")
    ? [sides.find((s) => s.id === "allies")!, sides.find((s) => s.id === "axis")!]
    : [sides[0]!, sides[1]!];
  if (sAllied != null && sAxis != null && sAllied !== sAxis && ac !== bc) {
    if (ac === sAllied && bc === sAxis) { out.set(a, allies.id); out.set(b, axis.id); return out; }
    if (ac === sAxis && bc === sAllied) { out.set(a, axis.id); out.set(b, allies.id); return out; }
  }

  // Last resort: trust the explicitly-listed value, flip the parity-guessed one; if that doesn't
  // separate them either, flip the higher value (observed encodings put axis at the low numbers).
  const explicit = (t: number) => sides.some((s) => s.teamValues.includes(t));
  const flip = explicit(a) && !explicit(b) ? b : explicit(b) && !explicit(a) ? a : Math.max(a, b);
  const keep = flip === a ? b : a;
  const keptSide = out.get(keep);
  const other = sides.find((s) => s.id !== keptSide);
  if (other) out.set(flip, other.id);
  return out;
}

/**
 * Whether resolveTeamSides' answer for this read rests on EVIDENCE — the static mapping already
 * separating the two big teams, or the session headcounts matching the roster counts exactly —
 * rather than on the last-resort flip. A caller holding state across reads (the live sampler)
 * uses this as the write-gate on its remembered mapping: a confident read updates the memory, an
 * unconfident one defers to it. Match start is the case that demands it — half-loaded lobbies
 * produce single-team reads and equal headcounts, and an answer that wobbles tick to tick paints
 * every inference downstream in alternating colours.
 */
export function teamSidesConfident(
  sides: GameSide[],
  teamCounts: Map<number, number>,
  session?: SessionHeadcounts | null,
): boolean {
  if (sides.length !== 2) return true; // nothing to correct — the static answer is all there is
  const values = [...teamCounts.keys()];
  if (values.length < 2) return false; // one visible team proves nothing about which side it is
  const [a, b] = rankTeams(sides, teamCounts) as [number, number];
  const sa = staticSideOf(sides, a)?.id;
  const sb = staticSideOf(sides, b)?.id;
  if (sa && sb && sa !== sb) return true; // the static mapping separated them on its own
  const ac = teamCounts.get(a)!;
  const bc = teamCounts.get(b)!;
  const sAllied = session?.alliedPlayerCount;
  const sAxis = session?.axisPlayerCount;
  return sAllied != null && sAxis != null && sAllied !== sAxis && ac !== bc
    && ((ac === sAllied && bc === sAxis) || (ac === sAxis && bc === sAllied));
}
