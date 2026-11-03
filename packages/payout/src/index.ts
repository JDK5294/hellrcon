/**
 * @app/payout — the bulk payout engine, pure.
 *
 * docs/bulk-payout.md has the decisions. It keeps the safety properties — per-recipient
 * accounting, a duplicate key, preview before execute — and stays clear of one structural
 * mistake: an engine that takes a discord.Interaction and reaches into it for the guild, the actor
 * and the progress display can only ever be driven from Discord. This package takes data and
 * returns decisions. The API routes drive it for the panel today and the Discord module drives it
 * later; neither is visible from here.
 *
 * Nothing in this file does I/O. Candidates arrive already annotated (who is linked, what roles
 * they hold, how long they were on), because the lookups belong to the caller — that is what
 * keeps every rule below unit-testable without a database or a Discord token.
 */

// The events list as a Discord post, and the schedule that sends it by itself — pure, and
// shared by the API's "Post now" and the worker's weekly one so they cannot disagree.
export * from "./announce.js";

/** What a payout pays. Two kinds, and they differ in WHO can receive (see `resolveRecipients`). */
export type PayoutKind = "currency" | "vip";

/** Who a VIP payout may reach. Currency has no choice to make — see `resolveRecipients`. */
export type PayoutAudience = "everyone" | "linked" | "role";

/** Where the candidate list came from. Recorded on the job so history reads as a sentence. */
export type PayoutSourceType = "linked" | "online" | "window" | "event" | "retry";

/**
 * One person the source produced, before the audience rules have spoken.
 *
 * `discordId` is null for a player with no Discord link — a real candidate for a VIP payout to
 * "everyone", never for currency. `playerId` is null for a linked member whose game account is
 * not on this game (currency can still reach them; VIP cannot land anywhere).
 */
export interface PayoutCandidate {
  discordId: string | null;
  playerId: string | null;
  displayName: string;
  /** The name the SOURCE saw (in-game name for presence sources), kept for the preview. */
  sourceName?: string | null;
  /** Discord role ids, when the caller looked them up; null means "could not ask", which is not
   *  the same as holding none — a role-audience resolve refuses on null rather than dropping. */
  roleIds?: string[] | null;
  /** Whole minutes present, for window sources — what the min-minutes rule reads. */
  minutes?: number;
}

/** A candidate that survived the audience rules — what preview shows and execute walks. */
export interface PayoutRecipient {
  discordId: string | null;
  playerId: string | null;
  displayName: string;
  sourceName: string | null;
  minutes: number | null;
  /**
   * The tier amount this recipient resolved to, set ONLY under a tiered payout. `null` means the
   * tier inherits the payout's base amount — kept as null rather than substituted here, because
   * the engine never sees the base amount and must not invent one.
   */
  amount?: number | null;
  /** Which tier's role matched, for the preview and the receipt — the WHY beside the amount. */
  tierRoleId?: string;
}

/**
 * One row of a role-tiered payout: holders of `roleId` receive `amount` (null = the payout's base
 * amount). Order is priority — a member holding several tier roles gets the FIRST match, so staff
 * put the generous tiers first ("Boosters 100, everyone-with-Member 50").
 */
export interface PayoutTier {
  roleId: string;
  amount: number | null;
}

export interface ResolveOptions {
  kind: PayoutKind;
  audience: PayoutAudience;
  /** Required when audience is "role". */
  roleId?: string | null;
  /**
   * Role tiers — per-role amounts. When present (non-empty) they take over the who-question
   * entirely: only linked members holding at least one tier's role are paid, each at their first
   * matching tier's amount, and `audience`/`roleId` are ignored (a tier IS a role restriction).
   */
  tiers?: PayoutTier[];
  /** Present for at least this many minutes (window sources). 0 / undefined = everyone counts. */
  minMinutes?: number;
  /** Recipients struck off by hand in the preview. Keys as `recipientKey` produces them. */
  removedKeys?: Iterable<string>;
}

export interface ResolveResult {
  recipients: PayoutRecipient[];
  /** Candidates the rules dropped, counted by why — the preview's "and 7 were unlinked" line.
   *  A payout that silently shrank is how "why didn't Dave get paid" tickets happen. */
  dropped: { unlinked: number; noRole: number; underMinutes: number; removed: number; noGameAccount: number };
}

