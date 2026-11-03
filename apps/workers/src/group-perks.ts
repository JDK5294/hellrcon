/**
 * Group VIP perks — the decisions, kept pure so they can be tested without a database or a game.
 *
 * A player group may carry a perk: while a player is listed, they hold PERMANENT VIP on the
 * servers the perk covers, and whatever timed VIP they had there freezes beneath it (the store
 * measures and keeps the balance — `vips.startGroupHold`). Leaving every group that holds it
 * gives the balance back plus the largest severance among those groups. This module answers,
 * for one reconcile, which holds to start, which to refresh and which to release; the sweep in
 * index.ts does the I/O around it.
 *
 * Level-triggered on purpose: it compares who SHOULD be held with who IS, every round, so any
 * way a membership changes — the Groups page, a profile, the live roster, a Discord role, an
 * import, a group deleted — is caught the same way, and a round missed is caught by the next.
 * It never acts on what it could not read: an unreadable membership aborts the round in the
 * sweep, and an unreadable VIP list holds back only the starts that needed it.
 *
 * What it will not do:
 *   - take over VIP it did not give: a permanent grant the player already holds, or a VIP entry
 *     the game's own list carries with no panel row, is theirs — nothing to freeze, nothing to
 *     give back;
 *   - write on a server in observe mode, or one whose VIP expiry the panel does not run (the
 *     `vipSweep` automation switch off — CRCON owns VIP there): starts wait, and holds already
 *     there stay held rather than being released into an expiry nobody would carry out;
 *   - grant to an id it cannot place in the perk's game: player ids do not cross games, and a
 *     console id the directory has never seen could belong to either — that member waits until
 *     they have been seen (a Steam64 can only be a WW2 player, so it needs no sighting there).
 */
import { banScopeCovers, memberGameVerdict, perkWritable, type GroupVipPerk, type ServerRow, type VipGroupHoldSource, type VipRow } from "@app/db";

// The id → game decision is shared with the rule engine's group triggers, and where a perk may
// write with the VIP list; re-exported here, where the perk decisions (and their tests) have
// always found them.
export { memberGameVerdict, perkWritable };

export interface PerkGroup {
  id: string;
  name: string;
  perk: GroupVipPerk;
  members: { playerId: string; playerName: string | null }[];
}

/** Why a member could not be held on a server this round — reported per group, never silent. */
export interface PerkNotes {
  /** console ids the directory has not seen yet, so their game is unknown. */
  notSeen: number;
  /** ids the directory knows belong to the other game. */
  otherGame: number;
  /** players already holding permanent VIP the group did not give. */
  ownPermanent: number;
  /** players the game's own VIP list carries with no panel grant (VIP set outside the panel). */
  ownGameVip: number;
  /** starts held back because the server's VIP list could not be read. */
  listUnreadable: number;
  /** starts held back on observe-mode servers or ones whose VIP expiry the panel does not run. */
  quietServers: number;
}
export const NO_NOTES: PerkNotes = { notSeen: 0, otherGame: 0, ownPermanent: 0, ownGameVip: 0, listUnreadable: 0, quietServers: 0 };

/** One (server, player) a perk should hold, and the groups holding it. */
export interface DesiredHold { serverId: string; playerId: string; playerName: string | null; groups: VipGroupHoldSource[] }

