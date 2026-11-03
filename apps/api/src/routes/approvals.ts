/**
 * The approvals queue — reading requests, and signing or refusing their lines.
 *
 * Who may decide a line is one rule in one place (@app/access approvalRefusal): someone who could
 * perform that line themselves — the capability at write, on that server. There is no approver
 * list to configure; the matrix already says who outranks whom, because a requester files
 * precisely because they lack the write. A signature covers as much as that signer's own
 * authority reaches and the remainder is filed onwards, so a request climbs the chain rather than
 * waiting for one person senior enough to swallow it whole.
 *
 * Lines resolve independently, stamped per decision, so whoever is awake picks off the lines
 * they can sign and the rest wait. Denying requires a reason — the requester reads it, and that
 * reason is what turns the queue into coaching instead of a silent wall. Approve-all is the same
 * per-line decision in a loop: it signs what THIS approver could sign and reports what it
 * skipped, never erroring on a line that belongs to someone else's authority.
 */
import { approvalRefusal, can, canAnywhere } from "@app/access";
import type { ApprovalLineRow, ApprovalRequestRow } from "@app/db";
import { readJsonBody, sendError, sendJson, str } from "../http.js";
import { approveLine, denyLine, executeApprovedLine, signerCoverage } from "../approvals.js";
import { REQUEST_TTL_HOURS } from "../requests.js";
import { postApprovalCard, updateApprovalCard } from "../approval-cards.js";
import type { Principal } from "../auth.js";
import type { AppContext } from "../context.js";
import { requirePrincipal, route, sendForbidden, tempbanRefusal, type Route } from "./kit.js";

/** A line as the panel sees it: the row plus whether THIS viewer may sign it (and why not). */
async function annotateLine(ctx: AppContext, p: Principal, req: ApprovalRequestRow, l: ApprovalLineRow, names: Map<string, string>) {
  // Past the deadline the sweep may not have swung yet, but approveLine already refuses — so
  // the button must not offer what the press would only bounce.
  const expired = Boolean(req.expiresAt && Date.parse(req.expiresAt) <= Date.now());
  /*
   * Holding the capability is not the whole story for a ban: a 24h-capped signer can advance a
   * 48h ask (they cover 24h and the rest climbs), but cannot advance a ban ALREADY at 24h — and
   * offering them a button that can only answer "your limit does not reach past this" is the
   * dead end this whole cascade exists to remove.
   */
  const cover = expired ? null : await signerCoverage(ctx, p, l);
  const refusal = expired
    ? "this request has expired — nothing executes from an expired request"
    : approvalRefusal({ userId: p.user.id, grants: p.grants }, l.capability, l.serverId)
      ?? (cover && !cover.progress
        ? `your temp-ban limit does not reach past the ${cover.applied}h already applied — this needs someone with a longer limit`
        : null);
  return {
    ...l,
    // A line captured without a name (an older row, a Discord or API filing) still shows a name:
    // the directory knows who that id is. A request is read hours later by someone who was not
    // there, and "0ff4c94…" names nobody.
    playerName: l.playerName || (l.playerId ? names.get(l.playerId) ?? null : null),
    canSign: l.state === "pending" && refusal === null,
    signRefusal: refusal,
    /** What this signer's own limit would cover of the ask, when that is less than all of it —
     *  so the panel can say "you can approve 24h of the 48h asked" before the click. The figure
     *  is the one the signature will actually grant (whole hours, floored), not a rounded
     *  approximation of it: a button that promises 25h and delivers 24 is a worse lie than none. */
    coversHours: cover?.partial ? cover.covered : undefined,
  };
}

