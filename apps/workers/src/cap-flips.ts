/**
 * CRCON's in-match recorder for the score timeline, ported from rcon/logs/loop.py at v12.3.0
 * (update_maps_history's gates, then record_cap_flips). It decides, from one live session read,
 * whether the round's `cap_flips` and `morale_history` grow, and sets `match_time` once. Those are
 * what get_public_info, the map history and every stored round publish, so this is the only
 * place they are decided.
 *
 * CRCON runs this every 2 seconds, and so does the worker: on its 10-second poll and on the score
 * check between polls (score-check.ts), so a flip's `ts` lands within 2 seconds of where CRCON's
 * would (two independent recorders never agree to the second). Everything else is CRCON's rule
 * for rule:
 *
 *   - Nothing is recorded while the live layer (as get_gamestate parses the session's map id)
 *     is not the one the round is filed under (round-start.ts), while the live mode differs from
 *     that layer's, or before the clock has started (0 remaining and nothing recorded on the
 *     previous pass).
 *   - A flip is the score when it differs from the last one recorded, at seconds since the start.
 *     Warfare's 2-2 is not recorded once there are flips (a new match's opening score leaking in),
 *     nor an Offensive score reset to its opening line.
 *   - Conquest samples morale with each flip, and takes initial_morale from the first one.
 *   - match_time is the theoretical full window, set the first time it is still 0.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { crconParseGameModeOrNone, crconParseLayer, crconParseLayerOrUnknown, crconTheoreticalMatchTime } from "@app/maps";

export interface TimelineState {
  /** [ts, allied_score, axis_score], oldest first. */
  capFlips: [number, number, number][];
  /** [ts, allied_morale, axis_morale], oldest first. */
  moraleHistory: [number, number, number][];
  matchTime: number;
  initialMorale: number | null;
  /** The elapsed seconds the previous pass returned (0 after an idle pass). */
  prevElapsed: number;
}

export interface LiveSession {
  mapId?: string;
  gameMode?: string;
  remainingMatchTime?: number;
  matchTime?: number;
  alliedScore?: number;
  axisScore?: number;
  alliedMorale?: number;
  axisMorale?: number;
  initialMorale?: number;
}

export interface TimelineStep {
  /** What the next pass sees as prevElapsed. */
  elapsed: number;
  /** Set when the pass got past update_maps_history's gates, so CRCON recorded the round's
   *  score timeline and its players (crcon-players.ts) on it. */
  recorded?: true;
  /** Set when match_time was 0 and now has its value. */
  matchTime?: number;
  flip?: [number, number, number];
  morale?: [number, number, number];
  initialMorale?: number;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/** One pass of CRCON's recorder over the open round. `roundMap` is the layer id the round is
 *  filed under; `nowSec` and `startSec` are epoch seconds. */
export function recordTimelineStep(roundMap: string, game: string, startSec: number, nowSec: number, session: LiveSession, state: TimelineState): TimelineStep {
  const elapsed = nowSec - startSec;
  // gs["current_map"]["id"]: the catalogue's spelling of a known id, "unknown" for no shape at all.
  const live = crconParseLayerOrUnknown(session.mapId ?? "", game);
  if (live.id !== roundMap) return { elapsed: 0 };
  let cachedMode: string;
  try {
    cachedMode = crconParseLayer(roundMap, game).game_mode;
  } catch {
    return { elapsed: 0 };
  }
  const liveMode = crconParseGameModeOrNone(session.gameMode ?? "", game) ?? live.game_mode;
  if (cachedMode !== liveMode) return { elapsed: 0 };
  // timedelta(seconds=int(remainingMatchTime)).seconds: the clock, 0 before a match starts.
  const remaining = int(session.remainingMatchTime) ?? 0;
  if (remaining === 0 && state.prevElapsed === 0) return { elapsed: 0 };

  const step: TimelineStep = { elapsed, recorded: true };
  if (state.matchTime === 0) step.matchTime = crconTheoreticalMatchTime(cachedMode, int(session.matchTime) ?? 0);

  const allied = int(session.alliedScore);
  const axis = int(session.axisScore);
  if (allied === null || axis === null) return step;
  const flips = state.capFlips;
  if (cachedMode === "warfare" && allied === 2 && axis === 2 && flips.length) return step;
  if (cachedMode === "offensive" && flips.length) {
    const attackers = crconParseLayer(roundMap, game).attackers;
    const opening = attackers === "allies" ? [0, 5] : attackers === "axis" ? [5, 0] : null;
    if (opening && allied === opening[0] && axis === opening[1]) return step;
  }
  const last = flips[flips.length - 1];
  if (!last || last[1] !== allied || last[2] !== axis) {
    step.flip = [elapsed, allied, axis];
    if (cachedMode === "conquest") {
      if (state.initialMorale === null) step.initialMorale = int(session.initialMorale) ?? 0;
      step.morale = [elapsed, int(session.alliedMorale) ?? 0, int(session.axisMorale) ?? 0];
    }
  }
  return step;
}
