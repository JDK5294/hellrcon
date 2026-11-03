/**
 * The weapon rollup pipeline: the pure fold that turns a round's kill stream into per-weapon
 * counts, and the sweep that walks unrolled rounds through it.
 *
 * Fold one finished round's kill events into per-player, per-WEAPON counts — both directions.
 * The weapon is the unit of record ("236 kills with the Gewehr" is the number people argue
 * about); its class is resolved here by the game's own classifier and stored beside it, so class
 * boards are just sums over weapons. Every kill in the log also names its VICTIM, so the same
 * fold fills the other side of the row: deaths TO that weapon — "who dies to artillery the most"
 * is as recorded as "who kills with it".
 *
 * Pure, so the pipeline is testable without a repo. Teamkills stay out of BOTH directions (the
 * kind filter drops them before either side is counted — a TK death is tracked as deathsByTk on
 * the round pages, not as a relationship with a weapon), and a kill with no weapon recorded has
 * nothing to count under and is skipped rather than guessed.
 */
export function weaponKillRollup(
  events: { kind: string; actorPlayerId: string | null; victimPlayerId: string | null; weapon: string | null }[],
  classify: (weapon: string) => { id: string },
): { playerId: string; weapon: string; classId: string; kills: number; deaths: number }[] {
  const counts = new Map<string, { playerId: string; weapon: string; classId: string; kills: number; deaths: number }>();
  const row = (playerId: string, weapon: string) => {
    const key = `${playerId}|${weapon}`;
    let r = counts.get(key);
    if (!r) { r = { playerId, weapon, classId: classify(weapon).id, kills: 0, deaths: 0 }; counts.set(key, r); }
    return r;
  };
  for (const e of events) {
    if (e.kind !== "evt.kill" || !e.weapon) continue;
    if (e.actorPlayerId) row(e.actorPlayerId, e.weapon).kills += 1;
    if (e.victimPlayerId) row(e.victimPlayerId, e.weapon).deaths += 1;
  }
  return [...counts.values()];
}

/** What the sweep needs of the repository — small on purpose, so a test can stand one up. */
export interface WeaponRollupRepo {
  matches: {
    pendingWeaponRollup: (limit: number) => Promise<{ id: string; serverId: string; game: string | null; startedAt: string; endedAt: string | null }[]>;
    saveWeaponRollup: (matchId: string, rows: { playerId: string; weapon: string; classId: string; kills: number; deaths: number }[]) => Promise<void>;
  };
  servers: { list: () => Promise<{ id: string; game: string }[]> };
  events: {
    window: (q: { serverId: string; kinds: string[]; from: string; to?: string; limit: number }) =>
      Promise<{ kind: string; actorPlayerId: string | null; victimPlayerId: string | null; weapon: string | null }[]>;
  };
}

/**
 * Visit finished rounds newest first, fold each one's kill stream through ITS game's classifier,
 * and stamp it done — including rounds with no kill log at all, which would otherwise be
 * re-scanned forever. Backfills all history by itself, one batch a minute.
 *
 * Both the read and the write are guarded per ROUND rather than per batch: whichever round fails,
 * it stamps nothing and is retried on the next sweep, while the rest of the batch still lands. A
 * single round that can never be saved must not stand in front of every round behind it.
 */
export async function sweepWeaponRollups(
  repo: WeaponRollupRepo,
  batch: number,
  classifyFor: (game: string) => (weapon: string) => { id: string },
): Promise<void> {
  const pending = await repo.matches.pendingWeaponRollup(batch);
  if (pending.length === 0) return;
  const servers = await repo.servers.list().catch(() => []);
  const gameOf = new Map(servers.map((s) => [s.id, s.game]));
  for (const m of pending) {
    // The window read: the paged one stops at 500 rows, and a round's kills run to thousands.
    const events = await repo.events.window({
      serverId: m.serverId,
      kinds: ["evt.kill"],
      from: m.startedAt,
      to: m.endedAt ? new Date(Date.parse(m.endedAt) + 1000).toISOString() : undefined,
      limit: 20_000,
    }).catch(() => null);
    if (!events) continue;
    const classify = classifyFor(m.game ?? gameOf.get(m.serverId) ?? "hll");
    await repo.matches.saveWeaponRollup(m.id, weaponKillRollup(events, classify)).catch(() => {});
  }
}
