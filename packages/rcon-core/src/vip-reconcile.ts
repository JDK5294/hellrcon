/**
 * VIP reconciliation — the same contract as ban reconciliation, for the other thing we write to
 * the game and then trust blindly.
 *
 * The vips table says what staff GRANTED; the game's own VIP list says who is actually getting
 * queue priority. Nothing compared the two: `AddVip` was written, the row was stored, and from
 * then on the panel showed the row. The incident that forced this feature was exactly that gap —
 * a live server answering a well-formed EMPTY `vipplayers` list while the table held dozens of
 * unexpired grants. Every one of those players believed they had VIP, the panel agreed, and the
 * game gave them nothing. No error had ever fired, because there was never anything to fail: each
 * individual write answered 200 at the time (or the list was wiped later, which no write path
 * would ever notice).
 *
 * The planner compares one server's grants against its live list and says what would bring them
 * into line:
 *
 *   apply   — grants in force (unexpired, not paused) the game does not list. The wiped-list
 *             incident is this bucket at full size; the everyday case is the one AddVip that
 *             silently matched nobody or the write that failed after the row was stored.
 *   remove  — game entries whose grant is expired or PAUSED. The expiry half backstops the expiry
 *             sweep (a server down at expiry time); the pause half closes a real hole — a VIP
 *             timeout removes the entry at pause time, and nothing until now noticed if the entry
 *             came back (a reinstall, a restore from backup) while the punishment stood.
 *   foreign — game entries with no grant behind them at all: granted from another tool or before
 *             this panel. REPORTED, never removed — same rule as foreign bans, and for the same
 *             reason: deleting what we merely do not recognise would make the panel the only
 *             allowed way to manage VIP.
 *
 * ## Pause is a stop sign, not a gap
 *
 * A paused VIP is DELIBERATELY absent from the game while their row stays live — that is what a
 * VIP timeout is. A reconciler that read "live row, missing from game" naively would re-add every
 * paused VIP on its next tick, quietly undoing every timeout staff ever issue. So paused rows are
 * classified before anything else: never `apply`, and `remove` if present. Banked pauses freeze
 * the expiry meter, so a banked row is never judged expired here either — pushing the expiration
 * out is `resumeLapsedVipPauses`' arithmetic, not ours.
 *
 * Pure — (grants, game list, clock) → plan, no I/O — so every rule above is testable without a
 * game server, and the runner is only plumbing.
 *
 * Lives in rcon-core (not the worker) because BOTH consumers need the same rules: the worker's
 * periodic sweep and the API's staff-driven sync on the VIPs page. Two copies of "does a pause
 * beat an expiry" is how the two surfaces end up disagreeing about who has VIP. The grant type is
 * structural — the fields of `VipRow` this planner reads — so rcon-core does not grow a @app/db
 * dependency; the db row satisfies it as-is and comes back out typed via the generic.
 */
import type { GameVip } from "./protocol/binary-v2/responses.js";

/** The slice of a VIP grant row the planner reasons about (satisfied by @app/db's VipRow). */
export interface VipGrantLike {
  playerId: string;
  playerName: string | null;
  comment: string | null;
  /** null = permanent; otherwise the ISO instant the VIP lapses. */
  expiration: string | null;
  /** VIP timeout: while set and in the future, the VIP must be OFF the game. */
  pausedUntil: string | null;
  /** 'banked' freezes the expiry meter during the pause (see the db row's docs). */
  pauseMode: "running" | "banked" | null;
}

export interface VipReconcilePlan<T extends VipGrantLike = VipGrantLike> {
  apply: T[];
  remove: { playerId: string; playerName: string | null; why: "expired" | "paused" }[];
  foreign: GameVip[];
}

export function planVipReconcile<T extends VipGrantLike>(grants: T[], gameVips: GameVip[], nowIso: string): VipReconcilePlan<T> {
  const now = Date.parse(nowIso);
  const paused = (v: VipGrantLike) => Boolean(v.pausedUntil && Date.parse(v.pausedUntil) > now);
  // Banked pauses froze the meter, so their stored expiration is not comparable to the clock —
  // treat them as unexpired and let the pause rule govern (it always does: paused ⇒ off the game).
  const expired = (v: VipGrantLike) => v.expiration !== null && Date.parse(v.expiration) <= now && !(paused(v) && v.pauseMode === "banked");

  const byId = new Map<string, T>(grants.map((v) => [v.playerId, v]));
  const listed = new Set(gameVips.map((g) => g.playerId));

  const remove: VipReconcilePlan<T>["remove"] = [];
  for (const g of gameVips) {
    const row = byId.get(g.playerId);
    if (!row) continue; // foreign, handled below
    if (paused(row)) remove.push({ playerId: row.playerId, playerName: row.playerName, why: "paused" });
    else if (expired(row)) remove.push({ playerId: row.playerId, playerName: row.playerName, why: "expired" });
  }

  return {
    apply: grants.filter((v) => !listed.has(v.playerId) && !paused(v) && !expired(v)),
    remove,
    foreign: gameVips.filter((g) => !byId.has(g.playerId)),
  };
}

/**
 * One line summarising a plan, stable across identical plans — the runner reports a STANDING
 * situation once, not once per tick. Same convention as `reconcileSignature` for bans.
 */
export function vipReconcileSignature(plan: VipReconcilePlan<VipGrantLike>): string {
  const part = (xs: string[]) => [...xs].sort().join(",");
  return [
    part(plan.apply.map((v) => v.playerId)),
    part(plan.remove.map((r) => `${r.playerId}:${r.why}`)),
    part(plan.foreign.map((f) => f.playerId)),
  ].join(" / ");
}
