/**
 * Reading a player's team switches.
 *
 * The game writes every team change as a TEAMSWITCH line, and Unassigned ("None" in the log) always
 * sits between the two sides: joining at connect is `None > Allies`, and a side swap is TWO lines,
 * `Allies > None` then `None > Axis`. So a single line never says "he swapped sides" — that only
 * shows once the join is set against the side the player was last on this round. A player who drops
 * to Unassigned and comes back to the same side has not swapped; one who lands on the other side
 * has, whether or not the game wrote the "left" line first (a reconnect, say), and a direct
 * `Allies > Axis`, should the game ever write one, is a swap on its own.
 *
 * Pure and game-agnostic: the parser describes each line on its own, ingest replays a player's
 * lines through the round to name the swaps, and the importer does the same for history.
 */

/** The data a team-switch event carries. (A type, not an interface, so it is an event's data record.) */
export type TeamSwitchData = {
  /** the team as the log names it — "Allies", "Axis", or "None" for Unassigned. */
  from: string;
  to: string;
  /** set on the join that completes a side swap: the side the player came from. */
  swapFrom?: string;
  /** set with swapFrom: the player's side swaps this round, this one included. */
  swapCount?: number;
  /** the line in words: "joined Allies", "left Allies", "switched sides Allies → Axis". */
  change: string;
};

/** What one player's switches so far this round add up to. */
export interface TeamSwitchState {
  /** the side the player was last on this round (null: none yet). */
  lastSide: string | null;
  /** side swaps so far this round. */
  swaps: number;
}

export const NO_SWITCHES: TeamSwitchState = { lastSide: null, swaps: 0 };

/** Unassigned, as the log writes it ("None"), or a blank team. */
export function isUnassigned(team: string | null | undefined): boolean {
  const t = team?.trim().toLowerCase();
  return !t || t === "none" || t === "unassigned";
}

const sideOf = (team: string): string | null => (isUnassigned(team) ? null : team.trim());
const sameSide = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The side a switch came from when it landed on the other one, else "" — no swap. */
function swapOrigin(from: string, to: string, swapFrom: string): string {
  const came = swapFrom || (!isUnassigned(from) ? from : "");
  return !isUnassigned(to) && came && !sameSide(came, to) ? came : "";
}

/**
 * One line, read against what the player's earlier lines this round add up to: the data to store
 * with it, and the state the next line is read against.
 */
export function describeTeamSwitch(step: { from: string; to: string }, before: TeamSwitchState = NO_SWITCHES): { data: TeamSwitchData; after: TeamSwitchState } {
  const from = step.from.trim();
  const to = step.to.trim();
  const fromSide = sideOf(from);
  const toSide = sideOf(to);
  if (toSide) {
    // The side they came from: the one this line names, else the one they were last on.
    const came = fromSide ?? before.lastSide;
    if (came && !sameSide(came, toSide)) {
      const swaps = before.swaps + 1;
      return {
        data: { from, to, swapFrom: came, swapCount: swaps, change: `switched sides ${came} → ${toSide}` },
        after: { lastSide: toSide, swaps },
      };
    }
    return { data: { from, to, change: `joined ${toSide}` }, after: { lastSide: toSide, swaps: before.swaps } };
  }
  if (fromSide) return { data: { from, to, change: `left ${fromSide}` }, after: { lastSide: fromSide, swaps: before.swaps } };
  return { data: { from, to, change: "unassigned" }, after: before };
}

/**
 * A whole history of switches read through its rounds at once — what ingest does poll by poll,
 * for a history already in hand (an archive import). Each row is read against its player's
 * earlier switches in the same round: a round runs between round edges (match starts and ends,
 * epoch ms) and never across a gap of more than `lookbackMs` in that player's switches (a missed
 * or trimmed edge is not one endless round). `who` names whose round it is — the player when
 * known, else the name. Within one millisecond-stamp a leave reads before a join, as ingest
 * orders them. Returns each row's data, in the rows' own order.
 */
export function describeSwitchHistory(rows: readonly { ts: number; who: string; step: { from: string; to: string } }[], edges: readonly number[], lookbackMs: number): TeamSwitchData[] {
  const out: TeamSwitchData[] = new Array(rows.length);
  const walk = walkSwitchHistory(rows.length, {
    ts: (i) => rows[i]!.ts, who: (i) => rows[i]!.who, from: (i) => rows[i]!.step.from, to: (i) => rows[i]!.step.to,
  }, edges, lookbackMs);
  for (const [i, data] of walk) out[i] = data;
  return out;
}

/** How a switch history is read by index — whatever the caller keeps it in. */
export interface SwitchHistoryColumns {
  ts(i: number): number;
  who(i: number): string;
  from(i: number): string;
  to(i: number): string;
}

