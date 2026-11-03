/**
 * Bulk payout — the app side of @app/payout's pure engine (docs/bulk-payout.md).
 *
 * Split of responsibilities, kept strict so the engine stays testable and the surfaces stay thin:
 *   @app/payout        decides WHO gets paid and whether a run may proceed (pure);
 *   this file          gathers candidates (queries, Discord), drives a job, writes receipts;
 *   routes/payouts.ts  HTTP: capability checks, request parsing, polling.
 *
 * Money moves through the paths that already carry it — economy.apply for currency (one write
 * path for balances, idempotent by ref) and shop.grantDays for VIP (cumulative, pause-aware,
 * permanent-guarded, audited). A payout is a LOOP over those, never a reimplementation: the
 * permanent-VIP downgrade bug was fixed in exactly one place, and a bulk path that wrote VIP
 * itself would put it back a hundred rows at a time.
 */
import {
  duplicateKey, resolveRecipients, sweepPayoutEvents, validateExecution, windowMinutes,
  type PayoutAudience, type PayoutCandidate, type PayoutKind, type PayoutRecipient, type PayoutSourceType, type PayoutTier,
} from "@app/payout";
import { communityGuild, guildMember } from "./discord-guild.js";
import { guildRoster } from "./discord-roster.js";
import { grantDays } from "./shop.js";
import { computeGrantExpiration } from "./routes/kit.js";
import { createLogger } from "@app/shared";
import type { AppContext } from "./context.js";
import { rewardsRefusedBy, type MatchRow, type PayoutEventRow, type PayoutJobRow, type PlayerRow, type Repository } from "@app/db";

const log = createLogger("payouts");

/** The pause between VIP grants (the old bot's vip_delay_seconds): each VIP grant opens a game connection, and a hundred of them
 *  back to back is a way to hurt a live server mid-event. Currency writes are our own DB.
 *  Env-tunable, so tests are not obliged to sleep. */
const VIP_DELAY_MS = Number.isFinite(Number(process.env.PAYOUT_VIP_DELAY_MS)) ? Number(process.env.PAYOUT_VIP_DELAY_MS) : 1500;

/** Above this many linked candidates, read the guild's whole member list instead of asking per
 *  person — see the note at the call site for why the crossover exists at all. */
const BULK_ROLE_LOOKUP_MIN = 25;
/** And above THIS many, per-person lookups are not a fallback worth attempting: they are
 *  serialised by the rate limiter, so the request would die of old age before answering. */
const MAX_PER_PERSON_ROLE_LOOKUPS = 150;

export interface PayoutSource {
  type: PayoutSourceType;
  /** online + window sources: which server's presence. */
  serverId?: string;
  /** window source. */
  from?: string;
  to?: string;
  minMinutes?: number;
  /** retry source: the job whose FAIL rows are being paid. */
  jobId?: string;
  /** event source: the named payout event being paid. */
  eventId?: string;
}

export interface PreviewRequest {
  source: PayoutSource;
  kind: PayoutKind;
  audience: PayoutAudience;
  roleId?: string | null;
  /** Role tiers (per-role amounts). When present they take over the who-question — see @app/payout. */
  tiers?: PayoutTier[];
  removedKeys?: string[];
}

/**
 * Gather candidates for a source. Everything the engine is not allowed to do lives here: the
 * queries, the Discord lookups, the per-game link fan-out.
 */
