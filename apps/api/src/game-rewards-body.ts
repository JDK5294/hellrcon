/**
 * The game-rewards settings out of a request body — every number bounded, every list capped, every
 * message length-checked — over the server's current settings, so a PUT may send one section.
 */
import { GAME_REWARD_CARDS, SQUAD_METRICS, SQUAD_TYPES, TOP_STAT_CATEGORIES, mergeGameRewards, orderedIds, type GameRewardsConfig, type RewardAmount, type SquadMetric, type SquadType, type StreakTier, type TopStatCategory } from "@app/db";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const int = (v: unknown, min: number, max: number, name: string): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const bool = (v: unknown, fallback: boolean) => (v === undefined ? fallback : v === true);
const text = (v: unknown, fallback: string, name: string): string => {
  if (v === undefined) return fallback;
  const s = String(v ?? "");
  if (s.length > 1000) throw new Error(`${name} must be at most 1000 characters`);
  return s;
};
function reward(v: unknown, name: string): RewardAmount {
  const r = obj(v);
  return { vipHours: int(r.vipHours ?? 0, 0, 8760, `${name} VIP hours`), points: int(r.points ?? 0, 0, 1_000_000, `${name} points`) };
}
/** A per-item message: kept only when it says something (blank = use the card's message). */
function itemMessage(v: unknown, name: string): { message?: string } {
  const m = text(v, "", name).trim();
  return m ? { message: m } : {};
}
function dayTiers(v: unknown, fallback: StreakTier[], name: string): StreakTier[] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length > 10) throw new Error(`${name} tiers must be a list of at most 10`);
  const tiers = v.map((t, i) => ({
    days: int(obj(t).days, 1, 365, `${name} tier ${i + 1} days`), reward: reward(obj(t).reward, `${name} tier ${i + 1}`),
    ...itemMessage(obj(t).message, `${name} tier ${i + 1} message`),
  }));
  if (new Set(tiers.map((t) => t.days)).size !== tiers.length) throw new Error(`${name} tiers must each have a different number of days`);
  return tiers.sort((a, b) => a.days - b.days);
}

