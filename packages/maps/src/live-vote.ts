/**
 * The two decisions the map-vote worker makes on every pass, extracted so they can be tested without
 * a game server, a Discord token or a clock:
 *
 *  - `buildVoteAnnouncement` — what the in-game broadcast says (ported from the earlier bot's
 *    `_build_in_game_reminder_text`, which offered a "map list" and a "vote counts" layout).
 *  - `shouldApplyLiveLeader` — whether to re-queue the next map because the leading option changed.
 *
 * Live-applying is the behaviour that makes a vote trustworthy: rather than deciding once when the
 * match ends, the next map is kept pointed at whatever is currently winning. If a match ends early,
 * crashes, or a seed round is cut short, the map players actually picked is already queued.
 */
import type { PollOption } from "./vote.js";

export type VoteMessageLayout = "none" | "map_list" | "vote_counts";

/**
 * THE definition of a ballot-shaped chat line: a number, give or take punctuation ("3", " 3 ",
 * "!3", "3."), optionally behind the vote command players bring from other servers' votemaps:
 * "!vm 4", "!VM4", "!votemap 4", in any case, with or without the space. Those used to count as
 * conversation, so a player who voted that way was simply not counted. Returns the number, or null
 * for anything that is conversation.
 *
 * One definition on purpose, shared by the two sides that must agree on it forever:
 *  - the in-game vote counter (foldChatBallots in the worker) — what COUNTS as a vote;
 *  - the rules engine's exemption — what a chat rule must NEVER punish.
 * The map vote asks players to type these lines, so an auto-moderation rule counting them as
 * chat traffic punishes people for voting. If the shapes ever forked, one side would punish
 * exactly what the other side solicits.
 *
 * Bounds match the counter: at most two digits (no vote offers a hundred options; "1944" is a
 * year, not a ballot), and anything beyond the number is conversation ("3 tanks on E5").
 */
export function parseVoteBallot(message: string): number | null {
  const m = /^\s*(?:!\s*(?:votemap|vm)\s*|!?\s*)(\d{1,2})\s*[.!]?\s*$/i.exec(message);
  return m ? Number(m[1]) : null;
}

export interface VoteAnnouncementInput {
  /** the line staff wrote, e.g. "Vote for the next map in Discord!". */
  header: string;
  /** what to list underneath it. */
  layout: VoteMessageLayout;
  /** the options currently being voted on. */
  options: PollOption[];
  /** vote counts index-aligned with `options`; omitted or empty means "counts unknown". */
  tallies?: number[];
  /** In-game chat voting: each line carries its ballot number ("2. Foy"), and the vote_counts
   *  layout keeps OPTION ORDER instead of sorting by votes — the number IS how a player votes,
   *  and a list that reshuffles as votes land would have people voting for the wrong map. */
  numbered?: boolean;
}

/**
 * Compose the in-game broadcast for a running vote.
 *
 * `{options}` in the header is always replaced with a comma-separated list of the map names — and a
 * header that uses it is taken to have listed the maps itself, so no second list is appended. That
 * keeps every message written before layouts existed rendering exactly as it did.
 *
 * With no vote running, the header alone is returned (never a dangling "vote for:" with nothing
 * under it).
 */
