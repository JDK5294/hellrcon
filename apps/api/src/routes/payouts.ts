/**
 * Bulk payout HTTP surface (docs/bulk-payout.md). Thin on purpose: the rules live in
 * @app/payout, the driving in ../payouts.ts — this file is capability checks, request parsing,
 * and the polling contract the panel builds its screen on.
 *
 * Paying is a community-wide capability (`economy.payout`), like the balances it moves: a member's
 * points are not a per-server fact, and a VIP payout names its target servers in the request
 * instead. The capability is deliberately outside the economy.manage bundle — minting at scale is
 * granted by hand or not at all.
 *
 * Scheduling an event is a SEPARATE, smaller capability (`events.manage`), because opening and
 * closing a window is not spending anything. The one exception is pinning an event's map-vote
 * profile: deciding which maps get voted on is a map-vote power whichever screen it is spelled
 * from, so that field additionally needs `mapvote.config` write on the server it pins.
 */
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { can, canAnywhere } from "@app/access";
import { explicitRotationOf } from "@app/maps";
import { MAX_WINDOW_DAYS, MAX_WINDOW_MS, buildEventsPost, eventPayments, resolveRecipients, sweepPayoutEvents, validateEventSchedule } from "@app/payout";
import { discordLiteral } from "@app/shared";
import { buildCandidates, buildEventReport, startPayout, type ExecuteRequest, type PayoutSource, type PreviewRequest } from "../payouts.js";
import { pageLimit, pageOffset, requirePrincipal, route, sendForbidden, type Route } from "./kit.js";
import type { PayoutAudience, PayoutKind, PayoutTier } from "@app/payout";
import type { EventPostConfig, PayoutEventPatch } from "@app/db";

/** More recipients than this is a mistake, not an event: refuse rather than mint to a typo.
 *  The number is far above any real community's linked roster and far below "the directory". */
const MAX_RECIPIENTS = 2000;
const MAX_AMOUNT = 1_000_000; // same ceiling as a manual balance adjustment
const MAX_DAYS = 3650;        // ten years of VIP in one payout is a typo
/** A payout split across more roles than this is a list nobody is maintaining. */
const MAX_TIERS = 10;
/** The furthest ahead an events post will look. A quarter is already more than anybody plans. */
const MAX_POST_DAYS = 92;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Reading events (list, one, report) is open to analytics holders as well as payout holders: an
 * event's name and window are what the event REPORT is about, and "how did Friday night go" is
 * an analytics question someone can be trusted with without also being trusted to mint currency.
 * Writing events is narrower — see canWriteEvents.
 */
function canReadEvents(grants: Parameters<typeof canAnywhere>[0]): boolean {
  return canAnywhere(grants, "events.manage", "read")
    || canAnywhere(grants, "economy.payout", "read")
    || canAnywhere(grants, "analytics.server", "read")
    || canAnywhere(grants, "analytics.match", "read");
}

/**
 * Who may schedule or cancel an event: `events.manage` at write, and only that.
 *
 * Opening and closing a window is not spending anything, and it arrived needing `economy.payout`,
 * the "trust them with the whole float" permission. Paying the people in the window still needs
 * that one, unchanged. For a while `economy.payout` write was accepted here too, as the larger
 * trust — but then the panel's Events tab answered to one permission and its schedule to another,
 * and someone holding only payouts found a tab with nothing on it. Each permission now answers for
 * its own job, and a Block on `events.manage` blocks scheduling whatever else is held.
 */
function canWriteEvents(grants: Parameters<typeof canAnywhere>[0]): boolean {
  return canAnywhere(grants, "events.manage", "write");
}

function parseSource(v: unknown): PayoutSource {
  const o = (v ?? {}) as Record<string, unknown>;
  const type = str(o.type);
  if (type !== "linked" && type !== "online" && type !== "window" && type !== "event" && type !== "retry") {
    throw new Error("source.type must be linked, online, window, event or retry");
  }
  const src: PayoutSource = { type };
  if (o.serverId != null) src.serverId = str(o.serverId);
  if (o.from != null) src.from = str(o.from);
  if (o.to != null) src.to = str(o.to);
  if (o.jobId != null) src.jobId = str(o.jobId);
  if (o.eventId != null) src.eventId = str(o.eventId);
  if (o.minMinutes != null) {
    const n = Number(o.minMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 24 * 60) throw new Error("minMinutes must be a whole number of minutes within a day");
    src.minMinutes = n;
  }
  // Same bound, same reason as an event's span (MAX_WINDOW_DAYS in @app/payout): presence is read
  // as raw session intervals, so an unbounded window is an unbounded read — and truncating it
  // would pay a partial list, which is worse than refusing.
  if (src.type === "window" && src.from && src.to) {
    const span = Date.parse(src.to) - Date.parse(src.from);
    if (Number.isFinite(span) && span > MAX_WINDOW_MS) {
      throw new Error(`a payout window can span at most ${MAX_WINDOW_DAYS} days — narrow it, or pay a saved event instead`);
    }
  }
  return src;
}