/**
 * The identity a recipient is deduplicated and removed by.
 *
 * Discord id when there is one — that is the account currency lands on, and one person must not
 * appear twice because two game accounts hang off their Discord. Player id otherwise (an
 * unlinked VIP recipient has nothing else). Prefixed so the two id spaces cannot collide.
 */
export function recipientKey(c: { discordId: string | null; playerId: string | null }): string {
  return c.discordId ? `d:${c.discordId}` : `p:${c.playerId ?? ""}`;
}

/**
 * Apply the audience rules to a candidate list. Pure, order-stable, and the ONLY place the
 * who-can-receive policy lives:
 *
 *  - **Currency reaches linked users only.** Not a preference: currency is a balance on a
 *    Discord account, and an unlinked player has no row to credit. The audience field is
 *    ignored for currency rather than trusted — a caller cannot widen this by passing
 *    "everyone".
 *  - **VIP** honours the audience: everyone / linked / holding a given Discord role. A role is
 *    a Discord attribute, so "role" implies linked. A VIP recipient must also have a game
 *    account (`playerId`), or there is nowhere to land the grant.
 *  - A candidate whose roles could not be fetched (`roleIds: null`) under a role audience or a
 *    tiered payout is REFUSED — the resolve throws rather than quietly paying a shorter list,
 *    because "Discord was down" must not become "those people held no role".
 *  - **Tiers** (per-role amounts) take over the who-question when present: only linked members
 *    holding at least one tier's role are paid, each at their FIRST matching tier's amount, and
 *    the audience field is ignored — a tier is a role restriction with an amount attached.
 */
export function resolveRecipients(candidates: PayoutCandidate[], opts: ResolveOptions): ResolveResult {
  const tiers = opts.tiers?.length ? opts.tiers : null;
  if (!tiers && opts.audience === "role" && !opts.roleId) throw new Error("a role audience needs a role");
  const dropped = { unlinked: 0, noRole: 0, underMinutes: 0, removed: 0, noGameAccount: 0 };
  const removed = new Set(opts.removedKeys ?? []);
  const minMinutes = Math.max(0, Math.floor(opts.minMinutes ?? 0));
  const byKey = new Map<string, PayoutRecipient>();

  /*
   * ONE PERSON FIRST, then the rules.
   *
   * A candidate is a game ACCOUNT, and this app deliberately knows that one Discord can own
   * several of them (it is what the ban-evasion tripwire is built on). The rules used to run per
   * account and dedupe afterwards, which made the two that ask about a PERSON answer wrongly:
   * someone who played 20 minutes on one account and 25 on another was judged as two 20-and-25s
   * and dropped by a 30-minute floor, and the preview's "and 7 were unlinked" counted accounts
   * rather than people. Folding first makes each rule see the person it is asking about.
   *
   * Minutes fold as the MAX, not the sum: two of a person's accounts can be connected at once,
   * and inventing presence nobody had is the worse error of the two. (It also fixes the old
   * behaviour of keeping whichever sighting happened to arrive last.)
   */
  const folded: PayoutCandidate[] = [];
  const foldedByKey = new Map<string, PayoutCandidate>();
  for (const c of candidates) {
    const key = recipientKey(c);
    const prev = foldedByKey.get(key);
    if (!prev) {
      const copy: PayoutCandidate = { ...c };
      foldedByKey.set(key, copy);
      folded.push(copy);
      continue;
    }
    // First sighting wins on the name; presence beats absence on the ids and the roles, so a
    // linked candidate arriving after their unlinked duplicate carries both ids.
    prev.discordId = prev.discordId ?? c.discordId ?? null;
    prev.playerId = prev.playerId ?? c.playerId ?? null;
    prev.sourceName = prev.sourceName ?? c.sourceName ?? null;
    prev.roleIds = prev.roleIds ?? c.roleIds;
    if (c.minutes !== undefined) prev.minutes = Math.max(prev.minutes ?? 0, c.minutes);
  }

  for (const c of folded) {
    if (minMinutes > 0 && (c.minutes ?? 0) < minMinutes) { dropped.underMinutes++; continue; }
    if (opts.kind === "currency" || tiers || opts.audience !== "everyone") {
      if (!c.discordId) { dropped.unlinked++; continue; }
    }
    if (opts.kind === "vip" && !c.playerId) { dropped.noGameAccount++; continue; }
    let tier: PayoutTier | undefined;
    if (tiers) {
      if (c.roleIds === null || c.roleIds === undefined) {
        throw new Error(`could not read Discord roles for ${c.displayName} — refusing to guess who holds a tier's role`);
      }
      tier = tiers.find((t) => c.roleIds!.includes(String(t.roleId)));
      if (!tier) { dropped.noRole++; continue; }
    } else if (opts.kind === "vip" && opts.audience === "role") {
      if (c.roleIds === null || c.roleIds === undefined) {
        throw new Error(`could not read Discord roles for ${c.displayName} — refusing to guess who holds the role`);
      }
      if (!c.roleIds.includes(String(opts.roleId))) { dropped.noRole++; continue; }
    }
    const key = recipientKey(c);
    if (removed.has(key)) { dropped.removed++; continue; }
    byKey.set(key, {
      discordId: c.discordId ?? null,
      playerId: c.playerId ?? null,
      displayName: c.displayName,
      sourceName: c.sourceName ?? null,
      minutes: c.minutes ?? null,
      ...(tier ? { amount: tier.amount, tierRoleId: tier.roleId } : {}),
    });
  }
  const recipients = [...byKey.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) ||
    recipientKey(a).localeCompare(recipientKey(b)));
  return { recipients, dropped };
}