/** Every (server, player) the perks say should be held, with the groups saying so. */
export function desiredHolds(groups: PerkGroup[], servers: ServerRow[], gameOf: Map<string, string>): { desired: Map<string, DesiredHold>; notes: Map<string, PerkNotes> } {
  const desired = new Map<string, DesiredHold>();
  const notes = new Map<string, PerkNotes>();
  for (const g of groups) {
    const n: PerkNotes = { ...NO_NOTES };
    notes.set(g.id, n);
    const covered = servers.filter((s) => s.game === g.perk.game && banScopeCovers(g.perk.scope, s.id));
    if (!covered.length) continue;
    for (const m of g.members) {
      const verdict = memberGameVerdict(m.playerId, g.perk.game, gameOf);
      if (verdict !== "ok") { n[verdict] += 1; continue; }
      for (const s of covered) {
        const key = `${s.id}|${m.playerId}`;
        const d = desired.get(key) ?? desired.set(key, { serverId: s.id, playerId: m.playerId, playerName: m.playerName, groups: [] }).get(key)!;
        if (!d.groups.some((x) => x.id === g.id)) d.groups.push({ id: g.id, name: g.name, severanceMinutes: g.perk.severanceMinutes });
        if (!d.playerName && m.playerName) d.playerName = m.playerName;
      }
    }
  }
  for (const d of desired.values()) d.groups.sort((a, b) => a.id.localeCompare(b.id));
  return { desired, notes };
}

export interface HoldStart {
  serverId: string; playerId: string; playerName: string | null; groups: VipGroupHoldSource[];
  /** false while a VIP timeout has it off the game — the timeout's end puts it back */
  addToGame: boolean;
  /** No grant row of ours stood: a game entry added for this start is the perk's alone, so one the
   *  panel then failed to record must come back off the game. */
  fresh: boolean;
  /** The running timed grant's expiration when the plan was made (null for none, or one a VIP
   *  timeout froze) — rechecked just before starting. */
  expiration: string | null;
}
export interface HoldRelease {
  serverId: string; playerId: string; playerName: string | null; expiration: string; bankedMs: number;
  /** What the release pays: a group that still carries its perk pays the severance it is set to
   *  now; one whose perk ended (switched off, deleted) pays what the person who ended it chose. */
  severanceMinutes: number;
  /** The largest severance the hold recorded when read — the release lands only if unchanged. */
  recordedSeverance: number;
  groups: VipGroupHoldSource[];
}
export interface PerkPlan {
  start: HoldStart[];
  /** `was`: the groups the hold remembered when read — the refresh lands only if it still does. */
  refresh: { serverId: string; playerId: string; groups: VipGroupHoldSource[]; was: VipGroupHoldSource[] }[];
  release: HoldRelease[];
  /** servers whose own VIP list is needed before some starts can be decided (players with no grant row). */
  needLists: Set<string>;
}

/**
 * A timed grant this close to its end (or just past it) is the expiry sweep's, not a new hold's:
 * started into a hold, the sweep could take it out from under the hold — the game entry removed,
 * or the row deleted after the perk re-added that entry, which then reads as VIP of the player's
 * own and is never managed again. The next round after the sweep starts it cleanly. A row still
 * there EXPIRY_STUCK_MS after its date is one the sweep cannot clear (the game no longer lists it,
 * say): waiting longer would block the perk for good, so the hold takes it over — which is what
 * clears it. (A VIP timeout that froze the meter is exempt: the sweep never touches it.)
 */
export const EXPIRY_MARGIN_MS = 5 * 60_000;
export const EXPIRY_STUCK_MS = 15 * 60_000;

export function expiringSoon(row: Pick<VipRow, "expiration" | "pauseMode" | "pausedUntil"> | null | undefined, nowMs: number): boolean {
  if (!row?.expiration || (row.pauseMode === "banked" && row.pausedUntil !== null)) return false;
  const at = Date.parse(row.expiration);
  return at <= nowMs + EXPIRY_MARGIN_MS && at > nowMs - EXPIRY_STUCK_MS;
}