/** Role tiers: [{roleId, amount}] — per-role amounts, order = priority, blank amount = the base
 *  amount. Validated whole so a typo'd tier fails the request, never quietly pays wrong. */
function parseTiers(v: unknown, kind: PayoutKind): PayoutTier[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error("tiers must be a list of { roleId, amount }");
  if (v.length > MAX_TIERS) throw new Error(`at most ${MAX_TIERS} role tiers`);
  const max = kind === "vip" ? MAX_DAYS : MAX_AMOUNT;
  const seen = new Set<string>();
  return v.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const roleId = str(o.roleId).trim();
    if (!/^\d{5,25}$/.test(roleId)) throw new Error(`tier ${i + 1}: roleId must be a Discord role id`);
    if (seen.has(roleId)) throw new Error(`tier ${i + 1}: that role already has a tier`);
    seen.add(roleId);
    const rawAmount = o.amount;
    const amount = rawAmount === null || rawAmount === undefined || rawAmount === "" ? null : Number(rawAmount);
    if (amount !== null && (!Number.isInteger(amount) || amount < 1 || amount > max)) {
      throw new Error(`tier ${i + 1}: amount must be blank (the base amount) or 1..${max}`);
    }
    return { roleId, amount };
  });
}

function parseShared(body: Record<string, unknown>): PreviewRequest {
  const kind = str(body.kind) as PayoutKind;
  if (kind !== "currency" && kind !== "vip") throw new Error("kind must be currency or vip");
  const audience = (str(body.audience) || "linked") as PayoutAudience;
  if (audience !== "everyone" && audience !== "linked" && audience !== "role") throw new Error("audience must be everyone, linked or role");
  const removedKeys = Array.isArray(body.removedKeys) ? body.removedKeys.map(str).slice(0, MAX_RECIPIENTS) : [];
  return {
    source: parseSource(body.source),
    kind, audience,
    roleId: body.roleId == null ? null : str(body.roleId),
    tiers: parseTiers(body.tiers, kind),
    removedKeys,
  };
}

/** Why this set cannot serve as an event's rotation — null when it can. Checked at the door on
 *  create/edit AND again by the worker at open time, because sets keep being edited in between. */
async function rotationSetProblem(repo: { mapSets: { get(id: string): Promise<{ name: string; game: string; pool: Record<string, unknown> } | null> } }, setId: string, server: { name: string; game: string }): Promise<string | null> {
  const set = await repo.mapSets.get(setId);
  if (!set) return "that map set no longer exists";
  if (set.game !== server.game) return `"${set.name}" is a ${set.game} set — ${server.name} runs ${server.game}, and map ids do not cross games`;
  const lineup = explicitRotationOf(set.pool);
  if (!lineup || !lineup.length) return `"${set.name}" is a vote recipe (counts and rules), not a concrete rotation lineup — save a live rotation as a set to attach one`;
  return null;
}