/** One completed presence interval, as `player_sessions` stores it. */
export interface SessionInterval {
  playerId: string;
  connectedAt: string;
  disconnectedAt: string;
}

/**
 * Fold session intervals into per-player minutes inside a window — the "who was on between X
 * and Y" source, from exact intervals rather than five-minute samples (decision 3 in
 * docs/bulk-payout.md). Only the overlap with the window counts, so a six-hour session around a
 * two-hour event contributes two hours, and someone still connected can be included by passing
 * their open session with `disconnectedAt: now`.
 */
export function windowMinutes(sessions: SessionInterval[], fromIso: string, toIso: string): Map<string, number> {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const out = new Map<string, number>();
  if (!(from < to)) return out;
  for (const s of sessions) {
    const a = Math.max(from, Date.parse(s.connectedAt));
    const b = Math.min(to, Date.parse(s.disconnectedAt));
    if (!(a < b)) continue;
    out.set(s.playerId, (out.get(s.playerId) ?? 0) + (b - a));
  }
  for (const [k, ms] of out) out.set(k, Math.floor(ms / 60_000));
  return out;
}

export interface DuplicateKeyInput {
  sourceType: PayoutSourceType;
  sourceRef: string;
  kind: PayoutKind;
  amount: number;
  /** VIP target servers; irrelevant to currency and normalised away there. */
  serverIds: string[];
  recipients: { discordId: string | null; playerId: string | null }[];
  /** Role tiers, when the payout is tiered — order kept, because order is priority. */
  tiers?: PayoutTier[];
}

/**
 * The identity of a payout, for refusing to run the same one twice — the duplicate key,
 * checked both in memory (a double-click) and against the jobs table (a re-run after a restart).
 * Same source, same kind, same amount, same targets, same tiers, same people = same key, whatever
 * order the people arrived in. (Tier ORDER stays in the key: it is priority, and reordering the
 * same rows genuinely pays different amounts.)
 */
export function duplicateKey(i: DuplicateKeyInput): string {
  const servers = i.kind === "vip" ? [...i.serverIds].sort().join(",") : "";
  const who = i.recipients.map(recipientKey).sort().join(",");
  // Appended, never inserted: an untiered payout's key must stay byte-identical to what every
  // job already in the table recorded, or re-running one of them stops being caught.
  const tiers = i.tiers?.length ? `|tiers:${i.tiers.map((t) => `${t.roleId}=${t.amount ?? ""}`).join(",")}` : "";
  return `${i.sourceType}:${i.sourceRef}:${i.kind}:${i.amount}:${servers}:${who}${tiers}`;
}

/* ------------------------------------------------------------------------------------------- *
 * Payout events — named windows whose boundaries resolve themselves.
 *
 * An event's window can be bounded two ways on each side: a hard timestamp, or the next match
 * boundary at/after an anchor time ("start when the first new round after 8pm starts", "end when
 * the round being played at 11pm finishes"). Presence is recorded by `player_sessions` whether or
 * not anyone is watching, so this scheduler only resolves WHEN the window is — a sweep that runs
 * late resolves the same boundaries it would have resolved on time, and loses nobody.
 * ------------------------------------------------------------------------------------------- */

