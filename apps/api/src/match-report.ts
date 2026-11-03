/**
 * The full match report — everything the round's kill stream and stat rows can say, assembled
 * once, server-side, into the shape the Match page draws.
 *
 * The scoreboard alone under-uses what is already recorded: every kill carries a weapon and a
 * timestamp, every stat row carries the game's own score buckets, and the fold in streamer.ts
 * already turns the stream into per-player weapons, nemeses and streaks for the public surface.
 * This module reuses that fold and adds the round-level reads on top: which weapon classes each
 * side killed with, how the round FLOWED (kills per minute, per side), who kept meeting whom
 * (duels), and the superlatives worth a chip on the page (awards). All of it derives from data in
 * hand — a round whose kill log was never captured simply reports `complete: false` and the page
 * shows the scoreboard it always had.
 */
import { foldKillWindow, type KillEventLike } from "./streamer.js";

export interface ReportStatRow {
  playerId: string;
  playerName: string | null;
  side: "allies" | "axis" | null;
  kills: number;
  deaths: number;
  teamkills: number;
  combat: number;
  offense: number;
  defense: number;
  support: number;
  vehicleKills: number;
  slSeconds: number;
}

export interface ClassSplit {
  classId: string;
  label: string;
  allies: number;
  axis: number;
}

export interface TimelinePoint {
  /** minutes since round start, at the bucket's START. */
  minute: number;
  allies: number;
  axis: number;
}

export interface Duel {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  aKills: number;
  bKills: number;
}

export interface Award {
  id: string;
  label: string;
  /** the emoji the chip wears — decoration beside the label, never the only identity. */
  emoji: string;
  playerId: string;
  playerName: string;
  /** already formatted for display ("23", "4.6 K/D", "41m"). */
  value: string;
}

/** One moment of a player's round: seconds since kickoff, what happened (a kill, a death, or a
 *  team kill they made), who the other player was, and the weapon. A team kill is its own kind,
 *  never a "k": the charts climb on kills, and a team kill is not one. The player it hit takes it
 *  as a death like any other. A tuple, not an object — a busy player has hundreds of these and
 *  every key name would ride along each one. */
export type TimelineEvent = [secs: number, kind: "k" | "d" | "t", other: string | null, weapon: string | null];

/** One moment of a player's score buckets: seconds since kickoff, then their combat, offense,
 *  defense and support totals at that moment. Points come a minute apart while the scores move
 *  (match_score_series), so each total holds until the next point. */
export type ScorePoint = [secs: number, combat: number, offense: number, defense: number, support: number];

/** One player's slice of the fold, trimmed for the wire: dicts become sorted top-N lists. */
export interface PlayerDetail {
  /** the side their stat row recorded — what colours their line on the round's charts. */
  side: "allies" | "axis" | null;
  weapons: [string, number][];
  deathByWeapons: [string, number][];
  mostKilled: [string, number][];
  deathBy: [string, number][];
  /** the player's whole round in order — the drill-in's personal timeline. */
  timeline: TimelineEvent[];
  killsStreak: number;
  deathsWithoutKillStreak: number;
  longestLifeSecs: number | null;
  shortestLifeSecs: number | null;
  deathsByTk: number;
  /** Their score buckets through the round, where it was recorded (rounds before the recorder
   *  have none). */
  scores?: ScorePoint[];
}

/** One weapon's round, per side — the individual-weapon layer under the class split. */
export interface WeaponSplit {
  weapon: string;
  allies: number;
  axis: number;
}

export interface MatchReport {
  /** false = no kill events for this window (imported round, trimmed log): charts don't exist,
   *  and the page must say why rather than draw empty axes. */
  complete: boolean;
  classSplit: ClassSplit[];
  /** the round's most-used weapons by kills, per side — top slice only, the drill-ins carry the
   *  rest per player. */
  weaponSplit: WeaponSplit[];
  /** minutes each timeline bucket covers — 1 for a normal round, wider only to cap the points. */
  bucketMinutes: number;
  timeline: TimelinePoint[];
  duels: Duel[];
  awards: Award[];
  players: Record<string, PlayerDetail>;
}

/**
 * The report as the PUBLIC stats site consumes it: the same numbers, no internal ids anywhere.
 *
 * Players are keyed by display NAME — the identity the public scoreboard itself already runs on
 * (its nemesis dicts are name-keyed), and the only one that is publishable on every server: the
 * platform-id toggle governs ids, never names. Duels and awards drop their id fields the same way.
 */
