/**
 * CRCON's record of a round as it starts, ported from rcon/hooks.py handle_new_match_start at
 * v12.3.0: the layer id it files the round under — the `map_name` every past round is published
 * with, and the id its in-match recorder (cap-flips.ts) compares the live map with — whether that
 * id was guessed from the match log, and the match_time and initial_morale the round starts with.
 *
 *   - The MATCH START line names the map in display text; CRCON guesses a layer from it
 *     (guess_map_from_log, in @app/maps).
 *   - When the line is under five minutes old and the live layer is on the same map, the LIVE
 *     layer is filed, not the guess, and initial_morale is the live one when the live mode agrees
 *     with that layer's.
 *   - Otherwise the guess is filed, and guessed stays true.
 *   - match_time is the live timer's theoretical window whenever the live mode agrees with the
 *     live layer's, recent or not; 0 otherwise (the recorder fills it later).
 *
 * CRCON decides this once, as its log loop reads the line; the worker decides it on its first
 * pass over the open round that has a session read to decide with.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { crconGuessMapFromLog, crconParseGameModeOrNone, crconParseLayer, crconParseLayerOrUnknown, crconTheoreticalMatchTime } from "@app/maps";
import type { LiveSession } from "./cap-flips.js";

export interface RoundStart {
  /** The layer id the round is filed under (str(map_to_save)). */
  map: string;
  guessed: boolean;
  matchTime: number;
  initialMorale: number | null;
}

/** CRCON trusts the live layer only for a MATCH START line younger than this. */
const RECENT_MS = 5 * 60 * 1000;

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/**
 * `logMapText` is what the round stores from its MATCH START line (everything after "MATCH
 * START"); `startMs` is that line's time and `nowMs` the moment of deciding.
 */
export function recordRoundStart(logMapText: string | null, game: string, startMs: number, nowMs: number, session: LiveSession): RoundStart {
  const logMap = crconGuessMapFromLog(`MATCH START ${logMapText ?? ""}`, game);
  // get_gamestate's current_map and game_mode, then parse_layer of that layer's id.
  const live = crconParseLayerOrUnknown(session.mapId ?? "", game);
  const current = crconParseLayer(live.id, game);
  const liveMode = crconParseGameModeOrNone(session.gameMode ?? "", game) ?? live.game_mode;
  const modesAgree = current.game_mode === liveMode;
  const matchTime = modesAgree ? crconTheoreticalMatchTime(liveMode, int(session.matchTime) ?? 0) : 0;
  if (nowMs - startMs < RECENT_MS && current.map.name === logMap.map.name) {
    return { map: current.id, guessed: false, matchTime, initialMorale: modesAgree ? int(session.initialMorale) : null };
  }
  return { map: logMap.id, guessed: true, matchTime, initialMorale: null };
}