/**
 * describeSwitchHistory's reading of `n` rows read by INDEX, yielding each row's data in time order
 * as `[index, data]`. The same reading, for a history too long to hold as one object per row: an
 * archive import walks millions of switches from compact columns, and writes each result as it
 * arrives rather than collecting them all.
 */
export function* walkSwitchHistory(n: number, rows: SwitchHistoryColumns, edges: readonly number[], lookbackMs: number): Generator<[number, TeamSwitchData]> {
  const rank = (i: number) => {
    const from = rows.from(i), to = rows.to(i);
    return !isUnassigned(from) && isUnassigned(to) ? 0 : isUnassigned(from) && !isUnassigned(to) ? 2 : 1;
  };
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => rows.ts(a) - rows.ts(b) || rank(a) - rank(b) || a - b);
  const sortedEdges = [...edges].filter(Number.isFinite).sort((a, b) => a - b);
  const state = new Map<string, { round: number; lastTs: number; s: TeamSwitchState }>();
  let e = 0;
  for (const i of order) {
    const ts = rows.ts(i);
    while (e < sortedEdges.length && sortedEdges[e]! <= ts) e++;
    const who = rows.who(i);
    const cur = state.get(who);
    const prior = cur && cur.round === e && ts - cur.lastTs <= lookbackMs ? cur.s : NO_SWITCHES;
    const r = describeTeamSwitch({ from: rows.from(i), to: rows.to(i) }, prior);
    state.set(who, { round: e, lastTs: ts, s: r.after });
    yield [i, r.data];
  }
}

/** Replay a player's lines this round, oldest first. */
export function foldTeamSwitches(steps: Iterable<{ from: string; to: string }>, start: TeamSwitchState = NO_SWITCHES): TeamSwitchState {
  let state = start;
  for (const step of steps) state = describeTeamSwitch(step, state).after;
  return state;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/**
 * A stored switch in words, as every surface shows it after the player's name: "joined Allies",
 * "left Allies (unassigned)", "switched sides Allies → Axis", and "… (2nd this round)" from the
 * second swap on. Built from the teams rather than the stored sentence, so a row that only has
 * its teams back reads the same; null when the row carries nothing to read (the caller says
 * "switched team"). Rules match against this same text, so what staff read in the log is what
 * a rule's match can name.
 *
 * The panel (apps/panel/lib/eventKinds.ts) and the Discord relay (apps/discord/src/format.ts)
 * import no workspace packages, so each keeps a copy — their tests hold both to this one.
 */
export function teamSwitchText(data: unknown): string | null {
  const d = (data ?? null) as { from?: unknown; to?: unknown; swapFrom?: unknown; swapCount?: unknown; change?: unknown } | null;
  if (!d) return null;
  const from = str(d.from), to = str(d.to);
  if (!from && !to) return str(d.change) || null;
  const came = swapOrigin(from, to, str(d.swapFrom));
  if (came) {
    const n = typeof d.swapCount === "number" ? d.swapCount : 0;
    return `switched sides ${came} → ${to}${n >= 2 ? ` (${ordinal(n)} this round)` : ""}`;
  }
  if (!isUnassigned(to)) return `joined ${to}`;
  if (!isUnassigned(from)) return `left ${from} (unassigned)`;
  return "unassigned";
}

/**
 * Is a stored switch a side swap — did the player land on the other side? The join that completes
 * Allies → None → Axis is one, and so is a direct Allies → Axis; dropping to Unassigned, joining a
 * side at connect, and coming back to the side they left are not. This is all a rule's team-switch
 * trigger hears, read off the teams exactly as teamSwitchText reads them, so what the Game log
 * shows as "switched sides" is what sets a rule off. A row with no teams to read is no swap.
 */
export function isSideSwap(data: unknown): boolean {
  const d = (data ?? null) as { from?: unknown; to?: unknown; swapFrom?: unknown } | null;
  return d ? swapOrigin(str(d.from), str(d.to), str(d.swapFrom)) !== "" : false;
}

/**
 * The two teams of a TEAMSWITCH line's body ("TEAMSWITCH Name (Allies > None)"), or null. Anchored
 * on the LAST bracket, so a name that carries its own brackets ("Bob (TTV)") stays whole.
 */
export const TEAMSWITCH_BODY_RE = /^TEAMSWITCH\s+(.+?)\s*\(([^()]*?)\s*>\s*([^()]*?)\)\s*$/i;
export function parseTeamSwitchBody(body: string): { name: string; from: string; to: string } | null {
  const m = TEAMSWITCH_BODY_RE.exec(body.trim());
  if (!m || !m[1]?.trim()) return null;
  return { name: m[1].trim(), from: (m[2] ?? "").trim() || "None", to: (m[3] ?? "").trim() || "None" };
}
