/**
 * Resolve the winner of a map vote from the poll tally. Pure so it's unit-testable and shared by any
 * vote surface (native Discord poll, custom embed, panel). Options are indexed in poll order; counts
 * line up by index. Highest count wins; ties break to the earliest option (deterministic). With no
 * votes at all, the first option wins — a map still gets applied rather than stalling the rotation.
 * The options are shuffled when the ballot is composed, so "the first option" is a random pick.
 */
import type { PollOption } from "./vote.js";

export interface VoteWinner {
  option: PollOption;
  index: number;
  count: number;
  /** true when no option received any vote (winner is the first option by default). Votes for an
   *  excluded map do not count here. */
  noVotes: boolean;
}

/** One map id against another, as every guard here compares them: case and stray spaces aside. */
const sameMap = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function resolveVoteWinner(options: PollOption[], counts: number[], opts: { exclude?: string | null } = {}): VoteWinner | null {
  if (options.length === 0) return null;
  /*
   * `exclude` is the map being played right now. A ballot is composed without it, but a ballot
   * that opened while a round was ending can carry the map that then loaded — and queueing the
   * map in play as the next one replays it. It cannot win while anything else is on the ballot;
   * a ballot of nothing else (which composition never produces) is judged as it stands.
   */
  const exclude = opts.exclude?.trim() || null;
  const barred = (o: PollOption) => !!exclude && sameMap(o.id, exclude);
  const eligible = options.some((o) => !barred(o)) ? (o: PollOption) => !barred(o) : () => true;
  let bestIndex = -1;
  let bestCount = 0;
  let total = 0;
  for (let i = 0; i < options.length; i++) {
    // Votes for a barred map count for nothing here: the result is then the default pick.
    if (!eligible(options[i]!)) continue;
    const c = counts[i] ?? 0;
    total += c;
    if (bestIndex === -1 || c > bestCount) { bestCount = c; bestIndex = i; }
  }
  return { option: options[bestIndex]!, index: bestIndex, count: bestCount, noVotes: total === 0 };
}


/**
 * The vote's result as its round ends, and whether that result still has to be queued.
 *
 * `roundMap` is the map the vote's own round was played on, when the vote saw it; `inPlay` is the
 * map in play as the match end is READ. Normally they are the same map — the scoreboard is still
 * up — and it cannot win: queueing the map just played replays it. (A ballot is composed without
 * it, so this only bites a ballot that opened as a round was ending.)
 *
 * They differ when the match end is read late, after the next map has loaded. Barring the map in
 * play then would bar the map players picked — live apply or the replay guard queued it, which is
 * why it loaded — and announce the runner-up. So the round's own map is what is barred, and a
 * winner that is already in play is reported as the result it is, with `alreadyInPlay` telling the
 * caller not to queue it a second time. Without `roundMap`, the map in play stands in for the
 * round that ended, as it always did.
 */
export function resolveRoundResult(input: {
  options: PollOption[];
  counts: number[];
  roundMap?: string | null;
  inPlay?: string | null;
}): { winner: VoteWinner; alreadyInPlay: boolean } | null {
  const roundMap = input.roundMap?.trim() || null;
  const inPlay = input.inPlay?.trim() || null;
  const winner = resolveVoteWinner(input.options, input.counts, { exclude: roundMap ?? inPlay });
  if (!winner) return null;
  const alreadyInPlay = !!inPlay && !!roundMap && !sameMap(inPlay, roundMap) && sameMap(winner.option.id, inPlay);
  return { winner, alreadyInPlay };
}