const sameSources = (a: VipGroupHoldSource[], b: VipGroupHoldSource[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.name === b[i]!.name && x.severanceMinutes === b[i]!.severanceMinutes);

/** The severance a release gives: the largest among the groups that held it (0 = none). */
export function releaseSeverance(groups: VipGroupHoldSource[]): number {
  return groups.reduce((m, g) => Math.max(m, g.severanceMinutes || 0), 0);
}

/**
 * Compare who should be held with who is.
 *
 * @param rows every VIP row on the servers in play, keyed `${serverId}|${playerId}`.
 * @param gameLists a server's own VIP list (ids), null when it could not be read, absent when not
 *   read — a start needing one that is absent lands in `needLists` instead.
 */
export function planPerkHolds(input: {
  desired: Map<string, DesiredHold>;
  rows: Map<string, VipRow>;
  servers: ServerRow[];
  gameLists: Map<string, Set<string> | null>;
  nowMs: number;
  /** Each group that carries a perk now → its severance in minutes. */
  perkSeverances?: Map<string, number>;
  /** notes per group, filled in as starts are judged. */
  notes: Map<string, PerkNotes>;
}): PerkPlan {
  const byId = new Map(input.servers.map((s) => [s.id, s]));
  const plan: PerkPlan = { start: [], refresh: [], release: [], needLists: new Set() };
  const note = (d: DesiredHold, k: keyof PerkNotes) => { for (const g of d.groups) { const n = input.notes.get(g.id); if (n) n[k] += 1; } };

  for (const [key, d] of input.desired) {
    const server = byId.get(d.serverId);
    if (!server) continue;
    const row = input.rows.get(key);
    if (row?.groupHold) {
      if (!sameSources(row.groupHold.groups, d.groups)) plan.refresh.push({ serverId: d.serverId, playerId: d.playerId, groups: d.groups, was: row.groupHold.groups });
      continue;
    }
    if (!perkWritable(server)) { note(d, "quietServers"); continue; }
    if (row && row.expiration === null) { note(d, "ownPermanent"); continue; }
    if (expiringSoon(row, input.nowMs)) continue;
    const paused = !!row?.pausedUntil && Date.parse(row.pausedUntil) > input.nowMs;
    if (!row) {
      // No grant of ours: the game's own list decides whether this VIP is somebody else's.
      if (!input.gameLists.has(d.serverId)) { plan.needLists.add(d.serverId); continue; }
      const list = input.gameLists.get(d.serverId);
      if (list === null || list === undefined) { note(d, "listUnreadable"); continue; }
      if (list.has(d.playerId)) { note(d, "ownGameVip"); continue; }
    }
    const frozen = row?.pauseMode === "banked" && row.pausedUntil !== null;
    plan.start.push({ serverId: d.serverId, playerId: d.playerId, playerName: d.playerName ?? row?.playerName ?? null, groups: d.groups, addToGame: !paused, fresh: !row, expiration: frozen ? null : row?.expiration ?? null });
  }

  for (const [key, row] of input.rows) {
    if (!row.groupHold || input.desired.has(key)) continue;
    const server = byId.get(row.serverId);
    // A server we cannot write on (or that is gone from the active list) keeps the hold: releasing
    // into an expiry nobody carries out would leave a dated grant the game never drops.
    if (!server || !perkWritable(server)) continue;
    const recordedSeverance = releaseSeverance(row.groupHold.groups);
    const severanceMinutes = releaseSeverance(row.groupHold.groups.map((g) => ({ ...g, severanceMinutes: input.perkSeverances?.get(g.id) ?? g.severanceMinutes })));
    const bankedMs = row.groupHold.bankedMs;
    plan.release.push({
      serverId: row.serverId, playerId: row.playerId, playerName: row.playerName,
      expiration: new Date(input.nowMs + bankedMs + severanceMinutes * 60_000).toISOString(),
      bankedMs, severanceMinutes, recordedSeverance, groups: row.groupHold.groups,
    });
  }
  return plan;
}

/** "13 days", "2 hours", "45 minutes" — a balance or severance as staff would say it. */
export function describeSpan(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"}`;
  if (min >= 1440) return `${(min / 1440).toFixed(1)} days`;
  if (min >= 60) return `${Math.round(min / 60)} hour${Math.round(min / 60) === 1 ? "" : "s"}`;
  return `${min} minute${min === 1 ? "" : "s"}`;
}
