/**
 * The analytics reads. Each page has its own capability; none of them writes anything.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { buildCombatSummary, buildMapVoteAnalytics, buildMatchTrends, buildStaffTeamAnalytics, countableActions, distribute, foldPlatformModeration, percentileOf, teamCategoryOf, weekHourGrid } from "../analytics.js";
import { scopeCovers, type BanScope } from "../ban-scope.js";
import { vipHistoryReplay } from "../vip-history.js";
import { HOUR_METRICS, isHourMetric, type AuditRow } from "@app/db";
import { displayNameOf } from "../auth.js";
import { sendError, sendJson } from "../http.js";
import { buildStaffAnalytics } from "../staff-analytics.js";
import { buildMatchReport, headcountTimeline, HEADCOUNT_MAX_MINUTES } from "../match-report.js";
import { seedingAuditFor } from "../seeding-audit.js";
import { auditChanges, auditDetails } from "../audit-changes.js";
import { can, canAnywhere } from "@app/access";
import { errors } from "@app/shared";
import { classifyWeapon, getGame } from "@app/games";
import { adminResponseFor, resolveAnalyticsWindow, currentActorNames, readableAudit, pageAnchor, pageLimit, pageOffset, requirePrincipal, serverScope, route, sendForbidden, viewerTimeZone, type Route } from "./kit.js";

/** The audit store's own per-page ceiling. Asking for more than this silently returns this many. */
const AUDIT_PAGE = 500;
/**
 * How much of a window an aggregate will read before it gives up and says so.
 *
 * A month of HUMAN staff actions is nowhere near this even for a busy community — the loop below
 * almost always stops on a short page long before it. The number exists so that a pathological
 * window cannot pull an unbounded table into memory, and so the one case where it bites is
 * reported rather than silently under-counted.
 */
const STAFF_ANALYTICS_MAX = 20_000;

/**
 * Read a whole window a page at a time, up to `max`.
 *
 * `truncated` is the point. A single capped read hands back a number that looks like an answer and
 * is quietly too low; this says which of the two it gave you.
 */
async function gatherPages<T>(read: (offset: number) => Promise<T[]>, max: number): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (;;) {
    const page = await read(rows.length);
    rows.push(...page);
    if (page.length < AUDIT_PAGE) return { rows, truncated: false }; // a short page means the window is spent
    if (rows.length >= max) return { rows: rows.slice(0, max), truncated: true };
  }
}

/**
 * Each analytics read carries its NAME into any failure: a bare 500 with a ref meant staring at a
 * handful of parallel queries wondering which one broke on which install's data. The page's error
 * then says "the concurrency read failed: <database's own words>" — an admin surface may say that
 * much, and it is exactly what a field report needs to be actionable.
 *
 * A 500, never a 502: the install sits behind Cloudflare, which swaps an origin 502 for its own
 * bodyless page — so the database's words never reached the page, and every failed read showed
 * up as "the proxy did not answer", pointing at the tunnel instead of the query.
 */
function labelRead<T>(name: string, p: Promise<T>, serverId: string | undefined): Promise<T> {
  return p.catch((err) => { throw errors.readFailed(`the ${name} read failed: ${(err as Error).message}`, { serverId }); });
}