export type PayoutEventStatus = "scheduled" | "open" | "closed" | "cancelled";
/** How a boundary resolves: at the anchor itself, or at the next match boundary at/after it. */
export type PayoutOpenMode = "at" | "match_start_after";
export type PayoutCloseMode = "at" | "match_end_after";

/** The scheduling half of an event row — all the transition function reads. */
export interface PayoutEventBounds {
  status: PayoutEventStatus;
  openMode: PayoutOpenMode;
  /** The configured time. Under "at" it IS the boundary; under a match mode it is where the
   *  match search begins. */
  openAnchor: string;
  /** The resolved boundary, once known. */
  openedAt: string | null;
  closeMode: PayoutCloseMode;
  closeAnchor: string;
  closedAt: string | null;
}

/** Match lookups the caller injects, already scoped to the event's server. Both mean "at or
 *  after": a round starting exactly on the anchor is the round the anchor asked for. */
export interface EventMatchLookups {
  /** startedAt of the earliest match with startedAt >= iso, or null if none yet. */
  firstMatchStartedAtOrAfter(iso: string): string | null | Promise<string | null>;
  /** endedAt of the earliest-ending FINISHED match with endedAt >= iso, or null if none yet. */
  firstMatchEndedAtOrAfter(iso: string): string | null | Promise<string | null>;
}

/** What one sweep decided for one event. Both fields can be set in a single pass — a sweep that
 *  slept through the whole event opens and closes it retroactively in one transition. */
export interface EventTransition {
  openedAt?: string;
  closedAt?: string;
}

const ms = (iso: string) => Date.parse(iso);

/**
 * The widest window anything here will read sessions for.
 *
 * Presence is read as raw intervals — every session row overlapping the window, folded in
 * memory — which is the right shape for an evening and the wrong shape for a decade. Nothing
 * bounded the span, so `{from: 2020, to: 2030}` asked the API to pull every session a server
 * ever recorded, from a route that only needs read level to preview. A quarter covers a whole
 * season or campaign, which is the widest thing anybody actually pays out on; past it the honest
 * answer is "narrow it", never a silently truncated list of who gets paid.
 */
export const MAX_WINDOW_DAYS = 92;
export const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 86_400_000;


/**
 * Decide which boundaries of one event have become resolvable — the entire scheduler policy,
 * pure. The worker sweep and the API's resolve-on-read both call this and apply whatever it
 * returns, so there is exactly one definition of when an event opens and closes.
 *
 *  - **Open "at"**: resolves once now reaches the anchor, and the boundary is the ANCHOR, not
 *    the sweep time — a poller that wakes late must not shrink the window.
 *  - **Open "match_start_after"**: resolves when a match with startedAt >= anchor exists; the
 *    boundary is that match's start, so an 8pm event doesn't slice into the round already
 *    underway at 8pm.
 *  - **Close "at"**: the anchor, clamped to no earlier than openedAt. The clamp matters when a
 *    match-mode open resolved AFTER the close anchor (no round started until later): the event
 *    closes with an empty window instead of a negative one.
 *  - **Close "match_end_after"**: the endedAt of the first match to END at/after the anchor
 *    (same clamp) — the round being played at closing time finishes and counts.
 *
 * Returns null when nothing changed. Closed/cancelled events never transition.
 */
export async function resolveEventBoundaries(
  ev: PayoutEventBounds,
  nowIso: string,
  matches: EventMatchLookups,
): Promise<EventTransition | null> {
  if (ev.status === "closed" || ev.status === "cancelled") return null;
  const now = ms(nowIso);
  const t: EventTransition = {};

  let openedAt = ev.openedAt;
  if (ev.status === "scheduled") {
    if (ev.openMode === "at") {
      if (now >= ms(ev.openAnchor)) t.openedAt = openedAt = ev.openAnchor;
    } else {
      const s = await matches.firstMatchStartedAtOrAfter(ev.openAnchor);
      if (s != null) t.openedAt = openedAt = s;
    }
    if (!openedAt) return null; // still waiting to open; the close side cannot resolve first
  }
  if (!openedAt) throw new Error("an open payout event has no openedAt — the row is corrupt");

  const closeFrom = ms(ev.closeAnchor) >= ms(openedAt) ? ev.closeAnchor : openedAt;
  if (ev.closeMode === "at") {
    if (now >= ms(closeFrom)) t.closedAt = closeFrom;
  } else {
    const e = await matches.firstMatchEndedAtOrAfter(closeFrom);
    if (e != null) t.closedAt = e;
  }
  /**
   * The safety close: an event closes when its boundary resolves, or at the maximum span,
   * whichever comes first.
   *
   * A `match_end_after` event on a server that then runs no rounds has no boundary to find, so it
   * stayed open forever — and an open event's window is [openedAt, now], which grows without
   * limit. Every read of it (the report, paying it live) folds raw session intervals over that
   * window, so "nobody closed it" quietly became the unbounded read that MAX_WINDOW_DAYS exists
   * to prevent. Bounding it HERE makes every window in the system bounded by construction rather
   * than by a guard at each read site, and the event still closes with a real roster instead of
   * being stuck until somebody cancels it and loses the payout.
   *
   * An `at` close cannot reach this: its anchor is validated within the span of the open anchor.
   */
  if (!t.closedAt && now - ms(openedAt) >= MAX_WINDOW_MS) {
    t.closedAt = new Date(ms(openedAt) + MAX_WINDOW_MS).toISOString();
  }
  return t.openedAt || t.closedAt ? t : null;
}

