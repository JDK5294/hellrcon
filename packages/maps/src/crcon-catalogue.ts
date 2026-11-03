/**
 * CRCON's map catalogue, ported verbatim from its `maps.py`.
 *
 * ---------------------------------------------------------------------------------------------
 * Derived from Hell Let Loose Community RCON — https://github.com/MarechJ/hll_rcon_tool
 *
 *   Copyright (c) 2020 Julien Marechal
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * The notice is repeated here, and not only in NOTICE.md, because this file SHIPS: it compiles
 * into the published package, and MIT asks that the notice travel with the copy.
 * ---------------------------------------------------------------------------------------------
 *
 * These are catalogue FACTS, not inferences: the tag a scoreboard prints, the short name an
 * overlay shows, which way round the map is drawn, and which two armies actually fight on it.
 * Nothing here can be derived from a map id — Carentan fields US, Kursk fields RUS and Driel
 * fields CW, and no amount of string parsing knows that — which is why the public API used to answer them blank (gap 4 in
 * docs/streamer-mode.md) and why a lookup table is the right shape.
 *
 * Extracted mechanically from CRCON master rather than retyped, so a value cannot drift from a
 * transcription slip. WW2 only, and deliberately: CRCON builds its OWN Vietnam entries from the
 * protocol at runtime (`Map.from_hllrcon`) rather than from this list, so inventing static Vietnam
 * rows here would be guessing where CRCON reads. A map with no row keeps CRCON's own empty values.
 */
export interface CrconMapFacts {
  /** The uppercase display name CRCON carries as `map.name`, distinct from `pretty_name`. */
  name: string;
  tag: string;
  prettyName: string;
  shortname: string;
  /** Faction short names, lowercased — CRCON's `Faction.name`. */
  allies: string;
  axis: string;
  orientation: "horizontal" | "vertical";
}

/** Keyed by the map FAMILY id (`stmereeglise`), which is what a layer id's first token gives. */
export const CRCON_MAPS: Record<string, CrconMapFacts> = {
  "stmereeglise": { name: "SAINTE-MÈRE-ÉGLISE", tag: "SME", prettyName: "St. Mere Eglise", shortname: "SME", allies: "us", axis: "ger", orientation: "horizontal" },
  "stmariedumont": { name: "ST MARIE DU MONT", tag: "BRC", prettyName: "St. Marie Du Mont", shortname: "SMDM", allies: "us", axis: "ger", orientation: "vertical" },
  "utahbeach": { name: "UTAH BEACH", tag: "UTA", prettyName: "Utah Beach", shortname: "Utah", allies: "us", axis: "ger", orientation: "horizontal" },
  "omahabeach": { name: "OMAHA BEACH", tag: "OMA", prettyName: "Omaha Beach", shortname: "Omaha", allies: "us", axis: "ger", orientation: "horizontal" },
  // Update 21 (not in the ported maps.py yet): the Canadian landing beach. Faction token follows
  // the kill log's CDN. Orientation matches its beach siblings until a live tactical map says
  // otherwise — flip it here if the in-game map proves vertical.
  "junobeach": { name: "JUNO BEACH", tag: "JUN", prettyName: "Juno Beach", shortname: "Juno", allies: "cdn", axis: "ger", orientation: "horizontal" },
  "purpleheartlane": { name: "PURPLE HEART LANE", tag: "PHL", prettyName: "Purple Heart Lane", shortname: "PHL", allies: "us", axis: "ger", orientation: "vertical" },
  "carentan": { name: "CARENTAN", tag: "CAR", prettyName: "Carentan", shortname: "Carentan", allies: "us", axis: "ger", orientation: "horizontal" },
  "hurtgenforest": { name: "HÜRTGEN FOREST", tag: "HUR", prettyName: "Hurtgen Forest", shortname: "Hurtgen", allies: "us", axis: "ger", orientation: "horizontal" },
  "hill400": { name: "HILL 400", tag: "HIL", prettyName: "Hill 400", shortname: "Hill 400", allies: "us", axis: "ger", orientation: "horizontal" },
  "foy": { name: "FOY", tag: "FOY", prettyName: "Foy", shortname: "Foy", allies: "us", axis: "ger", orientation: "vertical" },
  "kursk": { name: "KURSK", tag: "KUR", prettyName: "Kursk", shortname: "Kursk", allies: "rus", axis: "ger", orientation: "vertical" },
  "stalingrad": { name: "STALINGRAD", tag: "STA", prettyName: "Stalingrad", shortname: "Stalingrad", allies: "rus", axis: "ger", orientation: "horizontal" },
  "remagen": { name: "REMAGEN", tag: "REM", prettyName: "Remagen", shortname: "Remagen", allies: "us", axis: "ger", orientation: "vertical" },
  "kharkov": { name: "Kharkov", tag: "KHA", prettyName: "Kharkov", shortname: "Kharkov", allies: "rus", axis: "ger", orientation: "vertical" },
  "driel": { name: "DRIEL", tag: "DRL", prettyName: "Driel", shortname: "Driel", allies: "cw", axis: "ger", orientation: "vertical" },
  "elalamein": { name: "EL ALAMEIN", tag: "ELA", prettyName: "El Alamein", shortname: "Alamein", allies: "cw", axis: "ger", orientation: "horizontal" },
  "mortain": { name: "MORTAIN", tag: "MOR", prettyName: "Mortain", shortname: "Mortain", allies: "us", axis: "ger", orientation: "horizontal" },
  "elsenbornridge": { name: "ELSENBORN RIDGE", tag: "EBR", prettyName: "Elsenborn Ridge", shortname: "Elsenborn", allies: "us", axis: "ger", orientation: "vertical" },
  "tobruk": { name: "TOBRUK", tag: "TBK", prettyName: "Tobruk", shortname: "Tobruk", allies: "cw", axis: "ger", orientation: "horizontal" },
  "smolensk": { name: "SMOLENSK", tag: "SMO", prettyName: "Smolensk", shortname: "Smolensk", allies: "rus", axis: "ger", orientation: "horizontal" },
};
