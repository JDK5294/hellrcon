/**
 * Find paid permanent VIP grants that automation later dated or destroyed.
 *
 * The incident this answers, seen twice in the field: staff grant PERMANENT VIP (bought with
 * real money), an automated writer rewrites the row's expiration to a date, and the expiry
 * sweep later removes the grant from the game — correctly, by the date it finds. The write
 * that did the damage never shows on the screens staff investigate with, so the loss reads as
 * a mystery. The store now refuses that write (NewVip.replacePermanent), but rows poisoned
 * BEFORE the floor existed are still out there: some already swept away, some sitting as time
 * bombs that will expire in the coming days. This scan finds both from the audit trail the app
 * has kept all along.
 *
 * The rule, per (server, player): find the latest HUMAN act that made the grant permanent.
 * If no HUMAN act since then replaced or ended it — a dated re-grant, a revoke, a reduction
 * are all a person deciding — then the grant should still be permanent today. A current row
 * with a date is a DOWNGRADED grant (with the date it will die); a missing row is a LOST one.
 * Every automated write between the permanent grant and now rides along as evidence, so the
 * finding reads as a receipt, not an accusation.
 *
 * Human vs automated is the audit table's own `automated` flag, stamped at write time — a
 * person always acts through an account, the app never does.
 *
 * One refinement from a THIRD field sighting: the anchor does not have to be a person. An
 * automated PERMANENT write — the reconciler restoring a grant to the game, the importer
 * carrying one in from an archive — is proof the book of record held a permanent at that
 * instant, because those writers only ever copy what the book (or the archive) already says.
 * Requiring a human anchor blinded the scan to every permanent that ENTERED through a sync or
 * an import: a vip-sync-restored permanent flattened by the pre-floor seed reward never made
 * the findings list, and the restore button that exists for exactly this damage never
 * appeared. A story may now START from either kind of permanent write; only a person ever
 * ENDS one.
 */

import { storedVipExpiration } from "@app/db";

/** The slice of an audit row the scan reads. */
export interface VipAuditEvent {
  ts: string;
  action: string;
  automated: boolean;
  actorName: string;
  serverId: string | null;
  targetId: string | null;
  targetName?: string | null;
  data?: Record<string, unknown> | null;
}

/** The slice of a current VIP row the verdict compares against. */
export interface VipCurrentRow { serverId: string; playerId: string; playerName: string | null; expiration: string | null }

export interface VipIntegrityFinding {
  serverId: string;
  playerId: string;
  playerName: string | null;
  /**
   * "lost" = a permanent row is gone; "downgraded" = it stands but carries a date it should
   * not; "shortened" = a DATED grant automation moved earlier — real hours taken, however the
   * grant was earned, with `lostMs` saying exactly how many.
   */
  verdict: "lost" | "downgraded" | "shortened";
  /** When (and by whom) the entitlement this finding defends was established. */
  permanentSince: string;
  grantedBy: string;
  /** For "shortened": dated milliseconds automation took, summed across the story. */
  lostMs?: number;
  /** For a downgraded grant: the date it will be removed on unless restored first. */
  currentExpiration: string | null;
  /** The automated writes since the permanent grant, oldest first, as readable sentences. */
  evidence: string[];
}

const dstr = (d: Record<string, unknown> | null | undefined, k: string): string | null => {
  const v = (d ?? {})[k];
  return typeof v === "string" ? v : null;
};

/**
 * The scan, fed one audit row at a time in time order — so the route streams the whole VIP history
 * through it a page at a time (audit.vipTimeline) instead of holding it, or capping it: a capped
 * read taken oldest first dropped the NEWEST rows, where every dismissal and add-back is.
 */