export async function buildCandidates(ctx: AppContext, req: PreviewRequest): Promise<PayoutCandidate[]> {
  const repo = ctx.repo;
  const src = req.source;
  let candidates: PayoutCandidate[];

  switch (src.type) {
    case "linked": {
      // Every Discord account with a link — one candidate per PERSON, however many game accounts
      // hang off them (the executor picks the right per-game account per server at grant time).
      const discordIds = await repo.externalLinks.distinctExternalIds("discord");
      candidates = [];
      for (const discordId of discordIds) {
        const players = await repo.externalLinks.findPlayers("discord", discordId);
        const member = await repo.economy.member(discordId);
        candidates.push({
          discordId,
          playerId: players[0]?.id ?? null,
          displayName: member?.discordName || players[0]?.name || discordId,
        });
      }
      break;
    }
    case "online": {
      if (!src.serverId) throw new Error("pick a server for an online payout");
      // "Online" is our own session state — the ingest opens and closes these within a minute of
      // the game. No RCON call, so a preview cannot disturb a live server, and it works the same
      // on an observe-mode connection.
      const open = await repo.sessions.openOnServer(src.serverId);
      candidates = await candidatesFromPlayers(repo, [...open.keys()], () => undefined);
      break;
    }
    case "window": {
      if (!src.serverId || !src.from || !src.to) throw new Error("a window payout needs a server and both bounds");
      if (Date.parse(src.from) >= Date.parse(src.to)) throw new Error("the window ends before it starts");
      candidates = await windowCandidates(repo, src.serverId, src.from, src.to);
      break;
    }
    case "event": {
      if (!src.eventId) throw new Error("pick the event being paid");
      // Resolve-on-read: an event whose boundaries became resolvable is opened/closed here even
      // if no worker is alive — the sweep is idempotent and its writes are status-guarded.
      await sweepPayoutEvents(repo);
      const ev = await repo.payoutEvents.get(src.eventId);
      if (!ev) throw new Error("no such payout event");
      if (ev.status === "cancelled") throw new Error("that event was cancelled");
      if (ev.status === "scheduled") throw new Error("that event has not opened yet");
      // The event's floor becomes the source's, unless the request set its own. Written back onto
      // the source so BOTH resolve calls (preview and execute) read it, and so the job's
      // sourceRef records the floor that actually applied.
      if (src.minMinutes === undefined) src.minMinutes = ev.minMinutes;
      if (ev.status === "closed" && ev.roster) {
        // The materialised list IS the record — the sessions behind it may be trimmed by now.
        const byId = new Map(ev.roster.map((r) => [r.playerId, r]));
        candidates = await candidatesFromPlayers(repo, [...byId.keys()], (id) => byId.get(id)?.minutes);
      } else {
        // Still open: who has been on since it opened, the people currently on included.
        candidates = await windowCandidates(repo, ev.serverId, ev.openedAt!, new Date().toISOString());
      }
      break;
    }
    case "retry": {
      if (!src.jobId) throw new Error("pick the payout whose failures are being retried");
      // An interrupted run's unreached people are its PENDING rows, owed exactly like its
      // failures. A RUNNING job's PENDING rows are still being paid by its driver, so there only
      // the failures qualify.
      const source = await repo.payouts.get(src.jobId);
      if (!source) throw new Error("that payout no longer exists");
      // A rehearsal paid nobody: "retrying" it would pay real people off a practice list — and only
      // the part of it that happened to fail or not be reached. Run the payout itself instead.
      if (source.dryRun) throw new Error("that was a dry run — it paid nobody, so there is nothing to retry. Run the payout itself instead.");
      const interrupted = source.status === "INTERRUPTED";
      const failed = await repo.payouts.failedItems(src.jobId, { includePending: interrupted });
      if (!failed.length) throw new Error(interrupted ? "that payout has nobody left to pay" : "that payout has no failed rows to retry");
      candidates = failed.map((i) => ({
        discordId: i.discordId,
        playerId: i.playerId,
        displayName: i.displayName || i.discordId || i.playerId || "unknown",
      }));
      break;
    }
    default:
      throw new Error("pick where the recipients come from");
  }

  // A role audience — and any TIERED payout, whatever it pays — needs each linked candidate's
  // roles. An UNAVAILABLE answer stays null throughout, so the engine refuses loudly instead of
  // reading "Discord was down" as "held no role".
  if ((req.kind === "vip" && req.audience === "role") || req.tiers?.length) {
    const guild = await communityGuild(repo);
    if (!guild.guildId) throw new Error("no community Discord server is configured — a role audience needs one");
    const linked = candidates.filter((c) => c.discordId);

    /*
     * One list, not one call per person.
     *
     * Asking per member is a Discord round trip each, and they all share a route key — so the
     * shared limiter puts them in a single bucket and runs them one at a time, pausing whenever
     * the window empties. That is the limiter behaving correctly; it is the CALLER that was wrong.
     * A tiered payout over "all linked members" therefore took minutes and blew through the
     * panel's request timeout, which is what "the preview button froze" was.
     *
     * Past a couple of dozen people the whole member list is cheaper than the lookups it replaces,
     * and it is one request for the first thousand. Below that the per-person path still wins,
     * because a small event should not pull an entire guild down the wire.
     */
    let roster: Map<string, string[]> | null = null;
    if (linked.length > BULK_ROLE_LOOKUP_MIN) {
      // Through the shared roster, so preview → dry run → pay is ONE member-list read rather than
      // three: the same three presses that used to be three full walks of the guild.
      const all = await guildRoster(guild.guildId);
      // Anything but a complete list stays unusable — a short answer must never be taken at face
      // value, since the people missing from it would read as holding no roles.
      if (all.kind === "roster") roster = all.byUser;
      /*
       * The list is the only way this finishes at scale, so when it is missing, SAY WHY.
       *
       * Falling back to per-person lookups above the cap just reproduces the original bug: a
       * minute of silence and then "the server did not respond", which names nothing anyone can
       * act on. Below the cap the fallback is genuinely fine — a few dozen lookups is seconds —
       * so it still runs there, and only a run that cannot finish is refused.
       *
       * The two failures need opposite advice, which is why they are told apart: a refused list is
       * a setting to change, a guild too large to page is a payout to narrow. Telling someone to
       * switch on an intent that is already on sends them to fix the wrong thing.
       */
      if (!roster && linked.length > MAX_PER_PERSON_ROLE_LOOKUPS) {
        // `roster` cannot reach here (it is what sets the map), but it is spelled out rather than
        // asserted away — a cast would go stale the moment a fourth outcome is added.
        const why = all.kind === "tooLarge"
          ? `the Discord server has more than ${all.seen} members, which is more than this can read in one request`
          : all.kind === "unavailable"
            ? `the Discord member list could not be read (${all.reason})`
            : "the Discord member list could not be read";
        throw new Error(
          `${why}, and asking about each of these ${linked.length} people separately would take longer than this request has. `
          + "Narrow the payout to a smaller source — an event, or the players online now.",
        );
      }
    }

    if (roster) {
      // The list is authoritative once it arrives: present means these roles, absent means not in
      // the guild, which is an empty set rather than an unknown.
      for (const c of linked) c.roleIds = roster.get(c.discordId!) ?? [];
    } else {
      const cache = new Map<string, string[] | null>();
      const lookup = async (discordId: string): Promise<string[] | null> => {
        if (cache.has(discordId)) return cache.get(discordId)!;
        const m = await guildMember(guild.guildId!, discordId);
        const roles = m.kind === "member" ? m.roleIds : m.kind === "notInGuild" ? [] : null;
        cache.set(discordId, roles);
        return roles;
      };
      const queue = [...linked];
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          c.roleIds = await lookup(c.discordId!);
        }
      }));
    }
  }
  return candidates;
}