/** Directory names for every player id across these requests, in ONE query. */
async function nameMap(ctx: AppContext, requests: ApprovalRequestRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(requests.flatMap((r) => r.lines.map((l) => l.playerId)).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map();
  const rows = await ctx.repo.players.findByPlatformIds(ids).catch(() => []);
  return new Map(rows.filter((pl) => pl.name).map((pl) => [pl.platformId, pl.name]));
}

async function view(ctx: AppContext, p: Principal, r: ApprovalRequestRow, names: Map<string, string>) {
  return { ...r, own: r.requesterUserId === p.user.id, lines: await Promise.all(r.lines.map((l) => annotateLine(ctx, p, r, l, names))) };
}


/**
 * Would this line execute FULLY under p's own authority — the write, and (for temp bans) their
 * hour cap? The fate badge at review and the split at submit both use this, so they always agree
 * with what execution would actually do: a capped moderator's 10h temp ban is NOT "applies
 * immediately" — executing it would only bounce off their own cap — it goes for a signature,
 * exactly like the fast path splits the same action outside the cart.
 */
async function executesAsOwn(ctx: AppContext, p: Principal, l: ApprovalLineRow): Promise<boolean> {
  // The SAME test the queue uses to decide who may sign it — "can you do this yourself, there" —
  // so the two can never drift, and a community-wide line (a watch carries no server) is judged
  // the way its own route judges it rather than being asked for a global grant nobody has.
  if (approvalRefusal({ userId: p.user.id, grants: p.grants }, l.capability, l.serverId)) return false;
  if (l.kind === "tempban" && l.serverId) {
    const hours = Number(l.payload.hours ?? 0);
    if (hours > 0 && await tempbanRefusal(ctx.repo, p, l.serverId, hours)) return false;
  }
  return true;
}

/**
 * Approve-with-modification: only NUMERIC fields the payload actually carries, and only DOWN —
 * granting more than was asked for is a new action nobody requested, and it would execute under
 * a requester's name who never asked for it.
 */
function parseModification(line: ApprovalLineRow, body: Record<string, unknown>): { modified: Record<string, { requested: number; granted: number }> | null; error?: string } {
  const raw = body.modified;
  if (raw === undefined || raw === null) return { modified: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { modified: null, error: "modified must be an object of numeric fields" };
  const MODIFIABLE: Record<string, string[]> = { tempban: ["hours"], tempban_extend: ["hours"], vip: ["days", "hours"] };
  const allowed = MODIFIABLE[line.kind] ?? [];
  const out: Record<string, { requested: number; granted: number }> = {};
  for (const [field, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(field)) return { modified: null, error: `'${field}' cannot be modified on a ${line.kind} line` };
    const requested = Number(line.payload[field] ?? 0);
    const granted = Number(v);
    if (!Number.isFinite(granted) || granted <= 0) return { modified: null, error: `${field} must be a positive number` };
    if (granted > requested) return { modified: null, error: `${field} can only be modified DOWN (${requested} was asked for) — more than asked is a new request` };
    if (granted !== requested) out[field] = { requested, granted };
  }
  return { modified: Object.keys(out).length ? out : null };
}

export const approvalsRoutes: Route[] = [
  /**
   * The queue and the requester's own record, in one read: `queue` is every OPEN request holding
   * at least one line this viewer could sign; `mine` is what they filed, newest first, including
   * resolved and denied ones — the deny reasons ARE the answer they are waiting for.
   */
  route("GET", "/api/requests", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const mineRows = (await ctx.repo.approvals.list({ requesterUserId: p.user.id, limit: 50 })).filter((r) => r.status !== "draft");
    const queueRows = (await ctx.repo.approvals.list({ status: ["open"] })).filter((r) => r.requesterUserId !== p.user.id);
    const names = await nameMap(ctx, [...mineRows, ...queueRows]);
    const mine = await Promise.all(mineRows.map((r) => view(ctx, p, r, names)));
    const queue = (await Promise.all(queueRows.map((r) => view(ctx, p, r, names)))).filter((r) => r.lines.some((l) => l.canSign));
    sendJson(res, 200, { mine, queue });
  }),

  /** The current draft (or null), each line badged with its fate at THIS user's grants: a line
   *  they hold at write applies immediately on submit; the rest go for signatures. */
  route("GET", "/api/requests/draft", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const d = await ctx.repo.approvals.findDraft(p.user.id);
    if (!d) return sendJson(res, 200, { draft: null });
    const names = await nameMap(ctx, [d]);
    const lines = await Promise.all(d.lines.map(async (l) => ({
      ...l,
      playerName: l.playerName || (l.playerId ? names.get(l.playerId) ?? null : null),
      fate: (await executesAsOwn(ctx, p, l)) ? "immediate" : "ask",
    })));
    sendJson(res, 200, { draft: { ...d, lines } });
  }),

  /**
   * THE RECORD: every finished line the community has decided, not just your own.
   *
   * Filing and signing fall out of who you are — the requester sees theirs, a write-holder sees
   * what waits on them — so neither needs a permission. Reviewing the TEAM's finished work is a
   * different question ("was that ban ever approved?", "who keeps denying these?", "what did we
   * decide about this player last month?") and it is the one thing here that needs granting.
   *
   * Returned as one row per DECIDED LINE rather than as nested requests, because the questions
   * people bring are about decisions: sort by player, by action, by who signed it. A bundle of
   * three lines is three answers, and nesting them hides two.
   *
   * Bounded and newest-first. The panel sorts and filters what it is given and says how much that
   * is, rather than pretending to page through everything.
   */
  route("GET", "/api/requests/history", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "moderation.requests.history", "read")) {
      return sendForbidden(res, "moderation.requests.history", "read");
    }
    const url = new URL(req.url ?? "/", "http://x");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 1000);
    // Drafts are private scratch and open requests are live work — neither is history.
    const rows = await ctx.repo.approvals.list({ status: ["resolved", "expired", "withdrawn"], limit });
    const names = await nameMap(ctx, rows);
    const serverNames = new Map((await ctx.repo.servers.list().catch(() => [])).map((s) => [s.id, s.name]));
    // A server's decisions to whoever may review that server's: the permission is granted per
    // server. A line that belongs to no server (a watchlist request) is for someone who may review
    // every server's, as Staff activity keeps community-wide rows.
    const all = await ctx.repo.servers.list({ includeRetired: true });
    const reviews = (serverId: string) => can(p.grants, "moderation.requests.history", "read", { serverId });
    const everywhere = all.every((s) => reviews(s.id));
    const decisions = rows.flatMap((r) => r.lines
      .filter((l) => (l.serverId ? reviews(l.serverId) : everywhere))
      // A line nobody ever decided (voided with its request) is part of the story; a pending one
      // cannot be, because its request is closed.
      .map((l) => ({
        requestId: r.id, lineId: l.id,
        requesterName: r.requesterName, filedAt: r.submittedAt ?? r.createdAt,
        requestStatus: r.status,
        kind: l.kind, capability: l.capability,
        serverId: l.serverId, serverName: l.serverId ? serverNames.get(l.serverId) ?? null : null,
        playerId: l.playerId, playerName: l.playerName || (l.playerId ? names.get(l.playerId) ?? null : null),
        state: l.state, decidedByName: l.decidedByName, decidedAt: l.decidedAt,
        denyReason: l.denyReason, applyError: l.applyError, modified: l.modified,
        /*
         * `label` so the history table can name a filed CALL instead of printing "route" — but NOT
         * its body: the table never shows one, and a page of rows carrying whole auto-settings
         * profiles is megabytes nobody reads. The request itself has the body when somebody opens
         * it.
         */
        payload: {
          hours: l.payload.hours, days: l.payload.days, reason: l.payload.reason, message: l.payload.message,
          ...(l.kind === "route" ? { label: l.payload.label } : {}),
        },
      })));
    sendJson(res, 200, { decisions, limit });
  }),

  // NOTE: registered after /api/requests/draft and /history above — ":id" would otherwise swallow
  // both of those literal paths.
  route("GET", "/api/requests/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const r = await ctx.repo.approvals.get(params.id!);
    if (!r || r.status === "draft") return sendError(res, 404, "request not found");
    // Visible to its requester and to anyone who could sign (or could have signed) part of it.
    const v = await view(ctx, p, r, await nameMap(ctx, [r]));
    if (!v.own && !r.lines.some((l) => approvalRefusal({ userId: p.user.id, grants: p.grants }, l.capability, l.serverId) === null)) {
      return sendError(res, 404, "request not found");
    }
    sendJson(res, 200, { request: v });
  }),

  route("POST", "/api/requests/:id/lines/:lineId/approve", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const r = await ctx.repo.approvals.get(params.id!);
    if (!r) return sendError(res, 404, "request not found");
    if (r.status !== "open") return sendError(res, 409, `this request is ${r.status}`);
    const line = r.lines.find((l) => l.id === params.lineId);
    if (!line) return sendError(res, 404, "line not found");
    if (line.state !== "pending") return sendError(res, 409, `already ${line.state}${line.decidedByName ? ` by ${line.decidedByName}` : ""}`);
    const body = await readJsonBody(req);
    const mod = parseModification(line, body);
    if (mod.error) return sendError(res, 400, mod.error);
    const out = await approveLine(ctx, p, r, line, mod.modified);
    if ("refusal" in out) return sendError(res, 403, out.refusal);
    if ("raced" in out) return sendError(res, 409, "already handled by another approver");
    void updateApprovalCard(ctx, r.id);
    // `cascaded` is present when the signer covered part of the ask and the remainder was filed
    // onwards — the panel says so, because a silent partial approval reads as a full one. The
    // follow-up gets its own relay card, exactly like the split at filing time: the people who
    // can finish it are the ones watching that channel.
    if (out.cascaded) void postApprovalCard(ctx, out.cascaded.requestId);
    sendJson(res, 200, { line: out.line, applyError: out.applyError, cascaded: out.cascaded });
  }),

  route("POST", "/api/requests/:id/lines/:lineId/deny", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const r = await ctx.repo.approvals.get(params.id!);
    if (!r) return sendError(res, 404, "request not found");
    if (r.status !== "open") return sendError(res, 409, `this request is ${r.status}`);
    const line = r.lines.find((l) => l.id === params.lineId);
    if (!line) return sendError(res, 404, "line not found");
    const body = await readJsonBody(req);
    // A denial without a reason is a wall; with one it is coaching. The requester reads it.
    const reason = str(body.reason).trim();
    if (!reason) return sendError(res, 400, "a reason is required — the requester reads it");
    const out = await denyLine(ctx, p, r, line, reason);
    if ("refusal" in out) return sendError(res, 403, out.refusal);
    if ("raced" in out) return sendError(res, 409, "already handled by another approver");
    void updateApprovalCard(ctx, r.id);
    sendJson(res, 200, { line: out.line });
  }),

  /** Sign every pending line THIS approver may sign; report the rest with the reason each was
   *  left alone. One stamp per line, same as clicking them one by one. */
  route("POST", "/api/requests/:id/approve-all", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const r = await ctx.repo.approvals.get(params.id!);
    if (!r) return sendError(res, 404, "request not found");
    if (r.status !== "open") return sendError(res, 409, `this request is ${r.status}`);
    const approved: { lineId: string; applyError: string | null; cascaded?: { appliedHours: number; requestedHours: number; requestId: string } }[] = [];
    const skipped: { lineId: string; reason: string }[] = [];
    for (const line of r.lines) {
      if (line.state !== "pending") continue;
      const out = await approveLine(ctx, p, r, line, null);
      if ("refusal" in out) skipped.push({ lineId: line.id, reason: out.refusal });
      else if ("raced" in out) skipped.push({ lineId: line.id, reason: "already handled by another approver" });
      else {
        // Approve-all signs each line the same way the buttons do, cascade included — a bundle
        // must not quietly swallow the fact that half a ban went onwards for a longer signature.
        if (out.cascaded) void postApprovalCard(ctx, out.cascaded.requestId);
        approved.push({ lineId: line.id, applyError: out.applyError, cascaded: out.cascaded });
      }
    }
    if (!approved.length && skipped.length) return sendError(res, 409, `nothing signed: ${skipped[0]!.reason}`);
    void updateApprovalCard(ctx, r.id);
    sendJson(res, 200, { approved, skipped });
  }),

  /** The requester pulls their own request back. Decided lines keep their stamps — they happened. */
  route("POST", "/api/requests/:id/withdraw", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const r = await ctx.repo.approvals.get(params.id!);
    if (!r) return sendError(res, 404, "request not found");
    if (r.requesterUserId !== p.user.id) return sendError(res, 403, "only the requester can withdraw a request");
    const w = await ctx.repo.approvals.withdraw(r.id);
    if (!w) return sendError(res, 409, `this request is ${r.status}`);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "request.withdraw",
      targetType: "request", targetId: r.id, summary: "withdrew their approval request",
      data: { requestId: r.id },
    });
    void updateApprovalCard(ctx, r.id);
    sendJson(res, 200, { request: await view(ctx, p, w, await nameMap(ctx, [w])) });
  }),
  /* ---------------- the builder: one private draft per user, filed on review ---------------- */

  /** Enter (or resume) request mode: everyone has at most one draft, and coming back finds it.
   *  Resuming un-parks a saved draft — the view elevation returns with the bar, not before. */
  route("POST", "/api/requests/draft", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const existing = await ctx.repo.approvals.findDraft(p.user.id);
    const d = existing
      ? (existing.parkedAt ? (await ctx.repo.approvals.parkDraft(p.user.id, false)) ?? existing : existing)
      : await ctx.repo.approvals.create({ requesterUserId: p.user.id, requesterName: p.name });
    sendJson(res, 200, { draft: d });
  }),

  /** "Save draft": park it. The lines are kept and resume later, but a parked draft confers no
   *  view elevation — leaving the builder ends the widened view instead of hiding it. */
  route("POST", "/api/requests/draft/park", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const d = await ctx.repo.approvals.parkDraft(p.user.id, true);
    if (!d) return sendError(res, 404, "no draft");
    sendJson(res, 200, { draft: d });
  }),

  route("DELETE", "/api/requests/draft", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const d = await ctx.repo.approvals.findDraft(p.user.id);
    if (d) await ctx.repo.approvals.discardDraft(d.id);
    sendJson(res, 200, { ok: true });
  }),

  /** Reviewing means being able to drop a row before filing. */
  route("DELETE", "/api/requests/draft/lines/:lineId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const d = await ctx.repo.approvals.findDraft(p.user.id);
    if (!d) return sendError(res, 404, "no draft");
    if (!(await ctx.repo.approvals.removeLine(d.id, params.lineId!))) return sendError(res, 404, "line not found");
    sendJson(res, 200, { ok: true });
  }),

  /**
   * Submit the draft — the "does everything look right" moment made real. Lines the requester
   * holds at WRITE execute now, under their own name (they never needed anyone's signature; the
   * builder is a cart, not a demotion); the rest are filed as one bundle for the queue. Nothing
   * executed anything while the cart was being filled — this click is when the world changes.
   */
  route("POST", "/api/requests/draft/submit", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const d = await ctx.repo.approvals.findDraft(p.user.id);
    if (!d || !d.lines.length) return sendError(res, 400, "the request is empty — add an action first");
    const applied: { lineId: string; kind: string; error: string | null }[] = [];
    let asked = 0;
    for (const line of d.lines) {
      if (await executesAsOwn(ctx, p, line)) {
        const { error, refused } = await executeApprovedLine(ctx, p, line, { suffix: "" });
        /*
         * It stopped at a SECOND key they lack — adding someone to a VIP-perk group needs the VIP
         * key on the perk's servers, not just the groups key the cart judged it by. That is not a
         * failure, it is an ask: the line goes for a signature, asking for the key it found
         * missing, exactly as the same press outside the cart would have filed it. (A refusal
         * stops a handler before it changes anything, so nothing has half-happened.)
         */
        if (refused && line.kind === "route") {
          await ctx.repo.approvals.removeLine(d.id, line.id);
          await ctx.repo.approvals.addLine(d.id, {
            serverId: refused.serverId ?? line.serverId, capability: refused.capability, kind: line.kind,
            payload: line.payload, playerId: line.playerId, playerName: line.playerName, seq: line.seq,
          });
          asked++;
          continue;
        }
        await ctx.repo.approvals.markExecuted(line.id, { userId: p.user.id, name: p.name }, error);
        applied.push({ lineId: line.id, kind: line.kind, error });
      } else {
        asked++;
      }
    }
    await ctx.repo.approvals.submit(d.id, new Date(Date.now() + REQUEST_TTL_HOURS * 3_600_000).toISOString());
    // All-immediate bundles resolve in the same motion; a mixed one stays open on its ask lines.
    const settled = await ctx.repo.approvals.settle(d.id);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "request.file",
      targetType: "request", targetId: d.id,
      summary: `submitted a built request: ${applied.length} applied under their own permissions, ${asked} filed for approval`,
      data: { requestId: d.id, applied: applied.length, asked },
    });
    if (asked > 0) void postApprovalCard(ctx, d.id);
    sendJson(res, 200, { applied, filed: asked > 0 ? d.id : null, request: settled });
  }),
];
