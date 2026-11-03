/**
 * Who the expired-VIP sweep talks to, and what it may do when the game says no.
 *
 * The sweep itself is I/O — group by server, open one connection each, RemoveVip, drop the row.
 * The decisions are here, because one of them is not obvious and got the sweep stuck.
 *
 * A PAUSED grant is already off the game. Pausing a VIP takes it out of the game immediately and
 * keeps our row, with `paused_until` set, so that nothing re-adds it; the resume clears that field
 * when (and only when) it puts the VIP back. A running-mode pause deliberately lets the clock keep
 * running — the lost time IS the punishment — so a grant can, and routinely does, reach its
 * expiry while paused. The sweep then asked the game to remove a VIP the game does not have, and
 * removed our row only if that call SUCCEEDED. Where the game answers "not a VIP" with an error,
 * the row therefore survived its own expiry forever: retried every sweep, a warning each tick, a
 * grant that had run out still sitting in the table.
 *
 * So the game is still told — a pause set while the server was in observe mode never reached it,
 * and that stale VIP is exactly what the sweep is for — but a refusal only blocks the row when the
 * game might really still be holding one.
 */
import { automationEnabled } from "@app/db";
import type { Repository, ServerRow, VipRow } from "@app/db";

export type VipSkipReason = "server-gone" | "retired" | "observe" | "sweep-off";

export interface VipExpiryTarget {
  row: VipRow;
  /**
   * Whether a refusal from the game must stop us clearing the row. False for a paused grant: the
   * panel already took that VIP off the game, so "no such VIP" is the expected answer, not a
   * failure to retry.
   */
  gameMayStillHoldIt: boolean;
}

export interface VipExpiryPlan {
  /** Grants whose server no longer exists at all (deleted, not retired): drop the rows, tell nobody. */
  orphans: VipRow[];
  /** Servers to connect to, with the rows to remove on each. */
  work: { serverId: string; rows: VipExpiryTarget[] }[];
  /** Servers deliberately left alone, and why. */
  skipped: { serverId: string; reason: VipSkipReason }[];
}

/** True when the panel has already taken this VIP off the game and nothing has put it back. */
export function pausedOffTheGame(v: Pick<VipRow, "pausedUntil">): boolean {
  return v.pausedUntil !== null;
}

/**
 * @param expired every grant past its expiration (the store already excludes banked pauses, whose
 *   meter is frozen — see `vips.expired`).
 * @param serverById the servers that exist right now — RETIRED ones included (readVipExpiryPlan).
 */
export function planVipExpiry(expired: VipRow[], serverById: Map<string, ServerRow>): VipExpiryPlan {
  const orphans: VipRow[] = [];
  const byServer = new Map<string, VipRow[]>();
  for (const v of expired) {
    if (!serverById.has(v.serverId)) { orphans.push(v); continue; }
    const rows = byServer.get(v.serverId);
    if (rows) rows.push(v); else byServer.set(v.serverId, [v]);
  }
  const work: VipExpiryPlan["work"] = [];
  const skipped: VipExpiryPlan["skipped"] = [];
  for (const [serverId, rows] of byServer) {
    const server = serverById.get(serverId)!;
    // Retiring touches nothing but the stamp, and the worker no longer talks to a retired server.
    // Its grants wait here, rows and all, so that bringing the server back lets the next sweep
    // take the expired ones off the game; dropping them now would leave the game holding VIP that
    // nothing would ever remove.
    if (server.retiredAt) { skipped.push({ serverId, reason: "retired" }); continue; }
    // Observe mode is read-only: RemoveVip would be refused by the guard on every sweep, spamming
    // a warning each tick and burning a connection. The grants stay until the server is armed.
    if (server.engagementMode === "observe") { skipped.push({ serverId, reason: "observe" }); continue; }
    // Same quiet skip where this server's VIP sweep is switched off — e.g. CRCON still owns VIP
    // there while this app is being adopted one system at a time.
    if (!automationEnabled(server.automation, "vipSweep")) { skipped.push({ serverId, reason: "sweep-off" }); continue; }
    work.push({ serverId, rows: rows.map((row) => ({ row, gameMayStillHoldIt: !pausedOffTheGame(row) })) });
  }
  return { orphans, work, skipped };
}

/**
 * The sweep's read and plan: every grant past its expiry, against every server that exists.
 *
 * `servers.list()` leaves retired servers out, and a grant planned against that list read as one
 * whose server was GONE: its row was deleted and the game never told. Retiring is reversible, so a
 * server brought back kept those VIPs on the game with nothing left to take them off. The read
 * here asks for retired servers too, so only a deleted server's grants count as orphans.
 * Returns null when nothing has expired.
 */
export async function readVipExpiryPlan(
  repo: { vips: Pick<Repository["vips"], "expired">; servers: Pick<Repository["servers"], "list"> },
  nowIso: string,
): Promise<{ plan: VipExpiryPlan; serverById: Map<string, ServerRow> } | null> {
  const expired = await repo.vips.expired(nowIso);
  if (!expired.length) return null;
  const serverById = new Map((await repo.servers.list({ includeRetired: true })).map((s) => [s.id, s]));
  return { plan: planVipExpiry(expired, serverById), serverById };
}