/**
 * Who was on a server between two times, with per-player minutes. Exact intervals, not samples
 * (decision 3 in docs/bulk-payout.md). Sessions still open are clipped at now and unioned in, so
 * a payout run DURING the event sees the people currently on.
 */
async function windowCandidates(repo: Repository, serverId: string, fromIso: string, toIso: string): Promise<PayoutCandidate[]> {
  const closed = await repo.sessions.inWindow(serverId, fromIso, toIso);
  const nowIso = new Date().toISOString();
  const open = await repo.sessions.openOnServer(serverId);
  const all = [...closed, ...[...open.entries()].map(([playerId, connectedAt]) => ({ playerId, connectedAt, disconnectedAt: nowIso }))];
  const minutes = windowMinutes(all, fromIso, toIso);
  return candidatesFromPlayers(repo, [...minutes.keys()], (id) => minutes.get(id));
}

/** Players → candidates, with each player's Discord link looked up so audience rules can see it. */
async function candidatesFromPlayers(repo: Repository, playerIds: string[], minutesOf: (playerId: string) => number | undefined): Promise<PayoutCandidate[]> {
  if (!playerIds.length) return [];
  const players = await repo.players.findByIds(playerIds);
  const out: PayoutCandidate[] = [];
  for (const p of players) {
    const links = await repo.externalLinks.list(p.id);
    const discordId = links.find((l) => l.provider === "discord")?.externalId ?? null;
    const c: PayoutCandidate = { discordId, playerId: p.id, displayName: p.name || p.platformId, sourceName: p.name };
    const m = minutesOf(p.id);
    if (m !== undefined) c.minutes = m;
    out.push(c);
  }
  return out;
}

