/**
 * Map-vote profiles: an ordered list of named pool configs, each optionally gated by a schedule +
 * player-count spec. The first profile whose spec is active "wins" and supplies the pool config for
 * the vote — the map-vote counterpart of the earlier bot's time/day/pop profiles, now driven by the
 * shared @app/schedule engine instead of bespoke matching.
 */
import { resolveProfile, type ScheduleSpec, type ScheduleContext } from "@app/schedule";
import { DEFAULT_POOL_CONFIG, type MapPoolConfig } from "./vote.js";

export interface MapVoteProfile {
  name: string;
  /** when this profile is active; absent = unconditional default (put it last). */
  spec?: ScheduleSpec;
  /** pool overrides layered over DEFAULT_POOL_CONFIG. */
  pool?: Partial<MapPoolConfig>;
}

export interface ResolvedPool {
  /** the active profile's name, or null if none matched. */
  profileName: string | null;
  /** the effective pool config to compose the poll with. */
  config: MapPoolConfig;
}

/**
 * Resolve which profile is active at `now` (given player count) and return its effective pool config
 * (profile pool merged over the defaults). `fallbackTimezone` fills in for profiles whose spec omits
 * one. When nothing matches, returns the default pool with a null name.
 */
export function resolveActivePool(profiles: MapVoteProfile[], now: Date, ctx: ScheduleContext = {}, fallbackTimezone?: string): ResolvedPool {
  const withTz: MapVoteProfile[] = profiles.map((p) =>
    p.spec ? { ...p, spec: { timezone: fallbackTimezone, ...p.spec } } : p,
  );
  const active = resolveProfile(withTz, now, ctx);
  const config: MapPoolConfig = { ...DEFAULT_POOL_CONFIG, ...(active?.pool ?? {}) };
  return { profileName: active?.name ?? null, config };
}

/**
 * Resolve one profile BY NAME, ignoring its schedule spec entirely — how an open payout event
 * pins a profile for its duration ("event maps while the event runs, whatever the clock says").
 * Returns null when no profile carries the name any more: the profile may have been renamed or
 * deleted since the event was created, and the right response is to fall back to the schedule,
 * not to refuse to open votes for the rest of the event.
 */
export function resolvePinnedPool(profiles: MapVoteProfile[], name: string): ResolvedPool | null {
  const p = profiles.find((x) => x.name === name);
  if (!p) return null;
  return { profileName: p.name, config: { ...DEFAULT_POOL_CONFIG, ...(p.pool ?? {}) } };
}