export interface PublicPlayerReport {
  side: "allies" | "axis" | null;
  timeline: TimelineEvent[];
  killsStreak: number;
  deathsWithoutKillStreak: number;
  longestLifeSecs: number | null;
  shortestLifeSecs: number | null;
  deathsByTk: number;
  scores?: ScorePoint[];
}

export interface PublicMatchReport {
  complete: boolean;
  bucketMinutes: number;
  classSplit: ClassSplit[];
  weaponSplit: WeaponSplit[];
  timeline: TimelinePoint[];
  duels: { aName: string; bName: string; aKills: number; bKills: number }[];
  awards: { id: string; emoji: string; label: string; playerName: string; value: string }[];
  players: Record<string, PublicPlayerReport>;
  /** Names worn by more than one player this round, so held out of `players` (see below). The
   *  page names the reason on those rows rather than leaving an unexplained gap. */
  sharedNames: string[];
}

/** Strip a report for the public wire. `nameOf` resolves an internal player id to a display name;
 *  a player it cannot name is withheld entirely — the public-stats rule for unresolvable rows.
 *
 *  Nothing stops two people wearing the SAME name in one round, and this map is keyed by name
 *  because internal ids must never cross the public wire. So a shared name is not a key: both
 *  players are withheld rather than one of them being published under the other's row, which is
 *  what a last-writer-wins map would do — the scoreboard would drill into someone else's round
 *  and neither the reader nor we could tell. The staff match page, which has real ids, still
 *  shows both. */
export function publicMatchReport(r: MatchReport, nameOf: (playerId: string) => string | null): PublicMatchReport {
  // Keyed by what players call themselves, so it inherits nothing: a player named "__proto__" is a
  // row like any other, not the object's prototype.
  const players: Record<string, PublicPlayerReport> = Object.create(null);
  const claims = new Map<string, number>();
  for (const id of Object.keys(r.players)) {
    const name = nameOf(id);
    if (name) claims.set(name, (claims.get(name) ?? 0) + 1);
  }
  for (const [id, d] of Object.entries(r.players)) {
    const name = nameOf(id);
    if (!name || (claims.get(name) ?? 0) > 1) continue;
    players[name] = {
      side: d.side,
      timeline: d.timeline,
      killsStreak: d.killsStreak,
      deathsWithoutKillStreak: d.deathsWithoutKillStreak,
      longestLifeSecs: d.longestLifeSecs,
      shortestLifeSecs: d.shortestLifeSecs,
      deathsByTk: d.deathsByTk,
      ...(d.scores ? { scores: d.scores } : {}),
    };
  }
  return {
    complete: r.complete,
    bucketMinutes: r.bucketMinutes,
    classSplit: r.classSplit,
    weaponSplit: r.weaponSplit,
    timeline: r.timeline,
    duels: r.duels.map(({ aName, bName, aKills, bKills }) => ({ aName, bName, aKills, bKills })),
    awards: r.awards.map(({ id, emoji, label, playerName, value }) => ({ id, emoji, label, playerName, value })),
    players,
    sharedNames: [...claims.entries()].filter(([, n]) => n > 1).map(([name]) => name).sort(),
  };
}

const top = (dict: Record<string, number>, n: number): [string, number][] =>
  Object.entries(dict).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