/** A pending event as the sweep needs it — a structural slice of the store's row, so this
 *  package never imports the store. */
export interface PayoutEventRecord extends PayoutEventBounds {
  id: string;
  serverId: string;
}

/** The slice of the repository the sweep reads and writes. Declared structurally so the real
 *  `Repository` satisfies it without this package depending on @app/db. */
export interface EventSweepStore {
  payoutEvents: {
    pending(): Promise<PayoutEventRecord[]>;
    applyTransition(id: string, t: { openedAt?: string; closedAt?: string; roster?: { playerId: string; name: string | null; minutes: number }[] }): Promise<unknown>;
  };
  matches: {
    firstStartedAfter(serverId: string, iso: string): Promise<{ startedAt: string } | null>;
    firstEndedAfter(serverId: string, iso: string): Promise<{ endedAt: string | null } | null>;
  };
  sessions: {
    inWindow(serverId: string, fromIso: string, toIso: string): Promise<SessionInterval[]>;
    /** playerId -> connectedAt for sessions still open (only CLOSED ones are in the table). */
    openOnServer(serverId: string): Promise<Map<string, string>>;
  };
  players: {
    findByIds(ids: string[]): Promise<{ id: string; name: string | null; platformId: string }[]>;
  };
}

/**
 * Resolve every pending event's boundaries and persist what changed — the whole scheduler, one
 * sweep. The worker runs this on a timer; the API runs it before reading events, so the states
 * are correct even with no worker alive. Idempotent and race-safe: the decisions come from
 * `resolveEventBoundaries` (deterministic for a given now) and `applyTransition` is
 * status-guarded, so two sweeps racing just means one of them matches zero rows.
 *
 * When a close resolves, the who-was-there roster is materialised onto the row AT THAT MOMENT:
 * closed sessions inside the window plus still-open ones clipped to it — so the event outlives
 * session trimming, and someone still connected at the whistle is not lost for lacking a
 * disconnect row yet.
 */
export async function sweepPayoutEvents(store: EventSweepStore, nowIso = new Date().toISOString()): Promise<{ opened: number; closed: number }> {
  let opened = 0;
  let closed = 0;
  for (const ev of await store.payoutEvents.pending()) {
    const t = await resolveEventBoundaries(ev, nowIso, {
      firstMatchStartedAtOrAfter: async (iso) => (await store.matches.firstStartedAfter(ev.serverId, iso))?.startedAt ?? null,
      firstMatchEndedAtOrAfter: async (iso) => (await store.matches.firstEndedAfter(ev.serverId, iso))?.endedAt ?? null,
    });
    if (!t) continue;
    let roster: { playerId: string; name: string | null; minutes: number }[] | undefined;
    if (t.closedAt) {
      const from = t.openedAt ?? ev.openedAt!; // a close always has an open, new or standing
      const openNow = await store.sessions.openOnServer(ev.serverId);
      const intervals = [
        ...(await store.sessions.inWindow(ev.serverId, from, t.closedAt)),
        ...[...openNow.entries()].map(([playerId, connectedAt]) => ({ playerId, connectedAt, disconnectedAt: nowIso })),
      ];
      const minutes = windowMinutes(intervals, from, t.closedAt);
      const players = await store.players.findByIds([...minutes.keys()]);
      const nameOf = new Map(players.map((p) => [p.id, p.name || p.platformId]));
      roster = [...minutes.entries()]
        .map(([playerId, m]) => ({ playerId, name: nameOf.get(playerId) ?? null, minutes: m }))
        .sort((a, b) => b.minutes - a.minutes || a.playerId.localeCompare(b.playerId));
    }
    await store.payoutEvents.applyTransition(ev.id, { ...t, ...(roster ? { roster } : {}) });
    if (t.openedAt) opened++;
    if (t.closedAt) closed++;
  }
  return { opened, closed };
}