export const payoutRoutes: Route[] = [
  /**
   * Resolve who a payout would reach, and say who it would NOT and why. The preview is the
   * consent step: execute re-resolves the same request server-side, so what was previewed is
   * what runs — the client's copy of the list is display, not authority.
   */
  route("POST", "/api/payouts/preview", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.payout", "read")) return sendForbidden(res, "economy.payout", "read");
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const preview = parseShared(body);
      const candidates = await buildCandidates(ctx, preview);
      const { recipients, dropped } = resolveRecipients(candidates, {
        kind: preview.kind, audience: preview.audience, roleId: preview.roleId, tiers: preview.tiers,
        minMinutes: preview.source.minMinutes, removedKeys: preview.removedKeys,
      });
      if (recipients.length > MAX_RECIPIENTS) {
        return sendError(res, 400, `${recipients.length} recipients is above the ${MAX_RECIPIENTS} ceiling — narrow the source`);
      }
      sendJson(res, 200, { recipients, dropped, candidateCount: candidates.length });
    } catch (err) {
      sendError(res, 400, (err as Error).message);
    }
  }),

  /** Start a payout (or a dry run of one). Returns the job immediately; the panel polls it. */
  route("POST", "/api/payouts", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.payout", "write")) return sendForbidden(res, "economy.payout", "write");
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const shared = parseShared(body);
      // Blank base + every tier priced is a complete payout: nothing reads the base, so nothing
      // needs one. `validateExecution` holds the rule; this only has to stop refusing at the door.
      const amount = body.amount === undefined || body.amount === null || body.amount === "" ? 0 : Number(body.amount);
      const basePays = !shared.tiers?.length || shared.tiers.some((t) => t.amount === null);
      if (!Number.isInteger(amount) || amount < 0) throw new Error("the amount must be a whole number");
      if (basePays && amount <= 0) {
        throw new Error(shared.tiers?.length
          ? "a tier left blank pays the base amount, so the base amount is needed — set it, or give every tier its own"
          : "the amount must be a whole number above zero");
      }
      if (shared.kind === "currency" && amount > MAX_AMOUNT) throw new Error(`at most ${MAX_AMOUNT} points per payout`);
      if (shared.kind === "vip" && amount > MAX_DAYS) throw new Error(`at most ${MAX_DAYS} VIP days per payout`);
      const serverIds = Array.isArray(body.serverIds) ? body.serverIds.map(str).filter(Boolean) : [];
      const reqFull: ExecuteRequest = { ...shared, amount, serverIds, dryRun: Boolean(body.dryRun) };
      const started = await startPayout(ctx, reqFull, { userId: p.user.id, name: p.name });
      sendJson(res, 202, { job: started.job });
    } catch (err) {
      sendError(res, 400, (err as Error).message);
    }
  }),

  route("GET", "/api/payouts", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.payout", "read")) return sendForbidden(res, "economy.payout", "read");
    const u = new URL(req.url ?? "/", "http://x").searchParams;
    // Up to 500 a page, as the events list: the panel's pages go up to 200.
    const limit = pageLimit(u, 25, 500);
    const offset = pageOffset(u);
    const [jobs, total] = await Promise.all([ctx.repo.payouts.list({ limit, offset }), ctx.repo.payouts.count()]);
    sendJson(res, 200, { items: jobs, total, offset, limit });
  }),

  /** One job with its receipts — the polling target while it runs, the record forever after. */
  route("GET", "/api/payouts/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "economy.payout", "read")) return sendForbidden(res, "economy.payout", "read");
    const job = await ctx.repo.payouts.get(params.id!).catch(() => null);
    if (!job) return sendError(res, 404, "no such payout");
    const u = new URL(req.url ?? "/", "http://x").searchParams;
    const limit = pageLimit(u, 500, 2000);
    const offset = pageOffset(u);
    const [items, itemsTotal] = await Promise.all([
      ctx.repo.payouts.items(job.id, { limit, offset }),
      ctx.repo.payouts.itemsCount(job.id),
    ]);
    sendJson(res, 200, { job, items, itemsTotal, offset, limit });
  }),

  /**
   * Create a payout event — a named window whose boundaries resolve themselves (a hard time, or
   * the next match boundary at/after an anchor). Creatable for any time: the future (scheduled
   * in advance), or the past — presence was recorded regardless, so the sweep right below
   * resolves a retroactive window immediately and the response already carries its bounds.
   */
  route("POST", "/api/payout-events", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canWriteEvents(p.grants)) return sendForbidden(res, "events.manage", "write");
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const name = str(body.name).trim();
      if (!name) throw new Error("name the event");
      if (name.length > 120) throw new Error("the name is longer than 120 characters");
      const serverId = str(body.serverId);
      const server = serverId ? await ctx.repo.servers.findById(serverId) : null;
      if (!server) throw new Error("pick the server the event runs on");
      const openMode = (str(body.openMode) || "at") as "at" | "match_start_after";
      const closeMode = (str(body.closeMode) || "at") as "at" | "match_end_after";
      const openAnchor = str(body.openAnchor);
      const closeAnchor = str(body.closeAnchor);
      validateEventSchedule({ openMode, openAnchor, closeMode, closeAnchor });
      let minMinutes = 0;
      if (body.minMinutes != null) {
        const n = Number(body.minMinutes);
        if (!Number.isInteger(n) || n < 0 || n > 24 * 60) throw new Error("minMinutes must be a whole number of minutes within a day");
        minMinutes = n;
      }
      // A pinned map-vote profile is validated against the server's REAL profile list at the
      // door: a typo here would otherwise sit silent until Friday night, when the pin quietly
      // resolves to nothing and the schedule picks the maps instead.
      let mapVoteProfile: string | null = null;
      if (body.mapVoteProfile != null && str(body.mapVoteProfile).trim()) {
        mapVoteProfile = str(body.mapVoteProfile).trim();
        /**
         * Deciding which maps get voted on is a MAP-VOTE power, whichever screen it is spelled
         * from. Editing the profiles directly needs `mapvote.config` write on the server; pinning
         * one for the length of an event has the same effect on what players get to play, so it
         * needs the same grant — otherwise scheduling rights quietly became map control.
         * Server-scoped, because that capability is: rights on one server are not rights on
         * another.
         */
        if (!can(p.grants, "mapvote.config", "write", { serverId })) {
          return sendForbidden(res, "mapvote.config", "write", { serverId });
        }
        const cfg = await ctx.repo.mapVote.getConfig(serverId);
        const names = (cfg?.profiles ?? []).map((pr) => (pr as { name: string }).name);
        if (!names.includes(mapVoteProfile)) {
          throw new Error(names.length
            ? `no map-vote profile named "${mapVoteProfile}" on that server — it has: ${names.join(", ")}`
            : "that server has no map-vote profiles to pin");
        }
      }
      // A rotation set is the same shape of power as the vote pin above — it decides what
      // players get to play — so it takes the rotation grant on the event's server, and a set
      // that cannot yield a concrete lineup is refused at the door rather than on event night.
      let rotationSetId: string | null = null;
      if (body.rotationSetId != null && str(body.rotationSetId).trim()) {
        rotationSetId = str(body.rotationSetId).trim();
        if (!can(p.grants, "maps.rotation", "write", { serverId })) {
          return sendForbidden(res, "maps.rotation", "write", { serverId });
        }
        const problem = await rotationSetProblem(ctx.repo, rotationSetId, server);
        if (problem) throw new Error(problem);
      }
      const created = await ctx.repo.payoutEvents.create({
        name, serverId,
        openMode, openAnchor: new Date(Date.parse(openAnchor)).toISOString(),
        closeMode, closeAnchor: new Date(Date.parse(closeAnchor)).toISOString(),
        minMinutes, mapVoteProfile, rotationSetId, createdBy: p.name,
      });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "economy.payoutEvent.create",
        targetType: "payoutEvent", targetId: created.id, targetName: name, serverId,
        summary: `scheduled payout event "${name}"`,
        data: { openMode, openAnchor: created.openAnchor, closeMode, closeAnchor: created.closeAnchor, minMinutes, mapVoteProfile, rotationSetId },
      });
      await sweepPayoutEvents(ctx.repo); // a retroactive window resolves before the caller sees it
      const event = (await ctx.repo.payoutEvents.get(created.id)) ?? created;
      sendJson(res, 201, { event });
    } catch (err) {
      sendError(res, 400, (err as Error).message);
    }
  }),

  /**
   * Edit an event that has not finished happening — the thing a schedule is useless without,
   * since plans move. Every field the create route takes, under the store's status rule: a
   * `scheduled` event takes all of them, an `open` one keeps its resolved open boundary and its
   * server (presence has been accruing there since), and a closed or cancelled one is a record
   * and refuses. The schedule is re-validated as a WHOLE — the patch is merged onto the stored
   * row first — so a one-field edit cannot leave the pair backwards or a quarter apart.
   */
  route("PATCH", "/api/payout-events/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canWriteEvents(p.grants)) return sendForbidden(res, "events.manage", "write");
    const before = await ctx.repo.payoutEvents.get(params.id!).catch(() => null);
    if (!before) return sendError(res, 404, "no such payout event");
    if (before.status === "closed" || before.status === "cancelled") {
      return sendError(res, 409, `that event is ${before.status} — a finished window is a record, not a plan`);
    }
    const running = before.status === "open";
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const patch: PayoutEventPatch = {};
      if (body.name !== undefined) {
        const name = str(body.name).trim();
        if (!name) throw new Error("name the event");
        if (name.length > 120) throw new Error("the name is longer than 120 characters");
        patch.name = name;
      }
      if (body.minMinutes !== undefined) {
        const n = Number(body.minMinutes);
        if (!Number.isInteger(n) || n < 0 || n > 24 * 60) throw new Error("minMinutes must be a whole number of minutes within a day");
        patch.minMinutes = n;
      }
      // The open half is settled once the event is running: say so rather than accepting the
      // field and dropping it, which would read as a save that worked.
      const movesOpenSide = body.openMode !== undefined || body.openAnchor !== undefined || body.serverId !== undefined;
      if (running && movesOpenSide) {
        throw new Error("this event has already opened — its start and its server are settled. The close time, name, minutes and map pin can still change.");
      }
      if (body.serverId !== undefined) {
        const serverId = str(body.serverId);
        if (!(await ctx.repo.servers.findById(serverId))) throw new Error("pick the server the event runs on");
        patch.serverId = serverId;
      }
      if (body.openMode !== undefined) patch.openMode = str(body.openMode) === "match_start_after" ? "match_start_after" : "at";
      if (body.openAnchor !== undefined) patch.openAnchor = str(body.openAnchor);
      if (body.closeMode !== undefined) patch.closeMode = str(body.closeMode) === "match_end_after" ? "match_end_after" : "at";
      if (body.closeAnchor !== undefined) patch.closeAnchor = str(body.closeAnchor);
      // Validated as the event will STAND, not as the patch reads: a new close time is only legal
      // against the open time it will actually sit beside.
      const merged = { ...before, ...patch };
      validateEventSchedule({
        openMode: merged.openMode, openAnchor: merged.openAnchor,
        closeMode: merged.closeMode, closeAnchor: merged.closeAnchor,
      });
      if (patch.openAnchor) patch.openAnchor = new Date(Date.parse(patch.openAnchor)).toISOString();
      if (patch.closeAnchor) patch.closeAnchor = new Date(Date.parse(patch.closeAnchor)).toISOString();
      // Same rule as create, checked against the server the event will run on: pinning maps is a
      // map-vote power wherever it is spelled from.
      if (body.mapVoteProfile !== undefined) {
        const wanted = str(body.mapVoteProfile).trim();
        const serverId = patch.serverId ?? before.serverId;
        /*
         * Only a CHANGE to the pin is an exercise of that power. The panel sends the whole form
         * back on every save, so an unchanged pin rides along with a rename — and checking the
         * grant on that meant somebody with events.manage but not mapvote.config could not edit a
         * pinned event at all. They were refused over a field the panel does not even show them
         * without the grant, so the error named a control they could not see.
         *
         * Moving the event to another server is not "unchanged": the same profile name is a
         * different pool there, and it has to be re-checked against that server's profiles.
         */
        const movedServer = serverId !== before.serverId;
        const unchanged = wanted === (before.mapVoteProfile ?? "") && !movedServer;
        if (!wanted) {
          // Clearing a pin is not pinning, so it needs no map-vote grant — it hands the choice
          // back to the schedule, which is the state the event would have had by default.
          patch.mapVoteProfile = null;
        } else if (unchanged) {
          // Nothing to do, and deliberately not written: leaving it out of the patch is what keeps
          // "the form came back with the same pin on it" from counting as an edit at all.
        } else {
          if (!can(p.grants, "mapvote.config", "write", { serverId })) return sendForbidden(res, "mapvote.config", "write", { serverId });
          const cfg = await ctx.repo.mapVote.getConfig(serverId);
          const names = (cfg?.profiles ?? []).map((pr) => (pr as { name: string }).name);
          if (!names.includes(wanted)) {
            throw new Error(names.length
              ? `no map-vote profile named "${wanted}" on that server — it has: ${names.join(", ")}`
              : "that server has no map-vote profiles to pin");
          }
          patch.mapVoteProfile = wanted;
        }
      }
      if (body.rotationSetId !== undefined) {
        const wanted = str(body.rotationSetId).trim();
        const serverId = patch.serverId ?? before.serverId;
        const movedServer = serverId !== before.serverId;
        const unchanged = wanted === (before.rotationSetId ?? "") && !movedServer;
        if (!wanted) {
          patch.rotationSetId = null;
        } else if (unchanged) {
          // The form sending the same set back is not an edit — same rule as the vote pin above.
        } else {
          if (!can(p.grants, "maps.rotation", "write", { serverId })) return sendForbidden(res, "maps.rotation", "write", { serverId });
          const target = await ctx.repo.servers.findById(serverId);
          if (!target) throw new Error("pick the server the event runs on");
          const problem = await rotationSetProblem(ctx.repo, wanted, target);
          if (problem) throw new Error(problem);
          patch.rotationSetId = wanted;
        }
      }
      if (!Object.keys(patch).length) return sendError(res, 400, "nothing to change");
      const updated = await ctx.repo.payoutEvents.update(before.id, patch);
      if (!updated) return sendError(res, 409, "that event finished while you were editing it");
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "economy.payoutEvent.update",
        targetType: "payoutEvent", targetId: updated.id, targetName: updated.name, serverId: updated.serverId,
        // What CHANGED, both sides — an edit nobody can read back is an edit nobody can question.
        summary: `edited payout event "${updated.name}"${before.name !== updated.name ? ` (was "${before.name}")` : ""}: ${Object.keys(patch).join(", ")}`,
        data: { changed: Object.keys(patch), before: { name: before.name, openAnchor: before.openAnchor, closeAnchor: before.closeAnchor, minMinutes: before.minMinutes, mapVoteProfile: before.mapVoteProfile }, patch },
      });
      // A retroactive edit can make the window resolvable on the spot — same as create.
      await sweepPayoutEvents(ctx.repo);
      sendJson(res, 200, { event: (await ctx.repo.payoutEvents.get(updated.id)) ?? updated });
    } catch (err) {
      sendError(res, 400, (err as Error).message);
    }
  }),

  route("GET", "/api/payout-events", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canReadEvents(p.grants)) return sendForbidden(res, "events.manage", "read");
    // Resolve-on-read keeps the list truthful with no worker alive; status-guarded writes make
    // it safe to run beside the worker's own sweep.
    await sweepPayoutEvents(ctx.repo);
    const u = new URL(req.url ?? "/", "http://x").searchParams;
    // Up to 500 a page: the panel's lists offer pages of up to 200, and a page that came back
    // shorter than it asked for would have the next page start past rows nobody was shown.
    const limit = pageLimit(u, 25, 500);
    const offset = pageOffset(u);
    const [events, total] = await Promise.all([ctx.repo.payoutEvents.list({ limit, offset }), ctx.repo.payoutEvents.count()]);
    /*
     * Two columns the list shows beside each event: the server it ran on, and whether it has been
     * paid. The name is resolved here, from every server retired ones included, so an event keeps
     * naming its server after the server is retired or falls outside a reader's picker; an event
     * whose server was deleted outright gets null. So does one on a DECOMMISSIONED server, for
     * everyone but the setup account: stage 2 takes the server away from every other account (see
     * GET /api/servers), so its name is not printed to people it no longer exists for. The payment
     * is a state and a count only (see EventPayment): reading events does not take economy.payout,
     * so amounts and recipients stay on the Payouts screen. Null means no payout has been made.
     */
    const [runs, servers, setupUserId] = await Promise.all([
      ctx.repo.payouts.forEvents(events.map((e) => e.id)),
      ctx.repo.servers.list({ includeRetired: true }),
      ctx.repo.users.firstUserId(),
    ]);
    const isSetupUser = p.user.id === setupUserId;
    const serverName = new Map(servers.filter((s) => isSetupUser || !s.decommissionedAt).map((s) => [s.id, s.name]));
    const paid = eventPayments(runs);
    const items = events.map((e) => ({ ...e, serverName: serverName.get(e.serverId) ?? null, payment: paid.get(e.id) ?? null }));
    sendJson(res, 200, { items, total, offset, limit });
  }),

  /**
   * The events list, posted to Discord as unix timestamps — every reader sees it on their own
   * clock (see @app/payout's announce module for why that is the only honest spelling).
   *
   * `POST` sends it now; the same message and the same list the weekly schedule below sends, from
   * one builder, so the automatic post and the one staff just pressed cannot disagree. A `preview`
   * body returns the text without posting, which is also how the panel shows what will go out.
   */
  route("POST", "/api/payout-events/post", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const preview = body.preview === true;
    // A preview only renders the message: reading what would be posted is a read, so it is never
    // filed as a request. Posting it is the write.
    if (preview ? !canReadEvents(p.grants) : !canWriteEvents(p.grants)) return sendForbidden(res, "events.manage", preview ? "read" : "write");
    const stored = await ctx.repo.payoutEvents.getPostConfig();
    const days = body.days === undefined ? stored.daysAhead : Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_POST_DAYS) {
      return sendError(res, 400, `days must be a whole number from 1 to ${MAX_POST_DAYS}`);
    }
    const channelId = str(body.channelId).trim() || stored.channelId;
    if (!preview && !/^\d{5,25}$/.test(channelId)) {
      return sendError(res, 400, "channelId must be a numeric Discord channel id (set one in the events post settings, or pass one)");
    }
    // Resolve first: an event that became open or closed since the last sweep must not be
    // announced as still to come.
    await sweepPayoutEvents(ctx.repo);
    const [events, servers] = await Promise.all([
      ctx.repo.payoutEvents.list({ limit: 200 }),
      ctx.repo.servers.list({ includeRetired: true }), // payout receipts keep naming retired servers
    ]);
    const message = buildEventsPost(events, {
      days,
      serverNames: new Map(servers.map((s) => [s.id, s.name])),
      literal: discordLiteral,
    });
    if (!message) return sendError(res, 409, `nothing to post — no events are scheduled in the next ${days} day${days === 1 ? "" : "s"}`);
    if (preview) return sendJson(res, 200, { message, posted: false });

    const token = process.env.DISCORD_TOKEN;
    if (!token) return sendError(res, 409, "no Discord bot token is set — add it under Discord → Setup & status");
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      // Already sized to Discord's budget by buildEventsPost (whole entries, never a sheared token).
      body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return sendError(res, 502, `Discord rejected the post (${r.status}) — check the channel id and that the bot can post there`);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.payoutEvent.post",
      targetType: "discord-channel", targetId: channelId, targetName: `channel ${channelId}`,
      summary: `posted the next ${days} day${days === 1 ? "" : "s"} of events to channel ${channelId}`,
      data: { channelId, days, manual: true },
    });
    sendJson(res, 200, { message, posted: true });
  }),

  /** The self-sending post's settings. Read with the events list; written by whoever schedules. */
  route("GET", "/api/payout-events/post-config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canReadEvents(p.grants)) return sendForbidden(res, "events.manage", "read");
    sendJson(res, 200, {
      config: await ctx.repo.payoutEvents.getPostConfig(),
      botConfigured: Boolean(process.env.DISCORD_TOKEN),
    });
  }),

  route("PUT", "/api/payout-events/post-config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canWriteEvents(p.grants)) return sendForbidden(res, "events.manage", "write");
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const patch: Partial<EventPostConfig> = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.channelId !== undefined) {
      const id = str(body.channelId).trim();
      if (id && !/^\d{5,25}$/.test(id)) return sendError(res, 400, "channelId must be a numeric Discord channel id");
      patch.channelId = id;
    }
    if (body.daysAhead !== undefined) {
      const n = Number(body.daysAhead);
      if (!Number.isInteger(n) || n < 1 || n > MAX_POST_DAYS) return sendError(res, 400, `daysAhead must be a whole number from 1 to ${MAX_POST_DAYS}`);
      patch.daysAhead = n;
    }
    if (body.weekday !== undefined) {
      const n = Number(body.weekday);
      if (!Number.isInteger(n) || n < -1 || n > 6) return sendError(res, 400, "weekday must be -1 (every day) or 0–6 (Sunday–Saturday)");
      patch.weekday = n;
    }
    if (body.atHour !== undefined) {
      const n = Number(body.atHour);
      if (!Number.isInteger(n) || n < 0 || n > 23) return sendError(res, 400, "atHour must be 0–23");
      patch.atHour = n;
    }
    if (body.atMinute !== undefined) {
      const n = Number(body.atMinute);
      if (!Number.isInteger(n) || n < 0 || n > 59) return sendError(res, 400, "atMinute must be 0–59");
      patch.atMinute = n;
    }
    const effective = { ...(await ctx.repo.payoutEvents.getPostConfig()), ...patch };
    if (effective.enabled && !effective.channelId) return sendError(res, 400, "turning the automatic post on needs a channel — it has nowhere to post");
    /**
     * Changing the schedule clears the once-a-day latch.
     *
     * Without this, moving today's post from 9am to 10am does nothing until tomorrow: the latch
     * says today is done, so the new time is ignored on exactly the day the person was watching
     * for it. Clearing it means "post again today when the new time comes", which is what pressing
     * save at 9:30 for a 10:00 post plainly means.
     */
    if (patch.weekday !== undefined || patch.atHour !== undefined || patch.atMinute !== undefined || patch.enabled === true) {
      patch.lastPostedOn = null;
    }
    const config = await ctx.repo.payoutEvents.setPostConfig(patch);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.payoutEvent.postConfig",
      targetType: "setting", targetId: "event-post",
      summary: config.enabled
        ? `set the events post to go out ${config.weekday < 0 ? "every day" : WEEKDAY_NAMES[config.weekday]} at ${String(config.atHour).padStart(2, "0")}:${String(config.atMinute).padStart(2, "0")} (next ${config.daysAhead} days) in channel ${config.channelId}`
        : "turned the automatic events post off",
      data: { patch },
    });
    sendJson(res, 200, { config });
  }),

  route("GET", "/api/payout-events/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canReadEvents(p.grants)) return sendForbidden(res, "events.manage", "read");
    await sweepPayoutEvents(ctx.repo);
    const event = await ctx.repo.payoutEvents.get(params.id!).catch(() => null);
    if (!event) return sendError(res, 404, "no such payout event");
    sendJson(res, 200, { event });
  }),

  /**
   * Analytics for exactly one event's window: who came (and for how long), the rounds played
   * inside it, and who led the board. Live while the event is open; final once it closes.
   */
  route("GET", "/api/payout-events/:id/report", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canReadEvents(p.grants)) return sendForbidden(res, "events.manage", "read");
    await sweepPayoutEvents(ctx.repo);
    const event = await ctx.repo.payoutEvents.get(params.id!).catch(() => null);
    if (!event) return sendError(res, 404, "no such payout event");
    if (event.status === "scheduled" || event.status === "cancelled" || !event.openedAt) {
      return sendError(res, 400, `that event is ${event.status} — there is no window to report on yet`);
    }
    sendJson(res, 200, { event, report: await buildEventReport(ctx, event) });
  }),

  route("POST", "/api/payout-events/:id/cancel", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canWriteEvents(p.grants)) return sendForbidden(res, "events.manage", "write");
    const event = await ctx.repo.payoutEvents.get(params.id!).catch(() => null);
    if (!event) return sendError(res, 404, "no such payout event");
    const ok = await ctx.repo.payoutEvents.cancel(event.id);
    // A closed window is a record, not a plan — cancelling records is how evidence vanishes.
    if (!ok) return sendError(res, 409, `that event is already ${event.status}`);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.payoutEvent.cancel",
      targetType: "payoutEvent", targetId: event.id, targetName: event.name, serverId: event.serverId,
      summary: `cancelled payout event "${event.name}"`,
      data: {},
    });
    sendJson(res, 200, { event: await ctx.repo.payoutEvents.get(event.id) });
  }),

  /**
   * Mark a finished event as needing no payout (`{ noPayout: true }`), or undo it (`false`).
   *
   * The events list says "Awaiting payment" for every closed event nobody has paid, and some are
   * never meant to be paid: a practice night, a scrim. Cancelling is not the way out, because a
   * closed window is a record and its report stays readable, so the event stays closed and carries
   * the decision beside it instead. Scheduling rights suffice: deciding not to pay spends nothing,
   * the mark is reversible, and the audit trail says who made it. Pressing it twice is one decision,
   * so a repeat changes nothing and logs nothing.
   */
  route("POST", "/api/payout-events/:id/no-payout", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canWriteEvents(p.grants)) return sendForbidden(res, "events.manage", "write");
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (typeof body.noPayout !== "boolean") return sendError(res, 400, "noPayout must be true (no payout needed) or false (undo)");
    // Resolve first, like every other event read: a window that has just finished closes here.
    await sweepPayoutEvents(ctx.repo);
    const event = await ctx.repo.payoutEvents.get(params.id!).catch(() => null);
    if (!event) return sendError(res, 404, "no such payout event");
    if (event.status !== "closed") {
      return sendError(res, 409, `that event is ${event.status} — only a finished event can be marked as needing no payout`);
    }
    if (body.noPayout === (event.noPayoutAt !== null)) return sendJson(res, 200, { event });
    const updated = await ctx.repo.payoutEvents.setNoPayout(event.id, body.noPayout ? { at: new Date().toISOString(), by: p.name } : null);
    if (!updated) return sendError(res, 409, "that event changed while this was being saved — reload and try again");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "economy.payoutEvent.noPayout",
      targetType: "payoutEvent", targetId: event.id, targetName: event.name, serverId: event.serverId,
      summary: body.noPayout
        ? `marked event "${event.name}" as needing no payout`
        : `marked event "${event.name}" as needing a payout again`,
      data: { noPayout: body.noPayout },
    });
    sendJson(res, 200, { event: updated });
  }),
];
