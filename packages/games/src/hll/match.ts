/**
 * Pure parsing of an HLL "MATCH ENDED" result string into a structured outcome. The admin log's
 * end line varies in shape, and the shapes mean different things:
 *
 *   "`Kharkov Warfare` ALLIED (2 - 3) AXIS"  — the modern game: BOTH sides appear, flanking the
 *                                              score as column labels. No winner is named at all;
 *                                              the numbers are the only verdict. Reading the first
 *                                              side token as "the winner" here recorded every
 *                                              single round as an Allied win — a 122–0 season.
 *   "Foy Warfare AXIS (5 - 0)"               — the legacy shape: ONE side named, and it is the
 *                                              winner.
 *   "SME Offensive (3 - 2)"                  — no side named; the decisive score decides.
 *
 * Kept out of the worker so it's unit-testable with fixture strings; the worker just folds the
 * result onto the open match row.
 */
export type MatchSide = "allies" | "axis";

export interface MatchOutcome {
  /** winning side, when the result names one (ALLIED/AXIS); null for a draw or unparseable side. */
  winner: MatchSide | null;
  /** left/right numbers from the "(a - b)" score, if present. Convention: allied then axis. */
  alliedScore: number | null;
  axisScore: number | null;
}

// The LAST "(a - b)" in the line, not an end-anchored one: the modern line ends "… (2 - 3) AXIS",
// and an end anchor made the score invisible — every round then leaned on the sampled live score,
// and a round the sampler missed recorded no score at all.
const SCORE_RE = /\(\s*(\d+)\s*[-–]\s*(\d+)\s*\)/g;
function lastScore(text: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  SCORE_RE.lastIndex = 0;
  for (let m = SCORE_RE.exec(text); m; m = SCORE_RE.exec(text)) last = m;
  return last;
}

// Faction tokens that appear in kill-log player tags, grouped by side. One table for BOTH games —
// the parser and this resolver are shared with HLL: Vietnam, whose logs tag players US and NVA.
// The namespaces cannot collide (no HLL faction is called NVA), and one table means a token learned
// from either game's live log is learned for both. Anything unlisted → null, never a guess.
const ALLIED = new Set(["allies", "us", "gb", "rus", "sov", "cdn", "cw", "b8a"]);
const AXIS = new Set(["axis", "ger", "dak", "nva"]);

/** Map an HLL kill-log faction token ("US", "GER", "Allies", …) to a side, or null if unknown. */
export function sideFromTeam(token: string | null | undefined): MatchSide | null {
  const t = (token ?? "").trim().toLowerCase();
  if (ALLIED.has(t)) return "allies";
  if (AXIS.has(t)) return "axis";
  return null;
}

/**
 * The map a MATCH ENDED tail names, or null when it names none we can trust. Only the modern
 * backticked form is read — "`Kharkov Warfare` ALLIED (2 - 3) AXIS" — because that is the one
 * shape where the map's boundaries are unambiguous. This exists for the stale-whistle guard: a
 * backfilled log window can carry the END of a round the tracker never saw OPEN, and the one
 * honest way to notice is that the whistle names a different map than the round in progress.
 */
export function resultMapName(result: string): string | null {
  const m = /`([^`]+)`/.exec((result ?? "").trim());
  const name = m?.[1]?.trim();
  return name || null;
}

/** Loose map-name equality for the guard above: case and duplicate whitespace are presentation. */
export function sameMapName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/** Parse a MATCH ENDED result tail (and optional pre-extracted score) into a structured outcome. */
export function parseMatchResult(result: string, score?: string): MatchOutcome {
  const text = (result ?? "").trim();
  const upper = text.toUpperCase();
  const at = (re: RegExp) => upper.search(re);
  let alliedAt = at(/\bALLI(?:ED|ES)\b/);
  let axisAt = at(/\bAXIS\b/);
  // Vietnam vocabulary: the same engine writing US/NVA (or South/North) where HLL writes
  // ALLIED/AXIS. Checked only when NEITHER classic token is present, so an HLL line can never be
  // re-read ("ALLIED wins over US positions" stays an Allied line), and on word boundaries so
  // "OFFENSIVEUS" inside a layer id cannot match.
  if (alliedAt < 0 && axisAt < 0) {
    axisAt = at(/\bNVA\b|\bNORTH\b/);
    alliedAt = at(/\bUS\b|\bSOUTH\b/);
  }
  // BOTH sides present = the flanked scoreboard shape: the tokens label the numbers between them
  // and name no winner. Exactly one present = the legacy named-winner shape.
  const flanked = alliedAt >= 0 && axisAt >= 0;
  let winner: MatchSide | null = null;
  if (!flanked) {
    if (alliedAt >= 0) winner = "allies";
    else if (axisAt >= 0) winner = "axis";
  }

  let alliedScore: number | null = null;
  let axisScore: number | null = null;
  const m = (score ? lastScore(`(${score.trim()})`) : null) ?? lastScore(text);
  if (m) {
    let left = Number(m[1]);
    let right = Number(m[2]);
    // The numbers follow the labels: "ALLIED (2 - 3) AXIS" reads allied 2, axis 3 — and if the
    // game ever prints the sides the other way round, the token order says so.
    if (flanked && axisAt < alliedAt) [left, right] = [right, left];
    alliedScore = left;
    axisScore = right;
    // If no winner was named and the score is decisive, the score is the verdict.
    if (!winner && alliedScore !== axisScore) winner = alliedScore > axisScore ? "allies" : "axis";
  }
  return { winner, alliedScore, axisScore };
}
