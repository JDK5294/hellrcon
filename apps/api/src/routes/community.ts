/**
 * The staff noticeboard: notices, read receipts, acknowledgements, and the unread-notice nudge config.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { displayNameOf } from "../auth.js";
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson, str } from "../http.js";
import { canAnywhere } from "@app/access";
import { pageLimit, pageOffset, requirePrincipal, route, sendForbidden, type Route } from "./kit.js";

export const communityRoutes: Route[] = [
  // --- Staff announcements (the notice board every logged-in staff member sees) ---
  // Formerly the public community feed; the public site moved off-panel, so reading now requires a
  // session — nothing is served unauthenticated. Posted (published) notices only. Every row
  // carries the requesting user's own read state (myRead), so the board can show NEW badges and
  // the Acknowledge button without a second round-trip.
  //
  // A page at a time (`offset`, `limit`), with how many there are in `total`. The board read the
  // newest fifty and no more, so an older notice could not be found on it at all.
  route("GET", "/api/community/announcements", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const u = new URL(req.url ?? "/", "http://x").searchParams;
    const [rows, total, myReads] = await Promise.all([
      ctx.repo.announcements.listPublished(pageLimit(u, 50, 500), pageOffset(u)),
      ctx.repo.announcements.countPublished(),
      ctx.repo.announcements.readsForUser(p.user.id),
    ]);
    const mine = new Map(myReads.map((r) => [r.announcementId, r]));
    sendJson(res, 200, { announcements: rows.map((a) => ({ ...a, myRead: mine.get(a.id) ?? null })), total });
  }),

  // --- Announcement management (requires the community.edit capability; drafts included) ---
  // Paged like the board: it read the newest hundred, drafts included, and no further.
  route("GET", "/api/community/announcements/all", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "community.edit", "read")) return sendForbidden(res, "community.edit", "read");
    const u = new URL(req.url ?? "/", "http://x").searchParams;
    const [rows, total, myReads] = await Promise.all([
      ctx.repo.announcements.listAll(pageLimit(u, 100, 500), pageOffset(u)),
      ctx.repo.announcements.countAll(),
      ctx.repo.announcements.readsForUser(p.user.id),
    ]);
    const mine = new Map(myReads.map((r) => [r.announcementId, r]));
    sendJson(res, 200, { announcements: rows.map((a) => ({ ...a, myRead: mine.get(a.id) ?? null })), total });
  }),

  // The board calls this after rendering: first-read receipts for the posted notices the user
  // just saw. Idempotent; the first read time is never overwritten, so re-visits don't skew the
  // time-to-see analytics.
  route("POST", "/api/community/announcements/read", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const body = await readJsonBody(req);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => str(x)).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    if (ids.length) await ctx.repo.announcements.markRead(p.user.id, ids.slice(0, 200));
    sendJson(res, 200, { ok: true });
  }),

  // Explicit "✓ Acknowledge" — the stronger signal for policy changes (implies read).
  route("POST", "/api/community/announcements/:id/ack", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const read = await ctx.repo.announcements.acknowledge(params.id!, p.user.id);
    if (!read) return sendError(res, 404, "notice not found (or not posted)");
    sendJson(res, 200, { read });
  }),

  // Who has seen / acknowledged one notice, and how long after posting — for the people who run
  // the board (community.edit). Includes who HASN'T seen it, which is usually the question.
  route("GET", "/api/community/announcements/:id/reads", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "community.edit", "write")) return sendForbidden(res, "community.edit", "write");
    const a = await ctx.repo.announcements.get(params.id!);
    if (!a) return sendError(res, 404, "notice not found");
    const [reads, users] = await Promise.all([ctx.repo.announcements.reads(a.id), ctx.repo.users.list()]);
    const nameOf = new Map(users.map((u) => [u.id, displayNameOf(u)]));
    const minutesToSee = (readAt: string) => (a.publishedAt ? Math.max(0, Math.round((Date.parse(readAt) - Date.parse(a.publishedAt)) / 60_000)) : null);
    const readerIds = new Set(reads.map((r) => r.userId));
    sendJson(res, 200, {
      announcement: { id: a.id, title: a.title, published: a.published, publishedAt: a.publishedAt },
      staffCount: users.length,
      reads: reads.map((r) => ({ userId: r.userId, name: nameOf.get(r.userId) ?? r.userId, readAt: r.readAt, acknowledgedAt: r.acknowledgedAt, minutesToSee: minutesToSee(r.readAt) })),
      unread: users.filter((u) => !readerIds.has(u.id)).map((u) => ({ userId: u.id, name: displayNameOf(u) })),
    });
  }),

  // The Discord unread-notice nudge: after N hours, the worker posts one reminder per notice in
  // the configured staff channel naming whoever still hasn't opened the board. Editors configure it.
  route("GET", "/api/community/announcements/nudge-config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "community.edit", "read")) return sendForbidden(res, "community.edit", "read");
    // The staff list rides along for the excused-picker: the people the nudge would name are the
    // options for who it should not, and shipping them here keeps the picker behind the SAME gate
    // instead of making noticeboard editors also hold admin.users.
    const [config, users] = await Promise.all([ctx.repo.announcements.getNudgeConfig(), ctx.repo.users.list()]);
    sendJson(res, 200, { config, staff: users.map((u) => ({ id: u.id, name: displayNameOf(u) })) });
  }),

  route("PUT", "/api/community/announcements/nudge-config", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "community.edit", "write")) return sendForbidden(res, "community.edit", "write");
    const body = await readJsonBody(req);
    const patch: { enabled?: boolean; channelId?: string; afterHours?: number; excusedUserIds?: string[] } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (body.channelId !== undefined) {
      const id = str(body.channelId).trim();
      if (id && !/^\d{5,}$/.test(id)) return sendError(res, 400, "channelId must be a numeric Discord channel id");
      patch.channelId = id;
    }
    if (body.afterHours !== undefined) {
      const h = Number(body.afterHours);
      if (!(h >= 1 && h <= 24 * 30)) return sendError(res, 400, "afterHours must be between 1 and 720");
      patch.afterHours = Math.round(h);
    }
    if (body.excusedUserIds !== undefined) {
      if (!Array.isArray(body.excusedUserIds)) return sendError(res, 400, "excusedUserIds must be an array of user ids");
      const ids = [...new Set((body.excusedUserIds as unknown[]).map((x) => str(x).trim()).filter(Boolean))];
      if (ids.length > 200) return sendError(res, 400, "at most 200 excused staff");
      // Real accounts only: a typo'd id would sit in the list reading as an excusal while
      // excusing nobody the nudge was ever going to name.
      for (const id of ids) {
        if (!(await ctx.repo.users.findById(id))) return sendError(res, 400, "excusedUserIds names an account that is not a user here — pick from the staff list");
      }
      patch.excusedUserIds = ids;
    }
    const effective = { ...(await ctx.repo.announcements.getNudgeConfig()), ...patch };
    if (effective.enabled && !effective.channelId) return sendError(res, 400, "enabled needs a channelId (the nudge has nowhere to post)");
    const config = await ctx.repo.announcements.setNudgeConfig(patch);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "announcement.nudge_config",
      targetType: "setting", targetId: "announcement.nudge",
      summary: `${config.enabled ? `set the unread-notice nudge to post after ${config.afterHours}h` : "turned the unread-notice nudge off"}${patch.excusedUserIds ? ` — ${config.excusedUserIds.length} staff excused from being named` : ""}`,
      data: { patch },
    });
    sendJson(res, 200, { config });
  }),

  // Board-wide read analytics: per-notice seen/acknowledged counts and time-to-see, plus the
  // overall read rate — "does the team actually read these, and how fast".
  route("GET", "/api/community/announcements/analytics", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // Two different reasons to hold these read receipts, so either unlocks them:
    //   - you RUN the board (community.edit) — the notice list shows per-notice reach inline, and
    //     it always has;
    //   - you were granted the ANALYTICS page (analytics.announcements) — reporting on whether the
    //     team reads its notices, without the ability to post one.
    // The denial names the analytics capability, since that is the one an admin is likelier to
    // want to grant for this.
    if (!canAnywhere(p.grants, "analytics.announcements", "read") && !canAnywhere(p.grants, "community.edit", "write")) {
      return sendForbidden(res, "analytics.announcements", "read");
    }
    // Which notices: the newest hundred, drafts included, unless `offset`/`limit` pick others in
    // the same order — the board asks after the page of notices it is showing, which can be any.
    const u = new URL(req.url ?? "/", "http://x").searchParams;
    const [rows, users] = await Promise.all([ctx.repo.announcements.listAll(pageLimit(u, 100, 200), pageOffset(u)), ctx.repo.users.list()]);
    const staffCount = users.length;
    const notices = await Promise.all(rows.map(async (a) => {
      const reads = await ctx.repo.announcements.reads(a.id);
      const minutes = a.publishedAt
        ? reads.map((r) => Math.max(0, (Date.parse(r.readAt) - Date.parse(a.publishedAt!)) / 60_000)).sort((x, y) => x - y)
        : [];
      const median = minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)]! : null;
      const avg = minutes.length ? minutes.reduce((s, m) => s + m, 0) / minutes.length : null;
      return {
        id: a.id, title: a.title, published: a.published, publishedAt: a.publishedAt,
        readCount: reads.length, ackCount: reads.filter((r) => r.acknowledgedAt).length, staffCount,
        avgMinutesToSee: avg === null ? null : Math.round(avg),
        medianMinutesToSee: median === null ? null : Math.round(median),
      };
    }));
    const posted = notices.filter((n) => n.published);
    const readRate = posted.length && staffCount ? posted.reduce((s, n) => s + n.readCount / staffCount, 0) / posted.length : null;
    const allAvgs = posted.map((n) => n.avgMinutesToSee).filter((m): m is number => m !== null);
    sendJson(res, 200, {
      staffCount,
      postedCount: posted.length,
      overallReadRate: readRate === null ? null : Math.round(readRate * 100) / 100,
      overallAvgMinutesToSee: allAvgs.length ? Math.round(allAvgs.reduce((s, m) => s + m, 0) / allAvgs.length) : null,
      notices,
    });
  }),

  route("POST", "/api/community/announcements", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "community.edit", "write")) return sendForbidden(res, "community.edit", "write");
    const body = await readJsonBody(req);
    const title = boundedText(body.title, TEXT_MAX.name, "title");
    const text = boundedText(body.body, TEXT_MAX.post, "body");
    if (!title || !text) return sendError(res, 400, "title and body are required");
    const row = await ctx.repo.announcements.create({ title, body: text, published: Boolean(body.published), authorUserId: p.user.id });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "announcement.create",
      targetType: "announcement", targetId: row.id, targetName: row.title,
      summary: `${row.published ? "posted" : "drafted"} the notice "${row.title}"`,
      data: { published: row.published },
    });
    sendJson(res, 201, { announcement: row });
  }),

  route("PATCH", "/api/community/announcements/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "community.edit", "write")) return sendForbidden(res, "community.edit", "write");
    const body = await readJsonBody(req);
    const patch: { title?: string; body?: string; published?: boolean } = {};
    // Same bounds and blank-refusal as creating one — without them an edit could blank a notice's
    // title or store a body far past what any reader (or the create route) would accept.
    if (typeof body.title === "string") {
      const title = boundedText(body.title, TEXT_MAX.name, "title");
      if (!title) return sendError(res, 400, "title cannot be blank");
      patch.title = title;
    }
    if (typeof body.body === "string") {
      const text = boundedText(body.body, TEXT_MAX.post, "body");
      if (!text) return sendError(res, 400, "body cannot be blank");
      patch.body = text;
    }
    if (typeof body.published === "boolean") patch.published = body.published;
    const before = await ctx.repo.announcements.get(params.id!);
    const row = await ctx.repo.announcements.update(params.id!, patch);
    if (!row) return sendError(res, 404, "announcement not found");
    // Publishing is the edit that matters most — it is the moment the whole team is expected to
    // have read something — so it gets its own wording rather than a generic "edited".
    const published = before && !before.published && row.published;
    const unpublished = before && before.published && !row.published;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name,
      action: published ? "announcement.publish" : unpublished ? "announcement.unpublish" : "announcement.update",
      targetType: "announcement", targetId: row.id, targetName: row.title,
      summary: `${published ? "posted" : unpublished ? "withdrew" : "edited"} the notice "${row.title}"`,
      data: { patch: Object.keys(patch) },
    });
    sendJson(res, 200, { announcement: row });
  }),

  route("DELETE", "/api/community/announcements/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "community.edit", "write")) return sendForbidden(res, "community.edit", "write");
    const before = await ctx.repo.announcements.get(params.id!);
    const ok = await ctx.repo.announcements.remove(params.id!);
    if (!ok) return sendError(res, 404, "announcement not found");
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "announcement.delete",
      targetType: "announcement", targetId: params.id!, targetName: before?.title,
      summary: `deleted the notice "${before?.title ?? params.id}"`,
      data: { title: before?.title ?? null, wasPublished: before?.published ?? null },
    });
    sendJson(res, 200, { deleted: true });
  }),
];