export interface ExecuteRequest extends PreviewRequest {
  amount: number;
  /** VIP target servers; ignored for currency. */
  serverIds: string[];
  dryRun: boolean;
}

export interface StartedJob {
  job: PayoutJobRow;
  /** Resolves when the run finishes — awaited by tests, fire-and-forget by the route. */
  done: Promise<void>;
}

/**
 * Validate, gate against duplicates, open the job, and start the run. The caller gets the job row
 * immediately and polls it; the run writes a receipt row per recipient as it goes, so a crash
 * mid-run leaves a ledger of exactly who was reached (status INTERRUPTED at next boot + the items
 * + retry = the recovery story).
 */
export async function startPayout(ctx: AppContext, req: ExecuteRequest, actor: { userId: string | null; name: string }): Promise<StartedJob> {
  // Re-resolve on the server rather than trusting a posted recipient list: the preview's list
  // rides along only as removals, so a tampered request cannot pay someone the rules exclude.
  const candidates = await buildCandidates(ctx, req);
  const { recipients } = resolveRecipients(candidates, {
    kind: req.kind, audience: req.audience, roleId: req.roleId, tiers: req.tiers,
    minMinutes: req.source.minMinutes, removedKeys: req.removedKeys,
  });
  validateExecution({ kind: req.kind, amount: req.amount, serverIds: req.serverIds, recipients, previewReady: true, tiers: req.tiers });

  const sourceRef = JSON.stringify({ ...req.source });
  const key = duplicateKey({
    sourceType: req.source.type, sourceRef, kind: req.kind, amount: req.amount,
    serverIds: req.serverIds, recipients, tiers: req.tiers,
  });
  // Every payment in a chain of retries is made under the ROOT payout's ref — see payVip.
  const rootJobId = req.source.type === "retry" && req.source.jobId ? await rootJobOf(ctx.repo, req.source.jobId) : null;
  // One real retry per root at a time. Two with different lists have different keys, and each
  // checks "already paid under the root?" before granting — run side by side, both could check
  // the same person before either granted, and VIP days add up.
  const rootLock = rootJobId ? `root:${rootJobId}` : null;
  // The claims are taken in the same tick as the checks — no await between them — or two clicks
  // landing together both pass the check before either claims, and the whole list is paid twice.
  // Every refusal and failure below gives them back: a claim left behind turns every later attempt
  // into "already running" until the next restart.
  const claims: string[] = [];
  if (!req.dryRun) {
    if (ctx.runningPayoutKeys.has(key)) throw new Error("this exact payout is already running");
    if (rootLock && ctx.runningPayoutKeys.has(rootLock)) throw new Error("another retry of that payout is still running — wait for it to finish, then retry whoever is left");
    claims.push(key, ...(rootLock ? [rootLock] : []));
    for (const c of claims) ctx.runningPayoutKeys.add(c);
  }
  const release = (): void => { for (const c of claims) ctx.runningPayoutKeys.delete(c); };

  let job: PayoutJobRow;
  try {
    if (!req.dryRun) {
      const existing = await ctx.repo.payouts.findDuplicate(key);
      if (existing?.status === "INTERRUPTED") {
        throw new Error(`this exact payout was cut off part-way (job ${existing.id}, ${existing.createdAt}) — running it again would pay everyone it already reached a second time. Retry it instead: that pays only the people it didn't reach.`);
      }
      if (existing) throw new Error(`this exact payout already ran (job ${existing.id}, ${existing.createdAt}) — change something real or retry its failures instead`);
    }
    job = await ctx.repo.payouts.create({
      // Tiers ride on the sourceRef jsonb so the job records the rule that priced each person —
      // history and retries read them back from here without a schema change.
      sourceType: req.source.type,
      sourceRef: { ...req.source, ...(rootJobId ? { rootJobId } : {}), ...(req.tiers?.length ? { tiers: req.tiers } : {}) } as Record<string, unknown>,
      payoutType: req.kind, amount: req.amount,
      serverIds: req.kind === "vip" ? req.serverIds : [],
      audience: req.kind === "currency" ? "linked" : req.audience,
      dryRun: req.dryRun, status: "RUNNING",
      requestedByUserId: actor.userId, requestedByName: actor.name,
      totalCount: recipients.length, duplicateKey: key,
    });
  } catch (err) {
    release();
    throw err;
  }

  const done = runJob(ctx, job, recipients, actor)
    .catch(async (err) => {
      log.error("payout run failed", { jobId: job.id, err: (err as Error).message });
      // A run that died mid-list (the database blinked) is exactly a cut-off run: close it as one,
      // tallied from its receipts, so "Pay the rest" is offered now rather than after a restart.
      // If the database is still down this fails too, and the next boot's interruptStale does it.
      const items = await ctx.repo.payouts.items(job.id, { limit: 100_000 }).catch(() => null);
      if (!items) return;
      const paid = items.filter((i) => i.status === "PASS").length;
      await ctx.repo.payouts.finish(job.id, { status: "INTERRUPTED", successCount: paid, failedCount: items.length - paid }).catch(() => {});
    })
    .finally(release);
  return { job, done };
}

