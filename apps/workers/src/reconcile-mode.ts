/**
 * What each reconciler may do on a server this sweep: nothing, report, or fix.
 *
 * Both reconcilers (bans, VIP) compare what the panel decided with what the game enforces. They
 * report what differs everywhere they run, and change the game only where the server's own "Fix
 * what it finds" switch is on. That switch was a deploy flag once, one for every server
 * (BAN_RECONCILE_APPLY / VIP_RECONCILE_APPLY); it is now part of each server's automation, set in
 * the app and read on every sweep, so switching it takes effect at the next tick with no restart.
 */
import { automationEnabled } from "@app/db";
import type { ServerRow } from "@app/db";

export type ReconcileMode = "skip" | "report" | "fix";

const KEYS = {
  ban: { run: "banSync", fix: "banSyncApply" },
  vip: { run: "vipSync", fix: "vipSyncApply" },
} as const;

export function reconcileMode(server: Pick<ServerRow, "engagementMode" | "automation">, which: keyof typeof KEYS): ReconcileMode {
  // Observe means "read, never write", and the sweep honours it entirely — even a report would
  // describe writes the server can never receive.
  if (server.engagementMode === "observe") return "skip";
  if (!automationEnabled(server.automation, KEYS[which].run)) return "skip";
  return automationEnabled(server.automation, KEYS[which].fix) ? "fix" : "report";
}

/** Sweeps in a row a reconciler re-sends one write the game accepted but never carried out. */
export const RECONCILE_MAX_SENDS = 3;

/**
 * Writes the game answers "done" to and never does. A ban or VIP pushed under an id the server
 * cannot act on is accepted and changes nothing, so the next sweep plans it again — and without
 * this an armed reconciler re-sent it every few minutes forever, auditing each send as a fresh
 * ban, unban or grant. After RECONCILE_MAX_SENDS accepted sends the write is left alone and
 * reported once. It is tried again when it stops being planned (it landed, or the decision behind
 * it changed) and comes back, when the server's fix is switched off and on, or after a restart.
 *
 * Only a send the game ACCEPTED counts. One it refuses throws, is logged, writes no audit row and
 * is retried next sweep as before, so a game that is restarting does not use up the tries.
 *
 * One instance per kind of write (ban applies, ban lifts, VIP restores, VIP removals): `plan`
 * forgets a server's writes that are no longer planned, so two kinds must not share one.
 */
export class StuckWrites {
  private readonly sends = new Map<string, number>();
  private readonly reported = new Set<string>();

  private static key(serverId: string, key: string): string {
    return `${serverId}\u0000${key}`;
  }

  /**
   * This sweep's planned writes on one server: the ones still worth sending, the ones given up
   * on, and which of those have not been reported yet. Forgets the server's writes no longer
   * planned.
   */
  plan<T>(serverId: string, planned: T[], keyOf: (t: T) => string): { send: T[]; stuck: T[]; unreported: T[] } {
    const live = new Set(planned.map((t) => StuckWrites.key(serverId, keyOf(t))));
    this.forget(serverId, (k) => !live.has(k));
    const send: T[] = [];
    const stuck: T[] = [];
    const unreported: T[] = [];
    for (const t of planned) {
      const k = StuckWrites.key(serverId, keyOf(t));
      if ((this.sends.get(k) ?? 0) < RECONCILE_MAX_SENDS) { send.push(t); continue; }
      stuck.push(t);
      if (!this.reported.has(k)) { this.reported.add(k); unreported.push(t); }
    }
    return { send, stuck, unreported };
  }

  /** The game accepted this write. */
  accepted(serverId: string, key: string): void {
    const k = StuckWrites.key(serverId, key);
    this.sends.set(k, (this.sends.get(k) ?? 0) + 1);
  }

  /** Start the server over: its fix was switched off, or nothing is left to write there. */
  clear(serverId: string): void {
    this.forget(serverId, () => true);
  }

  private forget(serverId: string, drop: (k: string) => boolean): void {
    const prefix = StuckWrites.key(serverId, "");
    for (const k of [...this.sends.keys()]) if (k.startsWith(prefix) && drop(k)) this.sends.delete(k);
    for (const k of [...this.reported]) if (k.startsWith(prefix) && drop(k)) this.reported.delete(k);
  }
}

/** "Alpha, Bravo, Charlie and 4 more" — who a stuck-write report is about, kept short. */
export function namesOf(players: { playerId: string; playerName?: string | null }[], max = 5): string {
  const names = players.map((p) => p.playerName || p.playerId);
  return names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
}
