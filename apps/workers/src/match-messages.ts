/**
 * Timed match messages (Auto settings): "N minutes after the match starts, tell everyone X".
 *
 * Pure, like state-rules.ts: the runner reads the open match, the roster count and what has
 * already gone out, and asks this which messages are due. Each message goes out ONCE per match —
 * keyed by the match's start time plus the message itself, so editing the list mid-match cannot
 * re-send a line that already went, and a reordered list does not either.
 */
import { MATCH_MESSAGE_GRACE_MIN, type AutoSettingsMatchMessage } from "@app/db";

/** The once-per-match key: the match (its start) + the message (its time and text). */
export function matchMessageKey(matchStartedAt: string, m: Pick<AutoSettingsMatchMessage, "minutes" | "message">): string {
  return `${matchStartedAt}|${m.minutes}|${m.message}`;
}

/**
 * The messages due now. A message is due from its minute until MATCH_MESSAGE_GRACE_MIN after it:
 * a worker that restarts, or a server that reaches the player minimum a couple of minutes late,
 * still sends it — one that only notices half an hour later does not, so switching this on
 * mid-match (or a long outage) never dumps a backlog of stale lines on the players.
 */
export function dueMatchMessages(opts: {
  messages: AutoSettingsMatchMessage[];
  matchStartedAt: string;
  /** minutes since the match started (null = unknown: nothing is due). */
  matchMinutes: number | null;
  playerCount: number;
  sent: ReadonlySet<string>;
  graceMin?: number;
}): { message: AutoSettingsMatchMessage; key: string }[] {
  if (opts.matchMinutes === null || !Number.isFinite(opts.matchMinutes)) return [];
  const grace = opts.graceMin ?? MATCH_MESSAGE_GRACE_MIN;
  const due: { message: AutoSettingsMatchMessage; key: string }[] = [];
  for (const m of opts.messages) {
    if (!m.enabled || !m.message.trim()) continue;
    if (opts.matchMinutes < m.minutes || opts.matchMinutes >= m.minutes + grace) continue;
    if (m.minPlayers > 0 && opts.playerCount < m.minPlayers) continue;
    const key = matchMessageKey(opts.matchStartedAt, m);
    if (opts.sent.has(key)) continue;
    due.push({ message: m, key });
  }
  return due.sort((a, b) => a.message.minutes - b.message.minutes);
}

/**
 * The keys already sent this match, read back from the audit rows the runner writes — so a
 * restart inside the grace window does not send the same message twice. Real sends and dry-run
 * "would send" lines are kept APART: trying a message in dry-run and then switching dry-run off
 * must not leave the real message counted as already gone out.
 */
export function sentMatchMessageKeys(rows: { data?: unknown }[], dryRun = false): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const d = r.data as { key?: unknown; dryRun?: unknown } | null | undefined;
    if (typeof d?.key !== "string" || !d.key) continue;
    if ((d.dryRun === true) !== dryRun) continue;
    out.add(d.key);
  }
  return out;
}
