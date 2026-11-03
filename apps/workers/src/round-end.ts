/**
 * CRCON's record of a round's end, ported from rcon/hooks.py record_map_end at v12.3.0. A MATCH
 * ENDED line read within a minute ends the round only when the live layer is on the map the line
 * names (guess_map_from_log); otherwise CRCON writes nothing, and the next MATCH START ends the
 * round at its own time. A line read later than that ends the round at the line's time, whatever
 * is live.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool
 *   Copyright (c) 2020 Julien Marechal. MIT License; full text in third_party/crcon/LICENSE.
 */
import { crconGuessMapFromLog, crconParseLayer, crconParseLayerOrUnknown } from "@app/maps";
import type { LiveSession } from "./cap-flips.js";

/** CRCON checks the live map only for a MATCH ENDED line younger than this. */
const RECENT_MS = 60 * 1000;

/**
 * `endedText` is what the round stores from its MATCH ENDED line (everything after "MATCH
 * ENDED"); `endMs` is that line's time and `nowMs` the moment of deciding. `deferred` is true
 * where CRCON leaves the end to the next round's start.
 */
export function recordRoundEnd(endedText: string, game: string, endMs: number, nowMs: number, session: LiveSession): { deferred: boolean } {
  if (nowMs - endMs >= RECENT_MS) return { deferred: false };
  const logMap = crconGuessMapFromLog(`MATCH ENDED ${endedText}`, game);
  // get_gamestate's current_map, then parse_layer of that layer's id.
  const current = crconParseLayer(crconParseLayerOrUnknown(session.mapId ?? "", game).id, game);
  return { deferred: current.map.name !== logMap.map.name };
}