const fmtMins = (secs: number): string => {
  const m = Math.floor(secs / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${secs % 60}s`;
};

export function buildMatchReport(input: {
  events: KillEventLike[];
  stats: ReportStatRow[];
  startedAt: string;
  endedAt: string | null;
  /** the game's weapon classifier — class id + label for a raw weapon string. */
  classify: (weapon: string) => { id: string; label: string };
  /** each player's score series by internal id, five ints a point (repo.matches.scoreSeries). */
  scoreSeries?: Map<string, number[]>;
}): MatchReport {
  const { events, stats, startedAt } = input;
  const sideOf = new Map(stats.map((s) => [s.playerId, s.side]));
  const nameOf = new Map(stats.map((s) => [s.playerId, s.playerName || "[No Name]"]));
  const kills = events.filter((e) => e.kind === "evt.kill");
  const startMs = Date.parse(startedAt);

  // --- Kills by weapon class, per side. The side is the KILLER's, read from the stat rows the
  // same response carries — a killer with no row (joined and left between stat folds) still
  // counts toward the class total under whichever side stays unknown, so the split can be short
  // of the total; the page prints both numbers and the truth survives.
  const byClass = new Map<string, ClassSplit>();
  for (const e of kills) {
    if (!e.weapon) continue;
    const c = input.classify(e.weapon);
    let row = byClass.get(c.id);
    if (!row) { row = { classId: c.id, label: c.label, allies: 0, axis: 0 }; byClass.set(c.id, row); }
    const side = e.actorPlayerId ? sideOf.get(e.actorPlayerId) : null;
    if (side === "allies") row.allies += 1;
    else if (side === "axis") row.axis += 1;
  }
  const classSplit = [...byClass.values()]
    .filter((c) => c.allies + c.axis > 0)
    .sort((a, b) => b.allies + b.axis - (a.allies + a.axis));

  // --- The same split one level finer: individual weapons. Top 12 by total — the round's story
  // weapons — with the same killer's-side attribution and the same honesty about unknown sides.
  const byWeapon = new Map<string, WeaponSplit>();
  for (const e of kills) {
    if (!e.weapon) continue;
    let row = byWeapon.get(e.weapon);
    if (!row) { row = { weapon: e.weapon, allies: 0, axis: 0 }; byWeapon.set(e.weapon, row); }
    const side = e.actorPlayerId ? sideOf.get(e.actorPlayerId) : null;
    if (side === "allies") row.allies += 1;
    else if (side === "axis") row.axis += 1;
  }
  const weaponSplit = [...byWeapon.values()]
    .filter((w) => w.allies + w.axis > 0)
    .sort((a, b) => b.allies + b.axis - (a.allies + a.axis) || a.weapon.localeCompare(b.weapon))
    .slice(0, 12);

  // --- The round's flow: kills per bucket per side. One-minute buckets up to ~48 points, then
  // wider — a chart with 200 ticks reads as noise, and a 3-hour offensive deserves 4-minute bars
  // more than it deserves precision nobody can see.
  const lastMs = kills.length ? Math.max(...kills.map((e) => Date.parse(e.ts))) : startMs;
  const totalMin = Math.max(1, Math.ceil((lastMs - startMs) / 60000));
  const bucketMinutes = Math.max(1, Math.ceil(totalMin / 48));
  const buckets = Math.ceil(totalMin / bucketMinutes);
  const timeline: TimelinePoint[] = Array.from({ length: buckets }, (_, i) => ({ minute: i * bucketMinutes, allies: 0, axis: 0 }));
  for (const e of kills) {
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((Date.parse(e.ts) - startMs) / 60000 / bucketMinutes)));
    const side = e.actorPlayerId ? sideOf.get(e.actorPlayerId) : null;
    if (side === "allies") timeline[i]!.allies += 1;
    else if (side === "axis") timeline[i]!.axis += 1;
  }

  // --- Duels: the pairs who kept meeting, both directions summed, ranked by how much of the
  // round was theirs. Ordered inside the pair so A is whoever got the better of it.
  const pair = new Map<string, { aId: string; bId: string; aKills: number; bKills: number }>();
  for (const e of kills) {
    if (!e.actorPlayerId || !e.victimPlayerId) continue;
    const [x, y] = [e.actorPlayerId, e.victimPlayerId].sort();
    const key = `${x}|${y}`;
    let d = pair.get(key);
    if (!d) { d = { aId: x!, bId: y!, aKills: 0, bKills: 0 }; pair.set(key, d); }
    if (e.actorPlayerId === d.aId) d.aKills += 1; else d.bKills += 1;
  }
  const duels: Duel[] = [...pair.values()]
    .filter((d) => d.aKills + d.bKills >= 4)
    .sort((a, b) => b.aKills + b.bKills - (a.aKills + a.bKills))
    .slice(0, 8)
    .map((d) => {
      const flip = d.bKills > d.aKills;
      const [aId, bId, aKills, bKills] = flip ? [d.bId, d.aId, d.bKills, d.aKills] : [d.aId, d.bId, d.aKills, d.bKills];
      return { aId, bId, aKills, bKills, aName: nameOf.get(aId) ?? "[No Name]", bName: nameOf.get(bId) ?? "[No Name]" };
    });

  // --- The fold: per-player weapons, nemeses, streaks and life stats — the same code the public
  // scoreboard runs, so this page and the community's tools can never disagree about a streak.
  const folded = foldKillWindow(events, startedAt);
  const players: Record<string, PlayerDetail> = {};
  for (const [id, l] of folded) {
    players[id] = {
      side: sideOf.get(id) ?? null,
      weapons: top(l.weapons, 10),
      deathByWeapons: top(l.deathByWeapons, 6),
      mostKilled: top(l.mostKilled, 5),
      deathBy: top(l.deathBy, 5),
      // The fold already walked the stream in order, so encounters come out sorted.
      timeline: l.encounters.map((e): TimelineEvent => [e.ts, e.action === "death" ? "d" : e.teamkill ? "t" : "k", e.player_name, e.weapon]),
      killsStreak: l.killsStreak,
      deathsWithoutKillStreak: l.deathsWithoutKillStreak,
      longestLifeSecs: l.longestLifeSecs,
      shortestLifeSecs: l.shortestLifeSecs,
      deathsByTk: l.deathsByTk,
    };
  }
  // Score series ride on the same lines. A player with a series and no kill or death has a line of
  // their own: a medic's round is all support and no kills, and is still worth a chart.
  for (const [id, flat] of input.scoreSeries ?? []) {
    const scores: ScorePoint[] = [];
    for (let i = 0; i + 4 < flat.length; i += 5) scores.push([flat[i]!, flat[i + 1]!, flat[i + 2]!, flat[i + 3]!, flat[i + 4]!]);
    if (!scores.length) continue;
    players[id] ??= {
      side: sideOf.get(id) ?? null,
      weapons: [], deathByWeapons: [], mostKilled: [], deathBy: [], timeline: [],
      killsStreak: 0, deathsWithoutKillStreak: 0, longestLifeSecs: null, shortestLifeSecs: null, deathsByTk: 0,
    };
    players[id]!.scores = scores;
  }

  // --- Awards. Computed, never stored: each names the single row that tops a stat worth telling
  // the room about, and stays away when the round has nothing to say (no vehicle kills = no
  // tanker award, rather than a chip on somebody with zero).
  const awards: Award[] = [];
  const give = (id: string, emoji: string, label: string, pick: (s: ReportStatRow) => number, fmt: (n: number, s: ReportStatRow) => string, min = 1) => {
    let best: ReportStatRow | null = null;
    for (const s of stats) {
      const v = pick(s);
      if (v < min) continue;
      if (!best || v > pick(best) || (v === pick(best) && s.kills > best.kills)) best = s;
    }
    if (best) awards.push({ id, emoji, label, playerId: best.playerId, playerName: best.playerName || "[No Name]", value: fmt(pick(best), best) });
  };
  give("kills", "💀", "Most kills", (s) => s.kills, (n) => String(n));
  give("kd", "⚖️", "Best K/D", (s) => (s.kills >= 10 ? s.kills / Math.max(1, s.deaths) : 0), (n) => n.toFixed(1), 0.01);
  const streakOf = (s: ReportStatRow) => players[s.playerId]?.killsStreak ?? 0;
  give("streak", "🔥", "Longest killstreak", streakOf, (n) => String(n), 5);

  // First blood: the round's opening kill, straight off the stream — a moment, not a total, so it
  // bypasses the stat-row picker. Best burst: the most kills anyone packed into a 30-second
  // stretch, at least three — two kills half a minute apart is a Tuesday, not a burst.
  const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const opener = kills.filter((e) => e.actorPlayerId).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))[0];
  if (opener?.actorPlayerId) {
    const t = Math.max(0, Math.round((Date.parse(opener.ts) - startMs) / 1000));
    awards.push({ id: "firstblood", emoji: "🩸", label: "First blood", playerId: opener.actorPlayerId, playerName: nameOf.get(opener.actorPlayerId) ?? opener.actorName ?? "[No Name]", value: clock(t) });
  }
  const killSecs = new Map<string, number[]>();
  for (const e of kills) {
    if (!e.actorPlayerId) continue;
    let arr = killSecs.get(e.actorPlayerId);
    if (!arr) { arr = []; killSecs.set(e.actorPlayerId, arr); }
    arr.push((Date.parse(e.ts) - startMs) / 1000);
  }
  let burst: { playerId: string; count: number } | null = null;
  for (const [id, secs] of killSecs) {
    secs.sort((a, b) => a - b);
    let lo = 0;
    for (let hi = 0; hi < secs.length; hi++) {
      while (secs[hi]! - secs[lo]! > 30) lo++;
      const count = hi - lo + 1;
      if (count >= 3 && (!burst || count > burst.count)) burst = { playerId: id, count };
    }
  }
  if (burst) awards.push({ id: "burst", emoji: "💥", label: "Best burst", playerId: burst.playerId, playerName: nameOf.get(burst.playerId) ?? "[No Name]", value: `${burst.count} in 30s` });

  give("support", "🧰", "Most support", (s) => s.support, (n) => n.toLocaleString(), 100);
  give("defense", "🛡", "Defense anchor", (s) => s.defense, (n) => n.toLocaleString(), 100);
  give("vehicles", "🚜", "Vehicle hunter", (s) => s.vehicleKills, (n) => String(n), 2);
  give("sl", "🎖", "Squad-lead time", (s) => s.slSeconds, (n) => fmtMins(n), 10 * 60);
  give("tks", "🤦", "Friendly fire", (s) => s.teamkills, (n) => String(n), 3);
  give("magnet", "🧲", "Most deaths", (s) => s.deaths, (n) => String(n), 15);

  return { complete: kills.length > 0, classSplit, weaponSplit, bucketMinutes, timeline, duels, awards, players };
}

/** One minute mark of a round: how many players each side had on it. */
export interface HeadcountPoint {
  /** minutes since round start — the mark this reading stands for. */
  minute: number;
  /** players on the side at that mark. Null = no sample near enough to say: a gap, never 0. */
  allies: number | null;
  axis: number | null;
}

/** The longest stretch of a round the headcount reads — a runaway offensive is ~3 hours, so six
 *  is room to spare while keeping one page load to a few hundred samples. */
export const HEADCOUNT_MAX_MINUTES = 360;

/**
 * How far a sample may sit from a minute mark and still stand for it. The worker takes a roster
 * sample once a minute, but on its poll loop — each lands a second or two past the last, so they
 * drift across the minute marks. Bucketing by whole minute would drop an empty minute into the
 * line every half hour or so for nothing more than that drift; reading the nearest sample does
 * not. A gap shows where the samples really stop — a mark with none within 45 seconds, as when
 * the worker restarts or cannot read the server.
 */
const HEADCOUNT_REACH_MS = 45_000;

/**
 * Players on each side, minute by minute through a round, from the worker's roster samples.
 *
 * Only what the samples measured: the round's own window (a sample from before the start or after
 * the end was taken on another round or an end screen), a side the sample did not count reads as a
 * gap, and a round with no samples — imported, or played while the worker was not watching —
 * returns nothing, so the page can say so instead of drawing a flat zero. A round still running
 * ends at its latest sample.
 */
export function headcountTimeline(
  samples: { ts: string; composition?: { bySide?: Record<string, { players?: number } | undefined> } | null }[],
  startedAt: string,
  endedAt: string | null,
): HeadcountPoint[] {
  const startMs = Date.parse(startedAt);
  const closedMs = endedAt ? Date.parse(endedAt) : Infinity;
  if (!Number.isFinite(startMs) || Number.isNaN(closedMs)) return [];
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // The round's own samples only: one from the end screen after it must not stand for its last minute.
  const pts = samples
    .map((s) => ({ ms: Date.parse(s.ts), allies: count(s.composition?.bySide?.allies?.players), axis: count(s.composition?.bySide?.axis?.players) }))
    .filter((p) => p.ms >= startMs && p.ms <= closedMs)
    .sort((a, b) => a.ms - b.ms);
  if (pts.length === 0) return [];
  const endMs = Number.isFinite(closedMs) ? closedMs : pts[pts.length - 1]!.ms;
  const last = Math.min(HEADCOUNT_MAX_MINUTES, Math.floor((endMs - startMs) / 60_000));
  const out: HeadcountPoint[] = [];
  let next = 0; // the first sample after the mark
  for (let minute = 0; minute <= last; minute++) {
    const mark = startMs + minute * 60_000;
    while (next < pts.length && pts[next]!.ms <= mark) next++;
    const before = next > 0 ? pts[next - 1]! : null;
    const after = next < pts.length ? pts[next]! : null;
    // Whichever sample is nearer the mark; a tie goes to the later one.
    const near = !before ? after : !after ? before : after.ms - mark <= mark - before.ms ? after : before;
    const fits = near !== null && Math.abs(near.ms - mark) <= HEADCOUNT_REACH_MS;
    out.push({ minute, allies: fits ? near.allies : null, axis: fits ? near.axis : null });
  }
  return out;
}
