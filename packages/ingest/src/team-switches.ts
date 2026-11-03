/**
 * Team switches, read the way a person reads them: whose they are, and which ones were side swaps.
 *
 * The game's TEAMSWITCH line names the player but carries no id, and a swap is two lines with
 * Unassigned between them (`Allies > None`, `None > Axis` — see @app/games team-switch.ts). So
 * before a batch is stored, its switch lines are:
 *
 *   - LINKED to a player by name: the players that name could mean are every id another line of
 *     the same batch pairs with it (a CONNECTED, a kill, a chat line) together with every player
 *     on this server under it right now. Only ever when that is exactly one player — players
 *     share names, and an unlinked switch is far better than one filed under the wrong person
 *     (whom a rule would then message, punish or kick).
 *   - DESCRIBED against that player's earlier switches this round: the round's stored switches
 *     (a swap's two lines often land in different polls) and then the batch's own, in order. The
 *     join onto the other side is the swap, and carries the side it came from and the count.
 *     A linked switch is read against that player's own switches, never against another player's
 *     under the same name. An unlinked one is read against the other unlinked ones under its name
 *     only when nobody on record answers to that name; under a name several players answer to
 *     (or one that could not be checked) each switch is read on its own.
 *
 * "This round" starts at the latest round edge on record before the batch's first switch — the
 * open match's start, the last MATCH START or MATCH ENDED line — and never more than
 * ROUND_LOOKBACK_MS before that switch, so a round whose start was missed (the poller down across
 * a map change) is not read as yesterday's. Measured from the lines, not the clock: a window read
 * late is read against its own round.
 *
 * It runs before the insert because events are stored once and never rewritten — and it must not
 * cost the batch: anything it cannot read leaves the lines as the parser described them, unlinked,
 * and is reported back as a warning; the batch and everything that follows it go on as normal.
 */
import type { EvtRow, Repository } from "@app/db";
import { describeTeamSwitch, isUnassigned, parseTeamSwitchBody, NO_SWITCHES, type TeamSwitchData, type TeamSwitchState } from "@app/games";

export const TEAM_SWITCH_KIND = "evt.player.teamSwitched";
/** The furthest back a player's switches still count as this round's, whatever the round edges
 *  on record say. Longer than any real round; a round "open" for longer missed its boundary. */
export const ROUND_LOOKBACK_MS = 3 * 60 * 60_000;
/** The lines that end one round's reading and start the next. */
export const ROUND_EDGE_KINDS = ["evt.match.started", "evt.match.ended"];
const PAGE = 500;
/** A round's switches are a few hundred; this bounds a pathological one. */
const MAX_PAGES = 40;

/** One parsed line as ingest holds it before storing. */
export interface ParsedLine {
  dedupeKey: string;
  evt: { kind: string; ts: string } | null;
  f: { playerId?: string; playerName?: string; victimId?: string; victimName?: string; data?: Record<string, unknown> | null };
}

export interface SwitchEnrichment {
  /** dedupeKey → the player the switch was linked to. */
  linked: Map<string, string>;
  /** dedupeKey → the switch described against the round. */
  data: Map<string, TeamSwitchData>;
  /** what could not be read, if anything — a warning, never the batch's failure. */
  errors: string[];
}

const nameOf = (s: string | null | undefined) => (s ?? "").trim();
/** Whose round a switch is read in: its player's when it is linked, else its name's. */
const stateKey = (playerId: string | null | undefined, name: string) => (playerId ? `id:${playerId}` : `name:${name}`);

/** A switch's two teams: as stored, else read back off the original line (rows stored before the
 *  teams were kept). Null for anything that cannot be read (an imported row with no line text). */
export function switchStepOf(row: Pick<EvtRow, "data" | "dedupeKey">): { from: string; to: string } | null {
  const d = row.data as { from?: unknown; to?: unknown } | null;
  if (d && typeof d.from === "string" && typeof d.to === "string") return { from: d.from, to: d.to };
  const body = (row.dedupeKey ?? "").replace(/^\d+\|/, "");
  const m = parseTeamSwitchBody(body);
  return m ? { from: m.from, to: m.to } : null;
}

/**
 * Within one second, a leave comes before a join. The log stamps whole seconds and some adapters
 * deliver it newest first, so `None > Axis` can arrive ahead of the `Allies > None` it follows;
 * read that way the swap would be missed and the late leave would set the side back. Only the
 * switch lines are put in this order — ingest's own sort is untouched.
 */
export function switchRank(step: { from: string; to: string }): number {
  if (!isUnassigned(step.from) && isUnassigned(step.to)) return 0; // left a side
  if (isUnassigned(step.from) && !isUnassigned(step.to)) return 2; // joined a side
  return 1;
}

