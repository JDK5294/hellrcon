/**
 * Who held VIP on a server, and when — rebuilt from the VIP history the audit trail has kept all
 * along, for the analytics that count VIPs per day.
 *
 * Every write that decides a VIP's expiry leaves an audit row (the same slice of the trail the VIP
 * integrity scan reads, audit.vipTimeline): grants, rewards that move the expiry, a rule's own VIP,
 * reductions, revokes, the expiry sweep, group perks holding and releasing a grant. Replayed in
 * time order, per (server, player), they say when each player's VIP began and when it ended — a
 * dated grant ends on its date even when no row says so, because the sweep only tidies up after it.
 *
 * Where the history runs out, today's VIP list fills in: a grant imported from CRCON, or adopted
 * from the game, may have no grant row of its own, but its row has stood since it was created.
 *
 * Unlike the integrity scan this asks what DID happen, not what was owed, so it reads every write
 * at face value with three exceptions: a VIP sync taking an entry off the game (the grant itself
 * had already lapsed, or is paused, and stays on the books), a reward's dry run (nothing was
 * written), and time banked under a group perk — or taken back out of that balance (the grant
 * stays permanent while it is held).
 *
 * Grants under an hour are left out: a crash VIP lets somebody rejoin a full server, it does not
 * make them a VIP for the day. A run counts when it was set to last an hour or more AND something
 * in it gave an hour or more on its own — so a crash VIP renewed by every crash is still a crash
 * VIP, however long the renewals run, and a month's grant taken back after ten minutes is not a
 * VIP's day either. Both are measured to the expiry, not to now: a month's grant made ten minutes
 * ago counts at once.
 */
import { storedVipExpiration } from "@app/db";
import type { VipAuditEvent } from "./vip-integrity.js";

/** The shortest VIP that counts as having had VIP. */
export const VIP_STRETCH_MIN_MS = 3_600_000;

/** One unbroken run of VIP: [from, to) in epoch milliseconds, `to` no later than now. */
export interface VipStretch { serverId: string; playerId: string; from: number; to: number }
/** A run as the replay builds it: `ends` is when it was set to end — its expiry, never (Infinity)
 *  for a permanent one still running. `long`: something in it gave an hour or more on its own. */
interface Run extends VipStretch { ends: number; long: boolean }

/** The slice of a current VIP row the replay needs: today's list is the floor under the history. */
export interface VipListedRow { serverId: string; playerId: string; expiration: string | null; createdAt: string; createdByName: string }

/** Who a rule's VIP (crash VIP, the no-VIP trigger) is created by: the enforcer, which runs the rules. */
const RULE_VIP_CREATOR = "enforcer";

/**
 * Feed it the VIP slice of the audit trail oldest first (only `serverId`'s rows, when given), then
 * finish with today's VIP list. Returns each player's runs on each server, merged where they meet,
 * less the ones made of grants under an hour.
 */
