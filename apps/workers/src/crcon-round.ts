/**
 * One pass of CRCON's map recorder over the newest round, which is CRCON's current map whether
 * it has ended or not (MapsHistory.get_current_map). It composes CRCON's decisions at the round's
 * start (round-start.ts) and end (round-end.ts) with its in-match recorder (cap-flips.ts), the way
 * rcon/logs/loop.py update_maps_history treats an ended round at v12.3.0:
 *
 *   - A round whose end stands gets one more recording pass, the first time the end is seen, and
 *     none after; its length is then carried as the elapsed time.
 *   - A round whose end CRCON deferred to the next start is still recorded as if running.
 *
 * Pure: the caller reads the session and writes what comes back, in the order start, timeline,
 * end (so a failure between writes repeats the end's pass rather than losing it).
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { recordTimelineStep, type LiveSession, type TimelineStep } from "./cap-flips.js";
import { recordRoundStart, type RoundStart } from "./round-start.js";
import { recordRoundEnd } from "./round-end.js";

/** What a pass reads of the round (a MatchRow carries all of it). */
export interface RoundRecord {
  map: string | null;
  startedAt: string;
  endedAt: string | null;
  /** The MATCH ENDED line's text, when a whistle closed the round. */
  result: string | null;
  crconMap: string | null;
  crconEndDeferred: boolean | null;
  capFlips: [number, number, number][];
  moraleHistory: [number, number, number][];
  matchTime: number;
  crconInitialMorale: number | null;
}

export interface RoundPass {
  start?: RoundStart;
  end?: { deferred: boolean };
  step?: TimelineStep;
  /** What the next pass sees as the previous elapsed time. */
  elapsed: number;
}

export function crconRoundPass(round: RoundRecord, game: string, nowMs: number, session: LiveSession, prevElapsed: number): RoundPass {
  const startMs = Date.parse(round.startedAt);
  const pass: RoundPass = { elapsed: prevElapsed };
  let filedAs = round.crconMap;
  let matchTime = round.matchTime;
  let initialMorale = round.crconInitialMorale;
  if (filedAs === null) {
    pass.start = recordRoundStart(round.map, game, startMs, nowMs, session);
    filedAs = pass.start.map;
    if (matchTime === 0) matchTime = pass.start.matchTime;
    initialMorale ??= pass.start.initialMorale;
  }
  let deferred = round.crconEndDeferred;
  let endSeenNow = false;
  if (round.endedAt !== null && round.result !== null && deferred === null) {
    pass.end = recordRoundEnd(round.result, game, Date.parse(round.endedAt), nowMs, session);
    deferred = pass.end.deferred;
    endSeenNow = !deferred;
  }
  if (round.endedAt !== null && deferred !== true && !endSeenNow) {
    pass.elapsed = Math.floor((Date.parse(round.endedAt) - startMs) / 1000);
    return pass;
  }
  pass.step = recordTimelineStep(filedAs, game, Math.floor(startMs / 1000), Math.floor(nowMs / 1000), session, {
    capFlips: round.capFlips, moraleHistory: round.moraleHistory, matchTime, initialMorale, prevElapsed,
  });
  pass.elapsed = pass.step.elapsed;
  return pass;
}