/**
 * The gate in front of creating an event. Anchors in the past are deliberately legal — sessions
 * are recorded regardless, so "pay out last night" is a feature, not a mistake (decision 3 in
 * docs/bulk-payout.md).
 */
export function validateEventSchedule(ev: {
  openMode: PayoutOpenMode; openAnchor: string;
  closeMode: PayoutCloseMode; closeAnchor: string;
}): void {
  if (ev.openMode !== "at" && ev.openMode !== "match_start_after") throw new Error("openMode must be at or match_start_after");
  if (ev.closeMode !== "at" && ev.closeMode !== "match_end_after") throw new Error("closeMode must be at or match_end_after");
  const open = ms(ev.openAnchor);
  const close = ms(ev.closeAnchor);
  if (!Number.isFinite(open)) throw new Error("openAnchor is not a time");
  if (!Number.isFinite(close)) throw new Error("closeAnchor is not a time");
  if (close < open) throw new Error("the close anchor is before the open anchor");
  if (ev.openMode === "at" && ev.closeMode === "at" && close === open) {
    throw new Error("the window is zero minutes wide"); // equal anchors are fine for match modes: "the first round after 8pm" opens and closes one round
  }
  // Bounded for the reason above. Checked on the ANCHORS, which is what staff chose; a match-mode
  // boundary lands near its anchor, so this bounds the resolved window as well in every case
  // short of a server that runs no rounds for a quarter.
  if (close - open > MAX_WINDOW_MS) {
    throw new Error(`an event can span at most ${MAX_WINDOW_DAYS} days — this one is ${Math.round((close - open) / 86_400_000)}`);
  }
}

export interface ExecutionRequest {
  kind: PayoutKind;
  amount: number;
  serverIds: string[];
  recipients: PayoutRecipient[];
  previewReady: boolean;
  /** Role tiers, when the payout is tiered — validated so no tier can pay zero or a fraction. */
  tiers?: PayoutTier[];
}

/**
 * The gate in front of execute. Everything here is also enforced item-by-item downstream; this
 * exists so a request that cannot possibly succeed is refused whole, with a reason a person can
 * act on, before any row is written.
 */
export function validateExecution(req: ExecutionRequest): void {
  if (!req.previewReady) throw new Error("preview the recipients before executing");
  if (!req.recipients.length) throw new Error("there are no eligible recipients");
  if (req.kind !== "currency" && req.kind !== "vip") throw new Error("pick a payout type");
  for (const t of req.tiers ?? []) {
    if (!t.roleId) throw new Error("every tier needs a role");
    if (t.amount !== null && (!Number.isInteger(t.amount) || t.amount <= 0)) {
      throw new Error("a tier's amount must be blank (the base amount) or a whole number above zero");
    }
  }
  /*
   * The base amount is required only when something can actually READ it.
   *
   * A blank tier means "pay the base", so the base matters the moment one tier is left blank — and
   * not before. When every tier carries its own amount the base is never consulted (the executor
   * resolves `tier.amount ?? base`), and demanding one anyway asks for a number that cannot reach
   * anybody. That is not a hypothetical: pricing two roles and leaving the base empty is the
   * obvious way to use this feature, and it left the Pay button refusing a payout that was complete.
   */
  const tiers = req.tiers ?? [];
  const basePays = !tiers.length || tiers.some((t) => t.amount === null);
  if (!Number.isInteger(req.amount) || req.amount < 0) throw new Error("the amount must be a whole number");
  if (basePays && req.amount <= 0) {
    throw new Error(tiers.length
      ? "a tier left blank pays the base amount, so the base amount is needed — set it, or give every tier its own"
      : "the amount must be a whole number above zero");
  }
  if (req.kind === "vip" && !req.serverIds.length) throw new Error("pick at least one server for a VIP payout");
  if (req.kind === "currency") {
    const unlinked = req.recipients.filter((r) => !r.discordId).length;
    if (unlinked) throw new Error(`${unlinked} recipient(s) have no Discord link — currency cannot land anywhere for them`);
  }
  if (req.kind === "vip") {
    const homeless = req.recipients.filter((r) => !r.playerId).length;
    if (homeless) throw new Error(`${homeless} recipient(s) have no game account — VIP cannot land anywhere for them`);
  }
}