async function runJob(ctx: AppContext, job: PayoutJobRow, recipients: PayoutRecipient[], actor: { userId: string | null; name: string }): Promise<void> {
  const repo = ctx.repo;
  const reason = historyReason(job);
  const root = rootOf(job);
  let success = 0;
  let failed = 0;

  // Everyone's receipt goes on the ledger as PENDING before anyone is paid, so a run cut off
  // part-way leaves exactly who it never reached — what its retry pays — rather than no row.
  const itemIds = await repo.payouts.openItems(job.id, recipients.map((r) => ({
    playerId: r.playerId, discordId: r.discordId, displayName: r.displayName,
  })));

  for (const [n, r] of recipients.entries()) {
    let status: "PASS" | "FAIL" = "PASS";
    let error = "";
    let detail: Record<string, unknown> = {};
    const pace = { touchedGame: false };
    // The tier's amount when the payout is tiered (null = the base amount); the job's otherwise.
    const amount = r.amount ?? job.amount;
    try {
      detail = job.payoutType === "currency"
        ? await payCurrency(repo, job, r, amount, reason, actor.name, root)
        : await payVip(repo, job, r, amount, reason, actor.name, root, pace);
      // The receipt says what THIS person was paid — under tiers that differs per row, and a
      // receipt that only pointed at the job's base amount would misstate most of them.
      if (r.tierRoleId) { detail.amount = amount; detail.tierRoleId = r.tierRoleId; }
      success++;
    } catch (err) {
      // One person's failure must not strand the rest — their row says FAIL and why, the loop
      // moves on, and retry pays exactly the FAIL rows later.
      status = "FAIL";
      error = (err as Error).message;
      failed++;
    }
    await repo.payouts.settleItem(itemIds[n]!, { status, error, detail });
    // The pacing — AFTER the receipt: these writes hit the live game server, and a restart
    // landing in the pause must find this person already on the ledger as paid.
    if (pace.touchedGame) await new Promise((resolve) => setTimeout(resolve, VIP_DELAY_MS));
  }

  await repo.payouts.finish(job.id, {
    status: failed === 0 ? "COMPLETE" : "COMPLETE_WITH_FAILURES",
    successCount: success, failedCount: failed,
  });
  // Tiered runs name the rule, not just the base figure — "50 points to 40 people" would
  // misdescribe a payout where the boosters got 100.
  const tiered = recipients.some((r) => r.tierRoleId);
  await repo.audit.create({
    actorUserId: actor.userId, actorName: actor.name, action: "economy.payout",
    targetType: "payout", targetId: job.id, targetName: null, serverId: null,
    summary: `${job.dryRun ? "dry-ran" : "ran"} a bulk payout: ${job.amount} ${job.payoutType === "vip" ? "VIP day(s)" : "point(s)"}${tiered ? " (tiered by role)" : ""} to ${recipients.length} recipient(s) (${success} ok, ${failed} failed)`,
    data: { jobId: job.id, payoutType: job.payoutType, amount: job.amount, tiered, dryRun: job.dryRun, success, failed },
  });
}