export function parseGameRewardsBody(body: Obj, current: GameRewardsConfig): { value: GameRewardsConfig } | { error: string } {
  try {
    const next = mergeGameRewards(current);
    // The arrangement: the cards' order (a match end's combined message follows it) and, below,
    // the top-stats categories' order. Unknown ids are dropped, missing ones kept at the end.
    if (body.order !== undefined) {
      if (!Array.isArray(body.order)) throw new Error("order must be a list of reward cards");
      next.order = orderedIds(body.order, GAME_REWARD_CARDS);
    }
    if (body.bestSquads !== undefined) {
      const b = obj(body.bestSquads);
      const q = next.bestSquads;
      q.enabled = bool(b.enabled, q.enabled);
      q.dryRun = bool(b.dryRun, q.dryRun);
      q.broadcast = bool(b.broadcast, q.broadcast);
      q.showEveryone = bool(b.showEveryone, q.showEveryone);
      if (b.minMinutes !== undefined) q.minMinutes = int(b.minMinutes, 0, 180, "best squads minimum minutes");
      if (b.minPlayers !== undefined) q.minPlayers = int(b.minPlayers, 0, 100, "best squads minimum players");
      if (b.minMembers !== undefined) q.minMembers = int(b.minMembers, 1, 6, "best squads minimum members");
      if (b.metric !== undefined) {
        if (!SQUAD_METRICS.includes(b.metric as SquadMetric)) throw new Error(`best squads are ranked by one of ${SQUAD_METRICS.join(", ")}`);
        q.metric = b.metric as SquadMetric;
      }
      if (b.scoring !== undefined) {
        if (b.scoring !== "total" && b.scoring !== "average") throw new Error("best squads scoring is total or average");
        q.scoring = b.scoring;
      }
      q.message = text(b.message, q.message, "best squads message");
      if (b.types !== undefined) {
        if (!Array.isArray(b.types)) throw new Error("best squads types must be a list");
        for (const raw of b.types) {
          const t = obj(raw);
          const id = String(t.id) as SquadType;
          if (!SQUAD_TYPES.includes(id)) throw new Error(`unknown squad type '${String(t.id)}'`);
          const slot = q.types.find((x) => x.id === id)!;
          slot.enabled = bool(t.enabled, slot.enabled);
          if (t.message !== undefined) {
            const m = itemMessage(t.message, `${id} squad message`);
            if (m.message) slot.message = m.message; else delete slot.message;
          }
          if (t.ranks !== undefined) {
            if (!Array.isArray(t.ranks) || t.ranks.length > 10) throw new Error(`${id} squads: at most 10 places`);
            slot.ranks = t.ranks.map((r, i) => reward(r, `${id} squad place ${i + 1}`));
          }
        }
        // A list naming every type is an arrangement (its order is the message order); a few is an edit of those few.
        const named = new Set(b.types.map((t) => String(obj(t).id)));
        if (SQUAD_TYPES.every((id) => named.has(id))) {
          const order = orderedIds(b.types.map((t) => obj(t).id), q.types.map((t) => t.id));
          q.types = order.map((id) => q.types.find((t) => t.id === id)!);
        }
      }
    }
    if (body.topStats !== undefined) {
      const b = obj(body.topStats);
      const t = next.topStats;
      t.enabled = bool(b.enabled, t.enabled);
      t.dryRun = bool(b.dryRun, t.dryRun);
      t.broadcast = bool(b.broadcast, t.broadcast);
      t.showEveryone = bool(b.showEveryone, t.showEveryone);
      if (b.minMinutes !== undefined) t.minMinutes = int(b.minMinutes, 0, 180, "top stats minimum minutes");
      if (b.minPlayers !== undefined) t.minPlayers = int(b.minPlayers, 0, 100, "top stats minimum players");
      t.message = text(b.message, t.message, "top stats message");
      if (b.categories !== undefined) {
        if (!Array.isArray(b.categories)) throw new Error("top stats categories must be a list");
        for (const raw of b.categories) {
          const c = obj(raw);
          const id = String(c.id) as TopStatCategory;
          if (!TOP_STAT_CATEGORIES.includes(id)) throw new Error(`unknown top stats category '${String(c.id)}'`);
          const slot = t.categories.find((x) => x.id === id)!;
          slot.enabled = bool(c.enabled, slot.enabled);
          if (c.message !== undefined) {
            const m = itemMessage(c.message, `${id} message`);
            if (m.message) slot.message = m.message; else delete slot.message;
          }
          if (c.ranks !== undefined) {
            if (!Array.isArray(c.ranks) || c.ranks.length > 10) throw new Error(`${id}: at most 10 places`);
            slot.ranks = c.ranks.map((r, i) => reward(r, `${id} place ${i + 1}`));
          }
        }
        // A list naming EVERY category is an arrangement — its order becomes theirs. A list of a
        // few is an edit of those few, and must not move them to the top as a side effect.
        const named = new Set(b.categories.map((c) => String(obj(c).id)));
        if (TOP_STAT_CATEGORIES.every((id) => named.has(id))) {
          const order = orderedIds(b.categories.map((c) => obj(c).id), t.categories.map((c) => c.id));
          t.categories = order.map((id) => t.categories.find((c) => c.id === id)!);
        }
      }
    }
    if (body.killStreaks !== undefined) {
      const b = obj(body.killStreaks);
      const k = next.killStreaks;
      k.enabled = bool(b.enabled, k.enabled);
      k.dryRun = bool(b.dryRun, k.dryRun);
      k.message = text(b.message, k.message, "kill streak message");
      if (b.minPlayers !== undefined) k.minPlayers = int(b.minPlayers, 0, 100, "kill streak minimum players");
      if (b.tiers !== undefined) {
        if (!Array.isArray(b.tiers) || b.tiers.length > 10) throw new Error("kill streak tiers must be a list of at most 10");
        const tiers = b.tiers.map((t, i) => ({
          kills: int(obj(t).kills, 2, 500, `kill streak tier ${i + 1} kills`), reward: reward(obj(t).reward, `kill streak tier ${i + 1}`),
          ...itemMessage(obj(t).message, `kill streak tier ${i + 1} message`),
        }));
        if (new Set(tiers.map((t) => t.kills)).size !== tiers.length) throw new Error("kill streak tiers must each have a different number of kills");
        k.tiers = tiers.sort((a, b2) => a.kills - b2.kills);
      }
    }
    for (const key of ["playDays", "seedDays"] as const) {
      if (body[key] === undefined) continue;
      const b = obj(body[key]);
      const d = next[key];
      const name = key === "playDays" ? "days played" : "days seeding";
      d.enabled = bool(b.enabled, d.enabled);
      d.dryRun = bool(b.dryRun, d.dryRun);
      d.message = text(b.message, d.message, `${name} message`);
      d.tiers = dayTiers(b.tiers, d.tiers, name);
      if (b.repeatEveryDays !== undefined) d.repeatEveryDays = int(b.repeatEveryDays, 0, 365, `${name} repeat`);
      if (key === "playDays" && b.minMinutes !== undefined) next.playDays.minMinutes = int(b.minMinutes, 1, 1440, "minutes played per day");
    }
    if (body.matchEnd !== undefined) {
      const b = obj(body.matchEnd);
      const e = next.matchEnd;
      e.enabled = bool(b.enabled, e.enabled);
      e.dryRun = bool(b.dryRun, e.dryRun);
      e.message = text(b.message, e.message, "match-end message");
      if (b.minMatchMinutes !== undefined) e.minMatchMinutes = int(b.minMatchMinutes, 0, 600, "minimum match length");
      if (b.minPlayedMinutes !== undefined) e.minPlayedMinutes = int(b.minPlayedMinutes, 0, 600, "minimum minutes played");
      if (b.minPlayers !== undefined) e.minPlayers = int(b.minPlayers, 0, 100, "match-end minimum players");
      if (b.reward !== undefined) e.reward = reward(b.reward, "match-end reward");
    }
    return { value: next };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * What the config will ACTUALLY pay: only switched-on, live (not dry-run) kinds, and only enabled
 * top-stats categories — as a stable string per reward kind, so two configs can be compared.
 */
export function livePayouts(cfg: GameRewardsConfig): { vip: string; points: string } {
  const parts: [string, RewardAmount][] = [];
  // The thresholds are part of what is paid: lowering "minimum players" from 40 to 0 pays a live
  // reward far more often, so it is a paying change exactly like raising the amount.
  const top = cfg.topStats, ks = cfg.killStreaks, pd = cfg.playDays;
  if (top.enabled && !top.dryRun) for (const c of top.categories) if (c.enabled) c.ranks.forEach((r, i) => parts.push([`top:${top.minPlayers}:${top.minMinutes}:${c.id}:${i}`, r]));
  // Every member of a placed squad is paid, so a smaller minimum squad pays more people.
  const sq = cfg.bestSquads;
  if (sq.enabled && !sq.dryRun) for (const t of sq.types) if (t.enabled) t.ranks.forEach((r, i) => parts.push([`squad:${sq.minPlayers}:${sq.minMinutes}:${sq.minMembers}:${t.id}:${i}`, r]));
  if (ks.enabled && !ks.dryRun) for (const t of ks.tiers) parts.push([`streak:${ks.minPlayers}:${t.kills}`, t.reward]);
  if (pd.enabled && !pd.dryRun) { for (const t of pd.tiers) parts.push([`play:${pd.minMinutes}:${t.days}:${pd.repeatEveryDays}`, t.reward]); }
  if (cfg.matchEnd.enabled && !cfg.matchEnd.dryRun) parts.push([`end:${cfg.matchEnd.minMatchMinutes}:${cfg.matchEnd.minPlayedMinutes}:${cfg.matchEnd.minPlayers}`, cfg.matchEnd.reward]);
  if (cfg.seedDays.enabled && !cfg.seedDays.dryRun) { for (const t of cfg.seedDays.tiers) parts.push([`seed:${t.days}:${cfg.seedDays.repeatEveryDays}`, t.reward]); }
  // Sorted, so re-arranging the cards or categories (which pays nothing more) never reads as a change.
  parts.sort(([a], [b]) => a.localeCompare(b));
  return {
    vip: parts.filter(([, r]) => r.vipHours > 0).map(([k, r]) => `${k}=${r.vipHours}`).join(","),
    points: parts.filter(([, r]) => r.points > 0).map(([k, r]) => `${k}=${r.points}`).join(","),
  };
}
