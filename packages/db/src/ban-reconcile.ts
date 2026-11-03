/**
 * Ban reconciliation — the piece that turns a ban decision into a standing rule.
 *
 * The decisions table (`player_ban`) says what staff MEANT; each game server's own ban list says
 * what it is ENFORCING. This planner compares the two for one server and says what would bring
 * them into line:
 *
 *   apply   — active decisions whose rule covers this server, which the server is not enforcing.
 *             This is how a server added next month inherits every "all servers" ban, and how a
 *             server whose ban file was lost gets it back.
 *   lift    — game bans whose decision has been lifted or has expired. The unban path clears the
 *             servers it can reach at click time; this catches the one that was down.
 *   foreign — game bans with no decision behind them at all: placed from the in-game console or
 *             straight over RCON. REPORTED, never removed — a ban a human placed by hand is
 *             legitimate, and deleting what we merely do not recognise would make the panel the
 *             only allowed way to moderate. The seed exists to adopt these instead.
 *   ranOut  — temp bans the game still lists after their own time ran out, which no standing
 *             decision covers: neither lifted (the game refuses to) nor foreign (nothing to adopt).
 *
 * Pure — same contract as `planSeedingTick`: (decisions, game state, clock) → plan, no I/O — so
 * the interesting logic is testable without a game server, and the runner is only plumbing.
 *
 * Lives in @app/db (next to `banScopeCovers`, which it reasons with) rather than in the worker,
 * because the worker's sweep and the API's staff-driven "Sync with game" both consume it — the
 * same arrangement as the VIP planner in rcon-core, and for the same reason: two copies of "does
 * this rule cover this server" is how the two surfaces end up disagreeing about who is banned.
 */
import { banScopeCovers, type PlayerBanRow } from "./types.js";

export interface GameBanLite {
  playerId: string;
  type: "temp" | "perma";
  /** The game's own record of a temp ban — when it was placed and for how many hours — which is
   *  what tells a ban the game still LISTS from one it still enforces (gameBanRanOut). */
  ts?: string | null;
  durationHours?: number;
}

export interface BanReconcilePlan {
  apply: PlayerBanRow[];
  lift: { playerId: string; kind: "temp" | "perma" }[];
  foreign: GameBanLite[];
  /**
   * Temp bans the game still lists after their time ran out by its own clock, which no standing
   * decision covers — whether the one behind it is over or there never was one. Nothing to lift
   * and nothing to adopt: the game no longer enforces them, and it refuses to remove one
   * (RemoveTemporaryBan answers "Request was invalid"). Reported, never sent — and never counted
   * as placed outside the panel, which would ask staff to adopt a ban that holds nobody.
   */
  ranOut: { playerId: string; kind: "temp" }[];
}

/**
 * Whether a temp ban the game lists has run out by its own record: placed at `ts`, for
 * `durationHours`. HLL goes on listing a temp ban after it ends — a live WW2 server listed 21
 * finished 24-hour team-kill bans among its 37 — and refuses RemoveTemporaryBan for every one.
 * An entry missing either value is never taken to be over, and a perma ban never runs out.
 */
export function gameBanRanOut(b: { type: string; ts?: string | null; durationHours?: number }, nowMs: number): boolean {
  if (b.type !== "temp" || !b.ts || !(Number(b.durationHours) > 0)) return false;
  const placed = Date.parse(b.ts);
  return Number.isFinite(placed) && placed + Number(b.durationHours) * 3_600_000 <= nowMs;
}

export function planBanReconcile(
  serverId: string,
  game: string,
  decisions: PlayerBanRow[],
  gameBans: GameBanLite[],
  nowIso: string,
): BanReconcilePlan {
  const covered = decisions.filter((d) => d.game === game && banScopeCovers(d.scope, serverId));
  const isActive = (d: PlayerBanRow) => d.liftedAt === null && (d.expiresAt === null || d.expiresAt > nowIso);
  const key = (playerId: string, kind: string) => `${playerId}|${kind}`;

  const active = new Map<string, PlayerBanRow>();
  const inactive = new Set<string>();
  for (const d of covered) {
    // Banned, lifted, banned again is three rows; the ACTIVE one wins for its (player, kind).
    if (isActive(d)) active.set(key(d.playerId, d.kind), d);
    else inactive.add(key(d.playerId, d.kind));
  }
  const onServer = new Set(gameBans.map((b) => key(b.playerId, b.type)));
  const now = Date.parse(nowIso);
  // Game bans no active decision stands behind: over (lifted or expired) or never decided.
  const unbacked = gameBans.filter((b) => !active.has(key(b.playerId, b.type)));
  const enforced = unbacked.filter((b) => !gameBanRanOut(b, now));

  return {
    apply: [...active.values()].filter((d) => !onServer.has(key(d.playerId, d.kind))),
    lift: enforced.filter((b) => inactive.has(key(b.playerId, b.type))).map((b) => ({ playerId: b.playerId, kind: b.type })),
    foreign: enforced.filter((b) => !inactive.has(key(b.playerId, b.type))),
    ranOut: unbacked.filter((b) => gameBanRanOut(b, now)).map((b) => ({ playerId: b.playerId, kind: "temp" as const })),
  };
}

/**
 * One line summarising a plan, for the audit trail and the dry-run report. Stable ordering, so two
 * identical plans produce identical strings — the runner uses that to report a standing situation
 * once instead of every tick.
 */
export function reconcileSignature(plan: BanReconcilePlan): string {
  const part = (xs: string[]) => [...xs].sort().join(",");
  return [
    part(plan.apply.map((d) => `${d.playerId}:${d.kind}`)),
    part(plan.lift.map((l) => `${l.playerId}:${l.kind}`)),
    part(plan.foreign.map((f) => `${f.playerId}:${f.type}`)),
  ].join(" / ");
}