export function buildVoteAnnouncement(input: VoteAnnouncementInput): string {
  const names = input.options.map((o) => o.name);
  const inline = names.join(", ");
  const header = input.header.replace(/\{options\}/gi, inline || "the map poll").trim();
  const headerListsThem = /\{options\}/i.test(input.header);
  if (input.layout === "none" || headerListsThem || names.length === 0) return header;

  const label = (name: string, i: number) => (input.numbered ? `${i + 1}. ${name}` : name);
  let lines: string[];
  if (input.layout === "map_list") {
    lines = names.map(label);
  } else {
    const tallies = input.tallies ?? [];
    // No counts read yet (the vote just opened, or Discord was unreachable) — showing "0 votes"
    // beside every map would misrepresent it, so fall back to the plain list.
    const known = tallies.length === input.options.length;
    lines = known
      ? input.numbered
        // Numbered lists never re-sort (see VoteAnnouncementInput.numbered).
        ? input.options.map((o, i) => `${label(o.name, i)} - ${tallies[i] ?? 0} vote${(tallies[i] ?? 0) === 1 ? "" : "s"}`)
        : input.options
            .map((o, i) => ({ name: o.name, votes: tallies[i] ?? 0 }))
            .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))
            .map((o) => `${o.name} - ${o.votes} vote${o.votes === 1 ? "" : "s"}`)
      : names.map(label);
  }
  return fit(header, lines);
}

/**
 * What one in-game message may be. Matches TEXT_MAX.reason in the API — the bucket for "something
 * said to a player in game" — because that is what this becomes.
 */
export const MAX_ANNOUNCEMENT_CHARS = 500;

/**
 * Header first, then as many option lines as fit.
 *
 * The header is bounded where staff type it, but the composed message is header PLUS a line per
 * option, and neither the option count nor the length of a map's custom display name is bounded by
 * anything. Sending the whole thing and hoping meant a poll with enough options silently produced a
 * message the game refused — once per player, now that this is sent individually.
 *
 * Whole lines are dropped rather than the text being cut mid-word, and the list is already ordered
 * with the most-voted first, so what survives is the part players most need to see. If even the
 * header does not fit it is truncated with an ellipsis, because a clipped reminder still tells
 * someone a vote is open.
 */
function fit(header: string, lines: string[]): string {
  if (header.length >= MAX_ANNOUNCEMENT_CHARS) return header.slice(0, MAX_ANNOUNCEMENT_CHARS - 1) + "…";
  const kept: string[] = [];
  let used = header.length + 2; // the blank line between the header and the list
  for (const line of lines) {
    if (used + line.length + (kept.length ? 1 : 0) > MAX_ANNOUNCEMENT_CHARS) break;
    used += line.length + (kept.length ? 1 : 0);
    kept.push(line);
  }
  return kept.length ? `${header}\n\n${kept.join("\n")}` : header;
}

export interface LiveLeaderInput {
  /** the "keep the next map on the current leader" setting. */
  enabled: boolean;
  /** the map that should be queued right now (the vote leader, or a staff override). */
  leaderId: string | null;
  /** what the tracker queued last time, so an unchanged leader costs no RCON calls. */
  alreadyAppliedId: string | null;
  /** total votes cast; a vote nobody has entered yet leaves the rotation alone. */
  totalVotes: number;
  /** when the last match ended (epoch ms), or 0 if we have never seen one. */
  lastMatchEndAt: number;
  now: number;
  /** how long after a match ends to leave the next map alone. */
  postMatchApplyDelayMs: number;
}

/** Whether to queue `leaderId` as the next map now — and, when not, why not (for the log). */
export function shouldApplyLiveLeader(input: LiveLeaderInput): { apply: boolean; reason: string } {
  if (!input.enabled) return { apply: false, reason: "live apply is off" };
  if (!input.leaderId) return { apply: false, reason: "no leading option" };
  if (input.totalVotes <= 0) return { apply: false, reason: "nobody has voted yet" };
  if (input.leaderId === input.alreadyAppliedId) return { apply: false, reason: "leader unchanged" };
  // The match that just started already has its map; the first votes of the replacement poll would
  // otherwise thrash the rotation while players are still loading in.
  if (input.lastMatchEndAt > 0 && input.postMatchApplyDelayMs > 0) {
    const since = input.now - input.lastMatchEndAt;
    if (since < input.postMatchApplyDelayMs) {
      return { apply: false, reason: `settling after the last match (${Math.ceil((input.postMatchApplyDelayMs - since) / 1000)}s left)` };
    }
  }
  return { apply: true, reason: "leader changed" };
}