/** A payout run as the events list reads it — a structural slice of the store's job row, so this
 *  package never imports the store. */
export interface EventPayoutRun {
  id: string;
  sourceType: string;
  sourceRef: Record<string, unknown>;
  dryRun: boolean;
  status: "RUNNING" | "COMPLETE" | "COMPLETE_WITH_FAILURES" | "INTERRUPTED";
  createdAt: string;
  completedAt: string | null;
  failedCount: number;
}

/**
 * Whether an event has been paid, as the events list shows it. A state and a count, never an
 * amount or a name: reading events does not take the payout permission, so what was paid, and to
 * whom, stays on the Payouts screen.
 */
export interface EventPayment {
  /** paying: a run is going now. paid: every payout made for the event reached everyone on its
   *  list. part: a payout left people unpaid — failures, or a run cut off part-way — which its
   *  retry on the Payouts screen pays. */
  state: "paying" | "paid" | "part";
  /** People the finished runs left unpaid: each payout's latest run, failed and never reached. */
  unpaid: number;
  /** While paying, when the running run started; otherwise when the latest run finished. */
  at: string;
}

/**
 * Each event's payment, from the runs made for it: its event payouts, and the retries down each
 * one's chain. A retry names the run it retried (`sourceRef.jobId`), and since retries began
 * recording it, the payout at the head of the chain (`rootJobId`); either leads back to the event.
 *
 * A payout stands where its LATEST run left it. A retry is handed the people the run before it did
 * not reach, and anyone it finds already paid under the chain counts as reached, so the newest run
 * says how many are still owed: an interrupted payout retried to the end is paid, and one whose
 * retry failed again is owed what that retry failed. Ties on the start time keep the order given.
 *
 * Dry runs are skipped: a rehearsal pays nobody, so it neither pays an event nor leaves anyone owed.
 */
export function eventPayments(runs: EventPayoutRun[]): Map<string, EventPayment> {
  const real = runs.filter((r) => !r.dryRun);
  const byId = new Map(real.map((r) => [r.id, r]));
  /** The event payout at the head of a run's chain, or null for a run that is not part of one. */
  const headOf = (run: EventPayoutRun): EventPayoutRun | null => {
    let cur: EventPayoutRun | undefined = run;
    // No chain is longer than the runs there are, so a loop in the data cannot hang the list.
    for (let hops = 0; cur?.sourceType === "retry" && hops <= real.length; hops++) {
      const up: unknown = cur.sourceRef.rootJobId ?? cur.sourceRef.jobId;
      cur = typeof up === "string" ? byId.get(up) : undefined;
    }
    return cur?.sourceType === "event" && typeof cur.sourceRef.eventId === "string" ? cur : null;
  };
  /** Each payout's newest run, by the payout's id. */
  const latest = new Map<string, { eventId: string; run: EventPayoutRun }>();
  for (const run of real) {
    const head = headOf(run);
    if (!head) continue;
    const seen = latest.get(head.id);
    if (!seen || run.createdAt >= seen.run.createdAt) latest.set(head.id, { eventId: head.sourceRef.eventId as string, run });
  }
  const perEvent = new Map<string, EventPayoutRun[]>();
  for (const { eventId, run } of latest.values()) perEvent.set(eventId, [...(perEvent.get(eventId) ?? []), run]);

  const out = new Map<string, EventPayment>();
  for (const [eventId, newest] of perEvent) {
    const running = newest.filter((r) => r.status === "RUNNING");
    const finished = newest.filter((r) => r.status !== "RUNNING");
    const unpaid = finished.reduce((n, r) => n + r.failedCount, 0);
    const lastOf = (times: string[]): string => times.reduce((a, b) => (b > a ? b : a));
    out.set(eventId, running.length
      ? { state: "paying", unpaid, at: lastOf(running.map((r) => r.createdAt)) }
      : { state: unpaid > 0 ? "part" : "paid", unpaid, at: lastOf(finished.map((r) => r.completedAt ?? r.createdAt)) });
  }
  return out;
}