async function payCurrency(repo: Repository, job: PayoutJobRow, r: PayoutRecipient, amount: number, reason: string, actorName: string, root: string): Promise<Record<string, unknown>> {
  const discordId = r.discordId!; // validateExecution already refused unlinked currency recipients
  const cfg = await repo.economy.config();
  if (job.dryRun) {
    const member = await repo.economy.member(discordId);
    const before = member?.balance ?? 0;
    const after = cfg.balanceCap === null ? before + amount : Math.min(cfg.balanceCap, before + amount);
    return { balanceBefore: before, balanceAfter: after, capped: after - before < amount };
  }
  // Idempotent by ref: if this exact item already applied (a retried run, a crash between the
  // write and the receipt), apply() is a no-op that returns the standing entry — paid once, ever.
  // The ref names the ROOT payout, so a retry of an interrupted run is caught by it too.
  const out = await repo.economy.apply(
    { discordId, delta: amount, reason, ref: `payout:${root}:${discordId}`, actorName },
    { maxBalance: cfg.balanceCap },
  );
  return {
    balanceBefore: out.member.balance - (out.applied ? out.entry.delta : 0),
    balanceAfter: out.member.balance,
    applied: out.applied,
    capped: out.applied && out.entry.delta < amount,
  };
}

async function payVip(repo: Repository, job: PayoutJobRow, r: PayoutRecipient, amount: number, reason: string, actorName: string, root: string, pace: { touchedGame: boolean }): Promise<Record<string, unknown>> {
  const ref = `payout:${root}`;
  // Per-game link fan-out: one Discord account links one game account PER GAME, and the target
  // servers can span games. Each server gets the recipient's account for ITS game; a server with
  // no matching account is recorded as skipped rather than failing the whole person.
  const linkedPlayers: PlayerRow[] = r.discordId ? await repo.externalLinks.findPlayers("discord", r.discordId) : [];
  const soloPlayer = !r.discordId && r.playerId ? await repo.players.findById(r.playerId) : null;

  const servers: Record<string, unknown> = {};
  let landedAnywhere = false;
  let firstError: string | null = null;
  for (const serverId of job.serverIds) {
    const server = await repo.servers.findById(serverId);
    if (!server) { servers[serverId] = { skipped: "server no longer exists" }; continue; }
    const player = soloPlayer && soloPlayer.game === server.game
      ? soloPlayer
      : linkedPlayers.find((p) => p.game === server.game) ?? (soloPlayer ?? null);
    if (!player || player.game !== server.game) {
      servers[serverId] = { skipped: `no ${server.game} account` };
      continue;
    }
    const before = await repo.vips.get(server.id, player.platformId);
    // A retry can be paying someone its interrupted parent already granted here and was cut off
    // before recording. Every grant in the chain carries the root's ref, so the trail answers it:
    // one under that ref on this server means this server is paid. VIP days add up, so without
    // this a recovered run hands them out twice.
    if (job.sourceType === "retry" && await vipPaidUnder(repo, server.id, player.platformId, ref)) {
      servers[serverId] = { before: before?.expiration ?? null, after: before?.expiration ?? null, alreadyPaid: true };
      landedAnywhere = true;
      continue;
    }
    if (job.dryRun) {
      // A group perk's hold is permanent too, but the days are not lost on it: they bank — unless
      // the group's perk takes no rewards, when it absorbs them like permanent VIP of their own.
      const alreadyPermanent = Boolean(before) && before!.expiration === null
        && (!before!.groupHold || (await rewardsRefusedBy(repo, before!.groupHold)).length > 0);
      servers[serverId] = {
        before: before?.expiration ?? null,
        after: alreadyPermanent ? null : computeGrantExpiration({ mode: "duration", days: amount, cumulative: true }, before),
        alreadyPermanent,
      };
      landedAnywhere = true;
      continue;
    }
    try {
      pace.touchedGame = true;
      const outcome = await grantDays(repo, server, player, amount, actorName, ref, null, "bulk payout");
      servers[serverId] = { before: before?.expiration ?? null, after: outcome.expiration, alreadyPermanent: outcome.alreadyPermanent };
      landedAnywhere = true;
    } catch (err) {
      servers[serverId] = { error: (err as Error).message };
      firstError = firstError ?? (err as Error).message;
    }
  }
  if (firstError && !landedAnywhere) throw new Error(firstError);
  if (!landedAnywhere) throw new Error("no target server matched a game account for this recipient");
  return { servers };
}

