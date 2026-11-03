/**
 * The score checked every 2 seconds between ingest polls, as CRCON's loop checks it.
 *
 * CRCON's log loop (rcon/logs/loop.py, run(loop_frequency_secs=2), v12.3.0) reads the game state
 * every 2 seconds, and record_cap_flips stamps a flip with the seconds since the round's start at
 * the pass that sees the score change. Our recorder ran only on the ingest poll, every 10 seconds,
 * so a flip could land up to 10 seconds after CRCON's would; an owner's side-by-side read showed
 * 349 against CRCON's 346. Between polls the worker now waits in 2-second steps and checks the
 * score at each one.
 *
 * Only a running round's timeline. Filing a round's start, closing its end and recording its
 * players stay on the poll, which also draws the score charts' closing point when it sees an end:
 * a round still to be filed, or one whose end stands, is the poll's alone, so the two never make
 * the same decision twice. Both run in the same loop, one after the other, never at once.
 */
import { crconRoundPass, type RoundRecord } from "./crcon-round.js";
import type { LiveSession, TimelineStep } from "./cap-flips.js";

/** CRCON's loop_frequency_secs. */
export const SCORE_CHECK_MS = 2_000;

/** Whether a timeline step has anything to write. */
export const stepHasNews = (step: TimelineStep | undefined): step is TimelineStep =>
  !!step && (!!step.flip || !!step.morale || step.matchTime !== undefined || step.initialMorale !== undefined);

/** The rounds a score check records: filed under a layer, and running (or their end deferred). */
export const scoreCheckable = (round: Pick<RoundRecord, "crconMap" | "endedAt" | "crconEndDeferred">): boolean =>
  round.crconMap !== null && (round.endedAt === null || round.crconEndDeferred === true);

/**
 * Wait until `untilMs` in steps of `stepMs`, checking the score after each step that leaves time
 * before the next poll. Returns once the poll is due or the runner has stopped.
 */
export async function waitCheckingScore(o: {
  untilMs: number;
  stepMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  check: () => Promise<void>;
}): Promise<void> {
  for (let left = o.untilMs - o.now(); left > 0 && !o.stopped(); left = o.untilMs - o.now()) {
    await o.sleep(Math.min(o.stepMs, left));
    if (!o.stopped() && o.untilMs - o.now() > 0) await o.check();
  }
}

/** What one score check reads and writes. */
export interface ScoreCheckIO {
  newestRound(): Promise<(RoundRecord & { id: string; game?: string | null }) | null>;
  readSession(): Promise<LiveSession>;
  recordTimeline(roundId: string, step: TimelineStep): Promise<unknown>;
  now(): number;
}

/**
 * One check: the newest round's timeline off one session read. Returns the elapsed time the next
 * pass carries (cap-flips.ts), unchanged for a round the check leaves to the poll — and that
 * round costs no session read.
 */
export async function scoreCheck(io: ScoreCheckIO, game: string, prevElapsed: number): Promise<number> {
  const round = await io.newestRound();
  if (!round || !scoreCheckable(round)) return prevElapsed;
  const session = await io.readSession();
  const pass = crconRoundPass(round, round.game ?? game, io.now(), session, prevElapsed);
  if (stepHasNews(pass.step)) await io.recordTimeline(round.id, pass.step);
  return pass.elapsed;
}