export function vipIntegrityScanner(): { feed(e: VipAuditEvent): void; findings(current: VipCurrentRow[]): VipIntegrityFinding[] } {
  /*
   * One expiry TIMELINE per (server, player). `expected` is what the row's expiration should be
   * right now — null meaning permanent, undefined meaning no grant on the books. A person's
   * write of any kind resets the story to their decision (their call is the truth, and it
   * forgives nothing retroactively because the finding it might have generated is theirs to
   * make). An automated write may extend the timeline freely, but every automated write that
   * moves it EARLIER is time taken from a player, whoever earned the grant — the sum rides in
   * `lostMs` and each write in the evidence.
   */
  interface Track {
    since: string; by: string;
    expected: string | null | undefined;
    lostMs: number;
    humanEnded: boolean;
    evidence: string[];
    name: string | null;
    /** A story still owed something, carried through a group perk's hold (see vip.group_hold). */
    held?: boolean;
    /**
     * Every write since this DATED grant began is a rule's own VIP (crash VIP, the no-VIP trigger):
     * minutes a rule handed out for free and manages itself. Nothing in it was paid for or earned,
     * so moving it earlier is never time taken — two crash VIPs recorded a moment out of order read
     * as "time taken" and sent a crash-VIP-only player to the list. Any write someone paid for or
     * earned (a reward, the shop, a trigger, an import) clears it; a VIP sync copying the row back
     * to the game does not. Hours owed from an earlier grant stay owed either way.
     */
    ruleOnly?: boolean;
  }
  const tracks = new Map<string, Track>();
  const hoursOf = (ms: number) => Math.round(ms / 3_600_000);


  const feed = (e: VipAuditEvent): void => {
    /*
     * A banked VIP pause ending gives the frozen time back — the expiry moves LATER. Unread, the
     * story kept the pre-pause date as its baseline and could not see a later cut back into the
     * returned hours. It only ever extends a running dated story: it never starts one and never
     * shortens one. The lapse sweep writes one row per server (serverId + expiration); a staff
     * resume covers several servers in one row, listed under `banked`.
     */
    if (e.action === "player.vipresume") {
      const d = (e.data ?? {}) as { playerId?: unknown; banked?: unknown };
      const pid = typeof d.playerId === "string" ? d.playerId : e.targetId;
      const given = Array.isArray(d.banked)
        ? (d.banked as { serverId?: unknown; expiration?: unknown }[]).filter((b) => typeof b?.serverId === "string" && typeof b?.expiration === "string").map((b) => ({ serverId: b.serverId as string, expiration: b.expiration as string }))
        : e.serverId && dstr(e.data, "expiration") ? [{ serverId: e.serverId, expiration: dstr(e.data, "expiration")! }] : [];
      for (const b of given) {
        const t = pid ? tracks.get(`${b.serverId}|${pid}`) : undefined;
        if (!t || t.humanEnded || typeof t.expected !== "string") continue;
        // A pause ending on a year-3000 grant hands back a date in that range: still permanent.
        if (storedVipExpiration(b.expiration) === null) t.expected = null;
        else if (b.expiration > t.expected) t.expected = b.expiration;
      }
      return;
    }
    if (!e.serverId || !e.targetId) return;
    const key = `${e.serverId}|${e.targetId}`;
    // Read as the store keeps it: CRCON's year-3000 "never expires" is permanent (null). A sync or
    // an import that copied one in anchors a PERMANENT story, so automation dating it down reads
    // as the downgrade it is — restored as permanent, not as a few hundred thousand days added back.
    const expiration = storedVipExpiration(dstr(e.data, "expiration"));
    const t = tracks.get(key);
    const name = e.targetName ?? t?.name ?? null;

    /*
     * Group perks. A hold makes the grant permanent for as long as the player stays in the group —
     * the group's permanent, not one anybody bought or was given outright — so it closes the story
     * running before it: nothing in it is owed while they are held, and a hold ending is the perk
     * working, never damage. Its release hands back a DATED grant (the frozen balance plus any
     * severance), and that date starts a fresh story to defend like any other. Time granted while
     * held lands in the frozen balance, not on the row, so those writes are not part of any story.
     *
     * Except a story that is still OWED something: a permanent automation dated or swept away (a
     * hold only ever starts on a dated or missing row, so a story expecting permanent here is
     * already damage), or hours automation took. The hold is no person deciding that debt is
     * settled — closing it would hide the downgrade until the release dated the grant and the
     * sweep removed it, with nothing left to say why. That story rides through the hold (no
     * finding while the grant stands permanent) and the release carries it on.
     */
    if (e.action === "vip.group_hold") {
      if (t && !t.humanEnded && (t.expected === null || t.lostMs > 0)) {
        t.held = true;
        t.evidence.push(`${e.ts} — a group perk began holding the grant (permanent while they stay in the group)`);
        return;
      }
      tracks.set(key, { since: e.ts, by: e.actorName, expected: undefined, lostMs: 0, humanEnded: true, evidence: [], name });
      return;
    }
    if (e.action === "vip.group_release") {
      if (t?.held && !t.humanEnded) {
        t.held = false;
        t.evidence.push(`${e.ts} — the group perk let go of it${expiration ? `, dated ${expiration}` : ""}`);
        // A dated story goes on from the release's date; a permanent one still expects permanent.
        if (t.expected !== null) t.expected = expiration ?? undefined;
        return;
      }
      tracks.set(key, expiration
        ? { since: e.ts, by: e.actorName, expected: expiration, lostMs: 0, humanEnded: false, evidence: [], name }
        : { since: e.ts, by: e.actorName, expected: undefined, lostMs: 0, humanEnded: true, evidence: [], name });
      return;
    }
    if ((e.data as { groupHeld?: unknown } | null)?.groupHeld === true) {
      // A person taking the VIP of their own out from beneath the hold — all of it, or some time —
      // is still a person deciding, and it settles whatever the story was owed: the release starts
      // the next story, from the date it hands back. Time GRANTED while held changes no story; it
      // only waits in the frozen balance.
      if (!e.automated && (e.action === "vip.revoke" || e.action === "vip.reduce")) {
        tracks.set(key, { since: e.ts, by: e.actorName, expected: undefined, lostMs: 0, humanEnded: true, evidence: [], name });
      }
      return;
    }

    // A scheduled rule's revoke or cut is a decision too: a person configured it, for that group,
    // on that calendar — it is the rule doing what it was told, not automation taking time.
    const decided = !e.automated || (e.data as { decidedByRule?: unknown } | null)?.decidedByRule === true;
    if (decided) {
      // A person's decision defines the truth from here — permanent, dated, reduced or gone.
      if (e.action === "vip.grant") {
        tracks.set(key, { since: e.ts, by: e.actorName, expected: expiration, lostMs: 0, humanEnded: false, evidence: [], name });
      } else if (e.action === "vip.reduce") {
        // A reduction that used the grant up ended it — `after` is null then, which must not read
        // as "permanent" (that turned a deliberate refund into a "lost permanent VIP" finding).
        const after = dstr(e.data, "after");
        tracks.set(key, after
          ? { since: e.ts, by: e.actorName, expected: storedVipExpiration(after), lostMs: 0, humanEnded: false, evidence: [], name }
          : { since: e.ts, by: e.actorName, expected: undefined, lostMs: 0, humanEnded: true, evidence: [], name });
      } else if (e.action === "vip.revoke") {
        tracks.set(key, { since: e.ts, by: e.actorName, expected: undefined, lostMs: 0, humanEnded: true, evidence: [], name });
      } else if (e.action === "vip.integrity_ignore") {
        // A person looked at this exact story and judged the removal intentional. The story
        // closes — and closes only up to THIS instant: anything automation takes afterwards
        // starts a fresh story and surfaces on the next scan, so an old dismissal can never
        // swallow new damage.
        tracks.set(key, { since: e.ts, by: e.actorName, expected: undefined, lostMs: 0, humanEnded: true, evidence: [], name });
      }
      return;
    }

    const dryRun = (e.data as { dryRun?: boolean } | null)?.dryRun;
    if (dryRun) return;

    // An automated PERMANENT write is proof the book held a permanent at this instant (the
    // reconciler and the importers only copy what the book or the archive already says). It
    // anchors a story when none is running; a live story keeps its anchor and, since the write
    // can only happen while the book really is permanent, any accumulated dated story is
    // superseded. Never evidence — the safety net working.
    if (e.action === "vip.grant" && expiration === null) {
      // While a group perk holds the grant the row IS permanent: a sync restoring its game entry
      // is the safety net working on the group's permanent, and a story carried through the hold
      // keeps what it is owed.
      if (t?.held && !t.humanEnded) return;
      if (!t || t.humanEnded || t.expected !== null) {
        tracks.set(key, { since: t && !t.humanEnded && t.expected === null ? t.since : e.ts, by: t && !t.humanEnded && t.expected === null ? t.by : e.actorName, expected: null, lostMs: 0, humanEnded: false, evidence: t?.expected === null ? t.evidence : [], name });
      }
      return;
    }

    // game.reward moves an expiry exactly like seed.reward (top stats, streaks, days in a row).
    // Unread, a reward's extension was invisible: the story kept the older date as its baseline,
    // so a later automated cut back toward it read as no loss at all.
    // enforcer.vip is a rule's grant (crash VIP, the no-VIP trigger): the same kind of write.
    if (e.action === "vip.grant" || e.action === "seed.reward" || e.action === "game.reward" || e.action === "enforcer.vip" || e.action === "vip.reduce") {
      const wrote = e.action === "vip.reduce" ? storedVipExpiration(dstr(e.data, "after")) : expiration;
      if (wrote === null && e.action !== "vip.grant") return; // a reward absorbing into permanent writes nothing
      const ruleVip = e.action === "enforcer.vip";
      const syncCopy = e.action === "vip.grant" && (e.data as { reconcile?: unknown } | null)?.reconcile === true;
      if (!t || t.humanEnded || t.expected === undefined) {
        // A grant appearing with no story running — a seed reward earned fresh, a shop purchase,
        // an import or sync of a grant made elsewhere. It starts a DATED story: time earned is time
        // defended. A rule's own VIP starts one too, marked as nothing anybody paid for.
        // Hours automation took from a grant that has since lapsed are still owed: the new grant
        // carries them on (a fresh story here once wiped them, so a player cut and then given any
        // automated VIP later — a crash VIP, the next seed reward — dropped off the list).
        const owed = t && !t.humanEnded && t.lostMs > 0 ? t : undefined;
        if (wrote) tracks.set(key, { since: owed?.since ?? e.ts, by: owed?.by ?? e.actorName, expected: wrote, lostMs: owed?.lostMs ?? 0, humanEnded: false, evidence: owed?.evidence ?? [], name, ...(ruleVip ? { ruleOnly: true } : {}) });
        return;
      }
      if (t.expected === null) {
        // The flatten: a date written over a permanent. The permanent story keeps running —
        // the verdict comes from the CURRENT row at the end — and the write is the receipt.
        if (wrote) t.evidence.push(`${e.ts} — ${e.actorName === "seeding" ? "seed reward" : e.actorName === "game rewards" ? "game reward" : e.action === "enforcer.vip" ? "rule VIP" : e.actorName} wrote an expiration of ${wrote} over the grant`);
        return;
      }
      if (wrote && wrote < t.expected) {
        // Time taken counts only where somebody paid for or earned it: a rule's free minutes
        // moving around among themselves are nobody's loss.
        if (!t.ruleOnly) {
          const taken = Date.parse(t.expected) - Date.parse(wrote);
          t.lostMs += taken;
          t.evidence.push(`${e.ts} — ${e.actorName} moved the expiry earlier: ${t.expected} became ${wrote} (−${hoursOf(taken)}h)`);
        }
        t.expected = wrote;
      } else if (wrote) {
        t.expected = wrote; // a stack or extension — the ordinary business of rewards
      }
      if (t.ruleOnly && !ruleVip && !syncCopy) delete t.ruleOnly; // paid-for or earned time is in the story now
      return;
    }

    if (!t || t.humanEnded) return;
    if (e.action === "vip.expire") {
      if (t.expected === null) {
        t.evidence.push(`${e.ts} — the expiry sweep removed the grant (its stored date had passed)`);
      } else if (t.expected !== undefined) {
        // The sweep ending a dated grant ON TIME is the grant ending; any time already taken
        // stays owed, so the story survives to the verdict with `expected` cleared.
        t.expected = undefined;
      }
    } else if (e.action === "vip.revoke") {
      if (t.expected === null) {
        const why = dstr(e.data, "why");
        t.evidence.push(`${e.ts} — ${e.actorName} removed the game's VIP entry${why ? ` (the row read as ${why})` : ""}`);
      } else if (t.expected !== undefined) {
        t.expected = undefined;
      }
    }
  };

  const findings = (current: VipCurrentRow[]): VipIntegrityFinding[] => {
    const rowByKey = new Map(current.map((v) => [`${v.serverId}|${v.playerId}`, { ...v, expiration: storedVipExpiration(v.expiration) }]));
    const found: VipIntegrityFinding[] = [];
    for (const [key, t] of tracks) {
      if (t.humanEnded) continue;
      const [serverId, playerId] = key.split("|") as [string, string];
      const row = rowByKey.get(key);
      if (row && row.expiration === null) continue; // permanent stands — nothing was lost in the end
      if (t.expected === null) {
        // The permanent story: the row should be permanent and is not.
        found.push({
          serverId, playerId,
          playerName: row?.playerName ?? t.name,
          verdict: row ? "downgraded" : "lost",
          permanentSince: t.since, grantedBy: t.by,
          currentExpiration: row?.expiration ?? null,
          evidence: t.evidence,
        });
      } else if (t.lostMs > 0) {
        // The dated story: automation took real hours, whoever earned the grant.
        found.push({
          serverId, playerId,
          playerName: row?.playerName ?? t.name,
          verdict: "shortened",
          permanentSince: t.since, grantedBy: t.by,
          currentExpiration: row?.expiration ?? null,
          lostMs: t.lostMs,
          evidence: t.evidence,
        });
      }
    }
    // Lost first (the player is ALREADY without what they paid for), then downgraded and
    // shortened together by fuse: soonest expiration first — the order to work the list in.
    const rank = { lost: 0, downgraded: 1, shortened: 1 } as const;
    return found.sort((a, b) => {
      if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
      const ax = a.currentExpiration ?? "", bx = b.currentExpiration ?? "";
      if (ax !== bx) return ax.localeCompare(bx);
      return `${a.serverId}|${a.playerId}`.localeCompare(`${b.serverId}|${b.playerId}`);
    });
  };

  return { feed, findings };
}

export function auditVipIntegrity(events: VipAuditEvent[], current: VipCurrentRow[]): VipIntegrityFinding[] {
  const scan = vipIntegrityScanner();
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) scan.feed(e);
  return scan.findings(current);
}