/** The payout a job's payments are made under: its own, or for a retry the payout the chain of
 *  retries is ultimately paying. */
function rootOf(job: PayoutJobRow): string {
  return job.sourceType === "retry" && typeof job.sourceRef.rootJobId === "string" ? job.sourceRef.rootJobId : job.id;
}

/** Follow a retry chain to the payout it is paying. Retries written before rootJobId was recorded
 *  name only their parent, hence the walk (bounded — a chain is a few links at most). */
async function rootJobOf(repo: Repository, jobId: string): Promise<string> {
  let id = jobId;
  for (let depth = 0; depth < 32; depth++) {
    const j = await repo.payouts.get(id);
    if (!j || j.sourceType !== "retry") return id;
    if (typeof j.sourceRef.rootJobId === "string") return j.sourceRef.rootJobId;
    const parent = typeof j.sourceRef.jobId === "string" ? j.sourceRef.jobId : "";
    if (!parent || parent === id) return id;
    id = parent;
  }
  return id;
}

/** Whether this player already holds a VIP grant made under `ref` on this server — the trail
 *  grantDays leaves on every grant it makes. */
async function vipPaidUnder(repo: Repository, serverId: string, platformId: string, ref: string): Promise<boolean> {
  const rows = await repo.audit.list({ action: "vip.grant", targetId: platformId, serverId, limit: 500 });
  return rows.some((a) => (a.data as { ref?: unknown } | null)?.ref === ref);
}

export interface EventReport {
  window: { from: string; to: string; live: boolean };
  attendance: {
    players: number;
    totalMinutes: number;
    medianMinutes: number;
    /** Most people on at once inside the window; null when only the materialised roster remains
     *  (it carries minutes, not intervals, so concurrency cannot be reconstructed from it). */
    peakConcurrent: number | null;
    /** Whether the numbers came from the event's materialised roster (sessions since trimmed). */
    fromRoster: boolean;
    list: { playerId: string; name: string | null; minutes: number }[];
  };
  rounds: {
    id: string; seq: number; map: string | null; startedAt: string; endedAt: string | null;
    winner: "allies" | "axis" | null; alliedScore: number | null; axisScore: number | null; durationSec: number | null;
  }[];
  top: { playerId: string; name: string | null; kills: number; deaths: number; teamkills: number }[];
}

/**
 * Analytics for exactly one event's window — who came, what was played, who led the board. The
 * point of the scheduler's resolved boundaries: "how did Friday night go" answered over the
 * event's real bounds, not the calendar day around it.
 *
 * Attendance prefers live session intervals (they carry concurrency); for a closed event whose
 * sessions have since been trimmed, the materialised roster answers instead — fewer numbers, but
 * the record survives its evidence, which is why the roster exists.
 */
