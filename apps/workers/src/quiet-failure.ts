/**
 * Best-effort work that runs on a tick: a blip is noise, a persistent failure is news.
 *
 * Every repeating job in the worker wraps itself in a try/catch so one bad read cannot tear down
 * the loop it rides on — which is right. What was wrong is where those catches logged: `debug`,
 * while the default LOG_LEVEL is `info`. The reasoning was sound (a failure on a 60-second tick
 * logged at warn is a hundred lines an hour, and a log nobody can read is as good as no log), but
 * the result was that a feature could stop working forever and say nothing at all. The roster stats
 * fold is the one that matters most: if it starts failing, kills and playtime quietly stop
 * accumulating and the first anyone hears of it is "why is the leaderboard stale?".
 *
 * So: say it once when it breaks, repeat while it stays broken but rarely, and say so when it
 * recovers. The recovery line is the half that makes the warning safe to act on — without it a
 * reader finds a warning from an hour ago and cannot tell whether it is still true.
 */

/** What the caller should do about this failure. */
export interface FailureVerdict {
  /** Log it — this failure is new, or it has gone on long enough to be worth repeating. */
  speak: boolean;
  /** Consecutive failures including this one. 1 means "just started". */
  runs: number;
  /** How long it has been failing, in ms. 0 on the first. */
  sinceMs: number;
}

/** What the caller should say about a success that ended a run of failures. */
export interface RecoveryVerdict {
  /** True only when this success follows failures the caller was told to speak about. */
  recovered: boolean;
  /** How many consecutive failures preceded it. */
  runs: number;
  /** How long it had been failing, in ms. */
  sinceMs: number;
}

/** Repeat a still-failing warning this often. Long enough to stay out of the way, short enough
 *  that someone reading an hour of logs sees it more than once. */
const DEFAULT_REPEAT_MS = 15 * 60_000;

/**
 * Tracks consecutive failures per key so a tick can decide whether its failure is worth saying.
 *
 * One instance per process; the key names the job and its subject (`"stats-fold:<serverId>"`), so
 * one server's broken pipeline never silences another's.
 */
export class QuietFailures {
  private readonly runs = new Map<string, { count: number; firstAt: number; lastSpokeAt: number }>();

  constructor(private readonly repeatMs = DEFAULT_REPEAT_MS) {}

  /** Record a failure and decide whether to log it. */
  fail(key: string, now = Date.now()): FailureVerdict {
    const prev = this.runs.get(key);
    if (!prev) {
      this.runs.set(key, { count: 1, firstAt: now, lastSpokeAt: now });
      return { speak: true, runs: 1, sinceMs: 0 };
    }
    prev.count += 1;
    const sinceMs = now - prev.firstAt;
    // `>=` so a repeat interval of 0 speaks every time, which is what a test asking for that means.
    const speak = now - prev.lastSpokeAt >= this.repeatMs;
    if (speak) prev.lastSpokeAt = now;
    return { speak, runs: prev.count, sinceMs };
  }

  /**
   * Record a success. Reports a recovery only when the failures before it were ever spoken about —
   * a single blip that was never logged does not need an "it's fine now" line for a problem the
   * reader never saw.
   */
  ok(key: string, now = Date.now()): RecoveryVerdict {
    const prev = this.runs.get(key);
    if (!prev) return { recovered: false, runs: 0, sinceMs: 0 };
    this.runs.delete(key);
    return { recovered: true, runs: prev.count, sinceMs: now - prev.firstAt };
  }
}

/** "for 2h 5m" / "for 40s" — the phrase that turns a warning into something a reader can weigh. */
export function forDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `for ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `for ${m}m`;
  const h = Math.floor(m / 60);
  return `for ${h}h ${m % 60}m`;
}