export const analyticsRoutes: Route[] = [
  // One more figure for the When people play grid, read when somebody picks it, so the page's own
  // load (players online) stays what it was. One server only: a peak or a side gap added up across
  // servers would describe no server at all.
  route("GET", "/api/analytics/server/hours", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const serverId = u.get("serverId") || undefined;
    if (!serverId) return sendError(res, 400, "serverId is required");
    if (!can(p.grants, "analytics.server", "read", { serverId })) return sendForbidden(res, "analytics.server", "read");
    const metric = u.get("metric");
    if (!isHourMetric(metric)) return sendError(res, 400, `metric must be one of: ${HOUR_METRICS.join(", ")}`);
    const win = await resolveAnalyticsWindow(ctx.repo, u, serverId);
    const rows = await ctx.repo.analytics.hourGrid({ ...win, serverId, tz: viewerTimeZone(req) }, metric);
    sendJson(res, 200, { metric, window: { from: win.from, to: win.to }, rows });
  }),
  route("GET", "/api/analytics/server", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const serverId = u.get("serverId") || undefined;
    if (!can(p.grants, "analytics.server", "read", { serverId })) return sendForbidden(res, "analytics.server", "read");
    const win = await resolveAnalyticsWindow(ctx.repo, u, serverId);
    // Resolved once and passed to everything that buckets. Read separately per call, two builders
    // on one page could be answered about two different weeks — which is exactly what happened
    // while the occupancy heatmap was still on UTC and the session heatmap beside it was not.
    const tz = viewerTimeZone(req);
    const label = <T,>(name: string, p: Promise<T>) => labelRead(name, p, serverId);
    // Who held VIP when, rebuilt from the VIP history up to the window's end (a row after it can
    // only start or end VIP after it), read beside everything else. Today's list goes under it once
    // both are in.
    const replay = vipHistoryReplay({ serverId, now: Date.now() });
    const readVipHistory = async (): Promise<void> => {
      let cursor: string | null = null;
      do {
        const page: { rows: AuditRow[]; next: string | null } = await ctx.repo.audit.vipTimeline(cursor, 5000, { serverId, before: win.to });
        for (const e of page.rows) replay.feed(e);
        cursor = page.next;
      } while (cursor);
    };
    const [activity, mix, matches, concurrency, scores, platform, platformTrend, banRecord, vipRecord, servers] = await Promise.all([
      label("session-activity", ctx.repo.analytics.sessionActivity({ ...win, tz })),
      label("player-mix", ctx.repo.analytics.playerMix(win)), // counts, not buckets — no zone to get wrong
      label("matches", ctx.repo.analytics.matchesInWindow(win)),
      label("concurrency", ctx.repo.analytics.concurrency({ ...win, tz })),
      label("score-trends", ctx.repo.analytics.scoreTrends({ ...win, tz })),
      label("platform-breakdown", ctx.repo.analytics.platformBreakdown(win)), // sums, not buckets — no zone to get wrong
      label("platform-trend", ctx.repo.analytics.platformTrend({ ...win, tz })),
      label("ban-record", ctx.repo.playerBans.list()),
      label("vip-record", ctx.repo.vips.list(serverId)),
      label("server-list", ctx.repo.servers.list()),
      label("vip-history", readVipHistory()),
    ]);
    const vipStretches = replay.finish(vipRecord);
    // Bans and VIP for the platform split. Only the ids it can count are looked up: decisions made
    // in the window, and the players who held VIP.
    const from = Date.parse(win.from), to = Date.parse(win.to);
    const bans = banRecord.filter((b) => Date.parse(b.createdAt) >= from && Date.parse(b.createdAt) < to);
    const directory = new Map((await label("player-directory", ctx.repo.players.findByPlatformIds(
      [...new Set([...bans.map((b) => b.playerId), ...vipStretches.filter((v) => v.to > from && v.from < to).map((v) => v.playerId)])],
    ))).map((pl) => [pl.platformId, pl.platform]));
    // The ban list's own rule for "covers this server". A server no longer in the list (retired)
    // has nothing a ban can be counted against.
    const shown = serverId ? servers.find((sv) => sv.id === serverId) : undefined;
    const split = foldPlatformModeration(platform.rows, platformTrend.rows, {
      bans, vipStretches, platformOf: (id) => directory.get(id),
      covers: (b) => !serverId || (shown !== undefined && scopeCovers(b.scope as BanScope, shown, b.game)),
      from: win.from, to: win.to, tz,
    });
    sendJson(res, 200, {
      window: { from: win.from, to: win.to },
      activity,
      // The crossplay split: who plays here per platform, how the finished rounds went for each,
      // and the bans and VIP that belong to each. Sums on the wire; the page derives every ratio.
      // The trend beside it is the same split per local day, for the lines.
      platform: { rows: split.rows },
      platformTrend: { rows: split.trend },
      // VIPs on this server per local day, every platform together, every day in the window.
      vipDaily: split.vipDaily,
      // How many were on AT ONCE, which is what "how busy are we" means. `activity` counts session
      // starts, which answers a different question and used to be the only one on offer.
      concurrency,
      mix,
      // The balance headline belongs here too: "are our matches worth playing" is a server-health
      // question as much as a match-analytics one.
      balance: buildMatchTrends(matches, tz),
      // What KIND of game is being played here, from the game's own score buckets rather than the
      // kill log. Population says whether the server is busy; this says whether it is being played.
      scores,
    });
  }),

  route("GET", "/api/analytics/match", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const serverId = u.get("serverId") || undefined;
    if (!can(p.grants, "analytics.match", "read", { serverId })) return sendForbidden(res, "analytics.match", "read");
    const win = await resolveAnalyticsWindow(ctx.repo, u, serverId);
    const matches = await labelRead("matches", ctx.repo.analytics.matchesInWindow(win), serverId);
    sendJson(res, 200, { window: { from: win.from, to: win.to }, ...buildMatchTrends(matches, viewerTimeZone(req)) });
  }),

  route("GET", "/api/analytics/staff", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "analytics.staff", "read")) return sendForbidden(res, "analytics.staff", "read");
    const scope = await serverScope(req, res, ctx, p, "analytics.staff");
    if (!scope) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const win = await resolveAnalyticsWindow(ctx.repo, u, scope.requested ?? undefined);
    // Humans are selected BY THE QUERY, and the window is read a page at a time.
    //
    // This used to take the most recent 500 entries and keep the human ones. Automation outnumbers
    // staff hundreds to one, so once a rule gets busy — the crash-VIP grant on a full server is one
    // audit row per disconnect — those 500 rows are all machinery and the human filter is left with
    // nothing. The whole team read as zero across a 30-day window in which every one of their
    // actions was still sitting in the table. Nothing had been deleted; the page simply never
    // looked past the noise.
    //
    // Paged rather than one bigger read because the store ceilings a page at 500 (right for a UI
    // list, wrong for a month's aggregate): a single capped read would trade a team that reads as
    // zero for one that reads as too low, which is the same lie told more quietly.
    const { rows: entries, truncated } = await gatherPages((offset) => ctx.repo.audit.list({
      from: win.from, to: win.to, actor: "human", limit: AUDIT_PAGE, offset,
      // For an unrestricted viewer the server filter is a VIEW choice, so community-wide work —
      // watchlist flags, notes, account and template changes, none of which carry a server —
      // stays measured. Without this, picking (or pinning) a server zeroed exactly the staff
      // whose month was that kind of work, while their own profile page still showed it all.
      ...(scope.serverIds ? { serverIds: scope.serverIds, includeUnscoped: !scope.restricted } : {}),
    }), STAFF_ANALYTICS_MAX);
    // The whole team, not only whoever acted: an admin with a quiet window is a fact worth
    // seeing, and omitting them made "no actions" indistinguishable from "not on the team".
    const accounts = await ctx.repo.users.list();
    const rolesByUser = await ctx.repo.userRoles.listByUsers(accounts.map((u) => u.id));
    const roster = accounts.map((u) => ({
      userId: u.id,
      name: u.discordNick || u.discordUsername || u.username,
      roleIds: [...new Set((rolesByUser.get(u.id) ?? []).map((a) => a.roleId))],
    }));
    const rosterIds = new Set(roster.map((m) => m.userId));
    // Staff analytics is about the PEOPLE WHO ARE HERE: how the current team splits the work, who
    // covers which hours, who is carrying it. Two populations are cut out.
    //
    // The app's own automation (no actor account) is not a colleague — its share-of-actions bar
    // reduced every human to a sliver — and it reports under Administration → System instead.
    //
    // Departed staff are cut too, and that is the difference between this page and Administration
    // → Staff activity. Their work is not erased: the audit trail keeps every action under the
    // name that took it, forever, and Staff activity is where you go to read it. But a coverage
    // grid and a workload split are for planning THIS week's roster, and someone who left in March
    // holding 30% of the share makes that read wrong — the remaining shares no longer sum to the
    // team, and the busiest-member figure describes someone who cannot take a shift. So the cut is
    // made on the ENTRIES, not just the member list, so totals, shares, the donut, the hour grid
    // and the response metric all describe one coherent population: the staff you have.
    //
    // (The automation cut is the query's `actor: "human"` above, not a check here — doing it on the
    // rows a limited read returned is what emptied this page.)
    // Bulk volleys count ONCE — the per-target rows stay in the trail and on player profiles,
    // but "messaged the whole server" is one act of staffing, not a hundred, and the second half
    // of a split ban is the same ban (countableActions).
    const allHumans = countableActions(entries.filter((e) => e.actorUserId && rosterIds.has(e.actorUserId)));
    /*
     * The viewer's exclusions, applied to EVERY measurement on the page: totals, shares, the
     * split, the hour grids, the timeline and the response pairing all describe one population,
     * or the page argues with itself. Hiding is a lens, never a record — the trail keeps
     * everything — and it exists because a settings-heavy owner's config work drowned the
     * moderation picture this page is for. `allMembers` is returned PRE-hide so the picker can
     * always offer the way back.
     */
    const hideUsers = new Set((u.get("hideUsers") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const hideCats = new Set((u.get("hideCategories") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    const humans = allHumans
      .filter((e) => !hideUsers.has(e.actorUserId!))
      .filter((e) => !hideCats.has(teamCategoryOf(e.action)));
    const shownRoster = roster.filter((m) => !hideUsers.has(m.userId));
    const team = buildStaffTeamAnalytics(humans, viewerTimeZone(req), shownRoster);
    // Names follow the person: a rename should propagate to every past action, same as the trail.
    const nameById = await currentActorNames(ctx);
    const response = await adminResponseFor(ctx, win, humans, viewerTimeZone(req));
    sendJson(res, 200, {
      window: { from: win.from, to: win.to },
      ...team,
      members: team.members.map((m) => ({ ...m, name: (m.userId && nameById.get(m.userId)) || m.name })),
      // The whole team regardless of hiding, so the "measured" picker can list who is hidden.
      allMembers: roster.map((m) => ({ userId: m.userId, name: nameById.get(m.userId) || m.name })),
      roles: (await ctx.repo.roles.list()).map((r) => ({ id: r.id, name: r.name })),
      response,
      // True only when the window held more human actions than one read will carry. Every figure
      // on the page then describes the most recent slice rather than the window asked for, and a
      // reader is owed that sentence — an aggregate that is quietly short is worse than no number.
      truncated,
    });
  }),

  route("GET", "/api/analytics/mapvote", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const serverId = u.get("serverId") || undefined;
    if (!can(p.grants, "analytics.mapvote", "read", { serverId })) return sendForbidden(res, "analytics.mapvote", "read");
    if (!serverId) return sendJson(res, 200, { window: null, votesHeld: 0, decidedByVote: 0, overridden: 0, overrideRate: null, totalBallots: 0, avgTurnout: null, maps: [], timeline: [] });
    const win = await resolveAnalyticsWindow(ctx.repo, u, serverId);
    const [history, tally] = await Promise.all([
      ctx.repo.mapVote.history(serverId, 500),
      ctx.repo.mapVote.mapTally(serverId),
    ]);
    const inWindow = history.filter((h) => h.decidedAt >= win.from && h.decidedAt < win.to);
    sendJson(res, 200, { window: { from: win.from, to: win.to }, ...buildMapVoteAnalytics(inWindow, tally, viewerTimeZone(req)) });
  }),

  route("GET", "/api/analytics/combat", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const serverId = u.get("serverId") || undefined;
    if (!can(p.grants, "analytics.combat", "read", { serverId })) return sendForbidden(res, "analytics.combat", "read");
    const win = await resolveAnalyticsWindow(ctx.repo, u, serverId);
    const activity = await labelRead("combat", ctx.repo.analytics.combat({ ...win, tz: viewerTimeZone(req) }), serverId);
    // Which weapon is a rifle and which is artillery is game knowledge, so the store counts raw
    // strings and the descriptor buckets them here. A server we can't identify still gets every
    // weapon listed — they just all land in "Other" rather than the page going blank.
    const server = serverId ? await ctx.repo.servers.findById(serverId) : null;
    const descriptor = getGame(server?.game)?.descriptor ?? null;
    sendJson(res, 200, {
      window: { from: win.from, to: win.to },
      ...buildCombatSummary(activity.totals, activity.byWeapon, (w) => classifyWeapon(descriptor, w)),
      daily: activity.daily,
      weekHour: activity.weekHour,
      byHour: activity.byHour,
      topKillers: activity.topKillers,
      topTeamkillers: activity.topTeamkillers,
      byMap: activity.byMap,
    });
  }),

  route("GET", "/api/analytics/composition", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const serverId = u.get("serverId") || undefined;
    if (!can(p.grants, "analytics.composition", "read", { serverId })) return sendForbidden(res, "analytics.composition", "read");
    const win = await resolveAnalyticsWindow(ctx.repo, u, serverId);
    const composition = await labelRead("composition", ctx.repo.analytics.composition(win), serverId);
    // Role numbers and side ids are the game's; the labels for them live in the descriptor. Sent
    // alongside so the page can name a role without a second round-trip and without the panel
    // holding a copy of any game's role table.
    const server = serverId ? await ctx.repo.servers.findById(serverId) : null;
    const descriptor = getGame(server?.game)?.descriptor ?? null;
    sendJson(res, 200, {
      window: { from: win.from, to: win.to },
      ...composition,
      roles: descriptor?.roles ?? {},
      sides: (descriptor?.sides ?? []).map((s) => ({ id: s.id, label: s.label, color: s.color ?? null })),
      squadLabel: descriptor?.squadLabel ?? "squad",
    });
  }),

  route("GET", "/api/analytics/player", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // canAnywhere, then the scope narrows: a grant on ONE server used to fail this check outright,
    // because a server-scoped grant does not apply to a scope-less test. Same shape as the
    // leaderboard and the directory, which are community-wide reads for the same reason.
    if (!canAnywhere(p.grants, "analytics.player", "read")) return sendForbidden(res, "analytics.player", "read");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    // Every other analytics page takes a serverId; this one did not, so a percentile was computed
    // against every server's population at once while the page sat under a pinned server. The
    // subject's own figures below are scoped to match, or the comparison is between two different
    // things.
    const scope = await serverScope(req, res, ctx, p, "analytics.player");
    if (!scope) return;
    const win = await resolveAnalyticsWindow(ctx.repo, u, scope.requested ?? undefined);
    // The population sample: the leaderboard already ranks everyone, and it is the cheapest honest
    // source for "how do players compare" without walking the whole players table.
    const [board, activity, mix] = await Promise.all([
      ctx.repo.stats.leaderboard("kills", 500, scope.serverIds),
      ctx.repo.analytics.sessionActivity({ ...win, tz: viewerTimeZone(req) }),
      ctx.repo.analytics.playerMix(win),
    ]);
    const kills = board.map((b) => b.kills);
    const kds = board.map((b) => (b.deaths ? b.kills / b.deaths : b.kills));

    // Optional subject: one player measured AGAINST the population above. This is the whole point
    // of the search box on the page — a profile already says "412 kills", and 412 means nothing
    // until you know it is the 87th percentile of the people who play here.
    const subjectId = u.get("playerId") || "";
    let subject: unknown = null;
    if (subjectId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subjectId);
      const player = (isUuid ? await ctx.repo.players.findById(subjectId) : null)
        ?? await ctx.repo.players.findByPlatformId(subjectId);
      if (!player) return sendError(res, 404, "player not found");
      // Scoped the same way the population above is, so the percentile compares like with like.
      const [stats, sessions] = await Promise.all([
        ctx.repo.stats.get(player.id, scope.requested ?? undefined),
        ctx.repo.sessions.list(player.id, 200, scope.requested ?? undefined),
      ]);
      const k = stats?.kills ?? 0;
      const d = stats?.deaths ?? 0;
      const kd = d ? k / d : k;
      subject = {
        playerId: player.id,
        platformId: player.platformId,
        name: player.name,
        firstSeen: player.firstSeen,
        lastSeen: player.lastSeen,
        stats: stats ?? null,
        kd: Math.round(kd * 100) / 100,
        // Where they sit in the sampled population, so the number has a scale attached.
        killsPercentile: percentileOf(k, kills),
        kdPercentile: percentileOf(kd, kds),
        // Their own play pattern, in the same 7×24 shape the population chart uses, so the two are
        // directly comparable: "they only ever play when we're already busy" — which is exactly
        // why it must be in the same ZONE as that chart: this was the third weekHourGrid call
        // site to miss the tz, and unzoned it put the subject's evenings a day-column away from
        // the population's on any install not on UTC.
        weekHour: weekHourGrid(sessions.map((s) => s.connectedAt), viewerTimeZone(req)),
        sessions: sessions.length,
        playtimeSec: stats?.playtimeSec ?? 0,
      };
    }

    sendJson(res, 200, {
      window: { from: win.from, to: win.to },
      sampled: board.length,
      activity,
      mix,
      // Bands rather than a raw histogram: "how many players have between 100 and 500 kills" is
      // readable; a bar per distinct value is not.
      killDistribution: distribute(kills, [0, 10, 50, 100, 500, 1000, 5000], (n) => n.toLocaleString()),
      kdDistribution: distribute(kds.map((k) => Math.round(k * 10) / 10), [0, 0.5, 1, 1.5, 2, 3, 5], (n) => String(n)),
      top: board.slice(0, 25),
      subject,
    });
  }),

  route("GET", "/api/audit", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    // canAnywhere + scope: the trail is per-server (every entry carries the server it happened on),
    // so a moderator granted staff.analytics on ONE server should see that server's history — and
    // only that server's. A scope-blind check could not express either half.
    if (!canAnywhere(p.grants, "audit.trail", "read")) return sendForbidden(res, "audit.trail", "read");
    const scope = await serverScope(req, res, ctx, p, "audit.trail");
    if (!scope) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const filters = {
      ...(scope.serverIds ? { serverIds: scope.serverIds } : {}),
      // Narrowing to one server is a VIEW choice for anyone who can see them all, so the
      // community-level work — player groups, notes, templates, accounts — stays in the trail.
      // It used to drop out the moment a server was pinned, which is why whole categories of
      // staff action looked like they were never being recorded.
      includeUnscoped: !scope.restricted,
      q: u.get("q") || undefined,
      actorUserId: u.get("actor") || undefined,
      action: u.get("action") || undefined,
      /**
       * `?actions=a,b` — one record made of several audit actions. The store has always supported
       * it; only the HTTP layer did not, so a caller wanting "every ban" had to make two requests
       * and merge two independently-paged lists by hand, which cannot be done correctly.
       *
       * Bans are the case in point (a temp ban and a permanent ban are both bans), and so are
       * unbans and team switches. Bounded, because this becomes an `IN` list on a hot table.
       */
      actions: (u.get("actions") || "").split(",").map((a) => a.trim()).filter(Boolean).slice(0, 20),
      targetId: u.get("targetId") || undefined,
      serverId: u.get("serverId") || undefined,
      from: u.get("from") || undefined,
      to: u.get("to") || undefined,
      limit: pageLimit(u, 200, 500),
      offset: pageOffset(u),
    };
    // Pin the read: staff keep acting while someone reads the trail, and each new entry would
    // otherwise push page two down by a row so it repeats what page one already showed.
    const { anchor, to } = pageAnchor(u, filters.to);
    filters.to = to;
    const [entries, total] = await Promise.all([ctx.repo.audit.list(filters), ctx.repo.audit.count(filters)]);
    // `actorName`/`targetName` are the historical record — what things were called at the time —
    // and are never rewritten. The readable pair alongside them resolves BOTH ends to what they
    // are called now, so the Trail names people instead of printing ids at them.
    sendJson(res, 200, {
      // A seeding row names its rule; the ground rules' detail is for the rules permission's holders.
      entries: await readableAudit(ctx, seedingAuditFor(entries, canAnywhere(p.grants, "admin.moderation", "read"))),
      total, offset: filters.offset, limit: filters.limit, anchor,
    });
  }),

  route("GET", "/api/audit/staff", async (req, res, ctx) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "staff.profiles", "read")) return sendForbidden(res, "staff.profiles", "read");
    const scope = await serverScope(req, res, ctx, p, "staff.profiles");
    if (!scope) return;
    const u = new URL(req.url ?? "", "http://x").searchParams;
    // "Who is moderating THIS server" — a different question from "who is busy across the
    // community", and this rollup could only ever answer the second one.
    // People by default: the app's own automation (vip.expire alone runs hundreds of times) is a
    // different population and would bury every human on the page. ?actors=auto asks for the
    // machinery instead — that view lives under Administration → System.
    let staff = await ctx.repo.audit.staffSummary({
      from: u.get("from") || undefined, to: u.get("to") || undefined,
      actor: u.get("actors") === "auto" ? "auto" : "human",
      ...(scope.serverIds ? { serverIds: scope.serverIds } : {}),
      includeUnscoped: !scope.restricted,
    });
    /*
     * The machinery view groups by actor name, and shop presses used to stamp each buyer's own
     * `discord:<name>` on their audit rows — one "service" per customer, dozens of one-count
     * impostor rows. New rows land under the real service ("shop"); the stored years of old ones
     * fold into a single line here, because a display problem in history is the display's to fix.
     */
    if (u.get("actors") === "auto") {
      const members = staff.filter((r) => !r.actorUserId && r.actorName.startsWith("discord:"));
      if (members.length) {
        const merged = { actorUserId: null, actorName: "discord members", count: 0, lastAt: "", byAction: {} as Record<string, number> };
        for (const r of members) {
          merged.count += r.count;
          if (r.lastAt > merged.lastAt) merged.lastAt = r.lastAt;
          for (const [a, n] of Object.entries(r.byAction)) merged.byAction[a] = (merged.byAction[a] ?? 0) + n;
        }
        // Re-sorted, not appended: the store hands the list ranked by count and the System page
        // renders it in order, so a fold worth hundreds of presses must not sit under a
        // one-count service just because it was assembled last.
        staff = [...staff.filter((r) => r.actorUserId || !r.actorName.startsWith("discord:")), merged]
          .sort((a, b) => b.count - a.count);
      }
    }
    // Grouping is already by actorUserId, so a rename never splits one person into two cards — but
    // the stored name may be an old one, so resolve the current display name here.
    const nameById = await currentActorNames(ctx);
    // Each actor's roles ride along so the page can narrow the team to "just the Admins" (or any
    // role set) without a second permission surface — the viewer already may see who acted.
    const assignments = await ctx.repo.userRoles.listByUsers(staff.map((r) => r.actorUserId).filter((id): id is string => !!id));
    const roleIdsByUser = new Map([...assignments].map(([uid, list]) => [uid, [...new Set(list.map((a) => a.roleId))]]));
    const roles = (await ctx.repo.roles.list()).map((r) => ({ id: r.id, name: r.name }));
    sendJson(res, 200, {
      staff: staff.map((r) => ({
        ...r,
        actorDisplayName: (r.actorUserId && nameById.get(r.actorUserId)) || r.actorName,
        roleIds: (r.actorUserId && roleIdsByUser.get(r.actorUserId)) || [],
      })),
      roles,
    });
  }),

  // Per-staff analytics for a staff profile: category breakdown, top targets/servers, daily series.
  route("GET", "/api/audit/staff/:userId", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "staff.profiles", "read")) return sendForbidden(res, "staff.profiles", "read");
    const scope = await serverScope(req, res, ctx, p, "staff.profiles");
    if (!scope) return;
    const userId = params.userId!;
    const tz = viewerTimeZone(req);
    const entries = await readableAudit(ctx, await ctx.repo.audit.list({
      actorUserId: userId, limit: 5000,
      ...(scope.serverIds ? { serverIds: scope.serverIds } : {}),
      includeUnscoped: !scope.restricted,
    }));
    // Decorated first, so "most acted on" names people. It listed platform ids, which is the one
    // form of a player that tells a reader nothing at a glance.
    // Bulk volleys count once here too — a person's profile page must agree with the team page
    // about how much work a select-all message was.
    const analytics = buildStaffAnalytics(countableActions(entries), tz);
    // Notice engagement is the Announcement analytics page's data, pivoted to one person — the
    // catalogue puts read rates, time-to-see and acknowledgements squarely under
    // analytics.announcements, and says nothing about them under staff.analytics. It shipped here
    // to anyone who could open a staff profile. It is withheld from the payload rather than hidden
    // in the component, because it is a record about a named person.
    const canNotices = canAnywhere(p.grants, "analytics.announcements", "read");
    const [user, servers, published, myReads] = await Promise.all([
      ctx.repo.users.findById(userId),
      ctx.repo.servers.list({ includeRetired: true }), // rounds played on a retired server keep its name
      canNotices ? ctx.repo.announcements.listPublished(500) : Promise.resolve([]),
      canNotices ? ctx.repo.announcements.readsForUser(userId) : Promise.resolve([]),
    ]);
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const topServers = analytics.topServers.map((s) => ({ ...s, name: serverName.get(s.serverId) ?? s.serverId }));
    // Of everything currently posted, what has this staff member seen, how fast after posting, and
    // what did they acknowledge.
    const readByNotice = new Map(myReads.map((r) => [r.announcementId, r]));
    const minutesToSee: number[] = [];
    let readCount = 0;
    let ackCount = 0;
    for (const a of published) {
      const r = readByNotice.get(a.id);
      if (!r) continue;
      readCount++;
      if (r.acknowledgedAt) ackCount++;
      if (a.publishedAt) minutesToSee.push(Math.max(0, (Date.parse(r.readAt) - Date.parse(a.publishedAt)) / 60_000));
    }
    minutesToSee.sort((x, y) => x - y);
    const notices = {
      postedCount: published.length,
      readCount,
      unreadCount: published.length - readCount,
      ackCount,
      readRate: published.length ? Math.round((readCount / published.length) * 100) / 100 : null,
      avgMinutesToSee: minutesToSee.length ? Math.round(minutesToSee.reduce((s, m) => s + m, 0) / minutesToSee.length) : null,
      medianMinutesToSee: minutesToSee.length ? Math.round(minutesToSee[Math.floor((minutesToSee.length - 1) / 2)]!) : null,
    };
    sendJson(res, 200, {
      user: user ? { id: user.id, username: user.username, displayName: displayNameOf(user), discordUsername: user.discordUsername, createdAt: user.createdAt } : null,
      actorName: (user ? displayNameOf(user) : undefined) ?? entries[0]?.actorName ?? "unknown",
      analytics: { ...analytics, topServers },
      ...(canNotices ? { notices } : {}),
      canViewNotices: canNotices,
    });
  }),

  /**
   * One entry of the trail in full — for the detail a tap on it opens: everything its record holds,
   * and what the action changed (audit-changes.ts), setting by setting, before and after. The same
   * read as the trail: an entry on a server the reader may not see, or a community-wide one for a
   * reader held to some servers, is not found.
   */
  route("GET", "/api/audit/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    if (!canAnywhere(p.grants, "audit.trail", "read")) return sendForbidden(res, "audit.trail", "read");
    const scope = await serverScope(req, res, ctx, p, "audit.trail");
    if (!scope) return;
    const row = await ctx.repo.audit.get(params.id!);
    const visible = row && (row.serverId ? can(p.grants, "audit.trail", "read", { serverId: row.serverId }) : !scope.restricted);
    if (!row || !visible) return sendError(res, 404, "no such entry in the trail");
    // Shaped as the trail shapes it: a seeding row's ground rules only for their permission's holders.
    const [entry] = await readableAudit(ctx, seedingAuditFor([row], canAnywhere(p.grants, "admin.moderation", "read")));
    const changes = await auditChanges(ctx, entry!, p.grants);
    sendJson(res, 200, { entry, changes, details: auditDetails(entry!, changes) });
  }),

  /**
   * One round in full: the match row plus every player's scoreboard line for it.
   *
   * Match history listed rounds but each row was a dead end — you could see that a round happened
   * and who won, with no way to ask who played it or how they did.
   */
  route("GET", "/api/matches/:id", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const match = await ctx.repo.matches.get(params.id!);
    if (!match) return sendError(res, 404, "match not found");
    // Server-scoped read: seeing a round means being allowed to see the server it was played on.
    if (!can(p.grants, "server.view", "read", { serverId: match.serverId })) return sendForbidden(res, "server.view", "read");
    // The roster samples' read stops at the whistle (padded a second, like the kills below) and
    // never runs past the headcount's cap: an open round is the server's latest, but it has no end
    // to stop the read at.
    const capMs = Date.parse(match.startedAt) + (HEADCOUNT_MAX_MINUTES + 1) * 60_000;
    const samplesTo = new Date(Math.min(match.endedAt ? Date.parse(match.endedAt) + 1000 : capMs, capMs)).toISOString();
    const [stats, servers, events, scoreSeries, samples] = await Promise.all([
      ctx.repo.matches.statsForMatch(match.id),
      ctx.repo.servers.list({ includeRetired: true }), // a match report outlives its server's retirement
      // The round's own kill stream, same window discipline as the public scoreboard: the upper
      // bound is exclusive, so pad a second past the whistle rather than shave the closing kill.
      ctx.repo.events.window({
        serverId: match.serverId,
        kinds: ["evt.kill", "evt.teamkill"],
        from: match.startedAt,
        to: match.endedAt ? new Date(Date.parse(match.endedAt) + 1000).toISOString() : undefined,
        limit: 20_000,
      }).catch(() => []),
      ctx.repo.matches.scoreSeries(match.id).catch(() => new Map<string, number[]>()),
      ctx.repo.rosterSnapshots.list({ serverId: match.serverId, from: match.startedAt, to: samplesTo }).catch(() => []),
    ]);
    const server = servers.find((s) => s.id === match.serverId);
    // The round's OWN game, not whichever the server runs today — a server that switched games
    // must not have its old rounds' weapons read through the wrong classifier (same rule as the
    // public scoreboard, from CRCON's parse_recorded_layer lesson).
    const descriptor = getGame(match.game ?? server?.game ?? "hll")?.descriptor;
    const report = buildMatchReport({
      events, stats, startedAt: match.startedAt, endedAt: match.endedAt,
      classify: (w) => classifyWeapon(descriptor, w),
      scoreSeries,
    });
    sendJson(res, 200, {
      match: { ...match, serverName: server?.name ?? null },
      stats,
      report,
      // Players on each side, minute by minute, from the worker's roster samples.
      headcount: headcountTimeline(samples, match.startedAt, match.endedAt),
    });
  }),
];