export async function buildEventReport(ctx: AppContext, ev: PayoutEventRow): Promise<EventReport> {
  const repo = ctx.repo;
  const from = ev.openedAt!;
  const nowIso = new Date().toISOString();
  const to = ev.closedAt ?? nowIso;

  // Open sessions are unioned in whether or not the event has CLOSED, because only closed
  // sessions live in the table: somebody who was here for the event and is still playing has no
  // row yet, and leaving them out made the report disagree with the payout about who attended —
  // the payout reads the roster, which was materialised at close with exactly this union. "Dave
  // got paid but isn't on the report" is the ticket that produces. windowMinutes clips each
  // interval to the window, so a session that began after the event closed still counts nothing.
  const closedSessions = await repo.sessions.inWindow(ev.serverId, from, to);
  const openNow = await repo.sessions.openOnServer(ev.serverId);
  const intervals = [
    ...closedSessions,
    ...[...openNow.entries()].map(([playerId, connectedAt]) => ({ playerId, connectedAt, disconnectedAt: nowIso })),
  ];

  let list: { playerId: string; name: string | null; minutes: number }[];
  let peakConcurrent: number | null = null;
  let fromRoster = false;
  if (!intervals.length && ev.roster?.length) {
    list = ev.roster.map((r) => ({ ...r }));
    fromRoster = true;
  } else {
    const minutes = windowMinutes(intervals, from, to);
    const players = await repo.players.findByIds([...minutes.keys()]);
    const nameOf = new Map(players.map((p) => [p.id, p.name || p.platformId]));
    list = [...minutes.entries()].map(([playerId, m]) => ({ playerId, name: nameOf.get(playerId) ?? null, minutes: m }));
    // Peak concurrency: sweep the clipped interval edges. +1 sorts before -1 at the same instant,
    // so a back-to-back reconnect does not read as a dip.
    const edges: [number, number][] = [];
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    for (const s of intervals) {
      const a = Math.max(fromMs, Date.parse(s.connectedAt));
      const b = Math.min(toMs, Date.parse(s.disconnectedAt));
      if (a < b) { edges.push([a, +1], [b, -1]); }
    }
    edges.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
    let cur = 0;
    peakConcurrent = 0;
    for (const [, d] of edges) { cur += d; if (cur > peakConcurrent) peakConcurrent = cur; }
  }
  list.sort((a, b) => b.minutes - a.minutes || a.playerId.localeCompare(b.playerId));
  const allMinutes = list.map((r) => r.minutes).sort((a, b) => a - b);
  const median = allMinutes.length ? allMinutes[Math.floor((allMinutes.length - 1) / 2)]! : 0;

  // `matchesInWindow` is FINISHED rounds only (`ended_at IS NOT NULL`), which drops the round
  // being played right now — the one staff opening a live event's report most want to see, and
  // also the last round of an event that closed while it was still running. The report already
  // renders a null `endedAt` as "in play"; without this that branch could never be reached.
  // Same lower bound the query uses, so an open round that began before the window still counts
  // as outside it.
  const openMatch = await repo.matches.getOpen(ev.serverId).catch(() => null);
  const inWindow = openMatch && Date.parse(openMatch.startedAt) >= Date.parse(from) && Date.parse(openMatch.startedAt) < Date.parse(to);
  const matches = [
    ...(await repo.analytics.matchesInWindow({ serverId: ev.serverId, from, to })),
    ...(inWindow ? [openMatch!] : []),
  ].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)); // a report reads in play order
  const rounds = matches.map((m: MatchRow) => ({
    id: m.id, seq: m.seq, map: m.map, startedAt: m.startedAt, endedAt: m.endedAt,
    winner: m.winner, alliedScore: m.alliedScore, axisScore: m.axisScore,
    durationSec: m.endedAt ? Math.max(0, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 1000)) : null,
  }));

  // Who led the board, summed across the event's rounds — the same stat rows the round pages read.
  const byPlayer = new Map<string, { playerId: string; name: string | null; kills: number; deaths: number; teamkills: number }>();
  if (matches.length) {
    for (const s of await repo.matches.participants(matches.map((m: MatchRow) => m.id))) {
      const cur = byPlayer.get(s.playerId) ?? { playerId: s.playerId, name: s.playerName, kills: 0, deaths: 0, teamkills: 0 };
      cur.kills += s.kills; cur.deaths += s.deaths; cur.teamkills += s.teamkills;
      cur.name = s.playerName ?? cur.name;
      byPlayer.set(s.playerId, cur);
    }
  }
  const top = [...byPlayer.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).slice(0, 15);

  return {
    window: { from, to, live: !ev.closedAt },
    attendance: {
      players: list.length,
      totalMinutes: list.reduce((n, r) => n + r.minutes, 0),
      medianMinutes: median,
      peakConcurrent,
      fromRoster,
      list: list.slice(0, 200),
    },
    rounds,
    top,
  };
}

/** The sentence the ledger and the VIP comment carry — the old bot's history_reason, same idea. */
function historyReason(job: PayoutJobRow): string {
  const suffix = job.dryRun ? " (dry run)" : "";
  switch (job.sourceType) {
    case "window": return `Bulk payout${suffix}: event window`;
    case "event": return `Bulk payout${suffix}: named event`;
    case "online": return `Bulk payout${suffix}: online players`;
    case "retry": return `Bulk payout${suffix}: retry of failed rows`;
    default: return `Bulk payout${suffix}: linked members`;
  }
}