export async function enrichTeamSwitches(repo: Repository, serverId: string, parsed: ParsedLine[], idByPlatform: Map<string, string>): Promise<SwitchEnrichment> {
  const out: SwitchEnrichment = { linked: new Map(), data: new Map(), errors: [] };
  const switches = parsed
    .filter((p) => p.evt?.kind === TEAM_SWITCH_KIND && nameOf(p.f.playerName))
    .map((p) => ({ ...p, name: nameOf(p.f.playerName), step: switchStepOf({ data: p.f.data ?? null, dedupeKey: p.dedupeKey }) }));
  if (!switches.length) return out;
  const names = new Set(switches.map((s) => s.name));

  // ---- link ----
  const batchIds = new Map<string, Set<string>>();
  const mention = (name: string | undefined, platformId: string | undefined) => {
    const id = platformId ? idByPlatform.get(platformId) : undefined;
    const n = nameOf(name);
    if (!id || !n || !names.has(n)) return;
    (batchIds.get(n) ?? batchIds.set(n, new Set()).get(n)!).add(id);
  };
  for (const p of parsed) { mention(p.f.playerName, p.f.playerId); mention(p.f.victimName, p.f.victimId); }
  // Who is on the server under each name — read even for a name the batch already pairs with an
  // id: a kill by one Bob says nothing about which Bob swapped, while another one is online.
  // (A player who connects in this very batch has no open session yet; the batch's id is theirs.)
  let online: Map<string, Set<string>> | null = null;
  try {
    const open = await repo.sessions.openOnServer(serverId);
    const players = open.size ? await repo.players.findByIds([...open.keys()]) : [];
    online = new Map();
    for (const pl of players) {
      const n = nameOf(pl.name);
      if (names.has(n)) (online.get(n) ?? online.set(n, new Set()).get(n)!).add(pl.id);
    }
  } catch (err) {
    out.errors.push(`team switches could not be linked to players on the server: ${(err as Error).message}`);
  }
  // A name more than one player answers to — or one we could not check — is AMBIGUOUS: its
  // switches are neither linked nor read against each other, since any two of them may be two
  // different players. Only a name nobody on record answers to is read as one unknown player.
  const ambiguous = new Set<string>();
  const linkFor = (name: string): string | null => {
    if (!online) { ambiguous.add(name); return null; }
    const ids = new Set([...(batchIds.get(name) ?? []), ...(online.get(name) ?? [])]);
    if (ids.size > 1) ambiguous.add(name);
    return ids.size === 1 ? [...ids][0]! : null;
  };
  for (const s of switches) {
    const id = linkFor(s.name);
    if (id) out.linked.set(s.dedupeKey, id);
  }

  // ---- describe ----
  const readable = switches.filter((s) => s.step);
  if (!readable.length) return out;
  const batchKeys = new Set(parsed.map((p) => p.dedupeKey));
  const linkedIds = new Set(out.linked.values());
  // Round edges inside this batch: a switch at or after one belongs to the next round.
  const batchEdges = parsed.filter((p) => p.evt && ROUND_EDGE_KINDS.includes(p.evt.kind)).map((p) => Date.parse(p.evt!.ts)).sort((a, b) => a - b);
  const roundOf = (tsMs: number) => batchEdges.filter((t) => t <= tsMs).length;

  // The round so far, per player (per name for unlinked lines) — read against the batch's lines
  // before its first round edge.
  const before = new Map<string, TeamSwitchState>();
  try {
    const at = (ts: string | null | undefined) => { const n = ts ? Date.parse(ts) : NaN; return Number.isFinite(n) ? n : -Infinity; };
    const firstMs = Math.min(...readable.map((r) => at(r.evt?.ts)).filter(Number.isFinite));
    const open = await repo.matches.getOpen(serverId);
    // The last edge at or before the first switch (`to` is exclusive): a start in the same second
    // as a switch opens that switch's round, as it does inside the batch.
    const edge = await repo.events.query({ serverId, kinds: ROUND_EDGE_KINDS, to: new Date(firstMs + 1).toISOString(), limit: 1 });
    const openAt = at(open?.startedAt);
    const from = new Date(Math.max(firstMs - ROUND_LOOKBACK_MS, openAt <= firstMs ? openAt : -Infinity, at(edge[0]?.ts))).toISOString();
    const rows: EvtRow[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await repo.events.query({ serverId, kinds: [TEAM_SWITCH_KIND], from, limit: PAGE, offset: page * PAGE });
      rows.push(...got);
      if (got.length < PAGE) break;
    }
    const history = rows
      // A linked row counts for its player; an unlinked one for its name — and a row linked to
      // somebody this batch is not about (another player under the same name) for nobody here.
      .filter((r) => !(r.dedupeKey && batchKeys.has(r.dedupeKey)) && (r.actorPlayerId ? linkedIds.has(r.actorPlayerId) : names.has(nameOf(r.actorName)) && !ambiguous.has(nameOf(r.actorName))))
      .map((r) => ({ key: stateKey(r.actorPlayerId, nameOf(r.actorName)), ts: Date.parse(r.ts), step: switchStepOf(r) }))
      .filter((r): r is { key: string; ts: number; step: { from: string; to: string } } => !!r.step)
      .sort((a, b) => a.ts - b.ts || switchRank(a.step) - switchRank(b.step));
    for (const h of history) before.set(h.key, describeTeamSwitch(h.step, before.get(h.key) ?? NO_SWITCHES).after);
  } catch (err) {
    out.errors.push(`team switches could not be read against the round so far: ${(err as Error).message}`);
  }

  const ordered = readable
    .map((s) => ({ ...s, tsMs: Date.parse(s.evt!.ts), playerId: out.linked.get(s.dedupeKey) ?? null }))
    .sort((a, b) => a.tsMs - b.tsMs || switchRank(a.step!) - switchRank(b.step!));
  const state = new Map<string, { round: number; s: TeamSwitchState }>();
  for (const sw of ordered) {
    // An ambiguous name's switch is read on its own: "joined Axis", never a swap off a namesake's side.
    const key = !sw.playerId && ambiguous.has(sw.name) ? `line:${sw.dedupeKey}` : stateKey(sw.playerId, sw.name);
    const round = roundOf(sw.tsMs);
    const cur = state.get(key);
    // Never the unlinked rows under the name for a linked player (nor, above, for an ambiguous
    // one): they may be somebody else's, and a swap read off somebody else's side is a rule acting
    // on a player who never swapped. A swap missed is the lesser error.
    const prior = cur && cur.round === round ? cur.s : round === 0 ? before.get(key) ?? NO_SWITCHES : NO_SWITCHES;
    const r = describeTeamSwitch(sw.step!, prior);
    out.data.set(sw.dedupeKey, r.data);
    state.set(key, { round, s: r.after });
  }
  return out;
}