export function vipHistoryReplay(opts: { serverId?: string; now: number }) {
  /** `exp`: null permanent, a number the instant a dated grant ends. `since`: when this run began. */
  interface Held { exp: number | null; since: number; long: boolean }
  const held = new Map<string, Held>();
  const runs: Run[] = [];
  const parts = (key: string) => key.split("|") as [string, string];
  /** Does an expiry of `exp`, written at `at`, give an hour or more? */
  const lasts = (at: number, exp: number | null) => exp === null || exp - at >= VIP_STRETCH_MIN_MS;

  const close = (key: string, at: number): void => {
    const h = held.get(key);
    if (!h) return;
    held.delete(key);
    const [serverId, playerId] = parts(key);
    if (at > h.since) runs.push({ serverId, playerId, from: h.since, to: at, ends: at, long: h.long });
  };
  /** A dated grant that ran out before `at` ended on its date, whatever comes next. */
  const lapse = (key: string, at: number): void => {
    const h = held.get(key);
    if (h && h.exp !== null && h.exp <= at) close(key, h.exp);
  };
  /**
   * The expiry is now `exp` (null permanent), written at `at`: a run starts if none was, and a date
   * already past ends it. `grant`: the write gave VIP, as a reduction does not. A write that finds
   * no run is judged on what it left either way: a reduction there is a grant older than the
   * history, and what remains of it is what the history knows of its length.
   */
  const set = (key: string, at: number, exp: number | null, grant: boolean): void => {
    if (exp !== null && exp <= at) { close(key, at); return; }
    const h = held.get(key);
    if (!h) { held.set(key, { exp, since: at, long: lasts(at, exp) }); return; }
    h.exp = exp;
    if (grant && lasts(at, exp)) h.long = true;
  };
  const date = (v: unknown): number | null | undefined => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") return undefined;
    const stored = storedVipExpiration(v);
    if (stored === null) return null;
    const ms = Date.parse(stored);
    return Number.isFinite(ms) ? ms : undefined;
  };

  const feed = (e: VipAuditEvent): void => {
    const at = Date.parse(e.ts);
    if (!Number.isFinite(at)) return;
    const data = (e.data ?? {}) as Record<string, unknown>;
    if (data.dryRun === true) return;

    // A banked pause ending hands the frozen time back: the expiry moves later. The lapse sweep
    // writes one row per server; a staff resume lists several servers under `banked`. Only a date
    // says anything: a pause that let the time run gave nothing back, and its row carries none.
    if (e.action === "player.vipresume") {
      const pid = typeof data.playerId === "string" ? data.playerId : e.targetId;
      const given = Array.isArray(data.banked)
        ? (data.banked as { serverId?: unknown; expiration?: unknown }[]).map((b) => ({ serverId: b?.serverId, expiration: b?.expiration }))
        : [{ serverId: e.serverId, expiration: data.expiration }];
      for (const b of given) {
        if (!pid || typeof b.serverId !== "string" || typeof b.expiration !== "string" || (opts.serverId && b.serverId !== opts.serverId)) continue;
        const key = `${b.serverId}|${pid}`;
        lapse(key, at);
        const exp = date(b.expiration);
        if (exp === undefined) continue;
        const h = held.get(key);
        // Never earlier, never a permanent dated: the time handed back only adds. With no run (the
        // old date passed while the pause held the grant, or the grant is older than the history)
        // it put the VIP on again from here.
        if (h && (h.exp === null || (exp !== null && exp <= h.exp))) continue;
        set(key, at, exp, true);
      }
      return;
    }

    if (!e.serverId || (opts.serverId && e.serverId !== opts.serverId)) return;
    // A rule's VIP (crash VIP, the no-VIP trigger) files its row under the player's PROFILE id and
    // carries the game id in its data, which is the id every other VIP row uses.
    const pid = e.action === "enforcer.vip" ? (typeof data.playerId === "string" ? data.playerId : null) : e.targetId;
    if (!pid) return;
    const key = `${e.serverId}|${pid}`;
    lapse(key, at);

    switch (e.action) {
      case "vip.grant": {
        // Time granted while a group perk holds the grant is banked under the hold: the row stays
        // permanent, so the write changes nothing about whether they have VIP.
        if (data.groupHeld === true) return;
        const exp = date(data.expiration);
        if (exp !== undefined) set(key, at, exp, true);
        return;
      }
      case "seed.reward":
      case "game.reward":
      case "enforcer.vip": {
        if (data.groupHeld === true) return;
        // Rewards record the expiry that LANDED; one with none moved no VIP (points only, or
        // absorbed by a permanent grant). Never read as a downgrade of a permanent: the store
        // refuses to date one, so a date written beside it is the request, not the row.
        if (typeof data.expiration !== "string") return;
        const exp = date(data.expiration);
        if (exp === undefined || exp === null) return;
        if (held.get(key)?.exp === null) return;
        set(key, at, exp, true);
        return;
      }
      case "vip.reduce": {
        // Time taken from the balance frozen under a group perk's hold: the grant stays permanent
        // while they are listed, so whether they have VIP did not change.
        if (data.groupHeld === true) return;
        // `after` null means the reduction used the grant up: the VIP ended here.
        const exp = date(data.after);
        if (data.after === null || data.after === undefined || exp === null) { close(key, at); return; }
        if (exp !== undefined) set(key, at, exp, false);
        return;
      }
      case "vip.revoke":
        // The VIP sync taking an entry off the game: the grant had already lapsed (its date ended
        // it) or is paused and stays on the books. Nor does a revoke of the VIP of their own frozen
        // under a group perk's hold: the group's permanent stands. Every other revoke ends the grant.
        if (data.reconcile === true || data.groupHeld === true) return;
        close(key, at);
        return;
      case "vip.expire":
        close(key, at);
        return;
      case "vip.group_hold":
        // Permanent for as long as they stay in the group.
        set(key, at, null, true);
        return;
      case "vip.group_release": {
        // The hold hands back a dated grant (the frozen balance and any severance), or nothing.
        const exp = date(data.expiration);
        if (typeof data.expiration !== "string" || exp === undefined || exp === null) { close(key, at); return; }
        set(key, at, exp, true);
        return;
      }
      default:
        return;
    }
  };

  const finish = (listed: VipListedRow[]): VipStretch[] => {
    const now = opts.now;
    // Still running: counted up to now, and measured against when it is set to end. A month's
    // grant made ten minutes ago is a month's grant, not a ten-minute one.
    for (const key of [...held.keys()]) {
      lapse(key, now);
      const h = held.get(key);
      if (!h) continue;
      held.delete(key);
      const [serverId, playerId] = parts(key);
      if (now > h.since) runs.push({ serverId, playerId, from: h.since, to: now, ends: h.exp ?? Infinity, long: h.long });
    }
    // Today's list under the history: a row has stood since it was created, up to its date (or
    // now). The expiry sweep deletes a row once its date passes, so a row that is still here has
    // not lapsed since then, and a grant that left no grant row of its own still counts. A rule's
    // row is the exception: renewed by every crash, it has stood as long as the renewals have, and
    // the history says what those were.
    for (const v of listed) {
      if (opts.serverId && v.serverId !== opts.serverId) continue;
      const from = Date.parse(v.createdAt);
      const exp = date(v.expiration);
      const ends = exp === null || exp === undefined ? Infinity : exp;
      const to = Math.min(ends, now);
      const long = v.createdByName !== RULE_VIP_CREATOR && ends - from >= VIP_STRETCH_MIN_MS;
      if (Number.isFinite(from) && to > from) runs.push({ serverId: v.serverId, playerId: v.playerId, from, to, ends, long });
    }
    // Merge each player's runs on each server, then keep the ones that lasted.
    const byKey = new Map<string, Run[]>();
    for (const r of runs) {
      const k = `${r.serverId}|${r.playerId}`;
      const list = byKey.get(k) ?? [];
      list.push(r);
      byKey.set(k, list);
    }
    const out: Run[] = [];
    for (const list of byKey.values()) {
      list.sort((a, b) => a.from - b.from);
      let cur: Run | null = null;
      for (const r of list) {
        if (cur && r.from <= cur.to) {
          cur.to = Math.max(cur.to, r.to);
          cur.ends = Math.max(cur.ends, r.ends);
          cur.long = cur.long || r.long;
          continue;
        }
        if (cur) out.push(cur);
        cur = { ...r };
      }
      if (cur) out.push(cur);
    }
    return out.filter((r) => r.long && r.ends - r.from >= VIP_STRETCH_MIN_MS).map(({ ends: _ends, long: _long, ...s }) => s);
  };

  return { feed, finish };
}
